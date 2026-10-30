# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""회의 — TFT 방의 사람과 에이전트가 한 대화를 나눈다.

방(office.py 의 office_rooms)이 참가자를 정한다. 사람이 말을 올리면 참가한 에이전트마다 중계(relay.py)로 보내고,
답이 끝나는 대로 같은 기록(office_messages)에 쌓는다. 에이전트는 방에서 오간 새 말만 받는다(relay 가 이미 보낸 기록을 뺀다).
설치본이 서로 달라도 한 방에서 말할 수 있다. 화면은 기록을 주기적으로 읽는다(GET /api/office/meeting).
"""
from __future__ import annotations

import json
import os
import threading
import time
import uuid
from datetime import datetime

from . import meeting_files, office, relay, shared
from ..common import db, table_cache
from ..common.i18n import tr
from ..hermes import attach_notice, skill_commands, workspace as wsp
from ..ops import mcp_servers

SCHEMA = """
CREATE TABLE IF NOT EXISTS office_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT, room INTEGER NOT NULL, role TEXT NOT NULL, author TEXT NOT NULL DEFAULT '',
  content TEXT NOT NULL, ts TEXT NOT NULL, kind TEXT NOT NULL DEFAULT '', data TEXT);
CREATE INDEX IF NOT EXISTS office_messages_room ON office_messages (room, id);
CREATE TABLE IF NOT EXISTS office_meeting_live (room INTEGER PRIMARY KEY, last REAL NOT NULL, since REAL NOT NULL);
CREATE TABLE IF NOT EXISTS office_meeting_pending (
  room INTEGER NOT NULL, alias TEXT NOT NULL, origin TEXT NOT NULL, ts REAL NOT NULL, PRIMARY KEY (room, alias));
CREATE TABLE IF NOT EXISTS office_servers (origin TEXT PRIMARY KEY, ts REAL NOT NULL);
CREATE TABLE IF NOT EXISTS office_meeting_lost (
  room INTEGER NOT NULL, alias TEXT NOT NULL, origin TEXT NOT NULL, ts REAL NOT NULL, PRIMARY KEY (room, alias, origin));
CREATE TABLE IF NOT EXISTS office_meeting_threads (
  id INTEGER PRIMARY KEY AUTOINCREMENT, room INTEGER NOT NULL, after_id INTEGER NOT NULL, ts TEXT NOT NULL, by TEXT NOT NULL DEFAULT '');
CREATE INDEX IF NOT EXISTS office_meeting_threads_room ON office_meeting_threads (room, id);
"""
_MIGRATED: set = set()
MAX_TEXT = 4000
KEEP = 500                                                    # 대화 차례마다 남기는 기록 수(스펙 2026-10-20-027 D9)
KEEP_THREADS = 30                                             # 방마다 남기는 대화 차례 수. 넘으면 가장 오래된 차례의 기록째 지운다(D9)
THREAD_KIND = "thread_started"                                # 「새 대화」 알림 행의 kind(D6). 새 차례의 첫 행이다
ACTIVE_FOR = 300                                              # 마지막 말 뒤 이 시간(초)까지는 회의 중으로 본다 — 장면의 회의실 모이기(계획 007 P3)
SUMMARY_WAIT = 300                                            # 회의록 요약을 기다리는 시간(초)
SUPPORT_TTL = 30                                              # 설치본이 공유 폴더를 받을 수 있는지(표지 파일) 판정을 기억하는 시간(초)
VISIBLE_WAIT = 10.0                                           # 올린 파일이 에이전트 쪽에서 보일 때까지 기다리는 최대 시간(초, NFS 캐시 방어)
SNAPSHOT_WAIT = 10.0                                          # 턴 앞뒤 작업 폴더 목록을 기다리는 최대 시간(초)
CHIP_NOTE = "files"                                           # 에이전트 결과 파일 행의 kind
ROOT = attach_notice.ROOT                                      # 에이전트 파드의 데이터 폴더(/opt/data)
GUARD_KIND = "guard_blocked"                                  # 가드레일이 막은 답 행의 kind(스펙 2026-10-20-026 R6·R6b)
# 차단 답을 알아보는 구절. 출처는 openmaru-cogentai docker/litellm-plugins/aas_guardrail_hook.py 의 BLOCKED_NOTICE
# (「🚫 죄송합니다. 입력하신 내용이 정책에 위반되어 처리할 수 없습니다.」). 문장 앞부분·이모지가 바뀌어도 알아보도록 핵심 구절만 보고,
# 정책을 설명하는 긴 답을 잘못 보지 않도록 GUARD_MAX 자 이하일 때만 차단으로 본다(R6). 화면(MeetingRoom.tsx)도 같은 값을 쓴다
GUARD_PHRASE = "정책에 위반되어 처리할 수 없습니다"  # i18n-ignore: 훅 차단 안내를 알아보는 구절(비교용)
GUARD_MAX = 80


def rooms_dir(room_id: int) -> str:
    """에이전트가 이 방의 결과 파일을 두는 작업 폴더 안 하위 폴더(R1b). 칩·자동 올리기는 이 아래만 본다."""
    return f"{wsp.WORKSPACE}/rooms/{int(room_id)}"


def is_guard_blocked(answer: str) -> bool:
    text = (answer or "").strip()
    return 0 < len(text) <= GUARD_MAX and GUARD_PHRASE in text
LOST_KIND = "reply_lost"                                      # 서버가 다시 시작돼 답을 받지 못한 행의 kind(스펙 2026-10-20-030 R8). 화면은 호박색 줄과 「다시 묻기」
LAST_EVERY = 2.0                                              # 답 글이 조금씩 올 때 마지막 말 시각을 공유 DB 에 쓰는 최소 간격(초)
ALIVE = 30.0                                                  # 서버 신호가 이만큼 끊기면 그 서버의 답 기다림을 믿지 않는다(shared.ALIVE 와 같다)


class MeetingError(ValueError):
    def __init__(self, message: str, code: int = 400, reason: str = ""):
        super().__init__(message)
        self.code = code
        self.reason = reason                                      # 화면이 종류를 가리는 코드(bad_file·no_receiver·not_configured)


def _db():
    conn = office.connect()
    conn.executescript(SCHEMA)
    key = (db.backend(), os.environ.get("AAS_DATA_DIR", ""), os.environ.get("AAS_DB_SCHEMA", ""))
    if key not in _MIGRATED:
        # 알림 말(kind·data): 새 화면은 data 로 번역해 그리고, 옛 화면은 content 의 대체 문장을 보인다(계획 2026-10-13-014 재검토 D2)
        cols = db.columns(conn, "office_messages")
        for col, ddl in (("kind", "kind TEXT NOT NULL DEFAULT ''"), ("data", "data TEXT")):
            if col not in cols:
                db.add_column(conn, "office_messages", ddl)
        # 답 기다림이 어느 차례의 어느 말에 대한 것인지·답을 이미 썼는지(스펙 2026-10-20-030 4-8). 옛 행은 NULL — 「다시 묻기」를 숨긴다
        cols = db.columns(conn, "office_meeting_pending")
        for col, ddl in (("thread", "thread INTEGER"), ("mid", "mid INTEGER"), ("answered", "answered INTEGER NOT NULL DEFAULT 0")):
            if col not in cols:
                db.add_column(conn, "office_meeting_pending", ddl)
        _MIGRATED.add(key)
    return conn


def _room(room_id: int) -> dict:
    room = next((r for r in office.rooms() if r["id"] == room_id), None)
    if not room:
        raise MeetingError(tr("없는 방입니다", "No such room"), 404)
    return room


def _speaker(author: str, known: dict) -> str:
    """에이전트에게 보내는 글에 쓰는 이름. 사람(이메일)은 표시 이름으로 바꾼다 — LiteLLM 가드레일이 이메일을 개인정보로 보고
    질문을 막는다(OMAI-1120). 방 기록(office_messages.author)에는 이메일을 그대로 둔다."""
    return office.display_name(author, known) if "@" in (author or "") else author


# ---- 대화 차례(스펙 2026-10-20-027) ---------------------------------------------
# 방 기록은 하나이고, 「새 대화」마다 office_meeting_threads 에 경계(after_id = 그때 방의 마지막 행 id)를 남긴다.
# 차례 n 의 기록은 after_n < id ≤ after_(n+1). 차례 표에 행이 없는 옛 방은 모든 기록이 차례 0 이다(옮기기 없음).
def _thread(conn, room: int) -> tuple[int, int]:
    """지금 차례 (id, after_id). 새 대화를 한 번도 하지 않았으면 (0, 0)."""
    row = conn.execute("SELECT id, after_id FROM office_meeting_threads WHERE room=? ORDER BY id DESC LIMIT 1", (room,)).fetchone()
    return (int(row["id"]), int(row["after_id"])) if row else (0, 0)


def _segments(conn, room: int) -> list[tuple[int, int, int | None, str, str]]:
    """차례마다 (id, lo, hi, ts, by). 기록 범위는 lo < id ≤ hi(hi 가 None 이면 끝까지). 오래된 차례가 앞."""
    rows = [dict(r) for r in conn.execute("SELECT id, after_id, ts, by FROM office_meeting_threads WHERE room=? ORDER BY id", (room,))]
    marks = [(0, 0, "", "")] + [(int(r["id"]), int(r["after_id"]), str(r["ts"]), str(r["by"] or "")) for r in rows]
    return [(tid, lo, marks[i + 1][1] if i + 1 < len(marks) else None, ts, by) for i, (tid, lo, ts, by) in enumerate(marks)]


def _range_sql(lo: int, hi: int | None) -> tuple[str, tuple]:
    return (" AND id>?" + ("" if hi is None else " AND id<=?"), (lo,) if hi is None else (lo, hi))


def session_title(room: int, thread: int) -> str:
    """에이전트 세션 이름. 차례 0 은 예전 이름 그대로라 기존 방은 같은 Hermes 세션을 잇는다(R6)."""
    return f"meeting-{room}" if not thread else f"meeting-{room}-t{thread}"


def _trim(conn, room: int) -> None:
    """지금 차례만 KEEP 행으로 줄인다. 새 기록은 늘 지금 차례에 들어가므로 앞 차례는 건드리지 않는다(R4 — 말·알림이 같은 함수를 쓴다)."""
    _, lo = _thread(conn, room)
    conn.execute("DELETE FROM office_messages WHERE room=? AND id>? AND id NOT IN (SELECT id FROM office_messages WHERE room=? AND id>? ORDER BY id DESC LIMIT ?)",
                 (room, lo, room, lo, KEEP))


def _trim_threads(conn, room: int) -> None:
    """방마다 차례는 KEEP_THREADS 개까지. 넘으면 가장 오래된 차례의 기록을 먼저 지우고 그 차례 행을 지운다(M6). 차례 0 도 센다."""
    segs = _segments(conn, room)
    if segs[0][2] is not None and not conn.execute("SELECT 1 FROM office_messages WHERE room=? AND id<=? LIMIT 1", (room, segs[0][2])).fetchone():
        segs = segs[1:]                                       # 차례 0 은 이미 비었다
    while len(segs) > KEEP_THREADS:
        tid, lo, hi, _ts, _by = segs.pop(0)
        cond, args = _range_sql(lo, hi)
        conn.execute("DELETE FROM office_messages WHERE room=?" + cond, (room, *args))
        if tid:
            conn.execute("DELETE FROM office_meeting_threads WHERE id=?", (tid,))


def _append(room: int, role: str, author: str, content: str, kind: str = "", data: dict | None = None, conn=None) -> int:
    """conn: 방 잠금(_lock_room)을 쥔 연결. 주면 그 트랜잭션 안에서 쓴다 — SQLite 는 잠금을 쥔 채 다른 연결로 쓰면 멈춘다(R1)."""
    if conn is None:
        with _db() as own:
            return _append(room, role, author, content, kind, data, own)
    mid = conn.execute("INSERT INTO office_messages (room, role, author, content, ts, kind, data) VALUES (?,?,?,?,?,?,?) RETURNING id",
                       (room, role, author, content, office._now(), kind, json.dumps(data, ensure_ascii=False) if data is not None else None)).fetchone()[0]
    _trim(conn, room)
    return mid


# ---- SOUL 변경 알림(OMAI-1126 리뷰 O8, 디자인 결정 7A·13A·18A·19A, 재검토 D2·M2·M4·L1·L5) -------------------------
NOTICE_KIND = "soul_changed"
NOTICE_MERGE = 600                                            # 같은 에이전트의 알림을 하나로 합치는 시간(초)
LOCK_NOTICE = 1397708108                                      # 방 단위 advisory 잠금의 첫 키('SOUL'). 둘째 키가 방 id


def notice_text(d: dict) -> str:
    """옛 화면·옛 서버가 보이는 대체 문장(한국어 한 줄). 새 화면은 data 로 지금 언어 문장을 만든다."""
    if d.get("package"):
        return f"{d['alias']} 의 SOUL 이 스킬 허브 패키지 {d['package']} {d.get('version') or ''} 업데이트로 바뀌었습니다".replace("  ", " ")  # i18n-ignore: 옛 화면용 대체 문장(DB 저장)
    a, b = d.get("rev_from"), d.get("rev_to")
    revs = f"버전 {a}→{b}" if a and b and a != b else f"버전 {b}" if b else ""  # i18n-ignore: 옛 화면용 대체 문장(DB 저장)
    if d.get("source") == "pc_import":                        # PC 가져오기로 바뀜(OMAI-1444 R15)
        return f"{d.get('who') or ''} 님이 PC 에서 가져와 {d['alias']} 의 성격을 바꿨습니다" + (f"({revs})" if revs else "")  # i18n-ignore: 옛 화면용 대체 문장(DB 저장)
    text = f"{d['alias']} 의 SOUL 이 바뀌었습니다({', '.join(x for x in (revs, d.get('who') or '') if x)})"  # i18n-ignore: 옛 화면용 대체 문장(DB 저장)
    return text + (f" — {d['note']}" if d.get("note") else "")


def notice_rooms(pod: str, profile: str) -> list[tuple[dict, str]]:
    """그 에이전트가 켜진 자리로 앉은 열린 방과 그 방의 자리 별칭(재검토 L5). 꺼 둔 자리의 방은 알리지 않는다."""
    aliases = {s["alias"] for s in office.seats() if s["pod"] == pod and s["profile"] == profile and s["enabled"]}
    if not aliases:
        return []
    return [(r, next(a for a in r["seats"] if a in aliases)) for r in office.rooms() if r["status"] != "closed" and aliases & set(r["seats"])]


def _lock_room(conn, room: int) -> None:
    """같은 방의 「마지막 메시지 확인 → 고치거나 붙이기」를 한 줄로 세운다(재검토 L1)."""
    if db.is_pg(conn):
        conn.execute("SELECT pg_advisory_xact_lock(?, ?)", (LOCK_NOTICE, room))
    elif not conn.in_transaction:
        conn.execute("BEGIN IMMEDIATE")


def _mergeable(last, pod: str, profile: str, now: datetime) -> dict | None:
    """방의 마지막 메시지가 같은 에이전트의 SOUL 알림이고 10분 안이면 그 data. 사이에 다른 말이 있으면 합치지 않는다(재검토 M2).
    마켓 업데이트(package)·PC 가져오기(source) 알림에는 뒤이은 저장을 합치지 않는다(OMAI-1444 ROV4)."""
    if not last or last["kind"] != NOTICE_KIND:
        return None
    try:
        data = json.loads(last["data"] or "{}")
        age = (now - datetime.fromisoformat(str(last["ts"]))).total_seconds()
    except (ValueError, TypeError):
        return None
    return data if data.get("pod") == pod and data.get("profile") == profile and not data.get("package") and not data.get("source") and 0 <= age <= NOTICE_MERGE else None


def notice_soul(pod: str, profile: str, who: str, rev_from: int | None = None, rev_to: int | None = None, note: str = "",
                package: str = "", version: str = "", source: str = "") -> int:
    """SOUL 이 바뀐 것을 그 에이전트가 앉은 열린 방에 남기고 알린 방 수를 돌려준다. role=system 이라 에이전트에게는 보내지 않는다.
    package 를 주면 마켓 에이전트 패키지 업데이트로 바뀐 것이다(재검토 M4) — 판 범위 대신 패키지와 판을 적고 합치지 않는다.
    source 를 주면(pc_import) data 에 남기고 note 는 비우며 앞 알림에 합치지 않는다(OMAI-1444 DD13·ROV4). 화면이 source 로 문장을 고른다."""
    count = 0
    for room, alias in notice_rooms(pod, profile):
        with _db() as conn:
            _lock_room(conn, room["id"])
            # 시각은 잠금을 잡은 뒤에 구한다. 잠금 전에 구하면 먼저 잠금을 잡은 다른 저장보다 이른 시각이 되어(초 경계에서)
            # 간격이 음수라 합치지 않고 알림이 둘 남았다(OMAI-1458)
            now = datetime.now().astimezone()
            ts = now.isoformat(timespec="seconds")
            data = {"alias": alias, "pod": pod, "profile": profile, "who": who, "note": "" if source else note[:200], "ts": ts}
            data.update({"package": package, "version": version} if package else {"rev_from": rev_from, "rev_to": rev_to})
            if package:                                       # 화면이 보이는 패키지 ID(free/x → shared/x). package 는 slug 그대로(스펙 2026-10-28-010)
                from ..market import marketplace
                data["package_label"] = marketplace.pkg_label(package)
            if source:
                data["source"] = source
            last = conn.execute("SELECT id, kind, data, ts FROM office_messages WHERE room=? ORDER BY id DESC LIMIT 1", (room["id"],)).fetchone()
            prev = None if package or source else _mergeable(last, pod, profile, now)
            if prev:                                          # 연달아 저장: 처음 판은 두고 마지막 판·시각·누가·메모를 고친다(디자인 결정 7A)
                data["rev_from"] = prev.get("rev_from") or rev_from
                conn.execute("UPDATE office_messages SET content=?, data=?, ts=? WHERE id=?",
                             (notice_text(data), json.dumps(data, ensure_ascii=False), ts, last["id"]))
            else:
                conn.execute("INSERT INTO office_messages (room, role, author, content, ts, kind, data) VALUES (?,?,?,?,?,?,?)",
                             (room["id"], "system", "", notice_text(data), ts, NOTICE_KIND, json.dumps(data, ensure_ascii=False)))
                _trim(conn, room["id"])
        count += 1
    return count


class Meeting:
    def __init__(self, bridge: relay.Bridge, workspace_for=None, origin: str | None = None, clock=time.time):
        """workspace_for: 설치본 id → 그 설치본의 작업 폴더(hermes.workspace.Workspace) 또는 None. 서버가 넘긴다 —
        이 모듈은 web/server.py 를 import 하지 않는다. 없으면 파일 첨부와 결과 파일 칩은 쓰지 않는다.
        origin: 이 서버 표시(shared.Shared.origin). 회의 목록 상태(마지막 말·시작 시각·답 기다림)는 공유 DB 에 두어
        서버 복제본 둘이 같은 목록을 본다(스펙 2026-10-20-017 R4). 답 기다림은 대화를 연 서버만 알아서 origin 을 붙인다."""
        self.bridge = bridge
        self.workspace_for = workspace_for
        self.visible_wait, self.visible_step = VISIBLE_WAIT, 1.0
        self._support: dict[str, tuple[bool, float]] = {}
        self._mark_lock = threading.Lock()
        self.origin = origin or uuid.uuid4().hex[:12]
        self._clock = clock
        self._partial: dict[int, dict[str, str]] = {}        # 방 → 별칭 → 지금까지 쓴 답(스트리밍 표시, 계획 007 P3). 이 서버에만 있다
        self._wrote: dict[int, float] = {}                    # 방 → 답 글 때문에 마지막 말 시각을 공유 DB 에 쓴 때(LAST_EVERY)
        self._lock = threading.Lock()
        self._asking: dict[tuple[int, str], int] = {}        # (방, 별칭) → 이 서버에서 그 에이전트에게 보내는 중인 말 수(R7)
        self._alive_lock = threading.Lock()
        self._alive_memo: tuple[float, set[str]] | None = None   # (읽은 시각, 살아 있는 서버) — shared.ALIVE_MEMO 초 기억
        self.alive_source = None                              # 서버가 shared.Shared._alive 를 넣는다 — 기억을 하나로(스펙 2026-10-26-002 §9-12)

    # ---- 회의 목록 상태(공유 DB, 스펙 2026-10-20-017 R1·R4) ------------------------
    def _alive(self, conn) -> set[str]:
        """살아 있는 서버들(shared.Shared 의 신호). 나는 첫 신호를 쓰기 전에도 살아 있다. 신호가 5초마다라 shared.ALIVE_MEMO 초 기억한다 —
        회의 목록 토픽이 읽을 때마다 물었다(스펙 2026-10-26-002 R6, OKE 1차 반영 뒤에도 0.70/s 남음)."""
        if self.alive_source is not None:
            return set(self.alive_source(conn))
        now = self._clock()
        with self._alive_lock:
            memo = self._alive_memo
        if memo is not None and 0 <= now - memo[0] < shared.ALIVE_MEMO:
            return set(memo[1])
        alive = {r[0] for r in conn.execute("SELECT origin FROM office_servers WHERE ts >= ?", (now - ALIVE,))} | {self.origin}
        with self._alive_lock:
            self._alive_memo = (now, alive)
        return set(alive)

    def _pending_of(self, conn, room_id: int | None = None) -> dict[int, set[str]]:
        """방 → 답을 쓰는 중인 에이전트. 죽은 서버가 남긴 기다림은 뺀다 — 그 서버가 죽으면 대화도 끝났다.
        답 시간 한도(relay.TURN_LIMIT)를 넘긴 기다림도 뺀다. 지우기가 DB 오류로 실패해 남은 행이 새 대화를 계속 막지 않게 한다(R8)."""
        alive = self._alive(conn)
        oldest = self._clock() - relay.TURN_LIMIT
        sql, args = "SELECT room, alias, origin, ts FROM office_meeting_pending", ()
        if room_id is not None:
            sql, args = sql + " WHERE room=?", (room_id,)
        out: dict[int, set[str]] = {}
        for r in conn.execute(sql, args):
            if r["origin"] in alive and float(r["ts"]) >= oldest:
                out.setdefault(r["room"], set()).add(r["alias"])
        return out

    def _stale_of(self, conn, room_id: int) -> set[str]:
        """신호가 끊긴 서버가 남긴, 아직 답을 쓰지 않은 기다림. 정리(sweep_lost)가 「받지 못함」 줄로 바꿀 때까지 화면이 「확인하는 중」으로 보인다
        (스펙 2026-10-20-030 DR7). 회의 중 판정·장면(_touch·active)에는 넣지 않는다 — 죽은 에이전트가 발언자가 된다."""
        alive = self._alive(conn)
        oldest = self._clock() - relay.TURN_LIMIT
        return {r["alias"] for r in conn.execute("SELECT alias, origin, ts, answered FROM office_meeting_pending WHERE room=?", (room_id,))
                if r["origin"] not in alive and float(r["ts"]) >= oldest and not r["answered"]}

    def _touch(self, room_id: int, start: bool = False, conn=None) -> None:
        """마지막 말 시각을 지금으로. start(사람이 말함)이고 쉬던 방(답 기다림 없음, 마지막 말 뒤 ACTIVE_FOR 넘음)이면
        회의 시작 시각(since)도 지금으로 정한다. 답이 오는 것만으로는 회의를 새로 시작하지 않는다. conn: 방 잠금을 쥔 연결(R1)."""
        if conn is None:
            with _db() as own:
                return self._touch(room_id, start, own)
        now = self._clock()
        row = conn.execute("SELECT last, since FROM office_meeting_live WHERE room=?", (room_id,)).fetchone()
        since = now
        if row is not None:
            idle = not self._pending_of(conn, room_id).get(room_id) and now - row["last"] > ACTIVE_FOR
            if not (start and idle):
                since = row["since"]
        conn.execute(db.upsert("office_meeting_live", ("room", "last", "since"), ("room",)), (room_id, now, since))
        shared.notify(conn, "meeting")                        # 커밋 때 두 서버의 회의 목록 토픽이 다시 읽는다(스펙 2026-10-26-002 R7)

    # ---- 읽기 -------------------------------------------------------------
    def view(self, room_id: int, after: int = 0, thread: int | None = None) -> dict:
        """지금 차례의 기록. thread 를 주면 그 차례(지난 대화, 읽기 전용) — 그 방의 차례가 아니면 404(R3).
        thread 는 늘 지금 차례 id, viewing 은 돌려준 기록의 차례 id. 화면은 기록을 통째로 바꾸므로 따로 비울 필요가 없다(C1)."""
        room = _room(room_id)
        with _db() as conn:                                   # 기다림을 행보다 먼저 읽는다 — 답 스레드는 행을 다 쓴 뒤 기다림을 지우므로, 기다림이 비어 보이면 행도 끝난 것이다
            pending = sorted(self._pending_of(conn, room_id).get(room_id, ()))
            stale = sorted(self._stale_of(conn, room_id) - set(pending))
            segs = _segments(conn, room_id)
            current = segs[-1][0]
            viewing = current if thread is None else int(thread)
            seg = next((x for x in segs if x[0] == viewing), None)
            if seg is None:
                raise MeetingError(tr("이 방의 대화가 아닙니다", "This conversation is not in this room"), 404, "not_found")
            cond, args = _range_sql(max(seg[1], int(after or 0)), seg[2])
            rows = [dict(r) for r in conn.execute("SELECT id, role, author, content, ts, kind, data FROM office_messages WHERE room=?" + cond + " ORDER BY id", (room_id, *args))]
            talked = {}                                       # 「새 대화」 알림의 앞 차례에 아직 말이 남아 있는가 — 없으면 화면이 「지난 대화 보기」를 숨긴다(DR10)
            for r in rows:
                if r.get("kind") == THREAD_KIND and r.get("data"):
                    prev = int((json.loads(r["data"]) or {}).get("prev") or 0)
                    pseg = next((x for x in segs if x[0] == prev), None)
                    if pseg and prev not in talked:
                        pc, pa = _range_sql(pseg[1], pseg[2])
                        talked[prev] = bool(conn.execute("SELECT 1 FROM office_messages WHERE room=? AND role!='system'" + pc + " LIMIT 1", (room_id, *pa)).fetchone())
        if viewing != current:                                # 지난 차례에는 답하는 중·쓰는 중인 글이 없다
            pending, stale = [], []
        for r in rows:                                        # 알림은 구조(kind·data)로 보낸다 — 화면이 지금 언어로 그린다(재검토 D2)
            r["data"] = json.loads(r["data"]) if r.get("data") else None
            if r.get("kind") == THREAD_KIND and isinstance(r["data"], dict):
                r["data"]["prev_ok"] = talked.get(int(r["data"].get("prev") or 0), False)
            if r.get("kind") == NOTICE_KIND and isinstance(r["data"], dict) and r["data"].get("package"):
                from ..market import marketplace                  # 보는 사람의 언어로(공용/x·shared/x). 저장한 값은 뒤 작업이 만들어 언어가 없다(스펙 2026-10-28-010 §6-3)
                r["data"]["package_label"] = marketplace.pkg_label(str(r["data"]["package"]))
            if not r.get("kind"):
                r.pop("kind", None), r.pop("data", None)
        seats = {s["alias"]: s for s in office.seats()}
        with self._lock:
            partial = dict(self._partial.get(room_id, {})) if viewing == current else {}
        labels = office.seat_labels()                          # 화면에 보일 에이전트 이름(2026-10-18-010). 웹소켓으로 가는 값도 이 함수라 같다
        for r in rows:                                         # 「doc 에게 보내지 못했습니다」처럼 저장된 경고 글의 앞머리 별칭도 이름으로(글쓴이 값은 그대로)
            lab = labels.get(r["author"], r["author"])
            if r["role"] == "system" and not r.get("kind") and lab != r["author"] and r["content"].startswith(r["author"] + " "):
                r["content"] = lab + r["content"][len(r["author"]):]
        known = office.people()                                # 사람이 쓴 글의 글쓴이(이메일)도 이름으로(2026-10-20-025). 모르면 이메일 앞부분
        labels |= {r["author"]: office.display_name(r["author"], known) for r in rows if r["role"] == "user" and "@" in (r["author"] or "")}
        starters = {str((r.get("data") or {}).get("by") or "") for r in rows if r.get("kind") == THREAD_KIND}   # 「새 대화」 알림의 시작한 사람(DR3)
        labels |= {b: office.display_name(b, known) for b in starters if "@" in b}
        changers = {str((r.get("data") or {}).get("who") or "") for r in rows if r.get("kind") == NOTICE_KIND}   # SOUL 알림의 바꾼 사람(이메일 → 이름, 2026-10-30)
        labels |= {w: office.display_name(w, known) for w in changers if "@" in w}
        shown = set(room["seats"]) | {r["author"] for r in rows} | set(pending) | set(stale) | set(partial) | starters | changers
        return {"room": {"id": room["id"], "name": room["name"], "purpose": room["purpose"], "status": room["status"], "seats": room["seats"], "people": office.named(room["people"], known)},
                "participants": [{"alias": a, "title": seats[a]["title"], "pod": seats[a]["pod"], "enabled": seats[a]["enabled"], "label": labels.get(a, a)} for a in room["seats"] if a in seats],
                "labels": {a: labels[a] for a in shown if labels.get(a, a) != a},
                "messages": rows, "pending": pending, "stale": stale, "partial": partial, "files": meeting_files.info(), "thread": current, "viewing": viewing}

    def threads(self, room_id: int) -> dict:
        """「지난 대화」 목록(최근 것이 앞). 말 수는 사람·에이전트의 말(시스템 행 제외), first 는 첫 사람 말 앞부분.
        지난 차례 중 말이 없는 것은 뺀다(DR6). 차례 0 은 기록이 남아 있을 때만 있다."""
        _room(room_id)
        known = office.people()
        out = []
        with _db() as conn:
            segs = _segments(conn, room_id)
            current = segs[-1][0]
            for tid, lo, hi, ts, by in segs:
                cond, args = _range_sql(lo, hi)
                count = conn.execute("SELECT COUNT(*) FROM office_messages WHERE room=? AND role!='system'" + cond, (room_id, *args)).fetchone()[0]
                if tid != current and not count:
                    continue
                first = conn.execute("SELECT content, ts FROM office_messages WHERE room=? AND role='user'" + cond + " ORDER BY id LIMIT 1", (room_id, *args)).fetchone()
                if not ts:                                    # 차례 0 은 첫 행의 시각
                    head = conn.execute("SELECT ts FROM office_messages WHERE room=?" + cond + " ORDER BY id LIMIT 1", (room_id, *args)).fetchone()
                    ts = str(head["ts"]) if head else ""
                out.append({"id": tid, "ts": ts, "by": by, "by_label": office.display_name(by, known) if "@" in by else by,
                            "count": int(count), "first": str(first["content"])[:120] if first else "", "current": tid == current})
        return {"threads": list(reversed(out)), "current": current}

    def new_thread(self, room_id: int, who: str) -> dict:
        """「새 대화」(스펙 2026-10-20-027). 끝난 방(R14)·답하는 중(D4)이면 409. 말하기(say)와 같은 방 잠금 안에서 경계를 긋는다(R1).
        에이전트 세션은 다음 말에서 새 이름(session_title)으로 새로 열린다. 앞 차례의 이 서버 메모리는 비운다(R5·R10)."""
        room = _room(room_id)
        if room["status"] == "closed":
            raise MeetingError(tr("끝난 방입니다. 다시 열어야 새 대화를 시작할 수 있습니다", "This room is closed. Reopen it to start a new conversation"), 409, "closed")
        with _db() as conn:
            _lock_room(conn, room_id)
            if self._pending_of(conn, room_id).get(room_id) or self._stale_of(conn, room_id):   # 정리 전 「받지 못함」 줄이 새 차례에 들어가지 않게(RD4)
                raise MeetingError(tr("AI 에이전트가 답하는 중에는 새 대화를 시작할 수 없습니다", "You cannot start a new conversation while AI Agents are replying"), 409, "busy")
            prev, _ = _thread(conn, room_id)
            last = conn.execute("SELECT COALESCE(MAX(id), 0) FROM office_messages WHERE room=?", (room_id,)).fetchone()[0]
            tid = conn.execute("INSERT INTO office_meeting_threads (room, after_id, ts, by) VALUES (?,?,?,?) RETURNING id",
                               (room_id, int(last), office._now(), who)).fetchone()[0]
            _append(room_id, "system", who, f"{who} 님이 새 대화를 시작했습니다", THREAD_KIND, {"by": who, "prev": prev}, conn)  # i18n-ignore: 옛 화면용 대체 문장(화면은 kind 로 그린다)
            _trim_threads(conn, room_id)
            shared.notify(conn, "meeting")                    # 회의 목록의 마지막 답이 새 차례 기준이 된다(R7)
        old = session_title(room_id, prev)
        rows = [r for a in room["seats"] for t in (old, old + "-summary") if (r := office.session_find(a, t))]
        self.bridge.forget([r["id"] for r in rows])
        return {"thread": int(tid)}

    # ---- 말하기 -----------------------------------------------------------
    @staticmethod
    def _history(room_id: int, alias: str, after: int = 0) -> list[dict]:
        """이 에이전트가 아직 못 본 방의 기록. 에이전트의 대화는 자기가 받은 말과 자기 답을 이미 알고 있으므로
        자기 마지막 답 뒤의 기록만 「이름: 말」 로 건넨다(그 뒤에 올라온 사람의 말과 다른 에이전트의 답).
        after: 지금 차례의 경계. 앞 차례의 말은 새 세션에 건네지 않는다(D3)."""
        with _db() as conn:
            # 차단 줄(guard_blocked)도 그 에이전트의 마지막 답으로 본다 — 아니면 막힌 말이 다음 턴에 다시 실린다(R6b)
            last = conn.execute("SELECT COALESCE(MAX(id), 0) FROM office_messages WHERE room=? AND author=? AND (role='assistant' OR kind=?)",
                                (room_id, alias, GUARD_KIND)).fetchone()[0]
            last = max(int(last), int(after))
            rows = conn.execute("SELECT author, content, kind, data FROM office_messages WHERE room=? AND id>? AND role!='system' ORDER BY id", (room_id, last)).fetchall()
        known = office.people()
        out = []
        for r in rows:
            content = r["content"]
            if r["kind"] == "attach":                             # 파일이 붙은 말: 못 받은 에이전트에게는 그 말을 건네지 않고, 나머지에는 파일이 있었음만 알린다(안내 경로는 넣지 않는다)
                try:
                    data = json.loads(r["data"] or "{}")
                except ValueError:
                    data = {}
                if alias in (data.get("undelivered") or []):
                    continue
                names = [str(f.get("name") or "") for f in data.get("files") or []]
                if names:
                    content = f"{content} [첨부: {', '.join(names)}]"  # i18n-ignore: 에이전트(LLM)에 보내는 방 기록
            out.append({"role": "user", "content": f"{_speaker(r['author'], known)}: {content}"})
        return out

    @staticmethod
    def _system(room: dict, alias: str, titles: dict, auto_upload: bool = False) -> str:
        """auto_upload: 그 에이전트에서 결과 칩·방 자료 자동 올리기가 되는가(_chips_on). 아니면 「자동으로 올라갑니다」를 약속하지 않는다.
        파일 문장(스펙 2026-10-20-026 F1): 입력 폴더가 읽기 전용이라는 것을 몰라 결과를 /opt/data/cache 에 써 방에 안 올라간 일이 있었다.
        결과 폴더를 방마다 나눈 것은 같은 에이전트가 여러 방에서 동시에 일할 때 다른 방 파일이 섞여 올라가지 않게 하려는 것(R1b)."""
        names = ", ".join(f"{a}({titles[a]})" if titles.get(a) else a for a in room["seats"])
        known = office.people()
        people = ", ".join(_speaker(p, known) for p in room["people"]) or "(적지 않음)"  # i18n-ignore: 에이전트(LLM)에 보내는 시스템 프롬프트
        rid = room["id"]
        # 문장(「~하세요」)으로 쓴 안내는 목적 없는 방에서 지시만으로 AI 필터가 jailbreak 로 판정했다(OKE 가드레일 검사 2026-10-20, 5개 방 중 3개).
        # 같은 내용을 항목 목록(설명형)으로 쓰니 5개 방 모두 통과했다 — 문구를 바꿀 때 OKE 가드레일 검사를 다시 한다(스펙 2026-10-20-026 §6)
        files = ("\n\n## 파일 위치\n"  # i18n-ignore: 에이전트(LLM)에 보내는 시스템 프롬프트
                 f"- 방에 올라온 파일: `{ROOT}/{wsp.UPLOADS}/aas-shared/{rid}/` (읽기 전용, 그 자리에서 읽는다)\n"  # i18n-ignore: 에이전트(LLM)에 보내는 시스템 프롬프트
                 f"- 결과 파일 저장 위치: `{ROOT}/{rooms_dir(rid)}/`" + (" (방 자료에 자동으로 올라간다)" if auto_upload else "") + "\n"  # i18n-ignore: 에이전트(LLM)에 보내는 시스템 프롬프트
                 # 중간 파일은 rooms/ 밖 작업 폴더에 — 칩은 rooms/{방}/ 만 보므로 올라가지 않는다. /opt/data/cache 는 Hermes 내부 폴더라 권하지 않는다(§7-7)
                 f"- 중간 파일·스크립트: `{ROOT}/{wsp.WORKSPACE}/tmp/` (방에 올라가지 않는다)\n"  # i18n-ignore: 에이전트(LLM)에 보내는 시스템 프롬프트
                 f"- 다른 에이전트가 만든 파일: 방 자료에 올라간 것은 `aas-shared/{rid}/` 에서 읽고, 그 밖의 파일은 만든 에이전트에게 요청한다"  # i18n-ignore: 에이전트(LLM)에 보내는 시스템 프롬프트
                 ) if meeting_files.enabled() else ""
        # 목적은 항목별 Markdown(### 머리)일 수 있어 한 문장에 끼우지 않고 끝에 절로 붙인다(2026-10-18, 스펙 2026-10-18-004)
        purpose = (room["purpose"] or "").strip()
        return (f"당신은 '{room['name']}' 방에 참가한 {alias} 입니다. " + ("" if purpose else "목적: (적지 않음). ")  # i18n-ignore: 에이전트(LLM)에 보내는 시스템 프롬프트
                + f"에이전트: {names}. 사람: {people}. "  # i18n-ignore: 에이전트(LLM)에 보내는 시스템 프롬프트
                "방의 다른 사람과 에이전트가 한 말은 「이름: 말」 모양으로 전달됩니다. 맡은 일에 필요한 만큼만 짧게 답하세요." + files
                + (f"\n\n## 이 방의 목적\n{purpose}" if purpose else ""))  # i18n-ignore: 에이전트(LLM)에 보내는 시스템 프롬프트

    # ---- 파일(스펙 office/meeting-file-sharing §4-9) -------------------------------------------------
    def _ws(self, pod_id: str):
        if self.workspace_for is None:
            return None
        try:
            return self.workspace_for(pod_id)
        except Exception:
            return None

    def supports_files(self, pod_id: str) -> bool:
        """그 설치본이 공유 폴더를 받을 수 있는가: 서버가 공유 폴더 루트에 직접 쓴 표지 파일이 그 설치본의 사이드카에 보이는가(30초 기억).
        작업 폴더를 못 읽는 설치본(로컬 폴더·옛 사이드카)이거나 표지가 안 보이면(볼륨이 안 붙음) 받을 수 없다."""
        now = time.monotonic()
        with self._lock:
            hit = self._support.get(pod_id)
        if hit and now - hit[1] < SUPPORT_TTL:
            return hit[0]
        ok = False
        ws = self._ws(pod_id)
        try:
            if ws is not None and ws.supported():
                info = ws.check(f"{wsp.UPLOADS}/aas-shared/{wsp.SHARED_MARKER}")
                ok = bool(info.get("exists") and info.get("type") == "file")
        except Exception:
            ok = False
        with self._lock:
            self._support[pod_id] = (ok, now)
        return ok

    @staticmethod
    def _visible(ws, path: str) -> bool:
        try:
            info = ws.check(path)
            return bool(info.get("exists") and info.get("type") == "file")
        except Exception:
            return False

    def _wait_visible(self, ws, paths: list[str]) -> bool:
        """올린 파일이 그 에이전트의 사이드카에 보일 때까지 step 간격으로 최대 visible_wait 초 확인한다(NFS 속성·디렉터리 캐시)."""
        deadline = time.monotonic() + self.visible_wait
        pending = list(paths)
        while True:
            pending = [p for p in pending if not self._visible(ws, p)]
            if not pending:
                return True
            if time.monotonic() >= deadline:
                return False
            time.sleep(self.visible_step)

    def _mark_undelivered(self, msg: int, alias: str) -> None:
        """말의 data.undelivered 에 별칭을 더한다 — _history 가 그 에이전트의 다음 턴에서 이 말을 뺀다."""
        with self._mark_lock, _db() as conn:
            row = conn.execute("SELECT data FROM office_messages WHERE id=?", (msg,)).fetchone()
            try:
                data = json.loads(row["data"] or "{}") if row else {}
            except ValueError:
                data = {}
            if row is None or alias in data.get("undelivered", []):
                return
            data["undelivered"] = [*data.get("undelivered", []), alias]
            conn.execute("UPDATE office_messages SET data=? WHERE id=?", (json.dumps(data, ensure_ascii=False), msg))

    @staticmethod
    def _file_ids(files) -> list[str]:
        if files is None:
            return []
        if not isinstance(files, list) or len(files) > meeting_files.MAX_PER_MESSAGE or any(not isinstance(f, str) or not f for f in files):
            raise MeetingError(tr("붙일 수 없는 파일입니다", "This file cannot be attached"), 400, "bad_file")
        return list(dict.fromkeys(files))

    def _snap(self, ws) -> dict | None:
        """작업 폴더 목록(턴 앞뒤 비교용). 늦거나 실패하면 None — 그 턴은 결과 파일 칩을 건너뛴다."""
        box: dict = {}

        def run():
            try:
                box["v"] = ws.snapshot()
            except Exception:
                box["v"] = None
        t = threading.Thread(target=run, daemon=True, name="aas-meeting-snapshot")
        t.start()
        t.join(SNAPSHOT_WAIT)
        return box.get("v")

    # ---- 말하기 -----------------------------------------------------------
    def skills(self, room_id: int) -> dict:
        """회의실 / 목록(스펙 2026-10-19-012 D2·R5). 방의 켜진 참가자마다 그 Hermes 의 스킬 목록을 나란히(최대 8, 하나당 5초) 읽어
        command 로 합치고 가진 별칭(agents)을 붙인다. 늦거나 실패한 참가자는 빼고 failed 에 적는다. 다른 사람 에이전트의 스킬도
        이름·설명을 보인다(R3/D10 — 방 참가자는 이미 그 에이전트에게 말을 보낼 수 있다)."""
        from concurrent.futures import ThreadPoolExecutor
        room = _room(room_id)
        seats = {s["alias"]: s for s in office.seats() if s["enabled"]}
        members = [a for a in room["seats"] if a in seats]

        def one(alias: str) -> tuple[str, dict]:
            try:
                return alias, skill_commands.cached(self.bridge.hub(seats[alias]["pod"]), seats[alias]["profile"])
            except Exception:
                return alias, {"skills": [], "warning": "unavailable"}
        merged: dict[str, dict] = {}
        failed: list[str] = []
        if members:
            with ThreadPoolExecutor(max_workers=max(1, min(8, len(members))), thread_name_prefix="aas-meeting-skills") as pool:
                for alias, got in pool.map(one, members):
                    if got.get("warning"):
                        failed.append(alias)
                        continue
                    for row in got.get("skills") or []:
                        key = row["command"].lower()
                        cur = merged.setdefault(key, {**row, "agents": []})
                        cur["usage"] = max(cur["usage"], row["usage"])
                        if not cur.get("description") and row.get("description"):
                            cur["description"] = row["description"]
                            cur["description_full"] = row.get("description_full", row["description"])   # 번역 키도 같은 글로(스펙 2026-10-19-017 D8)
                        cur["agents"].append(alias)
        rows = sorted(merged.values(), key=lambda r: (-len(r["agents"]), -r["usage"], r["name"].lower()))
        return {"skills": rows, "members": members, "failed": failed}

    def say(self, room_id: int, who: str, text: str, targets: list[str] | None = None, files: list[str] | None = None,
            skill: str | None = None, managed: set[str] | None = None) -> dict:
        """skill: 화면이 고른 스킬(스펙 2026-10-19-012). 에이전트마다 그 Hermes 에서 펼친다. 없는 에이전트는 글만 받고 방 기록에
        시스템 줄이 남는다(R4). 방 기록에는 사용자가 친 글(화면이 보낸 text, /스킬 포함)이 그대로 남는다.
        managed: 말한 사람이 관리하는(주인·관리자·팀 관리자) 자리. 그 밖의 에이전트에게는 위키 쓰기 도구를 막고 보낸다(스펙 2026-10-23-004 15-9).
        None 은 옛 호출(검사 없음)이다 — 서버는 늘 넘긴다."""
        skill = str(skill or "").strip().lstrip("/")[:120] or None
        ids = self._file_ids(files)
        text = str(text or "").strip()[:MAX_TEXT]
        if not text and not ids:
            raise MeetingError(tr("말을 적어 주세요", "Enter a message"))
        if ids and not meeting_files.enabled():
            raise MeetingError(tr("파일 올리기가 켜져 있지 않습니다", "File sharing is not enabled"), 400, "not_configured")
        room = _room(room_id)
        if room["status"] == "closed":
            raise MeetingError(tr("끝난 방입니다. 다시 열어야 말할 수 있습니다", "This room is closed. Reopen it to post a message"), 409)
        seats = {s["alias"]: s for s in office.seats() if s["enabled"]}
        members = [a for a in room["seats"] if a in seats]
        if not members:
            raise MeetingError(tr("이 방에 앉은 AI 에이전트가 없습니다. 「TFT 방」에서 AI 에이전트를 고르세요", "No AI Agent is seated in this room. Pick AI Agents in the TFT room"), 409)
        picked = [a for a in (targets or members) if a in members]
        if targets and not picked:
            raise MeetingError(tr("받을 AI 에이전트가 이 방에 없습니다", "The target AI Agent is not in this room"))
        rows, skipped = [], []
        if ids:
            try:
                rows = meeting_files.claim(room_id, ids)
            except meeting_files.FileError as exc:
                raise MeetingError(str(exc), 400, "bad_file") from None
            skipped = [a for a in picked if not self.supports_files(seats[a]["pod"])]       # 공유 폴더를 받을 수 없는 설치본은 이 말을 받지 않는다(결정 R3)
            picked = [a for a in picked if a not in skipped]
            if not picked:
                raise MeetingError(tr("파일을 받을 수 있는 AI 에이전트가 없습니다", "No AI Agent here can receive files"), 409, "no_receiver")
        text = text or attach_notice.EMPTY_TEXT
        titles = {a: seats[a]["title"] for a in members}
        # 차례 확인·기록 읽기·말 추가·기다림 넣기를 방 잠금 하나로 묶는다 — 사이에 「새 대화」가 끼면 말은 앞 차례, 답은 새 차례로 갈라졌다(R1).
        # 쓰기는 모두 이 연결로 한다(SQLite 는 잠금을 쥔 채 다른 연결로 쓰면 멈춘다). 읽기(_history)는 다른 연결이어도 된다
        with _db() as conn:
            _lock_room(conn, room_id)
            thread, after = _thread(conn, room_id)
            histories = {a: self._history(room_id, a, after) for a in picked}      # 이 말이 올라가기 전의 기록(에이전트마다 자기 말이 다르다)
            if rows:
                mid = _append(room_id, "user", who, text, "attach",
                              {"files": [{"id": r["id"], "name": r["name"], "size": r["size"]} for r in rows], "undelivered": skipped}, conn)
                meeting_files.attach(ids, mid, conn)
                for alias in skipped:
                    _append(room_id, "system", alias, f"{alias} 는 파일을 받을 수 없어 이 말을 받지 않았습니다", conn=conn)  # i18n-ignore: 방 기록에 저장되는 시스템 메시지
            else:
                mid = _append(room_id, "user", who, text, conn=conn)
            self._touch(room_id, start=True, conn=conn)              # 기다림을 적기 전에 — 쉬던 방인지는 지금까지의 기다림으로 본다
            with self._lock:
                for alias in picked:
                    self._asking[(room_id, alias)] = self._asking.get((room_id, alias), 0) + 1
            for alias in picked:
                conn.execute(db.upsert("office_meeting_pending", ("room", "alias", "origin", "ts", "thread", "mid", "answered"), ("room", "alias")),
                             (room_id, alias, self.origin, self._clock(), thread, mid, 0))
        for alias in picked:
            blocked = None if managed is None or alias in managed else mcp_servers.foreign_write_blocks()
            threading.Thread(target=self._ask, args=(room, alias, seats[alias], who, text, histories[alias], titles, rows, mid, skill, thread, blocked),
                             daemon=True, name="aas-meeting").start()
        return {"ok": True, "message": mid, "targets": picked, "skipped": [{"alias": a, "reason": "unsupported"} for a in skipped]}

    def _ask(self, room: dict, alias: str, seat: dict, who: str, text: str, history: list, titles: dict, rows: list | None = None, mid: int = 0,
             skill: str | None = None, thread: int = 0, blocked: list[str] | None = None) -> None:
        """thread: 말을 받은 때의 차례. 세션 이름을 여기서 정해, 그 사이 새 대화가 생겨도 바뀌지 않는다(S4).
        blocked: 이 턴에서 막을 도구(say 의 managed 참고)."""
        rid = room["id"]
        ws = self._ws(seat["pod"]) if (rows or meeting_files.enabled()) else None
        # 이 말의 결과로 방 기록에 남길 줄(role, content, kind, data). 끝에 _deliver 가 한 번에 쓴다 — 그 사이 이 서버가 죽은 것으로 정리됐으면 쓰지 않는다(4-8)
        lines: list[tuple] = []
        chips_from = None                                         # (before, ws): 답을 쓴 뒤에만 결과 파일 칩을 단다
        try:
            attach = None
            if rows:                                              # 올린 파일이 이 에이전트 쪽에서 보일 때까지 확인한다. 안 보이면 이 에이전트는 이 말을 받지 않는다
                paths = [meeting_files.pod_path(rid, r) for r in rows]
                if ws is None or not self._wait_visible(ws, paths):
                    self._mark_undelivered(mid, alias)
                    lines.append(("system", f"{alias} 는 파일이 보이지 않아 이 말을 받지 않았습니다", "", None))  # i18n-ignore: 방 기록에 저장되는 시스템 메시지
                    return
                attach = [{"name": r["name"], "size": r["size"], "path": p} for r, p in zip(rows, paths)]
            chips = ws is not None and self._chips_on(ws)
            before = self._snap(ws) if chips else None
            row, _ = office.session_create(alias, session_title(rid, thread))
            # 이름은 speaker 로 따로 넘긴다 — 말 앞에 붙이면 가드레일이 이름까지 검사해 막았다(OKE 2026-10-21, hermes_chat.SPEAKER_MARK)
            name = _speaker(who, office.people())
            block = {"blocked_tools": blocked} if blocked else {}
            if skill:
                turn = self.bridge.start(alias, seat, row, skill_commands.strip_token(text, skill), self._system(room, alias, titles, chips), history,
                                         by=who, files=attach, skill=skill, speaker=name,
                                         display=f"{name}: {text}", **block)   # 대화 창 말풍선도 스킬 없는 말처럼 이름을 붙인다(스펙 2026-10-20-022)
                if turn.skill_reason == "noskill":
                    _append(rid, "system", alias, f"{alias} 에게는 스킬 /{skill} 가 없어 글만 보냈습니다")  # i18n-ignore: 방 기록에 저장되는 시스템 메시지
                elif turn.skill_reason:
                    _append(rid, "system", alias, f"{alias} 에게 스킬 /{skill} 를 불러오지 못해 글만 보냈습니다")  # i18n-ignore: 방 기록에 저장되는 시스템 메시지
            else:
                turn = self.bridge.start(alias, seat, row, text, self._system(room, alias, titles, chips), history, by=who, files=attach,
                                         speaker=name, display=f"{name}: {text}", **block)
            n, answer, failed = 0, "", ""
            while True:
                items = turn.after(n, wait=15)
                for item in items:
                    n += 1
                    if item[0] == "delta":
                        with self._lock:
                            part = self._partial.setdefault(rid, {})
                            part[alias] = (part.get(alias, "") + str(item[1]))[-MAX_TEXT:]
                            due = time.monotonic() - self._wrote.get(rid, 0.0) >= LAST_EVERY
                            if due:
                                self._wrote[rid] = time.monotonic()
                        if due:
                            self._touch(rid)
                    elif item[0] == "final":
                        answer = str(item[1])
                    elif item[0] == "failed":
                        failed = str(item[1])
                if turn.done and n >= len(turn.items):
                    break
            if failed:
                lines.append(("system", f"{alias} 가 답하지 못했습니다: {failed}", "", None))  # i18n-ignore: 방 기록에 저장되는 시스템 메시지
            elif is_guard_blocked(answer):                       # 훅이 막은 답: 에이전트가 한 말로 남기지 않는다. content 는 예전 화면·요약용 대체 문장
                lines.append(("system", f"{alias} 는 가드레일에 막혀 답하지 못했습니다", GUARD_KIND, {"alias": alias}))  # i18n-ignore: 방 기록에 저장되는 대체 문장(화면은 kind 로 그린다)
            elif answer.strip():
                lines.append(("assistant", answer.strip(), "", None))
            if chips and before is not None:
                chips_from = (before, ws)
        except relay.Busy:
            lines.append(("system", f"{alias} 는 앞의 말에 아직 답하는 중입니다. 잠시 뒤에 다시 말해 보세요", "", None))  # i18n-ignore: 방 기록에 저장되는 시스템 메시지
        except Exception as exc:                                # 한 에이전트의 실패가 다른 에이전트의 답을 막지 않는다
            lines.append(("system", f"{alias} 에게 보내지 못했습니다 ({type(exc).__name__})", "", None))  # i18n-ignore: 방 기록에 저장되는 시스템 메시지
        finally:
            key = (rid, alias)
            with self._lock:
                self._partial.get(rid, {}).pop(alias, None)
                left = self._asking[key] = max(0, self._asking.get(key, 1) - 1)
                if not left:
                    self._asking.pop(key, None)
            try:
                delivered = self._deliver(rid, alias, lines, last=not left)
                if delivered and chips_from is not None:          # 칩 행(방 자료 id 포함)을 다 쓴 뒤에 기다림을 지운다(시험 9g)
                    self._append_chips(rid, alias, seat["pod"], chips_from[0], self._snap(chips_from[1]), chips_from[1])
            except Exception as exc:                            # 기록을 못 써도 기다림은 아래에서 지운다(남으면 정리가 「받지 못함」으로 바꾼다)
                print(f"회의 답을 기록하지 못했습니다: {type(exc).__name__}", flush=True)  # i18n-ignore: 로그
            try:
                # 같은 에이전트에게 보내는 말이 아직 있으면(연달아 보내 Busy 로 끝난 경우) 기다림을 지우지 않는다 — 첫 답이 오는 중이다(R7)
                if not left:
                    with _db() as conn:
                        conn.execute("DELETE FROM office_meeting_pending WHERE room=? AND alias=? AND origin=?", (rid, alias, self.origin))
                    with self._lock:                              # 지우는 사이 새 말이 기다림을 다시 넣었으면 되살린다
                        again = self._asking.get(key, 0)
                    if again:
                        with _db() as conn:
                            conn.execute(db.upsert("office_meeting_pending", ("room", "alias", "origin", "ts"), ("room", "alias")),
                                         (rid, alias, self.origin, self._clock()))
                self._touch(rid)
            except Exception:                                   # DB 가 잠깐 안 되면 기다림은 남지만, 답 시간 한도(R8)·서버 신호로 풀린다
                pass

    def _deliver(self, rid: int, alias: str, lines: list[tuple], last: bool) -> bool:
        """답 줄을 방 잠금 안에서 쓴다. 정리(sweep_lost)가 이 서버의 기다림을 「받지 못함」으로 이미 바꿨으면 쓰지 않는다 —
        서버가 느리기만 해서 정리된 뒤 답이 오면 두 줄이 다 남았다(외부 검토 H7). 표시는 한 번 쓰면 지운다.
        last: 이 에이전트에게 이 서버가 보내는 중인 말이 이것뿐이다. 그러면 기다림에 답을 썼다고 적어 정리가 「받지 못함」을 쓰지 않게 한다."""
        with _db() as conn:
            _lock_room(conn, rid)
            if conn.execute("DELETE FROM office_meeting_lost WHERE room=? AND alias=? AND origin=? RETURNING room", (rid, alias, self.origin)).fetchone():
                return False
            for role, content, kind, data in lines:
                _append(rid, role, alias, content, kind, data, conn)
            if last:
                conn.execute("UPDATE office_meeting_pending SET answered=1 WHERE room=? AND alias=? AND origin=?", (rid, alias, self.origin))
        return True

    @staticmethod
    def _chips_on(ws) -> bool:
        try:
            return meeting_files.enabled() and bool(ws.supported())
        except Exception:
            return False

    @staticmethod
    def _append_chips(rid: int, alias: str, pod: str, before: dict | None, after: dict | None, ws=None) -> None:
        """이번 턴에 에이전트가 자기 작업 폴더에 만들거나 바꾼 파일을 답 행 뒤에 kind='files' 시스템 행으로 남긴다(결정 R1).
        role='system' 이라 다른 에이전트의 _history 에 섞이지 않는다. 목록을 못 뜨면 칩 없이 답만 남는다.
        ws 가 있으면 그 파일을 방 자료에도 올리고(2026-10-20) 파일마다 결과(room 파일id 또는 skip 오류 코드)를 행에 적는다."""
        mine = rooms_dir(rid) + "/"                           # 이 방 결과 폴더 아래만 — 다른 방 일·중간 파일이 섞여 올라가지 않는다(R1b)
        keep = lambda snap: None if snap is None else {k: v for k, v in snap.items() if k.startswith(mine) or k == "__truncated__"}  # noqa: E731
        found = wsp.diff(keep(before), keep(after))           # 개수 제한(CHIP_LIMIT) 전에 거른다 — 다른 폴더 파일이 이 방 파일을 밀어내지 않게
        chips = [{"path": f["path"], "name": f["name"], "size": f["size"]} for f in (found or {}).get("files", []) if f.get("downloadable")][:wsp.CHIP_LIMIT]
        if not chips:
            return
        mid = _append(rid, "system", alias, "", CHIP_NOTE, {"pod": pod, "files": chips})
        if ws is None:
            return
        done = meeting_files.publish(rid, alias, pod, chips, ws, mid)
        data = {"pod": pod, "files": [{**c, **r} for c, r in zip(chips, done)]}
        with _db() as conn:
            conn.execute("UPDATE office_messages SET data=? WHERE id=?", (json.dumps(data, ensure_ascii=False), mid))

    # ---- 장면(계획 007 P3) --------------------------------------------------
    def active(self, now: float | None = None) -> list[dict]:
        """지금 회의 중인 방(답하는 중이거나 마지막 말 뒤 ACTIVE_FOR 안). 누가 회의실에 있는지는 위치일 뿐이라 모두에게 보인다
        — 발언 내용은 부르는 쪽이 방 구성원에게만 붙인다."""
        now = self._clock() if now is None else now
        rooms = {r["id"]: r for r in office.rooms() if r["status"] != "closed"}
        with _db() as conn:
            live = [(r["room"], r["last"], r["since"]) for r in conn.execute("SELECT room, last, since FROM office_meeting_live")]
            waiting = self._pending_of(conn)
        out = []
        with self._lock:
            for rid, at, since in sorted(live, key=lambda r: -r[1]):        # 최근에 말한 회의가 앞(장면 연출은 첫 회의, 디자인 리뷰 이슈 9)
                pending = sorted(waiting.get(rid, ()))
                if rid not in rooms or (not pending and now - at > ACTIVE_FOR):
                    continue
                partial = self._partial.get(rid, {})
                speaker = max(partial, key=lambda a: len(partial[a])) if partial else (pending[0] if pending else None)
                out.append({"room": rid, "name": rooms[rid]["name"], "seats": rooms[rid]["seats"], "pending": pending,
                            "speaker": speaker, "at": at, "since": since})
        return out

    def active_with_last(self) -> list[dict]:
        """회의 목록 토픽의 값: active() 의 줄마다 이 서버의 쓰는 중인 글(partial)과 지금 차례의 마지막 len(seats) 줄 가운데 에이전트 답.
        회의마다 view() 전체를 불러 5초에 SELECT 16개(회의 1개)~38개(3개)를 냈다 — 차례 표와 마지막 줄을 질의 하나씩으로 읽는다
        (스펙 2026-10-26-002 R7). 결과는 view() 로 만들던 값과 같다(시험 test_meeting_active_reads 가 비교한다)."""
        rows = self.active()
        if not rows:
            return []
        ids = [r["room"] for r in rows]
        need = {r["room"]: len(r["seats"]) or KEEP for r in rows}   # 자리가 없는 방은 [-0:] 처럼 지금 차례 전체(KEEP 행까지 남는다)
        marks = ",".join("?" * len(ids))
        with _db() as conn:
            after = {int(t["room"]): int(t["after_id"]) for t in conn.execute(
                f"SELECT room, after_id FROM office_meeting_threads WHERE room IN ({marks}) ORDER BY id", ids)}   # 방마다 마지막 줄이 지금 차례
            cond = " OR ".join("(room=? AND id>?)" for _ in ids)
            args = [v for rid in ids for v in (rid, after.get(rid, 0))]
            msgs = [dict(m) for m in conn.execute(
                "SELECT room, id, role, author, content, ts, kind, data FROM (SELECT room, id, role, author, content, ts, kind, data, "
                f"ROW_NUMBER() OVER (PARTITION BY room ORDER BY id DESC) rn FROM office_messages WHERE {cond}) x WHERE rn <= ? ORDER BY room, id",
                (*args, max(need.values())))]
        by_room: dict[int, list[dict]] = {}
        for m in msgs:
            by_room.setdefault(int(m.pop("room")), []).append(m)
        with self._lock:
            partials = {rid: dict(self._partial.get(rid, {})) for rid in ids}
        out = []
        for row in rows:
            last = []
            for m in by_room.get(row["room"], [])[-need[row["room"]]:]:
                if m["role"] != "assistant":
                    continue
                m["data"] = json.loads(m["data"]) if m.get("data") else None   # view() 와 같은 모양: kind 가 없으면 kind·data 를 뺀다
                if not m.get("kind"):
                    m.pop("kind", None), m.pop("data", None)
                last.append(m)
            out.append({**row, "partial": partials.get(row["room"]) or {}, "last": last})
        return out

    def summary(self, room_id: int, who: str, managed: set[str] | None = None) -> str:
        """회의록 요약. 방의 첫 에이전트에게 따로 만든 세션(meeting-<방>-summary)으로 묻는다 — 회의 세션을 쓰면 답하는 중일 때 Busy 가 나고,
        요약이 방 기록에 들어가 다음 차례에 모든 에이전트에게 다시 간다(독립 검토 M5). 결과는 방 기록에 넣지 않는다."""
        room = _room(room_id)
        seats = {s["alias"]: s for s in office.seats() if s["enabled"]}
        alias = next((a for a in room["seats"] if a in seats), None)
        if not alias:
            raise MeetingError(tr("요약할 AI 에이전트가 방에 없습니다", "No AI Agent in this room can write the summary"), 409)
        with _db() as conn:
            thread, after = _thread(conn, room_id)            # 지금 차례만 요약한다(D3)
            rows = conn.execute("SELECT author, content FROM office_messages WHERE room=? AND id>? AND role!='system' ORDER BY id DESC LIMIT 200", (room_id, after)).fetchall()
        if not rows:
            raise MeetingError(tr("요약할 기록이 없습니다", "There is nothing to summarize"), 409)
        known = office.people()
        log = "\n".join(f"{_speaker(r['author'], known)}: {r['content']}" for r in reversed(rows))
        ask = ("다음은 회의 기록입니다. 결정한 것, 할 일(담당), 남은 질문을 Markdown 으로 짧게 정리하세요.\n\n" + log)[:MAX_TEXT * 4]  # i18n-ignore: 에이전트(LLM)에 보내는 지시
        row, _ = office.session_create(alias, session_title(room_id, thread) + "-summary")   # 요약 세션도 차례마다(R9)
        blocked = None if managed is None or alias in managed else mcp_servers.foreign_write_blocks()   # 요약도 말한 사람의 권한으로(15-9)
        turn = self.bridge.start(alias, seats[alias], row, ask, by=who, **({"blocked_tools": blocked} if blocked else {}))
        deadline, n, answer = time.time() + SUMMARY_WAIT, 0, ""
        while not turn.done and time.time() < deadline:
            items = turn.after(n, wait=10)
            n += len(items)
        for item in turn.items:
            if item[0] == "final":
                answer = str(item[1])
            elif item[0] == "failed":
                raise MeetingError(str(item[1]), 502)
        if not answer.strip():
            raise MeetingError(tr("요약이 제때 끝나지 않았습니다", "The summary did not finish in time"), 504)
        return answer.strip()


def sweep_lost(origin: str, clock=time.time, alive=None) -> int:
    """신호가 끊긴 서버가 남긴 답 기다림을 「서버가 다시 시작돼 답을 받지 못했습니다」 줄로 바꾸고 지운다(스펙 2026-10-20-030 R8·4-8).
    어느 서버가 몇 번 불러도 같다 — 행마다 방 잠금 안에서 지우고, 지운 서버만 줄을 쓴다. 그 서버가 늦게라도 답을 쓰지 않게 표시를 남긴다(_deliver).
    줄은 지금 차례 끝에 넣는다(기록에 차례 칸이 없다). 정리 전에는 새 대화를 막으므로 지금 차례가 그 말의 차례다. 차례가 다르거나 모르면 mid 를 비운다.
    답 시간 한도(relay.TURN_LIMIT)를 넘긴 행은 줄 없이 지운다 — 오래 멈춘 뒤 엉뚱한 때에 줄이 생기지 않게. 정리한 줄 수를 돌려준다."""
    now = clock()
    tables = ("office_meeting_pending", "office_meeting_lost")
    if table_cache.quiet("meeting.sweep", tables):             # 답 기다림도 받지 못함 줄도 없고 그대로다(스펙 2026-10-26-002 §9-14)
        return 0
    token = table_cache.quiet_token(tables)
    with _db() as conn:
        # 서버는 shared.Shared._alive 를 넘긴다 — 살아 있는 서버 기억을 함께 쓴다(스펙 2026-10-26-002 §9-13)
        alive = (set(alive(conn)) if alive is not None
                 else {r[0] for r in conn.execute("SELECT origin FROM office_servers WHERE ts >= ?", (now - ALIVE,))}) | {origin}
        rows = [dict(r) for r in conn.execute("SELECT room, alias, origin FROM office_meeting_pending")]
        # 받지 못함 줄은 TURN_LIMIT 뒤에 지운다. 줄이 있을 때만 지운다 — 0줄이어도 지우기 문장은 이 서버가 그 표를 쓴 것으로 쳐져(C1)
        # 「조용함」이 끝내 성립하지 않았다(스펙 2026-10-26-002 §9-14). 남은 줄이 있으면 조용하다고 적지 않는다
        lost_left = conn.execute("SELECT 1 FROM office_meeting_lost LIMIT 1").fetchone() is not None
        if lost_left:
            conn.execute("DELETE FROM office_meeting_lost WHERE ts < ?", (now - relay.TURN_LIMIT,))
    if not rows and not lost_left:
        table_cache.mark_quiet("meeting.sweep", token)
    count = 0
    for r in rows:
        if r["origin"] in alive:
            continue
        with _db() as conn:
            _lock_room(conn, r["room"])
            gone = conn.execute("DELETE FROM office_meeting_pending WHERE room=? AND alias=? AND origin=? RETURNING ts, thread, mid, answered",
                                (r["room"], r["alias"], r["origin"])).fetchone()
            if not gone or gone["answered"] or float(gone["ts"]) < now - relay.TURN_LIMIT:
                continue
            current, _ = _thread(conn, r["room"])
            mid = int(gone["mid"]) if gone["mid"] is not None and gone["thread"] is not None and int(gone["thread"]) == current else None
            _append(r["room"], "system", r["alias"], f"서버가 다시 시작돼 {r['alias']} 의 답을 받지 못했습니다", LOST_KIND,  # i18n-ignore: 옛 화면용 대체 문장(화면은 kind 로 그린다)
                    {"alias": r["alias"], "mid": mid}, conn)
            conn.execute(db.upsert("office_meeting_lost", ("room", "alias", "origin", "ts"), ("room", "alias", "origin")),
                         (r["room"], r["alias"], r["origin"], now))
            shared.notify(conn, "meeting")                    # 기다림이 빠졌다(R7)
        count += 1
    return count

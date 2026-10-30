# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""오피스 — 여러 Hermes 설치본의 프로파일을 한 가상 오피스(Claw3D 3D 장면)에 앉히기 위한 AAS 쪽 메타.

Hermes 는 건드리지 않는다(설정·플러그인·버전 모두). 여기 있는 것은 전부 AAS DB 의 기록이다:
  자리(seat)  — 어느 설치본(POD)의 어느 프로파일을 오피스에 어떤 이름(별칭)으로 앉히는가, 그리고 역할·팀 같은 소개.
  방(room)    — 사람과 여러 설치본의 봇이 함께 일하는 TFT 공간의 기록.
  핀(pin)     — 검증해 둔 Hermes 버전.
  점검(check) — 설치본이 살아 있는지, 핀과 어긋났는지.
  세션        — 중계(relay.py)가 오피스의 대화를 Hermes 의 어느 대화에 이었는지.
설치본은 따로 적지 않는다 — POD 등록부(pods.py)가 곧 설치본 목록이다.
"""
from __future__ import annotations

import json
import os
import re
import threading
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from pathlib import Path

from ..common import db, store, table_cache
from ..common.i18n import tr
from . import office_changed

SCHEMA = """
CREATE TABLE IF NOT EXISTS office_seats (
  alias TEXT PRIMARY KEY, pod TEXT NOT NULL, profile TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
  title TEXT NOT NULL DEFAULT '', role TEXT NOT NULL DEFAULT '', team TEXT NOT NULL DEFAULT '', avatar TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '', key_sha TEXT NOT NULL DEFAULT '', by TEXT, ts TEXT NOT NULL, UNIQUE (pod, profile));
CREATE TABLE IF NOT EXISTS office_rooms (
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, purpose TEXT NOT NULL DEFAULT '', owner TEXT NOT NULL DEFAULT '',
  seats TEXT NOT NULL DEFAULT '[]', people TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'open', by TEXT, ts TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS office_room_members (
  room INTEGER NOT NULL, email TEXT NOT NULL, by TEXT, ts TEXT NOT NULL, PRIMARY KEY (room, email));
CREATE TABLE IF NOT EXISTS office_card_owner (
  board TEXT NOT NULL, task_id TEXT NOT NULL, email TEXT NOT NULL, ts TEXT NOT NULL, PRIMARY KEY (board, task_id));
CREATE TABLE IF NOT EXISTS office_pins (key TEXT PRIMARY KEY, value TEXT NOT NULL, by TEXT, ts TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS office_checks (
  ts TEXT NOT NULL, target TEXT NOT NULL, status TEXT NOT NULL, version TEXT NOT NULL DEFAULT '', detail TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (target, ts));
CREATE TABLE IF NOT EXISTS office_sessions (
  id TEXT PRIMARY KEY, alias TEXT NOT NULL, title TEXT NOT NULL, stored_id TEXT NOT NULL DEFAULT '', ts TEXT NOT NULL,
  UNIQUE (alias, title));
CREATE TABLE IF NOT EXISTS office_layouts (
  id INTEGER PRIMARY KEY, version INTEGER NOT NULL, items TEXT NOT NULL, by TEXT, ts TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS office_desk_assignments (
  desk_uid TEXT PRIMARY KEY, alias TEXT NOT NULL UNIQUE, by TEXT, ts TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS office_people (
  email TEXT PRIMARY KEY, name TEXT NOT NULL DEFAULT '', avatar_seed TEXT NOT NULL DEFAULT '', ts TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS office_seat_optout (
  pod TEXT NOT NULL, profile TEXT NOT NULL, by TEXT, ts TEXT NOT NULL, PRIMARY KEY (pod, profile));
CREATE TABLE IF NOT EXISTS office_room_places (
  room_id INTEGER PRIMARY KEY, place_uid TEXT NOT NULL UNIQUE, ts TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS office_seat_version (id INTEGER PRIMARY KEY, n INTEGER NOT NULL);
"""
_MIGRATED: set = set()
# 자리 표의 판 번호(스펙 2026-10-24-006 R5). 트리거가 자리 표를 바꾸는 문장마다 올린다 — 이 서버의 코드든, 다른 복제본이든, SQL 을 직접 쓰든
SEAT_BUMP = "INSERT INTO office_seat_version (id, n) VALUES (1, 1) ON CONFLICT (id) DO UPDATE SET n = office_seat_version.n + 1"
_SEATS: dict[tuple, tuple[int, list[dict]]] = {}           # (백엔드, 데이터 폴더, 스키마) → (판 번호, 자리 목록)


def _seat_triggers(conn) -> None:
    if db.is_pg(conn):
        conn.execute("CREATE OR REPLACE FUNCTION office_seat_bump() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN " + SEAT_BUMP + "; RETURN NULL; END $$")
        conn.execute("CREATE OR REPLACE TRIGGER office_seat_bump AFTER INSERT OR UPDATE OR DELETE ON office_seats "
                     "FOR EACH STATEMENT EXECUTE FUNCTION office_seat_bump()")
    else:
        for op in ("INSERT", "UPDATE", "DELETE"):
            conn.execute(f"CREATE TRIGGER IF NOT EXISTS office_seat_bump_{op.lower()} AFTER {op} ON office_seats BEGIN {SEAT_BUMP}; END")
    # 판 번호 줄이 없으면(트리거가 생기기 전의 DB) 캐시를 쓰지 않는다 — 처음부터 한 줄 둔다
    conn.execute("INSERT INTO office_seat_version (id, n) VALUES (1, 1) ON CONFLICT (id) DO NOTHING")

ID = re.compile(r"^[a-z0-9][a-z0-9_-]{0,40}$")                 # 설치본 id·프로파일 이름(Hermes 의 이름 규칙과 같다)
PIN_KEYS = ("hermes",)


def pin_label(key: str) -> str:
    return {"hermes": tr("Hermes 버전", "Hermes version")}[key]


KEEP_CHECKS = 200                                              # 대상마다 남기는 점검 기록 수


class OfficeError(ValueError):
    pass


def _now() -> str:
    return datetime.now().astimezone().isoformat(timespec="seconds")


def connect():
    conn = store.connect()
    conn.executescript(SCHEMA)
    key = (db.backend(), os.environ.get("AAS_DATA_DIR", ""), os.environ.get("AAS_DB_SCHEMA", ""))
    if key not in _MIGRATED:                                   # 옛 DB: 배치 판본 열을 더한다(계획 2026-10-13-001 §3-5)
        # 열 추가는 db.add_column 으로 한다 — 서버 두 대(PostgreSQL)나 스레드 여럿(SQLite)이 동시에 더해도 두 번째가 실패하지 않는다.
        # preset 은 IF NOT EXISTS 없이 더해 동시 시작 때 DuplicateColumn 이 났다(계획 2026-10-13-014 ET1 시험에서 발견)
        if "preset" not in db.columns(conn, "office_layouts"):
            db.add_column(conn, "office_layouts", "preset TEXT")
        room_cols = db.columns(conn, "office_rooms")
        for col, ddl in (("kind", "kind TEXT NOT NULL DEFAULT 'tft'"), ("team_key", "team_key TEXT NOT NULL DEFAULT ''")):
            if col not in room_cols:                           # 팀 방(계획 2026-10-13-011 §3-3)
                db.add_column(conn, "office_rooms", ddl)
        # 팀마다 팀 방은 하나(리뷰 A5): 자리 맞추기는 서버 두 대가 5초마다 따로 돌리므로 같은 팀 방을 동시에 만들 수 있다
        conn.execute("CREATE UNIQUE INDEX IF NOT EXISTS office_rooms_team_key ON office_rooms (team_key) WHERE kind='team'")
        if "team_src" not in db.columns(conn, "office_seats"):   # 팀이 부서에서 왔는가(계획 2026-10-13-008 §2-3)
            # OKE 첫 반영 때 서버 두 대가 동시에 더해 한쪽이 DuplicateColumn 으로 그 주기 자리 맞추기에 실패했다(OMAI-1118)
            db.add_column(conn, "office_seats", "team_src TEXT NOT NULL DEFAULT ''")
        _seat_triggers(conn)
        _MIGRATED.add(key)
    return conn


def _text(value, limit: int) -> str:
    return " ".join(str(value or "").split())[:limit]


def _multiline(value, limit: int) -> str:
    """여러 줄 글: 줄 끝 공백과 세 줄 넘는 빈 줄만 줄이고 줄바꿈은 둔다(방 목적의 Markdown)."""
    lines = [ln.rstrip() for ln in str(value or "").replace("\r\n", "\n").replace("\r", "\n").split("\n")]
    return re.sub(r"\n{3,}", "\n\n", "\n".join(lines)).strip()[:limit]


# ---- 읽기 ---------------------------------------------------------------
def seats() -> list[dict]:
    return store.memo("office.seats", _seats_cached, lambda rows: [dict(r) for r in rows])     # 값이 글자·숫자뿐인 줄이라 줄마다 얕게


def _seats_cached() -> list[dict]:
    """표 바뀜 알림으로 버리는 프로세스 캐시(스펙 2026-10-26-002 R10·E4). 캐시를 쓸 수 없으면(SQLite·끊김) 지금처럼 버전 번호를 확인한다."""
    return table_cache.get("office.seats", ("office_seats",), _seats, lambda rows: [dict(r) for r in rows])


def _seats() -> list[dict]:
    """자리 목록. 오피스 화면·권한 검사·회의가 한 요청에서 여러 번 부르고 화면이 몇 초마다 다시 묻는다 — 자리 표가 바뀌지 않았으면
    (판 번호가 같으면) 저장해 둔 목록을 쓴다(자리 5,000개에서 표 읽기 8.6ms, 스펙 2026-10-24-006 R5)."""
    key = (db.backend(), os.environ.get("AAS_DATA_DIR", ""), os.environ.get("AAS_DB_SCHEMA", ""))
    with connect() as conn:
        row = conn.execute("SELECT n FROM office_seat_version WHERE id=1").fetchone()
        ver = int(row[0]) if row else 0
        hit = _SEATS.get(key)
        if ver and hit and hit[0] == ver:
            rows = hit[1]
        else:
            rows = [{**{k: r[k] for k in r.keys() if k != "key_sha"}, "enabled": bool(r["enabled"])}
                    for r in conn.execute("SELECT * FROM office_seats ORDER BY pod, alias")]
            if ver and db.tx_depth() <= 1:                 # 남의 트랜잭션 안에서 읽은 목록은 되돌려질 수 있어 남기지 않는다
                _SEATS[key] = (ver, rows)
    return [dict(r) for r in rows]


# ---- 화면에 보일 에이전트 이름(스펙 2026-10-18-010) ---------------------------------
# 자리 별칭이 설치본 id(aas-agent-…)면 화면마다 id 가 그대로 보였다. 에이전트 화면과 같은 이름(HermesAgent displayName)으로 보인다.
# 이름은 서버의 등록부에 있으므로 서버가 이 제공 함수를 넣는다(없으면 별칭 그대로). {설치본 id: 이름}
agent_names_provider = lambda: {}  # noqa: E731
# {설치본 id: 「주인 이름 · 에이전트 이름」}. 서버 문장(문제 띠·오류)에 id 대신 쓴다(스펙 2026-10-19-003). 없으면 id 그대로
agent_labels_provider = lambda: {}  # noqa: E731


def agent_label(pod_id: str) -> str:
    """설치본 id → 문장에 쓸 글자. 모르면 id."""
    return (agent_labels_provider() or {}).get(pod_id) or pod_id


def seat_labels(seat_rows: list[dict] | None = None) -> dict[str, str]:
    """자리 별칭 → 화면에 보일 이름. 자동으로 만든 별칭(설치본 id 와 같거나 by='auto')만 에이전트 이름으로 바꾼다 —
    관리자가 「오피스 이름」으로 지은 별칭은 그대로 둔다. 한 설치본에 자리가 여럿이면 「이름 · 프로파일」."""
    rows = seats() if seat_rows is None else seat_rows
    names = agent_names_provider() or {}
    per_pod: dict[str, int] = {}
    for s in rows:
        per_pod[s["pod"]] = per_pod.get(s["pod"], 0) + 1
    out = {}
    for s in rows:
        name = names.get(s["pod"], "")
        auto = s["alias"] == s["pod"] or s.get("by") == "auto"
        out[s["alias"]] = (name if per_pod[s["pod"]] == 1 else f"{name} · {s['profile']}") if name and auto else s["alias"]
    return out


def rooms() -> list[dict]:
    return store.memo("office.rooms", lambda: table_cache.get("office.rooms", ("office_rooms", "office_room_members"), _rooms))


def _rooms() -> list[dict]:
    with connect() as conn:
        rows = [dict(r) for r in conn.execute("SELECT * FROM office_rooms ORDER BY status='closed', id DESC")]
    with connect() as conn:
        members: dict[int, list[str]] = {}
        for m in conn.execute("SELECT room, email FROM office_room_members ORDER BY email"):
            members.setdefault(m["room"], []).append(m["email"])
    for r in rows:
        r["seats"], r["people"] = json.loads(r["seats"] or "[]"), json.loads(r["people"] or "[]")
        r["members"] = members.get(r["id"], [])
    return rows


def pins() -> dict[str, dict]:
    with connect() as conn:
        return {r["key"]: dict(r) for r in conn.execute("SELECT * FROM office_pins")}


def last_checks() -> dict[str, dict]:
    with connect() as conn:
        rows = conn.execute("SELECT c.* FROM office_checks c JOIN (SELECT target, MAX(ts) ts FROM office_checks GROUP BY target) m "
                            "ON c.target=m.target AND c.ts=m.ts").fetchall()
    return {r["target"]: dict(r) for r in rows}


def routing() -> dict[str, dict]:
    """다리가 쓰는 표. 별칭 → {pod, profile}. 꺼 둔 자리는 빠진다."""
    return {s["alias"]: {"pod": s["pod"], "profile": s["profile"]} for s in seats() if s["enabled"]}


# ---- 쓰기 ---------------------------------------------------------------
def set_seat(body: dict, who: str, known: dict[str, set[str]]) -> dict:
    """known: POD id → 그 설치본에 실제로 있는 프로파일 이름들."""
    pod, profile = str(body.get("pod") or ""), str(body.get("profile") or "")
    alias = str(body.get("alias") or profile)
    if pod not in known:
        raise OfficeError(tr("없는 설치본입니다", "No such installation"))
    if profile not in known[pod]:
        raise OfficeError(tr("그 AI 에이전트 작업공간에 없는 프로파일입니다", "That AI Agent Workspace has no such profile"))
    if not ID.match(alias) or alias == "default":
        raise OfficeError(tr("오피스에서 쓸 이름은 영문 소문자·숫자·-·_ 로 적습니다(default 는 쓸 수 없습니다)", "Write the office name with lowercase letters, digits, - and _ ('default' is not allowed)"))
    with connect() as conn:
        before = conn.execute("SELECT team FROM office_seats WHERE pod=? AND profile=?", (pod, profile)).fetchone()
        if before is not None and team_key(before["team"]) != team_key(body.get("team")):
            # 팀이 바뀌었다 — 자동으로 앉힌 책상을 풀어 다음 채우기 때 새 팀 구역에 앉힌다(R5). 관리자가 손으로 정한 책상은 둔다
            conn.execute("DELETE FROM office_desk_assignments WHERE by='auto' AND alias IN "
                         "(SELECT alias FROM office_seats WHERE pod=? AND profile=?)", (pod, profile))
        other = conn.execute("SELECT pod, profile FROM office_seats WHERE alias=?", (alias,)).fetchone()
        if other and (other["pod"], other["profile"]) != (pod, profile):
            raise OfficeError(tr(f"그 이름은 이미 {agent_label(other['pod'])} 의 {other['profile']} 가 쓰고 있습니다. 다른 이름을 정하세요.",
                              f"That name is already used by {other['profile']} of {agent_label(other['pod'])}. Choose another name."))
        for (old,) in conn.execute("SELECT alias FROM office_seats WHERE pod=? AND profile=? AND alias!=?", (pod, profile, alias)).fetchall():
            conn.execute("UPDATE office_desk_assignments SET alias=? WHERE alias=?", (alias, old))              # 이름을 바꿔도 책상은 그대로
        conn.execute("DELETE FROM office_seats WHERE pod=? AND profile=? AND alias!=?", (pod, profile, alias))     # 이름을 바꾼 경우
        conn.execute("DELETE FROM office_seat_optout WHERE pod=? AND profile=?", (pod, profile))                 # 관리자가 다시 앉혔다
        # 사람이 팀을 바꾸면 team_src 를 비워 부서가 다시 덮지 않게 한다. 팀을 그대로 두고 다른 칸만 고치면 부서에서 온 표시를 둔다
        conn.execute("INSERT INTO office_seats (alias, pod, profile, enabled, title, role, team, avatar, note, by, ts) VALUES (?,?,?,?,?,?,?,?,?,?,?) "
                     "ON CONFLICT(alias) DO UPDATE SET enabled=excluded.enabled, title=excluded.title, role=excluded.role, team=excluded.team, "
                     "team_src=CASE WHEN office_seats.team=excluded.team THEN office_seats.team_src ELSE '' END, avatar=excluded.avatar, note=excluded.note, by=excluded.by, ts=excluded.ts",
                     (alias, pod, profile, 0 if body.get("enabled") is False else 1, _text(body.get("title"), 80), _text(body.get("role"), 120),
                      _text(body.get("team"), 80), _text(body.get("avatar"), 40), _text(body.get("note"), 300), who, _now()))
    return {"ok": True, "alias": alias}


def _drop_seat(conn, alias: str) -> None:
    """자리와 그 자리의 대화 세션·책상 배정을 지운다. 「관리자가 뺀」 기록(optout)은 쓰지 않는다 — 부른 쪽이 정한다."""
    conn.execute("DELETE FROM office_seats WHERE alias=?", (alias,))
    conn.execute("DELETE FROM office_sessions WHERE alias=?", (alias,))
    conn.execute("DELETE FROM office_desk_assignments WHERE alias=?", (alias,))


def delete_seat(alias: str, who: str = "") -> dict:
    """자리를 지운다. 관리자가 뺀 프로파일은 자동 자리(auto_seat)가 다시 만들지 않게 적어 둔다."""
    with connect() as conn:
        row = conn.execute("SELECT pod, profile FROM office_seats WHERE alias=?", (alias,)).fetchone()
        if not row:
            raise OfficeError(tr("없는 자리입니다", "No such seat"))
        _drop_seat(conn, alias)
        conn.execute(db.upsert("office_seat_optout", ("pod", "profile", "by", "ts"), ("pod", "profile")), (row["pod"], row["profile"], who, _now()))
    return {"ok": True}


def profile_created(pod: str, profile: str) -> None:
    """프로파일을 만든 뒤: 같은 이름의 옛 「관리자가 뺀」 기록을 지운다 — 새 프로파일은 저절로 앉는다(스펙 2026-10-26-008 R5).
    예전에는 프로파일을 지울 때도 이 기록이 남았다."""
    with connect() as conn:
        conn.execute("DELETE FROM office_seat_optout WHERE pod=? AND profile=?", (pod, profile))


def rename_profile(pod: str, old: str, new: str, who: str = "") -> dict:
    """프로파일 이름을 바꾼 뒤: 그 프로파일의 자리와 「관리자가 뺀」 기록을 새 이름으로 옮긴다(스펙 2026-10-26-008 R3).
    별칭·책상·팀·역할은 그대로 둔다 — 별칭은 책상 배정·대화 세션·회의 기록의 열쇠다. 새 이름에 남은 옛 기록은 먼저 지우고,
    이름이 바뀐 뒤 옮기기 전에 자동 자리가 새 이름으로 생겼으면 그 자리를 지워 자리를 하나로 둔다. {옮긴 자리 수}."""
    with connect() as conn:
        conn.execute("DELETE FROM office_seat_optout WHERE pod=? AND profile=?", (pod, new))
        moved = [r["alias"] for r in conn.execute("SELECT alias FROM office_seats WHERE pod=? AND profile=?", (pod, old))]
        if moved:
            extra = [r["alias"] for r in conn.execute("SELECT alias FROM office_seats WHERE pod=? AND profile=? AND by='auto'", (pod, new))]
            _leave_open_rooms(conn, set(extra), who)
            for alias in extra:
                _drop_seat(conn, alias)
            conn.execute("UPDATE office_seats SET profile=? WHERE pod=? AND profile=?", (new, pod, old))
        conn.execute("UPDATE office_seat_optout SET profile=? WHERE pod=? AND profile=?", (new, pod, old))
    return {"seats": len(moved)}


def prune_auto_seats(pod: str, profiles: set[str], who: str = "") -> list[str]:
    """이 작업공간의 프로파일 목록(읽기에 성공한 것)에 없는 프로파일의 자동 자리(by='auto')를 지우고 열린 방에서 뺀다(스펙 2026-10-26-008 R6).
    Hermes 명령줄로 지우거나 이름을 바꾼 경우, 지우기 직전에 읽은 목록으로 자리가 다시 생긴 경우를 맞춘다. 관리자가 고친 자리는 두고,
    「관리자가 뺀」 기록은 쓰지 않는다. 지운 별칭을 돌려준다."""
    with connect() as conn:
        gone = sorted(r["alias"] for r in conn.execute("SELECT alias, profile FROM office_seats WHERE pod=? AND by='auto'", (pod,))
                      if r["profile"] not in profiles)
        if gone:
            _leave_open_rooms(conn, set(gone), who)
            for alias in gone:
                _drop_seat(conn, alias)
    return gone


def forget_profile(pod: str, profile: str, who: str = "") -> dict:
    """프로파일을 지운 뒤: 그 프로파일이 앉은 오피스 자리를 지우고 열린 방의 자리 목록에서 뺀다(스펙 2026-10-15-011 R1).
    끝난 방의 기록과 팀 방(자리의 팀을 따라 저절로 바뀐다)은 건드리지 않는다. {지운 자리 수, 바뀐 방 수}.
    지운 프로파일은 관리자가 오피스에서 뺀 것이 아니라 「관리자가 뺀」 기록(optout)을 남기지 않는다 — 남기면 같은 이름으로 다시 만든
    프로파일이 자동 자리에 앉지 않았다(스펙 2026-10-26-008 R5)."""
    aliases = {s["alias"] for s in seats() if s["pod"] == pod and s["profile"] == profile}
    if not aliases:
        return {"seats": 0, "rooms": 0}
    with connect() as conn:
        changed = _leave_open_rooms(conn, aliases, who)
        for alias in sorted(aliases):
            _drop_seat(conn, alias)
    return {"seats": len(aliases), "rooms": changed}


def _leave_open_rooms(conn, aliases: set[str], who: str) -> int:
    """열린 방(팀 방 제외)의 자리 목록에서 별칭들을 뺀다. 바뀐 방 수."""
    if not aliases:
        return 0
    changed = 0
    for row in conn.execute("SELECT id, seats FROM office_rooms WHERE status != 'closed' AND kind != 'team'").fetchall():
        kept = [a for a in json.loads(row["seats"] or "[]") if a not in aliases]
        if len(kept) != len(json.loads(row["seats"] or "[]")):
            conn.execute("UPDATE office_rooms SET seats=?, by=?, ts=? WHERE id=?", (json.dumps(kept), who or "system", _now(), row["id"]))
            changed += 1
    return changed


# ---- 공유 공간: 레이아웃·책상 배정·자동 자리 (계획 007 P−1) ----------------------
LAYOUT_MAX_ITEMS = 2000
DESK_TYPE = "desk_cubicle"


class LayoutConflict(OfficeError):
    """다른 사람이 먼저 레이아웃을 바꿨다(버전 번호가 다르다). 화면은 다시 읽고 고친다."""


class LayoutForbidden(OfficeError):
    """관리자가 아닌 사람이 이미 있는 레이아웃을 바꾸려 했다."""


def layout() -> dict:
    """{version, items, preset}. 버전이 없으면 version 0, items None. 서버가 뜰 때 ensure_default_layout 이 버전을 만든다."""
    return store.memo("office.layout", lambda: table_cache.get("office.layout", ("office_layouts",), _layout, dict), dict)   # items(큰 JSON)는 나눠 쓴다 — 부르는 쪽은 읽기만 한다


def _layout() -> dict:
    with connect() as conn:
        row = conn.execute("SELECT version, items, by, ts, preset FROM office_layouts WHERE id=1").fetchone()
    if not row:
        return {"version": 0, "items": None, "preset": None}
    return {"version": row["version"], "items": json.loads(row["items"]), "by": row["by"], "ts": row["ts"], "preset": row["preset"]}


# ---- 기본 배치 자동 적용(계획 2026-10-13-001 §3-5, D6) ------------------------------
# 화면 코드의 기본 배치(ui/.../core/aasKoreanOffice.ts)를 뽑은 파일. 화면 시험이 둘이 같은지 본다.
DEFAULT_LAYOUT_FILE = Path(__file__).with_name("default_layout.json")
_DEFAULT: dict | None = None


def default_layout() -> dict:
    global _DEFAULT
    if _DEFAULT is None:
        _DEFAULT = json.loads(DEFAULT_LAYOUT_FILE.read_text(encoding="utf-8"))
    return _DEFAULT


DEFAULT_PRESET = default_layout()["preset"]


def ensure_default_layout() -> bool:
    """저장된 판의 판본(preset)이 실린 기본 배치와 다르면 저장된 배치를 무시하고 기본 배치로 바꾼다. 바꿨으면 True.
    판 번호를 하나 올리고 책상 배정·TFT 회의실 짝을 모두 지운다(다음 채우기에서 다시 정한다).
    조건부 UPDATE 한 문장으로 바꾸므로 서버 두 대가 동시에 불러도 한 번만 바뀐다(PostgreSQL 은 같은 행을 잠그고
    뒤에 온 문장이 WHERE 를 새 값으로 다시 본다). 관리자가 편집해 저장한 판은 판본을 그대로 두므로 다시 덮어쓰지 않는다."""
    d = default_layout()
    items = json.dumps(_clean_items(d["items"]), ensure_ascii=False)
    with connect() as conn:
        conn.execute("INSERT INTO office_layouts (id, version, items, by, ts, preset) VALUES (1, 0, '[]', 'seed', ?, NULL) "
                     "ON CONFLICT(id) DO NOTHING", (_now(),))
        changed = conn.execute("UPDATE office_layouts SET version=version+1, items=?, by=?, ts=?, preset=? "
                               "WHERE id=1 AND (preset IS NULL OR preset<>?)",
                               (items, "default", _now(), d["preset"], d["preset"])).rowcount
        if changed:
            conn.execute("DELETE FROM office_desk_assignments")
            conn.execute("DELETE FROM office_room_places")
    return bool(changed)


def _clean_items(items) -> list[dict]:
    if not isinstance(items, list) or not items or len(items) > LAYOUT_MAX_ITEMS:
        raise OfficeError(tr(f"레이아웃은 가구 1~{LAYOUT_MAX_ITEMS}개의 목록이어야 합니다", f"A layout must be a list of 1 to {LAYOUT_MAX_ITEMS} items"))
    out, uids = [], set()
    for it in items:
        if not isinstance(it, dict) or not isinstance(it.get("type"), str) or not isinstance(it.get("_uid"), str):
            raise OfficeError(tr("가구마다 type 과 _uid 가 있어야 합니다", "Every item needs a type and a _uid"))
        if not all(isinstance(it.get(k), (int, float)) for k in ("x", "y")):
            raise OfficeError(tr("가구마다 x·y 좌표가 있어야 합니다", "Every item needs x and y"))
        if it["_uid"] in uids:
            raise OfficeError(tr(f"같은 _uid 가 두 번 있습니다: {it['_uid'][:40]}", f"Duplicate _uid: {it['_uid'][:40]}"))
        uids.add(it["_uid"])
        out.append(it)
    if len(json.dumps(out)) > 1_000_000:
        raise OfficeError(tr("레이아웃이 너무 큽니다", "The layout is too large"))
    return out


def save_layout(items, version: int, who: str, admin: bool) -> dict:
    """판 번호가 지금 판과 같아야 저장한다(아니면 LayoutConflict). 관리자만 저장한다 — 기본 배치는 서버가 직접 만든다
    (ensure_default_layout). 예전에는 판이 없을 때 누구나 판 1 을 올렸는데, 그러면 관리자가 아닌 사람이 배치를 정할 수 있었다."""
    clean = _clean_items(items)
    if not admin:
        raise LayoutForbidden(tr("레이아웃은 관리자만 바꿉니다", "Only admins can change the layout"))
    with connect() as conn:
        row = conn.execute("SELECT version FROM office_layouts WHERE id=1").fetchone()
        current = row["version"] if row else 0
        if int(version) != current:
            raise LayoutConflict(tr("다른 사람이 먼저 레이아웃을 바꿨습니다. 다시 읽은 뒤 고치세요.", "Someone changed the layout first. Reload and try again."))
        new = current + 1
        if row:
            conn.execute("UPDATE office_layouts SET version=?, items=?, by=?, ts=? WHERE id=1", (new, json.dumps(clean, ensure_ascii=False), who, _now()))
        else:
            conn.execute("INSERT INTO office_layouts (id, version, items, by, ts) VALUES (1,?,?,?,?)", (new, json.dumps(clean, ensure_ascii=False), who, _now()))
        desks = {it["_uid"] for it in clean if it["type"] == DESK_TYPE}
        for (uid,) in conn.execute("SELECT desk_uid FROM office_desk_assignments").fetchall():
            if uid not in desks:                                   # 지운 책상의 배정은 풀린다 — 그 에이전트는 다음 주기에 빈 책상을 받는다
                conn.execute("DELETE FROM office_desk_assignments WHERE desk_uid=?", (uid,))
    return {"ok": True, "version": new}


def desk_uids() -> list[str]:
    items = layout()["items"] or []
    return [it["_uid"] for it in items if it.get("type") == DESK_TYPE]


def team_key(team) -> str:
    """팀 이름 비교용 — 앞뒤 공백을 떼고 대소문자를 가리지 않는다."""
    return " ".join(str(team or "").split()).casefold()


def default_teams(owner_of: dict[str, str], dept_of: dict[str, str]) -> list[str]:
    """부서명을 기본 팀으로 쓴다(계획 2026-10-13-008 §2-3). 팀이 비었거나 전에 부서에서 채운(team_src='dept') 자리의 팀을
    그 설치본 주인의 부서로 맞춘다. 사람이 고친 팀(set_seat 이 team_src 를 비운다)은 덮지 않는다. 부서를 지워도 팀은 지우지 않는다.
    owner_of: POD id → 주인 이메일, dept_of: 이메일 → 부서. 팀을 바꾼 별칭을 돌려준다."""
    changed = []
    with connect() as conn:
        rows = [dict(r) for r in conn.execute("SELECT alias, pod, team, team_src FROM office_seats")]
        for r in rows:
            dept = dept_of.get(owner_of.get(r["pod"], ""), "")
            if not dept or not (r["team"] == "" or r["team_src"] == "dept") or (r["team"] == dept and r["team_src"] == "dept"):
                continue
            if team_key(r["team"]) != team_key(dept):         # 팀이 바뀌면 자동 책상을 풀어 같은 팀 구역에 다시 앉힌다(set_seat 와 같다)
                conn.execute("DELETE FROM office_desk_assignments WHERE by='auto' AND alias=?", (r["alias"],))
            conn.execute("UPDATE office_seats SET team=?, team_src='dept' WHERE alias=?", (_text(dept, 80), r["alias"]))
            changed.append(r["alias"])
    return changed


def desk_assignments() -> dict[str, str]:
    """책상 _uid → 자리 별칭."""
    def read() -> dict[str, str]:
        with connect() as conn:
            return {r["desk_uid"]: r["alias"] for r in conn.execute("SELECT desk_uid, alias FROM office_desk_assignments")}
    return table_cache.get("office.desks", ("office_desk_assignments",), read, dict)


def assign_desk(desk_uid: str, alias: str, who: str) -> dict:
    """관리자가 책상을 정한다. alias 가 비면 그 책상을 비운다. 그 별칭이 앉아 있던 다른 책상은 비운다."""
    if desk_uid not in desk_uids():
        raise OfficeError(tr("없는 책상입니다", "No such desk"))
    with connect() as conn:
        conn.execute("DELETE FROM office_desk_assignments WHERE desk_uid=?", (desk_uid,))
        if alias:
            if not conn.execute("SELECT 1 FROM office_seats WHERE alias=?", (alias,)).fetchone():
                raise OfficeError(tr("없는 자리입니다", "No such seat"))
            conn.execute("DELETE FROM office_desk_assignments WHERE alias=?", (alias,))
            conn.execute("INSERT INTO office_desk_assignments (desk_uid, alias, by, ts) VALUES (?,?,?,?)", (desk_uid, alias, who, _now()))
    return {"ok": True}


def fill_desks() -> list[tuple[str, str]]:
    """책상이 없는 켜진 자리를 빈 책상에 앉힌다. 새로 앉힌 (책상, 별칭)을 돌려준다(계획 2026-10-13-001 R3·R5).
      - 팀장석(lead)은 사람 자리라 에이전트에게 주지 않는다.
      - 같은 팀(team_key)은 그 팀이 이미 있는 구역에 앉힌다. 처음 나온 팀은 아무 팀도 없는 구역 중 앞 번호를 받는다.
        구역이 차면 다음 빈 구역으로 넘친다.
      - 팀이 없는 자리는 팀이 없는 구역 중 뒤 번호부터 앉힌다(앞 구역을 팀에게 남긴다).
      - 구역이 없는 배치(옛 배치)는 책상 순서대로 앉힌다.
    책상이 모자라면 남는 자리는 그대로 둔다 — 장면에서 라운지에 선다."""
    items = layout()["items"] or []
    desks = [(it["_uid"], it.get("zone") or 0) for it in items if it.get("type") == DESK_TYPE and not it.get("lead")]
    if not desks:
        return []
    done = []
    with connect() as conn:
        taken = {r["desk_uid"]: r["alias"] for r in conn.execute("SELECT desk_uid, alias FROM office_desk_assignments")}
        rows = [dict(r) for r in conn.execute("SELECT alias, team FROM office_seats WHERE enabled=1 ORDER BY ts, alias")]
        team_of = {r["alias"]: team_key(r["team"]) for r in rows}
        seated = set(taken.values())
        zone_of = dict(desks)
        zones = sorted({z for _, z in desks})
        teams_in: dict[int, set] = {z: set() for z in zones}
        for desk, alias in taken.items():
            if desk in zone_of:
                teams_in[zone_of[desk]].add(team_of.get(alias, ""))

        def free_in(z):
            return [d for d, dz in desks if dz == z and d not in taken]

        # 팀 회의실이 붙은 구역(1·2·3·6). 새 팀은 이 구역부터 받아 팀 회의실을 쓸 수 있게 한다(계획 2026-10-13-011 리뷰 A2)
        room_zones = {it.get("zone") for it in items if it.get("type") == "room" and it.get("kind") == "team"}

        def pick(team: str) -> str | None:
            if not team:                                    # 팀 없음: 팀이 없는 구역 중 뒤 번호부터(팀 회의실 없는 구역 먼저)
                empty = [z for z in reversed(zones) if not (teams_in[z] - {""})]
                order = [z for z in empty if z not in room_zones] + [z for z in empty if z in room_zones] + list(reversed(zones))
            else:                                           # 그 팀이 있는 구역 → 팀 회의실이 있는 빈 구역 → 아무 팀도 없는 구역 → 아무 데나
                empty = [z for z in zones if not (teams_in[z] - {""})]
                order = ([z for z in zones if team in teams_in[z]] + [z for z in empty if z in room_zones] + empty + zones)
            for z in order:
                free = free_in(z)
                if free:
                    return free[0]
            return None

        for r in rows:
            alias = r["alias"]
            if alias in seated:
                continue
            desk = pick(team_of[alias])
            if desk is None:
                break
            conn.execute("INSERT INTO office_desk_assignments (desk_uid, alias, by, ts) VALUES (?,?,?,?)", (desk, alias, "auto", _now()))
            taken[desk] = alias
            teams_in[zone_of[desk]].add(team_of[alias])
            done.append((desk, alias))
    return done


# ---- TFT 회의실 짝(계획 2026-10-13-001 R4) ---------------------------------------
def room_places() -> dict[int, str]:
    """AAS 방(TFT) 번호 → 짝지어진 TFT 회의실(배치의 room 항목 _uid)."""
    def read() -> dict[int, str]:
        with connect() as conn:
            return {r["room_id"]: r["place_uid"] for r in conn.execute("SELECT room_id, place_uid FROM office_room_places")}
    return table_cache.get("office.room_places", ("office_room_places",), read, dict)


def assign_room_places() -> dict[int, str]:
    """열린 방마다 TFT 회의실 하나를 짝짓는다. 닫히거나 지운 방, 배치에서 사라진 회의실의 짝은 지운다.
    이미 있는 짝은 바꾸지 않는다(다른 TFT 가 끝나도 남은 TFT 의 방은 그대로). 빈 회의실이 없으면 짝을 만들지 않는다(대회의실을 쓴다).
    방 번호와 회의실은 각각 하나의 짝에만 든다(고유 제약). 서버 두 대가 같은 회의실을 집으면 뒤에 온 쪽이 다음 회의실로 다시 시도한다."""
    items = layout()["items"] or []
    places = [it["_uid"] for it in items if it.get("type") == "room" and it.get("kind") == "tft"]
    all_rooms = sorted(rooms(), key=lambda r: r["id"])
    open_rooms = [r["id"] for r in all_rooms if r["status"] != "closed" and r.get("kind", "tft") != "team"]
    team_rooms = _team_room_preferences(items, [r for r in all_rooms if r["status"] != "closed" and r.get("kind") == "team"])
    team_places = {it["_uid"] for it in items if it.get("type") == "room" and it.get("kind") == "team"}
    with connect() as conn:
        for row in conn.execute("SELECT room_id, place_uid FROM office_room_places").fetchall():
            if row["room_id"] in team_rooms:
                ok = row["place_uid"] in team_places
            else:
                ok = row["room_id"] in open_rooms and row["place_uid"] in places
            if not ok:
                conn.execute("DELETE FROM office_room_places WHERE room_id=?", (row["room_id"],))
    for rid, prefs in team_rooms.items():                     # 팀 방: 그 팀 구역의 팀 회의실 → 다른 빈 팀 회의실(구역 4·5 팀) → 없으면 대회의실
        _pair(rid, prefs)
    for rid in open_rooms:
        _pair(rid, places)
    return room_places()


def _pair(rid: int, places: list[str]) -> None:
    """방 하나를 places 의 앞에서부터 빈 회의실과 짝짓는다. 이미 짝이 있으면 그대로 둔다."""
    for _ in range(len(places)):
        current = room_places()
        if rid in current:
            return
        free = [p for p in places if p not in current.values()]
        if not free:
            return
        try:
            with connect() as conn:                         # 문장마다 따로 커밋한다 — 고유 제약 충돌은 그 문장만 되돌린다
                conn.execute("INSERT INTO office_room_places (room_id, place_uid, ts) VALUES (?,?,?)", (rid, free[0], _now()))
            return
        except Exception:                                   # 다른 서버가 먼저 집었다 — 다시 읽고 다음 회의실로
            continue


def _team_room_preferences(items: list[dict], team_rooms: list[dict]) -> dict[int, list[str]]:
    """팀 방마다 짝지을 팀 회의실 순서. 그 팀 에이전트가 많이 앉은 구역의 팀 회의실부터, 그다음 나머지 팀 회의실(구역 번호 순).
    에이전트가 많은 팀부터 고른다(dict 순서). 팀 회의실은 구역 1·2·3·6 에만 있어 구역 4·5 팀은 빈 팀 회의실로 간다."""
    room_of_zone = {it.get("zone"): it["_uid"] for it in items if it.get("type") == "room" and it.get("kind") == "team"}
    order = [room_of_zone[z] for z in sorted(z for z in room_of_zone if z is not None)]
    zone_of = {it["_uid"]: it.get("zone") for it in items if it.get("type") == DESK_TYPE}
    team_of = {s["alias"]: team_key(s.get("team")) for s in seats()}
    counts: dict[str, dict] = {}
    for desk, alias in desk_assignments().items():
        if zone_of.get(desk) is not None and team_of.get(alias):
            per = counts.setdefault(team_of[alias], {})
            per[zone_of[desk]] = per.get(zone_of[desk], 0) + 1
    out = {}
    for r in sorted(team_rooms, key=lambda r: -len(r["seats"])):
        per = counts.get(r.get("team_key") or "", {})
        own = [room_of_zone[z] for z in sorted(per, key=lambda z: (-per[z], z)) if z in room_of_zone]
        out[r["id"]] = own + [u for u in order if u not in own]
    return out


def sync_team_rooms(owner_of: dict[str, str]) -> bool:
    """팀마다 팀 방(office_rooms kind='team')을 하나 둔다(계획 2026-10-13-011 §3-3, Q3·Q4).
    에이전트(seats) = 그 팀 자리(출처와 관계없이), 구성원 = 그 팀 자리 에이전트의 주인(owner_of: POD id → 주인 이메일).
    관리자는 접근 규칙이 따로 통과시킨다. Keycloak 부서로 정하지 않는다 — 부서만 바꿔 남의 팀 회의에 들어가지 못하게(리뷰 결정 D5).
    팀 방 구성원은 회의를 보고 말하는 것까지만 한다(office_access.visible_aliases 가 팀 방을 뺀다).
    팀에 자리가 없어지면 닫는다(지우지 않는다 — 회의 기록이 남는다). 바뀐 것이 있으면 True."""
    teams: dict[str, dict] = {}
    for s in seats():
        key = team_key(s.get("team"))
        if not key or not s.get("enabled", True):
            continue
        t = teams.setdefault(key, {"names": {}, "aliases": []})
        t["names"][s["team"].strip()] = t["names"].get(s["team"].strip(), 0) + 1
        t["aliases"].append(s["alias"])
        owner = (owner_of.get(s["pod"]) or "").lower()
        if owner and owner != "*" and EMAIL.match(owner):
            t.setdefault("owners", set()).add(owner)
    changed = False
    with connect() as conn:
        existing = {r["team_key"]: dict(r) for r in conn.execute("SELECT id, name, seats, status, team_key FROM office_rooms WHERE kind='team'")}
        for key, t in teams.items():
            name = max(t["names"].items(), key=lambda kv: (kv[1], kv[0]))[0][:80]
            seats_json = json.dumps(sorted(t["aliases"]))
            row = existing.get(key)
            if row is None:
                made = conn.execute("INSERT INTO office_rooms (name, purpose, owner, seats, people, status, by, ts, kind, team_key) "
                                    "VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING RETURNING id",
                                    (name, "", "", seats_json, "[]", "open", "auto", _now(), "team", key)).fetchone()
                if made is None:                               # 다른 서버가 방금 만들었다 — 다음 주기에 맞춘다
                    continue
                rid = made[0]
                changed = True
            else:
                rid = row["id"]
                if (row["name"], row["seats"], row["status"]) != (name, seats_json, "open"):
                    conn.execute("UPDATE office_rooms SET name=?, seats=?, status='open', by='auto', ts=? WHERE id=?", (name, seats_json, _now(), rid))
                    changed = True
            want = sorted(t.get("owners", set()))
            have = sorted(r["email"] for r in conn.execute("SELECT email FROM office_room_members WHERE room=?", (rid,)))
            if want != have:
                _set_members(conn, rid, want, "auto")
                changed = True
        for key, row in existing.items():
            if key not in teams and row["status"] != "closed":
                conn.execute("UPDATE office_rooms SET status='closed', seats='[]', by='auto', ts=? WHERE id=?", (_now(), row["id"]))
                changed = True
    return changed


def _alias_base(owner: str, profile: str, primary: str = "default") -> str:
    """자동 자리 별칭. 그 설치본의 주 프로파일(보통 default, 새 사용자는 main — 스펙 2026-10-14-003)은 이메일 앞부분 그대로."""
    local = re.sub(r"[^a-z0-9_-]+", "-", (owner or "").split("@")[0].lower()).strip("-_") or "agent"
    base = local if profile in ("default", primary) else f"{local}-{profile}"
    if not base[0].isalnum():
        base = "a" + base
    return base[:36]


def seat_alias(pod: str, profile: str) -> str:
    """이 설치본·프로파일이 앉은 자리 별칭(없으면 빈 값)."""
    with connect() as conn:
        row = conn.execute("SELECT alias FROM office_seats WHERE pod=? AND profile=?", (pod, profile)).fetchone()
    return str(row["alias"]) if row else ""


def auto_seat(pods: list) -> list[str]:
    """사용자마다 Hermes 가 하나씩 생기는 구성에서(001 R3) 자리가 없는 설치본의 프로파일을 오피스에 앉힌다(계획 007 R2).
    pods: (id, owner, profiles) 를 가진 것들. 관리자가 뺀 프로파일(office_seat_optout)은 건너뛴다. 새로 만든 별칭을 돌려준다."""
    made = []
    with connect() as conn:
        seated = {(r["pod"], r["profile"]) for r in conn.execute("SELECT pod, profile FROM office_seats")}
        optout = {(r["pod"], r["profile"]) for r in conn.execute("SELECT pod, profile FROM office_seat_optout")}
        used = {r["alias"] for r in conn.execute("SELECT alias FROM office_seats")}
        for p in pods:
            for profile in p.profiles:
                if (p.id, profile) in seated or (p.id, profile) in optout or not ID.match(profile):
                    continue
                base = _alias_base(p.owner, profile, getattr(p, "primary", "default"))
                alias, n = base, 2
                while alias in used or alias == "default" or not ID.match(alias):
                    alias, n = f"{base[:33]}-{n}", n + 1
                conn.execute("INSERT INTO office_seats (alias, pod, profile, enabled, title, by, ts) VALUES (?,?,?,1,?,?,?)",
                             (alias, p.id, profile, "", "auto", _now()))
                used.add(alias)
                made.append(alias)
    return made


def set_room(body: dict, who: str) -> dict:
    name = _text(body.get("name"), 80)
    if not name:
        raise OfficeError(tr("방 이름을 적어 주세요", "Enter a room name"))
    known = {s["alias"] for s in seats()}
    picked = [str(x) for x in (body.get("seats") or []) if str(x) in known][:64]
    status = str(body.get("status") or "open")
    if status not in ("open", "closed"):
        raise OfficeError(tr("상태는 open 또는 closed 입니다", "Status must be open or closed"))
    rid = int(body.get("id") or 0)
    with connect() as conn:
        old = conn.execute("SELECT kind, owner, people FROM office_rooms WHERE id=?", (rid,)).fetchone() if rid else None
    if old and old["kind"] == "team":
        raise OfficeError(tr("팀 방은 자리의 팀에 맞춰 저절로 바뀝니다. 팀은 오피스 자리나 사용자 관리 메뉴의 부서에서 고치세요.",
                             "Team rooms follow seat teams automatically. Change the team on the office seat or the department in the user management menu."))
    # 담당: 보내지 않으면 그대로, 비어 있는 새 방은 만든 사람(2026-10-18). 이메일이면 구성원에 넣는다
    owner = _text(body.get("owner"), 120) if "owner" in body else (old["owner"] if old else "")
    if not owner and not rid and "@" in (who or ""):
        owner = who.lower()
    members = _clean_members(body["members"]) if "members" in body else None
    if members is not None and "@" in owner and owner.lower() not in members:
        members.append(owner.lower())
    # 사람(회의 안내문·목록): 화면은 구성원만 고르고 「사람」 칸이 없다 — 구성원에서 만든다. 둘 다 없으면 그대로 둔다
    if "people" in body:
        people = [_text(x, 120) for x in (body.get("people") or []) if _text(x, 120)][:64]
    elif members is not None:
        people = members[:64]
    else:
        people = json.loads(old["people"] or "[]") if old else []
    # 목적은 항목별 Markdown(### 머리, 여러 줄)이라 줄바꿈을 지키고 길이를 늘린다(2026-10-18-004)
    row = (name, _multiline(body.get("purpose"), 4000), owner, json.dumps(picked), json.dumps(people, ensure_ascii=False),
           status, who, _now())
    with connect() as conn:
        if rid:
            if not conn.execute("UPDATE office_rooms SET name=?, purpose=?, owner=?, seats=?, people=?, status=?, by=?, ts=? WHERE id=?",
                                (*row, rid)).rowcount:
                raise OfficeError(tr("없는 방입니다", "No such room"))
        else:
            rid = conn.execute("INSERT INTO office_rooms (name, purpose, owner, seats, people, status, by, ts) VALUES (?,?,?,?,?,?,?,?) RETURNING id",
                               row).fetchone()[0]
        if members is not None:                                # 보내지 않으면 구성원은 그대로 둔다
            _set_members(conn, rid, members, who)
    return {"ok": True, "id": rid}


EMAIL = re.compile(r"^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$")


def _clean_members(emails) -> list[str]:
    """구성원 이메일 목록을 소문자·중복 없이. 이메일 모양이 아니면 거절한다(사람 이름 같은 것이 섞이면 아무도 권한을 얻지 못한다)."""
    if not isinstance(emails, list):
        raise OfficeError(tr("구성원은 이메일 목록이어야 합니다", "Members must be a list of email addresses"))
    clean = []
    for e in emails:
        mail = str(e or "").strip().lower()
        if not mail:
            continue
        if not EMAIL.match(mail):
            raise OfficeError(tr(f"이메일 모양이 아닙니다: {mail[:60]}", f"Not a valid email address: {mail[:60]}"))
        if mail not in clean:
            clean.append(mail)
    if len(clean) > 200:
        raise OfficeError(tr("구성원은 200명까지입니다", "A room can have up to 200 members"))
    return clean


def _set_members(conn, rid: int, emails, who: str) -> None:
    """방 구성원을 통째로 바꾼다."""
    clean = _clean_members(emails)
    conn.execute("DELETE FROM office_room_members WHERE room=?", (rid,))
    for mail in clean:
        conn.execute("INSERT INTO office_room_members (room, email, by, ts) VALUES (?,?,?,?)", (rid, mail, who, _now()))


def member_rooms(email: str) -> set[int]:
    """이 사람이 구성원인 방 번호들(끝난 방도 포함 — 걸러내는 일은 부르는 쪽이 한다)."""
    if not email:
        return set()
    def read() -> set[int]:
        with connect() as conn:
            return {r["room"] for r in conn.execute("SELECT room FROM office_room_members WHERE email=?", (email.lower(),))}
    return store.memo(f"office.member_rooms:{email.lower()}", read, clone=set)   # 읽기만 하는 요청 안에서는 사람마다 한 번(스펙 2026-10-24-009 3-2)


def delete_room(rid: int) -> dict:
    with connect() as conn:
        if (conn.execute("SELECT kind FROM office_rooms WHERE id=?", (rid,)).fetchone() or {"kind": ""})["kind"] == "team":
            raise OfficeError(tr("팀 방은 지울 수 없습니다. 팀에 자리가 없어지면 저절로 닫힙니다.",
                                 "Team rooms cannot be deleted. They close by themselves when the team has no seats."))
        if not conn.execute("DELETE FROM office_rooms WHERE id=?", (rid,)).rowcount:
            raise OfficeError(tr("없는 방입니다", "No such room"))
        conn.execute("DELETE FROM office_room_members WHERE room=?", (rid,))
        conn.execute("DELETE FROM office_room_places WHERE room_id=?", (rid,))
    try:                                                       # 방의 회의 파일(올린 파일·에이전트 출력)도 지운다. 실패해도 방 삭제는 끝난 것이다
        from . import meeting_files
        meeting_files.delete_room(rid)
    except Exception:
        pass
    return {"ok": True}


def set_pin(key: str, value: str, who: str) -> dict:
    if key not in PIN_KEYS:
        raise OfficeError(tr("알 수 없는 핀입니다", "Unknown pin"))
    value = _text(value, 120)
    with connect() as conn:
        if value:
            conn.execute(db.upsert("office_pins", ("key", "value", "by", "ts"), ("key",)), (key, value, who, _now()))
        else:
            conn.execute("DELETE FROM office_pins WHERE key=?", (key,))
    return {"ok": True}


# ---- 대화 기록 -----------------------------------------------------------
def session_rows(alias: str) -> list[dict]:
    with connect() as conn:
        return [dict(r) for r in conn.execute("SELECT * FROM office_sessions WHERE alias=? ORDER BY ts DESC", (alias,))]


def session_get(sid: str) -> dict | None:
    with connect() as conn:
        row = conn.execute("SELECT * FROM office_sessions WHERE id=?", (sid,)).fetchone()
    return dict(row) if row else None


def session_create(alias: str, title: str) -> tuple[dict, bool]:
    """(행, 새로 만들었는가). 같은 자리에 같은 제목이 있으면 그 대화를 돌려준다."""
    import secrets
    title = str(title or "")[:300] or "오피스 대화"  # i18n-ignore: 대화 제목으로 저장되는 기본값
    with connect() as conn:
        row = conn.execute("SELECT * FROM office_sessions WHERE alias=? AND title=?", (alias, title)).fetchone()
        if row:
            return dict(row), False
        sid = "ofc_" + secrets.token_hex(12)
        conn.execute("INSERT INTO office_sessions (id, alias, title, ts) VALUES (?,?,?,?)", (sid, alias, title, _now()))
    return {"id": sid, "alias": alias, "title": title, "stored_id": ""}, True


def meeting_stored_ids() -> set[str]:
    """회의 대화(meeting-<방>…)가 쓰는 Hermes 세션 id. 채팅 「지난 대화」 목록에서 뺀다(스펙 2026-10-20-027 R11)."""
    with connect() as conn:
        rows = conn.execute("SELECT stored_id FROM office_sessions WHERE title LIKE 'meeting-%' AND stored_id != ''").fetchall()
    return {str(r[0]) for r in rows}


def session_find(alias: str, title: str) -> dict | None:
    """session_create 와 같은 자리를 찾되 없으면 만들지 않는다(지난 말 읽기)."""
    with connect() as conn:
        row = conn.execute("SELECT * FROM office_sessions WHERE alias=? AND title=?", (alias, str(title or "")[:300])).fetchone()
    return dict(row) if row else None


def session_retitle(alias: str, old: str, new: str) -> bool:
    """옛 이름 대화를 새 이름으로 바꾼다(스펙 2026-10-20-002 R13). 새 이름이 이미 있거나 옛 이름이 없으면 그대로 두고 False.
    Hermes 쪽 세션(stored_id)은 그대로라 지난 말이 이어진다 — 이름은 이 표에만 있다(relay 는 행 id·stored_id 만 쓴다)."""
    with connect() as conn:
        if conn.execute("SELECT 1 FROM office_sessions WHERE alias=? AND title=?", (alias, new[:300])).fetchone():
            return False
        cur = conn.execute("UPDATE office_sessions SET title=? WHERE alias=? AND title=?", (new[:300], alias, old[:300]))
        return bool(cur.rowcount)


def known_emails() -> set[str]:
    """오피스가 아는 사람(사람 표·방 구성원)의 이메일. 대화 이름 이전에서 같은 이메일 앞부분을 쓰는 사람을 찾는다(R13)."""
    with connect() as conn:
        rows = conn.execute("SELECT email FROM office_people UNION SELECT email FROM office_room_members").fetchall()
    return {str(r[0]).lower() for r in rows if r[0]}


def session_stored(sid: str, stored_id: str) -> None:
    with connect() as conn:
        conn.execute("UPDATE office_sessions SET stored_id=?, ts=? WHERE id=?", (stored_id, _now(), sid))


# ---- 점검 ---------------------------------------------------------------
def _probe(url: str, timeout: float = 4.0) -> tuple[str, str, str]:
    """(상태, 버전, 설명). 인증 없이 /health 만 본다 — 키를 쓰지 않는다."""
    try:
        with urllib.request.urlopen(urllib.request.Request(url, headers={"Accept": "application/json"}), timeout=timeout) as resp:
            raw = resp.read(65536)
        try:
            data = json.loads(raw)
        except ValueError:
            return "bad", "", "JSON 이 아닌 응답"  # i18n-ignore: 점검 기록(office_checks)에 저장되는 상세
        if not isinstance(data, dict):
            return "bad", "", "알 수 없는 응답"  # i18n-ignore: 점검 기록(office_checks)에 저장되는 상세
        return "ok", str(data.get("version") or ""), str(data.get("status") or "")[:80]
    except urllib.error.HTTPError as exc:
        return "bad", "", f"HTTP {exc.code}"
    except OSError as exc:
        return "down", "", type(exc).__name__


def _problem_keys(found: list[dict]) -> list[tuple[str, str]]:
    """문제 띠 비교용 (대상, 수준). 문구는 언어마다 달라(tr) 비교에 쓰지 않는다(스펙 2026-10-26-001, 외부 검토 M4)."""
    return sorted((str(p.get("target") or ""), str(p.get("level") or "")) for p in found)


def run_checks(pods: list) -> dict:
    """자리가 있는 설치본마다 Hermes 대시보드가 살아 있는지 본다. 인증 없이 상태만 보고, 결과를 남기고 요약을 돌려준다.
    문제 띠가 바뀌면 오피스 변경 번호(관리자용)를 올린다(스펙 2026-10-26-001 리뷰 D4) — 리더 반복은 문제 띠를 읽지 않는다."""
    before = _problem_keys(problems())
    ts, used = _now(), {s["pod"] for s in seats() if s["enabled"]}
    rows = [(f"pod:{p.id}", *_probe(p.dashboard_url + "/api/health")) for p in pods if p.id in used]
    with connect() as conn:
        for target, status, version, detail in rows:
            conn.execute(db.upsert("office_checks", ("ts", "target", "status", "version", "detail"), ("target", "ts")), (ts, target, status, version, detail))
            conn.execute("DELETE FROM office_checks WHERE target=? AND ts NOT IN (SELECT ts FROM office_checks WHERE target=? ORDER BY ts DESC LIMIT ?)",
                         (target, target, KEEP_CHECKS))
        known = {r[0] for r in rows}
        for (target,) in conn.execute("SELECT DISTINCT target FROM office_checks").fetchall():
            if target not in known:
                conn.execute("DELETE FROM office_checks WHERE target=?", (target,))      # 자리가 다 빠진 설치본과 옛 대상(다리)의 기록은 지운다
    found = problems()
    if _problem_keys(found) != before:
        office_changed.bump("problems")
    return {"ts": ts, "checked": len(rows), "problems": found}


RECHECK_EVERY = 15.0                                           # 닿지 않던 설치본을 다시 보는 최소 간격(초). 화면을 보는 사람이 많아도 이 간격마다 한 번이다
_rechecked: dict[str, float] = {}
_recheck_lock = threading.Lock()


def recheck_failed(pods: list) -> None:
    """마지막 점검이 닿지 않음(down·bad)이었던 설치본만 다시 본다. 살아났으면 그 기록을 새로 남겨 화면의 띠가 바로 사라진다.
    점검은 서버가 뜰 때와 30분마다만 돌아서, 에이전트 파드가 다시 뜨는 동안 한 번 실패하면 살아난 뒤에도 다음 점검까지 약 30분 동안
    「연결할 수 없습니다」 띠가 남았다(OKE 2026-10-14 17:03 점검 → 17:11 화면). 닿는 설치본은 다시 보지 않고, 아직 안 닿으면 새 기록을 쌓지 않는다
    (점검 기록 KEEP_CHECKS 개가 같은 실패로 밀려나지 않게). 보는 순서는 15초 간격 제한을 먼저 건다."""
    bad = {t for t, c in last_checks().items() if t.startswith("pod:") and c["status"] != "ok"}
    if not bad:
        return
    now = time.monotonic()
    with _recheck_lock:
        due = [p for p in pods if f"pod:{p.id}" in bad and now - _rechecked.get(p.id, -RECHECK_EVERY) >= RECHECK_EVERY]
        for p in due:
            _rechecked[p.id] = now
    if not due:
        return
    def look(p):
        try:
            return p, _probe(p.dashboard_url + "/api/health")
        except Exception as exc:                  # 주소가 비정상이면 urlopen 이 ValueError 를 던진다. 오피스 개요 응답을 깨지 않는다
            return p, ("down", "", type(exc).__name__)
    with ThreadPoolExecutor(max_workers=min(4, len(due))) as ex:
        results = list(ex.map(look, due))
    ts = _now()
    revived = False
    with connect() as conn:
        for p, (status, version, detail) in results:
            if status == "ok":
                conn.execute(db.upsert("office_checks", ("ts", "target", "status", "version", "detail"), ("target", "ts")), (ts, f"pod:{p.id}", status, version, detail))
                revived = True
    if revived:                                   # 닿지 않음 → 닿음이면 그 띠가 빠진다. 새로 읽지 않고 알린다(스펙 2026-10-26-001 리뷰 D4)
        office_changed.bump("problems")


def problems() -> list[dict]:
    """화면 위에 띄울 것: 닿지 않는 설치본, 핀과 다른 Hermes 버전."""
    out, checks = [], {t: c for t, c in last_checks().items() if t.startswith("pod:")}
    want = (pins().get("hermes") or {}).get("value", "")
    for target, c in sorted(checks.items()):
        if want and c["status"] == "ok" and c["version"] and c["version"] != want:
            who = agent_label(target[4:])
            out.append({"level": "warn", "target": target, "text": tr(f"{who} 의 Hermes 가 {c['version']} 입니다 — 검증해 둔 버전은 {want}. 오피스에서 대화가 되는지 확인한 뒤 핀을 고치세요.",
                                  f"Hermes on {who} is {c['version']}. The verified version is {want}. Check that office chat works, then update the pin.")})
    for target, c in sorted(checks.items()):
        if c["status"] != "ok":
            who = agent_label(target[4:])
            out.append({"level": "bad", "target": target, "text": tr(f"{who} 의 Hermes API 서버에 연결할 수 없습니다 ({c['detail'] or c['status']})",
                                                    f"Cannot reach the Hermes API server on {who} ({c['detail'] or c['status']})")})
    return out


def overview() -> dict:
    checks, pin = last_checks(), pins()
    return {"seats": seats(), "rooms": rooms(), "pins": {k: {"label": pin_label(k), **(pin.get(k) or {"value": ""})} for k in PIN_KEYS},
            "checks": checks, "problems": problems()}


# ---- 사람(계획 007 P6a) ----------------------------------------------------
def person_touch(email: str, name: str) -> None:
    """오피스에 들어온 사람의 표시 이름을 적어 둔다(에이전트 주인 이름에 쓴다). 얼굴 시드는 그대로 둔다."""
    if not email:
        return
    with connect() as conn:
        # 오피스 신호(10초)마다 썼다. ts 를 읽는 곳이 없어 이름이 바뀔 때만 고친다(스펙 2026-10-24-009 3-4)
        conn.execute("INSERT INTO office_people (email, name, ts) VALUES (?,?,?) ON CONFLICT(email) DO UPDATE SET name=excluded.name, ts=excluded.ts "
                     "WHERE office_people.name <> excluded.name"
                     if name else "INSERT INTO office_people (email, name, ts) VALUES (?,?,?) ON CONFLICT(email) DO NOTHING",
                     (email.lower(), _text(name, 80), _now()))


def sync_names(names: dict[str, str]) -> int:
    """사용자 목록(Keycloak)의 이름으로 표시 이름을 맞춘다. 바뀐 사람 수를 돌려준다. 얼굴 시드는 그대로 둔다."""
    known = people()
    changed = {e.lower(): _text(n, 80) for e, n in names.items() if e and _text(n, 80) and (known.get(e.lower()) or {}).get("name") != _text(n, 80)}
    if changed:
        with connect() as conn:
            for email, name in changed.items():
                conn.execute("INSERT INTO office_people (email, name, ts) VALUES (?,?,?) ON CONFLICT(email) DO UPDATE SET name=excluded.name, ts=excluded.ts",
                             (email, name, _now()))
    return len(changed)


def set_face(email: str, seed: str) -> dict:
    """내 얼굴 시드를 바꾼다(본인만, 계획 007 P6a). 비우면 이메일로 돌아간다."""
    seed = _text(seed, 40)
    with connect() as conn:
        conn.execute("INSERT INTO office_people (email, avatar_seed, ts) VALUES (?,?,?) ON CONFLICT(email) DO UPDATE SET avatar_seed=excluded.avatar_seed, ts=excluded.ts",
                     (email.lower(), seed, _now()))
    return {"ok": True, "seed": seed}


def people() -> dict[str, dict]:
    """이메일 → {name, seed}. 읽기만 하는 요청 안에서는 한 번만 읽는다(스펙 2026-10-24-009 3-2)."""
    def read() -> dict[str, dict]:
        with connect() as conn:
            return {r["email"]: {"name": r["name"], "seed": r["avatar_seed"]} for r in conn.execute("SELECT email, name, avatar_seed FROM office_people")}
    return store.memo("office.people", lambda: table_cache.get("office.people", ("office_people",), read))


# ---- 사람 열쇠(스펙 2026-10-18-009) ------------------------------------------------
# 방 담당은 구성원을 고쳐야 하지만 이메일 전체는 관리자만 본다(계획 007 R6). 담당에게는 사람을 이메일 대신 서버만 되돌릴 수 있는
# 열쇠(HMAC)로 준다. 열쇠의 비밀 값은 DB meta 에 한 번 만들어 서버 여러 대가 같은 값을 쓴다.
_secret_memo: dict[tuple, bytes] = {}


def _person_secret_forget() -> None:
    _secret_memo.clear()


def _person_secret() -> bytes:
    """사람 열쇠의 비밀 값. 한 번 만들면 바뀌지 않아, PostgreSQL 이고 듣기 연결이 붙어 있으면 기억한다 — 오피스 요청마다 읽었다
    (스펙 2026-10-26-002 §9-13). 데이터 폴더·스키마마다 따로 기억한다."""
    where = (os.environ.get("AAS_DATA_DIR", ""), db._tl_schema() if db.backend() == "postgres" else "")
    hit = _secret_memo.get(where) if table_cache.enabled() else None
    if hit is not None:
        return hit
    got = _person_secret_read()
    if table_cache.enabled():
        _secret_memo[where] = got
    return got


def _person_secret_read() -> bytes:
    import secrets
    with connect() as conn:
        row = conn.execute("SELECT value FROM meta WHERE key='office_person_key'").fetchone()
        if row:
            return bytes.fromhex(row["value"])
        conn.execute("INSERT INTO meta (key, value) VALUES ('office_person_key', ?) ON CONFLICT (key) DO NOTHING", (secrets.token_hex(32),))
        return bytes.fromhex(conn.execute("SELECT value FROM meta WHERE key='office_person_key'").fetchone()["value"])


def person_key(email: str, secret: bytes | None = None) -> str:
    import hashlib
    import hmac
    return "p_" + hmac.new(secret or _person_secret(), (email or "").strip().lower().encode(), hashlib.sha256).hexdigest()[:16]


def person_directory() -> list[dict]:
    """담당이 구성원을 고를 때 쓰는 사람 목록: 이름과 열쇠뿐(이메일은 내려가지 않는다). 오피스·사용자 목록에서 이름을 아는 사람."""
    secret = _person_secret()
    rows = [{"key": person_key(e, secret), "name": v.get("name") or e.split("@")[0]} for e, v in people().items() if "@" in e]
    return sorted(rows, key=lambda r: (r["name"], r["key"]))


def email_of_key(key: str) -> str:
    """열쇠를 이메일로 되돌린다. 모르는 열쇠면 빈 값."""
    secret = _person_secret()
    return next((e for e in people() if "@" in e and person_key(e, secret) == key), "")


def named(values: list[str], known: dict[str, dict] | None = None) -> list[str]:
    """방의 사람 목록을 화면에 보일 이름으로(2026-10-18 부터 구성원 이메일이 들어간다). 이메일이 아닌 옛 값은 그대로."""
    known = people() if known is None else known
    return [display_name(v, known) if "@" in (v or "") else v for v in values]


def who_labels(values) -> dict[str, str]:
    """회의 자료의 올린 사람·에이전트 → 화면 이름(스펙 2026-10-20-025 §6). 이메일은 사람 이름, 자리 별칭은 「주인 · 에이전트 이름」
    (설치본에 자리가 여럿이면 「· 프로파일」). 이름을 모르는 값과 바뀌지 않는 값은 빠진다 — 화면은 없으면 값 그대로 쓴다."""
    known, rows = people(), seats()
    by_alias = {s["alias"]: s for s in rows}
    per_pod: dict[str, int] = {}
    for s in rows:
        per_pod[s["pod"]] = per_pod.get(s["pod"], 0) + 1
    out = {}
    for v in set(values):
        if "@" in (v or ""):
            out[v] = display_name(v, known)
        elif v in by_alias:
            s = by_alias[v]
            lab = agent_label(s["pod"])
            if lab != s["pod"]:
                out[v] = f"{lab} · {s['profile']}" if per_pod[s["pod"]] > 1 else lab
    return {k: n for k, n in out.items() if n and n != k}


def person_name(value: str, known: dict[str, dict] | None = None) -> str:
    """기록에 남은 「누가」 값을 화면에 보일 이름으로. 이메일이면 사람 이름(모르면 앞부분), 에이전트·시스템 표시처럼 이메일이 아니면 그대로.
    화면에 남의 이메일이 이름 대신 보이지 않게 응답에 *_name 으로 함께 싣는다(사용자 지시 2026-10-30)."""
    return display_name(value, known) if "@" in (value or "") else (value or "")


def display_name(email: str, known: dict[str, dict] | None = None) -> str:
    """사람에게 보일 이름. 모르면 이메일 앞부분 — 이메일 전체는 관리자에게만 보인다(계획 007 R6)."""
    known = people() if known is None else known
    name = (known.get((email or "").lower()) or {}).get("name") or ""
    return name or (email or "").split("@")[0]

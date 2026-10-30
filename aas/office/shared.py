# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""서버 복제본 사이에 오피스의 실시간 정보를 나눈다(계획 007 §10, OMAI-1105 복제본 2개).

브라우저는 한 서버에 고정되고(고정 쿠키), 대화 연결(ChatHub)은 대화를 연 서버에만 있다. 그래서 그 서버만 아는 것을
공유 DB 에 적어 다른 서버가 읽게 한다. 쓰는 쪽이 같은 트랜잭션에서 `pg_notify` 로 알리고, 각 서버는 전용 연결로 듣다가
알림이 오면 `server.shared_tick` 에서 그 종류만 읽는다. 알림을 놓쳐도 5초마다 셋을 읽는다(스펙 2026-10-24-009 4절).
SQLite(서버 하나)는 알림 없이 0.3초마다 읽는다.

  office_relay          말풍선 이벤트(chat.start·chat.end·tool·chat.delta·agent.lastSeen). 낸 서버가 적고 다른 서버가
                        자기 이벤트 줄에 다시 낸다. 받는 사람(`_to`)을 그대로 옮겨 공개 범위 표(event_view)가 같게 적용된다.
  office_busy           서버마다 지금 진행 중인 대화(설치본, 프로파일). 다른 서버도 그 자리를 「일하는 중」으로 그린다.
  office_inbox          답하지 않은 승인·되묻기. 대화를 연 서버가 적고 지운다.
  office_inbox_answers  다른 서버에서 한 답. 대화를 연 서버가 가져가 처리하고 결과를 적는다.
  office_servers        서버마다 살아 있다는 신호. 신호가 끊긴 서버의 대화·요청은 믿지 않는다(그 서버가 죽으면 대화도 끝났다).
"""
from __future__ import annotations

import hashlib
import json
import threading
import time
import uuid

from ..common import cache_epoch, db, store, table_cache
from . import office

ALIVE = 30.0                                   # 이만큼 신호가 없으면 죽은 서버로 본다
BEAT_EVERY = 10.0                              # 살아 있음 신호를 쓰는 간격(초). 5초였다 — ALIVE 안에 신호가 셋 들어간다(스펙 2026-10-26-002 §9-12)
ALIVE_MEMO = BEAT_EVERY                        # 살아 있는 서버 목록을 기억하는 시간(초, 스펙 2026-10-26-002 R6). 신호 간격보다 길게 기억할 까닭이 없다
RELAY_KEEP = 120.0                             # 중계 기록을 남기는 시간(초)
RELAY_WINDOW = 65.0                            # 중계를 읽을 때 되돌아보는 시간 — 60초 폴백에서도 유실되지 않게 65초(스펙 2026-10-25-001 R4·D2)
# desks.changed 도 건넨다 — 다른 서버에서 방·자리·권한을 바꿔도 이 서버에 붙은 장면이 다시 받아 보기 범위가 맞는다(스펙 2026-10-21-022 리뷰 R5)
RELAYED = frozenset({"chat.start", "chat.end", "tool", "chat.delta", "agent.lastSeen", "desks.changed",
                     "agent.status", "seat.added", "seat.removed", "layout.changed"})
# 자리 상태는 리더의 5초 반복만 계산해 중계한다(스펙 2026-10-24-011 R3). 리더가 아닌 서버가 화면 요청으로 계산한 상태는 내보내지 않는다 —
# 리더보다 몇 초 늦은 값이 건너가면 화면이 잠깐 옛 상태로 돌아간다
LEADER_RELAYED = frozenset({"agent.status", "seat.added", "seat.removed"})

SCHEMA = """
CREATE TABLE IF NOT EXISTS office_servers (origin TEXT PRIMARY KEY, ts REAL NOT NULL);
CREATE TABLE IF NOT EXISTS office_relay /* unlogged */ (
  id INTEGER PRIMARY KEY AUTOINCREMENT, origin TEXT NOT NULL, type TEXT NOT NULL, payload TEXT NOT NULL, ts REAL NOT NULL);
CREATE TABLE IF NOT EXISTS office_busy (origin TEXT NOT NULL, pod TEXT NOT NULL, profile TEXT NOT NULL, PRIMARY KEY (origin, pod, profile));
CREATE TABLE IF NOT EXISTS office_collected (id INTEGER PRIMARY KEY, origin TEXT NOT NULL, body TEXT NOT NULL, ts REAL NOT NULL);
CREATE TABLE IF NOT EXISTS office_collected_pod /* unlogged */ (pod TEXT PRIMARY KEY, origin TEXT NOT NULL, body TEXT NOT NULL, ts REAL NOT NULL);
CREATE TABLE IF NOT EXISTS health_collected (slot TEXT NOT NULL, pod TEXT NOT NULL, body TEXT NOT NULL, ts REAL NOT NULL, PRIMARY KEY (slot, pod));
CREATE TABLE IF NOT EXISTS office_inbox (id TEXT PRIMARY KEY, origin TEXT NOT NULL, item TEXT NOT NULL, at REAL NOT NULL);
CREATE TABLE IF NOT EXISTS office_inbox_answers (
  id TEXT PRIMARY KEY, origin TEXT NOT NULL, body TEXT NOT NULL, by TEXT NOT NULL DEFAULT '', ts REAL NOT NULL, result TEXT);
"""


def _connect():
    conn = office.connect()
    conn.executescript(SCHEMA)
    return conn


# ---- 알림(PostgreSQL LISTEN/NOTIFY) ------------------------------------------------
KINDS = ("presence", "relay", "answer")
FALLBACK = 5.0                                 # 알림을 놓쳤거나 연결이 끊겼을 때의 폴백 주기(초)
FALLBACK_LISTEN = 60.0                         # 듣기 연결이 정상일 때의 폴백 주기(초, 스펙 2026-10-25-001 R4)
MIN_GAP = 0.3                                  # 같은 종류는 이보다 자주 읽지 않는다 — 걸음이 몰려도 지금 주기(0.3초)보다 늘지 않게(리뷰 C7)


def channel_for(schema: str) -> str:
    """알림 채널 이름. 채널은 DB 전체에 걸려 스키마별 설치·시험끼리 섞이지 않게 스키마를 넣는다(외부 검토 M5, 63바이트 안)."""
    return "aas_shared_" + hashlib.sha1(schema.encode()).hexdigest()[:8]


def channel() -> str:
    return channel_for(db._tl_schema())


def notify(conn, kind: str) -> None:
    """쓰기와 같은 트랜잭션에서 알린다 — 커밋될 때만 나가고 되돌려지면 나가지 않는다. SQLite 는 아무것도 하지 않는다."""
    if db.is_pg(conn):
        conn.execute("SELECT pg_notify(?, ?)", (channel(), kind))


def parse_notify(payload: str, me: str) -> str | None:
    """알림 내용 → 이 서버가 읽을 종류. 걸음은 누가 냈든 읽는다(내 서버 화면도 읽기로 받는다, 리뷰 C6). 내 말풍선·남의 답은 무시."""
    kind, _, origin = str(payload or "").partition(":")
    if kind == "presence":
        return "presence"
    if kind == "relay" and origin and origin != me:
        return "relay"
    if kind == "answer" and origin == me:
        return "answer"
    if kind == "desks":
        return "desks"
    if kind == "office_changed":                  # 오피스 정보 변경 번호(스펙 2026-10-26-001). 내가 올린 것도 받는다 — 다시 읽기는 한 번 더여도 같다
        return "office_changed"
    if kind == "meeting":                         # 회의 상태가 바뀌었다 — 내가 쓴 것도 받는다(스펙 2026-10-26-002 R7)
        return "meeting"
    return None


def due_reads(now: float, pending: set, last: dict, last_full: float, pg: bool, listening: bool = True) -> tuple[set, set, bool]:
    """이번 주기에 읽을 종류, 다음 주기로 미룰 종류, 폴백 반복 읽기인가. SQLite 는 알림이 없어 지금처럼 매번 셋을 읽는다.
    PostgreSQL 은 정상 청취 중에는 60초 폴백, 끊기면 5초 폴백(스펙 2026-10-25-001 R4)."""
    if not pg:
        return set(KINDS), set(), True
    fallback = FALLBACK_LISTEN if listening else FALLBACK
    if now - last_full >= fallback:
        return set(KINDS), set(), True
    reads = {k for k in pending if now - last.get(k, 0.0) >= MIN_GAP}
    return reads, set(pending) - reads, False


class Listener:
    """풀 밖의 전용 연결 하나(autocommit)로 LISTEN 한다. 알림 내용은 on_notify 로 넘기고, 붙을 때마다 on_connect 를 부른다
    (끊긴 동안의 알림을 놓쳤으니 부른 쪽이 한 번 다 읽는다). 끊기면 retry 초 뒤 다시 붙는다. 읽기는 부른 쪽 스레드가 한다."""

    def __init__(self, on_notify, on_connect, connect=None, retry: float = 5.0):
        self._on_notify, self._on_connect, self._retry = on_notify, on_connect, retry
        self._connect = connect or self._default_connect
        self._stop = threading.Event()
        self._conn = None
        self.connected = False
        self._thread: threading.Thread | None = None

    @staticmethod
    def _default_connect():
        import psycopg
        return psycopg.connect(db._backend().conninfo(5), autocommit=True)

    def start(self) -> None:
        if self._thread is None:
            self._thread = threading.Thread(target=self._run, daemon=True, name="aas-shared-listen")
            self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        conn = self._conn
        if conn is not None:
            try:
                conn.close()
            except Exception:  # noqa: BLE001 — 닫는 중 오류는 무시한다
                pass
        if self._thread is not None:
            self._thread.join(timeout=5)

    def _run(self) -> None:
        while not self._stop.is_set():
            try:
                self._conn = self._connect()
                self._conn.execute(f'LISTEN "{channel()}"')
                epoch_ch = cache_epoch.channel()
                self._conn.execute(f'LISTEN "{epoch_ch}"')
                tbl_ch = table_cache.channel()                 # 표 바뀜 알림(스펙 2026-10-26-002 R10)
                self._conn.execute(f'LISTEN "{tbl_ch}"')
                self.connected = True
                print("서버 사이 알림 듣기 연결이 붙었습니다", flush=True)   # i18n-ignore: 로그
                self._on_connect()
                while not self._stop.is_set():
                    for n in self._conn.notifies(timeout=1.0):
                        ch = getattr(n, "channel", None)
                        if ch == epoch_ch:
                            cache_epoch.on_notify(n.payload)
                        elif ch == tbl_ch:
                            table_cache.on_notify(n.payload)
                        else:
                            self._on_notify(n.payload)
            except Exception as exc:  # noqa: BLE001 — DB 가 잠시 끊겨도 다시 붙는다. 그동안은 5초 반복 읽기가 맞춘다
                if not self._stop.is_set():
                    print(f"서버 사이 알림 듣기 연결이 끊겼습니다: {type(exc).__name__}", flush=True)   # i18n-ignore: 로그
            finally:
                self.connected = False
                if self._conn is not None:
                    try:
                        self._conn.close()
                    except Exception:  # noqa: BLE001
                        pass
                    self._conn = None
            self._stop.wait(self._retry)


class Shared:
    def __init__(self, origin: str | None = None, clock=time.time):
        self.origin = origin or uuid.uuid4().hex[:12]
        self._clock = clock
        self.bus = None
        self.relay_status = lambda: True                 # 자리 상태를 중계해도 되는가 — 서버가 리더 여부로 바꾼다(LEADER_RELAYED)
        # 받은 중계 (번호, 시각) → 받은 시각(되돌아보는 창 안에서 두 번 받지 않게). 중계 표는 UNLOGGED 라 PostgreSQL 이 비정상 종료되면
        # 비워지고 번호가 다시 시작할 수 있어 번호만으로 가리지 않는다(스펙 2026-10-24-010 외부 검토 N9)
        self._seen: dict[tuple, float] | None = None
        self._busy: set | None = None
        self._lock = threading.Lock()
        self._alive_memo: tuple[float, set[str]] | None = None   # (읽은 시각, 살아 있는 서버) — ALIVE_MEMO 초 기억

    # ---- 살아 있음 -----------------------------------------------------------
    def heartbeat(self) -> None:
        with _connect() as conn:
            conn.execute("INSERT INTO office_servers (origin, ts) VALUES (?,?) ON CONFLICT(origin) DO UPDATE SET ts=excluded.ts",
                         (self.origin, self._clock()))

    def alive_servers(self) -> list[str]:
        """살아 있는 서버 origin(나 포함). 담당 서버 정하기(owner)가 쓴다."""
        with _connect() as conn:
            return sorted(self._alive(conn))

    def _alive(self, conn) -> set[str]:
        """살아 있는 서버들. 나는 첫 신호를 쓰기 전에도 살아 있다. 신호는 BEAT_EVERY 초마다라 ALIVE_MEMO 초 기억한다 — 읽을 때마다 물었다(초당 약 1건,
        스펙 2026-10-26-002 R6). 새 서버는 최대 ALIVE_MEMO 초 늦게 알아, 그동안 맡을 에이전트(owner.mine)가 잠깐 다를 수 있다."""
        now = self._clock()
        with self._lock:
            memo = self._alive_memo
        if memo is not None and 0 <= now - memo[0] < ALIVE_MEMO:
            return set(memo[1])
        alive = {r[0] for r in conn.execute("SELECT origin FROM office_servers WHERE ts >= ?", (now - ALIVE,))} | {self.origin}
        with self._lock:
            self._alive_memo = (now, alive)
        return set(alive)

    # ---- 말풍선 이벤트 중계 ----------------------------------------------------
    def attach(self, bus) -> None:
        """이 서버의 오피스 이벤트 줄에 붙는다. 여기서 낸 말풍선 이벤트를 DB 에 적는다."""
        self.bus = bus
        bus.on_publish = self.relay_out

    def relay_out(self, etype: str, payload: dict) -> None:
        if etype not in RELAYED or (etype in LEADER_RELAYED and not self.relay_status()):
            return
        with _connect() as conn:
            conn.execute("INSERT INTO office_relay (origin, type, payload, ts) VALUES (?,?,?,?)",
                         (self.origin, etype, json.dumps(payload, ensure_ascii=False), self._clock()))
            notify(conn, f"relay:{self.origin}")

    def relay_in(self) -> list[tuple[str, dict]]:
        """다른 서버가 낸 말풍선 이벤트 중 아직 받지 않은 것. 이 서버의 이벤트 줄에 다시 낸다(DB 로 되돌려 적지 않는다).
        처음 부르면 바탕만 잡는다(서버가 뜨기 전 이벤트는 보내지 않는다)."""
        now = self._clock()
        with _connect() as conn:
            rows = [((r["id"], r["ts"]), r["type"], r["payload"]) for r in conn.execute(
                "SELECT id, ts, type, payload FROM office_relay WHERE origin <> ? AND ts >= ? ORDER BY id",
                (self.origin, now - RELAY_WINDOW))]
        with self._lock:
            first = self._seen is None
            seen = self._seen if self._seen is not None else {}
            fresh = [(i, t, p) for i, t, p in rows if i not in seen]
            for i, _t, _p in fresh:
                seen[i] = now
            self._seen = {i: at for i, at in seen.items() if at >= now - RELAY_WINDOW * 2}
        if first:
            return []
        out = [(t, json.loads(p)) for _i, t, p in fresh]
        if self.bus is not None:
            for t, p in out:
                self.bus.publish(t, p, relay=False)
        return out

    # ---- 리더가 계산한 자리 상태의 재료 --------------------------------------------------
    def put_collected_pods(self, rows: dict) -> None:
        """담당 서버가 읽은 에이전트별 (마지막 실행 실패, 실행 중, 읽지 못함)을 한 문장으로 적는다(스펙 2026-10-25-001 R2·D6)."""
        if not rows:
            return
        now = self._clock()
        items = []
        for pid, (failed, running, bad) in sorted(rows.items()):
            body = json.dumps({"failed": sorted(map(list, failed)), "running": sorted(map(list, running)), "bad": bool(bad)}, ensure_ascii=False)
            items.extend([pid, self.origin, body, now])
        sql = db.upsert_many("office_collected_pod", ("pod", "origin", "body", "ts"), ("pod",), len(rows))
        if sql:
            with _connect() as conn:
                conn.execute(sql, items)

    def get_collected_pods(self, max_age: float) -> dict:
        """max_age 초 안에 적힌 에이전트별 줄. {에이전트: (실패, 실행 중, 읽지 못함)}. 오래된 줄은 빼고 돌려준다(부른 쪽이 직접 읽는다)."""
        since = self._clock() - max_age
        if db.backend() == "postgres":
            rows = [{"pod": pod, "body": body} for pod, body, ts in self._leader_rows()[0] if ts >= since]
        else:
            with _connect() as conn:
                rows = conn.execute("SELECT pod, body FROM office_collected_pod WHERE ts >= ?", (since,)).fetchall()
        out = {}
        for r in rows:
            got = json.loads(r["body"])
            out[r["pod"]] = ({tuple(x) for x in got["failed"]}, {tuple(x) for x in got["running"]}, bool(got["bad"]))
        return out

    def _leader_rows(self) -> tuple[list, list]:
        """PostgreSQL: 재료 줄 [(에이전트, 본문, 시각)] 과 일하는 중 줄 [(origin, 에이전트, 프로파일)] 을 한 문장으로 읽는다. 리더 스냅샷이 두 표를
        따로 읽어 문장이 둘이었다(스펙 2026-10-26-002 R13). request_memo 범위 안이면 한 번만 읽는다. 시각은 부른 쪽이 거른다."""
        def read():
            with _connect() as conn:
                r = conn.execute("SELECT (SELECT COALESCE(json_agg(json_build_array(pod, body, ts)), '[]'::json) FROM office_collected_pod) AS c, "
                                 "(SELECT COALESCE(json_agg(json_build_array(origin, pod, profile)), '[]'::json) FROM office_busy) AS b").fetchone()
            return [tuple(x) for x in r["c"]], [tuple(x) for x in r["b"]]
        return store.memo(f"shared.leader_rows:{self.origin}", read, clone=lambda v: v)   # 부른 쪽은 고치지 않고 새 값을 만든다

    # ---- 일하는 중 --------------------------------------------------------------
    def set_busy(self, keys: set) -> None:
        """이 서버에서 진행 중인 대화(설치본, 프로파일). 바뀔 때만 쓴다."""
        keys = set(keys)
        if keys == self._busy:
            return
        with _connect() as conn:
            conn.execute("DELETE FROM office_busy WHERE origin=?", (self.origin,))
            for pod, profile in sorted(keys):
                conn.execute("INSERT INTO office_busy (origin, pod, profile) VALUES (?,?,?)", (self.origin, pod, profile))
        self._busy = keys

    def remote_busy(self) -> set:
        with _connect() as conn:
            alive = self._alive(conn) - {self.origin}
            if db.backend() == "postgres":
                return {(pod, profile) for origin, pod, profile in self._leader_rows()[1] if origin in alive}
            return {(r["pod"], r["profile"]) for r in conn.execute("SELECT origin, pod, profile FROM office_busy") if r["origin"] in alive}

    # ---- 받은편지함 -------------------------------------------------------------
    def inbox_put(self, item_id: str, item: dict) -> None:
        with _connect() as conn:
            conn.execute("INSERT INTO office_inbox (id, origin, item, at) VALUES (?,?,?,?) "
                         "ON CONFLICT(id) DO UPDATE SET origin=excluded.origin, item=excluded.item, at=excluded.at",
                         (item_id, self.origin, json.dumps(item, ensure_ascii=False), float(item.get("at") or self._clock())))

    def inbox_drop(self, item_ids: list[str]) -> None:
        if not item_ids:
            return
        with _connect() as conn:
            for i in item_ids:
                conn.execute("DELETE FROM office_inbox WHERE id=?", (i,))   # 답 기록은 남긴다 — 답한 서버가 결과를 읽는다(cleanup 이 지운다)

    def inbox_items(self) -> dict[str, dict]:
        """살아 있는 서버의 요청 전부(id → 항목, 항목에 origin 을 붙인다)."""
        def read() -> list[tuple]:
            with _connect() as conn:
                return [(r["id"], r["origin"], r["item"]) for r in conn.execute("SELECT id, origin, item FROM office_inbox ORDER BY at")]
        rows = table_cache.get("shared.inbox", ("office_inbox",), read, clone=list)   # 받은편지함 신호가 사람마다 15초마다 읽었다(스펙 2026-10-26-002 §9-14)
        with _connect() as conn:
            alive = self._alive(conn)
        return {rid: {**json.loads(item), "origin": origin} for rid, origin, item in rows if origin in alive}

    def answer_put(self, item_id: str, body: dict, by: str) -> None:
        with _connect() as conn:
            row = conn.execute("SELECT origin FROM office_inbox WHERE id=?", (item_id,)).fetchone()
            if row is None:
                return
            conn.execute("INSERT INTO office_inbox_answers (id, origin, body, by, ts, result) VALUES (?,?,?,?,?,NULL) "
                         "ON CONFLICT(id) DO UPDATE SET body=excluded.body, by=excluded.by, ts=excluded.ts, result=NULL",
                         (item_id, row["origin"], json.dumps(body, ensure_ascii=False), by, self._clock()))
            notify(conn, f"answer:{row['origin']}")

    def answers_for_me(self) -> list[dict]:
        """다른 서버에서 한 답 중 이 서버의 대화에 대한 것(아직 처리하지 않은 것)."""
        with _connect() as conn:
            return [{"id": r["id"], "body": json.loads(r["body"]), "by": r["by"]}
                    for r in conn.execute("SELECT id, body, by FROM office_inbox_answers WHERE origin=? AND result IS NULL", (self.origin,))]

    def answer_done(self, item_id: str, result: dict) -> None:
        with _connect() as conn:
            conn.execute("UPDATE office_inbox_answers SET result=? WHERE id=?", (json.dumps(result, ensure_ascii=False), item_id))

    def answer_result(self, item_id: str) -> dict | None:
        with _connect() as conn:
            row = conn.execute("SELECT result FROM office_inbox_answers WHERE id=?", (item_id,)).fetchone()
        return json.loads(row["result"]) if row and row["result"] else None

    # ---- 정리 -------------------------------------------------------------------
    def cleanup(self) -> None:
        """오래된 중계, 죽은 서버의 일하는 중·요청을 지운다(어느 서버가 해도 같다)."""
        now = self._clock()
        with _connect() as conn:
            conn.execute("DELETE FROM office_relay WHERE ts < ?", (now - RELAY_KEEP,))
            conn.execute("DELETE FROM office_inbox_answers WHERE ts < ?", (now - RELAY_KEEP * 30,))
            dead = [r[0] for r in conn.execute("SELECT origin FROM office_servers WHERE ts < ?", (now - ALIVE * 10,))]
            for origin in dead:
                for t in ("office_busy", "office_inbox", "office_servers"):
                    conn.execute(f"DELETE FROM {t} WHERE origin=?", (origin,))
        # 죽은 서버의 회의 답 기다림은 여기서 지우지 않는다 — 안내 없이 지우면 답이 사라진 것을 알 수 없었다.
        # meeting.sweep_lost 가 「답을 받지 못했습니다」 줄을 남기며 지운다(스펙 2026-10-20-030 4-8 4-1, server.shared_tick)


# ---- 30분 상태 수집 나누기(스펙 2026-10-24-013 3단계 D5) ------------------------------------------
def put_health(slot: str, pod_id: str, body: dict) -> None:
    """담당 서버가 이번 수집 창(slot)에 읽은 한 에이전트의 결과(collect_all.scoped 또는 failure). 이틀 지난 줄은 지운다."""
    now = time.time()
    with _connect() as conn:
        conn.execute(db.upsert("health_collected", ("slot", "pod", "body", "ts"), ("slot", "pod")),
                     (slot, pod_id, json.dumps(body, ensure_ascii=False, default=str), now))
        conn.execute("DELETE FROM health_collected WHERE ts < ?", (now - 2 * 86400,))


def get_health(slot: str) -> dict:
    with _connect() as conn:
        rows = conn.execute("SELECT pod, body FROM health_collected WHERE slot = ?", (slot,)).fetchall()
    return {r["pod"]: json.loads(r["body"]) for r in rows}

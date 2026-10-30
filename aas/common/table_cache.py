# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""자주 바뀌지 않는 표의 프로세스 캐시와 「표 바뀜」 알림(스펙 2026-10-26-002 R10).

자리·방·사람·배치·무시한 크론·공지 같은 표를 5초 반복과 화면 요청이 계속 다시 읽었다(OKE 에서 이 표들만 초당 약 3건).
값은 원본에서만 무효화한다 — 캐시에 든 값에서 판별값을 다시 계산하지 않는다(2026-10-26 memo_disc 사고).

- 표마다 문장 단위 트리거 세 개(INSERT·UPDATE·DELETE)가 바뀐 행이 있을 때만 `pg_notify('aas_tbl_<스키마 해시>', 표 이름)` 을 보낸다(H2).
  트리거라서 어느 서버가 쓰든, psql 로 직접 쓰든 알린다. 롤백한 쓰기는 알리지 않는다. 트리거는 이 캐시가 그 표를 처음 쓸 때 단다.
- 이 프로세스의 쓰기는 알림을 기다리지 않는다. db 층이 대상 표에 쓰는 문장을 보면 그 자리에서, 그리고 커밋 뒤에 한 번 더 표의 세대를
  올린다(C1 — room.set 직후 같은 스레드가 방을 다시 읽는다).
- 읽기 시작 때의 세대와 저장 때의 세대가 다르면 저장하지 않는다(H1). 쓰기 트랜잭션이 열린 채 읽은 값은 저장하지 않는다(E3).
- 같은 열쇠는 한 스레드만 읽고 나머지는 기다린다(E2). 버리면 다음 읽기는 반드시 DB 를 읽는다(옛 값을 먼저 주지 않는다).
- PostgreSQL 이고 서버 사이 듣기 연결이 붙어 있을 때만 캐시한다. SQLite·끊김·트리거를 달지 못한 표는 지금처럼 매번 읽는다.
  알림을 놓칠 때를 위해 TTL(60초)을 둔다. 듣기 연결이 다시 붙으면 모두 버린다.
"""
from __future__ import annotations

import copy
import hashlib
import re
import threading
import time
from typing import Any, Callable, Iterable

from . import db

TTL = 60.0
_clock = time.monotonic
listening: Callable[[], bool] = lambda: False             # 서버가 넣는다(shared.Listener 가 붙어 있는가)

_lock = threading.Lock()
_epoch = [0]                                               # 다시 붙음 등으로 모두 버린 횟수
_gen: dict[tuple[str, str], int] = {}                      # (스키마, 표) → 세대
_store: dict[tuple[str, str], tuple[float, tuple, Any]] = {}   # (스키마, 열쇠) → (저장 시각, 세대들, 값)
_key_locks: dict[tuple[str, str], threading.Lock] = {}
_installed: set[tuple[str, str]] = set()                   # 트리거를 단 (스키마, 표)
_failed: dict[tuple[str, str], float] = {}                # 트리거를 달지 못한 (스키마, 표) → 다시 해 볼 시각. 그때까지 캐시하지 않는다
RETRY = 60.0

TABLES = frozenset({"cron_muted", "office_seats", "office_rooms", "office_room_members", "office_people", "office_layouts",
                    "office_desk_assignments", "office_room_places", "notices", "pod_owners", "pod_primary", "user_directory",
                    "agent_limits",                     # 에이전트 목록이 부를 때마다 두 번 읽었다(스펙 2026-10-26-002 §9-12)
                    "agent_sizes",                      # 작업공간 크기(스펙 2026-10-30-003 §4-4)
                    # §9-14: 받은편지함 신호·진행 카드(값 캐시)와 대기 줄(값은 캐시하지 않고 「비었고 바뀌지 않음」만 본다, quiet)
                    "office_cards", "office_card_owner", "office_inbox", "admin_requests",
                    "market_update_pending", "market_update_auto", "office_meeting_pending", "office_meeting_lost",
                    # 「확인할 것」 확인 표 — 빠지면 쓴 뒤에도 TTL(60초) 동안 옛 값을 주어 확인한 줄이 남는다(2026-10-30 OKE #499 에서 겪음)
                    "issue_acks"})
_WRITE = re.compile(r"^\s*(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+\"?([A-Za-z_]\w*)\"?", re.I)


def channel_for(schema: str) -> str:
    """알림 채널 이름(스키마 해시 포함, 63바이트 안). 트리거에는 이 값을 글자로 넣는다(PostgreSQL 에 sha1 이 없다, M5)."""
    return "aas_tbl_" + hashlib.sha1(schema.encode()).hexdigest()[:8]


def channel() -> str:
    return channel_for(db._tl_schema())


def _schema() -> str:
    return db._tl_schema()


def enabled() -> bool:
    return db.backend() == "postgres" and listening()


def _gens(schema: str, tables: Iterable[str]) -> tuple:
    return (_epoch[0],) + tuple(_gen.get((schema, t), 0) for t in tables)


def _ready(schema: str, tables: Iterable[str]) -> bool:
    """이 표들에 트리거를 모두 달았는가."""
    return all((schema, t) in _installed for t in tables)


def _install(schema: str, tables: Iterable[str]) -> bool:
    """대상 표에 트리거를 단다(이 프로세스에서 스키마·표마다 한 번). 하나라도 못 달면 거짓 — 그 열쇠는 캐시하지 않는다."""
    need = [t for t in tables if (schema, t) not in _installed]
    if not need:
        return True
    if any(_clock() < _failed.get((schema, t), 0.0) for t in need):
        return False
    if db.tx_depth() > 0:                                     # 부른 쪽 트랜잭션 안에서 달면 그 롤백에 함께 사라진다 — 다음 기회에
        return False
    ch = channel_for(schema)
    conn = db.connect()
    try:
        conn.execute("CREATE OR REPLACE FUNCTION aas_table_changed() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN "
                     "IF EXISTS (SELECT 1 FROM aas_changed_rows) THEN PERFORM pg_notify(TG_ARGV[0], TG_TABLE_NAME); END IF; "
                     "RETURN NULL; END $$")
        for t in need:
            # 전이 표(REFERENCING)는 사건 하나짜리 트리거에만 걸 수 있다 — 셋으로 나눈다
            for name, event, ref in (("ins", "INSERT", "NEW"), ("upd", "UPDATE", "NEW"), ("del", "DELETE", "OLD")):
                conn.execute(f"CREATE OR REPLACE TRIGGER aas_tbl_{name} AFTER {event} ON {t} REFERENCING {ref} TABLE AS aas_changed_rows "
                             f"FOR EACH STATEMENT EXECUTE FUNCTION aas_table_changed('{ch}')")
            _installed.add((schema, t))
        return True
    except Exception as exc:                                  # 표가 아직 없거나 권한이 없으면 지금처럼 매번 읽는다
        print(f"표 바뀜 트리거를 달지 못했습니다({','.join(need)}): {type(exc).__name__}", flush=True)   # i18n-ignore: 운영자 로그
        with _lock:
            for t in need:
                if (schema, t) not in _installed:
                    _failed[(schema, t)] = _clock() + RETRY
        return False


def get(key: str, tables: tuple[str, ...], read: Callable[[], Any], clone: Callable[[Any], Any] | None = copy.deepcopy, ttl: float = TTL):
    """tables 를 읽어 만든 값. 캐시를 쓸 수 없으면 read() 를 그대로 부른다. 돌려주는 값은 clone 한 것이다(부른 쪽이 고쳐도 번지지 않게)."""
    if not enabled():
        return read()
    schema = _schema()
    if not _ready(schema, tables):
        # 처음에는 읽은 뒤에 트리거를 단다 — 읽는 함수가 표를 만드는 경우가 있다(공지·사람). 이번 값은 남기지 않는다:
        # 읽기와 달기 사이의 쓰기는 알림이 없다. 못 달면 RETRY 초 뒤 다시 해 본다
        value = read()
        _install(schema, tables)
        return value
    k = (schema, key)
    with _lock:
        hit = _store.get(k)
        if hit is not None and hit[1] == _gens(schema, tables) and _clock() - hit[0] < ttl:
            return clone(hit[2]) if clone else hit[2]
        klock = _key_locks.setdefault(k, threading.Lock())
    with klock:                                               # 같은 열쇠는 한 스레드만 읽는다
        with _lock:
            gens = _gens(schema, tables)
            hit = _store.get(k)
            if hit is not None and hit[1] == gens and _clock() - hit[0] < ttl:
                return clone(hit[2]) if clone else hit[2]
        value = read()
        if not db.in_write_tx():                              # 되돌려질 수 있는 값은 남기지 않는다(E3)
            with _lock:
                if _gens(schema, tables) == gens:             # 읽는 사이에 바뀌었으면 남기지 않는다(H1)
                    _store[k] = (_clock(), gens, value)
    return clone(value) if clone else value


_quiet: dict[tuple[str, str], tuple[float, tuple]] = {}   # (스키마, 열쇠) → (본 시각, 그때의 세대들)


def quiet(key: str, tables: tuple[str, ...]) -> bool:
    """지난번 이 열쇠로 읽었을 때 비어 있었고(mark_quiet) 그 뒤 표가 바뀐 적이 없으면 참 — 다시 읽지 않아도 된다.
    대기 줄처럼 값을 캐시하면 안 되는 표에 쓴다(옛 값으로 같은 일을 두 번 할 수 있다). TTL 이 지나면 거짓(알림을 놓칠 때를 위해)."""
    if not enabled():
        return False
    schema = _schema()
    if not _ready(schema, tables):
        return False
    with _lock:
        hit = _quiet.get((schema, key))
        return hit is not None and hit[1] == _gens(schema, tables) and 0 <= _clock() - hit[0] < TTL


def quiet_token(tables: tuple[str, ...]):
    """읽기 전에 부른다. 읽은 결과가 비었으면 mark_quiet 에 넘긴다. 캐시를 못 쓰면 None(트리거가 없으면 단다)."""
    if not enabled():
        return None
    schema = _schema()
    if not _ready(schema, tables) and not _install(schema, tables):
        return None
    with _lock:
        return (_clock(), _gens(schema, tables))


def mark_quiet(key: str, token) -> None:
    """읽은 결과가 비었다. 읽기 전 세대(token)로 적는다 — 읽는 사이에 바뀌었으면 다음 quiet 가 거짓이 된다(H1)."""
    if token is None or db.in_write_tx():
        return
    with _lock:
        _quiet[(_schema(), key)] = token


def invalidate(tables: Iterable[str], schema: str | None = None) -> None:
    """이 표들을 읽어 만든 값을 버린다(세대를 올린다)."""
    schema = schema or _schema()
    with _lock:
        for t in tables:
            _gen[(schema, t)] = _gen.get((schema, t), 0) + 1


def on_notify(payload: str) -> None:
    """표 바뀜 알림(내용은 표 이름). 어느 서버가 썼든 버린다 — 내가 쓴 것을 한 번 더 버려도 다음 읽기가 한 번 늘 뿐이다."""
    table = str(payload or "")
    if table in TABLES:
        invalidate((table,))


def reset_all() -> None:
    """듣기 연결이 (다시) 붙었다 — 끊긴 동안의 알림을 놓쳤을 수 있어 모두 버린다."""
    with _lock:
        _epoch[0] += 1


def written_table(sql: str) -> str | None:
    """이 문장이 쓰는 대상 표(INSERT·UPDATE·DELETE). 대상 표가 아니면 None."""
    m = _WRITE.match(sql)
    if m and m.group(1).lower() in TABLES:
        return m.group(1).lower()
    return None


db.write_watch = written_table                             # 이 프로세스의 쓰기를 알림 없이 곧바로 반영한다(C1)
db.write_done = lambda tables: invalidate(tables)


def clear_for_test() -> None:
    with _lock:
        _store.clear()
        _quiet.clear()
        _gen.clear()
        _installed.clear()
        _failed.clear()
        _key_locks.clear()
        _epoch[0] += 1

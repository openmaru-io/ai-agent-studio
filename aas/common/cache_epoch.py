# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""서버 복제본 사이에 「이 POD 의 캐시를 버렸다」는 신호를 나눈다(OMAI-1287).

화면 데이터 캐시(`server._cached`)는 프로세스 메모리에만 있다. 바꾸는 요청을 받은 복제본만 캐시를 버리면 다른 복제본은 옛 값을
유효 시간(최대 5분)이 지나도록 준다. 그래서 캐시를 버릴 때마다 DB 의 `meta` 표에 접두사(보통 POD id)별 토큰을 새로 쓰고,
다른 복제본은 이 토큰이 바뀐 것을 보면 그 POD 의 로컬 캐시를 버린다.

- PostgreSQL(복제본이 여럿)에서만 동작한다. SQLite(서버 하나)는 신호가 필요 없다.
- 다른 복제본의 변경은 LISTEN/NOTIFY 로 받는다. 표 읽기는 처음과 알림 연결이 다시 붙을 때(sync)만 한다(스펙 2026-10-25-001 R3).
- DB 오류는 삼킨다 — 신호를 못 나눠도 화면은 지금까지의 동작(프로세스 안 캐시)으로 돈다.
스펙: cogentai-aas-docs docs-plan/server/aas-cache-cross-replica.md
"""
from __future__ import annotations

import hashlib
import threading
import uuid

from . import config, db, store

KEY = "cache_epoch:"
POLL = 1.0                       # 하위 호환 상수

_lock = threading.Lock()         # _seen·_dirty 보호
_seen: dict[str, str] = {}       # 이 프로세스가 마지막으로 본 토큰
_dirty: set[str] = set()         # 다른 복제본이 변경해 로컬 캐시를 버려야 하는 접두사
_initialized = False
ORIGIN = uuid.uuid4().hex[:12]   # 이 프로세스. 알림 내용 「ORIGIN|접두사」로 자기 알림을 가린다(접두사에는 ':' 가 들어간다)


def enabled() -> bool:
    return config.db_backend() == "postgres"


def channel_for(schema: str) -> str:
    """캐시 무효화 알림 채널 이름(스키마 해시 포함, 63바이트 안)."""
    return "aas_epoch_" + hashlib.sha1(schema.encode()).hexdigest()[:8]


def channel() -> str:
    return channel_for(db._tl_schema())


def _read() -> dict[str, str]:
    with store.connect() as conn:
        rows = conn.execute("SELECT key, value FROM meta WHERE key LIKE ?", (KEY + "%",)).fetchall()
    return {str(r[0])[len(KEY):]: str(r[1]) for r in rows}


def sync() -> None:
    """Cold Start 또는 DB 재연결 시 meta 표의 토큰 전체를 1회 조회해 동기화한다(스펙 2026-10-25-001 R3·D3)."""
    if not enabled():
        return
    global _initialized
    try:
        table = _read()
    except Exception:
        return
    with _lock:
        if not _initialized:
            _seen.update(table)
            _dirty.clear()
            _initialized = True
        else:
            for prefix, remote in table.items():
                if _seen.get(prefix) != remote:
                    _dirty.add(prefix)
                    _seen[prefix] = remote


def on_notify(payload: str) -> None:
    """캐시 무효화 알림 수신. 내가 보낸 알림만 건너뛴다 — 시각으로 가리면 바로 뒤 다른 복제본의 알림까지 버렸다(OMAI-1477 검토).
    「|」가 없는 알림은 옛 판 서버가 보낸 접두사 그대로다(다른 복제본으로 본다)."""
    origin, sep, prefix = payload.partition("|")
    if not sep:
        origin, prefix = "", payload
    if origin == ORIGIN:
        return
    with _lock:
        _dirty.add(prefix)


def bump(prefix: str) -> None:
    """이 접두사의 캐시를 버렸다고 알린다. 이 프로세스가 본 토큰도 같이 바꿔 자기 신호로 자기 캐시를 또 버리지 않는다."""
    if not enabled():
        return
    token = uuid.uuid4().hex[:16]
    try:
        with store.connect() as conn:
            conn.execute("INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", (KEY + prefix, token))
            if db.is_pg(conn):
                conn.execute("SELECT pg_notify(?, ?)", (channel(), f"{ORIGIN}|{prefix}"))
    except Exception:
        return
    with _lock:
        _seen[prefix] = token
        _dirty.discard(prefix)


def changed(prefix: str) -> bool:
    """다른 복제본이 이 접두사의 토큰을 바꿨나. 한 번 참을 주면 dirty 플래그를 지운다. DB 조회를 전혀 하지 않는다."""
    if not enabled():
        return False
    if not _initialized:
        sync()
    with _lock:
        if prefix in _dirty:
            _dirty.discard(prefix)
            return True
        return False


def reset_for_test() -> None:
    global _initialized
    with _lock:
        _seen.clear()
        _dirty.clear()
        _initialized = False

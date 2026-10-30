# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""대화를 누가 어떻게 열었나·지금 Claude Code 가 쓰는 중인가(스펙 2026-10-28-001 §3-7 ⑤, 재검토 F8, OMAI-1513).

Hermes 는 이 값을 갖지 않으므로 AAS 가 따로 적는다. 열 때는 이 서버의 대화 번호(session_id)만 알고, Hermes 가 저장한 번호(stored_id)는
첫 제목 이벤트 뒤에 알게 되어 나중에 채운다. 화면 대화 목록은 stored_id 로 찾는다.
쓰는 중 = 마지막 chat_wait·chat_send 뒤 90초. 다른 파드의 브라우저도 이 표로 본다.
"""
from __future__ import annotations

import time

from ..common import store

SCHEMA = """
CREATE TABLE IF NOT EXISTS chat_session_meta (
  pod TEXT NOT NULL, session_id TEXT NOT NULL, stored_id TEXT NOT NULL DEFAULT '', profile TEXT NOT NULL DEFAULT '',
  opened_by TEXT NOT NULL DEFAULT '', opened_via TEXT NOT NULL DEFAULT 'screen', purpose TEXT NOT NULL DEFAULT '',
  active_until REAL NOT NULL DEFAULT 0, created REAL NOT NULL, PRIMARY KEY (pod, session_id));
CREATE INDEX IF NOT EXISTS chat_session_meta_stored ON chat_session_meta (pod, stored_id);
"""

ACTIVE_FOR = 90.0                  # 마지막 기다리기 뒤 이만큼 「쓰는 중」(F8)
TOUCH_EVERY = 50.0                 # chat_wait 는 50초마다 오므로 그보다 자주 쓰지 않는다
KEEP = 30 * 86400
PURPOSES = ("", "skill-test")


def _conn():
    conn = store.connect()
    conn.executescript(SCHEMA)
    return conn


def opened(pod: str, sid: str, stored_id: str, profile: str, by: str, via: str, purpose: str = "", now: float | None = None) -> None:
    now = time.time() if now is None else now
    purpose = purpose if purpose in PURPOSES else ""
    with _conn() as conn:
        conn.execute("DELETE FROM chat_session_meta WHERE created < ?", (now - KEEP,))
        conn.execute("INSERT INTO chat_session_meta (pod, session_id, stored_id, profile, opened_by, opened_via, purpose, active_until, created) "
                     "VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT (pod, session_id) DO UPDATE SET stored_id=excluded.stored_id, "
                     "opened_by=excluded.opened_by, opened_via=excluded.opened_via, purpose=excluded.purpose, active_until=excluded.active_until",
                     (pod, sid, stored_id or "", profile or "", (by or "").lower(), via or "screen", purpose, now + ACTIVE_FOR, now))


def touch(pod: str, sid: str, stored_id: str = "", now: float | None = None) -> bool:
    """쓰는 중으로 늘린다(50초에 한 번 이하). stored_id 를 알게 됐으면 채운다. 쓴 줄이 있으면 True."""
    now = time.time() if now is None else now
    with _conn() as conn:
        n = conn.execute("UPDATE chat_session_meta SET active_until=? WHERE pod=? AND session_id=? AND active_until < ?",
                         (now + ACTIVE_FOR, pod, sid, now + ACTIVE_FOR - TOUCH_EVERY)).rowcount
        if stored_id:
            n += conn.execute("UPDATE chat_session_meta SET stored_id=? WHERE pod=? AND session_id=? AND stored_id=''",
                              (stored_id, pod, sid)).rowcount
    return bool(n)


def lookup(pod: str, sid: str) -> dict | None:
    """이 서버 메모리에서 대화가 사라졌을 때(파드가 바뀜) 다시 열 번호를 찾는다: {stored_id, profile}. 모르면 None."""
    with _conn() as conn:
        r = conn.execute("SELECT stored_id, profile FROM chat_session_meta WHERE pod=? AND session_id=?", (pod, sid)).fetchone()
    return {"stored_id": r["stored_id"], "profile": r["profile"]} if r and r["stored_id"] else None


def for_stored(pod: str, stored_ids: list[str], now: float | None = None) -> dict[str, dict]:
    """화면 대화 목록용: {stored_id: {via, purpose, active}}. 같은 대화를 여러 번 열었으면 가장 최근 것."""
    now = time.time() if now is None else now
    ids = [i for i in stored_ids if i]
    if not ids:
        return {}
    out: dict[str, dict] = {}
    with _conn() as conn:
        for i in range(0, len(ids), 200):
            part = ids[i:i + 200]
            rows = conn.execute(f"SELECT * FROM chat_session_meta WHERE pod=? AND stored_id IN ({','.join('?' * len(part))}) ORDER BY created",
                                (pod, *part)).fetchall()
            for r in rows:
                out[r["stored_id"]] = {"via": r["opened_via"], "purpose": r["purpose"], "active": float(r["active_until"]) > now}
    return out

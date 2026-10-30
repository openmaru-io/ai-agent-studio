# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""MCP 연결의 공유 상태 — 사람당 호출 수·동시 대기 수와 세션 번호 서명 키(스펙 2026-10-28-001 재검토 D3·D7, OMAI-1513).

파드 여러 개가 같은 사람의 요청을 나눠 받으므로(D4) 사람당 한도는 DB 에서 센다. 파드마다의 스레드 보호(동시 대기 32)는 mcp_server 가 메모리로 센다.
"""
from __future__ import annotations

import hashlib
import hmac
import secrets
import time

from ..common import config, store

SCHEMA = """
CREATE TABLE IF NOT EXISTS mcp_rate (user_email TEXT NOT NULL, minute INTEGER NOT NULL, n INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_email, minute));
CREATE TABLE IF NOT EXISTS mcp_waits (id TEXT PRIMARY KEY, user_email TEXT NOT NULL, until REAL NOT NULL);
CREATE INDEX IF NOT EXISTS mcp_waits_email ON mcp_waits (user_email);
"""

WAIT_HOLD = 70.0                     # 대기 한 줄의 유효 시간. chat_wait 최대 50초보다 길게 — 파드가 죽어 지우지 못한 줄은 이 뒤 저절로 빠진다
_key_memo: bytes | None = None


def _int(name: str, default: int) -> int:
    try:
        return max(1, int(config.get(name, str(default)) or default))
    except ValueError:
        return default


def per_minute() -> int:
    return _int("AAS_MCP_CALLS_PER_MIN", 300)


def waits_per_user() -> int:
    return _int("AAS_MCP_WAITS_PER_USER", 3)


def _conn():
    conn = store.connect()
    conn.executescript(SCHEMA)
    return conn


def hit(email: str, now: float | None = None) -> int:
    """이번 분의 호출을 하나 세고 센 뒤의 수를 돌려준다. 지난 분의 줄은 지운다."""
    now = time.time() if now is None else now
    minute = int(now // 60)
    with _conn() as conn:
        conn.execute("INSERT INTO mcp_rate (user_email, minute, n) VALUES (?, ?, 1) "
                     "ON CONFLICT (user_email, minute) DO UPDATE SET n = mcp_rate.n + 1", (email, minute))
        n = conn.execute("SELECT n FROM mcp_rate WHERE user_email=? AND minute=?", (email, minute)).fetchone()["n"]
        conn.execute("DELETE FROM mcp_rate WHERE minute < ?", (minute - 1,))
    return int(n)


def wait_begin(email: str, now: float | None = None) -> str | None:
    """동시 대기 한 자리를 잡는다. 한도를 넘으면 None(잡은 자리는 바로 돌려놓는다)."""
    now = time.time() if now is None else now
    wid = secrets.token_hex(8)
    with _conn() as conn:
        conn.execute("DELETE FROM mcp_waits WHERE until < ?", (now,))
        conn.execute("INSERT INTO mcp_waits (id, user_email, until) VALUES (?, ?, ?)", (wid, email, now + WAIT_HOLD))
        n = conn.execute("SELECT COUNT(*) AS n FROM mcp_waits WHERE user_email=? AND until >= ?", (email, now)).fetchone()["n"]
        if int(n) > waits_per_user():                 # 먼저 넣고 센다 — 두 파드가 동시에 세도 한도를 넘지 않는다
            conn.execute("DELETE FROM mcp_waits WHERE id=?", (wid,))
            return None
    return wid


def wait_end(wid: str) -> None:
    with _conn() as conn:
        conn.execute("DELETE FROM mcp_waits WHERE id=?", (wid,))


def _key() -> bytes:
    """세션 번호 서명 키. 파드들이 같은 DB 의 meta 에서 함께 쓴다(오피스 사람 키와 같은 방식)."""
    global _key_memo
    if _key_memo is None:
        with store.connect() as conn:
            row = conn.execute("SELECT value FROM meta WHERE key='mcp_session_key'").fetchone()
            if not row:
                conn.execute("INSERT INTO meta (key, value) VALUES ('mcp_session_key', ?) ON CONFLICT (key) DO NOTHING",
                             (secrets.token_hex(32),))
                row = conn.execute("SELECT value FROM meta WHERE key='mcp_session_key'").fetchone()
            _key_memo = bytes.fromhex(row["value"])
    return _key_memo


def _sig(body: str) -> str:
    return hmac.new(_key(), b"aas-mcp-session-v1:" + body.encode(), hashlib.sha256).hexdigest()[:32]


def session_id(family: str, now: float | None = None) -> str:
    """연결(family)에 묶인 Mcp-Session-Id. DB 에 두지 않고 서명으로 확인한다(D7)."""
    body = f"{family}.{int(time.time() if now is None else now)}"
    return f"{body}.{_sig(body)}"


def session_family(value: str) -> str | None:
    """서명이 맞으면 family, 아니면 None."""
    parts = (value or "").split(".")
    if len(parts) != 3 or not parts[0] or not parts[1].isdigit():
        return None
    body = f"{parts[0]}.{parts[1]}"
    return parts[0] if hmac.compare_digest(parts[2], _sig(body)) else None

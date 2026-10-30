# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""MCP 1회용 전송 주소(스펙 2026-10-28-001 D3·F7, OMAI-1513).

파일·스킬 묶음·비밀값·인증 파일은 도구 인자가 아니라 이 주소로 curl 이 직접 올리고 받는다 — 값이 모델을 거치지 않는다.
키는 10분, 한 번, 만든 연결(family)에 묶인다. DB 에는 키의 sha256 만 둔다. 어느 파드가 받아도 되게 DB 에 둔다(S4).
올리기·파일 받기는 본문을 두지 않고 쓸 때 지금 화면 API 로 흘려보낸다. 긴 답(answer)만 글을 함께 둔다.
"""
from __future__ import annotations

import hashlib
import json
import secrets
import time

from ..common import store

SCHEMA = """
CREATE TABLE IF NOT EXISTS mcp_transfers (
  key_hash TEXT PRIMARY KEY, token_id TEXT NOT NULL, family TEXT NOT NULL, user_email TEXT NOT NULL,
  kind TEXT NOT NULL, direction TEXT NOT NULL, pod TEXT NOT NULL, params TEXT NOT NULL, body TEXT NOT NULL DEFAULT '',
  created REAL NOT NULL, expires REAL NOT NULL, used REAL NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS mcp_transfers_expires ON mcp_transfers (expires);
"""

TTL = 600.0
ANSWER_MAX = 2 * 1024 * 1024                       # 긴 답 글을 두는 한도(바이트)
UP = {"file", "skill", "env", "credential", "channel"}   # channel: 메신저 봇 토큰(M2 ④, 값은 env 와 같이 다룬다)
DOWN = {"file", "skill", "answer"}


def _conn():
    conn = store.connect()
    conn.executescript(SCHEMA)
    return conn


def _hash(key: str) -> str:
    return hashlib.sha256(key.encode()).hexdigest()


def create(row: dict, kind: str, direction: str, pod: str, params: dict, body: str = "", now: float | None = None) -> str:
    """키를 만든다. row 는 만든 토큰 줄(personal_tokens). 원문 키는 이때만 돌려준다."""
    if (direction == "up" and kind not in UP) or (direction == "down" and kind not in DOWN) or direction not in ("up", "down"):
        raise ValueError("unknown transfer")
    now = time.time() if now is None else now
    key = secrets.token_urlsafe(24)
    with _conn() as conn:
        conn.execute("DELETE FROM mcp_transfers WHERE expires < ?", (now - TTL,))
        conn.execute("INSERT INTO mcp_transfers (key_hash, token_id, family, user_email, kind, direction, pod, params, body, created, expires) "
                     "VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                     (_hash(key), row["id"], row["family"], row["user_email"], kind, direction, pod,
                      json.dumps(params, ensure_ascii=False), body.encode()[:ANSWER_MAX].decode("utf-8", "ignore"), now, now + TTL))
    return key


def take(key: str, direction: str, now: float | None = None) -> tuple[str, dict | None]:
    """키를 쓴다(한 번만). ('ok'|'unknown'|'used'|'expired', 줄). 'ok' 면 이미 쓴 것으로 표시했다.
    방향(올리기·받기)이 다른 요청은 키를 쓰지 않고 'unknown' — 잘못 부른 curl 이 키를 태우지 않게."""
    now = time.time() if now is None else now
    if not key or len(key) > 100:
        return "unknown", None
    h = _hash(key)
    with _conn() as conn:
        r = conn.execute("SELECT * FROM mcp_transfers WHERE key_hash=?", (h,)).fetchone()
        if r is None:
            return "unknown", None
        d = dict(r)
        if d["direction"] != direction:
            return "unknown", None
        if d["used"]:
            return "used", d
        if d["expires"] < now:
            return "expired", d
        # 두 요청이 같은 키를 동시에 써도 하나만 통과한다
        if conn.execute("UPDATE mcp_transfers SET used=? WHERE key_hash=? AND used=0", (now, h)).rowcount != 1:
            return "used", d
    d["params"] = json.loads(d["params"] or "{}")
    return "ok", d


def family_active(family: str, now: float | None = None) -> dict | None:
    """그 연결의 살아 있는 토큰 줄(아무거나 하나). 끊었거나 만료면 None — 만든 뒤 폐기한 연결의 키는 쓸 수 없다."""
    now = time.time() if now is None else now
    from . import tokens
    with tokens._conn() as conn:
        r = conn.execute("SELECT * FROM personal_tokens WHERE family=? AND revoked=0 AND expires>=? ORDER BY created DESC",
                         (family, now)).fetchone()
    return dict(r) if r else None

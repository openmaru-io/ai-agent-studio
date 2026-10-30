# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""승인·되묻기에 누가 먼저 답했나(스펙 2026-10-28-001 §3-7 ④, 재검토 F4, OMAI-1513).

Claude Code(토큰)와 사람(채팅·받은편지함)이 같은 카드에 답할 수 있다. 먼저 적은 쪽이 이기고, 늦은 쪽은 「이미 …가 답했습니다」를 받는다.
서버가 여럿이어도 같은 DB 의 기본 키로 가린다. 답을 보내다 실패하면 적은 줄을 지워 다시 답할 수 있게 한다.
"""
from __future__ import annotations

import time

from ..common import store

SCHEMA = """
CREATE TABLE IF NOT EXISTS approval_answers (
  answer_key TEXT PRIMARY KEY, pod TEXT NOT NULL, session_id TEXT NOT NULL, kind TEXT NOT NULL,
  choice TEXT NOT NULL DEFAULT '', by_email TEXT NOT NULL DEFAULT '', via TEXT NOT NULL DEFAULT 'screen', ts REAL NOT NULL);
"""

KEEP = 30 * 86400


def _conn():
    conn = store.connect()
    conn.executescript(SCHEMA)
    return conn


def key(pod: str, request_id: str, question_id: str | None = None) -> str:
    """같은 요청 번호가 다른 에이전트에서 겹치지 않게 pod 를 붙인다. 여러 질문 카드는 질문마다 따로."""
    return f"{pod}:{request_id}" + (f":{question_id}" if question_id else "")


def claim(answer_key: str, pod: str, sid: str, kind: str, choice: str, by: str, via: str, now: float | None = None) -> dict | None:
    """먼저 답한 쪽으로 적는다. 이겼으면 None, 이미 누가 답했으면 그 줄."""
    now = time.time() if now is None else now
    with _conn() as conn:
        conn.execute("DELETE FROM approval_answers WHERE ts < ?", (now - KEEP,))
        n = conn.execute("INSERT INTO approval_answers (answer_key, pod, session_id, kind, choice, by_email, via, ts) "
                         "VALUES (?,?,?,?,?,?,?,?) ON CONFLICT (answer_key) DO NOTHING",
                         (answer_key, pod, sid, kind, choice[:40], (by or "").lower(), via or "screen", now)).rowcount
        if n == 1:
            return None
        r = conn.execute("SELECT * FROM approval_answers WHERE answer_key=?", (answer_key,)).fetchone()
    return dict(r) if r else None


def release(answer_key: str) -> None:
    """답을 보내지 못했다 — 다시 답할 수 있게 지운다."""
    with _conn() as conn:
        conn.execute("DELETE FROM approval_answers WHERE answer_key=?", (answer_key,))


def get(answer_key: str) -> dict | None:
    with _conn() as conn:
        r = conn.execute("SELECT * FROM approval_answers WHERE answer_key=?", (answer_key,)).fetchone()
    return dict(r) if r else None

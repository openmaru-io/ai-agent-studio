# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""세션 칸에서 닫은 대화의 Hermes 저장 번호(stored_id)(스펙 2026-11-06-002 D2·E1~E4, OMAI-1851).

닫기는 이 서버 메모리의 세션에 숨김 표시만 했다. 세션이 정리되거나 서버가 다시 시작되면 표시가 사라져, 닫은 대화가 세션 칸의
「완료」(Hermes 저장 세션)에 다시 나왔다. 저장 번호를 이 표에 남겨 완료 묶음만 거른다 — 「지난 대화」 서랍에는 그대로 보이고,
거기서 다시 열면 행을 지운다(E3). 로그인이 꺼진 설치는 email '' 로 함께 쓴다. 90일 지난 행은 쓸 때 지운다(E4).
"""
from __future__ import annotations

import time

from ..common import store

SCHEMA = """
CREATE TABLE IF NOT EXISTS chat_hidden (
  email TEXT NOT NULL, pod TEXT NOT NULL, stored_id TEXT NOT NULL, at REAL NOT NULL,
  PRIMARY KEY (email, pod, stored_id));
"""

KEEP = 90 * 86400


def _conn():
    conn = store.connect()
    conn.executescript(SCHEMA)
    return conn


def hide(email: str, pod: str, stored_ids, now: float | None = None) -> int:
    """닫은 대화의 저장 번호를 남긴다. 이미 있으면 그대로. 남긴 수."""
    now = time.time() if now is None else now
    ids = sorted({str(i) for i in stored_ids or () if i})
    with _conn() as conn:
        conn.execute("DELETE FROM chat_hidden WHERE at < ?", (now - KEEP,))
        n = 0
        for sid in ids:
            n += conn.execute("INSERT INTO chat_hidden (email, pod, stored_id, at) VALUES (?,?,?,?) ON CONFLICT (email, pod, stored_id) DO NOTHING",
                              ((email or "").lower(), pod, sid, now)).rowcount
    return n


def unhide(email: str, pod: str, stored_id: str) -> None:
    """다시 연 대화는 숨김을 푼다(E3)."""
    if not stored_id:
        return
    with _conn() as conn:
        conn.execute("DELETE FROM chat_hidden WHERE email=? AND pod=? AND stored_id=?", ((email or "").lower(), pod, stored_id))


def stored_ids(email: str, pods, now: float | None = None) -> dict[str, set[str]]:
    """{pod: 닫은 저장 번호}. 90일 지난 행은 넣지 않는다."""
    now = time.time() if now is None else now
    pods = [p for p in pods or () if p]
    out: dict[str, set[str]] = {p: set() for p in pods}
    if not pods:
        return out
    with _conn() as conn:
        rows = conn.execute(f"SELECT pod, stored_id FROM chat_hidden WHERE email=? AND at >= ? AND pod IN ({','.join('?' * len(pods))})",
                            ((email or "").lower(), now - KEEP, *pods)).fetchall()
    for r in rows:
        out[r["pod"]].add(r["stored_id"])
    return out

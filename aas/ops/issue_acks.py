# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""프로파일 「확인할 것」의 주의·안내를 사람이 확인해 뺀다(사용자 지시 2026-10-30, 스펙 2026-10-24-003 §12·§13).

  대상    level 이 warn(주의)·info(안내)인 항목. bad(문제)는 고쳐야 사라지는 장애 신호라 뺄 수 없다.
  열쇠    (pod, profile, 지문). 지문은 항목의 code 와 값(n·package·version 등)이라 값이 바뀌면(스킬 4개 → 5개) 다시 나타난다.
          code 가 없는 옛 항목은 문장으로 지문을 만든다 — 화면 언어를 바꾸면 다시 보일 수 있다.
  범위    프로파일마다 하나다. 한 사람이 확인하면 그 프로파일을 보는 모두에게 빠진다(누가 언제 했는지는 by·ts 와 사용 기록).
"""
from __future__ import annotations

import hashlib
import json
from datetime import datetime

from ..common import db, store, table_cache

SCHEMA = """
CREATE TABLE IF NOT EXISTS issue_acks (
  pod TEXT NOT NULL, profile TEXT NOT NULL, sig TEXT NOT NULL, by TEXT, ts TEXT, PRIMARY KEY (pod, profile, sig));
"""
LEVELS = ("warn", "info")
_SKIP = ("text", "to", "ack", "sig", "from")


def _conn():
    conn = store.connect()
    conn.executescript(SCHEMA)
    return conn


def sig(issue: dict) -> str:
    """항목의 지문. 문장·링크·화면 표시값은 빼고 code 와 값으로 만든다(code 가 없으면 문장)."""
    key = {k: v for k, v in issue.items() if k not in _SKIP}
    if not issue.get("code"):
        key["text"] = issue.get("text", "")
    return hashlib.sha1(json.dumps(key, sort_keys=True, ensure_ascii=False, default=str).encode()).hexdigest()[:16]


def _read() -> set[tuple[str, str, str]]:
    with _conn() as conn:
        return {(r["pod"], r["profile"], r["sig"]) for r in conn.execute("SELECT pod, profile, sig FROM issue_acks")}


def acked() -> set[tuple[str, str, str]]:
    # 프로파일 응답마다 부른다 — 표 바뀜 알림으로 버리는 캐시(mutes 와 같이)
    return store.memo("issue_acks", lambda: table_cache.get("issue_acks", ("issue_acks",), _read, set))


MAX_PER_CALL = 100


def _valid(signature: str) -> bool:
    return len(signature) == 16 and all(c in "0123456789abcdef" for c in signature)


def ack(pod: str, profile: str, signature: str | list[str], by: str) -> int:
    """지문 하나 또는 여럿(「모두 확인」)을 한 번에 적는다. 하나라도 잘못되면 아무것도 적지 않는다. 적은 수를 돌려준다."""
    sigs = [signature] if isinstance(signature, str) else list(dict.fromkeys(signature))
    if not profile or not sigs or len(sigs) > MAX_PER_CALL or not all(isinstance(s, str) and _valid(s) for s in sigs):
        raise ValueError("bad request")
    ts = datetime.now().astimezone().isoformat(timespec="seconds")
    with _conn() as conn:
        for s in sigs:
            conn.execute(db.upsert("issue_acks", ("pod", "profile", "sig", "by", "ts"), ("pod", "profile", "sig")), (pod, profile, s, by, ts))
    return len(sigs)


def apply(pod: str, rows: list[dict], can_ack: bool) -> list[dict]:
    """확인한 항목을 빼고, 확인할 수 있는 사람의 응답에는 주의·안내 항목에 ack·sig 를 단다. 받은 줄은 고치지 않고 복사한다."""
    done = acked()
    out = []
    for r in rows:
        issues = r.get("issues") or []
        if not issues:
            out.append(r)
            continue
        kept = []
        for i in issues:
            if i.get("level") not in LEVELS:
                kept.append(i)
                continue
            s = sig(i)
            if (pod, r.get("name", ""), s) in done:
                continue
            kept.append({**i, "ack": True, "sig": s} if can_ack else {k: v for k, v in i.items() if k != "ack"})
        out.append({**r, "issues": kept})
    return out

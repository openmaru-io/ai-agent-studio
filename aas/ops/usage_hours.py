# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""스킬·도구 사용 집계를 AAS DB 에 시간 칸으로 쌓는 표 셋(스펙 2026-11-19-005 U1).

Hermes 세션 기록을 매번 90일씩 다시 읽지 않고, 끝난 시간 칸은 여기 두고 커서 뒤의 새 기록만 읽는다. 이 모듈은 표를 읽고 쓰기만 하고,
세션 기록을 읽어 세는 일은 `observed` 가 한다. 표는 `observed` 를 거쳐서만 쓴다(두 길 금지, 스펙 엔지니어링 리뷰).

- skill_usage_hours: (pod, profile, hour, kind, name, job) 마다 횟수 n. hour 는 UTC 시 단위 epoch, kind 는 skill·tool·script·mcp,
  job 은 크론 작업 id(크론이 아니면 빈 값 — 흐름 겹쳐 보기의 크론 줄이 쓴다).
- skill_usage_sessions: 도구 호출이 있던 세션. 실행 수(runs)는 「기간 안에 메시지가 있던 세션」이라 last_at 으로 센다.
- skill_usage_cursor: 마지막으로 읽은 메시지 시각, 처음 채우기를 시작한 시각, 아직 못 읽은 구간(「모름」), 읽기 임대.
"""
from __future__ import annotations

import json
import time

from ..common import db, store

HOUR = 3600
SKILL_DAYS = 90                    # skill 칸과 세션을 두는 기간
OTHER_DAYS = 14                    # tool·script·mcp 칸은 14일 집계에만 쓴다(엔지니어링 리뷰 M3)
LEASE_SECONDS = 120.0
_CHUNK = 200                       # 한 문장에 넣는 행 수(SQLite 자리표 상한 안)

_HOUR_COLS = ("pod", "profile", "hour", "kind", "name", "job", "n")
_HOUR_KEYS = ("pod", "profile", "hour", "kind", "name", "job")


def acquire(pod: str, profile: str, owner: str, now: float | None = None, ttl: float = LEASE_SECONDS) -> bool:
    """(pod, profile) 읽기 임대를 잡는다. 다른 서버 복제본이 쥐고 있고 아직 만료 전이면 False. 같은 owner 가 다시 잡으면 늘린다.
    restart_lock 과 같은 조건부 upsert 라 SQLite·PostgreSQL 에서 한 문장으로 끝난다(엔지니어링 리뷰 H4)."""
    at = time.time() if now is None else now
    with store.connect() as conn:
        conn.execute("INSERT INTO skill_usage_cursor (pod, profile, lease_until, lease_owner) VALUES (?,?,?,?) "
                     "ON CONFLICT (pod, profile) DO UPDATE SET lease_until=excluded.lease_until, lease_owner=excluded.lease_owner "
                     "WHERE skill_usage_cursor.lease_until < ? OR skill_usage_cursor.lease_owner = ?",
                     (pod, profile, at + ttl, owner, at, owner))
        row = conn.execute("SELECT lease_owner FROM skill_usage_cursor WHERE pod=? AND profile=?", (pod, profile)).fetchone()
    return row is not None and row["lease_owner"] == owner


def release(pod: str, profile: str, owner: str) -> None:
    with store.connect() as conn:
        conn.execute("UPDATE skill_usage_cursor SET lease_until=0, lease_owner='' WHERE pod=? AND profile=? AND lease_owner=?",
                     (pod, profile, owner))


def cursor(pod: str, profile: str) -> dict | None:
    with store.connect() as conn:
        row = conn.execute("SELECT ts, filled_from, unknown FROM skill_usage_cursor WHERE pod=? AND profile=?",
                           (pod, profile)).fetchone()
    if row is None or row["ts"] is None:
        return None
    return {"ts": float(row["ts"]), "filled_from": float(row["filled_from"]) if row["filled_from"] is not None else None,
            "unknown": _unknown(row["unknown"])}


def cursors(pod: str) -> dict[str, dict]:
    """POD 의 프로파일별 커서(채운 적 있는 것만)."""
    with store.connect() as conn:
        rows = conn.execute("SELECT profile, ts, filled_from, unknown FROM skill_usage_cursor WHERE pod=? AND ts IS NOT NULL",
                            (pod,)).fetchall()
    return {r["profile"]: {"ts": float(r["ts"]), "filled_from": float(r["filled_from"]) if r["filled_from"] is not None else None,
                           "unknown": _unknown(r["unknown"])} for r in rows}


def save(pod: str, profile: str, owner: str, *, spans: list[tuple[int, int]], hours: dict, sessions: list[dict],
         ts: float, unknown: list, filled_from: float | None = None) -> bool:
    """끝까지 다시 읽은 시 구간들(spans, 양끝 포함)의 칸을 통째로 바꾸고 세션·커서를 고친다. 못 읽은 구간의 칸은 그대로 둔다. 한 트랜잭션이고, 임대를 쥔 owner 만 쓴다
    (쥐지 않았으면 아무것도 바꾸지 않고 False). hours 는 {(hour, kind, name, job): n}, sessions 는 {session_id, started_at, last_at, job}.
    커서는 앞으로만 간다(MAX). 세션의 last_at 도 줄지 않는다."""
    with store.connect() as conn:
        held = conn.execute("UPDATE skill_usage_cursor SET lease_owner=lease_owner WHERE pod=? AND profile=? AND lease_owner=?",
                            (pod, profile, owner)).rowcount
        if not held:
            return False
        for lo, hi in spans:
            conn.execute("DELETE FROM skill_usage_hours WHERE pod=? AND profile=? AND hour >= ? AND hour <= ?",
                         (pod, profile, lo, hi))
        rows = [(pod, profile, h, k, name, job, n) for (h, k, name, job), n in hours.items()
                if n and any(lo <= h <= hi for lo, hi in spans)]
        for i in range(0, len(rows), _CHUNK):
            part = rows[i:i + _CHUNK]
            conn.execute(db.upsert_many("skill_usage_hours", _HOUR_COLS, _HOUR_KEYS, len(part)),
                         [v for r in part for v in r])
        for s in sessions:
            conn.execute("INSERT INTO skill_usage_sessions (pod, profile, session_id, started_at, last_at, job) VALUES (?,?,?,?,?,?) "
                         "ON CONFLICT (pod, profile, session_id) DO UPDATE SET "
                         "last_at = CASE WHEN excluded.last_at > skill_usage_sessions.last_at THEN excluded.last_at "
                         "ELSE skill_usage_sessions.last_at END, job = excluded.job",
                         (pod, profile, str(s["session_id"]), s.get("started_at"), float(s["last_at"]), s.get("job") or ""))
        conn.execute("UPDATE skill_usage_cursor SET ts = CASE WHEN ts IS NULL OR ts < ? THEN ? ELSE ts END, unknown = ?, "
                     "filled_from = COALESCE(filled_from, ?) WHERE pod=? AND profile=?",
                     (ts, ts, json.dumps(unknown), filled_from if filled_from is not None else ts, pod, profile))
    return True


def prune(pod: str, now: float | None = None) -> None:
    """90일 지난 skill 칸·세션, 14일 지난 tool·script·mcp 칸을 지운다."""
    at = time.time() if now is None else now
    with store.connect() as conn:
        conn.execute("DELETE FROM skill_usage_hours WHERE pod=? AND kind='skill' AND hour < ?", (pod, int(at - SKILL_DAYS * 86400) // HOUR))
        conn.execute("DELETE FROM skill_usage_hours WHERE pod=? AND kind<>'skill' AND hour < ?", (pod, int(at - OTHER_DAYS * 86400) // HOUR))
        conn.execute("DELETE FROM skill_usage_sessions WHERE pod=? AND last_at < ?", (pod, at - SKILL_DAYS * 86400))


def delete_profile(pod: str, profile: str) -> None:
    with store.connect() as conn:
        for table in ("skill_usage_hours", "skill_usage_sessions", "skill_usage_cursor"):
            conn.execute(f"DELETE FROM {table} WHERE pod=? AND profile=?", (pod, profile))


def rename_profile(pod: str, old: str, new: str) -> None:
    """프로파일 이름을 바꾸면 쌓인 칸도 새 이름으로 옮긴다. 안 옮기면 새 이름은 90일을 다시 채운다(엔지니어링 리뷰 M2).
    새 이름에 이미 행이 있으면(같은 이름을 지웠다 다시 만든 경우) 그 행을 먼저 지운다."""
    with store.connect() as conn:
        for table in ("skill_usage_hours", "skill_usage_sessions", "skill_usage_cursor"):
            conn.execute(f"DELETE FROM {table} WHERE pod=? AND profile=?", (pod, new))
            conn.execute(f"UPDATE {table} SET profile=? WHERE pod=? AND profile=?", (new, pod, old))


def hours(pod: str, since_hour: int, kinds: tuple[str, ...] | None = None) -> list[dict]:
    """since_hour 부터의 칸. 프로파일·kind·name·job 별 합으로 돌려준다."""
    sql = ("SELECT profile, kind, name, job, SUM(n) AS n FROM skill_usage_hours WHERE pod=? AND hour >= ?"
           + (f" AND kind IN ({','.join('?' * len(kinds))})" if kinds else "") + " GROUP BY profile, kind, name, job")
    with store.connect() as conn:
        rows = conn.execute(sql, (pod, since_hour, *(kinds or ()))).fetchall()
    return [{"profile": r["profile"], "kind": r["kind"], "name": r["name"], "job": r["job"], "n": int(r["n"])} for r in rows]


def sessions(pod: str, since: float) -> list[dict]:
    """since 뒤에 메시지가 있던 도구 호출 세션."""
    with store.connect() as conn:
        rows = conn.execute("SELECT profile, session_id, started_at, last_at, job FROM skill_usage_sessions WHERE pod=? AND last_at >= ?",
                            (pod, since)).fetchall()
    return [{"profile": r["profile"], "session_id": r["session_id"], "started_at": r["started_at"], "last_at": float(r["last_at"]),
             "job": r["job"]} for r in rows]


def _unknown(raw) -> list:
    try:
        value = json.loads(raw or "[]")
    except ValueError:
        return []
    return [[float(a), float(b)] for a, b in value] if isinstance(value, list) else []

# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""채팅 기본 프로파일 — 에이전트마다 채팅이 먼저 여는 프로파일(스펙 2026-10-19-001 R3, 리뷰 D6·D7).

- AAS 기록만 바꾼다. Hermes 의 활성 프로파일과 주 프로파일(primary.primary_of)은 그대로다 — primary_of 는 오피스 자동 자리·복제 원본·
  주인의 main 삭제 막기가 함께 써서, 이 값으로 덮으면 그 기능들이 바뀐다(리뷰 발견 4, D12→D13).
- 고른 이름이 프로파일 목록에 없으면(지웠거나 숨긴 루트) 주 프로파일로 돌아간다.
"""
from __future__ import annotations

from datetime import datetime

from ..common import store

SCHEMA = ("CREATE TABLE IF NOT EXISTS pod_default_profile (pod TEXT PRIMARY KEY, profile TEXT NOT NULL, "
          "by TEXT NOT NULL, ts TEXT NOT NULL)")


def _connect():
    conn = store.connect()
    conn.execute(SCHEMA)
    return conn


def stored(pod_id: str) -> str:
    """저장한 이름(없으면 빈 값). 목록과 맞춰 보지 않는다."""
    with _connect() as conn:
        row = conn.execute("SELECT profile FROM pod_default_profile WHERE pod=?", (pod_id,)).fetchone()
    return str(row["profile"]) if row else ""


def records() -> dict[str, str]:
    with _connect() as conn:
        return {r["pod"]: r["profile"] for r in conn.execute("SELECT pod, profile FROM pod_default_profile")}


def resolve(pod_id: str, names: list[str], primary_name: str, known: dict[str, str] | None = None) -> str:
    """채팅이 먼저 열 프로파일: 저장한 이름이 목록에 있으면 그것, 아니면 주 프로파일. 주 프로파일도 목록에 없으면(만드는 중) 목록의 첫 이름."""
    name = (known if known is not None else {pod_id: stored(pod_id)}).get(pod_id, "")
    if name and name in names:
        return name
    return primary_name if primary_name in names or not names else names[0]


def save(pod_id: str, profile: str, by: str) -> None:
    ts = datetime.now().astimezone().isoformat(timespec="seconds")
    with _connect() as conn:
        conn.execute("INSERT INTO pod_default_profile (pod, profile, by, ts) VALUES (?,?,?,?) "
                     "ON CONFLICT (pod) DO UPDATE SET profile=excluded.profile, by=excluded.by, ts=excluded.ts", (pod_id, profile, by, ts))


__all__ = ["SCHEMA", "stored", "records", "resolve", "save"]

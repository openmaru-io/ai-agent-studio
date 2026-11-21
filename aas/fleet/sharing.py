# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""작업공간 공유의 설치 스위치와 작업공간별 공유 정보(스펙 2026-11-17-008 §3-4·§3-6).

  설치 스위치   meta owner_sharing("0" 이면 끔, 기본 켬). 끄면 소유자의 공유 구역이 숨고 workspace_members 는 권한 계산에서 빠진다
                (행은 남긴다). 관리자가 주는 access_grants 는 그대로다. 30초 캐시, 바꾸면 cache_epoch 로 다른 서버도 버린다.
  공유 정보     workspace_share(pod): 처음 공유한 시각(since), 그 전 대화를 구성원에게 숨길 기준 시각(hide_before, 비면 숨기지 않음),
                구성원에게 보일 안내 한 줄(note).
구성원 표(workspace_members)는 pods.Registry 가 읽고 쓴다."""
from __future__ import annotations

import threading
import time
from datetime import datetime

from ..common import db, store

SHARE_SCHEMA = ("CREATE TABLE IF NOT EXISTS workspace_share (pod TEXT PRIMARY KEY, note TEXT NOT NULL DEFAULT '', "
                "since TEXT NOT NULL DEFAULT '', hide_before TEXT NOT NULL DEFAULT '', by TEXT, ts TEXT NOT NULL)")
NOTE_MAX = 200
ENABLED_KEY = "owner_sharing"
ENABLED_EPOCH = "settings:owner_sharing"
ENABLED_TTL = 30.0

_lock = threading.Lock()
_cache: dict = {}


def _now() -> str:
    return datetime.now().astimezone().isoformat(timespec="seconds")


def enabled() -> bool:
    """소유자가 공유할 수 있는 설치인가(기본 켬)."""
    from ..common import cache_epoch
    key = store.data_dir().as_posix()
    with _lock:
        if cache_epoch.changed(ENABLED_EPOCH):
            _cache.clear()
        hit = _cache.get(key)
        if hit is not None and time.monotonic() - hit[0] < ENABLED_TTL:
            return hit[1]
    try:
        with store.connect() as conn:
            row = conn.execute("SELECT value FROM meta WHERE key=?", (ENABLED_KEY,)).fetchone()
        value = not (row is not None and str(row["value"] or "") == "0")
    except Exception:                       # 읽지 못하면 켠 것으로 본다 — 구성원 권한은 표가 비면 어차피 없다
        value = True
    with _lock:
        _cache[key] = (time.monotonic(), value)
    return value


def set_enabled(on: bool, who: str = "local") -> bool:
    from ..common import cache_epoch
    with store.connect() as conn:
        conn.execute("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value=excluded.value",
                     (ENABLED_KEY, "1" if on else "0"))
        conn.execute("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value=excluded.value",
                     (ENABLED_KEY + "_by", str(who or "local")))
    with _lock:
        _cache.clear()
    cache_epoch.bump(ENABLED_EPOCH)
    return bool(on)


def info(pod_id: str) -> dict:
    """{note, since, hide_before}. 공유한 적이 없으면 빈 값."""
    with store.connect() as conn:
        conn.execute(SHARE_SCHEMA)
        row = conn.execute("SELECT note, since, hide_before FROM workspace_share WHERE pod=?", (pod_id,)).fetchone()
    return {"note": row["note"], "since": row["since"], "hide_before": row["hide_before"]} if row else {"note": "", "since": "", "hide_before": ""}


def _upsert(pod_id: str, note: str, since: str, hide_before: str, who: str) -> None:
    with store.connect() as conn:
        conn.execute(SHARE_SCHEMA)
        conn.execute(db.upsert("workspace_share", ("pod", "note", "since", "hide_before", "by", "ts"), ("pod",)),
                     (pod_id, note, since, hide_before, who, _now()))


def start(pod_id: str, hide_before: bool, who: str) -> dict:
    """처음 공유할 때 한 번. 이미 공유한 적이 있으면 그대로 둔다(숨김 기준은 처음 고른 값)."""
    cur = info(pod_id)
    if cur["since"]:
        return cur
    since = _now()
    _upsert(pod_id, cur["note"], since, since if hide_before else "", who)
    return info(pod_id)


def set_note(pod_id: str, note: str, who: str) -> str:
    note = " ".join(str(note or "").split())
    if len(note) > NOTE_MAX:
        raise ValueError(NOTE_MAX)
    cur = info(pod_id)
    _upsert(pod_id, note, cur["since"], cur["hide_before"], who)
    return note


def hide_before_epoch(pod_id: str) -> float:
    """구성원에게 숨길 대화의 기준(유닉스 초). 숨기지 않으면 0."""
    raw = info(pod_id)["hide_before"]
    if not raw:
        return 0.0
    try:
        return datetime.fromisoformat(raw).timestamp()
    except ValueError:
        return 0.0


TEAM_SCHEMA = "CREATE TABLE IF NOT EXISTS workspace_team_notice (pod TEXT PRIMARY KEY, profile TEXT NOT NULL, platform TEXT NOT NULL, by TEXT, ts TEXT NOT NULL)"


def team_notice(pod_id: str) -> dict | None:
    """팀 공지 대화방(스펙 2026-11-17-008 §6-4): 실패한 예약 작업을 그 (프로파일, 메신저)의 홈 채널로도 보낸다. 없으면 None."""
    with store.connect() as conn:
        conn.execute(TEAM_SCHEMA)
        row = conn.execute("SELECT profile, platform FROM workspace_team_notice WHERE pod=?", (pod_id,)).fetchone()
    return {"profile": row["profile"], "platform": row["platform"]} if row else None


def set_team_notice(pod_id: str, profile: str, platform: str, who: str) -> dict | None:
    """profile 이 비면 끈다."""
    with store.connect() as conn:
        conn.execute(TEAM_SCHEMA)
        if not profile:
            conn.execute("DELETE FROM workspace_team_notice WHERE pod=?", (pod_id,))
            return None
        conn.execute(db.upsert("workspace_team_notice", ("pod", "profile", "platform", "by", "ts"), ("pod",)), (pod_id, profile, platform, who, _now()))
    return team_notice(pod_id)

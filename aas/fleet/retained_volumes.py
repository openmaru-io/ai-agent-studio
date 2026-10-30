# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""지운 에이전트의 남은 데이터 볼륨 알림(OMAI-1291).

에이전트를 지워도 StatefulSet 이 만든 PVC(data-<에이전트>-0)는 남는다 — 되살리기·자료 회수를 위해 일부러 남긴다.
남은 볼륨이 정해진 기간(AAS_RETAINED_VOLUME_NOTICE_DAYS, 기본 30일, 0 이면 끔)을 넘기면 관리자 받은편지함에 항목 하나로 알린다.

  기록    표 retained_volumes. 서버가 에이전트를 지울 때 지운 시각·옛 주인·내보내기 파일을 남긴다(record_deletion).
          기록이 없는 볼륨(이 기능 전에 지운 것, kubectl 로 지운 것)은 하루 1회 점검이 처음 본 시각을 남긴다.
  점검    scan(PVC 목록, 에이전트 이름들) — 하루 1회 점검(리더)이 부른다. 사라진 볼륨의 행은 지운다.
  항목    받은편지함을 읽을 때 DB 만 보고 만든다(쿠버네티스를 부르지 않는다). id 는 rvol|<알릴 볼륨 이름들의 해시>.
  처리    ack 는 지금 알릴 볼륨들에 처리 시각을 남긴다. 같은 기간이 다시 지나면 한 번 더 알린다.
첫 판은 알림만 한다. 지우기는 운영자가 kubectl 로 한다(서버에 PVC 삭제 권한을 주지 않는다).
"""
from __future__ import annotations

import hashlib
import os
import re
from datetime import datetime

from ..common import config, db, store

SCHEMA = """
CREATE TABLE IF NOT EXISTS retained_volumes (
  pvc TEXT PRIMARY KEY, agent TEXT NOT NULL, owner TEXT NOT NULL DEFAULT '', deleted_by TEXT NOT NULL DEFAULT '',
  deleted_at TEXT NOT NULL DEFAULT '', first_seen TEXT NOT NULL DEFAULT '', export TEXT NOT NULL DEFAULT '',
  size TEXT NOT NULL DEFAULT '', acked_at TEXT NOT NULL DEFAULT '', acked_by TEXT NOT NULL DEFAULT '');
"""
PREFIX = "rvol|"
DEFAULT_DAYS = 30
_NAME = re.compile(r"^data-(.+)-0$")
_MIGRATED: set = set()                 # 열을 더했는가 — (백엔드, 데이터 폴더, 스키마)마다 프로세스에서 한 번


def notice_days() -> int:
    """알림 기간(일). 0 이면 끈다. 숫자가 아니면 기본값."""
    try:
        return max(0, int(config.get("AAS_RETAINED_VOLUME_NOTICE_DAYS", str(DEFAULT_DAYS))))
    except ValueError:
        return DEFAULT_DAYS


def agent_of(pvc_name: str) -> str:
    """data-<에이전트>-0 → 에이전트 이름. 규칙에 맞지 않으면 빈 값(공유 볼륨 등은 대상이 아니다)."""
    m = _NAME.match(pvc_name or "")
    return m.group(1) if m else ""


def _now() -> datetime:
    return datetime.now().astimezone()


def _iso(dt: datetime) -> str:
    return dt.isoformat(timespec="seconds")


def _conn():
    conn = store.connect()
    conn.executescript(SCHEMA)
    key = (db.backend(), os.environ.get("AAS_DATA_DIR", ""), os.environ.get("AAS_DB_SCHEMA", ""))
    if key not in _MIGRATED:
        # 지울 때의 에이전트 이름·주인 이름. 화면이 설치본 id 대신 「주인 · 에이전트 이름」을 보인다(스펙 2026-10-19-003). 그 전에 지운 것은 빈 값.
        # 다른 모듈처럼 처음 한 번·없는 열만 — 연결마다 ALTER 를 보내 표 잠금·WAL 쓰기 COMMIT 을 기다렸다(스펙 2026-10-28-009 R1)
        cols = db.columns(conn, "retained_volumes")
        for col, ddl in (("agent_name", "agent_name TEXT NOT NULL DEFAULT ''"), ("owner_name", "owner_name TEXT NOT NULL DEFAULT ''")):
            if col not in cols:
                db.add_column(conn, "retained_volumes", ddl)
        _MIGRATED.add(key)
    return conn


def record_deletion(agent: str, owner: str, by: str, export: str, now: datetime | None = None, agent_name: str = "", owner_name: str = "") -> None:
    """서버가 에이전트를 지울 때 부른다. 같은 이름을 다시 지우면 새 값으로 바꾸고 처리 표시를 지운다.
    agent_name·owner_name: 지운 뒤에는 등록부에 없어 이름을 찾을 수 없으므로 지울 때 함께 적는다(스펙 2026-10-19-003)."""
    at = _iso(now or _now())
    with _conn() as conn:
        conn.execute("INSERT INTO retained_volumes (pvc, agent, owner, deleted_by, deleted_at, first_seen, export, agent_name, owner_name) VALUES (?,?,?,?,?,?,?,?,?) "
                     "ON CONFLICT (pvc) DO UPDATE SET agent=excluded.agent, owner=excluded.owner, deleted_by=excluded.deleted_by, "
                     "deleted_at=excluded.deleted_at, first_seen=excluded.first_seen, export=excluded.export, acked_at='', acked_by='', "
                     "agent_name=excluded.agent_name, owner_name=excluded.owner_name",
                     (f"data-{agent}-0", agent, (owner or "").lower(), (by or "").lower(), at, at, export or "", agent_name or "", owner_name or ""))


def scan(pvcs: list[dict], agents: set[str], now: datetime | None = None) -> list[dict]:
    """하루 1회 점검. 에이전트가 없는 data 볼륨을 기록하고(처음 보면 그 시각), 사라졌거나 에이전트가 다시 생긴 볼륨의 행은 지운다.
    지금 남은 볼륨 행들을 돌려준다."""
    at = _iso(now or _now())
    left: dict[str, tuple[str, str]] = {}
    for p in pvcs:
        name = str((p.get("metadata") or {}).get("name") or "")
        agent = agent_of(name)
        if agent and agent not in agents:
            size = str((((p.get("spec") or {}).get("resources") or {}).get("requests") or {}).get("storage") or "")
            left[name] = (agent, size)
    with _conn() as conn:
        for name, (agent, size) in left.items():
            conn.execute("INSERT INTO retained_volumes (pvc, agent, first_seen, size) VALUES (?,?,?,?) "
                         "ON CONFLICT (pvc) DO UPDATE SET size=excluded.size", (name, agent, at, size))
        for r in conn.execute("SELECT pvc FROM retained_volumes").fetchall():
            if r["pvc"] not in left:
                conn.execute("DELETE FROM retained_volumes WHERE pvc=?", (r["pvc"],))
        return [dict(r) for r in conn.execute("SELECT * FROM retained_volumes ORDER BY pvc")]


def _days(since: str, now: datetime) -> int:
    try:
        return max(0, (now - datetime.fromisoformat(since)).days)
    except ValueError:
        return 0


def _due(now: datetime, days: int) -> list[dict]:
    """기간을 넘겼고, 처리했다면 그 뒤로 같은 기간이 지난 볼륨. 오래된 것부터."""
    if days <= 0:
        return []
    with _conn() as conn:
        rows = [dict(r) for r in conn.execute("SELECT * FROM retained_volumes ORDER BY pvc")]
    out = []
    for r in rows:
        age = _days(r["deleted_at"] or r["first_seen"], now)
        if age >= days and (not r["acked_at"] or _days(r["acked_at"], now) >= days):
            out.append({**r, "days": age})
    return sorted(out, key=lambda r: (-r["days"], r["pvc"]))


def _item_id(rows: list[dict]) -> str:
    return PREFIX + hashlib.sha256("\n".join(sorted(r["pvc"] for r in rows)).encode()).hexdigest()[:16]


def notice_items(namespace: str, now: datetime | None = None, days: int | None = None) -> list[dict]:
    """관리자 받은편지함 항목(있으면 하나). 볼륨마다 에이전트·옛 주인·지운 날·크기·내보내기 파일, 지울 때 쓸 kubectl 명령."""
    now = now or _now()
    days = notice_days() if days is None else days
    rows = _due(now, days)
    if not rows:
        return []
    vols = [{"pvc": r["pvc"], "agent": r["agent"], "owner": r["owner"], "agent_name": r.get("agent_name") or "", "owner_name": r.get("owner_name") or "", "since": r["deleted_at"] or r["first_seen"], "known": bool(r["deleted_at"]),
             "days": r["days"], "size": r["size"], "export": r["export"]} for r in rows]
    return [{"id": _item_id(rows), "kind": "retained_volume", "alias": "", "text": "", "volumes": vols, "days": days,
             "command": f"kubectl -n {namespace} delete pvc " + " ".join(v["pvc"] for v in vols),
             "at": datetime.fromisoformat(vols[0]["since"]).timestamp() if vols[0]["since"] else now.timestamp()}]


def ack(item_id: str, who: str, now: datetime | None = None, days: int | None = None) -> int:
    """「처리했습니다」. 지금 알리는 볼륨들에 처리 시각을 남긴다. 그사이 목록이 바뀌었으면 거절한다(화면을 다시 읽게)."""
    now = now or _now()
    rows = _due(now, notice_days() if days is None else days)
    if not rows or _item_id(rows) != item_id:
        raise ValueError("retained volume notice changed")
    with _conn() as conn:
        for r in rows:
            conn.execute("UPDATE retained_volumes SET acked_at=?, acked_by=? WHERE pvc=?", (_iso(now), (who or "").lower(), r["pvc"]))
    return len(rows)

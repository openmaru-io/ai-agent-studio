# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""실제 실행 기록 — 세션 DB 에서 "무엇을 불렀나"만 읽는다.

읽는 것: 도구 이름, skill_view 가 연 스킬 이름, 명령에 적힌 스크립트 경로(/opt/data/….py 모양만 뽑고 나머지는 버린다).
읽지 않는 것: 대화 내용, 도구 결과, 그 밖의 인자 값.
크론 세션은 id 가 cron_<작업 id>_<시각> 이라 작업과 정확히 이어진다.
"""
from __future__ import annotations

import json
import re
import time
from datetime import datetime
from pathlib import Path

from ..hermes import hermes_reader as hr
from ..common.i18n import tr

_CRON_ID = re.compile(r"^cron_([0-9a-zA-Z]+)_\d{8}_\d{6}")
_SCRIPT = re.compile(r"/opt/data/((?!secrets/)[\w./-]+\.(?:py|sh|js|ts))(?![\w.])")
_MCP = re.compile(r"^mcp__([A-Za-z0-9-]+)__([A-Za-z][A-Za-z0-9_]*)$")
MAX_ROWS = 60_000


def _bucket() -> dict:
    return {"runs": 0, "last": 0.0, "tools": {}, "skills": {}, "scripts": {}, "mcp": {}}


def _bump(d: dict, key: str, n: int = 1) -> None:
    d[key] = d.get(key, 0) + n


def _feed(b: dict, name: str, args) -> None:
    _bump(b["tools"], name)
    m = _MCP.match(name)
    if m:
        _bump(b["mcp"].setdefault(m.group(1), {}), m.group(2))
        return
    if not isinstance(args, dict):
        return
    if name == "skill_view" and isinstance(args.get("name"), str):
        _bump(b["skills"], args["name"].split("/")[-1][:80])
    elif name in ("terminal", "execute_code", "process"):
        text = args.get("command") or args.get("code") or ""
        if isinstance(text, str):
            for rel in set(_SCRIPT.findall(text)):
                _bump(b["scripts"], rel)


def collect(home: Path | None = None, days: int = 14) -> dict:
    home = home or hr.hermes_home()
    since = time.time() - days * 86400
    jobs: dict[str, dict] = {}
    profiles: dict[str, dict] = {}
    notes: list[str] = []
    for prof in hr.profiles(home):
        db = prof.path / "state.db"
        if not db.is_file():
            continue
        try:
            conn = hr._connect_immutable(db)
            try:
                if not {"id", "started_at"} <= hr._columns(conn, "sessions") or not {"session_id", "tool_calls"} <= hr._columns(conn, "messages"):
                    notes.append(tr(f"{prof.name}: 세션 DB 모양이 달라 건너뜀", f"{prof.name}: skipped because the session DB has a different schema"))
                    continue
                pb = profiles.setdefault(prof.name, _bucket())
                seen: set[str] = set()
                rows = conn.execute(
                    "SELECT s.id, s.started_at, m.tool_calls FROM messages m JOIN sessions s ON s.id = m.session_id "
                    "WHERE s.started_at >= ? AND m.tool_calls IS NOT NULL AND m.tool_calls != '' LIMIT ?", (since, MAX_ROWS))
                for sid, started, raw in rows:
                    m = _CRON_ID.match(str(sid))
                    jb = jobs.setdefault(f"{prof.name}/{m.group(1)}", _bucket()) if m else None
                    if sid not in seen:
                        seen.add(sid)
                        for b in (pb, jb):
                            if b is not None:
                                b["runs"] += 1
                                b["last"] = max(b["last"], float(started or 0))
                    try:
                        calls = json.loads(raw)
                    except (TypeError, ValueError):
                        continue
                    for call in calls if isinstance(calls, list) else []:
                        fn = (call or {}).get("function") or {}
                        name = fn.get("name")
                        if not isinstance(name, str) or not name:
                            continue
                        args = fn.get("arguments")
                        if isinstance(args, str):
                            try:
                                args = json.loads(args)
                            except ValueError:
                                args = None
                        if name == "tool_call" and isinstance(args, dict) and isinstance(args.get("name"), str):   # 감싼 호출
                            name, args = args["name"], args.get("arguments")
                        for b in (pb, jb):
                            if b is not None:
                                _feed(b, name, args)
            finally:
                conn.close()
        except Exception as exc:
            notes.append(f"{prof.name}: {type(exc).__name__}")
    for b in list(jobs.values()) + list(profiles.values()):
        b["last"] = datetime.fromtimestamp(b["last"]).astimezone().isoformat(timespec="minutes") if b["last"] else ""
    return {"days": days, "jobs": jobs, "profiles": profiles, "notes": notes,
            "collected_at": datetime.now().astimezone().isoformat(timespec="seconds")}

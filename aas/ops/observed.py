# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""실제 실행 기록 — 세션 DB 에서 "무엇을 불렀나"만 읽는다.

읽는 것: 도구 이름, skill_view 가 연 스킬 이름, 명령에 적힌 스크립트 경로(/opt/data/….py 모양만 뽑고 나머지는 버린다).
읽지 않는 것: 대화 내용, 도구 결과, 그 밖의 인자 값.
크론 세션은 id 가 cron_<작업 id>_<시각> 이라 작업과 정확히 이어진다.

세는 값은 AAS DB 의 시간 칸 표(usage_hours)에 쌓는다(스펙 2026-11-19-005 U1). `refresh` 가 프로파일마다 커서 뒤의 새 기록만 읽어
칸을 고치고, `collect` 는 표에서 14일 결과를 만든다. 처음 한 번(90일)과 「모름」 구간만 시간 구간을 나눠 읽는다.
쿠버네티스에서는 세션 DB 를 사이드카로 읽는데 질의 하나가 2만 행·10초까지라, 예전처럼 14일을 한 질의로 읽으면 기록이 많은
프로파일이 통째로 빠져 사용 0 으로 보였다.
"""
from __future__ import annotations

import json
import os
import re
import socket
import sqlite3
import time
from datetime import datetime
from pathlib import Path

from ..hermes import hermes_reader as hr
from ..hermes.readers import remote as _remote
from ..common.i18n import tr
from . import usage_hours as uh

_CRON_ID = re.compile(r"^cron_([0-9a-zA-Z]+)_\d{8}_\d{6}")
_SCRIPT = re.compile(r"/opt/data/((?!secrets/)[\w./-]+\.(?:py|sh|js|ts))(?![\w.])")
_MCP = re.compile(r"^mcp__([A-Za-z0-9-]+)__([A-Za-z][A-Za-z0-9_]*)$")

HOUR = uh.HOUR
DAY = 86400
FILL_DAYS = uh.SKILL_DAYS                 # 처음 채우는 기간
FULL_DAYS = uh.OTHER_DAYS                 # 이 기간은 모든 도구 호출을 읽고, 그 앞은 skill_view 가 든 행만 읽는다
OVERLAP = 2 * HOUR                        # 늦게 기록된 메시지를 놓치지 않으려고 커서보다 앞부터 다시 읽는다(엔지니어링 리뷰 H5)
ROWS_FULL, ROWS_SKILL, ROWS_OLD_SIDECAR = 5_000, 19_000, 2_000
SQL_SECONDS = 30                          # 사이드카가 이 질의에 쓸 시간 한도(상한 30, 사이드카 sqlite_limits)
SQL_BYTES = 8_000_000
PROFILE_BUDGET, POD_BUDGET = 30.0, 300.0  # 한 차례에 프로파일 하나·POD 하나에 쓰는 시간. 넘으면 다음 차례에 이어 읽는다
NAMES_PER_HOUR = 200                      # 시 칸 하나의 이름 상한, 넘치면 _other(엔지니어링 리뷰 M3)
NAME_LEN = 80
OWNER = f"{socket.gethostname()}:{os.getpid()}"


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


def _calls(raw):
    """tool_calls JSON 에서 (도구 이름, 인자). 감싼 호출(tool_call)은 푼다."""
    try:
        calls = json.loads(raw)
    except (TypeError, ValueError):
        return
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
        if name == "tool_call" and isinstance(args, dict) and isinstance(args.get("name"), str):
            name, args = args["name"], args.get("arguments")
        yield name, args


# ---- 읽기 ---------------------------------------------------------------------------------------
class _Shape:
    """세션 DB 모양. 옛 DB 에는 messages.timestamp·sessions.ended_at 이 없다 — 그때는 세션 시작 시각으로 거른다."""

    def __init__(self, conn):
        s, m = hr._columns(conn, "sessions"), hr._columns(conn, "messages")
        self.ok = {"id", "started_at"} <= s and {"session_id", "tool_calls"} <= m
        self.msg_ts = "timestamp" in m
        self.ended = "ended_at" in s

    def query(self, lo: float, hi: float, narrow: bool, cap: int) -> tuple[str, list]:
        """(SQL, 매개변수). 사이드카는 매개변수를 목록으로 받는다.
        세션을 먼저 거르고 그 세션의 메시지를 (session_id, timestamp) 색인으로 읽는다. messages(timestamp) 만의 색인이 없어
        메시지 시각으로 바로 거르면 구간마다 messages 표를 다 읽는다(스펙 리뷰 3회차 실현성 1)."""
        at = "m.timestamp" if self.msg_ts else "s.started_at"
        sql = (f"SELECT s.id, s.started_at, {at}, m.tool_calls FROM sessions s JOIN messages m ON m.session_id = s.id "
               "WHERE s.started_at < ?")
        params: list = [hi]
        if self.ended:
            sql += " AND (s.ended_at IS NULL OR s.ended_at >= ?)"
            params.append(lo)
        sql += f" AND {at} >= ? AND {at} < ? AND m.tool_calls IS NOT NULL AND m.tool_calls != ''"
        params += [lo, hi]
        if narrow:
            sql += " AND m.tool_calls LIKE '%skill_view%'"
        return sql + f" LIMIT {cap + 1}", params


def _exec(conn, sql: str, params: list, cap: int) -> list:
    """한 구간을 읽는다. 원격이면 사이드카에 시간·바이트 한도를 함께 보낸다. 행이 cap 을 넘으면 SqlTruncated."""
    if isinstance(conn, _remote.RemoteConnection):
        rows = conn.execute(sql, params, max_seconds=SQL_SECONDS, max_bytes=SQL_BYTES).fetchall()
    else:
        rows = conn.execute(sql, params).fetchall()
    if len(rows) > cap:
        raise _remote.SqlTruncated("too many rows")
    return rows


class _Reader:
    """프로파일 하나의 구간 읽기. 넘치면 하루 → 6시간 넷 → 1시간 여섯으로 나누고, 1시간도 못 읽으면 그 구간은 「모름」."""

    def __init__(self, conn, shape: _Shape, old_sidecar: bool, deadline: float):
        self.conn, self.shape, self.deadline = conn, shape, deadline
        self.old = old_sidecar
        self.unknown: list[list[float]] = []
        self.done: list[list[float]] = []       # 끝까지 읽은 구간 — 이 구간의 칸만 바꾼다
        self.rows: list = []
        self.stats = {"queries": 0, "rows": 0}
        self.stopped = False                  # 1시간 구간도 시간 초과 — 남은 구간은 읽지 않는다

    def cap(self, narrow: bool) -> int:
        if self.old:
            return ROWS_OLD_SIDECAR
        return ROWS_SKILL if narrow else ROWS_FULL

    def read(self, lo: float, hi: float, full_from: float) -> None:
        span = DAY
        t = lo
        while t < hi:
            end = min(hi, (int(t) // span + 1) * span)
            self._range(t, end, full_from, DAY)
            t = end

    def _range(self, lo: float, hi: float, full_from: float, size: float) -> None:
        if self.stopped or time.monotonic() > self.deadline:
            self.unknown.append([lo, hi])
            return
        narrow = hi <= full_from
        cap = self.cap(narrow)
        try:
            rows = self._try(lo, hi, narrow, cap)
        except (_remote.SqlTruncated, _remote.SqlTimeout) as exc:
            smaller = {DAY: 6 * HOUR, 6 * HOUR: HOUR}.get(size)
            if smaller is None or hi - lo <= HOUR:
                self.unknown.append([lo, hi])
                if isinstance(exc, _remote.SqlTimeout):
                    self.stopped = True          # 1시간도 시간 초과면 나누기가 소용없다(스펙 리뷰 3회차)
                return
            t = lo
            while t < hi:
                end = min(hi, t + smaller)
                self._range(t, end, full_from, smaller)
                t = end
            return
        if rows is not None:
            self.rows.extend(rows)
            self.done.append([lo, hi])

    def _try(self, lo, hi, narrow, cap):
        sql, params = self.shape.query(lo, hi, narrow, cap)
        for attempt in (0, 1):
            self.stats["queries"] += 1
            try:
                rows = _exec(self.conn, sql, params, cap)
                self.stats["rows"] += len(rows)
                return rows
            except _remote.SqlBusy:
                if attempt:
                    self.unknown.append([lo, hi])       # 잠금은 한 번만 다시 묻고 나누지 않는다
                    return None
                time.sleep(1)
        return None


# ---- 세기 ---------------------------------------------------------------------------------------
def _count(rows) -> tuple[dict, dict]:
    """읽은 행 → ({(hour, kind, name, job): n}, {session_id: {started_at, last_at, job}}). job 이 빈 칸은 프로파일 전체,
    크론 세션은 그 작업 id 칸에도 센다(흐름 겹쳐 보기의 크론 줄, 엔지니어링 리뷰 H1)."""
    per: dict[tuple[int, str], dict] = {}
    sessions: dict[str, dict] = {}
    for sid, started, at, raw in rows:
        sid = str(sid)
        at = float(at or started or 0)
        m = _CRON_ID.match(sid)
        job = m.group(1) if m else ""
        s = sessions.setdefault(sid, {"session_id": sid, "started_at": float(started or 0) or None, "last_at": at, "job": job})
        s["last_at"] = max(s["last_at"], at)
        hour = int(at) // HOUR
        for name, args in _calls(raw):
            for j in ({"", job} if job else {""}):
                _feed(per.setdefault((hour, j), _bucket()), name, args)
    cells: dict[tuple, int] = {}
    for (hour, job), b in per.items():
        flat = [("tool", k, n) for k, n in b["tools"].items()] + [("skill", k, n) for k, n in b["skills"].items()] \
            + [("script", k, n) for k, n in b["scripts"].items()] \
            + [("mcp", f"{srv}/{tool}", n) for srv, tools in b["mcp"].items() for tool, n in tools.items()]
        flat.sort(key=lambda r: -r[2])
        for i, (kind, name, n) in enumerate(flat):
            key = (hour, kind, name[:NAME_LEN] if i < NAMES_PER_HOUR else "_other", job)
            cells[key] = cells.get(key, 0) + n
    return cells, sessions


# ---- 쌓기 ---------------------------------------------------------------------------------------
def refresh(home: Path | None = None, pod: str = "", now: float | None = None) -> dict:
    """프로파일마다 커서 뒤의 새 기록을 읽어 시간 칸 표를 고친다. 다른 서버 복제본이 같은 프로파일을 읽고 있으면 건너뛴다.
    돌려주는 값은 {notes, log}. log 는 프로파일마다 「구간 질의 수·행 수·모름 구간·걸린 시간」(구현 전 게이트 측정용)."""
    home = home or hr.hermes_home()
    pod = pod or _pod_key(home)
    at = time.time() if now is None else now
    began = time.monotonic()
    notes: list[str] = []
    log: list[dict] = []
    backend = getattr(home, "backend", None)
    old_sidecar = backend is not None and not backend.has_sql_limits()
    for prof in hr.profiles(home):
        db = prof.path / "state.db"
        if not db.is_file():
            continue
        if time.monotonic() - began > POD_BUDGET:
            break                                               # 남은 프로파일은 다음 차례에 — 커서가 그대로라 그 자리부터
        if not uh.acquire(pod, prof.name, OWNER, now=at):
            continue
        try:
            entry = _refresh_one(db, pod, prof.name, at, old_sidecar, notes)
            if entry:
                log.append(entry)
        finally:
            uh.release(pod, prof.name, OWNER)
    uh.prune(pod, now=at)
    for e in log:
        print("사용 집계 " + json.dumps(e, ensure_ascii=False), flush=True)   # i18n-ignore: 로그(게이트 측정)
    return {"notes": notes, "log": log}


def _refresh_one(db, pod: str, profile: str, at: float, old_sidecar: bool, notes: list) -> dict | None:
    began = time.monotonic()
    cur = uh.cursor(pod, profile)
    fill_lo = (int(at - FILL_DAYS * DAY) // HOUR) * HOUR     # 구간은 시 경계에서 시작한다 — 칸을 통째로 바꾸므로
    if cur is None or cur["ts"] < fill_lo:
        ranges, first = [[fill_lo, at]], True                   # 처음 채우기(또는 90일 넘게 따라잡을 것)
    else:
        lo = max(fill_lo, (int(cur["ts"]) // HOUR) * HOUR - OVERLAP)
        ranges = [[max((int(a) // HOUR) * HOUR, fill_lo), b] for a, b in cur["unknown"] if b > fill_lo] + [[lo, at]]
        first = False
    try:
        conn = hr._connect_immutable(db)
    except (sqlite3.Error, OSError) as exc:
        notes.append(f"{profile}: {type(exc).__name__}")
        return None
    try:
        shape = _Shape(conn)
        if not shape.ok:
            notes.append(tr(f"{profile}: 세션 DB 모양이 달라 건너뜀", f"{profile}: skipped because the session DB has a different schema"))
            return None
        reader = _Reader(conn, shape, old_sidecar, began + PROFILE_BUDGET)
        for lo, hi in ranges:
            reader.read(lo, hi, at - FULL_DAYS * DAY)
    except sqlite3.Error as exc:                                 # 400·DB 없음 등 — 이번 구간 전체를 「모름」으로
        notes.append(f"{profile}: {type(exc).__name__}")
        reader = None
    finally:
        conn.close()
    if reader is None:
        unknown, done = [[r[0], r[1]] for r in ranges], []
        cells, sessions = {}, {}
    else:
        unknown, done = reader.unknown, reader.done
        cells, sessions = _count(reader.rows)
    spans = [(int(lo) // HOUR, (int(hi) - 1) // HOUR) for lo, hi in _merge(done)]
    uh.save(pod, profile, OWNER, spans=spans, hours=cells, sessions=list(sessions.values()), ts=at,
            unknown=_merge(unknown), filled_from=fill_lo if first else None)
    return {"pod": pod, "profile": profile, "first": first, "queries": reader.stats["queries"] if reader else 0,
            "rows": reader.stats["rows"] if reader else 0, "unknown": len(unknown), "seconds": round(time.monotonic() - began, 2)}


def _merge(spans: list) -> list:
    out: list[list[float]] = []
    for lo, hi in sorted(spans):
        if out and lo <= out[-1][1]:
            out[-1][1] = max(out[-1][1], hi)
        else:
            out.append([lo, hi])
    return out


# ---- 14일 결과 -----------------------------------------------------------------------------------
def collect(home: Path | None = None, days: int = 14, pod: str = "") -> dict:
    """커서 뒤를 읽어 표를 고친 뒤, 표에서 지난 days 일(×24시간)의 결과를 만든다. 결과 모양은 예전과 같다:
    {days, jobs: {"프로파일/작업": 칸}, profiles: {프로파일: 칸}, notes, partial_profiles, collected_at}.
    runs 는 기간 안에 메시지가 있던 도구 호출 세션 수다(예전은 기간 안에 시작한 세션 — 오래 이어진 세션이 0 으로 보였다)."""
    home = home or hr.hermes_home()
    pod = pod or _pod_key(home)
    at = time.time()
    done = refresh(home, pod, now=at)
    since = at - days * DAY
    jobs: dict[str, dict] = {}
    profiles: dict[str, dict] = {}
    for r in uh.hours(pod, int(since) // HOUR):
        b = profiles.setdefault(r["profile"], _bucket()) if not r["job"] else jobs.setdefault(f"{r['profile']}/{r['job']}", _bucket())
        if r["kind"] == "mcp":
            srv, _, tool = r["name"].partition("/")
            _bump(b["mcp"].setdefault(srv, {}), tool, r["n"])
        else:
            _bump(b[{"tool": "tools", "skill": "skills", "script": "scripts"}.get(r["kind"], "tools")], r["name"], r["n"])
    for s in uh.sessions(pod, since):
        for b in (profiles.setdefault(s["profile"], _bucket()),
                  jobs.setdefault(f"{s['profile']}/{s['job']}", _bucket()) if s["job"] else None):
            if b is not None:
                b["runs"] += 1
                b["last"] = max(b["last"], s["last_at"])
    partial = sorted(p for p, c in uh.cursors(pod).items() if any(hi > since for _lo, hi in c["unknown"]))
    for b in list(jobs.values()) + list(profiles.values()):
        b["last"] = datetime.fromtimestamp(b["last"]).astimezone().isoformat(timespec="minutes") if b["last"] else ""
    return {"days": days, "jobs": jobs, "profiles": profiles, "notes": done["notes"], "partial_profiles": partial,
            "collected_at": datetime.now().astimezone().isoformat(timespec="seconds")}


def _pod_key(home) -> str:
    """POD 를 모르는 호출(로컬 시험·CLI)은 데이터 폴더로 가른다."""
    return f"home:{home}"

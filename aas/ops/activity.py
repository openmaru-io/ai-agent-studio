# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""활동 현황 — Hermes 가 저장하는 세션 DB(state.db)를 읽기 전용으로 요약한다(회의록 R6).

프로파일 × 출처(텔레그램·버즈·크론·CLI·AAS …)별 세션 수, 메시지·도구 호출 수, 토큰, 마지막 활동.
대화 내용은 읽지 않는다 — 집계 컬럼만 본다.
"""
from __future__ import annotations

import sqlite3
import time
from datetime import datetime

from ..hermes import hermes_reader as hr
from ..common.i18n import tr

WINDOWS = {"7d": 7, "30d": 30}
COLS = ("message_count", "tool_call_count", "input_tokens", "output_tokens", "api_call_count")


def _iso(ts) -> str | None:
    try:
        return datetime.fromtimestamp(float(ts)).astimezone().isoformat(timespec="minutes")
    except (TypeError, ValueError, OSError):
        return None


USED = ("message_count", "tool_call_count", "input_tokens", "output_tokens")   # 결과에 쓰는 합계(api_call_count 는 합하지만 쓰지 않는다)
_STD = set(USED) | {"source", "started_at", "last_activity_at", "model"}


def _queries(have: set[str], since: float, cols=COLS) -> list[tuple[str, tuple]]:
    """집계 쿼리 세 개(전체 수·출처별·모델별). 없는 컬럼은 0 으로 둔다."""
    sums = ", ".join(f"COALESCE(SUM({c}),0) AS {c}" if c in have else f"0 AS {c}" for c in cols)
    last = "MAX(COALESCE(last_activity_at, started_at))" if "last_activity_at" in have else "MAX(started_at)"
    out = [("SELECT COUNT(*) FROM sessions", ()),
           (f"SELECT source, COUNT(*) AS n, {sums}, {last} AS last FROM sessions WHERE started_at >= ? GROUP BY source ORDER BY n DESC", (since,))]
    if "model" in have:
        out.append(("SELECT COALESCE(NULLIF(model,''),?) AS m, COUNT(*) AS n, COALESCE(SUM(input_tokens),0) AS i, "
                    "COALESCE(SUM(output_tokens),0) AS o FROM sessions WHERE started_at >= ? GROUP BY 1",
                    (tr("(미기록)", "(not recorded)"), since)))
    return out


def collect(days: int = 7, home=None) -> dict:
    since = time.time() - days * 86400
    profiles, by_source, by_model = [], {}, {}
    profs = list(hr.profiles(home))
    dbs = {prof.name: prof.path / "state.db" for prof in profs}
    present = {prof.name for prof in profs if dbs[prof.name].is_file()}
    # 표준 컬럼을 가정한 쿼리를 모든 프로파일에 대해 한 번에 보낸다(원격이면 사이드카 요청 하나, OMAI-1102).
    # 컬럼 목록을 함께 받아, 표준과 다른 프로파일만 그 컬럼에 맞춘 쿼리로 다시 읽는다.
    std_q = [("PRAGMA table_info(sessions)", ())] + _queries(_STD, since, USED)
    items = [(dbs[name], q, ps) for name in dbs if name in present for q, ps in std_q]
    batch = iter(hr.query_batch(items)) if items else iter(())
    for prof in profs:
        db = dbs[prof.name]
        row = {"name": prof.name, "status": "ok", "sources": [], "sessions": 0, "messages": 0,
               "tool_calls": 0, "input_tokens": 0, "output_tokens": 0, "last_activity": None,
               "total_sessions": 0}
        if prof.name not in present:
            row["status"] = "no_db"
            profiles.append(row)
            continue
        got = [next(batch) for _ in std_q]
        try:
            if isinstance(got[0], Exception):
                raise got[0]
            have = {r["name"] for r in got[0]}
            if not {"source", "started_at"} <= have:
                raise hr.SchemaMismatch(tr("sessions 테이블 구조가 다릅니다", "The sessions table has a different structure"))
            if _STD <= have:
                answers = got[1:]
            else:                                               # 표준과 다르다 — 이 프로파일만 컬럼에 맞춰 다시 읽는다
                answers = hr.query_batch([(db, q, ps) for q, ps in _queries(have, since)])
            for a in answers:
                if isinstance(a, Exception):
                    raise a
            row["total_sessions"] = answers[0][0][0]
            for r in answers[1]:
                src = r["source"] or "?"
                item = {"source": src, "sessions": r["n"], "messages": r["message_count"],
                        "tool_calls": r["tool_call_count"], "input_tokens": r["input_tokens"],
                        "output_tokens": r["output_tokens"], "last_activity": _iso(r["last"])}
                row["sources"].append(item)
                for k in ("sessions", "messages", "tool_calls", "input_tokens", "output_tokens"):
                    row[k] += item[k]
                    by_source.setdefault(src, {"source": src, "sessions": 0, "messages": 0, "tool_calls": 0,
                                               "input_tokens": 0, "output_tokens": 0, "profiles": 0})[k] += item[k]
                by_source[src]["profiles"] += 1
                if item["last_activity"] and (row["last_activity"] or "") < item["last_activity"]:
                    row["last_activity"] = item["last_activity"]
            for r in (answers[2] if len(answers) > 2 else []):
                m = by_model.setdefault(r["m"], {"model": r["m"], "sessions": 0, "input_tokens": 0, "output_tokens": 0})
                m["sessions"] += r["n"]; m["input_tokens"] += r["i"]; m["output_tokens"] += r["o"]
        except hr.SchemaMismatch as exc:
            row["status"] = f"error: {exc}"
        except sqlite3.Error as exc:
            row["status"] = f"error: {type(exc).__name__}"
        profiles.append(row)
    return {"collected_at": datetime.now().astimezone().isoformat(timespec="seconds"), "days": days,
            "profiles": profiles,
            "by_source": sorted(by_source.values(), key=lambda s: -s["sessions"]),
            "by_model": sorted(by_model.values(), key=lambda m: -m["sessions"]),
            "totals": {k: sum(p[k] for p in profiles) for k in
                       ("sessions", "messages", "tool_calls", "input_tokens", "output_tokens")}
                      | {"idle_profiles": sum(1 for p in profiles if p["status"] == "ok" and not p["sessions"])}}


def daily(since: float, until: float, home=None) -> dict[str, dict]:
    """since~until(에포크 초) 사이에 시작한 세션을 서버 시간대의 날짜별로 더한다(대시보드 일별 사용량, 계획 2026-10-14-014 R10).
    프로파일마다 GROUP BY 한 결과 몇 줄만 받는다 — 원격이면 사이드카 요청 하나다. 읽지 못한 프로파일은 건너뛴다.
    날짜는 사이드카의 시간대가 아니라 이 서버의 시간대로 자른다(시차 초를 더해 'unixepoch' 로 자른다)."""
    offset = int(datetime.now().astimezone().utcoffset().total_seconds())
    sql = ("SELECT date(CAST(started_at AS INTEGER) + ?, 'unixepoch') AS d, COUNT(*) AS n, COALESCE(SUM(message_count),0) AS m, "
           "COALESCE(SUM(input_tokens),0) AS i, COALESCE(SUM(output_tokens),0) AS o FROM sessions "
           "WHERE started_at >= ? AND started_at < ? GROUP BY d")
    dbs = [prof.path / "state.db" for prof in hr.profiles(home)]
    dbs = [db for db in dbs if db.is_file()]
    out: dict[str, dict] = {}
    for rows in hr.query_batch([(db, sql, (offset, since, until)) for db in dbs]) if dbs else []:
        if isinstance(rows, Exception):
            continue
        for r in rows:
            day = out.setdefault(r["d"], {"sessions": 0, "messages": 0, "input_tokens": 0, "output_tokens": 0})
            day["sessions"] += r["n"]; day["messages"] += r["m"]; day["input_tokens"] += r["i"]; day["output_tokens"] += r["o"]
    return out

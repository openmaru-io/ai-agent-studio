# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""스킬 기간 사용(스펙 2026-11-19-005 2단계 R1·R2). 쌓아 둔 시간 칸(usage_hours)에서 7·30·90일 합을 만든다.

줄마다:
  uses_N      — 지난 N×24시간 skill_view 횟수(그 프로파일). 집계 전 프로파일이면 None
  covered_N   — 그 기간에 「모름」 구간이 없고 집계가 됐다
  unused_N    — 세 조건(기간 사용·.usage.json 마지막 사용·크론 결과)이 모두 없으면 True. 셀 수 없으면 None
  file_only_N — 세션 기록에는 없고 .usage.json 마지막 사용만 기간 안
공유 원본 줄(사본이 있는 줄)에는 shared_uses_N·shared_covered_N·shared_unused_N(자신과 사본 합)과
used_by: [{profile, n7, n30, n90}](쓴 프로파일만, 30일 많이 쓴 순)을 더한다(U3).
에이전트마다 runs_N(기간 안에 메시지가 있던 도구 호출 세션 수)·runs_since(처음 채우기 시작)·usage_ready·usage_unknown(읽지 못한 구간).
"""
from __future__ import annotations

import time
from datetime import datetime, timezone

from ..assets import skill_deps
from . import usage_hours

PERIODS = (7, 30, 90)
DAY = 86400


def iso(ts: float) -> str:
    return datetime.fromtimestamp(ts, timezone.utc).strftime("%Y-%m-%dT%H:%M:%S")


def _ts(text: str) -> float | None:
    """.usage.json 의 시각(ISO, 시간대가 없으면 UTC 로 본다)."""
    if not text:
        return None
    try:
        dt = datetime.fromisoformat(str(text).replace("Z", "+00:00"))
    except ValueError:
        return None
    return (dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)).timestamp()


def _covered(cur: dict | None, lo: float, hi: float) -> bool:
    if not cur:
        return False
    return not any(a < hi and b > lo for a, b in cur.get("unknown") or [])


def compute(pod: str, skills: list[dict], last_used: dict[str, str], now: float | None = None) -> tuple[dict[str, dict], dict[str, dict]]:
    """(스킬 id → 기간 필드, 프로파일 → 에이전트 기간 필드). last_used 는 스킬 id → .usage.json 마지막 사용(annotate 의 last_used)."""
    at = time.time() if now is None else now
    cursors = usage_hours.cursors(pod)
    counts: dict[int, dict[tuple[str, str], int]] = {}
    for n in PERIODS:
        got: dict[tuple[str, str], int] = {}
        for r in usage_hours.hours(pod, int(at - n * DAY) // 3600, ("skill",)):
            got[(r["profile"], r["name"])] = got.get((r["profile"], r["name"]), 0) + r["n"]
        counts[n] = got
    rows: dict[str, dict] = {}
    for s in skills:
        cur = cursors.get(s["profile"])
        used_at = _ts(last_used.get(s["id"], ""))
        cron_ok = any(c.get("last_status") for c in s.get("cron") or [])
        out: dict = {}
        for n in PERIODS:
            lo = at - n * DAY
            if cur is None:
                out.update({f"uses_{n}": None, f"covered_{n}": False, f"unused_{n}": None, f"file_only_{n}": False})
                continue
            uses = counts[n].get((s["profile"], s["name"]), 0)
            covered = _covered(cur, lo, at)
            file_in = used_at is not None and used_at >= lo
            out[f"uses_{n}"] = uses
            out[f"covered_{n}"] = covered
            out[f"file_only_{n}"] = uses == 0 and file_in
            out[f"unused_{n}"] = False if (uses or file_in or cron_ok) else (True if covered else None)
        rows[s["id"]] = out
    # 공유 원본: 자신과 사본(가져다 쓰는 프로파일)의 합(U3)
    for s in skills:
        if s.get("shared_from"):
            continue
        group = skill_deps.copies_of(s, skills)
        if len(group) < 2:
            continue
        mine = rows[s["id"]]
        by = []
        for c in group:
            r = rows[c["id"]]
            if any(r.get(f"uses_{n}") for n in PERIODS):
                by.append({"profile": c["profile"], **{f"n{n}": r.get(f"uses_{n}") or 0 for n in PERIODS}})
        by.sort(key=lambda x: (-x["n30"], -x["n90"], x["profile"]))
        mine["used_by"] = by
        for n in PERIODS:
            members = [rows[c["id"]] for c in group]
            ready = all(m[f"uses_{n}"] is not None for m in members)
            covered = ready and all(m[f"covered_{n}"] for m in members)
            mine[f"shared_uses_{n}"] = sum(m[f"uses_{n}"] or 0 for m in members) if ready else None
            mine[f"shared_covered_{n}"] = covered
            if any(m[f"unused_{n}"] is False for m in members):
                mine[f"shared_unused_{n}"] = False
            else:
                mine[f"shared_unused_{n}"] = True if covered else None
    # 에이전트: 실행 수는 기간 안에 메시지가 있던 도구 호출 세션
    sessions = usage_hours.sessions(pod, at - max(PERIODS) * DAY)
    agents: dict[str, dict] = {}
    for prof, cur in cursors.items():
        mine = [x for x in sessions if x["profile"] == prof]
        agents[prof] = {"usage_ready": True, "runs_since": iso(cur["filled_from"]) if cur.get("filled_from") else "",
                        # 읽지 못한 구간(UTC ISO 쌍) — 화면 상태 안내가 고른 기간에 걸친 것만 날짜로 보인다
                        "usage_unknown": [[iso(a), iso(b)] for a, b in cur.get("unknown") or [] if b > at - max(PERIODS) * DAY],
                        **{f"runs_{n}": sum(1 for x in mine if x["last_at"] >= at - n * DAY) for n in PERIODS}}
    for s in skills:
        agents.setdefault(s["profile"], {"usage_ready": False, "runs_since": "", "usage_unknown": [], **{f"runs_{n}": None for n in PERIODS}})
    return rows, agents


TOP_N = 50


def top_skills(rows: list[dict]) -> dict[str, list[dict]]:
    """모든 에이전트의 기간 사용 순위(스펙 2026-11-19-005 U5, R5). rows 는 기간 값을 붙인 /api/skills 줄.
    묶음은 원본 기준: 공용 사본은 (가져온 곳, 이름)으로 원본과 한 줄로 합치고, 공용이 아닌 같은 이름 스킬은 에이전트별로 따로 낸다.
    순서는 기간 사용 합 → 쓰는 에이전트 수 → 이름, 기간마다 상위 50. 사용 0 인 줄은 내지 않는다.
    한 줄은 {key, name, origin_profile, shared, n, partial, profiles: [{profile, id, n}]}(쓴 에이전트만, 많이 쓴 순).
    묶음의 어느 줄이라도 그 기간을 다 세지 못했으면 partial(화면 「일부」)."""
    out: dict[str, list[dict]] = {}
    for n in PERIODS:
        groups: dict[tuple[str, str], dict] = {}
        for s in rows:
            uses = s.get(f"uses_{n}")
            if uses is None and f"uses_{n}" not in s:
                continue
            home = s.get("shared_from") or s["profile"]
            g = groups.setdefault((home, s["name"]), {"key": f"{home}/{s['name']}", "name": s["name"], "origin_profile": home,
                                                      "shared": False, "n": 0, "partial": False, "profiles": []})
            g["shared"] = g["shared"] or bool(s.get("shared_from"))
            g["n"] += uses or 0
            g["partial"] = g["partial"] or not s.get(f"covered_{n}", False)
            if uses:
                g["profiles"].append({"profile": s["profile"], "id": s["id"], "n": uses})
        ranked = [g for g in groups.values() if g["n"] > 0]
        for g in ranked:
            g["profiles"].sort(key=lambda x: (-x["n"], x["profile"]))
        ranked.sort(key=lambda g: (-g["n"], -len(g["profiles"]), g["name"], g["origin_profile"]))
        out[str(n)] = ranked[:TOP_N]
    return out

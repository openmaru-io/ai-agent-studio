# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""스킬을 지우면 무엇이 깨지는가 — 흐름 색인(flow.build)의 들어오는 연결로 센다.

- 막음(block): 예약 작업이 이 스킬을 돌린다(cron → runs), 다른 스킬이 머리말 related_skills 로 이 스킬을 가리킨다(refers, conf doc)
- 알림(warn): 다른 스킬 본문이 이름만 언급한다(refers, conf mention — 오탐이 많아 막지 않는다)
- 가져다 씀(agents): 공용 스킬을 skills.external_dirs 로 가져다 쓰는 AI 에이전트(프로파일). 지우면 그쪽에서도 빠진다

공용 스킬은 가져다 쓰는 프로파일마다 줄(사본, shared_from)이 따로 있고 예약 작업은 그 사본을 가리킬 수 있다.
그래서 원본과 사본 모두의 들어오는 연결을 본다. 사본끼리·자기 자신에서 오는 연결은 세지 않는다.
"""
from __future__ import annotations

LIMIT = 20                                   # 화면에 보일 만큼만


def copies_of(s: dict, skills: list[dict]) -> list[dict]:
    """s 와 같은 스킬 폴더를 가리키는 줄: 자신 + (s 가 원본이면) 가져다 쓰는 프로파일의 사본."""
    if s.get("shared_from"):
        return [s]
    return [s] + [r for r in skills if r.get("shared_from") == s["profile"] and r["name"] == s["name"] and r["id"] != s["id"]]


def dependents(index: dict | None, skills: list[dict], s: dict) -> dict:
    """{"block": [...], "warn": [...], "agents": [...], "checked": bool}. 줄마다 {kind, id, label, profile}.
    index 가 없으면(흐름 색인이 아직 없음) checked=False — 부르는 쪽은 지우기 전에 다시 본다."""
    copies = copies_of(s, skills)
    agents = sorted({c["profile"] for c in copies if c.get("shared_from")})
    if not index:
        return {"block": [], "warn": [], "agents": agents, "checked": False}
    mine = {"skill:" + c["id"] for c in copies}
    nodes, inc = index.get("nodes") or {}, index.get("inc") or {}
    block: dict[str, dict] = {}
    warn: dict[str, dict] = {}
    for nid in mine:
        for e in inc.get(nid, []):
            src = e.get("from") or ""
            if src in mine:
                continue
            n = nodes.get(src) or {}
            kind = n.get("kind") or src.split(":", 1)[0]
            item = {"kind": kind, "id": src.split(":", 1)[1] if ":" in src else src, "label": n.get("label") or src,
                    "profile": n.get("profile") or ""}
            if kind == "cron" and e.get("kind") == "runs":
                block.setdefault(src, item)
            elif kind == "skill" and e.get("kind") in ("refers", "runs"):
                (warn if e.get("conf") == "mention" else block).setdefault(src, item)
    for k in list(warn):
        if k in block:
            warn.pop(k)
    order = lambda d: sorted(d.values(), key=lambda x: (x["kind"] != "cron", x["profile"], x["label"]))
    return {"block": order(block)[:LIMIT], "warn": order(warn)[:LIMIT], "agents": agents, "checked": True,
            "n_block": len(block), "n_warn": len(warn)}


def summary(index: dict | None, skills: list[dict]) -> dict[str, dict]:
    """줄마다 {n_block, n_warn, n_agents} — 스킬 목록(/api/skills)에 붙인다. 사본 묶음을 한 번에 만들어 줄 수에 비례해 끝난다."""
    by_origin: dict[tuple[str, str], list[dict]] = {}
    for r in skills:
        if r.get("shared_from"):
            by_origin.setdefault((r["shared_from"], r["name"]), []).append(r)
    out: dict[str, dict] = {}
    for s in skills:
        group = [s] if s.get("shared_from") else [s] + by_origin.get((s["profile"], s["name"]), [])
        n_agents = sum(1 for c in group if c.get("shared_from"))
        if not index:
            out[s["id"]] = {"n_block": 0, "n_warn": 0, "n_agents": n_agents, "checked": False}
            continue
        d = dependents(index, group, s) if len(group) > 1 else dependents(index, [s], s)
        out[s["id"]] = {"n_block": d["n_block"], "n_warn": d["n_warn"], "n_agents": n_agents, "checked": True}
    return out

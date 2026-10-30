# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""크론 작업(또는 스킬)이 실제로 하는 일을 사람이 읽을 단계 목록으로 풀어 준다.
새로 분석하지 않는다 — 흐름 그래프(flow.py)와 실행 기록(observed.py)에서 뽑는다."""
from __future__ import annotations

import re
from pathlib import Path

from . import flow
from ..market import skill_desc
from ..common.i18n import tr

ORDER = ("skill", "script", "mcp", "host", "cred", "lib")


def _title(kind: str) -> str:
    """묶음 제목. 부르는 때에 언어가 정해지도록 함수로 둔다."""
    return {"skill": tr("함께 가리키는 스킬", "Related skills"), "script": tr("돌리는 스크립트", "Scripts it runs"),
            "mcp": tr("부르는 MCP 서버", "MCP servers it calls"), "host": tr("접속하는 외부 호스트", "External hosts it connects to"),
            "cred": tr("쓰는 API 키·토큰", "API keys & tokens it uses"), "lib": tr("불러 쓰는 라이브러리", "Libraries it imports")}[kind]


def _outline(home: Path, rel: str | None) -> list[dict]:
    """SKILL.md 의 제목 줄로 만든 차례(무슨 절이 있는지)."""
    if not rel:
        return []
    out = []
    fence = False
    for no, line in enumerate(flow._read(home / rel).splitlines(), 1):
        if line.strip().startswith("```"):
            fence = not fence
        m = None if fence else re.match(r"^(#{1,3})\s+(.+?)\s*$", line)
        if m:
            out.append({"level": len(m.group(1)), "text": flow.mask_line(m.group(2))[:80], "line": no})
    return out[:30]


def _summary(n: dict, nodes: dict) -> str:
    """항목 요약. 번역된 노드(한국어면 스킬 설명 번역)를 먼저 보고, 영어 화면에서 메타 키가 바뀐 경우는 번역 전 노드에서 읽는다."""
    m, raw = n.get("meta") or {}, (nodes.get(n["id"]) or {}).get("meta") or {}
    return m.get("요약") or m.get("설명") or raw.get("요약") or raw.get("설명") or ""  # i18n-ignore: flow.py 의 데이터 키


def build(index: dict, home: Path, profile: str, skill: str = "", job_id: str = "", obs: dict | None = None,
          gateway: dict | None = None, deliver: str = "") -> dict:
    """skill 이름이나 작업 id 로 설명을 만든다. 둘 다 없거나 못 찾으면 unknown=True."""
    nodes = index["nodes"]
    root = ""
    if job_id and f"cron:{profile}/{job_id}" in nodes:
        root = f"cron:{profile}/{job_id}"
    elif skill:
        short = skill.split("/")[-1]
        root = index["skill_ids"].get(f"{profile}/{short}") or index["skill_ids"].get(f"default/{short}") or ""
    out = {"profile": profile, "root": root, "unknown": not root, "skill": None, "groups": [], "checks": [], "observed": None}
    if gateway is not None:
        if gateway.get("running") is False:
            out["checks"].append({"level": "bad", "text": tr(f"{profile} 의 게이트웨이가 꺼져 있습니다 — 예약 작업은 게이트웨이 안에서 돌기 때문에 이 작업은 실행되지 않습니다.",
                                                    f"The gateway of {profile} is off. Scheduled jobs run inside the gateway, so this job does not run.")})
        elif gateway.get("running"):
            out["checks"].append({"level": "ok", "text": tr(f"{profile} 의 게이트웨이가 돌고 있습니다.", f"The gateway of {profile} is running.")})
    if deliver in ("", "local"):
        out["checks"].append({"level": "warn", "text": tr("결과를 저장만 합니다 — 실패해도 아무에게도 알리지 않습니다.", "Results are only saved. No one is notified, even on failure.")})
    elif deliver:
        kind = deliver.split(":")[0]
        connected = {c["name"] for c in (gateway or {}).get("channels", []) if c.get("state") == "connected" and not c.get("stale")}
        if kind in ("telegram", "buzz", "slack", "discord", "mattermost") and gateway is not None and kind not in connected:
            out["checks"].append({"level": "bad", "text": tr(f"결과를 {kind} 로 보내게 돼 있는데 이 프로파일의 {kind} 가 연결돼 있지 않습니다.",
                                                    f"Results are set to go to {kind}, but {kind} is not connected for this profile.")})
        else:
            out["checks"].append({"level": "ok", "text": tr(f"결과와 실패 알림을 {deliver} 로 보냅니다.", f"Results and failure alerts go to {deliver}.")})
    if not root:
        out["checks"].append({"level": "warn", "text": tr("돌릴 스킬을 찾지 못했습니다. 지시문만 있는 작업은 AI 에이전트가 그때 판단해 도구를 고르므로 미리 알 수 있는 흐름이 없습니다.",
                                            "No skill to run was found. A job with only instructions lets the AI Agent choose tools at run time, so there is no call flow to show in advance.")})
        return out

    sub = flow.subgraph(index, root)
    if obs:
        sub = flow.overlay(index, sub, obs)
        out["observed"] = sub.get("observed")
    by_id = {n["id"]: n for n in sub["nodes"]}
    main = by_id[root]
    skill_node = main if main["kind"] == "skill" else next(
        (by_id[e["to"]] for e in sub["edges"] if e["from"] == root and e["to"].startswith("skill:") and e["kind"] == "runs"), None)
    if skill_node:
        raw = (nodes.get(skill_node["id"]) or {}).get("meta") or {}   # 번역 전 노드에서 읽는다 — 영어 화면은 메타 키가 Description 으로 바뀌어 빈 글이 됐다(스펙 2026-10-19-017 P5)
        out["skill"] = {"id": skill_node["id"], "name": skill_node["label"],
                        "description": skill_desc.translate_text(skill_node["label"], raw.get("설명", ""), 240),  # i18n-ignore: flow.py 의 데이터 키
                        "path": skill_node["path"], "where": skill_node["sub"], "outline": _outline(home, skill_node["path"])}
    first_in: dict[str, dict] = {}
    for e in sub["edges"]:
        if e["to"] != root and by_id.get(e["from"], {}).get("depth", 0) >= 0:
            first_in.setdefault(e["to"], e)
    skip = {root, skill_node["id"] if skill_node else ""}
    for kind in ORDER:
        items = []
        for n in sub["nodes"]:
            if n["kind"] != kind or n["id"] in skip or n.get("depth", 0) < 0:
                continue
            e = first_in.get(n["id"]) or {"from": root, "conf": "doc", "evidence": [], "meta": {}, "kind": ""}
            ev = e["evidence"][0] if e["evidence"] else None
            items.append({"id": n["id"], "label": n["label"], "sub": n["sub"], "path": n.get("path"), "status": n.get("status"),
                          "badges": n.get("badges", []), "summary": _summary(n, nodes),
                          "by": by_id[e["from"]]["label"] if e["from"] in by_id else "", "conf": e["conf"], "rel": e["kind"],
                          "evidence": ev, "tools": e["meta"].get("tools", []), "urls": e["meta"].get("urls", [])[:2],
                          "observed": e["meta"].get("observed", 0), "link": n.get("link")})
        if items:
            out["groups"].append({"kind": kind, "title": _title(kind), "items": items})
    # 돌기 위한 조건: 자격증명·라이브러리·MCP 상태
    for n in sub["nodes"]:
        if n.get("depth", 0) < 0:
            continue
        if n["kind"] == "cred":                             # 돌아가는 데 걸리는 것만(만료·빈 값). "같은 값이 여러 곳" 같은 정리 거리는 뺀다
            why = [b for b in n.get("badges", []) if re.search("만료|비어", b)]  # i18n-ignore: 흐름 그래프의 배지(플래그)와 맞대어 보는 정규식
            if why:
                out["checks"].append({"level": "bad" if any(re.search("만료됨|비어", b) for b in why) else "warn",  # i18n-ignore: flow.py 의 데이터 키·배지와 맞대어 보는 값
                                      "text": tr(f"API 키·토큰 {n['label']}: ", f"API key or token {n['label']}: ") + ", ".join(why)})
        elif n["kind"] == "lib" and n.get("status") == "warn":
            out["checks"].append({"level": "warn", "text": tr(f"라이브러리 {n['label']} 이(가) 설치 목록에 없습니다(표준 모듈이거나 이름이 다를 수 있음).",
                                                f"Library {n['label']} is not in the install list (it may be a standard module or have a different name).")})
        elif n["kind"] == "mcp":
            where = [p for p in str(n["meta"].get("설정된 프로파일") or "").split(", ") if p]  # i18n-ignore: flow.py 의 데이터 키·배지와 맞대어 보는 값
            if profile not in where and "default" not in where:
                out["checks"].append({"level": "bad", "text": tr(f"MCP 서버 {n['label']} 이(가) {profile} 프로파일에 설정돼 있지 않습니다.",
                                                    f"MCP server {n['label']} is not configured in profile {profile}.")})
    if not any(g["kind"] in ("script", "mcp", "host") for g in out["groups"]):
        out["checks"].append({"level": "warn", "text": tr("이 스킬 문서와 스크립트에서 부르는 것을 찾지 못했습니다. AI 에이전트가 문서를 읽고 그때 판단해 도구를 씁니다.",
                                        "Nothing is called from this skill document or its scripts. The AI Agent reads the document and chooses tools at run time.")})
    out["truncated"] = sub.get("truncated", False)
    return out

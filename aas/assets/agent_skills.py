# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""AI 에이전트(프로파일)별 스킬 상태 — 스킬 화면의 에이전트 중심 보기.

스킬 그래프(skill_graph)의 줄은 이미 프로파일마다 있다(자기 스킬 + skills.external_dirs 로 가져온 공용 스킬).
여기서는 그 줄에 그 프로파일 기준의 상태를 붙인다. 읽기만 한다 — Hermes 대시보드를 부르지 않고 데이터 폴더를 읽는다:
  enabled   — config.yaml 의 skills.disabled 에 없으면 켜짐(Hermes hermes_cli/skills_config.get_disabled_skills 와 같은 규칙)
  usage     — skills/.usage.json (Hermes tools/skill_usage: use/view/patch 횟수·마지막 사용·state)
  seen      — 최근 N일 세션 기록에서 skill_view 로 연 횟수(ops/observed)
  missing   — SKILL.md 가 선언한 필수 환경변수 중 그 프로파일 .env 에 값이 없는 이름(값은 읽지 않는다)
  modes     — 어떻게 도는가: cron(예약 작업이 부름)·script(스크립트)·mcp·rest·chat(대화에서만)
  readiness — off(꺼짐) > setup(설정 필요) > unused(쓴 기록 없음) > ok
"""
from __future__ import annotations

import json
from pathlib import Path

import yaml

from . import skill_setup

MODES = ("cron", "script", "mcp", "rest", "chat")
READINESS = ("ok", "setup", "unused", "off")


def _text(path) -> str:
    try:
        return path.read_text(encoding="utf-8", errors="replace") if path.is_file() else ""
    except OSError:
        return ""


def disabled_of(config_text: str) -> set[str]:
    """config.yaml 의 skills.disabled(전역 목록). 플랫폼별 목록은 그 플랫폼에서만 꺼지므로 여기서는 보지 않는다."""
    try:
        cfg = yaml.safe_load(config_text or "")
    except yaml.YAMLError:
        return set()
    skills = cfg.get("skills") if isinstance(cfg, dict) else None
    raw = skills.get("disabled") if isinstance(skills, dict) else None
    if isinstance(raw, str):
        raw = [raw]
    return {str(x).strip() for x in raw or [] if str(x).strip()} if isinstance(raw, list) else set()


def usage_of(text: str) -> dict[str, dict]:
    try:
        doc = json.loads(text or "{}")
    except ValueError:
        return {}
    return {k: v for k, v in doc.items() if isinstance(v, dict)} if isinstance(doc, dict) else {}


def _int(v) -> int:
    try:
        return max(0, int(v or 0))
    except (TypeError, ValueError):
        return 0


class Facts:
    """프로파일 폴더 하나의 상태 근거. 프로파일마다 한 번만 읽는다."""

    def __init__(self, root: Path):
        self.disabled = disabled_of(_text(root / "config.yaml"))
        self.usage = usage_of(_text(root / "skills" / ".usage.json"))
        self.env = skill_setup.set_names(root / ".env")


def row_state(s: dict, facts: Facts, seen: int) -> dict:
    """스킬 그래프 한 줄 → 그 프로파일 기준 상태. s 는 skill_graph 의 항목(required_env·cron·scripts·mcp·rest 포함)."""
    rec = facts.usage.get(s["name"]) or {}
    count = sum(_int(rec.get(k)) for k in ("use_count", "view_count", "patch_count"))
    last = max(str(rec.get("last_used_at") or ""), str(rec.get("last_viewed_at") or ""))
    missing = [e["name"] for e in s.get("required_env") or [] if not e.get("optional") and e["name"] not in facts.env]
    modes = [m for m, on in (("cron", bool(s.get("cron"))),
                             ("script", bool(s.get("scripts") or s.get("external_scripts"))),
                             ("mcp", bool(s.get("mcp"))), ("rest", bool(s.get("rest")))) if on]
    if not modes:
        modes = ["chat"]                                       # 부르는 예약 작업도 코드도 없으면 대화에서 지시로만 쓰인다
    enabled = s["name"] not in facts.disabled
    used = count > 0 or seen > 0 or any(c.get("last_status") for c in s.get("cron") or [])
    readiness = "off" if not enabled else "setup" if missing else "ok" if used else "unused"
    return {"enabled": enabled, "uses": count, "last_used": last[:19], "seen": seen,
            "state": str(rec.get("state") or ""), "missing_env": missing, "modes": modes, "readiness": readiness}


def annotate(home: Path, profiles: list, skills: list[dict], observed: dict | None = None) -> tuple[dict[str, dict], list[dict]]:
    """skills(skill_graph 항목)의 그 프로파일 기준 상태(스킬 id → 상태)와 에이전트 요약 목록을 돌려준다.
    profiles = hermes_reader.profiles(home) 의 Profile(name, path) 목록. home 은 지금은 쓰지 않고 호출 모양만 맞춘다."""
    obs = (observed or {}).get("profiles") or {}
    facts = {p.name: Facts(p.path) for p in profiles}
    states: dict[str, dict] = {}
    for s in skills:
        f = facts.get(s["profile"])
        if f is None:
            continue
        seen = _int(((obs.get(s["profile"]) or {}).get("skills") or {}).get(s["name"]))
        states[s["id"]] = row_state(s, f, seen)
    agents = []
    for p in profiles:
        mine = [(s, states[s["id"]]) for s in skills if s["profile"] == p.name and s["id"] in states]
        bucket = obs.get(p.name) or {}
        agents.append({
            "profile": p.name,
            "skills": len(mine),
            "enabled": sum(1 for _s, st in mine if st["enabled"]),
            "setup": sum(1 for _s, st in mine if st["readiness"] == "setup"),
            "unused": sum(1 for _s, st in mine if st["readiness"] == "unused"),
            "shared": sum(1 for s, _st in mine if s.get("shared_from")),
            "cron": sum(1 for s, _st in mine if s.get("cron")),
            "runs": _int(bucket.get("runs")),
            "last_run": str(bucket.get("last") or "")[:16],
            "last_used": max((st["last_used"] for _s, st in mine), default=""),
        })
    return states, agents

# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""프로파일 한눈에 — 흩어져 있던 것(모델·채널·크론·스킬·MCP·자격증명·활동)을 프로파일 기준으로 묶는다.
읽기는 AAS 가 이미 모은 것과 Hermes 대시보드 API 의 목록을 합친다. 바꾸는 일은 server.py 가 Hermes API 로 보낸다."""
from __future__ import annotations

import re

from ..assets.files import mask_line
from ..common import config
from ..common.i18n import tr
from ..common.redact import mcp_target
from ..ops import models
from . import env_desc

NAME = re.compile(r"^[a-z0-9][a-z0-9_-]{0,40}$")
ACTIONS = {"describe", "soul", "soul_preview", "soul_revert", "agents", "agents_preview", "agents_revert", "agents_ack", "config", "config_preview", "config_revert", "model", "gateway", "skill", "toolset", "mcp", "mcp_test", "mcp_add", "mcp_remove", "mcp_catalog", "mcp_install", "mcp_docmost_write", "mcp_outline_write", "mcp_apply", "mcp_url_check", "mcp_to_oauth",
           "create", "rename", "export", "delete", "env_set", "env_clear", "channel_save", "channel_test", "pairing_approve", "pairing_revoke"}
ENV_KEY = re.compile(r"^[A-Z][A-Z0-9_]{1,63}$")


def summarize(hermes_profiles: list[dict], agents: list[dict], chan: dict, mdl: dict, health: dict, creds: list[dict],
              act: dict, mcp_cfg: dict[str, list[str]]) -> list[dict]:
    by = lambda rows, key="name": {r[key]: r for r in rows}       # noqa: E731
    ag, ch, mo, he, ac = by(agents), by(chan["profiles"]), by(mdl["profiles"]), by(health["profiles"]), by(act["profiles"])
    out = []
    for hp in hermes_profiles:
        name = hp["name"]
        a, c, m, h, v = ag.get(name, {}), ch.get(name, {}), mo.get(name, {}), he.get(name, {}), ac.get(name, {})
        mine = [x for x in creds if x["profile"] == name]
        expiring = sum(1 for x in mine if any("만료" in f for f in x["flags"]))  # i18n-ignore: 자격증명 flags 의 한글 문구와 맞대어 본다
        running = c.get("running", hp.get("gateway_running"))
        # i18n-ignore: 문제 출처 코드(UI 가 크론만 맞대어 본다)
        issues = [{"level": i["level"], "text": i["text"], "from": "채널"} for i in c.get("issues", [])]
        # i18n-ignore: 문제 출처 코드(UI 가 크론만 맞대어 본다)
        issues += [{"level": i["level"], "text": i["text"], "from": "모델"} for i in m.get("issues", [])]
        if h.get("failed_jobs"):
            issues.append({"level": "bad", "text": tr(f"마지막 실행이 실패인 예약 작업 {h['failed_jobs']}개", f"{h['failed_jobs']} scheduled jobs whose last run failed"),
                           "from": "크론"})  # i18n-ignore: UI(Home.tsx)가 맞대어 보는 값
        if expiring:
            issues.append({"level": "warn", "text": tr(f"만료됐거나 곧 만료되는 API 키·토큰 {expiring}개", f"{expiring} API keys and tokens expired or expiring soon"),
                           "from": "자격증명"})  # i18n-ignore: 문제 출처 코드
        if not hp.get("has_env") and not hp.get("is_default"):
            issues.append({"level": "warn", "text": tr("비밀값 파일(.env)이 없습니다", "No secrets file (.env)"), "from": "설정"})  # i18n-ignore: 문제 출처 코드
        out.append({
            "name": name, "title": a.get("title") or hp.get("display_name") or "", "description": hp.get("description") or a.get("description") or "",
            # 설정의 ${HERMES_LLM_MODEL} 은 서버에도 같은 값이 있으면 풀어 보인다(모델 화면과 같은 규칙, 스펙 2026-10-21-015 단계 3)
            "is_default": bool(hp.get("is_default")), "model": models._expand(hp.get("model") or ""), "provider": hp.get("provider") or "",
            "running": running, "service_disabled": bool((c.get("service") or {}).get("disabled")),
            "channels": [{"name": p["name"], "state": p.get("state"), "stale": p.get("stale"), "attention": p.get("needs_attention")}
                         for p in c.get("platforms", []) if p["name"] != "api_server"],
            "jobs_total": h.get("jobs_total", 0), "jobs_active": h.get("jobs_active", 0), "failed_jobs": h.get("failed_jobs", 0),
            "open_incidents": h.get("open_incidents", 0), "skills": hp.get("skill_count", 0), "mcp": mcp_cfg.get(name, []),
            "creds": len(mine), "creds_expiring": expiring, "sessions_7d": v.get("sessions", 0), "last_activity": v.get("last_activity"),
            "issues": issues})
    return sorted(out, key=lambda r: (not any(i["level"] == "bad" for i in r["issues"]), not r["issues"], r["is_default"], r["name"]))


def soul_view(content: str, kind: str = "") -> dict:
    """kind="agents" 면 작업 지침의 가림 규칙(주소 속 긴 조각은 두기, 스펙 2026-10-19-004 O7)."""
    lines = content.splitlines()
    masked = [mask_line(ln, kind) for ln in lines]
    return {"lines": masked, "masked_lines": [i for i, (a, b) in enumerate(zip(lines, masked), 1) if a != b]}


def toolsets_view(rows) -> list[dict]:
    rows = rows.get("toolsets", []) if isinstance(rows, dict) else rows
    return [{"name": r.get("name"), "label": r.get("label") or r.get("name"), "description": str(r.get("description") or "")[:200],
             "enabled": bool(r.get("enabled")), "configured": r.get("configured") is not False,
             "tools": len(r.get("tools") or [])} for r in rows or [] if isinstance(r, dict) and r.get("name")]


def skills_view(rows) -> list[dict]:
    rows = rows.get("skills", []) if isinstance(rows, dict) else rows
    return [{"name": r.get("name"), "description": str(r.get("description") or "")[:200], "category": r.get("category") or "",
             "enabled": bool(r.get("enabled")), "usage": r.get("usage") or 0, "provenance": r.get("provenance") or "",
             "description_full": str(r.get("description") or "")}     # 번역 키용. 응답에서는 skill_desc.apply 가 뺀다(스펙 2026-10-19-017 P5)
            for r in rows or [] if isinstance(r, dict) and r.get("name")]


def mcp_view(rows) -> list[dict]:
    """env 값은 버리고 이름만 남긴다 — 여기에 API 키가 들어 있다."""
    rows = rows.get("servers", []) if isinstance(rows, dict) else rows
    out = []
    for r in rows or []:
        if not isinstance(r, dict) or not r.get("name"):
            continue
        out.append({"name": r["name"], "transport": r.get("transport") or "", "enabled": r.get("enabled") is not False,
                    "target": mcp_target(r.get("url"), r.get("command"), r.get("args")),
                    "env_names": sorted((r.get("env") or {}).keys())[:20], "auth": r.get("auth") or ""})
    return out


_NOT_CHAT = re.compile(r"(embed|bge-|rerank|whisper|tts|stt|ocr|moderation|image|dall-e|clip)", re.I)


DEFAULT_EXCLUDE_MODELS = "cogentai-aas-aux"       # 보조 작업 전용 별칭(가드레일 제외) — 주 모델로 고르지 못하게 한다


def excluded_models() -> set[str]:
    raw = config.get_or_empty("AAS_GUARDRAIL_EXCLUDE_MODELS", DEFAULT_EXCLUDE_MODELS)
    return {m.strip() for m in raw.split(",") if m.strip()}


def chat_models(model_rows: list[dict]) -> list[str]:
    """LiteLLM 이 내놓는 AAS 모델 중 대화에 쓰는 모델만. 임베딩·음성·이미지 모델은 이름으로,
    보조 작업 전용 별칭은 AAS_GUARDRAIL_EXCLUDE_MODELS 로 걸러 낸다."""
    skip = excluded_models()
    return sorted(m["id"] for m in model_rows
                  if m.get("in_litellm") and m.get("aas_model") and m["id"] not in skip and not _NOT_CHAT.search(m["id"]))


# 「AAS 기본 모델」: 오퍼레이터가 에이전트 설정의 주 모델 칸에 적는 자리표시자. Hermes 가 실행할 때 에이전트 파드의
# 같은 이름 환경변수로 푼다. 이 값을 두면 관리자가 기본 모델을 바꿀 때 프로파일도 따라간다.
DEFAULT_MODEL_REF = "${HERMES_LLM_MODEL}"


def default_model() -> str:
    """지금 AAS 기본 모델 이름(서버 설정의 HERMES_LLM_MODEL). 모르면 빈 문자열 — 화면은 이름 없이 「AAS 기본 모델」만 보인다."""
    return config.get("HERMES_LLM_MODEL")


def model_choice_ok(model: str, choices: list[str]) -> bool:
    """주 모델로 고를 수 있는 값인가: 대화용 모델이거나, 기본 모델을 따르게 되돌리는 자리표시자."""
    return bool(model) and (model == DEFAULT_MODEL_REF or model in choices)


def gateway_shared(*, in_k8s: bool, profile: str | None) -> bool:
    """이 프로파일의 게이트웨이를 루트 게이트웨이가 함께 돌리는가. 쿠버네티스 파드(사이드카로 읽는다)의 이름 있는 프로파일이 그렇다 —
    컨테이너 안 Hermes 는 프로파일별 gateway start 를 하지 않고, 오퍼레이터가 GATEWAY_MULTIPLEX_PROFILES=true 로 루트 게이트웨이가
    모든 프로파일의 크론·채널을 맡게 한다(2026-10-14). compose·로컬은 프로파일마다 게이트웨이를 띄운다."""
    return in_k8s and profile is not None


def gateway_request(op: str, profile: str | None, *, shared: bool) -> tuple[str, dict]:
    """게이트웨이 동작을 Hermes 대시보드 요청(경로, query)으로. 함께 쓰는 프로파일은 다시 시작만 루트 게이트웨이로 보내고
    시작·멈추기는 거절한다 — Hermes 도 409 로 거절하고, 루트를 멈추면 이 에이전트의 모든 프로파일이 멈춘다."""
    if op not in ("start", "stop", "restart"):
        raise ValueError(tr("알 수 없는 요청", "Unknown request"))
    if not shared:
        return f"/api/gateway/{op}", ({"profile": profile} if profile else {})
    if op == "restart":
        return "/api/gateway/restart", {}
    raise ValueError(tr("이 프로파일의 게이트웨이는 AI 에이전트 작업공간의 기본 게이트웨이가 함께 돌립니다. 따로 시작하거나 멈출 수 없고 다시 시작만 할 수 있습니다",
                        "The AI Agent Workspace's main gateway also runs this profile. It cannot be started or stopped on its own; you can only restart it"))


def env_view(rows) -> list[dict]:
    """프로파일 .env 의 변수 목록. 값은 버린다(Hermes 가 주는 일부 가린 값도 내보내지 않는다) — 이름과 채워져 있는지만."""
    if isinstance(rows, dict) and "vars" in rows:
        rows = rows["vars"]
    items = rows.items() if isinstance(rows, dict) else [(r.get("key") or r.get("name"), r) for r in rows or [] if isinstance(r, dict)]
    out = []
    for k, v in items:
        if not (k and isinstance(v, dict)):
            continue
        desc = str(v.get("description") or "")
        row = {"name": str(k), "set": bool(v.get("is_set")), "description": desc[:160], "category": str(v.get("category") or ""),
               "channel": bool(v.get("channel_managed")), "known": not v.get("custom", False)}
        ko = env_desc.find(str(k), desc)              # 자르기 전 원문으로 찾는다(스펙 2026-10-21-003 P2)
        if ko:
            row["description"], row["description_src"] = ko[:160], desc[:160]
        out.append(row)
    return sorted(out, key=lambda r: (not r["set"], r["category"], r["name"]))

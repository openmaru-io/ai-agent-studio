# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""모델·LiteLLM 현황 — 프로파일이 쓰겠다고 적은 모델과 LiteLLM 이 실제로 내놓는 모델을 맞대 본다.

Hermes 설정에서는 모델 이름·제공자·주소만 꺼낸다. API 키는 LiteLLM 목록을 묻는 데만 메모리에서
쓰고, 저장하거나 응답에 싣지 않는다.
"""
from __future__ import annotations

import json
import os
import re
import time
import urllib.error
import urllib.request
from pathlib import Path
from urllib.parse import urlsplit

from ..common import config, netcache
from ..hermes import hermes_reader as hr
from ..common.i18n import tr
from ..common.redact import clean_url, redact

# Hermes v0.21.0 에 등록된 전송 방식(agent/transports/*.py 의 register_transport). 이 밖의 값을
# api_mode 에 적으면 get_transport() 가 None 을 돌려주고 호출이 `'NoneType' … build_kwargs` 로 죽는다.
VALID_API_MODES = {"chat_completions", "codex_responses", "anthropic_messages", "bedrock_converse"}
FALLBACK_ERROR_MARK = "build_kwargs"      # 폴백 경로가 죽을 때 Hermes 가 남기는 오류 문자열


def _env(key: str) -> str:
    return config.get(key)


def litellm_url() -> str:
    return _env("AAS_LITELLM_URL").rstrip("/")


def k8s_mode() -> bool:
    """쿠버네티스 모드(AAS_K8S_NAMESPACE)인가. 모델 화면·AI 보조가 부를 LLM 을 이것으로 가른다(스펙 2026-10-21-015 R5·D10)."""
    return bool(_env("AAS_K8S_NAMESPACE"))


def api_base() -> str:
    """OpenAI 호환 기본 주소(`/models`·`/chat/completions` 를 바로 붙이는 곳, 끝의 / 없음).
    쿠버네티스: 운영 LiteLLM(AAS_LITELLM_URL + /v1). 아니면(compose): Hermes 와 같은 HERMES_LLM_BASE_URL 을 그대로 쓴다 —
    /v1 이 아닌 주소(예: /v1beta/openai)도 있어 AAS 가 경로를 덧붙이지 않는다(R11). 그 값이 없으면 AAS_LITELLM_URL + /v1(붙기 compose)."""
    if not k8s_mode():
        base = _env("HERMES_LLM_BASE_URL").rstrip("/")
        if base:
            return base
    url = litellm_url()
    return url + "/v1" if url else ""


def _auth_headers(key: str) -> dict:
    """키가 없으면 Authorization 을 보내지 않는다(키 없는 Ollama 등)."""
    return {"Authorization": f"Bearer {key}"} if key else {}


def _missing_url() -> str:
    if k8s_mode():
        return tr("LiteLLM 주소(AAS_LITELLM_URL)가 설정되지 않았습니다", "The LiteLLM address (AAS_LITELLM_URL) is not set")
    return tr("LLM 주소(HERMES_LLM_BASE_URL 또는 AAS_LITELLM_URL)가 설정되지 않았습니다",
              "The LLM address (HERMES_LLM_BASE_URL or AAS_LITELLM_URL) is not set")


DEFAULT_MODEL_PREFIX = "cogentai-aas"


def model_prefix() -> str:
    """AAS 모델 화면에 보일 LiteLLM 모델 이름의 앞부분. 빈 값이면 거르지 않는다(compose 시험 환경의 다른 LiteLLM 용)."""
    return config.get_or_empty("AAS_LITELLM_MODEL_PREFIX", DEFAULT_MODEL_PREFIX).strip()


def is_aas_model(model: str, prefix: str | None = None) -> bool:
    prefix = model_prefix() if prefix is None else prefix
    return not prefix or model.startswith(prefix)


def _same_gateway(base_url: str) -> bool:
    """프로파일의 base_url 이 우리가 묻는 LiteLLM 과 같은 곳인가(컨테이너 안 이름 ↔ 호스트)."""
    if not base_url:
        return False
    a, b = urlsplit(base_url), urlsplit(api_base())
    host = {"host.docker.internal": "127.0.0.1", "localhost": "127.0.0.1"}
    return (host.get(a.hostname or "", a.hostname), a.port) == (host.get(b.hostname or "", b.hostname), b.port)


# 쿠버네티스 오퍼레이터가 만드는 에이전트 설정은 모델·주소를 환경변수 자리표시자로 적는다(Hermes 가 실행할 때 푼다).
# 서버에도 같은 이름의 값이 있으면 풀어서 보인다. 키(${HERMES_LLM_API_KEY})는 풀지 않는다.
_PLACEHOLDER = re.compile(r"\$\{(HERMES_LLM_MODEL|HERMES_LLM_BASE_URL)\}")


def _expand(value):
    """설정 값 안의 ${HERMES_LLM_MODEL}·${HERMES_LLM_BASE_URL} 을 서버 설정의 같은 이름 값으로 푼다. 값이 없으면 그대로 둔다."""
    if isinstance(value, str):
        return _PLACEHOLDER.sub(lambda m: config.get(m.group(1)) or m.group(0), value)
    if isinstance(value, dict):
        return {k: _expand(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_expand(v) for v in value]
    return value


def _load_yaml(path: Path) -> dict:
    import yaml                       # 모델 화면만 쓰는 의존성 — 지연 import
    try:
        data = yaml.safe_load(path.read_text(encoding="utf-8", errors="replace"))
    except Exception:
        return {}
    return _expand(data) if isinstance(data, dict) else {}


def _ref(d: dict | None) -> dict | None:
    if not isinstance(d, dict):
        return None
    model = str(d.get("model") or d.get("default") or "").strip()
    if not model:
        return None
    return {"model": model, "provider": str(d.get("provider") or ""),
            "base_url": clean_url(str(d.get("base_url") or "")) if d.get("base_url") else "",
            "api_mode": str(d.get("api_mode") or "")}


def _profile_config(prof: hr.Profile) -> tuple[dict, str]:
    """(필요한 값만 추린 설정, LiteLLM 용 키). 키는 호출자가 메모리에서만 쓴다."""
    cfg = _load_yaml(prof.path / "config.yaml")
    if not cfg:
        return {"has_config": False}, ""
    fallbacks = cfg.get("fallback_providers") or []
    if isinstance(fallbacks, dict):
        fallbacks = [fallbacks]
    declared, key = [], ""
    for name, p in (cfg.get("providers") or {}).items():
        if not isinstance(p, dict):
            continue
        declared.append({"provider": str(name),
                         "base_url": clean_url(str(p.get("base_url") or "")) if p.get("base_url") else "",
                         "models": [str(m) for m in (p.get("models") or []) if m]})
        raw = str(p.get("api_key") or "")
        if not key and raw and "${" not in raw and _same_gateway(str(p.get("base_url") or "")):
            key = raw
    aux = []
    for task, a in (cfg.get("auxiliary") or {}).items():
        if isinstance(a, dict) and str(a.get("model") or "").strip():
            aux.append({"task": str(task), **(_ref(a) or {})})
    return {"has_config": True, "primary": _ref(cfg.get("model")),
            "fallbacks": [r for r in (_ref(f) for f in fallbacks) if r],
            "declared": declared, "auxiliary": aux}, key


def fetch_litellm(key: str, key_source: str) -> dict:
    k8s = k8s_mode()
    out = {"url": litellm_url() if k8s else api_base(), "reachable": False, "auth": "no_key", "key_source": key_source,
           "prefix": model_prefix(), "models": [], "all_models": [], "hidden": 0, "error": ""}
    if not out["url"]:
        out["error"] = _missing_url()
        return out
    if k8s:
        # 쿠버네티스: 운영 LiteLLM. 살아 있는지(LiteLLM 전용 /health/liveliness) 먼저 보고, 목록은 키가 있어야 묻는다(지금까지 동작)
        try:
            with netcache.urlopen(out["url"] + "/health/liveliness", timeout=5):
                out["reachable"] = True
        except Exception as exc:
            out["error"] = tr(f"LiteLLM 에 연결할 수 없습니다: {type(exc).__name__}", f"Cannot reach LiteLLM: {type(exc).__name__}")
            return out
        if not key:
            out["error"] = tr("모델 목록을 조회할 키가 없습니다", "There is no key to query the model list")
            return out
    # compose: 어떤 OpenAI 호환 서버(Ollama·OpenAI·LiteLLM)인지 모르므로 liveliness 없이 /models 를 바로, 키가 없어도 묻는다(R5)
    req = urllib.request.Request(api_base() + "/models", headers=_auth_headers(key))
    try:
        with netcache.urlopen(req, timeout=10) as resp:
            data = json.loads(resp.read())
        out["reachable"] = True
        # 판정(known·in_litellm)은 거르기 전 목록으로, 화면 목록·개수는 거른 목록으로 한다.
        # 보조 작업 전용 별칭(가드레일 없이 부르는 길, AAS_GUARDRAIL_EXCLUDE_MODELS)도 숨긴다. 프로파일이 쓰면 사용 중인 행으로 남는다.
        from ..fleet.profiles import excluded_models
        skip = excluded_models() if out["prefix"] else set()
        out["all_models"] = sorted({str(m.get("id")) for m in data.get("data", []) if m.get("id")})
        out["models"] = [m for m in out["all_models"] if is_aas_model(m, out["prefix"]) and m not in skip]
        out["hidden"] = len(out["all_models"]) - len(out["models"])
        out["auth"] = "ok"
    except urllib.error.HTTPError as exc:
        out["reachable"] = True
        if exc.code in (401, 403):
            setting = key_source if key_source in ("AAS_LITELLM_KEY", "HERMES_LLM_API_KEY") else \
                ("AAS_LITELLM_KEY" if k8s else "HERMES_LLM_API_KEY")
            out["auth"], out["error"] = "rejected", tr(f"키가 거절됐습니다({setting} 확인, HTTP {exc.code})",
                                                       f"The key was rejected (check {setting}, HTTP {exc.code})")
        else:
            out["error"] = tr(f"모델 목록 조회 실패: HTTP {exc.code}", f"Could not list models: HTTP {exc.code}")
    except Exception as exc:
        if k8s:
            out["error"] = tr(f"모델 목록 조회 실패: {type(exc).__name__}", f"Could not list models: {type(exc).__name__}")
        else:
            out["error"] = tr(f"LLM 서버에 연결할 수 없습니다: {type(exc).__name__}", f"Cannot reach the LLM server: {type(exc).__name__}")
    return out


def server_llm_key() -> tuple[str, str]:
    """서버가 아는 LiteLLM 키와 그 출처 이름. 없으면 ("", "").
    자격증명 현황표가 AAS 가 프로파일 `.env` 에 넣은 같은 키를 알아보는 데도 쓴다(스펙 2026-10-28-006 R10)."""
    own = _env("AAS_LITELLM_KEY")
    if own:
        return own, "AAS_LITELLM_KEY"
    if not k8s_mode() and _env("HERMES_LLM_API_KEY"):     # compose: Hermes 와 같은 .env 값(R6, 새 이름을 만들지 않는다)
        return _env("HERMES_LLM_API_KEY"), "HERMES_LLM_API_KEY"
    return "", ""


def _resolve_key(hermes_key: str) -> tuple[str, str]:
    key, source = server_llm_key()
    if key:
        return key, source
    if hermes_key:
        return hermes_key, tr("프로파일 설정", "Profile config")
    return "", ""


def collect(health: dict | None = None, home=None) -> dict:
    profiles, hermes_key = [], ""
    for prof in hr.profiles(home):
        cfg, key = _profile_config(prof)
        hermes_key = hermes_key or key
        try:
            jobs = hr.read_jobs(prof) or []
        except Exception:
            jobs = []
        cron_models = {}
        for j in jobs:
            m = str(j.get("model") or "").strip()
            if m and j.get("enabled", True):
                cron_models.setdefault(m, []).append(str(j.get("name") or j.get("id")))
        profiles.append({"name": prof.name, **cfg,
                         "cron_overrides": [{"model": m, "jobs": js} for m, js in sorted(cron_models.items())],
                         "jobs_active": sum(1 for j in jobs if j.get("enabled", True)), "issues": []})
    key, source = _resolve_key(hermes_key)
    gw = fetch_litellm(key, source)
    known = set(gw.get("all_models") or gw["models"]) if gw["auth"] == "ok" else None
    prefix = gw.get("prefix", model_prefix())

    traces: dict[str, list[str]] = {}
    for row in (health or {}).get("failed_jobs", []) + (health or {}).get("incidents", []):
        if FALLBACK_ERROR_MARK in (row.get("error") or ""):
            jobs_ = traces.setdefault(row["profile"], [])
            if row["job"] not in jobs_:
                jobs_.append(row["job"])

    usage: dict[str, dict] = {}

    def use(model: str, role: str, name: str):
        usage.setdefault(model, {"primary": [], "fallback": [], "auxiliary": [], "cron": []})[role].append(name)

    def check(p: dict, ref: dict | None, label: str, level: str = "bad"):
        if ref and known is not None and _same_gateway(ref.get("base_url") or (p.get("primary") or {}).get("base_url", "")) \
                and ref["model"] not in known:
            p["issues"].append({"level": level, "text": tr(f"{label} 모델 `{ref['model']}` 이 LiteLLM 목록에 없음",
                                         f"{label} model `{ref['model']}` is not in the LiteLLM list")})

    for p in profiles:
        if not p.get("has_config"):
            if p["name"] != "default" or p["jobs_active"]:
                p["issues"].append({"level": "warn", "text": tr("config.yaml 을 읽지 못함", "Cannot read config.yaml")})
            continue
        prim = p.get("primary")
        if not prim:
            p["issues"].append({"level": "warn", "text": tr("주 모델이 설정에 없음(Hermes 기본값 사용)", "No primary model in the config (the Hermes default is used)")})
        else:
            use(prim["model"], "primary", p["name"])
            check(p, prim, tr("주", "Primary"))
        # 폴백이 없는 것은 문제로 치지 않는다(2026-10-04 결정): 주 모델과 폴백이 같은 LiteLLM 을
        # 보므로 Hermes 쪽 폴백은 보호가 안 되고, 모델 이중화는 LiteLLM 에서 한다.
        if prim and prim.get("api_mode") and prim["api_mode"] not in VALID_API_MODES:
            p["issues"].append({"level": "bad", "text": tr(f"주 모델의 api_mode `{prim['api_mode']}` 는 Hermes 에 없는 전송 방식",
                                                                         f"The api_mode `{prim['api_mode']}` of the primary model is not a transport Hermes supports")})
        for f in p["fallbacks"]:
            use(f["model"], "fallback", p["name"])
            check(p, f, tr("폴백", "Fallback"))
            if f.get("api_mode") and f["api_mode"] not in VALID_API_MODES:
                p["issues"].append({"level": "bad", "text": tr(f"폴백의 api_mode `{f['api_mode']}` 는 Hermes 에 없는 전송 방식 "
                                                 f"(유효: {', '.join(sorted(VALID_API_MODES))}) — 폴백이 호출되면 `build_kwargs` 오류로 죽는다",
                                                 f"The api_mode `{f['api_mode']}` of the fallback is not a transport Hermes supports "
                                                 f"(valid: {', '.join(sorted(VALID_API_MODES))}). Calling the fallback fails with a `build_kwargs` error")})
            if prim and f["model"] == prim["model"] and f.get("base_url") == prim.get("base_url"):
                p["issues"].append({"level": "warn", "text": tr("폴백이 주 모델과 같음", "The fallback is the same as the primary model")})
        for a in p["auxiliary"]:
            use(a["model"], "auxiliary", f"{p['name']}:{a['task']}")
            check(p, a, tr(f"보조({a['task']})", f"Auxiliary ({a['task']})"), "warn")
        for c in p["cron_overrides"]:
            use(c["model"], "cron", tr(f"{p['name']} ({len(c['jobs'])}개 작업)", f"{p['name']} ({len(c['jobs'])} jobs)"))
            check(p, {"model": c["model"], "base_url": (prim or {}).get("base_url", "")}, tr("예약 작업 지정", "Scheduled job override"))
        outside = []
        for ref in [prim, *p["fallbacks"], *p["auxiliary"]] + [{"model": c["model"]} for c in p["cron_overrides"]]:
            if ref and not is_aas_model(ref["model"], prefix) and ref["model"] not in outside \
                    and _same_gateway(ref.get("base_url") or (prim or {}).get("base_url", "")):
                outside.append(ref["model"])
        for m in outside:
            p["issues"].append({"level": "warn", "text": tr(f"AAS 모델이 아닌 `{m}` 을 씀 — 가드레일이 적용되지 않고, AAS 전용 키로 바꾸면 거부된다",
                                                             f"Uses `{m}`, which is not an AAS model. The guardrail does not apply, and the AAS-only key rejects it")})
        if known is not None:
            stale = sorted({m for d in p["declared"] if _same_gateway(d["base_url"]) for m in d["models"]} - known)
            if stale:
                p["issues"].append({"level": "warn", "text": tr("제공자 목록에 적혀 있으나 LiteLLM 에 없는 모델: ", "Models listed for the provider but missing in LiteLLM: ") + ", ".join(stale)})
        if p["name"] in traces:
            jobs_txt = ", ".join(traces[p["name"]][:4])
            if p["fallbacks"]:
                p["issues"].append({"level": "bad", "text": tr("폴백 경로 오류 흔적 — `build_kwargs` 로 죽은 작업: ", "Fallback path error found. Jobs that died with `build_kwargs`: ") + jobs_txt})
            else:   # 폴백은 이미 비웠다 — 남은 것은 지난 실행의 기록이고 다음 실행에서 사라져야 한다
                p["issues"].append({"level": "warn", "text": tr("지난 실행에 남은 폴백 오류 기록(폴백은 제거됨, 다음 실행에서 사라지는지 확인): ",
                                                 "Fallback error left from a previous run (the fallback was removed; "
                                                 "check that it disappears on the next run): ") + jobs_txt})
    models = [{"id": m, "in_litellm": True, "aas_model": is_aas_model(m, prefix),
               **usage.get(m, {"primary": [], "fallback": [], "auxiliary": [], "cron": []})}
              for m in gw["models"]]
    # 거른 목록 밖이라도 프로파일이 쓰는 모델은 행으로 남긴다(접두어 밖이면 aas_model false).
    # 단, 보조 작업 전용 별칭(AAS_GUARDRAIL_EXCLUDE_MODELS)은 프로파일이 써도 행으로 만들지 않는다: 새 사용자의 시드 설정이
    # 보조 작업을 이 별칭으로 보내서 「사용하지 않음」 행이 남았다(OMAI-1269). 프로파일의 보조 작업 정보(p["auxiliary"])는 그대로다.
    from ..fleet.profiles import excluded_models
    skip = excluded_models() if prefix else set()
    models += [{"id": m, "in_litellm": (m in known) if known is not None else None, "aas_model": is_aas_model(m, prefix), **u}
               for m, u in sorted(usage.items()) if m not in set(gw["models"]) and m not in skip]
    from ..fleet.profiles import default_model
    return {"collected_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"), "litellm": gw, "models": models,
            "profiles": profiles, "default_model": default_model(),     # 화면의 「기본 모델」 뱃지(2026-10-18)
            "totals": {"litellm_models": len(gw["models"]),
                       "profiles_with_bad": sum(1 for p in profiles if any(i["level"] == "bad" for i in p["issues"])),
                       "profiles_with_warn": sum(1 for p in profiles if p["issues"]),
                       "fallback_trace_jobs": sum(len(v) for v in traces.values()),
                       "unused_models": sum(1 for m in models if m["in_litellm"] and not any(m[k] for k in ("primary", "fallback", "auxiliary", "cron")))}}


def probe(model: str, home=None) -> dict:
    """모델 하나에 1토큰짜리 호출을 보내 실제로 답하는지 본다. 사용자가 누를 때만 부른다."""
    hermes_key = ""
    for prof in hr.profiles(home):
        hermes_key = hermes_key or _profile_config(prof)[1]
    key, _ = _resolve_key(hermes_key)
    if not api_base():
        return {"model": model, "ok": False, "error": _missing_url()}
    if not key and k8s_mode():
        return {"model": model, "ok": False, "error": tr("키가 없습니다", "No key")}
    body = json.dumps({"model": model, "messages": [{"role": "user", "content": "ping"}],
                       "max_tokens": 1}).encode()
    req = urllib.request.Request(api_base() + "/chat/completions", data=body,
                                 headers={**_auth_headers(key), "Content-Type": "application/json"})
    t0 = time.time()
    try:
        with netcache.urlopen(req, timeout=60) as resp:
            json.loads(resp.read())
        return {"model": model, "ok": True, "ms": int((time.time() - t0) * 1000)}
    except urllib.error.HTTPError as exc:
        try:
            detail = json.loads(exc.read()).get("error", {}).get("message", "")
        except Exception:
            detail = ""
        return {"model": model, "ok": False, "ms": int((time.time() - t0) * 1000),
                "error": redact(f"HTTP {exc.code} {detail}", 240)}
    except Exception as exc:
        return {"model": model, "ok": False, "ms": int((time.time() - t0) * 1000),
                "error": f"{type(exc).__name__}"}

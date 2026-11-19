# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""프로파일 템플릿 목록과 상세(스펙 2026-11-18-002 §4-2 1·2). 「템플릿에서」 탭이 읽는다.

템플릿 = agent/distribution.yaml 에 aas.template: 1 이 있는 에이전트 패키지. 허브 목록에는 종류가 없어, 패키지마다 파일 목록을
한 번 보고 에이전트 패키지면 묶음을 받아 매니페스트·설정을 읽는다. 결과는 (패키지, 판)마다 기억한다 — 같은 판의 내용은 바뀌지 않는다.
상세는 동의 해시(서버 계산, §4-5)·SOUL·AGENTS·예약 작업 원문을 함께 돌려준다. 값(비밀값)은 담지 않는다 — 템플릿에 값이 없다.
"""
from __future__ import annotations

import json
import tempfile
import threading
from pathlib import Path

import yaml

from ..assets import skill_setup
from . import market_stage, marketplace, template_checks
from .marketplace import AGENT_MANIFEST, MarketError

_LOCK = threading.Lock()
_KIND: dict[str, bool] = {}                 # "ns/name@ver" → 에이전트 패키지인가
_DETAIL: dict[str, dict | None] = {}        # "ns/name@ver" → 템플릿 상세(템플릿이 아니면 None)
MAX_TEXT = 20000


def _key(ns: str, name: str, version: str) -> str:
    return f"{ns}/{name}@{version}"


def _is_agent(ns: str, name: str, version: str, cfg: dict) -> bool:
    key = _key(ns, name, version)
    with _LOCK:
        if key in _KIND:
            return _KIND[key]
    files = marketplace.fetch(f"/api/v1/skills/{ns}/{name}/versions/{version}/files", cfg)
    files = files if isinstance(files, list) else files.get("items", [])
    agent = any(str(f.get("filePath") or "") == AGENT_MANIFEST for f in files)
    with _LOCK:
        _KIND[key] = agent
    return agent


def _text(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8")[:MAX_TEXT] if path.is_file() else ""
    except (OSError, UnicodeDecodeError):
        return ""


def _read(ns: str, name: str, version: str) -> dict | None:
    """묶음을 받아 템플릿 상세를 만든다. 템플릿이 아니면 None. 받기 실패는 MarketError(502)."""
    with tempfile.TemporaryDirectory(prefix="aas-template-") as tmp:
        pkg = Path(tmp) / "pkg"
        pkg.mkdir()
        try:
            market_stage.download({"namespace": ns, "name": name, "version": version}, pkg)
        except market_stage.Refuse as exc:
            raise MarketError(str(exc), 502) from None
        src = pkg / "agent"
        try:
            manifest = yaml.safe_load(_text(src / "distribution.yaml") or "") or {}
        except yaml.YAMLError:
            return None
        if not market_stage.is_template(manifest):
            return None
        try:
            cfg = yaml.safe_load(_text(src / "config.yaml") or "") or {}
        except yaml.YAMLError:
            cfg = {}
        servers = template_checks.mcp_servers_of(cfg if isinstance(cfg, dict) else {})
        # 이미 게시된 템플릿의 LLM 접속값(AAS 가 준다)은 묻지 않는다(스펙 2026-11-19-002 §4-2 #9)
        env = [e for e in manifest.get("env_requires") or [] if isinstance(e, dict) and e.get("name") and not skill_setup.is_aas_managed(str(e["name"]))]
        mcp = []
        for sname, spec in sorted(servers.items()):
            if not isinstance(spec, dict):
                continue
            row = {"name": str(sname), "keys": sorted(template_checks.refs(spec)), "stdio": bool(spec.get("command")) and not spec.get("url")}
            if row["stdio"]:
                args = [str(a) for a in spec.get("args") or []]
                row.update(command=str(spec["command"]), args=args, consent_hash=template_checks.consent_hash(spec["command"], args),
                           problem=template_checks.stdio_problem(spec["command"], args))
            else:
                row["url"] = str(spec.get("url") or "")[:500]
            mcp.append(row)
        try:
            jobs = json.loads(_text(src / "cron" / "jobs.json") or "[]")
        except ValueError:
            jobs = []
        jobs = jobs.get("jobs", []) if isinstance(jobs, dict) else jobs
        cron = [{"name": str(j.get("name") or j.get("id") or "")[:120], "schedule": str(j.get("schedule") or j.get("cron") or "")[:120],
                 "prompt": str(j.get("prompt") or "")[:4000], "script": str(j.get("script") or "")[:4000]}
                for j in jobs if isinstance(j, dict)]
        aas = manifest.get("aas") if isinstance(manifest.get("aas"), dict) else {}
        skills = market_stage._agent_skill_folders(pkg)
        files = [p.relative_to(pkg / "template" / "files").as_posix() for p in sorted((pkg / "template" / "files").rglob("*")) if p.is_file()] \
            if (pkg / "template" / "files").is_dir() else []
        return {"id": f"{ns}/{name}", "namespace": ns, "name": name, "version": version, "public": ns in template_checks.PUBLIC_NAMESPACES,
                "description": str(manifest.get("description") or "")[:400], "author": str(manifest.get("author") or "")[:120],
                "env_requires": [{"name": str(e["name"]), "description": str(e.get("description") or "")[:300], "required": e.get("required") is not False,
                                  "used_by": [str(u) for u in e.get("used_by") or []][:20]} for e in env],
                "mcp": mcp, "mcp_servers": servers, "skills": len(skills), "hub_skills": [h for h in aas.get("hub_skills") or [] if isinstance(h, dict)][:50],
                "cron": cron, "files": files[:template_checks.MAX_TEMPLATE_FILES], "model_hint": "" if "${" in str(aas.get("model_hint") or "") else str(aas.get("model_hint") or "")[:120],
                "examples": [str(x)[:200] for x in aas.get("examples") or []][:5],
                "soul": _text(src / "SOUL.md"), "agents": _text(pkg / "template" / "AGENTS.md"), "readme": _text(src / "README.md")}


def detail(ns: str, name: str, version: str = "", cfg: dict | None = None) -> dict:
    """템플릿 상세. 템플릿이 아니면 MarketError(404). version 이 비면 공개된 마지막 판."""
    cfg = cfg or marketplace.settings()
    ns = marketplace.ns_slug(ns, cfg)
    if not (marketplace.NAME.match(ns) and marketplace.NAME.match(name)) or ns not in cfg["namespaces"]:
        raise MarketError("템플릿 이름이 올바르지 않습니다", 400)  # i18n-ignore: 화면이 코드로 문구를 고른다
    if not version:
        info = marketplace.fetch(f"/api/v1/skills/{ns}/{name}", cfg)
        version = str((info.get("publishedVersion") or {}).get("version") or "")
        if not version:
            raise MarketError("공개된 판이 없습니다", 404)  # i18n-ignore: 화면이 코드로 문구를 고른다
    key = _key(ns, name, version)
    with _LOCK:
        cached = _DETAIL.get(key, "miss")
    if cached == "miss":
        cached = _read(ns, name, version)
        with _LOCK:
            _DETAIL[key] = cached
    if cached is None:
        raise MarketError("템플릿이 아닌 패키지입니다", 404, reason="not_template")  # i18n-ignore: 화면이 코드로 문구를 고른다
    return dict(cached)


CARD_FIELDS = ("id", "namespace", "name", "version", "public", "description", "author", "env_requires", "skills", "hub_skills", "model_hint", "examples")


def card(d: dict) -> dict:
    """목록 카드에 보일 것(원문은 빼고 개수·이름만)."""
    out = {k: d[k] for k in CARD_FIELDS}
    out.update(mcp=[{k: m[k] for k in ("name", "url", "stdio") if k in m} for m in d["mcp"]], cron=len(d["cron"]), files=len(d["files"]))
    return out


def listing(items: list[dict], cfg: dict | None = None) -> dict:
    """허브 목록(catalog 결과)에서 템플릿만 카드로. 패키지 하나를 읽지 못해도 나머지는 보인다 — 못 읽은 수를 함께 돌려준다."""
    cfg = cfg or marketplace.settings()
    out, failed = [], 0
    for it in items:
        if it.get("namespace") not in cfg["namespaces"]:
            continue                                   # 미러(공개 스킬)에는 템플릿을 두지 않는다
        try:
            if not _is_agent(it["namespace"], it["name"], it["version"], cfg):
                continue
            d = detail(it["namespace"], it["name"], it["version"], cfg)
        except MarketError as exc:
            if exc.code != 404:
                failed += 1
            continue
        out.append({**card(d), "summary": it.get("summary") or "", "owner": it.get("owner") or "", "tags": it.get("tags") or [], "restricted": it.get("restricted")})
    return {"items": out, "failed": failed}

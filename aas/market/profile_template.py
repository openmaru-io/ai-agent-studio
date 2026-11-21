# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""프로파일을 템플릿(스킬 허브 에이전트 패키지)으로 묶고 게시한다(스펙 2026-11-18-002 §4-1, 2단계).

  묶기     build — 프로파일 폴더를 읽어 SKILL.md·agent/{distribution.yaml, SOUL.md, README.md, config.yaml, cron/jobs.json, skills/…} 를 만든다.
           config 는 허용 키(도구 묶음·스킬 켜기/끄기·mcp_servers)만, MCP 의 env·headers 값은 ${KEY} 로 바꾼다. 예약 작업은 남길 필드만 골라 꺼 둔다.
           직접 만든·고친 스킬만 넣고, 허브에서 받은 스킬은 aas.hub_skills 에 이름·판만 적는다. .env 값·auth·채널·memories·sessions 는 읽지 않는다.
  검사     설치 때와 같은 template_checks.check + 비밀값(글 파일 전부) + 사내 주소(공용 구역 거절·제한 구역 경고) + 공용 구역 의심 문구 경고.
  게시     publish — dry_run 이면 미리 보기만. 아니면 사람마다 하루 한도(잠금 안에서 세고 기록), 같은 이름이면 내 것만 새 판, 묶음 보관 뒤 바로 허브에 게시
           (승인 없음, D2). 관리자 받은편지함에 「새 템플릿」 알림을 남긴다(승인이 아니다).
"""
from __future__ import annotations

import fcntl
import hashlib
import io
import json
import re
import secrets
import tarfile
from contextlib import contextmanager
from datetime import datetime, timedelta

from pathlib import Path, PurePosixPath

import yaml

from ..assets import files as asset_files, skill_origin, skill_setup
from ..common import config, store
from ..common.i18n import tr
from . import market_publish as mp, marketplace, skill_keep, template_checks
from .marketplace import NAME, MarketError

KIND = "template"
SUSPICIOUS = re.compile(r"\.env\b|auth\.json|\bcurl\s|\bwget\s|base64|/opt/data", re.I)   # 공용 구역 게시의 의심 문구(경고만, E3)
CRON_KEEP = ("id", "name", "prompt", "skills", "skill", "script", "no_agent", "schedule", "schedule_display", "enabled_toolsets")
SECRET_HEADER = re.compile(r"^(Bearer\s+|Basic\s+|Token\s+)?(.+)$", re.I)


class TemplateError(MarketError):
    """막는 오류. code 는 HTTP 상태, reason 은 §4-5 의 오류 코드."""


# §4-5 오류 코드 → 고칠 일(fix). 문제 본문(RFC 9457)의 type 은 이 표의 위치, fix 는 사람·에이전트가 할 일이다
FIX = {
    "name_taken": lambda: tr("다른 이름을 쓰세요", "Use another name"),
    "profile_limit": lambda: tr("쓰지 않는 프로파일을 지우세요", "Delete a profile you do not use"),
    "pending": lambda: tr("진행 중인 요청이 끝나기를 기다리세요", "Wait for the request in progress to finish"),
    "consent_required": lambda: tr("설치 화면에서 명령 실행 MCP 에 동의하세요", "Agree to the command MCP servers on the install screen"),
    "consent_mismatch": lambda: tr("AI 에이전트 템플릿이 바뀌었습니다. 확인 단계를 다시 열어 동의하세요", "The AI Agent template changed. Open the review step and agree again"),
    "env_ref_blocked": lambda: tr("그 이름을 참조하는 MCP·예약 작업을 빼거나 고치세요", "Remove or fix the MCP server or cron job that refers to that name"),
    "env_ref_host": lambda: tr("MCP 주소의 호스트를 고정하세요", "Fix the host part of the MCP address"),
    "stdio_unpinned": lambda: tr("명령의 패키지 판을 고정하세요(pkg@1.2.3, pkg==1.2.3)", "Pin the package version in the command (pkg@1.2.3, pkg==1.2.3)"),
    "stdio_public": lambda: tr("제한 구역으로 올리거나 명령 실행 MCP 를 빼세요", "Publish to the restricted zone or leave out command MCP servers"),
    "secret_found": lambda: tr("파일·줄에 든 비밀값을 지우세요", "Remove the secret from that file or line"),
    "internal_ref": lambda: tr("사내 주소를 지우거나 제한 구역으로 올리세요", "Remove internal addresses or publish to the restricted zone"),
    "publish_daily_limit": lambda: tr("24시간 뒤 다시 올리세요(설정 AAS_TEMPLATE_DAILY_LIMIT)", "Publish again after 24 hours (setting AAS_TEMPLATE_DAILY_LIMIT)"),
    "agents_too_long": lambda: tr("작업 지침을 20,000자 안으로 줄이거나 빼세요", "Shorten the work instructions below 20,000 characters or leave them out"),
    "file_path": lambda: tr("작업 폴더 안의 일반 파일을 고르세요", "Choose a regular file inside the workspace"),
    "too_big": lambda: tr("스킬이나 예약 작업을 빼세요", "Leave out some skills or cron jobs"),
}


def problem(exc: MarketError) -> dict:
    """RFC 9457 꼴 본문 칸(type·title·status·detail) + code·fix. 비밀값은 담지 않는다(검사 문장에는 파일·줄만 있다)."""
    code = str(getattr(exc, "reason", "") or "")
    fix = FIX.get(code)
    return {"type": f"/docs/errors/template#{code or 'error'}", "title": code or "error", "status": getattr(exc, "code", 400),
            "detail": str(exc), "code": code, **({"fix": fix()} if fix else {})}


def daily_limit() -> int:
    try:
        return max(1, int(config.get("AAS_TEMPLATE_DAILY_LIMIT", "10")))
    except ValueError:
        return 10


# ---- 읽기 -------------------------------------------------------------------------------------------------

def _read(path) -> str:
    try:
        return path.read_text(encoding="utf-8") if path.is_file() else ""
    except (OSError, UnicodeDecodeError):
        return ""


def _secret_like(text: str) -> bool:
    return bool(mp.SECRET.search(text or "")) or asset_files.has_secrets(text or "")


def _env_key(*parts: str) -> str:
    return re.sub(r"[^A-Z0-9_]+", "_", "_".join(parts).upper()).strip("_")[:63] or "MCP_KEY"


def template_mcp(name: str, spec: dict, add_env) -> tuple[dict, list[str]]:
    """MCP 항목 하나를 템플릿용으로: env·headers 의 값(이미 ${…} 인 것은 그대로)을 ${KEY} 로 바꾼다. 돌려주는 값: (항목, 막는 사유들)."""
    out, errors = json.loads(json.dumps(spec)), []
    env = out.get("env") if isinstance(out.get("env"), dict) else None
    for k, v in list((env or {}).items()):
        if isinstance(v, str) and not template_checks.REF.fullmatch(v.strip()):
            key = str(k) if template_checks.ENV_NAME.match(str(k)) else _env_key("MCP", name, str(k))
            env[k] = "${" + key + "}"
        for ref in template_checks.refs(env[k]):
            add_env(ref, f"mcp:{name}")
    headers = out.get("headers") if isinstance(out.get("headers"), dict) else None
    for h, v in list((headers or {}).items()):
        if not isinstance(v, str):
            continue
        if not template_checks.refs(v):
            m = SECRET_HEADER.match(v.strip())
            key = _env_key("MCP", name, str(h))
            headers[h] = (m.group(1) or "") + "${" + key + "}" if m else "${" + key + "}"
        for ref in template_checks.refs(headers[h]):
            add_env(ref, f"mcp:{name}")
    for ref in template_checks.refs(out.get("url") or ""):
        add_env(ref, f"mcp:{name}")
    if any(_secret_like(str(a)) for a in out.get("args") or []):
        errors.append(tr(f"MCP {name} 의 인자에 비밀값으로 보이는 값이 있습니다 — 값은 env 로 옮기세요", f"MCP {name} has a secret-looking argument. Move the value to env"))
    if isinstance(out.get("url"), str) and _secret_like(out["url"]):
        errors.append(tr(f"MCP {name} 의 주소에 비밀값으로 보이는 값이 있습니다 — 주소의 키는 ${{KEY}} 로 바꾸세요", f"MCP {name} has a secret in its URL. Replace it with ${{KEY}}"))
    return out, errors


def _skills(pod_id: str, root, profile: str) -> list[dict]:
    """프로파일의 스킬 폴더마다 {rel, name, origin, package?}. 허브 설치 기록이 있으면 package·version·restricted."""
    facts = skill_origin.Facts(root)
    have = {r["name"]: r for r in marketplace.installed(pod_id) if r["profile"] == profile and r.get("kind") == "skill"}
    out = []
    base = root / "skills"
    if not base.is_dir():
        return out
    seen: list[str] = []
    from ..hermes.readers import remote
    skip = frozenset(skill_keep.RUNTIME_DIRS) | skill_keep.dependency_names()   # .deps 안을 사이드카에 묻지 않는다(스펙 2026-11-18-019 R8)
    for md in sorted(remote.search_rglob(base, "SKILL.md", skip), key=lambda f: (len(f.parts), str(f))):
        rel = md.parent.relative_to(root).as_posix()
        if any(part.startswith(".") for part in md.parent.relative_to(base).parts) or any(rel.startswith(s + "/") for s in seen):
            continue
        seen.append(rel)
        name = skill_keep.skill_name(md.parent)
        origin = skill_origin.origin(facts, name, rel, md.parent)
        row = {"rel": rel, "name": name, "origin": origin}
        if origin == "market":
            rec = have.get(rel.rsplit("/", 1)[-1])
            if rec:
                row.update(package=rec["package"], namespace=rec["namespace"], pkg_name=rec["name"], version=str(rec["version"]))
        out.append(row)
    return out


def _jobs(text: str) -> list[dict]:
    try:
        doc = json.loads(text or "[]")
    except ValueError:
        return []
    jobs = doc.get("jobs", []) if isinstance(doc, dict) else doc
    return [j for j in jobs if isinstance(j, dict)]


def template_job(job: dict) -> dict:
    """남길 필드만(§4-1 R9): 받는 곳·모델·작업 폴더·실행 상태는 지우고 꺼 둔다. deliver 는 local — 비우면 origin 으로 돌아간다."""
    out = {k: job[k] for k in CRON_KEEP if k in job and job[k] not in (None, "", [])}
    out.update(enabled=False, state="paused", deliver="local", repeat={"times": (job.get("repeat") or {}).get("times"), "completed": 0},
               paused_reason="템플릿에서 꺼진 채로 만들었습니다")  # i18n-ignore: Hermes 예약 작업에 저장되는 문장
    return out


# ---- 묶기 -------------------------------------------------------------------------------------------------

def build(pod_id: str, home, profile: str, *, name: str, description: str, namespace: str, author: str, version: str = "1.0.0",
          choices: dict | None = None, tags: list[str] | None = None, soul_override: str | None = None, model_hint: str = "",
          agents: bool | None = None, ref_files: list[dict] | None = None, who: str = "", examples: list[str] | None = None,
          allow_internal: bool = False, key_notes: dict[str, str] | None = None) -> dict:
    """묶음과 미리 보기. key_notes 는 올리는 사람이 적은 KEY 설명(이름 → 한 줄) — 받는 사람의 KEY 칸 아래에 보인다. 돌려주는 값: {files: [(경로, 바이트)], items, env_requires, hub_skills, errors, warnings, stdio, model_hint}.
    choices = {"skills": [rel…], "mcp": [이름…], "cron": [id…]} — 없는 칸은 모두 담는다."""
    root = skill_keep.profile_root(home, profile)
    choices = choices or {}
    errors: list[dict] = []
    warnings: list[dict] = []
    env: dict[str, dict] = {}

    def err(code: str, message: str, **extra) -> None:
        errors.append({"code": code, "message": message, **extra})

    def add_env(key: str, used_by: str) -> None:
        row = env.setdefault(key, {"name": key, "description": "", "required": True, "used_by": []})
        if used_by not in row["used_by"]:
            row["used_by"].append(used_by)

    soul = soul_override if soul_override is not None else _read(root / "SOUL.md")
    if not soul.strip():
        err("soul_missing", tr("SOUL 이 비어 있습니다", "SOUL is empty"))
    try:
        cfg = yaml.safe_load(_read(root / "config.yaml") or "") or {}
    except yaml.YAMLError:
        cfg = {}
    cfg = cfg if isinstance(cfg, dict) else {}
    model = cfg.get("model")
    if not model_hint:
        model_hint = str(model.get("default") or model.get("model") or "") if isinstance(model, dict) else str(model or "")
    if "${" in model_hint:
        model_hint = ""                                                # AAS 기본 모델 참조(${HERMES_LLM_MODEL})는 이름이 아니다 — 받는 쪽에서 뜻이 없다(OKE 시험 2026-11-18)

    # MCP
    items: dict[str, list[dict]] = {"skills": [], "mcp": [], "cron": []}
    servers = {}
    for sname, spec in sorted(template_checks.mcp_servers_of(cfg).items()):
        if not isinstance(spec, dict):
            continue
        take = "mcp" not in choices or sname in choices["mcp"]
        items["mcp"].append({"id": str(sname), "label": str(sname), "included": take, "stdio": bool(spec.get("command")) and not spec.get("url"),
                             "url": str(spec.get("url") or "")[:300]})
        if take:
            entry, why = template_mcp(str(sname), spec, add_env)
            for w in why:
                err("secret_found", w)
            servers[str(sname)] = entry
    tcfg: dict = {k: cfg[k] for k in ("toolsets", "platform_toolsets") if k in cfg}
    disabled = (cfg.get("skills") or {}).get("disabled") if isinstance(cfg.get("skills"), dict) else None
    if disabled:
        tcfg["skills"] = {"disabled": list(disabled)}
    if servers:
        tcfg["mcp_servers"] = servers
    config_text = yaml.safe_dump(tcfg, allow_unicode=True, sort_keys=False) if tcfg else ""

    # 예약 작업
    jobs = []
    for job in _jobs(_read(root / "cron" / "jobs.json")):
        jid = str(job.get("id") or job.get("name") or "")
        take = "cron" not in choices or jid in choices["cron"]
        items["cron"].append({"id": jid, "label": str(job.get("name") or jid)[:120], "included": take})
        if take:
            t = template_job(job)
            jobs.append(t)
            for ref in template_checks.refs(t):
                add_env(ref, f"cron:{t.get('name') or jid}")
    cron_text = json.dumps({"jobs": jobs}, ensure_ascii=False, indent=2) if jobs else ""

    # 스킬
    files: list[tuple[str, bytes]] = []
    hub_skills: list[dict] = []
    skipped: list[str] = []                                        # 담지 않은 의존성·실행 기록 폴더(스펙 2026-11-18-019 R7)
    incomplete: list = []
    defaults = set(marketplace.default_packages())
    for s in _skills(pod_id, root, profile):
        if s["origin"] == "bundled":
            continue                                               # Hermes 기본 스킬(고치지 않은 것)은 받는 쪽에도 있다
        take = "skills" not in choices or s["rel"] in choices["skills"]
        row = {"id": s["rel"], "label": s["name"], "origin": s["origin"], "included": take}
        if s["origin"] == "hub":
            row.update(included=False, note=tr("외부 허브에서 받은 스킬은 담지 않습니다", "Skills from an external hub are not included"))
        items["skills"].append(row)
        if not take or s["origin"] == "hub":
            continue
        if s["origin"] == "market":
            if not s.get("package") or s["package"] in defaults:
                continue                                           # AAS 기본 스킬은 받는 쪽에도 늘 들어간다
            try:
                pkg = marketplace.package(s["namespace"], s["pkg_name"])
            except MarketError:
                pkg = {"paid": False}
            if pkg.get("paid") and namespace in template_checks.PUBLIC_NAMESPACES:
                err("restricted_skill", tr(f"공용 구역 AI 에이전트 템플릿은 허용이 필요한 스킬({s['package']})을 가리킬 수 없습니다", f"A shared AI Agent template cannot point to the restricted skill {s['package']}"))
            hub_skills.append({"namespace": s["namespace"], "name": s["pkg_name"], "version": s["version"]})
            continue
        excluded: list[str] = []
        gone: list[str] = []
        try:
            got = mp.collect(root / s["rel"], excluded, gone, incomplete)
            skipped += [f"{s['rel']}/{g}" for g in gone]
        except MarketError as exc:
            err("skill_files", f"{s['rel']}: {exc}")
            continue
        for f in excluded:
            err("secret_found", tr(f"비밀값으로 보이는 문자열이 있습니다: {s['rel']}/{f}", f"Looks like a secret: {s['rel']}/{f}"))
        md = dict(got).get("SKILL.md", b"").decode("utf-8", errors="replace")
        for e in skill_setup.required_env(skill_setup.frontmatter(md)):
            if skill_setup.is_aas_managed(e["name"]):           # LLM 접속값은 AAS 가 준다 — 설치한 사람에게 묻지 않고 차단 이름 점검에도 걸지 않는다(스펙 2026-11-19-002)
                continue
            add_env(e["name"], f"skill:{s['name']}")
            if e.get("prompt") and not env[e["name"]]["description"]:
                env[e["name"]]["description"] = e["prompt"][:300]
            if e.get("optional"):
                env[e["name"]]["required"] = False
        sub = s["rel"][len("skills/"):]
        files += [(f"agent/skills/{sub}/{r}", d) for r, d in got]

    line = mp.skipped_line(skipped, incomplete)
    if line:                                                       # 미리 보기·게시 모두 — 게시 요청 기록의 warnings 로 관리자도 본다
        warnings.append({"code": "skipped_dirs", **line})

    # KEY 이름 — 값은 읽지 않는다. 막힌 이름은 넣지 않고 사유로 보인다
    from ..fleet import env_desc
    env_requires = []
    for key, row in sorted(env.items()):
        if template_checks.blocked(key):
            err("env_ref_blocked", tr(f"{key} 는 설치한 사람이 넣을 수 없는 이름이라 AI 에이전트 템플릿에 쓸 수 없습니다({', '.join(row['used_by'])})",
                                       f"{key} cannot be set by the installer, so a template cannot use it ({', '.join(row['used_by'])})"))
            continue
        note = " ".join(str((key_notes or {}).get(key) or "").split())[:200]   # 올리는 사람의 설명이 먼저(MCP KEY 는 설명이 비어 있다, OKE 2026-11-18)
        row["description"] = note or row["description"] or (env_desc.find(key, "") or "")[:300]
        env_requires.append(row)

    # 작업 지침(AGENTS.md)과 참고 파일 — template/ 아래. Hermes 로 넘기지 않고 설치 뒤 AAS 가 넣는다(3단계)
    agents_text = read_agents(home, profile)
    agents_on = bool(agents_text.strip()) and agents is not False
    items["agents"] = [{"id": "AGENTS.md", "label": "AGENTS.md", "included": agents_on, "size": len(agents_text)}] if agents_text.strip() else []
    if agents_on and len(agents_text) > MAX_AGENTS:
        err("agents_too_long", tr(f"작업 지침이 {len(agents_text)}자입니다. {MAX_AGENTS}자 안으로 줄이거나 빼세요", f"The work instructions are {len(agents_text)} characters. Shorten them below {MAX_AGENTS} or leave them out"))
    template_files: list[tuple[str, bytes]] = [("template/AGENTS.md", agents_text.encode())] if agents_on else []
    picked, needs = reference_files(home, ref_files or [], err)
    template_files += [(f"template/files/{f['path']}", f["data"]) for f in picked if f["ok"]]
    files_meta = [{"path": f["path"], "size": len(f["data"]), "text": f["text"],
                   **({"confirmed_by": who, "confirmed_at": mp._now()} if not f["text"] else {})} for f in picked if f["ok"]]
    items["files"] = [{"id": f["path"], "label": f["path"], "included": f["ok"], "size": len(f["data"]), "text": f["text"], "confirmed": f.get("confirmed", False)}
                      for f in picked] + [{"id": p, "label": p, "included": False, "size": 0, "text": False, "confirmed": False} for p in needs]

    readme = f"# {name}\n\n{description}\n"
    manifest = {"name": name, "version": version, "description": description[:400], "author": author,
                "env_requires": env_requires,
                "aas": {"template": 1, "model_hint": model_hint[:120], "hub_skills": hub_skills, "files": files_meta, "agents": agents_on,
                        "examples": [" ".join(str(x).split())[:200] for x in examples or [] if str(x).strip()][:5]}}   # 첫 대화 빈 화면의 예시(§4-5)
    tags = [t for t in tags or [] if t in _work_tags()][:3]
    skill_md = "---\n" + yaml.safe_dump({"name": name, "description": description[:400], "version": version, "author": author,
                                         **({"tags": tags} if tags else {}), "kind": "agent-template"}, allow_unicode=True, sort_keys=False) + "---\n\n" + readme
    files = [("SKILL.md", skill_md.encode()), ("agent/distribution.yaml", yaml.safe_dump(manifest, allow_unicode=True, sort_keys=False).encode()),
             ("agent/SOUL.md", soul.encode()), ("agent/README.md", readme.encode())] \
        + ([("agent/config.yaml", config_text.encode())] if config_text else []) \
        + ([("agent/cron/jobs.json", cron_text.encode())] if cron_text else []) + files + template_files

    # 검사 — 설치 때와 같은 검사 + 비밀값 + 사내 주소 + 의심 문구
    try:
        info = template_checks.check(namespace, config_text, cron_text, [e["name"] for e in env_requires], [r for r, _ in files], None)
    except template_checks.CheckError as exc:
        err(exc.code, str(exc))
        info = {"stdio": template_checks.stdio_list(servers)}
    for rel, data in files:
        if not rel.startswith("agent/skills/") and _secret_like(data.decode("utf-8", errors="ignore")):
            err("secret_found", tr(f"비밀값으로 보이는 문자열이 있습니다: {rel} — 그 줄을 지우세요", f"Looks like a secret: {rel}. Remove that line"))
    refs = mp.publish_auto_refs(mp._public_files(files) if namespace in mp.VISIBILITY else files)
    if refs:
        if namespace in mp.VISIBILITY and allow_internal:            # 사내 공유: 올리는 사람이 확인하면 경고로 두고 게시 기록에 남긴다(스펙 2026-11-18-010)
            warnings.append({"code": "internal_ref_ok", "message": tr(f"사내 주소·사설 IP 가 있지만 확인하고 올립니다: {', '.join(refs[:5])}",
                                                                      f"Internal addresses found; publishing as confirmed: {', '.join(refs[:5])}")})
        elif namespace in mp.VISIBILITY:
            err("internal_ref", tr(f"사내 주소·사설 IP 가 있어 공용 구역에 올릴 수 없습니다: {', '.join(refs[:5])}", f"Internal addresses found, so it cannot go to the shared zone: {', '.join(refs[:5])}"))
        else:
            warnings.append({"code": "internal_ref", "message": tr(f"사내 주소·사설 IP 가 있습니다: {', '.join(refs[:5])}", f"Internal addresses found: {', '.join(refs[:5])}")})
    if namespace in template_checks.PUBLIC_NAMESPACES:
        hits = [rel for rel, data in files if rel.endswith((".md", ".json")) and SUSPICIOUS.search(data.decode("utf-8", errors="ignore"))]
        if hits:
            warnings.append({"code": "suspicious", "message": tr(f"파일·키를 밖으로 보내는 데 쓰일 수 있는 문구가 있습니다: {', '.join(hits[:5])} — 공용 구역에 올리기 전에 확인하세요",
                                                                 f"Some text could be used to send files or keys elsewhere: {', '.join(hits[:5])}. Check it before publishing to the shared zone")})
    agent_part = [(r, d) for r, d in files if r.startswith("agent/")]
    if len(_tar(agent_part)) > marketplace.PAYLOAD_LIMIT:
        err("too_big", tr(f"묶음이 설치 한도({marketplace.PAYLOAD_LIMIT // 1024} KiB)를 넘습니다 — 스킬이나 예약 작업을 빼세요",
                          f"The bundle exceeds the install limit ({marketplace.PAYLOAD_LIMIT // 1024} KiB). Leave out some skills or cron jobs"))
    return {"files": files, "items": items, "env_requires": env_requires, "hub_skills": hub_skills, "errors": errors, "warnings": warnings,
            "stdio": info.get("stdio", []), "model_hint": model_hint, "soul": soul, "needs_confirmation": needs, "agents": agents_text if agents_on else "",
            "internal_refs": refs}


MAX_AGENTS = 20000
TEXT_EXT = (".txt", ".md", ".csv", ".json", ".yaml", ".yml", ".html", ".xml", ".py", ".sh", ".js", ".ts", ".sql", ".ini", ".toml", ".tsv", ".log")


def read_agents(home, profile: str) -> str:
    """프로파일의 AGENTS.md(작업 지침). 없거나 못 읽으면 빈 글."""
    return _read(skill_keep.profile_root(home, profile) / "AGENTS.md")


def _is_text(rel: str, data: bytes) -> bool:
    if b"\x00" in data[:8192]:
        return False
    try:
        data.decode("utf-8")
    except UnicodeDecodeError:
        return False
    return rel.lower().endswith(TEXT_EXT) or "." not in rel.rsplit("/", 1)[-1]


def reference_files(home, wanted: list[dict], err) -> tuple[list[dict], list[str]]:
    """고른 참고 파일(작업 폴더 /opt/data/workspace 기준 상대 경로)을 읽는다. 돌려주는 값: (읽은 파일들, 확인이 필요한 글 아닌 파일 경로들).
    D5: 글 파일은 비밀값 검사를 거치고, 그 밖의 형식은 만든 사람이 파일마다 확인(confirmed)해야 담긴다. 경로는 만들 때도 정규화해 본다(E10)."""
    out, needs, total = [], [], 0
    base = home / "workspace"
    deps = {n.lower() for n in skill_keep.dependency_names()}
    for item in wanted[: template_checks.MAX_TEMPLATE_FILES + 1]:
        rel = str(item.get("path") or "").strip()
        why = template_checks.file_path_problem(rel)
        if why:
            err("file_path", tr(f"참고 파일 경로를 받을 수 없습니다: {rel} — {why}", f"Cannot use the reference file path {rel}: {why}"))
            continue
        hit = next((x for x in PurePosixPath(rel).parts if x.lower() in deps), None)
        if hit:                                                    # 만들 때만 막는다 — file_path_problem 은 설치 때도 쓴다(스펙 2026-11-18-019 R4)
            err("file_path", tr(f"참고 파일 경로를 받을 수 없습니다: {rel} — `{hit}` 는 의존성 폴더라 담지 않습니다. 파일을 다른 폴더로 옮기거나 목록에서 빼세요",
                                f"Cannot use the reference file path {rel}: `{hit}` is a dependency folder and is not included. Move the file to another folder or remove it from the list"),
                reason="dependency_dir")
            continue
        path = base / rel
        try:
            # 사이드카 경로(RemotePath)는 링크를 따라가지 않고 폴더 밖을 막는다 — 링크 검사는 로컬 경로만(collect 와 같다). OKE 시험 2026-11-18 의 500
            if (_local(path) and path.is_symlink()) or not path.is_file() or skill_keep.escapes(base, path):
                err("file_path", tr(f"작업 폴더에 없는 파일입니다: {rel}", f"Not a file in the workspace: {rel}"))
                continue
            data = path.read_bytes()
        except OSError as exc:
            err("file_read", tr(f"참고 파일을 읽지 못했습니다: {rel} ({type(exc).__name__})", f"Could not read the reference file {rel} ({type(exc).__name__})"))
            continue
        total += len(data)
        text = _is_text(rel, data)
        row = {"path": rel, "data": data, "text": text, "ok": True, "confirmed": bool(item.get("confirmed"))}
        if text and _secret_like(data.decode("utf-8", errors="ignore")):
            err("secret_found", tr(f"참고 파일에 비밀값으로 보이는 문자열이 있습니다: {rel}", f"The reference file looks like it contains a secret: {rel}"))
            row["ok"] = False
        elif not text and not item.get("confirmed"):
            needs.append(rel)                                          # 「개인정보·고객 자료 없음」 확인 전에는 담지 않는다(D5)
            continue
        out.append(row)
    if len(wanted) > template_checks.MAX_TEMPLATE_FILES:
        err("files_too_many", tr(f"참고 파일은 {template_checks.MAX_TEMPLATE_FILES}개까지입니다", f"Up to {template_checks.MAX_TEMPLATE_FILES} reference files"))
    if total > template_checks.MAX_TEMPLATE_BYTES:
        err("files_too_big", tr(f"참고 파일 합계가 {template_checks.MAX_TEMPLATE_BYTES // 2**20}MB 를 넘습니다", f"Reference files exceed {template_checks.MAX_TEMPLATE_BYTES // 2**20} MB in total"))
    return out, needs


def _local(path) -> bool:
    return isinstance(path, Path)


def workspace_files(home, limit: int = 500) -> list[dict]:
    """참고 파일 고르기 목록: 작업 폴더의 일반 파일(점 파일·건너뛸 폴더·링크 제외). {path, size}.
    쿠버네티스에서는 home 이 사이드카 경로(RemotePath)라 건너뛸 폴더를 빼고 한 번에 훑는다(search_rglob)."""
    from ..hermes import workspace as wsp
    from ..hermes.readers import remote
    base = home / "workspace"
    out: list[dict] = []
    try:
        if not base.is_dir():
            return out
        skip = frozenset(wsp.SKIP_DIRS) | skill_keep.dependency_names()   # 의존성 폴더는 후보에서 뺀다(스펙 2026-11-18-019 R3, 실행 기록 이름은 사용자 문서라 둔다)
        found = base.rglob("*") if _local(base) else remote.search_rglob(base, "*", skip)
        for p in sorted(found):
            rel = PurePosixPath(str(p.relative_to(base))).as_posix()
            if any(part.startswith(".") or part in skip for part in rel.split("/")) or (_local(p) and p.is_symlink()) or not p.is_file():
                continue
            if template_checks.file_path_problem(rel):
                continue
            out.append({"path": rel, "size": p.stat().st_size})
            if len(out) >= limit:
                break
    except OSError:
        return out
    return out


def _work_tags() -> dict:
    from . import tags as market_tags
    return market_tags.WORK


def _tar(files: list[tuple[str, bytes]]) -> bytes:
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz", compresslevel=9) as tar:
        for rel, data in files:
            info = tarfile.TarInfo(rel)
            info.size = len(data)
            tar.addfile(info, io.BytesIO(data))
    return buf.getvalue()


# ---- 게시 -------------------------------------------------------------------------------------------------

@contextmanager
def person_lock(who: str):
    """사람마다 하루 한도 세기·기록을 서버 사이에서도 하나씩(E15). 이메일은 파일 이름에 쓰지 않고 해시로."""
    d = store.data_dir() / "market" / "publish-locks"
    d.mkdir(parents=True, exist_ok=True)
    with open(d / f"tpl-{hashlib.sha256((who or '').lower().encode()).hexdigest()[:24]}.lock", "a+") as fh:
        fcntl.flock(fh, fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(fh, fcntl.LOCK_UN)


def used_today(who: str, now: datetime | None = None) -> list[dict]:
    """지난 24시간 이 사람이 게시한 템플릿(성공한 것만, 관리자 직접 게시 제외). 게시 기록 폴더를 센다 — 서버들이 같은 값을 본다."""
    now = now or datetime.now().astimezone()
    cut = now - timedelta(hours=24)
    out = []
    for r in mp.requests():
        if r.get("kind") != KIND or str(r.get("who") or "").lower() != (who or "").lower() or r.get("admin_direct"):
            continue
        if r.get("status") not in ("published", "pending_review"):
            continue
        try:
            if datetime.fromisoformat(str(r["ts"])) >= cut:
                out.append(r)
        except (KeyError, ValueError):
            continue
    return out


def mine(who: str) -> list[dict]:
    """내가 올린 템플릿(게시 기록의 요청한 사람 기준, E17). 이름마다 마지막 게시 하나.
    AAS 가 허브에서 내린 기록(hub_hide)이 마지막 게시보다 뒤면 status 를 hidden 으로 바꾼다 — 게시 기록만 보면 내린 템플릿이
    올라간 것처럼 보이고 「내리기」가 붙었다(OKE #656, 2026-11-18). 허브를 부르지 않고 AAS 기록만 본다(목록을 열 때마다 허브 왕복을 하지 않게)."""
    from . import hub_hide
    seen: dict[str, dict] = {}
    for r in sorted(mp.requests(), key=lambda x: str(x["id"])):
        if r.get("kind") == KIND and str(r.get("who") or "").lower() == (who or "").lower() and r.get("status") in ("published", "pending_review"):
            seen[r["name"]] = {k: r.get(k) for k in ("id", "name", "version", "namespace", "status", "ts", "profile", "pod")}
    try:
        down = {(h["namespace"], h["name"]): str(h.get("ts") or "") for h in hub_hide.records()}
    except Exception:                                      # 숨김 기록을 못 읽어도 목록은 보인다
        down = {}
    for row in seen.values():
        at = down.get((row["namespace"], row["name"]))
        if at and _after(at, str(row.get("ts") or "")):
            row["status"] = "hidden"
    return sorted(seen.values(), key=lambda r: r["name"])


def _after(a: str, b: str) -> bool:
    """ISO 시각 a 가 b 보다 늦은가(같은 꼴이 아니어도 비교). 읽지 못하면 a 가 있으면 늦은 것으로 본다."""
    from datetime import datetime
    try:
        return datetime.fromisoformat(a) > datetime.fromisoformat(b)
    except ValueError:
        return bool(a) and not b


def owner_of(name: str) -> str:
    """그 템플릿을 처음 올린 사람(게시 기록). 없으면 빈 값."""
    rows = sorted((r for r in mp.requests() if r.get("kind") == KIND and r.get("name") == name), key=lambda x: str(x["id"]))
    return str(rows[0].get("who") or "").lower() if rows else ""


def publish(pod_id: str, home, profile: str, who: str, *, admin: bool, name: str, description: str, namespace: str, author: str,
            choices: dict | None = None, tags: list[str] | None = None, soul_override: str | None = None, dry_run: bool = False,
            agents: bool | None = None, ref_files: list[dict] | None = None, examples: list[str] | None = None,
            allow_internal: bool = False, key_notes: dict[str, str] | None = None) -> dict:
    """템플릿 게시. allow_internal: 공용 구역의 사내 주소·사설 IP 를 사람이 확인했다(스펙 2026-11-18-010, MCP 도구는 넘기지 않는다). 막는 오류는 TemplateError(422·409·429). dry_run 은 미리 보기만 하고 한도를 세지 않는다."""
    namespace = marketplace.ns_slug(namespace or "")
    spaces = marketplace.settings()["namespaces"]
    if namespace not in spaces:
        raise TemplateError(tr("이 스킬 허브에서 다루지 않는 구역입니다", "This skill hub does not serve that zone"), 400, reason="zone")
    if not NAME.match(name or ""):
        raise TemplateError(tr("AI 에이전트 템플릿 이름은 소문자·숫자·하이픈 2~63자입니다", "The AI Agent template name must be 2-63 lowercase letters, digits or hyphens"), 400, reason="name")
    if len((description or "").strip()) < 20:
        raise TemplateError(tr("설명은 20자 이상으로 무엇을 하는 프로파일인지 적으세요", "Write at least 20 characters about what the profile does"), 400, reason="description")
    there = _hub_version(name)
    owner = owner_of(name)
    if there and not (admin or owner == (who or "").lower()):
        raise TemplateError(tr("스킬 허브에 같은 이름이 있습니다 — 다른 이름을 쓰세요", "The skill hub already has that name. Use another name"), 409, reason="name_taken")
    if there and there["namespace"] != namespace:
        raise TemplateError(tr(f"이 AI 에이전트 템플릿은 {marketplace.ns_label(there['namespace'])} 구역에 있습니다 — 같은 구역으로 올리세요",
                               f"This template is in the {marketplace.ns_label(there['namespace'])} zone. Publish to the same zone"), 409, reason="zone_changed")
    version = mp._bump(there["version"]) if there and there["version"] else "1.0.0"
    out = build(pod_id, home, profile, name=name, description=description.strip(), namespace=namespace, author=author, version=version,
                choices=choices, tags=tags, soul_override=soul_override, agents=agents, ref_files=ref_files, who=(who or "").lower(), examples=examples,
                allow_internal=allow_internal, key_notes=key_notes)
    preview = {k: out[k] for k in ("items", "env_requires", "hub_skills", "errors", "warnings", "stdio", "model_hint", "soul", "needs_confirmation", "agents", "internal_refs")}
    preview.update(name=name, version=version, namespace=namespace, update=bool(there), from_version=(there or {}).get("version") or "",
                   files=[{"path": r, "size": len(d)} for r, d in out["files"]], limit=daily_limit(), used=len(used_today(who)))
    if dry_run:
        return {"status": "preview", **preview}
    if out["errors"]:
        first = out["errors"][0]
        raise TemplateError(first["message"], 422, reason=first["code"])
    if out["needs_confirmation"]:                                       # 글이 아닌 파일은 사람이 파일마다 확인한 뒤에만 담는다(D5). 에이전트가 대신 확인하지 않는다
        return {"status": "needs_confirmation", **preview}
    with person_lock(who), mp.name_lock(name):
        if not admin and len(used_today(who)) >= daily_limit():
            raise TemplateError(tr(f"오늘 올릴 수 있는 AI 에이전트 템플릿 수({daily_limit()})를 다 썼습니다. 24시간 안에 올린 것이 지나면 다시 올릴 수 있습니다",
                                   f"You have used today's template publish limit ({daily_limit()}). Try again after 24 hours from the earliest one"), 429, reason="publish_daily_limit")
        if any(r["name"] == name and r["status"] in ("requested", "publishing") and not r.get("stale") for r in mp.requests()):
            raise TemplateError(tr("같은 이름의 게시가 진행 중입니다", "A publish with that name is in progress"), 409, reason="pending")
        rid = datetime.now().strftime("%Y%m%d%H%M%S%f") + "-" + secrets.token_hex(3)
        (mp._dir() / (rid + ".zip")).write_bytes(mp.zip_of(out["files"]))
        row = mp._write({"id": rid, "ts": mp._now(), "who": (who or "").lower(), "pod": pod_id, "profile": profile, "path": "", "kind": KIND,
                         "name": name, "version": version, "origin": KIND, "derived_from": "", "description": description[:240],
                         "files": preview["files"], "status": "publishing", "message": "", "want_namespace": namespace,
                         "env_names": [e["name"] for e in out["env_requires"]], "stdio": [s["name"] for s in out["stdio"]],
                         "warnings": [w["message"] for w in out["warnings"]][:20], **({"admin_direct": True} if admin else {}),
                         **({"internal_refs_ack": {"by": (who or "").lower(), "at": mp._now(), "refs": out["internal_refs"][:50]}}
                            if allow_internal and namespace in mp.VISIBILITY and out["internal_refs"] else {}),
                         "confirmed_files": [{"path": f["path"], "by": f.get("confirmed_by"), "at": f.get("confirmed_at")}
                                             for f in yaml.safe_load(dict(out["files"])["agent/distribution.yaml"])["aas"]["files"] if not f.get("text")]})
        row = mp._publish(row, namespace, f"auto:{row['who']}" if not admin else row["who"])
    if row["status"] in ("published", "pending_review"):
        _notify_admins(row)
    return {"status": row["status"], "request_id": row["id"], "message": row.get("message") or "", **preview}


def _hub_version(name: str) -> dict | None:
    try:
        return mp._exists(name)
    except MarketError as exc:
        raise TemplateError(tr(f"스킬 허브를 확인하지 못했습니다: {exc}", f"Could not check the skill hub: {exc}"), 502, reason="hub") from None


def _notify_admins(row: dict) -> None:
    """관리자 받은편지함에 「새 템플릿」 알림(승인이 아니다, D2). 같은 프로파일의 알림이 아직 열려 있으면 더하지 않는다."""
    from ..ops import admin_requests
    detail = tr(f"AI 에이전트 템플릿 {row['name']} {row['version']} ({marketplace.ns_label(row.get('namespace') or '')}, 명령 실행 MCP {len(row.get('stdio') or [])}개)",
                f"Template {row['name']} {row['version']} ({marketplace.ns_label(row.get('namespace') or '')}, {len(row.get('stdio') or [])} command MCP servers)")
    try:
        admin_requests.create(row["pod"], row["profile"], row["who"], "template_notice", detail)
    except admin_requests.RequestError:
        pass                                                          # 이미 열린 알림이 있거나 대기 상한 — 게시는 그대로 성공


def unpublish(name: str, who: str, admin: bool) -> dict:
    """만든 사람(게시 기록의 요청한 사람)이나 관리자가 템플릿을 내린다. 기존 hub_hide.hide(허브 archive + 누가·언제 기록)를 그대로 쓴다(E17)."""
    from . import hub_hide
    owner = owner_of(name)
    if not owner:
        raise TemplateError(tr("내가 올린 AI 에이전트 템플릿이 아닙니다", "This is not an AI Agent template you published"), 404, reason="not_found")
    if not admin and owner != (who or "").lower():
        raise TemplateError(tr("올린 사람과 관리자만 내릴 수 있습니다", "Only the publisher and admins can take it down"), 403, reason="not_owner")
    there = _hub_version(name)
    if not there:
        raise TemplateError(tr("스킬 허브에 없는 AI 에이전트 템플릿입니다", "The skill hub does not have this AI Agent template"), 404, reason="not_found")
    out = hub_hide.hide(there["namespace"], name, who)
    return {"ok": True, "name": name, "namespace": there["namespace"], **({"hub": out} if isinstance(out, dict) else {})}



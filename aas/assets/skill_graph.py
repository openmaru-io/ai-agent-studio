# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""스킬 인벤토리와 호출 관계 — 정적 분석.

SKILL.md 와 같은 디렉터리의 텍스트 파일을 읽어 그 스킬이 부르는 MCP 서버·REST
호스트·스크립트·다른 스킬을 뽑는다. 스크립트가 부르는 스크립트는 깊이 3 까지 따라가고(script_refs, 연결도와 같은 규칙),
다른 스킬로는 넘어가지 않는다.
자유 서술에서 뽑는 것이라 놓침과 오탐이 있다 — 각 항목에 근거 종류를 붙인다.
"""
from __future__ import annotations

import hashlib
import re
from datetime import datetime
from pathlib import Path

from ..hermes.readers import remote

from ..hermes import hermes_reader as hr
from . import script_refs, skill_origin, skill_setup
from ..common.i18n import tr
from ..common.redact import clean_url, redact

SCRIPT_EXT = set(script_refs.SCRIPT_EXT)
TEXT_EXT = {".md", ".json", ".yaml", ".yml", ".txt", ".toml"} | SCRIPT_EXT
MAX_FILE_BYTES = 300_000
MAX_FILES = 80

_MCP_TOOL = re.compile(r"\bmcp__([A-Za-z0-9-]+)__([A-Za-z][A-Za-z0-9_]*)")
_SCRIPT_REF = script_refs.OPT_REF
_BACKTICK = re.compile(r"`/?([A-Za-z0-9][A-Za-z0-9_-]{2,})`")
_SLASH = re.compile(r"(?<![\w/.])/([A-Za-z][A-Za-z0-9_-]{2,})\b")


def _frontmatter(text: str) -> dict:
    if not text.startswith("---"):
        return {}
    end = text.find("\n---", 3)
    if end == -1:
        return {}
    meta: dict = {}
    for line in text[3:end].splitlines():
        m = re.match(r"^\s*(name|description|related_skills)\s*:\s*(.*)$", line)
        if not m:
            continue
        key, val = m.group(1), m.group(2).strip()
        if key == "related_skills":
            meta[key] = [v.strip().strip("\"'") for v in val.strip("[]").split(",") if v.strip()]
        elif key not in meta:
            meta[key] = val.strip("\"'")
    return meta


def _read(path: Path) -> str:
    try:
        if path.stat().st_size > MAX_FILE_BYTES:
            return ""
        return path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return ""


def _short(rel: str, srel: str) -> str:
    """화면에 보일 파일 이름: 스킬 폴더 안이면 폴더 기준, 밖이면 /opt/data 경로."""
    return rel[len(srel) + 1:] if rel.startswith(srel + "/") else "/opt/data/" + rel


def _analyze(profile: str, skill_md: Path, home: Path, mcp_names: set[str]) -> dict:
    sdir = skill_md.parent
    md = _read(skill_md)
    meta = _frontmatter(md)
    files = []
    for p in sorted(hr.search_rglob(sdir, "*")):                 # 의존성 폴더(node_modules·.venv 등)는 스킬 파일이 아니다(스펙 2026-11-03-003 D11)
        if p.is_file() and not any(part.startswith(".") for part in p.relative_to(sdir).parts):
            files.append(p)
        if len(files) >= MAX_FILES:
            break
    texts = {p: _read(p) for p in files if p.suffix.lower() in TEXT_EXT}
    srel = str(sdir.relative_to(home))
    scripts = [str(p.relative_to(sdir)) for p in files if p.suffix.lower() in SCRIPT_EXT]
    # SKILL.md 가 가리키는 폴더 밖 스크립트(/opt/data/… = Hermes 홈)는 화면에 경로를 보인다
    external = sorted({"/opt/data/" + m for m in _SCRIPT_REF.findall(md)
                       if not ("/opt/data/" + m).startswith("/opt/data/" + srel + "/")})
    # 부르는 스크립트를 따라간다: 폴더 안 스크립트와 SKILL.md 가 가리킨 스크립트에서 깊이 3 까지(연결도와 같은 규칙, 스펙 2026-10-28-013 재검토 R1·D2)
    own = {str(p.relative_to(home)): texts.get(p, "") for p in files if p.suffix.lower() in SCRIPT_EXT}
    read = lambda rel: own[rel] if rel in own else _read(home / rel)  # noqa: E731
    ok = lambda rel: script_refs.listed(home, rel)  # noqa: E731
    starts = [r for r in own if ok(r)] + [t for t, _k, _n, _l in script_refs.refs(home, f"{srel}/SKILL.md", md, True, ok)]
    followed = script_refs.follow(home, starts, read, ok)
    deep = {rel: read(rel) for rel in followed if rel not in own}
    mcp, _ = _scan("\n".join([*texts.values(), *deep.values()]), mcp_names)
    # 외부 호스트: SKILL.md 와 따라간 스크립트에 나오면 부르는 것, 그 밖의 글 파일(README·참고 글)에만 나오면 문서에만 있는 것(D2·D3)
    call: dict[str, dict] = {}
    for rel, text in [(f"{srel}/SKILL.md", md), *((r, read(r)) for r in followed)]:
        for _no, _line, host, raw in script_refs.hosts(text):
            entry = call.setdefault(host, {"urls": set(), "files": set()})
            entry["urls"].add(clean_url(raw))
            entry["files"].add(_short(rel, srel))
    doc: dict[str, set] = {}
    for p, text in texts.items():
        rel = str(p.relative_to(home))
        if p == skill_md or rel in own:
            continue
        for _no, _line, host, _raw in script_refs.hosts(text):
            if host not in call:
                doc.setdefault(host, set()).add(_short(rel, srel))
    rest = [{"host": h, "urls": sorted(v["urls"])[:5], "files": sorted(v["files"])[:10]} for h, v in sorted(call.items())]
    rest_doc = [{"host": h, "files": sorted(f)[:10]} for h, f in sorted(doc.items())]
    mentions = set(_BACKTICK.findall(md)) | set(_SLASH.findall(md))
    name = meta.get("name") or sdir.name
    return {
        "md_sha": hashlib.sha256(md.encode("utf-8")).hexdigest(),     # Hermes 가 고쳤는지 보는 판 기록 수집이 쓴다
        "id": f"{profile}:{sdir.relative_to(home)}",
        "name": name, "profile": profile,
        "path": str(sdir.relative_to(home)),
        "description": redact(meta.get("description", ""), 240),
        "modified": datetime.fromtimestamp(skill_md.stat().st_mtime).astimezone()
                            .isoformat(timespec="seconds"),
        "files": len(files),
        "mcp": mcp, "rest": rest, "rest_doc": rest_doc,
        "scripts": scripts,
        "external_scripts": external[:20],
        "required_env": skill_setup.required_env(skill_setup.frontmatter(md)),   # 필요한 비밀값 이름·안내(스펙 2026-10-16-010 2단계). 설정됐는지는 요청 때 붙인다
        "_related": meta.get("related_skills", []),
        "_mentions": mentions,
    }


def _scan(blob: str, mcp_names: set[str]) -> tuple[list[dict], list[dict]]:
    """글에서 부르는 MCP 서버·REST 호스트를 뽑는다(데이터 폴더 스킬과 AAS 기본 스킬이 같이 쓴다)."""
    mcp: dict[str, dict] = {}
    for m in _MCP_TOOL.finditer(blob):
        server, tool = m.group(1), m.group(2)
        entry = mcp.setdefault(server, {"server": server, "tools": set(), "evidence": tr("도구 이름", "Tool name")})
        entry["tools"].add(tool)
    for name in mcp_names:  # Hermes 식 이름: mcp_<서버(하이픈→밑줄)>_<도구>
        us = re.escape(name.replace("-", "_"))
        tools = set(re.findall(rf"\bmcp_{us}_([a-z][a-z0-9_]*)", blob))
        if tools:
            entry = mcp.setdefault(name, {"server": name, "tools": set(), "evidence": tr("도구 이름", "Tool name")})
            entry["tools"] |= tools
    # 서버 이름만 나온 경우는 같은 줄에 "mcp" 가 있을 때만 센다 — "APM" 같은 짧은 이름은
    # 제품명으로도 쓰여서 이름만으로는 오탐이 난다.
    mcp_lines = [ln for ln in blob.splitlines() if "mcp" in ln.lower()]
    for name in mcp_names:
        pat = re.compile(rf"(?<![\w-]){re.escape(name)}(?![\w-])")
        if name not in mcp and any(pat.search(ln) for ln in mcp_lines):
            mcp[name] = {"server": name, "tools": set(), "evidence": tr("서버 이름 언급", "Server name mentioned")}

    hosts: dict[str, set] = {}
    for _no, _line, host, raw in script_refs.hosts(blob):    # 호스트 거르기·줄 길이는 연결도와 같은 규칙(script_refs)
        hosts.setdefault(host, set()).add(clean_url(raw))

    return ([{"server": v["server"], "tools": sorted(v["tools"])[:20],
              "evidence": v["evidence"]} for v in sorted(mcp.values(), key=lambda x: x["server"])],
            [{"host": h, "urls": sorted(u)[:5]} for h, u in sorted(hosts.items())])


def build(home: Path | None = None, jobs_by_profile: dict[str, list[dict]] | None = None) -> dict:
    home = home or hr.hermes_home()
    if jobs_by_profile is None:
        remote.prefetch(home)                                 # 원격이면 데이터 폴더 묶음을 먼저 받는다(OMAI-1102)
        return remote.memo(home, "skill_graph", lambda: _build(home, None))   # 같은 묶음 안에서는 한 번만(호출흐름이 세 번 만들었다)
    return _build(home, jobs_by_profile)


def _build(home, jobs_by_profile: dict[str, list[dict]] | None) -> dict:
    mcp_cfg = hr.mcp_server_names(home)
    mcp_names = {n for names in mcp_cfg.values() for n in names}
    skills = [_analyze(prof, md, home, mcp_names) for prof, md in hr.skill_files(home)]
    own = {(s["profile"], s["name"]) for s in skills}
    for prof, label, md in hr.shared_skill_files(home):      # 설정의 skills.external_dirs 로 가져온 스킬(D6). 같은 이름이 프로파일에 있으면 그쪽이 이긴다(Hermes 와 같다)
        s = _analyze(prof, md, home, mcp_names)
        if (prof, s["name"]) not in own:
            own.add((prof, s["name"]))
            skills.append({**s, "shared_from": label})
    skill_origin.annotate(home, skills)
    names = {s["name"] for s in skills}
    for s in skills:
        refs = {r for r in s.pop("_related") if r in names and r != s["name"]}
        refs |= {m for m in s.pop("_mentions") if m in names and m != s["name"]}
        s["skills"] = sorted(refs)

    if jobs_by_profile is None:
        jobs_by_profile = {}
        for p in hr.profiles(home):
            try:  # 깨진 jobs.json 하나가 스킬 화면 전체를 막지 않게 한다 (Cron 건강 쪽이 알린다)
                jobs_by_profile[p.name] = hr.read_jobs(p) or []
            except Exception:
                jobs_by_profile[p.name] = []
    by_key: dict[tuple[str, str], dict] = {}
    for s in skills:
        by_key.setdefault((s["profile"], s["name"]), s)
        s["cron"] = []
    unresolved = []
    for prof, jobs in jobs_by_profile.items():
        for job in jobs:
            for sk in job.get("skills") or []:
                short = str(sk).split("/")[-1]
                target = by_key.get((prof, short)) or by_key.get(("default", short))
                link = {"profile": prof, "job": job.get("name") or job.get("id"),
                        "schedule": job.get("schedule_display") or "",
                        "last_status": job.get("last_status"),
                        "enabled": bool(job.get("enabled", True))}
                if target:
                    target["cron"].append(link)
                else:
                    unresolved.append({**link, "skill": str(sk)})

    by_mcp: dict[str, list[str]] = {}
    by_host: dict[str, list[str]] = {}
    for s in skills:
        for m in s["mcp"]:
            by_mcp.setdefault(m["server"], []).append(s["id"])
        for r in s["rest"]:
            by_host.setdefault(r["host"], []).append(s["id"])
    return {
        "built_at": datetime.now().astimezone().isoformat(timespec="seconds"),
        "skills": sorted(skills, key=lambda s: (s["profile"] != "default", s["profile"], s["name"])),
        "mcp_configured": mcp_cfg,
        "by_mcp": dict(sorted(by_mcp.items(), key=lambda kv: -len(kv[1]))),
        "by_host": dict(sorted(by_host.items(), key=lambda kv: -len(kv[1]))),
        "cron_unresolved": unresolved,
        "totals": {"skills": len(skills),
                   "with_cron": sum(1 for s in skills if s["cron"]),
                   "with_mcp": sum(1 for s in skills if s["mcp"]),
                   "with_rest": sum(1 for s in skills if s["rest"])},
    }


def list_row(s: dict) -> dict:
    """스킬 목록(/api/skills)의 한 행. 상세는 /api/skill 이 따로 준다.
    urls 는 외부 URL 탭의 「호출 URL」 열에 쓴다 — 호스트 순, 호스트마다 5개까지(build 가 자른 그대로)."""
    return ({k: s[k] for k in ("id", "name", "profile", "description", "modified", "origin")}
            | {"shared_from": s.get("shared_from", ""), "n_mcp": len(s["mcp"]), "n_rest": len(s["rest"]),
               "n_scripts": len(s["scripts"]) + len(s["external_scripts"]),
               "n_cron": len(s["cron"]),
               "urls": [u for r in s["rest"] for u in r["urls"]]})

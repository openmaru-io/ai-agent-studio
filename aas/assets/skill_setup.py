# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""스킬이 선언한 필요한 비밀값(스펙 2026-10-16-010 2단계, OMAI-1263).

Hermes 는 SKILL.md 머리(frontmatter)의 세 곳을 합쳐 「이 스킬에 필요한 환경변수」를 정한다(Hermes 345cd2b
tools/skills_tool_setup.py `_get_required_environment_variables`). 같은 규칙으로 이름·안내만 읽는다. 값은 다루지 않는다.
  required_environment_variables: [이름 | {name, prompt, help, required_for, optional}]
  setup.collect_secrets:          [{env_var, prompt, provider_url | url}]   (setup.help 는 공통 도움말)
  prerequisites.env_vars:         [이름]                                    (옛 형식)
메시징 채널에서는 스킬이 비밀값을 물을 수 없어, 화면이 이 목록을 보이고 비밀값 탭(env_set)으로 받는다.
"""
from __future__ import annotations

import re

import yaml

_ENV_NAME = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")       # Hermes _ENV_VAR_NAME_RE 와 같다
_ENV_LINE = re.compile(r"^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$")


def _list(raw) -> list:
    return [raw] if isinstance(raw, dict) else raw if isinstance(raw, list) else []


def _text(value) -> str:
    return value.strip() if isinstance(value, str) and value.strip() else ""


def frontmatter(md: str) -> dict:
    """SKILL.md 머리를 YAML 로. 없거나 깨졌으면 {}."""
    if not md.startswith("---"):
        return {}
    end = md.find("\n---", 3)
    if end == -1:
        return {}
    try:
        data = yaml.safe_load(md[3:end])
    except yaml.YAMLError:
        return {}
    return data if isinstance(data, dict) else {}


def required_env(meta: dict) -> list[dict]:
    """[{name, prompt, help?, required_for?, optional?}] — 이름이 겹치면 먼저 나온 것이 이긴다(Hermes 와 같다)."""
    setup = meta.get("setup") if isinstance(meta.get("setup"), dict) else {}
    setup_help = _text(setup.get("help"))
    prereqs = meta.get("prerequisites")
    legacy = (prereqs.get("env_vars") if isinstance(prereqs, dict) else None) or []
    legacy = [legacy] if isinstance(legacy, str) else legacy if isinstance(legacy, list) else []
    entries = [{"name": i} if isinstance(i, str) else i for i in _list(meta.get("required_environment_variables")) if isinstance(i, (str, dict))]
    entries += [{"name": i.get("env_var"), "prompt": i.get("prompt"), "url": _text(str(i.get("provider_url") or i.get("url") or "")) or None}
                for i in _list(setup.get("collect_secrets")) if isinstance(i, dict)]
    entries += [{"name": str(v)} for v in legacy if str(v).strip()]
    out: dict[str, dict] = {}
    for e in entries:
        name = str(e.get("name") or e.get("env_var") or "").strip()
        if not name or name in out or not _ENV_NAME.match(name):
            continue
        item = {"name": name, "prompt": str(e.get("prompt") or "").strip()[:200]}
        help_text = _text(e.get("help")) or _text(e.get("provider_url")) or _text(e.get("url")) or setup_help
        if help_text:
            item["help"] = help_text[:300]
        if _text(e.get("required_for")):
            item["required_for"] = _text(e.get("required_for"))[:120]
        if e.get("optional"):
            item["optional"] = True
        out[name] = item
    return list(out.values())[:20]


def set_names(*env_files) -> set[str]:
    """`.env` 파일들에서 값이 있는 변수 이름만. 값은 돌려주지 않는다. 없는 파일은 건너뛴다."""
    names: set[str] = set()
    for path in env_files:
        try:
            if not path.is_file():
                continue
            text = path.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        for line in text.splitlines():
            m = _ENV_LINE.match(line)
            if m and m.group(2).strip().strip("\"'"):
                names.add(m.group(1))
    return names

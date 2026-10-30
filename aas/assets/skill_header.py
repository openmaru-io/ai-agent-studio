# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""「새 스킬」 머리말(frontmatter)을 만든다(스펙 2026-10-28-004 §9).

Hermes 스킬 기준(d923a5eb tools/skill_linter.py, agent/learn_prompt.py)에서 쓰는 키만 넣는다:
  version                          — 모든 Hermes 기본 스킬에 있고 lint 가 없으면 경고한다. 새 스킬은 1.0.0
  author                           — 만든 사람의 AAS 이름(없으면 뺀다)
  required_environment_variables   — 이름 목록. Hermes 는 이것으로 준비 여부를 보이고, AAS 는 「필요한 비밀값」으로 보인다(skill_setup)
  metadata.hermes.tags             — Hermes skill_view 가 에이전트에게 보이는 태그
  metadata.hermes.related_skills   — skill_view 가 함께 보이고, 스킬 연결도가 잇는다
값은 json.dumps 로 따옴표를 붙여 YAML 로 안전하게 쓴다. 목록은 한 줄 흐름 형식이다 — 스킬 연결도(skill_graph._frontmatter)가
`related_skills:` 를 줄 단위로 읽기 때문이다.
"""
from __future__ import annotations

import json
import re

VERSION = "1.0.0"
MAX_ENV = 10
MAX_RELATED = 10
MAX_TAGS = 8
MAX_TAG_LEN = 30
_ENV_NAME = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")       # skill_setup._ENV_NAME·Hermes _ENV_VAR_NAME_RE 와 같다


def _q(value: str) -> str:
    return json.dumps(value, ensure_ascii=False)


def _flow(items: list[str]) -> str:
    return "[" + ", ".join(_q(i) for i in items) + "]"


def _strings(raw, what: str) -> list[str]:
    if raw is None:
        return []
    if not isinstance(raw, list) or not all(isinstance(i, str) for i in raw):
        raise ValueError(f"{what} must be a list of strings")
    out: list[str] = []
    for item in (i.strip() for i in raw):
        if item and item not in out:
            out.append(item)
    return out


def env_names(raw) -> list[str]:
    names = _strings(raw, "env")
    bad = [n for n in names if not _ENV_NAME.match(n)]
    if bad:
        raise ValueError(f"bad env name: {', '.join(bad)}")
    if len(names) > MAX_ENV:
        raise ValueError(f"too many env names (max {MAX_ENV})")
    return names


def tag_list(raw) -> list[str]:
    tags = _strings(raw, "tags")
    bad = [t for t in tags if "," in t or len(t) > MAX_TAG_LEN]
    if bad:
        raise ValueError(f"bad tag: {', '.join(bad)}")
    if len(tags) > MAX_TAGS:
        raise ValueError(f"too many tags (max {MAX_TAGS})")
    return tags


def related_list(raw, known: set[str], name: str) -> list[str]:
    names = _strings(raw, "related")
    bad = [n for n in names if n == name or n not in known]
    if bad:
        raise ValueError(f"unknown related skill: {', '.join(bad)}")
    if len(names) > MAX_RELATED:
        raise ValueError(f"too many related skills (max {MAX_RELATED})")
    return names


def build(name: str, description: str, *, author: str = "", env: list[str] | None = None,
          related: list[str] | None = None, tags: list[str] | None = None) -> str:
    lines = ["---", f"name: {name}", f"description: {_q(description)}", f"version: {VERSION}"]
    if author.strip():
        lines.append(f"author: {_q(author.strip())}")
    if env:
        lines.append(f"required_environment_variables: {_flow(env)}")
    if tags or related:
        lines += ["metadata:", "  hermes:"]
        if tags:
            lines.append(f"    tags: {_flow(tags)}")
        if related:
            lines.append(f"    related_skills: {_flow(related)}")
    return "\n".join(lines + ["---"]) + "\n"

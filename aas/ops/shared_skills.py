# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""공용 스킬(스펙 2026-10-15-011 D6, 단계 3): 새 프로파일의 config.yaml 에 `skills.external_dirs` 로 다른 프로파일의 스킬 폴더를 건다.

Hermes 는 외부 폴더의 스킬을 그 프로파일 스킬 뒤에 붙여 읽고(`get_all_skills_dirs`), 같은 이름이면 프로파일 자기 것이 이긴다.
여기서는 설정 글을 고치는 일과 외부 폴더 경로를 읽는 일만 한다. 외부 폴더는 `/opt/data` 아래만 쓴다(owner_guard.config_dirs_error 와 같은 범위).
"""
from __future__ import annotations

import posixpath
import re

import yaml

from ..common.i18n import tr

DATA_DIR = "/opt/data"
_SKILLS_TOP = re.compile(r"^skills\s*:", re.M)


def dir_for(source: str, is_root: bool) -> str:
    """복제 원본 프로파일의 스킬 폴더(파드 안 경로)."""
    return f"{DATA_DIR}/skills" if is_root else f"{DATA_DIR}/profiles/{source}/skills"


def _norm(d) -> str:
    p = posixpath.normpath(str(d))
    return p if p == DATA_DIR or p.startswith(DATA_DIR + "/") else ""


def dirs_of(config_text: str) -> list[str]:
    """config.yaml 의 skills.external_dirs 중 /opt/data 아래 절대 경로만(중복 없이, 적힌 순서). 읽을 수 없으면 빈 목록."""
    try:
        cfg = yaml.safe_load(config_text or "")
    except yaml.YAMLError:
        return []
    skills = cfg.get("skills") if isinstance(cfg, dict) else None
    raw = skills.get("external_dirs") if isinstance(skills, dict) else None
    out: list[str] = []
    for d in raw if isinstance(raw, list) else []:
        n = _norm(d) if isinstance(d, str) else ""
        if n and n not in out:
            out.append(n)
    return out


def label_of(abs_dir: str) -> str:
    """외부 폴더가 어느 프로파일의 스킬인지: profiles/<이름>/skills → 이름, <데이터>/skills → default, 그 밖은 /opt/data 기준 경로."""
    rel = posixpath.relpath(abs_dir, DATA_DIR)
    m = re.fullmatch(r"profiles/([^/]+)/skills", rel)
    if m:
        return m.group(1)
    return "default" if rel == "skills" else rel


def with_dir(config_text: str, directory: str) -> str:
    """config.yaml 글에 외부 폴더를 더한다. 이미 있으면 그대로. 글이 YAML 이 아니거나 skills 가 표가 아니면 ValueError.
    `skills:` 가 아직 없으면 글 끝에 덧붙여 주석을 지키고, 있으면 YAML 로 다시 쓴다(주석은 사라진다)."""
    d = _norm(directory)
    if not d:
        raise ValueError(tr(f"{DATA_DIR} 아래 경로만 쓸 수 있습니다", f"Only paths under {DATA_DIR} are allowed"))
    text = config_text or ""
    try:
        cfg = yaml.safe_load(text) if text.strip() else {}
    except yaml.YAMLError as exc:
        raise ValueError(tr(f"config.yaml 을 읽을 수 없습니다: {exc}", f"Cannot read config.yaml: {exc}")) from exc
    if cfg is None:
        cfg = {}
    if not isinstance(cfg, dict):
        raise ValueError(tr("config.yaml 이 표 모양이 아닙니다", "config.yaml is not a mapping"))
    if d in dirs_of(text):
        return text
    if not _SKILLS_TOP.search(text):
        return text.rstrip("\n") + ("\n" if text.strip() else "") + f"skills:\n  external_dirs:\n  - {d}\n"
    skills = cfg.get("skills")
    if skills is None:
        skills = cfg["skills"] = {}
    if not isinstance(skills, dict):
        raise ValueError(tr("config.yaml 의 skills 가 표 모양이 아닙니다", "skills in config.yaml is not a mapping"))
    cur = skills.get("external_dirs")
    skills["external_dirs"] = [*(cur if isinstance(cur, list) else []), d]
    return yaml.safe_dump(cfg, allow_unicode=True, sort_keys=False, default_flow_style=False)

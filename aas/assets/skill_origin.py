# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""스킬마다 출처를 읽는다(스펙 2026-10-14-015 §4-2): Hermes 기본(bundled)·고친 기본(bundled_modified)·허브(hub)·마켓(market)·
에이전트가 만든 것(agent)·직접 만든 것(local). Hermes 의 파일은 읽기만 한다.

근거는 프로파일 폴더의 skills/.bundled_manifest(이름:MD5), skills/.hub/lock.json(허브로 설치한 이름), skills/.usage.json(created_by) 와
폴더 위치(skills/market/…)다. MD5 는 Hermes tools/skills_sync.py 의 _dir_hash 와 같은 방식이다.
"""
from __future__ import annotations

import hashlib
import json
from pathlib import Path

from ..market import skill_keep

ORIGINS = ("bundled", "bundled_modified", "hub", "market", "agent", "local")


def _text(path) -> str:
    try:
        return path.read_text(encoding="utf-8")
    except OSError:
        return ""


def _json(path) -> dict:
    try:
        doc = json.loads(_text(path) or "{}")
    except ValueError:
        return {}
    return doc if isinstance(doc, dict) else {}


def hermes_dir_hash(folder) -> str:
    """Hermes _dir_hash 와 같은 MD5: 정렬한 파일마다 상대 경로와 내용을 이어 해시한다. 실행 부산물은 뺀다."""
    h = hashlib.md5()
    for f in sorted(folder.rglob("*")):
        rel = Path(str(f.relative_to(folder)))
        if skill_keep.is_runtime(rel) or not f.is_file():
            continue
        h.update(str(rel).encode("utf-8"))
        h.update(f.read_bytes())
    return h.hexdigest()


class Facts:
    """프로파일 폴더 하나의 출처 근거. 프로파일마다 한 번만 읽는다."""

    def __init__(self, root):
        self.root = root
        manifest = {}
        for line in _text(root / "skills" / ".bundled_manifest").splitlines():
            name, _, digest = line.strip().partition(":")
            if name.strip():
                manifest[name.strip()] = digest.strip()
        self.manifest = manifest
        self.hub = set(_json(root / "skills" / ".hub" / "lock.json").get("installed") or {})
        usage = _json(root / "skills" / ".usage.json")
        # 보관(archived)된 기록은 근거로 쓰지 않는다 — Hermes 는 보관할 때 기록을 지우지 않아, 같은 이름으로 다시 올린 스킬이
        # 「에이전트가 만듦」으로 보였다(스펙 2026-10-29-005 R13, OKE T0 실측: 다시 만든 뒤에도 state 가 archived 로 남음)
        self.agent = {n for n, rec in usage.items() if isinstance(rec, dict) and rec.get("created_by") == "agent" and rec.get("state") != "archived"}


def origin(facts: Facts, name: str, rel_in_root: str, folder) -> str:
    """rel_in_root = 프로파일 폴더 기준 스킬 폴더 경로(skills/…)."""
    if name in facts.hub:
        return "hub"
    if name in facts.manifest:
        digest = facts.manifest[name]
        if not digest:
            return "bundled"                                   # v1 매니페스트(해시 없음): 고쳤는지 알 수 없다
        try:
            return "bundled" if hermes_dir_hash(folder) == digest else "bundled_modified"
        except OSError:
            return "bundled"
    if rel_in_root.startswith("skills/market/"):
        return "market"
    return "agent" if name in facts.agent else "local"


def annotate(home, skills: list[dict]) -> None:
    """스킬 목록(skill_graph 의 항목들)에 origin 을 붙인다. 목록의 path 는 데이터 폴더 기준이다."""
    cache: dict[str, Facts] = {}
    for s in skills:
        path = str(s["path"])
        if path.startswith("profiles/"):
            prof, _, rest = path[len("profiles/"):].partition("/")
            base, rel = home / "profiles" / prof, rest
        else:
            base, rel = home, path
        facts = cache.get(str(base)) or cache.setdefault(str(base), Facts(base))
        s["origin"] = origin(facts, s["name"], rel, home / path)

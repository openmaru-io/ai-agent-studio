# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""보호 스킬 — 고객사 전용 스킬을 켠 프로파일에만 배달하고 바뀐 사본을 원본으로 되돌린다(cogentai-aas-docs 스펙 2026-11-21-003).

  자리      aas/assets/protected_skills/<이름>/ (SKILL.md + 그 밖 파일). 기본 스킬 묶음(aas_skill_packages)과 따로 둔다 —
            skill_bundle.names()·enabled_names()·build_lock 은 이 폴더를 모른다(기본 묶음 동작은 그대로, 스펙 G5).
            폴더째 공개본에서 뺀다(.gitattributes 두 줄). 공개본에는 폴더가 없어 보호 스킬이 없다.
  판        SKILL.md 머리말 version. 잠금은 그 폴더의 versions.lock.json(꼴은 skill_bundle 과 같다 — 판을 올리지 않고 내용을
            고치면 lock 이 거절한다).
  설정      보호 스킬마다 설치 값 하나. 이름 표는 사내 전용 aas/common/edition.py 의 PROTECTED_SKILLS(없으면 빈 표).
            설치 값을 켠 설치에만 목록·스위치·배달에 보인다(protected_enabled).

  python -m aas.market.protected_skills lock    잠금 파일을 다시 쓴다(판을 올린 뒤)
  python -m aas.market.protected_skills check   보호 스킬을 더하거나 판을 올린 뒤 빠진 곳을 찾는다(make check-protected-skills)
"""
from __future__ import annotations

import importlib
import json
import re
import sys
from pathlib import Path

from . import skill_bundle

REPO = Path(__file__).resolve().parents[2]
PROTECTED_DIR = REPO / "aas" / "assets" / "protected_skills"
LOCK = "versions.lock.json"
ATTRIBUTES = REPO / ".gitattributes"
RULES = REPO / "bin" / "export-public" / "rules.txt"
_DIR_REL = "aas/assets/protected_skills"

try:                                        # 공개본에는 사내 전용 모듈이 없다(skill_bundle 과 같은 꼴)
    _edition = importlib.import_module("aas.common.edition")
except ModuleNotFoundError as exc:
    if exc.name != "aas.common.edition":
        raise
    _edition = None
SETTINGS: dict[str, str] = dict(getattr(_edition, "PROTECTED_SKILLS", {}) or {})   # 스킬 이름 → 설치 값 이름


def protected_names(root: Path = PROTECTED_DIR) -> list[str]:
    """폴더에 있는 보호 스킬 전체(설치 값과 상관없음). 허브 같은 이름 올리기 거절도 이것으로 본다."""
    if not root.is_dir():
        return []
    return skill_bundle.names(root)


def protected_enabled(root: Path = PROTECTED_DIR, settings: dict[str, str] | None = None) -> list[str]:
    """설치 값을 켠 보호 스킬 — 목록·스위치·배달이 쓴다. 표에 설정 이름이 없는 스킬은 켜지 않는다."""
    table = SETTINGS if settings is None else settings
    return [n for n in protected_names(root) if n in table and skill_bundle._on(table[n])]


def read_lock(root: Path = PROTECTED_DIR) -> dict:
    path = root / LOCK
    return json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}


def write_lock(root: Path = PROTECTED_DIR) -> dict:
    """잠금 파일을 다시 쓴다. 판이 같은데 내용이 바뀐 스킬이 있으면 skill_bundle.BundleError."""
    lock = skill_bundle.build_lock(root, read_lock(root))
    skill_bundle._write_json(root / LOCK, lock)
    return lock


def _rules(path: Path) -> list[re.Pattern]:
    out = []
    for raw in path.read_text(encoding="utf-8").splitlines():
        parts = raw.strip().split(None, 2)
        if len(parts) == 3 and parts[0] == "deny":
            out.append(re.compile(parts[2]))
    return out


def check(root: Path = PROTECTED_DIR, settings: dict[str, str] | None = None,
          attributes: Path = ATTRIBUTES, rules: Path = RULES, dir_rel: str = _DIR_REL) -> list[str]:
    """빠진 곳 목록(빈 목록이면 통과). 보호 스킬이 없으면(공개본 포함) 볼 것이 없다.
    잠금 줄·판·sha, 설정 이름 표(양쪽), .gitattributes 의 폴더 두 줄, 공개 흔적 규칙이 스킬 이름과 설정 이름을 잡는지."""
    table = SETTINGS if settings is None else settings
    names = protected_names(root)
    problems: list[str] = []
    for name in sorted(set(table) - set(names)):
        problems.append(f"{name}: 설정 이름 표에는 있는데 {dir_rel}/{name}/SKILL.md 가 없습니다")   # i18n-ignore: 개발자 점검 명령의 출력
    if not names:
        return problems
    try:
        built = skill_bundle.build_lock(root, read_lock(root))
    except skill_bundle.BundleError as err:
        problems.append(str(err))
        built = None
    if built is not None and built != read_lock(root):
        problems.append(f"{dir_rel}/{LOCK} 이 원본과 다릅니다. python -m aas.market.protected_skills lock 으로 다시 쓰세요")   # i18n-ignore: 개발자 점검 명령의 출력
    for name in names:
        if name not in table:
            problems.append(f"{name}: 설정 이름 표(aas/common/edition.py PROTECTED_SKILLS)에 없습니다")   # i18n-ignore: 개발자 점검 명령의 출력
    lines = {tuple(l.split()) for l in attributes.read_text(encoding="utf-8").splitlines()} if attributes.exists() else set()
    for pattern in (dir_rel, f"{dir_rel}/**"):
        if (pattern, "export-ignore") not in lines:
            problems.append(f".gitattributes 에 「{pattern} export-ignore」 줄이 없습니다(공개본에 보호 스킬이 나갑니다)")   # i18n-ignore: 개발자 점검 명령의 출력
    deny = _rules(rules) if rules.exists() else []
    for name in names:
        for word in (name, table.get(name, "")):
            if word and not any(r.search(word) for r in deny):
                problems.append(f"{word}: 공개 흔적 규칙(bin/export-public/rules.txt)이 이 낱말을 잡지 않습니다")   # i18n-ignore: 개발자 점검 명령의 출력
    return problems


if __name__ == "__main__":
    cmd = sys.argv[1:]
    if cmd == ["lock"]:
        try:
            for name, row in write_lock().items():
                print(f"{name} {row['version']} {row['sha256'][:12]}")
        except skill_bundle.BundleError as err:
            print(err, file=sys.stderr)
            sys.exit(1)
    elif cmd == ["check"]:
        found = check()
        for line in found:
            print(line, file=sys.stderr)
        print(f"보호 스킬 {len(protected_names())}개, 빠진 곳 {len(found)}개")   # i18n-ignore: 개발자 점검 명령의 출력
        sys.exit(1 if found else 0)
    else:
        print("사용: python -m aas.market.protected_skills lock|check", file=sys.stderr)   # i18n-ignore: 개발자 점검 명령의 출력
        sys.exit(64)

# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""AAS 기본 스킬 묶음 — 서버 이미지가 싣는 스킬 패키지의 원본(스펙 2026-10-29-001 R8, OMAI-1534).

  자리      aas/assets/aas_skill_packages/<이름>/ (SKILL.md + scripts/). 마켓 레포(cogentai-aas-marketplace)에는 두지 않는다.
  판        SKILL.md 머리말의 version 하나. 허브 게시·자동 올리기는 이 판만 견준다.
  잠금      versions.lock.json 에 (판, 내용 해시)를 둔다. 판을 올리지 않고 내용을 고치면 lock 이 거절하고 시험이 실패한다(F11)
            — 같은 판으로는 허브에 다시 게시되지 않아 고친 내용이 아무에게도 가지 않기 때문이다.

  python -m aas.market.skill_bundle lock   잠금 파일을 다시 쓴다(판을 올린 뒤).
"""
from __future__ import annotations

import hashlib
import json
import re
import sys
from pathlib import Path

PACKAGES_DIR = Path(__file__).resolve().parent.parent / "assets" / "aas_skill_packages"
LOCK = "versions.lock.json"
_FRONT = re.compile(r"\A---\n(.*?)\n---\n", re.S)
_SKIP = ("__pycache__",)


class BundleError(Exception):
    pass


def names(root: Path = PACKAGES_DIR) -> list[str]:
    return sorted(p.name for p in root.iterdir() if p.is_dir() and (p / "SKILL.md").is_file())


def front(name: str, root: Path = PACKAGES_DIR) -> dict[str, str]:
    """SKILL.md 머리말의 맨 윗단 키(name·description·version …). 들여 쓴 metadata 는 읽지 않는다."""
    m = _FRONT.match((root / name / "SKILL.md").read_text(encoding="utf-8"))
    if not m:
        raise BundleError(f"{name}: SKILL.md 머리말이 없습니다")   # i18n-ignore: 개발자·빌드 시험이 읽는 오류(화면에 나오지 않음)
    out = {}
    for line in m.group(1).splitlines():
        if re.match(r"^[a-z_]+:", line):
            key, _, value = line.partition(":")
            out[key] = value.strip().strip('"').strip("'")
    return out


def _files(pkg: Path) -> list[Path]:
    return sorted(p for p in pkg.rglob("*") if p.is_file() and not any(s in p.parts for s in _SKIP))


def digest(name: str, root: Path = PACKAGES_DIR) -> str:
    """패키지 안 파일(상대 경로 + 내용)의 SHA-256. __pycache__ 는 뺀다."""
    pkg = root / name
    h = hashlib.sha256()
    for p in _files(pkg):
        h.update(p.relative_to(pkg).as_posix().encode() + b"\0" + p.read_bytes() + b"\0")
    return h.hexdigest()


def read_lock(root: Path = PACKAGES_DIR) -> dict:
    path = root / LOCK
    return json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}


def build_lock(root: Path, old: dict) -> dict:
    """새 잠금 내용. 버전이 같은데 내용이 바뀐 패키지가 있으면 BundleError."""
    out = {}
    for name in names(root):
        version, sha = front(name, root).get("version", ""), digest(name, root)
        if not re.fullmatch(r"\d+\.\d+\.\d+", version):
            raise BundleError(f"{name}: SKILL.md 의 version 이 1.2.3 꼴이 아닙니다: {version!r}")   # i18n-ignore: 개발자·빌드 시험이 읽는 오류(화면에 나오지 않음)
        prev = old.get(name)
        if prev and prev.get("version") == version and prev.get("sha256") != sha:
            raise BundleError(f"{name}: 내용이 바뀌었는데 버전이 {version} 그대로입니다. SKILL.md 의 version 을 올리세요")   # i18n-ignore: 개발자·빌드 시험이 읽는 오류(화면에 나오지 않음)
        out[name] = {"version": version, "sha256": sha}
    return out


def write_lock(root: Path = PACKAGES_DIR) -> dict:
    lock = build_lock(root, read_lock(root))
    (root / LOCK).write_text(json.dumps(lock, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return lock


if __name__ == "__main__":
    if sys.argv[1:] != ["lock"]:
        print("사용: python -m aas.market.skill_bundle lock", file=sys.stderr)   # i18n-ignore: 개발자·빌드 시험이 읽는 오류(화면에 나오지 않음)
        sys.exit(64)
    try:
        for name, row in write_lock().items():
            print(f"{name} {row['version']} {row['sha256'][:12]}")
    except BundleError as err:
        print(err, file=sys.stderr)
        sys.exit(1)

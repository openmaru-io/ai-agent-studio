# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""AAS 기본 스킬 묶음 — 서버 이미지가 싣는 스킬 패키지의 원본(스펙 2026-10-29-001 R8, OMAI-1534).

  자리      aas/assets/aas_skill_packages/<이름>/ (SKILL.md + scripts/). 마켓 레포(cogentai-aas-marketplace)에는 두지 않는다.
  판        SKILL.md 머리말의 version 하나. 허브 게시·자동 올리기는 이 판만 견준다.
  잠금      versions.lock.json 에 (판, 내용 해시)를 둔다. 판을 올리지 않고 내용을 고치면 lock 이 거절하고 시험이 실패한다(F11)
            — 같은 판으로는 허브에 다시 게시되지 않아 고친 내용이 아무에게도 가지 않기 때문이다.

  python -m aas.market.skill_bundle lock   잠금 파일을 다시 쓴다(판을 올린 뒤).

  MCP 짝 스킬 cogentai-mindwiki·cogentai-database·cogentai-chart·docmost·outline 도 여기 둔다(OMAI-2031). 원본은 마켓 레포
  (cogentai-aas-marketplace)였지만 그 레포는 Bitbucket 이라 CI 가 돌지 않아 main 에 합쳐도 허브에 올라가지 않았다.
  조건  CONDITIONAL 의 패키지는 설치 값에 따라 게시·배달한다(enabled_names). 고객사 판(aas/common/edition.py, 사내 전용)이 있으면
        그 설치 값을 켠 설치는 판 스킬만, 끈 설치는 일반판 cogentai-database 만 받는다.
        법령 조회 짝 스킬 law-go-kr 는 AAS_LAW_GO_KR_ENABLED 를 켠 설치에만(스펙 2026-11-20-008).
        names() 는 묶음 전체(잠금·기본 스킬 표시).
  판 잠금  고객사 판 스킬의 잠금 줄은 versions.edition.lock.json(사내 전용)에 따로 쓴다. 공개본에는 판 스킬도 그 잠금 줄도 없다(스펙 2026-11-21-001).
"""
from __future__ import annotations

import hashlib
import importlib
import json
import re
import sys
from pathlib import Path

from ..common import config

PACKAGES_DIR = Path(__file__).resolve().parent.parent / "assets" / "aas_skill_packages"
LOCK = "versions.lock.json"
EDITION_LOCK = "versions.edition.lock.json"
_FRONT = re.compile(r"\A---\n(.*?)\n---\n", re.S)
_SKIP = ("__pycache__",)


class BundleError(Exception):
    pass


def names(root: Path = PACKAGES_DIR) -> list[str]:
    return sorted(p.name for p in root.iterdir() if p.is_dir() and (p / "SKILL.md").is_file())


# 설치 값에 따라 게시·배달하는 패키지 → (설치 값 이름, 켜졌을 때 넣는가). 고객사 판 스킬은 그 설치 값을 켠 설치에만, 일반판
# cogentai-database 는 끈 설치에만 넣는다 — 카탈로그(mcp_servers.simple_builtins)도 둘 중 하나만 보인다
# (사용자 결정 2026-11-16·2026-11-17). 값을 읽는 규칙은 aas/ops/mcp_servers.py edition_enabled 와 같다
# 법령 조회 짝 스킬 law-go-kr 는 커넥터를 켠 설치에만 넣는다 — 카탈로그 항목(mcp_servers.law_go_kr_enabled)과 같은 값
# (스펙 2026-11-20-008 §5-3, OMAI-2138). 이 줄이 없으면 커넥터가 없는 설치의 모든 프로파일에 스킬이 배달된다
CONDITIONAL = {"law-go-kr": ("AAS_LAW_GO_KR_ENABLED", True)}
try:                                        # import_module: 모듈이 없을 때 이름이 붙은 ModuleNotFoundError 를 낸다(mcp_servers 와 같다)
    _edition = importlib.import_module("aas.common.edition")
except ModuleNotFoundError as exc:          # 공개본(고객사 판 없음)
    if exc.name != "aas.common.edition":
        raise
    _edition = None
EDITION_PACKAGES = frozenset({_edition.DATABASE_PACKAGE} if _edition else ())
if _edition:
    CONDITIONAL.update({_edition.DATABASE_PACKAGE: (_edition.SETTING, True), "cogentai-database": (_edition.SETTING, False)})


def _on(key: str) -> bool:
    return config.get(key, "").strip().lower() in ("1", "on", "true", "yes")


def enabled_names(root: Path = PACKAGES_DIR) -> list[str]:
    """이 설치에서 게시·배달할 묶음 패키지."""
    return [n for n in names(root) if n not in CONDITIONAL or _on(CONDITIONAL[n][0]) == CONDITIONAL[n][1]]


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
    out = {}
    for name in (LOCK, EDITION_LOCK):
        path = root / name
        if path.exists():
            out.update(json.loads(path.read_text(encoding="utf-8")))
    return out


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


def _write_json(path: Path, data: dict) -> None:
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def write_lock(root: Path = PACKAGES_DIR) -> dict:
    """잠금 파일을 다시 쓴다. 고객사 판 스킬 줄은 EDITION_LOCK 에 따로 쓴다(공개본의 LOCK 에 판 이름이 남지 않게)."""
    lock = build_lock(root, read_lock(root))
    _write_json(root / LOCK, {k: v for k, v in lock.items() if k not in EDITION_PACKAGES})
    edition_rows = {k: v for k, v in lock.items() if k in EDITION_PACKAGES}
    if edition_rows:
        _write_json(root / EDITION_LOCK, edition_rows)
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

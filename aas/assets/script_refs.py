# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""스킬이 부르는 스크립트·외부 호스트를 찾는 규칙 한 벌 — 스킬 목록(skill_graph)과 스킬 연결도(flow)가 함께 쓴다.

두 화면이 같은 스킬의 외부 호스트 수를 같게 보여야 하므로(스펙 2026-10-28-013 디자인 D5·재검토 D2) 다음을 여기 한 곳에서 정한다.
  - 호스트 거르기(자리표시·잡음 호스트)와 읽는 줄 길이 상한
  - 스크립트가 다른 스크립트를 부르는 참조: /opt/data 경로, 옆 파일 import, 셸·subprocess 줄의 옆 파일 이름
  - 따라갈 수 있는 스크립트: 데이터 폴더 안, 스크립트 목록(inventory.tools)과 같은 자리
  - 따라가는 깊이: 뿌리가 직접 부른 스크립트가 0, 3 까지. 스크립트마다 가장 얕은 깊이로 센다
"""
from __future__ import annotations

import re
import sys
from pathlib import Path
from typing import Callable, Iterator
from urllib.parse import urlsplit

SCRIPT_EXT = (".py", ".sh", ".js", ".mjs", ".cjs", ".ts")     # inventory.SCRIPT_EXT 와 같은 확장자
MAX_LINE = 2000                                               # 이보다 긴 줄(한 줄 JSON·압축 JS)은 읽지 않는다
MAX_DEPTH = 3

URL = re.compile(r"https?://[^\s\"'<>)\]}`\\]+")
OPT_REF = re.compile(r"/opt/data/([\w./-]+\.(?:py|sh|js|mjs|cjs|ts))\b")
_HOST_OK = re.compile(r"^[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$")
_NOISE_HOSTS = {"www.w3.org", "schemas.openxmlformats.org", "schemas.microsoft.com", "json-schema.org"}
_PLACEHOLDER = ("example.", "localhost", "127.0.0.1", "0.0.0.0", "your-", "<", "{", "$")
_PY_IMPORT = re.compile(r"^\s*(?:import|from)\s+([A-Za-z_][\w.]*)")
_JS_IMPORT = re.compile(r"(?:require\(\s*|from\s+)[\"']([^\"'./][^\"']*)[\"']")
_SCRIPT_NAME = re.compile(r"(?<![\w/.-])([\w-]+\.(?:py|sh|js|mjs|cjs|ts))\b")
_STDLIB = set(getattr(sys, "stdlib_module_names", ())) | {"__future__"}


def host_of(raw: str) -> str:
    """주소에서 호스트를 꺼낸다. 예시·자리표시·스키마 주소면 빈 글."""
    try:
        host = urlsplit(raw).hostname or ""
    except ValueError:
        return ""
    if not _HOST_OK.match(host) or host in _NOISE_HOSTS or any(host.startswith(x) or x in host for x in _PLACEHOLDER):
        return ""
    return host


def lines(text: str) -> Iterator[tuple[int, str]]:
    """(줄 번호, 줄). 너무 긴 줄은 건너뛴다 — 두 화면이 같은 줄만 읽게."""
    for no, line in enumerate(text.splitlines(), 1):
        if len(line) <= MAX_LINE:
            yield no, line


def hosts(text: str) -> Iterator[tuple[int, str, str, str]]:
    """(줄 번호, 줄, 호스트, 주소)."""
    for no, line in lines(text):
        for m in URL.finditer(line):
            host = host_of(m.group(0))
            if host:
                yield no, line, host, m.group(0)


def modules(line: str, ext: str) -> list[str]:
    """한 줄의 import 대상 이름(Python·JS). 옆 파일인지 라이브러리인지는 부르는 쪽이 가른다."""
    if ext == ".py":
        m = _PY_IMPORT.match(line)
        return [m.group(1)] if m else []
    if ext in (".js", ".mjs", ".cjs", ".ts"):
        return [x.split("/")[0] if not x.startswith("@") else "/".join(x.split("/")[:2]) for x in _JS_IMPORT.findall(line)]
    return []


def _rel(path: str) -> str | None:
    """데이터 폴더 기준 상대 경로. `..`·절대 경로면 None — 데이터 폴더 밖은 따라가지 않는다."""
    parts = [p for p in path.split("/") if p not in ("", ".")]
    return None if not parts or ".." in parts else "/".join(parts)


def sibling(home: Path, rel: str, name: str) -> str | None:
    """rel 파일과 같은 폴더의 name 파일(있으면) 상대 경로."""
    target = _rel(str(Path(rel).parent / name))
    return target if target and (home / target).is_file() else None


def refs(home: Path, rel: str, text: str, is_doc: bool, ok: Callable[[str], bool]) -> Iterator[tuple[str, str, int, str]]:
    """rel 파일이 부르는 스크립트: (대상 상대 경로, 종류 runs·imports, 줄 번호, 줄).
    문서(SKILL.md)는 /opt/data 경로만 본다. ok 가 거짓인 대상(스크립트 목록에 없는 것)은 내지 않는다."""
    ext = Path(rel).suffix.lower()
    for no, line in lines(text):
        for m in OPT_REF.finditer(line):
            target = _rel(m.group(1))
            if target and ok(target):
                yield target, "runs", no, line
        if is_doc:
            continue
        for mod in modules(line, ext):
            top = mod.split(".")[0]
            for cand in (f"{top}.py", f"{top}.js"):
                target = sibling(home, rel, cand)
                if target:
                    if ok(target):
                        yield target, "imports", no, line
                    break
        if ext == ".sh" or "subprocess" in line or "os.system" in line:
            for m in _SCRIPT_NAME.finditer(line):
                target = sibling(home, rel, m.group(1))
                if target and ok(target):
                    yield target, "runs", no, line


def is_sibling_module(home: Path, rel: str, mod: str) -> bool:
    """import 이름이 옆 파일(스크립트)을 가리키는가 — 그러면 라이브러리가 아니다."""
    top = mod.split(".")[0]
    return any(sibling(home, rel, f"{top}{e}") for e in (".py", ".js"))


def is_stdlib(mod: str) -> bool:
    top = mod.split(".")[0]
    return top in _STDLIB or top.startswith("_") or mod.startswith("node:")


def listed(home: Path, rel: str) -> bool:
    """스크립트 목록(inventory.tools)이 보는 자리에 있는 스크립트인가.
    목록은 프로파일의 scripts/·bin/ 바로 아래 파일과 스킬 폴더 안 스크립트를 읽는다(inventory._tools)."""
    rel_ok = _rel(rel)
    if not rel_ok or Path(rel_ok).suffix.lower() not in SCRIPT_EXT or not (home / rel_ok).is_file():
        return False
    parts = rel_ok.split("/")
    folder = parts[:-1]
    if folder and folder[-1] in ("scripts", "bin") and (len(folder) == 1 or (len(folder) == 3 and folder[0] == "profiles")):
        return True
    for i in range(len(folder), 0, -1):                       # 위 폴더 어딘가에 SKILL.md 가 있으면 스킬 폴더 안이다
        if (home / "/".join(folder[:i]) / "SKILL.md").is_file():
            return True
    return False


def follow(home: Path, starts: list[str], read: Callable[[str], str], ok: Callable[[str], bool]) -> dict[str, int]:
    """starts(깊이 0)에서 스크립트 참조를 따라간다. {상대 경로: 가장 얕은 깊이}, 깊이 MAX_DEPTH 까지."""
    best: dict[str, int] = {}
    queue = [(r, 0) for r in starts]
    while queue:                                              # 너비 우선이라 먼저 만난 깊이가 가장 얕다
        rel, depth = queue.pop(0)
        if depth > MAX_DEPTH or rel in best:
            continue
        best[rel] = depth
        if depth < MAX_DEPTH:
            queue.extend((t, depth + 1) for t, _k, _n, _l in refs(home, rel, read(rel), False, ok))
    return best

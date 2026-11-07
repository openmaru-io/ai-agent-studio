# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""마켓 설치·새 판이 사용자가 고치거나 만든 스킬·크론·MCP 를 지우지 않게 지킨다(스펙 2026-10-14-015, 리뷰 R3·R7·R8·R9).

배달기(market_dispatch)가 HermesTask 를 만들기 전에 이 모듈로 그 프로파일의 지금 모양을 읽어 본다. 읽기만 하고 Hermes 의 파일은 고치지 않는다.
`home` 은 Hermes 데이터 폴더다 — 쿠버네티스에서는 읽기 사이드카를 거치는 RemotePath 이고 pathlib.Path 와 같은 모양으로 읽힌다.
"""
from __future__ import annotations

import hashlib
import io
import json
import re
import tarfile
import time
from pathlib import Path

from ..common import store

# Hermes skills_sync._is_runtime_cache 와 같은 것을 뺀다 — 스크립트를 돌리며 생긴 부산물 때문에 고치지 않은 스킬이 「고쳤다」로 읽히면 안 된다(리뷰 O8)
RUNTIME_DIRS = {"__pycache__", ".pytest_cache", ".mypy_cache", ".ruff_cache", "node_modules", ".git"}
RUNTIME_SUFFIX = (".pyc", ".pyo")
RUNTIME_NAMES = {".DS_Store"}
MAX_BACKUP = 8 * 2**20                    # 덮기 전 백업 하나의 크기 한도
BACKUP_DAYS = 30
_NAME = re.compile(r"^name:\s*['\"]?([^'\"\n#]+?)['\"]?\s*(?:#.*)?$", re.M)


def profile_root(home, profile: str):
    """그 프로파일의 폴더. 루트(default)는 데이터 폴더 자체다."""
    return home if profile in ("", "default") else home / "profiles" / profile


def profile_rel(profile: str, path) -> list[str] | None:
    """스킬 폴더 경로를 프로파일 기준 조각으로. 맞지 않으면 None.
    목록·상세 API 는 데이터 폴더 기준(profiles/<이름>/skills/…)을 준다. 같은 프로파일이면 그 앞부분을 떼고 받는다 —
    MCP skill_get 의 zip 링크와 market_publish 가 이 값을 그대로 넘겨 「스킬 폴더 경로가 올바르지 않습니다」가 났다(2026-11-06).
    다른 프로파일 이름이 붙은 경로는 그대로 거부한다."""
    parts = [p for p in str(path or "").split("/") if p]
    if len(parts) > 2 and parts[0] == "profiles" and profile not in ("", "default") and parts[1] == profile:
        parts = parts[2:]
    if len(parts) < 2 or parts[0] != "skills" or any(p in ("..", ".") or p.startswith(".") for p in parts):
        return None
    return parts


def escapes(root, folder) -> bool:
    """로컬 폴더(Path)가 링크를 따라 프로파일 밖을 가리키는가. 사이드카 경로는 사이드카가 링크를 따라가지 않아 늘 False 다.
    폴더 안 링크는 collect 가 거절하지만 폴더 자체·중간 폴더가 링크면 밖의 파일을 읽었다(CodeQL #32~35·42·43·46)."""
    return isinstance(folder, Path) and Path(root).resolve() not in Path(folder).resolve().parents


def is_runtime(rel: Path) -> bool:
    return rel.name in RUNTIME_NAMES or rel.name.endswith(RUNTIME_SUFFIX) or any(p in RUNTIME_DIRS for p in rel.parts)


def digest(folder) -> dict[str, str]:
    """폴더 안 일반 파일의 {상대 경로: sha256}. 실행 부산물은 뺀다. 폴더가 없으면 빈 값.
    읽다가 OSError 가 나면(사이드카에 닿지 않음) 그대로 올린다 — 못 읽은 것을 「없다」로 읽으면 사용자 스킬을 덮게 된다."""
    out: dict[str, str] = {}
    if not folder.is_dir():
        return out
    for f in sorted(folder.rglob("*")):
        rel = Path(str(f.relative_to(folder)))
        if is_runtime(rel):
            continue
        if f.is_file():
            out[rel.as_posix()] = hashlib.sha256(f.read_bytes()).hexdigest()
    return out


def same(a: dict[str, str], b: dict[str, str]) -> bool:
    return a == b


def skill_name(folder) -> str:
    """SKILL.md 머리말의 name, 없으면 폴더 이름. Hermes 는 같은 name 이 둘이면 둘 다 쓰지 못한다(리뷰 O1)."""
    try:
        head = (folder / "SKILL.md").read_text(encoding="utf-8", errors="replace")[:2000]
    except OSError:
        return str(getattr(folder, "name", ""))
    if head.startswith("---"):
        m = _NAME.search(head.split("---", 2)[1] if head.count("---") >= 2 else head)
        if m:
            return m.group(1).strip()
    return str(getattr(folder, "name", ""))


def installed_skills(root) -> dict[str, str]:
    """{스킬 폴더 상대 경로(skills/…): name} — 그 프로파일의 skills/ 아래 SKILL.md 가 있는 폴더. 스킬 안의 SKILL.md(예시)는 따로 세지 않는다."""
    skills = root / "skills"
    out: dict[str, str] = {}
    if not skills.is_dir():
        return out
    found = sorted((f for f in skills.rglob("SKILL.md") if not is_runtime(Path(str(f.relative_to(skills))))),
                   key=lambda f: (len(f.parts), str(f)))
    for md in found:
        rel = "skills/" + str(md.parent.relative_to(skills)).strip("/")
        if rel == "skills/.":
            continue
        if any(rel.startswith(o + "/") for o in out):
            continue
        out[rel] = skill_name(md.parent)
    return out


def inspect(root, planned: dict[str, str], ours: set[str]) -> dict:
    """설치하려는 스킬 폴더 {rel: name} 이 그 프로파일의 지금 스킬과 부딪히는지 본다(R7).
    occupied = 같은 경로에 설치 기록 없는 폴더가 이미 있다(사용자가 만든 것일 수 있다 — 묻는다)
    clash    = 같은 name 이 다른 경로에 있다(둘 다 쓰지 못하게 된다 — 멈춘다)
    ours     = 이 패키지로 AAS 가 설치한 경로들(기록에 있는 것은 덮어도 된다)"""
    have = installed_skills(root)
    occupied, clash = [], []
    for rel, name in planned.items():
        if rel in have and rel not in ours:
            occupied.append(rel)
        for other, other_name in have.items():
            if other != rel and other_name == name and not other.startswith(rel + "/") and not rel.startswith(other + "/"):
                clash.append({"path": rel, "name": name, "other": other})
    return {"occupied": occupied, "clash": clash}


def modified(root, rel: str, reference: dict[str, str] | None) -> str:
    """기록된 원본(reference = 설치된 판의 {경로: sha256})과 지금 폴더를 비교한다(R3).
    'same' 고치지 않음 / 'changed' 고침 / 'unknown' 원본을 모름(설치 기록이 없거나 SkillHub 에서 못 받음) / 'absent' 폴더가 없음"""
    folder = root / rel
    if not folder.is_dir():
        return "absent"
    if reference is None:
        return "unknown"
    return "same" if same(digest(folder), reference) else "changed"


# ---- 큐레이터가 보관한 스킬(R6) ---------------------------------------------------------------------

_STAMP = re.compile(r"^(.+)-\d{14}$")


def archived(home) -> list[dict]:
    """모든 프로파일의 skills/.archive 바로 아래 폴더 → [{profile, skill, dir}]. 같은 이름이 겹쳐 붙은 시각 꼬리(-YYYYMMDDHHMMSS)는 뗀다.
    읽지 못하면(사이드카에 닿지 않음) OSError 를 그대로 올린다."""
    out: list[dict] = []
    roots = [("default", home)]
    profiles = home / "profiles"
    if profiles.is_dir():
        roots += [(p.name, p) for p in sorted(profiles.iterdir()) if p.is_dir()]
    for profile, root in roots:
        arc = root / "skills" / ".archive"
        if not arc.is_dir():
            continue
        for d in sorted(arc.iterdir()):
            if d.is_dir():
                m = _STAMP.match(d.name)
                out.append({"profile": profile, "skill": m.group(1) if m else d.name, "dir": d.name})
    return out


# ---- 크론·MCP 합치기(R9) ---------------------------------------------------------------------------

def merge_jobs(current: str | None, package: str) -> str:
    """크론 jobs.json 을 합친다 — 같은 id 는 패키지 것, 나머지는 사용자 것을 유지. 형식이 깨졌으면 ValueError(요청을 멈춘다)."""
    pkg = json.loads(package or "{}")
    cur = json.loads(current) if current and current.strip() else type(pkg)()      # 사용자 것이 없으면 패키지와 같은 모양의 빈 것

    def jobs(doc) -> list:
        if isinstance(doc, list):
            return doc
        if isinstance(doc, dict) and isinstance(doc.get("jobs", []), list):
            return doc.get("jobs", [])
        raise ValueError("jobs.json 형식이 올바르지 않습니다")  # i18n-ignore: 요청 결과로 기록하는 문장(저장)

    merged = {str(j.get("id")): j for j in jobs(cur) if isinstance(j, dict)}
    order = list(merged)
    for j in jobs(pkg):
        if not isinstance(j, dict):
            continue
        key = str(j.get("id"))
        if key not in merged:
            order.append(key)
        merged[key] = j
    result = [merged[k] for k in order]
    if isinstance(pkg, dict) or isinstance(cur, dict):
        base = dict(cur) if isinstance(cur, dict) else {}
        base["jobs"] = result
        return json.dumps(base, ensure_ascii=False, indent=2)
    return json.dumps(result, ensure_ascii=False, indent=2)


def merge_mcp(current: str | None, package: str) -> str:
    """mcp.json 을 합친다 — 최상위 객체 안의 같은 이름은 패키지 것, 나머지는 사용자 것을 유지."""
    pkg = json.loads(package or "{}")
    cur = json.loads(current) if current and current.strip() else {}
    if not isinstance(pkg, dict) or not isinstance(cur, dict):
        raise ValueError("mcp.json 형식이 올바르지 않습니다")  # i18n-ignore: 요청 결과로 기록하는 문장(저장)
    out = dict(cur)
    for key, val in pkg.items():
        out[key] = {**out[key], **val} if isinstance(val, dict) and isinstance(out.get(key), dict) else val
    return json.dumps(out, ensure_ascii=False, indent=2)


# ---- 덮기 전 백업(R8) ------------------------------------------------------------------------------

def backup_dir() -> Path:
    d = store.data_dir() / "market" / "backups"
    d.mkdir(parents=True, exist_ok=True)
    return d


def backup(root, request_id: str, rels: list[str]) -> str:
    """덮일 폴더·파일을 tar.gz 로 AAS 볼륨에 남긴다. 파일 이름을 돌려준다. 남길 것이 없으면 빈 문자열. 크기 한도를 넘거나 쓰지 못하면 OSError(요청을 멈춘다)."""
    buf, total = io.BytesIO(), 0
    with tarfile.open(fileobj=buf, mode="w:gz") as tar:
        for rel in rels:
            base = root / rel
            files = [base] if base.is_file() else [f for f in sorted(base.rglob("*")) if f.is_file()] if base.is_dir() else []   # 읽지 못하면 OSError — 백업 없이 덮지 않는다
            for f in files:
                name = str(f.relative_to(root)).strip("/")
                if is_runtime(Path(name)):
                    continue
                data = f.read_bytes()
                total += len(data)
                if total > MAX_BACKUP:
                    raise OSError(f"백업이 너무 큽니다({MAX_BACKUP // 2**20}MiB 초과)")  # i18n-ignore: 요청 결과로 기록하는 문장(저장)
                info = tarfile.TarInfo(name)
                info.size, info.mtime, info.mode = len(data), int(time.time()), 0o644
                tar.addfile(info, io.BytesIO(data))
    if not total:
        return ""
    name = f"{request_id}.tar.gz"
    tmp = backup_dir() / (name + ".tmp")
    tmp.write_bytes(buf.getvalue())
    tmp.rename(backup_dir() / name)
    purge_backups()
    return name


def purge_backups(days: int = BACKUP_DAYS) -> int:
    """기한이 지난 백업을 지운다. 지운 개수."""
    cutoff, n = time.time() - days * 86400, 0
    for p in backup_dir().glob("*.tar.gz"):
        try:
            if p.stat().st_mtime < cutoff:
                p.unlink()
                n += 1
        except OSError:
            continue
    return n

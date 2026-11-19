# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""내 스킬을 마켓에 올린다(스펙 2026-10-14-015 T5, 리뷰 R4·R10·R11): 올리기 요청 → 관리자 승인 → AAS 가 SkillHub 에 바로 게시.

  요청     사용자가 쓰던 스킬 폴더를 묶음으로 만들어 AAS 에 저장한다(폴더 안 일반 파일만, 점 파일·링크 제외, 크기 한도, 비밀값 검사).
  승인     관리자가 네임스페이스를 고르고 승인하면 SkillHub publish API 로 올린다. 응답 상태(published/pending_review)를 그대로 적는다.
  보관     올린 묶음(zip)은 AAS 볼륨에 판별로 남겨 내려받을 수 있다. 레포(cogentai-aas-marketplace)로 옮기는 것은 사람이 한다.

요청·결과는 data/market/publish/<id>.json, 묶음은 같은 이름의 .zip 이다. Hermes 의 파일은 읽기만 한다.
"""
from __future__ import annotations

import contextlib
import fcntl
import hashlib
import io
import json
import re
import secrets
import urllib.error
import urllib.parse
import urllib.request
import time
import uuid
import zipfile
from datetime import datetime
from pathlib import Path

from ..assets import files as asset_files, skill_origin
from ..common import store
from ..common.i18n import tr
from ..common.redact import redact
from . import marketplace, skill_keep
from .marketplace import NAME, VERSION, MarketError

MAX_FILES = 200
MAX_BYTES = 5 * 2**20
MAX_FILE_BYTES = 1 * 2**20
ALLOWED_ORIGINS = ("local", "agent", "bundled_modified", "market")
# Slack·Google·JWT·GitHub 를 더했다(스펙 2026-10-28-001 R18 — 주인 스킬 자동 승인으로 관리자 검토 없이 게시될 수 있어서)
SECRET = re.compile(r"(glpat-[\w-]{20,}|sk_[A-Za-z0-9]{24,}|sk-[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----"
                    r"|xox[abp]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{35}|eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}"
                    r"|gh[pousr]_[A-Za-z0-9]{36})")
_RID = re.compile(r"^\d{20}-[0-9a-f]{6}\Z")
VISIBILITY = {"free": "PUBLIC"}                       # 그 밖의 네임스페이스는 구성원만(marketplace.json 의 paid 와 같다)
ADMIN_ORIGIN = "admin_upload"                          # 관리자가 zip 으로 바로 게시한 기록(스펙 2026-10-29-002)
STALE_PUBLISHING = 600                                # 게시 중(publishing)이 이만큼(초) 넘으면 결과를 모르는 실패로 본다(R9)


def _now() -> str:
    return datetime.now().astimezone().isoformat(timespec="seconds")


def _dir() -> Path:
    d = store.data_dir() / "market" / "publish"
    d.mkdir(parents=True, exist_ok=True)
    return d


def _write(row: dict) -> dict:
    tmp = _dir() / (row["id"] + ".tmp")
    tmp.write_text(json.dumps(row, ensure_ascii=False), encoding="utf-8")
    tmp.rename(_dir() / (row["id"] + ".json"))
    return row


@contextlib.contextmanager
def name_lock(name: str):
    """같은 패키지 이름의 게시 요청·직접 게시·승인·숨기기를 서버 사이에서도 하나씩(스펙 2026-10-29-002 R9·R15).
    공유 데이터 폴더(NFS)의 flock 은 읽기로도 연 파일이어야 해 "a+" 로 연다."""
    d = store.data_dir() / "market" / "publish-locks"     # 기록 폴더(publish/)와 따로 — 기록 폴더는 파일만 둔다
    d.mkdir(parents=True, exist_ok=True)
    with open(d / f"{name if NAME.match(name or '') else '_'}.lock", "a+") as fh:
        fcntl.flock(fh, fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(fh, fcntl.LOCK_UN)


def stale(row: dict) -> bool:
    """게시 중인데 STALE_PUBLISHING 을 넘긴 관리자 직접 게시 — 프로세스가 죽었거나 허브 응답을 못 받았다."""
    if row.get("status") != "publishing":
        return False
    try:
        return time.time() - datetime.fromisoformat(str(row.get("ts"))).timestamp() > STALE_PUBLISHING
    except ValueError:
        return True


def _view(row: dict) -> dict:
    """화면에 보일 기록. 오래된 publishing 은 「결과 모름」 실패로 보인다(디스크 값은 그대로, R9)."""
    out = {**row, "message": redact(str(row.get("message") or ""), 600)}
    if stale(row):
        out.update(status="failed", stale=True, message=tr("게시 결과를 모름 — 허브에서 버전을 확인하세요", "Publish result unknown — check the version in the skill hub"))
    return out


def get(rid: str) -> dict | None:
    if not _RID.match(rid or ""):
        return None
    try:
        return json.loads((_dir() / (rid + ".json")).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def requests(pod: str | None = None) -> list[dict]:
    rows = []
    for p in _dir().glob("*.json"):
        row = get(p.stem)
        if row and (pod is None or row.get("pod") == pod):
            rows.append(_view(row))
    return sorted(rows, key=lambda r: r["id"], reverse=True)


def bundle_path(rid: str) -> Path | None:
    p = _dir() / (rid + ".zip")
    return p if _RID.match(rid or "") and p.is_file() else None


# ---- 묶음 만들기 ------------------------------------------------------------------------------------

# 스킬 묶음(허브 게시·AI 에이전트 템플릿·내려받기)에서 빼는 실행 기록 이름(스펙 2026-11-18-019 D4·R1). 스킬 폴더 바로 아래의 폴더일 때만
# 뺀다 — cache·sessions 는 스킬이 미리 만든 색인·예시를 담는 이름으로도 쓰여 깊은 곳은 담는다. mcp-tokens 만 어느 깊이든 뺀다.
# 의존성 이름은 skill_keep.dependency_names()(018, 어느 깊이든). 두 이름은 깊이 규칙이 달라 하나로 합치지 않는다(019 Eng F8).
# 운영자 AAS_TREE_SKIP_DIRS_EXTRA 는 사이드카 성능 설정이라 묶음 내용에 쓰지 않는다(019 D6 — 설치마다 같은 스킬이 다른 묶음이 되지 않게).
RUN_LOG_DIRS = frozenset({"logs", "cache", "sessions", "terminal-sessions", "mcp-tokens"})
ANY_DEPTH_RUN_LOG = frozenset({"mcp-tokens"})


def run_log_dirs() -> frozenset[str]:
    return RUN_LOG_DIRS


def _scan(folder, incomplete: list) -> tuple[list[tuple[str, object]], list[str]]:
    """스킬 폴더를 훑어 (담을 후보 [(상대 경로, 경로)], 뺀 폴더·파일 [상대 경로]) 를 돌려준다. 파일을 읽기 전에 끝낸다 — 한도 오류가 나도
    뺀 목록이 완전하다(019 Eng F3).
    - 의존성·실행 기록 이름·실행 부산물·사이드카가 안 보는 점 이름은 훑기 skip 에 넣어 원격에서 그 안을 사이드카에 묻지 않는다. 실행 기록
      이름을 skip 에서 빼면 logs/ 하나만 있어도 사이드카가 묶음에서 안 보는 폴더(partial)를 만나 스킬 전체가 대체 길로 간다(019 Eng F1).
    - skip 에 걸린 것 중 깊이 2 이상의 실행 기록 이름 폴더는 그 폴더만 다시 훑어 담고, 같은 이름의 파일은 그대로 담는다(D4).
    - 원격에서 묶음이 답하지 못하면(대체 길) 사이드카에는 실행 기록 이름을 빼고 묻고(fallback_skip), 깊이 규칙은 여기서 적용한다.
      건너뛴 이름을 찾으려고 폴더마다 다시 묻지 않으며(skipped_probe=False), 대체 길로 간 것은 incomplete 에 남는다(019 R7).
      깊은 같은 이름 폴더를 다시 훑을 때는 사이드카가 그 폴더 안을 늘 보지 않아 언제나 대체 길로 간다 — 이것은 incomplete 로 치지 않는다
      (치면 cache·sessions 가 든 스킬마다 「목록이 완전하지 않을 수 있다」가 붙었다, OKE 실화면 2026-11-18). 그 안의 의존성 폴더는 목록에 안 나올 수 있다."""
    from ..hermes.readers import remote
    deps = skill_keep.dependency_names()
    dots = frozenset(n for n in remote.TREE_SKIP_DIRS if n.startswith("."))
    runtime = frozenset(skill_keep.RUNTIME_DIRS)
    skip = runtime | deps | RUN_LOG_DIRS | dots
    opts = {} if isinstance(folder, Path) else {"skipped_probe": False, "incomplete": incomplete,
                                                 "fallback_skip": runtime | deps | ANY_DEPTH_RUN_LOG | dots}
    entries: list[tuple[str, object]] = []
    gone: list[str] = []
    queue = [("", folder)]
    while queue:
        prefix, base = queue.pop()
        found: set = set()
        call = opts if not prefix or not opts else {**opts, "incomplete": []}
        for p in remote.search_rglob(base, "*", skip, skipped=found, **call):
            entries.append((prefix + Path(str(p.relative_to(base))).as_posix(), p))
        for s in sorted(found):
            rel = prefix + s
            parts = rel.split("/")
            if any(x.startswith(".") for x in parts[:-1]):
                continue                                   # 점 폴더 안 — 어차피 통째로 빠진다
            name = parts[-1]
            if name in RUN_LOG_DIRS and name not in ANY_DEPTH_RUN_LOG:
                target = base / s
                if not target.is_dir():
                    entries.append((rel, target))          # 같은 이름의 파일은 담는다
                    continue
                if len(parts) >= 2:
                    queue.append((rel + "/", target))      # 깊은 같은 이름 폴더는 담는다 — 그 폴더만 다시 훑는다
                    continue
            gone.append(rel)
    keep = []
    for rel, p in entries:                                 # 대체 길·다시 훑기 결과에도 깊이 규칙을 적용한다
        parts = rel.split("/")
        if parts[0] in RUN_LOG_DIRS and parts[0] not in ANY_DEPTH_RUN_LOG and (len(parts) > 1 or p.is_dir()):
            if len(parts) == 1:
                gone.append(rel)
            continue
        cut = next((i for i, x in enumerate(parts[:-1]) if x in ANY_DEPTH_RUN_LOG), None)
        if cut is not None:
            gone.append("/".join(parts[:cut + 1]))
            continue
        keep.append((rel, p))
    shown = sorted({g for g in gone if not g.split("/")[-1].startswith(".") and g.split("/")[-1] not in runtime})
    return sorted(keep, key=lambda e: e[0]), shown


def skipped_line(skipped: list[str], incomplete: list | None = None) -> dict | None:
    """뺀 폴더·파일을 알리는 한 줄(019 R7): {message, paths(전체), doc}. 문장에는 앞 5개와 「외 N개」만 적는다. 뺀 것이 없고 대체 길도 아니면 None."""
    names = list(skipped)
    if not names and not incomplete:
        return None
    parts = []
    if names:
        head = ", ".join(names[:5]) + (tr(f" 외 {len(names) - 5}개", f" and {len(names) - 5} more") if len(names) > 5 else "")
        parts.append(tr(f"담지 않은 폴더·파일: {head}", f"Folders and files left out: {head}"))
    last = [n.split("/")[-1] for n in names]
    if any(n in skill_keep.dependency_names() for n in last):
        parts.append(tr("받는 쪽에서 의존성을 설치해야 동작합니다(requirements.txt·설치 스크립트를 스킬에 넣으세요)",
                        "The receiver must install the dependencies (put requirements.txt or a setup script in the skill)"))
    if any(n in RUN_LOG_DIRS - ANY_DEPTH_RUN_LOG for n in last):
        parts.append(tr("실행 기록 폴더를 담으려면 data/logs/ 처럼 한 단계 아래로 옮기세요",
                        "To include a run-log folder, move it one level down, such as data/logs/"))
    if incomplete:
        parts.append(tr("원격에서 일부 폴더를 확인하지 못해 목록이 완전하지 않을 수 있습니다",
                        "Some remote folders could not be checked, so the list may be incomplete"))
    doc = tr("manual/user-guide/chapters/407-profile-templates.md#템플릿에-들어가지-않는-것",
             "manual/user-guide/chapters/407-profile-templates.en.md#what-a-template-never-includes")
    return {"message": " — ".join(parts), "paths": names, "doc": doc}


def collect(folder, excluded: list[str] | None = None, skipped: list[str] | None = None,
            incomplete: list | None = None) -> list[tuple[str, bytes]]:
    """스킬 폴더 안의 일반 파일만 모은다(R4). 링크·점 파일·폴더 밖·너무 큰 것·비밀값이 든 것은 MarketError.
    excluded 를 주면(내려받기, OMAI-1195 R4) 비밀값이 든 파일은 거절하지 않고 빼서 그 이름을 excluded 에 담는다.
    의존성 폴더(어느 깊이든)와 스킬 바로 아래 실행 기록 폴더는 담지 않는다(스펙 2026-11-18-019). skipped 를 주면 뺀 폴더·파일을,
    incomplete 를 주면 원격 대체 길로 간 경로를 담는다 — 돌려주는 값이 아니라 채우는 인자인 것은 MarketError 로 실패해도 쓰기 위해서다."""
    out, total = [], 0
    local = isinstance(folder, Path)          # 사이드카 경로(RemotePath)는 사이드카가 링크를 따라가지 않고 폴더 밖을 막는다
    entries, gone = _scan(folder, incomplete if incomplete is not None else [])
    if skipped is not None:
        skipped.extend(gone)
    for rel_s, f in entries:
        rel = Path(rel_s)
        if any(part.startswith(".") for part in rel.parts) or skill_keep.is_runtime(rel):
            continue
        if local and f.is_symlink():
            raise MarketError(tr(f"심볼릭 링크는 올릴 수 없습니다: {rel.as_posix()}", f"Symbolic links cannot be published: {rel.as_posix()}"))
        if not f.is_file():
            continue
        data = f.read_bytes()
        if len(data) > MAX_FILE_BYTES:
            raise MarketError(tr(f"파일이 너무 큽니다({rel.as_posix()}, 한도 {MAX_FILE_BYTES // 2**20}MiB)", f"File too large: {rel.as_posix()}"))
        text = data.decode("utf-8", errors="ignore")
        if SECRET.search(text) or asset_files.has_secrets(text):
            if excluded is not None:
                excluded.append(rel.as_posix())
                continue
            raise MarketError(tr(f"비밀값으로 보이는 문자열이 있어 올릴 수 없습니다: {rel.as_posix()}", f"It looks like it contains a secret, so it cannot be published: {rel.as_posix()}"))
        total += len(data)
        out.append((rel.as_posix(), data))
        if len(out) > MAX_FILES or total > MAX_BYTES:
            raise MarketError(tr(f"파일이 너무 많거나 큽니다(최대 {MAX_FILES}개, {MAX_BYTES // 2**20}MiB)", "Too many or too large files"))
    if not any(r == "SKILL.md" for r, _ in out):
        raise MarketError(tr("SKILL.md 가 없습니다", "SKILL.md is missing"))
    return out


def set_header(text: str, **fields: str) -> str:
    """SKILL.md 머리말의 한 줄짜리 키를 바꾸거나 더한다. 머리말이 없으면 MarketError."""
    if not text.startswith("---\n"):
        raise MarketError(tr("SKILL.md 는 --- 로 시작하는 머리말이 있어야 합니다", "SKILL.md must start with a --- header"))
    head, sep, body = text[4:].partition("\n---")
    if not sep:
        raise MarketError(tr("SKILL.md 머리말이 닫히지 않았습니다", "The SKILL.md header is not closed"))
    lines = head.split("\n")
    for key, val in fields.items():
        line = f"{key}: {val}"
        idx = next((i for i, ln in enumerate(lines) if re.match(rf"^{re.escape(key)}\s*:", ln)), None)
        if idx is None:
            lines.append(line)
        else:
            lines[idx] = line
    return "---\n" + "\n".join(lines) + "\n---" + body


def header_of(text: str) -> dict:
    out = {}
    if text.startswith("---\n"):
        for line in text[4:].split("\n---", 1)[0].splitlines():
            m = re.match(r"^([A-Za-z_][\w-]*):\s*(.*)$", line)
            if m:
                out[m.group(1)] = m.group(2).strip().strip("\"'")
    return out


def zip_of(files: list[tuple[str, bytes]]) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        for rel, data in files:
            z.writestr(rel, data)
    return buf.getvalue()


def _unzip(blob: bytes) -> list[tuple[str, bytes]]:
    with zipfile.ZipFile(io.BytesIO(blob)) as z:
        return [(n, z.read(n)) for n in z.namelist() if not n.endswith("/")]


def public_author(value: str) -> str:
    """머리말 author 값에서 이메일을 뺀 이름. 「이름 <메일>」이면 이름, 메일만이면 @ 앞(2026-10-28 사용자 결정 B)."""
    v = str(value or "").strip().strip("\"'")
    name = re.sub(r"\s*<[^>]*>", "", v).strip()
    return name.split("@", 1)[0] if "@" in name else name


def _public_files(files: list[tuple[str, bytes]]) -> list[tuple[str, bytes]]:
    """공개 게시본: SKILL.md 머리말 author 의 이메일을 지운다. AAS 가 만들 때 넣는 줄이라 그것만으로 직원 스킬의 공개 게시가 모두 막혔다."""
    out = []
    for rel, data in files:
        if rel == "SKILL.md":
            text = data.decode("utf-8", errors="replace")
            author = header_of(text).get("author", "")
            if "@" in author:
                text = set_header(text, author=f'"{public_author(author)}"')
            data = text.encode("utf-8")
        out.append((rel, data))
    return out


# ---- 요청 -------------------------------------------------------------------------------------------

def _exists(name: str) -> dict | None:
    """SkillHub 의 설정된 네임스페이스에 같은 이름이 있으면 {namespace, version}, 없으면 None. 조회가 실패하면 MarketError."""
    for ns in marketplace.settings()["namespaces"]:
        try:
            info = marketplace.fetch(f"/api/v1/skills/{ns}/{name}")
        except MarketError as exc:
            if exc.code == 404:
                continue
            raise
        if info:
            return {"namespace": ns, "version": str((info.get("publishedVersion") or {}).get("version") or "")}
    return None


def _exists_readonly(name: str) -> str:
    """읽기 전용 네임스페이스(공개 미러 community 등)에 같은 이름이 있으면 그 네임스페이스, 없으면 빈 값(스펙 2026-10-29-002 R11)."""
    for ns in marketplace.settings().get("readonly") or []:
        try:
            if marketplace.fetch(f"/api/v1/skills/{ns}/{name}"):
                return ns
        except MarketError as exc:
            if exc.code == 404:
                continue
            raise
    return ""


def _newer(a: str, b: str) -> bool:
    return marketplace._ver(a) > marketplace._ver(b)


def request_publish(pod_id: str, home, who: str, admin: bool, profile: str, skill_path: str, name: str, version: str, namespace: str = "",
                    declare_env: list[str] | None = None) -> dict:
    """올리기 요청을 검사하고 묶음과 함께 저장한다. 검사에 걸리면 MarketError(저장하지 않는다).
    namespace 는 원하는 곳(자동 승인 때 쓴다, 표시 이름도 받아 slug 로 저장 — 스펙 2026-10-28-010 D7). hash 는 set_header 전 묶음의 해시 — 만든 기록과 견준다(D11)."""
    namespace = marketplace.ns_slug(namespace) if namespace else ""
    if namespace and namespace not in marketplace.settings()["namespaces"]:
        raise MarketError(tr("이 스킬 허브에서 다루지 않는 네임스페이스입니다", "This skill hub does not serve that namespace"))
    if not marketplace.PROFILE.match(profile or "") and profile != "default":
        raise MarketError(tr("프로파일 이름이 올바르지 않습니다", "The profile name is not valid"))
    if not NAME.match(name or ""):
        raise MarketError(tr("스킬 이름은 소문자·숫자·하이픈으로 2~63자로 적습니다(원본 스킬 이름은 그대로 둡니다)", "Write the skill name with lowercase letters, digits, and hyphens (2-63 characters)"))
    if not VERSION.match(version or ""):
        raise MarketError(tr("버전은 1.2.3 꼴이어야 합니다", "The version must look like 1.2.3"))
    parts = skill_keep.profile_rel(profile, skill_path)  # 기록에는 떼어 낸 프로파일 기준 경로가 남는다(화면의 r.path === inRoot 비교)
    if parts is None:
        raise MarketError(tr("스킬 폴더 경로가 올바르지 않습니다", "The skill folder path is not valid"))
    rel = "/".join(parts)
    root = skill_keep.profile_root(home, profile)
    folder = root / rel
    try:
        if skill_keep.escapes(root, folder):
            raise MarketError(tr("스킬 폴더 경로가 올바르지 않습니다", "The skill folder path is not valid"), 400)
        if not folder.is_dir() or not (folder / "SKILL.md").is_file():
            raise MarketError(tr("그 프로파일에 이 스킬 폴더가 없습니다", "That skill folder is not in the profile"), 404)
        skill_name = skill_keep.skill_name(folder)
        origin = skill_origin.origin(skill_origin.Facts(root), skill_name, rel, folder)
        files = collect(folder)
    except OSError as exc:
        raise MarketError(tr(f"스킬 폴더를 읽지 못했습니다: {type(exc).__name__}", f"Could not read the skill folder: {type(exc).__name__}"), 503) from None
    if origin not in ALLOWED_ORIGINS:
        raise MarketError(tr("Hermes 기본 스킬(고치지 않은 것)과 허브 스킬은 올릴 수 없습니다", "Unmodified Hermes built-in skills and hub skills cannot be published"))
    derived = ""
    if origin == "bundled_modified":
        derived = f"hermes-bundled:{skill_name}"
    elif origin == "market":
        have = next((r for r in marketplace.installed(pod_id) if r["profile"] == profile and r["kind"] == "skill" and r["name"] == parts[-1]), None)
        if not have:
            raise MarketError(tr("스킬 허브 설치 기록이 없어 원본을 확인할 수 없습니다", "No skill hub install is recorded, so the original cannot be verified"))
        try:
            paid = bool(marketplace.package(have["namespace"], have["name"])["paid"])
        except MarketError:
            raise MarketError(tr("원본 스킬이 허용이 필요한 스킬인지 확인하지 못해 올릴 수 없습니다", "Could not confirm whether the original skill is restricted")) from None
        if paid:
            raise MarketError(tr("허용이 필요한 스킬을 고친 것은 올릴 수 없습니다", "A modified restricted skill cannot be published"))
        derived = f"{have['namespace']}/{have['name']}@{have['version']}"
    declare = [e for e in dict.fromkeys(str(x) for x in declare_env or []) if ENV_NAME.match(e)][:20]
    with name_lock(name):
        return _request_locked(pod_id, who, admin, profile, rel, name, version, namespace, origin, derived, files, declare)


def _request_locked(pod_id: str, who: str, admin: bool, profile: str, rel: str, name: str, version: str, namespace: str,
                    origin: str, derived: str, files: list[tuple[str, bytes]], declare: list[str] | None = None) -> dict:
    prior = [r for r in requests() if r["name"] == name and r["status"] in ("published", "pending_review")]
    if any(r["status"] in ("requested", "publishing") and not r.get("stale") for r in requests() if r["name"] == name):
        raise MarketError(tr("같은 이름의 게시 요청이 이미 기다리고 있습니다", "A publish request with that name is already waiting"), 409)
    there = _exists(name)
    if there:
        mine = any(r["who"] == who for r in prior) or admin
        if not mine:
            raise MarketError(tr("스킬 허브에 같은 이름의 스킬이 이미 있습니다 — 다른 이름을 쓰세요", "A skill with that name already exists in the skill hub. Use another name"), 409)
        if not _newer(version, there["version"]):
            raise MarketError(tr(f"스킬 허브의 버전({there['version']})보다 큰 버전이어야 합니다", f"The version must be newer than the skill hub's ({there['version']})"), 409)
    elif prior and not any(_newer(version, r["version"]) for r in prior[:1]):
        raise MarketError(tr(f"이미 올린 버전({prior[0]['version']})보다 큰 버전이어야 합니다", "The version must be newer than the one already published"), 409)
    if _exists_readonly(name):                                     # 공개 미러와 같은 이름은 새 판 알림을 멈추게 한다(R11, 2026-10-29 의도한 변화)
        raise MarketError(tr("공개 미러에 같은 이름이 있습니다 — 다른 이름을 쓰세요", "The public mirror has a package with that name. Use another name"), 409)
    md = dict(files)["SKILL.md"].decode("utf-8", errors="replace")
    fm = header_of(md)
    if len(fm.get("description", "")) < 20:
        raise MarketError(tr("SKILL.md 의 description 은 20자 이상이어야 합니다", "The description in SKILL.md must be at least 20 characters"))
    from . import publish_auto
    digest = publish_auto.bundle_hash(files)
    refs = publish_auto.internal_refs(files, publish_auto.config(marketplace.settings()["namespaces"])["domains"])
    extra = {"name": name, "version": version}
    if derived:
        extra["derived_from"] = derived
    # 관리 이름(LLM_*)은 화면이 보낸 declare_env 와 상관없이 같은 계산으로 다시 구한다 — 점검 미리 보기와 올라간 머리말이
    # 같다(스펙 2026-11-19-002 §4-2 #4). 덧붙일 수 없으면 점검과 같은 문구로 거절한다
    from ..assets import skill_setup
    general = [n for n in declare or [] if not skill_setup.is_aas_managed(n)]
    md = apply_env_declare(md, general, managed_add_of(md, env_reads(files)))
    files = [(r, set_header(md, **extra).encode("utf-8") if r == "SKILL.md" else d) for r, d in files]
    rid = datetime.now().strftime("%Y%m%d%H%M%S%f") + "-" + secrets.token_hex(3)
    (_dir() / (rid + ".zip")).write_bytes(zip_of(files))
    return _write({"id": rid, "ts": _now(), "who": who, "pod": pod_id, "profile": profile, "path": rel, "name": name, "version": version,
                   "origin": origin, "derived_from": derived, "description": fm.get("description", "")[:240],
                   "files": [{"path": r, "size": len(d)} for r, d in files], "status": "requested", "message": "",
                   "hash": digest, "want_namespace": namespace, "internal_refs": refs})


# ---- 게시 전 점검(쓰지 않는다) -------------------------------------------------------------------------
# 「점검 → 미리보기 → 게시」: 요청과 같은 검사를 모두 돌려 걸리는 것을 한 번에 보이고, 묶음에 들어갈 파일과
# SKILL.md 머리말이 어떻게 바뀌는지 보여 준다. 아무것도 저장하지 않는다.

ENV_NAME = re.compile(r"^[A-Z][A-Z0-9_]{2,63}\Z")
# 코드가 읽는 환경변수(연결도 flow.py 와 같은 모양). 셸·실행 환경 변수는 비밀값이 아니다
_ENV_READ = [re.compile(r"os\.environ(?:\.get)?\s*[\[(]\s*[\"']([A-Z][A-Z0-9_]{2,})[\"']"),
             re.compile(r"os\.getenv\(\s*[\"']([A-Z][A-Z0-9_]{2,})[\"']"),
             re.compile(r"process\.env\.([A-Z][A-Z0-9_]{2,})"),
             re.compile(r"\$\{([A-Z][A-Z0-9_]{2,})[}:]")]
_ENV_NOISE = {"PATH", "HOME", "PWD", "USER", "SHELL", "LANG", "TZ", "IFS", "PYTHONPATH", "TMPDIR", "TERM", "NODE_ENV", "DEBUG", "LOG_LEVEL"}
_CODE_EXT = (".py", ".sh", ".bash", ".js", ".mjs", ".cjs", ".ts")


def env_reads(files: list[tuple[str, bytes]]) -> dict[str, list[str]]:
    """스크립트가 읽는 환경변수 이름 → 그 파일들. HERMES_* 는 Hermes 가 채우는 값이라 뺀다."""
    out: dict[str, list[str]] = {}
    for rel, data in files:
        if not rel.lower().endswith(_CODE_EXT):
            continue
        text = data.decode("utf-8", errors="ignore")
        for pat in _ENV_READ:
            for name in pat.findall(text):
                if name in _ENV_NOISE or name.startswith(("HERMES_", "AAS_")):
                    continue
                where = out.setdefault(name, [])
                if rel not in where:
                    where.append(rel)
    return dict(sorted(out.items()))


def _declare_fields(md: str, declare: list[str]) -> dict:
    """빠진 필수 환경변수 선언을 머리말 한 줄로 더한다. 이미 그 키가 있으면(여러 줄 목록일 수 있다) 건드리지 않는다."""
    if not declare or "required_environment_variables" in header_of(md):
        return {}
    from ..assets import skill_setup
    have = {e["name"] for e in skill_setup.required_env(skill_setup.frontmatter(md))}
    add = [e for e in declare if e not in have]
    return {"required_environment_variables": "[" + ", ".join(add) + "]"} if add else {}


# ---- AAS 가 주는 LLM 접속값의 선언(스펙 2026-11-19-002 §4-2 #4, OMAI-2123) --------------------------------------
# Hermes 는 스킬이 선언한 이름만 파드의 HERMES_LLM_* 값으로 잇는다. 그래서 코드가 LLM_BASE_URL·LLM_API_KEY·LLM_MODEL 을
# 읽으면 이미 선언 목록이 있어도 그 목록에 덧붙인다. 덧붙일 수 없으면 게시를 막는다(받는 쪽마다 빈 값을 받으므로).
_REQ_KEY = "required_environment_variables"


def managed_add_of(md: str, reads) -> list[str]:
    """코드가 읽지만 선언하지 않은 LLM 접속값 이름(LLM_* 셋만 — HERMES_LLM_* 는 더하지 않는다)."""
    from ..assets import skill_setup
    declared = {e["name"] for e in skill_setup.required_env(skill_setup.frontmatter(md))}
    return [n for n in skill_setup.AAS_LLM_ALIAS if n in reads and n not in declared]


def hermes_llm_reads(files: list[tuple[str, bytes]]) -> list[str]:
    """코드가 직접 읽는 HERMES_LLM_* 이름(env_reads 는 HERMES_ 를 빼므로 따로 찾는다)."""
    from ..assets import skill_setup
    found: set[str] = set()
    for rel, data in files:
        if not rel.lower().endswith(_CODE_EXT):
            continue
        text = data.decode("utf-8", errors="ignore")
        for pat in _ENV_READ:
            found |= {n for n in pat.findall(text) if n.startswith("HERMES_LLM_") and skill_setup.is_aas_managed(n)}
    return sorted(found)


def managed_fix_lines(add: list[str]) -> str:
    return "\n".join(f"- {n}" for n in add)


def _managed_error(add: list[str]) -> str:
    lines = managed_fix_lines(add)
    return tr(f"코드가 읽는 LLM 접속값을 선언에 더해야 AAS 가 줍니다. `required_environment_variables` 목록에 이 줄을 더하세요:\n{lines}",
              f"Declare the LLM connection values the code reads so AAS can provide them. Add these lines to the `required_environment_variables` list:\n{lines}")


def _append_managed(md: str, add: list[str]) -> str:
    """머리말에 이미 있는 required_environment_variables 목록에 관리 이름을 덧붙인다.
    한 줄 꼴([A, B])이면 그 목록에, 여러 줄 꼴(- A 줄들)이면 마지막 항목 뒤에 같은 들여쓰기로 더한다. 덧붙인 뒤 머리말을
    YAML 로 다시 읽어 이름 목록(문자열이나 name: 을 가진 항목)이고 더한 이름이 들었는지 본다 — 항목이 여러 줄 사전이면
    붙인 줄이 사전 안으로 들어가 깨질 수 있어서다. 두 꼴이 아니거나 확인에 실패하면 MarketError."""
    from ..assets import skill_setup
    head, sep, body = md[4:].partition("\n---")
    lines = head.split("\n")
    idx = next((i for i, ln in enumerate(lines) if re.match(rf"^{_REQ_KEY}\s*:", ln)), None)
    if idx is None:
        raise MarketError(_managed_error(add))
    rest = lines[idx].split(":", 1)[1].strip()
    if rest.startswith("[") and rest.endswith("]"):
        inner = rest[1:-1].strip().rstrip(",").strip()
        lines[idx] = f"{_REQ_KEY}: [" + ", ".join(([inner] if inner else []) + add) + "]"
    elif not rest:
        last, indent = None, None
        for j in range(idx + 1, len(lines)):
            m = re.match(r"^(\s*)-(\s|$)", lines[j])
            if not m or (indent is not None and m.group(1) != indent):
                break
            last, indent = j, m.group(1)
        if last is None:
            raise MarketError(_managed_error(add))
        lines[last + 1:last + 1] = [f"{indent}- {n}" for n in add]
    else:
        raise MarketError(_managed_error(add))
    out = "---\n" + "\n".join(lines) + "\n---" + body
    raw = skill_setup.frontmatter(out).get(_REQ_KEY)
    ok = isinstance(raw, list) and all(isinstance(i, str) or (isinstance(i, dict) and i.get("name")) for i in raw)
    names = {i if isinstance(i, str) else str(i.get("name")) for i in raw} if ok else set()
    if not ok or not set(add) <= names:
        raise MarketError(_managed_error(add))
    return out


def apply_env_declare(md: str, declare: list[str], managed_add: list[str]) -> str:
    """머리말에 선언을 더한 SKILL.md. 목록이 없으면 한 줄(일반 이름 + 관리 이름), 있으면 관리 이름만 그 목록에 덧붙인다
    (일반 이름은 지금처럼 건드리지 않는다). 관리 이름을 덧붙일 수 없으면 MarketError."""
    if _REQ_KEY not in header_of(md):
        fields = _declare_fields(md, list(dict.fromkeys(list(declare) + list(managed_add))))
        return set_header(md, **fields) if fields else md
    return _append_managed(md, managed_add) if managed_add else md


def _bump(version: str) -> str:
    parts = (str(version or "0.0.0").split(".") + ["0", "0", "0"])[:3]
    try:
        return f"{int(parts[0])}.{int(parts[1])}.{int(parts[2]) + 1}"
    except ValueError:
        return "1.0.0"


def check_publish(pod_id: str, home, who: str, admin: bool, profile: str, skill_path: str, name: str = "", version: str = "",
                  usage: dict | None = None, hub: bool = True) -> dict:
    """게시 요청 전 점검. 반환: {ok, checks:[{id, level(pass|warn|fail), message}], name, version, files, excluded, env, header}.
    usage 는 그 프로파일 기준 스킬 상태(agent_skills: uses·last_used·readiness·cron 마지막 결과) — 「잘 동작했는가」 근거.
    hub 가 거짓이면 허브 조회(같은 이름·버전)를 건너뛴다(시험·허브 장애)."""
    checks: list[dict] = []

    def add(cid: str, level: str, message: str, **extra) -> None:
        checks.append({"id": cid, "level": level, "message": message, **extra})

    if not marketplace.PROFILE.match(profile or "") and profile != "default":   # 빈 profile 을 경로 오류로 알리면 원인을 못 찾는다
        raise MarketError(tr("프로파일 이름이 올바르지 않습니다", "The profile name is not valid"))
    parts = skill_keep.profile_rel(profile, skill_path)
    if parts is None:
        raise MarketError(tr("스킬 폴더 경로가 올바르지 않습니다", "The skill folder path is not valid"))
    rel = "/".join(parts)
    root = skill_keep.profile_root(home, profile)
    folder = root / rel
    excluded: list[str] = []
    skipped: list[str] = []
    incomplete: list = []
    try:
        if skill_keep.escapes(root, folder) or not folder.is_dir() or not (folder / "SKILL.md").is_file():
            raise MarketError(tr("그 프로파일에 이 스킬 폴더가 없습니다", "That skill folder is not in the profile"), 404)
        skill_name = skill_keep.skill_name(folder)
        origin = skill_origin.origin(skill_origin.Facts(root), skill_name, rel, folder)
        try:
            files = collect(folder, excluded, skipped, incomplete)
        except MarketError as exc:
            files = []
            add("files", "fail", str(exc))
    except OSError as exc:
        raise MarketError(tr(f"스킬 폴더를 읽지 못했습니다: {type(exc).__name__}", f"Could not read the skill folder: {type(exc).__name__}"), 503) from None

    name = name or re.sub(r"[^a-z0-9-]+", "-", skill_name.lower()).strip("-")[:63]
    md = dict(files).get("SKILL.md", b"").decode("utf-8", errors="replace")
    fm = header_of(md)
    if origin not in ALLOWED_ORIGINS:
        add("origin", "fail", tr("Hermes 기본 스킬(고치지 않은 것)과 허브에서 받은 스킬은 올릴 수 없습니다",
            "Unmodified Hermes built-in skills and skills installed from a hub cannot be published"))
    else:
        add("origin", "pass", tr("올릴 수 있는 출처입니다", "The skill's origin can be published"))
    if files:
        add("files", "pass", tr(f"파일 {len(files)}개, {sum(len(d) for _r, d in files) // 1024 + 1}KiB", f"{len(files)} files, {sum(len(d) for _r, d in files) // 1024 + 1} KiB"))
    line = skipped_line(skipped, incomplete)
    if line:                                               # warn 은 게시를 막지 않는다(스펙 2026-11-18-019 R7)
        add("skipped_dirs", "warn", line["message"], paths=line["paths"], doc=line["doc"])
    for f in excluded:
        add("secret", "fail", tr(f"비밀값으로 보이는 문자열이 있습니다: {f} — 값을 지우고 환경변수로 읽게 고치세요",
            f"Looks like it contains a secret: {f}. Remove the value and read it from an environment variable"))
    if not NAME.match(name or ""):
        add("name", "fail", tr("스킬 이름은 소문자·숫자·하이픈 2~63자입니다", "The skill name must be 2-63 lowercase letters, digits, or hyphens"))
    if md and not md.startswith("---\n"):
        add("header", "fail", tr("SKILL.md 는 --- 로 시작하는 머리말이 있어야 합니다", "SKILL.md must start with a --- header"))
    desc = fm.get("description", "")
    if len(desc) < 20:
        add("description", "fail", tr(f"description 이 {len(desc)}자입니다 — 20자 이상으로 무엇을 하는 스킬인지 적으세요",
            f"The description is {len(desc)} characters. Write at least 20 characters about what the skill does"))
    else:
        add("description", "pass", tr("설명이 있습니다", "The skill has a description"))

    hub_version = ""
    if hub and NAME.match(name or ""):
        try:
            if any(r["status"] in ("requested", "publishing") and not r.get("stale") for r in requests() if r["name"] == name):
                add("pending", "fail", tr("같은 이름의 게시 요청이 이미 기다리고 있습니다", "A publish request with that name is already waiting"))
            there = _exists(name)
            if there:
                hub_version = there["version"]
                prior = [r for r in requests() if r["name"] == name and r["status"] in ("published", "pending_review")]
                if not (admin or any(r["who"] == who for r in prior)):
                    add("hub_name", "fail", tr(f"스킬 허브({there['namespace']})에 같은 이름이 있습니다 — 다른 이름을 쓰세요",
                        f"The skill hub ({there['namespace']}) already has that name. Use another name"))
                else:
                    add("hub_name", "pass", tr(f"허브의 {there['namespace']}/{name} 새 버전으로 올립니다(지금 {hub_version})",
                        f"Publishes a new version of {there['namespace']}/{name} (now {hub_version})"))
            else:
                add("hub_name", "pass", tr("허브에 없는 새 이름입니다", "The name is new to the skill hub"))
            if _exists_readonly(name):
                add("mirror", "fail", tr("공개 미러에 같은 이름이 있습니다 — 다른 이름을 쓰세요", "The public mirror has that name. Use another name"))
        except MarketError as exc:
            add("hub", "warn", tr(f"스킬 허브를 확인하지 못했습니다: {exc}", f"Could not check the skill hub: {exc}"))
    version = version or (_bump(hub_version) if hub_version else (fm.get("version") if VERSION.match(fm.get("version") or "") else "1.0.0"))
    if not VERSION.match(version or ""):
        add("version", "fail", tr("버전은 1.2.3 꼴이어야 합니다", "The version must look like 1.2.3"))
    elif hub_version and not _newer(version, hub_version):
        add("version", "fail", tr(f"허브의 버전({hub_version})보다 커야 합니다", f"Must be newer than the hub's version ({hub_version})"))

    # 필요한 환경변수: 선언 ∪ 코드에서 읽는 것. 선언이 없으면 받는 쪽이 무엇을 채워야 하는지 모른다
    from ..assets import skill_setup
    declared = [e["name"] for e in skill_setup.required_env(skill_setup.frontmatter(md))]
    reads = env_reads(files)
    # 일반 이름은 env 줄, AAS 가 주는 LLM 접속값은 env_aas 줄로 나눈다(스펙 2026-11-19-002 §4-2 #4)
    undeclared = [n for n in reads if n not in declared and not skill_setup.is_aas_managed(n)]
    managed_add = managed_add_of(md, reads)
    general_declared = [n for n in declared if not skill_setup.is_aas_managed(n)]
    general_reads = [n for n in reads if not skill_setup.is_aas_managed(n)]
    if undeclared:
        add("env", "warn", tr(f"코드가 읽지만 선언하지 않은 환경변수: {', '.join(undeclared)} — 머리말에 선언을 더합니다",
            f"Read by the code but not declared: {', '.join(undeclared)}. The header will declare them"))
    elif general_declared or general_reads:
        add("env", "pass", tr("필요한 환경변수가 선언돼 있습니다", "The required environment variables are declared"))
    env_md, env_fail = md, ""
    if md.startswith("---\n") and "\n---" in md[4:]:
        try:
            env_md = apply_env_declare(md, undeclared, managed_add)
        except MarketError as exc:
            env_fail = str(exc)
    if env_fail:
        add("env_aas", "fail", env_fail, lines=managed_fix_lines(managed_add))
    elif managed_add:
        add("env_aas", "pass", tr(f"LLM 접속값은 AAS 가 줍니다(선언에 더함: {', '.join(managed_add)})",
            f"AAS provides the LLM connection values (added to the declaration: {', '.join(managed_add)})"))
    elif any(skill_setup.is_aas_managed(n) for n in declared) or any(skill_setup.is_aas_managed(n) for n in reads):
        add("env_aas", "pass", tr("LLM 접속값은 AAS 가 줍니다", "AAS provides the LLM connection values"))
    if hermes_llm_reads(files):
        add("env_aas", "warn", tr("LLM_BASE_URL·LLM_API_KEY·LLM_MODEL 이름으로 읽고 선언하세요. HERMES_LLM_* 는 AAS 내부 이름이라 바뀔 수 있고, "
                                  "선언하지 않으면 execute_code 에서 HERMES_LLM_API_KEY 는 빈 값입니다",
                                  "Read and declare them as LLM_BASE_URL, LLM_API_KEY, and LLM_MODEL. HERMES_LLM_* are internal AAS names that may change, "
                                  "and without a declaration HERMES_LLM_API_KEY is empty in execute_code"))
    try:
        refs = publish_auto_refs(files)
    except Exception:
        refs = []
    if refs:
        add("internal", "warn", tr(f"사내 주소·사설 IP 가 있습니다({len(refs)}곳) — 공개 네임스페이스에는 올라가지 않습니다",
            f"Internal addresses or private IPs found ({len(refs)}). It cannot go to a public namespace"))

    u = usage or {}
    outside = [str(x) for x in u.get("external_scripts") or []]
    if outside:                                                    # SKILL.md 가 부르는 폴더 밖 스크립트는 묶음에 들어가지 않는다 — 받는 쪽에서는 없다
        add("outside", "warn", tr(f"스킬 폴더 밖 스크립트 {len(outside)}개는 묶음에 들어가지 않습니다({', '.join(outside[:3])}) — 스킬 폴더 안으로 옮겨야 받는 쪽에서 동작합니다",
                                  f"{len(outside)} scripts outside the skill folder are not in the package ({', '.join(outside[:3])}). Move them into the skill folder so the skill works where it is installed"))
    failed = [c for c in u.get("cron") or [] if str(c.get("last_status") or "") not in ("", "ok", "success")]
    if failed:
        add("works", "warn", tr(f"이 스킬을 부르는 예약 작업이 최근에 실패했습니다: {', '.join(str(c.get('job')) for c in failed[:3])}",
            f"A scheduled job that runs this skill failed recently: {', '.join(str(c.get('job')) for c in failed[:3])}"))
    elif u.get("uses") or u.get("seen") or any(c.get("last_status") for c in u.get("cron") or []):
        add("works", "pass", tr(f"이 AI 에이전트가 {u.get('uses') or u.get('seen') or 0}번 썼습니다" + (f"(마지막 {str(u.get('last_used'))[:10]})" if u.get("last_used") else ""),
            f"This AI Agent used it {u.get('uses') or u.get('seen') or 0} times" + (f" (last {str(u.get('last_used'))[:10]})" if u.get("last_used") else "")))
    else:
        add("works", "warn", tr("이 AI 에이전트가 쓴 기록이 없습니다 — 한 번 돌려 보고 올리기를 권합니다",
            "This AI Agent has no record of using it. Run it once before publishing"))

    before = md.split("\n---", 1)[0][4:] if md.startswith("---\n") else ""
    after = before
    if md.startswith("---\n") and "\n---" in md[4:]:
        after = set_header(env_md, name=name, version=version).split("\n---", 1)[0][4:]
    return {"ok": not any(c["level"] == "fail" for c in checks), "checks": checks, "name": name, "version": version,
            "hub_version": hub_version, "origin": origin, "path": rel, "profile": profile,
            "files": [{"path": r, "size": len(d)} for r, d in files], "excluded": excluded,
            "env": {"declared": declared, "reads": reads, "undeclared": undeclared, "managed_add": managed_add},
            "header": {"before": before, "after": after}}


def publish_auto_refs(files: list[tuple[str, bytes]]) -> list[str]:
    from . import publish_auto
    return publish_auto.internal_refs(files, publish_auto.config(marketplace.settings()["namespaces"])["domains"])


# ---- 승인·반려·게시 ---------------------------------------------------------------------------------

def reject(rid: str, admin_who: str, reason: str) -> dict:
    row = get(rid)
    if not row or row["status"] != "requested":
        raise MarketError(tr("기다리는 게시 요청이 아닙니다", "That is not a waiting publish request"), 404)
    row.update(status="rejected", decided_by=admin_who, finished=_now(), message=(reason or tr("반려했습니다", "Rejected"))[:300])
    return _write(row)


def _post(namespace: str, name: str, version: str, blob: bytes, token: str | None = None) -> tuple[int, dict]:
    """token 을 주면 그 토큰으로(기본 스킬 묶음의 게시 전용 토큰, 스펙 2026-10-29-001 R13), 없으면 서버 토큰으로 게시한다."""
    cfg = marketplace.settings()
    mark = uuid.uuid4().hex
    body = (f'--{mark}\r\nContent-Disposition: form-data; name="visibility"\r\n\r\n{VISIBILITY.get(namespace, "NAMESPACE_ONLY")}\r\n'
            f'--{mark}\r\nContent-Disposition: form-data; name="file"; filename="{name}-{version}.zip"\r\nContent-Type: application/zip\r\n\r\n').encode()
    body += blob + f"\r\n--{mark}--\r\n".encode()
    req = urllib.request.Request(cfg["url"] + f"/api/v1/skills/{urllib.parse.quote(namespace)}/publish", data=body, method="POST",
                                 headers={"Accept": "application/json", "Content-Type": f"multipart/form-data; boundary={mark}"})
    token = token if token is not None else marketplace._token(cfg["token_file"])
    if token:
        req.add_header("Authorization", "Bearer " + token)
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            return resp.status, json.loads(resp.read() or b"{}")
    except urllib.error.HTTPError as exc:
        try:
            return exc.code, json.loads(exc.read() or b"{}")
        except ValueError:
            return exc.code, {}


def approve(rid: str, admin_who: str, namespace: str) -> dict:
    """관리자 승인 → SkillHub 에 게시한다. 결과 상태를 그대로 적는다: published / pending_review / failed(+이유).
    관리자 직접 게시 기록은 여기로 다시 보내지 않는다 — 스크립트 확인을 건너뛰게 된다(스펙 2026-10-29-002 R9·DD11)."""
    row = get(rid)
    if not row or row["status"] not in ("requested", "failed") or row.get("origin") == ADMIN_ORIGIN:   # 게시가 실패한 요청은 다시 승인할 수 있다
        raise MarketError(tr("기다리는 게시 요청이 아닙니다", "That is not a waiting publish request"), 404)
    namespace = marketplace.ns_slug(namespace)                    # 표시 이름(shared)도 받는다(스펙 2026-10-28-010 D7). 저장·게시 경로는 slug
    if namespace not in marketplace.settings()["namespaces"]:
        raise MarketError(tr("이 스킬 허브에서 다루지 않는 네임스페이스입니다", "This skill hub does not serve that namespace"))
    with name_lock(row["name"]):
        row = get(rid) or row
        if row["status"] not in ("requested", "failed"):
            raise MarketError(tr("기다리는 게시 요청이 아닙니다", "That is not a waiting publish request"), 404)
        return _publish(row, namespace, admin_who)


def _publish(row: dict, namespace: str, admin_who: str) -> dict:
    """보관한 묶음을 namespace 에 게시하고 결과를 기록에 적는다. 승인과 관리자 직접 게시가 같이 쓴다(R9). 이름 잠금 안에서 부른다."""
    rid = row["id"]
    blob = bundle_path(rid).read_bytes()
    if namespace in VISIBILITY:                           # 회사 밖에 공개되는 곳: author 의 이메일을 지우고(사용자 결정 B) 사내 주소가 남으면 거절(R18)
        from . import publish_auto
        files = _public_files(_unzip(blob))
        refs = publish_auto.internal_refs(files, publish_auto.config(marketplace.settings()["namespaces"])["domains"])
        if refs and not row.get("internal_refs_ack"):    # 템플릿을 올린 사람이 사내 주소를 확인했으면 통과(기록에 누가·무엇을 남김, 스펙 2026-11-18-010)
            raise MarketError(tr(f"사내 도메인이나 사설 IP 가 있어 공개 네임스페이스에 게시할 수 없습니다: {', '.join(refs[:5])}",
                                 f"It contains internal domains or private IPs, so it cannot go to a public namespace: {', '.join(refs[:5])}"))
        blob = zip_of(files)
        (_dir() / (rid + ".zip")).write_bytes(blob)       # 보관한 묶음도 게시한 그대로(관리자가 내려받는 것과 같게)
    there = _exists(row["name"])
    if there and there["namespace"] != namespace:
        label = marketplace.ns_label(there["namespace"])
        raise MarketError(tr(f"같은 이름이 다른 네임스페이스({label})에 있습니다", f"The same name exists in another namespace ({label})"), 409)
    try:
        code, res = _post(namespace, row["name"], row["version"], blob)
    except OSError as exc:
        code, res = 0, {"msg": type(exc).__name__}
    row.update(decided_by=admin_who, namespace=namespace, finished=_now())
    if code == 200 and res.get("code") == 0:
        # 허브 응답 상태: PUBLISHED 만 게시됨, SCANNING·PENDING_REVIEW·UPLOADED 는 검토 대기(2026-10-29 T0 실측 — 일반 구성원 게시는 SCANNING 으로 온다)
        status = str((res.get("data") or {}).get("status") or "PUBLISHED").upper()
        row.update(status="published" if status == "PUBLISHED" else "pending_review", message=str((res.get("data") or {}).get("status") or ""))
    else:
        row.update(status="failed", message=f"HTTP {code} {str(res.get('msg') or '')}"[:300])
    return _write(row)


def auto_approve(rid: str, namespace: str) -> dict:
    """주인 스킬 자동 승인(Q14). 승인자는 auto:<요청자>. 검사·게시가 실패하면 관리자 승인 대기(requested)로 되돌리고 이유를 남긴다(F11)."""
    row = get(rid)
    if not row or row["status"] != "requested":
        return row or {}
    try:
        out = approve(rid, f"auto:{row['who']}", namespace)
    except (MarketError, OSError) as exc:
        row = get(rid) or row
        row.update(status="requested", auto_failed=True,
                   message=tr(f"자동 승인하지 못해 관리자 승인을 기다립니다: {exc}", f"Could not approve automatically; waiting for an admin: {exc}")[:300])
        return _write(row)
    if out["status"] == "failed":
        out.update(status="requested", auto_failed=True,
                   message=tr(f"자동 게시가 실패해 관리자 승인을 기다립니다: {out.get('message', '')}", f"Automatic publish failed; waiting for an admin: {out.get('message', '')}")[:300])
        return _write(out)
    out["auto"] = True
    return _write(out)


def auto_versions() -> dict[str, list[dict]]:
    """{"<ns>/<name>": [{version, by}]} — 관리자 검토 없이 게시된 버전(D6). 설치하는 사람의 화면에 보인다.
    by 는 올린 사람의 이름이다 — 모든 사용자가 보므로 이메일을 보내지 않는다(2026-10-30)."""
    from ..office import office
    known = office.people()
    out: dict[str, list[dict]] = {}
    for r in requests():
        if r.get("auto") and r.get("status") in ("published", "pending_review") and r.get("namespace"):
            out.setdefault(f"{r['namespace']}/{r['name']}", []).append({"version": r["version"], "by": office.person_name(str(r.get("who") or ""), known)})
    return out

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
_RID = re.compile(r"^\d{20}-[0-9a-f]{6}$")
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

def collect(folder, excluded: list[str] | None = None) -> list[tuple[str, bytes]]:
    """스킬 폴더 안의 일반 파일만 모은다(R4). 링크·점 파일·폴더 밖·너무 큰 것·비밀값이 든 것은 MarketError.
    excluded 를 주면(내려받기, OMAI-1195 R4) 비밀값이 든 파일은 거절하지 않고 빼서 그 이름을 excluded 에 담는다."""
    out, total = [], 0
    local = isinstance(folder, Path)          # 사이드카 경로(RemotePath)는 사이드카가 링크를 따라가지 않고 폴더 밖을 막는다
    root = folder.resolve() if local else folder
    for f in sorted(folder.rglob("*")):
        rel = Path(str(f.relative_to(folder)))
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


def request_publish(pod_id: str, home, who: str, admin: bool, profile: str, skill_path: str, name: str, version: str, namespace: str = "") -> dict:
    """올리기 요청을 검사하고 묶음과 함께 저장한다. 검사에 걸리면 MarketError(저장하지 않는다).
    namespace 는 원하는 곳(자동 승인 때 쓴다, 표시 이름도 받아 slug 로 저장 — 스펙 2026-10-28-010 D7). hash 는 set_header 전 묶음의 해시 — 만든 기록과 견준다(D11)."""
    namespace = marketplace.ns_slug(namespace) if namespace else ""
    if namespace and namespace not in marketplace.settings()["namespaces"]:
        raise MarketError(tr("이 스킬 허브에서 다루지 않는 네임스페이스입니다", "This skill hub does not serve that namespace"))
    if not marketplace.PROFILE.match(profile or "") and profile != "default":
        raise MarketError(tr("프로파일 이름이 올바르지 않습니다", "The profile name is not valid"))
    if not NAME.match(name or ""):
        raise MarketError(tr("패키지 이름은 소문자·숫자·하이픈으로 2~63자로 적습니다(원본 스킬 이름은 그대로 둡니다)", "Write the package name with lowercase letters, digits, and hyphens (2-63 characters)"))
    if not VERSION.match(version or ""):
        raise MarketError(tr("버전은 1.2.3 꼴이어야 합니다", "The version must look like 1.2.3"))
    parts = [p for p in str(skill_path or "").split("/") if p]
    if len(parts) < 2 or parts[0] != "skills" or any(p in ("..", ".") or p.startswith(".") for p in parts):
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
            raise MarketError(tr("원본 패키지가 허용이 필요한 패키지인지 확인하지 못해 올릴 수 없습니다", "Could not confirm whether the original package is restricted")) from None
        if paid:
            raise MarketError(tr("허용이 필요한 패키지를 고친 것은 올릴 수 없습니다", "A modified restricted package cannot be published"))
        derived = f"{have['namespace']}/{have['name']}@{have['version']}"
    with name_lock(name):
        return _request_locked(pod_id, who, admin, profile, rel, name, version, namespace, origin, derived, files)


def _request_locked(pod_id: str, who: str, admin: bool, profile: str, rel: str, name: str, version: str, namespace: str,
                    origin: str, derived: str, files: list[tuple[str, bytes]]) -> dict:
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
    files = [(r, set_header(d.decode("utf-8"), **extra).encode("utf-8") if r == "SKILL.md" else d) for r, d in files]
    rid = datetime.now().strftime("%Y%m%d%H%M%S%f") + "-" + secrets.token_hex(3)
    (_dir() / (rid + ".zip")).write_bytes(zip_of(files))
    return _write({"id": rid, "ts": _now(), "who": who, "pod": pod_id, "profile": profile, "path": rel, "name": name, "version": version,
                   "origin": origin, "derived_from": derived, "description": fm.get("description", "")[:240],
                   "files": [{"path": r, "size": len(d)} for r, d in files], "status": "requested", "message": "",
                   "hash": digest, "want_namespace": namespace, "internal_refs": refs})


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
        if refs:
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

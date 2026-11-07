# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""스킬 내려받기·올리기(OMAI-1195, 스펙 2026-10-15-009).

- 내려받기: 스킬 폴더를 zip 으로 묶는다. 폴더를 모으는 규칙은 마켓 올리기(market_publish.collect)와 같고, 비밀값이 든 파일은
  거절하지 않고 빼서 그 이름을 알린다(R4). 뺀 파일이 있으면 zip 최상위에 EXCLUDED.txt 를 넣는다(DR6).
- 올리기: zip 을 검사해 임시로 보관하고(미리 보기, 해시) 사용자가 확인하면 그 해시로 적용한다(DR9·DR13).
  SKILL.md 한 장만 든 묶음은 Hermes 의 스킬 만들기 API 로, 스크립트·참고 파일이 든 묶음은 HermesTask(ProfileInstall)로 놓는다(R6).
  놓는 곳은 skills/uploaded/<이름>/ 이다. skills/market/ 은 마켓 새 판이 지우는 영역이라 쓰지 않는다(D1).
"""
from __future__ import annotations

import base64
import hashlib
import io
import json
import re
import secrets
import tarfile
import time
import zipfile
from pathlib import Path

import yaml

from ..assets import files as asset_files
from ..common.i18n import tr
from ..fleet import k8s
from ..market import market_publish, market_stage, marketplace, skill_keep
from ..market.marketplace import MarketError

EXCLUDED_NOTE = "EXCLUDED.txt"


def _skill_folder(home, profile: str, path: str):
    """프로파일 안 skills/ 아래의 스킬 폴더. 상위 경로·점 폴더·skills/ 밖은 400, 없는 프로파일·폴더는 404."""
    if profile != "default" and not marketplace.PROFILE.match(profile or ""):
        raise MarketError(tr("프로파일 이름이 올바르지 않습니다", "The profile name is not valid"), 400)
    parts = skill_keep.profile_rel(profile, path)      # profiles/<이름>/skills/… 도 받는다(MCP skill_get zip 링크)
    if parts is None:
        raise MarketError(tr("스킬 폴더 경로가 올바르지 않습니다", "The skill folder path is not valid"), 400)
    root = skill_keep.profile_root(home, profile)
    try:
        if not root.is_dir():
            raise MarketError(tr("없는 프로파일입니다", "Profile not found"), 404)
        folder = root / "/".join(parts)
        if skill_keep.escapes(root, folder):
            raise MarketError(tr("스킬 폴더 경로가 올바르지 않습니다", "The skill folder path is not valid"), 400)
        if not folder.is_dir() or not (folder / "SKILL.md").is_file():
            raise MarketError(tr("그 프로파일에 이 스킬 폴더가 없습니다", "That skill folder is not in the profile"), 404)
    except OSError as exc:
        raise MarketError(tr(f"스킬 폴더를 읽지 못했습니다: {type(exc).__name__}", f"Could not read the skill folder: {type(exc).__name__}"), 503) from None
    return folder


def _excluded_note(names: list[str]) -> bytes:
    lines = [tr("이 zip 에 넣지 않은 파일입니다. 비밀값으로 보이는 문자열이 들어 있어 뺐습니다.", "These files are not in this zip. They contain text that looks like a secret."),
             tr("이 파일이 없으면 스킬이 동작하지 않을 수 있습니다.", "The skill may not work without these files."), ""]
    return "\n".join(lines + names + [""]).encode("utf-8")


def build_download(home, profile: str, path: str) -> tuple[str, bytes, list[str]]:
    """(스킬 이름, zip 바이트, 뺀 파일 이름들). 실패는 MarketError."""
    folder = _skill_folder(home, profile, path)
    excluded: list[str] = []
    try:
        files = market_publish.collect(folder, excluded)
    except OSError as exc:
        raise MarketError(tr(f"스킬 폴더를 읽지 못했습니다: {type(exc).__name__}", f"Could not read the skill folder: {type(exc).__name__}"), 503) from None
    if excluded:
        files = [*files, (EXCLUDED_NOTE, _excluded_note(excluded))]
    return skill_keep.skill_name(folder), market_publish.zip_of(files), excluded


# ---- 올리기 ---------------------------------------------------------------------------------------

UPLOAD_MAX = marketplace.PAYLOAD_LIMIT           # 올리기 본문 한도와 전달 묶음 한도를 같은 값으로(R2). 일반 POST 한도(MAX_BODY)는 올리지 않는다
UPLOAD_CATEGORY = "uploaded"                      # skills/uploaded/<이름>/ (D1)
TTL = 30 * 60                                     # 검사한 묶음을 임시로 두는 시간(DR9: 만료되면 화면이 같은 파일을 다시 올린다)
NAME_RE = re.compile(r"[a-z0-9][a-z0-9-]{1,62}")
SCRIPT_EXT = (".py", ".sh", ".bash", ".js", ".mjs", ".ts", ".rb", ".pl", ".ps1")
TASK_WAIT = 30.0                                  # HermesTask 가 끝나기를 기다리는 시간(초)
_HASH = re.compile(r"[0-9a-f]{64}")
_URL_HOST = re.compile(r"https?://([A-Za-z0-9.-]+)")


def _is_script(rel: str) -> bool:
    return rel.startswith("scripts/") or rel.lower().endswith(SCRIPT_EXT)


def _read_zip(blob: bytes) -> list[tuple[str, bytes]]:
    """zip 을 풀어 (경로, 바이트)로 돌려준다. 절대 경로·.. ·링크·암호 걸린 파일·한도 초과는 400/413. 점 파일·__MACOSX·런타임 부산물은 말없이 뺀다."""
    if len(blob) > UPLOAD_MAX:
        raise MarketError(tr(f"스킬 묶음이 너무 큽니다(한도 {UPLOAD_MAX // 1024}KiB)", f"The skill bundle is too large (limit {UPLOAD_MAX // 1024} KiB)"), 413)
    try:
        z = zipfile.ZipFile(io.BytesIO(blob))
    except zipfile.BadZipFile:
        raise MarketError(tr("zip 파일이 아닙니다", "That is not a zip file"), 400) from None
    infos = [i for i in z.infolist() if not i.is_dir()]
    if len(infos) > market_publish.MAX_FILES or sum(i.file_size for i in infos) > market_publish.MAX_BYTES:
        raise MarketError(tr(f"파일이 너무 많거나 큽니다(최대 {market_publish.MAX_FILES}개, {market_publish.MAX_BYTES // 2**20}MiB)", "Too many or too large files"), 413)
    out: list[tuple[str, bytes]] = []
    for info in infos:
        name = info.filename.replace("\\", "/")
        parts = [p for p in name.split("/") if p]
        if name.startswith("/") or ".." in parts or (info.external_attr >> 16) & 0o170000 == 0o120000:
            raise MarketError(tr(f"받을 수 없는 경로가 있습니다: {info.filename}", f"The zip has a path that cannot be accepted: {info.filename}"), 400)
        if parts and (parts[0] == "__MACOSX" or any(p.startswith(".") for p in parts) or skill_keep.is_runtime(Path(*parts))):
            continue
        if info.flag_bits & 0x1:
            raise MarketError(tr("암호가 걸린 zip 은 올릴 수 없습니다", "A password-protected zip cannot be uploaded"), 400)
        with z.open(info) as f:
            data = f.read(market_publish.MAX_FILE_BYTES + 1)
        if len(data) > market_publish.MAX_FILE_BYTES:
            raise MarketError(tr(f"파일이 너무 큽니다({info.filename}, 한도 {market_publish.MAX_FILE_BYTES // 2**20}MiB)", f"File too large: {info.filename}"), 413)
        out.append(("/".join(parts), data))
    if not any(r == "SKILL.md" for r, _ in out):                  # 폴더째 묶은 zip(weekly/SKILL.md)도 받는다
        tops = {r.split("/")[0] for r, _ in out}
        if len(tops) == 1 and any(r == f"{next(iter(tops))}/SKILL.md" for r, _ in out):
            out = [(r.split("/", 1)[1], d) for r, d in out]
    out = [(r, d) for r, d in out if r != EXCLUDED_NOTE]            # 내려받기가 넣은 안내 파일은 스킬 파일이 아니다(DR6)
    if not any(r == "SKILL.md" for r, _ in out):
        raise MarketError(tr("SKILL.md 가 없습니다", "SKILL.md is missing"), 400)
    return out


def _summary(text: str) -> str:
    """스크립트가 하는 일 한 줄: 첫 주석이나 문서 문자열. 쓴 사람이 적은 것이라 참고용이다(DR8)."""
    for line in text.splitlines()[:40]:
        s = line.strip()
        if not s or s.startswith("#!"):
            continue
        if s.startswith(("#", "//", "--")):
            return s.lstrip("#/- ").strip()[:120]
        for q in ('"""', "\'\'\'"):
            if s.startswith(q):
                return s.strip(q[0]).strip()[:120]
        return ""
    return ""


def inspect(blob: bytes) -> dict:
    """올린 zip 을 검사한다. 미리 보기에 쓸 값을 돌려준다. 걸리는 것은 MarketError(저장하지 않는다)."""
    files = _read_zip(blob)
    for rel, data in files:
        text = data.decode("utf-8", errors="ignore")
        if market_publish.SECRET.search(text) or asset_files.has_secrets(text):
            raise MarketError(tr(f"비밀값으로 보이는 문자열이 있어 올릴 수 없습니다: {rel}", f"It looks like it contains a secret, so it cannot be uploaded: {rel}"), 400)
    skill_md = dict(files)["SKILL.md"].decode("utf-8", errors="replace")
    head = market_publish.header_of(skill_md)
    scripts = []
    for rel, data in files:
        if _is_script(rel):
            text = data.decode("utf-8", errors="ignore")
            hosts = list(dict.fromkeys(_URL_HOST.findall(text)))[:10]
            scripts.append({"path": rel, "summary": _summary(text), "hosts": hosts})
    scripts.sort(key=lambda x: x["path"])
    name = head.get("name", "")
    return {"hash": hashlib.sha256(blob).hexdigest(), "name": name, "name_valid": bool(NAME_RE.fullmatch(name)),
            "description": head.get("description", ""),
            "files": [{"path": r, "size": len(d)} for r, d in sorted(files)],
            "scripts": scripts, "only_skill_md": [r for r, _ in files] == ["SKILL.md"]}


# 임시 보관(DR9) — 검사한 zip 을 해시 이름으로 두고, 적용은 해시만 받는다. 올린 사람과 POD 가 같아야 쓸 수 있다.

def _store() -> Path:
    return marketplace._dir("skill-uploads")


def keep(blob: bytes, pod_id: str, who: str) -> str:
    d = _store()
    now = time.time()
    for f in d.glob("*"):
        try:
            if now - f.stat().st_mtime > TTL:
                f.unlink()
        except OSError:
            pass
    h = hashlib.sha256(blob).hexdigest()
    (d / (h + ".zip")).write_bytes(blob)
    (d / (h + ".json")).write_text(json.dumps({"pod": pod_id, "who": who, "ts": now}), encoding="utf-8")
    return h


def recall(h: str, pod_id: str, who: str) -> bytes:
    gone = MarketError(tr("올린 파일의 검사 결과가 만료되었습니다", "The check result for the uploaded file has expired"), 410)
    if not _HASH.fullmatch(h or ""):
        raise gone
    d = _store()
    try:
        meta = json.loads((d / (h + ".json")).read_text(encoding="utf-8"))
        blob = (d / (h + ".zip")).read_bytes()
    except (OSError, ValueError):
        raise gone from None
    if time.time() - float(meta.get("ts") or 0) > TTL or meta.get("pod") != pod_id or meta.get("who") != who or hashlib.sha256(blob).hexdigest() != h:
        raise gone
    return blob


def prepare(blob: bytes, name: str, taken: set[str], confirm_scripts: bool) -> dict:
    """적용할 것을 정한다. 이름 규칙·충돌·스크립트 확인을 다시 검사한다(미리 본 뒤 바뀌었을 수 있다). 이름이 바뀌면 SKILL.md 머리말의 name 을 다시 쓴다(DR4)."""
    info = inspect(blob)
    files = _read_zip(blob)
    name = (name or info["name"]).strip()
    if not NAME_RE.fullmatch(name):
        raise MarketError(tr("이름은 영문 소문자·숫자·- 로, 2자 이상으로 적습니다 (예: weekly-report)", "Use lowercase letters, digits and -, at least 2 characters (example: weekly-report)"), 400)
    if name in taken:
        raise MarketError(tr("같은 이름의 스킬이 이미 있습니다", "A skill with that name already exists"), 409)
    if info["scripts"] and not confirm_scripts:
        raise MarketError(tr("스크립트를 확인해야 적용할 수 있습니다", "Confirm the scripts before applying"), 400)
    if info["name"] != name:
        files = [(r, market_publish.set_header(d.decode("utf-8"), name=name).encode("utf-8") if r == "SKILL.md" else d) for r, d in files]
    return {"name": name, "files": files, "only_skill_md": info["only_skill_md"], "scripts": info["scripts"],
            "hash": info["hash"], "content": dict(files)["SKILL.md"].decode("utf-8")}


def _tar(entries: list[tuple[str, bytes, int]]) -> bytes:
    """파일 시각은 묶는 때로 둔다. Hermes 가 tar 의 시각을 그대로 풀어 놓아, 0 이면 스킬의 수정 시각이 1970-01-01 로 보였다(2026-10-28 OKE)."""
    buf, now = io.BytesIO(), int(time.time())
    with tarfile.open(fileobj=buf, mode="w:gz", compresslevel=9) as tar:
        for rel, data, mode in sorted(entries):
            info = tarfile.TarInfo(rel)
            info.mtime, info.uid, info.gid, info.uname, info.gname = now, 0, 0, "", ""
            info.size, info.mode = len(data), mode
            tar.addfile(info, io.BytesIO(data))
    raw = buf.getvalue()
    return raw[:4] + b"\x00\x00\x00\x00" + raw[8:]            # gzip 머리글의 시각은 쓰이지 않아 0 으로 둔다


def distribution(profile: str, name: str, files: list[tuple[str, bytes]], who: str) -> bytes:
    """HermesTask(ProfileInstall)에 실을 배포판(tar.gz). Hermes 는 distribution_owned 에 적힌 경로만 프로파일에 놓는다. scripts/ 아래는 실행 비트를 준다(zip 은 잃는다)."""
    base = f"skills/{UPLOAD_CATEGORY}/{name}"
    entries = [(f"{base}/{rel}", data, 0o755 if rel.startswith("scripts/") else 0o644) for rel, data in files]
    manifest = {"name": profile, "version": "1", "description": f"AAS 올리기: {name}", "distribution_owned": [base]}  # i18n-ignore: 배포판 매니페스트에 적혀 Hermes 에 저장되는 설명
    entries.append(("distribution.yaml", yaml.safe_dump(manifest, allow_unicode=True, sort_keys=False).encode("utf-8"), 0o644))
    blob = _tar(entries)
    if len(blob) > market_stage.MAX_PAYLOAD:
        raise MarketError(tr(f"스킬 묶음이 너무 큽니다(묶으면 {len(blob) // 1024}KiB, 한도 {market_stage.MAX_PAYLOAD // 1024}KiB)", "The skill bundle is too large"), 413)
    return blob


def send_bundle(client, agent: str, profile: str, name: str, files: list[tuple[str, bytes]], who: str, wait: float = TASK_WAIT) -> str:
    """파일이 든 묶음을 HermesTask 로 놓고 끝나기를 기다린다. "done" 이거나 시간 안에 안 끝나면 "pending". 실패는 MarketError."""
    payload = base64.b64encode(distribution(profile, name, files, who)).decode()
    task = "upl-" + secrets.token_hex(6)
    manifest = {"apiVersion": f"{k8s.GROUP}/{k8s.VERSION}", "kind": "HermesTask",
                "metadata": {"name": task, "namespace": client.namespace, "labels": {"aas.openmaru.io/agent": agent}},
                "spec": {"agent": agent, "profile": profile, "type": "ProfileInstall", "force": True, "payload": payload, "requestedBy": str(who or "")[:200]}}
    try:
        client.create_task(manifest)
    except k8s.K8sError as exc:
        raise MarketError(tr(f"작업을 만들지 못했습니다: {exc}", f"Could not create the task: {exc}"), 503) from None
    deadline = time.monotonic() + wait
    while True:
        try:
            status = (client.get_task(task).get("status") or {})
        except k8s.K8sError:
            status = {}
        phase = status.get("phase")
        if phase in ("Succeeded", "Failed"):
            try:
                client.delete_task(task)
            except k8s.K8sError:
                pass                                          # 오퍼레이터가 24시간 뒤 지운다
            if phase == "Failed":
                raise MarketError(str(status.get("message") or tr("실패했습니다", "Failed")), 502)
            return "done"
        if time.monotonic() >= deadline:
            return "pending"
        time.sleep(1.0)

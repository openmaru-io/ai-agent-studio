# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""마켓 패키지를 SkillHub 에서 받아 Hermes 배포판 모양의 폴더로 만들고 tar.gz 묶음으로 돌려준다(쿠버네티스 모드).

예전 compose 시험 환경의 호스트 도우미(bin/market_agent.py, 없앴다)가 하던 「받기 → 해시 대조 → 배포판 만들기」를 서버 안으로 옮긴 것이다.
묶음은 HermesTask.spec.payload 로 가고, Hermes 컨테이너 안의 명령(`hermes profile install`)은 오퍼레이터가 돌린다.
Hermes 의 파일을 직접 고치지 않는다 — 프로파일에 쓰는 것은 Hermes 자신이다.
"""
from __future__ import annotations

import base64
import hashlib
import io
import json
import re
import shutil
import tarfile
import tempfile
import time
import urllib.error
import urllib.request
import zipfile
from pathlib import Path

from ..assets import skill_setup
from . import marketplace, skill_keep, template_checks

NAME = marketplace.NAME
PROFILE = marketplace.PROFILE
VERSION = marketplace.VERSION
MAX_ZIP, MAX_FILES, MAX_TOTAL = 20 * 2**20, 500, 60 * 2**20
MAX_PAYLOAD = marketplace.PAYLOAD_LIMIT   # HermesTask 에 실을 묶음(tar.gz) 크기. CRD 필드·etcd 요청 한도 안에 들게 한다
AGENT_TOP = {"SOUL.md", "config.yaml", "mcp.json", "skills", "cron", ".env.template", "README.md"}       # 에이전트 패키지가 프로파일에 놓을 수 있는 것
SKILL_CATEGORY = "market"                                                                              # 스킬 패키지가 놓이는 자리: skills/market/<이름>/


class Refuse(Exception):
    """요청을 거절한다 — 메시지는 화면에 그대로 보인다. code = 오류 코드(스펙 2026-11-18-002 §4-5, 없으면 빈 값)."""

    def __init__(self, message: str, code: str = ""):
        super().__init__(message)
        self.code = code


class Unavailable(Refuse):
    """스킬 허브에 잠깐 닿지 않았다(연결 실패·시간 초과·5xx·429). 요청은 지금처럼 실패로 닫히되 transient 가 남아,
    기본 스킬 배달기가 간격을 두고 다시 시도한다(OMAI-2085). Refuse 를 잡던 곳은 그대로 잡는다."""


class NeedsChoice(Refuse):
    """고친 스킬·설치 기록 없는 같은 경로의 스킬이 있어 사용자에게 물어야 한다(리뷰 R3). needs = {"modified": [...], "occupied": [...]}.
    요청은 실패로 닫히고 needs 가 요청 기록에 남아, 화면이 선택 대화 상자를 그린 뒤 on_modified 를 담아 다시 요청한다."""

    def __init__(self, message: str, needs: dict):
        super().__init__(message)
        self.needs = needs


def validate(req: dict) -> None:
    for key, pat in (("namespace", NAME), ("name", NAME), ("version", VERSION), ("profile", PROFILE)):
        if not pat.match(str(req.get(key) or "")):
            raise Refuse(f"요청의 {key} 가 올바르지 않습니다")  # i18n-ignore: 배달기가 요청 결과로 기록하는 문장(저장)
    if req.get("kind") not in ("skill", "agent") or req.get("mode") not in ("install", "update", "remove", "skills"):
        raise Refuse("요청의 종류가 올바르지 않습니다")  # i18n-ignore: 배달기가 요청 결과로 기록하는 문장(저장)
    if req["mode"] == "skills" and req["kind"] != "agent":
        raise Refuse("스킬만 설치는 에이전트 패키지에만 씁니다")  # i18n-ignore: 배달기가 요청 결과로 기록하는 문장(저장)
    if req["mode"] == "remove" and req["kind"] != "skill":
        raise Refuse("에이전트 패키지는 여기서 지우지 않습니다")  # i18n-ignore: 배달기가 요청 결과로 기록하는 문장(저장)
    if req["profile"] == "default":
        raise Refuse("공용(루트) 프로파일에는 설치할 수 없습니다")  # i18n-ignore: 배달기가 요청 결과로 기록하는 문장(저장)


def _hub(path: str, raw: bool = False):
    cfg = marketplace.settings()
    if not cfg["url"]:
        raise Refuse("스킬 허브 주소(AAS_SKILLHUB_URL)가 설정돼 있지 않습니다")  # i18n-ignore: 배달기가 요청 결과로 기록하는 문장(저장)
    req = urllib.request.Request(cfg["url"] + path, headers={"Accept": "*/*" if raw else "application/json"})
    token = marketplace._token(cfg["token_file"])
    if token:
        req.add_header("Authorization", "Bearer " + token)
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            data = resp.read(MAX_ZIP + 1)
    except urllib.error.HTTPError as exc:
        why = Unavailable if exc.code >= 500 or exc.code == 429 else Refuse
        raise why(f"스킬 허브가 거절했습니다 (HTTP {exc.code})") from None  # i18n-ignore: 배달기가 요청 결과로 기록하는 문장(저장)
    except OSError as exc:
        raise Unavailable(f"스킬 허브에 연결할 수 없습니다: {type(exc).__name__}") from None  # i18n-ignore: 배달기가 요청 결과로 기록하는 문장(저장)
    if raw:
        return data
    body = json.loads(data or b"{}")
    return body.get("data", body) if isinstance(body, dict) else body


def download(req: dict, dest: Path) -> list[str]:
    """그 버전의 묶음을 받아 dest 에 푼다. SkillHub 가 알려 준 파일 목록·해시와 다르면 거절한다."""
    base = f"/api/v1/skills/{req['namespace']}/{req['name']}/versions/{req['version']}"
    listed = _hub(base + "/files")
    listed = listed if isinstance(listed, list) else listed.get("items", [])
    want = {str(f["filePath"]): str(f.get("sha256") or "") for f in listed}
    blob = _hub(base + "/download", raw=True)
    if len(blob) > MAX_ZIP:
        raise Refuse("묶음이 너무 큽니다(20MB 초과)")  # i18n-ignore: 배달기가 요청 결과로 기록하는 문장(저장)
    return extract(blob, dest, want)


def extract(blob: bytes, dest: Path, want: dict[str, str]) -> list[str]:
    try:
        z = zipfile.ZipFile(io.BytesIO(blob))
    except zipfile.BadZipFile:
        raise Refuse("받은 묶음이 zip 이 아닙니다") from None  # i18n-ignore: 배달기가 요청 결과로 기록하는 문장(저장)
    infos = [i for i in z.infolist() if not i.is_dir()]
    if len(infos) > MAX_FILES or sum(i.file_size for i in infos) > MAX_TOTAL:
        raise Refuse("묶음에 파일이 너무 많거나 큽니다")  # i18n-ignore: 배달기가 요청 결과로 기록하는 문장(저장)
    got = []
    for info in infos:
        rel = Path(info.filename)
        if rel.is_absolute() or ".." in rel.parts or (info.external_attr >> 16) & 0o170000 == 0o120000:
            raise Refuse(f"묶음에 받을 수 없는 경로가 있습니다: {info.filename}")  # i18n-ignore: 배달기가 요청 결과로 기록하는 문장(저장)
        data = z.read(info)
        if want and want.get(info.filename) != hashlib.sha256(data).hexdigest():
            raise Refuse(f"파일 해시가 스킬 허브 기록과 다릅니다: {info.filename}")  # i18n-ignore: 배달기가 요청 결과로 기록하는 문장(저장)
        out = dest / rel
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_bytes(data)
        got.append(info.filename)
    if want and set(got) != set(want):
        raise Refuse("묶음의 파일 목록이 스킬 허브 기록과 다릅니다")  # i18n-ignore: 배달기가 요청 결과로 기록하는 문장(저장)
    if "SKILL.md" not in got:
        raise Refuse("묶음에 SKILL.md 가 없습니다")  # i18n-ignore: 배달기가 요청 결과로 기록하는 문장(저장)
    return got


def _agent_skill_folders(pkg: Path) -> list[str]:
    """에이전트 패키지 agent/ 아래의 스킬 폴더(skills/<묶음>/<스킬>) 상대 경로. 얕은 것부터 — 스킬 폴더 안의 SKILL.md(예시 등)는 따로 세지 않는다."""
    root = pkg / "agent" / "skills"
    found = root.rglob("SKILL.md") if root.is_dir() else []
    owned: list[str] = []
    for skill_md in sorted(found, key=lambda f: (len(f.parts), str(f))):
        rel = skill_md.parent.relative_to(pkg / "agent").as_posix()
        if not any(rel.startswith(o + "/") for o in owned):
            owned.append(rel)
    return owned


def planned_skills(req: dict, pkg: Path) -> dict[str, str]:
    """이 요청이 프로파일에 놓을 스킬 폴더 {상대 경로: 스킬 name}. 설치 전 충돌 검사(리뷰 R7)에 쓴다."""
    if req["kind"] == "skill":
        return {f"skills/{SKILL_CATEGORY}/{req['name']}": skill_keep.skill_name(pkg)}
    if req["mode"] == "remove":
        return {}
    return {rel: skill_keep.skill_name(pkg / "agent" / rel) for rel in _agent_skill_folders(pkg)}


def _check_agent(req: dict, pkg: Path, src: Path, manifest: dict, consent: bool | None = None) -> dict:
    """새 프로파일로 설치하는 에이전트 패키지의 검사(스펙 2026-11-18-002 §4-2 4, E2). 받은 본문에 대해 한다 — 검사한 것과 설치하는 것이 같다.
    템플릿만이 아니라 모든 에이전트 패키지에 한다(좁히면 R1 이 다른 패키지에 열린 채 남는다). 돌려주는 값 = template_checks.check 결과."""
    read = lambda rel: (src / rel).read_text(encoding="utf-8") if (src / rel).is_file() else ""      # noqa: E731
    env = manifest.get("env_requires") or []
    names = [str(e.get("name") or "") for e in env if isinstance(e, dict)]
    if any(isinstance(e, dict) and "default" in e for e in env):
        raise Refuse("env_requires 에 default 값을 둘 수 없습니다(.env.EXAMPLE 에 그대로 적힙니다)", "env_default")  # i18n-ignore: 배달기가 요청 결과로 기록하는 문장(저장)
    files = [p.relative_to(pkg).as_posix() for p in pkg.rglob("*") if p.is_file()]
    if consent is None:
        consent = req["mode"] == "install"
    consents = [str(c) for c in req.get("consents") or []] if consent else None
    try:
        return template_checks.check(req["namespace"], read("config.yaml"), read("cron/jobs.json"), names, files, consents, read("mcp.json"))
    except template_checks.CheckError as exc:
        raise Refuse(str(exc), exc.code) from None


def is_template(manifest: dict) -> bool:
    aas = manifest.get("aas") if isinstance(manifest, dict) else None
    return isinstance(aas, dict) and aas.get("template") == 1


def stage(req: dict, pkg: Path, out: Path, current: dict | None = None, skip: set | None = None, report: dict | None = None) -> dict:
    """받은 패키지를 Hermes 배포판 모양으로 만든다. 돌려주는 값 = 적은 매니페스트.
    Hermes 는 매니페스트의 distribution_owned 에 적힌 경로만 프로파일에 베낀다 — 스킬 패키지는 자기 폴더 하나만, 에이전트 패키지는 허용한 것만.
    current = 새 판으로 올릴 때 그 프로파일의 지금 크론·MCP 파일 {"cron/jobs.json": 글, "mcp.json": 글}(없으면 None) — 사용자 것과 합쳐 지우지 않는다(R9).
    skip = 이번에는 바꾸지 않을 distribution_owned 경로들(사용자가 「내 것 지키기」를 골랐다, R3).
    report = 부른 쪽이 넘긴 빈 표. 템플릿 설치면 {template, template_version, env_names, waiting_mcp} 를 채운다(설치 줄에 적는다, 값은 없다)."""
    import yaml
    out.mkdir(parents=True)
    if req["kind"] == "skill":
        rel = f"skills/{SKILL_CATEGORY}/{req['name']}"
        shutil.copytree(pkg, out / rel)
        manifest = {"name": req["profile"], "version": req["version"], "description": f"AAS 스킬 허브: {req['package']}", "distribution_owned": [rel]}  # i18n-ignore: 배포판 매니페스트에 적혀 Hermes 에 저장되는 설명
    elif req["mode"] == "skills":                              # 에이전트 패키지의 스킬만(2026-10-14-002). SOUL·설정·크론·MCP 는 넣지 않는다
        owned = []
        for rel in _agent_skill_folders(pkg):
            shutil.copytree(pkg / "agent" / rel, out / rel)
            owned.append(rel)
        if not owned:
            raise Refuse("이 에이전트 패키지에는 스킬이 없습니다")  # i18n-ignore: 배달기가 요청 결과로 기록하는 문장(저장)
        manifest = {"name": req["profile"], "version": req["version"], "description": f"AAS 스킬 허브: {req['package']} 의 스킬", "distribution_owned": owned}  # i18n-ignore: 배포판 매니페스트에 적혀 Hermes 에 저장되는 설명
    else:
        src = pkg / "agent"
        try:
            manifest = yaml.safe_load((src / "distribution.yaml").read_text(encoding="utf-8"))
        except (OSError, yaml.YAMLError):
            raise Refuse("에이전트 패키지의 agent/distribution.yaml 을 읽을 수 없습니다") from None  # i18n-ignore: 배달기가 요청 결과로 기록하는 문장(저장)
        if not isinstance(manifest, dict):
            raise Refuse("agent/distribution.yaml 이 올바르지 않습니다")  # i18n-ignore: 배달기가 요청 결과로 기록하는 문장(저장)
        template = is_template(manifest)
        env_names = [str(e.get("name") or "") for e in manifest.get("env_requires") or [] if isinstance(e, dict)
                     and not skill_setup.is_aas_managed(str(e.get("name") or ""))]     # LLM 접속값은 AAS 가 준다 — 그 KEY 로 MCP 를 꺼 두지 않는다(스펙 2026-11-19-002)
        if req["mode"] == "install" or (template and req["mode"] == "update"):
            # 템플릿 새 판도 같은 검사와 stdio 동의를 받는다 — 올리기 뒤 AAS 가 MCP 를 합치므로 새 명령도 동의 없이 들어가지 않게(스펙 2026-11-18-002 새 판)
            _check_agent(req, pkg, src, manifest, consent=True)
        main_config = (current or {}).get("config.yaml")
        if template and req["mode"] == "install" and not main_config:      # 모델 없는 프로파일을 만들지 않는다(E16)
            raise Refuse("받는 사람의 주 프로파일 설정(config.yaml)을 읽지 못해 템플릿으로 프로파일을 만들지 않았습니다", "main_config_missing")  # i18n-ignore: 배달기가 요청 결과로 기록하는 문장(저장)
        owned = []
        for entry in sorted(src.iterdir()):
            if entry.name == "distribution.yaml":
                continue
            if entry.name not in AGENT_TOP:
                raise Refuse(f"에이전트 패키지에 넣을 수 없는 항목입니다: agent/{entry.name}")  # i18n-ignore: 배달기가 요청 결과로 기록하는 문장(저장)
            (shutil.copytree if entry.is_dir() else shutil.copy2)(entry, out / entry.name)
            if entry.name == "config.yaml" and template and req["mode"] == "install":
                # 템플릿 전용 합치기(E1): 받는 사람 main 의 모델·제공자 위에 템플릿의 도구 묶음·스킬 켜기/끄기·MCP 만. KEY 를 쓰는 MCP 는 꺼 둔다
                try:
                    merged, waiting = template_checks.merge_config(main_config, entry.read_text(encoding="utf-8"), env_names)
                except (ValueError, OSError) as exc:
                    raise Refuse(f"템플릿 설정을 주 프로파일 설정과 합치지 못했습니다: {exc}", "config_invalid") from None  # i18n-ignore: 배달기가 요청 결과로 기록하는 문장(저장)
                (out / "config.yaml").write_text(merged, encoding="utf-8")
                if report is not None:
                    report["waiting_mcp"] = waiting
            if entry.name == "config.yaml" and req["mode"] == "update":
                continue                                          # 새 버전으로 올릴 때는 쓰던 설정을 지킨다
            if entry.name == "skills":                            # 폴더째 넣으면 프로파일의 다른 스킬·사용 기록이 지워진다 — 패키지의 스킬 폴더마다 따로 적는다(리뷰 P1 A)
                owned += _agent_skill_folders(pkg)
            elif entry.name == "cron" and req["mode"] == "update":
                owned += _merged_file(out, entry, "cron/jobs.json", (current or {}).get("cron/jobs.json"), skill_keep.merge_jobs)
            elif entry.name == "mcp.json" and req["mode"] == "update":
                owned += _merged_file(out, entry, "mcp.json", (current or {}).get("mcp.json"), skill_keep.merge_mcp)
            elif entry.name != "README.md":
                owned.append(entry.name)
        if "SOUL.md" not in owned:
            raise Refuse("에이전트 패키지에 agent/SOUL.md 가 없습니다")  # i18n-ignore: 배달기가 요청 결과로 기록하는 문장(저장)
        if template and "config.yaml" not in owned and req["mode"] == "install":       # 템플릿이 config 를 담지 않아도 main 의 모델로 만든다
            merged, waiting = template_checks.merge_config(main_config, "", env_names)
            (out / "config.yaml").write_text(merged, encoding="utf-8")
            owned.append("config.yaml")
            if report is not None:
                report["waiting_mcp"] = waiting
        if report is not None and template:
            aas_ = manifest.get("aas") if isinstance(manifest.get("aas"), dict) else {}
            report.update(template=req["package"], template_version=req["version"], env_names=env_names,
                          examples=[str(x)[:200] for x in aas_.get("examples") or []][:5])   # 첫 대화 빈 화면의 예시(§4-5 첫 일 안내)
            report.setdefault("waiting_mcp", [])
        manifest = {k: manifest[k] for k in ("description", "hermes_requires", "author", "license", "env_requires") if manifest.get(k)}
        manifest.update({"name": req["profile"], "version": req["version"], "distribution_owned": owned})
    for rel in sorted(skip or ()):                              # 사용자가 지키기로 한 것은 이번 배포판에서 뺀다
        if rel in manifest["distribution_owned"]:
            manifest["distribution_owned"].remove(rel)
            target = out / rel
            shutil.rmtree(target, ignore_errors=True) if target.is_dir() else target.unlink(missing_ok=True)
    (out / "distribution.yaml").write_text(yaml.safe_dump(manifest, allow_unicode=True, sort_keys=False), encoding="utf-8")
    return manifest


def _merged_file(out: Path, entry: Path, rel: str, current: str | None, merge) -> list[str]:
    """새 판의 크론·MCP 파일을 그 프로파일의 지금 것과 합쳐 배포판에 놓고, 그 파일 하나만 owned 로 돌려준다.
    합칠 수 없으면(형식이 깨졌다) Refuse — 사용자 것을 덮지 않고 요청을 멈춘다."""
    src = entry / Path(rel).name if entry.is_dir() else entry
    if not src.is_file():
        return []
    try:
        text = merge(current, src.read_text(encoding="utf-8"))
    except (ValueError, OSError):
        raise Refuse(f"{rel} 를 사용자 것과 합칠 수 없습니다 — 형식을 확인하세요") from None  # i18n-ignore: 배달기가 요청 결과로 기록하는 문장(저장)
    (out / rel).parent.mkdir(parents=True, exist_ok=True)
    (out / rel).write_text(text, encoding="utf-8")
    return [rel]


def pack(folder: Path) -> bytes:
    """폴더를 tar.gz 로 묶는다. 순서·소유자는 고정하고 시각은 묶는 때로 둔다 — Hermes 가 tar 의 시각을 그대로 풀어 놓아,
    0 으로 고정했을 때 설치한 스킬의 수정 시각이 1970-01-01 로 보였다(2026-10-28). 같은 바이트를 비교하는 곳은 없다."""
    buf, now = io.BytesIO(), int(time.time())
    with tarfile.open(fileobj=buf, mode="w:gz", compresslevel=9) as tar:
        for path in sorted(folder.rglob("*")):
            rel = path.relative_to(folder).as_posix()
            info = tarfile.TarInfo(rel)
            info.mtime, info.uid, info.gid, info.uname, info.gname = now, 0, 0, "", ""
            if path.is_dir():
                info.type, info.mode = tarfile.DIRTYPE, 0o755
                tar.addfile(info)
            elif path.is_file() and not path.is_symlink():
                data = path.read_bytes()
                info.size, info.mode = len(data), 0o644
                tar.addfile(info, io.BytesIO(data))
    raw = buf.getvalue()
    # gzip 머리글의 시각(4바이트)도 0 으로 고정한다
    return raw[:4] + b"\x00\x00\x00\x00" + raw[8:]


def _reference(req: dict, record: dict | None, tmp: Path, plan: dict[str, str]) -> dict[str, dict[str, str] | None]:
    """설치된 판의 원본 {스킬 폴더: {경로: sha256}}. SkillHub 에서 그 판을 받아 비교 기준으로 쓴다(리뷰 D5).
    설치 기록이 없거나 받지 못하면 모두 None(= 원본을 모름)."""
    if not record or not record.get("version"):
        return {rel: None for rel in plan}
    old = tmp / "installed"
    try:
        download({**req, "version": str(record["version"]), "namespace": record.get("namespace") or req["namespace"], "name": record.get("name") or req["name"]}, old)
    except Refuse:
        return {rel: None for rel in plan}
    if req["kind"] == "skill":
        return {rel: skill_keep.digest(old) for rel in plan}
    return {rel: (skill_keep.digest(old / "agent" / rel) if (old / "agent" / rel).is_dir() else None) for rel in plan}


def _protect(req: dict, root, plan: dict[str, str], record: dict | None, tmp: Path) -> tuple[set, dict, list[str]]:
    """덮기 전 검사(리뷰 R3·R7): (이번에 건드리지 않을 경로들, 사용자 선택 필요 목록, 덮여서 백업할 경로들).
    같은 name 이 다른 경로에 있으면 Refuse, 고쳤거나 원본을 모르는 스킬이 있고 사용자가 아직 고르지 않았으면 NeedsChoice."""
    ours = set(plan) if record else set()
    found = skill_keep.inspect(root, plan, ours)
    if found["clash"]:
        c = found["clash"][0]
        raise Refuse(f"같은 이름의 스킬 '{c['name']}' 이 이미 있어({c['other']}) 설치하면 둘 다 쓸 수 없게 됩니다 — 하나의 이름을 바꾸거나 지우고 다시 하세요")  # i18n-ignore: 배달기가 요청 결과로 기록하는 문장(저장)
    have = skill_keep.installed_skills(root)
    existing = [rel for rel in plan if rel in have]
    refs = _reference(req, record, tmp, {rel: "" for rel in existing if rel in ours})
    modified = []
    for rel in existing:
        if rel in found["occupied"]:
            continue
        if skill_keep.modified(root, rel, refs.get(rel)) in ("changed", "unknown"):
            modified.append(rel)
    needs = {"modified": modified, "occupied": found["occupied"]}
    todo = modified + found["occupied"]
    choice = str(req.get("on_modified") or "")
    if choice == "copy" and (req["kind"] != "skill" or len(todo) != 1 or not todo[0].startswith("skills/market/")):
        raise Refuse("「로컬 사본 남기고 새 버전」은 스킬 허브로 설치한 스킬 하나를 고쳤을 때만 쓸 수 있습니다")  # i18n-ignore: 배달기가 요청 결과로 기록하는 문장(저장)
    if todo and choice not in ("keep", "overwrite", "copy"):
        raise NeedsChoice(f"내가 고쳤거나 직접 만든 스킬이 있습니다: {', '.join(todo)} — 지키거나 덮을지 고르세요", needs)  # i18n-ignore: 배달기가 요청 결과로 기록하는 문장(저장)
    skip = set(todo) if choice == "keep" else set()
    return skip, needs, [rel for rel in existing if rel not in skip]


def prepare(req: dict, home=None, record: dict | None = None) -> dict:
    """설치 요청 하나를 준비한다 — 받기, 덮기 전 검사·백업, 배포판 만들기, 묶기. 거절은 Refuse, 사용자 선택이 필요하면 NeedsChoice.
    home = 그 POD 의 Hermes 데이터 폴더(없으면 지키기 검사를 하지 않는다), record = 이 프로파일에 이 패키지를 설치한 마지막 기록.
    돌려주는 값: {payload(base64 tar.gz, 바꿀 것이 없으면 빈 값), manifest, backup(백업 파일 이름), skipped(지킨 경로들)}"""
    validate(req)
    with tempfile.TemporaryDirectory(prefix="aas-market-") as tmp:
        tmp = Path(tmp)
        pkg, staged = tmp / "pkg", tmp / "stage"
        pkg.mkdir()
        download(req, pkg)
        skip, current, backup_name = set(), None, ""
        if home is not None and req["mode"] != "remove":
            root = skill_keep.profile_root(home, req["profile"])
            try:
                skip, _, overwritten = _protect(req, root, planned_skills(req, pkg), record, tmp)
                if req["kind"] == "agent" and req["mode"] == "update":
                    current = {rel: (root / rel).read_text(encoding="utf-8") if (root / rel).is_file() else None for rel in ("cron/jobs.json", "mcp.json")}
                    overwritten = overwritten + [rel for rel in ("cron/jobs.json", "mcp.json") if current[rel] is not None]
                if req["kind"] == "agent" and req["mode"] == "install":     # 템플릿 전용 합치기의 바탕 = 받는 사람 주 프로파일 config(스펙 2026-11-18-002 §4-2 4)
                    current = {"config.yaml": _main_config(home, req)}
                backup_name = skill_keep.backup(root, req["id"], overwritten)
            except OSError as exc:
                raise Refuse(f"그 프로파일의 스킬을 읽지 못해 지키기 검사·백업을 할 수 없어 진행하지 않았습니다: {type(exc).__name__}") from None  # i18n-ignore: 배달기가 요청 결과로 기록하는 문장(저장)
        report: dict = {}
        manifest = stage(req, pkg, staged, current=current, skip=skip, report=report)
        blob = pack(staged) if manifest["distribution_owned"] else b""
    if len(blob) > MAX_PAYLOAD:
        raise Refuse(f"패키지가 너무 큽니다(묶으면 {len(blob) // 1024} KiB, 한도 {MAX_PAYLOAD // 1024} KiB)")  # i18n-ignore: 배달기가 요청 결과로 기록하는 문장(저장)
    return {"payload": base64.b64encode(blob).decode() if blob else "", "manifest": manifest, "backup": backup_name, "skipped": sorted(skip), "template": report}


def _main_config(home, req: dict) -> str | None:
    """그 작업공간 주 프로파일의 config.yaml 글. 읽지 못하면 None — 템플릿이면 stage 가 거절한다."""
    from ..fleet import primary
    try:
        path = skill_keep.profile_root(home, primary.primary_of(str(req.get("pod") or ""))) / "config.yaml"
        return path.read_text(encoding="utf-8") if path.is_file() else None
    except OSError:
        return None


def build_payload(req: dict) -> tuple[str, dict]:
    """설치 요청 하나를 (base64 tar.gz, 매니페스트)로 만든다. 거절은 Refuse. 그 프로파일을 읽지 않는 옛 길 — 지키기 검사는 prepare 가 한다."""
    res = prepare(req)
    return res["payload"], res["manifest"]

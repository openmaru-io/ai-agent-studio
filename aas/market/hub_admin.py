# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""관리자가 zip 으로 스킬 허브에 바로 게시한다(스펙 2026-10-29-002, OMAI-1536).

  미리 보기   zip 을 검사한 파일 목록으로 새 스킬/새 판을 가르고, 막는 이유·다음 판·바뀐 파일·사내 주소·설치 수를 돌려준다(R5·R10·R11·R16).
  게시        이름 잠금 안에서 검사를 모두 다시 하고(R2), 기록을 publishing 으로 만든 뒤 market_publish._publish 로 게시한다(R9).
  다시 게시   admin_upload 실패·오래된 publishing 만. 허브에 같은 판·같은 묶음이 있으면 게시 없이 기록만 맞춘다(R13).

zip 을 푸는 일(경로·한도·비밀값 검사)은 서버의 skill_files 가 하고 여기에는 (경로, 바이트) 목록이 온다.
"""
from __future__ import annotations

import hashlib
import secrets
from datetime import datetime

from ..common.i18n import tr
from . import market_publish as mp, marketplace, publish_auto, skill_bundle
from .marketplace import NAME, VERSION, MarketError


def _ver(v: str) -> tuple:
    return marketplace._ver(v)


def _bump(v: str) -> str:
    parts = [int(x) for x in (v or "0.0.0").split(".")[:3]] + [0, 0, 0]
    return f"{parts[0]}.{parts[1]}.{parts[2] + 1}"


def hub_versions(ns: str, name: str) -> list[dict]:
    """허브 버전 목록 — 상태와 무관하게(검토 대기 포함, R10·R13). [{version, status}]."""
    try:
        got = marketplace.fetch(f"/api/v1/skills/{ns}/{name}/versions")
    except MarketError as exc:
        if exc.code == 404:
            return []
        raise
    items = got.get("items", []) if isinstance(got, dict) else got or []
    return [{"version": str(v.get("version") or ""), "status": str(v.get("status") or "")} for v in items if v.get("version")]


def hub_files(ns: str, name: str, version: str) -> list[dict]:
    """허브 그 버전의 파일 목록 [{path, size, sha256}] — 허브가 파일마다 sha256 을 준다(2026-10-29 T0 실측)."""
    got = marketplace.fetch(f"/api/v1/skills/{ns}/{name}/versions/{version}/files")
    items = got if isinstance(got, list) else (got or {}).get("items", [])
    return [{"path": str(f.get("filePath") or ""), "size": int(f.get("fileSize") or 0), "sha256": str(f.get("sha256") or "")} for f in items]


def _same(theirs: dict, data: bytes) -> bool:
    """허브 파일 한 개와 우리 바이트가 같은가 — sha256 이 있으면 내용으로, 없으면 크기로."""
    return theirs["sha256"] == hashlib.sha256(data).hexdigest() if theirs.get("sha256") else theirs["size"] == len(data)


def _published_records(name: str) -> list[dict]:
    return [r for r in mp.requests() if r["name"] == name and r["status"] in ("published", "pending_review")]


def next_version(ns: str, name: str, header_version: str = "") -> str:
    """다음 버전 = (허브 버전 목록 전체 · AAS 기록의 published/pending_review) 중 가장 큰 버전 + 1, 머리말 버전이 더 크면 그것(R10·DD19)."""
    seen = [v["version"] for v in hub_versions(ns, name)] + [r["version"] for r in _published_records(name)]
    nxt = _bump(max(seen, key=_ver)) if seen else "1.0.0"
    return header_version if VERSION.match(header_version or "") and _ver(header_version) > _ver(nxt) else nxt


def _for_compare(files: list[tuple[str, bytes]], name: str, version: str) -> dict[str, bytes]:
    """게시 때와 같은 머리말(name·version)을 넣은 모습 — 크기·내용 비교가 머리말 때문에 늘 다르게 나오지 않게(OV11)."""
    return {r: (mp.set_header(d.decode("utf-8", errors="replace"), name=name, version=version).encode("utf-8") if r == "SKILL.md" else d)
            for r, d in files}


def changed_files(ns: str, name: str, files: list[tuple[str, bytes]]) -> dict:
    """새 버전의 바뀐 파일(R5). AAS 가 보관한 마지막 게시 묶음이 있으면 내용으로, 없으면 허브 현재 버전의 경로·크기로."""
    prior = _published_records(name)
    if prior and mp.bundle_path(prior[0]["id"]):
        old = dict(mp._unzip(mp.bundle_path(prior[0]["id"]).read_bytes()))
        new = _for_compare(files, name, prior[0]["version"])
        basis = "bundle"
        diff = lambda r: old[r] != new[r]                                      # noqa: E731
        version = prior[0]["version"]
    else:
        vs = [v for v in hub_versions(ns, name) if v["status"].upper() in ("", "PUBLISHED")]
        if not vs:
            return {"basis": "", "version": "", "added": [], "removed": [], "changed": []}
        version = max((v["version"] for v in vs), key=_ver)
        old = {f["path"]: f for f in hub_files(ns, name, version)}
        new = _for_compare(files, name, version)
        basis = "hub" if all(f.get("sha256") for f in old.values()) else "hub_size"   # sha256 이 없으면 같은 크기 내용 변경은 보이지 않는다
        diff = lambda r: not _same(old[r], new[r])                              # noqa: E731
    return {"basis": basis, "version": version,
            "added": sorted(set(new) - set(old)), "removed": sorted(set(old) - set(new)),
            "changed": sorted(r for r in set(new) & set(old) if diff(r))}


def internal_refs(files: list[tuple[str, bytes]]) -> dict:
    """사내 주소 두 목록 — 공개 네임스페이스는 author 메일을 지운 게시본 기준, 구성원 전용은 원본 기준(R16)."""
    domains = publish_auto.config(marketplace.settings()["namespaces"])["domains"]
    return {"public": publish_auto.internal_refs(mp._public_files(files), domains), "member": publish_auto.internal_refs(files, domains)}


def installed_count(ns: str, name: str, pods: list[str]) -> int:
    """이 AAS 에서 그 패키지를 설치한 프로파일 수(설치 기록 기준, 살아 있는 작업공간만 — R14)."""
    pkg = f"{ns}/{name}"
    return sum(1 for rows in marketplace.installed_all(pods).values() for r in rows if r.get("package") == pkg)


def blockers(name: str, version: str | None, namespace: str, files: list[tuple[str, bytes]], who: str, *, rid: str = "") -> list[str]:
    """게시를 막는 이유들(빈 목록이면 게시할 수 있다). 미리 보기는 모두 보이고, 게시는 첫 이유로 거절한다(R2).
    rid 는 다시 게시하는 자기 기록 — 같은 이름 대기 검사에서 뺀다. version 이 None 이면(미리 보기, 아직 고르지 않음) 판 검사를 건너뛴다."""
    out: list[str] = []
    if not NAME.match(name or ""):
        out.append(tr("SKILL.md 의 name 은 소문자·숫자·하이픈으로 2~63자여야 합니다", "The name in SKILL.md must be 2-63 lowercase letters, digits or hyphens"))
        return out
    if name in skill_bundle.names():
        out.append(tr("AAS 기본 스킬은 AAS 서버가 관리합니다. 서버를 새 버전으로 반영해 배포하세요", "AAS built-in skills are managed by the AAS server. Deploy a new server version to update them"))
    if mp._exists_readonly(name):
        out.append(tr("공개 미러에 같은 이름이 있습니다 — 다른 이름을 쓰세요", "The public mirror has a package with that name. Use another name"))
    from . import hub_hide
    there = mp._exists(name)
    if there and hub_hide.hidden(there["namespace"], name):
        out.append(tr(f"{name} 은 허브에서 숨긴 패키지입니다. 먼저 다시 보이기를 한 뒤 새 버전으로 게시하세요",
                      f"{name} is hidden in the skill hub. Show it again first, then publish a new version"))
    if any(r["name"] == name and r["id"] != rid and r["status"] in ("requested", "publishing") for r in mp.requests()):
        out.append(tr("같은 이름의 게시 요청이 기다리고 있습니다", "A publish request with that name is already waiting"))
    ns = there["namespace"] if there else namespace
    if there and namespace and there["namespace"] != namespace:
        out.append(tr(f"같은 이름이 다른 네임스페이스({marketplace.ns_label(there['namespace'])})에 있습니다",
                      f"The same name exists in another namespace ({marketplace.ns_label(there['namespace'])})"))
    if version is None:
        pass
    elif not VERSION.match(version or ""):
        out.append(tr("버전은 1.2.3 꼴이어야 합니다", "The version must look like 1.2.3"))
    else:
        known = [v["version"] for v in hub_versions(ns, name)] if ns else []
        known += [r["version"] for r in _published_records(name) if r["id"] != rid]
        top = max(known, key=_ver) if known else ""
        if top and not mp._newer(version, top):
            out.append(tr(f"허브의 버전(v{top})보다 커야 합니다", f"The version must be newer than v{top}"))
    md = dict(files).get("SKILL.md", b"").decode("utf-8", errors="replace")
    if len(mp.header_of(md).get("description", "")) < 20:
        out.append(tr("SKILL.md 의 description 은 20자 이상이어야 합니다", "The description in SKILL.md must be at least 20 characters"))
    if namespace in mp.VISIBILITY:
        refs = internal_refs(files)["public"]
        if refs:
            out.append(tr(f"사내 주소가 있어 {marketplace.ns_label(namespace)} 에 게시할 수 없습니다: {', '.join(refs[:5])}",
                          f"It has internal addresses, so it cannot go to {marketplace.ns_label(namespace)}: {', '.join(refs[:5])}"))
    return out


def preview(files: list[tuple[str, bytes]], info: dict, pods: list[str], expected: str = "") -> dict:
    """미리 보기. info = skill_files.inspect 결과(이름·설명·스크립트). expected = 「새 버전 게시」로 들어온 기대 이름(ns/name 또는 name)."""
    name = info.get("name", "")
    head = mp.header_of(dict(files).get("SKILL.md", b"").decode("utf-8", errors="replace"))
    there = mp._exists(name) if NAME.match(name or "") else None
    ns = there["namespace"] if there else ""
    out = {"name": name, "description": info.get("description", ""), "files": info.get("files", []), "scripts": info.get("scripts", []),
           "hub": there, "next_version": next_version(ns, name, head.get("version", "")) if there else (head.get("version") if VERSION.match(head.get("version", "")) else "1.0.0"),
           "changed": changed_files(ns, name, files) if there else None, "refs": internal_refs(files),
           "installed": installed_count(ns, name, pods) if there else 0,
           "blockers": blockers(name, None, "", files, ""), "expected_mismatch": "", "public_namespaces": sorted(mp.VISIBILITY)}
    want = expected.split("/")[-1] if expected else ""
    if want and want != name:
        out["expected_mismatch"] = want
    return out


def direct(files: list[tuple[str, bytes]], info: dict, blob_hash: str, namespace: str, version: str, confirm_scripts: bool, who: str) -> dict:
    """관리자 직접 게시(R2·R9). 검사를 모두 다시 하고 publishing 기록을 만든 뒤 게시한다."""
    name = info.get("name", "")
    namespace = marketplace.ns_slug(namespace)
    there = mp._exists(name) if NAME.match(name or "") else None
    if there:
        namespace = there["namespace"]                                          # 새 판은 그 네임스페이스로 고정
    if namespace not in marketplace.settings()["namespaces"]:
        raise MarketError(tr("이 스킬 허브에서 다루지 않는 네임스페이스입니다", "This skill hub does not serve that namespace"))
    if info.get("scripts") and not confirm_scripts:
        raise MarketError(tr("스크립트를 확인해야 게시할 수 있습니다", "Confirm the scripts before publishing"))
    with mp.name_lock(name):
        problems = blockers(name, version, namespace, files, who)
        if problems:
            raise MarketError(problems[0], 409)
        pub = [(r, mp.set_header(d.decode("utf-8"), name=name, version=version).encode("utf-8") if r == "SKILL.md" else d) for r, d in files]
        rid = datetime.now().strftime("%Y%m%d%H%M%S%f") + "-" + secrets.token_hex(3)
        (mp._dir() / (rid + ".zip")).write_bytes(mp.zip_of(pub))
        row = mp._write({"id": rid, "ts": mp._now(), "who": who, "pod": "", "profile": "", "path": "", "name": name, "version": version,
                         "origin": mp.ADMIN_ORIGIN, "derived_from": "", "description": info.get("description", "")[:240],
                         "files": [{"path": r, "size": len(d)} for r, d in pub], "status": "publishing", "message": "",
                         "namespace": namespace, "hash": blob_hash, "auto": False, "decided_by": who,
                         "scripts": len(info.get("scripts") or [])})
        return mp._publish(row, namespace, who)


def retry(rid: str, who: str, confirm_scripts: bool) -> tuple[dict, str]:
    """admin_upload 실패·오래된 publishing 기록을 다시 게시한다(DD11·R13). 돌려주는 두 번째 값: "reconciled"|"republished"."""
    row = mp.get(rid)
    if not row or row.get("origin") != mp.ADMIN_ORIGIN:
        raise MarketError(tr("관리자 직접 게시 기록이 아닙니다", "That is not a direct publish record"), 404)
    with mp.name_lock(row["name"]):
        row = mp.get(rid) or row
        if not (row["status"] == "failed" or mp.stale(row)):
            raise MarketError(tr("다시 게시할 수 있는 기록이 아닙니다", "That record cannot be published again"), 409)
        if row.get("scripts") and not confirm_scripts:
            raise MarketError(tr("스크립트를 확인해야 게시할 수 있습니다", "Confirm the scripts before publishing"))
        ns, name, version = row.get("namespace") or "", row["name"], row["version"]
        blob = mp.bundle_path(rid).read_bytes()
        files = mp._unzip(blob)
        on_hub = next((v for v in hub_versions(ns, name) if v["version"] == version), None) if ns else None
        if on_hub:
            mine = dict(mp._public_files(files) if ns in mp.VISIBILITY else files)
            theirs = {f["path"]: f for f in hub_files(ns, name, version)}
            other = any(r["id"] != rid and r["name"] == name and r["version"] == version and r["status"] == "published" for r in mp.requests())
            if set(mine) != set(theirs) or not all(_same(theirs[k], mine[k]) for k in mine) or other:
                raise MarketError(tr(f"허브의 v{version} 은 다른 묶음입니다", f"v{version} in the skill hub is a different bundle"), 409)
            status = "published" if on_hub["status"].upper() in ("", "PUBLISHED") else "pending_review"
            row.update(status=status, finished=mp._now(), message=tr("허브에 이미 있는 버전 — 기록만 맞춤", "Already in the skill hub — record reconciled"))
            return mp._write(row), "reconciled"
        problems = blockers(name, version, ns, files, who, rid=rid)
        if problems:
            raise MarketError(problems[0], 409)
        row.update(status="publishing", ts=mp._now(), message="")
        mp._write(row)
        return mp._publish(row, ns, who), "republished"


def bundle_hash(blob: bytes) -> str:
    return hashlib.sha256(blob).hexdigest()

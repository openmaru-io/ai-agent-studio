# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""주인 스킬 자동 승인(스펙 2026-10-28-001 §3-6-5, Q14·Q16·D6·D11·R13·R18, OMAI-1513).

  만든 기록  이 AAS 에서 사람이 스킬을 만들거나(skill_create) 올리거나(zip 적용) 고칠 때(파일 저장) 그 폴더의 묶음 해시와 사람을 적는다.
  판정      요청한 사람이 그 작업공간의 주인이고, 출처가 agent 이거나 「만든 기록이 그 사람이고 해시가 지금과 같다」일 때만 자동.
            고친 Hermes 기본 스킬(bundled_modified)·고친 허브 스킬(market)·기록 없는 local 은 관리자 승인.
  설정      관리자가 켜고 끈다(기본 켬). 대상 네임스페이스는 요청에 준 것, 없으면 auto_namespace, 그것도 없으면 공개가 아닌 첫 네임스페이스.
  사내 주소  공개 네임스페이스로 가는 묶음에 사내 도메인·사설 IP 가 있으면 거절, 구성원 네임스페이스면 경고만(R18).
"""
from __future__ import annotations

import hashlib
import ipaddress
import re
from datetime import datetime

from ..common import store

SCHEMA = """
CREATE TABLE IF NOT EXISTS skill_authored (
  pod TEXT NOT NULL, profile TEXT NOT NULL, path TEXT NOT NULL, who TEXT NOT NULL, hash TEXT NOT NULL, ts TEXT NOT NULL,
  PRIMARY KEY (pod, profile, path));
"""

AUTO_KEY, NS_KEY, DOMAINS_KEY = "market_auto_approve", "market_auto_namespace", "market_internal_domains"
DEFAULT_DOMAINS = ("openmaru.io", "local", "internal", "lan", "corp")   # 회사 도메인과 내부 전용 최상위 이름(x.local 등). 클러스터 이름은 소스에 적지 않는다(공개 스냅샷 검사)
PRIVATE_NETS = tuple(ipaddress.ip_network(n) for n in ("10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"))
_IP = re.compile(r"(?<![\d.])(\d{1,3}(?:\.\d{1,3}){3})(?![\d.])")


def _conn():
    conn = store.connect()
    conn.executescript(SCHEMA)
    return conn


def bundle_hash(files: list[tuple[str, bytes]]) -> str:
    """collect(folder) 결과(set_header 전 경로·바이트)의 해시. 파일 순서와 상관없다."""
    h = hashlib.sha256()
    for rel, data in sorted(files):
        h.update(rel.encode("utf-8") + b"\0" + hashlib.sha256(data).digest())
    return h.hexdigest()


def record(pod: str, profile: str, path: str, who: str, digest: str) -> None:
    with _conn() as conn:
        conn.execute("INSERT INTO skill_authored (pod, profile, path, who, hash, ts) VALUES (?,?,?,?,?,?) "
                     "ON CONFLICT (pod, profile, path) DO UPDATE SET who=excluded.who, hash=excluded.hash, ts=excluded.ts",
                     (pod, profile or "default", path, (who or "").lower(), digest, datetime.now().astimezone().isoformat(timespec="seconds")))


def lookup(pod: str, profile: str, path: str) -> dict | None:
    with _conn() as conn:
        r = conn.execute("SELECT who, hash, ts FROM skill_authored WHERE pod=? AND profile=? AND path=?",
                         (pod, profile or "default", path)).fetchone()
    return {"who": r["who"], "hash": r["hash"], "ts": r["ts"]} if r else None


def record_folder(pod: str, home, profile: str, rel: str, who: str) -> bool:
    """지금 폴더의 묶음 해시를 적는다. 폴더를 못 읽거나 올릴 수 없는 묶음이면(비밀값 등) 적지 않는다 — 자동 승인이 안 될 뿐이다."""
    from . import market_publish, skill_keep
    try:
        files = market_publish.collect(skill_keep.profile_root(home, profile) / rel)
    except Exception:                                    # MarketError·OSError·사이드카 오류 모두 「기록 없음」으로
        return False
    record(pod, profile, rel, who, bundle_hash(files))
    return True


def find_skill_dir(home, profile: str, name: str) -> str | None:
    """이름으로 프로파일 기준 스킬 폴더를 찾는다: skills/<이름> 또는 skills/<분류>/<이름>(올린 것은 uploaded). 공용 목록 캐시를 쓰지 않는다
    — 뒤 작업이 캐시를 다시 만들면 다른 요청·시험이 같은 작업공간의 목록을 읽는 중에 끼어든다."""
    from . import skill_keep
    skills = skill_keep.profile_root(home, profile) / "skills"
    try:
        if (skills / name / "SKILL.md").is_file():
            return f"skills/{name}"
        for d in sorted(skills.iterdir(), key=lambda x: x.name):
            if d.is_dir() and (d / name / "SKILL.md").is_file():
                return f"skills/{d.name}/{name}"
    except Exception:
        return None
    return None


def skill_folder_of(home, file_rel: str) -> tuple[str, str] | None:
    """데이터 폴더 기준 파일 경로(profiles/<p>/skills/…/x 또는 skills/…/x) → (프로파일, 프로파일 기준 스킬 폴더). SKILL.md 가 있는 가장 가까운 위 폴더."""
    parts = [p for p in str(file_rel or "").split("/") if p]
    profile, rest = ("default", parts) if parts[:1] == ["skills"] else (parts[1], parts[2:]) if parts[:1] == ["profiles"] and len(parts) > 2 else ("", [])
    if not rest or rest[0] != "skills" or len(rest) < 3:
        return None
    from . import skill_keep
    root = skill_keep.profile_root(home, profile)
    for n in range(len(rest) - 1, 1, -1):
        rel = "/".join(rest[:n])
        try:
            if (root / rel / "SKILL.md").is_file():
                return profile, rel
        except Exception:
            return None
    return None


# ---- 설정(관리자) -----------------------------------------------------------------------------------
def _meta(key: str) -> str | None:
    from ..common import settings
    with store.connect() as conn:
        return settings._meta(conn, key)


def _set_meta(key: str, value: str) -> None:
    from ..common import settings
    with store.connect() as conn:
        settings._set_meta(conn, key, value)


def config(namespaces: list[str]) -> dict:
    """{auto: 켬, namespace: 자동 승인 대상, domains: 사내 도메인}. 대상이 설정 밖이면 공개가 아닌 첫 네임스페이스."""
    from .market_publish import VISIBILITY
    ns = _meta(NS_KEY) or ""
    if ns not in namespaces:
        ns = next((n for n in namespaces if n not in VISIBILITY), namespaces[0] if namespaces else "")
    raw = _meta(DOMAINS_KEY)
    domains = [d for d in (raw.split(",") if raw is not None else DEFAULT_DOMAINS) if d.strip()]
    return {"auto": _meta(AUTO_KEY) != "0", "namespace": ns, "domains": [d.strip().lower() for d in domains]}


def set_config(auto: bool | None, namespace: str | None, namespaces: list[str]) -> dict:
    if namespace is not None:
        if namespace and namespace not in namespaces:
            raise ValueError(namespace)
        _set_meta(NS_KEY, namespace)
    if auto is not None:
        _set_meta(AUTO_KEY, "1" if auto else "0")
    return config(namespaces)


# ---- 판정 ---------------------------------------------------------------------------------------------
def eligible(row: dict, owner: bool, admin: bool) -> tuple[bool, str]:
    """(자동 승인할 수 있는가, 안 되는 이유 코드). row 는 request_publish 가 저장한 요청(hash 포함)."""
    if admin:
        return False, "admin"                             # 관리자는 지금처럼 직접 승인한다
    if not owner:
        return False, "not_owner"
    origin = row.get("origin")
    if origin == "agent":
        return True, ""
    if origin != "local":
        return False, "origin_" + str(origin)            # bundled_modified·market — 원본 권리 확인이 필요하다
    rec = lookup(row["pod"], row["profile"], row["path"])
    if not rec:
        return False, "no_record"
    if rec["who"] != str(row.get("who") or "").lower():
        return False, "other_author"
    if rec["hash"] != row.get("hash"):
        return False, "changed_since"                     # 만든 뒤 다른 누가(AI 에이전트 포함) 바꿨다
    return True, ""


def internal_refs(files: list[tuple[str, bytes]], domains: list[str]) -> list[str]:
    """사내 도메인·사설 IP 가 든 곳 「파일:줄」 목록(최대 20)."""
    out: list[str] = []
    pats = [re.compile(r"(?<![\w.-])([\w-]+\.)*" + re.escape(d) + r"(?![\w-])", re.I) for d in domains if d]
    for rel, data in files:
        for no, line in enumerate(data.decode("utf-8", errors="ignore").splitlines(), 1):
            hit = any(p.search(line) for p in pats)
            if not hit:
                for m in _IP.finditer(line):
                    try:
                        hit = any(ipaddress.ip_address(m.group(1)) in net for net in PRIVATE_NETS)
                    except ValueError:
                        continue
                    if hit:
                        break
            if hit:
                out.append(f"{rel}:{no}")
                if len(out) >= 20:
                    return out
    return out

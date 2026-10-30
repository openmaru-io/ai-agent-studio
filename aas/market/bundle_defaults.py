# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""AAS 기본 스킬 묶음을 모든 프로파일에 배달한다(스펙 2026-10-29-001 D4 B·R3·R4·R12·R14·F6·F8, OMAI-1534).

  누구에게  모든 작업공간의 모든 프로파일. 루트 default 는 Hermes 가 설치를 막아 뺀다(R3).
  언제      리더의 스킬 허브 주기(market_update_cycle)에서, INTERVAL 마다. 허브에 묶음 판 이상이 게시된 뒤에만(그 전엔 기다린다).
  배달 기록 market_bundle_delivery. 요청은 줄에 세울 뿐이라(queued) 요청의 끝 상태를 보고 done·failed 로 고친다(F6).
            done 이면 다시 넣지 않는다 — 사용자가 지워도 다시 넣지 않는다(D4 B). 지웠는지 파일을 볼 필요가 없다.
            failed 는 그 판에 한 번만 시도하고 「확인할 것」에 보인다. 묶음 판이 바뀌면 다시 대상이다(R4).
            사람이 스킬 허브에서 설치하면(설치 기록이 생기면) done 으로 본다.
  한 프로파일 한 주기에 요청 하나(끝나지 않은 요청이 있으면 409 → 기록 없이 다음 주기).
  대상 제한 AAS_BUNDLE_DELIVER_PODS(작업공간 id, 쉼표) — OKE 첫 반영을 한 작업공간에서 먼저 보려고(T2b). 비면 모두.
  환경 값 AAS_DEFAULT_SKILLS 의 다른 패키지는 이 규칙을 쓰지 않는다 — main 첫 생성 때만(marketplace.queue_defaults, R14).
"""
from __future__ import annotations

import os
import threading
import time
from datetime import datetime

from ..common import store
from ..common.i18n import tr
from . import marketplace, skill_bundle

NAMESPACE = "free"
INTERVAL = 60.0                                   # 허브 판 확인·요청 간격(초). 리더 주기는 5초
SCHEMA = """
CREATE TABLE IF NOT EXISTS market_bundle_delivery (
  pod TEXT NOT NULL, profile TEXT NOT NULL, package TEXT NOT NULL, version TEXT NOT NULL, request TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL, message TEXT NOT NULL DEFAULT '', ts TEXT, PRIMARY KEY (pod, profile, package));
"""
_last = [0.0]
_lock = threading.Lock()


def _now() -> str:
    return datetime.now().astimezone().isoformat(timespec="seconds")


def _conn():
    conn = store.connect()
    conn.executescript(SCHEMA)
    return conn


def reset() -> None:
    _last[0] = 0.0


def packages() -> list[str]:
    """묶음 패키지 id(free/<이름>)."""
    return [f"{NAMESPACE}/{n}" for n in skill_bundle.names()]


def record(pod_id: str, profile: str, package_id: str) -> dict | None:
    with _conn() as conn:
        row = conn.execute("SELECT * FROM market_bundle_delivery WHERE pod=? AND profile=? AND package=?", (pod_id, profile, package_id)).fetchone()
    return dict(row) if row else None


def _put(pod_id: str, profile: str, package_id: str, version: str, status: str, request: str = "", message: str = "") -> None:
    with _conn() as conn:
        conn.execute("INSERT INTO market_bundle_delivery (pod, profile, package, version, request, status, message, ts) VALUES (?,?,?,?,?,?,?,?) "
                     "ON CONFLICT(pod, profile, package) DO UPDATE SET version=excluded.version, request=excluded.request, "
                     "status=excluded.status, message=excluded.message, ts=excluded.ts",
                     (pod_id, profile, package_id, version, request, status, message[:300], _now()))


def _settle(pod_id: str, rows: dict) -> None:
    """queued 줄을 요청의 끝 상태로 고친다."""
    waiting = [r for r in rows.values() if r["status"] == "queued" and r["request"]]
    if not waiting:
        return
    ended = {str(r["id"]): r for r in marketplace.requests(pod_id, 2000) if r["status"] in ("done", "failed")}
    for w in waiting:
        r = ended.get(w["request"])
        if r is not None:
            _put(pod_id, w["profile"], w["package"], w["version"], r["status"], w["request"], str(r.get("message") or ""))
            rows[(w["profile"], w["package"])] = {**w, "status": r["status"]}


def _ready() -> dict[str, dict]:
    """허브에 묶음 버전 이상이 게시된 패키지 {id: 허브 패키지}. 허브에 닿지 않으면 MarketError."""
    out = {}
    for name in skill_bundle.names():
        want = skill_bundle.front(name)["version"]
        try:
            pkg = marketplace.package(NAMESPACE, name)
        except marketplace.MarketError as exc:
            if exc.code == 404:
                continue
            raise
        if marketplace._ver(str(pkg.get("version") or "")) >= marketplace._ver(want):
            out[f"{NAMESPACE}/{name}"] = {**pkg, "_bundle": want}
    return out


def deliver(pods: list, profiles_of) -> list[str]:
    """한 주기. 요청한 「pod/프로파일 패키지」 목록. profiles_of(pod) = 그 작업공간의 프로파일 이름들."""
    with _lock:
        if _last[0] and time.monotonic() - _last[0] < INTERVAL:
            return []
        _last[0] = time.monotonic()
    try:
        ready = _ready()
    except marketplace.MarketError as exc:            # 허브에 닿지 않음 — 다음 주기
        print(f"기본 스킬 배달: 허브를 읽지 못했습니다: {exc}", flush=True)   # i18n-ignore: 로그
        return []
    only = {p.strip() for p in os.environ.get("AAS_BUNDLE_DELIVER_PODS", "").split(",") if p.strip()}
    done: list[str] = []
    for pod in [p for p in pods if not only or p.id in only]:
        with _conn() as conn:
            rows = {(r["profile"], r["package"]): dict(r) for r in conn.execute("SELECT * FROM market_bundle_delivery WHERE pod=?", (pod.id,))}
        _settle(pod.id, rows)
        profiles = [p for p in profiles_of(pod) if p != "default"]
        have = {(r["profile"], r["package"]) for r in marketplace.installed(pod.id)}
        for profile in profiles:
            for package_id in packages():
                row = rows.get((profile, package_id))
                if row and row["status"] in ("done", "queued"):
                    continue
                if (profile, package_id) in have:          # 사람이 설치했다
                    _put(pod.id, profile, package_id, ready.get(package_id, {}).get("_bundle", ""), "done")
                    continue
                if package_id not in ready:                # 허브에 아직 묶음 판이 없다 — 게시를 기다린다
                    continue
                pkg = ready[package_id]
                if row and row["status"] == "failed" and row["version"] == pkg["_bundle"]:   # 이 판은 이미 한 번 실패했다
                    continue
                try:
                    req = marketplace.request_install(pod.id, pod.container, pkg, "", profile, "install", "aas", profiles)
                except marketplace.MarketError as exc:
                    if exc.code == 409:                    # 끝나지 않은 요청 — 다음 주기
                        break
                    _put(pod.id, profile, package_id, pkg["_bundle"], "failed", "", str(exc))
                    continue
                _put(pod.id, profile, package_id, pkg["_bundle"], "queued", str(req["id"]))
                done.append(f"{pod.id}/{profile} {package_id}")
                break                                      # 한 프로파일 한 주기에 하나
    return done


def issues(pod_id: str, profile: str) -> list[dict]:
    """「확인할 것」: 기본 스킬 설치 실패(그 버전에서 다시 하지 않는다 — 스킬 허브에서 직접 설치하면 풀린다)."""
    with _conn() as conn:
        rows = [dict(r) for r in conn.execute("SELECT package, version, message FROM market_bundle_delivery WHERE pod=? AND profile=? AND status='failed'",
                                              (pod_id, profile))]
    out = []
    for r in rows:
        name = r["package"].split("/", 1)[-1]
        why = r["message"] or tr("원인 모름", "unknown cause")
        out.append({"code": "market_default_failed", "level": "bad", "package": r["package"], "version": r["version"],
                    "text": tr(f"기본 스킬 {name} v{r['version']} 을 설치하지 못했습니다. 스킬 허브에서 직접 설치하세요: {why}",
                               f"Could not install the default skill {name} v{r['version']}. Install it from the skill hub: {why}")})
    return out


def follow_profile(pod_id: str, profile: str, mode: str, to: str = "") -> None:
    with _conn() as conn:
        if mode == "forget":
            conn.execute("DELETE FROM market_bundle_delivery WHERE pod=? AND profile=?", (pod_id, profile))
        elif mode == "rename" and to:
            conn.execute("UPDATE market_bundle_delivery SET profile=? WHERE pod=? AND profile=?", (to, pod_id, profile))

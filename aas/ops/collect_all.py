# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""모든 POD 의 크론 건강을 모아 관리자용 한 편으로 합친다(계획 R13·R12).

POD 는 최대 workers(기본 8)개까지 동시에 읽고, POD 하나가 timeout(기본 60초)을 넘기면 그 POD 만 「수집 실패」로 남긴다.
스레드는 죽일 수 없으므로 멈춘 POD 는 사이드카 요청 제한(10초)이 풀 때까지 자리를 차지하지만, 다른 POD 수집은 기다리지 않는다.
합친 결과의 프로파일 이름은 `<POD>/<프로파일>` 이다. 무시(음소거) 기록은 원래 이름(raw_profile)으로 맞춘다.
"""
from __future__ import annotations

import json
import threading
import time
from concurrent.futures import ThreadPoolExecutor, wait
from datetime import datetime, timezone
from typing import Callable

from ..common import config, db
from . import cron_health
from ..common.i18n import tr

ROW_KEYS = ("incidents", "failed_jobs", "stalled", "silent")
SUM_KEYS = ("profiles", "profiles_ok", "jobs", "jobs_active", "open_incidents", "new_incidents",
            "live_incidents", "settled_incidents", "failed_jobs", "stalled", "silent")


def _num(key: str, default, cast, low):
    try:
        value = cast(config.get(key, str(default)))
    except ValueError:
        return default
    return value if value >= low else default


def workers() -> int:
    return _num("AAS_COLLECT_WORKERS", 8, int, 1)


def timeout() -> float:
    return _num("AAS_COLLECT_TIMEOUT", 60.0, float, 1.0)


def flow_timeout() -> float:
    return _num("AAS_FLOW_TIMEOUT", 120.0, float, 1.0)


def scoped(health: dict, pod_id: str) -> dict:
    """한 POD 의 수집 결과에서 프로파일 이름 앞에 POD id 를 붙인다. 원래 이름은 raw_profile 로 남긴다."""
    out = dict(health)
    out["profiles"] = [{**p, "name": f"{pod_id}/{p['name']}", "raw_name": p["name"]} for p in health["profiles"]]
    for key in ROW_KEYS:
        out[key] = [{**r, "raw_profile": r.get("profile"), "profile": f"{pod_id}/{r.get('profile')}"} for r in health.get(key, [])]
    t = dict(health["totals"])
    t["stale_profiles"] = [f"{pod_id}/{n}" for n in t.get("stale_profiles", [])]
    out["totals"] = t
    return out


def failure(pod_id: str, reason: str, now: datetime | None = None) -> dict:
    """수집하지 못한 POD 를 나타내는 결과. 프로파일 한 줄이 오류로 남아 스냅샷·다이제스트에 보인다."""
    now = now or datetime.now(timezone.utc).astimezone()
    name = f"{pod_id}/(수집)"  # i18n-ignore: 이름 표지 "(수집)" 을 digest 가 맞대어 비교한다(아래 줄 raw_name 포함)
    row = {"name": name, "raw_name": "(수집)", "jobs_status": "error", "exec_status": "error", "detail": reason, "jobs_total": 0, "jobs_active": 0,
           "open_incidents": 0, "new_incidents": 0, "failed_jobs": 0, "stalled_jobs": 0, "silent_jobs": 0, "runs_7d": 0, "runs_failed_7d": 0, "stale": False}
    return {"collected_at": now.isoformat(timespec="seconds"), "profiles": [row], "incidents": [], "failed_jobs": [], "stalled": [], "silent": [],
            "totals": {k: 0 for k in SUM_KEYS} | {"profiles": 1, "stale_profiles": []}, "_failed_pod": {"pod": pod_id, "reason": reason}}


def merge(healths: list[dict], pods_total: int) -> dict:
    """POD 별 결과(scoped 또는 failure)를 하나로 합친다. 숫자는 더하고 목록은 이어 붙인다."""
    now = max((h["collected_at"] for h in healths), default=datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds"))
    out: dict = {"collected_at": now, "profiles": [], **{k: [] for k in ROW_KEYS}}
    totals = {k: 0 for k in SUM_KEYS}
    stale: list[str] = []
    failed: list[dict] = []
    for h in healths:
        out["profiles"] += h["profiles"]
        for key in ROW_KEYS:
            out[key] += h.get(key, [])
        for k in SUM_KEYS:
            totals[k] += h["totals"].get(k, 0)
        stale += h["totals"].get("stale_profiles", [])
        if h.get("_failed_pod"):
            failed.append(h["_failed_pod"])
    # 수집 실패 줄은 「프로파일 수」에 세지만 성공으로는 세지 않는다(failure 의 profiles_ok 는 0)
    totals["stale_profiles"] = stale
    out["totals"] = totals
    out["incidents"].sort(key=lambda i: not i.get("new"))
    out["pods"] = {"ok": pods_total - len(failed), "total": pods_total, "failed": failed}
    return out


def map_pods(pods: list, fn: Callable, workers: int | None = None, timeout: float | None = None) -> dict[str, tuple[bool, object]]:
    """각 POD 에 fn(pod)을 동시에(workers 개까지) 돌린다. 반환: {pod id: (성공 여부, 값 또는 실패 이유)}.
    POD 하나가 실행을 시작한 뒤 timeout 초를 넘기거나 예외를 내면 그 POD 만 실패로 적는다. 대기열에서 기다린 시간은 세지 않는다."""
    workers, timeout = workers or globals()["workers"](), timeout or globals()["timeout"]()
    out: dict[str, tuple[bool, object]] = {}
    if not pods:
        return out
    begun: dict[str, float] = {}
    pool = ThreadPoolExecutor(max_workers=workers, thread_name_prefix="aas-pods")

    def run(p):
        begun[p.id] = time.monotonic()
        return fn(p)
    try:
        futures = {pool.submit(run, p): p for p in pods}
        pending, started = set(futures), time.monotonic()
        hard_stop = started + timeout * (len(pods) / workers + 2)       # 안전 상한: 모든 차례를 합친 시간
        while pending:
            done, pending = wait(pending, timeout=0.05)
            for f in done:
                p = futures[f]
                try:
                    out[p.id] = (True, f.result())
                except Exception as exc:
                    out[p.id] = (False, f"{type(exc).__name__}: {str(exc)[:120]}")
            now = time.monotonic()
            for f in list(pending):
                p = futures[f]
                if (p.id in begun and now - begun[p.id] > timeout) or now > hard_stop:
                    out[p.id] = (False, tr(f"시간 초과({timeout:g}초)", f"Timed out ({timeout:g} s)"))
                    pending.discard(f)
    finally:
        pool.shutdown(wait=False, cancel_futures=True)
    return out


def collect_rows(pods: list, collect: Callable | None = None, workers: int | None = None, timeout: float | None = None) -> dict:
    """pods 의 hermes_home 을 동시에 읽어 POD 마다 결과(scoped 또는 failure)를 돌려준다. 담당 서버가 자기 몫만 읽을 때도 쓴다."""
    collect = collect or cron_health.collect                  # 호출할 때 정한다(기본 인자로 묶으면 시험에서 바꿔 끼울 수 없다)
    got = map_pods(pods, lambda p: collect(home=p.hermes_home), workers, timeout)
    return {p.id: scoped(got[p.id][1], p.id) if got[p.id][0] else failure(p.id, str(got[p.id][1])) for p in pods if p.id in got}


def collect_pods(pods: list, collect: Callable | None = None, workers: int | None = None, timeout: float | None = None) -> dict:
    """pods 의 hermes_home 을 동시에 읽어 합친다. 시간을 넘기거나 예외가 난 POD 는 failure 로 남긴다."""
    rows = collect_rows(pods, collect, workers, timeout)
    return merge([rows[p.id] for p in pods if p.id in rows], len(pods))


class RoundGuard:
    """한 바퀴가 안 끝났으면 다음 바퀴를 건너뛴다(R12)."""

    def __init__(self):
        self._busy = threading.Lock()

    def run(self, fn: Callable) -> bool:
        if not self._busy.acquire(blocking=False):
            return False
        try:
            fn()
            return True
        finally:
            self._busy.release()


# ---- 마지막 바퀴 기록(관리자 요약이 보여 준다) ----------------------------------------------
def save_round(pods: dict, seconds: float) -> None:
    from ..common import store
    value = json.dumps({"ts": datetime.now().astimezone().isoformat(timespec="seconds"), "seconds": round(seconds, 1), "pods": pods}, ensure_ascii=False)
    with store.connect() as conn:
        conn.execute(db.upsert("meta", ("key", "value"), ("key",)), ("collect_round", value))


def last_round() -> dict | None:
    from ..common import store
    with store.connect() as conn:
        row = conn.execute("SELECT value FROM meta WHERE key='collect_round'").fetchone()
    return json.loads(row["value"]) if row else None

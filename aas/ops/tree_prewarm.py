# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""서버가 뜬 뒤 제한을 둔 묶음 미리 받기(스펙 2026-11-20-001 §5-0 0-4 A2).

배포 직후 첫 화면은 묶음이 없어 에이전트마다 처음부터 받는다(20~60초, 프로파일 화면은 10초 한도라 「응답 없음」).
최근 7일 사람이 쓴 에이전트만 최대 20개, 이 복제본에서 한 번에 하나씩 미리 받아 둔다. 복제본마다 자기가 받는다 — ingress 가
사용자를 한 복제본에 고정해(`aas_u` 쿠키) 리더만 받으면 다른 복제본 사용자에게는 효과가 없다(Eng 재검토 M4·H3).
미리 받은 묶음은 `tree_cache.grace` 로 버리기 시간만큼 유예한다. 배경 스레드라 사람 사용(`tree_cache.HUMAN`)으로 세지 않는다.
`AAS_TREE_PREWARM`(기본 켬, 0·off 면 끔)으로 정한다.
"""
from __future__ import annotations

import os
import threading
import time
from typing import Callable

from ..hermes.readers import tree_cache

START_DELAY = 60.0      # 서버가 뜬 뒤 이만큼 기다렸다 시작한다 — 뜨는 동안의 다른 일(등록부·첫 요청)과 겹치지 않게
BUDGET = 600.0          # 전체 상한(초). 넘으면 남은 에이전트는 받지 않는다
LIMIT = 20              # 최대 에이전트 수
RECENT_DAYS = 7


def enabled() -> bool:
    """기본 켬. AAS_TREE_PREWARM 이 0·false·no·off 면 끈다. 처음에는 기본 끔이었다 — OKE 시험(서버가 뜬 지 6분 뒤 첫 방문 2.2초,
    메모리 166Mi)을 보고 켰다(스펙 2026-11-20-001 §5-0-5·6)."""
    return (os.environ.get("AAS_TREE_PREWARM") or "").strip().lower() not in ("0", "false", "no", "off")


def _skip(backend, now: float) -> str:
    """받지 않을 까닭(빈 문자열이면 받는다). 옛 사이드카·받기 실패·잘림·응답 없음 기억이 있으면 받아 봐야 실패하거나 사이드카만 더
    바쁘게 한다. 이미 묶음이 있는 경우는 여기서 다루지 않는다(run 이 받지 않고 유예만 건다)."""
    if getattr(backend, "_has_tree", None) is False:
        return "old_sidecar"
    memo = getattr(backend, "fail_memo", 30.0)
    failed = getattr(backend, "_tree_failed_at", 0.0)
    if failed and now - failed < memo:
        return "failed"
    if getattr(backend, "_cut_warned", False):
        return "cut"
    down = getattr(backend, "_down_at", 0.0)
    if down and now - down < memo:
        return "down"
    return ""


def run(get_pods: Callable[[], dict], recent: Callable[[int], list[str]], *, stop: threading.Event | None = None,
        clock: Callable[[], float] = time.monotonic, start_delay: float = START_DELAY, budget: float = BUDGET,
        limit: int = LIMIT) -> dict:
    """미리 받기 한 번. get_pods(): {pod id: Pod}(부를 때마다 지금 등록부), recent(limit): 최근 쓴 pod id 목록(많이 쓴 순).
    결과 {"warmed", "kept", "skipped", "failed"} 를 돌려주고 한 줄 로그를 남긴다. 실패한 에이전트는 건너뛰고 다음으로 간다."""
    stop = stop or threading.Event()
    out: dict[str, list[str]] = {"warmed": [], "kept": [], "skipped": [], "failed": []}
    if start_delay > 0 and stop.wait(start_delay):
        return out
    if stop.is_set():
        return out
    try:
        targets = list(recent(limit))[:limit]
    except Exception as exc:
        print(f"묶음 미리 받기 대상 읽기 실패: {type(exc).__name__}", flush=True)   # i18n-ignore: 로그
        return out
    started = clock()
    for pid in targets:
        if stop.is_set() or clock() - started >= budget:
            break
        pod = get_pods().get(pid)                                  # 받는 사이 등록부에서 사라질 수 있다 — 그때는 건너뛴다
        backend = getattr(getattr(pod, "hermes_home", None), "backend", None)
        if backend is None:
            out["skipped"].append(pid)
            continue
        if backend.has_tree():
            # 이미 있다 — 서버가 뜰 때 도는 배경 작업(aas-pods·aas-office·aas-market)이 먼저 받은 것. 다시 받지 않고 유예만 건다.
            # 건너뛰기만 하면 유예가 없어 첫 정리 바퀴(5분)에 버려졌다(OKE 2026-11-20 #694, 건너뜀 4 → 버림 4)
            tree_cache.grace(backend.label, clock() + tree_cache.idle_drop())
            out["kept"].append(pid)
            continue
        if _skip(backend, time.monotonic()):
            out["skipped"].append(pid)
            continue
        try:
            ok = backend.snapshot()
        except Exception:
            out["failed"].append(pid)
            continue
        if ok and backend.has_tree():
            tree_cache.grace(backend.label, clock() + tree_cache.idle_drop())
            out["warmed"].append(pid)
        else:
            out["failed"].append(pid)
    took = clock() - started
    print(f"묶음 미리 받기: 받음 {len(out['warmed'])} 있던것유예 {len(out['kept'])} 건너뜀 {len(out['skipped'])} 실패 {len(out['failed'])} "   # i18n-ignore: 로그
          f"{took:.0f}초 (대상 {len(targets)})", flush=True)
    return out

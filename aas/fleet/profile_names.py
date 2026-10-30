# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""에이전트 목록의 프로파일 이름 저장값(스펙 2026-10-19-006 R1·D5).

- 목록(`/api/agents`·토픽 agents)은 여기 저장된 값만 읽고 사이드카를 기다리지 않는다. 사이드카 하나가 멈추면 화면 전체가 막혔다(리뷰 O1·O2).
- 값이 없거나 TTL 이 지났으면 그 에이전트의 읽기를 뒤 스레드에서 하나만 시작한다. 이미 돌고 있으면 시작하지 않는다.
- 읽기가 예외면 None 을 저장한다. TTL 이 지나면 다시 시도한다.
- forget(pod): 프로파일을 만들거나 이름을 바꾸거나 지운 뒤 부른다. 그 전에 시작한 읽기의 결과는 저장하지 않는다(세대 번호).
- `_cached` 를 쓰지 않는 이유: 처음 호출이 fn 을 기다리고, 예외를 저장하지 않으며, 시간 초과 뒤에도 building 락을 쥔 채 돈다.
"""
from __future__ import annotations

import threading
import time
from typing import Callable

TTL = 30.0

_lock = threading.Lock()
_values: dict[str, tuple[float, list[str] | None]] = {}   # pod id → (읽은 시각, 이름 목록 | None)
_running: set[str] = set()
_generation: dict[str, int] = {}


def peek(pod_id: str, read: Callable[[], list[str] | None]) -> list[str] | None:
    """저장된 이름 목록(없으면 None). 없거나 TTL 이 지났으면 read 를 뒤에서 하나만 돌린다. 기다리지 않는다."""
    now = time.monotonic()
    with _lock:
        hit = _values.get(pod_id)
        start = (hit is None or now - hit[0] >= TTL) and pod_id not in _running
        if start:
            _running.add(pod_id)
            gen = _generation.get(pod_id, 0)
    if start:
        threading.Thread(target=_run, args=(pod_id, read, gen), daemon=True, name="aas-profile-names").start()
    return hit[1] if hit else None


def _run(pod_id: str, read: Callable[[], list[str] | None], gen: int) -> None:
    try:
        names = read()
    except Exception as exc:                                   # 사이드카 오류 — 그 줄만 「—」, TTL 뒤 다시
        print(f"프로파일 이름 읽기 실패 {pod_id}: {type(exc).__name__}", flush=True)   # i18n-ignore: 로그
        names = None
    with _lock:
        if _generation.get(pod_id, 0) == gen:                 # 읽는 동안 forget 되었으면 옛 결과를 저장하지 않는다
            _values[pod_id] = (time.monotonic(), names)
        _running.discard(pod_id)


def forget(pod_id: str) -> None:
    with _lock:
        _generation[pod_id] = _generation.get(pod_id, 0) + 1
        _values.pop(pod_id, None)


__all__ = ["TTL", "peek", "forget"]

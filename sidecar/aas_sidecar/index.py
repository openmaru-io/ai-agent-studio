# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""폴더 변경 색인(스펙 2026-10-24-013 R10·D3). 서버가 1분마다 목록 전체를 받지 않고 「지난번 이후 바뀐 것」만 묻게 한다.

every 가 0 이면 물을 때 폴더를 훑어(`Ops.tree` 목록) 지난 목록과 견준다. 마지막 훑기가 2초 안이면 그 결과를 쓴다 — 서버 두 대가
함께 물어도 한 번만 훑는다. 그러면 /v1/changes 가 전체 받기만큼 걸렸다(OKE 평균 12~13초, 스펙 2026-11-20-001 §2-4).
every 가 0 보다 크면 최근 ACTIVE 초 안에 물은 폴더를 뒤에서 「훑기가 끝난 뒤 every 초」마다 다시 훑어 두고, 물으면 그 색인으로
바로 답한다(§3-8, C안). 물을 때 훑는 것은 처음·AAS 가 고친 직후(fresh)·색인이 SERVE_MAX 초보다 오래됐을 때뿐이다.
파일 변경 알림(inotify)은 쓰지 않는다: 표준 라이브러리에 없고 데이터 폴더가 NFS 라 알림이 빠질 수 있다.

커서는 「<이 프로세스의 무작위 이름>:<세대>」다. 사이드카가 다시 시작됐거나 기록이 넘쳐 커서 뒤를 다 알 수 없으면 `reset` 을
알린다 — 서버는 목록 전체를 다시 받는다.
"""
from __future__ import annotations

import secrets
import threading
import time

REUSE = 2.0                      # 뒤 훑기가 꺼져 있을 때: 이 안에 다시 물으면 다시 훑지 않는다(초)
LOG_MAX = 20_000                 # 기억하는 변경 줄 수. 넘치면 오래된 커서는 reset
ACTIVE = 900.0                   # 이 안에 물은 폴더만 뒤에서 다시 훑는다. 서버는 사람이 쓰지 않은 묶음을 버린다(tree_cache.idle_drop, 기본 1시간 —
                                 # AAS_TREE_IDLE_DROP 으로 늘리면 15분 넘게 비운 뒤 맞추기는 이 색인이 아니라 사이드카 그 자리 훑기가 된다)
SERVE_MAX = 120.0                # 뒤 훑기가 이보다 오래 끝나지 않았으면(멈춤·계속 실패) 물을 때 훑는다
FAIL_LOG_EVERY = 600.0           # 같은 폴더의 뒤 훑기 실패 로그는 10분에 한 줄
TICK = 1.0                       # 뒤 스레드가 할 일을 보는 간격(초)


class ChangeIndex:
    def __init__(self, scan, clock=time.monotonic, every: float = 0.0, thread: bool = True):
        self._scan = scan                                   # (params) → {"entries": [...], "partial": [...]} — Ops.tree 목록
        self._clock = clock
        self._every = max(0.0, float(every or 0.0))
        self._thread_on = thread
        self._started = False
        self._epoch = secrets.token_hex(4)
        self._lock = threading.Lock()                       # 색인 상태만 지킨다. 훑는 동안은 쥐지 않는다 — 큰 폴더 하나가 다른 폴더를 막았다
        self._scanning: dict[tuple, threading.Lock] = {}    # 같은 폴더는 한 번에 하나만 훑는다(기록 순서가 훑은 순서와 같게)
        self._failed: dict[tuple, float] = {}
        # 훑기 인자 → {gen, prev(경로 → 항목), log[(gen, 경로)], at(훑기가 끝난 시각), partial, params, asked(마지막으로 물은 시각)}
        self._state: dict[tuple, dict] = {}

    def record(self, key: tuple, listing: dict, params: dict | None = None) -> str:
        """목록 하나를 색인에 넣고 그 커서를 돌려준다(tree 가 부른다). params 가 있으면 그 폴더를 뒤에서 다시 훑을 수 있다."""
        with self._lock:
            cursor = self._record(key, listing)
            self._touch(key, params)
        self._ensure_thread()
        return cursor

    def _record(self, key: tuple, listing: dict) -> str:
        st = self._state.setdefault(key, {"gen": 0, "prev": None, "log": [], "at": 0.0, "partial": []})
        now = {e["path"]: e for e in listing["entries"]}
        prev = st["prev"]
        if prev is not None:
            changed = [p for p, e in now.items() if p not in prev or _sig(prev[p]) != _sig(e)]
            removed = [p for p in prev if p not in now]
            if changed or removed:
                st["gen"] += 1
                st["log"].extend((st["gen"], p) for p in changed + removed)
                if len(st["log"]) > LOG_MAX:
                    st["log"] = st["log"][-LOG_MAX:]
        st["prev"], st["partial"], st["at"] = now, list(listing.get("partial", [])), self._clock()
        return f"{self._epoch}:{st['gen']}"

    def _touch(self, key: tuple, params: dict | None) -> None:
        st = self._state.get(key)
        if st is not None:
            st["asked"] = self._clock()
            if params is not None:
                st["params"] = params

    def _limit(self) -> float:
        """이보다 오래된 색인은 물을 때 다시 훑는다."""
        return SERVE_MAX if self._every > 0 else REUSE

    def _rescan(self, key: tuple, params: dict, *, fresh: bool, max_age: float) -> bool:
        """그 폴더를 훑어 색인에 넣는다. 잘렸으면 색인을 버리고 False. 같은 폴더를 다른 쪽이 훑는 중이면 끝나기를 기다리고,
        fresh 가 아니면 그 결과를 쓴다(서버 두 대가 함께 물어도 한 번만 훑는다)."""
        with self._lock:
            lock = self._scanning.setdefault(key, threading.Lock())
        with lock:
            with self._lock:
                st = self._state.get(key)
                if not fresh and st is not None and st["prev"] is not None and self._clock() - st["at"] < max_age:
                    return True
            listing = self._scan(params)
            with self._lock:
                if listing.get("truncated"):
                    # 항목 상한에서 잘린 목록을 견주면 잘린 나머지가 「없어짐」으로 적혀 서버가 있는 파일을 없다고 답한다.
                    # 색인을 버리고 reset 으로 알린다 — 서버는 잘린 묶음으로 처리한다(스펙 2026-11-03-003 R7·D12)
                    self._state.pop(key, None)
                    return False
                self._record(key, listing)
                self._state[key].setdefault("params", params)
                self._failed.pop(key, None)
                return True

    def changes(self, key: tuple, since: str, params: dict, fresh: bool = False) -> dict:
        """since 커서 뒤에 생기거나 바뀐 항목(지금 값)과 없어진 경로. 알 수 없으면 reset.
        fresh: 색인을 쓰지 않고 다시 훑는다 — AAS 가 방금 고친 직후(서버의 invalidate)에 옛 훑기를 돌려주지 않게."""
        limit = self._limit()
        with self._lock:
            self._touch(key, params)
            st = self._state.get(key)
            need = fresh or st is None or st["prev"] is None or self._clock() - st["at"] >= limit
        if need and not self._rescan(key, params, fresh=fresh, max_age=limit):
            return {"cursor": "", "reset": True, "truncated": True}
        self._ensure_thread()
        with self._lock:
            st = self._state.get(key)
            if st is None or st["prev"] is None:                 # 그사이 뒤 훑기가 잘려 색인을 버렸다
                return {"cursor": "", "reset": True, "truncated": True}
            self._touch(key, params)
            cursor = f"{self._epoch}:{st['gen']}"
            epoch, _, gen = str(since or "").partition(":")
            try:
                since_gen = int(gen)
            except ValueError:
                since_gen = -1
            oldest = st["log"][0][0] if st["log"] else st["gen"] + 1
            if epoch != self._epoch or since_gen < 0 or since_gen > st["gen"] or (since_gen < st["gen"] and since_gen + 1 < oldest):
                return {"cursor": cursor, "reset": True}
            paths = sorted({p for g, p in st["log"] if g > since_gen})
            prev = st["prev"]
            return {"cursor": cursor, "reset": False, "entries": [prev[p] for p in paths if p in prev],
                    "removed": [p for p in paths if p not in prev], "partial": st["partial"]}

    def scan_due(self) -> int:
        """뒤 훑기 한 바퀴: 최근 ACTIVE 초 안에 물었고 마지막 훑기가 every 초 전에 끝난 폴더를 하나씩 훑는다. 훑은 폴더 수.
        실패하면 지난 색인을 그대로 둔다 — 색인이 SERVE_MAX 초를 넘으면 물을 때 훑는다."""
        if self._every <= 0:
            return 0
        now = self._clock()
        with self._lock:
            due = [(k, st["params"]) for k, st in self._state.items()
                   if st.get("params") is not None and st["prev"] is not None
                   and now - st.get("asked", 0.0) < ACTIVE and now - st["at"] >= self._every]
        done = 0
        for key, params in due:
            try:
                self._rescan(key, params, fresh=False, max_age=self._every)
            except Exception as exc:                                 # noqa: BLE001 — 한 폴더가 실패해도 다른 폴더는 훑는다
                self._fail_log(key, exc)
            done += 1
        return done

    def _fail_log(self, key: tuple, exc: Exception) -> None:
        now = self._clock()
        with self._lock:
            if now - self._failed.get(key, -FAIL_LOG_EVERY) < FAIL_LOG_EVERY:
                return
            self._failed[key] = now
        print(f"aas-sidecar: 뒤 훑기 실패 path={key[0] or '.'} {type(exc).__name__}", flush=True)

    def _ensure_thread(self) -> None:
        if self._every <= 0 or not self._thread_on:
            return
        with self._lock:
            if self._started:
                return
            self._started = True
        threading.Thread(target=self._loop, daemon=True, name="aas-sidecar-index").start()

    def _loop(self) -> None:
        while True:
            try:
                self.scan_due()
            except Exception as exc:                                 # noqa: BLE001 — 뒤 스레드는 멈추지 않는다
                print(f"aas-sidecar: 뒤 훑기 바퀴 실패 {type(exc).__name__}", flush=True)
            time.sleep(TICK)


def _sig(e: dict) -> tuple:
    return (e.get("type"), e.get("size"), e.get("mtime"), e.get("sha256"))

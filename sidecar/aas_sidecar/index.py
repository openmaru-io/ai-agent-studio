# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""폴더 변경 색인(스펙 2026-10-24-013 R10·D3). 서버가 1분마다 목록 전체를 받지 않고 「지난번 이후 바뀐 것」만 묻게 한다.

물을 때 폴더를 훑어(`Ops.tree` 목록) 지난 목록과 견준다. 마지막 훑기가 2초 안이면 그 결과를 쓴다 — 서버 두 대가 함께 물어도
한 번만 훑는다. 파일 변경 알림(inotify)은 쓰지 않는다: 표준 라이브러리에 없고 데이터 폴더가 NFS 라 알림이 빠질 수 있다.

커서는 「<이 프로세스의 무작위 이름>:<세대>」다. 사이드카가 다시 시작됐거나 기록이 넘쳐 커서 뒤를 다 알 수 없으면 `reset` 을
알린다 — 서버는 목록 전체를 다시 받는다.
"""
from __future__ import annotations

import secrets
import threading
import time

REUSE = 2.0                      # 이 안에 다시 물으면 다시 훑지 않는다(초)
LOG_MAX = 20_000                 # 기억하는 변경 줄 수. 넘치면 오래된 커서는 reset


class ChangeIndex:
    def __init__(self, scan, clock=time.monotonic):
        self._scan = scan                                   # (params) → {"entries": [...], "partial": [...]} — Ops.tree 목록
        self._clock = clock
        self._epoch = secrets.token_hex(4)
        self._lock = threading.Lock()
        self._state: dict[tuple, dict] = {}                 # 훑기 인자 → {gen, prev(경로 → 항목), log[(gen, 경로)], at, partial}

    def record(self, key: tuple, listing: dict) -> str:
        """목록 하나를 색인에 넣고 그 커서를 돌려준다(tree 가 부른다)."""
        with self._lock:
            return self._record(key, listing)

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

    def changes(self, key: tuple, since: str, params: dict, fresh: bool = False) -> dict:
        """since 커서 뒤에 생기거나 바뀐 항목(지금 값)과 없어진 경로. 알 수 없으면 reset.
        fresh: 2초 재사용 없이 다시 훑는다 — AAS 가 방금 고친 직후(서버의 invalidate)에 옛 훑기를 돌려주지 않게."""
        with self._lock:
            st = self._state.get(key)
            if fresh or st is None or st["prev"] is None or self._clock() - st["at"] >= REUSE:
                listing = self._scan(params)
                if listing.get("truncated"):
                    # 항목 상한에서 잘린 목록을 견주면 잘린 나머지가 「없어짐」으로 적혀 서버가 있는 파일을 없다고 답한다.
                    # 색인을 버리고 reset 으로 알린다 — 서버는 잘린 묶음으로 처리한다(스펙 2026-11-03-003 R7·D12)
                    self._state.pop(key, None)
                    return {"cursor": "", "reset": True, "truncated": True}
                cursor = self._record(key, listing)
                st = self._state[key]
            else:
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


def _sig(e: dict) -> tuple:
    return (e.get("type"), e.get("size"), e.get("mtime"), e.get("sha256"))

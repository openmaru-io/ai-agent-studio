# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""사이드카 묶음(tree)의 내용 보관과 정리(스펙 2026-10-24-013 R5·R6·R8).

- 내용은 파일마다 zlib 수준 1 로 압축해 `Blob` 에 둔다. 압축해도 4/5 이상이면(작은 파일 등) 원문 그대로 둔다.
- 같은 내용은 서버 전체에서 한 벌만 둔다(sha256 → `Blob`, 약한 참조). 묶음들이 `Blob` 을 쥐고 있는 동안만 남고, 아무도
  쥐지 않으면 파이썬 참조 수로 사라진다 — 따로 세거나 지우는 단계가 없어 쓰는 중인 내용이 지워지지 않는다(외부 검토 OV5).
  자격증명 파일은 여기에 넣지 않는다(`private`, 리뷰 A1).
- 「사용」은 사람의 요청(HTTP·웹소켓)에서만 적는다(`HUMAN`, 외부 검토 OV4). 배경 작업이 묶음을 살려 두지 않는다.
  `sweep` 이 10분 넘게 쓰지 않은 묶음과 상한(`AAS_TREE_CACHE_MB`, 기본 512)을 넘는 만큼을 오래된 것부터 버린다.
"""
from __future__ import annotations

import contextvars
import hashlib
import os
import threading
import time
import weakref
import zlib

IDLE_DROP = 600.0               # 사람이 이만큼 쓰지 않은 에이전트의 묶음·결과 캐시는 버린다(D2)
ENTRY_BYTES = 200               # 묶음 항목 하나가 차지한다고 보는 크기(목록·폴더 표). 내용은 Blob 크기를 센다

HUMAN: contextvars.ContextVar[bool] = contextvars.ContextVar("aas_tree_human", default=False)
_used: dict[str, float] = {}                                    # 에이전트(백엔드 label) → 사람이 마지막으로 쓴 시각
_store: "weakref.WeakValueDictionary[str, Blob]" = weakref.WeakValueDictionary()
_lock = threading.Lock()


def cap_bytes() -> int:
    try:
        return int(float(os.environ.get("AAS_TREE_CACHE_MB") or 512) * 1024 * 1024)
    except ValueError:
        return 512 * 1024 * 1024


class Blob:
    """파일 내용 하나. 압축이 이득이면 압축해 두고 읽을 때 푼다."""

    __slots__ = ("_z", "_raw", "size", "__weakref__")

    def __init__(self, data: bytes):
        self.size = len(data)
        z = zlib.compress(data, 1)
        if len(z) * 5 < len(data) * 4:
            self._z, self._raw = z, None
        else:
            self._z, self._raw = None, data

    def bytes(self) -> bytes:
        return self._raw if self._raw is not None else zlib.decompress(self._z)

    @property
    def held(self) -> int:
        return len(self._raw) if self._raw is not None else len(self._z)


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def intern(data: bytes) -> Blob:
    """같은 내용이면 이미 있는 Blob 을 돌려준다(서버 전체 한 벌, D8)."""
    key = digest(data)
    with _lock:
        blob = _store.get(key)
        if blob is None or blob.size != len(data):
            blob = _store[key] = Blob(data)
        return blob


def known(sha: str) -> Blob | None:
    """사이드카가 알려 준 해시의 내용을 이미 들고 있으면 그 Blob(R7)."""
    with _lock:
        return _store.get(sha)


def private(data: bytes) -> Blob:
    """한 벌 저장소에 넣지 않는 내용(자격증명 파일을 토큰으로 바꾼 것)."""
    return Blob(data)


def store_bytes() -> int:
    with _lock:
        blobs = list(_store.values())
    return sum(b.held for b in blobs)


def touch(label: str) -> None:
    """사람의 요청이 이 에이전트의 묶음을 썼다. 배경 작업에서는 아무것도 하지 않는다."""
    if HUMAN.get():
        _used[label] = time.monotonic()


def idle(label: str, now: float | None = None) -> bool:
    now = time.monotonic() if now is None else now
    return now - _used.get(label, float("-inf")) >= IDLE_DROP


def sweep(backends: list, now: float | None = None) -> list[str]:
    """오래 쓰지 않은 묶음을 버리고, 상한을 넘으면 오래 쓰지 않은 것부터 더 버린다. 버린 백엔드의 label 을 돌려준다.
    버릴 때 그 백엔드의 사이드카 연결도 닫는다(외부 검토 OV10)."""
    now = time.monotonic() if now is None else now
    dropped = []
    for b in backends:
        if b.has_tree() and idle(b.label, now):
            b.drop()
            dropped.append(b.label)
    live = sorted((b for b in backends if b.has_tree()), key=lambda b: _used.get(b.label, float("-inf")))
    cap = cap_bytes()
    for b in live:
        if store_bytes() + sum(x.entry_count() for x in live if x.has_tree()) * ENTRY_BYTES <= cap:
            break
        b.drop()
        dropped.append(b.label)
    return dropped

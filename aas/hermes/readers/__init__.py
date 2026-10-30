# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""Hermes 데이터를 읽는 백엔드. 로컬(폴더를 직접)과 원격(읽기 사이드카)이 같은 모양의 Path 를 낸다."""
from __future__ import annotations

import threading

from ...common import config
from .remote import RemoteBackend, RemotePath

_lock = threading.Lock()
_backends: dict[tuple[str, str, str], RemoteBackend] = {}


def remote_home(url: str, token_env: str = "AAS_SIDECAR_TOKEN", label: str = "", token_fn=None, key_extra: str = "") -> RemotePath:
    """사이드카 한 곳당 백엔드 하나를 나눠 쓴다(stat 캐시를 함께 쓴다). 토큰은 부를 때마다 읽는다(Secret 교체 대비).
    token_fn 을 주면 환경변수 대신 그 함수로 읽는다(쿠버네티스 Secret)."""
    url = url.rstrip("/")
    key = (url, token_env, key_extra)
    with _lock:
        if key not in _backends:
            _backends[key] = RemoteBackend(url, token_fn or (lambda: config.get(token_env)), label=label or url.split("//", 1)[-1])
        return RemotePath(_backends[key], "")


def read_texts(paths: list) -> list[str]:
    """여러 파일의 글. 사이드카 경로(같은 백엔드)면 read 요청 하나로 묶고, 로컬이면 하나씩 읽는다. 없거나 못 읽은 파일은 빈 문자열.
    사이드카에 닿지 못하면 SidecarError 를 올린다(스펙 2026-10-24-002 R5)."""
    from . import remote
    if paths and all(isinstance(p, RemotePath) for p in paths) and len({id(p._b) for p in paths}) == 1:
        return remote.read_texts(paths, strict=True)
    out = []
    for p in paths:
        try:
            out.append(p.read_text(encoding="utf-8", errors="replace"))
        except OSError:
            out.append("")
    return out

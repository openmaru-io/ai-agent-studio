# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""에이전트마다 담당 서버(스펙 2026-10-24-013 3단계 R11·D5).

살아 있는 서버(`office_servers`, 30초 안 신호) 가운데 `sha256(에이전트 id, 서버 origin)` 이 가장 큰 서버가 그 에이전트를 맡는다
(rendezvous hashing). 서버가 늘거나 줄면 그 서버로 가거나 그 서버에서 오는 몫만 옮겨 간다.
에이전트별 배경 작업(오피스 재료 읽기·30분 상태 수집·5분 프로파일 맞추기)은 담당 서버가 자기 몫만 한다. 서버마다 목록을 읽는
때가 달라 잠깐 겹치거나 비는 몫은 읽는 쪽 대비(오래된 줄은 직접 읽기)가 메운다.
"""
from __future__ import annotations

import hashlib


def _weight(pod_id: str, origin: str) -> bytes:
    return hashlib.sha256(f"{pod_id}\0{origin}".encode("utf-8", "surrogateescape")).digest()


def owner_of(pod_id: str, origins) -> str:
    return max(origins, key=lambda o: _weight(pod_id, o))


def mine(pods: list, me: str, origins) -> list:
    """pods 가운데 me 가 맡는 것(순서 그대로). origins 에 me 가 없어도 me 는 살아 있는 서버로 친다."""
    alive = set(origins) | {me}
    return [p for p in pods if owner_of(p.id, alive) == me]

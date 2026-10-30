# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""MCP 서버 주소를 이 설치에서 쓸 수 있는지 설정과 주소만으로 판정한다(스펙 2026-10-16-010 4-7·11-2 V2, OMAI-1263).

AAS 서버는 사용자가 넣은 주소로 요청하지 않는다. DNS 조회도 하지 않는다. AAS 서버가 그 주소로 나가면 클러스터 안의
다른 사용자 Hermes·DB·쿠버네티스 API 로 요청이 갈 수 있기 때문이다(SSRF, 10-2 R8).
실제로 닿는지는 추가한 뒤 사용자 파드에서 연결 시험·로그인 시작으로 확인한다.

- AAS_NETWORK_MODE: online(기본, 9절 Q6) · restricted(허용 목록만) · airgap(클러스터·사내망 밖으로 나가지 못함)
- AAS_EGRESS_ALLOW: 쉼표로 나눈 호스트 패턴(fnmatch, 예: *.corp.example.com, github.com)
- 사내 주소: 허용 목록, 사설·루프백 IP, 클러스터 이름(*.svc·*.svc.cluster.local·점 없는 이름). 도메인 이름으로 짐작하지 않는다(Q8)
- 링크 로컬(169.254.0.0/16·fe80::/10)은 클라우드 메타데이터 주소라 어느 모드에서도 쓸 수 없다
"""
from __future__ import annotations

import ipaddress
from fnmatch import fnmatchcase
from urllib.parse import urlsplit

from ..common import config
from ..common.i18n import tr

MODES = ("online", "restricted", "airgap")
DEFAULT_MODE = "online"


def mode() -> str:
    raw = config.get("AAS_NETWORK_MODE", DEFAULT_MODE).strip().lower()
    return raw if raw in MODES else DEFAULT_MODE


def allow_patterns() -> list[str]:
    return [p.strip().lower() for p in config.get("AAS_EGRESS_ALLOW", "").split(",") if p.strip()]


def _is_cluster_name(host: str) -> bool:
    return "." not in host or host.endswith(".svc") or host.endswith(".svc.cluster.local")


def _result(verdict: str, reason: str, message: str) -> dict:
    return {"verdict": verdict, "reason": reason, "message": message, "mode": mode()}


def check(url: str) -> dict:
    """주소 하나의 판정. verdict 는 internal(사내)·external(외부)·blocked(쓸 수 없음)·invalid(주소가 아님).
    message 는 추가 대화 상자의 주소 칸 아래에 그대로 보이는 글이다(11-2 V2)."""
    try:
        parts = urlsplit(str(url or "").strip())
        host = (parts.hostname or "").lower()
    except ValueError:
        host, parts = "", None
    if parts is None or parts.scheme not in ("http", "https") or not host:
        return _result("invalid", "invalid_url", tr("http:// 또는 https:// 주소를 넣으세요", "Enter an http:// or https:// address"))
    try:
        ip = ipaddress.ip_address(host)
    except ValueError:
        ip = None
    if ip is not None and ip.is_link_local:
        return _result("blocked", "link_local", tr("이 환경에서 쓸 수 없음: 링크 로컬 주소(클라우드 메타데이터)는 쓸 수 없습니다",
                                                   "Not available here: link-local (cloud metadata) addresses are not allowed"))
    allowed = any(fnmatchcase(host, p) for p in allow_patterns())
    internal = allowed or (ip.is_private or ip.is_loopback if ip is not None else _is_cluster_name(host))
    if internal:
        return _result("internal", "internal", tr("사내 주소 · 추가 뒤 확인", "Internal address · check after adding"))
    current = mode()
    if current == "airgap":
        return _result("blocked", "airgap", tr("이 환경에서 쓸 수 없음: 외부 인터넷 연결이 필요합니다. 이 설치는 에어갭입니다",
                                               "Not available here: this needs internet access and this installation is air-gapped"))
    if current == "restricted":
        return _result("blocked", "not_allowed", tr("이 환경에서 쓸 수 없음: 외부 접속 허용 목록(AAS_EGRESS_ALLOW)에 없는 주소입니다",
                                                    "Not available here: the address is not in the egress allow list (AAS_EGRESS_ALLOW)"))
    return _result("external", "external", tr("외부 주소 · 추가 뒤 확인", "External address · check after adding"))

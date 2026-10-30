# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""OIDC 공급자(Keycloak)로 가는 서버의 https 요청에서 인증서 검증을 끄는 선택 옵션(OMAI-1289).

기본은 검증한다. `AAS_OIDC_INSECURE_SKIP_TLS_VERIFY` 가 1·true·yes·on 일 때만 끈다(그 밖의 값은 검증한다).
사내 CA 를 서버가 믿게 하는 것(`SSL_CERT_FILE` 에 사내 CA 를 이어 붙인 묶음)이 맞는 방법이고, 이 옵션은 그것이 어려운 시험·개발 환경용이다.

끄는 범위는 이 모듈로 부르는 OIDC 공급자 호출(로그인 발견·토큰 교환·갱신·로그아웃, Keycloak 관리 API)뿐이다.
MCP·마켓·LiteLLM 같은 다른 외부 호출에는 영향이 없다. 켜져 있으면 서버 로그에 한 번 경고한다.
스펙: cogentai-aas-docs docs-plan/security/oidc-tls-verify-option.md
"""
from __future__ import annotations

import ssl
import urllib.request

from ..common import config

ENV = "AAS_OIDC_INSECURE_SKIP_TLS_VERIFY"
_TRUE = {"1", "true", "yes", "on"}
_warned = False


def skip_verify() -> bool:
    return config.get(ENV).strip().lower() in _TRUE


def context() -> ssl.SSLContext | None:
    """검증을 끄는 문맥. 끄지 않았으면 None(urllib 의 기본 검증을 그대로 쓴다)."""
    if not skip_verify():
        return None
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    return ctx


def urlopen(req, timeout: float):
    """`urllib.request.urlopen` 과 같게 쓴다. 옵션을 켠 때만 인증서를 검증하지 않는다."""
    global _warned
    ctx = context()
    if ctx is not None and not _warned:
        _warned = True
        print(f"경고: {ENV} 가 켜져 있어 OIDC 공급자 https 인증서를 검증하지 않습니다. 시험·개발 환경에서만 쓰세요.", flush=True)   # i18n-ignore: 로그
    return urllib.request.urlopen(req, timeout=timeout, context=ctx)

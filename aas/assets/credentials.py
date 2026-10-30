# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""Hermes 의 대시보드 계정·사이드카 토큰을 어디서 얻는가.

쿠버네티스 모드: 오퍼레이터가 만든 Secret(`credentialsSecret`)을 읽어 메모리에 잠깐 둔다(계획 R16). 값은 로그·DB 에 남기지 않는다.
그 밖: 등록부가 적은 환경변수 이름(`dashboard_*_env`, `sidecar_token_env`)에서 읽는다(compose·파일 등록부).
"""
from __future__ import annotations

import threading
import time

from ..common import config
from ..fleet import k8s
from ..common.i18n import tr

TTL = 30.0                                    # Secret 을 다시 읽는 간격. 값이 바뀌어도 이 안에 따라간다
_lock = threading.Lock()
_cache: dict[str, tuple[float, dict[str, str]]] = {}
_refreshing: set[str] = set()                 # 뒤에서 다시 읽는 중인 Secret 이름


def secret_values(name: str, fresh: bool = False) -> dict[str, str]:
    """TTL 이 지난 값은 바로 돌려주고 뒤에서 다시 읽는다. 쿠버네티스 API 가 멈춰도(OKE etcd 장애) 화면이 지난 값으로 계속 읽는다(OMAI-1116).
    요청이 API 를 기다리는 것은 처음 읽을 때와 fresh·forget 뒤뿐이다."""
    client = k8s.client()
    if client is None:
        raise k8s.K8sError(tr("쿠버네티스 모드가 아닙니다(AAS_K8S_NAMESPACE)", "Not running in Kubernetes mode (AAS_K8S_NAMESPACE)"))
    with _lock:
        hit = _cache.get(name)
        if hit and not fresh:
            if time.monotonic() - hit[0] >= TTL and name not in _refreshing:
                _refreshing.add(name)
                threading.Thread(target=_refresh_behind, args=(client, name), daemon=True, name="secret-refresh").start()
            return hit[1]
    values = client.secret(name)
    with _lock:
        _cache[name] = (time.monotonic(), values)
    return values


def _refresh_behind(client: k8s.K8s, name: str) -> None:
    try:
        values = client.secret(name)
        with _lock:
            _cache[name] = (time.monotonic(), values)
    except k8s.K8sError as exc:
        if exc.code == 404:                       # Secret 이 지워졌다(에이전트를 지웠다) — 지난 값을 더 쓰지 않는다
            with _lock:
                _cache.pop(name, None)
        print(f"Secret 다시 읽기 실패 {name}: HTTP {exc.code}", flush=True)   # i18n-ignore: 로그. 값은 싣지 않는다
    finally:
        with _lock:
            _refreshing.discard(name)


def forget(name: str = "") -> None:
    """읽어 둔 값을 버린다(인증이 거절됐을 때 다시 읽게 한다)."""
    with _lock:
        _cache.pop(name, None) if name else _cache.clear()


def sidecar_token(secret: str) -> str:
    return secret_values(secret).get("sidecar-token", "")


def dashboard(pod) -> tuple[str, str]:
    """(대시보드 사용자, 비밀번호). Secret 이 있으면 거기서, 없으면 환경변수에서."""
    if getattr(pod, "credentials_secret", ""):
        values = secret_values(pod.credentials_secret)
        return values.get("dashboard-user", ""), values.get("dashboard-password", "")
    return config.get(pod.dashboard_user_env), config.get(pod.dashboard_password_env)

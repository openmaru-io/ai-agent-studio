# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""이름 조회 결과를 기억해 다시 쓰는 urlopen.

호출마다 DNS 를 새로 물으면 UDP 패킷 하나만 사라져도 glibc 가 5초를 기다린다(OKE 실측 약 3천 번에 한 번, OMAI-1108).
LiteLLM 처럼 몇십 초~몇 분 간격으로 부르는 곳은 연결을 다시 쓸 수도 없다(서버가 쉬는 연결을 몇 초 뒤 닫는다).
그래서 조회 결과를 TTL 동안 기억하고, 지난 값은 바로 쓰면서 뒤에서 다시 조회한다. 연결이 모두 실패하면 버리고 새로 조회한다.

거의 바뀌지 않는 Service 주소(ClusterIP)에 쓴다. 프로세스 전체 오프너(`install_opener`)는 바꾸지 않는다.
"""
from __future__ import annotations

import http.client
import ipaddress
import socket
import threading
import time
import urllib.request

TTL = 60.0


class _Entry:
    def __init__(self, addrs: list, taken: float):
        self.addrs = addrs
        self.taken = taken


_cache: dict[tuple[str, int], _Entry] = {}
_refreshing: set[tuple[str, int]] = set()
_lock = threading.Lock()


def clear() -> None:
    with _lock:
        _cache.clear()


def _is_ip(host: str) -> bool:
    try:
        ipaddress.ip_address(host)
        return True
    except ValueError:
        return False


def _lookup(host: str, port: int) -> list:
    return socket.getaddrinfo(host, port, 0, socket.SOCK_STREAM)


def _refresh(key: tuple[str, int]) -> None:
    try:
        addrs = _lookup(*key)
        with _lock:
            _cache[key] = _Entry(addrs, time.monotonic())
    except OSError:
        pass                                                    # 지난 값을 계속 쓴다. 연결이 실패하면 그때 버린다
    finally:
        with _lock:
            _refreshing.discard(key)


def _resolve(host: str, port: int) -> tuple[list, bool]:
    """(주소 목록, 기억해 둔 값인가). 지난 값은 바로 돌려주고 뒤에서 다시 조회한다."""
    key = (host, port)
    with _lock:
        entry = _cache.get(key)
        if entry is not None and time.monotonic() - entry.taken >= TTL and key not in _refreshing:
            _refreshing.add(key)
            threading.Thread(target=_refresh, args=(key,), daemon=True, name="netcache-refresh").start()
    if entry is not None:
        return entry.addrs, True
    addrs = _lookup(host, port)
    with _lock:
        _cache[key] = _Entry(addrs, time.monotonic())
    return addrs, False


def _connect_any(addrs: list, timeout, source_address) -> socket.socket:
    err: OSError | None = None
    for family, kind, proto, _canon, sockaddr in addrs:
        sock = socket.socket(family, kind, proto)
        try:
            if timeout is not socket._GLOBAL_DEFAULT_TIMEOUT:
                sock.settimeout(timeout)
            if source_address:
                sock.bind(source_address)
            sock.connect(sockaddr)
            return sock
        except OSError as exc:
            err = exc
            sock.close()
    raise err or OSError("getaddrinfo returns an empty list")


def create_connection(address, timeout=socket._GLOBAL_DEFAULT_TIMEOUT, source_address=None) -> socket.socket:
    """socket.create_connection 과 같되 이름 조회 결과를 기억해 쓴다."""
    host, port = address
    if _is_ip(host):
        return socket.create_connection(address, timeout, source_address)
    addrs, cached = _resolve(host, port)
    try:
        return _connect_any(addrs, timeout, source_address)
    except OSError:
        if not cached:
            raise
        with _lock:
            _cache.pop((host, port), None)                     # 주소가 바뀌었을 수 있다 — 새로 조회해 한 번 더
        addrs, _ = _resolve(host, port)
        return _connect_any(addrs, timeout, source_address)


class _HTTPConnection(http.client.HTTPConnection):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self._create_connection = create_connection


class _HTTPSConnection(http.client.HTTPSConnection):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self._create_connection = create_connection          # TLS 호스트 확인은 원래 이름(self.host)으로 한다


class _HTTPHandler(urllib.request.HTTPHandler):
    def http_open(self, req):
        return self.do_open(_HTTPConnection, req)


class _HTTPSHandler(urllib.request.HTTPSHandler):
    def https_open(self, req):
        return self.do_open(_HTTPSConnection, req, context=self._context)


_opener = urllib.request.build_opener(_HTTPHandler, _HTTPSHandler)


def urlopen(req, timeout: float):
    """urllib.request.urlopen 과 같게 쓴다(HTTPError·URLError 도 같다)."""
    return _opener.open(req, timeout=timeout)

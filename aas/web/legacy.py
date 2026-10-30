# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""옛 http.server Handler 를 ASGI 앱으로 감싼다(OMAI-1100, 경로를 Starlette 로 옮기는 동안만 쓴다).

요청을 바이트로 만들어 Handler 를 메모리 스트림 위에서 한 번 실행하고, 쓴 응답을 그대로 돌려준다.
Host·로그인·CSRF·언어 판정이 모두 Handler 안에 있으므로 이 어댑터는 규칙을 새로 만들지 않는다.
SSE 두 경로는 Handler 가 검사까지만 하고 동기 생성기를 넘기면, 여기서 전용 실행기로 흘려보낸다.
"""
from __future__ import annotations

import asyncio
import contextvars
import io
import os
from concurrent.futures import ThreadPoolExecutor

import anyio

from ..common import store
from . import server

MAX_REQUEST_BODY = 1024 * 1024        # Handler 의 상한(256KB)보다 넉넉하게. 넘으면 읽지 않고 413
# 같은 프로세스 안 요청이 바깥 요청에서 옮겨 오는 헤더(F14). Cookie·Authorization 은 옮기지 않는다 — 사용자는 principal 로만 정한다
FORWARD_HEADERS = (b"host", b"x-forwarded-for", b"x-forwarded-proto", b"x-forwarded-host", b"x-forwarded-port", b"accept-language")
_DROP = {b"server", b"date", b"connection", b"content-length", b"transfer-encoding"}
_stream_pool: ThreadPoolExecutor | None = None


def request_limit(path: str) -> int:
    """ASGI 층의 본문 상한. 처리기 상한(server.body_limit)보다 작으면 그 경로가 413 을 먼저 낸다(받아쓰기 10MB, 스펙 2026-10-22-005 §9 F1)."""
    return max(MAX_REQUEST_BODY, server.body_limit(path))


def stream_pool() -> ThreadPoolExecutor:
    """SSE 가 기다리는 동안 쓰는 전용 스레드(AAS_STREAM_THREADS, 기본 256). 일반 스레드 풀과 나눠 화면 요청이 막히지 않게 한다."""
    global _stream_pool
    if _stream_pool is None:
        try:
            n = max(8, int(os.environ.get("AAS_STREAM_THREADS", "256")))
        except ValueError:
            n = 256
        _stream_pool = ThreadPoolExecutor(max_workers=n, thread_name_prefix="aas-stream")
    return _stream_pool


class _Null:
    """Handler 가 쓰는 server 속성 자리."""
    server_name, server_port = "aas", 0


class AdaptedHandler(server.Handler):
    """소켓 대신 메모리 스트림에서 요청 하나를 처리한다. TLS 여부와 상대 주소는 ASGI scope 에서 받는다."""

    def __init__(self, raw: bytes, client: tuple[str, int], https: bool, principal: dict | None = None):
        self.rfile = io.BytesIO(raw)
        self.wfile = io.BytesIO()
        self.client_address = client
        self.server = _Null()
        self.request = self.connection = None
        self._https = https
        self.stream = None                 # SSE 경로면 (동기 생성기, 컨텍스트)
        self.close_connection = True
        self.principal = principal         # dispatch 만 넣는다(스펙 2026-10-28-001 D2). 바깥 요청(app)은 늘 None

    def run(self) -> None:
        if self.principal is None:
            self.handle_one_request()
            return
        mark = store.actor_via.set("token")                # 이 요청이 남기는 기록에 via=token(F8)
        try:
            self.handle_one_request()
        finally:
            store.actor_via.reset(mark)

    def _tls(self) -> bool:
        return self._https

    def start_stream(self, gen) -> None:
        """SSE 응답을 이 어댑터가 넘겨받는다. 생성기는 요청 언어 등 컨텍스트를 그대로 쓴다."""
        self.stream = (gen, contextvars.copy_context())


def _parse(out: bytes) -> tuple[int, list[tuple[bytes, bytes]], bytes]:
    head, _, body = out.partition(b"\r\n\r\n")
    lines = head.split(b"\r\n")
    status = int(lines[0].split(b" ", 2)[1])
    headers = []
    for line in lines[1:]:
        k, _, v = line.partition(b":")
        if k.strip().lower() not in _DROP:
            headers.append((k.strip().lower(), v.strip()))
    return status, headers, body


async def _read_body(receive, limit: int = MAX_REQUEST_BODY) -> bytes | None:
    chunks, size = [], 0
    while True:
        msg = await receive()
        if msg["type"] == "http.disconnect":
            return b"".join(chunks)
        chunk = msg.get("body", b"")
        size += len(chunk)
        if size > limit:
            return None
        chunks.append(chunk)
        if not msg.get("more_body"):
            return b"".join(chunks)


async def _send_plain(send, status: int, headers: list[tuple[bytes, bytes]], body: bytes) -> None:
    await send({"type": "http.response.start", "status": status,
                "headers": headers + [(b"content-length", str(len(body)).encode())]})
    await send({"type": "http.response.body", "body": body})


async def _stream(send, receive, headers: list[tuple[bytes, bytes]], gen, ctx: contextvars.Context) -> None:
    """동기 생성기를 전용 실행기에서 한 조각씩 꺼내 보낸다. 브라우저가 끊으면 기다리던 조각이 끝난 뒤 생성기를 닫는다."""
    loop = asyncio.get_running_loop()
    pool = stream_pool()
    done = object()

    def pull():
        return ctx.run(next, gen, done)

    async def watch():
        while (await receive())["type"] != "http.disconnect":
            pass

    await send({"type": "http.response.start", "status": 200, "headers": headers})
    watcher = asyncio.ensure_future(watch())
    pending = None
    try:
        while True:
            pending = loop.run_in_executor(pool, pull)
            finished, _ = await asyncio.wait({pending, watcher}, return_when=asyncio.FIRST_COMPLETED)
            if watcher in finished:
                break
            chunk = pending.result()
            pending = None
            if chunk is done:
                break
            await send({"type": "http.response.body", "body": chunk, "more_body": True})
        if not watcher.done():
            await send({"type": "http.response.body", "body": b"", "more_body": False})
    except OSError:
        pass                                      # 쓰기 실패(상대가 닫음)
    finally:
        watcher.cancel()
        if pending is not None and not pending.done():
            pending.add_done_callback(lambda _f: pool.submit(gen.close))
        else:
            pool.submit(gen.close)


async def app(scope, receive, send) -> None:
    """옛 Handler 로 처리하는 ASGI 앱(Starlette 라우터의 마지막 자리)."""
    if scope["type"] != "http":
        return
    try:
        declared = int(dict(scope["headers"]).get(b"content-length", b"0") or 0)
    except ValueError:
        declared = 0
    limit = request_limit(scope["path"])
    body = None if declared > limit else await _read_body(receive, limit)
    if body is None:
        await _send_plain(send, 413, [(b"content-type", b"application/json; charset=utf-8")], b'{"error": "too large"}')
        return
    target = scope.get("raw_path") or scope["path"].encode()
    if scope.get("query_string"):
        target += b"?" + scope["query_string"]
    lines = [scope["method"].encode() + b" " + target + b" HTTP/1.1"]
    lines += [k + b": " + v for k, v in scope["headers"] if k not in (b"content-length", b"transfer-encoding")]
    lines.append(b"Content-Length: " + str(len(body)).encode())
    raw = b"\r\n".join(lines) + b"\r\n\r\n" + body
    client = tuple(scope.get("client") or ("", 0))
    # MCP 도구가 같은 프로세스 안에서 넣은 요청이면 scope 에 내부 값이 있다(D2). 바깥 요청은 헤더로 이 키를 만들 수 없다
    handler = AdaptedHandler(raw, client, scope.get("scheme") == "https", scope.get(server.PRINCIPAL_KEY))
    await anyio.to_thread.run_sync(handler.run)
    if handler.stream is not None and not handler.wfile.getvalue():
        gen, ctx = handler.stream
        await _stream(send, receive, list(SSE_HEADERS), gen, ctx)
        return
    out = handler.wfile.getvalue()
    if not out:
        await _send_plain(send, 500, [], b"")
        return
    status, headers, rest = _parse(out)
    await _send_plain(send, status, headers, b"" if status in (204, 304) else rest)


def dispatch(method: str, target: str, principal: dict, outer_headers, client: tuple[str, int], https: bool,
             body: bytes = b"", content_type: str = "application/json") -> tuple[int, list[tuple[bytes, bytes]], bytes]:
    """MCP 도구가 지금 화면 경로를 같은 프로세스 안에서 부른다(스펙 2026-10-28-001 D2). 이 스레드에서 바로 돈다.
    principal = {"user": 토큰 사용자(via=token), "pod": "<id>"}. 바깥 요청의 헤더는 FORWARD_HEADERS 만 옮기고,
    상대 주소·https 여부는 바깥 요청 그대로 넘겨 Host·https 판정이 화면과 같게 한다. SSE 경로는 다루지 않는다(500)."""
    if not principal or not isinstance(principal.get("user"), dict):
        raise ValueError("principal required")
    lines = [method.encode() + b" " + target.encode() + b" HTTP/1.1"]
    for k, v in outer_headers:
        k = k.lower() if isinstance(k, bytes) else str(k).lower().encode()
        if k in FORWARD_HEADERS:
            lines.append(k + b": " + (v if isinstance(v, bytes) else str(v).encode()))
    lines += [b"Content-Type: " + content_type.encode(), b"Content-Length: " + str(len(body)).encode()]
    handler = AdaptedHandler(b"\r\n".join(lines) + b"\r\n\r\n" + body, client, https, principal)
    handler.run()
    out = handler.wfile.getvalue()
    if handler.stream is not None and not out:
        handler.stream[0].close()
        return 500, [], b'{"error": "stream not supported"}'
    if not out:
        return 500, [], b""
    return _parse(out)


SSE_HEADERS = ((b"content-type", b"text/event-stream; charset=utf-8"), (b"cache-control", b"no-store"),
               (b"x-content-type-options", b"nosniff"), (b"x-accel-buffering", b"no"))

# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""AAS 제어면 ASGI 앱과 실행기(uvicorn + Starlette, OMAI-1100).

HTTP 와 웹소켓을 같은 포트에서 받는다. 아직 옮기지 않은 경로는 옛 Handler 어댑터(legacy.py)가 처리한다.
비즈니스 코드는 동기 그대로 두고 스레드 풀(AAS_THREADPOOL)에서 돈다.
"""
from __future__ import annotations

import asyncio
import contextlib
import json
import os
import signal
import threading

import anyio
import uvicorn
from starlette.applications import Starlette
from starlette.responses import Response
from starlette.routing import Mount, Route

from ..common import db, i18n
from ..hermes.readers import tree_cache
from . import legacy, server

_drain_hooks: list = []                 # 종료 신호를 받으면 uvicorn 이 연결을 닫기 전에 부를 비동기 함수들(웹소켓 bye 등)
_draining = threading.Event()


def draining() -> bool:
    return _draining.is_set()


def on_drain(fn) -> None:
    if fn not in _drain_hooks:
        _drain_hooks.append(fn)


def _int_env(name: str, default: int) -> int:
    try:
        return max(1, int(os.environ.get(name, str(default))))
    except ValueError:
        return default


def json_response(obj, status: int = 200) -> Response:
    """옛 Handler._json 과 같은 본문·보안 헤더."""
    return Response(json.dumps(obj, ensure_ascii=False).encode(), status_code=status, media_type="application/json; charset=utf-8",
                    headers={"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "X-Frame-Options": "DENY",
                             "Content-Language": i18n.get_lang(), "Vary": "Accept-Language, Cookie"})


async def healthz(_request):
    """프로세스가 살아 있는지만 본다. 허용 Host·로그인보다 앞(프로브는 파드 IP 로 부른다). 스레드 풀이 가득 차도 답한다."""
    return json_response({"ok": True})


async def readyz(_request):
    """요청을 받을 준비가 됐는지. DB 가 멈추면 트래픽만 끊고(503) 재시작하지 않는다. DB 확인은 2초 제한."""
    try:
        with anyio.fail_after(2.5):
            ok = await anyio.to_thread.run_sync(db.ping, 2.0, abandon_on_cancel=True)
    except TimeoutError:
        ok = False
    return json_response({"ok": bool(ok)}, 200 if ok else 503)


class LangMiddleware:
    """순수 ASGI 미들웨어 — http·websocket 두 scope 모두에서 요청 언어를 정한다(BaseHTTPMiddleware 는 웹소켓을 건너뛴다)."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] in ("http", "websocket"):
            raw = next((v for k, v in scope["headers"] if k == b"accept-language"), None)
            cookie = next((v for k, v in scope["headers"] if k == b"cookie"), None)
            i18n.set_lang(i18n.request_lang(raw.decode("latin-1") if raw else None, cookie.decode("latin-1") if cookie else None))
            tree_cache.HUMAN.set(True)                 # 사람의 요청 — 묶음·결과 캐시 「사용」으로 친다(스펙 2026-10-24-013 OV4)
        await self.app(scope, receive, send)


def create_app(background: bool = True) -> Starlette:
    """background 가 거짓이면 반복 스레드(오피스·수명주기·마켓·칸반)를 띄우지 않는다(시험 하네스용)."""

    @contextlib.asynccontextmanager
    async def lifespan(_app):
        anyio.to_thread.current_default_thread_limiter().total_tokens = _int_env("AAS_THREADPOOL", 64)
        if background:
            server.start_background()
        yield

    routes = [Route("/healthz", healthz), Route("/readyz", readyz)]
    try:
        from . import ws
        routes += ws.routes()
    except ImportError:
        pass
    from . import files                 # 대화 파일(OMAI-1153) — 본문이 커서 옛 Handler 어댑터를 거치지 않는다
    routes += files.routes()
    from . import meeting_files         # 회의 파일 공유 — 방 구성원 인증, 레거시 Mount 앞(/api/office/meeting/ 접두를 레거시 Handler 도 받는다)
    routes += meeting_files.routes()
    from . import kanban_files          # 칸반 카드 첨부 내려받기 — 흘려보내야 해서 레거시 Mount 앞(/api/office/kanban/ 접두를 레거시 Handler 도 받는다)
    routes += kanban_files.routes()
    from . import pc_import_routes      # 내 PC 의 Hermes 가져오기·main 내보내기(OMAI-1136) — 묶음이 커서 옛 Handler 를 거치지 않는다
    routes += pc_import_routes.routes()
    from . import credential_files      # 프로파일 인증 파일(JSON) 목록·넣기·지우기(스펙 2026-10-22-004)
    routes += credential_files.routes()
    from . import static_assets         # 화면 빌드 산출물 — wasm 처럼 큰 파일을 나눠 보내려고 옛 Handler 를 거치지 않는다(스펙 2026-10-20-005 D11)
    routes += static_assets.routes()
    from . import mcp_server            # Claude Code 연결 /mcp(스펙 2026-10-28-001). 레거시 Mount 앞
    routes += mcp_server.routes()
    from . import mcp_oauth             # 그 OAuth(메타데이터·등록·동의 화면·토큰)
    routes += mcp_oauth.routes()
    routes.append(Mount("/", app=legacy.app))
    app = Starlette(routes=routes, lifespan=lifespan)
    app.add_middleware(LangMiddleware)
    return app


def _config(app, host: str, port: int, **extra) -> uvicorn.Config:
    return uvicorn.Config(app, host=host, port=port, ws="websockets-sansio", ws_ping_interval=20, ws_ping_timeout=20,
                          ws_max_size=64 * 1024, proxy_headers=False, server_header=False, access_log=False,
                          log_level=os.environ.get("AAS_UVICORN_LOG", "warning"), timeout_graceful_shutdown=10,
                          timeout_keep_alive=65, **extra)


class AASServer(uvicorn.Server):
    """신호는 run() 이 한 번만 받는다. 여기서는 신호를 직접 잡지 않는다(HTTP·TLS 두 서버가 한 신호를 함께 처리)."""

    @contextlib.contextmanager
    def capture_signals(self):
        yield


async def _drain_then_exit(servers: list[AASServer]) -> None:
    """uvicorn 이 받는 소켓을 닫고 연결마다 1012 를 보내기 전에, 웹소켓에 bye 1012 를 먼저 보낸다(OMAI-1100).
    uvicorn 0.54 는 lifespan 종료를 연결을 모두 닫은 뒤에 부르므로 그 자리에서는 bye 를 보낼 수 없다."""
    _draining.set()
    try:
        await asyncio.wait_for(asyncio.gather(*(fn() for fn in _drain_hooks), return_exceptions=True), timeout=5)
    except asyncio.TimeoutError:
        pass
    for s in servers:
        s.should_exit = True


def build_servers(app, host: str, port: int) -> list[AASServer]:
    servers = [AASServer(_config(app, host, port))]
    cert, key = os.environ.get("AAS_TLS_CERT", ""), os.environ.get("AAS_TLS_KEY", "")
    if cert and key:
        if os.path.isfile(cert) and os.path.isfile(key):
            servers.append(AASServer(_config(app, host, int(os.environ.get("AAS_TLS_PORT", "17443")), lifespan="off",
                                             ssl_certfile=cert, ssl_keyfile=key)))
            print(f"AAS https: {host}:{os.environ.get('AAS_TLS_PORT', '17443')}")
        else:
            print(f"https 를 켜지 못했습니다: 인증서 파일이 없습니다 ({cert})")   # i18n-ignore: 로그
    return servers


async def serve_async(app, host: str, port: int) -> None:
    servers = build_servers(app, host, port)
    loop = asyncio.get_running_loop()
    hits = []

    def on_signal(sig):
        hits.append(sig)
        if len(hits) == 1:
            loop.create_task(_drain_then_exit(servers))
        else:                                           # 두 번째 신호는 기다리지 않고 끝낸다
            for s in servers:
                s.should_exit = s.force_exit = True

    for sig in (signal.SIGINT, signal.SIGTERM):
        with contextlib.suppress(NotImplementedError, RuntimeError):
            loop.add_signal_handler(sig, on_signal, sig)
    main = asyncio.ensure_future(servers[0].serve())
    await asyncio.sleep(0)
    while not servers[0].started and not main.done():   # 주 서버가 lifespan 을 마친 뒤 TLS 를 띄운다
        await asyncio.sleep(0.05)
    await asyncio.gather(main, *(s.serve() for s in servers[1:]))


def run(host: str, port: int) -> None:
    asyncio.run(serve_async(create_app(background=True), host, port))

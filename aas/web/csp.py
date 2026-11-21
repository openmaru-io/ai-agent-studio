# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""주 화면 CSP(Content-Security-Policy) 1단계: 막지 않고 위반만 보고받는다(스펙 2026-11-14-018).

- 서버가 내보내는 HTML 응답(옛 Handler·Starlette·index.html 모두)에 `Content-Security-Policy-Report-Only` 를 붙인다.
  이미 정책이 있는 응답(임베드 위젯)은 건드리지 않는다.
- 서버가 만드는 HTML 의 `<script` 에는 응답마다 새 nonce 를 넣는다. 스크립트에는 'unsafe-inline' 을 주지 않으므로,
  끼어든 스크립트와 인라인 이벤트 처리기(onclick= 등)는 보고에 나온다.
- 브라우저가 보내는 위반 보고(`POST /api/csp-report`)는 주소의 질의·조각을 지우고 한 줄로 남긴다. 같은 위반은 한동안 한 번만.
- AAS_CSP_MODE: report(기본) · off(머리를 붙이지 않는다). 막는 단계(enforce)는 보고를 본 뒤 2단계에서 더한다.
"""
from __future__ import annotations

import json
import logging
import os
import secrets
import threading
import time
from urllib.parse import urlsplit

LOG = logging.getLogger("aas.csp")
REPORT_PATH = "/api/csp-report"
HEADER = "Content-Security-Policy-Report-Only"
REPORT_LIMIT = 16 * 1024                 # 보고 하나의 본문 한도. 넘으면 읽지 않는다
HTML_LIMIT = 4 * 1024 * 1024             # nonce 를 넣으려고 모아 둘 HTML 크기 한도. 넘으면 정책 없이 그대로 보낸다
DEDUPE_S = 600                           # 같은 (지시어, 막힌 주소, 화면) 은 10분에 한 번만 남긴다
DEDUPE_MAX = 500

_seen: dict[tuple, float] = {}
_seen_lock = threading.Lock()


def mode() -> str:
    m = os.environ.get("AAS_CSP_MODE", "report").strip().lower()
    return m if m in ("report", "off") else "report"


def policy(nonce: str) -> str:
    """정책 초안. 화면이 쓰는 것: 자기 주소의 스크립트·작업 스레드(blob 포함)·pdf.js wasm, 인라인 style 속성(React),
    data:/blob: 그림·소리(파일 뷰어·SVG data 주소), srcdoc·blob iframe(문서 미리보기), 같은 주소의 웹소켓.
    blob: 스크립트·data:/blob: 연결은 OKE 에서 처음 모은 보고로 더했다(스펙 6절). blob: 주소는 같은 출처의 스크립트만 만들 수 있다."""
    return "; ".join((
        "default-src 'self'",
        f"script-src 'self' 'nonce-{nonce}' 'wasm-unsafe-eval' blob:",   # blob: troika-three-text 작업 스레드의 importScripts(6절)
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: blob:",
        "media-src 'self' data: blob:",
        "font-src 'self' data:",
        "connect-src 'self' data: blob:",                             # 3D 오피스 three.js 가 GLTF·그림을 data:/blob: 로 fetch(6절)
        "worker-src 'self' blob:",
        "frame-src 'self' blob: data:",
        "object-src 'none'",
        "base-uri 'self'",
        "form-action 'self'",
        "frame-ancestors 'none'",
        f"report-uri {REPORT_PATH}",
    ))


def add_nonce(body: bytes, nonce: str) -> bytes:
    """서버가 만든 HTML 의 <script 마다 nonce 를 넣는다. 화면에 들어간 사용자 글은 &lt;script 로 이스케이프돼 있어 바뀌지 않는다."""
    return body.replace(b"<script", f'<script nonce="{nonce}"'.encode())


class CSPMiddleware:
    """순수 ASGI 미들웨어. text/html 응답만 모아 nonce 를 넣고 정책 머리를 붙인다."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http" or mode() == "off":
            return await self.app(scope, receive, send)
        start: dict | None = None
        chunks: list[bytes] = []
        size = 0
        passthrough = False

        async def wrapped(message):
            nonlocal start, size, passthrough
            if message["type"] == "http.response.start":
                headers = {k.decode("latin-1").lower(): v.decode("latin-1") for k, v in message.get("headers", [])}
                html = headers.get("content-type", "").startswith("text/html")
                has_policy = "content-security-policy" in headers or HEADER.lower() in headers
                if not html or has_policy:
                    passthrough = True
                    return await send(message)
                start = message                                  # 본문을 다 받을 때까지 머리를 미룬다
                return
            if message["type"] != "http.response.body" or passthrough:
                return await send(message)
            chunks.append(message.get("body", b""))
            size += len(chunks[-1])
            if size > HTML_LIMIT:                                # 너무 크면 정책 없이 그대로 보낸다
                passthrough = True
                await send(start)
                await send({"type": "http.response.body", "body": b"".join(chunks), "more_body": message.get("more_body", False)})
                return
            if message.get("more_body"):
                return
            nonce = secrets.token_urlsafe(18)
            body = add_nonce(b"".join(chunks), nonce)
            headers = [(k, v) for k, v in start.get("headers", []) if k.lower() != b"content-length"]
            headers += [(b"content-length", str(len(body)).encode()), (HEADER.encode(), policy(nonce).encode())]
            await send({**start, "headers": headers})
            await send({"type": "http.response.body", "body": body})

        await self.app(scope, receive, wrapped)


def _clean(url) -> str:
    """보고의 주소에서 질의·조각을 지운다(토큰·next 가 들어 있을 수 있다). inline·eval 같은 낱말은 그대로."""
    s = str(url or "")[:500]
    if "://" not in s:
        return s[:60]
    u = urlsplit(s)
    return f"{u.scheme}://{u.netloc}{u.path}"[:200]


def _page(url) -> str:
    """위반이 난 화면은 경로만(호스트는 늘 AAS 다)."""
    return urlsplit(str(url or "")[:500]).path[:120] or "-"


def _reports(data) -> list[dict]:
    """두 형식을 같은 모양으로: report-uri 의 {"csp-report": {...}} 와 Reporting API 의 [{"type": "csp-violation", "body": {...}}]."""
    out = []
    if isinstance(data, dict) and isinstance(data.get("csp-report"), dict):
        r = data["csp-report"]
        out.append({"directive": r.get("effective-directive") or r.get("violated-directive"), "blocked": r.get("blocked-uri"),
                    "page": r.get("document-uri"), "source": r.get("source-file"), "line": r.get("line-number")})
    elif isinstance(data, list):
        for item in data[:20]:
            b = item.get("body") if isinstance(item, dict) else None
            if isinstance(b, dict) and item.get("type") == "csp-violation":
                out.append({"directive": b.get("effectiveDirective"), "blocked": b.get("blockedURL"),
                            "page": b.get("documentURL"), "source": b.get("sourceFile"), "line": b.get("lineNumber")})
    return out


def record(raw: bytes) -> bool:
    """보고 본문을 읽어 남긴다. 읽을 수 없으면 False."""
    try:
        reports = _reports(json.loads(raw or b"null"))
    except ValueError:
        return False
    if not reports:
        return False
    now = time.monotonic()
    for r in reports:
        directive = str(r["directive"] or "-")[:40]
        blocked, page = _clean(r["blocked"]) or "-", _page(r["page"])
        key = (directive, blocked, page)
        with _seen_lock:
            if now - _seen.get(key, -DEDUPE_S - 1) < DEDUPE_S:
                continue
            if len(_seen) >= DEDUPE_MAX:
                _seen.clear()
            _seen[key] = now
        line = r["line"] if isinstance(r["line"], int) else "-"
        LOG.warning("csp_violation directive=%s blocked=%s page=%s source=%s line=%s",
                    directive, blocked, page, _clean(r["source"]) or "-", line)
    return True


async def report_endpoint(request):
    """POST /api/csp-report. 브라우저가 보내므로 X-AAS 머리·로그인을 요구하지 않는다(로그인 화면의 위반도 받는다)."""
    from starlette.responses import Response
    length = int(request.headers.get("content-length") or 0)
    if length > REPORT_LIMIT:
        return Response(status_code=413)
    body = b""
    async for chunk in request.stream():
        body += chunk
        if len(body) > REPORT_LIMIT:
            return Response(status_code=413)
    return Response(status_code=204 if record(body) else 400)


def routes():
    from starlette.routing import Route
    return [Route(REPORT_PATH, report_endpoint, methods=["POST"])]

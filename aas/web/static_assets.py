# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""React 빌드 산출물의 /assets/ (스펙 2026-10-20-005 리뷰 D11).

옛 Handler 어댑터는 응답을 BytesIO 에 통째로 모은 뒤 보낸다(legacy.py). 문서 뷰어의 wasm·pdf.js 작업 스레드처럼 큰 파일은
메모리에 다 올리지 않도록 legacy Mount 앞에서 FileResponse 로 나눠 보낸다. 허용 Host·로그인·경로 규칙은 옛 _serve_file 과 같다.
"""
from __future__ import annotations

import hashlib
from pathlib import Path
from urllib.parse import unquote

from starlette.requests import Request
from starlette.responses import FileResponse, PlainTextResponse, RedirectResponse, Response
from starlette.routing import Route

from . import server
from .files import _View

_SECURITY = {"X-Content-Type-Options": "nosniff", "X-Frame-Options": "DENY"}


def _not_found() -> Response:
    return PlainTextResponse("not found", status_code=404, headers={"Cache-Control": "no-store", **_SECURITY})


def _target(rel: str) -> tuple[Path, str] | None:
    """점 파일·모르는 확장자·폴더 밖(심볼릭 링크 포함)은 None. 루트는 요청마다 읽는다(시험이 STATIC_DIR 을 바꿔 끼운다)."""
    if "\x00" in rel or not rel:
        return None
    root = (server.STATIC_DIR / "assets").resolve()
    target = (root / rel).resolve()
    ctype = server.STATIC_TYPES.get(target.suffix.lower())
    if not ctype or root not in target.parents or not target.is_file() or any(part.startswith(".") for part in Path(rel).parts):
        return None
    return target, ctype


def _etag(path: Path) -> str:
    """FileResponse 가 붙이는 ETag 와 같은 값(수정 시각·크기). 해시 이름 파일이라 이것으로 충분하다."""
    st = path.stat()
    return '"%s"' % hashlib.md5(f"{st.st_mtime}-{st.st_size}".encode(), usedforsecurity=False).hexdigest()


async def asset(request: Request) -> Response:
    view = _View(request)
    if not view._host_ok():
        return PlainTextResponse("invalid host", status_code=400, headers={"Cache-Control": "no-store", **_SECURITY})
    a = server.auth()
    if a.enabled and not a.user(request.headers.get("cookie")):
        return RedirectResponse("/auth/login", status_code=302, headers={"Cache-Control": "no-store"})
    found = _target(unquote(request.path_params["rest"]))
    if not found:
        return _not_found()
    path, ctype = found
    # 빌드가 미리 압축해 둔 .gz 가 있고 브라우저가 gzip 을 받으면 그것을 낸다(스펙 2026-10-20-005 §7 D7).
    # 압축본과 원본은 ETag 를 달리하고 Vary 를 붙여, 캐시가 둘을 섞어 내지 않게 한다(외부 검토 OV2-M6)
    gz = path.with_name(path.name + ".gz")
    has_gz = path.suffix.lower() == ".wasm" and gz.is_file() and not gz.is_symlink()
    use_gz = has_gz and "gzip" in request.headers.get("accept-encoding", "").lower()
    send = gz if use_gz else path
    etag = _etag(send)[:-1] + ('-gz"' if use_gz else '"')
    headers = {"Cache-Control": server.ASSET_CACHE, "ETag": etag, **_SECURITY}
    if has_gz:
        headers["Vary"] = "Accept-Encoding"
    if use_gz:
        headers["Content-Encoding"] = "gzip"
    if request.headers.get("if-none-match") == etag:
        return Response(status_code=304, headers=headers)
    return FileResponse(send, media_type=ctype, headers=headers, stat_result=send.stat())


def routes() -> list:
    return [Route("/assets/{rest:path}", asset, methods=["GET", "HEAD"])]

# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""대화 파일 올리기·내려받기·목록·지우기(OMAI-1153, 스펙 2026-10-14-005 §3·§3-10).

옛 Handler(legacy 어댑터)는 본문 1MB·응답 전체 버퍼링이라 파일을 다룰 수 없어 Starlette 라우트로 둔다.
- PUT    /api/chat/files?pod=&name=   본문 = 파일 바이트. Hermes upload-stream 으로 흘려보낸다(R3·R9·R15)
- HEAD   /api/chat/files?pod=&path=   받기 전 확인(R16). 이유 코드를 JSON 이 아니라 머리 X-AAS-Code 로 돌려준다
- GET    /api/chat/files?pod=&path=   사이드카 download 를 흘려보낸다(R1·R11)
- DELETE /api/chat/files?pod=&path=   사이드카로 링크·종류를 확인한 뒤 Hermes 로 지운다(R8)
- GET    /api/chat/files/list?pod=    「파일」 서랍 목록·사용량(D10·R15)
- GET|HEAD /api/office/chat/files?alias=&path=   오피스 장면 대화창의 받기(스펙 2026-10-20-002 R2·R4). 자리 별칭으로 고르고
  require_use(주인·방 구성원)를 본다. 주인이 올린 파일은 403 owner_private, 그 밖은 위 받기·확인과 같다
전송은 전용 스레드 한도(AAS_FILE_TRANSFERS, 기본 8)로 돌고 넘치면 429(R6). 이유는 코드로만 보낸다(화면이 번역, 재검토 O-7).
"""
from __future__ import annotations

import html
import http.client
import os
import threading
import urllib.parse
import urllib.request
import uuid

import anyio
from starlette.requests import ClientDisconnect, Request
from starlette.responses import JSONResponse, Response, StreamingResponse
from starlette.routing import Route

from ..common.i18n import tr
from ..hermes import workspace as wsp
from ..hermes.hermes_api import HermesError
from ..office import office, office_access
from . import server

CHUNK = 64 * 1024
# 브라우저와 조각 하나를 주고받는 데 기다리는 한도(초). 넘으면 그 전송을 끊고 자리를 돌려준다(스펙 2026-10-24-002 R11·D5)
STALL_WAIT = 60.0


def _transfers() -> int:
    try:
        return max(1, int(os.environ.get("AAS_FILE_TRANSFERS", "8")))
    except ValueError:
        return 8


class _Slots:
    """서버 파드 하나가 동시에 흘려보내는 전송 수(R6). 넘치면 기다리지 않고 429."""

    def __init__(self, n: int):
        self.n, self.used = n, 0
        self._lock = threading.Lock()

    def take(self) -> bool:
        with self._lock:
            if self.used >= self.n:
                return False
            self.used += 1
            return True

    def give(self) -> None:
        with self._lock:
            self.used = max(0, self.used - 1)

    def full(self) -> bool:
        with self._lock:
            return self.used >= self.n


SLOTS = _Slots(_transfers())
_limiter: anyio.CapacityLimiter | None = None


def limiter() -> anyio.CapacityLimiter:
    """전송 전용 스레드 한도. 기본 스레드 풀(AAS_THREADPOOL)을 화면 요청에 남겨 둔다(R6, 재검토 O-9)."""
    global _limiter
    if _limiter is None:
        _limiter = anyio.CapacityLimiter(SLOTS.n)
    return _limiter


class _View:
    """Handler 의 Host·출처 판정 메서드를 이 요청에 그대로 쓴다(규칙을 두 벌 두지 않는다, ws._View 와 같은 방식)."""
    _host_ok = server.Handler._host_ok
    _same_origin = server.Handler._same_origin
    _trusts_proxy = server.Handler._trusts_proxy
    _effective_host = server.Handler._effective_host
    _secure_request = server.Handler._secure_request
    _is_local_host = server.Handler._is_local_host
    _secrets_ok = server.Handler._secrets_ok

    def __init__(self, request: Request):
        self.headers = request.headers
        self.client_address = tuple(request.client or ("", 0))
        self._https = request.url.scheme == "https"
        self.principal = (getattr(request, "scope", None) or {}).get(server.PRINCIPAL_KEY)   # 같은 프로세스 안 요청이면 _same_origin 이 통과시킨다(D2)

    def _tls(self) -> bool:
        return self._https


def _err(code: str, status: int, **extra) -> JSONResponse:
    return JSONResponse({"code": code, **extra}, status_code=status, headers={"Cache-Control": "no-store"})


class _Denied(Exception):
    def __init__(self, code: str, status: int):
        super().__init__(code)
        self.code, self.status = code, status


def _context(request: Request, *, write: bool):
    """(pod, workspace). 상태를 바꾸는 요청(PUT·DELETE·HEAD)은 X-AAS·같은 출처, GET 은 SSE 처럼 Sec-Fetch-Site(R11·R16)."""
    view = _View(request)
    if not view._host_ok():
        raise _Denied("forbidden", 403)
    if write and not view._same_origin():
        raise _Denied("forbidden", 403)
    if not write and request.headers.get("Sec-Fetch-Site", "same-origin") not in ("same-origin", "none"):
        raise _Denied("forbidden", 403)
    a = server.auth()
    user = server.request_user(a, request)
    if a.enabled and not user:
        raise _Denied("login", 401)
    pid = request.query_params.get("pod", "")
    if not pid:
        raise _Denied("pod", 400)
    pod = next((p for p in server.registry().allowed(user, a.enabled) if p.id == pid), None)
    if pod is None:
        raise _Denied("pod", 403)
    ws = server.workspace_for(pod)
    if ws is None:
        raise _Denied("unsupported", 501)
    if not ws.supported():
        raise _Denied("old_sidecar", 501)
    return pod, ws


async def _ctx(request: Request, *, write: bool):
    return await anyio.to_thread.run_sync(lambda: _context(request, write=write))


# ---- 올리기 ------------------------------------------------------------------------------------
def _cookie(auth, url: str) -> str:
    req = urllib.request.Request(url)
    auth.jar.add_cookie_header(req)
    return req.get_header("Cookie") or ""


async def upload(request: Request) -> Response:
    try:
        _pod, ws = await _ctx(request, write=True)
    except _Denied as d:
        return _err(d.code, d.status)
    raw_len = request.headers.get("content-length", "")
    if not raw_len.isdigit():
        return _err("length", 411)
    size = int(raw_len)
    if size == 0:
        return _err("empty", 400)
    if size > wsp.MAX_FILE:
        return _err("too_large", 413, limit=wsp.MAX_FILE)
    asked = wsp.clean_name(urllib.parse.unquote(request.query_params.get("name", "")))
    if not SLOTS.take():
        return _err("busy", 429)
    try:
        ok, used = await anyio.to_thread.run_sync(ws.reserve, size)
        if not ok:
            return _err("quota", 413, used=used, quota=wsp.quota())
        try:
            folder = wsp.today_dir()
            if not await anyio.to_thread.run_sync(ws.ensure, folder):
                return _err("agent_unreachable", 502)
            name = await anyio.to_thread.run_sync(ws.pick_name, folder, asked)
            path = f"{folder}/{name}"
            status = await _stream_to_hermes(request, ws.api.auth, path, size)
        finally:
            ws.release(size)
    finally:
        SLOTS.give()
    if status == 200:
        return JSONResponse({"path": path, "name": name, "size": size, "renamed": name != asked})
    return _err({409: "name_taken", 413: "too_large", 499: "aborted"}.get(status, "agent_unreachable"),
                {409: 409, 413: 413, 499: 400}.get(status, 502))


def _multipart(path: str, overwrite: bool = False) -> tuple[str, bytes, bytes]:
    """Hermes upload-stream 의 multipart 머리·꼬리(path·overwrite·file). _stream_to_hermes 와 push_file 이 함께 쓴다."""
    boundary = uuid.uuid4().hex
    head = (f"--{boundary}\r\nContent-Disposition: form-data; name=\"path\"\r\n\r\n{path}\r\n"
            f"--{boundary}\r\nContent-Disposition: form-data; name=\"overwrite\"\r\n\r\n{'true' if overwrite else 'false'}\r\n"
            f"--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"upload\"\r\n"
            "Content-Type: application/octet-stream\r\n\r\n").encode("utf-8")
    return boundary, head, f"\r\n--{boundary}--\r\n".encode()


def _post_upload(auth, boundary: str, length: int, body) -> int:
    """multipart 본문(조각을 내는 반복자)을 Hermes upload-stream 에 보낸다. Hermes 상태, 연결이 끊기면 502."""
    url = auth.s["url"].rstrip("/")
    parts = urllib.parse.urlsplit(url)
    cls = http.client.HTTPSConnection if parts.scheme == "https" else http.client.HTTPConnection
    conn = cls(parts.hostname, parts.port, timeout=120)
    try:
        conn.request("POST", (parts.path or "") + "/api/files/upload-stream", body=body, headers={
            "Content-Type": f"multipart/form-data; boundary={boundary}", "Content-Length": str(length),
            "Cookie": _cookie(auth, url + "/api/files/upload-stream"), "Accept": "application/json"})
        resp = conn.getresponse()
        resp.read()
        if resp.status in (401, 403):
            auth.logged_in = False                            # 다음 요청이 다시 로그인한다
        return resp.status
    except (ConnectionAbortedError, OSError, http.client.HTTPException):
        return 502
    finally:
        conn.close()


def push_file(auth, path: str, local_path: str) -> int:
    """서버의 파일을 Hermes 작업 폴더 경로에 올린다(덮어쓰지 않음). PC 가져오기의 거른 묶음이 쓴다(2026-10-22-003 §4-4). Hermes 상태."""
    size = os.path.getsize(local_path)
    boundary, head, tail = _multipart(path)

    def body():
        yield head
        with open(local_path, "rb") as f:
            while True:
                chunk = f.read(1024 * 1024)
                if not chunk:
                    break
                yield chunk
        yield tail
    return _post_upload(auth, boundary, len(head) + size + len(tail), body())


def push_bytes(auth, path: str, data: bytes, overwrite: bool = False) -> int:
    """메모리의 바이트를 Hermes 경로에 올린다(기본은 덮어쓰지 않음). 인증 파일은 서버 디스크에 두지 않으려고 이 길을 쓴다
    (스펙 2026-10-22-004 §4-3). 허브 없는 설치본의 기본 스킬은 overwrite 로 판을 바꾼다(스펙 2026-10-29-001 R10). Hermes 상태."""
    boundary, head, tail = _multipart(path, overwrite)
    return _post_upload(auth, boundary, len(head) + len(data) + len(tail), iter((head, data, tail)))


async def _stream_to_hermes(request: Request, auth, path: str, size: int, tee=None) -> int:
    """브라우저 본문을 multipart 로 감싸 Hermes upload-stream 에 흘려보낸다(R3). path·overwrite 는 AAS 가 쓴다.
    브라우저가 끊거나 길이가 맞지 않으면 위쪽 연결도 끊어 Hermes 가 임시 파일을 지우게 한다. Hermes 상태를 돌려준다(499: 중단).
    tee 가 있으면 받은 조각마다 부른다(PC 묶음 검사가 서버 임시 파일에도 쓴다, OMAI-1136)."""
    boundary, head, tail = _multipart(path)
    send_ch, recv_ch = anyio.create_memory_object_stream(8)
    state = {"aborted": False}

    def body():
        yield head
        while True:
            try:
                chunk = anyio.from_thread.run(recv_ch.receive)
            except anyio.EndOfStream:
                break
            yield chunk
        if state["aborted"]:
            raise ConnectionAbortedError("client aborted")    # 끝을 보내지 않고 끊는다 — Hermes 는 임시 파일을 지운다
        yield tail

    def worker() -> int:
        status = _post_upload(auth, boundary, len(head) + size + len(tail), body())
        return 499 if status == 502 and state["aborted"] else status

    async def feed():
        got = 0
        try:
            async with send_ch:
                chunks = request.stream().__aiter__()
                while True:
                    try:
                        with anyio.fail_after(STALL_WAIT):            # 올리다 멈춘 브라우저 — 자리·용량 예약을 쥐지 않게 끊는다(R11)
                            chunk = await chunks.__anext__()
                    except StopAsyncIteration:
                        break
                    except TimeoutError:
                        state["aborted"] = True
                        return
                    if not chunk:
                        continue
                    got += len(chunk)
                    if got > size:
                        state["aborted"] = True
                        return
                    if tee is not None:
                        tee(chunk)
                    await send_ch.send(chunk)
                if got != size:
                    state["aborted"] = True
        except ClientDisconnect:
            state["aborted"] = True

    result = 502
    async with anyio.create_task_group() as tg:
        tg.start_soon(feed)
        result = await anyio.to_thread.run_sync(worker, limiter=limiter())
        tg.cancel_scope.cancel()                           # Hermes 가 먼저 답했으면(거절 등) 남은 본문을 읽지 않는다
    return result


# ---- 확인·내려받기·지우기 ------------------------------------------------------------------------
def _check_code(info: dict) -> tuple[int, str]:
    if not info.get("exists"):
        return 404, "not_found"
    if info.get("link"):
        return 403, "link"
    if info.get("type") == "dir":
        return 403, "dir"
    if info.get("type") != "file":
        return 403, "not_file"
    if int(info.get("nlink") or 1) > 1:
        return 403, "hardlink"
    return 200, ""


def _page(status: int, code: str) -> Response:
    """주소를 직접 열었을 때만 보이는 안내(화면은 HEAD 로 먼저 확인한다, R16)."""
    msg = {"not_found": tr("파일이 없습니다. 이미 지웠을 수 있습니다.", "The file does not exist. It may have been deleted."),
           "busy": tr("내려받기가 몰려 있습니다. 잠시 뒤 다시 시도하세요.", "Too many downloads. Try again shortly."),
           "old_sidecar": tr("AI 에이전트 작업공간을 다시 띄운 뒤 받을 수 있습니다.", "Restart the AI Agent Workspace to download files."),
           }.get(code, tr("받을 수 없는 파일입니다.", "This file cannot be downloaded."))
    body = (f"<!doctype html><meta charset=utf-8><title>AAS</title><body style='font-family:sans-serif;padding:24px'>"
            f"<p>{html.escape(msg)}</p><p><a href='javascript:history.back()'>{html.escape(tr('대화로 돌아가기', 'Back to the chat'))}</a></p>")
    return Response(body, status_code=status, media_type="text/html; charset=utf-8",
                    headers={"Cache-Control": "no-store", "X-AAS-Code": code})


async def head(request: Request) -> Response:
    try:
        _pod, ws = await _ctx(request, write=True)
    except _Denied as d:
        return Response(status_code=d.status, headers={"X-AAS-Code": d.code})
    path = request.query_params.get("path", "")
    if not wsp.in_workspace(path):
        return Response(status_code=400, headers={"X-AAS-Code": "outside"})
    return await _head_of(ws, path)


async def _head_of(ws, path: str) -> Response:
    """권한·경로 검사를 마친 뒤의 확인(채팅 받기·오피스 대화창 받기가 같이 쓴다)."""
    if SLOTS.full():
        return Response(status_code=429, headers={"X-AAS-Code": "busy"})
    try:
        status, code = _check_code(await anyio.to_thread.run_sync(ws.check, path))
    except OSError:
        status, code = 502, "agent_unreachable"
    return Response(status_code=status, headers={"X-AAS-Code": code, "Cache-Control": "no-store"})


class _SlotStream(StreamingResponse):
    """전송 자리를 응답이 끝나거나 끊길 때 돌려준다(생성기가 시작되기 전에 끊겨도)."""

    def __init__(self, *args, on_close, **kwargs):
        super().__init__(*args, **kwargs)
        self._on_close = on_close

    async def __call__(self, scope, receive, send):
        stalled = []

        async def send_or_give_up(message):
            # 받지 않는 브라우저로 보내기가 커널 재전송 한도(약 15분)까지 자리를 쥐지 않게 끊는다(스펙 2026-10-24-002 R11)
            try:
                with anyio.fail_after(STALL_WAIT):
                    await send(message)
            except TimeoutError:
                stalled.append(True)
                raise
        try:
            await super().__call__(scope, receive, send_or_give_up)
        except (TimeoutError, ClientDisconnect):          # Starlette 는 보내기의 OSError(시간 초과 포함)를 ClientDisconnect 로 바꾼다
            if not stalled:
                raise
        finally:
            self._on_close()


async def download(request: Request) -> Response:
    if request.method == "HEAD":
        return await head(request)
    try:
        _pod, ws = await _ctx(request, write=False)
    except _Denied as d:
        return _page(d.status, d.code)
    path = request.query_params.get("path", "")
    if not wsp.in_workspace(path):
        return _page(400, "outside")
    return await _download_of(ws, path)


async def _download_of(ws, path: str) -> Response:
    """권한·경로 검사를 마친 뒤 사이드카 download 를 흘려보낸다(채팅 받기·오피스 대화창 받기가 같이 쓴다)."""
    if not SLOTS.take():
        return _page(429, "busy")
    try:
        status, code, resp, conn = await anyio.to_thread.run_sync(ws.backend.open_download, path)
    except OSError:
        SLOTS.give()
        return _page(502, "agent_unreachable")
    if status != 200:
        SLOTS.give()
        return _page(status, {"missing": "not_found"}.get(code, code or "not_file"))
    name = urllib.parse.unquote(resp.getheader("X-File-Name") or path.rsplit("/", 1)[-1])
    closed = {"v": False}

    def close():
        if not closed["v"]:
            closed["v"] = True
            conn.close()
            SLOTS.give()

    async def chunks():
        while True:
            chunk = await anyio.to_thread.run_sync(resp.read, CHUNK, limiter=limiter())
            if not chunk:
                break
            yield chunk

    headers = {"Content-Length": resp.getheader("Content-Length") or "",
               "Content-Disposition": "attachment; filename=\"download\"; filename*=UTF-8''" + urllib.parse.quote(name),
               "X-Content-Type-Options": "nosniff", "Cache-Control": "no-store"}
    return _SlotStream(chunks(), media_type="application/octet-stream", headers=headers, on_close=close)


# ---- 오피스 장면 대화창 받기(스펙 2026-10-20-002 R2·R4) ------------------------------------------------
def office_target(acc, alias: str, path: str):
    """대화창 받기가 열어 주는 범위를 보고 그 자리의 작업 폴더를 돌려준다. 안 되면 _Denied.
    채팅 받기(_context)는 설치본 주인·grants 만 통과시키므로 방 구성원은 쓸 수 없다 — 대화 보내기와 같은 require_use 를 본다.
    받을 수 있는 곳은 workspace/ 아래(숨은 파일 제외)이고, 주인이 올린 파일(workspace.own_upload)은 주인 본인이 와도 owner_private 로 막는다
    (리뷰 R4·D12: 대화 기록을 읽지 않고 경로 규칙으로 정한다). 남는 위험: 에이전트는 작업 폴더를 다 읽으므로 내용을 글로 말할 수는 있다."""
    if not alias:
        raise _Denied("bad_request", 400)
    try:
        acc.require_use(alias)
    except office_access.Denied:
        raise _Denied("forbidden", 403) from None
    if not wsp.in_workspace(path) or wsp.hidden(path):
        raise _Denied("outside", 400)
    if wsp.own_upload(path):
        raise _Denied("owner_private", 403)
    seat = next((s for s in office.seats() if s["alias"] == alias and s["enabled"]), None)
    if seat is None:
        raise _Denied("not_found", 404)
    ws = server._workspace_for_pod_id(seat["pod"])
    if ws is None:
        raise _Denied("unsupported", 501)
    if not ws.supported():
        raise _Denied("old_sidecar", 501)
    return ws


def _office_context(request: Request, *, write: bool):
    """(작업 폴더, 경로). Host·출처 규칙은 채팅 받기(_context)와 같다(HEAD 는 X-AAS·같은 출처, GET 은 Sec-Fetch-Site)."""
    view = _View(request)
    if not view._host_ok():
        raise _Denied("forbidden", 403)
    if write and not view._same_origin():
        raise _Denied("forbidden", 403)
    if not write and request.headers.get("Sec-Fetch-Site", "same-origin") not in ("same-origin", "none"):
        raise _Denied("forbidden", 403)
    a = server.auth()
    user = server.request_user(a, request)
    if a.enabled and not user:
        raise _Denied("login", 401)
    path = request.query_params.get("path", "")
    acc = office_access.Access(server.registry(), user, a.enabled)
    return office_target(acc, request.query_params.get("alias", ""), path), path


async def office_file(request: Request) -> Response:
    is_head = request.method == "HEAD"
    try:
        ws, path = await anyio.to_thread.run_sync(lambda: _office_context(request, write=is_head))
    except _Denied as d:
        return Response(status_code=d.status, headers={"X-AAS-Code": d.code, "Cache-Control": "no-store"}) if is_head else _page(d.status, d.code)
    return await (_head_of(ws, path) if is_head else _download_of(ws, path))


async def delete(request: Request) -> Response:
    try:
        _pod, ws = await _ctx(request, write=True)
    except _Denied as d:
        return _err(d.code, d.status)
    path = request.query_params.get("path", "")
    recursive = request.query_params.get("recursive") == "1"
    if not wsp.in_workspace(path):
        return _err("outside", 400)

    def run():
        info = ws.check(path)
        folder = recursive and info.get("exists") and not info.get("link") and info.get("type") == "dir"
        if folder:
            # 폴더 지우기(스펙 2026-10-28-002): recursive=1 일 때만. 올린 파일 루트·회의 공유·.hermes·숨은 경로는 막는다
            if not wsp.can_delete_dir(path):
                return 403, "protected"
        else:
            status, code = _check_code(info)       # 심링크·폴더·하드링크면 지우지 않는다(R8)
            if status != 200:
                return status, code
        try:
            ws.delete(path, recursive=bool(folder))
        except HermesError as exc:
            return (404, "not_found") if exc.code == 404 else (502, "agent_unreachable")
        return 200, ""
    try:
        status, code = await anyio.to_thread.run_sync(run)
    except OSError:
        status, code = 502, "agent_unreachable"
    return JSONResponse({"ok": True, "path": path}) if status == 200 else _err(code, status)


async def listing(request: Request) -> Response:
    try:
        _pod, ws = await _ctx(request, write=False)
    except _Denied as d:
        return _err(d.code, d.status)
    try:
        out = await anyio.to_thread.run_sync(ws.listing)
    except OSError:
        return _err("agent_unreachable", 502)
    return JSONResponse(out, headers={"Cache-Control": "no-store"})


async def files(request: Request) -> Response:
    if request.method == "PUT":
        return await upload(request)
    if request.method == "DELETE":
        return await delete(request)
    return await download(request)


def routes() -> list:
    return [Route("/api/chat/files/list", listing, methods=["GET"]),
            Route("/api/chat/files", files, methods=["GET", "HEAD", "PUT", "DELETE"]),
            Route("/api/office/chat/files", office_file, methods=["GET", "HEAD"])]       # 레거시 Mount 앞(/api/office/chat/ 접두를 레거시 Handler 도 받는다)

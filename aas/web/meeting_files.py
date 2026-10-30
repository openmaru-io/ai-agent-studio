# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""회의 파일 올리기·내려받기·목록·지우기(스펙 office/meeting-file-sharing §4-6·§4-9).

옛 Handler(legacy 어댑터)는 본문 1MB·응답 전체 버퍼링이라 파일을 다룰 수 없어 Starlette 라우트로 둔다. 레거시 Mount("/") 앞에 등록한다
(/api/office/meeting/ 접두는 레거시 Handler 도 받는다).
- PUT    /api/office/meeting/files?room=&name=          본문 = 파일 바이트. 서버가 공유 볼륨에 직접 쓴다
- GET    /api/office/meeting/files?room=                올린 파일(DB)·에이전트 출력(디스크 스캔) 목록
- GET    /api/office/meeting/files/<id>?room=           받기
- DELETE /api/office/meeting/files/<id>?room=           올린 사람 또는 관리자
- GET    /api/office/meeting/out?room=&path=            에이전트 출력 받기
- GET    /api/office/meeting/agent-file?room=&msg=&n=   방 기록에 남은 에이전트 결과 파일 받기(사이드카 download 를 흘려보낸다)
- POST   /api/office/meeting/files/from-agent           에이전트 결과 파일을 방에 올리기
방 구성원 확인은 office_access.Access.require_room 이다(채팅 파일의 _context 는 설치본 주인·관리자만 통과시켜 쓸 수 없다).
오류는 JSON {"error": 코드}. 전송은 채팅 파일과 같은 전송 자리(SLOTS)·전용 스레드 한도를 쓴다.
"""
from __future__ import annotations

import json
import urllib.parse

import anyio
from starlette.requests import ClientDisconnect, Request
from starlette.responses import JSONResponse, Response
from starlette.routing import Route

from ..hermes import workspace as wsp
from ..office import meeting, meeting_files, office_access
from ..office.meeting_files import FileError
from . import server
from .files import CHUNK, SLOTS, _SlotStream, _View, limiter


class _Denied(Exception):
    def __init__(self, code: str, status: int):
        super().__init__(code)
        self.code, self.status = code, status


def _err(code: str, status: int) -> JSONResponse:
    return JSONResponse({"error": code}, status_code=status, headers={"Cache-Control": "no-store"})


def _context(request: Request, *, write: bool, room=None):
    """(보낸 사람, 접근 규칙, 방 번호, 방). 상태를 바꾸는 요청은 X-AAS·같은 출처, GET 은 Sec-Fetch-Site(채팅 파일과 같은 규칙)."""
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
    try:
        rid = int(room if room is not None else request.query_params.get("room", ""))
    except (TypeError, ValueError):
        raise _Denied("bad_request", 400) from None
    acc = office_access.Access(server.registry(), user, a.enabled)
    try:
        row = acc.require_room(rid)
    except office_access.Denied as exc:
        raise _Denied("no_room", 404) if exc.code == 404 else _Denied("forbidden", 403) from None
    if not meeting_files.enabled():
        raise _Denied("not_configured", 501)
    return acc.email or "local", acc, rid, row


async def _ctx(request: Request, *, write: bool, room=None):
    return await anyio.to_thread.run_sync(lambda: _context(request, write=write, room=room))


def _fail(exc: FileError) -> JSONResponse:
    return _err(exc.code, exc.status)


# ---- 올리기 ------------------------------------------------------------------------------------
async def upload(request: Request) -> Response:
    try:
        who, _acc, rid, room = await _ctx(request, write=True)
    except _Denied as d:
        return _err(d.code, d.status)
    if room.get("status") == "closed":
        return _err("room_closed", 409)
    raw_len = request.headers.get("content-length", "")
    if not raw_len.isdigit():
        return _err("bad_request", 400)
    size = int(raw_len)
    if not SLOTS.take():
        return _err("busy", 429)
    try:
        try:
            up = await anyio.to_thread.run_sync(meeting_files.begin, rid, request.query_params.get("name", ""), size, who)
        except FileError as exc:
            return _fail(exc)
        try:
            async for chunk in request.stream():
                if chunk:
                    await anyio.to_thread.run_sync(up.write, chunk, limiter=limiter())
            out = await anyio.to_thread.run_sync(up.finish)
        except FileError as exc:
            with anyio.CancelScope(shield=True):
                await anyio.to_thread.run_sync(up.abort)
            return _fail(exc)
        except ClientDisconnect:
            with anyio.CancelScope(shield=True):
                await anyio.to_thread.run_sync(up.abort)
            return _err("bad_request", 400)
        except BaseException:                                # 취소·예기치 못한 오류: 임시 파일과 uploading 행을 남기지 않는다
            with anyio.CancelScope(shield=True):
                await anyio.to_thread.run_sync(up.abort)
            raise
    finally:
        SLOTS.give()
    return JSONResponse(out, headers={"Cache-Control": "no-store"})


# ---- 목록·지우기 -----------------------------------------------------------------------------------
async def listing(request: Request) -> Response:
    try:
        _who, _acc, rid, _room = await _ctx(request, write=False)
    except _Denied as d:
        return _err(d.code, d.status)
    return JSONResponse(await anyio.to_thread.run_sync(meeting_files.listing, rid), headers={"Cache-Control": "no-store"})


async def delete(request: Request) -> Response:
    try:
        who, acc, rid, _room = await _ctx(request, write=True)
    except _Denied as d:
        return _err(d.code, d.status)
    try:
        await anyio.to_thread.run_sync(meeting_files.remove, rid, request.path_params["fid"], who, acc.admin)
    except FileError as exc:
        return _fail(exc)
    return JSONResponse({"ok": True}, headers={"Cache-Control": "no-store"})


# ---- 받기 ------------------------------------------------------------------------------------------
def _disposition(name: str) -> str:
    return "attachment; filename=\"download\"; filename*=UTF-8''" + urllib.parse.quote(name)


def _stream_file(fh, size: int, name: str) -> Response:
    """열린 파일을 흘려보낸다. 전송 자리는 부른 쪽이 잡았고 응답이 끝나거나 끊길 때 돌려준다."""
    closed = {"v": False}

    def close():
        if not closed["v"]:
            closed["v"] = True
            fh.close()
            SLOTS.give()

    async def chunks():
        while True:
            chunk = await anyio.to_thread.run_sync(fh.read, CHUNK, limiter=limiter())
            if not chunk:
                break
            yield chunk

    headers = {"Content-Length": str(size), "Content-Disposition": _disposition(name),
               "X-Content-Type-Options": "nosniff", "Cache-Control": "no-store"}
    return _SlotStream(chunks(), media_type="application/octet-stream", headers=headers, on_close=close)


async def _serve(request: Request, opener) -> Response:
    """방 구성원 확인 → 전송 자리 → opener(방 번호) 가 (파일 객체, 크기, 이름) → 흘려보내기."""
    try:
        _who, _acc, rid, _room = await _ctx(request, write=False)
    except _Denied as d:
        return _err(d.code, d.status)
    if not SLOTS.take():
        return _err("busy", 429)
    try:
        fh, size, name = await anyio.to_thread.run_sync(opener, rid)
    except FileError as exc:
        SLOTS.give()
        return _fail(exc)
    except OSError:
        SLOTS.give()
        return _err("io_error", 502)
    return _stream_file(fh, size, name)


async def download(request: Request) -> Response:
    fid = request.path_params["fid"]
    return await _serve(request, lambda rid: meeting_files.open_file(rid, fid))


async def download_out(request: Request) -> Response:
    path = request.query_params.get("path", "")
    return await _serve(request, lambda rid: meeting_files.open_out(rid, path))


# ---- 에이전트 결과 파일 ---------------------------------------------------------------------------------
def _agent_record(rid: int, msg, n) -> tuple[str, str, str]:
    """방 기록의 files 행에서 (설치본, 경로, 에이전트 별칭). 요청이 아니라 기록에서 읽는다(결정 R2) — 기록에 없는 경로는 받을 수 없다."""
    try:
        msg, n = int(msg), int(n)
    except (TypeError, ValueError):
        raise FileError("bad_request", 400) from None
    with meeting._db() as conn:
        row = conn.execute("SELECT author, kind, data FROM office_messages WHERE id=? AND room=?", (msg, rid)).fetchone()
    if row is None or row["kind"] != meeting.CHIP_NOTE:
        raise FileError("no_file", 404)
    try:
        data = json.loads(row["data"] or "{}")
        files = data.get("files") or []
        path, pod = str(files[n]["path"]), str(data.get("pod") or "")
    except (ValueError, IndexError, KeyError, TypeError):
        raise FileError("no_file", 404) from None
    if n < 0 or not wsp.in_workspace(path):
        raise FileError("no_file", 404)
    return pod, path, str(row["author"])


def _open_agent(rid: int, msg, n):
    """(응답, 연결, 이름, 별칭, 출처 「설치본:경로」) — 사이드카 download. 사이드카가 심링크·하드링크·workspace 밖을 다시 확인한다."""
    pod, path, alias = _agent_record(rid, msg, n)
    ws = server._workspace_for_pod_id(pod)
    if ws is None or not ws.supported():
        raise FileError("io_error", 502)
    status, code, resp, conn = ws.backend.open_download(path)
    if status != 200:
        raise FileError("no_file", 404) if status == 404 or code == "missing" else FileError("io_error", 502)
    name = urllib.parse.unquote(resp.getheader("X-File-Name") or path.rsplit("/", 1)[-1])
    return resp, conn, name, alias, f"{pod}:{path}"


class _ConnFile:
    """사이드카 응답을 파일처럼 읽고, 닫을 때 연결도 닫는다(_stream_file 이 쓴다)."""

    def __init__(self, resp, conn):
        self.resp, self.conn = resp, conn

    def read(self, n: int) -> bytes:
        return self.resp.read(n)

    def close(self) -> None:
        self.conn.close()


async def agent_file(request: Request) -> Response:
    q = request.query_params

    def opener(rid):
        resp, conn, name, _alias, _src = _open_agent(rid, q.get("msg"), q.get("n"))
        return _ConnFile(resp, conn), int(resp.getheader("Content-Length") or 0), name
    return await _serve(request, opener)


async def from_agent(request: Request) -> Response:
    raw_len = request.headers.get("content-length", "")
    if not raw_len.isdigit() or int(raw_len) > 4096:
        return _err("bad_request", 400)
    try:
        body = json.loads(await request.body() or b"{}")
        room, msg, n = body["room"], body["msg"], body["n"]
    except (ValueError, KeyError, TypeError):
        return _err("bad_request", 400)
    try:
        who, _acc, rid, row = await _ctx(request, write=True, room=room)
    except _Denied as d:
        return _err(d.code, d.status)
    if row.get("status") == "closed":
        return _err("room_closed", 409)

    def run():
        resp, conn, name, alias, src = _open_agent(rid, msg, n)
        try:
            return meeting_files.put_agent(rid, name, int(resp.getheader("Content-Length") or 0), resp.read, who, alias, src, int(msg))
        finally:
            conn.close()
    if not SLOTS.take():
        return _err("busy", 429)
    try:
        out = await anyio.to_thread.run_sync(run, limiter=limiter())
    except FileError as exc:
        return _fail(exc)
    except OSError:
        return _err("io_error", 502)
    finally:
        SLOTS.give()
    return JSONResponse(out, headers={"Cache-Control": "no-store"})


async def files_root(request: Request) -> Response:
    return await (upload(request) if request.method == "PUT" else listing(request))


async def file_one(request: Request) -> Response:
    return await (delete(request) if request.method == "DELETE" else download(request))


def routes() -> list:
    return [Route("/api/office/meeting/files/from-agent", from_agent, methods=["POST"]),
            Route("/api/office/meeting/files/{fid}", file_one, methods=["GET", "DELETE"]),
            Route("/api/office/meeting/files", files_root, methods=["GET", "PUT"]),
            Route("/api/office/meeting/out", download_out, methods=["GET"]),
            Route("/api/office/meeting/agent-file", agent_file, methods=["GET"])]

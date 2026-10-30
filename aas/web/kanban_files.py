# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""칸반 카드 첨부 내려받기(스펙 office/kanban-card-structured-brief §3-9, R1·R4·R6·R7).

옛 Handler(legacy 어댑터)는 응답을 전부 버퍼링해 파일을 보낼 수 없어 대화 파일(files.py)과 같이 Starlette 라우트로 둔다.
레거시 Mount("/") 앞에 등록한다(/api/office/kanban/ 접두는 레거시 Handler 도 받는다).
- HEAD /api/office/kanban/tasks/<task_id>/attachments/<att_id>?board=   받기 전 확인. 이유는 머리 X-AAS-Code 로만 준다
- GET  /api/office/kanban/tasks/<task_id>/attachments/<att_id>?board=   Hermes 대시보드의 첨부를 흘려보낸다
권한은 카드 상세와 같다: 관리자는 모두, 그 밖의 사람은 카드 담당을 쓸 수 있어야 한다. 담당이 비면 막지 않는다(R7, 카드 상세와 같은 규칙).
Hermes 내려받기는 보드 단위라, 먼저 카드 상세의 첨부 목록에 att_id 가 있는지 본다(번호만 바꿔 다른 카드 첨부를 받지 못하게).
실패하면 본문 없이 X-AAS-Code(forbidden·login·bad_request·not_found·too_large·busy·agent_unreachable)를 준다. 화면이 번역한다.
"""
from __future__ import annotations

import urllib.parse

import anyio
from starlette.requests import Request
from starlette.responses import Response
from starlette.routing import Route

from ..common import store
from ..hermes.hermes_api import HermesError
from ..office import hub_auto, office_access
from . import server
from .files import CHUNK, SLOTS, _SlotStream, _View, limiter

MAX_BYTES = 25 * 1024 * 1024          # Hermes KANBAN_ATTACHMENT_MAX_BYTES(hermes_cli/kanban_db.py, 이미지 판 d923a5e)


class _Denied(Exception):
    def __init__(self, code: str, status: int):
        super().__init__(code)
        self.code, self.status = code, status


def _fail(code: str, status: int) -> Response:
    return Response(status_code=status, headers={"X-AAS-Code": code, "Cache-Control": "no-store"})


def _context(request: Request, *, write: bool) -> dict:
    """권한·카드 소속·크기를 확인하고 (사람, 설치본, 보드, 카드, 첨부)를 돌려준다. HEAD 는 X-AAS·같은 출처, GET 은 Sec-Fetch-Site(files.py 와 같은 규칙)."""
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
    board = request.query_params.get("board", "")
    task_id, att_id = request.path_params["task_id"], request.path_params["att_id"]
    if not board:
        raise _Denied("bad_request", 400)
    acc = office_access.Access(server.registry(), user, a.enabled)
    auto = server.office_auto()
    if not acc.admin:
        try:
            acc.require_use(auto.card_assignee(board, task_id))     # 담당이 비면 통과(R7, 카드 상세와 같다)
        except office_access.Denied:
            raise _Denied("forbidden", 403) from None
    try:
        pod = auto.pod_of(board, task_id)
        listed = auto.detail(board, task_id, pod)["attachments"]
    except hub_auto.Fail as exc:
        if exc.status == 503:
            raise _Denied("agent_unreachable", 503) from None
        raise _Denied("bad_request", 400) if exc.status == 400 else _Denied("not_found", 404) from None
    att = next((x for x in listed if str(x.get("id")) == att_id), None)
    if att is None:
        raise _Denied("not_found", 404)
    try:
        size = int(att.get("size") or 0)
    except (TypeError, ValueError):
        size = 0
    if size > MAX_BYTES:
        raise _Denied("too_large", 413)
    return {"who": acc.email or "local", "auto": auto, "pod": pod, "board": board, "task_id": task_id, "att_id": att_id,
            "name": str(att.get("filename") or "download")}


async def attachment(request: Request) -> Response:
    is_head = request.method == "HEAD"
    try:
        ctx = await anyio.to_thread.run_sync(lambda: _context(request, write=is_head))
    except _Denied as d:
        return _fail(d.code, d.status)
    if is_head:
        if SLOTS.full():
            return _fail("busy", 429)
        return Response(status_code=200, headers={"Cache-Control": "no-store"})
    if not SLOTS.take():
        return _fail("busy", 429)
    path = f"/api/plugins/kanban/attachments/{urllib.parse.quote(ctx['att_id'], safe='')}"
    try:
        resp = await anyio.to_thread.run_sync(lambda: ctx["auto"].api(ctx["pod"]).open_stream("GET", path, {"board": ctx["board"]}),
                                              limiter=limiter())
    except HermesError as exc:
        SLOTS.give()
        return _fail("not_found", 404) if exc.code == 404 else _fail("agent_unreachable", 503)
    except Exception:                                                    # 로그인 실패 등
        SLOTS.give()
        return _fail("agent_unreachable", 503)
    length = resp.headers.get("Content-Length") or ""
    if length.isdigit() and int(length) > MAX_BYTES:
        resp.close()
        SLOTS.give()
        return _fail("too_large", 413)
    closed = {"v": False}

    def close():
        if not closed["v"]:
            closed["v"] = True
            resp.close()
            SLOTS.give()

    async def chunks():
        sent = 0
        while True:
            chunk = await anyio.to_thread.run_sync(resp.read, CHUNK, limiter=limiter())
            if not chunk:
                break
            sent += len(chunk)
            if sent > MAX_BYTES:                                         # 목록 크기와 달리 더 크면 끊는다(받는 쪽은 덜 받은 파일로 안다)
                raise ConnectionAbortedError("attachment exceeds the size limit")
            yield chunk

    await anyio.to_thread.run_sync(store.log_usage, "kanban_attachment_download",
                                   f"{ctx['who']} {ctx['board']} {ctx['task_id']} {ctx['att_id']}"[:200])
    headers = {"Content-Disposition": "attachment; filename=\"download\"; filename*=UTF-8''" + urllib.parse.quote(ctx["name"], safe=""),
               "X-Content-Type-Options": "nosniff", "Cache-Control": "no-store"}
    if length.isdigit():
        headers["Content-Length"] = length
    return _SlotStream(chunks(), media_type="application/octet-stream", headers=headers, on_close=close)


def routes() -> list:
    return [Route("/api/office/kanban/tasks/{task_id}/attachments/{att_id}", attachment, methods=["GET", "HEAD"])]

# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""「MindWiki 에 저장」 경로(스펙 2026-11-15-002 A4·D11·D19). 일은 aas.ops.mindwiki_save 가 한다.

- GET  /api/mindwiki/save/state?pod=&profile=        단추를 보일지·막을지와 기억한 저장 위치(Keycloak 을 부르지 않는다, 기억한 확인만)
- GET  /api/mindwiki/save/teamspaces?pod=&profile=   위치 고르기: 팀스페이스
- GET  /api/mindwiki/save/pages?pod=&profile=&parent=&teamspace=&q=   위치 고르기: 페이지(제목·id·경로만)
- PUT  /api/mindwiki/save/target                     저장 위치 기억
- POST /api/mindwiki/save/answer                     답 하나를 새 하위 페이지로
- POST /api/mindwiki/save/file                       대화 파일 하나를 「AAS 파일」 페이지에 첨부

권한: 로그인한 프로파일 주인만(관리자도 남의 작업공간 대화는 저장하지 못한다, 2026-11-14-001 과 같은 규칙). 위젯 토큰은 이 경로를 부를 수
없고(aas/auth/embed.py 의 허용 경로 밖, D19), Keycloak 로그인을 쓰지 않는 설치(비밀번호 로그인)에서는 no_keycloak 이다.
쓰기는 X-AAS·같은 출처를 본다. 사용 기록 usage 에 mindwiki_save(<프로파일> <종류> <page_id>)를 남기고 본문은 남기지 않는다.
"""
from __future__ import annotations

import json
import urllib.parse

import anyio
from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.routing import Route

from ..common import config, store
from ..hermes import workspace as wsp
from ..ops import mindwiki_save as ms
from . import files, server

MAX_BODY = (1 << 20) + 8192


class _Fail(Exception):
    def __init__(self, reason: str, status: int):
        super().__init__(reason)
        self.reason, self.status = reason, status


def _json(data: dict, status: int = 200) -> JSONResponse:
    return JSONResponse(data, status_code=status, headers={"Cache-Control": "no-store"})


def _fail(reason: str, status: int) -> JSONResponse:
    return _json({"ok": False, "reason": reason}, status)


def _who(request: Request, *, write: bool, pod_id: str, profile: str):
    """(auth, user, pod). 주인이 아니면 not_owner, Keycloak 로그인이 아니면 no_keycloak."""
    view = files._View(request)
    if not view._host_ok() or (write and not view._same_origin()):
        raise _Fail("forbidden", 403)
    a = server.auth()
    if not a.enabled or not a.oidc_enabled:
        raise _Fail("no_keycloak", 409)
    user = server.request_user(a, request)
    if not user:
        raise _Fail("session_ended", 401)
    pod = next((p for p in server.registry().allowed(user, a.enabled) if p.id == pod_id), None)
    if pod is None or not server._owns_pod(pod, user, a.enabled):
        raise _Fail("not_owner", 403)
    if not profile or len(profile) > 120:
        raise _Fail("invalid", 400)
    return a, user, pod


def _token(a, request: Request) -> str:
    token, why = a.access_token(request.headers.get("cookie"))
    if not token:
        # 409: 화면 전역의 401 처리(로그인 화면으로 옮기기)를 타지 않고, 그 자리에 「다시 로그인」을 보인다
        raise _Fail(why or "session_ended", 409 if why in ("session_ended", "no_refresh_token") else 503)
    return token


def _workspace(user, pod, profile: str) -> str:
    ws = ms.connected_workspace(str(user.get("sub") or ""), pod.id, profile)
    if not ws:
        raise _Fail("need_workspace", 409)
    return ws


def _run(fn):
    async def handler(request: Request):
        try:
            return await anyio.to_thread.run_sync(lambda: fn(request))
        except _Fail as f:
            return _fail(f.reason, f.status)
        except ms.SaveError as e:
            return _fail(e.reason, e.status)
    return handler


def _q(request: Request, name: str) -> str:
    return str(request.query_params.get(name) or "")[:200]


def _state(request: Request):
    pod_id, profile = _q(request, "pod"), _q(request, "profile")
    try:
        _a, user, pod = _who(request, write=False, pod_id=pod_id, profile=profile)
    except _Fail as f:
        if f.reason in ("no_keycloak",):
            return _json({"available": False, "hidden": True, "reason": f.reason})
        raise
    sub = str(user.get("sub") or "")
    ws = ms.connected_workspace(sub, pod.id, profile)
    tgt = ms.target(sub, pod.id, profile) or {}
    if tgt and ws and tgt.get("workspace") != ws:                     # 연결 워크스페이스가 바뀌었다 — 위치를 다시 고른다
        tgt = {}
    cap = ms.cached_capabilities() or {}
    reason = "" if ws else "need_workspace"
    if cap.get("reason"):
        reason = cap["reason"]
    return _json({"available": not reason, "hidden": False, "reason": reason, "checked": bool(cap), "workspace": ws,
                  "target": {k: tgt.get(k, "") for k in ("teamspace", "parent_id", "parent_title", "path")} if tgt.get("parent_id") else None})


def _teamspaces(request: Request):
    a, user, pod = _who(request, write=False, pod_id=_q(request, "pod"), profile=_q(request, "profile"))
    ws = _workspace(user, pod, _q(request, "profile"))
    token = _token(a, request)
    cap = ms.capabilities(token, ws)                                  # 위치 고르기를 열 때 한 번 확인한다(설치 단위로 기억)
    if cap.get("reason"):
        raise _Fail(cap["reason"], 409 if cap["reason"] != "old_mindwiki" else 501)
    return _json({"teamspaces": ms.teamspaces(token, ws)})


def _pages(request: Request):
    a, user, pod = _who(request, write=False, pod_id=_q(request, "pod"), profile=_q(request, "profile"))
    ws = _workspace(user, pod, _q(request, "profile"))
    return _json(ms.pages(_token(a, request), ws, parent=_q(request, "parent"), teamspace=_q(request, "teamspace"), q=_q(request, "q")))


def _body(request: Request) -> dict:
    raw = anyio.from_thread.run(request.body)
    if len(raw) > MAX_BODY:
        raise _Fail("invalid", 413)
    try:
        body = json.loads(raw or b"{}")
    except ValueError:
        raise _Fail("invalid", 400) from None
    if not isinstance(body, dict):
        raise _Fail("invalid", 400)
    return body


def _set_target(request: Request):
    body = _body(request)
    profile = str(body.get("profile") or "")
    _a, user, pod = _who(request, write=True, pod_id=str(body.get("pod") or ""), profile=profile)
    ws = _workspace(user, pod, profile)
    parent = str(body.get("parent_id") or "")
    if not parent:
        raise _Fail("need_target", 400)
    tgt = ms.set_target(str(user.get("sub") or ""), pod.id, profile, workspace=ws, teamspace=str(body.get("teamspace") or ""),
                        parent_id=parent, parent_title=str(body.get("parent_title") or ""), path=str(body.get("path") or ""))
    return _json({"ok": True, "target": {k: tgt.get(k, "") for k in ("teamspace", "parent_id", "parent_title", "path")}})


def _parent_of(body: dict, user, pod, profile: str, ws: str) -> str:
    parent = str(body.get("parent_id") or "")
    if parent:
        return parent
    tgt = ms.target(str(user.get("sub") or ""), pod.id, profile) or {}
    if tgt.get("workspace") != ws or not tgt.get("parent_id"):
        raise _Fail("need_target", 409)
    return str(tgt["parent_id"])


def _key(body: dict) -> str:
    key = str(body.get("key") or "").strip()
    if not key or len(key) > 200:
        raise _Fail("invalid", 400)
    return key


def _save_answer(request: Request):
    body = _body(request)
    profile = str(body.get("profile") or "")
    a, user, pod = _who(request, write=True, pod_id=str(body.get("pod") or ""), profile=profile)
    ws = _workspace(user, pod, profile)
    parent = _parent_of(body, user, pod, profile, ws)
    # 설치 값 AAS_PUBLIC_URL 이 먼저다 — ingress 뒤에서 request.base_url 은 http:// 였다(OKE 2026-11-15, 「대화 열기」 링크)
    base = (config.get("AAS_PUBLIC_URL", "") or str(request.base_url)).rstrip("/")
    out = ms.save_answer(_token(a, request), ws, parent=parent, title=str(body.get("title") or ""), markdown=str(body.get("markdown") or ""),
                         key=_key(body), agent=str(body.get("agent") or profile)[:80], aas_url=base)
    store.log_usage("mindwiki_save", f"{profile} answer {out['page_id']}", pod=pod.id)
    return _json({"ok": True, **out})


def _save_file(request: Request):
    body = _body(request)
    profile = str(body.get("profile") or "")
    a, user, pod = _who(request, write=True, pod_id=str(body.get("pod") or ""), profile=profile)
    path = str(body.get("path") or "")
    if not wsp.in_workspace(path):
        raise _Fail("invalid", 400)
    ws = _workspace(user, pod, profile)
    parent = _parent_of(body, user, pod, profile, ws)
    token = _token(a, request)
    wsx = server.workspace_for(pod)
    if wsx is None or not wsx.supported():
        raise _Fail("agent_unreachable", 501)
    if not files.SLOTS.take():
        raise _Fail("busy", 429)
    try:
        try:
            status, code, resp, conn = wsx.backend.open_download(path)
        except OSError:
            raise _Fail("agent_unreachable", 502) from None
        try:
            if status != 200:
                raise _Fail({"missing": "not_found"}.get(code, code or "not_file"), status if status < 500 else 502)
            name = urllib.parse.unquote(resp.getheader("X-File-Name") or path.rsplit("/", 1)[-1])
            length = int(resp.getheader("Content-Length") or 0)
            if length <= 0:
                raise _Fail("not_file", 400)
            out = ms.save_file(token, ws, parent=parent, name=name, stream=resp, length=length, key=_key(body))
        finally:
            conn.close()
    finally:
        files.SLOTS.give()
    store.log_usage("mindwiki_save", f"{profile} file {out['page_id']}", pod=pod.id)
    return _json({"ok": True, **out})


def routes() -> list:
    return [Route("/api/mindwiki/save/state", _run(_state), methods=["GET"]),
            Route("/api/mindwiki/save/teamspaces", _run(_teamspaces), methods=["GET"]),
            Route("/api/mindwiki/save/pages", _run(_pages), methods=["GET"]),
            Route("/api/mindwiki/save/target", _run(_set_target), methods=["PUT"]),
            Route("/api/mindwiki/save/answer", _run(_save_answer), methods=["POST"]),
            Route("/api/mindwiki/save/file", _run(_save_file), methods=["POST"])]

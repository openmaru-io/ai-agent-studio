# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""「MindWiki 에 저장」 경로(스펙 2026-11-15-002 A4·D11·D19). 일은 aas.ops.mindwiki_save 가 한다.

- GET  /api/mindwiki/save/state?pod=&profile=        단추를 보일지·막을지와 기억한 저장 위치·최근 위치 다섯(recent, 지금 연결 워크스페이스만)
                                                     (Keycloak 을 부르지 않는다, 기억한 확인만)
- GET  /api/mindwiki/save/teamspaces?pod=&profile=   위치 고르기: 팀스페이스
- GET  /api/mindwiki/save/pages?pod=&profile=&parent=&teamspace=&q=   위치 고르기: 페이지(제목·id·경로만)
- PUT  /api/mindwiki/save/target                     저장 위치 기억
- POST /api/mindwiki/save/answer                     답 하나를 새 하위 페이지로
- POST /api/mindwiki/save/file                       대화 파일 하나를 「AAS 파일」 페이지에 첨부
- POST /api/mindwiki/save/create                     고르기 창의 「새 페이지」·「새 데이터베이스」(스펙 2026-11-23-019 P3·P4·P8)

저장 위치 종류 kind: page(하위 페이지)·database(새 행)·teamspace(맨 위). page 가 아니면 MindWiki 연결 경로 판 2 이상이어야 한다 —
기억한 판이 낮으면 MindWiki 를 부르지 않고 409 need_upgrade(서버마다 판 기억이 달라도 옛 MindWiki 에 kind 를 보내지 않게, 리뷰 Eng M5).

MindWiki 를 함께 설치하지 않은 곳(AAS_MINDWIKI_URL 없음)에서는 state 가 hidden·no_mindwiki 이고 다른 경로는 409 no_mindwiki 다
(스펙 2026-11-23-019 G1). 검사 순서는 로그인 → no_mindwiki → no_keycloak → 주인. 요청 키는 서버가 만든다(ms.save_key, 리뷰 Eng H2).

권한: 로그인한 프로파일 주인만(관리자도 남의 작업공간 대화는 저장하지 못한다, 2026-11-14-001 과 같은 규칙). 위젯 토큰은 이 경로를 부를 수
없고(aas/auth/embed.py 의 허용 경로 밖, D19), Keycloak 로그인을 쓰지 않는 설치(비밀번호 로그인)에서는 no_keycloak 이다.
쓰기는 X-AAS·같은 출처를 본다. 사용 기록 usage 에 mindwiki_save(<프로파일> <종류> <page_id>)를 남기고 본문은 남기지 않는다.
"""
from __future__ import annotations

import json
import logging
import urllib.parse

import anyio
from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.routing import Route

from ..common import config, store
from ..hermes import workspace as wsp
from ..ops import mcp_servers
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
    """(auth, user, pod). 순서: 로그인 → no_mindwiki → no_keycloak → 주인(스펙 2026-11-23-019 G1, 리뷰 Eng L-b).
    로그인하지 않은 요청에는 늘 로그인 오류가 먼저 간다. 숨김(no_mindwiki)과 no_keycloak 은 같은 409 라 화면은 이유 코드로 가른다."""
    view = files._View(request)
    if not view._host_ok() or (write and not view._same_origin()):
        raise _Fail("forbidden", 403)
    a = server.auth()
    user = server.request_user(a, request) if a.enabled else None
    if a.enabled and not user:
        raise _Fail("session_ended", 401)
    if not mcp_servers.mindwiki_url():
        raise _Fail("no_mindwiki", 409)
    if not a.enabled or not a.oidc_enabled:
        raise _Fail("no_keycloak", 409)
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
        if f.reason in ("no_keycloak", "no_mindwiki"):
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
                  "target": {k: tgt.get(k, "") for k in ("teamspace", "parent_id", "parent_title", "path", "kind")} if tgt.get("parent_id") else None,
                  "recent": ms.recent(sub, pod.id, profile, ws)})


def _teamspaces(request: Request):
    a, user, pod = _who(request, write=False, pod_id=_q(request, "pod"), profile=_q(request, "profile"))
    ws = _workspace(user, pod, _q(request, "profile"))
    token = _token(a, request)
    cap = ms.capabilities(token, ws)                                  # 위치 고르기를 열 때 한 번 확인한다(설치 단위로 기억)
    if cap.get("reason"):
        raise _Fail(cap["reason"], 409 if cap["reason"] != "old_mindwiki" else 501)
    # 판 번호·새 데이터베이스 가능 여부를 함께 준다 — 화면이 판이 낮으면 데이터베이스·새로 만들기·팀스페이스 줄을 숨긴다(P7·W3·P5)
    return _json({"teamspaces": ms.teamspaces(token, ws), "save_level": int(cap.get("save_level") or 0),
                  "make_database": bool(cap.get("make_database"))})


def _pages(request: Request):
    a, user, pod = _who(request, write=False, pod_id=_q(request, "pod"), profile=_q(request, "profile"))
    ws = _workspace(user, pod, _q(request, "profile"))
    return _json(ms.pages(_token(a, request), ws, parent=_q(request, "parent"), teamspace=_q(request, "teamspace"), q=_q(request, "q"),
                          kinds=ms.save_level() >= 2))


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
                        parent_id=parent, parent_title=str(body.get("parent_title") or ""), path=str(body.get("path") or ""),
                        kind=_kind(body.get("kind")))
    return _json({"ok": True, "target": {k: tgt.get(k, "") for k in ("teamspace", "parent_id", "parent_title", "path", "kind")}})


def _kind(v) -> str:
    k = str(v or "page")
    if k not in ms.KINDS:
        raise _Fail("invalid", 400)
    return k


def _parent_of(body: dict, user, pod, profile: str, ws: str) -> tuple[str, str, dict]:
    """(부모 id, 위치 종류, 최근 줄의 제목·경로·팀스페이스). 본문에 없으면 기억한 위치. page 가 아닌데 판이 낮으면 need_upgrade(MindWiki 를 부르기 전).
    제목·경로는 화면이 보낸 값(parent_title·parent_path·teamspace)을 쓰고, 옛 화면이라 없으면 기억한 위치가 같은 부모일 때 그 값을, 아니면 빈 값(id 만)."""
    parent, kind = str(body.get("parent_id") or ""), _kind(body.get("kind"))
    tgt = ms.target(str(user.get("sub") or ""), pod.id, profile) or {}
    if tgt.get("workspace") != ws:
        tgt = {}
    if not parent:
        if not tgt.get("parent_id"):
            raise _Fail("need_target", 409)
        parent, kind = str(tgt["parent_id"]), _kind(tgt.get("kind"))
    if kind != "page" and ms.save_level() < 2:
        raise _Fail("need_upgrade", 409)                  # 이 실패에서는 기억 위치를 지우지 않는다(리뷰 Eng M5)
    mine = tgt if tgt.get("parent_id") == parent else {}
    # 위치 경로는 parent_path 다 — 파일 저장의 path 는 파일 경로라 이름을 나눈다
    meta = {"title": str(body.get("parent_title") or mine.get("parent_title") or ""), "path": str(body.get("parent_path") or mine.get("path") or ""),
            "teamspace": str(body.get("teamspace") or mine.get("teamspace") or "")}
    return parent, kind, meta


def _gone(user, pod, profile: str, parent: str, err: ms.SaveError) -> None:
    """위치가 지워졌거나 권한을 잃었으면 기억 위치와 그 최근 줄을 지운다(R3). row_rejected 는 데이터베이스가 그대로라 지우지 않는다(P6).
    need_upgrade 는 MindWiki 를 부르기 전에 나므로 여기 오지 않는다."""
    if err.reason in ("parent_not_found", "forbidden_parent"):
        sub = str(user.get("sub") or "")
        ms.forget_target_if(sub, pod.id, profile, parent)
        ms.forget_recent(sub, pod.id, profile, parent)


def _remember_recent(user, pod, profile: str, ws: str, parent: str, kind: str, meta: dict) -> None:
    """저장 성공 뒤 최근 줄(R2). 「이 위치 기억」과 관계없다. MindWiki 에는 이미 저장됐으므로 이 표 쓰기가 실패해도 저장 결과는 그대로 준다(로그만)."""
    try:
        ms.add_recent(str(user.get("sub") or ""), pod.id, profile, workspace=ws, parent_id=parent, kind=kind, **meta)
    except Exception:  # noqa: BLE001 — 저장은 끝났다. 같은 키로 다시 누르면 같은 결과가 오므로 오류로 돌려주지 않는다
        logging.getLogger("aas.web").warning("mindwiki recent not recorded pod=%s", pod.id, exc_info=True)


def _answer_key(body: dict, pod, profile: str, parent: str, kind: str = "page") -> str:
    """(대화, 메시지)로 서버가 키를 만든다. 옛 화면이 key 만 보내면 그 값을 대상으로 쓴다(올리는 동안 섞인 판)."""
    conv, msg = str(body.get("conversation") or "")[:200], str(body.get("message") or "")[:200]
    if not (conv and msg):
        old = str(body.get("key") or "").strip()
        if not old or len(old) > 400:
            raise _Fail("invalid", 400)
        conv, msg = "key", old
    return ms.save_key("answer", pod.id, profile, kind, parent, conv, msg)


def _save_answer(request: Request):
    body = _body(request)
    profile = str(body.get("profile") or "")
    a, user, pod = _who(request, write=True, pod_id=str(body.get("pod") or ""), profile=profile)
    ws = _workspace(user, pod, profile)
    parent, kind, meta = _parent_of(body, user, pod, profile, ws)
    # 설치 값 AAS_PUBLIC_URL 이 먼저다 — ingress 뒤에서 request.base_url 은 http:// 였다(OKE 2026-11-15, 「대화 열기」 링크)
    base = (config.get("AAS_PUBLIC_URL", "") or str(request.base_url)).rstrip("/")
    try:
        out = ms.save_answer(_token(a, request), ws, parent=parent, title=str(body.get("title") or ""), markdown=str(body.get("markdown") or ""),
                             key=_answer_key(body, pod, profile, parent, kind), agent=str(body.get("agent") or profile)[:80], aas_url=base, kind=kind)
    except ms.SaveError as e:
        _gone(user, pod, profile, parent, e)
        raise
    _remember_recent(user, pod, profile, ws, parent, kind, meta)
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
    parent, kind, meta = _parent_of(body, user, pod, profile, ws)
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
            # 같은 경로라도 크기·수정 시각이 다르면(에이전트가 고쳐 다시 만듦) 새로 올린다. 같은 파일을 두 번 누르면 한 번만(리뷰 Eng H2 회귀 계약)
            key = ms.save_key("file", pod.id, profile, kind, parent, path, length, resp.getheader("Last-Modified") or "")
            try:
                out = ms.save_file(token, ws, parent=parent, name=name, stream=resp, length=length, key=key, kind=kind)
            except ms.SaveError as e:
                _gone(user, pod, profile, parent, e)
                raise
        finally:
            conn.close()
    finally:
        files.SLOTS.give()
    _remember_recent(user, pod, profile, ws, parent, kind, meta)
    store.log_usage("mindwiki_save", f"{profile} file {out['page_id']}", pod=pod.id)
    return _json({"ok": True, **out})


def _create(request: Request):
    """「새 페이지」·「새 데이터베이스」. 화면이 「만들기」를 누를 때마다 새 nonce, 다시 보낼 때만 같은 값(P8).
    결과를 모르는 실패(시간 초과·503·in_progress)는 서버만 같은 키로 한 번 다시 보낸다 — 화면은 다시 보내지 않는다(리뷰 Eng M4)."""
    body = _body(request)
    profile = str(body.get("profile") or "")
    a, user, pod = _who(request, write=True, pod_id=str(body.get("pod") or ""), profile=profile)
    ws = _workspace(user, pod, profile)
    make, parent_kind = str(body.get("make") or ""), str(body.get("parent_kind") or "page")
    parent, nonce = str(body.get("parent_id") or ""), str(body.get("nonce") or "")[:64]
    if make not in ("page", "database") or parent_kind not in ("page", "teamspace") or not parent or not nonce:
        raise _Fail("invalid", 400)
    if ms.save_level() < 2:
        raise _Fail("need_upgrade", 409)
    if make == "database" and not (ms.cached_capabilities() or {}).get("make_database"):
        raise _Fail("need_upgrade", 409)                  # MindWiki 가 새 데이터베이스를 허락하지 않았다(W3 보안 승인 전)
    token = _token(a, request)
    key = ms.save_key("make", pod.id, profile, make, parent, nonce)
    for attempt in (1, 2):
        try:
            out = ms.create_location(token, ws, make=make, parent=parent, parent_kind=parent_kind, title=str(body.get("title") or ""), key=key)
            break
        except ms.SaveError as e:
            if attempt == 2 or e.reason not in ("timeout", "mindwiki_5xx", "in_progress"):
                raise
    store.log_usage("mindwiki_save", f"{profile} create {make} {out['id']}", pod=pod.id)
    return _json({"ok": True, **out})


def routes() -> list:
    return [Route("/api/mindwiki/save/state", _run(_state), methods=["GET"]),
            Route("/api/mindwiki/save/teamspaces", _run(_teamspaces), methods=["GET"]),
            Route("/api/mindwiki/save/pages", _run(_pages), methods=["GET"]),
            Route("/api/mindwiki/save/target", _run(_set_target), methods=["PUT"]),
            Route("/api/mindwiki/save/answer", _run(_save_answer), methods=["POST"]),
            Route("/api/mindwiki/save/file", _run(_save_file), methods=["POST"]),
            Route("/api/mindwiki/save/create", _run(_create), methods=["POST"])]

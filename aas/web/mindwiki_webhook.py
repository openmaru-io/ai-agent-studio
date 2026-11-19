# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""POST /api/mindwiki/webhook — MindWiki 자동화 「AAS 에이전트에게 맡기기」(스펙 2026-11-15-002 A5). 계산은 aas.ops.mindwiki_webhook.

로그인·CSRF 검사 없이 HMAC 서명으로만 받는다(레거시 Mount 앞, Starlette 경로는 스스로 인증한다). 응답 본문은
{type, title, status, reason, card_id?, trace_id}. 상태 표는 스펙 A5: 202 ok·blocked_no_write_token, 200 다시 받음, 401 bad_signature·
stale_timestamp, 503 webhook_disabled·hermes_not_ready, 422 no_agent·author_daily_limit·install_daily_limit·invalid, 413 too_large,
500 internal. 429 는 쓰지 않는다(D22).
"""
from __future__ import annotations

import threading
import traceback

import anyio
from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.routing import Route

from ..common import store
from ..fleet import primary
from ..hermes.hermes_api import HermesAPI, HermesError
from ..ops import mindwiki_connect
from ..ops import mindwiki_webhook as mw
from . import server

PATH = "/api/mindwiki/webhook"
_BOARDS: set = set()                     # 보드를 만든 파드(프로세스 기억) — 카드마다 보드를 다시 만들지 않는다


def _answer(status: int, reason: str, trace: str, **extra) -> JSONResponse:
    body = {"type": "mindwiki_webhook", "title": reason, "status": status, "reason": reason, "trace_id": trace, **extra}
    return JSONResponse(body, status_code=status, headers={"Cache-Control": "no-store"})


async def _read(request: Request) -> bytes:
    """Content-Length 를 먼저 보고, 본문은 흘려 읽으며 256 KiB 를 넘는 순간 끊는다(chunked·거짓 길이도)."""
    try:
        if int(request.headers.get("content-length") or 0) > mw.MAX_BODY:
            raise mw.Reject(413, "too_large")
    except ValueError:
        raise mw.Reject(413, "too_large") from None
    got = bytearray()
    async for chunk in request.stream():
        got += chunk
        if len(got) > mw.MAX_BODY:
            raise mw.Reject(413, "too_large")
    return bytes(got)


def _pod_of(sub: str, email: str):
    """작성자의 주 작업공간 파드. 주인 sub 가 비어 있는 파드는 이메일로 찾는다(리뷰 Eng F5)."""
    user = {"sub": sub, "email": email}
    owned = [p for p in list(server.registry().pods) if p.owned_by(user)]
    if not owned:
        return None
    for p in owned:
        if primary.primary_of(p.id):
            return p
    return owned[0]


def _not_ready(exc: HermesError) -> bool:
    return getattr(exc, "code", 0) in (0, 502, 503, 504)


_MAKING: set = set()                     # 뒤에서 만드는 중인 (파드, 프로파일)
_MAKING_LOCK = threading.Lock()


def _has_profile(api: HermesAPI, name: str) -> bool:
    return any(isinstance(r, dict) and r.get("name") == name for r in api.call("GET", "/api/profiles").get("profiles", []))


def _make_profile(api: HermesAPI, pod_id: str, name: str, web: bool) -> None:
    """뒤 작업: 자동화 전용 프로파일을 만들고 도구 묶음을 맞춘다. Hermes 의 프로파일 만들기는 10초를 넘길 수 있어
    웹훅 답을 기다리게 하지 않는다 — MindWiki 의 웹훅 제한 시간이 10초다(OKE 2026-11-15, 첫 웹훅이 약 11초)."""
    try:
        if not _has_profile(api, name):
            # i18n-ignore: Hermes 프로파일 설명(사람이 프로파일 목록에서 본다) — 설치 언어와 관계없이 한 줄로 둔다
            desc = "MindWiki 자동화 전용. MindWiki 쓰기는 자동화 실행의 대상에만 된다" + (" · 웹 조사" if web else "")
            api.call("POST", "/api/profiles", {"name": name, "clone_from": None, "no_skills": True, "description": desc})
        _sync_toolsets(api, name, web)
    except Exception:  # noqa: BLE001 — 다음 웹훅이 다시 만든다
        print(f"mindwiki webhook profile pod={pod_id} profile={name}\n{traceback.format_exc()}", flush=True)   # i18n-ignore: 서버 로그
    finally:
        with _MAKING_LOCK:
            _MAKING.discard((pod_id, name))


def _start_making(api: HermesAPI, pod_id: str, name: str, web: bool) -> None:
    with _MAKING_LOCK:
        if (pod_id, name) in _MAKING:
            return
        _MAKING.add((pod_id, name))
    threading.Thread(target=_make_profile, args=(api, pod_id, name, web), name=f"mindwiki-auto-{name}", daemon=True).start()


def _sync_toolsets(api: HermesAPI, name: str, web: bool) -> None:
    """도구 묶음 맞추기(D20): 웹(켠 경우)만 남기고 끈다. 카드를 만들 때마다 한다 — 사람이 켠 도구도 다시 끈다."""
    rows = api.call("GET", "/api/tools/toolsets", None, {"profile": name})
    rows = rows.get("toolsets", rows) if isinstance(rows, dict) else rows
    for tool, on in mw.toolset_changes(rows, web):
        api.call("PUT", f"/api/tools/toolsets/{tool}", {"enabled": on, "profile": name}, {"profile": name})


def _write_ready(sub: str, pod: str, profile: str) -> bool:
    """그 프로파일에 MindWiki 쓰기 연결이 있고 끝나지 않았나. AAS 는 토큰을 읽지 않고 connector_tokens 로 판단한다."""
    row = mindwiki_connect._row(sub, pod, profile) or {}
    if row.get("status") != "connected" or not row.get("write"):
        return False
    exp = mindwiki_connect._parse(row.get("expires_at") or "")
    return exp is None or exp > mindwiki_connect._now()


def _deliver(w: dict, install: str, delivery: str) -> tuple[int, str, str]:
    """(상태, 이유, 카드 id)."""
    pod = _pod_of(w["sub"], w["email"])
    if pod is None:
        return 422, "no_agent", ""
    profile = mw.profile_for(w["web"])
    api = HermesAPI(server.hub(pod).auth)
    try:
        if not _has_profile(api, profile):
            # 프로파일이 없으면 쓰기 연결도 없다 — 만들기는 뒤로 돌리고 곧바로 「막힘」으로 답한다
            _start_making(api, pod.id, profile, w["web"])
            mindwiki_connect.want_auto(w["sub"], pod.id, profile, w["workspace"])
            return 202, "blocked_no_write_token", ""
        _sync_toolsets(api, profile, w["web"])
        if not _write_ready(w["sub"], pod.id, profile):
            mindwiki_connect.want_auto(w["sub"], pod.id, profile, w["workspace"])   # 다음 로그인 때 자동 첫 연결이 잇는다(자동화 전용 토큰)
            return 202, "blocked_no_write_token", ""
        if pod.id not in _BOARDS:
            try:
                # i18n-ignore: Hermes 에 저장되는 보드 이름
                api.call("POST", "/api/plugins/kanban/boards", {"slug": mw.BOARD, "name": "MindWiki 자동화", "description": "MindWiki 자동화 카드"})
            except HermesError as exc:
                if _not_ready(exc):
                    raise
            _BOARDS.add(pod.id)
        c = mw.card(w, install, delivery)
        res = api.call("POST", "/api/plugins/kanban/tasks", {**c, "assignee": profile}, {"board": mw.BOARD})
    except HermesError as exc:
        if _not_ready(exc):
            return 503, "hermes_not_ready", ""
        raise
    tid = str((res.get("task") or res).get("id") or "") if isinstance(res, dict) else ""
    if not tid:
        return 503, "hermes_not_ready", ""
    return 202, "ok", tid


async def receive(request: Request):
    trace = mw.trace_id()
    try:
        if not mw.enabled():
            raise mw.Reject(503, "webhook_disabled")
        body = await _read(request)
        headers = {k.lower(): v for k, v in request.headers.items()}
        install, delivery = mw.verify(headers, body)
        w = mw.parse(body)
        done = await anyio.to_thread.run_sync(mw.begin, install, delivery, w["sub"])
        if done is not None:
            return _answer(200, done["reason"] or "ok", trace, card_id=done["card_id"] or None)
        try:
            status, reason, tid = await anyio.to_thread.run_sync(_deliver, w, install, delivery)
        except Exception:
            await anyio.to_thread.run_sync(mw.release, install, delivery)
            raise
        if status >= 500:
            await anyio.to_thread.run_sync(mw.release, install, delivery)
        if status < 300 or status == 422:
            await anyio.to_thread.run_sync(mw.finish, install, delivery, tid, reason)     # 막힘·없음도 한도에 센 그대로 끝낸다
            store.log_usage("mindwiki_webhook_card", f"{mw.profile_for(w['web'])} {reason} {tid}".strip())
        return _answer(status, reason, trace, **({"card_id": tid} if tid else {}))
    except mw.Reject as r:
        extra = {"detail": r.detail} if r.reason == "stale_timestamp" and r.detail else {}
        return _answer(r.status, r.reason, trace, **extra)
    except Exception:  # noqa: BLE001 — MindWiki 가 다시 보내고 delivery 로 겹치지 않는다
        print(f"mindwiki webhook internal trace={trace}\n{traceback.format_exc()}", flush=True)   # i18n-ignore: 서버 로그
        return _answer(500, "internal", trace)


def routes() -> list:
    return [Route(PATH, receive, methods=["POST"])]

# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""위젯 답 저장 경로(스펙 cogentai-aas-docs security/chat-embed-save-answer 2026-11-18-012). 검사·채우기는 aas.ops.answer_format.

위젯(임베드 토큰만, D5):
- GET  /api/chat/answer-format/info?format=<id> | ?pageSchema=1      형식 조회(D16)
- POST /api/chat/answer-format/fill?pod=<id>                         답을 형식대로 채운다(D6·D7·D24)
- POST /api/chat/answer-format/outcome?pod=<id>                      판을 닫을 때의 결과(D20·D25①)

관리자(본 화면 쿠키, D17):
- GET·POST /api/admin/embed-apps/<app>/formats, PUT·DELETE …/formats/<id>, POST …/formats/<id>/try, POST …/formats-try
- PUT /api/admin/embed-apps/<app>/formats-settings {page_schema}       「페이지가 형식을 넘길 수 있음」

임베드 토큰은 미들웨어(embed_routes)가 확인해 principal 로 넣고 쿠키를 떼므로, 위젯 경로는 via=embed 인 principal 만 받는다.
/api/admin/* 는 임베드 토큰이 401 이다(embed.path_allowed). 오류 본문은 RFC 9457 꼴 {type, code, title, detail, instance, retry_after?}.
사용 기록에는 본문·스키마를 남기지 않는다(D11).
"""
from __future__ import annotations

import json
import re
import threading
import time
import uuid
from datetime import datetime, timedelta, timezone

import anyio
from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.routing import Route

from ..auth import embed, mcp_limits
from ..common import config, store
from ..common.i18n import tr
from ..ops import answer_format as af
from ..ops import cron_health
from . import files, server

BODY_MAX = 256 * 1024                 # D7
PER_MIN_DEFAULT = 5                   # D7, AAS_EMBED_FORMAT_PER_MIN
ADMIN_PER_MIN = 20                    # D17
CONCURRENCY_DEFAULT = 8               # D7, AAS_EMBED_FORMAT_CONCURRENCY
OUTCOMES = ("saved", "cancelled", "save_failed")
SOURCES = ("registered", "page", "none")
EDITED_MAX = 10_000

_TITLES = {
    "format.not_found": lambda: tr("저장 형식이 없습니다", "Save format not found"),
    "format.page_schema_off": lambda: tr("이 사이트는 페이지 형식을 쓸 수 없습니다", "This site cannot send its own format"),
    "format.forbidden": lambda: tr("이 요청으로는 저장 형식을 쓸 수 없습니다", "This request cannot use save formats"),
    "format.schema_invalid": lambda: tr("저장 형식이 잘못되었습니다", "The save format is not valid"),
    "format.too_deep": lambda: tr("저장 형식이 너무 크거나 깊습니다", "The save format is too large or too deep"),
    "format.rate_limited": lambda: tr("잠시 뒤 다시 하세요", "Try again shortly"),
    "format.rate_limited_admin": lambda: tr("잠시 뒤 다시 하세요", "Try again shortly"),
    "format.busy": lambda: tr("잠시 뒤 다시 하세요", "Try again shortly"),
    "format.fill_llm": lambda: tr("모델이 형식대로 답하지 못했습니다", "The model did not answer in the format"),
    "format.fill_guardrail": lambda: tr("가드레일이 요청을 막았습니다", "The guardrail blocked the request"),
    "format.fill_timeout": lambda: tr("채우기가 시간 안에 끝나지 않았습니다", "Filling did not finish in time"),
    "format.too_large": lambda: tr("요청이 너무 큽니다", "The request is too large"),
    "format.text_too_long": lambda: tr("글이 너무 깁니다", "The text is too long"),
    "format.bad_request": lambda: tr("요청을 처리할 수 없습니다", "The request cannot be processed"),
    "format.id_invalid": lambda: tr("형식 id 는 영문 소문자·숫자·- 만 씁니다", "Use lowercase letters, digits and - in the format id"),
    "format.id_reserved": lambda: tr("이 형식 id 는 쓸 수 없습니다", "This format id is reserved"),
    "format.id_exists": lambda: tr("같은 id 의 형식이 있습니다", "A format with this id exists"),
    "format.admin_only": lambda: tr("관리자만 할 수 있습니다", "Only an admin can do this"),
}


class _Fail(Exception):
    def __init__(self, code: str, status: int, **extra):
        super().__init__(code)
        self.code, self.status, self.extra = code, status, extra


def _rid() -> str:
    return uuid.uuid4().hex[:16]


def _problem(code: str, status: int, rid: str, **extra) -> JSONResponse:
    title = _TITLES.get(code, _TITLES["format.bad_request"])()
    body = {"type": "about:blank", "code": code, "title": title, "status": status, "instance": rid, "requestId": rid}
    body.update({k: v for k, v in extra.items() if v is not None})
    headers = {"Cache-Control": "no-store", "X-Request-Id": rid}
    if "retry_after" in extra:
        headers["Retry-After"] = str(extra["retry_after"])
    return JSONResponse(body, status_code=status, media_type="application/problem+json", headers=headers)


def _ok(data: dict, rid: str) -> JSONResponse:
    return JSONResponse({**data, "requestId": rid}, headers={"Cache-Control": "no-store", "X-Request-Id": rid})


def _note_value(v) -> str:
    """D25①: 사용 기록 note 에 들어가는 값. 영문 소문자·숫자·-·_ 만 남기고 64자로 자른다(D15 가 note 를 갈라 센다)."""
    return re.sub(r"[^a-z0-9_.-]", "", str(v or "").lower())[:64] or "-"


def _int_env(name: str, default: int) -> int:
    try:
        return max(1, int(config.get(name, str(default)) or default))
    except ValueError:
        return default


def per_minute() -> int:
    return _int_env("AAS_EMBED_FORMAT_PER_MIN", PER_MIN_DEFAULT)


_slots_lock = threading.Lock()
_slots: threading.BoundedSemaphore | None = None
_thread_limiter: anyio.CapacityLimiter | None = None


def _slots_now() -> tuple[threading.BoundedSemaphore, anyio.CapacityLimiter]:
    """채우기 전용 동시 자리(D24②). 자리는 스레드가 끝날 때 놓는다 — 504 를 먼저 돌려줘도 LLM 호출이 끝날 때까지 쥔다.
    스레드도 전용 한도에서 돌려 기본 스레드 한도(화면 요청용)를 쓰지 않는다."""
    global _slots, _thread_limiter
    with _slots_lock:
        if _slots is None:
            n = _int_env("AAS_EMBED_FORMAT_CONCURRENCY", CONCURRENCY_DEFAULT)
            _slots, _thread_limiter = threading.BoundedSemaphore(n), anyio.CapacityLimiter(n)
        return _slots, _thread_limiter


def _retry_after(now: float | None = None) -> int:
    now = time.time() if now is None else now
    return max(1, 60 - int(now % 60))


async def _read_body(request: Request) -> dict:
    """D24①: Content-Length 를 먼저 보고, 없으면 스트림을 세며 읽다가 256KB 를 넘으면 413."""
    length = request.headers.get("content-length", "")
    if length.isdigit() and int(length) > BODY_MAX:
        raise _Fail("format.too_large", 413)
    chunks, size = [], 0
    async for chunk in request.stream():
        size += len(chunk)
        if size > BODY_MAX:
            raise _Fail("format.too_large", 413)
        chunks.append(chunk)
    try:
        body = json.loads(b"".join(chunks) or b"{}")
    except ValueError:
        raise _Fail("format.bad_request", 400) from None
    if not isinstance(body, dict):
        raise _Fail("format.bad_request", 400)
    return body


# ---- 위젯 경로 -------------------------------------------------------------------------------------------------

def _widget(request: Request) -> tuple[dict, dict]:
    """(principal, 앱). 임베드 토큰 요청(via=embed, embed_app)만 받는다(D5). 본 화면 쿠키·MCP 토큰은 403 not_embed."""
    p = (getattr(request, "scope", None) or {}).get(server.PRINCIPAL_KEY)
    user = (p or {}).get("user") or {}
    if not p or user.get("via") != "embed" or not user.get("embed_app"):
        raise _Fail("format.forbidden", 403, detail={"reason": "not_embed"})
    app = embed.get_app(str(user["embed_app"]))
    if app is None:
        raise _Fail("format.forbidden", 403, detail={"reason": "not_embed"})
    return p, app


def _pod_profile(p: dict, profile: str):
    """D6②: 그 작업공간에서 대화할 수 있는 사람인가(채팅 경로와 같은 검사)."""
    a = server.auth()
    pod = server._chat_pod(a, p["user"], str(p.get("pod") or ""))
    if pod is None:
        raise _Fail("format.forbidden", 403, detail={"reason": "pod"})
    name = server._chat_profile(pod, str(profile or "")[:120])
    if name not in {x.name for x in cron_health.hr.profiles(pod.hermes_home)}:
        raise _Fail("format.forbidden", 403, detail={"reason": "profile"})
    return pod, name


def _info(request: Request) -> dict:
    _p, app = _widget(request)
    if request.query_params.get("pageSchema") == "1":
        return {"page_schema": bool(app.get("page_schema"))}
    fmt = embed.get_format(app["app_id"], str(request.query_params.get("format") or "")[:64])
    if fmt is None:
        raise _Fail("format.not_found", 404)
    return {"label": fmt["label"], "version": fmt["version"], "schemaHash": af.schema_hash(fmt["schema"])}


def _str(body: dict, key: str) -> str:
    v = body.get(key)
    if v is None:
        return ""
    if not isinstance(v, str):
        raise _Fail("format.bad_request", 400, detail={"field": key})
    return v


def _prepare_fill(request: Request, body: dict) -> dict:
    """D24① 순서의 앞부분(한도 앞까지): 앱·형식 → 작업공간·프로파일 → 본문 꼴·스키마. 실패는 한도를 쓰지 않는다."""
    p, app = _widget(request)
    has_format, has_schema = body.get("format") not in (None, ""), body.get("schema") is not None
    if has_format == has_schema:
        raise _Fail("format.bad_request", 400, detail={"field": "format"})
    if has_format:
        fmt = embed.get_format(app["app_id"], _str(body, "format")[:64])
        if fmt is None:
            raise _Fail("format.not_found", 404)
        source, schema, instructions = "registered", fmt["schema"], fmt["instructions"]
    else:
        if not app.get("page_schema"):
            raise _Fail("format.page_schema_off", 403)
        fmt, source, schema = None, "page", body.get("schema")
        instructions = _str(body, "instructions")
        if len(instructions) > af.INSTRUCTIONS_MAX:
            raise _Fail("format.text_too_long", 400, detail={"field": "instructions"})
    _pod, profile = _pod_profile(p, _str(body, "profile"))
    markdown = _str(body, "markdown")
    if not markdown.strip():
        raise _Fail("format.bad_request", 400, detail={"field": "markdown"})
    length = body.get("markdownLength")
    if length is not None and (not isinstance(length, int) or isinstance(length, bool) or length < 0):
        raise _Fail("format.bad_request", 400, detail={"field": "markdownLength"})
    question = _str(body, "question")
    context = body.get("context")
    if context is not None and not isinstance(context, dict):
        raise _Fail("format.bad_request", 400, detail={"field": "context"})
    if source == "page":
        code, errors = af.check_schema(schema)
        if code:
            raise _Fail(code, 400, errors=errors)
    return {"user": p["user"], "app": app, "fmt": fmt, "source": source, "schema": schema, "instructions": instructions,
            "markdown": markdown, "length": max(length or 0, len(markdown)), "question": question, "context": context,
            "profile": profile}


def _log_fill(job: dict, code: str, rid: str) -> None:
    fid = job["fmt"]["id"] if job["fmt"] else "page"
    store.log_usage("embed_format_fill", f"app={_note_value(job['app']['app_id'])} format={_note_value(fid)} source={job['source']} "
                                         f"chars={int(job['length'])} code={_note_value(code)} req={rid}")


async def fill(request: Request):
    rid = _rid()
    job = None
    try:
        body = await _read_body(request)
        job = await anyio.to_thread.run_sync(lambda: _prepare_fill(request, body))
        email = str(job["user"].get("email") or "")
        if await anyio.to_thread.run_sync(mcp_limits.hit, f"fmt:{email}") > per_minute():
            raise _Fail("format.rate_limited", 429, retry_after=_retry_after())
        slots, limiter = _slots_now()
        if not slots.acquire(blocking=False):
            raise _Fail("format.busy", 429, retry_after=5)

        def work():
            try:
                return af.fill(job["schema"], source=job["source"], markdown=af.cut(job["markdown"], af.MARKDOWN_MAX),
                               instructions=job["instructions"], question=job["question"], context=job["context"])
            finally:
                slots.release()
        result = None
        with anyio.move_on_after(af.DEADLINE_S + 2):
            result = await anyio.to_thread.run_sync(work, abandon_on_cancel=True, limiter=limiter)
        if result is None:
            raise af.FormatError("format.fill_timeout", 504)
        result["truncated"] = result["truncated"] or job["length"] > af.MARKDOWN_MAX
    except _Fail as f:
        if job is not None and f.status not in (403, 429):
            await anyio.to_thread.run_sync(_log_fill, job, f.code, rid)
        return _problem(f.code, f.status, rid, **f.extra)
    except af.FormatError as e:
        await anyio.to_thread.run_sync(_log_fill, job, e.code, rid)
        detail = {"reason": e.reason} if e.reason else None
        return _problem(e.code, e.status, rid, detail=detail)
    await anyio.to_thread.run_sync(_log_fill, job, "ok_with_errors" if result["errors"] else "ok", rid)
    fmt = job["fmt"]
    return _ok({"payload": result["payload"], "errors": result["errors"], "truncated": result["truncated"],
                "format": fmt["id"] if fmt else None, "version": fmt["version"] if fmt else None,
                "schemaHash": af.schema_hash(job["schema"]), "source": job["source"], "schema": job["schema"],   # 위젯이 양식을 그리고 같은 규칙으로 검사한다
                "filledAt": datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")}, rid)


def _outcome(request: Request, body: dict) -> dict:
    """D20·D25①: 결과 종류와 고친 칸 수만. format 은 토큰 앱의 형식 id(지운 것 포함)·page(앱이 허용할 때)·none 중 하나."""
    p, app = _widget(request)
    fid, source, outcome, edited = body.get("format"), body.get("source"), body.get("outcome"), body.get("edited")
    if source not in SOURCES or outcome not in OUTCOMES:
        raise _Fail("format.bad_request", 400, detail={"field": "outcome"})
    if not isinstance(edited, int) or isinstance(edited, bool) or not 0 <= edited <= EDITED_MAX:
        raise _Fail("format.bad_request", 400, detail={"field": "edited"})
    if source == "registered":
        if not isinstance(fid, str) or embed.get_format(app["app_id"], fid, include_deleted=True) is None:
            raise _Fail("format.bad_request", 400, detail={"field": "format"})
    elif source == "page":
        if not app.get("page_schema"):
            raise _Fail("format.bad_request", 400, detail={"field": "format"})
        fid = "page"
    else:
        fid = "none"
    store.log_usage("embed_format_outcome", f"app={_note_value(app['app_id'])} format={_note_value(fid)} source={source} "
                                            f"outcome={outcome} edited={edited}")
    return {"ok": True}


def _sync(fn):
    async def handler(request: Request):
        rid = _rid()
        try:
            return _ok(await anyio.to_thread.run_sync(lambda: fn(request)), rid)
        except _Fail as f:
            return _problem(f.code, f.status, rid, **f.extra)
    return handler


def _with_body(fn, *, admin: bool = False):
    async def handler(request: Request):
        rid = _rid()
        try:
            if admin:
                await anyio.to_thread.run_sync(lambda: _admin(request, write=True))
            body = await _read_body(request)
            return _ok(await anyio.to_thread.run_sync(lambda: fn(request, body)), rid)
        except _Fail as f:
            return _problem(f.code, f.status, rid, **f.extra)
        except embed.FormatError as e:
            return _problem(e.code, e.status, rid, detail={"field": e.field} if e.field else None, errors=e.errors or None)
        except af.FormatError as e:
            return _problem(e.code, e.status, rid, detail={"reason": e.reason} if e.reason else None)
    return handler


# ---- 관리 경로 -------------------------------------------------------------------------------------------------

def _admin(request: Request, *, write: bool) -> dict:
    view = files._View(request)
    if not view._host_ok() or (write and not view._same_origin()):
        raise _Fail("format.forbidden", 403)
    a = server.auth()
    user = server.request_user(a, request)
    if a.enabled and not user:
        raise _Fail("format.forbidden", 401)
    if not server.registry().is_admin(user) and a.enabled:
        raise _Fail("format.admin_only", 403)
    return user or {}


def _app_id(request: Request) -> str:
    app_id = str(request.path_params.get("app") or "")
    if embed.get_app(app_id) is None:
        raise _Fail("format.not_found", 404, detail={"field": "app_id"})
    return app_id


def _warnings(schema: dict) -> list[dict]:
    """D22④: 경고(등록은 됨). title 없는 칸, maxLength 없는 문자열 칸."""
    out, stack = [], [(schema, "")]
    while stack:
        node, path = stack.pop()
        if not isinstance(node, dict):
            continue
        if path and "title" not in node:
            out.append({"path": path, "keyword": "title", "message": "no title: the form shows the key name"})
        types = node.get("type") if isinstance(node.get("type"), list) else [node.get("type")]
        if "string" in types and "maxLength" not in node and "enum" not in node and node.get("format") != "date-time":
            out.append({"path": path, "keyword": "maxLength", "message": "string without maxLength"})
        for k, sub in (node.get("properties") or {}).items() if isinstance(node.get("properties"), dict) else []:
            stack.append((sub, af._ptr(path, k)))
        if isinstance(node.get("items"), dict):
            stack.append((node["items"], path + "/items"))
    return sorted(out, key=lambda w: (w["path"], w["keyword"]))


def _stats(app_id: str) -> dict:
    """D15·D20: 최근 7일 채우기·실패·저장률·평균 고친 칸. ts 색인으로 읽고 note 를 Python 에서 가른다."""
    since = (datetime.now().astimezone() - timedelta(days=7)).isoformat(timespec="seconds")
    want = f"app={_note_value(app_id)} "
    out: dict[str, dict] = {}
    with store.connect() as conn:
        rows = conn.execute("SELECT kind, note FROM usage WHERE ts >= ? AND kind IN ('embed_format_fill', 'embed_format_outcome')",
                            (since,)).fetchall()
    for r in rows:
        note = str(r["note"] or "")
        if not note.startswith(want):
            continue
        kv = dict(x.split("=", 1) for x in note.split() if "=" in x)
        s = out.setdefault(kv.get("format", "-"), {"fills": 0, "failed": 0, "outcomes": 0, "saved": 0, "edited": 0})
        if r["kind"] == "embed_format_fill":
            s["fills"] += 1
            code = kv.get("code", "")
            if code.startswith("format.fill_") or code in ("format.schema_invalid", "format.too_deep", "ok_with_errors"):
                s["failed"] += 1
        else:
            s["outcomes"] += 1
            s["saved"] += kv.get("outcome") == "saved"
            s["edited"] += int(kv.get("edited", "0") or 0) if kv.get("edited", "0").isdigit() else 0
    for s in out.values():
        s["saveRate"] = round(s["saved"] / s["outcomes"], 3) if s["outcomes"] else None
        s["editedAvg"] = round(s["edited"] / s["outcomes"], 2) if s["outcomes"] else None
    return out


def _view(fmt: dict, stats: dict) -> dict:
    return {"id": fmt["id"], "label": fmt["label"], "schema": fmt["schema"], "instructions": fmt["instructions"],
            "version": fmt["version"], "schemaHash": af.schema_hash(fmt["schema"]), "updated": fmt["updated"],
            "updatedBy": fmt["updated_by"], "warnings": _warnings(fmt["schema"]), "stats": stats.get(fmt["id"])}


def _list(request: Request) -> dict:
    _admin(request, write=False)
    app_id = _app_id(request)
    stats = _stats(app_id)
    return {"formats": [_view(f, stats) for f in embed.list_formats(app_id)],
            "page_schema": bool(embed.get_app(app_id).get("page_schema")), "pageStats": stats.get("page")}


def _create(request: Request, body: dict) -> dict:
    user = _admin(request, write=True)
    app_id = _app_id(request)
    fmt = embed.save_format(app_id, str(body.get("id") or ""), body.get("label"), body.get("schema"), str(body.get("instructions") or ""),
                            create=True, by=str(user.get("email") or ""))
    return _view(fmt, {})


def _update(request: Request, body: dict) -> dict:
    user = _admin(request, write=True)
    app_id = _app_id(request)
    fmt = embed.save_format(app_id, str(request.path_params.get("format") or ""), body.get("label"), body.get("schema"),
                            str(body.get("instructions") or ""), create=False, by=str(user.get("email") or ""))
    return _view(fmt, {})


def _delete(request: Request) -> dict:
    user = _admin(request, write=True)
    app_id = _app_id(request)
    if not embed.remove_format(app_id, str(request.path_params.get("format") or ""), by=str(user.get("email") or "")):
        raise _Fail("format.not_found", 404)
    return {"ok": True}


def _settings(request: Request, body: dict) -> dict:
    user = _admin(request, write=True)
    app_id = _app_id(request)
    if not isinstance(body.get("page_schema"), bool):
        raise _Fail("format.bad_request", 400, detail={"field": "page_schema"})
    embed.set_page_schema(app_id, body["page_schema"], by=str(user.get("email") or ""))
    return {"page_schema": body["page_schema"]}


def _admin_try(schema, instructions: str, body: dict, user: dict) -> dict:
    """「예시로 채워 보기」. 관리자 1분 20번(D17). 결과는 저장하지 않는다."""
    if mcp_limits.hit(f"fmt-admin:{user.get('email') or ''}") > ADMIN_PER_MIN:
        raise _Fail("format.rate_limited_admin", 429, retry_after=_retry_after())
    markdown = _str(body, "markdown")
    started = time.monotonic()
    out = af.fill(schema, source="registered", markdown=af.cut(markdown, af.MARKDOWN_MAX), instructions=instructions,
                  question=_str(body, "question"))
    return {**out, "schemaHash": af.schema_hash(schema), "elapsedMs": int((time.monotonic() - started) * 1000)}


def _try_saved(request: Request, body: dict) -> dict:
    user = _admin(request, write=True)
    fmt = embed.get_format(_app_id(request), str(request.path_params.get("format") or ""))
    if fmt is None:
        raise _Fail("format.not_found", 404)
    return _admin_try(fmt["schema"], fmt["instructions"], body, user)


def _try_draft(request: Request, body: dict) -> dict:
    user = _admin(request, write=True)
    _app_id(request)
    code, errors = af.check_schema(body.get("schema"))
    if code:
        raise _Fail(code, 400, errors=errors)
    instructions = _str(body, "instructions")
    if len(instructions) > af.INSTRUCTIONS_MAX:
        raise _Fail("format.text_too_long", 400, detail={"field": "instructions"})
    return _admin_try(body["schema"], instructions, body, user)


_list_h, _create_h, _delete_h, _update_h = _sync(_list), _with_body(_create), _sync(_delete), _with_body(_update)


async def _formats(request: Request):
    """GET 목록·POST 만들기를 한 경로에서."""
    return await (_list_h if request.method == "GET" else _create_h)(request)


async def _one(request: Request):
    return await (_delete_h if request.method == "DELETE" else _update_h)(request)


def routes() -> list:
    base = server.EMBED_APPS_PATH + "/{app}"
    return [Route("/api/chat/answer-format/info", _sync(_info), methods=["GET"]),
            Route("/api/chat/answer-format/fill", fill, methods=["POST"]),
            Route("/api/chat/answer-format/outcome", _with_body(_outcome), methods=["POST"]),
            Route(base + "/formats", _formats, methods=["GET", "POST"]),
            Route(base + "/formats-try", _with_body(_try_draft), methods=["POST"]),
            Route(base + "/formats-settings", _with_body(_settings), methods=["PUT"]),
            Route(base + "/formats/{format}/try", _with_body(_try_saved), methods=["POST"]),
            Route(base + "/formats/{format}", _one, methods=["PUT", "DELETE"])]

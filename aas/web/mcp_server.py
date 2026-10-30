# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""AAS MCP 서버 `/mcp` — 로컬 Claude Code 가 원격 에이전트를 다룬다(스펙 2026-10-28-001 §3-2·§3-3, OMAI-1513).

직접 구현한 JSON-RPC 5개(initialize·notifications/initialized·ping·tools/list·tools/call), JSON 응답만(D7).
Bearer 토큰(personal_tokens)만 받고 쿠키는 보지 않는다. Origin 이 있으면 거절한다(브라우저 안 스크립트 막기, §3-2).
도구는 지금 화면 API 경로를 같은 프로세스 안에서 부른다(D2) — 사용자는 ASGI scope 의 내부 값(server.PRINCIPAL_KEY)으로만 붙인다.
"""
from __future__ import annotations

import asyncio
import contextvars
import json
import shlex
import threading
import time
from urllib.parse import urlencode

import anyio
from starlette.requests import Request
from starlette.responses import JSONResponse, Response
from starlette.routing import Route

from ..auth import keycloak, mcp_limits, mcp_transfers, tokens
from ..common import config, i18n, store
from ..common.i18n import tr
from ..fleet import profiles
from ..ops import chat_session_meta
from ..hermes import workspace as wsp
from ..hermes.hermes_chat import APPROVAL_CHOICES, ChatUnavailable
from ..market import marketplace
from . import credential_files, legacy, server, skill_files

PROTOCOLS = ("2025-06-18", "2025-03-26", "2024-11-05")   # 앞의 것이 기본. 클라이언트가 고른 판이 이 안에 있으면 그대로 쓴다
BODY_MAX = 256 * 1024                                     # 글은 64KB 까지 인자로(D3) — JSON 꾸밈을 더해 넉넉히
WAIT_MAX = 50.0                                           # chat_wait 한 번의 최대 대기(D9). HAProxy timeout-server 3600s 안
FILES_GRACE = 2.0                                         # 턴이 끝난 뒤 바뀐 파일 목록(aas.files, 따로 계산)이 오기를 기다리는 시간
TEXT_MAX = 16 * 1024                                      # 답 글을 결과에 넣는 한도(D9)
INLINE_MAX = 64 * 1024                                    # 파일을 결과에 글로 넣는 한도(D3). 넘거나 글이 아니면 1회용 받기 주소
FIELD_MAX = 2000                                          # 승인·되묻기 카드의 글 칸 하나의 한도
MEMBER_TTL = 300.0                                        # Keycloak 활성·그룹 확인을 기억하는 시간(D12)
INSTRUCTIONS = ("CogentAI AAS: talk to your remote Hermes agents. Start with agents_list, then chat_start → chat_send → chat_wait "
                "(repeat chat_wait with the returned `after` until state is done). Answer approvals with approval_respond.")


class ToolError(Exception):
    """도구 결과의 isError. word 는 고정 낱말(§3-3): auth·forbidden·busy·invalid·reconnect·unavailable."""
    def __init__(self, word: str, message: str = "", hint: str = ""):
        super().__init__(message or word)
        self.word, self.message, self.hint = word, message, hint


MCP_LANG = "en"                                          # Claude Code 는 Accept-Language 를 보내지 않는다. 도구 설명과 같은 영어로(2026-10-28)


def _hint(word: str) -> str:
    """오류의 next. message(서버 문장)와 같은 언어로 — 한쪽만 한국어이던 것(2026-10-28 OKE reconnect)."""
    return {"busy": tr("몇 초 기다린 뒤 다시 부르세요", "wait a few seconds and call again"),
            "reconnect": tr("이 서버에서 대화가 사라졌습니다. chat_start 로 새 대화를 열고 다시 보내세요",
                            "the chat is gone from this server; open a new chat with chat_start and send again"),
            "auth": tr("토큰이 더는 유효하지 않습니다. Claude Code 를 AAS 에 다시 연결하세요",
                       "the token is no longer valid; reconnect Claude Code to AAS")}[word]


# ---- 인증 ----------------------------------------------------------------------------------------------
_members: dict[str, tuple[bool, float]] = {}
_members_lock = threading.Lock()


def _keycloak():
    return keycloak.admin_from_config()


def member(email: str, now: float | None = None) -> bool | None:
    """그 사람이 아직 AAS 를 쓸 수 있는가(D12). Keycloak 관리 클라이언트가 없는 설치(비밀번호 로그인 등)는 늘 True.
    확인하지 못하면 None — 기억이 지났으면 막는다(fail-closed)."""
    now = time.time() if now is None else now
    with _members_lock:
        got = _members.get(email)
    if got and now - got[1] < MEMBER_TTL:
        return got[0]
    kc = _keycloak()
    if kc is None:
        return True
    try:
        ok = kc.is_member(email)
    except Exception:                                     # 닿지 않음·권한 없음 — 이유는 로그에 남기지 않는다(주소·비밀이 섞일 수 있다)
        return None
    with _members_lock:
        _members[email] = (ok, now)
    return ok


def _bearer(request: Request) -> str:
    got = request.headers.get("authorization", "")
    return got[7:].strip() if got[:7].lower() == "bearer " else ""


def _client_ip(request: Request) -> str:
    fwd = request.headers.get("x-forwarded-for", "")
    return (fwd.split(",")[0].strip() if fwd else "") or (request.client.host if request.client else "")


def _deny(status: int, word: str, reason: str = "") -> JSONResponse:
    headers = {"Cache-Control": "no-store"}
    if status == 401:
        headers["WWW-Authenticate"] = f'Bearer error="invalid_token", error_description="{reason or word}"'
    return JSONResponse({"error": word, **({"reason": reason} if reason else {})}, status, headers=headers)


def _authenticate(raw: str) -> tuple[dict | None, JSONResponse | None]:
    """(토큰 줄, 거절 응답). 스레드에서 돈다(DB·Keycloak)."""
    state, row = tokens.lookup_state(raw)
    if state != "active":
        return None, _deny(401, "auth", {"unknown": "invalid_token"}.get(state, state))
    ok = member(row["user_email"])
    if ok is None:
        return None, _deny(503, "unavailable", "member_check")
    if not ok:                                            # 퇴사·사용 중지·그룹 빠짐 — 그 사람의 연결을 모두 끊는다(D12)
        tokens.revoke_all(row["user_email"], by="keycloak")
        return None, _deny(401, "auth", "removed")
    return row, None


# ---- 같은 프로세스 안 요청(D2) ---------------------------------------------------------------------------
def token_user(row: dict) -> dict:
    """토큰 줄 → 내부 사용자 값의 user. 관리자 권한은 쓰지 않는다(D5, Registry.is_admin 이 via 를 본다)."""
    return {"email": row["user_email"], "name": row["user_email"], "sub": row["user_sub"], "admin": False, "via": "token",
            "token": row["id"]}


def inner_scope(outer: dict, user: dict, pod: str, method: str, path: str, query: dict | None = None, extra=()) -> dict:
    """같은 프로세스 안 요청의 ASGI scope(D2). 바깥 요청의 헤더는 legacy.FORWARD_HEADERS 만 옮긴다(F14) — Cookie·Authorization 은 버린다."""
    headers = [(k, v) for k, v in outer.get("headers", []) if k in legacy.FORWARD_HEADERS] + list(extra)
    if not any(k == b"accept-language" for k, _ in headers):   # 안쪽 화면 API 의 문장도 /mcp 와 같은 언어로
        headers.append((b"accept-language", MCP_LANG.encode()))
    scope = {"type": "http", "asgi": {"version": "3.0", "spec_version": "2.3"}, "http_version": "1.1", "method": method,
             "scheme": outer.get("scheme", "http"), "path": path, "raw_path": path.encode(), "root_path": "",
             "query_string": urlencode(query or {}).encode(), "headers": headers, "client": outer.get("client"),
             "server": outer.get("server"), server.PRINCIPAL_KEY: {"user": user, "pod": pod}}
    if "state" in outer:
        scope["state"] = outer["state"]
    return scope


class Ctx:
    def __init__(self, request: Request, row: dict):
        self.request, self.row = request, row
        self.email = row["user_email"]
        self.scopes = set(row["scopes"].split())
        self.user = token_user(row)
        self.headers: dict = {}

    async def api(self, method: str, path: str, pod: str = "", query: dict | None = None, body=None):
        """지금 화면 API 를 부른다. (상태, JSON 또는 바이트). body 가 bytes 면 그대로(인증 파일), 아니면 JSON. 응답 헤더는 self.headers 에."""
        raw_body = isinstance(body, bytes)
        data = body if raw_body else json.dumps(body, ensure_ascii=False).encode() if body is not None else b""
        ctype = b"application/octet-stream" if raw_body else b"application/json"
        scope = inner_scope(self.request.scope, self.user, pod, method, path, query,
                            [(b"content-type", ctype), (b"content-length", str(len(data)).encode())])
        done = asyncio.Event()
        sent = [False]
        status, chunks, ctype = [500], [], [b""]

        async def receive():
            if not sent[0]:
                sent[0] = True
                return {"type": "http.request", "body": data, "more_body": False}
            await done.wait()
            return {"type": "http.disconnect"}

        async def send(msg):
            if msg["type"] == "http.response.start":
                status[0] = msg["status"]
                self.headers = {k.decode("latin-1").lower(): v.decode("latin-1") for k, v in msg.get("headers") or []}
                ctype[0] = self.headers.get("content-type", "").encode()
            elif msg["type"] == "http.response.body":
                chunks.append(msg.get("body", b""))

        mark = store.actor_via.set("token")                # Starlette 경로의 기록에도 via=token(F8). 옛 Handler 는 스스로 붙인다
        try:
            await self.request.app(scope, receive, send)
        finally:
            store.actor_via.reset(mark)
            done.set()
        raw = b"".join(chunks)
        if ctype[0].startswith(b"application/json") and raw:
            try:
                return status[0], json.loads(raw)
            except ValueError:
                pass
        return status[0], raw

    async def call(self, method: str, path: str, pod: str = "", query: dict | None = None, body=None):
        status, out = await self.api(method, path, pod, query, body)
        return _ok(status, out)


def _ok(status: int, out):
    """화면 API 응답 → 결과, 실패면 ToolError. 500 본문(예외 이름·문장)은 넘기지 않는다(§3-3)."""
    if 200 <= status < 300:
        return out
    msg = out.get("error") if isinstance(out, dict) else ""
    if isinstance(msg, dict):
        msg = msg.get("text") or msg.get("message") or msg.get("code") or ""
    if not msg and isinstance(out, dict):                 # Starlette 경로(files·credential_files)는 {"code": …} 로 답한다
        msg = out.get("code") or ""
    msg = str(msg or "")[:500]
    if isinstance(out, dict) and out.get("reason") == "already_answered":   # 사람이 먼저 답했다 — 다시 부를 일이 아니다(§3-7 ④)
        raise ToolError("invalid", msg)
    if status == 401:
        raise ToolError("auth", msg, _hint("auth"))
    if status == 403:
        raise ToolError("forbidden", msg)
    if status in (409, 429):
        raise ToolError("busy", msg, _hint("busy"))
    if status in (400, 404, 413, 422):
        raise ToolError("invalid", msg)
    if status == 503:
        raise ToolError("reconnect", msg, _hint("reconnect"))
    if status in (501, 502):                              # 서버가 쓴 안내 문장(사이드카·Hermes 에 닿지 못함 등). 500 과 달리 예외 글이 아니다
        raise ToolError("unavailable", msg)
    raise ToolError("unavailable", "")


# ---- 도구 ------------------------------------------------------------------------------------------------
def _s(desc: str, **extra) -> dict:
    return {"type": "string", "description": desc, **extra}


POD = _s("Agent (POD) id from agents_list")
PROFILE = _s("Profile name; empty = the agent's chat default")
SESSION = _s("session_id from chat_start")


def _arg(args: dict, name: str, required: bool = True, limit: int = 200) -> str:
    v = args.get(name)
    v = "" if v is None else str(v)
    if required and not v.strip():
        raise ToolError("invalid", f"`{name}` is required")
    if len(v) > limit:
        raise ToolError("invalid", f"`{name}` is too long")
    return v.strip()


async def _pod(ctx: Ctx, args: dict, required: bool = True) -> str:
    """쓰기 도구는 pod 필수, 읽기 도구는 비우면 볼 수 있는 첫 에이전트(F1). 쿠키 없는 pick() 이 고르지 않게 여기서 정한다."""
    pid = _arg(args, "pod", required)
    if pid:
        return pid
    a = server.auth()
    pods = await anyio.to_thread.run_sync(lambda: server.registry().allowed(ctx.user, a.enabled))
    if not pods:
        raise ToolError("forbidden", "no agent is linked to this account")
    return pods[0].id


async def _chat_pod(ctx: Ctx, pid: str):
    """대화 도구가 쓸 Pod 객체(chat_wait·seq 용). 권한은 화면 채팅과 같은 _chat_pod."""
    a = server.auth()
    pod = await anyio.to_thread.run_sync(server._chat_pod, a, ctx.user, pid)
    if pod is None:
        _ok(*reversed(await anyio.to_thread.run_sync(server._chat_pod_refusal, a, ctx.user, pid)))
    return pod


# ---- 1회용 전송 주소(D3) -------------------------------------------------------------------------------
def base_url(request: Request) -> str:
    """curl 이 부를 이 AAS 의 주소. 등록된 접속 주소와 맞을 때만 Host 를 쓰고, 아니면 public_url(Host 를 꾸며 주소를 바꾸지 못하게)."""
    a = server.auth()
    tls = request.url.scheme == "https" or request.headers.get("x-forwarded-proto", "").split(",")[0].strip() == "https"
    host = request.headers.get("x-forwarded-host", "").split(",")[0].strip() or request.headers.get("host", "")
    return (a.base_for(host, tls) or str(a.cfg.get("public_url") or "")).rstrip("/")


async def _link(ctx: Ctx, kind: str, direction: str, pod: str, params: dict, body: str = "") -> str:
    key = await anyio.to_thread.run_sync(lambda: mcp_transfers.create(ctx.row, kind, direction, pod, params, body))
    return f"{base_url(ctx.request)}/mcp/transfer/{key}"


def _up_command(url: str, source: str, env: bool = False) -> str:
    """값·내용을 모델이 읽지 않게 경로나 환경변수 이름만 쓴다(3-4-1 B)."""
    put = f"curl -sS --fail-with-body -X PUT -H 'Content-Type: application/octet-stream' --data-binary @{'-' if env else shlex.quote(source)} {shlex.quote(url)}"
    return f'printf %s "${{{source}}}" | {put}' if env else put


def _down_command(url: str, out: str) -> str:
    """받을 곳은 aas-files/ 처럼 따로 둔다 — 같은 이름의 로컬 파일(올린 원본 등)을 덮지 않게(2026-10-28 실제 Claude Code 로 확인)."""
    return f"curl -sS --fail-with-body --create-dirs -o {shlex.quote(out)} {shlex.quote(url)}"


def _link_view(url: str, command: str, **extra) -> dict:
    return {"url": url, "command": command, "expires_in": int(mcp_transfers.TTL), "single_use": True, **extra}


AGENT_KEYS = ("pod", "name", "owner_name", "current", "shared", "team", "state", "connected", "profiles", "chat_default", "primary")
PROFILE_KEYS = ("name", "title", "description", "running")


async def agents_list(ctx: Ctx, args: dict):
    """화면 채팅 목록의 묶음에서 Claude Code 가 쓸 칸만. 서버 설정 파일 경로·대시보드 주소 같은 안쪽 값은 넘기지 않는다
    (2026-10-28 실제 Claude Code 로 확인하다 env_file 경로가 보여 고침)."""
    out = await ctx.call("GET", "/api/chat/status", "", {"all": "1"})
    rows = []
    for g in out.get("groups", []):
        row = {k: g[k] for k in AGENT_KEYS if k in g}
        row["agents"] = [{k: p[k] for k in PROFILE_KEYS if k in p} for p in g.get("agents") or [] if isinstance(p, dict)]
        rows.append(row)
    return {"agents": rows}


async def chat_start(ctx: Ctx, args: dict):
    pid = await _pod(ctx, args)
    profile, resume = _arg(args, "profile", False), _arg(args, "resume", False)
    purpose = _arg(args, "purpose", False, 20)
    if purpose not in chat_session_meta.PURPOSES:
        raise ToolError("invalid", "`purpose` is empty or skill-test")
    if resume:
        out = await ctx.call("POST", "/api/chat/resume", pid, body={"pod": pid, "profile": profile, "stored_id": resume})
    else:
        out = await ctx.call("POST", "/api/chat/session", pid, body={"pod": pid, "profile": profile})
    sid = str((out or {}).get("session_id") or "")
    pod = await _chat_pod(ctx, pid)
    h = server.hub(pod)
    if sid:                                               # 화면 대화 목록의 「Claude Code」 표시·쓰는 중 띠(§3-7 ⑤)
        stored = resume or str((h.sessions.get(sid) or {}).get("stored_id") or "")
        await anyio.to_thread.run_sync(lambda: chat_session_meta.opened(pid, sid, stored, str(out.get("profile") or profile), ctx.email,
                                                                        "token", purpose))
    stored = resume or (str((h.sessions.get(sid) or {}).get("stored_id") or "") if sid else "")
    return {**out, "pod": pid, "after": h.seq(sid) if sid else 0, **({"stored_id": stored} if stored else {})}


READ_MAX = 50                                             # chat_read 가 돌려주는 메시지 수 상한
READ_TEXT = 4000                                          # 메시지 하나의 글 상한


def history_messages(events: list[dict], last: int) -> list[dict]:
    """다시 연 대화의 이벤트 → 메시지(역할·글·도구 이름·시각). 마지막 aas.history 와 그 뒤 끝난 답을 잇는다."""
    rows: list[dict] = []
    for e in events:
        p = e.get("payload") if isinstance(e.get("payload"), dict) else {}
        if e.get("type") == "aas.history":
            rows = [r for r in p.get("messages") or [] if isinstance(r, dict)]
        elif e.get("type") == "message.complete" and isinstance(p.get("text"), str):
            rows.append({"role": "assistant", "text": p["text"]})
    out = []
    for r in rows[-last:]:
        row = {k: r[k] for k in ("role", "name", "timestamp", "reason") if r.get(k)}
        text = str(r.get("text") or "")
        if text:
            row["text"] = text[:READ_TEXT] + ("…" if len(text) > READ_TEXT else "")
        out.append(row)
    return out


async def chat_read(ctx: Ctx, args: dict):
    """지난 대화의 메시지를 읽는다. 예약 작업 실행(cron_get 의 runs[].id)도 같은 저장 번호라 그 답을 볼 수 있다(2026-10-28 OKE 시험:
    cron_get 이 실행 정보만 주어 스킬 결과를 볼 수 없었다)."""
    pid, stored = await _pod(ctx, args), _arg(args, "stored_id", True, 200)
    try:
        last = min(max(int(args.get("last") or 10), 1), READ_MAX)
    except (TypeError, ValueError):
        raise ToolError("invalid", "`last` is a number")
    opened = await chat_start(ctx, {"pod": pid, "profile": _arg(args, "profile", False), "resume": stored})
    sid = str(opened.get("session_id") or "")
    h = server.hub(await _chat_pod(ctx, pid))
    events = await anyio.to_thread.run_sync(lambda: h.events_after(sid, 0, wait=0))
    return {"pod": pid, "stored_id": stored, "session_id": sid, "title": opened.get("title") or "", "after": h.seq(sid),
            "messages": history_messages(events, last)}


async def _touch(pid: str, h, sid: str) -> None:
    """Claude Code 가 이 대화를 쓰는 중이다(90초). Hermes 가 저장한 번호를 알게 됐으면 채운다."""
    stored = str((getattr(h, "sessions", {}).get(sid) or {}).get("stored_id") or "")
    await anyio.to_thread.run_sync(lambda: chat_session_meta.touch(pid, sid, stored))


async def chat_send(ctx: Ctx, args: dict):
    pid, sid = await _pod(ctx, args), _arg(args, "session_id")
    text = _arg(args, "text", True, 64 * 1024)
    body = {"pod": pid, "session_id": sid, "text": text}
    if args.get("skill"):
        body["skill"] = _arg(args, "skill", False, 120)
    if args.get("files"):
        if not isinstance(args["files"], list):
            raise ToolError("invalid", "`files` must be a list of uploaded file names")
        body["files"] = args["files"][:20]
    pod = await _chat_pod(ctx, pid)
    after = server.hub(pod).seq(sid)                      # 보내기 전 번호 — 이 뒤의 이벤트가 이번 턴이다
    out = await ctx.call("POST", "/api/chat/send", pid, body=body)
    await _touch(pid, server.hub(pod), sid)
    return {"ok": True, "after": after, "result": out.get("result")}


def _clip(v, depth: int = 0):
    if isinstance(v, str):
        return v if len(v) <= FIELD_MAX else v[:FIELD_MAX] + "…"
    if depth > 3:
        return None
    if isinstance(v, dict):
        return {k: _clip(x, depth + 1) for k, x in list(v.items())[:40] if k not in ("srq_id", "session_id")}
    if isinstance(v, list):
        return [_clip(x, depth + 1) for x in v[:40]]
    return v


def summarize(events: list[dict]) -> dict:
    """이벤트 → chat_wait 결과. 도구 호출은 이름·상태만(D9). 답 글은 TEXT_MAX 바이트까지."""
    parts, final, state, error = [], None, "running", ""
    tools: dict = {}
    approvals: dict = {}
    clarify: dict = {}
    files, notices = [], []
    for e in events:
        t, p = e.get("type"), e.get("payload") if isinstance(e.get("payload"), dict) else {}
        if t == "message.start":
            parts, final, state, error = [], None, "running", ""
        elif t == "message.delta":
            parts.append(str(p.get("text") or ""))
        elif t == "message.complete":
            final = p.get("text") if isinstance(p.get("text"), str) else None
            state = "error" if p.get("status") == "error" else "done"
            if state == "error":
                error = str(final or "")[:FIELD_MAX]
        elif t == "error":
            state, error = "error", str(p.get("message") or p.get("text") or "")[:FIELD_MAX]
        elif t == "tool.start":
            tools[p.get("tool_id") or f"#{len(tools)}"] = {"name": str(p.get("name") or "tool"), "state": "running"}
        elif t == "tool.complete" and p.get("tool_id") in tools:
            tools[p["tool_id"]]["state"] = "failed" if p.get("error") or p.get("status") == "error" else "done"
        elif t == "approval.request":
            approvals[str(p.get("request_id") or "")] = _clip(p)
        elif t == "clarify.request":
            clarify[str(p.get("request_id") or "")] = _clip(p)
        elif t == "aas.approval.answered":
            approvals.pop(str(p.get("request_id") or ""), None)
        elif t == "aas.clarify.answered":
            clarify.pop(str(p.get("request_id") or ""), None)
        elif t == "aas.request.cancelled":
            approvals.pop(str(p.get("request_id") or ""), None)
            clarify.pop(str(p.get("request_id") or ""), None)
        elif t == "aas.files":
            files.append(_clip(p))
        elif t == "aas.disconnected":
            state = "disconnected"
        elif t == "aas.notice" and p.get("code"):
            notices.append(str(p["code"]))
    if state == "running" and approvals:
        state = "approval"
    elif state == "running" and clarify:
        state = "clarify"
    text = final if final is not None else "".join(parts)
    out: dict = {"state": state, "after": events[-1]["seq"] if events else None}
    raw = text.encode()
    if len(raw) > TEXT_MAX:                               # 넘는 답은 앞부분만. 전체는 chat_wait 가 1회용 받기 주소로 붙인다
        out.update(text=raw[:TEXT_MAX].decode("utf-8", "ignore"), truncated=True, length=len(raw), _full=text)
    elif text:
        out["text"] = text
    for k, v in (("tools", list(tools.values())), ("approvals", list(approvals.values())), ("clarify", list(clarify.values())),
                 ("files", files), ("notices", notices), ("error", error)):
        if v:
            out[k] = v
    return out


def collect(h, sid: str, after: int, budget: float) -> list[dict]:
    """budget 초 안에서 턴이 끝나거나(답·오류·끊김) 사람의 답(승인·되묻기)이 필요해질 때까지 이벤트를 모은다. 전용 실행기에서 돈다(F2)."""
    deadline = time.monotonic() + budget
    got: list[dict] = []
    grace = None
    while True:
        remaining = deadline - time.monotonic()
        if grace is not None:
            remaining = min(remaining, grace - time.monotonic())
        batch = h.events_after(sid, after, wait=max(0.0, remaining))
        if batch:
            got += batch
            after = batch[-1]["seq"]
        state = summarize(got)["state"] if got else "running"
        if state in ("approval", "clarify", "error", "disconnected"):
            return got
        if state == "done":
            if any(e["type"] == "aas.files" for e in got) or (grace is not None and time.monotonic() >= grace):
                return got
            if grace is None:
                grace = time.monotonic() + FILES_GRACE
        if remaining <= 0 and not batch:
            return got


_pod_waits = threading.BoundedSemaphore(max(1, int(config.get("AAS_MCP_WAITS_PER_POD", "32") or 32)))   # 파드마다 스레드 보호(재검토 D7)


async def chat_wait(ctx: Ctx, args: dict):
    pid, sid = await _pod(ctx, args), _arg(args, "session_id")
    try:
        after = int(args.get("after") or 0)
        budget = min(WAIT_MAX, max(0.0, float(args.get("timeout") if args.get("timeout") is not None else WAIT_MAX)))
    except (TypeError, ValueError):
        raise ToolError("invalid", "`after` and `timeout` must be numbers")
    pod = await _chat_pod(ctx, pid)
    h = server.hub(pod)
    await _touch(pid, h, sid)
    if not _pod_waits.acquire(blocking=False):
        raise ToolError("busy", "too many waits on this server", _hint("busy"))
    try:
        wid = await anyio.to_thread.run_sync(mcp_limits.wait_begin, ctx.email)
        if wid is None:
            raise ToolError("busy", f"up to {mcp_limits.waits_per_user()} chat_wait calls at once", _hint("busy"))
        try:
            ctx_run = contextvars.copy_context().run      # 실행기 스레드는 요청 언어(contextvar)를 넘겨받지 않는다
            events = await asyncio.get_running_loop().run_in_executor(legacy.stream_pool(), ctx_run, collect, h, sid, after, budget)
        except ChatUnavailable as exc:
            raise ToolError("reconnect", str(exc), _hint("reconnect"))
        finally:
            await anyio.to_thread.run_sync(mcp_limits.wait_end, wid)
    finally:
        _pod_waits.release()
    out = summarize(events)
    if out["after"] is None:
        out["after"] = after
    stored = str((getattr(h, "sessions", {}).get(sid) or {}).get("stored_id") or "")
    if stored:                                            # 다른 서버로 넘어가도 chat_start(resume) 로 다시 열 번호
        out["stored_id"] = stored
    full = out.pop("_full", None)
    if full is not None:
        url = await _link(ctx, "answer", "down", pid, {"session_id": sid}, full)
        out["full_answer"] = _link_view(url, _down_command(url, "aas-files/answer.md"))
    return out


async def chat_interrupt(ctx: Ctx, args: dict):
    pid, sid = await _pod(ctx, args), _arg(args, "session_id")
    return await ctx.call("POST", "/api/chat/interrupt", pid, body={"pod": pid, "session_id": sid})


async def approval_respond(ctx: Ctx, args: dict):
    pid, sid = await _pod(ctx, args), _arg(args, "session_id")
    choice = _arg(args, "choice")
    if choice not in APPROVAL_CHOICES:
        raise ToolError("invalid", f"`choice` must be one of {', '.join(APPROVAL_CHOICES)}")
    return await ctx.call("POST", "/api/chat/approval", pid,
                          body={"pod": pid, "session_id": sid, "choice": choice, "request_id": _arg(args, "request_id", False) or None})


async def clarify_answer(ctx: Ctx, args: dict):
    pid, sid = await _pod(ctx, args), _arg(args, "session_id")
    return await ctx.call("POST", "/api/chat/clarify", pid,
                          body={"pod": pid, "session_id": sid, "request_id": _arg(args, "request_id"),
                                "answer": args.get("answer"), "question_id": _arg(args, "question_id", False) or None})


async def command_run(ctx: Ctx, args: dict):
    pid, sid = await _pod(ctx, args), _arg(args, "session_id")
    out = await ctx.call("POST", "/api/chat/command", pid,
                         body={"pod": pid, "session_id": sid, "command": _arg(args, "command", True, 40),
                               "arg": _arg(args, "arg", False, 4000)})
    if isinstance(out, dict) and out.get("ok") is False:   # 허용 목록 밖·주인만 등 안내 문장(11-4)
        err = out.get("error") or {}
        raise ToolError("invalid", str(err.get("text") or err.get("code") or ""))
    return out


async def files_list(ctx: Ctx, args: dict):
    pid = await _pod(ctx, args, required=False)
    return await ctx.call("GET", "/api/chat/files/list", pid, {"pod": pid})


SKILL_ROW = ("id", "name", "profile", "description", "enabled", "origin", "category", "tags", "new_version")


async def skills_list(ctx: Ctx, args: dict):
    pid = await _pod(ctx, args, required=False)
    profile = _arg(args, "profile", False)
    out = await ctx.call("GET", "/api/skills", pid, {"pod": pid})
    rows = [{k: r[k] for k in SKILL_ROW if k in r} for r in out.get("skills", []) if not profile or r.get("profile") == profile]
    return {"pod": pid, "skills": rows, "profiles": out.get("profiles"), "can_upload": out.get("can_upload")}


async def _skill_id(ctx: Ctx, pid: str, sid: str, profile: str) -> str:
    """이름만 받으면 skills_list 에서 id 를 찾는다(2026-10-28 OKE 에서 Claude Code 가 이름으로 불러 「없는 스킬」). 여러 프로파일에 있으면 고르게 한다."""
    if ":" in sid or "/" in sid:
        return sid
    out = await ctx.call("GET", "/api/skills", pid, {"pod": pid})
    hits = [r for r in out.get("skills", []) if r.get("name") == sid and (not profile or r.get("profile") == profile)]
    if not hits:
        raise ToolError("invalid", f"no skill named {sid}" + (f" in profile {profile}" if profile else "") + "; see skills_list")
    if len(hits) > 1:
        raise ToolError("invalid", f"{sid} is in several profiles ({', '.join(str(r.get('profile')) for r in hits)}); "
                                   "give `profile` or the id from skills_list")
    return str(hits[0].get("id") or sid)


async def skill_get(ctx: Ctx, args: dict):
    """스킬 정보와 SKILL.md 본문(skill_md: path·sha·text). 본문이 없으면 Claude Code 가 skill_file_read 를 한 번 더 불렀다(2026-10-28)."""
    pid = await _pod(ctx, args, required=False)
    sid = await _skill_id(ctx, pid, _arg(args, "id", True, 400), _arg(args, "profile", False))
    hit = await ctx.call("GET", "/api/skill", pid, {"pod": pid, "id": sid})
    if isinstance(hit, dict) and hit.get("path"):
        try:
            md = await ctx.call("GET", "/api/file", pid, {"pod": pid, "path": f"{hit['path']}/SKILL.md"})
            if isinstance(md, dict) and isinstance(md.get("lines"), list):
                hit["skill_md"] = {"path": md.get("path"), "sha": md.get("sha"), "text": "\n".join(map(str, md["lines"]))[:INLINE_MAX]}
        except ToolError:                                 # 본문을 못 읽어도 정보는 준다
            pass
    if args.get("zip") and isinstance(hit, dict):         # 폴더 zip 받기(스크립트 포함). 권한은 /api/skill/download 가 받을 때 다시 본다
        url = await _link(ctx, "skill", "down", pid, {"profile": hit.get("profile") or "", "path": hit.get("path") or ""})
        hit["download"] = _link_view(url, _down_command(url, f"aas-files/{hit.get('name') or 'skill'}.zip"))
    return hit


async def file_get(ctx: Ctx, args: dict):
    """크기는 작업공간 목록에서 읽는다 — 받기 경로의 HEAD 는 있는지만 보고 크기·형식을 주지 않는다(2026-10-28 실제 Hermes 로 확인).
    64KB 이하이고 UTF-8 글이면 결과에, 아니면 1회용 받기 주소."""
    pid, path = await _pod(ctx, args, required=False), _arg(args, "path", True, 1000)
    listing = await ctx.call("GET", "/api/chat/files/list", pid, {"pod": pid})
    entry = next((e for e in (listing or {}).get("entries", []) if isinstance(e, dict) and e.get("path") == path), None)
    if entry is None or entry.get("kind") != "file":
        raise ToolError("invalid", "no such file in the chat workspace; see files_list")
    if not entry.get("downloadable", True):
        raise ToolError("forbidden", f"this file cannot be downloaded ({entry.get('reason') or 'not allowed'})")
    size = int(entry.get("size") or 0)
    if size <= INLINE_MAX:
        status, raw = await ctx.api("GET", "/api/chat/files", pid, {"pod": pid, "path": path})
        raw = _ok(status, raw)
        raw = raw if isinstance(raw, bytes) else json.dumps(raw, ensure_ascii=False).encode()
        if b"\x00" not in raw:
            try:
                return {"path": path, "size": len(raw), "text": raw.decode("utf-8")}
            except UnicodeDecodeError:
                pass
    url = await _link(ctx, "file", "down", pid, {"path": path})
    return {"path": path, "size": size, "download": _link_view(url, _down_command(url, f"aas-files/{entry.get('name') or 'file'}"))}


async def file_put(ctx: Ctx, args: dict):
    pid = await _pod(ctx, args)
    name = _arg(args, "name", True, 255)
    await _chat_pod(ctx, pid)                             # 볼 수 없는 에이전트면 주소를 만들지 않는다
    url = await _link(ctx, "file", "up", pid, {"name": name})
    return _link_view(url, _up_command(url, _arg(args, "source", False, 1000) or name), max_bytes=wsp.MAX_FILE,
                      after="The response JSON has `name`; pass it in chat_send `files`.")


async def skill_upload(ctx: Ctx, args: dict):
    pid, profile = await _pod(ctx, args), _arg(args, "profile")
    await _chat_pod(ctx, pid)
    url = await _link(ctx, "skill", "up", pid, {"profile": profile})
    return _link_view(url, _up_command(url, _arg(args, "source", False, 1000) or "skill.zip"), max_bytes=skill_files.UPLOAD_MAX,
                      after="The response JSON is the check result (name, scripts, conflict, hash). Then call skill_apply with that hash. "
                            "Do not upload in parallel: the agent's skill API handles one request at a time.")


async def skill_apply(ctx: Ctx, args: dict):
    pid = await _pod(ctx, args)
    body = {"pod": pid, "profile": _arg(args, "profile"), "hash": _arg(args, "hash", True, 100)}
    if args.get("name"):
        body["name"] = _arg(args, "name", False, 64)
    if args.get("confirm_scripts"):
        body["confirm_scripts"] = True
    out = await ctx.call("POST", "/api/skill/apply", pid, body=body)
    return {**(out if isinstance(out, dict) else {"result": out}),
            "next": "Open a NEW chat (chat_start) to test: chats opened before the change may not see the new skill."}


async def env_upload_command(ctx: Ctx, args: dict):
    pid, profile, name = await _pod(ctx, args), _arg(args, "profile"), _arg(args, "name", True, 120)
    if not profiles.ENV_KEY.match(name):
        raise ToolError("invalid", "`name` uses uppercase letters, digits and _ (example: OPENWEATHER_API_KEY)")
    src_file, src_env = _arg(args, "source_file", False, 1000), _arg(args, "source_env", False, 120)
    if bool(src_file) == bool(src_env):
        raise ToolError("invalid", "give exactly one of `source_file` (local path) or `source_env` (local variable name)")
    if src_env and not profiles.ENV_KEY.match(src_env):
        raise ToolError("invalid", "`source_env` must be a variable name")
    await _chat_pod(ctx, pid)
    url = await _link(ctx, "env", "up", pid, {"profile": profile, "name": name})
    return _link_view(url, _up_command(url, src_env or src_file, env=bool(src_env)),
                      note="Run the command as is. Do not read or print the value; the agent receives it directly.")


async def credential_upload_command(ctx: Ctx, args: dict):
    pid, profile, slot = await _pod(ctx, args), _arg(args, "profile"), _arg(args, "slot", True, 80)
    path = _arg(args, "source_file", True, 1000)
    try:
        credential_files.slot_path(slot)
    except credential_files.Fail:
        raise ToolError("invalid", "`slot` is google_client_secret, google_token or secret:<name>")
    await _chat_pod(ctx, pid)
    url = await _link(ctx, "credential", "up", pid, {"profile": profile, "slot": slot})
    return _link_view(url, _up_command(url, path), max_bytes=credential_files.MAX_BYTES,
                      note="Run the command as is. Do not read the file; the agent receives it directly.")


async def secrets_status(ctx: Ctx, args: dict):
    pid = await _pod(ctx, args, required=False)
    profile = _arg(args, "profile")
    out = await ctx.call("GET", "/api/profile", pid, {"pod": pid, "name": profile})
    rows = out.get("env") or (out.get("profile") or {}).get("env") or []
    keep = ("name", "set", "locked", "lock_reason", "category")
    return {"pod": pid, "profile": profile, "env": [{k: r[k] for k in keep if k in r} for r in rows if isinstance(r, dict)],
            "can_edit": ((out.get("caps") or {}).get("env") or {}).get("can")}


async def credentials_status(ctx: Ctx, args: dict):
    pid = await _pod(ctx, args, required=False)
    return await ctx.call("GET", "/api/profile/credential-files", pid, {"pod": pid, "profile": _arg(args, "profile")})


# ---- 쓰기 도구(T5c) ------------------------------------------------------------------------------------
async def _profile_action(ctx: Ctx, pid: str, body: dict):
    """/api/profile/action — 화면의 프로파일 바꾸기와 같은 경로·권한(주인 금지 이름·https·형식 검사, owner_guard)."""
    return await ctx.call("POST", "/api/profile/action", pid, body={"pod": pid, **body})


# ---- M2 ① 성격·작업 지침·설정(스펙 §3-6-1, profile:write) ---------------------------------------------------------
TEXT_KINDS = ("soul", "agents", "config")                  # 성격(SOUL.md)·작업 지침(AGENTS.md)·설정(config.yaml)
TEXT_HINT = ("Lines with secret-looking values come back masked and are listed in masked_lines. "
             "The server refuses to save text that still contains a mask, so edit only files without masked_lines.")


def _kind(args: dict) -> str:
    kind = _arg(args, "kind", True, 10)
    if kind not in TEXT_KINDS:
        raise ToolError("invalid", "`kind` is soul, agents or config")
    return kind


async def profile_get(ctx: Ctx, args: dict):
    """화면의 프로파일 서랍과 같은 읽기(/api/profile). 글은 가린 채로, sha 는 저장할 때 base_sha 로 쓴다."""
    pid, profile = await _pod(ctx, args, required=False), _arg(args, "profile")
    out = await ctx.call("GET", "/api/profile", pid, {"pod": pid, "name": profile})
    row = out.get("profile") or {}
    res: dict = {"pod": pid, "profile": {k: row[k] for k in ("name", "title", "description", "is_default", "model") if k in row}}
    for kind in TEXT_KINDS:
        v = out.get(kind)
        if isinstance(v, dict) and isinstance(v.get("lines"), list):
            res[kind] = {"text": "\n".join(map(str, v["lines"]))[:INLINE_MAX], "sha": v.get("sha"), "versions": v.get("versions"),
                         **({"masked_lines": v["masked_lines"]} if v.get("masked_lines") else {}),
                         **({"readonly_reason": v["readonly_reason"]} if v.get("readonly_reason") else {})}
    if isinstance(out.get("toolsets"), list):
        res["toolsets"] = [{k: t[k] for k in ("name", "label", "enabled", "configured") if k in t} for t in out["toolsets"] if isinstance(t, dict)]
    caps = out.get("caps") or {}
    res["can_edit"] = {k: bool((caps.get(k) or {}).get("can")) for k in (*TEXT_KINDS, "tools")}
    res["note"] = TEXT_HINT
    return res


async def profile_text_preview(ctx: Ctx, args: dict):
    pid, profile, kind = await _pod(ctx, args), _arg(args, "profile"), _kind(args)
    return await _profile_action(ctx, pid, {"action": f"{kind}_preview", "name": profile, "content": _text_arg(args)})


def _text_arg(args: dict) -> str:
    content = args.get("content")
    if not isinstance(content, str) or len(content.encode()) > INLINE_MAX:
        raise ToolError("invalid", "`content` is the whole file text, up to 64KB")
    return content


async def profile_text_set(ctx: Ctx, args: dict):
    """화면의 저장과 같다: 버전을 남기고, base_sha 가 지금 버전과 다르면 409(busy). 설정의 잠긴 키는 주인이 바꿀 수 없다."""
    pid, profile, kind = await _pod(ctx, args), _arg(args, "profile"), _kind(args)
    body = {"action": kind, "name": profile, "content": _text_arg(args), "base_sha": _arg(args, "base_sha", False, 100),
            "note": _arg(args, "note", False, 200)}
    return await _profile_action(ctx, pid, body)


async def profile_text_versions(ctx: Ctx, args: dict):
    pid, profile, kind = await _pod(ctx, args, required=False), _arg(args, "profile"), _kind(args)
    return await ctx.call("GET", "/api/profile/soul/versions", pid, {"pod": pid, "name": profile, "kind": kind})


async def profile_text_revert(ctx: Ctx, args: dict):
    pid, profile, kind = await _pod(ctx, args), _arg(args, "profile"), _kind(args)
    try:
        vid = int(args.get("version_id"))
    except (TypeError, ValueError):
        raise ToolError("invalid", "`version_id` is an id from profile_text_versions")
    return await _profile_action(ctx, pid, {"action": f"{kind}_revert", "name": profile, "id": vid,
                                            "base_sha": _arg(args, "base_sha", False, 100)})


async def toolset_set(ctx: Ctx, args: dict):
    pid, profile = await _pod(ctx, args), _arg(args, "profile")
    if not isinstance(args.get("enabled"), bool):
        raise ToolError("invalid", "`enabled` is true or false")
    return await _profile_action(ctx, pid, {"action": "toolset", "name": profile, "target": _arg(args, "toolset", True, 80),
                                            "enabled": args["enabled"]})


async def profile_create(ctx: Ctx, args: dict):
    """주인은 주 프로파일 복제만·파드당 상한(owner_guard.create_error) — 화면과 같은 검사."""
    pid = await _pod(ctx, args)
    body = {"action": "create", "name": _arg(args, "name", True, 64), "description": _arg(args, "description", False, 300),
            "clone_from": _arg(args, "clone_from", False, 64)}
    if args.get("no_skills"):
        body["no_skills"] = True
    return await _profile_action(ctx, pid, body)


async def profile_rename(ctx: Ctx, args: dict):
    pid = await _pod(ctx, args)
    return await _profile_action(ctx, pid, {"action": "rename", "name": _arg(args, "profile"), "new_name": _arg(args, "new_name", True, 64)})


async def profile_delete(ctx: Ctx, args: dict):
    """화면과 같다: 기본·주 프로파일은 못 지우고, 확인용 이름이 맞아야 하며, 지우기 전에 내보내기 묶음을 남긴다."""
    pid, profile = await _pod(ctx, args), _arg(args, "profile")
    return await _profile_action(ctx, pid, {"action": "delete", "name": profile, "confirm": _arg(args, "confirm", True, 64)})


# ---- M2 ② 예약 작업(스펙 §3-6-2, cron) ------------------------------------------------------------------------
async def _cron_action(ctx: Ctx, pid: str, body: dict):
    """/api/cron/action — 화면과 같은 권한(may_change_cron)·정책(cron_policy: 프로파일·전달 대상) 검사."""
    return await ctx.call("POST", "/api/cron/action", pid, body={"pod": pid, **body})


async def cron_list(ctx: Ctx, args: dict):
    pid = await _pod(ctx, args, required=False)
    return await ctx.call("GET", "/api/cron/jobs", pid, {"pod": pid, "profile": _arg(args, "profile")})


async def cron_get(ctx: Ctx, args: dict):
    pid = await _pod(ctx, args, required=False)
    return await ctx.call("GET", "/api/cron/job", pid, {"pod": pid, "profile": _arg(args, "profile"), "id": _arg(args, "id", True, 120)})


async def cron_create(ctx: Ctx, args: dict):
    pid = await _pod(ctx, args)
    body = {"action": "create", "profile": _arg(args, "profile"), "job_name": _arg(args, "name", True, 80),
            "schedule": _arg(args, "schedule", True, 120), "prompt": _arg(args, "prompt", False, 4000),
            "skill": _arg(args, "skill", False, 120), "deliver": _arg(args, "deliver", False, 120)}
    if not (body["skill"] or body["prompt"]):
        raise ToolError("invalid", "give `skill`, `prompt` or both")
    return await _cron_action(ctx, pid, body)


async def cron_update(ctx: Ctx, args: dict):
    """화면은 칸마다 따로 저장한다. 준 칸만 차례로 보낸다(지시문은 버전을 남기고 base_sha 를 본다)."""
    pid, profile, jid = await _pod(ctx, args), _arg(args, "profile"), _arg(args, "id", True, 120)
    steps = []
    if args.get("schedule") is not None:
        steps.append({"action": "schedule", "schedule": _arg(args, "schedule", True, 120)})
    if args.get("deliver") is not None:
        steps.append({"action": "deliver", "deliver": _arg(args, "deliver", True, 120)})
    if args.get("skill") is not None:
        steps.append({"action": "skill", "skill": _arg(args, "skill", False, 120)})
    if args.get("prompt") is not None:
        steps.append({"action": "prompt", "content": _arg(args, "prompt", False, 4000), "base_sha": _arg(args, "base_sha", False, 100)})
    if not steps:
        raise ToolError("invalid", "give at least one of `schedule`, `deliver`, `skill`, `prompt`")
    out = None
    for step in steps:
        out = await _cron_action(ctx, pid, {"profile": profile, "id": jid, **step})
    return out


async def cron_run(ctx: Ctx, args: dict):
    pid, op = await _pod(ctx, args), _arg(args, "op", True, 10)
    if op not in ("pause", "resume", "trigger"):
        raise ToolError("invalid", "`op` is pause, resume or trigger")
    out = await _cron_action(ctx, pid, {"action": op, "profile": _arg(args, "profile"), "id": _arg(args, "id", True, 120)})
    if op == "trigger":
        return {**(out if isinstance(out, dict) else {"result": out}), "next": "Call cron_get later for the run, then chat_read with stored_id=<runs[].id> to read what the agent answered."}
    return out


async def cron_delete(ctx: Ctx, args: dict):
    pid = await _pod(ctx, args)
    return await _cron_action(ctx, pid, {"action": "delete", "profile": _arg(args, "profile"), "id": _arg(args, "id", True, 120),
                                         "job_name": _arg(args, "name", True, 80), "confirm": _arg(args, "confirm", True, 80)})


# ---- M2 ③ 프로파일 MCP 서버(스펙 §3-6-3, mcp:write) ---------------------------------------------------------------
MCP_ROW = ("name", "transport", "enabled", "target", "env_names", "auth", "forced", "login", "logged_in", "state")


async def mcp_list(ctx: Ctx, args: dict):
    """프로파일 서랍의 MCP 목록(env 값은 이름만). OAuth 서버는 로그인 상태가 붙는다."""
    pid, profile = await _pod(ctx, args, required=False), _arg(args, "profile")
    out = await ctx.call("GET", "/api/profile", pid, {"pod": pid, "name": profile})
    rows = out.get("mcp") if isinstance(out.get("mcp"), list) else []
    return {"pod": pid, "profile": profile, "servers": [{k: r[k] for k in MCP_ROW if k in r} for r in rows if isinstance(r, dict)],
            "can_edit": bool(((out.get("caps") or {}).get("mcp") or {}).get("can"))}


async def mcp_catalog(ctx: Ctx, args: dict):
    pid = await _pod(ctx, args)
    return await _profile_action(ctx, pid, {"action": "mcp_catalog", "name": _arg(args, "profile")})


async def mcp_add(ctx: Ctx, args: dict):
    """화면의 「서버 추가」와 같은 검사(이름·상한·주소 가능 여부·비밀값은 https 에서만). 토큰·env 값은 설정에 ${VAR} 로만 남는다."""
    pid, profile = await _pod(ctx, args), _arg(args, "profile")
    kind = _arg(args, "kind", True, 10)
    if kind not in ("url", "stdio"):
        raise ToolError("invalid", "`kind` is url or stdio")
    body = {"action": "mcp_add", "name": profile, "server": _arg(args, "server", True, 64), "kind": kind}
    for k in ("url", "auth", "bearer_token", "command"):
        if args.get(k) is not None:
            body[k] = _arg(args, k, False, 4000)
    for k in ("args", "env", "oauth_client", "tools_include"):
        if args.get(k) is not None:
            body[k] = args[k]
    return await _profile_action(ctx, pid, body)


async def mcp_install(ctx: Ctx, args: dict):
    pid = await _pod(ctx, args)
    body = {"action": "mcp_install", "name": _arg(args, "profile"), "server": _arg(args, "server", True, 64)}
    if args.get("env") is not None:
        body["env"] = args["env"]
    if args.get("write") is not None:
        body["write"] = bool(args["write"])
    return await _profile_action(ctx, pid, body)


async def mcp_remove(ctx: Ctx, args: dict):
    pid, server = await _pod(ctx, args), _arg(args, "server", True, 120)
    if _arg(args, "confirm", True, 120) != server:              # 화면은 확인 창이 막는다. 도구는 이름을 한 번 더 받는다
        raise ToolError("invalid", "`confirm` must repeat the server name")
    return await _profile_action(ctx, pid, {"action": "mcp_remove", "name": _arg(args, "profile"), "target": server})


async def mcp_toggle(ctx: Ctx, args: dict):
    pid = await _pod(ctx, args)
    if not isinstance(args.get("enabled"), bool):
        raise ToolError("invalid", "`enabled` is true or false")
    return await _profile_action(ctx, pid, {"action": "mcp", "name": _arg(args, "profile"), "target": _arg(args, "server", True, 120),
                                            "enabled": args["enabled"]})


async def mcp_test(ctx: Ctx, args: dict):
    pid = await _pod(ctx, args)
    return await _profile_action(ctx, pid, {"action": "mcp_test", "name": _arg(args, "profile"), "target": _arg(args, "server", True, 120)})


async def mcp_apply(ctx: Ctx, args: dict):
    pid = await _pod(ctx, args)
    out = await _profile_action(ctx, pid, {"action": "mcp_apply", "name": _arg(args, "profile")})
    return {**(out if isinstance(out, dict) else {"result": out}),
            "next": "The gateway restarts. Open a NEW chat (chat_start) to use the changed MCP servers."}


async def mcp_login_link(ctx: Ctx, args: dict):
    """원격 MCP 서버의 OAuth 로그인은 그 서비스의 본인 확인이라 사람이 한다(없앨 수 없는 사람 손, Q15). 화면 링크만 준다."""
    pid, profile, server = await _pod(ctx, args), _arg(args, "profile"), _arg(args, "server", True, 120)
    rows = (await mcp_list(ctx, {"pod": pid, "profile": profile}))["servers"]
    row = next((r for r in rows if r.get("name") == server), None)
    if row is None:
        raise ToolError("invalid", "no such MCP server in this profile; see mcp_list")
    if row.get("auth") != "oauth":                         # OAuth 가 아닌 서버에는 로그인할 것이 없다(2026-10-28 OKE 시험에서 auth 없는 서버에도 링크를 줌)
        raise ToolError("invalid", "this server does not use OAuth sign-in; put its key with env_upload_command instead")
    return {"url": _screen_link(ctx.request, pod=pid, name=profile, pane="tools", server=server),
            "note": "Ask the user to open the link and sign in to the service. Call mcp_list to see when it is logged in."}


# ---- M2 ④ 메신저 연결(스펙 §3-6-4, channels) ----------------------------------------------------------------------
CHANNEL_PLATFORMS = ("telegram", "discord", "slack", "mattermost")


def _platform(args: dict) -> str:
    plat = _arg(args, "platform", True, 20).lower()
    if plat not in CHANNEL_PLATFORMS:
        raise ToolError("invalid", "`platform` is telegram, discord, slack or mattermost")
    return plat


async def channel_list(ctx: Ctx, args: dict):
    """프로파일 서랍 「채널」 탭과 같은 읽기. 변수는 이름·설정 여부만(값은 없다)."""
    pid = await _pod(ctx, args, required=False)
    return await ctx.call("GET", "/api/channels/platforms", pid, {"pod": pid, "profile": _arg(args, "profile")})


async def channel_save(ctx: Ctx, args: dict):
    """비밀이 아닌 값(허용 사용자 ID 등)·켜고 끄기·변수 지우기. 봇 토큰은 channel_token_upload_command 로(값이 모델을 거치지 않게)."""
    pid, plat = await _pod(ctx, args), _platform(args)
    body: dict = {"action": "channel_save", "name": _arg(args, "profile"), "platform": plat}
    env = args.get("env")
    if env is not None:
        if not isinstance(env, dict) or not all(isinstance(k, str) and isinstance(v, str) for k, v in env.items()):
            raise ToolError("invalid", "`env` is an object of variable name to value")
        if any("TOKEN" in k or "SECRET" in k or "PASSWORD" in k for k in env):
            raise ToolError("invalid", "put tokens and secrets with channel_token_upload_command so the value never passes through this chat")
        body["env"] = env
    if args.get("clear_env") is not None:
        body["clear_env"] = args["clear_env"]
    if args.get("enabled") is not None:
        if not isinstance(args["enabled"], bool):
            raise ToolError("invalid", "`enabled` is true or false")
        body["enabled"] = args["enabled"]
    return await _profile_action(ctx, pid, body)


async def channel_token_upload_command(ctx: Ctx, args: dict):
    pid, profile, plat = await _pod(ctx, args), _arg(args, "profile"), _platform(args)
    name = _arg(args, "name", True, 120)
    if not profiles.ENV_KEY.match(name):
        raise ToolError("invalid", "`name` is the channel variable, e.g. TELEGRAM_BOT_TOKEN (see channel_list env_vars)")
    src_file, src_env = _arg(args, "source_file", False, 1000), _arg(args, "source_env", False, 120)
    if bool(src_file) == bool(src_env):
        raise ToolError("invalid", "give exactly one of `source_file` (local path) or `source_env` (local variable name)")
    if src_env and not profiles.ENV_KEY.match(src_env):
        raise ToolError("invalid", "`source_env` must be a variable name")
    await _chat_pod(ctx, pid)
    url = await _link(ctx, "channel", "up", pid, {"profile": profile, "platform": plat, "name": name})
    return _link_view(url, _up_command(url, src_env or src_file, env=bool(src_env)),
                      note="Run the command as is. Do not read or print the token; AAS saves it to the channel directly. Then call channel_test.")


async def channel_test(ctx: Ctx, args: dict):
    pid = await _pod(ctx, args)
    return await _profile_action(ctx, pid, {"action": "channel_test", "name": _arg(args, "profile"), "platform": _platform(args)})


async def pairing_answer(ctx: Ctx, args: dict):
    """메신저에서 봇에 말을 건 사람의 페어링 요청 승인, 또는 승인한 사용자 해제."""
    pid, plat, op = await _pod(ctx, args), _platform(args), _arg(args, "op", True, 10)
    body: dict = {"name": _arg(args, "profile"), "platform": plat}
    if op == "approve":
        body.update(action="pairing_approve", request_id=_arg(args, "request_id", True, 120))
    elif op == "revoke":
        body.update(action="pairing_revoke", user_id=_arg(args, "user_id", True, 120))
    else:
        raise ToolError("invalid", "`op` is approve or revoke")
    return await _profile_action(ctx, pid, body)


# ---- M2 ⑤ 마켓(스펙 §3-6-5, market) ----------------------------------------------------------------------------
MARKET_ROW = ("namespace", "namespace_label", "name", "kind", "summary", "version", "latest", "installed", "installed_version", "profiles", "tags", "visibility",
              "paid", "restricted", "new_version", "auto_versions")   # auto_versions: 관리자 검토 없이 게시된 판(D6) — 처음에 빠져 OKE 시험에서 보이지 않았다
# namespace_label·restricted: 사람에게 보이는 네임스페이스 이름(free → 요청 언어로 공용·shared)과 허용 필요 여부(= paid). 스펙 2026-10-28-010 D3·D11


def _label_of(labels: dict, ns: str) -> str:
    """응답의 namespace_labels 로, 없으면(옛 서버) 이 서버의 표로 이름을 정한다. 빈 값은 빈 값."""
    return str(labels.get(ns) or marketplace.ns_label(ns)) if ns else ""


async def market_list(ctx: Ctx, args: dict):
    """마켓(SkillHub) 패키지와 이 에이전트에 설치한 것. 화면 목록과 같은 /api/market — query 로 이름·요약을 거른다."""
    pid = await _pod(ctx, args, required=False)
    out = await ctx.call("GET", "/api/market", pid, {"pod": pid})
    q = _arg(args, "query", False, 80).lower()
    labels = out.get("namespace_labels") or {}
    rows = [{**r, "namespace_label": _label_of(labels, str(r.get("namespace") or ""))} for r in out.get("packages") or [] if isinstance(r, dict)]
    if q:                                                 # 표시 이름(shared)으로도 찾는다(D11)
        rows = [r for r in rows if q in f"{r.get('namespace', '')}/{r.get('name', '')} {r['namespace_label']}/{r.get('name', '')} {r.get('summary', '')}".lower()]
    return {"pod": pid, "packages": [{k: r[k] for k in MARKET_ROW if k in r} for r in rows[:50]], "total": len(rows),
            "can_install": out.get("can_install")}


async def market_install(ctx: Ctx, args: dict):
    """설치는 요청만 남긴다 — 서버의 배달기가 HermesTask 로 보낸다(화면과 같음). 결과는 market_list 의 installed 로 본다."""
    pid = await _pod(ctx, args)
    body = {"pod": pid, "profile": _arg(args, "profile"), "namespace": _arg(args, "namespace", True, 63), "name": _arg(args, "name", True, 63),
            "version": _arg(args, "version", False, 20), "mode": _arg(args, "mode", False, 20) or "install"}
    out = await ctx.call("POST", "/api/market/install", pid, body=body)
    return {**(out if isinstance(out, dict) else {"result": out}),
            "next": "Installing runs in the background. Check market_list (installed) in a minute, then open a NEW chat to use it."}


async def skill_delete(ctx: Ctx, args: dict):
    """내가 만들거나 올린 스킬을 보관함으로 옮긴다(스펙 2026-10-29-005 R5). 화면과 같은 REST·검사(권한·출처·같은 이름·이름 규칙).
    profile:write 범위 — 「스킬 개발」 묶음 토큰은 지우기를 얻지 않는다."""
    pid = await _pod(ctx, args)
    sid = await _skill_id(ctx, pid, _arg(args, "id", True, 400), _arg(args, "profile", False))
    return await ctx.call("POST", "/api/skill/delete", pid, body={"pod": pid, "id": sid})


async def market_remove(ctx: Ctx, args: dict):
    pid = await _pod(ctx, args)
    return await ctx.call("POST", "/api/market/remove", pid, body={"pod": pid, "profile": _arg(args, "profile"),
                                                                    "namespace": _arg(args, "namespace", True, 63), "name": _arg(args, "name", True, 63)})


async def market_publish(ctx: Ctx, args: dict):
    """올리기 요청. 주인이 이 AAS 로 만든 스킬이면 자동 승인(Q14, 뒤에서 게시), 아니면 관리자 승인을 기다린다. 검사는 화면과 같다."""
    pid = await _pod(ctx, args)
    out = await ctx.call("POST", "/api/market/publish", pid, body={"pod": pid, "profile": _arg(args, "profile"), "path": _arg(args, "path", True, 400),
                                                                   "name": _arg(args, "name", True, 63), "version": _arg(args, "version", True, 20),
                                                                   "namespace": _arg(args, "namespace", False, 63)})
    req = (out or {}).get("request") or {} if isinstance(out, dict) else {}
    target = req.get("auto_namespace_label") or _label_of({}, str(req.get("auto_namespace") or ""))
    nxt = (f"Approved automatically without admin review; publishing to {target} in the background. "
           "Check market_publish_status in a few seconds." if req.get("auto") == "pending" else
           f"The request waits for an admin to approve it (reason: {req.get('auto_reason') or 'manual'}). Check market_publish_status.")
    return {**(out if isinstance(out, dict) else {"result": out}), "next": nxt}


async def market_publish_status(ctx: Ctx, args: dict):
    pid = await _pod(ctx, args, required=False)
    out = await ctx.call("GET", "/api/market/publish", pid, {"pod": pid})
    if isinstance(out, dict) and isinstance(out.get("items"), list):          # 줄마다 사람에게 보이는 이름(D11)
        labels = out.get("namespace_labels") or {}
        out = {**out, "items": [{**r, "namespace_label": _label_of(labels, str(r.get("namespace") or "")),
                                 "want_namespace_label": _label_of(labels, str(r.get("want_namespace") or ""))} if isinstance(r, dict) else r
                                for r in out["items"]]}
    return out


async def skill_file_read(ctx: Ctx, args: dict):
    pid = await _pod(ctx, args, required=False)
    out = await ctx.call("GET", "/api/file", pid, {"pod": pid, "path": _arg(args, "path", True, 1000)})
    keep = ("path", "name", "size", "lines", "sha", "editable", "readonly_reason", "versions")
    return {k: out[k] for k in keep if k in out} if isinstance(out, dict) else out


async def skill_create(ctx: Ctx, args: dict):
    pid = await _pod(ctx, args)
    body = {"pod": pid, "profile": _arg(args, "profile"), "name": _arg(args, "name", True, 64),
            "description": _arg(args, "description", False, 300), "body": _arg(args, "body", False, INLINE_MAX)}
    if args.get("category"):
        body["category"] = _arg(args, "category", False, 60)
    return await ctx.call("POST", "/api/skill/create", pid, body=body)


async def skill_update(ctx: Ctx, args: dict):
    """스킬 파일 하나를 고친다. base_sha 를 안 주면 지금 버전 위에 쓴다(다른 사람이 그 사이 바꿨으면 화면처럼 409)."""
    pid, path = await _pod(ctx, args), _arg(args, "path", True, 1000)
    content = args.get("content")
    if not isinstance(content, str) or not content or len(content.encode()) > INLINE_MAX:
        raise ToolError("invalid", "`content` is the whole file text, up to 64KB")
    sha = _arg(args, "base_sha", False, 100)
    if not sha:
        sha = str((await ctx.call("GET", "/api/file", pid, {"pod": pid, "path": path})).get("sha") or "")
    out = await ctx.call("POST", "/api/file/save", pid,
                         body={"pod": pid, "path": path, "content": content, "base_sha": sha, "note": _arg(args, "note", False, 200)})
    keep = ("path", "sha", "versions", "saved")
    return {k: out[k] for k in keep if k in out} if isinstance(out, dict) else out


async def skill_toggle(ctx: Ctx, args: dict):
    pid = await _pod(ctx, args)
    if not isinstance(args.get("enabled"), bool):
        raise ToolError("invalid", "`enabled` is true or false")
    return await _profile_action(ctx, pid, {"action": "skill", "name": _arg(args, "profile"), "target": _arg(args, "name", True, 120),
                                            "enabled": args["enabled"]})


def _env_name(args: dict) -> str:
    name = _arg(args, "name", True, 120)
    if not profiles.ENV_KEY.match(name):
        raise ToolError("invalid", "`name` uses uppercase letters, digits and _ (example: OPENWEATHER_API_KEY)")
    return name


async def secret_set(ctx: Ctx, args: dict):
    pid, profile, name = await _pod(ctx, args), _arg(args, "profile"), _env_name(args)
    value = args.get("value")
    if not isinstance(value, str) or not value:
        raise ToolError("invalid", "`value` is required")
    await _profile_action(ctx, pid, {"action": "env_set", "name": profile, "target": name, "value": value})
    return {"ok": True, "name": name, "profile": profile}        # 값은 돌려주지 않는다


async def secret_clear(ctx: Ctx, args: dict):
    pid, profile, name = await _pod(ctx, args), _arg(args, "profile"), _env_name(args)
    await _profile_action(ctx, pid, {"action": "env_clear", "name": profile, "target": name, "confirm": _arg(args, "confirm")})
    return {"ok": True, "name": name, "profile": profile}


def _screen_link(request: Request, **params) -> str:
    """화면 바로가기(디자인 D11 — 지금 화면과 같은 /profiles?…&pane=env 형식, 링크에 비밀 없음, 만료 없음)."""
    return f"{base_url(request)}/#/profiles?{urlencode(params)}"


async def secret_request(ctx: Ctx, args: dict):
    pid, profile = await _pod(ctx, args), _arg(args, "profile")
    names = args.get("names")
    if not isinstance(names, list) or not names or not all(isinstance(n, str) and profiles.ENV_KEY.match(n) for n in names):
        raise ToolError("invalid", "`names` is a list of variable names")
    await _chat_pod(ctx, pid)
    return {"links": [{"name": n, "url": _screen_link(ctx.request, pod=pid, name=profile, pane="env", key=n)} for n in names[:20]],
            "note": "Ask the user to open each link and enter the value. Call secrets_status to see when it is set."}


def _slot(args: dict) -> tuple[str, str]:
    slot = _arg(args, "slot", True, 80)
    try:
        return slot, credential_files.slot_path(slot)
    except credential_files.Fail:
        raise ToolError("invalid", "`slot` is google_client_secret, google_token or secret:<name>")


async def credential_set(ctx: Ctx, args: dict):
    pid, profile = await _pod(ctx, args), _arg(args, "profile")
    slot, _path = _slot(args)
    doc = args.get("json")
    data = (doc if isinstance(doc, str) else json.dumps(doc, ensure_ascii=False)).encode() if doc not in (None, "") else b""
    if not data or len(data) > credential_files.MAX_BYTES:
        raise ToolError("invalid", "`json` is the file content, up to 64KB")
    return await ctx.call("PUT", "/api/profile/credential-file", pid, {"pod": pid, "profile": profile, "slot": slot}, data)


async def credential_clear(ctx: Ctx, args: dict):
    pid, profile = await _pod(ctx, args), _arg(args, "profile")
    slot, path = _slot(args)
    if _arg(args, "confirm") != slot:
        raise ToolError("invalid", "`confirm` must repeat the slot name")
    return await ctx.call("DELETE", "/api/profile/credential-file", pid, {"pod": pid, "profile": profile, "slot": slot, "confirm": path})


async def credential_request(ctx: Ctx, args: dict):
    pid, profile = await _pod(ctx, args), _arg(args, "profile")
    slot, path = _slot(args)
    await _chat_pod(ctx, pid)
    return {"url": _screen_link(ctx.request, pod=pid, name=profile, pane="env", file=path),
            "note": "Ask the user to open the link and upload the file. Call credentials_status to see when it exists."}


async def token_rotate(ctx: Ctx, args: dict):
    try:
        days = int(args.get("days") or tokens.DEFAULT_DAYS)
        view, raw = await anyio.to_thread.run_sync(lambda: tokens.rotate(ctx.row, days))
    except (TypeError, ValueError):
        raise ToolError("invalid", "`days` is 7, 30, 60 or 90")
    except tokens.TokenError as exc:
        raise ToolError("invalid", str(exc))
    return {"token": raw, "expires": view["expires"], "old_token_ends_in": int(tokens.ROTATE_GRACE),
            "next": "Replace the Authorization header value where this token is stored (keychain or environment variable), "
                    "then reconnect. Do not print the token into files tracked by git."}


def _tool(name, scope, fn, desc, props=None, required=()):
    return {"name": name, "scope": scope, "fn": fn,
            "spec": {"name": name, "description": desc,
                     "inputSchema": {"type": "object", "properties": props or {}, "required": list(required)}}}


TOOLS = {t["name"]: t for t in (
    _tool("agents_list", "chat", agents_list, "List the agents (POD) and profiles you can use."),
    _tool("chat_start", "chat", chat_start,
          "Open a new chat on an agent, or reopen a past one with resume=<stored_id>. Returns session_id and `after` for chat_wait, "
          "and stored_id once the agent has saved the chat (chat_wait also returns it).",
          {"pod": POD, "profile": PROFILE, "resume": _s("stored_id of a past chat to reopen"),
           "purpose": _s("skill-test keeps test chats out of the user's normal chat list", enum=list(chat_session_meta.PURPOSES))}, ("pod",)),
    _tool("chat_read", "chat", chat_read,
          "Read the last messages of a saved chat (stored_id from chat_start/chat_wait) or of a scheduled job run (runs[].id from cron_get). "
          "It reopens the chat, so you can then chat_send to it with the returned session_id.",
          {"pod": POD, "profile": PROFILE, "stored_id": _s("Saved chat id or cron run id"),
           "last": {"type": "integer", "description": "How many messages, 1-50 (default 10)"}}, ("pod", "stored_id")),
    _tool("chat_send", "chat", chat_send,
          "Send a message. Returns at once with `after`; then call chat_wait. `skill` runs that skill with the text as its input.",
          {"pod": POD, "session_id": SESSION, "text": _s("Message (up to 64KB)"), "skill": _s("Skill name to run"),
           "files": {"type": "array", "items": {"type": "string"}, "description": "Names of files uploaded to the chat workspace"}},
          ("pod", "session_id", "text")),
    _tool("chat_wait", "chat", chat_wait,
          "Wait up to 50s for events after `after`. state: running (call again with the returned `after`), done (text = answer), "
          "approval (call approval_respond), clarify (call clarify_answer), error, disconnected. Tool calls show name and state only.",
          {"pod": POD, "session_id": SESSION, "after": {"type": "integer", "description": "Last event number you saw"},
           "timeout": {"type": "number", "description": "Seconds to wait, 0-50 (default 50)"}}, ("pod", "session_id")),
    _tool("chat_interrupt", "chat", chat_interrupt, "Stop the answer in progress.", {"pod": POD, "session_id": SESSION},
          ("pod", "session_id")),
    _tool("approval_respond", "approve", approval_respond, "Answer an approval card from chat_wait.",
          {"pod": POD, "session_id": SESSION, "request_id": _s("request_id from the approval"),
           "choice": _s("once, session, always or deny", enum=list(APPROVAL_CHOICES))}, ("pod", "session_id", "choice")),
    _tool("clarify_answer", "approve", clarify_answer, "Answer a question the agent asked (clarify in chat_wait).",
          {"pod": POD, "session_id": SESSION, "request_id": _s("request_id from the question"),
           "answer": {"description": "Answer text, or the choice"}, "question_id": _s("For multi-question cards")},
          ("pod", "session_id", "request_id", "answer")),
    _tool("command_run", "commands", command_run, "Run a / command the chat screen allows (same allow list).",
          {"pod": POD, "session_id": SESSION, "command": _s("Command name without /"), "arg": _s("Arguments")},
          ("pod", "session_id", "command")),
    _tool("files_list", "files:read", files_list, "List files in the agent's chat workspace.", {"pod": POD}),
    _tool("skills_list", "chat", skills_list, "List skills (name, profile, description, enabled, origin).",
          {"pod": POD, "profile": _s("Only this profile")}),
    _tool("skill_get", "chat", skill_get,
          "Show one skill with its SKILL.md text and sha (skill_md, ready for skill_update), required secrets and whether each "
          "is set. zip=true adds a one-time download link for the folder.",
          {"pod": POD, "id": _s("Skill id from skills_list, or just the skill name"),
           "profile": _s("Profile, when the name is in several profiles"), "zip": {"type": "boolean"}}, ("id",)),
    _tool("file_get", "files:read", file_get,
          "Read a file from the chat workspace (path from files_list or chat_wait files). Text up to 64KB comes inline; "
          "otherwise a one-time curl command to save it locally.", {"pod": POD, "path": _s("Workspace path")}, ("path",)),
    _tool("file_put", "files:write", file_put,
          "Get a one-time curl command that uploads a local file to the chat workspace (up to 100MB, 10 minutes, once).",
          {"pod": POD, "name": _s("File name to save as"), "source": _s("Local path to upload (default: name)")}, ("pod", "name")),
    _tool("skill_upload", "skills:write", skill_upload,
          "Get a one-time curl command that uploads a skill folder zip (SKILL.md at the top, scripts allowed) for checking. "
          "Then call skill_apply with the returned hash. Owner of the agent only.",
          {"pod": POD, "profile": _s("Target profile"), "source": _s("Local zip path")}, ("pod", "profile")),
    _tool("skill_apply", "skills:write", skill_apply,
          "Apply a checked skill zip (hash from the skill_upload response). confirm_scripts=true is needed when it has scripts.",
          {"pod": POD, "profile": _s("Target profile"), "hash": _s("hash from the upload response"), "name": _s("Rename the skill"),
           "confirm_scripts": {"type": "boolean"}}, ("pod", "profile", "hash")),
    _tool("env_upload_command", "secrets:write", env_upload_command,
          "Get a one-time curl command that sends a secret (API key) to the profile's .env from a local file or environment variable, "
          "so the value never passes through this conversation. Prefer this over typing values.",
          {"pod": POD, "profile": _s("Profile name"), "name": _s("Variable name, e.g. OPENWEATHER_API_KEY"),
           "source_file": _s("Local file holding only the value"), "source_env": _s("Local environment variable holding the value")},
          ("pod", "profile", "name")),
    _tool("credential_upload_command", "secrets:write", credential_upload_command,
          "Get a one-time curl command that uploads a credential JSON file (up to 64KB) to a profile slot: google_client_secret, "
          "google_token or secret:<name> (skills read it at secrets/<name>.json in the profile).",
          {"pod": POD, "profile": _s("Profile name"), "slot": _s("Slot name"), "source_file": _s("Local JSON file path")},
          ("pod", "profile", "slot", "source_file")),
    _tool("profile_get", "chat", profile_get,
          "Read a profile: personality (soul = SOUL.md), work instructions (agents = AGENTS.md), settings (config = config.yaml) "
          "with each sha, toolsets, and what you may edit. " + TEXT_HINT,
          {"pod": POD, "profile": _s("Profile name")}, ("profile",)),
    _tool("profile_text_preview", "profile:write", profile_text_preview,
          "Show the diff and any problem (locked settings, invalid YAML) before saving soul, agents or config. Saves nothing.",
          {"pod": POD, "profile": _s("Profile name"), "kind": _s("soul, agents or config", enum=list(TEXT_KINDS)),
           "content": _s("Whole new file text")}, ("pod", "profile", "kind", "content")),
    _tool("profile_text_set", "profile:write", profile_text_set,
          "Save soul, agents or config of a profile (keeps a version). Give base_sha from profile_get; if someone changed it since, "
          "you get busy. Owners cannot change locked settings keys.",
          {"pod": POD, "profile": _s("Profile name"), "kind": _s("soul, agents or config", enum=list(TEXT_KINDS)),
           "content": _s("Whole new file text"), "base_sha": _s("sha from profile_get"), "note": _s("Change note")},
          ("pod", "profile", "kind", "content")),
    _tool("profile_text_versions", "chat", profile_text_versions, "List saved versions of soul, agents or config (id, time, who, note).",
          {"pod": POD, "profile": _s("Profile name"), "kind": _s("soul, agents or config", enum=list(TEXT_KINDS))}, ("profile", "kind")),
    _tool("profile_text_revert", "profile:write", profile_text_revert,
          "Restore soul, agents or config to a saved version (the current text is kept as a new version).",
          {"pod": POD, "profile": _s("Profile name"), "kind": _s("soul, agents or config", enum=list(TEXT_KINDS)),
           "version_id": {"type": "integer", "description": "id from profile_text_versions"}, "base_sha": _s("sha from profile_get")},
          ("pod", "profile", "kind", "version_id")),
    _tool("toolset_set", "profile:write", toolset_set, "Turn a toolset (group of agent tools) on or off for a profile.",
          {"pod": POD, "profile": _s("Profile name"), "toolset": _s("Toolset name from profile_get"), "enabled": {"type": "boolean"}},
          ("pod", "profile", "toolset", "enabled")),
    _tool("profile_create", "profile:write", profile_create,
          "Create a profile. Owners can only clone the main profile and have a per-agent limit.",
          {"pod": POD, "name": _s("lowercase-name"), "description": _s("What this profile is for"),
           "clone_from": _s("Profile to copy (empty = main)"), "no_skills": {"type": "boolean", "description": "Copy without skills"}},
          ("pod", "name")),
    _tool("profile_rename", "profile:write", profile_rename, "Rename a profile (not the main profile).",
          {"pod": POD, "profile": _s("Current name"), "new_name": _s("New lowercase-name")}, ("pod", "profile", "new_name")),
    _tool("profile_delete", "profile:write", profile_delete,
          "Delete a profile that is not the default or main one. `confirm` repeats the name. An export archive is made first; "
          "it fails while the profile has open chats.",
          {"pod": POD, "profile": _s("Profile name"), "confirm": _s("Same name again")}, ("pod", "profile", "confirm")),
    _tool("cron_list", "chat", cron_list, "List a profile's scheduled jobs (id, name, schedule, state, last run).",
          {"pod": POD, "profile": _s("Profile name")}, ("profile",)),
    _tool("cron_get", "chat", cron_get, "One scheduled job with its recent runs and delivery targets. Read a run's messages with chat_read(stored_id=runs[].id).",
          {"pod": POD, "profile": _s("Profile name"), "id": _s("Job id from cron_list")}, ("profile", "id")),
    _tool("cron_create", "cron", cron_create,
          "Create a scheduled job that runs a skill and/or instructions. schedule is a cron expression or text such as 'every 1h'. "
          "deliver is a target id from cron_get (default local).",
          {"pod": POD, "profile": _s("Profile name"), "name": _s("Job name"), "schedule": _s("When to run"),
           "skill": _s("Skill to run"), "prompt": _s("Instructions"), "deliver": _s("Where to send the result")},
          ("pod", "profile", "name", "schedule")),
    _tool("cron_update", "cron", cron_update,
          "Change a job's schedule, delivery, skill or instructions (only the fields you give). For instructions give base_sha "
          "from cron_get to avoid overwriting someone else's change.",
          {"pod": POD, "profile": _s("Profile name"), "id": _s("Job id"), "schedule": _s("New schedule"), "deliver": _s("New target"),
           "skill": _s("New skill (empty = none)"), "prompt": _s("New instructions"), "base_sha": _s("sha of the instructions you edited")},
          ("pod", "profile", "id")),
    _tool("cron_run", "cron", cron_run, "Pause, resume, or run a job now (trigger). After trigger, find the run in cron_get and read it with chat_read.",
          {"pod": POD, "profile": _s("Profile name"), "id": _s("Job id"), "op": _s("pause, resume or trigger", enum=["pause", "resume", "trigger"])},
          ("pod", "profile", "id", "op")),
    _tool("cron_delete", "cron", cron_delete, "Delete a job. `name` is the job's name and `confirm` repeats it.",
          {"pod": POD, "profile": _s("Profile name"), "id": _s("Job id"), "name": _s("Job name"), "confirm": _s("Same name again")},
          ("pod", "profile", "id", "name", "confirm")),
    _tool("mcp_list", "chat", mcp_list, "List a profile's MCP servers (name, transport, target, enabled, auth, env variable names only).",
          {"pod": POD, "profile": _s("Profile name")}, ("profile",)),
    _tool("mcp_catalog", "mcp:write", mcp_catalog, "MCP servers that can be installed from the catalog, with the variables each needs.",
          {"pod": POD, "profile": _s("Profile name")}, ("pod", "profile")),
    _tool("mcp_add", "mcp:write", mcp_add,
          "Add an MCP server to a profile. kind=url (remote; auth none, header or oauth) or stdio (command + args + env). "
          "Token and env values go to the profile's .env and the settings keep only ${VAR}; prefer putting keys with env_upload_command "
          "afterwards over passing values here. Then call mcp_apply.",
          {"pod": POD, "profile": _s("Profile name"), "server": _s("Server name"), "kind": _s("url or stdio", enum=["url", "stdio"]),
           "url": _s("Remote MCP URL"), "auth": _s("none, header or oauth", enum=["none", "header", "oauth"]), "bearer_token": _s("Token for auth=header"),
           "command": _s("stdio command"), "args": {"type": "array", "items": {"type": "string"}},
           "env": {"type": "object", "description": "stdio environment variables"},
           "tools_include": {"type": "array", "items": {"type": "string"}, "description": "Only these tools (remote header-auth servers)"}},
          ("pod", "profile", "server", "kind")),
    _tool("mcp_install", "mcp:write", mcp_install, "Install a catalog MCP server (name from mcp_catalog) with the variables it declares.",
          {"pod": POD, "profile": _s("Profile name"), "server": _s("Catalog entry name"), "env": {"type": "object"},
           "write": {"type": "boolean", "description": "Docmost/Outline: also enable write tools"}}, ("pod", "profile", "server")),
    _tool("mcp_remove", "mcp:write", mcp_remove, "Remove an MCP server (and its own MCP_ secrets). `confirm` repeats the server name.",
          {"pod": POD, "profile": _s("Profile name"), "server": _s("Server name"), "confirm": _s("Same name again")},
          ("pod", "profile", "server", "confirm")),
    _tool("mcp_toggle", "mcp:write", mcp_toggle, "Turn an MCP server on or off.",
          {"pod": POD, "profile": _s("Profile name"), "server": _s("Server name"), "enabled": {"type": "boolean"}},
          ("pod", "profile", "server", "enabled")),
    _tool("mcp_test", "mcp:write", mcp_test, "Try connecting to an MCP server and count its tools (up to 30 seconds).",
          {"pod": POD, "profile": _s("Profile name"), "server": _s("Server name")}, ("pod", "profile", "server")),
    _tool("mcp_apply", "mcp:write", mcp_apply, "Restart the agent's gateway so changed MCP servers take effect. Then open a new chat.",
          {"pod": POD, "profile": _s("Profile name")}, ("pod", "profile")),
    _tool("mcp_login_link", "mcp:write", mcp_login_link,
          "A link for the user to sign in to a remote OAuth MCP server on the AAS screen (a person must sign in to that service).",
          {"pod": POD, "profile": _s("Profile name"), "server": _s("Server name")}, ("pod", "profile", "server")),
    _tool("channel_list", "channels", channel_list,
          "Messenger channels (telegram, discord, slack, mattermost) of a profile: on/off, state, variable names and whether each is set, "
          "and pairing requests.", {"pod": POD, "profile": _s("Profile name")}, ("profile",)),
    _tool("channel_save", "channels", channel_save,
          "Turn a channel on or off, set non-secret variables (such as allowed user IDs) or clear variables. Owners cannot open a bot to "
          "everyone (*). Put bot tokens with channel_token_upload_command instead.",
          {"pod": POD, "profile": _s("Profile name"), "platform": _s("telegram, discord, slack or mattermost", enum=list(CHANNEL_PLATFORMS)),
           "env": {"type": "object", "description": "Non-secret variable name to value"},
           "clear_env": {"type": "array", "items": {"type": "string"}}, "enabled": {"type": "boolean"}}, ("pod", "profile", "platform")),
    _tool("channel_token_upload_command", "channels", channel_token_upload_command,
          "Get a one-time curl command that sends a channel token (e.g. TELEGRAM_BOT_TOKEN) from a local file or environment variable, "
          "so the value never passes through this conversation.",
          {"pod": POD, "profile": _s("Profile name"), "platform": _s("telegram, discord, slack or mattermost", enum=list(CHANNEL_PLATFORMS)),
           "name": _s("Variable name"), "source_file": _s("Local file holding only the token"), "source_env": _s("Local environment variable")},
          ("pod", "profile", "platform", "name")),
    _tool("channel_test", "channels", channel_test, "Check that the channel connects with the saved settings.",
          {"pod": POD, "profile": _s("Profile name"), "platform": _s("telegram, discord, slack or mattermost", enum=list(CHANNEL_PLATFORMS))},
          ("pod", "profile", "platform")),
    _tool("pairing_answer", "channels", pairing_answer, "Approve a pairing request (op=approve, request_id) or revoke a user (op=revoke, user_id).",
          {"pod": POD, "profile": _s("Profile name"), "platform": _s("telegram, discord, slack or mattermost", enum=list(CHANNEL_PLATFORMS)),
           "op": _s("approve or revoke", enum=["approve", "revoke"]), "request_id": _s("From channel_list pairing"), "user_id": _s("User to revoke")},
          ("pod", "profile", "platform", "op")),
    _tool("market_list", "chat", market_list, "Skill hub packages (namespace/name, summary, versions) and what is installed on this agent. "
          "query filters by name, namespace or summary. When you talk to a person, name the namespace by namespace_label (e.g. shared, restricted), "
          "not by namespace; send namespace to the other market tools.", {"pod": POD, "query": _s("Words to look for")}),
    _tool("market_install", "market", market_install,
          "Request installing (or updating, mode=update) a hub package into a profile. Runs in the background.",
          {"pod": POD, "profile": _s("Profile name"), "namespace": _s("Package namespace"), "name": _s("Package name"),
           "version": _s("Version (empty = latest)"), "mode": _s("install or update", enum=["install", "update"])},
          ("pod", "profile", "namespace", "name")),
    _tool("skill_delete", "profile:write", skill_delete,
          "Delete a skill you made or uploaded: Hermes moves it to the archive (restorable from the skill hub's archived list). "
          "Hub-installed and built-in skills are refused. `id` is the skill id from skills_list.",
          {"pod": POD, "id": _s("Skill id from skills_list (or its name)"), "profile": _s("Profile name when the name exists in several profiles")}, ("pod", "id")),
    _tool("market_remove", "market", market_remove, "Request removing an installed hub package from a profile.",
          {"pod": POD, "profile": _s("Profile name"), "namespace": _s("Package namespace"), "name": _s("Package name")},
          ("pod", "profile", "namespace", "name")),
    _tool("market_publish", "market", market_publish,
          "Request publishing a skill folder (path relative to the profile, e.g. skills/uploaded/<name>) to the skill hub. A skill the agent's "
          "owner made on this AAS (skill_create, skill_upload, skill_update) and nobody changed since is approved automatically without "
          "admin review; otherwise an admin approves it. Same checks as the screen (name, version, secrets; internal addresses are refused "
          "for public namespaces).",
          {"pod": POD, "profile": _s("Profile name"), "path": _s("Skill folder path relative to the profile"), "name": _s("Package name"),
           "version": _s("Version, e.g. 1.0.0"), "namespace": _s("Target namespace (empty = the admin's default for automatic approval)")},
          ("pod", "profile", "path", "name", "version")),
    _tool("market_publish_status", "chat", market_publish_status, "Publish requests of this agent and their status (waiting, approved, rejected). "
          "When you talk to a person, use namespace_label and want_namespace_label.",
          {"pod": POD}),
    _tool("skill_file_read", "chat", skill_file_read, "Read one skill file (e.g. profiles/<p>/skills/<name>/SKILL.md) with its sha for skill_update.",
          {"pod": POD, "path": _s("File path from skill_get")}, ("path",)),
    _tool("skill_create", "skills:write", skill_create,
          "Create a new skill with one SKILL.md. For folders with scripts use skill_upload.",
          {"pod": POD, "profile": _s("Target profile"), "name": _s("lowercase-name"), "description": _s("When to use it"),
           "body": _s("SKILL.md body (or the whole file starting with ---)"), "category": _s("Category")},
          ("pod", "profile", "name")),
    _tool("skill_update", "skills:write", skill_update,
          "Replace one skill file. Give base_sha from skill_file_read to avoid overwriting someone else's change (409 busy).",
          {"pod": POD, "path": _s("File path"), "content": _s("Whole new file text"), "base_sha": _s("sha you edited"),
           "note": _s("Change note")}, ("pod", "path", "content")),
    _tool("skill_toggle", "skills:write", skill_toggle, "Turn a skill on or off for a profile.",
          {"pod": POD, "profile": _s("Profile name"), "name": _s("Skill name"), "enabled": {"type": "boolean"}},
          ("pod", "profile", "name", "enabled")),
    _tool("secret_set", "secrets:write", secret_set,
          "Set a secret from a value already in this conversation. The value is stored in the model provider's and Claude Code's "
          "history: prefer env_upload_command.",
          {"pod": POD, "profile": _s("Profile name"), "name": _s("Variable name"), "value": _s("Value")},
          ("pod", "profile", "name", "value")),
    _tool("secret_clear", "secrets:write", secret_clear, "Remove a secret. `confirm` repeats the variable name.",
          {"pod": POD, "profile": _s("Profile name"), "name": _s("Variable name"), "confirm": _s("Same name again")},
          ("pod", "profile", "name", "confirm")),
    _tool("secret_request", "secrets:write", secret_request,
          "Links for the user to enter secrets on the AAS screen, when the value is not on this machine.",
          {"pod": POD, "profile": _s("Profile name"), "names": {"type": "array", "items": {"type": "string"}}},
          ("pod", "profile", "names")),
    _tool("credential_set", "secrets:write", credential_set,
          "Store a credential JSON already in this conversation (stays in history: prefer credential_upload_command).",
          {"pod": POD, "profile": _s("Profile name"), "slot": _s("Slot name"), "json": {"description": "JSON text or object"}},
          ("pod", "profile", "slot", "json")),
    _tool("credential_clear", "secrets:write", credential_clear, "Remove a credential file. `confirm` repeats the slot name.",
          {"pod": POD, "profile": _s("Profile name"), "slot": _s("Slot name"), "confirm": _s("Same slot again")},
          ("pod", "profile", "slot", "confirm")),
    _tool("credential_request", "secrets:write", credential_request,
          "A link for the user to upload a credential file on the AAS screen, when the file is not on this machine.",
          {"pod": POD, "profile": _s("Profile name"), "slot": _s("Slot name")}, ("pod", "profile", "slot")),
    _tool("token_rotate", "chat", token_rotate,
          "Issue a new personal access token for this connection (same name and scopes); the old one ends in 1 hour. "
          "Not for OAuth connections (they renew by themselves).",
          {"days": {"type": "integer", "enum": list(tokens.EXPIRY_DAYS)}}),
    _tool("secrets_status", "chat", secrets_status, "Secret (.env) names of a profile and whether each is set. Values are never shown.",
          {"pod": POD, "profile": _s("Profile name")}, ("profile",)),
    _tool("credentials_status", "chat", credentials_status,
          "Credential JSON file slots of a profile and whether each exists. Contents are never shown.",
          {"pod": POD, "profile": _s("Profile name")}, ("profile",)),
)}


def tools_for(scopes: set[str]) -> list[dict]:
    """그 토큰 범위로 쓸 수 있는 도구만(D14)."""
    return [t["spec"] for t in TOOLS.values() if t["scope"] in scopes]


def _result(payload, error: ToolError | None = None) -> dict:
    if error is not None:
        body = {"error": error.word, **({"message": error.message} if error.message and error.message != error.word else {}),
                **({"next": error.hint} if error.hint else {})}
        return {"content": [{"type": "text", "text": json.dumps(body, ensure_ascii=False)}], "isError": True}
    return {"content": [{"type": "text", "text": json.dumps(payload, ensure_ascii=False, default=str)}], "isError": False}


async def _reconnect_hint(args: dict) -> str:
    """reconnect 안내에 바로 쓸 resume 값을 넣는다. 대화 메타 테이블에 Hermes 가 저장한 번호가 있으면 그것, 없으면 새 대화
    (2026-10-28: 안내가 resume=<stored_id> 였는데 어느 도구도 그 번호를 주지 않아 따를 수 없었다)."""
    pid, sid = str(args.get("pod") or ""), str(args.get("session_id") or "")
    hit = await anyio.to_thread.run_sync(chat_session_meta.lookup, pid, sid) if pid and sid else None
    if not hit:
        return _hint("reconnect")
    prof = hit["profile"] or "main"
    return tr(f"이 서버에서 대화가 사라졌습니다. chat_start 를 pod={pid}, profile={prof}, resume={hit['stored_id']} 로 불러 "
              "다시 연 뒤 chat_wait 를 다시 부르거나 다시 보내세요",
              f"the chat is gone from this server; call chat_start with pod={pid}, profile={prof}, "
              f"resume={hit['stored_id']} to reopen it, then call chat_wait again or send again")


async def call_tool(ctx: Ctx, params: dict) -> dict:
    name = str(params.get("name") or "")
    args = params.get("arguments") or {}
    tool = TOOLS.get(name)
    if tool is None:
        raise _RpcError(-32602, f"unknown tool: {name}")
    if not isinstance(args, dict):
        raise _RpcError(-32602, "arguments must be an object")
    word = "ok"
    try:
        if tool["scope"] not in ctx.scopes:
            raise ToolError("forbidden", f"this connection does not have the `{tool['scope']}` scope")
        if await anyio.to_thread.run_sync(mcp_limits.hit, ctx.email) > mcp_limits.per_minute():
            raise ToolError("busy", f"up to {mcp_limits.per_minute()} calls a minute", _hint("busy"))
        out = _result(await tool["fn"](ctx, args))
    except ToolError as exc:
        word = exc.word
        if exc.word == "reconnect":
            exc.hint = await _reconnect_hint(args)
        out = _result(None, exc)
    # 도구 이름·대상 POD·결과 낱말만 남긴다. 글·값은 남기지 않는다(§3-1 기록)
    await _log("mcp_call", f"{ctx.email} {name} pod={str(args.get('pod') or '')[:80]} {word}")
    return out


async def _log(kind: str, note: str) -> None:
    """토큰으로 한 일의 기록(끝에 via=token, F8)."""
    mark = store.actor_via.set("token")
    try:
        await anyio.to_thread.run_sync(store.log_usage, kind, note)
    finally:
        store.actor_via.reset(mark)


class _RpcError(Exception):
    def __init__(self, code: int, message: str):
        super().__init__(message)
        self.code, self.message = code, message


def _rpc(mid, result=None, error: _RpcError | None = None) -> dict:
    if error is not None:
        return {"jsonrpc": "2.0", "id": mid, "error": {"code": error.code, "message": error.message}}
    return {"jsonrpc": "2.0", "id": mid, "result": result}


async def endpoint(request: Request) -> Response:
    a = server.auth()
    if not a.enabled:                                     # 로그인을 끈 설치에는 /mcp 가 없다(재검토 D5)
        return JSONResponse({"error": "not found"}, 404)
    if request.headers.get("origin"):                     # 브라우저 안 스크립트의 호출(§3-2)
        return _deny(403, "forbidden", "origin")
    if not request.headers.get("accept-language"):
        i18n.set_lang(MCP_LANG)
    if request.method == "GET":                           # 서버가 먼저 보내는 SSE 흐름은 없다(D7)
        return Response(status_code=405, headers={"Allow": "POST, DELETE"})
    row, denied = await anyio.to_thread.run_sync(_authenticate, _bearer(request))
    if denied is not None:
        if denied.status_code == 401:                     # Claude Code 가 여기서 OAuth 메타데이터를 찾는다(§3-1-2 1단계)
            meta = f'Bearer resource_metadata="{base_url(request)}/.well-known/oauth-protected-resource"'
            reason = json.loads(denied.body).get("reason", "")
            denied.headers["WWW-Authenticate"] = meta + (f', error="invalid_token", error_description="{reason}"' if _bearer(request) else "")
        return denied
    await anyio.to_thread.run_sync(tokens.mark_used, row["id"], _client_ip(request))
    if request.method == "DELETE":                        # 세션은 서명된 값이라 지울 것이 없다
        return Response(status_code=204)
    raw = await request.body()
    if len(raw) > BODY_MAX:
        return JSONResponse(_rpc(None, error=_RpcError(-32600, "request too large")), 413)
    try:
        msg = json.loads(raw)
    except ValueError:
        return JSONResponse(_rpc(None, error=_RpcError(-32700, "parse error")), 400)
    if not isinstance(msg, dict) or msg.get("jsonrpc") != "2.0":
        return JSONResponse(_rpc(None, error=_RpcError(-32600, "invalid request")), 400)
    method, mid = msg.get("method"), msg.get("id")
    if not isinstance(method, str) or mid is None:        # 알림(notifications/initialized 등)·클라이언트의 응답
        return Response(status_code=202)
    params = msg.get("params") if isinstance(msg.get("params"), dict) else {}
    headers = {"Cache-Control": "no-store"}
    if method == "initialize":
        wanted = str(params.get("protocolVersion") or "")
        headers["Mcp-Session-Id"] = mcp_limits.session_id(row["family"])
        return JSONResponse(_rpc(mid, {"protocolVersion": wanted if wanted in PROTOCOLS else PROTOCOLS[0],
                                       "capabilities": {"tools": {"listChanged": False}},
                                       "serverInfo": {"name": "cogentai-aas", "version": "1"},
                                       "instructions": INSTRUCTIONS}), headers=headers)
    given = request.headers.get("mcp-session-id", "")
    if not given:
        return JSONResponse(_rpc(mid, error=_RpcError(-32600, "Mcp-Session-Id header required")), 400)
    if mcp_limits.session_family(given) != row["family"]:   # 다른 연결의 번호·위조 — 다시 initialize 하게 404(MCP 규약)
        return JSONResponse(_rpc(mid, error=_RpcError(-32001, "session not found")), 404)
    ctx = Ctx(request, row)
    try:
        if method == "ping":
            result = {}
        elif method == "tools/list":
            result = {"tools": tools_for(ctx.scopes)}
        elif method == "tools/call":
            result = await call_tool(ctx, params)
        else:
            raise _RpcError(-32601, f"method not found: {method}")
    except _RpcError as exc:
        return JSONResponse(_rpc(mid, error=exc), headers=headers)
    return JSONResponse(_rpc(mid, result), headers=headers)


# ---- /mcp/transfer/<키> -------------------------------------------------------------------------------
TRANSFER_SCOPES = {("up", "file"): "files:write", ("up", "skill"): "skills:write", ("up", "env"): "secrets:write", ("up", "channel"): "channels",
                   ("up", "credential"): "secrets:write", ("down", "file"): "files:read", ("down", "skill"): "chat",
                   ("down", "answer"): "chat"}
ENV_BODY_MAX = 4096                                       # 값 4000자(env_set 의 한도) + 끝 줄바꿈 여유


def _up_limit(kind: str) -> int:
    return {"file": wsp.MAX_FILE, "skill": skill_files.UPLOAD_MAX, "credential": credential_files.MAX_BYTES}.get(kind, ENV_BODY_MAX)


def _check_transfer(key: str, direction: str) -> tuple[dict | None, dict | None, JSONResponse | None]:
    """(전송 줄, 토큰 줄, 거절). 스레드에서 돈다. 키는 여기서 쓴 것으로 표시된다."""
    state, t = mcp_transfers.take(key, direction)
    if state == "unknown":
        return None, None, _deny(404, "invalid", "unknown_transfer")
    if state != "ok":
        return None, None, _deny(410, "invalid", state)        # 이미 씀·만료 — 도구를 다시 불러 새 주소를 받는다
    row = mcp_transfers.family_active(t["family"])
    if row is None:                                            # 주소를 만든 뒤 연결을 끊었다
        return None, None, _deny(401, "auth", "revoked")
    ok = member(row["user_email"])
    if ok is None:
        return None, None, _deny(503, "unavailable", "member_check")
    if not ok:
        tokens.revoke_all(row["user_email"], by="keycloak")
        return None, None, _deny(401, "auth", "removed")
    if TRANSFER_SCOPES[(direction, t["kind"])] not in row["scopes"].split():
        return None, None, _deny(403, "forbidden", "scope")
    return t, row, None


class _Relay:
    """바깥 요청의 본문·응답을 그대로 흘려보내는 같은 프로세스 안 요청(올리기 100MB·받기를 메모리에 모으지 않는다)."""

    def __init__(self, app, scope: dict, note: str):
        self.app, self.scope, self.note = app, scope, note

    async def __call__(self, scope, receive, send):
        status = [0]

        async def watch(msg):
            if msg["type"] == "http.response.start":
                status[0] = msg["status"]
            await send(msg)
        mark = store.actor_via.set("token")
        try:
            await self.app(self.scope, receive, watch)
        finally:
            store.actor_via.reset(mark)
            await _log("mcp_transfer", f"{self.note} status={status[0]}")


async def transfer(request: Request) -> Response:
    a = server.auth()
    if not a.enabled:
        return JSONResponse({"error": "not found"}, 404)
    if request.headers.get("origin"):
        return _deny(403, "forbidden", "origin")
    direction = "down" if request.method == "GET" else "up"
    if direction == "up":
        raw_len = request.headers.get("content-length", "")
        if not raw_len.isdigit():                         # 키를 쓰기 전에 거절한다(다시 보낼 수 있게)
            return _deny(411, "invalid", "length")
    t, row, denied = await anyio.to_thread.run_sync(_check_transfer, request.path_params["key"], direction)
    if denied is not None:
        return denied
    user, pod, kind, prm = token_user(row), t["pod"], t["kind"], t["params"]
    note = f"{row['user_email']} {direction} {kind} pod={pod}"
    if direction == "up" and int(request.headers["content-length"]) > _up_limit(kind):
        return _deny(413, "invalid", "too_large")
    if kind == "answer":
        await _log("mcp_transfer", f"{note} status=200")
        return Response(t["body"], media_type="text/markdown; charset=utf-8", headers={"Cache-Control": "no-store"})
    if kind in ("env", "channel"):                         # 값은 기록·응답·예외 어디에도 넣지 않는다(3-4-1). channel 은 봇 토큰(M2 ④)
        raw = await request.body()
        try:
            value = raw.decode("utf-8")
        except UnicodeDecodeError:
            return _deny(400, "invalid", "not_utf8")
        value = value[:-2] if value.endswith("\r\n") else value[:-1] if value.endswith("\n") else value
        ctx = Ctx(request, row)
        if kind == "env":
            action = {"action": "env_set", "name": prm["profile"], "target": prm["name"], "value": value}
        else:                                             # 주인은 채널 변수를 env_set 으로 못 넣는다 — 화면의 채널 저장과 같은 검사(owner_guard.channel_env_check)
            action = {"action": "channel_save", "name": prm["profile"], "platform": prm["platform"], "env": {prm["name"]: value}}
        status, out = await ctx.api("POST", "/api/profile/action", pod, body={"pod": pod, **action})
        del value, raw
        await _log("mcp_transfer", f"{note} name={prm['name']} status={status}")
        if 200 <= status < 300:
            return JSONResponse({"ok": True, "name": prm["name"], "profile": prm["profile"]})
        try:
            _ok(status, out)
        except ToolError as exc:
            return JSONResponse({"error": exc.word, **({"message": exc.message} if exc.message else {})}, status)
    extra = [(b"content-length", request.headers["content-length"].encode()),
             (b"content-type", b"application/octet-stream")] if direction == "up" else []
    if (direction, kind) == ("down", "file"):
        target = ("GET", "/api/chat/files", {"pod": pod, "path": prm["path"]})
    elif (direction, kind) == ("down", "skill"):
        target = ("GET", "/api/skill/download", {"pod": pod, "profile": prm["profile"], "path": prm["path"]})
    elif kind == "file":
        target = ("PUT", "/api/chat/files", {"pod": pod, "name": prm["name"]})
    elif kind == "skill":
        target = ("POST", "/api/skill/upload", {"pod": pod, "profile": prm["profile"]})
    else:
        target = ("PUT", "/api/profile/credential-file", {"pod": pod, "profile": prm["profile"], "slot": prm["slot"]})
    return _Relay(request.app, inner_scope(request.scope, user, pod, target[0], target[1], target[2], extra), note)


def routes() -> list:
    return [Route("/mcp", endpoint, methods=["GET", "POST", "DELETE"]),
            Route("/mcp/transfer/{key}", transfer, methods=["GET", "PUT", "POST"])]

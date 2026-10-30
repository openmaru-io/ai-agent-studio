# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""MCP OAuth 의 웹 쪽 — 메타데이터·등록·동의 화면·토큰(스펙 2026-10-28-001 §3-1-1 A·§3-7 ①, OMAI-1513).

- `/.well-known/oauth-protected-resource`·`/.well-known/oauth-authorization-server`: Claude Code 가 401 뒤에 찾는다.
- `/mcp/oauth/register`·`/mcp/oauth/token`: MCP Ingress(어느 파드든, 값은 DB).
- `/oauth/connect/authorize`: 기본 Ingress, 브라우저 쿠키 세션. 없으면 같은 창으로 로그인에 보냈다가 돌아온다(D12).
로그인을 끈 설치에는 모두 없다(404).
"""
from __future__ import annotations

import hashlib
import hmac
import html
import json
from urllib.parse import quote, urlencode, urlsplit, urlunsplit, parse_qsl

import anyio
from starlette.requests import Request
from starlette.responses import JSONResponse, RedirectResponse, Response
from starlette.routing import Route

from ..auth import auth as auth_mod
from ..auth import mcp_limits, oauth_connect, tokens
from ..common import store
from ..common.i18n import tr
from . import mcp_server, server

AUTHORIZE_PATH = "/oauth/connect/authorize"
PARAMS = ("response_type", "client_id", "redirect_uri", "code_challenge", "code_challenge_method", "state", "scope", "resource")


def _off() -> JSONResponse | None:
    return None if server.auth().enabled else JSONResponse({"error": "not found"}, 404)


# ---- 메타데이터 -----------------------------------------------------------------------------------------
async def protected_resource(request: Request) -> Response:
    if (off := _off()) is not None:
        return off
    base = mcp_server.base_url(request)
    return JSONResponse({"resource": base + "/mcp", "authorization_servers": [base], "bearer_methods_supported": ["header"],
                         "scopes_supported": list(tokens.SCOPES), "resource_name": "CogentAI AAS"},
                        headers={"Cache-Control": "no-store"})


async def authorization_server(request: Request) -> Response:
    if (off := _off()) is not None:
        return off
    base = mcp_server.base_url(request)
    return JSONResponse({"issuer": base, "authorization_endpoint": base + AUTHORIZE_PATH, "token_endpoint": base + "/mcp/oauth/token",
                         "registration_endpoint": base + "/mcp/oauth/register", "response_types_supported": ["code"],
                         "grant_types_supported": ["authorization_code", "refresh_token"], "code_challenge_methods_supported": ["S256"],
                         "token_endpoint_auth_methods_supported": ["none"], "scopes_supported": list(tokens.SCOPES)},
                        headers={"Cache-Control": "no-store"})


def _oauth_error(exc: oauth_connect.OAuthError) -> JSONResponse:
    return JSONResponse({"error": exc.error, **({"error_description": exc.description} if exc.description else {})}, exc.status,
                        headers={"Cache-Control": "no-store"})


# ---- 등록·토큰 --------------------------------------------------------------------------------------------
async def register(request: Request) -> Response:
    if (off := _off()) is not None:
        return off
    if request.headers.get("origin"):
        return mcp_server._deny(403, "forbidden", "origin")
    raw = await request.body()
    if len(raw) > 16 * 1024:
        return JSONResponse({"error": "invalid_client_metadata"}, 413)
    try:
        meta = json.loads(raw or b"{}")
        if not isinstance(meta, dict):
            raise ValueError
    except ValueError:
        return JSONResponse({"error": "invalid_client_metadata", "error_description": "JSON object expected"}, 400)
    try:
        out = await anyio.to_thread.run_sync(oauth_connect.register, meta)
    except oauth_connect.OAuthError as exc:
        return _oauth_error(exc)
    return JSONResponse(out, 201, headers={"Cache-Control": "no-store"})


async def token(request: Request) -> Response:
    if (off := _off()) is not None:
        return off
    if request.headers.get("origin"):
        return mcp_server._deny(403, "forbidden", "origin")
    raw = await request.body()
    if len(raw) > 16 * 1024:
        return JSONResponse({"error": "invalid_request"}, 413)
    form = dict(parse_qsl(raw.decode("utf-8", "replace")))
    grant = form.get("grant_type", "")
    try:
        if grant == "authorization_code":
            out = await anyio.to_thread.run_sync(oauth_connect.exchange, form)
        elif grant == "refresh_token":
            out = await anyio.to_thread.run_sync(lambda: oauth_connect.refresh(form, mcp_server.member))
        else:
            raise oauth_connect.OAuthError("unsupported_grant_type")
    except oauth_connect.OAuthError as exc:
        return _oauth_error(exc)
    return JSONResponse(out, headers={"Cache-Control": "no-store", "Pragma": "no-cache"})


# ---- 동의 화면 -------------------------------------------------------------------------------------------
def _csrf(session: str, client_id: str) -> str:
    """그 브라우저 세션·그 클라이언트에만 맞는 값(F3). 세션 원문이 아니라 HMAC 만 화면에 둔다."""
    return hmac.new(mcp_limits._key(), b"aas-consent-v1:" + session.encode() + b":" + client_id.encode(), hashlib.sha256).hexdigest()


def _card(title: str, body: str, status: int = 200, sub: str = "") -> Response:
    # Referrer-Policy 는 same-origin — no-referrer 면 Chrome 이 동의 POST 에 Origin: null 을 실어 같은 출처 검사가 늘 거절한다
    # (2026-10-28 실제 Claude Code 로 확인하다 걸림). same-origin 이라도 Claude Code 의 루프백 주소(다른 출처)에는 보내지 않는다
    return Response(server._page(title, body, sub), status, media_type="text/html; charset=utf-8",
                    headers={"X-Frame-Options": "DENY", "Cache-Control": "no-store", "Referrer-Policy": "same-origin"})


def _restart(status: int = 400) -> Response:
    """만료·이미 쓴 요청·CSRF 실패(§3-7 ① 상태)."""
    return _card(tr("다시 시작하세요", "Start again"),
                 "<p>" + tr("이 연결 요청은 더 쓸 수 없습니다. Claude Code 에서 다시 시작하세요.",
                            "This connection request can no longer be used. Start again from Claude Code.") + "</p>", status)


def _back(redirect_uri: str, **params) -> Response:
    """Claude Code 의 루프백 주소로 돌려보낸다(code 나 error)."""
    u = urlsplit(redirect_uri)
    q = urlencode([*parse_qsl(u.query), *[(k, v) for k, v in params.items() if v]])
    return RedirectResponse(urlunsplit((u.scheme, u.netloc, u.path, q, "")), 303, headers={"Cache-Control": "no-store"})


def _login_redirect(request: Request) -> Response:
    """세션이 없다 — SSO 만 있으면 로그인 카드 없이 같은 창에서 SSO 로(디자인 D12, 재검토 F5·F6), 아니면 로그인 카드로. 돌아오면 이 주소."""
    a = server.auth()
    nxt = AUTHORIZE_PATH + ("?" + request.url.query if request.url.query else "")
    if a.oidc_enabled and not a.password_enabled:
        return RedirectResponse("/auth/oidc?next=" + quote(nxt, safe=""), 303)
    return RedirectResponse("/auth/login?next=" + quote(nxt, safe=""), 303)


def _validate(params: dict) -> tuple[dict | None, Response | None]:
    """(클라이언트, 거절). 클라이언트·돌아갈 주소가 틀리면 리디렉트하지 않고 오류 카드(§3-7 ①). 그 밖은 Claude Code 로 오류를 돌려준다."""
    c = oauth_connect.client(params.get("client_id", ""))
    if c is None or not oauth_connect.check_redirect(c, params.get("redirect_uri", "")):
        return None, _card(tr("연결할 수 없습니다", "Cannot connect"),
                           "<p>" + tr("모르는 클라이언트이거나 돌아갈 주소가 이 컴퓨터(localhost)가 아닙니다. Claude Code 에서 다시 시작하세요.",
                                      "Unknown client, or the return address is not this computer (localhost). Start again from Claude Code.")
                           + "</p>", 400)
    if params.get("response_type") != "code" or params.get("code_challenge_method") != "S256" or not params.get("code_challenge"):
        return None, _back(params["redirect_uri"], error="invalid_request",
                           error_description="response_type=code and PKCE S256 are required", state=params.get("state", ""))
    return c, None


def _hidden(params: dict) -> str:
    return "".join(f"<input type=hidden name={k} value='{html.escape(params[k], quote=True)}'>" for k in PARAMS if params.get(k))


def _bundles() -> list[tuple[str, str, str, list[str]]]:
    """(묶음, 이름, 설명, 위험 목록) — 화면 순서는 좁은 것부터, 기본은 「전체」(§3-7 ①)."""
    approve, secret, skill = tr("위험 명령 승인", "approving risky commands"), tr("비밀값 넣기", "setting secrets"), tr("스킬 올리기", "uploading skills")
    return [("read", tr("읽기만", "Read only"), tr("대화를 보고 결과를 받습니다", "Read chats and get results"), []),
            ("skill-dev", tr("스킬 개발용", "Skill development"), tr("대화·파일·스킬·비밀값·승인", "Chats, files, skills, secrets, approvals"),
             [approve, secret, skill]),
            ("all", tr("전체(내 에이전트)", "Everything (my agents)"), tr("내가 화면에서 할 수 있는 일 모두", "Everything you can do on the screen"),
             [approve, secret, skill, tr("마켓 게시", "publishing to the market"), tr("설정 바꾸기", "changing settings")])]


def _consent(params: dict, c: dict, user: dict, session: str, agents: list[str]) -> Response:
    e = html.escape
    rows = [f"<p><b>{tr('요청한 곳', 'Requested by')}</b> {e(c['name'])} <span style='display:inline-block;padding:0 6px;border:1px solid currentColor;border-radius:9px;font-size:11px;opacity:.8'>{tr('확인 안 됨', 'not verified')}</span><br>"
            f"<code style='word-break:break-all'>{e(params['redirect_uri'])}</code></p>",
            f"<p><b>{tr('계정', 'Account')}</b> {e(user.get('email') or '')}</p>",
            f"<p><b>{tr('에이전트', 'Agents')}</b> {e(', '.join(agents)) if agents else tr('없음', 'None')}</p>"]
    radios = []
    for key, name, desc, danger in _bundles():
        warn = f"<br><span id=warn-{key} class=hint style='color:#b45309'>▸ {e(' · '.join(danger))}</span>" if danger else ""
        radios.append(f"<label style='display:block;font-weight:normal'><input type=radio name=bundle value={key}"
                      f"{' checked' if key == 'all' else ''}{f' aria-describedby=warn-{key}' if danger else ''}> "
                      f"<b>{e(name)}</b> — {e(desc)}{warn}</label>")
    blocked = not agents
    body = ("".join(rows)
            + f"<form method=post action={AUTHORIZE_PATH}>{_hidden(params)}"
            + f"<input type=hidden name=csrf value={_csrf(session, c['client_id'])}>"
            + f"<fieldset style='border:0;padding:0;margin:0 0 12px'><legend><b>{tr('허락할 범위', 'What to allow')}</b></legend>{''.join(radios)}</fieldset>"
            + "<p class=hint>" + tr("마지막으로 쓴 뒤 30일 쓰지 않으면 끝납니다. 설정의 「Claude Code 연결」에서 언제든 끊을 수 있습니다.",
                                    "Ends after 30 days without use. Disconnect any time in Settings › Claude Code connections.") + "</p>"
            + ("<div class='notice error' role=alert>" + tr("쓸 수 있는 에이전트가 없어 연결할 수 없습니다.", "You have no agent to use, so you cannot connect.")
               + "</div>" if blocked else "")
            + f"<div style='display:flex;gap:8px;flex-wrap:wrap'><button class='btn btn-primary' name=decision value=allow"
            + (" disabled" if blocked else "") + f">{tr('허용', 'Allow')}</button>"
            + f"<button class='btn btn-secondary' name=decision value=deny>{tr('거부', 'Deny')}</button></div></form>")
    return _card(tr("Claude Code 가 AAS 에 연결하려 합니다", "Claude Code wants to connect to AAS"), body)


async def authorize(request: Request) -> Response:
    if (off := _off()) is not None:
        return off
    a = server.auth()
    if request.method == "POST":
        origin = request.headers.get("origin")
        if origin and urlsplit(origin).netloc != request.headers.get("host", ""):
            return _restart(403)
        raw = await request.body()
        if len(raw) > 16 * 1024:
            return _restart(413)
        form = dict(parse_qsl(raw.decode("utf-8", "replace")))
        params = {k: form.get(k, "") for k in PARAMS}
    else:
        params = {k: request.query_params.get(k, "") for k in PARAMS}
    c, denied = await anyio.to_thread.run_sync(_validate, params)
    if denied is not None:
        return denied
    cookie = request.headers.get("cookie")
    user = await anyio.to_thread.run_sync(a.user, cookie)
    if not user:
        return _restart(403) if request.method == "POST" else _login_redirect(request)
    session = auth_mod._cookie(cookie, auth_mod.COOKIE)
    if request.method == "GET":
        agents = await anyio.to_thread.run_sync(lambda: [p.id for p in server.registry().allowed(user, a.enabled)])
        return _consent(params, c, user, session, agents)
    if not hmac.compare_digest(form.get("csrf", ""), _csrf(session, c["client_id"])):
        return _restart(403)
    who = str(user.get("email") or "")
    if form.get("decision") != "allow":
        await anyio.to_thread.run_sync(store.log_usage, "oauth_deny", f"{who} client={c['client_id']}")
        return _back(params["redirect_uri"], error="access_denied", state=params.get("state", ""))
    if not await anyio.to_thread.run_sync(lambda: server.registry().allowed(user, a.enabled)):
        return _back(params["redirect_uri"], error="access_denied", error_description="no agent", state=params.get("state", ""))
    bundle = form.get("bundle", "all")
    if bundle not in tokens.BUNDLES:
        return _restart(400)
    code = await anyio.to_thread.run_sync(oauth_connect.make_code, c, user, params["redirect_uri"], params["code_challenge"], bundle)
    return _back(params["redirect_uri"], code=code, state=params.get("state", ""))


def routes() -> list:
    return [Route("/.well-known/oauth-protected-resource", protected_resource, methods=["GET"]),
            Route("/.well-known/oauth-protected-resource/mcp", protected_resource, methods=["GET"]),
            Route("/.well-known/oauth-authorization-server", authorization_server, methods=["GET"]),
            Route("/.well-known/oauth-authorization-server/mcp", authorization_server, methods=["GET"]),
            Route("/mcp/oauth/register", register, methods=["POST"]),
            Route("/mcp/oauth/token", token, methods=["POST"]),
            Route(AUTHORIZE_PATH, authorize, methods=["GET", "POST"])]

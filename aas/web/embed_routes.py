# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""채팅 임베드 위젯의 HTTP 쪽(OMAI-1873): 토큰 교환·폐기, 인증서 확인 페이지, 위젯 파일, Bearer → 요청 사용자, CORS.

- 교환 POST /api/embed/token {assertion} → {token, expires, sticky, protocol, ws, agent}. 앱은 요청 Origin 으로 찾는다.
  agent 는 앱에 등록한 기본 AI 에이전트(없으면 ""). 위젯 설정의 agent 가 있으면 위젯은 그것을 먼저 쓴다.
- Bearer 임베드 토큰이 있는 요청은 EmbedMiddleware 가 토큰을 확인하고 ASGI scope 의 server.PRINCIPAL_KEY 에 사용자를 넣는다
  (MCP 의 같은 프로세스 안 요청과 같은 자리). 그러면 _context·_chat_pod 의 허용 목록 검사를 그대로 탄다. 쿠키·Authorization 헤더는 버린다.
- 임베드 토큰은 허용 경로(embed.path_allowed)에서만 받고 그 밖은 401 이다. /mcp 도 여기서 막힌다(표가 달라 /mcp 자체도 받지 않는다).
- CORS 는 등록된 출처에서 온 임베드 요청에만 붙인다. Allow-Credentials 는 붙이지 않는다(위젯은 쿠키를 싣지 않는다).
  교환 경로만은 등록되지 않은 출처에도 Allow-Origin 을 붙인다 — 위젯이 403 origin_not_registered 를 읽어 안내를 고르게 하려는 것이고,
  그 응답에는 아무 값도 없다.
- 내장 팝업 로그인(OMAI-1911): 교환 경로가 {assertion}·{login, verifier}·{refresh, verifier} 셋을 받는다. 이 경로의 401 에는
  popup_login(그 출처의 앱이 팝업 로그인을 쓰는가)을 싣는다. 팝업은 GET /embed/login → 호스트 realm → GET /embed/login/callback →
  연결 화면(postMessage) → POST /embed/login/confirm 순서다. 연결 화면은 COOP 를 보내지 않는다 — opener 가 끊기면 승인할 길이 없다.
"""
from __future__ import annotations

import hashlib
import html
import json
from urllib.parse import parse_qs, urlsplit

import anyio
from starlette.requests import Request
from starlette.responses import FileResponse, PlainTextResponse, RedirectResponse, Response
from starlette.routing import Route

from ..auth import embed, mcp_limits
from ..auth.auth import AuthError
from ..common import store
from ..common.i18n import tr
from . import server

TOKEN_PATH = "/api/embed/token"
REVOKE_PATH = "/api/embed/token/revoke"
CERT_PATH = "/embed/cert"
LOGIN_PATH = "/embed/login"                     # 내장 팝업 로그인(OMAI-1911) — 위젯이 여는 팝업의 첫 주소
LOGIN_CALLBACK_PATH = "/embed/login/callback"   # 호스트 realm 이 돌려보내는 주소. 호스트 realm 의 클라이언트에 이 주소를 등록한다
LOGIN_CONFIRM_PATH = "/embed/login/confirm"     # 연결 화면이 위젯의 verifier 를 보내는 곳(같은 출처 fetch)
WIDGET_PATH = "/static/js/aas-widget.js"
INIT_PATH = "/static/js/aas-widget-init.js"     # window.__COGENTAI_AAS__ 를 읽어 init() 을 부르는 주입 스크립트(위젯 빌드가 함께 굽는다)
TYPES_PATH = "/static/js/aas-widget.d.ts"       # 위젯 공개 타입(ui/types/aas-widget.d.ts 를 위젯 빌드가 복사, 스펙 2026-11-18-012 D25⑩)
BODY_MAX = 64 * 1024
ALLOW_METHODS = "GET, POST, PUT, PATCH, DELETE"
ALLOW_HEADERS = "Authorization, Content-Type, Accept-Language, X-AAS"
EXPOSE_HEADERS = "Content-Language, Retry-After, Date"  # Date: 화면이 서버 시계 차이를 잰다
MAX_AGE = "600"
_SECURITY = {"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "X-Frame-Options": "DENY"}
# 팝업 로그인 화면(OMAI-1911). connect-src 'self' 는 confirm fetch 하나뿐이다. COOP 는 두지 않는다(opener 로 postMessage 를 보낸다)
_LOGIN_HEADERS = {**_SECURITY, "Referrer-Policy": "no-referrer",
                  "Content-Security-Policy": "default-src 'none'; script-src 'unsafe-inline'; connect-src 'self'; form-action 'none'; "
                                             "frame-ancestors 'none'"}


def _header(scope: dict, name: bytes) -> str:
    return next((v.decode("latin-1") for k, v in scope.get("headers", []) if k == name), "")


def _bearer(value: str) -> str:
    return value[7:].strip() if value[:7].lower() == "bearer " else ""


def _cors(origin: str) -> dict:
    return {"Access-Control-Allow-Origin": origin, "Vary": "Origin", "Access-Control-Expose-Headers": EXPOSE_HEADERS}


def _error(status: int, code: str, message: str, origin: str = "", extra: dict | None = None, fields: dict | None = None) -> Response:
    headers = {**_SECURITY, **(_cors(origin) if origin else {}), **(extra or {})}
    body = json.dumps({"error": code, "message": message, **(fields or {})}, ensure_ascii=False).encode()
    return Response(body, status_code=status, media_type="application/json; charset=utf-8", headers=headers)


def _client_ip(scope: dict) -> str:
    fwd = _header(scope, b"x-forwarded-for")
    return (fwd.split(",")[0].strip() if fwd else "") or (scope.get("client") or ("",))[0]


def _rate_limited(origin: str) -> Response:
    return _error(429, "rate_limited", tr(f"요청이 많습니다. 분당 {mcp_limits.per_minute()}번까지입니다",
                                          f"Too many requests. Up to {mcp_limits.per_minute()} a minute"), origin, {"Retry-After": "60"})


def over_limit(email: str) -> bool:
    """사람당 분당 요청 수(MCP 와 같은 값, AAS_MCP_CALLS_PER_MIN). 세는 칸은 MCP 와 따로 둔다."""
    return mcp_limits.hit(f"embed:{email}") > mcp_limits.per_minute()


# ---- 교환 ---------------------------------------------------------------------------------------------------
def _known(email: str) -> bool:
    """Keycloak 관리 클라이언트가 없는 설치에서 AAS 가 아는 사람인가: 비밀번호 계정·주인·접근 허용·오피스 사람, 또는 로그인한 적이 있다."""
    return email in server._known_emails() or embed.has_logged_in(email)


def _admit(email: str) -> None:
    """AAS 가 지금 이 사람을 들이는가 — 교환·팝업 로그인·갱신이 같은 규칙을 쓴다(OMAI-1911 에서 exchange 에서 뺐다). 아니면 EmbedError."""
    from . import mcp_server
    if over_limit(email):
        raise embed.EmbedError(429, "rate_limited", tr("요청이 많습니다. 잠시 뒤 다시 하세요", "Too many requests. Try again shortly"))
    ok = mcp_server.member(email)                         # AAS realm 의 사용자 그룹에 있는가(퇴사·사용 중지, D12)
    if ok is None:
        raise embed.EmbedError(503, "idp_unreachable", tr("AAS 가 로그인 서버에 연결할 수 없습니다. 잠시 뒤 다시 하세요",
                                                          "AAS cannot reach the sign-in server. Try again shortly"))
    if not ok or (mcp_server._keycloak() is None and not _known(email)):
        raise embed.EmbedError(403, "user_unknown", tr("AAS 사용 권한이 없습니다", "You do not have access to AAS"))


def _admit_claims(claims: dict) -> str:
    """팝업 로그인의 id_token claim → 들일 이메일. 확인된 이메일·허용 도메인은 로그인과 같은 Auth.verified_email 로 본다."""
    try:
        email = server.auth().verified_email(claims)
    except AuthError as exc:
        raise embed.EmbedError(403, "user_unknown", str(exc)) from None
    _admit(email)
    return email


def _alias_claims(app: dict, tokens: dict, claims: dict) -> tuple[dict, dict]:
    """팝업 로그인에도 화면 로그인과 같은 로그인 도메인 처리를 한다(스펙 2026-11-15-005 E1). 앱의 issuer 가 AAS 영역과 같을 때만
    — 관리 client 가 그 영역 것이다. 이메일을 바꾸면 같은 앱의 토큰 주소로 리프레시해 새 id_token 을 검사한다(nonce 는 보지 않는다)."""
    from ..auth import login_alias
    if app.get("issuer") != server.auth().cfg.get("issuer"):
        return tokens, claims

    def refresh(rt: str) -> tuple[dict, dict]:
        new = embed._kc_post(embed._token_url(app), {"grant_type": "refresh_token", "refresh_token": rt, "client_id": app["login_client_id"],
                                                     "client_secret": embed._login_secret(app["app_id"])}, app["issuer"])
        return new, embed.verify_login_id_token(app, str(new.get("id_token") or ""), None)
    try:
        out = login_alias.at_login(claims, tokens, str(app.get("login_client_id") or ""), refresh, source="embed")
    except login_alias.AliasError as exc:
        raise embed.EmbedError(exc.status, exc.code, exc.text()) from None
    return out if out else (tokens, claims)


def _issued(app: dict, email: str, raw: str, expires: float) -> dict:
    """교환·꺼내기·갱신이 같은 모양으로 돌려준다."""
    return {"token": raw, "expires": expires, "sticky": server._sticky_value(email), "protocol": dict(embed.PROTOCOL),
            "ws": server.ws_enabled(), "agent": app.get("default_agent") or ""}


def _auth_on() -> None:
    if not server.auth().enabled:                         # 로그인을 끈 설치는 신원을 확인할 길이 없다
        raise embed.EmbedError(403, "auth_disabled", tr("로그인을 끈 AAS 는 위젯을 쓸 수 없습니다", "This AAS has sign-in turned off and cannot serve the widget"))


def exchange(origin: str, assertion: str, ip: str) -> dict:
    """호스트 토큰 → 임베드 토큰. 스레드에서 돈다(DB·JWKS·Keycloak). 실패는 EmbedError."""
    a = server.auth()
    _auth_on()
    if mcp_limits.hit(f"embed-ip:{ip}") > mcp_limits.per_minute():
        raise embed.EmbedError(429, "rate_limited", tr("요청이 많습니다. 잠시 뒤 다시 하세요", "Too many requests. Try again shortly"))
    app = embed.app_for_origin(origin)
    if app is None:
        raise embed.EmbedError(403, "origin_not_registered", tr("이 사이트는 AAS 에 등록되지 않았습니다. 관리자에게 문의하세요",
                                                                "This site is not registered in AAS. Ask an admin"))
    if not assertion:
        raise embed.EmbedError(401, "token_invalid", tr("호스트 로그인 토큰이 없습니다", "No host sign-in token"))
    try:
        if app["mode"] == "keycloak":
            host = embed.verify_keycloak(app, assertion)
            from ..auth import login_alias
            if login_alias.is_login_domain(str(host.get("email") or "")):    # 합치지 않는다 — AAS 로그인이 이메일을 바꾼다(E-T4)
                exc = login_alias.login_aas_first()
                raise embed.EmbedError(exc.status, exc.code, str(exc))
            email = a.verified_email(host)
        else:
            claims = embed.verify_host_signed(app, assertion, [a.cfg.get("public_url", ""), *a.cfg.get("public_urls", [])])
            email = embed.host_email(claims)
            if not email:
                raise embed.EmbedError(401, "token_mismatch", tr("토큰에 사용자 이메일이 없습니다", "The token has no user email"))
            a.verified_email({"email": email}, require_verified=False)
    except AuthError as exc:                              # 확인되지 않은 이메일·허용 도메인 밖
        raise embed.EmbedError(403, "user_unknown", str(exc)) from None
    _admit(email)
    raw, expires = embed.issue(app, origin, email, embed.aas_sub(email))
    store.log_usage("embed_token", f"{email} app={app['app_id']} origin={embed.normalize_origin(origin)}")
    return _issued(app, email, raw, expires)


def redeem(origin: str, nonce, verifier, ip: str) -> dict | None:
    """팝업 로그인 꺼내기. 대기 중이면 None. 요청 한도는 교환과 다른 칸이다 — nonce 하나에 분당 LOGIN_POLLS_PER_MIN, IP 별 칸(OMAI-1911)."""
    _auth_on()
    if (mcp_limits.hit(f"embed-login-ip:{ip}") > mcp_limits.per_minute() * 4
            or (isinstance(nonce, str) and mcp_limits.hit(f"embed-login:{embed._hash(nonce)[:32]}") > embed.LOGIN_POLLS_PER_MIN)):
        raise embed.EmbedError(429, "rate_limited", tr("요청이 많습니다. 잠시 뒤 다시 하세요", "Too many requests. Try again shortly"))
    out = embed.login_redeem(origin, nonce, verifier)
    if out is None:
        return None
    # email: 팝업 토큰에는 호스트 신원 토큰이 없어 위젯이 사용자 바뀜을 이 값으로 가린다(OMAI-1911)
    return _issued(out["app"], out["email"], out["token"], out["expires"]) | {"refresh": True, "email": out["email"]}


def refresh(origin: str, raw_token, verifier, ip: str) -> dict:
    """팝업 로그인 토큰 갱신(호스트 refresh token). 요청 한도는 교환과 같은 IP 칸이다(Keycloak 을 부른다)."""
    _auth_on()
    if mcp_limits.hit(f"embed-ip:{ip}") > mcp_limits.per_minute():
        raise embed.EmbedError(429, "rate_limited", tr("요청이 많습니다. 잠시 뒤 다시 하세요", "Too many requests. Try again shortly"))
    out = embed.login_refresh(raw_token if isinstance(raw_token, str) else "", origin, verifier, _admit)
    return _issued(out["app"], out["email"], out["token"], out["expires"]) | {"refresh": True, "email": out["email"]}


def _host_refused(request: Request) -> Response | None:
    from .files import _View
    if not _View(request)._host_ok():
        return PlainTextResponse("invalid host", status_code=400, headers=_SECURITY)
    return None


async def token(request: Request) -> Response:
    refused = _host_refused(request)
    if refused is not None:
        return refused
    origin = request.headers.get("origin", "")
    cors = origin if embed.normalize_origin(origin) else ""
    if not cors:
        return _error(403, "origin_not_registered", tr("요청 출처(Origin)가 없습니다", "The request has no Origin"))
    raw = await request.body()
    if len(raw) > BODY_MAX:
        return _error(413, "token_invalid", tr("요청이 너무 큽니다", "The request is too large"), cors)
    try:
        body = json.loads(raw or b"{}")
    except ValueError:
        body = None
    body = body if isinstance(body, dict) else {}
    ip = _client_ip(request.scope)
    assertion = body.get("assertion")
    if "login" not in body and "refresh" not in body and not isinstance(assertion, str):
        return _error(400, "token_invalid", tr("assertion 이 없습니다", "assertion is required"), cors)
    try:
        if "login" in body:                               # 팝업 로그인 꺼내기(OMAI-1911)
            out = await anyio.to_thread.run_sync(redeem, origin, body.get("login"), body.get("verifier"), ip)
            if out is None:
                return Response(b'{"pending": true}', status_code=202, media_type="application/json; charset=utf-8",
                                headers={**_SECURITY, **_cors(cors)})
        elif "refresh" in body:                           # 팝업 로그인 토큰 갱신
            out = await anyio.to_thread.run_sync(refresh, origin, body.get("refresh"), body.get("verifier"), ip)
        else:
            out = await anyio.to_thread.run_sync(exchange, origin, assertion.strip(), ip)
    except embed.EmbedError as exc:
        fields = None
        if exc.status == 401:                             # 위젯이 「로그인」 버튼(내장 팝업)을 보일지 고른다
            fields = {"popup_login": embed.popup_login(await anyio.to_thread.run_sync(embed.app_for_origin, origin))}
        return _error(exc.status, exc.code, exc.message, cors, {"Retry-After": "60"} if exc.status == 429 else None, fields)
    return Response(json.dumps(out, ensure_ascii=False).encode(), media_type="application/json; charset=utf-8",
                    headers={**_SECURITY, **_cors(cors)})


async def revoke(request: Request) -> Response:
    """위젯의 destroy()·resetUserSession() 이 부른다. 같은 토큰을 두 번 보내도 200."""
    refused = _host_refused(request)
    if refused is not None:
        return refused
    origin = request.headers.get("origin", "")
    app = await anyio.to_thread.run_sync(embed.app_for_origin, origin) if origin else None
    if app is None:
        return _error(403, "origin_not_registered", tr("이 사이트는 AAS 에 등록되지 않았습니다", "This site is not registered in AAS"))
    raw = await request.body()
    try:                                                  # 팝업 로그인이면 위젯이 verifier 를 함께 보낸다(호스트 refresh token 폐기, OMAI-1911)
        body = json.loads(raw) if raw and len(raw) <= BODY_MAX else {}
    except ValueError:
        body = {}
    verifier = body.get("verifier") if isinstance(body, dict) else ""
    done = await anyio.to_thread.run_sync(embed.revoke, _bearer(request.headers.get("authorization", "")), origin, None,
                                          verifier if isinstance(verifier, str) else "")
    return Response(json.dumps({"ok": True, "revoked": done}).encode(), media_type="application/json; charset=utf-8",
                    headers={**_SECURITY, **_cors(origin)})


async def cert(request: Request) -> Response:
    """사설 인증서를 받아들이려고 위젯이 새 창으로 여는 페이지. 로그인이 필요 없고 비밀 값이 없다. iframe 에는 넣지 않는다."""
    refused = _host_refused(request)
    if refused is not None:
        return refused
    title = tr("AAS 연결 확인", "AAS connection check")
    text = tr("AAS 연결이 확인되었습니다. 이 창은 닫아도 됩니다.", "The AAS connection is confirmed. You can close this window.")
    page = (f"<!doctype html><html lang=\"{tr('ko', 'en')}\"><head><meta charset=\"utf-8\"><title>{html.escape(title)}</title>"
            "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\"></head>"
            "<body style=\"font-family:sans-serif;margin:48px 16px;text-align:center;color:#222;background:#fff\">"
            f"<p>{html.escape(text)}</p><script>setTimeout(function(){{window.close()}},800)</script></body></html>")
    return Response(page.encode(), media_type="text/html; charset=utf-8",
                    headers={**_SECURITY, "Content-Security-Policy": "default-src 'none'; script-src 'unsafe-inline'; frame-ancestors 'none'"})


# ---- 내장 팝업 로그인(OMAI-1911) ---------------------------------------------------------------------------------
def _script_json(value) -> str:
    """인라인 스크립트에 넣는 JSON. </script> 로 끊기지 않게 < 를 바꾼다."""
    return json.dumps(value, ensure_ascii=False).replace("<", "\\u003c")


def _login_page(status: int, text: str, script: str = "", extra: dict | None = None) -> Response:
    """팝업 로그인 화면. 오류 화면에는 스크립트가 없고 어디로도 보내지 않는다."""
    title = tr("AAS 로그인", "AAS sign-in")
    page = (f"<!doctype html><html lang=\"{tr('ko', 'en')}\"><head><meta charset=\"utf-8\"><title>{html.escape(title)}</title>"
            "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\"></head><body>"
            f"<p id=\"m\">{html.escape(text)}</p>{script}</body></html>")
    return Response(page.encode(), status_code=status, media_type="text/html; charset=utf-8", headers={**_LOGIN_HEADERS, **(extra or {})})


def _retry_text() -> str:
    return tr("이 창을 닫고 위젯에서 「로그인」을 다시 누르세요", "Close this window and press Sign in in the widget again")


def _login_failed(exc: embed.EmbedError) -> Response:
    return _login_page(exc.status if exc.status in (400, 401, 403, 429, 503) else 400, f"{exc.message} — {_retry_text()}")


async def login_start(request: Request) -> Response:
    """GET /embed/login?o=<호스트 출처>&n=<nonce>. 호스트 realm 인가 주소로 302 하고 state 를 이 브라우저의 쿠키에 묶는다."""
    refused = _host_refused(request)
    if refused is not None:
        return refused
    from .files import _View
    a, view = server.auth(), _View(request)
    if not a.enabled:
        return _login_page(403, tr("로그인을 끈 AAS 는 위젯을 쓸 수 없습니다", "This AAS has sign-in turned off and cannot serve the widget"))
    base = a.base_for(view._effective_host(), view._secure_request())
    if base is None:
        return _login_page(400, tr("AAS 에 등록된 접속 주소가 아닙니다", "This is not a registered AAS address"))
    if await anyio.to_thread.run_sync(mcp_limits.hit, f"embed-login-begin:{_client_ip(request.scope)}") > mcp_limits.per_minute():
        return _login_page(429, tr("요청이 많습니다. 잠시 뒤 다시 하세요", "Too many requests. Try again shortly"))
    try:
        url, cookie = await anyio.to_thread.run_sync(embed.login_begin, request.query_params.get("o", ""),
                                                     request.query_params.get("n", ""), base)
    except embed.EmbedError as exc:
        return _login_failed(exc)
    resp = RedirectResponse(url, status_code=302, headers={**_SECURITY, "Referrer-Policy": "no-referrer"})
    name = f"{embed.LOGIN_COOKIE}_{cookie[:16]}"                                   # = embed.login_cookie_name(state), 값은 state 해시
    resp.headers.append("Set-Cookie", f"{name}={cookie}; Path=/; Max-Age={embed.LOGIN_TTL}; HttpOnly; Secure; SameSite=Lax")
    return resp


_CONNECT_SCRIPT = """<script>(function(){
var c=%s,t=%s,done=false,m=document.getElementById("m");
function say(s){m.textContent=s}
window.addEventListener("message",function(e){
if(done||e.origin!==c.origin||!e.data||e.data.aasEmbedLogin!==c.nonce||typeof e.data.verifier!=="string")return;
done=true;
fetch("%s",{method:"POST",credentials:"same-origin",headers:{"Content-Type":"application/json"},
body:JSON.stringify({secret:c.secret,verifier:e.data.verifier})}).then(function(r){
if(r.ok){say(t.ok);setTimeout(function(){window.close()},300)}else{say(t.retry)}}).catch(function(){say(t.retry)});
});
try{window.opener.postMessage({aasEmbedLogin:c.nonce},c.origin)}catch(err){}
setTimeout(function(){if(!done)say(t.retry)},3000);
})();</script>"""


async def login_callback(request: Request) -> Response:
    """GET /embed/login/callback?state&code. 쿠키·state 를 맞추고 코드를 바꾼 뒤 연결 화면을 준다. 오류 화면은 어디로도 보내지 않는다."""
    refused = _host_refused(request)
    if refused is not None:
        return refused
    if not server.auth().enabled:
        return _login_page(403, tr("로그인을 끈 AAS 는 위젯을 쓸 수 없습니다", "This AAS has sign-in turned off and cannot serve the widget"))
    q = request.query_params
    code = "" if q.get("error") else q.get("code", "")   # 사용자가 취소했거나 Keycloak 이 거절했다 — 행을 지우고 오류 화면
    name = embed.login_cookie_name(q.get("state", ""))
    try:
        out = await anyio.to_thread.run_sync(lambda: embed.login_callback(q.get("state", ""), code, request.cookies.get(name, ""),
                                                                          _admit_claims, alias=_alias_claims))
    except embed.EmbedError as exc:
        return _login_failed(exc)
    texts = {"ok": tr("로그인했습니다. 이 창은 닫아도 됩니다.", "Signed in. You can close this window."), "retry": _retry_text()}
    script = _CONNECT_SCRIPT % (_script_json(out), _script_json(texts), LOGIN_CONFIRM_PATH)
    return _login_page(200, tr("위젯에 연결하는 중입니다…", "Connecting to the widget…"), script,
                       {"Set-Cookie": f"{name}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax"})


async def login_confirm(request: Request) -> Response:
    """POST /embed/login/confirm {secret, verifier}. 연결 화면(같은 출처)만 부른다 — Origin 이 이 서버여야 한다."""
    refused = _host_refused(request)
    if refused is not None:
        return refused
    origin = request.headers.get("origin", "")
    if not origin or urlsplit(origin).netloc != request.headers.get("host", ""):
        return _error(403, "forbidden", tr("다른 사이트에서 온 요청입니다", "The request came from another site"))
    raw = await request.body()
    try:
        body = json.loads(raw) if len(raw) <= BODY_MAX else None
    except ValueError:
        body = None
    if not isinstance(body, dict) or not isinstance(body.get("secret"), str) or not embed._valid_login_value(body.get("verifier")):
        return _error(400, "login_invalid", tr("요청 형식이 틀렸습니다", "Malformed request"))
    if not await anyio.to_thread.run_sync(embed.login_confirm, body["secret"], body["verifier"]):
        return _error(401, "login_invalid", tr("로그인이 만료됐거나 알 수 없는 로그인입니다", "The sign-in expired or is unknown"))
    return Response(b'{"ok": true}', media_type="application/json; charset=utf-8", headers=_SECURITY)


async def widget(request: Request) -> Response:
    """위젯 빌드 산출물(aas-widget.js·aas-widget-init.js·aas-widget.d.ts). 다른 사이트의 script 태그가 받으므로 로그인을 묻지 않는다. 파일이 없으면 404."""
    refused = _host_refused(request)
    if refused is not None:
        return refused
    path = server.STATIC_DIR / "js" / request.url.path.rsplit("/", 1)[-1]   # 경로는 routes() 의 두 고정 값뿐이다
    if not path.is_file() or path.is_symlink():
        return PlainTextResponse("not found", status_code=404, headers=_SECURITY)
    st = path.stat()
    etag = '"%s"' % hashlib.md5(f"{st.st_mtime}-{st.st_size}".encode(), usedforsecurity=False).hexdigest()
    headers = {"Cache-Control": "no-cache", "ETag": etag, "X-Content-Type-Options": "nosniff"}
    if request.headers.get("if-none-match") == etag:
        return Response(status_code=304, headers=headers)
    media = "text/plain; charset=utf-8" if path.name.endswith(".d.ts") else "text/javascript; charset=utf-8"   # 타입 파일은 받아 저장하는 글이다
    return FileResponse(path, media_type=media, headers=headers, stat_result=st)


def routes() -> list:
    return [Route(TOKEN_PATH, token, methods=["POST"]), Route(REVOKE_PATH, revoke, methods=["POST"]),
            Route(CERT_PATH, cert, methods=["GET"]), Route(LOGIN_PATH, login_start, methods=["GET"]),
            Route(LOGIN_CALLBACK_PATH, login_callback, methods=["GET"]), Route(LOGIN_CONFIRM_PATH, login_confirm, methods=["POST"]),
            Route(WIDGET_PATH, widget, methods=["GET", "HEAD"]),
            Route(INIT_PATH, widget, methods=["GET", "HEAD"]),
            Route(TYPES_PATH, widget, methods=["GET", "HEAD"])]


# ---- Bearer → 요청 사용자, CORS ---------------------------------------------------------------------------------
def _corsable(path: str) -> bool:
    return path == TOKEN_PATH or embed.path_allowed(path)


class EmbedMiddleware:
    """순수 ASGI 미들웨어(http 만). 임베드 토큰이 없는 요청은 아무것도 하지 않고 넘긴다 — 지금 화면의 요청에는 DB 조회가 늘지 않는다."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        path, origin = scope["path"], _header(scope, b"origin")
        if scope["method"] == "OPTIONS" and origin and _corsable(path):
            await self._preflight(scope, receive, send, origin, path)
            return
        raw = _bearer(_header(scope, b"authorization"))
        if not raw.startswith(embed.TOKEN_PREFIX) or path.startswith("/api/embed/"):   # 교환·폐기 경로는 스스로 확인한다
            await self.app(scope, receive, send)
            return
        response = await self._authorize(scope, raw, origin, path)
        if isinstance(response, Response):
            await response(scope, receive, send)
            return
        inner, cors = response

        async def send_cors(msg):
            if msg["type"] == "http.response.start":
                msg = {**msg, "headers": list(msg.get("headers") or []) + [(k.lower().encode(), v.encode()) for k, v in _cors(cors).items()]}
            await send(msg)
        await self.app(inner, receive, send_cors)

    async def _registered(self, origin: str) -> str:
        """등록된 출처면 그 값(오류 응답에도 CORS 를 붙여 위젯이 코드를 읽게), 아니면 ""."""
        return origin if origin and await anyio.to_thread.run_sync(embed.app_for_origin, origin) is not None else ""

    async def _authorize(self, scope: dict, raw: str, origin: str, path: str):
        """(안쪽 scope, CORS 출처) 또는 거절 응답."""
        if not embed.path_allowed(path):
            return _error(401, "path_not_allowed", tr("위젯 토큰으로 쓸 수 없는 경로입니다", "This path cannot be used with a widget token"),
                          await self._registered(origin))
        # 로그인을 끈 설치에서는 허용 목록 검사가 모든 에이전트를 내주므로(Registry.allowed) 토큰을 받지 않는다
        row = await anyio.to_thread.run_sync(embed.lookup, raw, origin) if origin and server.auth().enabled else None
        if row is None:                                   # 틀림·만료·폐기·다른 출처에 묶인 토큰 — 위젯은 다시 교환한다
            return _error(401, "token_invalid", tr("위젯 토큰이 유효하지 않습니다. 다시 연결하세요", "The widget token is not valid. Connect again"),
                          await self._registered(origin))
        if await anyio.to_thread.run_sync(over_limit, row["user_email"]):
            return _rate_limited(origin)
        query = parse_qs(scope.get("query_string", b"").decode("latin-1"))
        pod = str((query.get("pod") or [""])[0])[:100]
        inner = dict(scope)
        inner["headers"] = [(k, v) for k, v in scope.get("headers", []) if k not in (b"cookie", b"authorization")]
        inner[server.PRINCIPAL_KEY] = {"user": embed.embed_user(row), "pod": pod}
        return inner, origin

    async def _preflight(self, scope, receive, send, origin: str, path: str) -> None:
        ok = path == TOKEN_PATH and embed.normalize_origin(origin) or await self._registered(origin)
        if not ok:
            await PlainTextResponse("origin not registered", status_code=403, headers=_SECURITY)(scope, receive, send)
            return
        headers = {**_cors(origin), "Access-Control-Allow-Methods": ALLOW_METHODS, "Access-Control-Allow-Headers": ALLOW_HEADERS,
                   "Access-Control-Max-Age": MAX_AGE, "Cache-Control": "no-store"}
        await Response(status_code=204, headers=headers)(scope, receive, send)

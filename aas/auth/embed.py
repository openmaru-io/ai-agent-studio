# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""채팅 임베드 위젯 — 임베드 앱 등록·호스트 토큰 검증·임베드 토큰(OMAI-1873).

다른 웹 페이지(호스트)에 붙인 위젯이 호스트가 준 신원 증명(assertion)을 AAS 전용 짧은 토큰으로 바꿔 쓴다.
- 앱은 출처(Origin)로 찾는다. 출처 하나는 앱 하나에만 붙는다(embed_origins 의 기본 키).
- keycloak 모드: 호스트 realm 의 액세스 토큰(RS256)을 그 realm 의 JWKS 로 검증한다. iss·aud(필수)·exp·email_verified 를 본다.
- host-signed 모드: 호스트 서버가 등록된 공개 키(RS256 JWK)로 서명한 5분 이하 토큰. jti 는 DB 로 재사용을 막는다(서버가 둘이다).
- 임베드 토큰 원문은 만들 때 한 번만 돌려주고 DB 에는 sha256 만 둔다(personal_tokens 와 같은 방식). 표가 달라 /mcp 는 받지 않는다.

JWT 검증은 표준 라이브러리로 한다 — 이미지에 cryptography·PyJWT 가 없고 새 의존성을 넣지 않는다.
RSA PKCS#1 v1.5: pow(서명, e, n) 결과를 EMSA-PKCS1-v1_5(SHA-256 DigestInfo) 인코딩 전체와 상수 시간 비교한다.
JWKS 는 aas/auth/tls.py 의 urlopen 으로만 받는다(사설 CA·검증 끄기 옵션이 로그인과 같다).

내장 팝업 로그인(OMAI-1911): keycloak 모드 앱에 로그인 클라이언트(login_client_id·login_client_secret)가 있으면, 위젯이 AAS 주소의
/embed/login 팝업을 열고 AAS 가 호스트 realm 으로 OIDC 로그인(PKCE)을 한다. 위젯은 nonce(공개)와 verifier(비밀)를 만들어
nonce 만 팝업 주소에 싣는다. 연결 화면은 등록 출처의 opener 에만 postMessage 를 보내고, 위젯이 답한 verifier 를 행에 묶어 승인한다.
꺼내기(redeem)·갱신(refresh)은 그 verifier 가 있어야 된다 — Origin 헤더는 브라우저 밖에서 꾸밀 수 있으므로 출처만으로는 믿지 않는다.
호스트 refresh token 은 auth.seal(원문, 로그인 클라이언트 비밀, verifier)로 봉한다. DB 가 새도 verifier 없이는 풀 수 없다.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import re
import secrets
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from urllib.parse import urlsplit

from ..common import config, db, store
from ..common.i18n import tr
from . import tls

SCHEMA = """
CREATE TABLE IF NOT EXISTS embed_apps (
  app_id TEXT PRIMARY KEY, name TEXT NOT NULL, origins TEXT NOT NULL, mode TEXT NOT NULL,
  issuer TEXT NOT NULL DEFAULT '', jwks_url TEXT NOT NULL DEFAULT '', audience TEXT NOT NULL DEFAULT '',
  public_jwk TEXT NOT NULL DEFAULT '', default_agent TEXT NOT NULL DEFAULT '', created REAL NOT NULL);
CREATE TABLE IF NOT EXISTS embed_origins (origin TEXT PRIMARY KEY, app_id TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS embed_tokens (
  token_hash TEXT NOT NULL UNIQUE, app_id TEXT NOT NULL, origin TEXT NOT NULL, user_sub TEXT NOT NULL DEFAULT '',
  user_email TEXT NOT NULL, created REAL NOT NULL, expires REAL NOT NULL, revoked REAL NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS embed_tokens_expires ON embed_tokens (expires);
CREATE TABLE IF NOT EXISTS embed_jti (jti TEXT NOT NULL, app_id TEXT NOT NULL, expires REAL NOT NULL, PRIMARY KEY (app_id, jti));
CREATE TABLE IF NOT EXISTS embed_login (
  nonce_hash TEXT PRIMARY KEY, app_id TEXT NOT NULL, origin TEXT NOT NULL, state_hash TEXT NOT NULL UNIQUE, stage TEXT NOT NULL,
  data TEXT NOT NULL, confirm_hash TEXT NOT NULL DEFAULT '', verifier_hash TEXT NOT NULL DEFAULT '', email TEXT NOT NULL DEFAULT '',
  refresh_sealed TEXT NOT NULL DEFAULT '', created REAL NOT NULL, expires REAL NOT NULL);
CREATE INDEX IF NOT EXISTS embed_login_expires ON embed_login (expires);
CREATE TABLE IF NOT EXISTS embed_login_sessions (
  session_hash TEXT PRIMARY KEY, app_id TEXT NOT NULL, origin TEXT NOT NULL, email TEXT NOT NULL, token_hash TEXT NOT NULL,
  verifier_hash TEXT NOT NULL, refresh_sealed TEXT NOT NULL, created REAL NOT NULL, expires REAL NOT NULL);
CREATE INDEX IF NOT EXISTS embed_login_sessions_token ON embed_login_sessions (token_hash);
CREATE TABLE IF NOT EXISTS embed_formats (
  app_id TEXT NOT NULL, format_id TEXT NOT NULL, label_ko TEXT NOT NULL, label_en TEXT NOT NULL, schema_json TEXT NOT NULL,
  instructions TEXT NOT NULL DEFAULT '', version INTEGER NOT NULL DEFAULT 1, deleted INTEGER NOT NULL DEFAULT 0,
  updated REAL NOT NULL, updated_by TEXT NOT NULL DEFAULT '', PRIMARY KEY (app_id, format_id));
"""

# 옛 DB 에 더하는 열(OMAI-1911). 모두 TEXT 라 PostgreSQL 의 REAL(4바이트) 문제는 없다
_ADDED = (("embed_apps", "login_client_id TEXT NOT NULL DEFAULT ''"), ("embed_apps", "login_client_secret TEXT NOT NULL DEFAULT ''"),
          ("embed_tokens", "login_session TEXT NOT NULL DEFAULT ''"),
          ("embed_apps", "page_schema INTEGER NOT NULL DEFAULT 0"))       # 답 저장: 페이지가 형식을 넘길 수 있음(스펙 2026-11-18-012 D17)
_MIGRATED: set = set()

MODES = ("keycloak", "host-signed")
TOKEN_PREFIX = "aas_emb_"
TOKEN_TTL = 15 * 60                     # 임베드 토큰 유효 기간. 위젯은 만료 1분 전에 다시 바꾼다
KEEP_ENDED = 3600                       # 만료·폐기한 줄은 1시간 뒤 지운다
HOST_TTL_MAX = 5 * 60                   # host-signed 토큰의 exp 는 지금부터 5분 이하
LEEWAY = 30                             # 서버 사이 시계 차이
JWKS_TTL = 600                          # JWKS 메모리 캐시
JWKS_REFETCH_EVERY = 30                 # 모르는 kid 로 다시 받기는 이 간격에 한 번(아무 kid 로 Keycloak 을 두드리지 못하게)
JWKS_TIMEOUT = 5.0
RSA_MIN_BITS = 2048
LOGIN_TTL = 5 * 60                      # 팝업 로그인 하나가 시작부터 꺼내기까지 쓸 수 있는 시간(OMAI-1911)
LOGIN_COOKIE = "__Host-aas_embed_login"  # state 를 이 브라우저에 묶는다(로그인 CSRF). 값은 state 의 sha256


def login_cookie_name(state: str) -> str:
    """로그인 하나마다 쿠키 이름이 따로다(OMAI-1911). 이름이 하나면 두 탭이 함께 로그인을 시작할 때 나중 쿠키가 앞 것을 덮어
    먼저 시작한 쪽 콜백이 실패한다. 이름 끝은 state 해시 앞 16자라 state 원문은 드러나지 않는다."""
    return f"{LOGIN_COOKIE}_{_hash(state)[:16]}"
LOGIN_POLLS_PER_MIN = 60                # nonce 하나의 꺼내기 요청 한도. 위젯은 2초마다 묻는다(분당 30번)
LOGIN_FORMAT = re.compile(r"[A-Za-z0-9_-]{20,200}")      # 위젯이 만드는 nonce·verifier(base64url 43자)
KC_TIMEOUT = 10.0
PROTOCOL = {"min": 1, "max": 1}          # 서버가 받는 위젯 판 범위. 임베드가 쓰는 API(경로 허용 목록)를 바꾸면 함께 올린다

# 임베드 토큰을 받는 경로. 그 밖은 401 이다. 받아쓰기(transcribe)·읽어 주기(speak)는 임베드에서 쓰지 않는다
ALLOWED_PREFIXES = ("/api/chat/", "/api/embed/")
ALLOWED_EXACT = ("/api/me",)
DENIED_PREFIXES = ("/api/chat/transcribe", "/api/chat/speak")


class EmbedError(Exception):
    """code 는 위젯이 보는 고정 낱말(origin_not_registered·token_invalid·token_mismatch·user_unknown·idp_unreachable·rate_limited·auth_disabled).

    401 은 둘로 나눈다(OMAI-1908). token_invalid 는 다시 로그인하면 풀리는 경우(없음·형식·만료·아직 이른 토큰·jti 재사용)다.
    token_mismatch 는 서명·iss·aud·공개 키·유효 기간·jti·exp 처럼 호스트나 임베드 앱 설정이 틀린 경우다. 위젯은 이때 「로그인」을 보이지 않는다.
    """
    def __init__(self, status: int, code: str, message: str = ""):
        super().__init__(message or code)
        self.status, self.code, self.message = status, code, message or code


def _conn():
    conn = store.connect()
    conn.executescript(SCHEMA)
    key = (db.backend(), os.environ.get("AAS_DATA_DIR", ""), os.environ.get("AAS_DB_SCHEMA", ""))
    if key not in _MIGRATED:                              # 열 추가는 프로세스(저장소)마다 한 번만 본다 — store._MIGRATED 와 같은 가드
        for table, ddl in _ADDED:
            if ddl.split()[0] not in db.columns(conn, table):
                db.add_column(conn, table, ddl)
        _MIGRATED.add(key)
    return conn


def _hash(raw: str) -> str:
    return hashlib.sha256(raw.encode()).hexdigest()


def path_allowed(path: str) -> bool:
    """임베드 토큰으로 부를 수 있는 경로인가(쿼리는 떼고 넘긴다)."""
    if path.startswith(DENIED_PREFIXES) or ".." in path:
        return False
    return path in ALLOWED_EXACT or path.startswith(ALLOWED_PREFIXES)


# ---- 출처 -------------------------------------------------------------------------------------------------
def normalize_origin(value: str) -> str:
    """scheme://호스트[:포트] (소문자, 기본 포트는 뗀다). 경로·쿼리·사용자 정보가 있거나 http(s) 가 아니면 ""."""
    raw = str(value or "").strip()
    try:
        u = urlsplit(raw)
        port = u.port
    except ValueError:
        return ""
    if u.scheme not in ("http", "https") or not u.hostname or u.username or u.password or u.query or u.fragment \
            or u.path not in ("", "/"):
        return ""
    host = u.hostname.lower()
    if ":" in host:                                       # IPv6
        host = f"[{host}]"
    if port is None or (u.scheme, port) in (("http", 80), ("https", 443)):
        return f"{u.scheme}://{host}"
    return f"{u.scheme}://{host}:{port}"


def _app_row(r) -> dict:
    """앱 줄 → 돌려줄 값. 로그인 클라이언트 비밀은 싣지 않고 등록 여부(login_client_secret_set)만 싣는다(OMAI-1911)."""
    d = dict(r)
    d["origins"] = json.loads(d["origins"] or "[]")
    d["login_client_id"] = d.get("login_client_id") or ""
    d["login_client_secret_set"] = bool(d.pop("login_client_secret", ""))
    d["page_schema"] = bool(d.get("page_schema") or 0)
    return d


def _login_secret(app_id: str) -> str:
    """앱의 로그인 클라이언트 비밀. 서버 안에서만 쓴다."""
    with _conn() as conn:
        r = conn.execute("SELECT login_client_secret FROM embed_apps WHERE app_id=?", (app_id,)).fetchone()
    return str(r["login_client_secret"] or "") if r is not None else ""


def popup_login(app: dict | None) -> bool:
    """이 앱이 내장 팝업 로그인을 쓸 수 있는가 — keycloak 모드이고 로그인 클라이언트(ID·비밀)가 있다."""
    return bool(app and app.get("mode") == "keycloak" and app.get("login_client_id") and app.get("login_client_secret_set"))


def app_for_origin(origin: str) -> dict | None:
    """출처에 등록된 앱. 없으면 None."""
    o = normalize_origin(origin)
    if not o:
        return None
    with _conn() as conn:
        r = conn.execute("SELECT a.* FROM embed_origins o JOIN embed_apps a ON a.app_id = o.app_id WHERE o.origin=?", (o,)).fetchone()
    return _app_row(r) if r is not None else None


def get_app(app_id: str) -> dict | None:
    with _conn() as conn:
        r = conn.execute("SELECT * FROM embed_apps WHERE app_id=?", (app_id,)).fetchone()
    return _app_row(r) if r is not None else None


def list_apps() -> list[dict]:
    with _conn() as conn:
        return [_app_row(r) for r in conn.execute("SELECT * FROM embed_apps ORDER BY created")]


class AppError(ValueError):
    """앱 등록 값이 틀렸다. field 는 화면이 오류를 붙일 칸(name·origins·mode·issuer·jwks_url·audience·public_jwk·app_id·
    login_client_id·login_client_secret)."""
    def __init__(self, message: str, field: str = ""):
        super().__init__(message)
        self.field = field


def _checked(name: str, origins: list[str], mode: str, issuer: str, jwks_url: str, audience: str, public_jwk: str,
             login_client_id: str = "", login_client_secret: str = "", kept_secret: str = "") -> dict:
    """등록·고치기에 같이 쓰는 값 검사. 고친 값을 돌려주고, 틀리면 AppError.
    login_client_secret 이 비었으면 kept_secret(고치기 전 값)을 쓴다 — 화면은 비밀을 받지 못하므로 비워 보내면 유지다(OMAI-1911)."""
    name = " ".join(str(name or "").split())
    if not name:
        raise AppError(tr("이름을 적으세요", "Enter a name"), "name")
    if mode not in MODES:
        raise AppError(tr("인증 모드는 keycloak 또는 host-signed 입니다", "The mode is keycloak or host-signed"), "mode")
    norm = []
    for o in origins or []:
        n = normalize_origin(o)
        if not n:
            raise AppError(tr(f"출처 형식이 틀렸습니다: {o} (예: https://cop.example.com)",
                              f"Invalid origin: {o} (for example https://cop.example.com)"), "origins")
        if n not in norm:
            norm.append(n)
    if not norm:
        raise AppError(tr("허용 출처를 하나 이상 적으세요", "Add at least one allowed origin"), "origins")
    issuer, jwks_url, audience = (str(v or "").strip() for v in (issuer, jwks_url, audience))
    if mode == "keycloak":
        for field, value in (("issuer", issuer), ("jwks_url", jwks_url), ("audience", audience)):
            if not value:
                raise AppError(tr("keycloak 모드는 issuer·jwks_url·audience 가 모두 있어야 합니다",
                                  "keycloak mode needs issuer, jwks_url and audience"), field)
        if urlsplit(jwks_url).scheme not in ("http", "https"):
            raise AppError(tr("jwks_url 은 http(s) 주소입니다", "jwks_url must be an http(s) address"), "jwks_url")
        public_jwk = ""
        login_client_id = str(login_client_id or "").strip()
        login_client_secret = str(login_client_secret or "").strip() or (kept_secret if login_client_id else "")
        if login_client_secret and not login_client_id:
            raise AppError(tr("팝업 로그인 클라이언트 ID 를 적으세요", "Enter the popup sign-in client ID"), "login_client_id")
        if login_client_id and not login_client_secret:
            raise AppError(tr("팝업 로그인 클라이언트 비밀을 적으세요", "Enter the popup sign-in client secret"), "login_client_secret")
        if login_client_id and not jwks_url.rstrip("/").endswith("/protocol/openid-connect/certs"):
            # 토큰·revoke 주소를 JWKS 주소에서 얻는다(Keycloak 의 …/protocol/openid-connect/certs)
            raise AppError(tr("팝업 로그인은 Keycloak JWKS 주소(…/protocol/openid-connect/certs)가 있어야 합니다",
                              "Popup sign-in needs the Keycloak JWKS address (…/protocol/openid-connect/certs)"), "jwks_url")
    else:
        login_client_id = login_client_secret = ""
        try:
            _rsa_key(_parse_jwk_text(public_jwk))            # 형식·크기를 지금 확인한다
        except ValueError as exc:
            raise AppError(str(exc), "public_jwk") from None
        issuer = jwks_url = audience = ""
    return {"name": name, "origins": norm, "mode": mode, "issuer": issuer.rstrip("/"), "jwks_url": jwks_url, "audience": audience,
            "public_jwk": public_jwk, "login_client_id": login_client_id, "login_client_secret": login_client_secret}


def _claim_origins(conn, origins: list[str], app_id: str) -> None:
    """출처 하나는 앱 하나 — 다른 앱이 쓰는 출처면 AppError. 기본 키라 두 관리자가 동시에 같은 출처를 넣어도 하나만 남는다."""
    for o in origins:
        hit = conn.execute("SELECT app_id FROM embed_origins WHERE origin=?", (o,)).fetchone()
        if hit and hit["app_id"] != app_id:
            raise AppError(tr(f"출처 {o} 는 이미 앱 {hit['app_id']} 에 등록돼 있습니다. 출처 하나는 앱 하나에만 등록합니다",
                              f"Origin {o} is already registered to app {hit['app_id']}. An origin belongs to one app only"), "origins")
    for o in origins:
        conn.execute("INSERT INTO embed_origins (origin, app_id) VALUES (?,?)", (o, app_id))


def add_app(name: str, origins: list[str], mode: str, *, app_id: str = "", issuer: str = "", jwks_url: str = "",
            audience: str = "", public_jwk: str = "", default_agent: str = "", login_client_id: str = "", login_client_secret: str = "",
            now: float | None = None, by: str = "") -> dict:
    """앱을 등록한다. 틀린 값이면 AppError(ValueError, 사람이 읽는 문장). by 는 사용 기록에 남길 관리자(CLI 는 비움)."""
    now = time.time() if now is None else now
    v = _checked(name, origins, mode, issuer, jwks_url, audience, public_jwk, login_client_id, login_client_secret)
    app_id = app_id or "emb_" + secrets.token_hex(6)
    with _conn() as conn:
        if conn.execute("SELECT 1 FROM embed_apps WHERE app_id=?", (app_id,)).fetchone():
            raise AppError(tr(f"이미 있는 앱 번호입니다: {app_id}", f"App id already exists: {app_id}"), "app_id")
        _claim_origins(conn, v["origins"], app_id)
        conn.execute("INSERT INTO embed_apps (app_id, name, origins, mode, issuer, jwks_url, audience, public_jwk, default_agent, created, "
                     "login_client_id, login_client_secret) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
                     (app_id, v["name"], json.dumps(v["origins"]), v["mode"], v["issuer"], v["jwks_url"], v["audience"], v["public_jwk"],
                      str(default_agent or "").strip(), now, v["login_client_id"], v["login_client_secret"]))
    store.log_usage("embed_app_add", f"{by + ' ' if by else ''}{app_id} mode={v['mode']} origins={','.join(v['origins'])}")
    return get_app(app_id)


# 이 값이 바뀌면 이미 낸 임베드 토큰을 끝낸다 — 옛 신뢰 설정으로 받은 토큰이 15분 동안 남지 않게(OMAI-1873).
# 로그인 클라이언트 두 칸도 신뢰 설정이다 — 바뀌면 진행 중인 팝업 로그인과 로그인 세션도 지운다(OMAI-1911)
_TRUST_FIELDS = ("mode", "issuer", "jwks_url", "audience", "public_jwk", "login_client_id", "login_client_secret")


def _drop_logins(conn, app_id: str) -> None:
    """앱의 진행 중인 팝업 로그인과 로그인 세션을 지운다. 봉한 refresh token 은 verifier 가 없어 풀 수 없으므로 Keycloak revoke 는 하지 않는다 —
    봉한 값을 지우면 그 refresh token 은 아무도 쓸 수 없고, Keycloak 세션은 그 realm 의 유휴 시간에 끝난다(OMAI-1911)."""
    conn.execute("DELETE FROM embed_login WHERE app_id=?", (app_id,))
    conn.execute("DELETE FROM embed_login_sessions WHERE app_id=?", (app_id,))


def update_app(app_id: str, name: str, origins: list[str], mode: str, *, issuer: str = "", jwks_url: str = "", audience: str = "",
               public_jwk: str = "", default_agent: str = "", login_client_id: str = "", login_client_secret: str = "", by: str = "") -> dict:
    """앱을 고친다(app_id·만든 시각은 그대로). 없는 앱이면 AppError(field app_id).
    뺀 출처의 토큰은 출처 조인으로 곧바로 쓸 수 없고, 신뢰 설정(모드·issuer·JWKS·audience·공개 키·로그인 클라이언트)이 바뀌면
    그 앱의 토큰과 로그인 세션을 모두 지운다. login_client_secret 이 비었으면 등록된 비밀을 그대로 둔다."""
    with _conn() as conn:
        r = conn.execute("SELECT * FROM embed_apps WHERE app_id=?", (app_id,)).fetchone()
    if r is None:
        raise AppError(tr("없는 앱입니다", "App not found"), "app_id")
    v = _checked(name, origins, mode, issuer, jwks_url, audience, public_jwk, login_client_id, login_client_secret,
                 kept_secret=str(dict(r).get("login_client_secret") or ""))
    with _conn() as conn:
        r = conn.execute("SELECT * FROM embed_apps WHERE app_id=?", (app_id,)).fetchone()
        if r is None:
            raise AppError(tr("없는 앱입니다", "App not found"), "app_id")
        before = dict(r)
        conn.execute("DELETE FROM embed_origins WHERE app_id=?", (app_id,))
        _claim_origins(conn, v["origins"], app_id)
        conn.execute("UPDATE embed_apps SET name=?, origins=?, mode=?, issuer=?, jwks_url=?, audience=?, public_jwk=?, default_agent=?, "
                     "login_client_id=?, login_client_secret=? WHERE app_id=?",
                     (v["name"], json.dumps(v["origins"]), v["mode"], v["issuer"], v["jwks_url"], v["audience"], v["public_jwk"],
                      str(default_agent or "").strip(), v["login_client_id"], v["login_client_secret"], app_id))
        trust = any((before[f] or "") != v[f] for f in _TRUST_FIELDS)
        if trust:
            conn.execute("DELETE FROM embed_tokens WHERE app_id=?", (app_id,))
            _drop_logins(conn, app_id)
    store.log_usage("embed_app_update", f"{by + ' ' if by else ''}{app_id} mode={v['mode']} origins={','.join(v['origins'])}{' trust_changed' if trust else ''}")
    return get_app(app_id)


def remove_app(app_id: str, by: str = "") -> bool:
    """앱과 그 출처·토큰을 지운다. 지웠으면 True. 답 저장 형식은 행을 남기고 deleted=1 로 둔다 — 같은 앱 id 로 앱을 다시 만들어도
    형식은 살아나지 않고, 형식마다 다시 등록할 때 판이 이어진다(스펙 2026-11-18-012 D25②)."""
    with _conn() as conn:
        n = conn.execute("DELETE FROM embed_apps WHERE app_id=?", (app_id,)).rowcount
        conn.execute("UPDATE embed_formats SET deleted=1 WHERE app_id=?", (app_id,))
        conn.execute("DELETE FROM embed_origins WHERE app_id=?", (app_id,))
        conn.execute("DELETE FROM embed_tokens WHERE app_id=?", (app_id,))
        conn.execute("DELETE FROM embed_jti WHERE app_id=?", (app_id,))
        _drop_logins(conn, app_id)
    if n:
        store.log_usage("embed_app_remove", f"{by + ' ' if by else ''}{app_id}")
    return bool(n)


# ---- 답 저장 형식(스펙 2026-11-18-012 D17) -----------------------------------------------------------------------
FORMAT_ID = re.compile(r"^[a-z0-9][a-z0-9-]{0,47}$")
FORMAT_RESERVED = ("page", "none", "try")
LABEL_MAX = 40


class FormatError(ValueError):
    """형식 등록 값이 틀렸다. code 는 format.*(스펙 D22④), field 는 화면이 오류를 붙일 칸."""
    def __init__(self, code: str, status: int, field: str = "", errors: list | None = None):
        super().__init__(code)
        self.code, self.status, self.field, self.errors = code, status, field, errors or []


def _format_row(r) -> dict:
    d = dict(r)
    return {"id": d["format_id"], "label": {"ko": d["label_ko"], "en": d["label_en"]}, "schema": json.loads(d["schema_json"]),
            "instructions": d["instructions"], "version": int(d["version"]), "deleted": bool(d["deleted"]),
            "updated": d["updated"], "updated_by": d["updated_by"]}


def get_format(app_id: str, format_id: str, *, include_deleted: bool = False) -> dict | None:
    """형식 하나. 스키마·채우는 법·판을 한 번의 SELECT 로 읽는다(채우기가 같은 행으로 해시를 낸다, D24⑥)."""
    with _conn() as conn:
        r = conn.execute("SELECT * FROM embed_formats WHERE app_id=? AND format_id=?" + ("" if include_deleted else " AND deleted=0"),
                         (app_id, format_id)).fetchone()
    return _format_row(r) if r is not None else None


def list_formats(app_id: str) -> list[dict]:
    with _conn() as conn:
        return [_format_row(r) for r in conn.execute("SELECT * FROM embed_formats WHERE app_id=? AND deleted=0 ORDER BY format_id", (app_id,))]


def _checked_format(label: dict, schema, instructions: str) -> tuple[str, str, str, str]:
    from ..ops import answer_format as af
    label = label if isinstance(label, dict) else {}
    ko, en = str(label.get("ko") or "").strip(), str(label.get("en") or "").strip()
    if not ko or not en:
        raise FormatError("format.bad_request", 400, "label")
    if len(ko) > LABEL_MAX or len(en) > LABEL_MAX:
        raise FormatError("format.text_too_long", 400, "label")
    instructions = str(instructions or "")
    if len(instructions) > af.INSTRUCTIONS_MAX:
        raise FormatError("format.text_too_long", 400, "instructions")
    code, errors = af.check_schema(schema)
    if code:
        raise FormatError(code, 400, "schema", errors)
    return ko, en, af.compact(schema), instructions


def save_format(app_id: str, format_id: str, label: dict, schema, instructions: str = "", *, create: bool, by: str = "") -> dict:
    """형식 만들기(create)·고치기. 판은 스키마나 채우는 법이 바뀔 때 1 오르고 이름만 바꾸면 그대로다.
    지운(deleted) 형식을 같은 id 로 만들면 그 행을 살려 판을 이어서 올린다. 판 올리기는 한 트랜잭션의 version = version + 1 이다."""
    if get_app(app_id) is None:
        raise FormatError("format.not_found", 404, "app_id")
    if create:
        if not FORMAT_ID.match(format_id or ""):
            raise FormatError("format.id_invalid", 400, "id")
        if format_id in FORMAT_RESERVED:
            raise FormatError("format.id_reserved", 400, "id")
    ko, en, schema_json, instructions = _checked_format(label, schema, instructions)
    now = time.time()
    with _conn() as conn:
        r = conn.execute("SELECT * FROM embed_formats WHERE app_id=? AND format_id=?", (app_id, format_id)).fetchone()
        if create and r is not None and not r["deleted"]:
            raise FormatError("format.id_exists", 409, "id")
        if not create and (r is None or r["deleted"]):
            raise FormatError("format.not_found", 404, "id")
        if r is None:
            conn.execute("INSERT INTO embed_formats (app_id, format_id, label_ko, label_en, schema_json, instructions, version, deleted, "
                         "updated, updated_by) VALUES (?, ?, ?, ?, ?, ?, 1, 0, ?, ?)",
                         (app_id, format_id, ko, en, schema_json, instructions, now, by))
        else:
            bump = 1 if (r["deleted"] or r["schema_json"] != schema_json or r["instructions"] != instructions) else 0
            conn.execute("UPDATE embed_formats SET label_ko=?, label_en=?, schema_json=?, instructions=?, version = version + ?, deleted=0, "
                         "updated=?, updated_by=? WHERE app_id=? AND format_id=?",
                         (ko, en, schema_json, instructions, bump, now, by, app_id, format_id))
    store.log_usage("embed_format_save", f"{by + ' ' if by else ''}app={app_id} format={format_id}")
    return get_format(app_id, format_id)


def remove_format(app_id: str, format_id: str, by: str = "") -> bool:
    """형식을 지운다(행은 남기고 deleted=1, 판으로 확인하는 페이지가 옛 형식과 헷갈리지 않게)."""
    with _conn() as conn:
        n = conn.execute("UPDATE embed_formats SET deleted=1, updated=?, updated_by=? WHERE app_id=? AND format_id=? AND deleted=0",
                         (time.time(), by, app_id, format_id)).rowcount
    if n:
        store.log_usage("embed_format_remove", f"{by + ' ' if by else ''}app={app_id} format={format_id}")
    return bool(n)


def set_page_schema(app_id: str, on: bool, by: str = "") -> bool:
    """「페이지가 형식을 넘길 수 있음」. 없는 앱이면 False."""
    with _conn() as conn:
        n = conn.execute("UPDATE embed_apps SET page_schema=? WHERE app_id=?", (1 if on else 0, app_id)).rowcount
    if n:
        store.log_usage("embed_app_page_schema", f"{by + ' ' if by else ''}app={app_id} on={int(bool(on))}")
    return bool(n)


# ---- JWT(RS256) ---------------------------------------------------------------------------------------------
def _b64d(s: str) -> bytes:
    if not isinstance(s, str) or any(c not in "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_" for c in s):
        raise ValueError("b64")
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def _b64int(s: str) -> int:
    return int.from_bytes(_b64d(s), "big")


_SHA256_DIGEST_INFO = bytes.fromhex("3031300d060960864801650304020105000420")


def emsa_pkcs1_v15(message: bytes, k: int) -> bytes:
    """EMSA-PKCS1-v1_5 인코딩(RFC 8017 9.2) — SHA-256. k 는 모듈러스 바이트 수."""
    t = _SHA256_DIGEST_INFO + hashlib.sha256(message).digest()
    if k < len(t) + 11:
        raise ValueError("key too short")
    return b"\x00\x01" + b"\xff" * (k - len(t) - 3) + b"\x00" + t


def rsa_verify(message: bytes, signature: bytes, n: int, e: int) -> bool:
    """RSASSA-PKCS1-v1_5 검증(RFC 8017 8.2.2). 인코딩 전체를 상수 시간으로 비교한다."""
    k = (n.bit_length() + 7) // 8
    if len(signature) != k:
        return False
    s = int.from_bytes(signature, "big")
    if s >= n:
        return False
    em = pow(s, e, n).to_bytes(k, "big")
    try:
        want = emsa_pkcs1_v15(message, k)
    except ValueError:
        return False
    return hmac.compare_digest(em, want)


def _parse_jwk_text(text: str) -> dict:
    try:
        jwk = json.loads(text) if isinstance(text, str) else text
    except ValueError:
        raise ValueError(tr("공개 키(JWK)가 JSON 이 아닙니다", "The public key (JWK) is not JSON")) from None
    if isinstance(jwk, dict) and isinstance(jwk.get("keys"), list) and len(jwk["keys"]) == 1:
        jwk = jwk["keys"][0]                                 # JWKS 를 붙여 넣은 경우
    if not isinstance(jwk, dict):
        raise ValueError(tr("공개 키(JWK)가 객체가 아닙니다", "The public key (JWK) is not an object"))
    return jwk


def _rsa_key(jwk: dict) -> tuple[int, int]:
    """JWK → (n, e). RSA 서명 키가 아니거나 2048비트보다 작으면 ValueError. 개인 키 값(d)이 있으면 받지 않는다."""
    if jwk.get("kty") != "RSA" or jwk.get("use") not in (None, "sig") or jwk.get("alg") not in (None, "RS256"):
        raise ValueError(tr("RS256 서명용 RSA 공개 키(JWK)만 받습니다", "Only RSA public keys (JWK) for RS256 signatures are accepted"))
    if "d" in jwk:
        raise ValueError(tr("개인 키가 들어 있습니다. 공개 키만 넣으세요", "This contains a private key. Paste the public key only"))
    try:
        n, e = _b64int(jwk["n"]), _b64int(jwk["e"])
    except (KeyError, ValueError, TypeError):
        raise ValueError(tr("공개 키(JWK)의 n·e 를 읽지 못했습니다", "Cannot read n and e of the public key (JWK)")) from None
    if n.bit_length() < RSA_MIN_BITS or e < 3 or e % 2 == 0:
        raise ValueError(tr(f"RSA 키는 {RSA_MIN_BITS}비트 이상이어야 합니다", f"The RSA key must be at least {RSA_MIN_BITS} bits"))
    return n, e


def _split(token: str) -> tuple[dict, dict, bytes, bytes]:
    """(header, claims, 서명할 바이트, 서명). 형식이 틀리면 EmbedError 401."""
    try:
        h64, p64, s64 = str(token or "").strip().split(".")
        header, claims = json.loads(_b64d(h64)), json.loads(_b64d(p64))
        sig = _b64d(s64)
    except (ValueError, TypeError):
        raise EmbedError(401, "token_invalid", tr("토큰 형식이 틀렸습니다", "Malformed token")) from None
    if not isinstance(header, dict) or not isinstance(claims, dict):
        raise EmbedError(401, "token_invalid", tr("토큰 형식이 틀렸습니다", "Malformed token"))
    if header.get("alg") != "RS256":                         # none·HS256 등은 받지 않는다(공유 비밀·서명 없음)
        raise EmbedError(401, "token_invalid", tr("RS256 서명 토큰만 받습니다", "Only RS256-signed tokens are accepted"))
    if "crit" in header:
        raise EmbedError(401, "token_invalid", tr("토큰 형식이 틀렸습니다", "Malformed token"))
    return header, claims, f"{h64}.{p64}".encode("ascii"), sig


def _check_time(claims: dict, now: float) -> float:
    exp = claims.get("exp")
    if isinstance(exp, bool) or not isinstance(exp, (int, float)):
        raise EmbedError(401, "token_mismatch", tr("토큰에 만료 시각이 없습니다", "The token has no expiry"))
    if exp + LEEWAY < now:
        raise EmbedError(401, "token_invalid", tr("토큰이 만료됐습니다", "The token has expired"))
    nbf = claims.get("nbf")
    if isinstance(nbf, (int, float)) and not isinstance(nbf, bool) and nbf - LEEWAY > now:
        raise EmbedError(401, "token_invalid", tr("아직 쓸 수 없는 토큰입니다", "The token is not valid yet"))
    return float(exp)


def _aud_has(claims: dict, wanted: set[str]) -> bool:
    aud = claims.get("aud")
    got = [aud] if isinstance(aud, str) else aud if isinstance(aud, list) else []
    return any(isinstance(a, str) and a in wanted for a in got)


# ---- JWKS ---------------------------------------------------------------------------------------------------
_jwks: dict[str, tuple[float, dict]] = {}               # 주소 → (받은 시각, {kid: (n, e)})
_jwks_refetched: dict[str, float] = {}                  # 주소 → 모르는 kid 로 다시 받은 시각
_jwks_lock = threading.Lock()


def _fetch_jwks(url: str) -> dict:
    """JWKS 를 받아 {kid: (n, e)}. 못 받으면 EmbedError 503 과 로그 한 줄(TLS 오류 원인 포함)."""
    req = urllib.request.Request(url, headers={"Accept": "application/json"})
    try:
        with tls.urlopen(req, timeout=JWKS_TIMEOUT) as r:
            body = json.loads(r.read(1024 * 1024))
    except (urllib.error.URLError, OSError, ValueError) as exc:
        reason = getattr(exc, "reason", None) or exc
        print(f"임베드: Keycloak JWKS 를 받지 못했습니다: {type(exc).__name__}: {str(reason)[:200]}", flush=True)   # i18n-ignore: 로그
        raise EmbedError(503, "idp_unreachable", tr("Keycloak 에 연결할 수 없습니다", "Cannot reach Keycloak")) from None
    keys = {}
    for jwk in (body.get("keys") if isinstance(body, dict) else None) or []:
        if not isinstance(jwk, dict):
            continue
        try:
            keys[str(jwk.get("kid") or "")] = _rsa_key(jwk)
        except ValueError:
            continue                                      # 암호화용·EC 키 등은 건너뛴다
    return keys


def _jwks_key(url: str, kid: str, now: float) -> tuple[int, int] | None:
    """kid 의 공개 키. 캐시(10분)에 없으면 한 번 다시 받는다(키 회전). 그래도 없으면 None."""
    with _jwks_lock:
        got = _jwks.get(url)
    if got is None or now - got[0] >= JWKS_TTL:
        keys = _fetch_jwks(url)
        with _jwks_lock:
            _jwks[url] = got = (now, keys)
    if kid in got[1]:
        return got[1][kid]
    with _jwks_lock:
        recent = now - _jwks_refetched.get(url, -1e9) < JWKS_REFETCH_EVERY
        if not recent:
            _jwks_refetched[url] = now
    if recent:
        return None
    keys = _fetch_jwks(url)
    with _jwks_lock:
        _jwks[url] = (now, keys)
    return keys.get(kid)


def forget_jwks() -> None:
    with _jwks_lock:
        _jwks.clear()
        _jwks_refetched.clear()


# ---- 검증 ---------------------------------------------------------------------------------------------------
def verify_keycloak(app: dict, assertion: str, now: float | None = None) -> dict:
    """호스트 realm 의 액세스 토큰을 검증하고 claim 을 돌려준다. 이메일 확인·도메인은 부른 쪽이 Auth.verified_email 로 본다."""
    now = time.time() if now is None else now
    header, claims, signed, sig = _split(assertion)
    key = _jwks_key(app["jwks_url"], str(header.get("kid") or ""), now)
    if key is None or not rsa_verify(signed, sig, *key):
        raise EmbedError(401, "token_mismatch", tr("토큰 서명이 맞지 않습니다", "The token signature does not match"))
    if claims.get("iss") != app["issuer"]:
        raise EmbedError(401, "token_mismatch", tr("믿는 발급자의 토큰이 아닙니다", "The token is not from the trusted issuer"))
    if not _aud_has(claims, {app["audience"]}):            # azp 만으로는 받지 않는다 — 같은 realm 의 다른 서비스 토큰을 막는다
        raise EmbedError(401, "token_mismatch", tr("AAS 를 위한 토큰이 아닙니다(aud)", "The token is not for AAS (aud)"))
    _check_time(claims, now)
    return claims


def verify_host_signed(app: dict, assertion: str, aas_urls: list[str], now: float | None = None) -> dict:
    """호스트 서버가 서명한 토큰. iss=app_id, aud=AAS 주소, exp 는 5분 이하, jti 는 한 번만."""
    now = time.time() if now is None else now
    header, claims, signed, sig = _split(assertion)
    try:
        key = _rsa_key(_parse_jwk_text(app["public_jwk"]))
    except ValueError:
        raise EmbedError(401, "token_mismatch", tr("앱의 공개 키를 읽지 못했습니다", "Cannot read the app public key")) from None
    if not rsa_verify(signed, sig, *key):
        raise EmbedError(401, "token_mismatch", tr("토큰 서명이 맞지 않습니다", "The token signature does not match"))
    if claims.get("iss") != app["app_id"]:
        raise EmbedError(401, "token_mismatch", tr("발급자(iss)가 앱 번호와 다릅니다", "The issuer (iss) is not the app id"))
    if not _aud_has(claims, {u.rstrip("/") for u in aas_urls if u}):
        raise EmbedError(401, "token_mismatch", tr("이 AAS 를 위한 토큰이 아닙니다(aud)", "The token is not for this AAS (aud)"))
    exp = _check_time(claims, now)
    if exp > now + HOST_TTL_MAX + LEEWAY:
        raise EmbedError(401, "token_mismatch", tr("토큰 유효 기간은 5분 이하여야 합니다", "The token must expire within 5 minutes"))
    jti = claims.get("jti")
    if not isinstance(jti, str) or not jti or len(jti) > 200:
        raise EmbedError(401, "token_mismatch", tr("토큰에 jti 가 없습니다", "The token has no jti"))
    with _conn() as conn:
        conn.execute("DELETE FROM embed_jti WHERE expires < ?", (now - LEEWAY,))
        n = conn.execute("INSERT INTO embed_jti (jti, app_id, expires) VALUES (?,?,?) ON CONFLICT (app_id, jti) DO NOTHING",
                         (jti, app["app_id"], exp)).rowcount
    if not n:
        raise EmbedError(401, "token_invalid", tr("이미 쓴 토큰입니다", "The token was already used"))
    return claims


def host_email(claims: dict) -> str:
    """host-signed 토큰의 사용자: email, 없으면 이메일 꼴의 sub."""
    email = claims.get("email") or claims.get("sub") or ""
    email = str(email).strip().lower()
    return email if "@" in email else ""


def aas_sub(email: str) -> str:
    """AAS 로그인 기록에 남은 그 이메일의 sub(AAS realm). 없으면 ""(주인 확인은 이메일로도 된다)."""
    with store.connect() as conn:
        r = conn.execute("SELECT sub FROM auth_sessions WHERE email=? AND sub<>'' ORDER BY created DESC LIMIT 1", (email.lower(),)).fetchone()
    return str(r["sub"]) if r is not None else ""


def has_logged_in(email: str) -> bool:
    with store.connect() as conn:
        return conn.execute("SELECT 1 FROM auth_sessions WHERE email=? LIMIT 1", (email.lower(),)).fetchone() is not None


# ---- 임베드 토큰 ----------------------------------------------------------------------------------------------
def issue(app: dict, origin: str, email: str, sub: str = "", now: float | None = None, login_session: str = "",
          until: float | None = None) -> tuple[str, float]:
    """(원문, 만료 시각). 원문은 이때 한 번만 돌려준다. 팝업 로그인 토큰은 login_session 을 달고, 만료가 세션 상한(until)을 넘지 않는다."""
    now = time.time() if now is None else now
    raw = TOKEN_PREFIX + secrets.token_urlsafe(32)
    expires = now + TOKEN_TTL if until is None else min(now + TOKEN_TTL, until)
    with _conn() as conn:
        conn.execute("INSERT INTO embed_tokens (token_hash, app_id, origin, user_sub, user_email, created, expires, login_session) "
                     "VALUES (?,?,?,?,?,?,?,?)", (_hash(raw), app["app_id"], normalize_origin(origin), sub, email.lower(), now, expires, login_session))
    return raw, expires


def _lookup(where: str, value: str, origin: str, now: float) -> dict | None:
    o = normalize_origin(origin)
    if not o or not value:
        return None
    with _conn() as conn:          # 앱을 지웠거나 출처를 다른 앱으로 옮겼으면 그 토큰은 더 쓰지 못한다
        r = conn.execute(f"SELECT t.* FROM embed_tokens t JOIN embed_origins o ON o.origin = t.origin AND o.app_id = t.app_id "
                         f"WHERE t.{where}=?", (value,)).fetchone()
    if r is None:
        return None
    d = dict(r)
    if d["revoked"] or d["expires"] < now or d["origin"] != o:
        return None
    return d


def lookup(raw: str, origin: str, now: float | None = None) -> dict | None:
    """Bearer 원문 → 살아 있고 출처까지 맞는 줄. 아니면 None."""
    now = time.time() if now is None else now
    if not str(raw or "").startswith(TOKEN_PREFIX):
        return None
    return _lookup("token_hash", _hash(raw), origin, now)


def lookup_hash(token_hash: str, origin: str, now: float | None = None) -> dict | None:
    """웹소켓이 들고 있는 해시로 다시 확인한다(폐기·만료)."""
    return _lookup("token_hash", token_hash, origin, time.time() if now is None else now)


def revoke(raw: str, origin: str, now: float | None = None, verifier: str = "") -> bool:
    """토큰을 폐기한다. 팝업 로그인 토큰이면 그 로그인 세션도 지우고, verifier 가 맞으면 호스트 refresh token 도 Keycloak 에서
    폐기한다(실패해도 진행, OMAI-1911). 폐기한 토큰이 있었으면 True."""
    now = time.time() if now is None else now
    row = lookup(raw, origin, now)
    n, sess = 0, None
    if row is not None:
        with _conn() as conn:
            n = conn.execute("UPDATE embed_tokens SET revoked=? WHERE token_hash=? AND revoked=0", (now, row["token_hash"])).rowcount
    if str(raw or "").startswith(TOKEN_PREFIX):          # 만료된 토큰이어도 세션은 끝낸다(절전 뒤 destroy)
        with _conn() as conn:
            sess = conn.execute("DELETE FROM embed_login_sessions WHERE token_hash=? AND origin=? RETURNING *",
                                (_hash(raw), normalize_origin(origin))).fetchone()
            if sess is not None:
                conn.execute("UPDATE embed_tokens SET revoked=? WHERE login_session=? AND revoked=0", (now, sess["session_hash"]))
        if sess is not None:
            sess = dict(sess)
            store.log_usage("embed_login_end", f"{sess['email']} app={sess['app_id']} revoke")
            if _valid_login_value(verifier) and hmac.compare_digest(sess["verifier_hash"], _hash(verifier)):
                _kc_revoke(sess["app_id"], sess["refresh_sealed"], verifier)
    return bool(n)


def prune(now: float | None = None) -> int:
    """만료·폐기 1시간이 지난 토큰 줄과 지난 jti, 끝난 팝업 로그인·로그인 세션을 지운다. 지운 토큰 줄 수."""
    now = time.time() if now is None else now
    with _conn() as conn:
        n = conn.execute("DELETE FROM embed_tokens WHERE expires < ? OR (revoked > 0 AND revoked < ?)",
                         (now - KEEP_ENDED, now - KEEP_ENDED)).rowcount
        conn.execute("DELETE FROM embed_jti WHERE expires < ?", (now - LEEWAY,))
        conn.execute("DELETE FROM embed_login WHERE expires < ?", (now,))
        conn.execute("DELETE FROM embed_login_sessions WHERE expires < ?", (now,))
    return int(n or 0)


def embed_user(row: dict) -> dict:
    """토큰 줄 → 요청 사용자. mcp_server.token_user 와 같은 모양이고 관리자 권한은 쓰지 않는다(Registry.is_admin 이 via 를 본다)."""
    return {"email": row["user_email"], "name": row["user_email"], "sub": row["user_sub"], "admin": False, "via": "embed",
            "token": row["token_hash"][:12], "embed_app": row["app_id"]}


# ---- 내장 팝업 로그인(OMAI-1911) ---------------------------------------------------------------------------------
def _valid_login_value(value) -> bool:
    return isinstance(value, str) and LOGIN_FORMAT.fullmatch(value) is not None


def login_max_seconds() -> float:
    """로그인 세션의 절대 수명(AAS_EMBED_LOGIN_MAX_HOURS, 기본 12시간). 갱신해도 이 시간을 넘지 않는다."""
    try:
        hours = float(config.get("AAS_EMBED_LOGIN_MAX_HOURS", "12") or 12)
    except ValueError:
        hours = 12.0
    return max(hours, 0.1) * 3600


def _kc_base(app: dict) -> str:
    """JWKS 주소(서버 안 주소)에서 …/protocol/openid-connect 까지. 토큰·revoke 엔드포인트를 여기서 얻는다."""
    url = str(app.get("jwks_url") or "").rstrip("/")
    if not url.endswith("/protocol/openid-connect/certs"):
        raise EmbedError(503, "idp_unreachable", tr("앱의 JWKS 주소에서 Keycloak 토큰 주소를 얻지 못했습니다",
                                                    "Cannot derive the Keycloak token address from the app JWKS address"))
    return url[:-len("/certs")]


def _authorize_url(app: dict) -> str:
    """브라우저가 가는 인가 주소 — 공개 issuer 주소 아래다."""
    return str(app["issuer"]).rstrip("/") + "/protocol/openid-connect/auth"


def _token_url(app: dict) -> str:
    """서버가 부르는 토큰 엔드포인트 — JWKS 와 같은 서버 안 주소다(서버 파드는 공개 주소를 풀지 못할 수 있다)."""
    return _kc_base(app) + "/token"


def _forwarded(issuer: str) -> dict:
    """공개 issuer 의 X-Forwarded-* 헤더(OMAI-1911). hostname 을 고정하지 않은 Keycloak(KC_HOSTNAME_STRICT=false,
    KC_PROXY_HEADERS=xforwarded — OKE COP realm 이 그렇다)은 요청 호스트로 iss 를 정한다. 서버 안 주소로 부르면 iss 가
    http://<서비스>:8080/... 이 되어 앱 issuer 와 달라 id_token 검사가 늘 실패한다. 헤더를 믿지 않는 Keycloak 은 무시한다."""
    u = urllib.parse.urlsplit(issuer)
    if not u.hostname:
        return {}
    port = u.port or (443 if u.scheme == "https" else 80)
    return {"X-Forwarded-Host": u.hostname, "X-Forwarded-Proto": u.scheme, "X-Forwarded-Port": str(port)}


def _kc_post(url: str, form: dict, issuer: str = "") -> dict:
    """Keycloak 에 form POST. 400·401 은 EmbedError 401 token_invalid(invalid_grant 등), 그 밖의 실패는 503.
    issuer: 앱의 공개 issuer — 서버 안 주소로 불러도 공개 issuer 로 토큰을 받게 X-Forwarded-* 를 싣는다."""
    req = urllib.request.Request(url, data=urllib.parse.urlencode(form).encode(),
                                 headers={"Content-Type": "application/x-www-form-urlencoded", "Accept": "application/json",
                                          **(_forwarded(issuer) if issuer else {})})
    try:
        with tls.urlopen(req, timeout=KC_TIMEOUT) as r:
            body = json.loads(r.read(1024 * 1024) or b"{}")
    except urllib.error.HTTPError as exc:
        if exc.code in (400, 401):
            raise EmbedError(401, "token_invalid", tr("호스트 로그인이 끝났습니다. 다시 로그인하세요",
                                                      "The host sign-in has ended. Sign in again")) from None
        raise EmbedError(503, "idp_unreachable", tr("Keycloak 에 연결할 수 없습니다", "Cannot reach Keycloak")) from None
    except (urllib.error.URLError, OSError, ValueError) as exc:
        reason = getattr(exc, "reason", None) or exc
        print(f"임베드 로그인: Keycloak 토큰 엔드포인트 오류: {type(exc).__name__}: {str(reason)[:200]}", flush=True)   # i18n-ignore: 로그
        raise EmbedError(503, "idp_unreachable", tr("Keycloak 에 연결할 수 없습니다", "Cannot reach Keycloak")) from None
    if not isinstance(body, dict):
        raise EmbedError(503, "idp_unreachable", tr("Keycloak 응답을 읽지 못했습니다", "Cannot read the Keycloak response"))
    return body


def _kc_revoke(app_id: str, sealed: str, verifier: str) -> None:
    """호스트 refresh token 을 Keycloak 에서 폐기한다(RFC 7009). 실패해도 AAS 쪽 정리는 이미 끝났다."""
    try:
        from .auth import unseal
        app, secret = get_app(app_id), _login_secret(app_id)
        rt = unseal(sealed, secret, verifier) if app and secret else ""
        if rt:
            _kc_post(_kc_base(app) + "/revoke", {"token": rt, "token_type_hint": "refresh_token",
                                                 "client_id": app["login_client_id"], "client_secret": secret}, app["issuer"])
    except Exception as exc:                              # noqa: BLE001 — 폐기는 최선만 한다
        print(f"임베드 로그인: Keycloak refresh token 폐기 실패: {type(exc).__name__}", flush=True)   # i18n-ignore: 로그


def verify_login_id_token(app: dict, id_token: str, nonce: str | None, now: float | None = None) -> dict:
    """팝업 로그인의 id_token: 서명(JWKS)·iss=앱 issuer(공개 주소)·aud∋로그인 client_id·azp·exp·nonce. 틀리면 EmbedError 401.
    nonce 가 None 이면(갱신) 보지 않는다."""
    now = time.time() if now is None else now
    header, claims, signed, sig = _split(id_token)
    key = _jwks_key(app["jwks_url"], str(header.get("kid") or ""), now)
    if key is None or not rsa_verify(signed, sig, *key):
        raise EmbedError(401, "token_mismatch", tr("로그인 응답의 서명이 맞지 않습니다", "The sign-in response signature does not match"))
    if claims.get("iss") != app["issuer"]:
        raise EmbedError(401, "token_mismatch", tr("믿는 발급자의 로그인 응답이 아닙니다", "The sign-in response is not from the trusted issuer"))
    client = app.get("login_client_id") or ""
    aud = claims.get("aud")
    auds = [aud] if isinstance(aud, str) else aud if isinstance(aud, list) else []
    azp = claims.get("azp")
    if not client or client not in auds or (azp is not None and azp != client) or (len(auds) > 1 and azp is None):
        raise EmbedError(401, "token_mismatch", tr("이 로그인 클라이언트를 위한 응답이 아닙니다(aud·azp)",
                                                   "The sign-in response is not for this client (aud, azp)"))
    _check_time(claims, now)
    if nonce is not None and not hmac.compare_digest(str(claims.get("nonce") or ""), nonce):
        raise EmbedError(401, "token_mismatch", tr("로그인 요청과 응답이 맞지 않습니다", "The sign-in request and response do not match"))
    return claims


def login_begin(origin: str, nonce: str, base: str, now: float | None = None) -> tuple[str, str]:
    """(인가 주소, 쿠키 값). 출처가 등록됐고 keycloak 모드이며 로그인 클라이언트가 있어야 한다. 아니면 EmbedError 400."""
    now = time.time() if now is None else now
    app = app_for_origin(origin)
    if not _valid_login_value(nonce):
        raise EmbedError(400, "login_invalid", tr("로그인 요청 형식이 틀렸습니다", "Malformed sign-in request"))
    if app is None:
        raise EmbedError(400, "origin_not_registered", tr("이 사이트는 AAS 에 등록되지 않았습니다. 관리자에게 문의하세요",
                                                          "This site is not registered in AAS. Ask an admin"))
    if not popup_login(app):
        raise EmbedError(400, "login_unavailable", tr("이 사이트는 팝업 로그인을 쓰지 않습니다", "This site does not use popup sign-in"))
    state, oidc_nonce, pkce = secrets.token_urlsafe(32), secrets.token_urlsafe(24), secrets.token_urlsafe(48)
    redirect = base.rstrip("/") + "/embed/login/callback"
    data = {"nonce": nonce, "oidc_nonce": oidc_nonce, "pkce": pkce, "redirect": redirect}
    with _conn() as conn:
        conn.execute("DELETE FROM embed_login WHERE expires < ?", (now,))
        conn.execute("DELETE FROM embed_login WHERE nonce_hash=?", (_hash(nonce),))      # 같은 nonce 로 다시 열면 새로 시작한다
        conn.execute("INSERT INTO embed_login (nonce_hash, app_id, origin, state_hash, stage, data, created, expires) VALUES (?,?,?,?,?,?,?,?)",
                     (_hash(nonce), app["app_id"], normalize_origin(origin), _hash(state), "begun", json.dumps(data), now, now + LOGIN_TTL))
    challenge = base64.urlsafe_b64encode(hashlib.sha256(pkce.encode()).digest()).rstrip(b"=").decode()
    q = {"response_type": "code", "client_id": app["login_client_id"], "redirect_uri": redirect, "scope": "openid email",
         "state": state, "nonce": oidc_nonce, "code_challenge": challenge, "code_challenge_method": "S256"}
    store.log_usage("embed_login_begin", f"app={app['app_id']} origin={normalize_origin(origin)}")
    return _authorize_url(app) + "?" + urllib.parse.urlencode(q), _hash(state)


def login_callback(state: str, code: str, cookie: str, admit, now: float | None = None, alias=None) -> dict:
    """호스트 realm 이 돌려보낸 코드를 바꾸고 id_token 을 검사한다. admit(claims) 는 AAS 가 들일 이메일을 돌려주거나 EmbedError 를 낸다.
    alias(app, tokens, claims) 는 로그인 도메인 처리(스펙 2026-11-15-005)다 — (tokens, claims) 를 돌려주고 이메일을 바꿨으면 새 값이다.
    돌려주는 값: {origin, nonce, secret} — 연결 화면이 쓴다. secret 은 confirm 비밀(state 와 다른 값)이고 DB 에는 해시만 둔다."""
    from .auth import seal
    now = time.time() if now is None else now
    if not state or not cookie or not hmac.compare_digest(str(cookie), _hash(state)):
        raise EmbedError(400, "login_invalid", tr("이 브라우저에서 시작한 로그인이 아닙니다. 위젯에서 「로그인」을 다시 누르세요",
                                                  "This sign-in was not started in this browser. Press Sign in in the widget again"))
    with _conn() as conn:                                 # 한 번만 꺼낸다 — 같은 state 로 두 번 바꾸지 못한다
        r = conn.execute("UPDATE embed_login SET stage='called' WHERE state_hash=? AND stage='begun' RETURNING *", (_hash(state),)).fetchone()
    if r is None or r["expires"] < now:
        raise EmbedError(400, "login_invalid", tr("로그인 요청이 만료됐거나 알 수 없는 요청입니다. 위젯에서 「로그인」을 다시 누르세요",
                                                  "The sign-in request expired or is unknown. Press Sign in in the widget again"))
    row, data = dict(r), json.loads(r["data"])
    try:
        app = get_app(row["app_id"])
        secret = _login_secret(row["app_id"]) if app else ""
        if not popup_login(app) or not code:
            raise EmbedError(400, "login_invalid", tr("로그인을 마치지 못했습니다", "The sign-in did not complete"))
        tokens = _kc_post(_token_url(app), {"grant_type": "authorization_code", "code": code, "redirect_uri": data["redirect"],
                                            "client_id": app["login_client_id"], "client_secret": secret, "code_verifier": data["pkce"]}, app["issuer"])
        claims = verify_login_id_token(app, str(tokens.get("id_token") or ""), data["oidc_nonce"], now)
        if alias is not None:
            tokens, claims = alias(app, tokens, claims)
        email = admit(claims)
        rt = str(tokens.get("refresh_token") or "")
        if not rt:
            raise EmbedError(401, "token_mismatch", tr("Keycloak 이 refresh token 을 주지 않았습니다", "Keycloak returned no refresh token"))
        confirm = secrets.token_urlsafe(32)
        with _conn() as conn:                             # refresh token 은 confirm 비밀로 봉해 둔다(원문은 DB 에 두지 않는다)
            n = conn.execute("UPDATE embed_login SET stage='verified', confirm_hash=?, email=?, refresh_sealed=? "
                             "WHERE nonce_hash=? AND stage='called'",
                             (_hash(confirm), email, seal(rt, secret, confirm), row["nonce_hash"])).rowcount
        if not n:
            raise EmbedError(400, "login_invalid", tr("로그인 요청이 만료됐습니다", "The sign-in request expired"))
    except EmbedError as exc:
        with _conn() as conn:                             # 실패한 로그인은 지운다 — 위젯의 꺼내기가 401 을 받고 멈춘다
            conn.execute("DELETE FROM embed_login WHERE nonce_hash=?", (row["nonce_hash"],))
        store.log_usage("embed_login_fail", f"app={row['app_id']} origin={row['origin']} {exc.code}")
        raise
    store.log_usage("embed_login_ok", f"{email} app={row['app_id']} origin={row['origin']}")
    return {"origin": row["origin"], "nonce": data["nonce"], "secret": confirm}


def login_confirm(secret: str, verifier: str, now: float | None = None) -> bool:
    """연결 화면이 위젯에게서 받은 verifier 를 행에 묶는다. 승인했으면 True. confirm 비밀이 틀렸거나 이미 승인했으면 False."""
    from .auth import seal, unseal
    now = time.time() if now is None else now
    if not isinstance(secret, str) or not secret or len(secret) > 200 or not _valid_login_value(verifier):
        return False
    with _conn() as conn:
        r = conn.execute("SELECT * FROM embed_login WHERE confirm_hash=? AND stage='verified'", (_hash(secret),)).fetchone()
    if r is None or r["expires"] < now:
        return False
    row = dict(r)
    lsecret = _login_secret(row["app_id"])
    rt = unseal(row["refresh_sealed"], lsecret, secret)
    if not rt:
        return False
    with _conn() as conn:                                 # 이제 verifier 로 다시 봉한다. 두 번째 승인은 stage 조건으로 막힌다
        n = conn.execute("UPDATE embed_login SET stage='approved', verifier_hash=?, refresh_sealed=?, confirm_hash='' "
                         "WHERE nonce_hash=? AND stage='verified'",
                         (_hash(verifier), seal(rt, lsecret, verifier), row["nonce_hash"])).rowcount
    return bool(n)


def login_redeem(origin: str, nonce: str, verifier: str, now: float | None = None) -> dict | None:
    """위젯의 꺼내기. 대기 중이면 None(202). 승인됐고 verifier 가 맞으면 한 번만 로그인 세션을 만들고
    {app, email, token, expires} 를 돌려준다. 그 밖은 EmbedError 401 token_invalid."""
    now = time.time() if now is None else now
    gone = EmbedError(401, "token_invalid", tr("로그인이 만료됐거나 알 수 없는 로그인입니다. 다시 로그인하세요",
                                               "The sign-in expired or is unknown. Sign in again"))
    if not _valid_login_value(nonce) or not _valid_login_value(verifier):
        raise gone
    with _conn() as conn:
        r = conn.execute("SELECT * FROM embed_login WHERE nonce_hash=?", (_hash(nonce),)).fetchone()
    if r is None or r["expires"] < now or r["origin"] != normalize_origin(origin):
        raise gone
    if r["stage"] != "approved":
        return None
    if not hmac.compare_digest(r["verifier_hash"], _hash(verifier)):
        raise gone                                        # 행은 남긴다 — 틀린 verifier 로 남의 로그인을 지우지 못하게
    with _conn() as conn:                                 # 한 번만 꺼낸다
        r = conn.execute("DELETE FROM embed_login WHERE nonce_hash=? AND stage='approved' AND verifier_hash=? RETURNING *",
                         (_hash(nonce), _hash(verifier))).fetchone()
    app = app_for_origin(origin)
    if r is None or app is None or app["app_id"] != r["app_id"]:
        raise gone
    row = dict(r)
    session, until = secrets.token_hex(32), now + login_max_seconds()
    raw, expires = issue(app, origin, row["email"], aas_sub(row["email"]), now=now, login_session=session, until=until)
    with _conn() as conn:
        conn.execute("INSERT INTO embed_login_sessions (session_hash, app_id, origin, email, token_hash, verifier_hash, refresh_sealed, "
                     "created, expires) VALUES (?,?,?,?,?,?,?,?,?)",
                     (session, app["app_id"], row["origin"], row["email"], _hash(raw), row["verifier_hash"], row["refresh_sealed"], now, until))
    store.log_usage("embed_login_redeem", f"{row['email']} app={app['app_id']} origin={row['origin']}")
    return {"app": app, "email": row["email"], "token": raw, "expires": expires}


def login_refresh(raw_token: str, origin: str, verifier: str, admit, now: float | None = None) -> dict:
    """팝업으로 받은 임베드 토큰을 호스트 refresh token 으로 갱신한다. 만료된 임베드 토큰도 세션 상한 안이면 받는다(절전 뒤 복귀).
    새 토큰을 내면 옛 토큰은 곧바로 폐기하고, refresh token 교체는 원자적으로 한다(동시 갱신은 하나만 성공한다).
    admit(email) 은 AAS 가 지금도 들이는 사람인지 다시 본다. 실패는 EmbedError."""
    from .auth import seal, unseal
    now = time.time() if now is None else now
    gone = EmbedError(401, "token_invalid", tr("로그인이 끝났습니다. 다시 로그인하세요", "The sign-in has ended. Sign in again"))
    if not str(raw_token or "").startswith(TOKEN_PREFIX) or not _valid_login_value(verifier):
        raise gone
    o = normalize_origin(origin)
    with _conn() as conn:
        r = conn.execute("SELECT * FROM embed_login_sessions WHERE token_hash=?", (_hash(raw_token),)).fetchone()
    app = app_for_origin(origin)
    if r is None or r["origin"] != o or app is None or app["app_id"] != r["app_id"] or not popup_login(app):
        raise gone
    sess = dict(r)
    if sess["expires"] < now:
        with _conn() as conn:
            conn.execute("DELETE FROM embed_login_sessions WHERE session_hash=?", (sess["session_hash"],))
        store.log_usage("embed_login_end", f"{sess['email']} app={sess['app_id']} max_age")
        raise gone
    if not hmac.compare_digest(sess["verifier_hash"], _hash(verifier)):
        raise gone
    secret = _login_secret(app["app_id"])
    rt = unseal(sess["refresh_sealed"], secret, verifier)
    if not rt:
        raise gone

    def end(reason: str) -> None:
        with _conn() as conn:
            conn.execute("DELETE FROM embed_login_sessions WHERE session_hash=?", (sess["session_hash"],))
            conn.execute("UPDATE embed_tokens SET revoked=? WHERE login_session=? AND revoked=0", (now, sess["session_hash"]))
        store.log_usage("embed_login_end", f"{sess['email']} app={sess['app_id']} {reason}")

    try:
        tokens = _kc_post(_token_url(app), {"grant_type": "refresh_token", "refresh_token": rt,
                                            "client_id": app["login_client_id"], "client_secret": secret}, app["issuer"])
    except EmbedError as exc:
        if exc.status == 401:                             # invalid_grant: 호스트 SSO 세션 끝·계정 정지·관리자 로그아웃
            end("refresh_rejected")
        raise
    try:
        if tokens.get("id_token"):
            claims = verify_login_id_token(app, str(tokens["id_token"]), None, now)
            if str(claims.get("email") or "").lower() != sess["email"]:
                raise gone
        admit(sess["email"])
    except EmbedError as exc:
        if exc.status in (401, 403):                      # 다시 로그인해도 같은 거절(이메일 바뀜·AAS 권한 없음) — 세션을 끝낸다
            end("refresh_denied")
            raise (gone if exc.status == 401 else exc) from None
        # 일시 장애(429·503·JWKS)는 세션을 남긴다(OMAI-1911 리뷰). 다만 Keycloak 은 이미 refresh token 을 바꿔 주었을 수 있어
        # 새 값을 봉해 둔다 — 남겨 두지 않으면 옛 값은 폐기돼 다음 갱신이 invalid_grant 로 세션을 끝낸다
        with _conn() as conn:
            conn.execute("UPDATE embed_login_sessions SET refresh_sealed=? WHERE session_hash=? AND refresh_sealed=?",
                         (seal(str(tokens.get("refresh_token") or rt), secret, verifier), sess["session_hash"], sess["refresh_sealed"]))
        raise
    new_rt = str(tokens.get("refresh_token") or rt)
    raw, expires = TOKEN_PREFIX + secrets.token_urlsafe(32), min(now + TOKEN_TTL, sess["expires"])
    with _conn() as conn:                                 # 원자적 교체 — 같은 옛 토큰으로 동시에 온 갱신은 하나만 이긴다
        n = conn.execute("UPDATE embed_login_sessions SET token_hash=?, refresh_sealed=? "
                         "WHERE session_hash=? AND token_hash=? AND refresh_sealed=?",
                         (_hash(raw), seal(new_rt, secret, verifier), sess["session_hash"], sess["token_hash"], sess["refresh_sealed"])).rowcount
        if n:
            conn.execute("INSERT INTO embed_tokens (token_hash, app_id, origin, user_sub, user_email, created, expires, login_session) "
                         "VALUES (?,?,?,?,?,?,?,?)", (_hash(raw), app["app_id"], o, aas_sub(sess["email"]), sess["email"], now, expires,
                                                      sess["session_hash"]))
            conn.execute("UPDATE embed_tokens SET revoked=? WHERE token_hash=? AND revoked=0", (now, sess["token_hash"]))
    if not n:
        raise gone
    store.log_usage("embed_login_refresh", f"{sess['email']} app={app['app_id']} origin={o}")
    return {"app": app, "email": sess["email"], "token": raw, "expires": expires}


# ---- CLI -----------------------------------------------------------------------------------------------------
def _main(argv: list[str] | None = None) -> int:
    import argparse
    import sys
    p = argparse.ArgumentParser(prog="python -m aas.auth.embed", description="AAS chat embed apps (OMAI-1873)")
    sub = p.add_subparsers(dest="cmd", required=True)
    a = sub.add_parser("add", help="register an embed app")
    a.add_argument("--name", required=True)
    a.add_argument("--origin", action="append", required=True, help="allowed origin, e.g. https://cop.example.com (repeat)")
    a.add_argument("--mode", choices=MODES, required=True)
    a.add_argument("--app-id", default="")
    a.add_argument("--issuer", default="", help="keycloak: trusted issuer (realm URL)")
    a.add_argument("--jwks-url", default="", help="keycloak: internal JWKS address of that realm")
    a.add_argument("--audience", default="", help="keycloak: required aud value (e.g. aas-embed)")
    a.add_argument("--public-jwk", default="", help="host-signed: RS256 public JWK (JSON text or @file)")
    a.add_argument("--agent", default="", help="default agent (POD id)")
    a.add_argument("--login-client-id", default="", help="keycloak: popup sign-in client of the host realm (optional)")
    a.add_argument("--login-client-secret", default="", help="keycloak: secret of that client (value or @file)")
    a.add_argument("--idp-policy-checked", action="store_true",
                   help="keycloak: I checked that the host realm does not let users change their email or sign up by themselves")
    sub.add_parser("list", help="list embed apps")
    r = sub.add_parser("remove", help="remove an embed app and its tokens")
    r.add_argument("app_id")
    args = p.parse_args(argv)
    if args.cmd == "list":
        for app in list_apps():                           # 로그인 클라이언트 비밀은 list_apps 가 이미 뺐다(login_client_secret_set 만)
            app = {k: v for k, v in app.items() if k != "public_jwk"} | {"public_jwk": bool(app["public_jwk"])}
            print(json.dumps(app, ensure_ascii=False))
        return 0
    if args.cmd == "remove":
        ok = remove_app(args.app_id)
        print("removed" if ok else "not found")
        return 0 if ok else 1
    if args.mode == "keycloak" and not args.idp_policy_checked:
        # 호스트 realm 에서 이메일을 바꾸거나 스스로 가입할 수 있으면, 같은 이메일로 남의 AAS 계정에 들어간다(이메일로 잇는 규칙의 위험)
        print(tr("keycloak 모드는 호스트 realm 의 이메일 변경·자가 가입을 막았는지 확인한 뒤 --idp-policy-checked 를 붙여 등록합니다",
                 "For keycloak mode, check that the host realm blocks email changes and self sign-up, then add --idp-policy-checked"),
              file=sys.stderr)
        return 2
    jwk, login_secret = args.public_jwk, args.login_client_secret
    if jwk.startswith("@"):
        with open(jwk[1:], encoding="utf-8") as f:
            jwk = f.read()
    if login_secret.startswith("@"):                     # 비밀을 명령줄(프로세스 목록·셸 기록)에 남기지 않으려면 파일로 넘긴다
        with open(login_secret[1:], encoding="utf-8") as f:
            login_secret = f.read().strip()
    try:
        app = add_app(args.name, args.origin, args.mode, app_id=args.app_id, issuer=args.issuer, jwks_url=args.jwks_url,
                      audience=args.audience, public_jwk=jwk, default_agent=args.agent, login_client_id=args.login_client_id,
                      login_client_secret=login_secret)
    except ValueError as exc:
        print(str(exc), file=sys.stderr)
        return 2
    print(json.dumps({k: v for k, v in app.items() if k != "public_jwk"}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(_main())

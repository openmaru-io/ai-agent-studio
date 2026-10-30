# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""Claude Code 의 MCP OAuth 연결 — AAS 가 인가 서버를 한다(스펙 2026-10-28-001 §3-1-1 A·§3-1-2, OMAI-1513).

동적 클라이언트 등록(루프백 redirect 만, D13) → 동의 → code(PKCE S256) → 접근 토큰 1시간 + refresh.
연결 하나 = personal_tokens 의 kind=oauth 줄 하나(id=family). 그 줄의 token_hash 는 지금 접근 토큰, expires 는 연결 만료
(refresh 를 쓸 때마다 30일 뒤로, 재검토 D2). refresh 는 oauth_refresh 에 해시만 둔다.
refresh 를 바꾼 뒤 30초 안에 직전 refresh 가 다시 오면 같은 새 토큰을 돌려준다(재검토 F10) — 새 토큰 쌍을 직전 refresh 로만 열리게 봉해 둔다.
그 뒤 직전 refresh 가 쓰이면 재사용으로 보고 그 연결을 끊는다.
"""
from __future__ import annotations

import base64
import hashlib
import json
import secrets
import time
from urllib.parse import urlsplit

from ..common import store
from . import auth, mcp_limits, tokens

ACCESS_PREFIX, REFRESH_PREFIX = "aas_oat_", "aas_ort_"
ACCESS_TTL = 3600.0
CONNECTION_DAYS = 30                                     # 마지막으로 refresh 를 쓴 뒤 30일(Q5)
CODE_TTL = 300.0
REFRESH_GRACE = 30.0
NAME_MAX = 60
MAX_REDIRECTS = 5
LOOPBACK = ("localhost", "127.0.0.1", "::1")


class OAuthError(Exception):
    """RFC 6749 오류 낱말(invalid_request·invalid_client·invalid_grant·unsupported_grant_type·invalid_redirect_uri 등)."""
    def __init__(self, error: str, description: str = "", status: int = 400):
        super().__init__(description or error)
        self.error, self.description, self.status = error, description, status


def _hash(raw: str) -> str:
    return hashlib.sha256(raw.encode()).hexdigest()


def loopback(uri: str) -> bool:
    """http://localhost·127.0.0.1·[::1] 만(포트·경로 자유, D13). 사용자 정보·조각(#)이 든 주소는 받지 않는다."""
    try:
        u = urlsplit(uri)
    except ValueError:
        return False
    return u.scheme == "http" and (u.hostname or "") in LOOPBACK and not u.username and not u.password and not u.fragment \
        and "@" not in u.netloc


def _same_loopback(a: str, b: str) -> bool:
    """등록한 주소와 같은가. 루프백은 포트가 매번 바뀔 수 있어 포트는 보지 않는다(RFC 8252 §7.3)."""
    ua, ub = urlsplit(a), urlsplit(b)
    return (ua.scheme, ua.hostname, ua.path or "/", ua.query) == (ub.scheme, ub.hostname, ub.path or "/", ub.query)


# ---- 등록 ---------------------------------------------------------------------------------------------
def register(meta: dict, now: float | None = None) -> dict:
    """동적 클라이언트 등록(RFC 7591). 공개 클라이언트(token_endpoint_auth_method=none)만."""
    now = time.time() if now is None else now
    uris = meta.get("redirect_uris")
    if not isinstance(uris, list) or not uris or len(uris) > MAX_REDIRECTS or not all(isinstance(u, str) and len(u) <= 500 for u in uris):
        raise OAuthError("invalid_redirect_uri", "redirect_uris is required")
    if not all(loopback(u) for u in uris):
        raise OAuthError("invalid_redirect_uri", "only http://localhost, http://127.0.0.1 or http://[::1] redirect URIs are allowed")
    method = str(meta.get("token_endpoint_auth_method") or "none")
    if method != "none":
        raise OAuthError("invalid_client_metadata", "only public clients (token_endpoint_auth_method=none)")
    name = " ".join(str(meta.get("client_name") or "").split())[:NAME_MAX] or "MCP client"
    cid = "aasc_" + secrets.token_urlsafe(16)
    with tokens._conn() as conn:
        conn.execute("INSERT INTO oauth_clients (client_id, name, redirect_uris, created) VALUES (?,?,?,?)",
                     (cid, name, json.dumps(uris), now))
    store.log_usage("oauth_register", f"{cid} name={name[:40]}")
    return {"client_id": cid, "client_id_issued_at": int(now), "client_name": name, "redirect_uris": uris,
            "token_endpoint_auth_method": "none", "grant_types": ["authorization_code", "refresh_token"], "response_types": ["code"]}


def client(cid: str) -> dict | None:
    with tokens._conn() as conn:
        r = conn.execute("SELECT * FROM oauth_clients WHERE client_id=?", (cid or "",)).fetchone()
    if r is None:
        return None
    return {**dict(r), "redirect_uris": json.loads(r["redirect_uris"])}


def check_redirect(c: dict, uri: str) -> bool:
    return loopback(uri) and any(_same_loopback(uri, u) for u in c["redirect_uris"])


# ---- code ---------------------------------------------------------------------------------------------
def make_code(c: dict, user: dict, redirect_uri: str, challenge: str, bundle: str, now: float | None = None) -> str:
    now = time.time() if now is None else now
    if bundle not in tokens.BUNDLES:
        raise OAuthError("invalid_scope", "unknown bundle")
    code = secrets.token_urlsafe(32)
    with tokens._conn() as conn:
        conn.execute("DELETE FROM oauth_codes WHERE expires < ?", (now - CODE_TTL,))
        conn.execute("INSERT INTO oauth_codes (code_hash, client_id, user_email, user_sub, redirect_uri, challenge, bundle, expires) "
                     "VALUES (?,?,?,?,?,?,?,?)",
                     (_hash(code), c["client_id"], str(user.get("email") or "").lower(), str(user.get("sub") or ""),
                      redirect_uri, challenge, bundle, now + CODE_TTL))
    return code


def _pkce(verifier: str, challenge: str) -> bool:
    if not (43 <= len(verifier or "") <= 128):
        return False
    got = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
    return secrets.compare_digest(got, challenge)


def _pair(now: float) -> tuple[str, str]:
    return ACCESS_PREFIX + secrets.token_urlsafe(32), REFRESH_PREFIX + secrets.token_urlsafe(32)


def _grant(access: str, refresh: str, scopes: str) -> dict:
    return {"access_token": access, "token_type": "Bearer", "expires_in": int(ACCESS_TTL), "refresh_token": refresh, "scope": scopes}


def exchange(form: dict, now: float | None = None) -> dict:
    """grant_type=authorization_code. code 는 한 번만, PKCE·redirect_uri·client_id 가 맞아야 한다."""
    now = time.time() if now is None else now
    code, cid = str(form.get("code") or ""), str(form.get("client_id") or "")
    with tokens._conn() as conn:
        r = conn.execute("SELECT * FROM oauth_codes WHERE code_hash=?", (_hash(code),)).fetchone()
        if r is None or r["used"] or r["expires"] < now or r["client_id"] != cid:
            raise OAuthError("invalid_grant", "the code is unknown, used or expired")
        if conn.execute("UPDATE oauth_codes SET used=? WHERE code_hash=? AND used=0", (now, _hash(code))).rowcount != 1:
            raise OAuthError("invalid_grant", "the code was already used")
    if str(form.get("redirect_uri") or "") != r["redirect_uri"]:
        raise OAuthError("invalid_grant", "redirect_uri does not match")
    if not _pkce(str(form.get("code_verifier") or ""), r["challenge"]):
        raise OAuthError("invalid_grant", "code_verifier does not match")
    if tokens.active_count(r["user_email"], now) >= tokens.MAX_ACTIVE:
        raise OAuthError("invalid_request", f"up to {tokens.MAX_ACTIVE} connections; disconnect one on the AAS screen")
    c = client(cid) or {"name": "MCP client"}
    access, refresh = _pair(now)
    fam = secrets.token_hex(8)
    scopes = " ".join(tokens.BUNDLES[r["bundle"]])
    with tokens._conn() as conn:
        conn.execute("INSERT INTO personal_tokens (id, kind, family, user_sub, user_email, name, bundle, scopes, token_hash, prefix, "
                     "created, expires) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
                     (fam, "oauth", fam, r["user_sub"], r["user_email"], c["name"], r["bundle"], scopes, _hash(access),
                      access[len(ACCESS_PREFIX):][:8], now, now + CONNECTION_DAYS * 86400))
        conn.execute("INSERT INTO oauth_refresh (family, client_id, token_hash, access_expires) VALUES (?,?,?,?)",
                     (fam, cid, _hash(refresh), now + ACCESS_TTL))
    store.log_usage("oauth_connect", f"{r['user_email']} {fam} client={cid} bundle={r['bundle']}")
    return _grant(access, refresh, scopes)


def _seal_key() -> str:
    return mcp_limits._key().hex()


def refresh(form: dict, member=None, now: float | None = None) -> dict:
    """grant_type=refresh_token. member(email) 가 False 면 그 사람의 연결을 모두 끊는다(D12)."""
    now = time.time() if now is None else now
    raw, cid = str(form.get("refresh_token") or ""), str(form.get("client_id") or "")
    h = _hash(raw)
    with tokens._conn() as conn:
        cur = conn.execute("SELECT * FROM oauth_refresh WHERE token_hash=?", (h,)).fetchone()
        prev = None if cur is not None else conn.execute("SELECT * FROM oauth_refresh WHERE prev_hash=?", (h,)).fetchone()
        ref = cur or prev
        row = conn.execute("SELECT * FROM personal_tokens WHERE id=?", (ref["family"],)).fetchone() if ref is not None else None
    if ref is None or row is None:
        raise OAuthError("invalid_grant", "unknown refresh token")
    if cid and cid != ref["client_id"]:
        raise OAuthError("invalid_grant", "client_id does not match")
    if row["revoked"] or row["expires"] < now:
        raise OAuthError("invalid_grant", "the connection ended; connect again")
    if member is not None:
        ok = member(row["user_email"])
        if ok is None:
            raise OAuthError("temporarily_unavailable", "could not check the account", 503)
        if not ok:
            tokens.revoke_all(row["user_email"], by="keycloak")
            raise OAuthError("invalid_grant", "the account can no longer use AAS")
    if prev is not None:                                 # 직전 refresh
        if now <= float(prev["prev_until"]) and prev["grace_blob"]:
            try:
                pair = json.loads(auth.unseal(prev["grace_blob"], _seal_key(), raw))
                return _grant(pair["a"], pair["r"], row["scopes"])
            except Exception:
                pass
        tokens.revoke(row["id"], row["user_email"], by="aas", reason="refresh_reuse")   # 유예가 지난 재사용 — 새어 나간 것으로 본다
        raise OAuthError("invalid_grant", "refresh token reuse; the connection was ended")
    access, new = _pair(now)
    blob = auth.seal(json.dumps({"a": access, "r": new}), _seal_key(), raw)
    with tokens._conn() as conn:
        n = conn.execute("UPDATE oauth_refresh SET token_hash=?, prev_hash=?, prev_until=?, grace_blob=?, access_expires=? "
                         "WHERE family=? AND token_hash=?", (_hash(new), h, now + REFRESH_GRACE, blob, now + ACCESS_TTL, ref["family"], h)).rowcount
        if n != 1:                                       # 같은 refresh 로 동시에 바꿨다 — 먼저 바꾼 쪽의 쌍을 돌려준다
            again = conn.execute("SELECT grace_blob FROM oauth_refresh WHERE family=? AND prev_hash=?", (ref["family"], h)).fetchone()
            if again is None:
                raise OAuthError("invalid_grant", "unknown refresh token")
            pair = json.loads(auth.unseal(again["grace_blob"], _seal_key(), raw))
            return _grant(pair["a"], pair["r"], row["scopes"])
        conn.execute("UPDATE personal_tokens SET token_hash=?, prefix=?, expires=? WHERE id=?",
                     (_hash(access), access[len(ACCESS_PREFIX):][:8], now + CONNECTION_DAYS * 86400, row["id"]))
    return _grant(access, new, row["scopes"])

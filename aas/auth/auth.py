# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""OIDC 로그인(인가 코드 + PKCE)과 세션. 표준 라이브러리만 쓴다. 쿠버네티스에서는 Keycloak 을 쓴다.

설정(AAS_CONFIG_DIR/aas.env): AAS_OIDC_ISSUER, AAS_OIDC_CLIENT_ID, AAS_OIDC_CLIENT_SECRET 이 모두 있으면 켜진다.
발급자 기본값은 없다(Keycloak 이면 https://<호스트>/realms/<realm>). AAS_PUBLIC_URL(기본 localhost:17900),
AAS_PUBLIC_URLS(쉼표로 구분한 추가 접속 주소 — 예: https://aas.example.com).
권한은 토큰 claim 에서 로그인할 때마다 다시 읽는다:
  AAS_OIDC_USERS_GROUP(기본 aas-users): 이 그룹에 속해야 들어온다. 비우면 그룹을 따지지 않는다.
  AAS_OIDC_ADMIN_ROLE(기본 aas-admin): 이 역할이 있으면 관리자(그룹이 없어도 들어온다). 비우면 역할로는 관리자를 만들지 않는다.
  AAS_OIDC_GROUPS_CLAIM(기본 groups): 그룹 목록이 담긴 claim 이름. 역할은 realm_access.roles 와 resource_access.<client>.roles 에서 읽는다.
  AAS_ALLOWED_DOMAIN(기본 없음): 정하면 그 도메인 이메일만 받는다.
신원 키는 sub 다. 이메일은 표시와 검색용이다.

id_token 은 토큰 엔드포인트에서 TLS 로 직접 받는다. OIDC Core 3.1.3.7 은 이 경우 서명 검증을
TLS 서버 검증으로 갈음할 수 있게 한다 — 그래서 JWT 라이브러리 없이 iss·aud·exp·nonce 와
이메일·도메인만 검사한다. 발급자 주소가 https 가 아니면(시험용) 루프백일 때만 허용한다.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import secrets
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

from ..common import cache_epoch, config, db, store, table_cache
from ..common.names import person_name
from ..common.i18n import tr
from . import tls

USERS_FILE = config.users_file()
COOKIE = "aas_session"
LOGIN_WINDOW, LOGIN_MAX = 300, 5          # IP 당 5분에 5번까지
PENDING_TTL = 600
# 사용 중 로그인 유지(OMAI-1112): 조작 신호(touch)가 올 때만 유휴 마감을 민다. 그때 Keycloak 토큰도 갱신해 Keycloak 세션을 함께 잇는다.
REFRESH_EVERY = 240                       # 갱신 간격(초). 여러 탭이 몰려도 이보다 자주 하지 않는다
REFRESH_LEASE = 30                        # 갱신을 맡은 파드·스레드의 임대 시간(초)
SESSION_MEMO = 30.0                       # 세션 줄을 기억하는 시간(초). 로그인한 요청마다 읽었다(스펙 2026-10-26-002 R11)
SESSION_MEMO_MAX = 4096
AUTH_EPOCH = "auth"                       # 세션을 끝내거나 관리자 여부를 바꾸면 다른 서버의 기억도 버린다(cache_epoch)

_sessions: dict[str, tuple[float, int, object]] = {}   # 세션 해시 → (읽은 시각, 세대, 줄)
_sessions_lock = threading.Lock()
_sessions_gen = [0]


def _memo_on() -> bool:
    """PostgreSQL 이고 서버 사이 듣기 연결이 붙어 있을 때만 기억한다 — 다른 서버의 로그아웃을 알림으로 받아야 한다."""
    return db.backend() == "postgres" and table_cache.listening()


def _forget(h: str | None = None, others: bool = False) -> None:
    """이 서버의 세션 기억을 버린다(h 가 없으면 모두). others 면 다른 서버에도 알린다(M3)."""
    with _sessions_lock:
        _sessions_gen[0] += 1
        if h is None:
            _sessions.clear()
        else:
            _sessions.pop(h, None)
    if others:
        cache_epoch.bump(AUTH_EPOCH)


# ---- refresh_token 암호화. 키를 쿠키 토큰(서버에 저장하지 않음)과 클라이언트 비밀에서 만들어, DB 만 새서는 풀 수 없다.
# 표준 라이브러리만 쓴다: HMAC-SHA256 카운터 키스트림 XOR + HMAC 태그(encrypt-then-MAC).
def _seal_keys(secret: str, token: str) -> tuple[bytes, bytes]:
    root = hmac.new(secret.encode(), b"aas-rt-v1:" + token.encode(), hashlib.sha256).digest()
    return hmac.new(root, b"enc", hashlib.sha256).digest(), hmac.new(root, b"mac", hashlib.sha256).digest()


def _keystream(key: bytes, nonce: bytes, n: int) -> bytes:
    return b"".join(hmac.new(key, nonce + i.to_bytes(4, "big"), hashlib.sha256).digest() for i in range((n + 31) // 32))[:n]


def seal(plain: str, secret: str, token: str) -> str:
    if not plain:
        return ""
    enc, mac = _seal_keys(secret, token)
    nonce, data = secrets.token_bytes(16), plain.encode()
    ct = bytes(a ^ b for a, b in zip(data, _keystream(enc, nonce, len(data))))
    return base64.urlsafe_b64encode(nonce + ct + hmac.new(mac, nonce + ct, hashlib.sha256).digest()).decode()


def unseal(sealed: str, secret: str, token: str) -> str:
    """풀지 못하면(다른 쿠키·변조·빈 값) 빈 문자열."""
    try:
        raw = base64.urlsafe_b64decode(sealed)
        if len(raw) < 48:
            return ""
        nonce, ct, tag = raw[:16], raw[16:-32], raw[-32:]
        enc, mac = _seal_keys(secret, token)
        if not hmac.compare_digest(tag, hmac.new(mac, nonce + ct, hashlib.sha256).digest()):
            return ""
        return bytes(a ^ b for a, b in zip(ct, _keystream(enc, nonce, len(ct)))).decode()
    except Exception:
        return ""


class AuthError(Exception):
    pass


# ---- 자체 계정(아이디·비밀번호). IP 로 접속할 때 쓴다 — 구글 OAuth 는 localhost 가 아니면 https 도메인만 받는다.
def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    dk = hashlib.scrypt(password.encode(), salt=salt, n=2 ** 14, r=8, p=1, dklen=32)
    return "scrypt$16384$8$1$" + base64.b64encode(salt).decode() + "$" + base64.b64encode(dk).decode()


def verify_password(password: str, encoded: str) -> bool:
    try:
        scheme, n, r, p, salt, dk = encoded.split("$")
        if scheme != "scrypt":
            return False
        want = base64.b64decode(dk)
        got = hashlib.scrypt(password.encode(), salt=base64.b64decode(salt), n=int(n), r=int(r), p=int(p), dklen=len(want))
        return secrets.compare_digest(got, want)
    except Exception:
        return False


_DUMMY_HASH = hash_password(secrets.token_urlsafe(12))     # 없는 계정도 같은 시간이 걸리게


def load_users(path: Path | None = None) -> dict[str, str]:
    path = path or USERS_FILE
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        return {str(u["email"]).lower(): str(u["password_hash"]) for u in data.get("users", [])}
    except Exception:
        return {}


def save_user(email: str, password: str | None, path: Path | None = None) -> None:
    """비밀번호를 정하거나(해시만 저장) password=None 이면 계정을 지운다."""
    path = path or USERS_FILE
    users = load_users(path)
    if password is None:
        users.pop(email.lower(), None)
    else:
        users[email.lower()] = hash_password(password)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps({"users": [{"email": e, "password_hash": h} for e, h in sorted(users.items())]},
                              ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    tmp.chmod(0o600)
    os.replace(tmp, path)


def bootstrap_admin(path: Path | None = None) -> None:
    """빠른 시작(docker compose)의 첫 관리자. 계정이 하나도 없고 AAS_ADMIN_EMAIL·AAS_ADMIN_PASSWORD 가 있을 때만 만든다
    (스펙 2026-10-21-015 단계 2, 리뷰 D2·R9). 계정이 이미 있으면 .env 값을 쓰지 않는다 — 다시 시작할 때 바꾼 비밀번호를 덮지 않는다.
    serve 가 로그인 검사 전에 부른다. 비밀번호는 로그에 남기지 않는다."""
    email, password = _env("AAS_ADMIN_EMAIL").strip().lower(), _env("AAS_ADMIN_PASSWORD")
    if not email and not password:
        return
    path = path or USERS_FILE
    if load_users(path):
        return
    if "@" not in email:
        print("첫 관리자를 만들지 않았습니다: AAS_ADMIN_EMAIL 이 이메일 모양이 아닙니다", flush=True)  # i18n-ignore: 운영자가 읽는 시작 로그
        return
    if len(password) < 10:
        print("첫 관리자를 만들지 않았습니다: AAS_ADMIN_PASSWORD 는 10자 이상이어야 합니다", flush=True)  # i18n-ignore: 운영자가 읽는 시작 로그
        return
    save_user(email, password, path)
    print(f"첫 관리자 계정을 만들었습니다: {email}", flush=True)  # i18n-ignore: 운영자가 읽는 시작 로그


def _env(key: str, default: str = "") -> str:
    return config.get(key, default)


def _client_from_file() -> tuple[str, str]:
    """구글이 내려 주는 클라이언트 JSON(installed 또는 web)에서 id·secret 을 읽는다."""
    path = _env("AAS_OIDC_CLIENT_FILE")
    if not path:
        return "", ""
    try:
        data = json.loads(Path(os.path.expanduser(path)).read_text(encoding="utf-8"))
        body = data.get("web") or data.get("installed") or {}
        return str(body.get("client_id") or ""), str(body.get("client_secret") or "")
    except Exception:
        return "", ""


def settings() -> dict:
    file_id, file_secret = _client_from_file()
    k8s_mode = bool(_env("AAS_K8S_NAMESPACE"))
    return {"issuer": _env("AAS_OIDC_ISSUER").rstrip("/"),
            "discovery_url": _env("AAS_OIDC_DISCOVERY_URL").rstrip("/"),
            "client_id": _env("AAS_OIDC_CLIENT_ID") or file_id,
            "client_secret": _env("AAS_OIDC_CLIENT_SECRET") or file_secret,
            "domain": _env("AAS_ALLOWED_DOMAIN").lower().lstrip("@"),
            "users_group": _env("AAS_OIDC_USERS_GROUP", "aas-users").strip().strip("/"),
            "admin_role": _env("AAS_OIDC_ADMIN_ROLE", "aas-admin").strip(),
            "groups_claim": _env("AAS_OIDC_GROUPS_CLAIM", "groups").strip() or "groups",
            "password_login": _env("AAS_PASSWORD_LOGIN", "0" if k8s_mode else "1") not in ("0", "false", "no", ""),
            "public_url": _env("AAS_PUBLIC_URL", "http://localhost:17900").rstrip("/"),
            "public_urls": [u.strip().rstrip("/") for u in _env("AAS_PUBLIC_URLS").split(",") if u.strip()],
            "hours": float(_env("AAS_SESSION_HOURS", "24")),                 # 최대(조작해도 이 시간이 지나면 다시 로그인)
            "idle_minutes": float(_env("AAS_SESSION_IDLE_MINUTES", "120"))}  # 조작 신호가 이만큼 없으면 끝난다(OMAI-1112)


def has_admin_session(email: str) -> bool:
    """이 사람의 만료되지 않은 세션 중에 관리자 표시(토큰의 역할로 정해진 값)가 있는가. 로그인한 사람이 없는 주기 점검이 쓴다.
    유휴 마감이 아니라 최대(max_until)로 본다 — 관리자가 2시간 자리를 비웠다고 그 사람의 칸반 카드가 보류로 가면 안 된다(OMAI-1112)."""
    now = time.time()
    try:
        with store.connect() as conn:
            row = conn.execute("SELECT 1 FROM auth_sessions WHERE email=? AND admin=1 AND revoked=0 AND (max_until>? OR (max_until<=0 AND expires>?)) LIMIT 1",
                               (email.lower(), now, now)).fetchone()
    except Exception:
        return False
    return row is not None


class Auth:
    def __init__(self, cfg: dict | None = None):
        self.cfg = cfg or settings()
        self._tries: dict[str, list[float]] = {}
        self._lock = threading.Lock()
        self._discovery: dict | None = None
        self.on_login = None                    # 로그인에 성공한 신원(dict)을 받는 함수. 첫 로그인 등록에 쓴다(서버가 정한다)
        self.on_change = None                   # 세션을 지웠거나 관리자 여부가 바뀐 이메일을 받는 함수. 웹소켓을 바로 다시 검사한다(서버가 정한다)
        with store.connect() as conn:
            # 로그인 진행 상태(state → nonce·PKCE verifier·돌아갈 곳). 서버 메모리가 아니라 DB 라 서버가 둘이어도 콜백을 어느 서버가
            # 받든 된다 — 로그인 전 서버 고정(쿠키)이 필요 없다(스펙 2026-11-05-005 §5-1 U7, 2026-11-05 메모리에서 옮김).
            ddl = "CREATE TABLE IF NOT EXISTS auth_pending (state TEXT PRIMARY KEY, data TEXT NOT NULL, exp REAL NOT NULL)"
            conn.execute(db.to_pg(ddl) if db.is_pg(conn) else ddl)
            conn.execute("CREATE TABLE IF NOT EXISTS auth_sessions (hash TEXT PRIMARY KEY, email TEXT NOT NULL, "
                         "name TEXT, created REAL NOT NULL, expires REAL NOT NULL)")
            cols = db.columns(conn, "auth_sessions")
            for col, ddl in (("sub", "TEXT NOT NULL DEFAULT ''"), ("admin", "INTEGER NOT NULL DEFAULT 0"),
                             ("max_until", "REAL NOT NULL DEFAULT 0"), ("rt", "TEXT NOT NULL DEFAULT ''"),
                             ("refreshed", "REAL NOT NULL DEFAULT 0"), ("refresh_lock", "REAL NOT NULL DEFAULT 0"),
                             ("revoked", "REAL NOT NULL DEFAULT 0")):
                if col not in cols:             # 옛 DB: 열을 더한다. PostgreSQL 의 REAL 은 4바이트라 에포크 초가 1분 가까이 뭉개진다 — to_pg 로 바꾼다
                    conn.execute(f"ALTER TABLE auth_sessions ADD COLUMN {col} " + (db.to_pg(ddl) if db.is_pg(conn) else ddl))
            conn.execute("CREATE INDEX IF NOT EXISTS auth_sessions_email ON auth_sessions (email)")   # 로그인·끊기·관리자 확인이 email 로 찾는다(스펙 2026-10-24-006 R1)
            if "max_until" not in cols:         # 이미 있던 세션은 옛 끝(로그인 + 12시간)을 그대로 최대로 둔다
                conn.execute("UPDATE auth_sessions SET max_until=expires WHERE max_until=0")
            if db.is_pg(conn):                  # 2026-10-13 빌드 31 이 REAL(4바이트)로 만든 열을 고친다
                for col in ("max_until", "refreshed", "refresh_lock", "revoked"):
                    t = conn.execute("SELECT data_type FROM information_schema.columns WHERE table_name='auth_sessions' "
                                     "AND column_name=? AND table_schema=current_schema()", (col,)).fetchone()
                    if t and str(t["data_type"]).lower() == "real":
                        conn.execute(f"ALTER TABLE auth_sessions ALTER COLUMN {col} TYPE DOUBLE PRECISION")

    def _idle(self) -> float:
        return float(self.cfg.get("idle_minutes", 120)) * 60       # 시험이 넘기는 cfg 에는 이 키가 없을 수 있다

    def _max_of(self, row) -> float:
        """최대 시각. 롤링 재시작 중 옛 파드가 넣은 행은 max_until 이 0 이다 — 로그인 + hours 로 본다(즉시 로그아웃 방지)."""
        m = float(row["max_until"] or 0)
        return m if m > 0 else float(row["created"]) + float(self.cfg["hours"]) * 3600

    @property
    def oidc_enabled(self) -> bool:
        return bool(self.cfg["issuer"] and self.cfg["client_id"] and self.cfg["client_secret"])

    @property
    def is_google(self) -> bool:
        return (urllib.parse.urlsplit(self.cfg["issuer"]).hostname or "") == "accounts.google.com"

    @property
    def password_enabled(self) -> bool:
        return bool(self.cfg.get("password_login", True) and load_users(self.cfg.get("users_file")))

    @property
    def enabled(self) -> bool:
        return self.oidc_enabled or self.password_enabled

    def password_login(self, email: str, password: str, ip: str = "") -> str:
        """맞으면 세션 토큰. 틀리면 AuthError(계정이 없는지 비밀번호가 틀렸는지는 구분해 알려 주지 않는다)."""
        now = time.time()
        with self._lock:
            tries = [t for t in self._tries.get(ip, []) if now - t < LOGIN_WINDOW]
            if len(tries) >= LOGIN_MAX:
                self._tries[ip] = tries
                raise AuthError(tr("로그인 시도가 너무 많습니다. 5분 뒤에 다시 하세요.", "Too many login attempts. Try again in 5 minutes."))
            tries.append(now)
            self._tries[ip] = tries
        users = load_users(self.cfg.get("users_file"))
        email = (email or "").strip().lower()
        ok = verify_password(password or "", users.get(email) or _DUMMY_HASH) and email in users
        if not ok:
            store.log_usage("login_failed", ip)
            raise AuthError(tr("이메일 또는 비밀번호가 맞지 않습니다.", "Wrong email or password."))
        with self._lock:
            self._tries.pop(ip, None)
        return self._new_session(email, "")

    def password_attempt(self, email: str) -> None:
        """본인 비밀번호 변경의 현재 비밀번호 확인 한 번을 센다. 이메일마다 LOGIN_WINDOW 안에 LOGIN_MAX 번까지만 받는다(스펙 2026-10-14-017 S7).
        서버 복제본마다 센다 — 실제 방어선은 Keycloak 의 brute force 보호다. 성공하면 password_attempt_ok 로 비운다."""
        now, key = time.time(), "pw:" + (email or "").lower()
        with self._lock:
            tries = [t for t in self._tries.get(key, []) if now - t < LOGIN_WINDOW]
            if len(tries) >= LOGIN_MAX:
                self._tries[key] = tries
                raise AuthError(tr("시도가 너무 많습니다. 5분 뒤에 다시 하세요.", "Too many attempts. Try again in 5 minutes."))
            tries.append(now)
            self._tries[key] = tries

    def password_attempt_ok(self, email: str) -> None:
        with self._lock:
            self._tries.pop("pw:" + (email or "").lower(), None)

    def end_other_sessions(self, email: str, cookie_header: str | None) -> int:
        """같은 사람의 다른 로그인 세션을 끝낸다(지금 쿠키의 세션은 둔다). 끝낸 수를 돌려준다. revoke 와 같은 방식이다."""
        token = _cookie(cookie_header, COOKIE)
        mine = hashlib.sha256(token.encode()).hexdigest() if token else ""
        now = time.time()
        with store.connect() as conn:
            n = conn.execute("UPDATE auth_sessions SET expires=?, revoked=? WHERE email=? AND revoked=0 AND expires>=? AND hash<>?",
                             (now - 1, now, email.lower(), now, mine)).rowcount
        _forget(others=True)
        return n

    def _new_session(self, email: str, name: str, sub: str = "", admin: bool = False, refresh_token: str = "") -> str:
        token = secrets.token_urlsafe(32)
        now = time.time()
        max_until = now + self.cfg["hours"] * 3600
        rt = seal(refresh_token, self.cfg.get("client_secret") or "", token) if refresh_token and not self._offline(refresh_token) else ""
        with store.connect() as conn:
            # 유휴로 끝난 행은 최대까지 남긴다 — lifecycle.known_sub 가 sub 를 읽는다
            conn.execute("DELETE FROM auth_sessions WHERE (max_until>0 AND max_until<?) OR (max_until<=0 AND expires<?)", (now, now))
            conn.execute("INSERT INTO auth_sessions (hash, email, name, created, expires, sub, admin, max_until, rt, refreshed) "
                         "VALUES (?,?,?,?,?,?,?,?,?,?)",
                         (hashlib.sha256(token.encode()).hexdigest(), email.lower(), name, now,
                          min(now + self._idle(), max_until), sub, 1 if admin else 0, max_until, rt, now))
        store.log_usage("login", email.lower())
        return token

    @staticmethod
    def _offline(refresh_token: str) -> bool:
        """오프라인 토큰은 SSO 시간에 묶이지 않는다 — 저장하지 않는다."""
        try:
            payload = refresh_token.split(".")[1]
            return json.loads(base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4))).get("typ") == "Offline"
        except Exception:
            return False

    @property
    def secure_cookie(self) -> bool:
        return self.cfg["public_url"].startswith("https://")

    def base_for(self, host: str, tls: bool) -> str | None:
        """요청이 들어온 주소(Host, https 여부)가 등록된 접속 주소면 그 주소를 돌려준다.
        Host 헤더를 그대로 리디렉션에 쓰지 않으려고 목록과 대조한다."""
        want = (host or "").strip().lower()
        for url in [self.cfg["public_url"], *self.cfg.get("public_urls", [])]:
            u = urllib.parse.urlsplit(url)
            if u.netloc.lower() == want and u.scheme == ("https" if tls else "http"):
                return url
        return None

    def _check_issuer_transport(self) -> None:
        """발견 주소(없으면 발급자 주소)는 https 여야 한다. 루프백과 클러스터 안 서비스 이름(.svc)은 http 도 받는다."""
        u = urllib.parse.urlsplit(self.cfg.get("discovery_url") or self.cfg["issuer"])
        host = u.hostname or ""
        in_cluster = bool(self.cfg.get("discovery_url")) and (host.endswith(".svc") or ".svc." in host)
        if u.scheme != "https" and host not in ("127.0.0.1", "localhost", "::1") and not in_cluster:
            raise AuthError(tr("OIDC 발급자 주소는 https 여야 합니다", "The OIDC issuer URL must use https"))

    def discovery(self) -> dict:
        if self._discovery is None:
            self._check_issuer_transport()
            base = self.cfg.get("discovery_url") or self.cfg["issuer"]
            try:
                with tls.urlopen(base + "/.well-known/openid-configuration", timeout=10) as resp:
                    self._discovery = json.loads(resp.read())
            except Exception as exc:
                raise AuthError(tr(f"로그인 공급자 설정을 읽지 못했습니다: {type(exc).__name__}", f"Cannot read the login provider settings: {type(exc).__name__}")) from None
        return self._discovery

    def begin(self, next_path: str = "/", base: str | None = None, popup: bool = False) -> str:
        """base: 돌아올 접속 주소(base_for 가 돌려준 값). 없으면 기본 주소. popup: 로그인 창을 팝업으로 열었다(끝나면 팝업을 닫는 화면을 준다)."""
        d = self.discovery()
        base = base or self.cfg["public_url"]
        state, nonce = secrets.token_urlsafe(24), secrets.token_urlsafe(24)
        verifier = secrets.token_urlsafe(48)       # RFC 7636: 43~128자. 짧으면 Keycloak 이 invalid_code_verifier 로 거절한다
        if not next_path.startswith("/") or next_path.startswith("//"):
            next_path = "/"
        now = time.time()
        pend = {"nonce": nonce, "verifier": verifier, "next": next_path, "base": base, "popup": bool(popup)}
        with store.connect() as conn:
            conn.execute("DELETE FROM auth_pending WHERE exp < ?", (now,))
            conn.execute("INSERT INTO auth_pending (state, data, exp) VALUES (?,?,?)", (state, json.dumps(pend), now + PENDING_TTL))
        challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
        q = {"response_type": "code", "client_id": self.cfg["client_id"],
             "redirect_uri": base + "/auth/callback", "scope": "openid email profile",
             "state": state, "nonce": nonce, "code_challenge": challenge, "code_challenge_method": "S256"}
        if self.is_google:
            q["prompt"] = "select_account"
            if self.cfg["domain"]:
                q["hd"] = self.cfg["domain"]      # 구글: 계정 선택 화면을 이 도메인으로 좁힌다(검증은 아래에서 따로)
        return d["authorization_endpoint"] + "?" + urllib.parse.urlencode(q)

    def _take_pending(self, state: str) -> dict | None:
        """로그인 진행 상태를 한 번만 꺼낸다(지우면서 읽는다 — 같은 state 를 두 번 쓰지 못한다). 없거나 만료면 None."""
        if not state:
            return None
        with store.connect() as conn:
            row = conn.execute("DELETE FROM auth_pending WHERE state=? RETURNING data, exp", (state,)).fetchone()
        if not row or row[1] < time.time():
            return None
        return json.loads(row[0])

    def finish(self, code: str, state: str, with_popup: bool = False):
        """(세션 토큰, 돌아갈 경로). with_popup 이면 (세션 토큰, 돌아갈 경로, 팝업 여부). 실패하면 AuthError."""
        pend = self._take_pending(state)
        if not pend:
            raise AuthError(tr("로그인 요청이 만료됐거나 알 수 없는 요청입니다. 다시 시도하세요.", "The login request expired or is unknown. Try again."))
        d = self.discovery()
        body = urllib.parse.urlencode({
            "grant_type": "authorization_code", "code": code,
            "redirect_uri": pend["base"] + "/auth/callback",
            "client_id": self.cfg["client_id"], "client_secret": self.cfg["client_secret"],
            "code_verifier": pend["verifier"]}).encode()
        try:
            with tls.urlopen(urllib.request.Request(d["token_endpoint"], data=body), timeout=15) as resp:
                tokens = json.loads(resp.read())
        except urllib.error.HTTPError as exc:
            raise AuthError(tr(f"로그인 공급자가 코드를 거부했습니다 (HTTP {exc.code})", f"The login provider rejected the code (HTTP {exc.code})")) from None
        except Exception as exc:
            raise AuthError(tr(f"로그인 공급자에 연결할 수 없습니다: {type(exc).__name__}", f"Cannot reach the login provider: {type(exc).__name__}")) from None
        claims = self._claims(tokens.get("id_token") or "")
        self._merge_access_claims(claims, tokens.get("access_token") or "")
        who = self._validate(claims, pend["nonce"])
        self._remember_department(who["email"], claims)
        if self.on_login:
            try:
                self.on_login(who)
            except Exception as exc:            # 등록(첫 Hermes 만들기)이 실패해도 로그인은 막지 않는다. 다음 로그인에 다시 한다
                # i18n-ignore: 서버 로그
                print(f"로그인 후처리 실패 ({type(exc).__name__}): {exc}", flush=True)
        token = self._new_session(who["email"], who["name"], who["sub"], who["admin"], str(tokens.get("refresh_token") or ""))
        return (token, pend["next"], bool(pend.get("popup"))) if with_popup else (token, pend["next"])

    def _merge_access_claims(self, claims: dict, access_token: str) -> None:
        """Keycloak 은 기본 설정에서 realm_access·resource_access 를 액세스 토큰에만 싣는다.
        토큰 엔드포인트가 같은 응답으로 준 액세스 토큰에서 역할·그룹 claim 만 빌려 온다(신원 claim 은 id_token 만 믿는다)."""
        if not access_token:
            return
        try:
            extra = self._claims(access_token)
        except AuthError:
            return                                   # JWT 가 아닌 불투명 토큰이면 id_token 의 claim 만 쓴다
        for key in ("realm_access", "resource_access", self.cfg.get("groups_claim") or "groups"):
            if key not in claims and key in extra:
                claims[key] = extra[key]

    @staticmethod
    def _claims(id_token: str) -> dict:
        try:
            payload = id_token.split(".")[1]
            return json.loads(base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4)))
        except Exception:
            raise AuthError(tr("로그인 응답을 해석하지 못했습니다", "Cannot parse the login response")) from None

    def _roles(self, c: dict) -> set[str]:
        out = set(((c.get("realm_access") or {}).get("roles")) or [])
        for body in (c.get("resource_access") or {}).values():
            out |= set((body or {}).get("roles") or [])
        return {str(r) for r in out}

    def _groups(self, c: dict) -> set[str]:
        raw = c.get(self.cfg.get("groups_claim") or "groups") or []
        raw = [raw] if isinstance(raw, str) else raw
        return {str(g).strip().strip("/") for g in raw}      # Keycloak 은 그룹 경로를 /aas-users 처럼 줄 수 있다

    def _validate(self, c: dict, nonce: str) -> dict:
        """토큰 claim 을 검사하고 신원 {sub, email, name, admin} 을 돌려준다. 그룹·역할은 이때마다 새로 읽는다."""
        aud = c.get("aud")
        if c.get("iss") not in (self.cfg["issuer"], self.cfg["issuer"].replace("https://", "")):
            raise AuthError(tr("발급자가 다릅니다", "Issuer mismatch"))
        if not (aud == self.cfg["client_id"] or (isinstance(aud, list) and self.cfg["client_id"] in aud)):
            raise AuthError(tr("이 앱을 위한 로그인이 아닙니다", "This login is not for this app"))
        if float(c.get("exp") or 0) < time.time():
            raise AuthError(tr("로그인 응답이 만료됐습니다", "The login response expired"))
        if not secrets.compare_digest(str(c.get("nonce") or ""), nonce):
            raise AuthError(tr("로그인 요청과 응답이 맞지 않습니다", "The login request and response do not match"))
        email = str(c.get("email") or "").lower()
        if not email or c.get("email_verified") is not True:
            raise AuthError(tr("확인된 이메일이 없는 계정입니다", "This account has no verified email"))
        sub = str(c.get("sub") or "")
        if not sub:
            raise AuthError(tr("계정 식별자(sub)가 없는 응답입니다", "The response has no account identifier (sub)"))
        dom = self.cfg["domain"]
        if dom and (not email.endswith("@" + dom) or ("hd" in c and str(c["hd"]).lower() != dom)):
            raise AuthError(tr(f"{dom} 계정만 쓸 수 있습니다", f"Only {dom} accounts are allowed"))
        allowed, admin = self._access(c)
        if not allowed:
            group = self.cfg.get("users_group") or ""
            raise AuthError(tr(f"{group} 그룹에 속한 계정만 쓸 수 있습니다. 관리자에게 그룹 추가를 요청하세요.", f"Only members of the {group} group are allowed. Ask an admin to add you to the group."))
        # 토큰의 name 은 「이름 성」 순이라 사용자 목록(성+이름)과 달랐다. 성·이름이 있으면 같은 규칙으로 만든다(2026-10-18)
        name = person_name(str(c.get("given_name") or ""), str(c.get("family_name") or "")) or str(c.get("name") or "")
        return {"sub": sub, "email": email, "name": name, "admin": admin,
                "department": str(c.get("department") or "")}

    def _access(self, c: dict) -> tuple[bool, bool]:
        """(들어올 수 있는가, 관리자인가). 로그인과 토큰 갱신이 같은 규칙을 쓴다."""
        role = self.cfg.get("admin_role") or ""
        admin = bool(role and role in self._roles(c))
        group = self.cfg.get("users_group") or ""
        return (admin or not group or group in self._groups(c)), admin

    _COLS = "email, name, sub, admin, created, expires, max_until, rt, refreshed"

    def _row(self, token: str, fresh: bool = False):
        """세션 줄. 기억한 줄을 SESSION_MEMO 초 쓴다(R11). 세션을 끝내거나 관리자 여부를 바꾸면 _forget 이 다른 서버에도 알린다.
        fresh 면 DB 를 읽는다: 줄을 고치는 touch·로그아웃과, 기억한 줄로 끝나 보일 때(다른 서버의 touch 가 마감을 밀었을 수 있다, F3).
        마감 연장(touch)은 알리지 않는다 — 사용자마다 5분에 한 번이라 알리면 기억이 거의 맞지 않는다."""
        h = hashlib.sha256(token.encode()).hexdigest()

        def read():
            with store.connect() as conn:
                return conn.execute(f"SELECT {self._COLS} FROM auth_sessions WHERE hash=?", (h,)).fetchone()
        if fresh or not _memo_on():
            return read()
        if cache_epoch.changed(AUTH_EPOCH):                # 다른 서버가 세션을 끝냈다
            _forget()
        now = time.monotonic()
        with _sessions_lock:
            hit = _sessions.get(h)
            gen = _sessions_gen[0]
        if hit is not None and hit[1] == gen and 0 <= now - hit[0] < SESSION_MEMO:
            return hit[2]
        row = read()
        if row is not None:                                # 없는 세션은 기억하지 않는다(아무 쿠키로 기억을 채우지 못하게)
            with _sessions_lock:
                if _sessions_gen[0] == gen:                # 읽는 사이 버렸으면 남기지 않는다
                    if len(_sessions) >= SESSION_MEMO_MAX:
                        for k in sorted(_sessions, key=lambda k: _sessions[k][0])[:len(_sessions) // 2]:
                            del _sessions[k]
                    _sessions[h] = (now, gen, row)
        return row

    def _open(self, row, now: float) -> bool:
        return row["expires"] >= now and self._max_of(row) >= now

    def _alive(self, token: str, row, now: float) -> bool:
        """유휴 마감·최대 안이면 참. 처음 끝난 것을 보면 Keycloak 세션도 끝낸다(조작 없이 자동 재로그인되지 않게)."""
        if self._open(row, now):
            return True
        if row["rt"]:
            with store.connect() as conn:          # 한 번만: 먼저 비운 쪽이 끝낸다
                taken = conn.execute("UPDATE auth_sessions SET rt='' WHERE hash=? AND rt=?",
                                     (hashlib.sha256(token.encode()).hexdigest(), row["rt"])).rowcount
            _forget(hashlib.sha256(token.encode()).hexdigest())
            rt = unseal(row["rt"], self.cfg.get("client_secret") or "", token)
            if taken and rt:
                threading.Thread(target=self._end_keycloak, args=(rt,), daemon=True, name="keycloak-end").start()
        return False

    def user(self, cookie_header: str | None) -> dict | None:
        """요청마다 부른다. 세션을 연장하지 않는다 — 연장은 사용자가 조작할 때 오는 touch 만 한다(OMAI-1112)."""
        token = _cookie(cookie_header, COOKIE)
        if not token:
            return None
        row = self._row(token)
        now = time.time()
        if row and not self._open(row, now):
            row = self._row(token, fresh=True)
        if not row or not self._alive(token, row, now):
            return None
        return {"email": row["email"], "name": row["name"], "sub": row["sub"], "admin": bool(row["admin"])}

    def touch(self, cookie_header: str | None) -> dict | None:
        """사용자가 조작했다(화면이 5분에 한 번까지 보낸다). 유휴 마감을 최대 안에서 밀고, 때가 되면 Keycloak 토큰을 갱신한다.
        세션이 없거나 끝났으면 None."""
        token = _cookie(cookie_header, COOKIE)
        row = self._row(token, fresh=True) if token else None
        now = time.time()
        if not row or not self._alive(token, row, now):
            return None
        h = hashlib.sha256(token.encode()).hexdigest()
        max_until = self._max_of(row)
        expires = min(now + self._idle(), max_until)
        with store.connect() as conn:
            conn.execute("UPDATE auth_sessions SET expires=?, max_until=? WHERE hash=?", (expires, max_until, h))
        _forget(h)
        if row["rt"] and now - float(row["refreshed"] or 0) >= REFRESH_EVERY and not self._refresh(token, h, row):
            return None
        return {"idle_until": expires, "max_until": max_until}

    def _refresh(self, token: str, h: str, row) -> bool:
        """Keycloak 토큰을 갱신한다. 세션을 끝냈으면 False. 다른 파드·탭이 갱신 중이면 건너뛴다."""
        now = time.time()
        with store.connect() as conn:
            if conn.execute("UPDATE auth_sessions SET refresh_lock=? WHERE hash=? AND refresh_lock<?",
                            (now + REFRESH_LEASE, h, now)).rowcount != 1:
                return True
        secret = self.cfg.get("client_secret") or ""
        ended = False
        try:
            rt = unseal(row["rt"], secret, token)
            if not rt:
                return True
            d = self.discovery()
            body = urllib.parse.urlencode({"grant_type": "refresh_token", "refresh_token": rt,
                                           "client_id": self.cfg["client_id"], "client_secret": secret}).encode()
            try:
                with tls.urlopen(urllib.request.Request(d["token_endpoint"], data=body), timeout=10) as resp:
                    tokens = json.loads(resp.read())
            except urllib.error.HTTPError as exc:
                if exc.code in (400, 401):                 # invalid_grant: Keycloak 세션 끝·계정 정지·관리자 로그아웃
                    ended = True
                    store.log_usage("session_end", f"{row['email']} refresh_rejected")
                return not ended
            c = self._claims(tokens.get("id_token") or "")
            self._merge_access_claims(c, tokens.get("access_token") or "")
            aud = c.get("aud")
            same = (c.get("iss") in (self.cfg["issuer"], self.cfg["issuer"].replace("https://", ""))
                    and (aud == self.cfg["client_id"] or (isinstance(aud, list) and self.cfg["client_id"] in aud))
                    and (not row["sub"] or str(c.get("sub") or "") == row["sub"]))
            allowed, admin = self._access(c)
            if not (same and allowed):
                ended = True
                store.log_usage("session_end", f"{row['email']} refresh_denied")
                return False
            self._remember_department(row["email"], c)          # Keycloak 에서 부서를 바꾸면 다음 갱신 때 반영된다
            new_rt = str(tokens.get("refresh_token") or rt)
            # 이름도 로그인과 같은 규칙(성+이름)으로 다시 쓴다 — 이미 로그인한 세션이 옛 「이름 성」을 계속 들고 다니지 않게(2026-10-18)
            name = person_name(str(c.get("given_name") or ""), str(c.get("family_name") or "")) or str(c.get("name") or "")
            with store.connect() as conn:
                conn.execute("UPDATE auth_sessions SET rt=?, refreshed=?, admin=?, name=CASE WHEN ?<>'' THEN ? ELSE name END WHERE hash=?",
                             (seal(new_rt, secret, token) if not self._offline(new_rt) else "", time.time(), 1 if admin else 0, name, name, h))
            _forget(h, others=admin != bool(row["admin"]))    # 관리자 여부가 바뀌면 다른 서버도 버린다(M3)
            if admin != bool(row["admin"]):
                self._changed(row["email"])
            return True
        except (AuthError, OSError, ValueError):
            return True                                    # Keycloak 이 잠시 안 되면 세션은 둔다. 다음 touch 에 다시 한다
        finally:
            with store.connect() as conn:
                if ended:
                    conn.execute("DELETE FROM auth_sessions WHERE hash=?", (h,))
                else:
                    conn.execute("UPDATE auth_sessions SET refresh_lock=0 WHERE hash=?", (h,))
            if ended:
                _forget(h, others=True)
            if ended:
                self._changed(row["email"])

    @staticmethod
    def _remember_department(email: str, claims: dict) -> None:
        """Keycloak 사용자 속성 department(claim) 를 적는다 — 오피스 기본 팀으로 쓴다(계획 2026-10-13-008 §2-3).
        claim 이 없으면 빈 부서로 적는다(Keycloak 은 빈 속성을 claim 에 넣지 않는다). 실패해도 로그인은 막지 않는다."""
        try:
            from ..common import settings
            settings.set_department(email, claims.get("department"))
        except Exception as exc:
            print(f"부서를 적지 못했습니다 ({type(exc).__name__})", flush=True)   # i18n-ignore: 서버 로그

    def _changed(self, email: str) -> None:
        if self.on_change:
            try:
                self.on_change(email)
            except Exception:
                pass

    def _end_keycloak(self, refresh_token: str) -> None:
        """Keycloak 세션을 끝낸다(end-session). 실패해도 AAS 세션 정리는 이미 끝났다 — Keycloak 은 자기 유휴 시간에 끝낸다."""
        try:
            d = self.discovery()
            # 서버에서 Keycloak 으로 직접 보내는 요청이라 토큰 엔드포인트와 같은 내부 주소를 쓴다. discovery 의 end_session_endpoint 는
            # 브라우저용 공개 주소(KC_HOSTNAME)라 서버 파드가 이름을 풀지 못한다(OKE 실측, OMAI-1112).
            token_ep = str(d.get("token_endpoint") or "")
            url = token_ep[:-len("/token")] + "/logout" if token_ep.endswith("/token") else d.get("end_session_endpoint")
            if not url:
                return
            body = urllib.parse.urlencode({"client_id": self.cfg["client_id"], "client_secret": self.cfg.get("client_secret") or "",
                                           "refresh_token": refresh_token}).encode()
            with tls.urlopen(urllib.request.Request(url, data=body), timeout=5):
                pass
        except Exception:
            pass

    def revoke(self, email: str) -> int:
        """관리자가 이 사람을 로그아웃시킨다. 서버에는 그 사람의 쿠키가 없어 refresh_token 을 지금 풀 수 없으므로 행을 지우지 않고
        '끝남'으로 둔다. 그 브라우저가 다시 오면(열린 탭은 웹소켓 확인 60초 안) _alive 가 그 쿠키로 풀어 Keycloak 세션을 먼저 끝낸다.
        행은 max_until 까지 남는다. 끝낸 세션 수를 돌려준다(OMAI-1112)."""
        now = time.time()
        with store.connect() as conn:
            n = conn.execute("UPDATE auth_sessions SET expires=?, revoked=? WHERE email=? AND revoked=0 AND expires>=?",
                             (now - 1, now, email.lower(), now)).rowcount
        _forget(others=True)
        return n

    def logout(self, cookie_header: str | None) -> None:
        token = _cookie(cookie_header, COOKIE)
        if token:
            row = self._row(token, fresh=True)
            with store.connect() as conn:
                conn.execute("DELETE FROM auth_sessions WHERE hash=?",
                             (hashlib.sha256(token.encode()).hexdigest(),))
            _forget(hashlib.sha256(token.encode()).hexdigest(), others=True)
            rt = unseal(row["rt"], self.cfg.get("client_secret") or "", token) if row and row["rt"] else ""
            if rt:
                self._end_keycloak(rt)                     # 로그아웃하면 SSO 도 끝낸다 — 다음 로그인은 Keycloak 에서 다시 묻는다

    def set_cookie(self, token: str, secure: bool | None = None) -> str:
        """secure: 이 요청이 https 로 왔는가. 모르면 기본 주소의 scheme 을 따른다."""
        return (f"{COOKIE}={token}; Path=/; HttpOnly; SameSite=Lax; Max-Age={int(self.cfg['hours'] * 3600)}"
                + ("; Secure" if (self.secure_cookie if secure is None else secure) else ""))

    def clear_cookie(self) -> str:
        return f"{COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0"


def _cookie(header: str | None, name: str) -> str:
    for part in (header or "").split(";"):
        k, _, v = part.strip().partition("=")
        if k == name:
            return v
    return ""

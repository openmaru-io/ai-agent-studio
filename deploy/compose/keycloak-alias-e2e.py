#!/usr/bin/env python3
# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""실제 Keycloak 두 개로 로그인 도메인 → 회사 도메인 처리를 끝에서 끝까지 확인한다(스펙 2026-11-15-005 T1, OMAI-2037).

- Keycloak ① `aas`: AAS 가 쓰는 영역. 외부 제공자 alias `google`(OIDC, syncMode=IMPORT, trustEmail=true, 새 사용자는 aas-users 그룹),
  client scope `aas-login-provider`(사용자 세션 메모 매퍼 identity_provider → id_token claim)를 차트 keycloak-google.sh 와 같은 관리 REST 순서로 붙인다.
- Keycloak ② `google`: 구글 역할. 사용자 이메일이 `@legacy.example.com` 이다.
- AAS 서버를 이 컴퓨터의 Python 으로 띄우고, 브라우저 흉내로 AAS → Keycloak ① 로그인 화면 → 「google」 → Keycloak ② 폼 → 돌아오기를 돈다.

확인하는 것: 새로 온 사람이 회사 이메일로 들어온다(리프레시 토큰에 새 이메일) · 두 번째 구글 로그인에도 이메일이 그대로다(IMPORT)
· 세션 메모 매퍼로 identity_provider claim 이 온다(관찰 표) · 회사 이메일 사용자가 이미 있으면 AAS-LM-NEEDS-ADMIN(403) · 관리 client 는 manage-users 만으로 된다
· 「전원 바꾸기」가 이미 있는 로그인 도메인 사용자를 바꾼다.
비밀번호·client 비밀은 실행마다 무작위로 만들고, 끝나면 컨테이너·네트워크·임시 폴더를 지운다(--keep 이면 남긴다).

사용: 레포 루트에서 make test-python 으로 .venv 를 만든 뒤 `.venv/bin/python deploy/compose/keycloak-alias-e2e.py [--image …] [--keep]`
"""
import argparse
import html
import importlib.util
import json
import os
import re
import secrets
import shutil
import socket
import sqlite3
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
ap = argparse.ArgumentParser()
ap.add_argument("--image", default="quay.io/keycloak/keycloak:26.2.5")
ap.add_argument("--keep", action="store_true", help="끝나도 컨테이너와 임시 폴더를 남긴다")
args = ap.parse_args()

_missing = [m for m in ("yaml", "uvicorn", "starlette") if importlib.util.find_spec(m) is None]
if _missing:
    sys.exit(f"이 Python({sys.executable})에 AAS 서버 의존성이 없습니다: {', '.join(_missing)}. make test-python 뒤 .venv/bin/python 으로 돌리세요.")


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


TAG = secrets.token_hex(3)
NET, KC_AAS, KC_G = f"aas-alias-{TAG}", f"aas-alias-kc-{TAG}", f"aas-alias-google-{TAG}"
P_AAS, P_G, P_APP = free_port(), free_port(), free_port()
ADMIN_PW = secrets.token_urlsafe(12)
SECRET, ADMIN_SECRET, BROKER_SECRET = secrets.token_urlsafe(16), secrets.token_urlsafe(16), secrets.token_urlsafe(16)
PW = {n: secrets.token_urlsafe(12) + "aA1!" for n in ("hong", "lee", "park")}
tmp = Path(tempfile.mkdtemp(prefix="aas-alias-e2e-"))
checks: list[tuple[str, bool]] = []
aas_proc = None


def text(page: str) -> str:
    """오류 설명에 쓸 화면 글자(태그·스크립트를 뺀다)."""
    return re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", re.sub(r"(?s)<(script|style|head).*?</\1>", "", page))).strip()[:400]


def check(label: str, ok: bool, detail: str = "") -> None:
    checks.append((label, bool(ok)))
    print(("OK   " if ok else "FAIL ") + label + (f" — {detail}" if detail and not ok else ""), flush=True)


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **k):
        return None


class Browser:
    """호스트:포트별 쿠키. 리디렉션을 직접 따라간다(keycloak-e2e.py 와 같은 이유)."""

    def __init__(self):
        self.cookies: dict[str, dict[str, str]] = {}
        self.opener = urllib.request.build_opener(_NoRedirect)

    def _send(self, url: str, data: bytes | None):
        for _ in range(15):
            host = urllib.parse.urlsplit(url).netloc
            req = urllib.request.Request(url, data=data)
            jar = self.cookies.get(host, {})
            if jar:
                req.add_header("Cookie", "; ".join(f"{k}={v}" for k, v in jar.items()))
            try:
                resp = self.opener.open(req, timeout=30)
                status, headers, body = resp.status, resp.headers, resp.read()
            except urllib.error.HTTPError as exc:
                status, headers, body = exc.code, exc.headers, exc.read()
            for line in headers.get_all("Set-Cookie") or []:
                name, _, rest = line.split(";")[0].partition("=")
                if "Max-Age=0" in line or rest == "":
                    self.cookies.setdefault(host, {}).pop(name, None)
                else:
                    self.cookies.setdefault(host, {})[name] = rest
            if status in (301, 302, 303, 307) and headers.get("Location"):
                url, data = urllib.parse.urljoin(url, headers["Location"]), None
                continue
            return status, body.decode("utf-8", "replace"), url
        raise RuntimeError("리디렉션이 너무 많습니다")

    def get(self, url):
        return self._send(url, None)

    def post(self, url, form):
        return self._send(url, urllib.parse.urlencode(form).encode())

    def google_login(self, user: str):
        """AAS → Keycloak ① 로그인 화면의 google 단추 → Keycloak ② 폼 제출 → (첫 브로커 로그인) → AAS 콜백. (상태, 본문)"""
        status, page, url = self.get(f"http://127.0.0.1:{P_APP}/auth/oidc")
        m = re.search(r'href="([^"]*/broker/google/login[^"]*)"', page)
        if not m:
            return status, "google 단추 없음: " + page[:300]
        status, page, url = self.get(urllib.parse.urljoin(url, html.unescape(m.group(1))))
        m = re.search(r'<form[^>]*id="kc-form-login"[^>]*action="([^"]+)"', page) or re.search(r'<form[^>]*action="([^"]+)"[^>]*id="kc-form-login"', page)
        if m:                                              # 구글 쪽 세션이 없으면 폼, 있으면 바로 돌아온다
            status, page, url = self.post(html.unescape(m.group(1)), {"username": f"{user}@legacy.example.com", "password": PW[user], "credentialId": ""})
        m = re.search(r'<form[^>]*id="kc-update-profile-form"[^>]*action="([^"]+)"', page)
        if m:                                              # 첫 브로커 로그인의 프로필 확인(값이 다 있으면 건너뛴다)
            status, page, url = self.post(html.unescape(m.group(1)), {"email": f"{user}@legacy.example.com", "firstName": user.title(), "lastName": "Test"})
        return status, page

    def me(self):
        status, body, _ = self.get(f"http://127.0.0.1:{P_APP}/api/me")
        return status, (json.loads(body) if status == 200 else {})

    def logout(self):
        self.get(f"http://127.0.0.1:{P_APP}/auth/logout")


def wait(url: str, seconds: int) -> bool:
    end = time.time() + seconds
    while time.time() < end:
        try:
            urllib.request.urlopen(url, timeout=3).read()
            return True
        except Exception:
            time.sleep(2)
    return False


def kc(port: int, method: str, path: str, body=None, token: str = ""):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(f"http://127.0.0.1:{port}{path}", data=data, method=method,
                                 headers={"Authorization": "Bearer " + token, "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            raw = r.read()
            return r.status, (json.loads(raw) if raw else None), r.headers
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read().decode("utf-8", "replace"), exc.headers


def admin_token(port: int) -> str:
    form = urllib.parse.urlencode({"grant_type": "password", "client_id": "admin-cli", "username": "admin", "password": ADMIN_PW}).encode()
    with urllib.request.urlopen(urllib.request.Request(f"http://127.0.0.1:{port}/realms/master/protocol/openid-connect/token", data=form), timeout=30) as r:
        return json.loads(r.read())["access_token"]


def person(name: str, domain: str, groups=()) -> dict:
    return {"username": f"{name}@{domain}" if domain == "legacy.example.com" else name, "email": f"{name}@{domain}", "emailVerified": True,
            "enabled": True, "firstName": name.title(), "lastName": "Test", "groups": list(groups),
            "credentials": [{"type": "password", "value": PW[name], "temporary": False}]}


def realm_google() -> dict:
    return {"realm": "google", "enabled": True, "sslRequired": "none",
            "clients": [{"clientId": "aas-broker", "secret": BROKER_SECRET, "enabled": True, "publicClient": False, "standardFlowEnabled": True,
                         "redirectUris": [f"http://127.0.0.1:{P_AAS}/realms/aas/broker/google/endpoint"]}],
            "users": [person("hong", "legacy.example.com"), person("lee", "legacy.example.com")]}


def realm_aas() -> dict:
    installed = json.loads((ROOT / "deploy" / "k8s" / "keycloak" / "realm-aas.json").read_text(encoding="utf-8")) \
        if (ROOT / "deploy" / "k8s" / "keycloak" / "realm-aas.json").exists() else {}
    google = f"http://{KC_G}:8080/realms/google/protocol/openid-connect"
    return {"realm": "aas", "enabled": True, "sslRequired": "none", "duplicateEmailsAllowed": False, "editUsernameAllowed": False,
            "registrationEmailAsUsername": False, **({"components": installed["components"]} if installed.get("components") else {}),
            "roles": {"realm": [{"name": "aas-admin"}]}, "groups": [{"name": "aas-users"}, {"name": "aas-admins", "realmRoles": ["aas-admin"]}],
            "users": [person("lee", "openmaru.io", ["/aas-users"]),                        # 회사 이메일 사용자가 이미 있는 사람
                      person("park", "legacy.example.com", ["/aas-users"]),                      # 이미 구글로 들어와 있던 사람(전원 바꾸기 대상)
                      {"username": "service-account-aas-admin", "enabled": True, "serviceAccountClientId": "aas-admin",
                       "clientRoles": {"realm-management": ["view-users", "query-groups", "query-users", "view-realm", "manage-users"]}}],
            "clients": [{"clientId": "aas-admin", "secret": ADMIN_SECRET, "enabled": True, "publicClient": False,
                         "serviceAccountsEnabled": True, "standardFlowEnabled": False, "directAccessGrantsEnabled": False},
                        {"clientId": "aas", "secret": SECRET, "enabled": True, "publicClient": False, "standardFlowEnabled": True,
                         "directAccessGrantsEnabled": False, "redirectUris": [f"http://127.0.0.1:{P_APP}/auth/callback"],
                         "attributes": {"pkce.code.challenge.method": "S256"},
                         "protocolMappers": [{"name": "groups", "protocol": "openid-connect", "protocolMapper": "oidc-group-membership-mapper",
                                              "config": {"claim.name": "groups", "full.path": "false", "id.token.claim": "true",
                                                         "access.token.claim": "true", "userinfo.token.claim": "false"}}]}],
            "identityProviders": [{"alias": "google", "providerId": "oidc", "enabled": True, "trustEmail": True, "storeToken": False,
                                   "firstBrokerLoginFlowAlias": "first broker login",
                                   "config": {"syncMode": "IMPORT", "clientId": "aas-broker", "clientSecret": BROKER_SECRET,
                                              "clientAuthMethod": "client_secret_post", "defaultScope": "openid email profile",
                                              "authorizationUrl": f"http://127.0.0.1:{P_G}/realms/google/protocol/openid-connect/auth",
                                              "tokenUrl": google + "/token", "userInfoUrl": google + "/userinfo",
                                              "disableUserInfo": "true", "validateSignature": "false", "pkceEnabled": "false"}}],
            "identityProviderMappers": [{"name": "aas-users", "identityProviderAlias": "google", "identityProviderMapper": "oidc-hardcoded-group-idp-mapper",
                                         "config": {"group": "/aas-users", "syncMode": "INHERIT"}}]}


def attach_scope(token: str) -> None:
    """차트 keycloak-google.sh(T6) 와 같은 순서: scope 만들기 → 매퍼 → 영역 기본 scope → client aas 기본 scope. 이미 있으면 건너뛴다."""
    st, scopes, _ = kc(P_AAS, "GET", "/admin/realms/aas/client-scopes", token=token)
    sid = next((s["id"] for s in scopes if s["name"] == "aas-login-provider"), None)
    if not sid:
        st, _, hdr = kc(P_AAS, "POST", "/admin/realms/aas/client-scopes", token=token, body={
            "name": "aas-login-provider", "protocol": "openid-connect", "attributes": {"include.in.token.scope": "false"}})
        sid = hdr["Location"].rsplit("/", 1)[1]
    kc(P_AAS, "POST", f"/admin/realms/aas/client-scopes/{sid}/protocol-mappers/models", token=token, body={
        "name": "identity_provider", "protocol": "openid-connect", "protocolMapper": "oidc-usersessionmodel-note-mapper",
        "config": {"user.session.note": "identity_provider", "claim.name": "identity_provider", "jsonType.label": "String",
                   "id.token.claim": "true", "access.token.claim": "false", "userinfo.token.claim": "false", "introspection.token.claim": "false"}})
    kc(P_AAS, "PUT", f"/admin/realms/aas/default-default-client-scopes/{sid}", token=token)
    _, clients, _ = kc(P_AAS, "GET", "/admin/realms/aas/clients?clientId=aas", token=token)
    kc(P_AAS, "PUT", f"/admin/realms/aas/clients/{clients[0]['id']}/default-client-scopes/{sid}", token=token)


def kc_user(token: str, email: str) -> list[dict]:
    _, rows, _ = kc(P_AAS, "GET", "/admin/realms/aas/users?" + urllib.parse.urlencode({"email": email, "exact": "true"}), token=token)
    return rows or []


def set_mode(mode: str) -> None:
    """설정은 화면 대신 meta 표에 바로 쓴다(관리자 세션 없이). AAS 는 로그인마다 이 행을 읽는다."""
    with sqlite3.connect(tmp / "data" / "aas.db") as conn:
        conn.execute("INSERT INTO meta (key, value) VALUES ('login_alias', ?) ON CONFLICT (key) DO UPDATE SET value=excluded.value",
                     (json.dumps({"mode": mode, "pairs": [["legacy.example.com", "openmaru.io"]], "providers": ["google"], "exclude": []}),))


def rows(sql: str, *params) -> list:
    with sqlite3.connect(tmp / "data" / "aas.db") as conn:
        return conn.execute(sql, params).fetchall()


def cleanup() -> None:
    if aas_proc:
        aas_proc.terminate()
    if not args.keep:
        subprocess.run(["docker", "rm", "-f", KC_AAS, KC_G], capture_output=True)
        subprocess.run(["docker", "network", "rm", NET], capture_output=True)
        shutil.rmtree(tmp, ignore_errors=True)


try:
    subprocess.run(["docker", "network", "create", NET], capture_output=True, check=True)
    for name, port, realm in ((KC_G, P_G, realm_google()), (KC_AAS, P_AAS, realm_aas())):
        d = tmp / name
        d.mkdir()
        (d / "realm.json").write_text(json.dumps(realm), encoding="utf-8")
        run = subprocess.run(["docker", "run", "-d", "--name", name, "--network", NET, "-p", f"127.0.0.1:{port}:8080",
                              "-v", f"{d / 'realm.json'}:/opt/keycloak/data/import/realm.json:ro",
                              "-e", "KC_BOOTSTRAP_ADMIN_USERNAME=admin", "-e", f"KC_BOOTSTRAP_ADMIN_PASSWORD={ADMIN_PW}",
                              args.image, "start-dev", "--import-realm"], capture_output=True, text=True)
        if run.returncode:
            sys.exit(f"{name} 를 띄우지 못했습니다: " + run.stderr.strip())
    issuer = f"http://127.0.0.1:{P_AAS}/realms/aas"
    check("Keycloak 두 개가 올라왔다", wait(issuer + "/.well-known/openid-configuration", 240)
          and wait(f"http://127.0.0.1:{P_G}/realms/google/.well-known/openid-configuration", 60))
    if not all(ok for _, ok in checks):
        sys.exit(1)
    tok = admin_token(P_AAS)
    attach_scope(tok)
    attach_scope(tok)                                      # 두 번 돌려도 같다(T6 의 has_scope 와 같은 확인)

    (tmp / "config").mkdir()
    (tmp / "config" / "pods.json").write_text(json.dumps({"admins": [], "pods": []}), encoding="utf-8")
    env = {**os.environ, "PYTHONPATH": str(ROOT), "AAS_DATA_DIR": str(tmp / "data"), "AAS_CONFIG_DIR": str(tmp / "config"),
           "AAS_OIDC_ISSUER": issuer, "AAS_OIDC_CLIENT_ID": "aas", "AAS_OIDC_CLIENT_SECRET": SECRET,
           "AAS_KEYCLOAK_ADMIN_CLIENT_ID": "aas-admin", "AAS_KEYCLOAK_ADMIN_CLIENT_SECRET": ADMIN_SECRET,
           "AAS_ALLOWED_DOMAIN": "openmaru.io", "AAS_PASSWORD_LOGIN": "0",
           "AAS_PUBLIC_URL": f"http://127.0.0.1:{P_APP}", "AAS_ALLOWED_HOSTS": f"127.0.0.1:{P_APP}"}
    for k in ("AAS_K8S_NAMESPACE", "AAS_ADMINS", "AAS_OIDC_CLIENT_FILE", "AAS_OIDC_DISCOVERY_URL", "AAS_LOGIN_DOMAIN_ALIASES"):
        env.pop(k, None)
    aas_proc = subprocess.Popen([sys.executable, "-m", "aas", "serve", "--port", str(P_APP)], cwd=ROOT, env=env,
                                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    check("AAS 서버가 올라왔다", wait(f"http://127.0.0.1:{P_APP}/healthz", 30))

    # 1) 끈 상태: 허용 도메인(openmaru.io) 밖이라 지금처럼 거절된다
    b = Browser()
    st, page = b.google_login("hong")
    check("꺼져 있으면 @legacy.example.com 구글 로그인은 지금처럼 거절된다", st == 403 and "openmaru.io" in page, f"HTTP {st} {text(page)}")
    seen = rows("SELECT alias FROM login_idp_seen WHERE client='aas'") if rows("SELECT name FROM sqlite_master WHERE name='login_idp_seen'") else []
    check("세션 메모 매퍼로 id_token 에 identity_provider=google 이 온다", ("google",) in seen, str(seen))
    tok = admin_token(P_AAS)
    made = kc_user(tok, "hong@legacy.example.com")
    check("첫 브로커 로그인이 @legacy.example.com 사용자를 만들었다(지금 동작)", len(made) == 1)
    jid = made[0]["id"] if made else ""

    # 2) 켬: 새로 온 사람 — 이메일이 회사 도메인으로 바뀌고 리프레시한 토큰으로 들어온다
    set_mode("on")
    b = Browser()
    st, page = b.google_login("hong")
    st2, me = b.me()
    check("켜면 같은 구글 로그인이 회사 이메일로 들어온다", st2 == 200 and me.get("user", {}).get("email") == "hong@openmaru.io",
          f"login HTTP {st}, me HTTP {st2} {json.dumps(me)[:200]}")
    u = kc_user(admin_token(P_AAS), "hong@openmaru.io")
    check("Keycloak 사용자 이메일이 바뀌고 아이디·id 는 그대로다", len(u) == 1 and u[0]["id"] == jid and u[0]["username"] == "hong@legacy.example.com",
          json.dumps(u)[:300])
    rec = rows("SELECT kase, result, step FROM login_merges ORDER BY id")
    check("처리 기록: rename done agents_renamed", ("rename", "done", "agents_renamed") in rec, str(rec))
    idp = rows("SELECT login_idp FROM auth_sessions WHERE email='hong@openmaru.io'")
    check("세션의 로그인 방식이 idp:google", ("idp:google",) in idp, str(idp))

    # 3) 다시 로그인: IMPORT 라 이메일이 돌아가지 않고, 처리할 것이 없다
    b.logout()
    b2 = Browser()
    n = len(rec)
    st, page = b2.google_login("hong")
    st2, me = b2.me()
    check("두 번째 구글 로그인에도 회사 이메일 그대로(syncMode=IMPORT)", me.get("user", {}).get("email") == "hong@openmaru.io", f"HTTP {st2}")
    check("두 번째 로그인은 처리 기록을 더 남기지 않는다", len(rows("SELECT id FROM login_merges")) == n)

    # 4) 회사 이메일 사용자가 이미 있으면 거절
    b3 = Browser()
    st, page = b3.google_login("lee")
    check("회사 이메일 사용자가 있으면 AAS-LM-NEEDS-ADMIN(403)", st == 403 and "AAS-LM-NEEDS-ADMIN" in page, f"HTTP {st} {text(page)}")
    check("거절한 사람의 Keycloak 이메일은 그대로", len(kc_user(admin_token(P_AAS), "lee@legacy.example.com")) == 1)

    # 5) 전원 바꾸기(관리자 동작) — 이미 들어와 있던 park@legacy.example.com
    code = ("import json; from aas.auth import keycloak, login_alias; kc = keycloak.admin_from_config(); "
            "print(json.dumps(login_alias.bulk(kc, 'run', 'e2e')))")
    out = subprocess.run([sys.executable, "-c", code], cwd=ROOT, env=env, capture_output=True, text=True)
    res = json.loads(out.stdout.strip().splitlines()[-1]) if out.returncode == 0 and out.stdout.strip() else {}
    check("전원 바꾸기: park 바꿈, lee 확인 필요", res.get("done") == 1 and res.get("rejected") == 1, out.stdout[-300:] + out.stderr[-300:])
    check("park 의 Keycloak 이메일이 회사 도메인", len(kc_user(admin_token(P_AAS), "park@openmaru.io")) == 1)
finally:
    cleanup()

bad = [label for label, ok in checks if not ok]
print(f"\n{len(checks) - len(bad)}/{len(checks)} 통과" + (f" — 실패: {bad}" if bad else ""))
sys.exit(1 if bad else 0)

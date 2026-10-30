#!/usr/bin/env python3
# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""실제 Keycloak 컨테이너로 AAS 의 SSO 로그인을 끝에서 끝까지 확인한다(M2-4).

임시 realm(그룹 aas-users, 역할 aas-admin, 사용자 셋)을 가져와 Keycloak 을 띄우고, AAS 서버를 따로 띄운 뒤,
Keycloak 로그인 화면의 폼을 직접 제출해 인가 코드 흐름을 끝까지 돈다. 비밀번호·클라이언트 비밀은 실행마다 무작위로 만들고 끝나면 모두 지운다.
시험 스크립트는 표준 라이브러리와 docker 만 쓰지만, AAS 서버를 이 컴퓨터의 Python(`python -m aas serve`)으로 띄우므로 그 Python 에 서버 의존성(uvicorn·starlette·pyyaml 등)이 있어야 한다.
레포 루트에서 `make test-python` 을 한 번 돌리면 `.venv` 가 만들어진다. 그 `.venv/bin/python keycloak-e2e.py` 로 돌린다.

사용: .venv/bin/python keycloak-e2e.py [--image quay.io/keycloak/keycloak:26.2.5] [--keep]
확인하는 것: 그룹 구성원 로그인(sub 가 세션에 남음) · 그룹 밖 거절 · 역할만 있는 관리자 · 로그아웃 · 하루 1회 대조가 쓰는 관리 API(구성원 읽기·틀린 비밀·없는 그룹)
· 「사용자·권한」 화면의 쓰기(만들기 · 전체 PUT 뒤 department 유지 · 관리자 그룹 올리기·내리기 · 사용 중지 · 삭제).
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
ap.add_argument("--image", default="quay.io/keycloak/keycloak:26.2.5")   # 공개 상류 이미지. 폐쇄망이면 --image 로 자기 레지스트리를
ap.add_argument("--keep", action="store_true", help="끝나도 컨테이너와 임시 폴더를 남긴다")
ap.add_argument("--external-issuer", default="", help="이미 떠 있는 Keycloak(예: 쿠버네티스에 따로 설치한 것)을 쓴다. 발급자 주소(…/realms/aas). 컨테이너를 띄우지 않는다")
ap.add_argument("--aas-port", type=int, default=0, help="--external-issuer 와 함께: realm 에 등록된 AAS 접속 주소의 포트")
args = ap.parse_args()
EXTERNAL = bool(args.external_issuer)


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


KC_PORT, AAS_PORT = free_port(), (args.aas_port if EXTERNAL and args.aas_port else free_port())
NAME = f"aas-kc-e2e-{secrets.token_hex(3)}"
SECRET = os.environ.get("AAS_E2E_CLIENT_SECRET", "") if EXTERNAL else secrets.token_urlsafe(24)
PASSWORDS = {u: secrets.token_urlsafe(14) for u in ("alice", "boss", "outsider")}
ADMIN_SECRET = os.environ.get("AAS_E2E_ADMIN_CLIENT_SECRET", "") if EXTERNAL else secrets.token_urlsafe(24)
made_users: list[str] = []          # --external-issuer 로 만든 시험 사용자의 id(끝나면 지운다)
tmp = Path(tempfile.mkdtemp(prefix="aas-kc-e2e-"))
checks: list[tuple[str, bool]] = []
aas_proc = None

# 서버를 이 Python 으로 띄운다. 의존성이 없으면 Keycloak 컨테이너를 띄우기 전에 이유를 알리고 멈춘다.
_missing = [m for m in ("yaml", "uvicorn", "starlette") if importlib.util.find_spec(m) is None]
if _missing:
    sys.exit(f"이 Python({sys.executable})에 AAS 서버 의존성이 없습니다: {', '.join(_missing)}. "
             "레포 루트에서 make test-python 으로 .venv 를 만든 뒤 .venv/bin/python keycloak-e2e.py 로 돌리세요.")


def check(label: str, ok: bool) -> None:
    checks.append((label, bool(ok)))
    print(("OK   " if ok else "FAIL ") + label, flush=True)


def realm() -> dict:
    def user(name, groups=(), roles=()):
        return {"username": name, "email": f"{name}@example.com", "emailVerified": True, "enabled": True,
                "firstName": name.title(), "lastName": "Test", "groups": list(groups),
                "realmRoles": list(roles), "credentials": [{"type": "password", "value": PASSWORDS[name], "temporary": False}]}
    # 사용자 프로필(department 속성)은 설치 realm 파일의 것을 그대로 쓴다 — 없으면 Keycloak 26 이 department 를 받지 않는다
    installed = json.loads((ROOT / "deploy" / "k8s" / "keycloak" / "realm-aas.json").read_text(encoding="utf-8"))
    return {"realm": "aas", "enabled": True, "sslRequired": "none", "passwordPolicy": installed["passwordPolicy"], "components": installed["components"],
            "roles": {"realm": [{"name": "aas-admin"}]}, "groups": [{"name": "aas-users"}, {"name": "aas-admins", "realmRoles": ["aas-admin"]}],
            "users": [user("alice", groups=["/aas-users"]), user("boss", roles=["aas-admin"]), user("outsider"),
                      # 서비스 계정: 하루 1회 대조(조회)와 「사용자·권한」 화면의 쓰기(manage-users)
                      {"username": "service-account-aas-admin", "enabled": True, "serviceAccountClientId": "aas-admin",
                       "clientRoles": {"realm-management": ["view-users", "query-groups", "query-users", "view-realm", "manage-users"]}}],
            "clients": [{"clientId": "aas-admin", "secret": ADMIN_SECRET, "enabled": True, "publicClient": False,
                         "serviceAccountsEnabled": True, "standardFlowEnabled": False, "directAccessGrantsEnabled": False},
                        {"clientId": "aas", "secret": SECRET, "enabled": True, "publicClient": False,
                         "standardFlowEnabled": True, "directAccessGrantsEnabled": False,
                         "redirectUris": [f"http://127.0.0.1:{AAS_PORT}/auth/callback"],
                         "attributes": {"pkce.code.challenge.method": "S256"},
                         "protocolMappers": [{"name": "groups", "protocol": "openid-connect",
                                              "protocolMapper": "oidc-group-membership-mapper",
                                              "config": {"claim.name": "groups", "full.path": "false", "id.token.claim": "true",
                                                         "access.token.claim": "true", "userinfo.token.claim": "false"}}]}]}


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **k):
        return None


class Browser:
    """쿠키를 호스트:포트별로 모으는 간단한 브라우저. 리디렉션은 직접 따라간다.
    http.cookiejar 는 Keycloak 의 Version=1 쿠키(KC_RESTART)를 IP 주소 호스트에서 버려 「Restart login cookie not found」가 난다."""

    def __init__(self):
        self.cookies: dict[str, dict[str, str]] = {}
        self.opener = urllib.request.build_opener(_NoRedirect)

    def _send(self, url: str, data: bytes | None):
        for _ in range(10):
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

    def get(self, url: str):
        return self._send(url, None)

    def post(self, url: str, form: dict):
        return self._send(url, urllib.parse.urlencode(form).encode())

    def sso_login(self, user: str):
        """AAS → Keycloak 로그인 화면 → 폼 제출 → AAS 콜백. (상태, 본문)"""
        status, page, _ = self.get(f"http://127.0.0.1:{AAS_PORT}/auth/oidc")
        m = re.search(r'<form[^>]*id="kc-form-login"[^>]*action="([^"]+)"', page) or re.search(r'<form[^>]*action="([^"]+)"[^>]*id="kc-form-login"', page)
        if not m:
            if os.environ.get("E2E_DEBUG"):
                print(f"[debug] 로그인 폼을 찾지 못했습니다: HTTP {status}\n{page[:600]}", flush=True)
            return status, page
        status, body = self.post(html.unescape(m.group(1)), {"username": user, "password": PASSWORDS[user], "credentialId": ""})[:2]
        if os.environ.get("E2E_DEBUG"):
            msg = re.findall(r'(?:kc-feedback-text|pf-m-danger)[^>]*>([^<]{3,200})<', body)
            text = re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", re.sub(r"(?s)<(script|style|head).*?</\1>", "", body)))
            print(f"[debug] {user} 제출 뒤: HTTP {status} {msg} {text[:300]}", flush=True)
        return status, body

    def me(self):
        status, body, _ = self.get(f"http://127.0.0.1:{AAS_PORT}/api/me")
        return status, (json.loads(body) if status == 200 else {})


def wait(url: str, seconds: int) -> bool:
    end = time.time() + seconds
    while time.time() < end:
        try:
            urllib.request.urlopen(url, timeout=3).read()
            return True
        except Exception:
            time.sleep(2)
    return False


def kc_admin(method: str, path: str, body=None, token: str = ""):
    """관리 REST 호출(--external-issuer 에서 시험 사용자를 만들고 지우는 데 쓴다). (상태, 본문, 응답 헤더)"""
    base = args.external_issuer.split("/realms/")[0]
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(base + path, data=data, method=method, headers={"Authorization": "Bearer " + token, "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            raw = r.read()
            return r.status, (json.loads(raw) if raw else None), r.headers
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read().decode("utf-8", "replace"), exc.headers


def admin_token() -> str:
    base = args.external_issuer.split("/realms/")[0]
    form = urllib.parse.urlencode({"grant_type": "password", "client_id": "admin-cli", "username": os.environ["AAS_E2E_ADMIN_USER"],
                                   "password": os.environ["AAS_E2E_ADMIN_PASSWORD"]}).encode()
    with urllib.request.urlopen(urllib.request.Request(base + "/realms/master/protocol/openid-connect/token", data=form), timeout=30) as r:
        return json.loads(r.read())["access_token"]


def provision_external_users() -> None:
    """설치된 realm(aas)에 시험 사용자 셋을 만든다: alice(그룹 aas-users), boss(역할 aas-admin), outsider(아무것도 없음)."""
    tok = admin_token()
    _, groups, _ = kc_admin("GET", "/admin/realms/aas/groups?search=aas-users&exact=true", token=tok)
    gid = next(g["id"] for g in groups if g["name"] == "aas-users")
    _, role, _ = kc_admin("GET", "/admin/realms/aas/roles/aas-admin", token=tok)
    for name in ("alice", "boss", "outsider"):
        st, body, hdr = kc_admin("POST", "/admin/realms/aas/users", token=tok, body={
            "username": name, "email": f"{name}@example.com", "emailVerified": True, "enabled": True, "firstName": name.title(), "lastName": "Test",
            "credentials": [{"type": "password", "value": PASSWORDS[name], "temporary": False}]})
        if st != 201:
            raise SystemExit(f"시험 사용자 {name} 을 만들지 못했습니다: HTTP {st} {body}")
        uid = hdr["Location"].rsplit("/", 1)[1]
        made_users.append(uid)
        if name == "alice":
            kc_admin("PUT", f"/admin/realms/aas/users/{uid}/groups/{gid}", token=tok)
        if name == "boss":
            kc_admin("POST", f"/admin/realms/aas/users/{uid}/role-mappings/realm", token=tok, body=[role])


def cleanup() -> None:
    if made_users:
        try:
            tok = admin_token()
            for uid in made_users:
                kc_admin("DELETE", f"/admin/realms/aas/users/{uid}", token=tok)
        except Exception:
            print("시험 사용자를 지우지 못했습니다. Keycloak 에서 alice·boss·outsider 를 직접 지우세요", flush=True)
    if aas_proc:
        aas_proc.terminate()
    if not args.keep and not EXTERNAL:
        subprocess.run(["docker", "rm", "-f", NAME], capture_output=True)
        shutil.rmtree(tmp, ignore_errors=True)


try:
    if EXTERNAL:
        issuer = args.external_issuer.rstrip("/")
        check("Keycloak 이 올라왔다", wait(issuer + "/.well-known/openid-configuration", 60))
        if not all(ok for _, ok in checks):
            sys.exit(1)
        provision_external_users()
    else:
        (tmp / "realm.json").write_text(json.dumps(realm()), encoding="utf-8")
        run = subprocess.run(["docker", "run", "-d", "--name", NAME, "-p", f"127.0.0.1:{KC_PORT}:8080",
                              "-v", f"{tmp / 'realm.json'}:/opt/keycloak/data/import/realm.json:ro",
                              "-e", "KC_BOOTSTRAP_ADMIN_USERNAME=admin", "-e", f"KC_BOOTSTRAP_ADMIN_PASSWORD={secrets.token_urlsafe(12)}",
                              args.image, "start-dev", "--import-realm"], capture_output=True, text=True)
        if run.returncode:
            sys.exit("Keycloak 컨테이너를 띄우지 못했습니다: " + run.stderr.strip())
        issuer = f"http://127.0.0.1:{KC_PORT}/realms/aas"
        check("Keycloak 이 올라왔다", wait(issuer + "/.well-known/openid-configuration", 180))
        if not all(ok for _, ok in checks):
            print(subprocess.run(["docker", "logs", "--tail", "30", NAME], capture_output=True, text=True).stdout)
            sys.exit(1)

    (tmp / "config").mkdir()
    (tmp / "home_alice").mkdir()
    (tmp / "config" / "pods.json").write_text(json.dumps({"admins": [], "pods": [
        {"id": "a", "owner": "alice@example.com", "hermes_home": str(tmp / "home_alice")}]}), encoding="utf-8")
    env = {**os.environ, "PYTHONPATH": str(ROOT), "AAS_DATA_DIR": str(tmp / "data"), "AAS_CONFIG_DIR": str(tmp / "config"),
           "AAS_OIDC_ISSUER": issuer, "AAS_OIDC_CLIENT_ID": "aas", "AAS_OIDC_CLIENT_SECRET": SECRET,
           "AAS_PUBLIC_URL": f"http://127.0.0.1:{AAS_PORT}", "AAS_ALLOWED_HOSTS": f"127.0.0.1:{AAS_PORT}"}
    for k in ("AAS_K8S_NAMESPACE", "AAS_ADMINS", "AAS_OIDC_CLIENT_FILE", "AAS_ALLOWED_DOMAIN"):
        env.pop(k, None)
    aas_proc = subprocess.Popen([sys.executable, "-m", "aas", "serve", "--port", str(AAS_PORT)], cwd=ROOT, env=env,
                                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    check("AAS 서버가 올라왔다", wait(f"http://127.0.0.1:{AAS_PORT}/healthz", 30))

    b = Browser()
    status, _ = b.sso_login("alice")
    st, me = b.me()
    check("그룹 구성원은 로그인되고 자기 Hermes 만 본다", st == 200 and me["user"]["email"] == "alice@example.com"
          and [p["id"] for p in me["pods"]] == ["a"] and me["admin"] is False)
    check("세션에 Keycloak sub 가 남는다", bool(re.fullmatch(r"[0-9a-f-]{36}", me.get("user", {}).get("sub", ""))))

    b2 = Browser()
    status, body = b2.sso_login("outsider")
    check("그룹 밖 사용자는 거절된다", status == 403 and "aas-users" in body and b2.me()[0] != 200)

    b3 = Browser()
    b3.sso_login("boss")
    st, me = b3.me()
    check("역할 aas-admin 만 있는 사용자는 관리자다", st == 200 and me["admin"] is True)

    # 하루 1회 대조가 쓰는 관리 API 를 실제 Keycloak 에 부른다
    sys.path.insert(0, str(ROOT))
    from aas.auth import keycloak
    kc = keycloak.KeycloakAdmin(issuer, "aas-admin", ADMIN_SECRET, "aas-users", "aas-admin")
    members = kc.members()
    emails = sorted(m["email"] for m in members)
    if os.environ.get("E2E_DEBUG"):
        print(f"[debug] 관리 API 구성원: {members}", flush=True)
        try:
            tok = kc.token()
            print("[debug] 역할 보유자 원본:", kc._pages(tok, "/roles/aas-admin/users"), flush=True)
        except Exception as exc:
            print("[debug] 역할 보유자 조회 오류:", exc, flush=True)
    check("관리 API: 그룹 구성원과 관리자 역할 보유자를 읽는다(그룹 밖 사용자는 없다)", emails == ["alice@example.com", "boss@example.com"])
    check("관리 API: 구성원 id 가 로그인 세션의 sub 와 같다(대조가 sub 로 맞춘다)",
          any(m["email"] == "boss@example.com" and m["id"] == me["user"].get("sub") for m in members))
    wrong = keycloak.KeycloakAdmin(issuer, "aas-admin", "wrong-secret", "aas-users", "aas-admin")
    try:
        wrong.members(); denied = False
    except keycloak.KeycloakError:
        denied = True
    check("관리 API: 틀린 비밀이면 거절된다", denied)
    try:
        keycloak.KeycloakAdmin(issuer, "aas-admin", ADMIN_SECRET, "no-such-group", "aas-admin").members(); missing = False
    except keycloak.KeycloakError:
        missing = True
    check("관리 API: 없는 그룹은 빈 목록이 아니라 오류다", missing)

    if not EXTERNAL:                     # 이미 설치된 Keycloak 은 manage-users 가 없을 수 있다 — 컨테이너로 띄웠을 때만
        uid = ""
        try:
            tok = kc.token()
            uid = kc.create_user("e2e-hong", "e2e-hong@example.com", "길동", "홍", "개발팀", secrets.token_urlsafe(12), token=tok)
            rep = kc.get_user(uid, tok)
            check("쓰기: 만들면 이메일 확인됨·임시 비밀번호·department 가 들어간다",
                  rep.get("emailVerified") is True and (rep.get("attributes") or {}).get("department") == ["개발팀"]
                  and uid in {m["id"] for m in kc.members()})
            kc.update_user(uid, {"firstName": "길순"}, tok)
            rep = kc.get_user(uid, tok)
            check("쓰기: 전체 PUT 뒤에도 department 가 남는다(O7)", rep.get("firstName") == "길순" and (rep.get("attributes") or {}).get("department") == ["개발팀"])
            kc.set_admin(uid, True, tok)
            up = uid in kc.admin_ids(tok)
            kc.set_member(uid, False, tok)
            kc.set_admin(uid, False, tok)
            check("쓰기: 관리자 그룹 올리기·내리기, 내리면 사용자 그룹에 다시 넣는다(O6)", up and uid not in kc.admin_ids(tok) and uid in kc.directory(tok)["members"])
            kc.reset_password(uid, secrets.token_urlsafe(12), tok)
            kc.set_enabled(uid, False, tok)
            check("쓰기: 사용 중지한 사람은 대조 구성원에서 빠진다(R1)", uid not in {m["id"] for m in kc.members()})
            try:
                kc.create_user("e2e-hong", "e2e-other@example.com", "a", "b", "", secrets.token_urlsafe(12), token=tok)
                dup = ""
            except keycloak.KeycloakError as exc:
                dup = f"{exc.code} {exc.detail}"
            check("쓰기: 같은 아이디는 409 와 username 이 든 이유", dup.startswith("409") and "username" in dup.lower())
            kc.delete_user(uid, tok)
            uid = ""
            check("쓰기: 지운 사람은 목록에 없다", "e2e-hong" not in {u.get("username") for u in kc.list_users(tok)})
        except keycloak.KeycloakError as exc:
            check(f"쓰기: Keycloak 오류 없이 끝난다 ({exc.code} {exc.detail})", False)
        finally:
            if uid:
                try:
                    kc.delete_user(uid)
                except keycloak.KeycloakError:
                    pass

    b3.get(f"http://127.0.0.1:{AAS_PORT}/auth/logout")
    check("로그아웃하면 세션이 끊긴다", b3.me()[0] == 401)
finally:
    cleanup()

failed = [label for label, ok in checks if not ok]
print(f"\n{len(checks) - len(failed)}/{len(checks)} 통과")
sys.exit(1 if failed else 0)

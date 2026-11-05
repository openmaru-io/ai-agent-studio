# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""로그인·POD 연결 시험 — 가짜 OIDC 공급자와 실제 AAS 서버를 스레드로 띄워 끝에서 끝까지 본다."""
import aasserver  # 실제 uvicorn 앱을 띄우는 시험 하네스(OMAI-1100)
import base64
import http.client
import json
import os
import tempfile
import threading
import time
import unittest
from unittest import mock
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

TMP = tempfile.TemporaryDirectory()
os.environ["AAS_DATA_DIR"] = str(Path(TMP.name) / "data")


def b64(obj) -> str:
    return base64.urlsafe_b64encode(json.dumps(obj).encode()).rstrip(b"=").decode()


class FakeIdP(BaseHTTPRequestHandler):
    claims: dict = {}
    last_token_request: dict = {}

    def do_GET(self):
        base = f"http://127.0.0.1:{self.server.server_port}"
        body = json.dumps({"issuer": base, "authorization_endpoint": base + "/authorize",
                           "token_endpoint": base + "/token"}).encode()
        self.send_response(200); self.send_header("Content-Length", str(len(body))); self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        form = parse_qs(self.rfile.read(int(self.headers["Content-Length"])).decode())
        FakeIdP.last_token_request = {k: v[0] for k, v in form.items()}
        body = json.dumps({"id_token": f"{b64({'alg': 'none'})}.{b64(FakeIdP.claims)}.x"}).encode()
        self.send_response(200); self.send_header("Content-Length", str(len(body))); self.end_headers()
        self.wfile.write(body)

    def log_message(self, *a):
        pass


def start(server):
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


class AuthFlowTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        from aas.auth import auth
        from aas.fleet import pods
        from aas.web import server
        cls.idp = start(ThreadingHTTPServer(("127.0.0.1", 0), FakeIdP))
        cls.issuer = f"http://127.0.0.1:{cls.idp.server_port}"
        root = Path(TMP.name)
        for name in ("home_a", "home_b"):
            (root / name / "profiles" / ("p_" + name)).mkdir(parents=True)
        reg = root / "pods.json"
        reg.write_text(json.dumps({"admins": ["boss@corp.example"], "pods": [
            {"id": "a", "owner": "alice@corp.example", "hermes_home": str(root / "home_a")},
            {"id": "b", "owner": "bob@corp.example", "hermes_home": str(root / "home_b")}]}))
        cls.app = aasserver.start()
        cls.port = cls.app.server_port
        server._auth = auth.Auth({"issuer": cls.issuer, "client_id": "cid", "client_secret": "sec",
                                  "domain": "corp.example", "public_url": f"http://127.0.0.1:{cls.port}", "hours": 1})
        server._registry = pods.Registry(reg)
        cls.server = server

    @classmethod
    def tearDownClass(cls):
        cls.idp.shutdown(); cls.app.shutdown()
        cls.server._auth = cls.server._registry = None

    def req(self, method, path, cookie="", body=None, headers=None):
        c = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        h = {"Cookie": cookie} if cookie else {}
        h.update(headers or {})
        c.request(method, path, body=json.dumps(body) if body is not None else None, headers=h)
        r = c.getresponse()
        data = r.read()
        return r, data

    def login(self, email, popup=False, **extra):
        r, page = self.req("GET", "/auth/login")
        self.assertEqual(r.status, 200)                                             # SSO 만 있어도 로그인 화면을 먼저 보인다(스펙 2026-10-15-019)
        self.assertIn("/auth/oidc?next=/", page.decode())
        r, _ = self.req("GET", "/auth/oidc" + ("?popup=1" if popup else ""))
        self.assertEqual(r.status, 302)
        q = parse_qs(urlsplit(r.getheader("Location")).query)
        self.assertEqual((q["client_id"][0], q["code_challenge_method"][0]), ("cid", "S256"))
        self.assertNotIn("hd", q)                                                   # hd 는 구글 발급자일 때만 보낸다
        FakeIdP.claims = {"iss": self.issuer, "aud": "cid", "exp": time.time() + 300, "nonce": q["nonce"][0],
                          "sub": "sub-" + email, "email": email, "email_verified": True, "name": "N", **extra}
        r, body = self.req("GET", f"/auth/callback?code=abc&state={q['state'][0]}")
        return r, body, q

    def test_unauthenticated_is_blocked(self):
        r, _ = self.req("GET", "/")
        self.assertEqual((r.status, r.getheader("Location")), (302, "/auth/login"))
        r, body = self.req("GET", "/api/health")
        self.assertEqual(r.status, 401)
        r, _ = self.req("POST", "/api/chat/session", body={"profile": "x"}, headers={"X-AAS": "1"})
        self.assertEqual(r.status, 401)

    def test_popup_login_returns_a_closing_page_with_the_session_cookie(self):
        """스펙 2026-10-15-019: 팝업으로 연 로그인은 끝나면 원래 창에 알리고 닫는 화면을 준다. 쿠키는 그대로 준다."""
        r, body, _ = self.login("alice@corp.example", popup=True)
        self.assertEqual(r.status, 200)
        page = body.decode()
        self.assertIn("window.close()", page); self.assertIn("aasLogin", page); self.assertIn("location.origin", page)   # 같은 출처에만 알린다
        self.assertIn("HttpOnly", r.getheader("Set-Cookie"))
        cookie = r.getheader("Set-Cookie").split(";")[0]
        r, me = self.req("GET", "/api/me", cookie)
        self.assertEqual(json.loads(me)["user"]["email"], "alice@corp.example")      # 팝업이 받은 쿠키로 세션이 선다(원래 창이 /api/me 로 알아챈다)
        r, _, _ = self.login("alice@corp.example")                                    # 팝업이 아니면 예전처럼 이동한다
        self.assertEqual(r.status, 302)

    def test_login_binds_user_to_own_pod_only(self):
        r, _, q = self.login("alice@corp.example")
        self.assertEqual(r.status, 302)
        cookie = r.getheader("Set-Cookie").split(";")[0]
        self.assertIn("HttpOnly", r.getheader("Set-Cookie"))
        verifier = FakeIdP.last_token_request["code_verifier"]
        self.assertTrue(43 <= len(verifier) <= 128)                                 # RFC 7636 길이. 짧으면 Keycloak 이 거절한다
        digest = base64.urlsafe_b64encode(__import__("hashlib").sha256(verifier.encode()).digest()).rstrip(b"=").decode()
        self.assertEqual(digest, q["code_challenge"][0])                            # 검증값과 챌린지가 짝이다
        r, body = self.req("GET", "/api/me", cookie)
        me = json.loads(body)
        self.assertEqual((me["user"]["email"], me["pod"]["id"], [p["id"] for p in me["pods"]], me["admin"]),
                         ("alice@corp.example", "a", ["a"], False))
        r, body = self.req("GET", "/api/chat/status", cookie)
        self.assertEqual(json.loads(body)["profiles"], ["default", "p_home_a"])     # 자기 POD 의 프로파일만
        r, _ = self.req("POST", "/api/pod", cookie, {"id": "b"}, {"X-AAS": "1"})
        self.assertEqual(r.status, 403)                                             # 남의 POD 로 못 바꾼다
        r, body = self.req("GET", "/api/me", cookie + "; aas_pod=b")
        self.assertEqual(json.loads(body)["pod"]["id"], "a")                        # 쿠키를 꾸며도 안 된다
        r, _ = self.req("GET", f"/auth/callback?code=abc&state={q['state'][0]}")
        self.assertEqual(r.status, 403)                                             # state 는 한 번만 쓴다
        r, _ = self.req("GET", "/auth/logout", cookie)
        self.assertEqual(r.getheader("Location"), "/auth/login?out=1")
        r2, page = self.req("GET", "/auth/login?out=1", headers={"Host": "localhost:%d" % self.port})
        self.assertEqual(r2.status, 200); self.assertIn("/auth/oidc", page.decode())      # 바로 다시 로그인시키지 않고 화면을 보여 준다
        r, _ = self.req("GET", "/api/me", cookie)
        self.assertEqual(r.status, 401)

    def test_me_carries_department_and_company_name_for_office_label(self):
        """좌측 메뉴·오피스 제목 「<회사> > <부서> 오피스」(OMAI-1121 §3-5). 회사명은 설정한 값만 — 미설정이면 기본값(OPENMARU, Inc.)을 주지 않는다."""
        from aas.common import settings
        r, _, _ = self.login("alice@corp.example", department="마케팅팀")
        cookie = r.getheader("Set-Cookie").split(";")[0]
        settings.set_company_name("", "test")
        me = json.loads(self.req("GET", "/api/me", cookie)[1])
        self.assertEqual((me["department"], me["company_name"]), ("마케팅팀", ""))
        settings.set_company_name("ACME", "test")
        try:
            me = json.loads(self.req("GET", "/api/me", cookie)[1])
            self.assertEqual(me["company_name"], "ACME")
        finally:
            settings.set_company_name("", "test")

    def test_login_name_is_family_then_given_like_the_user_list(self):
        """2026-10-18: 토큰의 name 은 「이름 성」(관리자 AAS)이라 사용자 목록·구성원 칩(성+이름, AAS 관리자)과 달랐다. 성·이름이 있으면 같은 규칙으로 만든다."""
        r, _, _ = self.login("alice@corp.example", name="관리자 AAS", given_name="관리자", family_name="AAS")
        me = json.loads(self.req("GET", "/api/me", r.getheader("Set-Cookie").split(";")[0])[1])
        self.assertEqual(me["user"]["name"], "AAS 관리자")
        r, _, _ = self.login("alice@corp.example", given_name="민수", family_name="김")
        self.assertEqual(json.loads(self.req("GET", "/api/me", r.getheader("Set-Cookie").split(";")[0])[1])["user"]["name"], "김민수")
        r, _, _ = self.login("alice@corp.example", name="Alice Kim")                    # 성·이름이 없으면 name 그대로
        self.assertEqual(json.loads(self.req("GET", "/api/me", r.getheader("Set-Cookie").split(";")[0])[1])["user"]["name"], "Alice Kim")

    def test_me_own_pods_are_the_agents_the_user_owns(self):
        """스펙 2026-10-14-017 S9: 내 정보의 「내 에이전트」는 내가 주인인 에이전트다. 관리자도 남의 에이전트를 보지 않는다(OMAI-1159)."""
        r, _, _ = self.login("boss@corp.example")
        boss = self.req("GET", "/api/me", r.getheader("Set-Cookie").split(";")[0])[1]
        self.assertNotIn("a", json.loads(boss)["own_pods"])                          # 관리자 화면의 pods 에는 전체가 있지만 own_pods 는 아니다
        r, _, _ = self.login("alice@corp.example")
        alice = json.loads(self.req("GET", "/api/me", r.getheader("Set-Cookie").split(";")[0])[1])
        self.assertEqual(alice["own_pods"], ["a"])

    def test_admin_can_switch_pods(self):
        r, _, _ = self.login("boss@corp.example")
        cookie = r.getheader("Set-Cookie").split(";")[0]
        me = json.loads(self.req("GET", "/api/me", cookie)[1])
        self.assertEqual(([p["id"] for p in me["pods"]], me["admin"]), (["a", "b"], True))
        r, _ = self.req("POST", "/api/pod", cookie, {"id": "b"}, {"X-AAS": "1"})
        self.assertEqual(r.status, 200)
        me = json.loads(self.req("GET", "/api/me", cookie + "; " + r.getheader("Set-Cookie").split(";")[0])[1])
        self.assertEqual(me["pod"]["id"], "b")

    def test_전역_상태를_바꾸는_API_는_관리자만_쓴다(self):
        """OMAI-1122 D3(스펙 2026-10-13-012): 자산 담당·메모 기록, 모델 시험 호출, 칸반 보드 만들기·보내기, 전체 변경 기록."""
        X = {"X-AAS": "1"}
        alice = self.login("alice@corp.example")[0].getheader("Set-Cookie").split(";")[0]
        boss = self.login("boss@corp.example")[0].getheader("Set-Cookie").split(";")[0]
        calls = [("POST", "/api/registry", {"kind": "tool", "key": "x", "status": "registered"}),
                 ("POST", "/api/models/probe", {"model": "x"}),
                 ("POST", "/api/office/kanban/boards", {"slug": "s", "name": "S"}),
                 ("POST", "/api/office/kanban/dispatch?board=s", {})]
        for method, path, body in calls:
            r, data = self.req(method, path, alice, body, X if method != "GET" else None)
            self.assertEqual(r.status, 403, (path, data))
            r, data = self.req(method, path, boss, body, X if method != "GET" else None)
            self.assertNotEqual(r.status, 403, (path, data))                        # 관리자는 막지 않는다(입력 검사·Hermes 는 그다음)
        # 전체 변경 기록은 관리자만. alice 는 POD a 의 주인이라 자기 POD 기록만 받는다(OMAI-1126 리뷰 O7)
        r, data = self.req("GET", "/api/changes?days=7", alice)
        self.assertEqual((r.status, json.loads(data).get("owner"), json.loads(data).get("pod")), (200, True, "a"), data)
        r, data = self.req("GET", "/api/changes?days=7", boss)
        self.assertEqual((r.status, json.loads(data).get("owner")), (200, None), data)

    def test_rejections(self):
        for email, extra in (("eve@gmail.com", {}), ("eve@corp.example", {"hd": "evil.com"}),
                             ("eve@corp.example", {"email_verified": False}), ("eve@corp.example", {"aud": "other"}),
                             ("eve@corp.example", {"nonce": "wrong"}), ("eve@corp.example", {"exp": 1})):
            r, _, _ = self.login(email, **extra)
            self.assertEqual(r.status, 403, (email, extra))
            self.assertIsNone(r.getheader("Set-Cookie"))
        r, body, _ = self.login("carol@corp.example")                               # 도메인은 맞지만 POD 가 없다
        cookie = r.getheader("Set-Cookie").split(";")[0]
        r, body = self.req("GET", "/api/health", cookie)
        self.assertEqual(r.status, 403)
        self.assertIn("연결된 AI 에이전트 작업공간이 없습니다", json.loads(body)["error"])

    def test_첫_로그인_직후_Hermes_가_준비_중이면_오류_대신_준비_중_화면을_보여_준다(self):
        """쿠버네티스에서 첫 로그인은 HermesAgent 를 만들고, 파드가 Ready 가 되기까지 등록부(Pod)에는 아직 없다(OKE 실측)."""
        r, _, _ = self.login("carol@corp.example")
        cookie = r.getheader("Set-Cookie").split(";")[0]
        reg = self.server._registry
        mine = {"name": "hag-carol", "owner": "carol@corp.example", "owner_sub": "", "phase": "Pending", "ready": False, "suspended": False}
        with mock.patch.object(reg, "agents", [mine], create=True):
            r, body = self.req("GET", "/", cookie)
            self.assertEqual(r.status, 200)
            self.assertIn("준비하는 중", body.decode())
            self.assertIn("http-equiv=refresh", body.decode())
            r, body = self.req("GET", "/api/health", cookie)
            self.assertEqual(r.status, 503)
            self.assertIn("준비하는 중", json.loads(body)["error"])
        with mock.patch.object(reg, "agents", [{**mine, "suspended": True}], create=True):        # 멈춘 Hermes 는 준비 중이 아니다
            r, _ = self.req("GET", "/", cookie)
            self.assertEqual(r.status, 403)

    def test_login_started_on_one_server_finishes_on_another(self):
        """로그인 진행 상태(state·nonce·PKCE)는 DB 에 둔다 — 서버가 둘이면 콜백이 다른 서버로 가도 된다. 한 번만 쓴다
        (스펙 cogentai-aas-docs 2026-11-05-005 §5-1 U7, 쿠키 고정 없이 nginx·HAProxy 어디서나)."""
        from aas.auth import auth
        cfg = dict(self.server._auth.cfg)
        one, two = auth.Auth(cfg), auth.Auth(cfg)                                   # 서버 둘(메모리를 나누지 않는다)
        one._discovery = two._discovery = self.server._auth.discovery()
        q = parse_qs(urlsplit(one.begin("/kanban", popup=True)).query)
        pend = two._take_pending(q["state"][0])
        self.assertEqual((pend["nonce"], pend["next"], pend["popup"]), (q["nonce"][0], "/kanban", True))
        self.assertIsNone(one._take_pending(q["state"][0]))                           # 두 번 쓰지 못한다
        self.assertIsNone(two._take_pending("unknown"))

    def test_non_https_issuer_must_be_loopback(self):
        from aas.auth import auth
        a = auth.Auth({"issuer": "http://idp.example.com", "client_id": "c", "client_secret": "s",
                       "domain": "", "public_url": "http://x", "hours": 1})
        with self.assertRaises(auth.AuthError):
            a.begin("/")

    def test_password_login_for_ip_access(self):
        from aas.auth import auth
        users = Path(TMP.name) / "users.json"
        auth.save_user("Alice@Corp.example", "correct horse battery", users)
        self.assertEqual(oct(users.stat().st_mode & 0o777), "0o600")
        self.assertNotIn("correct horse", users.read_text())                         # 해시만 저장한다
        self.server._auth.cfg["users_file"] = users
        try:
            r, body = self.req("GET", "/auth/login", headers={"Host": "10.0.0.5:17900"})
            page = body.decode()
            self.assertIn("name=password", page); self.assertNotIn("/auth/oidc", page)   # IP 에서는 구글 버튼을 숨긴다
            r, body = self.req("GET", "/auth/login", headers={"Host": "localhost:17900"})
            self.assertIn("/auth/oidc", body.decode())
            form = lambda e, p, **h: self.raw("POST", "/auth/password", f"email={e}&password={p}&next=//evil.example", h)
            r, body = form("alice@corp.example", "wrong")
            self.assertEqual(r.status, 401); self.assertIsNone(r.getheader("Set-Cookie"))
            r, body = form("nobody@corp.example", "correct+horse+battery")
            self.assertEqual(r.status, 401)
            r, _ = form("alice@corp.example", "correct+horse+battery", Origin="http://evil.example")
            self.assertEqual(r.status, 403)
            r, _ = form("alice@corp.example", "correct+horse+battery")
            self.assertEqual((r.status, r.getheader("Location")), (302, "/"))        # next 는 내부 경로만
            cookie = r.getheader("Set-Cookie").split(";")[0]
            me = json.loads(self.req("GET", "/api/me", cookie)[1])
            self.assertEqual((me["user"]["email"], me["pod"]["id"]), ("alice@corp.example", "a"))
            for _ in range(6):
                r, body = form("alice@corp.example", "wrong")
            self.assertIn("너무 많습니다", body.decode())                              # 횟수 제한
            r, _ = form("alice@corp.example", "correct+horse+battery")
            self.assertEqual(r.status, 401)                                          # 제한 중에는 맞는 비밀번호도 안 받는다
        finally:
            self.server._auth.cfg.pop("users_file", None); self.server._auth._tries.clear()

    def test_ingress_terminated_tls_works_only_when_the_proxy_is_trusted(self):
        """Ingress 가 TLS 를 끝내고 http 로 넘겨도, 신뢰 설정이 켜져 있으면 https 로 로그인하고 쿠키에 Secure 를 붙인다(R1)."""
        self.server._auth.cfg["public_urls"] = ["https://aas.example.com"]
        fwd = {"Host": "aas.example.com", "X-Forwarded-Proto": "https"}
        try:
            r, _ = self.req("GET", "/auth/oidc?next=/", headers=fwd)                       # 신뢰 꺼짐: 헤더를 무시 → http 로 보여 거절
            self.assertEqual((r.status, r.getheader("Location")), (302, "/auth/login"))
            os.environ["AAS_TRUSTED_PROXY"] = "true"
            r, _ = self.req("GET", "/auth/oidc?next=/", headers=fwd)
            q = parse_qs(urlsplit(r.getheader("Location")).query)
            self.assertEqual(q["redirect_uri"][0], "https://aas.example.com/auth/callback")
            FakeIdP.claims = {"iss": self.issuer, "aud": "cid", "exp": time.time() + 300, "nonce": q["nonce"][0],
                              "sub": "s-alice", "email": "alice@corp.example", "email_verified": True}
            r, _ = self.req("GET", f"/auth/callback?code=abc&state={q['state'][0]}", headers=fwd)
            self.assertEqual(r.status, 302)
            self.assertIn("; Secure", r.getheader("Set-Cookie"))
            r, _ = self.req("GET", "/auth/oidc", headers={"Host": "aas.example.com"})        # 신뢰가 켜져도 헤더가 없으면 http
            self.assertEqual((r.status, r.getheader("Location")), (302, "/auth/login"))
            r, body = self.req("GET", "/auth/login", headers={"Host": "aas.example.com", "X-Forwarded-Proto": "https"})
            self.assertNotIn("암호화되지 않습니다", body.decode())                               # https 로 들어왔으니 http 경고가 없다
        finally:
            os.environ.pop("AAS_TRUSTED_PROXY", None)
            self.server._auth.cfg["public_urls"] = []

    def test_https_domain_gets_google_login(self):
        """https://도메인 으로 오면 그 주소로 돌아오는 구글 로그인을 주고, 쿠키에 Secure 를 붙인다."""
        import ssl, subprocess
        from aas.web import server
        d = Path(TMP.name)
        subprocess.run(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=aas.example.com",
                        "-keyout", str(d / "k.pem"), "-out", str(d / "c.pem")], check=True, capture_output=True)
        tls = aasserver.start(ssl_certfile=str(d / "c.pem"), ssl_keyfile=str(d / "k.pem"))
        self.server._auth.cfg["public_urls"] = ["https://aas.example.com"]
        ctx = ssl.create_default_context(cafile=str(d / "c.pem")); ctx.check_hostname = False

        def get(path, host="aas.example.com"):
            c = http.client.HTTPSConnection("127.0.0.1", tls.server_port, timeout=10, context=ctx)
            c.request("GET", path, headers={"Host": host})
            r = c.getresponse(); body = r.read(); c.close()
            return r, body
        try:
            r, _ = get("/auth/oidc?next=/")
            q = parse_qs(urlsplit(r.getheader("Location")).query)
            self.assertEqual(q["redirect_uri"][0], "https://aas.example.com/auth/callback")
            FakeIdP.claims = {"iss": self.issuer, "aud": "cid", "exp": time.time() + 300, "nonce": q["nonce"][0],
                              "sub": "s-alice", "email": "alice@corp.example", "email_verified": True}
            r, _ = get(f"/auth/callback?code=abc&state={q['state'][0]}")
            self.assertEqual(r.status, 302)
            self.assertIn("; Secure", r.getheader("Set-Cookie"))
            self.assertEqual(FakeIdP.last_token_request["redirect_uri"], "https://aas.example.com/auth/callback")
            r, _ = get("/auth/oidc", host="evil.example")                        # 등록되지 않은 이름으로는 구글에 보내지 않는다
            self.assertEqual((r.status, r.getheader("Location")), (302, "/auth/login"))
            r, _ = self.req("GET", "/auth/oidc", headers={"Host": "aas.example.com"})   # 같은 이름이라도 http 면 안 된다
            self.assertEqual((r.status, r.getheader("Location")), (302, "/auth/login"))
            r, _, _ = self.login("alice@corp.example")                              # 기존 주소는 그대로, Secure 없음
            self.assertNotIn("Secure", r.getheader("Set-Cookie"))
            raw = __import__("socket").create_connection(("127.0.0.1", tls.server_port), timeout=5)
            raw.sendall(b"GET / HTTP/1.0\r\n\r\n"); raw.close()                    # https 포트에 http 로 말을 걸어도 서버는 산다
            self.assertEqual(get("/auth/login")[0].status, 200)                     # 구글만 켜져 있어도 로그인 화면을 먼저 보인다(스펙 2026-10-15-019)
        finally:
            self.server._auth.cfg["public_urls"] = []
            tls.shutdown()

    def test_access_grants_from_the_screen(self):
        cookie = lambda r: r.getheader("Set-Cookie").split(";")[0]                 # noqa: E731
        boss = cookie(self.login("boss@corp.example")[0])
        alice = cookie(self.login("alice@corp.example")[0])
        X = {"X-AAS": "1"}
        setr = lambda who, **b: self.req("POST", "/api/users/set", who, b, X)       # noqa: E731
        self.assertEqual(setr(alice, email="carol@corp.example", role="user", pods=["a"])[0].status, 403)       # 관리자가 아니면 못 준다
        for bad in (dict(email="carol@elsewhere.com", role="user", pods=["a"]), dict(email="not-an-email", role="user", pods=["a"]),
                    dict(email="carol@corp.example", role="user", pods=["zz"]),
                    dict(email="carol@corp.example", role="owner", pods=["a"])):
            self.assertEqual(setr(boss, **bad)[0].status, 400, bad)
        r, _, _ = self.login("carol@corp.example")                                  # 아직 등록 전: 로그인은 되지만 볼 것이 없다
        carol = cookie(r)
        self.assertEqual(self.req("GET", "/api/health", carol)[0].status, 403)
        self.assertEqual(setr(boss, email="carol@corp.example", role="user", pods=[])[0].status, 200)           # 볼 Hermes 가 없어도 사용자로 둘 수 있다(자기 Hermes 는 소유로 열린다)
        self.assertEqual(self.req("GET", "/api/health", carol)[0].status, 403)
        from aas.web import server
        seq = server.OFFICE.bus.seq
        self.assertEqual(setr(boss, email="carol@corp.example", role="user", pods=["b"])[0].status, 200)
        self.assertIn("desks.changed", [e["type"] for e in server.OFFICE.bus.after(seq, wait=0)])   # 볼 에이전트가 바뀌면 장면이 다시 받는다(스펙 2026-10-21-022 리뷰 R8)
        me = json.loads(self.req("GET", "/api/me", carol)[1])
        self.assertEqual((me["pod"]["id"], me["admin"], [p["id"] for p in me["pods"]]), ("b", False, ["b"]))
        self.assertEqual(self.req("GET", "/api/users", carol)[0].status, 403)       # 사용자는 사용자 화면을 못 본다
        self.assertEqual(setr(boss, email="carol@corp.example", role="admin")[0].status, 200)
        me = json.loads(self.req("GET", "/api/me", carol)[1])
        self.assertEqual((me["admin"], sorted(p["id"] for p in me["pods"])), (True, ["a", "b"]))
        users = {u["email"]: u for u in json.loads(self.req("GET", "/api/users", boss)[1])["users"]}
        self.assertEqual((users["carol@corp.example"]["admin"], users["carol@corp.example"]["fixed"], users["boss@corp.example"]["fixed"]), (True, False, True))
        self.assertEqual(setr(carol, email="carol@corp.example", role="none")[0].status, 400)      # 자기 관리자 권한은 스스로 못 뺀다
        self.assertEqual(setr(boss, email="carol@corp.example", role="none")[0].status, 200)
        self.assertEqual(self.req("GET", "/api/me", carol)[0].status, 401)          # 접근을 빼면 로그인도 끊긴다
        self.assertEqual(setr(boss, email="boss@corp.example", role="none")[0].status, 200)        # 파일에 적힌 관리자는 화면에서 빼도 그대로다
        self.assertTrue(json.loads(self.req("GET", "/api/me", cookie(self.login("boss@corp.example")[0]))[1])["admin"])

    def test_에이전트가_0개여도_관리자는_사용자_화면을_보고_사람을_추가한다(self):
        """P2(스펙 2026-10-14-011): /api/users·/api/users/set 이 POD 검사 뒤에 있어 「연결된 POD 가 없습니다」 403 이 났다.
        Keycloak 관리 설정이 없는 지금 방식(R6)에서도 같다."""
        from aas.fleet import pods
        empty = Path(TMP.name) / "pods-empty.json"
        empty.write_text(json.dumps({"admins": ["boss@corp.example"], "pods": []}))
        old = self.server._registry
        self.server._registry = pods.Registry(empty)
        try:
            boss = self.login("boss@corp.example")[0].getheader("Set-Cookie").split(";")[0]
            r, body = self.req("GET", "/api/users", boss)
            self.assertEqual(r.status, 200, body)
            self.assertEqual(json.loads(body)["mode"], "legacy")
            r, body = self.req("POST", "/api/users/set", boss, {"email": "dave@corp.example", "role": "user", "pods": []}, {"X-AAS": "1"})
            self.assertEqual(r.status, 200, body)
            r, body = self.req("POST", "/api/users/create", boss, {"username": "dave"}, {"X-AAS": "1"})
            self.assertEqual(r.status, 501, body)                                   # Keycloak 관리 설정이 없으면 새 경로는 501
        finally:
            self.server._registry.grant("dave@corp.example", "none", [], "test")
            self.server._registry = old

    def test_redirect_header_cannot_be_split(self):
        r, page = self.req("GET", "/auth/login?next=/x%0d%0aSet-Cookie:%20a=b")          # 로그인 화면은 값을 HTML 안에서만 쓴다
        self.assertEqual(r.status, 200)
        self.assertIsNone(r.getheader("Set-Cookie"))
        self.assertNotIn("Set-Cookie", "".join(f"{k}: {v}" for k, v in r.getheaders()))
        r, _ = self.req("GET", "/auth/oidc?next=/x%0d%0aSet-Cookie:%20a=b")              # 이동하는 쪽도 헤더가 갈라지지 않는다
        self.assertEqual(r.status, 302)
        self.assertIsNone(r.getheader("Set-Cookie"))
        self.assertNotIn("\n", r.getheader("Location"))

    def test_host_allowlist(self):
        os.environ["AAS_ALLOWED_HOSTS"] = "localhost:17900,10.0.0.5:17900"
        try:
            r, _ = self.req("GET", "/auth/login", headers={"Host": "evil.example"})
            self.assertEqual(r.status, 400)
            r, _ = self.req("POST", "/api/chat/send", body={}, headers={"Host": "evil.example", "X-AAS": "1"})
            self.assertEqual(r.status, 400)
            r, _ = self.req("GET", "/auth/login", headers={"Host": "10.0.0.5:17900"})
            self.assertNotEqual(r.status, 400)
        finally:
            del os.environ["AAS_ALLOWED_HOSTS"]

    def raw(self, method, path, body, headers):
        c = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        c.request(method, path, body=body, headers={"Content-Type": "application/x-www-form-urlencoded", **headers})
        r = c.getresponse()
        return r, r.read()

    def test_open_redirect_is_refused(self):
        r, _ = self.req("GET", "/auth/oidc?next=//evil.example/x")
        q = parse_qs(urlsplit(r.getheader("Location")).query)
        FakeIdP.claims = {"iss": self.issuer, "aud": "cid", "exp": time.time() + 300, "nonce": q["nonce"][0],
                          "sub": "s-alice", "email": "alice@corp.example", "email_verified": True}
        r, _ = self.req("GET", f"/auth/callback?code=c&state={q['state'][0]}")
        self.assertEqual(r.getheader("Location"), "/")


class KeycloakUsersTest(unittest.TestCase):
    """「사용자·권한」의 Keycloak 방식(스펙 2026-10-14-011). 가짜 Keycloak 관리 API(kcfake)와 실제 AAS 서버를 띄운다."""
    GRANTED = ("kim@corp.example", "lee@corp.example", "hong@corp.example", "old@corp.example", "ghost@corp.example", "out@corp.example")

    @classmethod
    def setUpClass(cls):
        import kcfake
        from aas.auth import auth
        from aas.fleet import pods
        from aas.web import server
        cls.kcfake, cls.K = kcfake, kcfake.FakeKC
        cls.idp = start(ThreadingHTTPServer(("127.0.0.1", 0), FakeIdP))
        cls.issuer = f"http://127.0.0.1:{cls.idp.server_port}"
        cls.kc_httpd, cls.kc_issuer = kcfake.start()
        root = Path(TMP.name) / "kcusers"
        (root / "home_a" / "profiles").mkdir(parents=True, exist_ok=True)
        reg = root / "pods.json"
        reg.write_text(json.dumps({"admins": ["root@corp.example"], "pods": [
            {"id": "ka", "owner": "alice@corp.example", "hermes_home": str(root / "home_a")}]}))
        cls.app = aasserver.start()
        cls.port = cls.app.server_port
        cls.server = server
        cls.old = (server._auth, server._registry)
        server._auth = auth.Auth({"issuer": cls.issuer, "client_id": "cid", "client_secret": "sec", "domain": "corp.example",
                                  "users_group": "", "admin_role": "aas-admin",
                                  "public_url": f"http://127.0.0.1:{cls.port}", "hours": 1})
        server._registry = pods.Registry(reg)
        cls.kc_patch = mock.patch.object(server, "_kc_admin", lambda: kcfake.admin(cls.kc_issuer))
        cls.kc_patch.start()

    @classmethod
    def tearDownClass(cls):
        cls.kc_patch.stop()
        cls.idp.shutdown(); cls.app.shutdown(); cls.kc_httpd.shutdown()
        cls.server._auth, cls.server._registry = cls.old

    def setUp(self):
        K = self.K
        K.reset()
        K.add("kc-kim", "kim", "kim@corp.example", groups=["g-admins"], firstName="민수", lastName="김")      # 그룹으로 받은 관리자(P1)
        K.add("kc-lee", "lee", "lee@corp.example", groups=["g-users"], attributes={"department": ["영업팀"]})
        K.add("kc-out", "out", "out@corp.example")                                                           # 그룹 밖(K8)
        K.add("kc-off", "off", "off@corp.example", groups=["g-users"], enabled=False)
        K.add("kc-root", "root", "root@corp.example", groups=["g-users"])                                    # AAS_ADMINS(설치 때 지정됨)
        K.add("kc-sa", "service-account-aas-admin", "", serviceAccountClientId="aas-admin")
        self.kim = self.login("kim@corp.example", "kc-kim", admin=True)
        self.server.settings.ensure_department("개발팀", "test")      # 사용자 추가·수정의 부서는 부서 목록에서만 고른다(스펙 2026-10-15-026)

    def tearDown(self):
        reg = self.server._registry
        for e in self.GRANTED:
            reg.grant(e, "none", [], "test")                                          # 공유 데이터 폴더의 access_grants 행을 지운다

    def req(self, method, path, cookie="", body=None):
        c = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        h = {"Cookie": cookie} if cookie else {}
        if method != "GET":
            h["X-AAS"] = "1"
        c.request(method, path, body=json.dumps(body) if body is not None else None, headers=h)
        r = c.getresponse()
        data = r.read()
        c.close()
        return r.status, (json.loads(data) if data else {})

    def login(self, email, sub, admin=False):
        r, _ = self.req_raw("/auth/oidc")
        q = parse_qs(urlsplit(r.getheader("Location")).query)
        FakeIdP.claims = {"iss": self.issuer, "aud": "cid", "exp": time.time() + 300, "nonce": q["nonce"][0], "sub": sub,
                          "email": email, "email_verified": True, "name": "N",
                          **({"realm_access": {"roles": ["aas-admin"]}} if admin else {})}
        r, _ = self.req_raw(f"/auth/callback?code=abc&state={q['state'][0]}")
        return r.getheader("Set-Cookie").split(";")[0]

    def req_raw(self, path, cookie=""):
        c = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        c.request("GET", path, headers={"Cookie": cookie} if cookie else {})
        r = c.getresponse()
        body = r.read()
        c.close()
        return r, body

    def users(self, cookie=None):
        code, out = self.req("GET", "/api/users", cookie or self.kim)
        self.assertEqual(code, 200, out)
        return out, {u["key"]: u for u in out["users"]}

    def usage(self, kind):
        from aas.common import store
        with store.connect() as conn:
            return [r["note"] for r in conn.execute("SELECT note FROM usage WHERE kind=? ORDER BY ts", (kind,))]

    # ---- 목록 ----
    def test_목록은_Keycloak_사용자에_AAS_값을_붙이고_그룹으로_받은_관리자를_관리자로_보인다(self):
        out, rows = self.users()
        self.assertEqual((out["mode"], out["keycloak"]["ok"], out["login_url"]), ("keycloak", True, f"http://127.0.0.1:{self.port}"))
        kim, lee = rows["kc-kim"], rows["kc-lee"]
        self.assertEqual((kim["admin"], kim["admin_group"], kim["status"], kim["name"], kim["pods"]), (True, True, "ok", "김민수", ["ka"]))   # P1
        # 2026-10-18: 목록을 읽으면 오피스·회의가 쓰는 이름(office_people)도 Keycloak 이름으로 맞춘다(옛 토큰 이름이 남지 않게)
        from aas.office import office
        self.assertEqual(office.people()[kim["email"]]["name"], "김민수")
        self.assertEqual((lee["admin"], lee["member"], lee["status"], lee["department"], lee["pods"]), (False, True, "ok", "영업팀", []))
        self.assertEqual(rows["kc-out"]["status"], "no_access")
        self.assertIs(rows["kc-off"]["enabled"], False)
        self.assertEqual((rows["kc-root"]["fixed"], rows["kc-root"]["admin"]), (True, True))
        self.assertNotIn("kc-sa", rows)                                                # 서비스 계정은 사람이 아니다(C6)
        alice = rows["email:alice@corp.example"]                                        # 에이전트 주인이지만 Keycloak 계정이 없다
        self.assertEqual((alice["status"], alice["id"], alice["own_pods"]), ("no_account", "", ["ka"]))
        self.assertEqual(out["admin_count"], 2)                                         # kim(그룹) + root(AAS_ADMINS)
        self.assertGreaterEqual(kim["sessions"], 1)

    def test_관리자가_아니면_403_이고_Keycloak_을_읽지_못하면_AAS_값만으로_보인다(self):
        lee = self.login("lee@corp.example", "kc-lee")
        self.assertEqual(self.req("GET", "/api/users", lee)[0], 403)
        self.assertEqual(self.req("POST", "/api/users/create", lee, {})[0], 403)
        self.K.fail = {("GET", r"/admin/realms/aas/users"): 403}
        out, rows = self.users()
        self.assertEqual((out["keycloak"]["ok"], out["keycloak"]["reason"]), (False, "forbidden"))
        self.assertIn("email:kim@corp.example", rows)
        self.K.fail = {("GET", r"/admin/realms/aas/users"): 500}
        self.assertEqual(self.users()[0]["keycloak"]["reason"], "unreachable")

    # ---- 만들기 ----
    def test_만들기는_입력을_검사하고_Keycloak_계정과_화면_권한을_만든다(self):
        base = {"username": "hong", "email": "hong@corp.example", "first_name": "길동", "last_name": "홍", "department": "개발팀",
                "role": "user", "pods": ["ka"], "password": "Temp-pass-1", "create_agent": True}
        for bad, field in (({"username": "hong@corp.example"}, "username"), ({"email": "hong@gmail.com"}, "email"), ({"email": "nope"}, "email"),
                           ({"first_name": " "}, "first_name"), ({"last_name": ""}, "last_name"), ({"password": "short"}, "password")):
            code, out = self.req("POST", "/api/users/create", self.kim, {**base, **bad})
            self.assertEqual((code, out.get("field")), (400, field), bad)
        self.assertEqual(self.req("POST", "/api/users/create", self.kim, {**base, "pods": ["zz"]})[0], 400)
        code, out = self.req("POST", "/api/users/create", self.kim, base)
        self.assertEqual((code, out["ok"], out["username"], out["agent"]), (200, True, "hong", "deferred"), out)    # 쿠버네티스가 아니면 첫 로그인 때
        uid = out["id"]
        sent = self.K.calls("POST", r"/admin/realms/aas/users")[-1][2]
        self.assertEqual((sent["emailVerified"], sent["credentials"][0]["temporary"], sent["groups"]), (True, True, ["/aas-users"]))
        self.assertEqual(self.server._registry.grants()["hong@corp.example"], {**self.server._registry.grants()["hong@corp.example"], "role": "user", "pods": ["ka"]})
        rows = self.users()[1]
        self.assertEqual((rows[uid]["status"], rows[uid]["shared_pods"], rows[uid]["department"]), ("ok", ["ka"], "개발팀"))
        notes = " ".join(self.usage("user_create"))
        self.assertIn("hong", notes)
        self.assertNotIn("Temp-pass-1", notes)                                          # 감사 기록에 값을 남기지 않는다
        self.assertNotIn("hong@corp.example", notes)
        for dup, field in (({"email": "other@corp.example"}, "username"), ({"username": "hong2"}, "email")):
            code, out = self.req("POST", "/api/users/create", self.kim, {**base, **dup})
            self.assertEqual((code, out.get("field")), (409, field), dup)

    def test_관리자로_만들면_관리자_그룹에도_넣는다(self):
        code, out = self.req("POST", "/api/users/create", self.kim, {"username": "hong", "email": "hong@corp.example", "first_name": "길동",
                                                                   "last_name": "홍", "role": "admin", "password": "Temp-pass-1", "create_agent": False})
        self.assertEqual(code, 200, out)
        self.assertIn(out["id"], self.K.members["g-admins"])
        self.assertEqual(self.users()[1][out["id"]]["admin"], True)

    def test_화면_권한_쓰기가_실패하면_Keycloak_계정을_되돌리고_되돌리기도_실패하면_일부만_만들어짐(self):
        body = {"username": "hong", "email": "hong@corp.example", "first_name": "길동", "last_name": "홍", "password": "Temp-pass-1"}
        with mock.patch.object(type(self.server._registry), "grant", side_effect=RuntimeError("db down")):
            code, out = self.req("POST", "/api/users/create", self.kim, body)
            self.assertEqual((code, out.get("partial")), (500, None), out)
            self.assertNotIn("hong", {u["username"] for u in self.K.users.values()})      # 되돌렸다
            self.K.fail = {("DELETE", r"/admin/realms/aas/users/.+"): 500}
            code, out = self.req("POST", "/api/users/create", self.kim, body)
            self.assertEqual((code, out.get("partial")), (500, True), out)

    def test_에이전트를_만들지_못해도_계정은_남고_부서를_먼저_적는다(self):
        order = []
        with mock.patch.object(self.server.settings, "set_department", side_effect=lambda e, d: order.append(("dept", e, d))), \
                mock.patch.object(self.server, "_provision", side_effect=lambda *a: (order.append(("agent",) + a), (_ for _ in ()).throw(RuntimeError("k8s down")))[1]):
            code, out = self.req("POST", "/api/users/create", self.kim, {"username": "hong", "email": "hong@corp.example", "first_name": "길동",
                                                                       "last_name": "홍", "department": "개발팀", "password": "Temp-pass-1"})
        self.assertEqual((code, out["agent"], out["agent_error"]), (200, "failed", "k8s down"), out)
        self.assertEqual(order, [("dept", "hong@corp.example", "개발팀"), ("agent", out["id"], "hong@corp.example", "홍길동")])   # O1, sub = Keycloak id
        self.assertIn(out["id"], self.K.users)                                         # O8: 계정은 남긴다

    def test_Keycloak_쓰기_권한이_없으면_403_forbidden(self):
        self.K.deny_writes = True
        code, out = self.req("POST", "/api/users/create", self.kim, {"username": "hong", "email": "hong@corp.example", "first_name": "길동",
                                                                   "last_name": "홍", "password": "Temp-pass-1"})
        self.assertEqual((code, out.get("reason")), (403, "forbidden"), out)

    # ---- 고치기·권한 ----
    def test_고치기는_이름과_부서를_바꾸고_속성을_지우지_않으며_이메일은_받지_않는다(self):
        self.K.users["kc-lee"]["attributes"]["locale"] = ["ko"]
        code, out = self.req("POST", "/api/users/update", self.kim, {"id": "kc-lee", "first_name": "영희", "last_name": "이",
                                                                   "department": "개발팀", "email": "evil@corp.example", "pods": ["ka"]})
        self.assertEqual(code, 200, out)
        u = self.K.users["kc-lee"]
        self.assertEqual((u["firstName"], u["email"], u["attributes"]), ("영희", "lee@corp.example", {"department": ["개발팀"], "locale": ["ko"]}))
        self.assertEqual(self.server._registry.grants()["lee@corp.example"]["pods"], ["ka"])
        self.assertIn("fields=last_name,first_name,department,pods", self.usage("user_update")[-1])
        self.assertEqual(self.req("POST", "/api/users/update", self.kim, {"id": "kc-lee", "first_name": ""})[1].get("field"), "first_name")

    def test_관리자_올리기_내리기와_잠금(self):
        code, _ = self.req("POST", "/api/users/update", self.kim, {"id": "kc-lee", "role": "admin"})
        self.assertEqual(code, 200)
        self.assertIn("kc-lee", self.K.members["g-admins"])
        lee = self.login("lee@corp.example", "kc-lee", admin=True)
        code, _ = self.req("POST", "/api/users/update", self.kim, {"id": "kc-lee", "role": "user"})
        self.assertEqual(code, 200)
        self.assertNotIn("kc-lee", self.K.members["g-admins"])
        self.assertIn("kc-lee", self.K.members["g-users"])
        self.assertEqual(self.req_raw("/api/me", lee)[0].status, 401)                 # 관리자를 빼면 세션을 바로 끊는다
        code, out = self.req("POST", "/api/users/update", self.kim, {"id": "kc-kim", "role": "user"})
        self.assertEqual(code, 409, out)                                              # 자기 관리자 권한 빼기
        code, out = self.req("POST", "/api/users/update", self.kim, {"id": "kc-root", "role": "user"})
        self.assertEqual(code, 409, out)                                              # 설치 때 지정됨
        self.assertIn("운영자가 관리자로 정한", out["error"])

    def test_마지막_관리자는_사용_중지하거나_지우지_못한다(self):
        from aas.fleet import pods
        reg = self.server._registry
        old_admins = reg.admins
        reg.admins = set()
        reg.grant("ghost@corp.example", "admin", [], "test")                           # 옮기지 못한 관리자(관리자 수에 들지 않는다)
        try:
            ghost = self.login("ghost@corp.example", "kc-ghost")
            for path, body in (("/api/users/enable", {"id": "kc-kim", "enabled": False}), ("/api/users/delete", {"id": "kc-kim"}),
                               ("/api/users/update", {"id": "kc-kim", "role": "user"})):
                code, out = self.req("POST", path, ghost, body)
                self.assertEqual(code, 409, (path, out))
                self.assertIn("마지막 관리자", out["error"])
            self.assertIn("kc-kim", self.K.users)
            out = self.users(ghost)[0]
            self.assertEqual((out["unmigrated"], out["admin_count"]), (["ghost@corp.example"], 1))
            ghost_row = {u["key"]: u for u in out["users"]}["email:ghost@corp.example"]
            self.assertEqual((ghost_row["status"], ghost_row["admin"]), ("unmigrated", True))
        finally:
            reg.admins = old_admins

    def test_나는_사용_중지하거나_지우지_못한다(self):
        for path, body in (("/api/users/enable", {"id": "kc-kim", "enabled": False}), ("/api/users/delete", {"id": "kc-kim"})):
            self.assertEqual(self.req("POST", path, self.kim, body)[0], 409, path)
        self.assertEqual(self.req("POST", "/api/users/enable", self.kim, {"id": "kc-root", "enabled": False})[0], 409)   # 설치 때 지정됨

    # ---- 비밀번호·접근·로그아웃 ----
    def test_비밀번호_재설정은_임시이고_8자_미만은_거절한다(self):
        self.assertEqual(self.req("POST", "/api/users/password", self.kim, {"id": "kc-lee", "password": "short"})[1].get("field"), "password")
        self.assertEqual(self.req("POST", "/api/users/password", self.kim, {"id": "kc-lee", "password": "New-pass-99"})[0], 200)
        self.assertEqual(self.K.passwords["kc-lee"], ("New-pass-99", True))
        self.assertNotIn("New-pass-99", " ".join(self.usage("user_password")))
        self.assertEqual(self.req("POST", "/api/users/password", self.kim, {"id": "kc-none", "password": "New-pass-99"})[0], 404)

    def test_AAS_에_추가는_사용자_그룹에_넣는다(self):
        self.assertEqual(self.req("POST", "/api/users/access", self.kim, {"id": "kc-out"})[0], 200)
        self.assertIn("kc-out", self.K.members["g-users"])
        self.assertEqual(self.users()[1]["kc-out"]["status"], "ok")

    def test_로그인_끊기는_AAS_세션과_Keycloak_세션을_함께_끝낸다(self):
        lee = self.login("lee@corp.example", "kc-lee")
        code, out = self.req("POST", "/api/users/logout", self.kim, {"email": "lee@corp.example"})
        self.assertEqual(code, 200)
        self.assertGreaterEqual(out["ended"], 1)                                      # 앞선 시험의 세션도 같은 데이터 폴더에 있다
        self.assertTrue(self.K.calls("POST", r"/admin/realms/aas/users/kc-lee/logout"))
        self.assertEqual(self.req_raw("/api/me", lee)[0].status, 401)
        note = self.usage("user_logout")[-1]
        self.assertIn(" lee ", note)
        self.assertNotIn("lee@corp.example", note)
        self.assertEqual(self.req("POST", "/api/users/set", self.kim, {"email": "lee@corp.example", "role": "user"})[0], 501)   # Keycloak 방식에서는 쓰지 않는다

    # ---- 사용 중지·삭제와 Hermes ----
    def _agent(self, name, owner, sub, reason=""):
        spec = {"ownerEmail": owner, "ownerSub": sub, **({"suspended": True} if reason else {})}
        ann = {"aas.openmaru.io/suspended-reason": reason} if reason else {}
        return {"metadata": {"name": name, "annotations": ann}, "spec": spec}

    def test_사용_중지는_세션을_끊고_Hermes_를_disabled_로_멈추고_다시_사용은_disabled_만_켠다(self):
        lee = self.login("lee@corp.example", "kc-lee")
        client = mock.Mock()
        items = [self._agent("ag-1", "lee@corp.example", "kc-lee"), self._agent("ag-2", "lee@corp.example", "kc-lee", "idle")]
        with mock.patch.object(self.server, "_owned_agents", return_value=(client, items)):
            code, out = self.req("POST", "/api/users/enable", self.kim, {"id": "kc-lee", "enabled": False})
        self.assertEqual((code, out["agents"]), (200, 1), out)
        self.assertIs(self.K.users["kc-lee"]["enabled"], False)
        self.assertEqual(self.K.users["kc-lee"]["attributes"], {"department": ["영업팀"]})
        self.assertTrue(self.K.calls("POST", r"/admin/realms/aas/users/kc-lee/logout"))
        self.assertEqual(self.req_raw("/api/me", lee)[0].status, 401)
        name, patch = client.patch_agent.call_args[0]
        self.assertEqual((name, patch["metadata"]["annotations"]["aas.openmaru.io/suspended-reason"], patch["spec"]["suspended"]), ("ag-1", "disabled", True))
        client.reset_mock()
        items = [self._agent("ag-1", "lee@corp.example", "kc-lee", "disabled"), self._agent("ag-2", "lee@corp.example", "kc-lee", "idle")]
        with mock.patch.object(self.server, "_owned_agents", return_value=(client, items)):
            code, out = self.req("POST", "/api/users/enable", self.kim, {"id": "kc-lee", "enabled": True})
        self.assertEqual((code, out["agents"]), (200, 1), out)
        self.assertEqual([c[0][0] for c in client.patch_agent.call_args_list], ["ag-1"])            # 미사용으로 멈춘 것은 켜지 않는다
        self.assertIs(self.K.users["kc-lee"]["enabled"], True)
        self.assertEqual(self.req("POST", "/api/users/enable", self.kim, {"id": "kc-lee", "enabled": "no"})[0], 400)

    def test_삭제는_세션을_끊고_Hermes_주인을_비워_멈춘_뒤_계정과_화면_권한을_지운다(self):
        lee = self.login("lee@corp.example", "kc-lee")
        self.server._registry.grant("lee@corp.example", "user", ["ka"], "test")
        client = mock.Mock()
        with mock.patch.object(self.server, "_owned_agents", return_value=(client, [self._agent("ag-1", "lee@corp.example", "kc-lee")])):
            code, out = self.req("POST", "/api/users/delete", self.kim, {"id": "kc-lee"})
        self.assertEqual((code, out["agents"]), (200, ["ag-1"]), out)
        name, patch = client.patch_agent.call_args[0]
        self.assertEqual((patch["metadata"]["annotations"]["aas.openmaru.io/deleted-owner"], patch["spec"]["ownerEmail"], patch["spec"]["suspended"]),
                         ("lee@corp.example", None, True))
        self.assertNotIn("kc-lee", self.K.users)
        self.assertNotIn("lee@corp.example", self.server._registry.grants())
        self.assertEqual(self.req_raw("/api/me", lee)[0].status, 401)
        self.assertNotIn("lee@corp.example", " ".join(self.usage("user_delete")))
        # 쿠버네티스가 실패하면 Keycloak 계정을 지우기 전에 멈춘다
        from aas.fleet import k8s
        with mock.patch.object(self.server, "_owned_agents", side_effect=k8s.K8sError("down", 500)):
            code, _ = self.req("POST", "/api/users/delete", self.kim, {"id": "kc-out"})
        self.assertEqual(code, 502)
        self.assertIn("kc-out", self.K.users)

    # ---- K7 옮기기 ----
    def test_화면이_준_관리자를_Keycloak_그룹으로_옮기고_계정이_없으면_남긴다(self):
        reg = self.server._registry
        reg.grant("lee@corp.example", "admin", ["ka"], "test")
        reg.grant("ghost@corp.example", "admin", [], "test")
        kc = self.kcfake.admin(self.kc_issuer)
        out = self.server.migrate_admins_once(kc)
        self.assertEqual((out["moved"], out["left"]), (["lee@corp.example"], ["ghost@corp.example"]))
        self.assertIn("kc-lee", self.K.members["g-admins"])
        grants = reg.grants()
        self.assertEqual((grants["lee@corp.example"]["role"], grants["lee@corp.example"]["pods"]), ("user", ["ka"]))
        self.assertEqual(grants["ghost@corp.example"]["role"], "admin")
        self.assertTrue(reg.is_admin({"email": "ghost@corp.example"}))                  # 옮기지 못한 행은 계속 관리자다(O9)
        self.assertFalse(reg.is_admin({"email": "lee@corp.example"}))                   # 옮긴 행은 더는 관리자로 읽지 않는다(K7)
        self.assertEqual(self.server.migrate_admins_once(kc)["moved"], [])             # 두 번 해도 같다
        self.assertEqual(self.users()[1]["kc-lee"]["admin"], True)


if __name__ == "__main__":
    unittest.main()

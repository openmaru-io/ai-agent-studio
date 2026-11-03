# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""Claude Code 의 MCP OAuth 연결(스펙 2026-10-28-001 §3-1-1 A·§3-7 ① T2, OMAI-1513).

메타데이터 → 등록(루프백만, D13) → 동의 화면(로그인으로 보냈다 돌아오기·CSRF·거부) → code(PKCE) → 토큰 → /mcp →
refresh 바꾸기(30초 유예·재사용이면 끊기) · 접근 토큰 1시간 · Keycloak 빠짐 · 로그인 끔.
"""
import aasserver  # 실제 uvicorn 앱을 띄우는 시험 하네스(OMAI-1100)
import base64
import hashlib
import http.client
import json
import os
import re
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock
from urllib.parse import parse_qs, quote, urlencode, urlsplit

TMP = tempfile.TemporaryDirectory()
os.environ.setdefault("AAS_DATA_DIR", str(Path(TMP.name) / "data"))

ALICE, NOBODY = "oa-alice@corp.example", "oa-nobody@corp.example"
PASSWORD = "correct horse battery"
CALLBACK = "http://127.0.0.1:53817/callback"


def pkce():
    verifier = base64.urlsafe_b64encode(os.urandom(40)).rstrip(b"=").decode()
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
    return verifier, challenge


class OAuthTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        from aas.auth import auth
        from aas.fleet import pods
        from aas.web import mcp_server, server
        root = Path(TMP.name)
        cls.users = root / "oa-users.json"
        for e in (ALICE, NOBODY):
            auth.save_user(e, PASSWORD, cls.users)
        (root / "oa_home" / "profiles" / "main").mkdir(parents=True, exist_ok=True)
        reg = root / "oa-pods.json"
        reg.write_text(json.dumps({"pods": [{"id": "oa-a", "owner": ALICE, "hermes_home": str(root / "oa_home")}]}))
        cls.app = aasserver.start()
        cls.port = cls.app.server_port
        cls.saved = (server._auth, server._registry)
        server._auth = auth.Auth({"issuer": "", "client_id": "", "client_secret": "", "domain": "",
                                  "public_url": f"http://127.0.0.1:{cls.port}", "hours": 1, "users_file": cls.users})
        server._registry = pods.Registry(reg)
        cls.kc = mock.patch.object(mcp_server, "_keycloak", lambda: None)
        cls.kc.start()
        cls.server, cls.mcp = server, mcp_server

    @classmethod
    def tearDownClass(cls):
        cls.kc.stop()
        cls.app.shutdown()
        cls.server._auth, cls.server._registry = cls.saved
        from aas.auth import tokens
        with tokens._conn() as conn:
            for e in (ALICE, NOBODY):
                conn.execute("DELETE FROM oauth_refresh WHERE family IN (SELECT family FROM personal_tokens WHERE user_email=?)", (e,))
                conn.execute("DELETE FROM personal_tokens WHERE user_email=?", (e,))
                conn.execute("DELETE FROM oauth_codes WHERE user_email=?", (e,))

    # ---- 도우미 ----------------------------------------------------------------------------------
    def req(self, method, path, body=None, headers=None):
        c = http.client.HTTPConnection("127.0.0.1", self.port, timeout=20)
        c.request(method, path, body=body, headers=headers or {})
        r = c.getresponse()
        data = r.read()
        return r, (json.loads(data) if data[:1] == b"{" else data.decode("utf-8", "replace"))

    def login(self, email=ALICE):
        r, _ = self.req("POST", "/auth/password", f"email={email}&password=correct+horse+battery&next=/",
                        {"Content-Type": "application/x-www-form-urlencoded"})
        self.assertEqual(r.status, 302)
        return r.getheader("Set-Cookie").split(";")[0]

    def register(self, uris=(CALLBACK,), name="claude-code"):
        r, out = self.req("POST", "/mcp/oauth/register", json.dumps({"redirect_uris": list(uris), "client_name": name,
                                                                     "token_endpoint_auth_method": "none"}),
                          {"Content-Type": "application/json"})
        return r, out

    def authorize_query(self, cid, challenge, redirect=CALLBACK, **extra):
        q = {"response_type": "code", "client_id": cid, "redirect_uri": redirect, "code_challenge": challenge,
             "code_challenge_method": "S256", "state": "st-1", **extra}
        return "/oauth/connect/authorize?" + urlencode(q)

    def consent(self, cookie, cid, challenge, decision="allow", bundle="all", redirect=CALLBACK, csrf=None, headers=None):
        r, page = self.req("GET", self.authorize_query(cid, challenge, redirect), headers={"Cookie": cookie})
        self.assertEqual(r.status, 200, page)
        token = csrf if csrf is not None else re.search(r"name=csrf value=([0-9a-f]+)", page).group(1)
        form = {"response_type": "code", "client_id": cid, "redirect_uri": redirect, "code_challenge": challenge,
                "code_challenge_method": "S256", "state": "st-1", "csrf": token, "bundle": bundle, "decision": decision}
        return self.req("POST", "/oauth/connect/authorize", urlencode(form),
                        {"Cookie": cookie, "Content-Type": "application/x-www-form-urlencoded", **(headers or {})})

    def token(self, **form):
        return self.req("POST", "/mcp/oauth/token", urlencode(form), {"Content-Type": "application/x-www-form-urlencoded"})

    def connect(self, bundle="all"):
        """끝까지: 등록 → 동의 → code → 토큰. (client_id, 토큰 응답)."""
        _, reg = self.register()
        verifier, challenge = pkce()
        r, _ = self.consent(self.login(), reg["client_id"], challenge, bundle=bundle)
        code = parse_qs(urlsplit(r.getheader("Location")).query)["code"][0]
        r, out = self.token(grant_type="authorization_code", code=code, redirect_uri=CALLBACK, client_id=reg["client_id"],
                            code_verifier=verifier)
        self.assertEqual(r.status, 200, out)
        return reg["client_id"], out

    def mcp_init(self, access):
        return self.req("POST", "/mcp", json.dumps({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}}),
                        {"Authorization": f"Bearer {access}", "Content-Type": "application/json"})

    # ---- 메타데이터 ------------------------------------------------------------------------------
    def test_메타데이터와_401_안내(self):
        base = f"http://127.0.0.1:{self.port}"
        r, pr = self.req("GET", "/.well-known/oauth-protected-resource")
        self.assertEqual((pr["resource"], pr["authorization_servers"]), (base + "/mcp", [base]))
        self.assertEqual(self.req("GET", "/.well-known/oauth-protected-resource/mcp")[1], pr)
        r, asm = self.req("GET", "/.well-known/oauth-authorization-server")
        self.assertEqual(asm["authorization_endpoint"], base + "/oauth/connect/authorize")
        self.assertEqual(asm["token_endpoint"], base + "/mcp/oauth/token")
        self.assertEqual(asm["registration_endpoint"], base + "/mcp/oauth/register")
        self.assertEqual(asm["code_challenge_methods_supported"], ["S256"])
        r, _ = self.req("POST", "/mcp", json.dumps({"jsonrpc": "2.0", "id": 1, "method": "initialize"}))
        self.assertEqual(r.status, 401)
        self.assertEqual(r.getheader("WWW-Authenticate"), f'Bearer resource_metadata="{base}/.well-known/oauth-protected-resource"')
        r, _ = self.mcp_init("aas_oat_wrong")
        self.assertIn('error="invalid_token", error_description="invalid_token"', r.getheader("WWW-Authenticate"))

    # ---- 등록 ------------------------------------------------------------------------------------
    def test_등록은_루프백_주소만(self):
        r, out = self.register(("http://localhost:4000/cb", "http://[::1]:5/x", CALLBACK))
        self.assertEqual((r.status, out["token_endpoint_auth_method"]), (201, "none"))
        self.assertTrue(out["client_id"].startswith("aasc_"))
        for bad in ("https://evil.example/cb", "http://evil.example/cb", "http://localhost@evil.example/cb",
                    "http://127.0.0.1.evil.example/cb", "http://127.0.0.1:1/cb#frag", "javascript:alert(1)"):
            with self.subTest(uri=bad):
                r, out = self.register((bad,))
                self.assertEqual((r.status, out["error"]), (400, "invalid_redirect_uri"))
        r, out = self.req("POST", "/mcp/oauth/register", json.dumps({"redirect_uris": [CALLBACK], "token_endpoint_auth_method": "client_secret_basic"}))
        self.assertEqual(out["error"], "invalid_client_metadata")
        r, out = self.req("POST", "/mcp/oauth/register", json.dumps({"redirect_uris": [CALLBACK]}), {"Origin": "http://evil.example"})
        self.assertEqual(r.status, 403)

    # ---- 동의 화면 -------------------------------------------------------------------------------
    def test_세션이_없으면_로그인으로_보냈다가_돌아온다(self):
        _, reg = self.register()
        q = self.authorize_query(reg["client_id"], pkce()[1])
        r, _ = self.req("GET", q)
        self.assertEqual(r.status, 303)
        loc = r.getheader("Location")
        self.assertTrue(loc.startswith("/auth/login?next="), loc)
        self.assertEqual(parse_qs(urlsplit(loc).query)["next"][0], q)
        from aas.auth import auth                         # SSO 만 있는 설치는 로그인 카드 없이 SSO 로(디자인 D12)
        sso = auth.Auth({"issuer": "https://kc.example/realms/x", "client_id": "c", "client_secret": "s", "domain": "",
                         "public_url": f"http://127.0.0.1:{self.port}", "hours": 1, "users_file": Path(TMP.name) / "none.json"})
        with mock.patch.object(self.server, "_auth", sso):
            r, _ = self.req("GET", q)
        self.assertTrue(r.getheader("Location").startswith("/auth/oidc?next="), r.getheader("Location"))

    def test_동의_화면_내용과_틀(self):
        _, reg = self.register(name="claude-code <b>x</b>")
        r, page = self.req("GET", self.authorize_query(reg["client_id"], pkce()[1]), headers={"Cookie": self.login()})
        self.assertEqual(r.status, 200)
        self.assertEqual(r.getheader("X-Frame-Options"), "DENY")
        self.assertEqual(r.getheader("Referrer-Policy"), "same-origin")                 # no-referrer 면 브라우저가 Origin: null 을 보낸다
        self.assertIn("claude-code &lt;b&gt;x&lt;/b&gt;", page)                        # 클라이언트 이름은 글자로만
        self.assertIn(CALLBACK, page)
        self.assertIn(ALICE, page)
        self.assertIn("oa-a", page)
        self.assertRegex(page, r"value=all checked")                                    # 기본 묶음은 「전체」(§3-1)
        self.assertNotIn(" disabled", page)
        # 「읽기만」은 보내지 못한다고 적고, 보내는 묶음은 위험 줄 맨 앞에 「일을 시킴」(스펙 2026-11-03-001 DD8)
        self.assertIn("<b>읽기만</b> — 대화를 보고 결과를 받습니다. 메시지는 보낼 수 없습니다", page)
        for key in ("skill-dev", "all"):
            self.assertRegex(page, rf"id=warn-{key} [^>]*>▸ AI 에이전트에게 일을 시킴\(터미널 실행 포함\) · 위험 명령 승인")
        self.assertNotIn("id=warn-read", page)

    def test_에이전트가_없으면_허용을_막는다(self):
        _, reg = self.register()
        verifier, challenge = pkce()
        cookie = self.login(NOBODY)
        r, page = self.req("GET", self.authorize_query(reg["client_id"], challenge), headers={"Cookie": cookie})
        self.assertIn(" disabled", page)
        r, _ = self.consent(cookie, reg["client_id"], challenge)                       # 단추를 우회해 보내도
        self.assertEqual(parse_qs(urlsplit(r.getheader("Location")).query)["error"], ["access_denied"])

    def test_잘못된_요청(self):
        _, reg = self.register()
        cookie = self.login()
        r, page = self.req("GET", self.authorize_query("aasc_nope", pkce()[1]), headers={"Cookie": cookie})
        self.assertEqual(r.status, 400)                                                  # 모르는 클라이언트 — 리디렉트하지 않는다
        self.assertIsNone(r.getheader("Location"))
        r, page = self.req("GET", self.authorize_query(reg["client_id"], pkce()[1], "http://evil.example/cb"), headers={"Cookie": cookie})
        self.assertEqual(r.status, 400)
        r, _ = self.req("GET", self.authorize_query(reg["client_id"], ""), headers={"Cookie": cookie})
        loc = parse_qs(urlsplit(r.getheader("Location")).query)
        self.assertEqual((r.status, loc["error"], loc["state"]), (303, ["invalid_request"], ["st-1"]))   # PKCE 없음
        r, page = self.req("GET", self.authorize_query(reg["client_id"], pkce()[1], "http://127.0.0.1:60001/callback"),
                           headers={"Cookie": cookie})
        self.assertEqual(r.status, 200)                                                  # 루프백은 포트가 달라도 된다

    def test_거부_CSRF_다른_출처(self):
        _, reg = self.register()
        cookie = self.login()
        challenge = pkce()[1]
        r, _ = self.consent(cookie, reg["client_id"], challenge, decision="deny")
        loc = parse_qs(urlsplit(r.getheader("Location")).query)
        self.assertEqual((r.status, loc["error"], loc["state"]), (303, ["access_denied"], ["st-1"]))
        r, page = self.consent(cookie, reg["client_id"], challenge, csrf="0" * 64)
        self.assertEqual(r.status, 403)
        self.assertIsNone(r.getheader("Location"))
        r, page = self.consent(cookie, reg["client_id"], challenge, headers={"Origin": "http://evil.example"})
        self.assertEqual(r.status, 403)
        r, page = self.consent(cookie, reg["client_id"], challenge, headers={"Origin": "null"})
        self.assertEqual(r.status, 403)                                                  # 출처를 숨긴 요청
        r, _ = self.consent(cookie, reg["client_id"], challenge, decision="deny", headers={"Origin": f"http://127.0.0.1:{self.port}"})
        self.assertEqual(r.status, 303)                                                  # 브라우저처럼 같은 출처를 실은 요청
        other = self.login(NOBODY)                                                        # 다른 세션의 CSRF 값은 맞지 않는다
        _, page = self.req("GET", self.authorize_query(reg["client_id"], challenge), headers={"Cookie": cookie})
        mine = re.search(r"name=csrf value=([0-9a-f]+)", page).group(1)
        r, _ = self.consent(other, reg["client_id"], challenge, csrf=mine)
        self.assertEqual(r.status, 403)

    # ---- 토큰 ------------------------------------------------------------------------------------
    def test_code_교환과_mcp(self):
        _, reg = self.register()
        verifier, challenge = pkce()
        r, _ = self.consent(self.login(), reg["client_id"], challenge, bundle="skill-dev")
        q = parse_qs(urlsplit(r.getheader("Location")).query)
        self.assertEqual(q["state"], ["st-1"])
        code = q["code"][0]
        base = dict(grant_type="authorization_code", code=code, redirect_uri=CALLBACK, client_id=reg["client_id"])
        r, out = self.token(**base, code_verifier="x" * 50)
        self.assertEqual(out["error"], "invalid_grant")                                  # PKCE 가 틀리면 code 도 끝난다
        r, out = self.token(**base, code_verifier=verifier)
        self.assertEqual(out["error"], "invalid_grant")
        verifier, challenge = pkce()
        r, _ = self.consent(self.login(), reg["client_id"], challenge, bundle="skill-dev")
        code = parse_qs(urlsplit(r.getheader("Location")).query)["code"][0]
        r, out = self.token(grant_type="authorization_code", code=code, redirect_uri="http://127.0.0.1:1/other",
                            client_id=reg["client_id"], code_verifier=verifier)
        self.assertEqual(out["error"], "invalid_grant")                                  # redirect_uri 가 다름
        cid, out = self.connect(bundle="skill-dev")
        self.assertEqual((out["token_type"], out["expires_in"]), ("Bearer", 3600))
        self.assertTrue(out["access_token"].startswith("aas_oat_") and out["refresh_token"].startswith("aas_ort_"))
        r, init = self.mcp_init(out["access_token"])
        self.assertEqual(r.status, 200, init)
        sid = r.getheader("Mcp-Session-Id")
        r, lst = self.req("POST", "/mcp", json.dumps({"jsonrpc": "2.0", "id": 2, "method": "tools/list"}),
                          {"Authorization": f"Bearer {out['access_token']}", "Mcp-Session-Id": sid})
        names = {t["name"] for t in lst["result"]["tools"]}
        self.assertIn("skill_upload", names)
        self.assertNotIn("command_run", names)                                           # 「스킬 개발용」 묶음
        from aas.auth import tokens
        row = next(t for t in tokens.list_for(ALICE) if t["kind"] == "oauth" and t["bundle"] == "skill-dev")
        self.assertEqual(row["name"], "claude-code")                                     # 화면의 연결 한 줄
        self.assertGreater(row["expires"], time.time() + 29 * 86400)

    def test_refresh_바꾸기_유예_재사용(self):
        from aas.auth import oauth_connect, tokens
        cid, first = self.connect()
        r, second = self.token(grant_type="refresh_token", refresh_token=first["refresh_token"], client_id=cid)
        self.assertEqual(r.status, 200, second)
        self.assertNotEqual(second["refresh_token"], first["refresh_token"])
        self.assertEqual(self.mcp_init(first["access_token"])[0].status, 401)            # 옛 접근 토큰은 바로 끝난다
        self.assertEqual(self.mcp_init(second["access_token"])[0].status, 200)
        r, again = self.token(grant_type="refresh_token", refresh_token=first["refresh_token"], client_id=cid)
        self.assertEqual(again, second)                                                  # 30초 안의 직전 refresh — 같은 새 쌍(F10)
        fam = tokens.lookup(second["access_token"])["family"]
        with tokens._conn() as conn:
            conn.execute("UPDATE oauth_refresh SET prev_until=? WHERE family=?", (time.time() - 1, fam))
        r, out = self.token(grant_type="refresh_token", refresh_token=first["refresh_token"], client_id=cid)
        self.assertEqual(out["error"], "invalid_grant")                                  # 유예 뒤 재사용 — 연결을 끊는다
        r, out = self.mcp_init(second["access_token"])
        self.assertEqual((r.status, out["reason"]), (401, "revoked"))
        r, out = self.token(grant_type="refresh_token", refresh_token=second["refresh_token"], client_id=cid)
        self.assertEqual(out["error"], "invalid_grant")
        r, out = self.token(grant_type="password")
        self.assertEqual(out["error"], "unsupported_grant_type")
        self.assertEqual(oauth_connect.REFRESH_GRACE, 30.0)

    def test_접근_토큰은_1시간(self):
        from aas.auth import tokens
        cid, out = self.connect()
        fam = tokens.lookup(out["access_token"])["family"]
        with tokens._conn() as conn:
            conn.execute("UPDATE oauth_refresh SET access_expires=? WHERE family=?", (time.time() - 1, fam))
        r, body = self.mcp_init(out["access_token"])
        self.assertEqual((r.status, body["reason"]), (401, "expired"))                 # Claude Code 가 refresh 한다
        r, new = self.token(grant_type="refresh_token", refresh_token=out["refresh_token"], client_id=cid)
        self.assertEqual(self.mcp_init(new["access_token"])[0].status, 200)

    def test_끊은_연결과_빠진_사람(self):
        from aas.auth import tokens
        cid, out = self.connect()
        row = tokens.lookup(out["access_token"])
        tokens.revoke(row["id"], ALICE)                                                  # 화면에서 「연결 끊기」
        r, body = self.token(grant_type="refresh_token", refresh_token=out["refresh_token"], client_id=cid)
        self.assertEqual(body["error"], "invalid_grant")
        cid, out = self.connect()
        with mock.patch.object(self.mcp, "member", lambda email: False):
            r, body = self.token(grant_type="refresh_token", refresh_token=out["refresh_token"], client_id=cid)
        self.assertEqual(body["error"], "invalid_grant")
        self.assertEqual(tokens.lookup_state(out["access_token"])[0], "revoked")
        with mock.patch.object(self.mcp, "member", lambda email: None):
            cid, out = self.connect()
            r, body = self.token(grant_type="refresh_token", refresh_token=out["refresh_token"], client_id=cid)
        self.assertEqual((r.status, body["error"]), (503, "temporarily_unavailable"))

    def test_로그인을_끈_설치에는_없다(self):
        from aas.auth import auth
        off = auth.Auth({"issuer": "", "client_id": "", "client_secret": "", "domain": "", "public_url": "", "hours": 1,
                         "users_file": Path(TMP.name) / "none.json"})
        with mock.patch.object(self.server, "_auth", off):
            for method, path in (("GET", "/.well-known/oauth-protected-resource"), ("GET", "/.well-known/oauth-authorization-server"),
                                 ("POST", "/mcp/oauth/register"), ("POST", "/mcp/oauth/token"), ("GET", "/oauth/connect/authorize")):
                with self.subTest(path=path):
                    self.assertEqual(self.req(method, path, "" if method == "POST" else None)[0].status, 404)

    def test_로그인_화면은_동의_화면에서_오면_같은_창으로(self):
        from aas.auth import auth                         # 비밀번호·SSO 를 함께 켠 설치 — 카드는 보이되 SSO 는 같은 창(재검토 F6)
        both = auth.Auth({"issuer": "https://kc.example/realms/x", "client_id": "c", "client_secret": "s", "domain": "",
                          "public_url": f"http://127.0.0.1:{self.port}", "hours": 1, "users_file": self.users})
        with mock.patch.object(self.server, "_auth", both):
            r, page = self.req("GET", "/auth/login?next=" + quote("/oauth/connect/authorize?client_id=x", safe=""))
            self.assertIn("id=sso", page)
            self.assertNotIn("window.open", page)
            r, page = self.req("GET", "/auth/login?next=/")
            self.assertIn("window.open", page)                                           # 그 밖의 로그인은 지금처럼 팝업


if __name__ == "__main__":
    unittest.main()

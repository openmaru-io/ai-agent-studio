# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""내부 사용자 값(principal) 도입의 회귀 계약(스펙 2026-10-28-001 R7·D8, OMAI-1513).

지킬 동작: ①쿠키 요청의 사용자·POD 그대로 ②어떤 헤더로도 내부 값이 생기지 않음 ③내부 값 없는 POST 는 X-AAS·Origin 검사
④쿠키 사용자의 is_admin 그대로 ⑤Starlette 경로의 쿠키 인증 그대로.
의도한 변경: 내부 값 요청만 _same_origin 통과, 토큰 사용자 is_admin 거짓, 고른 POD 가 볼 수 없으면 POD 없음(F1), 기록에 via=token(F8).
"""
import aasserver  # 실제 uvicorn 앱을 띄우는 시험 하네스(OMAI-1100)
import http.client
import json
import os
import tempfile
import unittest
from pathlib import Path

TMP = tempfile.TemporaryDirectory()
os.environ.setdefault("AAS_DATA_DIR", str(Path(TMP.name) / "data"))

ALICE, BOSS = "pr-alice@corp.example", "pr-boss@corp.example"
PASSWORD = "correct horse battery"


class PrincipalContractTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        from aas.auth import auth
        from aas.fleet import pods
        from aas.web import server
        root = Path(TMP.name)
        cls.users = root / "pr-users.json"
        for e in (ALICE, BOSS):
            auth.save_user(e, PASSWORD, cls.users)
        for name in ("pr_home_a", "pr_home_b"):
            (root / name / "profiles" / ("p_" + name)).mkdir(parents=True, exist_ok=True)
        reg = root / "pr-pods.json"
        reg.write_text(json.dumps({"admins": [BOSS], "pods": [
            {"id": "pr-a", "owner": ALICE, "hermes_home": str(root / "pr_home_a")},
            {"id": "pr-b", "owner": ALICE, "hermes_home": str(root / "pr_home_b")},
            {"id": "pr-c", "owner": BOSS, "hermes_home": str(root / "pr_home_a")}]}))
        cls.app = aasserver.start()
        cls.port = cls.app.server_port
        cls.saved = (server._auth, server._registry)
        server._auth = auth.Auth({"issuer": "", "client_id": "", "client_secret": "", "domain": "",
                                  "public_url": f"http://127.0.0.1:{cls.port}", "hours": 1, "users_file": cls.users})
        server._registry = pods.Registry(reg)
        cls.server = server

    @classmethod
    def tearDownClass(cls):
        cls.app.shutdown()
        cls.server._auth, cls.server._registry = cls.saved
        from aas.auth import tokens
        with tokens._conn() as conn:
            for e in (ALICE, BOSS):
                conn.execute("DELETE FROM personal_tokens WHERE user_email=?", (e,))

    def req(self, method, path, cookie="", body=None, headers=None):
        c = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        h = {"Cookie": cookie} if cookie else {}
        h.update(headers or {})
        c.request(method, path, body=json.dumps(body) if body is not None else None, headers=h)
        r = c.getresponse()
        data = r.read()
        return r, (json.loads(data) if data[:1] in (b"{", b"[") else data)

    def login(self, email):
        c = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        c.request("POST", "/auth/password", body=f"email={email}&password=correct+horse+battery&next=/",
                  headers={"Content-Type": "application/x-www-form-urlencoded"})
        r = c.getresponse(); r.read()
        self.assertEqual(r.status, 302)
        return r.getheader("Set-Cookie").split(";")[0]

    def token_user(self, email):
        return {"email": email, "name": "N", "sub": "sub-" + email, "admin": False, "via": "token"}

    def dispatch(self, method, target, email, pod="", body=b""):
        from aas.web import legacy
        hdrs = [(b"host", f"127.0.0.1:{self.port}".encode())]
        status, headers, out = legacy.dispatch(method, target, {"user": self.token_user(email), "pod": pod}, hdrs,
                                               ("127.0.0.1", 50000), False, body)
        return status, (json.loads(out) if out[:1] in (b"{", b"[") else out)

    # ---- 지킬 동작 -------------------------------------------------------------------------------
    def test_1_쿠키_요청의_사용자와_POD_그대로(self):
        cookie = self.login(ALICE)
        r, me = self.req("GET", "/api/me", cookie)
        self.assertEqual((r.status, me["user"]["email"], me["admin"]), (200, ALICE, False))
        self.assertIn(me["pod"]["id"], ("pr-a", "pr-b"))
        r, me = self.req("GET", "/api/me", cookie + "; aas_pod=pr-b")
        self.assertEqual(me["pod"]["id"], "pr-b")
        r, me = self.req("GET", "/api/me", cookie + "; aas_pod=pr-c")           # 볼 수 없는 POD 쿠키는 내 것으로(지금 동작)
        self.assertIn(me["pod"]["id"], ("pr-a", "pr-b"))

    def test_2_어떤_헤더로도_내부_값이_생기지_않는다(self):
        spoof = json.dumps({"user": {"email": BOSS, "admin": True}, "pod": "pr-c"})
        for name in ("X-AAS-Principal", "aas.principal", "X-Forwarded-User", "X-Remote-User", "Authorization"):
            with self.subTest(header=name):
                value = "Bearer x" if name == "Authorization" else spoof
                r, _ = self.req("GET", "/api/me", headers={name: value})
                self.assertEqual(r.status, 401)
                r, _ = self.req("POST", "/api/tokens/create", body={"name": "n", "bundle": "read", "days": 30},
                                headers={name: value, "X-AAS": "1"})
                self.assertEqual(r.status, 401)

    def test_3_내부_값_없는_POST_는_X_AAS_와_Origin_을_본다(self):
        cookie = self.login(ALICE)
        body = {"name": "n", "bundle": "read", "days": 30}
        self.assertEqual(self.req("POST", "/api/tokens/create", cookie, body)[0].status, 403)                     # X-AAS 없음
        self.assertEqual(self.req("POST", "/api/tokens/create", cookie, body,
                                  {"X-AAS": "1", "Origin": "http://evil.example"})[0].status, 403)            # 다른 출처
        r, made = self.req("POST", "/api/tokens/create", cookie, body, {"X-AAS": "1"})
        self.assertEqual(r.status, 200)
        from aas.auth import tokens
        tokens.revoke(made["token"]["id"], ALICE)

    def test_4_쿠키_사용자의_관리자_판정_그대로(self):
        reg = self.server.registry()
        self.assertTrue(reg.is_admin({"email": BOSS, "admin": False}))       # 등록부 admins
        self.assertTrue(reg.is_admin({"email": ALICE, "admin": True}))        # 세션의 관리자 표시
        self.assertFalse(reg.is_admin({"email": ALICE, "admin": False}))
        r, me = self.req("GET", "/api/me", self.login(BOSS))
        self.assertTrue(me["admin"])

    def test_5_Starlette_경로의_쿠키_인증_그대로(self):
        r, out = self.req("GET", "/api/chat/files/list?pod=pr-a")
        self.assertEqual((r.status, out.get("code")), (401, "login"))
        r, out = self.req("PUT", "/api/chat/files?pod=pr-a&name=x.txt", self.login(ALICE), headers={"Content-Type": "text/plain"})
        self.assertEqual((r.status, out.get("code")), (403, "forbidden"))     # X-AAS 없는 쓰기
        r, out = self.req("GET", "/api/profile/credential-files?pod=pr-a")
        self.assertEqual(r.status, 401)

    # ---- 의도한 변경 -----------------------------------------------------------------------------
    def test_토큰_사용자는_관리자가_아니다(self):
        reg = self.server.registry()
        self.assertFalse(reg.is_admin(self.token_user(BOSS)))
        self.assertFalse(reg.is_admin({**self.token_user(BOSS), "admin": True}))
        status, me = self.dispatch("GET", "/api/me", BOSS, "pr-c")
        self.assertEqual((status, me["user"]["email"], me["admin"]), (200, BOSS, False))
        status, out = self.dispatch("GET", "/api/users", BOSS, "pr-c")          # 관리자 화면 API 는 거절
        self.assertEqual(status, 403)

    def test_내부_값_요청은_X_AAS_없이_통과하고_기록에_via_token(self):
        from aas.auth import tokens
        from aas.common import store
        status, made = self.dispatch("POST", "/api/tokens/create", ALICE, "pr-a",
                                     json.dumps({"name": "via", "bundle": "read", "days": 30}).encode())
        self.assertEqual(status, 200)
        with store.connect() as conn:
            note = conn.execute("SELECT note FROM usage WHERE kind='pat_create' AND note LIKE ? ORDER BY ts DESC",
                                (f"%{made['token']['id']}%",)).fetchone()["note"]
        self.assertTrue(note.endswith(" via=token"))
        tokens.revoke(made["token"]["id"], ALICE)

    def test_변경_기록은_자격과_토큰을_함께_읽는다(self):
        """log_usage 는 role= 뒤에 via= 를 붙인다 — 읽을 때 via 를 먼저 떼야 자격 표시가 살아 있다(스펙 2026-10-28-001 §3-7 ⑦)."""
        from aas.common import store
        from aas.ops import changes
        a, b = store.actor_role.set("team"), store.actor_via.set("token")
        try:
            store.log_usage("skill_save", f"{ALICE} profiles/main/skills/pr-via/SKILL.md", pod="pr-a")
        finally:
            store.actor_role.reset(a)
            store.actor_via.reset(b)
        row = next(r for r in changes.rows(pod="pr-a") if r["detail"].endswith("pr-via/SKILL.md"))
        self.assertEqual((row["who"], row.get("via"), row.get("by_team_manager")), (ALICE, "token", True))
        self.assertEqual(row["detail"], "profiles/main/skills/pr-via/SKILL.md")

    def test_고른_POD_를_쓰고_볼_수_없으면_POD_없음(self):
        self.assertEqual(self.dispatch("GET", "/api/me", ALICE, "pr-b")[1]["pod"]["id"], "pr-b")
        self.assertEqual(self.dispatch("GET", "/api/me", ALICE, "pr-a")[1]["pod"]["id"], "pr-a")
        self.assertIsNone(self.dispatch("GET", "/api/me", ALICE, "pr-c")[1]["pod"])       # 남의 POD

    def test_dispatch_는_쿠키와_Authorization_을_옮기지_않는다(self):
        from aas.web import legacy
        cookie = self.login(BOSS)
        hdrs = [(b"host", f"127.0.0.1:{self.port}".encode()), (b"cookie", cookie.encode()), (b"authorization", b"Bearer x"),
                (b"x-aas", b"1")]
        status, _, out = legacy.dispatch("GET", "/api/me", {"user": self.token_user(ALICE), "pod": ""}, hdrs, ("127.0.0.1", 1), False)
        me = json.loads(out)
        self.assertEqual((me["user"]["email"], me["admin"]), (ALICE, False))  # 쿠키의 BOSS 가 아니다
        with self.assertRaises(ValueError):
            legacy.dispatch("GET", "/api/me", {}, hdrs, ("127.0.0.1", 1), False)

    def test_Starlette_경로도_내부_값을_읽는다(self):
        from starlette.requests import Request
        from aas.web import files, server
        scope = {"type": "http", "method": "PUT", "path": "/api/chat/files", "query_string": b"pod=pr-c",
                 "headers": [(b"host", f"127.0.0.1:{self.port}".encode())], "client": ("127.0.0.1", 1), "scheme": "http",
                 server.PRINCIPAL_KEY: {"user": self.token_user(ALICE), "pod": "pr-c"}}
        with self.assertRaises(files._Denied) as cm:                        # X-AAS 없이도 출처 검사는 통과, 남의 POD 라 403 pod
            files._context(Request(scope), write=True)
        self.assertEqual((cm.exception.code, cm.exception.status), ("pod", 403))
        no_principal = {k: v for k, v in scope.items() if k != server.PRINCIPAL_KEY}
        with self.assertRaises(files._Denied) as cm:
            files._context(Request(no_principal), write=True)
        self.assertEqual((cm.exception.code, cm.exception.status), ("forbidden", 403))


if __name__ == "__main__":
    unittest.main()

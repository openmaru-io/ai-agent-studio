# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""내 정보·본인 비밀번호 변경(스펙 2026-10-14-017). 실제 서버를 띄우고 세션을 직접 만들어 쿠키로 보낸다.
Keycloak 은 가짜(KeycloakAdmin 의 같은 이름 함수)로 바꿔 끼워 호출 인자를 본다. 이 모듈의 시험은 세션 표를 시험마다 비운다."""
import aasserver  # 실제 uvicorn 앱을 띄우는 시험 하네스(OMAI-1100)
import http.client
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

TMP = tempfile.TemporaryDirectory()
os.environ["AAS_DATA_DIR"] = str(Path(TMP.name) / "data")      # 다른 서버 시험(test_auth 등)과 같은 방식. 끝에 지우지 않는다 — 뒤에 도는 시험이 같은 환경변수를 쓴다


class FakeKC:
    """KeycloakAdmin 대역. 비밀번호는 users[username] 에 둔다. 호출을 calls 에 적는다(비밀번호 값은 적지 않는다)."""

    def __init__(self):
        self.users = {"sub-alice": {"username": "alice", "password": "old-password-1"}, "sub-bob": {"username": "bob", "password": "bob-password-1"}}
        self.calls, self.verify_error, self.reset_error = [], None, None

    def token(self):
        self.calls.append(("token",))
        return "tok"

    def get_user(self, uid, token=None):
        self.calls.append(("get_user", uid))
        return {"id": uid, "username": self.users[uid]["username"]}

    def verify_password(self, username, password):
        self.calls.append(("verify", username))
        if self.verify_error:
            raise self.verify_error
        return any(u["username"] == username and u["password"] == password for u in self.users.values())

    def reset_password(self, uid, password, token=None, temporary=True):
        self.calls.append(("reset", uid, temporary))
        if self.reset_error:
            raise self.reset_error
        self.users[uid]["password"] = password


class AccountTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        from aas.auth import auth
        from aas.fleet import pods
        from aas.web import server
        root = Path(TMP.name)
        (root / "home_a" / "profiles" / "p").mkdir(parents=True)
        reg = root / "pods.json"
        reg.write_text(json.dumps({"admins": [], "pods": [{"id": "a", "owner": "alice@corp.example", "hermes_home": str(root / "home_a")}]}))
        cls.users_file = root / "users.json"
        auth.save_user("local@corp.example", "local-password-1", cls.users_file)
        cls.app = aasserver.start()
        cls.port = cls.app.server_port
        cls.old = (server._auth, server._registry)
        server._auth = auth.Auth({"issuer": "http://127.0.0.1:1/realms/aas", "client_id": "cid", "client_secret": "sec", "domain": "corp.example",
                                  "public_url": f"http://127.0.0.1:{cls.port}", "hours": 1, "users_file": cls.users_file})
        server._registry = pods.Registry(reg)
        cls.server, cls.auth = server, server._auth

    @classmethod
    def tearDownClass(cls):
        cls.app.shutdown()
        cls.server._auth, cls.server._registry = cls.old

    def setUp(self):
        self.kc = FakeKC()
        p = mock.patch.object(self.server, "_kc_admin", lambda: self.kc)
        p.start()
        self.addCleanup(p.stop)
        self.auth._tries.clear()
        from aas.common import store
        with store.connect() as conn:                       # 앞 시험이 만든 세션이 「다른 세션」 수에 섞이지 않게
            conn.execute("DELETE FROM auth_sessions")

    def session(self, email, sub=""):
        return f"aas_session={self.auth._new_session(email, 'N', sub)}"

    def post(self, path, cookie, body):
        c = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        c.request("POST", path, body=json.dumps(body), headers={"Cookie": cookie, "X-AAS": "1", "Content-Type": "application/json"})
        r = c.getresponse()
        return r.status, json.loads(r.read() or b"{}")

    def me(self, cookie):
        c = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        c.request("GET", "/api/me", headers={"Cookie": cookie})
        return json.loads(c.getresponse().read())

    def test_me_tells_whether_the_connection_is_encrypted(self):
        """자격증명 서랍이 입력 가능 여부를 서버와 같은 판단으로 안다(스펙 2026-10-14-025 D5). 이 맥(127.0.0.1)은 안전, 사내 IP 의 http 는 아니다."""
        cookie = self.session("alice@corp.example", "sub-alice")
        self.assertIs(self.me(cookie)["secure"], True)
        c = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        c.request("GET", "/api/me", headers={"Cookie": cookie, "Host": "10.0.0.5:17900"})
        self.assertIs(json.loads(c.getresponse().read())["secure"], False)

    def alive(self, cookie):
        c = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        c.request("GET", "/api/me", headers={"Cookie": cookie})
        return json.loads(c.getresponse().read()).get("user") is not None

    # ---- /api/me 의 account ----
    def test_me_tells_where_the_password_lives(self):
        self.assertEqual(self.me(self.session("alice@corp.example", "sub-alice"))["account"], {"method": "keycloak", "can_change_password": True})
        self.assertEqual(self.me(self.session("local@corp.example"))["account"], {"method": "local", "can_change_password": True})
        self.assertEqual(self.me(self.session("nosub@corp.example"))["account"], {"method": "none", "can_change_password": False})

    # ---- Keycloak ----
    def test_keycloak_change_verifies_then_resets_and_ends_only_other_sessions(self):
        mine, other, someone = self.session("alice@corp.example", "sub-alice"), self.session("alice@corp.example", "sub-alice"), self.session("bob@corp.example", "sub-bob")
        code, out = self.post("/api/users/me/password", mine, {"current": "old-password-1", "new": "brand-new-pass"})
        self.assertEqual((code, out), (200, {"ok": True, "other_sessions_ended": 1}))
        self.assertEqual([c for c in self.kc.calls if c[0] in ("verify", "reset")], [("verify", "alice"), ("reset", "sub-alice", False)])  # 임시 아님
        self.assertEqual(self.kc.users["sub-alice"]["password"], "brand-new-pass")
        self.assertTrue(self.alive(mine))
        self.assertFalse(self.alive(other))                 # 다른 기기의 세션은 끝남
        self.assertTrue(self.alive(someone))                # 다른 사람은 그대로

    def test_only_me_can_be_changed_even_if_the_body_names_someone_else(self):
        code, _ = self.post("/api/users/me/password", self.session("alice@corp.example", "sub-alice"),
                            {"current": "old-password-1", "new": "brand-new-pass", "email": "bob@corp.example", "id": "sub-bob", "sub": "sub-bob"})
        self.assertEqual(code, 200)
        self.assertEqual(self.kc.users["sub-bob"]["password"], "bob-password-1")
        self.assertNotIn(("reset", "sub-bob", False), self.kc.calls)

    def test_wrong_current_password_is_403_not_401_with_one_sentence_and_changes_nothing(self):  # 401 이면 화면이 로그인 화면으로 보낸다
        cookie = self.session("alice@corp.example", "sub-alice")
        code, out = self.post("/api/users/me/password", cookie, {"current": "nope-nope-nope", "new": "brand-new-pass"})
        self.assertEqual((code, out["field"], out["reason"]), (403, "current", "wrong_password"))
        self.assertEqual(self.kc.users["sub-alice"]["password"], "old-password-1")
        self.assertFalse([c for c in self.kc.calls if c[0] == "reset"])
        self.assertNotIn("nope", json.dumps(out))

    def test_input_checks_come_before_keycloak(self):
        cookie = self.session("alice@corp.example", "sub-alice")
        for body, field in (({"current": "", "new": "brand-new-pass"}, "current"), ({"current": "old-password-1", "new": "short"}, "new"),
                            ({"current": "old-password-1", "new": "old-password-1"}, "new")):
            code, out = self.post("/api/users/me/password", cookie, body)
            self.assertEqual((code, out["field"]), (400, field), body)
        self.assertEqual(self.kc.calls, [])

    def test_password_policy_rejection_from_keycloak_points_at_the_new_field(self):
        from aas.auth import keycloak
        self.kc.reset_error = keycloak.KeycloakError("거절", 400, "Invalid password: must not be equal to the username.")
        code, out = self.post("/api/users/me/password", self.session("alice@corp.example", "sub-alice"), {"current": "old-password-1", "new": "alice-alice-1"})
        self.assertEqual((code, out["field"]), (400, "new"))
        self.assertIn("must not be equal", out["error"])

    def test_six_attempts_in_five_minutes_are_429_and_success_resets_the_count(self):
        cookie = self.session("alice@corp.example", "sub-alice")
        for _ in range(5):
            self.assertEqual(self.post("/api/users/me/password", cookie, {"current": "wrong-wrong-1", "new": "brand-new-pass"})[0], 403)
        code, out = self.post("/api/users/me/password", cookie, {"current": "old-password-1", "new": "brand-new-pass"})
        self.assertEqual((code, out["reason"]), (429, "too_many"))
        self.auth._tries.clear()
        self.assertEqual(self.post("/api/users/me/password", cookie, {"current": "old-password-1", "new": "brand-new-pass"})[0], 200)
        self.assertNotIn("pw:alice@corp.example", self.auth._tries)

    def test_keycloak_unreachable_and_direct_access_off_are_reported_apart(self):
        from aas.auth import keycloak
        cookie = self.session("alice@corp.example", "sub-alice")
        self.kc.verify_error = keycloak.KeycloakError("연결 못함", 0)
        self.assertEqual(self.post("/api/users/me/password", cookie, {"current": "old-password-1", "new": "brand-new-pass"})[1]["reason"], "unreachable")
        self.kc.verify_error = keycloak.KeycloakError("거절", 400, "Client not allowed for direct access grants")
        code, out = self.post("/api/users/me/password", cookie, {"current": "old-password-1", "new": "brand-new-pass"})
        self.assertEqual((code, out["reason"]), (501, "config"))

    # ---- 로컬 사용자 파일 ----
    def test_local_user_file_is_verified_and_rewritten(self):
        from aas.auth import auth
        cookie = self.session("local@corp.example")
        code, out = self.post("/api/users/me/password", cookie, {"current": "wrong-wrong-1", "new": "brand-new-pass"})
        self.assertEqual(code, 403)
        self.assertEqual(self.post("/api/users/me/password", cookie, {"current": "local-password-1", "new": "brand-new-pass"})[0], 200)
        users = auth.load_users(self.users_file)
        self.assertTrue(auth.verify_password("brand-new-pass", users["local@corp.example"]))
        self.assertFalse(auth.verify_password("local-password-1", users["local@corp.example"]))
        self.assertEqual(self.kc.calls, [])                 # 로컬 방식은 Keycloak 을 부르지 않는다
        auth.save_user("local@corp.example", "local-password-1", self.users_file)

    def test_unsupported_method_is_501_and_login_is_required(self):
        code, out = self.post("/api/users/me/password", self.session("nosub@corp.example"), {"current": "x" * 9, "new": "y" * 9})
        self.assertEqual((code, out["reason"]), (501, "unsupported"))
        self.assertEqual(self.post("/api/users/me/password", "", {"current": "x", "new": "y"})[0], 401)

    # ---- 기록 ----
    def test_audit_logs_only_who_never_the_password(self):
        from aas.common import store
        self.post("/api/users/me/password", self.session("alice@corp.example", "sub-alice"), {"current": "old-password-1", "new": "brand-new-pass"})
        with store.connect() as conn:
            rows = [dict(r) for r in conn.execute("SELECT kind, note FROM usage WHERE kind='password_self'")]
        self.assertEqual(rows, [{"kind": "password_self", "note": "alice@corp.example"}])
        with store.connect() as conn:
            dump = json.dumps([dict(r) for r in conn.execute("SELECT * FROM usage")])
        self.assertNotIn("brand-new-pass", dump)
        self.assertNotIn("old-password-1", dump)


class VerifyPasswordTest(unittest.TestCase):
    """KeycloakAdmin.verify_password: 맞으면 참, 틀리면 거짓, 그 밖의 거절은 오류. 비밀번호가 오류 문장에 없다."""

    def kc(self):
        from aas.auth import keycloak
        return keycloak.KeycloakAdmin("https://kc.example/realms/aas", "aas-admin", "secret", "aas-users", "aas-admin")

    def run_with(self, result):
        from aas.auth import keycloak
        sent = []

        def fake_open(req):
            sent.append(req)
            if isinstance(result, Exception):
                raise result
            return result
        with mock.patch.object(keycloak.KeycloakAdmin, "_open", lambda self, req: fake_open(req)):
            try:
                return self.kc().verify_password("alice", "pw-secret-1"), sent
            except keycloak.KeycloakError as exc:
                return exc, sent

    def test_success_false_and_other_errors(self):
        from aas.auth import keycloak
        ok, sent = self.run_with({"access_token": "t"})
        self.assertIs(ok, True)
        body = sent[0].data.decode()
        self.assertIn("grant_type=password", body)
        self.assertIn("client_id=aas-admin", body)
        self.assertTrue(sent[0].full_url.endswith("/realms/aas/protocol/openid-connect/token"))
        self.assertIs(self.run_with(keycloak.KeycloakError("거절", 401, "Invalid user credentials"))[0], False)
        self.assertIs(self.run_with(keycloak.KeycloakError("거절", 400, "Account disabled"))[0], False)
        err = self.run_with(keycloak.KeycloakError("거절", 400, "Client not allowed for direct access grants"))[0]
        self.assertIsInstance(err, keycloak.KeycloakError)
        self.assertNotIn("pw-secret-1", str(err))
        self.assertIsInstance(self.run_with(keycloak.KeycloakError("연결", 0))[0], keycloak.KeycloakError)

    def test_reset_password_is_temporary_by_default_and_not_when_asked(self):
        from aas.auth import keycloak
        sent = []
        with mock.patch.object(keycloak.KeycloakAdmin, "_request", lambda self, tok, method, path, body=None, **q: sent.append((method, path, body))):
            self.kc().reset_password("u1", "pw-1", "tok")
            self.kc().reset_password("u1", "pw-2", "tok", temporary=False)
        self.assertEqual([s[2]["temporary"] for s in sent], [True, False])


if __name__ == "__main__":
    unittest.main()

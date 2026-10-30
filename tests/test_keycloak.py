"""Keycloak SSO 시험(M2-4) — 신원 키 sub, 그룹·역할 claim, 첫 로그인 등록, 옛 DB 이전.

가짜 OIDC 공급자는 실제 Keycloak 이 주는 claim 모양(realm_access.roles, groups 경로)을 흉내 낸다.
실제 Keycloak 컨테이너로 확인하는 절차는 deploy/compose/README.md 에 있다.
"""
import base64
import json
import os
import sqlite3
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest import mock
from urllib.parse import parse_qs, urlsplit

TMP = tempfile.TemporaryDirectory()
os.environ["AAS_DATA_DIR"] = str(Path(TMP.name) / "data")

from aas.fleet import agents, pods
from aas.auth import auth, keycloak
from aas.common import store  # noqa: E402


def b64(obj) -> str:
    return base64.urlsafe_b64encode(json.dumps(obj).encode()).rstrip(b"=").decode()


class FakeKeycloak(BaseHTTPRequestHandler):
    claims: dict = {}
    access: dict | None = None

    def do_GET(self):
        base = f"http://127.0.0.1:{self.server.server_port}"
        body = json.dumps({"issuer": base, "authorization_endpoint": base + "/auth",
                           "token_endpoint": base + "/token"}).encode()
        self.send_response(200); self.send_header("Content-Length", str(len(body))); self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        self.rfile.read(int(self.headers["Content-Length"]))
        tokens = {"id_token": f"{b64({'alg': 'none'})}.{b64(FakeKeycloak.claims)}.x"}
        if FakeKeycloak.access is not None:
            tokens["access_token"] = f"{b64({'alg': 'none'})}.{b64(FakeKeycloak.access)}.x"
        body = json.dumps(tokens).encode()
        self.send_response(200); self.send_header("Content-Length", str(len(body))); self.end_headers()
        self.wfile.write(body)

    def log_message(self, *a):
        pass


class KeycloakLoginTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.idp = ThreadingHTTPServer(("127.0.0.1", 0), FakeKeycloak)
        threading.Thread(target=cls.idp.serve_forever, daemon=True).start()
        cls.issuer = f"http://127.0.0.1:{cls.idp.server_port}"

    @classmethod
    def tearDownClass(cls):
        cls.idp.shutdown()

    def make(self, **over) -> auth.Auth:
        cfg = {"issuer": self.issuer, "client_id": "aas", "client_secret": "sec", "domain": "",
               "users_group": "aas-users", "admin_role": "aas-admin", "groups_claim": "groups",
               "public_url": "http://127.0.0.1:17900", "hours": 1, **over}
        return auth.Auth(cfg)

    def login(self, a: auth.Auth, **claims) -> str:
        q = parse_qs(urlsplit(a.begin("/")).query)
        FakeKeycloak.claims = {"iss": self.issuer, "aud": "aas", "exp": time.time() + 300, "nonce": q["nonce"][0],
                               "sub": "11111111-aaaa", "email": "kim@example.com", "email_verified": True,
                               "name": "김", **claims}
        token, _ = a.finish("code", q["state"][0])
        return token

    def test_group_member_logs_in_with_sub(self):
        a = self.make()
        token = self.login(a, groups=["/aas-users"])
        me = a.user(f"{auth.COOKIE}={token}")
        self.assertEqual((me["sub"], me["email"], me["admin"]), ("11111111-aaaa", "kim@example.com", False))

    def test_user_outside_group_is_rejected(self):
        a = self.make()
        for claims in ({}, {"groups": ["/other"]}, {"groups": "other"}):
            with self.assertRaises(auth.AuthError, msg=str(claims)):
                self.login(a, **claims)

    def test_admin_role_grants_admin_even_without_group(self):
        a = self.make()
        for claims in ({"realm_access": {"roles": ["aas-admin"]}},
                       {"resource_access": {"aas": {"roles": ["aas-admin"]}}}):
            me = a.user(f"{auth.COOKIE}={self.login(a, **claims)}")
            self.assertTrue(me["admin"], claims)

    def test_role_and_group_are_read_on_every_login(self):
        a = self.make()
        first = a.user(f"{auth.COOKIE}={self.login(a, groups=['aas-users'], realm_access={'roles': ['aas-admin']})}")
        second = a.user(f"{auth.COOKIE}={self.login(a, groups=['aas-users'])}")      # 역할을 뺏긴 뒤 다시 로그인
        self.assertEqual((first["admin"], second["admin"]), (True, False))
        with self.assertRaises(auth.AuthError):                                      # 그룹에서도 빠지면 못 들어온다
            self.login(a)

    def test_empty_group_setting_skips_the_group_check(self):
        a = self.make(users_group="")
        self.assertTrue(a.user(f"{auth.COOKIE}={self.login(a)}")["sub"])

    def test_roles_in_access_token_only_are_read_but_identity_is_not(self):
        a = self.make()
        FakeKeycloak.access = {"realm_access": {"roles": ["aas-admin"]}, "email": "mallory@example.com", "sub": "evil"}
        try:
            me = a.user(f"{auth.COOKIE}={self.login(a)}")                       # id_token 에는 그룹도 역할도 없다
        finally:
            FakeKeycloak.access = None
        self.assertEqual((me["admin"], me["email"], me["sub"]), (True, "kim@example.com", "11111111-aaaa"))

    def test_발견_주소를_내부_주소로_따로_줄_수_있다_발급자는_공개_주소로_검증한다(self):
        """클러스터 안 서버는 Keycloak 의 내부 서비스 주소(http)로 발견·토큰 교환을 하고, 브라우저는 공개 주소를 쓴다. 토큰의 iss 는 공개 주소다."""
        public = "https://aas-sso.example.com/realms/aas"
        a = self.make(issuer=public, discovery_url=self.issuer)                  # 내부 주소 = 가짜 공급자(루프백)
        q = parse_qs(urlsplit(a.begin("/")).query)
        FakeKeycloak.claims = {"iss": public, "aud": "aas", "exp": time.time() + 300, "nonce": q["nonce"][0], "sub": "s1", "email": "kim@example.com",
                               "email_verified": True, "name": "김", "groups": ["aas-users"]}
        token, _ = a.finish("code", q["state"][0])
        self.assertEqual(a.user(f"{auth.COOKIE}={token}")["sub"], "s1")
        # 공개 주소와 다른 iss 는 여전히 거절한다
        q = parse_qs(urlsplit(a.begin("/")).query)
        FakeKeycloak.claims = {**FakeKeycloak.claims, "iss": self.issuer, "nonce": q["nonce"][0]}
        with self.assertRaises(auth.AuthError):
            a.finish("code", q["state"][0])

    def test_내부_발견_주소는_클러스터_안_이름이나_루프백이면_http_를_받고_그_밖은_https_만(self):
        for ok in ("http://aas-keycloak.cogentai-aas.svc:8080/realms/aas", "http://aas-keycloak.cogentai-aas.svc.cluster.local:8080/realms/aas", "http://127.0.0.1:1/realms/aas"):
            a = self.make(issuer="https://aas-sso.example.com/realms/aas", discovery_url=ok)
            a._check_issuer_transport()
        a = self.make(issuer="https://aas-sso.example.com/realms/aas", discovery_url="http://idp.example.com/realms/aas")
        with self.assertRaises(auth.AuthError):
            a._check_issuer_transport()

    def test_설정에서_발견_주소를_읽는다(self):
        with mock.patch.dict(os.environ, {"AAS_OIDC_DISCOVERY_URL": "http://kc.ns.svc:8080/realms/aas/"}), \
                mock.patch.object(auth.config, "get", side_effect=lambda k, d="": os.environ.get(k, d)):
            self.assertEqual(auth.settings()["discovery_url"], "http://kc.ns.svc:8080/realms/aas")

    def test_missing_sub_is_rejected(self):
        a = self.make()
        with self.assertRaises(auth.AuthError):
            self.login(a, sub="", groups=["aas-users"])

    def test_on_login_receives_identity_and_failure_does_not_block(self):
        a = self.make()
        seen = []
        a.on_login = seen.append
        self.login(a, groups=["aas-users"])
        self.assertEqual((seen[0]["sub"], seen[0]["email"], seen[0]["admin"]), ("11111111-aaaa", "kim@example.com", False))
        a.on_login = mock.Mock(side_effect=RuntimeError("quota"))
        token = self.login(a, groups=["aas-users"])
        self.assertIsNotNone(a.user(f"{auth.COOKIE}={token}"))                      # 등록이 실패해도 로그인된다

    def test_no_google_defaults(self):
        with mock.patch.dict(os.environ, {}, clear=False):
            for k in ("AAS_OIDC_ISSUER", "AAS_ALLOWED_DOMAIN", "AAS_K8S_NAMESPACE", "AAS_PASSWORD_LOGIN"):
                os.environ.pop(k, None)
            with mock.patch.object(auth.config, "get", side_effect=lambda k, d="": os.environ.get(k, d)):
                cfg = auth.settings()
        self.assertEqual((cfg["issuer"], cfg["domain"], cfg["users_group"], cfg["admin_role"]), ("", "", "aas-users", "aas-admin"))
        self.assertTrue(cfg["password_login"])

    def test_password_login_is_off_by_default_on_kubernetes(self):
        env = {"AAS_K8S_NAMESPACE": "aas"}
        with mock.patch.dict(os.environ, env), mock.patch.object(auth.config, "get", side_effect=lambda k, d="": os.environ.get(k, d)):
            self.assertFalse(auth.settings()["password_login"])
        with mock.patch.dict(os.environ, {**env, "AAS_PASSWORD_LOGIN": "1"}), \
                mock.patch.object(auth.config, "get", side_effect=lambda k, d="": os.environ.get(k, d)):
            self.assertTrue(auth.settings()["password_login"])
        users = Path(TMP.name) / "users-k8s.json"
        auth.save_user("a@example.com", "pw-pw-pw-pw", users)
        a = self.make(users_file=users, password_login=False)
        self.assertFalse(a.password_enabled)
        self.assertTrue(self.make(users_file=users, password_login=True).password_enabled)

    def test_old_sessions_table_gets_sub_and_admin_columns(self):
        path = Path(TMP.name) / "old" / "aas.db"
        path.parent.mkdir()
        conn = sqlite3.connect(path)
        conn.execute("CREATE TABLE auth_sessions (hash TEXT PRIMARY KEY, email TEXT NOT NULL, name TEXT, created REAL NOT NULL, expires REAL NOT NULL)")
        conn.execute("INSERT INTO auth_sessions VALUES ('h','old@example.com','x',1,9999999999)")
        conn.commit(); conn.close()
        with mock.patch.object(store, "connect", lambda: _conn(path)):
            self.make()
            with store.connect() as c:
                row = c.execute("SELECT email, sub, admin FROM auth_sessions").fetchone()
        self.assertEqual((row["email"], row["sub"], row["admin"]), ("old@example.com", "", 0))


def _conn(path):
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    return conn


class OwnerBySubTest(unittest.TestCase):
    def reg(self, *owners):
        r = pods.Registry.__new__(pods.Registry)
        r.admins, r.error, r.agents = set(), "", []
        r.pods = [pods.Pod(f"p{i}", email, Path("/x"), owner_sub=sub) for i, (email, sub) in enumerate(owners)]
        r.grants = lambda: {}
        return r

    def test_owner_is_matched_by_sub_after_email_change(self):
        r = self.reg(("old@example.com", "sub-1"), ("other@example.com", "sub-2"))
        mine = r.allowed({"email": "new@example.com", "sub": "sub-1", "admin": False}, True)
        self.assertEqual([p.id for p in mine], ["p0"])
        self.assertEqual(r.allowed({"email": "new@example.com", "sub": "", "admin": False}, True), [])   # sub 가 없으면 이메일만

    def test_admin_flag_from_session_counts(self):
        r = self.reg(("a@example.com", "sub-1"), ("b@example.com", "sub-2"))
        user = {"email": "boss@example.com", "sub": "sub-9", "admin": True}
        self.assertTrue(r.is_admin(user))
        self.assertEqual(len(r.allowed(user, True)), 2)
        self.assertFalse(r.is_admin({"email": "boss@example.com", "sub": "sub-9", "admin": False}))


class FirstAgentTest(unittest.TestCase):
    def test_creates_one_when_none_exists_and_skips_when_present(self):
        client = mock.Mock(namespace="aas")
        client.create_agent.side_effect = lambda m: {"metadata": {"name": m["metadata"]["name"]}, "spec": m["spec"]}
        item = agents.ensure_first(client, [], "sub-1", "Kim@Example.com", "김")
        spec = client.create_agent.call_args[0][0]["spec"]
        self.assertEqual((spec["ownerSub"], spec["ownerEmail"], spec["displayName"]), ("sub-1", "kim@example.com", "김의 AI 에이전트 작업공간"))
        self.assertTrue(item)
        client.create_agent.reset_mock()
        agents.ensure_first(client, [], "sub-2", "lee@example.com")                                   # 이름이 없으면 이메일 앞부분
        self.assertEqual(client.create_agent.call_args[0][0]["spec"]["displayName"], "lee의 AI 에이전트 작업공간")
        client.create_agent.reset_mock()
        have = [{"owner": "old@example.com", "owner_sub": "sub-1"}]
        self.assertIsNone(agents.ensure_first(client, have, "sub-1", "kim@example.com"))               # sub 로 이미 있다
        self.assertIsNone(agents.ensure_first(client, [{"owner": "kim@example.com", "owner_sub": ""}], "sub-1", "kim@example.com"))
        client.create_agent.assert_not_called()

    def test_이름이_겹치면_번호를_붙인다(self):
        """스펙 2026-10-21-019: 동명이인의 첫 에이전트는 「… 2」. 겹침은 주인과 상관없이 전체 에이전트로 본다."""
        client = mock.Mock(namespace="aas")
        client.create_agent.side_effect = lambda m: {"metadata": {"name": m["metadata"]["name"]}, "spec": m["spec"]}
        others = [{"owner": "kim1@example.com", "owner_sub": "s1", "display_name": "김의 AI 에이전트 작업공간"},
                  {"owner": "kim2@example.com", "owner_sub": "s2", "display_name": "김의 AI 에이전트 작업공간 2"}]
        agents.ensure_first(client, others, "sub-3", "kim3@example.com", "김")
        self.assertEqual(client.create_agent.call_args[0][0]["spec"]["displayName"], "김의 AI 에이전트 작업공간 3")
        self.assertEqual(agents.default_name("박", others), "박의 AI 에이전트 작업공간")
        self.assertEqual(agents.default_name("김", others[1:]), "김의 AI 에이전트 작업공간")                    # 빈 번호를 채우지 않고 이름 그대로가 비면 그것


class KeycloakAdminWriteTest(unittest.TestCase):
    """「사용자·권한」 화면이 쓰는 Keycloak 관리 API(스펙 2026-10-14-011 단계 1). 가짜 Keycloak 이 받은 요청 경로·본문을 확인한다."""

    @classmethod
    def setUpClass(cls):
        import kcfake
        cls.kcfake = kcfake
        cls.httpd, cls.issuer = kcfake.start()

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()

    def setUp(self):
        self.K = self.kcfake.FakeKC
        self.K.reset()
        self.kc = self.kcfake.admin(self.issuer)

    def test_만들기는_이메일_확인됨_임시_비밀번호_그룹_경로를_보내고_Location_의_id_를_돌려준다(self):
        uid = self.kc.create_user("hong", "hong@x.com", "길동", "홍", "개발팀", "pw-12345678", admin=True)
        method, path, body = self.K.calls("POST", r"/admin/realms/aas/users")[0]
        self.assertEqual((body["emailVerified"], body["enabled"], body["credentials"][0]["temporary"]), (True, True, True))
        self.assertEqual(body["groups"], ["/aas-users", "/aas-admins"])
        self.assertEqual(body["attributes"], {"department": ["개발팀"]})
        self.assertEqual(self.K.users[uid]["username"], "hong")
        self.assertEqual(self.K.passwords[uid], ("pw-12345678", True))
        uid2 = self.kc.create_user("lee", "lee@x.com", "순신", "이", "", "pw-12345678")
        self.assertNotIn(uid2, self.K.members["g-admins"])
        self.assertIn(uid2, self.K.members["g-users"])

    def test_중복은_409_와_겹친_칸을_알리는_이유(self):
        self.K.add("u1", "hong", "hong@x.com")
        for username, email, want in (("hong", "new@x.com", "username"), ("new", "HONG@x.com", "email")):
            with self.assertRaises(keycloak.KeycloakError) as cm:
                self.kc.create_user(username, email, "a", "b", "", "pw-12345678")
            self.assertEqual(cm.exception.code, 409)
            self.assertIn(want, cm.exception.detail)

    def test_고치기는_전체_표현을_받아_PUT_해서_department_가_남는다(self):
        self.K.add("u1", "hong", "hong@x.com", attributes={"department": ["개발팀"], "locale": ["ko"]})
        self.kc.update_user("u1", {"firstName": "길순"})
        put = self.K.calls("PUT", r"/admin/realms/aas/users/u1")[0][2]
        self.assertEqual((put["username"], put["email"], put["firstName"]), ("hong", "hong@x.com", "길순"))
        self.assertEqual(self.K.users["u1"]["attributes"], {"department": ["개발팀"], "locale": ["ko"]})
        self.kc.update_user("u1", {"department": ""})
        self.assertEqual(self.K.users["u1"]["attributes"], {"locale": ["ko"]})

    def test_관리자_올리기는_그룹만_내리기는_그룹과_직접_역할을_빼고_사용자_그룹에_넣는다(self):
        self.K.add("u1", "hong", "hong@x.com")
        self.kc.set_admin("u1", True)
        self.assertIn("u1", self.K.members["g-admins"])
        self.assertNotIn("u1", self.K.role_users)                                       # 역할을 직접 주지 않는다
        self.K.role_users.add("u1")
        self.kc.set_admin("u1", False)
        self.assertNotIn("u1", self.K.members["g-admins"])
        self.assertNotIn("u1", self.K.role_users)
        self.assertIn("u1", self.K.members["g-users"])                                  # 사용자 그룹에 없던 관리자도 로그인을 잃지 않는다(O6)

    def test_비밀번호_사용_중지_로그아웃_삭제_접근(self):
        self.K.add("u1", "hong", "hong@x.com", attributes={"department": ["개발팀"]})
        self.kc.reset_password("u1", "new-pass-123")
        self.assertEqual(self.K.passwords["u1"], ("new-pass-123", True))
        self.kc.set_enabled("u1", False)
        self.assertIs(self.K.users["u1"]["enabled"], False)
        self.assertEqual(self.K.users["u1"]["attributes"], {"department": ["개발팀"]})
        self.assertTrue(self.K.calls("POST", r"/admin/realms/aas/users/u1/logout"))   # 사용 중지면 Keycloak 세션도 끝낸다
        self.kc.set_member("u1", True)
        self.assertIn("u1", self.K.members["g-users"])
        self.kc.delete_user("u1")
        self.assertNotIn("u1", self.K.users)
        with self.assertRaises(keycloak.KeycloakError) as cm:
            self.kc.get_user("u1")
        self.assertEqual(cm.exception.code, 404)

    def test_목록은_100명씩_끝까지_읽고_서비스_계정을_뺀다(self):
        for i in range(130):
            self.K.add(f"u{i:03}", f"user{i:03}", f"user{i:03}@x.com", groups=["g-users"])
        self.K.add("sa", "service-account-aas-admin", "", serviceAccountClientId="aas-admin")
        self.K.add("sa2", "robot", "", serviceAccountClientId="other")
        users = self.kc.list_users()
        self.assertEqual(len(users), 130)
        self.assertEqual(len(self.K.calls("GET", r"/admin/realms/aas/users")), 2)
        d = self.kc.directory()
        self.assertEqual((len(d["users"]), len(d["members"])), (130, 130))

    def test_구성원과_관리자는_사용_중지한_사람을_빼고_관리자는_직접과_그룹을_함께_센다(self):
        self.K.add("u1", "a", "a@x.com", groups=["g-users"])
        self.K.add("off", "off", "off@x.com", groups=["g-users"], enabled=False)
        self.K.add("boss", "boss", "boss@x.com", direct_admin=True)
        self.K.add("kim", "kim", "kim@x.com", groups=["g-admins"])
        self.K.add("offadmin", "oa", "oa@x.com", groups=["g-admins"], enabled=False)
        self.assertEqual(sorted(m["id"] for m in self.kc.members()), ["boss", "kim", "u1"])     # R1
        self.assertEqual(self.kc.admin_ids(), {"boss": "boss@x.com", "kim": "kim@x.com"})        # O5
        self.assertIn("offadmin", self.kc.admin_ids(enabled_only=False))
        self.assertEqual([u["id"] for u in self.kc.find_by_email("KIM@x.com")], ["kim"])

    def test_권한이_없거나_닿지_않으면_코드로_구별한다(self):
        self.K.add("u1", "a", "a@x.com")
        self.K.deny_writes = True
        with self.assertRaises(keycloak.KeycloakError) as cm:
            self.kc.reset_password("u1", "pw-12345678")
        self.assertEqual(cm.exception.code, 403)
        with self.assertRaises(keycloak.KeycloakError) as cm:
            keycloak.KeycloakAdmin("http://127.0.0.1:1/realms/aas", "c", "s", "aas-users", "aas-admin", timeout=2).list_users()
        self.assertEqual(cm.exception.code, 0)
        with self.assertRaises(keycloak.KeycloakError) as cm:
            self.kcfake.admin(self.issuer, "wrong").list_users()
        self.assertEqual(cm.exception.code, 401)

    def test_관리자_그룹이_없으면_관리자로_만들지_못한다(self):
        self.K.role_groups = []
        with self.assertRaises(keycloak.KeycloakError) as cm:
            self.kc.create_user("hong", "hong@x.com", "a", "b", "", "pw-12345678", admin=True)
        self.assertEqual(cm.exception.code, 404)
        self.assertFalse(self.K.users)                                                # 만들기 전에 멈춘다


if __name__ == "__main__":
    unittest.main()

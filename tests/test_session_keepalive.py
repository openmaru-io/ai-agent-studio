# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""사용 중 로그인 유지와 Keycloak 토큰 갱신(OMAI-1112).

로그인 뒤 12시간 고정 만료와 Keycloak 최대 10시간 때문에 쓰는 중에 로그인이 풀렸다. 이제 조작 신호(touch)가 올 때만
유휴 마감을 밀고(최대 24시간 안에서), 그때 Keycloak refresh_token 으로 토큰을 갱신한다. 세션이 끝나면 Keycloak 세션도 끝낸다.
"""
import aasserver  # 실제 uvicorn 앱을 띄우는 시험 하네스(OMAI-1100)
import base64
import hashlib
import http.client
import json
import os
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

TMP = tempfile.TemporaryDirectory()
os.environ.setdefault("AAS_DATA_DIR", str(Path(TMP.name) / "data"))

from aas.auth import auth  # noqa: E402
from aas.common import store  # noqa: E402


def b64(obj) -> str:
    return base64.urlsafe_b64encode(json.dumps(obj).encode()).rstrip(b"=").decode()


def jwt(claims: dict) -> str:
    return f"{b64({'alg': 'none'})}.{b64(claims)}.x"


class FakeKeycloak(BaseHTTPRequestHandler):
    claims: dict = {}            # id_token claim(로그인·갱신 공통)
    access: dict = {}            # access_token 에만 실리는 역할·그룹
    mode = "ok"                  # 갱신 응답: ok · invalid · error
    rt_typ = "Refresh"
    delay = 0.0
    refreshes: list = []         # 갱신에 쓰인 refresh_token
    ended: list = []             # end-session 에 쓰인 refresh_token
    issued = 0

    def do_GET(self):
        base = f"http://127.0.0.1:{self.server.server_port}"
        # OKE 처럼 end_session_endpoint 는 서버 파드가 닿지 못하는 공개 주소로 준다(KC_HOSTNAME). 토큰 엔드포인트만 내부 주소다
        self._json(200, {"issuer": base, "authorization_endpoint": base + "/authorize", "token_endpoint": base + "/token",
                         "end_session_endpoint": "https://aas-sso.unreachable.invalid/realms/aas/protocol/openid-connect/logout"})

    def do_POST(self):
        form = {k: v[0] for k, v in parse_qs(self.rfile.read(int(self.headers["Content-Length"])).decode()).items()}
        if self.path == "/logout":
            FakeKeycloak.ended.append(form.get("refresh_token"))
            return self._json(204, None)
        if form.get("grant_type") == "refresh_token":
            FakeKeycloak.refreshes.append(form.get("refresh_token"))
            time.sleep(FakeKeycloak.delay)
            if FakeKeycloak.mode == "invalid":
                return self._json(400, {"error": "invalid_grant", "error_description": "Session not active"})
            if FakeKeycloak.mode == "error":
                return self._json(503, {"error": "unavailable"})
            claims = {k: v for k, v in FakeKeycloak.claims.items() if k != "nonce"}
        else:
            claims = FakeKeycloak.claims
        FakeKeycloak.issued += 1
        self._json(200, {"id_token": jwt({**claims, "exp": time.time() + 300}),
                         "access_token": jwt(FakeKeycloak.access),
                         "refresh_token": jwt({"typ": FakeKeycloak.rt_typ, "n": FakeKeycloak.issued})})

    def _json(self, code, obj):
        body = json.dumps(obj).encode() if obj is not None else b""
        self.send_response(code)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *a):
        pass


def row(token: str):
    with store.connect() as conn:
        return conn.execute("SELECT * FROM auth_sessions WHERE hash=?", (hashlib.sha256(token.encode()).hexdigest(),)).fetchone()


def setrow(token: str, **values):
    with store.connect() as conn:
        for k, v in values.items():
            conn.execute(f"UPDATE auth_sessions SET {k}=? WHERE hash=?", (v, hashlib.sha256(token.encode()).hexdigest()))


def wait_for(pred, seconds=3.0):
    end = time.time() + seconds
    while time.time() < end:
        if pred():
            return True
        time.sleep(0.02)
    return pred()


class KeepAliveBase(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.idp = ThreadingHTTPServer(("127.0.0.1", 0), FakeKeycloak)
        threading.Thread(target=cls.idp.serve_forever, daemon=True).start()
        cls.issuer = f"http://127.0.0.1:{cls.idp.server_port}"

    @classmethod
    def tearDownClass(cls):
        cls.idp.shutdown()
        cls.idp.server_close()

    def setUp(self):
        FakeKeycloak.mode, FakeKeycloak.rt_typ, FakeKeycloak.delay = "ok", "Refresh", 0.0
        FakeKeycloak.refreshes, FakeKeycloak.ended = [], []
        FakeKeycloak.access = {"groups": ["/aas-users"], "realm_access": {"roles": []}}
        self.changed = []
        self.a = auth.Auth({"issuer": self.issuer, "client_id": "aas", "client_secret": "sec", "domain": "",
                            "public_url": "http://127.0.0.1:1", "hours": 24, "idle_minutes": 120,
                            "users_group": "aas-users", "admin_role": "aas-admin"})
        self.a.on_change = self.changed.append

    def login(self, email="kim@x.com") -> str:
        q = parse_qs(urlsplit(self.a.begin("/")).query)
        FakeKeycloak.claims = {"iss": self.issuer, "aud": "aas", "exp": time.time() + 300, "nonce": q["nonce"][0],
                               "sub": "sub-" + email, "email": email, "email_verified": True, "name": "Kim"}
        token, _ = self.a.finish("code", q["state"][0])
        return token

    def cookie(self, token: str) -> str:
        return f"{auth.COOKIE}={token}"


class SlidingSessionTest(KeepAliveBase):
    def test_new_session_ends_after_idle_unless_touched_and_never_after_max(self):
        t = self.login()
        r, now = row(t), time.time()
        self.assertAlmostEqual(r["max_until"], now + 24 * 3600, delta=5)
        self.assertAlmostEqual(r["expires"], now + 120 * 60, delta=5)
        setrow(t, expires=now + 10)
        out = self.a.touch(self.cookie(t))
        self.assertAlmostEqual(row(t)["expires"], now + 120 * 60, delta=5)               # 조작하면 유휴 마감이 2시간 뒤로
        self.assertAlmostEqual(out["idle_until"], row(t)["expires"], delta=1)
        setrow(t, max_until=now + 100)
        self.a.touch(self.cookie(t))
        self.assertAlmostEqual(row(t)["expires"], now + 100, delta=1)                     # 최대를 넘지 않는다

    def test_automatic_requests_do_not_extend(self):
        t = self.login()
        setrow(t, expires=time.time() + 50)
        before = row(t)["expires"]
        for _ in range(3):
            self.assertIsNotNone(self.a.user(self.cookie(t)))                             # 웹소켓 확인·주기 조회가 부르는 것
        self.assertEqual(row(t)["expires"], before)

    def test_idle_expiry_ends_session_and_keycloak_once(self):
        t = self.login()
        rt = auth.unseal(row(t)["rt"], "sec", t)
        setrow(t, expires=time.time() - 1)
        self.assertIsNone(self.a.user(self.cookie(t)))
        self.assertIsNone(self.a.touch(self.cookie(t)))                                    # 조작해도 되살리지 않는다
        self.assertTrue(wait_for(lambda: FakeKeycloak.ended == [rt]))                      # Keycloak 세션도 끝낸다(한 번만)
        self.assertEqual(row(t)["rt"], "")
        self.a.user(self.cookie(t))
        time.sleep(0.2)
        self.assertEqual(FakeKeycloak.ended, [rt])

    def test_cookie_lives_until_max(self):
        self.assertIn("Max-Age=86400", self.a.set_cookie("x"))

    def test_row_from_old_pod_without_max_until_uses_created_plus_hours(self):
        # 롤링 재시작 중 옛 파드가 넣은 행(max_until 기본 0)을 새 파드가 즉시 로그아웃시키면 안 된다
        token, now = "old-pod-token", time.time()
        with store.connect() as conn:
            conn.execute("INSERT INTO auth_sessions (hash, email, name, created, expires, sub, admin) VALUES (?,?,?,?,?,?,?)",
                         (hashlib.sha256(token.encode()).hexdigest(), "old@x.com", "", now - 60, now + 3600, "", 0))
        self.assertEqual(self.a.user(self.cookie(token))["email"], "old@x.com")
        out = self.a.touch(self.cookie(token))
        self.assertAlmostEqual(out["max_until"], now - 60 + 24 * 3600, delta=5)

    def test_admin_session_counts_until_max_not_idle(self):
        # 관리자가 2시간 자리를 비웠다고 그 사람의 칸반 카드가 보류로 옮겨지면 안 된다(hub_auto)
        FakeKeycloak.access = {"groups": [], "realm_access": {"roles": ["aas-admin"]}}
        t = self.login("boss@x.com")
        setrow(t, expires=time.time() - 1)
        self.assertTrue(auth.has_admin_session("boss@x.com"))
        setrow(t, max_until=time.time() - 1)
        self.assertFalse(auth.has_admin_session("boss@x.com"))

    def test_logout_ends_keycloak_session(self):
        t = self.login()
        rt = auth.unseal(row(t)["rt"], "sec", t)
        self.a.logout(self.cookie(t))
        self.assertIsNone(row(t))
        self.assertEqual(FakeKeycloak.ended, [rt])


class AdminRevokeTest(KeepAliveBase):
    """관리자가 다른 사람을 로그아웃시키면 그 사람의 Keycloak 세션도 끝난다(다음 요청 때). 서버에는 그 사람의 쿠키가 없어
    refresh_token 을 바로 풀 수 없다 — 세션을 '끝남'으로 두고, 그 브라우저가 다시 오면 그 쿠키로 풀어 Keycloak 을 먼저 끝낸다."""

    def test_revoked_session_ends_keycloak_on_next_request(self):
        t, other = self.login(), self.login()
        rt = auth.unseal(row(t)["rt"], "sec", t)
        self.assertEqual(self.a.revoke("kim@x.com"), 2)
        self.assertIsNotNone(row(t))                                                       # 행은 남는다(쿠키가 오면 Keycloak 을 끝내려고)
        self.assertEqual(FakeKeycloak.ended, [])
        self.assertIsNone(self.a.user(self.cookie(t)))                                     # 열린 탭의 웹소켓 확인(60초)이나 다음 요청
        self.assertTrue(wait_for(lambda: rt in FakeKeycloak.ended))
        self.assertIsNone(self.a.touch(self.cookie(t)))                                    # 조작해도 되살리지 않는다
        self.assertIsNone(self.a.user(self.cookie(other)))

    def test_revoked_admin_is_not_counted_and_others_are_untouched(self):
        FakeKeycloak.access = {"groups": [], "realm_access": {"roles": ["aas-admin"]}}
        boss = self.login("boss2@x.com")
        FakeKeycloak.access = {"groups": ["/aas-users"], "realm_access": {"roles": []}}
        kept = self.login("lee@x.com")
        self.assertTrue(auth.has_admin_session("boss2@x.com"))
        self.a.revoke("boss2@x.com")
        self.assertFalse(auth.has_admin_session("boss2@x.com"))                            # 권한을 뺀 관리자의 칸반 카드는 멈춰야 한다
        self.assertIsNone(self.a.user(self.cookie(boss)))
        self.assertIsNotNone(self.a.user(self.cookie(kept)))
        self.assertEqual(self.a.revoke("nobody@x.com"), 0)
        # boss2 의 Keycloak 끝내기는 백그라운드 스레드라, 기다리지 않으면 늦게 와서 다음 시험의 FakeKeycloak.ended 에 섞인다(부하가 클 때 실패)
        self.assertTrue(wait_for(lambda: len(FakeKeycloak.ended) == 1))


class PrecisionTest(KeepAliveBase):
    def test_times_keep_sub_second_precision(self):
        # PostgreSQL 의 REAL 은 4바이트라 에포크 초가 1분 가까이 뭉개졌다(빌드 31, OKE 실측 refreshed 가 created 보다 20초 앞섬)
        t = self.login()
        r = row(t)
        self.assertAlmostEqual(r["max_until"], r["created"] + 24 * 3600, delta=0.01)
        self.assertAlmostEqual(r["refreshed"], r["created"], delta=0.01)

    @unittest.skipUnless(os.environ.get("AAS_DB_BACKEND") == "postgres", "PostgreSQL 에서만 생기는 열 형식 문제")
    def test_real_columns_from_build_31_are_widened(self):
        with store.connect() as conn:
            for col in ("max_until", "refreshed", "refresh_lock"):
                conn.execute(f"ALTER TABLE auth_sessions ALTER COLUMN {col} TYPE REAL")
        auth.Auth({"issuer": "", "client_id": "", "client_secret": "", "domain": "", "public_url": "http://x", "hours": 24})
        with store.connect() as conn:
            types = {r["column_name"]: r["data_type"] for r in conn.execute(
                "SELECT column_name, data_type FROM information_schema.columns WHERE table_name='auth_sessions' AND table_schema=current_schema()").fetchall()}
        self.assertEqual({types[c] for c in ("max_until", "refreshed", "refresh_lock")}, {"double precision"})


class MigrationTest(unittest.TestCase):
    def test_existing_sessions_keep_their_old_end(self):
        with store.connect() as conn:
            conn.execute("DROP TABLE IF EXISTS auth_sessions")
            conn.execute("CREATE TABLE auth_sessions (hash TEXT PRIMARY KEY, email TEXT NOT NULL, name TEXT, created REAL NOT NULL, expires REAL NOT NULL)")
            conn.execute("INSERT INTO auth_sessions VALUES ('h1', 'a@x.com', '', 1, 4000000000)")
        auth.Auth({"issuer": "", "client_id": "", "client_secret": "", "domain": "", "public_url": "http://x", "hours": 24})
        with store.connect() as conn:
            r = conn.execute("SELECT max_until, rt FROM auth_sessions WHERE hash='h1'").fetchone()
        self.assertEqual((r["max_until"], r["rt"]), (4000000000, ""))


class RefreshTest(KeepAliveBase):
    def touch_due(self, t):
        setrow(t, refreshed=0)
        return self.a.touch(self.cookie(t))

    def test_refresh_rotates_token_and_updates_admin(self):
        t = self.login()
        old = auth.unseal(row(t)["rt"], "sec", t)
        FakeKeycloak.access = {"groups": ["/aas-users"], "realm_access": {"roles": ["aas-admin"]}}
        self.touch_due(t)
        self.assertEqual(FakeKeycloak.refreshes, [old])
        new = auth.unseal(row(t)["rt"], "sec", t)
        self.assertNotEqual(new, old)
        self.assertEqual(row(t)["admin"], 1)
        self.assertEqual(self.changed, ["kim@x.com"])                                      # 웹소켓 구독을 다시 검사한다
        self.assertEqual(row(t)["refresh_lock"], 0)

    def test_refresh_rewrites_the_session_name_family_then_given(self):
        """2026-10-18: 갱신 때 세션 이름도 로그인과 같은 규칙(성+이름)으로 다시 쓴다. 성·이름이 없으면 그대로 둔다."""
        t = self.login()
        FakeKeycloak.claims = {**FakeKeycloak.claims, "name": "관리자 AAS", "given_name": "관리자", "family_name": "AAS"}
        self.touch_due(t)
        self.assertEqual(row(t)["name"], "AAS 관리자")
        FakeKeycloak.claims = {k: v for k, v in FakeKeycloak.claims.items() if k not in ("name", "given_name", "family_name")}
        self.touch_due(t)
        self.assertEqual(row(t)["name"], "AAS 관리자")

    def test_recent_refresh_is_not_repeated(self):
        t = self.login()
        self.a.touch(self.cookie(t))
        self.assertEqual(FakeKeycloak.refreshes, [])                                       # 로그인 직후에는 갱신하지 않는다

    def test_invalid_grant_ends_session(self):
        t = self.login()
        FakeKeycloak.mode = "invalid"
        self.assertIsNone(self.touch_due(t))
        self.assertIsNone(row(t))
        self.assertIsNone(self.a.user(self.cookie(t)))
        self.assertEqual(self.changed, ["kim@x.com"])

    def test_server_error_keeps_session_and_retries_next_touch(self):
        t = self.login()
        FakeKeycloak.mode = "error"
        self.assertIsNotNone(self.touch_due(t))
        self.assertIsNotNone(self.a.user(self.cookie(t)))
        self.assertEqual(row(t)["refresh_lock"], 0)
        FakeKeycloak.mode = "ok"
        self.a.touch(self.cookie(t))                                                       # refreshed 가 그대로라 바로 다시 한다
        self.assertEqual(len(FakeKeycloak.refreshes), 2)

    def test_removed_from_group_ends_session(self):
        t = self.login()
        FakeKeycloak.access = {"groups": [], "realm_access": {"roles": []}}
        self.assertIsNone(self.touch_due(t))
        self.assertIsNone(row(t))

    def test_other_subject_ends_session(self):
        t = self.login()
        FakeKeycloak.claims = {**FakeKeycloak.claims, "sub": "someone-else"}
        self.assertIsNone(self.touch_due(t))

    def test_offline_refresh_token_is_not_stored(self):
        FakeKeycloak.rt_typ = "Offline"
        t = self.login()
        self.assertEqual(row(t)["rt"], "")
        self.assertIsNotNone(self.touch_due(t))
        self.assertEqual(FakeKeycloak.refreshes, [])

    def test_concurrent_touches_refresh_once(self):
        t = self.login()
        setrow(t, refreshed=0)
        FakeKeycloak.delay = 0.5
        threads = [threading.Thread(target=self.a.touch, args=(self.cookie(t),)) for _ in range(3)]
        for th in threads:
            th.start()
        for th in threads:
            th.join()
        self.assertEqual(len(FakeKeycloak.refreshes), 1)


class SealTest(unittest.TestCase):
    def test_round_trip_and_key_binding(self):
        sealed = auth.seal("refresh-token-value", "sec", "cookie-a")
        self.assertNotIn("refresh-token-value", sealed)
        self.assertEqual(auth.unseal(sealed, "sec", "cookie-a"), "refresh-token-value")
        self.assertEqual(auth.unseal(sealed, "sec", "cookie-b"), "")                       # 다른 쿠키로는 풀리지 않는다
        self.assertEqual(auth.unseal(sealed, "other", "cookie-a"), "")                     # 다른 서버 비밀로도
        raw = bytearray(base64.urlsafe_b64decode(sealed))
        raw[20] ^= 1
        self.assertEqual(auth.unseal(base64.urlsafe_b64encode(bytes(raw)).decode(), "sec", "cookie-a"), "")   # 변조 거부
        self.assertEqual(auth.unseal("garbage", "sec", "cookie-a"), "")
        self.assertEqual(auth.seal("", "sec", "cookie-a"), "")


class TouchRouteTest(KeepAliveBase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        from aas.fleet import pods
        from aas.web import server
        root = Path(TMP.name)
        (root / "home_k" / "profiles").mkdir(parents=True, exist_ok=True)
        reg = root / "pods-keepalive.json"
        reg.write_text(json.dumps({"admins": [], "pods": [{"id": "k", "owner": "kim@x.com", "hermes_home": str(root / "home_k")}]}))
        cls.app = aasserver.start()
        cls.server = server
        cls.old = (server._auth, server._registry)
        server._registry = pods.Registry(reg)

    @classmethod
    def tearDownClass(cls):
        cls.app.shutdown()
        cls.server._auth, cls.server._registry = cls.old
        super().tearDownClass()

    def setUp(self):
        super().setUp()
        self.server._auth = self.a

    def post(self, cookie="", headers=None):
        c = http.client.HTTPConnection("127.0.0.1", self.app.server_port, timeout=10)
        h = {"Content-Type": "application/json", **({"Cookie": cookie} if cookie else {}), **(headers or {})}
        c.request("POST", "/api/session/touch", body="{}", headers=h)
        r = c.getresponse()
        return r.status, json.loads(r.read() or b"{}")

    def test_touch_route(self):
        self.assertEqual(self.post(headers={"X-AAS": "1"})[0], 401)                        # 세션 없음
        t = self.login()
        self.assertEqual(self.post(self.cookie(t))[0], 403)                                # X-AAS 없음
        setrow(t, expires=time.time() + 10)
        status, body = self.post(self.cookie(t), {"X-AAS": "1"})
        self.assertEqual(status, 200)
        self.assertGreater(body["idle_until"], time.time() + 3600)
        t2 = self.login("nopod@x.com")                                                     # 연결된 POD 가 없어도 연장된다
        self.assertEqual(self.post(self.cookie(t2), {"X-AAS": "1"})[0], 200)


if __name__ == "__main__":
    unittest.main()

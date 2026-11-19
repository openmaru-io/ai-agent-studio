# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""채팅 임베드 위젯 서버 1단계(OMAI-1873): 앱 등록·JWT 검증·임베드 토큰·교환·경로 제한·CORS·인증서 페이지.

실제 uvicorn 앱에 http.client 로 붙는다. Keycloak JWKS 는 aas.auth.tls.urlopen 을 대역으로 바꿔 준다(그 함수를 거치는지도 함께 본다).
"""
import aasserver  # 실제 uvicorn 앱을 띄우는 시험 하네스(OMAI-1100)
import http.client
import io
import json
import os
import ssl
import tempfile
import threading
import time
import unittest
import urllib.error
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from unittest import mock

TMP = tempfile.TemporaryDirectory()
os.environ.setdefault("AAS_DATA_DIR", str(Path(TMP.name) / "data"))

import embed_keys  # noqa: E402

from aas.auth import embed, tls  # noqa: E402

ALICE, BOB, BOSS, STRANGER = "em-alice@corp.example", "em-bob@corp.example", "em-boss@corp.example", "em-stranger@corp.example"
PASSWORD = "correct horse battery"
KC_ORIGIN, PORTAL_ORIGIN, EVIL = "http://cop.embed.example:8000", "https://portal.embed.example", "https://evil.embed.example"
ISSUER, JWKS_URL, AUD = "https://kc.embed.example/realms/cop", "https://kc-internal.embed.example/realms/cop/protocol/openid-connect/certs", "aas-embed"
KC_APP, HOST_APP = "em-kc-app", "em-host-app"


class FakeJwks:
    """tls.urlopen 대역. 부른 주소를 세고, fail 이 있으면 그 예외를 낸다."""

    def __init__(self):
        self.keys, self.calls, self.fail = {}, [], None

    def __call__(self, req, timeout):
        self.calls.append(req.full_url)
        if self.fail is not None:
            raise self.fail
        return io.BytesIO(json.dumps({"keys": list(self.keys.values())}).encode())


def kc_claims(email=ALICE, **over):
    now = time.time()
    c = {"iss": ISSUER, "aud": [AUD, "account"], "azp": "cop-console", "sub": "host-sub-" + email, "exp": now + 300, "iat": now,
         "email": email, "email_verified": True}
    c.update(over)
    return {k: v for k, v in c.items() if v is not None}


def _cleanup_db():
    from aas.auth import mcp_limits
    with embed._conn() as conn:
        for t in ("embed_apps", "embed_origins", "embed_tokens", "embed_jti"):
            conn.execute(f"DELETE FROM {t}")
    with mcp_limits._conn() as conn:
        conn.execute("DELETE FROM mcp_rate WHERE user_email LIKE 'embed%'")


class EmbedUnitTest(unittest.TestCase):
    """서버를 띄우지 않는 부분: RSA·JWT·출처·저장."""

    def tearDown(self):
        _cleanup_db()
        embed.forget_jwks()

    def test_rsa_pkcs1_v15_검증(self):
        a, b = embed_keys.key("a"), embed_keys.key("b")
        sig = a.sign_raw(b"msg")
        self.assertTrue(embed.rsa_verify(b"msg", sig, a.n, a.e))
        self.assertFalse(embed.rsa_verify(b"msg!", sig, a.n, a.e))              # 내용이 다르다
        self.assertFalse(embed.rsa_verify(b"msg", sig, b.n, b.e))               # 다른 키
        self.assertFalse(embed.rsa_verify(b"msg", sig[:-1], a.n, a.e))          # 길이가 다르다
        self.assertFalse(embed.rsa_verify(b"msg", (a.n + 1).to_bytes(a.k + 1, "big")[-a.k:], a.n, a.e))   # n 이상
        bad = bytearray(sig)
        bad[5] ^= 1
        self.assertFalse(embed.rsa_verify(b"msg", bytes(bad), a.n, a.e))

    def test_alg_none_HS256_은_거절(self):
        a = embed_keys.key("a")
        good = embed_keys.jwt({"x": 1}, a, kid="k")
        h, p, s = good.split(".")
        none_h = embed_keys.b64(json.dumps({"alg": "none"}).encode())
        hs_h = embed_keys.b64(json.dumps({"alg": "HS256", "kid": "k"}).encode())
        for token in (f"{none_h}.{p}.", f"{hs_h}.{p}.{s}", "a.b", "", "x.y.z"):
            with self.assertRaises(embed.EmbedError) as cm:
                embed._split(token)
            self.assertEqual((cm.exception.status, cm.exception.code), (401, "token_invalid"))
        self.assertEqual(embed._split(good)[0]["alg"], "RS256")

    def test_출처_정규화(self):
        n = embed.normalize_origin
        self.assertEqual(n("HTTPS://Cop.Example.com:443"), "https://cop.example.com")
        self.assertEqual(n("http://a.example:8000/"), "http://a.example:8000")
        for bad in ("cop.example.com", "ftp://a.example", "https://a.example/path", "https://u:p@a.example", "https://a.example?q=1", "null", ""):
            self.assertEqual(n(bad), "", bad)

    def test_출처_하나는_앱_하나에만(self):
        embed.add_app("A", [KC_ORIGIN], "keycloak", app_id="u-a", issuer=ISSUER, jwks_url=JWKS_URL, audience=AUD)
        with self.assertRaises(ValueError):
            embed.add_app("B", ["HTTP://cop.embed.example:8000/"], "keycloak", app_id="u-b", issuer=ISSUER, jwks_url=JWKS_URL, audience=AUD)
        self.assertIsNone(embed.get_app("u-b"))
        self.assertEqual(embed.app_for_origin(KC_ORIGIN)["app_id"], "u-a")
        self.assertIsNone(embed.app_for_origin(EVIL))
        with self.assertRaises(ValueError):                                     # keycloak 모드는 aud 필수
            embed.add_app("C", ["https://c.example"], "keycloak", issuer=ISSUER, jwks_url=JWKS_URL)

    def test_host_signed_공개_키_검사(self):
        small = embed_keys.Key(bits=1024)
        with self.assertRaises(ValueError):
            embed.add_app("S", ["https://s.example"], "host-signed", public_jwk=json.dumps(small.jwk()))
        with self.assertRaises(ValueError):                                     # 개인 키를 붙여 넣었다
            embed.add_app("S", ["https://s.example"], "host-signed", public_jwk=json.dumps(embed_keys.key("h").jwk(private=True)))
        app = embed.add_app("S", ["https://s.example"], "host-signed", public_jwk=json.dumps(embed_keys.key("h").jwk()))
        self.assertEqual(app["mode"], "host-signed")

    def test_경로_허용_목록(self):
        for ok in ("/api/chat/send", "/api/chat/status", "/api/chat/events", "/api/me", "/api/embed/token/revoke"):
            self.assertTrue(embed.path_allowed(ok), ok)
        for no in ("/api/admin/users", "/api/users", "/api/office", "/mcp", "/api/chat/transcribe", "/api/chat/transcribe/stream",
                   "/api/chat/speak", "/api/me/x", "/api/chat/../users", "/ws"):
            self.assertFalse(embed.path_allowed(no), no)

    def test_임베드_토큰_발급_출처_만료_폐기_정리(self):
        app = embed.add_app("A", [KC_ORIGIN, PORTAL_ORIGIN], "keycloak", app_id="u-t", issuer=ISSUER, jwks_url=JWKS_URL, audience=AUD)
        now = 1_800_000_000.0
        raw, expires = embed.issue(app, KC_ORIGIN, "X@Corp.example", "aas-sub", now=now)
        self.assertTrue(raw.startswith(embed.TOKEN_PREFIX))
        self.assertEqual(expires, now + embed.TOKEN_TTL)
        with embed._conn() as conn:                                             # 원문은 저장하지 않는다
            stored = [dict(r) for r in conn.execute("SELECT * FROM embed_tokens")]
        self.assertEqual(stored[0]["token_hash"], embed._hash(raw))
        self.assertNotIn(raw, json.dumps(stored))
        row = embed.lookup(raw, KC_ORIGIN, now=now + 10)
        self.assertEqual((row["user_email"], row["user_sub"]), ("x@corp.example", "aas-sub"))
        self.assertIsNone(embed.lookup(raw, PORTAL_ORIGIN, now=now + 10))      # 같은 앱이라도 다른 출처
        self.assertIsNone(embed.lookup(raw, KC_ORIGIN, now=expires + 1))       # 만료
        self.assertIsNone(embed.lookup("aas_emb_nope", KC_ORIGIN, now=now))
        self.assertTrue(embed.revoke(raw, KC_ORIGIN, now=now + 20))
        self.assertIsNone(embed.lookup(raw, KC_ORIGIN, now=now + 21))
        self.assertFalse(embed.revoke(raw, KC_ORIGIN, now=now + 22))
        self.assertEqual(embed.prune(now=now + 20 + 1800), 0)                   # 폐기 1시간 전에는 남긴다
        self.assertEqual(embed.prune(now=now + 20 + embed.KEEP_ENDED + 1), 1)
        raw2, _ = embed.issue(app, KC_ORIGIN, "y@corp.example", now=now)
        self.assertEqual(embed.prune(now=now + embed.TOKEN_TTL + embed.KEEP_ENDED - 5), 0)
        self.assertEqual(embed.prune(now=now + embed.TOKEN_TTL + embed.KEEP_ENDED + 5), 1)

    def test_앱을_지우면_토큰도_끝난다(self):
        app = embed.add_app("A", [KC_ORIGIN], "keycloak", app_id="u-r", issuer=ISSUER, jwks_url=JWKS_URL, audience=AUD)
        raw, _ = embed.issue(app, KC_ORIGIN, ALICE)
        self.assertIsNotNone(embed.lookup(raw, KC_ORIGIN))
        self.assertTrue(embed.remove_app("u-r"))
        self.assertIsNone(embed.lookup(raw, KC_ORIGIN))
        self.assertIsNone(embed.app_for_origin(KC_ORIGIN))

    def test_앱_고치기(self):
        app = embed.add_app("A", [KC_ORIGIN, PORTAL_ORIGIN], "keycloak", app_id="u-up", issuer=ISSUER, jwks_url=JWKS_URL, audience=AUD)
        embed.add_app("B", ["https://b.example"], "keycloak", app_id="u-other", issuer=ISSUER, jwks_url=JWKS_URL, audience=AUD)
        kc, portal = embed.issue(app, KC_ORIGIN, ALICE)[0], embed.issue(app, PORTAL_ORIGIN, ALICE)[0]
        # 이름·출처만 바꾸면 남은 출처의 토큰은 그대로, 뺀 출처의 토큰은 곧바로 쓸 수 없다
        out = embed.update_app("u-up", " New  name ", [KC_ORIGIN], "keycloak", issuer=ISSUER + "/", jwks_url=JWKS_URL, audience=AUD,
                               default_agent="em-a")
        self.assertEqual((out["name"], out["origins"], out["issuer"], out["default_agent"]), ("New name", [KC_ORIGIN], ISSUER, "em-a"))
        self.assertIsNotNone(embed.lookup(kc, KC_ORIGIN))
        self.assertIsNone(embed.lookup(portal, PORTAL_ORIGIN))
        self.assertIsNone(embed.app_for_origin(PORTAL_ORIGIN))
        # 신뢰 설정(audience)이 바뀌면 그 앱의 토큰을 모두 지운다
        embed.update_app("u-up", "New name", [KC_ORIGIN], "keycloak", issuer=ISSUER, jwks_url=JWKS_URL, audience="other-aud")
        self.assertIsNone(embed.lookup(kc, KC_ORIGIN))
        # 다른 앱의 출처는 가져올 수 없고, 틀린 값은 칸 이름과 함께 거절한다(그때 바뀐 것은 없다)
        with self.assertRaises(embed.AppError) as cm:
            embed.update_app("u-up", "New name", [KC_ORIGIN, "https://b.example"], "keycloak", issuer=ISSUER, jwks_url=JWKS_URL, audience=AUD)
        self.assertEqual(cm.exception.field, "origins")
        self.assertEqual(embed.app_for_origin(KC_ORIGIN)["app_id"], "u-up")
        self.assertEqual(embed.get_app("u-up")["audience"], "other-aud")
        for kwargs, field in (({"name": ""}, "name"), ({"mode": "oidc"}, "mode"), ({"origins": ["cop.example"]}, "origins"),
                              ({"jwks_url": ""}, "jwks_url"), ({"jwks_url": "ftp://x"}, "jwks_url")):
            args = {"name": "N", "origins": [KC_ORIGIN], "mode": "keycloak", "issuer": ISSUER, "jwks_url": JWKS_URL, "audience": AUD} | kwargs
            with self.subTest(field), self.assertRaises(embed.AppError) as cm:
                embed.update_app("u-up", args.pop("name"), args.pop("origins"), args.pop("mode"), **args)
            self.assertEqual(cm.exception.field, field)
        with self.assertRaises(embed.AppError) as cm:                           # host-signed 로 바꾸며 개인 키를 붙였다
            embed.update_app("u-up", "N", [KC_ORIGIN], "host-signed", public_jwk=json.dumps(embed_keys.key("h").jwk(private=True)))
        self.assertEqual(cm.exception.field, "public_jwk")
        out = embed.update_app("u-up", "N", [KC_ORIGIN], "host-signed", issuer=ISSUER, public_jwk=json.dumps(embed_keys.key("h").jwk()))
        self.assertEqual((out["mode"], out["issuer"], out["audience"]), ("host-signed", "", ""))   # 다른 모드의 값은 지운다
        with self.assertRaises(embed.AppError) as cm:
            embed.update_app("u-none", "N", [KC_ORIGIN], "keycloak", issuer=ISSUER, jwks_url=JWKS_URL, audience=AUD)
        self.assertEqual(cm.exception.field, "app_id")

    def test_CLI_등록_목록_삭제(self):
        out, err = io.StringIO(), io.StringIO()
        base = ["add", "--name", "COP", "--origin", KC_ORIGIN, "--mode", "keycloak", "--app-id", "u-cli", "--issuer", ISSUER,
                "--jwks-url", JWKS_URL, "--audience", AUD]
        with redirect_stdout(out), redirect_stderr(err):
            self.assertEqual(embed._main(base), 2)                              # 호스트 realm 정책 확인 없이는 등록하지 않는다
            self.assertIsNone(embed.get_app("u-cli"))
            self.assertEqual(embed._main(base + ["--idp-policy-checked"]), 0)
            self.assertEqual(embed._main(["list"]), 0)
            self.assertEqual(embed._main(["remove", "u-cli"]), 0)
            self.assertEqual(embed._main(["remove", "u-cli"]), 1)
        self.assertIn('"app_id": "u-cli"', out.getvalue())

    def test_JWKS_캐시와_새_kid_재조회(self):
        app = embed.add_app("A", [KC_ORIGIN], "keycloak", app_id="u-j", issuer=ISSUER, jwks_url=JWKS_URL, audience=AUD)
        k1, k2 = embed_keys.key("kc1"), embed_keys.key("kc2")
        fake = FakeJwks()
        fake.keys = {"k1": k1.jwk("k1")}
        with mock.patch.object(tls, "urlopen", fake):                           # JWKS 는 tls.urlopen 으로만 받는다
            embed.verify_keycloak(app, embed_keys.jwt(kc_claims(), k1, "k1"))
            embed.verify_keycloak(app, embed_keys.jwt(kc_claims(), k1, "k1"))
            self.assertEqual(fake.calls, [JWKS_URL])                           # 두 번째는 캐시
            fake.keys["k2"] = k2.jwk("k2")                                      # Keycloak 키 회전
            embed.verify_keycloak(app, embed_keys.jwt(kc_claims(), k2, "k2"))
            self.assertEqual(len(fake.calls), 2)                               # 모르는 kid 라 한 번 다시 받았다
            with self.assertRaises(embed.EmbedError) as cm:                     # 또 모르는 kid — 30초 안에는 다시 받지 않는다
                embed.verify_keycloak(app, embed_keys.jwt(kc_claims(), k2, "k-random"))
            self.assertEqual((cm.exception.status, len(fake.calls)), (401, 2))

    def test_JWKS_인증서_오류는_503(self):
        app = embed.add_app("A", [KC_ORIGIN], "keycloak", app_id="u-e", issuer=ISSUER, jwks_url=JWKS_URL, audience=AUD)
        fake = FakeJwks()
        fake.fail = urllib.error.URLError(ssl.SSLCertVerificationError(1, "certificate verify failed: self-signed certificate"))
        out = io.StringIO()
        with mock.patch.object(tls, "urlopen", fake), redirect_stdout(out), self.assertRaises(embed.EmbedError) as cm:
            embed.verify_keycloak(app, embed_keys.jwt(kc_claims(), embed_keys.key("kc1"), "k1"))
        self.assertEqual((cm.exception.status, cm.exception.code), (503, "idp_unreachable"))
        self.assertIn("certificate verify failed", out.getvalue())             # 로그에 원인 한 줄


class EmbedHttpTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        from aas.auth import auth
        from aas.fleet import pods
        from aas.web import mcp_server, server
        root = Path(TMP.name)
        cls.users = root / "em-users.json"
        for e in (ALICE, BOB, BOSS):
            auth.save_user(e, PASSWORD, cls.users)
        for name in ("em_home_a", "em_home_b"):
            (root / name / "profiles" / "main").mkdir(parents=True, exist_ok=True)
            (root / name / "profiles" / "main" / "config.yaml").write_text("{}\n")   # 표시 파일이 없으면 프로파일이 아니다(OMAI-1855)
        reg = root / "em-pods.json"
        reg.write_text(json.dumps({"admins": [BOSS], "pods": [
            {"id": "em-a", "owner": ALICE, "hermes_home": str(root / "em_home_a")},
            {"id": "em-b", "owner": BOB, "hermes_home": str(root / "em_home_b")}]}))
        cls.app = aasserver.start()
        cls.port = cls.app.server_port
        cls.base = f"http://127.0.0.1:{cls.port}"
        cls.saved = (server._auth, server._registry)
        server._auth = auth.Auth({"issuer": "", "client_id": "", "client_secret": "", "domain": "", "public_url": cls.base,
                                  "public_urls": [], "hours": 1, "users_file": cls.users})
        server._registry = pods.Registry(reg)
        from test_mcp_server import FakeHub
        cls.hubs = {"em-a": FakeHub("em-a"), "em-b": FakeHub("em-b")}
        cls.patches = [mock.patch.object(server, "hub", lambda pod: cls.hubs[pod.id]),
                       mock.patch.object(mcp_server, "_keycloak", lambda: None)]   # 비밀번호 로그인 설치 — AAS 가 아는 사람인지로 본다
        for p in cls.patches:
            p.start()
        cls.server, cls.mcp = server, mcp_server
        cls.k1, cls.host_key = embed_keys.key("kc1"), embed_keys.key("host")

    @classmethod
    def tearDownClass(cls):
        for p in cls.patches:
            p.stop()
        cls.app.shutdown()
        cls.server._auth, cls.server._registry = cls.saved
        _cleanup_db()

    def setUp(self):
        _cleanup_db()
        embed.forget_jwks()
        embed.add_app("COP", [KC_ORIGIN], "keycloak", app_id=KC_APP, issuer=ISSUER, jwks_url=JWKS_URL, audience=AUD)
        embed.add_app("Portal", [PORTAL_ORIGIN], "host-signed", app_id=HOST_APP, public_jwk=json.dumps(self.host_key.jwk()))
        self.jwks = FakeJwks()
        self.jwks.keys = {"k1": self.k1.jwk("k1")}
        p = mock.patch.object(tls, "urlopen", self.jwks)
        p.start()
        self.addCleanup(p.stop)

    # ---- 도우미 ---------------------------------------------------------------------------------
    def req(self, method, path, body=None, origin=None, token=None, headers=None):
        c = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        h = {"Content-Type": "application/json"}
        if origin:
            h["Origin"] = origin
        if token:
            h["Authorization"] = f"Bearer {token}"
        h.update(headers or {})
        c.request(method, path, body=json.dumps(body) if body is not None else None, headers=h)
        r = c.getresponse()
        data = r.read()
        c.close()
        return r, (json.loads(data) if data[:1] in (b"{", b"[") else data)

    def exchange(self, assertion, origin=KC_ORIGIN):
        return self.req("POST", "/api/embed/token", {"assertion": assertion}, origin)

    def kc_token(self, email=ALICE, key=None, kid="k1", **claims):
        return embed_keys.jwt(kc_claims(email, **claims), key or self.k1, kid)

    def embed_token(self, email=ALICE):
        r, out = self.exchange(self.kc_token(email))
        self.assertEqual(r.status, 200, out)
        return out["token"]

    def host_token(self, email=ALICE, **over):
        now = time.time()
        c = {"iss": HOST_APP, "aud": self.base, "exp": now + 120, "jti": f"j-{time.monotonic_ns()}", "email": email}
        c.update(over)
        return embed_keys.jwt({k: v for k, v in c.items() if v is not None}, self.host_key)

    def login(self, email):
        c = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        c.request("POST", "/auth/password", body=f"email={email}&password=correct+horse+battery&next=/",
                  headers={"Content-Type": "application/x-www-form-urlencoded"})
        r = c.getresponse()
        r.read()
        c.close()
        self.assertEqual(r.status, 302)
        return r.getheader("Set-Cookie").split(";")[0]

    # ---- 교환 -----------------------------------------------------------------------------------
    def test_등록되지_않은_출처는_403(self):
        r, out = self.exchange(self.kc_token(), origin=EVIL)
        self.assertEqual((r.status, out["error"]), (403, "origin_not_registered"))
        self.assertEqual(r.getheader("Access-Control-Allow-Origin"), EVIL)      # 위젯이 코드를 읽어 「등록되지 않았습니다」를 고른다
        r, out = self.exchange(self.kc_token(), origin=None)
        self.assertEqual((r.status, out["error"]), (403, "origin_not_registered"))

    def test_keycloak_교환_응답과_CORS(self):
        r, out = self.exchange(self.kc_token())
        self.assertEqual(r.status, 200, out)
        self.assertEqual(set(out), {"token", "expires", "sticky", "protocol", "ws", "agent"})
        self.assertEqual(out["agent"], "")                                      # 앱에 기본 AI 에이전트를 두지 않았다
        self.assertTrue(out["token"].startswith("aas_emb_"))
        self.assertAlmostEqual(out["expires"], time.time() + embed.TOKEN_TTL, delta=30)
        self.assertEqual(out["sticky"], self.server._sticky_value(ALICE))
        self.assertEqual((out["protocol"], out["ws"]), (embed.PROTOCOL, True))
        self.assertEqual(r.getheader("Access-Control-Allow-Origin"), KC_ORIGIN)
        self.assertIn("Origin", r.getheader("Vary"))
        self.assertIsNone(r.getheader("Access-Control-Allow-Credentials"))
        self.assertEqual(r.getheader("X-Frame-Options"), "DENY")
        self.assertEqual(self.jwks.calls, [JWKS_URL])

    def test_keycloak_토큰_거절(self):
        other = embed_keys.key("kc2")
        cases = {
            "서명 틀림": (self.kc_token(key=other), 401, "token_mismatch"),   # 설정 불일치 — 다시 로그인해도 풀리지 않는다(OMAI-1908)
            "만료": (self.kc_token(exp=time.time() - 120), 401, "token_invalid"),
            "다른 iss": (self.kc_token(iss="https://kc.embed.example/realms/other"), 401, "token_mismatch"),
            "aud 없고 azp 만": (self.kc_token(aud="account", azp=AUD), 401, "token_mismatch"),
            "email_verified 거짓": (self.kc_token(email_verified=False), 403, "user_unknown"),
            "AAS 에 없는 사람": (self.kc_token(STRANGER), 403, "user_unknown"),
            "alg none": (embed_keys.b64(b'{"alg":"none"}') + "." + self.kc_token().split(".")[1] + ".", 401, "token_invalid"),
        }
        for name, (assertion, status, code) in cases.items():
            with self.subTest(name):
                r, out = self.exchange(assertion)
                self.assertEqual((r.status, out["error"]), (status, code), out)
                self.assertNotIn("token", out)

    def test_새_kid_는_다시_받아_통과(self):
        self.embed_token()
        k2 = embed_keys.key("kc2")
        self.jwks.keys["k2"] = k2.jwk("k2")
        r, out = self.exchange(self.kc_token(key=k2, kid="k2"))
        self.assertEqual(r.status, 200, out)
        self.assertEqual(len(self.jwks.calls), 2)

    def test_JWKS_를_못_받으면_503(self):
        self.jwks.fail = urllib.error.URLError(ssl.SSLCertVerificationError(1, "certificate verify failed"))
        with redirect_stdout(io.StringIO()):
            r, out = self.exchange(self.kc_token())
        self.assertEqual((r.status, out["error"]), (503, "idp_unreachable"))

    def test_Keycloak_구성원_거절과_장애(self):
        with mock.patch.object(self.mcp, "member", lambda email: False):
            r, out = self.exchange(self.kc_token())
        self.assertEqual((r.status, out["error"]), (403, "user_unknown"))
        with mock.patch.object(self.mcp, "member", lambda email: None):
            r, out = self.exchange(self.kc_token())
        self.assertEqual((r.status, out["error"]), (503, "idp_unreachable"))
        with mock.patch.object(self.mcp, "member", lambda email: True), mock.patch.object(self.mcp, "_keycloak", lambda: object()):
            r, out = self.exchange(self.kc_token(STRANGER))                    # Keycloak 이 있는 설치는 그 구성원 확인으로 들인다
        self.assertEqual(r.status, 200, out)

    def test_host_signed_교환(self):
        r, out = self.exchange(self.host_token(), PORTAL_ORIGIN)
        self.assertEqual(r.status, 200, out)
        self.assertEqual(self.jwks.calls, [])                                   # 밖으로 나가는 호출이 없다
        token = self.host_token(jti="same-jti")
        self.assertEqual(self.exchange(token, PORTAL_ORIGIN)[0].status, 200)
        r, out = self.exchange(token, PORTAL_ORIGIN)                            # jti 재사용
        self.assertEqual((r.status, out["error"]), (401, "token_invalid"))
        r, out = self.exchange(self.host_token(exp=time.time() + 600), PORTAL_ORIGIN)   # 5분 초과 — 호스트 서버 설정이 틀렸다(OMAI-1908)
        self.assertEqual((r.status, out["error"]), (401, "token_mismatch"))
        r, out = self.exchange(self.host_token(aud="https://other-aas.example"), PORTAL_ORIGIN)
        self.assertEqual((r.status, out["error"]), (401, "token_mismatch"))
        r, out = self.exchange(self.host_token(iss=KC_APP), PORTAL_ORIGIN)
        self.assertEqual((r.status, out["error"]), (401, "token_mismatch"))
        r, out = self.exchange(self.host_token(STRANGER), PORTAL_ORIGIN)
        self.assertEqual((r.status, out["error"]), (403, "user_unknown"))
        r, out = self.exchange(self.host_token(), KC_ORIGIN)                   # 다른 앱의 출처 — 그 앱(keycloak)의 규칙으로 본다
        self.assertEqual(r.status, 401)

    def test_웹소켓이_꺼진_설치는_ws_false(self):
        with mock.patch.dict(os.environ, {"AAS_WS": "off"}):
            r, out = self.exchange(self.kc_token())
        self.assertEqual((r.status, out["ws"]), (200, False))

    def test_로그인을_끈_설치는_교환_거절(self):
        from aas.auth import auth
        saved = self.server._auth
        self.server._auth = auth.Auth({"issuer": "", "client_id": "", "client_secret": "", "domain": "", "public_url": self.base,
                                       "hours": 1, "users_file": Path(TMP.name) / "no-users.json"})
        try:
            r, out = self.exchange(self.kc_token())
            self.assertEqual((r.status, out["error"]), (403, "auth_disabled"))
        finally:
            self.server._auth = saved
        token = self.embed_token()
        self.server._auth = auth.Auth({"issuer": "", "client_id": "", "client_secret": "", "domain": "", "public_url": self.base,
                                       "hours": 1, "users_file": Path(TMP.name) / "no-users.json"})
        try:                                                                    # 앞서 받은 토큰도 받지 않는다(모든 에이전트가 보이게 된다)
            r, out = self.req("GET", "/api/me", origin=KC_ORIGIN, token=token)
            self.assertEqual((r.status, out["error"]), (401, "token_invalid"))
        finally:
            self.server._auth = saved

    def test_요청_한도는_MCP_와_같은_값(self):
        from aas.auth import mcp_limits
        token = self.embed_token()
        with mock.patch.object(mcp_limits, "per_minute", lambda: 2):
            codes = [self.req("GET", "/api/me", origin=KC_ORIGIN, token=token)[0].status for _ in range(3)]
        self.assertEqual(codes[-1], 429)
        r, out = self.req("GET", "/api/me", origin=KC_ORIGIN, token=token)
        self.assertEqual(r.status, 200)                                         # 한도를 되돌리면 다시 된다(같은 분 300회)

    # ---- 채팅 API 가 임베드 토큰을 받는다 ----------------------------------------------------------
    def test_임베드_토큰으로_채팅_보내기(self):
        token = self.embed_token()
        r, out = self.req("POST", "/api/chat/session", {"pod": "em-a", "profile": "main"}, KC_ORIGIN, token)
        self.assertEqual(r.status, 200, out)
        self.assertEqual(r.getheader("Access-Control-Allow-Origin"), KC_ORIGIN)
        self.assertIsNone(r.getheader("Access-Control-Allow-Credentials"))
        self.assertIsNone(r.getheader("Set-Cookie"))                            # 임베드 요청에는 쿠키를 쓰지 않는다
        sid = out["session_id"]
        r, out = self.req("POST", "/api/chat/send", {"pod": "em-a", "session_id": sid, "text": "안녕"}, KC_ORIGIN, token)
        self.assertEqual(r.status, 200, out)
        self.assertIn(("send", sid, "안녕", ALICE, None), self.hubs["em-a"].calls)
        r, out = self.req("GET", "/api/chat/status?pod=em-a", origin=KC_ORIGIN, token=token)
        self.assertEqual(r.status, 200, out)

    def test_허용_목록_밖의_pod_는_403(self):
        token = self.embed_token()
        r, out = self.req("GET", "/api/chat/status?pod=em-b", origin=KC_ORIGIN, token=token)
        self.assertEqual(r.status, 403, out)
        r, out = self.req("POST", "/api/chat/session", {"pod": "em-b", "profile": "main"}, KC_ORIGIN, token)
        self.assertEqual(r.status, 403, out)

    def test_관리_경로와_받아쓰기는_401(self):
        token = self.embed_token(BOSS)
        for method, path in (("GET", "/api/admin/users"), ("GET", "/api/users"), ("GET", "/api/office"), ("GET", "/api/tokens"),
                             ("POST", "/api/chat/transcribe"), ("POST", "/api/chat/speak"), ("POST", "/api/agents"), ("GET", "/")):
            with self.subTest(path):
                r, out = self.req(method, path, {} if method == "POST" else None, KC_ORIGIN, token)
                self.assertEqual((r.status, out["error"]), (401, "path_not_allowed"))

    def test_api_me_는_관리자_권한_없이(self):
        r, out = self.req("GET", "/api/me", origin=KC_ORIGIN, token=self.embed_token(BOSS))
        self.assertEqual(r.status, 200, out)
        self.assertEqual((out["user"]["email"], out["user"]["via"], out["admin"]), (BOSS, "embed", False))   # 등록부 관리자여도
        r, out = self.req("GET", "/api/me", origin=KC_ORIGIN, token=self.embed_token(ALICE))
        self.assertEqual([p["id"] for p in out["pods"]], ["em-a"])

    def test_다른_출처에_묶인_토큰은_거절(self):
        token = self.embed_token()
        r, out = self.req("GET", "/api/me", origin=PORTAL_ORIGIN, token=token)
        self.assertEqual((r.status, out["error"]), (401, "token_invalid"))
        self.assertEqual(r.getheader("Access-Control-Allow-Origin"), PORTAL_ORIGIN)   # 등록된 출처라 위젯이 읽을 수는 있다
        r, out = self.req("GET", "/api/me", origin=EVIL, token=token)
        self.assertEqual(r.status, 401)
        self.assertIsNone(r.getheader("Access-Control-Allow-Origin"))
        r, out = self.req("GET", "/api/me", token=token)                       # Origin 없음
        self.assertEqual(r.status, 401)

    def test_mcp_는_임베드_토큰을_받지_않는다(self):
        token = self.embed_token()
        body = {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2025-06-18"}}
        r, out = self.req("POST", "/mcp", body, token=token)
        self.assertEqual(r.status, 401, out)
        row, denied = self.mcp._authenticate(token)                             # 표가 달라 /mcp 자체도 받지 않는다
        self.assertIsNone(row)
        self.assertEqual(denied.status_code, 401)

    def test_쿠키만_있고_Origin_다른_기존_요청은_막힌다(self):
        cookie = self.login(ALICE)
        r, out = self.req("POST", "/api/chat/session", {"pod": "em-a", "profile": "main"}, KC_ORIGIN,
                          headers={"Cookie": cookie, "X-AAS": "1"})
        self.assertEqual(r.status, 403, out)
        self.assertIsNone(r.getheader("Access-Control-Allow-Origin"))
        r, out = self.req("GET", "/api/me", origin=KC_ORIGIN, headers={"Cookie": cookie})
        self.assertIsNone(r.getheader("Access-Control-Allow-Origin"))          # 쿠키 요청에는 CORS 를 붙이지 않는다
        r, out = self.req("POST", "/api/chat/session", {"pod": "em-a", "profile": "main"}, headers={"Cookie": cookie, "X-AAS": "1"})
        self.assertEqual(r.status, 200, out)                                    # 같은 출처 화면은 그대로

    def test_임베드_요청의_쿠키는_버린다(self):
        cookie = self.login(BOSS)
        r, out = self.req("GET", "/api/me", origin=KC_ORIGIN, token=self.embed_token(ALICE), headers={"Cookie": cookie})
        self.assertEqual((r.status, out["user"]["email"], out["admin"]), (200, ALICE, False))

    def test_사전_요청(self):
        h = {"Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "authorization, content-type"}
        r, _ = self.req("OPTIONS", "/api/chat/send", origin=KC_ORIGIN, headers=h)
        self.assertEqual(r.status, 204)
        self.assertEqual(r.getheader("Access-Control-Allow-Origin"), KC_ORIGIN)
        self.assertEqual(r.getheader("Access-Control-Max-Age"), "600")
        self.assertIn("Authorization", r.getheader("Access-Control-Allow-Headers"))
        self.assertIn("POST", r.getheader("Access-Control-Allow-Methods"))
        self.assertIsNone(r.getheader("Access-Control-Allow-Credentials"))
        self.assertIn("Date", r.getheader("Access-Control-Expose-Headers"))  # 화면이 서버 시계 차이를 잰다
        r, _ = self.req("OPTIONS", "/api/chat/send", origin=EVIL, headers=h)
        self.assertEqual(r.status, 403)
        self.assertIsNone(r.getheader("Access-Control-Allow-Origin"))
        r, _ = self.req("OPTIONS", "/api/users", origin=KC_ORIGIN, headers=h)  # 허용 경로가 아니면 손대지 않는다
        self.assertIsNone(r.getheader("Access-Control-Allow-Origin"))
        r, _ = self.req("OPTIONS", "/api/embed/token", origin=EVIL, headers=h)  # 교환은 어느 출처든 403 을 읽을 수 있게
        self.assertEqual((r.status, r.getheader("Access-Control-Allow-Origin")), (204, EVIL))

    def test_토큰_폐기(self):
        token = self.embed_token()
        r, out = self.req("POST", "/api/embed/token/revoke", {}, KC_ORIGIN, token)
        self.assertEqual((r.status, out), (200, {"ok": True, "revoked": True}))
        self.assertEqual(r.getheader("Access-Control-Allow-Origin"), KC_ORIGIN)
        r, out = self.req("GET", "/api/me", origin=KC_ORIGIN, token=token)
        self.assertEqual(r.status, 401)
        r, out = self.req("POST", "/api/embed/token/revoke", {}, KC_ORIGIN, token)
        self.assertEqual((r.status, out["revoked"]), (200, False))
        r, out = self.req("POST", "/api/embed/token/revoke", {}, EVIL, token)
        self.assertEqual(r.status, 403)

    def test_인증서_확인_페이지(self):
        r, body = self.req("GET", "/embed/cert")
        self.assertEqual(r.status, 200)
        self.assertTrue(r.getheader("Content-Type").startswith("text/html"))
        self.assertEqual(r.getheader("X-Frame-Options"), "DENY")
        self.assertIn(b"window.close", body)
        self.assertNotIn(b"aas_session", body)

    def test_위젯_파일_자리(self):
        with tempfile.TemporaryDirectory() as d, mock.patch.object(self.server, "STATIC_DIR", Path(d)):
            r, _ = self.req("GET", "/static/js/aas-widget.js")
            self.assertEqual(r.status, 404)                                     # 빌드 전에는 없다
            (Path(d) / "js").mkdir()
            (Path(d) / "js" / "aas-widget.js").write_text("window.CogentAIAASWidget={};")
            r, body = self.req("GET", "/static/js/aas-widget.js")               # 로그인 없이 받는다(호스트의 script 태그)
            self.assertEqual((r.status, body), (200, b"window.CogentAIAASWidget={};"))
            self.assertTrue(r.getheader("Content-Type").startswith("text/javascript"))
            r, _ = self.req("GET", "/static/js/aas-widget-init.js")
            self.assertEqual(r.status, 404)
            (Path(d) / "js" / "aas-widget-init.js").write_text("window.__COGENTAI_AAS__;")
            r, body = self.req("GET", "/static/js/aas-widget-init.js")          # 주입 스크립트도 같은 자리·같은 규칙
            self.assertEqual((r.status, body), (200, b"window.__COGENTAI_AAS__;"))
            (Path(d) / "js" / "other.js").write_text("x")
            r, _ = self.req("GET", "/static/js/other.js")                       # 두 파일 밖은 이 경로가 내보내지 않는다(로그인 화면으로 간다)
            self.assertNotEqual(r.status, 200)

    def test_교환은_동시에_와도_각각_토큰(self):
        out, errors = [], []

        def one():
            try:
                r, body = self.exchange(self.kc_token())
                out.append((r.status, body.get("token")))
            except Exception as exc:                                            # noqa: BLE001
                errors.append(exc)
        threads = [threading.Thread(target=one) for _ in range(4)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        self.assertEqual(errors, [])
        self.assertEqual(len({t for s, t in out if s == 200}), 4)


class EmbedAdminApiTest(unittest.TestCase):
    """관리 › 임베드 앱 API(/api/admin/embed-apps). 서버 띄우기·요청 도우미는 EmbedHttpTest 의 것을 그대로 쓴다."""
    setUpClass = classmethod(EmbedHttpTest.setUpClass.__func__)
    tearDownClass = classmethod(EmbedHttpTest.tearDownClass.__func__)
    req, login, kc_token, exchange = EmbedHttpTest.req, EmbedHttpTest.login, EmbedHttpTest.kc_token, EmbedHttpTest.exchange
    PATH = "/api/admin/embed-apps"

    def setUp(self):
        _cleanup_db()
        embed.forget_jwks()
        self.jwks = FakeJwks()
        self.jwks.keys = {"k1": self.k1.jwk("k1")}
        p = mock.patch.object(tls, "urlopen", self.jwks)
        p.start()
        self.addCleanup(p.stop)
        self.boss, self.alice = self.login(BOSS), self.login(ALICE)

    def api(self, method, cookie, body=None, headers=None):
        h = {"Cookie": cookie, **({"X-AAS": "1"} if method == "POST" else {}), **(headers or {})}
        return self.req(method, self.PATH, body, headers=h)

    def kc_body(self, **over):
        return {"action": "save", "name": "COP Console", "origins": [KC_ORIGIN], "mode": "keycloak", "issuer": ISSUER, "jwks_url": JWKS_URL,
                "audience": AUD, "idp_policy_checked": True, **over}

    def test_관리자만(self):
        r, out = self.api("GET", self.alice)
        self.assertEqual(r.status, 403, out)
        r, out = self.api("POST", self.alice, self.kc_body())
        self.assertEqual(r.status, 403, out)
        self.assertEqual(embed.list_apps(), [])
        r, out = self.req("GET", self.PATH)                                      # 로그인 안 함
        self.assertEqual(r.status, 401)

    def test_CSRF_는_기존_관리자_API_와_같다(self):
        r, _ = self.req("POST", self.PATH, self.kc_body(), headers={"Cookie": self.boss})            # X-AAS 없음
        self.assertEqual(r.status, 403)
        r, _ = self.api("POST", self.boss, self.kc_body(), headers={"Origin": "https://evil.example"})   # 다른 출처
        self.assertEqual(r.status, 403)
        self.assertEqual(embed.list_apps(), [])

    def test_임베드_토큰으로는_부를_수_없다(self):
        embed.add_app("COP", [KC_ORIGIN], "keycloak", app_id=KC_APP, issuer=ISSUER, jwks_url=JWKS_URL, audience=AUD)
        r, out = self.exchange(self.kc_token(BOSS))
        self.assertEqual(r.status, 200, out)
        for method in ("GET", "POST"):                                          # 등록부 관리자(BOSS)의 토큰이어도
            with self.subTest(method):
                r, body = self.req(method, self.PATH, self.kc_body() if method == "POST" else None, KC_ORIGIN, out["token"])
                self.assertEqual((r.status, body["error"]), (401, "path_not_allowed"))

    def test_목록_등록_고치기_지우기(self):
        r, out = self.api("GET", self.boss)
        self.assertEqual(r.status, 200, out)
        self.assertEqual((out["apps"], out["modes"], out["auth_enabled"]), ([], ["keycloak", "host-signed"], True))
        self.assertEqual(out["audiences"], [self.base])                          # host-signed 토큰의 aud
        self.assertEqual(out["agents"], ["em-a", "em-b"])
        # keycloak 모드는 호스트 realm 정책 확인 칸이 없으면 저장하지 않는다(CLI --idp-policy-checked 와 같다)
        r, out = self.api("POST", self.boss, self.kc_body(idp_policy_checked=False))
        self.assertEqual((r.status, out["field"]), (400, "idp_policy_checked"))
        self.assertEqual(embed.list_apps(), [])
        r, out = self.api("POST", self.boss, self.kc_body(default_agent="em-zz"))
        self.assertEqual((r.status, out["field"]), (400, "default_agent"))
        r, out = self.api("POST", self.boss, self.kc_body(origins=f"{KC_ORIGIN}\n{PORTAL_ORIGIN}", default_agent="em-a"))   # 줄마다 하나도 받는다
        self.assertEqual(r.status, 200, out)
        app = out["app"]
        self.assertEqual((app["origins"], app["default_agent"]), ([KC_ORIGIN, PORTAL_ORIGIN], "em-a"))
        # 교환 응답에 기본 AI 에이전트가 실린다
        r, ex = self.exchange(self.kc_token())
        self.assertEqual((r.status, ex["agent"]), (200, "em-a"))
        # 다른 앱이 같은 출처를 가져가려 하면 칸 이름과 함께 400
        r, out = self.api("POST", self.boss, {"action": "save", "name": "Portal", "origins": [PORTAL_ORIGIN], "mode": "host-signed",
                                              "public_jwk": json.dumps(self.host_key.jwk())})
        self.assertEqual((r.status, out["field"]), (400, "origins"))
        r, out = self.api("POST", self.boss, {"action": "save", "name": "Portal", "origins": ["https://p2.example"], "mode": "host-signed",
                                              "public_jwk": "{not json"})
        self.assertEqual((r.status, out["field"]), (400, "public_jwk"))
        # 고치기: keycloak 을 host-signed 로 — 정책 확인 칸은 keycloak 모드에서만 필요하다
        r, out = self.api("POST", self.boss, {"action": "save", "app_id": app["app_id"], "name": "Portal", "origins": [PORTAL_ORIGIN],
                                              "mode": "host-signed", "public_jwk": json.dumps(self.host_key.jwk())})
        self.assertEqual(r.status, 200, out)
        self.assertEqual((out["app"]["mode"], out["app"]["origins"], out["app"]["issuer"]), ("host-signed", [PORTAL_ORIGIN], ""))
        r, ex = self.exchange(self.kc_token())                                   # 뺀 출처
        self.assertEqual((r.status, ex["error"]), (403, "origin_not_registered"))
        r, out = self.api("POST", self.boss, {"action": "save", "app_id": "emb_none", **self.kc_body(origins=["https://x.example"])})
        self.assertEqual((r.status, out["field"]), (404, "app_id"))
        r, out = self.api("GET", self.boss)
        self.assertEqual([a["name"] for a in out["apps"]], ["Portal"])
        self.assertEqual(json.loads(out["apps"][0]["public_jwk"]), self.host_key.jwk())   # 공개 키는 고치기 화면에 그대로
        # 지우기
        r, out = self.api("POST", self.boss, {"action": "remove", "app_id": app["app_id"]})
        self.assertEqual((r.status, out["ok"]), (200, True))
        r, out = self.api("POST", self.boss, {"action": "remove", "app_id": app["app_id"]})
        self.assertEqual(r.status, 404)
        r, out = self.api("POST", self.boss, {"action": "nope"})
        self.assertEqual(r.status, 400)

    def test_웹소켓_읽기로도_같은_답(self):
        """화면의 get() 은 웹소켓이 live 면 req 로 같은 처리기를 부른다 — 레거시 처리기에 두어야 HTTP 와 같은 답이 온다."""
        from aas.web import legacy
        raw = (f"GET {self.PATH} HTTP/1.1\r\nHost: 127.0.0.1:{self.port}\r\nCookie: {self.boss}\r\nSec-Fetch-Site: same-origin\r\n\r\n").encode()
        h = legacy.AdaptedHandler(raw, ("127.0.0.1", 1), False, None)
        h.run()
        status, _headers, body = legacy._parse(h.wfile.getvalue())
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body)["apps"], [])


if __name__ == "__main__":
    unittest.main()

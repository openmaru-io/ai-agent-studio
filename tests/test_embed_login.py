# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""임베드 위젯의 내장 팝업 로그인(OMAI-1911): 호스트 realm OIDC 로그인 → 연결 화면 → verifier 로 승인 → 꺼내기 → 갱신.

서버 띄우기·요청 도우미는 test_embed_auth 의 EmbedHttpTest 것을 그대로 쓴다. Keycloak 은 aas.auth.tls.urlopen 대역이
주소로 나눠 흉내 낸다(JWKS·토큰 엔드포인트·revoke).
"""
import http.client
import io
import json
import re
import threading
import time
import unittest
import urllib.error
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from unittest import mock
from urllib.parse import parse_qs, quote, urlsplit

import test_embed_auth as base  # noqa: E402  (AAS_DATA_DIR 을 먼저 정한다)
import embed_keys  # noqa: E402

from aas.auth import embed, tls  # noqa: E402

ALICE, BOB, STRANGER = base.ALICE, base.BOB, base.STRANGER
KC_ORIGIN, PORTAL_ORIGIN, EVIL = base.KC_ORIGIN, base.PORTAL_ORIGIN, base.EVIL
ISSUER, JWKS_URL, AUD, KC_APP, HOST_APP = base.ISSUER, base.JWKS_URL, base.AUD, base.KC_APP, base.HOST_APP
TOKEN_URL = JWKS_URL[:-len("/certs")] + "/token"
REVOKE_URL = JWKS_URL[:-len("/certs")] + "/revoke"
LOGIN_CLIENT, LOGIN_SECRET = "aas-embed-login", "login-secret-123"
NONCE = "n" * 43
VERIFIER = "v" * 43
OTHER_APP, OTHER_ORIGIN = "em-kc-nologin", "https://nologin.embed.example"


class FakeKc:
    """tls.urlopen 대역. 주소로 JWKS·토큰 엔드포인트·revoke 를 나눈다."""

    def __init__(self, key):
        self.key = key
        self.keys = {"k1": key.jwk("k1")}
        self.calls, self.token_requests, self.revoked = [], [], []
        self.headers: list[dict] = []        # 요청마다 보낸 헤더(소문자 키)
        self.nonce = ""                     # 다음 id_token 에 넣을 OIDC nonce(시작 302 에서 읽는다)
        self.over = {}                      # id_token claim 덮어쓰기
        self.refresh_over = None            # 갱신 응답의 id_token claim(None 이면 id_token 없이 준다)
        self.refresh_fail = None            # 갱신에서 낼 HTTP 상태
        self.barrier = None                 # 갱신을 동시에 두 개 받기
        self.signer = key
        self.rt_n = 0
        self.lock = threading.Lock()

    def id_token(self, **over):
        now = time.time()
        c = {"iss": ISSUER, "aud": LOGIN_CLIENT, "azp": LOGIN_CLIENT, "sub": "host-sub", "exp": now + 300, "iat": now,
             "email": ALICE, "email_verified": True, "nonce": self.nonce, **self.over, **over}
        return embed_keys.jwt({k: v for k, v in c.items() if v is not None}, self.signer, "k1")

    def _rt(self):
        with self.lock:
            self.rt_n += 1
            return f"rt-{self.rt_n}"

    def __call__(self, req, timeout):
        url = req.full_url
        self.calls.append(url)
        self.headers.append({k.lower(): v for k, v in req.header_items()})
        if url == JWKS_URL:
            return io.BytesIO(json.dumps({"keys": list(self.keys.values())}).encode())
        form = {k: v[0] for k, v in parse_qs((req.data or b"").decode()).items()}
        if url == REVOKE_URL:
            self.revoked.append(form)
            return io.BytesIO(b"")
        if url == TOKEN_URL:
            self.token_requests.append(form)
            if form.get("grant_type") == "refresh_token":
                if self.barrier is not None:
                    self.barrier.wait(timeout=5)
                if self.refresh_fail:
                    raise urllib.error.HTTPError(url, self.refresh_fail, "Bad Request", {}, io.BytesIO(b'{"error":"invalid_grant"}'))
                out = {"access_token": "at", "refresh_token": self._rt()}
                if self.refresh_over is not None:
                    out["id_token"] = self.id_token(nonce=None, **self.refresh_over)
                return io.BytesIO(json.dumps(out).encode())
            return io.BytesIO(json.dumps({"access_token": "at", "id_token": self.id_token(), "refresh_token": self._rt()}).encode())
        raise urllib.error.URLError(f"unexpected {url}")


class EmbedLoginTest(unittest.TestCase):
    setUpClass = classmethod(base.EmbedHttpTest.setUpClass.__func__)
    tearDownClass = classmethod(base.EmbedHttpTest.tearDownClass.__func__)
    req, login = base.EmbedHttpTest.req, base.EmbedHttpTest.login
    kc_token, exchange = base.EmbedHttpTest.kc_token, base.EmbedHttpTest.exchange

    def setUp(self):
        _cleanup()
        embed.forget_jwks()
        embed.add_app("COP", [KC_ORIGIN], "keycloak", app_id=KC_APP, issuer=ISSUER, jwks_url=JWKS_URL, audience=AUD,
                      login_client_id=LOGIN_CLIENT, login_client_secret=LOGIN_SECRET)
        embed.add_app("NoLogin", [OTHER_ORIGIN], "keycloak", app_id=OTHER_APP, issuer=ISSUER, jwks_url=JWKS_URL, audience=AUD)
        embed.add_app("Portal", [PORTAL_ORIGIN], "host-signed", app_id=HOST_APP, public_jwk=json.dumps(self.host_key.jwk()))
        self.kc = FakeKc(self.k1)
        p = mock.patch.object(tls, "urlopen", self.kc)
        p.start()
        self.addCleanup(p.stop)

    # ---- 도우미 ---------------------------------------------------------------------------------
    def get(self, path, headers=None):
        c = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        c.request("GET", path, headers=headers or {})
        r = c.getresponse()
        body = r.read()
        c.close()
        return r, body

    def begin(self, origin=KC_ORIGIN, nonce=NONCE):
        r, body = self.get(f"/embed/login?o={quote(origin, safe='')}&n={nonce}")
        self.assertEqual(r.status, 302, body)
        q = {k: v[0] for k, v in parse_qs(urlsplit(r.getheader("Location")).query).items()}
        self.kc.nonce = q["nonce"]
        cookie = r.getheader("Set-Cookie")
        return q, cookie.split(";")[0], r

    def callback(self, state, cookie, code="code-1", extra=""):
        h = {"Cookie": cookie} if cookie else {}
        return self.get(f"/embed/login/callback?state={quote(state)}&code={code}{extra}", h)

    def connected(self, origin=KC_ORIGIN, nonce=NONCE):
        """시작 → 콜백. 연결 화면에서 confirm 비밀을 꺼내 돌려준다."""
        q, cookie, _ = self.begin(origin, nonce)
        r, body = self.callback(q["state"], cookie)
        self.assertEqual(r.status, 200, body)
        return re.search(rb'"secret":\s*"([^"]+)"', body).group(1).decode()

    def confirm(self, secret, verifier=VERIFIER, origin=None):
        return self.req("POST", "/embed/login/confirm", {"secret": secret, "verifier": verifier},
                        headers={"Origin": origin or self.base} if origin != "" else {})

    def redeem(self, nonce=NONCE, verifier=VERIFIER, origin=KC_ORIGIN):
        return self.req("POST", "/api/embed/token", {"login": nonce, "verifier": verifier}, origin)

    def refresh(self, token, verifier=VERIFIER, origin=KC_ORIGIN):
        return self.req("POST", "/api/embed/token", {"refresh": token, "verifier": verifier}, origin)

    def logged_in(self, nonce=NONCE, verifier=VERIFIER):
        secret = self.connected(nonce=nonce)
        r, out = self.confirm(secret, verifier)
        self.assertEqual(r.status, 200, out)
        r, out = self.redeem(nonce, verifier)
        self.assertEqual(r.status, 200, out)
        return out

    def sessions(self):
        with embed._conn() as conn:
            return [dict(r) for r in conn.execute("SELECT * FROM embed_login_sessions")]

    # ---- 시작 -------------------------------------------------------------------------------------
    def test_시작은_호스트_realm_인가_주소로_302_PKCE_쿠키(self):
        q, cookie, r = self.begin()
        loc = r.getheader("Location")
        self.assertTrue(loc.startswith(ISSUER + "/protocol/openid-connect/auth?"), loc)
        self.assertEqual((q["client_id"], q["response_type"], q["scope"], q["code_challenge_method"]),
                         (LOGIN_CLIENT, "code", "openid email", "S256"))
        self.assertEqual(q["redirect_uri"], self.base + "/embed/login/callback")
        self.assertTrue(q["state"] and q["nonce"] and q["code_challenge"])
        self.assertNotIn("offline_access", q["scope"])
        raw = r.getheader("Set-Cookie")
        self.assertTrue(raw.startswith("__Host-aas_embed_login_"), raw)          # 탭마다 이름이 따로다
        for attr in ("HttpOnly", "Secure", "SameSite=Lax", "Path=/"):
            self.assertIn(attr, raw)
        self.assertNotIn(q["state"], raw)                                        # 쿠키에는 state 해시만
        self.assertEqual(r.getheader("Referrer-Policy"), "no-referrer")
        with embed._conn() as conn:                                              # nonce 원문은 키가 아니다
            row = dict(conn.execute("SELECT * FROM embed_login").fetchone())
        self.assertEqual(row["nonce_hash"], embed._hash(NONCE))
        self.assertNotIn(q["state"], json.dumps(row))
        self.assertEqual((row["origin"], row["app_id"]), (KC_ORIGIN, KC_APP))

    def test_시작_거절은_어디로도_보내지_않는다(self):
        for name, origin, nonce in (("등록 안 된 출처", EVIL, NONCE), ("로그인 클라이언트 없음", OTHER_ORIGIN, NONCE),
                                    ("host-signed", PORTAL_ORIGIN, NONCE), ("nonce 형식", KC_ORIGIN, "short"),
                                    ("nonce 문자", KC_ORIGIN, "x" * 30 + "!" + "y" * 12)):
            with self.subTest(name):
                r, body = self.get(f"/embed/login?o={quote(origin, safe='')}&n={quote(nonce)}")
                self.assertEqual(r.status, 400, body)
                self.assertIsNone(r.getheader("Location"))
                self.assertIsNone(r.getheader("Set-Cookie"))
        with embed._conn() as conn:
            self.assertEqual(conn.execute("SELECT COUNT(*) AS n FROM embed_login").fetchone()["n"], 0)

    # ---- 콜백 -------------------------------------------------------------------------------------
    def test_콜백_쿠키가_없거나_다르면_거절_하고_행은_남긴다(self):
        q, cookie, _ = self.begin()
        name = cookie.split("=", 1)[0]
        for c in ("", f"{name}=" + "0" * 64, "__Host-aas_embed_login_0000000000000000=" + cookie.split("=", 1)[1]):
            r, body = self.callback(q["state"], c)
            self.assertEqual(r.status, 400, body)
            self.assertIsNone(r.getheader("Location"))
        self.assertEqual(self.kc.token_requests, [])                             # 코드를 Keycloak 에 보내지도 않았다
        r, body = self.callback(q["state"], cookie)                              # 쿠키가 맞으면 아직 된다
        self.assertEqual(r.status, 200, body)
        r, body = self.callback(q["state"], cookie)                              # state 는 한 번만
        self.assertEqual(r.status, 400, body)

    def test_콜백은_코드를_서버_안_주소로_바꾼다(self):
        q, cookie, _ = self.begin()
        r, _ = self.callback(q["state"], cookie, code="the-code")
        self.assertEqual(r.status, 200)
        form = self.kc.token_requests[0]
        self.assertEqual((form["grant_type"], form["code"], form["client_id"], form["client_secret"], form["redirect_uri"]),
                         ("authorization_code", "the-code", LOGIN_CLIENT, LOGIN_SECRET, q["redirect_uri"]))
        self.assertTrue(len(form["code_verifier"]) >= 43)
        with embed._conn() as conn:                                              # refresh token 원문은 DB 에 두지 않는다
            row = dict(conn.execute("SELECT * FROM embed_login").fetchone())
        self.assertNotIn("rt-1", json.dumps(row))

    def test_id_token_거절(self):
        other = embed_keys.key("kc2")
        cases = {
            "서명": {"signer": other},
            "iss 가 서버 안 주소": {"iss": JWKS_URL[:-len("/protocol/openid-connect/certs")]},
            "aud": {"aud": "account"},
            "azp": {"aud": [LOGIN_CLIENT, "account"], "azp": "account"},
            "nonce": {"nonce": "other-nonce"},
            "만료": {"exp": time.time() - 600},
            "email_verified 거짓": {"email_verified": False},
            "AAS 사용자 아님": {"email": STRANGER},
        }
        for name, over in cases.items():
            with self.subTest(name):
                self.kc.signer = over.pop("signer", self.k1)
                q, cookie, _ = self.begin()
                self.kc.over = over
                r, body = self.callback(q["state"], cookie)
                self.assertIn(r.status, (401, 403), body)
                self.assertIsNone(r.getheader("Location"))
                self.assertNotIn(b"postMessage", body)
                self.assertNotIn(b"location", body.lower().replace(b"no-referrer", b""))
                r, out = self.redeem()                                           # 실패한 로그인은 꺼낼 수 없다
                self.assertEqual((r.status, out["error"]), (401, "token_invalid"))
                self.kc.over, self.kc.signer = {}, self.k1

    def test_Keycloak_이_오류로_돌려보내면_오류_화면(self):
        q, cookie, _ = self.begin()
        r, body = self.get(f"/embed/login/callback?state={quote(q['state'])}&error=access_denied", {"Cookie": cookie})
        self.assertEqual(r.status, 400, body)
        self.assertIsNone(r.getheader("Location"))
        self.assertEqual(self.kc.token_requests, [])

    def test_연결_화면_헤더(self):
        q, cookie, _ = self.begin()
        r, body = self.callback(q["state"], cookie)
        self.assertEqual(r.status, 200)
        self.assertIsNone(r.getheader("Cross-Origin-Opener-Policy"))             # opener 를 끊지 않는다
        self.assertEqual(r.getheader("Referrer-Policy"), "no-referrer")
        self.assertEqual(r.getheader("Content-Security-Policy"),
                         "default-src 'none'; script-src 'unsafe-inline'; connect-src 'self'; form-action 'none'; frame-ancestors 'none'")
        self.assertEqual((r.getheader("X-Frame-Options"), r.getheader("Cache-Control")), ("DENY", "no-store"))
        self.assertIn(b"postMessage", body)
        self.assertIn(json.dumps(KC_ORIGIN).encode(), body)                      # 등록 출처로만 보낸다
        self.assertNotIn(b"'*'", body)
        self.assertIn(b"/embed/login/confirm", body)
        self.assertIn(cookie.split("=", 1)[0] + "=;", r.getheader("Set-Cookie"))  # 쓴 쿠키는 지운다

    # ---- 승인 -------------------------------------------------------------------------------------
    def test_verifier_로_승인_verifier_없이는_안_된다(self):
        secret = self.connected()
        r, out = self.redeem()
        self.assertEqual((r.status, out), (202, {"pending": True}))
        for name, (body, origin) in {"verifier 없음": ({"secret": secret}, None), "verifier 형식": ({"secret": secret, "verifier": "x"}, None),
                                      "다른 출처": ({"secret": secret, "verifier": VERIFIER}, EVIL),
                                      "Origin 없음": ({"secret": secret, "verifier": VERIFIER}, ""),
                                      "비밀 틀림": ({"secret": "s" * 32, "verifier": VERIFIER}, None)}.items():
            with self.subTest(name):
                h = {} if origin == "" else {"Origin": origin or self.base}
                r, out = self.req("POST", "/embed/login/confirm", body, headers=h)
                self.assertIn(r.status, (400, 401, 403), out)
                self.assertEqual(self.redeem()[0].status, 202)
        r, out = self.confirm(secret)
        self.assertEqual((r.status, out["ok"]), (200, True))
        r, out = self.confirm(secret, "w" * 43)                                  # 두 번째 승인으로 verifier 를 바꾸지 못한다
        self.assertEqual(r.status, 401, out)

    # ---- 꺼내기 -----------------------------------------------------------------------------------
    def test_꺼내기_202_후_200_한_번만(self):
        secret = self.connected()
        self.assertEqual(self.redeem()[0].status, 202)
        self.confirm(secret)
        r, out = self.redeem(verifier="w" * 43)                                  # verifier 불일치 — 행은 남는다
        self.assertEqual((r.status, out["error"], out["popup_login"]), (401, "token_invalid", True))
        r, out = self.redeem(origin=PORTAL_ORIGIN)                               # 다른 출처
        self.assertEqual(r.status, 401, out)
        r, out = self.redeem()
        self.assertEqual(r.status, 200, out)
        self.assertEqual(set(out), {"token", "expires", "sticky", "protocol", "ws", "agent", "refresh", "email"})
        self.assertEqual(out["email"], ALICE)                                    # 위젯이 사용자 바뀜을 이메일로 가린다
        self.assertIs(out["refresh"], True)
        self.assertEqual(r.getheader("Access-Control-Allow-Origin"), KC_ORIGIN)
        r, me = self.req("GET", "/api/me", origin=KC_ORIGIN, token=out["token"])
        self.assertEqual((r.status, me["user"]["email"]), (200, ALICE))
        r, again = self.redeem()
        self.assertEqual((r.status, again["error"]), (401, "token_invalid"))
        s = self.sessions()
        self.assertEqual(len(s), 1)
        self.assertNotIn("rt-1", json.dumps(s))                                  # 봉한 값만
        self.assertNotIn(VERIFIER, json.dumps(s))

    def test_두_탭이_함께_시작해도_둘_다_된다(self):
        n2 = "t" * 43
        q1, c1, _ = self.begin()
        q2, c2, _ = self.begin(nonce=n2)
        self.assertNotEqual(c1.split("=", 1)[0], c2.split("=", 1)[0])
        both = f"{c1}; {c2}"                                                     # 같은 브라우저라 쿠키가 둘 다 실린다
        self.kc.nonce = q2["nonce"]                                               # 가짜 Keycloak 은 다음 id_token 의 nonce 하나만 기억한다
        r, body = self.callback(q2["state"], both)                               # 나중에 시작한 쪽이 먼저 돌아와도
        self.assertEqual(r.status, 200, body)
        self.kc.nonce = q1["nonce"]
        r, body = self.callback(q1["state"], both, code="code-2")
        self.assertEqual(r.status, 200, body)

    def test_Keycloak_호출에_공개_issuer_의_X_Forwarded_헤더를_싣는다(self):
        # hostname 을 고정하지 않은 Keycloak(KC_HOSTNAME_STRICT=false, KC_PROXY_HEADERS=xforwarded)은 요청 호스트로 iss 를 정한다.
        # 서버 안 주소로 불러도 공개 issuer 로 토큰을 받게 한다(OMAI-1911, OKE COP realm 실측)
        first = self.logged_in()
        self.refresh(first["token"])
        sent = [h for u, h in zip(self.kc.calls, self.kc.headers) if u == TOKEN_URL]
        self.assertGreaterEqual(len(sent), 2)                                    # 코드 교환과 갱신
        for h in sent:
            self.assertEqual((h.get("x-forwarded-host"), h.get("x-forwarded-proto"), h.get("x-forwarded-port")),
                             ("kc.embed.example", "https", "443"))

    def test_꺼내기_5분_만료와_모르는_nonce(self):
        secret = self.connected()
        self.confirm(secret)
        with embed._conn() as conn:
            conn.execute("UPDATE embed_login SET expires=?", (time.time() - 1,))
        r, out = self.redeem()
        self.assertEqual((r.status, out["error"]), (401, "token_invalid"))
        r, out = self.redeem(nonce="m" * 43)
        self.assertEqual((r.status, out["error"]), (401, "token_invalid"))
        for bad in ({"login": "short", "verifier": VERIFIER}, {"login": NONCE}, {"login": NONCE, "verifier": 3}):
            r, out = self.req("POST", "/api/embed/token", bad, KC_ORIGIN)
            self.assertEqual((r.status, out["error"]), (401, "token_invalid"), bad)

    def test_꾸민_Origin_의_서버_간_꺼내기는_verifier_없이_실패(self):
        secret = self.connected()
        self.confirm(secret)
        for verifier in ("", "a" * 43):                                          # 공격자는 nonce 와 Origin 은 알아도 verifier 를 모른다
            r, out = self.req("POST", "/api/embed/token", {"login": NONCE, "verifier": verifier}, KC_ORIGIN)
            self.assertEqual(r.status, 401, out)
        self.assertEqual(self.redeem()[0].status, 200)

    # ---- 갱신 -------------------------------------------------------------------------------------
    def test_갱신_성공과_옛_토큰_폐기(self):
        first = self.logged_in()
        n = len(self.kc.token_requests)
        r, out = self.refresh(first["token"])
        self.assertEqual(r.status, 200, out)
        self.assertIs(out["refresh"], True)
        self.assertEqual(out["email"], ALICE)
        self.assertNotEqual(out["token"], first["token"])
        form = self.kc.token_requests[n]
        self.assertEqual((form["grant_type"], form["refresh_token"], form["client_id"], form["client_secret"]),
                         ("refresh_token", "rt-1", LOGIN_CLIENT, LOGIN_SECRET))
        self.assertEqual(self.req("GET", "/api/me", origin=KC_ORIGIN, token=first["token"])[0].status, 401)
        self.assertEqual(self.req("GET", "/api/me", origin=KC_ORIGIN, token=out["token"])[0].status, 200)
        r, again = self.refresh(first["token"])                                  # 옛 토큰으로 다시 갱신하지 못한다
        self.assertEqual((r.status, again["error"], again["popup_login"]), (401, "token_invalid", True))
        r, third = self.refresh(out["token"])                                    # 바뀐 refresh token(rt-2)으로 이어 간다
        self.assertEqual(r.status, 200, third)
        self.assertEqual(self.kc.token_requests[-1]["refresh_token"], "rt-2")

    def test_갱신_verifier_가_없거나_다르면_401(self):
        first = self.logged_in()
        for verifier in ("", "w" * 43):
            r, out = self.refresh(first["token"], verifier)
            self.assertEqual((r.status, out["error"], out["popup_login"]), (401, "token_invalid", True))
        r, out = self.req("POST", "/api/embed/token", {"refresh": first["token"]}, KC_ORIGIN)
        self.assertEqual(r.status, 401, out)
        r, out = self.refresh(first["token"], origin=PORTAL_ORIGIN)              # 다른 출처
        self.assertEqual(r.status, 401, out)
        self.assertEqual(self.refresh(first["token"])[0].status, 200)            # 실패가 세션을 끝내지는 않는다

    def test_만료된_임베드_토큰도_상한_안이면_갱신(self):
        first = self.logged_in()
        with embed._conn() as conn:                                              # 절전 뒤 복귀 — 15분이 지났다
            conn.execute("UPDATE embed_tokens SET expires=?", (time.time() - 3 * 3600,))
        embed.prune()                                                            # 정리가 세션을 지우지 않는다
        r, out = self.refresh(first["token"])
        self.assertEqual(r.status, 200, out)

    def test_세션_상한을_넘으면_401(self):
        first = self.logged_in()
        s = self.sessions()[0]
        self.assertAlmostEqual(s["expires"] - s["created"], 12 * 3600, delta=5)  # 기본 12시간
        self.assertLessEqual(first["expires"], s["expires"])
        with embed._conn() as conn:
            conn.execute("UPDATE embed_login_sessions SET expires=?", (time.time() - 1,))
        r, out = self.refresh(first["token"])
        self.assertEqual((r.status, out["error"], out["popup_login"]), (401, "token_invalid", True))

    def test_세션_상한은_환경변수(self):
        with mock.patch.dict("os.environ", {"AAS_EMBED_LOGIN_MAX_HOURS": "1"}):
            self.logged_in()
        s = self.sessions()[0]
        self.assertAlmostEqual(s["expires"] - s["created"], 3600, delta=5)

    def test_동시_갱신은_하나만_성공(self):
        first = self.logged_in()
        self.kc.barrier = threading.Barrier(2)
        out = []

        def one():
            r, body = self.refresh(first["token"])
            out.append(r.status)
        threads = [threading.Thread(target=one) for _ in range(2)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        self.assertEqual(sorted(out), [200, 401])

    def test_invalid_grant_는_401_popup_login_과_세션_삭제(self):
        first = self.logged_in()
        self.kc.refresh_fail = 400
        r, out = self.refresh(first["token"])
        self.assertEqual((r.status, out["error"], out["popup_login"]), (401, "token_invalid", True))
        self.assertEqual(self.sessions(), [])

    def test_갱신에서_이메일이_바뀌면_401(self):
        first = self.logged_in()
        self.kc.refresh_over = {"email": BOB}
        r, out = self.refresh(first["token"])
        self.assertEqual((r.status, out["error"]), (401, "token_invalid"))
        self.assertEqual(self.sessions(), [])
        second = self.logged_in()
        self.kc.refresh_over = {}                                                # 같은 이메일의 새 id_token 은 받는다
        self.assertEqual(self.refresh(second["token"])[0].status, 200)

    def test_갱신에서_AAS_권한이_없어지면_403(self):
        first = self.logged_in()
        with mock.patch.object(self.mcp, "member", lambda email: False):
            r, out = self.refresh(first["token"])
        self.assertEqual((r.status, out["error"]), (403, "user_unknown"))

    def test_갱신의_일시_장애는_세션을_남기고_새_refresh_token_을_저장한다(self):
        first = self.logged_in()
        with mock.patch.object(self.mcp, "member", lambda email: None):         # AAS realm 그룹 확인 실패(Keycloak 이 잠깐 끊김)
            r, out = self.refresh(first["token"])
        self.assertEqual((r.status, out["error"]), (503, "idp_unreachable"))
        used = self.kc.token_requests[-1]["refresh_token"]
        r, out = self.refresh(first["token"])                                    # 복구 뒤 같은 토큰으로 다시 갱신된다
        self.assertEqual(r.status, 200, out)
        self.assertNotEqual(self.kc.token_requests[-1]["refresh_token"], used)  # 장애 때 받은 새 refresh token 으로 이어 간다

    # ---- 교환의 popup_login -----------------------------------------------------------------------
    def test_401_에_popup_login(self):
        r, out = self.exchange("")
        self.assertEqual((r.status, out["error"], out["popup_login"]), (401, "token_invalid", True))
        self.assertEqual(out["message"], "호스트 로그인 토큰이 없습니다")
        r, out = self.exchange(self.kc_token(key=embed_keys.key("kc2")))         # 서명 틀림도 401 이면 싣는다
        self.assertEqual((r.status, out["error"], out["popup_login"]), (401, "token_mismatch", True))
        r, out = self.exchange("", origin=OTHER_ORIGIN)
        self.assertEqual((r.status, out["popup_login"]), (401, False))
        r, out = self.exchange("", origin=PORTAL_ORIGIN)
        self.assertEqual((r.status, out["popup_login"]), (401, False))
        r, out = self.exchange("", origin=EVIL)                                  # 401 이 아니면 싣지 않는다
        self.assertEqual(r.status, 403)
        self.assertNotIn("popup_login", out)
        r, out = self.exchange(self.kc_token())                                  # 호스트 토큰이 있으면 지금과 같다
        self.assertEqual(r.status, 200, out)
        self.assertNotIn("refresh", out)

    # ---- 요청 한도 --------------------------------------------------------------------------------
    def test_요청_한도_칸이_따로다(self):
        from aas.auth import mcp_limits
        secret = self.connected()
        with mock.patch.object(mcp_limits, "per_minute", lambda: 2):            # 교환 칸(IP)을 다 써도 꺼내기는 된다
            codes = [self.exchange("")[0].status for _ in range(3)]
            self.assertEqual(codes[-1], 429)
            self.assertEqual(self.redeem()[0].status, 202)
        with mock.patch.object(embed, "LOGIN_POLLS_PER_MIN", 3):               # nonce 칸을 다 쓰면 그 nonce 만 429
            codes = [self.redeem()[0].status for _ in range(4)]
            self.assertEqual(codes[-1], 429)
            self.assertEqual(self.exchange("")[0].status, 401)
        self.confirm(secret)

    # ---- 정리 -------------------------------------------------------------------------------------
    def test_폐기하면_세션을_지우고_Keycloak_revoke(self):
        first = self.logged_in()
        r, out = self.req("POST", "/api/embed/token/revoke", {"verifier": VERIFIER}, KC_ORIGIN, first["token"])
        self.assertEqual((r.status, out["revoked"]), (200, True))
        self.assertEqual(self.sessions(), [])
        self.assertEqual(self.kc.revoked[0]["token"], "rt-1")
        self.assertEqual((self.kc.revoked[0]["client_id"], self.kc.revoked[0]["token_type_hint"]), (LOGIN_CLIENT, "refresh_token"))
        self.assertEqual(self.refresh(first["token"])[0].status, 401)

    def test_verifier_없는_폐기도_세션은_지운다(self):
        first = self.logged_in()
        self.req("POST", "/api/embed/token/revoke", {}, KC_ORIGIN, first["token"])
        self.assertEqual(self.sessions(), [])
        self.assertEqual(self.kc.revoked, [])                                    # 봉한 refresh token 을 풀 수 없다

    def test_Keycloak_revoke_가_실패해도_폐기는_된다(self):
        first = self.logged_in()
        real = self.kc.__call__

        def failing(req, timeout):
            if req.full_url == REVOKE_URL:
                raise urllib.error.URLError("down")
            return real(req, timeout)
        with mock.patch.object(tls, "urlopen", failing):
            r, out = self.req("POST", "/api/embed/token/revoke", {"verifier": VERIFIER}, KC_ORIGIN, first["token"])
        self.assertEqual((r.status, out["revoked"]), (200, True))
        self.assertEqual(self.sessions(), [])

    def test_앱_삭제와_신뢰_필드_변경은_세션을_지운다(self):
        self.logged_in()
        self.connected(nonce="p" * 43)                                           # 진행 중인 로그인도
        embed.update_app(KC_APP, "COP renamed", [KC_ORIGIN], "keycloak", issuer=ISSUER, jwks_url=JWKS_URL, audience=AUD,
                         login_client_id=LOGIN_CLIENT)                           # 이름만 — 비밀은 비워 보내면 유지
        self.assertEqual(len(self.sessions()), 1)
        embed.update_app(KC_APP, "COP", [KC_ORIGIN], "keycloak", issuer=ISSUER, jwks_url=JWKS_URL, audience=AUD,
                         login_client_id=LOGIN_CLIENT, login_client_secret="rotated")
        self.assertEqual(self.sessions(), [])
        with embed._conn() as conn:
            self.assertEqual(conn.execute("SELECT COUNT(*) AS n FROM embed_login").fetchone()["n"], 0)
        embed.update_app(KC_APP, "COP", [KC_ORIGIN], "keycloak", issuer=ISSUER, jwks_url=JWKS_URL, audience=AUD,
                         login_client_id=LOGIN_CLIENT, login_client_secret=LOGIN_SECRET)
        self.logged_in()
        self.assertEqual(len(self.sessions()), 1)
        self.assertTrue(embed.remove_app(KC_APP))
        self.assertEqual(self.sessions(), [])

    def test_정리는_끝난_로그인과_세션을_지운다(self):
        self.logged_in()
        self.connected(nonce="p" * 43)
        now = time.time()
        embed.prune(now=now)
        self.assertEqual(len(self.sessions()), 1)
        embed.prune(now=now + 13 * 3600)
        self.assertEqual(self.sessions(), [])
        with embed._conn() as conn:
            self.assertEqual(conn.execute("SELECT COUNT(*) AS n FROM embed_login").fetchone()["n"], 0)

    def test_감사_기록(self):
        self.logged_in()
        with embed._conn() as conn:
            kinds = {r["kind"] for r in conn.execute("SELECT kind FROM usage WHERE kind LIKE 'embed_login%'")}
        self.assertTrue({"embed_login_begin", "embed_login_ok", "embed_login_redeem"} <= kinds, kinds)


class EmbedLoginAdminTest(unittest.TestCase):
    """관리 API·CLI 의 로그인 클라이언트 두 칸."""
    setUpClass = classmethod(base.EmbedHttpTest.setUpClass.__func__)
    tearDownClass = classmethod(base.EmbedHttpTest.tearDownClass.__func__)
    req, login = base.EmbedHttpTest.req, base.EmbedHttpTest.login
    PATH = "/api/admin/embed-apps"

    def setUp(self):
        _cleanup()
        self.boss = self.login(base.BOSS)

    def api(self, body=None):
        h = {"Cookie": self.boss, **({"X-AAS": "1"} if body is not None else {})}
        return self.req("POST" if body is not None else "GET", self.PATH, body, headers=h)

    def kc_body(self, **over):
        return {"action": "save", "name": "COP", "origins": [KC_ORIGIN], "mode": "keycloak", "issuer": ISSUER, "jwks_url": JWKS_URL,
                "audience": AUD, "idp_policy_checked": True, **over}

    def test_비밀은_가리고_빈_값이면_유지(self):
        r, out = self.api(self.kc_body(login_client_id=LOGIN_CLIENT))           # 비밀 없이 처음 등록
        self.assertEqual((r.status, out["field"]), (400, "login_client_secret"))
        r, out = self.api(self.kc_body(login_client_secret=LOGIN_SECRET))       # 비밀만
        self.assertEqual((r.status, out["field"]), (400, "login_client_id"))
        r, out = self.api(self.kc_body(login_client_id=LOGIN_CLIENT, login_client_secret=LOGIN_SECRET))
        self.assertEqual(r.status, 200, out)
        app = out["app"]
        self.assertNotIn(LOGIN_SECRET, json.dumps(out))
        self.assertEqual((app["login_client_id"], app["login_client_secret_set"]), (LOGIN_CLIENT, True))
        self.assertNotIn("login_client_secret", app)
        r, out = self.api()
        self.assertNotIn(LOGIN_SECRET, json.dumps(out))
        self.assertIs(out["apps"][0]["login_client_secret_set"], True)
        r, out = self.api(self.kc_body(app_id=app["app_id"], name="COP 2", login_client_id=LOGIN_CLIENT, login_client_secret=""))
        self.assertEqual(r.status, 200, out)
        self.assertEqual(embed._login_secret(app["app_id"]), LOGIN_SECRET)       # 빈 값이면 그대로
        r, out = self.api(self.kc_body(app_id=app["app_id"], login_client_id="", login_client_secret=""))
        self.assertEqual((r.status, out["app"]["login_client_secret_set"], out["app"]["login_client_id"]), (200, False, ""))
        self.assertEqual(embed._login_secret(app["app_id"]), "")                 # 클라이언트를 빼면 비밀도 지운다
        r, out = self.api(self.kc_body(app_id=app["app_id"], login_client_id=LOGIN_CLIENT, login_client_secret="",
                                       jwks_url="https://kc.example/jwks.json"))
        self.assertEqual(r.status, 400, out)

    def test_host_signed_는_로그인_클라이언트를_두지_않는다(self):
        r, out = self.api({"action": "save", "name": "P", "origins": [PORTAL_ORIGIN], "mode": "host-signed",
                           "public_jwk": json.dumps(self.host_key.jwk()), "login_client_id": LOGIN_CLIENT, "login_client_secret": LOGIN_SECRET})
        self.assertEqual(r.status, 200, out)
        self.assertEqual((out["app"]["login_client_id"], out["app"]["login_client_secret_set"]), ("", False))

    def test_CLI_비밀은_값_또는_파일_목록은_가린다(self):
        d = Path(base.TMP.name)
        (d / "login-secret.txt").write_text(LOGIN_SECRET + "\n")
        out, err = io.StringIO(), io.StringIO()
        args = ["add", "--name", "COP", "--origin", KC_ORIGIN, "--mode", "keycloak", "--app-id", "u-cli-login", "--issuer", ISSUER,
                "--jwks-url", JWKS_URL, "--audience", AUD, "--idp-policy-checked", "--login-client-id", LOGIN_CLIENT,
                "--login-client-secret", "@" + str(d / "login-secret.txt")]
        with redirect_stdout(out), redirect_stderr(err):
            self.assertEqual(embed._main(args), 0, err.getvalue())
            self.assertEqual(embed._main(["list"]), 0)
        self.assertEqual(embed._login_secret("u-cli-login"), LOGIN_SECRET)
        self.assertNotIn(LOGIN_SECRET, out.getvalue())
        self.assertIn('"login_client_secret_set": true', out.getvalue())


class EmbedLoginUnitTest(unittest.TestCase):
    def tearDown(self):
        _cleanup()
        embed.forget_jwks()

    def test_주소_도출(self):
        app = {"issuer": ISSUER, "jwks_url": JWKS_URL}
        self.assertEqual(embed._authorize_url(app), ISSUER + "/protocol/openid-connect/auth")
        self.assertEqual(embed._token_url(app), TOKEN_URL)
        with self.assertRaises(embed.EmbedError):
            embed._token_url({"issuer": ISSUER, "jwks_url": "https://kc.example/jwks.json"})

    def test_id_token_검증(self):
        key = embed_keys.key("kc1")
        app = embed.add_app("A", [KC_ORIGIN], "keycloak", app_id="u-idt", issuer=ISSUER, jwks_url=JWKS_URL, audience=AUD,
                            login_client_id=LOGIN_CLIENT, login_client_secret=LOGIN_SECRET)
        kc = FakeKc(key)
        kc.nonce = "abc"
        with mock.patch.object(tls, "urlopen", kc):
            claims = embed.verify_login_id_token(app, kc.id_token(), "abc")
            self.assertEqual(claims["email"], ALICE)
            embed.verify_login_id_token(app, kc.id_token(aud=[LOGIN_CLIENT], azp=None), "abc")   # aud 하나면 azp 가 없어도 된다
            for over in ({"aud": [LOGIN_CLIENT, "x"], "azp": None}, {"aud": AUD}, {"nonce": "zzz"}, {"iss": ISSUER + "/"}):
                with self.subTest(over), self.assertRaises(embed.EmbedError):
                    embed.verify_login_id_token(app, kc.id_token(**over), "abc")


def _cleanup():
    base._cleanup_db()
    with embed._conn() as conn:
        for t in ("embed_login", "embed_login_sessions"):
            conn.execute(f"DELETE FROM {t}")


if __name__ == "__main__":
    unittest.main()

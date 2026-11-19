# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""MindWiki 계정으로 연결(스펙 2026-11-14-001 2단계)이 쓰는 Auth.access_token: 갱신으로만 액세스 토큰을 얻고,
토큰 없이 끝나는 경우를 이유로 가른다(다른 탭이 갱신 중·refresh 토큰 없음·Keycloak 일시 오류·세션 끝)."""
import base64
import io
import json
import os
import tempfile
import time
import unittest
import urllib.error
from pathlib import Path
from unittest import mock

TMP = tempfile.TemporaryDirectory()
os.environ.setdefault("AAS_DATA_DIR", str(Path(TMP.name) / "data"))

from aas.auth import auth as authmod  # noqa: E402
from aas.common import store  # noqa: E402

ISS = "https://sso.example/realms/aas"


def _jwt(claims: dict) -> str:
    enc = lambda d: base64.urlsafe_b64encode(json.dumps(d).encode()).decode().rstrip("=")   # noqa: E731
    return f"{enc({'alg': 'none'})}.{enc(claims)}.sig"


class AccessTokenTest(unittest.TestCase):
    def setUp(self):
        self.a = authmod.Auth({"issuer": ISS, "client_id": "aas", "client_secret": "sec", "domain": "corp.example",
                               "public_url": "https://aas.example", "hours": 1})
        self.sub = "sub-" + os.urandom(4).hex()
        self.token = self.a._new_session("kim@corp.example", "김", sub=self.sub, refresh_token="rt-1")
        self.cookie = f"{authmod.COOKIE}={self.token}"
        self.calls = []
        self.fail = None
        p = mock.patch.object(authmod.Auth, "discovery", lambda s: {"token_endpoint": "https://sso.example/token"})
        p.start()
        self.addCleanup(p.stop)
        p = mock.patch.object(authmod.tls, "urlopen", self.kc)
        p.start()
        self.addCleanup(p.stop)
        self.addCleanup(self._clean)

    def _clean(self):
        with store.connect() as conn:
            conn.execute("DELETE FROM auth_sessions WHERE sub=?", (self.sub,))

    def kc(self, req, timeout):
        self.calls.append(req.full_url)
        if self.fail == "down":
            raise urllib.error.URLError("down")
        if self.fail:
            raise urllib.error.HTTPError(req.full_url, self.fail, "Bad Request", {}, io.BytesIO(b'{"error":"invalid_grant"}'))
        idt = _jwt({"iss": ISS, "aud": "aas", "sub": self.sub, "email": "kim@corp.example", "email_verified": True})
        return io.BytesIO(json.dumps({"access_token": "at-new", "refresh_token": "rt-2", "id_token": idt}).encode())

    def test_returns_a_fresh_access_token_even_right_after_the_last_refresh(self):
        with mock.patch.object(authmod.Auth, "_access", lambda s, c: (True, False)):
            self.assertEqual(self.a.access_token(self.cookie), ("at-new", ""))       # 240초 조건 없이 갱신한다
            self.assertEqual(self.a.access_token(self.cookie), ("at-new", ""))       # 회전한 refresh 토큰(rt-2)으로 이어 간다
        self.assertEqual(len(self.calls), 2)

    def test_reasons_when_no_token_comes_back(self):
        self.assertEqual(self.a.access_token("other=1"), ("", "session_ended"))
        self.fail = "down"
        self.assertEqual(self.a.access_token(self.cookie), ("", "keycloak_unavailable"))
        h = __import__("hashlib").sha256(self.token.encode()).hexdigest()
        with store.connect() as conn:                                               # 다른 탭이 갱신 중: 1초 뒤 한 번 더 해도 잡혀 있으면
            conn.execute("UPDATE auth_sessions SET refresh_lock=? WHERE hash=?", (time.time() + 60, h))
        with mock.patch.object(authmod.time, "sleep", lambda s: None):
            self.assertEqual(self.a.access_token(self.cookie), ("", "lease_busy"))
        with store.connect() as conn:
            conn.execute("UPDATE auth_sessions SET refresh_lock=0, rt='' WHERE hash=?", (h,))
        self.assertEqual(self.a.access_token(self.cookie), ("", "no_refresh_token"))

    def test_a_rejected_refresh_ends_the_session(self):
        self.fail = 400
        self.assertEqual(self.a.access_token(self.cookie), ("", "session_ended"))
        self.assertIsNone(self.a.user(self.cookie))


if __name__ == "__main__":
    unittest.main()

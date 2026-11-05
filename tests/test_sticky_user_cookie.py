# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""사용자 단위 서버 고정 쿠키 aas_u (스펙 cogentai-aas-docs 2026-11-05-005 §5-1 U1).

서버가 둘이면 브라우저마다 다른 서버에 붙어 한 사용자의 세션 목록(서버 메모리)이 기기마다 달랐다. 로그인한 요청에
aas_u 를 주고 ingress(HAProxy `balance hash req.cook(aas_u)`, nginx `upstream-hash-by $cookie_aas_u`)가 그 값으로 서버를 고른다. 값은 이메일에서 만들지만
이메일 원문이 쿠키에 들어가지 않는다(서버 비밀값 HMAC)."""
import os
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

TMP = tempfile.TemporaryDirectory()
os.environ.setdefault("AAS_DATA_DIR", str(Path(TMP.name) / "data"))

from aas.web import server  # noqa: E402


def ctx(cookie: str, user, enabled=True, secure=False):
    h = SimpleNamespace(headers={"Cookie": cookie}, principal=None, _secure_request=lambda: secure)
    a = SimpleNamespace(enabled=enabled, user=lambda c: user)
    with mock.patch.object(server, "auth", return_value=a), \
            mock.patch.object(server, "registry", return_value=SimpleNamespace(pick=lambda *x: None)):
        server.Handler._context(h)
    return getattr(h, "_sticky", None)


class StickyValueTest(unittest.TestCase):
    def test_same_user_same_value_without_the_email(self):
        with mock.patch.dict(os.environ, {"AAS_OIDC_CLIENT_SECRET": "s3"}):
            a = server._sticky_value("Kim@Example.com")
            self.assertEqual(a, server._sticky_value(" kim@example.com "))      # 대소문자·공백이 달라도 같은 사람
            self.assertNotEqual(a, server._sticky_value("lee@example.com"))
        self.assertNotIn("kim", a)
        self.assertRegex(a, r"^[0-9a-f]{16}$")

    def test_value_depends_on_the_server_secret(self):
        """두 서버가 같은 비밀값을 쓰면 같은 값이다. 비밀값이 바뀌면 한 번 다른 서버로 옮길 뿐이다."""
        with mock.patch.dict(os.environ, {"AAS_OIDC_CLIENT_SECRET": "one"}):
            one = server._sticky_value("kim@example.com")
        with mock.patch.dict(os.environ, {"AAS_OIDC_CLIENT_SECRET": "two"}):
            two = server._sticky_value("kim@example.com")
        self.assertNotEqual(one, two)


class StickyCookieTest(unittest.TestCase):
    def test_signed_in_request_gets_the_cookie(self):
        set_cookie = ctx("aas_session=x", {"email": "kim@example.com"}, secure=True)
        self.assertTrue(set_cookie.startswith("aas_u=" + server._sticky_value("kim@example.com") + ";"))
        for part in ("Path=/", "HttpOnly", "SameSite=Lax", "Secure"):
            self.assertIn(part, set_cookie)

    def test_cookie_already_right_is_not_sent_again(self):
        v = server._sticky_value("kim@example.com")
        self.assertIsNone(ctx(f"aas_session=x; aas_u={v}", {"email": "kim@example.com"}))

    def test_wrong_cookie_is_replaced(self):
        """다른 사람으로 다시 로그인한 브라우저는 그 사람의 서버로 옮긴다."""
        self.assertIsNotNone(ctx("aas_session=x; aas_u=0000000000000000", {"email": "kim@example.com"}))

    def test_no_cookie_without_login(self):
        self.assertIsNone(ctx("", None))                       # 로그인 전
        self.assertIsNone(ctx("", None, enabled=False))       # 로그인이 꺼진 설치(compose, 서버 하나)


if __name__ == "__main__":
    unittest.main()

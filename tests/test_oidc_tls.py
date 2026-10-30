# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""OIDC 공급자(Keycloak)로 가는 서버의 https 요청에서 인증서 검증을 끄는 선택 옵션 시험(OMAI-1289).
기본은 검증한다. AAS_OIDC_INSECURE_SKIP_TLS_VERIFY 를 켠 때만 이 호출들에서 끈다."""
import http.server
import json
import os
import ssl
import subprocess
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from pathlib import Path
from unittest import mock

TMP = tempfile.TemporaryDirectory()
os.environ.setdefault("AAS_DATA_DIR", str(Path(TMP.name) / "data"))

from aas.auth import auth, keycloak, tls  # noqa: E402

ENV = "AAS_OIDC_INSECURE_SKIP_TLS_VERIFY"


class Idp(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        body = json.dumps({"issuer": "https://idp.test/realms/aas", "token_endpoint": "https://idp.test/t"}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    do_POST = do_GET

    def log_message(self, *a):
        pass


class TlsServerCase(unittest.TestCase):
    """자체 서명 인증서로 https 를 여는 가짜 공급자. 사내 CA 를 믿지 않는 서버와 같은 상황이다."""

    @classmethod
    def setUpClass(cls):
        d = Path(TMP.name)
        subprocess.run(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=localhost",
                        "-keyout", str(d / "k.pem"), "-out", str(d / "c.pem")], check=True, capture_output=True)
        cls.httpd = http.server.HTTPServer(("127.0.0.1", 0), Idp)
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        ctx.load_cert_chain(str(d / "c.pem"), str(d / "k.pem"))
        cls.httpd.socket = ctx.wrap_socket(cls.httpd.socket, server_side=True)
        cls.port = cls.httpd.server_address[1]
        threading.Thread(target=cls.httpd.serve_forever, daemon=True).start()
        cls.url = f"https://localhost:{cls.port}/realms/aas"

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()

    def setUp(self):
        tls._warned = False


class SkipFlagTest(unittest.TestCase):
    def test_default_verifies(self):
        with mock.patch.dict(os.environ, {}, clear=False):
            os.environ.pop(ENV, None)
            self.assertFalse(tls.skip_verify())
            self.assertIsNone(tls.context())                        # 기본 검증 그대로

    def test_only_explicit_true_values_turn_it_on(self):
        for v in ("1", "true", "TRUE", "yes", "on", " True "):
            with mock.patch.dict(os.environ, {ENV: v}):
                self.assertTrue(tls.skip_verify(), v)
        for v in ("0", "false", "no", "off", "", "maybe", "skip"):
            with mock.patch.dict(os.environ, {ENV: v}):
                self.assertFalse(tls.skip_verify(), v)              # 모르는 값은 검증한다(안전한 쪽)

    def test_context_when_on_does_not_verify(self):
        with mock.patch.dict(os.environ, {ENV: "true"}):
            ctx = tls.context()
        self.assertEqual(ctx.verify_mode, ssl.CERT_NONE)
        self.assertFalse(ctx.check_hostname)


class UrlopenTest(TlsServerCase):
    def test_default_rejects_a_self_signed_certificate(self):
        with mock.patch.dict(os.environ, {}, clear=False):
            os.environ.pop(ENV, None)
            with self.assertRaises(urllib.error.URLError) as cm:
                tls.urlopen(urllib.request.Request(self.url), timeout=5)
        self.assertIn("CERTIFICATE_VERIFY_FAILED", str(cm.exception))

    def test_option_accepts_it_and_warns_once(self):
        with mock.patch.dict(os.environ, {ENV: "true"}), mock.patch("builtins.print") as pr:
            for _ in range(2):
                with tls.urlopen(urllib.request.Request(self.url), timeout=5) as r:
                    self.assertEqual(json.load(r)["issuer"], "https://idp.test/realms/aas")
        warns = [c for c in pr.call_args_list if "검증" in str(c)]
        self.assertEqual(len(warns), 1)                             # 켜진 동안 매번 쓰지 않고 한 번만 알린다


class CallersUseItTest(TlsServerCase):
    def test_login_discovery_follows_the_option(self):
        cfg = {"issuer": self.url, "discovery_url": self.url, "client_id": "c", "client_secret": "s"}
        with mock.patch.dict(os.environ, {}, clear=False):
            os.environ.pop(ENV, None)
            with self.assertRaises(auth.AuthError):
                auth.Auth(dict(cfg)).discovery()
        with mock.patch.dict(os.environ, {ENV: "1"}):
            self.assertEqual(auth.Auth(dict(cfg)).discovery()["token_endpoint"], "https://idp.test/t")

    def test_keycloak_admin_calls_follow_the_option(self):
        adm = keycloak.KeycloakAdmin(self.url, "cid", "sec", "aas-users", "aas-admin", timeout=5)
        req = urllib.request.Request(self.url + "/x")
        with mock.patch.dict(os.environ, {}, clear=False):
            os.environ.pop(ENV, None)
            with self.assertRaises(keycloak.KeycloakError):
                adm._send(req)
        with mock.patch.dict(os.environ, {ENV: "yes"}):
            body, _ = adm._send(urllib.request.Request(self.url + "/x"))
        self.assertEqual(body["issuer"], "https://idp.test/realms/aas")


if __name__ == "__main__":
    unittest.main()

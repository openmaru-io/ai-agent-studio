# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""주 화면 CSP 1단계: Content-Security-Policy-Report-Only 와 위반 보고(스펙 2026-11-14-018).
막지 않고 위반만 보고받는다. 서버가 만드는 HTML 의 <script> 에는 응답마다 다른 nonce 를 붙인다."""
import asyncio
import http.client
import json
import os
import re
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import aasserver  # 실제 uvicorn 앱을 띄우는 시험 하네스(OMAI-1100)

TMP = tempfile.TemporaryDirectory()
os.environ.setdefault("AAS_DATA_DIR", str(Path(TMP.name) / "data"))
HEADER = "Content-Security-Policy-Report-Only"


def nonce_of(policy: str) -> str:
    return re.search(r"'nonce-([A-Za-z0-9_-]+)'", policy).group(1)


class CspServerTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        from aas.auth import auth
        from aas.web import server
        users = Path(TMP.name) / "csp-users.json"
        auth.save_user("alice@corp.example", "correct horse battery", users)
        cls.app = aasserver.start()
        cls.port = cls.app.server_port
        cls.saved = server._auth
        server._auth = auth.Auth({"issuer": "", "client_id": "", "client_secret": "", "domain": "",
                                  "public_url": f"http://127.0.0.1:{cls.port}", "public_urls": [], "hours": 1, "users_file": users})
        cls.server = server

    @classmethod
    def tearDownClass(cls):
        cls.app.shutdown()
        cls.server._auth = cls.saved

    def setUp(self):
        from aas.web import csp
        csp._seen.clear()

    def req(self, method, path, body=None, headers=None):
        c = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        c.request(method, path, body=body, headers=headers or {})
        r = c.getresponse()
        data = r.read()
        c.close()
        return r, data

    def test_login_page_reports_only_and_every_script_has_the_nonce(self):
        r, body = self.req("GET", "/auth/login")
        page = body.decode()
        policy = r.getheader(HEADER)
        self.assertTrue(policy, "Report-Only 머리가 없다")
        self.assertIsNone(r.getheader("Content-Security-Policy"))                     # 1단계는 막지 않는다
        n = nonce_of(policy)
        self.assertGreaterEqual(len(n), 16)
        scripts = re.findall(r"<script[^>]*>", page)
        self.assertTrue(scripts)
        for tag in scripts:
            self.assertIn(f'nonce="{n}"', tag, tag)
        for part in ("default-src 'self'", "script-src 'self' 'nonce-", "'wasm-unsafe-eval'", "object-src 'none'",
                     "base-uri 'self'", "frame-ancestors 'none'", "report-uri /api/csp-report"):
            self.assertIn(part, policy)
        self.assertNotIn("unsafe-inline' 'nonce", policy)
        # OKE 에서 처음 모은 보고로 고친 것(스펙 2026-11-14-018 6절): 3D 오피스 three.js 가 GLTF 를 data:/blob: 로 fetch,
        # troika-three-text 작업 스레드가 importScripts(blob:)
        self.assertIn("connect-src 'self' data: blob:", policy)
        self.assertRegex(policy, r"script-src 'self' 'nonce-[^']+' 'wasm-unsafe-eval' blob:;")
        self.assertNotRegex(policy.split("script-src")[1].split(";")[0], "unsafe-inline")   # 스크립트에는 unsafe-inline 을 주지 않는다
        r2, _ = self.req("GET", "/auth/login")
        self.assertNotEqual(nonce_of(r2.getheader(HEADER)), n)                          # 응답마다 다르다
        self.assertEqual(int(r.getheader("Content-Length")), len(body))                 # nonce 를 넣은 뒤 길이

    def test_json_and_redirect_responses_get_no_policy(self):
        r, _ = self.req("GET", "/api/me")
        self.assertIsNone(r.getheader(HEADER))
        r, _ = self.req("GET", "/")
        self.assertIn(r.status, (200, 302))
        if r.status == 302:
            self.assertIsNone(r.getheader(HEADER))

    def test_off_mode_sends_no_policy_and_no_nonce(self):
        with mock.patch.dict(os.environ, {"AAS_CSP_MODE": "off"}):
            r, body = self.req("GET", "/auth/login")
        self.assertIsNone(r.getheader(HEADER))
        self.assertNotIn("nonce=", body.decode())

    def report(self, payload, ctype="application/csp-report"):
        return self.req("POST", "/api/csp-report", json.dumps(payload).encode(), {"Content-Type": ctype})

    def test_report_is_logged_without_query_and_deduplicated(self):
        rep = {"csp-report": {"document-uri": f"http://127.0.0.1:{self.port}/auth/login?next=/secret-path",
                              "effective-directive": "script-src-elem", "violated-directive": "script-src-elem",
                              "blocked-uri": "https://evil.example/a.js?token=abc#x", "source-file": "https://h/x.js?k=1",
                              "line-number": 3}}
        with self.assertLogs("aas.csp", level="WARNING") as logs:
            r, _ = self.report(rep)                                                      # X-AAS 머리 없이 받는다(브라우저가 붙일 수 없다)
        self.assertEqual(r.status, 204)
        line = logs.output[0]
        self.assertIn("csp_violation directive=script-src-elem blocked=https://evil.example/a.js page=/auth/login", line)
        for secret in ("secret-path", "token=abc", "k=1", "#x"):
            self.assertNotIn(secret, line)
        with self.assertNoLogs("aas.csp", level="WARNING"):
            r, _ = self.report(rep)                                                      # 같은 위반은 한동안 한 번만
        self.assertEqual(r.status, 204)

    def test_reporting_api_format_and_inline(self):
        rep = [{"type": "csp-violation", "url": "http://h/#/office", "body": {
            "documentURL": "http://h/index.html", "effectiveDirective": "script-src-attr", "blockedURL": "inline",
            "sourceFile": "http://h/auth/login", "lineNumber": 1}}]
        with self.assertLogs("aas.csp", level="WARNING") as logs:
            r, _ = self.report(rep, "application/reports+json")
        self.assertEqual(r.status, 204)
        self.assertIn("directive=script-src-attr blocked=inline page=/index.html", logs.output[0])

    def test_bad_and_large_reports_are_refused_quietly(self):
        with self.assertNoLogs("aas.csp", level="WARNING"):
            r, _ = self.req("POST", "/api/csp-report", b"not json", {"Content-Type": "application/csp-report"})
            self.assertEqual(r.status, 400)
            r, _ = self.req("POST", "/api/csp-report", b"{" + b" " * 20000 + b"}", {"Content-Type": "application/csp-report"})
            self.assertEqual(r.status, 413)
            r, _ = self.req("GET", "/api/csp-report")
            self.assertIn(r.status, (401, 404, 405))                                      # GET 은 보고로 받지 않는다(레거시가 로그인을 요구)

    def test_server_pages_have_no_inline_event_handlers(self):
        from aas.web import server
        page = server._mcp_oauth_error_page(Exception("x"), None).decode()
        self.assertNotRegex(page, r"\son[a-z]+=")
        self.assertIn("data-close", page)


class CspMiddlewareTest(unittest.TestCase):
    """이미 정책이 있는 응답(임베드 위젯)은 건드리지 않는다."""

    def run_app(self, headers, body=b"<html><script>x</script></html>"):
        from aas.web import csp

        async def inner(scope, receive, send):
            await send({"type": "http.response.start", "status": 200, "headers": headers})
            await send({"type": "http.response.body", "body": body})
        sent = []

        async def send(m):
            sent.append(m)

        async def receive():
            return {"type": "http.request"}
        asyncio.run(csp.CSPMiddleware(inner)({"type": "http", "path": "/", "headers": []}, receive, send))
        return dict((k.decode().lower(), v.decode()) for k, v in sent[0]["headers"]), b"".join(m.get("body", b"") for m in sent[1:])

    def test_existing_policy_is_left_alone(self):
        h, body = self.run_app([(b"content-type", b"text/html; charset=utf-8"),
                                (b"content-security-policy", b"default-src 'none'")])
        self.assertNotIn(HEADER.lower(), h)
        self.assertEqual(body, b"<html><script>x</script></html>")

    def test_non_html_is_left_alone(self):
        h, body = self.run_app([(b"content-type", b"text/javascript")], b"var a='<script';")
        self.assertNotIn(HEADER.lower(), h)
        self.assertEqual(body, b"var a='<script';")


if __name__ == "__main__":
    unittest.main()

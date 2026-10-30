# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""aas/web/server.py 의 화면용 문장 시험 — Accept-Language 에 따라 영어/한국어로 나오고 응답에 Content-Language 가 붙는다."""
import aasserver  # 실제 uvicorn 앱을 띄우는 시험 하네스(OMAI-1100)
import http.client
import json
import os
import tempfile
import threading
import unittest
from http.server import ThreadingHTTPServer
from pathlib import Path
from unittest import mock

TMP = tempfile.TemporaryDirectory()
os.environ.setdefault("AAS_DATA_DIR", str(Path(TMP.name) / "data"))

from aas.fleet import agents
from aas.common import i18n
from aas.web import server  # noqa: E402


class LangTest(unittest.TestCase):
    def tearDown(self):
        i18n.set_lang("ko")

    def both(self, fn):
        """같은 호출을 영어와 한국어로 부른 결과."""
        i18n.set_lang("en")
        en = fn()
        i18n.set_lang("ko")
        return en, fn()

    def test_text_problem_follows_language(self):
        en, ko = self.both(lambda: server._text_problem("config", "- a\n- b\n"))
        self.assertEqual(en, "The settings must be YAML in 'name: value' form")
        self.assertIn("이름: 값", ko)
        en, ko = self.both(lambda: server._text_problem("config", "timezone: Asia/Seoul\n"))
        self.assertIn("model entry", en)
        self.assertIn("model 항목", ko)
        en, ko = self.both(lambda: server._text_problem("config", "a: [unclosed"))
        self.assertTrue(en.startswith("Invalid YAML: "))
        self.assertTrue(ko.startswith("YAML 형식 오류: "))

    def test_agent_errors_say_agent_not_hermes(self):
        def run():
            with mock.patch.object(server.k8s, "client", return_value=None):
                try:
                    server._agents_write(None, None, True, "/api/agents", {})
                except agents.AgentError as exc:
                    return str(exc)
        en, ko = self.both(run)
        self.assertEqual(en, "Not in Kubernetes mode (AAS_K8S_NAMESPACE)")
        self.assertEqual(ko, "쿠버네티스 모드가 아닙니다(AAS_K8S_NAMESPACE)")

    def test_office_action_unknown(self):
        def run():
            try:
                server._office_action(None, {"action": "nope"}, "me")
            except ValueError as exc:
                return str(exc)
        en, ko = self.both(run)
        self.assertEqual((en, ko), ("Unknown request", "알 수 없는 요청"))

    def test_page_and_login_html(self):
        i18n.set_lang("en")
        self.assertIn(b"<html lang=en>", server._page("t", ""))
        i18n.set_lang("ko")
        self.assertIn(b"<html lang=ko>", server._page("t", ""))

    def test_edit_state_reason(self):
        a = mock.Mock(enabled=True)
        with mock.patch.object(server, "registry") as reg:
            reg.return_value.is_admin.return_value = False
            en, ko = self.both(lambda: server.Handler._edit_state(a, {}, "profiles/x/skills/a/SKILL.md", {"masked_lines": 0})["why_not"])
        self.assertEqual(en, "Only admins can edit this")
        self.assertEqual(ko, "관리자만 고칠 수 있습니다")


class HttpTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        from aas.auth import auth
        from aas.fleet import pods
        cls.old = {k: os.environ.get(k) for k in ("AAS_OIDC_ISSUER", "AAS_OIDC_CLIENT_FILE", "AAS_USERS_FILE", "AAS_ALLOWED_HOSTS", "AAS_PODS_FILE")}
        for k in cls.old:
            os.environ.pop(k, None)
        os.environ["AAS_USERS_FILE"] = str(Path(TMP.name) / "no-users.json")
        os.environ["AAS_PODS_FILE"] = str(Path(TMP.name) / "no-pods.json")
        home = Path(TMP.name) / "hermes"
        (home / "profiles").mkdir(parents=True, exist_ok=True)
        reg = Path(TMP.name) / "pods.json"
        reg.write_text('{"pods": [{"id": "t", "owner": "t@example.com", "hermes_home": "%s"}]}' % home)
        server._auth = auth.Auth({"issuer": "https://accounts.google.com", "client_id": "", "client_secret": "", "domain": "",
                                  "public_url": "http://localhost:17900", "hours": 1,
                                  "users_file": Path(TMP.name) / "no-users.json"})      # 로그인 꺼짐
        server._registry = pods.Registry(reg)
        cls.httpd = aasserver.start()
        cls.port = cls.httpd.server_port

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        for k, v in cls.old.items():
            if v is not None:
                os.environ[k] = v
        server._auth = None
        server._registry = None

    def get(self, path, lang=None):
        c = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        c.request("GET", path, headers={"Accept-Language": lang} if lang else {})
        r = c.getresponse()
        body = r.read()
        c.close()
        return r, body

    def test_unknown_profile_error_follows_accept_language(self):
        r, body = self.get("/api/chat/history?profile=zzz", "en")
        self.assertEqual(r.status, 400)
        self.assertEqual(json.loads(body)["error"], "Profile not found")
        self.assertEqual(r.getheader("Content-Language"), "en")
        self.assertEqual(r.getheader("Vary"), "Accept-Language, Cookie")
        r, body = self.get("/api/chat/history?profile=zzz")
        self.assertEqual(json.loads(body)["error"], "없는 프로파일")
        self.assertEqual(r.getheader("Content-Language"), "ko")
        r, body = self.get("/api/chat/history?profile=zzz", "ko-KR,ko;q=0.9")
        self.assertEqual(json.loads(body)["error"], "없는 프로파일")

    def test_keep_alive_connection_picks_language_per_request(self):
        c = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        seen = []
        for lang in ("en", "ko", "en"):
            c.request("GET", "/api/chat/history?profile=zzz", headers={"Accept-Language": lang})
            r = c.getresponse()
            seen.append((json.loads(r.read())["error"], r.getheader("Content-Language")))
        c.close()
        self.assertEqual(seen, [("Profile not found", "en"), ("없는 프로파일", "ko"), ("Profile not found", "en")])

    def test_login_required_error(self):
        class Fake:
            enabled = True

            def user(self, cookie):
                return None
        with mock.patch.object(server, "auth", return_value=Fake()):
            r, body = self.get("/api/health", "en")
            self.assertEqual(r.status, 401)
            self.assertEqual(json.loads(body)["error"], "Sign in required")
            self.assertEqual(r.getheader("Content-Language"), "en")
            r, body = self.get("/api/health")
            self.assertEqual(json.loads(body)["error"], "로그인이 필요합니다")

    def test_blocked_host_page_is_translated(self):
        os.environ["AAS_ALLOWED_HOSTS"] = "only.example.com"
        try:
            r, body = self.get("/", "en")
            self.assertEqual(r.status, 400)
            self.assertIn(b"not allowed", body)
            self.assertIn(b"<html lang=en>", body)
            r, body = self.get("/")
            self.assertIn("허용되지 않은 주소".encode(), body)
        finally:
            os.environ.pop("AAS_ALLOWED_HOSTS", None)


if __name__ == "__main__":
    unittest.main()

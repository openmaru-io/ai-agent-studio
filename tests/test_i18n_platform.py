# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""플랫폼 계층(인증·Hermes 채팅·쿠버네티스·Keycloak 등) 오류 문장의 언어 선택 시험."""
import os
import tempfile
import unittest
from pathlib import Path

TMP = tempfile.TemporaryDirectory()
os.environ.setdefault("AAS_DATA_DIR", str(Path(TMP.name) / "data"))

from aas.auth import auth, keycloak
from aas.hermes import hermes_chat
from aas.common import i18n, redact
from aas.fleet import k8s, lifecycle  # noqa: E402
from aas.hermes.readers import remote  # noqa: E402


class PlatformI18nTest(unittest.TestCase):
    def tearDown(self):
        i18n.set_lang("ko")

    def _both(self, fn):
        out = {}
        for lang in ("en", "ko"):
            i18n.set_lang(lang)
            out[lang] = fn()
        return out

    def test_redact_invalid_url(self):
        r = self._both(lambda: redact.clean_url("http://[bad"))
        self.assertEqual(r["en"], "(invalid URL)")
        self.assertEqual(r["ko"], "(잘못된 URL)")

    def test_k8s_unknown_api(self):
        def f():
            try:
                k8s.K8s("ns", api="").call("GET", "/x")
            except k8s.K8sError as exc:
                return str(exc)
        old = os.environ.pop("KUBERNETES_SERVICE_HOST", None)
        try:
            r = self._both(f)
        finally:
            if old is not None:
                os.environ["KUBERNETES_SERVICE_HOST"] = old
        self.assertIn("Kubernetes API address", r["en"])
        self.assertIn("쿠버네티스 API 주소", r["ko"])

    def test_keycloak_bad_issuer(self):
        def f():
            try:
                keycloak.KeycloakAdmin("https://kc.example/bad", "c", "s", "", "")
            except keycloak.KeycloakError as exc:
                return str(exc)
        r = self._both(f)
        self.assertIn("must look like", r["en"])
        self.assertIn("모양이 아닙니다", r["ko"])

    def test_lifecycle_skipped_when_no_members(self):
        r = self._both(lambda: lifecycle.reconcile(None, [], [])["skipped"])
        self.assertIn("0 members", r["en"])
        self.assertIn("0명", r["ko"])

    def test_auth_wrong_password(self):
        a = auth.Auth({"issuer": "", "client_id": "", "client_secret": "", "domain": "",
                       "users_file": str(Path(TMP.name) / "none.json")})

        def f():
            try:
                a.password_login("nobody@x.io", "pw", "1.2.3.4")
            except auth.AuthError as exc:
                return str(exc)
        r = self._both(f)
        self.assertEqual(r["en"], "Wrong username or password.")
        self.assertEqual(r["ko"], "아이디 또는 비밀번호가 맞지 않습니다.")

    def test_remote_relative_error(self):
        def f():
            try:
                remote.RemotePath(None, "") / "/abs"
            except ValueError as exc:
                return str(exc)
        r = self._both(f)
        self.assertEqual(r["en"], "Cannot join an absolute path")
        self.assertEqual(r["ko"], "절대 경로는 이을 수 없습니다")

    def test_hermes_chat_unknown_session(self):
        def f():
            c = hermes_chat.ChatHub.__new__(hermes_chat.ChatHub)
            c.sessions = {}
            try:
                c._known("zzz")
            except hermes_chat.ChatUnavailable as exc:
                return str(exc)
        r = self._both(f)
        self.assertIn("not created by this server", r["en"])
        self.assertIn("만든 세션이 아닙니다", r["ko"])


if __name__ == "__main__":
    unittest.main()

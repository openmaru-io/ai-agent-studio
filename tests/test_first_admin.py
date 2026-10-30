# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""첫 관리자 계정을 .env(AAS_ADMIN_EMAIL·AAS_ADMIN_PASSWORD)로 만든다(스펙 2026-10-21-015 단계 2, 리뷰 D2·R9)."""
import contextlib
import io
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

TMP = tempfile.TemporaryDirectory()
os.environ.setdefault("AAS_DATA_DIR", str(Path(TMP.name) / "data"))

from aas.auth import auth  # noqa: E402

PW = "first-admin-pass-123"


class FirstAdmin(unittest.TestCase):
    def setUp(self):
        self.users = Path(tempfile.mkdtemp(dir=TMP.name)) / "users.json"

    def run_bootstrap(self, **env):
        values = {"AAS_ADMIN_EMAIL": "", "AAS_ADMIN_PASSWORD": "", **env}
        out = io.StringIO()
        with mock.patch.dict(os.environ, values), contextlib.redirect_stdout(out):
            auth.bootstrap_admin(self.users)
        return out.getvalue()

    def test_계정이_없으면_만들고_그_비밀번호로_맞는다(self):
        log = self.run_bootstrap(AAS_ADMIN_EMAIL="Admin@Example.com", AAS_ADMIN_PASSWORD=PW)
        users = auth.load_users(self.users)
        self.assertEqual(list(users), ["admin@example.com"])
        self.assertTrue(auth.verify_password(PW, users["admin@example.com"]))
        self.assertIn("admin@example.com", log)
        self.assertNotIn(PW, log)                                   # 비밀번호는 로그에 찍지 않는다

    def test_계정이_하나라도_있으면_건드리지_않는다(self):
        auth.save_user("kim@example.com", "kim-own-password-1", self.users)
        before = self.users.read_text(encoding="utf-8")
        self.run_bootstrap(AAS_ADMIN_EMAIL="admin@example.com", AAS_ADMIN_PASSWORD=PW)
        self.assertEqual(self.users.read_text(encoding="utf-8"), before)

    def test_같은_계정이_있어도_비밀번호를_덮지_않는다(self):
        auth.save_user("admin@example.com", "changed-in-screen-1", self.users)
        self.run_bootstrap(AAS_ADMIN_EMAIL="admin@example.com", AAS_ADMIN_PASSWORD=PW)
        self.assertTrue(auth.verify_password("changed-in-screen-1", auth.load_users(self.users)["admin@example.com"]))

    def test_짧은_비밀번호는_만들지_않고_이유를_남긴다(self):
        log = self.run_bootstrap(AAS_ADMIN_EMAIL="admin@example.com", AAS_ADMIN_PASSWORD="short")
        self.assertEqual(auth.load_users(self.users), {})
        self.assertIn("10", log)
        self.assertNotIn("short", log)

    def test_이메일_모양이_아니면_만들지_않는다(self):
        self.run_bootstrap(AAS_ADMIN_EMAIL="admin", AAS_ADMIN_PASSWORD=PW)
        self.assertEqual(auth.load_users(self.users), {})

    def test_값이_없으면_아무것도_하지_않는다(self):
        self.assertEqual(self.run_bootstrap(), "")
        self.assertFalse(self.users.exists())

    def test_serve_는_로그인_검사_전에_첫_관리자를_만든다(self):
        from aas import __main__ as cli
        seen = {}

        def fake_serve(host, port):
            seen["users"] = auth.load_users(self.users)             # 서버의 로그인 검사가 이 시점의 계정을 본다

        with mock.patch.object(auth, "USERS_FILE", self.users), mock.patch.object(cli.server, "serve", fake_serve), \
                mock.patch.dict(os.environ, {"AAS_ADMIN_EMAIL": "admin@example.com", "AAS_ADMIN_PASSWORD": PW}), \
                contextlib.redirect_stdout(io.StringIO()):
            cli.main(["serve", "--host", "0.0.0.0"])
        self.assertIn("admin@example.com", seen["users"])


if __name__ == "__main__":
    unittest.main()

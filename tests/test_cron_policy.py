# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""크론 쓰기 규칙 시험(스펙 2026-10-15-003 R1·R6): 숨긴 루트 판정, 주인의 전달 대상 제한, 크론을 바꿀 수 있는 사람."""
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

TMP = tempfile.TemporaryDirectory()
os.environ.setdefault("AAS_DATA_DIR", str(Path(TMP.name) / "data"))

from aas.fleet import primary  # noqa: E402
from aas.fleet.pods import Pod  # noqa: E402
from aas.ops import cron_policy  # noqa: E402
from aas.web import server  # noqa: E402

KIM, LEE = {"email": "kim@x.com"}, {"email": "lee@x.com"}
POD = Pod("kim", "kim@x.com", Path(TMP.name))


class RootTest(unittest.TestCase):
    def test_대상_파드는_루트_default_를_거절한다(self):
        with mock.patch.object(primary, "is_target", return_value=True):
            self.assertTrue(cron_policy.profile_error("kim", "default"))
            self.assertEqual(cron_policy.profile_error("kim", "main"), "")

    def test_대상_기록이_없는_파드는_default_를_거절하지_않는다(self):
        with mock.patch.object(primary, "is_target", return_value=False):
            self.assertEqual(cron_policy.profile_error("kim", "default"), "")


class DeliverTest(unittest.TestCase):
    def test_주인은_local_origin_채널_이름만(self):
        with mock.patch.object(primary, "is_target", return_value=False):
            for ok in ("local", "origin", "telegram", "slack", ""):
                self.assertEqual(cron_policy.deliver_error("kim", ok, False), "", ok)
            for bad in ("telegram:123", "bot-chat:main", "bot-chat", "telegram,discord", "Local x"):
                self.assertTrue(cron_policy.deliver_error("kim", bad, False), bad)

    def test_관리자는_채널_대상_지정과_bot_chat_도_된다(self):
        with mock.patch.object(primary, "is_target", return_value=False):
            for ok in ("telegram:123", "bot-chat:main"):
                self.assertEqual(cron_policy.deliver_error("kim", ok, True), "", ok)

    def test_숨긴_루트의_bot_chat_default_는_관리자도_거절(self):
        with mock.patch.object(primary, "is_target", return_value=True):
            self.assertTrue(cron_policy.deliver_error("kim", "bot-chat:default", True))
            self.assertEqual(cron_policy.deliver_error("kim", "bot-chat:main", True), "")


class MayChangeCronTest(unittest.TestCase):
    def test_관리자와_주인만_바꾼다(self):
        self.assertTrue(server.may_change_cron(POD, KIM, True, False))
        self.assertTrue(server.may_change_cron(POD, LEE, True, True))
        self.assertFalse(server.may_change_cron(POD, LEE, True, False))
        self.assertFalse(server.may_change_cron(None, KIM, True, False))
        self.assertTrue(server.may_change_cron(POD, None, False, False))      # 로그인을 끈 로컬 실행


if __name__ == "__main__":
    unittest.main()

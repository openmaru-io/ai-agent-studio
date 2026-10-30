# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""마켓·오피스·회의·에이전트 서버 문장의 언어 선택 시험 — 영어와 한국어로 각각 나오는지 본다."""
import os
import tempfile
import unittest
from pathlib import Path

TMP = tempfile.TemporaryDirectory()
os.environ.setdefault("AAS_DATA_DIR", str(Path(TMP.name) / "data"))

from aas.fleet import agents, profiles
from aas.common import i18n
from aas.market import marketplace
from aas.office import meeting, office, office_access  # noqa: E402


class MarketI18nTest(unittest.TestCase):
    def tearDown(self):
        i18n.set_lang("ko")

    def _msg(self, fn, *exc):
        with self.assertRaises(exc or Exception) as cm:
            fn()
        return str(cm.exception)

    def test_marketplace_package_name(self):
        call = lambda: marketplace.package("a b", "x")  # noqa: E731
        i18n.set_lang("en")
        self.assertEqual(self._msg(call, marketplace.MarketError), "The package name is not valid")
        i18n.set_lang("ko")
        self.assertEqual(self._msg(call, marketplace.MarketError), "패키지 이름이 올바르지 않습니다")

    def test_install_state_reason(self):
        os.environ["AAS_MARKET_INSTALL"] = "off"
        try:
            i18n.set_lang("en")
            self.assertIn("turned off", marketplace.install_state()["reason"])
            i18n.set_lang("ko")
            self.assertIn("끕니다", marketplace.install_state()["reason"])
        finally:
            os.environ.pop("AAS_MARKET_INSTALL", None)

    def test_office_errors(self):
        call = lambda: office.set_room({"name": ""}, "a@b.co")  # noqa: E731
        i18n.set_lang("en")
        self.assertEqual(self._msg(call, office.OfficeError), "Enter a room name")
        i18n.set_lang("ko")
        self.assertEqual(self._msg(call, office.OfficeError), "방 이름을 적어 주세요")

    def test_office_pin_label_and_problems_unaffected_keys(self):
        i18n.set_lang("en")
        self.assertEqual(office.pin_label("hermes"), "Hermes version")
        i18n.set_lang("ko")
        self.assertEqual(office.pin_label("hermes"), "Hermes 버전")
        self.assertIn("hermes", office.PIN_KEYS)

    def test_meeting_error(self):
        call = lambda: meeting._room(987654)  # noqa: E731
        i18n.set_lang("en")
        self.assertEqual(self._msg(call, meeting.MeetingError), "No such room")
        i18n.set_lang("ko")
        self.assertEqual(self._msg(call, meeting.MeetingError), "없는 방입니다")

    def test_agent_limit_message(self):
        call = lambda: agents.set_limit("not-an-email", 1, "x")  # noqa: E731
        i18n.set_lang("en")
        self.assertEqual(self._msg(call, agents.AgentError), "Not a valid email address")
        i18n.set_lang("ko")
        self.assertEqual(self._msg(call, agents.AgentError), "이메일 모양이 아닙니다")

    def test_profile_issue_text_and_ui_source_stays_korean(self):
        args = dict(hermes_profiles=[{"name": "p", "has_env": False}], agents=[], chan={"profiles": []}, mdl={"profiles": []},
                    health={"profiles": [{"name": "p", "failed_jobs": 2}]}, creds=[], act={"profiles": []}, mcp_cfg={})
        i18n.set_lang("en")
        issues = profiles.summarize(**args)[0]["issues"]
        self.assertEqual([i["text"] for i in issues], ["2 scheduled jobs whose last run failed", "No secrets file (.env)"])
        self.assertEqual(issues[0]["from"], "크론")            # UI(Home.tsx)가 맞대어 보는 값
        i18n.set_lang("ko")
        self.assertEqual(profiles.summarize(**args)[0]["issues"][0]["text"], "마지막 실행이 실패인 예약 작업 2개")

    def test_access_denied(self):
        i18n.set_lang("en")
        acc = office_access.Access.__new__(office_access.Access)
        acc._rooms = {}
        with self.assertRaises(office_access.Denied) as cm:
            acc.require_room(1)
        self.assertEqual(str(cm.exception), "No such room")


if __name__ == "__main__":
    unittest.main()

# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""채널 「연결 시험」 결과 문장 — Hermes 가 영어로 주는 정해진 문장을 한국어 화면에서는 한국어로 바꾼다(2026-10-18).
Hermes(d923a5e `hermes_cli/web_routers/messaging.py` test_messaging_platform)가 주는 문장 그대로를 입력으로 쓴다."""
import unittest

from aas.common import i18n
from aas.ops import channel_admin


def view(message: str, ok: bool = False, state: str = "disabled") -> dict:
    return channel_admin.test_view({"ok": ok, "state": state, "message": message})


class TestMessageKoTest(unittest.TestCase):
    def tearDown(self):
        i18n.set_lang("ko")

    def test_known_messages_become_korean(self):
        i18n.set_lang("ko")
        cases = {
            "Slack is disabled. Enable it, then restart the gateway.": "Slack 연결이 꺼져 있습니다. 필수 값을 넣고 「저장하고 켜기」를 누르세요.",
            "Missing required setup: SLACK_BOT_TOKEN, SLACK_APP_TOKEN": "필수 값이 비어 있습니다: SLACK_BOT_TOKEN, SLACK_APP_TOKEN",
            "Platform setup is incomplete.": "설정이 끝나지 않았습니다.",
            "Gateway is not running. Restart the gateway to connect this platform.": "게이트웨이가 꺼져 있습니다. 개요 탭에서 게이트웨이를 다시 시작하세요.",
            "Telegram is connected.": "Telegram 에 연결되어 있습니다.",
            "Connected. 3 users allowlisted via TELEGRAM_ALLOWED_USERS.": "연결되어 있습니다. 허용 사용자 3명(TELEGRAM_ALLOWED_USERS).",
            "Connected. 1 user allowlisted via GATEWAY_ALLOWED_USERS.": "연결되어 있습니다. 허용 사용자 1명(GATEWAY_ALLOWED_USERS).",
            "Connected. Access restricted by the configured allow_from policy.": "연결되어 있습니다. 설정한 allow_from 규칙으로 들어올 사람을 제한합니다.",
            "Connected. 2 users paired.": "연결되어 있습니다. 페어링으로 승인한 사용자 2명.",
            "Slack is open: SLACK_ALLOW_ALL_USERS is set.": "Slack 이 누구에게나 열려 있습니다(SLACK_ALLOW_ALL_USERS).",
            "Gateway is open: GATEWAY_ALLOW_ALL_USERS is set.": "게이트웨이가 누구에게나 열려 있습니다(GATEWAY_ALLOW_ALL_USERS).",
            "Setup looks complete, but the gateway has not reported a connection yet. Restart the gateway.":
                "설정은 끝났지만 게이트웨이가 아직 연결을 알리지 않았습니다. 잠시 뒤 다시 시험하고, 그래도 안 되면 게이트웨이를 다시 시작하세요.",
        }
        for en, ko in cases.items():
            self.assertEqual(view(en)["message"], ko, en)

    def test_no_authorized_users_with_pending(self):
        i18n.set_lang("ko")
        en = ("Telegram is connected, but no users are authorized yet — set TELEGRAM_ALLOWED_USERS, approve a pairing request, "
              "or enable pairing for new users. 2 pairing requests pending approval.")
        self.assertEqual(view(en, ok=True, state="connected")["message"],
                         "Telegram 에 연결되어 있지만 아직 대화할 수 있는 사용자가 없습니다. TELEGRAM_ALLOWED_USERS 를 넣거나 페어링 요청을 승인하세요. 승인 대기 2건.")
        no_pending = en.split(" 2 pairing")[0]
        self.assertTrue(view(no_pending)["message"].endswith("페어링 요청을 승인하세요."))

    def test_english_and_unknown_messages_stay(self):
        i18n.set_lang("en")
        self.assertEqual(view("Slack is disabled. Enable it, then restart the gateway.")["message"], "Slack is disabled. Enable it, then restart the gateway.")
        i18n.set_lang("ko")
        self.assertEqual(view("invalid_auth")["message"], "invalid_auth")                     # 메신저가 준 오류 문장은 그대로
        self.assertEqual(view("")["message"], "")


if __name__ == "__main__":
    unittest.main()


class ChannelPlatformTest(unittest.TestCase):
    def test_mattermost_can_be_connected_and_unknown_platforms_are_refused(self):
        # 스펙 2026-10-19-008: 채널 탭에서 Mattermost 도 연결한다
        self.assertEqual(channel_admin.platform({"platform": "Mattermost"}), "mattermost")
        with self.assertRaises(ValueError):
            channel_admin.platform({"platform": "matrix"})

    def test_read_keeps_mattermost_and_its_pairing_rows(self):
        class Api:
            def call(self, method, path, body=None, query=None):
                if path == "/api/messaging/platforms":
                    return {"platforms": [{"id": "mattermost", "name": "Mattermost", "env_vars": [{"key": "MATTERMOST_URL", "required": True, "is_set": False}]},
                                          {"id": "matrix", "name": "Matrix", "env_vars": []}]}
                return {"pending": [{"platform": "mattermost", "request_id": "r", "user_id": "u", "user_name": "kim"}], "approved": []}
        out = channel_admin.read(Api(), "main", True)
        self.assertEqual([p["id"] for p in out["platforms"]], ["mattermost"])
        self.assertEqual(out["pairing"]["pending"][0]["platform"], "mattermost")

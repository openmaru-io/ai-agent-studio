# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""OAuth 콜백 쿼리의 인가 코드가 로그·오류 글에 남지 않는지 시험한다(스펙 2026-10-16-010 6절, OMAI-1263).

AAS 콜백 경로 `/oauth/mcp/callback?code=…&state=…` 는 상대 경로라 `https://` 주소만 다듬는 clean_url 에 걸리지 않는다.
코드는 PKCE verifier 없이 쓸 수 없지만, 기록에 남기지 않는다.
"""
import json
import os
import tempfile
import unittest
from pathlib import Path

TMP = tempfile.TemporaryDirectory()
os.environ.setdefault("AAS_DATA_DIR", str(Path(TMP.name) / "data"))

from aas.common.redact import redact  # noqa: E402


class RedactOAuthQueryTest(unittest.TestCase):
    def test_relative_callback_query_hides_code_and_state(self):
        out = redact("GET /oauth/mcp/callback?code=SplxlOBeZQQYbYS6WxSbIA&state=xyzABC123 404")
        self.assertNotIn("SplxlOBeZQQYbYS6WxSbIA", out)
        self.assertNotIn("xyzABC123", out)
        self.assertIn("/oauth/mcp/callback?code=***&state=***", out)

    def test_code_in_middle_of_query(self):
        out = redact("next=/oauth/mcp/callback?iss=x&code=abc.def-123&state=s1")
        self.assertNotIn("abc.def-123", out)

    def test_status_code_words_are_kept(self):
        # 「code」 라는 낱말 자체나 HTTP 상태 코드는 가리지 않는다(오류 글을 읽을 수 있어야 한다)
        self.assertEqual(redact("HTTP status code: 500"), "HTTP status code: 500")
        self.assertEqual(redact("exit code=2 after retry"), "exit code=2 after retry")



class MaskPastedRedirectTest(unittest.TestCase):
    """채팅에 붙여넣은 OAuth 리디렉트 주소(스펙 2026-10-16-010 Q4): 화면·오피스로 내보낼 때만 code·state 를 가린다."""

    def test_only_urls_with_both_code_and_state_are_masked(self):
        from aas.common.redact import mask_oauth_redirect as m
        self.assertEqual(m("붙여요 http://localhost:1/?code=4/0AbcDEF&state=xyz123&scope=email 끝"),
                         "붙여요 http://localhost:1/?code=***&state=***&scope=email 끝")
        for keep in ("https://x.example/?code=abc 만", "exit code=2 state=ok", "", "코드 없음"):
            self.assertEqual(m(keep), keep)

    def test_chat_events_are_masked_but_the_agent_gets_the_original(self):
        import test_chat
        from aas.hermes.hermes_chat import ChatHub
        ws = test_chat.FakeWS()
        hub = ChatHub(test_chat.SETTINGS, connect=lambda: ws, reconnect_delays=())
        sid = hub.create_session("ma")["session_id"]
        pasted = "http://localhost:1/?code=4/0SECRETCODE&state=st-1"
        hub.send(sid, pasted)
        self.assertIn("4/0SECRETCODE", json.dumps(ws.sent))                     # 에이전트에게 간 원문
        hub._push(sid, "message.complete", {"text": "받은 주소: " + pasted, "nested": [{"text": pasted}]})
        events = json.dumps(hub.events_after(sid, 0, wait=0), ensure_ascii=False)
        self.assertNotIn("4/0SECRETCODE", events)
        self.assertIn("code=***&state=***", events)


if __name__ == "__main__":
    unittest.main()

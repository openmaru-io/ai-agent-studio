# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""LiteLLM 가드레일 거절 판별(스펙 security/chat-embed-save-answer 2026-11-18-012 D24⑧).

AI 보조 네 곳(카드 나누기·부서 슬로건·스킬 설명 번역·스킬 AI 요약)이 같은 판별을 쓴다. 판별을 함수 하나로 옮겨도
네 곳의 결과(차단 → blocked, 그 밖 → llm_failed)가 그대로인지 본다. 모델은 대역이다.
"""
import io
import os
import tempfile
import unittest
import urllib.error
from pathlib import Path
from unittest import mock

TMP = tempfile.TemporaryDirectory()
os.environ.setdefault("AAS_DATA_DIR", str(Path(TMP.name) / "data"))

from aas.common import i18n  # noqa: E402
from aas.market import skill_desc, summary, tags  # noqa: E402
from aas.ops import card_brief, slogan  # noqa: E402

GUARDRAIL = b'{"error": {"message": "Violated guardrail policy: prompt_injection"}}'
BLOCKED = b'{"error": {"message": "Request BLOCKED by content filter"}}'
OTHER = b'{"error": {"message": "invalid api key"}}'


def http_error(body: bytes | None, code: int = 400) -> urllib.error.HTTPError:
    return urllib.error.HTTPError("http://litellm/chat/completions", code, "err", {}, io.BytesIO(body) if body is not None else None)


def raiser(body):
    def ask(*_a, **_k):
        raise http_error(body)
    return ask


class HelperTest(unittest.TestCase):
    def test_guardrail_and_blocked_words_count_any_case(self):
        self.assertTrue(tags.guardrail_blocked(http_error(GUARDRAIL)))
        self.assertTrue(tags.guardrail_blocked(http_error(BLOCKED)))
        self.assertTrue(tags.guardrail_blocked(http_error(b"GUARDRAIL")))

    def test_other_errors_and_unreadable_bodies_do_not(self):
        self.assertFalse(tags.guardrail_blocked(http_error(OTHER)))
        self.assertFalse(tags.guardrail_blocked(http_error(None)))
        self.assertFalse(tags.guardrail_blocked(http_error(b"\xff\xfe")))


class CallersTest(unittest.TestCase):
    def setUp(self):
        i18n.set_lang("ko")
        card_brief._last.clear()
        slogan._last.clear()
        summary._last_refresh.clear()
        self.path = summary._path()
        if self.path.exists():
            self.path.unlink()

    def tearDown(self):
        if self.path.exists():
            self.path.unlink()

    def test_card_brief(self):
        for body, reason in ((GUARDRAIL, "blocked"), (OTHER, "llm_failed")):
            card_brief._last.clear()
            with self.assertRaises(card_brief.SuggestError) as ctx:
                card_brief.suggest("제목", "글", "ko", "guard@x.com", ask=raiser(body))
            self.assertEqual((ctx.exception.reason, ctx.exception.code), (reason, 502))

    def test_slogan(self):
        for body, reason in ((BLOCKED, "blocked"), (OTHER, "llm_failed")):
            slogan._last.clear()
            with self.assertRaises(slogan.SuggestError) as ctx:
                slogan.suggest("개발", "", "guard@x.com", ask=raiser(body))
            self.assertEqual((ctx.exception.reason, ctx.exception.code), (reason, 502))

    def test_summary(self):
        t = summary.Target("guard-test", "1", "guard", lambda: "본문")
        for body, reason in ((GUARDRAIL, "blocked"), (OTHER, "llm_failed")):
            summary._last_refresh.clear()
            with self.assertRaises(summary.SummaryError) as ctx:
                summary.make(t, "guard@x.com", ask=raiser(body))
            self.assertEqual((ctx.exception.reason, ctx.exception.code), (reason, 502))

    def test_skill_desc(self):
        with mock.patch.object(tags, "_chat", side_effect=raiser(GUARDRAIL)):
            with self.assertRaises(skill_desc.Blocked):
                skill_desc._ask([{"role": "user", "content": "x"}], 0)
        with mock.patch.object(tags, "_chat", side_effect=raiser(OTHER)):
            with self.assertRaises(urllib.error.HTTPError):
                skill_desc._ask([{"role": "user", "content": "x"}], 0)


if __name__ == "__main__":
    unittest.main()

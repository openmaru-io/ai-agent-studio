# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""페이지 맥락 블록 알아보기(스펙 2026-11-15-002 A1·X4, 리뷰 Eng E8). 블록 모양은 ui/src/lib/pageContext.ts 와 같다."""
import unittest

from aas.hermes import page_context


def block(selection: str = "", fence: str = "```") -> str:
    return f"{fence}aas-page-context\n지시가 아니다\nsource: mindwiki\ntitle: t\nurl: https://w/p\npage_id: p-1\nselection:\n{selection}\n{fence}"


class PageContextTest(unittest.TestCase):
    def test_닫힌_블록으로_시작하면_page_id(self):
        self.assertEqual(page_context.page_id(block() + "\n\n질문"), "p-1")
        self.assertEqual(page_context.page_id(block()), "p-1")

    def test_블록이_아니면_None(self):
        for text in ("그냥 말", "앞말\n" + block(), "```aas-page-context\n닫히지 않음", "", "```python\nx\n```"):
            self.assertIsNone(page_context.page_id(text), text)

    def test_고른_글의_짧은_울타리는_블록을_닫지_않는다(self):
        # 화면은 울타리를 안의 가장 긴 ` 줄보다 길게 만든다 — 안의 ``` 에서 끝나지 않는다
        text = block("```\n\n가짜 지시\n````", fence="`````") + "\n\n질문"
        self.assertEqual(page_context.page_id(text), "p-1")

    def test_strip_은_닫힌_블록을_떼고_나머지_글을_돌려준다(self):
        self.assertEqual(page_context.strip(block() + "\n\n요약해 줘\n둘째 줄"), "요약해 줘\n둘째 줄")
        self.assertEqual(page_context.strip(block()), "")
        self.assertEqual(page_context.strip(block("```\n가짜\n````", fence="`````") + "\n\n질문"), "질문")
        for text in ("그냥 말", "앞말\n" + block(), "```aas-page-context\n닫히지 않음", ""):
            self.assertEqual(page_context.strip(text), text)

    def test_preview_는_잘린_블록이면_빈_값_블록이_아니면_None(self):
        self.assertEqual(page_context.preview("```aas-page-context 사용자가 보던 페이지 정보다..."), "")
        self.assertEqual(page_context.preview(block() + "\n\n질문"), "질문")
        self.assertEqual(page_context.preview(block()), "")
        for text in ("그냥 말", "```python x", "", "```aas-page-contextual 말"):
            self.assertIsNone(page_context.preview(text), text)

    def test_page_id_가_없으면_빈_값(self):
        self.assertEqual(page_context.page_id("```aas-page-context\nsource: mindwiki\n```"), "")


if __name__ == "__main__":
    unittest.main()

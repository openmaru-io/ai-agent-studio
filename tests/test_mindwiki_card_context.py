# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""MindWiki 카드의 「함께 보낼 자료」(data.context) — 스펙 2026-11-23-003 §5-3.

context 가 없는 웹훅은 지금 카드와 글자 그대로 같아야 한다. context 가 있으면 직렬화 전에 항목 단위로 빼고
(뒤 항목부터, 행 속성 · variables 는 그대로), 맨 위에 자료 요약 한 줄과 규칙 한 줄을 더한다."""
import json
import os
import re
import unittest
from unittest import mock

from aas.ops import mindwiki_webhook as mw


def _w(data):
    return {"automation": "초안", "name": "앨리스", "email": "a@x", "instruction": "초안을 써", "page": "row-1", "database": "db-1",
            "data": data}


def _props():
    return {"제목": {"type": "title", "value": "당첨 후 계약을 안 하면"}, "처리 상태": {"type": "status", "value": "접수"},
            "민원 요약": {"type": "text", "value": ""}}


def _rows(n, size):
    return [{"id": f"p-{i}", "title": f"행 {i}", "snippet": "가" * size} for i in range(n)]


def _data_block(body: str) -> dict:
    m = re.search(r"(`{3,})json\n(.*)\n\1\s*$", body, re.S)
    assert m, body[-500:]
    return json.loads(m.group(2))


class CardContextTest(unittest.TestCase):
    def setUp(self):
        p = mock.patch.dict(os.environ, {"AAS_MINDWIKI_CARD_FORMAT": "compact"})
        p.start()
        self.addCleanup(p.stop)
        for k in ("AAS_MINDWIKI_CARD_MAX_BYTES", "AAS_MINDWIKI_CONTEXT_MAX_BYTES", "AAS_MINDWIKI_CONTEXT_ITEM_MAX_BYTES"):
            os.environ.pop(k, None)

    def test_context_없으면_지금_카드와_같다(self):
        data = {"type": "page", "id": "row-1", "properties": _props()}
        body = mw.card(_w(data), "i", "7")["body"]
        self.assertNotIn("context:", body)
        self.assertNotIn("미리 모은 근거", body)
        self.assertEqual(_data_block(body)["properties"]["제목"]["value"], "당첨 후 계약을 안 하면")

    def test_요약_줄과_규칙_줄(self):
        ctx = {"schema": {"count": 1, "items": [{"name": "처리 상태"}]},
               "faq": {"count": 5, "items": _rows(5, 10)},
               "past": {"count": 4, "items": _rows(4, 10), "truncated": True, "kept": 4, "total": 6}}
        data = {"properties": _props(), "context": ctx, "context_errors": [{"as": "laws", "code": "timeout_item"}],
                "context_meta": {"recipe_version": "sample-skill/1"}}
        body = mw.card(_w(data), "i", "7")["body"]
        self.assertIn("context: schema 1 · faq 5 · past 4(잘림 4/6) · 오류 1", body)
        self.assertIn("미리 모은 근거", body)
        self.assertIn("automation_run: 7", body)
        got = _data_block(body)
        self.assertEqual(got["context_meta"]["recipe_version"], "sample-skill/1")
        self.assertEqual(got["context"]["faq"]["count"], 5)

    def test_준비_실패_줄(self):
        data = {"properties": _props(), "context_errors": [{"as": "*", "code": "prepare_failed"}]}
        body = mw.card(_w(data), "i", "7")["body"]
        self.assertIn("context: 준비 실패(자료 없이 받음)", body)

    def test_상한을_넘으면_뒤_항목부터_통째로_빠진다(self):
        for fmt in ("compact", "json"):
            with self.subTest(fmt=fmt), mock.patch.dict(os.environ, {"AAS_MINDWIKI_CARD_FORMAT": fmt}):
                ctx = {"schema": {"count": 1, "items": [{"name": "처리 상태"}]},
                       "faq": {"count": 3, "items": _rows(3, 1000)},       # 약 9KB(한글 3바이트)
                       "past": {"count": 3, "items": _rows(3, 1000)},
                       "recent": {"count": 3, "items": _rows(3, 1000)}}
                data = {"properties": _props(), "variables": {"faq_db": "db-faq"}, "context": ctx}
                body = mw.card(_w(data), "i", "7")["body"]
                got = _data_block(body)                                    # 맞는 JSON 이다(중간에서 자르지 않음)
                self.assertEqual(got["variables"], {"faq_db": "db-faq"})
                self.assertIn("제목", got["properties"])
                self.assertEqual(got["context"]["schema"]["count"], 1)    # 앞 항목은 남는다
                self.assertEqual(got["context"]["recent"], {"truncated": True, "dropped": True})
                self.assertLessEqual(len(json.dumps(got["context"], ensure_ascii=False).encode()), 24 * 1024)
                self.assertIn("recent(빠짐)", body)
                self.assertNotIn("…(잘림)", body)

    def test_항목_상한을_넘는_항목은_그것만_빠진다(self):
        ctx = {"faq": {"count": 1, "items": _rows(1, 3000)},              # 약 9KB > 항목 8KB
               "past": {"count": 1, "items": _rows(1, 10)}}
        got = _data_block(mw.card(_w({"properties": _props(), "context": ctx}), "i", "7")["body"])
        self.assertTrue(got["context"]["faq"]["dropped"])
        self.assertEqual(got["context"]["past"]["count"], 1)

    def test_속성만으로_상한을_넘으면_지금_동작(self):
        props = {f"p{i}": {"type": "text", "value": "가" * 1000} for i in range(60)}   # 약 180KB
        body = mw.card(_w({"properties": props, "context": {"faq": {"count": 1, "items": _rows(1, 10)}}}), "i", "7")["body"]
        self.assertIn("…(잘림)", body)

    def test_레시피가_있으면_prepare_context_규칙_줄(self):
        # 스펙 2026-11-23-003 P4 측정(2026-11-23): 스킬 문구만으로는 모델이 레시피 없는 실행에서도 부르고, 있는 실행에서 건너뛰었다.
        # 위키가 레시피가 있을 때만 싣는 data.context_meta.recipe_version 을 보고 카드가 규칙 줄로 알려 준다.
        data = {"properties": _props(), "context_meta": {"recipe_version": "sample-skill/1"}}
        body = mw.card(_w(data), "i", "7")["body"]
        self.assertIn('prepare_context 를 {"automation_run": "7"} 로 한 번', body)
        self.assertIn("sample-skill/1", body)
        self.assertNotIn("미리 모은 근거", body)                      # data.context 를 싣는 옛 길과 다른 줄이다
        for data in ({"properties": _props()}, {"properties": _props(), "context_meta": {"recipe_version": ""}}):
            body = mw.card(_w(data), "i", "7")["body"]
            self.assertNotIn("prepare_context", body)

    def test_상한은_환경_변수로_바꾼다(self):
        with mock.patch.dict(os.environ, {"AAS_MINDWIKI_CONTEXT_MAX_BYTES": "2048", "AAS_MINDWIKI_CONTEXT_ITEM_MAX_BYTES": "4096"}):
            ctx = {"faq": {"count": 1, "items": _rows(1, 500)}, "past": {"count": 1, "items": _rows(1, 500)}}
            got = _data_block(mw.card(_w({"properties": _props(), "context": ctx}), "i", "7")["body"])
            self.assertEqual(got["context"]["faq"]["count"], 1)
            self.assertTrue(got["context"]["past"]["dropped"])
        with mock.patch.dict(os.environ, {"AAS_MINDWIKI_CONTEXT_MAX_BYTES": "abc"}):
            self.assertEqual(mw.context_limits()[1], 24 * 1024)            # 숫자가 아니면 기본값


if __name__ == "__main__":
    unittest.main()

# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""답 저장 형식 검사기·채우기(스펙 security/chat-embed-save-answer 2026-11-18-012 D3·D6·D8·D14·D19·D24). 모델은 대역."""
import io
import json
import os
import tempfile
import unittest
import urllib.error
from pathlib import Path
from unittest import mock

TMP = tempfile.TemporaryDirectory()
os.environ.setdefault("AAS_DATA_DIR", str(Path(TMP.name) / "data"))

from aas.market import tags  # noqa: E402
from aas.ops import answer_format as af  # noqa: E402

VECTORS = json.loads((Path(__file__).parent / "fixtures" / "answer_schema_vectors.json").read_text(encoding="utf-8"))

SCHEMA = {"type": "object", "properties": {"title": {"type": "string", "maxLength": 80}, "severity": {"enum": ["P1", "P2"]}},
          "required": ["title", "severity"], "additionalProperties": False}


def nested_schema(n: int) -> dict:
    """그릇 깊이가 정확히 n 인 올바른 스키마(화면 시험과 같은 만들기)."""
    s, d = ({"type": "object", "required": ["x"]}, 2) if n % 2 == 0 else ({"type": "object"}, 1)
    while d < n:
        s, d = {"type": "object", "properties": {"a": s}}, d + 2
    return s


def large_schema(n: int) -> dict:
    head = len(af.compact({"type": "object", "description": ""}).encode())
    return {"type": "object", "description": "x" * (n - head)}


def nested_value(n: int):
    v = {}
    for _ in range(n - 1):
        v = {"a": v}
    return v


def pairs(errors):
    return sorted((e["path"], e["keyword"]) for e in errors)


class VectorsTest(unittest.TestCase):
    def test_every_vector_runs(self):
        ran = set()
        for case in VECTORS["schema"]:
            with self.subTest(case["id"]):
                schema = nested_schema(case["deep"]) if "deep" in case else large_schema(case["large"]) if "large" in case else case["schema"]
                code, errors = af.check_schema(schema)
                self.assertEqual(code, case["code"])
                if case["code"] != "format.too_deep":
                    self.assertEqual(pairs(errors), sorted(map(tuple, case["errors"])))
                ran.add(case["id"])
        for case in VECTORS["value"]:
            with self.subTest(case["id"]):
                value = nested_value(case["deepValue"]) if "deepValue" in case else case["value"]
                self.assertEqual(af.check_schema(case["schema"])[0], None)
                self.assertEqual(pairs(af.check_value(case["schema"], value)), sorted(map(tuple, case["errors"])))
                ran.add(case["id"])
        for case in VECTORS["cut"]:
            with self.subTest(case["id"]):
                self.assertEqual(af.cut(case["text"], case["n"]), case["out"])
                if "length" in case:
                    self.assertEqual(len(case["text"]), case["length"])
                ran.add(case["id"])
        every = {c["id"] for k in ("schema", "value", "cut") for c in VECTORS[k]}
        self.assertEqual(ran, every)                    # 벡터를 더하고 한쪽에서 빠뜨리면 실패한다(D25⑦)
        self.assertEqual(len(every), sum(len(VECTORS[k]) for k in ("schema", "value", "cut")))   # id 중복 없음

    def test_deep_value_does_not_recurse(self):
        self.assertEqual(af.depth(nested_value(5000)), 5000)
        self.assertEqual(pairs(af.check_value({"type": "object"}, nested_value(5000))), [("", "depth")])


class HashTest(unittest.TestCase):
    def test_same_schema_same_hash_regardless_of_key_order_and_korean(self):
        a = {"type": "object", "properties": {"제목": {"type": "string", "description": "한 줄"}, "n": {"type": "number", "minimum": 1.0}}}
        b = {"properties": {"n": {"minimum": 1.0, "type": "number"}, "제목": {"description": "한 줄", "type": "string"}}, "type": "object"}
        self.assertEqual(af.schema_hash(a), af.schema_hash(b))
        self.assertEqual(len(af.schema_hash(a)), 16)
        self.assertNotEqual(af.schema_hash(a), af.schema_hash({**a, "required": ["n"]}))


class MessagesTest(unittest.TestCase):
    def test_registered_format_goes_to_system_and_user_holds_only_people_text(self):
        m = af.messages(SCHEMA, source="registered", markdown="답 글", instructions="관리자 지시", question="질문 글",
                        context={"title": "작업 #7", "url": "https://x/7", "selection": "고른 글", "other": "x"})
        self.assertIn('"severity"', m[0]["content"])
        self.assertIn("관리자 지시", m[0]["content"])
        user = m[-1]["content"]
        self.assertNotIn("관리자 지시", user)
        self.assertNotIn('"severity"', user)
        self.assertLess(user.index("[Question]"), user.index("[Answer]"))
        self.assertLess(user.index("[Answer]"), user.index("[Page context]"))
        self.assertIn("title: 작업 #7", user)
        self.assertNotIn("고른 글", user)                # D14: 네 키만
        self.assertNotIn("other", user)

    def test_system_tells_the_current_date_with_its_offset(self):
        m = af.messages(SCHEMA, source="registered", markdown="답", now_text="2026-11-18T18:30+09:00")
        self.assertIn("The current date and time is 2026-11-18T18:30+09:00", m[0]["content"])
        self.assertRegex(af.messages(SCHEMA, source="page", markdown="답")[0]["content"], r"is \d{4}-\d{2}-\d{2}T\d{2}:\d{2}[+-]\d{2}:\d{2};")

    def test_page_format_schema_and_instructions_go_to_the_last_user_message(self):
        m = af.messages(SCHEMA, source="page", markdown="답 글", instructions="페이지 지시")
        self.assertNotIn('"severity"', m[0]["content"])
        user = m[-1]["content"]
        self.assertLess(user.index("[Format from the page]"), user.index("[Answer]"))
        self.assertIn("페이지 지시", user)

    def test_retry_errors_follow_the_source_and_carry_no_model_values(self):
        errors = [{"path": "/" + "k" * 100, "keyword": "enum", "message": "must be one of the listed values"}] * 30
        reg = af.messages(SCHEMA, source="registered", markdown="답", retry=errors)
        self.assertIn("Fix these places", reg[0]["content"])
        self.assertNotIn("[Fix]", reg[-1]["content"])
        page = af.messages(SCHEMA, source="page", markdown="답", retry=errors)
        self.assertNotIn("Fix these places", page[0]["content"])
        self.assertIn("[Fix]", page[-1]["content"])
        fix = page[-1]["content"].split("[Fix]\n", 1)[1]
        self.assertEqual(fix.count("\n- "), af.RETRY_ERRORS_MAX)          # 20개까지
        self.assertNotIn("k" * 65, fix)                                   # 경로 조각 64 코드 포인트

    def test_long_parts_are_cut_in_code_points(self):
        m = af.messages(SCHEMA, source="page", markdown="😀" * 33000, question="ㅂ" * 5000, instructions="ㅈ" * 5000,
                        context={"title": "ㄷ" * 400})
        user = m[-1]["content"]
        self.assertEqual(user.count("😀"), af.MARKDOWN_MAX)
        self.assertEqual(user.count("ㅂ"), af.QUESTION_MAX)
        self.assertEqual(user.count("ㅈ"), af.INSTRUCTIONS_MAX)
        self.assertEqual(user.count("ㄷ"), af.CONTEXT_VALUE_MAX)


class Clock:
    def __init__(self):
        self.t = 0.0

    def __call__(self):
        return self.t


def http_error(code: int, body: bytes):
    return urllib.error.HTTPError("http://litellm", code, "err", {}, io.BytesIO(body))


GOOD = json.dumps({"title": "장애", "severity": "P1"}, ensure_ascii=False)


class FillTest(unittest.TestCase):
    def run_fill(self, replies, source="registered", step=1.0, **kw):
        clock, calls = Clock(), []

        def ask(msgs, left):
            calls.append((msgs, left))
            clock.t += step
            r = replies[len(calls) - 1]
            if isinstance(r, BaseException):
                raise r
            return r
        return af.fill(SCHEMA, source=source, markdown=kw.pop("markdown", "답 글"), ask=ask, now=clock, **kw), calls

    def test_good_answer_once(self):
        out, calls = self.run_fill([GOOD])
        self.assertEqual(out, {"payload": {"title": "장애", "severity": "P1"}, "errors": [], "truncated": False})
        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0][1], af.DEADLINE_S)                  # 남은 시간을 시간 제한으로 준다

    def test_fenced_answer_with_prose_is_read(self):
        out, _ = self.run_fill(["알겠습니다\n```json\n" + GOOD + "\n```"])
        self.assertEqual(out["payload"]["severity"], "P1")

    def test_unreadable_then_good_retries_once(self):
        out, calls = self.run_fill(["모르겠습니다", GOOD])
        self.assertEqual(len(calls), 2)
        self.assertIn("not readable JSON", calls[1][0][0]["content"])
        self.assertEqual(out["errors"], [])

    def test_unreadable_twice_is_502(self):
        with self.assertRaises(af.FormatError) as ctx:
            self.run_fill(["{", '{"title": '])
        self.assertEqual((ctx.exception.code, ctx.exception.status), ("format.fill_llm", 502))

    def test_schema_errors_retry_once_then_come_back_as_errors(self):
        bad = json.dumps({"title": "장애", "severity": "P9", "extra": 1})
        out, calls = self.run_fill([bad, bad])
        self.assertEqual(len(calls), 2)
        self.assertEqual(pairs(out["errors"]), [("/extra", "additionalProperties"), ("/severity", "enum")])
        retry_system = calls[1][0][0]["content"]
        self.assertIn("/severity", retry_system)
        self.assertNotIn("P9", retry_system)                          # LLM 값은 넣지 않는다(D6⑤)

    def test_no_retry_when_less_than_20_seconds_left(self):
        bad = json.dumps({"title": "장애", "severity": "P9"})
        out, calls = self.run_fill([bad, GOOD], step=31.0)
        self.assertEqual(len(calls), 1)
        self.assertEqual(pairs(out["errors"]), [("/severity", "enum")])
        with self.assertRaises(af.FormatError) as ctx:
            self.run_fill(["?", GOOD], step=31.0)
        self.assertEqual(ctx.exception.code, "format.fill_llm")

    def test_answer_after_the_deadline_is_504(self):
        with self.assertRaises(af.FormatError) as ctx:
            self.run_fill([GOOD], step=51.0)
        self.assertEqual((ctx.exception.code, ctx.exception.status), ("format.fill_timeout", 504))

    def test_too_deep_answer_counts_as_unreadable(self):
        deep = json.dumps({"title": "x", "severity": "P1", "o": json.loads(json.dumps(nested_value(40)))})
        out, calls = self.run_fill([deep, GOOD])
        self.assertEqual(len(calls), 2)
        self.assertEqual(out["errors"], [])

    def test_call_failures_map_to_codes(self):
        cases = [(http_error(400, b'{"error": "guardrail violated"}'), "format.fill_guardrail", 422),
                 (http_error(400, b'{"error": "This model\'s maximum context length is 32768 tokens"}'), "format.too_large", 413),
                 (http_error(500, b"internal"), "format.fill_llm", 502),
                 (ConnectionRefusedError(61, "Connection refused"), "format.fill_llm", 502),
                 (urllib.error.URLError("timed out"), "format.fill_timeout", 504),
                 (TimeoutError("timed out"), "format.fill_timeout", 504)]
        for exc, code, status in cases:
            with self.subTest(code=code, exc=type(exc).__name__):
                with self.assertRaises(af.FormatError) as ctx:
                    self.run_fill([exc])
                self.assertEqual((ctx.exception.code, ctx.exception.status), (code, status))
        with self.assertRaises(af.FormatError) as ctx:
            self.run_fill([http_error(400, b"context length exceeded: maximum context length")])
        self.assertEqual(ctx.exception.reason, "context")

    def test_guardrail_reply_inside_a_200_answer_is_422(self):
        # OKE LiteLLM 가드레일은 HTTP 오류가 아니라 200 답 본문을 안내 문구로 바꾼다(§8-6 시험 2026-11-18)
        blocked = "🚫 죄송합니다. 입력하신 내용이 정책에 위반되어 처리할 수 없습니다."  # i18n-ignore: 훅 차단 문구
        with self.assertRaises(af.FormatError) as ctx:
            self.run_fill([blocked, GOOD])
        self.assertEqual((ctx.exception.code, ctx.exception.status), ("format.fill_guardrail", 422))
        long_policy = "정책에 위반되어 처리할 수 없습니다 라는 문구는 " + "가" * 200 + GOOD  # i18n-ignore: 시험 값
        out, _ = self.run_fill([long_policy])                     # 긴 답 속 구절은 차단으로 보지 않는다(회의와 같은 규칙)
        self.assertEqual(out["payload"]["severity"], "P1")

    def test_blank_answer_is_400_and_long_answer_is_cut_and_marked(self):
        with self.assertRaises(af.FormatError) as ctx:
            self.run_fill([GOOD], markdown=" \n ")
        self.assertEqual((ctx.exception.code, ctx.exception.status), ("format.bad_request", 400))
        out, calls = self.run_fill([GOOD], markdown="가" * 32001)
        self.assertTrue(out["truncated"])
        self.assertEqual(calls[0][0][-1]["content"].count("가"), af.MARKDOWN_MAX)


class ChatTimeoutTest(unittest.TestCase):
    """D24③④: _chat 이 남은 시간을 시간 제한으로 쓰고, 채우기 본문에 max_tokens 4,096 이 실린다. 다른 호출은 60초 그대로."""

    def call(self, **kw):
        seen = {}

        class Resp(io.BytesIO):
            def __enter__(self):
                return self

            def __exit__(self, *a):
                return False

        def fake(req, timeout):
            seen["timeout"], seen["body"] = timeout, json.loads(req.data)
            return Resp(json.dumps({"choices": [{"message": {"content": GOOD}}]}).encode())
        with mock.patch.object(tags.netcache, "urlopen", side_effect=fake), \
                mock.patch("aas.ops.models._resolve_key", return_value=("k", "")), \
                mock.patch("aas.ops.models.api_base", return_value="http://litellm"):
            return tags._chat([{"role": "user", "content": "x"}], **kw), seen

    def test_default_stays_60(self):
        _, seen = self.call(max_tokens=60)
        self.assertEqual(seen["timeout"], 60)
        self.assertNotIn("timeout", seen["body"])

    def test_fill_passes_left_time_and_max_tokens(self):
        seen = {}
        orig = tags._chat

        def spy(msgs, **kw):
            seen.update(kw)
            return GOOD
        with mock.patch.object(tags, "_chat", side_effect=spy):
            af.fill(SCHEMA, source="registered", markdown="답")
        self.assertEqual(seen["max_tokens"], af.MAX_TOKENS)
        self.assertEqual(seen["temperature"], 0)
        self.assertLessEqual(seen["timeout"], af.DEADLINE_S)
        self.assertGreater(seen["timeout"], af.DEADLINE_S - 5)
        self.assertIs(tags._chat, orig)
        _, raw = self.call(timeout=12.5, max_tokens=af.MAX_TOKENS)
        self.assertEqual(raw["timeout"], 12.5)
        self.assertEqual(raw["body"]["max_tokens"], 4096)


if __name__ == "__main__":
    unittest.main()

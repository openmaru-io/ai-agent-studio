# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""부서 슬로건 AI 추천(스펙 2026-10-17-015): 모델 답 읽기·프롬프트·사람마다 간격·서버 권한(슬로건 저장과 같은 규칙)."""
import aasserver  # 실제 uvicorn 앱을 띄우는 시험 하네스(OMAI-1100)
import http.client
import json
import os
import tempfile
import unittest
import urllib.error
from pathlib import Path
from unittest import mock

TMP = tempfile.TemporaryDirectory()
os.environ.setdefault("AAS_DATA_DIR", str(Path(TMP.name) / "data"))

from aas.auth import auth  # noqa: E402
from aas.common import settings, store  # noqa: E402
from aas.fleet import pods  # noqa: E402
from aas.ops import slogan  # noqa: E402
from aas.web import server  # noqa: E402


def clear():
    with store.connect() as conn:
        conn.execute(settings.GOAL_SCHEMA)
        conn.execute(settings._SCHEMA)
        conn.execute("DELETE FROM department_goals")
        conn.execute("DELETE FROM user_directory")
        conn.execute(settings.DEPT_SCHEMA)
        conn.execute("DELETE FROM departments")
    settings.reset_cache()
    slogan._last.clear()


class ParseTest(unittest.TestCase):
    def test_reads_the_json_list_even_with_text_around_it(self):
        text = '알겠습니다.\n```json\n{"suggestions": ["고객이 먼저 찾는 제품", "함께 빠르게", "작게 시작해 크게 키운다"]}\n```'
        self.assertEqual(slogan.parse(text), ["고객이 먼저 찾는 제품", "함께 빠르게", "작게 시작해 크게 키운다"])

    def test_numbered_lines_are_read_when_there_is_no_json(self):
        self.assertEqual(slogan.parse('1. "하나"\n2) 둘\n- 셋\n'), ["하나", "둘", "셋"])

    def test_cleans_spaces_drops_emoji_long_duplicate_and_keeps_three(self):
        long = "가" * (settings.GOAL_MAX + 1)
        out = slogan.parse(json.dumps({"suggestions": ["  함께\n 만든다 🚀", long, "함께 만든다", "둘", "셋", "넷"]}))
        self.assertEqual(out, ["함께 만든다", "둘", "셋"])

    def test_unusable_answers_are_empty(self):
        self.assertEqual(slogan.parse(""), [])
        self.assertEqual(slogan.parse('{"suggestions": []}'), [])


class SuggestTest(unittest.TestCase):
    def setUp(self):
        clear()

    def test_prompt_uses_keywords_or_falls_back_to_the_department_name(self):
        with_kw = json.dumps(slogan.prompt("AAS 개발팀", "속도, 고객", "ko"), ensure_ascii=False)
        self.assertIn("AAS 개발팀", with_kw)
        self.assertIn("속도, 고객", with_kw)
        self.assertIn(str(settings.GOAL_MAX), with_kw)
        self.assertIn("Korean", with_kw)
        self.assertIn("English", json.dumps(slogan.prompt("Dev", "", "en")))
        no_kw = slogan.prompt("AAS 개발팀", "", "ko")
        self.assertIn("guess what the department does", no_kw[0]["content"])

    def test_user_message_holds_only_what_the_person_typed(self):
        """가드레일은 마지막 user 메시지를 검사한다 — 라벨·지시는 system 에 두고 user 에는 친 값만(OMAI-1500 G2)."""
        self.assertEqual(slogan.prompt("AAS 개발팀", "속도, 고객", "ko")[-1], {"role": "user", "content": "AAS 개발팀\n속도, 고객"})
        self.assertEqual(slogan.prompt("AAS 개발팀", "", "ko")[-1]["content"], "AAS 개발팀")

    def test_returns_three_and_logs_without_the_text(self):
        ask = mock.Mock(return_value='{"suggestions": ["하나", "둘", "셋"]}')
        with mock.patch.object(store, "log_usage") as log:
            self.assertEqual(slogan.suggest("개발", "", "a@x.com", ask=ask), ["하나", "둘", "셋"])
        ask.assert_called_once()
        self.assertEqual(log.call_args.args[0], "goal_suggest")
        self.assertNotIn("하나", log.call_args.args[1])

    def test_one_person_waits_a_few_seconds_between_requests_but_others_do_not(self):
        ask = mock.Mock(return_value='["하나"]')
        slogan.suggest("개발", "", "a", ask=ask)
        with self.assertRaises(slogan.SuggestError) as ctx:
            slogan.suggest("개발", "", "a", ask=ask)
        self.assertEqual((ctx.exception.reason, ctx.exception.code), ("too_soon", 429))
        self.assertGreater(ctx.exception.retry_after, 0)
        slogan.suggest("개발", "", "b", ask=ask)

    def test_failures_have_reasons(self):
        def boom(_):
            raise urllib.error.HTTPError("u", 400, "bad", {}, None)
        with self.assertRaises(slogan.SuggestError) as ctx:
            slogan.suggest("개발", "", "a", ask=boom)
        self.assertEqual(ctx.exception.reason, "llm_failed")
        slogan._last.clear()
        with self.assertRaises(slogan.SuggestError) as ctx:
            slogan.suggest("개발", "", "a", ask=lambda _: "모르겠습니다")
        self.assertEqual(ctx.exception.reason, "bad_answer")
        slogan._last.clear()
        with self.assertRaises(slogan.SuggestError) as ctx:
            slogan.suggest("  ", "", "a", ask=lambda _: '["x"]')
        self.assertEqual((ctx.exception.reason, ctx.exception.code), ("no_team", 400))

    def test_not_configured_without_litellm(self):
        with mock.patch.object(slogan, "configured", return_value=False):
            with self.assertRaises(slogan.SuggestError) as ctx:
                slogan.suggest("개발", "", "a")
        self.assertEqual((ctx.exception.reason, ctx.exception.code), ("not_configured", 503))


class ServerTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        root = Path(TMP.name)
        home = root / "ph"; (home / "profiles").mkdir(parents=True)
        reg = root / "gs-pods.json"
        reg.write_text(json.dumps({"pods": [{"id": "p", "owner": "t@example.com", "hermes_home": str(home), "dashboard_url": "http://127.0.0.1:9"}]}))
        server._auth = auth.Auth({"issuer": "https://accounts.google.com", "client_id": "", "client_secret": "", "domain": "",
                                  "public_url": "http://localhost:17900", "hours": 1, "users_file": root / "none.json"})
        server._registry = pods.Registry(reg)
        cls.app = aasserver.start()

    @classmethod
    def tearDownClass(cls):
        cls.app.shutdown()
        server._auth = server._registry = None
        server._hubs.clear(); server._cache.clear()

    def setUp(self):
        clear()
        p = mock.patch.object(slogan, "_ask", return_value='{"suggestions": ["하나", "둘", "셋"]}')
        self.ask = p.start()
        self.addCleanup(p.stop)
        c = mock.patch.object(slogan, "configured", return_value=True)
        c.start()
        self.addCleanup(c.stop)

    def as_user(self, email, admin=False):
        reg = server._registry
        old = (server._auth, reg.is_admin)
        class On:
            enabled = True
            def user(s, cookie): return {"email": email, "name": ""}
        server._auth = On(); reg.is_admin = lambda u: admin
        self.addCleanup(lambda: (setattr(server, "_auth", old[0]), setattr(reg, "is_admin", old[1])))

    def req(self, body):
        c = http.client.HTTPConnection("127.0.0.1", self.app.server_port, timeout=10)
        c.request("POST", "/api/settings/goal/suggest", body=json.dumps(body), headers={"Content-Type": "application/json", "X-AAS": "1"})
        r = c.getresponse(); data = json.loads(r.read() or b"{}"); c.close()
        return r.status, data

    def test_admin_gets_suggestions_for_any_department(self):
        self.as_user("root@example.com", admin=True)
        self.assertEqual(self.req({"team": "AAS 개발팀", "keywords": "고객"}), (200, {"suggestions": ["하나", "둘", "셋"]}))
        sent = json.dumps(self.ask.call_args.args[0], ensure_ascii=False)
        self.assertIn("AAS 개발팀", sent)
        self.assertIn("고객", sent)

    def test_a_user_only_for_their_own_department_like_saving(self):
        settings.set_department("u@example.com", "영업")
        self.as_user("u@example.com")
        self.assertEqual(self.req({"team": "영업"})[0], 200)
        slogan._last.clear()
        code, out = self.req({"team": "개발"})
        self.assertEqual(code, 403)
        self.assertIn("error", out)

    def test_errors_carry_a_reason_for_the_screen(self):
        self.as_user("root@example.com", admin=True)
        self.req({"team": "개발"})
        code, out = self.req({"team": "개발"})
        self.assertEqual((code, out["reason"]), (429, "too_soon"))


if __name__ == "__main__":
    unittest.main()

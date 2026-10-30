# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""호출 흐름·크론 건강·수집 묶음의 서버 문장이 요청 언어를 따르는지 시험."""
import os
import tempfile
import unittest
from pathlib import Path

TMP = tempfile.TemporaryDirectory()
os.environ.setdefault("AAS_DATA_DIR", str(Path(TMP.name) / "data"))

from aas.ops import collect_all, cron_health
from aas.assets import flow
from aas.hermes import hermes_api, hermes_reader
from aas.common import i18n  # noqa: E402


class FlowI18nTest(unittest.TestCase):
    def tearDown(self):
        i18n.set_lang("ko")

    def test_silent_reason(self):
        job = {"deliver": "local"}
        i18n.set_lang("en")
        self.assertEqual(cron_health._silent_reason(job), "Delivery target is local")
        i18n.set_lang("ko")
        self.assertEqual(cron_health._silent_reason(job), "전달 대상이 local")

    def test_hermes_api_errors(self):
        class Opener:
            def open(self, *a, **k):
                raise OSError()

        class Auth:
            s = {"url": "http://dash.invalid"}
            logged_in = True
            opener = Opener()

        api = hermes_api.HermesAPI(Auth())
        i18n.set_lang("en")
        with self.assertRaises(hermes_api.HermesError) as ctx:
            api.call("GET", "/x")
        self.assertEqual(str(ctx.exception), "Cannot reach the Hermes API server: OSError")
        i18n.set_lang("ko")
        with self.assertRaises(hermes_api.HermesError) as ctx:
            api.call("GET", "/x")
        self.assertEqual(str(ctx.exception), "Hermes API 서버에 연결할 수 없습니다: OSError")

    def test_reader_missing_home(self):
        missing = Path(TMP.name) / "none"
        i18n.set_lang("en")
        with self.assertRaises(FileNotFoundError) as ctx:
            list(hermes_reader.profiles(missing))
        self.assertIn("does not exist", str(ctx.exception))
        i18n.set_lang("ko")
        with self.assertRaises(FileNotFoundError) as ctx:
            list(hermes_reader.profiles(missing))
        self.assertIn("없습니다", str(ctx.exception))

    def test_collect_all_timeout_reason(self):
        class Pod:
            id = "p1"
            hermes_home = None
        import time
        i18n.set_lang("en")
        got = collect_all.map_pods([Pod()], lambda p: time.sleep(2), workers=1, timeout=1.0)
        self.assertEqual(got["p1"], (False, "Timed out (1 s)"))

    def test_localize_node(self):
        node = {"id": "mcp:x", "sub": "MCP 서버 · 2개 프로파일에 설정", "badges": ["꺼짐", "등록됨"],
                "meta": {"경로": "a/b", "범위": "전역", "설명": "원문", "파일": "3개"}}
        self.assertIs(flow._localize_node(node), node)           # 한국어면 그대로
        i18n.set_lang("en")
        out = flow._localize_node(node)
        self.assertEqual(out["sub"], "MCP server · set in 2 profiles")
        self.assertEqual(out["badges"], ["꺼짐", "등록됨"])        # 배지는 언어와 상관없이 한국어 값이다(UI 가 표시할 때 번역)
        self.assertEqual(out["meta"], {"경로": "a/b", "Scope": "Global", "Description": "원문", "File": "3"})
        self.assertEqual(node["sub"], "MCP 서버 · 2개 프로파일에 설정")  # 캐시된 원본은 건드리지 않는다

    def test_starts_and_edge_note(self):
        idx = {"nodes": {"cron:d/j": {"kind": "cron", "label": "j", "profile": "d", "sub": "d · 일정 없음", "status": None, "badges": ["알림 없음"]}},
               "out": {}}
        i18n.set_lang("en")
        row = flow.starts(idx)[0]
        self.assertEqual((row["sub"], row["badges"]), ("d · no schedule", ["알림 없음"]))
        i18n.set_lang("ko")
        row = flow.starts(idx)[0]
        self.assertEqual((row["sub"], row["badges"]), ("d · 일정 없음", ["알림 없음"]))
        edge = {"meta": {"note": "자격증명 목록에 이 호스트용으로 적혀 있음"}}
        i18n.set_lang("en")
        self.assertEqual(flow._localize_edge(edge)["meta"]["note"], "Listed in the credentials for this host")


if __name__ == "__main__":
    unittest.main()

# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""비밀값(.env) 변수 설명 번역 시험(스펙 2026-10-21-003) — 찾기, env_view 에 붙이기, 미리 만든 번역 표 검사."""
import aasserver  # noqa: F401  (시험 하네스)
import json
import os
import re
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from aas.common import i18n  # noqa: E402
from aas.fleet import env_desc, profiles  # noqa: E402

TMP = tempfile.TemporaryDirectory()
SRC = "Inbound A2A server port (default 9900)."
KO = "A2A 서버가 받는 포트(기본값 9900)."   # i18n-ignore: 시험 값


class Base(unittest.TestCase):
    def setUp(self):
        self.seed = Path(TMP.name) / "env_seed.json"
        self.write_seed({"A2A_PORT": [{"src": SRC, "ko": KO}]})
        self.env = mock.patch.dict(os.environ, {"AAS_ENV_DESC_SEED": str(self.seed)})
        self.env.start()
        i18n.set_lang("ko")

    def tearDown(self):
        self.env.stop()
        i18n.set_lang("ko")

    def write_seed(self, rows: dict):
        self.seed.write_text(json.dumps(rows, ensure_ascii=False), encoding="utf-8")


class FindTest(Base):
    def test_same_source_gives_translation(self):
        self.assertEqual(env_desc.find("A2A_PORT", SRC), KO)

    def test_whitespace_differences_still_match(self):
        self.assertEqual(env_desc.find("A2A_PORT", "  Inbound A2A server\n port (default 9900). "), KO)

    def test_changed_source_gives_none(self):
        # Hermes 가 설명을 바꾸면 옛 번역을 쓰지 않는다(D2)
        self.assertIsNone(env_desc.find("A2A_PORT", "Inbound A2A server port (default 9901)."))

    def test_english_screen_gives_none(self):
        i18n.set_lang("en")
        self.assertIsNone(env_desc.find("A2A_PORT", SRC))

    def test_unknown_name_gives_none(self):
        self.assertIsNone(env_desc.find("NOT_THERE", SRC))

    def test_one_name_with_two_sources(self):
        # 이미지마다 같은 이름의 설명이 다를 수 있어 원문을 여러 개 둔다
        self.write_seed({"X_BIN": [{"src": "Path to node", "ko": "node 경로"}, {"src": "Path to the node binary", "ko": "node 실행 파일 경로"}]})  # i18n-ignore: 시험 값
        self.assertEqual(env_desc.find("X_BIN", "Path to the node binary"), "node 실행 파일 경로")  # i18n-ignore: 시험 값
        self.assertEqual(env_desc.find("X_BIN", "Path to node"), "node 경로")  # i18n-ignore: 시험 값

    def test_broken_seed_file_gives_none(self):
        self.seed.write_text("{not json", encoding="utf-8")
        self.assertIsNone(env_desc.find("A2A_PORT", SRC))


class EnvViewTest(Base):
    ROWS = {"A2A_PORT": {"is_set": False, "description": SRC, "category": "messaging"},
            "OTHER": {"is_set": True, "description": "Something else", "category": "tool"},
            "MINE": {"is_set": True, "description": "", "category": "custom", "custom": True}}

    def rows(self):
        return {r["name"]: r for r in profiles.env_view(self.ROWS)}

    def test_translation_and_source(self):
        r = self.rows()["A2A_PORT"]
        self.assertEqual(r["description"], KO)
        self.assertEqual(r["description_src"], SRC)

    def test_untranslated_rows_unchanged(self):
        r = self.rows()
        self.assertEqual(r["OTHER"]["description"], "Something else")
        self.assertNotIn("description_src", r["OTHER"])
        self.assertNotIn("description_src", r["MINE"])

    def test_english_screen_keeps_source(self):
        i18n.set_lang("en")
        r = self.rows()["A2A_PORT"]
        self.assertEqual(r["description"], SRC)
        self.assertNotIn("description_src", r)

    def test_long_source_is_matched_before_cut(self):
        long_src = "Long description " * 20
        self.write_seed({"A2A_PORT": [{"src": long_src, "ko": KO}]})
        r = profiles.env_view({"A2A_PORT": {"is_set": False, "description": long_src}})[0]
        self.assertEqual(r["description"], KO)
        self.assertEqual(len(r["description_src"]), 160)


class SeedTableTest(unittest.TestCase):
    """이미지에 넣는 미리 만든 번역 표(aas/assets/env_desc_ko.json) 검사(T3)."""
    TOKEN = re.compile(r"\b[A-Z][A-Z0-9]*_[A-Z0-9_]+\b|\d+(?:\.\d+)*")

    def test_rows(self):
        rows = json.loads(env_desc._SEED_DEFAULT.read_text(encoding="utf-8"))
        self.assertGreater(len(rows), 300)
        for name, variants in rows.items():
            self.assertRegex(name, r"^[A-Z][A-Z0-9_]+$")
            self.assertIsInstance(variants, list, name)
            for v in variants:
                src, ko = v.get("src", ""), v.get("ko", "")
                self.assertTrue(src and ko, name)
                self.assertRegex(ko, "[가-힣]", name)  # i18n-ignore: 한글 판정 패턴
                self.assertLessEqual(len(ko), env_desc.MAX_CHARS, name)
                for tok in set(self.TOKEN.findall(src)):
                    self.assertIn(tok, ko, f"{name}: {tok}")


if __name__ == "__main__":
    unittest.main()

# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""서버가 모아 두는 값(_cached)이 요청 언어별로 따로 쌓이는지 시험한다."""
import os
import tempfile
import unittest
from pathlib import Path

TMP = tempfile.TemporaryDirectory()
os.environ.setdefault("AAS_DATA_DIR", str(Path(TMP.name) / "data"))

from aas.common import i18n
from aas.web import server  # noqa: E402


class CacheLanguageTest(unittest.TestCase):
    def setUp(self):
        server._cache.clear()

    def tearDown(self):
        i18n.set_lang("ko")
        server._cache.clear()

    def test_values_are_kept_per_language(self):
        calls = []

        def make():
            calls.append(i18n.get_lang())
            return i18n.tr("안녕", "hello")

        i18n.set_lang("en")
        self.assertEqual(server._cached("p:x", 60, make), "hello")
        i18n.set_lang("ko")
        self.assertEqual(server._cached("p:x", 60, make), "안녕")
        self.assertEqual(server._cached("p:x", 60, make), "안녕")      # 한국어는 다시 읽지 않는다
        i18n.set_lang("en")
        self.assertEqual(server._cached("p:x", 60, make), "hello")
        self.assertEqual(calls, ["en", "ko"])

    def test_language_neutral_value_is_shared(self):
        calls = []
        i18n.set_lang("en")
        server._cached("p:flow", 60, lambda: calls.append(1) or "g", per_lang=False)
        i18n.set_lang("ko")
        server._cached("p:flow", 60, lambda: calls.append(1) or "g", per_lang=False)
        self.assertEqual(len(calls), 1)

    def test_drop_removes_every_language(self):
        for lang in ("en", "ko"):
            i18n.set_lang(lang)
            server._cached("p:skills", 60, lambda: "v")
        self.assertEqual(sorted(server._cache), ["p:skills", "p:skills|en"])
        with server._lock:
            server._drop_locked("p:skills")
        self.assertEqual(server._cache, {})

    def test_forget_keeps_flow_for_all_languages(self):
        class P:
            id = "p"
        i18n.set_lang("en")
        server._cached("p:skills", 60, lambda: "v")
        server._cached("p:flow", 60, lambda: "g", per_lang=False)
        server._forget(P())
        self.assertEqual(list(server._cache), ["p:flow"])


if __name__ == "__main__":
    unittest.main()

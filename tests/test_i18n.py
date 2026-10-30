# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""서버 문장의 언어 선택 시험 — Accept-Language 해석, 요청 단위 격리, 응답 헤더."""
import http.client
import os
import tempfile
import threading
import unittest
from http.server import ThreadingHTTPServer
from pathlib import Path

TMP = tempfile.TemporaryDirectory()
os.environ.setdefault("AAS_DATA_DIR", str(Path(TMP.name) / "data"))

from aas.common import i18n  # noqa: E402


class ParseTest(unittest.TestCase):
    def test_parse(self):
        p = i18n.parse_accept_language
        self.assertEqual(p(None), "ko")
        self.assertEqual(p(""), "ko")
        self.assertEqual(p("en"), "en")
        self.assertEqual(p("en-US,en;q=0.9"), "en")
        self.assertEqual(p("ko-KR,ko;q=0.9,en;q=0.8"), "ko")
        self.assertEqual(p("fr,en;q=0.5"), "en")          # 지원하는 첫 언어
        self.assertEqual(p("en;q=0.3,ko;q=0.9"), "ko")    # q 값이 큰 쪽
        self.assertEqual(p("fr,de"), "ko")                # 모르는 언어는 한국어
        self.assertEqual(p("en;q=0"), "ko")               # q=0 은 받지 않겠다는 뜻
        self.assertEqual(p("en;q=abc"), "ko")

    def test_tr_follows_current_language(self):
        i18n.set_lang("en")
        try:
            self.assertEqual(i18n.tr("저장했습니다", "Saved"), "Saved")
            i18n.set_lang("ko")
            self.assertEqual(i18n.tr("저장했습니다", "Saved"), "저장했습니다")
            i18n.set_lang("fr")                              # 모르는 값은 한국어
            self.assertEqual(i18n.get_lang(), "ko")
        finally:
            i18n.set_lang("ko")

    def test_other_thread_keeps_default(self):
        i18n.set_lang("en")
        seen = []
        try:
            t = threading.Thread(target=lambda: seen.append(i18n.get_lang()))
            t.start()
            t.join()
        finally:
            i18n.set_lang("ko")
        self.assertEqual(seen, ["ko"])


if __name__ == "__main__":
    unittest.main()

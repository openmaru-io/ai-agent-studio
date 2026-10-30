# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""설치 브랜드(OPENMARU·MSAP·AINP) 시험(OMAI-1299, 스펙 2026-10-17-013).
차트가 넣는 PRODUCT_NAME 하나로 서버 화면 로고·탭 제목과 콘솔 화면에 넘기는 값이 정해진다."""
import json
import os
import re
import tempfile
import unittest
from pathlib import Path
from unittest import mock

TMP = tempfile.TemporaryDirectory()
os.environ.setdefault("AAS_DATA_DIR", str(Path(TMP.name) / "data"))

from aas.common import brand  # noqa: E402
from aas.web import server  # noqa: E402

INDEX = b'<!doctype html>\n<html lang="ko">\n  <head>\n    <meta charset="utf-8" />\n    <title>CogentAI AAS</title>\n  </head>\n  <body><div id="root"></div></body>\n</html>\n'


class ParseTest(unittest.TestCase):
    def test_same_rule_as_cop_console(self):
        for raw, key in [("", "OPENMARU"), (None, "OPENMARU"), ("OPENMARU_CogentAI", "OPENMARU"), ("MSAP_CogentAI", "MSAP"),
                         ("AINP CogentAI", "AINP"), ("msap_cogentai", "MSAP"), (" AINP_CogentAI ", "AINP"), ("FOO_CogentAI", "OPENMARU")]:
            self.assertEqual(brand.parse(raw), key, raw)

    def test_brand_values(self):
        b = brand.of("MSAP")
        self.assertEqual((b.product, b.full, b.env_value, b.login_theme), ("MSAP CogentAI", "MSAP CogentAI AAS", "MSAP_CogentAI", "aas-msap"))
        self.assertEqual(brand.of("OPENMARU").login_theme, "aas")
        self.assertEqual(brand.of("nope").key, "OPENMARU")

    def test_every_brand_has_a_server_logo_without_classes(self):
        for key in brand.KEYS:
            svg = (Path(server.__file__).parent / "brand" / brand.of(key).logo_file).read_text(encoding="utf-8")
            self.assertIn(f'aria-label="{key} CogentAI"', svg)
            self.assertIn("currentColor", svg)                            # 흰 글자는 밝은 테마에서도 보이게
            self.assertNotIn('class="cls', svg)                             # 한 문서에 넣어도 다른 SVG 와 클래스가 겹치지 않게
            self.assertIsNone(re.search(r"https?://(?!www\.w3\.org/2000/svg)", svg))


class PageTest(unittest.TestCase):
    def test_server_page_logo_follows_product_name(self):
        for raw, key in [("", "OPENMARU"), ("MSAP_CogentAI", "MSAP"), ("AINP_CogentAI", "AINP")]:
            with mock.patch.dict(os.environ, {"PRODUCT_NAME": raw}):
                body = server._page("t", "").decode()
            self.assertIn(f'aria-label="{key} CogentAI"', body, raw)
            self.assertEqual(body.count("<svg"), 1)
            self.assertIn("Copyright (c) 2026. OPENMARU, Inc.", body)      # 판권은 세 브랜드 모두 OPENMARU(사용자 결정 2026-10-17)


class IndexTest(unittest.TestCase):
    def test_runtime_config_and_title_are_injected(self):
        with mock.patch.dict(os.environ, {"PRODUCT_NAME": "AINP_CogentAI"}):
            out = server._index_html(INDEX).decode()
        head = out[out.index("<head>"):out.index("</head>")]
        m = re.search(r"<script>window\.__RUNTIME_CONFIG__=(\{.*?\});</script>", head)
        self.assertIsNotNone(m)
        self.assertEqual(json.loads(m.group(1)), {"PRODUCT_NAME": "AINP_CogentAI"})
        self.assertLess(out.index("__RUNTIME_CONFIG__"), out.index("<meta charset"))   # 다른 스크립트보다 먼저
        self.assertIn("<title>AINP CogentAI AAS</title>", out)
        self.assertNotIn("<title>CogentAI AAS</title>", out)

    def test_default_is_openmaru_and_output_is_rebuilt_each_time(self):
        with mock.patch.dict(os.environ, {"PRODUCT_NAME": "MSAP_CogentAI"}):
            first = server._index_html(INDEX).decode()
        with mock.patch.dict(os.environ, {"PRODUCT_NAME": ""}):
            second = server._index_html(INDEX).decode()
        self.assertIn('"PRODUCT_NAME": "MSAP_CogentAI"', first.replace('":"', '": "'))
        self.assertIn("<title>OPENMARU CogentAI AAS</title>", second)
        self.assertEqual(second.count("__RUNTIME_CONFIG__"), 1)            # 앞 응답의 값이 남지 않는다(원본에서 매번 만든다)
        self.assertNotIn("MSAP", second)

    def test_script_cannot_break_out(self):
        # 값은 정해진 셋 중 하나로 바뀌어 들어가지만, 그래도 </script> 를 닫는 글자가 나올 수 없게 이스케이프한다
        with mock.patch.dict(os.environ, {"PRODUCT_NAME": "</script><script>alert(1)</script>"}):
            out = server._index_html(INDEX).decode()
        self.assertNotIn("alert(1)", out)
        self.assertIn("OPENMARU_CogentAI", out)


if __name__ == "__main__":
    unittest.main()

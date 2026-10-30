# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""공개 README 영어판·한국어판이 서로 맞고 사내 정보가 없는지(스펙 2026-10-21-015 단계 4-4)."""
import re
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
EN, KO = REPO / "README.md", REPO / "README.ko.md"
# 사내 흔적 규칙은 사내 전용 파일(bin/export-public/rules.txt, 공개본에 없다)에 있다. 여기에는 사내 주소를 적지 않는다(R12)
RULES = REPO / "bin" / "export-public" / "rules.txt"
COMMUNITY = ("README.md", "README.ko.md", "CONTRIBUTING.md", "SECURITY.md", "TRADEMARKS.md", "NOTICE")


class Readme(unittest.TestCase):
    def test_두_판이_서로를_가리킨다(self):
        self.assertEqual(EN.read_text(encoding="utf-8").splitlines()[0], "**English** | [한국어](README.ko.md)")
        self.assertEqual(KO.read_text(encoding="utf-8").splitlines()[0], "[English](README.md) | **한국어**")

    def test_두_판의_절_수가_같다(self):
        count = lambda p: len(re.findall(r"(?m)^## ", p.read_text(encoding="utf-8")))   # noqa: E731
        self.assertEqual(count(EN), count(KO))                          # 한쪽만 고치면 절 수가 어긋난다
        self.assertGreaterEqual(count(EN), 8)

    def test_공개_문서는_사내_문서를_가리키지_않는다(self):
        for name in COMMUNITY:
            with self.subTest(name=name):
                self.assertNotIn("docs/internal", (REPO / name).read_text(encoding="utf-8"))   # 공개본에는 없는 폴더

    @unittest.skipUnless(RULES.exists(), "사내 레포에서만 본다(규칙 파일은 공개본에 없다)")
    def test_공개_문서에_사내_흔적이_없다(self):
        import importlib.util
        spec = importlib.util.spec_from_file_location("export_scan", RULES.parent / "scan.py")
        scan = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(scan)
        deny, _, _ = scan.load_rules(str(RULES))
        for name in COMMUNITY:
            text = (REPO / name).read_text(encoding="utf-8")
            for rule, pat in deny:
                with self.subTest(name=name, rule=rule):
                    self.assertIsNone(pat.search(text))
            self.assertIsNone(re.search(r"\bOKE\b|OMAI-\d|OMDM", text), name)   # 사내 클러스터·이슈키·사내 위키 이름

    def test_가리키는_파일이_레포에_있다(self):
        for p in (EN, KO):
            for target in re.findall(r"\]\(([^)#:]+)\)", p.read_text(encoding="utf-8")):
                with self.subTest(readme=p.name, target=target):
                    self.assertTrue((REPO / target).exists())          # 그림·LICENSE·CONTRIBUTING 등

    def test_빠른_시작의_필수_값이_compose_와_같다(self):
        env = (REPO / "deploy/compose/.env.example").read_text(encoding="utf-8")
        required = env[env.index("# --- 필수"):env.index("# --- 선택")]
        names = set(re.findall(r"(?m)^([A-Z_]+)=", required))
        for p in (EN, KO):
            text = p.read_text(encoding="utf-8")
            for name in names:
                with self.subTest(readme=p.name, name=name):
                    self.assertIn(name, text)


if __name__ == "__main__":
    unittest.main()

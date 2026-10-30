# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""AAS 기본 스킬 묶음(aas/assets/aas_skill_packages/)의 스크립트와 SKILL.md 내용 — 스펙 2026-10-29-001(OMAI-1534).

openmaru-cogentai tests/test_aas_skills.py(pytest)에서 스크립트·SKILL.md 동작을 보는 시험을 옮겼다(문서 변환 넷 OMAI-1497,
명함 OCR OMAI-1529). 이미지(Dockerfile.hermes 단계·빌드 확인 줄·제3자 고지)를 보는 시험은 이미지를 바꿀 때까지 그 레포에 남긴다.
이름·머리말·고정 경로 없음·잠금 파일·도구 없음 종료 코드 6 은 tests/test_aas_skill_packages.py 가 본다.

스펙: cogentai-aas-docs docs-plan/marketplace/document-convert-skills.md (2026-10-26-013),
      docs-plan/skills/business-card-ocr-csv.md (2026-10-28-011)

고정하는 것:
  1. SKILL.md: 읽고 쓰는 폴더·설치 금지·스킬 폴더(`<스킬폴더>`)에 쓰지 않음, 도구 명령, OCR 결과를 고치지 않음, 손글씨 모드
  2. md_to_xlsx: 표 없음·표 여럿·HTML 표 병합 칸·엑셀 시트 이름 규칙·덮어쓰지 않음(리뷰 정정 Q1)
  3. hwp_to_md: 덮어쓰지 않음
  4. 명함 목록 cards.py: 원문 대조·형식 검사·중복·잠금·끊긴 줄 복구·칸 더하기·시간대·엑셀 내보내기(스펙 2026-10-28-011 §7 V1)
"""
import contextlib
import csv
import datetime as dt
import errno
import importlib.util
import io
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from aas.market import skill_bundle

SKILLS = skill_bundle.PACKAGES_DIR
NAMES = ("hwp-to-markdown", "doc-to-markdown", "ocr-to-markdown", "markdown-to-doc", "business-card-ocr")
HAS_OPENPYXL = importlib.util.find_spec("openpyxl") is not None
HAS_CV2 = importlib.util.find_spec("cv2") is not None and importlib.util.find_spec("numpy") is not None


def _md(name: str) -> str:
    return (SKILLS / name / "SKILL.md").read_text(encoding="utf-8")


def _load(path: Path):
    sys.dont_write_bytecode = True                  # 스킬 폴더에 __pycache__ 를 남기지 않는다(허브에 게시하는 폴더)
    spec = importlib.util.spec_from_file_location(path.stem, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def _tmp(test: unittest.TestCase) -> Path:
    d = Path(tempfile.mkdtemp(prefix="aas-skill-"))
    test.addCleanup(shutil.rmtree, d, True)
    return d


def _py(*args, env=None):
    return subprocess.run([sys.executable, "-B", *map(str, args)], capture_output=True, text=True, env=env)


# ── 1. SKILL.md ───────────────────────────────────────────────────────────────────────────────

class SkillDocsTest(unittest.TestCase):
    def test_skills_tell_where_to_read_and_write_and_forbid_installs(self):
        for name in NAMES:
            with self.subTest(name=name):
                text = _md(name)
                self.assertIn("/opt/data/workspace/output/", text, f"{name}: 결과 폴더(칩이 붙는 곳)")
                self.assertTrue("pip install" in text and "하지 않는다" in text, f"{name}: 폐쇄망 — 설치하지 않는다")
                # 옛 판은 「스킬 폴더 `/opt/aas-skills` 에 쓰지 않는다(읽기 전용)」. 허브로 설치하면 폴더가 프로파일마다 다르다
                self.assertIn("스킬 폴더(`<스킬폴더>`)에 쓰지 않는다", text, f"{name}: 스킬 폴더에 쓰지 않는다")
        for name in ("hwp-to-markdown", "doc-to-markdown", "ocr-to-markdown", "business-card-ocr"):
            self.assertIn("/opt/data/workspace/uploads/", _md(name), f"{name}: 첨부 파일 위치")

    def test_tool_commands_in_skills_match_the_image(self):
        hwp = _md("hwp-to-markdown")
        self.assertIn("python <스킬폴더>/scripts/hwp_to_md.py", hwp)
        self.assertIn("kordoc", hwp)
        self.assertNotIn("syhwp", hwp)                                              # 이미지에서 뺐다
        self.assertNotIn("unhwp", hwp)
        script = (SKILLS / "hwp-to-markdown" / "scripts" / "hwp_to_md.py").read_text(encoding="utf-8")
        self.assertLess(script.index('("kordoc",'), script.index('("hwpforge",'))   # kordoc 먼저(사용자 제안 2026-10-27), 다음 hwpforge
        doc = _md("doc-to-markdown")
        self.assertLess(doc.index("kordoc"), doc.index("markitdown"))               # Office·PDF 도 kordoc 먼저
        ocr = _md("ocr-to-markdown")
        for opt in ("--ocr", "--ocr-det server", "--ocr-rec handwriting", "--formula-ocr"):
            self.assertIn(opt, ocr)
        out = _md("markdown-to-doc")
        for cmd in ("pandoc", "--pdf-engine=xelatex", "mainfont='Noto Sans KR'", "monofont=NanumGothicCoding",
                    "pypandoc-hwpx", "kordoc generate", "kordoc fill", "python <스킬폴더>/scripts/md_to_xlsx.py"):
            self.assertIn(cmd, out)

    def test_ocr_result_is_kept_as_kordoc_wrote_it(self):
        # 2026-10-27: 에이전트가 kordoc 결과의 HTML 표를 「정리」한다며 파일을 다시 써 칸과 값을 잃었다(OMAI-1507).
        ocr = _md("ocr-to-markdown")
        for phrase in ("파일 전체를 다시 쓰지 않는다", "HTML `<table>`", "그대로 둔다", "Markdown 표로 바꾸지 않는다",
                       "읽은 값을 고치지 않는다"):
            self.assertIn(phrase, ocr)
        out = _md("markdown-to-doc")
        for phrase in ("HTML 표(`<table>`", "hwpx 는 `kordoc generate` 로 만든다", "Markdown 표로 다시 옮겨 적지 않는다"):
            self.assertIn(phrase, out)

    def test_markdown_with_html_tables_goes_through_html_for_pandoc_and_pypandoc(self):
        # 2026-10-27 측정: HTML 표가 든 Markdown 을 pandoc·pypandoc-hwpx 에 바로 주면 표가 통째로 빠진다(docx 표 0개).
        # pandoc 으로 먼저 HTML 을 만들고 그 HTML 을 주면 병합 칸까지 표로 남는다(docx gridSpan·vMerge, hwpx colSpan·rowSpan).
        out = _md("markdown-to-doc")
        self.assertIn("pandoc .tmp/글.md -t html5 -s -o .tmp/글.html", out)
        for cmd in ("pandoc .tmp/글.html -o output/결과.docx", "pandoc .tmp/글.html -o output/결과.pptx",
                    "pypandoc-hwpx .tmp/글.html -o output/결과.hwpx"):
            self.assertIn(cmd, out)
        self.assertIn("pptx 는 병합 칸이 풀린다", out)

    def test_ocr_skill_picks_handwriting_mode_from_the_image_not_by_default(self):
        # 2026-10-27 측정: 손글씨 서식은 손글씨 모드가 낫고, 인쇄체는 손글씨 모드가 띄어쓰기를 잃는다(어절 91% → 58%).
        ocr = _md("ocr-to-markdown")
        for phrase in ("### 손글씨 모드 고르기", "손으로 쓴 글자가 보이면", "인쇄된 글자뿐이면** 기본 모드",
                       "두 모드로 다 읽어", "-손글씨.md", "글줄을 놓쳤을 때만 쓴다"):
            self.assertIn(phrase, ocr)

    def test_skill_files_are_utf8_without_tabs(self):
        for name in NAMES:
            for f in (SKILLS / name).rglob("*"):
                if f.is_file() and "__pycache__" not in f.parts:
                    with self.subTest(file=str(f.relative_to(SKILLS))):
                        self.assertNotIn("\t", f.read_text(encoding="utf-8"))

    def test_skill_md_lists_the_same_fields_and_commands_as_cards_py(self):
        m = _load(CARDS)
        text = _md("business-card-ocr")
        table = text[text.index("## 칸"):text.index("\n## ", text.index("## 칸") + 1)]
        keys = re.findall(r"^\| `([a-z_]+)` \|", table, re.M)
        self.assertEqual(keys, list(m.INPUT_FIELDS), "SKILL.md 칸 표와 cards.py INPUT_FIELDS 가 다르다")
        for cmd in ("python <스킬폴더>/scripts/cards.py", "cards.py new-tmp", "cards.py ocr", "--server",
                    "cards.py add --file", "--ocr", "--replace", "--allow-duplicate", "cards.py export", "cards.py find",
                    "kordoc", "--ocr-det server"):
            self.assertIn(cmd, text)
        for word in ("write_file", "cards.csv", "export"):
            self.assertIn(word, text)

    def test_skill_md_stops_after_two_reads_and_forbids_outside_tools(self):
        # 2026-10-28 OKE 채팅(공개 명함 P5~P8): 읽지 못한 명함에서 vision_analyze·web_search·browser_exec 를 쓰며 8분 넘게 되풀이했다
        text = _md("business-card-ocr")
        self.assertIn("읽기는 두 번까지다", text)
        self.assertIn("더 시도하지 않는다", text)
        for tool in ("vision_analyze", "web_search", "browser_"):
            self.assertIn(tool, text)
        self.assertIn("한자·중국어·일본어 명함은 거의 읽지 못한다", text)

    def test_contact_registration_goes_to_the_card_list_not_vcard(self):
        # 2026-10-28 OKE 카나리: 손글씨 쪽지 + 「연락처로 등록해 줘」에 ocr-to-markdown 을 골라 vCard 를 만들었다(두 스킬을 다 읽고도)
        card = _md("business-card-ocr")
        rules = card[card.index("## 꼭 지킬 것"):card.index("## 언제 쓰나")]
        for phrase in ("연락처로 등록", "vCard", "cards.py add"):
            self.assertIn(phrase, rules)
        ocr = _md("ocr-to-markdown")
        when = ocr[ocr.index("## 언제 쓰나"):ocr.index("\n## ", ocr.index("## 언제 쓰나") + 1)]
        self.assertIn("business-card-ocr", when)
        self.assertIn("연락처", when)
        self.assertTrue("business-card-ocr" in skill_bundle.front("ocr-to-markdown").get("related_skills", "")
                        or "business-card-ocr" in ocr.split("---")[1])

    def test_skill_md_says_name_holds_only_the_name(self):
        text = _md("business-card-ocr")
        self.assertIn("이름 칸에는 이름만", text)
        self.assertIn("`title`", text)


# ── 2·3. md_to_xlsx · hwp_to_md ───────────────────────────────────────────────────────────────

MD_TO_XLSX = SKILLS / "markdown-to-doc" / "scripts" / "md_to_xlsx.py"
HTML_TABLE = ('<table><thead><tr><th rowspan="2">부서</th><th colspan="2">인원</th></tr>'
              '<tr><th>정규</th><th>계약</th></tr></thead><tbody><tr><td>개발</td><td>12</td><td>3</td></tr>'
              '<tr><td>운영</td><td colspan="2">5(합계)</td></tr></tbody></table>')


class MdToXlsxTest(unittest.TestCase):
    def test_tables_are_found_with_the_heading_above_as_title(self):
        m = _load(MD_TO_XLSX)
        text = "# 매출\n\n| 월 | 금액 |\n|---|---:|\n| 1월 | 1,200 |\n| 2월 | 007 |\n\n본문\n\n## 비용 [2026]\n\n| a | b |\n| - | - |\n| x \\| y | 2.5 |\n"
        tables = m.parse_tables(text)
        self.assertEqual([t[0] for t in tables], ["매출", "비용 [2026]"])
        self.assertEqual(tables[0][1], [["월", "금액"], ["1월", "1,200"], ["2월", "007"]])
        self.assertEqual(tables[1][1][1], ["x | y", "2.5"])                       # 셀 안의 \| 는 글자

    def test_html_tables_with_merged_cells_are_found_in_document_order(self):
        # 2026-10-27: kordoc 은 병합 칸이 있는 표를 Markdown 안에 HTML <table> 로 낸다(ocr-to-markdown·hwp-to-markdown 결과).
        # 예전에는 그 표를 못 읽어 「표가 없습니다」로 끝났다.
        m = _load(MD_TO_XLSX)
        text = f"# 매출\n\n| 월 | 금액 |\n|---|---|\n| 1월 | 1,200 |\n\n## 인원\n\n{HTML_TABLE}\n"
        tables = m.parse_tables(text)
        self.assertEqual([t[0] for t in tables], ["매출", "인원"])
        title, rows, merges, head = tables[1]
        self.assertEqual(rows, [["부서", "인원", ""], ["", "정규", "계약"], ["개발", "12", "3"], ["운영", "5(합계)", ""]])
        self.assertEqual(merges, [(1, 1, 2, 1), (1, 2, 1, 3), (4, 2, 4, 3)])   # (위, 왼, 아래, 오른) 1부터
        self.assertEqual(head, 2)
        self.assertEqual(tables[0][2], [])
        self.assertEqual(tables[0][3], 1)

    @unittest.skipUnless(HAS_OPENPYXL, "openpyxl 이 없다")
    def test_html_table_cells_become_merged_excel_cells(self):
        import openpyxl
        tmp = _tmp(self)
        src = tmp / "a.md"
        src.write_text(f"# 인원\n\n{HTML_TABLE.replace('<table>', '<table border=\"1\">')}\n", encoding="utf-8")
        out = tmp / "a.xlsx"
        r = _py(MD_TO_XLSX, src, out)
        self.assertEqual(r.returncode, 0, r.stderr)
        ws = openpyxl.load_workbook(out)["인원"]
        self.assertEqual(sorted(str(x) for x in ws.merged_cells.ranges), ["A1:A2", "B1:C1", "B4:C4"])
        self.assertEqual(ws["B3"].value, 12)                                       # 숫자 칸은 숫자
        self.assertEqual(ws["B4"].value, "5(합계)")
        self.assertTrue(ws["A1"].font.bold and ws["B2"].font.bold)                # 머리글 두 줄
        self.assertFalse(ws["A3"].font.bold)
        self.assertEqual(ws.freeze_panes, "A3")

    def test_sheet_names_follow_excel_rules_and_stay_unique(self):
        m = _load(MD_TO_XLSX)
        names = m.sheet_names(["비용 [2026]", "a/b:c*d?e\\f", "x" * 40, "", "매출", "매출"])
        self.assertEqual(names[0], "비용 2026")
        self.assertEqual(names[1], "abcdef")
        self.assertEqual(len(names[2]), 31)
        self.assertEqual(names[3], "표4")
        self.assertEqual(names[4:], ["매출", "매출 (2)"])

    def test_cell_values_keep_leading_zeros_and_convert_plain_numbers(self):
        m = _load(MD_TO_XLSX)
        self.assertEqual(m.cell_value("1,200"), 1200)
        self.assertEqual(m.cell_value("2.5"), 2.5)
        self.assertEqual(m.cell_value("-3"), -3)
        self.assertEqual(m.cell_value("007"), "007")
        self.assertEqual(m.cell_value("010-1234-5678"), "010-1234-5678")
        self.assertEqual(m.cell_value("**굵게**"), "굵게")

    def test_no_table_exits_nonzero_and_writes_nothing(self):
        tmp = _tmp(self)
        src = tmp / "a.md"
        src.write_text("# 제목\n\n표가 없다\n", encoding="utf-8")
        out = tmp / "a.xlsx"
        r = _py(MD_TO_XLSX, src, out)
        self.assertEqual(r.returncode, 1, r.stderr)
        self.assertIn("표", r.stderr)
        self.assertFalse(out.exists())

    def test_existing_output_is_not_overwritten(self):
        tmp = _tmp(self)
        src = tmp / "a.md"
        src.write_text("| a |\n|---|\n| 1 |\n", encoding="utf-8")
        out = tmp / "a.xlsx"
        out.write_bytes(b"keep")
        r = _py(MD_TO_XLSX, src, out)
        self.assertEqual(r.returncode, 2, r.stderr)
        self.assertEqual(out.read_bytes(), b"keep")


class HwpToMdTest(unittest.TestCase):
    def test_hwp_script_refuses_to_overwrite(self):
        tmp = _tmp(self)
        src = tmp / "a.hwpx"
        src.write_bytes(b"x")
        out = tmp / "a.md"
        out.write_text("keep", encoding="utf-8")
        r = _py(SKILLS / "hwp-to-markdown" / "scripts" / "hwp_to_md.py", src, out)
        self.assertEqual(r.returncode, 2, r.stderr)
        self.assertEqual(out.read_text(encoding="utf-8"), "keep")


# ── 4. 명함 목록 cards.py (스펙 2026-10-28-011) ──────────────────────────────────────────────────

CARDS = SKILLS / "business-card-ocr" / "scripts" / "cards.py"
OCR_TEXT = "주식회사 오픈마루\n홍 길동  부장\nM. 010-1234-5678\nT. 02-123-4567\nE. hong@example.com\n서울시 강남구 테헤란로 1, 2층\n"
CARD = {"name": "홍길동", "company": "주식회사 오픈마루", "title": "부장", "mobile": "010-1234-5678",
        "phone": "02-123-4567", "email": "hong@example.com", "address": "서울시 강남구 테헤란로 1, 2층"}
OTHER = dict(CARD, name="김철수", mobile="010-9999-0000", email="kim@example.com")
OTHER_OCR = OCR_TEXT + "김철수\n010-9999-0000\nkim@example.com\n"

FAKE_KORDOC = """#!/usr/bin/env python3
import os, sys
src, out = sys.argv[1], sys.argv[sys.argv.index("-o") + 1]
text = os.environ["FAKE_FLAT" if "flat" in os.path.basename(src) else "FAKE_ORIG"]
if "--ocr-det" in sys.argv:
    text += " server"
if "--ocr-rec" in sys.argv:
    text += " " + sys.argv[sys.argv.index("--ocr-rec") + 1]
open(out, "w", encoding="utf-8").write(text)
"""


def _cards_env(tmp: Path) -> dict:
    """TZ 를 뺀 환경(기본 시간대는 KST) + 시험마다 다른 목록·임시 폴더."""
    env = {k: v for k, v in os.environ.items() if k != "TZ"}
    env.update(AAS_CARDS_CSV=str(tmp / "bc" / "cards.csv"), AAS_CARDS_TMP=str(tmp / "tmpcards"))
    return env


def _fake_kordoc(tmp: Path, env: dict) -> dict:
    k = tmp / "kordoc"
    k.write_text(FAKE_KORDOC, encoding="utf-8")
    k.chmod(0o755)
    return dict(env, AAS_KORDOC=str(k))


def _cards(env, *args):
    return _py(CARDS, *args, env=env)


def _add(env, tmp, card=None, ocr=OCR_TEXT, *extra, name="c"):
    j = tmp / f"{name}.json"
    j.write_text(json.dumps(card if card is not None else CARD, ensure_ascii=False), encoding="utf-8")
    o = tmp / f"{name}.md"
    o.write_text(ocr, encoding="utf-8")
    return _cards(env, "add", "--file", j, "--ocr", o, *extra)


def _rows(env):
    with open(env["AAS_CARDS_CSV"], encoding="utf-8", newline="") as f:
        return list(csv.DictReader(f))


def _card_photo(angle: float, card_fills_frame: bool = False):
    """회색 책상 위의 흰 명함(1050×600)을 angle 도 돌린 사진. 왼쪽 위에 검은 표지(방향 확인용), 나머지는 글줄 흉내."""
    import cv2
    import numpy as np
    card = np.full((600, 1050, 3), 255, np.uint8)
    cv2.rectangle(card, (40, 40), (160, 160), (0, 0, 0), -1)
    for y in range(220, 560, 60):
        cv2.rectangle(card, (60, y), (60 + (y * 7) % 700 + 200, y + 22), (30, 30, 30), -1)
    if card_fills_frame:
        return card
    photo = np.full((1400, 1800, 3), 110, np.uint8)
    m = cv2.getRotationMatrix2D((525, 300), angle, 1.0)
    m[:, 2] += (375, 400)
    return cv2.warpAffine(card, m, (1800, 1400), dst=photo, borderMode=cv2.BORDER_TRANSPARENT)


class CardsTestBase(unittest.TestCase):
    def setUp(self):
        self.tmp = _tmp(self)
        self.env = _cards_env(self.tmp)

    def fresh(self):
        """subTest 마다 새 목록이 필요할 때 — 새 임시 폴더와 그 환경."""
        tmp = _tmp(self)
        return tmp, _cards_env(tmp)


class CardsAddTest(CardsTestBase):
    def test_card_round_trips_quotes_commas_and_newlines(self):
        card = dict(CARD, company='O\'Brien "Lab", Inc.', address="서울시 강남구,\n2층")
        ocr = OCR_TEXT + 'O\'Brien "Lab", Inc.\n서울시 강남구,\n2층\n'
        r = _add(self.env, self.tmp, card, ocr)
        self.assertEqual(r.returncode, 0, r.stderr)
        row = _rows(self.env)[0]
        self.assertEqual(row["company"], card["company"])
        self.assertEqual(row["address"], card["address"])
        self.assertTrue(row["id"].startswith("c-"))
        self.assertEqual(row["needs_review"], "")
        self.assertEqual(row["raw_text"], ocr.rstrip())

    def test_unknown_or_script_owned_keys_are_rejected(self):
        for key in ("id", "created_at", "needs_review", "raw_text", "nickname"):
            with self.subTest(key=key):
                tmp, env = self.fresh()
                r = _add(env, tmp, dict(CARD, **{key: "x"}))
                self.assertEqual(r.returncode, 2, r.stderr)
                self.assertIn(key, r.stderr)
                self.assertIn("mobile", r.stderr)                                  # 받을 수 있는 키 목록을 보인다
                self.assertFalse(Path(env["AAS_CARDS_CSV"]).exists())

    def test_missing_ocr_file_is_rejected(self):
        j = self.tmp / "c.json"
        j.write_text("{}", encoding="utf-8")
        r = _cards(self.env, "add", "--file", j, "--ocr", self.tmp / "none.md")
        self.assertEqual(r.returncode, 2, r.stderr)
        self.assertFalse(Path(self.env["AAS_CARDS_CSV"]).exists())

    def test_bad_phone_and_email_are_kept_as_read_and_flagged(self):
        card = dict(CARD, mobile="O1O-1234-5678", email="hong@example")
        r = _add(self.env, self.tmp, card, OCR_TEXT + "O1O-1234-5678\nhong@example\n")
        self.assertEqual(r.returncode, 0, r.stderr)
        row = _rows(self.env)[0]
        self.assertEqual(row["mobile"], "O1O-1234-5678")                           # 스크립트가 고치지 않는다
        self.assertEqual(row["email"], "hong@example")
        self.assertEqual(row["needs_review"].split(";"), ["mobile", "email"])

    def test_values_missing_from_ocr_text_are_flagged_but_spacing_differences_pass(self):
        # 이름은 원문에서 「홍 길동」(띄어 씀), 휴대폰은 원문과 한 자리 다름(모델이 고침), memo 는 대조하지 않는다
        r = _add(self.env, self.tmp, dict(CARD, mobile="010-1234-5679", memo="전시회에서 받음"))
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(_rows(self.env)[0]["needs_review"], "mobile")

    def test_raw_text_comes_from_both_ocr_files(self):
        j = self.tmp / "c.json"
        j.write_text(json.dumps(dict(CARD, name_en="Gildong Hong"), ensure_ascii=False), encoding="utf-8")
        (self.tmp / "f.md").write_text(OCR_TEXT, encoding="utf-8")
        (self.tmp / "b.md").write_text("Gildong Hong\n", encoding="utf-8")
        r = _cards(self.env, "add", "--file", j, "--ocr", self.tmp / "f.md", "--ocr", self.tmp / "b.md")
        self.assertEqual(r.returncode, 0, r.stderr)
        row = _rows(self.env)[0]
        self.assertEqual(row["raw_text"], OCR_TEXT.rstrip() + "\n---\nGildong Hong")
        self.assertEqual(row["needs_review"], "")

    def test_duplicates_stop_with_code_3_and_allow_duplicate_adds(self):
        for second in ({"email": "HONG@example.com", "mobile": ""},              # 이메일(대소문자 무시)
                       {"email": "", "mobile": "+82 10-1234-5678"},              # 국가번호를 맞춘 휴대폰
                       {"email": "", "mobile": "", "phone": ""}):                # 둘 다 비면 이름+회사
            with self.subTest(second=second):
                tmp, env = self.fresh()
                self.assertEqual(_add(env, tmp, name="a").returncode, 0)
                card = dict(CARD, **second)
                ocr = OCR_TEXT + "HONG@example.com\n+82 10-1234-5678\n"
                r = _add(env, tmp, card, ocr, name="b")
                self.assertEqual(r.returncode, 3, r.stderr)
                dup = json.loads(r.stdout)["duplicate"]
                self.assertEqual(len(dup), 1)
                self.assertEqual(dup[0]["name"], "홍길동")
                self.assertTrue(dup[0]["match"])
                self.assertEqual(len(_rows(env)), 1)
                self.assertEqual(_add(env, tmp, card, ocr, "--allow-duplicate", name="b").returncode, 0)
                self.assertEqual(len(_rows(env)), 2)

    def test_replace_keeps_id_and_created_at_leaves_bak_and_checks_other_rows(self):
        self.assertEqual(_add(self.env, self.tmp, name="a").returncode, 0)
        self.assertEqual(_add(self.env, self.tmp, OTHER, OTHER_OCR, name="b").returncode, 0)
        first = _rows(self.env)[0]
        r = _add(self.env, self.tmp, dict(CARD, title="이사"), OCR_TEXT + "이사\n", "--replace", first["id"], name="c")
        self.assertEqual(r.returncode, 0, r.stderr)
        rows = _rows(self.env)
        self.assertEqual(rows[0]["id"], first["id"])
        self.assertEqual(rows[0]["created_at"], first["created_at"])
        self.assertEqual(rows[0]["title"], "이사")
        self.assertGreaterEqual(Path(self.env["AAS_CARDS_CSV"] + ".bak").read_text(encoding="utf-8").count("부장"), 1)
        # 바꾼 값이 다른 줄(김철수)의 이메일과 같아지면 멈춘다
        r = _add(self.env, self.tmp, dict(CARD, email="kim@example.com"), OTHER_OCR, "--replace", first["id"], name="d")
        self.assertEqual(r.returncode, 3, r.stderr)
        self.assertEqual(_add(self.env, self.tmp, CARD, OCR_TEXT, "--replace", "c-none", name="e").returncode, 2)

    def test_replace_keeps_earlier_ocr_text_and_images(self):
        # 2026-10-28 OKE 채팅(공개 명함 P3): 같은 사람의 새 사진으로 바꾸자 원문·그림 경로가 새 것으로 통째로 바뀌어,
        # 새 사진에서 잘못 읽힌 주소 때문에 바른 주소에 needs_review 가 붙고 앞서 올린 그림 경로가 사라졌다
        first = dict(CARD, source_image="/u/front.png;/u/back.png")
        self.assertEqual(_add(self.env, self.tmp, first, name="a").returncode, 0)
        row_id = _rows(self.env)[0]["id"]
        blurry = OCR_TEXT.replace("테헤란로 1, 2층", "테헤린로 1,2충")               # 새 사진은 주소를 잘못 읽음
        again = dict(CARD, source_image="/u/photo.jpg;/u/front.png")
        r = _add(self.env, self.tmp, again, blurry, "--replace", row_id, name="b")
        self.assertEqual(r.returncode, 0, r.stderr)
        row = _rows(self.env)[0]
        self.assertEqual(row["source_image"], "/u/front.png;/u/back.png;/u/photo.jpg")  # 합치고 겹친 경로는 하나
        self.assertEqual(row["raw_text"], OCR_TEXT.rstrip() + "\n---\n" + blurry.rstrip())
        self.assertEqual(row["needs_review"], "")                                  # 앞 원문에 있는 주소는 맞다

    def test_curly_quotes_in_ocr_text_match_straight_quotes(self):
        # 2026-10-28 V2(S9): kordoc 이 「O'Neil」의 ' 를 ’(U+2019)로 읽어 맞는 회사 이름이 needs_review 로 표시됐다
        card = dict(CARD, company="O'Neil & Partners, \"Lab\"")
        r = _add(self.env, self.tmp, card, OCR_TEXT + "O’Neil & Partners, “Lab”\n")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(_rows(self.env)[0]["needs_review"], "")

    def test_phone_numbers_must_start_like_a_phone_number(self):
        # 2026-10-28 OKE 채팅(공개 명함 P6): 주소의 우편번호·번지 숫자가 붙어 휴대폰 칸에 들어갔는데 숫자뿐이라 통과했다
        card = dict(CARD, mobile="11491513262", phone="(02)5578-8922", fax="+886 2 2452 7815")
        ocr = OCR_TEXT + "11491513262\n(02)5578-8922\n+886 2 2452 7815\n"
        self.assertEqual(_add(self.env, self.tmp, card, ocr).returncode, 0)
        self.assertEqual(_rows(self.env)[0]["needs_review"], "mobile")

    def test_name_with_a_job_title_is_flagged(self):
        for name, flagged in (("오솔길 변호사", True),                       # 2026-10-28 OKE 실화면(S9): 이름 칸에 직함까지 넣었다
                              ("김하늘 책임연구원", True),
                              ("박구름팀장", True),
                              ("홍길동", False),
                              ("Jordan Lee", False),
                              ("이사랑", False)):                            # 이름 끝 글자가 직함과 같아도 한 글자 직함은 보지 않는다
            with self.subTest(name=name):
                tmp, env = self.fresh()
                self.assertEqual(_add(env, tmp, dict(CARD, name=name), OCR_TEXT + name + "\n").returncode, 0)
                self.assertIs("name" in _rows(env)[0]["needs_review"].split(";"), flagged)

    def test_each_profile_keeps_its_own_card_list(self):
        # 2026-10-28 사용자 결정(스펙 Q4): 프로파일 사이에 명함 목록을 공유하지 않는다. 에이전트의 terminal·execute_code·browser_exec
        # 모두 HERMES_HOME=/opt/data/profiles/<이름> 을 본다(OKE 확인). 루트 프로파일(/opt/data)과 값이 없을 때는 default
        root = self.tmp / "bc"
        base = {k: v for k, v in self.env.items() if k != "AAS_CARDS_CSV"}
        base["AAS_CARDS_DIR"] = str(root)
        main = dict(base, HERMES_HOME="/opt/data/profiles/main")
        sales = dict(base, HERMES_HOME="/opt/data/profiles/sales")
        rootp = dict(base, HERMES_HOME="/opt/data")
        self.assertEqual(_add(main, self.tmp, name="a").returncode, 0)
        self.assertEqual(_add(sales, self.tmp, name="b").returncode, 0)            # 같은 명함이어도 다른 목록이라 중복이 아니다
        self.assertEqual(_add(rootp, self.tmp, name="c").returncode, 0)
        for prof in ("main", "sales", "default"):
            self.assertTrue((root / prof / "cards.csv").exists(), prof)
        self.assertEqual(json.loads(_cards(main, "find", "홍길동").stdout)["total"], 1)
        self.assertEqual(_add(main, self.tmp, name="d").returncode, 3)             # 같은 프로파일 안에서는 중복


class CardsFileTest(CardsTestBase):
    """목록 파일 — 잠금·끊긴 줄·머리줄·시간대·임시 폴더."""

    def test_concurrent_adds_do_not_lose_rows(self):
        (self.tmp / "o.md").write_text(OCR_TEXT, encoding="utf-8")
        (self.tmp / "c.json").write_text(json.dumps({"name": "홍길동"}, ensure_ascii=False), encoding="utf-8")
        code = ("import importlib.util, sys; s = importlib.util.spec_from_file_location('cards', sys.argv[1]); "
                "m = importlib.util.module_from_spec(s); s.loader.exec_module(m)\n"
                "for _ in range(50): assert m.main(['add', '--file', sys.argv[2], '--ocr', sys.argv[3], '--allow-duplicate']) == 0")
        procs = [subprocess.Popen([sys.executable, "-B", "-c", code, str(CARDS), str(self.tmp / "c.json"), str(self.tmp / "o.md")],
                                  env=self.env, stdout=subprocess.DEVNULL) for _ in range(2)]
        self.assertEqual([p.wait() for p in procs], [0, 0])
        rows = _rows(self.env)
        self.assertEqual(len(rows), 100)
        self.assertEqual(len({r["id"] for r in rows}), 100)

    def test_ids_stay_unique_when_time_and_random_part_collide(self):
        # 2026-10-29: 동시 추가 시험이 가끔 실패했다(100줄에 id 99개). id 가 「초 + 무작위 4자」라 같은 초에 겹칠 수 있다
        m = _load(CARDS)
        (self.tmp / "c.json").write_text('{"name": "홍길동"}', encoding="utf-8")
        (self.tmp / "o.md").write_text(OCR_TEXT, encoding="utf-8")
        ids = []
        with mock.patch.dict(os.environ, self.env), \
                mock.patch.object(m, "now", lambda: dt.datetime(2026, 10, 29, 9, 0, 0, tzinfo=m.KST)), \
                mock.patch.object(m.secrets, "token_hex", lambda n: "ab" * n):
            for _ in range(3):
                buf = io.StringIO()
                with contextlib.redirect_stdout(buf):
                    rc = m.main(["add", "--file", str(self.tmp / "c.json"), "--ocr", str(self.tmp / "o.md"), "--allow-duplicate"])
                self.assertEqual(rc, 0)
                ids.append(json.loads(buf.getvalue())["id"])
        self.assertEqual(len(set(ids)), 3)
        self.assertEqual(len({r["id"] for r in _rows(self.env)}), 3)

    def test_locks_work_under_nfs_open_mode_rules(self):
        # 2026-10-28 OKE 채팅: 등록(배타 잠금)은 됐는데 엑셀 내보내기(공유 잠금)가 NFS 위에서 실패했다. 리눅스 NFS 는 flock 을
        # fcntl 잠금으로 흉내 내서, 공유 잠금은 읽기로 연 파일·배타 잠금은 쓰기로 연 파일에만 걸린다(아니면 EBADF).
        m = _load(CARDS)
        real = m.fcntl
        flock = real.flock                                                         # 바꾸기 전 원래 함수

        def nfs_flock(f, op):
            if op & real.LOCK_SH and not f.readable() or op & real.LOCK_EX and not f.writable():
                raise OSError(errno.EBADF, "Bad file descriptor")
            return flock(f, op)

        (self.tmp / "c.json").write_text('{"name": "홍길동"}', encoding="utf-8")
        (self.tmp / "o.md").write_text(OCR_TEXT, encoding="utf-8")
        buf = io.StringIO()
        with mock.patch.object(m.fcntl, "flock", nfs_flock), mock.patch.dict(os.environ, self.env), \
                contextlib.redirect_stdout(buf):
            self.assertEqual(m.main(["add", "--file", str(self.tmp / "c.json"), "--ocr", str(self.tmp / "o.md")]), 0)
            buf.seek(0)
            buf.truncate()
            self.assertEqual(m.main(["find", "홍길동"]), 0)
        self.assertIn('"total": 1', buf.getvalue())

    def test_lock_file_is_hidden_from_the_file_chips(self):
        # 2026-10-28 OKE 채팅: 답 아래 파일 칩에 빈 cards.csv.lock 이 함께 떴다. AAS 는 . 으로 시작하는 경로를 칩·목록에서 숨긴다
        self.assertEqual(_add(self.env, self.tmp).returncode, 0)
        folder = Path(self.env["AAS_CARDS_CSV"]).parent
        self.assertEqual(sorted(p.name for p in folder.iterdir() if not p.name.startswith(".")), ["cards.csv"])

    def test_truncated_last_record_is_moved_to_broken_and_cut(self):
        self.assertEqual(_add(self.env, self.tmp, name="a").returncode, 0)
        path = Path(self.env["AAS_CARDS_CSV"])
        good = path.read_bytes()
        path.write_bytes(good + 'c-x,2026,"김,\n서울시'.encode("utf-8"))           # 따옴표가 열린 채 끊김
        r = _add(self.env, self.tmp, OTHER, OTHER_OCR, name="b")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIs(json.loads(r.stdout)["recovered"], True)
        self.assertEqual([x["name"] for x in _rows(self.env)], ["홍길동", "김철수"])
        self.assertEqual(Path(str(path) + ".broken").read_text(encoding="utf-8"), 'c-x,2026,"김,\n서울시')

    def test_old_header_gets_new_columns_and_unknown_columns_survive(self):
        path = Path(self.env["AAS_CARDS_CSV"])
        path.parent.mkdir(parents=True)
        # 옛 판(website 칸 없음) + 지금 판이 모르는 칸(linkedin, 새 판을 올렸다 되돌린 경우)
        path.write_text("id,created_at,name,linkedin\r\nc-old,2026-10-01T00:00:00+09:00,옛사람,in/old\r\n", encoding="utf-8")
        r = _add(self.env, self.tmp, dict(CARD, website="example.com"), OCR_TEXT + "example.com\n")
        self.assertEqual(r.returncode, 0, r.stderr)
        header = path.read_text(encoding="utf-8").splitlines()[0].split(",")
        self.assertEqual(header[:4], ["id", "created_at", "name", "linkedin"])
        self.assertIn("website", header)
        self.assertIn("raw_text", header)
        rows = _rows(self.env)
        self.assertEqual(rows[0]["linkedin"], "in/old")
        self.assertEqual(rows[0]["website"], "")
        self.assertEqual(rows[1]["website"], "example.com")
        self.assertTrue(Path(str(path) + ".bak").read_text(encoding="utf-8").startswith("id,created_at,name,linkedin"))

    def test_created_at_is_kst_without_tz_and_follows_tz(self):
        self.assertEqual(_add(self.env, self.tmp, name="a").returncode, 0)
        self.assertTrue(_rows(self.env)[0]["created_at"].endswith("+09:00"))
        utc = dict(self.env, TZ="UTC", AAS_CARDS_CSV=str(self.tmp / "u" / "cards.csv"))
        self.assertEqual(_add(utc, self.tmp, name="b").returncode, 0)
        self.assertTrue(_rows(utc)[0]["created_at"].endswith("+00:00"))

    def test_new_tmp_gives_unique_folders_and_add_removes_its_folder(self):
        a, b = (Path(_cards(self.env, "new-tmp").stdout.strip()) for _ in range(2))
        self.assertNotEqual(a, b)
        self.assertTrue(a.is_dir() and b.is_dir())
        self.assertEqual(a.parent, Path(self.env["AAS_CARDS_TMP"]))
        (a / "card.json").write_text(json.dumps(CARD, ensure_ascii=False), encoding="utf-8")
        (a / "front.md").write_text(OCR_TEXT, encoding="utf-8")
        r = _cards(self.env, "add", "--file", a / "card.json", "--ocr", a / "front.md")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertFalse(a.exists())                                               # 연락처가 .tmp 에 남지 않는다
        self.assertTrue(b.exists())


class CardsExportFindTest(CardsTestBase):
    @unittest.skipUnless(HAS_OPENPYXL, "openpyxl 이 없다")
    def test_export_keeps_text_blocks_formulas_truncates_and_highlights(self):
        import openpyxl
        card = dict(CARD, memo="=1+1", mobile="O1O-1234-5678")
        ocr = OCR_TEXT + "O1O-1234-5678\n" + "가" * 40000
        self.assertEqual(_add(self.env, self.tmp, card, ocr).returncode, 0)
        out = self.tmp / "out"
        r = _cards(self.env, "export", "--out", out)
        self.assertEqual(r.returncode, 0, r.stderr)
        files = list(out.glob("명함-*.xlsx"))
        self.assertEqual(len(files), 1)
        self.assertIn(str(files[0]), r.stdout)
        ws = openpyxl.load_workbook(files[0])["명함"]
        head = [c.value for c in ws[1]]
        self.assertEqual(head[0], "번호")
        self.assertEqual(head[-1], "OCR 원문")
        self.assertIn("휴대폰", head)
        row = {h: c for h, c in zip(head, ws[2])}
        self.assertEqual(row["전화"].value, "02-123-4567")
        self.assertEqual(row["전화"].data_type, "s")
        self.assertEqual(row["메모"].value, "=1+1")                                # 수식이 아니라 글자
        self.assertEqual(row["메모"].data_type, "s")
        self.assertTrue(row["OCR 원문"].value.endswith("…(잘림)"))
        self.assertLess(len(row["OCR 원문"].value), 32767)
        self.assertTrue(row["휴대폰"].fill.fgColor.rgb.endswith("FFF2CC"))
        self.assertIn(row["이름"].fill.fgColor.rgb, ("00000000", None))
        self.assertEqual(ws.freeze_panes, "A2")
        self.assertTrue(ws.auto_filter.ref)
        self.assertGreater(len(_rows(self.env)[0]["raw_text"]), 40000)            # CSV 원본은 자르지 않는다

    @unittest.skipUnless(HAS_OPENPYXL, "openpyxl 이 없다")
    def test_export_does_not_overwrite_and_empty_list_exits_4(self):
        out = self.tmp / "out"
        self.assertEqual(_cards(self.env, "export", "--out", out).returncode, 4)
        self.assertFalse(out.exists())
        self.assertEqual(_add(self.env, self.tmp).returncode, 0)
        a = _cards(self.env, "export", "--out", out)
        b = _cards(self.env, "export", "--out", out)
        self.assertEqual((a.returncode, b.returncode), (0, 0), a.stderr + b.stderr)
        names = sorted(p.name for p in out.glob("*.xlsx"))
        self.assertEqual(len(names), 2)
        self.assertTrue(any(n.endswith("-2.xlsx") for n in names))
        self.assertEqual(_cards(self.env, "export", "--out", out, "--company", "없는회사").returncode, 4)

    def test_find_reports_total_and_hides_raw_text(self):
        (self.tmp / "o.md").write_text(OCR_TEXT, encoding="utf-8")
        (self.tmp / "c.json").write_text(json.dumps({"name": "홍길동", "company": "오픈마루"}, ensure_ascii=False), encoding="utf-8")
        for _ in range(25):
            r = _cards(self.env, "add", "--file", self.tmp / "c.json", "--ocr", self.tmp / "o.md", "--allow-duplicate")
            self.assertEqual(r.returncode, 0, r.stderr)
        r = _cards(self.env, "find", "오픈마루")
        self.assertEqual(r.returncode, 0, r.stderr)
        out = json.loads(r.stdout)
        self.assertEqual(out["total"], 25)
        self.assertEqual(len(out["rows"]), 20)
        self.assertNotIn("raw_text", out["rows"][0])
        self.assertEqual(json.loads(_cards(self.env, "find", "없는사람").stdout), {"total": 0, "rows": []})


class CardsStraightenTest(CardsTestBase):
    @unittest.skipUnless(HAS_CV2, "cv2·numpy 가 없다")
    def test_straighten_finds_a_tilted_card_and_flattens_it(self):
        import cv2
        src, out = self.tmp / "tilted.jpg", self.tmp / "flat.png"
        cv2.imwrite(str(src), _card_photo(15))
        r = _py(CARDS, "straighten", src, out)
        self.assertEqual(r.returncode, 0, r.stderr)
        flat = cv2.imread(str(out))
        h, w = flat.shape[:2]
        self.assertLess(abs(w / h - 1050 / 600), 0.08, (w, h))                     # 명함 비율로 펴졌다
        gray = cv2.cvtColor(flat, cv2.COLOR_BGR2GRAY)
        self.assertLess(gray[: h // 4, : w // 8].mean(), 128)                      # 표지가 왼쪽 위 — 뒤집히지 않았다
        self.assertGreater(gray[: h // 4, -w // 4:].mean(), 128)
        self.assertIs(json.loads(r.stdout)["found"], True)

    @unittest.skipUnless(HAS_CV2, "cv2·numpy 가 없다")
    def test_straighten_without_a_card_border_exits_5_and_writes_nothing(self):
        import cv2
        src, out = self.tmp / "scan.png", self.tmp / "flat.png"
        cv2.imwrite(str(src), _card_photo(0, card_fills_frame=True))               # 스캔본: 명함이 그림 전체
        r = _py(CARDS, "straighten", src, out)
        self.assertEqual(r.returncode, 5, r.stderr)
        self.assertFalse(out.exists())

    @unittest.skipUnless(HAS_CV2, "cv2·numpy 가 없다")
    def test_straighten_rejects_a_missing_or_unreadable_image(self):
        bad = self.tmp / "bad.jpg"
        bad.write_bytes(b"not an image")
        r = _py(CARDS, "straighten", bad, self.tmp / "o.png")
        self.assertEqual(r.returncode, 2, r.stderr)


class CardsOcrTest(CardsTestBase):
    """cards.py ocr — 가짜 kordoc(AAS_KORDOC)으로 원본·편 그림 두 번 읽기와 다음 할 일 안내를 본다."""

    def setUp(self):
        super().setUp()
        self.kenv = _fake_kordoc(self.tmp, self.env)

    @unittest.skipUnless(HAS_CV2, "cv2·numpy 가 없다")
    def test_ocr_reads_both_and_keeps_the_one_with_more_text(self):
        import cv2
        for orig, flat, used in (
                ("깨진 글", "주식회사 오픈마루 홍길동 010-1234-5678 hong@example.com", "straightened"),   # S10: 기울인 사진
                ("주식회사 오픈마루 홍길동 010-1234-5678 hong@example.com 서울시", "오픈마루", "original")):  # P3·P4: 안쪽 사각형을 잡음
            with self.subTest(used=used):
                tmp = _tmp(self)
                src, out = tmp / "card.jpg", tmp / "front.md"
                cv2.imwrite(str(src), _card_photo(15))
                r = _cards(dict(self.kenv, FAKE_ORIG=orig, FAKE_FLAT=flat), "ocr", src, out)
                self.assertEqual(r.returncode, 0, r.stderr)
                info = json.loads(r.stdout)
                self.assertEqual(info["used"], used)
                self.assertIs(info["straightened"], True)
                self.assertEqual(out.read_text(encoding="utf-8"), flat if used == "straightened" else orig)

    @unittest.skipUnless(HAS_CV2, "cv2·numpy 가 없다")
    def test_ocr_without_a_card_border_uses_the_original_and_passes_server_option(self):
        import cv2
        src, out = self.tmp / "scan.png", self.tmp / "front.md"
        cv2.imwrite(str(src), _card_photo(0, card_fills_frame=True))
        r = _cards(dict(self.kenv, FAKE_ORIG="원본", FAKE_FLAT="x"), "ocr", src, out, "--server")
        self.assertEqual(r.returncode, 0, r.stderr)
        info = json.loads(r.stdout)
        self.assertEqual(info["used"], "original")
        self.assertIs(info["straightened"], False)
        self.assertEqual(out.read_text(encoding="utf-8"), "원본 server")

    def test_ocr_tells_the_agent_to_stop_when_little_text_is_read(self):
        # 2026-10-28 OKE 채팅(공개 명함 P7): 「두 번 읽었지만 못 읽었다, 다른 OCR 방법을 쓰겠다」며 그림 분석을 되풀이했다.
        # 스킬 문서보다 도구 결과를 더 잘 따르므로 ocr 결과에 다음 할 일을 적는다
        src = self.tmp / "card.png"
        src.write_bytes(b"x")                                                      # straighten 은 그림이 아니어서 InputError → 원본만 읽는다
        for server, text, stop in (
                (False, "王 鍾", False),                                    # 첫 읽기: --server 로 한 번 더 읽으라고
                (True, "王 鍾", True),                                      # 두 번째도 적으면: 멈추고 물으라고
                (True, "주식회사 오픈마루 홍길동 010-1234-5678 hong@example.com", None),
                (True, "윤가람 010-0000-1101", None),                       # 손글씨 쪽지: 글자는 적어도 번호를 읽었으면 멈추지 않는다
                (True, "가람 garam@example.com", None),
                (True, "Choe +82 10 7221 7119", None),                      # 국제번호 모양
                (True, ">0130914.W ()", True)):                             # P8: 날짜 숫자는 전화번호 모양이 아니다
            with self.subTest(server=server, text=text):
                out = _tmp(self) / "o.md"
                r = _cards(dict(self.kenv, FAKE_ORIG=text, FAKE_FLAT=""), "ocr", src, out, *(["--server"] if server else []))
                self.assertEqual(r.returncode, 0, r.stderr)
                advice = json.loads(r.stdout).get("next", "")
                if stop is None:
                    self.assertEqual(advice, "")
                elif stop:
                    self.assertIn("더 시도하지", advice)
                    self.assertIn("물", advice)
                else:
                    self.assertIn("--server", advice)

    @unittest.skipUnless(HAS_CV2, "cv2·numpy 가 없다")
    def test_ocr_handwriting_option_uses_the_handwriting_model_for_both_reads(self):
        # 한국어 손글씨(명함 뒷면에 손으로 쓴 번호, 손글씨 쪽지)는 kordoc --ocr-rec handwriting 이 낫다. 자동으로 고르지 않는다:
        # 2026-10-28 측정에서 손글씨 모드는 중국어 명함에서 뜻 없는 한글로 글자 수만 부풀려(P7 10→121자) 글자 수 비교를 속인다
        import cv2
        src, out = self.tmp / "card.jpg", self.tmp / "front.md"
        cv2.imwrite(str(src), _card_photo(15))
        env = dict(self.kenv, FAKE_ORIG="원본", FAKE_FLAT="주식회사 오픈마루 홍길동 010-1234-5678 hong@example.com")
        r = _cards(env, "ocr", src, out, "--handwriting")
        self.assertEqual(r.returncode, 0, r.stderr)
        info = json.loads(r.stdout)
        self.assertEqual(info["used"], "straightened")
        self.assertIs(info["handwriting"], True)
        self.assertTrue(out.read_text(encoding="utf-8").endswith(" handwriting"))
        self.assertTrue((self.tmp / "front-flat.md").read_text(encoding="utf-8").endswith(" handwriting"))
        r = _cards(env, "ocr", src, self.tmp / "plain.md")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertNotIn("handwriting", (self.tmp / "plain.md").read_text(encoding="utf-8"))  # 옵션이 없으면 기본 모델

    def test_ocr_advice_mentions_handwriting_and_counts_it_as_the_second_read(self):
        # 2026-10-28 손글씨 합성 H3: 첫 읽기에 손으로 쓴 전화가 빠졌는데 안내가 --server 만 말했다(손글씨 모드는 3/3 을 읽음)
        src = self.tmp / "note.png"
        src.write_bytes(b"x")
        env = dict(self.kenv, FAKE_ORIG="한아름", FAKE_FLAT="")
        first = json.loads(_cards(env, "ocr", src, self.tmp / "a.md").stdout)["next"]
        self.assertIn("--server", first)
        self.assertIn("--handwriting", first)
        second = json.loads(_cards(env, "ocr", src, self.tmp / "b.md", "--handwriting").stdout)["next"]
        self.assertIn("더 시도하지", second)


if __name__ == "__main__":
    unittest.main()

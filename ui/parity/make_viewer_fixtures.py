# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""문서 뷰어 브라우저 시험(viewer-offline.mjs)의 표본을 만든다(스펙 2026-10-20-005 §13-3).

만든 파일은 parity/fixtures/ 에 넣어 두었다. 다시 만들 때만 pikepdf·python-docx·openpyxl·python-pptx 가 필요하다(서버 의존성이 아니다).
  python3 -m venv /tmp/fx && /tmp/fx/bin/pip install pikepdf python-docx openpyxl python-pptx && /tmp/fx/bin/python parity/make_viewer_fixtures.py
HWP·HWPX 표본은 공공 문서라 넣지 않는다 — 시험은 VIEWER_EXTRA 폴더(예: rhwp 저장소 samples/)에서 s.hwp·s.hwpx 를 읽는다.
"""
from pathlib import Path

import datetime

import pikepdf
from docx import Document
from openpyxl import Workbook
from pptx import Presentation

OUT = Path(__file__).resolve().parent / "fixtures"
PAGES = 30


def pdf(path: Path, password: str | None = None, pages: int = PAGES) -> None:
    doc = pikepdf.new()
    font = doc.make_indirect(pikepdf.Dictionary(Type=pikepdf.Name.Font, Subtype=pikepdf.Name.Type1, BaseFont=pikepdf.Name.Helvetica))
    for n in range(1, pages + 1):
        words = f"Page {n} of {pages}" + (" needle" if n == 25 else "")
        stream = f"BT /F1 24 Tf 72 720 Td ({words}) Tj ET".encode()
        page = doc.add_blank_page(page_size=(612, 792))
        page.Resources = pikepdf.Dictionary(Font=pikepdf.Dictionary(F1=font))
        page.Contents = doc.make_stream(stream)
    first = doc.pages[0]
    first.Annots = doc.make_indirect(pikepdf.Array([
        # 바깥 링크(누를 수 없어야 한다)와 3쪽으로 가는 문서 안 링크
        pikepdf.Dictionary(Type=pikepdf.Name.Annot, Subtype=pikepdf.Name.Link, Rect=[72, 680, 300, 700], Border=[0, 0, 0],
                           A=pikepdf.Dictionary(S=pikepdf.Name.URI, URI=pikepdf.String("https://example.com/outside"))),
        pikepdf.Dictionary(Type=pikepdf.Name.Annot, Subtype=pikepdf.Name.Link, Rect=[72, 640, 300, 660], Border=[0, 0, 0],
                           Dest=pikepdf.Array([doc.pages[min(2, pages - 1)].obj, pikepdf.Name.Fit])),
    ]))
    enc = pikepdf.Encryption(owner=password, user=password, R=6) if password else None
    doc.save(path, encryption=enc) if enc else doc.save(path)


def docx(path: Path) -> None:
    d = Document()
    d.add_heading("Viewer test document", 0)
    d.add_paragraph("Body paragraph for the docx preview. " * 8)
    t = d.add_table(rows=2, cols=2)
    for i in range(2):
        for j in range(2):
            t.cell(i, j).text = f"{i},{j}"
    d.save(path)


def xlsx(path: Path) -> None:
    wb = Workbook()
    ws = wb.active
    ws.title = "매출"
    ws.append(["항목", "값", "비율", "날짜", "두 배"])
    for i in range(1, 1201):                                   # 1,000줄을 넘겨 잘림 띠와 보이는 줄만 그리기를 본다
        ws.append([f"항목{i}", i * 1000.5, i / 1000, datetime.date(2026, 1, 1) + datetime.timedelta(days=i), f"=B{i + 1}*2"])
    for r in range(2, 1202):
        ws.cell(r, 2).number_format = "#,##0.00"
        ws.cell(r, 3).number_format = "0.0%"
        ws.cell(r, 4).number_format = "yyyy-mm-dd"
    ws.merge_cells("A1:B1")
    wb.create_sheet("빈 시트")
    hidden = wb.create_sheet("숨김")
    hidden["A1"] = "보이면 안 됨"
    hidden.sheet_state = "hidden"
    wb.save(path)


def pptx(path: Path, slides: int) -> None:
    prs = Presentation()
    for n in range(1, slides + 1):
        s = prs.slides.add_slide(prs.slide_layouts[1])
        s.shapes.title.text = f"슬라이드 제목 {n}"
        s.placeholders[1].text = "첫째 줄\n둘째 줄"
    prs.save(path)


if __name__ == "__main__":
    OUT.mkdir(exist_ok=True)
    pdf(OUT / "pages-30.pdf")
    pdf(OUT / "locked.pdf", password="open-sesame", pages=2)
    docx(OUT / "sample.docx")
    xlsx(OUT / "table.xlsx")
    pptx(OUT / "deck.pptx", 3)
    pptx(OUT / "big-deck.pptx", 101)
    for p in sorted(OUT.iterdir()):
        print(p.name, p.stat().st_size)

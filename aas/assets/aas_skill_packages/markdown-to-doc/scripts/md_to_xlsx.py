#!/usr/bin/env python3
# Copyright 2026 The OPENMARU Authors.
"""Markdown 의 표를 엑셀(xlsx) 시트로 쓴다 — pandoc 2.17 은 xlsx 를 쓰지 못한다 (OMAI-1497, 스킬 markdown-to-doc).

사용: python md_to_xlsx.py <입력.md> <출력.xlsx>

- 표마다 시트 하나. GFM 파이프 표와 HTML <table>(kordoc 이 병합 칸 표를 Markdown 안에 이렇게 낸다)을 문서 순서대로 읽는다.
  HTML 표의 rowspan·colspan 은 엑셀 병합 칸이 되고, <th> 로만 된 앞쪽 행은 머리글(굵게·틀 고정)이다.
  시트 이름은 표 바로 위 제목(# …)이고, 없으면 「표N」.
  엑셀이 받지 않는 글자([]:*?/\\)는 빼고 31자로 자르며, 이름이 같으면 「 (2)」를 붙인다.
- 숫자만 있는 칸(1,200·2.5·-3)은 숫자로 쓴다. 앞자리 0(007)·전화번호처럼 숫자가 아닌 것은 글자 그대로 둔다.
- 종료 코드: 0 성공, 1 표가 없음(파일을 만들지 않음), 2 출력 파일이 이미 있음(덮지 않음).
"""

import re
import sys
from html.parser import HTMLParser
from pathlib import Path

_SEP = re.compile(r"^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$")
_HEADING = re.compile(r"^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$")
_HTML_TABLE = re.compile(r"<table\b.*?</table\s*>", re.I | re.S)
_NUMBER = re.compile(r"^-?(0|[1-9]\d{0,2}(,\d{3})+|[1-9]\d*)(\.\d+)?$|^-?0\.\d+$")


def _cells(line: str) -> list[str]:
    body = line.strip()
    if body.startswith("|"):
        body = body[1:]
    if body.endswith("|") and not body.endswith("\\|"):
        body = body[:-1]
    parts = re.split(r"(?<!\\)\|", body)
    return [p.strip().replace("\\|", "|") for p in parts]


class _TableParser(HTMLParser):
    """HTML <table> 하나를 칸(글자, 머리글 여부, 행 수, 열 수)의 행 목록으로 읽는다. 안쪽 표는 글자로 합친다."""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.rows: list[list[tuple[str, bool, int, int]]] = []
        self._cell: list[str] | None = None
        self._attrs: tuple[bool, int, int] = (False, 1, 1)
        self._depth = 0

    def handle_starttag(self, tag, attrs):
        if tag == "table":
            self._depth += 1
        if self._depth != 1:
            return
        if tag == "tr":
            self.rows.append([])
        elif tag in ("td", "th"):
            a = dict(attrs)
            span = lambda k: max(1, int(a[k])) if str(a.get(k) or "").isdigit() else 1
            self._cell, self._attrs = [], (tag == "th", span("rowspan"), span("colspan"))
        elif tag == "br" and self._cell is not None:
            self._cell.append("\n")

    def handle_endtag(self, tag):
        if tag == "table":
            self._depth -= 1
        if self._depth == 1 and tag in ("td", "th") and self._cell is not None:
            if not self.rows:
                self.rows.append([])
            text = re.sub(r"[ \t]+", " ", "".join(self._cell)).strip()
            self.rows[-1].append((text, *self._attrs))
            self._cell = None

    def handle_data(self, data):
        if self._cell is not None:
            self._cell.append(data)


def _html_table(html: str) -> tuple[list[list[str]], list[tuple[int, int, int, int]], int]:
    """(행 목록, 병합 칸 (위, 왼, 아래, 오른) 1부터, 머리글 행 수). 병합 칸 글자는 왼쪽 위 칸에만 둔다."""
    p = _TableParser()
    p.feed(html)
    grid: dict[tuple[int, int], str] = {}
    head_cells: dict[int, list[bool]] = {}
    merges: list[tuple[int, int, int, int]] = []
    for r, row in enumerate(p.rows, 1):
        c = 1
        for text, is_th, rs, cs in row:
            while (r, c) in grid:
                c += 1
            for dr in range(rs):
                for dc in range(cs):
                    grid[(r + dr, c + dc)] = text if (dr, dc) == (0, 0) else ""
            if rs > 1 or cs > 1:
                merges.append((r, c, r + rs - 1, c + cs - 1))
            head_cells.setdefault(r, []).append(is_th)
            c += cs
    if not grid:
        return [], [], 0
    nrows = max(r for r, _ in grid)
    ncols = max(c for _, c in grid)
    rows = [[grid.get((r, c), "") for c in range(1, ncols + 1)] for r in range(1, nrows + 1)]
    head = 0
    while head < nrows and head_cells.get(head + 1) and all(head_cells[head + 1]):
        head += 1
    return rows, merges, head


def parse_tables(text: str) -> list[tuple[str, list[list[str]], list[tuple[int, int, int, int]], int]]:
    """(제목, 행 목록, 병합 칸, 머리글 행 수) 목록. GFM 표는 병합 칸이 없고 첫 행이 머리글이다."""
    lines = text.splitlines()
    tables: list[tuple[str, list[list[str]], list[tuple[int, int, int, int]], int]] = []
    title = ""
    i = 0
    while i < len(lines):
        line = lines[i]
        head = _HEADING.match(line)
        if head:
            title = head.group(1).strip()
            i += 1
            continue
        if re.search(r"<table\b", line, re.I):
            block, j = line, i
            while not re.search(r"</table\s*>", block, re.I) and j + 1 < len(lines):
                j += 1
                block += "\n" + lines[j]
            for found in _HTML_TABLE.findall(block):
                rows, merges, nhead = _html_table(found)
                if rows:
                    tables.append((title, rows, merges, nhead))
                    title = ""
            i = j + 1
            continue
        if "|" in line and i + 1 < len(lines) and _SEP.match(lines[i + 1]):
            rows = [_cells(line)]
            i += 2
            while i < len(lines) and "|" in lines[i] and lines[i].strip():
                rows.append(_cells(lines[i]))
                i += 1
            tables.append((title, rows, [], 1))
            title = ""
            continue
        i += 1
    return tables


def sheet_names(titles: list[str]) -> list[str]:
    out: list[str] = []
    for n, title in enumerate(titles, 1):
        name = re.sub(r"[\[\]:*?/\\]", "", title).strip().strip("'")
        name = re.sub(r"\s+", " ", name)[:31].strip() or f"표{n}"
        base, k = name, 2
        while name in out:
            suffix = f" ({k})"
            name = base[:31 - len(suffix)] + suffix
            k += 1
        out.append(name)
    return out


def cell_value(text: str):
    value = re.sub(r"^\*\*(.*)\*\*$", r"\1", text.strip())
    if _NUMBER.match(value):
        plain = value.replace(",", "")
        return float(plain) if "." in plain else int(plain)
    return value


def main(argv: list[str]) -> int:
    if len(argv) != 3:
        print("사용: python md_to_xlsx.py <입력.md> <출력.xlsx>", file=sys.stderr)
        return 64
    src, dst = Path(argv[1]), Path(argv[2])
    if dst.exists():
        print(f"출력 파일이 이미 있습니다(덮지 않음): {dst}", file=sys.stderr)
        return 2
    tables = parse_tables(src.read_text(encoding="utf-8"))
    if not tables:
        print(f"Markdown 에 표가 없습니다: {src}", file=sys.stderr)
        return 1
    try:
        from openpyxl import Workbook
        from openpyxl.styles import Font
        from openpyxl.utils import get_column_letter
    except ImportError:                               # 도구가 없다(스펙 2026-10-29-001 D4)
        print("이 스킬에 필요한 도구가 이 에이전트에 없습니다: openpyxl", file=sys.stderr)
        return 6

    wb = Workbook()
    wb.remove(wb.active)
    for (title, rows, merges, head), name in zip(tables, sheet_names([t[0] for t in tables])):
        ws = wb.create_sheet(name)
        for r, row in enumerate(rows, 1):
            for c, text in enumerate(row, 1):
                ws.cell(row=r, column=c, value=text if r <= head else cell_value(text))
        for top, left, bottom, right in merges:
            ws.merge_cells(start_row=top, start_column=left, end_row=bottom, end_column=right)
        for r in range(1, head + 1):
            for cell in ws[r]:
                cell.font = Font(bold=True)
        if head:
            ws.freeze_panes = f"A{head + 1}"
        for c in range(1, max(len(row) for row in rows) + 1):
            width = max(len(str(row[c - 1])) if c <= len(row) else 0 for row in rows)
            ws.column_dimensions[get_column_letter(c)].width = min(60, max(8, width * 2 + 2))   # 병합 칸(MergedCell)에는 column_letter 가 없다
    dst.parent.mkdir(parents=True, exist_ok=True)
    wb.save(dst)
    print(f"시트 {len(tables)}개를 썼습니다: {dst} ({', '.join(ws.title for ws in wb.worksheets)})")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))

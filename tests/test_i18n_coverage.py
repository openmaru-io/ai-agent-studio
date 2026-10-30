# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""서버 코드의 한글 문장 검사 — 화면으로 나가는 문장은 tr(한국어, 영어) 로 쓴다.

한글 문자열 상수는 tr() 인자 안에 있거나, 같은 줄이나 바로 윗줄에 `# i18n-ignore: <이유>` 가 있어야 한다.
무시해도 되는 것: 로그·명령줄 출력, 에이전트(LLM)에 보내는 프롬프트, 데이터베이스에 저장하는 문장,
한글 값을 맞대어 보는 비교, 데이터 키. docstring 과 주석은 검사하지 않는다.
"""
import ast
import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent / "aas"
HANGUL = re.compile("[가-힣]")
MARK = "i18n-ignore:"
# attach_notice.py: 에이전트에게 보내고 화면이 다시 읽는 고정 형식(언어와 무관, OMAI-1153 R12·D14)이라 번역하지 않는다
SKIP = {"i18n.py", "attach_notice.py"}
# aas_skill_packages: 서버가 돌리지 않고 Hermes 에이전트가 돌리는 스킬 스크립트(스펙 2026-10-29-001 R8). 명함 목록 칸 이름 등은 사용자 자료라 번역하지 않는다
SKIP_DIRS = {"aas_skill_packages"}


def _is_tr(node: ast.AST) -> bool:
    return isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id == "tr"


def scan(path: Path) -> tuple[list[str], list[str]]:
    """(tr 밖의 한글 상수 위치, 영어 인자에 한글이 든 tr 호출 위치)."""
    src = path.read_text(encoding="utf-8")
    lines = src.splitlines()
    tree = ast.parse(src)
    parent: dict[int, ast.AST] = {}
    for n in ast.walk(tree):
        for c in ast.iter_child_nodes(n):
            parent[id(c)] = n
    doc: set[int] = set()
    for n in ast.walk(tree):
        if isinstance(n, (ast.Module, ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and n.body:
            first = n.body[0]
            if isinstance(first, ast.Expr) and isinstance(first.value, ast.Constant) and isinstance(first.value.value, str):
                doc.add(id(first.value))
    bare: list[str] = []
    bad_en: list[str] = []
    for n in ast.walk(tree):
        if _is_tr(n):
            if len(n.args) != 2 or n.keywords:
                bad_en.append(f"{path.name}:{n.lineno} tr() 는 인자가 (한국어, 영어) 둘이어야 한다")
            else:
                en = n.args[1]
                if any(isinstance(c, ast.Constant) and isinstance(c.value, str) and HANGUL.search(c.value) for c in ast.walk(en)):
                    bad_en.append(f"{path.name}:{n.lineno} tr() 의 영어 인자에 한글이 있다")
        if not (isinstance(n, ast.Constant) and isinstance(n.value, str) and HANGUL.search(n.value)):
            continue
        if id(n) in doc:
            continue
        p = parent.get(id(n))
        inside = False
        while p is not None:
            if _is_tr(p):
                inside = True
                break
            p = parent.get(id(p))
        if inside:
            continue
        lo, hi = max(n.lineno - 1, 1), n.end_lineno or n.lineno
        if any(MARK in lines[i - 1] for i in range(lo, hi + 1)):
            continue
        bare.append(f"{path.name}:{n.lineno} {n.value.strip()[:40]!r}")
    return bare, bad_en


class CoverageTest(unittest.TestCase):
    def test_hangul_outside_tr(self):
        bare: list[str] = []
        bad: list[str] = []
        for f in sorted(ROOT.rglob("*.py")):
            if f.name in SKIP or SKIP_DIRS & set(f.relative_to(ROOT).parts):
                continue
            b, e = scan(f)
            bare += [str(f.relative_to(ROOT.parent)) + " " + x for x in b]
            bad += e
        self.assertEqual(bad, [])
        self.assertEqual(bare, [], f"tr() 밖의 한글 {len(bare)}곳:\n" + "\n".join(bare[:40]))

    def test_scan_detects(self):
        import tempfile
        with tempfile.TemporaryDirectory() as d:
            f = Path(d) / "m.py"
            f.write_text(
                '"""독스트링은 검사하지 않는다."""\n'
                "from x import tr\n"
                "a = tr('가', 'a')\n"
                "b = '나'\n"
                "c = '다'  # i18n-ignore: 로그\n"
                "# i18n-ignore: 프롬프트\n"
                "d = '라'\n"
                "e = tr('마', '바')\n"
                "g = tr(f'값 {a}', f'value {a}')\n",
                encoding="utf-8",
            )
            bare, bad = scan(f)
        self.assertEqual([x.split()[0] for x in bare], ["m.py:4"])
        self.assertEqual([x.split()[0] for x in bad], ["m.py:8"])


if __name__ == "__main__":
    unittest.main()

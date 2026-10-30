# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""AAS 기본 스킬 묶음(aas/assets/aas_skill_packages/) — 스펙 2026-10-29-001(OMAI-1534) R8·C1·C2·D4·F11.

서버 이미지가 이 폴더를 싣고 스킬 허브에 게시한다. 허브로 설치하면 스킬 폴더가 프로파일마다 달라
`/opt/aas-skills/...` 고정 경로를 쓸 수 없다. 필요한 도구가 없는 에이전트(상류 Hermes 이미지)에서는 종료 코드 6 으로 멈춘다.
판(`version`)을 올리지 않고 내용을 고치면 허브에 게시되지 않으므로, 내용 해시 잠금 파일과 견준다.
"""
import os
import re
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from aas.market import skill_bundle

ROOT = skill_bundle.PACKAGES_DIR
# aas-help 는 화면 빌드(ui/src/lib/helpSkill.ts)가 만든다(스펙 2026-10-29-001 §10-9)
NAMES = ("aas-help", "business-card-ocr", "doc-to-markdown", "hwp-to-markdown", "markdown-to-doc", "ocr-to-markdown")
# Hermes 가 함께 싣는 스킬 이름 — 같은 이름이면 프로파일에서 어느 쪽이 쓰일지 모른다(옛 이미지 빌드 확인 줄의 이름 겹침 검사)
HERMES_BUNDLED = {"docx", "pdf", "xlsx", "powerpoint", "pptx"}
NO_OPENPYXL = "import sys\nclass B:\n    def find_spec(self, name, *a):\n        if name.split('.')[0] == 'openpyxl':\n            raise ImportError('no openpyxl')\nsys.meta_path.insert(0, B())\n"


def _run(script: Path, *args, env=None, block_openpyxl=False, cwd=None):
    if block_openpyxl:
        code = NO_OPENPYXL + f"import runpy, sys\nsys.argv = {[str(script), *map(str, args)]!r}\nrunpy.run_path({str(script)!r}, run_name='__main__')\n"
        cmd = [sys.executable, "-B", "-c", code]
    else:
        cmd = [sys.executable, "-B", str(script), *map(str, args)]
    return subprocess.run(cmd, capture_output=True, text=True, env={**os.environ, **(env or {})}, cwd=cwd)


class PackagesTest(unittest.TestCase):
    def test_exactly_the_six_packages_with_matching_name_and_version(self):
        self.assertEqual(tuple(skill_bundle.names()), NAMES)
        for name in NAMES:
            front = skill_bundle.front(name)
            self.assertEqual(front["name"], name)
            self.assertRegex(front["version"], r"^\d+\.\d+\.\d+$")
            self.assertRegex(front["description"], "[가-힣]")
            self.assertRegex(front["description"], " / [A-Z]")
            self.assertLessEqual(len(front["description"]), 400)
            self.assertNotIn(name, HERMES_BUNDLED)

    def test_no_fixed_image_path_and_the_skill_folder_is_explained(self):
        for name in NAMES:
            for path in (ROOT / name).rglob("*"):
                if path.is_file():
                    self.assertNotIn("/opt/aas-skills", path.read_text(encoding="utf-8"), str(path))
            md = (ROOT / name / "SKILL.md").read_text(encoding="utf-8")
            if "<스킬폴더>" in md:                                       # 스킬 폴더를 말하면 그것이 무엇인지도 적는다
                self.assertIn("`skill_dir`", md)
                self.assertIn("종료 코드 6", md)
            for script in re.findall(r"python (\S+\.py)", md):
                self.assertTrue(script.startswith("<스킬폴더>/scripts/"), f"{name}: {script}")
                self.assertTrue((ROOT / name / script.replace("<스킬폴더>/", "")).is_file(), f"{name}: {script}")

    def test_lock_file_matches_contents_and_versions(self):
        lock = skill_bundle.read_lock()
        self.assertEqual(sorted(lock), list(NAMES))
        for name in NAMES:
            self.assertEqual(lock[name]["version"], skill_bundle.front(name)["version"],
                             f"{name}: 판이 잠금 파일과 다르다 — python -m aas.market.skill_bundle lock")
            self.assertEqual(lock[name]["sha256"], skill_bundle.digest(name),
                             f"{name}: 내용을 고쳤으면 SKILL.md 의 version 을 올리고 python -m aas.market.skill_bundle lock")

    def test_lock_refuses_changed_contents_with_the_same_version(self):
        with tempfile.TemporaryDirectory() as d:
            pkg = Path(d) / "demo"
            pkg.mkdir()
            (pkg / "SKILL.md").write_text("---\nname: demo\nversion: 1.0.0\n---\n# 보기\n", encoding="utf-8")
            first = skill_bundle.build_lock(Path(d), {})
            (pkg / "SKILL.md").write_text("---\nname: demo\nversion: 1.0.0\n---\n# 고침\n", encoding="utf-8")
            with self.assertRaises(skill_bundle.BundleError):
                skill_bundle.build_lock(Path(d), first)
            (pkg / "SKILL.md").write_text("---\nname: demo\nversion: 1.0.1\n---\n# 고침\n", encoding="utf-8")
            self.assertEqual(skill_bundle.build_lock(Path(d), first)["demo"]["version"], "1.0.1")

    def test_digest_ignores_pycache(self):
        before = skill_bundle.digest("markdown-to-doc")
        cache = ROOT / "markdown-to-doc" / "scripts" / "__pycache__"
        cache.mkdir(exist_ok=True)
        try:
            (cache / "x.pyc").write_bytes(b"x")
            self.assertEqual(skill_bundle.digest("markdown-to-doc"), before)
        finally:
            (cache / "x.pyc").unlink()
            cache.rmdir()


class MissingToolTest(unittest.TestCase):
    """도구가 없으면 종료 코드 6 과 빠진 도구 이름(D4). 에이전트가 다시 시도하지 않고 사용자에게 알린다."""

    def test_cards_ocr_without_kordoc(self):
        with tempfile.TemporaryDirectory() as d:
            r = _run(ROOT / "business-card-ocr/scripts/cards.py", "ocr", "x.jpg", Path(d) / "o.md",
                     env={"AAS_KORDOC": str(Path(d) / "no-kordoc")})
        self.assertEqual(r.returncode, 6, r.stderr)
        self.assertIn("kordoc", r.stderr)

    def test_cards_export_without_openpyxl(self):
        with tempfile.TemporaryDirectory() as d:
            csv = Path(d) / "cards.csv"
            csv.write_text("id,name\r\nC1,홍길동\r\n", encoding="utf-8")
            r = _run(ROOT / "business-card-ocr/scripts/cards.py", "export", "--out", d,
                     env={"AAS_CARDS_CSV": str(csv)}, block_openpyxl=True)
        self.assertEqual(r.returncode, 6, r.stderr)
        self.assertIn("openpyxl", r.stderr)

    def test_hwp_without_kordoc_and_hwpforge(self):
        with tempfile.TemporaryDirectory() as d:
            src = Path(d) / "a.hwpx"
            src.write_bytes(b"PK")
            code = ("import sys\nclass B:\n    def find_spec(self, name, *a):\n        if name == 'hwpforge':\n            raise ImportError('no')\n"
                    "sys.meta_path.insert(0, B())\nimport runpy\n"
                    f"sys.argv = {[str(ROOT / 'hwp-to-markdown/scripts/hwp_to_md.py'), str(src), str(Path(d) / 'o.md')]!r}\n"
                    f"runpy.run_path(sys.argv[0], run_name='__main__')\n")
            r = subprocess.run([sys.executable, "-B", "-c", code], capture_output=True, text=True, env={**os.environ, "PATH": d})
        self.assertEqual(r.returncode, 6, r.stderr)
        self.assertIn("kordoc", r.stderr)
        self.assertIn("hwpforge", r.stderr)

    def test_md_to_xlsx_without_openpyxl(self):
        with tempfile.TemporaryDirectory() as d:
            src = Path(d) / "t.md"
            src.write_text("| a | b |\n| --- | --- |\n| 1 | 2 |\n", encoding="utf-8")
            r = _run(ROOT / "markdown-to-doc/scripts/md_to_xlsx.py", src, Path(d) / "t.xlsx", block_openpyxl=True)
        self.assertEqual(r.returncode, 6, r.stderr)
        self.assertIn("openpyxl", r.stderr)


if __name__ == "__main__":
    unittest.main()

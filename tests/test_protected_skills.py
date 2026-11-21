# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""보호 스킬 원본·설치 값·잠금·점검 명령(cogentai-aas-docs 스펙 2026-11-21-003 §3-1, 2단계).

공용 시험이라 고객사 이름을 쓰지 않는다 — 가짜 보호 스킬 protected-fixture 를 임시 폴더에 만든다.
고객사 스킬 자체의 확인은 tests/test_edition_reb.py(사내 전용)에 있다.
"""
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from aas.market import protected_skills as ps, skill_bundle  # noqa: E402

NAME = "protected-fixture"
SETTING = "AAS_PROTECTED_FIXTURE_ENABLED"
ATTRS = "aas/assets/protected_skills                export-ignore\naas/assets/protected_skills/**             export-ignore\n"
RULES = "# 시험용\ndeny    customer-x    (?i:protected[-_]fixture)\n"


def skill_md(version="0.1.0", body="원본"):
    return f"---\nname: {NAME}\ndescription: 시험용 보호 스킬\nversion: {version}\n---\n\n{body}\n"


class Tree:
    """임시 원본 폴더 + .gitattributes + 흔적 규칙."""

    def __init__(self):
        self._tmp = tempfile.TemporaryDirectory()
        base = Path(self._tmp.name)
        self.root = base / "protected_skills"
        (self.root / NAME / "references").mkdir(parents=True)
        (self.root / NAME / "SKILL.md").write_text(skill_md(), encoding="utf-8")
        (self.root / NAME / "references" / "faq.md").write_text("참고\n", encoding="utf-8")
        (self.root / "README.md").write_text("설명\n", encoding="utf-8")   # 스킬이 아니다
        self.attrs = base / ".gitattributes"
        self.attrs.write_text(ATTRS, encoding="utf-8")
        self.rules = base / "rules.txt"
        self.rules.write_text(RULES, encoding="utf-8")
        ps.write_lock(self.root)

    def check(self, settings=None):
        return ps.check(self.root, {NAME: SETTING} if settings is None else settings, self.attrs, self.rules)

    def close(self):
        self._tmp.cleanup()


class ProtectedSkillsTest(unittest.TestCase):
    def setUp(self):
        self.t = Tree()
        self.addCleanup(self.t.close)

    def test_names_are_skill_folders_only_and_a_missing_folder_means_none(self):
        self.assertEqual(ps.protected_names(self.t.root), [NAME])
        self.assertEqual(ps.protected_names(self.t.root / "없음"), [])      # 공개본에는 폴더가 없다

    def test_enabled_needs_the_setting_on_and_a_table_entry(self):
        table = {NAME: SETTING}
        with mock.patch.dict(os.environ, {SETTING: ""}):
            with mock.patch.object(ps.skill_bundle.config, "read_env_file", return_value={}):
                self.assertEqual(ps.protected_enabled(self.t.root, table), [])
        with mock.patch.dict(os.environ, {SETTING: "true"}):
            self.assertEqual(ps.protected_enabled(self.t.root, table), [NAME])
            self.assertEqual(ps.protected_enabled(self.t.root, {}), [])     # 표에 없으면 켜지 않는다

    def test_a_clean_tree_passes_the_check(self):
        self.assertEqual(self.t.check(), [])

    def test_changing_content_without_a_new_version_fails_the_lock(self):
        (self.t.root / NAME / "SKILL.md").write_text(skill_md(body="고친 글"), encoding="utf-8")
        with self.assertRaises(skill_bundle.BundleError):
            ps.write_lock(self.t.root)
        self.assertTrue(any("version" in p for p in self.t.check()))

    def test_a_new_version_needs_the_lock_rewritten(self):
        (self.t.root / NAME / "SKILL.md").write_text(skill_md("0.1.1", "고친 글"), encoding="utf-8")
        self.assertTrue(any("versions.lock.json" in p for p in self.t.check()))
        ps.write_lock(self.t.root)
        self.assertEqual(self.t.check(), [])
        self.assertEqual(ps.read_lock(self.t.root)[NAME]["version"], "0.1.1")

    def test_each_missing_piece_is_named(self):
        self.assertTrue(any("설정 이름 표" in p and NAME in p for p in self.t.check(settings={})))
        self.assertTrue(any("ghost" in p for p in self.t.check(settings={NAME: SETTING, "ghost": "AAS_GHOST_ENABLED"})))
        self.t.attrs.write_text("aas/assets/protected_skills/**  export-ignore\n", encoding="utf-8")   # 폴더 이름 줄이 빠짐
        found = self.t.check()
        self.assertEqual(len(found), 1)
        self.assertIn("aas/assets/protected_skills export-ignore", found[0])
        self.t.attrs.write_text(ATTRS, encoding="utf-8")
        self.t.rules.write_text("deny  other  nothing-here\n", encoding="utf-8")
        found = self.t.check()
        self.assertEqual(sorted(p.split(":")[0] for p in found), sorted([NAME, SETTING]))   # 스킬 이름도 설정 이름도 못 잡음

    def test_the_default_bundle_does_not_see_protected_skills(self):
        # 기본 묶음 동작은 그대로(스펙 G5): 보호 폴더는 기본 묶음 폴더 밖이고 names()·enabled_names() 에 섞이지 않는다
        self.assertNotEqual(ps.PROTECTED_DIR, skill_bundle.PACKAGES_DIR)
        self.assertFalse(set(ps.protected_names()) & set(skill_bundle.names()))
        self.assertFalse(set(ps.protected_names()) & set(skill_bundle.enabled_names()))

    def test_the_repository_tree_passes_the_check(self):
        # make check-protected-skills 와 같은 점검 — 보호 스킬을 더하고 한 곳을 빠뜨리면 여기서 실패한다
        self.assertEqual(ps.check(), [])


if __name__ == "__main__":
    unittest.main()

# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""공용 스킬(스펙 2026-10-15-011 D6, 단계 3): config.yaml 의 skills.external_dirs 편집과, 외부 폴더 스킬이 스킬 목록에 「가져옴」으로 나오는지."""
import os
import tempfile
import unittest
from pathlib import Path

TMP = tempfile.TemporaryDirectory()
os.environ.setdefault("AAS_DATA_DIR", str(Path(TMP.name) / "data"))

from aas.assets import skill_graph  # noqa: E402
from aas.ops import shared_skills as ss  # noqa: E402


def put(root: Path, files: dict):
    for rel, text in files.items():
        p = root / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(text, encoding="utf-8")


class ConfigEditTest(unittest.TestCase):
    def test_dir_for_and_label_are_inverse(self):
        self.assertEqual(ss.dir_for("main", False), "/opt/data/profiles/main/skills")
        self.assertEqual(ss.dir_for("default", True), "/opt/data/skills")
        self.assertEqual([ss.label_of(ss.dir_for("main", False)), ss.label_of(ss.dir_for("default", True)), ss.label_of("/opt/data/team/skills")],
                         ["main", "default", "team/skills"])

    def test_adds_a_skills_block_at_the_end_keeping_comments(self):
        out = ss.with_dir("# 내 설정\nmodel: x\n", "/opt/data/profiles/main/skills")
        self.assertTrue(out.startswith("# 내 설정\nmodel: x\n"))
        self.assertEqual(ss.dirs_of(out), ["/opt/data/profiles/main/skills"])

    def test_extends_an_existing_skills_block_and_is_idempotent(self):
        base = "skills:\n  external_dirs: []\n  other: 1\nmodel: x\n"
        out = ss.with_dir(base, "/opt/data/profiles/main/skills")
        self.assertEqual(ss.dirs_of(out), ["/opt/data/profiles/main/skills"])
        self.assertIn("other: 1", out)
        self.assertEqual(ss.with_dir(out, "/opt/data/profiles/main/skills"), out)             # 이미 있으면 그대로
        self.assertEqual(ss.dirs_of(ss.with_dir(out, "/opt/data/profiles/b/skills")), ["/opt/data/profiles/main/skills", "/opt/data/profiles/b/skills"])

    def test_empty_config_and_refusals(self):
        self.assertEqual(ss.dirs_of(ss.with_dir("", "/opt/data/skills")), ["/opt/data/skills"])
        for text, d in [("a: [", "/opt/data/skills"), ("- 1\n", "/opt/data/skills"), ("skills: 3\n", "/opt/data/skills"), ("a: 1\n", "/etc/skills"), ("a: 1\n", "/opt/data/../etc")]:
            with self.assertRaises(ValueError, msg=(text, d)):
                ss.with_dir(text, d)

    def test_dirs_of_ignores_outside_paths(self):
        self.assertEqual(ss.dirs_of("skills:\n  external_dirs: ['/etc', /opt/data/x/../skills, 5]\n"), ["/opt/data/skills"])


class SharedListTest(unittest.TestCase):
    def setUp(self):
        self.home = Path(tempfile.mkdtemp(dir=TMP.name))
        put(self.home, {
            "profiles/main/skills/report/SKILL.md": "---\nname: report\ndescription: 주간 보고\n---\n본문",
            "profiles/main/skills/same/SKILL.md": "---\nname: same\n---\nmain 쪽",
            "profiles/main/skills/.hidden/SKILL.md": "---\nname: hidden\n---\n",
            "profiles/side/skills/own/SKILL.md": "---\nname: own\n---\n",
            "profiles/side/skills/same/SKILL.md": "---\nname: same\n---\nside 쪽",
            "profiles/side/config.yaml": "skills:\n  external_dirs:\n  - /opt/data/profiles/main/skills\n  - /etc\n",
            "profiles/main/config.yaml": "skills:\n  external_dirs:\n  - /opt/data/profiles/main/skills\n",       # 자기 폴더는 건너뛴다
        })

    def rows(self):
        g = skill_graph.build(self.home, jobs_by_profile={})
        return {(s["profile"], s["name"]): s for s in g["skills"]}

    def test_external_skills_appear_under_the_profile_with_their_source(self):
        rows = self.rows()
        self.assertEqual(rows[("side", "report")]["shared_from"], "main")
        self.assertEqual(rows[("side", "report")]["path"], "profiles/main/skills/report")
        self.assertEqual(rows[("side", "report")]["origin"], "local")                           # 출처 판정은 원래 프로파일(main)의 근거를 쓴다
        self.assertEqual(skill_graph.list_row(rows[("side", "report")])["shared_from"], "main")
        self.assertEqual(skill_graph.list_row(rows[("main", "report")])["shared_from"], "")

    def test_the_profiles_own_skill_wins_and_hidden_or_self_dirs_are_skipped(self):
        rows = self.rows()
        self.assertNotIn("shared_from", rows[("side", "same")])                                 # 같은 이름은 프로파일 자기 것
        self.assertEqual(rows[("side", "same")]["path"], "profiles/side/skills/same")
        self.assertNotIn(("side", "hidden"), rows)
        self.assertEqual(len([k for k in rows if k[0] == "main"]), 2)                           # main 은 자기 폴더를 두 번 세지 않는다
        self.assertEqual({k for k in rows if k[0] == "side"}, {("side", "own"), ("side", "same"), ("side", "report")})


if __name__ == "__main__":
    unittest.main()

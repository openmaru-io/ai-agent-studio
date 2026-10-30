# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""「새 스킬」 머리말(frontmatter) 만들기 시험(스펙 2026-10-28-004 §9).

만든 머리말을 Hermes 와 AAS 가 같은 값으로 읽는지 본다: YAML(Hermes parse_frontmatter·AAS skill_setup),
스킬 연결도의 한 줄 읽기(skill_graph._frontmatter 의 related_skills)."""
import unittest

import yaml

from aas.assets import skill_graph, skill_header, skill_setup


class SkillHeaderTest(unittest.TestCase):
    def test_minimal_header_has_version_and_no_empty_keys(self):
        text = skill_header.build("weekly-report", "주간 보고를 만든다")
        self.assertEqual(text, '---\nname: weekly-report\ndescription: "주간 보고를 만든다"\nversion: 1.0.0\n---\n')

    def test_full_header_is_read_the_same_by_yaml_setup_and_graph(self):
        text = skill_header.build("weekly-report", '따옴표 " 와 \\ 를 담은 설명', author="김영주",
                                  env=["NOTION_API_KEY", "SLACK_TOKEN"], related=["ga4", "report-mail"], tags=["보고", "Notion"])
        meta = yaml.safe_load(text.split("---")[1])
        self.assertEqual(meta["description"], '따옴표 " 와 \\ 를 담은 설명')
        self.assertEqual((meta["version"], meta["author"]), ("1.0.0", "김영주"))
        self.assertEqual(meta["required_environment_variables"], ["NOTION_API_KEY", "SLACK_TOKEN"])
        self.assertEqual(meta["metadata"]["hermes"], {"tags": ["보고", "Notion"], "related_skills": ["ga4", "report-mail"]})
        self.assertEqual([e["name"] for e in skill_setup.required_env(skill_setup.frontmatter(text + "\n# x\n"))], ["NOTION_API_KEY", "SLACK_TOKEN"])
        self.assertEqual(skill_graph._frontmatter(text + "\n# x\n")["related_skills"], ["ga4", "report-mail"])

    def test_env_names(self):
        self.assertEqual(skill_header.env_names([" A_KEY ", "A_KEY", "b2"]), ["A_KEY", "b2"])     # 공백·겹침 정리
        for bad in (["1BAD"], ["HAS SPACE"], ["X-Y"], "A_KEY", [f"K{i}" for i in range(11)]):
            with self.assertRaises(ValueError, msg=bad):
                skill_header.env_names(bad)

    def test_tags(self):
        self.assertEqual(skill_header.tag_list([" 보고 ", "보고", "", "Notion"]), ["보고", "Notion"])
        for bad in (["a,b"], ["x" * 31], [f"t{i}" for i in range(9)], "보고"):
            with self.assertRaises(ValueError, msg=bad):
                skill_header.tag_list(bad)

    def test_related_must_be_known_and_not_itself(self):
        known = {"ga4", "report-mail"}
        self.assertEqual(skill_header.related_list(["ga4", "ga4"], known, "weekly-report"), ["ga4"])
        for bad in (["nope"], ["weekly-report"], "ga4", [f"s{i}" for i in range(11)]):
            with self.assertRaises(ValueError, msg=bad):
                skill_header.related_list(bad, known | {f"s{i}" for i in range(11)} | {"weekly-report"}, "weekly-report")


if __name__ == "__main__":
    unittest.main()

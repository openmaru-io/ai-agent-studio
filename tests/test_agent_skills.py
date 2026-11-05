# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""에이전트(프로파일)별 스킬 상태: 켜짐(skills.disabled)·사용 기록(.usage.json)·설정 필요(.env)·동작 형태·준비 상태·왼쪽 칸 요약."""
import json
import tempfile
import unittest
from collections import namedtuple
from pathlib import Path

from aas.assets import agent_skills as ag

Profile = namedtuple("Profile", "name path")


def row(profile, name, **kw):
    base = {"id": f"{profile}:skills/{name}", "name": name, "profile": profile, "required_env": [], "cron": [], "scripts": [],
            "external_scripts": [], "mcp": [], "rest": []}
    return {**base, **kw}


class AgentSkillsTest(unittest.TestCase):
    def setUp(self):
        self.home = Path(tempfile.mkdtemp())
        self.ma = self.home / "profiles" / "ma"
        (self.ma / "skills").mkdir(parents=True)
        (self.ma / "config.yaml").write_text("skills:\n  external_dirs: [/opt/data/skills]\n  disabled:\n    - old-one\n", encoding="utf-8")
        (self.ma / ".env").write_text("REPORT_TOKEN=abc\nEMPTY=\n", encoding="utf-8")
        (self.ma / "skills" / ".usage.json").write_text(json.dumps({
            "weekly": {"use_count": 3, "view_count": 1, "last_used_at": "2026-11-01T09:00:00+00:00", "state": "active"}}), encoding="utf-8")
        self.profiles = [Profile("default", self.home), Profile("ma", self.ma)]

    def test_states(self):
        skills = [
            row("ma", "weekly", scripts=["run.py"], rest=[{"host": "api.example.com"}], required_env=[{"name": "REPORT_TOKEN"}]),
            row("ma", "old-one"),
            row("ma", "needs-key", required_env=[{"name": "EMPTY"}, {"name": "OPTIONAL", "optional": True}]),
            row("ma", "digest", shared_from="default", cron=[{"job": "daily", "last_status": "ok"}]),
            row("ma", "idle"),
            row("default", "weekly"),
        ]
        states, agents = ag.annotate(self.home, self.profiles, skills, {"profiles": {"ma": {"runs": 5, "last": "2026-11-05T10:00", "skills": {"idle": 2}}}})
        w = states["ma:skills/weekly"]
        self.assertEqual((w["enabled"], w["uses"], w["modes"], w["readiness"], w["missing_env"]), (True, 4, ["script", "rest"], "ok", []))
        self.assertEqual(states["ma:skills/old-one"]["readiness"], "off")              # skills.disabled
        self.assertEqual(states["ma:skills/needs-key"]["missing_env"], ["EMPTY"])       # 값이 빈 이름은 없는 것과 같다, optional 은 빼고
        self.assertEqual(states["ma:skills/needs-key"]["readiness"], "setup")
        self.assertEqual(states["ma:skills/digest"]["modes"], ["cron"])
        self.assertEqual(states["ma:skills/digest"]["readiness"], "ok")                 # 예약 작업이 돌았으면 쓰인 것
        self.assertEqual((states["ma:skills/idle"]["seen"], states["ma:skills/idle"]["readiness"]), (2, "ok"))   # 세션 기록에서 열어 봄
        self.assertEqual(states["ma:skills/idle"]["modes"], ["chat"])
        self.assertEqual(states["default:skills/weekly"]["readiness"], "unused")        # 사용 기록은 프로파일마다 따로다
        ma = next(a for a in agents if a["profile"] == "ma")
        self.assertEqual((ma["skills"], ma["enabled"], ma["setup"], ma["shared"], ma["cron"], ma["runs"]), (5, 4, 1, 1, 1, 5))
        self.assertEqual(ma["last_used"], "2026-11-01T09:00:00")

    def test_broken_files_do_not_break(self):
        (self.ma / "config.yaml").write_text("skills: [", encoding="utf-8")
        (self.ma / "skills" / ".usage.json").write_text("{", encoding="utf-8")
        states, _ = ag.annotate(self.home, self.profiles, [row("ma", "weekly")])
        self.assertEqual((states["ma:skills/weekly"]["enabled"], states["ma:skills/weekly"]["uses"]), (True, 0))

    def test_disabled_of(self):
        self.assertEqual(ag.disabled_of("skills:\n  disabled: one\n"), {"one"})
        self.assertEqual(ag.disabled_of(""), set())


if __name__ == "__main__":
    unittest.main()

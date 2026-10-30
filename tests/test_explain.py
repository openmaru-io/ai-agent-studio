# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""작업 설명 시험 — 흐름 그래프에서 뽑은 단계와 점검 항목이 실제와 맞는지."""
import json
import os
import tempfile
import unittest
from pathlib import Path

TMP = tempfile.TemporaryDirectory()
os.environ.setdefault("AAS_DATA_DIR", str(Path(TMP.name) / "data"))

from aas.assets import explain, flow
from aas.ops import mutes  # noqa: E402
from tests.test_flow import make_home  # noqa: E402


class ExplainTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.home = make_home(Path(TMP.name) / "ex")
        cls.ix = flow.build(cls.home)

    def groups(self, out):
        return {g["kind"]: {i["label"]: i for i in g["items"]} for g in out["groups"]}

    def test_skill_explained_with_scripts_hosts_credentials(self):
        out = explain.build(self.ix, self.home, "ma", skill="digest", gateway={"running": True, "channels": []}, deliver="local")
        self.assertFalse(out["unknown"])
        self.assertEqual((out["skill"]["name"], out["skill"]["description"]), ("digest", "요약 발송"))
        self.assertEqual(out["skill"]["outline"][0]["text"], "digest")
        g = self.groups(out)
        self.assertEqual(set(g["script"]), {"send.py", "helper.py", "util.py", "bridge.py"})
        send = g["script"]["send.py"]
        self.assertEqual((send["by"], send["conf"], send["evidence"]["file"]), ("digest", "doc", "skills/ops/digest/SKILL.md"))
        line = (self.home / send["evidence"]["file"]).read_text().splitlines()[send["evidence"]["line"] - 1]
        self.assertIn("send.py", line)                                              # 근거 줄이 실제 줄과 맞는다
        self.assertEqual(g["host"]["hooks.slack.com"]["by"], "send.py")
        self.assertIn("DIGEST_API_KEY", g["cred"]); self.assertIn("pyyaml", g["lib"]); self.assertIn("DOCS", g["mcp"])
        texts = " ".join(c["text"] for c in out["checks"])
        self.assertIn("게이트웨이가 돌고", texts); self.assertIn("저장만", texts)
        self.assertNotIn("abcdefghijklmnop", json.dumps(out, ensure_ascii=False))   # 웹훅 주소의 비밀 조각

    def test_job_root_and_blockers(self):
        out = explain.build(self.ix, self.home, "ma", job_id="j1", gateway={"running": False, "channels": []}, deliver="telegram")
        self.assertEqual((out["root"], out["skill"]["name"]), ("cron:ma/j1", "digest"))
        self.assertTrue(any(c["level"] == "bad" and "게이트웨이가 꺼져" in c["text"] for c in out["checks"]))
        self.assertTrue(any(c["level"] == "bad" and "telegram" in c["text"] for c in out["checks"]))

    def test_no_skill_says_flow_is_unknown(self):
        out = explain.build(self.ix, self.home, "ma", skill="", gateway={"running": True, "channels": []}, deliver="buzz")
        self.assertTrue(out["unknown"]); self.assertEqual(out["groups"], [])
        self.assertTrue(any("미리 알 수 있는 흐름이 없습니다" in c["text"] for c in out["checks"]))
        self.assertTrue(explain.build(self.ix, self.home, "ma", skill="nope")["unknown"])


class MuteTest(unittest.TestCase):
    def test_muted_job_leaves_the_numbers_but_stays_listed(self):
        row = lambda jid, **k: {"profile": "ma", "job_id": jid, "job": "job-" + jid, "new": False, **k}      # noqa: E731
        health = {"incidents": [row("a", now="failing"), row("a", now="failing"), row("b", now="ok"), row("c", now="failing")],
                  "failed_jobs": [row("a"), row("c")], "stalled": [], "silent": [row("a")],
                  "profiles": [{"name": "ma", "open_incidents": 4, "failed_jobs": 2, "stalled_jobs": 0, "silent_jobs": 1}],
                  "totals": {"open_incidents": 4, "live_incidents": 3, "settled_incidents": 1, "new_incidents": 0, "failed_jobs": 2, "stalled": 0, "silent": 1}}
        self.assertEqual(mutes.apply(health)["muted"], [])
        mutes.mute("ma", "a", "job-a", "고칠 계획 없음", "t@example.com")
        try:
            out = mutes.apply(health)
            t = out["totals"]
            self.assertEqual((t["open_incidents"], t["live_incidents"], t["settled_incidents"], t["failed_jobs"], t["silent"], t["muted_jobs"]), (4, 1, 1, 1, 0, 1))
            self.assertEqual((out["profiles"][0]["failed_jobs"], out["profiles"][0]["open_incidents"]), (1, 2))
            self.assertEqual([(m["job"], m["incidents"], m["failing"], m["note"]) for m in out["muted"]], [("job-a", 2, True, "고칠 계획 없음")])
            self.assertEqual(health["totals"]["failed_jobs"], 2)                    # 원본은 그대로
        finally:
            mutes.unmute("ma", "a")
        self.assertEqual(mutes.apply(health)["totals"]["failed_jobs"], 2)


if __name__ == "__main__":
    unittest.main()

# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""게시 전 점검(점검 → 미리보기 → 게시): 걸리는 것을 한 번에 보이고, 아무것도 저장하지 않으며, 빠진 환경변수 선언을 머리말에 더한다."""
import os
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest import mock

TMP = tempfile.TemporaryDirectory()
os.environ["AAS_DATA_DIR"] = str(Path(TMP.name) / "data")

from aas.market import market_publish as mp, marketplace as mk  # noqa: E402

GOOD = "---\nname: weekly-report\ndescription: Builds last week's report every Monday morning\n---\nBody"
CODE = "import os\nTOKEN = os.environ['REPORT_API_TOKEN']\nhome = os.getenv('HOME')\nhermes = os.getenv('HERMES_HOME')\n"


def put(root: Path, files: dict):
    for rel, text in files.items():
        p = root / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(text, encoding="utf-8")


class CheckTest(unittest.TestCase):
    def setUp(self):
        self.home = Path(tempfile.mkdtemp(dir=TMP.name))
        self.root = self.home / "profiles" / "ma"
        put(self.root, {"skills/local/weekly-report/SKILL.md": GOOD, "skills/local/weekly-report/scripts/run.py": CODE})
        for f in mp._dir().glob("*"):
            f.unlink()
        self.cfg = {"url": "http://hub", "token_file": "", "namespaces": ["free", "paid"]}
        self._p = [mock.patch.object(mk, "settings", return_value=self.cfg), mock.patch.object(mk, "install_state", return_value={"enabled": True}),
                   mock.patch.object(mk, "fetch", side_effect=mk.MarketError("없음", 404))]
        for p in self._p:
            p.start()

    def tearDown(self):
        for p in self._p:
            p.stop()

    def check(self, **kw):
        args = dict(pod_id="p1", home=self.home, who="kim@x.io", admin=False, profile="ma", skill_path="skills/local/weekly-report",
                    usage={"uses": 3, "last_used": "2026-11-01T09:00:00", "cron": []})
        args.update(kw)
        return mp.check_publish(**args)

    def level(self, out, cid):
        return next(c["level"] for c in out["checks"] if c["id"] == cid)

    def test_good_skill_passes_and_writes_nothing(self):
        out = self.check()
        self.assertTrue(out["ok"])
        self.assertEqual((out["name"], out["version"]), ("weekly-report", "1.0.0"))   # 이름은 폴더 스킬 이름, 버전은 처음이면 1.0.0
        self.assertEqual([f["path"] for f in out["files"]], ["SKILL.md", "scripts/run.py"])
        self.assertEqual(self.level(out, "works"), "pass")
        self.assertEqual(list(mp._dir().glob("*")), [])                                 # 점검은 요청 기록·묶음을 남기지 않는다

    def test_undeclared_env_is_warned_and_previewed_in_header(self):
        out = self.check()
        self.assertEqual(out["env"]["undeclared"], ["REPORT_API_TOKEN"])                 # HOME·HERMES_* 는 비밀값이 아니다
        self.assertEqual(self.level(out, "env"), "warn")
        self.assertIn("required_environment_variables: [REPORT_API_TOKEN]", out["header"]["after"])
        self.assertIn("version: 1.0.0", out["header"]["after"])
        self.assertNotIn("required_environment_variables", out["header"]["before"])

    def test_problems_are_listed_together(self):
        folder = self.root / "skills/local/weekly-report"
        put(folder, {"SKILL.md": "---\nname: weekly-report\ndescription: short\n---\n", "notes.md": "token sk-abcdefghijklmnopqrstuvwxyz0123456789"})
        out = self.check(usage={"uses": 0, "cron": [{"job": "weekly", "last_status": "error"}]})
        self.assertFalse(out["ok"])
        self.assertEqual(self.level(out, "description"), "fail")
        self.assertEqual(self.level(out, "secret"), "fail")
        self.assertEqual(out["excluded"], ["notes.md"])
        self.assertEqual(self.level(out, "works"), "warn")                              # 예약 작업이 실패했다

    def test_hub_version_suggests_next_and_refuses_older(self):
        def fetch(path):
            if path == "/api/v1/skills/free/weekly-report":
                return {"publishedVersion": {"version": "1.2.0"}}
            raise mk.MarketError("없음", 404)
        with mock.patch.object(mk, "fetch", side_effect=fetch):
            out = self.check(admin=True)
            self.assertEqual((out["version"], out["hub_version"]), ("1.2.1", "1.2.0"))
            self.assertTrue(out["ok"])
            self.assertEqual(self.level(self.check(admin=True, version="1.1.0"), "version"), "fail")
            self.assertEqual(self.level(self.check(), "hub_name"), "fail")              # 남이 올린 같은 이름

    def test_scripts_outside_the_folder_are_warned(self):
        out = self.check(usage={"uses": 3, "cron": [], "external_scripts": ["/opt/data/scripts/digest.py"]})
        self.assertEqual(self.level(out, "outside"), "warn")
        self.assertIn("/opt/data/scripts/digest.py", next(c["message"] for c in out["checks"] if c["id"] == "outside"))
        self.assertTrue(out["ok"])                                                       # 경고일 뿐 막지는 않는다(문서만인 스킬도 있다)

    def test_builtin_is_refused(self):
        put(self.root, {"skills/.bundled_manifest": "weekly-report:\n"})
        self.assertEqual(self.level(self.check(), "origin"), "fail")

    def test_request_declares_env_in_bundle_only(self):
        row = mp.request_publish("p1", self.home, "kim@x.io", False, "ma", "skills/local/weekly-report", "weekly-report", "1.0.0",
                                 declare_env=["REPORT_API_TOKEN", "bad name"])
        with zipfile.ZipFile(mp.bundle_path(row["id"])) as z:
            head = mp.header_of(z.read("SKILL.md").decode())
        self.assertEqual(head["required_environment_variables"], "[REPORT_API_TOKEN]")
        self.assertNotIn("required_environment_variables", (self.root / "skills/local/weekly-report/SKILL.md").read_text(encoding="utf-8"))

    def test_existing_declaration_is_not_touched(self):
        md = "---\nname: weekly-report\ndescription: Builds last week's report every Monday morning\nrequired_environment_variables:\n  - name: OTHER\n---\n"
        self.assertEqual(mp._declare_fields(md, ["REPORT_API_TOKEN"]), {})


if __name__ == "__main__":
    unittest.main()

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

    def test_empty_profile_is_named_as_a_profile_problem(self):
        with self.assertRaises(mp.MarketError) as cm:                                # 화면이 profile "" 를 보내면 경로 오류로 보여 원인을 숨겼다
            self.check(profile="")
        self.assertNotIn("경로", str(cm.exception))

    def test_the_data_folder_path_is_accepted_for_its_own_profile_only(self):
        out = self.check(skill_path="profiles/ma/skills/local/weekly-report")      # skills_list 가 주는 그대로
        self.assertTrue(out["ok"])
        for bad, profile in (("profiles/other/skills/local/weekly-report", "ma"),
                             ("profiles/ma/skills/local/weekly-report", "default"),
                             ("skills/../x", "ma"), ("weekly-report", "ma")):
            with self.assertRaises(mp.MarketError, msg=bad):
                self.check(skill_path=bad, profile=profile)

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


LLM_CODE = "import os\nbase = os.environ['LLM_BASE_URL']\nkey = os.getenv('LLM_API_KEY')\nTOKEN = os.environ['REPORT_API_TOKEN']\n"
HEAD = "---\nname: weekly-report\ndescription: Builds last week's report every Monday morning\n"


class ManagedEnvTest(unittest.TestCase):
    """AAS 가 주는 LLM 접속값(스펙 2026-11-19-002 §4-2 #4): 선언에 덧붙이고 env_aas 줄로 알린다. 덧붙일 수 없으면 fail."""
    setUp, tearDown, check = CheckTest.setUp, CheckTest.tearDown, CheckTest.check

    def put_skill(self, md, code=LLM_CODE):
        put(self.root, {"skills/local/weekly-report/SKILL.md": md, "skills/local/weekly-report/scripts/run.py": code})

    def env_aas(self, out):
        return [c for c in out["checks"] if c["id"] == "env_aas"]

    def publish(self, declare=()):
        row = mp.request_publish("p1", self.home, "kim@x.io", False, "ma", "skills/local/weekly-report", "weekly-report", "1.0.0", declare_env=list(declare))
        with zipfile.ZipFile(mp.bundle_path(row["id"])) as z:
            return z.read("SKILL.md").decode()

    def test_no_list_declares_general_and_managed_in_one_line(self):
        self.put_skill(GOOD)
        out = self.check()
        self.assertEqual((out["env"]["undeclared"], out["env"]["managed_add"]), (["REPORT_API_TOKEN"], ["LLM_BASE_URL", "LLM_API_KEY"]))
        lines = self.env_aas(out)
        self.assertEqual([c["level"] for c in lines], ["pass"])
        self.assertIn("LLM_BASE_URL, LLM_API_KEY", lines[0]["message"])                    # 더한 이름을 붙인다
        self.assertIn("required_environment_variables: [REPORT_API_TOKEN, LLM_BASE_URL, LLM_API_KEY]", out["header"]["after"])
        self.assertTrue(out["ok"])

    def test_request_publish_adds_managed_even_with_empty_declare_env(self):
        self.put_skill(GOOD)
        preview = self.check()["header"]["after"]
        md = self.publish(declare=["REPORT_API_TOKEN"])
        self.assertEqual(md.split("\n---", 1)[0][4:], preview)                            # 미리 보기와 올라간 머리말이 같다
        for f in mp._dir().glob("*"):
            f.unlink()
        md = self.publish(declare=[])                                                       # 화면이 빈 목록을 보내도
        self.assertIn("required_environment_variables: [LLM_BASE_URL, LLM_API_KEY]", md)

    def test_one_line_list_is_appended(self):
        self.put_skill(HEAD + "required_environment_variables: [REPORT_API_TOKEN]\n---\nBody")
        out = self.check()
        self.assertEqual((out["env"]["undeclared"], out["env"]["managed_add"]), ([], ["LLM_BASE_URL", "LLM_API_KEY"]))
        self.assertIn("required_environment_variables: [REPORT_API_TOKEN, LLM_BASE_URL, LLM_API_KEY]", out["header"]["after"])
        self.assertEqual(self.publish().split("\n---", 1)[0][4:], out["header"]["after"])

    def test_multi_line_list_is_appended(self):
        self.put_skill(HEAD + "required_environment_variables:\n  - REPORT_API_TOKEN\n  - name: OTHER\ntags: [x]\n---\nBody")
        out = self.check()
        self.assertTrue(out["ok"], out["checks"])
        self.assertIn("  - name: OTHER\n  - LLM_BASE_URL\n  - LLM_API_KEY\ntags: [x]", out["header"]["after"])
        self.assertEqual(self.publish().split("\n---", 1)[0][4:], out["header"]["after"])

    def test_multi_line_dict_items_fail_on_reread(self):
        self.put_skill(HEAD + "required_environment_variables:\n  - name: REPORT_API_TOKEN\n    prompt: report token\n---\nBody")
        out = self.check()
        line = self.env_aas(out)[0]
        self.assertEqual(line["level"], "fail")
        self.assertIn("- LLM_BASE_URL\n- LLM_API_KEY", line["message"])                   # 복사할 줄
        self.assertFalse(out["ok"])
        with self.assertRaises(mk.MarketError) as cm:
            self.publish()
        self.assertEqual(str(cm.exception), line["message"])                              # 같은 fail 로 게시를 거절한다
        self.assertEqual([f for f in mp._dir().glob("*.zip")], [])

    def test_other_shape_fails(self):
        self.put_skill(HEAD + "required_environment_variables: REPORT_API_TOKEN\n---\nBody")
        self.assertEqual(self.env_aas(self.check())[0]["level"], "fail")

    def test_declared_managed_passes_without_adding(self):
        self.put_skill(HEAD + "required_environment_variables: [LLM_BASE_URL, LLM_API_KEY, REPORT_API_TOKEN]\n---\nBody")
        out = self.check()
        self.assertEqual(out["env"]["managed_add"], [])
        self.assertEqual([(c["level"], c["message"]) for c in self.env_aas(out)], [("pass", "LLM 접속값은 AAS 가 줍니다")])
        self.assertEqual(self.level(out, "env"), "pass")

    def test_hermes_llm_reads_warn_and_are_not_added(self):
        self.put_skill(GOOD, "import os\nk = os.environ['HERMES_LLM_API_KEY']\n")
        out = self.check()
        self.assertEqual(out["env"]["managed_add"], [])
        self.assertEqual([c["level"] for c in self.env_aas(out)], ["warn"])
        self.assertIn("HERMES_LLM_*", self.env_aas(out)[0]["message"])
        self.assertTrue(out["ok"])
        self.assertNotIn("required_environment_variables", out["header"]["after"])

    def level(self, out, cid):
        return next(c["level"] for c in out["checks"] if c["id"] == cid)


if __name__ == "__main__":
    unittest.main()

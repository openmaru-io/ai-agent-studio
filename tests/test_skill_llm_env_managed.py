# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""스킬이 선언한 LLM_BASE_URL·LLM_API_KEY·LLM_MODEL 을 묻지 않고 AAS 가 준다(스펙 2026-11-19-002, OMAI-2123).

이름 목록·「비어 있음」 경우 표는 Hermes 사내 패치 시험(openmaru-cogentai tests/test_hermes_skill_llm_alias.py)과 같다.
한쪽을 바꾸면 다른 쪽도 바꾼다. 옆 레포가 있으면 패치 파일의 `_AAS_LLM_ALIAS` 와 직접 견준다(없으면 건너뛴다 — Jenkins)."""
import ast
import logging
import os
import re
import shutil
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

TMP = tempfile.TemporaryDirectory()
os.environ.setdefault("AAS_DATA_DIR", str(Path(TMP.name) / "data"))

from aas.assets import agent_skills, skill_setup  # noqa: E402

# Hermes 시험과 글자 그대로 같은 목록이어야 한다
ALIAS = {"LLM_BASE_URL": "HERMES_LLM_BASE_URL", "LLM_API_KEY": "HERMES_LLM_API_KEY", "LLM_MODEL": "HERMES_LLM_MODEL"}
SIX = {"LLM_BASE_URL", "LLM_API_KEY", "LLM_MODEL", "HERMES_LLM_BASE_URL", "HERMES_LLM_API_KEY", "HERMES_LLM_MODEL"}

# 「비어 있음」 경우 표(스펙 §4-1). (.env 줄, 기대 출처)
EMPTY_CASES = [
    ("LLM_API_KEY=", "aas"),                             # 빈 값
    ("LLM_API_KEY=   ", "aas"),                          # 공백
    ('LLM_API_KEY="${HERMES_LLM_API_KEY}"', "aas"),      # 따옴표 안 풀리지 않은 참조
    ("LLM_API_KEY=${OPENAI_API_KEY}", "aas"),            # 이름과 상관없이 ${…} 전체는 참조
    ("export LLM_API_KEY=", "aas"),                      # export 붙은 빈 값
    ("LLM_API_KEY=sk-real-value", "profile"),            # 실제 값
]

SA_CRM = """---
name: sa-crm
description: 영업 고객 관리 스킬입니다
required_environment_variables:
  - name: LLM_BASE_URL
  - name: LLM_API_KEY
  - name: LLM_MODEL
  - name: CRM_TOKEN
    prompt: CRM 토큰
  - name: LLM_INTENT_MODEL
    optional: true
---
본문
"""


def tmpdir() -> Path:
    return Path(tempfile.mkdtemp(dir=TMP.name))


class NamesTest(unittest.TestCase):
    def test_six_names_literally(self):
        self.assertEqual(skill_setup.AAS_LLM_ALIAS, ALIAS)
        self.assertEqual(set(skill_setup.AAS_MANAGED), SIX)
        self.assertTrue(all(skill_setup.is_aas_managed(n) for n in SIX))
        for other in ("OPENAI_API_KEY", "OPENAI_BASE_URL", "LLM_INTENT_MODEL", "", None):
            self.assertFalse(skill_setup.is_aas_managed(other), other)

    def test_matches_sibling_hermes_patch(self):
        """옆 레포 패치의 이름 표와 같다. parents 길이를 먼저 본다(Jenkins /src 에서 parents[N] IndexError, 2026-10-27)."""
        parents = Path(__file__).resolve().parents
        if len(parents) < 4:
            self.skipTest("옆 레포를 찾을 위치가 없다(Jenkins 등)")
        found = sorted(parents[3].glob("openmaru-cogentai*/docker/hermes-patches-aas/skill-llm-env-alias.patch"))
        if not found:
            self.skipTest("옆 레포 openmaru-cogentai 의 skill-llm-env-alias.patch 가 없다")
        for patch in found:
            m = re.search(r"_AAS_LLM_ALIAS\s*=\s*(\{[^}]*\})", patch.read_text(encoding="utf-8"))
            self.assertIsNotNone(m, str(patch))
            self.assertEqual(ast.literal_eval(m.group(1)), ALIAS, str(patch))


class RequiredEnvTest(unittest.TestCase):
    def test_managed_mark_on_declared_llm_names_only(self):
        got = {e["name"]: e for e in skill_setup.required_env(skill_setup.frontmatter(SA_CRM))}
        self.assertEqual({n for n, e in got.items() if e.get("managed") == "aas"}, {"LLM_BASE_URL", "LLM_API_KEY", "LLM_MODEL"})
        self.assertNotIn("managed", got["CRM_TOKEN"])
        self.assertNotIn("managed", got["LLM_INTENT_MODEL"])
        self.assertEqual(got["CRM_TOKEN"]["prompt"], "CRM 토큰")                        # 이름·안내는 그대로
        direct = skill_setup.required_env({"required_environment_variables": ["HERMES_LLM_API_KEY"]})
        self.assertEqual(direct[0]["managed"], "aas")


class ManagedSourceTest(unittest.TestCase):
    def test_empty_cases_table(self):
        for line, want in EMPTY_CASES:
            d = tmpdir()
            (d / ".env").write_text(f"OTHER=1\n{line}\n", encoding="utf-8")
            self.assertEqual(skill_setup.managed_source("LLM_API_KEY", d / ".env"), want, line)

    def test_parser_strips_quotes_comments_export(self):
        vals = skill_setup.env_values_of("export A='x' # c\nB=v # note\nC=\"\" # c\n# D=1\nE=a#b\nB=\n")
        self.assertEqual(vals, {"A": "x", "B": "", "C": "", "E": "a#b"})           # 같은 이름은 뒤가 이긴다(Hermes 와 같다)
        self.assertEqual(skill_setup.managed_source_of("B", vals), "aas")
        self.assertEqual(skill_setup.managed_source_of("A", vals), "profile")

    def test_missing_file_is_aas(self):
        self.assertEqual(skill_setup.managed_source("LLM_API_KEY", tmpdir() / "none.env"), "aas")

    def test_unreadable_file_warns_and_is_aas(self):
        d = tmpdir()
        (d / ".env").write_text("LLM_API_KEY=sk-real-value\n")
        with mock.patch.object(Path, "read_text", side_effect=PermissionError("denied")), \
                self.assertLogs("aas.assets.skill_setup", logging.WARNING) as logs:
            self.assertEqual(skill_setup.managed_source("LLM_API_KEY", d / ".env"), "aas")
        self.assertIn("PermissionError", logs.output[0])
        self.assertNotIn("sk-real-value", logs.output[0])


class WithStatusTest(unittest.TestCase):
    """`/api/skill` 이 쓰는 required_env 상태 붙이기."""

    def status(self, env_text):
        d = tmpdir()
        if env_text is not None:
            (d / ".env").write_text(env_text, encoding="utf-8")
        entries = skill_setup.required_env(skill_setup.frontmatter(SA_CRM))
        rows, mixed = skill_setup.with_status(entries, d / ".env")
        return {e["name"]: e for e in rows}, mixed

    def test_managed_always_set_and_source(self):
        rows, mixed = self.status("CRM_TOKEN=abc\n")
        for n in ("LLM_BASE_URL", "LLM_API_KEY", "LLM_MODEL"):
            self.assertEqual((rows[n]["set"], rows[n]["managed_source"]), (True, "aas"), n)
        self.assertTrue(rows["CRM_TOKEN"]["set"])
        self.assertFalse(rows["LLM_INTENT_MODEL"]["set"])
        self.assertNotIn("managed_source", rows["CRM_TOKEN"])
        self.assertFalse(mixed)

    def test_reference_empty_and_no_file_are_aas(self):
        for text in ("LLM_API_KEY=${HERMES_LLM_API_KEY}\n", "LLM_API_KEY=\n", None):
            rows, _mixed = self.status(text)
            self.assertEqual((rows["LLM_API_KEY"]["set"], rows["LLM_API_KEY"]["managed_source"]), (True, "aas"), text)

    def test_profile_value(self):
        rows, mixed = self.status("LLM_BASE_URL=http://x\nLLM_API_KEY=k\nLLM_MODEL=m\n")
        self.assertEqual({rows[n]["managed_source"] for n in ALIAS}, {"profile"})
        self.assertFalse(mixed)                                                           # 모두 같은 출처

    def test_managed_mixed(self):
        self.assertTrue(self.status("LLM_API_KEY=k\n")[1])                               # 키만 프로파일 값
        self.assertTrue(self.status("LLM_MODEL=m\n")[1])                                 # 모델만 프로파일 값
        self.assertFalse(self.status("")[1])
        d = tmpdir()
        (d / ".env").write_text("LLM_API_KEY=k\n")
        one = skill_setup.required_env({"required_environment_variables": ["LLM_API_KEY", "CRM_TOKEN"]})
        self.assertFalse(skill_setup.with_status(one, d / ".env")[1])                    # 하나만 선언했으면 갈릴 것이 없다


class RowStateTest(unittest.TestCase):
    def test_llm_only_missing_is_not_setup(self):
        s = {"name": "sa-crm", "required_env": skill_setup.required_env(skill_setup.frontmatter(SA_CRM))}
        facts = agent_skills.Facts("", "", "CRM_TOKEN=abc\n")
        st = agent_skills.row_state(s, facts, 1)
        self.assertEqual((st["missing_env"], st["readiness"]), ([], "ok"))
        st = agent_skills.row_state(s, agent_skills.Facts("", "", ""), 1)
        self.assertEqual((st["missing_env"], st["readiness"]), (["CRM_TOKEN"], "setup"))   # 일반 이름은 지금처럼


class ConsumersTest(unittest.TestCase):
    def test_summary_skill_source_has_no_required_mark_for_managed(self):
        from aas.market import summary
        hit = {"name": "sa-crm", "_md": SA_CRM, "required_env": skill_setup.required_env(skill_setup.frontmatter(SA_CRM)), "md_sha": "x" * 40}
        src = summary.skill_target(tmpdir(), hit).source()
        self.assertIn("LLM_API_KEY,", src)
        self.assertNotIn("LLM_API_KEY (required)", src)
        self.assertIn("CRM_TOKEN (required)", src)
        tsrc = summary._template_source({"name": "t"}, {"env_requires": [{"name": "LLM_API_KEY"}, {"name": "JIRA_TOKEN"}]})
        self.assertIn("keys the installer enters: LLM_API_KEY, JIRA_TOKEN (required)", tsrc)

    def test_pc_import_env_refs_skip_managed(self):
        import io
        import tarfile
        from aas.ops import pc_import
        md = "---\nname: s\nrequired_env: [LLM_API_KEY, LLM_BASE_URL, CRM_TOKEN]\n---\n"
        buf = io.BytesIO()
        with tarfile.open(fileobj=buf, mode="w:gz") as tar:
            d = tarfile.TarInfo("default")
            d.type = tarfile.DIRTYPE
            tar.addfile(d)
            for name, text in (("SOUL.md", "x"), ("skills/s/s/SKILL.md", md)):
                data = text.encode()
                info = tarfile.TarInfo(f"default/{name}")
                info.size = len(data)
                tar.addfile(info, io.BytesIO(data))
        got = pc_import.inspect_bytes(buf.getvalue())
        self.assertEqual(got["env_refs"], ["CRM_TOKEN"])

    def test_mcp_skill_get_description_explains_managed(self):
        from aas.web import mcp_server
        desc = mcp_server.TOOLS["skill_get"]["spec"]["description"]
        self.assertIn('managed: "aas"', desc)
        self.assertIn("secret_request", desc)
        self.assertIn("LLM_API_KEY", desc)


class TemplateIssuesTest(unittest.TestCase):
    def test_saved_install_record_skips_managed(self):
        from aas.web import server
        rec = {"template": "paid/sales", "env_names": ["LLM_BASE_URL", "LLM_API_KEY", "JIRA_TOKEN"]}
        pod = SimpleNamespace(id="p1", hermes_home=tmpdir())
        prof = SimpleNamespace(name="sales")
        with mock.patch.object(server.marketplace, "requests", return_value=[]), \
                mock.patch.object(server.cron_health.hr, "profiles", return_value=[prof]), \
                mock.patch.object(server.channels, "_env_names", return_value=set()):
            out = server._template_issues(pod, "sales", {"sales": rec})
        self.assertEqual(out[0]["keys"], ["JIRA_TOKEN"])
        with mock.patch.object(server.marketplace, "requests", return_value=[]), \
                mock.patch.object(server.cron_health.hr, "profiles", return_value=[prof]), \
                mock.patch.object(server.channels, "_env_names", return_value={"JIRA_TOKEN"}):
            self.assertEqual(server._template_issues(pod, "sales", {"sales": rec}), [])   # LLM 이름만 남으면 안내가 없다


class InventoryTest(unittest.TestCase):
    """비밀값 목록: 관리 이름의 .env 줄 중 managed_source 가 aas 인 줄만 조용히(aas_default=llm). 사용자 값 줄은 지금처럼 점검."""

    def setUp(self):
        self.home = tmpdir() / "hermes"
        (self.home / "profiles" / "a").mkdir(parents=True)
        (self.home / "config.yaml").write_text("model: x\n")
        (self.home / "profiles" / "a" / "config.yaml").write_text("model: x\n")
        os.environ["AAS_HERMES_COMPOSE_ENV"] = str(self.home / "no-compose-env")
        self.addCleanup(shutil.rmtree, self.home, True)

    def creds(self, env_text):
        from aas.assets import inventory
        from aas.ops import models
        (self.home / "profiles" / "a" / ".env").write_text(env_text)
        with mock.patch.object(models, "server_llm_key", return_value=("", "")):
            return {i["name"]: i for i in inventory._credentials(self.home)["items"] if i["profile"] == "a"}

    def test_empty_and_reference_are_quiet(self):
        for text in ("LLM_API_KEY=\n", "LLM_API_KEY=${HERMES_LLM_API_KEY}\n"):
            row = self.creds(text)["LLM_API_KEY"]
            self.assertEqual(row["aas_default"], "llm", text)
            self.assertNotIn("비어 있음", row["flags"], text)
            self.assertFalse(any("쓰는 곳" in f for f in row["flags"]), text)

    def test_user_value_is_checked(self):
        row = self.creds("LLM_API_KEY=sk-user-value-123456\n")["LLM_API_KEY"]
        self.assertIsNone(row["aas_default"])
        self.assertEqual(row["value_kind"], "secret")
        self.assertIn("쓰는 곳을 찾지 못함", row["flags"])                              # 지금처럼 점검된다

    def test_flow_node_not_red_for_empty_llm_key(self):
        from aas.assets import flow
        from aas.ops import models
        skill = self.home / "profiles" / "a" / "skills" / "s"
        skill.mkdir(parents=True)
        (skill / "SKILL.md").write_text("---\nname: s\ndescription: x\nrequired_environment_variables: [LLM_API_KEY, CRM_TOKEN]\n---\n")
        (skill / "run.py").write_text("import os\nk = os.environ['LLM_API_KEY']\nt = os.environ['CRM_TOKEN']\n")
        (self.home / "profiles" / "a" / ".env").write_text("LLM_API_KEY=\nCRM_TOKEN=\n")
        with mock.patch.object(models, "server_llm_key", return_value=("", "")):
            ix = flow.build(self.home)
        bad = sorted(n.get("label") for nid, n in ix["nodes"].items() if str(nid).startswith("cred:") and n.get("status") == "bad")
        self.assertEqual(bad, ["CRM_TOKEN"])                                              # 일반 이름의 빈 값은 지금처럼 빨갛다

if __name__ == "__main__":
    unittest.main()

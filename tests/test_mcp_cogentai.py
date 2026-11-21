# Copyright 2026 The OPENMARU Authors.
"""CogentAI 카탈로그 항목(SQL 진단, 차트) 시험 (OMAI-1863).

URL·키만 받는 읽기 전용 builtin 항목이다. Outline 과 같은 순서로 설치하고(키를 먼저 .env 에, include 를 넣은 채 한 번에),
쓰기 스위치와 끌 도구 묶음이 없다."""
import os
import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from aas.assets.files import FileError  # noqa: E402
from aas.ops import mcp_servers  # noqa: E402
from tests.test_mcp_outline import FakeHermes  # noqa: E402

URL = "http://mcp-orchestrator-service.openmaru-cogentai.svc.cluster.local:18080/mcp"
B = mcp_servers.COGENTAI


def _install(api, name, env):
    return mcp_servers.install(api, "ma", {"server": name, "env": env}, owner=False, secure=True, profs=["ma"], pod="p", by="t@example.com")


class CogentAICatalogTest(unittest.TestCase):
    def test_entries_have_an_address_and_a_secret_key_and_no_write_switch(self):
        with mock.patch.dict(os.environ, {B.url_setting: URL}):
            entries = {e["name"]: e for e in mcp_servers.catalog(FakeHermes(), "ma")["entries"]}
        for b in mcp_servers.simple_builtins().values():
            e = entries[b.name]
            self.assertEqual((e["builtin"], e["writable"], e["installed"]), (True, False, False))
            url_field, key_field = e["required_env"]
            self.assertEqual((url_field["name"], url_field["secret"], key_field["name"], key_field["secret"]), (b.url_field, False, b.key, True))
        self.assertEqual(entries["cogentai-database"]["required_env"][0]["value"], URL)
        self.assertTrue(entries["docmost"]["writable"] and entries["outline"]["writable"])

    def test_install_registers_only_its_tools_with_the_key_first_and_the_skill(self):
        api = FakeHermes()
        out = _install(api, "cogentai-database", {B.url_field: URL, B.key: "Bearer aas-key"})
        self.assertEqual((out["ok"], out["write"], out["skill_package"]), (True, False, "free/cogentai-database"))
        self.assertEqual(api.env, {B.key: "aas-key"})
        entry = api.servers["cogentai-database"]
        self.assertEqual(entry["headers"], {"Authorization": "Bearer ${MCP_COGENTAI_DATABASE_API_KEY}"})
        self.assertEqual(entry["tools"], {"include": ["diagnose_sql"]})              # 일반판은 SQL 진단만
        self.assertEqual(api.toolsets, {"browser": True, "connections": True})       # 도구 묶음은 끄지 않는다
        env_put = next(i for i, c in enumerate(api.calls) if c[:2] == ("PUT", "/api/env"))
        first = next(i for i, c in enumerate(api.calls) if c[:2] == ("PUT", "/api/mcp/servers"))
        self.assertLess(env_put, first)

    def test_instructions_block_keeps_the_users_lines(self):
        # 카탈로그 항목의 작업 지침 블록은 사람이 쓴 줄을 건드리지 않고 한 번만 넣고 뺀다(OMAI-1863). 블록이 있는 항목은 고객사 판뿐이라 가짜 본문으로 본다
        name, body = "demo-db", "## 데모\n- 먼저 `demo_tool` 을 부른다.\n"
        once = mcp_servers.with_instructions("사람 줄\n", name, body)
        self.assertEqual(mcp_servers.with_instructions(once, name, body), once)           # 다시 넣어도 하나
        self.assertEqual(mcp_servers.without_instructions(once, name), "사람 줄\n")
        self.assertEqual(mcp_servers.without_instructions(mcp_servers.with_instructions("", name, body), name), "")
        self.assertEqual(mcp_servers.without_instructions("블록 없음\n", name), "블록 없음\n")
        self.assertEqual(B.instructions, "")                                                  # 일반판은 넣지 않는다

    def test_without_an_edition_only_the_general_entry_is_shown(self):
        # 고객사 판 모듈(aas/ops/mcp_edition.py)은 사내 전용이다. 없으면(공개본) 일반판만 보이고 이름 검사 목록에도 없다(스펙 2026-11-21-001)
        general = {k: v for k, v in mcp_servers.SIMPLE_BUILTINS.items() if v is not mcp_servers.EDITION}
        with mock.patch.object(mcp_servers, "EDITION", None), mock.patch.dict(mcp_servers.SIMPLE_BUILTINS, general, clear=True):
            self.assertFalse(mcp_servers.edition_enabled())
            self.assertIn("cogentai-database", mcp_servers.simple_builtins())
            self.assertEqual(set(mcp_servers.SIMPLE_BUILTINS), {"cogentai-database", "cogentai-chart", "law-go-kr"})

    def test_chart_installs_the_chart_tools_and_skill(self):
        api = FakeHermes()
        out = _install(api, "cogentai-chart", {mcp_servers.COGENTAI_CHART.url_field: "http://mcp-chart-service:9091/mcp",
                                               mcp_servers.COGENTAI_CHART.key: "chart-key"})
        self.assertEqual(out["skill_package"], "free/cogentai-chart")
        self.assertIn("generate_bar_chart", api.servers["cogentai-chart"]["tools"]["include"])

    def test_a_rejected_key_removes_the_server_and_the_key_line(self):
        api = FakeHermes(test={"ok": False, "error": "HTTP 401 Unauthorized"})
        with self.assertRaises(FileError) as cm:
            _install(api, "cogentai-database", {B.url_field: URL, B.key: "wrong"})
        self.assertIn("401", str(cm.exception))
        self.assertNotIn("cogentai-database", api.servers)
        self.assertEqual(api.env, {})

    def test_only_its_variables_are_accepted(self):
        with self.assertRaises(FileError):
            _install(FakeHermes(), "cogentai-database", {B.url_field: URL, B.key: "k", "MCP_OUTLINE_API_KEY": "x"})
        with self.assertRaises(FileError):
            _install(FakeHermes(), "cogentai-database", {B.url_field: "ftp://x", B.key: "k"})


if __name__ == "__main__":
    unittest.main()

# Copyright 2026 The OPENMARU Authors.
"""CogentAI 카탈로그 항목(SQL 진단, 부동산원 청약 통계·SQL 진단, 차트) 시험 (OMAI-1863).

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
R = mcp_servers.COGENTAI_REB
REB_ON = {"AAS_COGENTAI_DATABASE_REB_ENABLED": "true"}


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

    def test_the_reb_option_shows_the_reb_entry_instead_of_the_general_one(self):
        # 부동산원 청약 통계는 그 업무 지식이 든 설치에서만 쓴다(사용자 결정, 2026-11-08).
        names = lambda: [e["name"] for e in mcp_servers.catalog(FakeHermes(), "ma")["entries"]]
        with mock.patch.dict(os.environ, {"AAS_COGENTAI_DATABASE_REB_ENABLED": ""}):
            self.assertIn("cogentai-database", names())
            self.assertNotIn("cogentai-database-reb", names())
            with self.assertRaises(FileError) as cm:
                _install(FakeHermes(), "cogentai-database-reb", {R.url_field: URL, R.key: "k"})
            self.assertEqual(cm.exception.reason, "catalog_hidden")
        with mock.patch.dict(os.environ, {**REB_ON, R.url_setting: URL}):
            entries = {e["name"]: e for e in mcp_servers.catalog(FakeHermes(), "ma")["entries"]}
            self.assertNotIn("cogentai-database", entries)
            self.assertEqual(entries["cogentai-database-reb"]["required_env"][0]["value"], URL)
            api = FakeHermes()
            out = _install(api, "cogentai-database-reb", {R.url_field: URL, R.key: "aas-key"})
        self.assertEqual(out["skill_package"], "free/cogentai-database-reb")
        self.assertEqual(api.servers["cogentai-database-reb"]["headers"], {"Authorization": "Bearer ${MCP_COGENTAI_DATABASE_REB_API_KEY}"})
        self.assertEqual(api.servers["cogentai-database-reb"]["tools"],
                         {"include": ["ask_subscription_statistics", "diagnose_sql", "export_subscription_result"]})

    def test_instructions_block_keeps_the_users_lines(self):
        body = R.instructions
        self.assertIn("웹 검색으로 답하기 전에", body)
        # 수치가 아닌 질문(분위기·동향)도, 앞 통계 답 뒤의 새 질문도 도구를 먼저 부르고 자기 지식으로 답하지 않는다(OKE 2026-11-08)
        self.assertIn("수치를 묻지 않아도", body)
        self.assertIn("새 질문마다 다시 부른다", body)
        self.assertIn("자기 지식으로 대신 답하지 않는다", body)
        # 「올해」·「작년」을 모델이 연도로 고쳐 넘기면 모델이 짐작한 올해(2025)로 기간이 틀린다(OKE 2026-11-08)
        self.assertIn("기간 낱말(올해·작년", body)
        self.assertIn("덧붙이는 말에는 연도·기간을 쓰지 않는다", body)
        # 「우리 동네는 괜찮아?」에 도구 없이 지역을 되묻고 「시세를 확인해 드릴 수 있습니다」라고 답했다(OKE 2026-11-12 O08, OMAI-1850)
        self.assertIn("동네·지역·집 상황", body)
        self.assertIn("되묻기 전에", body)
        self.assertIn("확인해 줄 수 있다고 말하지 않는다", body)
        once = mcp_servers.with_instructions("사람 줄\n", R.name, body)
        self.assertEqual(mcp_servers.with_instructions(once, R.name, body), once)           # 다시 넣어도 하나
        self.assertEqual(mcp_servers.without_instructions(once, R.name), "사람 줄\n")
        self.assertEqual(mcp_servers.without_instructions(mcp_servers.with_instructions("", R.name, body), R.name), "")
        self.assertEqual(mcp_servers.without_instructions("블록 없음\n", R.name), "블록 없음\n")
        self.assertEqual(B.instructions, "")                                                  # 일반판은 넣지 않는다

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

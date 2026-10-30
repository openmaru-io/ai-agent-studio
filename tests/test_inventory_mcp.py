# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""자산 > 도구의 「MCP 서버」 목록(inventory.tools 의 mcp) 시험(OMAI-1249, 스펙 2026-10-16-002).

모든 프로파일의 config.yaml mcp_servers 를 읽기만 한다. 비밀 값은 응답에 없고(이름과 mcp_target 결과만), 깨진 설정 한 개가 스크립트 목록·흐름 그림을 깨뜨리지 않는다.
"""
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

TMP = tempfile.TemporaryDirectory()
os.environ.setdefault("AAS_DATA_DIR", str(Path(TMP.name) / "data"))

from aas.assets import flow, inventory  # noqa: E402
from aas.common import i18n  # noqa: E402

GOOD = """model:
  default: m1
mcp_servers:
  github:
    command: npx
    args: ["-y", "@modelcontextprotocol/server-github"]
    env:
      GITHUB_TOKEN: ghp_abcdefghijklmnopqrstuvwxyz0123456789
      LOG_LEVEL: debug
  docs:
    url: https://docs.example.com/s/Abcdef0123456789TOKENxyz/mcp?key=SECRETKEY
    headers:
      Authorization: Bearer abcdefghijklmnopqrstuvwxyz
    auth: header
  paused:
    command: python3
    args: ["--api-key", "abc123secret"]
    enabled: false
"""


def make_home(name: str, configs: dict) -> Path:
    """configs: {None: 루트 config.yaml, "ma": profiles/ma/config.yaml, ...}. 스크립트 하나를 둬 스크립트 목록이 살아 있는지 본다."""
    home = Path(TMP.name) / name
    (home / "scripts").mkdir(parents=True, exist_ok=True)
    (home / "scripts" / "send.py").write_text('"""발송."""\nimport os\n', encoding="utf-8")
    for prof, text in configs.items():
        d = home if prof is None else home / "profiles" / prof
        d.mkdir(parents=True, exist_ok=True)
        (d / "config.yaml").write_text(text, encoding="utf-8")
    return home


def rows(home: Path) -> dict:
    return {r["id"]: r for r in inventory.tools(home)["mcp"]}


class RowsTest(unittest.TestCase):
    def setUp(self):
        i18n.set_lang("ko")

    def test_http_stdio_and_disabled_rows(self):
        home = make_home("rows", {None: GOOD})
        r = rows(home)
        gh, docs, off = r["default:github"], r["default:docs"], r["default:paused"]
        self.assertEqual((gh["transport"], gh["enabled"], gh["target"]), ("stdio", True, "npx -y server-github"))
        self.assertEqual((docs["transport"], docs["enabled"], docs["auth"], docs["target"]), ("http", True, "header", "https://docs.example.com/…"))
        self.assertEqual((off["transport"], off["enabled"], off["target"]), ("stdio", False, "python3 --api-key ***"))
        self.assertEqual(gh["env_names"], ["GITHUB_TOKEN", "LOG_LEVEL"])
        self.assertEqual((gh["env_count"], gh["header_count"], docs["header_names"]), (2, 0, ["Authorization"]))
        self.assertTrue(gh["modified"])
        t = inventory.tools(home)
        self.assertEqual((t["totals"]["mcp"], t["totals"]["mcp_off"]), (3, 1))
        self.assertEqual(t["mcp_skipped"], [])

    def test_scope_id_and_sorting(self):
        home = make_home("scope", {None: "mcp_servers:\n  a:\n    command: x\n", "zz": "mcp_servers:\n  b:\n    command: x\n", "ma": "mcp_servers:\n  c:\n    command: x\n"})
        got = inventory.tools(home)["mcp"]
        self.assertEqual([r["id"] for r in got], ["default:a", "ma:c", "zz:b"])
        by = {r["id"]: r for r in got}
        self.assertEqual((by["default:a"]["scope"], by["default:a"]["profile"]), ("전역", ""))
        self.assertEqual((by["ma:c"]["scope"], by["ma:c"]["profile"]), ("프로파일", "ma"))

    def test_scope_values_stay_korean_in_every_language(self):
        home = make_home("scopelang", {None: "mcp_servers:\n  a:\n    command: x\n", "ma": "mcp_servers:\n  c:\n    command: x\n"})
        for lang in ("en", "ko"):
            i18n.set_lang(lang)
            try:
                self.assertEqual([r["scope"] for r in inventory.tools(home)["mcp"]], ["전역", "프로파일"])
            finally:
                i18n.set_lang("ko")

    def test_ids_do_not_collide(self):
        # 서버 이름에 ':' 가 든 경우와 profiles/default 폴더가 루트와 겹치는 경우: 같은 id 가 둘이면 뒤의 것을 건너뛴다
        home = make_home("collide", {None: "mcp_servers:\n  x:\n    command: root\n  'p:q':\n    command: c\n", "default": "mcp_servers:\n  x:\n    command: nested\n"})
        got = inventory.tools(home)["mcp"]
        ids = [r["id"] for r in got]
        self.assertEqual(len(ids), len(set(ids)))
        self.assertIn("default:p:q", ids)
        self.assertEqual(len([i for i in ids if i == "default:x"]), 1)

    def test_no_servers_and_missing_config(self):
        home = make_home("none", {None: "model:\n  default: m\n"})
        (home / "profiles" / "ma").mkdir(parents=True)             # config.yaml 없는 프로파일
        t = inventory.tools(home)
        self.assertEqual((t["mcp"], t["mcp_skipped"], t["totals"]["mcp"], t["totals"]["mcp_off"]), ([], [], 0, 0))

    def test_scripts_list_and_totals_are_unchanged(self):
        t = inventory.tools(make_home("scripts", {None: GOOD}))
        self.assertEqual([i["name"] for i in t["items"]], ["send.py"])
        self.assertEqual(t["totals"]["items"], 1)
        self.assertIn("languages", t["totals"])


class SecretsTest(unittest.TestCase):
    def test_no_secret_value_in_the_response(self):
        blob = json.dumps(inventory.tools(make_home("secrets", {None: GOOD}))["mcp"], ensure_ascii=False)
        for secret in ("ghp_abcdefghijklmnop", "Abcdef0123456789TOKENxyz", "SECRETKEY", "abcdefghijklmnopqrstuvwxyz", "abc123secret"):
            self.assertNotIn(secret, blob)
        for name in ("GITHUB_TOKEN", "Authorization"):
            self.assertIn(name, blob)                              # 이름은 있다

    def test_names_are_capped_at_20_and_counts_are_exact(self):
        env = "\n".join(f"      K{i:02d}: v{i}" for i in range(22))
        home = make_home("cap", {None: f"mcp_servers:\n  big:\n    command: x\n    env:\n{env}\n"})
        r = rows(home)["default:big"]
        self.assertEqual((len(r["env_names"]), r["env_count"]), (20, 22))


BROKEN = {
    "yaml_error": "mcp_servers: [unclosed\n  - : :",
    "root_list": "- a\n- b\n",
    "servers_list": "mcp_servers:\n  - name: a\n",
    "servers_str": "mcp_servers: hello\n",
}
ITEM_BROKEN = {
    "item_str": "mcp_servers:\n  bad: just-a-string\n  ok:\n    command: x\n",
    "env_list": "mcp_servers:\n  bad:\n    command: x\n    env: [A, B]\n  ok:\n    command: x\n",
    "headers_str": "mcp_servers:\n  bad:\n    url: https://h.io/x\n    headers: nope\n  ok:\n    command: x\n",
    "args_str": "mcp_servers:\n  bad:\n    command: x\n    args: not-a-list\n  ok:\n    command: x\n",
    "url_number": "mcp_servers:\n  bad:\n    url: 12345\n  ok:\n    command: x\n",
}


class BrokenInputTest(unittest.TestCase):
    """깨진 설정 하나가 도구 목록·흐름 그림을 500 으로 만들지 않는다(inventory.tools 는 flow.build 도 부른다: flow.py:114)."""

    def test_broken_profile_is_skipped_and_reported_without_breaking_the_rest(self):
        for key, text in BROKEN.items():
            with self.subTest(case=key):
                home = make_home(f"broken_{key}", {None: GOOD, "bad": text})
                t = inventory.tools(home)
                self.assertEqual(sorted(r["id"] for r in t["mcp"]), ["default:docs", "default:github", "default:paused"])
                self.assertEqual([i["name"] for i in t["items"]], ["send.py"])
                self.assertEqual([s["profile"] for s in t["mcp_skipped"]], ["bad"])
                self.assertIn(t["mcp_skipped"][0]["reason"], {"unreadable", "not_a_map"})
                self.assertNotIn("unclosed", json.dumps(t["mcp_skipped"]))            # 예외 문구·파일 내용은 싣지 않는다
                flow.build(home)                                                      # 흐름 그림도 예외 없이 만들어진다

    def test_broken_item_is_skipped_but_siblings_stay(self):
        for key, text in ITEM_BROKEN.items():
            with self.subTest(case=key):
                home = make_home(f"item_{key}", {"ma": text})
                t = inventory.tools(home)
                ids = [r["id"] for r in t["mcp"]]
                self.assertIn("ma:ok", ids)
                self.assertNotIn("ma:bad", ids)
                self.assertEqual([s["profile"] for s in t["mcp_skipped"]], ["ma"])
                self.assertEqual(t["mcp_skipped"][0]["reason"], "partial")
                flow.build(home)

    def test_numeric_server_names_sort_without_error(self):
        home = make_home("numkey", {"ma": "mcp_servers:\n  7:\n    command: x\n  ok:\n    command: x\n"})
        t = inventory.tools(home)
        self.assertEqual([r["id"] for r in t["mcp"]], ["ma:7", "ma:ok"])
        self.assertEqual(t["mcp_skipped"], [])

    def test_whole_failure_yields_empty_list_and_a_star_entry(self):
        home = make_home("whole", {None: GOOD})
        with mock.patch.object(inventory, "_mcp", side_effect=RuntimeError("boom SECRET")):
            t = inventory.tools(home)
        self.assertEqual((t["mcp"], t["totals"]["mcp"]), ([], 0))
        self.assertEqual(t["mcp_skipped"], [{"profile": "*", "reason": "error"}])
        self.assertEqual([i["name"] for i in t["items"]], ["send.py"])


if __name__ == "__main__":
    unittest.main()

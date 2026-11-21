# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""law.go.kr 법령 조회 카탈로그 항목(law-go-kr) 시험 — 스펙 2026-11-20-008 §5-3(OMAI-2138).

커넥터 law-connector(cogentai-aas-connectors)를 원격 MCP 로 붙이는 URL·키 항목이다. 설치 값 AAS_LAW_GO_KR_ENABLED 를
켠 설치에서만 보이고, 보이지 않으면 설치도 받지 않는다. 짝 스킬 law-go-kr 도 같은 설치 값으로만 배달한다."""
import os
import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from aas.assets.files import FileError  # noqa: E402
from aas.market import skill_bundle  # noqa: E402
from aas.ops import mcp_servers  # noqa: E402
from tests.test_mcp_outline import FakeHermes  # noqa: E402

URL = "http://law-connector.cogentai-aas.svc.cluster.local:8080/mcp"
L = mcp_servers.LAW_GO_KR
ON = {"AAS_LAW_GO_KR_ENABLED": "true"}
OFF = {"AAS_LAW_GO_KR_ENABLED": ""}


def _install(api, env):
    return mcp_servers.install(api, "ma", {"server": "law-go-kr", "env": env}, owner=False, secure=True, profs=["ma"], pod="p", by="t@example.com")


def _names():
    return [e["name"] for e in mcp_servers.catalog(FakeHermes(), "ma")["entries"]]


class LawGoKrCatalogTest(unittest.TestCase):
    def test_hidden_and_refused_unless_the_setting_is_on(self):
        with mock.patch.dict(os.environ, OFF):
            self.assertNotIn("law-go-kr", _names())
            self.assertNotIn("law-go-kr", mcp_servers.simple_builtins())
            with self.assertRaises(FileError) as cm:
                _install(FakeHermes(), {L.url_field: URL, L.key: "k"})
            self.assertEqual(cm.exception.reason, "catalog_hidden")
        # 이름 검사용 전체 목록에는 늘 있다 — 다른 경로가 이 이름을 일반 Hermes 카탈로그 항목으로 다루지 않게
        self.assertIs(mcp_servers.SIMPLE_BUILTINS["law-go-kr"], L)

    def test_shown_with_the_address_prefilled_when_on(self):
        with mock.patch.dict(os.environ, {**ON, L.url_setting: URL}):
            entries = {e["name"]: e for e in mcp_servers.catalog(FakeHermes(), "ma")["entries"]}
        e = entries["law-go-kr"]
        self.assertEqual((e["builtin"], e["writable"], e["installed"]), (True, False, False))
        url_field, key_field = e["required_env"]
        self.assertEqual((url_field["name"], url_field["value"], key_field["name"], key_field["secret"]),
                         ("LAW_GO_KR_MCP_URL", URL, "MCP_LAW_GO_KR_API_KEY", True))
        # 다른 builtin 항목은 그대로 보인다(이 설정은 법령 항목만 더한다)
        self.assertIn("cogentai-chart", entries)

    def test_install_registers_only_the_three_read_tools_and_the_skill(self):
        api = FakeHermes()
        with mock.patch.dict(os.environ, ON):
            out = _install(api, {L.url_field: URL, L.key: "Bearer law-key"})
        self.assertEqual((out["ok"], out["write"], out["skill_package"]), (True, False, "free/law-go-kr"))
        self.assertEqual(api.env, {"MCP_LAW_GO_KR_API_KEY": "law-key"})
        entry = api.servers["law-go-kr"]
        self.assertEqual(entry["headers"], {"Authorization": "Bearer ${MCP_LAW_GO_KR_API_KEY}"})
        self.assertEqual(entry["tools"], {"include": ["search_law", "get_article", "verify_citation"]})

    def test_a_rejected_key_removes_the_server_and_the_key_line(self):
        # 커넥터는 키가 없거나 틀리면 401 을 돌려준다(스펙 §5-1). AAS 는 401·403 만 키 거절로 본다
        api = FakeHermes(test={"ok": False, "error": "HTTP 401 Unauthorized"})
        with mock.patch.dict(os.environ, ON), self.assertRaises(FileError) as cm:
            _install(api, {L.url_field: URL, L.key: "wrong"})
        self.assertIn("401", str(cm.exception))
        self.assertNotIn("law-go-kr", api.servers)
        self.assertNotIn("MCP_LAW_GO_KR_API_KEY", api.env)

    def test_labels_and_prompts_in_both_languages(self):
        for lang in ("ko", "en"):
            with mock.patch("aas.ops.mcp_servers.tr", side_effect=lambda ko, en, _l=lang: ko if _l == "ko" else en):
                texts = (L.label(), L.description(), L.url_prompt(), L.key_prompt())
            self.assertTrue(all(texts))
            if lang == "ko":
                self.assertIn("law_connector_key", L.key_prompt())


class LawGoKrSkillDeliveryTest(unittest.TestCase):
    def test_skill_is_delivered_only_when_the_setting_is_on(self):
        # 기본 스킬은 모든 프로파일에 배달된다. 커넥터가 없는 설치에서 스킬만 보이지 않게 같은 설치 값으로 가린다(스펙 §5-3)
        with mock.patch.dict(os.environ, OFF):
            off = skill_bundle.enabled_names()
        with mock.patch.dict(os.environ, ON):
            on = skill_bundle.enabled_names()
        self.assertNotIn("law-go-kr", off)
        self.assertIn("law-go-kr", on)
        self.assertEqual(sorted(set(on) ^ set(off)), ["law-go-kr"])

    def test_skill_names_the_three_tools_and_reads_them_from_the_first_60_characters(self):
        front = skill_bundle.front("law-go-kr")
        self.assertEqual(front["name"], "law-go-kr")
        # Hermes 스킬 목록은 설명 앞 57자만 싣는다 — 「법령」 질문에 이 스킬이 골라지게 앞부분에 둔다
        self.assertIn("법령", front["description"][:57])
        body = (skill_bundle.PACKAGES_DIR / "law-go-kr" / "SKILL.md").read_text(encoding="utf-8")
        for tool in ("mcp__law_go_kr__search_law", "mcp__law_go_kr__get_article", "mcp__law_go_kr__verify_citation"):
            self.assertIn(tool, body)


if __name__ == "__main__":
    unittest.main()

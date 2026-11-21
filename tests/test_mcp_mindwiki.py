# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""MindWiki MCP 카탈로그 항목을 시험한다(스펙 2026-11-14-001 1단계, OMAI-2018).

설치 값 AAS_MINDWIKI_URL 이 있을 때만 outline 다음에 보인다. 주소는 설치 값 + /mcp, 사용자는 개인 토큰(wiki_pat_)만 넣는다.
설치하면 tools.include 를 읽기 도구(쓰기를 고르면 쓰기 도구까지, trash_page 는 늘 빼고)로 채우고 browser·connections 를 끈다.
"""
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

TMP = tempfile.TemporaryDirectory()
os.environ.setdefault("AAS_DATA_DIR", str(Path(TMP.name) / "data"))

from aas.assets.files import FileError  # noqa: E402
from aas.ops import mcp_servers  # noqa: E402
from tests.test_mcp_outline import FakeHermes  # noqa: E402

BASE = "https://wiki.corp.example"
KEY = mcp_servers.MINDWIKI_KEY
TOKEN = "wiki_pat_abc123"


def _with_url(url=BASE):
    return mock.patch.dict(os.environ, {"AAS_MINDWIKI_URL": url})


def _install(api, env, **kw):
    return mcp_servers.install(api, "ma", {"server": "cogentai-mindwiki", "env": env, **kw.pop("body", {})}, owner=False, secure=kw.pop("secure", True),
                               profs=["ma"], pod="p", by="t@example.com")


class MindwikiCatalogTest(unittest.TestCase):
    def setUp(self):
        probe = mock.patch.object(mcp_servers, "_docmost_probe", return_value=200)   # 시험은 MindWiki 에 요청하지 않는다
        self.probed = probe.start()
        self.addCleanup(probe.stop)

    def test_hidden_without_the_install_value_and_shown_after_outline_with_it(self):
        with _with_url(""):
            names = [e["name"] for e in mcp_servers.catalog(FakeHermes(), "ma")["entries"]]
        self.assertNotIn("cogentai-mindwiki", names)
        with _with_url("ftp://wiki"):                                                 # http(s) 가 아니면 없는 것으로 본다
            self.assertNotIn("cogentai-mindwiki", [e["name"] for e in mcp_servers.catalog(FakeHermes(), "ma")["entries"]])
        with _with_url(BASE + "/"):
            entries = mcp_servers.catalog(FakeHermes(), "ma")["entries"]
        self.assertEqual([e["name"] for e in entries][:3], ["docmost", "outline", "cogentai-mindwiki"])
        entry = entries[2]
        self.assertEqual((entry["installed"], entry["builtin"], entry["write"], entry["url"]), (False, True, False, BASE + "/mcp"))
        self.assertEqual([(f["name"], f["secret"]) for f in entry["required_env"]], [(KEY, True)])   # 주소 칸은 없다

    def test_install_uses_the_install_value_address_and_registers_read_tools_only(self):
        api = FakeHermes()
        with _with_url():
            out = _install(api, {KEY: "Bearer " + TOKEN})
        self.assertEqual((out["ok"], out["write"], out["browser_off"], out["connections_off"], out["skill_package"]),
                         (True, False, True, True, "free/cogentai-mindwiki"))
        self.assertEqual(api.env, {KEY: TOKEN})
        entry = api.servers["cogentai-mindwiki"]
        self.assertEqual((entry["url"], entry["headers"]), (BASE + "/mcp", {"Authorization": "Bearer ${MCP_COGENTAI_MINDWIKI_API_KEY}"}))
        self.assertEqual(entry["tools"], {"include": list(mcp_servers.MINDWIKI_READ_TOOLS)})
        self.probed.assert_called_once_with(BASE + "/mcp", TOKEN)
        self.assertEqual((len(mcp_servers.MINDWIKI_READ_TOOLS), len(mcp_servers.MINDWIKI_WRITE_TOOLS)), (18, 15))   # 쓰기 15: suggest_edit(2단계)·첨부 올리기 둘(3단계 W2), 스펙 2026-11-15-002

    def test_write_adds_write_tools_but_never_trash_page(self):
        api = FakeHermes()
        with _with_url():
            _install(api, {KEY: TOKEN}, body={"write": True})
        include = api.servers["cogentai-mindwiki"]["tools"]["include"]
        self.assertEqual(include, list(mcp_servers.MINDWIKI_READ_TOOLS + mcp_servers.MINDWIKI_WRITE_TOOLS))
        self.assertNotIn("trash_page", include)
        with _with_url():
            self.assertTrue(next(e for e in mcp_servers.catalog(api, "ma")["entries"] if e["name"] == "cogentai-mindwiki")["write"])
            out = mcp_servers.set_mindwiki_write(api, "ma", False, pod="p", by="t")
        self.assertEqual((out["write"], api.servers["cogentai-mindwiki"]["tools"]["include"]), (False, list(mcp_servers.MINDWIKI_READ_TOOLS)))

    def test_old_tool_lists_are_refreshed_and_still_count_as_write(self):
        """예전 판이 적은 include(새 쓰기 도구 없음)도 「쓰기」로 보이고, 자동 점검이 이 판의 목록으로 채운다(스펙 2026-11-15-002, OKE 2026-11-15)."""
        api = FakeHermes()
        with _with_url():
            _install(api, {KEY: TOKEN}, body={"write": True})
        old = [t for t in api.servers["cogentai-mindwiki"]["tools"]["include"] if t not in ("suggest_edit", "start_attachment_upload", "complete_attachment_upload")]
        api.servers["cogentai-mindwiki"]["tools"]["include"] = old
        with _with_url():
            self.assertTrue(next(e for e in mcp_servers.catalog(api, "ma")["entries"] if e["name"] == "cogentai-mindwiki")["write"])
            self.assertTrue(mcp_servers.refresh_mindwiki_tools(api, "ma", pod="p", by="t"))
        self.assertEqual(api.servers["cogentai-mindwiki"]["tools"]["include"], list(mcp_servers.MINDWIKI_READ_TOOLS + mcp_servers.MINDWIKI_WRITE_TOOLS))
        self.assertFalse(mcp_servers.refresh_mindwiki_tools(api, "ma", pod="p", by="t"))       # 이미 맞으면 쓰지 않는다
        api.servers["cogentai-mindwiki"]["tools"]["include"] = list(mcp_servers.MINDWIKI_READ_TOOLS[:-1])   # 읽기만인 항목은 읽기 범위로
        self.assertTrue(mcp_servers.refresh_mindwiki_tools(api, "ma", pod="p", by="t"))
        self.assertEqual(api.servers["cogentai-mindwiki"]["tools"]["include"], list(mcp_servers.MINDWIKI_READ_TOOLS))

    def test_foreign_turns_block_mindwiki_write_and_trash_tools(self):
        blocked = mcp_servers.foreign_write_blocks()
        for tool in mcp_servers.MINDWIKI_WRITE_TOOLS + ("trash_page",):
            self.assertIn(f"mcp__*__{tool}", blocked)
        self.assertNotIn("mcp__*__search_pages", blocked)
        self.assertEqual(len(blocked), len(set(blocked)))                             # create_page 는 Docmost 와 겹쳐도 한 번

    def test_only_personal_tokens_and_only_the_key_field_are_accepted(self):
        with _with_url():
            for env, reason in (({KEY: "wiki_oat_1"}, "mindwiki_key_format"), ({KEY: "  "}, "env_missing"),
                                ({KEY: TOKEN, "MINDWIKI_MCP_URL": "https://evil.example/mcp"}, "env_undeclared")):
                with self.assertRaises(FileError) as cm:
                    _install(FakeHermes(), env)
                self.assertEqual(cm.exception.reason, reason)
            with self.assertRaises(FileError) as cm:
                _install(FakeHermes(), {KEY: TOKEN}, secure=False)                   # 암호화된 요청에서만 받는다
            self.assertNotEqual(cm.exception.reason, "mindwiki_key_format")
        with _with_url(""):                                                          # 보이지 않는 항목은 설치도 받지 않는다
            with self.assertRaises(FileError) as cm:
                _install(FakeHermes(), {KEY: TOKEN})
            self.assertEqual(cm.exception.reason, "catalog_hidden")

    def test_a_rejected_token_is_explained_before_anything_is_written(self):
        api = FakeHermes()
        self.probed.return_value = 401
        with _with_url(), self.assertRaises(FileError) as cm:
            _install(api, {KEY: TOKEN})
        self.assertEqual(cm.exception.reason, "mindwiki_key_rejected")
        self.assertEqual((api.servers, api.env), ({}, {}))

    def test_a_rejected_token_found_by_the_connection_test_removes_the_server(self):
        api = FakeHermes(test={"ok": False, "error": "HTTP 401 Unauthorized"})
        with _with_url(), self.assertRaises(FileError) as cm:
            _install(api, {KEY: TOKEN})
        self.assertEqual(cm.exception.reason, "mindwiki_key_rejected")
        self.assertEqual((api.servers, api.env), ({}, {}))
        api = FakeHermes(test={"ok": False, "error": "timed out"})                  # 그 밖의 결과는 설치를 그대로 둔다
        with _with_url():
            self.assertTrue(_install(api, {KEY: TOKEN})["ok"])
        self.assertIn("cogentai-mindwiki", api.servers)

    def test_installed_entry_cannot_be_installed_again_and_removal_tells_toolsets_stay_off(self):
        api = FakeHermes()
        with _with_url():
            _install(api, {KEY: TOKEN})
            with self.assertRaises(FileError) as cm:
                _install(api, {KEY: TOKEN})
            self.assertEqual(cm.exception.code, 409)
        out = mcp_servers.remove(api, "ma", "cogentai-mindwiki", "mcp_servers:\n  cogentai-mindwiki:\n    url: x\n")
        self.assertTrue(out["toolsets_off_notice"])
        self.assertNotIn("cogentai-mindwiki", api.servers)


class ProbeTrustedCaTest(unittest.TestCase):
    """사설 CA 로 서명한 MindWiki 에 서버가 닿지 못해 사전 확인이 0(연결 실패)이었다(2026-11-14 OKE).
    차트가 사용자 Hermes 와 같은 사내 CA 를 AAS_EXTRA_CA_FILE 로 주면 기본 묶음과 함께 믿는다."""

    def test_probe_context_adds_the_extra_ca_file_when_set(self):
        loaded = []
        real = mcp_servers.ssl.create_default_context

        def ctx(*a, **kw):
            c = real(*a, **kw)
            orig = c.load_verify_locations
            c.load_verify_locations = lambda cafile=None, **k: (loaded.append(cafile), orig(cafile=cafile, **k))[1]
            return c
        with tempfile.TemporaryDirectory() as d, mock.patch.object(mcp_servers.ssl, "create_default_context", ctx):
            ca = Path(d) / "ca.crt"
            ca.write_text(Path(mcp_servers.ssl.get_default_verify_paths().cafile or "/etc/ssl/cert.pem").read_text())
            with mock.patch.dict(os.environ, {"AAS_EXTRA_CA_FILE": str(ca)}):
                mcp_servers._probe_context()
            with mock.patch.dict(os.environ, {"AAS_EXTRA_CA_FILE": str(Path(d) / "missing.crt")}):
                mcp_servers._probe_context()                                         # 없는 파일은 넘어간다(기본 묶음만)
            with mock.patch.dict(os.environ, {"AAS_EXTRA_CA_FILE": ""}):
                mcp_servers._probe_context()
        self.assertEqual(loaded, [str(ca)])


if __name__ == "__main__":
    unittest.main()

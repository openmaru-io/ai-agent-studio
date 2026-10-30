# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""Docmost MCP 카탈로그 항목과 토큰 앞 `Bearer ` 떼기를 시험한다(스펙 2026-10-23-002 R3·R6·12-6, OMAI-1440).

카탈로그 항목은 늘 보인다. 사용자가 MCP 주소와 키를 넣고, 설치 값 AAS_DOCMOST_MCP_URL 은 주소 칸을 미리 채울 뿐이다.
설치하면 원격 주소 + 토큰으로 추가하고 tools.include 를 읽기 도구(쓰기를 고르면 쓰기 도구까지)로 채우며,
그 프로파일의 browser 도구 묶음을 끈다(12-5 우회 시도). Hermes 카탈로그 설치(/api/mcp/catalog/install)로는 보내지 않는다.
"""
import copy
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

TMP = tempfile.TemporaryDirectory()
os.environ.setdefault("AAS_DATA_DIR", str(Path(TMP.name) / "data"))

from aas.assets.files import FileError  # noqa: E402
from aas.hermes.hermes_api import HermesError  # noqa: E402
from aas.ops import mcp_servers  # noqa: E402

URL = "https://wiki.corp.example/mcp"
NOT_MCP = ("MCP server 'docmost' at https://other.example/mcp returned Content-Type 'text/html', not an MCP response "
           "(expected one of: application/json, text/event-stream).")


class FakeHermes:
    """서버 목록·추가·지도 쓰기·카탈로그·도구 묶음만 흉내 낸다. 추가는 Hermes 처럼 토큰을 .env 로 보내고 설정에는 참조만 남긴다."""

    def __init__(self, servers=None, add_error=None, toolset_error=None):
        self.servers = copy.deepcopy(servers or {})
        self.env: dict[str, str] = {}
        self.toolsets: dict[str, bool] = {"browser": True}
        self.calls = []
        self.add_error = add_error
        self.toolset_error = toolset_error

    def call(self, method, path, body=None, query=None, timeout=30):
        self.calls.append((method, path, copy.deepcopy(body)))
        if method == "GET" and path == "/api/mcp/servers":
            return {"servers": [{"name": k, "transport": "http", "enabled": True} for k in self.servers]}
        if method == "POST" and path == "/api/mcp/servers":
            if self.add_error:
                raise self.add_error
            entry = {"url": body["url"]}
            if body.get("bearer_token"):
                var = f"MCP_{mcp_servers.server_key(body['name'])}_API_KEY"
                self.env[var] = body["bearer_token"]
                entry["headers"] = {"Authorization": "Bearer ${" + var + "}"}
            self.servers[body["name"]] = entry
            return {"ok": True}
        if method == "GET" and path == "/api/config":
            return {"mcp_servers": copy.deepcopy(self.servers)}
        if method == "PUT" and path == "/api/mcp/servers":
            self.servers = copy.deepcopy(body["servers"])
            return {"ok": True}
        if method == "PUT" and path.startswith("/api/tools/toolsets/"):
            if self.toolset_error:
                raise self.toolset_error
            self.toolsets[path.rsplit("/", 1)[1]] = bool(body["enabled"])
            return {"ok": True}
        if method == "GET" and path == "/api/mcp/catalog":
            return {"entries": [{"name": "ctx", "auth_type": "none", "needs_install": False, "transport": "http", "description": "문서"}]}
        if method == "GET" and path == "/api/env":
            return {}
        raise AssertionError(f"예상하지 못한 호출: {method} {path}")


def _with_url(url=URL):
    return mock.patch.dict(os.environ, {"AAS_DOCMOST_MCP_URL": url})


def _install(api, env, **kw):
    return mcp_servers.install(api, "ma", {"server": "docmost", "env": env, **kw.pop("body", {})}, owner=False, secure=kw.pop("secure", True),
                               profs=["ma"], pod="p", by="t@example.com")


class StripBearerTest(unittest.TestCase):
    def test_leading_bearer_is_removed_in_any_case_and_spacing(self):
        for raw, want in (("Bearer abc", "abc"), ("bearer   abc", "abc"), ("BEARER\tabc ", "abc"), ("abc", "abc"), ("  abc  ", "abc"), ("Bearer ", ""), ("Bearerabc", "Bearerabc")):
            self.assertEqual(mcp_servers.strip_bearer(raw), want, raw)

    def test_add_sends_the_token_without_bearer_and_refuses_bearer_only(self):
        api = FakeHermes()
        mcp_servers.add(api, "ma", {"server": "docs", "kind": "url", "url": "https://example.com/mcp", "auth": "header", "bearer_token": "Bearer tok-1"},
                        owner=False, secure=True, profs=["ma"])
        post = next(c for c in api.calls if c[:2] == ("POST", "/api/mcp/servers"))
        self.assertEqual(post[2]["bearer_token"], "tok-1")
        with self.assertRaises(FileError) as cm:
            mcp_servers.add(FakeHermes(), "ma", {"server": "docs", "kind": "url", "url": "https://example.com/mcp", "auth": "header", "bearer_token": "Bearer  "},
                            owner=False, secure=True, profs=["ma"])
        self.assertEqual(cm.exception.reason, "token_format")


class DocmostCatalogTest(unittest.TestCase):
    def setUp(self):
        self.probe = getattr(mcp_servers, "_docmost_probe", None)                    # 대역을 끼우기 전의 원래 함수
        probe = mock.patch.object(mcp_servers, "_docmost_probe", return_value=200)    # 시험은 Docmost 에 요청하지 않는다
        self.probed = probe.start()
        self.addCleanup(probe.stop)

    def test_entry_is_always_listed_first_with_an_address_field_and_a_secret_key_field(self):
        with _with_url(""):
            entry = mcp_servers.catalog(FakeHermes(), "ma")["entries"][0]
        self.assertEqual((entry["name"], entry["installed"], entry["builtin"]), ("docmost", False, True))
        url_field, key_field = entry["required_env"]
        self.assertEqual((url_field["name"], url_field["secret"], url_field["value"]), (mcp_servers.DOCMOST_URL_FIELD, False, ""))
        self.assertEqual((key_field["name"], key_field.get("secret", True)), ("MCP_DOCMOST_API_KEY", True))
        self.assertEqual(entry["write"], False)
        with _with_url():
            self.assertEqual(mcp_servers.catalog(FakeHermes(), "ma")["entries"][0]["required_env"][0]["value"], URL)   # 설치 값은 주소 칸을 미리 채운다

    def test_installed_entry_reports_whether_write_tools_are_on(self):
        api = FakeHermes({"docmost": {"url": URL, "tools": {"include": list(mcp_servers.DOCMOST_READ_TOOLS + mcp_servers.DOCMOST_WRITE_TOOLS)}}})
        entry = mcp_servers.catalog(api, "ma")["entries"][0]
        self.assertEqual((entry["installed"], entry["write"]), (True, True))

    def test_install_adds_a_header_server_with_read_tools_only_and_turns_the_browser_off(self):
        api = FakeHermes()
        out = _install(api, {mcp_servers.DOCMOST_URL_FIELD: URL, "MCP_DOCMOST_API_KEY": "Bearer key-1"})
        self.assertEqual((out["ok"], out["write"], out["browser_off"], out["connections_off"]), (True, False, True, True))
        self.assertEqual(api.env, {"MCP_DOCMOST_API_KEY": "key-1"})
        entry = api.servers["docmost"]
        self.assertEqual((entry["url"], entry["headers"]), (URL, {"Authorization": "Bearer ${MCP_DOCMOST_API_KEY}"}))
        self.assertEqual(entry["tools"], {"include": list(mcp_servers.DOCMOST_READ_TOOLS)})
        self.assertEqual(api.toolsets["browser"], False)
        self.assertEqual(api.toolsets["connections"], False)                              # manage_connections 가 AAS 화면에 안내 없이 멈춘다(12-8)
        self.assertEqual(out["skill_package"], mcp_servers.DOCMOST_SKILL)                 # 함께 설치할 스킬(서버 라우트가 요청한다, 12-8)
        self.assertFalse(any(c[1] == "/api/mcp/catalog/install" for c in api.calls))
        self.assertEqual((len(mcp_servers.DOCMOST_READ_TOOLS), len(mcp_servers.DOCMOST_WRITE_TOOLS)), (10, 10))

    def test_install_with_write_registers_all_twenty_tools(self):
        api = FakeHermes()
        out = _install(api, {mcp_servers.DOCMOST_URL_FIELD: URL, "MCP_DOCMOST_API_KEY": "k"}, body={"write": True})
        self.assertTrue(out["write"])
        self.assertEqual(api.servers["docmost"]["tools"]["include"], list(mcp_servers.DOCMOST_READ_TOOLS + mcp_servers.DOCMOST_WRITE_TOOLS))

    def test_browser_toolset_failure_does_not_fail_the_install_but_is_reported(self):
        api = FakeHermes(toolset_error=HermesError("down", 503))
        out = _install(api, {mcp_servers.DOCMOST_URL_FIELD: URL, "MCP_DOCMOST_API_KEY": "k"})
        self.assertEqual((out["ok"], out["browser_off"], out["connections_off"]), (True, False, False))
        self.assertIn("docmost", api.servers)

    def test_write_tools_can_be_switched_later(self):
        api = FakeHermes({"docmost": {"url": URL, "tools": {"include": list(mcp_servers.DOCMOST_READ_TOOLS)}}})
        self.assertTrue(mcp_servers.set_docmost_write(api, "ma", True, pod="p", by="x")["write"])
        self.assertEqual(api.servers["docmost"]["tools"]["include"], list(mcp_servers.DOCMOST_READ_TOOLS + mcp_servers.DOCMOST_WRITE_TOOLS))
        self.assertFalse(mcp_servers.set_docmost_write(api, "ma", False, pod="p", by="x")["write"])
        self.assertEqual(api.servers["docmost"]["tools"]["include"], list(mcp_servers.DOCMOST_READ_TOOLS))
        with self.assertRaises(FileError) as cm:
            mcp_servers.set_docmost_write(FakeHermes(), "ma", True, pod="p", by="x")
        self.assertEqual(cm.exception.code, 404)

    def test_install_needs_the_address_the_key_and_an_encrypted_request(self):
        for env, reason in (({"MCP_DOCMOST_API_KEY": "k"}, "env_missing"), ({mcp_servers.DOCMOST_URL_FIELD: URL}, "env_missing"),
                            ({mcp_servers.DOCMOST_URL_FIELD: "ftp://x/mcp", "MCP_DOCMOST_API_KEY": "k"}, "url_format")):
            with self.assertRaises(FileError) as cm:
                _install(FakeHermes(), env)
            self.assertEqual(cm.exception.reason, reason, env)
        with self.assertRaises(FileError) as cm:
            _install(FakeHermes(), {mcp_servers.DOCMOST_URL_FIELD: URL, "MCP_DOCMOST_API_KEY": "k"}, secure=False)
        self.assertEqual(cm.exception.reason, "insecure")

    def test_only_the_install_value_address_is_probed_from_the_server(self):
        """사용자가 적은 주소로 AAS 서버가 요청을 보내지 않는다(서버를 거쳐 내부망을 찌르지 못하게). 설치 값 주소만 미리 묻는다."""
        with _with_url():
            _install(FakeHermes(), {mcp_servers.DOCMOST_URL_FIELD: URL, "MCP_DOCMOST_API_KEY": "k"})
            self.assertEqual(self.probed.call_count, 1)
            _install(FakeHermes(), {mcp_servers.DOCMOST_URL_FIELD: "https://other.example/mcp", "MCP_DOCMOST_API_KEY": "k"})
            self.assertEqual(self.probed.call_count, 1)

    def test_rejected_key_is_reported_with_the_real_status_before_anything_is_written(self):
        """Docmost 는 /mcp 의 GET 에 웹 화면(HTML)을 준다. Hermes 는 키를 붙인 POST 가 401 이면 GET 의 text/html 로
        「웹 페이지 주소」 오류를 낸다(OKE 2026-10-23). 설치 값 주소면 AAS 가 먼저 물어 401·403 이면 키 문제로 알린다."""
        api = FakeHermes()
        for status in (401, 403):
            with _with_url(), mock.patch.object(mcp_servers, "_docmost_probe", return_value=status):
                with self.assertRaises(FileError) as cm:
                    _install(api, {mcp_servers.DOCMOST_URL_FIELD: URL, "MCP_DOCMOST_API_KEY": "bad"})
            self.assertEqual((cm.exception.reason, cm.exception.code), ("docmost_key_rejected", 400))
            self.assertIn(str(status), str(cm.exception))
        self.assertEqual(api.calls, [c for c in api.calls if c[0] == "GET"])            # 아무것도 쓰지 않았다
        for status in (200, 0, 500):                                                     # 통과·연결 실패·서버 오류는 Hermes 에 맡긴다
            with _with_url(), mock.patch.object(mcp_servers, "_docmost_probe", return_value=status):
                self.assertTrue(_install(FakeHermes(), {mcp_servers.DOCMOST_URL_FIELD: URL, "MCP_DOCMOST_API_KEY": "k"})["ok"], status)

    def test_hermes_web_page_error_is_explained_as_a_wrong_address_or_a_rejected_key(self):
        api = FakeHermes(add_error=HermesError(NOT_MCP, 400))
        with self.assertRaises(FileError) as cm:
            _install(api, {mcp_servers.DOCMOST_URL_FIELD: "https://other.example/mcp", "MCP_DOCMOST_API_KEY": "k"})
        self.assertEqual(cm.exception.reason, "docmost_not_mcp")
        self.assertIn("키", str(cm.exception))
        self.assertNotIn("docmost", api.servers)

    def test_probe_posts_initialize_with_the_bearer_header(self):
        seen = {}

        class Resp:
            status = 200
            def __enter__(self): return self
            def __exit__(self, *a): return False

        def fake_open(req, timeout, context):
            seen.update(url=req.full_url, method=req.get_method(), auth=req.get_header("Authorization"), accept=req.get_header("Accept"))
            return Resp()
        with mock.patch("urllib.request.urlopen", side_effect=fake_open):
            self.assertEqual(self.probe(URL, "key-1"), 200)
        self.assertEqual((seen["url"], seen["method"], seen["auth"]), (URL, "POST", "Bearer key-1"))
        self.assertIn("text/event-stream", seen["accept"])
        import urllib.error
        with mock.patch("urllib.request.urlopen", side_effect=urllib.error.HTTPError(URL, 401, "Unauthorized", {}, None)):
            self.assertEqual(self.probe(URL, "k"), 401)
        with mock.patch("urllib.request.urlopen", side_effect=OSError("no route")):
            self.assertEqual(self.probe(URL, "k"), 0)

    def test_installed_entry_cannot_be_installed_again(self):
        with self.assertRaises(FileError) as cm:
            _install(FakeHermes({"docmost": {"url": URL}}), {mcp_servers.DOCMOST_URL_FIELD: URL, "MCP_DOCMOST_API_KEY": "k"})
        self.assertEqual(cm.exception.code, 409)


if __name__ == "__main__":
    unittest.main()

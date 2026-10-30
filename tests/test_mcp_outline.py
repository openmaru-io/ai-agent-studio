# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""Outline MCP 카탈로그 항목을 시험한다(스펙 2026-10-23-004, OMAI-1446).

Docmost 항목(test_mcp_docmost) 옆에 늘 보인다. 설치하면 원격 주소 + 토큰으로 추가하고 tools.include 를 읽기 도구 7개
(쓰기를 고르면 쓰기 도구 9개까지, 삭제 도구 3개는 늘 빼고)로 채우며, 그 프로파일의 browser·connections 도구 묶음을 끈다.
사용 규칙 스킬 free/outline 은 서버 라우트가 install_companion 으로 요청한다(test_market_defaults).
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
KEY = mcp_servers.OUTLINE_KEY
FIELD = mcp_servers.OUTLINE_URL_FIELD
DELETE_TOOLS = ("delete_document", "delete_collection", "delete_comment")


class FakeHermes:
    """서버 목록·추가·지도 쓰기·카탈로그·도구 묶음만 흉내 낸다(test_mcp_docmost 의 FakeHermes 와 같은 규칙)."""

    def __init__(self, servers=None, toolset_error=None, test=None):
        self.servers = copy.deepcopy(servers or {})
        self.test = test if test is not None else {"ok": True, "tools": list(range(19))}   # 연결 시험 결과(설치 직후 키 확인, 15절)
        self.env: dict[str, str] = {}
        self.toolsets: dict[str, bool] = {"browser": True, "connections": True}
        self.calls = []
        self.toolset_error = toolset_error

    def call(self, method, path, body=None, query=None, timeout=30):
        self.calls.append((method, path, copy.deepcopy(body)))
        if method == "GET" and path == "/api/mcp/servers":
            return {"servers": [{"name": k, "transport": "http", "enabled": True} for k in self.servers]}
        if method == "POST" and path == "/api/mcp/servers":
            var = f"MCP_{mcp_servers.server_key(body['name'])}_API_KEY"
            self.env[var] = body["bearer_token"]
            self.servers[body["name"]] = {"url": body["url"], "headers": {"Authorization": "Bearer ${" + var + "}"}}
            return {"ok": True}
        if method == "GET" and path == "/api/config":
            return {"mcp_servers": copy.deepcopy(self.servers)}
        if method == "PUT" and path == "/api/mcp/servers":
            self.servers = copy.deepcopy(body["servers"])
            return {"ok": True}
        if method == "PUT" and path.startswith("/api/tools/toolsets/"):
            name = path.rsplit("/", 1)[1]
            if self.toolset_error and name in self.toolset_error:
                raise HermesError("down", 503)
            self.toolsets[name] = bool(body["enabled"])
            return {"ok": True}
        if method == "POST" and path.startswith("/api/mcp/servers/") and path.endswith("/test"):
            if isinstance(self.test, Exception):
                raise self.test
            return copy.deepcopy(self.test)
        if method == "PUT" and path == "/api/env":
            self.env[body["key"]] = body["value"]
            return {"ok": True}
        if method == "DELETE" and path == "/api/env":
            self.env.pop(body["key"], None)
            return {"ok": True}
        if method == "DELETE" and path.startswith("/api/mcp/servers/"):
            self.servers.pop(path.rsplit("/", 1)[1], None)
            return {"ok": True}
        if method == "GET" and path == "/api/mcp/catalog":
            return {"entries": [{"name": "ctx", "auth_type": "none", "needs_install": False, "transport": "http", "description": "문서"}]}
        if method == "GET" and path == "/api/env":
            return {}
        raise AssertionError(f"예상하지 못한 호출: {method} {path}")


def _with_url(url=URL):
    return mock.patch.dict(os.environ, {"AAS_OUTLINE_MCP_URL": url})


def _install(api, env, **kw):
    return mcp_servers.install(api, "ma", {"server": "outline", "env": env, **kw.pop("body", {})}, owner=False, secure=kw.pop("secure", True),
                               profs=["ma"], pod="p", by="t@example.com")


class OutlineCatalogTest(unittest.TestCase):
    def setUp(self):
        probe = mock.patch.object(mcp_servers, "_docmost_probe", return_value=200)    # 시험은 Outline 에 요청하지 않는다
        self.probed = probe.start()
        self.addCleanup(probe.stop)

    def test_entry_is_listed_right_after_docmost_with_an_address_field_and_a_secret_key_field(self):
        with _with_url(""):
            names = [e["name"] for e in mcp_servers.catalog(FakeHermes(), "ma")["entries"]]
            entry = mcp_servers.catalog(FakeHermes(), "ma")["entries"][1]
        self.assertEqual(names, ["docmost", "outline", "ctx"])
        self.assertEqual((entry["installed"], entry["builtin"], entry["write"]), (False, True, False))
        url_field, key_field = entry["required_env"]
        self.assertEqual((url_field["name"], url_field["secret"], url_field["value"]), (FIELD, False, ""))
        self.assertEqual((key_field["name"], key_field["secret"]), (KEY, True))
        with _with_url():
            self.assertEqual(mcp_servers.catalog(FakeHermes(), "ma")["entries"][1]["required_env"][0]["value"], URL)

    def test_install_registers_seven_read_tools_and_turns_off_browser_and_connections(self):
        api = FakeHermes()
        out = _install(api, {FIELD: URL, KEY: "Bearer key-1"})
        self.assertEqual((out["ok"], out["write"], out["browser_off"], out["connections_off"]), (True, False, True, True))
        self.assertEqual(out["skill_package"], "free/outline")
        self.assertEqual(api.env, {KEY: "key-1"})
        entry = api.servers["outline"]
        self.assertEqual((entry["url"], entry["headers"]), (URL, {"Authorization": "Bearer ${MCP_OUTLINE_API_KEY}"}))
        self.assertEqual(entry["tools"], {"include": list(mcp_servers.OUTLINE_READ_TOOLS)})
        self.assertEqual(api.toolsets, {"browser": False, "connections": False})
        self.assertFalse(any(c[1] == "/api/mcp/catalog/install" for c in api.calls))
        self.assertEqual((len(mcp_servers.OUTLINE_READ_TOOLS), len(mcp_servers.OUTLINE_WRITE_TOOLS)), (7, 9))

    def test_the_server_appears_already_limited_so_the_gateway_never_sees_all_tools(self):
        """Hermes 추가 API(POST)에는 tools 칸이 없다. 추가한 뒤 include 를 쓰면 그 사이 게이트웨이가 삭제 도구까지 등록했다(OKE 2026-10-23, 15-3).
        키를 .env 에 먼저 쓰고, include 가 든 항목을 지도 쓰기 한 번으로 만든다."""
        for write, want in ((False, mcp_servers.OUTLINE_READ_TOOLS), (True, mcp_servers.OUTLINE_READ_TOOLS + mcp_servers.OUTLINE_WRITE_TOOLS)):
            api = FakeHermes()
            _install(api, {FIELD: URL, KEY: "Bearer key-9"}, body={"write": write})
            self.assertFalse(any(c[:2] == ("POST", "/api/mcp/servers") for c in api.calls))
            first = next(c for c in api.calls if c[:2] == ("PUT", "/api/mcp/servers") and "outline" in c[2]["servers"])
            self.assertEqual(first[2]["servers"]["outline"]["tools"], {"include": list(want)})
            env_put = next(i for i, c in enumerate(api.calls) if c[:2] == ("PUT", "/api/env"))
            self.assertLess(env_put, api.calls.index(first))                              # 키를 먼저 쓴다
            self.assertEqual(api.env, {KEY: "key-9"})

    def test_a_failed_create_removes_the_key_line(self):
        api = FakeHermes({"outline": {"url": URL}})                                       # 그사이 같은 이름이 생겼다
        with mock.patch.object(mcp_servers, "_servers", return_value=[]):                  # 목록에는 아직 없다고 보이는 경쟁
            with self.assertRaises(HermesError) as cm:
                mcp_servers.add(api, "ma", {"server": "outline", "kind": "url", "url": URL, "auth": "header", "bearer_token": "k"},
                                owner=False, secure=True, profs=["ma"], pod="p", by="x", tools_include=["fetch"])
        self.assertEqual(cm.exception.code, 409)
        self.assertEqual(api.env, {})

    def test_write_adds_nine_tools_and_never_the_delete_tools(self):
        api = FakeHermes()
        _install(api, {FIELD: URL, KEY: "k"}, body={"write": True})
        include = api.servers["outline"]["tools"]["include"]
        self.assertEqual(include, list(mcp_servers.OUTLINE_READ_TOOLS + mcp_servers.OUTLINE_WRITE_TOOLS))
        self.assertFalse(set(DELETE_TOOLS) & set(include))
        self.assertEqual(mcp_servers.catalog(api, "ma")["entries"][1]["write"], True)
        mcp_servers.set_outline_write(api, "ma", False, pod="p", by="x")
        self.assertEqual(api.servers["outline"]["tools"]["include"], list(mcp_servers.OUTLINE_READ_TOOLS))
        mcp_servers.set_outline_write(api, "ma", True, pod="p", by="x")
        self.assertFalse(set(DELETE_TOOLS) & set(api.servers["outline"]["tools"]["include"]))

    def test_write_switch_on_a_profile_without_outline_is_404(self):
        with self.assertRaises(FileError) as cm:
            mcp_servers.set_outline_write(FakeHermes(), "ma", True, pod="p", by="x")
        self.assertEqual(cm.exception.code, 404)

    def test_toolset_failures_do_not_fail_the_install_but_are_reported_one_by_one(self):
        for broken, want in ((("browser",), (False, True)), (("connections",), (True, False)), (("browser", "connections"), (False, False))):
            api = FakeHermes(toolset_error=broken)
            out = _install(api, {FIELD: URL, KEY: "k"})
            self.assertEqual((out["ok"], out["browser_off"], out["connections_off"]), (True,) + want, broken)
            self.assertIn("outline", api.servers)

    def test_only_declared_fields_are_accepted(self):
        for env in ({FIELD: URL, KEY: "k", "MCP_DOCMOST_API_KEY": "x"}, {FIELD: URL, KEY: "k\nX=1"}):
            with self.assertRaises(FileError) as cm:
                _install(FakeHermes(), env)
            self.assertEqual(cm.exception.reason, "env_undeclared", env)
        for env, reason in (({KEY: "k"}, "env_missing"), ({FIELD: URL}, "env_missing"), ({FIELD: "ftp://x/mcp", KEY: "k"}, "url_format")):
            with self.assertRaises(FileError) as cm:
                _install(FakeHermes(), env)
            self.assertEqual(cm.exception.reason, reason, env)
        with self.assertRaises(FileError) as cm:
            _install(FakeHermes(), {FIELD: URL, KEY: "k"}, secure=False)
        self.assertEqual(cm.exception.reason, "insecure")

    def test_only_the_install_value_address_is_probed(self):
        with _with_url():
            _install(FakeHermes(), {FIELD: URL, KEY: "k"})
            _install(FakeHermes(), {FIELD: "https://other.example/mcp", KEY: "k"})
        self.assertEqual(self.probed.call_count, 1)

    def test_rejected_key_and_mcp_off_are_explained_before_anything_is_written(self):
        """401·403 은 키 문제, 404 는 MCP 를 끈 워크스페이스다(Outline server/routes/mcp/index.ts, R2·D5)."""
        api = FakeHermes()
        for status, reason in ((401, "outline_key_rejected"), (403, "outline_key_rejected"), (404, "outline_mcp_off")):
            with _with_url(), mock.patch.object(mcp_servers, "_docmost_probe", return_value=status):
                with self.assertRaises(FileError) as cm:
                    _install(api, {FIELD: URL, KEY: "bad"})
            self.assertEqual((cm.exception.reason, cm.exception.code), (reason, 400), status)
        self.assertIn("Settings → Workspace → AI", str(cm.exception))
        self.assertEqual(api.calls, [c for c in api.calls if c[0] == "GET"])            # 아무것도 쓰지 않았다
        for status in (200, 0, 500):
            with _with_url(), mock.patch.object(mcp_servers, "_docmost_probe", return_value=status):
                self.assertTrue(_install(FakeHermes(), {FIELD: URL, KEY: "k"})["ok"], status)

    def test_a_rejected_key_found_by_the_connection_test_removes_the_server_and_refuses(self):
        """Hermes 의 추가는 키가 틀려도 저장한다 — 오류는 연결 시험에서야 나온다(OKE 2026-10-23, 15절). 설치 직후 시험해 지우고 거절한다."""
        err401 = ("MCP server 'outline': both Streamable HTTP and SSE transports failed (Streamable HTTP: Server returned an error response "
                  "(HTTP 401 from POST https://wiki.corp.example/mcp {\"ok\":false,\"message\":\"Unable to decode token\"}); SSE: Client error '405 Method Not Allowed')")
        for error, reason in ((err401, "outline_key_rejected"), (err401.replace("HTTP 401", "HTTP 403"), "outline_key_rejected"),
                              ("Server returned an error response (HTTP 404 from POST https://wiki.corp.example/mcp)", "outline_mcp_off")):
            api = FakeHermes(test={"ok": False, "error": error})
            with self.assertRaises(FileError) as cm:
                _install(api, {FIELD: "https://other.example/mcp", KEY: "bad"})
            self.assertEqual((cm.exception.reason, cm.exception.code), (reason, 400), error[:60])
            self.assertIn("지웠습니다", str(cm.exception))
            self.assertEqual((api.servers, api.env), ({}, {}))                          # 서버와 키 줄을 지웠다
            self.assertFalse(any(c[1].startswith("/api/tools/toolsets/") for c in api.calls))   # 도구 묶음은 건드리지 않았다
            self.assertEqual(sum(c[:2] == ("PUT", "/api/mcp/servers") for c in api.calls), 1)   # 지도 쓰기는 만들 때 한 번뿐

    def test_a_slow_or_other_connection_test_keeps_the_install(self):
        for test in (HermesError("timeout", 504, reason="timeout"), {"ok": False, "error": "connection reset"}, {"ok": True, "tools": [1]}):
            api = FakeHermes(test=test)
            self.assertTrue(_install(api, {FIELD: URL, KEY: "k"})["ok"], test)
            self.assertIn("outline", api.servers)
            self.assertEqual(api.servers["outline"]["tools"], {"include": list(mcp_servers.OUTLINE_READ_TOOLS)})

    def test_connection_test_errors_get_a_plain_hint_for_401_403_404(self):
        raw = "both Streamable HTTP and SSE transports failed (Streamable HTTP: Server returned an error response (HTTP 401 from POST https://x/mcp)"
        out = mcp_servers.explain_test_error(raw)
        self.assertTrue(out.startswith("서버가 인증을 거절했습니다(HTTP 401)"), out)
        self.assertTrue(out.endswith(raw))                                               # 원문은 뒤에 남긴다
        self.assertIn("HTTP 403", mcp_servers.explain_test_error(raw.replace("401", "403")))
        self.assertTrue(mcp_servers.explain_test_error(raw.replace("401", "404")).startswith("서버가 이 주소에서 MCP 를 찾지 못했습니다"))
        for other in ("", "connection reset", "HTTP 500 from POST"):
            self.assertEqual(mcp_servers.explain_test_error(other), other)

    def test_installed_entry_cannot_be_installed_again(self):
        with self.assertRaises(FileError) as cm:
            _install(FakeHermes({"outline": {"url": URL}}), {FIELD: URL, KEY: "k"})
        self.assertEqual(cm.exception.code, 409)

    def test_removing_outline_tells_that_the_toolsets_stay_off(self):
        """지워도 browser·connections 는 다시 켜지 않는다 — 알리기만 한다(R6·D9). 다른 서버에는 알림이 없다."""
        api = FakeHermes({"outline": {"url": URL}, "docs": {"url": URL}})
        out = mcp_servers.remove(api, "ma", "outline", "mcp_servers:\n  outline:\n    url: x\n")
        self.assertTrue(out["toolsets_off_notice"])
        self.assertNotIn("toolsets_off_notice", mcp_servers.remove(api, "ma", "docs", "mcp_servers:\n  docs:\n    url: x\n"))
        self.assertFalse(any(c[1].startswith("/api/tools/toolsets/") for c in api.calls))


if __name__ == "__main__":
    unittest.main()

# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""MCP 서버 한 줄 표시(redact.mcp_target)와 프로파일 MCP 탭(profiles.mcp_view)이 같은 값을 내는지 시험한다(OMAI-1249).

http 서버는 호스트까지만 보이고(경로·쿼리·사용자정보에 토큰이 들어 있을 수 있다), stdio 서버는 명령 이름과 앞 두 인자를 보이되
비밀 옵션(--api-key 등)의 값은 가린다.
"""
import os
import tempfile
import unittest
from pathlib import Path

TMP = tempfile.TemporaryDirectory()
os.environ.setdefault("AAS_DATA_DIR", str(Path(TMP.name) / "data"))

from aas.common import i18n  # noqa: E402
from aas.common.redact import mcp_target  # noqa: E402
from aas.fleet import profiles  # noqa: E402


class McpTargetTest(unittest.TestCase):
    def setUp(self):
        i18n.set_lang("ko")

    def test_http_shows_scheme_and_host_only(self):
        self.assertEqual(mcp_target("https://u:p@h.io:8443/a/b?token=1#f", "", []), "https://h.io:8443/…")
        self.assertEqual(mcp_target("http://h.io", "", []), "http://h.io/…")
        self.assertEqual(mcp_target("https://[::1]:9000/mcp", "", []), "https://[::1]:9000/…")

    def test_http_never_shows_a_token_in_the_path(self):
        out = mcp_target("https://mcp.example.com/s/Abcdef0123456789TOKENxyz/mcp?key=SECRET", "", [])
        self.assertNotIn("TOKEN", out)
        self.assertNotIn("SECRET", out)
        self.assertEqual(out, "https://mcp.example.com/…")

    def test_http_wins_over_command_and_bad_urls_are_not_echoed(self):
        self.assertEqual(mcp_target("https://h.io/x", "python3", ["a.py"]), "https://h.io/…")
        bad = mcp_target("http://[bad/SECRET", "", [])
        self.assertNotIn("SECRET", bad)
        self.assertEqual(mcp_target("no-scheme.example/SECRET", "", []).count("SECRET"), 0)

    def test_stdio_shows_command_name_and_first_two_args(self):
        self.assertEqual(mcp_target("", "/opt/hermes/.venv/bin/python3", ["/opt/data/scripts/bridge.py", "--x"]), "python3 bridge.py --x")
        self.assertEqual(mcp_target("", "npx", ["-y", "@scope/pkg", "third"]), "npx -y pkg")       # 인자는 Path.name 을 거치고 앞 두 개만 보인다

    def test_stdio_masks_the_value_of_a_secret_option(self):
        self.assertEqual(mcp_target("", "srv", ["--api-key", "abc123"]), "srv --api-key ***")
        self.assertEqual(mcp_target("", "srv", ["--TOKEN", "abc"]), "srv --TOKEN ***")
        self.assertEqual(mcp_target("", "srv", ["--client-secret", "abc"]), "srv --client-secret ***")
        self.assertEqual(mcp_target("", "srv", ["--api-key=abc123"]), "srv --api-key=***")           # mask_line 은 이 모양의 짧은 값을 가리지 못한다
        self.assertEqual(mcp_target("", "srv", ["--password=hunter2"]), "srv --password=***")

    def test_stdio_leaves_normal_options_and_documents_the_name_rule_limit(self):
        self.assertEqual(mcp_target("", "srv", ["--port", "8080"]), "srv --port 8080")
        self.assertEqual(mcp_target("", "srv", ["--pass", "abc123"]), "srv --pass abc123")            # 한계: 이름에 key·token 등이 없는 옵션은 가려지지 않는다

    def test_stdio_still_masks_secret_shaped_values(self):
        out = mcp_target("", "srv", ["ghp_abcdefghijklmnopqrstuvwxyz0123456789"])
        self.assertNotIn("abcdefghijklmnop", out)

    def test_empty_inputs(self):
        self.assertEqual(mcp_target("", "", []), "")
        self.assertEqual(mcp_target(None, None, None), "")
        self.assertEqual(mcp_target("", "", ["only-args"]), "")                                      # 명령이 없으면 인자만으로는 보이지 않는다
        self.assertEqual(mcp_target("", "srv", None), "srv")
        self.assertEqual(mcp_target("", "srv", "notalist"), "srv")                                   # args 가 목록이 아니어도 예외를 내지 않는다
        self.assertEqual(mcp_target(12345, "", []), "")                                              # url 이 문자열이 아니면 건너뛴다(예외 없음)


class McpViewTest(unittest.TestCase):
    """합치기 전에 mcp_view 의 출력을 고정하고, 합친 뒤에는 mcp_target 의 규칙을 반영한다."""

    ROWS = {"servers": [
        {"name": "OMDM", "transport": "stdio", "command": "/opt/hermes/.venv/bin/python3", "args": ["/opt/data/scripts/bridge.py"],
         "env": {"OMDM_TOKEN": "tok-abcdefghijklmnopqrstuvwxyz0123", "A": "1"}, "enabled": True},
        {"name": "docs", "transport": "http", "url": "https://docs.example.com/s/Abcdef0123456789TOKENxyz/mcp?key=SECRET",
         "headers": {"Authorization": "Bearer abcdefghijklmnop"}, "enabled": False, "auth": "header"},
        {"name": ""}, "not-a-row",
    ]}

    def test_names_only_and_no_secret_leaks(self):
        out = profiles.mcp_view(self.ROWS)
        self.assertEqual([r["name"] for r in out], ["OMDM", "docs"])
        blob = str(out)
        for secret in ("tok-abcdefghijklmnop", "Abcdef0123456789TOKENxyz", "SECRET", "abcdefghijklmnop"):
            self.assertNotIn(secret, blob)
        self.assertEqual(out[0]["env_names"], ["A", "OMDM_TOKEN"])
        self.assertEqual(out[0]["target"], "python3 bridge.py")
        self.assertEqual(out[1]["target"], "https://docs.example.com/…")
        self.assertEqual((out[0]["enabled"], out[1]["enabled"]), (True, False))
        self.assertEqual((out[0]["auth"], out[1]["auth"]), ("", "header"))
        self.assertEqual((out[0]["transport"], out[1]["transport"]), ("stdio", "http"))

    def test_list_input_and_empty(self):
        self.assertEqual(profiles.mcp_view([]), [])
        self.assertEqual(profiles.mcp_view(None), [])
        self.assertEqual(profiles.mcp_view({"servers": [{"name": "a", "enabled": False, "command": "x"}]})[0]["target"], "x")


if __name__ == "__main__":
    unittest.main()

# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""MCP 서버 설정 쓰기 규칙(mcp_servers.replace_server)을 시험한다(스펙 2026-10-16-010 4-2·13절 X1, OMAI-1263).

Hermes 의 PUT /api/config 는 깊은 병합이라 키를 지우지 못한다. 그래서 GET /api/config?include_defaults=false 로
원본 mcp_servers 를 읽고, 그 서버 항목만 새로 만들어 PUT /api/mcp/servers 로 지도 전체를 쓴다.
쓰기 직전 다시 읽어 바뀌었으면 덮지 않고, 이전 지도를 판 기록에 남긴다(비밀값처럼 보이면 남기지 않는다).
"""
import copy
import os
import tempfile
import unittest
from pathlib import Path

TMP = tempfile.TemporaryDirectory()
os.environ.setdefault("AAS_DATA_DIR", str(Path(TMP.name) / "data"))

from aas.assets.files import FileError  # noqa: E402
from aas.common import i18n, store  # noqa: E402
from aas.hermes.hermes_api import HermesError  # noqa: E402
from aas.ops import mcp_servers  # noqa: E402


class FakeHermes:
    """원본 config.yaml 의 mcp_servers 만 흉내 낸다. on_read 가 있으면 읽을 때마다 부른다(그사이 바뀜 흉내)."""

    def __init__(self, servers):
        self.servers = copy.deepcopy(servers)
        self.calls = []
        self.on_read = None
        self.reject = None

    def call(self, method, path, body=None, query=None, timeout=30):
        self.calls.append((method, path, dict(query or {}), copy.deepcopy(body)))
        if method == "GET" and path == "/api/config":
            assert (query or {}).get("include_defaults") == "false"
            if self.on_read:
                self.on_read(self)
            return {"model": "m", "mcp_servers": copy.deepcopy(self.servers)}
        if method == "PUT" and path == "/api/mcp/servers":
            if self.reject:
                raise self.reject
            self.servers = copy.deepcopy(body["servers"])
            return {"ok": True}
        raise AssertionError(f"예상하지 못한 호출: {method} {path}")


HEADER_SERVER = {"url": "https://mcp.example.com/mcp", "headers": {"Authorization": "Bearer ${MCP_JIRA_API_KEY}"},
                 "enabled": False, "tools": ["search"]}
OTHER = {"command": "npx", "args": ["-y", "@x/mcp"], "env": {"TOKEN": "${MCP_OTHER__TOKEN__AB12}"}}


def to_oauth(entry):
    entry.pop("headers", None)
    entry["auth"] = "oauth"
    entry["oauth"] = {"redirect_uri": "https://aas.example.com/oauth/mcp/callback", "application_type": "web", "timeout": 600}
    return entry


class KeyLockNoTransactionTest(unittest.TestCase):
    """MCP 설정 잠금이 DB 트랜잭션을 연 채 Hermes 를 30초씩 기다렸다. PostgreSQL 에 「트랜잭션 중 쉼」 한도(스펙 2026-10-24-002 R6)가
    들어가면 Hermes 가 느린 날 설정 저장이 끊긴다 — 복제본 사이의 잠금은 전용 연결의 세션 잠금으로 잡는다(R12, 검토 D2)."""

    def test_postgres_에서는_전용_연결의_세션_잠금만_쥐고_트랜잭션을_열지_않는다(self):
        from unittest import mock
        from aas.common import db
        seen = []

        class FakeConn:
            def execute(self, sql, params=None):
                seen.append(sql.split("(")[0])
                return self

            def close(self):
                seen.append("close")

        def no_transaction():
            raise AssertionError("잠금 안에서 store.connect 트랜잭션을 열었다")
        with mock.patch.object(db, "backend", return_value="postgres"), \
                mock.patch.object(db, "session_connection", return_value=FakeConn()), \
                mock.patch.object(mcp_servers.store, "connect", side_effect=no_transaction):
            with mcp_servers.key_lock("mcp_servers:p:main"):
                seen.append("body")                          # 여기서 Hermes 를 부른다
        self.assertEqual(seen, ["SELECT pg_advisory_lock", "body", "SELECT pg_advisory_unlock", "close"])

    def test_잠금_풀기가_실패해도_본문_결과를_덮지_않고_연결을_닫는다(self):
        """연결이 끊겨 unlock 이 실패하면 저장이 성공했어도 오류가 됐다. 연결을 닫으면 PostgreSQL 이 잠금을 푼다
        (스펙 2026-10-24-002 외부 검토 1)."""
        from unittest import mock
        from aas.common import db
        seen = []

        class FakeConn:
            def execute(self, sql, params=None):
                if "unlock" in sql:
                    raise OSError("연결이 끊겼다")
                return self

            def close(self):
                seen.append("close")
        with mock.patch.object(db, "backend", return_value="postgres"), \
                mock.patch.object(db, "session_connection", return_value=FakeConn()):
            with mcp_servers.key_lock("mcp_servers:p:unlock"):
                seen.append("body")
        self.assertEqual(seen, ["body", "close"])


class ReplaceServerTest(unittest.TestCase):
    def setUp(self):
        i18n.set_lang("ko")
        self.api = FakeHermes({"jira": HEADER_SERVER, "other": OTHER})

    def test_header_to_oauth_really_removes_headers_and_keeps_the_rest(self):
        out = mcp_servers.replace_server(self.api, "alpha", "jira", to_oauth, pod="p1", by="u@x")
        self.assertTrue(out["ok"])
        sent = next(c for c in self.api.calls if c[0] == "PUT")
        self.assertEqual(sent[2], {"profile": "alpha"})
        jira = sent[3]["servers"]["jira"]
        self.assertNotIn("headers", jira)                                   # 깊은 병합이었으면 남았을 옛 헤더
        self.assertEqual((jira["auth"], jira["enabled"], jira["tools"]), ("oauth", False, ["search"]))
        self.assertEqual(sent[3]["servers"]["other"], OTHER)                 # 다른 서버 항목은 원본 그대로

    def test_undo_oauth_subkeys_removes_the_keys_not_null(self):
        self.api.servers["jira"] = {"url": "https://mcp.example.com/mcp", "auth": "oauth",
                                    "oauth": {"redirect_uri": "https://aas/cb", "client_id": "c1", "scope": "read"}}

        def back_to_dynamic(entry):
            for k in ("client_id", "scope"):
                entry["oauth"].pop(k, None)
            return entry

        mcp_servers.replace_server(self.api, None, "jira", back_to_dynamic, pod="p1", by="u@x")
        self.assertEqual(self.api.servers["jira"]["oauth"], {"redirect_uri": "https://aas/cb"})

    def test_changed_in_the_meantime_is_not_overwritten(self):
        reads = []

        def someone_edits(api):
            reads.append(1)
            if len(reads) == 2:                                            # 두 번째(쓰기 직전) 읽기 전에 누가 바꿨다
                api.servers["other"] = {"command": "uvx", "args": []}

        self.api.on_read = someone_edits
        with self.assertRaises(FileError) as ctx:
            mcp_servers.replace_server(self.api, None, "jira", to_oauth, pod="p1", by="u@x")
        self.assertEqual((ctx.exception.code, ctx.exception.reason), (409, "changed"))
        self.assertFalse(any(c[0] == "PUT" for c in self.api.calls))

    def test_missing_server_is_404(self):
        with self.assertRaises(FileError) as ctx:
            mcp_servers.replace_server(self.api, None, "nope", to_oauth, pod="p1", by="u@x")
        self.assertEqual(ctx.exception.code, 404)

    def test_no_change_sends_nothing(self):
        out = mcp_servers.replace_server(self.api, None, "jira", lambda e: e, pod="p1", by="u@x")
        self.assertEqual(out, {"ok": True, "name": "jira", "changed": False, "version": None})
        self.assertFalse(any(c[0] == "PUT" for c in self.api.calls))

    def test_previous_map_is_kept_as_a_version_when_it_has_no_secret(self):
        out = mcp_servers.replace_server(self.api, "alpha", "jira", to_oauth, pod="p-hist", by="u@x")
        self.assertIsNotNone(out["version"])
        with store.connect() as conn:
            rows = [dict(r) for r in conn.execute("SELECT path, content FROM file_versions WHERE pod=? ORDER BY id", ("p-hist",))]
            conn.execute("DELETE FROM file_versions WHERE pod=?", ("p-hist",))    # 같은 데이터 폴더를 쓰는 다른 시험을 위해 지운다
        self.assertEqual(rows[0]["path"], "mcp_servers:alpha")
        self.assertIn("MCP_JIRA_API_KEY", rows[0]["content"])                  # 참조 이름은 남지만 값은 없다

    def test_map_with_a_literal_secret_is_not_stored_in_aas(self):
        self.api.servers["other"] = {"command": "npx", "env": {"API_KEY": "sk-live-0123456789abcdefghij"}}
        out = mcp_servers.replace_server(self.api, None, "jira", to_oauth, pod="p-secret", by="u@x")
        self.assertTrue(out["ok"])
        self.assertIsNone(out["version"])
        with store.connect() as conn:
            n = conn.execute("SELECT COUNT(*) FROM file_versions WHERE pod=?", ("p-secret",)).fetchone()[0]
        self.assertEqual(n, 0)

    def test_hermes_rejection_is_reported_and_leaves_no_version(self):
        self.api.reject = HermesError("Server 'jira' rejected: suspicious command/args configuration", 400)
        with self.assertRaises(HermesError) as ctx:
            mcp_servers.replace_server(self.api, None, "jira", to_oauth, pod="p-rej", by="u@x")
        self.assertEqual(ctx.exception.reason, "unsafe")
        with store.connect() as conn:
            n = conn.execute("SELECT COUNT(*) FROM file_versions WHERE pod=?", ("p-rej",)).fetchone()[0]
        self.assertEqual(n, 0)



class AddWithClientTest(unittest.TestCase):
    """미리 등록한 클라이언트로 OAuth 서버 추가(스펙 2026-10-16-010 V7): client_secret 은 .env 에, 설정에는 ${VAR} 참조만."""

    class Api(FakeHermes):
        def __init__(self):
            super().__init__({})
            self.env = {}

        def call(self, method, path, body=None, query=None, timeout=30):
            if method == "GET" and path == "/api/mcp/servers":
                return {"servers": [{"name": n} for n in self.servers]}
            if method == "POST" and path == "/api/mcp/servers":
                self.servers[body["name"]] = {"url": body["url"], "auth": body["auth"]}
                return {"ok": True}
            if path == "/api/env":
                if method == "PUT":
                    self.env[body["key"]] = body["value"]
                    return {"ok": True}
                return dict.fromkeys(self.env, {"is_set": True})
            return super().call(method, path, body, query, timeout)

    def setUp(self):
        i18n.set_lang("ko")
        with store.connect() as conn:
            from aas.assets import files
            conn.execute(files.VERSION_SCHEMA)
            conn.execute("DELETE FROM file_versions WHERE pod=?", ("cw-p",))

    def add(self, api, client, secure=True):
        body = {"kind": "url", "server": "jira", "url": "https://mcp.example.com/mcp", "auth": "oauth", "oauth_client": client}
        return mcp_servers.add(api, "alpha", body, owner=False, secure=secure, profs=["alpha"], pod="cw-p", by="u@x")

    def test_secret_goes_to_dotenv_and_config_keeps_a_reference(self):
        api = self.Api()
        self.add(api, {"client_id": "aas-console", "client_secret": "s3cret-client-value", "scope": "openid read"})
        (var, value), = api.env.items()
        self.assertRegex(var, r"^MCP_JIRA__CLIENT_SECRET__[0-9A-F]{4}$")
        self.assertEqual(value, "s3cret-client-value")
        self.assertEqual(api.servers["jira"]["oauth"], {"client_id": "aas-console", "scope": "openid read", "client_secret": "${" + var + "}"})
        self.assertNotIn("s3cret-client-value", repr(api.servers))

    def test_client_secret_needs_an_encrypted_request_and_a_client_id(self):
        with self.assertRaises(FileError) as ctx:
            self.add(self.Api(), {"client_id": "a", "client_secret": "s"}, secure=False)
        self.assertEqual(ctx.exception.reason, "insecure")
        with self.assertRaises(FileError) as ctx:
            self.add(self.Api(), {"client_secret": "s"})
        self.assertEqual((ctx.exception.reason, ctx.exception.field), ("client_format", "client_id"))
        api = self.Api()
        self.add(api, {"client_id": "public-app"}, secure=False)                 # 비밀값이 없으면 http 화면에서도 된다
        self.assertEqual((api.servers["jira"]["oauth"], api.env), ({"client_id": "public-app"}, {}))


if __name__ == "__main__":
    unittest.main()


class ToOAuthTest(unittest.TestCase):
    """헤더 인증 서버를 OAuth 로 바꾸기(V15): headers 를 빼고 켜짐·도구 선택은 두며, 이 서버만 쓰던 비밀값 줄을 지운다."""

    class Api(FakeHermes):
        def __init__(self, servers):
            super().__init__(servers)
            self.cleared = []

        def call(self, method, path, body=None, query=None, timeout=30):
            if method == "DELETE" and path.startswith("/api/env"):
                self.cleared.append((body or {}).get("key") or path.rsplit("/", 1)[-1])
                return {"ok": True}
            return super().call(method, path, body, query, timeout)

    def setUp(self):
        i18n.set_lang("ko")

    def test_switch_removes_headers_keeps_the_rest_and_clears_the_unused_token(self):
        api = self.Api({"jira": HEADER_SERVER, "other": OTHER})
        out = mcp_servers.to_oauth(api, "alpha", "jira", pod="cw-p", by="u@x")
        self.assertEqual(api.servers["jira"], {"url": "https://mcp.example.com/mcp", "enabled": False, "tools": ["search"], "auth": "oauth"})
        self.assertEqual(api.servers["other"], OTHER)
        self.assertEqual((out["env_cleared"], api.cleared), (1, ["MCP_JIRA_API_KEY"]))
        self.assertFalse(mcp_servers.to_oauth(api, "alpha", "jira", pod="cw-p", by="u@x")["changed"])      # 이미 OAuth

    def test_token_still_used_by_another_server_is_kept_and_stdio_is_refused(self):
        shared = {**OTHER, "env": {"TOKEN": "${MCP_JIRA_API_KEY}"}}
        api = self.Api({"jira": HEADER_SERVER, "other": shared})
        self.assertEqual(mcp_servers.to_oauth(api, "alpha", "jira", pod="cw-p", by="u@x")["env_cleared"], 0)
        with self.assertRaises(FileError) as ctx:
            mcp_servers.to_oauth(api, "alpha", "other", pod="cw-p", by="u@x")
        self.assertEqual(ctx.exception.reason, "not_remote")


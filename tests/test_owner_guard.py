# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""주인(관리자가 아닌 파드 주인)의 비밀값·채널 동작 검사(스펙 2026-10-15-011 D2·D3·R2·R5)."""
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

TMP = tempfile.TemporaryDirectory()
os.environ.setdefault("AAS_DATA_DIR", str(Path(TMP.name) / "data"))

from aas.fleet import primary  # noqa: E402
from aas.ops import owner_guard  # noqa: E402

CATALOG = {"OPENAI_API_KEY": "provider", "SERPER_API_KEY": "tool", "GITHUB_TOKEN": "skill", "TELEGRAM_BOT_TOKEN": "messaging",
           "HERMES_MAX_ITERATIONS": "setting", "TELEGRAM_ALLOWED_USERS": "messaging"}


class EnvKeyTest(unittest.TestCase):
    def test_tool_skill_and_unknown_custom_keys_are_allowed(self):
        for key in ("SERPER_API_KEY", "GITHUB_TOKEN", "MY_SKILL_KEY"):
            self.assertEqual(owner_guard.env_key_error(key, CATALOG), "", key)

    def test_provider_setting_and_policy_names_are_refused(self):
        for key in ("OPENAI_API_KEY", "HERMES_LLM_API_KEY", "HERMES_MAX_ITERATIONS", "GATEWAY_ALLOW_ALL_USERS", "TERMINAL_ENV", "AAS_X",
                    "LITELLM_MASTER_KEY", "OPENAI_BASE_URL", "HTTP_PROXY_ENDPOINT", "SOME_PROXY", "PATH", "HOME", "PYTHONPATH", "LD_PRELOAD"):
            self.assertTrue(owner_guard.env_key_error(key, CATALOG), key)

    def test_messaging_names_go_through_the_channel_tab_only(self):
        self.assertTrue(owner_guard.env_key_error("TELEGRAM_BOT_TOKEN", CATALOG))

    def test_unreadable_catalog_refuses_everything(self):
        self.assertTrue(owner_guard.env_key_error("SERPER_API_KEY", None))          # fail-closed


class ChannelEnvTest(unittest.TestCase):
    def test_only_token_and_real_user_ids_are_allowed(self):
        ok = (("telegram", "TELEGRAM_BOT_TOKEN", "123:abc"), ("telegram", "TELEGRAM_ALLOWED_USERS", "42,77"), ("discord", "DISCORD_BOT_TOKEN", "t"),
              ("discord", "DISCORD_ALLOWED_USERS", "1234567890"), ("slack", "SLACK_BOT_TOKEN", "xoxb-1"), ("slack", "SLACK_APP_TOKEN", "xapp-1"),
              ("slack", "SLACK_ALLOWED_USERS", "U1,U2"))
        for plat, key, val in ok:
            self.assertEqual(owner_guard.channel_env_error(plat, key, val), "", (plat, key))

    def test_star_empty_entries_and_policy_variables_are_refused(self):
        bad = (("telegram", "TELEGRAM_ALLOWED_USERS", "*"), ("telegram", "TELEGRAM_ALLOWED_USERS", "42,,77"), ("telegram", "TELEGRAM_ALLOWED_USERS", "42, *"),
               ("telegram", "TELEGRAM_ALLOWED_USERS", " "), ("telegram", "GATEWAY_ALLOWED_USERS", "42"), ("telegram", "TELEGRAM_ALLOW_ALL_USERS", "true"),
               ("telegram", "TELEGRAM_GROUP_ALLOWED_USERS", "42"), ("discord", "DISCORD_ALLOWED_ROLES", "1"), ("discord", "DISCORD_ALLOW_BOTS", "true"),
               ("slack", "SLACK_DM_POLICY", "open"), ("telegram", "TELEGRAM_PROXY", "http://x"), ("telegram", "DISCORD_BOT_TOKEN", "t"))
        for plat, key, val in bad:
            self.assertTrue(owner_guard.channel_env_error(plat, key, val), (plat, key, val))

    def test_mattermost_owner_can_set_server_url_token_and_user_ids(self):
        # Mattermost(스펙 2026-10-19-008): 봇 토큰 이름이 MATTERMOST_TOKEN 이고 서버 주소가 필수다
        ok = (("mattermost", "MATTERMOST_URL", "https://mattermost.example.com"), ("mattermost", "MATTERMOST_URL", "http://10.0.0.5:8065/mm"),
              ("mattermost", "MATTERMOST_TOKEN", "abc123"), ("mattermost", "MATTERMOST_ALLOWED_USERS", "3uo8dkh1p7g1mfk49ear5fzs5c"))
        for plat, key, val in ok:
            self.assertEqual(owner_guard.channel_env_error(plat, key, val), "", (plat, key, val))
        bad = (("mattermost", "MATTERMOST_URL", "ftp://mm.example.com"), ("mattermost", "MATTERMOST_URL", "https://u:p@mm.example.com"),
               ("mattermost", "MATTERMOST_URL", "https://mm.example.com?x=1"), ("mattermost", "MATTERMOST_URL", "mm.example.com"),
               ("mattermost", "MATTERMOST_BOT_TOKEN", "t"), ("mattermost", "MATTERMOST_ALLOW_ALL_USERS", "true"),
               ("mattermost", "MATTERMOST_ALLOWED_USERS", "*"), ("mattermost", "MATTERMOST_REQUIRE_MENTION", "false"))
        for plat, key, val in bad:
            self.assertTrue(owner_guard.channel_env_error(plat, key, val), (plat, key, val))
        self.assertEqual(owner_guard.channel_env_check("mattermost", "MATTERMOST_URL", "ftp://x")[0], "url_invalid")
        self.assertEqual(owner_guard.channel_clear_error("mattermost", "MATTERMOST_TOKEN"), "")

    def test_clear_follows_the_same_name_rule(self):
        self.assertEqual(owner_guard.channel_clear_error("telegram", "TELEGRAM_ALLOWED_USERS"), "")
        self.assertEqual(owner_guard.channel_clear_error("telegram", "TELEGRAM_BOT_TOKEN"), "")
        for key in ("HERMES_LLM_API_KEY", "OPENAI_API_KEY", "TELEGRAM_ALLOW_ALL_USERS", "DISCORD_BOT_TOKEN"):
            self.assertTrue(owner_guard.channel_clear_error("telegram", key), key)


class HiddenRootTest(unittest.TestCase):
    def test_owner_actions_on_the_hidden_root_are_refused_for_every_action(self):
        with mock.patch.object(primary, "is_target", return_value=True):
            for action in ("env_set", "env_clear", "config", "mcp", "rename", "delete", "channel_save", "soul", "skill", "toolset"):
                self.assertTrue(owner_guard.root_error("p1", primary.ROOT), action)
            self.assertEqual(owner_guard.root_error("p1", "main"), "")
        with mock.patch.object(primary, "is_target", return_value=False):           # 대상 기록이 없는 POD 는 루트가 유일한 프로파일일 수 있다
            self.assertEqual(owner_guard.root_error("p1", primary.ROOT), "")


BASE = """# 주석
model:
  default: cogentai-aas
  provider: custom
providers:
  litellm:
    base_url: http://litellm:4000
    api_key: ${HERMES_LLM_API_KEY}
auxiliary:
  title:
    model: cogentai-aas-aux
gateway:
  multiplex_profiles: true
terminal:
  backend: local
  cwd: /opt/data/workspace
  timeout: 120
skills:
  external_dirs: []
agent:
  max_turns: 40
"""


class ConfigLockTest(unittest.TestCase):
    def locked(self, new, old=BASE):
        return owner_guard.config_locked_keys(old, new)

    def test_unlocked_keys_may_change_and_comments_and_order_may_not_matter(self):
        self.assertEqual(self.locked(BASE.replace("max_turns: 40", "max_turns: 90").replace("timeout: 120", "timeout: 300")), [])
        reordered = BASE.replace("agent:\n  max_turns: 40\n", "").replace("terminal:", "agent:\n  max_turns: 40\nterminal:")
        self.assertEqual(self.locked("# 다른 주석\n" + reordered), [])

    def test_model_provider_auxiliary_and_gateway_keys_are_locked(self):
        for old, new, key in (("default: cogentai-aas", "default: gpt-x", "model"), ("base_url: http://litellm:4000", "base_url: https://api.openai.com", "providers"),
                              ("model: cogentai-aas-aux", "model: other", "auxiliary"), ("multiplex_profiles: true", "multiplex_profiles: false", "gateway")):
            self.assertEqual(self.locked(BASE.replace(old, new)), [key], key)
        self.assertEqual(self.locked(BASE + "fallback_providers: [openai]\n"), ["fallback_providers"])
        self.assertEqual(self.locked(BASE + "custom_providers:\n  x: {base_url: http://evil}\n"), ["custom_providers"])

    def test_terminal_backend_family_is_locked_but_the_rest_of_terminal_is_not(self):
        for line in ("backend: ssh", "docker_image: evil", "docker_volumes: [/:/host]", "singularity_image: x", "modal_image: x", "daytona_image: x", "vercel_runtime: x", "ssh_host: 10.0.0.5"):
            key, _, val = line.partition(": ")
            self.assertEqual(self.locked(BASE.replace("backend: local", f"backend: local\n  {line}" if key != "backend" else line)), [f"terminal.{key}"], line)
        self.assertEqual(self.locked(BASE.replace("cwd: /opt/data/workspace", "cwd: /opt/data/projects")), [])

    def test_authorization_keys_in_gateway_and_platforms_are_locked(self):
        for snippet in ("platforms:\n  telegram:\n    extra:\n      allow_from: ['*']\n", "platforms:\n  discord:\n    extra:\n      dm_policy: open\n",
                        "platforms:\n  slack:\n    extra:\n      group_allow_from: ['*']\n", "platforms:\n  telegram:\n    allowed_users: ['*']\n"):
            self.assertEqual(self.locked(BASE + snippet)[0].split(".")[0], "platforms", snippet)
        self.assertEqual(self.locked(BASE + "platforms:\n  telegram:\n    extra:\n      reply_to_mode: first\n"), [])         # 인가와 무관한 키

    def test_approvals_block_is_locked(self):
        # 스펙 2026-10-24-001 D2(OMAI-1460): 주인·팀 관리자는 승인 설정을 끄거나 바꾸지 못한다(관리자만). 우회 가능한 편의 잠금이다
        self.assertEqual(self.locked(BASE + "approvals:\n  mode: \"off\"\n"), ["approvals"])
        with_rules = BASE + "approvals:\n  mode: smart\n  deny: ['git push --force*']\n"
        self.assertEqual(self.locked(with_rules.replace("deny: ['git push --force*']", "deny: []"), with_rules), ["approvals"])
        self.assertEqual(self.locked(with_rules, with_rules), [])

    def test_yaml_anchors_cannot_hide_a_locked_change(self):
        tricky = BASE.replace("auxiliary:\n  title:\n    model: cogentai-aas-aux", "x: &m other\nauxiliary:\n  title:\n    model: *m")
        self.assertEqual(self.locked(tricky), ["auxiliary"])

    def test_removing_a_locked_key_counts_as_a_change(self):
        self.assertEqual(self.locked(BASE.replace("auxiliary:\n  title:\n    model: cogentai-aas-aux\n", "")), ["auxiliary"])

    def test_external_dirs_must_stay_under_the_data_folder(self):
        ok = BASE.replace("external_dirs: []", "external_dirs: [/opt/data/profiles/main/skills]")
        self.assertEqual(owner_guard.config_dirs_error(ok), "")
        for bad in ("/etc", "/opt/data/../etc", "/opt/datax/skills", "relative/skills", "~/skills", "/opt/data/../../root"):
            self.assertTrue(owner_guard.config_dirs_error(BASE.replace("external_dirs: []", f"external_dirs: ['{bad}']")), bad)

    def test_config_error_names_the_locked_keys_and_passes_unparsable_text_to_the_normal_check(self):
        msg = owner_guard.config_error(BASE, BASE.replace("default: cogentai-aas", "default: x").replace("backend: local", "backend: ssh"))
        self.assertIn("model", msg); self.assertIn("terminal.backend", msg)
        self.assertEqual(owner_guard.config_error(BASE, "a: [unclosed"), "")           # 형식 오류는 _text_problem 이 가린다
        self.assertEqual(owner_guard.config_error(BASE, BASE), "")


# ---- MCP 서버 추가·삭제·카탈로그(스펙 2026-10-15-025) ------------------------------------------------------------------------------------------------
import yaml  # noqa: E402

from aas.assets.files import FileError  # noqa: E402
from aas.hermes.hermes_api import HermesError  # noqa: E402
from aas.ops import mcp_servers  # noqa: E402


class FakeAPI:
    """Hermes 대시보드 API 의 MCP·환경변수 부분. fail[(메서드, 경로)] 에 HermesError 를 두면 그 호출이 실패한다."""

    def __init__(self):
        self.servers: dict = {None: [], "ma": []}                     # 프로파일 → 서버 요약 목록
        self.env: dict = {}
        self.fail: dict = {}
        self.calls: list = []
        self.catalog_rows: list = []
        self.timeouts: list = []

    def call(self, method, path, body=None, query=None, timeout=30):
        prof = (query or {}).get("profile")
        self.calls.append((method, path, prof, body))
        self.timeouts.append(timeout)
        hit = self.fail.get((method, path.split("?")[0])) or next((v for (m, p), v in self.fail.items() if m == method and p != path and path.startswith(p) and p.endswith("*")), None)
        if hit:
            raise hit
        if path == "/api/mcp/servers" and method == "GET":
            return {"servers": list(self.servers.get(prof, []))}
        if path == "/api/mcp/servers" and method == "POST":
            if any(r["name"] == body["name"] for r in self.servers.setdefault(prof, [])):
                raise HermesError("Server exists", 409)
            self.servers[prof].append({"name": body["name"], "transport": "http" if body.get("url") else "stdio", "enabled": True})
            return {}
        if path.startswith("/api/mcp/servers/") and method == "DELETE":
            name = path.rsplit("/", 1)[1]
            before = len(self.servers.get(prof, []))
            self.servers[prof] = [r for r in self.servers.get(prof, []) if r["name"] != name]
            if len(self.servers[prof]) == before:
                raise HermesError("not found", 404)
            return {"ok": True}
        if path == "/api/env" and method == "GET":
            return {"SERPER_API_KEY": {"is_set": False, "category": "tool"}, **{k: {"is_set": True, "category": "tool"} for k in self.env}}   # 실제 Hermes 는 카탈로그 전체를 준다
        if path == "/api/env" and method == "PUT":
            self.env[body["key"]] = body["value"]
            return {}
        if path == "/api/env" and method == "DELETE":
            if body["key"] not in self.env:
                raise HermesError("not found", 404)
            del self.env[body["key"]]
            return {}
        if path == "/api/mcp/catalog":
            return {"entries": self.catalog_rows, "diagnostics": []}
        if path == "/api/mcp/catalog/install":
            return {"ok": True}
        raise AssertionError((method, path))


def stdio(name, enabled=True):
    return {"name": name, "transport": "stdio", "enabled": enabled}


STDIO = {"kind": "stdio", "server": "mem", "command": "uvx", "args": ["mcp-server-time"], "env": {"API_TOKEN": "s3cret-value"}}
URL = {"kind": "url", "server": "docs", "url": "https://example.com/mcp", "auth": "none"}


def add(api, body, *, owner=False, secure=True, prof="ma", profs=(None, "ma")):
    return mcp_servers.add(api, prof, body, owner=owner, secure=secure, profs=list(profs))


class McpNameTest(unittest.TestCase):
    def test_server_key_matches_the_way_hermes_names_the_token_variable(self):
        self.assertEqual(mcp_servers.server_key("my-api"), "MY_API")
        self.assertEqual(mcp_servers.server_key("x-"), "X")                     # Hermes 는 앞뒤 _ 를 뗀다
        self.assertEqual(mcp_servers.server_key("My.Api"), "MY_API")

    def test_names_that_collapse_to_the_same_key_are_refused(self):
        for new, old in (("my_api", "my-api"), ("My-Api", "my-api"), ("x", "x-"), ("x-", "x")):
            with self.assertRaises(FileError, msg=(new, old)) as ctx:
                mcp_servers.check_name(new, [old])
            self.assertEqual((ctx.exception.reason, ctx.exception.field), ("name_exists", "name"))

    def test_format_and_double_underscore(self):
        for bad in ("", "-a", "a b", "a.b", "a" * 42, "a__b"):
            with self.assertRaises(FileError, msg=bad) as ctx:
                mcp_servers.check_name(bad, [])
            self.assertEqual(ctx.exception.reason, "name_format", bad)
        self.assertEqual(mcp_servers.check_name("ok-1_a", ["other"]), "OK_1_A")


class McpAddTest(unittest.TestCase):
    def test_remote_server_goes_to_hermes_and_the_token_is_only_sent_as_bearer_token(self):
        api = FakeAPI()
        out = add(api, {**URL, "auth": "header", "bearer_token": "tok-1"})
        self.assertEqual((out["ok"], out["kind"], out["env_written"]), (True, "url", 0))
        post = next(c for c in api.calls if c[0] == "POST")
        self.assertEqual(post[3]["bearer_token"], "tok-1")
        self.assertEqual(api.env, {})                                            # .env 는 Hermes 가 쓴다 — AAS 는 쓰지 않는다

    def test_oauth_server_is_added_without_a_token_and_needs_no_encrypted_request(self):
        api = FakeAPI()
        self.assertTrue(add(api, {**URL, "auth": "oauth", "bearer_token": "ignored"}, secure=False)["ok"])   # 토큰은 로그인으로 받는다(T5·V9)
        post = next(c for c in api.calls if c[0] == "POST")
        self.assertEqual(post[3]["auth"], "oauth")
        self.assertNotIn("bearer_token", post[3])
        with self.assertRaises(FileError) as ctx:
            add(FakeAPI(), {**URL, "auth": "basic"})
        self.assertEqual(ctx.exception.reason, "auth_format")

    def test_address_this_installation_cannot_reach_is_refused_and_only_an_admin_can_force_it(self):
        from unittest import mock
        with mock.patch.dict("os.environ", {"AAS_NETWORK_MODE": "airgap"}):
            for owner in (True, False):
                with self.assertRaises(FileError, msg=owner) as ctx:
                    add(FakeAPI(), {**URL, "url": "https://mcp.example.com/mcp"}, owner=owner)
                self.assertEqual((ctx.exception.code, ctx.exception.reason, ctx.exception.field), (403, "network_airgap", "url"))
            with self.assertRaises(FileError):
                add(FakeAPI(), {**URL, "url": "https://mcp.example.com/mcp", "force": True}, owner=True)       # 주인은 force 해도 안 된다(Q7)
            api = FakeAPI()
            out = mcp_servers.add(api, "ma", {**URL, "url": "https://mcp.example.com/mcp", "force": True}, owner=False, secure=True,
                                  profs=[None, "ma"], pod="og-p", by="admin@x", profile="ma")
            self.assertTrue(out["ok"] and out["forced"])
            self.assertEqual(mcp_servers.forced_servers("og-p", "ma")["docs"]["reason"], "airgap")      # 행에 「판정과 다르게 추가함」(V16)
            mcp_servers.remove(api, "ma", "docs", "", pod="og-p", profile="ma")
            self.assertEqual(mcp_servers.forced_servers("og-p", "ma"), {})                                 # 지우면 기록도 지운다
            self.assertTrue(add(FakeAPI(), {**URL, "url": "http://mcp.corp.svc:8080/mcp"}, owner=True)["ok"])   # 사내 주소는 된다

    def test_secrets_need_an_encrypted_request(self):
        for body in ({**URL, "auth": "header", "bearer_token": "t"}, STDIO):
            api = FakeAPI()
            with self.assertRaises(FileError) as ctx:
                add(api, body, secure=False)
            self.assertEqual((ctx.exception.code, ctx.exception.reason), (403, "insecure"))
            self.assertFalse([c for c in api.calls if c[0] in ("POST", "PUT")])
        self.assertTrue(add(FakeAPI(), URL, secure=False)["ok"])                  # 비밀이 없으면 http 화면에서도 된다

    def test_stdio_env_values_go_to_dotenv_and_the_config_only_gets_references(self):
        api = FakeAPI()
        out = add(api, STDIO)
        self.assertEqual(out["env_written"], 1)
        (var, value), = api.env.items()
        self.assertRegex(var, r"^MCP_MEM__API_TOKEN__[0-9A-F]{4}$")
        self.assertEqual(value, "s3cret-value")
        post = next(c for c in api.calls if c[0] == "POST")
        self.assertEqual(post[3]["env"], {"API_TOKEN": "${" + var + "}"})
        self.assertNotIn("s3cret-value", repr(post[3]))                           # 설정에 가는 본문에는 값이 없다 → mask_line 이 설정 탭을 잠그지 않는다

    def test_values_that_look_like_tokens_still_stay_out_of_the_config_so_the_yaml_tab_stays_editable(self):
        from aas.assets.files import mask_line
        api = FakeAPI()
        add(api, {**STDIO, "env": {"GH": "ghp_" + "a" * 36, "KEY": "sk-" + "b" * 30}})
        post = next(c for c in api.calls if c[0] == "POST")
        text = yaml.safe_dump({"mcp_servers": {"mem": post[3]}})
        self.assertEqual(mask_line(text), text)

    def test_secret_like_text_in_the_address_or_arguments_is_refused(self):
        for body in ({**URL, "url": "https://example.com/mcp?token=abcdef1234567890abcdef"},
                     {**STDIO, "env": {}, "args": ["--key", "ghp_" + "a" * 36]}):
            with self.assertRaises(FileError) as ctx:
                add(FakeAPI(), body)
            self.assertEqual(ctx.exception.reason, "secret_like")

    def test_env_names_and_urls_are_checked(self):
        for body, field in (({**STDIO, "env": {"a_b": "x"}}, "env"), ({**STDIO, "env": {"A__B": "x"}}, "env"), ({**STDIO, "env": {"_A": "x"}}, "env"),
                            ({**URL, "url": "ftp://x"}, "url"), ({**STDIO, "command": "npx -y"}, "command"), ({"kind": "other", "server": "x"}, "kind")):
            with self.assertRaises(FileError, msg=body) as ctx:
                add(FakeAPI(), body)
            self.assertEqual(ctx.exception.field, field)

    def test_same_key_is_refused_before_anything_is_written(self):
        api = FakeAPI()
        api.servers["ma"] = [{"name": "MEM-", "transport": "http", "enabled": True}]
        with self.assertRaises(FileError) as ctx:
            add(api, STDIO)
        self.assertEqual(ctx.exception.reason, "name_exists")
        self.assertEqual(api.env, {})

    def test_unreadable_list_refuses(self):
        api = FakeAPI()
        api.fail[("GET", "/api/mcp/servers")] = HermesError("down", 503)
        with self.assertRaises(FileError) as ctx:
            add(api, URL)
        self.assertEqual(ctx.exception.reason, "list_unreadable")

    def test_owner_cannot_use_a_variable_the_catalog_forbids_but_normal_names_pass(self):
        self.assertTrue(add(FakeAPI(), STDIO, owner=True)["ok"])
        api = FakeAPI()
        with mock.patch.object(owner_guard, "catalog_of", return_value=None):         # 변수 목록을 못 읽으면 거절(fail-closed)
            with self.assertRaises(FileError) as ctx:
                add(api, STDIO, owner=True)
        self.assertEqual(ctx.exception.reason, "list_unreadable")
        self.assertEqual(api.env, {})

    def test_clear_refusal_from_hermes_removes_the_lines_written_in_this_request(self):
        for code in (400, 409):
            api = FakeAPI()
            api.env["OTHER"] = "keep"
            api.fail[("POST", "/api/mcp/servers")] = HermesError("Server 'mem' rejected: suspicious command/args configuration" if code == 400 else "exists", code)
            with self.assertRaises(HermesError) as ctx:
                add(api, STDIO)
            self.assertEqual(api.env, {"OTHER": "keep"}, code)
            self.assertEqual(ctx.exception.code, code)
        self.assertEqual(ctx.exception.reason, "name_exists")

    def test_unsafe_command_message_is_plain_language(self):
        api = FakeAPI()
        api.fail[("POST", "/api/mcp/servers")] = HermesError("Server 'bad' rejected: MCP server uses shell interpreter 'bash' with network egress in args", 400)
        with self.assertRaises(HermesError) as ctx:
            add(api, {**STDIO, "env": {}})
        self.assertEqual(ctx.exception.reason, "unsafe")

    def test_timeout_keeps_the_lines_when_the_server_was_saved_and_clears_them_when_it_was_not(self):
        api = FakeAPI()
        def saved_then_timeout(method, path, body=None, query=None, timeout=30, _orig=api.call):
            if (method, path) == ("POST", "/api/mcp/servers"):
                api.servers["ma"].append(stdio("mem"))
                raise HermesError("slow", 504, "timeout")
            return _orig(method, path, body, query, timeout)
        api.call = saved_then_timeout
        out = add(api, STDIO)
        self.assertEqual(out["warn"], "slow_save")
        self.assertEqual(len(api.env), 1)                                         # 저장됐으므로 비밀값 줄을 남긴다
        api2 = FakeAPI()
        api2.fail[("POST", "/api/mcp/servers")] = HermesError("slow", 504, "timeout")
        with self.assertRaises(HermesError):
            add(api2, STDIO)
        self.assertEqual(api2.env, {})                                            # 저장되지 않았으므로 지운다

    def test_timeout_with_an_unreadable_list_keeps_the_lines_and_says_so(self):
        api = FakeAPI()
        api.fail[("POST", "/api/mcp/servers")] = HermesError("slow", 504, "timeout")
        orig = api.call
        state = {"posted": False}
        def call(method, path, body=None, query=None, timeout=30):
            if (method, path) == ("POST", "/api/mcp/servers"):
                state["posted"] = True
            if (method, path) == ("GET", "/api/mcp/servers") and state["posted"]:
                raise HermesError("down", 503)
            return orig(method, path, body, query, timeout)
        api.call = call
        with self.assertRaises(HermesError) as ctx:
            add(api, STDIO)
        self.assertEqual(len(api.env), 1)
        self.assertIn("1", str(ctx.exception))

    def test_two_requests_for_the_same_name_never_share_a_variable(self):
        a, b = FakeAPI(), FakeAPI()
        names = set()
        for api in (a, b):
            add(api, {**STDIO, "env": {"T": "x"}})
            names |= set(api.env)
        self.assertEqual(len(names), 2) if len(names) != 1 else None             # 4자리 무작위라 드물게 같을 수 있다 — 같은 파드에서는 이미 있는 변수와 겹치면 다시 뽑는다
        shared = FakeAPI()
        shared.servers["ma"] = []
        add(shared, {**STDIO, "env": {"T": "x"}})
        first = set(shared.env)
        shared.servers["ma"] = []
        add(shared, {**STDIO, "env": {"T": "y"}})
        self.assertEqual(len(shared.env), 2)
        self.assertTrue(first < set(shared.env))


class McpLimitTest(unittest.TestCase):
    def test_enabled_stdio_servers_across_profiles_are_counted_remote_and_disabled_are_not(self):
        api = FakeAPI()
        limit = mcp_servers.stdio_limit()
        api.servers[None] = [stdio(f"a{i}") for i in range(limit - 1)] + [{"name": "r", "transport": "http", "enabled": True}] * 5
        api.servers["ma"] = [stdio("off", enabled=False)]
        self.assertTrue(add(api, {**STDIO, "env": {}})["ok"])                     # limit-1 개 + 새 것 = limit 까지는 된다
        self.assertEqual(mcp_servers.stdio_enabled(api, [None, "ma"]), limit)
        with self.assertRaises(FileError) as ctx:
            add(api, {**STDIO, "server": "more", "env": {}})
        self.assertEqual((ctx.exception.code, ctx.exception.reason), (409, "mcp_limit"))
        self.assertTrue(add(api, {**URL, "server": "remote2"})["ok"])             # 원격 주소 서버는 상한과 무관하다

    def test_cannot_read_a_profile_means_refuse(self):
        api = FakeAPI()
        orig = api.call
        def call(method, path, body=None, query=None, timeout=30):
            if method == "GET" and path == "/api/mcp/servers" and (query or {}).get("profile") is None:
                raise HermesError("down", 503)
            return orig(method, path, body, query, timeout)
        api.call = call
        with self.assertRaises(FileError) as ctx:
            add(api, {**STDIO, "env": {}})
        self.assertEqual(ctx.exception.reason, "list_unreadable")

    def test_turning_a_stdio_server_on_is_checked_too_but_remote_and_already_on_are_not(self):
        api = FakeAPI()
        api.servers["ma"] = [stdio(f"s{i}") for i in range(mcp_servers.stdio_limit())] + [stdio("off", enabled=False), {"name": "rem", "transport": "http", "enabled": False}]
        with self.assertRaises(FileError) as ctx:
            mcp_servers.enable_error(api, "ma", "off", [None, "ma"])
        self.assertEqual(ctx.exception.reason, "mcp_limit")
        mcp_servers.enable_error(api, "ma", "rem", [None, "ma"])
        mcp_servers.enable_error(api, "ma", "s1", [None, "ma"])


class McpRemoveTest(unittest.TestCase):
    CONFIG = yaml.safe_dump({"mcp_servers": {
        "mem": {"command": "uvx", "env": {"A": "${MCP_MEM__A__1111}", "SHARED": "${MCP_SHARED__X}"}},
        "web": {"url": "https://x", "headers": {"Authorization": "Bearer ${MCP_WEB_API_KEY}"}},
        "other": {"command": "npx", "env": {"S": "${MCP_SHARED__X}", "G": "${GITHUB_TOKEN}"}}}})

    def api(self, **env):
        api = FakeAPI()
        api.servers["ma"] = [stdio("mem"), {"name": "web", "transport": "http", "enabled": True}, stdio("other")]
        api.env.update({"MCP_MEM__A__1111": "1", "MCP_SHARED__X": "2", "MCP_WEB_API_KEY": "3", "GITHUB_TOKEN": "4", **env})
        return api

    def test_removes_only_the_secret_lines_no_other_server_uses(self):
        api = self.api()
        out = mcp_servers.remove(api, "ma", "mem", self.CONFIG)
        self.assertEqual((out["env_cleared"], out["env_left"]), (1, 0))
        self.assertEqual(sorted(api.env), ["GITHUB_TOKEN", "MCP_SHARED__X", "MCP_WEB_API_KEY"])      # 공유 변수·MCP_ 가 아닌 변수는 남는다

    def test_bearer_variable_goes_with_its_server(self):
        api = self.api()
        mcp_servers.remove(api, "ma", "web", self.CONFIG)
        self.assertNotIn("MCP_WEB_API_KEY", api.env)

    def test_already_missing_lines_count_as_cleared_and_failures_are_reported(self):
        api = self.api()
        del api.env["MCP_MEM__A__1111"]
        self.assertEqual(mcp_servers.remove(api, "ma", "mem", self.CONFIG)["env_left"], 0)
        api = self.api()
        api.fail[("DELETE", "/api/env")] = HermesError("boom", 500)
        out = mcp_servers.remove(api, "ma", "web", self.CONFIG)
        self.assertEqual((out["env_cleared"], out["env_left"]), (0, 1))
        self.assertNotIn("web", [r["name"] for r in api.servers["ma"]])

    def test_missing_server_is_a_404_and_touches_no_env(self):
        api = self.api()
        with self.assertRaises(HermesError) as ctx:
            mcp_servers.remove(api, "ma", "ghost", self.CONFIG)
        self.assertEqual(ctx.exception.code, 404)
        self.assertEqual(len(api.env), 4)

    def test_unreadable_config_still_removes_the_server(self):
        api = self.api()
        self.assertEqual(mcp_servers.remove(api, "ma", "mem", "::not yaml::: [")["env_cleared"], 0)


class McpCatalogTest(unittest.TestCase):
    ROWS = [
        {"name": "ctx", "auth_type": "none", "needs_install": False, "transport": "http", "description": "docs"},
        {"name": "gh", "auth_type": "oauth", "needs_install": False, "transport": "http"},
        {"name": "linear", "auth_type": "oauth", "needs_install": False, "transport": "http", "url": "https://mcp.linear.example/mcp"},
        {"name": "gdrive", "auth_type": "oauth", "needs_install": False, "transport": "stdio"},
        {"name": "n8n", "auth_type": "api_key", "needs_install": True, "transport": "stdio"},
        {"name": "key", "auth_type": "api_key", "needs_install": False, "transport": "stdio", "required_env": [{"name": "KEY_TOKEN", "prompt": "키", "required": True}]},
        {"name": "weird", "auth_type": "saml", "needs_install": False, "transport": "http"},
        {"name": "nofield", "needs_install": False, "transport": "http"},
    ]

    def api(self):
        api = FakeAPI()
        api.catalog_rows = list(self.ROWS)
        return api

    def test_oauth_install_and_unknown_auth_are_hidden_and_counted(self):
        out = mcp_servers.catalog(self.api(), "ma")
        self.assertEqual([e["name"] for e in out["entries"]], ["docmost", "outline", "ctx", "linear", "key"])   # 원격 주소 OAuth 는 보인다(스펙 2026-10-16-010 Q5). AAS 의 Docmost·Outline 항목이 맨 앞(2026-10-23-002 12-6, 2026-10-23-004)
        self.assertEqual(out["hidden"], {"oauth": 2, "install": 1, "unknown": 2})            # 주소 없는·stdio OAuth 는 숨긴다. 인증 방식 필드가 없거나 모르면 숨긴다
        linear = next(e for e in out["entries"] if e["name"] == "linear")
        self.assertEqual((linear["auth_type"], linear["network"]["verdict"]), ("oauth", "external"))

    def test_remote_oauth_entry_installs_but_not_where_its_address_is_unreachable(self):
        self.assertTrue(mcp_servers.install(self.api(), "ma", {"server": "linear"}, owner=True, secure=False, profs=[None, "ma"])["ok"])
        with mock.patch.dict(os.environ, {"AAS_NETWORK_MODE": "airgap"}):
            with self.assertRaises(FileError) as ctx:
                mcp_servers.install(self.api(), "ma", {"server": "linear"}, owner=False, secure=True, profs=[None, "ma"])
        self.assertEqual(ctx.exception.reason, "network_airgap")
        with mock.patch.dict(os.environ, {"AAS_NETWORK_MODE": "airgap"}):
            names = [e["name"] for e in mcp_servers.catalog(self.api(), "ma")["entries"]]
        self.assertEqual(names[-1], "linear")                                     # 쓸 수 없는 항목은 끝으로(14-10)

    def test_install_refuses_hidden_entries_and_undeclared_variables(self):
        for body in ({"server": "gh"}, {"server": "gdrive"}, {"server": "n8n"}, {"server": "weird"}, {"server": "nofield"}, {"server": "ghost"},
                     {"server": "key", "env": {"KEY_TOKEN": "v", "OTHER": "x"}}, {"server": "key", "env": {}}):
            with self.assertRaises(FileError, msg=body):
                mcp_servers.install(self.api(), "ma", body, owner=False, secure=True, profs=[None, "ma"])

    def test_install_sends_only_declared_variables_and_needs_a_secure_request(self):
        api = self.api()
        with self.assertRaises(FileError) as ctx:
            mcp_servers.install(api, "ma", {"server": "key", "env": {"KEY_TOKEN": "v"}}, owner=False, secure=False, profs=[None, "ma"])
        self.assertEqual(ctx.exception.reason, "insecure")
        out = mcp_servers.install(api, "ma", {"server": "key", "env": {"KEY_TOKEN": "v"}}, owner=False, secure=True, profs=[None, "ma"])
        self.assertEqual(out["env_written"], 1)
        self.assertEqual(api.calls[-1][3], {"name": "key", "env": {"KEY_TOKEN": "v"}, "enable": True, "profile": "ma"})
        self.assertTrue(mcp_servers.install(api, "ma", {"server": "ctx"}, owner=True, secure=False, profs=[None, "ma"])["ok"])   # 비밀이 없으면 http 에서도

    def test_install_of_a_stdio_entry_respects_the_limit_but_a_remote_one_does_not(self):
        api = self.api()
        api.servers["ma"] = [stdio(f"s{i}") for i in range(mcp_servers.stdio_limit())]
        with self.assertRaises(FileError) as ctx:
            mcp_servers.install(api, "ma", {"server": "key", "env": {"KEY_TOKEN": "v"}}, owner=False, secure=True, profs=[None, "ma"])
        self.assertEqual(ctx.exception.reason, "mcp_limit")
        self.assertTrue(mcp_servers.install(api, "ma", {"server": "ctx"}, owner=False, secure=True, profs=[None, "ma"])["ok"])


if __name__ == "__main__":
    unittest.main()

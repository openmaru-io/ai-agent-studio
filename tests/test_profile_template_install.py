# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""프로파일 템플릿 설치 쪽 시험(스펙 2026-11-18-002 1단계) — 설치 때 검사(R1·D4·E9·E10), 템플릿 전용 config 합치기(E1·E16),
줄에 선 설치까지 세는 프로파일 한도(E7), 숨긴 패키지 거절(E5), 템플릿 설치 줄의 KEY 이름·기다리는 MCP 기록, KEY 가 찬 MCP 고르기."""
import io
import json
import os
import tarfile
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest import mock

import yaml

TMP = tempfile.TemporaryDirectory()
os.environ.setdefault("AAS_DATA_DIR", str(Path(TMP.name) / "data"))

from aas.market import market_dispatch, market_stage as ms, marketplace as mk, template_checks as tc, templates  # noqa: E402


def zipped(files: dict) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        for name, text in files.items():
            z.writestr(name, text)
    return buf.getvalue()


MAIN = yaml.safe_dump({"model": {"default": "openmaru-cogentai", "provider": "custom"}, "telegram": {"allowed_users": "1"},
                       "mcp_servers": {"mine": {"url": "https://a.example/mcp", "headers": {"Authorization": "Bearer ${MINE_TOKEN}"}}},
                       "skills": {"disabled": ["x"], "external_dirs": ["/opt/data/shared"]}, "toolsets": ["web"]})
TEMPLATE_CONFIG = yaml.safe_dump({"model": {"default": "other"}, "toolsets": ["web", "file"],
                                  "mcp_servers": {"jira": {"url": "https://jira.example/mcp", "headers": {"Authorization": "Bearer ${JIRA_TOKEN}"}},
                                                  "plain": {"url": "https://docs.example/mcp"},
                                                  "off": {"url": "https://off.example/mcp", "headers": {"X": "${JIRA_TOKEN}"}, "enabled": False}}})


def template_pkg(config=TEMPLATE_CONFIG, env=None, extra=None, aas=None):
    env = env if env is not None else [{"name": "JIRA_TOKEN", "description": "JIRA 토큰"}]
    manifest = {"name": "sales", "version": "1.2.0", "description": "영업", "env_requires": env, "aas": aas if aas is not None else {"template": 1}}
    files = {"SKILL.md": "---\nname: sales\n---\n", "agent/distribution.yaml": yaml.safe_dump(manifest, allow_unicode=True), "agent/SOUL.md": "나는 영업 도우미",
             "agent/config.yaml": config, "agent/cron/jobs.json": "[]", "template/AGENTS.md": "지침", "template/files/견적서.xlsx": "xx"}
    files.update(extra or {})
    return files


REQ = {"id": "20261118090000000000-abcdef", "namespace": "paid", "name": "sales", "package": "paid/sales", "version": "1.2.0", "profile": "sales",
       "container": "hermes", "kind": "agent", "mode": "install", "pod": "p1"}


class ChecksTest(unittest.TestCase):
    def ok(self, config, env=("JIRA_TOKEN",), ns="paid", consents=None, files=()):
        return tc.check(ns, config, "[]", list(env), list(files), consents)

    def refused(self, code, *a, **kw):
        with self.assertRaises(tc.CheckError) as cm:
            self.ok(*a, **kw)
        self.assertEqual(cm.exception.code, code)
        return str(cm.exception)

    def test_reference_must_be_listed_and_not_blocked(self):
        self.ok(TEMPLATE_CONFIG)
        self.refused("env_ref_blocked", TEMPLATE_CONFIG, env=())
        leak = yaml.safe_dump({"mcp_servers": {"x": {"url": "https://x.example/mcp", "headers": {"A": "${LITELLM_API_KEY}"}}}})
        self.assertIn("LITELLM_API_KEY", self.refused("env_ref_blocked", leak, env=("LITELLM_API_KEY",)))
        self.refused("env_ref_blocked", yaml.safe_dump({"mcp_servers": {"x": {"url": "https://x/m", "env": {"A": "${OPENAI_BASE_URL}"}}}}), env=("OPENAI_BASE_URL",))

    def test_host_part_cannot_hold_a_reference(self):
        cfg = yaml.safe_dump({"mcp_servers": {"x": {"url": "https://${JIRA_TOKEN}.evil.example/mcp"}}})
        self.refused("env_ref_host", cfg)
        self.ok(yaml.safe_dump({"mcp_servers": {"x": {"url": "https://x.example/mcp?key=${JIRA_TOKEN}"}}}))   # 경로·쿼리는 된다(가리기는 §4-5)

    def test_stdio_rules(self):
        pinned = {"mcp_servers": {"fs": {"command": "npx", "args": ["-y", "@scope/server-fs@1.2.3"], "env": {"T": "${JIRA_TOKEN}"}}}}
        cfg = yaml.safe_dump(pinned)
        h = tc.consent_hash("npx", ["-y", "@scope/server-fs@1.2.3"])
        self.assertEqual(self.ok(cfg, consents=[h])["stdio"][0]["consent_hash"], h)
        self.refused("stdio_public", cfg, ns="free", consents=[h])
        self.refused("consent_required", cfg, consents=[])
        self.refused("consent_mismatch", cfg, consents=["0" * 64])
        self.ok(cfg)                                                                       # 동의를 묻지 않는 길(올리기)은 검사만
        for args in (["-y", "@scope/server-fs"], ["-y", "-p", "evil@1.0.0", "@scope/server-fs@1.2.3"], ["@a/b@1.0.0", "extra"], ["${JIRA_TOKEN}@1.0.0"]):
            bad = yaml.safe_dump({"mcp_servers": {"fs": {"command": "npx", "args": args}}})
            self.refused("stdio_unpinned", bad)
        self.refused("stdio_unpinned", yaml.safe_dump({"mcp_servers": {"d": {"command": "docker", "args": ["run", "img@sha256:" + "a" * 64]}}}))
        self.ok(yaml.safe_dump({"mcp_servers": {"u": {"command": "uvx", "args": ["mcp-server-time==0.6.2"]}}}), consents=[tc.consent_hash("uvx", ["mcp-server-time==0.6.2"])])
        self.ok(yaml.safe_dump({"mcp_servers": {"p": {"command": "pipx", "args": ["run", "mcp-x==1.0"]}}}), consents=[tc.consent_hash("pipx", ["run", "mcp-x==1.0"])])

    def test_template_file_paths(self):
        self.ok("", env=(), files=["template/files/a/b.txt"])
        for bad in ("template/files/.env", "template/files/a/../../x", "template/files/.hermes/x", "template/files/a/config.yaml"):
            self.refused("file_path", "", env=(), files=[bad])
        self.refused("files_too_many", "", env=(), files=[f"template/files/f{i}.txt" for i in range(31)])

    def test_old_mcp_json_is_checked_too(self):
        with self.assertRaises(tc.CheckError):
            tc.check("paid", "", "", [], [], None, json.dumps({"mcpServers": {"x": {"url": "https://x/m", "headers": {"A": "${LITELLM_API_KEY}"}}}}))


class MergeTest(unittest.TestCase):
    def test_template_only_merge_keeps_main_model_and_drops_main_mcp_and_channels(self):
        text, waiting = tc.merge_config(MAIN, TEMPLATE_CONFIG, ["JIRA_TOKEN"])
        cfg = yaml.safe_load(text)
        self.assertEqual(cfg["model"]["default"], "openmaru-cogentai")             # 받는 사람 모델(템플릿 model 은 담지 않는다)
        self.assertNotIn("telegram", cfg)                                          # main 채널은 새 프로파일에 없다
        self.assertNotIn("mine", cfg["mcp_servers"])                               # main 의 MCP·인증 헤더가 복사되지 않는다(E1)
        self.assertEqual(cfg["toolsets"], ["web", "file"])
        self.assertIs(cfg["mcp_servers"]["jira"]["enabled"], False)                # KEY 를 쓰는 MCP 는 꺼진 채로(R13)
        self.assertNotIn("enabled", cfg["mcp_servers"]["plain"])
        self.assertEqual(waiting, ["jira"])                                         # 만든 사람이 꺼 둔 off 는 기다리지 않는다
        self.assertNotIn("external_dirs", cfg.get("skills") or {})
        self.assertNotIn("disabled", cfg.get("skills") or {})

    def test_ready_servers_need_every_key(self):
        servers = {"jira": {"url": "u", "headers": {"A": "${JIRA_TOKEN}", "B": "${JIRA_USER}"}, "enabled": False}, "on": {"url": "u", "headers": {"A": "${JIRA_TOKEN}"}}}
        self.assertEqual(tc.ready_servers(servers, ["jira", "on"], {"JIRA_TOKEN"}), [])
        self.assertEqual(tc.ready_servers(servers, ["jira", "on"], {"JIRA_TOKEN", "JIRA_USER"}), ["jira"])


class StageTest(unittest.TestCase):
    def setUp(self):
        self.home = Path(tempfile.mkdtemp(dir=TMP.name))
        (self.home / "profiles" / "main").mkdir(parents=True)

    def prepare(self, files, req=None, main=MAIN):
        if main is not None:
            (self.home / "profiles" / "main" / "config.yaml").write_text(main, encoding="utf-8")
        def download(r, dest):
            return ms.extract(zipped(files), dest, {})
        with mock.patch.object(ms, "download", download), mock.patch("aas.fleet.primary.primary_of", return_value="main"):
            return ms.prepare(req or REQ, self.home, None)

    def unpack(self, res):
        import base64
        with tarfile.open(fileobj=io.BytesIO(base64.b64decode(res["payload"]))) as tar:
            return {m.name: (tar.extractfile(m).read().decode() if m.isfile() else None) for m in tar.getmembers()}

    def test_template_install_merges_config_and_reports_names(self):
        res = self.prepare(template_pkg())
        got = self.unpack(res)
        cfg = yaml.safe_load(got["config.yaml"])
        self.assertEqual(cfg["model"]["default"], "openmaru-cogentai")
        self.assertIs(cfg["mcp_servers"]["jira"]["enabled"], False)
        self.assertNotIn("mine", cfg["mcp_servers"])
        self.assertFalse(any(k.startswith("template") for k in got))              # 참고 파일·AGENTS.md 는 Hermes 묶음에 없다
        self.assertEqual(res["template"], {"template": "paid/sales", "template_version": "1.2.0", "env_names": ["JIRA_TOKEN"], "waiting_mcp": ["jira"], "examples": []})
        res = self.prepare(template_pkg(aas={"template": 1, "examples": ["견적을 정리해 줘"]}))
        self.assertEqual(res["template"]["examples"], ["견적을 정리해 줘"])          # 첫 대화 빈 화면의 예시는 설치 기록에 남긴다

    def test_published_template_with_llm_env_does_not_wait_on_it(self):
        """이미 게시된 템플릿의 env_requires 에 LLM 접속값이 있어도 설치 기록 env_names 에 넣지 않는다(스펙 2026-11-19-002 §4-2 #9)."""
        cfg = yaml.safe_dump({"mcp_servers": {"llm": {"url": "https://l.example/mcp", "headers": {"A": "${LLM_API_KEY}"}}}})
        res = self.prepare(template_pkg(config=cfg, env=[{"name": "LLM_API_KEY"}, {"name": "LLM_BASE_URL"}, {"name": "JIRA_TOKEN"}]))
        self.assertEqual(res["template"]["env_names"], ["JIRA_TOKEN"])

    def test_template_without_main_config_is_refused(self):
        with self.assertRaises(ms.Refuse) as cm:
            self.prepare(template_pkg(), main=None)
        self.assertEqual(cm.exception.code, "main_config_missing")

    def test_checks_run_on_the_downloaded_body_for_every_agent_package(self):
        leak = yaml.safe_dump({"mcp_servers": {"x": {"url": "https://x.example/mcp", "headers": {"A": "${LITELLM_API_KEY}"}}}})
        for aas in ({"template": 1}, {}):                                           # 템플릿이 아닌 패키지도 같은 검사(R1)
            with self.assertRaises(ms.Refuse) as cm:
                self.prepare(template_pkg(config=leak, env=[{"name": "LITELLM_API_KEY"}], aas=aas))
            self.assertEqual(cm.exception.code, "env_ref_blocked")
        with self.assertRaises(ms.Refuse) as cm:
            self.prepare(template_pkg(env=[{"name": "JIRA_TOKEN", "default": "x"}]))
        self.assertEqual(cm.exception.code, "env_default")

    def test_stdio_consent_is_checked_by_stage(self):
        cfg = yaml.safe_dump({"mcp_servers": {"fs": {"command": "npx", "args": ["-y", "@s/fs@1.0.0"]}}})
        with self.assertRaises(ms.Refuse) as cm:
            self.prepare(template_pkg(config=cfg, env=[]))
        self.assertEqual(cm.exception.code, "consent_required")
        res = self.prepare(template_pkg(config=cfg, env=[]), req={**REQ, "consents": [tc.consent_hash("npx", ["-y", "@s/fs@1.0.0"])]})
        self.assertIn("fs", yaml.safe_load(self.unpack(res)["config.yaml"])["mcp_servers"])
        with self.assertRaises(ms.Refuse) as cm:
            self.prepare(template_pkg(config=cfg, env=[]), req={**REQ, "namespace": "free", "package": "free/sales"})
        self.assertEqual(cm.exception.code, "stdio_public")

    def test_reserved_reference_file_is_refused(self):
        with self.assertRaises(ms.Refuse) as cm:
            self.prepare(template_pkg(extra={"template/files/.env": "A=1"}))
        self.assertEqual(cm.exception.code, "file_path")


PKG = {"id": "paid/sales", "namespace": "paid", "name": "sales", "version": "1.2.0", "kind": "agent", "paid": False, "versions": [{"version": "1.2.0"}],
       "bytes": 100, "template_bytes": 0, "status": "ACTIVE", "files": []}


class RequestTest(unittest.TestCase):
    def setUp(self):
        for d in ("queue", "done"):
            for p in mk._dir(d).glob("*"):
                p.unlink()

    def ask(self, profile, have=("main",), **kw):
        return mk.request_install("p1", "hermes", {**PKG, **kw.pop("pkg", {})}, "", profile, "install", "a@x.io", list(have), **kw)

    def test_profile_limit_counts_installs_in_line(self):
        with mock.patch.dict(os.environ, {"AAS_PROFILE_LIMIT": "3"}), mock.patch("aas.ops.cron_policy.root_hidden", return_value=False):
            self.ask("one", owner_limit=True)
            self.ask("two", owner_limit=True)
            with self.assertRaises(mk.MarketError) as cm:
                self.ask("three", owner_limit=True)
            self.assertEqual((cm.exception.code, cm.exception.reason), (409, "profile_limit"))
            self.ask("three")                                                      # 관리자는 한도를 받지 않는다
            self.assertEqual(mk.counted_profiles("p1", ["main"]), ["main", "one", "three", "two"])

    def test_hidden_package_name_taken_and_consents(self):
        with self.assertRaises(mk.MarketError) as cm:
            self.ask("x", pkg={"status": "ARCHIVED"})
        self.assertEqual(cm.exception.reason, "hidden")
        with self.assertRaises(mk.MarketError) as cm:
            self.ask("main")
        self.assertEqual((cm.exception.code, cm.exception.reason), (409, "name_taken"))
        row = self.ask("y", consents=["a" * 64, "not-a-hash"])
        self.assertEqual(row["consents"], ["a" * 64])
        with self.assertRaises(mk.MarketError) as cm:
            self.ask("y")
        self.assertEqual(cm.exception.reason, "pending")

    def test_reference_files_do_not_count_toward_the_size_check(self):
        big = mk.PAYLOAD_LIMIT * mk.MAX_PACKING_RATIO
        self.ask("files", pkg={"bytes": big + 9_900_000, "template_bytes": 9_900_000})
        with self.assertRaises(mk.MarketError):
            self.ask("other", pkg={"bytes": big + 1})


class DispatchRecordTest(unittest.TestCase):
    def setUp(self):
        for d in ("queue", "done"):
            for p in mk._dir(d).glob("*"):
                p.unlink()

    def test_template_fields_go_on_the_row_and_into_installed(self):
        row = {**REQ, "status": "queued", "who": "a@x.io", "ts": "2026-11-18T09:00:00+09:00"}
        market_dispatch._write("queue", row)
        report = {"template": "paid/sales", "template_version": "1.2.0", "env_names": ["JIRA_TOKEN"], "waiting_mcp": ["jira"]}
        fake = {"payload": "eA==", "manifest": {"distribution_owned": ["SOUL.md"]}, "backup": "", "skipped": [], "template": report}
        client = mock.Mock(namespace="ns")
        with mock.patch.object(ms, "prepare", return_value=fake):
            out = market_dispatch._dispatch(client, row, {"p1"})
        self.assertEqual(out["status"], "running")
        self.assertEqual(out["waiting_mcp"], ["jira"])
        market_dispatch._close(out, "done", "설치했습니다")
        rec = next(r for r in mk.installed("p1") if r["profile"] == "sales")
        self.assertEqual((rec["template"], rec["env_names"], rec["waiting_mcp"]), ("paid/sales", ["JIRA_TOKEN"], ["jira"]))

    def test_refusal_code_is_recorded(self):
        row = {**REQ, "status": "queued", "who": "a@x.io", "ts": "2026-11-18T09:00:00+09:00"}
        with mock.patch.object(ms, "prepare", side_effect=ms.Refuse("동의 없음", "consent_required")):
            out = market_dispatch._dispatch(mock.Mock(namespace="ns"), row, {"p1"})
        self.assertEqual((out["status"], out["code"]), ("failed", "consent_required"))


class TemplateDetailTest(unittest.TestCase):
    def test_detail_has_consent_hash_keys_and_sources(self):
        cfg = yaml.safe_dump({"mcp_servers": {"fs": {"command": "npx", "args": ["-y", "@s/fs@1.0.0"]}, "jira": {"url": "https://j/mcp", "headers": {"A": "${JIRA_TOKEN}"}}}})
        files = template_pkg(config=cfg, extra={"agent/cron/jobs.json": json.dumps([{"name": "주간", "schedule": "0 9 * * 1", "prompt": "정리해"}])})
        with mock.patch.object(ms, "download", lambda r, dest: ms.extract(zipped(files), dest, {})):
            d = templates._read("paid", "sales", "1.2.0")
        fs = next(m for m in d["mcp"] if m["name"] == "fs")
        self.assertEqual(fs["consent_hash"], tc.consent_hash("npx", ["-y", "@s/fs@1.0.0"]))
        self.assertEqual(next(m for m in d["mcp"] if m["name"] == "jira")["keys"], ["JIRA_TOKEN"])
        self.assertEqual((d["soul"], d["agents"], d["files"], d["cron"][0]["prompt"]), ("나는 영업 도우미", "지침", ["견적서.xlsx"], "정리해"))
        card = templates.card(d)
        self.assertNotIn("soul", card)
        self.assertEqual((card["cron"], card["files"]), (1, 1))

    def test_card_does_not_ask_for_llm_env(self):
        files = template_pkg(env=[{"name": "LLM_API_KEY"}, {"name": "HERMES_LLM_MODEL"}, {"name": "JIRA_TOKEN"}])
        with mock.patch.object(ms, "download", lambda r, dest: ms.extract(zipped(files), dest, {})):
            d = templates._read("paid", "sales", "1.2.0")
        self.assertEqual([e["name"] for e in d["env_requires"]], ["JIRA_TOKEN"])
        self.assertEqual([e["name"] for e in templates.card(d)["env_requires"]], ["JIRA_TOKEN"])

    def test_non_template_agent_package_is_not_listed(self):
        with mock.patch.object(ms, "download", lambda r, dest: ms.extract(zipped(template_pkg(aas={})), dest, {})):
            self.assertIsNone(templates._read("paid", "sales", "1.2.0"))


class EnableAfterKeyTest(unittest.TestCase):
    """env_set 뒤 서버가 KEY 가 다 찬 MCP 를 켠다(§4-2 6, E8). 화면이 아니라 서버가 하므로 어디서 KEY 를 넣어도 같다."""

    def setUp(self):
        for d in ("queue", "done"):
            for p in mk._dir(d).glob("*"):
                p.unlink()
        row = {**REQ, "status": "done", "who": "a@x.io", "ts": "2026-11-18T09:00:00+09:00", "template": "paid/sales", "waiting_mcp": ["jira", "other"]}
        market_dispatch._write("done", row)

    def run_hook(self, env_set):
        from aas.web import server
        servers = {"jira": {"url": "u", "headers": {"A": "${JIRA_TOKEN}"}, "enabled": False},
                   "other": {"url": "u", "headers": {"A": "${OTHER_KEY}"}, "enabled": False}}
        calls = []

        class Api:
            def call(self, method, path, body=None, query=None, **kw):
                calls.append((method, path, body))
                if path == "/api/config":
                    return {"mcp_servers": servers}
                if path == "/api/env":
                    return {"vars": {k: {"is_set": True} for k in env_set}}
                return {}
        pod = mock.Mock(id="p1")
        with mock.patch.object(server, "_profile_action") as apply, mock.patch.object(server.mcp_servers, "enable_error"):
            done = server._template_enable_ready(pod, Api(), "sales", "sales", {"sales": {"is_default": False, "name": "sales"}}, "a@x.io")
        return done, calls, apply

    def test_only_servers_with_every_key_are_turned_on_and_applied(self):
        done, calls, apply = self.run_hook({"JIRA_TOKEN"})
        self.assertEqual(done, ["jira"])
        self.assertIn(("PUT", "/api/mcp/servers/jira/enabled", {"enabled": True}), calls)
        self.assertNotIn(("PUT", "/api/mcp/servers/other/enabled", {"enabled": True}), calls)
        apply.assert_called_once()

    def test_nothing_ready_means_no_restart(self):
        done, _, apply = self.run_hook(set())
        self.assertEqual(done, [])
        apply.assert_not_called()


if __name__ == "__main__":
    unittest.main()

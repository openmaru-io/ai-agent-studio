# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""게이트웨이 다시 시작 필요 — 기록하는 곳·지우는 때·apply/dismiss 오류 계약·/api/me 보기(스펙 2026-11-18-016 4-2~4-4).
Hermes 대시보드 API 는 대역(FakeApi)으로 바꾼다."""
import copy
import os
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

TMP = tempfile.TemporaryDirectory()
os.environ.setdefault("AAS_DATA_DIR", str(Path(TMP.name) / "data"))

from aas.common import store  # noqa: E402
from aas.fleet import pods  # noqa: E402
from aas.hermes.hermes_api import HermesError  # noqa: E402
from aas.ops import restart_pending as rp  # noqa: E402

OWNER = {"email": "kim@x.com", "sub": "sub-kim"}
OTHER = {"email": "lee@x.com", "sub": "sub-lee"}


class FakeApi:
    def __init__(self):
        self.calls = []
        self.config = {"mcp_servers": {"docmost": {"url": "http://d", "headers": {"Authorization": "Bearer ${MCP_DOCMOST_API_KEY}"},
                                                   "tools": {"include": ["search"]}}},
                       "platforms": {"telegram": {"enabled": True}}}
        self.hot_served = False
        self.restart_fail = None
        self.env = {"MCP_DOCMOST_API_KEY": {"is_set": True}, "LAW_OC": {"is_set": False},
                    "TELEGRAM_BOT_TOKEN": {"is_set": True, "channel_managed": True}}

    def call(self, method, path, body=None, query=None, timeout=30):
        self.calls.append((method, path))
        if path == "/api/config" and method == "GET":
            return copy.deepcopy(self.config)
        if path == "/api/mcp/servers" and method == "PUT":
            self.config["mcp_servers"] = copy.deepcopy(body["servers"])
            return {"ok": True}
        if path == "/api/env" and method == "GET":
            return self.env
        if path.startswith("/api/messaging/platforms/") and method == "PUT":
            return {"ok": True, "hot_served": self.hot_served}
        if path.startswith("/api/gateway") or path.endswith("/gateway/restart"):
            if self.restart_fail:
                raise self.restart_fail
            return {"ok": True}
        return {"ok": True}


def clean():
    with store.connect() as conn:
        conn.execute("DELETE FROM restart_pending WHERE pod LIKE 'kim%'")
        conn.execute("DELETE FROM restart_lock WHERE pod LIKE 'kim%'")
    rp._starts.clear()


class Base(unittest.TestCase):
    k8s = False

    def setUp(self):
        from aas.web import restart_pending_api, server
        clean()
        self.addCleanup(clean)
        self.s, self.rpa = server, restart_pending_api
        self.kim = pods.Pod("kim", "kim@x.com", "/tmp", sidecar_url="http://side" if self.k8s else "")
        reg = pods.Registry.__new__(pods.Registry)
        reg.pods, reg.admins, reg.restarting = [self.kim], set(), []
        reg.is_admin = lambda u: bool((u or {}).get("admin"))
        reg.team_pods = lambda u: []
        reg.member_rows = lambda pid: []
        self.reg = reg
        self.api = FakeApi()
        rows = [{"name": "default", "is_default": True}, {"name": "main", "is_default": False}, {"name": "work", "is_default": False}]
        for target, name, value in ((server, "registry", lambda: reg), (server, "_profile_rows", lambda pod: rows),
                                    (server, "hub", lambda pod: mock.Mock(auth=None)), (server, "HermesAPI", lambda auth: self.api),
                                    (server, "_messenger_sync", lambda pod: []), (server, "_drop_pod_key", lambda *a: None),
                                    (server, "_template_enable_ready", lambda *a: [])):
            p = mock.patch.object(target, name, value)
            p.start()
            self.addCleanup(p.stop)

    def act(self, action, name="main", **body):
        return self.s._profile_action(self.kim, {"action": action, "name": name, **body}, "kim@x.com")

    def rows(self):
        return sorted((r["profile"], r["kind"], r["target"]) for r in rp.all_items("kim"))


class Recording(Base):
    def test_도구_범위를_바꾸면_mcp_한_줄과_응답의_restart_pending(self):
        out = self.act("mcp_docmost_write", write=True)
        self.assertEqual(self.rows(), [("main", "mcp", "docmost")])
        self.assertEqual(out["restart_pending"], [{"profile": "main", "kind": "mcp", "target": "docmost"}])
        row = rp.items("kim")["items"][0]
        self.assertNotIn("Bearer", row["note"] + row["target"])

    def test_바뀐_것이_없으면_기록하지_않는다(self):
        self.act("mcp_docmost_write", write=True)
        clean()
        out = self.act("mcp_docmost_write", write=True)
        self.assertEqual((self.rows(), "restart_pending" in out), ([], False))

    def test_켜고_끄기는_기록하지_않는다(self):
        self.act("mcp", target="docmost", enabled=False)
        self.assertEqual(self.rows(), [])

    def test_channel_save_는_hot_served_가_거짓일_때만(self):
        self.api.hot_served = True
        self.act("channel_save", platform="telegram", enabled=True, _secure=True)
        self.assertEqual(self.rows(), [])
        self.api.hot_served = False
        self.act("channel_save", platform="telegram", enabled=True, _secure=True)
        self.assertEqual(self.rows(), [("main", "channel", "telegram")])

    def test_env_는_MCP_에서_쓰는_변수와_채널_변수만(self):
        self.act("env_set", target="LAW_OC", value="secret-1", _secure=True)
        self.assertEqual(self.rows(), [])
        self.act("env_set", target="MCP_DOCMOST_API_KEY", value="secret-2", _secure=True)
        self.act("env_set", target="TELEGRAM_BOT_TOKEN", value="secret-3", _secure=True)
        self.assertEqual(self.rows(), [("main", "env", "MCP_DOCMOST_API_KEY"), ("main", "env", "TELEGRAM_BOT_TOKEN")])

    def test_env_판정_읽기에_실패하면_기록한다(self):
        real = self.api.call

        def flaky(method, path, body=None, query=None, timeout=30):
            if path in ("/api/env", "/api/config") and method == "GET":
                raise HermesError("down", 502)
            return real(method, path, body, query, timeout)
        self.api.call = flaky
        self.act("env_set", target="LAW_OC", value="secret-1", _secure=True)
        self.assertEqual(self.rows(), [("main", "env", "LAW_OC")])

    def test_add_의_DB_오류에도_원_요청은_성공하고_unrecorded(self):
        with mock.patch.object(rp, "add", side_effect=RuntimeError("db")), mock.patch("builtins.print"):
            out = self.act("mcp_docmost_write", write=True)
        self.assertEqual((out["ok"], out["restart_pending"]), (True, "unrecorded"))

    def test_이름_바꾸기와_지우기(self):
        rp.add("kim", "work", "mcp", "x")
        self.act("rename", name="work", new_name="work2")
        self.assertEqual(self.rows(), [("work2", "mcp", "x")])

    def test_ensure_redirect_는_기록하지_않는다(self):
        from aas.ops import mcp_oauth_relay
        self.api.config["mcp_servers"]["gh"] = {"url": "https://gh", "auth": "oauth"}
        with rp.recording("kim", "main", "kim@x.com"):
            self.assertTrue(mcp_oauth_relay.ensure_redirect(self.api, "main", "gh", "https://aas/cb", pod="kim", by="kim@x.com"))
        self.assertEqual(self.rows(), [])


class Clearing(Base):
    def test_mcp_apply_는_요청_전_기록만_그_프로파일만_지운다(self):
        rp.add("kim", "main", "mcp", "a", now=time.time() - 10)
        rp.add("kim", "work", "mcp", "b", now=time.time() - 10)
        self.act("mcp_apply")
        self.assertEqual(self.rows(), [("work", "mcp", "b")])
        with store.connect() as conn:
            self.assertIsNone(conn.execute("SELECT 1 FROM restart_lock WHERE pod='kim'").fetchone())   # 잠금이 풀렸다

    def test_다시_시작이_실패하면_기록과_잠금이_남지_않는다(self):
        rp.add("kim", "main", "mcp", "a", now=time.time() - 10)
        self.api.restart_fail = HermesError("boom", 502)
        with self.assertRaises(HermesError):
            self.act("mcp_apply")
        self.assertEqual(self.rows(), [("main", "mcp", "a")])
        with store.connect() as conn:
            self.assertIsNone(conn.execute("SELECT 1 FROM restart_lock WHERE pod='kim'").fetchone())

    def test_다른_요청이_잠금을_쥐면_409_restart_locked(self):
        with store.connect() as conn:
            conn.execute("INSERT INTO restart_lock (pod, expires, token) VALUES ('kim', ?, 'other')", (time.time() + 50,))
        with self.assertRaises(self.s.files.FileError) as got:
            self.act("mcp_apply")
        self.assertEqual((got.exception.code, got.exception.reason), (409, "restart_locked"))
        self.assertGreater(self.s._error_body(got.exception)["retry_after"], 40)

    def test_pc_가져오기_끝의_다시_시작도_지운다(self):
        from aas.web import pc_import_routes
        rp.add("kim", "main", "mcp", "a", now=time.time() - 10)
        with mock.patch.object(pc_import_routes, "_api", lambda pod: self.api):
            pc_import_routes._restart(self.kim, "main")
        self.assertEqual(self.rows(), [])


class K8sClearing(Base):
    k8s = True

    def test_쿠버네티스는_어느_프로파일을_다시_시작해도_작업공간_전체(self):
        rp.add("kim", "main", "mcp", "a", now=time.time() - 10)
        rp.add("kim", "work", "env", "K", now=time.time() - 10)
        with mock.patch.object(self.s.mindwiki_connect, "apply_snapshot", return_value=None) as snap:
            self.act("mcp_apply", name="default")
        self.assertEqual(self.rows(), [])
        self.assertIsNone(snap.call_args.args[1])                       # MindWiki 세대도 작업공간 전체


class ApplyContract(Base):
    def apply(self, user=OWNER, **body):
        return self.rpa.apply(self.reg, user, True, {"pod": "kim", **body})

    def test_0건이면_200_다시_시작하지_않음(self):
        self.assertEqual(self.apply(), {"done": [], "failed": []})
        self.assertNotIn(("POST", "/api/gateway/restart"), self.api.calls)

    def test_권한_없음_403_없는_작업공간_404_모르는_프로파일_400(self):
        rp.add("kim", "main", "mcp", "a")
        for call, code, reason in ((lambda: self.apply(user=OTHER), 403, "forbidden"),
                                   (lambda: self.rpa.apply(self.reg, OWNER, True, {"pod": "nope"}), 404, "not_found"),
                                   (lambda: self.apply(profiles=["ghost"]), 400, "unknown_profile")):
            with self.assertRaises(self.rpa.RestartError) as got:
                call()
            self.assertEqual((got.exception.code, got.exception.reason), (code, reason))

    def test_다시_시작_중이면_409(self):
        self.reg.restarting = [self.kim]
        with self.assertRaises(self.rpa.RestartError) as got:
            self.apply()
        self.assertEqual(got.exception.reason, "restart_in_progress")

    def test_잠금을_쥐고_있으면_409_와_남은_초(self):
        rp.add("kim", "main", "mcp", "a")
        with store.connect() as conn:
            conn.execute("INSERT INTO restart_lock (pod, expires, token) VALUES ('kim', ?, 'other')", (time.time() + 20,))
        with self.assertRaises(self.rpa.RestartError) as got:
            self.apply()
        self.assertEqual(got.exception.reason, "restart_locked")
        self.assertTrue(15 <= got.exception.retry_after <= 21)

    def test_모두_성공하면_기록이_사라진다(self):
        rp.add("kim", "main", "mcp", "a", now=time.time() - 5)
        rp.add("kim", "work", "env", "K", now=time.time() - 5)
        self.assertEqual(self.apply(), {"done": ["main", "work"], "failed": []})
        self.assertEqual(self.rows(), [])

    def test_일부_실패는_502_와_성공만_지움(self):
        rp.add("kim", "main", "mcp", "a", now=time.time() - 5)
        rp.add("kim", "work", "env", "K", now=time.time() - 5)
        real = self.api.call

        def fail_work(method, path, body=None, query=None, timeout=30):
            if "restart" in path and (query or {}).get("profile") == "work":
                raise HermesError("Hermes did not answer in time token=abcdefghijklmnop1234", 504, "timeout")
            return real(method, path, body, query, timeout)
        self.api.call = fail_work
        with self.assertRaises(self.rpa.RestartError) as got:
            self.apply()
        body = self.rpa.error_body(got.exception)
        self.assertEqual((got.exception.code, body["reason"], body["done"]), (502, "restart_partial_failed", ["main"]))
        self.assertEqual([(f["profile"], f["reason"]) for f in body["failed"]], [("work", "outcome_unknown")])
        self.assertNotIn("abcdefghijklmnop1234", body["failed"][0]["error"])
        self.assertEqual(self.rows(), [("work", "env", "K")])

    def test_다시_시도는_시작_시각이_바뀌었으면_다시_시작하지_않는다(self):
        since = time.time() - 30
        rp.add("kim", "work", "env", "K", now=since - 5)
        with mock.patch.object(self.rpa, "_reader", lambda pod: (lambda: {"work": since + 10})):
            self.assertEqual(self.apply(since=since), {"done": ["work"], "failed": []})
        self.assertNotIn(("POST", "/api/gateway/restart"), self.api.calls)
        self.assertEqual(self.rows(), [])


class DismissContract(Base):
    def dismiss(self, user=OWNER, **body):
        return self.rpa.dismiss(self.reg, user, True, {"pod": "kim", **body})

    def test_멱등_200(self):
        rp.add("kim", "main", "env", "K")
        self.assertEqual(self.dismiss(profile="main", kind="env", target="K")["removed"], 1)
        self.assertEqual(self.dismiss(profile="main", kind="env", target="K")["removed"], 0)

    def test_all_과_권한과_kind_허용_목록(self):
        rp.add("kim", "main", "env", "K")
        rp.add("kim", "work", "mcp", "x")
        with self.assertRaises(self.rpa.RestartError) as got:
            self.dismiss(user=OTHER, all=True)
        self.assertEqual(got.exception.code, 403)
        with self.assertRaises(self.rpa.RestartError) as got:
            self.dismiss(profile="main", kind="model", target="K")
        self.assertEqual(got.exception.code, 400)
        self.assertEqual(self.dismiss(all=True)["removed"], 2)

    def test_MindWiki_는_mark_applied_실패면_500(self):
        with mock.patch.object(self.rpa.mindwiki_connect, "apply_snapshot", side_effect=RuntimeError("db")), mock.patch("builtins.print"):
            with self.assertRaises(self.rpa.RestartError) as got:
                self.dismiss(profile="main", kind="mindwiki", target="mindwiki")
        self.assertEqual((got.exception.code, got.exception.reason), (500, "mindwiki_mark_failed"))


class View(Base):
    def test_권한_없는_사람에게는_없다(self):
        rp.add("kim", "main", "mcp", "a")
        self.assertIsNone(self.rpa.view(self.kim, OTHER, True, self.reg))
        got = self.rpa.view(self.kim, OWNER, True, self.reg)
        self.assertEqual((got["total"], got["has_members"]), (1, False))

    def test_사이드카가_늦어도_기다리지_않는다(self):
        rp.add("kim", "main", "mcp", "a")

        def slow():
            time.sleep(2)
            return {"main": time.time()}
        with mock.patch.object(self.rpa, "_reader", lambda pod: slow):
            t = time.time()
            got = self.rpa.view(self.kim, OWNER, True, self.reg)
            self.assertLess(time.time() - t, 0.5)
        self.assertEqual(got["total"], 1)

    def test_MindWiki_기록은_prune_으로_지워지지_않는다(self):
        with mock.patch.object(self.s.mindwiki_connect, "pending_apply", return_value=[{"profile": "main", "at": 10.0}]):
            rp.prune("kim", {"main": time.time()})
            got = self.rpa.view(self.kim, OWNER, True, self.reg)
        self.assertEqual([(r["kind"], r["by_kind"]) for r in got["items"]], [("mindwiki", "auto")])


class McpTool(unittest.TestCase):
    def test_결과에_next(self):
        from aas.web import mcp_server
        out = mcp_server._restart_hint({"ok": True, "restart_pending": [{"profile": "main", "kind": "mcp", "target": "docmost"}]})
        self.assertIn("top bar", out["next"])
        self.assertNotIn("next", mcp_server._restart_hint({"ok": True}))


if __name__ == "__main__":
    unittest.main()

# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""스킬 새 버전 알림의 서버 쪽 시험(스펙 2026-10-24-003) — 허브 목록 캐시와 복제본 신호, 「확인할 것」 항목, 배달기 완료 뒤 캐시 비우기, 설치 기록 복사."""
import json
import os
import tempfile
import time
import types
import unittest
from pathlib import Path
from unittest import mock

TMP = tempfile.TemporaryDirectory()
os.environ.setdefault("AAS_DATA_DIR", str(Path(TMP.name) / "data"))

from aas.common import cache_epoch, store  # noqa: E402
from aas.market import market_dispatch, marketplace as mk, updates  # noqa: E402
from aas.web import server  # noqa: E402

ROW = {"pod": "p1", "profile": "work", "package": "free/outline", "namespace": "free", "name": "outline", "skill": "outline", "kind": "skill",
       "current": "0.1.1", "latest": "0.1.2", "basis": "record", "mode": "update", "state": "update", "reason": ""}


def other_replica_bumps(prefix: str) -> None:
    with store.connect() as conn:
        conn.execute("INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                     (cache_epoch.KEY + prefix, f"other-{os.urandom(4).hex()}"))
    cache_epoch.on_notify(prefix)


class Base(unittest.TestCase):
    def setUp(self):
        server._cache.clear()
        cache_epoch.reset_for_test()
        with store.connect() as conn:
            conn.execute("DELETE FROM meta WHERE key LIKE ?", (cache_epoch.KEY + "%",))
        for d in ("queue", "done"):
            for p in mk._dir(d).glob("*"):
                p.unlink()
        self.env = mock.patch.dict(os.environ, {"AAS_SKILLHUB_URL": "http://hub"})
        self.env.start()

    def tearDown(self):
        self.env.stop()
        server._cache.clear()


class CatalogCacheTest(Base):
    def test_one_read_and_other_replica_signal_drops_it(self):
        calls = []
        with mock.patch.object(mk, "catalog", lambda cfg=None: calls.append(1) or [{"id": "free/outline"}]), \
             mock.patch.object(cache_epoch, "enabled", lambda: True):
            self.assertTrue(server._catalog()["ok"])
            server._catalog()
            self.assertEqual(len(calls), 1)                              # 10분 동안 한 번(R20)
            other_replica_bumps("market")                                 # 다른 복제본이 올리기를 승인했다(R8)
            time.sleep(cache_epoch.POLL + 0.05)
            server._catalog()
        self.assertEqual(len(calls), 2)

    def test_hub_failure_is_retried_after_a_minute(self):
        calls = []

        def broken(cfg=None):
            calls.append(1)
            raise mk.MarketError("허브 꺼짐", 503)
        with mock.patch.object(mk, "catalog", broken):
            got = server._catalog()
            self.assertEqual((got["ok"], got["error"]), (False, "허브 꺼짐"))
            server._catalog()
            self.assertEqual(len(calls), 1)
            with mock.patch.object(server.time, "time", lambda: got["at"] + server.MARKET_FAIL_TTL + 1):
                server._catalog()
        self.assertEqual(len(calls), 2)


class IssueTest(Base):
    def test_market_issue_is_info_and_links_to_list(self):
        pod = types.SimpleNamespace(id="p1")
        rows = [{"name": "work", "issues": [{"level": "warn", "code": "model", "text": "모델"}]}, {"name": "other", "issues": []}]
        with mock.patch.object(server, "_market_updates_peek", lambda p: [ROW, {**ROW, "state": "kept"}]):
            out = server._with_market_issues(pod, rows)
        self.assertEqual([i["code"] for i in out[0]["issues"]], ["model", "market_update"])   # 기존 항목·순서는 그대로(R12 ③)
        item = out[0]["issues"][1]
        self.assertEqual((item["level"], item["n"], item["to"]["params"]["q"]), ("info", 1, "work"))
        self.assertIs(out[1], rows[1])                                    # 새 버전이 없는 줄은 그대로
        self.assertEqual(rows[0]["issues"][-1]["code"], "model")         # 캐시된 줄을 고치지 않는다

    def test_peek_does_not_wait_for_the_sidecar(self):
        pod = types.SimpleNamespace(id="p9")
        started = []
        with mock.patch.object(server, "_market_updates", lambda p: started.append(1) or time.sleep(0.3) or [ROW]):
            t0 = time.monotonic()
            self.assertEqual(server._market_updates_peek(pod), [])       # 모아 둔 값이 없다 — 뒤에서 만든다
            self.assertLess(time.monotonic() - t0, 0.2)


class FinishedTest(Base):
    def test_tick_reports_finished_pod_and_server_drops_updates(self):
        bad = {"id": "bad", "pod": "p1", "profile": "work", "mode": "update", "kind": "skill", "status": "queued"}
        (mk._dir("queue") / "bad.json").write_text(json.dumps(bad), encoding="utf-8")
        seen = []
        market_dispatch.tick(None, {"p1"}, on_finished=seen.append)      # 요청 번호가 틀려 곧바로 failed 로 닫힌다
        self.assertEqual(seen, ["p1"])
        pod = types.SimpleNamespace(id="p1", hermes_home=None)
        server._cache["p1:updates"] = (time.time(), [ROW])
        with mock.patch.object(server, "registry", lambda: types.SimpleNamespace(pods=[pod])), mock.patch.object(server.topics, "invalidate", lambda *a, **k: None):
            server._market_request_finished("p1")
        self.assertNotIn("p1:updates", server._cache)                    # R14


class RecordCopyTest(Base):
    def done(self, profile, package, version, kind="skill"):
        ns, _, name = package.partition("/")
        rid = f"2026102400000000{len(list(mk._dir('done').glob('*'))):04d}-abcdef"
        (mk._dir("done") / f"{rid}.json").write_text(json.dumps({"id": rid, "ts": "2026-10-24T00:00:00+09:00", "pod": "p1", "profile": profile,
                                                                 "package": package, "namespace": ns, "name": name, "version": version,
                                                                 "kind": kind, "mode": "install", "status": "done"}), encoding="utf-8")

    def test_clone_copies_skill_records_only(self):
        self.done("main", "free/outline", "0.1.1")
        self.done("main", "free/bot", "1.0.0", kind="agent")
        self.assertEqual(mk.copy_records("p1", "main", "work", "a@x.io"), 1)
        mine = {(r["profile"], r["package"], r["version"]) for r in mk.installed("p1")}
        self.assertIn(("work", "free/outline", "0.1.1"), mine)
        self.assertIn(("main", "free/outline", "0.1.1"), mine)           # 원본 기록은 그대로
        self.assertNotIn(("work", "free/bot", "1.0.0"), mine)


class OverviewTest(Base):
    def test_update_comes_from_scan_rows(self):
        cat = {"ok": True, "items": [{"id": "free/outline", "namespace": "free", "name": "outline", "version": "0.1.2", "paid": False}], "error": ""}
        out = mk.overview("p1", cat=cat, rows=[ROW])
        self.assertEqual((out["packages"][0]["update"], out["packages"][0]["skipped"]), (True, False))
        out = mk.overview("p1", cat=cat, rows=[{**ROW, "state": "skipped"}])
        self.assertEqual((out["packages"][0]["update"], out["packages"][0]["skipped"]), (False, True))
        self.assertNotIn("installed", cat["items"][0])                   # 모아 둔 목록을 고치지 않는다


class ListTest(Base):
    def setUp(self):
        super().setUp()
        with updates._conn() as conn:
            conn.execute("DELETE FROM market_update_pending")
        self.p1, self.p2 = types.SimpleNamespace(id="p1", owner="a@x.io", hermes_home=None), types.SimpleNamespace(id="p2", owner="b@x.io", hermes_home=None)
        reg = types.SimpleNamespace(pods=[self.p1, self.p2], is_admin=lambda u: False)
        self.reg = reg
        self.patches = [mock.patch.object(server, "_catalog", lambda: {"ok": True, "items": [], "error": "", "at": time.time()}),
                        mock.patch.object(server, "_market_updates", lambda pod: [{**ROW, "pod": pod.id}]),
                        mock.patch.object(server, "_manages_pod", lambda pod, user, auth: pod.id == "p1"),
                        mock.patch.object(server, "_market_modified", lambda pod, rows: [r.setdefault("modified", "same") for r in rows]),
                        mock.patch.object(server, "_pod_label", lambda pod, names=None, known=None: {"name": pod.id, "owner_name": ""}),
                        mock.patch.object(server.office, "agent_names_provider", lambda: {}), mock.patch.object(server.office, "people", lambda: {})]
        for p in self.patches:
            p.start()

    def tearDown(self):
        for p in self.patches:
            p.stop()
        super().tearDown()

    def test_scope_and_permission(self):
        out = server._market_update_list(self.reg, self.p1, {"email": "a@x.io"}, True, "managed")
        self.assertEqual([r["pod"] for r in out["rows"]], ["p1"])          # 관리하는 작업공간만(R5)
        self.assertEqual(out["managed_count"], 1)
        out = server._market_update_list(self.reg, self.p2, {"email": "a@x.io"}, True, "pod")
        self.assertEqual((out["rows"], out["can"]), ([], False))             # 보기만 받은 작업공간은 목록이 없다(R7)

    def test_pending_row_state(self):
        updates.queue("p1", [{"profile": "work", "package": "free/outline", "version": "0.1.2"}], "a@x.io")
        out = server._market_update_list(self.reg, self.p1, {"email": "a@x.io"}, True, "pod")
        self.assertEqual([r["state"] for r in out["rows"]], ["pending"])
        self.assertTrue(out["hub_ok"])


if __name__ == "__main__":
    unittest.main()

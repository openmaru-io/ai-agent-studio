# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""새 사용자 기본 스킬(스펙 2026-10-23-002 Q5, OMAI-1440).

main 을 처음 만들었을 때(primary.ensure 가 created) 설치 값 AAS_DEFAULT_SKILLS 의 패키지를 대기 표에 넣고,
주기마다 하나씩 스킬 허브 설치 요청으로 바꾼다. 한 프로파일에 끝나지 않은 요청이 있으면(409) 다음 주기에 다시 한다.
"""
import os
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

TMP = tempfile.TemporaryDirectory()
os.environ.setdefault("AAS_DATA_DIR", str(Path(TMP.name) / "data"))

from aas.common import store  # noqa: E402
from aas.market import marketplace  # noqa: E402
from aas.market.marketplace import MarketError  # noqa: E402

POD = SimpleNamespace(id="aas-agent-new-1", container="hermes")


def _pkg(ns, name):
    return {"id": f"{ns}/{name}", "namespace": ns, "name": name, "version": "0.1.0"}


class DefaultSkillsTest(unittest.TestCase):
    def setUp(self):
        with marketplace._conn() as conn:
            conn.execute("DELETE FROM market_default_pending")

    def tearDown(self):
        with marketplace._conn() as conn:
            conn.execute("DELETE FROM market_default_pending")

    def _pending(self):
        with marketplace._conn() as conn:
            return [(r["pod"], r["profile"], r["package"]) for r in conn.execute("SELECT pod, profile, package FROM market_default_pending ORDER BY package")]

    def test_list_comes_from_the_install_value_and_bad_names_are_skipped(self):
        with mock.patch.dict(os.environ, {"AAS_DEFAULT_SKILLS": " free/docmost , bad name, paid/x-y ,free/docmost"}):
            self.assertEqual(marketplace.env_default_packages(), ["free/docmost", "paid/x-y"])
        with mock.patch.dict(os.environ, {"AAS_DEFAULT_SKILLS": ""}):
            self.assertEqual(marketplace.env_default_packages(), [])

    def test_nothing_is_queued_when_the_list_is_empty(self):
        with mock.patch.dict(os.environ, {"AAS_DEFAULT_SKILLS": ""}):
            self.assertEqual(marketplace.queue_defaults(POD.id, "main"), 0)
        self.assertEqual(self._pending(), [])

    def test_queue_then_drain_one_request_per_profile_per_cycle(self):
        with mock.patch.dict(os.environ, {"AAS_DEFAULT_SKILLS": "free/docmost,free/other"}):
            self.assertEqual(marketplace.queue_defaults(POD.id, "main"), 2)
            self.assertEqual(marketplace.queue_defaults(POD.id, "main"), 0)            # 같은 것을 두 번 넣지 않는다
        asked = []

        def install(pod_id, container, pkg, version, profile, mode, who, profiles):
            if any(p == profile for _, p in asked):                                   # 끝나지 않은 요청이 있으면 409 (실제 request_install 과 같은 규칙)
                raise MarketError("busy", 409)
            asked.append((pkg["id"], profile))
            return {"id": "r"}
        with mock.patch.object(marketplace, "package", side_effect=_pkg), mock.patch.object(marketplace, "request_install", side_effect=install):
            done = marketplace.drain_defaults([POD])
        self.assertEqual(done, [f"{POD.id}/main free/docmost"])
        self.assertEqual(asked, [("free/docmost", "main")])
        self.assertEqual(self._pending(), [(POD.id, "main", "free/other")])            # 409 는 다음 주기에

    def test_other_failures_are_dropped_and_logged_so_they_do_not_retry_forever(self):
        with mock.patch.dict(os.environ, {"AAS_DEFAULT_SKILLS": "free/docmost"}):
            marketplace.queue_defaults(POD.id, "main")
        with mock.patch.object(marketplace, "package", side_effect=MarketError("not found", 404)):
            self.assertEqual(marketplace.drain_defaults([POD]), [])
        self.assertEqual(self._pending(), [])
        with store.connect() as conn:
            notes = [str(r["note"]) for r in conn.execute("SELECT note FROM usage WHERE kind='market_default_failed'")]
        self.assertTrue(any("free/docmost" in n for n in notes))

    def test_rows_of_pods_that_are_not_listed_wait(self):
        with mock.patch.dict(os.environ, {"AAS_DEFAULT_SKILLS": "free/docmost"}):
            marketplace.queue_defaults("other-pod", "main")
        with mock.patch.object(marketplace, "request_install") as req:
            self.assertEqual(marketplace.drain_defaults([POD]), [])
        req.assert_not_called()
        self.assertEqual(self._pending(), [("other-pod", "main", "free/docmost")])


class CompanionSkillTest(unittest.TestCase):
    """카탈로그로 Docmost 를 설치하면 docmost 스킬도 그 프로파일에 설치를 요청한다(스펙 2026-10-23-002 12-8). 스킬이 없으면 모델이
    mcp__docmost__* 대신 manage_connections 를 불러 AAS 화면에 아무 안내 없이 3분 멈췄다(OKE 2026-10-23). Outline 도 같은 경로를 쓴다(2026-10-23-004 R3)."""

    def setUp(self):
        with marketplace._conn() as conn:
            conn.execute("DELETE FROM market_default_pending")
        self.addCleanup(self._clear)

    @staticmethod
    def _clear():
        with marketplace._conn() as conn:
            conn.execute("DELETE FROM market_default_pending")

    @staticmethod
    def _pending():
        with marketplace._conn() as conn:
            return [(r["pod"], r["profile"], r["package"]) for r in conn.execute("SELECT pod, profile, package FROM market_default_pending")]

    def test_requests_the_skill_for_that_profile(self):
        seen = []
        with mock.patch.object(marketplace, "package", side_effect=_pkg), \
             mock.patch.object(marketplace, "request_install", side_effect=lambda *a, **k: seen.append(a) or {"id": "r1"}):
            self.assertEqual(marketplace.install_companion(POD.id, POD.container, "main", "free/docmost", "t@example.com"), "queued")
        self.assertEqual(seen[0][:3], (POD.id, POD.container, _pkg("free", "docmost")))
        self.assertEqual((seen[0][4], seen[0][5], seen[0][7]), ("main", "install", ["main"]))

    def test_failures_are_reported_but_never_raised(self):
        for side, want in ((MarketError("off", 403), "failed"), (OSError("down"), "failed")):
            with mock.patch.object(marketplace, "package", side_effect=_pkg), mock.patch.object(marketplace, "request_install", side_effect=side):
                self.assertEqual(marketplace.install_companion(POD.id, POD.container, "main", "free/docmost", "x"), want, side)
        self.assertEqual(marketplace.install_companion(POD.id, POD.container, "main", "bad name", "x"), "skipped")
        self.assertEqual(marketplace.install_companion(POD.id, POD.container, "default", "free/docmost", "x"), "skipped")   # 루트 프로파일에는 Hermes 가 설치를 막는다
        self.assertEqual(self._pending(), [])

    def test_an_unfinished_request_moves_the_skill_to_the_pending_table_once(self):
        with mock.patch.object(marketplace, "package", side_effect=_pkg), mock.patch.object(marketplace, "request_install", side_effect=MarketError("busy", 409)):
            for _ in range(2):
                self.assertEqual(marketplace.install_companion(POD.id, POD.container, "main", "free/outline", "x"), "queued_later")
        self.assertEqual(self._pending(), [(POD.id, "main", "free/outline")])          # 다음 주기 drain_defaults 가 다시 시도한다

    def test_an_installed_skill_is_not_requested_again(self):
        # 다시 요청하면 request_install 이 update 로 받고, 사용자가 고친 스킬이면 묻는 상태로 멈춘다(2026-10-23-004 S3)
        done = [{"profile": "main", "package": "free/outline"}]
        with mock.patch.object(marketplace, "installed", return_value=done), mock.patch.object(marketplace, "package", side_effect=_pkg), \
             mock.patch.object(marketplace, "request_install", return_value={"id": "r"}) as req:
            self.assertEqual(marketplace.install_companion(POD.id, POD.container, "main", "free/outline", "x"), "installed")
            self.assertEqual(marketplace.install_companion(POD.id, POD.container, "ops", "free/outline", "x"), "queued")   # 다른 프로파일은 요청한다
        self.assertEqual(req.call_count, 1)

    def test_drain_drops_a_pending_skill_that_got_installed_meanwhile(self):
        with marketplace._conn() as conn:
            conn.execute("INSERT INTO market_default_pending (pod, profile, package, ts) VALUES (?,?,?,?)", (POD.id, "main", "free/outline", "t"))
        with mock.patch.object(marketplace, "installed", return_value=[{"profile": "main", "package": "free/outline"}]), \
             mock.patch.object(marketplace, "request_install") as req:
            self.assertEqual(marketplace.drain_defaults([POD]), [])
        req.assert_not_called()
        self.assertEqual(self._pending(), [])


class PrimarySyncHookTest(unittest.TestCase):
    def test_created_main_queues_the_defaults_and_checked_does_not(self):
        from aas.web import server
        reg = SimpleNamespace(pods=[SimpleNamespace(id="p1", owner="n@example.com")])
        for what, queued in (("created templated", [("p1", "main")]), ("checked", [])):
            calls = []
            with mock.patch.object(server.primary, "pending", return_value=[{"pod": "p1", "profile": "main"}]), \
                 mock.patch.object(server.primary, "ensure", return_value=what), \
                 mock.patch.object(server.office, "seat_alias", return_value="n-main"), \
                 mock.patch.object(server, "hub", return_value=SimpleNamespace(auth=None)), \
                 mock.patch.object(server, "HermesAPI", return_value=None), \
                 mock.patch.object(server, "_forget"), \
                 mock.patch.object(server, "primary_skill_sync_once", return_value=[]), \
                 mock.patch.object(server.marketplace, "queue_defaults", side_effect=lambda pod, prof: calls.append((pod, prof)) or 1), \
                 mock.patch.object(server.marketplace, "drain_defaults", return_value=[]) as drain:
                server.primary_sync_once(reg)
            self.assertEqual(calls, queued, what)
            drain.assert_called_once_with(reg.pods)


if __name__ == "__main__":
    unittest.main()

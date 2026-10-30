# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""AAS 기본 스킬 묶음을 모든 프로파일에 배달(스펙 2026-10-29-001 D4 B·R3·R4·R12·R14·F6·F8, OMAI-1534).

- 모든 작업공간 × 프로파일(default 제외) × 묶음 패키지. 허브에 묶음 판 이상이 있을 때만 요청한다(게시 전에는 기다린다).
- 요청은 줄에 세울 뿐이다 — 끝난 상태(done·failed)를 보고 배달 기록을 적는다. done 이면 다시 넣지 않는다(지워도).
- failed 는 그 판에 한 번만. 「확인할 것」에 보이고, 묶음 판이 바뀌거나 사람이 설치하면 다시 대상이다.
- 한 프로파일에 한 주기 하나(409 는 다음 주기). 프로파일 이름 바꾸기·지우기를 따라간다.
- 환경 값 AAS_DEFAULT_SKILLS 는 지금처럼 main 첫 생성 때만(R14), 자동 올리기의 기본 목록에는 묶음이 들어간다(R12).
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
from aas.market import bundle_defaults, marketplace, skill_bundle, updates  # noqa: E402
from aas.market.marketplace import MarketError  # noqa: E402

NAMES = skill_bundle.names()
VER = {n: skill_bundle.front(n)["version"] for n in NAMES}


class Fake:
    """허브·설치 대역. hub = {이름: 허브 판}, requests = 요청 줄."""

    def __init__(self, hub=None):
        self.hub = dict(hub if hub is not None else VER)
        self.requests: list[dict] = []
        self.busy: set[tuple] = set()

    def package(self, ns, name, cfg=None):
        if name not in self.hub:
            raise MarketError("없음", 404)
        return {"id": f"{ns}/{name}", "namespace": ns, "name": name, "version": self.hub[name], "kind": "skill",
                "versions": [{"version": self.hub[name]}]}

    def request_install(self, pod_id, container, pkg, version, profile, mode, who, profiles, on_modified=""):
        if (pod_id, profile) in self.busy:
            raise MarketError("끝나지 않은 요청", 409)
        row = {"id": f"r{len(self.requests)}", "pod": pod_id, "profile": profile, "package": pkg["id"], "status": "queued", "mode": mode,
               "version": pkg["version"]}
        self.requests.append(row)
        self.busy.add((pod_id, profile))
        return row

    def finish(self, status="done", message=""):
        for r in self.requests:
            if r["status"] == "queued":
                r.update(status=status, message=message)
        self.busy.clear()

    def reqs(self, pod_id, limit=200):
        return [r for r in self.requests if r["pod"] == pod_id]

    def patches(self):
        return [mock.patch.object(marketplace, "package", self.package), mock.patch.object(marketplace, "request_install", self.request_install),
                mock.patch.object(marketplace, "requests", self.reqs), mock.patch.object(marketplace, "installed", lambda pod: [])]


POD = SimpleNamespace(id="pod-a", container="hermes")


class DeliverTest(unittest.TestCase):
    def setUp(self):
        with store.connect() as conn:
            conn.executescript(bundle_defaults.SCHEMA)
            conn.execute("DELETE FROM market_bundle_delivery")
        bundle_defaults.reset()

    def _run(self, fake, profiles=("main", "work", "default")):
        for p in fake.patches():
            p.start()
            self.addCleanup(p.stop)
        bundle_defaults.reset()
        return bundle_defaults.deliver([POD], lambda pod: list(profiles))

    def test_one_request_per_profile_per_cycle_and_never_the_root_profile(self):
        fake = Fake()
        self._run(fake)
        self.assertEqual(sorted(r["profile"] for r in fake.requests), ["main", "work"])
        for _ in range(len(NAMES) * 2):
            fake.finish()
            self._run(fake)
        got = {(r["profile"], r["package"]) for r in fake.requests}
        self.assertEqual(got, {(p, f"free/{n}") for p in ("main", "work") for n in NAMES})
        self.assertFalse(any(r["profile"] == "default" for r in fake.requests))

    def test_done_is_recorded_after_the_request_finishes_and_never_requested_again(self):
        fake = Fake()
        self._run(fake, profiles=("main",))
        first = fake.requests[0]["package"]
        self.assertEqual(bundle_defaults.record(POD.id, "main", first)["status"], "queued")
        fake.finish("done")
        self._run(fake, profiles=("main",))
        self.assertEqual(bundle_defaults.record(POD.id, "main", first)["status"], "done")
        for _ in range(len(NAMES) * 2):
            fake.finish()
            self._run(fake, profiles=("main",))
        self.assertEqual(sum(1 for r in fake.requests if r["package"] == first), 1)   # 사용자가 지워도 다시 넣지 않는다

    def test_failure_once_per_version_shows_an_issue_and_new_version_retries(self):
        fake = Fake()
        self._run(fake, profiles=("main",))
        pkg = fake.requests[0]["package"]
        fake.finish("failed", "Hermes 설치 실패")
        for _ in range(len(NAMES) * 2):
            self._run(fake, profiles=("main",))
            fake.finish("done")
        self.assertEqual(sum(1 for r in fake.requests if r["package"] == pkg), 1)
        issues = bundle_defaults.issues(POD.id, "main")
        self.assertEqual([i["code"] for i in issues], ["market_default_failed"])
        self.assertIn("Hermes 설치 실패", issues[0]["text"])
        name = pkg.split("/", 1)[1]
        with mock.patch.object(skill_bundle, "front", lambda n, root=None: {"version": "99.0.0" if n == name else VER[n]}):
            fake.hub[name] = "99.0.0"
            self._run(fake, profiles=("main",))
        self.assertEqual(sum(1 for r in fake.requests if r["package"] == pkg), 2)

    def test_waits_until_the_hub_has_the_bundle_version(self):
        fake = Fake(hub={n: "0.0.1" for n in NAMES[1:]})          # 첫 패키지는 아직 없음, 나머지는 낮은 판
        self._run(fake, profiles=("main",))
        self.assertEqual(fake.requests, [])
        self.assertIsNone(bundle_defaults.record(POD.id, "main", f"free/{NAMES[0]}"))

    def test_busy_profile_waits_without_a_record(self):
        fake = Fake()
        fake.busy.add((POD.id, "main"))
        self._run(fake, profiles=("main",))
        self.assertEqual(fake.requests, [])
        self.assertIsNone(bundle_defaults.record(POD.id, "main", f"free/{NAMES[0]}"))

    def test_already_installed_counts_as_delivered(self):
        fake = Fake()
        installed = [{"profile": "main", "package": f"free/{n}"} for n in NAMES]
        for p in fake.patches():
            p.start()
            self.addCleanup(p.stop)
        with mock.patch.object(marketplace, "installed", lambda pod: installed):
            bundle_defaults.reset()
            bundle_defaults.deliver([POD], lambda pod: ["main"])
        self.assertEqual(fake.requests, [])
        self.assertEqual(bundle_defaults.record(POD.id, "main", f"free/{NAMES[0]}")["status"], "done")

    def test_follow_profile_rename_and_forget(self):
        fake = Fake()
        self._run(fake, profiles=("main",))
        fake.finish("done")
        self._run(fake, profiles=("main",))
        pkg = fake.requests[0]["package"]
        updates.follow_profile(POD.id, "main", "rename", "home")
        self.assertIsNone(bundle_defaults.record(POD.id, "main", pkg))
        self.assertEqual(bundle_defaults.record(POD.id, "home", pkg)["status"], "done")
        updates.follow_profile(POD.id, "home", "forget")
        self.assertIsNone(bundle_defaults.record(POD.id, "home", pkg))

    def test_deliver_pods_setting_limits_the_workspaces(self):
        """OKE 첫 반영은 한 작업공간에만(T2b). AAS_BUNDLE_DELIVER_PODS 가 비면 모두."""
        fake = Fake()
        other = SimpleNamespace(id="pod-b", container="hermes")
        for p in fake.patches():
            p.start()
            self.addCleanup(p.stop)
        with mock.patch.dict(os.environ, {"AAS_BUNDLE_DELIVER_PODS": " pod-b ,pod-x"}):
            bundle_defaults.reset()
            bundle_defaults.deliver([POD, other], lambda pod: ["main"])
        self.assertEqual({r["pod"] for r in fake.requests}, {"pod-b"})
        with mock.patch.dict(os.environ, {"AAS_BUNDLE_DELIVER_PODS": ""}):
            fake.finish()
            bundle_defaults.reset()
            bundle_defaults.deliver([POD, other], lambda pod: ["main"])
        self.assertIn("pod-a", {r["pod"] for r in fake.requests})

    def test_runs_at_most_once_per_interval(self):
        fake = Fake()
        for p in fake.patches():
            p.start()
            self.addCleanup(p.stop)
        bundle_defaults.reset()
        bundle_defaults.deliver([POD], lambda pod: ["main"])
        fake.finish()
        bundle_defaults.deliver([POD], lambda pod: ["main"])       # 시간 제한 안
        self.assertEqual(len(fake.requests), 1)

    def test_hub_down_skips_quietly(self):
        fake = Fake()

        def down(ns, name, cfg=None):
            raise MarketError("연결 안 됨", 503)
        for p in fake.patches():
            p.start()
            self.addCleanup(p.stop)
        with mock.patch.object(marketplace, "package", down):
            bundle_defaults.reset()
            self.assertEqual(bundle_defaults.deliver([POD], lambda pod: ["main"]), [])
        self.assertEqual(fake.requests, [])


class DefaultListTest(unittest.TestCase):
    def test_bundle_is_always_default_but_env_list_alone_goes_to_first_main(self):
        with mock.patch.dict(os.environ, {"AAS_DEFAULT_SKILLS": "free/docmost"}):
            self.assertEqual(marketplace.env_default_packages(), ["free/docmost"])
            self.assertEqual(marketplace.default_packages(), ["free/docmost"] + [f"free/{n}" for n in NAMES])
            with marketplace._conn() as conn:
                conn.execute("DELETE FROM market_default_pending WHERE pod='pod-q'")
            marketplace.queue_defaults("pod-q", "main")
            with marketplace._conn() as conn:
                got = [r[0] for r in conn.execute("SELECT package FROM market_default_pending WHERE pod='pod-q'")]
                conn.execute("DELETE FROM market_default_pending WHERE pod='pod-q'")
        self.assertEqual(got, ["free/docmost"])


class AutoDefaultTest(unittest.TestCase):
    def test_auto_upgrade_is_on_until_an_admin_turns_it_off(self):
        with store.connect() as conn:
            conn.execute("DELETE FROM meta WHERE key=?", (updates.AUTO_KEY,))
        updates._auto_forget()
        self.assertTrue(updates.auto_enabled())
        updates.set_auto(False)
        self.assertFalse(updates.auto_enabled())
        updates.set_auto(True)
        self.assertTrue(updates.auto_enabled())


if __name__ == "__main__":
    unittest.main()

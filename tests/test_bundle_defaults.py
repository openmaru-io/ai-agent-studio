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

NAMES = skill_bundle.enabled_names()
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

    def finish(self, status="done", message="", transient=False):
        for r in self.requests:
            if r["status"] == "queued":
                r.update(status=status, message=message)
                if transient:
                    r["transient"] = True
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

    # ── 일시적 오류는 간격을 늘려 다시 시도한다(OMAI-2085) ──────────────────────────────────────
    # 2026-11-17 운영 COP 업그레이드 중 스킬 허브가 다시 시작하는 동안 배달 24건이 「스킬 허브에 연결할 수 없습니다」로
    # 영구 실패가 되어 「확인할 것」에 남았다. 손으로 배달 기록을 지워야 다시 배달됐다.

    HUB_DOWN = "스킬 허브에 연결할 수 없습니다: URLError"

    def _at(self, seconds):
        """벽시계를 지금+seconds 로 둔다(배달 간격 판정만 이 시계를 본다)."""
        p = mock.patch.object(bundle_defaults, "_wall", lambda: self.t0 + seconds)
        p.start()
        self.addCleanup(p.stop)

    def _one(self):
        """묶음 패키지 하나만 허브에 있다 — 한 프로파일 한 주기 하나라 다른 패키지가 끼지 않게."""
        self.t0 = bundle_defaults._wall()
        return Fake(hub={NAMES[0]: VER[NAMES[0]]}), f"free/{NAMES[0]}"

    def test_transient_failure_retries_after_the_backoff_and_leaves_no_issue(self):
        fake, pkg = self._one()
        self._run(fake, profiles=("main",))
        fake.finish("failed", self.HUB_DOWN, transient=True)
        self._run(fake, profiles=("main",))                                   # 결과를 적는다 — 간격 전이라 다시 요청하지 않는다
        self.assertEqual(bundle_defaults.record(POD.id, "main", pkg)["status"], "retry")
        self.assertEqual(len(fake.requests), 1)
        self.assertEqual(bundle_defaults.issues(POD.id, "main"), [])            # 다시 시도하는 중에는 「확인할 것」에 없다
        self._at(bundle_defaults.backoff(1) - 5)
        self._run(fake, profiles=("main",))
        self.assertEqual(len(fake.requests), 1)
        self._at(bundle_defaults.backoff(1) + 5)
        self._run(fake, profiles=("main",))
        self.assertEqual(len(fake.requests), 2)
        fake.finish("done")
        self._run(fake, profiles=("main",))
        self.assertEqual(bundle_defaults.record(POD.id, "main", pkg)["status"], "done")
        self.assertEqual(bundle_defaults.issues(POD.id, "main"), [])

    def test_gives_up_after_max_attempts_and_shows_the_issue(self):
        fake, pkg = self._one()
        later = 0
        for _ in range(bundle_defaults.MAX_ATTEMPTS + 2):
            self._run(fake, profiles=("main",))
            fake.finish("failed", self.HUB_DOWN, transient=True)
            later += 24 * 3600
            self._at(later)
        self._run(fake, profiles=("main",))
        self.assertEqual(len(fake.requests), bundle_defaults.MAX_ATTEMPTS)
        self.assertEqual(bundle_defaults.record(POD.id, "main", pkg)["status"], "failed")
        issues = bundle_defaults.issues(POD.id, "main")
        self.assertEqual([i["code"] for i in issues], ["market_default_failed"])
        self.assertIn(self.HUB_DOWN, issues[0]["text"])

    def test_backoff_doubles_from_one_minute(self):
        self.assertEqual([bundle_defaults.backoff(n) for n in range(1, 7)], [60, 120, 240, 480, 960, 1920])

    def test_transient_error_while_making_the_request_retries_but_a_refusal_does_not(self):
        fake, pkg = self._one()

        def down(*a, **k):
            raise MarketError(self.HUB_DOWN, 503, transient=True)
        with mock.patch.object(fake, "request_install", down):
            self._run(fake, profiles=("main",))
        row = bundle_defaults.record(POD.id, "main", pkg)
        self.assertEqual((row["status"], row["attempts"]), ("retry", 1))
        self._at(bundle_defaults.backoff(1) + 5)
        self._run(fake, profiles=("main",))
        self.assertEqual(len(fake.requests), 1)                                # 간격이 지나 다시 요청했다

        fake2, _ = self._one()
        with store.connect() as conn:
            conn.execute("DELETE FROM market_bundle_delivery")

        def refused(*a, **k):
            raise MarketError("스킬 허브가 거절했습니다", 502)
        with mock.patch.object(fake2, "request_install", refused):
            self._run(fake2, profiles=("main",))
        self.assertEqual(bundle_defaults.record(POD.id, "main", pkg)["status"], "failed")

    def test_new_bundle_version_starts_the_attempts_again(self):
        fake, pkg = self._one()
        self._run(fake, profiles=("main",))
        fake.finish("failed", self.HUB_DOWN, transient=True)
        self._run(fake, profiles=("main",))
        self.assertEqual(bundle_defaults.record(POD.id, "main", pkg)["attempts"], 1)
        with mock.patch.object(skill_bundle, "front", lambda n, root=None: {"version": "99.0.0" if n == NAMES[0] else VER[n]}):
            fake.hub[NAMES[0]] = "99.0.0"
            self._run(fake, profiles=("main",))
        self.assertEqual(len(fake.requests), 2)                               # 새 판은 간격과 상관없이 바로
        self.assertEqual(bundle_defaults.record(POD.id, "main", pkg)["attempts"], 0)

    def test_old_table_gets_the_attempts_column(self):
        with store.connect() as conn:
            conn.execute("DROP TABLE IF EXISTS market_bundle_delivery")
            conn.execute("CREATE TABLE market_bundle_delivery (pod TEXT NOT NULL, profile TEXT NOT NULL, package TEXT NOT NULL, version TEXT NOT NULL, "
                         "request TEXT NOT NULL DEFAULT '', status TEXT NOT NULL, message TEXT NOT NULL DEFAULT '', ts TEXT, PRIMARY KEY (pod, profile, package))")
            conn.execute("INSERT INTO market_bundle_delivery (pod, profile, package, version, status, ts) VALUES ('pod-a','main','free/x','1.0.0','done','t')")
        bundle_defaults._MIGRATED.clear()
        self.assertEqual(bundle_defaults.record(POD.id, "main", "free/x")["attempts"], 0)

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
        # 예는 묶음에 없는 패키지여야 한다 — docmost 는 OMAI-2031 에서 묶음에 들어왔다
        with mock.patch.dict(os.environ, {"AAS_DEFAULT_SKILLS": "free/team-notes"}):
            self.assertEqual(marketplace.env_default_packages(), ["free/team-notes"])
            self.assertEqual(marketplace.default_packages(), ["free/team-notes"] + [f"free/{n}" for n in NAMES])
            with marketplace._conn() as conn:
                conn.execute("DELETE FROM market_default_pending WHERE pod='pod-q'")
            marketplace.queue_defaults("pod-q", "main")
            with marketplace._conn() as conn:
                got = [r[0] for r in conn.execute("SELECT package FROM market_default_pending WHERE pod='pod-q'")]
                conn.execute("DELETE FROM market_default_pending WHERE pod='pod-q'")
        self.assertEqual(got, ["free/team-notes"])


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

# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""사이드카 변경 색인을 뒤에서 훑어 두기(스펙 2026-11-20-001 §3-8, C안).

예전에는 /v1/changes 를 물을 때마다 폴더 전체를 훑어 OKE 에서 평균 12~13초 걸렸다(§2-2·2-4). 뒤에서 주기적으로 훑어 둔 색인으로
바로 답한다. AAS 가 고친 직후(fresh)·처음·색인이 너무 오래됐을 때만 물을 때 훑는다."""
import os
import sys
import tempfile
import threading
import time
import unittest
import unittest.mock
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "sidecar"))

from aas_sidecar import index as sc_index, ops as sc_ops  # noqa: E402

KEY = ("", (), 262_144, None)
PARAMS = {"path": "", "skip_dirs": None, "max_file": 262_144, "hashes": None}


class Clock:
    def __init__(self):
        self.now = 1000.0

    def __call__(self):
        return self.now


class FakeScan:
    """훑을 때마다 지금 목록을 돌려준다. 훑은 횟수를 센다."""

    def __init__(self):
        self.files = {"a.md": 1}
        self.count = 0
        self.truncated = False
        self.gate = None

    def __call__(self, params):
        self.count += 1
        if self.gate is not None:
            self.gate.wait(5)
        if self.truncated:
            return {"entries": [], "partial": [], "truncated": True}
        return {"entries": [{"path": p, "type": "file", "size": s, "mtime": float(s)} for p, s in sorted(self.files.items())], "partial": []}


def index(every=20.0):
    clock, scan = Clock(), FakeScan()
    return sc_index.ChangeIndex(scan, clock=clock, every=every, thread=False), clock, scan


class BackgroundIndexTest(unittest.TestCase):
    def test_changes_are_answered_from_the_background_scan_without_scanning(self):
        ix, clock, scan = index()
        first = ix.changes(KEY, "", PARAMS)                             # 처음은 물을 때 훑는다
        self.assertEqual(scan.count, 1)
        self.assertTrue(first["reset"])
        cursor = first["cursor"]
        clock.now += 30
        out = ix.changes(KEY, cursor, PARAMS)                           # 120초 안 — 훑지 않고 색인으로 답한다
        self.assertEqual(scan.count, 1)
        self.assertEqual(out["entries"], [])
        scan.files["b.md"] = 2
        self.assertEqual(ix.scan_due(), 1)                              # 뒤 훑기가 바뀐 것을 적는다
        self.assertEqual(scan.count, 2)
        clock.now += 5
        out = ix.changes(KEY, cursor, PARAMS)
        self.assertEqual(scan.count, 2)
        self.assertEqual([e["path"] for e in out["entries"]], ["b.md"])
        self.assertFalse(out["reset"])

    def test_scan_due_waits_for_the_gap_after_the_last_scan(self):
        ix, clock, scan = index(every=20.0)
        ix.changes(KEY, "", PARAMS)
        clock.now += 10
        self.assertEqual(ix.scan_due(), 0)
        clock.now += 10
        self.assertEqual(ix.scan_due(), 1)
        self.assertEqual(scan.count, 2)

    def test_fresh_always_scans_right_away(self):
        ix, clock, scan = index()
        cursor = ix.changes(KEY, "", PARAMS)["cursor"]
        scan.files["a.md"] = 9                                          # AAS 가 방금 고쳤다
        out = ix.changes(KEY, cursor, PARAMS, fresh=True)
        self.assertEqual(scan.count, 2)
        self.assertEqual([e["path"] for e in out["entries"]], ["a.md"])

    def test_too_old_index_is_scanned_when_asked(self):
        ix, clock, scan = index()
        cursor = ix.changes(KEY, "", PARAMS)["cursor"]
        clock.now += sc_index.SERVE_MAX + 1                             # 뒤 훑기가 멈췄거나 계속 실패했다
        ix.changes(KEY, cursor, PARAMS)
        self.assertEqual(scan.count, 2)

    def test_folders_nobody_asked_about_lately_are_not_scanned(self):
        ix, clock, scan = index()
        ix.changes(KEY, "", PARAMS)
        clock.now += sc_index.ACTIVE + 1
        self.assertEqual(ix.scan_due(), 0)
        self.assertEqual(scan.count, 1)

    def test_tree_cursor_alone_makes_the_folder_scanned_behind(self):
        ix, clock, scan = index()
        ix.record(KEY, scan(PARAMS), PARAMS)                            # /v1/tree(cursor) 가 처음 목록을 넣는다
        clock.now += 20
        self.assertEqual(ix.scan_due(), 1)

    def test_truncated_background_scan_drops_the_index(self):
        ix, clock, scan = index()
        cursor = ix.changes(KEY, "", PARAMS)["cursor"]
        scan.truncated = True
        clock.now += 20
        ix.scan_due()
        out = ix.changes(KEY, cursor, PARAMS)
        self.assertTrue(out["reset"])
        self.assertTrue(out.get("truncated"))

    def test_failed_background_scan_keeps_the_index_and_logs_once(self):
        ix, clock, scan = index()
        cursor = ix.changes(KEY, "", PARAMS)["cursor"]

        def broken(params):
            raise OSError("nfs")
        ix._scan = broken
        out = []
        with unittest.mock.patch("builtins.print", lambda *a, **k: out.append(a[0])):
            clock.now += 20
            ix.scan_due()
            clock.now += 20
            ix.scan_due()
        self.assertEqual(len(out), 1, out)
        self.assertIn("OSError", out[0])
        ix._scan = scan
        self.assertFalse(ix.changes(KEY, cursor, PARAMS)["reset"])      # 지난 색인으로 답한다

    def test_a_long_scan_does_not_hold_up_other_folders(self):
        ix, clock, scan = index()
        other = ("skills", (), 262_144, None)
        ix.changes(KEY, "", PARAMS)
        ix.changes(other, "", {**PARAMS, "path": "skills"})
        scan.gate = threading.Event()
        clock.now += 20
        t = threading.Thread(target=ix.changes, args=(KEY, "", PARAMS), kwargs={"fresh": True})
        t.start()
        time.sleep(0.1)                                                 # KEY 를 훑는 중
        began = time.monotonic()
        ix.changes(other, "", {**PARAMS, "path": "skills"})             # 다른 폴더는 색인으로 바로 답한다
        self.assertLess(time.monotonic() - began, 1.0)
        scan.gate.set()
        t.join(5)

    def test_old_mode_without_background_scans_when_asked(self):
        ix, clock, scan = index(every=0.0)
        cursor = ix.changes(KEY, "", PARAMS)["cursor"]
        clock.now += sc_index.REUSE + 0.1
        ix.changes(KEY, cursor, PARAMS)
        self.assertEqual(scan.count, 2)                                 # 예전처럼 2초가 지나면 다시 훑는다
        clock.now += 30
        self.assertEqual(ix.scan_due(), 0)

    def test_thread_starts_once_in_background_mode(self):
        clock, scan = Clock(), FakeScan()
        ix = sc_index.ChangeIndex(scan, clock=clock, every=20.0)
        with unittest.mock.patch.object(sc_index.threading, "Thread") as thread:
            ix.changes(KEY, "", PARAMS)
            ix.changes(KEY, "", PARAMS)
        self.assertEqual(thread.call_count, 1)
        self.assertEqual(thread.call_args.kwargs.get("name"), "aas-sidecar-index")


class OpsBackgroundIndexTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        (self.root / "skills").mkdir()
        (self.root / "config.yaml").write_text("model: a\n")

    def tearDown(self):
        self.tmp.cleanup()

    def test_real_folder_change_is_seen_by_the_background_scan(self):
        ops = sc_ops.Ops(self.root, index_every=20.0)
        ops.index._thread_on = False
        clock = Clock()
        ops.index._clock = clock
        got = ops.tree("", cursor=True)
        (self.root / "config.yaml").write_text("model: changed\n")
        os.utime(self.root / "config.yaml", (2_000_000_000, 2_000_000_000))
        clock.now += 20
        self.assertEqual(ops.index.scan_due(), 1)
        with unittest.mock.patch.object(ops.index, "_scan", side_effect=AssertionError("물을 때 훑으면 안 된다")):
            out = ops.changes(got["cursor"])
        self.assertEqual([e["path"] for e in out["entries"]], ["config.yaml"])

    def test_every_comes_from_the_environment(self):
        self.assertEqual(sc_ops.index_every_from_env({}), sc_ops.DEFAULT_INDEX_EVERY)
        self.assertEqual(sc_ops.index_every_from_env({"AAS_SIDECAR_INDEX_EVERY": "0"}), 0.0)
        self.assertEqual(sc_ops.index_every_from_env({"AAS_SIDECAR_INDEX_EVERY": "45"}), 45.0)
        self.assertEqual(sc_ops.index_every_from_env({"AAS_SIDECAR_INDEX_EVERY": "x"}), sc_ops.DEFAULT_INDEX_EVERY)
        self.assertEqual(sc_ops.index_every_from_env({"AAS_SIDECAR_INDEX_EVERY": "-3"}), sc_ops.DEFAULT_INDEX_EVERY)

    def test_plain_ops_keeps_the_old_ask_time_scan(self):
        self.assertEqual(sc_ops.Ops(self.root).index._every, 0.0)       # 시험·로컬은 예전 동작


class PeriodicPodWorkersTest(unittest.TestCase):
    """서버가 뜰 때 도는 주기 작업이 작업공간 8개를 동시에 처음 받아 서로 느려졌다(9cb4 37.9초, §3-3). 2개씩만."""

    def test_each_pod_runs_two_workspaces_at_a_time(self):
        from aas.web import server
        seen = {}

        def fake(pods, fn, **kw):
            seen.update(kw)
            return {p.id: (True, fn(p)) for p in pods}
        pods = [SimpleNamespace(id=f"w-{i}") for i in range(9)]
        with unittest.mock.patch.object(server.collect_all, "map_pods", fake):
            server._each_pod(pods, lambda pod: [], "t")
        self.assertEqual(seen["workers"], server.PERIODIC_POD_WORKERS)
        self.assertEqual(server.PERIODIC_POD_WORKERS, 2)

    def test_ticker_health_and_dashboard_rounds_run_two_at_a_time(self):
        """뜬 직후 ticker 의 상태 모으기·대시보드 바퀴가 기본 8개로 돌아 처음 받기 6개가 함께 11~30초 걸렸다(OKE 10:01, §3-9)."""
        from aas import __main__ as cli
        from aas.ops import collect_all, dashboard
        seen = []

        def fake(pods, fn, workers=None, timeout=None):
            seen.append(workers)
            return {}
        pods = [SimpleNamespace(id=f"w-{i}", hermes_home="h") for i in range(5)]
        with unittest.mock.patch.object(collect_all, "map_pods", fake), \
                unittest.mock.patch.object(cli.owner, "mine", lambda pods, *a: pods), \
                unittest.mock.patch.object(cli.server, "_alive_origins", lambda: []), \
                unittest.mock.patch("aas.office.shared.put_health", lambda *a: None), \
                unittest.mock.patch("aas.office.shared.get_health", lambda slot: {}), \
                unittest.mock.patch.object(collect_all, "merge", lambda rows, n: {}), \
                unittest.mock.patch.object(dashboard.store, "save_pod_summary", lambda *a, **k: None), \
                unittest.mock.patch.object(dashboard.models, "fetch_litellm", side_effect=OSError("x")), \
                unittest.mock.patch.object(dashboard.store, "connect", side_effect=OSError("x")):
            cli._collect_mine_health("s", pods)
            cli._merge_health("s", pods)
            with self.assertRaises(OSError):
                dashboard.record_round(pods, {})
        self.assertEqual(seen, [collect_all.BACKGROUND_WORKERS] * 3)
        self.assertEqual(collect_all.BACKGROUND_WORKERS, 2)
        self.assertEqual(server_workers(), collect_all.BACKGROUND_WORKERS)


def server_workers():
    from aas.web import server
    return server.PERIODIC_POD_WORKERS


if __name__ == "__main__":
    unittest.main()

# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""서버가 뜬 뒤 제한을 둔 묶음 미리 받기(스펙 2026-11-20-001 §5-0 0-4 A2).

배포 직후 첫 화면은 묶음이 없어 에이전트마다 처음부터 받는다(20~60초, 「응답 없음」). 최근 7일 사람이 쓴 에이전트만 최대 20개,
복제본마다 동시 1개로 미리 받아 두고, 미리 받은 묶음은 버리기 시간만큼 유예해 다음 정리 바퀴에 바로 버리지 않는다."""
import os
import tempfile
import threading
import unittest
from datetime import datetime, timedelta
from pathlib import Path
from unittest import mock

TMP = tempfile.TemporaryDirectory()
os.environ["AAS_DATA_DIR"] = str(Path(TMP.name) / "data")

from aas.common import store  # noqa: E402
from aas.hermes.readers import tree_cache  # noqa: E402
from aas.ops import tree_prewarm  # noqa: E402


class Backend:
    """미리 받기가 보는 백엔드 필드만 흉내 낸다."""

    def __init__(self, label, fail=False):
        self.label, self.fail = label, fail
        self._has_tree, self._tree_failed_at, self.fail_memo, self._cut_warned, self._down_at = None, 0.0, 30.0, False, 0.0
        self.tree = False
        self.calls = 0
        self.human_at_call = None
        self.dropped = None

    def has_tree(self):
        return self.tree

    def entry_count(self):
        return 1 if self.tree else 0

    def snapshot(self):
        self.calls += 1
        self.human_at_call = tree_cache.HUMAN.get()
        if self.fail:
            raise OSError("사이드카에 연결할 수 없습니다")
        self.tree = True
        return True

    def drop(self, kind="manual"):
        self.tree, self.dropped = False, kind


class Pod:
    def __init__(self, pid, backend):
        self.id = pid
        self.hermes_home = type("H", (), {"backend": backend})()


class PrewarmTest(unittest.TestCase):
    def setUp(self):
        self.saved_used, self.saved_grace = dict(tree_cache._used), dict(tree_cache._grace)
        tree_cache._used.clear()
        tree_cache._grace.clear()
        self.clock = [1000.0]

    def tearDown(self):
        tree_cache._used.clear(); tree_cache._used.update(self.saved_used)
        tree_cache._grace.clear(); tree_cache._grace.update(self.saved_grace)

    def run_with(self, pods, recent, **kw):
        kw.setdefault("start_delay", 0)
        return tree_prewarm.run(lambda: {p.id: p for p in pods}, lambda limit: recent[:limit],
                                clock=lambda: self.clock[0], **kw)

    def test_최근_쓴_에이전트만_차례로_받고_미리_받은_묶음은_유예한다(self):
        a, b, c = Backend("a"), Backend("b"), Backend("c")
        got = self.run_with([Pod("a", a), Pod("b", b), Pod("c", c)], ["a", "b"])
        self.assertEqual((a.calls, b.calls, c.calls), (1, 1, 0))          # 최근에 쓰지 않은 c 는 받지 않는다
        self.assertEqual(got["warmed"], ["a", "b"])
        self.assertFalse(a.human_at_call)                                  # 배경 스레드 — 사람의 요청이 아니다
        self.assertNotIn("a", tree_cache._used)
        # 다음 정리 바퀴(5분 뒤)에 버리지 않고, 유예(버리기 시간)가 끝나면 버린다
        self.assertEqual(tree_cache.sweep([a, b], now=1000.0 + 300), [])
        self.assertEqual(sorted(tree_cache.sweep([a, b], now=1000.0 + tree_cache.idle_drop() + 1)), ["a", "b"])

    def test_배경_작업이_먼저_받아_둔_묶음도_유예해_첫_정리에서_버리지_않는다(self):
        """OKE(2026-11-20 #694): 서버가 뜰 때 도는 배경 작업이 먼저 받은 에이전트를 「이미 묶음 있음」으로 건너뛰어 유예가 없었고,
        첫 정리 바퀴(5분)에 그 수만큼 버려졌다(건너뜀 4 → 버림 4). 이미 있으면 다시 받지 않고 유예만 건다."""
        early, fresh = Backend("early"), Backend("fresh")
        early.tree = True                                                   # 배경 작업이 먼저 받음
        got = self.run_with([Pod("early", early), Pod("fresh", fresh)], ["early", "fresh"])
        self.assertEqual(early.calls, 0)                                    # 다시 받지 않는다
        self.assertEqual(got["kept"], ["early"])
        self.assertEqual(tree_cache.sweep([early, fresh], now=1000.0 + 300), [])

    def test_한_번에_하나씩만_받는다(self):
        lock, state = threading.Lock(), {"now": 0, "max": 0}

        class Slow(Backend):
            def snapshot(inner):
                with lock:
                    state["now"] += 1; state["max"] = max(state["max"], state["now"])
                with lock:
                    state["now"] -= 1
                return super().snapshot()
        pods = [Pod(f"p{i}", Slow(f"p{i}")) for i in range(5)]
        self.run_with(pods, [p.id for p in pods])
        self.assertEqual(state["max"], 1)

    def test_대상은_최대_20개(self):
        pods = [Pod(f"p{i}", Backend(f"p{i}")) for i in range(30)]
        got = self.run_with(pods, [p.id for p in pods])
        self.assertEqual(len(got["warmed"]), 20)

    def test_이미_묶음이_있거나_실패_잘림_응답없음_옛_사이드카면_건너뛴다(self):
        has, failed, cut, down, old, ok = (Backend(x) for x in ("has", "failed", "cut", "down", "old", "ok"))
        has.tree = True                                                     # 이미 있음 — 받지 않고 유예만(kept)
        failed._tree_failed_at = 999.0                                      # fail_memo(30초) 안
        cut._cut_warned = True
        down._down_at = 995.0
        old._has_tree = False
        pods = [Pod(b.label, b) for b in (has, failed, cut, down, old, ok)]
        with mock.patch.object(tree_prewarm.time, "monotonic", lambda: 1000.0):
            got = self.run_with(pods, [p.id for p in pods])
        self.assertEqual(got["warmed"], ["ok"])
        self.assertEqual(sorted(got["skipped"]), ["cut", "down", "failed", "old"])
        self.assertEqual(got["kept"], ["has"])
        self.assertEqual(sum(b.calls for b in (has, failed, cut, down, old)), 0)

    def test_실패해도_다음으로_가고_등록부에서_사라진_에이전트는_건너뛴다(self):
        bad, ok = Backend("bad", fail=True), Backend("ok")
        got = self.run_with([Pod("bad", bad), Pod("ok", ok)], ["bad", "gone", "ok"])
        self.assertEqual((got["failed"], got["warmed"]), (["bad"], ["ok"]))
        self.assertIn("gone", got["skipped"])

    def test_전체_시간_상한을_넘으면_멈춘다(self):
        class Tick(Backend):
            def snapshot(inner, clock=self.clock):
                clock[0] += 400                                              # 하나에 400초
                return super().snapshot()
        pods = [Pod(f"p{i}", Tick(f"p{i}")) for i in range(5)]
        got = self.run_with(pods, [p.id for p in pods], budget=600)
        self.assertEqual(len(got["warmed"]), 2)                              # 0초·400초에 시작한 둘만

    def test_멈춤_신호가_오면_시작하지_않는다(self):
        stop = threading.Event(); stop.set()
        a = Backend("a")
        got = self.run_with([Pod("a", a)], ["a"], stop=stop, start_delay=60)
        self.assertEqual((a.calls, got["warmed"]), (0, []))

    def test_기본은_켬이고_끄는_값이면_돌지_않는다(self):
        env = {k: v for k, v in os.environ.items() if k != "AAS_TREE_PREWARM"}
        with mock.patch.dict(os.environ, env, clear=True):
            self.assertTrue(tree_prewarm.enabled())                          # 기본 켬(OKE 시험 뒤, 스펙 §5-0-5·6)
        for value, on in (("", True), ("0", False), ("off", False), ("false", False), ("no", False), ("1", True), ("on", True)):
            with self.subTest(value=value), mock.patch.dict(os.environ, {"AAS_TREE_PREWARM": value}):
                self.assertEqual(tree_prewarm.enabled(), on)

    def test_유예_중인_묶음은_상한을_넘으면_사람이_쓴_묶음보다_먼저_버린다(self):
        warm, used = Backend("warm"), Backend("used")
        warm.tree = used.tree = True
        tree_cache.grace("warm", 1000.0 + 3600)
        tree_cache._used["used"] = 999.0
        with mock.patch.object(tree_cache, "cap_bytes", lambda: 1), mock.patch.object(tree_cache, "ENTRY_BYTES", 1):
            dropped = tree_cache.sweep([warm, used], now=1000.0)
        self.assertEqual(dropped[0], "warm")


class RecentPodsTest(unittest.TestCase):
    def test_최근_7일_사람이_쓴_에이전트를_많이_쓴_순으로(self):
        with store.connect() as conn:
            conn.execute("DELETE FROM usage")
        for pod, n in (("a", 3), ("b", 1), ("", 5), ("*", 4)):
            for _ in range(n):
                store.log_usage("console_view", pod=pod)
        old = (datetime.now().astimezone() - timedelta(days=8)).isoformat(timespec="seconds")
        with store.connect() as conn:
            conn.execute("INSERT INTO usage (ts, kind, note, pod) VALUES (?,?,?,?)", (old, "console_view", "", "c"))
        self.assertEqual(store.recent_pods(days=7, limit=20), ["a", "b"])   # 빈 칸·「*」·8일 전은 뺀다
        self.assertEqual(store.recent_pods(days=7, limit=1), ["a"])
        with store.connect() as conn:
            conn.execute("DELETE FROM usage")


if __name__ == "__main__":
    unittest.main()

# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""에이전트마다 담당 서버(스펙 2026-10-24-013 3단계 R11·D4·D5): 담당 정하기, 에이전트별 오피스 재료, 프로파일 맞추기·상태 수집 나누기."""
import os
import tempfile
import unittest
import unittest.mock
from pathlib import Path

TMP = tempfile.TemporaryDirectory()
os.environ.setdefault("AAS_DATA_DIR", str(Path(TMP.name) / "data"))

from aas.common import owner  # noqa: E402
from aas.office import shared  # noqa: E402


class Clock:
    def __init__(self):
        self.t = 1000.0

    def __call__(self):
        return self.t


def pod(pid):
    return unittest.mock.Mock(id=pid)


class OwnerTest(unittest.TestCase):
    def test_서버가_하나면_모두_내_몫(self):
        pods = [pod(f"p{i}") for i in range(20)]
        self.assertEqual(owner.mine(pods, "me", ["me"]), pods)

    def test_두_서버면_몫이_겹치지_않고_합이_전부(self):
        pods = [pod(f"p{i}") for i in range(200)]
        a, b = owner.mine(pods, "a", ["a", "b"]), owner.mine(pods, "b", ["b", "a"])
        self.assertFalse({p.id for p in a} & {p.id for p in b})
        self.assertEqual({p.id for p in a} | {p.id for p in b}, {p.id for p in pods})
        self.assertGreater(len(a), 50)                                # 대략 고르게
        self.assertGreater(len(b), 50)

    def test_서버가_늘면_일부만_옮겨_간다(self):
        pods = [pod(f"p{i}") for i in range(300)]
        before = {p.id: owner.owner_of(p.id, ["a", "b"]) for p in pods}
        after = {p.id: owner.owner_of(p.id, ["a", "b", "c"]) for p in pods}
        moved = [k for k in before if before[k] != after[k]]
        self.assertTrue(all(after[k] == "c" for k in moved))          # 새 서버로만 옮긴다
        self.assertLess(len(moved), 200)

    def test_목록에_내가_없어도_나는_살아_있는_서버로_친다(self):
        x = pod("x")
        self.assertEqual(owner.mine([x], "me", []), [x])


class CollectedPodTest(unittest.TestCase):
    def setUp(self):
        with shared._connect() as conn:
            conn.execute("DELETE FROM office_collected_pod")
        self.clock = Clock()
        self.s = shared.Shared("srv-a", clock=self.clock)

    tearDown = setUp

    def test_에이전트별로_적고_오래된_줄은_빼고_읽는다(self):
        self.s.put_collected_pods({"p1": ({("p1", "main")}, set(), False), "p2": (set(), {("p2", "x")}, True)})
        got = self.s.get_collected_pods(15)
        self.assertEqual(got["p1"], ({("p1", "main")}, set(), False))
        self.assertEqual(got["p2"], (set(), {("p2", "x")}, True))
        self.clock.t += 16
        self.assertEqual(self.s.get_collected_pods(15), {})

    def test_살아_있는_서버_목록(self):
        self.s.heartbeat()
        self.assertIn("srv-a", self.s.alive_servers())


class ServerOwnerTest(unittest.TestCase):
    def test_내_몫만_사이드카를_읽고_줄은_합쳐_쓴다(self):
        from aas.web import server
        pods = [unittest.mock.Mock(id=f"p{i}") for i in range(10)]
        reg = unittest.mock.Mock(pods=pods)
        seats = [{"pod": p.id, "profile": "main", "alias": p.id, "enabled": True} for p in pods]
        read = []

        def health(p):
            read.append(p.id)
            return {"failed_jobs": []}
        mine_ids = {p.id for p in owner.mine(pods, "me", ["me", "other"])}
        with unittest.mock.patch.object(server, "_health", side_effect=health), \
                unittest.mock.patch.object(server, "_running_profiles", return_value=set()), \
                unittest.mock.patch.object(server.office, "seats", return_value=seats), \
                unittest.mock.patch.object(server.SHARED, "origin", "me"), \
                unittest.mock.patch.object(server.SHARED, "alive_servers", return_value=["me", "other"]), \
                unittest.mock.patch.object(server.SHARED, "put_collected_pods") as put:
            server._collect_mine(reg)
        self.assertEqual(set(read), mine_ids)
        self.assertEqual(set(put.call_args[0][0]), mine_ids)

    def test_줄이_없는_에이전트는_직접_읽어_합친다(self):
        from aas.web import server
        pods = [unittest.mock.Mock(id="p1"), unittest.mock.Mock(id="p2")]
        seats = [{"pod": p.id, "profile": "main", "alias": p.id, "enabled": True} for p in pods]
        rows = {"p1": ({("p1", "main")}, set(), False)}
        read = []
        with unittest.mock.patch.object(server, "_health", side_effect=lambda p: read.append(p.id) or {"failed_jobs": []}), \
                unittest.mock.patch.object(server, "_running_profiles", return_value=set()), \
                unittest.mock.patch.object(server.SHARED, "get_collected_pods", return_value=rows):
            failed, running, bad = server._merged_collected(pods, seats)
        self.assertEqual(read, ["p2"])
        self.assertEqual(failed, {("p1", "main")})

    def test_프로파일_맞추기는_내_몫만(self):
        from aas.web import server
        pods = [unittest.mock.Mock(id=f"p{i}") for i in range(10)]
        reg = unittest.mock.Mock(pods=pods, is_admin=lambda u: True)
        with unittest.mock.patch.object(server.SHARED, "origin", "me"), \
                unittest.mock.patch.object(server.SHARED, "alive_servers", return_value=["me", "other"]):
            view = server._my_registry(reg)
        self.assertEqual([p.id for p in view.pods], [p.id for p in owner.mine(pods, "me", ["me", "other"])])
        self.assertTrue(view.is_admin("x"))                            # 다른 속성은 그대로


class HealthRoundTest(unittest.TestCase):
    def setUp(self):
        with shared._connect() as conn:
            conn.execute("DELETE FROM health_collected")

    tearDown = setUp

    def row(self, pid):
        from aas.ops import collect_all
        return collect_all.scoped({"collected_at": "2026-10-24T10:00:00+09:00", "profiles": [{"name": "main"}], "incidents": [],
                                   "failed_jobs": [], "stalled": [], "silent": [], "totals": {}}, pid)

    def test_담당_서버가_적은_줄을_리더가_합치고_빠진_것은_직접_읽는다(self):
        from aas import __main__ as main
        pods = [unittest.mock.Mock(id="p1"), unittest.mock.Mock(id="p2")]
        shared.put_health("10:00", "p1", self.row("p1"))
        read = []

        def rows(pp):
            read.extend(p.id for p in pp)
            return {p.id: self.row(p.id) for p in pp}
        with unittest.mock.patch.object(main.collect_all, "collect_rows", side_effect=rows):
            merged = main._merge_health("10:00", pods)
        self.assertEqual(read, ["p2"])
        self.assertEqual(merged["pods"]["total"], 2)
        self.assertEqual(len(merged["profiles"]), 2)

    def test_내_몫만_수집해_줄로_적는다(self):
        from aas import __main__ as main
        pods = [unittest.mock.Mock(id=f"p{i}") for i in range(6)]
        mine = owner.mine(pods, "me", ["me", "other"])
        with unittest.mock.patch.object(main.collect_all, "collect_rows", side_effect=lambda pp: {p.id: self.row(p.id) for p in pp}), \
                unittest.mock.patch.object(main.server.SHARED, "origin", "me"), \
                unittest.mock.patch.object(main.server.SHARED, "alive_servers", return_value=["me", "other"]):
            main._collect_mine_health("10:30", pods)
        self.assertEqual(set(shared.get_health("10:30")), {p.id for p in mine})


if __name__ == "__main__":
    unittest.main()

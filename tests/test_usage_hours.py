# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""스킬 사용 시간 칸 표 셋(스펙 2026-11-19-005 U1): 임대·덮어쓰기·커서 앞으로만·지우기·이름 바꾸기."""
import os
import tempfile
import threading
import unittest
from pathlib import Path

TMP = tempfile.TemporaryDirectory()
os.environ.setdefault("AAS_DATA_DIR", str(Path(TMP.name) / "data"))

from aas.common import store  # noqa: E402
from aas.ops import usage_hours as uh  # noqa: E402

POD = "uh-test"
T0 = 1_800_000_000.0
H0 = int(T0) // 3600


def clean():
    with store.connect() as conn:
        for table in ("skill_usage_hours", "skill_usage_sessions", "skill_usage_cursor"):
            conn.execute(f"DELETE FROM {table} WHERE pod=?", (POD,))


def write(owner="a", *, from_hour=H0, to_hour=H0, hours=None, sessions=(), ts=T0, unknown=(), profile="p"):
    return uh.save(POD, profile, owner, spans=[(from_hour, to_hour)], hours=hours or {}, sessions=list(sessions),
                   ts=ts, unknown=list(unknown))


class Lease(unittest.TestCase):
    def setUp(self):
        clean()

    tearDown = setUp

    def test_한_복제본만_읽고_만료되면_다른_쪽이_잡는다(self):
        self.assertTrue(uh.acquire(POD, "p", "a", now=T0))
        self.assertFalse(uh.acquire(POD, "p", "b", now=T0 + 10))
        self.assertTrue(uh.acquire(POD, "p", "a", now=T0 + 10))          # 같은 owner 는 늘린다
        self.assertTrue(uh.acquire(POD, "p", "b", now=T0 + 10 + uh.LEASE_SECONDS + 1))

    def test_풀면_바로_다른_쪽이_잡는다(self):
        uh.acquire(POD, "p", "a", now=T0)
        uh.release(POD, "p", "a")
        self.assertTrue(uh.acquire(POD, "p", "b", now=T0 + 1))

    def test_임대를_쥐지_않으면_쓰지_않는다(self):
        uh.acquire(POD, "p", "a", now=T0)
        self.assertFalse(write("b", hours={(H0, "skill", "x", ""): 3}))
        self.assertEqual(uh.hours(POD, H0), [])

    def test_두_스레드가_동시에_잡아도_하나만_얻는다(self):
        got = []
        barrier = threading.Barrier(2)

        def grab(owner):
            barrier.wait()
            got.append(uh.acquire(POD, "p", owner, now=T0))
        threads = [threading.Thread(target=grab, args=(o,)) for o in ("a", "b")]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        self.assertEqual(sorted(got), [False, True])


class Save(unittest.TestCase):
    def setUp(self):
        clean()
        uh.acquire(POD, "p", "a", now=T0)

    tearDown = setUp

    def test_다시_센_구간은_통째로_바뀌고_겹쳐_세지_않는다(self):
        write(hours={(H0, "skill", "x", ""): 2, (H0, "skill", "y", ""): 1})
        write(hours={(H0, "skill", "x", ""): 3})                          # 같은 칸을 다시 셌다 — y 는 사라졌다
        self.assertEqual(uh.hours(POD, H0), [{"profile": "p", "kind": "skill", "name": "x", "job": "", "n": 3}])

    def test_구간_밖의_칸은_그대로다(self):
        write(hours={(H0 - 5, "skill", "x", ""): 4}, from_hour=H0 - 5, to_hour=H0 - 5)
        write(hours={(H0, "skill", "x", ""): 1})
        self.assertEqual(uh.hours(POD, H0 - 10)[0]["n"], 5)

    def test_크론_작업은_따로_센다(self):
        write(hours={(H0, "tool", "terminal", ""): 2, (H0, "tool", "terminal", "j1"): 1})
        jobs = {r["job"]: r["n"] for r in uh.hours(POD, H0, ("tool",))}
        self.assertEqual(jobs, {"": 2, "j1": 1})

    def test_커서는_앞으로만_간다(self):
        write(ts=T0 + 100)
        write(ts=T0 + 50)                                                  # 느린 쪽이 더 이른 값으로 써도
        self.assertEqual(uh.cursor(POD, "p")["ts"], T0 + 100)
        self.assertEqual(uh.cursor(POD, "p")["filled_from"], T0 + 100)

    def test_세션_마지막_시각은_줄지_않는다(self):
        write(sessions=[{"session_id": "s1", "started_at": T0, "last_at": T0 + 30}])
        write(sessions=[{"session_id": "s1", "started_at": T0, "last_at": T0 + 10}])
        self.assertEqual(uh.sessions(POD, T0)[0]["last_at"], T0 + 30)

    def test_모름_구간을_기억한다(self):
        write(unknown=[[T0 - 3600, T0]])
        self.assertEqual(uh.cursor(POD, "p")["unknown"], [[T0 - 3600, T0]])

    def test_많은_행도_나눠서_넣는다(self):
        many = {(H0, "tool", f"t{i}", ""): 1 for i in range(450)}
        write(hours=many)
        self.assertEqual(len(uh.hours(POD, H0)), 450)


class Housekeeping(unittest.TestCase):
    def setUp(self):
        clean()
        uh.acquire(POD, "p", "a", now=T0)

    tearDown = setUp

    def test_오래된_칸과_세션을_지운다(self):
        old_skill, old_tool = H0 - 91 * 24, H0 - 15 * 24
        write(hours={(old_skill, "skill", "x", ""): 1, (old_tool, "tool", "t", ""): 1, (old_tool, "skill", "y", ""): 1},
              from_hour=old_skill, to_hour=H0,
              sessions=[{"session_id": "old", "last_at": T0 - 91 * 86400}, {"session_id": "new", "last_at": T0}])
        uh.prune(POD, now=T0)
        self.assertEqual({(r["kind"], r["name"]) for r in uh.hours(POD, 0)}, {("skill", "y")})   # 14일 넘은 skill 은 남는다
        self.assertEqual([s["session_id"] for s in uh.sessions(POD, 0)], ["new"])

    def test_이름을_바꾸면_세_표가_함께_바뀐다(self):
        write(hours={(H0, "skill", "x", ""): 1}, sessions=[{"session_id": "s", "last_at": T0}])
        uh.rename_profile(POD, "p", "q")
        self.assertEqual({r["profile"] for r in uh.hours(POD, H0)}, {"q"})
        self.assertEqual({s["profile"] for s in uh.sessions(POD, 0)}, {"q"})
        self.assertIsNotNone(uh.cursor(POD, "q"))
        self.assertIsNone(uh.cursor(POD, "p"))

    def test_프로파일을_지우면_행이_모두_지워진다(self):
        write(hours={(H0, "skill", "x", ""): 1}, sessions=[{"session_id": "s", "last_at": T0}])
        uh.delete_profile(POD, "p")
        self.assertEqual(uh.hours(POD, 0), [])
        self.assertEqual(uh.sessions(POD, 0), [])
        self.assertEqual(uh.cursors(POD), {})


if __name__ == "__main__":
    unittest.main()

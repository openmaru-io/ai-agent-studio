# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""오피스 접속자 시험(계획 007 P6a, R6): 30초 동안 신호가 없으면 빠지고, 이메일은 관리자에게만 보인다."""
import os
import tempfile
import unittest
from pathlib import Path

TMP = tempfile.TemporaryDirectory()
os.environ.setdefault("AAS_DATA_DIR", str(Path(TMP.name) / "data"))

from aas.office.presence import Presence, _connect, person_id  # noqa: E402


def clear():
    with _connect() as conn:
        conn.execute("DELETE FROM office_presence")


class Clock:
    def __init__(self):
        self.t = 1000.0

    def __call__(self):
        return self.t


class PresenceTest(unittest.TestCase):
    tearDown = staticmethod(clear)

    def setUp(self):
        clear()
        self.clock = Clock()
        self.p = Presence(ttl=30, clock=self.clock)

    def test_신호가_30초_없으면_빠진다(self):
        self.p.beat("a@x.com", "김", "")
        self.clock.t += 29
        self.assertEqual(len(self.p.view("b@x.com", False)), 1)
        self.clock.t += 2
        self.assertEqual(self.p.view("b@x.com", False), [])

    def test_이메일은_관리자에게만_보이고_나를_맨_앞에_둔다(self):
        self.p.beat("b@x.com", "나", "")
        self.p.beat("a@x.com", "가", "seed-a")
        rows = self.p.view("b@x.com", False)
        self.assertEqual([r["name"] for r in rows], ["나", "가"])
        self.assertTrue(rows[0]["me"])
        self.assertNotIn("email", rows[0])
        self.assertTrue(all("@" not in str(v) for r in rows for v in r.values()))
        self.assertEqual(self.p.view("x@x.com", True)[0]["email"], "a@x.com")

    def test_얼굴_시드가_없으면_이메일을_드러내지_않는_id_를_쓴다(self):
        self.p.beat("a@x.com", "", "")
        row = self.p.view("", False)[0]
        self.assertEqual(row["seed"], person_id("a@x.com"))
        self.assertEqual(row["name"], "a")

    def test_떠나면_바로_빠진다(self):
        self.p.beat("a@x.com", "가", "")
        self.p.leave("A@x.com")
        self.assertEqual(self.p.view("", True), [])


if __name__ == "__main__":
    unittest.main()


class MoveTest(unittest.TestCase):
    """내 아바타로 걷기(계획 007 P6b)."""
    tearDown = staticmethod(clear)

    def setUp(self):
        clear()
        self.p = Presence(ttl=30, clock=lambda: 1000.0)
        self.p.beat("a@x.com", "가", "")
        self.p.beat("b@x.com", "나", "")

    def test_오피스에_있는_사람만_움직이고_위치에는_이메일이_없다(self):
        self.assertIsNone(self.p.move("z@x.com", 1, 2, 0))
        out = self.p.move("a@x.com", 10.04, 20, 90)
        self.assertEqual(out, {"id": person_id("a@x.com"), "x": 10.0, "y": 20.0, "f": 90.0, "sit": ""})
        self.assertEqual(self.p.view("b@x.com", False)[1]["pos"]["x"], 10.0)

    def test_같은_의자는_먼저_요청한_사람이_앉는다(self):
        self.assertEqual(self.p.move("a@x.com", 1, 1, 0, sit="chair_1")["sit"], "chair_1")
        self.assertEqual(self.p.move("b@x.com", 1, 1, 0, sit="chair_1")["sit"], "")
        self.p.move("a@x.com", 50, 50, 0)                        # 일어나 걸어가면 의자가 빈다
        self.assertEqual(self.p.move("b@x.com", 1, 1, 0, sit="chair_1")["sit"], "chair_1")

    def test_떠나면_의자도_빈다(self):
        self.p.move("a@x.com", 1, 1, 0, sit="chair_1")
        self.p.leave("a@x.com")
        self.assertEqual(self.p.move("b@x.com", 1, 1, 0, sit="chair_1")["sit"], "chair_1")


class TwoServersTest(unittest.TestCase):
    """서버 복제본이 2개다(OMAI-1105). 고정 쿠키로 사람마다 다른 서버에 붙어도 서로 보이고, 의자 판정은 하나다."""
    tearDown = staticmethod(clear)

    def setUp(self):
        clear()
        self.a, self.b = Presence(ttl=30, clock=lambda: 1000.0), Presence(ttl=30, clock=lambda: 1000.0)

    def test_다른_서버에_붙은_사람도_보이고_걸음이_전해진다(self):
        self.a.beat("a@x.com", "가", "")
        self.b.beat("b@x.com", "나", "")
        self.assertEqual({r["name"] for r in self.a.view("a@x.com", False)}, {"가", "나"})
        self.assertEqual(self.b.changes(), [])                              # 처음은 바탕만 잡는다
        self.a.move("a@x.com", 10, 20, 0)
        self.assertEqual(self.b.changes(), [("person.move", {"id": person_id("a@x.com"), "x": 10.0, "y": 20.0, "f": 0.0, "sit": ""})])
        self.assertEqual(self.b.changes(), [])                              # 바뀌지 않았으면 다시 내지 않는다
        self.a.leave("a@x.com")
        self.assertEqual(self.b.changes(), [("person.leave", {"id": person_id("a@x.com")})])

    def test_같은_의자는_서버가_달라도_먼저_요청한_사람이_앉는다(self):
        self.a.beat("a@x.com", "가", "")
        self.b.beat("b@x.com", "나", "")
        self.assertEqual(self.a.move("a@x.com", 1, 1, 0, sit="chair_1")["sit"], "chair_1")
        self.assertEqual(self.b.move("b@x.com", 1, 1, 0, sit="chair_1")["sit"], "")

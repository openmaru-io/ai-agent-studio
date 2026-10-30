# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""한국 사무실 배치(계획 2026-10-13-001): 배포 때 자동 적용(D6), 팀 기준 책상 배정(R3·R5), TFT 회의실 짝(R4)."""
import os
import tempfile
import unittest
from pathlib import Path

TMP = tempfile.TemporaryDirectory()
os.environ.setdefault("AAS_DATA_DIR", str(Path(TMP.name) / "data"))

from aas.office import office  # noqa: E402

TABLES = ("office_layouts", "office_desk_assignments", "office_seat_optout", "office_seats", "office_room_places",
          "office_rooms", "office_room_members")


def clear():
    with office.connect() as conn:
        for t in TABLES:
            conn.execute(f"DELETE FROM {t}")


def seat(alias, team="", pod=None):
    pod = pod or alias
    office.set_seat({"pod": pod, "profile": "default", "alias": alias, "team": team}, "admin", {pod: {"default"}})


class Base(unittest.TestCase):
    def setUp(self):
        clear()

    tearDown = staticmethod(clear)


class AutoApplyTest(Base):
    def test_판이_없으면_실린_배치를_판_1_로_쓴다(self):
        self.assertTrue(office.ensure_default_layout())
        lay = office.layout()
        self.assertEqual((lay["version"], lay["preset"]), (1, office.DEFAULT_PRESET))
        self.assertEqual(len(lay["items"]), len(office.default_layout()["items"]))
        self.assertFalse(office.ensure_default_layout())                       # 두 번 불러도 한 번만

    def test_옛_판은_무시하고_새_배치로_바꾸며_배정과_짝을_지운다(self):
        office.save_layout([{"type": "desk_cubicle", "x": 0, "y": 0, "_uid": "kr_0"}], 0, "admin", admin=True)
        office.save_layout([{"type": "desk_cubicle", "x": 0, "y": 0, "_uid": "kr_0"}], 1, "admin", admin=True)
        seat("aa")
        office.assign_desk("kr_0", "aa", "admin")                               # 옛 판의 같은 uid 에 앉아 있었다(독립 검토 O2)
        with office.connect() as conn:
            conn.execute("INSERT INTO office_room_places (room_id, place_uid, ts) VALUES (1,'x','t')")
        self.assertTrue(office.ensure_default_layout())
        self.assertEqual(office.layout()["version"], 3)
        self.assertEqual(office.desk_assignments(), {})
        self.assertEqual(office.room_places(), {})

    def test_관리자가_편집한_뒤에는_덮어쓰지_않는다(self):
        office.ensure_default_layout()
        items = office.layout()["items"][:-1]
        office.save_layout(items, 1, "admin", admin=True)
        self.assertFalse(office.ensure_default_layout())
        self.assertEqual(office.layout()["version"], 2)
        self.assertEqual(office.layout()["preset"], office.DEFAULT_PRESET)

    def test_관리자가_아니면_판_0_이라도_배치를_올리지_못한다(self):
        with self.assertRaises(office.LayoutForbidden):
            office.save_layout([{"type": "plant", "x": 0, "y": 0, "_uid": "p"}], 0, "a@x.com", admin=False)


def zone_of(desk_uid):
    return next(it.get("zone") for it in office.layout()["items"] if it["_uid"] == desk_uid)


class TeamDeskTest(Base):
    def setUp(self):
        super().setUp()
        office.ensure_default_layout()

    def zones(self):
        return {alias: zone_of(d) for d, alias in office.desk_assignments().items()}

    def test_팀장석은_에이전트에게_주지_않는다(self):
        for i in range(45):
            seat(f"a{i}")
        office.fill_desks()
        leads = {it["_uid"] for it in office.layout()["items"] if it.get("lead")}
        self.assertEqual(set(office.desk_assignments()) & leads, set())
        self.assertEqual(len(office.desk_assignments()), 36)

    def test_같은_팀은_같은_구역에_앉고_팀이_없으면_팀_없는_구역에(self):
        for a in ("a1", "a2", "a3"):
            seat(a, "개발")
        for b in ("b1", "b2"):
            seat(b, " 디자인 ")
        seat("n1")
        seat("n2")
        office.fill_desks()
        z = self.zones()
        self.assertEqual(len({z["a1"], z["a2"], z["a3"]}), 1)
        self.assertEqual(z["b1"], z["b2"])
        self.assertNotEqual(z["a1"], z["b1"])
        self.assertNotIn(z["n1"], {z["a1"], z["b1"]})
        # 팀 없는 자리는 팀 회의실이 없는 구역의 뒤 번호부터 — 팀 회의실 구역은 팀에게 남긴다(계획 2026-10-13-011 리뷰 A2).
        # kr-21(스펙 2026-10-26-007)부터 팀 회의실은 구역 1·2·3 에만 있어 팀 회의실 없는 구역은 4·5·6 이다(전에는 4·5 라 5 였다)
        self.assertEqual(z["n1"], 6)

    def test_팀_이름은_공백과_대소문자를_가리지_않는다(self):
        seat("a1", "Dev")
        seat("a2", " dev ")
        office.fill_desks()
        z = self.zones()
        self.assertEqual(z["a1"], z["a2"])

    def test_한_구역보다_많은_팀은_빈_구역으로_넘친다(self):
        for i in range(8):
            seat(f"a{i}", "개발")
        office.fill_desks()
        z = list(self.zones().values())
        self.assertEqual(sorted(z.count(v) for v in set(z)), [2, 6])

    def test_팀이_바뀌면_그_자리만_새_팀_구역으로_옮기고_손으로_정한_책상은_그대로(self):
        seat("a1", "개발")
        seat("b1", "디자인")
        seat("m1", "디자인")
        office.fill_desks()
        manual = next(it["_uid"] for it in office.layout()["items"] if it.get("zone") == 4 and not it.get("lead") and it["type"] == "desk_cubicle")
        office.assign_desk(manual, "m1", "admin@x.com")                         # 관리자가 손으로 옮김
        seat("b1", "개발")                                                       # 팀이 바뀌었다
        seat("m1", "개발")
        office.fill_desks()
        z = self.zones()
        self.assertEqual(z["b1"], z["a1"])
        self.assertEqual(office.desk_assignments()[manual], "m1")


class RoomPlaceTest(Base):
    def setUp(self):
        super().setUp()
        office.ensure_default_layout()
        self.places = [it["_uid"] for it in office.layout()["items"] if it["type"] == "room" and it.get("kind") == "tft"]

    def room(self, name, status="open"):
        return office.set_room({"name": name, "status": status}, "admin")["id"]

    def test_열린_방에_TFT_회의실을_짝짓고_다른_방이_닫혀도_짝은_그대로(self):
        r1, r2 = self.room("A"), self.room("B")
        office.assign_room_places()
        self.assertEqual(office.room_places(), {r1: self.places[0], r2: self.places[1]})
        office.set_room({"id": r1, "name": "A", "status": "closed"}, "admin")
        office.assign_room_places()
        self.assertEqual(office.room_places(), {r2: self.places[1]})
        r3 = self.room("C")
        office.assign_room_places()
        self.assertEqual(office.room_places()[r3], self.places[0])               # 빈 것 중 앞 번호

    def test_회의실보다_방이_많으면_넘치는_방은_짝이_없다(self):
        ids = [self.room(n) for n in "ABCD"]
        office.assign_room_places()
        self.assertEqual(len(office.room_places()), 3)
        self.assertNotIn(ids[3], office.room_places())

    def test_방을_지우면_짝도_지운다(self):
        r1 = self.room("A")
        office.assign_room_places()
        office.delete_room(r1)
        office.assign_room_places()
        self.assertEqual(office.room_places(), {})


if __name__ == "__main__":
    unittest.main()

# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""팀 회의실 이름표·팀 방·팀 회의실 짝(계획 2026-10-13-011)."""
import os
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

TMP = tempfile.TemporaryDirectory()
os.environ.setdefault("AAS_DATA_DIR", str(Path(TMP.name) / "data"))

from aas.office import office  # noqa: E402
from aas.web import server  # noqa: E402

TABLES = ("office_layouts", "office_desk_assignments", "office_seat_optout", "office_seats", "office_room_places",
          "office_rooms", "office_room_members")


def clear():
    with office.connect() as conn:
        for t in TABLES:
            conn.execute(f"DELETE FROM {t}")


def seat(alias, team=""):
    office.set_seat({"pod": alias, "profile": "default", "alias": alias, "team": team}, "admin", {alias: {"default"}})


OWNERS = {"kim": "a@x.com", "lee": "a@x.com", "park": "b@x.com", "solo": "c@x.com"}


def team_rooms():
    return {r["team_key"]: r for r in office.rooms() if r.get("kind") == "team"}


def places_by_kind():
    items = {it["_uid"]: it for it in office.layout()["items"]}
    kinds = {r["id"]: r.get("kind") for r in office.rooms()}
    return {rid: (kinds[rid], items[uid].get("kind"), items[uid].get("zone")) for rid, uid in office.room_places().items()}


class Base(unittest.TestCase):
    def setUp(self):
        clear()
        office.ensure_default_layout()

    tearDown = staticmethod(clear)


class TeamRoomTest(Base):
    def test_팀마다_팀_방을_만들고_에이전트와_그_주인을_구성원으로_맞춘다(self):
        seat("kim", "마케팅팀")
        seat("lee", " 마케팅팀 ")
        seat("park", "영업팀")
        seat("solo")
        self.assertTrue(office.sync_team_rooms(OWNERS))
        rooms = team_rooms()
        self.assertEqual(sorted(rooms), sorted(["마케팅팀", "영업팀"]))
        self.assertEqual(rooms["마케팅팀"]["seats"], ["kim", "lee"])
        self.assertEqual(rooms["마케팅팀"]["members"], ["a@x.com"])
        self.assertEqual(rooms["영업팀"]["name"], "영업팀")
        self.assertEqual(rooms["영업팀"]["members"], ["b@x.com"])
        self.assertFalse(office.sync_team_rooms(OWNERS))                    # 바뀐 것 없음

    def test_관리자가_에이전트를_다른_팀으로_옮기면_주인이_그_팀_방_구성원이_된다(self):
        seat("kim", "마케팅팀")
        seat("park", "영업팀")
        office.sync_team_rooms(OWNERS)
        seat("kim", "영업팀")
        office.sync_team_rooms(OWNERS)
        rooms = team_rooms()
        self.assertEqual(rooms["영업팀"]["members"], ["a@x.com", "b@x.com"])
        self.assertEqual(rooms["마케팅팀"]["status"], "closed")

    def test_팀에_자리가_없어지면_닫고_다시_생기면_연다(self):
        seat("park", "영업팀")
        office.sync_team_rooms(OWNERS)
        seat("park", "회계팀")
        office.sync_team_rooms(OWNERS)
        rooms = team_rooms()
        self.assertEqual(rooms["영업팀"]["status"], "closed")
        self.assertEqual(rooms["회계팀"]["status"], "open")
        seat("park", "영업팀")
        office.sync_team_rooms(OWNERS)
        self.assertEqual(team_rooms()["영업팀"]["status"], "open")

    def test_팀_방은_고치거나_지울_수_없다(self):
        seat("kim", "마케팅팀")
        office.sync_team_rooms(OWNERS)
        rid = team_rooms()["마케팅팀"]["id"]
        with self.assertRaises(office.OfficeError):
            office.set_room({"id": rid, "name": "x"}, "admin")
        with self.assertRaises(office.OfficeError):
            office.delete_room(rid)


class PlaceTest(Base):
    def test_팀_방은_그_팀_구역의_팀_회의실과_TFT_방은_TFT_회의실과_짝짓는다(self):
        seat("kim", "마케팅팀")
        seat("lee", "마케팅팀")
        office.fill_desks()
        office.sync_team_rooms(OWNERS)
        tft = office.set_room({"name": "결제 TFT", "seats": ["kim"]}, "admin")["id"]
        office.assign_room_places()
        got = places_by_kind()
        team_rid = team_rooms()["마케팅팀"]["id"]
        zone = next(z for d, a in office.desk_assignments().items() if a == "kim"
                    for z in [next(it.get("zone") for it in office.layout()["items"] if it["_uid"] == d)])
        self.assertEqual(got[team_rid][:2], ("team", "team"))
        if zone in (1, 2, 3, 6):                                 # 팀 회의실이 있는 구역이면 그 구역의 회의실
            self.assertEqual(got[team_rid][2], zone)
        self.assertEqual(got[tft][:2], ("tft", "tft"))

    def test_팀_회의실이_없는_구역의_팀은_빈_팀_회의실로_간다(self):
        office.sync_team_rooms(OWNERS)
        for i in range(5):                                       # 팀 5개 — 팀 회의실은 3개뿐이다(kr-21, 스펙 2026-10-26-007)
            seat(f"t{i}", f"팀{i}")
        office.fill_desks()
        office.sync_team_rooms(OWNERS)
        office.assign_room_places()
        kinds = [v for v in places_by_kind().values() if v[0] == "team"]
        self.assertEqual(len(kinds), 3)                          # 넷째·다섯째 팀은 짝이 없다 — 대회의실이 없어 제자리에서 회의한다
        self.assertTrue(all(v[1] == "team" for v in kinds))


class LabelTest(Base):
    def test_짝지어진_팀_회의실은_팀_회의실_이름과_방_번호를_준다(self):
        seat("kim", "마케팅팀")
        office.fill_desks()
        office.sync_team_rooms(OWNERS)
        office.assign_room_places()
        acc = SimpleNamespace(member_of=lambda rid: True)
        labels = [r for r in server._office_room_labels(acc) if r["kind"] == "team"]
        named = [r for r in labels if r["label"] == "마케팅팀 회의실"]
        self.assertEqual(len(named), 1)
        self.assertEqual(named[0]["room"], team_rooms()["마케팅팀"]["id"])
        self.assertEqual(named[0]["name"], "마케팅팀")                 # 대회의실 명패 둘째 줄에 쓰는 팀 이름(스펙 2026-10-20-017 디자인 리뷰 이슈 2)

    def test_이름이_회의실로_끝나면_덧붙이지_않는다(self):
        self.assertEqual(server._team_room_label("기획 회의실"), "기획 회의실")
        self.assertEqual(server._team_room_label(" 연구소 "), "연구소 회의실")


if __name__ == "__main__":
    unittest.main()


class ReviewFixTest(Base):
    """엔지니어링 리뷰 지적(계획 2026-10-13-011 §7) A1·A2·A3·A5."""

    def test_A1_팀_방_구성원이라도_그_방_에이전트를_쓸_수_있게_되지_않는다(self):
        from aas.office import office_access
        seat("kim", "회계팀")
        seat("lee", "회계팀")
        office.sync_team_rooms({"kim": "kim@x.com", "lee": "lee@x.com"})    # lee 는 kim 의 에이전트와 같은 팀
        tft = office.set_room({"name": "결제 TFT", "seats": ["kim"], "members": ["park@x.com"]}, "admin")["id"]
        reg = SimpleNamespace(is_admin=lambda u: False, allowed=lambda u, a: [], managed=lambda u, a: [], pods=[])          # 자기 설치본도 없다고 둔다(방 경로만 본다)
        lee = office_access.Access(reg, {"email": "lee@x.com"}, True)
        self.assertTrue(lee.member_of(team_rooms()["회계팀"]["id"]))          # 회의는 보고 말할 수 있다
        self.assertEqual(lee.visible_aliases(), set())                       # 남의 에이전트(kim)에게 1:1 대화·크론·칸반은 안 된다
        park = office_access.Access(reg, {"email": "park@x.com"}, True)
        self.assertEqual(park.visible_aliases(), {"kim"})                    # TFT 방은 지금처럼
        self.assertTrue(park.member_of(tft))

    def test_A5_같은_팀_방은_하나만_생긴다(self):
        seat("kim", "마케팅팀")
        office.sync_team_rooms(OWNERS)
        with office.connect() as conn:                                       # 다른 서버가 같은 팀 방을 또 만들려 해도 막힌다
            made = conn.execute("INSERT INTO office_rooms (name, seats, people, status, by, ts, kind, team_key) "
                                "VALUES ('마케팅팀','[]','[]','open','auto','t','team','마케팅팀') ON CONFLICT DO NOTHING RETURNING id").fetchone()
        self.assertIsNone(made)
        office.sync_team_rooms(OWNERS)
        self.assertEqual(len([r for r in office.rooms() if r.get("kind") == "team"]), 1)

    def test_A2_새_팀은_팀_회의실이_있는_구역부터_받는다(self):
        for i in range(4):
            seat(f"t{i}", f"팀{i}")
        office.fill_desks()
        items = {it["_uid"]: it for it in office.layout()["items"]}
        zones = {a: items[d].get("zone") for d, a in office.desk_assignments().items()}
        self.assertEqual(sorted(zones.values()), [1, 2, 3, 4])               # 팀 회의실은 구역 1·2·3(kr-21). 넷째 팀은 빈 구역 중 앞 번호

    def test_A3_짝이_없는_팀_회의실은_번호_이름_그대로다(self):
        seat("kim", "마케팅팀")
        office.fill_desks()                                                  # 팀 방도 짝도 없이 책상만 있다
        acc = SimpleNamespace(member_of=lambda rid: True)
        labels = {r["label"] for r in server._office_room_labels(acc) if r["kind"] == "team"}
        self.assertEqual(labels, {"팀 회의실 1", "팀 회의실 2", "팀 회의실 3"})        # kr-21 부터 셋


class DepartmentDoesNotGrantTest(Base):
    def test_D5_부서를_바꿔도_팀_방_구성원이_되지_않는다(self):
        from aas.common import settings
        seat("kim", "회계팀")
        settings.set_department("intruder@x.com", "회계팀")                  # 계정 콘솔에서 부서를 회계팀으로 바꾼 사람
        office.sync_team_rooms({"kim": "kim@x.com"})
        self.assertEqual(team_rooms()["회계팀"]["members"], ["kim@x.com"])

# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""TFT 방을 담당·구성원도 고친다(스펙 2026-10-18-009, 사용자 결정 2026-10-18).

  관리자  전부(지금과 같다)
  담당    이름·목적·구성원·에이전트·방 끝내기. 에이전트는 자기 것만 새로 넣는다(남의 것은 이미 있던 것만 둔다)
  구성원  이름·목적만
  담당 바꾸기·방 지우기는 관리자만. 팀 방은 아무도(관리자도) 여기서 고치지 않는다.
방 구성원이 되면 그 방에 앉은 에이전트를 쓸 수 있어(office_access.visible_aliases), 에이전트·구성원 바꾸기는 남의 에이전트 권한과 이어진다.
구성원 이메일은 관리자만 본다(계획 007 R6) — 담당은 사람을 이메일 대신 서버가 만든 열쇠로 고른다."""
import unittest

try:
    from tests.test_office_access import ADMIN, A, B, C, AccessBase, Reg, acc
except ImportError:
    from test_office_access import ADMIN, A, B, C, AccessBase, Reg, acc  # noqa: F401

from aas.office import office, office_access  # noqa: E402
from aas.web import server  # noqa: E402

D = "d@x.com"


def room(rid):
    return next(r for r in office.rooms() if r["id"] == rid)


class RoomEditTest(AccessBase):
    def setUp(self):
        super().setUp()
        office.person_touch(A, "에이")
        office.person_touch(B, "비")
        office.person_touch(C, "씨")
        office.person_touch(D, "디")
        # A 가 담당, C 가 구성원. 에이전트는 A 의 sa 와 B 의 doc
        office.set_room({"id": self.r1, "name": "제안", "seats": ["sa", "doc"], "owner": A, "members": [A, C], "purpose": "목표"}, "me")

    def edit(self, email, body):
        return server._office_room_edit(Reg, {"email": email}, True, {"action": "room.set", "id": self.r1, **body}, email)

    def test_역할(self):
        self.assertEqual(acc(ADMIN).room_role(self.r1), "admin")
        self.assertEqual(acc(A).room_role(self.r1), "owner")
        self.assertEqual(acc(C).room_role(self.r1), "member")
        self.assertEqual(acc(B).room_role(self.r1), "")                  # 에이전트 주인이어도 구성원이 아니면 못 고친다

    def test_구성원은_이름과_목적만_바꾸고_나머지는_보내도_그대로다(self):
        self.edit(C, {"name": "제안 2", "purpose": "새 목표", "seats": ["ma"], "members": [], "owner": C, "status": "closed"})
        r = room(self.r1)
        self.assertEqual((r["name"], r["purpose"]), ("제안 2", "새 목표"))
        self.assertEqual((r["seats"], r["members"], r["owner"], r["status"]), (["sa", "doc"], [A, C], A, "open"))

    def test_담당은_구성원과_상태를_바꾸고_담당은_바꾸지_못한다(self):
        d = office.person_key(D)
        self.edit(A, {"name": "제안", "members": [office.person_key(A), office.person_key(C), d], "owner": C, "status": "closed", "seats": ["sa", "doc"]})
        r = room(self.r1)
        self.assertEqual(sorted(r["members"]), sorted([A, C, D]))
        self.assertEqual((r["owner"], r["status"]), (A, "closed"))

    def test_담당이_구성원에서_자기를_빼도_담당은_구성원으로_남는다(self):
        self.edit(A, {"name": "제안", "members": [office.person_key(C)], "seats": ["sa", "doc"]})
        self.assertIn(A, room(self.r1)["members"])

    def test_담당은_자기_에이전트만_새로_넣고_남의_것은_빼기만_한다(self):
        self.edit(A, {"name": "제안", "seats": ["sa", "ma"]})                   # doc(B 의 것) 빼고 ma(내 것) 넣기
        self.assertEqual(room(self.r1)["seats"], ["sa", "ma"])
        with self.assertRaises(office_access.Denied):
            self.edit(A, {"name": "제안", "seats": ["sa", "ma", "doc"]})       # 빠진 남의 것을 다시 넣기는 안 된다
        self.assertEqual(room(self.r1)["seats"], ["sa", "ma"])

    def test_모르는_사람_열쇠는_거절한다(self):
        with self.assertRaises(office_access.Denied):
            self.edit(A, {"name": "제안", "members": ["p_0000000000000000"]})

    def test_새_방_만들기와_지우기와_구성원이_아닌_사람은_거절한다(self):
        with self.assertRaises(office_access.Denied):
            server._office_room_edit(Reg, {"email": A}, True, {"action": "room.set", "id": 0, "name": "새 방"}, A)
        with self.assertRaises(office_access.Denied):
            server._office_room_edit(Reg, {"email": A}, True, {"action": "room.delete", "id": self.r1}, A)
        with self.assertRaises(office_access.Denied):
            self.edit(B, {"name": "남의 방"})
        self.assertEqual(room(self.r1)["name"], "제안")

    def test_팀_방은_담당이어도_거절한다(self):
        with office.connect() as conn:
            conn.execute("UPDATE office_rooms SET kind='team' WHERE id=?", (self.r1,))
        with self.assertRaises(office_access.Denied):
            self.edit(A, {"name": "팀 방 이름"})

    def test_오피스_자료에_내_역할과_담당에게만_구성원_열쇠를_싣는다(self):
        a = {r["id"]: r for r in server._office_base(Reg, {"email": A}, True)["rooms"]}[self.r1]
        c = {r["id"]: r for r in server._office_base(Reg, {"email": C}, True)["rooms"]}[self.r1]
        self.assertEqual(a["my_role"], "owner")
        self.assertEqual(sorted(a["members"]), sorted([office.person_key(A), office.person_key(C)]))
        self.assertEqual(a["owner_key"], office.person_key(A))
        self.assertNotIn("@", " ".join(a["members"]) + a["owner_key"])                     # 이메일은 내려가지 않는다(R6)
        self.assertEqual(c["my_role"], "member")
        self.assertNotIn("members", c)

    def test_사람_목록은_이름과_열쇠뿐이고_열쇠는_되돌릴_수_있다(self):
        rows = office.person_directory()
        self.assertIn({"key": office.person_key(D), "name": "디"}, rows)
        self.assertNotIn("@", " ".join(r["key"] + r["name"] for r in rows))
        self.assertEqual(office.email_of_key(office.person_key(D)), D)
        self.assertEqual(office.email_of_key("p_nope"), "")


if __name__ == "__main__":
    unittest.main()

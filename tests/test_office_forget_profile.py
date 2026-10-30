# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""프로파일을 지우면 그 프로파일이 앉은 오피스 자리를 지우고 열린 방에서 뺀다(스펙 2026-10-15-011 R1·단계 2)."""
import os
import tempfile
import unittest
from pathlib import Path

TMP = tempfile.TemporaryDirectory()
os.environ.setdefault("AAS_DATA_DIR", str(Path(TMP.name) / "data"))

from aas.office import office  # noqa: E402

KNOWN = {"p1": {"main", "side"}, "p2": {"main"}}


class ForgetProfileTest(unittest.TestCase):
    def setUp(self):
        with office.connect() as conn:
            for t in ("office_seats", "office_rooms", "office_room_members", "office_sessions", "office_desk_assignments", "office_seat_optout"):
                conn.execute(f"DELETE FROM {t}")
        office.set_seat({"pod": "p1", "profile": "main", "alias": "p1-main"}, "admin", KNOWN)
        office.set_seat({"pod": "p1", "profile": "side", "alias": "p1-side"}, "admin", KNOWN)
        office.set_seat({"pod": "p2", "profile": "main", "alias": "p2-main"}, "admin", KNOWN)
        self.open_room = office.set_room({"name": "열린 방", "seats": ["p1-main", "p1-side", "p2-main"]}, "admin")["id"]
        self.closed_room = office.set_room({"name": "닫힌 방", "seats": ["p1-side"], "status": "closed"}, "admin")["id"]

    def room(self, rid):
        return next(r for r in office.rooms() if r["id"] == rid)

    def test_seat_is_removed_and_the_alias_leaves_open_rooms(self):
        out = office.forget_profile("p1", "side", "kim@x.com")
        self.assertEqual(out, {"seats": 1, "rooms": 1})
        self.assertEqual({s["alias"] for s in office.seats()}, {"p1-main", "p2-main"})
        self.assertEqual(self.room(self.open_room)["seats"], ["p1-main", "p2-main"])        # 다른 자리는 그대로
        self.assertEqual(self.room(self.closed_room)["seats"], ["p1-side"])                 # 끝난 방의 기록은 건드리지 않는다

    def test_other_pods_with_the_same_profile_name_are_untouched(self):
        office.forget_profile("p1", "main", "kim@x.com")
        self.assertIn("p2-main", {s["alias"] for s in office.seats()})
        self.assertIn("p2-main", self.room(self.open_room)["seats"])

    def test_a_profile_without_seats_changes_nothing(self):
        self.assertEqual(office.forget_profile("p1", "ghost", "kim@x.com"), {"seats": 0, "rooms": 0})
        self.assertEqual(len(office.seats()), 3)

    def test_removed_profile_leaves_no_opt_out(self):
        """지운 프로파일은 관리자가 오피스에서 뺀 것이 아니라 「관리자가 뺀」 기록(optout)을 남기지 않는다 — 같은 이름으로 다시 만들면
        자동 자리가 앉힌다(스펙 2026-10-26-008 R5, 리뷰 D2). 예전(2026-10-15-011)에는 delete_seat 의 기록을 그대로 써 다시 앉히지 않았다."""
        office.forget_profile("p1", "side", "kim@x.com")
        with office.connect() as conn:
            self.assertEqual(conn.execute("SELECT COUNT(*) FROM office_seat_optout WHERE pod='p1' AND profile='side'").fetchone()[0], 0)


if __name__ == "__main__":
    unittest.main()

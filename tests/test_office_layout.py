# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""공유 공간 시험(계획 007 P−1): 서버 레이아웃(판 번호), 책상 배정, 자동 자리."""
import os
import tempfile
import types
import unittest
from pathlib import Path
from unittest import mock

TMP = tempfile.TemporaryDirectory()
os.environ.setdefault("AAS_DATA_DIR", str(Path(TMP.name) / "data"))

from aas.office import office  # noqa: E402


def items(desks: int, extra: int = 1) -> list[dict]:
    out = [{"type": "desk_cubicle", "x": 100 * i, "y": 300, "_uid": f"office_{i}"} for i in range(desks)]
    out += [{"type": "plant", "x": 10, "y": 10 * i, "_uid": f"plant_{i}"} for i in range(extra)]
    return out


def pod(pid: str, owner: str, profiles=("default",)):
    return types.SimpleNamespace(id=pid, owner=owner, profiles=list(profiles))


class SpaceBase(unittest.TestCase):
    def setUp(self):
        with office.connect() as conn:
            for t in ("office_layouts", "office_desk_assignments", "office_seat_optout", "office_seats", "office_sessions"):
                conn.execute(f"DELETE FROM {t}")

    tearDown = setUp


class LayoutTest(SpaceBase):
    def test_배치는_관리자만_올린다_판이_없어도(self):
        """계획 2026-10-13-001 §3-5: 기본 배치는 서버가 만든다(ensure_default_layout). 예전처럼 누구나 판 1 을 올리지 못한다."""
        self.assertEqual(office.layout(), {"version": 0, "items": None, "preset": None})
        with self.assertRaises(office.LayoutForbidden):
            office.save_layout(items(2), 0, "a@x.com", admin=False)
        self.assertEqual(office.save_layout(items(2), 0, "admin@x.com", admin=True)["version"], 1)
        self.assertEqual(office.save_layout(items(3), 1, "admin@x.com", admin=True)["version"], 2)
        self.assertEqual(len(office.layout()["items"]), 4)

    def test_판_번호가_다르면_거절한다(self):
        office.save_layout(items(2), 0, "admin@x.com", admin=True)
        with self.assertRaises(office.LayoutConflict):
            office.save_layout(items(2), 0, "admin@x.com", admin=True)           # 누가 먼저 판 1 을 만들었다

    def test_모양이_틀린_레이아웃은_거절한다(self):
        for bad in ([], "x", [{"type": "desk_cubicle", "x": 1, "y": 1}], [{"type": "a", "x": "1", "y": 1, "_uid": "u"}],
                    [{"type": "a", "x": 1, "y": 1, "_uid": "u"}, {"type": "b", "x": 1, "y": 1, "_uid": "u"}]):
            with self.assertRaises(office.OfficeError):
                office.save_layout(bad, 0, "admin@x.com", admin=True)


class DeskTest(SpaceBase):
    def seat(self, alias, pod_id="p1", profile=None):
        office.set_seat({"pod": pod_id, "profile": profile or alias, "alias": alias}, "admin", {pod_id: {profile or alias}})

    def test_빈_책상에_순서대로_앉히고_모자라면_남는다(self):
        office.save_layout(items(2), 0, "admin", admin=True)
        for a in ("aa", "bb", "cc"):
            self.seat(a, pod_id=a, profile="default")
        filled = office.fill_desks()
        self.assertEqual(len(filled), 2)
        self.assertEqual(set(office.desk_assignments()), {"office_0", "office_1"})
        self.assertEqual(office.fill_desks(), [])                                   # 다시 불러도 바뀌지 않는다

    def test_책상을_지우면_배정이_풀리고_다음에_빈_책상을_받는다(self):
        office.save_layout(items(2), 0, "admin", admin=True)
        self.seat("aa")
        office.fill_desks()
        desk = next(iter(office.desk_assignments()))
        office.save_layout([it for it in items(2) if it["_uid"] != desk], 1, "admin", admin=True)
        self.assertEqual(office.desk_assignments(), {})
        office.fill_desks()
        self.assertEqual(list(office.desk_assignments().values()), ["aa"])

    def test_관리자가_책상을_옮기면_원래_책상은_빈다(self):
        office.save_layout(items(3), 0, "admin", admin=True)
        self.seat("aa")
        office.fill_desks()
        office.assign_desk("office_2", "aa", "admin")
        self.assertEqual(office.desk_assignments(), {"office_2": "aa"})
        with self.assertRaises(office.OfficeError):
            office.assign_desk("없는책상", "aa", "admin")

    def test_별칭을_바꿔도_책상은_그대로(self):
        office.save_layout(items(1), 0, "admin", admin=True)
        self.seat("aa", profile="ma")
        office.fill_desks()
        office.set_seat({"pod": "p1", "profile": "ma", "alias": "bb"}, "admin", {"p1": {"ma"}})
        self.assertEqual(office.desk_assignments(), {"office_0": "bb"})


class AutoSeatTest(SpaceBase):
    def test_새_설치본은_주인_이름으로_자리를_얻고_이름이_겹치면_번호를_붙인다(self):
        made = office.auto_seat([pod("hag-1", "Kim.Cs@x.com"), pod("hag-2", "kim.cs@y.com")])
        self.assertEqual(made, ["kim-cs", "kim-cs-2"])
        self.assertEqual(office.auto_seat([pod("hag-1", "Kim.Cs@x.com")]), [])            # 이미 앉았다

    def test_관리자가_뺀_자리는_다시_만들지_않고_다시_앉히면_풀린다(self):
        office.auto_seat([pod("hag-1", "a@x.com")])
        office.delete_seat("a", "admin")
        self.assertEqual(office.auto_seat([pod("hag-1", "a@x.com")]), [])
        office.set_seat({"pod": "hag-1", "profile": "default", "alias": "a-agent"}, "admin", {"hag-1": {"default"}})
        office.delete_seat("a-agent", "admin")
        office.set_seat({"pod": "hag-1", "profile": "default", "alias": "a-agent"}, "admin", {"hag-1": {"default"}})
        with office.connect() as conn:
            self.assertIsNone(conn.execute("SELECT 1 FROM office_seat_optout WHERE pod='hag-1'").fetchone())

    def test_이상한_주인_이름도_규칙에_맞는_별칭이_된다(self):
        made = office.auto_seat([pod("p", "--@x.com"), pod("q", "")])
        self.assertTrue(all(office.ID.match(a) and a != "default" for a in made), made)
        self.assertEqual(len(made), 2)


def optouts() -> set:
    with office.connect() as conn:
        return {(r["pod"], r["profile"]) for r in conn.execute("SELECT pod, profile FROM office_seat_optout")}


def seat_of(pod_id: str, profile: str) -> dict | None:
    return next((s for s in office.seats() if s["pod"] == pod_id and s["profile"] == profile), None)


class ComposeAutoSeatTest(SpaceBase):
    """스펙 2026-10-26-008: compose 에서도 모든 프로파일을 앉히고, 지운 프로파일은 「관리자가 뺀」 기록을 남기지 않으며(R5),
    이름을 바꾸면 자리를 옮기고(R3), 목록에 없는 자동 자리를 정리한다(R6)."""

    def test_지운_프로파일은_뺀_기록을_남기지_않고_같은_이름으로_다시_만들면_앉는다(self):
        office.auto_seat([pod("p1", "admin@x.com", ("default", "ma"))])
        office.forget_profile("p1", "ma", "admin")
        self.assertIsNone(seat_of("p1", "ma"))
        self.assertEqual(optouts(), set())
        self.assertEqual(office.auto_seat([pod("p1", "admin@x.com", ("default", "ma"))]), ["admin-ma"])

    def test_관리자가_뺀_프로파일은_다른_프로파일을_만들어도_그대로_앉지_않는다(self):
        office.auto_seat([pod("p1", "admin@x.com", ("default", "ma"))])
        office.delete_seat("admin-ma", "admin")
        office.profile_created("p1", "ops")                               # 다른 이름을 만들었다
        self.assertEqual(optouts(), {("p1", "ma")})
        self.assertEqual(office.auto_seat([pod("p1", "admin@x.com", ("default", "ma", "ops"))]), ["admin-ops"])

    def test_프로파일을_만들면_그_이름의_옛_뺀_기록이_지워진다(self):
        office.auto_seat([pod("p1", "admin@x.com", ("default", "ma"))])
        office.delete_seat("admin-ma", "admin")                           # 올리기 전에 지운 이름이 남긴 기록과 같다
        office.profile_created("p1", "ma")
        self.assertEqual(optouts(), set())
        self.assertEqual(office.auto_seat([pod("p1", "admin@x.com", ("default", "ma"))]), ["admin-ma"])

    def test_이름을_바꾸면_자리와_뺀_기록이_새_이름으로_옮겨지고_별칭과_책상은_그대로(self):
        office.save_layout(items(2), 0, "admin", admin=True)
        office.auto_seat([pod("p1", "admin@x.com", ("default", "ma"))])
        office.fill_desks()
        desks = office.desk_assignments()
        office.rename_profile("p1", "ma", "mk", "admin")
        self.assertIsNone(seat_of("p1", "ma"))
        self.assertEqual(seat_of("p1", "mk")["alias"], "admin-ma")
        self.assertEqual(office.desk_assignments(), desks)
        self.assertEqual(office.auto_seat([pod("p1", "admin@x.com", ("default", "mk"))]), [])     # 자리가 하나 더 생기지 않는다
        office.delete_seat("admin-ma", "admin")
        office.rename_profile("p1", "mk", "mx", "admin")
        self.assertEqual(optouts(), {("p1", "mx")})

    def test_새_이름에_옛_뺀_기록이_남아_있어도_이름을_바꿀_수_있다(self):
        office.auto_seat([pod("p1", "admin@x.com", ("default", "ma", "mk"))])
        office.delete_seat("admin-mk", "admin")                           # mk 의 옛 기록(R5 이전에 지운 이름 등)
        office.rename_profile("p1", "ma", "mk", "admin")
        self.assertEqual(seat_of("p1", "mk")["alias"], "admin-ma")
        self.assertEqual(optouts(), set())

    def test_새_이름으로_이미_자동_자리가_생겼으면_그것을_지우고_옛_자리를_옮긴다(self):
        office.auto_seat([pod("p1", "admin@x.com", ("default", "ma"))])
        office.auto_seat([pod("p1", "admin@x.com", ("default", "ma", "mk"))])   # 이름이 바뀐 뒤 옮기기 전에 리더 바퀴가 돌았다
        office.rename_profile("p1", "ma", "mk", "admin")
        self.assertEqual([s["alias"] for s in office.seats() if s["profile"] == "mk"], ["admin-ma"])

    def test_목록에_없는_프로파일의_자동_자리를_정리하고_관리자가_고친_자리는_둔다(self):
        office.auto_seat([pod("p1", "admin@x.com", ("default", "ma", "ops", "qa"))])
        office.set_seat({"pod": "p1", "profile": "qa", "alias": "admin-qa", "title": "품질"}, "admin", {"p1": {"qa"}})
        with office.connect() as conn:
            conn.execute("INSERT INTO office_rooms (name, seats, status, by, ts) VALUES ('r', ?, 'open', 'a', 't')", ('["admin-ma", "admin"]',))
        removed = office.prune_auto_seats("p1", {"default", "ops"})      # ma·qa 가 목록에서 빠졌다
        self.assertEqual(removed, ["admin-ma"])
        self.assertIsNone(seat_of("p1", "ma"))
        self.assertIsNotNone(seat_of("p1", "qa"))                         # 관리자가 고친 자리
        self.assertEqual(optouts(), set())
        self.assertNotIn("admin-ma", [a for r in office.rooms() if r["name"] == "r" for a in r["seats"]])
        self.assertEqual(office.prune_auto_seats("p2", set()), [])        # 다른 작업공간은 건드리지 않는다


class ComposeSeatPodsTest(SpaceBase):
    """스펙 2026-10-26-008 R1·R2·R6: 서버의 자동 자리 대상과 프로파일 액션 뒤 처리."""

    def setUp(self):
        super().setUp()
        from aas.web import server
        self.server = server
        self.env = mock.patch.dict(os.environ, {"AAS_K8S_NAMESPACE": ""})
        self.env.start()
        self.addCleanup(self.env.stop)
        self.reg = types.SimpleNamespace(pods=[types.SimpleNamespace(id="p1", owner="admin@x.com"),
                                               types.SimpleNamespace(id="p2", owner="lee@x.com")])

    def names(self, table):
        def read(reg, name):
            v = table[name]
            if isinstance(v, Exception):
                raise v
            return v
        return mock.patch.object(self.server, "_agent_profile_names", side_effect=read)

    def test_쿠버네티스가_아니면_작업공간마다_모든_프로파일이_대상이다(self):
        with self.names({"p1": ["default", "ma"], "p2": ["default"]}):
            pods = self.server._office_seat_pods(self.reg)
        self.assertEqual([(p.id, p.profiles, p.primary) for p in pods], [("p1", ["default", "ma"], "default"), ("p2", ["default"], "default")])

    def test_작업공간_하나의_목록_읽기가_실패하면_그것만_빠진다(self):
        with self.names({"p1": OSError("sidecar"), "p2": ["default"]}):
            self.assertEqual([p.id for p in self.server._office_seat_pods(self.reg)], ["p2"])
        with self.names({"p1": None, "p2": ["default"]}):
            self.assertEqual([p.id for p in self.server._office_seat_pods(self.reg)], ["p2"])

    def test_자리_맞추기가_목록에_없는_자동_자리를_정리하고_읽기_실패_작업공간은_두다(self):
        with self.names({"p1": ["default", "ma"], "p2": ["default", "qa"]}):
            self.server._office_space(self.reg)
        self.assertIsNotNone(seat_of("p1", "ma"))
        with self.names({"p1": ["default"], "p2": OSError("sidecar")}):
            self.server._office_space(self.reg)
        self.assertIsNone(seat_of("p1", "ma"))                            # Hermes 명령줄로 지운 경우
        self.assertIsNotNone(seat_of("p2", "qa"))                         # 읽지 못한 작업공간은 그대로

    def test_프로파일을_만들면_알림으로_깨운_첫_바퀴에_자리가_생긴다(self):
        p1 = self.reg.pods[0]
        with self.names({"p1": ["default"], "p2": ["default"]}):
            self.server._office_space(self.reg)
        with mock.patch.object(self.server, "_notify_desks") as notify:
            self.server._office_after_profile_action(p1, "create", {"name": "ma"}, {}, "admin")
            notify.assert_called_once()
        with self.names({"p1": ["default", "ma"], "p2": ["default"]}):
            self.server._office_space(self.reg)
        self.assertEqual(seat_of("p1", "ma")["alias"], "admin-ma")

    def test_이름_바꾸기와_지우기도_자리를_따라가고_다른_액션은_알리지_않는다(self):
        p1 = self.reg.pods[0]
        office.auto_seat([pod("p1", "admin@x.com", ("default", "ma"))])
        with mock.patch.object(self.server, "_notify_desks") as notify:
            self.server._office_after_profile_action(p1, "rename", {"name": "ma"}, {"name": "mk"}, "admin")
            self.assertEqual(seat_of("p1", "mk")["alias"], "admin-ma")
            out = self.server._office_after_profile_action(p1, "delete", {"name": "mk"}, {}, "admin")
            self.assertEqual(out["forgot"]["seats"], 1)
            self.server._office_after_profile_action(p1, "soul", {"name": "default"}, {}, "admin")
            self.assertEqual(notify.call_count, 2)
        self.assertEqual(optouts(), set())


if __name__ == "__main__":
    unittest.main()

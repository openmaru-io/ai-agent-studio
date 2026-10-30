# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""사람 목록 토픽 office:people 과 웹소켓 사람 신호(스펙 2026-10-26-001 §4-2, 시험 T5~T7b).

오피스 화면은 사람 목록을 받으려고 10초마다 POST /api/office/presence 를 보냈다. 요청마다 쓰기 한 번, 사람 전체 읽기 한 번,
보기 범위 계산 한 번이 화면 수만큼 일어났다. 2단계는 신호를 웹소켓으로 보내고, 사람 목록은 토픽으로 받고, ts 는 서버가 묶어 쓴다."""
import asyncio
import os
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

from aas.common import settings
from aas.office import office, office_changed, presence, shared
from aas.web import server, topics, ws


class Clock:
    def __init__(self, t: float = 1000.0):
        self.t = t

    def __call__(self) -> float:
        return self.t


class DataDir(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.old = os.environ.get("AAS_DATA_DIR")
        os.environ["AAS_DATA_DIR"] = str(Path(self.tmp.name) / "data")
        settings.reset_cache()
        self.clock = Clock()
        self.p = presence.Presence(clock=self.clock)
        self.notified = []
        patcher = mock.patch.object(shared, "notify", lambda conn, kind: self.notified.append(kind))
        patcher.start()
        self.addCleanup(patcher.stop)

    def tearDown(self):
        if self.old is None:
            os.environ.pop("AAS_DATA_DIR", None)
        else:
            os.environ["AAS_DATA_DIR"] = self.old
        settings.reset_cache()
        self.tmp.cleanup()


class BeatNewsTest(DataDir):
    """T6: 들어옴·이름·얼굴 바뀜만 알리고, ts·보는 탭만 바뀐 신호는 알리지 않는다(리뷰 D5·D12, 외부 검토 H4)."""

    def test_처음_들어오면_알리고_같은_신호와_탭만_바뀐_신호는_알리지_않는다(self):
        self.p.beat("kim@x.com", "김", "s1", "room")
        self.assertEqual(self.notified, ["presence"])
        self.clock.t += 10
        self.p.beat("kim@x.com", "김", "s1", "room")
        self.clock.t += 10
        self.p.beat("kim@x.com", "김", "s1", "kanban")              # 탭 둘이 번갈아 보내도
        self.p.beat("kim@x.com", "김", "s1", "room")
        self.assertEqual(self.notified, ["presence"])

    def test_얼굴이나_이름이_바뀌면_알린다(self):
        self.p.beat("kim@x.com", "김", "s1")
        self.p.beat("kim@x.com", "김", "s2")
        self.p.beat("kim@x.com", "김철수", "s2")
        self.assertEqual(self.notified, ["presence"] * 3)

    def test_떠난_뒤나_TTL_이_지난_뒤_같은_값으로_다시_들어오면_알린다(self):
        self.p.beat("kim@x.com", "김", "s1")
        self.p.leave("kim@x.com")
        self.p.beat("kim@x.com", "김", "s1")
        self.assertEqual(self.notified, ["presence", "presence", "presence"])     # 들어옴·떠남·다시 들어옴
        self.clock.t += presence.TTL + 1
        self.p.beat("kim@x.com", "김", "s1")
        self.assertEqual(len(self.notified), 4)


class ChangesTest(DataDir):
    def test_사람_목록이_바뀌면_people_changed_를_켜고_탭만_바뀌면_켜지_않는다(self):
        self.p.changes()                                            # 바탕
        self.p.beat("kim@x.com", "김", "s1", "room")
        self.p.changes()
        self.assertTrue(self.p.people_changed)
        self.p.people_changed = False
        self.p.beat("kim@x.com", "김", "s1", "kanban")
        self.p.changes()
        self.assertFalse(self.p.people_changed)
        self.clock.t += presence.TTL + 1                            # 신호가 끊겨 시간이 지났다
        self.p.changes()
        self.assertTrue(self.p.people_changed)


class HoldTest(DataDir):
    """T7b: 웹소켓으로 붙은 사람의 ts 는 서버가 한 문장으로 고친다(리뷰 D15)."""

    def test_연결_셋을_한_문장으로_고치고_끊긴_연결은_빠진다(self):
        self.p.hold("c1", "kim@x.com", "김", "s1", "room")
        self.p.hold("c2", "kim@x.com", "김", "s1", "kanban")          # 같은 사람의 탭 둘
        self.p.hold("c3", "lee@x.com", "이", "s2", "room")
        self.clock.t += 20
        sqls = []
        real = presence._connect

        class Spy:                                                  # SQLite·PostgreSQL 연결 모두에서 보낸 문장을 센다(set_trace_callback 은 SQLite 만 있다)
            def __init__(self, conn):
                self.conn = conn

            def __enter__(self):
                self.inner = self.conn.__enter__()
                return self

            def __exit__(self, *exc):
                return self.conn.__exit__(*exc)

            def execute(self, sql, *args):
                sqls.append(sql)
                return self.inner.execute(sql, *args)

        def spy():
            return Spy(real())
        with mock.patch.object(presence, "_connect", spy):
            self.assertEqual(self.p.refresh_held(), 2)
        self.assertEqual(len([s for s in sqls if s.startswith("UPDATE office_presence SET ts=")]), 1)
        self.assertEqual({r["name"] for r in self.p.view("", True)}, {"김", "이"})
        self.p.release("c1")
        self.p.release("c3")
        self.assertEqual(self.p.held_emails(), {"kim@x.com"})
        self.clock.t += presence.TTL + 1                            # lee 는 아무도 붙잡지 않아 TTL 뒤 빠진다
        self.p.refresh_held()
        self.assertEqual({r["name"] for r in self.p.view("", True)}, {"김"})

    def test_떠나도_같은_사람의_다른_연결이_있으면_빼지_않는다(self):
        self.p.hold("c1", "kim@x.com", "김", "s1")
        self.p.hold("c2", "kim@x.com", "김", "s1")
        self.p.release("c1", leave=True)
        self.assertEqual(len(self.p.view("", True)), 1)
        self.p.release("c2", leave=True)
        self.assertEqual(self.p.view("", True), [])

    def test_다른_서버의_떠남으로_행이_지워져도_붙잡은_사람은_다시_넣는다(self):
        self.p.hold("c1", "kim@x.com", "김", "s1")
        with presence._connect() as conn:
            conn.execute("DELETE FROM office_presence")
        self.notified.clear()
        self.p.refresh_held()
        self.assertEqual(len(self.p.view("", True)), 1)
        self.assertEqual(self.notified, ["presence"])                # 다시 들어옴으로 알린다


class PeopleTopicTest(DataDir):
    """T5: 토픽 view 는 REST 와 같은 규칙으로 거른다(회귀 계약 3)."""

    def setUp(self):
        super().setUp()
        self.real = server.PRESENCE
        server.PRESENCE = self.p
        self.addCleanup(setattr, server, "PRESENCE", self.real)
        self.p.beat("lee@x.com", "이", "s2")
        self.p.beat("kim@x.com", "김", "s1")
        self.p.beat("out@x.com", "밖", "s3")

    def acc(self, email, allow):
        return SimpleNamespace(email=email, scene_people=lambda: allow)

    def test_일반_사용자와_관리자에게_REST_와_같은_목록을_준다(self):
        value = server.office_people_source()
        for acc in (self.acc("kim@x.com", {"kim@x.com", "lee@x.com"}), self.acc("boss@x.com", None)):
            with mock.patch.object(settings, "departments", return_value={"kim@x.com": "개발팀"}):
                self.assertEqual(server._office_people_from(value["rows"], acc), server._office_people(acc))
        mine = server._office_people_from(value["rows"], self.acc("kim@x.com", {"kim@x.com", "lee@x.com"}))
        self.assertEqual([r["name"] for r in mine], ["김", "이"])               # 나 먼저, 범위 밖 사람 없음
        self.assertTrue(mine[0]["me"])
        self.assertTrue(all("email" not in r for r in mine))                    # 일반 사용자에게 이메일 없음

    def test_같은지_비교는_보는_탭과_위치를_빼고_변경_번호를_넣는다(self):
        before = server.office_people_same(server.office_people_source())
        self.p.beat("kim@x.com", "김", "s1", "kanban")
        self.p.move("kim@x.com", 10, 20, 0)
        self.assertEqual(server.office_people_same(server.office_people_source()), before)
        office_changed.bump("rooms")
        self.assertNotEqual(server.office_people_same(server.office_people_source()), before)

    def test_웹소켓_신호는_이름을_적고_사람을_붙잡는다(self):
        """T7: POST 처럼 person_touch 로 이름을 적는다(외부 검토 H3). 이메일은 연결의 로그인 정보에서만 온다."""
        with mock.patch.object(office, "person_touch") as touch:
            server.office_people_pub("c9", {"email": "New@X.com", "name": "새"}, {"beat": "room", "email": "other@x.com"})
        touch.assert_called_once_with("new@x.com", "새")
        self.assertEqual(self.p.held_emails(), {"new@x.com"})
        server.office_people_pub("c9", {"email": "new@x.com"}, {"leave": True})
        self.assertNotIn("new@x.com", {r["email"] for r in self.p.view("", True)})

    def test_토픽은_10초_보조_주기와_같은지_비교를_쓴다(self):
        spec = ws.resolve("office:people")
        self.assertEqual(spec.interval(None), 10.0)
        self.assertIs(spec.same, server.office_people_same)


class HubSameTest(unittest.TestCase):
    """T5a: same 을 준 토픽은 비교값이 같으면 구독자 view 를 만들지 않는다. 주지 않은 토픽은 지금처럼 매번 만든다."""

    def run_refresh(self, same):
        calls = []
        values = iter([{"v": 1, "noise": 1}, {"v": 1, "noise": 2}, {"v": 2, "noise": 2}])

        class Sub:
            ctx = {}

            def push(self, *a):
                pass
        hub = topics.Hub(readers=2)
        loop = asyncio.new_event_loop()
        try:
            hub.start(loop)
            topic = topics.Topic("probe", "", topics.Spec(source=lambda: next(values), view=lambda v, ctx: calls.append(v) or v["v"], same=same))
            topic.subs = {Sub(): None}
            for _ in range(3):
                loop.run_until_complete(hub._refresh(topic))
        finally:
            loop.close()
            hub.pool.shutdown(wait=True)
        return calls

    def test_비교값이_같으면_다시_만들지_않는다(self):
        self.assertEqual(len(self.run_refresh(lambda v: v["v"])), 2)            # 처음 + v 가 바뀐 때

    def test_same_이_없으면_매번_만든다(self):
        self.assertEqual(len(self.run_refresh(None)), 3)


if __name__ == "__main__":
    unittest.main()

# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""서버 복제본 사이 공유(계획 007, OMAI-1105 복제본 2개): 받은편지함·말풍선 이벤트·일하는 중 상태를 공유 DB 로 나눈다."""
import os
import tempfile
import unittest
from pathlib import Path

TMP = tempfile.TemporaryDirectory()
os.environ.setdefault("AAS_DATA_DIR", str(Path(TMP.name) / "data"))

from aas.office import shared  # noqa: E402
from aas.office.inbox import Pending  # noqa: E402
from aas.office.office_state import OfficeBus  # noqa: E402


class Clock:
    def __init__(self):
        self.t = 1000.0

    def __call__(self):
        return self.t


def clear():
    with shared._connect() as conn:
        for t in ("office_servers", "office_relay", "office_busy", "office_inbox", "office_inbox_answers", "office_collected_pod"):
            conn.execute(f"DELETE FROM {t}")


class Base(unittest.TestCase):
    def setUp(self):
        clear()
        self.clock = Clock()
        self.a = shared.Shared("srv-a", clock=self.clock)
        self.b = shared.Shared("srv-b", clock=self.clock)
        self.a.heartbeat()
        self.b.heartbeat()

    tearDown = staticmethod(clear)


class RelayTest(Base):
    def test_말풍선_이벤트는_다른_서버의_이벤트_줄로_건너가고_되돌아오지_않는다(self):
        bus_a, bus_b = OfficeBus(), OfficeBus()
        self.a.attach(bus_a)
        self.b.attach(bus_b)
        self.assertEqual(self.b.relay_in(), [])                            # 처음은 바탕만 잡는다
        bus_a.publish("tool", {"alias": "kim0", "name": "terminal"})
        bus_a.publish("chat.delta", {"alias": "kim0", "text": "안녕", "_to": ["kim@x.com"]})
        self.a.relay_status = lambda: False                                # 리더가 아니다 — 상태는 리더만 계산해 중계한다(스펙 2026-10-24-011 R3)
        bus_a.publish("agent.status", {"alias": "kim0", "status": "working"})
        got = self.b.relay_in()
        self.assertEqual([t for t, _ in got], ["tool", "chat.delta"])
        self.assertEqual(got[1][1]["_to"], ["kim@x.com"])                 # 공개 범위 표가 그대로 적용되게 받는 사람을 지킨다
        self.assertEqual([e["type"] for e in bus_b.after(0, wait=0)], ["tool", "chat.delta"])
        self.assertEqual(self.a.relay_in(), [])                            # 내가 낸 것은 다시 받지 않는다
        self.assertEqual(self.b.relay_in(), [])                            # 한 번 받은 것은 다시 받지 않는다
        self.assertEqual(bus_a.after(0, wait=0)[-1]["type"], "agent.status")  # 건너온 것을 다시 내보내지 않는다(되돌이 없음)

    def test_리더가_계산한_자리_상태와_배치_변경은_다른_서버로_건너간다(self):
        """5초 반복을 리더만 돌린다. 리더가 아닌 서버에 붙은 화면도 상태 변화를 받도록 중계한다(스펙 2026-10-24-011 R3)."""
        bus_a, bus_b = OfficeBus(), OfficeBus()
        self.a.attach(bus_a)
        self.b.attach(bus_b)
        self.b.relay_in()
        for etype in ("agent.status", "seat.added", "seat.removed", "layout.changed"):
            bus_a.publish(etype, {"alias": "kim0", "status": "working"})
        self.assertEqual([t for t, _ in self.b.relay_in()], ["agent.status", "seat.added", "seat.removed", "layout.changed"])

    def test_번호가_처음부터_다시_시작해도_새_중계를_버리지_않는다(self):
        """중계 표는 UNLOGGED 라 PostgreSQL 이 비정상 종료되면 비워지고 번호가 1부터 다시 시작할 수 있다. 받은 번호만 기억하면
        새 중계를 「이미 받음」으로 버렸다(스펙 2026-10-24-010 외부 검토 N9)."""
        bus_a, bus_b = OfficeBus(), OfficeBus()
        self.a.attach(bus_a)
        self.b.attach(bus_b)
        self.b.relay_in()
        bus_a.publish("tool", {"alias": "kim0", "name": "terminal"})
        first = self.b.relay_in()
        with shared._connect() as conn:
            rid = conn.execute("SELECT id FROM office_relay").fetchone()[0]
            conn.execute("DELETE FROM office_relay")
        self.clock.t += 1
        with shared._connect() as conn:                                      # 비워진 뒤 같은 번호로 새 중계가 들어온다
            conn.execute("INSERT INTO office_relay (id, origin, type, payload, ts) VALUES (?,?,?,?,?)",
                         (rid, "srv-a", "tool", '{"alias": "kim0", "name": "browser"}', self.clock()))
        again = self.b.relay_in()
        self.assertEqual([p["name"] for _, p in first + again], ["terminal", "browser"])

    def test_책상_변경_신호도_다른_서버로_건너가_장면이_다시_받는다(self):
        """보기 범위(스펙 2026-10-21-022 리뷰 R5): 방·자리를 바꾼 서버가 아닌 쪽에 붙은 화면도 스냅샷을 다시 받아야 한다."""
        bus_a, bus_b = OfficeBus(), OfficeBus()
        self.a.attach(bus_a)
        self.b.attach(bus_b)
        self.b.relay_in()
        bus_a.publish("desks.changed", {})
        self.assertEqual([t for t, _ in self.b.relay_in()], ["desks.changed"])
        self.assertEqual([e["type"] for e in bus_b.after(0, wait=0)], ["desks.changed"])
        self.assertEqual(self.a.relay_in(), [])

    def test_오래된_중계는_지운다(self):
        self.a.attach(OfficeBus())
        self.a.bus.publish("tool", {"alias": "x", "name": "t"})
        self.clock.t += shared.RELAY_KEEP + 1
        self.a.cleanup()
        with shared._connect() as conn:
            self.assertEqual(conn.execute("SELECT COUNT(*) FROM office_relay").fetchone()[0], 0)


class CollectedTest(Base):
    """담당 서버가 적은 에이전트별 재료를 다른 서버가 나눠 쓴다(스펙 2026-10-24-011 R5 를 2026-10-24-013 R11 로 에이전트별로).
    다른 서버의 첫 오피스 요청이 사이드카를 직접 읽어 1.2초 걸리던 것을 막는 뜻은 그대로다."""
    def test_담당_서버가_적은_줄을_다른_서버가_읽고_오래된_줄은_쓰지_않는다(self):
        self.a.put_collected_pods({"p1": ({("p1", "main")}, {("p1", "ops")}, True)})
        self.assertEqual(self.b.get_collected_pods(15), {"p1": ({("p1", "main")}, {("p1", "ops")}, True)})
        self.clock.t += 16
        self.assertEqual(self.b.get_collected_pods(15), {})


class BusyTest(Base):
    def test_다른_서버의_대화도_일하는_중으로_보이고_서버가_죽으면_빠진다(self):
        self.a.set_busy({("p1", "default")})
        self.assertEqual(self.b.remote_busy(), {("p1", "default")})
        self.assertEqual(self.a.remote_busy(), set())                      # 내 것은 tracker 가 이미 안다
        self.a.set_busy(set())
        self.assertEqual(self.b.remote_busy(), set())
        self.a.set_busy({("p1", "default")})
        self.clock.t += shared.ALIVE + 1
        self.b.heartbeat()
        self.assertEqual(self.b.remote_busy(), set())                      # 신호가 끊긴 서버의 것은 믿지 않는다


class InboxTest(Base):
    def setUp(self):
        super().setUp()
        self.pa = Pending(clock=self.clock, shared=self.a)
        self.pb = Pending(clock=self.clock, shared=self.b)
        self.pa.on_chat("p1", "s1", "kim0", "kim@x.com", "aas.user", {"_by": "lee@x.com"})
        self.pa.on_chat("p1", "s1", "kim0", "kim@x.com", "approval.request", {"request_id": "r1", "command": "rm -rf /tmp/x"})
        self.item_id = Pending.item_id("p1", "s1", "r1")

    def test_다른_서버에_붙은_받는_사람에게도_보이고_답하면_빠진다(self):
        self.assertEqual([i["id"] for i in self.pb.for_person("lee@x.com")], [self.item_id])
        self.assertEqual(self.pb.for_person("kim@x.com"), [])               # 대화를 시작한 사람이 받는다
        self.assertEqual(self.pb.get(self.item_id)["origin"], "srv-a")
        self.pa.on_chat("p1", "s1", "kim0", "kim@x.com", "aas.approval.answered", {"request_id": "r1"})
        self.assertEqual(self.pb.for_person("lee@x.com"), [])

    def test_다른_서버에서_한_답은_대화가_열린_서버가_처리한다(self):
        self.b.answer_put(self.item_id, {"choice": "once"}, "lee@x.com")
        self.assertEqual(self.b.answers_for_me(), [])                      # srv-b 는 그 대화를 모른다
        mine = self.a.answers_for_me()
        self.assertEqual([(m["id"], m["body"]["choice"]) for m in mine], [(self.item_id, "once")])
        self.a.answer_done(self.item_id, {"ok": True})
        self.assertEqual(self.b.answer_result(self.item_id), {"ok": True})
        self.assertEqual(self.a.answers_for_me(), [])

    def test_죽은_서버의_요청은_보이지_않는다(self):
        self.clock.t += shared.ALIVE + 1
        self.b.heartbeat()
        self.assertEqual(self.pb.for_person("lee@x.com"), [])


if __name__ == "__main__":
    unittest.main()

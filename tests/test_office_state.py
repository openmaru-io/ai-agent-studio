# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""오피스 상태·이벤트(계획 003 §3 A안) — 상태 계산, 이벤트 버스, 변화 추적, 입력 수집."""
import threading
import time
import unittest
from types import SimpleNamespace

from aas.office import office_state as os_


def seat(alias, pod="p1", profile=None, enabled=True, **kw):
    return {"alias": alias, "pod": pod, "profile": profile or alias, "enabled": enabled, "title": kw.get("title", ""), "role": kw.get("role", ""),
            "team": kw.get("team", ""), "avatar": kw.get("avatar", "")}


class ComputeState(unittest.TestCase):
    def test_기본은_idle(self):
        out = os_.compute_state([seat("ma")], chat_busy=set(), running=set(), failed=set(), bad_pods=set())
        self.assertEqual([(a["alias"], a["status"]) for a in out], [("ma", "idle")])

    def test_대화_중이거나_크론이_돌면_working(self):
        out = os_.compute_state([seat("a"), seat("b"), seat("c")], chat_busy={("p1", "a")}, running={("p1", "b")}, failed=set(), bad_pods=set())
        self.assertEqual({a["alias"]: a["status"] for a in out}, {"a": "working", "b": "working", "c": "idle"})

    def test_마지막_실행_실패면_error(self):
        out = os_.compute_state([seat("a")], chat_busy=set(), running=set(), failed={("p1", "a")}, bad_pods=set())
        self.assertEqual(out[0]["status"], "error")

    def test_지금_일하는_중이면_실패_표시보다_working_이_앞선다(self):
        out = os_.compute_state([seat("a")], chat_busy={("p1", "a")}, running=set(), failed={("p1", "a")}, bad_pods=set())
        self.assertEqual(out[0]["status"], "working")

    def test_수집_실패한_설치본의_자리는_error(self):
        out = os_.compute_state([seat("a", pod="down")], chat_busy=set(), running=set(), failed=set(), bad_pods={"down"})
        self.assertEqual(out[0]["status"], "error")

    def test_꺼_둔_자리는_빠진다(self):
        out = os_.compute_state([seat("a", enabled=False), seat("b")], chat_busy=set(), running=set(), failed=set(), bad_pods=set())
        self.assertEqual([a["alias"] for a in out], ["b"])

    def test_소개_필드를_그대로_싣는다(self):
        out = os_.compute_state([seat("ma", title="마케팅", role="기획", team="성장", avatar="a1")], set(), set(), set(), set())
        self.assertEqual({k: out[0][k] for k in ("title", "role", "team", "avatar", "pod", "profile")},
                         {"title": "마케팅", "role": "기획", "team": "성장", "avatar": "a1", "pod": "p1", "profile": "ma"})


class Bus(unittest.TestCase):
    def test_번호는_1부터_커지고_after_는_그_뒤만_준다(self):
        bus = os_.OfficeBus()
        self.assertEqual(bus.seq, 0)
        bus.publish("a", {"x": 1})
        bus.publish("b", {})
        self.assertEqual(bus.seq, 2)
        self.assertEqual([e["type"] for e in bus.after(0, wait=0)], ["a", "b"])
        self.assertEqual([e["type"] for e in bus.after(1, wait=0)], ["b"])
        self.assertEqual(bus.after(2, wait=0), [])

    def test_기다리는_쪽은_발행되면_바로_깨어난다(self):
        bus = os_.OfficeBus()
        got = []
        t = threading.Thread(target=lambda: got.extend(bus.after(0, wait=5)))
        t.start()
        time.sleep(0.1)
        bus.publish("hello", {})
        t.join(2)
        self.assertEqual([e["type"] for e in got], ["hello"])

    def test_기다림이_끝나도_없으면_빈_목록(self):
        t0 = time.time()
        self.assertEqual(os_.OfficeBus().after(0, wait=0.2), [])
        self.assertGreaterEqual(time.time() - t0, 0.19)

    def test_오래된_이벤트는_밀려난다(self):
        bus = os_.OfficeBus(keep=3)
        for i in range(5):
            bus.publish("e", {"i": i})
        self.assertEqual([e["payload"]["i"] for e in bus.after(0, wait=0)], [2, 3, 4])


class Tracker(unittest.TestCase):
    def agents(self, **status):
        return [{"alias": a, "pod": "p1", "profile": a, "status": s} for a, s in status.items()]

    def test_처음_갱신은_바탕이라_이벤트를_내지_않는다(self):
        bus = os_.OfficeBus()
        tr = os_.StateTracker(bus)
        tr.update(self.agents(a="idle", b="working"))
        self.assertEqual(bus.seq, 0)

    def test_바뀐_자리만_agent_status_를_낸다(self):
        bus = os_.OfficeBus()
        tr = os_.StateTracker(bus)
        tr.update(self.agents(a="idle", b="idle"))
        tr.update(self.agents(a="working", b="idle"))
        ev = bus.after(0, wait=0)
        self.assertEqual([(e["type"], e["payload"]) for e in ev], [("agent.status", {"alias": "a", "status": "working", "prev": "idle"})])
        tr.update(self.agents(a="working", b="idle"))
        self.assertEqual(bus.seq, 1)

    def test_새로_앉은_자리와_빠진_자리도_알린다(self):
        bus = os_.OfficeBus()
        tr = os_.StateTracker(bus)
        tr.update(self.agents(a="idle"))
        tr.update(self.agents(b="idle"))
        self.assertEqual(sorted((e["type"], e["payload"]["alias"]) for e in bus.after(0, wait=0)), [("seat.added", "b"), ("seat.removed", "a")])

    def test_채팅_이벤트로_진행_중_집합이_갱신된다(self):
        bus = os_.OfficeBus()
        tr = os_.StateTracker(bus)
        tr.on_chat("s1", "p1", "ma", "aas.user", {"text": "q"})
        self.assertEqual(tr.chat_busy(), {("p1", "ma")})
        tr.on_chat("s1", "p1", "ma", "message.complete", {})
        self.assertEqual(tr.chat_busy(), set())

    def test_대화_시작과_끝_도구_호출을_이벤트로_낸다(self):
        bus = os_.OfficeBus()
        tr = os_.StateTracker(bus)
        tr.update([{"alias": "ma", "pod": "p1", "profile": "ma", "status": "idle"}])
        tr.on_chat("s1", "p1", "ma", "aas.user", {"text": "q"})
        tr.on_chat("s1", "p1", "ma", "message.start", {})          # 이미 진행 중이면 시작을 다시 알리지 않는다
        tr.on_chat("s1", "p1", "ma", "tool.start", {"name": "web_search"})
        tr.on_chat("s1", "p1", "ma", "message.delta", {"text": "x"})   # 글 조각은 내보내지 않는다
        tr.on_chat("s1", "p1", "ma", "message.complete", {})
        # 세션 id 는 내보내지 않는다(계획 007 M2)
        self.assertEqual([(e["type"], e["payload"]) for e in bus.after(0, wait=0) if e["type"] != "agent.lastSeen"],
                         [("chat.start", {"alias": "ma"}), ("tool", {"alias": "ma", "name": "web_search"}), ("chat.end", {"alias": "ma"})])

    def test_자리가_없으면_같은_이름의_다른_설치본_자리로_이벤트를_내지_않는다(self):
        """B 설치본의 자리 없는 ma 가 대화하면 A 설치본의 자리 ma 로 나가던 문제(계획 007 H1)."""
        bus = os_.OfficeBus()
        tr = os_.StateTracker(bus)
        tr.update([{"alias": "ma", "pod": "A", "profile": "ma", "status": "idle"}])
        tr.on_chat("s9", "B", "ma", "aas.user", {})
        tr.on_chat("s9", "B", "ma", "tool.start", {"name": "x"})
        tr.on_chat("s9", "B", "ma", "message.complete", {})
        self.assertEqual(bus.seq, 0)

    def test_두_세션이_같은_자리를_쓰면_둘_다_끝나야_idle(self):
        tr = os_.StateTracker(os_.OfficeBus())
        tr.on_chat("s1", "p1", "ma", "aas.user", {})
        tr.on_chat("s2", "p1", "ma", "aas.user", {})
        tr.on_chat("s1", "p1", "ma", "message.complete", {})
        self.assertEqual(tr.chat_busy(), {("p1", "ma")})
        tr.on_chat("s2", "p1", "ma", "error", {})
        self.assertEqual(tr.chat_busy(), set())

    def test_자리에_없는_프로파일의_대화는_이벤트를_내지_않는다(self):
        bus = os_.OfficeBus()
        tr = os_.StateTracker(bus)
        tr.on_chat("s1", "p1", None, "aas.user", {})
        self.assertEqual(bus.seq, 0)
        self.assertEqual(tr.chat_busy(), {("p1", "ma")} - {("p1", "ma")})


class Collect(unittest.TestCase):
    def test_설치본마다_실패와_실행_중을_모은다(self):
        pods = [SimpleNamespace(id="p1", hermes_home="H1"), SimpleNamespace(id="p2", hermes_home="H2")]
        health = {"p1": {"failed_jobs": [{"profile": "ma"}, {"profile": "ops", "muted": True}]},
                  "p2": RuntimeError("읽기 실패")}

        def health_of(pod):
            v = health[pod.id]
            if isinstance(v, Exception):
                raise v
            return v

        running_of = lambda pod: {"p1": {"ma", "kim"}, "p2": set()}[pod.id]            # noqa: E731
        failed, running, bad = os_.collect(pods, health_of, running_of, used_pods={"p1", "p2"})
        self.assertEqual(failed, {("p1", "ma")})                  # 무시한 작업은 세지 않는다
        self.assertEqual(running, {("p1", "ma"), ("p1", "kim")})
        self.assertEqual(bad, {"p2"})

    def test_자리가_없는_설치본은_읽지_않는다(self):
        called = []
        pods = [SimpleNamespace(id="p1", hermes_home="H1"), SimpleNamespace(id="p2", hermes_home="H2")]
        os_.collect(pods, lambda pod: called.append(pod.id) or {"failed_jobs": []}, lambda pod: set(), used_pods={"p1"})
        self.assertEqual(called, ["p1"])


class Snapshot(unittest.TestCase):
    def setUp(self):
        self.pods = [SimpleNamespace(id="p1", hermes_home="H")]
        self.seats = [seat("ma"), seat("ops")]
        self.failed = {"failed_jobs": []}
        self.running = set()

    def snap(self, office):
        return office.snapshot(self.pods, self.seats, lambda pod: self.failed, lambda pod: self.running)

    def test_상태와_번호를_함께_준다(self):
        office = os_.Office()
        out = self.snap(office)
        self.assertEqual({a["alias"]: a["status"] for a in out["agents"]}, {"ma": "idle", "ops": "idle"})
        self.assertEqual(out["seq"], 0)
        self.assertIn("ts", out)

    def test_실행이_돌면_working_이고_바뀐_것만_이벤트가_된다(self):
        office = os_.Office()
        self.snap(office)
        self.running = {"ma"}
        out = self.snap(office)
        self.assertEqual({a["alias"]: a["status"] for a in out["agents"]}["ma"], "working")
        self.assertEqual([(e["type"], e["payload"]["alias"]) for e in office.bus.after(0, wait=0)], [("agent.status", "ma")])
        self.snap(office)
        self.assertEqual(office.bus.seq, 1)

    def test_대화가_진행_중이면_working(self):
        office = os_.Office()
        self.snap(office)
        office.tracker.on_chat("s1", "p1", "ops", "aas.user", {})
        out = self.snap(office)
        self.assertEqual({a["alias"]: a["status"] for a in out["agents"]}["ops"], "working")

    def test_실패한_작업이_있으면_error(self):
        office = os_.Office()
        self.failed = {"failed_jobs": [{"profile": "ma"}]}
        self.assertEqual({a["alias"]: a["status"] for a in self.snap(office)["agents"]}["ma"], "error")


if __name__ == "__main__":
    unittest.main()


class DeltaTest(unittest.TestCase):
    """말풍선 답 글(계획 007 P1·R1·M3)."""

    def setUp(self):
        self.t = [1000.0]
        self.bus = os_.OfficeBus()
        self.tr = os_.StateTracker(self.bus, clock=lambda: self.t[0])
        self.tr.update([{"alias": "ma", "pod": "p1", "profile": "ma", "status": "idle"}])
        self.tr.owners = {"p1": "Owner@x.com"}

    def deltas(self):
        return [e["payload"] for e in self.bus.after(0, wait=0) if e["type"] == "chat.delta"]

    def test_답_글은_대화를_시작한_사람과_주인에게만_1초에_한_번(self):
        self.tr.on_chat("s1", "p1", "ma", "aas.user", {"text": "q", "_by": "Me@x.com"})
        self.tr.on_chat("s1", "p1", "ma", "message.delta", {"text": "안녕"})
        self.tr.on_chat("s1", "p1", "ma", "message.delta", {"text": "하세요"})        # 1초 안 — 보내지 않는다
        self.t[0] += 1.1
        self.tr.on_chat("s1", "p1", "ma", "message.delta", {"text": "!"})
        got = self.deltas()
        self.assertEqual([d["text"] for d in got], ["안녕", "안녕하세요!"])
        self.assertEqual(got[0]["_to"], ["me@x.com", "owner@x.com"])

    def test_최근_80자만_보내고_비밀값은_잘리기_전에_가린다(self):
        self.tr.on_chat("s1", "p1", "ma", "aas.user", {"text": "q", "_by": "me@x.com"})
        secret = "sk-" + "A" * 40
        self.tr.on_chat("s1", "p1", "ma", "message.delta", {"text": "x" * 70 + " 키는 " + secret})
        text = self.deltas()[0]["text"]
        self.assertLessEqual(len(text), 80)
        self.assertNotIn("A" * 10, text)                    # 키의 일부도 보이지 않는다

    def test_대화가_끝나면_쌓인_글을_비우고_마지막_활동_시각을_남긴다(self):
        self.tr.on_chat("s1", "p1", "ma", "aas.user", {"text": "q"})
        self.tr.on_chat("s1", "p1", "ma", "message.complete", {})
        self.assertEqual(self.tr.last_seen["ma"], 1000.0)
        self.assertIn("agent.lastSeen", [e["type"] for e in self.bus.after(0, wait=0)])
        self.assertEqual(self.deltas(), [])                  # 보낸 사람·주인이 없으면 답 글도 없다(주인은 있다 — 글이 없었다)

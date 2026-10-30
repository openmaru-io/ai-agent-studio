# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""오피스 대화의 지난 말 시험 — 화면을 새로 고쳐도 대화 창이 지난 말을 다시 보여 주도록 서버가 돌려준다.

사용자 보고(2026-10-16): 3D 오피스에서 대화한 뒤 다시 열면 「아직 나눈 말이 없습니다」만 보였다. 화면은 대화를 메모리에만
두었고 서버에는 지난 말을 읽는 길이 없었다. 대화는 Hermes 의 office-<사람>-<에이전트> 세션에 남아 있다."""
import json
import os
import tempfile
import threading
import time
import unittest
from pathlib import Path

TMP = tempfile.TemporaryDirectory()
os.environ.setdefault("AAS_DATA_DIR", str(Path(TMP.name) / "data"))

from aas.office import office, relay  # noqa: E402
from aas.hermes.hermes_chat import ChatHub  # noqa: E402

try:
    from tests.test_office import KNOWN, SETTINGS, FakeRegistry, FakeWS  # noqa: E402
except ImportError:                                            # unittest discover -s tests 로 돌릴 때
    from test_office import KNOWN, SETTINGS, FakeRegistry, FakeWS  # noqa: E402


class StoredWS(FakeWS):
    """다시 열면 Hermes 에 저장된 지난 말을 돌려준다(도구 줄·빈 답 포함)."""

    def send(self, data: str):
        frame = json.loads(data)
        if frame["method"] == "session.resume":
            self.sent.append(frame)
            self.reply(frame["id"], {"session_id": "yj-r1", "messages": [
                {"role": "user", "text": "어제 회의 정리해줘"},
                {"role": "assistant", "text": ""},
                {"role": "tool", "text": "", "name": "web_search"},
                {"role": "assistant", "text": "정리했습니다"},
            ]})
            return
        super().send(data)


class SlowResumeWS(FakeWS):
    """stored-slow 대화만 다시 여는 데 delay 초가 걸린다(Hermes 가 연결은 받았지만 늦게 답함)."""

    def __init__(self, name: str, delay: float = 2.0):
        super().__init__(name)
        self.delay = delay

    def send(self, data: str):
        frame = json.loads(data)
        if frame["method"] == "session.resume" and frame["params"]["session_id"] == "stored-slow":
            self.sent.append(frame)
            threading.Timer(self.delay, self.reply, args=(frame["id"], {"session_id": "yj-r-slow", "messages": []})).start()
            return
        super().send(data)


class OfficeChatHistoryTest(unittest.TestCase):
    def setUp(self):
        with office.connect() as conn:
            for t in ("office_seats", "office_sessions"):
                conn.execute(f"DELETE FROM {t}")
        office.set_seat({"pod": "yj", "profile": "sa"}, "me", KNOWN)
        self.seat = next(s for s in office.seats() if s["alias"] == "sa")
        self.wss: list[FakeWS] = []

    def tearDown(self):
        for w in self.wss:
            w.inbox.put(None)
        with office.connect() as conn:
            for t in ("office_seats", "office_sessions"):
                conn.execute(f"DELETE FROM {t}")

    def bridge(self, ws: FakeWS) -> relay.Bridge:
        self.wss.append(ws)
        return relay.Bridge(FakeRegistry(), lambda pod: ChatHub(SETTINGS, connect=lambda: ws))

    def wait_done(self, turn: relay.Turn) -> None:
        end = time.time() + 10
        while not turn.done and time.time() < end:
            time.sleep(0.02)
        self.assertTrue(turn.done)

    def stored_row(self, title: str, stored: str) -> dict:
        row, _ = office.session_create("sa", title)
        office.session_stored(row["id"], stored)
        return next(r for r in office.session_rows("sa") if r["id"] == row["id"])

    def test_한_대화를_다시_여는_것이_느려도_다른_대화와_허브는_기다리지_않는다(self):
        """중계 잠금 하나를 서버 전체가 쓰고, 그 안에서 Hermes 다시 열기(최대 180초)를 기다렸다. Hermes 하나가 늦으면
        모든 사람의 오피스 대화·칸반·회의가 줄을 섰다(스펙 2026-10-24-002 R1)."""
        ws = SlowResumeWS("yj")
        b = self.bridge(ws)
        slow, fast = self.stored_row("office-kim-sa", "stored-slow"), self.stored_row("office-lee-sa", "stored-fast")
        b.hub("yj")                                            # 허브는 먼저 만들어 둔다 — 시험은 잠금만 본다
        t = threading.Thread(target=b.history, args=(slow, self.seat), daemon=True)
        t.start()
        time.sleep(0.3)                                        # 느린 다시 열기가 잠금을 잡을 때까지
        began = time.monotonic()
        self.assertEqual(b.history(fast, self.seat)["messages"], [])
        b.hub("yj")
        self.assertLess(time.monotonic() - began, 1.0)
        t.join(5)

    def test_다시_여는_중에_잊은_대화는_다시_살아나지_않는다(self):
        """열기가 Hermes 를 기다리는 사이(중계 잠금 밖) 회의 「새 대화」가 앞 차례 대화를 잊으면, 열기가 끝나며 잊은 대화를
        메모리에 다시 썼다(스펙 2026-10-24-002 외부 검토 6). 열기는 결과를 버리고 「대화를 쓸 수 없음」으로 끝난다."""
        ws = SlowResumeWS("yj", delay=0.6)
        b = self.bridge(ws)
        slow = self.stored_row("office-kim-sa", "stored-slow")
        b.hub("yj")
        errors = []

        def read():
            try:
                b.history(slow, self.seat)
            except relay.ChatUnavailable as exc:
                errors.append(exc)
        t = threading.Thread(target=read, daemon=True)
        t.start()
        time.sleep(0.2)                                        # 열기가 Hermes 를 기다리는 중
        b.forget([slow["id"]])
        t.join(5)
        self.assertEqual(len(errors), 1)
        self.assertNotIn(slow["id"], b._live)
        self.assertNotIn(slow["id"], b._log)

    def test_열기가_끝나면_대화별_잠금을_남기지_않는다(self):
        """대화별 열기 잠금이 잊을 때만 지워져 대화 수만큼 늘었다(외부 검토 6)."""
        ws = SlowResumeWS("yj", delay=0.3)
        b = self.bridge(ws)
        slow = self.stored_row("office-kim-sa", "stored-slow")
        threads = [threading.Thread(target=b.history, args=(slow, self.seat), daemon=True) for _ in range(3)]
        for t in threads:
            t.start()
        for t in threads:
            t.join(5)
        self.assertEqual(b._opening, {})

    def test_같은_대화를_동시에_열어도_Hermes_다시_열기는_한_번이다(self):
        """잠금을 대화별로 나눠도 같은 대화를 두 요청이 함께 열면 안 된다 — 세션이 둘 생긴다(스펙 2026-10-24-002 검토 D5)."""
        ws = SlowResumeWS("yj", delay=1.0)
        b = self.bridge(ws)
        slow = self.stored_row("office-kim-sa", "stored-slow")
        got = []
        threads = [threading.Thread(target=lambda: got.append(b.history(slow, self.seat)), daemon=True) for _ in range(3)]
        for t in threads:
            t.start()
        for t in threads:
            t.join(5)
        self.assertEqual(len(got), 3)
        self.assertEqual(sum(1 for f in ws.sent if f["method"] == "session.resume"), 1)

    def test_답이_끝나는_동안_동시에_읽어도_답과_차례가_겹치지_않는다(self):
        """잠금을 나눈 뒤에도 기록 읽기와 답 넣기는 같은 잠금으로 맞춘다 — 차례가 남았는데 답이 보이거나, 차례가 없는데
        답이 없으면 화면에 답이 두 번 보이거나 빠진다(스펙 2026-10-24-002 검토 D5)."""
        gate = threading.Event()
        ws = FakeWS("yj")

        def later(sid, text):
            def go():
                gate.wait(5)
                ws.inbox.put(json.dumps({"method": "event", "params": {"type": "message.complete", "session_id": sid, "payload": {"text": "끝난 답"}}}))
            threading.Thread(target=go, daemon=True).start()
            return []
        ws.script = later
        b = self.bridge(ws)
        row, _ = office.session_create("sa", "office-kim-sa")
        turn = b.start("sa", self.seat, row, "질문", by="kim@x.com")
        seen, stop = [], threading.Event()

        def reader():
            while not stop.is_set():
                out = b.history(row, self.seat)
                seen.append((out["turn"], any(m["text"] == "끝난 답" for m in out["messages"])))
        readers = [threading.Thread(target=reader, daemon=True) for _ in range(4)]
        for r in readers:
            r.start()
        time.sleep(0.1)
        gate.set()
        self.wait_done(turn)
        end = time.time() + 5
        while time.time() < end and b.history(row, self.seat)["turn"]:
            time.sleep(0.02)
        time.sleep(0.1)
        stop.set()
        for r in readers:
            r.join(5)
        self.assertTrue(seen)
        for running, has_answer in seen:
            self.assertNotEqual(bool(running), has_answer, (running, has_answer))

    def test_대화가_없으면_빈_목록이고_Hermes_세션을_만들지_않는다(self):
        ws = FakeWS("yj")
        b = self.bridge(ws)
        self.assertEqual(b.history(None, self.seat), {"messages": [], "turn": None})
        row, _ = office.session_create("sa", "office-kim-sa")
        self.assertEqual(b.history(row, self.seat), {"messages": [], "turn": None})
        self.assertEqual([f["method"] for f in ws.sent], [])

    def test_끝난_차례는_보낸_말과_답으로_남는다(self):
        b = self.bridge(FakeWS("yj"))
        row, _ = office.session_create("sa", "office-kim-sa")
        self.wait_done(b.start("sa", self.seat, row, "일정 알려줘", by="kim@x.com"))
        b.history(row, self.seat)                              # 답 기록은 차례가 끝난 뒤 붙는다 — 한 번 더 읽어 확인
        end = time.time() + 5
        while time.time() < end and len(b.history(row, self.seat)["messages"]) < 2:
            time.sleep(0.02)
        self.assertEqual(b.history(row, self.seat), {"messages": [
            {"role": "user", "text": "일정 알려줘"}, {"role": "assistant", "text": "[yj] 답"}], "turn": None})

    def test_서버를_다시_띄워도_Hermes_에_저장된_지난_말을_다시_읽는다(self):
        row, _ = office.session_create("sa", "office-kim-sa")
        office.session_stored(row["id"], "stored-yj-s1")
        row = next(r for r in office.session_rows("sa") if r["id"] == row["id"])
        ws = StoredWS("yj")
        out = self.bridge(ws).history(row, self.seat)
        self.assertEqual(out["messages"], [{"role": "user", "text": "어제 회의 정리해줘"}, {"role": "assistant", "text": "정리했습니다"}])
        self.assertEqual([f["method"] for f in ws.sent], ["session.resume"])

    def test_서버가_다시_시작된_뒤_늦게_끝난_답은_다음_읽기에서_Hermes_에_다시_묻는다(self):
        """새 서버는 차례를 몰라 화면이 기록을 다시 읽는다. 한 번 읽은 기록을 메모리에 들고 있으면 늦게 끝난 답이 보이지 않았다(스펙 2026-10-20-030 D8)."""
        class LateWS(FakeWS):
            def send(self, data: str):
                frame = json.loads(data)
                if frame["method"] == "session.resume":
                    self.sent.append(frame)
                    self.reply(frame["id"], {"session_id": "yj-r1", "messages": [{"role": "user", "text": "늦게 끝날 질문"}]})
                    return
                if frame["method"] == "session.history":
                    self.sent.append(frame)
                    self.reply(frame["id"], {"count": 2, "messages": [
                        {"role": "user", "text": "늦게 끝날 질문"}, {"role": "assistant", "text": "끝난 답"}]})
                    return
                super().send(data)
        row, _ = office.session_create("sa", "office-kim-sa")
        office.session_stored(row["id"], "stored-yj-s1")
        row = next(r for r in office.session_rows("sa") if r["id"] == row["id"])
        ws = LateWS("yj")
        b = self.bridge(ws)
        self.assertEqual(b.history(row, self.seat)["messages"], [{"role": "user", "text": "늦게 끝날 질문"}])
        self.assertEqual(b.history(row, self.seat)["messages"],
                         [{"role": "user", "text": "늦게 끝날 질문"}, {"role": "assistant", "text": "끝난 답"}])
        hist = [f for f in ws.sent if f["method"] == "session.history"]
        self.assertEqual(hist[0]["params"], {"session_id": "yj-r1"})            # 계약에 없는 인자는 넣지 않는다
        b.history(row, self.seat)                                                # 진행 중인 차례가 없으면 늘 Hermes 에 다시 묻는다(T11)
        self.assertEqual([f["method"] for f in ws.sent], ["session.resume", "session.history", "session.history"])

    def test_다른_복제본이_뒤의_차례를_맡았으면_낡은_기록_대신_Hermes_기록을_돌려준다(self):
        """OKE 에서 파드를 지운 뒤 살아남은 파드가 앞서 읽어 둔 첫 문답만 돌려줘 창이 낡은 기록으로 바뀌었다. 뒤의 두 문답은
        다른 파드가 맡았다 — 마지막 줄이 답이라 다시 묻지 않았다(스펙 2026-10-20-030 T11)."""
        class TwoWS(FakeWS):
            def send(self, data: str):
                frame = json.loads(data)
                if frame["method"] == "session.resume":
                    self.sent.append(frame)
                    self.reply(frame["id"], {"session_id": "yj-r1", "messages": [
                        {"role": "user", "text": "첫 질문"}, {"role": "assistant", "text": "첫 답"}]})
                    return
                if frame["method"] == "session.history":
                    self.sent.append(frame)
                    self.reply(frame["id"], {"messages": [
                        {"role": "user", "text": "첫 질문"}, {"role": "assistant", "text": "첫 답"},
                        {"role": "user", "text": "둘째 질문"}, {"role": "assistant", "text": "둘째 답"}]})
                    return
                super().send(data)
        row, _ = office.session_create("sa", "office-kim-sa")
        office.session_stored(row["id"], "stored-yj-s1")
        row = next(r for r in office.session_rows("sa") if r["id"] == row["id"])
        b = self.bridge(TwoWS("yj"))
        self.assertEqual(b.history(row, self.seat)["messages"][-1], {"role": "assistant", "text": "첫 답"})
        self.assertEqual(b.history(row, self.seat)["messages"][-1], {"role": "assistant", "text": "둘째 답"})

    def test_되묻기_물음은_다시_읽어도_선택지와_함께_남는다(self):
        """중계는 되묻기를 받으면 차례를 멈춰 Hermes 에 물음이 assistant 말로 남지 않고 clarify 도구 줄로만 남는다.
        도구 줄을 버리면 새로 고친 창에 물음이 사라지고 내 말만 남았다(2026-10-23 로컬 재현, 스펙 2026-10-23-005 §6).
        줄 모양은 Hermes v0.22.2 session_history._history_to_messages 그대로다."""
        ask = {"role": "tool", "name": "clarify", "context": "보고서 형식은?",
               "args": {"questions": [{"question": "보고서 형식은?", "choices": ["PDF", "Word", "Markdown"]}]}}

        class AskWS(FakeWS):
            def send(self, data: str):
                frame = json.loads(data)
                if frame["method"] in ("session.resume", "session.history"):
                    self.sent.append(frame)
                    self.reply(frame["id"], {"session_id": "yj-r1", "messages": [
                        {"role": "user", "text": "보고서 만들어줘"}, {"role": "assistant", "text": ""}, ask,
                        {"role": "assistant", "text": ""}]})
                    return
                super().send(data)
        want = [{"role": "user", "text": "보고서 만들어줘"},
                {"role": "assistant", "text": "보고서 형식은?",
                 "choices": [{"question": "보고서 형식은?", "choices": ["PDF", "Word", "Markdown"], "multi": False}]}]
        row, _ = office.session_create("sa", "office-kim-sa")
        office.session_stored(row["id"], "stored-yj-s1")
        row = next(r for r in office.session_rows("sa") if r["id"] == row["id"])
        b = self.bridge(AskWS("yj"))
        self.assertEqual(b.history(row, self.seat)["messages"], want)          # 다시 열 때(aas.history)
        self.assertEqual(b.history(row, self.seat)["messages"], want)          # 다시 읽을 때(session.history)

    def test_인자가_없는_되묻기_도구_줄은_미리보기_글을_물음으로_쓴다(self):
        self.assertEqual(relay.asked({"role": "tool", "name": "clarify", "context": "어느 환경에 배포할까요?"}),
                         {"role": "assistant", "text": "어느 환경에 배포할까요?"})
        self.assertIsNone(relay.asked({"role": "tool", "name": "web_search", "context": "날씨"}))
        self.assertIsNone(relay.asked({"role": "tool", "name": "clarify"}))
        # LLM 이 questions 를 글(JSON 문자열)로 넘겨 Hermes 가 거절한 호출 — 물음이 아니다(2026-10-23 OKE 기록에서 2건)
        self.assertIsNone(relay.asked({"role": "tool", "name": "clarify", "context": "보고서 형식을 골라주세요.",
                                       "args": {"questions": "[{\"question\": \"보고서 형식을 골라주세요.\"}]"}}))

    def test_답하는_중이면_그_차례를_함께_돌려주고_답은_아직_넣지_않는다(self):
        gate = threading.Event()
        ws = FakeWS("yj")

        def slow(sid, text):                                   # 답은 gate 가 열린 뒤에 온다
            def later():
                gate.wait(5)
                ws.inbox.put(json.dumps({"method": "event", "params": {"type": "message.complete", "session_id": sid, "payload": {"text": "늦은 답"}}}))
            threading.Thread(target=later, daemon=True).start()
            return []
        ws.script = slow
        b = self.bridge(ws)
        row, _ = office.session_create("sa", "office-kim-sa")
        turn = b.start("sa", self.seat, row, "천천히", by="kim@x.com")
        self.assertEqual(b.history(row, self.seat), {"messages": [{"role": "user", "text": "천천히"}], "turn": turn.id})
        gate.set()
        self.wait_done(turn)
        end = time.time() + 5
        while time.time() < end and b.history(row, self.seat)["turn"]:
            time.sleep(0.02)
        self.assertEqual(b.history(row, self.seat)["messages"][-1], {"role": "assistant", "text": "늦은 답"})

    def test_저장_아이디는_답이_끝나기_전에_적는다(self):
        """첫 질문의 답 도중 서버가 다시 시작되면 새 서버가 다시 열 Hermes 대화를 몰라 기록이 비었다. 화면은 5분 동안 다시 읽다
        「받지 못했습니다」를 보였다 — Hermes 에는 답이 있었다(스펙 2026-10-20-030 T9)."""
        gate = threading.Event()
        ws = FakeWS("yj")

        def slow(sid, text):                                   # 제목(저장 아이디)은 바로, 답은 gate 가 열린 뒤에
            ws.inbox.put(json.dumps({"method": "event", "params": {"type": "session.title", "session_id": sid, "payload": {"session_id": "stored-yj-t1"}}}))

            def later():
                gate.wait(5)
                ws.inbox.put(json.dumps({"method": "event", "params": {"type": "message.complete", "session_id": sid, "payload": {"text": "늦은 답"}}}))
            threading.Thread(target=later, daemon=True).start()
            return []
        ws.script = slow
        b = self.bridge(ws)
        row, _ = office.session_create("sa", "office-kim-sa")
        turn = b.start("sa", self.seat, row, "천천히", by="kim@x.com")
        stored = lambda: next(r for r in office.session_rows("sa") if r["id"] == row["id"])["stored_id"]  # noqa: E731
        end = time.time() + 5
        while time.time() < end and not stored():
            time.sleep(0.02)
        self.assertFalse(turn.done)
        self.assertEqual(stored(), "stored-yj-t1")
        gate.set()
        self.wait_done(turn)


if __name__ == "__main__":
    unittest.main()

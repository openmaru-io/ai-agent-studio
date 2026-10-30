# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""받은편지함 시험(계획 007 P4): 답하지 않은 승인·되묻기를 받는 사람에게만, 답하거나 대화가 끝나면 지운다."""
import unittest

from aas.office.inbox import Pending, cards_for


class PendingTest(unittest.TestCase):
    def setUp(self):
        self.p = Pending(clock=lambda: 1.0)

    def ask(self, sid="s1", by="me@x.com", owner="owner@x.com"):
        if by is not None:
            self.p.on_chat("pod", sid, "ma", owner, "aas.user", {"text": "q", "_by": by})
        self.p.on_chat("pod", sid, "ma", owner, "approval.request", {"request_id": "r1", "command": "rm -rf /tmp/x", "description": "파일 삭제",
                                                                  "choices": ["once", "deny"]})

    def test_승인_요청은_대화를_시작한_사람에게만_보인다(self):
        self.ask()
        mine = self.p.for_person("ME@x.com")
        self.assertEqual([(i["kind"], i["text"], i["choices"]) for i in mine], [("approval", "파일 삭제", ["once", "deny"])])
        self.assertEqual(self.p.for_person("owner@x.com"), [])
        self.assertEqual(self.p.for_person(""), [])

    def test_시작한_사람을_모르면_주인이_받는다(self):
        """회의·칸반 실행처럼 사람이 보내지 않은 대화의 승인(독립 검토 H2)."""
        self.ask(by=None)
        self.assertEqual(len(self.p.for_person("owner@x.com")), 1)

    def test_답하거나_대화가_끝나면_지운다(self):
        self.ask()
        self.p.on_chat("pod", "s1", "ma", "o", "aas.approval.answered", {"request_id": "r1", "choice": "once"})
        self.assertEqual(self.p.for_person("me@x.com"), [])
        self.ask(sid="s2")
        self.p.on_chat("pod", "s2", "ma", "o", "message.complete", {})
        self.assertEqual(self.p.for_person("me@x.com"), [])

    def test_되묻기_묶음은_질문마다_항목이_된다(self):
        self.p.on_chat("pod", "s1", "ma", "o", "aas.user", {"_by": "me@x.com"})
        self.p.on_chat("pod", "s1", "ma", "o", "clarify.request",
                       {"request_id": "q1", "questions": [{"question_id": "a", "question": "어느 쪽?"}, {"question_id": "b", "question": "언제?"}]})
        self.assertEqual([i["text"] for i in self.p.for_person("me@x.com")], ["어느 쪽?", "언제?"])
        self.p.on_chat("pod", "s1", "ma", "o", "aas.clarify.answered", {"request_id": "q1", "question_id": "a"})
        self.assertEqual([i["text"] for i in self.p.for_person("me@x.com")], ["언제?"])

    def test_명령에_든_비밀값은_가린다(self):
        self.p.on_chat("pod", "s1", "ma", "o", "aas.user", {"_by": "me@x.com"})
        self.p.on_chat("pod", "s1", "ma", "o", "approval.request", {"request_id": "r", "command": "curl -H 'Authorization: Bearer abcdefghijklmnop'"})
        self.assertNotIn("abcdefghijklmnop", self.p.for_person("me@x.com")[0]["command"])


    def test_항목이_생기거나_빠질_때만_받는_사람에게_알린다(self):
        """답 조각(message.delta)마다 받은편지함 토픽을 다시 읽지 않게(스펙 2026-10-17-004 L6)."""
        told = []
        self.p.notify = lambda emails: told.append(set(emails))
        self.ask()
        self.assertEqual(told, [{"me@x.com"}])
        self.p.on_chat("pod", "s1", "ma", "o", "message.delta", {"text": "조각"})
        self.assertEqual(len(told), 1)
        self.p.on_chat("pod", "s1", "ma", "o", "aas.approval.answered", {"request_id": "r1"})
        self.assertEqual(told[-1], {"me@x.com"})

    # 스펙 2026-10-23-005: Hermes 가 요청을 끝내면(시간 초과·중단·다른 곳에서 답함) 이유와 상관없이 항목을 지운다(R4)
    def test_요청이_취소되면_항목을_지운다(self):
        self.ask()
        self.p.on_chat("pod", "s1", "ma", "o", "aas.request.cancelled", {"request_id": "r1", "method": "approval", "reason": "timeout"})
        self.assertEqual(self.p.for_person("me@x.com"), [])

    # 오피스 중계는 되묻기를 대화창 글로 바꾸고 곧바로 취소한다 — 항목이 생겼다 사라지며 알림이 깜박이지 않게 넣지 않는다(R15). 승인은 넣는다
    def test_오피스_중계_대화의_되묻기는_넣지_않는다(self):
        told = []
        self.p.notify = lambda emails: told.append(set(emails))
        self.p.on_chat("pod", "s1", "ma", "o", "aas.user", {"_by": "me@x.com"})
        self.p.on_chat("pod", "s1", "ma", "o", "clarify.request",
                       {"request_id": "srq-1", "questions": [{"question_id": "q0", "question": "형식?"}], "_relay": True})
        self.assertEqual((self.p.for_person("me@x.com"), told), ([], []))
        self.p.on_chat("pod", "s1", "ma", "o", "approval.request", {"request_id": "r2", "command": "ls", "_relay": True})
        self.assertEqual([i["kind"] for i in self.p.for_person("me@x.com")], ["approval"])

    # 다시 연 대화의 묶음 되묻기: 이미 잠긴 답(answers)의 질문은 다시 묻지 않는다(R6·F5)
    def test_다시_받은_묶음의_답한_질문은_넣지_않는다(self):
        self.p.on_chat("pod", "s1", "ma", "o", "aas.user", {"_by": "me@x.com"})
        self.p.on_chat("pod", "s1", "ma", "o", "clarify.request",
                       {"request_id": "srq-2", "questions": [{"question_id": "q0", "question": "형식?"}, {"question_id": "q1", "question": "언제?"}],
                        "answers": {"q0": "PDF"}})
        self.assertEqual([i["text"] for i in self.p.for_person("me@x.com")], ["언제?"])


class CardsTest(unittest.TestCase):
    def test_검토·막힘_카드는_소유자에게만(self):
        rows = [{"board": "b", "task_id": "1", "status": "review", "assignee": "ma", "title": "보고서"},
                {"board": "b", "task_id": "2", "status": "blocked", "assignee": "ma", "title": "배포"},
                {"board": "b", "task_id": "3", "status": "running", "assignee": "ma", "title": "진행"}]
        owners = {("b", "1"): "me@x.com", ("b", "2"): "other@x.com", ("b", "3"): "me@x.com"}
        self.assertEqual([c["text"] for c in cards_for(rows, owners, "me@x.com")], ["보고서"])


if __name__ == "__main__":
    unittest.main()

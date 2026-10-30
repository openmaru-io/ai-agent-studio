# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""회의 시험 — 설치본 둘의 가짜 대화 채널로, 방의 말이 참가한 에이전트에게만 가고 답이 기록에 쌓이는지 본다."""
import io
import os
import tempfile
import time
import unittest
from pathlib import Path

TMP = tempfile.TemporaryDirectory()
os.environ.setdefault("AAS_DATA_DIR", str(Path(TMP.name) / "data"))

from aas.office import meeting, meeting_files, office, relay, shared  # noqa: E402
from aas.hermes import attach_notice, workspace as wsp  # noqa: E402
from aas.hermes.hermes_chat import ChatHub  # noqa: E402

try:
    from tests.test_office import KNOWN, SETTINGS, FakeRegistry, FakeWS  # noqa: E402
except ImportError:                                            # unittest discover -s tests 로 돌릴 때
    from test_office import KNOWN, SETTINGS, FakeRegistry, FakeWS  # noqa: E402


class MeetingTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.ws = {"yj": FakeWS("yj"), "scdf": FakeWS("scdf")}
        cls.bridge = relay.Bridge(FakeRegistry(), lambda pod: ChatHub(SETTINGS, connect=lambda: cls.ws[pod.id]))
        cls.meeting = meeting.Meeting(cls.bridge)
        with office.connect() as conn:
            for t in ("office_seats", "office_rooms", "office_sessions"):
                conn.execute(f"DELETE FROM {t}")
        with meeting._db() as conn:
            conn.execute("DELETE FROM office_messages")
        office.set_seat({"pod": "yj", "profile": "sa", "title": "영업"}, "me", KNOWN)
        office.set_seat({"pod": "scdf", "profile": "scdf-doc"}, "me", KNOWN)
        cls.room = office.set_room({"name": "제안 TFT", "purpose": "RFP 대응", "seats": ["sa", "scdf-doc"], "people": ["kim"]}, "me")["id"]
        cls.bridge.routes(0)

    @classmethod
    def tearDownClass(cls):
        for w in cls.ws.values():
            w.inbox.put(None)
        with meeting._db() as conn:                            # 회의 목록 상태는 공유 데이터 폴더에 남는다 — 다른 시험이 같은 방 번호를 쓴다
            conn.execute("DELETE FROM office_meeting_live")
            conn.execute("DELETE FROM office_meeting_pending")

    def settle(self, want_messages: int, timeout: float = 10.0) -> dict:
        end, view = time.time() + timeout, {}
        while time.time() < end:
            view = self.meeting.view(self.room)
            if not view["pending"] and len(view["messages"]) >= want_messages:
                return view
            time.sleep(0.05)
        self.fail(f"회의 기록이 {want_messages}개가 되지 않았습니다: {view}")

    def test_1_말은_참가한_에이전트_모두에게_가고_답이_쌓인다(self):
        out = self.meeting.say(self.room, "kim", "일정 어떻게 돼?")
        self.assertEqual(sorted(out["targets"]), ["sa", "scdf-doc"])
        view = self.settle(3)
        msgs = view["messages"]
        self.assertEqual((msgs[0]["role"], msgs[0]["author"], msgs[0]["content"]), ("user", "kim", "일정 어떻게 돼?"))
        self.assertEqual({(m["author"], m["content"]) for m in msgs[1:]}, {("sa", "[yj] 답"), ("scdf-doc", "[scdf] 답")})
        self.assertEqual([p["alias"] for p in view["participants"]], ["sa", "scdf-doc"])
        self.assertIn("[말한 사람] kim\n[이번 말]\n일정 어떻게 돼?", self.ws["yj"].prompts()[-1])
        self.assertIn("제안 TFT", self.ws["yj"].prompts()[-1])           # 첫 말에는 방의 지시가 붙는다

    def test_2_받을_에이전트를_고르면_나머지는_받지_않는다(self):
        before = len(self.ws["scdf"].prompts())
        self.meeting.say(self.room, "kim", "영업만 답해", ["sa"])
        self.settle(5)
        self.assertEqual(len(self.ws["scdf"].prompts()), before)
        # 다음에 scdf-doc 에게 말하면, 못 본 말(영업에게만 한 말과 영업의 답)이 「이름: 말」 로 같이 간다
        self.meeting.say(self.room, "kim", "이제 문서도", ["scdf-doc"])
        self.settle(7)
        sent = self.ws["scdf"].prompts()[-1]
        self.assertIn("kim: 영업만 답해", sent)
        self.assertIn("sa: [yj] 답", sent)
        self.assertTrue(sent.endswith("[말한 사람] kim\n[이번 말]\n이제 문서도"))
        self.assertNotIn("kim: 일정 어떻게 돼?", sent)                   # 이미 받은 말은 다시 보내지 않는다

    def test_2b_관리하지_않는_에이전트에게는_위키_쓰기_도구를_막고_보낸다(self):
        """스펙 2026-10-23-004 15-9: managed 에 없는 자리는 aas_blocked_tools 를 붙여 보내고, 있는 자리와 옛 호출(None)은 붙이지 않는다."""
        def submits(pod):
            return [f["params"] for f in self.ws[pod].sent if f.get("method") == "prompt.submit"]
        n = len(self.meeting.view(self.room)["messages"])
        a, b = len(submits("yj")), len(submits("scdf"))
        self.meeting.say(self.room, "kim", "위키에 써 줘", managed={"sa"})
        self.settle(n + 3)
        self.assertNotIn("aas_blocked_tools", submits("yj")[a])
        self.assertIn("mcp__*__create_document", submits("scdf")[b]["aas_blocked_tools"])
        self.meeting.say(self.room, "kim", "옛 호출")
        self.settle(n + 6)
        self.assertNotIn("aas_blocked_tools", submits("scdf")[-1])

    def test_3_거절하는_경우(self):
        for args, code in (((999, "kim", "x"), 404), ((self.room, "kim", "  "), 400), ((self.room, "kim", "x", ["ghost"]), 400)):
            with self.assertRaises(meeting.MeetingError) as cm:
                self.meeting.say(*args)
            self.assertEqual(cm.exception.code, code)
        closed = office.set_room({"name": "끝난 방", "seats": ["sa"], "status": "closed"}, "me")["id"]
        with self.assertRaises(meeting.MeetingError) as cm:
            self.meeting.say(closed, "kim", "x")
        self.assertEqual(cm.exception.code, 409)
        empty = office.set_room({"name": "빈 방", "seats": []}, "me")["id"]
        with self.assertRaises(meeting.MeetingError) as cm:
            self.meeting.say(empty, "kim", "x")
        self.assertEqual(cm.exception.code, 409)

    def test_4_한_에이전트가_실패해도_나머지_답은_쌓인다(self):
        n = len(self.meeting.view(self.room)["messages"])
        ws = self.ws["yj"]
        ws.script = lambda sid, text: [("message.complete", {"status": "error", "text": "모델이 답하지 않습니다"})]
        try:
            self.meeting.say(self.room, "kim", "둘 다 답해")
            view = self.settle(n + 3)
        finally:
            ws.script = None
        new = view["messages"][n:]
        self.assertIn(("system", "sa"), {(m["role"], m["author"]) for m in new})
        self.assertIn("모델이 답하지 않습니다", next(m["content"] for m in new if m["role"] == "system"))
        self.assertIn(("assistant", "scdf-doc"), {(m["role"], m["author"]) for m in new})

    def test_4b_가드레일_차단_답은_차단_줄로_남고_막힌_말은_다음_턴에_다시_가지_않는다(self):
        """스펙 2026-10-20-026 R6·R6b: 훅의 차단 안내(80자 이하 + 핵심 구절)는 에이전트 답이 아니라 guard_blocked 시스템 행이다.
        그 행이 그 에이전트의 기준점이 되어, 막힌 말이 다음 턴의 방 기록에 다시 실리지 않는다."""
        ws = self.ws["yj"]
        n = len(self.meeting.view(self.room)["messages"])
        for blocked in ("🚫 죄송합니다. 입력하신 내용이 정책에 위반되어 처리할 수 없습니다.", "입력하신 내용이 정책에 위반되어 처리할 수 없습니다"):
            ws.script = lambda sid, text, b=blocked: [("message.complete", {"text": b})]
            try:
                self.meeting.say(self.room, "kim", "이 채팅방에 저장해줘", ["sa"])
                view = self.settle(n + 2)
            finally:
                ws.script = None
            user, row = view["messages"][n:n + 2]
            self.assertEqual((row["role"], row["kind"], row["author"], row["data"]), ("system", "guard_blocked", "sa", {"alias": "sa"}))
            self.assertEqual(row["content"], "sa 는 가드레일에 막혀 답하지 못했습니다")     # 예전 화면·회의 요약이 읽는 대체 문장
            self.meeting.say(self.room, "kim", "다음 말", ["sa"])
            self.settle(n + 4)
            self.assertNotIn("이 채팅방에 저장해줘", ws.prompts()[-1])
            n = len(self.meeting.view(self.room)["messages"])
        for answer in ("가" * 60 + " 입력하신 내용이 정책에 위반되어 처리할 수 없습니다",    # 80자를 넘는다
                       "그 요청은 정책상 처리할 수 없습니다. 대신 이렇게 해 보세요."):          # 핵심 구절이 없다
            ws.script = lambda sid, text, a=answer: [("message.complete", {"text": a})]
            try:
                self.meeting.say(self.room, "kim", "정책 설명", ["sa"])
                view = self.settle(n + 2)
            finally:
                ws.script = None
            self.assertEqual((view["messages"][n + 1]["role"], view["messages"][n + 1]["author"]), ("assistant", "sa"))
            n = len(view["messages"])

    def test_5_after_로_새_기록만_읽는다(self):
        view = self.meeting.view(self.room)
        last = view["messages"][-1]["id"]
        self.assertEqual(self.meeting.view(self.room, last)["messages"], [])
        self.assertEqual(len(self.meeting.view(self.room, last - 1)["messages"]), 1)


    def test_9_회의_중인_방은_장면에_알리고_시간이_지나면_빠진다(self):
        """계획 007 P3: 말이 오간 방은 ACTIVE_FOR 동안 회의 중이다(참가 에이전트가 회의실로 모인다)."""
        self.meeting.say(self.room, "kim", "진행 상황?")
        self.settle(2)
        rows = self.meeting.active()
        self.assertEqual([(r["room"], r["seats"]) for r in rows], [(self.room, ["sa", "scdf-doc"])])
        self.assertEqual(self.meeting.active(now=time.time() + meeting.ACTIVE_FOR + 1), [])

    def _said(self, m, text: str, timeout: float = 10.0) -> dict:
        """m 으로 sa 에게만 말하고 답이 끝날 때까지 기다린 뒤 이 방의 회의 목록 행을 돌려준다."""
        before = len(m.view(self.room)["messages"])
        m.say(self.room, "kim", text, ["sa"])
        end = time.time() + timeout
        while time.time() < end:
            view = m.view(self.room)
            if not view["pending"] and len(view["messages"]) >= before + 2:
                break
            time.sleep(0.05)
        return next(r for r in m.active(now=m._clock()) if r["room"] == self.room)

    def test_9d_회의_시작_시각은_말을_더_해도_그대로이고_쉬었다_다시_말하면_새로_정한다(self):
        """스펙 2026-10-20-017 R1: at 은 마지막 말 시각이라 순서 기준으로 쓰지 못한다. 쉬던 방에 첫 말이 올 때 since 를 정한다."""
        clk = [5000.0]
        m = meeting.Meeting(self.bridge, origin="srv-a", clock=lambda: clk[0])
        with meeting._db() as conn:
            conn.execute("DELETE FROM office_meeting_live WHERE room=?", (self.room,))
        self.assertEqual(self._said(m, "첫 말")["since"], 5000.0)
        clk[0] = 5100.0
        row = self._said(m, "둘째 말")
        self.assertEqual((row["since"], row["at"]), (5000.0, 5100.0))
        clk[0] = 5100.0 + meeting.ACTIVE_FOR + 10
        self.assertEqual(self._said(m, "쉬었다가")["since"], clk[0])

    def test_9e_두_서버가_같은_회의_목록을_본다(self):
        """R4: 회의 목록 상태는 공유 DB 에 있어 다른 서버(같은 DB, 다른 origin)의 active() 에도 같은 since 로 나온다."""
        clk = [7000.0]
        a = meeting.Meeting(self.bridge, origin="srv-a", clock=lambda: clk[0])
        b = meeting.Meeting(None, origin="srv-b", clock=lambda: clk[0])
        with meeting._db() as conn:
            conn.execute("DELETE FROM office_meeting_live WHERE room=?", (self.room,))
        mine = self._said(a, "다른 서버에서도 보이나")
        theirs = next(r for r in b.active(now=clk[0]) if r["room"] == self.room)
        self.assertEqual((theirs["since"], theirs["seats"]), (mine["since"], mine["seats"]))

    def test_9f_죽은_서버가_남긴_답_기다림은_회의를_붙잡지_않는다(self):
        """R4: 답을 기다리는 대화는 그 대화를 연 서버에만 있다. 그 서버 신호가 ALIVE 넘게 끊기면 그 기다림은 믿지 않는다."""
        clk = [9000.0]
        m = meeting.Meeting(None, origin="srv-a", clock=lambda: clk[0])
        old = clk[0] - meeting.ACTIVE_FOR - 100
        with meeting._db() as conn:
            conn.execute("DELETE FROM office_meeting_live WHERE room=?", (self.room,))
            conn.execute("DELETE FROM office_meeting_pending WHERE room=?", (self.room,))
            conn.execute("INSERT INTO office_meeting_live (room, last, since) VALUES (?,?,?)", (self.room, old, old))
            conn.execute("INSERT INTO office_meeting_pending (room, alias, origin, ts) VALUES (?,?,?,?)", (self.room, "sa", "srv-dead", old))
            conn.execute("DELETE FROM office_servers WHERE origin='srv-dead'")
            conn.execute("INSERT INTO office_servers (origin, ts) VALUES ('srv-dead', ?)", (clk[0],))
        try:
            self.assertIn(self.room, [r["room"] for r in m.active(now=clk[0])])      # 살아 있는 서버의 기다림은 회의를 붙잡는다
            with meeting._db() as conn:
                conn.execute("UPDATE office_servers SET ts=? WHERE origin='srv-dead'", (clk[0] - 1000,))
            clk[0] += shared.ALIVE_MEMO + 0.1                     # 살아 있는 서버 목록은 5초 기억한다 — 죽은 서버를 최대 그만큼 늦게 안다(스펙 2026-10-26-002 R6)
            self.assertNotIn(self.room, [r["room"] for r in m.active(now=clk[0])])
            self.assertEqual(m.view(self.room)["pending"], [])
            self.assertEqual(m.view(self.room)["stale"], ["sa"])            # 정리 전까지는 「확인하는 중」으로 보인다(스펙 2026-10-20-030 DR7)
        finally:
            with meeting._db() as conn:
                conn.execute("DELETE FROM office_meeting_pending WHERE room=?", (self.room,))
                conn.execute("DELETE FROM office_servers WHERE origin='srv-dead'")

    def _dead_wait(self, clk: float, thread=None, mid=None) -> None:
        with meeting._db() as conn:
            conn.execute("DELETE FROM office_meeting_pending WHERE room=?", (self.room,))
            conn.execute("INSERT INTO office_meeting_pending (room, alias, origin, ts, thread, mid) VALUES (?,?,?,?,?,?)",
                         (self.room, "sa", "srv-dead", clk - 60, thread, mid))
            conn.execute("DELETE FROM office_servers WHERE origin='srv-dead'")
            conn.execute("INSERT INTO office_servers (origin, ts) VALUES ('srv-dead', ?)", (clk - 1000,))

    def _cleanup_dead(self) -> None:
        with meeting._db() as conn:
            conn.execute("DELETE FROM office_meeting_pending WHERE room=?", (self.room,))
            conn.execute("DELETE FROM office_meeting_lost WHERE room=?", (self.room,))
            conn.execute("DELETE FROM office_servers WHERE origin='srv-dead'")

    def test_9h_죽은_서버의_기다림은_정리하면_답을_받지_못했다는_줄을_한_번_남긴다(self):
        """서버가 다시 시작되면 답을 쓰던 스레드가 사라져 답이 안내 없이 없어졌다(스펙 2026-10-20-030 R8·4-8)."""
        clk = time.time()
        m = meeting.Meeting(None, origin="srv-a", clock=lambda: clk)
        with meeting._db() as conn:
            cur, _ = meeting._thread(conn, self.room)
        mid = meeting._append(self.room, "user", "kim", "답이 사라질 질문")
        self._dead_wait(clk, thread=cur, mid=mid)
        try:
            with self.assertRaises(meeting.MeetingError) as cm:                # 정리 전 새 대화를 열면 줄이 새 차례에 들어간다(RD4)
                m.new_thread(self.room, "kim")
            self.assertEqual(cm.exception.code, 409)
            self.assertEqual(meeting.sweep_lost("srv-a", clock=lambda: clk), 1)
            self.assertEqual(meeting.sweep_lost("srv-a", clock=lambda: clk), 0)   # 두 번 정리해도 한 줄
            view = m.view(self.room)
            lost = [r for r in view["messages"] if r.get("kind") == meeting.LOST_KIND]
            self.assertEqual(len(lost), 1)
            self.assertEqual(lost[0]["data"], {"alias": "sa", "mid": mid})
            self.assertEqual((view["pending"], view["stale"]), ([], []))
        finally:
            self._cleanup_dead()

    def test_9i_차례가_바뀐_옛_기다림은_다시_묻기에_쓸_말을_비운다(self):
        """마이그레이션 전 행(thread 없음)이나 다른 차례의 행은 mid 를 비운다 — 화면은 「다시 묻기」를 숨긴다(4-8 4번)."""
        clk = time.time()
        self._dead_wait(clk, thread=None, mid=None)
        try:
            meeting.sweep_lost("srv-a", clock=lambda: clk)
            lost = [r for r in self.meeting.view(self.room)["messages"] if r.get("kind") == meeting.LOST_KIND]
            self.assertEqual(lost[-1]["data"], {"alias": "sa", "mid": None})
        finally:
            self._cleanup_dead()

    def test_9j_답을_받지_못했다고_정리된_뒤_늦게_온_답은_쓰지_않는다(self):
        """원래 서버가 느리기만 해서 정리된 뒤 답이 오면, 「받지 못함」 줄과 답이 둘 다 남았다(외부 검토 H7)."""
        m = meeting.Meeting(None, origin="srv-slow")
        with meeting._db() as conn:
            conn.execute("INSERT INTO office_meeting_lost (room, alias, origin, ts) VALUES (?,?,?,?)", (self.room, "sa", "srv-slow", time.time()))
        n = len(self.meeting.view(self.room)["messages"])
        try:
            self.assertFalse(m._deliver(self.room, "sa", [("assistant", "늦은 답", "", None)], last=True))
            self.assertEqual(len(self.meeting.view(self.room)["messages"]), n)
            self.assertTrue(m._deliver(self.room, "sa", [("assistant", "다음 답", "", None)], last=True))   # 표시는 한 번만 쓴다
            self.assertEqual(self.meeting.view(self.room)["messages"][-1]["content"], "다음 답")
        finally:
            self._cleanup_dead()

    def test_9l_서버_정리는_회의_기다림을_안내_없이_지우지_않는다(self):
        """shared.cleanup 이 300초 넘게 죽은 서버의 기다림을 지워 「확인하는 중」이 안내 없이 사라졌다(외부 검토, 4-8 4-1)."""
        from aas.office import shared
        clk = time.time()
        self._dead_wait(clk)
        with meeting._db() as conn:
            conn.execute("UPDATE office_servers SET ts=? WHERE origin='srv-dead'", (clk - 10000,))
        try:
            shared.Shared(origin="srv-a", clock=lambda: clk).cleanup()
            with meeting._db() as conn:
                self.assertIsNotNone(conn.execute("SELECT 1 FROM office_meeting_pending WHERE room=? AND origin='srv-dead'", (self.room,)).fetchone())
            self.assertEqual(meeting.sweep_lost("srv-a", clock=lambda: clk), 1)
        finally:
            self._cleanup_dead()

    def test_9k_답_기록과_기다림은_말을_받을_때의_차례와_말_번호를_담는다(self):
        out = self.meeting.say(self.room, "kim", "차례 확인", ["sa"])
        with meeting._db() as conn:
            row = conn.execute("SELECT thread, mid FROM office_meeting_pending WHERE room=? AND alias='sa'", (self.room,)).fetchone()
        self.settle(0)
        if row is not None:                                     # 답이 아주 빠르면 이미 지워졌다 — 그때는 확인할 것이 없다
            self.assertEqual(int(row["mid"]), out["message"])

    def test_9c_에이전트에게_보내는_글에는_이메일_대신_이름을_쓴다(self):
        """OMAI-1120: LiteLLM 가드레일이 이메일을 개인정보로 보고 회의 질문을 막았다. 방 기록에는 이메일을 그대로 둔다."""
        office.person_touch("lee@x.com", "이영희")
        room = office.set_room({"name": "개인정보 방", "seats": ["sa", "scdf-doc"], "people": ["lee@x.com", "park@x.com"]}, "me")["id"]
        self.meeting.say(room, "lee@x.com", "모두 자기 소개해주세요", ["sa"])
        self.settle_room(room, 2)
        self.meeting.say(room, "park@x.com", "문서 담당도 소개해 주세요", ["scdf-doc"])
        self.settle_room(room, 4)
        self.meeting.summary(room, "lee@x.com")
        sent = [self.ws["yj"].prompts()[-2], self.ws["scdf"].prompts()[-1], self.ws["yj"].prompts()[-1]]   # 회의 말 둘, 요약 하나
        for text in sent:
            self.assertNotIn("@", text)
        self.assertIn("사람: 이영희, park", sent[0])                                  # 방의 지시: 이름을 모르면 이메일 앞부분
        self.assertTrue(sent[0].endswith("[말한 사람] 이영희\n[이번 말]\n모두 자기 소개해주세요"))
        self.assertIn("이영희: 모두 자기 소개해주세요", sent[1])                       # 그동안 방에서 오간 말
        self.assertTrue(sent[1].endswith("[말한 사람] park\n[이번 말]\n문서 담당도 소개해 주세요"))
        self.assertIn("이영희: 모두 자기 소개해주세요", sent[2])                       # 회의록 요약
        authors = [m["author"] for m in self.meeting.view(room)["messages"] if m["role"] == "user"]
        self.assertEqual(authors, ["lee@x.com", "park@x.com"])

    def settle_room(self, room: int, want: int, timeout: float = 10.0) -> None:
        end = time.time() + timeout
        while time.time() < end:
            view = self.meeting.view(room)
            if not view["pending"] and len(view["messages"]) >= want:
                return
            time.sleep(0.05)
        self.fail(f"방 {room} 의 기록이 {want}개가 되지 않았습니다")

    def test_9b_회의록_요약은_따로_만든_세션으로_묻고_방_기록에_넣지_않는다(self):
        """독립 검토 M5: 회의 세션을 쓰면 Busy 와 부딪히고, 요약이 기록에 들어가 다음 차례에 모두에게 다시 간다."""
        before = len(self.meeting.view(self.room)["messages"])
        out = self.meeting.summary(self.room, "kim")
        self.assertTrue(out)
        self.assertEqual(len(self.meeting.view(self.room)["messages"]), before)
        titles = {r["title"] for r in office.session_rows("sa")}
        self.assertIn(f"meeting-{self.room}-summary", titles)
        self.assertIn("회의 기록", self.ws["yj"].prompts()[-1])

    def test_9g_기다림이_비어_보이면_답_스레드가_쓴_행도_모두_보인다(self):
        """답 스레드는 칩 행에 방 자료 id 를 채운(UPDATE) 뒤 기다림을 지운다. view 가 행을 먼저 읽고 기다림을 나중에 읽으면
        그 사이에 스레드가 끝날 때 「기다림 없음 + room 없는 칩 행」이 돌아간다(CI 에서 가끔 실패했다)."""
        mid = meeting._append(self.room, "system", "sa", "", meeting.CHIP_NOTE, {"pod": "yj", "files": [{"name": "a.txt"}]})
        with meeting._db() as conn:
            conn.execute("INSERT INTO office_meeting_pending (room, alias, origin, ts) VALUES (?, ?, ?, ?)", (self.room, "sa", self.meeting.origin, time.time()))
        original = self.meeting._pending_of

        def finish_then_read(conn, room_id=None):                 # 행을 읽은 뒤·기다림을 읽기 전에 답 스레드가 끝난 것과 같다
            conn.execute("UPDATE office_messages SET data=? WHERE id=?", ('{"pod": "yj", "files": [{"name": "a.txt", "room": "f1"}]}', mid))
            conn.execute("DELETE FROM office_meeting_pending WHERE room=?", (self.room,))
            return original(conn, room_id)

        self.meeting._pending_of = finish_then_read
        try:
            view = self.meeting.view(self.room)
        finally:
            del self.meeting._pending_of
        self.assertEqual(view["pending"], [])
        chip = next(m for m in view["messages"] if m["id"] == mid)
        self.assertEqual(chip["data"]["files"][0].get("room"), "f1")


class FakeShared:
    """설치본의 작업 폴더 대역(Workspace) — 사이드카 check 로 표지 파일·올린 파일이 보이는지, snapshot 으로 만든 파일을 돌려준다."""

    def __init__(self, marker=True):
        self.marker, self.files, self.misses, self.snaps, self.checks = marker, set(), {}, [], []

    def supported(self):
        return True

    def check(self, path):
        self.checks.append(path)
        if path == f"{wsp.UPLOADS}/aas-shared/{wsp.SHARED_MARKER}":
            return {"exists": True, "type": "file"} if self.marker else {"exists": False}
        if self.misses.get(path, 0) > 0:                       # NFS 캐시: 몇 번은 안 보이다가 보인다
            self.misses[path] -= 1
            return {"exists": False}
        return {"exists": True, "type": "file"} if path in self.files else {"exists": False}

    def snapshot(self):
        return self.snaps.pop(0) if self.snaps else {}

    @property
    def backend(self):
        return self

    def open_download(self, rel):
        """결과 파일 내려받기 대역: 내용은 경로 글자. 자동 올리기(meeting_files.publish)가 쓴다."""
        body = rel.encode()
        resp = io.BytesIO(body)
        resp.getheader = lambda k, d=None: str(len(body)) if k == "Content-Length" else d
        return 200, "", resp, resp


class SpyHub(ChatHub):
    """hub.send 로 간 인자를 기록한다(relay.start 가 파일이 없으면 옛 호출 그대로인지 본다)."""
    spy: list = []

    def send(self, sid, text, **kw):
        SpyHub.spy.append(dict(kw, text=text))
        return super().send(sid, text, **kw)


class MeetingFilesTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.ws = {"yj": FakeWS("yj"), "scdf": FakeWS("scdf")}
        cls.shared = {"yj": FakeShared(), "scdf": FakeShared()}
        cls.bridge = relay.Bridge(FakeRegistry(), lambda pod: SpyHub(SETTINGS, connect=lambda: cls.ws[pod.id]))
        cls.meeting = meeting.Meeting(cls.bridge, workspace_for=lambda pod: cls.shared.get(pod))
        cls.meeting.visible_wait, cls.meeting.visible_step = 0.4, 0.05
        cls.old_env = {k: os.environ.get(k) for k in ("AAS_MEETING_SHARED_IN", "AAS_MEETING_SHARED_OUT")}
        cls.dirs = tempfile.TemporaryDirectory()
        cls.shared_in, cls.shared_out = Path(cls.dirs.name) / "in", Path(cls.dirs.name) / "out"
        cls.shared_in.mkdir()
        cls.shared_out.mkdir()
        os.environ["AAS_MEETING_SHARED_IN"], os.environ["AAS_MEETING_SHARED_OUT"] = str(cls.shared_in), str(cls.shared_out)
        with office.connect() as conn:
            for t in ("office_seats", "office_rooms", "office_sessions"):
                conn.execute(f"DELETE FROM {t}")
        with meeting._db() as conn:
            conn.execute("DELETE FROM office_messages")
        with meeting_files._db() as conn:
            conn.execute("DELETE FROM office_files")
        office.set_seat({"pod": "yj", "profile": "sa", "title": "영업"}, "me", KNOWN)
        office.set_seat({"pod": "scdf", "profile": "scdf-doc"}, "me", KNOWN)
        cls.bridge.routes(0)

    @classmethod
    def tearDownClass(cls):
        for w in cls.ws.values():
            w.inbox.put(None)
        for k, v in cls.old_env.items():
            os.environ.pop(k, None)
            if v is not None:
                os.environ[k] = v
        with meeting_files._db() as conn:
            conn.execute("DELETE FROM office_files")
        cls.dirs.cleanup()

    def setUp(self):
        self.shared.update(yj=FakeShared(), scdf=FakeShared())
        self.meeting._support.clear()
        SpyHub.spy.clear()
        self.room = office.set_room({"name": f"파일 방 {time.time_ns()}", "purpose": "자료 공유", "seats": ["sa", "scdf-doc"], "people": ["kim"]}, "me")["id"]

    def upload(self, name="표.csv", data=b"a,b", visible=("yj", "scdf"), room=None):
        up = meeting_files.begin(room or self.room, name, len(data), "kim")
        up.write(data)
        out = up.finish()
        for pod in visible:
            self.shared[pod].files.add(meeting_files.pod_path(room or self.room, {"date": out["date"], "id": out["id"], "name": out["name"]}))
        return out

    def settle(self, want: int, room=None, timeout: float = 10.0) -> dict:
        end, view = time.time() + timeout, {}
        while time.time() < end:
            view = self.meeting.view(room or self.room)
            if not view["pending"] and len(view["messages"]) >= want:
                return view
            time.sleep(0.05)
        self.fail(f"회의 기록이 {want}개가 되지 않았습니다: {view}")

    def test_files_go_to_every_receiver_as_a_notice_and_stay_out_of_the_room_record(self):
        f = self.upload("표.csv")
        out = self.meeting.say(self.room, "kim", "이 표 봐 줘", None, [f["id"]])
        self.assertEqual((sorted(out["targets"]), out["skipped"]), (["sa", "scdf-doc"], []))
        view = self.settle(3)
        path = f"workspace/uploads/aas-shared/{self.room}/{f['date']}/{f['id']}-표.csv"
        for pod in ("yj", "scdf"):
            sent = self.ws[pod].prompts()[-1]
            self.assertIn("[말한 사람] kim\n[이번 말]\n이 표 봐 줘", sent)
            self.assertIn(attach_notice.line("표.csv", 3, path), sent)                       # 안내 줄: 경로는 파드 안의 공유 폴더
            self.assertIn(attach_notice.MEETING_NOTE, sent)
        first = view["messages"][0]
        self.assertEqual((first["role"], first["kind"], first["content"]), ("user", "attach", "이 표 봐 줘"))
        self.assertEqual(first["data"], {"files": [{"id": f["id"], "name": "표.csv", "size": 3}], "undelivered": []})
        for m in view["messages"]:                                                          # 방 기록에는 안내가 들어가지 않는다
            self.assertNotIn("[사용자가 파일을", m["content"])
            self.assertNotIn("/opt/data", m["content"])
        with meeting_files._db() as conn:
            self.assertEqual(conn.execute("SELECT msg FROM office_files WHERE id=?", (f["id"],)).fetchone()[0], first["id"])
        self.assertTrue(all(kw.get("files") and kw.get("note") for kw in SpyHub.spy))        # relay.start(files=) → hub.send(files=)
        self.assertEqual(SpyHub.spy[0]["files"], [{"name": "표.csv", "size": 3, "path": path}])

    def test_a_turn_without_files_calls_hub_send_exactly_as_before(self):
        self.meeting.say(self.room, "kim", "그냥 말")
        self.settle(3)
        self.assertEqual(len(SpyHub.spy), 2)
        for kw in SpyHub.spy:
            self.assertNotIn("files", kw)
            self.assertNotIn("note", kw)
        self.assertNotIn("[사용자가 파일을", self.ws["yj"].prompts()[-1])

    def test_meeting_turn_shows_only_the_speaker_and_message_in_the_agent_chat(self):
        """스펙 2026-10-20-022: 에이전트 대화 창의 말풍선·제목에는 방 지시·방 기록 없이 「이름: 말」만 간다."""
        self.meeting.say(self.room, "kim", "그냥 말")
        self.settle(3)
        self.assertTrue(SpyHub.spy and all(kw.get("display") == "kim: 그냥 말" for kw in SpyHub.spy))
        sent = self.ws["yj"].prompts()[-1]
        self.assertTrue(sent.startswith("[이 대화에서 지킬 것]"))                          # 에이전트는 지금처럼 맥락을 받는다
        self.assertTrue(sent.endswith("\n\n[말한 사람] kim\n[이번 말]\n그냥 말"))

    def test_room_rules_and_the_message_are_separated_by_the_turn_mark_for_the_guardrail(self):
        """OMAI-1389: 방 지시 바로 뒤에 「이름: 말」을 구분 줄 없이 붙인 글을 OKE 가드레일 AI 필터가 jailbreak 로 막았다.
        회의 글은 언제나 회의 머리로 시작하고 [이번 말] 줄 다음에 말이 온다. 붙일 방 기록이 없으면 빈 방 기록 머리를 붙인다(2026-10-21)."""
        self.meeting.say(self.room, "kim", "첫 말")
        self.settle(3)
        self.meeting.say(self.room, "kim", "둘째 말")
        self.settle(6)
        first, second = self.ws["yj"].prompts()[-2:]
        self.assertTrue(first.startswith("[이 대화에서 지킬 것]"))
        for sent, said in ((first, "첫 말"), (second, "둘째 말")):
            self.assertTrue(sent.startswith(("[이 대화에서 지킬 것]", "[그동안 방에서 오간 말]")), sent)
            self.assertTrue(sent.endswith("\n\n[말한 사람] kim\n[이번 말]\n" + said), sent)  # 지시·기록 바로 뒤에 말을 붙이지 않는다

    def test_the_guardrail_checks_only_what_the_person_typed(self):
        """OKE 2026-10-21: 「김영주: 왜 김영주 에이전트가 생겼는지 확인하고 다른 이름으로 변경해」를 AI 필터가 Cyber Crime 으로 막았다.
        이름 머리(「김영주: 」)를 빼면 통과했다. 훅은 [이번 말] 줄 뒤만 검사하므로 이름은 그 줄 앞에 두고, 회의 글은 언제나 회의 머리로 시작한다."""
        def checked(sent: str) -> str:                     # openmaru-cogentai aas_guardrail_hook.question_of 5단계와 같은 규칙
            q = sent.strip()
            if q.startswith(("[이 대화에서 지킬 것]", "[그동안 방에서 오간 말]")):
                at = q.find("\n[이번 말]\n")
                if at >= 0:
                    q = q[at + len("\n[이번 말]\n"):].strip()
            return q
        self.meeting.say(self.room, "kim", "첫 말")
        self.settle(3)
        self.meeting.say(self.room, "kim", "둘째 말", ["sa"])  # sa 만 받는다 — 앞 답 뒤로 방에 새 말이 없어 방 기록이 붙지 않을 수 있다
        self.settle(5)
        first, second = self.ws["yj"].prompts()[-2:]
        for sent, text in ((first, "첫 말"), (second, "둘째 말")):
            self.assertEqual(checked(sent), text, sent)
            self.assertIn("[말한 사람] kim\n[이번 말]\n", sent)

    def test_files_only_message_uses_the_default_text(self):
        f = self.upload()
        self.meeting.say(self.room, "kim", "   ", None, [f["id"]])
        view = self.settle(3)
        self.assertEqual(view["messages"][0]["content"], attach_notice.EMPTY_TEXT)
        with self.assertRaises(meeting.MeetingError) as cm:
            self.meeting.say(self.room, "kim", "  ")                                          # 글도 파일도 없으면 거절
        self.assertEqual(cm.exception.code, 400)

    def test_other_agents_see_the_file_name_in_history_but_not_the_path(self):
        f = self.upload("계약서.pdf")
        self.meeting.say(self.room, "kim", "영업만 봐", ["sa"], [f["id"]])
        self.settle(2)
        self.meeting.say(self.room, "kim", "이제 문서도", ["scdf-doc"])
        self.settle(4)
        sent = self.ws["scdf"].prompts()[-1]
        self.assertIn("kim: 영업만 봐 [첨부: 계약서.pdf]", sent)
        self.assertNotIn(f["id"], sent)                                                       # 안내 줄(경로)은 받는 에이전트에게만 간다
        self.assertNotIn("[사용자가 파일을", sent)
        self.assertNotIn(attach_notice.MEETING_NOTE, sent)

    def test_agent_without_the_marker_skips_the_message_and_its_history_too(self):
        self.shared["scdf"].marker = False                                                    # 볼륨이 안 붙은 설치본
        f = self.upload(visible=("yj",))
        out = self.meeting.say(self.room, "kim", "파일 있어요", None, [f["id"]])
        self.assertEqual((out["targets"], out["skipped"]), (["sa"], [{"alias": "scdf-doc", "reason": "unsupported"}]))
        before = len(self.ws["scdf"].prompts())
        view = self.settle(3)
        self.assertEqual(len(self.ws["scdf"].prompts()), before)
        self.assertEqual(view["messages"][0]["data"]["undelivered"], ["scdf-doc"])
        self.assertIn(("system", "scdf-doc", "scdf-doc 는 파일을 받을 수 없어 이 말을 받지 않았습니다"),
                      [(m["role"], m["author"], m["content"]) for m in view["messages"]])
        # 다음 말(파일 없음)을 scdf-doc 이 받아도 파일이 붙은 말은 기록에서 빠진다(OV2)
        self.meeting.say(self.room, "kim", "다 같이 의견", None)
        self.settle(6)
        sent = self.ws["scdf"].prompts()[-1]
        self.assertNotIn("파일 있어요", sent)
        self.assertTrue(sent.endswith("[말한 사람] kim\n[이번 말]\n다 같이 의견"))
        self.assertIn("[말한 사람] kim\n[이번 말]\n파일 있어요", [p for p in self.ws["yj"].prompts() if "파일 있어요" in p][0])         # 받은 에이전트의 대화에는 그 말이 있다

    def test_unsupported_pod_without_a_workspace_is_also_skipped(self):
        self.shared.pop("scdf")                                                               # workspace_for → None (로컬 폴더 설치본)
        try:
            f = self.upload(visible=("yj",))
            out = self.meeting.say(self.room, "kim", "x", None, [f["id"]])
        finally:
            self.shared["scdf"] = FakeShared()
        self.assertEqual(out["targets"], ["sa"])
        self.settle(3)

    def test_no_receiver_is_refused_and_nothing_is_saved(self):
        for fake in self.shared.values():
            fake.marker = False
        f = self.upload(visible=())
        with self.assertRaises(meeting.MeetingError) as cm:
            self.meeting.say(self.room, "kim", "x", None, [f["id"]])
        self.assertEqual((cm.exception.code, cm.exception.reason), (409, "no_receiver"))
        self.assertEqual(self.meeting.view(self.room)["messages"], [])
        with meeting_files._db() as conn:
            self.assertIsNone(conn.execute("SELECT msg FROM office_files WHERE id=?", (f["id"],)).fetchone()[0])   # 파일은 연결되지 않은 채 남는다

    def test_marker_decision_is_cached_for_a_while(self):
        self.meeting.supports_files("yj")
        self.meeting.supports_files("yj")
        self.assertEqual(sum(p.endswith(wsp.SHARED_MARKER) for p in self.shared["yj"].checks), 1)

    def test_file_not_visible_within_the_wait_is_skipped_with_a_system_row(self):
        f = self.upload(visible=("scdf",))                                                    # yj 의 사이드카에는 안 보인다
        yj_before, scdf_before = len(self.ws["yj"].prompts()), len(self.ws["scdf"].prompts())
        self.meeting.say(self.room, "kim", "봐 줘", None, [f["id"]])
        view = self.settle(3)
        self.assertEqual(len(self.ws["yj"].prompts()), yj_before)
        self.assertEqual(len(self.ws["scdf"].prompts()), scdf_before + 1)
        self.assertEqual(view["messages"][0]["data"]["undelivered"], ["sa"])
        self.assertTrue(any(m["role"] == "system" and "sa 는 파일이 보이지 않아" in m["content"] for m in view["messages"]))
        waited = [p for p in self.shared["yj"].checks if p.endswith("-표.csv")]
        self.assertGreater(len(waited), 2)                                                    # 1초 간격(시험에서는 줄임)으로 여러 번 확인했다

    def test_file_that_appears_late_is_delivered(self):
        f = self.upload(visible=("yj", "scdf"))
        path = meeting_files.pod_path(self.room, {"date": f["date"], "id": f["id"], "name": f["name"]})
        self.shared["yj"].misses[path] = 3
        before = len(self.ws["yj"].prompts())
        self.meeting.say(self.room, "kim", "늦게 보여도", None, [f["id"]])
        self.settle(3)
        self.assertEqual(len(self.ws["yj"].prompts()), before + 1)

    def test_bad_files_are_refused(self):
        other_room = office.set_room({"name": f"다른 방 {time.time_ns()}", "seats": ["sa"]}, "me")["id"]
        foreign, mine = self.upload(room=other_room), self.upload()
        for files in ([foreign["id"]], ["nope"], [mine["id"]] * 1 + [""], "x", [1], [f"{i:012d}" for i in range(11)]):
            with self.assertRaises(meeting.MeetingError, msg=files) as cm:
                self.meeting.say(self.room, "kim", "x", None, files)
            self.assertEqual((cm.exception.code, cm.exception.reason), (400, "bad_file"))
        self.meeting.say(self.room, "kim", "첫 말", None, [mine["id"]])
        with self.assertRaises(meeting.MeetingError) as cm:                                   # 이미 다른 말에 연결됨
            self.meeting.say(self.room, "kim", "또 붙이기", None, [mine["id"]])
        self.assertEqual(cm.exception.reason, "bad_file")
        self.settle(3)

    def test_files_are_refused_when_the_feature_is_off(self):
        f = self.upload()
        os.environ.pop("AAS_MEETING_SHARED_IN")
        try:
            with self.assertRaises(meeting.MeetingError) as cm:
                self.meeting.say(self.room, "kim", "x", None, [f["id"]])
            self.assertEqual((cm.exception.code, cm.exception.reason), (400, "not_configured"))
            self.assertEqual(self.meeting.view(self.room)["files"]["enabled"], False)
        finally:
            os.environ["AAS_MEETING_SHARED_IN"] = str(self.shared_in)
        self.assertEqual(self.meeting.view(self.room)["files"]["enabled"], True)

    def test_system_prompt_names_the_shared_folders_only_when_files_are_on(self):
        room = {"id": 7, "name": "방", "purpose": "목적", "seats": ["sa"], "people": []}
        text = meeting.Meeting._system(room, "sa", {}, auto_upload=True)
        # 스펙 2026-10-20-026 F1: 읽기 전용·복사 금지·방 결과 폴더·중간 파일·다른 에이전트 안내(절대 경로)
        for part in ("## 파일 위치", "- 방에 올라온 파일: `/opt/data/workspace/uploads/aas-shared/7/` (읽기 전용, 그 자리에서 읽는다)",
                     "- 결과 파일 저장 위치: `/opt/data/workspace/rooms/7/` (방 자료에 자동으로 올라간다)",
                     "- 중간 파일·스크립트: `/opt/data/workspace/tmp/` (방에 올라가지 않는다)",
                     "- 다른 에이전트가 만든 파일: 방 자료에 올라간 것은 `aas-shared/7/` 에서 읽고, 그 밖의 파일은 만든 에이전트에게 요청한다"):
            self.assertIn(part, text)
        self.assertNotIn("aas-shared-out", text)
        self.assertNotIn("/opt/data/cache", text)                                            # Hermes 내부 폴더는 안내하지 않는다(§7-7 결정)
        # 칩·자동 올리기를 못 하는 에이전트에는 「자동으로 올라갑니다」를 약속하지 않는다(외부 M1)
        self.assertNotIn("자동으로 올라간다", meeting.Meeting._system(room, "sa", {}, auto_upload=False))
        os.environ.pop("AAS_MEETING_SHARED_IN")
        try:
            self.assertNotIn("aas-shared", meeting.Meeting._system(room, "sa", {}))
        finally:
            os.environ["AAS_MEETING_SHARED_IN"] = str(self.shared_in)

    def test_system_prompt_puts_the_structured_purpose_as_its_own_section(self):
        """2026-10-18: 목적이 항목별 Markdown 이 되어, 한 문장 안에 끼우지 않고 안내문 끝에 「## 이 방의 목적」 절로 붙인다."""
        brief = "### 목표\n제안서 초안 확정\n\n### 기한\n10월 25일"
        text = meeting.Meeting._system({"id": 7, "name": "방", "purpose": brief, "seats": ["sa"], "people": []}, "sa", {})
        self.assertTrue(text.endswith("\n\n## 이 방의 목적\n" + brief), text)
        self.assertNotIn("목적: ###", text)
        empty = meeting.Meeting._system({"id": 7, "name": "방", "purpose": "", "seats": ["sa"], "people": []}, "sa", {})
        self.assertIn("목적: (적지 않음).", empty)
        self.assertNotIn("## 이 방의 목적", empty)

    def test_room_purpose_keeps_up_to_4000_characters(self):
        rid = office.set_room({"name": "긴 목적", "purpose": "가" * 5000}, "me@x.com")["id"]
        self.assertEqual(len(next(r for r in office.rooms() if r["id"] == rid)["purpose"]), 4000)
        office.delete_room(rid)
        rid = office.set_room({"name": "여러 줄", "purpose": "### 목표  \r\n확정\n\n\n\n### 기한\n금요일 "}, "me@x.com")["id"]
        self.assertEqual(next(r for r in office.rooms() if r["id"] == rid)["purpose"], "### 목표\n확정\n\n### 기한\n금요일")  # 줄바꿈을 지킨다
        office.delete_room(rid)

    def test_result_files_become_a_chip_row_after_the_answer(self):
        d = f"workspace/rooms/{self.room}"                                                     # 결과는 방 폴더 아래만 올린다(스펙 2026-10-20-026 R1b)
        self.shared["yj"].snaps = [{"workspace/old.txt": (1, 1.0, 1)},
                                   {"workspace/old.txt": (1, 1.0, 1), f"{d}/report.docx": (48, 2.0, 1), f"{d}/hard.bin": (5, 2.0, 2),
                                    "workspace/script.py": (9, 2.0, 1), "workspace/rooms/999999/other.txt": (3, 2.0, 1)}]
        self.meeting.say(self.room, "kim", "보고서 만들어", ["sa"])
        view = self.settle(3)
        user, answer, chips = view["messages"]
        self.assertEqual((answer["role"], answer["author"]), ("assistant", "sa"))
        self.assertEqual((chips["role"], chips["kind"], chips["author"], chips["content"]), ("system", "files", "sa", ""))
        (put,) = meeting_files.listing(self.room)["files"]                                    # 결과 파일은 방 자료에도 자동으로 올라간다
        self.assertEqual((put["name"], put["uploader"], put["msg"]), ("report.docx", "sa", chips["id"]))
        self.assertEqual(chips["data"], {"pod": "yj", "files": [{"path": f"{d}/report.docx", "name": "report.docx", "size": 48, "room": put["id"]}]})   # 하드링크는 받을 수 없어 뺀다. 방 폴더 밖·다른 방 폴더 파일도 뺀다
        # 칩 행은 다른 에이전트의 기록에 섞이지 않는다
        self.meeting.say(self.room, "kim", "문서 담당", ["scdf-doc"])
        self.settle(5)
        self.assertNotIn("report.docx", self.ws["scdf"].prompts()[-1])

    def test_no_chip_row_when_the_listing_fails_or_nothing_changed(self):
        self.shared["yj"].snapshot = lambda: None                                             # 사이드카가 목록을 못 뜬다
        self.meeting.say(self.room, "kim", "만들어", ["sa"])
        view = self.settle(2)
        self.assertEqual([m["role"] for m in view["messages"]], ["user", "assistant"])
        self.shared["yj"].snapshot = lambda: {"workspace/a.txt": (1, 1.0, 1)}                  # 앞뒤가 같다
        self.meeting.say(self.room, "kim", "또", ["sa"])
        view = self.settle(4)
        self.assertEqual([m["role"] for m in view["messages"]], ["user", "assistant", "user", "assistant"])

    def test_result_chips_are_capped_at_twenty(self):
        many = {f"workspace/rooms/{self.room}/f{i}.txt": (i + 1, 2.0, 1) for i in range(30)}
        self.shared["yj"].snaps = [{}, many]
        self.meeting.say(self.room, "kim", "많이", ["sa"])
        chips = self.settle(3)["messages"][-1]
        self.assertEqual((chips["kind"], len(chips["data"]["files"])), ("files", 20))

    def test_no_snapshots_when_the_feature_is_off(self):
        os.environ.pop("AAS_MEETING_SHARED_IN")
        self.shared["yj"].snaps = [{}, {"workspace/x.txt": (1, 1.0, 1)}]
        try:
            self.meeting.say(self.room, "kim", "기능 꺼짐", ["sa"])
            view = self.settle(2)
        finally:
            os.environ["AAS_MEETING_SHARED_IN"] = str(self.shared_in)
        self.assertEqual([m["role"] for m in view["messages"]], ["user", "assistant"])
        self.assertEqual(len(self.shared["yj"].snaps), 2)


if __name__ == "__main__":
    unittest.main()

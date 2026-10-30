# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""회의 「새 대화」·「지난 대화」 시험(스펙 2026-10-20-027). 방 안의 대화 차례가 에이전트 세션과 방 기록을 나누는지 본다."""
import json
import os
import re
import tempfile
import time
import unittest
from pathlib import Path

TMP = tempfile.TemporaryDirectory()
os.environ.setdefault("AAS_DATA_DIR", str(Path(TMP.name) / "data"))

from aas.common import dbmigrate  # noqa: E402
from aas.office import meeting, office, relay  # noqa: E402
from aas.hermes.hermes_chat import ChatHub  # noqa: E402

try:
    from tests.test_office import KNOWN, SETTINGS, FakeRegistry, FakeWS  # noqa: E402
except ImportError:                                            # unittest discover -s tests 로 돌릴 때
    from test_office import KNOWN, SETTINGS, FakeRegistry, FakeWS  # noqa: E402


class ThreadTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.ws = {"yj": FakeWS("yj"), "scdf": FakeWS("scdf")}
        cls.bridge = relay.Bridge(FakeRegistry(), lambda pod: ChatHub(SETTINGS, connect=lambda: cls.ws[pod.id]))
        cls.meeting = meeting.Meeting(cls.bridge)
        office.set_seat({"pod": "yj", "profile": "sa", "title": "영업"}, "me", KNOWN)
        office.set_seat({"pod": "scdf", "profile": "scdf-doc"}, "me", KNOWN)
        cls.rooms: list[int] = []
        cls.bridge.routes(0)

    @classmethod
    def tearDownClass(cls):
        for w in cls.ws.values():
            w.inbox.put(None)
        with meeting._db() as conn:                            # 공유 데이터 폴더 — 다른 시험이 같은 방 번호·별칭을 쓴다
            for rid in cls.rooms:
                for t in ("office_messages", "office_meeting_threads", "office_meeting_live", "office_meeting_pending"):
                    conn.execute(f"DELETE FROM {t} WHERE room=?", (rid,))
        for rid in cls.rooms:
            office.delete_room(rid)
        with office.connect() as conn:
            conn.execute("DELETE FROM office_sessions WHERE title LIKE 'meeting-%'")

    def new_room(self, **kw) -> int:
        rid = office.set_room({"name": f"차례 방 {len(self.rooms)}", "seats": ["sa", "scdf-doc"], "people": ["kim"], **kw}, "me")["id"]
        self.rooms.append(rid)
        return rid

    def settle(self, rid: int, want: int, timeout: float = 10.0) -> dict:
        end, view = time.time() + timeout, {}
        while time.time() < end:
            view = self.meeting.view(rid)
            if not view["pending"] and len(view["messages"]) >= want:
                return view
            time.sleep(0.05)
        self.fail(f"기록이 {want}개가 되지 않았습니다: {view}")

    def titles(self, alias: str) -> set[str]:
        return {r["title"] for r in office.session_rows(alias)}

    # ---- R6: 차례 표가 빈 옛 방은 지금과 같다 -----------------------------------
    def test_1_새_대화를_누르기_전의_방은_지금과_같다(self):
        rid = self.new_room()
        self.meeting.say(rid, "kim", "첫 말")
        view = self.settle(rid, 3)
        self.assertEqual(view["thread"], 0)
        self.assertIn(f"meeting-{rid}", self.titles("sa"))
        self.assertFalse(any(re.fullmatch(rf"meeting-{rid}-t\d+", t) for t in self.titles("sa")))
        self.meeting.say(rid, "kim", "둘째 말", ["scdf-doc"])
        self.settle(rid, 5)
        self.assertEqual(len(self.meeting.view(rid)["messages"]), 5)                   # 차례 0 = 모든 행
        self.assertEqual(self.meeting.threads(rid)["threads"][0]["id"], 0)
        self.meeting.summary(rid, "kim")
        self.assertIn(f"meeting-{rid}-summary", self.titles("sa"))

    # ---- 새 대화 ---------------------------------------------------------------
    def test_2_새_대화는_기록을_나누고_에이전트에게_새_세션으로_간다(self):
        rid = self.new_room()
        self.meeting.say(rid, "kim", "앞 대화의 비밀 이야기")
        self.settle(rid, 3)
        out = self.meeting.new_thread(rid, "kim@x.com")
        tid = out["thread"]
        self.assertGreater(tid, 0)
        view = self.meeting.view(rid)
        self.assertEqual(view["thread"], tid)
        self.assertEqual([(m["role"], m.get("kind")) for m in view["messages"]], [("system", meeting.THREAD_KIND)])
        self.assertEqual(view["messages"][0]["data"]["by"], "kim@x.com")
        self.assertEqual(view["messages"][0]["data"]["prev"], 0)
        self.assertTrue(view["messages"][0]["data"]["prev_ok"])                       # 앞 차례에 말이 있다 → 「지난 대화 보기」
        t2 = self.meeting.new_thread(rid, "kim")["thread"]
        self.assertFalse(self.meeting.view(rid)["messages"][0]["data"]["prev_ok"])     # 말 없이 끝난 차례는 링크가 없다
        with meeting._db() as conn:                                                    # 시험의 나머지는 t2 를 지금 차례로 쓴다
            conn.execute("DELETE FROM office_messages WHERE room=? AND kind=? AND id>(SELECT after_id FROM office_meeting_threads WHERE id=?)", (rid, meeting.THREAD_KIND, t2))
            conn.execute("DELETE FROM office_meeting_threads WHERE id=?", (t2,))
        self.assertIn("kim@x.com", view["labels"])                                    # 시작한 사람의 이름(DR3)
        before = len(self.ws["yj"].prompts())
        self.meeting.say(rid, "kim", "새 일")
        self.settle(rid, 4)
        sent = self.ws["yj"].prompts()[before]
        self.assertNotIn("앞 대화의 비밀 이야기", sent)                               # 앞 차례의 말은 가지 않는다
        self.assertIn(relay.ROOM_RULES, sent)                                         # 새 세션이라 방 지시를 다시 보낸다
        self.assertIn(f"meeting-{rid}-t{tid}", self.titles("sa"))
        self.meeting.summary(rid, "kim")
        self.assertIn(f"meeting-{rid}-t{tid}-summary", self.titles("sa"))             # 요약 세션도 차례마다(R9)
        self.assertNotIn("앞 대화의 비밀 이야기", self.ws["yj"].prompts()[-1])

    def test_3_답하는_중이거나_끝난_방이면_새_대화를_막는다(self):
        rid = self.new_room()
        with meeting._db() as conn:
            conn.execute("INSERT INTO office_meeting_pending (room, alias, origin, ts) VALUES (?,?,?,?)", (rid, "sa", self.meeting.origin, time.time()))
        with self.assertRaises(meeting.MeetingError) as cm:
            self.meeting.new_thread(rid, "kim")
        self.assertEqual((cm.exception.code, cm.exception.reason), (409, "busy"))
        with meeting._db() as conn:                            # 답 시간 한도를 넘긴 기다림은 막지 않는다(R8)
            conn.execute("UPDATE office_meeting_pending SET ts=? WHERE room=?", (time.time() - relay.TURN_LIMIT - 5, rid))
        self.assertEqual(self.meeting.view(rid)["pending"], [])
        self.assertGreater(self.meeting.new_thread(rid, "kim")["thread"], 0)
        closed = self.new_room(status="closed")
        with self.assertRaises(meeting.MeetingError) as cm:
            self.meeting.new_thread(closed, "kim")
        self.assertEqual((cm.exception.code, cm.exception.reason), (409, "closed"))

    def test_4_지난_차례를_읽고_다른_방의_차례는_404(self):
        rid, other = self.new_room(), self.new_room()
        self.meeting.say(rid, "kim", "지난 말")
        self.settle(rid, 3)
        t1 = self.meeting.new_thread(rid, "kim")["thread"]
        past = self.meeting.view(rid, thread=0)
        self.assertEqual([m["content"] for m in past["messages"]][0], "지난 말")
        self.assertEqual((past["thread"], past["viewing"], past["pending"], past["partial"]), (t1, 0, [], {}))
        t_other = self.meeting.new_thread(other, "kim")["thread"]
        with self.assertRaises(meeting.MeetingError) as cm:
            self.meeting.view(rid, thread=t_other)
        self.assertEqual(cm.exception.code, 404)
        with self.assertRaises(meeting.MeetingError) as cm:
            self.meeting.view(rid, thread=999999)
        self.assertEqual(cm.exception.code, 404)

    def test_5_차례_목록은_말_수_첫_말_시작한_사람과_지금_대화를_보이고_빈_지난_차례는_뺀다(self):
        rid = self.new_room()
        self.meeting.say(rid, "kim", "처음 대화의 첫 말")
        self.settle(rid, 3)
        t1 = self.meeting.new_thread(rid, "kim@x.com")["thread"]
        t2 = self.meeting.new_thread(rid, "kim@x.com")["thread"]                     # t1 은 말 없이 끝났다
        got = self.meeting.threads(rid)
        self.assertEqual(got["current"], t2)
        rows = {r["id"]: r for r in got["threads"]}
        self.assertNotIn(t1, rows)
        self.assertEqual([r["id"] for r in got["threads"]], [t2, 0])                 # 최근 것이 앞
        self.assertEqual((rows[0]["count"], rows[0]["first"], rows[0]["by"]), (3, "처음 대화의 첫 말", ""))
        self.assertEqual((rows[t2]["count"], rows[t2]["by"], rows[t2]["current"]), (0, "kim@x.com", True))
        self.assertTrue(rows[t2]["by_label"])

    def test_6_보관은_차례마다_KEEP_행_방마다_KEEP_THREADS_차례(self):
        rid = self.new_room()
        old = (meeting.KEEP, meeting.KEEP_THREADS)
        meeting.KEEP, meeting.KEEP_THREADS = 3, 2
        try:
            for i in range(4):
                meeting._append(rid, "user", "kim", f"처음 {i}")
            self.assertEqual(len(self.meeting.view(rid)["messages"]), 3)             # 지금 차례만 3행
            t1 = self.meeting.new_thread(rid, "kim")["thread"]
            meeting._append(rid, "user", "kim", "둘째 차례")
            self.assertEqual(len(self.meeting.view(rid, thread=0)["messages"]), 3)   # 새 차례에 쓴 것이 앞 차례를 지우지 않는다
            t2 = self.meeting.new_thread(rid, "kim")["thread"]                        # 차례 0·t1·t2 → 둘만 남는다
            ids = [r["id"] for r in self.meeting.threads(rid)["threads"]]
            self.assertEqual(ids, [t2, t1])
            with self.assertRaises(meeting.MeetingError):
                self.meeting.view(rid, thread=t1 - 10**9)                              # 없는 차례
            self.assertEqual([m["content"] for m in self.meeting.view(rid, thread=t1)["messages"]][-1], "둘째 차례")
        finally:
            meeting.KEEP, meeting.KEEP_THREADS = old

    def test_6b_SOUL_알림도_같은_보관_규칙을_쓰고_지난_차례를_지우지_않는다(self):
        rid = self.new_room()
        old = meeting.KEEP
        meeting.KEEP = 2
        try:
            meeting._append(rid, "user", "kim", "앞 차례 1")
            meeting._append(rid, "user", "kim", "앞 차례 2")
            self.meeting.new_thread(rid, "kim")
            for rev in (1, 2, 3):
                meeting.notice_soul("yj", "sa", "me", rev, rev + 1, package="p", version=str(rev))
            self.assertEqual(len(self.meeting.view(rid, thread=0)["messages"]), 2)
            self.assertEqual(len(self.meeting.view(rid)["messages"]), 2)
        finally:
            meeting.KEEP = old

    # ---- R1: 말하기와 새 대화의 줄 세우기 ------------------------------------------
    def test_7_말하기와_새_대화가_겹쳐도_말과_답은_같은_차례에_든다(self):
        rid = self.new_room()
        real = self.meeting._history
        started = []

        def new_thread_when_free():
            # 말하기가 방 잠금을 풀면 새 대화가 들어온다. 그때 답이 아직 끝나지 않았으면 「답하는 중」 409(D4)라 사람처럼
            # 다시 누른다. PostgreSQL 은 잠금을 트랜잭션 끝까지 쥐어 첫 시도가 늘 409 다 — SQLite 는 잠금 대기가 길어
            # 답이 끝난 뒤에 들어갔다. 어느 쪽이든 경계는 말과 답 뒤에 그어져야 한다
            end = time.time() + 10
            while True:
                try:
                    started.append(self.meeting.new_thread(rid, "lee"))
                    return
                except meeting.MeetingError as exc:
                    if exc.reason != "busy" or time.time() > end:
                        raise
                    time.sleep(0.05)

        def slow_history(room_id, alias, after=0):
            if not started:                                    # 말하기가 잠금을 쥔 채 기록을 읽는 사이에 새 대화를 끼워 넣는다
                started.append(1)
                import threading
                threading.Thread(target=new_thread_when_free, daemon=True).start()
                time.sleep(0.3)
            return real(room_id, alias, after)

        self.meeting._history = slow_history
        try:
            self.meeting.say(rid, "kim", "겹친 말", ["sa"])
        finally:
            del self.meeting._history
        end = time.time() + 10
        while time.time() < end and (len(started) < 2 or self.meeting.view(rid, thread=0)["pending"] or self.meeting.view(rid)["pending"]):
            time.sleep(0.05)
        tid = started[1]["thread"] if isinstance(started[1], dict) else self.fail("new_thread 가 끝나지 않았다")
        past = [(m["role"], m["content"]) for m in self.meeting.view(rid, thread=0)["messages"]]
        self.assertEqual(past, [("user", "겹친 말"), ("assistant", "[yj] 답")])       # 말과 답이 같은 차례(0)
        self.assertEqual([m.get("kind") for m in self.meeting.view(rid)["messages"]], [meeting.THREAD_KIND])
        self.assertGreater(tid, 0)

    # ---- R7: Busy 로 끝난 요청은 기다림을 지우지 않는다 ---------------------------
    def test_8_연달아_보내도_첫_답이_끝날_때까지_기다림이_남는다(self):
        rid = self.new_room()
        ws = self.ws["yj"]
        ws.script = lambda sid, text: []                       # 첫 말은 답이 오지 않는다(답하는 중)
        try:
            mark = len(ws.sent)
            self.meeting.say(rid, "kim", "첫 말", ["sa"])
            end = time.time() + 5
            while time.time() < end and not any(f["method"] == "prompt.submit" for f in ws.sent[mark:]):
                time.sleep(0.05)
            sid = next(f["params"]["session_id"] for f in ws.sent[mark:] if f["method"] == "prompt.submit")
            self.meeting.say(rid, "kim", "또 말", ["sa"])     # 같은 대화가 답하는 중 → Busy
            end = time.time() + 5
            while time.time() < end and not any("답하는 중" in m["content"] for m in self.meeting.view(rid)["messages"]):
                time.sleep(0.05)
            self.assertEqual(self.meeting.view(rid)["pending"], ["sa"])               # 첫 답을 아직 기다린다
            with self.assertRaises(meeting.MeetingError):
                self.meeting.new_thread(rid, "kim")
        finally:
            ws.script = None
        ws.inbox.put(json.dumps({"method": "event", "params": {"type": "message.complete", "session_id": sid, "payload": {"text": "늦은 답"}}}))
        end = time.time() + 10
        while time.time() < end and self.meeting.view(rid)["pending"]:
            time.sleep(0.05)
        self.assertEqual(self.meeting.view(rid)["pending"], [])

    # ---- R5·R10: 앞 차례의 중계·허브 메모리 비우기 --------------------------------
    def test_9_새_대화는_이_서버의_앞_차례_대화_메모리를_비운다(self):
        rid = self.new_room()
        self.meeting.say(rid, "kim", "메모리", ["sa"])
        self.settle(rid, 2)
        row = office.session_find("sa", f"meeting-{rid}")
        live = self.bridge._live[row["id"]]
        hub, sid = live["hub"], live["sid"]
        self.assertIn(row["id"], self.bridge._log)
        self.meeting.new_thread(rid, "kim")
        self.assertNotIn(row["id"], self.bridge._live)
        self.assertNotIn(row["id"], self.bridge._log)
        self.assertNotIn(sid, hub.sessions)
        self.assertNotIn(sid, hub._events)


class IdentityTablesTest(unittest.TestCase):
    def test_자동_증가_표는_모두_이전_목록에_있다(self):
        """SQLite→PostgreSQL 이전은 IDENTITY_TABLES 의 표만 시퀀스를 맞춘다. 빠지면 이전 뒤 첫 INSERT 가 키 충돌로 실패한다(R2)."""
        found = set()
        for ddl in dbmigrate.schema_scripts():
            for m in re.finditer(r"CREATE TABLE IF NOT EXISTS (\w+)\s*\(\s*id INTEGER PRIMARY KEY AUTOINCREMENT", ddl, re.I):
                found.add(m.group(1))
        self.assertIn("office_meeting_threads", found)
        self.assertEqual(sorted(found - set(dbmigrate.IDENTITY_TABLES)), [])


if __name__ == "__main__":
    unittest.main()

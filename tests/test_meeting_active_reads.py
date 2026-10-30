# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""회의 목록 토픽(office:meeting:active)의 DB 읽기(스펙 2026-10-26-002 R6·R7·E5). 회의마다 view() 전체를 불러 5초에 SELECT 16개(회의 1개)~38개(3개)를 냈다.
다시 짜기 전에 지금 함수의 결과와 같은지 비교하는 시험을 먼저 두었다(E5)."""
import json
import os
from types import SimpleNamespace
from unittest import mock

from aas.office import meeting, office, shared
from aas.web import server, ws

try:
    from tests.test_db_tps_phase1 import DataDir
    from tests.test_office import KNOWN
except ImportError:                                            # unittest discover -s tests 로 돌릴 때
    from test_db_tps_phase1 import DataDir
    from test_office import KNOWN


def reference_active(m: meeting.Meeting) -> list[dict]:
    """다시 짜기 전 server.office_meeting_active 의 본문 그대로(2026-10-26, f8dfacea). 비교 기준이다."""
    out = []
    for row in m.active():
        view = m.view(row["room"], 0)
        out.append({**row, "partial": view.get("partial") or {},
                    "last": [x for x in (view.get("messages") or [])[-len(row["seats"]):] if x.get("role") == "assistant"]})
    return out


class MeetingFixture(DataDir):
    def setUp(self):
        super().setUp()
        self.now = [10_000.0]
        self.m = meeting.Meeting(mock.Mock(), origin="me", clock=lambda: self.now[0])
        office.set_seat({"pod": "yj", "profile": "sa", "title": "영업"}, "me", KNOWN)
        office.set_seat({"pod": "yj", "profile": "ma"}, "me", KNOWN)
        office.set_seat({"pod": "scdf", "profile": "scdf-doc"}, "me", KNOWN)
        self.rooms = {}
        for name, seats in (("A", ["sa", "scdf-doc"]), ("B", ["sa", "ma", "scdf-doc"]), ("C", ["ma"]), ("D", ["sa"]), ("E", ["ma"])):
            self.rooms[name] = office.set_room({"name": name, "purpose": "p", "seats": seats, "people": ["kim"]}, "me")["id"]
        p = mock.patch.object(server, "office_meeting", return_value=self.m)
        p.start()
        self.addCleanup(p.stop)
        self.addCleanup(self._clear)

    def _clear(self):
        with meeting._db() as conn:                            # 회의 목록 상태 표는 다른 시험과 같은 이름을 쓴다
            for t in ("office_meeting_live", "office_meeting_pending", "office_meeting_threads", "office_messages", "office_servers"):
                conn.execute(f"DELETE FROM {t}")

    def live(self, name: str, ago: float = 10.0):
        with meeting._db() as conn:
            conn.execute("INSERT INTO office_meeting_live (room, last, since) VALUES (?,?,?)", (self.rooms[name], self.now[0] - ago, self.now[0] - 600))

    def pending(self, name: str, alias: str, origin: str = "me"):
        with meeting._db() as conn:
            conn.execute("INSERT INTO office_meeting_pending (room, alias, origin, ts) VALUES (?,?,?,?)", (self.rooms[name], alias, origin, self.now[0] - 1))

    def heartbeat(self, origin: str):
        with meeting._db() as conn:
            conn.execute("INSERT INTO office_servers (origin, ts) VALUES (?,?)", (origin, self.now[0]))

    def say(self, name: str, role: str, author: str, content: str, kind: str = "", data: dict | None = None):
        meeting._append(self.rooms[name], role, author, content, kind, data)

    def new_thread(self, name: str):
        with meeting._db() as conn:
            last = conn.execute("SELECT COALESCE(MAX(id), 0) FROM office_messages WHERE room=?", (self.rooms[name],)).fetchone()[0]
            conn.execute("INSERT INTO office_meeting_threads (room, after_id, ts, by) VALUES (?,?,?,?)", (self.rooms[name], int(last), office._now(), "kim@x.co"))

    def three_meetings(self):
        # A: 「새 대화」로 나뉜 방 — 지금 차례의 마지막 두 줄만, 앞 차례의 답은 빠져야 한다
        self.live("A")
        self.say("A", "user", "kim", "옛 질문")
        self.say("A", "assistant", "sa", "옛 답")
        self.new_thread("A")
        self.say("A", "system", "kim@x.co", "새 대화", meeting.THREAD_KIND, {"by": "kim@x.co", "prev": 0})
        self.say("A", "user", "kim", "새 질문")
        self.say("A", "assistant", "scdf-doc", "새 답", "guard_blocked", {"reason": "rm -rf"})
        # B: 이 서버가 답을 받는 중(쓰는 중인 글 partial), 다른 서버의 답 기다림은 살아 있는 서버만
        self.live("B", ago=200)                                # 마지막 말은 오래됐어도 기다림이 있으면 회의 중
        self.heartbeat("other")
        self.pending("B", "ma")
        self.pending("B", "scdf-doc", origin="other")
        self.pending("B", "sa", origin="dead")                 # 신호가 없는 서버의 기다림은 빠진다
        self.m._partial[self.rooms["B"]] = {"ma": "쓰는 중…"}
        for i in range(5):
            self.say("B", "assistant" if i % 2 else "user", "sa" if i % 2 else "kim", f"말 {i}")
        # C: 기록이 하나도 없는 방
        self.live("C", ago=5)
        # D: 끝난 방(목록에서 빠짐), E: 마지막 말이 오래된 방(빠짐)
        office.set_room({"id": self.rooms["D"], "name": "D", "purpose": "p", "seats": ["sa"], "people": ["kim"], "status": "closed"}, "me")
        self.live("D")
        self.live("E", ago=meeting.ACTIVE_FOR + 60)


class EquivalenceTest(MeetingFixture):
    """E5: 다시 짠 함수와 지금 함수의 결과가 같다(회의 0·1·3개, 기다림, 기록 없는 방, 다른 서버의 답)."""

    def test_회의가_없으면_빈_목록(self):
        self.assertEqual(server.office_meeting_active(), reference_active(self.m))
        self.assertEqual(server.office_meeting_active(), [])

    def test_회의_하나(self):
        self.live("A")
        self.say("A", "user", "kim", "일정?")
        self.say("A", "assistant", "sa", "다음 주")
        self.say("A", "assistant", "scdf-doc", "문서는 금요일")
        want = reference_active(self.m)
        self.assertEqual(len(want), 1)
        self.assertEqual(server.office_meeting_active(), want)

    def test_회의_셋과_빠지는_방들(self):
        self.three_meetings()
        want = reference_active(self.m)
        self.assertEqual([r["name"] for r in want], ["C", "A", "B"])   # 최근에 말한 회의가 앞
        got = server.office_meeting_active()
        self.assertEqual(got, want)
        b = next(r for r in got if r["name"] == "B")
        self.assertEqual((b["pending"], b["partial"]), (["ma", "scdf-doc"], {"ma": "쓰는 중…"}))
        a = next(r for r in got if r["name"] == "A")
        self.assertEqual([x["content"] for x in a["last"]], ["새 답"])
        self.assertEqual(a["last"][0]["data"], {"reason": "rm -rf"})


class ReadCountTest(MeetingFixture):
    """R7: 회의 셋일 때 토픽 값 한 번이 SELECT 7개 이하(전에는 38개)."""

    def test_회의_셋이어도_SELECT_7개_이하(self):
        self.three_meetings()
        server.office_meeting_active()                         # 표 만들기 등 첫 부름 몫은 빼고 센다
        n = self.count_sql("SELECT")
        server.office_meeting_active()
        self.assertLessEqual(n(), 7)


class MeetingAliveMemoTest(MeetingFixture):
    """R6 후속: 회의의 「살아 있는 서버」 읽기(meeting.py _alive)가 회의 목록 토픽마다 office_servers 를 물었다(OKE 반영 뒤 0.70/s 남음)."""

    def test_5초_안에는_한_번만_읽는다(self):
        with meeting._db() as conn:
            self.m._alive(conn)
        n = self.count_sql("FROM office_servers WHERE ts")
        with meeting._db() as conn:
            self.m._alive(conn)
            self.m._alive(conn)
        self.assertEqual(n(), 0)
        self.now[0] += shared.ALIVE_MEMO + 0.1
        with meeting._db() as conn:
            self.m._alive(conn)
        self.assertEqual(n(), 1)


class MeetingNotifyTest(MeetingFixture):
    """R7: 회의 상태를 쓰면 같은 트랜잭션에서 meeting 알림을 보내 두 서버의 회의 목록 토픽이 다시 읽는다.
    듣기 연결이 붙어 있고 기다리는 답이 없으면 주기를 5초 → 30초로 늘린다."""

    def test_회의_상태_쓰기는_meeting_알림을_보낸다(self):
        sent = []
        with mock.patch.object(meeting.shared, "notify", side_effect=lambda conn, kind: sent.append(kind)):
            self.m._touch(self.rooms["A"], start=True)
        self.assertIn("meeting", sent)

    def test_meeting_알림은_어느_서버가_보냈든_읽는다(self):
        self.assertEqual(shared.parse_notify("meeting", "me"), "meeting")

    def test_알림을_받으면_회의_목록_토픽을_다시_읽게_한다(self):
        with mock.patch.object(server.topics, "invalidate") as inv:
            server._shared_notified("meeting")
        inv.assert_called_with("office:meeting:active", exact=True)

    def test_듣기_연결이_붙어_있고_기다림이_없으면_30초(self):
        interval = ws._meeting_active_spec().interval
        with mock.patch.object(server, "SHARED_LISTENER", SimpleNamespace(connected=True)):
            self.assertEqual(interval([]), 30.0)
            self.assertEqual(interval([{"pending": ["ma"]}]), 1.5)
        with mock.patch.object(server, "SHARED_LISTENER", SimpleNamespace(connected=False)):
            self.assertEqual(interval([]), 5.0)
        with mock.patch.object(server, "SHARED_LISTENER", None):     # SQLite(서버 하나)는 알림이 없다
            self.assertEqual(interval([]), 5.0)


if __name__ == "__main__":
    import unittest
    unittest.main()

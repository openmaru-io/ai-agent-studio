# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""오피스 메타와 다리 시험 — 가짜 Hermes 대화 채널 둘(설치본 둘)을 붙여, 오피스가 기대하는 말투로 답하는지 본다."""
import json
import os
import queue
import tempfile
import threading
import unittest
from pathlib import Path

TMP = tempfile.TemporaryDirectory()
os.environ.setdefault("AAS_DATA_DIR", str(Path(TMP.name) / "data"))

from aas.office import office, relay  # noqa: E402
from aas.hermes.hermes_chat import ChatHub  # noqa: E402
from aas.fleet.pods import Pod  # noqa: E402

SETTINGS = {"url": "http://127.0.0.1:9", "user": "u", "password": "p", "provider": "basic"}


class FakeWS:
    """설치본 하나의 대시보드 대화 채널. 받은 말을 이름표를 붙여 되돌려준다."""

    def __init__(self, name: str):
        self.name, self.inbox, self.sent, self.n = name, queue.Queue(), [], 0
        self.script = None                                    # (sid, text) → [(type, payload)…] 로 바꿔 끼울 수 있다

    def send(self, data: str):
        frame = json.loads(data)
        self.sent.append(frame)
        m, rid, p = frame["method"], frame["id"], frame["params"]
        if m == "session.create":
            self.n += 1
            self.reply(rid, {"session_id": f"{self.name}-s{self.n}"})
        elif m == "session.resume":
            self.reply(rid, {"session_id": f"{self.name}-r-{p['session_id']}", "messages": []})
        elif m == "prompt.submit":
            self.reply(rid, {"ok": True})
            sid = p["session_id"]
            events = self.script(sid, p["text"]) if self.script else [
                ("session.title", {"session_id": "stored-" + sid}), ("tool.start", {"tool_id": "t1", "name": "web_search"}),
                ("tool.complete", {"tool_id": "t1", "name": "web_search"}), ("message.delta", {"text": f"[{self.name}] "}),
                ("message.delta", {"text": "답"}), ("message.complete", {"text": f"[{self.name}] 답"})]
            for t, pl in events:
                self.inbox.put(json.dumps({"method": "event", "params": {"type": t, "session_id": sid, "payload": pl}}))
        else:
            self.reply(rid, {"ok": True})

    def reply(self, rid, result):
        self.inbox.put(json.dumps({"jsonrpc": "2.0", "id": rid, "result": result}))

    def __iter__(self):
        while True:
            item = self.inbox.get()
            if item is None:
                return
            yield item

    def prompts(self):
        return [f["params"]["text"] for f in self.sent if f["method"] == "prompt.submit"]


class FakeRegistry:
    pods = [Pod("yj", "a@x.com", Path("/nonexistent")), Pod("scdf", "a@x.com", Path("/nonexistent"), "SC-Dark-Factory", "http://127.0.0.1:9")]


KNOWN = {"yj": {"sa", "ma", "default"}, "scdf": {"scdf-doc", "sa"}}


class OfficeMetaTest(unittest.TestCase):
    def setUp(self):
        with office.connect() as conn:
            for t in ("office_seats", "office_rooms", "office_pins", "office_checks", "office_sessions"):
                conn.execute(f"DELETE FROM {t}")

    def test_seat_rules(self):
        office.set_seat({"pod": "yj", "profile": "sa", "role": "영업 지원", "team": "TFT-A"}, "me", KNOWN)
        self.assertEqual(office.routing(), {"sa": {"pod": "yj", "profile": "sa"}})
        with self.assertRaises(office.OfficeError):            # 다른 설치본의 같은 이름은 별칭을 달리해야 한다
            office.set_seat({"pod": "scdf", "profile": "sa"}, "me", KNOWN)
        office.set_seat({"pod": "scdf", "profile": "sa", "alias": "scdf-sa"}, "me", KNOWN)
        self.assertEqual(office.routing()["scdf-sa"], {"pod": "scdf", "profile": "sa"})
        for bad in ({"pod": "nope", "profile": "sa"}, {"pod": "yj", "profile": "ghost"}, {"pod": "yj", "profile": "ma", "alias": "default"},
                    {"pod": "yj", "profile": "ma", "alias": "Bad Name"}):
            with self.assertRaises(office.OfficeError):
                office.set_seat(bad, "me", KNOWN)
        office.set_seat({"pod": "yj", "profile": "sa", "enabled": False}, "me", KNOWN)
        self.assertNotIn("sa", office.routing())               # 꺼 둔 자리는 다리가 모른다
        office.set_seat({"pod": "yj", "profile": "sa", "alias": "sales"}, "me", KNOWN)      # 이름 바꾸기 — 옛 이름은 사라진다
        self.assertEqual(sorted(s["alias"] for s in office.seats()), ["sales", "scdf-sa"])
        office.delete_seat("sales")
        with self.assertRaises(office.OfficeError):
            office.delete_seat("sales")

    def test_rooms_and_pins(self):
        office.set_seat({"pod": "yj", "profile": "sa"}, "me", KNOWN)
        rid = office.set_room({"name": "제안 TFT", "purpose": "RFP 대응", "seats": ["sa", "ghost"], "people": ["kim@x.com"]}, "me")["id"]
        room = office.rooms()[0]
        self.assertEqual((room["seats"], room["people"]), (["sa"], ["kim@x.com"]))      # 없는 자리는 버린다
        office.set_room({"id": rid, "name": "제안 TFT", "status": "closed"}, "me")
        self.assertEqual(office.rooms()[0]["status"], "closed")
        with self.assertRaises(office.OfficeError):
            office.set_room({"name": ""}, "me")
        office.set_pin("hermes", "0.21.0", "me")
        self.assertEqual(office.pins()["hermes"]["value"], "0.21.0")
        with self.assertRaises(office.OfficeError):
            office.set_pin("nope", "x", "me")

    def test_room_people_follow_members_and_owner_defaults(self):
        """2026-10-18: 화면은 「사람」 칸 없이 구성원만 고른다. 사람(회의 안내문·목록)은 구성원에서 나오고, 담당은 구성원이며 비우면 만든 사람이다."""
        rid = office.set_room({"name": "새 TFT", "members": ["Kim@X.com", "lee@x.com"]}, "me@x.com")["id"]
        room = next(r for r in office.rooms() if r["id"] == rid)
        mine = ["kim@x.com", "lee@x.com", "me@x.com"]                                      # 비워 둔 담당은 만든 사람이고 구성원에도 들어간다
        self.assertEqual((room["people"], room["members"], room["owner"]), (mine, mine, "me@x.com"))
        office.set_room({"id": rid, "name": "새 TFT", "owner": "park@x.com", "members": ["kim@x.com"]}, "me@x.com")
        room = next(r for r in office.rooms() if r["id"] == rid)
        self.assertEqual((room["owner"], room["members"], room["people"]), ("park@x.com", ["kim@x.com", "park@x.com"], ["kim@x.com", "park@x.com"]))  # 담당은 구성원에 들어간다
        office.set_room({"id": rid, "name": "새 TFT", "status": "closed"}, "me@x.com")             # 구성원·사람을 보내지 않으면 그대로 둔다
        room = next(r for r in office.rooms() if r["id"] == rid)
        self.assertEqual((room["status"], room["people"], room["owner"]), ("closed", ["kim@x.com", "park@x.com"], "park@x.com"))

    def test_version_drift_and_unreachable_pod_are_reported(self):
        office.set_seat({"pod": "yj", "profile": "sa"}, "me", KNOWN)
        office.set_pin("hermes", "0.21.0", "me")
        with office.connect() as conn:
            conn.execute("INSERT INTO office_checks VALUES ('2026-10-05T10:00:00+09:00','pod:yj','ok','0.21.5','')")
            conn.execute("INSERT INTO office_checks VALUES ('2026-10-05T10:00:00+09:00','pod:scdf','down','','ConnectionRefusedError')")
            conn.execute("INSERT INTO office_checks VALUES ('2026-10-05T10:00:00+09:00','hub','down','','옛 대상')")
        problems = office.problems()
        texts = " / ".join(p["text"] for p in problems)
        self.assertIn("0.21.5", texts)
        self.assertIn("scdf", texts)
        self.assertNotIn("다리", texts)                                    # 옛 대상(다리)의 기록은 더 보이지 않는다
        self.assertNotIn("has_key", json.dumps(office.seats()))


class OfficeApiTest(unittest.TestCase):
    """server 의 오피스 요청 처리 — 실제 프로파일 폴더를 보고 자리를 받는지."""

    def setUp(self):
        from aas.fleet import pods as pods_mod
        home = Path(TMP.name) / "hermes-api"
        (home / "profiles" / "sa").mkdir(parents=True, exist_ok=True)
        (home / "profiles" / "ma").mkdir(parents=True, exist_ok=True)

        class Reg:
            pods = [Pod("yj", "a@x.com", home)]
            allowed = staticmethod(lambda user, enabled: Reg.pods)
            managed = staticmethod(lambda user, enabled: Reg.pods)
            is_admin = staticmethod(lambda user: True)
        self.reg = Reg
        with office.connect() as conn:
            for t in ("office_seats", "office_rooms"):
                conn.execute(f"DELETE FROM {t}")

    def test_actions(self):
        from aas.web import server
        act = lambda body: server._office_action(self.reg, body, "me@x.com")      # noqa: E731
        act({"action": "seat.set", "pod": "yj", "profile": "sa", "role": "영업"})
        with self.assertRaises(office.OfficeError):
            act({"action": "seat.set", "pod": "yj", "profile": "ghost"})
        with self.assertRaises(ValueError):
            act({"action": "nope"})
        view = server._office(self.reg, None, False)
        self.assertNotIn("office_url", view)
        self.assertNotIn("hub_url", view)
        self.assertNotIn("has_token", view)
        seated = {p["name"]: p["seated"] for p in view["pods"][0]["profiles"]}
        self.assertEqual(seated, {"ma": False, "sa": True})

    def test_쿠버네티스에서는_default_프로파일도_앉힐_수_있다(self):
        """사용자별 Hermes 는 프로파일이 default 하나뿐이라, 빼면 새 사용자는 아무도 앉히지 못한다(OKE 실측: 자리 탭이 비어 있다)."""
        from unittest import mock
        from aas.web import server
        with mock.patch.dict(os.environ, {"AAS_K8S_NAMESPACE": "cogentai-aas-agents"}):
            view = server._office(self.reg, None, False)
        self.assertIn("default", {p["name"] for p in view["pods"][0]["profiles"]})
        self.assertNotIn("default", {p["name"] for p in server._office(self.reg, None, False)["pods"][0]["profiles"]})   # compose 는 그대로



class RelayTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.ws = {"yj": FakeWS("yj"), "scdf": FakeWS("scdf")}
        cls.bridge = relay.Bridge(FakeRegistry(), lambda pod: ChatHub(SETTINGS, connect=lambda: cls.ws[pod.id]))
        with office.connect() as conn:
            for t in ("office_seats", "office_sessions"):
                conn.execute(f"DELETE FROM {t}")
        office.set_seat({"pod": "yj", "profile": "sa"}, "me", KNOWN)
        office.set_seat({"pod": "scdf", "profile": "scdf-doc"}, "me", KNOWN)
        cls.bridge.routes(0)

    @classmethod
    def tearDownClass(cls):
        for w in cls.ws.values():
            w.inbox.put(None)

    def say(self, alias, text, key, system="", history=None):
        """말 한 번을 보내고 답이 끝날 때까지 기다려 조각 목록을 돌려준다."""
        row, _ = office.session_create(alias, key)
        turn = self.bridge.start(alias, self.bridge.routes()[alias], row, text, system, history or [])
        n, items = 0, []
        for _ in range(100):
            got = turn.after(n, wait=0.2)
            items += got
            n += len(got)
            if turn.done and n >= len(turn.items):
                break
        return turn, items, row

    def test_dm_goes_to_the_right_install(self):
        turn, items, row = self.say("sa", "안녕", "npc1-dm-user1", "짧게 답해")
        self.assertEqual([i[0] for i in items], ["tool_start", "tool_done", "delta", "delta", "final"])
        self.assertEqual(items[0][1], "web_search")
        self.assertEqual(items[-1][1], "[yj] 답")
        sent = self.ws["yj"].prompts()[-1]
        self.assertIn("짧게 답해", sent)
        self.assertTrue(sent.endswith("안녕"))
        self.assertEqual(self.ws["scdf"].prompts(), [])                            # 다른 설치본에는 가지 않는다
        self.say("sa", "또", "npc1-dm-user1", "짧게 답해")
        self.assertNotIn("짧게 답해", self.ws["yj"].prompts()[-1])                  # 같은 지시는 다시 보내지 않는다
        self.assertEqual(office.session_get(row["id"])["stored_id"][:7], "stored-")  # Hermes 쪽 대화 id 를 적어 둔다
        self.assertEqual(self.bridge.turn(turn.id, "sa"), turn)
        self.assertIsNone(self.bridge.turn(turn.id, "scdf-doc"))                    # 다른 자리 이름으로는 못 본다

    def test_room_run_reaches_other_install_and_sends_only_new_history(self):
        hist = [{"role": "user", "content": "김: 일정 봐 줘"}, {"role": "assistant", "content": "sa: 다음 주 화요일"}]
        turn, items, _ = self.say("scdf-doc", "문서 초안 써 줘", "npc2-room-r1", "방의 규칙", hist)
        self.assertEqual(items[-1], ("final", "[scdf] 답"))
        first = self.ws["scdf"].prompts()[-1]
        self.assertIn("방의 규칙", first)
        self.assertIn("김: 일정 봐 줘", first)
        self.assertEqual(turn.status, "completed")
        hist2 = hist + [{"role": "user", "content": "김: 표도 넣어"}]
        self.say("scdf-doc", "이어서", "npc2-room-r1", "방의 규칙", hist2)
        second = self.ws["scdf"].prompts()[-1]
        self.assertIn("김: 표도 넣어", second)
        self.assertNotIn("김: 일정 봐 줘", second)                                  # 이미 보낸 기록은 빼고
        self.assertNotIn("방의 규칙", second)
        self.assertEqual(len([f for f in self.ws["scdf"].sent if f["method"] == "session.create"]), 1)   # 같은 열쇠는 한 대화를 이어 쓴다
        self.bridge.control(turn, "stop", {})
        self.assertIn("session.interrupt", [f["method"] for f in self.ws["scdf"].sent])

    def test_failure_and_clarify(self):
        ws = self.ws["yj"]
        ws.script = lambda sid, text: [("message.complete", {"status": "error", "text": "모델이 답하지 않습니다"})]
        try:
            turn, items, _ = self.say("sa", "x", "k-fail")
            self.assertEqual(items[-1], ("failed", "모델이 답하지 않습니다"))
            ws.script = lambda sid, text: [("clarify.request", {"request_id": "c1", "questions": [{"qid": "q1", "question": "어느 고객인가요?"}]})]
            turn, items, _ = self.say("sa", "y", "k-ask")
            self.assertEqual(items[-1][0], "final")                                 # 되묻기는 답으로 내보낸다
            self.assertIn("어느 고객인가요?", items[-1][1])
            self.assertNotIn("choices", [k for k, *_ in items])                    # 선택지가 없으면 choices 항목도 없다
            # 선택지는 방 기록(final 글)에 넣지 않고 final 앞의 choices 항목으로 보낸다(스펙 2026-10-23-005 R9·D11)
            ws.script = lambda sid, text: [("clarify.request", {"request_id": "c2", "questions": [
                {"qid": "q1", "question": "형식?", "choices": ["PDF", "Word"], "multi_select": True}]})]
            turn, items, _ = self.say("sa", "z", "k-ask2")
            kinds = [k for k, *_ in items]
            self.assertEqual(kinds[-2:], ["choices", "final"])
            self.assertEqual(items[-2][1], [{"question": "형식?", "choices": ["PDF", "Word"], "multi": True}])
            self.assertNotIn("PDF", items[-1][1])
        finally:
            ws.script = None

    def test_resumed_chat_with_open_question_is_interrupted(self):
        """다시 연 대화에 답하지 않은 되묻기가 남아 있으면 중계가 끝낸다 — 중계는 다시 연 뒤 번호부터 읽어 그 물음을 보지 못한다(스펙 2026-10-23-005 R17)."""
        ws = self.ws["yj"]
        orig = ws.send

        def send(data):
            frame = json.loads(data)
            if frame.get("method") == "session.resume":
                ws.sent.append(frame)
                ws.reply(frame["id"], {"session_id": "yj-open", "messages": [], "open_requests": [
                    {"id": "srq-r", "method": "clarify", "params": {"session_id": "yj-open", "questions": [{"qid": "q0", "question": "형식?"}]}}]})
                return
            orig(data)
        ws.send = send
        try:
            row, _ = office.session_create("sa", "k-open")
            office.session_stored(row["id"], "stored-open")
            row = dict(row, stored_id="stored-open")
            live = self.bridge._ensure_live(row, self.bridge.routes()["sa"])
            self.assertEqual(live["sid"], "yj-open")
            self.assertTrue(live["hub"].sessions["yj-open"].get("relay"))
            self.assertIn("session.interrupt", [f.get("method") for f in ws.sent])
        finally:
            ws.send = orig


if __name__ == "__main__":
    unittest.main()

# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""오피스 1:1 대화의 「/」 명령 시험(스펙 2026-10-26-010 R3·R10·R11) — 관리하는 사람만, 되감은 뒤 대화 기록·지시 표시,
retry 는 relay 차례로, 답하는 중 /queue 예약."""
import json
import os
import tempfile
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

TMP = tempfile.TemporaryDirectory()
os.environ.setdefault("AAS_DATA_DIR", str(Path(TMP.name) / "data"))

from aas.hermes import chat_commands as cc, skill_commands  # noqa: E402
from aas.hermes.hermes_chat import ChatHub  # noqa: E402
from aas.office import office, office_access, relay  # noqa: E402

try:
    from tests.test_office import KNOWN, SETTINGS, FakeRegistry  # noqa: E402
    from tests.test_chat_commands import CmdWS  # noqa: E402
except ImportError:                                            # unittest discover -s tests 로 돌릴 때
    from test_office import KNOWN, SETTINGS, FakeRegistry  # noqa: E402
    from test_chat_commands import CmdWS  # noqa: E402


class OfficeCommandTest(unittest.TestCase):
    def setUp(self):
        skill_commands.forget()
        with office.connect() as conn:
            for t in ("office_seats", "office_sessions"):
                conn.execute(f"DELETE FROM {t}")
        office.set_seat({"pod": "yj", "profile": "sa"}, "me", KNOWN)
        self.seat = next(s for s in office.seats() if s["alias"] == "sa")
        self.ws = CmdWS("yj")
        self.bridge = relay.Bridge(FakeRegistry(), lambda pod: ChatHub(SETTINGS, connect=lambda: self.ws))
        self.row, _ = office.session_create("sa", "office-kim@x.com-sa")

    def tearDown(self):
        self.ws.inbox.put(None)
        with office.connect() as conn:
            for t in ("office_seats", "office_sessions"):
                conn.execute(f"DELETE FROM {t}")

    def wait_done(self, tid: str) -> relay.Turn:
        turn = self.bridge.turn(tid, "sa")
        end = time.time() + 5
        while not turn.done and time.time() < end:
            time.sleep(0.02)
        self.assertTrue(turn.done)
        return turn

    def log(self):
        return self.bridge.history(self.row, self.seat)["messages"]

    def test_status_and_plan(self):
        out = self.bridge.command("sa", self.seat, self.row, "status", by="kim@x.com")
        self.assertEqual(out, {"kind": "output", "command": "/status", "text": "out /status"})
        out = self.bridge.command("sa", self.seat, self.row, "plan", "배포", by="kim@x.com")
        self.assertEqual((out["kind"], out["text"]), ("turn", "/plan 배포"))
        self.wait_done(out["turn"])
        self.assertEqual(self.ws.prompts()[-1], "PLAN PROMPT task")
        self.assertEqual(self.log()[0], {"role": "user", "text": "/plan 배포"})

    def test_background_and_multi_turn_commands_are_not_run_in_office(self):
        """review·refine·goal·loop 는 Hermes 가 시작한 턴으로 결과가 오는데 relay 는 자기 차례만 읽는다(스펙 2026-10-27-002 R3)."""
        for name, arg in (("review", ""), ("refine", ""), ("goal", "끝내기"), ("loop", "10m 확인")):
            with self.assertRaises(cc.CommandError) as e:
                self.bridge.command("sa", self.seat, self.row, name, arg, by="kim@x.com")
            self.assertEqual(e.exception.code, "unsupported", name)
        self.assertEqual(self.ws.dispatched(), [])
        self.assertNotIn("/goal", self.bridge.command("sa", self.seat, self.row, "help", by="kim@x.com")["text"])

    def test_office_title_stores_the_stored_id_and_side_commands_are_out(self):
        """오피스 1:1 은 /title 만(3단계). 첫 말 전 제목이면 Hermes 자동 제목 이벤트가 없어 저장 번호를 여기서 적는다(OV1)."""
        out = self.bridge.command("sa", self.seat, self.row, "title", "회의 준비", by="kim@x.com")
        self.assertEqual(out["kind"], "output")
        self.assertNotIn("stored_key", out)
        self.assertEqual(office.session_find("sa", "office-kim@x.com-sa")["stored_id"], "stored-key-1")
        for name, arg in (("btw", "질문"), ("subgoal", "x"), ("heartbeat", "pause")):
            with self.assertRaises(cc.CommandError) as e:
                self.bridge.command("sa", self.seat, self.row, name, arg, by="kim@x.com")
            self.assertEqual(e.exception.code, "unsupported", name)

    def test_office_log_skips_hermes_started_prompts(self):
        """백그라운드 알림처럼 Hermes 가 스스로 시작한 턴의 프롬프트는 오피스 기록에 사람 말로 넣지 않는다(답은 남긴다)."""
        rows = relay.Bridge._log_rows([{"role": "user", "text": "안녕"}, {"role": "assistant", "text": "네"},
                                       {"role": "user", "text": "[IMPORTANT: Background process p1 exited (exit code 0)."},
                                       {"role": "assistant", "text": "끝났습니다"}])
        self.assertEqual([(r["role"], r["text"]) for r in rows], [("user", "안녕"), ("assistant", "네"), ("assistant", "끝났습니다")])

    def test_undo_rebuilds_the_log_and_resets_the_instruction_marks(self):
        t = self.bridge.start("sa", self.seat, self.row, "첫 질문", system="방 규칙", by="kim@x.com")
        self.wait_done(t.id)
        live = self.bridge._live[self.row["id"]]
        self.assertTrue(live["sys"])
        self.ws.history = []                                   # 마지막 턴을 지우면 빈 목록 — 버리지 않고 빈 기록으로(R11)
        out = self.bridge.command("sa", self.seat, self.row, "undo")
        self.assertEqual((out["kind"], out["messages"]), ("prefill", []))
        self.assertEqual(self.log(), [])
        self.assertEqual((live["sys"], live["seen"]), ("", ""))
        t2 = self.bridge.start("sa", self.seat, self.row, "다시", system="방 규칙", by="kim@x.com")
        self.wait_done(t2.id)
        self.assertIn("방 규칙", self.ws.prompts()[-1])          # 지시가 다시 붙는다

    def test_retry_goes_through_a_relay_turn_without_extra_headers(self):
        t = self.bridge.start("sa", self.seat, self.row, "첫 질문", by="kim@x.com")
        self.wait_done(t.id)
        self.ws.history = [{"role": "user", "text": "앞 질문"}, {"role": "assistant", "text": "앞 답"}]
        out = self.bridge.command("sa", self.seat, self.row, "retry", by="kim@x.com")
        self.assertEqual((out["kind"], out["retry"], out["text"]), ("turn", True, "첫 질문"))
        self.wait_done(out["turn"])
        self.assertEqual(self.ws.prompts()[-1], "첫 질문")       # 머리말 없이 한 번만
        log = self.log()
        self.assertEqual(log[:3], [{"role": "user", "text": "앞 질문"}, {"role": "assistant", "text": "앞 답"},
                                   {"role": "user", "text": "첫 질문"}])

    def test_busy_queue_is_sent_after_the_turn(self):
        hold = {"go": False}
        default = self.ws.script

        def slow(sid, text):
            return [] if not hold["go"] and text == "긴 일" else (default(sid, text) if default else [
                ("message.complete", {"text": "답"})])
        self.ws.script = slow
        t = self.bridge.start("sa", self.seat, self.row, "긴 일", by="kim@x.com")
        with self.assertRaises(cc.CommandError):
            self.bridge.command("sa", self.seat, self.row, "retry")
        out = self.bridge.command("sa", self.seat, self.row, "queue", "다음 말", by="kim@x.com")
        self.assertEqual(out, {"kind": "queued", "count": 1})
        self.assertEqual(self.bridge.queue_view(self.row["id"])["items"][0]["text"], "다음 말")
        sid = self.bridge._live[self.row["id"]]["sid"]
        self.ws.inbox.put(json.dumps({"method": "event", "params": {"type": "message.complete", "session_id": sid,
                                                                    "payload": {"text": "끝"}}}))
        self.wait_done(t.id)
        end = time.time() + 3
        while "다음 말" not in self.ws.prompts() and time.time() < end:
            time.sleep(0.02)
        self.assertIn("다음 말", self.ws.prompts())
        self.assertEqual(self.bridge.queue_view(self.row["id"])["items"], [])


class FakeAcc:
    def __init__(self, manages: bool):
        self._m = manages

    def require_use(self, alias):
        return None

    def manages(self, alias):
        return self._m


class RouteTest(unittest.TestCase):
    """서버 경로: 관리하지 않는 사람은 목록에 명령이 없고(이름은 있음) 실행은 403(R3·DC5·DC13)."""

    def setUp(self):
        from aas.web import server
        self.server = server
        with office.connect() as conn:
            for t in ("office_seats", "office_sessions"):
                conn.execute(f"DELETE FROM {t}")
        office.set_seat({"pod": "yj", "profile": "sa"}, "me", KNOWN)
        self.bridge = mock.Mock()
        self.patch = mock.patch.object(server, "office_auto", return_value=SimpleNamespace(bridge=self.bridge))
        self.patch.start()
        got = skill_commands.parse({"commands": {f"/{n}": {} for n in cc.NAMES}, "skills": {}})
        self.cached = mock.patch.object(server.skill_commands, "cached", return_value={**got, "warning": ""})
        self.cached.start()

    def tearDown(self):
        self.patch.stop()
        self.cached.stop()
        with office.connect() as conn:
            for t in ("office_seats", "office_sessions"):
                conn.execute(f"DELETE FROM {t}")

    def call(self, acc, method, path, body=None, query=None):
        one = lambda k: (query or {}).get(k, "")                # noqa: E731
        return self.server._office_chat(acc, method, path, one, body or {}, "kim@x.com", lambda *a: None)

    def test_member_gets_names_but_no_commands_and_cannot_run(self):
        code, out = self.call(FakeAcc(False), "GET", "/api/office/chat/skills", query={"alias": "sa"})
        self.assertEqual((code, out["commands"], out["commands_allowed"], len(out["command_names"])), (200, [], False, 19))
        with self.assertRaises(office_access.Denied):
            self.call(FakeAcc(False), "POST", "/api/office/chat/command", {"alias": "sa", "command": "status"})
        with self.assertRaises(office_access.Denied):
            self.call(FakeAcc(False), "POST", "/api/office/chat/queue", {"alias": "sa", "op": "drop"})
        self.bridge.command.assert_not_called()

    def test_manager_runs_and_refusals_are_sentences(self):
        code, out = self.call(FakeAcc(True), "GET", "/api/office/chat/skills", query={"alias": "sa"})
        self.assertEqual((len(out["commands"]), out["commands_allowed"]), (13, True))
        # 오피스 1:1 은 Hermes 가 시작한 턴을 따라가지 않는다 — review·refine·goal·loop 는 목록에 없다(스펙 2026-10-27-002 R3)
        self.assertFalse({"review", "refine", "goal", "loop"} & {r["name"] for r in out["commands"]})
        self.bridge.command.return_value = {"kind": "output", "command": "/status", "text": "ok"}
        self.bridge.queue_view.return_value = {"items": [], "held": False, "compressing": False}
        code, out = self.call(FakeAcc(True), "POST", "/api/office/chat/command", {"alias": "sa", "command": "status"})
        self.assertEqual((code, out["ok"], out["result"]["text"]), (200, True, "ok"))
        self.bridge.command.side_effect = cc.CommandError("busy", "답이 끝난 뒤에")
        code, out = self.call(FakeAcc(True), "POST", "/api/office/chat/command", {"alias": "sa", "command": "retry"})
        self.assertEqual((code, out["ok"], out["error"]["code"]), (200, False, "busy"))


if __name__ == "__main__":
    unittest.main()

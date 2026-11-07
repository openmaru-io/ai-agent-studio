# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""입력창 「/」 Hermes 내장 명령 시험(스펙 2026-10-26-010) — 가짜 대시보드 WS 로 허용 목록·이름 겹침·실행 경로·되감기·
/compress 기다림·/queue 예약을 본다. 가짜 Hermes 의 응답 모양은 d923a5eb 의 계약(tui_gateway/contracts/tools_commands.py)을 따른다."""
import json
import os
import re
import tempfile
import time
import unittest
from pathlib import Path

TMP = tempfile.TemporaryDirectory()
os.environ.setdefault("AAS_DATA_DIR", str(Path(TMP.name) / "data"))

from aas.hermes import chat_commands as cc, skill_commands  # noqa: E402
from aas.hermes.hermes_chat import ChatHub, SessionBusy  # noqa: E402

try:
    from tests.test_office import SETTINGS, FakeWS  # noqa: E402
except ImportError:                                            # unittest discover -s tests 로 돌릴 때
    from test_office import SETTINGS, FakeWS  # noqa: E402

META = {f"/{n}": {"argument_mode": None, "desktop": None} for n in cc.NAMES}
META["/model"] = {"argument_mode": None, "desktop": "hidden"}
CATALOG = {
    "pairs": [["/status", "Show status"], ["/요약", "주간 업무를 요약합니다"]],
    "commands": META,
    "categories": [{"name": "Session", "pairs": [["/status", "Show status"], ["/retry", "Retry"]]}],
    "skills": {"/요약": {"usage": 3, "origin": "local"}},
}
PLAN_PROMPT = ("[/plan — plan mode]\n\nFor this turn, you are in PLAN MODE — planning only.\n- Do not implement code.\n\n"
               "Task to plan:\n배포 정리\n\nWrite the plan for an implementer with zero context")   # d923a5eb agent/plan_prompt.py 모양
HISTORY = [{"role": "user", "text": "첫 질문"}, {"role": "assistant", "text": "첫 답"},
           {"role": "tool", "name": "web_search", "context": "q", "text": "", "args": {"q": "x"}}]


class CmdWS(FakeWS):
    """commands.catalog·slash.exec·command.dispatch·session.history 를 더한다. dispatch[name] 은 (결과, 오류 코드) 또는 None(답하지 않음)."""

    def __init__(self, name: str):
        super().__init__(name)
        self.catalog = CATALOG
        self.history: list | None = HISTORY
        self.submit_error = False
        self.submit_status = None                              # prompt.submit 응답의 status(streaming·queued·redirected…)
        self.control = None                                    # session.control.read 의 control
        self.title, self.title_pending, self.title_error = "", False, None
        self.control_error = None
        self.btw_n = 0
        self.dispatch = {
            "plan": ({"type": "send", "message": "PLAN PROMPT task"}, None),
            "retry": ({"type": "send", "message": "첫 질문"}, None),
            "undo": ({"type": "prefill", "message": "첫 질문", "notice": "↶ Undid 2 turns (4 message(s)). Edit and resubmit."}, None),
            "compress": ({"type": "exec", "output": "Compressed: 12k → 3k tokens"}, None),
            "queue": ({"type": "send", "message": "나중 말"}, None),
            "steer": ({"type": "exec", "output": "⏩ Steer queued"}, None),
        }

    def send(self, data: str):
        frame = json.loads(data)
        m, rid, p = frame["method"], frame["id"], frame["params"]
        if m == "commands.catalog":
            self.sent.append(frame)
            if self.catalog is not None:
                self.reply(rid, self.catalog)
        elif m == "slash.exec":
            self.sent.append(frame)
            self.reply(rid, {"output": f"out {p['command']}"})
        elif m == "command.dispatch":
            self.sent.append(frame)
            got = self.dispatch.get(p["name"])
            if got is None:
                return
            result, code = got
            if code:
                self.inbox.put(json.dumps({"jsonrpc": "2.0", "id": rid, "error": {"code": code, "message": "hermes says no"}}))
            else:
                self.reply(rid, result)
        elif m == "session.history":
            self.sent.append(frame)
            if self.history is None:
                self.inbox.put(json.dumps({"jsonrpc": "2.0", "id": rid, "error": {"code": 5000, "message": "boom"}}))
            else:
                self.reply(rid, {"count": len(self.history), "messages": self.history})
        elif m == "prompt.submit" and self.submit_error:
            self.sent.append(frame)
            self.inbox.put(json.dumps({"jsonrpc": "2.0", "id": rid, "error": {"code": 4009, "message": "busy"}}))
        elif m == "prompt.submit" and self.submit_status:
            self.sent.append(frame)
            self.reply(rid, {"status": self.submit_status})
        elif m == "session.title":
            self.sent.append(frame)
            if "title" in p:
                if self.title_error:
                    code, msg = self.title_error
                    self.inbox.put(json.dumps({"jsonrpc": "2.0", "id": rid, "error": {"code": code, "message": msg}}))
                    return
                self.title = p["title"]
                self.reply(rid, {"pending": self.title_pending, "title": p["title"]})
            else:
                self.reply(rid, {"title": self.title, "session_key": "stored-key-1"})
        elif m == "session.control":
            self.sent.append(frame)
            if self.control_error:
                code, msg = self.control_error
                self.inbox.put(json.dumps({"jsonrpc": "2.0", "id": rid, "error": {"code": code, "message": msg}}))
                return
            self.reply(rid, {"control": {}, "dispatch": {"type": "exec", "output": f"done {p['action']}"}})
        elif m == "prompt.btw":
            self.sent.append(frame)
            self.btw_n += 1
            self.reply(rid, {"task_id": f"btw_{self.btw_n}"})
        elif m == "session.control.read":
            self.sent.append(frame)
            if self.control is None:
                self.inbox.put(json.dumps({"jsonrpc": "2.0", "id": rid, "error": {"code": -32601, "message": "no method"}}))
            else:
                self.reply(rid, {"control": self.control})
        else:
            super().send(data)

    def methods(self):
        return [f["method"] for f in self.sent]

    def dispatched(self):
        return [f["params"]["name"] for f in self.sent if f["method"] == "command.dispatch"]


class PickTest(unittest.TestCase):
    def test_allowed_only_and_desktop_or_quick_command_collisions_are_removed(self):
        meta = dict(META)
        meta["/plan"] = {"desktop": "advanced"}                 # Hermes 판이 바뀌어 desktop 제약이 생긴 명령
        del meta["/usage"]                                    # 이 판에 없는 명령
        got = cc.pick({"commands": meta, "categories": [{"name": "User commands", "pairs": [["/retry", "exec: rm -rf"]]}]})
        self.assertEqual(got["commands"], ["help", "status", "context", "undo", "compress", "queue", "steer",
                                           "learn", "memory", "review", "refine", "goal", "loop", "title", "subgoal", "btw"])
        self.assertEqual(got["blocked"], ["/retry"])         # 빠른 명령과 이름이 같다(R9)
        # 목록을 못 읽어도 AAS 가 만드는 help 와 전용 RPC 명령(3단계)은 남는다 — catalog 의 desktop 값·이름 겹침과 관계없다
        self.assertEqual(cc.pick(None), {"commands": ["help", "title", "subgoal", "btw"], "blocked": [], "plugins": [], "known": [], "aliases": {}})

    def test_plugin_commands_are_listed_to_show_but_never_known_as_commands(self):
        meta = dict(META, **{"/작업": {"argument_mode": "text", "desktop": None}, "/ping": {"argument_mode": None, "desktop": None}})
        cat = {"commands": meta, "categories": [
            {"name": "Plugin commands", "pairs": [["/작업", "작업 페이지 1장"], ["/ping", "plugin"]]},
            {"name": "User commands", "pairs": [["/deploy", "exec: ./deploy.sh"]]}]}
        got = skill_commands.parse(cat)
        self.assertEqual(got["plugins"], [{"command": "/작업", "name": "작업", "description": "작업 페이지 1장", "hint": "<내용>"},
                                          {"command": "/ping", "name": "ping", "description": "plugin", "hint": ""}])
        v = cc.view(got, allowed=False)                       # 명령 권한이 없어도 보인다 — 글로 보내고 플러그인이 처리한다
        self.assertEqual([r["command"] for r in v["plugin_commands"]], ["/작업", "/ping"])
        # 화면이 명령으로 막거나 dispatch 하지 않게 알아보는 이름에는 넣지 않는다(R9). 빠른 명령은 어디에도 없다
        self.assertNotIn("/작업", v["command_names"])
        self.assertNotIn("/deploy", [r["command"] for r in v["plugin_commands"]])

    def test_parse_carries_commands_next_to_skills(self):
        out = skill_commands.parse(CATALOG)
        self.assertEqual(out["commands"], list(cc.NAMES))
        self.assertEqual([r["command"] for r in out["skills"]], ["/요약"])

    def test_view_gives_names_to_everyone_but_commands_only_when_allowed(self):
        got = skill_commands.parse(CATALOG)
        mine = cc.view(got)
        self.assertEqual(len(mine["commands"]), 19)
        self.assertEqual(mine["commands"][9]["hint"] != "", True)                          # steer 는 인자 모양이 있다
        self.assertTrue(next(r for r in mine["commands"] if r["name"] == "steer")["required"])
        other = cc.view(got, allowed=False)
        self.assertEqual((other["commands"], other["commands_allowed"]), ([], False))
        self.assertEqual(len(other["command_names"]), 20)                                   # 친 명령을 알아보는 데 쓴다(DC5)

    def test_help_lists_allowed_commands_and_skills_only(self):
        text = cc.help_text(skill_commands.parse(CATALOG))
        self.assertIn("/steer", text)
        self.assertIn("/요약", text)
        self.assertNotIn("/model", text)

    def test_normalize(self):
        with self.assertRaises(cc.CommandError) as e:
            cc.normalize("model", "")
        self.assertEqual(e.exception.code, "unknown")
        for name, arg in (("steer", ""), ("queue", "  "), ("undo", "two")):
            with self.assertRaises(cc.CommandError) as e:
                cc.normalize(name, arg)
            self.assertEqual(e.exception.code, "usage", name)
        self.assertEqual(cc.normalize("/UNDO", " 2 "), ("undo", "2"))


class RunTest(unittest.TestCase):
    def setUp(self):
        skill_commands.forget()
        self.ws = CmdWS("yj")
        self.hub = ChatHub(SETTINGS, connect=lambda: self.ws, reconnect_delays=())
        self.ws.script = lambda sid, text: []                  # 답을 끝내지 않는다 — 끝 이벤트는 시험이 넣는다
        self.sid = self.hub.create_session("ma")["session_id"]

    def tearDown(self):
        self.ws.inbox.put(None)

    def events(self, kind=None):
        return [e for e in self.hub.events_after(self.sid, 0, wait=0) if kind is None or e["type"] == kind]

    def finish_turn(self, status="complete"):
        self.ws.inbox.put(json.dumps({"method": "event", "params": {"type": "message.complete", "session_id": self.sid,
                                                                    "payload": {"text": "답", "status": status}}}))
        end = time.time() + 3
        while self.hub.running(self.sid) and time.time() < end:
            time.sleep(0.01)

    def wait_for(self, pred, timeout=3.0):
        end = time.time() + timeout
        while time.time() < end:
            if pred():
                return True
            time.sleep(0.01)
        return False

    def test_status_uses_slash_exec_and_usage_drops_its_argument(self):
        out = cc.run(self.hub, self.sid, "status")
        self.assertEqual(out, {"kind": "output", "command": "/status", "text": "out /status"})
        cc.run(self.hub, self.sid, "usage", "reset")         # reset 은 Codex 한도를 쓴다 — 넘기지 않는다
        cc.run(self.hub, self.sid, "context", "all")
        cmds = [f["params"]["command"] for f in self.ws.sent if f["method"] == "slash.exec"]
        self.assertEqual(cmds, ["/status", "/usage", "/context all"])

    def test_help_is_built_by_aas_and_never_calls_hermes_commands(self):
        out = cc.run(self.hub, self.sid, "help")
        self.assertEqual(out["kind"], "output")
        self.assertNotIn("slash.exec", self.ws.methods())
        self.assertEqual(self.ws.dispatched(), [])

    def test_unknown_names_never_reach_hermes(self):
        for name in ("model", "yolo", "whoami"):
            with self.assertRaises(cc.CommandError):
                cc.run(self.hub, self.sid, name)
        self.assertNotIn("slash.exec", self.ws.methods())
        self.assertEqual(self.ws.dispatched(), [])

    def test_quick_command_collision_and_catalog_failure_do_not_run(self):
        self.ws.catalog = {**CATALOG, "categories": [{"name": "User commands", "pairs": [["/plan", "exec: ./x.sh"]]}]}
        with self.assertRaises(cc.CommandError) as e:
            cc.run(self.hub, self.sid, "plan", "할 일")
        self.assertEqual(e.exception.code, "collision")
        self.ws.catalog = None
        old = skill_commands.CATALOG_TIMEOUT
        skill_commands.CATALOG_TIMEOUT = 0.2
        try:
            with self.assertRaises(cc.CommandError) as e:
                cc.run(self.hub, self.sid, "status")
            self.assertEqual(e.exception.code, "catalog")
        finally:
            skill_commands.CATALOG_TIMEOUT = old
        self.assertEqual(self.ws.dispatched(), [])
        self.assertNotIn("slash.exec", self.ws.methods())

    def test_plan_sends_hermes_text_and_shows_what_was_typed(self):
        self.assertEqual(cc.run(self.hub, self.sid, "plan", "배포 정리"), {"kind": "sent"})
        self.assertEqual(self.ws.prompts()[-1], "PLAN PROMPT task")
        self.assertEqual(self.events("aas.user")[-1]["payload"]["text"], "/plan 배포 정리")

    def test_retry_replaces_the_buffer_then_resends_the_original_question(self):
        self.hub.send(self.sid, "첫 질문")
        self.finish_turn()
        before = self.hub.seq(self.sid)
        self.assertEqual(cc.run(self.hub, self.sid, "retry"), {"kind": "sent", "retry": True})
        evs = self.events()
        self.assertEqual([e["type"] for e in evs], ["aas.history", "aas.user"])         # 버퍼는 기록 하나로 바뀌었다(R2)
        self.assertGreater(evs[0]["seq"], before)                                       # 번호는 이어진다 — 열린 화면이 받는다
        self.assertEqual(evs[0]["payload"]["rewound"], "retry")
        self.assertEqual([m["role"] for m in evs[0]["payload"]["messages"]], ["user", "assistant", "tool"])
        self.assertNotIn("args", evs[0]["payload"]["messages"][2])                      # 다시 열기와 같은 손보기(9-8)
        self.assertEqual(evs[1]["payload"]["text"], "첫 질문")
        self.assertTrue(evs[1]["payload"]["retry"])
        self.assertEqual(self.ws.prompts()[-1], "첫 질문")

    def test_plan_turns_show_as_the_typed_command_on_retry_and_in_rewound_history(self):
        """Hermes 는 /plan 이 만든 계획 프롬프트 전체를 사용자 말로 저장한다. retry·되감기·다시 열기에서 그 영어 프롬프트가
        말풍선에 보였다(OKE 2026-10-27 화면 확인) — 「/plan 할 일」로 되돌린다. Hermes 로는 프롬프트 그대로 보낸다."""
        from tests.test_chat_commands import PLAN_PROMPT
        self.ws.dispatch["retry"] = ({"type": "send", "message": PLAN_PROMPT}, None)
        self.ws.history = [{"role": "user", "text": PLAN_PROMPT}, {"role": "assistant", "text": "계획"}]
        self.assertEqual(cc.run(self.hub, self.sid, "retry"), {"kind": "sent", "retry": True})
        self.assertEqual(self.events("aas.user")[-1]["payload"]["text"], "/plan 배포 정리")
        self.assertEqual(self.ws.prompts()[-1], PLAN_PROMPT)
        self.assertEqual(self.events("aas.history")[-1]["payload"]["messages"][0]["text"], "/plan 배포 정리")
        self.assertEqual(cc.shown("[/plan — plan mode]\n\nrules\nNo explicit task was given with /plan — infer"), "/plan")
        self.assertEqual(cc.shown("그냥 말"), "그냥 말")
        self.ws.dispatch["undo"] = ({"type": "prefill", "message": PLAN_PROMPT, "notice": "↶ Undid 1 turn"}, None)
        self.finish_turn()
        self.assertEqual(cc.run(self.hub, self.sid, "undo"), {"kind": "prefill", "text": "/plan 배포 정리"})

    def test_retry_send_failure_returns_the_question_for_the_composer(self):
        self.ws.submit_error = True
        self.assertEqual(cc.run(self.hub, self.sid, "retry"), {"kind": "retry_failed", "text": "첫 질문"})

    def test_history_failure_keeps_the_buffer_and_says_so(self):
        self.hub.send(self.sid, "첫 질문")
        self.finish_turn()
        n = len(self.events())
        self.ws.history = None
        self.assertEqual(cc.run(self.hub, self.sid, "undo"), {"kind": "prefill", "text": "첫 질문"})
        evs = self.events()
        self.assertEqual(len(evs), n + 1)
        self.assertEqual(evs[-1]["payload"], {"code": "rewind_failed"})

    def test_undo_rewinds_with_the_number_of_turns_and_prefills(self):
        self.assertEqual(cc.run(self.hub, self.sid, "undo", "2"), {"kind": "prefill", "text": "첫 질문"})
        hist = self.events("aas.history")
        self.assertEqual((hist[-1]["payload"]["rewound"], hist[-1]["payload"]["turns"]), ("undo", 2))

    def test_compress_waits_180_seconds_and_blocks_sending_meanwhile(self):
        self.ws.dispatch["compress"] = None                    # 답하지 않는다
        old = cc.COMPRESS_TIMEOUT
        cc.COMPRESS_TIMEOUT = 0.3
        try:
            import threading
            box = {}
            t = threading.Thread(target=lambda: box.setdefault("out", cc.run(self.hub, self.sid, "compress")))
            t.start()
            self.assertTrue(self.wait_for(lambda: self.events("aas.compress")))
            with self.assertRaises(SessionBusy):
                self.hub.send(self.sid, "그사이 말")
            with self.assertRaises(cc.CommandError) as e:
                cc.run(self.hub, self.sid, "status")
            self.assertEqual(e.exception.code, "busy")
            t.join(3)
        finally:
            cc.COMPRESS_TIMEOUT = old
        self.assertEqual(box["out"], {"kind": "compress_timeout"})
        self.assertEqual([e["payload"]["state"] for e in self.events("aas.compress")], ["start", "timeout"])
        self.hub.send(self.sid, "이제 됨")                   # 넘긴 뒤에는 막지 않는다(Hermes 가 바쁘면 Hermes 가 거절)

    def test_compress_result_is_a_card(self):
        self.assertEqual(cc.run(self.hub, self.sid, "compress")["text"], "Compressed: 12k → 3k tokens")
        self.assertEqual([e["payload"]["state"] for e in self.events("aas.compress")], ["start", "done"])

    def test_compress_dispatch_uses_the_long_limit(self):
        seen = {}
        real = self.hub.request

        def spy(method, params=None, timeout=60):
            if method == "command.dispatch":
                seen["timeout"] = timeout
            return real(method, params, timeout)
        self.hub.request = spy
        cc.run(self.hub, self.sid, "compress")
        self.assertEqual(seen["timeout"], cc.COMPRESS_TIMEOUT)
        self.assertEqual(cc.COMPRESS_TIMEOUT, 180)

    def test_hermes_refusals_become_sentences(self):
        for code, want in ((4009, "busy"), (4018, "empty"), (4001, "empty"), (5009, "failed")):
            self.ws.dispatch["retry"] = (None, code)
            with self.assertRaises(cc.CommandError) as e:
                cc.run(self.hub, self.sid, "retry")
            self.assertEqual(e.exception.code, want, code)

    def test_while_answering_only_steer_and_queue_go(self):
        self.hub.send(self.sid, "긴 일")
        with self.assertRaises(cc.CommandError) as e:
            cc.run(self.hub, self.sid, "retry")
        self.assertEqual(e.exception.code, "busy")
        self.assertEqual(self.ws.dispatched(), [])
        self.assertEqual(cc.run(self.hub, self.sid, "steer", "테스트도"), {"kind": "steered"})
        self.assertEqual(cc.run(self.hub, self.sid, "queue", "다음 말"), {"kind": "queued", "count": 1})
        self.assertNotIn("queue", self.ws.dispatched())                                 # 예약은 서버가 든다
        self.assertEqual(self.events("aas.queue")[-1]["payload"]["items"][0]["text"], "다음 말")
        n = len(self.ws.prompts())
        self.finish_turn()
        self.assertTrue(self.wait_for(lambda: len(self.ws.prompts()) == n + 1))
        self.assertEqual(self.ws.prompts()[-1], "다음 말")
        self.assertEqual(self.events("aas.user")[-1]["payload"]["text"], "다음 말")    # 말풍선은 글만(DC8)
        self.assertEqual(self.events("aas.queue")[-1]["payload"]["items"], [])

    def test_idle_steer_and_queue_are_normal_messages(self):
        self.ws.dispatch["steer"] = ({"type": "send", "message": "방향", "notice": "No agent running"}, None)
        self.assertEqual(cc.run(self.hub, self.sid, "steer", "방향"), {"kind": "sent"})
        self.assertEqual(self.events("aas.user")[-1]["payload"]["text"], "방향")

    def test_interrupt_holds_the_queue_and_send_now_releases_it(self):
        self.hub.send(self.sid, "긴 일")
        cc.run(self.hub, self.sid, "queue", "a")
        cc.run(self.hub, self.sid, "queue", "b")
        self.hub.interrupt(self.sid)
        n = len(self.ws.prompts())
        self.finish_turn()
        time.sleep(0.1)
        self.assertEqual(len(self.ws.prompts()), n)                                     # 멈춘 직후 예약이 저절로 나가지 않는다
        self.assertTrue(self.events("aas.queue")[-1]["payload"]["held"])
        first = self.events("aas.queue")[-1]["payload"]["items"][0]["id"]
        self.hub.queue_op(self.sid, "cancel", first)
        self.hub.queue_op(self.sid, "send")
        self.assertTrue(self.wait_for(lambda: len(self.ws.prompts()) == n + 1))
        self.assertEqual(self.ws.prompts()[-1], "b")

    def test_error_turn_does_not_drain_the_queue(self):
        self.hub.send(self.sid, "긴 일")
        cc.run(self.hub, self.sid, "queue", "a")
        n = len(self.ws.prompts())
        self.finish_turn(status="error")
        time.sleep(0.1)
        self.assertEqual(len(self.ws.prompts()), n)


class HermesPlanTextTest(unittest.TestCase):
    """`shown()` 이 Hermes 의 실제 /plan 글을 읽는지(OMAI-1498, 스펙 2026-10-27-001 R10).

    LiteLLM 가드레일 훅은 Hermes 빌드 때 /plan 글자를 대조하지만 AAS 쪽은 대조가 없어, Hermes 판을 올려 글자가
    바뀌면 말풍선에 영어 지시가 조용히 보인다. 픽스처는 Hermes 이미지 안에서 `build_plan_prompt` 로 만든 글이다.
    """

    FIXTURE = Path(__file__).resolve().parent / "fixtures" / "hermes_plan_prompt.json"
    # CI 컨테이너(/src/tests)에는 위 폴더가 셋이 없다 — 클래스를 만들 때 IndexError 로 이 파일 전체가 import 되지 않았다
    _UP = Path(__file__).resolve().parents
    DOCKERFILE = _UP[3] / "openmaru-cogentai" / "docker" / "Dockerfile.hermes" if len(_UP) > 3 else None

    def test_real_plan_prompt_shows_the_typed_command(self):
        data = json.loads(self.FIXTURE.read_text(encoding="utf-8"))
        for case in data["cases"]:
            with self.subTest(task=case["task"]):
                self.assertEqual(cc.shown(case["prompt"]), f"/plan {case['task']}".strip())

    def test_fixture_matches_the_hermes_ref_the_image_builds(self):
        """Hermes 판을 올리면 픽스처도 새 판에서 다시 만들어야 한다. 이미지 레포가 옆에 없으면 건너뛴다."""
        if self.DOCKERFILE is None or not self.DOCKERFILE.exists():
            self.skipTest("openmaru-cogentai 레포가 옆에 없다")
        ref = re.search(r"^ARG HERMES_REF=([0-9a-f]{40})$", self.DOCKERFILE.read_text(encoding="utf-8"), re.M)
        data = json.loads(self.FIXTURE.read_text(encoding="utf-8"))
        self.assertEqual(data["hermes_ref"], ref.group(1))


def event(ws, sid, etype, payload=None):
    ws.inbox.put(json.dumps({"method": "event", "params": {"type": etype, "session_id": sid, "payload": payload or {}}}))


class Phase2RulesTest(unittest.TestCase):
    """2단계 허용·권한·/loop 검사(스펙 2026-10-27-002 R1·R2·R11·R12)."""

    def test_init_and_moa_are_not_commands(self):
        for name in ("init", "moa"):
            with self.assertRaises(cc.CommandError) as e:
                cc.normalize(name, "")
            self.assertEqual(e.exception.code, "unknown")

    def test_loop_refuses_slash_contents_however_the_interval_is_written(self):
        for arg in ("1m /init", "every 5m /memory approve x", "30s /quick", "/moa 질문", "10m /요약 --times 2",
                    "--times 3 1h /plan x", "1h30m  /retry --until 끝"):
            with self.assertRaises(cc.CommandError, msg=arg) as e:
                cc.normalize("loop", arg)
            self.assertEqual(e.exception.code, "usage")
        self.assertEqual(cc.normalize("loop", "10m 서버 상태 확인해 줘"), ("loop", "10m 서버 상태 확인해 줘"))
        self.assertEqual(cc.normalize("loop", "pause"), ("loop", "pause"))
        with self.assertRaises(cc.CommandError):
            cc.normalize("loop", " ")

    def test_goal_loop_and_memory_writes_need_the_owner(self):
        for name, arg in (("goal", "끝내기"), ("goal", "pause"), ("loop", "10m 확인"), ("loop", "stop"),
                          ("memory", "approve m1"), ("memory", "reject m1"), ("memory", "approval off")):
            with self.assertRaises(cc.CommandError, msg=f"{name} {arg}") as e:
                cc.allowed_for(name, arg, manages=False)
            self.assertEqual(e.exception.code, "forbidden")
        cc.allowed_for("memory", "pending", manages=False)
        cc.allowed_for("memory", "", manages=False)
        cc.allowed_for("goal", "끝내기", manages=True)

    def test_lists_hide_owner_commands_and_office_drops_background_ones(self):
        got = skill_commands.parse(CATALOG)
        shared = {r["name"] for r in cc.view(got, manages=False)["commands"]}
        self.assertFalse({"goal", "loop"} & shared)
        self.assertIn("memory", shared)
        office = {r["name"] for r in cc.view(got, office=True)["commands"]}
        self.assertFalse({"review", "refine", "goal", "loop"} & office)
        self.assertEqual(len(cc.view(got, manages=False)["command_names"]), 20)   # 친 명령은 알아본다 — 모델에 글로 가지 않게(NAMES 19 + catalog 의 /model)
        self.assertNotIn("/goal", cc.help_text(got, cc.shown_names(got, manages=False)))


class Phase2RunTest(RunTest):
    """2단계 명령 실행과 Hermes 가 스스로 시작한 턴(스펙 2026-10-27-002 §4-1·R4·R5·R6·R8·R10)."""

    def setUp(self):
        super().setUp()
        self.ws.dispatch.update({
            "learn": ({"type": "send", "message": "LEARN PROMPT"}, None),
            "memory": ({"type": "exec", "output": "No pending memory writes."}, None),
            "goal": ({"type": "send", "message": "GOAL KICKOFF", "notice": "Goal set"}, None),
            "loop": ({"type": "exec", "output": "Loop scheduled every 10m"}, None),
        })

    def ev(self, etype, payload=None):
        event(self.ws, self.sid, etype, payload)

    def settle(self, kind, n):
        self.assertTrue(self.wait_for(lambda: len(self.events(kind)) >= n), kind)

    # ---- 명령 ----
    def test_learn_shows_the_typed_command_and_drops_the_skill_cache_after_the_turn(self):
        self.assertEqual(cc.run(self.hub, self.sid, "learn", "배포 절차"), {"kind": "sent"})
        self.assertEqual(self.ws.prompts()[-1], "LEARN PROMPT")
        self.assertEqual(self.events("aas.user")[-1]["payload"]["text"], "/learn 배포 절차")
        skill_commands._cache[(1, "x")] = (time.time(), {})
        self.finish_turn()
        self.assertTrue(self.wait_for(lambda: not skill_commands._cache))

    def test_memory_pending_is_a_card_and_writes_are_refused_for_shared_users(self):
        self.assertEqual(cc.run(self.hub, self.sid, "memory", "pending", manages=False)["text"], "No pending memory writes.")
        with self.assertRaises(cc.CommandError) as e:
            cc.run(self.hub, self.sid, "memory", "approve m1", manages=False)
        self.assertEqual(e.exception.code, "forbidden")
        self.assertEqual(self.ws.dispatched(), ["memory"])

    def test_review_runs_live_with_its_focus_and_says_it_runs_in_the_background(self):
        out = cc.run(self.hub, self.sid, "review", "보안")
        self.assertEqual(out, {"kind": "output", "command": "/review", "text": "out /review 보안", "background": True})
        self.hub.send(self.sid, "긴 일")
        with self.assertRaises(cc.CommandError) as e:                                   # Hermes 도 바쁘면 띄우지 않는다
            cc.run(self.hub, self.sid, "refine")
        self.assertEqual(e.exception.code, "busy")

    def test_goal_starts_a_turn_and_its_controls_go_while_answering(self):
        self.assertEqual(cc.run(self.hub, self.sid, "goal", "테스트 모두 통과"), {"kind": "sent"})
        self.assertEqual(self.events("aas.user")[-1]["payload"]["text"], "/goal 테스트 모두 통과")
        self.assertEqual(self.ws.prompts()[-1], "GOAL KICKOFF")
        self.ws.dispatch["goal"] = ({"type": "exec", "output": "Goal paused"}, None)
        self.assertEqual(cc.run(self.hub, self.sid, "goal", "pause")["text"], "Goal paused")   # 답하는 중에도(목표 줄 단추)
        with self.assertRaises(cc.CommandError) as e:
            cc.run(self.hub, self.sid, "goal", "다른 목표")
        self.assertEqual(e.exception.code, "busy")
        with self.assertRaises(cc.CommandError) as e:
            cc.run(self.hub, self.sid, "loop", "stop", manages=False)
        self.assertEqual(e.exception.code, "forbidden")

    def test_goal_resume_while_answering_is_a_card_not_a_second_turn(self):
        self.hub.send(self.sid, "긴 일")
        self.ws.dispatch["goal"] = ({"type": "send", "message": "CONTINUE", "notice": "Goal resumed", "display": "/goal resume"}, None)
        n = len(self.ws.prompts())
        self.assertEqual(cc.run(self.hub, self.sid, "goal", "resume"), {"kind": "output", "command": "/goal", "text": "Goal resumed"})
        self.assertEqual(len(self.ws.prompts()), n)

    # ---- Hermes 가 시작한 턴 ----
    def test_hermes_started_turn_is_busy_labelled_once_and_ends(self):
        self.ev("status.update", {"kind": "loop", "text": "↻ /loop wakeup #1 firing…"})
        self.ev("message.start")
        self.ev("message.start")                                                         # 같은 턴에 두 번 온다(OV2)
        self.settle("message.start", 1)
        self.assertTrue(self.wait_for(lambda: self.hub.running(self.sid)))
        time.sleep(0.05)
        self.assertEqual([e["payload"] for e in self.events("aas.turn.auto")], [{"reason": "loop"}])
        self.assertEqual(len(self.events("message.start")), 1)
        with self.assertRaises(cc.CommandError) as e:
            cc.run(self.hub, self.sid, "retry")
        self.assertEqual(e.exception.code, "busy")
        self.assertEqual(cc.run(self.hub, self.sid, "queue", "다음"), {"kind": "queued", "count": 1})
        self.finish_turn()                                                               # 끝나면 예약이 나간다
        self.assertTrue(self.wait_for(lambda: self.ws.prompts()[-1:] == ["다음"]))

    def test_my_turn_is_not_labelled_and_a_redirected_message_does_not_count(self):
        self.hub.send(self.sid, "내 말")
        self.ev("message.start")
        self.settle("message.start", 1)
        self.finish_turn()
        self.assertEqual(self.events("aas.turn.auto"), [])
        self.ws.submit_status = "redirected"                                             # 지금 턴에 들어갔다 — 새 턴이 아니다(OV3)
        self.hub.send(self.sid, "끼어든 말")
        self.ws.submit_status = None
        self.ev("message.start")
        self.settle("aas.turn.auto", 1)
        self.assertEqual(self.events("aas.turn.auto")[-1]["payload"], {"reason": "notice"})

    def test_error_without_start_does_not_leave_my_turn_count_behind(self):
        self.hub.send(self.sid, "거절될 말")
        self.ev("error", {"message": "rejected"})
        self.assertTrue(self.wait_for(lambda: not self.hub.running(self.sid)))
        self.ev("message.start")
        self.settle("aas.turn.auto", 1)

    def test_goal_judge_text_after_my_turn_does_not_label_a_notice_turn(self):
        self.ev("session.control.update", {"control": {"goal": {"title": "g", "status": "done", "turns_used": 3, "max_turns": 20}}})
        self.ev("status.update", {"kind": "goal", "text": "Goal achieved"})
        self.ev("message.start")
        self.settle("aas.turn.auto", 1)
        self.assertEqual(self.events("aas.turn.auto")[-1]["payload"], {"reason": "notice"})
        self.finish_turn()
        self.ev("session.control.update", {"control": {"goal": {"title": "g", "status": "active", "turns_used": 4, "max_turns": 20}}})
        self.ev("status.update", {"kind": "goal", "text": "Continuing"})
        self.ev("message.start")
        self.settle("aas.turn.auto", 2)
        self.assertEqual(self.events("aas.turn.auto")[-1]["payload"], {"reason": "goal"})

    # ---- 예약을 Hermes 대기열에 넘김(R5·OV4) ----
    def test_queued_message_is_handed_to_hermes_and_leaves_the_list_when_it_starts(self):
        self.hub.send(self.sid, "긴 일")
        self.ev("message.start")
        cc.run(self.hub, self.sid, "queue", "다음 말")
        self.ws.submit_status = "queued"                                                 # Hermes 가 goal 판정 중이라 대기열에 넣었다
        n = len(self.ws.prompts())
        self.finish_turn()
        self.assertTrue(self.wait_for(lambda: len(self.ws.prompts()) == n + 1))
        submit = [f for f in self.ws.sent if f["method"] == "prompt.submit"][-1]
        self.assertTrue(submit["params"]["queued"])
        self.assertTrue(self.wait_for(lambda: self.events("aas.queue")[-1]["payload"]["items"] == [{"id": self.hub.sessions[self.sid]["queue"][0]["id"], "text": "다음 말", "hermes": True}]))
        self.hub.queue_op(self.sid, "drop")                                              # 넘긴 예약은 지울 수 없다
        self.assertEqual(len(self.hub.sessions[self.sid]["queue"]), 1)
        self.ev("message.start")                                                         # Hermes 가 대기열의 내 말을 시작했다
        self.assertTrue(self.wait_for(lambda: self.events("aas.queue")[-1]["payload"]["items"] == []))
        self.assertEqual(self.events("aas.turn.auto"), [])

    def test_stop_returns_handed_messages_to_held_and_shows_the_rest(self):
        self.ev("session.control.update", {"control": {"loop": {"prompt": "확인", "status": "active", "ticks_fired": 1}}})
        self.settle("aas.control", 1)
        self.hub.send(self.sid, "긴 일")
        cc.run(self.hub, self.sid, "queue", "다음 말")
        self.ws.submit_status = "queued"
        self.finish_turn()
        self.assertTrue(self.wait_for(lambda: (self.hub.sessions[self.sid].get("queue") or [{}])[0].get("hermes")))
        self.hub.interrupt(self.sid)
        q = self.events("aas.queue")[-1]["payload"]
        self.assertEqual((q["held"], q["items"][0].get("hermes")), (True, None))
        self.assertTrue(self.events("aas.control")[-1]["payload"]["resting"])
        self.ws.submit_status = None
        self.hub.send(self.sid, "다시 시작")
        self.assertFalse(self.events("aas.control")[-1]["payload"]["resting"])

    # ---- 목표·반복 상태(R6·OV5) ----
    def test_control_keeps_only_the_last_summary_and_survives_a_rewind(self):
        for n in (1, 2):
            self.ev("session.control.update", {"control": {"goal": {"title": "g", "status": "active", "turns_used": n, "max_turns": 20},
                                                           "loop": None, "heartbeat": {"status": "active"}, "revision": str(n)}})
        self.assertTrue(self.wait_for(lambda: self.events("aas.control") and self.events("aas.control")[-1]["payload"]["goal"]["turns_used"] == 2))
        self.assertEqual(len(self.events("aas.control")), 1)
        self.assertEqual(set(self.events("aas.control")[0]["payload"]), {"goal", "loop", "heartbeat", "resting"})   # 3단계부터 heartbeat 도(R3)
        self.assertEqual(self.events("session.control.update"), [])
        cc.run(self.hub, self.sid, "undo")
        self.assertEqual([e["type"] for e in self.events()], ["aas.history", "aas.control"])

    def test_chat_list_shows_live_goal_and_loop(self):
        self.hub.sessions[self.sid]["stored_id"] = "st-1"
        self.ev("session.control.update", {"control": {"goal": {"title": "g", "status": "active", "turns_used": 3, "max_turns": 20},
                                                       "loop": {"status": "paused", "prompt": "x"}}})
        self.settle("aas.control", 1)
        real = self.hub.request
        self.hub.request = lambda m, p=None, timeout=60: {"sessions": [{"id": "st-1"}, {"id": "st-2"}]} if m == "session.list" else real(m, p, timeout)
        rows = self.hub.history("ma")
        self.assertEqual(rows[0]["control"], {"goal": {"status": "active", "turns_used": 3, "max_turns": 20}, "loop": {"status": "paused"}})
        self.assertIsNone(rows[1]["control"])

    def test_reopened_history_turns_hermes_started_prompts_into_auto_lines(self):
        """Hermes 는 목표 이어 하기·반복 차례·위임 결과 프롬프트를 사용자 말로 저장한다 — 다시 열면 영어 지시가 사용자 말풍선으로
        보였다(OKE 2026-10-27). 실시간 화면과 같은 까닭 줄로 바꾸고, 제목은 사람이 친 첫 말에서 뽑는다."""
        self.ws.history = [
            {"role": "user", "text": "/goal 1 2 3", "timestamp": 1},
            {"role": "assistant", "text": "1"},
            {"role": "user", "text": "[Continuing toward your standing goal]\nGoal: 1 2 3\n\nContinue working", "timestamp": 2},
            {"role": "assistant", "text": "2"},
            {"role": "user", "text": "[/loop wakeup #1, every 10m]\nRecurring task: x"},
            {"role": "user", "text": "[ASYNC DELEGATION BATCH COMPLETE — deleg_1]\n[USER] ..."},
            {"role": "user", "text": "[IMPORTANT: Background process p1 exited (exit code 0).\n"},
            {"role": "user", "text": "[Heartbeat — recurring instruction, fires every 5m]\nping"},
            {"role": "user", "text": "[메모] 사람이 친 대괄호 말"},
        ]
        cc.run(self.hub, self.sid, "undo")
        rows = self.events("aas.history")[-1]["payload"]["messages"]
        self.assertEqual([(r["role"], r.get("reason") or r.get("text")) for r in rows],
                         [("user", "/goal 1 2 3"), ("assistant", "1"), ("auto", "goal"), ("assistant", "2"), ("auto", "loop"),
                          ("auto", "process"), ("auto", "process"), ("auto", "heartbeat"), ("user", "[메모] 사람이 친 대괄호 말")])
        self.assertEqual(rows[2]["timestamp"], 2)

    def test_chat_list_preview_of_a_plan_chat_shows_the_typed_command(self):
        """지난 대화 목록의 미리보기는 Hermes 가 저장한 첫 사용자 말이다 — /plan 대화는 영어 계획 프롬프트가 보였다(OKE 2026-10-27)."""
        real = self.hub.request
        rows = [{"id": "p1", "title": "", "preview": PLAN_PROMPT[:200]}, {"id": "p2", "title": "보통", "preview": "그냥 말"}]
        self.hub.request = lambda m, p=None, timeout=60: {"sessions": rows} if m == "session.list" else real(m, p, timeout)
        got = self.hub.history("ma")
        self.assertEqual([(r["title"], r["preview"]) for r in got], [("/plan 배포 정리", "/plan 배포 정리"), ("보통", "그냥 말")])
        rows[0]["preview"] = PLAN_PROMPT[:60]                                             # 할 일 앞에서 잘린 미리보기
        self.assertEqual(self.hub.history("ma")[0]["preview"], "/plan")

    def test_reopened_chat_reads_its_goal_and_keeps_hermes_busy_state(self):
        self.ws.control = {"goal": None, "loop": {"status": "active", "prompt": "확인", "next_due_at": 1}, "heartbeat": None}
        real_send = self.ws.send

        def send(data):
            frame = json.loads(data)
            if frame["method"] == "session.resume":
                self.ws.sent.append(frame)
                self.ws.reply(frame["id"], {"session_id": "r-1", "messages": [], "running": True})
                return
            real_send(data)
        self.ws.send = send
        out = self.hub.resume("ma", "st-9")
        self.assertTrue(self.hub.running(out["session_id"]))
        evs = lambda: [e for e in self.hub.events_after("r-1", 0, wait=0) if e["type"] == "aas.control"]   # noqa: E731 — 뒤에서 읽는다
        self.assertTrue(self.wait_for(evs))
        self.assertEqual(evs()[-1]["payload"]["loop"]["status"], "active")
        self.ws.control = None                                                           # 이 요청이 없는 Hermes — 조용히 넘어간다
        self.hub.resume("ma", "st-10")

    # ---- 긴 대화 버퍼 줄이기(R10) ----
    def test_a_full_buffer_is_compacted_into_history_after_a_turn(self):
        from aas.hermes import hermes_chat
        old = hermes_chat.COMPACT_AT
        hermes_chat.COMPACT_AT = 10
        try:
            self.ev("session.control.update", {"control": {"loop": {"status": "active", "prompt": "x"}}})
            self.hub.send(self.sid, "첫 질문")
            self.ev("message.start")
            for i in range(12):
                self.ev("message.delta", {"text": str(i)})
            self.finish_turn()
            self.assertTrue(self.wait_for(lambda: self.events()[0]["type"] == "aas.history"))
            evs = self.events()
            self.assertTrue(evs[0]["payload"]["compacted"])
            self.assertEqual([e["type"] for e in evs], ["aas.history", "aas.control"])       # 목표·반복 줄은 뒤에 새로
            self.assertEqual([e["seq"] for e in evs], sorted(e["seq"] for e in evs))
        finally:
            hermes_chat.COMPACT_AT = old



class Phase3Test(RunTest):
    """3단계 명령(스펙 2026-10-27-004) — worker 없이 전용 RPC."""

    def ev(self, etype, payload=None):
        event(self.ws, self.sid, etype, payload)

    def test_known_names_cover_every_builtin_and_aliases_but_not_quick_or_plugin(self):
        cat = {**CATALOG, "commands": {**META, "/version": {"desktop": None}, "/q": {"desktop": None}, "/deploy": {"desktop": None}},
               "canon": {"/q": "/queue", "/queue": "/queue", "/deploy": "/deploy", "/bp": "/blueprint"},
               "categories": [{"name": "Session", "pairs": [["/logs", "Logs"], ["/status", "s"]]},
                              {"name": "Plugin commands", "pairs": [["/deploy", "plugin"]]}]}
        got = skill_commands.parse(cat)
        view = cc.view(got)
        names = set(view["command_names"])
        self.assertTrue({"/version", "/logs", "/q", "/init", "/btw"} - {"/init"} <= names)
        self.assertNotIn("/deploy", names)                                              # 플러그인 명령은 막지 않는다(1단계 R9)
        self.assertEqual(view["command_aliases"], {"/q": "queue"})                      # /bp 는 허용 명령의 별칭이 아니다
        self.assertEqual(cc.view(got, manages=False)["owner_only"], ["/goal", "/loop", "/subgoal", "/title"])
        self.assertEqual(cc.view(got)["owner_only"], [])
        self.assertNotIn("heartbeat", [r["name"] for r in view["commands"]])           # 단추 전용 — 목록에 없다

    def test_title_sets_reads_back_the_stored_key_and_updates_the_header(self):
        meta = self.hub.sessions[self.sid]
        meta.pop("stored_id", None)
        out = cc.run(self.hub, self.sid, "title", "배포 정리")
        self.assertEqual((out["kind"], "stored_key" in out), ("output", False))
        self.assertIn("배포 정리", out["text"])
        self.assertEqual(meta["stored_id"], "stored-key-1")                             # 첫 말 전이면 자동 제목 이벤트가 오지 않는다(OV1)
        self.assertEqual(self.events("aas.title")[-1]["payload"], {"title": "배포 정리"})
        self.assertEqual(cc.run(self.hub, self.sid, "title")["text"], "배포 정리")       # 빈 인자는 읽기
        self.ws.title_pending = True
        self.assertIn("첫 말을 보낸 뒤", cc.run(self.hub, self.sid, "title", "다른 제목")["text"])

    def test_title_limits_and_hermes_refusals_are_sentences(self):
        with self.assertRaises(cc.CommandError) as e:
            cc.run(self.hub, self.sid, "title", "가" * 101)
        self.assertEqual(e.exception.code, "usage")
        self.ws.title_error = (4022, "Title 'x' is already in use by session abc")
        with self.assertRaises(cc.CommandError) as e:
            cc.run(self.hub, self.sid, "title", "x")
        self.assertIn("같은 제목", e.exception.text)
        with self.assertRaises(cc.CommandError) as e:
            cc.run(self.hub, self.sid, "title", "x", manages=False)
        self.assertEqual(e.exception.code, "forbidden")

    def test_subgoal_reads_the_nested_dispatch_and_splits_4004(self):
        self.assertEqual(cc.run(self.hub, self.sid, "subgoal", "시험도 통과")["text"], "done subgoal.add")
        sent = [f["params"] for f in self.ws.sent if f["method"] == "session.control"]
        self.assertEqual(sent[-1], {"session_id": self.sid, "action": "subgoal.add", "args": {"text": "시험도 통과"}})
        cc.run(self.hub, self.sid, "subgoal", "remove 2")
        self.assertEqual(self.ws.sent[-1]["params"]["args"], {"index": 2})
        cc.run(self.hub, self.sid, "subgoal", "clear")
        self.assertEqual(self.ws.sent[-1]["params"]["action"], "subgoal.clear")
        with self.assertRaises(cc.CommandError) as e:
            cc.run(self.hub, self.sid, "subgoal", "remove two")
        self.assertEqual(e.exception.code, "usage")
        for msg, want in (("no active goal", "진행 중인 목표가 없습니다"), ("index out of range (1..1)", "그 번호의 조건이 없습니다")):
            self.ws.control_error = (4004, msg)
            with self.assertRaises(cc.CommandError) as e:
                cc.run(self.hub, self.sid, "subgoal", "x")
            self.assertIn(want, e.exception.text)
        self.ws.control_error = None
        self.ws.control = {"goal": {"status": "active", "subgoals": ["a", "b"]}}
        self.assertEqual(cc.run(self.hub, self.sid, "subgoal")["text"], "1. a\n2. b")

    def test_btw_answer_waits_for_the_turn_end_and_failures_show(self):
        self.hub.send(self.sid, "긴 일")
        self.ev("message.start")
        self.settle = lambda k, n: self.assertTrue(self.wait_for(lambda: len(self.events(k)) >= n), k)
        self.assertEqual(cc.run(self.hub, self.sid, "btw", "지금 몇 시?"), {"kind": "btw_pending", "count": 1})   # 답하는 중에도
        self.assertEqual(self.ws.sent[-1]["params"], {"session_id": self.sid, "text": "지금 몇 시?"})
        self.ev("message.delta", {"text": "작업 중"})
        self.ev("btw.complete", {"task_id": "btw_1", "question": "지금 몇 시?", "text": "3시"})
        self.settle("aas.btw_wait", 2)
        self.assertEqual(self.events("aas.btw"), [])                                     # 흐르는 답 가운데 끼지 않는다
        self.assertEqual(self.events("aas.btw_wait")[-1]["payload"], {"count": 0})
        self.finish_turn()
        self.settle("aas.btw", 1)
        types = [e["type"] for e in self.events()]
        self.assertLess(types.index("message.complete"), types.index("aas.btw"))
        self.assertEqual(self.events("aas.btw")[0]["payload"], {"question": "지금 몇 시?", "text": "3시"})
        cc.run(self.hub, self.sid, "btw", "다른 것")
        self.ev("btw.complete", {"task_id": "btw_2", "question": "다른 것", "text": "error: boom"})
        self.settle("aas.btw", 2)
        self.assertTrue(self.events("aas.btw")[-1]["payload"]["failed"])                # 쉬는 중이면 바로
        with self.assertRaises(cc.CommandError) as e:
            cc.run(self.hub, self.sid, "btw", " ")
        self.assertEqual(e.exception.code, "usage")

    def test_heartbeat_is_shown_controlled_by_buttons_only_and_rests_after_stop(self):
        self.ev("session.control.update", {"control": {"heartbeat": {"status": "active", "interval_seconds": 300, "prompt": "p"}}})
        self.assertTrue(self.wait_for(lambda: self.events("aas.control")))
        self.assertEqual(self.events("aas.control")[-1]["payload"]["heartbeat"]["interval_seconds"], 300)
        self.assertEqual(cc.run(self.hub, self.sid, "heartbeat", "pause")["text"], "done heartbeat.pause")
        for arg in ("", "every 5m 확인"):
            with self.assertRaises(cc.CommandError):
                cc.run(self.hub, self.sid, "heartbeat", arg)                             # 거는 길은 없다(worker)
        with self.assertRaises(cc.CommandError) as e:
            cc.run(self.hub, self.sid, "heartbeat", "clear", manages=False)
        self.assertEqual(e.exception.code, "forbidden")
        self.hub.send(self.sid, "긴 일")
        self.hub.interrupt(self.sid)
        self.assertTrue(self.events("aas.control")[-1]["payload"]["resting"])            # heartbeat 만 걸려 있어도 쉰다(OV5)

    def test_disconnect_drops_btw_waits_and_says_so(self):
        cc.run(self.hub, self.sid, "btw", "질문")
        self.ws.inbox.put(None)                                                          # 연결 끊김
        self.assertTrue(self.wait_for(lambda: any(e["payload"].get("lost") for e in self.events("aas.btw_wait"))))
        self.assertEqual(self.events("aas.btw_wait")[-1]["payload"], {"count": 0, "lost": 1})


if __name__ == "__main__":
    unittest.main()

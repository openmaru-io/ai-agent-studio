# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""대화 파일 올리기·내려받기(OMAI-1153, 스펙 2026-10-14-005).

- 작업 폴더 도우미·턴 전후 비교·첨부 안내 문구(기준 파일 ui/src/lib/attachNotice.fixture.json — 화면 이미지 빌드가 ui/ 만 보므로 거기 둔다)
- ChatHub: 새 대화 cwd(R4)·다시 연 대화 cwd.set(R13)·파일 없는 send 의 본문 그대로(R7)·aas.files(R5·R10)
- 실제 uvicorn + 실제 사이드카 + 가짜 Hermes 대시보드로 PUT·HEAD·GET·DELETE·목록(R1·R3·R8·R9·R15·R16)
"""
import aasserver  # 실제 uvicorn 앱을 띄우는 시험 하네스
import email.utils
import http.client
import http.server
import json
import os
import re
import shutil
import sys
import tempfile
import threading
import time
import unicodedata
import unittest
import urllib.parse
from pathlib import Path

TMP = tempfile.TemporaryDirectory()
os.environ.setdefault("AAS_DATA_DIR", str(Path(TMP.name) / "data"))

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "sidecar"))
from aas_sidecar import ops as sc_ops, server as sc_server  # noqa: E402

from aas.auth import auth  # noqa: E402
from aas.fleet import pods  # noqa: E402
from aas.hermes import attach_notice, workspace as wsp  # noqa: E402
from aas.hermes.hermes_chat import ChatHub  # noqa: E402
from aas.office import office_state  # noqa: E402
from aas.web import files as web_files, legacy, server  # noqa: E402
from test_chat import SETTINGS, FakeWS  # noqa: E402

TOKEN = "t0ken-for-tests-0123456789"
FIXTURE = Path(__file__).resolve().parent.parent / "ui" / "src" / "lib" / "attachNotice.fixture.json"


# ---- 도우미 ---------------------------------------------------------------------------------------
class StalledBrowserTest(unittest.TestCase):
    """멈춘 브라우저가 전송 자리(8개)를 오래 쥐지 않는다(스펙 2026-10-24-002 R11·D5). 올리는 중에 브라우저가 사라지면 본문 읽기에
    한도가 없어 자리와 용량 예약이 묶였고, 받지 않는 브라우저로 보내면 커널 재전송 한도(약 15분)까지 자리를 쥐었다."""

    def test_받지_않는_브라우저로_보내기는_한도_뒤에_끝나고_자리를_돌려준다(self):
        import anyio
        from unittest import mock
        from aas.web import files
        closed = []

        async def chunks():
            yield b"x" * 10

        async def send(message):
            if message["type"] == "http.response.body":
                await anyio.sleep(30)                         # 브라우저가 받지 않는다

        async def receive():
            await anyio.sleep(30)
            return {"type": "http.disconnect"}

        async def main():
            stream = files._SlotStream(chunks(), media_type="application/octet-stream", on_close=lambda: closed.append(1))
            with anyio.fail_after(5):
                await stream({"type": "http", "asgi": {"spec_version": "2.4"}}, receive, send)
        began = time.monotonic()
        with mock.patch.object(files, "STALL_WAIT", 0.3):
            anyio.run(main)
        self.assertLess(time.monotonic() - began, 2)
        self.assertEqual(closed, [1])

    def test_올리다_멈춘_브라우저는_한도_뒤에_중단된다(self):
        import anyio
        from unittest import mock
        from aas.web import files
        got = []

        class Req:
            async def stream(self):
                yield b"a" * 10
                await anyio.sleep(30)                         # 절반 보내고 멈춘다
                yield b"b" * 10

        def post(auth, boundary, length, body):
            try:
                for part in body:
                    got.append(len(part))
            except ConnectionAbortedError:
                return 502
            return 201
        began = time.monotonic()
        with mock.patch.object(files, "STALL_WAIT", 0.3), mock.patch.object(files, "_post_upload", side_effect=post):
            status = anyio.run(files._stream_to_hermes, Req(), None, "workspace/a.txt", 20)
        self.assertLess(time.monotonic() - began, 3)
        self.assertEqual(status, 499)


class HelperTest(unittest.TestCase):
    def test_clean_name_strips_separators_controls_and_long_names(self):
        self.assertEqual(wsp.clean_name("../a/b\\c\x00.txt"), "..abc.txt".strip("."))
        self.assertEqual(wsp.clean_name(""), "upload")
        self.assertEqual(wsp.clean_name("3분기 매출.xlsx"), "3분기 매출.xlsx")
        long = wsp.clean_name("가" * 120 + ".xlsx")
        self.assertLessEqual(len(long.encode()), 200)
        self.assertTrue(long.endswith(".xlsx"))

    def test_clean_name_turns_macos_decomposed_hangul_into_composed(self):
        """macOS 파일 이름은 자모가 풀린(NFD) 글자다. 모델은 경로를 완성형(NFC)으로 쓰므로 저장 이름을 NFC 로 맞춘다(OMAI-1153)."""
        nfd = unicodedata.normalize("NFD", "스크린샷 2026-08-26 18.02.57.png")
        self.assertNotEqual(nfd, "스크린샷 2026-08-26 18.02.57.png")
        self.assertEqual(wsp.clean_name(nfd), "스크린샷 2026-08-26 18.02.57.png")
        self.assertEqual(wsp.clean_name("e\u0301.txt"), "\u00e9.txt")                  # 라틴 결합 문자도 같은 규칙
        long = wsp.clean_name(unicodedata.normalize("NFD", "가" * 70) + ".xlsx")      # 자르기는 정규화한 뒤에 한다
        self.assertEqual(long, "가" * 65 + ".xlsx")      # 200바이트 - 확장자 5바이트 = 195바이트 = 65글자

    def test_paths_must_stay_inside_workspace(self):
        for ok in ("workspace/a.txt", "workspace/uploads/2026-10-14/a.txt"):
            self.assertTrue(wsp.in_workspace(ok), ok)
        for bad in ("state.db", "/opt/data/workspace/a", "workspace", "workspace/../state.db", "workspace//a", "workspace/./a"):
            self.assertFalse(wsp.in_workspace(bad), bad)
        self.assertTrue(wsp.in_uploads("workspace/uploads/d/a"))
        self.assertFalse(wsp.in_uploads("workspace/outputs/a"))

    def test_quota_default_and_env(self):
        old = os.environ.pop("AAS_WORKSPACE_QUOTA", None)
        try:
            self.assertEqual(wsp.quota(), 2 * 1024 ** 3)
            os.environ["AAS_WORKSPACE_QUOTA"] = "1000"
            self.assertEqual(wsp.quota(), 1000)
            os.environ["AAS_WORKSPACE_QUOTA"] = "x"
            self.assertEqual(wsp.quota(), 2 * 1024 ** 3)
        finally:
            os.environ.pop("AAS_WORKSPACE_QUOTA", None)
            if old is not None:
                os.environ["AAS_WORKSPACE_QUOTA"] = old

    def test_diff_orders_new_first_then_by_size_and_cuts(self):
        before = {"workspace/a.txt": (10, 1.0, 1), "workspace/b.txt": (5, 1.0, 1)}
        after = {"workspace/a.txt": (10, 1.0, 1), "workspace/b.txt": (6, 2.0, 1),
                 "workspace/small.csv": (1, 3.0, 1), "workspace/big.docx": (900, 3.0, 1), "workspace/hard": (4, 3.0, 2)}
        out = wsp.diff(before, after)
        self.assertEqual([f["path"] for f in out["files"]],
                         ["workspace/big.docx", "workspace/hard", "workspace/small.csv", "workspace/b.txt"])
        self.assertEqual([f["status"] for f in out["files"]], ["new", "new", "new", "modified"])
        self.assertEqual(out["files"][1]["downloadable"], False)          # 하드링크
        many = {f"workspace/f{i}": (i, 1.0, 1) for i in range(30)}
        cut = wsp.diff({}, many)
        self.assertEqual((len(cut["files"]), cut["total"]), (wsp.CHIP_LIMIT, 30))

    def test_diff_with_unknown_or_truncated_listing(self):
        self.assertIsNone(wsp.diff(None, {}))
        self.assertEqual(wsp.diff({"__truncated__": (0, 0, 0)}, {})["truncated"], True)

    def test_attach_notice_matches_the_shared_fixture(self):
        """서버(Python)와 화면(TS)이 같은 기준 파일로 문구를 만들고 읽는다(재검토 O-12)."""
        for case in json.loads(FIXTURE.read_text(encoding="utf-8"))["cases"]:
            with self.subTest(case["name"]):
                self.assertEqual(attach_notice.build(case["text"], case["files"], case.get("note", False)), case["built"])
                text, files = attach_notice.parse(case["built"])
                self.assertEqual({"text": text, "files": files}, case["parsed"])

    def test_attach_notice_reads_notices_joined_onto_one_line(self):
        """R7·F11: 다시 연 스킬 대화는 줄바꿈이 공백으로 합쳐진다. 끝에서부터 안내를 하나씩 떼어 낸다(같은 기준 파일)."""
        for case in json.loads(FIXTURE.read_text(encoding="utf-8"))["joined"]:
            with self.subTest(case["name"]):
                text, files = attach_notice.parse(case["text"])
                self.assertEqual({"text": text, "files": files}, case["parsed"])

    def test_attach_notice_picks_the_wording_by_path(self):
        """D2·F10: 주인이 올린 파일(uploads/ 중 회의 공유 폴더가 아닌 곳)만 「올렸습니다」, 그 밖은 「골랐습니다」."""
        up = attach_notice.line("a.txt", 1, "workspace/uploads/2026-10-20/a.txt")
        self.assertTrue(up.startswith("[사용자가 파일을 올렸습니다: "))
        for p in ("workspace/a.txt", "workspace/uploads/aas-shared/1/d/a.txt", "workspace/uploads/aas-shared-out/1/sa/d/a.txt",
                  "workspace/uploadsx/a.txt"):
            self.assertTrue(attach_notice.line("a.txt", 1, p).startswith("[사용자가 작업 폴더의 파일을 골랐습니다: "), p)
        self.assertTrue(wsp.own_upload("workspace/uploads/aas-sharedx/a.txt"))      # 이름이 비슷한 폴더는 주인 업로드
        self.assertFalse(wsp.own_upload("workspace/uploads/aas-shared"))


# ---- ChatHub ---------------------------------------------------------------------------------------
class FakeWorkspace:
    def __init__(self, ensure_ok=True):
        self.ensure_ok = ensure_ok
        self.snaps = [{"workspace/old.txt": (1, 1.0, 1)}, {"workspace/old.txt": (1, 1.0, 1), "workspace/report.docx": (48, 2.0, 1)}]

    def ensure(self, folder="workspace"):
        return self.ensure_ok

    def snapshot(self):
        return self.snaps.pop(0) if self.snaps else {}


class CwdWS(FakeWS):
    """session.cwd.set 에 답하고, prompt.submit 뒤에 message.complete 를 보낸다."""

    def __init__(self, cwd_error=False):
        super().__init__()
        self.cwd_error = cwd_error

    def send(self, data):
        frame = json.loads(data)
        if frame["method"] == "session.cwd.set":
            self.sent.append(frame)
            if self.cwd_error:
                self.inbox.put(json.dumps({"id": frame["id"], "error": {"code": 4017, "message": "no dir"}}))
            else:
                self.reply(frame["id"], {"cwd": frame["params"]["cwd"]})
            return
        if frame["method"] == "prompt.submit":
            self.sent.append(frame)
            self.reply(frame["id"], {"ok": True})
            self.inbox.put(json.dumps(self.ev("message.complete", {"text": "끝"})))
            return
        super().send(data)


class ChatHubFilesTest(unittest.TestCase):
    def make(self, ws=None, workspace=None):
        self.ws = ws or CwdWS()
        hub = ChatHub(SETTINGS, connect=lambda: self.ws, reconnect_delays=())
        hub.workspace = workspace
        self.addCleanup(self.ws.close)
        return hub

    def events(self, hub, want, tries=30):
        # 이미 쌓인 이벤트가 있으면 events_after 는 기다리지 않고 돌아온다 — 재시도 사이에 직접 기다린다(CI 에서 0초 만에 끝나 실패한 적이 있다)
        for _ in range(tries):
            ev = hub.events_after("s1", 0, wait=0.2)
            if want in [e["type"] for e in ev]:
                return ev
            time.sleep(0.2)
        return hub.events_after("s1", 0, wait=0)

    def test_new_chat_works_in_workspace_and_only_cwd_is_added(self):
        """R4 + R7: 바뀌는 인자는 cwd 하나뿐이다."""
        plain = self.make()
        plain.create_session("ma")
        base = dict(self.ws.sent[0]["params"])
        hub = self.make(workspace=FakeWorkspace())
        hub.create_session("ma")
        params = dict(self.ws.sent[0]["params"])
        self.assertEqual(params.pop("cwd"), "/opt/data/workspace")
        self.assertEqual(params, base)

    def test_new_chat_without_folder_falls_back_and_says_so(self):
        hub = self.make(workspace=FakeWorkspace(ensure_ok=False))
        hub.create_session("ma")
        self.assertNotIn("cwd", self.ws.sent[0]["params"])
        notices = [e["payload"] for e in hub.events_after("s1", 0, wait=1) if e["type"] == "aas.notice"]
        self.assertEqual(notices, [{"code": "cwd_fallback"}])

    def test_resumed_chat_moves_to_workspace_without_changing_resume_params(self):
        """R13 + R7: session.resume 인자는 그대로, 뒤따라 session.cwd.set."""
        plain = self.make()
        plain.resume("ma", "st1")
        base = dict(self.ws.sent[0]["params"])
        hub = self.make(workspace=FakeWorkspace())
        hub.resume("ma", "st1")
        self.assertEqual(self.ws.sent[0]["params"], base)
        self.assertEqual((self.ws.sent[1]["method"], self.ws.sent[1]["params"]["cwd"]), ("session.cwd.set", "/opt/data/workspace"))

    def test_resumed_chat_says_so_when_the_folder_cannot_move(self):
        hub = self.make(ws=CwdWS(cwd_error=True), workspace=FakeWorkspace())
        hub.resume("ma", "st1")
        ev = self.events(hub, "aas.notice")
        self.assertIn({"code": "cwd_unchanged"}, [e["payload"] for e in ev if e["type"] == "aas.notice"])

    def test_send_without_files_keeps_the_text_byte_for_byte(self):
        """R7 회귀 계약: 파일이 없으면 Hermes 로 가는 본문이 받은 글과 같다(작업 폴더가 있어도)."""
        hub = self.make(workspace=FakeWorkspace())
        hub.create_session("ma")
        text = "  두 줄\n글 [사용자가 파일을 올렸습니다: 흉내]  "
        hub.send("s1", text)
        submit = [f for f in self.ws.sent if f["method"] == "prompt.submit"][0]
        self.assertEqual(submit["params"]["text"], text)

    def test_send_with_files_appends_notice_and_reports_files_to_the_screen(self):
        hub = self.make(workspace=FakeWorkspace())
        hub.create_session("ma")
        f = {"name": "a.xlsx", "size": 1024, "path": "workspace/uploads/2026-10-14/a.xlsx"}
        hub.send("s1", "", files=[f])
        submit = [x for x in self.ws.sent if x["method"] == "prompt.submit"][0]
        self.assertEqual(submit["params"]["text"], attach_notice.build("", [f]))
        user = [e["payload"] for e in hub.events_after("s1", 0, wait=1) if e["type"] == "aas.user"][0]
        self.assertEqual(user, {"text": "", "turn": 1, "files": [f]})
        self.assertEqual(hub.sessions["s1"]["title"], "a.xlsx")             # 글 없이 파일만이면 첫 파일 이름

    def test_turn_end_reports_changed_files_with_the_turn_number(self):
        """R5·R10: 답이 끝나면 별도 스레드가 턴 전후 목록을 비교해 aas.files 를 보낸다."""
        hub = self.make(workspace=FakeWorkspace())
        hub.create_session("ma")
        hub.send("s1", "보고서 만들어 줘")
        ev = self.events(hub, "aas.files")
        files = [e["payload"] for e in ev if e["type"] == "aas.files"]
        self.assertEqual(len(files), 1)
        self.assertEqual((files[0]["turn"], [f["path"] for f in files[0]["files"]]), (1, ["workspace/report.docx"]))

    def test_slow_listing_skips_chips_but_still_sends(self):
        slow = FakeWorkspace()
        slow.snapshot = lambda: time.sleep(1) or {}
        hub = self.make(workspace=slow)
        hub.snapshot_timeout = 0.05
        hub.create_session("ma")
        hub.send("s1", "안녕")
        self.assertTrue(any(f["method"] == "prompt.submit" for f in self.ws.sent))
        time.sleep(0.3)
        self.assertNotIn("aas.files", [e["type"] for e in hub.events_after("s1", 0, wait=0)])

    def test_resumed_title_ignores_attach_notice(self):
        from aas.hermes.hermes_chat import _title_of
        f = {"name": "q.pdf", "size": 10, "path": "workspace/uploads/d/q.pdf"}
        self.assertEqual(_title_of(attach_notice.build("", [f])), "q.pdf")
        self.assertEqual(_title_of(attach_notice.build("요약\n둘째", [f])), "요약")


class SharedVolumeSkipTest(unittest.TestCase):
    """회의 공유 볼륨(aas-shared·aas-shared-out)은 uploads/ 아래에 붙으므로 채팅 용량·목록·턴 비교에 들어가지 않아야 한다."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        root = Path(self.tmp.name)
        up = root / "workspace" / "uploads"
        (up / "aas-shared" / "1" / "2026-10-15").mkdir(parents=True)
        (up / "aas-shared-out" / "1" / "sa" / "2026-10-15").mkdir(parents=True)
        (up / "aas-shared" / "1" / "2026-10-15" / "big.bin").write_bytes(b"x" * 1000)
        (up / "aas-shared-out" / "1" / "sa" / "2026-10-15" / "out.bin").write_bytes(b"y" * 500)
        (up / "mine.txt").write_bytes(b"z" * 7)
        (root / "workspace" / "a.txt").write_bytes(b"12345")
        (root / "workspace" / ".hidden").write_bytes(b"h")
        (root / "workspace" / "b.csv.upload").write_bytes(b"t")
        ops = sc_ops.Ops(root)

        class Backend:
            def scan(self, rel, skip_dirs=None):
                return ops.scan(rel, skip_dirs=skip_dirs)
        self.ws = wsp.Workspace(Backend(), None)

    def test_used_does_not_count_the_shared_volumes(self):
        self.assertEqual(self.ws.used(), 5 + 1 + 1 + 7)          # a.txt + .hidden + b.csv.upload + mine.txt, 공유 폴더 1500바이트는 빠진다

    def test_skip_dirs_names_the_shared_volumes(self):
        self.assertIn("aas-shared", wsp.SKIP_DIRS)
        self.assertIn("aas-shared-out", wsp.SKIP_DIRS)
        self.assertEqual(wsp.SHARED_IN_POD, "/opt/data/workspace/uploads/aas-shared")
        self.assertEqual(wsp.SHARED_OUT_POD, "/opt/data/workspace/uploads/aas-shared-out")

    def test_listing_and_snapshot_skip_dot_files_and_upload_temp_files(self):
        listed = self.ws.listing()
        main = [e["path"] for e in listed["entries"] if not e.get("shared")]
        self.assertIn("workspace/a.txt", main)
        self.assertNotIn("workspace/.hidden", main)
        self.assertNotIn("workspace/b.csv.upload", main)
        self.assertFalse(any(p.startswith(("workspace/uploads/aas-shared/", "workspace/uploads/aas-shared-out/")) for p in main), main)
        self.assertNotIn("workspace/uploads/aas-shared", main)             # 마운트 지점 폴더 줄은 공유 묶음이 대신한다
        self.assertNotIn("workspace/uploads/aas-shared-out", main)
        snap = self.ws.snapshot()
        self.assertEqual(sorted(snap), ["workspace/a.txt"])

    def test_plan_files_are_listed_and_noticed_but_other_dot_paths_stay_hidden(self):
        """/plan 이 쓴 계획 파일(작업 폴더의 .hermes/plans/, 스펙 2026-10-26-010 12-7)은 서랍·결과 칩에 보인다. 다른 점 경로는 그대로 숨긴다."""
        root = Path(self.tmp.name) / "workspace"
        (root / ".hermes" / "plans").mkdir(parents=True)
        (root / ".hermes" / "plans" / "2026-10-27_hello.md").write_text("# Plan")
        (root / ".hermes" / "state.json").write_text("{}")
        (root / ".hermes" / "plans" / ".draft").write_text("x")
        (root / ".hermes" / "plans" / "a.md.upload").write_text("x")
        main = [e["path"] for e in self.ws.listing()["entries"] if not e.get("shared")]
        self.assertIn("workspace/.hermes/plans/2026-10-27_hello.md", main)
        for p in ("workspace/.hermes/state.json", "workspace/.hermes/plans/.draft", "workspace/.hermes/plans/a.md.upload", "workspace/.hidden"):
            self.assertNotIn(p, main)
        self.assertIn("workspace/.hermes/plans/2026-10-27_hello.md", self.ws.snapshot())
        self.assertFalse(wsp.hidden("workspace/.hermes/plans/2026-10-27_hello.md"))     # 받기·첨부도 같은 규칙
        self.assertTrue(wsp.hidden("workspace/.hermes/plans/../.env"))

    def test_listing_drops_folders_with_no_file_under_them(self):
        """「에이전트가 만든 파일」에 빈 폴더 줄만 보이던 문제(OKE 2026-10-20): 에이전트가 workspace/workspace/uploads/aas-shared-out 처럼
        빈 폴더를 만들면 폴더 줄 셋이 떴다. 아래에 파일이 하나라도 있는 폴더만 남긴다."""
        root = Path(self.tmp.name) / "workspace"
        (root / "workspace" / "uploads" / "aas-shared-out").mkdir(parents=True)     # 이름이 SKIP_DIRS 라 안으로 들어가지 않는 빈 폴더
        (root / "empty").mkdir()
        (root / "report" / "img").mkdir(parents=True)
        (root / "report" / "img" / "a.png").write_bytes(b"p")
        dirs = sorted(e["path"] for e in self.ws.listing()["entries"] if e["kind"] == "dir")
        self.assertEqual(dirs, ["workspace/report", "workspace/report/img", "workspace/uploads"])

    def test_listing_keeps_every_folder_when_the_listing_is_cut(self):
        """목록이 잘리면 폴더 아래 파일이 빠졌을 수 있어 빈 폴더인지 알 수 없다 — 폴더 줄을 그대로 둔다."""
        (Path(self.tmp.name) / "workspace" / "empty").mkdir()
        real = self.ws.backend

        class Cut:
            def scan(self, rel, skip_dirs=None):
                out = real.scan(rel, skip_dirs)
                return out if rel in wsp.SHARED_DIRS else {**out, "truncated": True}
        dirs = [e["path"] for e in wsp.Workspace(Cut(), None).listing()["entries"] if e["kind"] == "dir"]
        self.assertIn("workspace/empty", dirs)

    def test_listing_adds_shared_files_with_their_own_total_and_room(self):
        """R10: 공유 폴더 안은 따로 읽어 shared 줄과 shared_used 를 준다. used(에이전트 한도)는 그대로."""
        (Path(self.tmp.name) / "workspace" / "uploads" / "aas-shared" / ".aas-shared").write_bytes(b"m")   # 표지 파일은 숨김
        out = self.ws.listing()
        shared = {e["path"]: e for e in out["entries"] if e.get("shared")}
        self.assertEqual(sorted(shared), ["workspace/uploads/aas-shared-out/1/sa/2026-10-15/out.bin",
                                          "workspace/uploads/aas-shared/1/2026-10-15/big.bin"])
        big = shared["workspace/uploads/aas-shared/1/2026-10-15/big.bin"]
        self.assertEqual((big["kind"], big["size"], big["downloadable"], big["room"]), ("file", 1000, True, 1))
        self.assertEqual((out["shared_used"], out["shared_truncated"]), (1500, False))
        self.assertEqual(out["used"], 5 + 1 + 1 + 7)                         # 공유 볼륨은 에이전트 한도 밖이라 used 는 그대로
        self.assertFalse(any(e.get("shared") for e in out["entries"] if e["kind"] == "dir"))

    def test_listing_marks_a_truncated_or_unreadable_shared_part_as_unknown(self):
        """공유 목록이 잘리거나 읽지 못하면 합계는 None(모름), 잘림은 따로 알린다 — 본 목록의 truncated 와 섞지 않는다."""
        real = self.ws.backend

        class Cut:
            def __init__(self, fail):
                self.fail = fail

            def scan(self, rel, skip_dirs=None):
                out = real.scan(rel, skip_dirs)
                if rel in wsp.SHARED_DIRS:
                    if self.fail:
                        raise OSError("sidecar down")
                    return {**out, "truncated": True}
                return out
        cut = wsp.Workspace(Cut(False), None).listing()
        self.assertEqual((cut["shared_used"], cut["shared_truncated"], cut["truncated"]), (None, True, False))
        down = wsp.Workspace(Cut(True), None).listing()
        self.assertEqual((down["shared_used"], down["shared_truncated"]), (None, False))
        self.assertEqual([e for e in down["entries"] if e.get("shared")], [])
        self.assertIn("workspace/a.txt", [e["path"] for e in down["entries"]])

    def test_listing_without_shared_volumes_has_an_empty_shared_part(self):
        import shutil
        for d in ("aas-shared", "aas-shared-out"):
            shutil.rmtree(Path(self.tmp.name) / "workspace" / "uploads" / d)
        out = self.ws.listing()
        self.assertEqual([e for e in out["entries"] if e.get("shared")], [])
        self.assertEqual((out["shared_used"], out["shared_truncated"]), (0, False))
        self.assertEqual(out["used"], 5 + 1 + 1 + 7)


class AttachedFilesTest(unittest.TestCase):
    """보낼 때 붙인 파일 검사(스펙 2026-10-20-002 D1·F3·R11): 작업 폴더 안 일반 파일이면 받는다."""

    class WS:
        def __init__(self, infos):
            self.infos = infos

        def check(self, path):
            return self.infos.get(path, {"exists": False})

    def run_with(self, infos, paths):
        from unittest import mock
        with mock.patch.object(server, "workspace_for", return_value=self.WS(infos)):
            return server._attached_files(None, paths)

    def test_any_plain_file_in_the_workspace_is_accepted(self):
        f = {"exists": True, "type": "file", "size": 4198}
        paths = ["workspace/report/summary.md", "workspace/uploads/2026-10-20/a.pdf", "workspace/uploads/aas-shared/3/d/회의록.md"]
        out = self.run_with({p: f for p in paths}, paths)
        self.assertEqual([(x["name"], x["size"], x["path"]) for x in out],
                         [("summary.md", 4198, paths[0]), ("a.pdf", 4198, paths[1]), ("회의록.md", 4198, paths[2])])

    def test_outside_hidden_link_dir_and_missing_are_refused_with_the_path(self):
        infos = {"workspace/link": {"exists": True, "link": True, "type": "file"},
                 "workspace/d": {"exists": True, "type": "dir"},
                 "workspace/.env": {"exists": True, "type": "file", "size": 1},
                 "workspace/a.csv.upload": {"exists": True, "type": "file", "size": 1}}
        for p, code in (("state.db", "outside"), ("workspace/../state.db", "outside"), ("workspace/.env", "outside"),
                        ("workspace/a.csv.upload", "outside"), ("workspace/link", "file_missing"), ("workspace/d", "file_missing"),
                        ("workspace/none.txt", "file_missing")):
            out = self.run_with(infos, [p])
            self.assertEqual((out["code"], out["path"]), (code, p), p)
            self.assertTrue(out["error"])

    def test_picked_files_over_the_upload_limit_are_refused_but_uploads_are_not(self):
        big = {"exists": True, "type": "file", "size": wsp.MAX_FILE + 1}
        out = self.run_with({"workspace/logs/huge.log": big}, ["workspace/logs/huge.log"])
        self.assertEqual((out["code"], out["path"]), ("too_large", "workspace/logs/huge.log"))
        out = self.run_with({"workspace/uploads/aas-shared-out/1/sa/d/big.bin": big}, ["workspace/uploads/aas-shared-out/1/sa/d/big.bin"])
        self.assertEqual(out["code"], "too_large")                                       # 회의 공유 파일도 「고른」 파일이다
        ok = self.run_with({"workspace/logs/edge.log": {**big, "size": wsp.MAX_FILE}}, ["workspace/logs/edge.log"])
        self.assertEqual(ok[0]["size"], wsp.MAX_FILE)
        up = self.run_with({"workspace/uploads/d/up.bin": big}, ["workspace/uploads/d/up.bin"])
        self.assertEqual(up[0]["path"], "workspace/uploads/d/up.bin")                  # 올린 파일의 한도는 올릴 때 이미 봤다

    def test_send_returns_the_code_and_path_as_json(self):
        """화면은 400 본문의 code·path 로 그 뱃지만 빨갛게 바꾼다(DD5)."""
        out = self.run_with({}, ["workspace/none.txt"])
        self.assertEqual(json.loads(json.dumps(out))["path"], "workspace/none.txt")
        out = self.run_with({}, [f"workspace/f{i}" for i in range(wsp.MAX_FILES_PER_MESSAGE + 1)])
        self.assertEqual(out["code"], "too_many")


class LegacyLimitsTest(unittest.TestCase):
    def test_old_handler_limits_are_unchanged(self):
        """R7: 새 라우트만 큰 본문을 받는다. 옛 Handler 상한은 그대로."""
        self.assertEqual(server.MAX_BODY, 256 * 1024)
        self.assertEqual(legacy.MAX_REQUEST_BODY, 1024 * 1024)


# ---- 끝까지: uvicorn + 사이드카 + 가짜 Hermes -----------------------------------------------------------
class FakeDashboard(http.server.BaseHTTPRequestHandler):
    """Hermes 대시보드 파일 API 흉내: 로그인 쿠키, mkdir, upload-stream(multipart, overwrite=false 면 409), DELETE."""
    root: Path = Path(".")
    uploads: list = []

    def log_message(self, *a):
        pass

    def _json(self, code, obj, cookie=False):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        if cookie:
            self.send_header("Set-Cookie", "hsess=ok; Path=/")
        self.end_headers()
        self.wfile.write(body)

    def _authed(self):
        return "hsess=ok" in (self.headers.get("Cookie") or "")

    def _body(self):
        return self.rfile.read(int(self.headers.get("Content-Length") or 0))

    def do_POST(self):  # noqa: N802
        if self.path == "/auth/password-login":
            self._body()
            return self._json(200, {"ok": True}, cookie=True)
        if not self._authed():
            self._body()
            return self._json(401, {"detail": "login"})
        if self.path == "/api/files/mkdir":
            (self.root / json.loads(self._body())["path"]).mkdir(parents=True, exist_ok=True)
            return self._json(200, {"ok": True})
        if self.path == "/api/files/upload-stream":
            raw = self._body()
            boundary = re.search(r"boundary=(\S+)", self.headers["Content-Type"]).group(1).encode()
            fields = {}
            for part in raw.split(b"--" + boundary)[1:-1]:
                head, _, data = part.partition(b"\r\n\r\n")
                name = re.search(rb'name="([^"]+)"', head).group(1).decode()
                fields[name] = data[:-2]
            target = self.root / fields["path"].decode()
            if target.exists() and fields["overwrite"] == b"false":
                return self._json(409, {"detail": "File already exists"})
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(fields["file"])
            FakeDashboard.uploads.append(fields["path"].decode())
            return self._json(200, {"ok": True})
        self._json(404, {})

    def do_DELETE(self):  # noqa: N802
        body = json.loads(self._body())
        if not self._authed():
            return self._json(401, {})
        target = self.root / body["path"]
        if not target.exists():
            return self._json(404, {"detail": "Path not found"})
        # 이미지 Hermes(web_routers/files.py delete_managed_file)와 같게: 폴더는 recursive 면 rmtree, 아니면 rmdir(비어 있지 않으면 409)
        if target.is_dir() and not target.is_symlink():
            if body.get("recursive"):
                shutil.rmtree(target)
            else:
                try:
                    target.rmdir()
                except OSError:
                    return self._json(409, {"detail": "Could not delete path"})
        else:
            target.unlink()
        self._json(200, {"ok": True})


class FilesHttpTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.old = {k: os.environ.get(k) for k in ("AAS_USERS_FILE", "AAS_ALLOWED_HOSTS", "AAS_PODS_FILE", "AAS_OIDC_ISSUER",
                                                   "AAS_TRUSTED_PROXY", "AAS_SIDECAR_TOKEN", "AAS_DASHBOARD_USER",
                                                   "AAS_DASHBOARD_PASSWORD", "AAS_WORKSPACE_QUOTA")}
        for k in cls.old:
            os.environ.pop(k, None)
        cls.root = Path(TMP.name) / "agent"
        (cls.root / "workspace" / "outputs").mkdir(parents=True)
        (cls.root / "state.db").write_bytes(b"SQLITE-CHAT-HISTORY")
        (cls.root / "workspace" / "outputs" / "report.txt").write_bytes(b"hello report")
        (cls.root / "workspace" / "outputs" / "db-link").symlink_to(cls.root / "state.db")
        os.environ.update(AAS_SIDECAR_TOKEN=TOKEN, AAS_DASHBOARD_USER="u", AAS_DASHBOARD_PASSWORD="p")
        cls.sidecar = sc_server.make_server("127.0.0.1", 0, sc_ops.Ops(cls.root), TOKEN)
        threading.Thread(target=cls.sidecar.serve_forever, daemon=True).start()
        FakeDashboard.root = cls.root
        cls.dash = http.server.ThreadingHTTPServer(("127.0.0.1", 0), FakeDashboard)
        threading.Thread(target=cls.dash.serve_forever, daemon=True).start()
        reg = Path(TMP.name) / "pods-files.json"
        reg.write_text(json.dumps({"pods": [{
            "id": "w", "owner": "t@example.com", "hermes_home": "/nonexistent",
            "sidecar_url": f"http://127.0.0.1:{cls.sidecar.server_address[1]}",
            "dashboard_url": f"http://127.0.0.1:{cls.dash.server_address[1]}"}]}))
        server._auth = auth.Auth({"issuer": "https://accounts.google.com", "client_id": "", "client_secret": "", "domain": "",
                                  "public_url": "http://localhost:17900", "hours": 1, "users_file": Path(TMP.name) / "no-users.json"})
        server._registry = pods.Registry(reg)
        server.OFFICE = office_state.Office()
        server._hubs.clear()
        server._workspaces.clear()
        cls.httpd = aasserver.start()
        cls.port = cls.httpd.server_port

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.sidecar.shutdown()
        cls.dash.shutdown()
        server._hubs.clear()
        server._workspaces.clear()
        for k, v in cls.old.items():
            os.environ.pop(k, None)
            if v is not None:
                os.environ[k] = v
        server._auth = server._registry = None

    def req(self, method, path, body=None, headers=None):
        c = http.client.HTTPConnection("127.0.0.1", self.port, timeout=15)
        h = {"X-AAS": "1"} if method != "GET" else {}
        h.update(headers or {})
        c.request(method, path, body=body, headers=h)
        r = c.getresponse()
        data = r.read()
        c.close()
        return r, data

    def put(self, name, data, extra=""):
        return self.req("PUT", f"/api/chat/files?pod=w&name={urllib.parse.quote(name)}{extra}", body=data)

    def test_upload_lands_in_todays_uploads_and_same_name_gets_a_suffix(self):
        r, raw = self.put("매출 표.csv", b"a,b\n1,2\n")
        self.assertEqual(r.status, 200, raw)
        first = json.loads(raw)
        self.assertTrue(first["path"].startswith(wsp.today_dir() + "/"))
        self.assertEqual((first["name"], first["renamed"]), ("매출 표.csv", False))
        self.assertEqual((self.root / first["path"]).read_bytes(), b"a,b\n1,2\n")
        r, raw = self.put("매출 표.csv", b"again")
        second = json.loads(raw)
        self.assertEqual((second["name"], second["renamed"]), ("매출 표-2.csv", True))

    def test_upload_of_a_decomposed_hangul_name_is_stored_and_reported_composed(self):
        """OMAI-1153: NFD 이름으로 올려도 디스크·응답 경로가 NFC 라, 모델이 쓴 경로로 파일이 열린다."""
        nfd = unicodedata.normalize("NFD", "스크린샷 2026-08-26 18.02.57.png")
        r, raw = self.put(nfd, b"png")
        self.assertEqual(r.status, 200, raw)
        body = json.loads(raw)
        nfc = "스크린샷 2026-08-26 18.02.57.png"
        self.assertEqual(body["name"], nfc)
        self.assertEqual(body["path"], f"{wsp.today_dir()}/{nfc}")
        self.assertEqual((self.root / body["path"]).read_bytes(), b"png")

    def test_upload_checks_size_quota_origin_and_pod(self):
        old = wsp.MAX_FILE
        wsp.MAX_FILE = 4
        try:
            r, raw = self.put("big.bin", b"12345")
            self.assertEqual((r.status, json.loads(raw)["code"]), (413, "too_large"))
        finally:
            wsp.MAX_FILE = old
        os.environ["AAS_WORKSPACE_QUOTA"] = "10"
        try:
            r, raw = self.put("q.bin", b"x" * 64)
            self.assertEqual((r.status, json.loads(raw)["code"]), (413, "quota"))
        finally:
            os.environ.pop("AAS_WORKSPACE_QUOTA", None)
        r, raw = self.req("PUT", "/api/chat/files?pod=w&name=a", body=b"x", headers={"X-AAS": ""})
        self.assertEqual(r.status, 403)
        r, raw = self.req("PUT", "/api/chat/files?pod=nope&name=a", body=b"x")
        self.assertEqual((r.status, json.loads(raw)["code"]), (403, "pod"))
        r, raw = self.put("empty.txt", b"")
        self.assertEqual((r.status, json.loads(raw)["code"]), (400, "empty"))

    def test_upload_returns_busy_when_all_transfer_slots_are_taken(self):
        """R6: 동시 전송 상한을 넘으면 기다리지 않고 429, 끝난 전송은 자리를 돌려준다."""
        taken = 0
        while web_files.SLOTS.take():
            taken += 1
        try:
            r, raw = self.put("busy.txt", b"x")
            self.assertEqual((r.status, json.loads(raw)["code"]), (429, "busy"))
        finally:
            for _ in range(taken):
                web_files.SLOTS.give()
        r, _ = self.put("after-busy.txt", b"x")
        self.assertEqual(r.status, 200)
        self.assertEqual(web_files.SLOTS.used, 0)

    def test_head_then_download_streams_and_refuses_links(self):
        r, _ = self.req("HEAD", "/api/chat/files?pod=w&path=workspace/outputs/report.txt")
        self.assertEqual(r.status, 200)
        r, _ = self.req("HEAD", "/api/chat/files?pod=w&path=workspace/outputs/db-link")
        self.assertEqual((r.status, r.getheader("X-AAS-Code")), (403, "link"))
        r, _ = self.req("HEAD", "/api/chat/files?pod=w&path=workspace/outputs/none.txt")
        self.assertEqual((r.status, r.getheader("X-AAS-Code")), (404, "not_found"))
        r, _ = self.req("HEAD", "/api/chat/files?pod=w&path=state.db")
        self.assertEqual((r.status, r.getheader("X-AAS-Code")), (400, "outside"))
        r, raw = self.req("GET", "/api/chat/files?pod=w&path=workspace/outputs/report.txt")
        self.assertEqual((r.status, raw), (200, b"hello report"))
        self.assertIn("attachment", r.getheader("Content-Disposition"))
        self.assertEqual(r.getheader("X-Content-Type-Options"), "nosniff")
        r, raw = self.req("GET", "/api/chat/files?pod=w&path=workspace/outputs/db-link")
        self.assertEqual(r.status, 403)
        self.assertNotIn(b"SQLITE-CHAT-HISTORY", raw)
        r, _ = self.req("GET", "/api/chat/files?pod=w&path=workspace/outputs/report.txt", headers={"Sec-Fetch-Site": "cross-site"})
        self.assertEqual(r.status, 403)
        self.assertEqual(web_files.SLOTS.used, 0)

    def test_delete_refuses_links_and_removes_plain_files(self):
        (self.root / "workspace" / "outputs" / "gone.txt").write_bytes(b"x")
        r, raw = self.req("DELETE", "/api/chat/files?pod=w&path=workspace/outputs/db-link")
        self.assertEqual((r.status, json.loads(raw)["code"]), (403, "link"))
        self.assertTrue((self.root / "state.db").exists())
        r, raw = self.req("DELETE", "/api/chat/files?pod=w&path=workspace/outputs")
        self.assertEqual((r.status, json.loads(raw)["code"]), (403, "dir"))
        r, raw = self.req("DELETE", "/api/chat/files?pod=w&path=workspace/outputs/gone.txt")
        self.assertEqual(r.status, 200, raw)
        self.assertFalse((self.root / "workspace" / "outputs" / "gone.txt").exists())

    def test_folder_delete_needs_recursive_and_refuses_protected_paths(self):
        """스펙 2026-10-28-002 §4-1: recursive=1 이면 폴더를 숨은 파일까지 통째로 지우고, 루트·올린 파일 루트·회의 공유·.hermes 는 403 protected."""
        ws = self.root / "workspace"
        (ws / "rooms" / "13" / ".cache").mkdir(parents=True, exist_ok=True)
        (ws / "rooms" / "13" / "kanban.html").write_bytes(b"k")
        (ws / "rooms" / "13" / ".cache" / "x").write_bytes(b"h")
        for d in ("uploads/aas-shared/1", ".hermes"):
            (ws / d).mkdir(parents=True, exist_ok=True)
        (ws / "uploads" / "aas-shared" / "1" / "m.md").write_bytes(b"m")
        (ws / ".hermes" / "state.json").write_bytes(b"{}")

        def cleanup():
            shutil.rmtree(ws / "rooms", ignore_errors=True)
            shutil.rmtree(ws / ".hermes", ignore_errors=True)
            shutil.rmtree(ws / "uploads" / "aas-shared" / "1", ignore_errors=True)
        self.addCleanup(cleanup)
        r, raw = self.req("DELETE", "/api/chat/files?pod=w&path=workspace/rooms/13")
        self.assertEqual((r.status, json.loads(raw)["code"]), (403, "dir"))
        r, raw = self.req("DELETE", "/api/chat/files?pod=w&path=workspace&recursive=1")
        self.assertEqual((r.status, json.loads(raw)["code"]), (400, "outside"))   # 작업 폴더 루트는 처음부터 밖
        for path in ("workspace/uploads", "workspace/uploads/aas-shared", "workspace/uploads/aas-shared/1", "workspace/.hermes"):
            r, raw = self.req("DELETE", f"/api/chat/files?pod=w&path={path}&recursive=1")
            self.assertEqual((r.status, json.loads(raw)["code"]), (403, "protected"), path)
        self.assertTrue((ws / "uploads" / "aas-shared" / "1" / "m.md").exists())
        self.assertTrue((ws / ".hermes" / "state.json").exists())
        r, raw = self.req("DELETE", "/api/chat/files?pod=w&path=workspace/rooms/13&recursive=1")
        self.assertEqual(r.status, 200, raw)
        self.assertFalse((ws / "rooms" / "13").exists())
        self.assertTrue((ws / "rooms").exists())   # 위 폴더는 그대로
        r, raw = self.req("DELETE", "/api/chat/files?pod=w&path=workspace/outputs/db-link&recursive=1")
        self.assertEqual((r.status, json.loads(raw)["code"]), (403, "link"))

    def test_listing_marks_links_and_reports_usage(self):
        r, raw = self.req("GET", "/api/chat/files/list?pod=w")
        self.assertEqual(r.status, 200, raw)
        out = json.loads(raw)
        by = {e["path"]: e for e in out["entries"]}
        self.assertEqual((by["workspace/outputs/db-link"]["downloadable"], by["workspace/outputs/db-link"]["reason"]), (False, "link"))
        self.assertTrue(by["workspace/outputs/report.txt"]["downloadable"])
        self.assertEqual(out["quota"], wsp.quota())
        self.assertIsInstance(out["used"], int)

    def test_office_chat_files_streams_agent_and_shared_files_but_not_owner_uploads(self):
        """스펙 2026-10-20-002 R2·R4: 오피스 대화창 받기는 자리 별칭으로, 주인 업로드는 owner_private, 나머지는 채팅 받기와 같다."""
        from aas.office import office
        ws = self.root / "workspace"
        (ws / "uploads" / "aas-shared" / "1" / "d").mkdir(parents=True, exist_ok=True)
        (ws / "uploads" / "aas-shared" / "1" / "d" / "회의록.md").write_bytes(b"# minutes")
        (ws / "uploads" / "2026-10-20").mkdir(parents=True, exist_ok=True)
        (ws / "uploads" / "2026-10-20" / "private.txt").write_bytes(b"owner only")
        office.set_seat({"pod": "w", "profile": "wp", "alias": "wseat"}, "me", {"w": {"wp"}})

        def cleanup():
            with office.connect() as conn:
                conn.execute("DELETE FROM office_seats WHERE alias='wseat'")
        self.addCleanup(cleanup)
        base = "/api/office/chat/files?alias=wseat&path="
        r, raw = self.req("GET", base + "workspace/outputs/report.txt")
        self.assertEqual((r.status, raw), (200, b"hello report"))
        self.assertEqual((r.getheader("Content-Type"), r.getheader("Content-Length")), ("application/octet-stream", "12"))
        self.assertIn("attachment", r.getheader("Content-Disposition"))
        r, raw = self.req("GET", base + urllib.parse.quote("workspace/uploads/aas-shared/1/d/회의록.md"))
        self.assertEqual((r.status, raw), (200, b"# minutes"))
        self.assertIn("UTF-8''" + urllib.parse.quote("회의록.md"), r.getheader("Content-Disposition"))
        for method in ("GET", "HEAD"):
            r, raw = self.req(method, base + "workspace/uploads/2026-10-20/private.txt")
            self.assertEqual((r.status, r.getheader("X-AAS-Code")), (403, "owner_private"), method)
            self.assertNotIn(b"owner only", raw)
        r, _ = self.req("HEAD", base + "workspace/outputs/report.txt")
        self.assertEqual(r.status, 200)
        r, _ = self.req("HEAD", base + "workspace/outputs/db-link")
        self.assertEqual((r.status, r.getheader("X-AAS-Code")), (403, "link"))
        r, raw = self.req("GET", base + "workspace/outputs/db-link")
        self.assertEqual((r.status, r.getheader("X-AAS-Code")), (403, "link"))
        self.assertNotIn(b"SQLITE-CHAT-HISTORY", raw)
        r, _ = self.req("GET", base + "state.db")
        self.assertEqual((r.status, r.getheader("X-AAS-Code")), (400, "outside"))
        r, _ = self.req("HEAD", base + "workspace/outputs/none.txt")
        self.assertEqual((r.status, r.getheader("X-AAS-Code")), (404, "not_found"))
        r, _ = self.req("GET", "/api/office/chat/files?alias=nobody&path=workspace/outputs/report.txt")
        self.assertEqual((r.status, r.getheader("X-AAS-Code")), (404, "not_found"))
        r, _ = self.req("HEAD", base + "workspace/outputs/report.txt", headers={"X-AAS": ""})
        self.assertEqual(r.status, 403)                                                    # HEAD 는 채팅 받기처럼 X-AAS·같은 출처
        r, _ = self.req("GET", base + "workspace/outputs/report.txt", headers={"Sec-Fetch-Site": "cross-site"})
        self.assertEqual(r.status, 403)
        taken = 0
        while web_files.SLOTS.take():
            taken += 1
        try:
            r, _ = self.req("GET", base + "workspace/outputs/report.txt")
            self.assertEqual((r.status, r.getheader("X-AAS-Code")), (429, "busy"))
        finally:
            for _ in range(taken):
                web_files.SLOTS.give()
        self.assertEqual(web_files.SLOTS.used, 0)

    def test_status_says_files_are_supported(self):
        r, raw = self.req("GET", "/api/chat/status", headers={"Cookie": "aas_pod=w"})
        self.assertEqual(r.status, 200, raw)
        self.assertTrue(json.loads(raw)["files"])


if __name__ == "__main__":
    unittest.main()

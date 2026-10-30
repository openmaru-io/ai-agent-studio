# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""채팅 입력칸 음성 입력의 서버 쪽 — 스펙 docs-plan/deploy/chat-voice-input-whisper.md (2026-10-22-005, OMAI-1438).

- POST /api/chat/transcribe: 형식·설정·동시 한도(R10)·Hermes 오류 문구·사용 기록(글은 남기지 않음)
- 본문 상한: 이 경로만 10MB, 다른 경로는 그대로(§9 F1)
- /api/chat/status 의 stt(R2)
- 기존 프로파일에 stt 절을 한 번 넣기와 공통 함수 _config_once(R3)
Hermes 는 대역으로 바꾼다."""
import os
import tempfile
import threading
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

TMP = tempfile.TemporaryDirectory()
os.environ.setdefault("AAS_DATA_DIR", str(Path(TMP.name) / "data"))

import yaml  # noqa: E402

from aas.common import store  # noqa: E402
from aas.hermes import stt_config  # noqa: E402
from aas.hermes.hermes_api import HermesError  # noqa: E402
from aas.web import legacy, server  # noqa: E402

AUDIO = "data:audio/webm;base64," + "QUJD" * 100
POD = SimpleNamespace(id="tp", owner="x@x.com")


class FakeAPI:
    def __init__(self, result=None, error=None, gate=None):
        self.result, self.error, self.gate = result, error, gate
        self.calls = []

    def call(self, method, path, body=None, query=None, timeout=30):
        self.calls.append((method, path, body, query, timeout))
        if self.gate:
            self.gate.wait(5)
        if self.error:
            raise self.error
        return self.result


class TranscribeTest(unittest.TestCase):
    def setUp(self):
        self.env = mock.patch.dict(os.environ, {"AAS_STT_MODEL": "cogentai-stt"})
        self.env.start()
        server._TRANSCRIBE_SLOTS = None
        self.logs = []
        self.log = mock.patch.object(server.store, "log_usage", side_effect=lambda kind, note, **kw: self.logs.append((kind, note)))
        self.log.start()

    def tearDown(self):
        self.log.stop()
        self.env.stop()
        server._TRANSCRIBE_SLOTS = None

    def run_with(self, api, body, profile="main", root=False):
        with mock.patch.object(server, "HermesAPI", return_value=api), mock.patch.object(server, "hub", return_value=SimpleNamespace(auth=None)):
            return server._transcribe(POD, profile, root, body, "u@x.com")

    def test_정상이면_Hermes_가_돌려준_글을_그대로_주고_사용_기록에_글은_남기지_않는다(self):
        api = FakeAPI({"ok": True, "transcript": "오늘 회의 잡아 줘", "provider": "openai"})
        out, code = self.run_with(api, {"mime_type": "audio/webm;codecs=opus", "data_url": AUDIO, "seconds": 3.4})
        self.assertEqual((code, out), (200, {"transcript": "오늘 회의 잡아 줘"}))
        method, path, body, query, timeout = api.calls[0]
        self.assertEqual((method, path, query, timeout), ("POST", "/api/audio/transcribe", {"profile": "main"}, server.TRANSCRIBE_TIMEOUT))
        self.assertEqual(body, {"data_url": AUDIO, "mime_type": "audio/webm;codecs=opus"})
        self.assertEqual([k for k, _ in self.logs], ["chat_transcribe"])
        self.assertNotIn("회의", self.logs[0][1])
        self.assertIn("3s", self.logs[0][1])

    def test_루트_프로파일은_profile_인자를_보내지_않는다(self):
        api = FakeAPI({"transcript": ""})
        self.run_with(api, {"mime_type": "audio/mp4", "data_url": "data:audio/mp4;base64,QUJD"}, profile="default", root=True)
        self.assertIsNone(api.calls[0][3])

    def test_음성_인식이_설정되지_않았으면_503(self):
        with mock.patch.dict(os.environ, {"AAS_STT_MODEL": ""}):
            api = FakeAPI({"transcript": "x"})
            out, code = self.run_with(api, {"mime_type": "audio/webm", "data_url": AUDIO})
        self.assertEqual(code, 503)
        self.assertEqual(api.calls, [])

    def test_소리가_아닌_형식이나_data_URL_이_아니면_400(self):
        for body in ({"mime_type": "text/plain", "data_url": AUDIO}, {"mime_type": "audio/webm", "data_url": "QUJD"},
                     {"mime_type": "audio/webm", "data_url": "data:audio/webm;base64"}, {}):
            api = FakeAPI({"transcript": "x"})
            out, code = self.run_with(api, body)
            self.assertEqual(code, 400, body)
            self.assertEqual(api.calls, [])

    def test_Hermes_가_거절하면_원문_대신_사용자_문구(self):
        api = FakeAPI(error=HermesError("Transcription failed: secret-ish detail", 400))
        out, code = self.run_with(api, {"mime_type": "audio/webm", "data_url": AUDIO})
        self.assertEqual(code, 502)
        self.assertNotIn("secret-ish", out["error"])
        self.assertEqual(self.logs, [])

    def test_에이전트에_연결할_수_없으면_503_시간_초과는_504(self):
        out, code = self.run_with(FakeAPI(error=HermesError("down", 503)), {"mime_type": "audio/webm", "data_url": AUDIO})
        self.assertEqual(code, 503)
        out2, code2 = self.run_with(FakeAPI(error=HermesError("slow", 504, "timeout")), {"mime_type": "audio/webm", "data_url": AUDIO})
        self.assertEqual(code2, 504)
        self.assertNotEqual(out["error"], out2["error"])                              # 시간 초과는 「연결할 수 없음」과 다른 문구

    def test_seconds_가_이상한_값이어도_받아쓴_글은_돌려준다(self):
        for secs in ("Infinity", 1e999, "nan", "abc", None, -5):
            out, code = self.run_with(FakeAPI({"transcript": "네"}), {"mime_type": "audio/webm", "data_url": AUDIO, "seconds": secs})
            self.assertEqual((code, out), (200, {"transcript": "네"}), secs)

    def test_소리가_없었는데_인사말만_나오면_무음_환각으로_보고_버린다(self):
        # 2026-10-23 실측: GB10 Whisper(ko)에 3초 무음·조용한 방 잡음을 보내면 늘 「감사합니다.」, 사용자 마이크에서는 「안녕하세요」
        for said in (" 감사합니다.", "안녕하세요", "시청해 주셔서 감사합니다!", "감사합니다. 감사합니다.", "구독과 좋아요 부탁드립니다"):
            out, code = self.run_with(FakeAPI({"transcript": said}), {"mime_type": "audio/webm", "data_url": AUDIO, "heard": False})
            self.assertEqual((code, out), (200, {"transcript": "", "silent": True}), said)

    def test_소리가_들렸으면_인사말도_그대로_준다(self):
        # 사용자가 실제로 「감사합니다」라고 말한 것은 지킨다(사용자 결정 2026-10-23 A)
        out, code = self.run_with(FakeAPI({"transcript": "감사합니다."}), {"mime_type": "audio/webm", "data_url": AUDIO, "heard": True})
        self.assertEqual((code, out), (200, {"transcript": "감사합니다."}))

    def test_heard_를_보내지_않는_옛_화면은_그대로_준다(self):
        out, code = self.run_with(FakeAPI({"transcript": "감사합니다."}), {"mime_type": "audio/webm", "data_url": AUDIO})
        self.assertEqual((code, out), (200, {"transcript": "감사합니다."}))

    def test_소리가_없었어도_목록에_없는_글은_준다(self):
        # 마이크 음량이 작아 기준을 못 넘었을 뿐 실제로 말한 경우
        out, code = self.run_with(FakeAPI({"transcript": "안녕하세요 내일 회의 잡아 줘"}), {"mime_type": "audio/webm", "data_url": AUDIO, "heard": False})
        self.assertEqual((code, out), (200, {"transcript": "안녕하세요 내일 회의 잡아 줘"}))

    def test_동시_한도가_차면_429(self):
        with mock.patch.dict(os.environ, {"AAS_TRANSCRIBE_SLOTS": "1"}):
            server._TRANSCRIBE_SLOTS = None
            gate = threading.Event()
            first = FakeAPI({"transcript": "a"}, gate=gate)
            t = threading.Thread(target=self.run_with, args=(first, {"mime_type": "audio/webm", "data_url": AUDIO}))
            t.start()
            try:
                for _ in range(100):
                    if first.calls:
                        break
                    threading.Event().wait(0.01)
                out, code = self.run_with(FakeAPI({"transcript": "b"}), {"mime_type": "audio/webm", "data_url": AUDIO})
                self.assertEqual(code, 429)
            finally:
                gate.set()
                t.join(5)
            out, code = self.run_with(FakeAPI({"transcript": "c"}), {"mime_type": "audio/webm", "data_url": AUDIO})
            self.assertEqual(code, 200)                                              # 끝나면 자리가 돌아온다


class BodyLimitTest(unittest.TestCase):
    def test_받아쓰기_경로만_2MB_다른_경로는_그대로(self):
        self.assertEqual(server.body_limit(server.TRANSCRIBE_PATH), 2 * 1024 * 1024)
        self.assertEqual(server.body_limit("/api/chat/send"), server.MAX_BODY)
        self.assertEqual(legacy.request_limit(server.TRANSCRIBE_PATH), 2 * 1024 * 1024)
        self.assertEqual(legacy.request_limit("/api/pod"), legacy.MAX_REQUEST_BODY)

    def test_읽는_도중의_상한도_경로를_따른다(self):
        """Content-Length 없이 조각으로 와도(chunked) 받아쓰기 경로는 1MB 를 넘겨 받는다."""
        import asyncio
        big = b"x" * (600 * 1024)

        def receiver():
            msgs = [{"type": "http.request", "body": big, "more_body": True}, {"type": "http.request", "body": big, "more_body": False}]

            async def receive():
                return msgs.pop(0)
            return receive
        self.assertIsNone(asyncio.run(legacy._read_body(receiver())))                                     # 기본 1MB
        self.assertEqual(len(asyncio.run(legacy._read_body(receiver(), legacy.request_limit(server.TRANSCRIBE_PATH)))), 2 * len(big))


class StatusTest(unittest.TestCase):
    def test_chat_status_는_음성_인식_설정_여부를_알린다(self):
        hub = SimpleNamespace(status=lambda: {"connected": True})
        with mock.patch.object(server, "hub", return_value=hub), mock.patch.object(server, "workspace_for", return_value=None), \
                mock.patch.object(server.primary, "primary_of", return_value="main"), mock.patch.object(server, "_pod_owner_name", return_value=""), \
                mock.patch.object(server.cron_health.hr, "profiles", return_value=[]), mock.patch.object(server, "_agents", return_value=[]), \
                mock.patch.object(server.chat_default, "resolve", return_value="main"):
            pod = SimpleNamespace(id="tp", hermes_home=Path(TMP.name))
            with mock.patch.dict(os.environ, {"AAS_STT_MODEL": "cogentai-stt"}):
                self.assertIs(server._chat_status(pod)["stt"], True)
            with mock.patch.dict(os.environ, {"AAS_STT_MODEL": ""}):
                self.assertIs(server._chat_status(pod)["stt"], False)


class SttPatchTest(unittest.TestCase):
    def test_없으면_덧붙이고_있으면_그대로_둔다(self):
        base = "model:\n  default: m  # 주석\n"
        out = stt_config.with_stt(base, "cogentai-stt")
        self.assertTrue(out.startswith(base))                                         # 주석·내용은 그대로, 뒤에 더한다
        stt = yaml.safe_load(out)["stt"]
        self.assertEqual((stt["provider"], stt["language"], stt["openai"]["model"]), ("openai", "ko", "cogentai-stt"))
        self.assertEqual(stt["openai"]["base_url"], "${HERMES_LLM_BASE_URL}")
        self.assertEqual((stt["openai"]["timeout"], stt["openai"]["max_retries"]), (60, 1))
        self.assertIsNone(stt_config.with_stt(out, "cogentai-stt"))                    # 이미 있다
        self.assertIsNone(stt_config.with_stt("stt:\n  provider: local\n", "cogentai-stt"))   # 사람이 정한 값은 그대로
        self.assertIsNone(stt_config.with_stt("a: [1,\n", "cogentai-stt"))              # 읽을 수 없는 글은 고치지 않는다
        self.assertIsNone(stt_config.with_stt("model: m\n", ""))                         # 모델 이름이 없으면 넣지 않는다


class ConfigOnceTest(unittest.TestCase):
    def setUp(self):
        with store.connect() as conn:
            conn.execute("DELETE FROM meta WHERE key LIKE 'sttcfg:%' OR key LIKE 'once-test:%'")

    tearDown = setUp

    def api(self, texts, puts, changing=None):
        class API:
            def call(self, method, path, body=None, query=None, timeout=30):
                if path == "/api/profiles":
                    return {"profiles": [{"name": "default", "is_default": True}, {"name": "main", "is_default": False}]}
                prof = (query or {}).get("profile") or (body or {}).get("profile") or "default"
                if method == "GET":
                    text = texts[prof]
                    if changing is not None and prof in changing:                       # 두 번째 읽기에서 Hermes 가 바꾼 것처럼
                        texts[prof] = changing.pop(prof)
                    return {"yaml": text}
                puts.append(prof)
                texts[prof] = body["yaml_text"]
                return {"ok": True}
        return API()

    def test_그사이_Hermes_가_바꿨으면_덮지_않고_다음에_다시_본다(self):
        texts, puts = {"main": "model: m\n"}, []
        api = self.api(texts, puts, changing={"main": "model: n\n"})
        patch = lambda cur, q: cur + "x: 1\n"                                          # noqa: E731
        with mock.patch.object(server.files, "save_text") as save:
            self.assertEqual(server._config_once(POD, api, {"name": "main"}, "once-test", patch, "메모", "x=1"), "")
            save.assert_not_called()
            with store.connect() as conn:
                self.assertIsNone(conn.execute("SELECT 1 FROM meta WHERE key='once-test:tp/main'").fetchone())   # 다음 주기에 다시

    def test_stt_절은_설정이_있을_때만_프로파일마다_한_번_넣는다(self):
        texts = {"default": "model: m\n", "main": "stt:\n  provider: local\n"}
        puts = []
        reg = SimpleNamespace(pods=[POD])
        with mock.patch.object(server, "HermesAPI", return_value=self.api(texts, puts)), mock.patch.object(server, "hub", return_value=SimpleNamespace(auth=None)):
            with mock.patch.dict(os.environ, {"AAS_STT_MODEL": ""}):
                self.assertEqual(server.stt_sync_once(reg), [])                           # 꺼져 있으면 아무것도 하지 않는다(나중에 켜면 넣는다)
            with mock.patch.dict(os.environ, {"AAS_STT_MODEL": "cogentai-stt"}):
                self.assertEqual(server.stt_sync_once(reg), ["tp/default"])               # main 은 사람이 정한 stt 가 있다
                self.assertEqual(server.stt_sync_once(reg), [])                           # 한 번 본 프로파일은 다시 보지 않는다
        self.assertEqual(puts, ["default"])
        self.assertEqual(yaml.safe_load(texts["default"])["stt"]["openai"]["model"], "cogentai-stt")


if __name__ == "__main__":
    unittest.main()

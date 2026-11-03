# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""스트리밍 받아쓰기 중계 WS /api/chat/transcribe/stream (OMAI-1554, 계약 docs-plan/deploy/stt-stream-protocol.md 2026-10-31-002).

실제 uvicorn 앱(aasserver.py)에 websockets 클라이언트로 붙고, 엔진은 같은 규약을 말하는 가짜 WS 서버(websockets.sync.server)로 바꾼다.
- 정상 중계(ready 의 max_seconds 는 작은 쪽, 엔진 키는 Bearer, 메시지는 그대로), 사용 기록 형식(글 없음)
- 서버 전용 거절: Origin·미로그인·권한 없음·disabled(받아들인 뒤 error + 앱 close 코드)
- busy(서버 동시·사람당), too_long, idle, bad_audio, 엔진 끊김·연결 실패 → engine, 버퍼 상한 → busy
- /api/chat/status 의 stt_stream·stt_stream_max_seconds
사용 기록은 대역으로 모아 공유 데이터 폴더에 남기지 않는다(CLAUDE.md 시험 데이터 정리)."""
import aasserver  # 실제 uvicorn 앱을 띄우는 시험 하네스
import json
import os
import socket
import tempfile
import threading
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

TMP = tempfile.TemporaryDirectory()
os.environ.setdefault("AAS_DATA_DIR", str(Path(TMP.name) / "data"))

from websockets.exceptions import ConnectionClosed  # noqa: E402
from websockets.sync.client import connect  # noqa: E402
from websockets.sync.server import serve  # noqa: E402

from aas.auth import auth  # noqa: E402
from aas.fleet import pods  # noqa: E402
from aas.web import server, stt_stream  # noqa: E402

ADMIN, ALICE, BOB = "boss@example.com", "alice@example.com", "bob@example.com"
CHUNK = b"\x01\x00" * 1600                   # 100ms PCM16 16kHz


class FakeEngine:
    """계약대로 말하는 엔진. mode 로 동작을 바꾼다: normal · crash(첫 소리에 끊음) · slow(ready 를 늦게) · refuse(start 에 busy)."""

    def __init__(self):
        self.mode, self.max_seconds, self.delay = "normal", 600, 0.0
        self.refine_delay = None                            # 값이 있으면 final 뒤 이만큼 기다려 refined 를 보낸다(2026-11-01-001 D9)
        self.headers: list = []
        self.received: list = []
        self.server = serve(self.handle, "127.0.0.1", 0)
        self.port = self.server.socket.getsockname()[1]
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def reset(self):
        self.mode, self.max_seconds, self.delay = "normal", 600, 0.0
        self.refine_delay = None
        self.headers, self.received = [], []

    def handle(self, conn):
        self.headers.append(conn.request.headers.get("Authorization"))
        try:
            start = json.loads(conn.recv())
            self.received.append(start)
            if self.mode == "refuse":
                conn.send(json.dumps({"type": "error", "code": "busy", "message": "engine full"}))
                return
            if self.delay:
                time.sleep(self.delay)
            conn.send(json.dumps({"type": "ready", "session": "e1", "max_seconds": self.max_seconds}))
            seq, seg = 0, 0
            while True:
                msg = conn.recv()
                self.received.append(msg)
                if isinstance(msg, bytes):
                    if self.mode == "crash":
                        # 닫기 인사 없이 끊는다(엔진 프로세스가 죽은 것과 같다). close() 만 하면 Linux 는 다른 스레드가 이 소켓을
                        # 읽는 동안 FIN 을 보내지 않아 AAS 가 끊김을 모른다(Jenkins python:3.12 #515, macOS 는 통과) — shutdown 을 먼저 한다.
                        try:
                            conn.socket.shutdown(socket.SHUT_RDWR)
                        except OSError:
                            pass
                        conn.socket.close()
                        return
                    seq += 1
                    conn.send(json.dumps({"type": "interim", "text": f"중간{seq}", "seq": seq}, ensure_ascii=False))
                    continue
                if json.loads(msg).get("type") == "end":
                    conn.send(json.dumps({"type": "segment", "id": seg, "text": "오늘 3시 회의"}, ensure_ascii=False))
                    conn.send(json.dumps({"type": "final", "text": "오늘 3시 회의",
                                          "pending": 0 if self.refine_delay is None else 1}, ensure_ascii=False))
                    if self.refine_delay is not None:
                        time.sleep(self.refine_delay)
                        conn.send(json.dumps({"type": "refined", "text": "오늘 3시 회의입니다."}, ensure_ascii=False))
                    conn.send(json.dumps({"type": "done"}))
                    return
        except ConnectionClosed:
            return


class StreamTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.old = {k: os.environ.get(k) for k in ("AAS_USERS_FILE", "AAS_ALLOWED_HOSTS", "AAS_PODS_FILE", "AAS_OIDC_ISSUER", "AAS_TRUSTED_PROXY",
                                                  "AAS_STT_STREAM_URL", "AAS_STT_STREAM_KEY")}
        for k in cls.old:
            os.environ.pop(k, None)
        root = Path(TMP.name)
        for name in ("a", "b"):
            (root / f"home_{name}" / "profiles" / "work").mkdir(parents=True, exist_ok=True)
        reg = root / "pods.json"
        reg.write_text(json.dumps({"admins": [ADMIN], "pods": [
            {"id": "a", "owner": ALICE, "hermes_home": str(root / "home_a")},
            {"id": "b", "owner": BOB, "hermes_home": str(root / "home_b")}]}))
        users = root / "users.json"
        users.write_text(json.dumps({"users": [{"email": ALICE, "password_hash": "x"}]}))
        server._auth = auth.Auth({"issuer": "https://accounts.google.com", "client_id": "", "client_secret": "", "domain": "",
                                  "public_url": "http://localhost:17900", "hours": 1, "users_file": users})
        server._registry = pods.Registry(reg)
        cls.httpd = aasserver.start()
        cls.url = f"ws://127.0.0.1:{cls.httpd.server_port}{stt_stream.PATH}"
        cls.origin = f"http://127.0.0.1:{cls.httpd.server_port}"

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        for k, v in cls.old.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        server._auth = server._registry = None

    def setUp(self):
        # 시험마다 새 엔진을 띄운다. 한 엔진을 함께 쓰면 앞 시험의 연결 처리(늦은 ready·끊김)가 다음 시험까지 남아
        # Jenkins(python:3.12, 느린 노드)에서만 「정상」·「끊기면」 시험이 깨졌다(cogentai-aas #514, 2026-11-01).
        self.engine = FakeEngine()
        self.env = mock.patch.dict(os.environ, {"AAS_STT_STREAM_URL": f"ws://127.0.0.1:{self.engine.port}/v1/audio/transcriptions/stream",
                                                "AAS_STT_STREAM_KEY": "engine-secret"})
        self.env.start()
        self.logs = []
        self.log = mock.patch.object(stt_stream.store, "log_usage", side_effect=lambda kind, note, pod="": kind == "chat_transcribe_stream" and self.logs.append((kind, note, pod)))
        self.log.start()

    def tearDown(self):
        self.log.stop()
        self.env.stop()
        deadline = time.time() + 5
        while stt_stream.active() and time.time() < deadline:        # 다음 시험이 한도를 물려받지 않게
            time.sleep(0.02)
        self.engine.server.shutdown()
        self.assertEqual(stt_stream.active(), 0)

    # ---- 도우미 ----------------------------------------------------------------
    def open(self, email=ALICE, query="?pod=a&profile=default", origin=None):
        h = {"Cookie": f"aas_session={server.auth()._new_session(email, email.split('@')[0])}"} if email else {}
        return connect(self.url + query, origin=self.origin if origin is None else origin, additional_headers=h, open_timeout=5)

    def started(self, c, rate=16000):
        c.send(json.dumps({"type": "start", "lang": "ko", "sample_rate": rate}))
        return self.next(c)

    def next(self, c, timeout=5.0):
        return json.loads(c.recv(timeout=timeout))

    def until_closed(self, c, timeout=5.0):
        """닫힐 때까지 읽어 (받은 메시지들, close 코드)."""
        got = []
        deadline = time.time() + timeout
        try:
            while time.time() < deadline:
                got.append(json.loads(c.recv(timeout=max(0.05, deadline - time.time()))))
        except ConnectionClosed:
            pass
        return got, c.close_code

    def wait_logs(self, n=1):
        deadline = time.time() + 5
        while len(self.logs) < n and time.time() < deadline:
            time.sleep(0.02)
        return self.logs

    # ---- 정상 ------------------------------------------------------------------
    def test_정상이면_메시지를_그대로_중계하고_사용_기록에는_누가_프로파일_초만(self):
        c = self.open()
        ready = self.started(c)
        self.assertEqual((ready["type"], ready["session"], ready["max_seconds"]), ("ready", "e1", 300))   # 엔진 600 과 AAS 300 중 작은 쪽
        for _ in range(10):
            c.send(CHUNK)
        interims = [self.next(c) for _ in range(10)]
        self.assertEqual([m["type"] for m in interims], ["interim"] * 10)
        self.assertEqual(interims[-1]["seq"], 10)
        c.send(json.dumps({"type": "end"}))
        got, code = self.until_closed(c)
        self.assertEqual([m["type"] for m in got], ["segment", "final", "done"])
        self.assertEqual(got[0], {"type": "segment", "id": 0, "text": "오늘 3시 회의"})
        self.assertEqual(code, 1000)
        self.assertEqual(self.engine.headers, ["Bearer engine-secret"])                  # 엔진 키는 서버만 가진다
        self.assertEqual(self.engine.received[0], {"type": "start", "lang": "ko", "sample_rate": 16000})
        self.assertEqual(sum(1 for m in self.engine.received if isinstance(m, bytes)), 10)
        logs = self.wait_logs()
        self.assertEqual(logs, [("chat_transcribe_stream", f"{ALICE} default 1s", "a")])
        self.assertNotIn("회의", logs[0][1])

    def test_ready_의_max_seconds_는_엔진_값이_작으면_엔진_값(self):
        self.engine.max_seconds = 120
        c = self.open()
        self.assertEqual(self.started(c)["max_seconds"], 120)
        c.close()

    def test_ready_전에_보낸_소리도_버리지_않고_엔진에_보낸다(self):
        self.engine.delay = 0.5
        c = self.open()
        c.send(json.dumps({"type": "start", "lang": "ko", "sample_rate": 16000}))
        for _ in range(3):
            c.send(CHUNK)                                   # ready 전
        self.assertEqual(self.next(c)["type"], "ready")
        self.assertEqual([self.next(c)["type"] for _ in range(3)], ["interim"] * 3)
        c.close()

    def test_엔진_주소가_http_로_적혀도_ws_로_바꾸고_경로가_없으면_기본_경로(self):
        with mock.patch.dict(os.environ, {"AAS_STT_STREAM_URL": "http://speech-stt:9040"}):
            self.assertEqual(stt_stream.engine_url(), "ws://speech-stt:9040/v1/audio/transcriptions/stream")
        with mock.patch.dict(os.environ, {"AAS_STT_STREAM_URL": "https://e.example/x"}):
            self.assertEqual(stt_stream.engine_url(), "wss://e.example/x")

    # ---- 서버 전용 거절 -----------------------------------------------------------
    def test_Origin_이_다르면_forbidden_4403(self):
        c = self.open(origin="http://evil.example")
        got, code = self.until_closed(c)
        self.assertEqual((got[0]["type"], got[0]["code"], code), ("error", "forbidden", 4403))
        self.assertEqual(self.engine.headers, [])

    def test_로그인하지_않았으면_unauthorized_4401(self):
        c = self.open(email=None)
        got, code = self.until_closed(c)
        self.assertEqual((got[0]["code"], code), ("unauthorized", 4401))

    def test_볼_수_없는_에이전트나_없는_프로파일이면_forbidden(self):
        for email, query in ((BOB, "?pod=a&profile=default"), (ALICE, "?pod=a&profile=nope"), (ALICE, "?pod=zz&profile=default")):
            c = self.open(email=email, query=query)
            got, code = self.until_closed(c)
            self.assertEqual((got[0]["code"], code), ("forbidden", 4403), (email, query))
        self.assertEqual(self.engine.headers, [])

    def test_스트리밍을_켜지_않은_설치는_disabled(self):
        with mock.patch.dict(os.environ, {"AAS_STT_STREAM_URL": ""}):
            c = self.open()
            got, code = self.until_closed(c)
        self.assertEqual((got[0]["code"], code), ("disabled", 4404))

    # ---- 한도 ------------------------------------------------------------------
    def test_한_사람은_동시에_하나만_두번째는_busy(self):
        c1 = self.open()
        self.assertEqual(self.started(c1)["type"], "ready")
        c2 = self.open()
        got, code = self.until_closed(c2)
        self.assertEqual((got[0]["code"], code), ("busy", 1013))
        c1.close()

    def test_서버_동시_한도를_넘으면_다른_사람도_busy(self):
        with mock.patch.dict(os.environ, {"AAS_TRANSCRIBE_STREAMS": "1"}):
            c1 = self.open()
            self.assertEqual(self.started(c1)["type"], "ready")
            c2 = self.open(email=BOB, query="?pod=b&profile=work")
            got, _ = self.until_closed(c2)
            self.assertEqual(got[0]["code"], "busy")
            c1.close()

    def test_최대_길이를_넘으면_남은_구간을_보낸_뒤_too_long(self):
        with mock.patch.dict(os.environ, {"AAS_STT_STREAM_MAX_SECONDS": "1"}):
            c = self.open()
            self.assertEqual(self.started(c)["max_seconds"], 1)
            for _ in range(15):                             # 1.5초
                c.send(CHUNK)
            got, code = self.until_closed(c)
        kinds = [m["type"] for m in got]
        self.assertIn("segment", kinds)
        self.assertEqual(got[-1]["code"], "too_long")
        self.assertNotIn("final", kinds)                    # 엔진의 final·done 대신 too_long
        self.assertNotIn("done", kinds)
        self.assertLess(kinds.index("segment"), len(kinds) - 1)
        self.assertEqual(sum(1 for m in self.engine.received if isinstance(m, bytes)), 10)   # 한도 뒤 소리는 엔진에 보내지 않는다
        self.assertIn(json.dumps({"type": "end"}), self.engine.received)
        self.assertEqual(code, 1000)

    def test_refined_는_final_과_done_사이에_그대로_넘긴다(self):
        self.engine.refine_delay = 0.2
        c = self.open()
        self.started(c)
        c.send(CHUNK)
        c.send(json.dumps({"type": "end"}))
        got, _ = self.until_closed(c)
        self.assertEqual([m["type"] for m in got if m["type"] != "interim"], ["segment", "final", "refined", "done"])
        self.assertEqual(got[-2]["text"], "오늘 3시 회의입니다.")

    def test_최대_길이에서는_엔진의_2차_인식을_기다리지_않고_final_에서_too_long(self):
        # 2026-11-01-001 D25: 엔진은 final 뒤 최대 10초 2차 인식을 기다린다. AAS 한도로 끝낼 때는 그 사이 화면이
        # 녹음 중으로 보이지 않도록 final 을 받는 즉시 too_long 으로 닫는다
        self.engine.refine_delay = 3.0
        with mock.patch.dict(os.environ, {"AAS_STT_STREAM_MAX_SECONDS": "1"}):
            c = self.open()
            self.started(c)
            for _ in range(15):
                c.send(CHUNK)
            t = time.monotonic()
            got, _ = self.until_closed(c)
        self.assertEqual(got[-1]["code"], "too_long")
        self.assertNotIn("refined", [m["type"] for m in got])
        self.assertLess(time.monotonic() - t, 2.0)

    def test_소리가_오지_않으면_idle(self):
        with mock.patch.dict(os.environ, {"AAS_STT_STREAM_IDLE_SECONDS": "0.4"}):
            c = self.open()
            self.assertEqual(self.started(c)["type"], "ready")
            got, _ = self.until_closed(c)
        self.assertEqual(got[-1]["code"], "idle")

    def test_start_형식이_틀리거나_16kHz_가_아니면_bad_audio(self):
        c = self.open()
        self.assertEqual(self.started(c, rate=48000)["code"], "bad_audio")
        c2 = self.open()
        c2.send(CHUNK)                                      # start 보다 소리가 먼저
        got, code = self.until_closed(c2)
        self.assertEqual((got[0]["code"], code), ("bad_audio", 4400))

    def test_엔진이_끊기면_engine(self):
        self.engine.mode = "crash"
        c = self.open()
        self.assertEqual(self.started(c)["type"], "ready")
        c.send(CHUNK)
        got, code = self.until_closed(c)
        self.assertEqual((got[-1]["code"], code), ("engine", 1011))

    def test_엔진에_연결하지_못하면_engine(self):
        with mock.patch.dict(os.environ, {"AAS_STT_STREAM_URL": "ws://127.0.0.1:9/v1/audio/transcriptions/stream"}):
            c = self.open()
            c.send(json.dumps({"type": "start", "lang": "ko", "sample_rate": 16000}))
            got, _ = self.until_closed(c, timeout=15)
        self.assertEqual(got[-1]["code"], "engine")

    def test_엔진의_오류는_그대로_넘긴다(self):
        self.engine.mode = "refuse"
        c = self.open()
        c.send(json.dumps({"type": "start", "lang": "ko", "sample_rate": 16000}))
        got, _ = self.until_closed(c)
        self.assertEqual(got, [{"type": "error", "code": "busy", "message": "engine full"}])

    def test_ready_전_버퍼가_2MB_를_넘으면_busy(self):
        self.engine.delay = 3.0
        c = self.open()
        c.send(json.dumps({"type": "start", "lang": "ko", "sample_rate": 16000}))
        big = b"\x00" * 32000                               # 1초 조각 — 길이 한도(300초) 안에서 버퍼만 넘긴다
        try:
            for _ in range(70):
                c.send(big)
        except ConnectionClosed:
            pass
        got, code = self.until_closed(c)
        self.assertEqual((got[-1]["code"], code), ("busy", 1013))


class StatusFlagTest(unittest.TestCase):
    def test_chat_status_는_스트리밍_여부와_최대_길이를_알린다(self):
        hub = SimpleNamespace(status=lambda: {"connected": True})
        with mock.patch.object(server, "hub", return_value=hub), mock.patch.object(server, "workspace_for", return_value=None), \
                mock.patch.object(server.primary, "primary_of", return_value="main"), mock.patch.object(server, "_pod_owner_name", return_value=""), \
                mock.patch.object(server.cron_health.hr, "profiles", return_value=[]), mock.patch.object(server, "_agents", return_value=[]), \
                mock.patch.object(server.chat_default, "resolve", return_value="main"):
            pod = SimpleNamespace(id="tp", hermes_home=Path(TMP.name))
            with mock.patch.dict(os.environ, {"AAS_STT_STREAM_URL": "ws://e:9040", "AAS_STT_STREAM_MAX_SECONDS": "120"}):
                out = server._chat_status(pod)
                self.assertEqual((out["stt_stream"], out["stt_stream_max_seconds"]), (True, 120))
            with mock.patch.dict(os.environ, {"AAS_STT_STREAM_URL": ""}):
                out = server._chat_status(pod)
                self.assertEqual((out["stt_stream"], out["stt_stream_max_seconds"]), (False, 300))


if __name__ == "__main__":
    unittest.main()

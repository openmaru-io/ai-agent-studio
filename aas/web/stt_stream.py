# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""스트리밍 받아쓰기 중계 WS /api/chat/transcribe/stream (OMAI-1554, 계약 docs-plan/deploy/stt-stream-protocol.md 2026-10-31-002).

브라우저 ──(세션 쿠키·Origin)── 이 라우트 ──(Authorization: Bearer AAS_STT_STREAM_KEY)── speech 엔진 WS.
두 구간의 메시지 모양은 같다. 여기서는 인증·프로파일 권한·동시 한도·길이·유휴·버퍼 상한·사용 기록만 하고 메시지는 그대로 넘긴다.
바꾸는 것은 `ready` 의 max_seconds(엔진 값과 AAS_STT_STREAM_MAX_SECONDS 중 작은 쪽)와 AAS 가 직접 만드는 오류뿐이다.

- 거절은 핸드셰이크를 받아들인 뒤 {"type":"error"} + 앱 close 코드로 한다(ws.py 관례 — 브라우저는 핸드셰이크 HTTP 상태를 볼 수 없다).
  허용되지 않은 Host 만 받아들이기 전에 닫는다.
- 소리와 글은 저장하지 않는다. 사용 기록 chat_transcribe_stream 에는 누가·프로파일·초만 남긴다(chat_transcribe 와 같은 꼴).
- 동시 한도는 이 서버 한 대의 값이다(AAS_TRANSCRIBE_STREAMS 4, 사람당 AAS_TRANSCRIBE_STREAMS_PER_USER 1). 여러 서버를 합친 상한은
  엔진의 STT_STREAM_SLOTS 가 지킨다(엔진이 busy 를 보내면 그대로 넘긴다).
- 엔진에 보낼 소리는 큐에 쌓고 보내기 태스크 하나가 보낸다. `ready` 전에 온 소리와 엔진이 늦게 받는 소리가 같은 큐다 — 2MB 를 넘으면 busy.
- 이벤트 루프를 막지 않는다: 엔진 연결은 websockets 의 asyncio 클라이언트(Dockerfile·Makefile 의 websockets==17.2, 새 의존성 없음),
  로그인·등록부·프로파일 목록·사용 기록 같은 동기 코드는 스레드 풀에서 부른다.
"""
from __future__ import annotations

import asyncio
import collections
import json
import os
import time
import uuid
from urllib.parse import urlsplit, urlunsplit

from starlette.concurrency import run_in_threadpool
from starlette.routing import WebSocketRoute
from starlette.websockets import WebSocket, WebSocketDisconnect

from ..auth.auth import _cookie
from ..common import store
from ..common.i18n import tr
from ..hermes.hermes_api import HermesError
from . import protocol, server

PATH = "/api/chat/transcribe/stream"
ENGINE_PATH = "/v1/audio/transcriptions/stream"
SAMPLE_RATE = 16000
BYTES_PER_SECOND = SAMPLE_RATE * 2          # PCM16 모노
BUFFER_MAX = 2 * 1024 * 1024                # 계약 §4: ready 전·엔진 지연 버퍼. 넘으면 busy
CONNECT_TIMEOUT = 10.0
FINISH_TIMEOUT = 30.0                        # end 뒤 엔진이 final·done 을 보낼 때까지(남은 구간 확정)
SEND_TIMEOUT = 10.0
ENGINE_MAX_MSG = 1024 * 1024

# 오류 코드 → 앱 close 코드. 화면은 오류 메시지의 code 를 보고, close 코드는 로그·도구용이다
CLOSE = {"unauthorized": protocol.UNAUTHORIZED, "forbidden": protocol.FORBIDDEN, "disabled": 4404, "bad_audio": protocol.BAD_REQUEST,
         "busy": protocol.TRY_AGAIN, "too_long": protocol.NORMAL, "idle": protocol.NORMAL, "engine": protocol.INTERNAL}


def _env_int(name: str, default: int) -> int:
    try:
        return max(1, int(os.environ.get(name, str(default))))
    except ValueError:
        return default


def _env_float(name: str, default: float) -> float:
    try:
        v = float(os.environ.get(name, str(default)))
        return v if v > 0 else default
    except ValueError:
        return default


def engine_url() -> str:
    """AAS_STT_STREAM_URL. 비면 스트리밍을 쓰지 않는 설치다(화면은 일괄 경로만). http(s) 로 적어도 ws(s) 로 바꾸고, 경로가 없으면 엔진 기본 경로를 붙인다."""
    raw = os.environ.get("AAS_STT_STREAM_URL", "").strip()
    if not raw:
        return ""
    u = urlsplit(raw)
    scheme = {"http": "ws", "https": "wss"}.get(u.scheme, u.scheme)
    path = u.path if u.path not in ("", "/") else ENGINE_PATH
    return urlunsplit((scheme, u.netloc, path, u.query, ""))


def enabled() -> bool:
    return bool(engine_url())


def max_seconds() -> int:
    """AAS 쪽 최대 길이(AAS_STT_STREAM_MAX_SECONDS, 기본 300). ready 에는 엔진 값과 작은 쪽을 담는다."""
    return _env_int("AAS_STT_STREAM_MAX_SECONDS", 300)


def idle_seconds() -> float:
    """소리·end 가 이만큼 오지 않으면 idle(계약 §4, 엔진과 같은 15초)."""
    return _env_float("AAS_STT_STREAM_IDLE_SECONDS", 15.0)


# ---- 동시 한도(이벤트 루프 안에서만 바꾼다) ------------------------------------------
_active = 0
_per_user: dict[str, int] = collections.defaultdict(int)


def _acquire(who: str) -> bool:
    global _active
    if _active >= _env_int("AAS_TRANSCRIBE_STREAMS", 4) or _per_user[who] >= _env_int("AAS_TRANSCRIBE_STREAMS_PER_USER", 1):
        return False
    _active += 1
    _per_user[who] += 1
    return True


def _release(who: str) -> None:
    global _active
    _active = max(0, _active - 1)
    _per_user[who] -= 1
    if _per_user[who] <= 0:
        _per_user.pop(who, None)


def active() -> int:
    """시험·지표용: 지금 열린 스트림 수."""
    return _active


# ---- 대상 프로파일(기존 받아쓰기와 같은 권한) -------------------------------------------
def _target(a, user, pod_q: str, profile_q: str, cookie: str) -> tuple[object, str, str]:
    """(pod, 프로파일, 거절 코드). 기존 POST /api/chat/transcribe 와 같다: pod 를 주면 허용 목록(_chat_pod)에서, 없으면 쿠키로 고른
    지금 에이전트. 프로파일은 _chat_profile 로 고쳐 읽고 그 에이전트에 있는 것만. 스레드 풀에서 부른다(등록부·사이드카 읽기)."""
    pod = server._chat_pod(a, user, pod_q) if pod_q else server.registry().pick(user, a.enabled, _cookie(cookie, server.POD_COOKIE))
    if pod is None:
        return None, "", "forbidden"
    profile = server._chat_profile(pod, profile_q)
    try:
        known = {p.name for p in server.cron_health.hr.profiles(pod.hermes_home)}
    except (OSError, HermesError):                  # 사이드카에 닿지 않는다 — 화면은 일괄 경로로 넘어가 그쪽 문구를 보인다
        return pod, profile, "engine"
    if profile not in known:
        return pod, profile, "forbidden"
    return pod, profile, ""


def _message(code: str) -> str:
    return {
        "unauthorized": tr("로그인이 필요합니다", "Sign in required"),
        "forbidden": tr("이 프로파일에서 받아쓰기를 쓸 수 없습니다", "You cannot use transcription with this profile"),
        "disabled": tr("실시간 받아쓰기가 설정되지 않았습니다", "Live transcription is not set up"),
        "bad_audio": tr("소리 형식이 올바르지 않습니다", "The audio format is not valid"),
        "busy": tr("지금 실시간 받아쓰기가 많습니다", "Too many live transcriptions right now"),
        "too_long": tr("최대 길이에 닿아 받아쓰기를 끝냈습니다", "Transcription stopped at the maximum length"),
        "idle": tr("소리가 오지 않아 받아쓰기를 끝냈습니다", "Transcription stopped because no audio arrived"),
        "engine": tr("음성 인식 서버에 연결할 수 없습니다", "Cannot reach the speech recognition server"),
    }.get(code, code)


class _Relay:
    """연결 하나. 세 태스크(브라우저 읽기, 엔진 읽기, 엔진 보내기)와 유휴 감시가 돌고, 먼저 끝을 정한 쪽의 결과로 닫는다."""

    def __init__(self, ws: WebSocket):
        self.ws = ws
        self.engine = None
        self.queue: collections.deque = collections.deque()     # 엔진에 보낼 것: bytes(소리) 또는 str(end 등 텍스트)
        self.qbytes = 0
        self.wake = asyncio.Event()
        self.ready = asyncio.Event()
        self.over = asyncio.Event()
        self.outcome: tuple[str, str] | None = None             # ("done", "") 또는 ("error", 코드)
        self.audio_bytes = 0
        self.last_audio = time.monotonic()
        self.ended = False                                     # 브라우저가 end 를 보냈다(또는 AAS 가 길이 한도로 대신 보냈다)
        self.too_long = False
        self.limit = max_seconds()
        self.send_lock = asyncio.Lock()

    @property
    def seconds(self) -> float:
        return self.audio_bytes / BYTES_PER_SECOND

    def finish(self, kind: str, code: str = "") -> None:
        if self.outcome is None:
            self.outcome = (kind, code)
        self.over.set()

    async def to_client(self, text: str) -> None:
        async with self.send_lock:
            await asyncio.wait_for(self.ws.send_text(text), timeout=SEND_TIMEOUT)

    def push(self, item) -> bool:
        size = len(item) if isinstance(item, bytes) else 0
        if self.qbytes + size > BUFFER_MAX:
            return False
        self.queue.append(item)
        self.qbytes += size
        self.wake.set()
        return True

    # ---- 브라우저 → 엔진 큐 ----------------------------------------------------------
    async def client_reader(self) -> None:
        while True:
            msg = await self.ws.receive()
            if msg["type"] == "websocket.disconnect":
                self.finish("gone")
                return
            data, text = msg.get("bytes"), msg.get("text")
            if data is not None:
                if self.ended:
                    continue                                    # end 뒤 소리는 버린다
                self.last_audio = time.monotonic()
                if self.audio_bytes + len(data) > self.limit * BYTES_PER_SECOND:
                    self._stop_for_length()
                    continue
                self.audio_bytes += len(data)
                if not self.push(bytes(data)):
                    self.finish("error", "busy")
                    return
            elif text is not None:
                try:
                    m = json.loads(text)
                except ValueError:
                    continue
                if isinstance(m, dict) and m.get("type") == "end" and not self.ended:
                    self.ended = True
                    self.last_audio = time.monotonic()
                    self.push(json.dumps({"type": "end"}))

    def _stop_for_length(self) -> None:
        """AAS 쪽 길이 한도: 엔진에 end 를 대신 보내 남은 구간을 확정받고, final·done 대신 too_long 으로 닫는다(계약 §2)."""
        if self.ended:
            return
        self.ended = self.too_long = True
        self.push(json.dumps({"type": "end"}))

    async def engine_writer(self) -> None:
        await self.ready.wait()
        while True:
            while self.queue:
                item = self.queue.popleft()
                if isinstance(item, bytes):
                    self.qbytes -= len(item)
                await self.engine.send(item)
            self.wake.clear()
            await self.wake.wait()

    # ---- 엔진 → 브라우저 ------------------------------------------------------------
    async def engine_reader(self) -> None:
        from websockets.exceptions import ConnectionClosed
        try:
            while True:
                raw = await self.engine.recv()
                if isinstance(raw, bytes):
                    continue
                try:
                    m = json.loads(raw)
                except ValueError:
                    continue
                kind = m.get("type") if isinstance(m, dict) else None
                if kind == "ready":
                    try:
                        engine_max = int(m.get("max_seconds") or self.limit)
                    except (TypeError, ValueError):
                        engine_max = self.limit
                    self.limit = max(1, min(self.limit, engine_max))
                    await self.to_client(json.dumps({"type": "ready", "session": str(m.get("session") or uuid.uuid4().hex[:12]),
                                                     "max_seconds": self.limit}))
                    self.ready.set()
                    if self.audio_bytes > self.limit * BYTES_PER_SECOND:   # 엔진 값이 더 작아 이미 넘었다
                        self._stop_for_length()
                    continue
                if self.too_long and kind in ("final", "done", "refined"):
                    # final 에서 바로 끝낸다. 엔진은 final 뒤 2차 인식을 최대 10초 기다리는데(스펙 2026-11-01-001 D9),
                    # done 까지 기다리면 그동안 화면이 녹음 중으로 보인다(D25). 엔진의 2차 요청은 연결이 닫혀 끊긴다
                    self.finish("error", "too_long")
                    return
                await self.to_client(raw)                       # 그대로 넘긴다(interim·segment·final·error)
                if kind == "done":
                    self.finish("done")
                    return
                if kind == "error":
                    self.finish("relayed")
                    return
        except ConnectionClosed:
            self.finish("error", "engine")

    async def idle_watch(self) -> None:
        while True:
            await asyncio.sleep(min(1.0, idle_seconds() / 4))
            now = time.monotonic()
            if self.ended:
                if now - self.last_audio > FINISH_TIMEOUT:      # end 를 보냈는데 엔진이 끝맺지 않는다
                    self.finish("error", "engine")
                    return
            elif now - self.last_audio > idle_seconds():
                self.finish("error", "idle")
                return


async def _send_error(ws: WebSocket, code: str) -> None:
    try:
        await asyncio.wait_for(ws.send_text(json.dumps({"type": "error", "code": code, "message": _message(code)}, ensure_ascii=False)),
                               timeout=SEND_TIMEOUT)
        await ws.close(CLOSE.get(code, protocol.NORMAL))
    except (WebSocketDisconnect, RuntimeError, OSError, asyncio.TimeoutError):
        pass


async def _first_message(ws: WebSocket) -> dict | None:
    """첫 메시지 start. 형식이 틀리거나 16kHz 가 아니면 None(bad_audio). 시간 안에 오지 않으면 asyncio.TimeoutError."""
    msg = await asyncio.wait_for(ws.receive(), timeout=idle_seconds())
    if msg["type"] == "websocket.disconnect":
        raise WebSocketDisconnect()
    text = msg.get("text")
    if text is None:
        return None
    try:
        m = json.loads(text)
    except ValueError:
        return None
    if not isinstance(m, dict) or m.get("type") != "start":
        return None
    rate = m.get("sample_rate", SAMPLE_RATE)
    if isinstance(rate, bool) or rate != SAMPLE_RATE:
        return None
    lang = m.get("lang") or "ko"
    if not isinstance(lang, str) or len(lang) > 16:
        return None
    return {"type": "start", "lang": lang, "sample_rate": SAMPLE_RATE}


async def endpoint(ws: WebSocket) -> None:
    from . import ws as ws_mod
    view = ws_mod._View(ws)
    if not view._host_ok():
        await ws.close(protocol.POLICY)                    # 받아들이기 전에 닫는다(HTTP 403)
        return
    await ws.accept()
    from .app import draining
    if draining():                                           # 다른 서버로 — 화면은 busy 를 일괄 경로로 받는다
        await _send_error(ws, "busy")
        return
    refused, user = await ws_mod.admit(ws, view)
    if refused:
        await _send_error(ws, "forbidden" if refused == "origin" else "unauthorized")
        return
    if not enabled():
        await _send_error(ws, "disabled")
        return
    a = server.auth()
    pod_q, profile_q = ws.query_params.get("pod", ""), ws.query_params.get("profile", "")
    pod, profile, why = await run_in_threadpool(_target, a, user, pod_q, profile_q, ws.headers.get("cookie", ""))
    if why:
        await _send_error(ws, why)
        return
    who = str((user or {}).get("email") or "local").lower()
    if not _acquire(who):
        await _send_error(ws, "busy")
        return
    relay = None
    try:
        try:
            start = await _first_message(ws)
        except asyncio.TimeoutError:
            await _send_error(ws, "idle")
            return
        except WebSocketDisconnect:
            return
        if start is None:
            await _send_error(ws, "bad_audio")
            return
        relay = _Relay(ws)
        await _run(relay, start)
    finally:
        _release(who)
        if relay is not None:
            secs = int(round(relay.seconds))
            await run_in_threadpool(store.log_usage, "chat_transcribe_stream", f"{who} {profile} {secs}s", pod.id)   # 소리·글은 남기지 않는다(계약 §5)


async def _run(relay: _Relay, start: dict) -> None:
    from websockets.asyncio.client import connect
    from websockets.exceptions import WebSocketException
    key = os.environ.get("AAS_STT_STREAM_KEY", "").strip()
    reader = asyncio.create_task(relay.client_reader())     # 엔진에 붙는 동안에도 소리를 받아 큐에 쌓는다(계약 §2 ready 전 버퍼)
    tasks = [reader]
    try:
        try:
            relay.engine = await asyncio.wait_for(
                connect(engine_url(), additional_headers={"Authorization": f"Bearer {key}"} if key else None,
                        open_timeout=CONNECT_TIMEOUT, max_size=ENGINE_MAX_MSG, ping_interval=20, ping_timeout=20),
                timeout=CONNECT_TIMEOUT + 1)
            await relay.engine.send(json.dumps(start))
        except (OSError, asyncio.TimeoutError, WebSocketException) as exc:
            print(f"받아쓰기 스트림: 엔진에 연결하지 못했습니다 ({type(exc).__name__})", flush=True)   # i18n-ignore: 로그
            relay.finish("error", "engine")
        if relay.outcome is None:
            tasks += [asyncio.create_task(relay.engine_reader()), asyncio.create_task(relay.engine_writer()),
                      asyncio.create_task(relay.idle_watch())]
            for t in tasks:
                t.add_done_callback(lambda t: _task_done(relay, t))
            await relay.over.wait()
    finally:
        for t in tasks:
            t.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        if relay.engine is not None:
            try:
                await asyncio.wait_for(relay.engine.close(), timeout=2)
            except (OSError, asyncio.TimeoutError, WebSocketException):
                pass
    kind, code = relay.outcome or ("gone", "")
    if kind == "error":
        await _send_error(relay.ws, code)
    elif kind in ("done", "relayed"):
        try:
            await relay.ws.close(protocol.NORMAL)
        except (RuntimeError, OSError):
            pass


def _task_done(relay: _Relay, t: asyncio.Task) -> None:
    """태스크가 예외로 끝났다(엔진 쪽 보내기 실패 등). 브라우저 쪽 실패는 끊긴 것으로 본다."""
    if t.cancelled() or relay.outcome is not None:
        return
    exc = t.exception()
    if exc is None:
        return
    if isinstance(exc, (WebSocketDisconnect, RuntimeError, asyncio.TimeoutError)) and t.get_coro().__name__ == "client_reader":
        relay.finish("gone")
    else:
        relay.finish("error", "engine")


def routes() -> list:
    return [WebSocketRoute(PATH, endpoint)]

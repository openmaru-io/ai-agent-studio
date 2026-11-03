# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""웹소켓 엔드포인트 /ws (OMAI-1100). 탭마다 연결 하나에 토픽 구독을 다중화한다.

- 거절은 핸드셰이크를 받아들인 뒤 앱 close 코드(4401·4403·4409·1012·1013)로 한다. 브라우저는 핸드셰이크의 HTTP 상태 코드를 볼 수 없다.
  허용되지 않은 Host 와 기능 꺼짐만 받아들이기 전에 닫는다.
- Origin 은 반드시 있어야 하고 실제 접속 주소와 scheme·호스트·포트가 같아야 한다(웹소켓에는 X-AAS 헤더가 없어 이것이 유일한 출처 방어다).
- 소켓에 쓰는 것은 연결마다 보내기 태스크 하나뿐이다. 생산자는 큐에 넣기만 하고 막히지 않는다(COP Console OKE-1265 교착을 피한다).
- 송신 큐는 연결마다 256개·1MB, 서버 전체 64MB(AAS_WS_SEND_BUDGET_MB). 넘으면 큐가 가장 큰 연결을 1013 으로 닫는다.
- 연결 생존은 프로토콜 ping(uvicorn 20/20초)이 본다. 앱 단계 무수신 한도는 150초다(숨겨진 탭의 타이머가 1분 단위로 늦어져도 끊지 않는다).
"""
from __future__ import annotations

import asyncio
import collections
import math
import os
import random
import re
import time
import uuid
from urllib.parse import urlsplit

from starlette.concurrency import run_in_threadpool
from starlette.routing import WebSocketRoute
from starlette.websockets import WebSocket, WebSocketDisconnect

from ..auth.auth import COOKIE as _SESSION_COOKIE, _cookie
from ..common import i18n, settings
from ..market import skill_desc
from ..ops import notices
from . import protocol, server, topics

STARTED = int(time.time())          # 서버가 바뀌면 브라우저가 모든 토픽을 스냅샷부터 다시 받는다
HB_SECONDS = 20
HELLO_TIMEOUT = 10.0
SEND_TIMEOUT = 10.0
SESSION_CHECK = 60.0
RATE_PER_SECOND = 50
SUBS_PER_CONN = 100
QUEUE_MSGS = 256
QUEUE_BYTES = 1024 * 1024


def _env_int(name: str, default: int) -> int:
    try:
        return max(1, int(os.environ.get(name, str(default))))
    except ValueError:
        return default


def enabled() -> bool:
    return server.ws_enabled()


def idle_limit() -> float:
    return float(_env_int("AAS_WS_IDLE_SECONDS", 150))


class _View:
    """Handler 의 Host·프록시 판정 메서드를 웹소켓 요청에 그대로 쓴다(규칙을 두 벌 두지 않는다)."""
    _host_ok = server.Handler._host_ok
    _trusts_proxy = server.Handler._trusts_proxy
    _effective_host = server.Handler._effective_host
    _secure_request = server.Handler._secure_request

    def __init__(self, ws: WebSocket):
        self.headers = ws.headers
        self.client_address = tuple(ws.client or ("", 0))
        self._https = ws.url.scheme == "wss"

    def _tls(self) -> bool:
        return self._https


def origin_ok(view: _View) -> bool:
    origin = view.headers.get("origin") or ""
    if not origin or origin == "null":
        return False
    fetch_site = view.headers.get("sec-fetch-site")
    if fetch_site and fetch_site != "same-origin":
        return False
    u = urlsplit(origin)
    return u.scheme == ("https" if view._secure_request() else "http") and u.netloc.lower() == view._effective_host().lower()


class Conn:
    def __init__(self, ws: WebSocket, manager: "Manager", user: dict | None, ctx: dict, cookie: str):
        self.id = uuid.uuid4().hex[:12]
        self.ws, self.manager, self.user, self.ctx, self.cookie = ws, manager, user, ctx, cookie
        self.email = str((user or {}).get("email") or "").lower()
        self.topics: set = set()                        # 허브가 관리하는 (토픽, 언어) 키
        self.queue: collections.deque = collections.deque()
        self.qbytes = 0
        self.wake = asyncio.Event()
        self.drained = asyncio.Event()                  # 큐가 비었다(보내기 태스크가 켠다) — room() 이 기다린다
        self.drained.set()
        self.closing: tuple[int, str] | None = None
        self.closed = asyncio.Event()
        self.last_recv = time.monotonic()
        self.started = time.monotonic()
        self.last_gap: dict[str, float] = {}
        self.req_slots = asyncio.Semaphore(8)
        self.tasks: set = set()
        self.pub_window, self.pub_count = 0.0, 0
        self.people_window, self.people_count = 0.0, 0     # 사람 신호(office:people) 속도 제한 — 걸음이 신호를 밀어내지 않게 따로 센다

    # ---- 보내기(루프 스레드에서만) -------------------------------------------------
    def push(self, topic: str, msg: str, kind: str) -> None:
        if self.closing is not None:
            return
        size = len(msg.encode("utf-8"))
        if kind == "snap":                              # 상태 토픽은 합친다: 큐에 남은 같은 토픽의 snap 을 새 값으로 바꾼다
            for i, (t, k, m, sz) in enumerate(self.queue):
                if t == topic and k == "snap":
                    self.queue[i] = (topic, kind, msg, size)
                    self._account(size - sz)
                    self.wake.set()
                    return
        self.queue.append((topic, kind, msg, size))
        self._account(size)
        self.drained.clear()
        if (len(self.queue) > QUEUE_MSGS or self.qbytes > QUEUE_BYTES) and kind == "delta" and topic:
            self._overflow_events(topic)                 # 이벤트 토픽: 그 토픽의 남은 delta 를 버리고 gap 뒤 스냅샷부터
        if len(self.queue) > QUEUE_MSGS or self.qbytes > QUEUE_BYTES:
            self.close_with(protocol.TRY_AGAIN, "slow_client")
        else:
            self.manager.check_budget()
        self.wake.set()

    def _overflow_events(self, topic: str) -> None:
        now = time.monotonic()
        if now - self.last_gap.get(topic, -60.0) < 5.0:      # 다시 맞춘 뒤에도 곧바로 넘친다 — 이 연결은 따라오지 못한다
            return
        self.last_gap[topic] = now
        kept = collections.deque()
        for item in self.queue:
            if item[0] == topic and item[1] in ("delta", "event-snap"):
                self._account(-item[3])
            else:
                kept.append(item)
        self.queue = kept
        gap = protocol.encode("gap", topic=topic)
        self.queue.append((topic, "gap", gap, len(gap)))
        self._account(len(gap))
        self.manager.stats["gaps"] += 1
        self.manager.loop.create_task(topics.hub().resync(topic, self))

    async def room(self) -> None:
        """큐가 절반을 넘었으면 빌 때까지 기다린다(최대 SEND_TIMEOUT). 밀린 이벤트를 한꺼번에 넣으면 보내기 태스크가
        비울 틈이 없어 큐가 넘치고 1013 slow_client 로 닫혔다 — 화면은 같은 토픽을 다시 구독해 끝없이 다시 붙었다(2026-10-23 OKE).
        정말 읽지 않는 연결은 기다린 뒤에도 큐가 차서 지금처럼 닫힌다."""
        if self.closing is not None or (len(self.queue) <= QUEUE_MSGS // 2 and self.qbytes <= QUEUE_BYTES // 2):
            return
        try:
            await asyncio.wait_for(self.drained.wait(), timeout=SEND_TIMEOUT)
        except asyncio.TimeoutError:
            pass

    def _account(self, delta: int) -> None:
        self.qbytes += delta
        self.manager.total += delta

    def close_with(self, code: int, reason: str, retry_after_ms: int | None = None) -> None:
        """남은 큐를 버리고 bye 를 보낸 뒤 닫는다(보내기 태스크가 한다)."""
        if self.closing is not None:
            return
        self.closing = (code, reason)
        self._account(-self.qbytes)
        self.queue.clear()
        fields = {"code": code, "reason": reason}
        if retry_after_ms is not None:
            fields["retry_after_ms"] = retry_after_ms
        self.queue.append(("", "bye", protocol.encode("bye", **fields), 0))
        self.wake.set()

    async def sender(self) -> None:
        try:
            while True:
                while self.queue:
                    _t, _k, msg, size = self.queue.popleft()
                    self._account(-size)
                    await asyncio.wait_for(self.ws.send_text(msg), timeout=SEND_TIMEOUT)
                self.drained.set()
                if self.closing is not None:
                    await asyncio.wait_for(self.ws.close(self.closing[0]), timeout=SEND_TIMEOUT)
                    return
                self.wake.clear()
                await self.wake.wait()
        except asyncio.TimeoutError:                     # 상대가 읽지 않는다(수신 버퍼 가득) — 끊는다
            self.closing = self.closing or (protocol.TRY_AGAIN, "send_timeout")
            self.manager.stats["send_timeouts"] += 1
        except (WebSocketDisconnect, RuntimeError, OSError):
            pass                                          # 쓰기 실패(EPIPE·ECONNRESET) — 받기 루프도 끝낸다
        finally:
            self._account(-self.qbytes)
            self.queue.clear()
            self.drained.set()
            self.closed.set()


class Manager:
    """연결 목록·사용자별 상한·서버 전체 송신 예산·종료 정리. 루프 스레드에서만 상태를 바꾼다."""

    def __init__(self, loop: asyncio.AbstractEventLoop):
        self.loop = loop
        self.conns: dict[str, Conn] = {}
        self.by_user: dict[str, list[Conn]] = collections.defaultdict(list)
        self.total = 0
        self.per_user = _env_int("AAS_WS_PER_USER", 10)
        self.max_conns = _env_int("AAS_WS_MAX", 500)
        self.budget = _env_int("AAS_WS_SEND_BUDGET_MB", 64) * 1024 * 1024
        self.stats = collections.Counter()

    def add(self, conn: Conn) -> bool:
        if len(self.conns) >= self.max_conns:
            return False
        mine = self.by_user[conn.email or "local"]
        while len([c for c in mine if c.closing is None]) >= self.per_user:
            oldest = next(c for c in mine if c.closing is None)
            oldest.close_with(protocol.REPLACED, "replaced")
            self.stats["replaced"] += 1
        mine.append(conn)
        self.conns[conn.id] = conn
        return True

    def remove(self, conn: Conn) -> None:
        self.conns.pop(conn.id, None)
        mine = self.by_user.get(conn.email or "local", [])
        if conn in mine:
            mine.remove(conn)
        if not mine:
            self.by_user.pop(conn.email or "local", None)

    def check_budget(self) -> None:
        while self.total > self.budget:
            biggest = max((c for c in self.conns.values() if c.closing is None), key=lambda c: c.qbytes, default=None)
            if biggest is None or biggest.qbytes == 0:
                return
            biggest.close_with(protocol.TRY_AGAIN, "server_busy")
            self.stats["budget_kicks"] += 1

    async def drain(self) -> None:
        """종료 신호: 모든 연결에 bye 1012(새 파드가 뜨는 시간을 반영해 5~30초 뒤에 다시 붙으라고)를 보내고 최대 5초 기다린다."""
        for c in list(self.conns.values()):
            c.close_with(protocol.RESTART, "restart", retry_after_ms=random.randint(5000, 30000))
        waits = [c.closed.wait() for c in self.conns.values()]
        if waits:
            await asyncio.wait([asyncio.ensure_future(w) for w in waits], timeout=5)

    async def user_changed(self, email: str) -> None:
        """권한·세션이 바뀐 사용자의 연결을 다시 검사한다: 세션이 없으면 4401, 관리자 권한을 잃었으면 4403, 볼 수 없게 된 토픽은 해지."""
        for conn in list(self.by_user.get(email.lower(), [])):
            if conn.closing is not None:
                continue
            a = server.auth()
            user = await run_in_threadpool(a.user, conn.cookie) if a.enabled else conn.user
            if a.enabled and not user:
                conn.close_with(protocol.UNAUTHORIZED, "session_ended")
                continue
            admin = await run_in_threadpool(_is_admin, user, a.enabled)
            if conn.ctx["admin"] and not admin:
                conn.close_with(protocol.FORBIDDEN, "admin_revoked")
                continue
            conn.user = user
            conn.ctx.update(user=user, admin=admin)
            for name in await topics.hub().recheck(conn):
                conn.push(name, protocol.encode("error", code="forbidden", topic=name), "error")


REPORT_SECONDS = 600


async def _report(m: Manager) -> None:
    """운영 지표를 10분마다 한 줄 남긴다(그 사이 연결이 있었을 때만). 메시지마다 로그를 남기지 않는다."""
    seen = 0
    while True:
        await asyncio.sleep(REPORT_SECONDS)
        seen = max(seen, len(m.conns))
        if not seen and not m.stats:
            continue
        hub = topics.hub()
        subs = sum(len(c.topics) for c in m.conns.values())
        counts = " ".join(f"{k}={v}" for k, v in sorted(m.stats.items()))
        print(f"웹소켓: 연결 {len(m.conns)} 사용자 {len(m.by_user)} 구독 {subs} 큐 {m.total}B {counts} "   # i18n-ignore: 로그
              f"토픽 읽기 {hub.stats['reads']} 실패 {hub.stats['failures']} 시간초과 {hub.stats['timeouts']} "   # i18n-ignore: 로그
              f"늦음최대 {hub.stats['lag_max']:.1f}s 동시최대 {hub.stats['in_flight_max']}", flush=True)   # i18n-ignore: 로그
        m.stats.clear()
        hub.stats.update(failures=0, timeouts=0, lag_max=0.0, in_flight_max=0)
        seen = len(m.conns)


def _is_admin(user, auth_enabled: bool) -> bool:
    return (not auth_enabled) or server.registry().is_admin(user)


_manager: Manager | None = None


def pod_changed(session: str, pod_id: str) -> None:
    """HTTP 로 볼 POD 를 바꾼 뒤 부른다(어느 스레드에서도). 같은 로그인 세션의 열린 연결이 쓰는 쿠키의 aas_pod 를 새 값으로 바꾼다.
    연결 읽기(req)는 연결을 열 때의 쿠키로 요청을 다시 만들기 때문에, 이것이 없으면 화면이 새로고침 없이 에이전트를 바꾼 뒤에도
    옛 에이전트의 값을 읽는다(2026-10-18). 로그인 쿠키는 그대로 두므로 다른 세션·다른 사람의 연결은 건드리지 않는다."""
    m = _manager
    if m is None or not session:
        return
    for conn in list(m.conns.copy().values()):                          # 루프 스레드가 목록을 바꿀 수 있어 복사본을 돈다
        if _cookie(conn.cookie, _SESSION_COOKIE) == session:
            conn.cookie = _with_cookie(conn.cookie, server.POD_COOKIE, pod_id)


def _with_cookie(header: str, name: str, value: str) -> str:
    kept = [p.strip() for p in str(header or "").split(";") if p.strip() and p.strip().partition("=")[0] != name]
    return "; ".join([*kept, f"{name}={value}"])


def manager() -> Manager:
    """이벤트 루프마다 하나(시험은 시험 클래스마다 새 루프로 서버를 띄운다)."""
    global _manager
    loop = asyncio.get_running_loop()
    if _manager is None or _manager.loop is not loop:
        _manager = Manager(loop)
        _manager.reporter = loop.create_task(_report(_manager))
        hub = topics.hub()
        hub.start(loop)
        hub.topics.clear()
        hub.events.clear()
    return _manager


def _user_changed_threadsafe(email: str) -> None:
    m = _manager
    if m is not None and not m.loop.is_closed():
        m.loop.call_soon_threadsafe(lambda: m.loop.create_task(m.user_changed(email)))


topics.on_user_changed(_user_changed_threadsafe)


# ---- 토픽 정의(본문 §8.2) ---------------------------------------------------------
def _pod(pid: str):
    return next((p for p in server.registry().pods if p.id == pid), None)


def _pod_allowed(ctx: dict, pid: str) -> bool:
    return any(p.id == pid for p in server.registry().allowed(ctx.get("user"), ctx.get("auth", False), restarting=True))   # 다시 뜨는 동안 구독을 끊지 않는다(2026-10-23-006)


def _agent_preparing(a: dict) -> bool:
    """아직 바뀌는 중인 에이전트(만드는 중·다시 뜨는 중·멈추는 중·다시 켜는 중). 실패와, 멈추라고 했고 멈춘 것은 끝난 상태다 —
    멈춘 에이전트를 준비 중으로 쳐 에이전트 화면을 연 동안 2초 반복이 끝나지 않았다(스펙 2026-10-26-002 §9-10)."""
    if a.get("ready") or a.get("phase") == "Failed":
        return False
    return not (a.get("phase") == "Suspended" and a.get("suspended"))


def _agents_source() -> dict:
    reg = server.registry()
    if any(_agent_preparing(a) for a in getattr(reg, "agents", [])):
        reg.refresh(ttl=0)                                  # 준비 중인 것이 있으면 쿠버네티스를 바로 다시 읽는다
    try:                                                    # 주 프로파일 상태가 바뀌면(main 준비 끝) 표의 「main 준비 중」을 내리도록 값에 넣는다(2026-10-19-001 D11)
        from ..fleet import primary
        states = {k: v.get("state") for k, v in primary.records().items()}
    except Exception:
        states = {}
    # 순차 롤아웃: 진행 중이면 5초마다 다시 읽고, 진행·이미지가 바뀌면 화면에 보낸다(스펙 2026-10-28-015 DD18)
    from ..fleet import k8s, rollouts
    if any(rollouts.blocking(r) for r in getattr(reg, "rollouts", [])):
        reg.refresh(ttl=0)
    client = k8s.client()
    images = {(i.get("metadata") or {}).get("name"): [(i.get("status") or {}).get("image"), (i.get("status") or {}).get("sidecarImage")]
              for i in (client.last_agents() if client else [])}
    return {"agents": [dict(a) for a in getattr(reg, "agents", [])], "error": reg.error, "primary": states,
            "rollouts": [{"name": (r.get("metadata") or {}).get("name"), "spec": r.get("spec"), "status": r.get("status")} for r in getattr(reg, "rollouts", [])],
            "images": images}


def _agents_interval(value) -> float:
    preparing = value and any(_agent_preparing(a) for a in value.get("agents", []))
    return 2.0 if preparing else 5.0


def _health_source(pid: str):
    def read():
        pod = _pod(pid)
        if pod is None:
            raise LookupError(pid)
        return server.health_payload(pod)
    return read


def _office_access(ctx: dict):
    from ..office import office_access
    return office_access, office_access.Access(server.registry(), ctx.get("user"), ctx.get("auth", False))


def _office_snapshot(ctx: dict):
    from ..common import store
    with store.request_memo():                           # 보기 범위(Access)와 스냅샷이 같은 DB 읽기를 한 번만(스펙 2026-10-24-006 §6)
        _mod, acc = _office_access(ctx)
        snap = server._office_snapshot_for(acc)
    return snap["seq"], snap


def _office_batch(events: list, ctx: dict) -> list:
    """오피스 이벤트 한 묶음을 이 사람에게 보낼 내용으로 바꾼다(종류별 공개 범위, 계획 007 §3-2). 보내지 않으면 번호만 건너뛴다.
    공개 범위는 로그인 정보(이메일·관리자)만 쓰므로 묶음마다 등록부·DB 를 다시 읽지 않는다(계획 007 M1)."""
    from ..office import office_access
    user = ctx.get("user") or {}
    email = str(user.get("email") or "").lower()
    admin = (not ctx.get("auth", False)) or server.registry().is_admin(user)
    out = []
    for ev in events:
        view = office_access.event_view(ev["type"], ev["payload"], email, admin)
        out.append(None if view is None else {"type": ev["type"], "payload": view})
    return out


OFFICE_SPEC = topics.EventSpec(after=lambda seq, wait: server.OFFICE.bus.after(seq, wait=wait), oldest=lambda: server.OFFICE.bus.oldest(),
                               head=lambda: server.OFFICE.bus.seq, snapshot=_office_snapshot, batch_view=_office_batch)


def _presence_snapshot(ctx: dict):
    user = ctx.get("user") or {}
    me = str(user.get("email") or "").lower()
    admin = (not ctx.get("auth", False)) or server.registry().is_admin(user)
    seq = server.PRESENCE_BUS.seq
    return seq, {"people": server.PRESENCE.view(me, admin)}


PRESENCE_SPEC = topics.EventSpec(after=lambda seq, wait: server.PRESENCE_BUS.after(seq, wait=wait), oldest=lambda: server.PRESENCE_BUS.oldest(),
                                 head=lambda: server.PRESENCE_BUS.seq, snapshot=_presence_snapshot)
PUB_PER_SECOND = 4                           # 걸음은 1초에 4번까지 — 넘으면 조용히 버린다(다음 걸음이 곧 온다)
_SIT = re.compile(r"[A-Za-z0-9_.:-]{0,80}")


PEOPLE_PUB_PER_SECOND = 2                    # 사람 신호는 들어옴·이름·얼굴·탭 바뀜 때만 온다 — 넘으면 조용히 버린다


async def _on_people_pub(conn: "Conn", msg: dict) -> None:
    """사람 신호(스펙 2026-10-26-001 §4-2 서버 3). data: {"beat": "<보는 탭>"} 또는 {"leave": true}. 이메일은 연결의 로그인 정보로만 쓴다."""
    now = time.monotonic()
    if now - conn.people_window >= 1.0:
        conn.people_window, conn.people_count = now, 0
    conn.people_count += 1
    if conn.people_count > PEOPLE_PUB_PER_SECOND:
        return
    d = msg.get("data") if isinstance(msg.get("data"), dict) else {}
    beat = d.get("beat")
    if not d.get("leave") and not isinstance(beat, str):
        conn.push("", protocol.encode("error", code="bad_pub"), "error")
        return
    await run_in_threadpool(server.office_people_pub, conn.id, conn.user or {}, {"leave": bool(d.get("leave")), "beat": beat or ""})


async def _on_pub(conn: "Conn", msg: dict) -> None:
    """내 아바타 위치를 공유 DB 에 쓴다(계획 007 P6b). 다른 토픽에는 쓰지 못한다.
    알리는 일은 서버마다 도는 server.presence_tick 이 한다 — 다른 서버에 붙은 사람도 같은 길로 받는다."""
    if msg.get("topic") == "office:people" and conn.email:
        await _on_people_pub(conn, msg)
        return
    if msg.get("topic") != "office:presence" or not conn.email:
        conn.push("", protocol.encode("error", code="bad_pub"), "error")
        return
    now = time.monotonic()
    if now - conn.pub_window >= 1.0:
        conn.pub_window, conn.pub_count = now, 0
    conn.pub_count += 1
    if conn.pub_count > PUB_PER_SECOND:
        return
    d = msg.get("data") if isinstance(msg.get("data"), dict) else {}
    try:
        x, y, f = (float(d.get(k)) for k in ("x", "y", "f"))
    except (TypeError, ValueError):
        conn.push("", protocol.encode("error", code="bad_pub"), "error")
        return
    sit = d.get("sit") if isinstance(d.get("sit"), str) else ""
    if not all(math.isfinite(v) and -10000 <= v <= 10000 for v in (x, y, f)) or not _SIT.fullmatch(sit):
        conn.push("", protocol.encode("error", code="bad_pub"), "error")
        return
    await run_in_threadpool(server.PRESENCE.move, conn.email, x, y, f, sit)   # 오피스 신호가 없는 사람의 걸음은 쓰이지 않는다


def _chat_spec(pid: str, sid: str) -> topics.EventSpec:
    def chat_hub():
        pod = _pod(pid)
        if pod is None:
            raise LookupError(pid)
        return server.hub(pod)

    def allowed(ctx: dict) -> bool:
        # 거절하면 화면은 SSE 로 바꿔 받는다. 거절 이유는 로그에 남긴다 — 답이 화면에 오지 않던 일(2026-10-14)을 다음에는 로그로 가린다
        who = (ctx.get("user") or {}).get("email", "")
        topic = f"pod:{pid}:chat:{sid}"
        if not _pod_allowed(ctx, pid):
            print(f"대화 구독 거절 ({topic}, {who}): 이 사용자가 볼 수 없는 POD 입니다", flush=True)   # i18n-ignore: 로그
            return False
        try:
            chat_hub().events_after(sid, 10**12, wait=0)       # 모르는 세션이면 ChatUnavailable(이 서버 프로세스가 만든 세션이 아니다)
        except Exception as exc:
            print(f"대화 구독 거절 ({topic}, {who}): {type(exc).__name__}: {exc}", flush=True)   # i18n-ignore: 로그
            return False
        return True

    def all_events() -> list:
        return chat_hub().events_after(sid, 0, wait=0)

    def oldest() -> int:
        evs = all_events()
        return evs[0]["seq"] if evs else 1

    def head() -> int:
        evs = all_events()
        return evs[-1]["seq"] if evs else 0
    return topics.EventSpec(after=lambda seq, wait: chat_hub().events_after(sid, seq, wait=wait), oldest=oldest, head=head, allowed=allowed)


def _meeting_spec(room: int) -> topics.Spec:
    def allowed(ctx: dict) -> bool:
        _mod, acc = _office_access(ctx)
        try:
            acc.require_room(room)
        except Exception:
            return False
        return True
    # 정리 전 죽은 서버의 기다림(stale)도 짧게 — 「받지 못함」 줄이 곧 온다(스펙 2026-10-20-030 DR7)
    # 회의방 화면을 떠나면 30초만 더 돈다 — 5분 동안 회의마다 view() 를 다시 읽었다(스펙 2026-10-26-002 R8)
    return topics.Spec(source=lambda: server.office_meeting().view(room, 0), allowed=allowed,
                       interval=lambda v: 1.5 if v and (v.get("pending") or v.get("stale")) else 5.0, warm=30.0)


def _kanban_spec(board: str) -> topics.Spec:
    from ..office import hub_auto

    def source():
        status, out = hub_auto.route(server.office_auto(), "GET", f"{hub_auto.KANBAN}/board", {"board": [board]}, {})
        if status >= 400:
            raise RuntimeError(f"kanban {status}")
        return out

    def view(value, ctx: dict):
        _mod, acc = _office_access(ctx)
        if acc.admin:
            return value
        visible = acc.visible_aliases()                # 보이지 않는 자리 앞으로 된 카드는 보드에서 뺀다(HTTP 와 같은 규칙)
        return {**value, "columns": [{**c, "tasks": [t for t in c["tasks"] if not t.get("assignee") or t["assignee"] in visible]}
                                     for c in value.get("columns", [])]}
    return topics.Spec(source=source, view=view, interval=lambda _v: 5.0)


def _market_spec(pid: str) -> topics.Spec:
    from ..market import marketplace

    def waiting(v) -> bool:
        return bool(v) and any(r.get("status") in ("queued", "running") for r in v.get("requests", []))
    def view(v, ctx):
        # REST(/api/market)와 같은 설치 권한을 넣는다. 빠지면 이 값이 REST 값을 덮어 주인 단추가 꺼진다(OMAI-1126 리뷰 R1)
        admin = bool(ctx.get("admin"))
        pod = next((p for p in server.registry().pods if p.id == pid), None)
        # 패키지 요약 번역(스펙 2026-10-19-017 §9). 토픽은 언어별이고 view 는 그 언어로 불린다 — REST 에만 붙이면 이 값이 덮어 영어로 돌아간다
        return {**v, "admin": admin, "can_install": admin or server._manages_pod(pod, ctx.get("user"), ctx.get("auth", False)),
                "packages": skill_desc.apply(v.get("packages"), 400, field="summary")}
    return topics.Spec(source=lambda: marketplace.overview(pid),
                       view=view,
                       allowed=lambda ctx: _pod_allowed(ctx, pid), interval=lambda v: 5.0 if waiting(v) else 60.0)


def _mcp_login_interval(value) -> float:
    """로그인이 끝나 가는 동안(logging_in)은 2초, 그 밖에는 30초. 시작·취소·성공은 invalidate 로 곧바로 다시 읽는다(14-22)."""
    servers = (value or {}).get("servers") or {}
    return 2.0 if any((s or {}).get("state") == "logging_in" for s in servers.values()) else 30.0


def _mcp_login_spec(pid: str, profile: str) -> topics.Spec:
    from ..ops import mcp_oauth_relay

    def source():
        pod = _pod(pid)
        if pod is None:
            raise LookupError(pid)
        return server.mcp_login_snapshot(pod, profile)

    def view(value, ctx: dict):
        me = mcp_oauth_relay._user_key(ctx.get("user") if ctx.get("auth") else None)[0]
        out = {}
        for name, ls in (value.get("servers") or {}).items():
            ls = dict(ls)
            by = ls.pop("_by", None)
            if by is not None:
                ls["mine"] = bool(by) and by == me
            out[name] = ls
        return {"servers": out}
    return topics.Spec(source=source, view=view, allowed=lambda ctx: _pod_allowed(ctx, pid), interval=_mcp_login_interval)


def _ctx_email(ctx: dict) -> str:
    return str((ctx.get("user") or {}).get("email") or "").lower() if ctx.get("auth") else ""


def _inbox_spec(email: str) -> topics.Spec:
    """받은편지함 신호(스펙 2026-10-17-004 D9). 값은 공유 DB 쪽 항목의 바뀜 번호뿐이고, 화면은 번호가 바뀌면 /api/office/inbox 를 다시 읽는다.
    구독은 그 이메일이 로그인한 사람일 때만(로그인을 끈 실행은 local)."""
    me = "" if email == "local" else email

    def allowed(ctx: dict) -> bool:
        return server.inbox_topic(_ctx_email(ctx)) == f"office:inbox:{email}"
    return topics.Spec(source=lambda: server.office_inbox_signal(me), allowed=allowed, interval=lambda _v: 15.0, per_lang=False)


def _cards_spec() -> topics.Spec:
    """3D 카드 신호(스펙 2026-10-17-004 D10). 화면은 값이 바뀌면 /api/office/cards 를 다시 읽는다(거르기는 HTTP 가 한다)."""
    return topics.Spec(source=server.office_cards_signal, interval=lambda _v: 15.0, per_lang=False)


def _office_people_spec() -> topics.Spec:
    """사람 목록(스펙 2026-10-26-001 §4-2). 읽기는 토픽마다 한 번, 구독자마다 REST 와 같은 규칙(_office_people_from)으로 거른다.
    값이 같으면(보는 탭·위치만 바뀌면) 구독자 view 를 다시 만들지 않는다(리뷰 D11·D12). 보조 주기 10초가 신호가 끊긴 사람을 뺀다(D5)."""
    def view(value, ctx: dict):
        _mod, acc = _office_access(ctx)
        return {"people": server._office_people_from(value["rows"], acc)}
    return topics.Spec(source=server.office_people_source, view=view, interval=lambda _v: 10.0, per_lang=False,
                       same=server.office_people_same)


def _office_changed_spec() -> topics.Spec:
    """오피스 정보 변경 번호(스펙 2026-10-26-001 §4-1). 값은 {n, admin} 번호 둘뿐이고 모든 구독자가 같은 값을 받는다(R-A).
    화면은 번호가 바뀌면 자기 권한으로 /api/office 를 다시 읽는다. 바꾼 서버·다른 서버는 invalidate 로 곧바로, 놓치면 30초 주기로 맞춘다."""
    from ..office import office_changed
    return topics.Spec(source=office_changed.value, interval=lambda _v: 30.0, per_lang=False)


def _meeting_active_spec() -> topics.Spec:
    """진행 중인 회의(스펙 2026-10-17-004). 읽기는 한 번, 구독자마다 방 구성원으로 거른다(HTTP 와 같은 meeting_active_for)."""
    def view(value, ctx: dict):
        _mod, acc = _office_access(ctx)
        return server.meeting_active_for(value, acc)
    return topics.Spec(source=server.office_meeting_active, view=view, interval=_meeting_active_interval)


def _meeting_active_interval(value) -> float:
    """답을 기다리는 회의가 있으면 1.5초. 없으면 회의 상태를 쓸 때 meeting 알림으로 곧바로 다시 읽으므로, 듣기 연결이 붙어 있으면 30초
    (알림을 놓칠 때의 받침), 아니면(SQLite·끊김) 지금처럼 5초(스펙 2026-10-26-002 R7)."""
    if any(r.get("pending") for r in (value or [])):
        return 1.5
    listener = server.SHARED_LISTENER
    return 30.0 if listener is not None and listener.connected else 5.0


def _notices_spec() -> topics.Spec:
    """관리자 공지(스펙 2026-10-24-007). 서버마다 5초에 한 번 읽고(R1, 지터는 허브가 붙인다), 구독자마다 대상 부서로 거른다.
    부서 맵은 source 가 한 번 만들고 view 는 찾기만 한다(R6). 맵은 사람에게 보내지 않는다. 로그인을 끈 실행은 전체 공지만(4-3)."""
    return topics.Spec(source=lambda: notices.topic_source(settings.departments()),
                       view=lambda v, ctx: notices.topic_view(v, _ctx_email(ctx)), interval=lambda _v: 5.0, per_lang=False)


TURN_IDLE = 5.0                              # 끝난 대화의 토픽이 새 조각을 기다리는 동안 쉬는 시간(쉬지 않고 돌지 않게, L3)


def _turn_spec(alias: str, tid: str) -> topics.EventSpec:
    """오피스 대화 답 조각(스펙 2026-10-17-004). seq 는 조각 번호(1부터)라 HTTP 의 after(앞에서 받은 조각 수)와 같다.
    조각마다 done 을 실어 화면이 끝을 알고 구독을 푼다."""
    def turn():
        t = server.office_auto().bridge.turn(tid, alias)
        if t is None:
            raise LookupError(tid)
        return t

    def allowed(ctx: dict) -> bool:
        _mod, acc = _office_access(ctx)
        try:
            acc.require_use(alias)
            turn()
        except Exception:
            return False
        return True

    def after(seq: int, wait: float) -> list:
        t = turn()
        items = t.after(seq, wait)
        if not items and t.done and wait:
            time.sleep(min(wait, TURN_IDLE))             # 끝났고 더 올 것이 없다 — 구독이 풀릴 때까지 쉰다
            return []
        out = []
        for i, (kind, *rest) in enumerate(items, start=seq + 1):
            if kind == "approval":
                payload = {"kind": "approval"}
            elif kind == "choices":                      # 되묻기 선택지 — HTTP turn 과 같은 모양(스펙 2026-10-23-005 R9)
                payload = {"kind": "choices", "questions": rest[0] if rest and isinstance(rest[0], list) else []}
            elif kind == "notice":                       # 스킬을 붙이지 못하고 글만 보냈다 — HTTP turn 과 같은 모양(스펙 2026-10-19-012 OV-H2)
                payload = {"kind": "notice", "code": "skill_failed", "name": getattr(t, "skill", ""), "reason": str(rest[0] if rest else "")}
            else:
                payload = {"kind": kind, "text": str(rest[0] if rest else "")[:8000]}
            out.append({"seq": i, "type": "item", "payload": {**payload, "done": kind in ("final", "failed")}})   # Turn.add 가 끝내는 조각과 같다
        return out
    return topics.EventSpec(after=after, oldest=lambda: 1, head=lambda: len(turn().items), allowed=allowed)


def resolve(name: str):
    """토픽 이름을 해석한다. 이벤트 루프에서 불리므로 막히는 일(등록부·DB)은 하지 않고, 돌려주는 함수 안으로 미룬다."""
    if name == "office:state":
        return OFFICE_SPEC
    if name == "office:presence":
        return PRESENCE_SPEC
    m = re.fullmatch(r"pod:([^:]{1,100}):chat:([A-Za-z0-9_.-]{1,100})", name)
    if m:
        return _chat_spec(m.group(1), m.group(2))
    if name == "office:meeting:active":
        return _meeting_active_spec()
    if name == "office:changed":
        return _office_changed_spec()
    if name == "office:people":
        return _office_people_spec()
    if name == "office:cards":
        return _cards_spec()
    m = re.fullmatch(r"office:inbox:([^\s:]{1,200})", name)
    if m:
        return _inbox_spec(m.group(1))
    m = re.fullmatch(r"office:chat:([^:]{1,100}):(run_[0-9a-f]{1,64})", name)
    if m:
        return _turn_spec(m.group(1), m.group(2))
    m = re.fullmatch(r"office:meeting:(\d{1,12})", name)
    if m:
        return _meeting_spec(int(m.group(1)))
    m = re.fullmatch(r"office:kanban:([A-Za-z0-9_.-]{1,100})", name)
    if m:
        return _kanban_spec(m.group(1))
    m = re.fullmatch(r"pod:([^:]{1,100}):market", name)
    if m:
        return _market_spec(m.group(1))
    m = re.fullmatch(r"pod:([^:]{1,100}):mcp:([A-Za-z0-9_-]{1,64})", name)
    if m:
        return _mcp_login_spec(m.group(1), m.group(2))
    if name == "notices":
        return _notices_spec()
    if name == "agents":
        return topics.Spec(source=_agents_source, view=lambda _v, ctx: server._agents_list(server.registry(), ctx.get("user"), ctx.get("auth", False)),
                           interval=_agents_interval)
    m = re.fullmatch(r"pod:([^:]{1,100}):health", name)
    if m:
        pid = m.group(1)
        return topics.Spec(source=_health_source(pid), view=lambda v, ctx: {**v, "dashboard_url": server.dashboard_url(ctx.get("host", ""))},
                           allowed=lambda ctx: _pod_allowed(ctx, pid), interval=lambda _v: 30.0)
    return None


_registered = False


def _register_topics() -> None:
    global _registered
    if not _registered:
        topics.hub().add(resolve)
        _registered = True


# ---- 엔드포인트 -------------------------------------------------------------------
async def endpoint(ws: WebSocket) -> None:
    view = _View(ws)
    if not enabled() or not view._host_ok():
        await ws.close(protocol.POLICY)                    # 받아들이기 전에 닫는다(HTTP 403)
        return
    m = manager()
    await ws.accept()
    from .app import draining
    a = server.auth()
    if draining():
        await _refuse(ws, protocol.RESTART, "restart", retry_after_ms=random.randint(5000, 30000))
        return
    refused, user = await admit(ws, view)
    if refused == "origin":
        m.stats["refused_origin"] += 1
        await _refuse(ws, protocol.FORBIDDEN, "origin")
        return
    cookie = ws.headers.get("cookie", "")
    if refused:
        m.stats["refused_auth"] += 1
        await _refuse(ws, protocol.UNAUTHORIZED, "login_required")
        return
    admin = await run_in_threadpool(_is_admin, user, a.enabled)
    ctx = {"user": user, "auth": a.enabled, "admin": admin, "host": ws.headers.get("host", ""), "lang": i18n.DEFAULT}
    conn = Conn(ws, m, user, ctx, cookie)
    if not m.add(conn):
        m.stats["refused_full"] += 1
        await _refuse(ws, protocol.TRY_AGAIN, "server_full", retry_after_ms=random.randint(5000, 30000))
        return
    _register_topics()
    sender = asyncio.create_task(conn.sender())
    ticker = asyncio.create_task(_ticker(conn))
    try:
        await _receive_loop(conn)
    finally:
        topics.hub().unsubscribe_all(conn)
        for task in list(conn.tasks):
            task.cancel()
        if conn.closing is None:
            conn.closing = (protocol.NORMAL, "closed")
        conn.wake.set()
        ticker.cancel()
        try:
            await asyncio.wait_for(sender, timeout=SEND_TIMEOUT + 1)
        except (asyncio.TimeoutError, asyncio.CancelledError):
            sender.cancel()
        m.remove(conn)
        server.PRESENCE.release(conn.id)                  # 이 연결이 붙잡던 사람은 서버가 더 쓰지 않는다 — TTL(30초) 뒤 빠진다(스펙 2026-10-26-001 D15)


async def admit(ws: WebSocket, view: _View | None = None) -> tuple[str, dict | None]:
    """받아들인 웹소켓의 Origin·세션 쿠키 검사. (거절 이유, 사용자). 이유는 ""(통과)·"origin"·"login_required".
    /ws 와 받아쓰기 스트림(stt_stream.py)이 함께 쓴다 — 출처·로그인 규칙을 두 벌 두지 않는다. 로그인이 꺼져 있으면 사용자는 None."""
    view = view or _View(ws)
    if not origin_ok(view):
        print(f"웹소켓 Origin 거절: {view.headers.get('origin', '')[:120]!r} host={view._effective_host()[:80]!r} path={ws.url.path[:60]!r}", flush=True)   # i18n-ignore: 로그
        return "origin", None
    a = server.auth()
    user = await run_in_threadpool(a.user, ws.headers.get("cookie", "")) if a.enabled else None
    if a.enabled and not user:
        return "login_required", None
    return "", user


async def _refuse(ws: WebSocket, code: int, reason: str, retry_after_ms: int | None = None) -> None:
    fields = {"code": code, "reason": reason}
    if retry_after_ms is not None:
        fields["retry_after_ms"] = retry_after_ms
    try:
        await ws.send_text(protocol.encode("bye", **fields))
        await ws.close(code)
    except (WebSocketDisconnect, RuntimeError, OSError):
        pass


async def _ticker(conn: Conn) -> None:
    """하트비트(20초), 무수신 감시(150초), 세션 확인(60초, 스레드에서)."""
    next_session = time.monotonic() + SESSION_CHECK
    a = server.auth()
    while conn.closing is None:
        await asyncio.sleep(HB_SECONDS)
        now = time.monotonic()
        if now - conn.last_recv > idle_limit():
            conn.close_with(protocol.GOING_AWAY, "idle")
            conn.manager.stats["idle_closed"] += 1
            return
        conn.push("", protocol.encode("hb", ts=int(time.time() * 1000)), "hb")
        if a.enabled and now >= next_session:
            next_session = now + SESSION_CHECK
            if not await run_in_threadpool(a.user, conn.cookie):
                conn.close_with(protocol.UNAUTHORIZED, "session_ended")
                return


async def _receive_loop(conn: Conn) -> None:
    ws, hub = conn.ws, topics.hub()
    window_start, count = time.monotonic(), 0
    hello = False
    while conn.closing is None:
        timeout = HELLO_TIMEOUT if not hello else None
        recv = asyncio.ensure_future(ws.receive())
        closed = asyncio.ensure_future(conn.closed.wait())
        done, _ = await asyncio.wait({recv, closed}, timeout=timeout, return_when=asyncio.FIRST_COMPLETED)
        if recv not in done:
            recv.cancel()
            closed.cancel()
            if not done:                                   # hello 가 10초 안에 오지 않았다
                conn.close_with(protocol.POLICY, "no_hello")
            return
        closed.cancel()
        message = recv.result()
        if message["type"] == "websocket.disconnect":
            return
        conn.last_recv = time.monotonic()
        if conn.last_recv - window_start >= 1.0:
            window_start, count = conn.last_recv, 0
        count += 1
        if count > RATE_PER_SECOND:
            conn.close_with(protocol.POLICY, "rate")
            return
        text = message.get("text")
        if text is None:
            conn.close_with(protocol.POLICY, "binary")
            return
        try:
            msg = protocol.parse(text)
        except protocol.ProtocolError as exc:
            conn.push("", protocol.encode("error", code="bad_message", reason=exc.reason), "error")
            continue
        t = msg["t"]
        if not hello and t != "hello":
            conn.close_with(protocol.POLICY, "hello_first")
            return
        if t == "hello":
            hello = True
            await _on_hello(conn, msg)
        elif t == "sub":
            await _on_sub(conn, msg.get("topic") or "", msg.get("after"))
        elif t == "unsub":
            hub.unsubscribe(msg.get("topic") or "", conn)
        elif t == "req":
            if conn.req_slots.locked():                          # 연결당 동시에 8개까지 — 넘으면 바로 거절해 화면이 HTTP 로 읽게 한다
                conn.push("", _req_error(msg.get("id") if isinstance(msg.get("id"), str) else None, "busy"), "res")
            else:
                task = asyncio.create_task(_run_req(conn, msg))
                conn.tasks.add(task)
                task.add_done_callback(conn.tasks.discard)
        elif t == "pub":
            await _on_pub(conn, msg)
        elif t == "ping":
            pass
        else:
            conn.manager.stats["unknown_type"] += 1         # 앞뒤 판이 섞여도 견딘다
            if conn.manager.stats["unknown_type"] == 1:
                print(f"웹소켓: 알 수 없는 메시지 종류 {t[:40]!r}", flush=True)   # i18n-ignore: 로그


async def _on_hello(conn: Conn, msg: dict) -> None:
    lang = i18n.parse_accept_language(str(msg.get("lang") or ""))
    if conn.ctx.get("hello"):                               # 언어를 바꿨다 — 언어별 토픽을 새로 구독한다
        topics.hub().unsubscribe_all(conn)
    conn.ctx.update(lang=lang, hello=True)
    conn.push("", protocol.encode("welcome", conn=conn.id, user=(conn.user or {}).get("email", ""), server=STARTED, hb=HB_SECONDS,
                                  limits={"subs": SUBS_PER_CONN, "msg_bytes": 64 * 1024, "rate": RATE_PER_SECOND}), "welcome")
    for item in (msg.get("resume") or [])[:SUBS_PER_CONN]:
        if isinstance(item, dict) and isinstance(item.get("topic"), str):
            after = item.get("after")
            await _on_sub(conn, item["topic"], after if isinstance(after, int) and not isinstance(after, bool) else None)


async def _on_sub(conn: Conn, topic: str, after: int | None) -> None:
    if len(conn.topics) >= SUBS_PER_CONN:
        conn.push(topic, protocol.encode("error", code="too_many_subs", topic=topic), "error")
        return
    err = await topics.hub().subscribe(topic, conn, after)
    if err:
        conn.push(topic, protocol.encode("error", code=err, topic=topic), "error")


REQ_MAX_BYTES = 512 * 1024                   # 넘으면 화면이 HTTP 로 다시 읽는다(큰 응답 하나가 송신 큐 1MB 를 차지하지 않게)
REQ_EXCLUDED = ("/api/office/stream", "/api/chat/events")
# Starlette 라우트만 처리하는 경로(옛 Handler 는 모른다). req 가 옛 Handler 로 보내면 404 not_found 가 나와, 화면이 HTTP 로 다시 읽지 못했다(OMAI-1204)
REQ_EXCLUDED_PREFIXES = ("/api/office/meeting/files", "/api/office/meeting/out", "/api/office/meeting/agent-file")


def _req_error(rid, code: str) -> str:
    return protocol.encode("res", id=rid, ok=False, error={"code": code, "reason": code, "message": ""})


async def _run_req(conn: Conn, msg: dict) -> None:
    async with conn.req_slots:
        await _on_req(conn, msg)


async def _on_req(conn: Conn, msg: dict) -> None:
    """한 번 읽기. method "get" 은 HTTP GET 과 같은 처리기(옛 Handler)를 이 연결의 쿠키·언어로 실행한다 —
    두 경로의 결과가 갈라지지 않는다. 응답은 {status, body} 다(HTTP 상태를 그대로 싣는다)."""
    rid = msg.get("id")
    if not isinstance(rid, str) or len(rid) > 40:
        conn.push("", _req_error(None, "bad_id"), "res")
        return
    params = msg.get("params") if isinstance(msg.get("params"), dict) else {}
    path = params.get("path")
    if msg.get("method") != "get":
        conn.push("", _req_error(rid, "unknown_method"), "res")
        return
    if not isinstance(path, str) or not path.startswith("/api/") or len(path) > 2000 or any(c in path for c in "\r\n ") \
            or path.split("?", 1)[0] in REQ_EXCLUDED or path.split("?", 1)[0].startswith(REQ_EXCLUDED_PREFIXES):
        conn.push("", _req_error(rid, "bad_path"), "res")
        return
    from . import legacy
    view = _View(conn.ws)
    headers = [("Host", conn.ws.headers.get("host", "")), ("Accept-Language", conn.ctx.get("lang", i18n.DEFAULT)),
               ("Cookie", conn.cookie), ("Sec-Fetch-Site", "same-origin")]
    for name in ("x-forwarded-host", "x-forwarded-proto", "x-forwarded-for"):     # 신뢰 판정은 Handler 가 한다(R1)
        if conn.ws.headers.get(name):
            headers.append((name, conn.ws.headers[name]))
    raw = ("GET " + path + " HTTP/1.1\r\n" + "".join(f"{k}: {v}\r\n" for k, v in headers if v) + "\r\n").encode("latin-1", "replace")
    handler = legacy.AdaptedHandler(raw, view.client_address, view._https)
    try:
        await run_in_threadpool(handler.run)
        out = handler.wfile.getvalue()
        if handler.stream is not None or not out:
            conn.push("", _req_error(rid, "not_readable"), "res")
            return
        status, _headers, body = legacy._parse(out)
    except Exception as exc:
        print(f"웹소켓 req 실패 {path[:80]}: {type(exc).__name__}", flush=True)   # i18n-ignore: 로그
        conn.push("", _req_error(rid, "internal"), "res")
        return
    if len(body) > REQ_MAX_BYTES:
        conn.push("", _req_error(rid, "too_large"), "res")
        return
    try:
        data = protocol.json.loads(body or b"null")
    except ValueError:
        conn.push("", _req_error(rid, "not_json"), "res")
        return
    conn.push("", protocol.encode("res", id=rid, ok=True, data={"status": status, "body": data}), "res")


async def drain() -> None:
    if _manager is not None:
        await _manager.drain()


def routes() -> list:
    from .app import on_drain
    on_drain(drain)
    return [WebSocketRoute("/ws", endpoint)]

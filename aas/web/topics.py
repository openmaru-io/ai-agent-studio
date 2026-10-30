# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""토픽 허브: 구독 중인 데이터를 미리 읽어 두고 바뀐 것만 밀어 보낸다(OMAI-1100).

- 토픽마다 읽기(source)는 한 번만 하고, 사용자마다 다른 범위는 거르기(view)로 나눈다.
- 읽기와 거르기는 전용 실행기(AAS_TOPIC_READERS, 기본 8)에서 돈다. 동시에 사이드카·쿠버네티스로 나가는 읽기는 8 을 넘지 않는다.
- 간격에 ±20% 지터를 넣고, 읽기 한 번에 15초 제한을 둔다. 실패하면 마지막 값을 stale 로 유지하고 간격을 2배씩(최대 5분) 늘린다.
- 마지막 구독자가 빠져도 5분 동안 새로 고침을 유지한다(화면을 오갈 때 기다리지 않게).
- 이벤트 루프 밖(동기 스레드)에서는 invalidate·user_changed 만 부른다. 나머지 상태는 루프 스레드에서만 바뀐다.
"""
from __future__ import annotations

import asyncio
import os
import random
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from typing import Any, Callable

from ..common import i18n, store
from . import protocol

_UNSET = object()


class Denied(Exception):
    """이 구독자는 이 토픽을 볼 수 없다."""


@dataclass
class Spec:
    source: Callable[[], Any]                          # 공유 읽기(스레드에서)
    view: Callable[[Any, dict], Any] | None = None     # 구독자별 거르기(스레드에서). Denied 를 내면 구독을 끊는다
    allowed: Callable[[dict], bool] | None = None      # 구독할 수 있는가(스레드에서)
    interval: Callable[[Any], float] = lambda _v: 30.0
    per_lang: bool = True                              # 문장이 언어에 따라 달라지면 언어마다 따로 읽는다
    # 값 비교 함수(스펙 2026-10-26-001 리뷰 D11). 주면 새로 읽은 값의 비교값이 지난 값과 같고 오류 상태도 같을 때 구독자 view 를 만들지 않는다.
    # 없으면 지금처럼 새로 고칠 때마다 모든 구독자 view 를 다시 만든다(보내기만 같은 값이면 생략). 구독자별 거르기가 무거운 토픽만 켠다
    same: Callable[[Any], Any] | None = None
    warm: float | None = None                          # 마지막 구독자가 떠난 뒤 더 도는 시간(초). None 이면 허브 기본값(스펙 2026-10-26-002 R8)


@dataclass(eq=False)
class Topic:
    name: str
    lang: str
    spec: Spec
    subs: dict = field(default_factory=dict)          # 구독자 → 마지막으로 보낸 view 문자열
    seq: int = 0
    value: Any = _UNSET
    error: str = ""
    sent_error: str = ""                               # 구독자에게 마지막으로 알린 실패 상태
    failures: int = 0
    read_at: float = 0.0
    warm_until: float = 0.0
    task: asyncio.Task | None = None
    wake: asyncio.Event = field(default_factory=asyncio.Event)
    reading: asyncio.Future | None = None             # 아직 도는 읽기(시간 한도를 넘겨 포기했어도 스레드는 돈다)


# ---- 이벤트 토픽(오피스·채팅) ------------------------------------------------------
@dataclass
class EventSpec:
    """번호가 붙은 이벤트 줄을 따라가는 토픽. 이어 받을 수 있으면 그 뒤 이벤트만, 아니면 스냅샷부터 보낸다."""
    after: Callable[[int, float], list]                     # (seq, 기다릴 초) → seq 보다 큰 이벤트들(막히는 호출)
    oldest: Callable[[], int]                                # 남아 있는 가장 오래된 seq(없으면 head+1)
    head: Callable[[], int]                                  # 지금까지 낸 마지막 seq
    snapshot: Callable[[dict], tuple[int, Any]] | None = None   # 구독자 문맥 → (seq, 스냅샷). 없으면 남은 이벤트를 처음부터 보낸다
    view: Callable[[dict, dict], Any] | None = None         # (이벤트, 문맥) → 보낼 data. None 이면 번호만 건너뛴다(skip)
    allowed: Callable[[dict], bool] | None = None
    batch_view: Callable[[list, dict], list] | None = None  # 한 묶음을 문맥 하나로 거른다(문맥을 매번 만들지 않게)


@dataclass(eq=False)
class EventTopic:
    name: str
    spec: EventSpec
    subs: dict = field(default_factory=dict)          # 구독자 → 마지막으로 보낸 seq(None 이면 준비 중)
    pending: dict = field(default_factory=dict)       # 준비 중인 구독자 → 그 사이 도착한 이벤트
    head: int = 0
    task: asyncio.Task | None = None


def _event_data(ev: dict) -> dict:
    return {"type": ev["type"], "payload": ev["payload"]}


class EventHubMixin:
    """Hub 에 이벤트 토픽을 더한다. 이벤트를 기다리는 일은 SSE 전용 실행기(legacy.stream_pool)에서 한다."""

    def _wait_pool(self):
        from . import legacy
        return legacy.stream_pool()

    async def subscribe_events(self, name: str, spec: EventSpec, sub, after: int | None) -> str:
        if spec.allowed is not None:
            try:
                ok = await self._call(spec.allowed, sub.ctx.get("lang", ""), sub.ctx)
            except Exception:
                ok = False
            if not ok:
                return "forbidden"
        topic = self.events.get(name)
        if topic is None:
            topic = self.events[name] = EventTopic(name, spec)
            topic.head = await self.loop.run_in_executor(self.pool, spec.head)
        if sub in topic.subs:
            return ""
        topic.subs[sub] = None
        topic.pending[sub] = []
        sub.topics.add(("event", name))
        if topic.task is None or topic.task.done():
            topic.task = self.loop.create_task(self._pump(topic))
        await self._catch_up(topic, sub, after)
        return ""

    async def _catch_up(self, topic: EventTopic, sub, after: int | None) -> None:
        spec, lang = topic.spec, sub.ctx.get("lang", "")
        oldest = await self.loop.run_in_executor(self.pool, spec.oldest)
        msgs: list[tuple[str, str]] = []                   # (종류, 메시지)
        if after is not None and after + 1 >= oldest:
            start = after
        elif spec.snapshot is not None:
            if after is not None:
                msgs.append(("gap", protocol.encode("gap", topic=topic.name)))
            seq, snap = await self._call(spec.snapshot, lang, sub.ctx)
            msgs.append(("event-snap", protocol.encode("snap", topic=topic.name, seq=seq, data={"type": "snapshot", "payload": snap})))
            start = seq
        else:
            if after is not None and after > 0:
                msgs.append(("gap", protocol.encode("gap", topic=topic.name)))
            start = 0
        events = await self.loop.run_in_executor(self._wait_pool(), spec.after, start, 0)
        msgs += [("delta", m) for m in await self._views(topic, sub, events)]
        if sub not in topic.subs:                          # 그사이 해지했다
            return
        last = events[-1]["seq"] if events else start
        for kind, m in msgs:
            await sub.room()                               # 한꺼번에 넣으면 큐가 넘쳐 1013 으로 닫힌다(2026-10-23) — 비울 틈을 준다
            if sub not in topic.subs:                      # 기다리는 사이 해지했거나 닫혔다
                return
            sub.push(topic.name, m, kind)
        while topic.pending.get(sub):                      # 준비하는 동안 펌프가 받은 이벤트 중 아직 안 보낸 것
            got, topic.pending[sub] = topic.pending[sub], []
            for ev in got:
                if ev["seq"] > last:
                    for m in await self._views(topic, sub, [ev]):
                        sub.push(topic.name, m, "delta")
                    last = ev["seq"]
            if sub not in topic.subs:
                return
        topic.pending.pop(sub, None)
        topic.subs[sub] = last

    async def _views(self, topic: EventTopic, sub, events: list) -> list[str]:
        if not events:
            return []
        spec, ctx = topic.spec, sub.ctx

        def build():
            i18n.set_lang(ctx.get("lang", "") or i18n.DEFAULT)
            if spec.batch_view is not None:
                datas = spec.batch_view(events, ctx)
            elif spec.view is not None:
                datas = [spec.view(ev, ctx) for ev in events]
            else:
                datas = [_event_data(ev) for ev in events]
            out = []
            for ev, data in zip(events, datas):
                if data is None:
                    out.append(protocol.encode("delta", topic=topic.name, seq=ev["seq"], skip=True))
                else:
                    out.append(protocol.encode("delta", topic=topic.name, seq=ev["seq"], data=data))
            return out
        return await self.loop.run_in_executor(self.pool, build)

    async def _pump(self, topic: EventTopic) -> None:
        try:
            while topic.subs:
                events = await self.loop.run_in_executor(self._wait_pool(), topic.spec.after, topic.head, 20.0)
                if not events:
                    continue
                topic.head = events[-1]["seq"]
                for sub in list(topic.subs):
                    sent = topic.subs.get(sub)
                    if sent is None:                          # 아직 스냅샷을 준비하는 중 — 모아 두었다가 이어 붙인다
                        if sub in topic.pending:
                            topic.pending[sub].extend(events)
                        continue
                    fresh = [e for e in events if e["seq"] > sent]
                    for m in await self._views(topic, sub, fresh):
                        sub.push(topic.name, m, "delta")
                    if sub in topic.subs and fresh:
                        topic.subs[sub] = fresh[-1]["seq"]
        except Exception as exc:
            print(f"이벤트 토픽 실패 {topic.name}: {type(exc).__name__}", flush=True)   # i18n-ignore: 로그
            for sub in list(topic.subs):                         # 채팅 세션이 닫힌 경우 등 — 구독자에게 알리고 끊는다
                self._drop_event(topic.name, sub)
                sub.push(topic.name, protocol.encode("error", code="topic_ended", topic=topic.name, reason=type(exc).__name__), "error")
        finally:
            if not topic.subs and self.events.get(topic.name) is topic:
                del self.events[topic.name]

    def _drop_event(self, name: str, sub) -> None:
        sub.topics.discard(("event", name))
        topic = self.events.get(name)
        if topic is not None:
            topic.subs.pop(sub, None)
            topic.pending.pop(sub, None)

    async def resync(self, name: str, sub) -> None:
        """송신 큐가 넘쳐 이 구독자의 delta 를 버렸다: 스냅샷(없으면 남은 이벤트 처음)부터 다시 보낸다."""
        topic = self.events.get(name)
        if topic is None or sub not in topic.subs:
            return
        topic.subs[sub] = None
        topic.pending[sub] = []
        await self._catch_up(topic, sub, None)



def _env_int(name: str, default: int) -> int:
    try:
        return max(1, int(os.environ.get(name, str(default))))
    except ValueError:
        return default


class Hub(EventHubMixin):
    def __init__(self, readers: int | None = None, timeout: float = 15.0, warm: float = 300.0, max_backoff: float = 300.0):
        self.readers = readers or _env_int("AAS_TOPIC_READERS", 8)
        self.timeout, self.warm, self.max_backoff = timeout, warm, max_backoff
        self.pool = ThreadPoolExecutor(max_workers=self.readers, thread_name_prefix="aas-topic")
        self.loop: asyncio.AbstractEventLoop | None = None
        self.sem: asyncio.Semaphore | None = None
        self.topics: dict[tuple[str, str], Topic] = {}
        self.events: dict[str, EventTopic] = {}
        self.resolvers: list[Callable[[str], Spec | None]] = []
        self.stats = {"reads": 0, "failures": 0, "timeouts": 0, "lag_max": 0.0, "in_flight": 0, "in_flight_max": 0}

    # ---- 설정 ----------------------------------------------------------------
    def start(self, loop: asyncio.AbstractEventLoop) -> None:
        self.loop = loop
        self.sem = asyncio.Semaphore(self.readers)

    def add(self, resolver: Callable[[str], Spec | None]) -> None:
        self.resolvers.append(resolver)

    def resolve(self, name: str) -> Spec | None:
        for r in self.resolvers:
            spec = r(name)
            if spec is not None:
                return spec
        return None

    # ---- 동기 스레드에서 부르는 것 ----------------------------------------------
    def invalidate(self, prefix: str, exact: bool = False) -> None:
        """바꾸는 요청이 성공한 뒤: 이 이름(또는 접두사)의 토픽을 곧바로 다시 읽게 한다. 어느 스레드에서 불러도 된다.
        exact: 이름이 정확히 같은 토픽만(받은편지함 office:inbox:a@x.co 가 a@x.com 을 깨우지 않게, 스펙 2026-10-17-004 L9)."""
        if self.loop is not None and not self.loop.is_closed():
            self.loop.call_soon_threadsafe(self._wake_matching, prefix, exact)

    def _wake_matching(self, prefix: str, exact: bool = False) -> None:
        for (name, _lang), topic in self.topics.items():
            if name == prefix or (not exact and name.startswith(prefix)):
                topic.wake.set()

    # ---- 구독 ----------------------------------------------------------------
    def _key(self, name: str, spec: Spec, ctx: dict) -> tuple[str, str]:
        return (name, ctx.get("lang", i18n.DEFAULT) if spec.per_lang else "")

    async def _call(self, fn, lang: str, *args):
        """스레드에서 요청 언어로 fn 을 부른다. 루프 밖 스레드는 컨텍스트를 물려받지 않으므로 언어를 직접 정한다."""
        def run():
            i18n.set_lang(lang or i18n.DEFAULT)
            return fn(*args)
        return await self.loop.run_in_executor(self.pool, run)

    async def subscribe(self, name: str, sub, after: int | None = None) -> str:
        """구독. 오류 이유(빈 문자열이면 성공)를 돌려준다. 이미 값이 있으면 이 구독자의 view 를 바로 보낸다."""
        spec = self.resolve(name)
        if spec is None:
            return "unknown_topic"
        if isinstance(spec, EventSpec):
            return await self.subscribe_events(name, spec, sub, after)
        lang = sub.ctx.get("lang", i18n.DEFAULT)
        if spec.allowed is not None:
            try:
                ok = await self._call(spec.allowed, lang, sub.ctx)
            except Exception:
                ok = False
            if not ok:
                return "forbidden"
        key = self._key(name, spec, sub.ctx)
        topic = self.topics.get(key)
        if topic is None:
            topic = self.topics[key] = Topic(name, key[1], spec)
        if sub in topic.subs:
            return ""
        topic.subs[sub] = None
        sub.topics.add(key)
        if topic.value is not _UNSET:
            resumed = after is not None and after == topic.seq and topic.seq > 0     # 이미 최신 seq 를 갖고 있다 — 기록만 하고 보내지 않는다
            await self._send_views(topic, [sub], force=not resumed, silent=resumed)
        self._ensure_running(topic)
        return ""

    def unsubscribe(self, name: str, sub) -> None:
        for key in [k for k in list(sub.topics) if k[0] == name]:
            self._drop(key, sub)
        if ("event", name) in sub.topics:
            self._drop_event(name, sub)

    def unsubscribe_all(self, sub) -> None:
        for key in list(sub.topics):
            if key[0] == "event":
                self._drop_event(key[1], sub)
            else:
                self._drop(key, sub)

    def _drop(self, key, sub) -> None:
        sub.topics.discard(key)
        topic = self.topics.get(key)
        if topic is None:
            return
        topic.subs.pop(sub, None)
        if not topic.subs:
            topic.warm_until = time.monotonic() + (topic.spec.warm if topic.spec.warm is not None else self.warm)

    def subscriber_count(self, name: str) -> int:
        ev = self.events.get(name)
        return sum(len(t.subs) for (n, _l), t in self.topics.items() if n == name) + (len(ev.subs) if ev else 0)

    async def recheck(self, sub) -> list[str]:
        """권한이 바뀐 구독자의 구독을 다시 검사한다. 볼 수 없게 된 토픽 이름을 돌려주고 해지한다."""
        lost = []
        for key in [k for k in list(sub.topics) if k[0] == "event"]:
            ev = self.events.get(key[1])
            if ev is None or ev.spec.allowed is None:
                continue
            try:
                ok = await self._call(ev.spec.allowed, sub.ctx.get("lang", ""), sub.ctx)
            except Exception:
                ok = False
            if not ok:
                self._drop_event(key[1], sub)
                lost.append(key[1])
        for key in list(sub.topics):
            if key[0] == "event":
                continue
            topic = self.topics.get(key)
            if topic is None or topic.spec.allowed is None:
                continue
            try:
                ok = await self._call(topic.spec.allowed, sub.ctx.get("lang", ""), sub.ctx)
            except Exception:
                ok = False
            if not ok:
                self._drop(key, sub)
                lost.append(key[0])
        return lost

    # ---- 새로 고침 -------------------------------------------------------------
    def _ensure_running(self, topic: Topic) -> None:
        if topic.task is None or topic.task.done():
            topic.task = self.loop.create_task(self._run(topic))

    def _delay(self, topic: Topic) -> float:
        if topic.failures:
            base = min(self.max_backoff, topic.spec.interval(None if topic.value is _UNSET else topic.value) * (2 ** topic.failures))
        else:
            base = topic.spec.interval(topic.value)
        return base * random.uniform(0.8, 1.2)

    async def _run(self, topic: Topic) -> None:
        try:
            due = time.monotonic()
            while topic.subs or time.monotonic() < topic.warm_until:
                lag = time.monotonic() - due
                self.stats["lag_max"] = max(self.stats["lag_max"], lag)
                await self._refresh(topic)
                delay = self._delay(topic)
                due = time.monotonic() + delay
                topic.wake.clear()
                try:
                    await asyncio.wait_for(topic.wake.wait(), timeout=delay)
                    due = time.monotonic()
                except asyncio.TimeoutError:
                    pass
        finally:
            if not topic.subs and self.topics.get((topic.name, topic.lang)) is topic:
                del self.topics[(topic.name, topic.lang)]

    async def _refresh(self, topic: Topic) -> None:
        if topic.reading is not None and not topic.reading.done():
            # 앞 읽기가 아직 돈다 — 또 보내지 않고 지난 값을 둔다. 보내면 느린 읽기가 공용 스레드를 차지해 모든 사용자의
            # 실시간 갱신이 멈췄다(스펙 2026-10-24-002 R10)
            self.stats["skipped"] = self.stats.get("skipped", 0) + 1
            self._fail(topic, "timeout")
            return
        async with self.sem:
            self.stats["in_flight"] += 1
            self.stats["in_flight_max"] = max(self.stats["in_flight_max"], self.stats["in_flight"])
            fut = topic.reading = self.loop.run_in_executor(self.pool, self._source_call(topic))
            prev = topic.value
            unchanged = False
            try:
                value = await asyncio.wait_for(asyncio.shield(fut), timeout=self.timeout)
                self.stats["reads"] += 1
                if topic.spec.same is not None and prev is not _UNSET:
                    try:
                        unchanged = topic.spec.same(prev) == topic.spec.same(value)
                    except Exception:                  # 비교가 실패하면 다시 만든다(지금 동작)
                        unchanged = False
                topic.value, topic.error, topic.failures, topic.read_at = value, "", 0, time.monotonic()
            except asyncio.TimeoutError:
                self.stats["timeouts"] += 1
                self._fail(topic, "timeout")
            except Exception as exc:
                self.stats["failures"] += 1
                self._fail(topic, type(exc).__name__)
            finally:
                self.stats["in_flight"] -= 1
        if topic.value is not _UNSET and topic.subs:
            flipped = topic.error != topic.sent_error         # 실패하기 시작했거나 회복했으면 값이 같아도 알린다
            if unchanged and not flipped:
                self.stats["same_skips"] = self.stats.get("same_skips", 0) + 1
                return
            await self._send_views(topic, list(topic.subs), force=flipped, bump=True)
            topic.sent_error = topic.error

    def _source_call(self, topic: Topic):
        lang, fn = topic.lang, topic.spec.source

        def run():
            i18n.set_lang(lang or i18n.DEFAULT)
            return fn()
        return run

    def _fail(self, topic: Topic, reason: str) -> None:
        topic.failures += 1
        topic.error = reason
        print(f"토픽 읽기 실패 {topic.name}: {reason}", flush=True)   # i18n-ignore: 로그

    async def _send_views(self, topic: Topic, subs: list, force: bool = False, silent: bool = False, bump: bool = False) -> None:
        """구독자마다 view 를 만들어, 지난번과 다른 구독자에게만 snap 을 보낸다. 같은 view 는 같은 메시지 문자열을 나눠 쓴다.
        bump: 값이 바뀐 새로 고침이면 seq 를 올린다. 새 구독자에게 지금 값을 보낼 때는 올리지 않는다(이어 받기 기준이 흔들리지 않게)."""
        if topic.value is _UNSET:
            return
        value, spec = topic.value, topic.spec

        def build():
            # 구독자마다 거르는 동안 권한·자리·사람 목록을 한 번만 읽는다. run_in_executor 는 contextvars 를 넘기지 않아
            # 범위를 이 안에서 켠다(스펙 2026-10-24-009 3-2). 토픽 읽기(_source_call)와는 묶지 않는다
            with store.request_memo():
                return _views()

        def _views():
            out = []
            for s in subs:
                i18n.set_lang(s.ctx.get("lang", "") or i18n.DEFAULT)
                try:
                    v = value if spec.view is None else spec.view(value, s.ctx)
                    out.append(protocol.json.dumps(v, ensure_ascii=False, separators=(",", ":"), sort_keys=True))
                except Denied:
                    out.append(None)
                except Exception as exc:
                    out.append(protocol.json.dumps({"error": type(exc).__name__}))
            return out
        views = await self.loop.run_in_executor(self.pool, build)
        if silent:
            for s, v in zip(subs, views):
                if s in topic.subs:
                    topic.subs[s] = v
            return
        changed = [(s, v) for s, v in zip(subs, views) if s in topic.subs and (force or v != topic.subs[s])]
        if not changed:
            return
        if bump or topic.seq == 0:
            topic.seq += 1
        shared: dict[str, str] = {}
        extra = f',"stale":true,"error":{protocol.json.dumps(topic.error)}' if topic.error else ""
        for s, v in changed:
            if v is None:
                self._drop((topic.name, topic.lang), s)
                s.push(topic.name, protocol.encode("error", code="forbidden", topic=topic.name), "error")
                continue
            topic.subs[s] = v
            msg = shared.get(v)
            if msg is None:
                msg = shared[v] = f'{{"v":1,"t":"snap","topic":{protocol.json.dumps(topic.name)},"seq":{topic.seq},"data":{v}{extra}}}'
            s.push(topic.name, msg, "snap")


_hub: Hub | None = None
_hub_lock = threading.Lock()


def hub() -> Hub:
    global _hub
    with _hub_lock:
        if _hub is None:
            _hub = Hub()
        return _hub


def invalidate(prefix: str, exact: bool = False) -> None:
    """바꾸는 요청 뒤에 부른다. 허브가 아직 없으면(웹소켓을 안 쓰면) 아무것도 하지 않는다."""
    if _hub is not None:
        _hub.invalidate(prefix, exact)


_user_listeners: list[Callable[[str], None]] = []


def on_user_changed(fn: Callable[[str], None]) -> None:
    if fn not in _user_listeners:
        _user_listeners.append(fn)


def user_changed(email: str) -> None:
    """권한·세션을 바꾼 뒤 부른다(어느 스레드에서도). 그 사용자의 열린 웹소켓 연결이 구독을 다시 검사한다."""
    for fn in list(_user_listeners):
        try:
            fn(str(email or "").lower())
        except Exception as exc:                       # 알림 실패가 바꾸는 요청을 실패로 만들지 않게
            print(f"웹소켓 권한 알림 실패: {type(exc).__name__}", flush=True)   # i18n-ignore: 로그

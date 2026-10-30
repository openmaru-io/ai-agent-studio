# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""오피스의 상태와 이벤트(계획 003 §3 A안).

씬은 `OfficeAgent[]`(자리마다 working/idle/error)와 이벤트 흐름만 받는다. Hermes 의 게이트웨이 말투를 흉내 내지 않는다.

  working — AAS 가 중계하는 대화가 진행 중이거나, 그 프로파일의 크론 실행이 running 에 있을 때.
            텔레그램·CLI 로 직접 진행 중인 대화는 AAS 가 볼 수 없어 working 으로 나오지 않는다(알려진 한계).
  error   — 마지막 크론 실행이 실패했거나, 그 설치본을 읽지 못했을 때.
  idle    — 그 밖.
  지금 일하는 중이면 실패 표시보다 working 이 앞선다(진행 중인 것이 더 새로운 사실이다).

이 모듈은 순수한 계산과 메모리 안의 버스만 둔다. 읽기(Hermes)와 채팅 중계 연결은 server.py 가 한다.
"""
from __future__ import annotations

import threading
import time

from ..common.redact import redact
from datetime import datetime
from collections import deque
from typing import Callable, Iterable

Key = tuple[str, str]                         # (설치본 id, 프로파일 이름)


def compute_state(seats: Iterable[dict], chat_busy: set[Key], running: set[Key], failed: set[Key], bad_pods: set[str]) -> list[dict]:
    out = []
    for s in seats:
        if not s.get("enabled", True):
            continue
        key = (s["pod"], s["profile"])
        if key in chat_busy or key in running:
            status = "working"
        elif key in failed or s["pod"] in bad_pods:
            status = "error"
        else:
            status = "idle"
        out.append({"alias": s["alias"], "pod": s["pod"], "profile": s["profile"], "status": status,
                    **{k: s.get(k, "") for k in ("title", "role", "team", "avatar")}})
    return out


def collect(pods, health_of: Callable, running_of: Callable, used_pods: set[str]) -> tuple[set[Key], set[Key], set[str]]:
    """설치본마다 (마지막 실행 실패, 실행 중, 읽지 못한 설치본). 자리가 없는 설치본은 읽지 않는다."""
    failed: set[Key] = set()
    running: set[Key] = set()
    bad: set[str] = set()
    for pod in pods:
        if pod.id not in used_pods:
            continue
        try:
            health = health_of(pod)
            for j in health.get("failed_jobs", []):
                if not j.get("muted"):
                    failed.add((pod.id, j["profile"]))
            running |= {(pod.id, p) for p in running_of(pod)}
        except Exception:                     # 한 설치본이 죽어도 나머지 자리는 그린다
            bad.add(pod.id)
    return failed, running, bad


class OfficeBus:
    """번호가 붙은 이벤트 줄. SSE 가 Last-Event-ID 로 이어 받는다."""

    def __init__(self, keep: int = 2000):
        self._events: deque = deque(maxlen=keep)
        self._cond = threading.Condition()
        self.seq = 0
        self.on_publish: Callable[[str, dict], None] | None = None   # 다른 서버로 중계(shared.Shared.attach)

    def oldest(self) -> int:
        """남아 있는 가장 오래된 이벤트 번호. 하나도 없으면 seq + 1(이어 받을 틈이 없다)."""
        with self._cond:
            return self._events[0]["seq"] if self._events else self.seq + 1

    def publish(self, etype: str, payload: dict | None = None, relay: bool = True) -> int:
        """relay=False 는 다른 서버에서 건너온 이벤트다 — 다시 중계하지 않는다."""
        with self._cond:
            self.seq += 1
            seq = self.seq
            self._events.append({"seq": seq, "type": etype, "payload": payload or {}})
            self._cond.notify_all()
        if relay and self.on_publish is not None:
            try:
                self.on_publish(etype, payload or {})
            except Exception as exc:                      # DB 가 잠시 끊겨도 이 서버의 화면에는 간다
                print(f"오피스 이벤트를 다른 서버로 보내지 못했습니다: {type(exc).__name__}", flush=True)   # i18n-ignore: 로그
        return seq

    def after(self, seq: int, wait: float = 20.0) -> list[dict]:
        """seq 보다 큰 이벤트. 없으면 wait 초까지 기다린다(없이 끝나면 빈 목록 = keepalive 때)."""
        deadline = time.time() + wait
        with self._cond:
            while True:
                out = [e for e in self._events if e["seq"] > seq]
                if out:
                    return out
                left = deadline - time.time()
                if left <= 0:
                    return []
                self._cond.wait(left)


DELTA_CHARS = 80                              # 말풍선에 보이는 답 글(최근 글자 수, 계획 007 P1)
DELTA_EVERY = 1.0                             # 대화 세션마다 답 글을 보내는 간격(초)
_START = {"aas.user", "message.start"}
_END = {"message.complete", "error", "aas.disconnected"}


class StateTracker:
    """자리 상태가 바뀐 것과 대화의 시작·끝·도구 호출을 버스에 낸다."""

    def __init__(self, bus: OfficeBus, clock=time.time):
        self.bus = bus
        self._clock = clock
        self._last: dict[str, str] | None = None
        self._alias: dict[Key, str] = {}
        self._busy: dict[Key, set[str]] = {}           # 자리 → 진행 중인 세션들
        self._lock = threading.Lock()
        self.owners: dict[str, str] = {}               # 설치본 id → 주인 이메일(답 글을 받을 사람, 계획 007 R1)
        self._by: dict[str, str] = {}                  # 세션 → 대화를 시작한 사람
        self._text: dict[str, str] = {}                # 세션 → 쌓인 답 글
        self._sent: dict[str, float] = {}              # 세션 → 마지막으로 답 글을 보낸 시각
        self.last_seen: dict[str, float] = {}          # 별칭 → 마지막 활동 시각(대화·도구). 서버를 다시 띄우면 비어 있다

    def alias_of(self, pod: str, profile: str | None) -> str | None:
        with self._lock:
            return self._alias.get((pod, profile or ""))

    def chat_busy(self) -> set[Key]:
        with self._lock:
            return {k for k, v in self._busy.items() if v}

    def update(self, agents: list[dict]) -> list[dict]:
        """새 상태를 반영하고 바뀐 이벤트를 낸다. 처음 한 번은 바탕이라 내지 않는다."""
        now = {a["alias"]: a["status"] for a in agents}
        with self._lock:
            self._alias = {(a["pod"], a["profile"]): a["alias"] for a in agents}
            prev, self._last = self._last, now
        if prev is None:
            return []
        changed = []
        for alias, status in now.items():
            if alias not in prev:
                self.bus.publish("seat.added", {"alias": alias, "status": status})
            elif prev[alias] != status:
                self.bus.publish("agent.status", {"alias": alias, "status": status, "prev": prev[alias]})
                changed.append({"alias": alias, "status": status})
        for alias in prev:
            if alias not in now:
                self.bus.publish("seat.removed", {"alias": alias})
        return changed

    def apply_remote(self, etype: str, payload: dict) -> None:
        """다른 서버(리더)가 계산해 중계한 자리 상태를 기억에 반영한다. 이 서버가 화면 요청으로 상태를 계산할 때 같은 변화를
        다시 내지 않게 한다(스펙 2026-10-24-011 R3)."""
        alias = str(payload.get("alias") or "")
        with self._lock:
            if self._last is None or not alias:
                return
            if etype in ("agent.status", "seat.added"):
                self._last[alias] = str(payload.get("status") or "")
            elif etype == "seat.removed":
                self._last.pop(alias, None)

    def on_chat(self, sid: str, pod: str, profile: str | None, etype: str, payload: dict) -> None:
        """ChatHub 의 이벤트를 받는다. 자리에 앉은 프로파일의 대화만 오피스에 알린다.
        자리가 없으면 내지 않는다 — 프로파일 이름을 별칭으로 쓰면 다른 설치본의 같은 이름 자리로 나간다(계획 007 H1)."""
        if not profile:
            return
        key = (pod, profile)
        with self._lock:
            alias = self._alias.get(key)
        payload = payload or {}
        if alias:
            self._seen(alias)
        if etype in _START:
            with self._lock:
                sessions = self._busy.setdefault(key, set())
                first = sid not in sessions
                sessions.add(sid)
                if etype == "aas.user":
                    self._by[sid] = str(payload.get("_by") or "").lower()
                    self._text[sid] = ""
            if first and alias:
                self.bus.publish("chat.start", {"alias": alias})          # 세션 id 는 내보내지 않는다(계획 007 M2)
        elif etype in _END:
            with self._lock:
                sessions = self._busy.setdefault(key, set())
                was = sid in sessions
                sessions.discard(sid)
                self._text.pop(sid, None)
                self._sent.pop(sid, None)
            if was and alias:
                self.bus.publish("chat.end", {"alias": alias})
        elif etype == "tool.start" and alias:
            self.bus.publish("tool", {"alias": alias, "name": str(payload.get("name") or "tool")[:80]})
        elif etype == "message.delta" and alias:
            self._delta(sid, pod, alias, str(payload.get("text") or ""))

    def _seen(self, alias: str) -> None:
        now = self._clock()
        prev = self.last_seen.get(alias, 0)
        self.last_seen[alias] = now
        if now - prev >= 60:                                              # 1분에 한 번만 알린다(장면은 30분 기준으로 부재를 본다)
            self.bus.publish("agent.lastSeen", {"alias": alias, "ts": int(now)})

    def _delta(self, sid: str, pod: str, alias: str, piece: str) -> None:
        """답 글을 쌓아 1초에 한 번, 비밀값을 가린 뒤 최근 80자를 대화 당사자와 주인에게만 보낸다(계획 007 R1·M3).
        가리기를 먼저 해야 한다 — 먼저 자르면 잘린 비밀값이 가리기 규칙에 걸리지 않는다."""
        now = self._clock()
        with self._lock:
            text = (self._text.get(sid, "") + piece)[-4000:]
            self._text[sid] = text
            if now - self._sent.get(sid, 0) < DELTA_EVERY:
                return
            self._sent[sid] = now
            to = sorted({x for x in (self._by.get(sid, ""), (self.owners.get(pod) or "").lower()) if x})
        if to:
            tail = text[-400:]                        # 가리기는 최근 400자에 한다 — 잘린 경계가 보이는 80자에서 멀다
            self.bus.publish("chat.delta", {"alias": alias, "text": redact(tail, limit=len(tail) + 1)[-DELTA_CHARS:], "_to": to})


class Office:
    """버스 + 추적기 + 지금 상태. 서버가 하나 쥔다."""

    def __init__(self):
        self.bus = OfficeBus()
        self.tracker = StateTracker(self.bus)
        self.remote_busy: Callable[[], set[Key]] = set     # 다른 서버에서 진행 중인 대화(shared.Shared.remote_busy)

    def snapshot(self, pods, seats: list[dict], health_of: Callable, running_of: Callable,
                 collected: tuple | None = None, on_collected: Callable | None = None) -> dict:
        """collected: 다른 서버(리더)가 계산한 (실패, 실행 중, 읽지 못함) — 있으면 사이드카를 읽지 않는다. on_collected: 직접 계산한 값을 넘길 곳."""
        if collected is not None:
            failed, running, bad = collected
        else:
            used = {s["pod"] for s in seats if s.get("enabled", True)}
            failed, running, bad = collect(pods, health_of, lambda pod: running_of(pod), used)
            if on_collected is not None:
                try:
                    on_collected(failed, running, bad)
                except Exception as exc:                   # 나눠 쓰기가 안 돼도 이 서버의 상태는 그린다
                    print(f"오피스 상태 재료를 나누지 못했습니다: {type(exc).__name__}", flush=True)   # i18n-ignore: 로그
        try:
            remote = self.remote_busy()
        except Exception:                                  # DB 가 잠시 끊기면 이 서버가 아는 것만으로 그린다
            remote = set()
        agents = compute_state(seats, self.tracker.chat_busy() | remote, running, failed, bad)
        self.tracker.owners = {p.id: (getattr(p, "owner", "") or "") for p in pods}
        self.tracker.update(agents)
        agents = [{**a, "last_seen": int(self.tracker.last_seen[a["alias"]])} if a["alias"] in self.tracker.last_seen else a for a in agents]
        return {"agents": agents, "seq": self.bus.seq, "ts": datetime.now().astimezone().isoformat(timespec="seconds")}

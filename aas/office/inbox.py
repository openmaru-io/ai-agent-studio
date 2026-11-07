# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""받은편지함 — 사람이 답해야 에이전트가 움직이는 일만 모은다(계획 007 P4, §3-3 G2).

  도구 실행 승인·되묻기  채팅 이벤트(approval.request·clarify.request)에서 아직 답하지 않은 것. 받는 사람: 대화를 시작한 사람, 없으면 에이전트 주인
                         회의·칸반 실행에서 온 요청도 같은 대화 채널(ChatHub)을 거치므로 여기에 모인다 — 회의는 승인을 처리하지 않아
                         아무도 모른 채 시간이 끝날 때까지 기다리던 문제를 막는다(독립 검토 H2)
  검토·막힘 카드          칸반 카드(office_cards). 받는 사람: 카드 소유자(office_card_owner)
  실패한 크론             설치본의 크론 실행 기록. 받는 사람: 에이전트 주인
요청은 대화를 연 서버의 메모리에 두고, 서버 복제본 사이에 보이도록 공유 DB 에 그대로 적는다(shared.Shared, OMAI-1105 복제본 2개).
목록·조회는 DB 에서 읽어 다른 서버의 요청도 보인다. 서버를 다시 띄우면 그 서버의 답하지 않은 요청은 사라진다(대화도 끝났다).
"""
from __future__ import annotations

import threading
import time

from ..ops import llm_block
from ..common.redact import redact

_ASK = {"approval.request": "approval", "clarify.request": "clarify"}
# aas.request.cancelled: Hermes 가 요청을 끝냈다(시간 초과·중단·다른 곳에서 답함). 이유와 상관없이 항목을 지운다(스펙 2026-10-23-005 R4)
_ANSWERED = {"aas.approval.answered", "aas.clarify.answered", "aas.request.cancelled"}
_ENDED = {"message.complete", "error", "aas.disconnected"}


class Pending:
    """채팅 이벤트에서 아직 답하지 않은 승인·되묻기를 모은다. ChatHub 의 listener 로 붙는다."""

    def __init__(self, clock=time.time, shared=None):
        self._clock = clock
        self._shared = shared                        # 있으면 복제본 사이에 나눈다(shared.Shared)
        self._items: dict[str, dict] = {}            # id → 항목
        self._by: dict[tuple[str, str], str] = {}    # (설치본, 세션) → 대화를 시작한 사람
        self._lock = threading.Lock()
        self.notify = None                           # 받는 사람(이메일 집합)의 받은편지함이 바뀌었을 때 부른다(토픽 다시 읽기, 스펙 2026-10-17-004)

    @staticmethod
    def item_id(pod: str, sid: str, request_id: str, qid: str = "") -> str:
        return f"{pod}|{sid}|{request_id}|{qid}"

    def on_chat(self, pod: str, sid: str, alias: str, owner: str, etype: str, payload: dict) -> None:
        payload = payload or {}
        with self._lock:
            before = dict(self._items)
            self._apply(pod, sid, alias, owner, etype, payload)
            added = {k: v for k, v in self._items.items() if before.get(k) is not v}
            dropped = [k for k in before if k not in self._items]
        if self._shared is not None and (added or dropped):
            for k, v in added.items():
                self._shared.inbox_put(k, v)
            self._shared.inbox_drop(dropped)
        if self.notify is not None and (added or dropped):      # 답 조각(message.delta)처럼 항목이 그대로면 알리지 않는다(L6)
            to = {e for v in added.values() for e in v["to"]} | {e for k in dropped for e in before[k]["to"]}
            if to:
                self.notify(to)

    def _apply(self, pod: str, sid: str, alias: str, owner: str, etype: str, payload: dict) -> None:
        if etype == "aas.user":
            self._by[(pod, sid)] = str(payload.get("_by") or "").lower()
        elif etype in _ASK:
            rid = str(payload.get("request_id") or "")
            kind = _ASK[etype]
            if kind == "clarify" and payload.get("_relay"):     # 오피스 중계는 되묻기를 대화창 글로 바꾸고 곧바로 취소한다 — 항목이 깜박이지 않게(R15)
                return
            answered = payload.get("answers") if isinstance(payload.get("answers"), dict) else {}
            questions = payload.get("questions") if kind == "clarify" and isinstance(payload.get("questions"), list) else [payload]
            for q in questions:
                qid = str(q.get("question_id") or "") if kind == "clarify" and q is not payload else ""
                if qid and qid in answered:                       # 다시 받은 묶음에서 이미 잠긴 답(R6)
                    continue
                text = (q.get("question") or q.get("text") or payload.get("description") or payload.get("command") or "")
                self._items[self.item_id(pod, sid, rid, qid)] = {
                    "kind": kind, "pod": pod, "sid": sid, "request_id": rid, "question_id": qid, "alias": alias,
                    "text": redact(str(text), 300), "command": redact(str(payload.get("command") or ""), 300),
                    "choices": [str(c) for c in (q.get("choices") or payload.get("choices") or [])][:8],
                    "to": [x for x in (self._by.get((pod, sid)) or (owner or "").lower(),) if x],
                    "at": self._clock()}
        elif etype in _ANSWERED:
            rid = str(payload.get("request_id") or "")
            qid = str(payload.get("question_id") or "")
            for key in [k for k, v in self._items.items() if v["pod"] == pod and v["sid"] == sid and v["request_id"] == rid
                        and (not qid or v["question_id"] == qid)]:
                self._items.pop(key, None)
        elif etype in _ENDED:
            for key in [k for k, v in self._items.items() if v["pod"] == pod and v["sid"] == sid]:
                self._items.pop(key, None)

    def local(self, item_id: str) -> dict | None:
        """이 서버에서 연 대화의 요청(답을 처리할 때)."""
        with self._lock:
            return dict(self._items[item_id]) if item_id in self._items else None

    def _all(self) -> dict[str, dict]:
        if self._shared is not None:
            return self._shared.inbox_items()
        with self._lock:
            return {k: dict(v) for k, v in self._items.items()}

    def get(self, item_id: str) -> dict | None:
        return self._all().get(item_id)

    def for_person(self, email: str) -> list[dict]:
        email = (email or "").lower()
        return [{"id": k, **{x: v[x] for x in ("kind", "alias", "text", "command", "choices", "question_id", "at")}}
                for k, v in sorted(self._all().items(), key=lambda kv: kv[1]["at"]) if email and email in v["to"]]


def cards_for(rows: list[dict], owners: dict[tuple[str, str], str], email: str) -> list[dict]:
    """검토·막힘 카드 중 이 사람이 맡긴 것. rows: office_cards 행, owners: (보드, 카드) → 소유자 이메일."""
    email = (email or "").lower()
    out = []
    for r in rows:
        if r["status"] in ("review", "blocked") and owners.get((r["board"], r["task_id"]), "").lower() == email and email:
            out.append({"id": f"card|{r['board']}|{r['task_id']}", "kind": r["status"], "alias": r["assignee"], "text": r["title"],
                        "board": r["board"], "task_id": r["task_id"]})
    return out


def crons_for(failed: list[dict], email: str) -> list[dict]:
    """실패한 크론(주인 기준으로 이미 거른 목록)을 받은편지함 항목으로."""
    return [{"id": f"cron|{f['pod']}|{f['profile']}|{f['job_id']}", "kind": "cron_failed", "alias": f.get("alias") or f["profile"],
             "pod": f["pod"], "profile": f["profile"], "job_id": f["job_id"],   # 화면의 「크론 보기」가 작업 서랍을 열 때 쓴다(alias 는 Cron 표 검색 글에 없고, Cron 화면은 보고 있는 POD 의 작업만 보이므로 다른 POD 면 pod 로 전환한다)
             "text": redact(str(f.get("job") or f.get("name") or f["job_id"]), 120), "error": llm_block.explain(redact(str(f.get("error") or ""), 300))} for f in failed]   # 가드 거절은 안내로(D18)

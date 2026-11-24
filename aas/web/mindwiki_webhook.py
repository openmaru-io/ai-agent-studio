# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""POST /api/mindwiki/webhook — MindWiki 자동화 「AAS 에이전트에게 맡기기」(스펙 2026-11-15-002 A5). 계산은 aas.ops.mindwiki_webhook.

로그인·CSRF 검사 없이 HMAC 서명으로만 받는다(레거시 Mount 앞, Starlette 경로는 스스로 인증한다). 응답 본문은
{type, title, status, reason, card_id?, trace_id}. 상태 표는 스펙 A5: 202 ok·blocked_no_write_token, 200 다시 받음, 401 bad_signature·
stale_timestamp, 503 webhook_disabled·hermes_not_ready, 422 no_agent·author_daily_limit·install_daily_limit·invalid, 413 too_large,
500 internal. 429 는 쓰지 않는다(D22).

복제할 프로파일 T(본문 agent.profile, 스펙 2026-11-21-002 §3-2·§5): 작성자 파드 가운데 T 가 있는 한 파드를 찾아(캐시 10분, 나란히 2초)
그 파드의 자동화 전용 복제본 mwauto-<T>(웹 조사는 mwauto-web-<T>)가 카드를 맡는다. 더하는 답: 202 no_profile·ambiguous_profile·
profile_preparing(이번 웹훅이 복제를 시작함)·profile_unsafe·profile_limit·pod_unreachable. 받은 때부터 9초 마감 — Hermes 호출은
바깥에서 남은 시간으로 자르고, 카드 전에 지나면 503. T 가 없으면 아래 지금 경로(G4) 그대로다.
"""
from __future__ import annotations

import os
import secrets
import threading
import time
import traceback
from concurrent.futures import Future, ThreadPoolExecutor
from concurrent.futures import TimeoutError as FutureTimeout
from concurrent.futures import wait as futures_wait
from urllib.parse import quote

import anyio
from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.routing import Route

from ..assets import files
from ..common import config, store
from ..common.redact import redact
from ..fleet import primary, profile_names, profiles
from ..hermes.hermes_api import HermesAPI, HermesError
from ..market import marketplace, protected_skills
from ..ops import mcp_servers, mindwiki_connect
from ..ops import mindwiki_auto_clone as clones
from ..ops import mindwiki_webhook as mw
from . import server

PATH = "/api/mindwiki/webhook"
_BOARDS: set = set()                     # 보드를 만든 파드(프로세스 기억) — 카드마다 보드를 다시 만들지 않는다


def _answer(status: int, reason: str, trace: str, **extra) -> JSONResponse:
    body = {"type": "mindwiki_webhook", "title": reason, "status": status, "reason": reason, "trace_id": trace, **extra}
    return JSONResponse(body, status_code=status, headers={"Cache-Control": "no-store"})


async def _read(request: Request) -> bytes:
    """Content-Length 를 먼저 보고, 본문은 흘려 읽으며 256 KiB 를 넘는 순간 끊는다(chunked·거짓 길이도)."""
    try:
        if int(request.headers.get("content-length") or 0) > mw.MAX_BODY:
            raise mw.Reject(413, "too_large")
    except ValueError:
        raise mw.Reject(413, "too_large") from None
    got = bytearray()
    async for chunk in request.stream():
        got += chunk
        if len(got) > mw.MAX_BODY:
            raise mw.Reject(413, "too_large")
    return bytes(got)


def _pod_of(sub: str, email: str):
    """작성자의 주 작업공간 파드. 주인 sub 가 비어 있는 파드는 이메일로 찾는다(리뷰 Eng F5)."""
    user = {"sub": sub, "email": email}
    owned = [p for p in list(server.registry().pods) if p.owned_by(user)]
    if not owned:
        return None
    for p in owned:
        if primary.primary_of(p.id):
            return p
    return owned[0]


def _chosen_pod(w: dict) -> tuple[object | None, str]:
    """MindWiki 가 지정한 AAS 에이전트(본문 agent.pod, 스펙 2026-11-21-002 §3-7): (파드, 이유). 지정이 없으면 (None, "").
    작성자의 준비된 파드면 그 파드, 다시 뜨는 중이면 hermes_not_ready, 그 밖(남의 · 공유받은 · 멈춘 · 지워진 파드)은 한 이유
    pod_not_owned — 남의 파드가 있는지 알려 주지 않는다."""
    want = w.get("pod") or ""
    if not want:
        return None, ""
    user = {"sub": w["sub"], "email": w["email"]}
    reg = server.registry()
    for p in list(reg.pods):
        if p.id == want and p.owned_by(user):
            return p, ""
    for p in list(getattr(reg, "restarting", None) or []):
        if p.id == want and p.owned_by(user):
            return None, "hermes_not_ready"
    return None, "pod_not_owned"


def _not_ready(exc: HermesError) -> bool:
    return getattr(exc, "code", 0) in (0, 502, 503, 504)


_MAKING: set = set()                     # 뒤에서 만드는 중인 (파드, 프로파일)
_MAKING_LOCK = threading.Lock()


def _has_profile(api: HermesAPI, name: str) -> bool:
    return any(isinstance(r, dict) and r.get("name") == name for r in api.call("GET", "/api/profiles").get("profiles", []))


def _make_profile(api: HermesAPI, pod_id: str, name: str, web: bool) -> None:
    """뒤 작업: 자동화 전용 프로파일을 만들고 도구 묶음을 맞춘다. Hermes 의 프로파일 만들기는 10초를 넘길 수 있어
    웹훅 답을 기다리게 하지 않는다 — MindWiki 의 웹훅 제한 시간이 10초다(OKE 2026-11-15, 첫 웹훅이 약 11초)."""
    try:
        if not _has_profile(api, name):
            # i18n-ignore: Hermes 프로파일 설명(사람이 프로파일 목록에서 본다) — 설치 언어와 관계없이 한 줄로 둔다
            desc = "MindWiki 자동화 전용. MindWiki 쓰기는 자동화 실행의 대상에만 된다" + (" · 웹 조사" if web else "")
            api.call("POST", "/api/profiles", {"name": name, "clone_from": None, "no_skills": True, "description": desc})
        _sync_toolsets(api, name, web)
    except Exception:  # noqa: BLE001 — 다음 웹훅이 다시 만든다
        print(f"mindwiki webhook profile pod={pod_id} profile={name}\n{traceback.format_exc()}", flush=True)   # i18n-ignore: 서버 로그
    finally:
        with _MAKING_LOCK:
            _MAKING.discard((pod_id, name))


def _start_making(api: HermesAPI, pod_id: str, name: str, web: bool) -> None:
    with _MAKING_LOCK:
        if (pod_id, name) in _MAKING:
            return
        _MAKING.add((pod_id, name))
    threading.Thread(target=_make_profile, args=(api, pod_id, name, web), name=f"mindwiki-auto-{name}", daemon=True).start()


def _sync_toolsets(api: HermesAPI, name: str, web: bool, skills: bool = False) -> None:
    """도구 묶음 맞추기(D20): 웹(켠 경우)만 남기고 끈다. 카드를 만들 때마다 한다 — 사람이 켠 도구도 다시 끈다. 지금 값과 다른 것만 PUT.
    skills: 복제본은 skills 묶음을 켜 둔다(스펙 2026-11-21-002 §3-2 5)."""
    rows = api.call("GET", "/api/tools/toolsets", None, {"profile": name})
    rows = rows.get("toolsets", rows) if isinstance(rows, dict) else rows
    for tool, on in mw.toolset_changes(rows, web, skills):
        api.call("PUT", f"/api/tools/toolsets/{tool}", {"enabled": on, "profile": name}, {"profile": name})


def _write_ready(sub: str, pod: str, profile: str) -> bool:
    """그 프로파일에 MindWiki 쓰기 연결이 있고 끝나지 않았나. AAS 는 토큰을 읽지 않고 connector_tokens 로 판단한다."""
    row = mindwiki_connect._row(sub, pod, profile) or {}
    if row.get("status") != "connected" or not row.get("write"):
        return False
    exp = mindwiki_connect._parse(row.get("expires_at") or "")
    return exp is None or exp > mindwiki_connect._now()


def _deliver(w: dict, install: str, delivery: str, deadline: float | None = None) -> tuple[int, str, str, str]:
    """(상태, 이유, 카드 id, 카드를 맡는 프로파일 이름). deadline 은 time.monotonic() 기준 마감(복제할 프로파일 경로만 쓴다)."""
    if w.get("profile"):
        return _deliver_template(w, install, delivery, time.monotonic() + DEADLINE if deadline is None else deadline)
    profile = mw.profile_for(w["web"])
    status, reason, tid = _deliver_default(w, install, delivery, profile)
    return status, reason, tid, profile


def _deliver_default(w: dict, install: str, delivery: str, profile: str) -> tuple[int, str, str]:
    """복제할 프로파일이 없는 자동화(G4): 지정한 AAS 에이전트(§3-7), 없으면 주 작업공간 파드의 mindwiki-auto(·-web)."""
    pod, why = _chosen_pod(w)
    if why == "hermes_not_ready":
        return 503, why, ""
    if why:
        return 202, why, ""
    pod = pod or _pod_of(w["sub"], w["email"])
    if pod is None:
        return 422, "no_agent", ""
    api = HermesAPI(server.hub(pod).auth)
    try:
        if not _has_profile(api, profile):
            # 프로파일이 없으면 쓰기 연결도 없다 — 만들기는 뒤로 돌리고 곧바로 「막힘」으로 답한다
            _start_making(api, pod.id, profile, w["web"])
            mindwiki_connect.want_auto(w["sub"], pod.id, profile, w["workspace"])
            return 202, "blocked_no_write_token", ""
        _sync_toolsets(api, profile, w["web"])
        if not _write_ready(w["sub"], pod.id, profile):
            mindwiki_connect.want_auto(w["sub"], pod.id, profile, w["workspace"])   # 다음 로그인 때 자동 첫 연결이 잇는다(자동화 전용 토큰)
            return 202, "blocked_no_write_token", ""
        if pod.id not in _BOARDS:
            try:
                # i18n-ignore: Hermes 에 저장되는 보드 이름
                api.call("POST", "/api/plugins/kanban/boards", {"slug": mw.BOARD, "name": "MindWiki 자동화", "description": "MindWiki 자동화 카드"})
            except HermesError as exc:
                if _not_ready(exc):
                    raise
            _BOARDS.add(pod.id)
        c = mw.card(w, install, delivery)
        # 켠 보호 스킬은 카드에 실어 보낸다 — 이 경로는 skills 묶음을 꺼 두어 에이전트가 스킬을 찾지 못한다(스펙 2026-11-21-003 §9)
        skills = protected_skills.preload_for(pod.id, profile, message=w["instruction"])   # 첫 구절이 가리키는 보호 스킬만(스펙 2026-11-24-002 D8)
        res = api.call("POST", "/api/plugins/kanban/tasks", {**c, "assignee": profile, **({"skills": skills} if skills else {})}, {"board": mw.BOARD})
    except HermesError as exc:
        if _not_ready(exc):
            return 503, "hermes_not_ready", ""
        raise
    tid = str((res.get("task") or res).get("id") or "") if isinstance(res, dict) else ""
    if not tid:
        return 503, "hermes_not_ready", ""
    return 202, "ok", tid


async def receive(request: Request):
    trace = mw.trace_id()
    deadline = time.monotonic() + DEADLINE                    # 받은 때부터 9초(MindWiki 웹훅 제한 10초, 스펙 2026-11-21-002 §3-2 1)
    try:
        if not mw.enabled():
            raise mw.Reject(503, "webhook_disabled")
        body = await _read(request)
        headers = {k.lower(): v for k, v in request.headers.items()}
        install, delivery = mw.verify(headers, body)
        w = mw.parse(body)
        done = await anyio.to_thread.run_sync(mw.begin, install, delivery, w["sub"])
        if done is not None:
            return _answer(200, done["reason"] or "ok", trace, card_id=done["card_id"] or None)
        try:
            status, reason, tid, profile = await anyio.to_thread.run_sync(_deliver, w, install, delivery, deadline)
        except Exception:
            await anyio.to_thread.run_sync(mw.release, install, delivery)
            raise
        if status >= 500:
            await anyio.to_thread.run_sync(mw.release, install, delivery)
        if status < 300 or status == 422:
            await anyio.to_thread.run_sync(mw.finish, install, delivery, tid, reason, w.get("page") or "")     # 막힘·없음도 한도에 센 그대로 끝낸다
            store.log_usage("mindwiki_webhook_card", f"{profile} {reason} {tid}".strip())    # _deliver 가 돌려준 이름(스펙 2026-11-21-002 §3-2 7)
        return _answer(status, reason, trace, **({"card_id": tid} if tid else {}))
    except mw.Reject as r:
        extra = {"detail": r.detail} if r.reason == "stale_timestamp" and r.detail else {}
        return _answer(r.status, r.reason, trace, **extra)
    except Exception:  # noqa: BLE001 — MindWiki 가 다시 보내고 delivery 로 겹치지 않는다
        print(f"mindwiki webhook internal trace={trace}\n{traceback.format_exc()}", flush=True)   # i18n-ignore: 서버 로그
        return _answer(500, "internal", trace)


# ---- 복제할 프로파일 T 의 자동화 전용 복제본(스펙 2026-11-21-002 §3-2) ---------------------------------------------------------

DEADLINE = 9.0                   # 받은 때부터 카드까지의 마감(초)
LOOKUP_WAIT = 2.0                # 파드 찾기에서 파드마다 기다리는 시간(나란히라 전체도 약 2초)
CACHE_FOR = 600.0                # (작성자, T) → 파드 캐시(10분)
UNREACHABLE_AFTER = 3            # 같은 자동화에서 「답하지 않는 파드」 503 이 이만큼 이어지면 202 pod_unreachable
CLONE_LIMIT = 3                  # 파드마다 mwauto- 복제본 상한(기본 mindwiki-auto·-web 제외). AAS_MINDWIKI_AUTO_CLONE_LIMIT 로 바꾼다
_LOOKUPS = ThreadPoolExecutor(max_workers=8, thread_name_prefix="mw-lookup")    # 파드 찾기(크기 제한, 파드마다 하나로 합친다)
_CALLS = ThreadPoolExecutor(max_workers=16, thread_name_prefix="mw-call")       # 마감 안의 Hermes 호출을 바깥에서 자른다
_INFLIGHT: dict[str, Future] = {}
_INFLIGHT_LOCK = threading.Lock()
_CACHE: dict[tuple[str, str], tuple[str, float]] = {}
_STREAK: dict[tuple[str, str, str], int] = {}
_STATE_LOCK = threading.Lock()
SERVER_ID = "aas-" + secrets.token_hex(4)


class _Late(Exception):
    """9초 마감이 지났다 — 카드를 만들지 않고 503(MindWiki 가 다시 보낸다)."""


class _CloneFailed(Exception):
    """복제본을 안전하게 만들지 못했다(이유는 키 이름만 — 값은 넣지 않는다)."""


def _clone_limit() -> int:
    try:
        return max(1, int(config.get("AAS_MINDWIKI_AUTO_CLONE_LIMIT", str(CLONE_LIMIT))))
    except ValueError:
        return CLONE_LIMIT


def _left(deadline: float) -> float:
    return deadline - time.monotonic()


class _Timed:
    """HermesAPI 의 call 을 바깥에서 남은 시간으로 자른다(엔지니어링 재검토 「시간」). 401·403 뒤 다시 로그인은 call 의 timeout 밖이라
    안쪽 timeout 만으로는 마감을 지키지 못한다. 안쪽에도 남은 시간을 넘긴다. 자른 호출은 뒤에서 끝까지 돈다(카드는 idempotency_key 로 겹치지 않는다)."""

    def __init__(self, api, deadline: float):
        self.api, self.deadline = api, deadline
        self.auth = getattr(api, "auth", None)

    def call(self, method, path, body=None, query=None, timeout=30):
        left = _left(self.deadline)
        if left <= 0.05:
            raise _Late()
        fut = _CALLS.submit(self.api.call, method, path, body, query, max(0.5, min(timeout, left)))
        try:
            return fut.result(timeout=left)
        except FutureTimeout:
            raise _Late() from None


def _names_of(pod) -> set[str]:
    rows = HermesAPI(server.hub(pod).auth).call("GET", "/api/profiles", timeout=LOOKUP_WAIT).get("profiles", [])
    return {str(r["name"]) for r in rows if isinstance(r, dict) and r.get("name")}


def _lookup(pod) -> Future:
    """파드 하나의 프로파일 목록 조회. 같은 파드에 진행 중인 조회가 있으면 그것을 같이 기다린다(느린 파드에 웹훅 10개 → 조회 하나)."""
    with _INFLIGHT_LOCK:
        fut = _INFLIGHT.get(pod.id)
        if fut is None or fut.done():
            fut = _LOOKUPS.submit(_names_of, pod)
            _INFLIGHT[pod.id] = fut
    return fut


def _ask(pods: list, deadline: float) -> tuple[dict[str, set[str]], list[str]]:
    """({답한 파드 id: 프로파일 이름들}, 답하지 않은 파드 id). 기다림은 바깥에서 min(2초, 남은 시간)으로 자른다."""
    futs = {p.id: _lookup(p) for p in pods}
    done, _ = futures_wait(list(futs.values()), timeout=max(0.0, min(LOOKUP_WAIT, _left(deadline))))
    answered: dict[str, set[str]] = {}
    silent: list[str] = []
    for pid, fut in futs.items():
        if fut in done and fut.exception() is None:
            answered[pid] = fut.result()
        else:
            if fut in done and not isinstance(fut.exception(), HermesError):
                print(f"mindwiki webhook lookup pod={pid} error={type(fut.exception()).__name__}", flush=True)   # i18n-ignore: 서버 로그
            silent.append(pid)
    return answered, silent


def _find_pod(w: dict, deadline: float) -> tuple[object | None, set[str] | None, str]:
    """(파드, 그 파드의 프로파일 이름들, 이유). T 가 있는 작성자 파드가 꼭 하나일 때만 파드를 돌려준다(D6).
    이유: no_agent · ambiguous_profile · hermes_not_ready(답하지 않은 파드가 있어 하나라고 말할 수 없음) · no_profile.
    준비된 파드(registry.pods)와 다시 뜨는 중인 파드(registry.restarting, 답하지 않음으로 센다)만 본다 — 멈춘(suspended) 파드는 어느 쪽에도 없다."""
    if w.get("pod"):                                                   # 지정한 에이전트 하나만 본다 — 같은 이름이 다른 파드에 있어도 막지 않는다(§3-7)
        pod, why = _chosen_pod(w)
        if why:
            return None, None, why
        answered, _ = _ask([pod], deadline)
        if pod.id not in answered:
            return None, None, "hermes_not_ready"
        if w["profile"] not in answered[pod.id]:
            return None, None, "no_profile"
        return pod, answered[pod.id], ""
    user = {"sub": w["sub"], "email": w["email"]}
    reg = server.registry()
    owned = [p for p in list(reg.pods) if p.owned_by(user)]
    ids = {p.id for p in owned}
    restarting = [p for p in list(getattr(reg, "restarting", None) or []) if p.owned_by(user) and p.id not in ids]
    if not owned and not restarting:
        return None, None, "no_agent"
    key = (w["sub"], w["profile"])
    hit = _CACHE.get(key)
    if hit and hit[1] > clones.now():
        pod = next((p for p in owned if p.id == hit[0]), None)      # 캐시가 맞아도 주인을 다시 본다(E8) — owned 에 있어야 한다
        if pod is not None:
            answered, _ = _ask([pod], deadline)
            if w["profile"] in answered.get(pod.id, set()):
                return pod, answered[pod.id], ""
        _CACHE.pop(key, None)                                        # T 가 없거나 답하지 않음 — 다시 찾는다
    answered, silent = _ask(owned, deadline)
    silent += [p.id for p in restarting]
    have = [p for p in owned if w["profile"] in answered.get(p.id, set())]
    if len(have) > 1:
        return None, None, "ambiguous_profile"
    if silent:
        return None, None, "hermes_not_ready"
    if not have:
        return None, None, "no_profile"
    _CACHE[key] = (have[0].id, clones.now() + CACHE_FOR)
    return have[0], answered[have[0].id], ""


def _streak(w: dict, unreachable: bool) -> int:
    key = (w["sub"], w.get("automation_id") or w.get("automation") or "", w["profile"])
    with _STATE_LOCK:
        if not unreachable:
            _STREAK.pop(key, None)
            return 0
        _STREAK[key] = n = _STREAK.get(key, 0) + 1
        if n >= UNREACHABLE_AFTER:
            _STREAK.pop(key, None)
        return n


def _env_text(pod, profile: str) -> str:
    """그 프로파일 .env 글(복제본에 허용 키만 옮기는 데만 쓴다 — 밖으로 내보내지 않는다)."""
    return server._profile_env_text(pod, profile)


def _env_names(api, profile: str) -> set[str]:
    listing = api.call("GET", "/api/env", query={"profile": profile})
    return {r["name"] for r in profiles.env_view(listing) if r["set"]}


def _raw_config(api, profile: str) -> str:
    return str(api.call("GET", "/api/config/raw", query={"profile": profile}).get("yaml") or "")


# 자동화 복제본 하나가 동시에 돌리는 카드 수 상한(스펙 AAS 2026-11-22-004 M11, 사용자 요청 2026-11-22). 카드 하나가 모델을 차례로
# 부르므로 1 이면 그 복제본의 LLM 호출도 동시 하나다. 0 · 빈 값이면 상한 없음(Hermes 가 받는 대로). Hermes 의
# kanban.max_in_progress_per_profile 은 파드의 모든 프로파일에 걸리고 게이트웨이를 다시 띄워야 읽어 쓰지 않는다.
_ACTIVE = ("running", "ready", "todo", "triage")
_STUCK = ("blocked", "review")


def _card_limit() -> int:
    try:
        return max(0, int(os.environ.get("AAS_MINDWIKI_CARD_CONCURRENCY", "0") or 0))
    except ValueError:
        return 0


def _columns(board) -> dict[str, list]:
    """칸반 보드 응답의 열 → 카드 목록. Hermes 는 `columns: [{name, tasks}]` 목록으로 준다(plugins/kanban/dashboard/plugin_api.py).
    사전으로 읽어 M11 상한이 OKE 에서 한 번도 걸리지 않았다(스펙 2026-11-22-008 A3)."""
    cols = (board or {}).get("columns") if isinstance(board, dict) else None
    if isinstance(cols, dict):
        return cols
    return {c["name"]: c.get("tasks") or [] for c in cols or [] if isinstance(c, dict) and isinstance(c.get("name"), str)}


def _unstick(api, tid: str, status_of: dict[str, str], pod_id: str, profile: str) -> bool:
    """todo 카드 tid 의 선행 카드가 모두 막힘 · 검토(_STUCK)면 이음을 지우고 ready 로 돌린다. 풀었으면 True.
    status_of 는 {카드 id: Hermes 상태}다(없는 선행 카드는 막힌 것으로 보지 않는다). 이음이 이미 없으면(404) 넘어간다 —
    위키 파드 여럿이 같은 카드를 함께 풀 수 있다(스펙 2026-11-24-003 C2). 그 밖의 Hermes 실패는 부른 쪽으로 올린다."""
    links = (api.call("GET", f"/api/plugins/kanban/tasks/{tid}", query={"board": mw.BOARD}) or {}).get("links") or {}
    parents = list(links.get("parents") or [])
    stuck = [p for p in parents if status_of.get(p, "") in _STUCK]
    if not stuck or len(stuck) != len(parents):
        return False
    for p in stuck:
        try:
            api.call("DELETE", "/api/plugins/kanban/links", query={"parent_id": p, "child_id": tid, "board": mw.BOARD})
        except HermesError as exc:
            if getattr(exc, "code", 0) != 404:
                raise
    api.call("PATCH", f"/api/plugins/kanban/tasks/{tid}", {"status": "ready"}, {"board": mw.BOARD})
    _log("mindwiki_auto_queue_unstuck", pod=pod_id, profile=profile, task=tid, parents=",".join(stuck))
    return True


def _queue_behind(api, pod_id: str, name: str) -> list[str]:
    """상한이 있으면 그 복제본의 도는 카드를 세어, 상한 이상이면 가장 늦게 만든 카드를 선행 카드로 돌려준다(Hermes 는 선행 카드가
    done · archived 가 되면 뒤 카드를 시작한다). 선행 카드가 막힘 · 검토로 끝나 묶인 뒤 카드는 이음을 풀고 ready 로 돌린다 —
    그대로 두면 줄 전체가 멈춘다. 읽기 · 풀기가 실패하면 로그만 남기고 상한 없이 보낸다(카드를 막지 않는다)."""
    limit = _card_limit()
    if limit <= 0:
        return []
    try:
        cols = _columns(api.call("GET", "/api/plugins/kanban/board", query={"board": mw.BOARD}))
        mine = {t["id"]: (status, t) for status, ts in cols.items() for t in ts or [] if isinstance(t, dict) and t.get("assignee") == name}
        for tid, (status, t) in list(mine.items()):
            if status != "todo" or not (t.get("link_counts") or {}).get("parents"):
                continue
            if _unstick(api, tid, {k: v[0] for k, v in mine.items()}, pod_id, name):
                mine[tid] = ("ready", t)
        active = sorted((t.get("created_at") or 0, tid) for tid, (status, t) in mine.items() if status in _ACTIVE)
    except (HermesError, KeyError, TypeError, AttributeError) as exc:
        if isinstance(exc, HermesError) and _not_ready(exc):
            raise
        _log("WARNING mindwiki_auto_queue_failed", pod=pod_id, profile=name, error=redact(str(exc), 160))
        return []
    if len(active) < limit:
        return []
    _log("mindwiki_auto_queued", pod=pod_id, profile=name, behind=active[-1][1], active=len(active), limit=limit)
    return [active[-1][1]]


def _same_row_card(api, install: str, pod_id: str, name: str, page: str) -> str:
    """같은 행으로 만든 카드가 그 복제본 보드에서 아직 돌면(running · ready · todo · triage) 그 카드 id.
    버튼 카드가 줄을 서 있는 동안 「접수」로 돌린 행을 조건 자동화가 다시 깨워, 한 행에 카드 둘이 초안을 두 벌 썼다
    (스펙 AAS 2026-11-22-004 따로 고칠 것 16 — 스킬 1단계 규칙만으로는 막지 못함). 끝난 카드는 막지 않는다(다시 맡기기).
    원장 · 보드를 읽지 못하면 경고만 남기고 막지 않는다."""
    ids = mw.cards_for_page(install, page)
    if not ids:
        return ""
    try:
        cols = _columns(api.call("GET", "/api/plugins/kanban/board", query={"board": mw.BOARD}))
    except HermesError as exc:
        if _not_ready(exc):
            raise
        _log("WARNING mindwiki_auto_same_row_failed", pod=pod_id, profile=name, error=redact(str(exc), 160))
        return ""
    active = {t["id"] for status, ts in cols.items() if status in _ACTIVE for t in ts or []
              if isinstance(t, dict) and t.get("assignee") == name and isinstance(t.get("id"), str)}
    for tid in ids:
        if tid in active:
            _log("mindwiki_auto_same_row", pod=pod_id, profile=name, page=page, card=tid)
            return tid
    return ""


def _preload_skills() -> bool:
    return os.environ.get("AAS_MINDWIKI_PRELOAD_SKILLS", "1").strip().lower() not in ("0", "false", "no", "off")


def _shared_workdir(name: str) -> dict:
    """복제본마다 고정된 칸반 작업 폴더(workspace_kind=dir). Hermes 는 작업 폴더를 시스템 프롬프트에 적고 그 뒤에 미리 실은 스킬 ·
    도구 설명을 붙인다 — 카드마다 폴더가 다르면 그 뒤 약 2만 7천 토큰이 vLLM 캐시에 맞지 않는다(스펙 AAS 2026-11-23-003, 2026-11-23
    gemma 첫 요청 47초). 폴더는 Hermes 가 만들고 지우지 않는다. 끄려면 AAS_MINDWIKI_SHARED_WORKDIR=0."""
    if os.environ.get("AAS_MINDWIKI_SHARED_WORKDIR", "1").strip().lower() in ("0", "false", "no", "off"):
        return {}
    return {"workspace_kind": "dir",
            "workspace_path": f"{config.DEFAULT_HERMES_HOME}/kanban/boards/{mw.BOARD}/workspaces/shared-{name}"}


def _log(event: str, **kv) -> None:
    print(" ".join([event] + [f"{k}={v}" for k, v in kv.items()]), flush=True)   # i18n-ignore: 서버 로그


def _deliver_template(w: dict, install: str, delivery: str, deadline: float) -> tuple[int, str, str, str]:
    name = mw.profile_for(w["web"], w["profile"])
    try:
        pod, names, why = _find_pod(w, deadline)
        if why == "no_agent":
            return 422, "no_agent", "", name
        if why == "hermes_not_ready":
            if _streak(w, True) >= UNREACHABLE_AFTER:
                return 202, "pod_unreachable", "", name
            return 503, "hermes_not_ready", "", name
        _streak(w, False)
        if why:
            return 202, why, "", name
        api = _Timed(HermesAPI(server.hub(pod).auth), deadline)
        status, reason, tid = _clone_path(w, install, delivery, pod, api, names or set(), name, deadline)
    except _Late:
        return 503, "hermes_not_ready", "", name
    except HermesError as exc:
        if _not_ready(exc):
            return 503, "hermes_not_ready", "", name
        raise
    return status, reason, tid, name


def _clone_path(w: dict, install: str, delivery: str, pod, api, names: set[str], name: str, deadline: float) -> tuple[int, str, str]:
    row = clones.get(pod.id, name)
    if clones.stale_making(row):
        return _stale(pod, name, w)
    if clones.fresh_making(row):                                      # ① 만드는 중(다른 서버 포함)
        return 202, "blocked_no_write_token", ""
    if clones.unsafe(row):                                           # 1시간 안 — 다시 복제하지 않는다(CEO E5)
        return 202, "profile_unsafe", ""
    if name not in names:
        return _begin_clone(w, pod, api, name, deadline)
    reasons = _unsafe_now(api, w["sub"], pod.id, name)              # ② 채널·MCP·write_approval
    if reasons:
        _log("mindwiki_auto_profile_unsafe", pod=pod.id, profile=name, reasons=",".join(reasons))
        return 202, "profile_unsafe", ""
    if not _protected_ready(pod, name, row, deadline):               # ②와 ③ 사이: 복제 때 켠 보호 스킬이 원본과 같은가(되돌림 포함)
        return 202, "profile_preparing", ""
    if not _write_ready(w["sub"], pod.id, name):                     # ③ 자동화 전용 연결
        mindwiki_connect.want_auto(w["sub"], pod.id, name, w["workspace"])
        return 202, "blocked_no_write_token", ""
    _drift(api, pod.id, w["profile"], name, row)                      # T 가 복제 뒤 바뀌었으면 로그만(CEO F6, 카드는 막지 않는다)
    _tune_tools(api, pod.id, name)                                    # 앞서 만든 복제본 · 다시 연결한 복제본의 도구 설정을 맞춘다(M9 · M10)
    _sync_toolsets(api, name, w["web"], skills=True)
    if pod.id not in _BOARDS:
        try:
            # i18n-ignore: Hermes 에 저장되는 보드 이름
            api.call("POST", "/api/plugins/kanban/boards", {"slug": mw.BOARD, "name": "MindWiki 자동화", "description": "MindWiki 자동화 카드"})
        except HermesError as exc:
            if _not_ready(exc):
                raise
        _BOARDS.add(pod.id)
    if _left(deadline) <= 0.05:                                       # ④ 카드 — 마감이 지났으면 만들지 않는다
        return 503, "hermes_not_ready", ""
    same = _same_row_card(api, install, pod.id, name, w.get("page") or "")
    if same:                                                          # 같은 행 카드가 아직 돈다 — 새로 만들지 않고 그 카드로 답한다
        return 202, "ok", same
    c = mw.card(w, install, delivery, clone=True)
    # 켠 보호 스킬을 카드에 실어 시작 때 넣는다 — skill_view 호출 하나가 줄어든다(스펙 AAS 2026-11-22-004 M4). 끄려면
    # AAS_MINDWIKI_PRELOAD_SKILLS=0(복제 경로만 — 기본 경로는 skills 묶음이 꺼져 있어 미리 싣기가 유일한 길이다)
    skills = protected_skills.preload_for(pod.id, name, message=w["instruction"]) if _preload_skills() else []   # 스펙 2026-11-24-002 D8
    parents = _queue_behind(api, pod.id, name)                         # 동시 상한: 도는 카드가 상한이면 그 뒤에 줄 세운다(M11)
    extra = {**({"skills": skills} if skills else {}), **({"parents": parents} if parents else {}), **_shared_workdir(name)}
    try:
        res = api.call("POST", "/api/plugins/kanban/tasks", {**c, "assignee": name, **extra}, {"board": mw.BOARD})
    except HermesError as exc:
        if not skills or _not_ready(exc) or _left(deadline) <= 0.05:
            raise
        # Hermes 가 --skills 이름을 찾지 못하면 카드를 실패로 끝낸다 — 복제본은 skills 묶음이 켜져 있어 skill_view 로 읽을 수 있으니 한 번만 빼고 다시 보낸다
        _log("WARNING mindwiki_auto_preload_failed", pod=pod.id, profile=name, skills=",".join(skills), error=redact(str(exc), 160))
        res = api.call("POST", "/api/plugins/kanban/tasks", {**c, "assignee": name, **({"parents": parents} if parents else {}),
                                                              **_shared_workdir(name)}, {"board": mw.BOARD})
    tid = str((res.get("task") or res).get("id") or "") if isinstance(res, dict) else ""
    if not tid:
        return 503, "hermes_not_ready", ""
    return 202, "ok", tid


def _tune_tools(api, pod_id: str, name: str) -> None:
    """복제본 설정의 도구 몫(칸반 도구 미루기 · MindWiki 도구 처음부터 싣기 · 반복 실패 멈추기)이 빠졌으면 맞춰 쓴다(스펙 AAS
    2026-11-22-004 M9 · M10). 실패는 로그만 — 카드는 막지 않는다."""
    try:
        text = clones.tuned_config(_raw_config(api, name))
        if text is not None:
            api.call("PUT", "/api/config/raw", {"yaml_text": text, "profile": name}, {"profile": name})
            _log("mindwiki_auto_tune_tools", pod=pod_id, profile=name)
    except (HermesError, ValueError) as exc:
        if isinstance(exc, HermesError) and _not_ready(exc):
            raise
        _log("WARNING mindwiki_auto_tune_tools_failed", pod=pod_id, profile=name, error=redact(str(exc), 160))


def _unsafe_now(api, sub: str, pod_id: str, name: str) -> list[str]:
    """쓸 때 점검 ②. MindWiki MCP 서버와 그 키는 그 (작성자, 파드, 복제본)의 자동화 전용 연결 행(AAS 가 발급한 토큰)이 있을 때만 받는다."""
    row = mindwiki_connect._row(sub, pod_id, name) or {}
    return clones.unsafe_reasons(_raw_config(api, name), _env_names(api, name), mindwiki_ok=bool(row.get("tid")),
                                 mindwiki_server=mcp_servers.MINDWIKI, mindwiki_key=mcp_servers.MINDWIKI_KEY)


def _protected_ready(pod, name: str, row: dict | None, deadline: float) -> bool:
    """복제 때 T 에서 물려받은 보호 스킬(상태 행의 skills)이 복제본에 있고 원본과 같은가. 다르면 그 자리에서 되돌린다(2026-11-21-003)."""
    skills = clones.skills_of(row)
    if not skills:
        return True
    ops = server._ProtectedOps(pod)
    template = str((row or {}).get("template") or "")
    for skill in skills:
        left = _left(deadline)
        if left <= 0.05:
            raise _Late()
        if template:
            try:
                _copy_rules(pod.id, template, name, skill)       # T 의 설치 규칙을 같은 판으로(2026-11-24-001 4-5). 시한 검사 뒤에
            except _CloneFailed:
                return False                                 # 규칙 없이 카드를 돌리지 않는다 — 202 profile_preparing, MindWiki 가 다시 보낸다
        fut = _CALLS.submit(protected_skills.apply_now, pod.id, name, skill, ops, wait=min(2.0, left))
        try:
            if not fut.result(timeout=left):
                return False
        except FutureTimeout:
            raise _Late() from None
    return True


def _copy_rules(pod_id: str, template: str, name: str, skill: str) -> None:
    """복제본에 T 의 설치 규칙을 복사한다. DB 오류면 카드를 규칙 없이 돌리지 않게 _CloneFailed(스펙 2026-11-24-001 4-5)."""
    try:
        protected_skills.copy_rules(pod_id, template, name, skill)
    except Exception as exc:  # noqa: BLE001 — 어떤 DB 오류든 규칙 빠진 초안이 정상처럼 나가지 않게 멈춘다
        _log("protected_skill_rules_copy_failed", pod=pod_id, profile=name, skill=skill, error=type(exc).__name__)
        raise _CloneFailed(f"protected_rules:{skill}") from exc


def _drift(api, pod_id: str, template: str, name: str, row: dict | None) -> None:
    want = (row or {}).get("template_sha") or ""
    if not want:
        return
    try:
        now_sha = clones.sha(_raw_config(api, template))
    except HermesError:
        return                                                       # 경고용 읽기 — 카드를 막지 않는다
    if now_sha != want:
        _log("WARNING mindwiki_auto_profile_drift", pod=pod_id, template=template, profile=name)


def _stale(pod, name: str, w: dict) -> tuple[int, str, str]:
    """making 이 10분 넘게 멈췄다: 조건부 UPDATE 에 성공한 서버 하나만 복제본을 지우고 안전하지 않음(1시간)으로 둔다."""
    if clones.take_stale(pod.id, name, SERVER_ID):
        _log("mindwiki_auto_clone_stale", pod=pod.id, profile=name)
        clones.mark_unsafe(pod.id, name, "stale_making")
        threading.Thread(target=_delete_quietly, args=(pod, name, _who(w)), name=f"mwauto-del-{name}", daemon=True).start()
    return 202, "profile_unsafe", ""


def _who(w: dict) -> str:
    return f"system:mindwiki-auto({w.get('email') or w['sub'][:8]})"


def _begin_clone(w: dict, pod, api, name: str, deadline: float) -> tuple[int, str, str]:
    """create_lock 안에서 이름과 상한(3개, 만드는 중 포함)을 다시 보고 making 을 맡은 뒤 뒤 작업을 띄운다. 이번 웹훅은 profile_preparing."""
    owner = f"{SERVER_ID}:{secrets.token_hex(4)}"
    try:
        with marketplace.create_lock(pod.id, timeout=max(0.1, min(2.0, _left(deadline)))):
            known = {str(r.get("name")) for r in api.call("GET", "/api/profiles").get("profiles", []) if isinstance(r, dict)}
            if name in known:                                        # 방금 다른 서버가 만들었다 — 다음 웹훅이 쓸 때 점검을 한다
                return 202, "blocked_no_write_token", ""
            taken = ({n for n in known if mw.is_clone(n)} | set(clones.making(pod.id))) - {name}
            if len(taken) >= _clone_limit():
                return 202, "profile_limit", ""
            if not clones.claim(pod.id, name, w["profile"], owner):
                return 202, "blocked_no_write_token", ""
    except TimeoutError:
        return 503, "hermes_not_ready", ""
    _log("mindwiki_auto_clone_start", pod=pod.id, template=w["profile"], profile=name)
    threading.Thread(target=_make_clone, args=(pod, name, dict(w), owner), name=f"mwauto-{name}", daemon=True).start()
    return 202, "profile_preparing", ""


def _make_clone(pod, name: str, w: dict, owner: str) -> None:
    """뒤 작업(스펙 2026-11-21-002 엔지니어링 재검토 「복제 방식」): ① 빈 프로파일(no_skills, AAS 만들기 경로 — 잠금·예약 이름 통과)
    ② T 의 설정을 바꾼 것(채널 enabled:false·mcp_servers 없음·skills.write_approval) ③ SOUL·AGENTS ④ .env 허용 키 ⑤ T 에서 켠 보호 스킬.
    T 의 사용자 스킬·기억 파일(MEMORY·USER)·예약 작업은 넣지 않는다. 확인에 실패하면 이번에 만든 복제본만 지우고 1시간 안전하지 않음."""
    api = HermesAPI(server.hub(pod).auth)
    template, who, created = w["profile"], _who(w), False
    try:
        with marketplace.create_lock(pod.id):
            known = {str(r.get("name")) for r in api.call("GET", "/api/profiles").get("profiles", []) if isinstance(r, dict)}
            if name in known:                                        # 이미 있는 이름 — 실패로 보지 않는다(지우지 않음·기억 없음)
                clones.drop(pod.id, name, owner)
                _log("mindwiki_auto_clone_exists", pod=pod.id, profile=name)
                return
            # i18n-ignore: Hermes 프로파일 설명(사람이 프로파일 목록에서 본다) — 설치 언어와 관계없이 한 줄로 둔다
            desc = f"MindWiki 자동화 전용({template} 복사). MindWiki 쓰기는 자동화 실행의 대상에만 된다" + (" · 웹 조사" if w["web"] else "")
            server._profile_action(pod, {"action": "create", "name": name, "clone_from": None, "no_skills": True, "description": desc}, who,
                                   auto=True, locked=True)
        created = True
        skills = _build_clone(api, pod, template, name, owner)
        t_sha = clones.sha(_raw_config(api, template))
        if not clones.ready(pod.id, name, owner, t_sha, skills):
            _log("mindwiki_auto_clone_lost", pod=pod.id, profile=name)   # 멈춘 것으로 보고 다른 서버가 가져갔다 — 그쪽이 정리한다
            return
        mindwiki_connect.want_auto(w["sub"], pod.id, name, w["workspace"])   # 다음 로그인 때 자동화 전용 첫 연결(_auto_first)
        try:
            _sync_toolsets(api, name, w["web"], skills=True)
        except HermesError as exc:                                   # 카드 때 다시 맞춘다
            _log("mindwiki_auto_clone_toolsets", pod=pod.id, profile=name, error=redact(str(exc), 120))
        _log("mindwiki_auto_clone_ready", pod=pod.id, template=template, profile=name, protected=",".join(skills) or "-")
    except (HermesError, files.FileError, ValueError, _CloneFailed) as exc:
        _clone_failed(pod, name, owner, created, who, f"{type(exc).__name__}:{redact(str(exc), 160)}")
    except Exception as exc:                                         # 예상하지 못한 오류 — 정리한 뒤 다시 던진다(조용히 삼키지 않는다)
        print(f"mindwiki_auto_clone_error pod={pod.id} profile={name}\n{traceback.format_exc()}", flush=True)   # i18n-ignore: 서버 로그
        _clone_failed(pod, name, owner, created, who, type(exc).__name__)
        raise
    finally:
        try:
            server._forget(pod)
            profile_names.forget(pod.id)
        except Exception:  # noqa: BLE001 — 캐시 버리기 실패는 다음 조회가 덮는다
            pass


def _build_clone(api, pod, template: str, name: str, owner: str) -> list[str]:
    """②~⑤ 와 확인. 돌려주는 값은 복제본에 켠 보호 스킬 이름들."""
    t_cfg = _raw_config(api, template)
    t_env = clones.parse_env(_env_text(pod, template))
    cfg = clones.clone_config(t_cfg, set(t_env))
    api.call("PUT", "/api/config/raw", {"yaml_text": cfg, "profile": name}, {"profile": name})
    clones.beat(pod.id, name, owner)
    q = lambda n: quote(n, safe="")                                  # noqa: E731
    soul = str(api.call("GET", f"/api/profiles/{q(template)}/soul").get("content") or "")
    if soul:
        api.call("PUT", f"/api/profiles/{q(name)}/soul", {"content": soul})
    instructions = server._profile_text_io(api, "agents", template, None)[0]()
    if instructions:
        server._profile_text_io(api, "agents", name, None)[1](instructions)
    clones.beat(pod.id, name, owner)
    allowed = clones.env_allowed(cfg)
    for key in sorted(allowed & set(t_env)):
        value = t_env[key]
        if value and len(value) <= 4000 and not any(c in value for c in "\r\n\x00"):
            api.call("PUT", "/api/env", {"key": key, "value": value, "profile": name}, {"profile": name})
    left_out = sorted(set(t_env) - allowed)
    if left_out:
        _log("mindwiki_auto_clone_env_skipped", pod=pod.id, profile=name, keys=",".join(left_out))   # 이름만 — 값은 남기지 않는다
    clones.beat(pod.id, name, owner)
    skills = protected_skills.enabled_for(pod.id, template)
    if skills:
        ops = server._ProtectedOps(pod)
        for skill in skills:
            _copy_rules(pod.id, template, name, skill)
            if not protected_skills.apply_now(pod.id, name, skill, ops):
                raise _CloneFailed(f"protected:{skill}")
    clones.beat(pod.id, name, owner)
    reasons = clones.unsafe_reasons(_raw_config(api, name), _env_names(api, name), mindwiki_ok=False,
                                    mindwiki_server=mcp_servers.MINDWIKI, mindwiki_key=mcp_servers.MINDWIKI_KEY)
    if reasons:
        raise _CloneFailed("verify:" + ",".join(reasons))
    return skills


def _clone_failed(pod, name: str, owner: str, created: bool, who: str, reason: str) -> None:
    _log("mindwiki_auto_clone_failed", pod=pod.id, profile=name, created=int(created), reason=reason)
    if not created:                                                  # 아무것도 만들지 않았다 — 다음 웹훅이 다시 한다
        clones.drop(pod.id, name, owner)
        return
    clones.mark_unsafe(pod.id, name, reason)                          # 1시간 다시 복제하지 않는다(지우기에 실패해도)
    _delete_quietly(pod, name, who)


def _delete_quietly(pod, name: str, who: str) -> None:
    """복제본을 AAS 의 프로파일 지우기 경로로 지운다(설치 기록·MindWiki 연결 행·보호 스킬 기록도 함께). 실패하면 로그만."""
    try:
        delete_clone(pod, name, who)
        _log("mindwiki_auto_clone_deleted", pod=pod.id, profile=name)
    except (HermesError, files.FileError, ValueError) as exc:
        _log("mindwiki_auto_clone_delete_failed", pod=pod.id, profile=name, error=f"{type(exc).__name__}:{redact(str(exc), 160)}")


def delete_clone(pod, name: str, who: str) -> None:
    """AAS 의 프로파일 지우기(_profile_action delete — 쉬는 대화 닫기·MindWiki 연결 행 forget 포함)와 HTTP 처리기가 뒤에 하는 정리
    (마켓 설치 기록·보호 스킬 기록·캐시). 내보내기는 건너뛴다 — 자동화 전용 복제본에는 사람의 자료가 없다."""
    server._profile_action(pod, {"action": "delete", "name": name, "confirm": name, "skip_export": True}, who)
    marketplace.note_profile(pod.id, name, "forget", who)
    protected_skills.forget_profile(pod.id, name)


# ---- 카드 상태 묻기(스펙 2026-11-22-008 A2, 위키 스펙 2026-11-22-007 D2) ---------------------------------------------------------
# MindWiki 가 맡긴 일(delivery)의 카드가 어디까지 왔는지 15초마다 묻는다. 위키 행의 「AI 작업 중」 표시가 이것을 본다.
CARDS_PATH = "/api/mindwiki/cards"
CARDS_DEADLINE = 8.0             # 받은 때부터 답까지(위키 쪽 제한 10초)
_BOARD_READS = ThreadPoolExecutor(max_workers=4, thread_name_prefix="mw-cards")
_CANCELS = ThreadPoolExecutor(max_workers=4, thread_name_prefix="mw-cancel")   # 카드 보관(도는 카드는 작업 프로세스를 끝내느라 몇 초 걸린다)
# Hermes 칸반 상태 → 위키에 알리는 상태. archived 는 끝난 카드를 치운 것이다
_CARD_STATE = {"triage": "waiting", "todo": "waiting", "ready": "waiting", "running": "running",
               "done": "done", "archived": "done", "blocked": "blocked", "review": "review"}


UNSTICK_MAX = 5                  # 묻기 한 번에 푸는 막힌 카드 수(스펙 2026-11-24-003 C2)
UNSTICK_MIN_LEFT = 2.0           # 마감까지 이보다 적게 남으면 풀지 않고 다음 물음으로 넘긴다
_OPEN = ("triage", "todo", "ready", "running", "blocked", "review")   # 멈출 수 있는 Hermes 상태(C1)


def _board_tasks(pod, timeout: float) -> dict[str, tuple[str, dict]]:
    """파드 하나의 MindWiki 자동화 보드: {카드 id: (Hermes 상태, 카드)}. 치운(archived) 카드까지 본다 — 빠지면 「없어짐」으로 잘못 알린다."""
    board = HermesAPI(server.hub(pod).auth).call("GET", "/api/plugins/kanban/board", query={"board": mw.BOARD, "include_archived": "true"},
                                                 timeout=timeout)
    return {t["id"]: (status, t) for status, ts in _columns(board).items() for t in ts or [] if isinstance(t, dict) and isinstance(t.get("id"), str)}


def _find_cards(install: str, deliveries: list[str], deadline: float) -> dict[str, tuple]:
    """{delivery: (파드 | None, Hermes 상태 | None, 카드 | None, 모두 답했는가, 카드 id, 그 파드의 보드)} — 원장에 있는(이 설치 ·
    카드를 만든) delivery 만.
    작성자의 준비된 파드 보드를 나란히 읽는다(마감 안). 카드를 찾지 못했을 때 「모두 답했는가」는 다시 뜨는 파드가 없고
    작성자의 준비된 파드가 모두 답했다는 뜻이다(파드가 없어도 True). card_states · cancel_cards 가 함께 쓴다."""
    found = mw.cards_of(install, deliveries)
    if not found:
        return {}
    reg = server.registry()
    ready = list(reg.pods)
    restarting = list(getattr(reg, "restarting", None) or [])
    pods_of: dict[str, tuple[list, bool]] = {}                    # 작성자 → (준비된 파드, 다시 뜨는 파드가 있는가)
    for author, _ in found.values():
        if author not in pods_of:
            user = {"sub": author, "email": ""}
            pods_of[author] = ([p for p in ready if p.owned_by(user)], any(p.owned_by(user) for p in restarting))
    pods = {p.id: p for mine, _ in pods_of.values() for p in mine}
    futs = {pid: _BOARD_READS.submit(_board_tasks, pod, max(0.5, _left(deadline))) for pid, pod in pods.items()}
    done, _ = futures_wait(list(futs.values()), timeout=max(0.0, _left(deadline)))
    boards = {pid: f.result() for pid, f in futs.items() if f in done and f.exception() is None}
    out: dict[str, tuple] = {}
    for delivery, (author, card) in found.items():
        mine, waking = pods_of[author]
        hit = next((p for p in mine if p.id in boards and card in boards[p.id]), None)
        if hit is not None:
            status, task = boards[hit.id][card]
            out[delivery] = (hit, status, task, True, card, boards[hit.id])
        else:
            out[delivery] = (None, None, None, not waking and all(p.id in boards for p in mine), card, {})
    return out


def card_states(install: str, deliveries: list[str], deadline: float) -> dict[str, dict]:
    """{delivery: {"state": …}}. 원장에 없거나 다른 설치의 delivery · 답하지 않은 파드 · 다시 뜨는 파드는 unknown.
    작성자의 파드가 모두 답했는데 어느 보드에도 카드가 없으면 gone(파드가 없어도 gone).
    답을 정한 뒤 waiting(todo) 카드 가운데 선행 카드가 모두 막힌 것을 푼다(C2) — 이번 답은 waiting 그대로다."""
    out = {d: {"state": "unknown"} for d in deliveries}
    stuck: list[tuple] = []
    for delivery, (pod, status, task, answered, card, board) in _find_cards(install, deliveries, deadline).items():
        if status is not None:
            out[delivery] = {"state": _CARD_STATE.get(status, "unknown")}
            if (status == "todo" and (task.get("link_counts") or {}).get("parents")
                    and any(s in _STUCK for s, _ in board.values())):
                stuck.append((pod, card, task, board))
        elif answered:
            out[delivery] = {"state": "gone"}
    _unstick_waiting(stuck, deadline)
    return out


def _unstick_waiting(stuck: list[tuple], deadline: float) -> None:
    """선행 카드가 모두 막힌 todo 카드를 최대 UNSTICK_MAX 개 푼다. 마감까지 UNSTICK_MIN_LEFT 초보다 적게 남으면 멈춘다.
    실패는 로그만 남긴다(답은 이미 정했다, 다음 물음이 다시 한다)."""
    unstuck = 0
    for pod, card, task, board in stuck:
        if unstuck >= UNSTICK_MAX or _left(deadline) < UNSTICK_MIN_LEFT:
            return
        profile = str(task.get("assignee") or "")
        try:
            if _unstick(_Timed(HermesAPI(server.hub(pod).auth), deadline), card, {k: v[0] for k, v in board.items()}, pod.id, profile):
                unstuck += 1
        except (HermesError, _Late, KeyError, TypeError, AttributeError) as exc:
            _log("WARNING mindwiki_auto_queue_unstick_failed", pod=pod.id, profile=profile, task=card,
                 error=redact(f"{type(exc).__name__}:{exc}", 160))


def _cancel_one(pod, card: str, deadline: float) -> str:
    """카드 하나를 Hermes 에서 보관(archived)한다: cancelled · done(이미 보관됨, 409) · unknown(그 밖의 실패).
    reclaim 은 쓰지 않는다 — 카드를 ready 로 돌려 다시 돌게 한다. 보관은 도는 작업 프로세스를 끝낸다(archive_task)."""
    try:
        HermesAPI(server.hub(pod).auth).call("PATCH", f"/api/plugins/kanban/tasks/{quote(card, safe='')}", {"status": "archived"},
                                             {"board": mw.BOARD}, timeout=max(0.5, _left(deadline)))
        return "cancelled"
    except HermesError as exc:
        if getattr(exc, "code", 0) == 409:
            return "done"
        _log("WARNING mindwiki_auto_cancel_failed", pod=pod.id, card=card, code=getattr(exc, "code", 0), error=redact(str(exc), 160))
        return "unknown"


def cancel_cards(install: str, deliveries: list[str], deadline: float) -> dict[str, dict]:
    """{delivery: {"state": cancelled | done | gone | unknown}}(스펙 2026-11-24-003 C1). 원장에 없거나 끝났는데 카드 id 가 없음 → gone,
    끝난(done · archived) 카드 → done, 도는 카드 → 보관해 cancelled. 카드를 아직 만드는 중(원장 pending) · 답하지 않은 · 다시 뜨는 파드,
    마감 안에 끝내지 못한 보관 → unknown(위키가 다시 보낸다)."""
    out = {d: {"state": "gone"} for d in deliveries}
    for delivery in mw.pending_of(install, deliveries):
        out[delivery] = {"state": "unknown"}
    where = {d: (None, "") for d in deliveries}
    todo: dict = {}
    for delivery, (pod, status, _task, answered, card, _board) in _find_cards(install, deliveries, deadline).items():
        where[delivery] = (pod, card)
        if status is None:
            out[delivery] = {"state": "gone" if answered else "unknown"}
        elif status in ("done", "archived"):
            out[delivery] = {"state": "done"}
        elif status in _OPEN:
            out[delivery] = {"state": "unknown"}
            if _left(deadline) > 0.05:
                todo[delivery] = _CANCELS.submit(_cancel_one, pod, card, deadline)
        else:
            out[delivery] = {"state": "unknown"}
    if todo:
        done, _ = futures_wait(list(todo.values()), timeout=max(0.0, _left(deadline)))
        for delivery, fut in todo.items():
            if fut in done and fut.exception() is None:
                out[delivery] = {"state": fut.result()}
    for delivery in deliveries:
        pod, card = where[delivery]
        _log("mindwiki_auto_cancelled", delivery=delivery, card=card, pod=getattr(pod, "id", ""), result=out[delivery]["state"])
    return out


async def _cards_call(request: Request, work, what: str):
    """/cards · /cards/cancel 의 공통 틀: 서명(delivery 0 만) · 몸 검사 · 마감 8초 · 답 {cards}."""
    trace = mw.trace_id()
    deadline = time.monotonic() + CARDS_DEADLINE
    try:
        if not mw.enabled():
            raise mw.Reject(503, "webhook_disabled")
        body = await _read(request)
        install, delivery = mw.verify({k.lower(): v for k, v in request.headers.items()}, body)
        if delivery != "0":                                     # 묻기는 delivery 0 으로 서명한다 — 웹훅 서명을 옮겨 쓰지 못하게
            raise mw.Reject(400, "invalid")
        ids = mw.parse_cards(body)
        states = await anyio.to_thread.run_sync(work, install, ids, deadline)
        return _answer(200, "ok", trace, cards=states)
    except mw.Reject as r:
        return _answer(r.status, r.reason, trace)
    except Exception:  # noqa: BLE001 — 위키는 다음 차례에 다시 묻는다
        print(f"mindwiki {what} internal trace={trace}\n{traceback.format_exc()}", flush=True)   # i18n-ignore: 서버 로그
        return _answer(500, "internal", trace)


async def cards(request: Request):
    return await _cards_call(request, card_states, "cards")


# ---- 카드 멈추기(스펙 2026-11-24-003 C1, 위키 스펙 2026-11-24-005) — 사용자가 행의 AI 작업을 멈추면 위키 작업자가 보낸다 ----------------
CANCEL_PATH = "/api/mindwiki/cards/cancel"


async def cancel(request: Request):
    return await _cards_call(request, cancel_cards, "cards cancel")


# ---- 프로파일 목록(스펙 2026-11-21-002 §3-6, 위키 스펙 2026-11-23-003) ------------------------------------------------------------
# MindWiki 「AAS 에이전트 더하기」가 주인의 프로파일을 목록에서 고르게 한다. 웹훅의 _find_pod 와 같은 범위(주인인 파드만, 공유받은
# 파드는 빼고)를 보고, 웹훅이 거절할 이름(template_ok 가 아닌 것·default)은 뺀다. 복제본 상태는 _drift 와 같은 sha 비교다.
PROFILES_PATH = "/api/mindwiki/profiles"
PROFILES_DEADLINE = 8.0          # 받은 때부터 답까지(위키 쪽 제한 10초)
_PROFILE_READS = ThreadPoolExecutor(max_workers=4, thread_name_prefix="mw-profiles")


def _clone_state(api, pod_id: str, template: str, names: set[str], clone: str) -> str:
    """none(복제본 없음) · ready(있고 원본과 같거나 비교할 기록이 없음) · stale(복제 뒤 원본 설정이 바뀜 — 지워야 다시 복제)."""
    if clone not in names:
        return "none"
    want = (clones.get(pod_id, clone) or {}).get("template_sha") or ""
    if not want:
        return "ready"
    try:
        return "ready" if clones.sha(_raw_config(api, template)) == want else "stale"
    except HermesError:
        return "ready"                                               # 비교용 읽기 — 실패하면 있는 것만 알린다


def _pod_profiles(pod, timeout: float) -> list[dict]:
    """파드 하나의 고를 수 있는 프로파일: [{name, title, description, model, clone, web_clone}], 이름순."""
    api = HermesAPI(server.hub(pod).auth)
    rows = [r for r in api.call("GET", "/api/profiles", timeout=timeout).get("profiles", []) if isinstance(r, dict) and r.get("name")]
    names = {str(r["name"]) for r in rows}
    out = []
    for r in rows:
        name = str(r["name"])
        if not mw.template_ok(name) or r.get("is_default"):
            continue
        out.append({"name": name, "title": str(r.get("display_name") or "")[:120], "description": str(r.get("description") or "")[:300],
                    "model": str(r.get("model") or "")[:120],
                    "clone": _clone_state(api, pod.id, name, names, mw.profile_for(False, name)),
                    "web_clone": _clone_state(api, pod.id, name, names, mw.profile_for(True, name))})
    return sorted(out, key=lambda x: x["name"])


def owner_profiles(owner: dict, deadline: float) -> dict:
    """{"pods": [{pod, name, owner_name, reachable, profiles}], "ambiguous": [여러 파드에 있는 이름]}. 답하지 않거나 다시 뜨는
    파드는 reachable false 에 profiles 빈 목록 — 그 파드에 있는 이름이 겹치는지는 알 수 없다(웹훅은 그때 hermes_not_ready)."""
    reg = server.registry()
    mine = [p for p in list(reg.pods) if p.owned_by(owner)]
    ids = {p.id for p in mine}
    waking = [p for p in list(getattr(reg, "restarting", None) or []) if p.owned_by(owner) and p.id not in ids]
    futs = {p.id: _PROFILE_READS.submit(_pod_profiles, p, max(0.5, min(LOOKUP_WAIT, _left(deadline)))) for p in mine}
    done, _ = futures_wait(list(futs.values()), timeout=max(0.0, _left(deadline)))
    names = office_names()
    first = _default_pod_id(owner)
    pods, seen = [], {}
    for p in mine + waking:
        fut = futs.get(p.id)
        ok = fut is not None and fut in done and fut.exception() is None
        rows = fut.result() if ok else []
        for r in rows:
            seen[r["name"]] = seen.get(r["name"], 0) + 1
        label = server._pod_label(p, names)
        pods.append({"pod": p.id, "name": label["name"] or p.id, "owner_name": label["owner_name"], "reachable": ok, "profiles": rows,
                     "default": p.id == first, "chat_default": _chat_default(p)})
    return {"pods": pods, "ambiguous": sorted(n for n, c in seen.items() if c > 1)}


def _default_pod_id(owner: dict) -> str:
    """채팅 위젯이 기본으로 여는 그 사람의 파드(Registry.pick). MindWiki 가 아직 설정하지 않은 사람의 처음 값으로 쓴다(§3-7)."""
    try:
        pod = server.registry().pick(owner, True, "")
    except Exception:  # noqa: BLE001 — 처음 값 꾸밈이다
        return ""
    return pod.id if pod is not None and pod.owned_by(owner) else ""


def _chat_default(pod) -> str:
    """그 파드에서 채팅이 먼저 여는 프로파일(디스크에서 읽는다). 목록에서 뺀 이름(루트 default 등)일 수 있다."""
    try:
        return server._chat_default_of(pod)
    except Exception:  # noqa: BLE001 — 처음 값 꾸밈이다
        return ""


def office_names() -> dict:
    try:
        return server.office.agent_names_provider()
    except Exception:  # noqa: BLE001 — 에이전트 이름은 꾸밈이다. 없으면 파드 id 를 보인다
        return {}


async def profiles_list(request: Request):
    trace = mw.trace_id()
    deadline = time.monotonic() + PROFILES_DEADLINE
    try:
        if not mw.enabled():
            raise mw.Reject(503, "webhook_disabled")
        body = await _read(request)
        _, delivery = mw.verify({k.lower(): v for k, v in request.headers.items()}, body)
        if delivery != "0":                                     # 묻기는 delivery 0 으로 서명한다 — 웹훅 서명을 옮겨 쓰지 못하게
            raise mw.Reject(400, "invalid")
        owner = mw.parse_profiles(body)
        found = await anyio.to_thread.run_sync(owner_profiles, owner, deadline)
        return _answer(200, "ok", trace, **found)
    except mw.Reject as r:
        return _answer(r.status, r.reason, trace)
    except Exception:  # noqa: BLE001 — 위키는 직접 입력으로 돌아간다
        print(f"mindwiki profiles internal trace={trace}\n{traceback.format_exc()}", flush=True)   # i18n-ignore: 서버 로그
        return _answer(500, "internal", trace)


def routes() -> list:
    return [Route(PATH, receive, methods=["POST"]), Route(CARDS_PATH, cards, methods=["POST"]), Route(CANCEL_PATH, cancel, methods=["POST"]), Route(PROFILES_PATH, profiles_list, methods=["POST"])]

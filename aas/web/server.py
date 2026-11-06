"""AAS 제어면 서버 — 로그인, 사용자 → POD 연결, JSON API, 정적 페이지, 채팅 중계.

요청은 uvicorn + Starlette 앱(app.py)이 받고, 아직 옮기지 않은 경로는 이 Handler 를 어댑터(legacy.py)로 실행한다(OMAI-1100).
모든 수집기는 요청한 사용자의 POD(Hermes 데이터 폴더)만 읽는다.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import ipaddress
from datetime import datetime
import contextvars
import html
import json
import math
import os
import posixpath
import re
import ssl
import threading
import time
import types
from http.server import BaseHTTPRequestHandler
from pathlib import Path
from urllib.parse import parse_qs, quote, unquote, urlencode, urlsplit

from ..ops import activity, admin_requests, bundled_repair, changes, channels, chat_hidden, chat_session_meta, collect_all, channel_admin, cron_done, cron_health, cron_policy, dashboard, issue_acks, models, mcp_oauth_relay, mcp_servers, mutes, network_mode, notices, observed, owner_guard, pc_import, profile_copy, shared_skills, slogan, card_brief, tts
from ..fleet import agents, chat_default, export, identity, k8s, lifecycle, primary, profile_names, profiles, retained_volumes, rollouts
from ..common import brand, cache_epoch, config, db, i18n, leader, owner, settings, soul_templates, store, table_cache
from ..common.names import person_name
from ..assets import agent_skills, credentials, explain, files, flow, inventory, skill_graph, skill_header, skill_setup
from ..office import hub_auto, inbox, meeting, meeting_files, office, office_access, office_changed, office_state, presence, relay, shared
from ..auth import keycloak
from ..market import bundle_defaults, bundle_local, bundle_publish, hub_admin, hub_hide, market_dispatch, market_publish, marketplace, publish_auto, skill_bundle, skill_desc, skill_keep, summary as skill_summary, tags as market_tags, updates as market_updates
from ..auth.auth import COOKIE as SESSION_COOKIE, Auth, AuthError, _cookie, _env, has_admin_session, load_users
from ..hermes.hermes_api import HermesAPI, HermesError, job_view, run_view
from ..common.i18n import tr
from ..hermes.hermes_chat import ChatHub, ChatNotFound, ChatUnavailable, SessionBusy, load_settings
from ..hermes import chat_commands, hermes_reader, readers, skill_commands, stt_config, workspace
from ..hermes.readers import remote as hermes_remote, tree_cache
from ..common.redact import redact
from ..fleet.pods import Pod, Registry
from . import skill_files, topics

STATIC_TYPES = {".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8",
                ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2", ".woff": "font/woff",
                ".ico": "image/x-icon", ".glb": "model/gltf-binary", ".mp3": "audio/mpeg",       # .mp3: 오피스 배경음(계획 007 P8)
                # 문서 뷰어(스펙 2026-10-20-005 §5-3): pdf.js 작업 스레드(.mjs)·wasm(이 형식이어야 받으면서 컴파일한다)·cmaps·기본 글꼴
                ".mjs": "text/javascript; charset=utf-8", ".wasm": "application/wasm", ".bcmap": "application/octet-stream",
                ".pfb": "application/octet-stream", ".ttf": "font/ttf"}

STATIC_DIR = Path(os.environ.get("AAS_STATIC_DIR") or Path(__file__).resolve().parent.parent / "static")   # React 빌드 산출물(ui/ → npm run build)
ASSET_CACHE = "public, max-age=31536000, immutable"                  # /assets/ 의 파일 이름에는 내용 해시가 들어 있다
MAX_BODY = 256 * 1024
# 채팅 입력칸 음성 입력(스펙 2026-10-22-005 §3-9). 녹음은 base64 JSON 이라 이 경로만 본문 상한이 크다(60초·32kbps 는 약 0.32MB,
# 비트레이트를 지키지 않는 브라우저의 128kbps 도 약 1.3MB). ASGI 층은 로그인 검사 전에 이만큼 읽으므로 넉넉히 두지 않는다(교차 리뷰 6).
# ASGI 층(legacy.request_limit)도 같은 값을 쓴다 — 한 층만 풀면 다른 층이 413 을 낸다(§9 F1)
TRANSCRIBE_PATH = "/api/chat/transcribe"
TRANSCRIBE_MAX_BODY = 2 * 1024 * 1024
TRANSCRIBE_TIMEOUT = 150            # Hermes 쪽은 stt.openai.timeout 60·max_retries 1 이라 최악 약 120초. 그보다 길게 기다린다(§9-7 Low)
POD_COOKIE = "aas_pod"
# 사용자 단위 서버 고정(스펙 2026-11-05-005 §5-1 U1·U7). 서버가 둘이면 ingress 가 이 값으로 서버를 고른다 — HAProxy 는
# `balance hash req.cook(aas_u)`, nginx 는 `upstream-hash-by: $cookie_aas_u`. 한 사용자의 모든 기기가 같은 서버에 붙어 채팅 세션 목록
# (서버 메모리)이 같다. 로그인 전에는 고정하지 않는다 — 로그인 진행 상태(PKCE·state)는 DB(auth_pending)라 어느 서버가 받아도 된다.
# 🔴 이름에 하이픈을 쓰지 않는다 — nginx 의 $cookie_<이름> 변수는 하이픈 이름을 읽지 못한다(처음 이름 aas-u 를 바꿈, 2026-11-05).
STICKY_COOKIE = "aas_u"
_cache: dict[str, tuple[float, object]] = {}
_building: dict[str, threading.Lock] = {}              # 키마다 만드는 중 표시(같은 값을 동시에 두 번 만들지 않게)
_refreshing: set[str] = set()                          # 뒤에서 다시 만드는 중인 키
_generation: dict[str, int] = {}                       # POD 마다 _forget 한 횟수. 그 전에 시작한 다시 만들기의 결과는 버린다(스펙 2026-10-16-010 D30)
STALE_FACTOR, STALE_MIN = 10, 300.0                     # 만료된 값을 이 안에서는 바로 쓰고 뒤에서 다시 만든다(유효 시간의 10배, 최소 5분)
_lock = threading.Lock()
_hubs: dict[str, ChatHub] = {}
_auth: Auth | None = None
_registry: Registry | None = None


def auth() -> Auth:
    global _auth
    with _lock:
        if _auth is None:
            _auth = Auth()
            _auth.on_login = _first_login
            _auth.on_change = topics.user_changed      # 토큰 갱신이 세션을 끝내거나 관리자 여부를 바꾸면 웹소켓을 바로 다시 검사한다
        return _auth


# 사람(이메일)별 마련 잠금. 같은 사람이 동시에 두 번 들어와도 하나만 만들면 된다 — 서버 전체 잠금이면 etcd 가 느릴 때 모든
# 사람의 로그인이 한 줄로 섰다(스펙 2026-10-24-002 R9). 칸 수를 고정해 잠금 표가 사람 수만큼 커지지 않게 한다
_PROVISION_LOCKS = [threading.Lock() for _ in range(64)]


def _provision_lock(email: str) -> threading.Lock:
    return _PROVISION_LOCKS[int(hashlib.sha1(email.lower().encode()).hexdigest(), 16) % len(_PROVISION_LOCKS)]


def _first_login(who: dict) -> None:
    """OIDC 로그인에 성공한 사람에게 Hermes 가 없으면 첫 HermesAgent 를 만든다(쿠버네티스 모드에서만)."""
    _provision(who["sub"], who["email"], who.get("name", ""))


def _provision(sub: str, email: str, name: str = "") -> str:
    """이 사람의 Hermes 를 마련한다: 이메일로만 주인이 적힌 것에 sub 잇기 → 없으면 첫 HermesAgent 만들기 → 사용 기록 → main 프로파일 표시.
    첫 로그인과 「사용자·권한」의 사람 추가가 함께 쓴다(스펙 2026-10-14-011 C4). 빠뜨리면 화면에서 추가한 사람은 main 프로파일을 받지 못한다.
    돌려주는 값: created(만듦) · exists(이미 있음) · deferred(쿠버네티스 모드가 아님). 쿠버네티스 오류는 그대로 올린다."""
    client = k8s.client()
    if client is None:
        return "deferred"
    reg = registry()
    email_l = email.lower()
    have = [a for a in reg.agents if a.get("owner") == email_l or (sub and a.get("owner_sub") == sub)]
    if have and not (sub and any(a.get("owner") == email_l and a.get("owner_sub") != sub for a in reg.agents)):
        return "exists"                          # 지금 목록으로 이미 마련된 사람 — 로그인마다 k8s 를 다시 읽지 않는다(R9)
    with _provision_lock(email):                 # 같은 사람이 동시에 두 번 들어와도(또는 추가와 첫 로그인이 겹쳐도) 하나만 만든다
        reg.refresh(ttl=0)
        if agents.link_sub(client, reg.agents, sub, email):
            reg.refresh(ttl=0)
        item = agents.ensure_first(client, reg.agents, sub, email, name)
        if not item:
            return "exists"
        reg.refresh(ttl=0)
        pod_id = (item.get("metadata") or {}).get("name", "")
        store.log_usage("agent_first", f"{email} {pod_id}")
        if primary.mark(pod_id):                          # 새 사용자만 주 프로파일(main)을 받는다(스펙 2026-10-14-003 리뷰 D13)
            _IDENTITY_WAKE.set()
        return "created"


def registry() -> Registry:
    global _registry
    with _lock:
        if _registry is None:
            _registry = Registry()
    refresh = getattr(_registry, "refresh", None)          # 쿠버네티스 모드: HermesAgent 목록을 10초마다 다시 읽는다(락 밖에서). 시험의 가짜 등록부에는 없을 수 있다
    if refresh:
        refresh()
    return _registry


def _agent_names() -> dict[str, str]:
    """{설치본 id: 에이전트 이름} — 에이전트 화면과 같은 이름(HermesAgent displayName). 쿠버네티스 모드에서만 있다."""
    return {a["name"]: a["display_name"] for a in (getattr(registry(), "agents", None) or []) if a.get("display_name")}


office.agent_names_provider = _agent_names     # 오피스 자리 별칭이 설치본 id 면 이 이름으로 보인다(스펙 2026-10-18-010)


def _agent_labels() -> dict[str, str]:
    """{설치본 id: 「주인 이름 · 에이전트 이름」}. 이름이 없으면 id, 주인이 없으면 이름만. 오피스 문제 띠·오류 문장이 쓴다(스펙 2026-10-19-003)."""
    names, known = office.agent_names_provider(), office.people()
    out = {}
    for p in getattr(registry(), "pods", []) or []:
        lab = _pod_label(p, names, known)
        out[p.id] = f"{lab['owner_name']} · {lab['name'] or p.id}" if lab["owner_name"] else (lab["name"] or p.id)
    return out


office.agent_labels_provider = _agent_labels


def _attachment(name: str) -> str:
    """내려받기 Content-Disposition. filename 은 ASCII 로 바꾼 이름, filename* 은 UTF-8 원래 이름이다.
    한글 이름은 헤더(Latin-1)에 넣지 못해 500 이 났고, 폴더 이름의 줄바꿈·따옴표가 헤더에 그대로 들어갔다(CodeQL #72)."""
    plain = re.sub(r"[^A-Za-z0-9._-]+", "_", name).strip("._") or "download"
    return f"attachment; filename=\"{plain}\"; filename*=UTF-8''{quote(name, safe='')}"


def _error_body(exc: Exception) -> dict:
    """오류 응답 본문. 문장(error)은 요청 언어로 나가고, reason 이 있으면 화면이 그것으로 종류를 가린다."""
    reason, field = getattr(exc, "reason", ""), getattr(exc, "field", "")
    return {"error": str(exc), **({"reason": reason} if reason else {}), **({"field": field} if field else {})}


class ProfileNotFound(ValueError):
    """없는 프로파일. 처리부가 `getattr(exc, "code", 400)` 으로 404 를 낸다(스펙 2026-10-19-011 R8).
    화면은 상태 코드로 「그 에이전트에 이 이름의 프로파일이 없음」을 가린다. ValueError 를 이어받아 다른 except 는 그대로다."""
    code = 404
    reason = "profile_not_found"

    def __init__(self):
        super().__init__(tr("없는 프로파일입니다", "Profile not found"))


def _lang_key(key: str, per_lang: bool = True) -> str:
    """영어 요청의 캐시 키. 한국어는 원래 키를 그대로 써서 직접 키를 다루는 곳과 맞는다."""
    lang = i18n.get_lang()
    return key if (not per_lang or lang == i18n.DEFAULT) else f"{key}|{lang}"


def _drop_locked(key: str) -> None:
    """키와 그 키의 언어별 항목을 모두 버린다. _lock 을 쥔 채로 부른다."""
    _cache.pop(key, None)
    for lang in i18n.SUPPORTED:
        _cache.pop(f"{key}|{lang}", None)


def _drop_pod_key(pod: Pod, *keys: str) -> None:
    """이 POD 의 캐시 키(접두사 `<POD>:` 를 뗀 이름)를 버리고, 다른 서버 복제본도 버리게 신호를 쓴다(OMAI-1287).
    `_forget` 을 쓰지 않고 키만 골라 버리던 곳(스킬 만들기·올리기 등)이 쓴다. 사이드카의 폴더 묶음(tree) 캐시도 함께 버린다 —
    키만 버리면 다시 만들 때 60초 안의 옛 묶음을 읽어, 바꾼 복제본만 목록이 옛 값이었다(OKE 확인). 신호는 DB 쓰기라 _lock 밖에서 한다."""
    with _lock:
        for key in keys:
            _drop_locked(f"{pod.id}:{key}")
    backend = getattr(getattr(pod, "hermes_home", None), "backend", None)
    if backend is not None:
        backend.invalidate()
    cache_epoch.bump(pod.id)


def _sync_epoch(prefix: str) -> None:
    """다른 복제본이 이 POD 의 캐시를 버렸다는 신호를 봤으면 이 프로세스의 그 POD 캐시도 버린다(OMAI-1287).
    신호는 다시 쓰지 않는다 — 쓰면 복제본끼리 서로 신호를 되울린다."""
    if not cache_epoch.changed(prefix):
        return
    pod = next((p for p in registry().pods if p.id == prefix), None)
    if pod is not None:
        _forget(pod, notify=False)
        return
    with _lock:                                                 # 등록부에 없는 접두사(POD 가 아닌 키): 캐시만 버린다
        _generation[prefix] = _generation.get(prefix, 0) + 1
        for key in [k for k in _cache if k.startswith(prefix + ":") and k.split(":", 1)[1].split("|")[0] != "flow"]:
            _cache.pop(key, None)


def _store_if_current(key: str, gen: int, value) -> None:
    """_lock 을 쥔 채로 부른다. 만드는 사이에 그 POD 를 _forget 했으면 버린다 — 옛 값이 되살아나지 않게(D30)."""
    if _generation.get(key.split(":", 1)[0], 0) == gen:
        _cache[key] = (time.time(), value)


def _cached(key: str, ttl: float, fn, per_lang: bool = True, stale_ok: bool = True):
    """per_lang 이 참이면 요청 언어별로 따로 모아 둔다(문장이 언어에 따라 달라지는 값).
    거짓이면 언어와 무관한 값 하나만 둔다(읽는 때에 번역하는 흐름 그래프).
    stale_ok 가 거짓이면 만료된 값을 돌려주지 않고 기다려 새로 만든다(MCP 로그인 상태처럼 ttl 안에 바뀌어야 하는 값, D30)."""
    key = _lang_key(key, per_lang)
    tree_cache.touch(key.split(":", 1)[0])           # 사람 요청이 이 POD 의 결과를 봤다 — 10분 정리에서 남긴다(D2). 배경 작업은 치지 않는다
    _sync_epoch(key.split(":", 1)[0])                # 다른 서버 복제본이 바꿨으면 먼저 이 프로세스의 캐시를 버린다(OMAI-1287)
    with _lock:
        hit = _cache.get(key)
        if hit and time.time() - hit[0] < ttl:
            return hit[1]
        building = _building.setdefault(key, threading.Lock())
        gen = _generation.get(key.split(":", 1)[0], 0)
        # 만료됐지만 너무 오래되지 않았으면 지난 값을 바로 돌려주고 뒤에서 다시 만든다(OMAI-1102). 기다리는 것은 처음과 _forget 뒤뿐이다
        stale = stale_ok and hit is not None and time.time() - hit[0] < max(ttl * STALE_FACTOR, STALE_MIN)
        refresh = stale and key not in _refreshing
        if refresh:
            _refreshing.add(key)
    if stale:
        if refresh:
            ctx = contextvars.copy_context()                    # 요청 언어를 뒤의 스레드에도 넘긴다
            threading.Thread(target=ctx.run, args=(_refresh_in_background, key, building, fn, gen), daemon=True,
                             name="aas-cache-refresh").start()
        return hit[1]
    with building:                                   # 같은 키를 여러 요청이 동시에 다시 만들지 않는다 — 먼저 온 요청이 만들면 나머지는 그 값을 쓴다(OMAI-1102)
        with _lock:
            hit = _cache.get(key)
            if hit and time.time() - hit[0] < ttl:
                return hit[1]
        value = fn()
        with _lock:
            _store_if_current(key, gen, value)
        return value


def _refresh_in_background(key: str, building: threading.Lock, fn, gen: int) -> None:
    try:
        with building:
            value = fn()
            with _lock:
                _store_if_current(key, gen, value)
    except Exception as exc:                            # 실패하면 지난 값을 그대로 두고 다음 요청이 다시 시도한다
        print(f"캐시 다시 만들기 실패 {key.split('|')[0][:60]}: {type(exc).__name__}", flush=True)   # i18n-ignore: 로그
    finally:
        with _lock:
            _refreshing.discard(key)


OFFICE = office_state.Office()
PRESENCE = presence.Presence()
PRESENCE_BUS = office_state.OfficeBus(keep=500)        # 사람 아바타 걸음(계획 007 P6b). 오피스 버스와 따로 둬 걸음이 자리 이벤트를 밀어내지 않는다
PRESENCE_EVERY = 0.3                                   # 반복 스레드 주기(초). DB 읽기는 알림이 올 때나 5초마다만(PostgreSQL, 스펙 2026-10-24-009 4절)
SHARED = shared.Shared()                               # 서버 복제본 사이에 받은편지함·말풍선·일하는 중을 나눈다(OMAI-1105 복제본 2개)
SHARED.attach(OFFICE.bus)
SHARED.relay_status = lambda: leader.is_leader()        # 자리 상태는 리더만 중계한다(스펙 2026-10-24-011 R3)
OFFICE.remote_busy = SHARED.remote_busy
INBOX = inbox.Pending(shared=SHARED)


def inbox_topic(email: str) -> str:
    """받은편지함 신호 토픽 이름(스펙 2026-10-17-004). 이메일은 소문자, 로그인을 끈 실행은 local."""
    return f"office:inbox:{str(email or '').strip().lower() or 'local'}"


INBOX.notify = lambda emails: [topics.invalidate(inbox_topic(e), exact=True) for e in emails]


def _cards_changed() -> None:
    topics.invalidate("office:cards", exact=True)
    topics.invalidate("office:inbox:")                  # 검토·막힘 카드는 받은편지함 항목이기도 하다


hub_auto.ON_CARDS_CHANGED.append(_cards_changed)
# 오피스 정보 변경 번호(스펙 2026-10-26-001): 이 서버의 신호 토픽은 곧바로, 다른 서버는 shared 알림(office_changed)으로 다시 읽는다.
# 부서 쓰기는 aas/common 층이라 웹 서버를 모르므로 settings 에 넣어 준다
office_changed.after = lambda: topics.invalidate("office:changed", exact=True)
settings.changed_hook = office_changed.bump
ANSWER_WAIT = 8.0                                      # 다른 서버가 연 대화에 답할 때 결과를 기다리는 시간(초)


RUNNING_TTL = 10                 # 「일하는 중」(5초 → 10초, 사용자 결정 2026-10-24, 스펙 2026-10-24-011 R4). 오피스 표시가 최대 이만큼 늦다
EXEC_PROFILES_TTL = 60           # 실행 기록 DB 가 있는 프로파일 구성(R1). AAS 가 그 에이전트를 고치면 _forget 이 바로 버린다


def _exec_profiles(pod: Pod) -> list:
    """실행 기록 DB 가 있는 프로파일. 5초마다 데이터 폴더·profiles 폴더·프로파일 목록·프로파일마다 DB 있음을 사이드카에 다시 물었다
    (stat 캐시 2초가 주기보다 짧았다, 스펙 2026-10-24-011 R1). 구성은 거의 바뀌지 않아 기억한다."""
    def read():
        return [p for p in cron_health.hr.profiles(pod.hermes_home) if (p.path / "cron" / "executions.db").is_file()]
    return _cached(f"{pod.id}:exec-profiles", EXEC_PROFILES_TTL, read, per_lang=False)


def _running_profiles(pod: Pod) -> set[str]:
    """크론 실행이나 칸반 카드가 지금 돌고 있는 프로파일 이름들(RUNNING_TTL 캐시). 읽지 못하면 예외를 그대로 올려 그 설치본을 error 로 본다."""
    def read():
        out = set()
        execs = cron_health.hr.read_executions_many(_exec_profiles(pod), check_files=False)   # 한 번에(OMAI-1102), 구성은 기억한 것
        for name, ex in execs.items():
            if isinstance(ex, cron_health.hr.SchemaMismatch):
                raise ex
            if ex.running:
                out.add(name)
        return out | _card_running(pod)
    return _cached(f"{pod.id}:running", RUNNING_TTL, read)


_auto: hub_auto.Auto | None = None
OFFICE_REST = ("/api/office/kanban/", "/api/office/cron/", "/api/office/meeting/", "/api/office/chat/")   # 칸반·크론(hub_auto.route)과 회의 말하기
OFFICE_READ = ("/api/office/events", "/api/office/meeting")                           # 읽기 전용 경로(질의 문자열만 받는다)
_meeting_obj: meeting.Meeting | None = None


def office_auto() -> hub_auto.Auto:
    """칸반·크론 번역기. 설치본의 대화 채널(hub)은 채팅과 같은 것을 쓴다."""
    global _auto
    reg = registry()                                              # _lock 은 다시 잠글 수 없어서 락 밖에서 먼저 얻는다
    with _lock:
        if _auto is None:
            _auto = hub_auto.Auto(relay.Bridge(reg, hub_factory=hub))
            _auto.allowed = _owner_may_use
        return _auto


def _owner_may_use(email: str, alias: str) -> bool:
    """카드를 맡긴 사람이 지금도 그 에이전트를 시킬 수 있는가(방 구성원·소유·관리자). 실행할 때마다 불린다."""
    # 관리자 신분은 로그인 세션(토큰의 역할)에 있다. 이메일만 넘기면 Keycloak 역할로 관리자가 된 사람의 카드가 모두 막힌다.
    return office_access.Access(registry(), {"email": email, "admin": has_admin_session(email)}, True).can_use(alias)


def office_meeting() -> meeting.Meeting:
    global _meeting_obj
    auto = office_auto()
    with _lock:
        if _meeting_obj is None:
            _meeting_obj = meeting.Meeting(auto.bridge, workspace_for=_workspace_for_pod_id, origin=SHARED.origin)   # 회의 목록을 서버 사이에 나눈다(2026-10-20-017 R4)
            _meeting_obj.alive_source = SHARED._alive                # 살아 있는 서버 기억을 하나로 — 둘이 따로 읽었다(스펙 2026-10-26-002 §9-12)
        return _meeting_obj


def _workspace_for_pod_id(pod_id: str):
    """설치본 id 로 그 작업 폴더(회의의 파일 첨부·결과 파일 칩이 쓴다). 없는 설치본·로컬 폴더 설치본은 None."""
    pod = next((p for p in registry().pods if p.id == pod_id), None)
    return workspace_for(pod) if pod else None


def _running_cards_read() -> dict[str, set[str]]:
    def read() -> dict[str, set[str]]:
        with hub_auto._db() as conn:
            rows = conn.execute("SELECT DISTINCT pod, assignee FROM office_cards WHERE status='running'").fetchall()
        out: dict[str, set[str]] = {}
        for r in rows:
            out.setdefault(r[0], set()).add(r[1])
        return out
    return table_cache.get("cards.running", ("office_cards",), read)   # 어느 서버가 카드를 써도 표 바뀜 알림으로 버린다(스펙 2026-10-26-002 §9-14)


CARDS_TTL = 10.0                 # 진행 카드 기억(초). 카드 상태는 이미 20초 주기 값이라 보이는 늦음이 늘지 않는다(스펙 2026-10-26-002 R5·E7)
_cards_clock = time.monotonic
_cards_lock = threading.Lock()
_cards_memo: dict[tuple, tuple[float, int, dict[str, set[str]]]] = {}   # (백엔드, 데이터 폴더, 스키마) → (읽은 시각, 카드 쓰기 세대, 진행 카드)


def _running_cards() -> dict[str, set[str]]:
    """진행 카드를 프로세스에 10초 기억한다. 「일하는 중」 뒤 새로 고침이 에이전트마다 따로 돌아 요청 범위 메모 밖에서 에이전트마다 물었다.
    이 서버가 카드 표를 쓰면(hub_auto.cards_written) 기다리지 않고 다시 읽는다 — 읽기 전 세대를 적어 두어, 읽는 사이에 쓴 것도 놓치지 않는다.
    같은 열쇠는 한 스레드만 읽는다. 돌려주는 값은 복사본이다(부른 쪽이 고쳐도 기억한 값은 그대로)."""
    key = (db.backend(), os.environ.get("AAS_DATA_DIR", ""), os.environ.get("AAS_DB_SCHEMA", ""))
    with _cards_lock:
        hit = _cards_memo.get(key)
        if hit is None or _cards_clock() - hit[0] >= CARDS_TTL or hit[1] != hub_auto.cards_gen():
            gen = hub_auto.cards_gen()
            hit = (_cards_clock(), gen, _running_cards_read())
            _cards_memo[key] = hit
    return {k: set(v) for k, v in hit[2].items()}


def _running_cards_clear() -> None:
    with _cards_lock:
        _cards_memo.clear()


def _card_running(pod: Pod) -> set[str]:
    """맡은 카드가 진행 칸에 있는 자리의 프로파일 이름들. 카드 상태는 보드를 볼 때와 20초 주기에 갱신된 마지막 값이다.
    진행 카드는 모든 에이전트 것을 한 번에 묻는다 — 반복 한 번에 에이전트마다 물었다(스펙 2026-10-24-011 R2)."""
    by_alias = {s["alias"]: s["profile"] for s in office.seats() if s["pod"] == pod.id}
    return {by_alias[a] for a in store.memo("office.running_cards", _running_cards).get(pod.id, ()) if a in by_alias}


COLLECTED_MAX_AGE = 60.0        # 담당 서버가 적은 에이전트별 재료를 쓰는 시간(초, 스펙 2026-10-25-001 R2·D1). 넘으면 담당이 멈춘 것으로 보고 직접 계산한다


def _alive_origins() -> list[str]:
    """살아 있는 서버 origin. DB 를 못 읽으면 나만 — 그동안은 모든 에이전트를 내 몫으로 본다(겹쳐 읽을 뿐 빠지지 않는다)."""
    try:
        return SHARED.alive_servers()
    except Exception:
        return [SHARED.origin]


class _RegView:
    """등록부와 같되 pods 만 이 서버가 맡는 에이전트인 것(스펙 2026-10-24-013 3단계 D5). 다른 속성은 원래 등록부를 그대로 쓴다."""

    def __init__(self, reg, pods: list):
        self._reg, self.pods = reg, pods

    def __getattr__(self, name):
        return getattr(self._reg, name)


def _my_registry(reg):
    return _RegView(reg, owner.mine(list(reg.pods), SHARED.origin, _alive_origins()))


_collect_state: dict[str, tuple[str, float]] = {}      # pid -> (hash, last_written_t)


def _collect_mine(reg) -> None:
    """이 서버가 맡은 에이전트만 사이드카를 읽어 (실패·실행 중·읽지 못함)을 에이전트별 줄로 적는다(5초 반복, 모든 서버).
    내용이 같으면 DB 쓰기를 생략하되 10초마다 하트비트로 생존 갱신한다(스펙 2026-10-25-001 R2·D1)."""
    seats = office.seats()
    used = {s["pod"] for s in seats if s.get("enabled", True)}
    pods = [p for p in owner.mine(list(reg.pods), SHARED.origin, _alive_origins()) if p.id in used]
    failed, running, bad = office_state.collect(pods, _health, _running_profiles, used)
    now = time.time()
    to_write = {}
    current_pids = set()
    for p in pods:
        current_pids.add(p.id)
        f_p = {k for k in failed if k[0] == p.id}
        r_p = {k for k in running if k[0] == p.id}
        b_p = p.id in bad
        entry = (f_p, r_p, b_p)
        h = hashlib.sha1(f"{sorted(f_p)}:{sorted(r_p)}:{b_p}".encode()).hexdigest()
        prev_h, prev_t = _collect_state.get(p.id, ("", 0.0))
        if prev_h != h or (now - prev_t) >= 10.0:
            to_write[p.id] = entry
            _collect_state[p.id] = (h, now)
    for dead_pid in list(_collect_state.keys()):
        if dead_pid not in current_pids:
            _collect_state.pop(dead_pid, None)
    if to_write:
        SHARED.put_collected_pods(to_write)


def _merged_collected(pods: list, seats: list[dict]) -> tuple[set, set, set]:
    """담당 서버들이 적은 에이전트별 줄(15초 안)을 합친다. 줄이 없거나 오래된 에이전트(담당이 죽었거나 막 바뀜)는 이 서버가 직접 읽는다
    (스펙 2026-10-24-013 3단계 T2)."""
    used = {s["pod"] for s in seats if s.get("enabled", True)}
    try:
        rows = SHARED.get_collected_pods(COLLECTED_MAX_AGE)
    except Exception:                                        # DB 가 잠시 끊기면 모두 직접 읽는다
        rows = {}
    missing = [p for p in pods if p.id in used and p.id not in rows]
    failed, running, bad = office_state.collect(missing, _health, _running_profiles, used) if missing else (set(), set(), set())
    for pid, (f, r, b) in rows.items():
        failed |= f
        running |= r
        if b:
            bad.add(pid)
    return failed, running, bad


def _office_snapshot(reg: Registry) -> dict:
    """오피스 상태. 사이드카 재료는 담당 서버들이 적은 에이전트별 줄을 합쳐 쓴다(스펙 2026-10-24-013 R11)."""
    seats = office.seats()
    collected = _merged_collected(list(reg.pods), seats)
    snap = OFFICE.snapshot(reg.pods, seats, _health, _running_profiles, collected=collected)
    return {**snap, "desks": office.desk_assignments(), "layout_version": office.layout()["version"]}


def _with_agent_names(agents: list[dict]) -> list[dict]:
    """오피스 에이전트 서랍용 이름. label=자리의 화면 이름(seat_labels), pod_name=설치본의 에이전트 이름(없으면 빈 값). 스펙 2026-10-18-014."""
    labels, names = office.seat_labels(), office.agent_names_provider()
    return [{**a, "label": labels.get(a["alias"], a["alias"]), "pod_name": names.get(a["pod"], "")} for a in agents]


def _office_snapshot_for(acc: office_access.Access) -> dict:
    """장면 스냅샷. 보는 사람의 보기 범위(내 것·내 TFT 방·내 부서 팀 자리, 스펙 2026-10-21-022)의 에이전트만 준다 — 계획 007 R5 「하나의 오피스」를 바꿈.
    이벤트와 책상 배정(desks)은 거르지 않는다: 화면은 장면에 없는 자리의 이벤트를 무시하고, desks 는 사람이 앉을 의자를 고를 때 쓴다(리뷰 R3·R7).
    보는 사람마다 「내 에이전트」 표시와 주인 이름을 붙인다(P6a). 주인 이메일은 관리자에게만 준다(R6)."""
    with store.request_memo():                             # 같은 DB 읽기를 한 번만(스펙 2026-10-24-006 §6). 부른 쪽이 이미 켰으면 그것을 쓴다
        return _office_snapshot_body(acc)


def _office_snapshot_body(acc: office_access.Access) -> dict:
    reg = registry()
    snap = _office_snapshot(reg)
    owners = {p.id: (p.owner or "") for p in reg.pods}
    known = office.people()
    scene = acc.scene_aliases()
    agents = []
    for a in snap["agents"]:
        if a["alias"] not in scene:
            continue
        owner = owners.get(a["pod"], "")
        row = {**a, "owner_name": office.display_name(owner, known) if owner and owner != "*" else "",
               "owner_seed": (known.get(owner.lower()) or {}).get("seed") or (presence.person_id(owner) if owner else ""),
               "mine": bool(acc.email) and owner.lower() == acc.email}
        if acc.admin:
            row["owner_email"] = owner
        agents.append(row)
    return {**snap, "agents": _with_agent_names(agents), "rooms": _office_room_labels(acc)}


def _office_room_labels(acc: office_access.Access) -> list[dict]:
    """배치의 방 표시(room)마다 문 위에 보일 이름(계획 2026-10-13-001 R3·R4·R6).
    TFT 회의실은 짝지어진 AAS 방의 이름을 구성원·관리자에게만 보이고, 나머지에게는 「<회의실> · 사용 중」만 보인다.
    방 번호(room)는 위치일 뿐이라 모두에게 준다(회의 때 그 방으로 모이는 것은 모두에게 보인다, 007 R5).
    팀 회의실은 짝지어진 팀 방의 이름으로 「<팀> 회의실」(번호 room 도 준다 — 팀 회의 때 모인다). 짝이 없으면 「팀 회의실 N」 그대로
    (계획 2026-10-13-011 §3-1, 리뷰 A3·A4). 팀 이름은 모두에게 같게 보인다."""
    items = office.layout()["items"] or []
    by_place = {uid: rid for rid, uid in office.room_places().items()}
    names = {r["id"]: r["name"] for r in office.rooms()}
    out = []
    for it in items:
        if it.get("type") != "room":
            continue
        base = str(it.get("label") or "")
        row = {"uid": it["_uid"], "kind": it.get("kind") or "", "label": base}
        if it.get("kind") == "tft" and it["_uid"] in by_place:
            rid = by_place[it["_uid"]]
            row["room"] = rid
            row["label"] = names.get(rid, base) if acc.member_of(rid) else tr(f"{base} · 사용 중", f"{base} · in use")
        elif it.get("kind") == "team" and it["_uid"] in by_place:      # 팀 방과 짝지어진 팀 회의실: 「<팀> 회의실」(계획 2026-10-13-011 §3-1)
            rid = by_place[it["_uid"]]
            row["room"] = rid                                          # 팀 회의 때 이 회의실로 모인다(meetingSeatsByAgent)
            row["label"] = _team_room_label(names.get(rid, base))
            if names.get(rid):
                row["name"] = names[rid].strip()                       # 팀 이름(모두에게 같다). 대회의실 명패 둘째 줄(스펙 2026-10-20-017 디자인 리뷰 이슈 2)
        # 짝이 없는 팀 회의실은 「팀 회의실 N」 그대로 둔다. 구역의 주 팀 이름을 붙이면 그 팀 회의가 다른 회의실로 모일 때
        # 이름표와 실제 모이는 곳이 어긋난다(리뷰 A3·A4) — 이름표는 실제 짝(팀 방)만 따른다
        out.append(row)
    return out


def _team_room_label(team: str) -> str:
    """팀 회의실 이름표. 팀 이름이 이미 「회의실」로 끝나면 덧붙이지 않는다(계획 2026-10-13-011 Q1). 팀 이름은 비밀이 아니라 모두에게 같다."""
    team = team.strip()
    return team if team.endswith(tr("회의실", "meeting room")) else tr(f"{team} 회의실", f"{team} meeting room")


def _health(pod: Pod):
    return mutes.apply(_cached(f"{pod.id}:health", 30, lambda: cron_health.collect(home=pod.hermes_home)))


def health_payload(pod: Pod) -> dict:
    """/api/health 와 웹소켓 토픽 pod:<id>:health 가 같이 쓰는 본문(접속 주소에 따라 달라지는 dashboard_url 은 뺀다)."""
    health = dict(_health(pod))
    down = {r["name"]: r for r in _channels(pod)["profiles"] if r["running"] is False}
    health["stalled"] = [
        {**j, "cause": (tr("게이트웨이가 꺼져 있음", "Gateway is off") + (tr(" (일부러 꺼 둠)", " (turned off on purpose)") if (down[j["profile"]].get("service") or {}).get("disabled") else ""))
         if j["profile"] in down else ""} for j in health["stalled"]]
    return health


def dashboard_url(host_header: str) -> str:
    """접속한 주소와 같은 곳의 Hermes 대시보드."""
    host = (host_header or "localhost").rsplit(":", 1)[0]
    return os.environ.get("AAS_DASHBOARD_PUBLIC_URL") or f"http://{host}:{os.environ.get('AAS_DASHBOARD_PUBLIC_PORT', '9119')}"


def _skills(pod: Pod):
    return _cached(f"{pod.id}:skills", 300, lambda: skill_graph.build(pod.hermes_home))


def _flow(pod: Pod):
    return _cached(f"{pod.id}:flow", 900, lambda: flow.build(pod.hermes_home), per_lang=False)


def _observed(pod: Pod):
    return _cached(f"{pod.id}:observed", 300, lambda: observed.collect(pod.hermes_home))


_observed_warming: set[str] = set()


def _observed_ready(pod: Pod):
    """세션 기록 집계가 이미 있으면 그 값, 없으면 None 을 바로 돌려주고 뒤에서 만든다(스펙 2026-11-06-002 E5).
    집계는 최근 세션 기록을 모두 읽어 처음 한 번이 수 초 걸린다 — 스킬 목록이 그만큼 기다렸다. 다 만들면 스킬 상태를 버려 다음 읽기에 관측 횟수가 붙는다."""
    with _lock:
        ready = _lang_key(f"{pod.id}:observed") in _cache
        start = not ready and pod.id not in _observed_warming
        if start:
            _observed_warming.add(pod.id)
    if ready:
        return _observed(pod)

    def warm():
        try:
            _observed(pod)
            with _lock:
                _cache.pop(_lang_key(f"{pod.id}:skill_states", False), None)
        except Exception as exc:
            print(f"세션 기록 집계 실패 {pod.id}: {type(exc).__name__}", flush=True)   # i18n-ignore: 로그
        finally:
            with _lock:
                _observed_warming.discard(pod.id)
    if start:
        threading.Thread(target=contextvars.copy_context().run, args=(warm,), daemon=True, name="aas-observed-warm").start()
    return None


def _skill_states(pod: Pod) -> tuple[dict, list]:
    """에이전트(프로파일)별 스킬 상태(켜짐·사용 기록·설정 필요·동작 형태)와 왼쪽 칸 요약. 프로파일을 바꾸면(_forget) 다시 읽는다."""
    def build():
        try:
            obs = _observed_ready(pod)
        except Exception:                                      # 세션 기록을 못 읽어도 목록은 보인다 — 관측 횟수만 빈다
            obs = None
        return agent_skills.annotate(pod.hermes_home, hermes_reader.profiles(pod.hermes_home), _skills(pod)["skills"], obs)
    return _cached(f"{pod.id}:skill_states", 60, build, per_lang=False)


HUB_ADMIN_WRITES = ("/api/market/publish/upload", "/api/market/publish/direct", "/api/market/publish/retry", "/api/market/hub/hide", "/api/market/hub/show")   # 관리자 직접 게시·허브에서 숨기기(스펙 2026-10-29-002)
HUB_ADMIN_KEY = "hub-admin"                       # 관리자 직접 게시의 임시 보관 키 — 작업공간(POD)이 없다
MARKET_CATALOG_TTL, MARKET_FAIL_TTL, MARKET_UPDATES_TTL = 600, 60, 120   # 허브 목록 10분·허브 장애 60초·판 비교 120초(스펙 2026-10-24-003 R8·R13·R20)
_updates_warming: set[str] = set()


def _catalog() -> dict:
    """스킬 허브 목록 {ok, items, error, at}. 서버 전체가 하나를 쓴다(키 market:catalog, 복제본 신호 접두사 market, R8·R20).
    허브 장애는 60초만 기억하고 다시 묻는다(외부 검토 7) — 장애 동안 알림이 없고 화면은 오류 배너를 보인다."""
    def build():
        cfg = marketplace.settings()
        if not cfg["url"]:
            return {"ok": False, "items": [], "error": "", "at": time.time()}
        try:
            return {"ok": True, "items": marketplace.catalog(cfg), "error": "", "at": time.time()}
        except marketplace.MarketError as exc:
            return {"ok": False, "items": [], "error": str(exc), "at": time.time()}
    got = _cached("market:catalog", MARKET_CATALOG_TTL, build, per_lang=False)
    if not got["ok"] and time.time() - got["at"] > MARKET_FAIL_TTL:
        with _lock:
            _drop_locked("market:catalog")
        got = _cached("market:catalog", MARKET_CATALOG_TTL, build, per_lang=False)
    return got


def _forget_market_catalog() -> None:
    """허브 목록이 바뀌었다(올리기 승인·태그 새로 고침·설치 끝, R8·R14·R20). 다른 복제본도 버리게 신호를 쓴다."""
    with _lock:
        _drop_locked("market:catalog")
    cache_epoch.bump("market")


def _market_updates(pod: Pod) -> list[dict]:
    """이 작업공간의 판 비교 결과(120초, 키 <pod>:updates — _forget(pod)·복제본 신호로 비워진다, R13). 허브를 못 읽으면 빈 목록.
    사이드카를 못 읽으면 예외를 그대로 올린다."""
    def build():
        cat = _catalog()                                           # 모아 둔 값이 있으면 허브를 다시 묻지 않는다
        return market_updates.scan(pod.id, pod.hermes_home, cat["items"]) if cat["ok"] else []
    return _cached(f"{pod.id}:updates", MARKET_UPDATES_TTL, build, per_lang=False)


def _market_updates_peek(pod: Pod) -> list[dict]:
    """「확인할 것」·메뉴 수가 쓰는 판 비교 결과. 모아 둔 값이 있을 때만 붙이고, 없으면 뒤에서 만들게 하고 빈 목록을 준다 —
    프로파일 목록·/api/me 가 사이드카 읽기를 기다리지 않게(외부 검토 7)."""
    with _lock:
        hit = _cache.get(f"{pod.id}:updates")
        if hit is not None and time.time() - hit[0] >= max(MARKET_UPDATES_TTL * STALE_FACTOR, STALE_MIN):
            hit = None                                             # 너무 오래돼 _cached 가 기다려 새로 만들 값 — 기다리지 않고 뒤에서 만든다
        if hit is None:
            if pod.id in _updates_warming:
                return []
            _updates_warming.add(pod.id)
    if hit is not None:
        try:
            return _market_updates(pod)
        except Exception:                                          # 사이드카에 잠깐 닿지 않음 — 알림 없이 둔다
            return []

    def warm():
        try:
            _market_updates(pod)
        except Exception as exc:
            print(f"버전 비교 실패 {pod.id}: {type(exc).__name__}", flush=True)   # i18n-ignore: 로그
        finally:
            with _lock:
                _updates_warming.discard(pod.id)
    threading.Thread(target=warm, daemon=True, name="aas-market-updates").start()
    return []


def _market_modified(pod: Pod, rows: list[dict]) -> None:
    """목록 줄마다 고친 내용 판정(R17)을 붙인다. 모아 둔 판정이 없으면 「확인 중」(checking)으로 두고 뒤에서 판정한다(D17).
    판정은 120초 기억하고 _forget(pod) 때 함께 버린다(키가 <pod>: 로 시작한다)."""
    todo = []
    now = time.time()
    with _lock:
        for r in rows:
            if r["state"] != "update":
                continue
            hit = _cache.get(f"{pod.id}:mod:{r['profile']}:{r['package']}:{r['current']}")
            if hit and now - hit[0] < MARKET_UPDATES_TTL:
                r["modified"] = hit[1]
            else:
                r["modified"] = "checking"
                todo.append(r)
        key = f"{pod.id}:modwarm"
        if not todo or key in _updates_warming:
            return
        _updates_warming.add(key)
        gen = _generation.get(pod.id, 0)

    def judge():
        try:
            for r in todo:
                got = market_updates.modified(pod.hermes_home, r)
                with _lock:
                    _store_if_current(f"{pod.id}:mod:{r['profile']}:{r['package']}:{r['current']}", gen, got)
        finally:
            with _lock:
                _updates_warming.discard(key)
    threading.Thread(target=judge, daemon=True, name="aas-market-modified").start()


def _market_update_list(reg: Registry, current: Pod, user, auth_enabled: bool, scope: str) -> dict:
    """스킬 허브 「새 버전 있음」 목록(스펙 2026-10-24-003 R5·D7·D8·D17). scope=pod 는 지금 작업공간, managed 는 내가 올릴 수 있는 모든 작업공간
    (관리자=전부, 주인=자기 것, 팀 관리자=팀원 것). 줄마다 상태·고친 내용 판정·대기·실패를 붙인다."""
    admin = (not auth_enabled) or reg.is_admin(user)
    manageable = [p for p in reg.pods if admin or _manages_pod(p, user, auth_enabled)]
    pods = manageable if scope == "managed" else [current] if any(p.id == current.id for p in manageable) else []
    cat = _catalog()
    got = collect_all.map_pods(pods, _market_updates, timeout=_PROFILES_ALL_TIMEOUT) if cat["ok"] else {}
    names, known = office.agent_names_provider(), office.people()
    rows, failed = [], []
    for pod in pods:
        ok, value = got.get(pod.id, (cat["ok"], []))
        if not ok:
            failed.append({"pod": pod.id, **_pod_label(pod, names, known)})
            continue
        mine = [dict(r) for r in value]
        waiting = {(q["profile"], q["package"]): q for q in market_updates.pending(pod.id)}
        reqs = marketplace.requests(pod.id, 300)
        auto = {(a["profile"], a["package"], a["version"]): a for a in market_updates.auto_rows(pod.id)}
        _market_modified(pod, mine)
        label = _pod_label(pod, names, known)
        for r in mine:
            r["pod_name"], r["pod_owner_name"] = label["name"], label["owner_name"]
            last = next((q for q in reqs if q["profile"] == r["profile"] and q.get("package") == r["package"]), None)
            if r["state"] == "update" and (r["profile"], r["package"]) in waiting:
                r["state"] = "pending"
            elif r["state"] == "update" and last and last["status"] in ("queued", "running"):
                r["state"] = "installing"
            elif r["state"] == "update" and (a := auto.get((r["profile"], r["package"], r["latest"]))) and a["status"] == "failed":
                r.update(state="auto_failed", message=a["message"])
            elif r["state"] == "update" and last and last["status"] == "failed" and last.get("version") == r["latest"]:
                r.update(state="failed", message=str(last.get("message") or "")[:300], needs=last.get("needs"))
        rows += mine
    return {"rows": rows, "hub_ok": cat["ok"], "hub_error": cat["error"], "configured": bool(marketplace.settings()["url"]),
            "pods_failed": failed, "checked_at": datetime.fromtimestamp(cat["at"]).astimezone().isoformat(timespec="seconds"),
            "scope": "managed" if scope == "managed" else "pod", "managed_count": len(manageable), "admin": admin,
            "can": bool(pods), "auto": market_updates.auto_enabled(), "defaults": marketplace.default_packages()}


def market_update_cycle(reg: Registry | None = None) -> list[str]:
    """리더가 배달 주기(5초)마다 부른다: 자동 올리기 결과를 짝짓고, 켜져 있으면 대상 줄을 대기 표에 넣고(5분마다), 대기 표를 요청으로 바꾼다(R2·R11·R18)."""
    global _auto_checked
    reg = reg or registry()
    try:
        bundle_publish.publish_once()                              # AAS 기본 스킬 묶음을 허브에(10분마다, 스펙 2026-10-29-001 R1)
    except Exception as exc:                                       # 게시가 실패해도 배달·자동 올리기는 한다
        print(f"기본 스킬 게시 실패: {type(exc).__name__}", flush=True)   # i18n-ignore: 로그
    market_updates.settle_auto_all([pod.id for pod in reg.pods])   # 에이전트마다 물었다 — 질의 하나로(스펙 2026-10-26-002 R2·E8)
    if market_updates.auto_enabled() and time.time() - _auto_checked > AUTO_UPGRADE_EVERY:
        _auto_checked = time.time()
        for pod in reg.pods:
            try:
                market_updates.auto_queue(_market_updates(pod), pod.hermes_home)
            except Exception as exc:                               # 한 작업공간을 못 읽어도 나머지는 한다
                print(f"자동 올리기 대상 찾기 실패 {pod.id}: {type(exc).__name__}", flush=True)   # i18n-ignore: 로그
    done = market_updates.drain(reg.pods, lambda pod: [p.name for p in cron_health.hr.profiles(pod.hermes_home)])
    try:
        done += bundle_defaults.deliver(reg.pods, lambda pod: [p.name for p in cron_health.hr.profiles(pod.hermes_home)])   # 스펙 2026-10-29-001 D4
    except Exception as exc:                                       # 기본 스킬 배달이 실패해도 판 비교 새로 고침은 한다
        print(f"기본 스킬 배달 실패: {type(exc).__name__}", flush=True)   # i18n-ignore: 로그
    for pod in reg.pods:
        if any(d.startswith(pod.id + "/") for d in done):
            _drop_pod_key(pod, "updates")
    return done


AUTO_UPGRADE_EVERY = 300.0
_auto_checked = 0.0


def _market_request_finished(pod_id: str) -> None:
    """배달기가 그 작업공간의 요청을 끝냈다 — 버전 비교 결과·프로파일 줄을 버리고 다른 복제본도 버리게 한다(R14)."""
    pod = next((p for p in registry().pods if p.id == pod_id), None)
    if pod is not None:
        _forget(pod)


def _with_market_issues(pod: Pod, rows: list[dict]) -> list[dict]:
    """프로파일 줄에 스킬 새 버전(안내)·자동 올리기 실패·안내를 붙인다. 올리기 권한이 있는 사람의 응답에만 부른다(R7). 캐시된 줄은 고치지 않고 복사한다."""
    by = market_updates.by_profile(_market_updates_peek(pod))
    out = []
    for r in rows:
        extra = ([market_updates.issue(r["name"], by[r["name"]])] if r["name"] in by else []) + market_updates.auto_issues(pod.id, r["name"]) + bundle_defaults.issues(pod.id, r["name"]) + bundle_local.issues(pod.id, r["name"])
        out.append({**r, "issues": [*r.get("issues", []), *extra]} if extra else r)
    return out


def _profile_rows(pod: Pod) -> list[dict]:
    def build():
        listed = HermesAPI(hub(pod).auth).call("GET", "/api/profiles").get("profiles", [])
        # 줄은 「만료」 플래그만 쓴다 — 사용처 없이 모으고, 자격증명 화면(`{pod}:credentials`)과 캐시 키를 나눈다(스펙 2026-11-03-003 R4, OV1)
        creds = _cached(f"{pod.id}:credentials_nousage", 120, lambda: inventory.credentials(pod.hermes_home, usage=False))["items"]
        act = _cached(f"{pod.id}:activity7", 60, lambda: activity.collect(7, home=pod.hermes_home))
        rows = profiles.summarize(listed, _agents(pod), _channels(pod), _models(pod), _health(pod), creds, act,
                                  cron_health.hr.mcp_server_names(pod.hermes_home))
        for r in rows:                                             # PC 가져오기의 남은 할 일·되돌리기 실패를 「확인할 것」에(OMAI-1136 D5·D7)
            name = r["name"]                                       # 할 일이 끝나면 그만큼 줄인다(2026-10-22-003 R27). 읽기는 남은 항목이 있을 때만 한다
            r["issues"] = [*r["issues"], *pc_import.issues_for(
                pod.id, name,
                env_have=lambda name=name: pc_import.env_names_of(HermesAPI(hub(pod).auth).call("GET", "/api/env", query={"profile": name})),
                skills_have=lambda name=name: pc_import.skill_names_of(hermes_reader.skill_files(pod.hermes_home), name))]
        return rows
    return _cached(f"{pod.id}:profiles", 20, build)


def _forget(pod: Pod, keep: tuple[str, ...] = ("flow",), notify: bool = True) -> None:
    """Hermes 를 바꾼 뒤: 이 POD 의 모아 둔 것을 버려 다음 조회 때 새로 읽게 한다(그림은 뒤에서 다시 만든다).
    notify 가 참이면 다른 서버 복제본도 버리게 신호를 쓴다(OMAI-1287). 다른 복제본의 신호를 보고 버릴 때는 거짓이다."""
    with _lock:
        _generation[pod.id] = _generation.get(pod.id, 0) + 1
        for key in [k for k in _cache if k.startswith(pod.id + ":") and k.split(":", 1)[1].split("|")[0] not in keep]:
            _cache.pop(key, None)
    backend = getattr(getattr(pod, "hermes_home", None), "backend", None)
    if backend is not None:
        backend.invalidate()                                      # 사이드카 묶음(tree)·stat 캐시도 버린다 — 고친 직후 옛 내용이 보이지 않게(OMAI-1102)
    topics.invalidate(f"pod:{pod.id}:")                           # 웹소켓으로 보고 있는 이 POD 의 토픽도 다시 읽는다(OMAI-1100)
    if notify:
        cache_epoch.bump(pod.id)


def _primary_view(pod: Pod | None) -> dict | None:
    row = primary.state(pod.id) if pod is not None else None
    return {"profile": row["profile"], "ready": row["state"] == "templated"} if row else None


def _is_primary(pod: Pod, name: str) -> bool:
    """main 대상 POD 의 주 프로파일인가. 이름 바꾸기·삭제를 막는다(스펙 2026-10-14-003 리뷰 D10)."""
    row = primary.state(pod.id)
    return bool(row) and row["profile"] == name


def _visible_profile_rows(pod: Pod, admin: bool) -> list[dict]:
    """프로파일 화면 목록. main 대상 POD 는 루트를 사용자에게서 빼고 관리자에게는 「루트(숨김)」 읽기 전용으로 보인다(리뷰 D8).
    PC 가져오기의 임시 프로파일(pcimp-)은 숨기고, 가져오는 중인 프로파일에 importing 을 붙인다(OMAI-1444 R11·DD4).
    importing 은 20초 캐시 밖에서 읽고 캐시된 행을 고치지 않게 복사한다(ROV11)."""
    rows = [r for r in _profile_rows(pod) if not pc_import.reserved_name(r["name"])]
    busy = (pc_import.running(pod.id) or {}).get("profile")
    mode = primary.hide_root(pod.id, admin)
    if mode == "drop":
        rows = [r for r in rows if not r.get("is_default")]
    elif mode != "show":
        rows = [{**r, "hidden_root": True} if r.get("is_default") else r for r in rows]
    return [{**r, "importing": bool(busy) and r["name"] == busy} for r in rows]


def _import_guard(pod: Pod, name: str, cancel: bool = True) -> None:
    """이름 바꾸기·삭제 전 PC 가져오기 검사(OMAI-1444 R1, ROV4). 진행 중이면 409 busy_import, 확인 단계 묶음은 취소하고 올린 묶음을 지운다.
    다른 검사를 모두 마친 뒤 부른다. 검사와 Hermes 요청 사이에 시작(claim)이 끼면 오퍼레이터가 NOPROFILE 로 실패해 되돌리기 길을 탄다(한계).
    cancel=False 는 진행 중인지만 본다 — 삭제는 미리 내보내기 전에 이것으로 먼저 거절하고, 취소는 내보내기가 된 뒤에 한다."""
    from . import pc_import_routes
    refused = tr("PC 가져오기가 진행 중이라 지금은 할 수 없습니다", "A PC import is in progress, so this cannot be done now")
    if ((pc_import.running(pod.id) or {}).get("profile")) == name:
        raise files.FileError(refused, 409, reason="busy_import")
    if not cancel:
        return
    for old in pc_import.uploaded_of(pod.id, name):
        if pc_import.cancel(old["id"], "profile_changed"):
            pc_import_routes._drop_bundles(pod, old["id"])
        elif (pc_import.get(old["id"]) or {}).get("state") == "running":   # 그사이 시작됐다
            raise files.FileError(refused, 409, reason="busy_import")
    pc_import_routes.forget_plan(pod.id)


def _import_profile(pod: Pod, api: HermesAPI, name: str, base: str, imp: tuple, known: dict, owner: bool, desc: str | None) -> dict:
    """같은 사용자의 다른 에이전트(파드)의 프로파일에서 SOUL·설정을 가져와 새 프로파일을 만든다(스펙 2026-10-15-011 D8, 단계 4).
    새 프로파일은 받는 쪽 파드의 base(주인은 주 프로파일) 복제로 시작해 모델·제공자·채널 같은 잠글 값은 받는 쪽 것을 그대로 두고,
    원본의 SOUL 과 안전한 설정 키만 얹는다. 비밀값·채널·MCP 서버·스킬은 가져오지 않는다. 이미 만들어진 뒤 실패하면 이유를 알리고 프로파일은 둔다."""
    src_pod, src_prof = imp
    if src_prof not in {p.name for p in cron_health.hr.profiles(src_pod.hermes_home)} or (src_prof == primary.ROOT and cron_policy.root_hidden(src_pod.id)):
        raise ValueError(tr("가져올 프로파일이 없습니다", "The profile to import does not exist"))
    if base and base not in known:
        raise ValueError(tr("복제할 프로파일이 없습니다", "The profile to clone does not exist"))
    api.call("POST", "/api/profiles", {"name": name, "clone_from": base or None, "no_skills": False, "description": desc})
    out: dict = {"ok": True, "name": name}
    try:
        src_api = HermesAPI(hub(src_pod).auth)
        src_default = src_prof == primary.ROOT
        src_cfg = _profile_text_io(src_api, "config", src_prof, None if src_default else src_prof)[0]()
        read, write = _profile_text_io(api, "config", name, name)
        dest_cfg = read()
        merged = profile_copy.import_overlay(dest_cfg, src_cfg)
        if owner:                                                  # 주인: 잠글 키가 받는 쪽 값 그대로인지 한 번 더 확인한다
            refused = owner_guard.config_error(dest_cfg, merged)
            if refused:
                raise files.FileError(refused, 403, reason="config_locked")
        write(merged)
        soul = str(src_api.call("GET", f"/api/profiles/{quote(src_prof, safe='')}/soul").get("content") or "")
        if soul:
            api.call("PUT", f"/api/profiles/{quote(name, safe='')}/soul", {"content": soul})
        out["imported"] = {"pod": src_pod.id, "profile": src_prof, "kept": profile_copy.skipped_keys(src_cfg)}
    except (HermesError, files.FileError, ValueError) as exc:
        out["import_error"] = str(exc)
    return out


def _profile_action(pod: Pod, body: dict, who: str) -> dict:
    """프로파일을 바꾸는 요청을 Hermes 대시보드 API 로 보낸다. 잘못된 요청은 ValueError, Hermes 의 거절은 HermesError."""
    action, name = str(body.get("action") or ""), str(body.get("name") or "")
    if action not in profiles.ACTIONS:
        raise ValueError(tr("알 수 없는 요청", "Unknown request"))
    api = HermesAPI(hub(pod).auth)
    known = {r["name"]: r for r in _profile_rows(pod)}
    q = lambda n: quote(n, safe="")                               # noqa: E731
    if action == "create":
        src = str(body.get("clone_from") or "")
        if body.get("_owner"):                                     # 주인: 주 프로파일 복제만, 스킬 포함, 파드당 상한(스펙 2026-10-15-011 D5)
            code, refused = owner_guard.create_error(pod.id, src, bool(body.get("no_skills")), list(known))
            if refused:
                raise files.FileError(refused, code, reason="profile_limit" if code == 409 else "create_not_allowed")
            src = src or primary.primary_of(pod.id)
        if not profiles.NAME.match(name):
            raise ValueError(tr("이름은 영문 소문자·숫자·-·_ 로, 소문자나 숫자로 시작해야 합니다", "Use lowercase letters, digits, - and _, and start with a lowercase letter or digit"))
        if pc_import.reserved_name(name):                          # PC 가져오기 임시 프로파일 이름(OMAI-1444 R11)
            raise ValueError(pc_import.reserved_error())
        if name in known:
            raise ValueError(tr("이미 있는 이름입니다", "That name is already in use"))
        if src and src not in known:
            raise ValueError(tr("복제할 프로파일이 없습니다", "The profile to clone does not exist"))
        imp = body.get("_import")                                  # 다른 에이전트에서 설정 가져오기(D8, 단계 4): 핸들러가 원본 파드의 권한을 이미 확인했다
        if imp:
            out = _import_profile(pod, api, name, src, imp, known, bool(body.get("_owner")), str(body.get("description") or "")[:300] or None)
            if src:                                                # 스킬은 받는 쪽 src 복제로 들어온다 — 그 설치 기록을 따라 적는다(스펙 2026-10-24-003 R16)
                marketplace.copy_records(pod.id, src, name, who)
            return out
        share, no_skills = bool(body.get("share_skills")), bool(body.get("no_skills"))
        if share and not src:
            raise ValueError(tr("스킬을 함께 쓰려면 복제할 프로파일을 고르세요", "Choose a profile to clone to share its skills"))
        desc = str(body.get("description") or "")[:300] or None
        if src and (share or no_skills):
            # Hermes 는 복제(clone_from)와 no_skills 를 함께 받지 않는다. 스킬 없이 복제하려면 빈 프로파일을 만들고 원본의 SOUL·설정(채널 제외)을 직접 옮긴다.
            # 공용 스킬(D6)이면 거기에 원본의 skills 폴더를 설정에 건다. 프로파일은 이미 만들어졌으므로 옮기기에 실패하면 이유를 알리고 프로파일은 둔다
            api.call("POST", "/api/profiles", {"name": name, "clone_from": None, "no_skills": True, "description": desc})
            out = {"ok": True, "name": name}
            try:
                src_prof = None if known[src]["is_default"] else src
                text = profile_copy.for_new_profile(_profile_text_io(api, "config", src, src_prof)[0]())
                if share:
                    text = shared_skills.with_dir(text, shared_skills.dir_for(src, bool(known[src]["is_default"])))
                _profile_text_io(api, "config", name, name)[1](text)
                soul = str(api.call("GET", f"/api/profiles/{q(src)}/soul").get("content") or "")
                if soul:
                    api.call("PUT", f"/api/profiles/{q(name)}/soul", {"content": soul})
                instructions = _profile_text_io(api, "agents", src, None)[0]()          # 작업 지침(AGENTS.md)도 옮긴다. clone_from 길은 Hermes 패치가 옮긴다(스펙 2026-10-19-004 R7·O1)
                if instructions:
                    _profile_text_io(api, "agents", name, None)[1](instructions)
                    files.remember_version(pod.id, f"agents:{name}", instructions, who, "프로파일 추가 때 복사")   # i18n-ignore: 판 기록에 저장되는 메모
                if share:
                    out["shared_skills_from"] = src
            except (HermesError, files.FileError, ValueError) as exc:
                out["share_error" if share else "copy_error"] = str(exc)
            return out
        api.call("POST", "/api/profiles", {"name": name, "clone_from": src or None, "no_skills": False, "description": desc})
        if src:                                                    # 복제한 스킬 패키지의 설치 기록도 새 프로파일로(스펙 2026-10-24-003 R16)
            marketplace.copy_records(pod.id, src, name, who)
        return {"ok": True, "name": name}
    if name not in known:
        raise ProfileNotFound()
    prof = None if known[name]["is_default"] else name            # 기본 프로파일은 이름 없이 부른다
    owner = bool(body.get("_owner"))                               # 관리자가 아닌 주인의 요청(핸들러가 정한다) — 아래 owner_guard 검사를 거친다
    if owner:
        refused = owner_guard.root_error(pod.id, primary.ROOT if known[name]["is_default"] else name)
        if refused:
            raise files.FileError(refused, 403)
    if action == "describe":
        api.call("PUT", f"/api/profiles/{q(name)}/description", {"description": str(body.get("description") or "")[:600]})
    elif action == "agents_ack":                                  # 작업 지침의 에이전트 변경 「확인함」 — 아래 글 분기보다 먼저(빈 내용 저장으로 떨어지지 않게, 스펙 2026-10-19-004 §10 H3)
        files.ack(pod.id, f"agents:{name}", int(body.get("version_id") or 0), who)
        return {"ok": True}
    elif action.split("_")[0] == "agents":                        # 작업 지침(AGENTS.md) — 경로·읽기 규칙이 달라 따로(스펙 2026-10-19-004 §4-3)
        return _agents_action(pod, api, name, action.partition("_")[2], body, who)
    elif action.split("_")[0] in ("soul", "config"):              # 글 두 가지: 성격(SOUL.md)과 설정(config.yaml) — 같은 판 관리
        kind, _, step = action.partition("_")
        key = f"{kind}:{name}"
        read, write = _profile_text_io(api, kind, name, prof)
        current = read()
        proposed = str(body.get("content") or "")
        if step == "preview":
            out = files.diff_text(pod.id, key, current, proposed=proposed)
            out["problem"] = _text_problem(kind, proposed) or (owner_guard.config_error(current, proposed) if owner and kind == "config" else "")
            return out
        content = files.version_content(pod.id, key, int(body.get("id") or 0)) if step == "revert" else proposed
        problem = _text_problem(kind, content)
        if problem:
            raise files.FileError(problem, 422)
        if owner and kind == "config":                               # 주인: 잠글 키가 지금 값과 같아야 한다. 되돌리기도 같은 검사(관리자가 나중에 바꾼 잠글 키와 부딪히면 거절)
            refused = owner_guard.config_error(current, content)
            if refused:
                raise files.FileError(refused, 403, reason="config_locked", field=",".join(owner_guard.config_locked_keys(current, content)))
        after = files.save_text(pod.id, key, current, content, str(body.get("base_sha") or ""), who, write, read,
                                f"버전 {int(body.get('id') or 0)} 으로 되돌림" if step == "revert" else (str(body.get("note") or "").strip()[:200] or "저장"))   # i18n-ignore: 판 기록에 저장되는 메모
        tpl = body.get("template") if kind == "soul" and step == "" else None
        if isinstance(tpl, dict) and soul_templates.get(str(tpl.get("id") or ""), str(tpl.get("lang") or "")):   # 템플릿에서 시작한 저장 — 어느 판을 적용했는지 남긴다(009 D2)
            soul_templates.record_use(pod.id, name, str(tpl["id"]), str(tpl["lang"]), int(tpl.get("rev") or 0), who)
        out = {"ok": True, kind: {**profiles.soul_view(after), "sha": files.text_sha(after), "versions": len(files.versions(pod.id, key))}}
        if kind == "soul" and getattr(after, "version", None):          # 사람이 SOUL 을 바꿨다 — 그 에이전트가 앉은 열린 방에 알린다(디자인 결정 18A)
            out["notice"] = _notice_soul(pod, name, who, after, "" if step == "revert" else str(body.get("note") or "").strip())
        return out
    elif action == "model":
        model = str(body.get("model") or "")
        if not profiles.model_choice_ok(model, profiles.chat_models(_models(pod)["models"])):   # ${HERMES_LLM_MODEL} = AAS 기본 모델 따르기
            raise ValueError(tr("LiteLLM 이 내놓는 대화용 모델 중에서 골라야 합니다", "Choose one of the chat models that LiteLLM provides"))
        api.call("PUT", f"/api/profiles/{q(name)}/model", {"provider": known[name]["provider"] or "custom", "model": model})
    elif action in ("gateway", "mcp_apply"):                      # 쿠버네티스의 이름 있는 프로파일은 루트 게이트웨이가 함께 돌린다(2026-10-14). mcp_apply 는 다시 시작만
        path, query = profiles.gateway_request("restart" if action == "mcp_apply" else str(body.get("op") or ""), prof, shared=profiles.gateway_shared(in_k8s=bool(pod.sidecar_url), profile=prof))
        api.call("POST", path, {}, query or None)
    elif action == "mcp_to_oauth":                                   # 헤더 인증 서버를 OAuth 로 바꾸기(스펙 2026-10-16-010 V15)
        return mcp_servers.to_oauth(api, prof, str(body.get("target") or ""), pod=pod.id, by=who)
    elif action == "mcp_url_check":                                  # 추가 대화 상자의 주소 칸 아래 가능 여부(스펙 2026-10-16-010 V2). 설정과 주소만 보고 요청하지 않는다(R8)
        return network_mode.check(str(body.get("url") or ""))
    elif action == "mcp_docmost_write":                              # Docmost 쓰기 도구 켜고 끄기(스펙 2026-10-23-002 12-6)
        return mcp_servers.set_docmost_write(api, prof, bool(body.get("write")), pod=pod.id, by=who)
    elif action == "mcp_outline_write":                              # Outline 쓰기 도구 켜고 끄기(스펙 2026-10-23-004). 삭제 도구는 켜지 않는다
        return mcp_servers.set_outline_write(api, prof, bool(body.get("write")), pod=pod.id, by=who)
    elif action in ("mcp_add", "mcp_remove", "mcp_catalog", "mcp_install"):         # MCP 서버 추가·삭제·카탈로그(스펙 2026-10-15-025). 검사와 롤백은 mcp_servers
        profs = [None if r["is_default"] else r["name"] for r in known.values()]
        secure = bool(body.get("_secure"))
        if action == "mcp_add":
            return mcp_servers.add(api, prof, body, owner=owner, secure=secure, profs=profs, pod=pod.id, by=who, profile=name)
        if action == "mcp_install":
            out = mcp_servers.install(api, prof, body, owner=owner, secure=secure, profs=profs, pod=pod.id, by=who, profile=name)
            if out.get("skill_package"):                             # Docmost·Outline 은 사용 규칙 스킬도 함께 설치한다(스펙 2026-10-23-002 12-8, 2026-10-23-004)
                out["skill"] = marketplace.install_companion(pod.id, pod.container, name, str(out["skill_package"]), who)
            return out
        if action == "mcp_catalog":
            return mcp_servers.catalog(api, prof)
        target = str(body.get("target") or "")
        if not target or len(target) > 120 or "/" in target:
            raise ValueError(tr("대상이 없습니다", "Target is missing"))
        try:
            before = _profile_text_io(api, "config", name, prof)[0]()
        except (HermesError, ValueError):
            before = ""                                                # 설정을 읽지 못하면 서버만 지운다(비밀값 줄은 남는다)
        return mcp_servers.remove(api, prof, target, before, pod=pod.id, profile=name)
    elif action in ("skill", "toolset", "mcp", "mcp_test"):
        target = str(body.get("target") or "")
        if not target or len(target) > 120 or "/" in target and action != "skill":
            raise ValueError(tr("대상이 없습니다", "Target is missing"))
        on = bool(body.get("enabled"))
        if action == "skill":
            api.call("PUT", "/api/skills/toggle", {"name": target, "enabled": on, "profile": prof}, {"profile": prof})
        elif action == "toolset":
            api.call("PUT", f"/api/tools/toolsets/{q(target)}", {"enabled": on, "profile": prof}, {"profile": prof})
        elif action == "mcp":
            if on:                                                   # 켜기로 상한을 넘기지 못하게(스펙 R15)
                mcp_servers.enable_error(api, prof, target, [None if r["is_default"] else r["name"] for r in known.values()])
            api.call("PUT", f"/api/mcp/servers/{q(target)}/enabled", {"enabled": on}, {"profile": prof})
        else:
            try:
                res = api.call("POST", f"/api/mcp/servers/{q(target)}/test", {}, {"profile": prof}, timeout=mcp_servers.TEST_TIMEOUT)   # Hermes 는 30초만 기다린다(R14)
            except HermesError as exc:
                if exc.reason != "timeout":
                    raise
                return {"ok": True, "test": {"ok": False, "tools": 0, "timeout": True, "error": ""}}
            ok = bool(res.get("ok") or res.get("success"))
            err = "" if ok else mcp_servers.explain_test_error(redact(res.get("error") or "", 300))   # 401·403·404 는 안내를 앞에(스펙 2026-10-23-004 15절)
            return {"ok": True, "test": {"ok": ok, "tools": len(res.get("tools") or []), "error": err}}
    elif action in ("env_set", "env_clear"):                     # 비밀값: 넣기·바꾸기·지우기. 값은 기록하지도 돌려주지도 않는다
        key = str(body.get("target") or "")
        if not body.get("_secure"):
            raise files.FileError(tr("암호화되지 않은 주소(http, 사내 IP)에서는 비밀값을 다룰 수 없습니다. https 주소나 이 맥의 localhost 에서 여세요.",
               "Secrets cannot be handled over an unencrypted address (http, internal IP). Open this page over https or on localhost of this Mac."), 403)
        if not profiles.ENV_KEY.match(key):
            raise ValueError(tr("이름은 영문 대문자·숫자·_ 로 적습니다 (예: TELEGRAM_BOT_TOKEN)", "Use uppercase letters, digits and _ (example: TELEGRAM_BOT_TOKEN)"))
        try:                                                         # 목록 한 번으로 주인 검사와 바꾸기 전 상태(was_set, 스펙 2026-10-19-015 A4)를 함께 본다
            listing = api.call("GET", "/api/env", query={"profile": prof})
        except HermesError:
            listing = None
        was_set = next((("true" if r["set"] else "false") for r in profiles.env_view(listing) if r["name"] == key), "false") if listing is not None else "unknown"
        if owner:                                                    # 주인: 모델 키·동작·접속 변수와 채널 변수는 거절. 목록을 읽지 못해도 거절(fail-closed)
            catalog = owner_guard.catalog_of(listing) if listing is not None else None
            why, refused = owner_guard.env_key_check(key, catalog)
            if refused:
                raise files.FileError(refused, 403, reason=why, field=key)
        if action == "env_set":
            value = body.get("value")
            if isinstance(value, str) and key.startswith("MCP_") and key.endswith("_API_KEY"):   # MCP 토큰은 헤더에 Bearer 가 붙으므로 앞의 Bearer 를 뗀다(스펙 2026-10-23-002 R7)
                value = mcp_servers.strip_bearer(value)
            if not isinstance(value, str) or not (0 < len(value) <= 4000) or any(c in value for c in "\r\n\x00"):
                raise ValueError(tr("값이 비었거나 줄바꿈이 들어 있습니다", "The value is empty or contains a line break"))
            api.call("PUT", "/api/env", {"key": key, "value": value, "profile": prof}, {"profile": prof})
        else:
            if str(body.get("confirm") or "") != key:
                raise ValueError(tr("확인용 이름이 맞지 않습니다", "The confirmation name does not match"))
            api.call("DELETE", "/api/env", {"key": key, "profile": prof}, {"profile": prof})
        from . import pc_import_routes
        pc_import_routes.forget_plan(pod.id)                         # PC 가져오기 확인 화면의 미리 나눈 숫자를 다시 계산하게 한다(2026-10-22-003 OV-8)
        return {"ok": True, "was_set": was_set}
    elif action in ("channel_save", "channel_test", "pairing_approve", "pairing_revoke"):     # 채널 연결(스펙 2026-10-15-003 단계 2)
        if known[name]["is_default"] and cron_policy.root_hidden(pod.id):
            raise ValueError(tr("숨긴 루트에는 채널을 연결할 수 없습니다. 주 프로파일(main)을 고르세요.", "Channels cannot be connected to the hidden root. Choose the main profile."))
        plat, qs = channel_admin.platform(body), {"profile": prof}
        if action == "channel_save":
            payload = channel_admin.save_payload(body)
            if owner:                                                # 주인: 봇 토큰·허용 사용자(실제 ID)만. `*`·인가 변수는 열린 봇이 된다
                for k, v in payload["env"].items():
                    why, refused = owner_guard.channel_env_check(plat, k, v)
                    if refused:
                        raise files.FileError(refused, 403, reason=why, field=k)
                for k in payload["clear_env"]:
                    refused = owner_guard.channel_clear_error(plat, k)
                    if refused:
                        raise files.FileError(refused, 403, reason="auth_var_blocked", field=k)
            if payload["env"] and not body.get("_secure"):
                raise files.FileError(tr("암호화되지 않은 주소(http, 사내 IP)에서는 비밀값을 다룰 수 없습니다. https 주소나 이 맥의 localhost 에서 여세요.",
                   "Secrets cannot be handled over an unencrypted address (http, internal IP). Open this page over https or on localhost of this Mac."), 403)
            res = api.call("PUT", f"/api/messaging/platforms/{plat}", payload, qs)
            return {"ok": True, "hot_served": bool(res.get("hot_served")) if isinstance(res, dict) else False}
        if action == "channel_test":
            return {"ok": True, "test": channel_admin.test_view(api.call("POST", f"/api/messaging/platforms/{plat}/test", {}, qs))}
        if action == "pairing_approve":
            rid = str(body.get("request_id") or "").strip()[:120]
            if not rid:
                raise ValueError(tr("승인할 요청을 골라 주세요", "Choose a request to approve"))
            api.call("POST", "/api/pairing/approve", {"platform": plat, "request_id": rid, "profile": prof}, qs)
        else:
            uid = str(body.get("user_id") or "").strip()[:120]
            if not uid:
                raise ValueError(tr("해제할 사용자를 골라 주세요", "Choose a user to revoke"))
            api.call("POST", "/api/pairing/revoke", {"platform": plat, "user_id": uid, "profile": prof}, qs)
    elif action == "rename":
        new = str(body.get("new_name") or "")
        if known[name]["is_default"] or _is_primary(pod, name):
            raise ValueError(tr("기본 프로파일은 이름을 바꿀 수 없습니다", "The default profile cannot be renamed"))
        if not profiles.NAME.match(new) or new in known:
            raise ValueError(tr("새 이름이 맞지 않거나 이미 있습니다", "The new name is invalid or already in use"))
        if pc_import.reserved_name(new):
            raise ValueError(pc_import.reserved_error())
        _import_guard(pod, name)
        api.call("PATCH", f"/api/profiles/{q(name)}", {"new_name": new})
        files.move_key(pod.id, f"agents:{name}", f"agents:{new}")      # 작업 지침의 판·확인 기록이 이름을 따라간다(스펙 2026-10-19-004 §10 M1)
        files.move_key(pod.id, f"soul:{name}", f"soul:{new}")          # SOUL 판(PC 가져오기 판 포함)도 따라간다(OMAI-1444 ROV9)
        pc_import.move_profile(pod.id, name, new)                      # 가져오기 결과·「확인할 것」이 새 이름에 남는다(R2)
        bundled_repair.move_profile(pod.id, name, new)                 # 기본 스킬 되돌리기 기록도 따라간다(스펙 2026-10-27-011 R13)
        from . import credential_files
        credential_files.move_profile(pod.id, name, new)               # 인증 파일을 마지막으로 바꾼 사람이 따라간다(2026-10-22-004 R13)
        return {"ok": True, "name": new}
    elif action in ("export", "delete"):
        if action == "delete":
            if known[name]["is_default"] or _is_primary(pod, name):
                raise ValueError(tr("기본 프로파일은 삭제할 수 없습니다", "The default profile cannot be deleted"))
            if str(body.get("confirm") or "") != name:
                raise ValueError(tr("확인용 이름이 맞지 않습니다", "The confirmation name does not match"))
            if any(s["profile"] == name and not s["closed"] for s in hub(pod).status()["sessions"]):
                raise ValueError(tr("이 프로파일과 열려 있는 대화가 있습니다. 대화를 닫고 다시 하세요.", "This profile has open chats. Close them and try again."))
            _import_guard(pod, name, cancel=False)                     # 진행 중이면 미리 내보내기 전에 거절한다(내보내기 묶음이 헛되이 남지 않게)
        where = ""
        if action == "export" or not body.get("skip_export"):
            try:                                                           # 삭제 전에는 묶음을 먼저 남긴다(실패하면 여기서 멈춘다)
                res = api.call("POST", f"/api/profiles/{q(name)}/export", {})
            except HermesError as exc:
                if action == "export":
                    raise
                why = tr("게이트웨이가 남긴 소켓 파일 때문에 묶지 못했습니다", "A socket file left by the gateway blocked the export") if "gateway.sock" in str(exc) else str(exc)
                raise HermesError(tr(f"내보내기에 실패해 삭제하지 않았습니다: {why}", f"The export failed, so nothing was deleted: {why}"), 502, reason="export_failed") from None
            where = str(res.get("path") or res.get("output") or res.get("archive") or "")
            if action == "export":
                return {"ok": True, "archive": where}
            if not where:
                raise HermesError(tr("내보내기 결과를 확인하지 못해 삭제하지 않았습니다", "The export result could not be confirmed, so nothing was deleted"), 502, reason="export_failed")
        _import_guard(pod, name)                                       # 확인 단계 묶음 취소는 미리 내보내기가 된 뒤(OMAI-1444 R1, ROV4)
        api.call("DELETE", f"/api/profiles/{q(name)}")
        files.forget_key(pod.id, f"agents:{name}")                     # 같은 이름으로 다시 만들면 옛 판과 비교되어 「에이전트가 고침」으로 보이지 않게
        files.forget_key(pod.id, f"soul:{name}")                       # SOUL 판도 같다(OMAI-1444 ROV9)
        pc_import.detach_profile(pod.id, name)                         # 같은 이름의 새 프로파일에 옛 가져오기 기록이 붙지 않게(R2)
        bundled_repair.detach_profile(pod.id, name)
        from . import credential_files
        credential_files.detach_profile(pod.id, name)                  # 같은 이름의 새 프로파일에 옛 「바꾼 사람」이 붙지 않게(2026-10-22-004 R13)
        return {"ok": True, "archive": where, "deleted": name}
    return {"ok": True}


AGENTS_FILE = "AGENTS.md"
AGENTS_DEFAULT_LIMIT = 20_000                                     # Hermes 가 한도를 알려 주지 않을 때(계약 A-1)


def _agents_path(api: HermesAPI, name: str) -> tuple[str, str]:
    """(AGENTS.md 의 절대 경로, 화면에 보일 데이터 폴더 기준 경로). Hermes 프로파일 목록의 path 만 쓰고 요청에 든 경로는 쓰지 않는다.
    기본 프로파일 경로(HERMES_HOME) 아래가 아니면 거절한다 — /api/fs/write-text 는 경로를 막지 않는다(스펙 2026-10-19-004 R2)."""
    listed = api.call("GET", "/api/profiles").get("profiles", [])
    row = next((p for p in listed if isinstance(p, dict) and p.get("name") == name), None)
    root = next((p for p in listed if isinstance(p, dict) and p.get("is_default")), None)
    base, home = str((row or {}).get("path") or ""), str((root or {}).get("path") or "")
    if not (posixpath.isabs(base) and posixpath.isabs(home)):
        raise files.FileError(tr("작업 지침 파일의 위치를 알 수 없습니다", "The location of the instructions file is unknown"), 409, reason="path_unknown")
    base, home = posixpath.normpath(base), posixpath.normpath(home)
    if base != home and not base.startswith(home.rstrip("/") + "/"):
        raise files.FileError(tr("기본 프로파일 폴더 밖의 파일은 고칠 수 없습니다", "Files outside the default profile folder cannot be edited"), 403, reason="path_outside")
    full = posixpath.join(base, AGENTS_FILE)
    return full, posixpath.relpath(full, home)


def _agents_marker(api: HermesAPI, name: str) -> tuple[bool, int]:
    """Hermes 패치 표지(계약 A-1): (작업 지침을 읽는가, 한도). 응답은 왔는데 profile_instructions 가 true 가 아니면 (False, 기본 한도) — 옛 이미지는
    이 경로가 없어 404 다. 연결 실패·5xx·시간 초과는 HermesError 그대로(읽기 오류, §10 M5)."""
    try:
        res = api.call("GET", f"/api/profiles/{quote(name, safe='')}/instructions", timeout=10)
    except HermesError as exc:
        if exc.code in (400, 404, 409, 422):
            return False, AGENTS_DEFAULT_LIMIT
        raise
    except ValueError:                                            # JSON 이 아닌 답(경로가 없는 옛 대시보드의 화면 HTML 등)
        return False, AGENTS_DEFAULT_LIMIT
    if not isinstance(res, dict) or res.get("profile_instructions") is not True:
        return False, AGENTS_DEFAULT_LIMIT
    try:
        limit = int(res.get("context_file_max_chars") or 0)
    except (TypeError, ValueError):
        limit = 0
    return True, limit if limit > 0 else AGENTS_DEFAULT_LIMIT


def _agents_fetch(api: HermesAPI, full: str) -> dict:
    """read-text 한 번: {text, exists, reason}. 404 는 아직 없음, 그 밖의 실패는 HermesError 그대로(R3).
    reason: '' | 'link'(응답 경로가 예상과 다름 — 심볼릭 링크, O4) | 'truncated'(잘림·이진 파일). fs API 에 profile 인자를 넘기지 않는다(O12)."""
    try:
        res = api.call("GET", "/api/fs/read-text", query={"path": full})
    except HermesError as exc:
        if exc.code == 404:
            return {"text": "", "exists": False, "reason": ""}
        raise
    binary = bool(res.get("binary"))
    reason = "link" if str(res.get("path") or "") != full else "truncated" if binary or res.get("truncated") else ""
    return {"text": "" if binary else str(res.get("text") or ""), "exists": True, "reason": reason}


def _agents_refusal(reason: str) -> str:
    return {
        "link": lambda: tr("다른 파일을 가리키는 링크라 여기서 고칠 수 없습니다.", "This file is a link to another file, so it cannot be edited here."),
        "truncated": lambda: tr("파일이 커서 여기서 고칠 수 없습니다.", "The file is too large to edit here."),
        "unsupported": lambda: tr("이 AI 에이전트 작업공간의 Hermes 가 아직 작업 지침을 읽지 않습니다.", "This AI Agent Workspace's Hermes does not read instructions yet."),
    }.get(reason, lambda: reason)()


def _agents_warnings(chars: int, limit: int) -> list[str]:
    """크기 경고(D5·R1). 저장을 막지 않는다. Hermes 는 앞뒤 공백을 걷어 낸 길이로 자르므로 같은 기준으로 센다(§10 L1)."""
    if chars <= limit:
        return []
    return [tr(f"{chars:,}자로 한도 {limit:,}자를 넘습니다. AI 에이전트는 가운데를 잘라 읽습니다.",
               f"{chars:,} characters exceeds the limit of {limit:,}. The AI Agent reads it with the middle cut out.")]


def _agents_detail(pod: Pod, api: HermesAPI, name: str) -> tuple[dict, str]:
    """프로파일 상세의 작업 지침 칸과 notes 에 넣을 한 줄(일시적인 읽기 오류일 때만, §10 M4). 읽기 오류여도 객체를 돌려준다.
    깨끗하게 읽었을 때만 「Hermes 가 고침」·「Hermes 가 지움」 판을 남기고, 저장과 같은 잠금 안에서 읽고 남긴다(H1·H2·D19)."""
    key = f"agents:{name}"
    out: dict = {"lines": [], "masked_lines": [], "sha": files.text_sha(""), "exists": False, "path": "", "readonly_reason": None,
                 "limit": AGENTS_DEFAULT_LIMIT, "chars": 0, "warnings": []}
    note = ""
    got = None
    try:
        supported, out["limit"] = _agents_marker(api, name)
        full, out["path"] = _agents_path(api, name)
        with files.text_lock(pod.id, key):
            try:
                got = _agents_fetch(api, full)
            except HermesError:
                if supported:
                    raise
            if supported and got and not got["reason"]:
                if got["exists"]:
                    files.record_agent_edit(pod.id, key, name, got["text"], files.text_sha(got["text"]))
                else:
                    files.record_agent_delete(pod.id, key, name)
    except (HermesError, files.FileError) as exc:
        out["readonly_reason"] = "read_error"
        if isinstance(exc, HermesError):                          # 위치 거절 같은 고정된 이유는 다시 읽어도 같아 notes 에 넣지 않는다
            note = f"agents: {exc}"
        return {**out, **files.agent_state(pod.id, key, False)}, note
    if got is None:                                               # 기능이 꺼진 파드에서 읽기도 실패 — 사유는 기능 꺼짐 하나만
        return {**out, "readonly_reason": "unsupported", **files.agent_state(pod.id, key, False)}, ""
    text = got["text"]
    reason = "unsupported" if not supported else got["reason"] or ("masked" if files.has_secrets(text, "agents") else None)
    chars = len(text.strip())
    out.update(profiles.soul_view(text, "agents"), sha=files.text_sha(text), exists=got["exists"], readonly_reason=reason,
               chars=chars, warnings=_agents_warnings(chars, out["limit"]))
    return {**out, **files.agent_state(pod.id, key, got["exists"])}, ""


def _agents_action(pod: Pod, api: HermesAPI, name: str, step: str, body: dict, who: str) -> dict:
    """작업 지침 미리 보기·저장·되돌리기. 기능 꺼짐·잘림·링크면 저장과 되돌리기를 서버가 거절한다(화면 잠금만으로는 API 직접 호출을 못 막는다, §10 M5)."""
    key = f"agents:{name}"
    read, write = _profile_text_io(api, "agents", name, None)
    if step == "preview":
        try:
            limit = _agents_marker(api, name)[1]
        except HermesError:
            limit = AGENTS_DEFAULT_LIMIT
        current = _agents_fetch(api, _agents_path(api, name)[0])["text"]
        proposed = str(body.get("content") or "")
        out = files.diff_text(pod.id, key, current, proposed=proposed)
        out["problem"] = _text_problem("agents", proposed)                   # 막는 문제만. 크기는 warnings(R1)
        out["warnings"] = _agents_warnings(len(proposed.replace("\r\n", "\n").strip()), limit)
        return out
    with files.text_lock(pod.id, key):
        if not _agents_marker(api, name)[0]:
            raise files.FileError(_agents_refusal("unsupported"), 409, reason="unsupported")
        got = _agents_fetch(api, _agents_path(api, name)[0])
        if got["reason"]:
            raise files.FileError(_agents_refusal(got["reason"]), 409, reason=got["reason"])
        vid = int(body.get("id") or 0)
        content = files.revert_content(pod.id, key, vid) if step == "revert" else str(body.get("content") or "")
        problem = _text_problem("agents", content)
        if problem:
            raise files.FileError(problem, 422)
        after = files.save_text(pod.id, key, got["text"], content, str(body.get("base_sha") or ""), who, write, read,
                                f"버전 {vid} 으로 되돌림" if step == "revert" else (str(body.get("note") or "").strip()[:200] or "저장"),   # i18n-ignore: 판 기록에 저장되는 메모
                                remember_before=got["exists"])
    return {"ok": True, "agents": {**profiles.soul_view(after, "agents"), "sha": files.text_sha(after), "versions": len(files.versions(pod.id, key))}}


def _profile_text_io(api: HermesAPI, kind: str, name: str, prof: str | None):
    """(읽기, 쓰기) — 둘 다 Hermes API. agents 는 범용 파일 API 를 쓰고, 읽을 때마다 경로·링크·잘림을 다시 확인한다(스펙 2026-10-19-004 R2·R3·O4)."""
    n = quote(name, safe="")
    if kind == "agents":
        def read_agents() -> str:
            got = _agents_fetch(api, _agents_path(api, name)[0])
            if got["reason"]:
                raise files.FileError(_agents_refusal(got["reason"]), 409, reason=got["reason"])
            return got["text"]

        def write_agents(text: str) -> None:
            full = _agents_path(api, name)[0]
            res = api.call("POST", "/api/fs/write-text", {"path": full, "content": text})
            if str((res or {}).get("path") or "") != full:                     # Hermes 가 링크를 따라가 다른 곳에 썼다(O4)
                raise files.FileError(_agents_refusal("link"), 502, reason="link")
        return read_agents, write_agents
    if kind == "soul":
        return (lambda: str(api.call("GET", f"/api/profiles/{n}/soul").get("content") or ""),
                lambda text: api.call("PUT", f"/api/profiles/{n}/soul", {"content": text}))
    return (lambda: str(api.call("GET", "/api/config/raw", query={"profile": prof}).get("yaml") or ""),
            lambda text: api.call("PUT", "/api/config/raw", {"yaml_text": text, "profile": prof}, {"profile": prof}))


def _bundle_reader(pod: Pod):
    """허브 없는 설치본의 기본 스킬 쓰기용: Hermes 파일 API 로 /opt/data 아래 상대 경로를 읽는다. 없으면 None(스펙 2026-10-29-001 R10)."""
    api = HermesAPI(hub(pod).auth)

    def read(path: str) -> bytes | None:
        try:
            res = api.call("GET", "/api/files/read", query={"path": path})
        except HermesError as exc:
            if exc.code in (400, 404):
                return None
            raise
        return base64.b64decode(str(res.get("data_url") or "").partition(",")[2] or b"")
    return read


def _bundle_writer(pod: Pod):
    from . import files as web_files                       # web.files 가 server 를 불러와 위에서 부르면 순환한다
    auth = hub(pod).auth
    return lambda path, data: web_files.push_bytes(auth, path, data, overwrite=True)


def primary_sync_once(reg: Registry) -> list[str]:
    """main 대상 POD 의 주 프로파일을 만들고 첫 템플릿 SOUL 을 입힌다(스펙 2026-10-14-003 §4-2·§4-2a). 끝난 「pod/프로파일」 목록.
    닿지 않거나 Hermes 가 아직 SOUL 을 만들지 않았으면 상태를 그대로 두고 다음 주기에 이어 한다."""
    waiting = {r["pod"]: r for r in primary.pending()}
    done: list[str] = []
    for pod in reg.pods:
        row = waiting.get(pod.id)
        if not row:
            continue
        profile = str(row["profile"])
        try:
            alias = office.seat_alias(pod.id, profile) or office._alias_base(pod.owner, profile, profile)
            what = primary.ensure(pod, HermesAPI(hub(pod).auth), alias, files.save_text)
            if what:
                store.log_usage("profile_primary", f"aas {pod.id}/{profile} {what}", pod=pod.id)
                done.append(f"{pod.id}/{profile}")
                _forget(pod)
            if "created" in what.split():                   # 새 사용자의 main 을 처음 만들었을 때만 기본 스킬을 넣는다(스펙 2026-10-23-002 Q5)
                marketplace.queue_defaults(pod.id, profile)
        except Exception as exc:                              # 한 설치본이 실패해도 나머지는 한다
            print(f"주 프로파일을 준비하지 못했습니다 ({pod.id}/{profile}): {type(exc).__name__}: {exc}", flush=True)   # i18n-ignore: 로그
    try:
        done += marketplace.drain_defaults(reg.pods)
    except Exception as exc:                                  # 기본 스킬은 주 프로파일 준비를 막지 않는다
        print(f"기본 스킬 설치 요청을 넣지 못했습니다: {type(exc).__name__}: {exc}", flush=True)   # i18n-ignore: 로그
    try:
        if not marketplace.settings()["url"]:                 # 스킬 허브 없는 설치본(compose) — 서버가 묶음을 직접 쓴다(스펙 2026-10-29-001 R10)
            done += bundle_local.install(reg.pods, lambda pod: [p.name for p in cron_health.hr.profiles(pod.hermes_home)],
                                         _bundle_reader, _bundle_writer)
    except Exception as exc:
        print(f"기본 스킬을 넣지 못했습니다: {type(exc).__name__}: {str(exc)[:120]}", flush=True)   # i18n-ignore: 로그
    done += primary_skill_sync_once(reg)
    done += bundled_repair_once(reg)
    return done


def primary_skill_sync_once(reg: Registry) -> list[str]:
    """Hermes 버전이 바뀐 POD 의 이름 있는 프로파일에 기본 스킬 맞추기(HermesTask SkillSync)를 요청한다(스펙 2026-10-14-003 리뷰 D14, 2026-10-14-015 D3).
    컨테이너가 뜰 때 Hermes 는 루트만 맞추고, 복제로 만든 프로파일은 갱신을 받지 못한다. 기본 스킬 목록이 있는 프로파일만 — 패키지 프로파일은 뺀다."""
    client = k8s.client()
    if client is None:
        return []
    def one(pod) -> list[str]:
        asked: list[str] = []
        try:
            version = str(HermesAPI(hub(pod).auth).call("GET", "/api/status").get("version") or "")
            if not primary.pod_version_changed(pod.id, version):
                return asked
            for profile in primary.sync_profiles(pod.hermes_home):
                client.create_task(primary.skill_sync_task(pod.id, profile, version, client.namespace, k8s.GROUP, k8s.VERSION))
                store.log_usage("profile_primary", f"aas {pod.id}/{profile} skillsync {version}", pod=pod.id)
                asked.append(f"{pod.id}/{profile}")
        except Exception as exc:
            print(f"기본 스킬 맞추기를 요청하지 못했습니다 ({pod.id}): {type(exc).__name__}", flush=True)   # i18n-ignore: 로그
        return asked
    return _each_pod(reg.pods, one, "기본 스킬 맞추기를 요청하지 못했습니다")   # i18n-ignore: 로그


def bundled_repair_once(reg: Registry) -> list[str]:
    """내보내기 때 가려진 기본 스킬을 되돌리는 작업(HermesTask SkillBundledRepair)을 프로파일마다 요청하고 결과를 읽는다
    (스펙 2026-10-27-011 R13, D4·D7). 기다리지 않는다 — 요청한 작업의 결과는 다음 주기에 읽는다. 성공해야만 완료로 기록한다.
    가져오기가 진행 중인 POD 는 건너뛴다(폴더 복사와 겹치지 않게). 후보는 기본 스킬 목록이 있는 프로파일 가운데 출처
    「기본(바뀜)」 줄이 있거나(모아 둔 스킬 목록에서만 본다 — 여기서 새로 만들지 않는다) PC 가져오기를 마친 것."""
    client = k8s.client()
    if client is None:
        return []

    def one(pod) -> list[str]:
        out: list[str] = []
        if pc_import.running(pod.id):
            return out
        with _lock:
            hit = _cache.get(f"{pod.id}:skills")
        rows = (hit[1].get("skills") or []) if hit else []
        modified = {str(r.get("profile")) for r in rows if r.get("origin") == "bundled_modified"}
        names = primary.sync_profiles(pod.hermes_home)
        imported = {n for n in names if (pc_import.latest(pod.id, n) or {}).get("state") == "done"}
        for profile in bundled_repair.candidates(names, modified, imported):
            try:
                state, n = bundled_repair.step(client, pod.id, profile, client.namespace, k8s.GROUP, k8s.VERSION, pc_import.unsupported)
            except Exception as exc:                                      # noqa: BLE001 — 한 프로파일이 실패해도 나머지는 본다
                print(f"기본 스킬 되돌리기를 요청하지 못했습니다 ({pod.id}/{profile}): {type(exc).__name__}", flush=True)   # i18n-ignore: 로그
                continue
            if state == "done":
                store.log_usage("skill_bundled_repair", f"aas {pod.id}/{profile} {n}", pod=pod.id)
                _forget(pod)                                              # 안내 띠(D14)와 표가 어긋나지 않게 스킬 목록을 다시 만든다
                out.append(f"{pod.id}/{profile}")
        return out
    return _each_pod(reg.pods, one, "기본 스킬 되돌리기를 요청하지 못했습니다")   # i18n-ignore: 로그


def _curator_effective_off(api: HermesAPI, query: dict | None) -> bool:
    """기본값까지 합친 실제 적용 값이 이미 `curator.prune_builtins: false` 인가. 못 읽으면 False(지금처럼 써 본다)."""
    try:
        cur = (api.call("GET", "/api/config", query=query) or {}).get("curator")
    except Exception:                                               # noqa: BLE001 — 판단만 못 할 뿐 쓰기는 그대로 해 본다
        return False
    return isinstance(cur, dict) and cur.get("prune_builtins") is False


def _config_once(pod, api: HermesAPI, prow: dict, key: str, patch, note: str, usage: str) -> str:
    """프로파일 하나의 config.yaml 을 한 번만 고친다 — 큐레이터·사용법 스킬 폴더·음성 인식이 함께 쓴다(스펙 2026-10-22-005 R3).
    patch(지금 글, query) 가 새 글을 돌려주면 판 기록과 함께 쓰고, None 이면 고칠 것이 없다. 어느 쪽이든 meta 에 「봤다」를 남겨
    다음 주기에 다시 보지 않는다(사람이 나중에 빼도 다시 넣지 않는다). 그사이 Hermes 가 바꿨으면 덮지 않고 다음 주기에 다시 본다.
    넣었으면 「pod/이름」, 아니면 빈 값. 이번엔 못 하면 예외(다음 주기에 다시)."""
    name, root = str(prow.get("name") or ""), bool(prow.get("is_default"))
    mkey = f"{key}:{pod.id}/{name}"
    if _config_once_seen(mkey):
        return ""
    with store.connect() as conn:
        if conn.execute("SELECT 1 FROM meta WHERE key=?", (mkey,)).fetchone():
            _config_once_seen_add(mkey)
            return ""
    query = None if root else {"profile": name}
    read = lambda: str(api.call("GET", "/api/config/raw", query=query).get("yaml") or "")      # noqa: E731
    write = lambda text: api.call("PUT", "/api/config/raw", {"yaml_text": text, **(query or {})}, query)      # noqa: E731
    current = read()
    patched = patch(current, query)
    done = ""
    if patched is not None:
        if read() != current:                                       # 그사이 Hermes 가 바꿨다 — 덮지 않고 다음 주기에
            return ""
        if files.has_secrets(current, files.kind_of(f"config:{name}")):
            # 비밀값처럼 보이는 줄이 있으면 판 기록(save_text)이 거절한다(403) — 그 글을 AAS 저장소에 남기지 않으려는 규칙이다.
            # 한 줄 더하는 설정이라 판 없이 Hermes 에 바로 쓰고 변경 기록에만 남긴다. 거절된 채 두면 주기마다 실패만 되풀이했다(스펙 2026-10-28-006 R9·R12)
            write(patched)
            store.log_usage("profile_config", f"aas {name} {usage} (버전 없음)", pod=pod.id)   # i18n-ignore: 변경 기록 문구
        else:
            files.save_text(pod.id, f"config:{name}", current, patched, files.text_sha(current), "aas", write, read, note)
            store.log_usage("profile_config", f"aas {name} {usage}", pod=pod.id)
        done = f"{pod.id}/{name}"
    with store.connect() as conn:
        conn.execute("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value=excluded.value", (mkey, "1"))
    _config_once_seen_add(mkey)
    return done


_CONFIG_SEEN: set[tuple] = set()


def _config_once_where(mkey: str) -> tuple:
    return (db.backend(), os.environ.get("AAS_DATA_DIR", ""), db._tl_schema() if db.backend() == "postgres" else "", mkey)


def _config_once_seen(mkey: str) -> bool:
    """이 표시가 meta 에 있는 것을 이미 보았나. 표시는 한 번 쓰면 지우지 않으므로 기억한다 — 주기마다 프로파일마다 물었다
    (OKE 2026-10-26 초당 0.57건, 스펙 2026-10-26-002 §9-12). 데이터 폴더·스키마마다 따로 기억한다. 다른 캐시처럼 PostgreSQL 이고
    듣기 연결이 붙어 있을 때만 쓴다(SQLite 시험은 표시를 지우고 다시 맞추는 것을 본다)."""
    return table_cache.enabled() and _config_once_where(mkey) in _CONFIG_SEEN


def _config_once_seen_add(mkey: str) -> None:
    if table_cache.enabled():
        _CONFIG_SEEN.add(_config_once_where(mkey))


def _curator_one(pod, api: HermesAPI, prow: dict) -> str:
    """프로파일 하나의 config.yaml 에 curator 설정을 넣는다. 넣었으면 「pod/이름」, 아니면 빈 값. 이번엔 못 하면 예외(다음 주기에 다시)."""
    def patch(current: str, query: dict | None) -> str | None:
        patched = primary.curator_patch(current)
        if patched is not None and _curator_effective_off(api, query):
            return None                                             # 적용 값이 이미 false(Hermes v0.22 기본값) — 써도 기본값 줄은 남지 않는다(OMAI-1295)
        return patched
    return _config_once(pod, api, prow, "curator", patch, "큐레이터 기본 스킬 보관 끄기", "curator.prune_builtins=false")   # i18n-ignore: 판 기록에 저장되는 메모


SYNC_POD_TIMEOUT = 120.0                         # 주기 설정 맞추기에서 작업공간 하나를 기다리는 한도(초, 스펙 2026-10-24-002 R16)


_POD_BUSY: set[str] = set()                      # 주기 작업이 아직 도는 작업공간(한도를 넘겨 결과를 버린 작업도 끝날 때까지)
_POD_BUSY_LOCK = threading.Lock()


def _each_pod(pods, one, label: str) -> list:
    """주기 작업을 작업공간마다 나란히 돌리고 결과를 등록부 순서로 모은다. 작업공간 하나가 SYNC_POD_TIMEOUT 을 넘으면 이번 주기에서는
    건너뛴다(다음 주기에 다시 본다). 차례로 돌면 멈춘 Hermes 하나가 한 주기를 길게 늘렸다(R16). one(pod) 은 목록을 돌려준다.
    한도를 넘긴 작업은 결과만 버리고 계속 돈다 — 그 작업공간은 끝날 때까지 다음 단계·주기에서 건너뛴다. 단계끼리 같은 config.yaml 에
    동시에 쓰지 않게 한다(스펙 2026-10-24-002 외부 검토 5)."""
    pods = list(pods)
    with _POD_BUSY_LOCK:
        skipped = [p for p in pods if p.id in _POD_BUSY]
        pods = [p for p in pods if p.id not in _POD_BUSY]
        _POD_BUSY.update(p.id for p in pods)
    for pod in skipped:
        print(f"{label} ({pod.id}): 앞 작업이 아직 끝나지 않아 이번에는 건너뜁니다", flush=True)   # i18n-ignore: 로그
    started: set[str] = set()

    def run(pod):
        with _POD_BUSY_LOCK:
            if pod.id not in _POD_BUSY:                    # 시작 전에 취소로 정리됐다
                return []
            started.add(pod.id)
        try:
            return one(pod)
        finally:
            with _POD_BUSY_LOCK:
                _POD_BUSY.discard(pod.id)
    try:
        got = collect_all.map_pods(pods, run, workers=max(1, min(8, len(pods))), timeout=SYNC_POD_TIMEOUT) if pods else {}
    finally:
        with _POD_BUSY_LOCK:                               # map_pods 는 끝날 때 시작하지 않은 작업을 취소한다
            for pod in pods:
                if pod.id not in started:
                    _POD_BUSY.discard(pod.id)
    out: list = []
    for pod in pods:
        ok, value = got.get(pod.id, (False, "timeout"))
        if ok:
            out.extend(value or [])
        else:
            print(f"{label} ({pod.id}): {value}", flush=True)   # i18n-ignore: 로그
    return out


def curator_sync_once(reg: Registry) -> list[str]:
    """각 프로파일의 config.yaml 에 `curator.prune_builtins: false` 한 줄을 넣는다 — 프로파일마다 한 번만(스펙 2026-10-14-015 D4).
    큐레이터가 30일 안 쓴 기본 스킬을 보관함으로 옮겨 사용자에게는 「없어진 것」으로 보인다. 사람이 정한 값이 있으면 그대로 둔다.
    판 기록·변경 기록에 남고, 한 프로파일이 안 돼도(비밀값 줄이 있는 설정 등) 나머지는 한다."""
    def one(pod) -> list[str]:
        done: list[str] = []
        try:
            api = HermesAPI(hub(pod).auth)
            profiles_ = api.call("GET", "/api/profiles").get("profiles", [])
        except Exception as exc:
            print(f"큐레이터 설정을 넣지 못했습니다 ({pod.id}): {type(exc).__name__}", flush=True)   # i18n-ignore: 로그
            return done
        for prow in profiles_:
            try:
                if (what := _curator_one(pod, api, prow)):
                    done.append(what)
            except Exception as exc:
                print(f"큐레이터 설정을 넣지 못했습니다 ({pod.id}/{prow.get('name')}): {type(exc).__name__}: {str(exc)[:100]}", flush=True)   # i18n-ignore: 로그
        return done
    return _each_pod(reg.pods, one, "큐레이터 설정을 넣지 못했습니다")   # i18n-ignore: 로그


def _nous_guest_one(pod, api: HermesAPI, prow: dict) -> str:
    """프로파일 하나의 config.yaml 에 `nous.guest: false` 를 넣는다 — 프로파일마다 한 번만. 사람이 정한 값은 그대로(스펙 2026-10-28-006 §4-4).
    Hermes 는 이 값이 없으면 호스팅 커넥터를 처음 쓸 때 외부 포털에 Nous 익명 계정을 만든다(OKE 4곳에서 실제로 만들어짐)."""
    return _config_once(pod, api, prow, "nousguest", lambda current, _q: primary.nous_guest_patch(current),
                        "Nous 익명 로그인 끄기", "nous.guest=false")   # i18n-ignore: 판 기록에 저장되는 메모


def nous_guest_sync_once(reg: Registry) -> list[str]:
    """이미 있는·새로 생긴 프로파일에 `nous.guest: false` 를 한 번 넣는다. 새 작업공간은 시드(hermes-seed)가 먼저 넣는다.
    넣은 「pod/프로파일」 목록을 돌려준다. 한 프로파일이 안 돼도 나머지는 한다."""
    def one(pod) -> list[str]:
        done: list[str] = []
        try:
            api = HermesAPI(hub(pod).auth)
            profiles_ = api.call("GET", "/api/profiles").get("profiles", [])
        except Exception as exc:
            print(f"Nous 익명 로그인 끄기를 넣지 못했습니다 ({pod.id}): {type(exc).__name__}", flush=True)   # i18n-ignore: 로그
            return done
        for prow in profiles_:
            try:
                if (what := _nous_guest_one(pod, api, prow)):
                    done.append(what)
            except Exception as exc:
                print(f"Nous 익명 로그인 끄기를 넣지 못했습니다 ({pod.id}/{prow.get('name')}): {type(exc).__name__}: {str(exc)[:100]}", flush=True)   # i18n-ignore: 로그
        return done
    return _each_pod(reg.pods, one, "Nous 익명 로그인 끄기를 넣지 못했습니다")   # i18n-ignore: 로그


def _stt_one(pod, api: HermesAPI, prow: dict, model: str) -> str:
    """프로파일 하나의 config.yaml 에 음성 인식(stt) 절을 넣는다 — 프로파일마다 한 번만. 이미 stt 가 있으면 그대로 둔다(스펙 2026-10-22-005 §3-8)."""
    return _config_once(pod, api, prow, "sttcfg", lambda current, _q: stt_config.with_stt(current, model),
                        "음성 인식(stt) 설정 더하기", f"stt.openai.model={model}")   # i18n-ignore: 판 기록에 저장되는 메모


def stt_sync_once(reg: Registry) -> list[str]:
    """이미 있는 프로파일에 stt 절을 한 번 넣는다. AAS_STT_MODEL 이 비면(음성 인식을 켜지 않은 설치) 아무것도 하지 않고 「봤다」도 남기지 않는다
    — 나중에 켜면 그때 넣는다. 새 에이전트는 시드(hermes-seed)가 넣는다. 넣은 「pod/프로파일」 목록을 돌려준다."""
    model = _stt_model()
    if not model:
        return []
    def one(pod) -> list[str]:
        done: list[str] = []
        try:
            api = HermesAPI(hub(pod).auth)
            profiles_ = api.call("GET", "/api/profiles").get("profiles", [])
        except Exception as exc:
            print(f"음성 인식 설정을 넣지 못했습니다 ({pod.id}): {type(exc).__name__}", flush=True)   # i18n-ignore: 로그
            return done
        for prow in profiles_:
            try:
                if (what := _stt_one(pod, api, prow, model)):
                    done.append(what)
            except Exception as exc:
                print(f"음성 인식 설정을 넣지 못했습니다 ({pod.id}/{prow.get('name')}): {type(exc).__name__}: {str(exc)[:100]}", flush=True)   # i18n-ignore: 로그
        return done
    return _each_pod(reg.pods, one, "음성 인식 설정을 넣지 못했습니다")   # i18n-ignore: 로그


def identity_sync_once(reg: Registry) -> list[str]:
    """모든 설치본·프로파일의 SOUL 첫 문장을 회사 이름에 맞춘다(계획 2026-10-13-008 §2-2). 바꾼 「pod/프로파일」 목록을 돌려준다.
    닿지 않는 설치본(멈춘 Hermes)·읽지 못한 프로파일은 건너뛰고 다음 주기에 다시 본다. 사람이 고친 첫 문장은 바꾸지 않는다."""
    sentence, known, who = settings.identity_sentence(), settings.identity_history(), settings.company_by()
    targets = primary.records()

    def one(pod) -> list[str]:
        done: list[str] = []
        try:
            api = HermesAPI(hub(pod).auth)
            listed = api.call("GET", "/api/profiles").get("profiles", [])
        except Exception:
            return done
        changed = False
        for hp in listed:
            name = str(hp.get("name") or "")
            if not name or (hp.get("is_default") and pod.id in targets):   # 주 프로파일을 쓰는 POD 의 숨긴 루트는 맞추지 않는다(스펙 003 §4-3)
                continue
            try:
                read, write = _profile_text_io(api, "soul", name, None if hp.get("is_default") else name)
                current = read()
                new = identity.rewrite(current, sentence, known)
                if new is None:
                    continue
                settings.remember_identity(sentence)          # 쓰기 전에 남긴다 — 쓰다 끊겨도 다음에 이 문장을 알아본다
                files.save_text(pod.id, f"soul:{name}", current, new, files.text_sha(current), who, write, read,
                                "회사 이름으로 첫 문장을 맞춤")   # i18n-ignore: 판 기록에 저장되는 메모
                store.log_usage("profile_soul_identity", f"{who} {pod.id}/{name}", pod=pod.id)
                done.append(f"{pod.id}/{name}")
                changed = True
            except Exception as exc:                          # 한 프로파일이 실패해도 나머지는 한다
                print(f"SOUL 첫 문장을 맞추지 못했습니다 ({pod.id}/{name}): {type(exc).__name__}", flush=True)   # i18n-ignore: 로그
        if changed:
            _forget(pod)
        return done
    return _each_pod(reg.pods, one, "SOUL 첫 문장을 맞추지 못했습니다")   # i18n-ignore: 로그


_IDENTITY_WAKE = threading.Event()
_identity_pods: set[str] = set()


def identity_wake_if_new_pods(reg: Registry) -> None:
    """새 설치본(사용자의 첫 Hermes)이 보이면 SOUL 첫 문장 맞추기를 바로 깨운다. Hermes 가 SOUL 을 만든 뒤에야 바꿀 수 있어
    한 번에 못 바꾸면 5분 주기가 다시 본다."""
    ids = {p.id for p in reg.pods}
    if ids - _identity_pods:
        _IDENTITY_WAKE.set()
    _identity_pods.clear()
    _identity_pods.update(ids)


AGENT_EDIT_BASELINE = ("local", "agent", "market", "bundled_modified")     # 기본·허브 스킬은 원본이 이미지·허브에 있어 처음 판을 남기지 않는다
AGENT_EDIT_BATCH = 40                                                      # 한 번에 읽는 SKILL.md 개수


def agent_edit_sync_once(reg: Registry) -> int:
    """Hermes 가 대화로 고친 SKILL.md 를 「Hermes 가 고침」 판으로 남긴다(스펙 2026-10-14-015 T4, R12). 처음 보는 스킬은 지금 내용을 기준 판으로만 남긴다.
    사람이 AAS 에서 저장한 판은 이미 기록돼 있어 sha 가 같으므로 건너뛴다. 읽는 것은 skill_graph 의 md_sha 로 바뀐 것만이다."""
    def one(pod) -> list[int]:
        recorded = 0
        try:
            skills_ = _skills(pod)["skills"]
            last = files.latest_shas(pod.id)
            todo = [s for s in skills_ if s.get("origin") in AGENT_EDIT_BASELINE and last.get(f"{s['path']}/SKILL.md") != s.get("md_sha")][:AGENT_EDIT_BATCH]
            for s in todo:
                rel = f"{s['path']}/SKILL.md"
                try:
                    text = (pod.hermes_home / rel).read_text(encoding="utf-8", errors="replace")
                except OSError:
                    continue                                       # 그사이 지운 스킬(보관) — 이 주기의 다른 스킬은 계속 본다(2026-10-29-005 OV6)
                if files.text_sha(text) != s["md_sha"]:
                    continue                                       # 읽는 사이 또 바뀌었다 — 다음 주기에
                what = files.record_agent_edit(pod.id, rel, s["profile"], text, s["md_sha"])
                if what in ("recorded", "secret"):
                    recorded += 1
                    store.log_usage("skill_agent_edit", f"{s['profile']} {s['name']}" + (" (비밀값이 있어 내용은 기록하지 않음)" if what == "secret" else ""), pod=pod.id)   # i18n-ignore: 사용 기록에 저장되는 문장
        except Exception as exc:
            print(f"스킬 고침 버전 기록 실패 ({pod.id}): {type(exc).__name__}", flush=True)   # i18n-ignore: 로그
        return [recorded]
    return sum(_each_pod(reg.pods, one, "스킬 고침 버전 기록 실패"))   # i18n-ignore: 로그


_TAG_WAKE = threading.Event()


def _summary_message(reason: str) -> str:
    return {
        "not_configured": lambda: tr("AI 요약을 쓸 수 없습니다(LiteLLM 이 설정되지 않음)", "AI summaries are not available (LiteLLM is not set up)"),
        "too_soon": lambda: tr("다시 요약은 10분에 한 번 할 수 있습니다", "You can summarize again once every 10 minutes"),
        "llm_failed": lambda: tr("모델을 부르지 못했습니다. 잠시 뒤 다시 하세요", "Could not reach the model. Try again later"),
        "blocked": lambda: tr("원문에 차단되는 표현이 있어 요약하지 못했습니다", "The source has content the guardrail blocks, so it could not be summarized"),
        "bad_answer": lambda: tr("모델의 답을 요약으로 읽지 못했습니다. 다시 요약해 보세요", "The model's answer could not be read as a summary. Try again"),
        "not_found": lambda: tr("없는 스킬", "Skill not found"),
    }.get(reason, lambda: reason)()


def _suggest_message(reason: str) -> str:
    return {
        "not_configured": lambda: tr("AI 추천을 쓸 수 없습니다(LiteLLM 이 설정되지 않음)", "AI suggestions are not available (LiteLLM is not set up)"),
        "too_soon": lambda: tr("잠시 뒤 다시 추천받으세요", "Wait a moment and ask again"),
        "llm_failed": lambda: tr("모델을 부르지 못했습니다. 잠시 뒤 다시 하세요", "Could not reach the model. Try again later"),
        "blocked": lambda: tr("입력에 차단되는 표현이 있어 추천하지 못했습니다", "The input has content the guardrail blocks, so no suggestions were made"),
        "bad_answer": lambda: tr("모델의 답에서 슬로건을 읽지 못했습니다. 다시 추천받으세요", "No slogans could be read from the model's answer. Ask again"),
        "no_team": lambda: tr("부서 이름을 적어 주세요", "Enter a department name"),
    }.get(reason, lambda: reason)()


def _brief_message(reason: str) -> str:
    """칸반 카드 「AI 로 항목 나누기」 오류 문구(스펙 office/kanban-card-structured-brief §3-7). 화면은 reason 코드로 자기 문구를 고른다."""
    return {
        "not_configured": lambda: tr("AI 로 항목을 나눌 수 없습니다(LiteLLM 이 설정되지 않음)", "AI cannot split the text (LiteLLM is not set up)"),
        "too_soon": lambda: tr("잠시 후 다시 눌러 주세요", "Wait a moment and try again"),
        "llm_failed": lambda: tr("모델을 부르지 못했습니다. 잠시 뒤 다시 하세요", "Could not reach the model. Try again later"),
        "blocked": lambda: tr("입력에 차단되는 표현이 있어 항목을 나누지 못했습니다", "The input has content the guardrail blocks, so the text was not split"),
        "bad_answer": lambda: tr("모델의 답을 항목으로 읽지 못했습니다. 다시 눌러 주세요", "The model's answer could not be read as fields. Try again"),
        "no_text": lambda: tr("나눌 글을 적어 주세요", "Enter the text to split"),
        "forbidden": lambda: tr("쓸 수 있는 AI 에이전트가 없어 카드를 만들 수 없습니다", "You have no AI Agent you can use, so you cannot create cards"),
    }.get(reason, lambda: reason)()


def _summary_target(pod, args: dict) -> skill_summary.Target:
    """요약 대상을 서버가 정한다(화면이 키를 보내지 않는다). 마켓은 ns·name, 스킬은 지금 POD 의 스킬 id — 볼 수 있는 POD 의 스킬만 찾아진다."""
    ns, name = str(args.get("ns") or ""), str(args.get("name") or "")
    if ns or name:
        return skill_summary.market_target(marketplace.package(ns, name))
    sid = unquote(str(args.get("id") or ""))
    hit = next((s for s in _skills(pod)["skills"] if s["id"] == sid), None) if sid else None
    if not hit:
        raise skill_summary.SummaryError("not_found", 404)
    if hit.get("origin") == "market":                       # 마켓에서 설치한 스킬은 마켓 요약을 그대로 쓴다(태그와 같은 규칙)
        k = skill_summary.market_key_for(hit["name"])
        if k:
            try:
                kns, kname = k[len("market:"):].split("/", 1)
                return skill_summary.market_target(marketplace.package(kns, kname))
            except (ValueError, marketplace.MarketError):
                pass                                        # 마켓을 못 읽으면 스킬 내용으로 요약한다
    return skill_summary.skill_target(pod.hermes_home, hit)


def _summary_error(exc: Exception) -> dict:
    reason = getattr(exc, "reason", "")
    if isinstance(exc, skill_summary.SummaryError):
        return {"error": _summary_message(reason), "reason": reason, **({"retry_after": exc.retry_after} if exc.retry_after else {})}
    return _error_body(exc)


_tag_seen: dict[str, tuple[str, list[dict]]] = {}             # POD → (묶음 지문, 태그용 스킬 목록)


def _all_skills_for_tags() -> tuple[list[dict], bool]:
    """태그를 붙일 스킬: 모든 POD 의 스킬(이름·설명·출처). 이미 캐시되는 `_skills(pod)` 를 쓴다. 돌려주는 값은 (목록, 모두 읽었는가) —
    한 POD 라도 못 읽으면 False 이고, 그 주기에는 옛 스킬 행을 지우지 않는다(일부만 읽은 채 지우면 못 읽은 POD 의 태그가 사라진다)."""
    out: list[dict] = []
    complete = True
    for pod in list(registry().pods):
        try:
            # 묶음 목록만 받아 지문이 지난번과 같으면 지난 스킬 목록을 쓴다 — 10분마다 모든 에이전트의 묶음 내용을 다시 받지 않게
            # (스펙 2026-10-24-013 D6). 원격이 아니거나 지문을 못 받으면 지금처럼 모은다
            backend = getattr(getattr(pod, "hermes_home", None), "backend", None)
            fp = backend.fingerprint() if backend is not None else None
            seen = _tag_seen.get(pod.id)
            if fp and seen and seen[0] == fp:
                out.extend(seen[1])
                continue
            found = [{"name": sk.get("name"), "description": sk.get("description"), "origin": sk.get("origin")} for sk in _skills(pod)["skills"]]
            if fp:
                _tag_seen[pod.id] = (fp, found)
            out.extend(found)
        except Exception as exc:
            complete = False
            print(f"스킬 태그용 스킬 모으기 실패({pod.id}): {type(exc).__name__}", flush=True)   # i18n-ignore: 로그
    return out, complete


def _market_tag_loop(every: float = 600.0, first: float = 60.0):
    """스킬 허브 태그 분류(OMAI-1275): 리더만, 10분마다. 남았으면 5초 뒤 이어서 한다. 관리자가 다시 매기기를 누르면 바로 깨어난다."""
    wait = first
    while True:
        woken = _TAG_WAKE.wait(timeout=wait)
        _TAG_WAKE.clear()
        wait = every
        if not woken and not leader.is_leader():
            continue
        try:
            found, complete = _all_skills_for_tags()
            got = market_tags.sync_once(skills=found, prune=complete)
            if got["tagged"] and got["pending"]:
                wait = 5.0
        except Exception as exc:
            print(f"스킬 태그 분류 실패: {type(exc).__name__}", flush=True)   # i18n-ignore: 로그


_DESC_WAKE = threading.Event()


def _skill_desc_loop(every: float = 600.0, first: float = 90.0, tick: float = skill_desc.FLUSH_EVERY):
    """스킬 설명 번역(스펙 2026-10-19-017 P4). 모든 서버가 60초마다 자기 대기 기록을 파일에 쓰고, 리더만 10분마다 8개씩 번역한다.
    남았으면 5초 뒤 이어서. 깨워져도 리더가 아니면 번역하지 않는다 — 번역 표는 리더만 쓴다(태그 루프와 다르다, 리뷰 D8)."""
    due = time.time() + first
    while True:
        woken = _DESC_WAKE.wait(timeout=max(1.0, min(tick, due - time.time())))
        _DESC_WAKE.clear()
        try:
            skill_desc.flush()
        except Exception as exc:
            print(f"스킬 설명 대기 기록 실패: {type(exc).__name__}", flush=True)   # i18n-ignore: 로그
        if not woken and time.time() < due:
            continue
        due = time.time() + every
        if not leader.is_leader():
            continue
        try:
            found, _complete = _all_skills_for_tags()
            got = skill_desc.sync_once(skills=found)
            if got["done"] and got["pending"]:
                due = time.time() + 5.0
        except Exception as exc:
            print(f"스킬 설명 번역 실패: {type(exc).__name__}", flush=True)   # i18n-ignore: 로그


def _identity_wait(every: float) -> float:
    """다음 점검까지 기다릴 시간. main 을 아직 만들지 못한 에이전트가 있으면 30초 — 첫 시도는 Hermes 가 뜨기 전이라 실패하기 쉽고,
    5분을 기다리면 그동안 채팅·스킬 허브의 프로파일 목록이 빈다(스펙 2026-10-19-001 리뷰 D13). DB 를 못 읽으면 주기 그대로."""
    try:
        return 30.0 if primary.pending() else every
    except Exception:
        return every


def _identity_loop(every: float = 300.0, first: float = 30.0):
    """SOUL 첫 문장 맞추기: 5분마다(서버마다 자기가 맡은 에이전트, 스펙 2026-10-24-013 D5)·회사 이름을 바꾼 직후·새 설치본이 보인 때(계획 2026-10-13-008)."""
    wait = first
    while True:
        woken = _IDENTITY_WAKE.wait(timeout=wait)
        _IDENTITY_WAKE.clear()
        wait = _identity_wait(every)
        # 주기 점검은 서버마다 자기가 맡은 에이전트만 한다(스펙 2026-10-24-013 D5). 회사 이름을 저장한 서버는 모든 에이전트를 바로 한다 —
        # 두 서버가 겹쳐 써도 판 관리의 sha 확인이 두 번째 쓰기를 막는다(409)
        reg = registry() if woken else _my_registry(registry())
        try:
            primary_sync_once(reg)                      # 주 프로파일 만들기·첫 템플릿이 먼저 — 그 뒤 첫 문장 맞추기는 같은 결과다
        except Exception as exc:
            print(f"주 프로파일 준비 실패: {type(exc).__name__}", flush=True)   # i18n-ignore: 로그
        try:
            curator_sync_once(reg)                      # 큐레이터가 기본 스킬을 보관하지 않게(스펙 2026-10-14-015 D4)
        except Exception as exc:
            print(f"큐레이터 설정 실패: {type(exc).__name__}", flush=True)   # i18n-ignore: 로그
        try:
            nous_guest_sync_once(reg)                   # Nous 익명 로그인 끄기(스펙 2026-10-28-006 §4-4)
        except Exception as exc:
            print(f"Nous 익명 로그인 끄기 실패: {type(exc).__name__}", flush=True)   # i18n-ignore: 로그
        try:
            stt_sync_once(reg)                          # 이미 있는 프로파일에 음성 인식(stt) 절(스펙 2026-10-22-005 §3-8)
        except Exception as exc:
            print(f"음성 인식 설정 실패: {type(exc).__name__}", flush=True)   # i18n-ignore: 로그
        try:
            agent_edit_sync_once(reg)                   # Hermes 가 대화로 고친 스킬 문서를 판 기록에(스펙 2026-10-14-015 T4)
        except Exception as exc:
            print(f"스킬 고침 버전 기록 실패: {type(exc).__name__}", flush=True)   # i18n-ignore: 로그
        try:
            identity_sync_once(reg)
        except Exception as exc:
            print(f"SOUL 첫 문장 맞추기 실패: {type(exc).__name__}", flush=True)   # i18n-ignore: 로그
        if not (woken or leader.is_leader()):                  # 아래 둘은 DB 기록으로 도는 전역 정리 — 리더만
            continue
        try:                                                   # 서버가 도중에 다시 떠 멈춘 PC 가져오기를 닫는다(OMAI-1136 R11-3)
            from . import pc_import_routes
            pc_import_routes.recover_once(registry())
        except Exception as exc:
            print(f"PC 가져오기 복구 실패: {type(exc).__name__}", flush=True)   # i18n-ignore: 로그
        try:                                                   # 서버가 올리기와 작업 사이에 멈춰 남은 인증 파일 임시본(2026-10-22-004 실패 모드)
            from . import credential_files
            credential_files.sweep_once(registry())
        except Exception as exc:
            print(f"인증 파일 임시본 정리 실패: {type(exc).__name__}", flush=True)   # i18n-ignore: 로그


def _text_problem(kind: str, content: str) -> str:
    if files.MASK in content:
        return tr("가려진 값(«가림»)이 들어 있어 저장할 수 없습니다", "Cannot save: the text contains masked values")
    if kind == "config":
        try:
            import yaml
            parsed = yaml.safe_load(content)
        except Exception as exc:
            return tr("YAML 형식 오류: ", "Invalid YAML: ") + redact(str(exc), 200)
        if not isinstance(parsed, dict):
            return tr("설정은 '이름: 값' 꼴의 YAML 이어야 합니다", "The settings must be YAML in 'name: value' form")
        if not isinstance(parsed.get("model"), dict) or not (parsed["model"].get("default") or parsed["model"].get("model")):
            return tr("model 항목(주 모델)이 빠졌습니다 — 이대로 저장하면 AI 에이전트가 돌지 않습니다", "The model entry (main model) is missing. Saving as is would stop the AI Agent from running.")
    return ""


# 에이전트 주인이 자기 POD 에서 할 수 있는 프로파일 동작(OMAI-1126, 스펙 2026-10-13-014 D1). 나머지는 관리자만
# toolset(도구 켜고 끄기)은 OMAI-1193 에서 더했다. MCP·모델·설정 파일은 계속 관리자만
OWNER_PROFILE_ACTIONS = frozenset({"soul", "soul_preview", "soul_revert", "skill", "toolset",
                                   "agents", "agents_preview", "agents_revert", "agents_ack",   # 작업 지침(AGENTS.md)은 SOUL 과 같은 권한(스펙 2026-10-19-004 D2·§10 H3)
                                   "env_set", "env_clear", "channel_save", "channel_test", "pairing_approve", "pairing_revoke",   # 비밀값·채널(스펙 2026-10-15-011 D2·D3). 이름·값은 owner_guard 가 가린다
                                   "config", "config_preview", "config_revert", "mcp", "mcp_test", "rename",   # 설정 파일·MCP·이름 바꾸기(D4·D10, 단계 1b). 잠글 키는 owner_guard.config_error, main 은 rename 분기가 막는다
                                   "mcp_add", "mcp_remove", "mcp_catalog", "mcp_install", "mcp_docmost_write", "mcp_outline_write", "mcp_url_check", "mcp_to_oauth",   # MCP 서버 추가·삭제·카탈로그(스펙 2026-10-15-025). YAML 편집으로 이미 할 수 있는 일이라 권한은 넓어지지 않는다. 검사는 mcp_servers
                                   "mcp_apply",   # 바꾼 MCP 서버를 에이전트에 붙이려는 게이트웨이 다시 시작 하나만(스펙 2026-10-15-025 §12). 시작·멈추기는 관리자 전용 gateway 로 남는다
                                   "create"})   # 프로파일 추가(D5, 단계 2): 주 프로파일 복제·상한은 owner_guard.create_error. 삭제는 owner_delete 가 따로 허용한다


def _owns_pod(pod: Pod | None, user, auth_enabled: bool) -> bool:
    """지금 POD 의 주인인가(owner 이메일 또는 OIDC sub). 화면 권한(grants)으로 보기만 받은 사람과 주인 '*' 인 기본 POD 는 아니다."""
    if not auth_enabled:
        return True
    return pod is not None and Pod.owned_by(pod, user)          # 판정은 Pod.owned_by 한 곳(리뷰 O6)


def _chat_manages(a, user, pod: Pod) -> bool:
    """채팅의 「/」 goal·loop·memory 쓰기 권한(스펙 2026-10-27-002 R12): 로그인을 끈 설치·관리자·주인·팀 관리자. grants 로 들어온 사람은 아니다."""
    return (not a.enabled) or registry().is_admin(user) or _manages_pod(pod, user, a.enabled)


def _manages_pod(pod: Pod | None, user, auth_enabled: bool) -> bool:
    """설정을 다룰 수 있는 에이전트인가: 주인이거나 팀 관리자의 팀 에이전트(스펙 2026-10-22-001 §5-2). 보기만 받은 사람은 아니다."""
    if not auth_enabled:
        return True
    return pod is not None and (Pod.owned_by(pod, user) or pod.id in {p.id for p in registry().team_pods(user)})


def _acts_as_team_manager(pod: Pod | None, user, auth_enabled: bool) -> bool:
    """팀 관리자 자격으로 다루는 중인가(관리자도 주인도 아닌데 _manages_pod 가 참)."""
    return (auth_enabled and not registry().is_admin(user) and not _owns_pod(pod, user, auth_enabled)
            and _manages_pod(pod, user, auth_enabled))


def _actor_role(pod: Pod | None, user, auth_enabled: bool) -> str:
    """이 사람이 대상 에이전트에서 어떤 자격으로 일하는가(기록의 role, D15). 주인 → "", 관리자 → "admin", 팀 관리자 → "team",
    그 밖(접근 권한만 받은 사람·TFT 방 구성원 등) → "other". 로그인을 끈 설치는 주인 개념이 없어 표시하지 않는다."""
    if not auth_enabled or pod is None or not user or _owns_pod(pod, user, auth_enabled):
        return ""
    if registry().is_admin(user):
        return "admin"
    return "team" if _manages_pod(pod, user, auth_enabled) else "other"


def _owner_change_rows(pod: Pod, user, days: int) -> list[dict]:
    """주인·팀 관리자 화면의 변경 기록: 이 에이전트의 현재 주인 기간 기록만. 관리자가 한 일만 이름을 가리고(by_admin),
    팀 관리자(by_team_manager)·그 밖의 사람(by_other)은 이름이 보인다(D11·D15, R5)."""
    since = registry().owner_since(pod)
    rows = _with_request_status(changes.rows(days, pod=pod.id, since=since), pod.id)
    owner = (pod.owner or "").lower()
    for r in rows:
        if r["who"] and r["who"].lower() == owner:
            # 주인 자신의 줄은 표시를 모두 뺀다. 자격은 요청 시작의 쿠키 에이전트로 정해, 기록 에이전트가 다른 경로(프로파일 만들기 target_pod 등)에서는
            # 주인이 자기 에이전트에 한 일에도 other·admin 이 붙을 수 있다(D15 검토 지적 1)
            for k in changes.ROLES.values():
                r.pop(k, None)
            continue
        legacy = not any(r.get(k) for k in changes.ROLES.values())        # 역할 표시 전의 기록 — 그때는 관리자만 남의 에이전트를 바꿀 수 있었다
        if r.get("by_admin") or (legacy and r["who"]):
            r["who"], r["by_admin"] = "", True
    return rows


def _admin_change_rows(days: int) -> list[dict]:
    """관리자 화면의 전체 변경 기록. 누가 칸을 모두 보이므로 주인 화면용 표시(by_admin·by_other)는 뺀다 — 관리자 이름이 가려지지 않게(D15)."""
    rows = changes.rows(days)
    for r in rows:
        r.pop("by_admin", None)
        r.pop("by_other", None)
    return _with_who_names(_with_owners(_with_request_status(rows, None), registry()))


def _market_agent(pod: Pod | None, name: str) -> str:
    """이 프로파일을 만든 마켓 에이전트 패키지 id(없으면 ''). 주인은 이런 프로파일만 지운다(리뷰 O4, D8)."""
    if pod is None or not name:
        return ""
    # 스킬만 넣은 기록(mode=skills)은 마켓이 만든 프로파일이 아니다(2026-10-14-002)
    return next((str(r["package"]) for r in marketplace.installed(pod.id)
                 if r["profile"] == name and r.get("kind") == "agent" and r.get("mode") != "skills"), "")


def _notice_soul(pod: Pod, name: str, who: str, saved, note: str) -> dict:
    """방 알림. 알림이 실패해도 저장은 되돌리지 않고 기록만 남긴다(디자인 결정 6A, 재검토 E3)."""
    try:
        rooms = meeting.notice_soul(pod.id, name, who, saved.before, saved.version, note)
    except Exception as exc:                                       # noqa: BLE001 — 저장은 이미 끝났다
        store.log_usage("profile_soul_notice_failed", f"{who} {name} {type(exc).__name__}", pod=pod.id)
        return {"rooms": 0, "failed": True}
    if rooms:
        topics.invalidate("office:meeting:")
    return {"rooms": rooms}


def _soul_rooms(pod: Pod, name: str, user, admin: bool) -> dict:
    """SOUL 을 저장하면 알림이 갈 열린 방. 이름은 보는 사람이 구성원인 방(관리자는 전부)만 보이고 나머지는 수만(재검토 H3)."""
    email = str((user or {}).get("email") or "").lower()
    rooms = [r for r, _ in meeting.notice_rooms(pod.id, name)]
    named = [r["name"] for r in rooms if admin or email in r.get("members", [])]
    return {"names": named, "others": len(rooms) - len(named)}


def _with_request_status(rows: list[dict], pod_id: str | None) -> list[dict]:
    """마켓 설치·지우기 줄에 요청 상태(queued·running·done·failed)를 붙인다(디자인 결정 4A, 재검토 M5)."""
    if not any(r.get("request") for r in rows):
        return rows
    status = {str(q["id"]): q["status"] for q in marketplace.requests(pod_id, 2000)}
    return [{**r, "request_status": status.get(r["request"], "")} if r.get("request") else r for r in rows]


def _with_owners(rows: list[dict], reg) -> list[dict]:
    """관리자용 변경 기록 줄에 그 POD 주인의 표시 이름을 붙인다. 대상 글은 「main …」처럼 프로파일 이름뿐이라
    사용자마다 Hermes 가 하나씩인 쿠버네티스에서는 누구의 main 인지 알 수 없었다(2026-10-18). 주인이 없으면(기본 POD '*') POD 이름을 붙인다."""
    known, names = office.people(), office.agent_names_provider()
    owners = {p.id: office.display_name(p.owner, known) if "@" in (p.owner or "") else p.id for p in reg.pods}
    labels = {p.id: _pod_label(p, names, known) for p in reg.pods}   # 화면은 owner 대신 「주인 · 에이전트 이름」을 그린다(스펙 2026-10-19-003)
    return [{**r, "owner": owners[r["pod"]], "owner_name": labels[r["pod"]]["owner_name"], "pod_name": labels[r["pod"]]["name"]}
            if r.get("pod") in owners else r for r in rows]


def _room_name(rid) -> str:
    try:
        rid = int(rid or 0)
    except (TypeError, ValueError):
        return ""
    return next((str(r["name"]) for r in office.rooms() if r["id"] == rid), "") if rid else ""


def _office_target(body: dict) -> str:
    """오피스 바꾸기(/api/office/action) 기록의 대상. 방은 id 만 오는 요청(room.delete)이 있어 바꾸기 전에 방 이름을 읽는다(2026-10-18)."""
    if str(body.get("action") or "").startswith("room.") and (name := _room_name(body.get("id"))):
        return name[:60]
    return str(body.get("alias") or body.get("profile") or body.get("name") or body.get("key") or "")[:60]


def _room_note(body: dict, query: dict) -> str:
    """칸반·회의 요청 기록에 붙일 방 이름. 경로(POST /api/office/meeting/say)만으로는 어느 방인지 알 수 없었다(2026-10-18)."""
    name = _room_name(body.get("room") or (query.get("room") or [""])[0])
    return f" 방 {name[:60]}" if name else ""   # i18n-ignore: 사용 기록에 저장되는 문장


def _agent_places(pod: Pod, name: str) -> dict:
    """이 프로파일이 앉은 오피스 자리 수와 그 자리가 든 열린 방 수. 삭제 확인 문구에 쓴다(디자인 결정 12A)."""
    aliases = {s["alias"] for s in office.seats() if s["pod"] == pod.id and s["profile"] == name}
    rooms = [r for r in office.rooms() if r.get("status") != "closed" and aliases & set(r["seats"])] if aliases else []
    try:                                                       # 연결된 채널 수(삭제하면 봇 토큰·허용 사용자·페어링도 함께 지워진다, TD10)
        chans = next((p for p in _channels(pod).get("profiles", []) if p.get("name") == name), {}).get("platforms", [])
    except Exception:                                          # 채널을 못 읽어도 삭제 확인은 보인다
        chans = []
    return {"seats": len(aliases), "rooms": len(rooms), "channels": len(chans)}


def may_change_profile(action: str, pod: Pod | None, user, auth_enabled: bool, admin: bool) -> bool:
    """profile/action 을 받아도 되는가. 관리자는 모두, 주인과 팀 관리자는 OWNER_PROFILE_ACTIONS 만."""
    return (not auth_enabled) or admin or (action in OWNER_PROFILE_ACTIONS and _manages_pod(pod, user, auth_enabled))


def content_gate(pod: Pod | None, user, auth_enabled: bool, admin: bool, profile: str) -> str:
    """스킬 문서·새 스킬·크론 메모·판 이름·무시를 고쳐도 되는가(스펙 2026-10-15-011 D10). 통과면 빈 문자열, 아니면 403 문구.
    관리자와 그 파드의 주인·팀 관리자만, 주인과 팀 관리자는 숨긴 루트 default 를 못 만진다(R5)."""
    if (not auth_enabled) or admin:
        return ""
    if not _manages_pod(pod, user, auth_enabled):
        return tr("관리자나 이 AI 에이전트 작업공간의 소유자만 바꿀 수 있습니다", "Only admins or the AI Agent Workspace's owner can change this")
    return owner_guard.root_error(pod.id, profile or primary.ROOT) if pod is not None else ""


def _profile_of_path(rel: str) -> str:
    """스킬 파일 경로(profiles/<이름>/… 또는 루트의 skills/…)가 속한 프로파일."""
    parts = rel.split("/")
    return parts[1] if parts[0] == "profiles" and len(parts) > 1 else primary.ROOT


def _profile_of_key(key: str) -> str:
    """버전 기록 키(soul:이름, config:이름, jobprompt:프로파일/작업, jobnote:프로파일/작업)가 속한 프로파일."""
    return key.split(":", 1)[1].split("/", 1)[0] if ":" in key else ""


def may_change_cron(pod: Pod | None, user, auth_enabled: bool, admin: bool) -> bool:
    """크론을 만들거나 바꿔도 되는가: 관리자와 그 에이전트 묶음(POD)의 주인·팀 관리자(스펙 2026-10-15-003 R1)."""
    return (not auth_enabled) or admin or _manages_pod(pod, user, auth_enabled)


def may_use_market(path: str, pod: Pod | None, user, auth_enabled: bool, admin: bool) -> bool:
    """마켓 설치·지우기는 관리자나 주인·팀 관리자, 허용이 필요한 네임스페이스의 사용 허용(grant)은 관리자만."""
    return (not auth_enabled) or admin or (path != "/api/market/grant" and _manages_pod(pod, user, auth_enabled))


def _soul_template_values(pod: Pod | None, profile: str, user) -> dict:
    """템플릿 자리 표시 값. 프로파일을 주면 그 POD 주인의 부서와 오피스 별칭(보는 사람 기준이 아니다, 리뷰 B3).
    프로파일이 없으면(설정 화면 미리 보기) 보는 사람의 부서를 쓰고 {agent} 는 그대로 둔다."""
    depts = settings.departments()
    if pod is not None and profile:
        alias = next((s["alias"] for s in office.seats() if s["pod"] == pod.id and s["profile"] == profile), "") or profile
        return {"department": depts.get((pod.owner or "").lower(), ""), "agent": alias}
    return {"department": depts.get(str((user or {}).get("email") or "").lower(), "")}


MCP_LOGIN_SETTLE_TTL = 3     # 로그인 성공 뒤 게이트웨이가 붙기를 기다리는 동안의 상태 읽기 캐시(14-15). 화면은 그동안 3초마다 묻는다


def _mcp_login_reads(pod: Pod, name: str, is_default: bool) -> tuple[dict | None, dict | None]:
    """(토큰 수정 시각, 그 프로파일의 게이트웨이 기록). 30초, 지난 값 없음(D26·D30). 사이드카에 닿지 않으면 (None, None) → 「확인 전」.
    막 로그인한 프로파일은 유예(CONNECT_GRACE)에 캐시 30초를 더한 동안 3초만 둔다. 30초를 그대로 쓰면 게이트웨이가 유예 끝 무렵 붙을 때
    유예가 지난 뒤에도 붙기 전 값이 남아 「확인 전」이 되고, 화면은 그것을 끝 상태로 보고 묻기를 멈춘다(OKE 2026-10-17, 14-15)."""
    def read():
        root = pod.hermes_home
        home = root if is_default else root / "profiles" / name
        try:
            tokens = mcp_oauth_relay.token_times(home)
            records = mcp_oauth_relay.gateway_records(root)
        except OSError as exc:
            print(f"MCP 로그인 상태를 읽지 못했습니다 ({pod.id}): {type(exc).__name__}", flush=True)   # i18n-ignore: 로그
            return None, None
        return tokens, (records.get(name) or {}) if records is not None else None
    ttl = MCP_LOGIN_SETTLE_TTL if mcp_oauth_relay.recent_login(pod.id, name, mcp_oauth_relay.CONNECT_GRACE + 30) else 30
    return _cached(f"{pod.id}:mcplogin:{name}", ttl, read, per_lang=False, stale_ok=False)


def _forget_mcp_login(pod_id: str, profile: str) -> None:
    """로그인 시작·취소·성공 직후: 그 프로파일의 로그인 상태 캐시를 버린다(D26). 만드는 중인 값도 버리게 세대를 올린다(D30)."""
    with _lock:
        _generation[pod_id] = _generation.get(pod_id, 0) + 1
        _drop_locked(f"{pod_id}:mcplogin:{profile}")
        _drop_locked(f"{pod_id}:mcplogin_inbox")                    # 받은편지함 항목도 다음 읽기에서 새로(V14)
        _drop_locked(f"{pod_id}:credentials")                       # 자산 › 자격증명의 토큰 행(T7)
        _drop_locked(f"{pod_id}:credentials_nousage")               # 프로파일 줄용 같은 표(사용처 없음, 스펙 2026-11-03-003 R4)
    topics.invalidate(f"pod:{pod_id}:mcp:{profile}")                # 보고 있는 화면에 곧바로 보낸다(14-22)
    cache_epoch.bump(pod_id)                                        # 다른 서버 복제본도 버린다(OMAI-1287)


def mcp_login_snapshot(pod: Pod, name: str) -> dict:
    """프로파일 한 곳의 OAuth MCP 서버 로그인 상태 {servers: {이름: login_state}}. 웹소켓 토픽 pod:<id>:mcp:<프로파일> 의 읽기(14-22).
    화면이 프로파일 상세 전체를 다시 읽지 않도록 Hermes API 는 부르지 않는다 — config.yaml 의 OAuth 서버·토큰 시각·게이트웨이 기록만
    사이드카로 읽고, 판정은 상세와 같은 annotate 를 쓴다. 진행 중인 로그인은 시작한 사람을 _by 에 둔다(구독자마다 mine 으로 바꾼다)."""
    row = next((r for r in _profile_rows(pod) if r["name"] == name), None)
    if not row:
        raise ProfileNotFound()
    root = pod.hermes_home
    is_default = bool(row["is_default"])
    servers = mcp_oauth_relay.oauth_servers(root if is_default else root / "profiles" / name)
    if not servers:
        return {"servers": {}}
    rows = [dict(v) for v in servers.values()]
    tokens, records = _mcp_login_reads(pod, name, is_default)
    mcp_oauth_relay.annotate(rows, {r["name"]: str(r.get("url") or "") for r in rows}, pod=pod.id, profile=name,
                             tokens=tokens, records=records, user=None)
    out = {}
    for r in rows:
        ls = dict(r.get("login_state") or {})
        if ls.get("state") == "logging_in" and not ls.get("connecting"):
            ls["_by"] = mcp_oauth_relay.started_by(pod.id, name, r["name"])
        out[r["name"]] = ls
    return {"servers": out}


def _profile_detail(pod: Pod, name: str, user=None) -> dict:
    row = next((r for r in _profile_rows(pod) if r["name"] == name), None)
    if not row:
        raise ProfileNotFound()
    api, prof = HermesAPI(hub(pod).auth), (None if row["is_default"] else name)
    out = {"profile": row, "pod": pod.id, "notes": []}          # pod: MCP OAuth 로그인 경로가 파드를 받는다(스펙 2026-10-16-010 T6)
    if pod.restarting:                                            # 다시 뜨는 중이면 화면이 URLError 대신 「다시 시작하는 중」을 보인다(스펙 2026-10-23-008)
        out["restarting"] = True

    def part(key, fn):
        try:
            out[key] = fn()
        except HermesError as exc:
            out[key] = None
            out["notes"].append(f"{key}: {exc}")
    soul_text = {"v": ""}

    def soul():
        soul_text["v"] = str(api.call("GET", f"/api/profiles/{quote(name, safe='')}/soul").get("content") or "")
        return {**profiles.soul_view(soul_text["v"]), "sha": files.text_sha(soul_text["v"]), "versions": len(files.versions(pod.id, f"soul:{name}"))}
    part("soul", soul)
    out["agents"], note = _agents_detail(pod, api, name)         # 작업 지침(AGENTS.md, 스펙 2026-10-19-004). 읽기 오류여도 객체(§10 M4)
    if note:
        out["notes"].append(note)
    if out.get("soul") is not None:                               # 템플릿 적용 기록·부서 추천(계획 2026-10-13-009)
        out["soul_template"] = soul_templates.profile_hint(pod.id, name, soul_text["v"], settings.departments().get((pod.owner or "").lower(), ""))

    def config():
        text = _profile_text_io(api, "config", name, prof)[0]()
        return {**profiles.soul_view(text), "sha": files.text_sha(text), "versions": len(files.versions(pod.id, f"config:{name}"))}
    part("config", config)
    part("toolsets", lambda: profiles.toolsets_view(api.call("GET", "/api/tools/toolsets", query={"profile": prof})))
    part("skills", lambda: skill_desc.apply(profiles.skills_view(api.call("GET", "/api/skills", query={"profile": prof})), 200))
    def mcp():
        raw = api.call("GET", "/api/mcp/servers", query={"profile": prof})
        rows = profiles.mcp_view(raw)
        forced = mcp_servers.forced_servers(pod.id, name)                  # 「그래도 추가」한 서버(스펙 2026-10-16-010 V16)
        for r in rows:
            if r["name"] in forced:
                r["forced"] = True
        if any(r.get("auth") == "oauth" for r in rows):          # OAuth 서버가 있을 때만 상태를 읽는다(스펙 2026-10-16-010 D31)
            listed = raw.get("servers", []) if isinstance(raw, dict) else raw
            urls = {str(r.get("name")): str(r.get("url") or "") for r in listed or [] if isinstance(r, dict)}
            tokens, records = _mcp_login_reads(pod, name, bool(row["is_default"]))
            mcp_oauth_relay.annotate(rows, urls, pod=pod.id, profile=name, tokens=tokens, records=records, user=user)
        return rows
    part("mcp", mcp)
    part("env", lambda: profiles.env_view(api.call("GET", "/api/env", query={"profile": prof})))
    out["models"] = profiles.chat_models(_models(pod)["models"])
    out["default_model"] = profiles.default_model()               # 「<이름> (AAS 기본 모델)」 표기용
    out["gateway_shared"] = profiles.gateway_shared(in_k8s=bool(pod.sidecar_url), profile=prof)
    return out


def _rebuild_flow(pod: Pod) -> None:
    try:
        value = flow.build(pod.hermes_home)
        with _lock:
            _cache[f"{pod.id}:flow"] = (time.time(), value)
            _drop_locked(f"{pod.id}:skills")
        cache_epoch.bump(pod.id)
    except Exception as exc:
        print(f"흐름 그래프를 만들지 못했습니다 ({pod.id}): {type(exc).__name__}")   # i18n-ignore: 로그


def _maybe_auto_publish(pod: Pod, row: dict, owner: bool, admin: bool) -> dict:
    """주인 스킬 자동 승인(스펙 2026-10-28-001 Q14·D11): 조건이 맞으면 뒤에서 승인하고, 응답에 auto=pending·대상 네임스페이스를 붙인다.
    안 되면 auto_reason(코드). 게시는 SkillHub 호출이라 요청을 붙잡지 않는다(F11)."""
    cfg = publish_auto.config(marketplace.settings()["namespaces"])
    ok, reason = publish_auto.eligible(row, owner, admin)
    if not cfg["auto"]:
        ok, reason = False, "off"
    if not ok:
        return {**row, "auto_reason": reason}
    ns = row.get("want_namespace") or cfg["namespace"]

    def run():
        try:
            out = market_publish.auto_approve(row["id"], ns)
            store.log_usage("market_publish_decide", f"auto:{row['who']} {out.get('name')}@{out.get('version')} → {ns} {out.get('status')} req={row['id']}", pod=pod.id)
            _forget_market_catalog()
        except Exception as exc:                                       # 뒤 작업이라 요청 줄은 requested 로 남는다 — 관리자가 승인할 수 있다
            print(f"자동 승인 실패({row['id']}): {type(exc).__name__}", flush=True)   # i18n-ignore: 로그
    threading.Thread(target=run, daemon=True).start()
    return {**row, "auto": "pending", "auto_namespace": ns, "auto_namespace_label": marketplace.ns_label(ns),   # 화면·MCP 가 사람에게 보이는 이름(스펙 2026-10-28-010)
            "auto_public": ns in market_publish.VISIBILITY}


def _note_authored(pod: Pod, who: str, profile: str = "", name: str = "", file_rel: str = "") -> None:
    """사람이 이 AAS 로 스킬을 만들거나 올리거나 고쳤다 — 그 폴더의 묶음 해시를 적는다(자동 승인의 「만든 기록」, D11). 뒤에서 읽는다."""
    def run():
        try:
            if file_rel:
                hit = publish_auto.skill_folder_of(pod.hermes_home, file_rel)
                if not hit:
                    return
                prof, rel = hit
            else:
                prof = profile or "default"
                rel = publish_auto.find_skill_dir(pod.hermes_home, prof, name)
                if not rel:
                    return
            publish_auto.record_folder(pod.id, pod.hermes_home, prof, rel, who)
        except Exception as exc:
            print(f"만든 기록 실패({pod.id}): {type(exc).__name__}", flush=True)   # i18n-ignore: 로그
    threading.Thread(target=run, daemon=True).start()


SKILL_DELETE_ORIGINS = ("local", "agent")                              # 내가 만들거나 올린 스킬만 보관으로 지운다(스펙 2026-10-29-005 §4-1)
SKILL_DELETE_NAME = re.compile(r"^[a-z0-9][a-z0-9._-]{0,63}$")          # Hermes 지우기 API 는 id 가 memory: 로 시작하면 메모리를 지운다(R10)
SKILL_DELETE_REASONS = {
    "origin": lambda: tr("이 스킬은 화면에서 지울 수 없습니다", "This skill cannot be deleted here"),
    "same_name": lambda: tr("같은 이름의 스킬이 둘 있어 지울 수 없습니다. 하나의 이름을 바꾼 뒤 지우세요", "Two skills have this name. Rename one, then delete"),
    "name": lambda: tr("이 이름의 스킬은 화면에서 지울 수 없습니다", "A skill with this name cannot be deleted here"),
}
SKILL_DELETE_CODES = {"origin": 403, "same_name": 409, "name": 400}


def skill_delete_block(s: dict, rows: list[dict]) -> str:
    """스킬 항목을 화면에서 지울 수 없는 이유(빈 값이면 지울 수 있음). 화면의 비활성 판정(ui skillDelete.ts)과 같은 규칙이다.
    origin: 내 스킬이 아님(기본·허브·스킬 허브·외부 폴더) / same_name: 그 프로파일에 같은 머리말 이름이 둘 이상 — Hermes 는 이름으로 찾아 다른 쪽을
    보관할 수 있다(R1) / name: 이름 규칙 밖(R10)."""
    if s.get("origin") not in SKILL_DELETE_ORIGINS or s.get("shared_from"):
        return "origin"
    if sum(1 for r in rows if r["profile"] == s["profile"] and r["name"] == s["name"] and not r.get("shared_from")) > 1:
        return "same_name"
    if not SKILL_DELETE_NAME.match(s["name"]):
        return "name"
    return ""


def _reload_skill_commands(pod: Pod, profile: str) -> str:
    """파일로 놓은 스킬(HermesTask)을 Hermes 의 /스킬 명령 목록에 넣는다 — skills.reload(= /reload-skills) 전에는 새 대화에서도
    「noskill」이었다(2026-10-28 OKE, OMAI-1513 스펙 Q10). Hermes 스킬 API 로 만든 스킬은 API 가 스스로 다시 읽는다.
    "ok" 또는 "failed" — 실패해도 파일은 놓였으므로 적용은 성공으로 둔다. 인자는 계약(SkillsReloadParams)에 있는 profile 만."""
    try:
        hub(pod).request("skills.reload", {} if profile == primary.ROOT else {"profile": profile}, timeout=20)
    except Exception:
        return "failed"
    skill_commands.forget()                                             # 입력창 / 목록(60초 저장)도 새로 읽게
    return "ok"


def _skill_sender(pod: Pod):
    """SKILL.md 저장을 Hermes 의 스킬 API 에 맡긴다. 같은 이름의 다른 스킬을 고치지 않도록, Hermes 가 가리키는 위치를 먼저 확인한다.
    이름(머리말 name:)이 아니라 skills 아래 경로(`분류/스킬`)로 찾게 한다 — Hermes 는 이 꼴을 그 프로파일의 skills 폴더 기준으로만 맞춰
    같은 이름의 다른 스킬과 헷갈리지 않는다(OMAI-1462). 분류 없이 바로 아래 있는 스킬은 경로가 이름과 같아 여전히 겹칠 수 있다."""
    def send(rel: str, current: str, content: str) -> None:
        parts = Path(rel).parts
        profile = parts[1] if parts[0] == "profiles" else None
        top = 2 if profile else 0                                       # skills/… 또는 profiles/<이름>/skills/…
        under = parts[top + 1:-1] if len(parts) > top + 1 and parts[top] == "skills" else ()
        name = "/".join(under) or Path(rel).parent.name
        api = HermesAPI(hub(pod).auth)
        found = api.call("GET", "/api/skills/content", query={"name": name, "profile": profile})
        where = str(found.get("path") or "")
        if not where.endswith("/" + rel):
            raise HermesError(tr("같은 이름의 스킬이 또 있어 어느 것을 고칠지 정할 수 없어 저장하지 않았습니다. 관리자에게 알려 주세요.",
                                 "Another skill has the same name, so it is unclear which one to edit and nothing was saved. Tell your administrator."), 422)
        api.call("PUT", "/api/skills/content", {"name": name, "content": content, "profile": profile})
        # files.save 가 곧바로 다시 읽어 바뀌었는지 본다 — 사이드카 묶음(60초)이 남아 있으면 옛 내용을 읽어 「저장했다는데 그대로」(502)였다
        # (2026-10-28 OKE, Claude Code 가 만들고 바로 고친 스킬. Hermes 쪽 파일은 바뀜). 다른 서버 복제본도 버리게 _drop_pod_key 로
        _drop_pod_key(pod, "skills")
    return send


def _agents_list(reg: Registry, user, auth_enabled: bool) -> dict:
    """사용자 Hermes(HermesAgent) 목록. 관리자는 전부, 그 밖은 내 것만. 쿠버네티스 모드가 아니면 빈 목록."""
    email = str((user or {}).get("email") or "").lower()
    sub = str((user or {}).get("sub") or "")
    admin = (not auth_enabled) or reg.is_admin(user)
    mine = agents.owned_count(reg.agents, sub, email) if email else 0
    limit = agents.limit_for(email) if email else agents.default_limit()
    out = {"enabled": k8s.client() is not None, "error": reg.error,
           "limit": limit, "count": mine, "default_limit": agents.default_limit(),
           "can_create": admin or mine < limit, "admin": admin,
           "agents": [a for a in reg.agents if admin or a["owner"] == email or (sub and a.get("owner_sub") == sub)]}
    # 「+」 만들기 칸에 미리 넣는 이름. 겹침은 전체 에이전트로 보되 남의 이름은 내보내지 않는다(스펙 2026-10-21-019)
    out["suggested_name"] = agents.default_name(str((user or {}).get("name") or "") or email.split("@", 1)[0], reg.agents) if email else ""
    # 주 프로파일(main)을 아직 만드는 중이면 표의 상태 옆에 「main 준비 중」(스펙 2026-10-19-001 디자인 D11). 판정은 /api/me 의 primary.ready 와 같다
    try:
        recs = primary.records()
    except Exception:
        recs = {}
    out["agents"] = [{**a, "primary_preparing": (recs.get(a["name"]) or {}).get("state", "templated") != "templated"} for a in out["agents"]]
    # 프로파일 칸(스펙 2026-10-19-006): 저장된 이름만 보고 사이드카를 기다리지 않는다(R1·D5). 아직 모르면 null, 읽기는 뒤에서
    try:
        defaults = chat_default.records()
    except Exception:
        defaults = {}
    ready = {p.id for p in reg.pods}
    for a in out["agents"]:
        names = profile_names.peek(a["name"], lambda n=a["name"]: _agent_profile_names(reg, n)) if a["name"] in ready else None
        a["profiles"] = names
        a["chat_default"] = chat_default.resolve(a["name"], names, primary.primary_of(a["name"], known=recs), known=defaults) if names else ""   # [] 이면 main 을 만드는 중(C5)
    if admin:
        out["limits"] = agents.limits()              # 사람마다 바꾼 한도(관리자만 본다)
        out["collect"] = collect_all.last_round()    # 마지막 전체 수집 바퀴: 수집한 POD 수·실패한 POD·걸린 시간(관리자 요약)
        _add_rollout_fields(out, reg)
        _add_size_fields(out)
    return out


def _add_size_fields(out: dict) -> None:
    """관리자 응답의 「설정과 다름」(스펙 2026-10-30-003 §4-4 R13). 원본은 등록부가 읽은 목록, 설치 기본값은 마지막으로 읽은 ConfigMap 이라
    이 요청은 쿠버네티스를 기다리지 않는다(capacity_doc 이 뒤에서 다시 읽는다)."""
    client = k8s.client()
    if client is None:
        return
    raw = {(i.get("metadata") or {}).get("name"): i for i in client.last_agents()}
    rows, install = agents.sizes(), agents.install_defaults(agents.capacity_doc(client)[1])
    for a in out["agents"]:
        if a["name"] in raw:
            a["size_differs"] = agents.size_differs(raw[a["name"]], agents.desired(a["owner"], rows), install)


def _agents_sizes(reg: Registry, user, auth_enabled: bool) -> dict:
    """GET /api/agents/sizes(관리자, §4-8): 설치 기본값·관리자 기본값·사람별 값과 작업공간별 지금 값(spec·PVC 실제 요청)."""
    client = k8s.client()
    if client is None:
        raise agents.AgentError(tr("쿠버네티스 모드가 아닙니다(AAS_K8S_NAMESPACE)", "Not in Kubernetes mode (AAS_K8S_NAMESPACE)"), 404)
    if auth_enabled and not reg.is_admin(user):
        raise agents.AgentError(tr("관리자만 볼 수 있습니다", "Only admins can see this"), 403)
    rows = agents.sizes()
    blank = {f: None for f in agents.SIZE_FIELDS}
    try:
        pvcs = {(p.get("metadata") or {}).get("name") or "": p for p in client.list_pvcs()}
    except k8s.K8sError:
        pvcs = {}

    def pvc_size(name: str) -> str | None:
        p = pvcs.get(f"data-{name}-0") or {}                  # StatefulSet 의 PVC 이름(retained_volumes 와 같은 규칙)
        return ((p.get("status") or {}).get("capacity") or {}).get("storage") or (((p.get("spec") or {}).get("resources") or {}).get("requests") or {}).get("storage")
    return {"install": agents.install_defaults(agents.capacity_doc(client, fresh=True)[1]), "admin": {**blank, **(rows.get(agents.ADMIN_SIZE) or {})},
            "people": {e: {**blank, **v} for e, v in rows.items() if e != agents.ADMIN_SIZE},
            "agents": {a["name"]: {"size": a.get("size") or blank, "pvc": pvc_size(a["name"])} for a in reg.agents}}


def _agents_capacity(reg: Registry, user, auth_enabled: bool, query: dict) -> dict:
    """GET /api/agents/capacity(§4-5·§4-8). 관리자는 노드별 자리, 그 밖은 available 참·거짓만(D10).
    cpu_request·memory_request 를 주면 그 크기로 센다(크기 입력 창의 「이 크기로 n개 더」)."""
    admin = (not auth_enabled) or reg.is_admin(user)
    client = k8s.client()
    if client is None:
        return agents.capacity("unknown", None, {}) if admin else {"available": None}
    state, doc = agents.capacity_doc(client, fresh=True)
    want = agents.desired("")                                  # 관리자 기본값(사람 행은 보지 않는다)
    for f in ("cpu_request", "memory_request"):
        v = (query.get(f) or [""])[0]
        if admin and v and agents.qty(v):
            want[f] = v
    out = agents.capacity(state, doc, want, agents.read_quota(client) if state == "ok" else None)
    if not admin:
        return {"available": (out["slots"] > 0) if out["state"] in ("ok", "stale") and out["slots"] is not None else None}
    out["suspended"] = sum(1 for a in reg.agents if a.get("suspended"))      # 다시 켜면 쓸 자리(§4-5 5)
    return out


def _size_targets(client, email: str, install: dict | None) -> list[dict]:
    """이 사람의 작업공간(크기 롤아웃 대상)과 지금 메모리 한도(D9 경고용)."""
    out = []
    for item in client.last_agents():
        if agents._owner(item.get("spec") or {}) == email:
            lim = agents.with_install(agents.spec_size(item), install).get("memory_limit")
            out.append({"name": (item.get("metadata") or {}).get("name") or "", "memory_limit": agents.qty(lim)})
    return out


def _size_save(client, reg: Registry, user, body: dict) -> tuple[dict, int]:
    """POST /api/agents/size(§4-4·§4-6): 검사 → 저장 → 사람이면 그 사람의 작업공간으로 크기 롤아웃(D14).
    막히면 409 와 blocked(force 로 덮어쓴다). 다른 롤아웃이 진행 중이면 값만 저장하고 after_rollout 을 돌려준다."""
    email = str(body.get("email") or "").strip().lower()
    if email != agents.ADMIN_SIZE and not agents.EMAIL.match(email):
        raise agents.AgentError(tr("이메일 모양이 아닙니다", "Not a valid email address"))
    values = agents.clean_size(body)
    reg.refresh(ttl=0)                                        # 대상 작업공간·진행 중 롤아웃은 최신 목록으로
    state, doc = agents.capacity_doc(client, fresh=True)
    install = agents.install_defaults(doc)
    rows = {**agents.sizes(), email: values}
    merged = agents.with_install(agents.desired("" if email == agents.ADMIN_SIZE else email, rows), install)
    agents.check_order(merged)
    targets = [] if email == agents.ADMIN_SIZE else _size_targets(client, email, install)
    checked = agents.check_size(doc if state == "ok" else None, merged, targets)
    if checked["reject"]:
        raise agents.AgentError(checked["reject"])
    if checked["blocked"] and not body.get("force"):
        raise agents.AgentError(checked["blocked"]["reason"], 409, extra={"blocked": checked["blocked"], "warnings": checked["warnings"]})
    me = str((user or {}).get("email") or "local")
    agents.set_size(email, values, me)
    out: dict = {"ok": True, "warnings": checked["warnings"], "targets": [t["name"] for t in targets]}
    if targets:
        want = agents.desired(email)
        try:
            item = rollouts.create_resize(client, reg.rollouts, [{"agent": t["name"], "resources": agents.resources_of(want)} for t in targets],
                                          tr(f"{email} 크기", f"{email} size"), me)
            out["rollout"] = (item.get("metadata") or {}).get("name", "")
        except rollouts.RolloutError as exc:
            if exc.code != 409:
                raise agents.AgentError(str(exc), exc.code) from None
            out["after_rollout"] = True                       # 값은 저장했다. 롤아웃이 끝난 뒤 「다시 적용」(§4-4)
        except k8s.K8sError as exc:
            raise agents.AgentError(tr(f"값은 저장했지만 크기 롤아웃을 만들지 못했습니다: {exc}", f"Saved, but the size rollout could not be created: {exc}"), exc.code,
                                    extra={"saved": True, "targets": [t["name"] for t in targets]}) from None
        reg.refresh(ttl=0)
    return out, 200


def _size_apply(client, reg: Registry, user, body: dict) -> tuple[dict, int]:
    """POST /api/agents/size/apply(§4-4 「기존에도 적용」, 행 메뉴 「다시 적용」은 names 하나): 「설정과 다름」 작업공간으로 크기 롤아웃(D12)."""
    reg.refresh(ttl=0)
    names = {str(n) for n in (body.get("names") or []) if str(n)}
    rows, install = agents.sizes(), agents.install_defaults(agents.capacity_doc(client, fresh=True)[1])
    targets, owners = [], set()
    for item in client.last_agents():
        name, owner = (item.get("metadata") or {}).get("name") or "", agents._owner(item.get("spec") or {})
        want = agents.desired(owner, rows)
        if (not names or name in names) and agents.size_differs(item, want, install):
            targets.append({"agent": name, "resources": agents.resources_of(want)})
            owners.add(owner)
    one = next(iter(owners)) if names and len(owners) == 1 else ""
    version = tr(f"{one} 크기", f"{one} size") if one else tr("기본 크기", "Default size")
    try:
        item = rollouts.create_resize(client, reg.rollouts, targets, version, str((user or {}).get("email") or "local"))
    except rollouts.RolloutError as exc:
        raise agents.AgentError(str(exc), exc.code) from None
    except k8s.K8sError as exc:
        raise agents.AgentError(str(exc), exc.code) from None
    reg.refresh(ttl=0)
    return {"ok": True, "rollout": (item.get("metadata") or {}).get("name", ""), "targets": [t["agent"] for t in targets]}, 201


def _add_rollout_fields(out: dict, reg: Registry) -> None:
    """관리자 응답에만 버전 칸과 롤아웃 요약을 싣는다(스펙 2026-10-28-015 디자인 리뷰 DD18). 원본은 등록부가 10초마다 읽은 목록이라
    이 요청은 쿠버네티스를 부르지 않는다. 쿠버네티스 모드가 아니면 싣지 않는다."""
    client = k8s.client()
    if client is None:
        return
    items, raw = list(reg.rollouts), {(i.get("metadata") or {}).get("name"): i for i in client.last_agents()}
    tgt, names = rollouts.target(items), rollouts.versions(items)
    for a in out["agents"]:
        if a["name"] in raw:
            a.update(rollouts.agent_fields(raw[a["name"]], items, tgt, names))
    out.update(rollouts.summary(items, list(raw.values())))


# ---- 「사용자·권한」 화면(스펙 2026-10-14-011) -------------------------------------------------
# Keycloak 관리 설정(AAS_KEYCLOAK_ADMIN_CLIENT_ID·…_SECRET)이 있으면 Keycloak 사용자가 원본이다(mode keycloak).
# 없거나 로그인이 꺼져 있으면 지금 방식 그대로다: 다섯 곳의 이메일을 합친 목록과 화면 권한(/api/users/set)만(mode legacy, R6).
USER_WRITES = ("/api/users/create", "/api/users/update", "/api/users/password", "/api/users/enable", "/api/users/access", "/api/users/delete")
SELF_WRITES = ("/api/users/me/password",)                  # 로그인한 본인의 일(관리자가 아니어도 된다, 스펙 2026-10-14-017)
TOKEN_WRITES = ("/api/tokens/create", "/api/tokens/revoke", "/api/tokens/revoke-all", "/api/tokens/admin-revoke")   # 「Claude Code 연결」 — 본인의 연결만, admin-revoke 는 관리자(스펙 2026-10-28-001 T1·T3)
USER_EMAIL = re.compile(r"[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}")
USER_NAME = re.compile(r"[a-z0-9][a-z0-9._-]{2,62}")          # 아이디. 이메일을 그대로 넣지 않는다 — 아이디로 로그인하지 못한다(013 스펙)
PASSWORD_MIN, PERSON_NAME_MAX = 8, 100


def _kc_admin():
    """Keycloak 관리 클라이언트. 설정이 없으면 None. 시험이 가짜 Keycloak 으로 바꿔 끼운다."""
    return keycloak.admin_from_config()


def _users_mode(a) -> tuple[str, "keycloak.KeycloakAdmin | None"]:
    kc = _kc_admin() if a.enabled else None
    return ("keycloak" if kc is not None else "legacy"), kc


def _pod_owner_name(pod) -> str:
    """이 설치본 주인의 사람 이름. 이메일 주인이 없으면 빈 값. 채팅·메신저 연결 목록의 프로파일 옆에 보인다(2026-10-18-010).
    이 설치본을 볼 수 있는 사람은 관리자와 주인뿐이라 이름을 보여도 새로 알려지는 것이 없다."""
    owner = getattr(pod, "owner", "") or ""
    return office.display_name(owner, office.people()) if "@" in owner else ""


def _with_who_names(rows: list[dict]) -> list[dict]:
    """변경 기록 줄의 「누가」(이메일)에 사람 이름을 붙인다(who_name). 이메일이 아닌 값(local·빈 값)은 그대로 둔다."""
    known = office.people()
    return [{**r, "who_name": office.display_name(r["who"], known)} if "@" in (r.get("who") or "") else r for r in rows]


def _owner_badge(pod, owner: bool, admin: bool) -> dict:
    """목록 이름 옆 뱃지 값: 주인이면 {"owner": True}(「내 전용」), 주인이 아닌 관리자에게는 주인 표시 이름(「<이름>님 전용」)."""
    if owner:
        return {"owner": True}
    if admin and pod.owner and pod.owner != "*":
        return {"owner_name": office.display_name(pod.owner, office.people())}
    return {}


def _display_name(first: str, last: str, username: str = "") -> str:
    """성+이름. 규칙은 로그인 세션과 함께 쓴다(aas.common.names, 2026-10-18)."""
    return person_name(first, last, username)


def _aas_people(a) -> tuple[list[dict], list[dict], set[str]]:
    """AAS 쪽 사람 기록: (지금 세션, 로그인 기록, 로컬 비밀번호 계정)."""
    now = time.time()
    with store.connect() as conn:
        sess = [dict(r) for r in conn.execute("SELECT email, COUNT(*) n, MAX(created) last, MAX(expires) until FROM auth_sessions WHERE expires > ? GROUP BY email", (now,))]
        logins = [dict(r) for r in conn.execute("SELECT note email, MAX(ts) last, COUNT(*) n FROM usage WHERE kind='login' GROUP BY note ORDER BY last DESC LIMIT 50")]
    from ..auth.auth import load_users
    try:
        local = {str(e).lower() for e in load_users(a.cfg.get("users_file"))} if hasattr(a, "cfg") else set()
    except Exception:
        local = set()
    return sess, logins, local


def _session_fields(e: str, sess: list[dict], logins: list[dict], local: set[str], empty="") -> dict:
    return {"password": e in local, "sessions": next((s["n"] for s in sess if s["email"] == e), 0),
            "until": next((datetime.fromtimestamp(s["until"]).astimezone().isoformat(timespec="minutes") for s in sess if s["email"] == e), empty),
            "last_login": next((l["last"] for l in logins if l["email"] == e), empty), "logins": next((l["n"] for l in logins if l["email"] == e), 0)}


def _pod_label(pod, names: dict | None = None, known: dict | None = None) -> dict:
    """설치본 한 개의 화면 글자 재료: 에이전트 이름(name)과 주인의 사람 이름(owner_name). 없으면 빈 값.
    화면은 「주인 이름 · 에이전트 이름」으로 그린다(스펙 2026-10-19-003). 이 설치본을 볼 수 있는 사람만 받는다."""
    names = office.agent_names_provider() if names is None else names
    owner = getattr(pod, "owner", "") or ""
    owner_name = office.display_name(owner, office.people() if known is None else known) if "@" in owner else ""
    return {"name": names.get(pod.id, ""), "owner_name": owner_name}


def _team_pod_ids(reg: Registry, user, auth_enabled: bool) -> set[str]:
    """내 팀 에이전트 id: 팀 관리자가 다루는 것 중 내가 주인이 아닌 것. 요청마다 한 번 구해 pods·채팅 묶음이 나눠 쓴다(스펙 2026-10-22-001 DD2)."""
    if not auth_enabled or not user:
        return set()
    return {p.id for p in reg.team_pods(user) if not p.owned_by(user)}


def _me_team_flags(reg: Registry, pod: Pod | None, user, auth_enabled: bool) -> dict:
    """/api/me 의 팀 관리자 칸: 지금 에이전트를 팀 관리자로 보는 중인가(team_manager), 그 주인 이름(owner_name),
    내가 팀 관리자로 지정된 시각(team_manager_since, 아니면 빈 값 — 화면의 처음 안내 띠, DD9)."""
    key = reg.team_of_manager(user) if auth_enabled else ""
    return {"team_manager": _acts_as_team_manager(pod, user, auth_enabled),
            "owner_name": _pod_owner_name(pod) if pod is not None else "",
            "team_manager_since": settings.team_manager_since(str((user or {}).get("email") or ""), key) if key else ""}


def _pod_team_manager_names(pod: Pod) -> list[str]:
    """주인의 변경 기록 위에 보일 「우리 팀 관리자」: 주인 부서의 지금 팀 관리자 표시 이름(부서를 옮긴 사람은 뺀다, DD6)."""
    dept = settings.departments().get(str(pod.owner or "").lower(), "")
    if not dept:
        return []
    known = office.people()
    owner = str(pod.owner or "").lower()                               # 주인 자신이 팀 관리자여도 「우리 팀 관리자」에 넣지 않는다
    return [office.display_name(e, known) for e in settings.current_team_managers(settings._team_key(dept)) if e != owner]


def _pod_public(pod, names: dict | None = None, known: dict | None = None, team_ids: set[str] | None = None) -> dict | None:
    """/api/me 의 pod 한 개: id·주인에 에이전트 이름(name)과 주인 이름(owner_name)을 더한다 — 대시보드의 「지금 에이전트: <이름>」(스펙 2026-10-18-018),
    계정 메뉴의 에이전트 바꾸기(2026-10-19-003)."""
    if pod is None:
        return None
    return {**pod.public(), **_pod_label(pod, names, known), **({} if team_ids is None else {"team": pod.id in team_ids})}


def _pod_rows(reg) -> list[dict]:
    """사용자 화면의 설치본 목록. name 은 에이전트 이름(없으면 빈 값) — 「볼 수 있는 에이전트」를 이름으로 그린다(스펙 2026-10-18-011)."""
    names = office.agent_names_provider()
    return [{"id": p.id, "owner": p.owner, "container": p.container, "name": names.get(p.id, "")} for p in reg.pods]


def _users_view(a, user) -> dict:
    """GET /api/users. 두 방식의 공통 칸: mode·keycloak·login_url·admin_count·unmigrated(계약 api-contract)."""
    reg = registry()
    mode, kc = _users_mode(a)
    base = {"auth_enabled": a.enabled, "me": (user or {}).get("email", ""), "domain": getattr(a, "cfg", {}).get("domain", ""),
            "registry_file": str(reg.path), "registry_error": reg.error, "mode": mode,
            "login_url": getattr(a, "cfg", {}).get("public_url", "") or "",
            "pods": _pod_rows(reg)}
    if mode == "legacy":
        reason = "unconfigured"
        return {**base, **_users_legacy(a, reg), "unmigrated": [],
                "keycloak": {"ok": False, "reason": reason, "message": tr("OIDC 관리 설정이 없어 화면 권한만 줍니다", "OIDC admin settings are missing, so only screen permissions are managed")}}
    return {**base, **_users_keycloak(a, reg, kc)}


def _users_legacy(a, reg) -> dict:
    """지금 방식: AAS_ADMINS·access_grants·에이전트 주인·로그인 세션·로그인 기록의 이메일을 합친다(R6 — 바꾸지 않는다)."""
    sess, logins, local = _aas_people(a)
    grants = reg.grants()
    emails = sorted({*reg.admins, *grants, *(p.owner for p in reg.pods if p.owner not in ("*", "")), *(s["email"] for s in sess), *(l["email"] for l in logins if "@" in str(l["email"]))})
    admin_of = lambda e: e in reg.admins or grants.get(e, {}).get("role") == "admin"       # noqa: E731
    users = [{"email": e, "admin": admin_of(e),
              "pods": [p.id for p in reg.pods] if admin_of(e) else sorted({*(p.id for p in reg.pods if p.owner == e), *grants.get(e, {}).get("pods", [])}),
              "fixed": e in reg.admins or any(p.owner == e for p in reg.pods),        # 등록부 파일에 적힌 사람(화면에서 못 뺀다)
              "grant": grants.get(e), **_session_fields(e, sess, logins, local)} for e in emails]
    return {"users": users, "admin_count": sum(1 for u in users if u["admin"])}


def _users_keycloak(a, reg, kc) -> dict:
    """Keycloak 사용자 목록에 AAS 값(볼 수 있는 에이전트·세션·로그인·AAS_ADMINS)을 붙인다. Keycloak 을 읽지 못하면 AAS 값만으로(쓰기는 화면이 잠근다)."""
    sess, logins, local = _aas_people(a)
    grants, unmigrated = reg.grants(), set(reg.admin_grants())
    all_pods = [p.id for p in reg.pods]
    owned_list = getattr(reg, "agents", None) or [{"name": p.id, "owner": p.owner, "owner_sub": p.owner_sub, "suspended": False, "suspended_reason": ""}
                                                  for p in reg.pods]
    try:
        d, state = kc.directory(), {"ok": True, "reason": "", "message": ""}
    except keycloak.KeycloakError as exc:
        d = None
        state = {"ok": False, "reason": "forbidden" if exc.code in (401, 403) else "unreachable", "message": str(exc)}

    def row(uid: str, email: str, **kw) -> dict:
        mine = [x for x in owned_list if (email and x.get("owner") == email) or (uid and x.get("owner_sub") == uid)]
        own = sorted(x["name"] for x in mine)
        shared = grants.get(email, {}).get("pods", []) if email else []
        fixed, grant_admin = bool(email) and email in reg.admins, bool(email) and email in unmigrated
        kc_admin = kw.pop("kc_admin", False)
        admin = kc_admin or fixed or grant_admin
        status = kw.pop("status", "")
        if not status:
            status = "unmigrated" if grant_admin and not (kc_admin or fixed) else "no_access" if not kw.get("member") and not admin else "ok"
        out = {"key": uid or f"email:{email}", "id": uid, "username": "", "email": email, "first_name": "", "last_name": "", "name": "",
               "department": "", "enabled": True, "member": False, "admin_group": False, **kw,
               "admin": admin, "fixed": fixed, "status": status,
               "pods": all_pods if admin else sorted({*own, *shared}), "own_pods": own, "shared_pods": list(shared),
               "agents_running": sum(1 for x in mine if not x.get("suspended")),
               "agents_suspended": sum(1 for x in mine if x.get("suspended") and x.get("suspended_reason") == "disabled"),
               **_session_fields(email, sess, logins, local, None)}
        return out

    users, seen = [], set()
    admin_emails, disabled = set(), set()
    for u in (d or {}).get("users", []):
        uid, email = str(u.get("id") or ""), str(u.get("email") or "").lower()
        first, last = str(u.get("firstName") or ""), str(u.get("lastName") or "")
        dept = ((u.get("attributes") or {}).get("department") or [""])[0]
        kc_admin = uid in d["admin_direct"] or uid in d["admin_group"]
        enabled = u.get("enabled", True) is not False
        if email:
            seen.add(email)
            if not enabled:
                disabled.add(email)
            elif kc_admin:
                admin_emails.add(email)
        users.append(row(uid, email, username=str(u.get("username") or ""), first_name=first, last_name=last,
                         name=_display_name(first, last, str(u.get("username") or "")), department=str(dept or ""), enabled=enabled,
                         member=uid in d["members"], admin_group=uid in d["admin_group"], kc_admin=kc_admin))
    # Keycloak 에 없지만 AAS 기록(세션·로그인 기록·주인·화면 권한·AAS_ADMINS)에 있는 이메일 — 「Keycloak 계정 없음」
    others = {*reg.admins, *grants, *(x.get("owner") for x in owned_list), *(s["email"] for s in sess), *(l["email"] for l in logins if "@" in str(l["email"]))}
    for email in sorted(e for e in others if e and e != "*" and "@" in e and e not in seen):
        grant_admin = email in unmigrated and email not in reg.admins
        users.append(row("", email, name=email.split("@", 1)[0],
                         status="unmigrated" if grant_admin else ("no_account" if d is not None else "ok")))
    if d is not None:
        # 오피스·회의가 쓰는 이름(office_people)은 그 사람이 오피스에 다시 들어와야 바뀌어 옛 이름이 남았다(2026-10-18). 목록을 읽을 때 맞춘다
        office.sync_names({u["email"]: u["name"] for u in users if u["id"] and u["email"] and u["name"]})
    return {"users": users, "keycloak": state, "unmigrated": sorted(unmigrated),
            "admin_count": len(admin_emails | (reg.admins - disabled))}


# ---- 부서 목록(스펙 2026-10-15-026) ----------------------------------------------------------------------------------
DEPARTMENT_WRITES = ("/api/departments/create", "/api/departments/rename", "/api/departments/delete", "/api/departments/managers")


def _kc_department(u: dict) -> str:
    return str(((u.get("attributes") or {}).get("department") or [""])[0] or "")


def _departments_view(a) -> dict:
    """관리자가 보는 부서 목록. 처음에는 기존 부서를 목록으로 한 번 옮긴다 — Keycloak 사용자의 부서까지 모으고, Keycloak 에 닿지 않으면
    다른 출처만으로 옮기되 완료 표시를 남기지 않아 다음에 다시 한다(스펙 5-3)."""
    mode, kc = _users_mode(a)
    if not settings.seeded():
        if kc is None:
            settings.ensure_seeded(None, final=True)
        else:
            try:
                settings.ensure_seeded([_kc_department(u) for u in kc.list_users()], final=True)
            except keycloak.KeycloakError:
                settings.ensure_seeded(None, final=False)
    rows = settings.department_rows()
    listed = settings.team_managers()
    for r in rows:
        key = settings._team_key(r["name"])
        here = settings.current_team_managers(key)
        r["managers"] = here
        r["moved"] = [e for e in listed.get(key, []) if e not in here]       # 행은 있지만 부서를 옮겼거나 부서를 모르는 사람
    return {"departments": rows, "mode": mode}


def _dept_members(kc, key: str) -> list[dict]:
    """그 부서(team_key)에 속한 사람. Keycloak 방식이면 Keycloak 사용자 목록 기준이라 로그인한 적 없는 사람도 센다(결정 R1).
    Keycloak 에 닿지 않으면 KeycloakError. Keycloak 이 없으면 로그인으로 알게 된 사람(user_directory)이다."""
    if kc is None:
        return [{"id": "", "email": e, "username": e.split("@", 1)[0]} for e, d in settings.departments().items() if settings._team_key(d) == key]
    out = []
    for u in kc.list_users():
        if settings._team_key(_kc_department(u)) == key:
            first, last = str(u.get("firstName") or ""), str(u.get("lastName") or "")
            out.append({"id": str(u.get("id") or ""), "email": str(u.get("email") or "").lower(), "username": str(u.get("username") or ""),
                        "name": _display_name(first, last, str(u.get("username") or ""))})
    return out


def _notice_reach(a, audience) -> int | None:
    """공지 대상 사람 수(R9: 부서 화면과 같이 Keycloak 사용자 기준, 전체는 Keycloak 사용자 수). Keycloak 에 닿지 않거나 없으면 user_directory.
    로그인을 끈 실행은 사람을 모르므로 None(화면이 수를 숨긴다)."""
    if not a.enabled:
        return None
    _, kc = _users_mode(a)
    people = None
    if kc is not None:
        try:
            people = [_kc_department(u) for u in kc.list_users()]
        except keycloak.KeycloakError:
            people = None
    if people is None:
        people = notices.directory_people()
    return notices.reach_from(audience, people)


def _notice_admin(row: dict, at, known: dict | None = None) -> dict:
    """관리 목록의 공지 한 줄. 작성자·고친 사람은 이메일 대신 사람 이름(author_name·editor_name)도 준다."""
    known = office.people() if known is None else known
    view = notices.admin_view(row, at)
    return {**view, "author_name": office.display_name(view["author"], known), "editor_name": office.display_name(view["editor"], known)}


def _notices_write(a, me: str, body: dict) -> tuple[dict, int]:
    """POST /api/notices {action: save|remove|extend|reach}. 검사 실패는 400 {error, field}(E9), 바뀐 공지는 409 {reason: changed}(E3)."""
    action = str(body.get("action") or "")
    try:
        if action == "reach":
            known = [r["name"] for r in settings.department_rows()]
            aud = notices.check_audience(body.get("audience", "all"), known)
            return {"reach": _notice_reach(a, aud)}, 200
        if action == "save":
            row = notices.save(body, me, [r["name"] for r in settings.department_rows()])
            kind = "notice_save"
        elif action == "remove":
            row = notices.remove(body.get("id"), me)
            kind = "notice_remove"
        elif action == "extend":
            row = notices.extend(body.get("id"), body.get("ends_at"), me)
            kind = "notice_save"
        else:
            return {"error": tr("알 수 없는 동작입니다", "Unknown action")}, 400
    except notices.NoticeError as exc:
        return _error_body(exc), exc.code
    store.log_usage(kind, notices.log_note(me, row))
    topics.invalidate("notices", exact=True)                 # 이 서버는 곧바로 보낸다. 다른 서버는 다음 5초 주기(R1)
    out = {"ok": True, "notice": _notice_admin(row, notices.now())}
    if action == "save":
        out["reach"] = _notice_reach(a, row["audience"])
    return out, 200


def _departments_write(a, user, path: str, body: dict) -> tuple[dict, int]:
    """부서 목록 쓰기(관리자만). create: 만들기. delete: 사람이 0 명일 때만. rename: 새 이름 등록 → 사용자 이동 → 옛 이름 지우기(6절)."""
    reg, me = registry(), (user or {}).get("email", "local")
    if a.enabled and not reg.is_admin(user):
        return {"error": tr("관리자만 할 수 있습니다", "Only admins can do this")}, 403
    too_long = lambda v: len(" ".join(str(v or "").split())) > settings.DEPARTMENT_MAX     # noqa: E731
    name = settings._dept_name(body.get("name"))
    if not name:
        return {"error": tr("부서 이름을 적어 주세요", "Enter a department name"), "field": "name"}, 400
    for field in ("name", "new_name"):
        if too_long(body.get(field)):
            return {"error": tr(f"부서 이름은 {settings.DEPARTMENT_MAX}자까지 쓸 수 있습니다", f"A department name can be up to {settings.DEPARTMENT_MAX} characters"), "field": field}, 400
    mode, kc = _users_mode(a)
    key = settings._team_key(name)
    if path == "/api/departments/managers":                           # Keycloak 사람 수 조회 전에 처리한다 — Keycloak 에 닿지 않아도 지정된다
        raw = body.get("emails")
        if not isinstance(raw, list):                                   # 빠지거나 목록이 아니면 []로 보고 모두 지우던 것을 막는다
            return {"error": tr("emails 는 이메일 목록이어야 합니다", "emails must be a list of emails"), "field": "emails"}, 400
        emails = sorted({str(e or "").strip().lower() for e in raw if str(e or "").strip()})
        depts = settings.departments()
        # 부서 확인은 새로 넣는 사람만 한다. 이미 행이 있는 사람(부서를 옮긴 사람 포함)은 그대로 보내도 된다 —
        # 화면은 옮긴 사람 칩을 지우지 않으면 그 이메일도 보내므로, 확인하면 다른 사람을 바꾸는 저장까지 막혔다(DT1 리뷰)
        have = set(settings.team_managers().get(key, []))
        bad = [e for e in emails if e not in have and (not depts.get(e) or settings._team_key(depts[e]) != key)]
        if bad:
            return {"error": tr("이 부서로 로그인한 적이 없는 사람입니다: " + ", ".join(bad),
                                "These people have never signed in under this department: " + ", ".join(bad)),
                    "field": "emails", "emails": bad}, 400
        saved = settings.set_team_managers(name, emails, me)
        store.log_usage("department_managers", f"{me} {name} {','.join(saved)}")
        for email in sorted(have | set(saved)):                           # 빠진 사람과 들어온 사람의 열린 웹소켓·오피스 범위를 바로 다시 검사한다(최종 리뷰 I1)
            topics.user_changed(email)
        _scene_scope_changed()
        return {"ok": True, "managers": saved}, 200
    if path == "/api/departments/create":
        try:
            shown = settings.create_department(name, me)
        except settings.DepartmentError:
            return {"error": tr("이미 있는 부서입니다", "This department already exists"), "field": "name"}, 409
        store.log_usage("department_create", f"{me} {shown}")
        return {"ok": True, "name": shown}, 200
    try:
        members = _dept_members(kc, key)
    except keycloak.KeycloakError:
        return {"error": tr("OIDC 에 연결하지 못해 사람 수를 확인할 수 없습니다. 잠시 뒤 다시 시도하세요.",
                            "Could not reach OIDC to count the people. Try again shortly."), "reason": "unreachable"}, 503
    listed = settings.listed_name(name) is not None
    if path == "/api/departments/delete":
        if members:
            return {"error": tr(f"이 부서에는 사람이 {len(members)}명 있어 삭제할 수 없습니다. 먼저 사용자의 부서를 바꾸세요.",
                                f"This department has {len(members)} people, so it cannot be deleted. Change their department first."),
                    "people": len(members)}, 409
        if not settings.delete_department(name):
            return {"error": tr("없는 부서입니다", "No such department")}, 404
        store.log_usage("department_delete", f"{me} {name}")
        return {"ok": True}, 200
    # rename
    new = settings._dept_name(body.get("new_name"))
    if not new:
        return {"error": tr("새 부서 이름을 적어 주세요", "Enter the new department name"), "field": "new_name"}, 400
    if not listed and not members:
        return {"error": tr("없는 부서입니다", "No such department")}, 404
    try:
        new = settings.rename_register(name, new, me)
    except settings.DepartmentError as exc:
        if exc.code == "exists":
            return {"error": tr("이미 있는 부서 이름입니다", "That department name already exists"), "field": "new_name"}, 409
        return {"error": tr("새 부서 이름을 적어 주세요", "Enter the new department name"), "field": "new_name"}, 400
    failed, changed = [], 0
    tok = kc.token() if kc is not None else None
    for m in members:
        try:
            if kc is not None and m["id"]:
                try:
                    kc.update_user(m["id"], {"department": new}, tok)
                except keycloak.KeycloakError as exc:
                    if exc.code != 401:
                        raise
                    tok = kc.token()                                  # 관리자 토큰이 중간에 끝났으면 새로 받고 한 번 더
                    kc.update_user(m["id"], {"department": new}, tok)
            if m["email"]:
                settings.set_department(m["email"], new)
            changed += 1
        except keycloak.KeycloakError:
            failed.append({"name": m.get("name") or m["username"], "username": m["username"]})
    if failed:                                                        # 일부 실패: 표의 옛 이름과 새 이름을 모두 남기고, 같은 요청을 다시 보내면 이어서 한다
        store.log_usage("department_rename_partial", f"{me} {name} changed={changed} failed={len(failed)}")
        return {"ok": True, "partial": True, "name": new, "changed": changed, "total": len(members), "failed": failed}, 200
    settings.rename_finish(name, new)
    store.log_usage("department_rename", f"{me} {name} changed={changed}")
    return {"ok": True, "name": new, "changed": changed, "total": len(members)}, 200


def _users_error(exc: "keycloak.KeycloakError") -> tuple[dict, int]:
    """Keycloak 오류를 화면 오류로: 409 겹침(field), 400 입력, 403 쓰기 권한 없음(manage-users), 404 없음, 그 밖은 502 연결 실패."""
    detail = (exc.detail or "").lower()
    if exc.code == 409:
        field = "email" if "email" in detail else "username"
        return {"error": tr("이미 쓰는 이메일입니다", "This email is already in use") if field == "email" else tr("이미 쓰는 아이디입니다", "This username is already in use"),
                "field": field}, 409
    if exc.code in (401, 403):
        return {"error": tr("AAS 서버에 OIDC 사용자 쓰기 권한(manage-users)이 없습니다. 서비스 계정 aas-admin 에 manage-users 를 주십시오.",
                            "The AAS server has no permission to change OIDC users (manage-users). Grant manage-users to the aas-admin service account."),
                "reason": "forbidden"}, 403
    if exc.code == 400:
        out = {"error": tr(f"OIDC 가 값을 받지 않았습니다: {exc.detail or exc}", f"OIDC did not accept the value: {exc.detail or exc}")}
        if "password" in detail:
            out["field"] = "password"
        return out, 400
    if exc.code == 404:
        return {"error": str(exc) if "HTTP" not in str(exc) else tr("OIDC 에 없는 사용자입니다", "No such OIDC user")}, 404
    return {"error": str(exc), "reason": "unreachable"}, 502


def _account_method(a, user) -> str:
    """로그인한 사람의 비밀번호가 어디 있는가(스펙 2026-10-14-017 S5·S9): local(사용자 파일) · keycloak · none(바꿀 수 없음, 예: Google 로그인·로그인 꺼짐)."""
    email = str((user or {}).get("email") or "").lower()
    if not a.enabled or not email:
        return "none"
    from ..auth.auth import load_users
    if email in load_users(a.cfg.get("users_file") if hasattr(a, "cfg") else None):
        return "local"
    if (user or {}).get("sub") and _kc_admin() is not None:
        return "keycloak"
    return "none"


def _connections_summary(a, user) -> dict | None:
    from ..auth import tokens
    email = str((user or {}).get("email") or "")
    return tokens.summary(email) if a.enabled and email else None


def _tokens_write(a, user, path: str, body: dict) -> tuple[dict, int]:
    """내 Claude Code 연결 만들기·끊기·모두 끊기(스펙 2026-10-28-001 T1). 대상은 늘 로그인한 본인 — 본문에 이메일을 받지 않는다.
    원문 토큰은 만들 때 응답에 한 번만 싣고 로그·기록에는 넣지 않는다. 로그인을 끈 설치는 쓰지 않는다(Q7)."""
    from ..auth import tokens
    if not a.enabled:
        return {"error": tr("로그인을 켜면 쓸 수 있습니다", "Available when sign-in is enabled"), "reason": "login_off"}, 404
    if not isinstance(body, dict):
        return {"error": tr("잘못된 요청", "Invalid request")}, 400
    email = str(user["email"]).lower()
    try:
        if path == "/api/tokens/admin-revoke":                     # 관리자의 강제 끊기 — 사유를 남기고 주인에게 알린다(디자인 D19)
            if not registry().is_admin(user):                       # 토큰 요청은 관리자가 아니다(D5)
                return {"error": tr("관리자만 끊을 수 있습니다", "Only admins can disconnect this")}, 403
            reason = " ".join(str(body.get("reason") or "").split())[:200]
            if len(reason) < 2:
                return {"error": tr("끊는 사유를 적으세요", "Enter the reason"), "field": "reason"}, 400
            owner = str(body.get("email") or "").strip().lower()
            if not tokens.revoke(str(body.get("id") or ""), owner, by=email, reason=reason):
                return {"error": tr("이미 끊었거나 없는 연결입니다", "The connection is already ended or does not exist"), "reason": "not_found"}, 404
            return {"ok": True}, 200
        if path == "/api/tokens/create":
            try:
                days = int(body.get("days") or tokens.DEFAULT_DAYS)
            except (TypeError, ValueError):
                days = 0
            view, raw = tokens.issue(user, str(body.get("name") or ""), str(body.get("bundle") or ""), days)
            return {"ok": True, "token": view, "secret": raw}, 200
        if path == "/api/tokens/revoke":
            if not tokens.revoke(str(body.get("id") or ""), email):
                return {"error": tr("이미 끊었거나 없는 연결입니다", "The connection is already ended or does not exist"), "reason": "not_found"}, 404
            return {"ok": True}, 200
        # 모두 끊기: 확인으로 내 이메일을 적게 한다(디자인 D9). 로그인 세션은 부르는 쪽이 끝낸다(재검토 D8)
        if str(body.get("confirm") or "").strip().lower() != email:
            return {"error": tr("확인용으로 내 이메일을 그대로 적으세요", "Type your email to confirm"), "field": "confirm"}, 400
        return {"ok": True, "revoked": tokens.revoke_all(email)}, 200
    except tokens.TokenError as exc:
        out = {"error": str(exc)}
        if exc.reason:
            out["reason" if exc.reason in ("limit", "auth") else "field"] = exc.reason
        return out, exc.code


def _self_password(a, user, cookie: str | None, body: dict) -> tuple[dict, int]:
    """본인 비밀번호 변경(스펙 2026-10-14-017). 대상은 늘 로그인한 본인 — 본문에 이메일·id 를 받지 않는다.
    현재 비밀번호를 확인(Keycloak password grant 또는 사용자 파일 해시)한 뒤 바꾸고, 같은 사람의 다른 세션을 끝낸다.
    틀린 현재 비밀번호와 없는 계정은 같은 문장으로 답한다. 비밀번호는 로그·응답·감사 기록에 넣지 않는다."""
    from ..auth.auth import _DUMMY_HASH, AuthError, load_users, save_user, verify_password
    email = str((user or {}).get("email") or "").lower()
    method = _account_method(a, user)
    if method == "none":
        return {"error": tr("이 로그인 방식에서는 AAS 에서 비밀번호를 바꿀 수 없습니다. 계정 관리자에게 문의하세요.", "You cannot change the password in AAS with this sign-in method. Ask your account admin."),
                "reason": "unsupported"}, 501
    current, new = str(body.get("current") or ""), str(body.get("new") or "")
    bad = lambda msg, field: ({"error": msg, "field": field}, 400)       # noqa: E731
    if not current:
        return bad(tr("현재 비밀번호를 입력하세요", "Enter your current password"), "current")
    if len(new) < PASSWORD_MIN:
        return bad(tr(f"새 비밀번호는 {PASSWORD_MIN}자 이상이어야 합니다", f"The new password must be at least {PASSWORD_MIN} characters"), "new")
    if new == current:
        return bad(tr("새 비밀번호가 현재 비밀번호와 같습니다", "The new password is the same as the current one"), "new")
    try:
        a.password_attempt(email)
    except AuthError as exc:
        return {"error": str(exc), "reason": "too_many"}, 429
    # 401 이 아니다: 화면 공통 처리(api.ts)는 401 을 「로그인이 끝남」으로 읽어 로그인 화면으로 보낸다
    wrong = ({"error": tr("현재 비밀번호가 맞지 않습니다", "The current password is wrong"), "field": "current", "reason": "wrong_password"}, 403)
    if method == "local":
        path = a.cfg.get("users_file")
        if not verify_password(current, load_users(path).get(email) or _DUMMY_HASH):
            return wrong
        save_user(email, new, path)
    else:
        kc, sub = _kc_admin(), str(user["sub"])
        try:
            tok = kc.token()
            username = str(kc.get_user(sub, tok).get("username") or "")
            if not username or not kc.verify_password(username, current):
                return wrong
        except keycloak.KeycloakError as exc:
            if exc.code == 400 and "direct access" in (exc.detail or "").lower():
                return {"error": tr("OIDC 의 aas-admin 클라이언트가 직접 액세스(비밀번호 확인)를 허용하지 않습니다. 관리자에게 문의하세요.",
                                    "The OIDC aas-admin client does not allow direct access (password check). Ask an admin."), "reason": "config"}, 501
            return {"error": tr("OIDC 에 연결할 수 없습니다", "Cannot reach OIDC"), "reason": "unreachable"}, 502
        try:
            kc.reset_password(sub, new, tok, temporary=False)
        except keycloak.KeycloakError as exc:
            if exc.code == 400:
                return {"error": tr(f"새 비밀번호를 받지 않았습니다: {exc.detail or exc}", f"The new password was not accepted: {exc.detail or exc}"), "field": "new"}, 400
            return _users_error(exc)
    a.password_attempt_ok(email)
    n = a.end_other_sessions(email, cookie)
    store.log_usage("password_self", email)
    return {"ok": True, "other_sessions_ended": n}, 200


def _user_lock(kc, tok: str, reg, uid: str, email: str, user, action: str) -> str:
    """잠금 규칙(V12, 서버도 같은 규칙으로 409): 나 · 설치 때 지정됨(AAS_ADMINS) · 마지막 관리자. 막으면 이유 문장, 아니면 빈 문자열.
    action: disable · delete · demote."""
    me, me_sub = str((user or {}).get("email") or "").lower(), str((user or {}).get("sub") or "")
    if (email and email == me) or (uid and uid == me_sub):
        return tr("내 계정은 다른 관리자가 바꿔야 합니다", "Another admin must change your own account")
    if email and email in reg.admins:
        return tr("설치할 때 운영자가 관리자로 정한 사람입니다", "This admin was set by the operator at installation")
    admins = kc.admin_ids(tok)
    if uid in admins and len(set(admins.values()) | set(reg.admins)) <= 1:
        what = {"disable": tr("사용 중지할", "disable"), "delete": tr("삭제할", "delete"), "demote": tr("관리자에서 뺄", "demote")}[action]
        return tr(f"마지막 관리자는 {what} 수 없습니다", f"You cannot {what} the last admin")
    return ""


def _owned_agents(uid: str, email: str) -> tuple:
    client = k8s.client()
    if client is None:
        return None, []
    return client, [i for i in client.list_agents() if agents.is_owner(i, uid, email)]


def _users_write(a, user, path: str, body: dict) -> tuple[dict, int]:
    """「사용자·권한」의 쓰기. 관리자만(403). Keycloak 관리 설정이 없으면 새 경로는 501, /api/users/set 은 지금 방식(R6)."""
    reg, me = registry(), (user or {}).get("email", "local")
    if a.enabled and not reg.is_admin(user):
        return {"error": tr("관리자만 할 수 있습니다", "Only admins can do this")}, 403
    mode, kc = _users_mode(a)
    if path == "/api/users/logout":                  # 어떤 사람의 로그인 세션을 끊는다(AAS 세션 + Keycloak 관리 설정이 있으면 Keycloak 세션)
        email = str(body.get("email") or "").lower()
        n = a.revoke(email)                          # 행을 지우지 않고 끝남으로 둔다 — 그 브라우저가 오면 Keycloak 세션도 끝낸다(OMAI-1112)
        if kc is None:
            store.log_usage("session_revoke", f"{me} {email}")      # 지금 방식 그대로(R6)
        else:
            names = []
            try:
                tok = kc.token()
                found = [kc.get_user(str(body["id"]), tok)] if body.get("id") else kc.find_by_email(email, tok) if email else []
                for u in found:
                    kc.logout_user(u["id"], tok)
                    names.append(str(u.get("username") or u["id"]))
            except keycloak.KeycloakError:
                pass                                 # AAS 세션은 이미 끝났다. Keycloak 세션은 자기 유휴 시간에 끝난다
            store.log_usage("user_logout", f"{me} {','.join(names) or '-'} ended={n}")   # 감사 기록에 이메일 값을 남기지 않는다
        topics.user_changed(email)
        return {"ok": True, "ended": n}, 200
    if path == "/api/users/set":                     # 권한 주기·바꾸기·빼기 — AAS 쪽 기록. 등록부 파일에 적힌 것은 그대로다
        if mode != "legacy":                         # Keycloak 방식에서는 권한을 Keycloak 그룹으로 정한다(K7)
            return {"error": tr("OIDC 방식에서는 쓰지 않는 요청입니다. 사용자 고치기를 쓰십시오.", "Not used with OIDC. Edit the user instead.")}, 501
        email, role = str(body.get("email") or "").strip().lower(), str(body.get("role") or "")
        pods_in = [str(x) for x in (body.get("pods") or [])]
        known = {p.id for p in reg.pods}
        domain = getattr(a, "cfg", {}).get("domain", "")
        err = (tr("이메일 모양이 아닙니다", "Not a valid email address") if not USER_EMAIL.fullmatch(email)
               else tr(f"{domain} 계정만 등록할 수 있습니다", f"Only {domain} accounts can be registered") if domain and not email.endswith("@" + domain)
               else tr("알 수 없는 권한입니다", "Unknown role") if role not in ("admin", "user", "none")
               else tr("없는 AI 에이전트 작업공간입니다", "AI Agent Workspace not found") if any(p not in known for p in pods_in)
               else tr("내 관리자 권한은 내가 뺄 수 없습니다(다른 관리자가 해야 합니다)", "You cannot remove your own admin role. Another admin must do it.") if email == me.lower() and role != "admin" and email not in reg.admins
               else "")
        if err:
            return {"error": err}, 400
        reg.grant(email, role, pods_in if role == "user" else [], me)
        _scene_scope_changed()                       # 볼 에이전트가 바뀐다(스펙 2026-10-21-022 리뷰 R8)
        if role == "none":                           # 접근을 뺐으면 그 사람의 로그인도 끊는다(Keycloak 세션은 그 브라우저의 다음 요청 때, OMAI-1112)
            a.revoke(email)
        store.log_usage("user_grant", f"{me} {email} → {role}" + (f" ({','.join(pods_in)})" if role == "user" else ""))
        topics.user_changed(email)                   # 열린 웹소켓의 구독을 다시 검사한다(OMAI-1100)
        return {"ok": True}, 200
    if mode != "keycloak":
        return {"error": tr("Keycloak 관리 설정(AAS_KEYCLOAK_ADMIN_CLIENT_ID·…_SECRET)이 없어 사용자를 만들거나 고칠 수 없습니다",
                            "Keycloak admin settings (AAS_KEYCLOAK_ADMIN_CLIENT_ID, …_SECRET) are missing, so users cannot be created or changed")}, 501
    try:
        return _users_keycloak_write(a, user, reg, kc, me, path, body)
    except keycloak.KeycloakError as exc:
        store.log_usage(f"user_{path.rsplit('/', 1)[-1]}_failed", f"{me} HTTP {exc.code}")
        return _users_error(exc)


def _clean(value, limit: int) -> str:
    return " ".join(str(value or "").split())[:limit]


def _users_keycloak_write(a, user, reg, kc, me: str, path: str, body: dict) -> tuple[dict, int]:
    known = {p.id for p in reg.pods}
    bad = lambda msg, field=None: ({"error": msg, **({"field": field} if field else {})}, 400)      # noqa: E731
    if path == "/api/users/create":
        username, email = str(body.get("username") or "").strip().lower(), str(body.get("email") or "").strip().lower()
        first, last = _clean(body.get("first_name"), PERSON_NAME_MAX), _clean(body.get("last_name"), PERSON_NAME_MAX)
        dept, role = _clean(body.get("department"), settings.DEPARTMENT_MAX), str(body.get("role") or "user")
        pods_in, password = [str(x) for x in (body.get("pods") or [])], str(body.get("password") or "")
        domain = getattr(a, "cfg", {}).get("domain", "")
        if dept:                                     # 부서는 관리자가 정한 목록에서만 고른다(스펙 2026-10-15-026 D2). 캐시가 아니라 DB 로 확인한다(R3/D6)
            dept = settings.listed_name(dept) or ""
            if not dept:
                return bad(tr("목록에 없는 부서입니다. 사용자 메뉴의 「부서」 카드에서 먼저 만드세요.", "This department is not in the list. Create it from the Departments card in the Users menu first."), "department")
        if not USER_NAME.fullmatch(username):
            return bad(tr("아이디는 영문 소문자·숫자·. _ - 로 63자까지입니다(이메일 말고)", "Use lowercase letters, digits, . _ - up to 63 characters (not an email)"), "username")
        if not USER_EMAIL.fullmatch(email):
            return bad(tr("이메일 모양이 아닙니다", "Not a valid email address"), "email")
        if domain and not email.endswith("@" + domain):
            return bad(tr(f"{domain} 계정만 등록할 수 있습니다", f"Only {domain} accounts can be registered"), "email")
        if not last:
            return bad(tr("성을 넣으십시오", "Enter the last name"), "last_name")
        if not first:
            return bad(tr("이름을 넣으십시오", "Enter the first name"), "first_name")
        if role not in ("user", "admin"):
            return bad(tr("알 수 없는 권한입니다", "Unknown role"))
        if any(p not in known for p in pods_in):
            return bad(tr("없는 AI 에이전트 작업공간입니다", "AI Agent Workspace not found"))
        if len(password) < PASSWORD_MIN:
            return bad(tr(f"비밀번호는 {PASSWORD_MIN}자 이상이어야 합니다", f"The password must be at least {PASSWORD_MIN} characters"), "password")
        tok = kc.token()
        uid = kc.create_user(username, email, first, last, dept, password, admin=role == "admin", token=tok)
        try:
            reg.grant(email, "user", pods_in, me)    # 볼 수 있는 에이전트(K3). 관리자 여부는 Keycloak 그룹이 정한다(K7)
            _scene_scope_changed()
        except Exception as exc:                     # AAS 기록을 쓰지 못하면 만든 Keycloak 사용자를 지워 되돌린다
            print(f"사용자 만들기: AAS 기록 실패 ({type(exc).__name__}), Keycloak 사용자를 되돌린다", flush=True)   # i18n-ignore: 로그
            try:
                kc.delete_user(uid, tok)
            except keycloak.KeycloakError:
                store.log_usage("user_create_failed", f"{me} {username} partial")
                return {"error": tr(f"OIDC 에 아이디 {username} 이 남았을 수 있습니다. 목록에서 확인한 뒤 지우십시오.",
                                    f"The username {username} may remain in OIDC. Check the list and delete it."), "partial": True}, 500
            store.log_usage("user_create_failed", f"{me} {username} rolled-back")
            return {"error": tr("AAS 기록을 쓰지 못해 만든 계정을 되돌렸습니다", "Could not write the AAS record, so the new account was rolled back")}, 500
        out = {"ok": True, "id": uid, "username": username, "email": email, "agent": "deferred"}
        if body.get("create_agent", True) is not False:
            try:
                settings.set_department(email, dept)     # Hermes 를 만들기 전에 부서를 먼저 적는다 — main 프로파일의 SOUL 템플릿이 부서를 본다(O1)
                out["agent"] = _provision(uid, email, _display_name(first, last, username))
            except Exception as exc:                 # 계정은 그대로 둔다. 첫 로그인 때 다시 만든다(O8)
                out["agent"], out["agent_error"] = "failed", str(exc)[:200]
        store.log_usage("user_create", f"{me} {username} role={role} agent={out['agent']}")
        topics.user_changed(email)
        return out, 200

    uid = str(body.get("id") or "")
    if not uid:
        return bad(tr("사용자 id 가 필요합니다", "The user id is required"))
    tok = kc.token()
    rep = kc.get_user(uid, tok)
    email, username = str(rep.get("email") or "").lower(), str(rep.get("username") or "")
    lock = lambda action: _user_lock(kc, tok, reg, uid, email, user, action)     # noqa: E731

    if path == "/api/users/update":                 # 성·이름·부서·관리자 여부·볼 수 있는 에이전트. 아이디·이메일은 받지 않는다(R2)
        changes, fields = {}, []
        for key, kc_key in (("last_name", "lastName"), ("first_name", "firstName")):
            if key in body:
                val = _clean(body.get(key), PERSON_NAME_MAX)
                if not val:
                    return bad(tr("성을 넣으십시오", "Enter the last name") if key == "last_name" else tr("이름을 넣으십시오", "Enter the first name"), key)
                changes[kc_key] = val
        if "department" in body:
            changes["department"] = _clean(body.get("department"), settings.DEPARTMENT_MAX)
            current = ((rep.get("attributes") or {}).get("department") or [""])[0]
            if changes["department"] and settings._team_key(changes["department"]) != settings._team_key(current):   # 이미 그 부서인 사용자는 검사하지 않는다(D2)
                listed = settings.listed_name(changes["department"])
                if not listed:
                    return bad(tr("목록에 없는 부서입니다. 사용자 메뉴의 「부서」 카드에서 먼저 만드세요.", "This department is not in the list. Create it from the Departments card in the Users menu first."), "department")
                changes["department"] = listed
        role = str(body["role"]) if "role" in body else ""
        if role and role not in ("user", "admin"):
            return bad(tr("알 수 없는 권한입니다", "Unknown role"))
        pods_in = [str(x) for x in (body.get("pods") or [])] if "pods" in body else None
        if pods_in is not None and any(p not in known for p in pods_in):
            return bad(tr("없는 AI 에이전트 작업공간입니다", "AI Agent Workspace not found"))
        kc_admin = uid in kc.admin_ids(tok, enabled_only=False)
        fixed, grant_admin = email in reg.admins, email in set(reg.admin_grants())
        demote = role == "user" and (kc_admin or fixed or grant_admin)
        if demote:
            why = tr("설치할 때 운영자가 관리자로 정한 사람입니다", "This admin was set by the operator at installation") if fixed else lock("demote")
            if why:
                return {"error": why}, 409
        for kc_key in ("lastName", "firstName", "department"):
            if kc_key in changes and str(rep.get(kc_key) if kc_key != "department" else ((rep.get("attributes") or {}).get("department") or [""])[0]) != changes[kc_key]:
                fields.append({"lastName": "last_name", "firstName": "first_name"}.get(kc_key, kc_key))
        if fields:
            kc.update_user(uid, changes, tok)
        if role == "admin" and not (kc_admin or fixed):
            kc.set_admin(uid, True, tok)             # 관리자 그룹에 넣는다. 다음 토큰 갱신(최대 4분) 때 반영된다
            fields.append("role")
        elif demote:
            kc.set_admin(uid, False, tok)            # 관리자 그룹·직접 역할을 빼고 사용자 그룹에 넣는다(O6)
            a.revoke(email)                          # 관리자를 빼면 그 사람의 AAS 세션을 바로 끊는다
            fields.append("role")
        if role and email:
            reg.migrated(email)                      # 화면이 정한 관리자 여부는 Keycloak 그룹에만 둔다(K7)
        if pods_in is not None and email:
            reg.grant(email, "admin" if email in set(reg.admin_grants()) else "user", pods_in, me)
            _scene_scope_changed()
            fields.append("pods")
        if "department" in fields and email:
            settings.set_department(email, changes["department"])
        store.log_usage("user_update", f"{me} {username} fields={','.join(fields) or '-'}")
        topics.user_changed(email)
        return {"ok": True}, 200
    if path == "/api/users/password":
        password = str(body.get("password") or "")
        if len(password) < PASSWORD_MIN:
            return bad(tr(f"비밀번호는 {PASSWORD_MIN}자 이상이어야 합니다", f"The password must be at least {PASSWORD_MIN} characters"), "password")
        kc.reset_password(uid, password, tok)
        store.log_usage("user_password", f"{me} {username}")
        return {"ok": True}, 200
    if path == "/api/users/access":                 # 「AAS 에 추가」: 사용자 그룹에 넣는다(K8)
        kc.set_member(uid, True, tok)
        store.log_usage("user_access", f"{me} {username}")
        topics.user_changed(email)
        return {"ok": True}, 200
    if path == "/api/users/enable":
        if not isinstance(body.get("enabled"), bool):
            return bad(tr("enabled 는 참이나 거짓이어야 합니다", "enabled must be true or false"))
        on = body["enabled"]
        if not on:
            why = lock("disable")
            if why:
                return {"error": why}, 409
        kc.set_enabled(uid, on, tok)                 # 사용 중지면 Keycloak 세션도 끝낸다
        if not on:
            a.revoke(email)
        n = 0
        try:                                         # 사용 중지: 그 사람의 Hermes 를 이유 disabled 로 멈춘다. 다시 사용: 이유가 disabled 인 것만 켠다(R1)
            client, mine = _owned_agents(uid, email)
            for item in mine:
                name, info = item["metadata"]["name"], lifecycle.suspended_info(item)
                if not on and not (item.get("spec") or {}).get("suspended"):
                    lifecycle.suspend(client, name, "disabled")
                    n += 1
                elif on and info["reason"] == "disabled":
                    lifecycle.resume(client, name)
                    n += 1
            if client is not None:
                reg.refresh(ttl=0)
        except k8s.K8sError as exc:
            store.log_usage("user_enable_failed", f"{me} {username} k8s")
            return {"error": tr(f"계정은 바꿨지만 AI 에이전트 작업공간을 처리하지 못했습니다: {exc}", f"The account was changed but its AI Agent Workspaces were not handled: {exc}"), "partial": True}, 502
        store.log_usage("user_enable", f"{me} {username} enabled={int(on)} agents={n}")
        topics.user_changed(email)
        topics.invalidate("agents")
        return {"ok": True, "agents": n}, 200
    if path == "/api/users/delete":                 # 세션 끊기 → Hermes 주인 비우고 멈춤(deleted) → Keycloak 삭제 → access_grants 지우기(K6·R3)
        why = lock("delete")
        if why:
            return {"error": why}, 409
        a.revoke(email)
        try:
            kc.logout_user(uid, tok)
        except keycloak.KeycloakError:
            pass                                     # 삭제가 Keycloak 세션도 끝낸다
        names = []
        try:
            client, mine = _owned_agents(uid, email)
            for item in mine:
                lifecycle.orphan(client, item["metadata"]["name"], email)
                names.append(item["metadata"]["name"])
            if client is not None:
                reg.refresh(ttl=0)
        except k8s.K8sError as exc:                  # Keycloak 계정을 지우기 전에 멈춘다 — 다시 누르면 이어서 한다
            store.log_usage("user_delete_failed", f"{me} {username} k8s")
            return {"error": tr(f"AI 에이전트 작업공간을 처리하지 못해 삭제를 멈췄습니다: {exc}", f"Stopped the deletion because its AI Agent Workspaces could not be handled: {exc}")}, 502
        kc.delete_user(uid, tok)
        if email:
            reg.grant(email, "none", [], me)
            _scene_scope_changed()
        store.log_usage("user_delete", f"{me} {username} agents={len(names)}")
        topics.user_changed(email)
        if names:
            topics.invalidate("agents")
        return {"ok": True, "agents": names}, 200
    return {"error": "not found"}, 404


def _agent_profile_names(reg: Registry, name: str) -> list[str] | None:
    """그 에이전트의 프로파일 이름(숨긴 루트는 뺀다). 등록부(Ready 파드)에 없으면 None — 아직 준비 중이라 읽을 수 없다."""
    pod = next((p for p in reg.pods if p.id == name), None)
    if pod is None:
        return None
    hidden = cron_policy.root_hidden(pod.id)
    return [p.name for p in cron_health.hr.profiles(pod.hermes_home) if not (hidden and p.name == primary.ROOT)]


def _owned_agent(client, user, admin: bool, name: str) -> dict:
    """주인이나 관리자만. 아니면 AgentError(403·404)."""
    try:
        item = client.get_agent(name)
    except k8s.K8sError as exc:
        raise agents.AgentError(str(exc), exc.code) from None
    sub, me = str((user or {}).get("sub") or ""), str((user or {}).get("email") or "").lower()
    if not (admin or agents.is_owner(item, sub, me)):
        raise agents.AgentError(tr("내 AI 에이전트 작업공간이 아닙니다", "This is not your AI Agent Workspace"), 403)
    return item


def _agent_profiles(reg: Registry, user, auth_enabled: bool, name: str) -> dict:
    """「수정」 대화 상자의 프로파일 목록과 지금 채팅 기본(스펙 2026-10-19-001 R-LATE L6). /api/profiles 는 쿠키의 에이전트만 주므로 따로 둔다."""
    client = k8s.client()
    if client is None:
        raise agents.AgentError(tr("쿠버네티스 모드가 아닙니다(AAS_K8S_NAMESPACE)", "Not in Kubernetes mode (AAS_K8S_NAMESPACE)"), 404)
    _owned_agent(client, user, (not auth_enabled) or reg.is_admin(user), name)
    names = _agent_profile_names(reg, name)
    if names is None:
        raise agents.AgentError(tr("AI 에이전트 작업공간이 아직 준비되지 않았습니다", "The AI Agent Workspace is not ready yet"), 409)
    main = primary.primary_of(name)
    return {"profiles": names, "primary": main, "chat_default": chat_default.resolve(name, names, main)}


def _agent_update(client, reg: Registry, user, admin: bool, body: dict) -> tuple[dict, int]:
    """이름(spec.displayName)과 채팅 기본 프로파일을 고친다. 두 값을 모두 검사한 뒤에 쓴다 — 한쪽만 바뀌지 않게(디자인 D10)."""
    name = str(body.get("name") or "")
    _owned_agent(client, user, admin, name)
    display = body.get("display_name")
    if display is not None:
        display = str(display).strip()
        if not display or len(display) > 80:
            raise agents.AgentError(tr("이름은 1~80자로 적어 주세요", "Use 1-80 characters for the name"))
    wanted = body.get("chat_default")
    if wanted is not None:
        wanted = str(wanted)
        names = _agent_profile_names(reg, name)
        if names is None:
            raise agents.AgentError(tr("AI 에이전트 작업공간이 아직 준비되지 않아 프로파일을 고를 수 없습니다", "The AI Agent Workspace is not ready, so a profile cannot be chosen yet"), 409)
        if wanted not in names:
            raise agents.AgentError(tr("이 AI 에이전트 작업공간에 없는 프로파일입니다", "That AI Agent Workspace has no such profile"))
    if display is not None:
        try:
            client.patch_agent(name, {"spec": {"displayName": display}})
        except k8s.K8sError as exc:
            raise agents.AgentError(str(exc), exc.code) from None
        reg.refresh(ttl=0)
    if wanted is not None:
        chat_default.save(name, wanted, str((user or {}).get("email") or "local"))
        _cache.pop(f"{name}:agents", None)
    return {"ok": True}, 200


ROLLOUT_WRITES = ("/api/agents/rollout", "/api/agents/rollout/action")
SIZE_WRITES = ("/api/agents/size", "/api/agents/size/apply")       # 작업공간 크기(스펙 2026-10-30-003 §4-4), 관리자만


def _agents_write(reg: Registry, user, auth_enabled: bool, path: str, body: dict) -> tuple[dict, int]:
    """HermesAgent 를 만들거나 지운다. 만들기: 누구나 자기 것을 한도 안에서(관리자는 남의 것도). 지우기·한도 바꾸기: 관리자만(소유자 지우기는 M2-7). 실제 리소스는 오퍼레이터가 맞춘다."""
    client = k8s.client()
    if client is None:
        raise agents.AgentError(tr("쿠버네티스 모드가 아닙니다(AAS_K8S_NAMESPACE)", "Not in Kubernetes mode (AAS_K8S_NAMESPACE)"), 404)
    admin = (not auth_enabled) or reg.is_admin(user)
    if path == "/api/agents":
        owner = str(body.get("owner_email") or "").strip().lower()
        me = str((user or {}).get("email") or "").lower()
        if owner and owner != me:                    # 남의 Hermes 는 관리자만
            if not admin:
                raise agents.AgentError(tr("관리자만 다른 사람의 AI 에이전트 작업공간을 만들 수 있습니다", "Only admins can create an AI Agent Workspace for someone else"), 403)
            item = agents.create(client, owner, str(body.get("owner_sub") or ""), str(body.get("display_name") or ""), str(body.get("name") or ""))
        elif me:
            item = agents.create_for_user(client, str((user or {}).get("sub") or ""), me, str(body.get("display_name") or ""))
        else:
            raise agents.AgentError(tr("소유자 이메일이 필요합니다", "The owner email is required"))
        reg.refresh(ttl=0)
        # 「+」로 만든 에이전트도 첫 로그인처럼 주 프로파일(main)을 받는다(사용자 결정 2026-10-19, 스펙 2026-10-19-001 R7).
        # 예전에는 _provision 에서만 표시해 「+」 에이전트에는 default 만 있었고, 채팅·스킬 허브의 목록이 비었다
        if primary.mark((item.get("metadata") or {}).get("name", "")):
            _IDENTITY_WAKE.set()
        office_changed.bump("pods")                  # 배치 폼의 작업공간 목록(스펙 2026-10-26-001). 리더 반복도 pod_changed 로 잡지만 등록부 새로 고침을 기다리지 않는다
        return {"ok": True, "agent": agents.view(item)}, 201
    sub, me = str((user or {}).get("sub") or ""), str((user or {}).get("email") or "").lower()
    if path in ROLLOUT_WRITES:                                                  # 순차 롤아웃: 관리자만(스펙 2026-10-28-015 §4-4)
        if not admin:
            raise agents.AgentError(tr("관리자만 롤아웃을 다룰 수 있습니다", "Only admins can manage rollouts"), 403)
        try:
            reg.refresh(ttl=0)                                                  # 진행 중인지는 최신 목록으로 판단한다
            if path == "/api/agents/rollout":
                item = rollouts.create(client, body, reg.rollouts, {a["name"] for a in reg.agents}, me or "local")
            else:
                item = rollouts.action(client, reg.rollouts, str(body.get("name") or ""), str(body.get("action") or ""), me or "local")
        except rollouts.RolloutError as exc:
            raise agents.AgentError(str(exc), exc.code) from None
        except k8s.K8sError as exc:
            raise agents.AgentError(str(exc), exc.code) from None
        reg.refresh(ttl=0)
        return {"ok": True, "rollout": (item.get("metadata") or {}).get("name", "")}, 201 if path == "/api/agents/rollout" else 200
    if path == "/api/agents/update":                                            # 「수정」: 주인이나 관리자(스펙 2026-10-19-001 R5·R3)
        return _agent_update(client, reg, user, admin, body)
    if path in ("/api/agents/delete", "/api/agents/resume"):                    # 주인이나 관리자
        name = str(body.get("name") or "")
        try:
            item = client.get_agent(name)
        except k8s.K8sError as exc:
            raise agents.AgentError(str(exc), exc.code) from None
        if not (admin or agents.is_owner(item, sub, me)):
            raise agents.AgentError(tr("내 AI 에이전트 작업공간이 아닙니다", "This is not your AI Agent Workspace"), 403)
        if path == "/api/agents/resume":
            lifecycle.resume(client, name)
            reg.refresh(ttl=0)
            return {"ok": True}, 200
        if str(body.get("confirm_name") or "") != name:
            raise agents.AgentError(tr("지우려면 AI 에이전트 작업공간 id 를 그대로 다시 입력해야 합니다", "To delete, type the AI Agent Workspace id exactly"), 400)
        pod = next((p for p in reg.pods if p.id == name), None)
        bundle = None
        if pod is not None:
            try:
                bundle = export.bundle(pod.hermes_home, name)
            except Exception as exc:              # 내보내기가 실패해도 지우기는 막지 않는다(파드가 이미 죽어 있을 수 있다). 결과에 알린다.
                print(f"내보내기 실패 ({name}): {type(exc).__name__}", flush=True)   # i18n-ignore: 로그
        try:
            client.delete_agent(name)
        except k8s.K8sError as exc:
            raise agents.AgentError(str(exc), exc.code) from None
        cleaned = lifecycle.cascade(name)
        try:                                       # 남는 데이터 볼륨의 기간을 이 시각부터 센다(OMAI-1291). 기록이 실패해도 지우기는 끝났다
            owner = agents._owner(item.get("spec") or {})
            retained_volumes.record_deletion(name, owner, me or "local", bundle.name if bundle else "",
                                             agent_name=str((item.get("spec") or {}).get("displayName") or ""),
                                             owner_name=office.display_name(owner, office.people()) if "@" in (owner or "") else "")
        except Exception as exc:
            print(f"남은 볼륨 기록 실패 ({name}): {type(exc).__name__}", flush=True)   # i18n-ignore: 로그
        reg.refresh(ttl=0)
        office_changed.bump("pods", "seats")         # 지운 작업공간의 자리도 빠진다(스펙 2026-10-26-001)
        return {"ok": True, "export": bundle.name if bundle else None, "cleaned": cleaned}, 200
    if not admin:
        raise agents.AgentError(tr("관리자만 할 수 있습니다", "Only admins can do this"), 403)
    if path == "/api/agents/owner":
        name, email = str(body.get("name") or ""), str(body.get("owner_email") or "").strip().lower()
        if not agents.EMAIL.match(email):
            raise agents.AgentError(tr("소유자는 이메일 주소여야 합니다", "The owner must be an email address"))
        # 새 주인의 크기를 같은 patch 에 넣는다(스펙 2026-10-30-003 D8). 크기가 바뀌면 파드가 다시 만들어지므로 §4-6 검사를 거친다
        want = agents.desired(email)
        try:
            item = client.get_agent(name)
        except k8s.K8sError as exc:
            raise agents.AgentError(str(exc), exc.code) from None
        state, doc = agents.capacity_doc(client, fresh=True)
        install = agents.install_defaults(doc)
        if agents.size_differs(item, want, install):
            lim = agents.qty(agents.with_install(agents.spec_size(item), install).get("memory_limit"))
            checked = agents.check_size(doc if state == "ok" else None, agents.with_install(want, install), [{"name": name, "memory_limit": lim}])
            if checked["reject"]:
                raise agents.AgentError(checked["reject"])
            if checked["blocked"] and not body.get("force"):
                raise agents.AgentError(checked["blocked"]["reason"], 409, extra={"blocked": checked["blocked"]})
        spec = {"ownerEmail": email, "ownerSub": lifecycle.known_sub(email) or email}
        res = agents.resources_patch(item, want)
        if res:
            spec["resources"] = res
        try:
            # 새 주인을 정하면 지운 주인의 표시(deleted-owner)를 지운다(스펙 2026-10-14-011 R3)
            client.patch_agent(name, {"metadata": {"annotations": {lifecycle.ANNO_DELETED_OWNER: None}}, "spec": spec})
        except k8s.K8sError as exc:
            raise agents.AgentError(str(exc), exc.code) from None
        reg.refresh(ttl=0)
        _scene_scope_changed()                       # 주인이 바뀌면 ① 내 에이전트가 달라진다(스펙 2026-10-21-022 리뷰 R8)
        return {"ok": True}, 200
    if path == "/api/agents/size":
        return _size_save(client, reg, user, body)
    if path == "/api/agents/size/apply":
        return _size_apply(client, reg, user, body)
    if path == "/api/agents/limit":
        raw = body.get("limit")
        if raw is not None and (isinstance(raw, bool) or not isinstance(raw, int)):
            raise agents.AgentError(tr("한도는 정수이거나 비워야(기본값) 합니다", "The limit must be an integer, or empty for the default"))
        agents.set_limit(str(body.get("email") or ""), raw, str((user or {}).get("email") or "local"))
        return {"ok": True}, 200
    raise agents.AgentError(tr("알 수 없는 요청입니다", "Unknown request"), 404)


def _office_inbox(reg: Registry, user) -> dict:
    """받은편지함(계획 007 P4): 답하지 않은 승인·되묻기 + 내가 맡긴 검토·막힘 카드 + 내 에이전트의 실패한 크론."""
    me = str((user or {}).get("email") or "").lower()
    items = INBOX.for_person(me)
    items += inbox.cards_for(_inbox_cards(), _card_owners(), me)
    by_pod = {(s["pod"], s["profile"]): s["alias"] for s in office.seats()}
    failed = []
    for pod in reg.pods:
        if not me or (pod.owner or "").lower() != me:
            continue
        try:
            for f in _health(pod).get("failed_jobs", []):
                if not f.get("muted"):
                    failed.append({**f, "pod": pod.id, "alias": by_pod.get((pod.id, f["profile"]))})
        except Exception:                                  # 한 설치본을 못 읽어도 나머지는 보인다
            continue
    items += inbox.crons_for(failed, me)
    done = []
    for pod in reg.pods:
        if not me or (pod.owner or "").lower() != me:
            continue
        try:                                                        # 파일 읽기, 파드마다 30초 캐시(스펙 2026-10-15-003 R3·F1)
            rows = _cached(f"{pod.id}:crondone", 30, lambda pod=pod: cron_done.recent_success(pod.hermes_home), per_lang=False)
            done += cron_done.items_for(rows, pod.id, by_pod, cron_policy.root_hidden(pod.id))
        except Exception:
            continue
    items += cron_done.unacked(done, me) if me else []
    for pod in reg.pods:                                                # MCP 로그인 필요(스펙 2026-10-16-010 T8·V14): 받는 사람은 주인
        if not me or (pod.owner or "").lower() != me:
            continue
        try:
            items += _cached(f"{pod.id}:mcplogin_inbox", 30, lambda pod=pod: mcp_oauth_relay.login_items(
                pod.id, pod.hermes_home, [(p.name, p.path) for p in cron_health.hr.profiles(pod.hermes_home)],
                lambda pod_id, prof: by_pod.get((pod_id, prof))), per_lang=False, stale_ok=False)
        except OSError:
            continue
    label = lambda pod_id, prof: by_pod.get((pod_id, prof)) or prof     # noqa: E731
    admin_requests.prune()
    if reg.is_admin(user):                                              # 관리자에게 온 요청(스펙 2026-10-15-011 단계 5)
        known_people = office.people()
        items += admin_requests.admin_items(label, name_of=lambda email: office.display_name(email, known_people))
        if config.get("AAS_K8S_NAMESPACE"):                             # 지운 에이전트의 남은 데이터 볼륨(OMAI-1291)
            items += retained_volumes.notice_items(config.get("AAS_K8S_NAMESPACE"))
    if me:                                                              # 내가 낸 요청의 결과
        items += admin_requests.result_items(me, label)
    items += pc_import.inbox_items(me, reg.is_admin(user), label)       # PC 에서 가져오기: 대행 알림·끝남·되돌리기 실패(OMAI-1136 D11)
    if "@" in me:                                                      # Claude Code 연결: 만료 예정·남이 끊음(스펙 2026-10-28-001 §3-7 ③). 로그인을 끈 설치(local)는 없다
        from ..auth import tokens
        items += tokens.inbox_items(me)
    # 자리 별칭이 설치본 id(자동 별칭)면 화면에 id 가 보였다 — 보일 이름(label)을 따로 준다. alias 는 답하기·이동에 그대로 쓴다(스펙 2026-10-19-003)
    seat_label = office.seat_labels()
    return {"items": [{**i, "label": seat_label.get(i["alias"], i["alias"])} if i.get("alias") else i for i in items]}


def _inbox_cards() -> list[dict]:
    """받은편지함에 들어갈 검토·막힘 카드. 받은편지함 신호(사람마다 15초)와 REST(화면 30초)가 같이 읽는다 — 표 캐시(스펙 2026-10-26-002 §9-14)."""
    def read() -> list[dict]:
        with hub_auto._db() as conn:
            return [dict(r) for r in conn.execute("SELECT board, task_id, status, assignee, title FROM office_cards WHERE status IN ('review','blocked')")]
    return table_cache.get("inbox.cards", ("office_cards",), read)


def _card_owners() -> dict:
    """카드를 맡긴 사람(보드, 카드) → 이메일. 표 캐시."""
    def read() -> dict:
        with office.connect() as conn:
            return {(r["board"], r["task_id"]): r["email"] for r in conn.execute("SELECT board, task_id, email FROM office_card_owner")}
    return table_cache.get("inbox.owners", ("office_card_owner",), read)


def office_inbox_signal(me: str) -> dict:
    """받은편지함 신호 토픽의 값(스펙 2026-10-17-004 D9): 공유 DB 에 있는 항목(승인·되묻기·검토·막힘 카드·관리자 요청)의 바뀜 번호.
    파드 파일을 읽는 크론·MCP 로그인 항목은 넣지 않는다 — 사이드카를 기다리면 토픽 읽기 실행기 8개가 막힌다(L5). 그쪽은 화면이 30초마다 HTTP 로 읽는다."""
    me = str(me or "").lower()
    keys = [i["id"] for i in INBOX.for_person(me)]
    if me:
        keys += [f"{c['id']}|{c['kind']}|{c['text']}" for c in inbox.cards_for(_inbox_cards(), _card_owners(), me)]
    keys += [f"req|{rid}|{status}" for rid, status in admin_requests.signal_rows(me)]
    return {"v": hashlib.sha1("\n".join(keys).encode("utf-8")).hexdigest()[:16], "n": len(keys)}


def office_cards_signal() -> dict:
    """3D 카드 신호 토픽 office:cards 의 값(스펙 2026-10-17-004 D10): 마지막 카드 이벤트 번호와 카드 줄 수.
    조용한 첫 동기화는 이벤트를 내지 않지만 줄 수가 바뀐다. 공유 DB 라 다른 복제본의 바뀜도 주기(15초) 안에 보인다."""
    with hub_auto._db() as conn:
        top = int(conn.execute("SELECT COALESCE(MAX(id), 0) n FROM office_events").fetchone()["n"])
        count = int(conn.execute("SELECT COUNT(*) n FROM office_cards").fetchone()["n"])
    return {"event": top, "cards": count}


def office_meeting_active() -> list[dict]:
    """진행 중인 회의(토픽 office:meeting:active 의 값, 스펙 2026-10-17-004). 구독자마다 거르기는 meeting_active_for 가 한다.
    회의마다 view() 를 부르지 않고 한 번에 읽는다(스펙 2026-10-26-002 R7)."""
    return office_meeting().active_with_last()


def meeting_active_for(rows: list[dict], acc: office_access.Access) -> dict:
    """회의실에 누가 있는지(위치)는 모두에게, 발언 중인 글은 그 방 구성원에게만(계획 007 P3, R5). 방 이름은 구성원·관리자에게만(계획 2026-10-13-001 R6).
    HTTP(/api/office/meeting/active)와 토픽이 같은 규칙을 쓴다.
    구성원이 아니면 seats 를 장면에 보이는 자리로 줄인다(스펙 2026-10-21-022). 빈 목록이어도 행은 둔다 — 명패 「회의 중」이 room 으로 정해진다(리뷰 R2)."""
    out = []
    scene = None
    for row in rows:
        if acc.member_of(row["room"]):
            out.append(row)
        else:
            scene = acc.scene_aliases() if scene is None else scene
            out.append({**{k: v for k, v in row.items() if k not in ("name", "partial", "last")},
                        "seats": [a for a in row.get("seats") or [] if a in scene]})
    return {"meetings": out}


def _office_people(acc: office_access.Access) -> list[dict]:
    """/api/office/presence 의 사람 목록. 장면의 사람은 이 목록으로 그리므로 보기 범위(같은 부서·같은 TFT 구성원, 스펙 2026-10-21-022)로 거른다.
    웹소켓 office:presence(위치와 id 만)는 거르지 않는다(리뷰 R6). 이메일로 거른 뒤 관리자가 아니면 이메일을 뺀다(R6)."""
    return _office_people_from(PRESENCE.view(acc.email, True), acc)


def _office_people_from(rows: list[dict], acc: office_access.Access) -> list[dict]:
    """사람 행(이메일 있음)을 이 사람에게 보낼 목록으로 거른다. REST(/api/office/presence)와 토픽 office:people 이 같이 쓴다
    (스펙 2026-10-26-001 회귀 계약 3). 토픽 읽기는 보는 사람을 모르므로 me 와 「나 먼저」 정렬을 여기서 다시 한다(외부 검토 L2)."""
    me = (acc.email or "").lower()
    rows = sorted(({**r, "me": str(r["email"]).lower() == me} for r in rows), key=lambda r: not r["me"])   # sorted 는 안정 정렬 — 나머지 순서(이름순)는 그대로
    allow = acc.scene_people()
    if allow is None:                                           # 관리자는 부서로 거를 수 있게 부서를 붙인다(스펙 2026-10-22-002)
        depts = settings.departments()
        return [{**r, "department": depts.get(r["email"].lower(), "")} for r in rows]
    return [{k: v for k, v in r.items() if k != "email"} for r in rows if r["email"].lower() in allow]


def office_people_source() -> dict:
    """토픽 office:people 의 값(스펙 2026-10-26-001 §4-2): 지금 있는 사람 전체(이메일 있음, 화면에 그대로 가지 않는다 — view 가 거른다)와
    오피스 정보 변경 번호. 번호를 넣어 부서·방·권한이 바뀌면 값이 달라져 다시 거른다(리뷰 D11)."""
    return {"rows": PRESENCE.view("", True), "changed": office_changed.value()}


def office_people_same(value: dict) -> tuple:
    """skip_same 비교값: 사람 행에서 보는 탭(viewing)과 위치(pos)를 뺀 것 + 변경 번호. 위치는 걸음 토픽(office:presence)이 따로 보내고,
    viewing 은 화면이 읽지 않는다(리뷰 D12). 이 둘만 바뀌면 구독자 보기 범위를 다시 계산하지 않는다."""
    rows = tuple(sorted((str(r.get("email")), str(r.get("name")), str(r.get("seed"))) for r in value.get("rows") or []))
    changed = value.get("changed") or {}
    return rows, changed.get("n"), changed.get("admin")


def office_people_pub(conn_id: str, user: dict, data: dict) -> None:
    """웹소켓 사람 신호(스펙 2026-10-26-001 §4-2 서버 3·3a). POST /api/office/presence 와 같은 쓰기를 하되 사람 목록은 돌려주지 않는다.
    이메일은 연결의 로그인 정보에서만 가져온다. 떠남(leave)은 이 서버에 같은 사람의 다른 연결이 없을 때만 그 사람을 뺀다."""
    me = str((user or {}).get("email") or "").lower()
    if not me:
        return
    if data.get("leave"):
        PRESENCE.release(conn_id, leave=True)
        return
    office.person_touch(me, str((user or {}).get("name") or ""))      # 에이전트 주인 이름에 쓰는 이름 기록(외부 검토 H3)
    with store.request_memo():
        known = office.people()
        seed = (known.get(me) or {}).get("seed") or presence.person_id(me)
        PRESENCE.hold(conn_id, me, office.display_name(me, known), seed, str(data.get("beat") or "")[:80])


def _office_cards(acc: office_access.Access) -> dict:
    """장면의 3D 칸반 보드와 에이전트 서랍이 쓰는 카드 목록(계획 007 P4). 칸반 보드와 같은 규칙으로 거른다 —
    보이지 않는 자리 앞으로 된 카드는 빠진다. 카드 상태는 보드를 볼 때와 20초 주기에 갱신된 마지막 값이다."""
    with hub_auto._db() as conn:
        rows = [dict(r) for r in conn.execute(
            "SELECT c.board, c.task_id, c.status, c.assignee, c.title FROM office_cards c "
            "JOIN office_boards b ON b.slug=c.board WHERE b.archived=0 ORDER BY c.board, c.task_id LIMIT 1000")]
    if not acc.admin:
        visible = acc.visible_aliases()
        rows = [r for r in rows if not r["assignee"] or r["assignee"] in visible]
    return {"cards": rows}


def _office_inbox_answer(reg: Registry, user, auth_enabled: bool, body: dict) -> dict:
    """받은편지함의 승인·되묻기에 답한다. 받는 사람(대화를 시작한 사람·주인)과 관리자만."""
    item_id = str(body.get("id") or "")
    if item_id.startswith(admin_requests.ADMIN_PREFIX):                 # 관리자 요청 처리·거절: 관리자만
        if auth_enabled and not reg.is_admin(user):
            raise office_access.Denied(tr("관리자만 요청을 처리할 수 있습니다", "Only admins can handle requests"))
        status = {"handled": "handled", "declined": "declined"}.get(str(body.get("choice") or ""), "")
        admin_requests.decide(item_id, status, str((user or {}).get("email") or "local"), str(body.get("reason") or ""))
        return {"ok": True}
    if item_id.startswith(retained_volumes.PREFIX):                     # 남은 볼륨 알림 「처리했습니다」: 관리자만(OMAI-1291)
        if auth_enabled and not reg.is_admin(user):
            raise office_access.Denied(tr("관리자만 처리할 수 있습니다", "Only admins can handle this"))
        try:
            retained_volumes.ack(item_id, str((user or {}).get("email") or "local"))
        except ValueError:
            raise office.OfficeError(tr("알림 내용이 바뀌었습니다. 받은편지함을 다시 읽어 주세요", "The notice has changed. Reload the inbox")) from None
        return {"ok": True}
    if item_id.startswith(pc_import.PREFIX):                            # PC 가져오기 알림 「확인」: 본 사람의 표시만 지운다(OMAI-1136)
        try:
            pc_import.ack(item_id, str((user or {}).get("email") or "local"))
        except ValueError:
            raise office.OfficeError(tr("이미 없는 알림입니다", "The notice no longer exists")) from None
        return {"ok": True}
    if item_id.startswith("conn|"):                                     # Claude Code 연결 알림 「확인」: 그 연결의 주인만(스펙 2026-10-28-001 §3-7 ③)
        from ..auth import tokens
        try:
            tokens.notice_ack(item_id, str((user or {}).get("email") or ""))
        except ValueError:
            raise office.OfficeError(tr("이미 없는 알림입니다", "The notice no longer exists")) from None
        return {"ok": True}
    if item_id.startswith(admin_requests.RESULT_PREFIX):                # 내 요청의 결과 확인: 요청자 본인만
        admin_requests.ack(item_id, str((user or {}).get("email") or "local").lower())
        return {"ok": True}
    if item_id.startswith(cron_done.PREFIX):                        # 크론 완료 알림: 이 파드의 주인이 「확인」한다
        me = str((user or {}).get("email") or "").lower()
        pod = next((p for p in reg.pods if p.id == cron_done.pod_of(item_id)), None)
        if auth_enabled and not (me and pod and (pod.owner or "").lower() == me):
            raise office_access.Denied(tr("이 알림을 확인할 수 있는 사람이 아닙니다", "You cannot acknowledge this notice"))
        cron_done.ack(me or "local", item_id)
        return {"ok": True}
    item = INBOX.get(item_id)
    if not item:
        raise office.OfficeError(tr("이미 답했거나 끝난 요청입니다", "The request was already answered or has ended"))
    me = str((user or {}).get("email") or "").lower()
    if auth_enabled and me not in item["to"] and not reg.is_admin(user):
        raise office_access.Denied(tr("이 요청에 답할 수 있는 사람이 아닙니다", "You cannot answer this request"))
    answer = {"choice": str(body.get("choice") or "deny"), "answer": body.get("answer")}
    if item.get("origin", SHARED.origin) == SHARED.origin:
        return _inbox_apply(reg, item, answer, me)
    # 그 대화는 다른 서버에 열려 있다 — 답을 DB 에 적고 그 서버가 처리한 결과를 기다린다(shared_tick 이 0.3초마다 가져간다)
    SHARED.answer_put(item_id, answer, me)
    deadline = time.time() + ANSWER_WAIT
    while time.time() < deadline:
        result = SHARED.answer_result(item_id)
        if result is not None:
            if result.get("error"):
                raise office.OfficeError(result["error"])
            return result
        time.sleep(0.2)
    return {"ok": True, "queued": True}


class AlreadyAnswered(Exception):
    """승인·되묻기에 다른 쪽이 먼저 답했다(스펙 2026-10-28-001 §3-7 ④). body 는 화면·Claude Code 에 줄 409 본문."""
    def __init__(self, row: dict):
        who = "Claude Code" if row.get("via") == "token" else (office.person_name(row.get("by_email") or "") or tr("다른 사람", "someone else"))   # 이메일 대신 이름(2026-10-30)
        super().__init__(who)
        self.body = {"error": tr(f"이미 {who} 가 답했습니다", f"{who} already answered"), "reason": "already_answered",
                     "by": row.get("by_email") or "", "via": row.get("via") or "screen", "choice": row.get("choice") or ""}


def _answer_once(pod: Pod, sid: str, kind: str, request_id: str | None, question_id: str | None, choice: str, by: str, send):
    """먼저 답한 쪽만 보낸다(Claude Code·채팅·받은편지함이 같은 카드에 답할 수 있다). 요청 번호가 없는 옛 승인은 가리지 않는다.
    보내다 실패하면 적은 줄을 지워 다시 답할 수 있게 한다."""
    from ..ops import approval_answers
    if not request_id:
        return send()
    k = approval_answers.key(pod.id, request_id, question_id)
    won = approval_answers.claim(k, pod.id, sid, kind, choice, by, store.actor_via.get() or "screen")
    if won is not None:
        raise AlreadyAnswered(won)
    try:
        return send()
    except Exception:
        approval_answers.release(k)
        raise


def _inbox_apply(reg: Registry, item: dict, answer: dict, by: str = "") -> dict:
    """이 서버의 대화 연결로 답을 보낸다."""
    pod = next((p for p in reg.pods if p.id == item["pod"]), None)
    if pod is None:
        raise office.OfficeError(tr("없는 AI 에이전트 작업공간입니다", "No such AI Agent Workspace"))
    h = hub(pod)
    try:
        if item["kind"] == "approval":
            return {"ok": True, "result": _answer_once(pod, item["sid"], "approval", item["request_id"] or None, None, answer["choice"], by,
                                                       lambda: h.approve(item["sid"], answer["choice"], item["request_id"] or None))}
        return {"ok": True, "result": _answer_once(pod, item["sid"], "clarify", item["request_id"], item["question_id"] or None, "answer", by,
                                                   lambda: h.clarify(item["sid"], item["request_id"], answer.get("answer"), item["question_id"] or None))}
    except AlreadyAnswered as exc:                         # 받은편지함 화면은 이 문장을 그대로 보인다
        raise office.OfficeError(exc.body["error"]) from None


def _office(reg: Registry, user, auth_enabled: bool) -> dict:
    out = _office_base(reg, user, auth_enabled)
    # 부서 슬로건·목표 현수막(스펙 2026-10-15-018): 문구가 있고 사람이나 자리 팀이 있는 부서와 보는 사람의 부서
    return {**out, **settings.banners(settings.departments().get(str((user or {}).get("email") or "").lower(), ""), active=_active_team_keys())}


def _active_team_keys() -> set[str]:
    """현수막을 보일 부서: 사람이 있는 부서(로그인으로 알게 된 부서)와 오피스 자리의 팀. 사용자의 부서를 바꾸면 옛 부서는 여기서 빠진다."""
    keys = {office.team_key(d) for d in settings.departments().values()}
    keys |= {office.team_key(s["team"]) for s in office.seats() if s.get("team")}
    return keys


def _office_base(reg: Registry, user, auth_enabled: bool) -> dict:
    acc = office_access.Access(reg, user, auth_enabled)
    seated = {(s["pod"], s["profile"]) for s in office.seats()}
    # 쿠버네티스의 사용자별 Hermes 는 프로파일이 default 하나뿐이다. 빼면 아무도 앉힐 수 없어 그때만 넣는다.
    skip_default = not config.get("AAS_K8S_NAMESPACE")
    # primary: 그 설치본의 주 프로파일. TFT 방에서 구성원을 고르면 그 사람의 주 프로파일 자리가 저절로 체크된다(2026-10-18)
    names = office.agent_names_provider() or {}
    known_people = office.people()
    pods = [{"id": p.id, "owner": p.owner, "owner_name": office.person_name(p.owner or "", known_people), "name": names.get(p.id, ""), "primary": primary.primary_of(p.id),
             "profiles": [{"name": x.name, "seated": (p.id, x.name) in seated}
                          for x in cron_health.hr.profiles(p.hermes_home) if not (skip_default and x.name == "default")]}
            for p in reg.allowed(user, auth_enabled)]
    if acc.admin:
        office.recheck_failed(reg.pods)     # 파드가 다시 뜨는 동안 실패한 점검이 살아난 뒤에도 띠로 남지 않게(관리자에게만 띠가 간다)
    ov = office.overview()
    labels = office.seat_labels()                    # 화면에 보일 에이전트 이름(2026-10-18-010)
    ov = {**ov, "seats": [{**s, "label": labels.get(s["alias"], s["alias"])} for s in ov["seats"]]}
    mine = _my_seat(reg, user)
    if acc.admin:
        known = office.people()          # 목록의 「사람」 열은 이름으로. 고칠 때 쓰는 구성원·담당은 이메일 그대로
        # 관리자의 「볼 부서」 콤보박스(스펙 2026-10-22-002): 방마다 구성원의 부서(team_key)와, 고를 부서 이름(부서 목록 ∪ 사람 부서).
        # /api/departments 는 처음 부를 때 Keycloak 사용자를 조회하므로 쓰지 않는다(리뷰 R2)
        depts = settings.departments()
        team = lambda d: office.team_key(office._text(d, 80))     # noqa: E731 — 022 의 자리 팀 비교와 같은 규칙
        ov = {**ov, "rooms": [{**r, "people": office.named(r["people"], known),
                               "teams": sorted({team(depts[m]) for m in r.get("members") or [] if depts.get(m)})} for r in ov["rooms"]]}
        # 고를 부서는 AAS 부서 목록(설정 > 부서)이다. 사람 부서 기록은 로그인 때만 갱신돼 옛 값(시험 계정의 「AAS 개발부」)이 남으므로 넣지 않고,
        # 관리자 본인 부서가 목록에 없을 때만 그 하나를 더해 처음 값이 「전체」로 떨어지지 않게 한다(사용자 정정 2026-10-22)
        names = [d["name"] for d in settings.department_rows()]
        mine = depts.get(acc.email, "")
        if mine and team(mine) not in {team(n) for n in names}:
            names.append(mine)
        return {**ov, "pods": pods, "can_edit": True, "can_act": True, "my_seat": mine, "departments": names}
    visible = acc.visible_aliases()
    known = office.people()
    # 구성원 이메일은 관리자만 본다. 사람·담당도 이메일일 수 있어(2026-10-18) 표시 이름으로 바꿔 준다
    secret = office._person_secret()
    rooms = []
    for r in acc.rooms():
        row = {**{k: v for k, v in r.items() if k != "members"}, "people": office.named(r["people"], known), "owner": office.named([r["owner"]], known)[0]}
        role = acc.room_role(r["id"])
        if role:
            row["my_role"] = role                                    # 담당·구성원도 고친다(2026-10-18-009)
        if role == "owner":                                          # 담당은 구성원을 고치므로 구성원을 열쇠로 준다(이메일은 R6 로 관리자만)
            row["members"] = [office.person_key(m, secret) for m in r.get("members") or []]
            row["owner_key"] = office.person_key(r["owner"], secret)
        rooms.append(row)
    return {"seats": [s for s in ov["seats"] if s["alias"] in visible], "rooms": rooms, "pins": {}, "checks": {}, "problems": [],
            "pods": pods, "can_edit": False, "can_act": True, "my_seat": mine}


def _my_seat(reg: Registry, user) -> str:
    """「카드 추가」 담당의 처음 값(OMAI-1286): 내가 주인인 설치본의 주 프로파일 자리, 없으면 내 설치본의 이름 순 첫 자리, 없으면 빈 값."""
    email = str((user or {}).get("email") or "").lower()
    own = [p.id for p in reg.pods if email and (p.owner or "").lower() == email]
    if not own:
        return ""
    recs = primary.records()
    for pod in own:
        alias = office.seat_alias(pod, primary.primary_of(pod, recs))
        if alias:
            return alias
    names = sorted(s["alias"] for s in office.seats() if s["pod"] in own and s["enabled"])
    return names[0] if names else ""


def _office_room_edit(reg: Registry, user, auth_enabled: bool, body: dict, who: str) -> dict:
    """관리자가 아닌 사람의 TFT 방 고치기(스펙 2026-10-18-009). 역할에 따라 칸을 걸러 room.set 으로 보낸다. 안 되면 office_access.Denied."""
    acc = office_access.Access(reg, user, auth_enabled)
    return _office_action(reg, acc.room_edit(body), who)


def _scene_scope_changed() -> None:
    """장면의 보기 범위가 바뀌었다(자리 팀·접근 권한·주인). 화면이 스냅샷을 다시 받게 desks.changed 를 낸다(스펙 2026-10-21-022 §3-4, 리뷰 R8).
    desks.changed 는 다른 서버로도 중계된다(shared.RELAYED, 리뷰 R5)."""
    OFFICE.bus.publish("desks.changed", {})
    office_changed.bump("seats", "rooms", "pods")               # 자리·방·작업공간 목록과 보기 범위가 바뀐다 — 모든 탭의 화면이 /api/office 를 다시 읽는다(스펙 2026-10-26-001)


def _office_action(reg: Registry, body: dict, who: str) -> dict:
    """오피스 메타를 바꾼다 — 전부 AAS DB 의 기록이고 Hermes 는 건드리지 않는다."""
    action = str(body.get("action") or "")
    if action == "seat.set":
        known = {p.id: {x.name for x in cron_health.hr.profiles(p.hermes_home)} for p in reg.pods}
        out = office.set_seat(body, who, known)
        _scene_scope_changed()                                  # 팀이 바뀌면 보이는 사람이 달라진다
        _notify_desks()
        return out
    if action == "seat.delete":
        out = office.delete_seat(str(body.get("alias") or ""), who)
        _notify_desks()
        office_changed.bump("seats")
        return out
    if action == "desk.set":
        out = office.assign_desk(str(body.get("desk") or ""), str(body.get("alias") or ""), who)
        OFFICE.bus.publish("desks.changed", {})
        _notify_desks()
        return out
    if action == "room.set":
        out = office.set_room(body, who)
        office.assign_room_places()                             # 열리거나 닫힌 방의 TFT 회의실 짝을 바로 맞춘다(R4)
        OFFICE.bus.publish("desks.changed", {})
        _notify_desks()
        office_changed.bump("rooms")
        return out
    if action == "room.delete":
        out = office.delete_room(int(body.get("id") or 0))
        office.assign_room_places()
        OFFICE.bus.publish("desks.changed", {})
        _notify_desks()
        office_changed.bump("rooms")
        return out
    if action == "pin.set":
        out = office.set_pin(str(body.get("key") or ""), str(body.get("value") or ""), who)
        office_changed.bump("pins", "problems")                 # Hermes 버전 비교 띠가 핀을 쓴다. 관리자에게만 보이는 값이라 admin 번호만 오른다
        return out
    if action == "check":
        return {"ok": True, **office.run_checks(reg.pods)}
    raise ValueError(tr("알 수 없는 요청", "Unknown request"))


def _channels(pod: Pod):
    return _cached(f"{pod.id}:channels", 30, lambda: channels.collect(pod.hermes_home, pod.container))


def _models(pod: Pod):
    return _cached(f"{pod.id}:models", 60, lambda: models.collect(_health(pod), home=pod.hermes_home))


def _agents(pod: Pod) -> list[dict]:
    """채팅 목록에 보일 에이전트(프로파일). 이름·한 줄 소개·게이트웨이 상태·마지막 활동·실패 수."""
    def build():
        import yaml
        health = _health(pod)
        chan = {r["name"]: r for r in _channels(pod)["profiles"]}
        act = {p["name"]: p for p in _cached(f"{pod.id}:activity7", 60, lambda: activity.collect(7, home=pod.hermes_home))["profiles"]}
        out = []
        profs = cron_health.hr.profiles(pod.hermes_home)
        # 프로파일마다 두 파일을 하나씩 읽지 않고 한 번에 읽는다 — 사이드카에서는 read 요청 하나다(스펙 2026-10-24-002 R5)
        texts = readers.read_texts([prof.path / n for prof in profs for n in ("SOUL.md", "profile.yaml")])
        for i, prof in enumerate(profs):
            title, desc = "", ""
            soul, meta_text = texts[2 * i], texts[2 * i + 1]
            first = (soul.lstrip().splitlines() or [""])[0]
            if first.startswith("#"):
                title = first.lstrip("# ").split("—")[0].strip()[:40]
            try:
                meta = yaml.safe_load(meta_text) or {}
                desc = " ".join(str(meta.get("description") or "").split())[:160] if isinstance(meta, dict) else ""
            except Exception:
                pass
            row = next((p for p in health["profiles"] if p["name"] == prof.name), {})
            out.append({"name": prof.name, "title": title, "description": desc,
                        "running": (chan.get(prof.name) or {}).get("running"),
                        "channels": [p["name"] for p in (chan.get(prof.name) or {}).get("platforms", [])
                                     if p["state"] == "connected" and not p["stale"] and p["name"] != "api_server"],
                        "last_activity": (act.get(prof.name) or {}).get("last_activity"),
                        "failed_jobs": row.get("failed_jobs", 0), "open_incidents": row.get("open_incidents", 0)})
        return out
    return _cached(f"{pod.id}:agents", 30, build)


def _attached_files(pod: Pod, paths) -> list[dict] | dict:
    """보낼 때 붙인 작업 폴더 경로를 사이드카로 확인해 [{name, size, path}] 로(재검토 O-8). 오류면 {code, path, error}.
    올린 파일만 받다가 작업 폴더 전체의 일반 파일로 넓혔다(스펙 2026-10-20-002 D1) — 서랍 「AI」 단추가 에이전트가 만든 파일도 붙인다.
    목록에서 숨기는 파일(점 파일·*.upload)은 outside(F3), 고른 파일이 한 파일 상한(MAX_FILE)을 넘으면 too_large(R11).
    올린 파일의 크기는 올릴 때 이미 봤다. 파일 하나에 대한 오류는 path 를 함께 준다 — 화면이 그 뱃지만 거절로 바꾼다(DD5)."""
    if not paths:
        return []
    if not isinstance(paths, list) or len(paths) > workspace.MAX_FILES_PER_MESSAGE:
        return {"code": "too_many", "error": tr("파일이 너무 많습니다", "Too many files")}
    ws = workspace_for(pod)
    if ws is None:
        return {"code": "unsupported", "error": tr("이 AI 에이전트 작업공간은 파일을 받지 않습니다", "This AI Agent Workspace does not accept files")}
    out = []
    for p in paths:
        p = str(p)
        if not workspace.in_workspace(p) or workspace.hidden(p):
            return {"code": "outside", "path": p, "error": tr("작업 폴더의 파일이 아닙니다", "Not a file in the workspace")}
        try:
            info = ws.check(p)
        except OSError:
            return {"code": "agent_unreachable", "error": tr("AI 에이전트 작업공간에 연결할 수 없습니다", "Cannot reach the AI Agent Workspace")}
        if not info.get("exists") or info.get("link") or info.get("type") != "file":
            if workspace.own_upload(p):
                return {"code": "file_missing", "path": p, "error": tr("올린 파일이 없습니다. 다시 올려 주세요", "The uploaded file is gone. Upload it again")}
            return {"code": "file_missing", "path": p, "error": tr("파일이 없습니다. 이미 지웠을 수 있습니다", "The file does not exist. It may have been deleted")}
        size = int(info.get("size") or 0)
        if size > workspace.MAX_FILE and not workspace.own_upload(p):
            mb = workspace.MAX_FILE // (1024 * 1024)
            return {"code": "too_large", "path": p, "limit": workspace.MAX_FILE,
                    "error": tr(f"{mb} MB 를 넘는 파일은 붙일 수 없습니다", f"Files over {mb} MB cannot be attached")}
        out.append({"name": p.rsplit("/", 1)[-1], "size": size, "path": p})
    return out


def _chat_default_of(pod: Pod) -> str:
    """이름 없이 온 채팅 요청이 열 프로파일: 채팅 기본(목록에 있을 때) → 주 프로파일(스펙 2026-10-19-001 R3)."""
    main = primary.primary_of(pod.id)
    try:
        names = [p.name for p in cron_health.hr.profiles(pod.hermes_home)]
    except (OSError, HermesError, AttributeError):                    # 목록을 못 읽으면 주 프로파일(지금처럼)
        return main
    return chat_default.resolve(pod.id, names, main) if chat_default.stored(pod.id) else main


def _chat_profile(pod: Pod, requested: str) -> str:
    """채팅 요청의 프로파일 이름. 루트(default)가 숨겨진 POD(주 에이전트 main)에서 default 나 빈 값으로 오면 주 에이전트로 본다.
    default 를 그대로 받으면 목록에 없어 「없는 프로파일」로 거절돼 화면이 막혔다(OMAI-1199). 다른 이름은 그대로 둔다."""
    name = requested or _chat_default_of(pod)
    if name == primary.ROOT and cron_policy.root_hidden(pod.id):
        return primary.primary_of(pod.id)
    return name


def _skill_targets(pod: Pod) -> list[str]:
    """새 스킬을 넣을 수 있는 프로파일 이름. 루트(default)가 숨겨진 POD(주 에이전트 main)에서는 default 를 뺀다(OMAI-1195).
    화면이 default(공용)를 기본으로 보내 「없는 프로파일입니다」로 거절됐다. 목록은 서버가 정하고 화면은 그대로 쓴다."""
    names = [p.name for p in cron_health.hr.profiles(pod.hermes_home)]
    if cron_policy.root_hidden(pod.id):
        names = [n for n in names if n != primary.ROOT]
    return names


def _skill_taken(pod: Pod, profile: str) -> set[str]:
    """그 프로파일에서 쓰는 스킬 이름(공용 포함). 새 스킬·올리기가 같은 이름을 거절하는 데 쓴다."""
    return {s["name"] for s in _skills(pod)["skills"] if s["profile"] in (profile, "default")}


def _upload_client():
    """파일이 든 묶음을 보낼 쿠버네티스 클라이언트. compose 에서는 None(시험이 바꿔 끼운다 — k8s.client 를 통째로 바꾸면 POD 목록이 흔들린다)."""
    return k8s.client()


def _may_upload(a, user, pod: Pod) -> bool:
    """스킬 zip 올리기는 관리자나 그 POD 의 주인이 한다(마켓 설치와 같은 규칙, 결정 R1·DR5). 새 스킬 만들기(관리자 전용)와 다르다."""
    return may_use_market("/api/market/install", pod, user, a.enabled, registry().is_admin(user))


def _chat_status(pod: Pod) -> dict:
    """채팅 화면의 상태. 프로파일·에이전트 목록은 사이드카로 읽는다 — 에이전트 파드가 다시 뜨는 동안 사이드카에 닿지 않으면
    500 이 아니라 목록 없이 「연결 없음」과 이유를 돌려준다(예전에는 몇 초 동안 HTTP 500, OKE 2026-10-12,
    aas-litellm-model-and-guardrail.md §10-5). 대시보드 연결 오류가 있으면 그것을 먼저 보인다."""
    out = hub(pod).status()
    ws = workspace_for(pod)
    out["files"] = bool(ws is not None and _safe_supported(ws))     # 이 서버가 대화 파일을 다루는가(화면은 참일 때만 첨부 단추, OMAI-1153)
    out["pod"] = pod.id                                              # 파일 주소의 pod 인자(R11)
    out["primary"] = primary.primary_of(pod.id)                      # 루트 default 가 숨겨진 POD 에서 화면이 default 를 주 에이전트로 바꾼다
    out["owner_name"] = _pod_owner_name(pod)                         # 프로파일 이름 옆에 누구의 것인지(2026-10-18-010)
    out["stt"] = bool(_stt_model())                                  # 음성 인식이 설정된 설치인가 — 거짓이면 화면이 마이크 단추를 숨긴다(2026-10-22-005 R2)
    from . import stt_stream                                          # 스트리밍 받아쓰기(OMAI-1554, 계약 §5). 거짓이면 화면은 일괄 경로만 쓴다
    out["stt_stream"] = stt_stream.enabled()                         # AAS_STT_STREAM_URL 이 있으면 참. 마이크 단추는 stt 가 참일 때만 보인다
    out["stt_stream_max_seconds"] = stt_stream.max_seconds()
    speech = tts.info()                                              # 읽어 주기(chat-reply-tts §3-8). 목록이 깨져도 예외 없이 거짓(리뷰 C1)
    out["tts"], out["tts_voices"] = speech["tts"], speech["voices"]
    try:
        out["profiles"] = [p.name for p in cron_health.hr.profiles(pod.hermes_home)]
        out["agents"] = _agents(pod)
        out["chat_default"] = chat_default.resolve(pod.id, out["profiles"], out["primary"])   # 채팅이 먼저 여는 프로파일(2026-10-19-001 R3)
    except (OSError, HermesError) as exc:              # SidecarError 는 OSError 다
        out.update(profiles=[], agents=[], connected=False,
                   error=out.get("error") or tr(f"AI 에이전트 작업공간에 연결할 수 없습니다: {redact(str(exc), 160)}",
                                                f"Cannot reach the AI Agent Workspace: {redact(str(exc), 160)}"))
    return out


def body_limit(path: str) -> int:
    """처리기의 본문 상한. 받아쓰기 경로만 크다(스펙 2026-10-22-005 §3-9)."""
    return TRANSCRIBE_MAX_BODY if path == TRANSCRIBE_PATH else MAX_BODY


def _stt_model() -> str:
    """차트 hermes.stt.model 이 넘긴 음성 인식 별칭(AAS_STT_MODEL). 비면 음성 입력을 쓰지 않는 설치다."""
    return os.environ.get("AAS_STT_MODEL", "").strip()


# Whisper 가 무음에 지어내는 한국어 글(띄어쓰기·문장부호를 걷은 꼴, 되풀이 포함). 2026-10-23 실측: GB10 Whisper(ko)에
# 3초 무음·조용한 방 잡음을 보내면 늘 「감사합니다.」, 사용자 마이크에서는 「안녕하세요」. Hermes 의 걸러내기
# (tools/voice_mode_transcript.py WHISPER_HALLUCINATIONS)는 영어 위주라 통과한다. 화면이 녹음 중 소리를 듣지 못했다고 알릴 때만
# 쓴다 — 실제로 말한 「감사합니다」는 지킨다(사용자 결정 2026-10-23, 스펙 2026-10-22-005 §8-12).
_SILENCE_HALLUCINATION = re.compile(
    # i18n-ignore: 화면 문구가 아니라 받아쓴 글과 대조하는 무음 환각 목록
    r"(?:감사합니다|고맙습니다|감사드립니다|안녕하세요|안녕히계세요|안녕히가세요|시청해주셔서(?:감사|고맙)(?:합|습|드립)니다"
    r"|구독과좋아요(?:부탁드립니다)?|좋아요와구독(?:부탁드립니다)?|다음영상에서만나요|다음시간에만나요|MBC뉴스\w*입니다|자막\w*|네|음|아)+")
_NOT_WORD = re.compile(r"[\s.,!?~…·'\"]+")


def _silence_hallucination(text: str) -> bool:
    """받아쓴 글 전체가 무음 환각 목록뿐인가."""
    core = _NOT_WORD.sub("", text)
    return bool(core) and _SILENCE_HALLUCINATION.fullmatch(core) is not None


_TRANSCRIBE_SLOTS: threading.BoundedSemaphore | None = None


def _transcribe_slots() -> threading.BoundedSemaphore:
    """받아쓰기 전용 동시 한도(AAS_TRANSCRIBE_SLOTS, 기본 8). 받아쓰기는 Hermes 를 오래 기다리므로 공용 스레드(AAS_THREADPOOL)를
    화면 요청에 남겨 둔다. 파일 전송 한도(files.SLOTS)와 같은 방식이다(R10)."""
    global _TRANSCRIBE_SLOTS
    if _TRANSCRIBE_SLOTS is None:
        try:
            n = max(1, int(os.environ.get("AAS_TRANSCRIBE_SLOTS", "8")))
        except ValueError:
            n = 8
        _TRANSCRIBE_SLOTS = threading.BoundedSemaphore(n)
    return _TRANSCRIBE_SLOTS


def _transcribe(pod: Pod, profile: str, root: bool, body: dict, who: str) -> tuple[dict, int]:
    """녹음 하나를 그 프로파일의 Hermes 로 받아쓴다(POST /api/audio/transcribe). (응답, 상태 코드).
    소리는 저장하지 않는다. 사용 기록에는 누가·어느 프로파일·몇 초만 남기고 받아쓴 글은 남기지 않는다(§3-9)."""
    if not _stt_model():
        return {"error": tr("음성 인식이 설정되지 않았습니다", "Speech recognition is not set up")}, 503
    mime = str(body.get("mime_type") or "")
    kind = mime.split(";", 1)[0].strip().lower()
    data_url = str(body.get("data_url") or "")
    head = data_url.split(",", 1)[0]
    if not (kind.startswith("audio/") or kind == "video/webm") or not data_url.startswith("data:") or "," not in data_url or ";base64" not in head:
        return {"error": tr("녹음 형식이 올바르지 않습니다", "The recording format is not valid")}, 400
    slots = _transcribe_slots()
    if not slots.acquire(blocking=False):
        return {"error": tr("지금 받아쓰기가 많습니다. 다시 시도를 눌러 주세요", "Too many transcriptions right now. Press Retry."), "busy": True}, 429
    try:
        out = HermesAPI(hub(pod).auth).call("POST", "/api/audio/transcribe", {"data_url": data_url, "mime_type": mime},
                                            None if root else {"profile": profile}, timeout=TRANSCRIBE_TIMEOUT)
    except HermesError as exc:
        print(f"받아쓰기 실패 ({pod.id}/{profile}): HTTP {exc.code} {redact(str(exc), 100)}", flush=True)   # i18n-ignore: 로그
        if exc.code == 504:
            return {"error": tr("받아쓰기가 시간 안에 끝나지 않았습니다", "Transcription did not finish in time")}, 504
        if exc.code == 503:
            return {"error": tr("AI 에이전트 작업공간에 연결할 수 없어 받아쓰지 못했습니다", "Could not reach the AI Agent Workspace to transcribe")}, 503
        return {"error": tr("음성 인식을 쓸 수 없습니다. 관리자에게 음성 인식 설정을 확인해 달라고 하세요",
                            "Speech recognition is not available. Ask an admin to check the speech recognition settings.")}, 502
    finally:
        slots.release()
    try:
        raw = float(body.get("seconds"))
        secs = f"{max(0, min(600, int(raw)))}s" if math.isfinite(raw) else ""
    except (TypeError, ValueError, OverflowError):
        secs = ""
    secs = secs or f"{len(data_url) * 3 // 4 // 1024}KB"                   # 화면이 길이를 안 보냈거나 이상한 값이면 크기로 남긴다
    store.log_usage("chat_transcribe", f"{who} {profile} {secs}", pod=pod.id)
    text = str((out or {}).get("transcript") or "")
    # heard 는 화면이 녹음 중 음량이 기준을 넘었는지다. 보내지 않는 옛 화면은 들은 것으로 본다
    if body.get("heard") is False and _silence_hallucination(text):
        return {"transcript": "", "silent": True}, 200
    return {"transcript": text}, 200


SPEAK_PATH = "/api/chat/speak"
TTS_PREVIEW_PATH = "/api/tts/preview"


def _speak_audio(text: str, voice: str, first: str, who: str, usage: str, pod_id: str = "") -> tuple[int, dict | bytes, dict]:
    """조각 하나를 합성한다(한도 → LiteLLM). (상태, JSON 이나 mp3 바이트, 덧붙일 헤더). 자리는 합성이 끝날 때까지 잡는다 —
    화면이 요청을 끊어도 이 스레드의 합성은 끝까지 가므로, 한 사람이 멈췄다 다시 눌러 자리를 다 쓰지 못한다(OV-M1)."""
    lim = tts.limits()
    busy = lim.acquire(who)
    if busy == "user":
        return 429, {"error": tr("이전 읽기를 마무리하는 중입니다", "Finishing the previous read-aloud"), "busy": "user"}, {}
    if busy:
        return 429, {"error": tr("지금 읽기 요청이 많습니다", "Too many read-aloud requests right now"), "busy": "slots"}, {}
    try:
        audio = tts.synthesize(text, voice, first)
    except tts.SpeakError as exc:
        print(f"읽어 주기 실패 ({who}): {exc.reason}", flush=True)   # i18n-ignore: 로그
        if exc.code == 504:
            return 504, {"error": tr("읽어 주기가 시간 안에 끝나지 않았습니다", "Read-aloud did not finish in time")}, {}
        if exc.code == 503:
            return 503, {"error": tr("음성 합성 서버에 연결할 수 없습니다", "Cannot reach the speech synthesis server")}, {}
        return 502, {"error": tr("읽어 주기를 쓸 수 없습니다. 관리자에게 음성 합성 설정을 확인해 달라고 하세요",
                                 "Read-aloud is not available. Ask an admin to check the speech synthesis settings.")}, {}
    finally:
        lim.release(who)
    store.log_usage("chat_speak", f"{who} {usage} {len(text)}", pod=pod_id)   # 누가·몇 글자만, 글은 남기지 않는다(§3-8)
    return 200, audio, {}


def _speak(pod_id: str, profile: str, body: dict, who: str) -> tuple[int, dict | bytes, dict]:
    """POST /api/chat/speak — 답 전체를 다듬고 나눠 part 번 조각의 mp3 를 돌려준다(chat-reply-tts §3-8).
    헤더 X-Speak-Parts(조각 수), 읽을 글을 6,000자에서 잘랐으면 X-Speak-Truncated: 1. 읽을 글이 없으면 204."""
    vs = tts.voices()
    if not (tts.model() and vs):
        return 404, {"error": tr("읽어 주기가 설정되지 않았습니다", "Read-aloud is not set up")}, {}
    text = body.get("text")
    if not isinstance(text, str):
        return 400, {"error": tr("읽을 글이 없습니다", "There is no text to read")}, {}
    if len(text) > tts.TEXT_MAX:
        return 400, {"error": tr(f"답이 너무 깁니다({tts.TEXT_MAX:,}자까지)", f"The reply is too long (up to {tts.TEXT_MAX:,} characters)")}, {}
    part = body.get("part", 0)
    if isinstance(part, bool) or not isinstance(part, int):
        return 400, {"error": tr("조각 번호가 올바르지 않습니다", "Invalid part number")}, {}
    chunks, truncated = tts.plan(text)
    headers = {"X-Speak-Parts": str(len(chunks)), **({"X-Speak-Truncated": "1"} if truncated else {})}
    if not chunks:
        return 204, b"", headers
    if not 0 <= part < len(chunks):
        return 400, {"error": tr("조각 번호가 범위 밖입니다", "Part number is out of range")}, headers
    voice = tts.resolve_voice(str(body.get("voice") or ""), vs)
    code, out, _ = _speak_audio(chunks[part], voice, vs[0]["id"], who, f"{profile} part{part}", pod_id)
    return code, out, headers


def _tts_preview(body: dict, who: str) -> tuple[int, dict | bytes, dict]:
    """POST /api/tts/preview {voice} — 그 목소리의 미리 듣기 글(AAS_TTS_VOICES 의 sample)만 읽는다. 자유 글·pod 없음, 한도 공유(R11)."""
    vs = tts.voices()
    if not (tts.model() and vs):
        return 404, {"error": tr("읽어 주기가 설정되지 않았습니다", "Read-aloud is not set up")}, {}
    wanted = str(body.get("voice") or "")
    v = next((x for x in vs if x["id"] == wanted), None)
    if v is None:
        return 400, {"error": tr("없는 목소리입니다", "Unknown voice")}, {}
    sample = tts.normalize(str(v.get("sample") or ""))[:tts.CHUNK_MAX * 3]
    if not sample:
        return 204, b"", {"X-Speak-Parts": "0"}
    code, out, _ = _speak_audio(sample, v["id"], vs[0]["id"], who, f"preview:{v['id']}")
    return code, out, ({"X-Speak-Parts": "1"} if code == 200 else {})


def _chat_pod(a, user, wanted: str) -> Pod | None:
    """채팅 요청이 고른 에이전트(pod 인자). 허용 목록(/api/pod 와 같은 기준)에 없으면 None — 부르는 쪽이 403 을 낸다.
    registry().pick 은 모르는 이름을 첫 에이전트로 바꾸므로 쓰지 않는다: 엉뚱한 에이전트와 대화하게 된다(스펙 2026-10-19-001 리뷰 D8)."""
    return next((p for p in registry().allowed(user, a.enabled) if p.id == wanted), None)


def _chat_pod_refusal(a, user, wanted: str) -> tuple[dict, int]:
    """_chat_pod 가 None 일 때의 답. 볼 수 있는 에이전트가 다시 뜨는 중(등록부에서 잠시 빠짐)이면 503 — 화면이 간격을 두고 다시 시도한다.
    403 으로 답하면 화면이 「다시 열지 못했습니다」로 바로 포기했다(OKE 2026-10-24, 스펙 2026-10-24-008)."""
    if any(p.id == wanted for p in registry().allowed(user, a.enabled, restarting=True)):
        return {"error": tr("AI 에이전트 작업공간이 다시 시작하는 중입니다. 1~2분쯤 뒤에 다시 시도해 주세요.",
                            "The AI Agent Workspace is restarting. Try again in a minute or two.")}, 503
    return {"error": tr("이 AI 에이전트 작업공간을 볼 수 없습니다", "You cannot see this AI Agent Workspace")}, 403


# 채팅 목록이 작업공간 하나를 기다리는 한도(초). 사이드카 한 번의 한도(10초)보다 짧아야 막힌 읽기 하나가 목록을 늘리지 않는다.
# 정상은 0.2~0.4초(OKE 2026-10-24). 스펙 2026-10-24-002 R2·D1
CHAT_GROUP_TIMEOUT = 8.0


def _chat_groups(reg: Registry, user, auth_enabled: bool, current: Pod) -> list[dict]:
    """채팅 목록의 에이전트별 묶음(스펙 2026-10-19-001 R2). 범위: 내가 주인인 것 + 관리자가 나눠 준 것 + 지금 에이전트(리뷰 D9).
    관리자는 허용 목록이 전체라 자기 것 + 지금 에이전트만 넣는다. 순서: 지금 에이전트 → 나머지는 에이전트 이름순(디자인 D5).
    에이전트별로 나란히 읽고, 한 에이전트가 실패해도 그 묶음만 오류다(섹션 4 P-1). 멈추거나 준비 중이라 등록부에 없는 내 에이전트도 묶음으로 보인다(디자인 D7)."""
    pods, names, mine = _my_agent_pods(reg, user, auth_enabled, current)
    team_ids = _team_pod_ids(reg, user, auth_enabled)

    def one(pod: Pod) -> dict:
        base = {"pod": pod.id, "name": names.get(pod.id, ""), "owner_name": _pod_owner_name(pod),
                "current": pod.id == current.id, "shared": not mine(pod) and pod.id != current.id, "team": pod.id in team_ids,
                "primary_ready": (_primary_view(pod) or {"ready": True})["ready"]}    # 거짓이면 묶음에 「준비 중」(디자인 D7)
        try:
            # 작업공간별 상태는 캐시로 하나만 읽는다(스펙 2026-10-24-002 검토 D3). map_pods 는 한도를 넘긴 작업의 결과만 버리고
            # 스레드는 계속 돌리므로, 요청마다 새로 읽으면 막힌 작업공간에 스레드가 쌓인다. 지난 값이 있으면 바로 쓴다
            return {**_cached(f"{pod.id}:chatstatus", 3, lambda: _chat_status(pod), stale_ok=False), **base, "state": "ok"}
        except Exception as exc:                                       # 한 에이전트를 못 읽어도 나머지 묶음은 보인다
            return failed(pod, base, str(exc))

    def failed(pod: Pod, base: dict, why: str) -> dict:
        return {**base, "state": "error", "agents": [], "sessions": [], "configured": False,
                "error": tr(f"AI 에이전트 작업공간에 연결할 수 없습니다: {redact(why, 160)}", f"Cannot reach the AI Agent Workspace: {redact(why, 160)}")}
    # 가장 느린 작업공간을 끝까지 기다리지 않는다 — 넘기면 그 묶음만 오류다(R2, OMAI-1459 에서 목록이 몇 분씩 걸렸다)
    got = collect_all.map_pods(pods, one, workers=max(1, min(8, len(pods))), timeout=CHAT_GROUP_TIMEOUT)
    groups = []
    for pod in pods:
        ok, value = got.get(pod.id, (False, tr("시간 초과", "Timed out")))
        groups.append(value if ok else failed(pod, {"pod": pod.id, "name": names.get(pod.id, ""), "owner_name": "", "current": pod.id == current.id,
                                                    "shared": not mine(pod) and pod.id != current.id, "team": pod.id in team_ids,
                                                    "primary_ready": True}, str(value)))
    return groups + [{**g, "agents": [], "sessions": [], "configured": False} for g in _offline_agent_groups(reg, user)]


def _chat_session_ttl() -> float:
    """세션 목록 자동 정리 기준(초). AAS_CHAT_SESSION_TTL_HOURS(기본 24, 0 이면 끔)."""
    try:
        return max(0.0, float(os.environ.get("AAS_CHAT_SESSION_TTL_HOURS", "24"))) * 3600
    except ValueError:
        return 24 * 3600


def _chat_sessions(reg: Registry, user, auth_enabled: bool, current: Pod) -> list[dict]:
    """채팅 세션 목록: 채팅 묶음과 같은 범위의 에이전트마다 이 서버에 열린 대화 세션(오피스 중계 제외).
    로그인이 켜져 있으면 내가 연 세션만. 상태(waiting·running·idle·closed)는 메모리에서 바로 읽어 Hermes 를 부르지 않는다."""
    pods, names, _mine = _my_agent_pods(reg, user, auth_enabled, current)
    by = str((user or {}).get("email") or "") if auth_enabled else None
    out = []
    for pod in pods:
        h = _hubs.get(pod.id)                              # 허브를 아직 만들지 않은 에이전트는 열린 세션이 없다(연결을 새로 열지 않는다)
        if h is None:
            continue
        for row in h.live_sessions(by):                    # 읽기만 한다 — 정리는 shared_tick 60초 블록(_prune_chat_hubs, 스펙 2026-11-05-005 D4)
            out.append({**row, "pod": pod.id, "agent_name": names.get(pod.id, "")})
    out.sort(key=lambda r: -r["last_at"])
    return out


def _chat_hidden(reg: Registry, user, auth_enabled: bool, current: Pod) -> tuple[list[str], list[str]]:
    """(내가 목록에서 닫은 세션 id, 닫은 대화의 Hermes 저장 번호).
    세션 id: 다른 기기에서 닫은 세션을 그 세션을 열고 있는 탭도 목록에서 빼게 한다(스펙 2026-11-05-005 7-6).
    저장 번호: 세션 칸 「완료」가 Hermes 저장 세션에서 거른다(스펙 2026-11-06-002 D2·E1). 정리·재시작 뒤에도 남도록 chat_hidden 표에서 읽는다.
    닫을 때 저장 번호를 아직 몰랐던 세션(첫 제목 전)은 여기서 알게 되면 그때 표에 쓴다.
    로그인이 꺼져 있으면 모두(표는 email ''). 사용자 단위 서버 고정(aas_u)이라 한 사용자의 세션은 이 서버 허브에 있다."""
    pods, _names, _mine = _my_agent_pods(reg, user, auth_enabled, current)
    by = str((user or {}).get("email") or "") if auth_enabled else None
    out = []
    for pod in pods:
        h = _hubs.get(pod.id)
        if h is None:
            continue
        late = []
        for sid, m in list(h.sessions.items()):
            if m.get("hidden") and not m.get("relay") and (by is None or m.get("by", "") == by):
                out.append(sid)
                if m.get("stored_id") and not m.get("hidden_saved"):
                    late.append(m["stored_id"])
                    m["hidden_saved"] = True
        if late:
            chat_hidden.hide(by or "", pod.id, late)
    stored = chat_hidden.stored_ids(by or "", [p.id for p in pods])
    return out, sorted({i for ids in stored.values() for i in ids})


def _sticky_attrs(secure: bool) -> str:
    return "; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000" + ("; Secure" if secure else "")


def _sticky_value(email: str) -> str:
    """aas_u 값: 이메일의 HMAC 앞 16자. 두 서버가 같은 비밀값(AAS_OIDC_CLIENT_SECRET)을 써서 같은 값을 낸다. 이메일 원문은 쿠키에 넣지 않는다.
    HMAC 의 키·접두어 "aas-u" 는 값 계산용이라 쿠키 이름을 바꿀 때 그대로 뒀다."""
    key = (os.environ.get("AAS_OIDC_CLIENT_SECRET") or "aas-u").encode()
    return hmac.new(key, b"aas-u:" + email.strip().lower().encode(), hashlib.sha256).hexdigest()[:16]


def _prune_chat_hubs() -> None:
    """이 서버의 채팅 허브마다 오래 쉬던 세션을 걷어내고 Hermes 세션도 닫는다(shared_tick 60초 블록). 한 허브가 실패해도 나머지는 한다."""
    ttl = _chat_session_ttl()
    for pod_id, h in list(_hubs.items()):
        try:
            h.prune(ttl)
        except Exception as exc:
            print(f"채팅 세션을 정리하지 못했습니다({pod_id}): {type(exc).__name__}", flush=True)   # i18n-ignore: 로그


def _my_agent_pods(reg: Registry, user, auth_enabled: bool, current: Pod) -> tuple[list, dict, object]:
    """채팅 묶음·모은 프로파일 목록이 함께 쓰는 범위(스펙 2026-10-19-001 리뷰 D9, 2026-10-19-018 A1): 내가 주인인 것 + 관리자가 나눠 준 것 + 지금 에이전트.
    관리자는 허용 목록이 전체라 자기 것 + 지금 에이전트만. 순서는 지금 에이전트 → 에이전트 이름순. 반환: (POD 목록, 에이전트 이름표, 주인 판정)."""
    admin = (not auth_enabled) or reg.is_admin(user)
    allowed = reg.allowed(user, auth_enabled)
    mine = lambda p: bool(user) and p.owned_by(user)                  # noqa: E731  주인 표시라 그대로
    # 로그인이 꺼진 구성(루프백 전용 compose)은 주인 개념이 없어 모든 에이전트를 넣는다
    pods = [p for p in allowed if not auth_enabled or p.id == current.id or mine(p) or not admin]
    names = _agent_names()
    label = lambda pid: (names.get(pid) or pid).lower()                # noqa: E731
    pods.sort(key=lambda p: (p.id != current.id, label(p.id)))
    return pods, names, mine


def _offline_agent_groups(reg: Registry, user) -> list[dict]:
    """등록부(Ready 파드)에 없는 내 에이전트: 멈춤·준비 중(디자인 D7). 채팅 묶음과 모은 프로파일 목록이 함께 쓴다."""
    seen = {p.id for p in reg.pods}
    email = str((user or {}).get("email") or "").lower()
    out = []
    for item in getattr(reg, "agents", None) or []:
        if item.get("name") in seen or not email or str(item.get("owner") or "").lower() != email:
            continue
        out.append({"pod": item["name"], "name": item.get("display_name") or "", "owner_name": "", "current": False, "shared": False,
                    "state": "stopped" if item.get("suspended") else "starting"})
    return out


# 모은 프로파일 목록에서 시간을 넘긴 에이전트와 그 시각(스펙 2026-10-19-018 리뷰 D6). 30초 동안은 다시 부르지 않는다 —
# map_pods 는 시간을 넘겨도 돌던 스레드를 멈추지 못해, 새로 고칠 때마다 Hermes 를 기다리는 스레드가 쌓였다
# 건너뛰는 것은 그 읽기가 아직 도는 동안만이다. 재기동 직후 첫 읽기(사이드카 묶음 받기, OKE 10~15초)는 뒤에서 끝나 캐시를 채우므로,
# 끝난 뒤에도 30초 동안 「응답 없음」을 내면 화면이 정상 자료를 받지 못했다(스펙 2026-11-02-002)
_PROFILES_ALL_TIMEOUT = 10.0
_PROFILES_ALL_QUIET = 30.0
_profiles_all_slow: dict[str, float] = {}
_profiles_all_reading: dict[str, int] = {}                 # 에이전트별 아직 도는 읽기 수


def _profiles_all(reg: Registry, user, auth_enabled: bool, current: Pod) -> dict:
    """프로파일 화면의 내 에이전트 전체 목록(스펙 2026-10-19-018 A1, 리뷰 D3·D4·D6). 범위는 채팅 묶음과 같다.
    줄마다 어느 에이전트의 것인지(pod·pod_name·pod_owner_name)와 그 에이전트의 주 프로파일·채팅 기본인지를 붙이고,
    에이전트별 정보(만들 권한·상한·주 프로파일·채팅 기본·전용 뱃지)는 groups 에 둔다. 한 에이전트가 실패하거나 10초를 넘기면 그 묶음만 error 다."""
    admin = (not auth_enabled) or reg.is_admin(user)
    pods, names, mine = _my_agent_pods(reg, user, auth_enabled, current)
    lang = i18n.get_lang()
    now = time.time()
    with _lock:
        quiet = {p.id for p in pods if now - _profiles_all_slow.get(p.id, 0) < _PROFILES_ALL_QUIET and p.id in _profiles_all_reading}

    def read(pod: Pod) -> list[dict]:
        i18n.set_lang(lang)                                        # map_pods 의 스레드는 요청 언어를 물려받지 않는다(리뷰 I5)
        with _lock:
            _profiles_all_reading[pod.id] = _profiles_all_reading.get(pod.id, 0) + 1
        try:
            rows = _visible_profile_rows(pod, admin)
            can = may_use_market("/api/market/install", pod, user, auth_enabled, admin)
            return issue_acks.apply(pod.id, _with_market_issues(pod, rows) if can else rows, can)   # 스킬 새 버전은 올릴 수 있는 사람에게만(R7). 확인한 주의·안내는 뺀다
        finally:
            with _lock:
                left = _profiles_all_reading.pop(pod.id, 1) - 1
                if left > 0:
                    _profiles_all_reading[pod.id] = left
    got = collect_all.map_pods([p for p in pods if p.id not in quiet], read, timeout=_PROFILES_ALL_TIMEOUT)
    rows, groups = [], []
    for pod in pods:
        owner = _manages_pod(pod, user, auth_enabled)             # 만들기·편집 권한: 주인과 팀 관리자
        shared = not mine(pod) and pod.id != current.id
        base = {"pod": pod.id, "name": names.get(pod.id, ""), "owner_name": _pod_owner_name(pod), "current": pod.id == current.id,
                "shared": shared, "can_create": admin or owner}
        ok, value = got.get(pod.id, (False, None))
        if not ok:
            timed = isinstance(value, str) and value.startswith(tr("시간 초과", "Timed out"))     # map_pods 가 요청 스레드에서 만든 시간 초과 문구
            if timed:
                _profiles_all_slow[pod.id] = now
            if timed or pod.id in quiet:
                why = tr("응답 없음", "Not responding")
            else:
                why = tr(f"AI 에이전트 작업공간에 연결할 수 없습니다: {redact(str(value), 160)}", f"Cannot reach the AI Agent Workspace: {redact(str(value), 160)}")
            groups.append({**base, "state": "error", "error": why})
            continue
        _profiles_all_slow.pop(pod.id, None)
        main = primary.primary_of(pod.id)
        # 숨긴 루트(default)는 관리자에게도 줄로 보이지 않는다(사용자 2026-10-19, 2026-10-14-003 리뷰 D8 「관리자에게만 루트(숨김) 읽기 전용」을
        # 모은 목록에서 번복). 에이전트마다 「사용 금지」 줄이 하나씩 붙어 목록이 길어졌다. 상한 개수는 원래 규칙대로 전체 이름으로 센다
        shown = [r for r in value if not r.get("hidden_root")]
        first = chat_default.resolve(pod.id, [r["name"] for r in shown], main)
        group = {**base, "state": "ok", "primary": main, "chat_default": first, "count": len(shown), **_owner_badge(pod, _owns_pod(pod, user, auth_enabled), admin)}   # 뱃지는 주인 표시라 그대로
        if owner and not admin:                                    # 주인에게는 상한과 지금 개수(스펙 2026-10-15-011 D5)
            group["profile_limit"] = {"used": owner_guard.profile_count([r["name"] for r in value], cron_policy.root_hidden(pod.id)),
                                      "max": owner_guard.profile_limit()}
        groups.append(group)
        for r in shown:
            rows.append({**r, "pod": pod.id, "pod_name": base["name"], "pod_owner_name": base["owner_name"] if shared else "",
                         "primary": r["name"] == main, "chat_default": r["name"] == first})
    groups += _offline_agent_groups(reg, user)
    return {"profiles": rows, "groups": groups, "can_edit": admin, "default_model": profiles.default_model()}


class _HubApi:
    """그 POD 의 지금 대시보드 연결로 Hermes API 를 부른다. 계정이 바뀌어 허브가 새로 만들어져도 따라간다."""

    def __init__(self, pod: Pod):
        self.pod = pod

    @property
    def auth(self):
        return hub(self.pod).auth

    def call(self, *args, **kwargs):
        return HermesAPI(hub(self.pod).auth).call(*args, **kwargs)


_ws_lock = threading.Lock()
_workspaces: dict[str, "workspace.Workspace"] = {}


def workspace_for(pod: Pod):
    """POD 의 대화 작업 폴더(OMAI-1153). 사이드카로 읽는 POD(쿠버네티스·compose)만 — 로컬 폴더 POD 는 None."""
    home = pod.hermes_home
    if not isinstance(home, readers.RemotePath):
        return None
    with _ws_lock:
        ws = _workspaces.get(pod.id)
        if ws is None or ws.backend is not home.backend:
            ws = _workspaces[pod.id] = workspace.Workspace(home.backend, _HubApi(pod))
        return ws


def _safe_supported(ws) -> bool:
    try:
        return ws.supported()
    except Exception:
        return False


def hub(pod: Pod) -> ChatHub:
    """Pod 한 곳의 대시보드 연결. 쿠버네티스 Pod 는 계정을 Secret 에서 읽고(짧게 캐시), 같은 이름으로 다시 만들어져 계정이 바뀌면 새로 만든다.
    그 밖(compose·파일 등록부)은 환경변수 이름에서 처음 만들 때 한 번 읽는다."""
    secret_mode = bool(pod.credentials_secret)
    creds = credentials.dashboard(pod) if secret_mode else None
    with _lock:
        have = _hubs.get(pod.id)
        if secret_mode and have is not None and (have.settings["user"], have.settings["password"], have.settings["url"]) != (*creds, pod.dashboard_url):
            _hubs.pop(pod.id)
        if pod.id not in _hubs:
            base = load_settings()
            user, password = creds or (_env(pod.dashboard_user_env), _env(pod.dashboard_password_env))
            _hubs[pod.id] = ChatHub({"url": pod.dashboard_url, "provider": base["provider"], "user": user, "password": password})
            # 대화 작업 폴더(OMAI-1153). 판 확인은 여기서 하지 않는다(잠금 안에서 사이드카를 기다리지 않게) —
            # 옛 사이드카면 목록 비교가 실패해 칩만 건너뛰고, 작업 폴더(Hermes mkdir·cwd)는 그대로 쓴다
            _hubs[pod.id].workspace = workspace_for(pod)
            _hubs[pod.id].listeners.append(lambda sid, profile, etype, payload, pid=pod.id: OFFICE.tracker.on_chat(sid, pid, profile, etype, payload))
            _hubs[pod.id].listeners.append(
                lambda sid, profile, etype, payload, pid=pod.id, owner=(pod.owner or ""):
                INBOX.on_chat(pid, sid, OFFICE.tracker.alias_of(pid, profile) or str(profile or ""), owner, etype, payload))
        return _hubs[pod.id]


def ws_enabled() -> bool:
    """브라우저가 웹소켓(/ws)을 쓰는가(AAS_WS, 기본 켜짐 — OMAI-1100). off 면 HTTP 폴링·SSE 로 읽는다."""
    return config.get("AAS_WS", "on").strip().lower() not in ("0", "off", "false", "no")


# ---- 서버가 직접 그리는 화면(로그인·로그아웃·안내) --------------------------------------------
# COP·Observ 와 같은 가운데 카드(OMAI-1128, 스펙 2026-10-14-001). 색은 DESIGN.md·Observ 로그인과 같은 값이다.
# 어두운 테마가 기본이다. 콘솔(ThemeMode.tsx readMode)도 고른 값이 없으면 다크라서 같게 맞췄다(OMAI-1245: 콘솔은 다크인데 이 화면만 OS 설정을 따라 흰 배경이었다). 에어갭: 글꼴·그림·CSS 를 밖에서 받지 않는다(로고 SVG·CSS 를 HTML 안에 넣는다).
# 로고는 설치 브랜드(PRODUCT_NAME, OPENMARU·MSAP·AINP)를 따른다. 사본은 ui/scripts/brand-logo-inline.mjs 가 만든다(OMAI-1299, 스펙 2026-10-17-013)
_LOGOS = {k: (Path(__file__).parent / "brand" / brand.of(k).logo_file).read_text(encoding="utf-8").split("\n", 1)[1].strip() for k in brand.KEYS}
# 테마는 콘솔의 테마 단추가 localStorage 'aas-theme'(light|dark)에 저장한 값을 따른다(THEME_KEY, ui/src/components/ThemeMode.tsx). 고른 값이 없으면 다크다.
# 브라우저·OS 설정(prefers-color-scheme)은 보지 않는다(콘솔이 보지 않으므로). 같은 주소(origin)라 로그인·로그아웃·준비 중 화면도 그 값을 읽을 수 있다.
_THEME_KEY = "aas-theme"
_THEME_LIGHT = ("color-scheme:light;--bg:#edeef2;--card:#fff;--line:#e5e7eb;--fg:#111827;--muted:#6b7280;--faint:#9ca3af;"
                "--field:rgba(17,24,39,.03);--field-line:rgba(17,24,39,.14);--field-focus:rgba(17,24,39,.45);--wash:rgba(17,24,39,.04);"
                "--shadow:0 8px 32px rgba(0,0,0,.06)")
_BRAND = "--brand:#DA291C;--brand-hover:#B01E0A;--ring:0 0 0 2px var(--card),0 0 0 4px #DA291C"   # 두 테마가 같다
_THEME_DARK = ("color-scheme:dark;--bg:#08090a;--card:#0f1011;--line:rgba(255,255,255,.08);--fg:#f7f8f8;"
               "--muted:#8a8f98;--faint:#62666d;--field:rgba(255,255,255,.04);--field-line:rgba(255,255,255,.10);--field-focus:rgba(255,255,255,.35);"
               "--wash:rgba(255,255,255,.04);--shadow:0 20px 60px rgba(0,0,0,.5)")


def _dark_notice(scope: str) -> str:
    """어두운 테마의 알림 글자색(성공·오류). scope 는 이 규칙이 걸릴 :root 조건이다."""
    return f"{scope} .notice.ok{{color:#10b981}}{scope} .notice.error{{color:#ef5350}}"


_THEME_SCRIPT = (f"<script>try{{var t=localStorage.getItem('{_THEME_KEY}');if(t==='light'||t==='dark')"
                 "document.documentElement.setAttribute('data-theme',t)}catch(e){}</script>")
_NOT_LIGHT = ":root:not([data-theme=light])"
_PAGE_CSS = (
    ":root{" + _THEME_DARK + ";" + _BRAND + "}" + _dark_notice(_NOT_LIGHT) + "\n"   # 고른 테마가 없으면 다크
    ":root[data-theme=light]{" + _THEME_LIGHT + ";" + _BRAND + "}\n"                  # 밝게 골랐을 때만 밝다
) + """
*{box-sizing:border-box}
html,body{margin:0;min-height:100%}
body{min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:20px;padding:24px 16px;
background:var(--bg);color:var(--fg);font:14px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI","Noto Sans KR","Apple SD Gothic Neo","Malgun Gothic",sans-serif;
-webkit-font-smoothing:antialiased}
.card{width:100%;max-width:400px;background:var(--card);border:1px solid var(--line);border-top:2px solid var(--brand);border-radius:12px;
box-shadow:var(--shadow);padding:36px 28px 28px}
.brand{display:flex;flex-direction:column;align-items:center;gap:6px;margin-bottom:24px;color:var(--fg)}
.brand-logo{height:40px;width:auto;max-width:100%}
.product{font-size:16px;font-weight:700;letter-spacing:.02em;color:var(--fg)}
.product-full{margin-top:-5px;font-size:12px;letter-spacing:.03em;color:var(--faint)}
.product-full b{font-weight:600;color:var(--muted)}
h1{font-size:17px;font-weight:600;line-height:1.4;margin:0 0 4px;text-align:center}
.sub{font-size:12.5px;color:var(--muted);text-align:center;margin:0 0 20px}
.body{font-size:13.5px}
.body p{margin:0 0 12px}
[hidden]{display:none!important}
.notice{display:flex;gap:8px;align-items:flex-start;padding:10px 12px;border-radius:6px;font-size:12.5px;margin-bottom:16px;border:1px solid}
.notice.ok{background:rgba(16,185,129,.08);border-color:rgba(16,185,129,.2);color:#047857}
.notice.error{background:rgba(218,41,28,.08);border-color:rgba(218,41,28,.2);color:#b91c1c}
form{display:grid;gap:14px}
label{display:grid;gap:6px;font-size:12px;font-weight:500;color:var(--muted)}
input[type=email],input[type=password]{width:100%;height:38px;padding:0 12px;border-radius:6px;border:1px solid var(--field-line);
background:var(--field);color:var(--fg);font:inherit;font-size:13.5px;outline:none;transition:border-color .15s,box-shadow .15s}
input:focus{border-color:var(--field-focus);box-shadow:0 0 0 3px var(--wash)}
.btn{display:flex;align-items:center;justify-content:center;gap:8px;width:100%;height:40px;border-radius:6px;font:inherit;font-size:13.5px;
font-weight:600;text-decoration:none;cursor:pointer;transition:background .15s,border-color .15s}
.btn-primary{background:var(--brand);color:#fff;border:1px solid var(--brand)}
.btn-primary:hover{background:var(--brand-hover);border-color:var(--brand-hover)}
.btn-secondary{background:var(--wash);color:var(--fg);border:1px solid var(--field-line)}
.btn-secondary:hover{border-color:var(--field-focus)}
.btn:focus-visible{outline:none;box-shadow:var(--ring)}
.btn svg{width:16px;height:16px;flex:none}
.or{display:flex;align-items:center;gap:10px;margin:16px 0;font-size:11.5px;color:var(--faint)}
.or::before,.or::after{content:"";flex:1;height:1px;background:var(--line)}
.body .hint{margin:14px 0 0;font-size:12px;color:var(--faint);text-align:center}
.body .tagline{margin:20px 0 0;font-size:12px;font-weight:600;letter-spacing:.01em;color:var(--faint);text-align:center}
.prefs{display:flex;justify-content:center;gap:8px;margin-top:12px}
.pref{display:inline-flex;align-items:center;height:28px;padding:0 10px;border-radius:6px;border:1px solid var(--field-line);background:var(--wash);color:var(--muted);font:inherit;font-size:12px;cursor:pointer;transition:border-color .15s,color .15s}
.pref:hover{border-color:var(--field-focus);color:var(--fg)}
.pref:focus-visible{outline:none;box-shadow:var(--ring)}
.theme span{display:inline-flex;align-items:center;gap:6px}.theme svg{width:14px;height:14px}
.theme .to-dark,:root[data-theme=light] .theme .to-light{display:none}:root[data-theme=light] .theme .to-dark{display:inline-flex}
.foot{font-size:11.5px;color:var(--faint);text-align:center}
.foot a{color:inherit;text-decoration:none}.foot a:hover{text-decoration:underline}
@media (max-width:480px){.card{padding:28px 20px 22px}.brand-logo{height:32px}}
"""


def _index_html(raw: bytes) -> bytes:
    """콘솔 화면(index.html)에 설치 브랜드를 넣는다 — Observ 와 같이 <head> 바로 뒤에 window.__RUNTIME_CONFIG__ 를, 탭 첫 제목은 브랜드 이름으로.
    로그인 전에는 /api/me 를 못 쓰고 첫 그리기에 로고가 바뀌어 보이지 않게 하려고 HTML 에 직접 넣는다. 매 응답 원본에서 만든다(OMAI-1299)."""
    b = brand.current()
    cfg = _js_json({"PRODUCT_NAME": b.env_value})                 # 값은 정해진 셋이지만 </script> 로 닫히지 않게
    text = raw.decode("utf-8")
    text = text.replace("<head>", f"<head><script>window.__RUNTIME_CONFIG__={cfg};</script>", 1)
    text = re.sub(r"<title>[^<]*</title>", f"<title>{html.escape(b.full)}</title>", text, count=1)
    return text.encode("utf-8")


# ---- 서버 페이지의 공지 띠(스펙 2026-10-24-007 4-5·6D·R5·R10) ----------------------------------------------------------------
# 작업공간이 없어 서버가 그리는 「준비 중」·「연결된 작업공간 없음」 페이지 맨 위에 고정한다. 색은 React 띠(shellTokens.noticeTokens)와 같은 값.
# 클래스·변수는 .aas-nbar-*·--nbar-* (기존 .notice 와 겹치지 않게, E5). live 영역은 두지 않는다(5초 다시 불러오기에 되풀이하지 않게)
NBAR_MAX = 3
_NBAR_CSS = """
.aas-nbar{position:fixed;top:0;left:0;right:0;z-index:10}
.aas-nbar-row{display:flex;flex-wrap:wrap;gap:4px 10px;align-items:baseline;min-height:36px;padding:8px 24px;font-size:13px;line-height:20px;
background:var(--nbar-bg);color:var(--nbar-fg);border-bottom:1px solid rgba(255,255,255,.08)}
.aas-nbar-row.high{--nbar-bg:#DA291C;--nbar-fg:#fff;--nbar-icon:#fff}
.aas-nbar-row.mid{--nbar-bg:linear-gradient(rgba(245,158,11,.15),rgba(245,158,11,.15)),#0f1011;--nbar-fg:#f7f8f8;--nbar-icon:#f59e0b;
border-bottom-color:rgba(245,158,11,.35)}
.aas-nbar-row.low{--nbar-bg:linear-gradient(rgba(255,255,255,.04),rgba(255,255,255,.04)),#0f1011;--nbar-fg:#d0d6e0;--nbar-icon:#60a5fa}
.aas-nbar-row.feature{--nbar-icon:#27a644}
.aas-nbar-kind{font-size:11px;font-weight:500;color:var(--nbar-icon)}
.aas-nbar-title{font-weight:700}
.aas-nbar-when{font-size:12px;opacity:.85}
.aas-nbar-row a{color:inherit;text-decoration:underline}
.aas-nbar-more{min-height:28px;padding:4px 24px;font-size:12px;background:#0f1011;color:#d0d6e0;border-bottom:1px solid rgba(255,255,255,.08)}
@media (max-width:600px){.aas-nbar-row,.aas-nbar-more{padding-left:8px;padding-right:8px}}
"""
# 시각은 브라우저 언어·시간대의 Intl 기본 꼴로 바꾸고(R10), 띠 높이만큼 본문을 내린다. 스크립트가 없으면 UTC 오프셋이 붙은 글자가 그대로 보인다
_NBAR_SCRIPT = ("<script>(function(){var b=document.querySelector('.aas-nbar');if(!b)return;try{var f=new Intl.DateTimeFormat(document.documentElement.lang||undefined,"
                "{dateStyle:'medium',timeStyle:'short'});Array.prototype.forEach.call(b.querySelectorAll('time'),function(t){var d=new Date(t.getAttribute('datetime'));"
                "if(!isNaN(d))t.textContent=f.format(d)})}catch(e){}document.body.style.paddingTop=(b.offsetHeight+24)+'px'})();</script>")


def _nbar_kinds() -> dict[str, tuple[str, str]]:
    """종류 → (세기 클래스, 보이는 종류 이름). 색만으로 종류를 알리지 않게 이름을 함께 쓴다(1B)."""
    return {"outage": ("high", tr("장애", "Outage")), "maintenance": ("mid", tr("점검", "Maintenance")),
            "deprecation": ("mid", tr("중단 예정", "Deprecation")), "feature": ("low feature", tr("새 기능", "New")),
            "info": ("low", tr("안내", "Info"))}


def _nbar_time(iso: str) -> str:
    try:
        text = datetime.fromisoformat(iso).strftime("%Y-%m-%d %H:%M UTC%z")
        text = text[:-2] + ":" + text[-2:]                   # UTC+0000 → UTC+00:00
    except ValueError:
        text = iso
    return f"<time datetime='{html.escape(iso, quote=True)}'>{html.escape(text)}</time>"


def _notice_band(rows: list[dict]) -> str:
    """공지 띠 HTML. 글은 줄바꿈해 다 보이고(E6), AAS 안 경로(#/) 「바로 가기」는 뺀다(작업공간이 없으면 갈 수 없다)."""
    if not rows:
        return ""
    kinds, out = _nbar_kinds(), []
    for n in rows[:NBAR_MAX]:
        cls, name = kinds.get(n["kind"], ("low", n["kind"]))
        link = n.get("link") or ""
        go = (f" <a href='{html.escape(link, quote=True)}' target=_blank rel=noopener>{tr('바로 가기', 'Open')}</a>"
              if link.lower().startswith(("http://", "https://")) else "")
        body = f"<span>{html.escape(n['body'])}</span>" if n.get("body") else ""
        out.append(f"<div class='aas-nbar-row {cls}'><span class=aas-nbar-kind>{html.escape(name)} ·</span>"
                   f"<span class=aas-nbar-title>{html.escape(n['title'])}</span>{body}"
                   f"<span class=aas-nbar-when>{_nbar_time(n['starts_at'])} ~ {_nbar_time(n['ends_at'])}</span>{go}</div>")
    if len(rows) > NBAR_MAX:
        out.append(f"<div class=aas-nbar-more>{tr(f'외 {len(rows) - NBAR_MAX}개', f'{len(rows) - NBAR_MAX} more')}</div>")
    return f"<aside class=aas-nbar aria-label='{tr('공지', 'Notices')}'>{''.join(out)}</aside>"


def _user_notices(a, user) -> list[dict]:
    """이 사람에게 지금 보일 공지(사람에게 가는 칸만). 로그인을 끈 실행은 전체 공지만(4-3). 읽기가 실패해도 페이지와 /api/me 는 그대로 낸다."""
    try:
        return notices.for_user((user or {}).get("email", "") if a.enabled else "", settings.departments() if a.enabled else {})
    except Exception as exc:                                       # noqa: BLE001 — 공지는 덧붙이는 것이라 실패해도 본 응답을 막지 않는다(E6)
        print(f"공지 읽기 실패: {type(exc).__name__}", flush=True)   # i18n-ignore: 로그
        return []


# 제품명 풀이(사용자 지시 2026-10-30, 풀이는 버전 정보 창 about.tagline 과 같은 「AI Agent Studio」). 머리글자만 진하게 해 약어가 어디서 왔는지 보인다
_PRODUCT_FULL = "<span class=product-full><b>A</b>I <b>A</b>gent <b>S</b>tudio</span>"
# 탭 아이콘. 콘솔(ui/index.html)과 같은 인라인 SVG — 파일을 받지 않아 에어갭에서도 뜬다. 시험이 두 값이 같은지 본다(스펙 2026-10-14-001 §13)
_FAVICON = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='-0.6 -16.9 79.6 79.6'%3E%3Cg fill='%23e60012'%3E%3Cpath d='M32.94,3.92C31.61,1.54,29.18.12,26.46.12h0c-2.72,0-5.15,1.42-6.49,3.79L.65,38.29c-.88,1.56-.86,3.42.04,4.96.9,1.55,2.51,2.47,4.31,2.47h11.15c2.67,0,5.07-1.38,6.42-3.68,1.35-2.3,1.38-5.07.07-7.4l-5.33-9.5c-.77-1.38-.77-3.09,0-4.46.82-1.46,2.3-2.33,3.98-2.33s3.16.87,3.98,2.33l11.96,21.25c1.31,2.34,3.8,3.79,6.49,3.79s5.07-1.38,6.42-3.68,1.38-5.07.07-7.4L32.94,3.92Z'/%3E%3Cpath d='M77.53,34.34l-7.9-14.08c-1.87-3.34-6.03-4.55-9.45-2.82-.11.06-.22.11-.34.17-3.72,1.82-5.23,6.3-3.21,9.91l7.92,14.11c1.38,2.46,3.95,4.14,6.77,4.1,2.56-.04,4.86-1.34,6.21-3.51,1.48-2.38,1.37-5.43,0-7.87Z'/%3E%3Ccircle cx='53.93' cy='7.53' r='7.41'/%3E%3C/g%3E%3C/svg%3E"
_COMPANY_LINK = "<a href=https://www.openmaru.io/ target=_blank rel=noopener>https://www.openmaru.io/</a>"   # 바닥글 회사 주소. 색은 바닥글 글자색 그대로(.foot a)


def _page(title: str, body: str, sub: str = "", script: str = "", notices: list[dict] | None = None, heading: str = "") -> bytes:
    """서버가 직접 그리는 화면의 틀. 로그인 화면과 안내 화면(로그인할 수 없음·에이전트 준비 중 등)이 함께 쓴다.
    notices 를 주면 맨 위에 공지 띠를 고정한다(작업공간이 없는 사람의 안내 페이지만, 로그인 화면은 주지 않는다).
    heading 을 주면 카드 제목만 그것으로 쓰고 탭 제목은 title 그대로다(로그인 화면의 환영 문구)."""
    sub_html = f"<p class=sub>{html.escape(sub)}</p>" if sub else ""
    band = _notice_band(notices or [])
    top = (f" style='padding-top:{24 + 36 * min(len(notices or []), NBAR_MAX) + (28 if len(notices or []) > NBAR_MAX else 0)}px;justify-content:flex-start'"
           if band else "")
    return (f"<!doctype html><html lang={i18n.get_lang()}><meta charset=utf-8><meta name=viewport content='width=device-width,"
            f"initial-scale=1'><meta name=color-scheme content='light dark'><title>{html.escape(title)} — AAS</title>"
            f"<link rel=icon href=\"{_FAVICON}\">{_THEME_SCRIPT}<style>{_PAGE_CSS}{_NBAR_CSS if band else ''}</style><body{top}>{band}<main class=card><div class=brand>{_LOGOS[brand.current().key]}<span class=product>AAS</span>{_PRODUCT_FULL}</div>"
            f"<h1>{html.escape(heading or title)}</h1>{sub_html}<div class=body>{body}</div></main>"
            # 저작권 표기의 회사 주소는 누르면 새 창으로 여는 링크다(사용자 지시 2026-10-30). 화면을 열 때 받아 오는 것이 아니라 에어갭에서도 페이지는 그대로 뜬다
            f"<footer class=foot>Copyright (c) 2026. OPENMARU, Inc. · {_COMPANY_LINK}</footer>{script}{_NBAR_SCRIPT if band else ''}</body></html>").encode()


# SSO 단추를 누르면 팝업 창에서 로그인한다(COP Console 처럼, 스펙 2026-10-15-019). 팝업이 막히거나 스크립트가 없으면 단추가 링크라 같은 창에서 이동한다.
# 끝난 것은 팝업이 보내는 메시지(같은 출처만 믿는다)와, 열려 있는 동안 1초마다 /api/me 로 세션이 생겼는지 보는 것 두 가지로 알아챈다
# (인증 공급자 화면이 창 사이의 연결(opener)을 끊어도 되게).
_POPUP_SCRIPT = """<script>(function(){var a=document.getElementById('sso');if(!a||!window.open)return;var next=a.getAttribute('data-next')||'/',pop=null,timer=null;
function done(){if(timer)clearInterval(timer);location.replace(next)}
function check(){return fetch('/api/me',{credentials:'same-origin',cache:'no-store'}).then(function(r){if(r.ok)done();return r.ok}).catch(function(){return false})}
addEventListener('message',function(e){if(e.origin===location.origin&&e.data&&e.data.aasLogin==='ok')done()});
a.addEventListener('click',function(ev){if(ev.ctrlKey||ev.metaKey||ev.shiftKey||ev.button)return;ev.preventDefault();
var w=520,h=700,l=Math.max(0,screenX+(outerWidth-w)/2),t=Math.max(0,screenY+(outerHeight-h)/3);
pop=window.open(a.href+'&popup=1','aas-login','popup=yes,width='+w+',height='+h+',left='+l+',top='+t);
if(!pop){location.href=a.href;return}
a.setAttribute('aria-busy','true');if(timer)clearInterval(timer);
timer=setInterval(function(){check();if(pop.closed){clearInterval(timer);timer=null;a.removeAttribute('aria-busy');check()}},1000)})})();</script>"""

# 팝업 로그인이 끝나면 팝업에 주는 화면: 원래 창에 알리고 닫는다. 닫히지 않으면(창을 스크립트가 열지 않은 경우) 링크로 이어 간다.
def _popup_done(next_path: str) -> bytes:
    link = html.escape(next_path, quote=True)
    return _page(tr("로그인했습니다", "Signed in"),
                 f"<p>{tr('이 창은 곧 닫힙니다.', 'This window closes now.')}</p><p><a href='{link}'>{tr('닫히지 않으면 여기를 누르세요', 'Click here if it does not close')}</a></p>",
                 script="<script>try{if(window.opener)window.opener.postMessage({aasLogin:'ok'},location.origin)}catch(e){}window.close()</script>")


# ---- MCP 서버 OAuth 로그인 팝업(스펙 2026-10-16-010 4-1·11-4, OMAI-1263) ----------------------------------------------------
def _js_json(obj) -> str:
    """스크립트 안에 넣는 JSON(</script> 로 끊기지 않게 < 를 바꾼다)."""
    return json.dumps(obj, ensure_ascii=False).replace("<", "\\u003c")


def _mcp_tab_link(profile: str, server: str) -> str:
    return "/#/profiles?" + urlencode({"name": profile, "pane": "tools", "server": server})


def _mcp_oauth_target(a, user, pod_id: str, profile: str):
    """(pod, Hermes API 의 profile 값). 그 에이전트의 주인과 관리자만(9절 Q2). 주인은 숨긴 루트를 못 만진다. 아니면 RelayError."""
    pod = next((p for p in registry().pods if p.id == pod_id), None)
    if pod is None:
        raise mcp_oauth_relay.RelayError(tr("없는 AI 에이전트 작업공간입니다", "That AI Agent Workspace does not exist"), 404, reason="no_pod")
    refused = content_gate(pod, user, a.enabled, registry().is_admin(user), profile)
    if refused:
        raise mcp_oauth_relay.RelayError(refused, 403, reason="forbidden")
    row = next((r for r in _profile_rows(pod) if r["name"] == profile), None)
    if row is None:
        raise mcp_oauth_relay.RelayError(tr("없는 프로파일입니다", "That profile does not exist"), 404, reason="no_profile")
    return pod, (None if row["is_default"] else profile)


_MCP_OAUTH_BTNS = "display:flex;gap:8px;justify-content:flex-end;margin-top:16px"


def _mcp_oauth_start_page(pod_id: str, profile: str, server: str, other_host: bool) -> bytes:
    """팝업 시작 화면(11-4 V8): 맥락 → 대기 → 인가 호스트 확인 → 「계속」. 누른 순간 열린 창이라 계속을 눌러도 팝업 차단과 상관없다."""
    msg = {"preparing": tr("로그인 화면을 준비하는 중", "Preparing the sign-in page"),
           "at": tr("{host} 에서 로그인합니다", "You will sign in at {host}"),
           "cancelled": tr("로그인을 취소했습니다. 이 창을 닫아도 됩니다.", "Sign-in cancelled. You can close this window."),
           "failed": tr("로그인을 시작하지 못했습니다", "Could not start the sign-in")}
    ctx = " · ".join(html.escape(x) for x in (pod_id, profile, server))
    other = (f"<p class=hint>{tr('인가 뒤 AAS 로그인을 한 번 더 요청할 수 있습니다', 'AAS may ask you to sign in once more after authorization')}</p>"
             if other_host else "")
    body = (f"<p class=hint>{ctx}</p><p id=st role=status aria-live=polite>{html.escape(msg['preparing'])}</p>"
            f"<div id=err class='notice error' role=alert hidden></div>"
            f"<p id=warn class='notice' hidden>{tr('암호화되지 않은 주소입니다(시험 설정)', 'This address is not encrypted (test setting)')}</p>{other}"
            f"<details id=more hidden><summary>{tr('자세히', 'Details')}</summary><code id=full style='word-break:break-all'></code></details>"
            f"<div style='{_MCP_OAUTH_BTNS}'><button type=button class='btn btn-secondary' id=cx>{tr('취소', 'Cancel')}</button>"
            f"<button type=button class='btn btn-primary' id=go hidden>{tr('계속', 'Continue')}</button></div>")
    target = {"pod": pod_id, "profile": profile, "server": server}
    script = ("<script>(function(){var M=" + _js_json(msg) + ",B=" + _js_json(target) + ",url=null,$=function(i){return document.getElementById(i)};"
              "function post(p){return fetch(p,{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json','X-AAS':'1'},body:JSON.stringify(B)})"
              ".then(function(r){return r.json().then(function(j){return {ok:r.ok,j:j}})})}"
              "function fail(t){$('st').textContent=M.failed;var e=$('err');e.textContent=t||'';e.hidden=false;$('go').hidden=true}"
              "function cancel(){post('/api/mcp/oauth/cancel').finally(function(){$('st').textContent=M.cancelled;$('go').hidden=true;window.close()})}"
              "$('cx').addEventListener('click',cancel);addEventListener('keydown',function(e){if(e.key==='Escape')cancel()});"
              "$('go').addEventListener('click',function(){if(url)location.replace(url)});"
              "post('/api/mcp/oauth/start').then(function(x){if(!x.ok){fail(x.j.error);return}url=x.j.authorization_url;"
              "$('st').textContent=M.at.replace('{host}',x.j.host);$('full').textContent=url;$('more').hidden=false;$('warn').hidden=!x.j.insecure;"
              "var g=$('go');g.hidden=false;g.focus()}).catch(function(){fail('')})})();</script>")
    return _page(tr("MCP 서버 로그인", "MCP server sign-in"), body, script=script)


def _mcp_oauth_error_page(err, row: dict | None) -> bytes:
    """콜백·시작 오류 화면(11-4 V6). 모든 오류에 「창 닫기」, 다시 할 수 있는 오류에는 「다시 로그인」."""
    reason = getattr(err, "reason", "") or ""
    retry = reason not in ("superseded", "other_user", "insecure_authorization_url", "used", "unreachable")
    links = [f"<button type=button class='btn btn-secondary' onclick='window.close()'>{tr('창 닫기', 'Close window')}</button>"]
    if row:
        if retry:
            again = "/oauth/mcp/start?" + urlencode({"pod": row["pod"], "profile": row["profile"], "server": row["server"]})
            links.append(f"<a class='btn btn-primary' href='{html.escape(again, quote=True)}'>{tr('다시 로그인', 'Sign in again')}</a>")
        links.append(f"<a class='btn btn-secondary' href='{html.escape(_mcp_tab_link(row['profile'], row['server']), quote=True)}'>{tr('MCP 탭으로 돌아가기', 'Back to the MCP tab')}</a>")
    body = (f"<div class='notice error' role=alert>{html.escape(str(err))}</div>"
            f"<div style='{_MCP_OAUTH_BTNS};flex-wrap:wrap'>{''.join(links)}</div>")
    return _page(tr("로그인하지 못했습니다", "Sign-in failed"), body)


def _mcp_oauth_waiting_page(row: dict) -> bytes:
    """콜백을 넘긴 뒤: Hermes 가 토큰 교환·도구 시험을 마칠 때까지 2초마다 묻는다(4-1 6단계). 성공하면 1초 뒤 닫는다(V5).
    원래 창은 이 메시지에 기대지 않고 스스로 상태를 묻는다(인가 서버의 COOP 로 창 사이 연결이 끊길 수 있다, V10)."""
    msg = {"done": tr("로그인했습니다", "Signed in"),
           "fail": tr("로그인하지 못했습니다", "Sign-in failed"),
           "late": tr("로그인 시간이 지났습니다. 다시 로그인하세요", "The sign-in took too long. Sign in again"),
           "closing": tr("이 창은 곧 닫힙니다. 닫히지 않으면 MCP 탭으로 돌아가세요.", "This window closes now. If it does not, go back to the MCP tab.")}
    tab = html.escape(_mcp_tab_link(row["profile"], row["server"]), quote=True)
    body = (f"<p id=st role=status aria-live=polite>{tr('로그인을 마무리하는 중', 'Finishing the sign-in')}</p>"
            f"<div id=err class='notice error' role=alert hidden></div>"
            f"<div style='{_MCP_OAUTH_BTNS}'><a class='btn btn-secondary' href='{tab}'>{tr('MCP 탭으로 돌아가기', 'Back to the MCP tab')}</a></div>")
    script = ("<script>(function(){var M=" + _js_json(msg) + ",S=" + _js_json(row["state"]) + ",n=0,$=function(i){return document.getElementById(i)};"
              "function tick(){n++;fetch('/api/mcp/oauth/status?state='+encodeURIComponent(S),{credentials:'same-origin',cache:'no-store'})"
              ".then(function(r){return r.json()}).then(function(j){"
              "if(j.status==='approved'){$('st').textContent=M.done+' '+M.closing;"
              "try{if(window.opener)window.opener.postMessage({aasMcpLogin:'approved',server:j.server},location.origin)}catch(e){}setTimeout(function(){window.close()},1000);return}"
              "if(j.status==='error'||j.status==='expired'||j.status==='cancelled'){$('st').textContent=M.fail;var e=$('err');e.textContent=j.error||(j.status==='expired'?M.late:'');e.hidden=!e.textContent;return}"
              "if(n<330)setTimeout(tick,2000);else $('st').textContent=M.late}).catch(function(){if(n<330)setTimeout(tick,2000)})}tick()})();</script>")
    return _page(tr("MCP 서버 로그인", "MCP server sign-in"), body, script=script)


# SSO 단추 앞 열쇠 아이콘(Material Symbols 「key」 경로를 HTML 안에 넣는다 — 아이콘 글꼴을 받지 않는다)
_ICON_KEY = ("<svg viewBox='0 0 24 24' aria-hidden=true fill='currentColor'><path d='M7 14q-.825 0-1.412-.587T5 12t.588-1.412T7 10t1.413.588"
             "T9 12t-.587 1.413T7 14m0 4q-2.5 0-4.25-1.75T1 12t1.75-4.25T7 6q1.675 0 3.038.825T12.2 9H21l3 3-4.5 4.5-2-1.5-2 1.5-2.125-1.5H12.2"
             "q-.8 1.35-2.162 2.175T7 18m0-2q1.4 0 2.463-.85T10.875 13H14l1.45 1.025L17.5 12.5l1.775 1.375L21.15 12l-1-1h-9.275q-.35-1.3-1.412-"
             "2.15T7 8Q5.35 8 4.175 9.175T3 12t1.175 2.825T7 16'/></svg>")

# 로그인 화면 아래쪽의 표어와 테마·언어 고르기(사용자 지시 2026-10-30, MSAP Observability 로그인처럼, 스펙 2026-10-14-001 §13).
# 테마 버튼은 바꿀 쪽 이름을 보인다(다크면 「라이트」). 둘 다 콘솔과 같은 localStorage 키를 쓴다 — 로그인 뒤 콘솔도 같은 테마·언어로 뜬다.
# 언어는 서버가 문장을 만들므로 쿠키(aas-lang)에도 넣고 다시 그린다. 스크립트가 없으면 고를 수 없으므로 고르기 줄은 스크립트가 보이게 한다
_ICON_SUN = ("<svg viewBox='0 0 24 24' aria-hidden=true fill=none stroke=currentColor stroke-width=2 stroke-linecap=round><circle cx=12 cy=12 r=4 />"
             "<path d='M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4'/></svg>")
_ICON_MOON = ("<svg viewBox='0 0 24 24' aria-hidden=true fill=none stroke=currentColor stroke-width=2 stroke-linejoin=round>"
              "<path d='M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5z'/></svg>")


def _login_prefs(next_path: str) -> str:
    lang = i18n.get_lang()
    opts = "".join(f"<option value={code}{' selected' if code == lang else ''}>{name}</option>" for code, name in (("ko", "한국어"), ("en", "English")))   # i18n-ignore: 언어 이름은 그 언어로 쓴다
    return ("<p class=tagline>We make IT better!</p>"
            f"<div class=prefs id=prefs hidden data-next='{html.escape(next_path, quote=True)}'>"
            f"<button type=button class='pref theme' id=theme><span class=to-light>{_ICON_SUN}{tr('라이트', 'Light')}</span>"
            f"<span class=to-dark>{_ICON_MOON}{tr('다크', 'Dark')}</span></button>"
            f"<select class=pref id=lang aria-label='{tr('언어', 'Language')}'>{opts}</select></div>")


_PREFS_SCRIPT = ("<script>(function(){var p=document.getElementById('prefs');if(!p)return;p.hidden=false;var d=document.documentElement;"
                 "document.getElementById('theme').onclick=function(){var t=d.getAttribute('data-theme')==='light'?'dark':'light';d.setAttribute('data-theme',t);"
                 f"try{{localStorage.setItem('{_THEME_KEY}',t)}}catch(e){{}}}};"
                 "document.getElementById('lang').onchange=function(){var l=this.value,n=p.getAttribute('data-next')||'/';"
                 f"try{{localStorage.setItem('{i18n.LANG_COOKIE}',l)}}catch(e){{}}"
                 f"document.cookie='{i18n.LANG_COOKIE}='+l+';path=/;max-age=31536000;samesite=lax';"
                 # 같은 주소를 다시 부르면 안 된다 — 비밀번호가 틀린 화면은 POST 결과다. 로그인 화면을 같은 next 로 다시 연다
                 "location.replace('/auth/login'+(n==='/'?'':'?next='+encodeURIComponent(n)))}})();</script>")


def _preparing(user: dict | None) -> bool:
    """이 사용자의 HermesAgent 가 만들어졌지만 아직 준비되지 않았는가(멈춘 것은 제외)."""
    if not user:
        return False
    sub, email = user.get("sub") or "", (user.get("email") or "").lower()
    return any(((sub and a.get("owner_sub") == sub) or a.get("owner") == email) and not a.get("ready") and not a.get("suspended")
               for a in getattr(registry(), "agents", []))


PRINCIPAL_KEY = "aas.principal"      # 같은 프로세스 안 요청의 사용자(스펙 2026-10-28-001 D2). ASGI scope 키라 클라이언트가 헤더로 만들 수 없다


def request_user(a, request):
    """Starlette 경로의 사용자. MCP 가 같은 프로세스 안에서 넣은 요청이면 그 사용자, 아니면 쿠키 세션."""
    p = (getattr(request, "scope", None) or {}).get(PRINCIPAL_KEY)     # 시험의 대역 요청에는 scope 가 없다
    if p is not None:
        return p["user"]
    return a.user(request.headers.get("cookie")) if a.enabled else None


class Handler(BaseHTTPRequestHandler):
    server_version = "AAS/0.3"
    principal: dict | None = None        # {"user": …, "pod": "<id>"}. 같은 프로세스 안 요청(legacy.dispatch)만 넣는다 — 헤더에서 읽지 않는다

    def send_header(self, keyword, value):
        """줄바꿈·NUL 이 든 헤더는 보내지 않는다. 응답을 줄 단위로 다시 나누므로(legacy._parse) 값 속 줄바꿈이 새 헤더가 됐다(CodeQL #72)."""
        if any(c in f"{keyword}{value}" for c in "\r\n\0"):
            return
        super().send_header(keyword, value)

    def parse_request(self) -> bool:
        """요청마다 응답 문장의 언어를 고른 언어 쿠키, 없으면 Accept-Language 로 정한다(keep-alive 연결도 요청마다 다시 정한다)."""
        ok = super().parse_request()
        i18n.set_lang(i18n.request_lang(self.headers.get("Accept-Language"), self.headers.get("Cookie")) if ok else i18n.DEFAULT)
        return ok

    def _send(self, code: int, body: bytes, ctype: str, headers: dict | None = None):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        if "Cache-Control" not in (headers or {}):
            self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Content-Language", i18n.get_lang())
        self.send_header("Vary", "Accept-Language, Cookie")              # 언어는 고른 언어 쿠키로도 바뀐다
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        self._send_sticky()
        self.end_headers()
        self.wfile.write(body)

    def _send_sticky(self):
        """_context 가 정한 사용자 고정 쿠키(aas_u)를 한 번 싣는다. 같은 연결의 다음 요청에 남지 않게 지운다."""
        sticky = getattr(self, "_sticky", None)
        if sticky:
            self.send_header("Set-Cookie", sticky)
            self._sticky = None

    def _assets(self, path: str):
        """React 빌드 산출물의 assets/. 같은 방어를 하고, 해시 이름이라 오래 캐시한다."""
        self._serve_file(STATIC_DIR / "assets", unquote(path[len("/assets/"):]), ASSET_CACHE)

    def _serve_file(self, root: Path, rel: str, cache: str):
        if "\x00" in rel:
            self._send(404, b"not found", "text/plain; charset=utf-8")
            return
        target = (root / rel).resolve()
        ctype = STATIC_TYPES.get(target.suffix.lower())
        if (not ctype or root.resolve() not in target.parents or not target.is_file()
                or any(part.startswith(".") for part in Path(rel).parts)):
            self._send(404, b"not found", "text/plain; charset=utf-8")
            return
        body = target.read_bytes()
        etag = '"%s"' % hashlib.sha256(body).hexdigest()[:20]
        if self.headers.get("If-None-Match") == etag:
            self.send_response(304)
            self.send_header("ETag", etag)
            self.send_header("Cache-Control", cache)
            self.end_headers()
            return
        self._send(200, body, ctype, {"ETag": etag, "Cache-Control": cache})

    @staticmethod
    def _edit_state(a, user, rel: str, data: dict, pod: Pod | None = None) -> dict:
        """이 파일을 여기서 고칠 수 있는가, 안 되면 왜. 관리자와 그 파드의 주인이 고친다(주인은 숨긴 루트를 못 만진다, 스펙 2026-10-15-011 D10)."""
        admin = (not a.enabled) or registry().is_admin(user)
        may = admin or (pod is not None and not content_gate(pod, user, a.enabled, admin, _profile_of_path(rel)))
        why = ("" if files.editable(rel) else tr("스크립트는 보기만 됩니다. 고치려면 AI 에이전트와의 대화로 요청하세요.", "Scripts are read-only. To change one, ask the AI Agent in a chat.")) \
            or ("" if may else tr("관리자만 고칠 수 있습니다", "Only admins can edit this")) \
            or (tr("비밀값으로 보이는 줄이 있어 여기서는 고칠 수 없습니다", "Some lines look like secrets, so this cannot be edited here") if data["masked_lines"] else "")
        return {"editable": not why, "why_not": why}

    def _json(self, obj, code: int = 200):
        self._send(code, json.dumps(obj, ensure_ascii=False).encode(), "application/json; charset=utf-8")

    def _speech_reply(self, code: int, out, headers: dict):
        """읽어 주기 응답: 성공은 audio/mpeg 바이트, 204 는 빈 본문, 나머지는 JSON. 조각 헤더는 함께 싣는다."""
        if isinstance(out, (bytes, bytearray)):
            self._send(code, bytes(out), "audio/mpeg" if code == 200 else "text/plain; charset=utf-8", headers)
        else:
            self._send(code, json.dumps(out, ensure_ascii=False).encode(), "application/json; charset=utf-8", headers)

    def _redirect(self, location: str, cookie: str | None = None):
        if any(c in location for c in "\r\n"):          # 헤더에 줄바꿈이 섞이지 않게
            location = "/"
        self.send_response(302)
        self.send_header("Location", location)
        self.send_header("Cache-Control", "no-store")
        if cookie:
            self.send_header("Set-Cookie", cookie)
        self._send_sticky()
        self.send_header("Content-Length", "0")
        self.end_headers()

    def _same_origin(self) -> bool:
        """상태를 바꾸는 요청(채팅 등)을 다른 사이트가 보내지 못하게 한다: 전용 헤더(단순 요청이
        아니게 만들어 사전 요청을 강제 — CORS 를 열지 않으므로 막힌다)와 Origin/Host 일치를 요구한다."""
        if getattr(self, "principal", None) is not None:    # 같은 프로세스 안 요청(브라우저가 아니라 CSRF 대상이 아니다, D2)
            return True
        if self.headers.get("X-AAS") != "1":
            return False
        origin = self.headers.get("Origin")
        if origin and urlsplit(origin).netloc != self.headers.get("Host", ""):
            return False
        return True

    def _host_ok(self) -> bool:
        """AAS_ALLOWED_HOSTS 가 있으면 그 Host 로 온 요청만 받는다(DNS 리바인딩 방지)."""
        allowed = [h.strip().lower() for h in os.environ.get("AAS_ALLOWED_HOSTS", "").split(",") if h.strip()]
        return not allowed or self.headers.get("Host", "").lower() in allowed

    def _trusts_proxy(self) -> bool:
        """AAS_TRUSTED_PROXY 가 이 연결을 신뢰하는가. true 면 모든 연결(Ingress 만 서버에 닿게 NetworkPolicy 로 막은 배포용),
        CIDR 목록이면 그 프록시 주소에서 온 연결만. 비었거나 false 거나 알아볼 수 없으면 신뢰하지 않는다(계획 R1)."""
        raw = config.get("AAS_TRUSTED_PROXY").strip().lower()
        if raw in ("1", "true", "yes", "on"):
            return True
        if not raw or raw in ("0", "false", "no", "off"):
            return False
        try:
            peer = ipaddress.ip_address(self.client_address[0])
        except (ValueError, TypeError, IndexError):
            return False
        for part in re.split(r"[,\s]+", raw):
            try:
                if peer in ipaddress.ip_network(part, strict=False):
                    return True
            except ValueError:
                continue
        return False

    def _effective_host(self) -> str:
        """클라이언트가 접속한 이름. 신뢰하는 프록시 뒤에서는 X-Forwarded-Host(여러 단이면 맨 앞), 아니면 Host."""
        if self._trusts_proxy():
            fwd = self.headers.get("X-Forwarded-Host", "").split(",")[0].strip()
            if fwd:
                return fwd
        return self.headers.get("Host", "")

    def _is_local_host(self) -> bool:
        return self._effective_host().split(":")[0].lower() in ("localhost", "127.0.0.1", "[::1]")

    def _tls(self) -> bool:
        return isinstance(self.connection, ssl.SSLSocket)

    def _secrets_ok(self) -> bool:
        """비밀값을 받아도 되는 연결인가. 화면의 입력 허용과 실제 저장이 모두 이 함수로 판단한다(스펙 2026-10-19-015 A3).
        https 면 된다. http 는 localhost 일 때만인데, Host 헤더는 꾸밀 수 있으므로 쿠버네티스(로컬 시험이 아닌 곳)에서는 끈다.
        AAS_ALLOW_LOCALHOST_SECRETS=true|false 로 기본값을 바꾼다."""
        if self._secure_request():
            return True
        raw = config.get("AAS_ALLOW_LOCALHOST_SECRETS").strip().lower()
        allow = raw in ("1", "true", "yes", "on") if raw else not os.environ.get("KUBERNETES_SERVICE_HOST")
        return allow and self._is_local_host()

    def _secure_request(self) -> bool:
        """이 요청이 https 로 들어왔는가. 자기 소켓이 TLS 이거나, 신뢰하는 프록시가 X-Forwarded-Proto: https 를 달았을 때(맨 앞 값만 본다).
        로그인 주소 대조·Secure 쿠키·비밀값 탭·오피스 열쇠가 모두 이 한 함수로 판단한다."""
        if self._tls():
            return True
        return self._trusts_proxy() and self.headers.get("X-Forwarded-Proto", "").split(",")[0].strip().lower() == "https"

    def _oidc_base(self) -> str | None:
        """이 주소에서 SSO 로그인을 쓸 수 있으면 돌아올 접속 주소, 아니면 None.
        구글은 localhost 이거나 https 도메인인 리디렉션만 받는다. 그 밖의 발급자(Keycloak 등)는 등록된 접속 주소면 된다."""
        a = auth()
        if not a.oidc_enabled:
            return None
        base = a.base_for(self._effective_host(), self._secure_request())
        if base and (self._secure_request() or self._is_local_host() or not a.is_google):
            return base
        return a.cfg["public_url"] if self._is_local_host() and not self._secure_request() else None

    def _login_page(self, error: str = "", next_path: str = "/", code: int = 200, logged_out: bool = False):
        a = auth()
        parts = []
        if logged_out and not error:
            parts.append(f"<div class='notice ok' role=status>{tr('로그아웃했습니다.', 'You have signed out.')}</div>")
        if error:
            parts.append(f"<div class='notice error' role=alert>{html.escape(error)}</div>")
        sso = self._oidc_base()
        if a.password_enabled:
            parts.append(
                "<form method=post action=/auth/password>"
                f"<input type=hidden name=next value='{html.escape(next_path, quote=True)}'>"
                f"<label>{tr('이메일', 'Email')}<input name=email type=email autocomplete=username required autofocus></label>"
                f"<label>{tr('비밀번호', 'Password')}<input name=password type=password autocomplete=current-password required></label>"
                f"<button class='btn btn-primary'>{tr('로그인', 'Sign in')}</button></form>")
        if sso:
            if a.password_enabled:
                parts.append(f"<div class=or>{tr('또는', 'or')}</div>")
            # SSO 만 있으면 주 단추(빨강), 비밀번호와 함께면 보조 단추 — 빨강 주 단추는 한 화면에 하나(DESIGN §1-1)
            kind = "btn-secondary" if a.password_enabled else "btn-primary"
            nxt = html.escape(quote(next_path, safe="/"), quote=True)
            parts.append(f"<a class='btn {kind}' href='/auth/oidc?next=" + nxt + f"' id=sso data-next='{html.escape(next_path, quote=True)}'>"
                         + _ICON_KEY + tr("SSO 로 로그인", "Sign in with SSO") + "</a>")
            parts.append(f"<p class=hint>{tr('버튼을 누르면 새 창에서 로그인합니다.', 'A new window opens to sign in.')}</p>")
        elif a.oidc_enabled and not a.password_enabled:
            parts.append(tr("<p>이 주소로는 SSO 로그인을 쓸 수 없습니다(등록된 접속 주소가 아니거나, 구글이면 localhost 나 https 도메인이 아닙니다). 관리자에게 문의하세요.</p>",
                            "<p>SSO sign-in is not available at this address (it is not a registered access address or, for Google, not localhost or an https domain). Ask an admin.</p>"))
        if not self._is_local_host() and not self._secure_request():
            parts.append(tr("<p class=hint>이 연결은 암호화되지 않습니다(http). 사내망·VPN 안에서만 쓰세요.</p>",
                            "<p class=hint>This connection is not encrypted (http). Use it only inside the internal network or VPN.</p>"))
        parts.append(_login_prefs(next_path))
        sub = tr("회사 계정(SSO)으로 로그인합니다.", "Sign in with your company account (SSO).") if sso and not a.password_enabled else \
            tr("계정으로 로그인합니다.", "Sign in to your account.")
        # MCP 로그인 콜백에서 온 로그인(이미 팝업 안이다)은 SSO 를 같은 창에서 연다 — 팝업 안에 팝업을 열지 않는다(스펙 2026-10-16-010 V11).
        # Claude Code 연결 동의 화면에서 온 로그인도 같은 창에서 — 끝나면 동의 화면으로 돌아가야 한다(스펙 2026-10-28-001 디자인 D12)
        popup_ok = sso and not next_path.startswith((mcp_oauth_relay.CALLBACK_PATH, "/oauth/connect/"))
        self._send(code, _page(tr("로그인", "Sign in"), "".join(parts), sub, (_POPUP_SCRIPT if popup_ok else "") + _PREFS_SCRIPT,
                               heading=tr("AAS 에 오신 것을 환영합니다", "Welcome to AAS")),
                   "text/html; charset=utf-8")

    def _context(self):
        """(사용자, POD). 로그인이 켜져 있는데 세션이 없으면 사용자는 None."""
        a = auth()
        p = getattr(self, "principal", None)
        if p is not None:                       # 같은 프로세스 안 요청(D2): 사용자와 대상 POD 를 내부 값에서. 고른 POD 가 볼 수 없는 것이면 None(F1)
            user, wanted = p["user"], str(p.get("pod") or "")
            pod = registry().pick(user, a.enabled, wanted)
            if wanted and (pod is None or pod.id != wanted):
                pod = None
            return a, user, pod
        user = a.user(self.headers.get("Cookie")) if a.enabled else None
        pod = registry().pick(user, a.enabled, _cookie(self.headers.get("Cookie"), POD_COOKIE))
        self._sticky = None
        email = str((user or {}).get("email") or "")
        if email:                                           # 로그인한 요청: 사용자 고정 쿠키가 없거나 다르면 이 응답에 싣는다(_send·_redirect)
            want = _sticky_value(email)
            if _cookie(self.headers.get("Cookie"), STICKY_COOKIE) != want:
                self._sticky = f"{STICKY_COOKIE}={want}" + _sticky_attrs(self._secure_request())
        return a, user, pod

    # ---- 로그인 -----------------------------------------------------------
    def _auth_routes(self, path: str, query: dict) -> bool:
        a = auth()
        if path == "/auth/login":
            if not a.enabled:
                self._redirect("/")
            else:                          # SSO 만 있어도 로그인 화면을 먼저 보인다. 단추가 팝업을 연다(스펙 2026-10-15-019, COP Console 처럼)
                self._login_page(next_path=query.get("next", ["/"])[0], logged_out="out" in query)
            return True
        if path == "/auth/oidc":
            base = self._oidc_base()
            if not base:
                self._redirect("/auth/login")
                return True
            try:
                self._redirect(a.begin(query.get("next", ["/"])[0], base, popup=query.get("popup", [""])[0] == "1"))
            except AuthError as exc:
                self._send(503, _page(tr("로그인할 수 없습니다", "Cannot sign in"), f"<p>{html.escape(str(exc))}</p>"), "text/html; charset=utf-8")
            return True
        if path == "/auth/callback":
            try:
                if query.get("error"):
                    raise AuthError(tr("로그인이 취소됐습니다", "Sign-in was cancelled"))
                token, nxt, popup = a.finish(query.get("code", [""])[0], query.get("state", [""])[0], with_popup=True)
                if popup:                  # 팝업이면 원래 창에 알리고 닫는다
                    self._send(200, _popup_done(nxt), "text/html; charset=utf-8", {"Set-Cookie": a.set_cookie(token, self._secure_request())})
                else:
                    self._redirect(nxt, a.set_cookie(token, self._secure_request()))
            except AuthError as exc:
                self._send(403, _page(tr("로그인하지 못했습니다", "Sign-in failed"), f"<p>{html.escape(str(exc))}</p>"
                                      f"<p><a href='/auth/login'>{tr('다시 로그인', 'Sign in again')}</a></p>"), "text/html; charset=utf-8")
            return True
        if path == "/auth/logout":
            who = a.user(self.headers.get("Cookie")) if a.enabled else None
            a.logout(self.headers.get("Cookie"))
            if who:
                topics.user_changed(who.get("email", ""))      # 다른 탭의 웹소켓도 4401 로 닫는다
            # SSO 공급자의 세션은 남는다. 바로 /auth/oidc 로 넘기면 조용히 다시 로그인되므로 로그인 화면에서 멈춘다.
            self._redirect("/auth/login?out=1" if a.enabled else "/", a.clear_cookie())
            return True
        return False

    # ---- MCP 서버 OAuth 로그인(스펙 2026-10-16-010) ------------------------------
    def _mcp_oauth_get(self, path: str, query: dict, a, user) -> None:
        q1 = lambda k: str((query.get(k) or [""])[0])                            # noqa: E731
        page = lambda code, body: self._send(code, body, "text/html; charset=utf-8")   # noqa: E731
        if path == "/oauth/mcp/start":                                           # 팝업 시작 화면. 흐름은 화면의 스크립트가 POST 로 시작한다(R3)
            try:
                _mcp_oauth_target(a, user, q1("pod"), q1("profile"))
            except mcp_oauth_relay.RelayError as exc:
                page(exc.code, _mcp_oauth_error_page(exc, None))
                return
            public = urlsplit(a.cfg["public_url"]).netloc.lower()
            page(200, _mcp_oauth_start_page(q1("pod"), q1("profile"), q1("server"), public != self._effective_host().lower()))
            return
        if path == "/api/mcp/oauth/status":                                      # 팝업은 state 로, 원래 창은 (파드, 프로파일, 서버)로 묻는다
            try:
                state = q1("state")
                if state:
                    row = mcp_oauth_relay.by_state(state)
                    admin = (not a.enabled) or registry().is_admin(user)
                    if row is None or not (admin or mcp_oauth_relay._user_key(user)[0] == row["user_sub"]):
                        self._json({"status": "none"})
                        return
                    pod_obj = next((p for p in registry().pods if p.id == row["pod"]), None)
                    if pod_obj is None:
                        self._json({"status": "none"})
                        return
                else:
                    pod_obj, _prof = _mcp_oauth_target(a, user, q1("pod"), q1("profile"))
                    row = mcp_oauth_relay._latest(pod_obj.id, q1("profile"), q1("server"))
                out = mcp_oauth_relay.status(HermesAPI(hub(pod_obj).auth), row)
                if out.get("status") in ("approved", "error", "cancelled", "expired"):
                    _forget_mcp_login(pod_obj.id, out["profile"])
                self._json(out)
            except mcp_oauth_relay.RelayError as exc:
                self._json(_error_body(exc), exc.code)
            return
        # 콜백: state 를 일회용으로 쓰고, 시작한 사용자인지 본 뒤, 받은 값을 그 파드의 Hermes 콜백으로 넘긴다(4-1 4·5단계)
        row = None
        try:
            row = mcp_oauth_relay.by_state(q1("state"))
            claimed = mcp_oauth_relay.claim(q1("state"), user)
            pod_obj = next((p for p in registry().pods if p.id == claimed["pod"]), None)
            if pod_obj is None:
                raise mcp_oauth_relay.RelayError(tr("없는 AI 에이전트 작업공간입니다", "That AI Agent Workspace does not exist"), 404, reason="no_pod")
            out = mcp_oauth_relay.deliver(HermesAPI(hub(pod_obj).auth), claimed, code=q1("code"), state=q1("state"),
                                          error=q1("error"), iss=q1("iss"))
            store.log_usage("mcp_oauth_callback" if out["ok"] else "mcp_oauth_callback_failed",
                            f"{(user or {}).get('email', 'local')} {claimed['profile']}/{claimed['server']} {out['reason']}", pod=claimed["pod"])
            if not out["ok"]:
                raise mcp_oauth_relay.RelayError(out["message"], 502 if out["reason"] in ("hermes_down", "hermes_rejected") else 400, reason=out["reason"])
            _forget(pod_obj, ("flow", "credentials", "credentials_nousage", "libraries", "skills", "observed", "activity7", "activity30"))   # 토큰이 생겼다 — 도구·MCP 목록을 다시 읽게
            page(200, _mcp_oauth_waiting_page(claimed))
        except mcp_oauth_relay.RelayError as exc:
            page(exc.code if exc.code < 500 else 502, _mcp_oauth_error_page(exc, row))

    def _mcp_oauth_post(self, path: str, body: dict, a, user) -> None:
        try:
            pod_obj, prof = _mcp_oauth_target(a, user, str(body.get("pod") or ""), str(body.get("profile") or ""))
            api = HermesAPI(hub(pod_obj).auth)
            profile, server = str(body.get("profile") or ""), str(body.get("server") or "")
            who = (user or {}).get("email", "local")
            if path == "/api/mcp/oauth/cancel":
                n = mcp_oauth_relay.cancel(api, pod=pod_obj.id, profile=profile, server=server)
                _forget_mcp_login(pod_obj.id, profile)
                self._json({"ok": True, "cancelled": n})
                return
            out = mcp_oauth_relay.start(api, pod=pod_obj.id, profile=profile, prof=prof, server=server, user=user, public_url=a.cfg["public_url"])
            store.log_usage("mcp_oauth_start", f"{who} {profile}/{server} host={out['host']}", pod=pod_obj.id)
            _forget_mcp_login(pod_obj.id, profile)
            self._json({"ok": True, "authorization_url": out["authorization_url"], "host": out["host"], "insecure": out["insecure"]})
        except (mcp_oauth_relay.RelayError, files.FileError, HermesError) as exc:
            if path != "/api/mcp/oauth/cancel":
                store.log_usage("mcp_oauth_start_failed", f"{(user or {}).get('email', 'local')} {body.get('profile')}/{body.get('server')} {getattr(exc, 'reason', '')}")
            self._json(_error_body(exc), getattr(exc, "code", 400))

    # ---- GET --------------------------------------------------------------
    def do_GET(self):  # noqa: N802
        url = urlsplit(self.path)
        path, query = url.path, parse_qs(url.query)
        if path == "/healthz":      # 프로세스가 살아 있는지만 본다. 허용 Host·로그인보다 앞(프로브는 파드 IP 로 부른다)
            self._json({"ok": True})
            return
        if path == "/readyz":       # 요청을 받을 준비가 됐는지. DB 가 멈추면 트래픽만 끊고(503) 재시작하지 않는다. /healthz 처럼 Host 검사보다 앞
            ok = db.ping(2.0)
            self._json({"ok": ok}, 200 if ok else 503)
            return
        try:
            if not self._host_ok():
                self._send(400, _page(tr("잘못된 주소", "Invalid address"), tr("<p>허용되지 않은 주소로 접속했습니다.</p>", "<p>You connected through an address that is not allowed.</p>")), "text/html; charset=utf-8")
                return
            if self._auth_routes(path, query):
                return
            a, user, pod = self._context()
            if a.enabled and not user:
                if path.startswith("/api/"):
                    self._json({"error": tr("로그인이 필요합니다", "Sign in required"), "login": "/auth/login"}, 401)
                elif path == mcp_oauth_relay.CALLBACK_PATH:          # MCP 로그인 콜백: 세션이 없으면 로그인한 뒤 이 주소(쿼리 포함)로 돌아와 처리한다(4-4)
                    self._redirect("/auth/login?" + urlencode({"next": self.path}))
                else:
                    self._redirect("/auth/login")
                return
            if path in ("/oauth/mcp/start", mcp_oauth_relay.CALLBACK_PATH, "/api/mcp/oauth/status"):
                self._mcp_oauth_get(path, query, a, user)
                return
            if path == "/assets" or path.startswith("/assets/"):
                self._assets(path)
                return
            if path == "/api/tokens":                     # 「Claude Code 연결」: 내 연결 목록(스펙 2026-10-28-001 T1). ?ended=1 이면 30일 안에 끝난 것도
                from ..auth import tokens
                if not a.enabled:                         # 로그인을 끈 설치는 쓰지 않는다(Q7, 재검토 D4)
                    self._json({"error": tr("로그인을 켜면 쓸 수 있습니다", "Available when sign-in is enabled"), "reason": "login_off"}, 404)
                    return
                base = a.base_for(self._effective_host(), self._secure_request()) or a.cfg["public_url"]
                self._json({"tokens": tokens.list_for(user["email"], include_ended=query.get("ended", [""])[0] == "1"),
                            "bundles": {k: list(v) for k, v in tokens.BUNDLES.items()}, "expiry_days": list(tokens.EXPIRY_DAYS),
                            "default_days": tokens.DEFAULT_DAYS, "max": tokens.MAX_ACTIVE, "mcp_url": base.rstrip("/") + "/mcp"})
                return
            if path == "/api/tokens/all":                 # 사용자 관리 「Claude Code 연결」 탭: 모든 사람의 연결(관리자만, 디자인 D19)
                from ..auth import tokens
                if not a.enabled:
                    self._json({"error": tr("로그인을 켜면 쓸 수 있습니다", "Available when sign-in is enabled"), "reason": "login_off"}, 404)
                    return
                if not registry().is_admin(user):
                    self._json({"error": tr("관리자만 볼 수 있습니다", "Only admins can see this")}, 403)
                    return
                self._json({"tokens": tokens.list_all(include_ended=query.get("ended", [""])[0] == "1")})
                return
            if path == "/api/settings":                   # 「설정」 화면: 회사 이름과 에이전트 소개 문장(계획 2026-10-13-008)
                name = settings.company_name()
                self._json({"company_name": name, "default_company": settings.DEFAULT_COMPANY, "effective_company": name or settings.DEFAULT_COMPANY,
                            "identity_sentence": settings.identity_sentence(), "max": settings.COMPANY_MAX,
                            "goal_max": settings.GOAL_MAX,
                            # 부서별 슬로건·목표(스펙 2026-10-15-018): 관리자는 로그인으로 안 부서와 오피스 팀을 합친 모든 부서(scope all),
                            # 일반 사용자는 자기 부서 한 줄만(scope own, 부서가 없으면 빈 목록). can_edit 은 회사 이름·소개 문장, can_edit_goal 은 문구
                            "department_goals": (settings.goal_rows() if (not a.enabled) or registry().is_admin(user)
                                                 else settings.own_goal_rows((user or {}).get("email"))),
                            "goal_scope": "all" if (not a.enabled) or registry().is_admin(user) else "own",
                            "can_edit_goal": (not a.enabled) or registry().is_admin(user) or bool(settings.own_department((user or {}).get("email"))),
                            "can_edit": (not a.enabled) or registry().is_admin(user)})
                return
            if path == "/api/tts/voices":                 # 설정 › 내 화면의 목소리 줄(chat-reply-tts R11). 로그인한 누구나, 연결된 POD 가 없어도 된다
                self._json(tts.info())
                return
            if path == "/api/soul-templates":             # 설정 › SOUL 템플릿(계획 2026-10-13-009). 연결된 POD 가 없어도 된다
                admin = (not a.enabled) or registry().is_admin(user)
                tid, lang = query.get("id", [""])[0], query.get("lang", [""])[0]
                if tid:
                    self._json({"versions": soul_templates.versions(tid, lang)})
                else:
                    self._json({"templates": soul_templates.templates(include_deleted=admin), "langs": list(soul_templates.LANGS),
                                "placeholders": list(soul_templates.PLACEHOLDERS), "can_edit": admin,
                                "identity_sentence": settings.identity_sentence(), "default_template": settings.default_template()})
                return
            if path == "/api/notices":                    # 공지 관리 목록(관리자만, 스펙 2026-10-24-007). 시작이 늦은 순 최근 1,000행(R3)
                if a.enabled and not registry().is_admin(user):
                    self._json({"error": tr("관리자만 볼 수 있습니다", "Only admins can view this")}, 403)
                    return
                at, rows, known = notices.now(), notices.rows_all(notices.LIST_LIMIT + 1), office.people()
                self._json({"notices": [_notice_admin(r, at, known) for r in rows[:notices.LIST_LIMIT]], "limited": len(rows) > notices.LIST_LIMIT,
                            "limit": notices.LIST_LIMIT, "reach_enabled": a.enabled})
                return
            if path == "/api/departments":                # 부서 목록(관리자만, 스펙 2026-10-15-026). 사용자 폼의 후보와 부서 탭이 쓴다
                if a.enabled and not registry().is_admin(user):
                    self._json({"error": tr("관리자만 볼 수 있습니다", "Only admins can view this")}, 403)
                    return
                self._json(_departments_view(a))
                return
            if path == "/api/users":                      # 누가 들어오고 누가 관리자인가(관리자만). 연결된 에이전트가 없어도 된다(P2)
                if a.enabled and not registry().is_admin(user):
                    self._json({"error": tr("관리자만 볼 수 있습니다", "Only admins can view this")}, 403)
                    return
                self._json(_users_view(a, user))
                return
            if path == "/api/me":
                with store.request_memo():                   # 읽기만 한다 — 권한·사람 목록·회사 이름을 한 번씩만 읽는다(스펙 2026-10-24-009 3-2)
                    reg = registry()
                    names, known = office.agent_names_provider(), office.people()
                    team_ids = _team_pod_ids(reg, user, a.enabled)
                    self._json({"auth_enabled": a.enabled, "user": user, "admin": reg.is_admin(user), **_me_team_flags(reg, pod, user, a.enabled),
                                # 지금 POD 의 주인인가 — 운영 메뉴의 「내 에이전트 변경 기록」 입구(디자인 결정 2A)
                                "owner": bool(a.enabled and pod is not None and pod.owned_by(user)),   # 주인 표시라 그대로
                                "pod": _pod_public(pod, names, known, team_ids), "registry_error": reg.error,
                                "pods": [_pod_public(p, names, known, team_ids) for p in reg.allowed(user, a.enabled)],
                                # 내 정보 서랍의 「내 에이전트」: 내가 주인인 에이전트만(관리자의 pods 는 전체라 쓰지 않는다, OMAI-1159)
                                "own_pods": [p.id for p in reg.pods if p.owned_by(user)], "ws": ws_enabled(),   # 주인 표시라 그대로
                                # 좌측 메뉴·오피스 제목 「<회사> > <부서> 오피스」(OMAI-1121). 회사명은 설정한 값만(미설정이면 빈 값)
                                "department": settings.departments().get(str((user or {}).get("email") or "").lower(), ""),
                                "company_name": settings.company_name(),
                                # 새 사용자의 주 프로파일(main)이 아직 준비되지 않았으면 화면이 「준비 중」을 보인다(스펙 2026-10-14-003 리뷰 D6)
                                "primary": _primary_view(pod),
                                # 내 정보 서랍: 비밀번호를 어디서 바꾸는가(스펙 2026-10-14-017)
                                "account": {"method": (m := _account_method(a, user)), "can_change_password": m != "none"},
                                # 비밀값을 넣어도 되는 연결인가(암호화된 연결이거나 이 맥 안). 자격증명 서랍이 입력을 미리 막는다(스펙 2026-10-14-025 D5)
                                "secure": self._secrets_ok(),
                                # 메뉴 「스킬 허브」 배지: 이 작업공간에서 올릴 수 있는 새 버전 줄 수(D4). 올리기 권한이 없으면 0(R7). 모아 둔 값만 쓴다
                                "market_updates": len(market_updates.alerts(_market_updates_peek(pod)))
                                if pod is not None and may_use_market("/api/market/install", pod, user, a.enabled, reg.is_admin(user)) else 0,
                                # 지금 보일 공지(스펙 2026-10-24-007 R4). 처음 그릴 때와 웹소켓이 없을 때 화면이 쓴다
                                "notices": _user_notices(a, user),
                                # 「Claude Code 연결」 메뉴 배지·계정 서랍 한 줄(스펙 2026-10-28-001 §3-7 ②). 로그인을 끈 설치는 없다
                                "connections": _connections_summary(a, user)})
                return
            if pod is None and _preparing(user):
                # 첫 로그인은 HermesAgent 를 만들고, 파드가 Ready 가 되기 전에는 등록부에 오르지 않는다. 오류 대신 기다리게 한다.
                msg = tr("AI 에이전트 작업공간을 준비하는 중입니다. 잠시 뒤 자동으로 다시 불러옵니다.", "Preparing your AI Agent Workspace. This page reloads automatically in a moment.")
                if path.startswith("/api/"):
                    self._json({"error": msg, "preparing": True}, 503)
                else:
                    self._send(200, _page(tr("AI 에이전트 작업공간을 준비하는 중입니다", "Preparing your AI Agent Workspace"), "<meta http-equiv=refresh content=5>"
                                          + tr("<p>처음 로그인하면 사용자 전용 AI 에이전트 작업공간을 만듭니다. 보통 1~2분 걸립니다. 이 화면은 5초마다 다시 불러옵니다.</p>",
                                               "<p>On your first sign-in, a personal AI Agent Workspace is created for you. This usually takes 1-2 minutes. This page reloads every 5 seconds.</p>"),
                                          notices=_user_notices(a, user)), "text/html; charset=utf-8")
                return
            if pod is None:
                msg = registry().error or tr("이 계정에 연결된 AI 에이전트 작업공간이 없습니다. 관리자에게 등록을 요청하세요.", "No AI Agent Workspace is linked to this account. Ask an admin to register one.")
                if path.startswith("/api/"):
                    self._json({"error": msg}, 403)
                else:
                    self._send(403, _page(tr("연결된 AI 에이전트 작업공간이 없습니다", "No AI Agent Workspace is linked"), f"<p>{html.escape(msg)}</p><p>{html.escape((user or {}).get('email', ''))}"
                                          f" · <a href='/auth/logout'>{tr('로그아웃', 'Sign out')}</a></p>", notices=_user_notices(a, user)), "text/html; charset=utf-8")
                return
            if path.startswith("/api/chat/") and query.get("pod", [""])[0] and query.get("all", [""])[0] != "1":
                pod = _chat_pod(a, user, query["pod"][0])       # 채팅은 지금 에이전트(쿠키)와 따로 에이전트를 고른다(2026-10-19-001 리뷰 D8)
                if pod is None:
                    self._json(*_chat_pod_refusal(a, user, query["pod"][0]))
                    return
            if path in ("/", "/index.html"):
                store.log_usage("console_view", (user or {}).get("email", ""))
                built = STATIC_DIR / "index.html"
                if built.is_file():
                    self._send(200, _index_html(built.read_bytes()), "text/html; charset=utf-8")
                else:                                         # 화면은 이미지를 만들 때 빌드한다. 소스에서 돌릴 때는 ui/ 에서 빌드해야 한다
                    self._send(503, _page(tr("화면이 빌드되지 않았습니다", "The UI is not built"),
                                    tr("<p>소스에서 실행 중이라면 <code>cd ui &amp;&amp; npm ci &amp;&amp; npm run build</code> 를 먼저 실행하세요. 컨테이너 이미지에는 빌드된 화면이 들어 있습니다.</p>",
                                       "<p>If you run from source, first run <code>cd ui &amp;&amp; npm ci &amp;&amp; npm run build</code>. The container image includes the built UI.</p>")), "text/html; charset=utf-8")
            elif path == "/api/health":
                self._json({**health_payload(pod), "dashboard_url": dashboard_url(self.headers.get("Host", "localhost"))})
            elif path == "/api/skills":
                g = _skills(pod)
                tag_table = market_tags.load()                 # 스킬 태그(OMAI-1283): 표를 한 번만 읽어 행마다 붙인다
                slim = [{**skill_graph.list_row(s), "tags": market_tags.skill_tags(tag_table, s["name"], s.get("description") or "", s.get("origin") or ""),
                         "delete_block": skill_delete_block(s, g["skills"])}     # 화면의 지우기 비활성 이유 — 서버 지우기와 같은 규칙(2026-10-29-005 DD3)
                        for s in g["skills"]]
                slim = skill_desc.apply(slim, 240)              # 태그는 원문으로 찾은 뒤에 번역을 붙인다(스펙 2026-10-19-017 P5)
                try:
                    states, agents = _skill_states(pod)         # 에이전트 중심 보기: 줄마다 그 프로파일 기준 상태
                except Exception:
                    states, agents = {}, []
                slim = [{**row, **states.get(row["id"], {})} for row in slim]
                if may_use_market("/api/market/install", pod, user, a.enabled, registry().is_admin(user)):   # 스킬 줄의 「새 버전 v…」(D15). 올릴 수 있는 사람에게만(R7)
                    newer = {(r["profile"], r["skill"]): r["latest"] for r in market_updates.alerts(_market_updates_peek(pod)) if r["kind"] == "skill"}
                    paths = {x["id"]: str(x.get("path") or "") for x in g["skills"]}
                    for row in slim:
                        folder = ("/" + paths.get(row["id"], "")).partition("/" + market_updates.MARKET_DIR + "/")[2]
                        if folder and "/" not in folder and (row.get("profile"), folder) in newer:
                            row["new_version"] = newer[(row["profile"], folder)]
                self._json({"built_at": g["built_at"], "totals": g["totals"], "skills": slim,
                            "bundled_repaired": bundled_repair.recent(pod.id),    # 자동 복구 안내 띠(스펙 2026-10-27-011 D14). 캐시하지 않고 요청마다 읽는다
                            "by_mcp": g["by_mcp"], "by_host": g["by_host"],
                            "mcp_configured": g["mcp_configured"],
                            "profiles": _skill_targets(pod), "primary": primary.primary_of(pod.id),
                            "agents": agents,
                            "can_upload": _may_upload(a, user, pod)})
            elif path == "/api/skill/download":               # 스킬 폴더를 zip 으로(OMAI-1195). 보기 권한이 있으면 받을 수 있다
                try:
                    name, blob, excluded = skill_files.build_download(pod.hermes_home, query.get("profile", [""])[0], query.get("path", [""])[0])
                except marketplace.MarketError as exc:
                    self._json(_error_body(exc), exc.code)
                else:
                    extra = {"Content-Disposition": _attachment(f"{name}.zip")}
                    if excluded:
                        extra["X-AAS-Excluded"] = json.dumps(excluded, ensure_ascii=True)     # 헤더는 ASCII 로(화면이 JSON 으로 읽는다)
                    store.log_usage("skill_download", f"{(user or {}).get('email', 'local')} {query.get('profile', [''])[0]}/{name}", pod=pod.id)
                    self._send(200, blob, "application/zip", extra)
            elif path == "/api/skill":
                sid = unquote(query.get("id", [""])[0])
                hit = next((s for s in _skills(pod)["skills"] if s["id"] == sid), None)
                if hit and hit.get("required_env"):              # 설정됐는지는 그때그때 .env 이름만 읽어 붙인다(스킬 묶음은 300초 캐시, 스펙 2026-10-16-010 2단계)
                    root = pod.hermes_home
                    home = root if hit["profile"] == "default" else root / "profiles" / hit["profile"]
                    have = skill_setup.set_names(home / ".env")        # 멀티플렉스는 프로파일마다 비밀값 범위가 따로다 — 그 프로파일의 .env 만 본다
                    hit = {**hit, "required_env": [{**e, "set": e["name"] in have} for e in hit["required_env"]]}
                if hit:
                    hit = {k: v for k, v in hit.items() if k != "_md"}      # AAS 기본 스킬 본문은 요약 원문으로만(스펙 2026-10-27-007 R2)
                    hit = {**hit, "tags": market_tags.skill_tags(market_tags.load(), hit["name"], hit.get("description") or "", hit.get("origin") or "")}
                    hit = skill_desc.apply([hit], 240)[0]
                self._json(hit or {"error": tr("없는 스킬", "Skill not found")}, 200 if hit else 404)
            elif path == "/api/skill/summary":                # 스킬 AI 요약 읽기(스펙 2026-10-17-002). ?id=<스킬> 또는 ?ns=&name=<마켓 패키지>
                try:
                    self._json(skill_summary.view(_summary_target(pod, {k: v[0] for k, v in query.items()})))
                except (skill_summary.SummaryError, marketplace.MarketError) as exc:
                    self._json(_summary_error(exc), exc.code)
            elif path == "/api/flows":
                ix = _flow(pod)
                notes = files.notes_index(pod.id, "jobnote:")
                self._json({"built_at": ix["built_at"], "totals": ix["totals"],
                            "starts": [{**s, "note": " ".join(notes.get("jobnote:" + s["id"][5:], "").split())[:160]} for s in flow.starts(ix)]})
            elif path == "/api/flow":
                sub = flow.subgraph(_flow(pod), unquote(query.get("root", [""])[0]), mentions=query.get("mentions", [""])[0] == "1")
                if sub:
                    try:
                        sub = flow.overlay(_flow(pod), sub, _observed(pod))
                    except Exception as exc:              # 실행 기록을 못 읽어도 그림은 보여 준다
                        sub = {**sub, "observed": {"error": type(exc).__name__}}
                self._json(sub or {"error": tr("없는 시작점입니다", "Start point not found")}, 200 if sub else 404)
            elif path == "/api/file/versions":
                self._json({"versions": files.versions(pod.id, unquote(query.get("path", [""])[0]))})
            elif path == "/api/file/diff":
                try:
                    self._json(files.diff(pod.hermes_home, pod.id, unquote(query.get("path", [""])[0]), int(query.get("id", ["0"])[0])))
                except (files.FileError, ValueError) as exc:
                    self._json(_error_body(exc), getattr(exc, "code", 400))
            elif path == "/api/file":
                rel = unquote(query.get("path", [""])[0])
                try:
                    data = files.read(pod.hermes_home, rel)
                    data.update(self._edit_state(a, user, rel, data, pod))
                    data["versions"] = len(files.versions(pod.id, rel))
                    data["siblings"] = files.siblings(pod.hermes_home, rel) if query.get("siblings", [""])[0] == "1" else []
                    store.log_usage("file_view", (user or {}).get("email", ""))
                    self._json(data)
                except files.FileError as exc:
                    self._json(_error_body(exc), exc.code)
            elif path == "/api/profiles/importable":          # 설정을 가져올 수 있는 내 다른 에이전트와 그 프로파일(스펙 2026-10-15-011 단계 4)
                admin = (not a.enabled) or registry().is_admin(user)
                # 만들 에이전트를 고르면(스펙 2026-10-19-018 리뷰 I6) 그 에이전트를 빼고 지금 에이전트는 넣는다 — 만드는 곳과 같은 에이전트에서는 가져오지 않는다
                skip = query.get("target", [""])[0] or pod.id
                mine = [p for p in registry().pods if p.id != skip and (admin or _manages_pod(p, user, a.enabled))] if (admin or user) else []
                sources = []
                for p in mine:
                    try:
                        names = [x.name for x in cron_health.hr.profiles(p.hermes_home)
                                 if not (x.name == primary.ROOT and cron_policy.root_hidden(p.id)) and not pc_import.reserved_name(x.name)]   # 임시 프로파일은 고르개에서 뺀다(OMAI-1444 ROV7)
                    except Exception:                          # 한 에이전트를 못 읽어도 나머지는 보인다
                        continue
                    if names:                                  # 이름·주인 이름: 화면이 「주인 · 에이전트 › 프로파일」로 그린다(스펙 2026-10-19-003)
                        sources.append({"pod": p.id, "profiles": names, **_pod_label(p)})
                self._json({"sources": sources})
            elif path in ("/api/profiles", "/api/profile", "/api/profile/soul/versions", "/api/profile/soul/diff"):
                name = query.get("name", [""])[0]
                try:
                    if path == "/api/profiles" and query.get("all", [""])[0] == "1":   # 내 에이전트 전체(스펙 2026-10-19-018 A1). 기본 응답 모양은 그대로 둔다(대시보드·자산)
                        self._json(_profiles_all(registry(), user, a.enabled, pod))
                    elif path == "/api/profiles":
                        admin = (not a.enabled) or registry().is_admin(user)
                        rows = _visible_profile_rows(pod, admin)
                        can_ack = may_use_market("/api/market/install", pod, user, a.enabled, admin)
                        if can_ack:                                     # 스킬 새 버전은 올릴 수 있는 사람에게만(스펙 2026-10-24-003 R7)
                            rows = _with_market_issues(pod, rows)
                        rows = issue_acks.apply(pod.id, rows, can_ack)   # 확인한 주의·안내는 빼고, 확인할 수 있으면 버튼 표시(§13)
                        owner = _owns_pod(pod, user, a.enabled)
                        manages = _manages_pod(pod, user, a.enabled)       # 만들기·상한은 주인과 팀 관리자, 뱃지(owner)는 주인 표시라 그대로
                        extra = {"can_create": admin or manages}
                        if manages and not admin:                       # 주인에게는 상한과 지금 개수를 알려 추가 단추 옆에 보인다(스펙 2026-10-15-011 D5)
                            extra["profile_limit"] = {"used": owner_guard.profile_count([r["name"] for r in rows], cron_policy.root_hidden(pod.id)), "max": owner_guard.profile_limit()}
                        # 목록 이름 옆 「내 전용」·「<이름>님 전용」 뱃지(2026-10-17-016). 규칙은 상세(/api/profile)의 owner·owner_name 과 같다
                        extra.update(_owner_badge(pod, owner, admin))
                        main = primary.primary_of(pod.id)
                        # 「채팅 기본」 뱃지(2026-10-19-001 R4·디자인 D12). 숨긴 루트는 고를 수 없다
                        chat_first = chat_default.resolve(pod.id, [r["name"] for r in rows if not r.get("hidden_root")], main)
                        self._json({"profiles": rows, "can_edit": admin, "primary": main, "chat_default": chat_first,
                                    "default_model": profiles.default_model(), **extra})
                    elif path == "/api/profile":
                        detail, admin = _profile_detail(pod, name, user), (not a.enabled) or registry().is_admin(user)
                        can_ack = may_use_market("/api/market/install", pod, user, a.enabled, admin)
                        if can_ack:                                     # 스킬 새 버전은 올릴 수 있는 사람에게만(R7)
                            detail["profile"] = _with_market_issues(pod, [detail["profile"]])[0]
                        detail["profile"] = issue_acks.apply(pod.id, [detail["profile"]], can_ack)[0]   # 확인한 주의·안내는 뺀다(§13)
                        public = str((getattr(a, "cfg", None) or {}).get("public_url") or "")
                        if public:                                    # 추가 대화 상자의 콜백 주소 복사(V7). 공개 주소가 없으면 빼고 화면은 칸을 비운다
                            detail["mcp_oauth_callback"] = mcp_oauth_relay.callback_url(public)
                        if detail["profile"].get("is_default") and primary.hide_root(pod.id, True) != "show":
                            detail["profile"]["hidden_root"] = True       # 숨긴 루트는 관리자에게도 읽기 전용(리뷰 D8)
                            admin = False
                        owner = _owns_pod(pod, user, a.enabled)           # 응답의 owner·owner_name 은 주인 표시라 그대로
                        manages = _manages_pod(pod, user, a.enabled)      # 권한 판정은 주인과 팀 관리자
                        package = _market_agent(pod, name)
                        # 지울 수 있는가: 관리자, 또는 주인이고 마켓 에이전트 패키지로 만든 프로파일(리뷰 O4, 디자인 결정 11A)
                        can_delete = not detail["profile"].get("is_default") and (admin or (manages and not _is_primary(pod, name)))
                        # 관리자가 남의 에이전트를 열면 「<이름>님 전용」 태그용 주인 표시 이름을 준다(이메일 전체는 주지 않는다, 스펙 2026-10-15-011 D9)
                        owner_name = office.display_name(pod.owner, office.people()) if (not a.enabled or registry().is_admin(user)) and not owner and pod.owner and pod.owner != "*" else ""
                        if manages and not admin and detail.get("env"):    # 주인 화면: 서버가 막는 변수는 잠금 사유를 함께 준다(디자인 결정 2C, TD5)
                            catalog = {r["name"]: r["category"] for r in detail["env"]}
                            for r in detail["env"]:
                                r["locked"] = owner_guard.env_key_error(r["name"], catalog)
                        secure = self._secrets_ok()
                        may = admin or manages                                # 이 서랍의 탭별 권한과 막힌 이유(디자인 결정 1A, TD1). 문장은 화면이 코드로 고른다
                        hidden = bool(detail["profile"].get("hidden_root"))
                        caps = {t: {"can": may and not hidden, "reason": "" if may and not hidden else ("hidden_root" if hidden else "not_owner")}
                                for t in ("soul", "agents", "config", "skills", "tools", "mcp", "cron")}
                        for t in ("env", "channels"):                       # 비밀값·채널은 암호화된 연결에서만
                            ok_ = may and not hidden and secure
                            caps[t] = {"can": ok_, "reason": "" if ok_ else ("hidden_root" if hidden else "not_owner" if not may else "insecure")}
                        caps["model"] = {"can": admin, "reason": "" if admin else "admin_only_model"}
                        if isinstance(detail.get("agents"), dict) and detail["agents"].get("readonly_reason") is None and not caps["agents"]["can"]:
                            detail["agents"]["readonly_reason"] = "hidden_root" if hidden else "view_only"   # 사유 우선순위의 마지막 둘(스펙 2026-10-19-004 §4-4 11)
                        # main 은 관리자도 이름을 바꾸지 못한다 — rename 분기가 이미 거절한다(2026-10-17-016). 예전 caps 는 관리자에게 열려 있었다
                        main_ = _is_primary(pod, name)
                        caps["rename"] = {"can": (admin or manages) and not main_, "reason": "main_fixed" if main_ else "" if admin or manages else "not_owner"}
                        caps["delete"] = {"can": can_delete, "reason": "" if can_delete else ("main_fixed" if _is_primary(pod, name) else "admin_only")}
                        self._json({**detail, "caps": caps, "can_edit": admin, "owner": owner, "manages": manages, "can_delete": can_delete, "market_package": package,
                                    **({"owner_name": owner_name} if owner_name else {}),
                                    "places": _agent_places(pod, name) if can_delete else None,
                                    "rooms": _soul_rooms(pod, name, user, admin) if admin or manages else None,
                                    "secure": secure})
                    else:
                        wanted = query.get("kind", ["soul"])[0]
                        kind = wanted if wanted in ("config", "agents") else "soul"
                        row = next((r for r in _profile_rows(pod) if r["name"] == name), None)
                        if not row:
                            raise ValueError(tr("없는 프로파일입니다", "Profile not found"))
                        if path.endswith("/versions"):
                            self._json({"versions": files.versions(pod.id, f"{kind}:{name}")})
                        else:
                            cur = _profile_text_io(HermesAPI(hub(pod).auth), kind, name, None if row["is_default"] else name)[0]()
                            self._json(files.diff_text(pod.id, f"{kind}:{name}", cur, int(query.get("id", ["0"])[0])))
                except (HermesError, files.FileError, ValueError) as exc:
                    self._json(_error_body(exc), getattr(exc, "code", 400))
            elif path in ("/api/text/versions", "/api/text/version", "/api/text/diff2", "/api/cron/note"):
                try:
                    if path == "/api/cron/note":
                        self._json(files.note_get(pod.id, f"jobnote:{query.get('profile', [''])[0]}/{query.get('id', [''])[0]}"))
                    else:
                        key = unquote(query.get("key", [""])[0])
                        if not files.valid_key(key):
                            raise ValueError(tr("알 수 없는 글입니다", "Unknown text"))
                        if path.endswith("/versions"):
                            self._json({"versions": files.versions(pod.id, key)})
                        elif path.endswith("/version"):
                            self._json(files.version_view(pod.id, key, int(query.get("id", ["0"])[0])))
                        else:
                            self._json(files.diff_versions(pod.id, key, int(query.get("a", ["0"])[0]), int(query.get("b", ["0"])[0])))
                except (files.FileError, ValueError) as exc:
                    self._json(_error_body(exc), getattr(exc, "code", 400))
            elif path == "/api/market":                      # 마켓플레이스(SkillHub)의 패키지와 이 Hermes 에 설치한 것
                try:                                          # AAS 밖에서 지워진 프로파일의 설치 기록을 내린다(Hermes 에 못 물으면 건너뛴다)
                    names = _cached(f"{pod.id}:profile_names", 15, lambda: [str(p.get("name")) for p in HermesAPI(hub(pod).auth).call("GET", "/api/profiles").get("profiles", [])])
                    marketplace.reconcile(pod.id, names)
                except (HermesError, ChatUnavailable):
                    pass
                cat = _catalog()                                  # 허브 목록은 서버가 10분 모아 둔다(스펙 2026-10-24-003 R20)
                try:
                    found = _market_updates(pod) if cat["ok"] else None
                except Exception:                                 # 사이드카를 못 읽으면 설치 기록 판으로 「새 버전」을 정한다
                    found = None
                out = marketplace.overview(pod.id, cat=cat, rows=found)
                out["admin"] = not a.enabled or registry().is_admin(user)
                out["can_install"] = out["admin"] or _manages_pod(pod, user, a.enabled)     # 주인도 설치·지우기(OMAI-1126)
                out["packages"] = skill_desc.apply(out["packages"], 400, field="summary")   # 패키지 요약 번역(스펙 2026-10-19-017 §9). 저장값은 그대로
                autos = market_publish.auto_versions()                 # 관리자 검토 없이 게시된 판(스펙 2026-10-28-001 D6) — 설치하는 사람에게 보인다
                for pkg_ in out["packages"]:
                    hit_ = autos.get(f"{pkg_.get('namespace')}/{pkg_.get('name')}")
                    if hit_:
                        pkg_["auto_versions"] = hit_
                self._json(out)
            elif path == "/api/market/updates":                # 「새 버전 있음」 목록(스펙 2026-10-24-003 D3-1·R5)
                out = _market_update_list(registry(), pod, user, a.enabled, query.get("scope", ["pod"])[0])
                out["affected"] = market_updates.affected(out["rows"]) if out["admin"] else 0
                self._json(out)
            elif path in ("/api/market/hub/hidden", "/api/market/hub/installed"):   # 「허브에서 숨김」 탭 목록·설치 프로파일 수(관리자, 스펙 2026-10-29-002 DD10·R14)
                if a.enabled and not registry().is_admin(user):
                    self._json({"error": tr("관리자만 할 수 있습니다", "Only admins can do this")}, 403)
                elif path.endswith("/hidden"):
                    self._json({"items": hub_hide.listing()})
                else:
                    ns, name = marketplace.ns_slug(query.get("namespace", [""])[0]), query.get("name", [""])[0]
                    self._json({"count": hub_admin.installed_count(ns, name, [p_.id for p_ in registry().pods]), "builtin": name in skill_bundle.names()})
            elif path == "/api/market/publish":                # 올리기 요청 목록: 관리자는 전체, 주인은 이 POD 것만
                is_admin = not a.enabled or registry().is_admin(user)
                if not may_use_market("/api/market/install", pod, user, a.enabled, is_admin):
                    self._json({"items": [], "admin": False, "can": False})
                else:
                    spaces = marketplace.settings()["namespaces"]
                    known_people = office.people()                     # 요청한 사람·결정한 관리자를 이름으로(주인·팀 관리자도, 2026-10-30)
                    items = [{**r, "who_name": office.person_name(str(r.get("who") or ""), known_people),
                              "decided_by_name": office.person_name(str(r.get("decided_by") or ""), known_people)}
                             for r in market_publish.requests(None if is_admin else pod.id)]
                    self._json({"items": items, "admin": is_admin, "can": True,
                                "namespaces": spaces, "namespace_labels": marketplace.ns_labels(), "auto": publish_auto.config(spaces)})
            elif path == "/api/market/publish/bundle":         # 올린 묶음 내려받기(관리자만)
                p_ = market_publish.bundle_path(query.get("id", [""])[0])
                if not (not a.enabled or registry().is_admin(user)) or p_ is None:
                    self._json({"error": "not found"}, 404)
                else:
                    self._send(200, p_.read_bytes(), "application/zip", {"Content-Disposition": _attachment(f"{p_.stem}.zip")})
            elif path == "/api/market/archived":              # 큐레이터가 보관한 스킬(되살리기 후보). 설치 권한이 있는 사람만 본다
                if not may_use_market(path, pod, user, a.enabled, registry().is_admin(user)):
                    self._json({"items": []})
                else:
                    try:
                        self._json({"items": skill_keep.archived(pod.hermes_home)})
                    except OSError:
                        self._json({"items": [], "error": tr("보관된 스킬을 읽지 못했습니다", "Could not read archived skills")})
            elif path == "/api/market/package":
                try:                                          # ns 는 표시 이름(shared)도 받는다 — package() 가 slug 로 바꾼다(스펙 2026-10-28-010 D7)
                    pkg = marketplace.package(query.get("ns", [""])[0], query.get("name", [""])[0])
                    pkg["allowed"] = marketplace.allowed(pod.id, pkg)
                    self._json(skill_desc.apply([pkg], 400, field="summary")[0])
                except marketplace.MarketError as exc:
                    self._json(_error_body(exc), exc.code)
            elif path == "/api/changes":
                days = max(1, min(90, int(query.get("days", ["30"])[0] or 30)))
                if not a.enabled or registry().is_admin(user):   # 전체 변경 기록은 관리자만(OMAI-1122, 스펙 2026-10-13-012 D3)
                    self._json({"days": days, "rows": _admin_change_rows(days)})
                elif _manages_pod(pod, user, a.enabled):           # 주인과 팀 관리자는 지금 POD 의 자기 기간 기록만(OMAI-1126 리뷰 O7, 재검토 L6, 스펙 2026-10-22-001 R5)
                    since = registry().owner_since(pod)
                    rows = _owner_change_rows(pod, user, days)
                    owner = _owns_pod(pod, user, a.enabled)
                    self._json({"days": days, "rows": _with_who_names(rows), "owner": owner, **({"team_managers": _pod_team_manager_names(pod)} if owner else {"team_manager": True}),
                                "pod": pod.id, "pod_name": _pod_label(pod)["name"], "since": since})
                else:
                    self._json({"error": tr("이 AI 에이전트 작업공간의 소유자가 아니어서 기록을 볼 수 없습니다.", "You are not the owner of this AI Agent Workspace, so you cannot view its history.")}, 403)
            elif path == "/api/cron/explain":                # 이 작업(또는 이 스킬을 돌리는 작업)이 하게 될 일
                prof = query.get("profile", [""])[0]
                chan = next((r for r in _channels(pod)["profiles"] if r["name"] == prof), None)
                gw = {"running": chan["running"], "channels": [{"name": p["name"], "state": p.get("state"), "stale": p.get("stale")} for p in chan["platforms"]]} if chan else None
                try:
                    obs = _observed(pod)
                except Exception:
                    obs = None
                self._json(explain.build(_flow(pod), pod.hermes_home, prof, query.get("skill", [""])[0], query.get("job", [""])[0],
                                         obs, gw, query.get("deliver", [""])[0]))
            elif path == "/api/cron/jobs":                   # 한 프로파일의 작업 목록 — 프로파일 서랍 「크론」 탭(스펙 2026-10-15-003 R2). Hermes 에 직접 묻는다
                prof = query.get("profile", [""])[0]
                try:
                    res = HermesAPI(hub(pod).auth).call("GET", "/api/cron/jobs", query={"profile": prof})
                    jobs = res.get("jobs", []) if isinstance(res, dict) else res
                    self._json({"profile": prof, "jobs": [job_view(j) for j in (jobs or []) if isinstance(j, dict) and j.get("id")],
                                "can_edit": may_change_cron(pod, user, a.enabled, (not a.enabled) or registry().is_admin(user))})
                except HermesError as exc:
                    self._json(_error_body(exc), exc.code)
            elif path == "/api/cron/job":                    # 한 작업의 지금 상태와 최근 실행 — Hermes 에 직접 묻는다
                prof, jid = query.get("profile", [""])[0], query.get("id", [""])[0]
                try:
                    api = HermesAPI(hub(pod).auth)
                    job = api.call("GET", f"/api/cron/jobs/{quote(jid, safe='')}", query={"profile": prof})
                    try:
                        runs = api.call("GET", f"/api/cron/jobs/{quote(jid, safe='')}/runs", query={"profile": prof, "limit": 10})
                    except HermesError:
                        runs = []
                    runs = runs.get("runs", []) if isinstance(runs, dict) else runs
                    try:
                        tg = api.call("GET", "/api/cron/delivery-targets")
                        targets = [{"id": str(t.get("id")), "name": str(t.get("name") or t.get("id")), "ready": t.get("home_target_set") is not False}
                                   for t in (tg.get("targets", []) if isinstance(tg, dict) else tg) if isinstance(t, dict) and t.get("id")]
                    except HermesError:
                        targets = []
                    raw_job = job.get("job", job) if isinstance(job, dict) else {}
                    ptext = str(raw_job.get("prompt") or "")
                    self._json({"profile": prof, "targets": targets, "muted": mutes.get(prof, jid),
                                "prompt_doc": {**profiles.soul_view(ptext), "sha": files.text_sha(ptext), "versions": len(files.versions(pod.id, f"jobprompt:{prof}/{jid}"))},
                                "note_doc": files.note_get(pod.id, f"jobnote:{prof}/{jid}") if files.valid_key(f"jobnote:{prof}/{jid}") else None, "job": job_view(job.get("job", job) if isinstance(job, dict) else {}),
                                "runs": [run_view(r) for r in (runs or []) if isinstance(r, dict)][:10],
                                "can_edit": may_change_cron(pod, user, a.enabled, (not a.enabled) or registry().is_admin(user))})     # 관리자와 그 파드의 주인(크론·메모·무시)
                except HermesError as exc:
                    self._json(_error_body(exc), exc.code)
            elif path == "/api/agents":
                self._json(_agents_list(registry(), user, a.enabled))
            elif path in ("/api/agents/sizes", "/api/agents/capacity"):    # 작업공간 크기·남은 자리(스펙 2026-10-30-003 §4-4·§4-5)
                try:
                    self._json(_agents_sizes(registry(), user, a.enabled) if path == "/api/agents/sizes" else _agents_capacity(registry(), user, a.enabled, query))
                except agents.AgentError as exc:
                    self._json(_error_body(exc), exc.code)
            elif path == "/api/agents/profiles":            # 「수정」 대화 상자(스펙 2026-10-19-001 R5·L6)
                try:
                    self._json(_agent_profiles(registry(), user, a.enabled, query.get("name", [""])[0]))
                except agents.AgentError as exc:
                    self._json(_error_body(exc), exc.code)
            elif path in OFFICE_READ or path.startswith(OFFICE_REST):
                self._office_rest("GET", a, user, path, query, {})
            elif path == "/api/office":
                self._json(_office(registry(), user, a.enabled))
            elif path == "/api/office/people":            # 방 담당이 구성원을 고를 때 쓰는 이름·열쇠 목록(이메일 없음, 2026-10-18-009)
                self._json({"people": office.person_directory()})
            elif path == "/api/office/layout":
                self._json({**office.layout(), "desks": office.desk_assignments()})
            elif path == "/api/office/cards":
                self._json(_office_cards(office_access.Access(registry(), user, a.enabled)))
            elif path == "/api/office/inbox":
                self._json(_office_inbox(registry(), user))
            elif path == "/api/requests":                    # 내가 이 에이전트에서 처리를 기다리는 요청(막힌 자리에 「처리 대기 중」을 보인다)
                self._json({"waiting": admin_requests.waiting_for(str((user or {}).get("email") or ""), pod.id) if user and pod else []})
            elif path == "/api/office/state":
                with store.request_memo():                   # 같은 요청 안에서 같은 DB 읽기를 한 번만(스펙 2026-10-24-006 §6)
                    self._json(_office_snapshot_for(office_access.Access(registry(), user, a.enabled)))
            elif path == "/api/office/stream":
                self._office_stream(query, a, user)
            elif path == "/api/trend":                       # 관리자는 전체, 그 밖은 볼 수 있는 POD 의 줄만·전체 합계 값 없이(계획 2026-10-14-014 R2·R6)
                reg = registry()
                admin = (not a.enabled) or reg.is_admin(user)
                ids = None if admin else [p.id for p in reg.allowed(user, a.enabled)]
                self._json({"baseline_ts": store.baseline_ts(), "trend": store.trend(dashboard.TREND_DAYS, ids, totals=admin)})
            elif path == "/api/dashboard":                   # 대시보드: DB 만 읽는다 — Hermes·사이드카를 부르지 않는다(R1)
                self._json(dashboard.view(registry(), user, a.enabled))
            elif path == "/api/activity":
                days = 30 if query.get("days", ["7"])[0] == "30" else 7
                admin = (not a.enabled) or registry().is_admin(user)
                # 프로파일 이름 옆 「내 전용」·「<이름>님 전용」(프로파일 목록과 같은 규칙, 2026-10-18). 모은 값은 함께 쓰므로 사람별 값은 캐시 밖에서 붙인다
                self._json({**_cached(f"{pod.id}:activity{days}", 60, lambda: activity.collect(days, home=pod.hermes_home)),
                            **_owner_badge(pod, _owns_pod(pod, user, a.enabled), admin)})   # 주인 표시라 그대로
            elif path in ("/api/credentials", "/api/tools", "/api/libraries"):
                kind = path.rsplit("/", 1)[1]
                fn = getattr(inventory, kind)
                self._json(_cached(f"{pod.id}:{kind}", 120, lambda: fn(pod.hermes_home)))
            elif path == "/api/channels":
                self._json({**_channels(pod), "owner_name": _pod_owner_name(pod)})
            elif path == "/api/channels/platforms":          # 프로파일 서랍 「채널」 탭: Hermes 의 채널 설정 상태(스펙 2026-10-15-003). 관리자와 주인이 보고 페어링 목록은 관리자만
                prof = query.get("profile", [""])[0]
                admin = (not a.enabled) or registry().is_admin(user)
                if not (admin or _manages_pod(pod, user, a.enabled)):
                    self._json({"error": tr("관리자나 이 AI 에이전트 작업공간의 소유자만 볼 수 있습니다", "Only admins or the AI Agent Workspace's owner can see this")}, 403)
                elif prof not in {r["name"] for r in _profile_rows(pod)}:
                    self._json({"error": tr("없는 프로파일입니다", "Profile not found")}, 400)
                else:
                    try:
                        scoped = None if next((r for r in _profile_rows(pod) if r["name"] == prof), {}).get("is_default") else prof
                        self._json(_cached(f"{pod.id}:chanhermes:{prof}:{int(admin)}", 20, lambda: channel_admin.read(HermesAPI(hub(pod).auth), scoped, True)))
                    except HermesError as exc:
                        self._json(_error_body(exc), exc.code)
            elif path == "/api/models":
                self._json(_models(pod))
            elif path == "/api/chat/status":
                if query.get("all", [""])[0] == "1":            # 채팅 목록의 에이전트별 묶음(2026-10-19-001 R2). 기본 응답 모양은 그대로 둔다(스킬 허브 useAgents)
                    self._json({"pod": pod.id, "groups": _chat_groups(registry(), user, a.enabled, pod)})
                else:
                    self._json(_chat_status(pod))
            elif path == "/api/chat/sessions":                 # 세션 목록(모든 내 에이전트의 열린 대화와 상태)
                hidden, hidden_stored = _chat_hidden(registry(), user, a.enabled, pod)
                self._json({"pod": pod.id, "sessions": _chat_sessions(registry(), user, a.enabled, pod),
                            "hidden": hidden, "hidden_stored": hidden_stored})
            elif path == "/api/chat/history":
                profile = _chat_profile(pod, query.get("profile", [""])[0])
                if profile not in {p.name for p in cron_health.hr.profiles(pod.hermes_home)}:
                    self._json({"error": tr("없는 프로파일", "Profile not found")}, 400)
                    return
                # 회의가 만든 세션(오피스 등록부의 meeting-*)은 뺀다 — 새 대화마다 에이전트별로 늘어 주인의 대화를 밀어낸다(스펙 2026-10-20-027 R11)
                hidden = office.meeting_stored_ids()
                if query.get("exclude_hidden", [""])[0] == "1":  # 세션 칸 「완료」만 닫은 대화를 뺀다 — 「지난 대화」 서랍에는 보인다(스펙 2026-11-06-002 E2)
                    hidden = set(hidden) | chat_hidden.stored_ids(str((user or {}).get("email") or "") if a.enabled else "", [pod.id])[pod.id]
                # 보일 줄 수(기본 80, 세션 칸의 「1주일」은 200). 회의 세션을 거른 뒤 자른다
                try:
                    want = max(1, min(200, int(query.get("limit", ["80"])[0] or 80)))
                except ValueError:
                    want = 80
                rows = [r for r in hub(pod).history(profile, limit=max(200, want)) if r.get("id") not in hidden][:want]
                # Claude Code 가 연 대화: 목록 Tag·「스킬 시험」 거름·쓰는 중 띠(스펙 2026-10-28-001 §3-7 ⑤)
                meta = chat_session_meta.for_stored(pod.id, [str(r.get("id") or "") for r in rows])
                for r in rows:
                    m = meta.get(str(r.get("id") or ""))
                    if m and m["via"] == "token":
                        r["claude"] = {"purpose": m["purpose"], "active": m["active"]}
                self._json({"profile": profile, "sessions": rows})
            elif path == "/api/chat/skills":                   # 입력창 / 목록(스펙 2026-10-19-012 P1). 고른 에이전트(pod)·프로파일 기준, 60초 저장
                profile = _chat_profile(pod, query.get("profile", [""])[0])
                if profile not in {p.name for p in cron_health.hr.profiles(pod.hermes_home)}:
                    self._json({"error": tr("없는 프로파일", "Profile not found")}, 400)
                    return
                got = skill_commands.cached(hub(pod), profile)
                self._json({"profile": profile, **{k: v for k, v in got.items() if k != "blocked"},
                            "skills": skill_desc.apply(got.get("skills"), skill_commands.DESC_MAX),
                            **chat_commands.view(got, manages=_chat_manages(a, user, pod))})   # 명령 목록(스펙 2026-10-26-010). goal·loop 는 주인·관리자만(2026-10-27-002 R12)
            elif path == "/api/chat/events":
                self._chat_events(query, pod)
            else:
                self._json({"error": "not found"}, 404)
        except ChatUnavailable as exc:
            self._json({"error": str(exc)}, 503)
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception as exc:
            self._json({"error": f"{type(exc).__name__}: {exc}"}, 500)

    def _office_rest(self, method: str, a, user, path: str, query: dict, body: dict):
        """칸반·크론·회의(오피스 API). 접근 규칙은 office_access: 관리자는 모두, 그 밖은 보이는 자리·구성원인 방에서만."""
        who = (user or {}).get("email", "local")
        room = _room_note(body if isinstance(body, dict) else {}, query) if method != "GET" else ""   # 방을 지우는 요청도 있어 바꾸기 전에 읽는다
        try:
            acc = office_access.Access(registry(), user, a.enabled)
            status, out = _office_route(acc, method, path, query, body if isinstance(body, dict) else {}, who)
        except office_access.Denied as exc:
            if method != "GET":
                store.log_usage("office_denied", f"{who} {method} {path[:80]}")
            self._json(_error_body(exc), exc.code)
            return
        except meeting.MeetingError as exc:
            self._json(_error_body(exc), exc.code)
            return
        except hub_auto.Fail as exc:
            if method != "GET":
                store.log_usage("office_failed", f"{who} {method} {path[:80]} {exc.code}")
            self._json({"error": exc.code, "detail": exc.detail}, exc.status)
            return
        if method != "GET":
            store.log_usage("office_change", f"{who} {method} {path[:80]}{room}")
            topics.invalidate("office:kanban:")               # 칸반·회의를 보고 있는 화면에 곧바로 보낸다(OMAI-1100)
            topics.invalidate("office:meeting:")
        self._json(out, status)

    def _office_rest_other(self, method: str):
        """PUT·PATCH·DELETE 는 칸반·크론 경로에서만 받는다."""
        self._role_token = None
        try:
            self._office_rest_other_inner(method)
        finally:
            if self._role_token is not None:
                store.actor_role.reset(self._role_token)

    def _office_rest_other_inner(self, method: str):
        path = urlsplit(self.path).path
        try:
            if not path.startswith(OFFICE_REST):
                self._json({"error": "not found"}, 404)
                return
            if not self._host_ok():
                self._json({"error": tr("허용되지 않은 주소", "Address not allowed")}, 400)
                return
            if not self._same_origin():
                self._json({"error": "forbidden"}, 403)
                return
            a, user, pod = self._context()
            if a.enabled and not user:
                self._json({"error": tr("로그인이 필요합니다", "Sign in required"), "login": "/auth/login"}, 401)
                return
            if pod is None:
                self._json({"error": tr("연결된 POD 가 없습니다", "No POD is linked to this account")}, 403)
                return
            length = int(self.headers.get("Content-Length") or 0)
            if length > MAX_BODY:
                self._json({"error": "too large"}, 413)
                return
            body = json.loads(self.rfile.read(length) or b"{}") if length else {}
            self._mark_actor_role(a, user, pod)
            self._office_rest(method, a, user, path, parse_qs(urlsplit(self.path).query), body)
        except ValueError:
            self._json({"error": tr("잘못된 요청", "Invalid request")}, 400)
        except Exception as exc:
            self._json({"error": f"{type(exc).__name__}: {exc}"}, 500)

    def do_PUT(self):  # noqa: N802
        self._office_rest_other("PUT")

    def do_PATCH(self):  # noqa: N802
        self._office_rest_other("PATCH")

    def do_DELETE(self):  # noqa: N802
        self._office_rest_other("DELETE")

    def _office_stream(self, query: dict, a, user):
        """오피스 SSE. Last-Event-ID 가 있고 이벤트가 남아 있으면 그 뒤만 이어 주고, 아니면 snapshot 으로 시작한다.
        20초마다 keepalive 를 보낸다(Ingress 60초 제한)."""
        if self.headers.get("Sec-Fetch-Site", "same-origin") not in ("same-origin", "none"):
            self._json({"error": "forbidden"}, 403)
            return
        raw = self.headers.get("Last-Event-ID") or query.get("after", [""])[0]
        after = int(raw) if str(raw).isdigit() else None
        self.start_stream(_office_events(after, a, user))

    def _chat_events(self, query: dict, pod: Pod):
        """SSE. 브라우저가 Last-Event-ID 로 이어 받는다."""
        if self.headers.get("Sec-Fetch-Site", "same-origin") not in ("same-origin", "none"):
            self._json({"error": "forbidden"}, 403)
            return
        sid = query.get("session_id", [""])[0]
        after = int(self.headers.get("Last-Event-ID") or query.get("after", ["0"])[0] or 0)
        h = hub(pod)
        h.events_after(sid, 10**12, wait=0)          # 모르는 세션이면 여기서 ChatUnavailable
        self.start_stream(_chat_event_stream(h, sid, after))

    def start_stream(self, gen) -> None:
        """SSE 응답 본문(바이트 조각을 내는 동기 생성기)을 넘긴다. 실제 전송은 ASGI 어댑터(legacy.py)가 전용 실행기에서 한다(OMAI-1100)."""
        raise NotImplementedError("Handler runs only through legacy.AdaptedHandler")

    def _soul_templates_post(self, path: str, body: dict, a, user, pod) -> None:
        """만들기·고치기·지우기·되돌리기는 관리자만. render 는 자리 표시를 채운 SOUL 전체를 돌려준다(저장하지 않는다)."""
        me = (user or {}).get("email", "local")
        try:
            if path == "/api/soul-templates/render":
                tid, lang, profile = str(body.get("id") or ""), str(body.get("lang") or ""), str(body.get("profile") or "")
                item = soul_templates.get(tid, lang) if tid else None
                if "body" in body:                          # 편집 중인 본문 미리 보기
                    item = {"name": str(body.get("name") or (item or {}).get("name") or ""), "body": str(body.get("body") or "")}
                if item is None:
                    raise soul_templates.TemplateError(tr("없는 템플릿입니다", "Template not found"), 404)
                self._json({"content": soul_templates.render(item, _soul_template_values(pod, profile, user)), "rev": item.get("rev", 0)})
                return
            if a.enabled and not registry().is_admin(user):
                self._json({"error": tr("관리자만 할 수 있습니다", "Only admins can do this")}, 403)
                return
            op, tid, lang = str(body.get("op") or "save"), str(body.get("id") or ""), str(body.get("lang") or "")
            if op == "save":
                out = soul_templates.save(body, me)
                store.log_usage("soul_template_create" if not tid else "soul_template_update", f"{me} {out['id']}.{out['lang']} rev={out['rev']}")
            elif op == "delete":
                soul_templates.delete(tid, lang, me)
                store.log_usage("soul_template_delete", f"{me} {tid}.{lang}")
                out = {"id": tid, "lang": lang}
            elif op == "reset":
                out = soul_templates.reset(tid, lang)
                store.log_usage("soul_template_reset", f"{me} {tid}.{lang}")
            elif op == "default":                          # 부서에 맞는 템플릿이 없는 새 사용자에게 쓸 템플릿(스펙 2026-10-14-003 리뷰 D9). 비우면 없음
                if tid and not soul_templates.get(tid, lang):
                    raise soul_templates.TemplateError(tr("없는 템플릿입니다", "Template not found"), 404)
                out = {"default_template": settings.set_default_template(f"{tid}.{lang}" if tid else "", me)}
                store.log_usage("soul_template_default", f"{me} {out['default_template'] or '-'}")
            elif op == "revert":
                out = soul_templates.revert(tid, lang, int(body.get("rev") or 0), me)
                store.log_usage("soul_template_update", f"{me} {tid}.{lang} rev={out['rev']} revert={int(body.get('rev') or 0)}")
            else:
                raise soul_templates.TemplateError(tr("알 수 없는 요청", "Unknown request"))
            self._json({"ok": True, "template": out})
        except soul_templates.TemplateError as exc:
            self._json({"error": str(exc)}, exc.code)

    # ---- 스킬 올리기(OMAI-1195) --------------------------------------------
    def _admin_request(self, body: dict, a, user, pod: Pod | None) -> None:
        """관리자에게 요청 만들기. 요청자는 이 파드의 주인이거나 관리자, 프로파일은 실제로 있어야 하고 숨긴 루트는 안 된다. 로그인이 꺼진 모드에서는 받을 사람이 없어 거절한다."""
        def refuse(message: str, code: int = 400) -> None:
            self._json({"error": message}, code)
        if not a.enabled:
            return refuse(tr("로그인을 켜지 않은 환경에서는 관리자에게 요청할 수 없습니다", "Requests to admins need sign-in to be enabled"))
        if pod is None or not (registry().is_admin(user) or _manages_pod(pod, user, a.enabled)):
            return refuse(tr("이 AI 에이전트 작업공간의 소유자나 관리자만 요청할 수 있습니다", "Only the AI Agent Workspace's owner or an admin can send a request"), 403)
        profile = str(body.get("profile") or "")
        if profile not in {x.name for x in cron_health.hr.profiles(pod.hermes_home)} or cron_policy.root_hidden(pod.id) and profile == primary.ROOT:
            return refuse(tr("없는 프로파일입니다", "Profile not found"))
        try:
            rid = admin_requests.create(pod.id, profile, str((user or {}).get("email") or ""), str(body.get("kind") or ""), str(body.get("detail") or ""))
        except admin_requests.RequestError as exc:
            return refuse(str(exc), exc.code)
        store.log_usage("admin_request", f"{(user or {}).get('email', 'local')} {profile} {str(body.get('kind'))[:40]}", pod=pod.id)
        topics.invalidate("office:inbox:")                    # 관리자들의 받은편지함에 곧바로(스펙 2026-10-17-004)
        self._json({"ok": True, "id": rid})

    def _skill_upload(self, a, user, pod: Pod) -> None:
        """POST /api/skill/upload?profile=<위치> — 본문 = zip. 검사해 임시로 보관하고 미리 보기 값(해시·이름·스크립트·충돌)을 돌려준다. 적용하지 않는다(DR13)."""
        if not _may_upload(a, user, pod):
            self._json({"error": tr("관리자나 이 AI 에이전트 작업공간의 소유자만 올릴 수 있습니다", "Only admins or the owner of this AI Agent Workspace can upload skills")}, 403)
            return
        length = int(self.headers.get("Content-Length") or 0)
        if length > skill_files.UPLOAD_MAX:
            self._json({"error": tr(f"스킬 묶음이 너무 큽니다(한도 {skill_files.UPLOAD_MAX // 1024}KiB)", f"The skill bundle is too large (limit {skill_files.UPLOAD_MAX // 1024} KiB)")}, 413)
            return
        who = (user or {}).get("email", "local")
        try:
            blob = self.rfile.read(length)
            info = skill_files.inspect(blob)
            profile = parse_qs(urlsplit(self.path).query).get("profile", [""])[0]
            info["conflict"] = bool(info["name"]) and bool(profile) and info["name"] in _skill_taken(pod, profile)
            info["hash"] = skill_files.keep(blob, pod.id, who)
        except marketplace.MarketError as exc:
            self._json(_error_body(exc), exc.code)
            return
        self._json(info)

    def _hub_upload(self, a, user) -> None:
        """POST /api/market/publish/upload?expected=<ns/name> — 본문 = zip. 검사·임시 보관하고 미리 보기를 돌려준다. 게시하지 않는다(스펙 2026-10-29-002)."""
        if a.enabled and not registry().is_admin(user):
            self._json({"error": tr("관리자만 할 수 있습니다", "Only admins can do this")}, 403)
            return
        length = int(self.headers.get("Content-Length") or 0)
        if length > skill_files.UPLOAD_MAX:
            self._json({"error": tr(f"스킬 묶음이 너무 큽니다(한도 {skill_files.UPLOAD_MAX // 1024}KiB)", f"The skill bundle is too large (limit {skill_files.UPLOAD_MAX // 1024} KiB)")}, 413)
            return
        who = (user or {}).get("email", "local")
        try:
            blob = self.rfile.read(length)
            info = skill_files.inspect(blob)
            out = hub_admin.preview(skill_files._read_zip(blob), info, [p_.id for p_ in registry().pods],
                                    parse_qs(urlsplit(self.path).query).get("expected", [""])[0])
            out["hash"] = skill_files.keep(blob, HUB_ADMIN_KEY, who)
        except marketplace.MarketError as exc:
            self._json(_error_body(exc), exc.code)
            return
        self._json(out)

    def _skill_delete(self, a, user, pod: Pod, body: dict) -> None:
        """POST /api/skill/delete {id} — 내가 만들거나 올린 스킬(출처 local·agent)을 Hermes 보관함(skills/.archive)으로 옮긴다(스펙 2026-10-29-005).
        항목은 서버가 스킬 목록에서 id 로 찾고, 권한·출처·같은 이름·이름 규칙을 그 항목으로 다시 본다(R1·R8·R10). Hermes 가 실패하거나 늦으면
        목록을 다시 읽어 실제로 없어졌으면 성공으로 답한다(R11)."""
        who = (user or {}).get("email", "local")
        sid = str(body.get("id") or "")
        s = next((r for r in _skills(pod)["skills"] if r["id"] == sid), None)
        if s is None:
            self._json({"error": tr("스킬을 찾을 수 없습니다", "Skill not found")}, 404)
            return
        prof, name = s["profile"], s["name"]
        refused = content_gate(pod, user, a.enabled, registry().is_admin(user), prof)
        if refused:
            self._json({"error": refused}, 403)
            return
        blocked = skill_delete_block(s, _skills(pod)["skills"])
        if blocked:
            self._json({"error": SKILL_DELETE_REASONS[blocked](), "reason": blocked}, SKILL_DELETE_CODES[blocked])
            return
        target = None if prof == primary.ROOT else prof
        try:
            HermesAPI(hub(pod).auth).call("DELETE", "/api/learning/node", {"id": name, "profile": target}, query={"profile": target})
        except HermesError as exc:
            _drop_pod_key(pod, "skills")                                # 실패·시간 초과여도 보관됐을 수 있다 — 목록을 새로 읽어 본다(R11)
            if any(r["id"] == sid for r in _skills(pod)["skills"]):
                store.log_usage("skill_delete_failed", f"{who} {prof}/{name}", pod=pod.id)
                pinned = "pinned" in str(exc)
                self._json({"error": tr("고정된 스킬입니다. 고정을 푼 뒤 지우세요", "This skill is pinned. Unpin it, then delete it") if pinned
                            else tr("스킬을 지우지 못했습니다. 잠시 뒤 다시 시도하세요", "Could not delete the skill. Try again shortly"),
                            "reason": "pinned" if pinned else "hermes", "detail": str(exc)[:300]}, 409)
                return
        files.forget_key(pod.id, f"{s['path']}/SKILL.md")              # 같은 경로로 다시 올린 스킬이 옛 버전과 비교되지 않게(R2)
        store.log_usage("skill_delete", f"{who} {prof}/{name}", pod=pod.id)
        _drop_pod_key(pod, "skills")
        threading.Thread(target=_rebuild_flow, args=(pod,), daemon=True).start()
        threading.Thread(target=_reload_skill_commands, args=(pod, prof), daemon=True).start()   # 실행 중 게이트웨이의 /스킬 목록에서도 빼게(OV6)
        self._json({"ok": True, "name": name, "profile": prof})

    def _skill_apply(self, a, user, pod: Pod, body: dict) -> None:
        """POST /api/skill/apply {hash, profile, name?, confirm_scripts?} — 보관해 둔 검사 결과를 적용한다. SKILL.md 만 든 묶음은 Hermes 스킬 API 로,
        파일이 든 묶음은 HermesTask 로 skills/uploaded/<이름>/ 에 놓는다(R6)."""
        if not _may_upload(a, user, pod):
            self._json({"error": tr("관리자나 이 AI 에이전트 작업공간의 소유자만 올릴 수 있습니다", "Only admins or the owner of this AI Agent Workspace can upload skills")}, 403)
            return
        who = (user or {}).get("email", "local")
        profile = str(body.get("profile") or primary.primary_of(pod.id))
        reload = ""
        try:
            if profile == primary.ROOT and cron_policy.root_hidden(pod.id):
                raise ValueError(tr("이 AI 에이전트 작업공간의 루트(default)에는 스킬을 올릴 수 없습니다. 주 프로파일(main)을 고르세요.", "Skills cannot be uploaded to the root (default). Choose the main profile."))
            if profile not in _skill_targets(pod):
                raise ValueError(tr("없는 프로파일입니다", "Profile not found"))
            blob = skill_files.recall(str(body.get("hash") or ""), pod.id, who)
            plan = skill_files.prepare(blob, str(body.get("name") or ""), _skill_taken(pod, profile), bool(body.get("confirm_scripts")))
            state = "done"
            if plan["only_skill_md"]:
                HermesAPI(hub(pod).auth).call("POST", "/api/skills", {"name": plan["name"], "content": plan["content"].rstrip("\n") + "\n",
                                                                       "category": skill_files.UPLOAD_CATEGORY, "profile": None if profile == "default" else profile})
            else:
                client = _upload_client()
                if client is None:
                    raise ValueError(tr("이 환경에서는 스크립트·참고 파일이 든 스킬을 올릴 수 없습니다. SKILL.md 한 장만 올리세요.", "Skills with scripts or reference files cannot be uploaded in this environment. Upload a single SKILL.md."))
                if profile == primary.ROOT:
                    raise ValueError(tr("공용(루트) 프로파일에는 파일이 든 스킬을 올릴 수 없습니다 — Hermes 가 막습니다", "Skills with files cannot be uploaded to the shared (root) profile. Hermes blocks it"))
                state = skill_files.send_bundle(client, pod.id, profile, plan["name"], plan["files"], who)
                if state == "done":
                    reload = _reload_skill_commands(pod, profile)
        except (HermesError, ValueError, marketplace.MarketError) as exc:
            store.log_usage("skill_upload_failed", f"{who} {profile}", pod=pod.id)
            self._json(_error_body(exc), getattr(exc, "code", 400))
            return
        store.log_usage("skill_upload", f"{who} {profile}/{plan['name']} {plan['hash'][:12]} scripts={len(plan['scripts'])}", pod=pod.id)
        _drop_pod_key(pod, "skills")
        if state == "done":                                   # pending 이면 아직 놓이지 않았다 — 다음 저장 때 적힌다
            _note_authored(pod, who, profile, plan["name"])
        threading.Thread(target=_rebuild_flow, args=(pod,), daemon=True).start()
        self._json({"ok": True, "name": plan["name"], "profile": profile, "state": state, "scripts": len(plan["scripts"]),
                    **({"reload": reload} if reload else {})})

    # ---- POST -------------------------------------------------------------
    def do_POST(self):  # noqa: N802
        self._role_token = None
        try:
            self._do_post()
        finally:                                              # 예외로 끝나도 다음 요청에 팀 관리자 표시가 남지 않게 한다
            if self._role_token is not None:
                store.actor_role.reset(self._role_token)

    def _mark_actor_role(self, a, user, pod) -> None:
        """이 요청의 기록에 작성자 자격(관리자·팀 관리자·다른 사람)을 켠다. 주인이면 켜지 않는다.
        요청을 시작할 때 쿠키로 고른 에이전트 기준이다(리뷰 R3=B, 알려진 한계, D15)."""
        role = _actor_role(pod, user, a.enabled)
        if role:
            self._role_token = store.actor_role.set(role)

    def _do_post(self):
        path = urlsplit(self.path).path
        try:
            if not self._host_ok():
                self._json({"error": tr("허용되지 않은 주소", "Address not allowed")}, 400)
                return
            if path == "/auth/password":
                self._password_login()
                return
            if not (path.startswith("/api/chat/") or path.startswith(OFFICE_REST) or path in ("/api/session/touch", "/api/settings", "/api/notices", TTS_PREVIEW_PATH, "/api/soul-templates", "/api/soul-templates/render", "/api/models/probe", "/api/pod", "/api/registry", "/api/cron/action", "/api/file/save", "/api/file/revert", "/api/file/preview", "/api/profile/action", "/api/cron/mute", "/api/cron/note", "/api/text/label", "/api/skill/create", "/api/skill/upload", "/api/skill/apply", "/api/skill/delete", "/api/users/logout", "/api/users/set", *USER_WRITES, *DEPARTMENT_WRITES, *SELF_WRITES, *TOKEN_WRITES, "/api/office/action", "/api/office/layout", "/api/office/presence", "/api/office/face", "/api/office/inbox/answer", "/api/requests", "/api/settings/goal", "/api/settings/goal/suggest", "/api/office/brief/suggest", "/api/agents", "/api/agents/delete", "/api/agents/limit", "/api/agents/resume", "/api/agents/owner", "/api/agents/update", *ROLLOUT_WRITES, *SIZE_WRITES, "/api/market/install", "/api/market/grant", "/api/market/remove", "/api/market/restore", "/api/market/updates/queue", "/api/market/updates/skip", "/api/market/updates/seen", "/api/market/updates/auto", "/api/profile/issue/ack", "/api/market/publish", "/api/market/publish/check", "/api/market/publish/decide", "/api/market/publish/auto", *HUB_ADMIN_WRITES, "/api/market/tags/refresh", "/api/skill/summary", "/api/skill/retranslate", "/api/mcp/oauth/start", "/api/mcp/oauth/cancel")):
                self._json({"error": "not found"}, 404)
                return
            if not self._same_origin():
                self._json({"error": "forbidden"}, 403)
                return
            a, user, pod = self._context()
            if a.enabled and not user:
                self._json({"error": tr("로그인이 필요합니다", "Sign in required"), "login": "/auth/login"}, 401)
                return
            if path == "/api/skill/upload":                  # 본문이 zip 바이트라 JSON 이 아니다. 한도는 이 경로에서만 512KiB(OMAI-1195 R2)
                self._skill_upload(a, user, pod)
                return
            if path == "/api/market/publish/upload":         # 관리자 직접 게시 미리 보기 — 본문이 zip(스펙 2026-10-29-002, 한도는 설치 묶음과 같은 512KiB R1)
                self._hub_upload(a, user)
                return
            length = int(self.headers.get("Content-Length") or 0)
            if length > body_limit(path):
                self._json({"error": "too large"}, 413)
                return
            body = json.loads(self.rfile.read(length) or b"{}")
            if path in ("/api/mcp/oauth/start", "/api/mcp/oauth/cancel"):   # MCP 서버 OAuth 로그인 시작·취소(스펙 2026-10-16-010). 파드는 본문이 정한다
                self._mcp_oauth_post(path, body, a, user)
                return
            if path == TTS_PREVIEW_PATH:                     # 목소리 미리 듣기(chat-reply-tts R11). 정해 둔 글만 읽어 pod 가 필요 없다
                self._speech_reply(*_tts_preview(body, str((user or {}).get("email") or "local")))
                return
            if path == "/api/session/touch":                 # 사용자가 조작했다 — 유휴 마감을 민다. 연결된 POD 가 없어도 된다(OMAI-1112)
                out = a.touch(self.headers.get("Cookie")) if a.enabled else {"ok": True}
                if out is None:
                    self._json({"error": tr("로그인이 필요합니다", "Sign in required"), "login": "/auth/login"}, 401)
                else:
                    self._json(out)
                return
            if path == "/api/settings":                      # 회사 이름 저장(관리자만). 연결된 POD 가 없어도 된다(계획 2026-10-13-008)
                me = (user or {}).get("email", "local")
                if a.enabled and not registry().is_admin(user):
                    self._json({"error": tr("관리자만 할 수 있습니다", "Only admins can do this")}, 403)
                    return
                try:
                    name = settings.set_company_name(body.get("company_name"), me)
                except ValueError:
                    self._json({"error": tr(f"회사 이름은 {settings.COMPANY_MAX}자까지 쓸 수 있습니다", f"The company name can be up to {settings.COMPANY_MAX} characters")}, 400)
                    return
                store.log_usage("settings_company", f"{me} {name or settings.DEFAULT_COMPANY}")
                _IDENTITY_WAKE.set()                         # 리더가 SOUL 첫 문장을 바로 맞춘다(리더가 아니면 리더의 다음 주기)
                self._json({"ok": True, "company_name": name, "identity_sentence": settings.identity_sentence()})
                return
            if path == "/api/notices":                       # 공지 저장·내림·연장·대상 사람 수(관리자만, 스펙 2026-10-24-007)
                if a.enabled and not registry().is_admin(user):
                    self._json({"error": tr("관리자만 할 수 있습니다", "Only admins can do this")}, 403)
                    return
                self._json(*_notices_write(a, (user or {}).get("email", "local"), body))
                return
            if path == "/api/settings/goal/suggest":         # 부서 슬로건 AI 추천 3개(스펙 2026-10-17-015). 저장하지 않는다. 권한은 슬로건 저장과 같다
                me = (user or {}).get("email", "local")
                if a.enabled and not registry().is_admin(user) and not settings.may_set_goal(me, body.get("team")):
                    self._json({"error": tr("자기 부서의 문구만 바꿀 수 있습니다", "You can only change your own department's text")}, 403)
                    return
                try:
                    self._json({"suggestions": slogan.suggest(body.get("team"), body.get("keywords"), me)})
                except slogan.SuggestError as exc:
                    self._json({"error": _suggest_message(exc.reason), "reason": exc.reason,
                                **({"retry_after": exc.retry_after} if exc.retry_after else {})}, exc.code)
                return
            if path == "/api/office/brief/suggest":          # 칸반 카드 「AI 로 항목 나누기」(스펙 office/kanban-card-structured-brief §3-7). 저장하지 않는다
                me = (user or {}).get("email", "local")      # /api/office/kanban/ 아래에 두지 않는다(그 아래는 hub_auto.route 로 가 404)
                acc = office_access.Access(registry(), user, a.enabled)
                if not acc.admin and not acc.visible_aliases():   # 카드를 만들 수 없는 사람(쓸 수 있는 에이전트가 없음)
                    self._json({"error": _brief_message("forbidden"), "reason": "forbidden"}, 403)
                    return
                try:
                    self._json(card_brief.suggest(body.get("title"), body.get("text"), body.get("lang"), me))
                except card_brief.SuggestError as exc:
                    self._json({"error": _brief_message(exc.reason), "reason": exc.reason,
                                **({"retry_after": exc.retry_after} if exc.retry_after else {})}, exc.code)
                return
            if path == "/api/settings/goal":                 # 부서 슬로건·목표 한 곳 저장(스펙 2026-10-15-018). 문구를 비우면 지운다
                me = (user or {}).get("email", "local")
                # 관리자는 모든 부서, 일반 사용자는 로그인으로 알게 된 자기 부서만(목록에 없는 새 부서도 못 만든다)
                if a.enabled and not registry().is_admin(user) and not settings.may_set_goal(me, body.get("team")):
                    self._json({"error": tr("자기 부서의 문구만 바꿀 수 있습니다", "You can only change your own department's text")}, 403)
                    return
                try:
                    saved = settings.set_goal(body.get("team"), body.get("goal"), me)
                except ValueError as exc:
                    msg = (tr("부서 이름을 적어 주세요", "Enter a department name") if "name" in str(exc)
                           else tr(f"문구는 {settings.GOAL_MAX}자까지 쓸 수 있습니다", f"The text can be up to {settings.GOAL_MAX} characters"))
                    self._json({"error": msg}, 400)
                    return
                store.log_usage("settings_goal", f"{me} {saved['team']}")
                self._json({"ok": True, **saved})
                return
            if path in ("/api/soul-templates", "/api/soul-templates/render"):   # SOUL 템플릿(계획 2026-10-13-009)
                self._soul_templates_post(path, body, a, user, pod)
                return
            if path == "/api/pod":                           # 볼 POD 를 바꾼다(허용된 것 중에서만)
                wanted = str(body.get("id") or "")
                if wanted not in {p.id for p in registry().allowed(user, a.enabled)}:
                    self._json({"error": tr("볼 수 없는 POD", "POD not available to you")}, 403)
                    return
                from . import ws as ws_mod                       # 같은 세션의 열린 웹소켓 연결도 새 에이전트를 읽게 한다(순환 import 를 피해 여기서 부른다)
                ws_mod.pod_changed(_cookie(self.headers.get("Cookie"), SESSION_COOKIE), wanted)
                self._send(200, b'{"ok": true}', "application/json; charset=utf-8",
                           {"Set-Cookie": f"{POD_COOKIE}={wanted}; Path=/; HttpOnly; SameSite=Lax"})
                return
            if path in SELF_WRITES:                           # 내 비밀번호 — 에이전트가 0개여도 된다
                self._json(*_self_password(a, user, self.headers.get("Cookie"), body))
                return
            if path in TOKEN_WRITES:                          # 내 Claude Code 연결 — 에이전트가 0개여도 된다
                out, code = _tokens_write(a, user, path, body)
                if path == "/api/tokens/revoke-all" and code == 200:   # 로그인 세션도 끝낸다(재검토 D8): 이 브라우저는 지우고 다른 세션·Keycloak 은 revoke
                    a.logout(self.headers.get("Cookie"))
                    out["sessions"] = a.revoke(str(user["email"]))
                    self._send(200, json.dumps(out, ensure_ascii=False).encode(), "application/json; charset=utf-8",
                               {"Set-Cookie": a.clear_cookie()})
                    return
                self._json(out, code)
                return
            if path in USER_WRITES or path in ("/api/users/set", "/api/users/logout"):   # 「사용자·권한」 — 에이전트가 0개여도 된다(P2)
                self._json(*_users_write(a, user, path, body))
                return
            if path in DEPARTMENT_WRITES:                     # 부서 목록 — 에이전트가 0개여도 된다
                out, code = _departments_write(a, user, path, body)
                if code == 200:
                    _notify_desks()
                self._json(out, code)
                return
            if pod is None:
                self._json({"error": tr("연결된 POD 가 없습니다", "No POD is linked to this account")}, 403)
                return
            if path.startswith("/api/chat/") and isinstance(body, dict) and body.get("pod"):
                pod = _chat_pod(a, user, str(body["pod"]))     # 2026-10-19-001 리뷰 D8 — 보내기·승인·중단도 대화가 속한 에이전트로
                if pod is None:
                    self._json(*_chat_pod_refusal(a, user, str(body["pod"])))
                    return
            self._mark_actor_role(a, user, pod)
            if path.startswith(OFFICE_REST):
                self._office_rest("POST", a, user, path, parse_qs(urlsplit(self.path).query), body)
                return
            if path in ("/api/agents", "/api/agents/delete", "/api/agents/limit", "/api/agents/resume", "/api/agents/owner", "/api/agents/update", *ROLLOUT_WRITES, *SIZE_WRITES):
                who = (user or {}).get("email", "local")
                try:
                    out, code = _agents_write(registry(), user, a.enabled, path, body)
                except agents.AgentError as exc:
                    store.log_usage("agent_failed", f"{who} {path} {str(exc)[:80]}")
                    self._json({**_error_body(exc), **exc.extra}, exc.code)     # 크기 막힘은 blocked 를 함께(스펙 2026-10-30-003 §4-8)
                    return
                store.log_usage("agent_change", f"{who} {path} {str(body.get('name') or body.get('owner_email') or '')[:60]}")
                topics.invalidate("agents")                  # 다른 탭에 곧바로 보낸다(OMAI-1100)
                self._json(out, code)
                return
            if path == "/api/office/presence":               # 오피스에 있다는 신호(10초마다). 지금 있는 사람 목록을 돌려준다(계획 007 P6a)
                me = str((user or {}).get("email") or "").lower()
                if me:
                    office.person_touch(me, str((user or {}).get("name") or ""))
                # 사람 목록을 고치는 쓰기(person_touch) 뒤부터는 같은 읽기를 한 번만 한다(스펙 2026-10-24-009 3-2). beat 는 걸음 표만 쓴다
                with store.request_memo():
                    if me:
                        known = office.people()
                        seed = (known.get(me) or {}).get("seed") or presence.person_id(me)
                        if body.get("leave"):
                            PRESENCE.leave(me)
                        else:
                            PRESENCE.beat(me, office.display_name(me, known), seed, str(body.get("viewing") or ""))
                    self._json({"people": _office_people(office_access.Access(registry(), user, a.enabled))})   # 보기 범위로 거른다(스펙 2026-10-21-022)
                return
            if path == "/api/requests":                      # 막힌 일을 관리자에게 요청한다(스펙 2026-10-15-011 단계 5)
                self._admin_request(body, a, user, pod)
                return
            if path == "/api/office/inbox/answer":           # 받은편지함에서 승인·되묻기에 답한다(계획 007 P4)
                try:
                    out = _office_inbox_answer(registry(), user, a.enabled, body)
                except office_access.Denied as exc:
                    self._json(_error_body(exc), exc.code)
                    return
                except admin_requests.RequestError as exc:
                    self._json(_error_body(exc), exc.code)
                    return
                except (office.OfficeError, ChatUnavailable) as exc:
                    self._json(_error_body(exc), 409 if isinstance(exc, office.OfficeError) else 503)
                    return
                store.log_usage("office_inbox_answer", f"{(user or {}).get('email', 'local')} {str(body.get('id'))[:80]}")
                if str(body.get("id") or "").startswith(admin_requests.ADMIN_PREFIX):
                    topics.invalidate("office:inbox:")        # 처리한 요청은 모든 관리자와 요청자의 받은편지함에서 바뀐다
                else:
                    topics.invalidate(inbox_topic((user or {}).get("email", "")), exact=True)
                self._json(out)
                return
            if path == "/api/office/face":                   # 내 얼굴 시드(본인만)
                me = str((user or {}).get("email") or "").lower()
                if not me:
                    self._json({"error": tr("로그인한 사람만 얼굴을 바꿀 수 있습니다", "Only signed-in people can change their face")}, 403)
                    return
                self._json(office.set_face(me, str(body.get("seed") or "")))
                return
            if path == "/api/office/layout":                 # 레이아웃 저장(판 번호). 관리자 — 판이 아직 없을 때만 누구나 기본 배치를 올린다(계획 007 P−1)
                who = (user or {}).get("email", "local")
                try:
                    out = office.save_layout(body.get("items"), int(body.get("version") or 0), who, (not a.enabled) or registry().is_admin(user))
                except office.LayoutConflict as exc:
                    self._json(_error_body(exc), 409)
                    return
                except office.LayoutForbidden as exc:
                    self._json(_error_body(exc), 403)
                    return
                except (office.OfficeError, ValueError, TypeError) as exc:
                    self._json(_error_body(exc), 400)
                    return
                office.fill_desks()
                OFFICE.bus.publish("layout.changed", {"version": out["version"]})
                _notify_desks()
                store.log_usage("office_change", f"{who} layout v{out['version']}")
                self._json(out)
                return
            if path == "/api/office/action":
                if a.enabled and not registry().is_admin(user):
                    # 관리자가 아니면 자기가 담당·구성원인 TFT 방 고치기만(스펙 2026-10-18-009). 나머지는 지금처럼 관리자만
                    who = (user or {}).get("email", "local")
                    try:
                        out = _office_room_edit(registry(), user, a.enabled, body, who)
                    except office_access.Denied as exc:
                        self._json(_error_body(exc), exc.code)
                        return
                    except (office.OfficeError, ValueError) as exc:
                        self._json(_error_body(exc), getattr(exc, "code", 400))
                        return
                    store.log_usage("office_change", f"{who} room.set {int(body.get('id') or 0)}")
                    self._json(out)
                    return
                who = (user or {}).get("email", "local")
                target = _office_target(body)
                try:
                    out = _office_action(registry(), body, who)
                except (office.OfficeError, ValueError, files.FileError) as exc:
                    store.log_usage("office_failed", f"{who} {str(body.get('action'))[:40]}")
                    self._json(_error_body(exc), getattr(exc, "code", 400))
                    return
                if body.get("action") != "check":
                    store.log_usage("office_change", f"{who} {str(body.get('action'))[:40]} {target}")
                self._json(out)
                return
            if path == "/api/skill/apply":                   # 올린 zip 의 검사 결과(해시)를 확인한 뒤 적용한다(OMAI-1195)
                self._skill_apply(a, user, pod, body)
                return
            if path == "/api/skill/delete":                  # 내 스킬을 Hermes 보관함으로(스펙 2026-10-29-005)
                self._skill_delete(a, user, pod, body)
                return
            if path == "/api/skill/create":                  # 새 스킬 — Hermes 의 스킬 API 가 만들고 검사한다
                refused = content_gate(pod, user, a.enabled, registry().is_admin(user), str(body.get("profile") or primary.primary_of(pod.id)))
                if refused:
                    self._json({"error": refused}, 403)
                    return
                who = (user or {}).get("email", "local")
                name, prof = str(body.get("name") or "").strip(), str(body.get("profile") or primary.primary_of(pod.id))
                try:
                    import re as _re
                    if not _re.fullmatch(r"[a-z0-9][a-z0-9-]{1,62}", name):
                        raise ValueError(tr("이름은 영문 소문자·숫자·- 로, 2자 이상으로 적습니다 (예: weekly-report)", "Use lowercase letters, digits and -, at least 2 characters (example: weekly-report)"))
                    known = {p.name for p in cron_health.hr.profiles(pod.hermes_home)}
                    if prof == primary.ROOT and cron_policy.root_hidden(pod.id):
                        raise ValueError(tr("이 AI 에이전트 작업공간의 루트(default)에는 스킬을 만들 수 없습니다. 주 프로파일(main)을 고르세요.", "Skills cannot be created on the root (default). Choose the main profile."))
                    if prof not in known:
                        raise ValueError(tr("없는 프로파일입니다", "Profile not found"))
                    visible = [s for s in _skills(pod)["skills"] if s["profile"] in (prof, "default")]
                    if any(s["name"] == name for s in visible):
                        raise ValueError(tr("같은 이름의 스킬이 이미 있습니다", "A skill with that name already exists"))
                    desc = " ".join(str(body.get("description") or "").split())[:300]
                    text = str(body.get("body") or "").replace("\r\n", "\n").strip()
                    if not desc and not text.startswith("---"):
                        raise ValueError(tr("설명을 적어 주세요 — AI 에이전트가 이 스킬을 언제 쓸지 설명을 보고 정합니다", "Enter a description. The AI Agent decides when to use this skill from it."))
                    # 머리말: 버전·만든 사람·필요한 환경 변수·태그·관련 스킬(스펙 2026-10-28-004 §9). 관련 스킬은 이 프로파일에서 보이는 스킬만
                    try:
                        env = skill_header.env_names(body.get("env"))
                    except ValueError:
                        raise ValueError(tr("환경 변수 이름은 영문·숫자·_ 로, 숫자로 시작하지 않게, 10개까지 적습니다 (예: NOTION_API_KEY)", "Environment variable names use letters, digits and _, do not start with a digit, up to 10 (example: NOTION_API_KEY)"))
                    try:
                        tags = skill_header.tag_list(body.get("tags"))
                    except ValueError:
                        raise ValueError(tr("태그는 쉼표 없이 30자 안으로, 8개까지 적습니다", "Tags are up to 30 characters without commas, up to 8"))
                    try:
                        related = skill_header.related_list(body.get("related"), {s["name"] for s in visible}, name)
                    except ValueError:
                        raise ValueError(tr("관련 스킬은 이 프로파일에서 쓰는 다른 스킬 10개까지 선택합니다", "Choose up to 10 other skills this profile uses as related skills"))
                    head = skill_header.build(name, desc, author=str((user or {}).get("name") or ""), env=env, related=related, tags=tags)
                    content = text if text.startswith("---") else head + "\n" + (text or f"# {name}\n")
                    if files.has_secrets(content) or files.MASK in content:
                        raise ValueError(tr("비밀값으로 보이는 내용은 스킬 문서에 적을 수 없습니다", "Text that looks like a secret cannot go in a skill document"))
                    if len(content.encode("utf-8")) > files.MAX_BYTES:
                        raise ValueError(tr("내용이 너무 깁니다", "The content is too long"))
                    cat = str(body.get("category") or "").strip()[:60] or None
                    HermesAPI(hub(pod).auth).call("POST", "/api/skills", {"name": name, "content": content.rstrip("\n") + "\n", "category": cat,
                                                                           "profile": None if prof == "default" else prof})
                except (HermesError, ValueError) as exc:
                    store.log_usage("skill_create_failed", f"{who} {prof}/{name}", pod=pod.id)
                    self._json(_error_body(exc), getattr(exc, "code", 400))
                    return
                store.log_usage("skill_create", f"{who} {prof}/{name}", pod=pod.id)
                _drop_pod_key(pod, "skills")
                _note_authored(pod, who, prof, name)
                threading.Thread(target=_rebuild_flow, args=(pod,), daemon=True).start()
                self._json({"ok": True, "name": name, "profile": prof})
                return
            if path in ("/api/cron/note", "/api/text/label"):  # 작업 메모·판 이름 — AAS 쪽 기록
                refused = content_gate(pod, user, a.enabled, registry().is_admin(user), str(body.get("profile") or "") if path == "/api/cron/note" else _profile_of_key(str(body.get("key") or "")))
                if refused:
                    self._json({"error": refused}, 403)
                    return
                who = (user or {}).get("email", "local")
                try:
                    if path == "/api/cron/note":
                        key = f"jobnote:{body.get('profile')}/{body.get('id')}"
                        if not files.valid_key(key):
                            raise ValueError(tr("알 수 없는 작업입니다", "Unknown job"))
                        self._json(files.note_save(pod.id, key, str(body.get("content") or ""), str(body.get("base_sha") or ""), who, str(body.get("note") or "")[:200]))
                    else:
                        key = str(body.get("key") or "")
                        if not files.valid_key(key):
                            raise ValueError(tr("알 수 없는 글입니다", "Unknown text"))
                        files.label_version(pod.id, key, int(body.get("id") or 0), str(body.get("note") or ""))
                        self._json({"ok": True})
                except (files.FileError, ValueError) as exc:
                    self._json(_error_body(exc), getattr(exc, "code", 400))
                return
            if path == "/api/skill/summary":                        # 스킬 AI 요약 만들기·다시 요약(스펙 2026-10-17-002). 볼 수 있는 사람은 누구나, 다시 요약은 10분에 한 번
                try:
                    target = _summary_target(pod, body)
                    self._json(skill_summary.make(target, (user or {}).get("email", "local"), refresh=bool(body.get("refresh"))))
                except (skill_summary.SummaryError, marketplace.MarketError) as exc:
                    self._json(_summary_error(exc), exc.code)
                return
            if path == "/api/skill/retranslate":                    # 스킬 설명 다시 번역(관리자만, 스펙 2026-10-19-017 D8·DD3). 리더가 다음 주기(최대 10분)에 한다
                if not market_tags.may_refresh(a.enabled, registry().is_admin(user)):
                    self._json({"error": tr("관리자만 할 수 있습니다", "Only admins can do this")}, 403)
                    return
                hit = next((s for s in _skills(pod)["skills"] if s["id"] == str(body.get("id") or "")), None)
                if not hit or not skill_desc.worth(hit.get("description") or ""):
                    self._json({"error": tr("다시 번역할 설명이 없습니다", "There is no description to translate again")}, 400)
                    return
                key = skill_desc.request_retranslate(hit["name"], hit["description"])
                store.log_usage("skill_desc_retranslate", f"{(user or {}).get('email', 'local')} {hit['name']}", pod=pod.id)
                _DESC_WAKE.set()
                self._json({"ok": True, "key": key})
                return
            if path == "/api/profile/issue/ack":                 # 「확인할 것」의 주의·안내를 확인해 뺀다(스펙 2026-10-24-003 §13). 권한은 스킬 올리기와 같다
                is_admin = not a.enabled or registry().is_admin(user)
                if not may_use_market("/api/market/install", pod, user, a.enabled, is_admin):
                    self._json({"error": tr("관리자나 이 AI 에이전트 작업공간의 소유자만 할 수 있습니다", "Only admins or the owner of this AI Agent Workspace can do this")}, 403)
                    return
                who = (user or {}).get("email", "local")
                try:
                    sigs = body.get("sigs") if isinstance(body.get("sigs"), list) else str(body.get("sig") or "")   # sigs 는 「모두 확인」
                    n = issue_acks.ack(pod.id, str(body.get("profile") or ""), sigs, who)
                except ValueError:
                    self._json({"error": tr("잘못된 요청입니다", "Invalid request")}, 400)
                    return
                store.log_usage("profile_issue_ack", f"{who} {body.get('profile')} {body.get('code') or ''} {n}", pod=pod.id)
                self._json({"ok": True, "n": n})
                return
            if path in ("/api/market/updates/queue", "/api/market/updates/skip", "/api/market/updates/seen", "/api/market/updates/auto"):   # 새 버전 올리기·건너뛰기·자동 올리기(스펙 2026-10-24-003)·자동 올리기 안내 확인
                reg, who = registry(), (user or {}).get("email", "local")
                is_admin = not a.enabled or reg.is_admin(user)
                if path.endswith("/auto"):                            # 자동 올리기 설정은 관리자만(R2)
                    if not is_admin:
                        self._json({"error": tr("관리자만 할 수 있습니다", "Only admins can do this")}, 403)
                        return
                    market_updates.set_auto(bool(body.get("enabled")))
                    store.log_usage("market_auto_upgrade", f"{who} {'on' if body.get('enabled') else 'off'}", pod=pod.id)
                    self._json({"ok": True, "auto": market_updates.auto_enabled()})
                    return
                items = body.get("items") if isinstance(body.get("items"), list) else [body]
                by_pod: dict[str, list[dict]] = {}
                for it in items[:500]:
                    it = it if isinstance(it, dict) else {}
                    if it.get("package"):                             # 패키지 ID 의 네임스페이스가 표시 이름(shared/x)이어도 slug 로(스펙 2026-10-28-010 D7)
                        it = {**it, "package": marketplace.pkg_slug(str(it["package"]))}
                    target = next((p for p in reg.pods if p.id == str(it.get("pod") or pod.id)), None)
                    if target is None or not may_use_market("/api/market/install", target, user, a.enabled, is_admin):   # 줄마다 그 작업공간의 올리기 권한(R7)
                        self._json({"error": tr("관리자나 이 AI 에이전트 작업공간의 소유자만 할 수 있습니다", "Only admins or the owner of this AI Agent Workspace can do this")}, 403)
                        return
                    by_pod.setdefault(target.id, []).append(it)
                try:
                    made = 0
                    for pid, its in by_pod.items():
                        target = next(p for p in reg.pods if p.id == pid)
                        if path.endswith("/queue"):
                            made += market_updates.queue(pid, its, who)
                        elif path.endswith("/seen"):                  # 「확인할 것」의 자동 올리기 안내를 사람이 확인(같은 올리기 권한)
                            for it in its:
                                made += market_updates.mark_seen(pid, str(it.get("profile") or ""), str(it.get("package") or ""), str(it.get("version") or ""))
                        else:
                            for it in its:
                                market_updates.skip(pid, str(it.get("profile") or ""), str(it.get("package") or ""), str(it.get("version") or ""), who, bool(it.get("undo")))
                                made += 1
                        store.log_usage("market_update_" + path.rsplit("/", 1)[1], f"{who} {pid} {len(its)}", pod=pid)
                        _drop_pod_key(target, "updates")
                except marketplace.MarketError as exc:
                    self._json(_error_body(exc), exc.code)
                    return
                self._json({"ok": True, "n": made})
                return
            if path == "/api/market/tags/refresh":                  # 스킬 태그를 모두 다시 매긴다(관리자만, OMAI-1275)
                if not market_tags.may_refresh(a.enabled, registry().is_admin(user)):
                    self._json({"error": tr("관리자만 할 수 있습니다", "Only admins can do this")}, 403)
                    return
                queued = market_tags.reset()
                _forget_market_catalog()                               # 허브 목록의 태그도 새로(R20)
                store.log_usage("market_tags_refresh", f"{(user or {}).get('email', 'local')} {queued}", pod=pod.id)
                _TAG_WAKE.set()
                self._json({"ok": True, "queued": queued})
                return
            if path == "/api/market/publish/auto":                # 주인 스킬 자동 승인 켜고 끄기·대상 네임스페이스(관리자, 스펙 2026-10-28-001 Q14)
                if a.enabled and not registry().is_admin(user):
                    self._json({"error": tr("관리자만 할 수 있습니다", "Only admins can do this")}, 403)
                    return
                spaces = marketplace.settings()["namespaces"]
                try:
                    cfg = publish_auto.set_config(body.get("auto") if isinstance(body.get("auto"), bool) else None,
                                                  marketplace.ns_slug(str(body["namespace"])) if body.get("namespace") is not None else None, spaces)   # 표시 이름도 받는다(D7)
                except ValueError:
                    self._json({"error": tr("이 스킬 허브에서 다루지 않는 네임스페이스입니다", "This skill hub does not serve that namespace")}, 400)
                    return
                store.log_usage("market_auto_settings", f"{(user or {}).get('email', 'local')} auto={cfg['auto']} ns={cfg['namespace']}", pod=pod.id)
                self._json({"ok": True, "auto": cfg})
                return
            if path in HUB_ADMIN_WRITES:                          # 관리자 직접 게시·다시 게시·허브에서 숨기기(스펙 2026-10-29-002). 토큰 요청은 관리자가 아니다(2026-10-28-001 D5)
                if a.enabled and not registry().is_admin(user):
                    self._json({"error": tr("관리자만 할 수 있습니다", "Only admins can do this")}, 403)
                    return
                who = (user or {}).get("email", "local")
                try:
                    if path == "/api/market/publish/direct":
                        blob = skill_files.recall(str(body.get("hash") or ""), HUB_ADMIN_KEY, who)
                        info = skill_files.inspect(blob)
                        row = hub_admin.direct(skill_files._read_zip(blob), info, hub_admin.bundle_hash(blob), str(body.get("namespace") or ""),
                                               str(body.get("version") or ""), bool(body.get("confirm_scripts")), who)
                        store.log_usage("market_publish_direct", f"{who} {row['namespace']}/{row['name']}@{row['version']} {row['status']} req={row['id']}")
                        out = {"ok": True, "request": row}
                    elif path == "/api/market/publish/retry":
                        row, how = hub_admin.retry(str(body.get("id") or ""), who, bool(body.get("confirm_scripts")))
                        store.log_usage("market_publish_" + how, f"{who} {row.get('namespace')}/{row['name']}@{row['version']} {row['status']} req={row['id']}")
                        out = {"ok": True, "request": row, "how": how}
                    else:
                        fn = hub_hide.hide if path.endswith("/hide") else hub_hide.show
                        res = fn(str(body.get("namespace") or ""), str(body.get("name") or ""), who)
                        store.log_usage("market_hub_" + path.rsplit("/", 1)[-1], f"{who} {res['namespace']}/{res['name']}")
                        out = {"ok": True, **res}
                except (marketplace.MarketError, OSError) as exc:
                    self._json(_error_body(exc), getattr(exc, "code", 400))
                    return
                _forget_market_catalog()                         # 게시·숨기기가 허브 목록을 바꾼다(R15)
                self._json(out)
                return
            if path == "/api/market/publish/check":            # 게시 전 점검 — 쓰지 않는다. 요청할 수 있는 사람에게만(같은 권한)
                is_admin = not a.enabled or registry().is_admin(user)
                if not may_use_market("/api/market/install", pod, user, a.enabled, is_admin):
                    self._json({"error": tr("관리자나 이 AI 에이전트 작업공간의 소유자만 게시를 요청할 수 있습니다", "Only admins or the owner of this AI Agent Workspace can publish")}, 403)
                    return
                prof, rel = str(body.get("profile") or ""), str(body.get("path") or "")
                sid = str(body.get("id") or "") or f"{prof}:{rel if prof == 'default' else f'profiles/{prof}/{rel}'}"   # id: 공용 스킬은 쓰는 에이전트의 줄로 사용 기록을 본다
                row = next((s for s in _skills(pod)["skills"] if s["id"] == sid), None)
                try:
                    usage = {**_skill_states(pod)[0].get(sid, {}), "cron": (row or {}).get("cron") or [], "external_scripts": (row or {}).get("external_scripts") or []}
                except Exception:
                    usage = None
                try:
                    out = market_publish.check_publish(pod.id, pod.hermes_home, (user or {}).get("email", "local"), is_admin, prof, rel,
                                                       str(body.get("name") or ""), str(body.get("version") or ""), usage)
                except (marketplace.MarketError, OSError) as exc:
                    self._json(_error_body(exc), getattr(exc, "code", 400))
                    return
                self._json(out)
                return
            if path in ("/api/market/publish", "/api/market/publish/decide"):   # 내 스킬 올리기: 요청은 관리자나 주인, 승인·반려는 관리자만(스펙 2026-10-14-015 T5)
                is_admin = not a.enabled or registry().is_admin(user)
                if path.endswith("/decide") and not is_admin:
                    self._json({"error": tr("관리자만 할 수 있습니다", "Only admins can do this")}, 403)
                    return
                if not may_use_market("/api/market/install", pod, user, a.enabled, is_admin):
                    self._json({"error": tr("관리자나 이 AI 에이전트 작업공간의 소유자만 게시를 요청할 수 있습니다", "Only admins or the owner of this AI Agent Workspace can publish")}, 403)
                    return
                who = (user or {}).get("email", "local")
                try:
                    if path == "/api/market/publish":
                        row = market_publish.request_publish(pod.id, pod.hermes_home, who, is_admin, str(body.get("profile") or ""), str(body.get("path") or ""),
                                                             str(body.get("name") or ""), str(body.get("version") or ""), str(body.get("namespace") or ""),
                                                             [str(x) for x in body.get("declare_env") or [] if isinstance(x, str)][:20])
                        store.log_usage("market_publish_request", f"{who} {row['name']}@{row['version']} ← {pod.id}/{row['profile']} req={row['id']}", pod=pod.id)
                        row = _maybe_auto_publish(pod, row, _owns_pod(pod, user, a.enabled), is_admin)
                    elif body.get("approve"):
                        row = market_publish.approve(str(body.get("id") or ""), who, str(body.get("namespace") or ""))
                        store.log_usage("market_publish_decide", f"{who} {row['name']}@{row['version']} → {row['namespace']} {row['status']} req={row['id']}", pod=pod.id)
                    else:
                        row = market_publish.reject(str(body.get("id") or ""), who, str(body.get("reason") or ""))
                        store.log_usage("market_publish_decide", f"{who} {row['name']}@{row['version']} 반려 req={row['id']}", pod=pod.id)   # i18n-ignore: 사용 기록에 저장되는 문장
                except (marketplace.MarketError, OSError) as exc:
                    self._json(_error_body(exc), getattr(exc, "code", 400))
                    return
                if path.endswith("/decide"):                           # 승인한 판이 허브 목록에 보이게(R8)
                    _forget_market_catalog()
                self._json({"ok": True, "request": row})
                return
            if path in ("/api/market/install", "/api/market/grant", "/api/market/remove", "/api/market/restore"):   # 설치는 요청만 남긴다 — 서버의 배달기(market_dispatch)가 HermesTask 로 보내 오퍼레이터가 Hermes CLI 로 설치한다(compose 는 끈다)
                # 설치·지우기는 관리자나 그 POD 의 주인, 허용이 필요한 네임스페이스의 사용 허용(grant)은 관리자만(OMAI-1126, 스펙 2026-10-13-014 D2·D3)
                if not may_use_market(path, pod, user, a.enabled, registry().is_admin(user)):
                    self._json({"error": tr("관리자만 할 수 있습니다", "Only admins can do this") if path == "/api/market/grant" else
                                tr("관리자나 이 AI 에이전트 작업공간의 소유자만 설치할 수 있습니다", "Only admins or the owner of this AI Agent Workspace can install")}, 403)
                    return
                who = (user or {}).get("email", "local")
                ns, name = marketplace.ns_slug(str(body.get("namespace") or "")[:63]), str(body.get("name") or "")[:63]   # 표시 이름(restricted)도 받아 slug 로 — 기록·저장은 slug(스펙 2026-10-28-010 D7·D10)
                label = f"{who} {ns}/{name}@{str(body.get('version') or '')[:20]} → {pod.id}/{str(body.get('profile') or '')[:41]}"
                try:
                    if path == "/api/market/grant":
                        marketplace.set_grant(pod.id, ns, bool(body.get("allow")), who)
                        topics.invalidate(f"pod:{pod.id}:market")
                        _drop_pod_key(pod, "updates")                   # 허용이 바뀌면 「올릴 수 없음」 줄이 달라진다(R21)
                        store.log_usage("market_grant", f"{who} {pod.id} {ns} → {'허용' if body.get('allow') else '해제'}", pod=pod.id)   # i18n-ignore: 사용 기록에 저장되는 문장
                        self._json({"ok": True})
                        return
                    if path == "/api/market/restore":
                        row = marketplace.request_restore(pod.id, pod.container, str(body.get("profile") or ""), str(body.get("name") or ""), who)
                        store.log_usage("market_restore", f"{who} {row['name']} ← {pod.id}/{row['profile']} req={row['id']}", pod=pod.id)
                        _forget(pod)
                        self._json({"ok": True, "request": row})
                        return
                    if path == "/api/market/remove":
                        row = marketplace.request_remove(pod.id, pod.container, f"{ns}/{name}", str(body.get("profile") or ""), who)
                        store.log_usage("market_remove", f"{who} {ns}/{name} ← {pod.id}/{row['profile']} req={row['id']}", pod=pod.id)   # 요청 id: 변경 기록이 요청 상태와 짝짓는다(재검토 M5)
                        _forget(pod)
                        self._json({"ok": True, "request": row})
                        return
                    pkg = marketplace.package(ns, name)
                    have = [str(p.get("name")) for p in HermesAPI(hub(pod).auth).call("GET", "/api/profiles").get("profiles", [])]
                    row = marketplace.request_install(pod.id, pod.container, pkg, str(body.get("version") or ""), str(body.get("profile") or ""),
                                                      str(body.get("mode") or "install"), who, have, str(body.get("on_modified") or ""))
                except (marketplace.MarketError, HermesError) as exc:
                    if path != "/api/market/grant":
                        store.log_usage("market_install_failed" if path.endswith("install") else "market_remove_failed", label, pod=pod.id)
                    self._json(_error_body(exc), getattr(exc, "code", 400))
                    return
                store.log_usage("market_install", f"{label} req={row['id']}", pod=pod.id)
                _forget(pod)
                self._json({"ok": True, "request": row})
                return
            if path == "/api/cron/mute":                     # 무시(음소거) — AAS 쪽 기록. Hermes 는 건드리지 않는다
                refused = content_gate(pod, user, a.enabled, registry().is_admin(user), str(body.get("profile") or ""))
                if refused:
                    self._json({"error": refused}, 403)
                    return
                prof, jid = str(body.get("profile") or ""), str(body.get("id") or "")
                if not prof or not jid:
                    self._json({"error": tr("알 수 없는 요청", "Unknown request")}, 400)
                    return
                who = (user or {}).get("email", "local")
                if body.get("mute"):
                    mutes.mute(prof, jid, str(body.get("job_name") or jid)[:120], str(body.get("note") or ""), who)
                else:
                    mutes.unmute(prof, jid)
                store.log_usage("cron_mute" if body.get("mute") else "cron_unmute", f"{who} {prof}/{jid}", pod=pod.id)
                topics.invalidate(f"pod:{pod.id}:health")      # 무시 표시는 읽을 때 붙는다 — 열린 화면에 곧바로 다시 보낸다
                self._json({"ok": True, "muted": mutes.get(prof, jid)})
                return
            if path == "/api/profile/action":                # 프로파일을 바꾸는 일 — 전부 Hermes 대시보드 API 로 보낸다
                # 화면이 보던 에이전트와 쿠키의 에이전트가 다르면 거절한다(스펙 2026-10-19-011 R1 ③). 다른 탭에서 에이전트를 바꾼 뒤
                # 이 탭에서 저장하면 옛 에이전트의 글이 새 에이전트에 들어갔다. expect_pod 가 없는 옛 화면·다른 호출은 그대로 통과
                expect = str(body.pop("expect_pod", "") or "")
                if expect and expect != pod.id:
                    self._json({"error": tr("다른 AI 에이전트 작업공간으로 바뀌었습니다", "The AI Agent Workspace has changed"), "reason": "agent_changed"}, 409)
                    return
                # 만들 에이전트를 고른 「만들기」(스펙 2026-10-19-018 B3·리뷰 I4·I8). 쿠키와 상관없이 그 에이전트에 만든다 — 화면은 늘 보낸다.
                # 아래 검사(권한·가져오기 원본·상한·기록)가 모두 그 에이전트 기준이 되도록 여기서 pod 를 바꾼다
                target = str(body.pop("target_pod", "") or "")
                if target and target != pod.id:
                    picked = next((p for p in registry().allowed(user, a.enabled) if p.id == target), None)
                    if body.get("action") != "create" or picked is None or not ((not a.enabled) or registry().is_admin(user) or _manages_pod(picked, user, a.enabled)):
                        self._json({"error": tr("이 AI 에이전트 작업공간에는 프로파일을 만들 수 없습니다", "You cannot create a profile in that AI Agent Workspace")}, 403)
                        return
                    pod = picked
                # 관리자는 모두, 에이전트 주인은 자기 POD 의 SOUL·스킬 켜고 끄기만(OMAI-1126, 스펙 2026-10-13-014)
                admin = registry().is_admin(user)
                # 주인은 마켓 에이전트 패키지로 만든 프로파일만 지운다(리뷰 O4, D8). 묶음 파일은 관리자만 꺼내므로 내보내기를 건너뛰지 못한다(디자인 결정 12A)
                package = _market_agent(pod, str(body.get("name") or "")) if body.get("action") == "delete" else ""
                owner_delete = bool(a.enabled and not admin and body.get("action") == "delete" and _manages_pod(pod, user, a.enabled))   # 주인은 main 이 아닌 프로파일을 지운다(스펙 2026-10-15-011 D10). main·숨긴 루트는 _profile_action 이 막는다
                if not (owner_delete or may_change_profile(str(body.get("action") or ""), pod, user, a.enabled, admin)):
                    self._json({"error": tr("관리자만 프로파일을 바꿀 수 있습니다. AI 에이전트 작업공간 소유자는 자기 AI 에이전트 작업공간의 성격(SOUL)·스킬·도구·MCP·설정 파일(잠긴 설정 제외)·메신저 연결·비밀값·이름 바꾸기, 스킬 허브로 만든 프로파일 삭제를 합니다.",
                                            "Only admins can change profiles. AI Agent Workspace owners can change the personality (SOUL), skills, tools, MCP, settings file (except locked settings), messenger connections, secrets and names of their own AI Agent Workspace, and delete profiles made from the skill hub.")}, 403)
                    return
                if isinstance(body.get("import_from"), dict):       # 다른 에이전트에서 가져오기: 원본 파드는 내 것(또는 관리자)이어야 하고 지금 보는 파드와 달라야 한다
                    wanted = body["import_from"]
                    src_pod = next((p for p in registry().pods if p.id == str(wanted.get("pod") or "")), None)
                    if src_pod is None or src_pod.id == pod.id or not ((not a.enabled) or admin or _manages_pod(src_pod, user, a.enabled)):
                        self._json({"error": tr("가져올 수 있는 AI 에이전트 작업공간이 아닙니다", "You cannot import from that AI Agent Workspace")}, 403)
                        return
                    body["_import"] = (src_pod, str(wanted.get("profile") or ""))
                body.pop("import_from", None)
                if owner_delete:
                    body["skip_export"] = False
                who, action = (user or {}).get("email", "local"), str(body.get("action") or "")
                label = f"{who} {body.get('name')}" + "".join(f" {k}={str(body[k])[:60]}" for k in ("op", "target", "enabled", "model", "new_name", "clone_from", "id", "version_id", "skip_export", "platform", "server", "kind") if k in body) \
                    + (f" keys={','.join(sorted(str(k)[:64] for k in (body.get('env') or {})))[:200]}" if isinstance(body.get("env"), dict) and body["env"] else "")
                body["_secure"] = self._secrets_ok()          # 비밀값은 암호화된 연결이나 로컬 시험 환경의 localhost 에서만(A3)
                body["_owner"] = bool(a.enabled and not admin)                              # 관리자가 아닌 주인 — owner_guard 검사 대상(클라이언트가 보낸 값은 덮어쓴다)
                try:
                    out = _profile_action(pod, body, who)
                except (HermesError, files.FileError, ValueError) as exc:
                    if not action.endswith("_preview"):
                        store.log_usage(f"profile_{action}_failed"[:60], label, pod=pod.id)
                    self._json(_error_body(exc), getattr(exc, "code", 400))
                    return
                if action not in ("soul_preview", "config_preview", "agents_preview", "mcp_test", "mcp_catalog", "mcp_url_check", "export"):
                    store.log_usage("profile_" + action, label + (f" was_set={out['was_set']}" if isinstance(out, dict) and "was_set" in out else ""), pod=pod.id)
                    if action in ("delete", "rename"):           # 마켓 설치 기록이 프로파일을 따라가게
                        marketplace.note_profile(pod.id, str(body.get("name") or ""), "forget" if action == "delete" else "rename", who, str(out.get("name") or ""))
                    # 프로파일이 생기거나 없어질 때만 전부 새로 읽는다. 그 밖에는 프로파일 상태에 딸린 것만 버린다(다음 화면이 빨리 뜨게).
                    # 비밀값을 넣거나 지우고(.env 줄) 설정 파일을 고치거나 되돌리고(providers 의 api_key, mcp_servers 의 env·headers)
                    # 모델을 바꾸면(Hermes 가 config.yaml 을 다시 써 providers 의 base_url 등이 바뀐다) 자격증명 표가 바뀌므로 그 캐시(120초)는 남기지 않는다(OMAI-1175)
                    kept = ("flow", "tools", "libraries", "skills", "observed", "activity7", "activity30") if action in ("env_set", "env_clear", "config", "config_revert", "model", "mcp_add", "mcp_remove", "mcp_install", "mcp_docmost_write", "mcp_outline_write", "mcp_to_oauth", "channel_save", "channel_test", "pairing_approve", "pairing_revoke") else \
                        ("flow", "credentials", "credentials_nousage", "tools", "libraries", "skills", "observed", "activity7", "activity30")
                    if action in ("config", "config_revert", "mcp", "mcp_add", "mcp_remove", "mcp_install", "mcp_to_oauth"):          # 도구 화면의 MCP 서버 목록이 config.yaml 의 mcp_servers 를 읽는다(OMAI-1249)
                        kept = tuple(k for k in kept if k != "tools")
                    _forget(pod) if action in ("create", "rename", "delete") else _forget(pod, kept)
                    if action in ("create", "rename", "delete"):     # 에이전트 목록의 프로파일 칸을 곧바로 바꾼다(스펙 2026-10-19-006 R3·C2). 다른 저장은 이름이 바뀌지 않는다
                        profile_names.forget(pod.id)
                        topics.invalidate("agents")
                    out = _office_after_profile_action(pod, action, body, out, who)   # _forget 다음 — 리더가 새 목록을 읽게(스펙 2026-10-26-008 R2)
                    if action in ("create", "rename", "delete", "skill"):
                        threading.Thread(target=_rebuild_flow, args=(pod,), daemon=True).start()
                elif action == "export":
                    store.log_usage("profile_export", label, pod=pod.id)
                if package:                                      # 지운 뒤 「마켓에서 다시 설치」 링크(디자인 결정 8A)
                    out = {**out, "market_package": package}
                self._json(out)
                return
            if path in ("/api/file/save", "/api/file/revert", "/api/file/preview"):       # 스킬 문서 고치기 — 저장은 Hermes 스킬 API 가 한다
                refused = content_gate(pod, user, a.enabled, registry().is_admin(user), _profile_of_path(str(body.get("path") or "")))
                if refused:
                    self._json({"error": refused}, 403)
                    return
                rel, who = str(body.get("path") or ""), (user or {}).get("email", "local")
                try:
                    if path == "/api/file/preview":           # 저장하기 전에 무엇이 바뀌는지와 검사 결과를 본다
                        content = str(body.get("content") or "")
                        out = files.diff(pod.hermes_home, pod.id, rel, proposed=content)
                        try:
                            files.check(rel, content)
                            out["problem"] = ""
                        except files.FileError as exc:
                            out["problem"] = str(exc)
                        self._json(out)
                        return
                    note = str(body.get("note") or "").strip()[:200] or "저장"   # i18n-ignore: 판 기록에 저장되는 메모
                    if path == "/api/file/revert":
                        vid = int(body.get("id") or 0)
                        content, note = files.version_content(pod.id, rel, vid), f"버전 {vid} 으로 되돌림"   # i18n-ignore: 판 기록에 저장되는 메모
                    else:
                        content = str(body.get("content") or "")
                    out = files.save(pod.hermes_home, pod.id, rel, content, str(body.get("base_sha") or ""), who, _skill_sender(pod), note)
                except (files.FileError, HermesError, ValueError) as exc:
                    store.log_usage("skill_save_failed", f"{who} {rel}", pod=pod.id)
                    self._json(_error_body(exc), getattr(exc, "code", 400))
                    return
                store.log_usage("skill_revert" if path.endswith("revert") else "skill_save", f"{who} {rel}", pod=pod.id)
                _note_authored(pod, who, file_rel=rel)
                threading.Thread(target=_rebuild_flow, args=(pod,), daemon=True).start()     # 그림은 뒤에서 다시 만든다
                out.update(self._edit_state(a, user, rel, out, pod))
                out.update({"versions": len(files.versions(pod.id, rel)), "siblings": files.siblings(pod.hermes_home, rel)})
                self._json(out)
                return
            if path == "/api/cron/action":                   # 켜기·끄기·지금 실행·주기 바꾸기 — Hermes 대시보드 API 로 보낸다
                admin = (not a.enabled) or registry().is_admin(user)
                if not may_change_cron(pod, user, a.enabled, admin):
                    self._json({"error": tr("관리자나 이 AI 에이전트 작업공간의 소유자만 예약 작업을 바꿀 수 있습니다", "Only admins or the AI Agent Workspace's owner can change scheduled jobs")}, 403)
                    return
                prof, jid, action = str(body.get("profile") or ""), str(body.get("id") or ""), str(body.get("action") or "")
                if action not in ("pause", "resume", "trigger", "schedule", "deliver", "delete", "create", "prompt", "skill") or (not jid and action != "create"):
                    self._json({"error": tr("알 수 없는 요청", "Unknown request")}, 400)
                    return
                sched = " ".join(str(body.get("schedule") or "").split())
                if action in ("schedule", "create") and not (0 < len(sched) <= 120):
                    self._json({"error": tr("주기를 적어 주세요", "Enter a schedule")}, 400)
                    return
                deliver = str(body.get("deliver") or "").strip()
                if action == "deliver" and not (0 < len(deliver) <= 120):
                    self._json({"error": tr("전달 대상을 골라 주세요", "Choose a delivery target")}, 400)
                    return
                refused = (cron_policy.profile_error(pod.id, prof) if action == "create" else "") or \
                    (cron_policy.deliver_error(pod.id, deliver, admin) if action in ("create", "deliver") else "")
                if refused:
                    self._json({"error": refused}, 400 if admin else 403)
                    return
                if action == "delete" and str(body.get("confirm") or "") != str(body.get("job_name") or "\x00"):
                    self._json({"error": tr("확인용 작업 이름이 맞지 않습니다", "The confirmation job name does not match")}, 400)
                    return
                api, base = HermesAPI(hub(pod).auth), f"/api/cron/jobs/{quote(jid, safe='')}"
                try:
                    if action == "schedule":
                        res = api.call("PUT", base, {"updates": {"schedule": sched}}, {"profile": prof})
                    elif action == "deliver":
                        res = api.call("PUT", base, {"updates": {"deliver": deliver}}, {"profile": prof})
                    elif action == "skill":
                        sk = str(body.get("skill") or "").strip()[:120]
                        res = api.call("PUT", base, {"updates": {"skills": [sk] if sk else []}}, {"profile": prof})
                    elif action == "prompt":                 # 지시문 고치기 — 고치기 전·후를 판으로 남긴다
                        key = f"jobprompt:{prof}/{jid}"
                        if not files.valid_key(key):
                            raise HermesError(tr("알 수 없는 작업입니다", "Unknown job"), 400)
                        read = lambda: str((lambda j: j.get("job", j) if isinstance(j, dict) else {})(api.call("GET", base, query={"profile": prof})).get("prompt") or "")   # noqa: E731
                        files.save_text(pod.id, key, read(), str(body.get("content") or ""), str(body.get("base_sha") or ""), (user or {}).get("email", "local"),
                                        lambda text: api.call("PUT", base, {"updates": {"prompt": text}}, {"profile": prof}), read,
                                        str(body.get("note") or "").strip()[:200] or "저장")   # i18n-ignore: 판 기록에 저장되는 메모
                        res = api.call("GET", base, query={"profile": prof})
                    elif action == "delete":
                        current = api.call("GET", base, query={"profile": prof})          # 화면이 본 이름과 Hermes 의 이름이 같을 때만 지운다
                        current = current.get("job", current) if isinstance(current, dict) else {}
                        if str(current.get("name") or current.get("id") or "") != str(body.get("job_name")):
                            raise HermesError(tr("그사이 작업이 바뀌었습니다. 다시 열어 주세요.", "The job changed in the meantime. Reopen it."), 409)
                        res = api.call("DELETE", base, query={"profile": prof})
                    elif action == "create":
                        name, skill = str(body.get("job_name") or "").strip()[:80], str(body.get("skill") or "").strip()[:120]
                        prompt = str(body.get("prompt") or "").strip()[:4000]
                        if not name or not (skill or prompt):
                            raise HermesError(tr("이름과, 돌릴 스킬이나 지시문 중 하나는 있어야 합니다", "A name and either a skill or instructions to run are required"), 400)
                        if prof not in {p.name for p in cron_health.hr.profiles(pod.hermes_home)}:
                            raise HermesError(tr("없는 프로파일입니다", "Profile not found"), 400)
                        res = api.call("POST", "/api/cron/jobs", {"name": name, "schedule": sched, "prompt": prompt, "skills": [skill] if skill else None,
                                                                  "deliver": deliver or "local"}, {"profile": prof})
                    else:
                        res = api.call("POST", f"{base}/{action}", {}, {"profile": prof})
                except (HermesError, files.FileError) as exc:
                    store.log_usage("cron_" + action + "_failed", f"{(user or {}).get('email', 'local')} {prof}/{jid}", pod=pod.id)
                    self._json(_error_body(exc), exc.code)
                    return
                store.log_usage("cron_" + action, f"{(user or {}).get('email', 'local')} {prof}/{str(body.get('job_name') or jid)[:80]}"
                                + (f" → {sched}" if action in ("schedule", "create") else f" → {deliver}" if action == "deliver" else ""), pod=pod.id)
                if action in ("create", "delete"):
                    _drop_pod_key(pod, "profiles")
                    threading.Thread(target=_rebuild_flow, args=(pod,), daemon=True).start()
                _drop_pod_key(pod, "health", "skills")
                job = res.get("job", res) if isinstance(res, dict) else {}
                self._json({"ok": True, "job": job_view(job) if isinstance(job, dict) and job.get("id") else None})
                return
            if path in ("/api/registry", "/api/models/probe") and a.enabled and not registry().is_admin(user):
                # 자산 담당·메모·상태(AAS 전역 표)와 모델 시험 호출은 관리자만(OMAI-1122, 스펙 2026-10-13-012 D3)
                self._json({"error": tr("관리자만 할 수 있습니다", "Only admins can do this")}, 403)
                return
            if path == "/api/registry":                      # AAS 자체 관리 기록(담당·메모·상태). Hermes 는 건드리지 않는다.
                kind = str(body.get("kind") or "")
                plural = {"credential": "credentials", "tool": "tools", "library": "libraries"}.get(kind)
                if not plural:
                    self._json({"error": tr("알 수 없는 종류", "Unknown kind")}, 400)
                    return
                known = {i["id"] for i in _cached(f"{pod.id}:{plural}", 120, lambda: getattr(inventory, plural)(pod.hermes_home))["items"]}
                key = str(body.get("key") or "")
                if key not in known:
                    self._json({"error": tr("목록에 없는 항목", "Item is not in the list")}, 400)
                    return
                out = inventory.register(kind, key, str(body.get("status") or "registered"), str(body.get("owner") or ""),
                                         str(body.get("note") or ""), (user or {}).get("email", "local"))
                _drop_pod_key(pod, plural)
                self._json(out)
                return
            if path == "/api/models/probe":
                known = {m["id"] for m in _models(pod)["models"]}
                model = str(body.get("model") or "")
                if model not in known:                      # 아는 모델 이름만 — 임의 문자열을 흘려보내지 않는다
                    self._json({"error": tr("모르는 모델", "Unknown model")}, 400)
                    return
                store.log_usage("model_probe", model)
                self._json(models.probe(model, home=pod.hermes_home))
                return
            h = hub(pod)
            sid = str(body.get("session_id") or "")
            known_profiles = {p.name for p in cron_health.hr.profiles(pod.hermes_home)}
            if path == TRANSCRIBE_PATH:                     # 말로 입력(스펙 2026-10-22-005 §3-9). 권한은 /api/chat/send 와 같다(위의 body.pod 검사)
                profile = _chat_profile(pod, str(body.get("profile") or ""))
                if profile not in known_profiles:
                    self._json({"error": tr("없는 프로파일", "Profile not found")}, 400)
                    return
                self._json(*_transcribe(pod, profile, profile == "default", body, str((user or {}).get("email") or "local")))
                return
            if path == SPEAK_PATH:                          # 답 읽어 주기(chat-reply-tts §3-8). 권한은 /api/chat/send 와 같다(위의 body.pod 검사)
                profile = _chat_profile(pod, str(body.get("profile") or ""))
                if profile not in known_profiles:
                    self._json({"error": tr("없는 프로파일", "Profile not found")}, 400)
                    return
                self._speech_reply(*_speak(pod.id, profile, body, str((user or {}).get("email") or "local")))
                return
            if path == "/api/chat/session":
                profile = _chat_profile(pod, str(body.get("profile") or ""))
                if profile not in known_profiles:
                    self._json({"error": tr("없는 프로파일", "Profile not found")}, 400)
                    return
                store.log_usage("chat_session", profile)
                self._json(h.create_session(profile, by=str((user or {}).get("email") or "")))
            elif path == "/api/chat/resume":
                profile = _chat_profile(pod, str(body.get("profile") or ""))
                stored = str(body.get("stored_id") or "")
                if profile not in known_profiles or not stored:
                    self._json({"error": tr("잘못된 요청", "Invalid request")}, 400)
                    return
                store.log_usage("chat_resume", profile)
                out = h.resume(profile, stored, by=str((user or {}).get("email") or ""))
                chat_hidden.unhide(str((user or {}).get("email") or "") if a.enabled else "", pod.id, stored)   # 다시 열면 숨김을 푼다(스펙 2026-11-06-002 E3)
                self._json(out)
            elif path == "/api/chat/send":
                text = str(body.get("text") or "").strip()
                files_in = body.get("files") or []
                if not text and not files_in:
                    self._json({"error": tr("빈 메시지", "Message is empty")}, 400)
                    return
                attached = _attached_files(pod, files_in)
                if isinstance(attached, dict):
                    self._json(attached, 400)
                    return
                skill = str(body.get("skill") or "").strip().lstrip("/")[:120]
                try:                                       # 바쁨(스킬 펼치기 전, /compress 중)은 409 — 화면이 「답하는 중」으로 본다
                    if skill:                              # 화면이 고른 스킬(스펙 2026-10-19-012 R7). 글은 사용자가 친 그대로 오고, 그 낱말만 떼어 인자로 쓴다
                        sent = h.send(sid, skill_commands.strip_token(text, skill), by=str((user or {}).get("email") or ""), files=attached,
                                      skill=skill, display=text)
                    else:
                        sent = h.send(sid, text, by=str((user or {}).get("email") or ""), files=attached)
                except SessionBusy as exc:
                    self._json({"error": str(exc)}, 409)
                    return
                # 보내기가 성공한 뒤에만 남긴다(바쁨 409·실패는 세지 않는다). 누가 어느 에이전트에 보냈는지만, 글 내용은 남기지 않는다(스펙 2026-10-22-001 §5-4)
                store.log_usage("chat_send", f"{(user or {}).get('email') or 'local'} {(h.sessions.get(sid) or {}).get('profile') or 'default'}", pod=pod.id)
                if pod.sidecar_url:                        # 쿠버네티스의 사용자 Hermes: 롤아웃이 대화 중인 에이전트를 맨 뒤로 미루게 표시한다(스펙 2026-10-28-015 리뷰 D4)
                    rollouts.mark_busy_later(pod.id)
                self._json({"ok": True, "result": sent})
            elif path == "/api/chat/command":              # 「/」 내장 명령(스펙 2026-10-26-010). 권한은 위의 pod 거름(R4), 허용 목록은 chat_commands
                try:
                    out = chat_commands.run(h, sid, str(body.get("command") or ""), str(body.get("arg") or ""),
                                            by=str((user or {}).get("email") or ""), manages=_chat_manages(a, user, pod))
                except chat_commands.CommandError as exc:  # 안내 문장으로 보일 거절(11-4) — 화면이 code 로 모양을 고른다
                    self._json({"ok": False, "error": {"code": exc.code, "text": exc.text}})
                    return
                store.log_usage("chat_command", f"{(user or {}).get('email') or 'local'} {str(body.get('command') or '')[:20]}", pod=pod.id)
                self._json({"ok": True, "result": out})
            elif path == "/api/chat/queue":                # /queue 예약 지우기·버리기·지금 보내기(DC8)
                op = str(body.get("op") or "")
                if op not in ("cancel", "drop", "send"):
                    self._json({"error": tr("잘못된 요청", "Invalid request")}, 400)
                    return
                self._json({"ok": True, "result": h.queue_op(sid, op, str(body.get("id") or ""))})
            elif path == "/api/chat/approval":                # 먼저 답한 쪽만(Claude Code·받은편지함과 겹칠 수 있다, 스펙 2026-10-28-001 §3-7 ④)
                choice, rid, who = str(body.get("choice") or "deny"), body.get("request_id"), str((user or {}).get("email") or "")
                self._json({"ok": True, "result": _answer_once(pod, sid, "approval", rid, None, choice, who, lambda: h.approve(sid, choice, rid))})
            elif path == "/api/chat/clarify":
                rid, qid, who = str(body.get("request_id") or ""), body.get("question_id") or None, str((user or {}).get("email") or "")
                self._json({"ok": True, "result": _answer_once(pod, sid, "clarify", rid, qid, "answer", who,
                                                              lambda: h.clarify(sid, rid, body.get("answer"), qid))})
            elif path == "/api/chat/interrupt":
                self._json({"ok": True, "result": h.interrupt(sid)})
            elif path == "/api/chat/sessions/hide":          # 세션 목록에서 닫기(여러 개). 내가 연 세션만, 다른 기기에서도 빠진다
                ids = body.get("ids") or []
                if not isinstance(ids, list):
                    raise ValueError("ids")
                by = str((user or {}).get("email") or "") if a.enabled else None
                done = h.hide_sessions([str(x) for x in ids][:500], by)
                # 저장 번호를 아는 세션은 바로 표에 남긴다 — 정리·재시작 뒤에도 「완료」에 다시 나오지 않게(스펙 2026-11-06-002 E1)
                chat_hidden.hide(by or "", pod.id, h.mark_hidden_saved(done))
                self._json({"ok": True, "hidden": done})
            else:
                self._json({"error": "not found"}, 404)
        except ChatNotFound as exc:                 # Hermes 에 대화가 없다 — 화면은 다시 열기를 멈춘다(스펙 2026-10-20-030 R9)
            self._json({"error": str(exc), "code": "not_found"}, 404)
        except AlreadyAnswered as exc:              # 다른 쪽이 먼저 답했다 — 카드는 답한 상태로 둔다(스펙 2026-10-28-001 §3-7 ④)
            self._json(exc.body, 409)
        except ChatUnavailable as exc:
            self._json({"error": str(exc)}, 503)
        except ValueError:
            self._json({"error": tr("잘못된 요청", "Invalid request")}, 400)
        except Exception as exc:
            self._json({"error": f"{type(exc).__name__}: {exc}"}, 500)

    def _password_login(self):
        origin = self.headers.get("Origin")
        if origin and urlsplit(origin).netloc != self.headers.get("Host", ""):
            self._send(403, _page(tr("로그인할 수 없습니다", "Cannot sign in"), tr("<p>다른 사이트에서 온 요청입니다.</p>", "<p>This request came from another site.</p>")), "text/html; charset=utf-8")
            return
        length = int(self.headers.get("Content-Length") or 0)
        if length > 4096:
            self._login_page(tr("잘못된 요청입니다.", "Invalid request."), code=413)
            return
        form = parse_qs(self.rfile.read(length).decode("utf-8", "replace"))
        nxt = form.get("next", ["/"])[0]
        if not nxt.startswith("/") or nxt.startswith("//"):
            nxt = "/"
        try:
            token = auth().password_login(form.get("email", [""])[0], form.get("password", [""])[0],
                                          self.client_address[0])
        except AuthError as exc:
            self._login_page(str(exc), nxt, code=401)
            return
        self._redirect(nxt, auth().set_cookie(token, self._secure_request()))

    def log_message(self, fmt, *args):
        pass


def _sse(seq: int, etype: str, payload: dict) -> bytes:
    data = json.dumps({"type": etype, "payload": payload}, ensure_ascii=False)
    return f"id: {seq}\ndata: {data}\n\n".encode()


def _office_events(after: int | None, a, user):
    """오피스 SSE 본문. Last-Event-ID 뒤 이벤트가 남아 있으면 그 뒤만, 아니면 snapshot 부터. 20초마다 keepalive(Ingress 60초 제한)."""
    acc = office_access.Access(registry(), user, a.enabled)
    if after is None or after + 1 < OFFICE.bus.oldest():           # 처음이거나, 놓친 이벤트가 이미 밀려났다
        snap = _office_snapshot_for(acc)
        yield _sse(snap["seq"], "snapshot", snap)
        after = snap["seq"]
    while True:
        events = OFFICE.bus.after(after, wait=20)
        if not events:
            yield b": keepalive\n\n"
            continue
        out = []
        for ev in events:
            after = ev["seq"]
            view = office_access.event_view(ev["type"], ev["payload"], acc.email, acc.admin)
            if view is not None:
                out.append(_sse(ev["seq"], ev["type"], view))
            else:
                out.append(f": skip {ev['seq']}\n\n".encode())           # 이 사람에게 보내지 않는 소식은 번호만 건너뛴다
        yield b"".join(out)


def _chat_event_stream(h: ChatHub, sid: str, after: int):
    """채팅 SSE 본문. 브라우저가 Last-Event-ID 로 이어 받는다."""
    while True:
        events = h.events_after(sid, after, wait=20)
        if not events:
            yield b": keepalive\n\n"
            continue
        out = []
        for ev in events:
            after = ev["seq"]
            out.append(_sse(ev["seq"], ev["type"], ev["payload"]))
        yield b"".join(out)


def _office_seat_pods(reg: Registry) -> list:
    """자동 자리(계획 007 R2) 대상. 쿠버네티스는 사용자마다 Hermes 가 하나씩이라 주 프로파일 하나만 앉힌다.
    로컬(compose) 구성은 작업공간마다 모든 프로파일을 앉힌다 — 예전에는 관리자가 「배치」에서 하나씩 앉혀야 해 처음 띄운 오피스가
    비어 있었다(스펙 2026-10-26-008 R1). 목록을 읽지 못한 작업공간은 이번 바퀴에서 빼고, 읽은 것만 정리(R6) 대상으로 표시한다(full)."""
    recs = primary.records()                                  # 주 프로파일을 쓰는 POD 는 main 을 앉힌다(스펙 003 리뷰 D13). 나머지는 지금처럼 default
    if config.get("AAS_K8S_NAMESPACE"):
        return [types.SimpleNamespace(id=p.id, owner=p.owner or "", profiles=[primary.primary_of(p.id, recs)], primary=primary.primary_of(p.id, recs))
                for p in reg.pods]
    out = []
    for p in reg.pods:
        try:
            names = _agent_profile_names(reg, p.id)
        except Exception as exc:                              # noqa: BLE001 — 사이드카 하나가 실패해도 다른 작업공간은 앉힌다
            print(f"오피스 자동 자리: {p.id} 의 프로파일 목록을 읽지 못했습니다: {type(exc).__name__}", flush=True)   # i18n-ignore: 로그
            continue
        if names is None:
            continue
        out.append(types.SimpleNamespace(id=p.id, owner=p.owner or "", profiles=list(names), primary=primary.primary_of(p.id, recs), full=True))
    return out


def _office_after_profile_action(pod, action: str, body: dict, out: dict, who: str) -> dict:
    """프로파일 만들기·이름 바꾸기·지우기가 성공한 뒤 오피스 자리를 따라 바꾸고 리더가 곧바로 자리를 맞추게 한다(스펙 2026-10-26-008 R2·R3·R5).
    프로파일은 이미 바뀌었으므로 자리 정리가 실패해도 기록만 남긴다 — 남은 것은 리더의 자리 맞추기(R6)가 다음 바퀴에 맞춘다.
    _forget(pod) 다음에 부른다. 그 전에 알리면 리더가 아직 버리지 않은 사이드카 묶음으로 옛 목록을 읽는다."""
    if action not in ("create", "rename", "delete"):
        return out
    name = str(body.get("name") or "")
    try:
        if action == "create":
            office.profile_created(pod.id, name)
        elif action == "rename":
            office.rename_profile(pod.id, name, str(out.get("name") or ""), who)
        else:                                                 # 지운 프로파일이 앉은 자리를 지우고 열린 방에서 뺀다(스펙 2026-10-15-011 R1)
            out = {**out, "forgot": office.forget_profile(pod.id, name, who)}
    except Exception as exc:                                  # noqa: BLE001 — 프로파일은 이미 바뀌었다
        store.log_usage(f"profile_{action}_office_failed", f"{who} {name} {type(exc).__name__}", pod=pod.id)
    _notify_desks()
    return out


_office_space_state = {"last_t": 0.0, "pod_hash": "", "leader_was": False, "triggered": False}


def _trigger_office_space() -> None:
    _office_space_state["triggered"] = True


def _notify_desks() -> None:
    """자리·배치·부서 변경 시 리더가 즉시 자리 맞춤을 하도록 알린다(스펙 2026-10-25-001 R1·D5)."""
    _trigger_office_space()
    _office_wake.set()
    try:
        with shared._connect() as conn:
            shared.notify(conn, "desks")
    except Exception:
        pass


def _office_space(reg: Registry) -> None:
    """자동 자리와 빈 책상 채우기. 바뀌면 장면에 알린다."""
    if office.ensure_default_layout():                         # 배포한 기본 배치의 판본이 다르면 바꾼다(계획 2026-10-13-001 D6)
        OFFICE.bus.publish("layout.changed", {"version": office.layout()["version"]})
    seat_pods = _office_seat_pods(reg)
    # 목록을 다 읽은 작업공간(compose)은 목록에 없는 프로파일의 자동 자리를 먼저 지운다 — Hermes 명령줄로 지우거나 이름을 바꾼 경우,
    # 지우기 직전에 읽은 목록으로 자리가 다시 생긴 경우(스펙 2026-10-26-008 R6). 쿠버네티스는 주 프로파일만 보므로 하지 않는다
    pruned = [a for p in seat_pods if getattr(p, "full", False) for a in office.prune_auto_seats(p.id, set(p.profiles))]
    made = office.auto_seat(seat_pods) + pruned
    if hub_auto.ensure_default_board(bool(reg.pods)):       # 에이전트가 생기면 칸반을 바로 쓰게(OMAI-1286)
        topics.invalidate("office:kanban:")
    identity_wake_if_new_pods(reg)
    depts = settings.departments()
    teamed = office.default_teams({p.id: (p.owner or "").lower() for p in reg.pods}, depts)   # 부서 → 기본 팀(계획 2026-10-13-008 §2-3)
    filled = office.fill_desks()
    teamed = office.sync_team_rooms({p.id: (p.owner or "") for p in reg.pods}) or teamed   # 팀마다 팀 방(계획 2026-10-13-011 §3-3)
    before = office.room_places()
    placed = office.assign_room_places() != before
    if made or filled or placed or teamed:
        OFFICE.bus.publish("desks.changed", {})


def _office_tick() -> bool:
    """5초 반복 한 번. 모든 서버가 자기가 맡은 에이전트의 사이드카 재료를 읽어 적는다(스펙 2026-10-24-013 R11).
    자리 맞추기(_office_space)는 60초 주기 또는 변경(파드 목록·오피스 조작·새 리더) 시에만 돌린다(스펙 2026-10-25-001 R1).
    자리 상태 계산·중계는 리더가 5초마다 한다. 리더가 아니면 재료만 적고 False."""
    try:
        with store.request_memo():                            # 에이전트마다 무시한 크론·자리를 다시 읽었다 — 한 바퀴에 한 번(스펙 2026-10-26-002 R1)
            _collect_mine(registry())
    except Exception as exc:
        print(f"오피스 재료를 읽지 못했습니다: {type(exc).__name__}", flush=True)   # i18n-ignore: 로그
    if not leader.is_leader():
        _office_space_state["leader_was"] = False
        return False
    reg = registry()
    now = time.time()
    pod_hash = hashlib.sha1(",".join(sorted(f"{p.id}:{p.owner or ''}" for p in reg.pods)).encode()).hexdigest()
    became_leader = not _office_space_state["leader_was"]
    pod_changed = pod_hash != _office_space_state["pod_hash"]
    time_due = (now - _office_space_state["last_t"]) >= 60.0
    needed = became_leader or pod_changed or time_due or _office_space_state["triggered"]
    # 쿠버네티스 오퍼레이터가 만든·지운 작업공간은 AAS 쓰기 요청이 없어 여기서 알린다(스펙 2026-10-26-001 리뷰 D6). 새 리더의 첫 반복은
    # 바탕만 잡는다 — 배포·리더 전환 때마다 모든 화면이 다시 읽지 않게(외부 검토 M6). 자리 맞추기가 실패해도 같은 변화를 두 번 알리지 않게 따로 기억한다
    seen = _office_space_state.get("pods_seen", "")
    if seen and seen != pod_hash and not became_leader:
        office_changed.bump("pods")
    _office_space_state["pods_seen"] = pod_hash
    if needed:
        try:
            _office_space(reg)
            _office_space_state["last_t"] = now
            _office_space_state["pod_hash"] = pod_hash
            _office_space_state["triggered"] = False
        except Exception as exc:
            print(f"오피스 자리를 맞추지 못했습니다: {type(exc).__name__}", flush=True)   # i18n-ignore: 로그
    _office_space_state["leader_was"] = True
    try:
        with store.request_memo():                            # 상태 계산은 읽기만 한다 — 같은 DB 읽기를 한 번만(R2). 자리 맞추기는 쓰고 읽어 켜지 않는다
            _office_snapshot(reg)
    except Exception as exc:                                  # 한 번 실패해도 다음 주기에 다시 한다
        print(f"오피스 상태를 계산하지 못했습니다: {type(exc).__name__}", flush=True)   # i18n-ignore: 로그
    return True


POOL_REPORT_EVERY = 300.0
_pool_report_at = {"t": 0.0}


def _pool_report(now: float) -> str | None:
    """5분마다 이 서버의 DB 풀 기록을 남긴다. 기다림·실패·끊김이 있을 때만 한 줄(스펙 2026-10-24-010 R1·Q4). 서버마다(파드마다)
    남긴다 — 풀은 서버마다 따로다. 처음 부르면 시각만 잡는다."""
    if not _pool_report_at["t"]:
        _pool_report_at["t"] = now
        return None
    if now - _pool_report_at["t"] < POOL_REPORT_EVERY:
        return None
    _pool_report_at["t"] = now
    line = db.pool_report_line(db.pool_stats())
    if line:
        print(line, flush=True)
    ddl = db.ddl_report_line()                   # 정의 문장 건너뜀·실행 수(스펙 2026-10-28-009 R4)
    if ddl:
        print(ddl, flush=True)
    return line


_sidecar_at = {"t": 0.0}


def _tree_sweep() -> list[str]:
    """사람이 10분 넘게 쓰지 않은 에이전트의 묶음을 버리고(상한을 넘으면 오래된 것부터 더) 그 에이전트의 결과 캐시도 버린다
    (스펙 2026-10-24-013 R8·D2). 버린 묶음의 label 을 돌려준다."""
    pods = list(registry().pods)
    backends = [b for b in (getattr(getattr(p, "hermes_home", None), "backend", None) for p in pods) if b is not None]
    dropped = tree_cache.sweep(backends)
    idle = {p.id for p in pods if tree_cache.idle(p.id)}
    with _lock:
        for key in [k for k in _cache if k.split(":", 1)[0] in idle]:
            _cache.pop(key, None)
    return dropped


def _sidecar_round(now: float) -> None:
    """5분마다: 사이드카 호출 기록 한 줄(R0)과 묶음·결과 캐시 정리(R8). 처음 부르면 시각만 잡는다."""
    if not _sidecar_at["t"]:
        _sidecar_at["t"] = now
        return
    if now - _sidecar_at["t"] < POOL_REPORT_EVERY:
        return
    _sidecar_at["t"] = now
    line = hermes_remote.call_report_line(hermes_remote.call_stats())
    if line:
        print(line, flush=True)
    dropped = _tree_sweep()
    if dropped:
        print(f"사이드카 묶음 정리: {len(dropped)}개 버림, 남은 내용 {tree_cache.store_bytes() / 1024 / 1024:.1f}MB", flush=True)   # i18n-ignore: 로그


OFFICE_IDLE_EVERY = 30.0
_office_wake = threading.Event()                       # 사람이 들어오거나 자리가 바뀌면 30초를 기다리지 않고 한 바퀴 돈다(R15·E10)


def _office_every(every: float) -> float:
    """다음 바퀴까지 기다릴 시간. 오피스에 사람이 아무도 없으면(어느 서버든) 30초 — 재료 수집과 리더 스냅샷이 5초마다 돌며
    초당 약 3건을 읽었다(스펙 2026-10-26-002 R15). 반복의 스냅샷은 자리 상태 이벤트에만 쓰이고 화면은 요청 때 따로 계산한다."""
    return every if PRESENCE.anyone() else max(every, OFFICE_IDLE_EVERY)


def _office_loop(every: float = 5.0):
    """보는 사람이 없어도 자리 상태가 바뀌면 이벤트가 쌓이게, 5초마다 상태를 다시 계산한다(첫 호출이 바탕). 아무도 없으면 30초(R15).
    DB 풀 기록도 여기서 본다 — 오피스 계산보다 먼저, 따로 잡아 오피스 계산이 실패해도 기록은 남는다."""
    while True:
        try:
            _pool_report(time.time())                          # 풀은 서버마다 따로라 리더가 아니어도 남긴다
        except Exception as exc:
            print(f"DB 풀 기록을 남기지 못했습니다: {type(exc).__name__}", flush=True)   # i18n-ignore: 로그
        try:
            _sidecar_round(time.time())                        # 묶음은 서버마다 따로 든다 — 리더가 아니어도 정리한다
        except Exception as exc:
            print(f"사이드카 기록·정리를 하지 못했습니다: {type(exc).__name__}", flush=True)   # i18n-ignore: 로그
        _office_tick()
        _office_wake.wait(_office_every(every))
        _office_wake.clear()


_shared_at = {"beat": 0.0, "clean": 0.0, "sweep": 0.0, "full": 0.0, "missed_log": 0.0}
_shared_last: dict[str, float] = {}                    # 종류별 마지막 DB 읽기 시각
_shared_pending: set[str] = set()                      # 알림이 와서 읽어야 할 종류
_shared_lock = threading.Lock()
_shared_wake = threading.Event()                       # 알림이 오면 반복 스레드를 0.3초 기다리지 않고 깨운다(외부 검토 H3)
_shared_missed = {"n": 0}                              # 알림 없이 5초 반복 읽기로 찾은 것(듣기가 고장 나면 늘어난다, 외부 검토 M7)
SHARED_LISTENER: "shared.Listener | None" = None


def _shared_notified(payload: str) -> None:
    kind = shared.parse_notify(payload, SHARED.origin)
    if kind == "meeting":                                     # 어느 서버가 회의 상태를 썼다 — 회의 목록을 다시 읽는다(스펙 2026-10-26-002 R7)
        topics.invalidate("office:meeting:active", exact=True)
        return
    if kind == "desks":
        _trigger_office_space()
        _office_wake.set()                                    # 30초 모드여도 새 자리의 별칭을 바로 맞춘다 — 늦으면 그 자리의 이벤트를 버린다(E10)
        topics.invalidate("office:meeting:active", exact=True)   # 방을 닫거나 자리를 바꾸면 회의 목록도 바뀐다(주기가 30초일 수 있다)
        return
    if kind == "office_changed":                         # 다른 서버가 오피스 정보를 바꿨다 — 이 서버의 신호 토픽을 곧바로 다시 읽는다(스펙 2026-10-26-001)
        office_changed.forget()                              # 기억한 번호도 버린다(스펙 2026-10-26-002 §9-13)
        topics.invalidate("office:changed", exact=True)
        return
    if kind:
        with _shared_lock:
            _shared_pending.add(kind)
        _shared_wake.set()


def _shared_reconnected() -> None:
    """듣기 연결이 (다시) 붙었다 — 끊긴 동안의 알림을 놓쳤을 수 있어 셋을 한 번 읽는다. PostgreSQL 이 다시 시작됐을 수 있어
    풀에 쉬던 연결도 점검한다(끊긴 연결이 첫 요청에서 오류를 냈다, 스펙 2026-10-24-010 D8).
    소실된 캐시 알림 복구를 위해 cache_epoch 전체를 대조 동기화한다(스펙 2026-10-25-001 R3·D3)."""
    try:
        db.check_pool()
    except Exception as exc:
        print(f"DB 풀 점검을 하지 못했습니다: {type(exc).__name__}", flush=True)   # i18n-ignore: 로그
    try:
        cache_epoch.sync()
    except Exception as exc:
        print(f"캐시 세대 동기화를 하지 못했습니다: {type(exc).__name__}", flush=True)   # i18n-ignore: 로그
    table_cache.reset_all()                                   # 끊긴 동안의 표 바뀜 알림을 놓쳤을 수 있다(스펙 2026-10-26-002 R10)
    office_changed.forget()                                   # 오피스 변경 번호 알림도 놓쳤을 수 있다(§9-13)
    with _shared_lock:
        _shared_pending.update(shared.KINDS)
    _shared_wake.set()


def _shared_read(kind: str) -> int:
    """한 종류를 DB 에서 읽어 이 서버에 반영한다. 찾은 것의 수를 돌려준다."""
    if kind == "presence":
        changes = PRESENCE.changes()
        for etype, payload in changes:
            PRESENCE_BUS.publish(etype, payload)
        if PRESENCE.people_changed:                         # 들어옴·떠남·이름·얼굴 — 사람 목록 토픽을 곧바로 다시 읽는다(스펙 2026-10-26-001 리뷰 D3)
            PRESENCE.people_changed = False
            topics.invalidate("office:people", exact=True)
            _office_wake.set()                              # 누가 들어왔으면 30초 모드를 바로 끝낸다(R15 — 별도 office-wake 알림 대신 사람 신호 알림)
        return len(changes)
    if kind == "relay":
        got = SHARED.relay_in()
        for etype, payload in got:
            if etype == "agent.lastSeen" and payload.get("alias"):
                OFFICE.tracker.last_seen[payload["alias"]] = max(OFFICE.tracker.last_seen.get(payload["alias"], 0), float(payload.get("ts") or 0))
            OFFICE.tracker.apply_remote(etype, payload)           # 리더가 계산한 자리 상태를 기억한다(스펙 2026-10-24-011 R3)
        return len(got)
    answers = SHARED.answers_for_me()
    for ans in answers:
        item = INBOX.local(ans["id"])
        try:
            if item is None:
                raise office.OfficeError(tr("이미 답했거나 끝난 요청입니다", "The request was already answered or has ended"))
            result = _inbox_apply(registry(), item, ans["body"], ans.get("by") or "")
        except Exception as exc:                              # 답한 쪽 화면에 사유를 그대로 보인다
            result = {"error": str(exc) or type(exc).__name__}
        SHARED.answer_done(ans["id"], result)
    return len(answers)


def shared_tick() -> None:
    """서버 복제본 사이 공유(0.3초마다 돈다): 살아 있음 신호, 걸음, 다른 서버의 말풍선 이벤트, 일하는 중, 다른 서버에서 온 답.
    PostgreSQL 에서는 DB 읽기를 알림이 온 종류만, 알림을 놓쳐도 5초마다 셋을 한다(스펙 2026-10-24-009 4절). SQLite 는 매번 읽는다."""
    now = time.time()
    if now - _shared_at["beat"] >= shared.BEAT_EVERY:
        SHARED.heartbeat()
        _shared_at["beat"] = now
    pg = db.backend() == "postgres"
    listening = SHARED_LISTENER is not None and SHARED_LISTENER.connected
    with _shared_lock:
        notified = set(_shared_pending)
        reads, left, full = shared.due_reads(now, notified, _shared_last, _shared_at["full"], pg, listening=listening)
        _shared_pending.clear()
        _shared_pending.update(left)
    if full:
        _shared_at["full"] = now
    for kind in shared.KINDS:
        if kind in reads:
            _shared_last[kind] = now
            found = _shared_read(kind)
            listening = SHARED_LISTENER is not None and SHARED_LISTENER.connected
            if pg and full and found and kind not in notified and listening:    # 듣는 중인데 알림 없이 찾았다 — 놓친 알림
                _shared_missed["n"] += found
    if pg and now - _shared_at["missed_log"] >= 300:
        if _shared_missed["n"]:
            state = "붙음" if SHARED_LISTENER is not None and SHARED_LISTENER.connected else "끊김"   # i18n-ignore: 로그
            print(f"서버 사이 알림 없이 맞춘 것 {_shared_missed['n']}건(5분), 듣기 연결 {state}", flush=True)   # i18n-ignore: 로그
            _shared_missed["n"] = 0
        _shared_at["missed_log"] = now
    SHARED.set_busy(OFFICE.tracker.chat_busy())
    # 다시 시작한 서버가 남긴 회의 답 기다림을 「받지 못함」 줄로 바꾼다(스펙 2026-10-20-030 4-8). 리더는 15초마다, 리더가 멈춰도 빠지지 않게 모두가 60초마다
    if now - _shared_at["sweep"] >= 15 and leader.is_leader():
        _sweep_meetings()
        _shared_at["sweep"] = now
    if now - _shared_at.get("hold", 0.0) >= presence.HOLD_EVERY:
        try:                                                  # 웹소켓으로 붙은 사람의 신호를 서버가 한 문장으로 대신 쓴다(스펙 2026-10-26-001 리뷰 D15)
            PRESENCE.refresh_held()
        except Exception as exc:                              # 한 번 놓쳐도 TTL(30초)이 15초 주기의 두 배라 빠지지 않는다
            print(f"웹소켓 사람 신호를 쓰지 못했습니다: {type(exc).__name__}", flush=True)   # i18n-ignore: 로그
        _shared_at["hold"] = now
    if now - _shared_at["clean"] >= 60:
        SHARED.cleanup()
        PRESENCE.expire()                                     # 걸음 읽기는 만료 행을 거르기만 한다 — 지우기는 여기서(리뷰 C2)
        _sweep_meetings()
        _prune_chat_hubs()                                    # 오래 쉬던 채팅 세션(스펙 2026-11-05-005 D4)
        _shared_at["clean"] = now


def _sweep_meetings() -> None:
    try:
        meeting.sweep_lost(SHARED.origin, alive=SHARED._alive)
    except Exception as exc:                                  # 다음 주기에 다시 한다
        print(f"회의 답 기다림을 정리하지 못했습니다: {type(exc).__name__}", flush=True)   # i18n-ignore: 로그


def presence_tick() -> None:
    """DB 에 쓰인 걸음·떠남을 이 서버의 화면들에 보낸다(다른 서버에 붙은 사람의 것도, 계획 007 P6b)."""
    _shared_read("presence")


def _presence_loop():
    global SHARED_LISTENER
    if db.backend() == "postgres" and SHARED_LISTENER is None:
        SHARED_LISTENER = shared.Listener(_shared_notified, _shared_reconnected)
        table_cache.listening = lambda: SHARED_LISTENER is not None and SHARED_LISTENER.connected
        SHARED_LISTENER.start()
    while True:
        _shared_wake.clear()
        try:
            shared_tick()
        except Exception as exc:                              # DB 가 잠시 끊겨도 다음 주기에 다시 한다
            print(f"오피스 공유 정보를 읽지 못했습니다: {type(exc).__name__}", flush=True)   # i18n-ignore: 로그
            time.sleep(5)
        _shared_wake.wait(PRESENCE_EVERY)


def _known_emails() -> set[str]:
    """AAS 가 아는 사람의 이메일: 등록부 주인·접근 허용 표·비밀번호 계정·오피스 사람·방 구성원. Keycloak 사용자 목록은 부르지 않는다."""
    reg = registry()
    found = {p.owner for p in reg.pods} | set(reg.grants()) | set(load_users(auth().cfg.get("users_file"))) | office.known_emails()
    return {str(e).lower() for e in found if e and e != "*"}


def _office_chat_title(who: str, alias: str) -> str:
    """사람·에이전트마다 하나인 대화의 이름 office-<이메일 전체>-<에이전트>(스펙 2026-10-20-002 R13).
    예전에는 이메일 앞부분만 써서 kim@a.com 과 kim@b.com 이 같은 대화(같은 Hermes 세션)를 썼다. 옛 이름 대화는
    새 이름 대화가 없고, 같은 앞부분을 쓰는 다른 사람을 AAS 가 모를 때만 새 이름으로 바꿔 이어 받는다(있으면 새로 시작한다)."""
    email = re.sub(r"[\x00-\x1f\x7f\s]", "", str(who or "")).lower()
    title = f"office-{email}-{alias}"
    old = f"office-{str(who or '').split('@')[0]}-{alias}"              # 바꾸기 전 규칙 그대로(대소문자도)
    if old == title or office.session_find(alias, title) is not None or office.session_find(alias, old) is None:
        return title
    prefix = email.split("@")[0]
    if not any(e != email and e.split("@")[0] == prefix for e in _known_emails()):
        office.session_retitle(alias, old, title)
    return title


def _office_chat(acc: office_access.Access, method: str, path: str, one, body: dict, who: str, audit) -> tuple[int, dict]:
    """장면 안 1:1 대화(계획 007 P2). 채팅 API 는 주인·grants 만 허용하므로(FR-15) 방 구성원이 남의 에이전트와 말하는 길은
    오피스 경로뿐이다(003 §8-1). 대화는 사람·에이전트마다 하나(office-<이메일>-<에이전트>, _office_chat_title)라 주인이 Hermes 세션 목록에서 누가 시켰는지 안다."""
    bridge = office_auto().bridge
    alias = str((body.get("alias") if method == "POST" else one("alias")) or "")
    acc.require_use(alias)
    seat = next((s for s in office.seats() if s["alias"] == alias and s["enabled"]), None)
    if not seat:
        raise office_access.Denied(tr("오피스에 없는 AI 에이전트입니다", "This AI Agent is not in the office"), 404)
    if path == "/api/office/chat/history" and method == "GET":   # 화면을 새로 고친 뒤 대화 창을 다시 채운다(2026-10-16 사용자 보고)
        try:
            row = office.session_find(alias, _office_chat_title(who, alias))
            out = bridge.history(row, seat)
            return 200, {**out, "queue": bridge.queue_view(row["id"])} if row else out   # 대화가 없으면 예약도 없다 — 옛 응답 그대로
        except ChatUnavailable as exc:
            raise meeting.MeetingError(str(exc), 503) from None
    if path == "/api/office/chat/skills" and method == "GET":   # 입력창 / 목록(스펙 2026-10-19-012 P1). 대화 보내기와 같은 접근 규칙(require_use)
        got = skill_commands.cached(bridge.hub(seat["pod"]), seat["profile"])
        # 명령은 그 에이전트를 관리하는 사람에게만(스펙 2026-10-26-010 R3·DC13). 이름 10개는 누구에게나 준다(DC5)
        return 200, {**{k: v for k, v in got.items() if k != "blocked"}, "skills": skill_desc.apply(got.get("skills"), skill_commands.DESC_MAX),
                     **chat_commands.view(got, allowed=acc.manages(alias), office=True)}
    if path == "/api/office/chat/command" and method == "POST":  # 「/」 내장 명령(스펙 2026-10-26-010 R3). 관리하는 사람만
        if not acc.manages(alias):
            raise office_access.Denied(tr("이 명령은 AI 에이전트를 관리하는 사람만 쓸 수 있습니다", "Only people who manage this AI Agent can use this command"), 403)
        row, _ = office.session_create(alias, _office_chat_title(who, alias))
        try:
            out = bridge.command(alias, seat, row, str(body.get("command") or ""), str(body.get("arg") or ""), by=who)
        except chat_commands.CommandError as exc:
            return 200, {"ok": False, "error": {"code": exc.code, "text": exc.text}}
        except ChatUnavailable as exc:
            raise meeting.MeetingError(str(exc), 503) from None
        audit(alias, "오피스 명령")   # i18n-ignore: 사용 기록에 저장되는 문장
        return 200, {"ok": True, "result": out, "queue": bridge.queue_view(row["id"])}
    if path == "/api/office/chat/queue" and method == "POST":    # /queue 예약 지우기·버리기·지금 보내기(DC8)
        if not acc.manages(alias):
            raise office_access.Denied(tr("이 명령은 AI 에이전트를 관리하는 사람만 쓸 수 있습니다", "Only people who manage this AI Agent can use this command"), 403)
        op = str(body.get("op") or "")
        row = office.session_find(alias, _office_chat_title(who, alias))
        if op not in ("cancel", "drop", "send") or not row:
            raise meeting.MeetingError(tr("잘못된 요청", "Invalid request"))
        return 200, {"queue": bridge.queue_op(row["id"], op, str(body.get("id") or ""))}
    if path == "/api/office/chat/send" and method == "POST":
        text = str(body.get("text") or "").strip()[:4000]
        if not text:
            raise meeting.MeetingError(tr("말을 적어 주세요", "Enter a message"))
        skill = str(body.get("skill") or "").strip().lstrip("/")[:120]
        row, _ = office.session_create(alias, _office_chat_title(who, alias))
        try:
            # 주인·관리자·팀 관리자가 아니면 주인의 위키 계정으로 쓰지 못하게 그 턴의 쓰기 도구를 막는다(스펙 2026-10-23-004 15-9)
            block = {} if acc.manages(alias) else {"blocked_tools": mcp_servers.foreign_write_blocks()}
            if skill:                                  # 스펙 2026-10-19-012 R7: 글은 친 그대로, 그 낱말만 떼어 스킬 인자로
                turn = bridge.start(alias, seat, row, skill_commands.strip_token(text, skill), by=who, skill=skill, display=text, **block)
            else:
                turn = bridge.start(alias, seat, row, text, by=who, **block)
        except relay.Busy:
            raise meeting.MeetingError(tr("앞의 말에 아직 답하는 중입니다", "Still answering the previous message"), 409) from None
        except ChatUnavailable as exc:
            raise meeting.MeetingError(str(exc), 503) from None
        audit(alias, "오피스 대화")   # i18n-ignore: 사용 기록에 저장되는 문장
        return 202, {"turn": turn.id}
    turn = bridge.turn(str((body.get("turn") if method == "POST" else one("turn")) or ""), alias)
    if turn is None:
        raise hub_auto.Fail(404, "not_found")
    if path == "/api/office/chat/turn" and method == "GET":
        try:
            after = max(0, int(one("after") or 0))
        except ValueError:
            after = 0
        items = turn.items[after:]
        out = []
        for kind, *rest in items:
            value = rest[0] if rest else ""
            if kind == "approval":                       # 승인은 받은편지함에서 한다(P4) — 여기서는 기다린다는 표시만
                out.append({"kind": "approval"})
            elif kind == "notice":                       # 스킬을 붙이지 못하고 글만 보냈다(스펙 2026-10-19-012 OV-H2)
                out.append({"kind": "notice", "code": "skill_failed", "name": turn.skill, "reason": str(value)})
            elif kind == "choices":                      # 되묻기 선택지(스펙 2026-10-23-005 R9) — 글로 바꾸면 목록이 깨진다
                out.append({"kind": "choices", "questions": value if isinstance(value, list) else []})
            else:
                out.append({"kind": kind, "text": str(value)[:8000]})
        return 200, {"items": out, "next": after + len(items), "done": turn.done, "status": turn.status,
                     "queue": bridge.queue_view(turn.office_sid)}
    if path == "/api/office/chat/stop" and method == "POST":
        return 200, bridge.control(turn, "stop", {})
    raise hub_auto.Fail(404, "not_found")


def _event_aliases(ev: dict) -> list[str]:
    payload = ev.get("payload") if isinstance(ev.get("payload"), dict) else {}
    return [str(x) for x in (ev.get("profile"), ev.get("assignee"), payload.get("assignee"), payload.get("profile")) if x]


def _office_audit(acc: office_access.Access, who: str, alias: str) -> None:
    """남의 에이전트를 시킨 오피스 명령을 기록한다. 작성자 자격 표시는 쿠키로 고른 에이전트가 아니라 시킨 자리의 에이전트로 정한다(최종 리뷰 M1, D15).
    관리자는 acting_on_others 가 거짓이라 여기 오지 않는다 — 그래서 세션의 관리자 표시 없이 이메일만으로 판정해도 된다."""
    if not acc.acting_on_others(alias):
        return
    pod_id = (acc.seat_of(alias) or {}).get("pod", "")
    pod = next((p for p in registry().pods if p.id == pod_id), None)
    token = store.actor_role.set(_actor_role(pod, {"email": who}, auth().enabled))
    try:
        store.log_usage("office_command", f"{who} {alias}", pod=pod_id)
    finally:
        store.actor_role.reset(token)


def _office_route(acc: office_access.Access, method: str, path: str, query: dict, body: dict, who: str) -> tuple[int, dict]:
    """오피스 API 한 요청을 접근 규칙에 맞춰 처리한다. 거절은 Denied·MeetingError·Fail 로 낸다."""
    one = lambda k: (query.get(k) or [""])[0]                    # noqa: E731
    def audit(alias, what):                                      # what 은 호출부 문서용 — 기록에는 남기지 않는다(note 를 「<이메일> <자리>」로 고정해 날짜별로 묶는다, 스펙 2026-10-22-001 §5-4)
        _office_audit(acc, who, alias)
    if path.startswith("/api/office/chat/"):
        return _office_chat(acc, method, path, one, body, who, audit)
    if path.startswith("/api/office/meeting"):
        m = office_meeting()
        if path == "/api/office/meeting" and method == "GET":
            try:
                room, after = int(one("room") or 0), int(one("after") or 0)
                thread = int(one("thread")) if one("thread") != "" else None    # 지난 대화(읽기 전용, 스펙 2026-10-20-027 S8)
            except ValueError:
                raise meeting.MeetingError(tr("방 번호가 맞지 않습니다", "The room number is invalid")) from None
            acc.require_room(room)
            return 200, m.view(room, after) if thread is None else m.view(room, after, thread=thread)
        if path == "/api/office/meeting/threads" and method == "GET":   # 「지난 대화」 목록(S8). 방을 볼 수 있으면 누구나(DR7)
            try:
                room = int(one("room") or 0)
            except ValueError:
                raise meeting.MeetingError(tr("방 번호가 맞지 않습니다", "The room number is invalid")) from None
            acc.require_room(room)
            return 200, m.threads(room)
        if path == "/api/office/meeting/new" and method == "POST":      # 「새 대화」(S3). 사용 기록·토픽 깨우기는 아래 오피스 REST 공통 경로가 한다(C2)
            try:
                room = int(body.get("room") or 0)
            except (TypeError, ValueError):
                raise meeting.MeetingError(tr("방 번호가 맞지 않습니다", "The room number is invalid")) from None
            acc.require_room(room)
            return 200, m.new_thread(room, who)
        if path == "/api/office/meeting/active" and method == "GET":
            return 200, meeting_active_for(office_meeting_active(), acc)
        if path == "/api/office/meeting/summary" and method == "POST":
            try:
                room = int(body.get("room") or 0)
            except (TypeError, ValueError):
                raise meeting.MeetingError(tr("방 번호가 맞지 않습니다", "The room number is invalid")) from None
            acc.require_room(room)
            return 200, {"markdown": m.summary(room, who, managed=acc.managed_aliases())}
        if path == "/api/office/meeting/skills" and method == "GET":   # 회의실 / 목록(스펙 2026-10-19-012 D2·R3·R5). 방 참가자만
            try:
                room = int(one("room") or 0)
            except ValueError:
                raise meeting.MeetingError(tr("방 번호가 맞지 않습니다", "The room number is invalid")) from None
            acc.require_room(room)
            got = m.skills(room)                       # 번역은 합친 뒤 요청 스레드에서 — 작업 스레드는 요청 언어를 모른다(리뷰 D8)
            return 200, {**got, "skills": skill_desc.apply(got.get("skills"), skill_commands.DESC_MAX)}
        if path == "/api/office/meeting/say" and method == "POST":
            targets = body.get("targets")
            try:
                room = int(body.get("room") or 0)
            except (TypeError, ValueError):
                raise meeting.MeetingError(tr("방 번호가 맞지 않습니다", "The room number is invalid")) from None
            acc.require_room(room)
            extra = {"files": body["files"]} if body.get("files") is not None else {}   # 파일이 없는 옛 요청은 옛 호출 그대로
            if str(body.get("skill") or "").strip():                                  # 스펙 2026-10-19-012: 스킬이 없는 옛 요청도 옛 호출 그대로
                extra["skill"] = str(body["skill"])
            extra["managed"] = acc.managed_aliases()                                   # 관리하지 않는 에이전트에게는 위키 쓰기 도구를 막는다(15-9)
            out = m.say(room, who, str(body.get("text") or ""), [str(t) for t in targets] if isinstance(targets, list) else None, **extra)
            attached = f" 첨부 {meeting_files.names(body['files'])}" if isinstance(body.get("files"), list) and body["files"] else ""   # i18n-ignore: 사용 기록에 저장되는 문장
            for alias in out["targets"]:
                audit(alias, f"회의 {room}{attached}")   # i18n-ignore: 사용 기록에 저장되는 문장
            return 202, out
        raise hub_auto.Fail(404, "not_found")
    # 칸반 보드 만들기·보내기(dispatch)는 관리자만(OMAI-1122, 스펙 2026-10-13-012 D3). 보드 이름·보관은 아래에서 막는다
    if method == "POST" and path in (f"{hub_auto.KANBAN}/boards", f"{hub_auto.KANBAN}/dispatch") and not acc.admin:
        raise office_access.Denied(tr("칸반 보드 만들기·실행은 관리자만 합니다", "Only admins can create or run boards"))
    auto = office_auto()
    cron = hub_auto.CRON.match(path)
    if cron:
        alias = cron.group(1)
        acc.require_use(alias)
        if method != "GET":
            if not acc.manages(alias):          # 쓰기는 관리자·에이전트 주인·팀 관리자만, 읽기는 보이는 자리(스펙 2026-10-15-003 R1·R7, 2026-10-22-001 D12)
                raise office_access.Denied(tr("AI 에이전트 작업공간 소유자나 팀 관리자, 관리자만 바꿉니다", "Only the AI Agent Workspace's owner, a team manager, or an admin can change scheduled jobs"))
            seat = acc.seat_of(alias) or {}
            updates = body.get("updates") if isinstance(body.get("updates"), dict) else {}
            refused = (cron_policy.profile_error(seat.get("pod", ""), seat.get("profile", "")) if method == "POST" and cron.group(2) == "/jobs" else "") or \
                cron_policy.deliver_error(seat.get("pod", ""), str(body.get("deliver") or updates.get("deliver") or ""), acc.admin)
            if refused:
                raise hub_auto.Fail(400, "invalid_field", refused)
            store.log_usage("cron_office_" + method.lower(), f"{who} {alias}"[:200], pod=seat.get("pod"))
            audit(alias, f"크론 {method}")   # i18n-ignore: 사용 기록에 저장되는 문장
        return hub_auto.route(auto, method, path, query, body)
    board = one("board")
    if path == "/api/office/events":
        status, out = hub_auto.route(auto, method, path, query, body)
        if not acc.admin:
            visible = acc.visible_aliases()
            out["events"] = [e for e in out.get("events", []) if all(a in visible for a in _event_aliases(e))]
        return status, out
    if re.fullmatch(hub_auto.KANBAN + r"/boards/[^/]+", path) and method != "GET" and not acc.admin:
        raise office_access.Denied(tr("보드 이름·보관은 관리자만 바꿉니다", "Only admins can rename or archive boards"))
    if path == f"{hub_auto.KANBAN}/tasks" and method == "POST":
        alias = str(body.get("assignee") or "")
        if not alias and not acc.admin:                          # 담당 없는 카드는 첫 설치본(남의 Hermes)의 분류 대기로 간다(OMAI-1286)
            raise office_access.Denied(tr("담당 AI 에이전트를 골라 주세요", "Choose an AI Agent to assign"), 400)
        acc.require_use(alias)
        status, out = hub_auto.route(auto, method, path, query, body)
        task_id = str((out.get("task") or {}).get("id") or "")
        if task_id:
            auto.record_owner(board, task_id, acc.email)
            audit(alias, f"카드 {task_id}")   # i18n-ignore: 사용 기록에 저장되는 문장
        return status, out
    tm = hub_auto.TASK_PATH.fullmatch(path)                     # 카드 하위 경로(runs/<번호>/commands 포함, 스펙 2026-11-03-001 X2)도 담당 검사를 받는다
    if tm and not acc.admin:
        assignee = auto.card_assignee(board, tm.group(1))
        if assignee:
            acc.require_use(assignee)
        for key in ("assignee", "profile"):                      # 담당을 바꾸는 요청은 새 담당도 시킬 수 있어야 한다
            if body.get(key):
                acc.require_use(str(body[key]))
    if tm and method != "GET":
        audit(auto.card_assignee(board, tm.group(1)), f"카드 {tm.group(1)} {method}")   # i18n-ignore: 사용 기록에 저장되는 문장
    status, out = hub_auto.route(auto, method, path, query, body)
    if path == f"{hub_auto.KANBAN}/board" and not acc.admin:       # 보이지 않는 자리 앞으로 된 카드는 보드에서 뺀다
        visible = acc.visible_aliases()
        out["columns"] = [{**c, "tasks": [t for t in c["tasks"] if not t.get("assignee") or t["assignee"] in visible]} for c in out.get("columns", [])]
    return status, out


def _kanban_loop(every: float = 20.0):
    """준비·진행 중인 카드가 있는 보드를 20초마다 밀어 준다. 크론 실행 소식도 같은 주기에 쌓는다."""
    while True:
        time.sleep(every)
        if not leader.is_leader():        # 칸반 배정·크론 소식 쌓기는 리더만(OMAI-1105). 두 서버가 같은 이벤트를 두 번 쌓지 않게
            continue
        try:
            auto = office_auto()
            auto.tick()
            auto.cron_sync(every=0)
        except Exception as exc:                              # 한 번 실패해도 다음 주기에 다시 한다
            print(f"오피스: 보드 밀어 주기 실패 ({type(exc).__name__})", flush=True)   # i18n-ignore: 로그


def lifecycle_once(kc=None) -> dict:
    """하루 1회 점검: Keycloak 구성원과 대조해 빠진 사람의 Hermes 를 멈추고, 오래 안 쓴 Hermes 를 멈춘다. 쿠버네티스 모드에서만.
    한쪽이 실패해도 다른 쪽은 한다. 결과(멈춘 이름·건너뛴 이유·오류)를 돌려주고 사용 기록에 남긴다."""
    client = k8s.client()
    if client is None:
        return {}
    out: dict = {"keycloak": None, "idle": [], "errors": []}
    reg = registry()
    reg.refresh(ttl=0)
    kc = kc if kc is not None else keycloak.admin_from_config()
    if kc is not None:
        try:
            out["keycloak"] = lifecycle.reconcile(client, client.list_agents(), kc.members())
        except (keycloak.KeycloakError, k8s.K8sError) as exc:
            out["errors"].append(f"Keycloak 대조: {exc}")   # i18n-ignore: 사용 기록에 저장되는 문장
    try:
        out["idle"] = lifecycle.run_idle(client, client.list_agents(), {p.id: p for p in reg.pods})
    except k8s.K8sError as exc:
        out["errors"].append(f"미사용 멈춤: {exc}")   # i18n-ignore: 사용 기록에 저장되는 문장
    try:                                       # 지운 에이전트의 남은 데이터 볼륨(OMAI-1291). 알림 항목은 받은편지함을 읽을 때 DB 로 만든다
        out["retained"] = len(retained_volumes.scan(client.list_pvcs(), {str((a.get("metadata") or {}).get("name") or "") for a in client.list_agents()}))
    except k8s.K8sError as exc:
        out["errors"].append(f"남은 볼륨: {exc}")   # i18n-ignore: 사용 기록에 저장되는 문장
    reg.refresh(ttl=0)
    kcres = out["keycloak"] or {}
    store.log_usage("lifecycle", f"keycloak 멈춤 {len(kcres.get('suspended', []))} 재개 {len(kcres.get('resumed', []))}"   # i18n-ignore: 사용 기록에 저장되는 문장
                                 f"{' 건너뜀: ' + kcres['skipped'] if kcres.get('skipped') else ''} · 미사용 멈춤 {len(out['idle'])}"   # i18n-ignore: 사용 기록에 저장되는 문장
                                 f"{' · 오류 ' + '; '.join(out['errors'])[:160] if out['errors'] else ''}")   # i18n-ignore: 사용 기록에 저장되는 문장
    return out


def migrate_admins_once(kc=None) -> dict:
    """K7: 화면이 예전에 준 관리자(access_grants.role=admin)를 Keycloak 관리자 그룹으로 옮긴다. 리더만 부른다(C5).
    이메일로 Keycloak 사용자를 하나만 찾으면 관리자 그룹에 넣고 그 행만 role=user 로 바꾼다. 찾지 못했거나 실패한 행은 그대로 두어
    계속 관리자로 읽힌다(말없이 권한을 잃지 않게, O9). 여러 번 불러도 결과가 같다. {moved: [이메일], left: [이메일]}."""
    reg = registry()
    pending = reg.admin_grants()
    kc = kc if kc is not None else _kc_admin()
    out: dict = {"moved": [], "left": list(pending)}
    if kc is None or not pending:
        return out
    try:
        tok = kc.token()
    except keycloak.KeycloakError as exc:
        print(f"관리자 옮기기: Keycloak 토큰 실패 ({exc.code})", flush=True)   # i18n-ignore: 로그
        return out
    for email in pending:
        try:
            found = kc.find_by_email(email, tok)
            if len(found) != 1:
                continue
            kc.set_admin(found[0]["id"], True, tok)
            reg.migrated(email)
            out["moved"].append(email)
        except keycloak.KeycloakError as exc:
            print(f"관리자 옮기기 실패 (HTTP {exc.code})", flush=True)   # i18n-ignore: 로그
    out["left"] = [e for e in pending if e not in out["moved"]]
    if out["moved"] or out["left"]:
        print(f"관리자 옮기기: {len(out['moved'])}명 옮김, {len(out['left'])}명 남음", flush=True)   # i18n-ignore: 로그
    return out


def _lifecycle_loop():
    time.sleep(300)                       # 기동 직후에는 등록부가 안정될 때까지 기다린다
    while True:
        if not leader.is_leader():        # 복제본 여러 개 중 리더만 Hermes 를 멈춘다(OMAI-1105). 아니면 잠시 뒤 다시 본다
            time.sleep(60)
            continue
        try:
            migrate_admins_once()         # K7: 남은 관리자 행이 없으면 Keycloak 을 부르지 않는다
        except Exception as exc:
            print(f"관리자 옮기기 실패 ({type(exc).__name__})", flush=True)   # i18n-ignore: 로그
        try:
            lifecycle_once()
        except Exception as exc:
            print(f"수명주기 점검 실패 ({type(exc).__name__})", flush=True)   # i18n-ignore: 로그
        try:
            hours = max(1.0, float(config.get("AAS_LIFECYCLE_HOURS", "24")))
        except ValueError:
            hours = 24.0
        time.sleep(hours * 3600)


def _required_settings() -> dict[str, str]:
    """시작할 때 비어 있으면 알릴 설정 {이름: 환경변수}. 쿠버네티스 모드에서는 에이전트마다 HermesAgent 에서 대시보드 주소를 얻으므로
    전역 Hermes 대시보드 주소(AAS_DASHBOARD_URL)를 요구하지 않는다."""
    required = {}
    if k8s.client() is None:
        required["Hermes API 서버 주소"] = "AAS_DASHBOARD_URL"  # i18n-ignore: 운영자가 읽는 시작 로그
    required["LiteLLM 주소"] = "AAS_LITELLM_URL"  # i18n-ignore: 운영자가 읽는 시작 로그
    return required


def serve(host: str = "127.0.0.1", port: int = 17900):
    a = auth()
    if host not in ("127.0.0.1", "localhost", "::1") and not a.enabled:
        raise SystemExit("로그인(OIDC)이 설정되지 않은 채로는 127.0.0.1 밖으로 열지 않습니다.")   # i18n-ignore: 명령줄 출력
    for line in config.missing(_required_settings()):
        print(f"설정이 비어 있어 해당 기능이 꺼집니다: {line}", flush=True)   # i18n-ignore: 로그
    # i18n-ignore: 운영자가 읽는 시작 로그
    print(f"AAS 제어면: http://{host}:{port}  로그인 {'켜짐' if a.enabled else '꺼짐(루프백 전용)'}  "
          f"POD {[p.id for p in registry().pods]}", flush=True)
    from . import app                                 # uvicorn·starlette 는 서버를 띄울 때만 읽는다(OMAI-1100)
    app.run(host, port)


def start_background() -> None:
    """서버가 도는 동안 함께 도는 반복 작업. ASGI 앱의 lifespan 시작 단계에서 한 번 부른다(시험 하네스는 부르지 않는다)."""
    threading.Thread(target=_office_loop, daemon=True, name="aas-office").start()
    threading.Thread(target=_presence_loop, daemon=True, name="aas-presence").start()
    threading.Thread(target=_identity_loop, daemon=True, name="aas-identity").start()
    threading.Thread(target=_market_tag_loop, daemon=True, name="aas-market-tags").start()
    threading.Thread(target=_skill_desc_loop, daemon=True, name="aas-skill-desc").start()
    threading.Thread(target=_lifecycle_loop, daemon=True, name="aas-lifecycle").start()
    threading.Thread(target=market_dispatch.loop, args=(k8s.client, lambda: {a["name"] for a in registry().agents}),
                     kwargs={"get_home": lambda pod: next((p.hermes_home for p in registry().pods if p.id == pod), None),   # 덮기 전에 그 POD 의 프로파일을 읽어 고친 스킬을 지킨다(스펙 2026-10-14-015)
                             "on_finished": _market_request_finished, "after_tick": market_update_cycle},   # 설치가 끝나면 판 비교를 새로, 새 버전 대기 표를 요청으로(2026-10-24-003 R14·R18)
                     daemon=True, name="aas-market").start()
    threading.Thread(target=_kanban_loop, daemon=True, name="aas-office-kanban").start()

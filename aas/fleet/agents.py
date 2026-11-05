# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""사용자 Hermes(`HermesAgent`)의 이름·모양·화면용 요약, 그리고 Pod 로의 변환.

AAS 서버는 HermesAgent 만 만들고 지운다. StatefulSet·PVC·Secret 같은 실제 리소스는 오퍼레이터가 맞춘다(계획 R8).
"""
from __future__ import annotations

import json
import math
import re
import secrets
import threading
import time
from dataclasses import replace

from ..common import config, db
from . import k8s
from ..hermes import readers
from ..common.i18n import tr
from .pods import Pod

EMAIL = re.compile(r"^[^@\s]+@(?=[^@\s]*$)[^@\s]+\.[^@\s]+$")   # 도메인 칸을 먼저 한 번 훑어 확인한다(되돌아가기로 제곱 시간, CodeQL #3~5·7·10)
NAME_PREFIX = "aas-agent-"                                  # 사용자 Hermes(HermesAgent·StatefulSet·파드) 이름의 앞부분
DELETED_SUB = "aas:deleted-owner"                           # 주인을 지운 Hermes 의 ownerSub(CRD 필수 칸이라 비울 수 없다). 누구의 sub 와도 같지 않다(lifecycle.orphan)


class AgentError(ValueError):
    def __init__(self, message: str, code: int = 400, field: str = "", extra: dict | None = None):
        super().__init__(message)
        self.code = code
        self.field = field                                  # 화면이 그 칸 옆에 오류를 보인다(크기 칸, 스펙 2026-10-30-003 §4-7)
        self.extra = extra or {}                            # 오류 본문에 더할 것(막힘 blocked, §4-8)


def new_name(email: str) -> str:
    """쿠버네티스 이름 규칙에 맞는 이름. `aas-agent-` + 이메일 앞부분 + 무작위 4자리(같은 사람이 여러 개를 만들 수 있다).
    StatefulSet 이름이라 52자 이하로 둔다(파드의 controller-revision-hash 레이블이 이름 + 11자이고 63자 이하여야 한다).
    2026-10-11 까지 만든 에이전트는 `hag-` 로 시작한다. 이름은 바꿀 수 없어 그대로 둔다."""
    local = re.sub(r"[^a-z0-9]+", "-", email.split("@", 1)[0].lower())[:30].strip("-") or "user"
    return f"{NAME_PREFIX}{local}-{secrets.token_hex(2)}"


def manifest(name: str, namespace: str, owner_sub: str, owner_email: str, display_name: str = "", size: dict | None = None) -> dict:
    spec = {"ownerSub": owner_sub, "ownerEmail": owner_email}
    if display_name:
        spec["displayName"] = display_name[:80]
    spec.update(size_spec(size or {}))                     # 관리자가 정한 칸만. 빈 칸은 오퍼레이터가 설치 기본값으로 채운다(스펙 2026-10-30-003 §4-1)
    return {"apiVersion": f"{k8s.GROUP}/{k8s.VERSION}", "kind": "HermesAgent", "metadata": {"name": name, "namespace": namespace}, "spec": spec}


def create(client: k8s.K8s, owner_email: str, owner_sub: str = "", display_name: str = "", name: str = "") -> dict:
    owner_email = owner_email.strip().lower()
    if not EMAIL.match(owner_email):
        raise AgentError(tr("소유자는 이메일 주소여야 합니다", "The owner must be an email address"))
    name = name or new_name(owner_email)
    if not re.fullmatch(r"[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?", name):
        raise AgentError(tr("이름은 소문자·숫자·- 로 63자까지입니다", "Use lowercase letters, digits, and - only, up to 63 characters"))
    try:
        return client.create_agent(manifest(name, client.namespace, owner_sub or owner_email, owner_email, display_name, desired(owner_email)))
    except k8s.K8sError as exc:
        raise AgentError(str(exc), 409 if exc.code == 409 else exc.code) from None


def _owner(spec: dict) -> str:
    """주인(이메일, 없으면 sub). 주인을 지운 Hermes 는 빈 문자열이다."""
    sub = str(spec.get("ownerSub") or "")
    return str(spec.get("ownerEmail") or (sub if sub != DELETED_SUB else "")).lower()


def view(item: dict) -> dict:
    """화면에 내보낼 만큼만. 계정 Secret 의 값은 여기 없다(이름만)."""
    spec, status, meta = item.get("spec") or {}, item.get("status") or {}, item.get("metadata") or {}
    sub = str(spec.get("ownerSub") or "")
    return {"name": meta.get("name", ""), "owner": _owner(spec),
            "owner_sub": sub if sub != DELETED_SUB else "",
            "deleted_owner": str((meta.get("annotations") or {}).get("aas.openmaru.io/deleted-owner") or ""),
            "display_name": spec.get("displayName", ""), "suspended": bool(spec.get("suspended")),
            "phase": status.get("phase") or "Pending", "message": status.get("message", ""),
            "ready": bool(status.get("readyReplicas")), "created": meta.get("creationTimestamp", ""),
            **{f"suspended_{k}": v for k, v in _suspended(item).items()},
            "channels": [c for c in (status.get("channels") or []) if isinstance(c, dict)],
            "channels_checked": status.get("channelsCheckedAt") or "", "channels_error": status.get("channelsError") or "",
            # 롤아웃이 지금 이 에이전트를 바꾸는 중(오퍼레이터의 rollout-updating 주석). 표가 「문제」에서 빼고 「업데이트 중」으로 보인다(스펙 2026-10-28-015 DD7)
            "updating": bool((meta.get("annotations") or {}).get("aas.openmaru.io/rollout-updating")),
            # 노드 자리가 없어 파드가 기다린다(오퍼레이터 status.waitReason, 스펙 2026-10-30-003 §4-2a), spec 의 크기 다섯 칸(§4-8)
            "wait_reason": str(status.get("waitReason") or ""), "size": spec_size(item),
            "busy": _busy(item)}                                # 대화 중(busy-until). 크기 저장 확인 창의 목록이 보인다(3A)


def _busy(item: dict) -> bool:
    from datetime import datetime, timezone
    from . import rollouts
    return rollouts._busy(item, datetime.now(timezone.utc))


def _suspended(item: dict) -> dict:
    from . import lifecycle
    return lifecycle.suspended_info(item)


def pod_from(item: dict) -> Pod | None:
    """준비된 HermesAgent 를 Pod 로. 아직 주소가 없거나 준비되지 않았으면 None(읽기를 시도하면 수집 실패만 쌓인다)."""
    status = item.get("status") or {}
    if status.get("phase") != "Ready":
        return None
    return _pod(item)


def restarting_pod_from(item: dict) -> Pod | None:
    """Ready 였다가 다시 뜨는 중인 HermesAgent 를 Pod(restarting=True) 로(스펙 2026-10-23-006). 게이트웨이 다시 시작(같은 파드)은 NotReady,
    파드를 새로 만드는 롤아웃은 readyPodUID 가 남은 Provisioning 이다(운영자 hermesagent_types.go). 멈춘 것·주소 없는 것·처음 만드는 것은 None."""
    spec, status = item.get("spec") or {}, item.get("status") or {}
    phase = status.get("phase")
    if spec.get("suspended") or not (phase == "NotReady" or (phase == "Provisioning" and status.get("readyPodUID"))):
        return None
    pod = _pod(item)
    # 롤아웃이 새 버전으로 바꾸는 중이면 사용자 띠가 이유를 말한다(스펙 2026-10-28-015 DD13)
    reason = "update" if ((item.get("metadata") or {}).get("annotations") or {}).get("aas.openmaru.io/rollout-updating") else ""
    return replace(pod, restarting=True, restart_reason=reason) if pod else None


def _pod(item: dict) -> Pod | None:
    spec, status, name = item.get("spec") or {}, item.get("status") or {}, (item.get("metadata") or {}).get("name", "")
    if not name or not status.get("dashboardURL") or not status.get("sidecarURL"):
        return None
    secret = status.get("credentialsSecret") or f"{name}-credentials"
    owner = _owner(spec)
    from ..assets import credentials
    home = readers.remote_home(status["sidecarURL"], label=name, token_fn=lambda s=secret: credentials.sidecar_token(s), key_extra=secret)
    sub = str(spec.get("ownerSub") or "")
    return Pod(name, owner, home, container=name, dashboard_url=status["dashboardURL"], sidecar_url=status["sidecarURL"], credentials_secret=secret,
               owner_sub=sub if sub != DELETED_SUB else "")


def ensure_first(client: k8s.K8s, agent_list: list[dict], sub: str, email: str, name: str = "") -> dict | None:
    """처음 로그인한 사람에게 Hermes 가 하나도 없으면 하나 만든다. 이미 있으면 None. agent_list 는 Registry.agents(view 모양)."""
    if any((sub and a.get("owner_sub") == sub) or a.get("owner") == email.lower() for a in agent_list):
        return None
    return create(client, email, sub, default_name(name or email.split("@", 1)[0], agent_list))


def default_name(who: str, agent_list: list[dict]) -> str:
    """「<사람 이름>의 AI 에이전트 작업공간」(2026-10-23 OMAI-1443, 새로 만드는 것부터. 이미 있는 이름은 그대로). 이미 있는 이름이면(주인 무관) 「… 2」「… 3」. 사람 이름 그대로면 사람과 에이전트가 헷갈린다(스펙 2026-10-21-019)."""
    base = tr(f"{who}의 AI 에이전트 작업공간", f"{who}'s AI Agent Workspace")
    taken = {str(a.get("display_name") or "").strip() for a in agent_list}
    n, name = 1, base
    while name in taken:
        n += 1
        name = f"{base} {n}"
    return name


# ---- 사용자당 개수 한도(R14). 기본값은 설치 값(AAS_AGENT_LIMIT, 기본 3), 사람마다 관리자가 바꾼 값은 aas.db 에 둔다.
_create_lock = threading.Lock()
LIMIT_SCHEMA = "CREATE TABLE IF NOT EXISTS agent_limits (email TEXT PRIMARY KEY, max INTEGER NOT NULL, by TEXT, ts TEXT NOT NULL)"
LIMIT_MAX = 50


def default_limit() -> int:
    try:
        return max(0, min(LIMIT_MAX, int(config.get("AAS_AGENT_LIMIT", "3"))))
    except ValueError:
        return 3


def limits() -> dict[str, int]:
    """관리자가 사람마다 바꾼 한도 {이메일: 개수}."""
    from ..common import store, table_cache

    def read() -> dict[str, int]:
        with store.connect() as conn:
            conn.execute(LIMIT_SCHEMA)
            return {r["email"]: int(r["max"]) for r in conn.execute("SELECT email, max FROM agent_limits")}
    try:                                                      # 표 바뀜 알림으로 버리는 캐시(스펙 2026-10-26-002 §9-12). 표 만들기도 캐시가 빌 때만
        return table_cache.get("agents.limits", ("agent_limits",), read)
    except Exception:
        return {}


def limit_for(email: str) -> int:
    return limits().get(email.lower(), default_limit())


def set_limit(email: str, value: int | None, by: str) -> None:
    """value=None 이면 기본값으로 되돌린다."""
    from datetime import datetime
    from ..common import store
    email = email.strip().lower()
    if not EMAIL.match(email):
        raise AgentError(tr("이메일 모양이 아닙니다", "Not a valid email address"))
    if value is not None and not (0 <= value <= LIMIT_MAX):
        raise AgentError(tr(f"한도는 0~{LIMIT_MAX} 사이여야 합니다", f"The limit must be between 0 and {LIMIT_MAX}"))
    with store.connect() as conn:
        conn.execute(LIMIT_SCHEMA)
        if value is None:
            conn.execute("DELETE FROM agent_limits WHERE email=?", (email,))
        else:
            conn.execute(db.upsert("agent_limits", ("email", "max", "by", "ts"), ("email",)),
                         (email, value, by, datetime.now().astimezone().isoformat(timespec="seconds")))


def owned_count(agent_list: list[dict], sub: str, email: str) -> int:
    """agent_list(view 모양) 중 이 사람의 것. 준비 전·실패한 것도 센다(자원을 이미 쓰고 있다)."""
    return sum(1 for a in agent_list if (sub and a.get("owner_sub") == sub) or a.get("owner") == email.lower())


def create_for_user(client: k8s.K8s, sub: str, email: str, display_name: str = "") -> dict:
    """사용자가 자기 Hermes 를 만든다. 개수는 쿠버네티스에서 방금 읽은 목록으로 세고, 한도를 넘으면 409."""
    email = email.strip().lower()
    with _create_lock:                                   # 같은 사람이 동시에 두 번 눌러도 한도를 넘지 않게
        try:
            current = [view(i) for i in client.list_agents()]
        except k8s.K8sError as exc:
            raise AgentError(str(exc), exc.code) from None
        n, limit = owned_count(current, sub, email), limit_for(email)
        if n >= limit:
            raise AgentError(tr(f"만들 수 있는 AI 에이전트 작업공간은 {limit}개까지입니다(지금 {n}개). 더 필요하면 관리자에게 한도를 늘려 달라고 요청하세요.",
                              f"You can create up to {limit} AI Agent Workspaces (you have {n}). Ask an admin to raise your limit if you need more."), 409)
        return create(client, email, sub, display_name)


def is_owner(item: dict, sub: str, email: str) -> bool:
    spec = item.get("spec") or {}
    return bool((sub and spec.get("ownerSub") == sub) or (email and str(spec.get("ownerEmail") or "").lower() == email.lower()))


def link_sub(client: k8s.K8s, agent_list: list[dict], sub: str, email: str) -> list[str]:
    """이메일로만 소유자가 적힌 Hermes(관리자가 미리 만들었거나 소유권을 옮긴 것)에 이 사람의 sub 를 이어 준다. 바꾼 이름을 돌려준다."""
    changed = []
    for a in agent_list:
        if a.get("owner") == email.lower() and a.get("owner_sub") != sub and sub:
            client.patch_agent(a["name"], {"spec": {"ownerSub": sub}})
            changed.append(a["name"])
    return changed


# ---- 작업공간 크기(스펙 2026-10-30-003 §4-4). 사람마다·관리자 기본값('*')을 aas.db 에 둔다. 빈 칸(NULL)은 한 단계 아래 값을 따른다 ----
# 우선순위: 사람 → 관리자 기본값 → 설치 기본값(오퍼레이터가 spec 의 빈 칸에 채운다, §4-1). 서버는 앞의 둘만 spec 에 쓴다.
ADMIN_SIZE = "*"
SIZE_FIELDS = ("cpu_request", "memory_request", "cpu_limit", "memory_limit", "storage")
RES_FIELDS = {"cpu_request": ("requests", "cpu"), "memory_request": ("requests", "memory"),
              "cpu_limit": ("limits", "cpu"), "memory_limit": ("limits", "memory")}
SIZE_SCHEMA = ("CREATE TABLE IF NOT EXISTS agent_sizes (email TEXT PRIMARY KEY, cpu_request TEXT, memory_request TEXT, "
               "cpu_limit TEXT, memory_limit TEXT, storage TEXT, by TEXT, ts TEXT NOT NULL)")
_CPU_IN = re.compile(r"^[0-9]+(\.[0-9]+)?m?$")              # 화면이 보내는 모양: 500m·2·0.5
_MEM_IN = re.compile(r"^[0-9]+(\.[0-9]+)?(Ki|Mi|Gi|Ti)?$")   # 1280Mi·4Gi
_QTY = re.compile(r"^([0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE]([+-]?[0-9]+))?(n|u|m|k|M|G|T|P|E|Ki|Mi|Gi|Ti|Pi|Ei)?$")
_SUFFIX = {"": 1.0, "n": 1e-9, "u": 1e-6, "m": 1e-3, "k": 1e3, "M": 1e6, "G": 1e9, "T": 1e12, "P": 1e15, "E": 1e18,
           "Ki": 2.0 ** 10, "Mi": 2.0 ** 20, "Gi": 2.0 ** 30, "Ti": 2.0 ** 40, "Pi": 2.0 ** 50, "Ei": 2.0 ** 60}
GIB = 2.0 ** 30


def qty(value) -> float | None:
    """쿠버네티스 수량 → 기본 단위(CPU 는 개, 메모리·디스크는 바이트). 읽을 수 없으면 None."""
    m = _QTY.match(str(value if value is not None else "").strip())
    if not m:
        return None
    return float(m.group(1)) * (10.0 ** int(m.group(2)) if m.group(2) else 1.0) * _SUFFIX[m.group(3) or ""]


def _same(a, b) -> bool:
    qa, qb = qty(a), qty(b)
    if qa is None or qb is None:
        return (a or None) == (b or None)
    return abs(qa - qb) <= 1e-9 * max(1.0, abs(qa))


def sizes() -> dict[str, dict]:
    """저장된 크기 {이메일 또는 '*': {칸: 수량 또는 None}}."""
    from ..common import store, table_cache

    def read() -> dict[str, dict]:
        with store.connect() as conn:
            conn.execute(SIZE_SCHEMA)
            return {r["email"]: {f: r[f] for f in SIZE_FIELDS} for r in conn.execute("SELECT email, " + ", ".join(SIZE_FIELDS) + " FROM agent_sizes")}
    try:                                                      # 개수 한도와 같은 표 바뀜 캐시(스펙 2026-10-26-002 §9-12)
        return table_cache.get("agents.sizes", ("agent_sizes",), read)
    except Exception:
        return {}


def desired(email: str, rows: dict | None = None) -> dict:
    """칸마다 사람 → 관리자 기본값. 둘 다 없는 칸은 None(설치 기본값은 오퍼레이터가 채운다, §4-4)."""
    rows = sizes() if rows is None else rows
    mine, base = rows.get((email or "").lower()) or {}, rows.get(ADMIN_SIZE) or {}
    return {f: (mine.get(f) or base.get(f) or None) for f in SIZE_FIELDS}


def with_install(want: dict, install: dict | None) -> dict:
    """빈 칸에 설치 기본값을 채운 값(검사·비교용). 설치 기본값을 모르면 그대로."""
    return {f: (want.get(f) or (install or {}).get(f) or None) for f in SIZE_FIELDS}


def clean_size(body: dict) -> dict:
    """POST 본문의 다섯 칸을 검사한다. 빈 값·null 은 None(그 칸을 비운다)."""
    out = {}
    for f in SIZE_FIELDS:
        raw = body.get(f)
        v = "" if raw is None else str(raw).strip()
        if not v:
            out[f] = None
            continue
        ok = (_CPU_IN if f.startswith("cpu") else _MEM_IN).match(v)
        if not ok or not qty(v):
            raise AgentError(tr("CPU 는 500m·2 처럼, 메모리·디스크는 1280Mi·4Gi 처럼 0보다 큰 값을 적으세요",
                                "Use a value above zero such as 500m or 2 for CPU, and 1280Mi or 4Gi for memory and disk"), field=f)
        out[f] = v
    return out


def check_order(merged: dict) -> None:
    """요청 ≤ 한도(합친 값 기준, §4-6). 둘 중 하나를 모르면 보지 않는다."""
    for kind in ("cpu", "memory"):
        r, lim = qty(merged.get(f"{kind}_request")), qty(merged.get(f"{kind}_limit"))
        if r is not None and lim is not None and r > lim + 1e-9:
            raise AgentError(tr("요청이 한도보다 큽니다", "The request is larger than the limit"), field=f"{kind}_request")


def set_size(email: str, values: dict, by: str) -> None:
    """칸이 모두 비면 행을 지운다(사람은 관리자 기본값, '*' 는 설치 기본값으로 간다)."""
    from datetime import datetime
    from ..common import store
    email = email.strip().lower()
    if email != ADMIN_SIZE and not EMAIL.match(email):
        raise AgentError(tr("이메일 모양이 아닙니다", "Not a valid email address"))
    with store.connect() as conn:
        conn.execute(SIZE_SCHEMA)
        if not any(values.get(f) for f in SIZE_FIELDS):
            conn.execute("DELETE FROM agent_sizes WHERE email=?", (email,))
        else:
            conn.execute(db.upsert("agent_sizes", ("email", *SIZE_FIELDS, "by", "ts"), ("email",)),
                         (email, *[values.get(f) for f in SIZE_FIELDS], by, datetime.now().astimezone().isoformat(timespec="seconds")))


def spec_size(item: dict) -> dict:
    """HermesAgent spec 의 다섯 칸(없으면 None)."""
    spec = item.get("spec") or {}
    res = spec.get("resources") or {}
    out = {f: (res.get(a) or {}).get(b) for f, (a, b) in RES_FIELDS.items()}
    out["storage"] = (spec.get("storage") or {}).get("size")
    return {f: (str(v) if v not in (None, "") else None) for f, v in out.items()}


def resources_of(want: dict) -> dict:
    """정한 칸만 담은 ResourceRequirements 모양. 크기 롤아웃 targets 는 오퍼레이터가 spec.resources 를 이 값으로 통째로 바꾸므로
    빈 칸을 null 로 보내지 않는다(빈 dict 면 spec.resources 를 지운다, §4-8)."""
    out: dict = {}
    for f, (a, b) in RES_FIELDS.items():
        if want.get(f):
            out.setdefault(a, {})[b] = want[f]
    return out


def resources_patch(item: dict, want: dict) -> dict:
    """merge-patch 용 spec.resources: 값이 있는 칸은 그 값, spec 에만 있는 칸은 null 로 지운다(F3). 바뀔 것이 없으면 빈 dict."""
    have, out = spec_size(item), {}
    for f, (a, b) in RES_FIELDS.items():
        if want.get(f) or have.get(f):
            out.setdefault(a, {})[b] = want.get(f) or None
    return out


def size_spec(want: dict) -> dict:
    """새 작업공간 spec 에 넣을 칸. PVC 크기는 만들 때만 정해진다(D2)."""
    spec: dict = {}
    res = resources_of(want)
    if res:
        spec["resources"] = res
    if want.get("storage"):
        spec["storage"] = {"size": want["storage"]}
    return spec


def install_defaults(doc: dict | None) -> dict | None:
    """오퍼레이터가 ConfigMap 에 적은 설치 기본값(§4-8). 모르면 None."""
    if not doc:
        return None
    dft = doc.get("defaults") or {}
    res = dft.get("resources") or {}
    out = {f: (res.get(a) or {}).get(b) for f, (a, b) in RES_FIELDS.items()}
    out["storage"] = dft.get("storage")
    return {f: (str(v) if v else None) for f, v in out.items()}


def size_differs(item: dict, want: dict, install: dict | None) -> bool:
    """「설정과 다름」(R13): (spec 칸 + 설치 기본값) 과 (desired 칸 + 설치 기본값) 이 CPU·메모리 네 칸 중 하나라도 다르다.
    PVC 는 이미 만든 것을 바꾸지 않아 보지 않는다(D2). 설치 기본값을 모르면 spec 과 desired 만 비교한다."""
    have = spec_size(item)
    for f in RES_FIELDS:
        a, b = have[f], want.get(f)
        if install:
            a, b = a or install.get(f), b or install.get(f)
        if not _same(a, b):
            return True
    return False


# ---- 남은 자리(§4-5). 오퍼레이터가 ConfigMap aas-capacity 에 노드별 재료를 쓰고 서버가 센다 ----
CAPACITY_CM, CAPACITY_KEY, QUOTA_NAME = "aas-capacity", "capacity.json", "agents-quota"
STALE_SECONDS = 660                                          # checkedAt 이 11분 넘게 그대로면 오래된 값(§4-5 6). 오퍼레이터는 내용이 같으면 5분(최대 5분 30초)마다만 checkedAt 을 고친다 — 두 번 놓친 시간(2026-11-04, 2분이던 때는 정상에도 경고)
_CAP_TTL = 15.0
_cap: dict = {"at": -1e9, "value": None, "busy": False}
_cap_lock = threading.Lock()


def _read_capacity(client: k8s.K8s) -> tuple[str, dict | None]:
    try:
        raw = (client.get_configmap(CAPACITY_CM).get("data") or {}).get(CAPACITY_KEY)
        doc = json.loads(raw) if raw else None
        value: tuple[str, dict | None] = ("ok", doc) if isinstance(doc, dict) else ("unknown", None)
    except k8s.K8sError as exc:                               # 없음(계산 꺼짐)·권한 없음(차트가 아직 옛것)은 「아직 모릅니다」(F8)
        value = ("unknown", None) if exc.code in (403, 404) else ("error", None)
    except ValueError:
        value = ("error", None)
    with _cap_lock:
        _cap.update(at=time.monotonic(), value=value, busy=False)
    return value


def capacity_doc(client: k8s.K8s, fresh: bool = False) -> tuple[str, dict | None]:
    """("ok"|"unknown"|"error", 내용). fresh 가 아니면 마지막 값을 바로 준다 — 목록 요청이 쿠버네티스를 기다리지 않게(OMAI-1109).
    오래되면 뒤에서 다시 읽는다. 아직 한 번도 읽지 않았으면 ("unknown", None)."""
    if fresh:
        return _read_capacity(client)
    with _cap_lock:
        value, stale = _cap["value"], time.monotonic() - _cap["at"] >= _CAP_TTL
        start = stale and not _cap["busy"]
        if start:
            _cap["busy"] = True
    if start:
        threading.Thread(target=_read_capacity, args=(client,), daemon=True, name="aas-capacity").start()
    return value or ("unknown", None)


def forget_capacity() -> None:
    with _cap_lock:
        _cap.update(at=-1e9, value=None, busy=False)


def read_quota(client: k8s.K8s) -> dict | None:
    """ResourceQuota agents-quota. 없거나 읽을 수 없으면 None(총량 상한을 보지 않는다)."""
    try:
        return client.get_resourcequota(QUOTA_NAME)
    except k8s.K8sError:
        return None


def _q(d: dict | None, key: str) -> float:
    return qty((d or {}).get(key)) or 0.0


def _when(raw: str):
    from datetime import datetime
    try:
        return datetime.fromisoformat(str(raw).replace("Z", "+00:00"))
    except ValueError:
        return None


def pod_request(doc: dict, want: dict) -> tuple[float, float] | None:
    """파드 하나의 요청(CPU 개, 메모리 바이트) = 칸 값(없으면 설치 기본값) + 파드당 추가 요청(사이드카·init, §4-5 1)."""
    full = with_install(want, install_defaults(doc))
    cpu, mem = qty(full.get("cpu_request")), qty(full.get("memory_request"))
    if not cpu or not mem:
        return None
    extra = doc.get("podExtra") or {}
    return cpu + _q(extra, "cpu"), mem + _q(extra, "memory")


def _free(n: dict) -> tuple[float, float]:
    return _q(n.get("allocatable"), "cpu") - _q(n.get("requests"), "cpu"), _q(n.get("allocatable"), "memory") - _q(n.get("requests"), "memory")


def _room(n: dict) -> bool:
    return not n.get("maxPods") or int(n.get("pods") or 0) < int(n["maxPods"])


def _quota_slots(quota: dict, cpu: float, mem: float, storage: float | None) -> int | None:
    st = quota.get("status") or {}
    hard, used = st.get("hard") or (quota.get("spec") or {}).get("hard") or {}, st.get("used") or {}
    per = {"pods": 1.0, "requests.cpu": cpu, "requests.memory": mem, "persistentvolumeclaims": 1.0, "requests.storage": storage}
    vals = [max(0, math.floor((_q(hard, k) - _q(used, k)) / unit + 1e-9)) for k, unit in per.items() if k in hard and unit]
    return min(vals) if vals else None


def capacity(state: str, doc: dict | None, want: dict, quota: dict | None = None, now=None) -> dict:
    """관리자 화면의 남은 자리(§4-5 서버 쪽 1~6, §4-8 모양). want 는 관리자 기본값(또는 크기 입력 창의 값)."""
    from datetime import datetime, timezone
    out: dict = {"state": state, "slots": None, "by_node": [], "top_node": None, "pending": None, "quota_limited": False,
                 "computed_at": "", "checked_at": "", "pod": None, "short": {}}
    if state != "ok" or not doc:
        return out
    out["computed_at"], out["checked_at"] = doc.get("computedAt") or "", doc.get("checkedAt") or doc.get("computedAt") or ""
    at = _when(out["checked_at"])
    now = now or datetime.now(timezone.utc)
    if at is None or (now - at).total_seconds() > STALE_SECONDS:
        out["state"] = "stale"
    pod = pod_request(doc, want)
    if not pod:
        out["state"] = "unknown"
        return out
    pc, pm = pod
    out["pod"] = {"cpu": pc, "memory": pm}
    rows, total = [], 0
    for n in doc.get("nodes") or []:
        fc, fm = _free(n)
        by = {"memory": math.floor(fm / pm + 1e-9), "cpu": math.floor(fc / pc + 1e-9)}
        if n.get("maxPods"):
            by["pods"] = int(n["maxPods"]) - int(n.get("pods") or 0)
        slots = max(0, min(by.values()))
        am, ac = _q(n.get("allocatable"), "memory"), _q(n.get("allocatable"), "cpu")
        rows.append({"name": n.get("name") or "", "slots": slots, "free_cpu": max(0.0, fc), "free_memory": max(0.0, fm),
                     "total_cpu": ac, "total_memory": am,                       # 노드 전체(allocatable). 화면의 「남음 / 전체」
                     "cpu_request_pct": round(100 * _q(n.get("requests"), "cpu") / ac) if ac else None,
                     "memory_request_pct": round(100 * _q(n.get("requests"), "memory") / am) if am else None,
                     "memory_limit_pct": round(100 * _q(n.get("limits"), "memory") / am) if am else None,
                     "limited_by": min(by, key=lambda k: by[k])})
        total += slots
    pend = doc.get("pendingHermes") or {}
    count = int(pend.get("count") or 0)
    # 노드가 정해지지 않은 Hermes 파드는 곧 자리를 쓴다(F14·R10). 개수와 요청 중 큰 쪽만큼 뺀다
    pend_slots = max(count, math.ceil(_q(pend, "cpu") / pc - 1e-9), math.ceil(_q(pend, "memory") / pm - 1e-9)) if count else 0
    out["pending"] = {"count": count, "slots": pend_slots}
    slots = max(0, total - pend_slots)
    if quota:
        q = _quota_slots(quota, pc, pm, qty(with_install(want, install_defaults(doc)).get("storage")))
        if q is not None and q < slots:
            slots, out["quota_limited"] = q, True
    top = max(rows, key=lambda r: r["slots"]) if rows else None
    if top and total and top["slots"] * 2 > total:                    # 한 노드에 절반 넘게 몰리면 늘 적는다(1B·F9)
        out["top_node"] = {"name": top["name"], "slots": top["slots"]}
    for r in rows:
        if r["slots"] == 0:
            out["short"][r["limited_by"]] = out["short"].get(r["limited_by"], 0) + 1
    out.update(slots=slots, by_node=rows)
    return out


def _gib(v: float) -> str:
    return f"{v / GIB:.2f}"


def check_size(doc: dict | None, merged: dict, targets: list[dict]) -> dict:
    """저장 전 검사(§4-6). merged 는 설치 기본값까지 채운 값, targets 는 이 값이 바로 적용될 작업공간
    [{name, memory_limit(지금 바이트 또는 None)}]. 돌려주는 값 {reject: 글|"", blocked: {...}|None, warnings: [글]}."""
    out: dict = {"reject": "", "blocked": None, "warnings": []}
    if not doc:
        return out
    pod = pod_request(doc, merged)
    nodes = doc.get("nodes") or []
    if not pod or not nodes:
        return out
    pc, pm = pod
    # F5: 어느 노드의 「할당 가능량 − 옮길 수 없는 파드 요청」에도 들어가지 않으면 어떤 경우에도 뜨지 못한다
    caps = [(_q(n.get("allocatable"), "cpu") - _q(n.get("fixedRequests"), "cpu"), _q(n.get("allocatable"), "memory") - _q(n.get("fixedRequests"), "memory")) for n in nodes]
    if not any(c >= pc - 1e-9 and m >= pm - 1e-9 for c, m in caps):
        bc, bm = max(c for c, _ in caps), max(m for _, m in caps)
        out["reject"] = tr(f"이 크기의 파드는 어느 노드에도 들어가지 않습니다(가장 큰 노드에 둘 수 있는 양: CPU {bc:.2f}개 · 메모리 {_gib(bm)}GiB)",
                           f"No node can hold a pod of this size (the most a node can hold: CPU {bc:.2f} · memory {_gib(bm)} GiB)")
        return out

    def fits(n: dict) -> bool:
        fc, fm = _free(n)
        return _room(n) and fc >= pc - 1e-9 and fm >= pm - 1e-9
    # D6·R5: 도는 작업공간의 요청을 올리면 그 노드에서 지금 요청을 돌려받은 여유로도, 다른 노드에도 들어가야 한다. 크기 롤아웃이 하나씩이라 따로 본다(D14)
    where = {a.get("name"): (n, a) for n in nodes for a in (n.get("agents") or [])}
    stuck = []
    for t in targets:
        if t["name"] not in where:
            continue                                           # 파드가 없다(멈춤·대기) — 다시 뜰 자리를 잡고 있지 않다
        node, a = where[t["name"]]
        oc, om = _q(a.get("requests"), "cpu"), _q(a.get("requests"), "memory")
        if pc <= oc + 1e-9 and pm <= om + 1e-9:
            continue
        fc, fm = _free(node)
        if not (fc + oc >= pc - 1e-9 and fm + om >= pm - 1e-9) and not any(fits(n) for n in nodes if n is not node):
            stuck.append(t["name"])
    if stuck:
        out["blocked"] = {"reason": tr(f"도는 AI 에이전트 작업공간 {len(stuck)}개가 이 크기로 다시 뜰 노드 자리가 없습니다. 저장하면 대기 상태로 남습니다",
                                       f"{len(stuck)} running AI Agent Workspaces have no node room to restart at this size. If you save, they stay waiting"),
                          "agents": stuck,
                          "nodes": [{"name": n.get("name") or "", "free_cpu": max(0.0, _free(n)[0]), "free_memory": max(0.0, _free(n)[1])} for n in nodes]}
    # 새 작업공간용 값이 지금 여유 노드에 들어가지 않으면 경고만(§4-6 4)
    if not any(fits(n) for n in nodes):
        out["warnings"].append(tr("지금 노드 여유로는 이 크기의 새 AI 에이전트 작업공간이 뜨지 못합니다. 다른 작업공간을 멈추면 자리가 생깁니다",
                                  "With the current node room, a new AI Agent Workspace of this size cannot start. Suspending other workspaces frees room"))
    # D9: 메모리 한도 합. 바로 바뀌는 작업공간이 있으면 그 노드에 늘어나는 만큼, 없으면(관리자 기본값) 새 작업공간 하나가 더해질 때
    new_lim = qty(merged.get("memory_limit"))
    if new_lim:
        worst = None
        for n in nodes:
            am = _q(n.get("allocatable"), "memory")
            if not am:
                continue
            here = {a.get("name") for a in (n.get("agents") or [])}
            delta = sum(new_lim - (t.get("memory_limit") or 0.0) for t in targets if t["name"] in here) if targets else new_lim
            pct = round(100 * (_q(n.get("limits"), "memory") + delta) / am)
            if delta > 0 and pct > 100 and (worst is None or pct > worst[1]):
                worst = (n.get("name") or "", pct)
        if worst:
            out["warnings"].append(tr(f"이 값이면 노드 {worst[0]} 의 메모리 한도 합이 {worst[1]}% 가 됩니다",
                                      f"With this value, the memory limit total on node {worst[0]} becomes {worst[1]}%"))
    return out

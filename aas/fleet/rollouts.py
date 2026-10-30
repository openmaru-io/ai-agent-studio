# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""순차 롤아웃(HermesRollout) — 관리자 「AI 에이전트」 화면의 버전 열·진행 띠가 읽는 요약과, 시작·멈춤·계속·되돌리기 요청.

진행은 오퍼레이터가 한다(cogentai-aas-operator 의 HermesRollout 컨트롤러). 서버는 HermesRollout 을 만들고 spec 의 칸만 바꾸며,
status 는 읽기만 한다. 대화 중인 에이전트에는 busy-until 주석을 달아 오퍼레이터가 마지막 묶음으로 미루게 한다(스펙 2026-10-28-015 §4-3·§4-4·§4-6).
"""
from __future__ import annotations

import re
import secrets
import threading
import time
from datetime import datetime, timedelta, timezone

from ..common.i18n import tr
from . import k8s

DIGEST = re.compile(r"^[^@\s]+@sha256:[0-9a-f]{64}$")
MAX_BATCH, DEFAULT_BATCH, MAX_CANARY, NAME_MAX = 5, 2, 5, 80
TERMINAL = ("Done", "Failed")
ANN_ROLLOUT_IMAGE = "aas.openmaru.io/rollout-image"
ANN_UPDATING = "aas.openmaru.io/rollout-updating"
ANN_BUSY = "aas.openmaru.io/busy-until"
ANN_BY = "aas.openmaru.io/created-by"
BUSY_TTL, BUSY_REFRESH = 120, 60      # 대화 중 표시는 2분, 남은 시간이 1분 미만일 때만 다시 쓴다(리뷰 D4 — HermesAgent 갱신·reconcile 을 줄인다)


class RolloutError(Exception):
    def __init__(self, message: str, code: int = 400):
        super().__init__(message)
        self.code = code


# ---- 읽기 -----------------------------------------------------------------
def digest(ref: str) -> str:
    """`저장소@sha256:…` 의 digest(`sha256:…`). 없으면 빈 값."""
    return ref.split("@", 1)[1] if "@sha256:" in (ref or "") else ""


def repo(ref: str) -> str:
    return (ref or "").split("@", 1)[0]


def same_as_chart(image: str, chart: str, version: str) -> bool:
    """롤아웃 값과 차트 값이 같은 판인가. 롤아웃은 digest, 차트는 태그라 글자로는 늘 다르다(2026-10-29 OKE 에서 같은 이미지에
    「차트 값과 다릅니다」가 뜸). 차트가 태그면 저장소가 같고 태그가 롤아웃의 버전 이름과 같을 때 같은 판으로 본다.
    서버는 레지스트리에 태그를 묻지 않으므로, 같은 태그를 다른 이미지로 덮어쓴 경우는 가리지 못한다."""
    image, chart = image or "", chart or ""
    if image == chart:
        return True
    if not digest(image) or "@" in chart:
        return False
    name, _, tag = chart.rpartition(":")
    return bool(name) and "/" not in tag and name == repo(image) and tag == (version or "")


def _meta(item: dict) -> dict:
    return item.get("metadata") or {}


def _created(item: dict) -> tuple:
    return (_meta(item).get("creationTimestamp") or "", _meta(item).get("name") or "")


def kind(item: dict) -> str:
    """롤아웃 종류: image(기본, kind 가 없는 옛 CR 도) · resize(크기 롤아웃, 스펙 2026-10-30-003 §4-2b·§4-8)."""
    return "resize" if (item.get("spec") or {}).get("kind") == "resize" else "image"


def _images(items: list[dict]) -> list[dict]:
    """이미지 목표·버전 이름·차트 비교는 이미지 롤아웃만 본다 — 크기 롤아웃에는 이미지가 없다."""
    return [i for i in items if kind(i) == "image"]


def blocking(item: dict) -> bool:
    """새 롤아웃을 막는 진행 중 롤아웃인가(Failed·Done·abort 는 막지 않는다, 디자인 리뷰 DD5)."""
    st, spec = item.get("status") or {}, item.get("spec") or {}
    return st.get("phase") not in TERMINAL and not spec.get("abort") and not _meta(item).get("deletionTimestamp")


def latest_done(items: list[dict]) -> dict | None:
    done = [i for i in items if (i.get("status") or {}).get("phase") == "Done" and (i.get("status") or {}).get("completionTime")]
    return max(done, key=lambda i: ((i.get("status") or {}).get("completionTime"), _meta(i).get("name") or "")) if done else None


def current(items: list[dict]) -> dict | None:
    """띠에 보일 롤아웃: 진행 중인 것, 없으면 가장 최근에 만든 것."""
    act = sorted((i for i in items if blocking(i)), key=_created)
    if act:
        return act[0]
    return max(items, key=_created) if items else None


def target(items: list[dict]) -> dict:
    """지금 「목표」: 진행 중인 (되돌리기가 아닌) 롤아웃, 없으면 마지막 Done 롤아웃의 기본값. 롤아웃이 한 번도 없으면 빈 값(오래됨을 알 수 없다)."""
    items = _images(items)
    act = sorted((i for i in items if blocking(i) and not (i.get("spec") or {}).get("rollbackOf")), key=_created)
    src = act[0] if act else latest_done(items)
    if not src:
        return {"image": "", "sidecar_image": "", "version": ""}
    st, spec = src.get("status") or {}, src.get("spec") or {}
    return {"image": st.get("defaultImage") or spec.get("image") or "", "sidecar_image": st.get("defaultSidecarImage") or spec.get("sidecarImage") or "",
            "version": spec.get("versionName") or ""}


def versions(items: list[dict]) -> dict[str, str]:
    """digest → 롤아웃에 적은 버전 이름(Q3). 같은 digest 를 여러 롤아웃이 썼으면 나중 것."""
    out: dict[str, str] = {}
    for i in sorted(_images(items), key=_created):
        spec = i.get("spec") or {}
        name = spec.get("versionName") or ""
        for ref in (spec.get("image"), spec.get("sidecarImage")):
            if name and digest(ref or ""):
                out[digest(ref)] = name
    return out


def agent_fields(item: dict, items: list[dict], tgt: dict | None = None, names: dict | None = None) -> dict:
    """관리자 표의 버전 칸(디자인 리뷰 DD6·DD18). item 은 HermesAgent 원본."""
    tgt = tgt if tgt is not None else target(items)
    names = names if names is not None else versions(items)
    spec, st = item.get("spec") or {}, item.get("status") or {}
    image, side = st.get("image") or "", st.get("sidecarImage") or ""
    over_h, over_s = bool(spec.get("image")), bool(spec.get("sidecarImage"))
    # 목표 digest. 롤아웃이 바꾸지 않는 컨테이너는 차트 태그(digest 없음)라 비교하지 않는다(2026-10-29 OKE 에서 모두 「오래됨」으로 보임)
    th, ts = digest(tgt["image"]), digest(tgt["sidecar_image"])
    # 「따로 지정됨」: 목표가 바꾸는 컨테이너를 모두 spec 으로 덮어써 롤아웃에서 빠지는 에이전트(리뷰 D13)
    pinned = (over_h or over_s) and (over_h or not th) and (over_s or not ts)
    outdated = None                         # 롤아웃이 한 번도 없으면 목표가 태그라 알 수 없다(§4-4)
    if th or ts:
        outdated = (not over_h and bool(image) and bool(th) and digest(image) != th) or \
                   (not over_s and bool(side) and bool(ts) and digest(side) != ts)
    state = ""
    cur = current(items)
    if cur and ((cur.get("status") or {}).get("phase") not in ("Done",)):
        name = _meta(item).get("name")
        for a in (cur.get("status") or {}).get("agents") or []:
            if a.get("name") == name:
                state = a.get("state") or ""
    return {"image_digest": image, "sidecar_digest": side, "version": names.get(digest(image), ""),
            "outdated": outdated, "pinned": pinned, "rollout_state": state}


def _seconds(a: str, b: str) -> int | None:
    try:
        x = datetime.fromisoformat(a.replace("Z", "+00:00"))
        y = datetime.fromisoformat(b.replace("Z", "+00:00"))
    except (AttributeError, ValueError):
        return None
    return int((y - x).total_seconds())


def _busy(item: dict, now: datetime) -> bool:
    raw = ((_meta(item).get("annotations") or {}).get(ANN_BUSY) or "")
    try:
        until = datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except ValueError:
        return False
    return now < until + timedelta(seconds=30)


def summary(items: list[dict], agent_items: list[dict], now: datetime | None = None) -> dict:
    """진행 띠·「오래됨」 카드·차트 값 안내가 읽는 요약(디자인 리뷰 DD1·DD4·DD5·DD9·DD11·DD12·DD19). 롤아웃이 없으면 rollout 은 None."""
    now = now or datetime.now(timezone.utc)
    tgt, done = target(items), latest_done(_images(items))
    out: dict = {"target": tgt, "ever": bool(done), "rollout": None, "chart_differs": False}
    if done:
        dst, ver = done.get("status") or {}, (done.get("spec") or {}).get("versionName") or ""
        out["chart_differs"] = bool(dst.get("chartImage")) and not (
            same_as_chart(dst.get("defaultImage"), dst.get("chartImage"), ver)
            and same_as_chart(dst.get("defaultSidecarImage"), dst.get("chartSidecarImage"), ver))
    cur = current(items)
    if not cur:
        return out
    spec, st, meta = cur.get("spec") or {}, cur.get("status") or {}, _meta(cur)
    agents = [a for a in (st.get("agents") or []) if isinstance(a, dict)]
    by_state = lambda s: [a["name"] for a in agents if a.get("state") == s]   # noqa: E731
    known = {_meta(i).get("name"): i for i in agent_items}
    waiting = by_state("waiting")
    free = [n for n in waiting if not (spec.get("skipBusy", True) and n in known and _busy(known[n], now))]
    deferred = [n for n in waiting if n not in free]
    canary = list(spec.get("canary") or [])
    canary_info = None
    if canary and not spec.get("rollbackOf"):
        c = next((a for a in agents if a.get("name") == canary[0]), None)
        if c:
            canary_info = {"name": c.get("name"), "state": c.get("state"),
                           "ready_seconds": _seconds(c.get("startedAt") or "", c.get("finishedAt") or "") if c.get("finishedAt") else None,
                           "waiting_seconds": _seconds(c.get("finishedAt") or "", now.isoformat()) if c.get("state") == "done" else None}
    batch = max(1, min(MAX_BATCH, int(spec.get("batchSize") or DEFAULT_BATCH)))
    out["rollout"] = {
        "name": meta.get("name"), "kind": kind(cur), "version": spec.get("versionName") or "", "phase": st.get("phase") or "Pending", "message": st.get("message") or "",
        "image": spec.get("image") or "", "sidecar_image": spec.get("sidecarImage") or "", "rollback_of": spec.get("rollbackOf") or "",
        "canary": canary, "canary_info": canary_info, "batch": int(st.get("batch") or 0), "batch_size": batch,
        "skip_busy": spec.get("skipBusy", True) is not False, "paused": bool(spec.get("paused")), "approved": bool(spec.get("approved")),
        "aborted": bool(spec.get("abort")), "blocking": blocking(cur),
        "total": len(agents), "done": len(by_state("done")), "updating": by_state("updating"), "waiting": len(waiting),
        "next_batch": (free or deferred)[:batch], "deferred_busy": len(deferred),
        "suspended": sum(1 for a in agents if a.get("suspended")), "excluded": list(st.get("excluded") or []),
        "reverted": by_state("reverted"), "failed": by_state("failed"),
        "started": st.get("startedAt") or meta.get("creationTimestamp") or "", "completed": st.get("completionTime") or "",
        "created_by": (meta.get("annotations") or {}).get(ANN_BY, ""),
        "agents": [{k: a.get(k) for k in ("name", "state", "image", "sidecarImage", "previous", "previousSidecar", "suspended", "startedAt", "finishedAt", "message")}
                   for a in agents],
    }
    return out


# ---- 쓰기 -----------------------------------------------------------------
def _new_name() -> str:
    return "hro-" + datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S") + "-" + secrets.token_hex(2)


def _check_free(items: list[dict]) -> None:
    for i in items:
        if blocking(i):
            raise RolloutError(tr(f"진행 중인 롤아웃({_meta(i).get('name')})이 있습니다", f"A rollout is already in progress ({_meta(i).get('name')})"), 409)


def create(client: k8s.K8s, body: dict, items: list[dict], agent_names: set[str], by: str) -> dict:
    """새 롤아웃(디자인 리뷰 DD10). 형식이 맞지 않거나 진행 중인 롤아웃이 있으면 거절한다. 레지스트리 조회는 하지 않는다(리뷰 D6)."""
    version = str(body.get("version_name") or "").strip()
    image = str(body.get("image") or "").strip()
    side = str(body.get("sidecar_image") or "").strip()
    if not version or len(version) > NAME_MAX:
        raise RolloutError(tr(f"버전 이름을 1~{NAME_MAX}자로 적으세요", f"Enter a version name of 1-{NAME_MAX} characters"))
    if not image and not side:
        raise RolloutError(tr("Hermes 이미지나 사이드카 이미지 가운데 하나 이상을 적으세요", "Enter a Hermes image or a sidecar image"))
    for ref in (image, side):
        if ref and not DIGEST.match(ref):
            raise RolloutError(tr("이미지는 저장소@sha256:<64자> 형식이어야 합니다", "Images must be repository@sha256:<64 hex>"))
    canary = [str(c) for c in (body.get("canary") or []) if str(c)]
    if len(canary) > MAX_CANARY or any(c not in agent_names for c in canary):
        raise RolloutError(tr("카나리는 있는 에이전트 다섯 개까지 고를 수 있습니다", "Pick up to five existing agents as the canary"))
    try:
        batch = int(body.get("batch_size") or DEFAULT_BATCH)
    except (TypeError, ValueError):
        batch = 0
    if not 1 <= batch <= MAX_BATCH:
        raise RolloutError(tr(f"묶음 크기는 1~{MAX_BATCH} 입니다", f"Batch size must be 1-{MAX_BATCH}"))
    _check_free(items)
    spec: dict = {"versionName": version, "batchSize": batch, "skipBusy": body.get("skip_busy", True) is not False}
    if image:
        spec["image"] = image
    if side:
        spec["sidecarImage"] = side
    if canary:
        spec["canary"] = canary
    obj = {"apiVersion": f"{k8s.GROUP}/{k8s.VERSION}", "kind": "HermesRollout",
           "metadata": {"name": _new_name(), "namespace": client.namespace, "annotations": {ANN_BY: by}}, "spec": spec}
    return client.create_rollout(obj)


def action(client: k8s.K8s, items: list[dict], name: str, op: str, by: str) -> dict:
    """멈춤·계속·되돌리기(디자인 리뷰 DD5·DD12). 되돌리기는 진행 중이면 abort 를 단 뒤 rollbackOf 롤아웃을 만든다."""
    item = next((i for i in items if _meta(i).get("name") == name), None)
    if item is None:
        raise RolloutError(tr("없는 롤아웃입니다", "Rollout not found"), 404)
    spec, phase = item.get("spec") or {}, (item.get("status") or {}).get("phase") or ""
    if op == "pause":
        if not blocking(item):
            raise RolloutError(tr("진행 중인 롤아웃이 아닙니다", "The rollout is not in progress"), 409)
        return client.patch_rollout(name, {"spec": {"paused": True}})
    if op == "resume":
        if blocking(item) and spec.get("paused"):
            return client.patch_rollout(name, {"spec": {"paused": False}})
        if blocking(item) and phase == "WaitingApproval":
            return client.patch_rollout(name, {"spec": {"approved": True}})
        raise RolloutError(tr("계속할 것이 없습니다(이미 진행 중이거나 끝났습니다)", "Nothing to resume"), 409)
    if op == "abort":                                                # 그만두기: 바꾼 것은 새 값으로 두고 남은 것은 그대로(스펙 2026-10-30-003 §4-2b)
        if not blocking(item):
            raise RolloutError(tr("진행 중인 롤아웃이 아닙니다", "The rollout is not in progress"), 409)
        return client.patch_rollout(name, {"spec": {"abort": True}})
    if op == "rollback":
        if kind(item) == "resize":                                   # 크기 롤아웃은 되돌리지 않는다. 값을 바꿔 다시 적용한다(§4-2b)
            raise RolloutError(tr("크기 롤아웃은 되돌릴 수 없습니다. 값을 바꿔 다시 적용하세요", "A size rollout cannot be rolled back. Change the values and apply again"), 409)
        if spec.get("rollbackOf"):
            raise RolloutError(tr("되돌리기 롤아웃은 다시 되돌릴 수 없습니다", "A rollback cannot be rolled back"), 409)
        changed = [a for a in ((item.get("status") or {}).get("agents") or []) if a.get("state") in ("done", "updating", "failed")]
        if not changed:
            raise RolloutError(tr("되돌릴 에이전트가 없습니다", "No agent to roll back"), 409)
        if blocking(item):
            client.patch_rollout(name, {"spec": {"abort": True}})
        _check_free([i for i in items if _meta(i).get("name") != name])
        obj = {"apiVersion": f"{k8s.GROUP}/{k8s.VERSION}", "kind": "HermesRollout",
               "metadata": {"name": _new_name(), "namespace": client.namespace, "annotations": {ANN_BY: by}},
               "spec": {"rollbackOf": name, "versionName": ((spec.get("versionName") or name) + tr(" 되돌리기", " rollback"))[:NAME_MAX],
                        "batchSize": max(1, min(MAX_BATCH, int(spec.get("batchSize") or DEFAULT_BATCH))), "skipBusy": spec.get("skipBusy", True) is not False}}
        return client.create_rollout(obj)
    raise RolloutError(tr("모르는 동작입니다", "Unknown action"))


def create_resize(client: k8s.K8s, items: list[dict], targets: list[dict], version: str, by: str) -> dict:
    """크기 롤아웃(스펙 2026-10-30-003 §4-2b·§4-8). targets=[{agent, resources}] — 오퍼레이터가 차례마다 spec.resources 를 이 값으로 바꾼다.
    진행 중인 롤아웃이 있으면 종류와 관계없이 409(디자인 1C·7A)."""
    if not targets:
        raise RolloutError(tr("다시 적용할 AI 에이전트 작업공간이 없습니다", "No AI Agent Workspace to apply"), 409)
    _check_free(items)
    obj = {"apiVersion": f"{k8s.GROUP}/{k8s.VERSION}", "kind": "HermesRollout",
           "metadata": {"name": _new_name(), "namespace": client.namespace, "annotations": {ANN_BY: by}},
           "spec": {"kind": "resize", "versionName": version[:NAME_MAX], "batchSize": 1, "skipBusy": True, "resize": {"targets": targets}}}
    return client.create_rollout(obj)


# ---- 대화 중 표시(busy-until) ----------------------------------------------
_busy_until: dict[str, float] = {}       # 에이전트 → 이 서버가 마지막으로 쓴 시각(초). 남은 시간이 넉넉하면 다시 쓰지 않는다
_busy_lock = threading.Lock()


def mark_busy(client: k8s.K8s, agent_name: str, now: float | None = None) -> bool:
    """대화를 보낸 에이전트에 busy-until=<지금+2분> 주석을 단다. 이 서버가 쓴 값이 1분 넘게 남아 있으면 쓰지 않는다. 썼으면 True."""
    now = time.time() if now is None else now
    with _busy_lock:
        if _busy_until.get(agent_name, 0) - now > BUSY_REFRESH:
            return False
        _busy_until[agent_name] = now + BUSY_TTL
    until = datetime.fromtimestamp(now + BUSY_TTL, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    try:
        client.patch_agent(agent_name, {"metadata": {"annotations": {ANN_BUSY: until}}})
    except k8s.K8sError:
        with _busy_lock:
            _busy_until.pop(agent_name, None)
        return False
    return True


def mark_busy_later(agent_name: str) -> None:
    """요청을 기다리게 하지 않으려고 뒤에서 쓴다. 쿠버네티스 모드가 아니면 아무것도 하지 않는다."""
    client = k8s.client()
    if client is None or not agent_name:
        return
    threading.Thread(target=mark_busy, args=(client, agent_name), daemon=True, name="aas-busy-until").start()

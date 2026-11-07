# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""작업공간 메모리 초과 안내와 메모리 늘리기 요청의 결과(OMAI-1856, 스펙 cogentai-aas-docs 2026-11-06-005 §5 O2).

받은편지함 항목은 읽을 때 계산한다(재검토 D1 — 크론 완료 알림과 같은 방식). 저장하는 것은 「확인했음」 하나뿐이다.
  workspace_oom   주인에게: 작업공간이 메모리 한도를 넘어 다시 시작했다(agents.oom_notice). id = oom|<작업공간>|<finishedAt>.
                  화면 서랍의 [닫기](디자인 D21)도 같은 확인 기록을 쓴다 — 두 곳이 함께 사라진다.
  size_failed     요청자에게: 메모리 늘리기 크기 롤아웃이 그 작업공간에서 실패했다. 요청은 대기로 남는다(재검토 R10).
                  id = sizefail|<롤아웃>|<작업공간>.
  blocked_route   관리자에게: 프로파일 모델이 AAS LiteLLM 이 아닌 주소로 간다(OMAI-1857 디자인 D10). id = route|<작업공간>|<프로파일>|<host:port>.
                  계산에서 빠진(해소된) 항목의 확인 기록은 그 자리에서 지워 다시 생기면 다시 알린다(재검토 H1). 멈춘 작업공간은 지우지 않는다(L2).
settle() 는 메모리가 커진 크기 롤아웃이 끝난(done) 작업공간의 대기 workspace_size 요청을 닫는다(디자인 D16·재검토 R10).
확인 기록은 workspace_oom 의 안내 기간(7일)보다 하루 길게 둔다(재검토 H1 — cron_done_ack 의 48시간을 따라 하면 7일 안내가 다시 뜬다).
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

from ..common import store
from ..fleet import agents
from . import admin_requests

SCHEMA = ("CREATE TABLE IF NOT EXISTS workspace_notice_ack (email TEXT NOT NULL, item_id TEXT NOT NULL, ts TEXT NOT NULL, "
          "PRIMARY KEY (email, item_id))")
OOM_PREFIX, FAIL_PREFIX, ROUTE_PREFIX = "oom|", "sizefail|", "route|"
KEEP = timedelta(days=agents.OOM_NOTICE_DAYS + 1)


def _conn():
    conn = store.connect()
    conn.executescript(SCHEMA)
    return conn


def _now() -> datetime:
    return datetime.now(timezone.utc)


def owns(item_id: str) -> bool:
    return item_id.startswith((OOM_PREFIX, FAIL_PREFIX, ROUTE_PREFIX))


def pod_of(item_id: str) -> str:
    """항목 id 의 작업공간 이름."""
    parts = item_id.split("|")
    if item_id.startswith((OOM_PREFIX, ROUTE_PREFIX)):
        return parts[1] if len(parts) > 1 else ""
    return parts[2] if len(parts) > 2 else ""


def ack(email: str, item_id: str, now: datetime | None = None) -> None:
    now = now or _now()
    with _conn() as conn:
        conn.execute("INSERT INTO workspace_notice_ack (email, item_id, ts) VALUES (?,?,?) ON CONFLICT DO NOTHING",
                     ((email or "").lower(), item_id, now.isoformat(timespec="seconds")))
        conn.execute("DELETE FROM workspace_notice_ack WHERE ts < ?", ((now - KEEP).isoformat(timespec="seconds"),))


def acked(email: str) -> set[str]:
    with _conn() as conn:
        return {r[0] for r in conn.execute("SELECT item_id FROM workspace_notice_ack WHERE email=?", ((email or "").lower(),))}


def oom_items(agent_rows: list[dict], email: str, now: datetime | None = None) -> list[dict]:
    """주인(email)의 작업공간 가운데 메모리 초과 안내가 있고 아직 확인하지 않은 것. agent_rows 는 등록부의 agents.view 값 전부
    (Ready 가 아닌 — 다시 시작을 되풀이하는 — 작업공간도 들어 있어야 한다, 재검토 C1)."""
    me = (email or "").lower()
    if not me:
        return []
    seen = acked(me)
    out = []
    for row in agent_rows:
        if (row.get("owner") or "").lower() != me:
            continue
        n = agents.oom_notice(row, now)
        if n and n["id"] not in seen:
            at = datetime.fromisoformat(n["finished_at"].replace("Z", "+00:00")).timestamp()
            out.append({"id": n["id"], "kind": "workspace_oom", "pod": row.get("name", ""), "alias": row.get("display_name") or row.get("name", ""),
                        "finished_at": n["finished_at"], "limit_memory": n["limit_memory"], "at": at})
    return out


def _created(item: dict) -> str:
    return str((item.get("metadata") or {}).get("creationTimestamp") or "")


def resize_outcomes(rollouts: list[dict]) -> dict[str, dict]:
    """크기 롤아웃의 작업공간별 마지막 결과: {작업공간: {state, memory(바이트|None), message, rollout}}. 끝난(done·failed) 것만."""
    out: dict[str, dict] = {}
    for item in sorted((r for r in rollouts if ((r.get("spec") or {}).get("kind") == "resize")), key=_created):
        spec, status = item.get("spec") or {}, item.get("status") or {}
        want = {str(t.get("agent") or ""): agents.qty((((t.get("resources") or {}).get("limits") or {}).get("memory")))
                for t in ((spec.get("resize") or {}).get("targets") or []) if isinstance(t, dict)}
        for a in status.get("agents") or []:
            name, state = str(a.get("name") or ""), str(a.get("state") or "")
            if name in want and state in ("done", "failed"):
                out[name] = {"state": state, "memory": want[name], "message": str(a.get("message") or ""),
                             "rollout": str((item.get("metadata") or {}).get("name") or "")}
    return out


def settle(rollouts: list[dict], agent_rows: list[dict], now: datetime | None = None) -> int:
    """메모리가 커진 크기 롤아웃이 끝난 작업공간의 대기 workspace_size 요청을 닫는다. 이전 한도는 그 작업공간의 메모리 초과 때 한도
    (last_termination.limit_memory) — 모르면 늘었는지 알 수 없어 닫지 않는다. 닫은 수."""
    pending = {w["pod"] for w in admin_requests.waiting_pods(None, "workspace_size")}
    if not pending:                                     # 받은편지함을 읽을 때마다 부른다 — 대기 요청이 없으면 롤아웃을 보지 않는다(DB 문장 수)
        return 0
    by_name = {r.get("name", ""): r for r in agent_rows}
    closed = 0
    for name, o in resize_outcomes(rollouts).items():
        if name not in pending:
            continue
        old = agents.qty(((by_name.get(name) or {}).get("last_termination") or {}).get("limit_memory"))
        if o["state"] == "done" and o["memory"] is not None and old is not None and o["memory"] > old:
            closed += admin_requests.close_workspace_size([name], old, o["memory"], now)
    return closed


def failed_items(rollouts: list[dict], email: str) -> list[dict]:
    """요청자(email)가 대기 중인 workspace_size 요청이 있는 작업공간에서 크기 롤아웃이 실패했다 — 실패 이유를 알린다. 확인하면 사라진다."""
    me = (email or "").lower()
    if not me:
        return []
    waiting = {w["pod"] for w in admin_requests.waiting_pods(me, "workspace_size")}
    seen = acked(me)
    out = []
    for name, o in resize_outcomes(rollouts).items():
        item_id = f"{FAIL_PREFIX}{o['rollout']}|{name}"
        if o["state"] == "failed" and name in waiting and item_id not in seen:
            out.append({"id": item_id, "kind": "size_failed", "pod": name, "alias": name, "text": o["message"], "at": _now().timestamp()})
    return out


def route_id(pod: str, profile: str, host: str) -> str:
    return f"{ROUTE_PREFIX}{pod}|{profile}|{host}"


def route_items(by_pod: dict[str, list[dict]], email: str, label=lambda pod: pod) -> list[dict]:
    """관리자(email)가 확인하지 않은 막히는 경로. by_pod = {작업공간: models.blocked_routes 결과} — 읽은 작업공간만 담는다.
    같은 (작업공간, 프로파일, 주소)는 모델이 여럿이어도 한 항목."""
    me = (email or "").lower()
    if not me:
        return []
    seen = acked(me)
    out, done = [], set()
    for pod, routes in by_pod.items():
        for r in routes:
            item_id = route_id(pod, r["profile"], r["host"])
            if item_id in seen or item_id in done:
                continue
            done.add(item_id)
            models = sorted({x["model"] for x in routes if x["profile"] == r["profile"] and x["host"] == r["host"]})
            out.append({"id": item_id, "kind": "blocked_route", "pod": pod, "alias": label(pod), "profile": r["profile"],
                        "host": r["host"], "models": models, "text": ", ".join(models), "at": _now().timestamp()})
    return out


def prune_routes(by_pod: dict[str, list[dict]]) -> int:
    """읽은 작업공간에서 계산에 없는(해소된) 경로의 확인 기록을 지운다 — 다시 생기면 다시 알린다(H1). 지운 수."""
    if not by_pod:
        return 0
    live = {route_id(pod, r["profile"], r["host"]) for pod, routes in by_pod.items() for r in routes}
    with _conn() as conn:
        rows = [r[0] for r in conn.execute("SELECT DISTINCT item_id FROM workspace_notice_ack WHERE item_id LIKE ?", (ROUTE_PREFIX + "%",))]
        gone = [i for i in rows if pod_of(i) in by_pod and i not in live]
        for i in gone:
            conn.execute("DELETE FROM workspace_notice_ack WHERE item_id=?", (i,))
    return len(gone)

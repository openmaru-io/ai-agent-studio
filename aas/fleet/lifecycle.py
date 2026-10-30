# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""사용자 Hermes 의 수명주기(계획 R19): 미사용 멈춤, Keycloak 대조 멈춤, 다시 띄우기, 소유권 이전, 지울 때의 연쇄 정리.

멈춤은 HermesAgent.spec.suspended 를 켜는 것이다(오퍼레이터가 replicas 0, 데이터는 그대로). 이유와 시각은 주석에 남긴다:
  aas.openmaru.io/suspended-reason = idle | keycloak | admin | disabled | deleted,  aas.openmaru.io/suspended-at = ISO 시각.
disabled 는 「사용자·권한」 화면에서 사용 중지한 사람의 것(다시 사용하면 켠다), deleted 는 지운 사람의 것이다(스펙 2026-10-14-011 R1·R3).
하루 1회 대조는 이유가 keycloak 인 것만 다시 켜므로 두 이유는 건드리지 않는다.
"""
from __future__ import annotations

import time
from datetime import datetime, timezone

from ..common import config, db, store
from ..hermes import hermes_reader as hr
from . import k8s
from ..common.i18n import tr

ANNO_REASON = "aas.openmaru.io/suspended-reason"
ANNO_AT = "aas.openmaru.io/suspended-at"
ANNO_DELETED_OWNER = "aas.openmaru.io/deleted-owner"   # 지운 사람의 옛 이메일. 「소유권 옮기기」로 새 주인을 정하면 지운다
REASONS = ("idle", "keycloak", "admin", "disabled", "deleted")
MAX_SUSPEND_SHARE = 0.5          # 한 번에 이 비율을 넘는 Hermes 를 Keycloak 때문에 멈추려 하면 설정 오류로 보고 멈추지 않는다


def idle_days() -> int:
    try:
        return max(1, int(config.get("AAS_AGENT_IDLE_DAYS", "30")))
    except ValueError:
        return 30


def _now_iso(now: float) -> str:
    return datetime.fromtimestamp(now, timezone.utc).isoformat(timespec="seconds")


def _created(item: dict) -> float:
    ts = hr.parse_ts((item.get("metadata") or {}).get("creationTimestamp"))
    return ts.timestamp() if ts else 0.0


def last_activity(home) -> float | None:
    """대화(sessions)와 크론 실행(jobs.json)의 가장 늦은 시각(epoch 초). 읽을 수 있는 것이 없으면 None."""
    best = None
    for prof in hr.profiles(home):
        db = prof.path / "state.db"
        if db.is_file():
            try:
                conn = hr._connect_immutable(db)
                have = {r["name"] for r in conn.execute("PRAGMA table_info(sessions)")}
                col = "MAX(COALESCE(last_activity_at, started_at))" if "last_activity_at" in have else "MAX(started_at)"
                val = conn.execute(f"SELECT {col} FROM sessions").fetchone()[0]
                if val and (best is None or float(val) > best):
                    best = float(val)
            except Exception:
                pass
        try:
            for job in hr.read_jobs(prof) or []:
                ts = hr.parse_ts(job.get("last_run_at"))
                if ts and (best is None or ts.timestamp() > best):
                    best = ts.timestamp()
        except Exception:
            pass
    return best


def suspend(client: k8s.K8s, name: str, reason: str, now: float | None = None) -> None:
    now = now or time.time()
    client.patch_agent(name, {"metadata": {"annotations": {ANNO_REASON: reason, ANNO_AT: _now_iso(now)}}, "spec": {"suspended": True}})


def resume(client: k8s.K8s, name: str) -> None:
    client.patch_agent(name, {"metadata": {"annotations": {ANNO_REASON: None, ANNO_AT: None}}, "spec": {"suspended": False}})


def orphan(client: k8s.K8s, name: str, old_email: str, now: float | None = None) -> None:
    """지운 사람의 Hermes: 옛 이메일 표시를 달고 주인을 비운 뒤 이유 deleted 로 멈춘다(K6·R3). 데이터(PVC)는 남긴다.
    주인을 비우면 같은 이메일로 다시 만든 계정에 link_sub·대조가 잇지 않는다. 넘기려면 관리자가 「소유권 옮기기」를 한다.
    ownerSub 는 CRD 에서 필수(1자 이상)라 지울 수 없어 누구의 sub 와도 같지 않은 표시값(agents.DELETED_SUB)을 넣는다."""
    from . import agents
    now = now or time.time()
    client.patch_agent(name, {"metadata": {"annotations": {ANNO_DELETED_OWNER: old_email, ANNO_REASON: "deleted", ANNO_AT: _now_iso(now)}},
                              "spec": {"suspended": True, "ownerSub": agents.DELETED_SUB, "ownerEmail": None}})


def suspended_info(item: dict) -> dict:
    ann = (item.get("metadata") or {}).get("annotations") or {}
    return {"reason": ann.get(ANNO_REASON, "") if (item.get("spec") or {}).get("suspended") else "",
            "since": ann.get(ANNO_AT, "") if (item.get("spec") or {}).get("suspended") else ""}


def run_idle(client: k8s.K8s, items: list[dict], pods: dict, now: float | None = None, days: int | None = None) -> list[str]:
    """준비된 Hermes 중 days 일 동안 대화·크론 실행이 없는 것을 멈춘다. pods: {이름: Pod}. 멈춘 이름을 돌려준다.
    만든 지 days 일이 안 됐거나 활동을 읽지 못한 것은 건드리지 않는다."""
    now, days = now or time.time(), days or idle_days()
    cutoff, stopped = now - days * 86400, []
    for item in items:
        name = (item.get("metadata") or {}).get("name", "")
        if (item.get("spec") or {}).get("suspended") or (item.get("status") or {}).get("phase") != "Ready" or name not in pods:
            continue
        if _created(item) > cutoff:
            continue
        try:
            last = last_activity(pods[name].hermes_home)
        except Exception:
            continue
        if last is None or last > cutoff:
            continue                     # 읽지 못했거나 최근에 썼다
        suspend(client, name, "idle", now)
        stopped.append(name)
    return stopped


def _in(members: list[dict], spec: dict) -> bool:
    sub, email = str(spec.get("ownerSub") or ""), str(spec.get("ownerEmail") or "").lower()
    return any(m["id"] == sub or (email and m["email"] == email) for m in members)


def reconcile(client: k8s.K8s, items: list[dict], members: list[dict], now: float | None = None) -> dict:
    """Keycloak 구성원과 맞춘다. 빠진 사람의 Hermes 는 멈추고(이유 keycloak), 돌아온 사람이 Keycloak 때문에 멈춘 것은 다시 띄운다.
    members 가 비어 있거나 한꺼번에 너무 많이 멈추게 되면 설정 오류로 보고 아무것도 하지 않는다."""
    now = now or time.time()
    out = {"suspended": [], "resumed": [], "skipped": ""}
    if not members:
        out["skipped"] = tr("OIDC 구성원이 0명이라 대조하지 않았습니다", "Skipped the check because OIDC has 0 members")
        return out
    from .agents import DELETED_SUB
    # 주인을 지운 Hermes(lifecycle.orphan)는 대조할 주인이 없다. 관리자가 다시 띄웠으면 그 결정을 따른다 — 넣으면 다음 대조가
    # 「OIDC 그룹에서 빠짐」으로 다시 멈춘다(OKE 2026-10-23). 주인을 정하려면 「소유권 옮기기」를 한다
    live = [i for i in items if not (i.get("spec") or {}).get("suspended") and (i.get("spec") or {}).get("ownerSub") != DELETED_SUB]
    gone = [i for i in live if not _in(members, i.get("spec") or {})]
    if live and len(gone) / len(live) > MAX_SUSPEND_SHARE and len(gone) > 1:
        out["skipped"] = tr(f"{len(live)}개 중 {len(gone)}개를 한꺼번에 멈추게 되어 설정 오류로 보고 중단했습니다", f"Stopped: suspending {len(gone)} of {len(live)} at once looks like a misconfiguration")
        return out
    for item in gone:
        name = item["metadata"]["name"]
        suspend(client, name, "keycloak", now)
        out["suspended"].append(name)
    for item in items:
        spec = item.get("spec") or {}
        if spec.get("suspended") and suspended_info(item)["reason"] == "keycloak" and _in(members, spec):
            resume(client, item["metadata"]["name"])
            out["resumed"].append(item["metadata"]["name"])
    return out


def known_sub(email: str) -> str:
    """이 이메일로 로그인한 적이 있으면 그 sub(없으면 빈 문자열)."""
    try:
        with store.connect() as conn:
            row = conn.execute("SELECT sub FROM auth_sessions WHERE email=? AND sub!='' ORDER BY created DESC LIMIT 1", (email.lower(),)).fetchone()
        return row["sub"] if row else ""
    except Exception:
        return ""


def cascade(pod_id: str) -> dict[str, int]:
    """지운 Hermes(pod id)를 가리키는 AAS 기록을 정리한다: 오피스 자리·방의 자리 목록·보드 연결·카드·크론 동기 기록, 마켓 허용, 사용자별 볼 Hermes,
    주 프로파일 기록·채팅 기본 프로파일.
    스냅샷 이력(수집 기록)은 남긴다. 표가 아직 없으면 건너뛴다."""
    import json as _json
    counts: dict[str, int] = {}
    with store.connect() as conn:
        have = db.table_names(conn)
        aliases = []
        if "office_seats" in have:
            aliases = [r["alias"] for r in conn.execute("SELECT alias FROM office_seats WHERE pod=?", (pod_id,))]
            counts["seats"] = conn.execute("DELETE FROM office_seats WHERE pod=?", (pod_id,)).rowcount
        if "office_rooms" in have and aliases:
            n = 0
            for r in conn.execute("SELECT id, seats FROM office_rooms").fetchall():
                try:
                    cur = _json.loads(r["seats"])
                except ValueError:
                    continue
                kept = [a for a in cur if a not in aliases]
                if kept != cur:
                    conn.execute("UPDATE office_rooms SET seats=? WHERE id=?", (_json.dumps(kept), r["id"]))
                    n += 1
            counts["rooms"] = n
        if "office_cron" in have and aliases:
            counts["cron"] = sum(conn.execute("DELETE FROM office_cron WHERE alias=?", (a,)).rowcount for a in aliases)
        if "office_board_pods" in have:
            counts["boards"] = conn.execute("DELETE FROM office_board_pods WHERE pod=?", (pod_id,)).rowcount
        if "office_cards" in have:
            counts["cards"] = conn.execute("DELETE FROM office_cards WHERE pod=?", (pod_id,)).rowcount
        if "market_grants" in have:
            counts["market"] = conn.execute("DELETE FROM market_grants WHERE pod=?", (pod_id,)).rowcount
        if "access_grants" in have:
            n = 0
            for r in conn.execute("SELECT email, pods FROM access_grants").fetchall():
                ids = [x for x in r["pods"].split(",") if x]
                if pod_id in ids:
                    conn.execute("UPDATE access_grants SET pods=? WHERE email=?", (",".join(x for x in ids if x != pod_id), r["email"]))
                    n += 1
            counts["grants"] = n
        # 주 프로파일 기록·채팅 기본 프로파일(스펙 2026-10-19-001 R7·R3). 같은 이름으로 다시 만들면 옛 templated 상태를 물려받아
        # 루트는 숨고 main 은 만들지 않아 프로파일 목록이 비었다
        for table, key in (("pod_primary", "primary"), ("pod_default_profile", "chat_default")):
            if table in have:
                counts[key] = conn.execute(f"DELETE FROM {table} WHERE pod=?", (pod_id,)).rowcount
    from . import primary
    primary.forget_cache()
    if counts.get("cards"):
        from ..office import hub_auto
        hub_auto.cards_written()                               # 커밋 뒤 — 진행 카드 기억이 다시 읽게(스펙 2026-10-26-002 R5)
    return {k: v for k, v in counts.items() if v}

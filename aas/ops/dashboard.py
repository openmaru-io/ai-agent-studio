# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""대시보드(계획 2026-10-14-014). 리더 수집 바퀴가 POD 요약과 일별 사용량을 DB 에 쌓고, /api/dashboard 는 DB 만 읽는다.

- 쓰는 쪽(record_round·record_usage)은 리더 서버의 30분 바퀴에서만 돈다. POD 마다 사이드카를 읽는다.
- 읽는 쪽(view)은 Hermes·사이드카를 부르지 않는다(R1). 서버가 두 대여도 같은 DB 값을 보인다.
- 관리자가 아니면 볼 수 있는 POD 만, 주인 이메일·운영 정보·snapshot_totals 는 빼고 준다(R2·R7).
"""
from __future__ import annotations

import json
from datetime import datetime, timedelta

from ..common import db, store
from ..common.i18n import tr
from . import activity, channels, collect_all, models

TREND_DAYS = 30                  # 사용 기록·수집 보관 31일 안에 들어가게(스펙 2026-10-24-006 R4, 예전 35)
STALE_SECONDS = 3600                     # 1시간 넘은 값은 「n시간 전 값」(디자인 DD4)


def _now() -> datetime:
    return datetime.now().astimezone()


# ---- 쓰는 쪽(리더 수집 바퀴) ------------------------------------------------------------------------
def cron_of(health: dict, pod_id: str, single: bool) -> dict:
    """합친 크론 수집 결과에서 POD 하나의 숫자. POD 하나 설치는 이름에 「pod/」 가 없어 전부 그 POD 다."""
    rows = [p for p in health.get("profiles", []) if single or str(p.get("name", "")).startswith(pod_id + "/")]
    pick = lambda k: sum(int(p.get(k) or 0) for p in rows)          # noqa: E731
    return {"jobs": pick("jobs_total"), "jobs_active": pick("jobs_active"), "failed_jobs": pick("failed_jobs"),
            "stalled_jobs": pick("stalled_jobs"), "open_incidents": pick("open_incidents")}


def expiring_credentials(items: list[dict]) -> int:
    """만료됐거나 곧 만료되는 자격증명 수. 홈 카드와 같게 백업·임시 파일은 뺀다."""
    return sum(1 for i in items if any("만료" in f for f in i.get("flags", []))  # i18n-ignore: 서버 플래그 비교
               and not any("백업" in f for f in i.get("flags", [])))  # i18n-ignore: 서버 플래그 비교


def pod_values(pod) -> dict:
    """POD 하나의 게이트웨이·문제 프로파일·만료 자격증명. 사이드카 읽기 두 번(채널 상태 파일, 자격증명 파일)."""
    from ..assets import inventory
    chan = channels.collect(pod.hermes_home, pod.container)["totals"]
    creds = inventory.credentials(pod.hermes_home)["items"]
    return {"profiles": chan["profiles"], "gateways_up": chan["gateways_up"], "profiles_bad": chan["profiles_with_bad"],
            "creds_expiring": expiring_credentials(creds),
            "messengers_connected": chan["messengers_connected"], "messengers_total": chan["messengers_total"]}


def record_round(pods: list, health: dict, read=pod_values) -> None:
    """수집 바퀴 한 번. 크론 수집에 실패한 POD 와 요약을 못 읽은 POD 는 실패로 적고 지난 값은 둔다(DD5)."""
    checked = _now().isoformat(timespec="seconds")
    failed = {f["pod"]: f.get("reason", "") for f in (health.get("pods") or {}).get("failed", [])}
    single = len(pods) == 1
    got = collect_all.map_pods([p for p in pods if p.id not in failed], read)
    for p in pods:
        if p.id in failed:
            store.save_pod_summary(p.id, checked, None, str(failed[p.id]))
            continue
        ok, value = got.get(p.id, (False, tr("수집하지 못함", "Not collected")))
        if ok:
            store.save_pod_summary(p.id, checked, {**cron_of(health, p.id, single), **value})
        else:
            store.save_pod_summary(p.id, checked, None, str(value))
    try:
        gw = models.fetch_litellm(*models._resolve_key(""))
        litellm = {"reachable": gw["reachable"], "error": gw.get("error", ""), "ts": checked}
    except Exception as exc:                                  # LiteLLM 확인 실패가 바퀴를 멈추지 않게 한다
        litellm = {"reachable": False, "error": type(exc).__name__, "ts": checked}
    with store.connect() as conn:
        conn.execute(db.upsert("meta", ("key", "value"), ("key",)), ("litellm_status", json.dumps(litellm, ensure_ascii=False)))


def usage_due(now: datetime) -> bool:
    """하루 한 번 00:30 바퀴에서. 한 번도 쌓지 않았으면 바로(처음 반영 때 TREND_DAYS 일을 채운다, R10)."""
    with store.connect() as conn:
        row = conn.execute("SELECT value FROM meta WHERE key='usage_daily_run'").fetchone()
    if not row:
        return True
    return row["value"] != now.date().isoformat() and (now.hour, now.minute) >= (0, 30)


def record_usage(pods: list, now: datetime | None = None, read=activity.daily) -> None:
    """어제까지의 날별 사용량. POD 마다 마지막으로 쌓은 날부터(없으면 TREND_DAYS 일 전부터) 오늘 0시 전까지 다시 센다.
    오늘 값은 쌓지 않는다 — 화면은 지금 POD 의 /api/activity 로 본다."""
    now = now or _now()
    today = now.replace(hour=0, minute=0, second=0, microsecond=0)
    oldest = today - timedelta(days=TREND_DAYS)

    def one(p):
        last = store.usage_last_day(p.id)
        start = max(oldest, datetime.fromisoformat(last).replace(tzinfo=today.tzinfo)) if last else oldest
        return read(start.timestamp(), today.timestamp(), home=p.hermes_home)
    for pid, (ok, value) in collect_all.map_pods(pods, one).items():
        if ok:
            store.save_usage_days(pid, value)
        else:
            print(f"일별 사용량 실패 {pid}: {value}", flush=True)  # i18n-ignore: 로그
    with store.connect() as conn:
        conn.execute(db.upsert("meta", ("key", "value"), ("key",)), ("usage_daily_run", now.date().isoformat()))


# ---- 읽는 쪽(/api/dashboard) ------------------------------------------------------------------------
def _age_seconds(ts: str | None, now: datetime) -> float | None:
    try:
        return (now - datetime.fromisoformat(ts)).total_seconds() if ts else None
    except ValueError:
        return None


def next_collect(now: datetime) -> str:
    """다음 수집 시각(매시 0·30분)."""
    nxt = now.replace(second=0, microsecond=0) + timedelta(minutes=30 - now.minute % 30)
    return nxt.isoformat(timespec="minutes")


def _meta(key: str) -> dict | None:
    with store.connect() as conn:
        row = conn.execute("SELECT value FROM meta WHERE key=?", (key,)).fetchone()
    try:
        return json.loads(row["value"]) if row else None
    except ValueError:
        return None


def _ops() -> dict:
    """관리자 운영 정보 한 줄: 사용자 수·최근 로그인, LiteLLM, 마켓 배달기, 마지막 수집 바퀴. 모두 DB·로컬 파일."""
    from ..market import marketplace
    with store.connect() as conn:
        row = conn.execute("SELECT COUNT(DISTINCT note) n, MAX(ts) last FROM usage WHERE kind='login'").fetchone()
    return {"users": int(row["n"] or 0) if row else 0, "last_login": row["last"] if row else None,
            "litellm": _meta("litellm_status"), "collect": collect_all.last_round(),
            # 마켓 설치를 끈 환경(compose 시험)에는 배달기가 없다 — 「멈춤」으로 잘못 보이지 않게 뺀다
            "market": marketplace.helper_status() if marketplace.install_state()["enabled"] else None}


def _people() -> dict:
    from ..office import office                            # 사람 표시 이름(office_people). 오피스 모듈을 늦게 부른다
    return office.people()


def _owner_name(email: str, known: dict) -> str:
    from ..office import office
    return office.display_name(email, known) if email and "@" in email else (email or "")


def view(reg, user, auth_enabled: bool, now: datetime | None = None) -> dict:
    """역할에 맞춘 대시보드 값. Hermes·사이드카를 부르지 않는다."""
    now = now or _now()
    admin = (not auth_enabled) or reg.is_admin(user)
    allowed = reg.allowed(user, auth_enabled)
    summaries = store.pod_summaries()
    k8s_agents = {a["name"]: a for a in getattr(reg, "agents", []) or []}
    rows = []
    names = _people() if admin else {}             # 「known」은 아래에서 POD id 집합으로 쓴다 — 겹치지 않게(2026-10-18)
    last_days = store.usage_last_days([p.id for p in allowed])
    for p in allowed:
        s = summaries.get(p.id)
        age = _age_seconds((s or {}).get("checked"), now)
        row = {"id": p.id, "name": (k8s_agents.get(p.id) or {}).get("display_name") or "",       # 에이전트 이름(없으면 화면이 id)
               "owner_me": bool(auth_enabled and p.owned_by(user)) or not auth_enabled, "ready": True,   # 주인 표시라 그대로
               "phase": (k8s_agents.get(p.id) or {}).get("phase", "Ready"),
               "collected": bool(s), "ok": bool(s and s["ok"]), "reason": (s or {}).get("reason") or "",
               "ts": (s or {}).get("ts"), "checked": (s or {}).get("checked"),
               "stale": age is not None and age > STALE_SECONDS,
               "values": {k: s[k] for k in store.SUMMARY_KEYS} if s and s.get("ts") else None,
               "last_day": last_days.get(p.id)}
        if admin:
            row["owner"] = p.owner
            row["owner_name"] = _owner_name(p.owner, names)            # 주인 칸은 사람 이름으로(2026-10-18). 이메일은 칩의 풍선말
        rows.append(row)
    if admin:                                             # 준비 중인 에이전트(쿠버네티스, 아직 등록부에 없음)도 표에 둔다
        known = {p.id for p in allowed}
        for name, a in k8s_agents.items():
            if name not in known:
                rows.append({"id": name, "name": a.get("display_name") or "", "owner": a.get("owner", ""), "owner_name": _owner_name(a.get("owner", ""), names), "owner_me": False, "ready": False, "phase": a.get("phase", ""),
                             "collected": False, "ok": False, "reason": "", "ts": None, "checked": None, "stale": False,
                             "values": None, "last_day": None})
    ok_rows = [r for r in rows if r["ok"] and r["values"]]
    total = lambda k: sum(r["values"][k] for r in ok_rows)          # noqa: E731
    ready = sum(1 for r in rows if r["ready"])
    totals = {"agents_ready": ready, "agents_total": len(rows),
              "failed_stalled": total("failed_jobs") + total("stalled_jobs"), "profiles_bad": total("profiles_bad"),
              "creds_expiring": total("creds_expiring"),
              # 합계는 이번 수집에 성공한 에이전트만 센다. 몇 개 기준인지 함께 준다(디자인 DD5)
              "counted": len(ok_rows), "countable": sum(1 for r in rows if r["ready"]),
              "failed": sum(1 for r in rows if r["ready"] and r["collected"] and not r["ok"])}
    ids = None if admin else [p.id for p in allowed]
    since = (now - timedelta(days=TREND_DAYS)).date().isoformat()
    out = {"admin": admin, "now": now.isoformat(timespec="seconds"), "next_collect": next_collect(now),
           "collected_at": max((r["checked"] for r in rows if r["checked"]), default=None),
           "pods": rows, "totals": totals, "trend": store.trend(TREND_DAYS, ids, totals=admin), "usage": store.usage_days(ids, since)}
    if admin:
        out["ops"] = _ops()
    return out

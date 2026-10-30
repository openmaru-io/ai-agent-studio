# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""Cron 건강 — 프로파일을 가로지르는 네 가지 집계.

1. 열린 사건(detected·alerted)   2. 마지막 실행이 실패인 작업
3. 멈춘 작업                     4. 실패해도 사람에게 알리지 않는 작업
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

from ..hermes import hermes_reader as hr
from ..common.i18n import tr
from ..common.redact import redact

STALL_GRACE = timedelta(hours=2)      # 예정 시각을 이만큼 넘기면 멈춤으로 본다
RUNNING_LIMIT = timedelta(hours=6)    # 이만큼 넘게 실행 중이면 걸린 것으로 본다
NEW_WINDOW = timedelta(hours=24)
STALE_GRACE = timedelta(minutes=10)   # DB 가 jobs.json 보다 이만큼 뒤처지면 stale
OPEN_STATES = ("detected", "alerted")
# 실행이 실패하지 않은 마지막 결과. delivery_failed 는 실행은 성공했고 결과 전달만 실패한 것이다(Hermes 가 failure_streak 에도 세지 않는다).
# 전달 문제는 「알림 대상이 없는 작업」(마지막 전달이 실패함)으로 따로 알린다(OMAI-1292)
OK_STATUSES = (None, "", "ok", "success", "completed", "delivery_failed")
RAN_OK = ("ok", "success", "completed", "delivery_failed")


def _iso(dt: datetime | None) -> str | None:
    return dt.isoformat(timespec="seconds") if dt else None


def _is_active(job: dict) -> bool:
    return bool(job.get("enabled", True)) and not job.get("paused_at") \
        and job.get("state") not in ("paused", "completed", "disabled")


def _silent_reason(job: dict) -> str | None:
    deliver = str(job.get("deliver") or "local")
    if job.get("last_delivery_error"):
        return tr("마지막 전달이 실패함", "The last delivery failed")
    if deliver == "local":
        return tr("전달 대상이 local", "Delivery target is local")
    if deliver == "origin" and not job.get("origin"):
        return tr("origin 대상이 비어 있음", "The origin target is empty")
    return None


def collect(now: datetime | None = None, home=None) -> dict:
    now = now or datetime.now(timezone.utc).astimezone()
    since = (now - timedelta(days=7)).isoformat()
    result = {
        "collected_at": _iso(now),
        "profiles": [], "incidents": [], "failed_jobs": [], "stalled": [], "silent": [],
    }
    profs = list(hr.profiles(home))
    execs = hr.read_executions_many(profs, since)           # 모든 프로파일의 실행 기록을 한 번에(원격이면 사이드카 요청 하나, OMAI-1102)
    for prof in profs:
        row = {"name": prof.name, "jobs_status": "ok", "exec_status": "ok", "detail": "",
               "jobs_total": 0, "jobs_active": 0, "open_incidents": 0, "new_incidents": 0,
               "failed_jobs": 0, "stalled_jobs": 0, "silent_jobs": 0,
               "runs_7d": 0, "runs_failed_7d": 0, "stale": False}
        job_names: dict[str, str] = {}
        job_last: dict[str, str] = {}                     # 작업 id → 마지막 실행 결과(사건이 이미 풀렸는지 가리려고)
        latest_run = None
        try:
            jobs = hr.read_jobs(prof)
        except Exception as exc:  # 한 프로파일의 고장이 전체 수집을 막지 않게 한다
            jobs, row["jobs_status"], row["detail"] = None, "error", redact(exc)
        if jobs is None and row["jobs_status"] == "ok":
            row["jobs_status"] = "no_jobs_file"
        for job in jobs or []:
            jid, name = str(job.get("id")), str(job.get("name") or job.get("id"))
            job_names[jid] = name
            job_last[jid] = "off" if not _is_active(job) else str(job.get("last_status") or "")
            row["jobs_total"] += 1
            last_run = hr.parse_ts(job.get("last_run_at"))
            if last_run and (latest_run is None or last_run > latest_run):
                latest_run = last_run
            if not _is_active(job):
                continue
            row["jobs_active"] += 1
            base = {"profile": prof.name, "job_id": jid, "job": name,
                    "schedule": job.get("schedule_display") or "",
                    "deliver": str(job.get("deliver") or "local").split(":")[0],
                    "skills": job.get("skills") or []}
            if job.get("last_status") not in OK_STATUSES:
                row["failed_jobs"] += 1
                result["failed_jobs"].append({**base, "last_run_at": _iso(last_run),
                                              "streak": job.get("failure_streak") or 0,
                                              "error": redact(job.get("last_error")
                                                              or job.get("last_status"))})
            next_run = hr.parse_ts(job.get("next_run_at"))
            if next_run and now - next_run > STALL_GRACE:
                row["stalled_jobs"] += 1
                result["stalled"].append({**base, "kind": tr("예정 시각 지남", "Past scheduled time"),
                                          "since": _iso(next_run),
                                          "hours": round((now - next_run).total_seconds() / 3600, 1)})
            reason = _silent_reason(job)
            if reason:
                row["silent_jobs"] += 1
                result["silent"].append({**base, "reason": reason,
                                         "delivery_error": redact(job.get("last_delivery_error"))})
        ex = execs[prof.name]
        if isinstance(ex, hr.SchemaMismatch):
            ex = hr.ExecData("error", str(ex))
        row["exec_status"] = ex.status
        if ex.detail:
            row["detail"] = redact(ex.detail)
        row["runs_7d"], row["runs_failed_7d"] = ex.recent_total, ex.recent_failed
        if ex.latest_claimed_at and latest_run and latest_run - ex.latest_claimed_at > STALE_GRACE:
            row["stale"] = True
        for run in ex.running or []:
            started = hr.parse_ts(run.get("started_at") or run.get("claimed_at"))
            if started and now - started > RUNNING_LIMIT:
                row["stalled_jobs"] += 1
                jid = str(run.get("job_id"))
                result["stalled"].append({
                    "profile": prof.name, "job_id": jid, "job": job_names.get(jid, jid),
                    "schedule": "", "deliver": "", "skills": [], "kind": tr("실행이 끝나지 않음", "Run has not finished"),
                    "since": _iso(started),
                    "hours": round((now - started).total_seconds() / 3600, 1)})
        for inc in ex.incidents or []:
            if inc.get("state") not in OPEN_STATES:
                continue
            first = hr.parse_ts(inc.get("first_seen_at"))
            last = hr.parse_ts(inc.get("last_seen_at"))
            is_new = bool(first and now - first <= NEW_WINDOW)
            jid = str(inc.get("job_id"))
            row["open_incidents"] += 1
            row["new_incidents"] += int(is_new)
            result["incidents"].append({
                "profile": prof.name, "id": inc.get("id"), "job_id": jid,
                "job": job_names.get(jid, tr(f"{jid} (삭제된 작업)", f"{jid} (deleted job)")), "state": inc.get("state"),
                "type": inc.get("failure_type") or "", "first_seen_at": _iso(first),
                "last_seen_at": _iso(last), "new": is_new,
                "age_days": (now - first).days if first else None,
                "error": redact(inc.get("error")),
                # 사건은 확인(ack)해야 닫힌다 — 그래서 이미 풀린 것도 계속 열려 있다. 지금도 문제인 것과 가른다.
                "now": ("gone" if jid not in job_names else "ok" if job_last.get(jid) in RAN_OK else "off" if job_last.get(jid) == "off" else "failing"),
                "ack": f"hermes -p {prof.name} cron incidents ack {inc.get('id')}"})
        result["profiles"].append(row)
    # 신규 먼저, 그 안에서는 최근에 본 것 먼저 (안정 정렬 두 번)
    result["incidents"].sort(key=lambda i: i["last_seen_at"] or "", reverse=True)
    result["incidents"].sort(key=lambda i: not i["new"])
    result["failed_jobs"].sort(key=lambda j: -(j["streak"] or 0))
    result["stalled"].sort(key=lambda j: -j["hours"])
    ok = sum(1 for p in result["profiles"]
             if p["jobs_status"] in ("ok", "no_jobs_file") and p["exec_status"] != "error")
    result["totals"] = {
        "profiles": len(result["profiles"]), "profiles_ok": ok,
        "jobs": sum(p["jobs_total"] for p in result["profiles"]),
        "jobs_active": sum(p["jobs_active"] for p in result["profiles"]),
        "open_incidents": len(result["incidents"]),
        "new_incidents": sum(1 for i in result["incidents"] if i["new"]),
        "live_incidents": sum(1 for i in result["incidents"] if i["now"] == "failing"),
        "settled_incidents": sum(1 for i in result["incidents"] if i["now"] != "failing"),
        "failed_jobs": len(result["failed_jobs"]),
        "stalled": len(result["stalled"]), "silent": len(result["silent"]),
        "stale_profiles": [p["name"] for p in result["profiles"] if p["stale"]],
    }
    return result

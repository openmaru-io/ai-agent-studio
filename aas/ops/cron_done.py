# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""크론 완료 알림(스펙 2026-10-15-003 R3·R4·F1~F3). 받은편지함을 읽을 때 계산하고, 사람이 「확인」한 항목만 표로 기록한다.

  모으기   프로파일의 cron/jobs.json 을 파일로 읽는다(Hermes HTTP 가 아니다 — 받은편지함은 15초마다 읽히고 HTTP 는 로그인·30초 제한에 걸린다).
           24시간 안에 성공(ok·success·completed)으로 끝난 작업만, 작업마다 최신 1건. 상태가 비었거나 delivery_failed 면 완료가 아니다.
  항목     id = cron_done|<파드>|<프로파일>|<작업>|<실행 시각>. 같은 실행은 같은 id 라 두 번 알리지 않는다. 채널로 보내는 작업도 낸다(R4).
  확인     (email, item_id) 한 줄. 24시간 창이 지나면 항목이 사라지므로 오래된 행은 읽을 때 지운다.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

from ..common import store
from ..common.redact import redact
from ..fleet import primary
from ..hermes import hermes_reader as hr

SCHEMA = "CREATE TABLE IF NOT EXISTS cron_done_ack (email TEXT NOT NULL, item_id TEXT NOT NULL, ts TEXT NOT NULL, PRIMARY KEY (email, item_id))"
WINDOW = timedelta(hours=24)
KEEP = timedelta(hours=48)
DONE_STATUSES = ("ok", "success", "completed")
PREFIX = "cron_done|"


def _counts(job: dict) -> bool:
    """알림 대상 작업인가. 한 번만 도는 작업은 끝나면 state 가 completed 이고 enabled 가 False 가 된다(OKE jobs.json 확인, 2026-10-15).
    cron_health 는 이것을 활성이 아니라고 보지만 막 성공한 일이므로 알린다. 사람이 멈추거나 끈 작업(paused·disabled·paused_at)만 뺀다."""
    if job.get("paused_at") or job.get("state") in ("paused", "disabled"):
        return False
    return job.get("state") == "completed" or job.get("enabled", True) is not False


def recent_success(home, now: datetime | None = None) -> list[dict]:
    """이 설치본에서 24시간 안에 성공으로 끝난 활성 작업. 읽지 못한 프로파일은 건너뛴다."""
    now = now or datetime.now(timezone.utc)
    out = []
    for prof in hr.profiles(home):
        try:
            jobs = hr.read_jobs(prof)
        except Exception:                                              # 한 프로파일을 못 읽어도 나머지는 보인다
            continue
        for job in jobs or []:
            ran = hr.parse_ts(job.get("last_run_at"))
            if not ran or not _counts(job) or str(job.get("last_status") or "").lower() not in DONE_STATUSES or now - ran > WINDOW:
                continue
            out.append({"profile": prof.name, "job_id": str(job.get("id")), "job": str(job.get("name") or job.get("id")),
                        "run_at": ran.isoformat(timespec="seconds"), "deliver": str(job.get("deliver") or "local")})
    return out


def items_for(done: list[dict], pod_id: str, alias_of: dict, root_hidden: bool) -> list[dict]:
    """받은편지함 항목. alias_of 는 (파드, 프로파일) → 오피스 자리 이름. 숨긴 루트의 작업은 내지 않는다."""
    return [{"id": f"{PREFIX}{pod_id}|{d['profile']}|{d['job_id']}|{d['run_at']}", "kind": "cron_done",
             "alias": alias_of.get((pod_id, d["profile"])) or d["profile"], "pod": pod_id, "profile": d["profile"], "job_id": d["job_id"],
             "text": redact(d["job"], 120),
             "at": datetime.fromisoformat(d["run_at"]).timestamp()}
            for d in done if not (root_hidden and d["profile"] == primary.ROOT)]


def unacked(items: list[dict], email: str) -> list[dict]:
    """이 사람이 아직 확인하지 않은 항목. 오래된 확인 행은 이때 지운다."""
    with store.connect() as conn:
        conn.execute(SCHEMA)
        conn.execute("DELETE FROM cron_done_ack WHERE ts < ?", ((datetime.now(timezone.utc) - KEEP).isoformat(timespec="seconds"),))
        seen = {r[0] for r in conn.execute("SELECT item_id FROM cron_done_ack WHERE email=?", (email,))}
    return [i for i in items if i["id"] not in seen]


def pod_of(item_id: str) -> str:
    return item_id.split("|")[1] if item_id.startswith(PREFIX) and item_id.count("|") >= 4 else ""


def ack(email: str, item_id: str) -> None:
    if not pod_of(item_id):
        raise ValueError("not a cron_done item")
    with store.connect() as conn:
        conn.execute(SCHEMA)
        conn.execute("INSERT INTO cron_done_ack (email, item_id, ts) VALUES (?,?,?) ON CONFLICT DO NOTHING",
                     (email, item_id, datetime.now(timezone.utc).isoformat(timespec="seconds")))

# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""무시(음소거)한 크론 작업 — AAS 쪽 기록일 뿐 Hermes 는 그대로다.
무시한 작업은 요약 숫자·다이제스트에서 빠지고 따로 모아 보여 준다(잊히지 않게 개수는 계속 알린다)."""
from __future__ import annotations

import os
from datetime import datetime

from ..common import db, store, table_cache

SCHEMA = ("CREATE TABLE IF NOT EXISTS cron_muted (profile TEXT NOT NULL, job_id TEXT NOT NULL, job TEXT, note TEXT, by TEXT, ts TEXT NOT NULL, "
          "PRIMARY KEY (profile, job_id))")
_MIGRATED: set = set()


def _key() -> tuple:
    return (db.backend(), os.environ.get("AAS_DATA_DIR", ""), db._tl_schema() if db.backend() == "postgres" else "")


def _connect():
    """표 만들기는 데이터 폴더·스키마마다 한 번만 한다 — 읽을 때마다 보내 SQLite 에서 왕복이 하나 더 있었다(스펙 2026-10-26-002 E1)."""
    conn = store.connect()
    if _key() not in _MIGRATED:
        with conn:
            conn.execute(SCHEMA)
        _MIGRATED.add(_key())
    return conn


def _run(work):
    """work(conn) 을 한다. 같은 폴더에 DB 파일이 새로 생겨(시험·복구) 기억과 달리 표가 없으면 표를 만들고 한 번 더 한다.
    파일이 바뀐 것을 inode 번호로 알아보려 했더니, Docker 의 파일 시스템이 지운 파일의 번호를 새 파일에 다시 주어 표를 만들지 않았다(2026-10-26)."""
    try:
        with _connect() as conn:
            return work(conn)
    except Exception as exc:
        text = str(exc)
        if "cron_muted" not in text or not ("no such table" in text or "does not exist" in text):
            raise
    _MIGRATED.discard(_key())
    with _connect() as conn:
        return work(conn)


def rows() -> list[dict]:
    # 오피스 상태가 에이전트마다 부른다(스펙 2026-10-24-006 §6). 표 바뀜 알림으로 버리는 프로세스 캐시(스펙 2026-10-26-002 R10)
    from ..office import office                                  # 무시한 사람을 이름으로(by_name, 2026-10-30). 오피스 모듈을 늦게 부른다
    cached = store.memo("mutes.rows", lambda: table_cache.get("mutes.rows", ("cron_muted",), _read, lambda rs: [dict(r) for r in rs]))
    return [{**r, "by_name": office.person_name(r.get("by") or "")} for r in cached]


def _read() -> list[dict]:
    return _run(lambda conn: [dict(r) for r in conn.execute("SELECT profile, job_id, job, note, by, ts FROM cron_muted ORDER BY ts DESC")])


def get(profile: str, job_id: str) -> dict | None:
    return next((r for r in rows() if r["profile"] == profile and r["job_id"] == str(job_id)), None)


def mute(profile: str, job_id: str, job: str, note: str = "", by: str = "") -> None:
    ts = datetime.now().astimezone().isoformat(timespec="seconds")
    _run(lambda conn: conn.execute(db.upsert("cron_muted", ("profile", "job_id", "job", "note", "by", "ts"), ("profile", "job_id")),
                                   (profile, str(job_id), job, note[:300], by, ts)))


def unmute(profile: str, job_id: str) -> None:
    _run(lambda conn: conn.execute("DELETE FROM cron_muted WHERE profile=? AND job_id=?", (profile, str(job_id))))


def apply(health: dict) -> dict:
    """수집 결과에 무시 표시를 얹고, 요약 숫자에서 무시한 작업을 뺀다. 원본은 건드리지 않는다."""
    muted = {(r["profile"], r["job_id"]): r for r in rows()}
    out = dict(health)
    out["muted"] = []
    if not muted:
        return out
    # 여러 POD 를 합친 결과(collect_all)는 profile 이 「POD/프로파일」이다. 무시 기록은 원래 프로파일 이름으로 쌓이므로 raw_profile 로 맞춘다.
    raw = lambda r: r.get("raw_profile", r.get("profile"))                       # noqa: E731
    hit = lambda r: (raw(r), str(r.get("job_id"))) in muted                      # noqa: E731
    for key in ("incidents", "failed_jobs", "stalled", "silent"):
        out[key] = [{**r, "muted": hit(r)} for r in health[key]]
    live = lambda key: [r for r in out[key] if not r["muted"]]                   # noqa: E731
    t = dict(health["totals"])
    t.update({"live_incidents": sum(1 for r in live("incidents") if r.get("now", "failing") == "failing"),
              "settled_incidents": sum(1 for r in live("incidents") if r.get("now", "failing") != "failing"),
              "new_incidents": sum(1 for r in live("incidents") if r["new"]),
              "failed_jobs": len(live("failed_jobs")), "stalled": len(live("stalled")), "silent": len(live("silent")),
              "muted_jobs": len(muted)})
    out["totals"] = t
    count = lambda key, prof: sum(1 for r in live(key) if r["profile"] == prof)  # noqa: E731
    out["profiles"] = [{**p, "open_incidents": count("incidents", p["name"]), "failed_jobs": count("failed_jobs", p["name"]),
                        "stalled_jobs": count("stalled", p["name"]), "silent_jobs": count("silent", p["name"])} for p in health["profiles"]]
    for (prof, jid), r in muted.items():
        inc = [i for i in out["incidents"] if i["muted"] and raw(i) == prof and i["job_id"] == jid]
        out["muted"].append({**r, "incidents": len(inc), "failing": any(f["muted"] and raw(f) == prof and f["job_id"] == jid for f in out["failed_jobs"])})
    return out

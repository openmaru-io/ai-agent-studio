# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""AAS 자체 SQLite — 스냅샷 이력, 사건 관찰 기록, 사용 기록. Hermes 와 무관한 파일이다."""
from __future__ import annotations

import contextvars
import copy
import os
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timedelta
from pathlib import Path

from . import config, db

SCHEMA = """
CREATE TABLE IF NOT EXISTS snapshots (
  ts TEXT NOT NULL, profile TEXT NOT NULL,
  open_incidents INTEGER, new_incidents INTEGER, failed_jobs INTEGER,
  stalled_jobs INTEGER, silent_jobs INTEGER, jobs_total INTEGER, jobs_active INTEGER,
  runs_7d INTEGER, runs_failed_7d INTEGER, collect_status TEXT,
  PRIMARY KEY (ts, profile));
CREATE TABLE IF NOT EXISTS incident_seen (
  profile TEXT NOT NULL, incident_id TEXT NOT NULL, job TEXT,
  first_seen_at TEXT, aac_first_saw TEXT NOT NULL, aac_last_saw TEXT NOT NULL,
  closed_seen_at TEXT,
  PRIMARY KEY (profile, incident_id));
CREATE TABLE IF NOT EXISTS snapshot_totals (
  ts TEXT PRIMARY KEY, live_incidents INTEGER, settled_incidents INTEGER,
  muted_jobs INTEGER, muted_incidents INTEGER);
CREATE TABLE IF NOT EXISTS usage (ts TEXT NOT NULL, kind TEXT NOT NULL, note TEXT, pod TEXT NOT NULL DEFAULT '');
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS pod_summary (
  pod TEXT PRIMARY KEY, ts TEXT, checked TEXT NOT NULL, ok INTEGER NOT NULL, reason TEXT,
  profiles INTEGER, gateways_up INTEGER, profiles_bad INTEGER, creds_expiring INTEGER,
  jobs INTEGER, jobs_active INTEGER, failed_jobs INTEGER, stalled_jobs INTEGER, open_incidents INTEGER,
  messengers_connected INTEGER, messengers_total INTEGER);
CREATE TABLE IF NOT EXISTS usage_daily (
  pod TEXT NOT NULL, day TEXT NOT NULL, sessions INTEGER, messages INTEGER, input_tokens INTEGER, output_tokens INTEGER,
  PRIMARY KEY (pod, day));
"""


_MEMO: contextvars.ContextVar[dict | None] = contextvars.ContextVar("aas_request_memo", default=None)


@contextmanager
def request_memo():
    """읽기만 하는 요청 하나 동안 같은 DB 읽기(memo 로 감싼 것)를 한 번만 한다. 오피스 상태 한 번에 무시한 크론 목록을 에이전트마다,
    자리·방·배치를 2~3번씩 다시 읽어 질의가 34번이었다(스펙 2026-10-24-006 §6). 쓰기가 섞이는 요청에는 쓰지 않는다 — 쓴 뒤 읽어도
    처음 읽은 값을 돌려준다. 이미 범위 안이면 바깥 범위를 그대로 쓴다."""
    if _MEMO.get() is not None:
        yield
        return
    token = _MEMO.set({})
    try:
        yield
    finally:
        _MEMO.reset(token)


def memo(key: str, read, clone=copy.deepcopy):
    """request_memo 범위 안이면 key 마다 read() 를 한 번만 부르고 clone 한 값을 돌려준다(부른 쪽이 고쳐도 번지지 않게). 범위 밖이면 그냥 부른다.
    큰 값은 clone 을 가볍게 준다 — 자리 5,000개를 부를 때마다 깊이 복사하면 줄인 왕복만큼 CPU 를 다시 쓴다."""
    cache = _MEMO.get()
    if cache is None:
        return read()
    if key not in cache:
        cache[key] = read()
    return clone(cache[key])


def data_dir() -> Path:
    d = config.data_dir_default()
    d.mkdir(parents=True, exist_ok=True)
    return d


# DB 파일 → {표 정의 묶음: 그 묶음을 처리한 뒤의 schema_version}. 받침이 파일째 pop 한 번으로 지운다 — 사전을 돌며 지우면
# 다른 스레드가 키를 더할 때 RuntimeError 가 나 원래 「표 없음」 오류가 바뀐다
_SCHEMA_DONE: dict[str, dict[str, int]] = {}


def forget_schema() -> None:
    """시험용: 표 정의 묶음을 처리한 기억을 비운다."""
    _SCHEMA_DONE.clear()


class _SchemaOnceConn(sqlite3.Connection):
    """SQLite 연결. 모듈마다 연결할 때마다 같은 표 정의 묶음(CREATE … IF NOT EXISTS)을 실행해 compose 의 SQLite 문장 96% 가
    표 만들기였다(스펙 2026-10-26-002 §9-15). 같은 DB 파일·같은 묶음은 schema_version 이 그대로인 동안 건너뛴다(§9-16 D).
    - schema_version 은 표·인덱스를 만들거나 지울 때만 오르고, DB 파일을 새로 만들면 0 이다 — 지운 파일의 inode 를 다시 받아도
      알아챈다(fa83550c). 다른 묶음이 값을 올리면 그 뒤 한 번 더 돌고 다시 건너뛴다. 스레드가 겹쳐 두 번 돌아도 결과가 같아 잠그지 않는다.
    - 받침: 새 파일이 우연히 같은 값이면 표가 없는데 건너뛴다. 첫 「no such table」에서 기억을 지우고 이 연결이 건너뛴 묶음을 다시
      실행한 뒤 한 번만 다시 한다. 트랜잭션 안이면 하지 않는다 — executescript 가 열린 트랜잭션을 먼저 커밋한다.
      고칠 묶음이 없거나 또 실패하면 원래 오류를 그대로 낸다(mutes 의 자기 받침이 이어서 동작한다)."""

    def __init__(self, database, *args, **kwargs):
        super().__init__(database, *args, **kwargs)
        self._db_path = str(database)
        self._version: int | None = None
        self._skipped: list[str] = []

    def _schema_version(self) -> int:
        if self._version is None:
            self._version = super().execute("PRAGMA schema_version").fetchone()[0]
        return self._version

    def executescript(self, script):
        if _SCHEMA_DONE.get(self._db_path, {}).get(script) == self._schema_version():
            self._skipped.append(script)
            return self.cursor()
        cur = super().executescript(script)
        self._version = None
        _SCHEMA_DONE.setdefault(self._db_path, {})[script] = self._schema_version()
        return cur

    def execute(self, sql, *args):
        try:
            return super().execute(sql, *args)
        except sqlite3.OperationalError as exc:
            if "no such table" not in str(exc) or self.in_transaction or not self._skipped:
                raise
        skipped, self._skipped = self._skipped, []
        _SCHEMA_DONE.pop(self._db_path, None)
        for script in skipped:
            super().executescript(script)
        self._version = None
        return super().execute(sql, *args)


def connect():
    """SQLite(기본) 또는 PostgreSQL(`AAS_DB_BACKEND=postgres`) 연결. 둘 다 `with` 와 `execute(sql, params)` 로 쓴다."""
    if db.backend() == "postgres":
        conn = db.connect()
    else:
        conn = sqlite3.connect(data_dir() / "aas.db", timeout=10, factory=_SchemaOnceConn)
        conn.row_factory = sqlite3.Row
    conn.executescript(SCHEMA)
    add_columns(conn)
    return conn


_MIGRATED: set = set()


def add_columns(conn) -> None:
    """옛 DB 에 나중에 생긴 열을 더한다. 이전 도구(dbmigrate.ensure_schema)도 부른다(리뷰 재검토 D3).
    usage.pod: 주인이 자기 POD 의 변경 기록만 SQL 에서 거른다(계획 2026-10-13-014 §12, 재검토 H2)."""
    key = (db.backend(), os.environ.get("AAS_DATA_DIR", ""), os.environ.get("AAS_DB_SCHEMA", ""))
    if key in _MIGRATED:
        return
    if "pod" not in db.columns(conn, "usage"):
        db.add_column(conn, "usage", "pod TEXT NOT NULL DEFAULT ''")
    for col in ("messengers_connected", "messengers_total"):       # 대시보드 「메신저 연결」(2026-10-18). 옛 행은 NULL = 아직 모르는 값
        if col not in db.columns(conn, "pod_summary"):
            db.add_column(conn, "pod_summary", f"{col} INTEGER")
    conn.execute("CREATE INDEX IF NOT EXISTS usage_pod_ts ON usage (pod, ts)")
    conn.execute("CREATE INDEX IF NOT EXISTS usage_ts ON usage (ts)")      # 변경 기록·평가가 pod 없이 기간으로 읽는다(스펙 2026-10-24-006 R1)
    _MIGRATED.add(key)


def _split(health: dict) -> tuple:
    """열린 사건을 지금도 실패 중 / 이미 회복 / 무시한 것으로 가른다. 무시는 AAS 쪽 기록이라 여기서 얹는다."""
    from ..ops import mutes
    seen = mutes.apply(health)
    incs = seen["incidents"]
    if any("now" not in i for i in incs):          # 사건에 now 가 없는 옛 수집 결과
        return (None, None, None, None)
    live = [i for i in incs if not i.get("muted")]
    failing = sum(1 for i in live if i["now"] == "failing")
    return (failing, len(live) - failing, len(seen["muted"]), len(incs) - len(live))


def record_snapshot(health: dict) -> None:
    ts = health["collected_at"]
    split = _split(health)
    with connect() as conn:
        conn.execute(db.upsert("snapshot_totals", ("ts", "live_incidents", "settled_incidents", "muted_jobs", "muted_incidents"), ("ts",)), (ts, *split))
        for p in health["profiles"]:
            status = "ok" if p["jobs_status"] != "error" and p["exec_status"] != "error" else "error"
            conn.execute(
                db.upsert("snapshots", ("ts", "profile", "open_incidents", "new_incidents", "failed_jobs", "stalled_jobs", "silent_jobs",
                                        "jobs_total", "jobs_active", "runs_7d", "runs_failed_7d", "collect_status"), ("ts", "profile")),
                (ts, p["name"], p["open_incidents"], p["new_incidents"], p["failed_jobs"],
                 p["stalled_jobs"], p["silent_jobs"], p["jobs_total"], p["jobs_active"],
                 p["runs_7d"], p["runs_failed_7d"], status))
        open_keys = set()
        for inc in health["incidents"]:
            key = (inc["profile"], inc["id"])
            open_keys.add(key)
            conn.execute(
                "INSERT INTO incident_seen (profile, incident_id, job, first_seen_at, "
                "aac_first_saw, aac_last_saw) VALUES (?,?,?,?,?,?) "
                "ON CONFLICT(profile, incident_id) DO UPDATE SET aac_last_saw=excluded.aac_last_saw, "
                "closed_seen_at=NULL",
                (*key, inc["job"], inc["first_seen_at"], ts, ts))
        # 수집에 실패한 프로파일의 사건은 닫힌 것으로 치지 않는다
        readable = {p["name"] for p in health["profiles"] if p["exec_status"] == "ok"}
        for row in conn.execute("SELECT profile, incident_id FROM incident_seen "
                                "WHERE closed_seen_at IS NULL").fetchall():
            if row["profile"] in readable and (row["profile"], row["incident_id"]) not in open_keys:
                conn.execute("UPDATE incident_seen SET closed_seen_at=? "
                             "WHERE profile=? AND incident_id=?",
                             (ts, row["profile"], row["incident_id"]))
        if not conn.execute("SELECT 1 FROM meta WHERE key='baseline_ts'").fetchone():
            conn.execute("INSERT INTO meta VALUES ('baseline_ts', ?) ON CONFLICT (key) DO NOTHING", (ts,))


# 이 요청을 한 사람이 대상 에이전트에서 어떤 자격인가: "admin"(관리자) · "team"(팀 관리자) · "other"(주인·팀 관리자 아닌 사람) · ""(주인, 또는 모름).
# 요청을 시작할 때 server.py 가 켜고 끝나면 되돌린다(스펙 2026-10-22-001 §5-4, D15)
actor_role: contextvars.ContextVar[str] = contextvars.ContextVar("actor_role", default="")
# 이 요청이 무엇으로 왔나: "token" 이면 Claude Code 연결(스펙 2026-10-28-001 F8). 기록 끝에 " via=token" 을 붙인다
actor_via: contextvars.ContextVar[str] = contextvars.ContextVar("actor_via", default="")


def log_usage(kind: str, note: str = "", pod: str = "") -> None:
    """pod: 어느 POD 에 대한 기록인가(주인이 자기 기록을 거를 때 쓴다). 모르면 비운다.
    작성자의 자격(actor_role)이 있으면 note 끝에 " role=<자격>" 을 붙인다. 쓸 때 정해 두어, 나중에 권한이 바뀌어도 주인 화면의 표시가 같다(D11·D15)."""
    role = actor_role.get()
    if pod and role:
        note += f" role={role}"
    via = actor_via.get()
    if via:
        note += f" via={via}"
    with connect() as conn:
        conn.execute("INSERT INTO usage (ts, kind, note, pod) VALUES (?,?,?,?)",
                     (datetime.now().astimezone().isoformat(timespec="seconds"), kind, note, pod or ""))


RETENTION_DAYS = 31          # 사용 기록·대시보드 수집을 남기는 기간(사용자 결정 2026-10-24, 스펙 2026-10-24-006 R3)


def prune_old(now: datetime | None = None) -> dict[str, int]:
    """RETENTION_DAYS 가 지난 사용 기록과 대시보드 수집 줄을 지운다. 평가가 견주는 기준 시점(baseline_ts)의 스냅샷은 남긴다.
    리더의 수집 바퀴(30분마다)가 부른다. 시각은 쓸 때와 같은 꼴(로컬 시간대 ISO 문자열)이라 글자로 견준다."""
    cutoff = ((now or datetime.now().astimezone()) - timedelta(days=RETENTION_DAYS)).isoformat(timespec="seconds")
    keep = baseline_ts() or ""
    with connect() as conn:
        return {"usage": conn.execute("DELETE FROM usage WHERE ts < ?", (cutoff,)).rowcount,
                "snapshots": conn.execute("DELETE FROM snapshots WHERE ts < ? AND ts <> ?", (cutoff, keep)).rowcount,
                "snapshot_totals": conn.execute("DELETE FROM snapshot_totals WHERE ts < ? AND ts <> ?", (cutoff, keep)).rowcount}


def baseline_ts() -> str | None:
    with connect() as conn:
        row = conn.execute("SELECT value FROM meta WHERE key='baseline_ts'").fetchone()
        return row["value"] if row else None


def totals_at(ts: str) -> dict | None:
    with connect() as conn:
        row = conn.execute(
            "SELECT COUNT(*) profiles, SUM(open_incidents) open_incidents, "
            "SUM(failed_jobs) failed_jobs, SUM(stalled_jobs) stalled, SUM(silent_jobs) silent, "
            "SUM(jobs_total) jobs, SUM(runs_7d) runs_7d, SUM(runs_failed_7d) runs_failed_7d, "
            "SUM(CASE WHEN collect_status!='ok' THEN 1 ELSE 0 END) collect_errors FROM snapshots WHERE ts=?", (ts,)).fetchone()
        if not row or not row["profiles"]:
            return None
        extra = conn.execute("SELECT live_incidents, settled_incidents, muted_jobs, muted_incidents "
                             "FROM snapshot_totals WHERE ts=?", (ts,)).fetchone()
        keys = ("live_incidents", "settled_incidents", "muted_jobs", "muted_incidents")
        return {**dict(row), **(dict(extra) if extra else dict.fromkeys(keys))}


def latest_by_pod() -> list[dict]:
    """가장 최근 스냅샷을 POD 별로 묶는다. 프로파일 이름이 「POD/프로파일」일 때만 의미가 있다(여러 POD 수집). 아니면 빈 목록."""
    with connect() as conn:
        row = conn.execute("SELECT MAX(ts) ts FROM snapshots").fetchone()
        if not row or not row["ts"]:
            return []
        rows = conn.execute("SELECT profile, open_incidents, failed_jobs, jobs_total, collect_status FROM snapshots WHERE ts=?", (row["ts"],)).fetchall()
    pods: dict[str, dict] = {}
    for r in rows:
        if "/" not in r["profile"]:
            return []
        pod = r["profile"].split("/", 1)[0]
        item = pods.setdefault(pod, {"pod": pod, "profiles": 0, "jobs": 0, "open_incidents": 0, "failed_jobs": 0, "errors": 0})
        item["profiles"] += 1
        item["jobs"] += r["jobs_total"] or 0
        item["open_incidents"] += r["open_incidents"] or 0
        item["failed_jobs"] += r["failed_jobs"] or 0
        item["errors"] += int(r["collect_status"] != "ok")
    return sorted(pods.values(), key=lambda p: (-p["open_incidents"], p["pod"]))


TREND_SUMS = ("COUNT(*) profiles, SUM(s.open_incidents) open_incidents, SUM(s.failed_jobs) failed_jobs, SUM(s.stalled_jobs) stalled, "
              "SUM(s.silent_jobs) silent, SUM(s.jobs_total) jobs, SUM(s.runs_7d) runs_7d, SUM(s.runs_failed_7d) runs_failed_7d, "
              "SUM(CASE WHEN s.collect_status!='ok' THEN 1 ELSE 0 END) collect_errors")
TOTAL_KEYS = ("live_incidents", "settled_incidents", "muted_jobs", "muted_incidents")


def trend(days: int = 35, pods: list[str] | None = None, totals: bool = True) -> list[dict]:
    """하루의 마지막 스냅샷 기준 일별 합계. 질의 한 번으로 묻는다(계획 2026-10-14-014 R11 — 예전에는 날짜마다 한 번).
    pods 를 주면 그 POD 의 줄(이름이 「pod/」 로 시작)만 더한다. 이름에 「/」 가 없으면 POD 하나 설치라 그 POD 의 줄로 본다(R2).
    totals 가 거짓이면 snapshot_totals(진행 중·해소 장애, 음소거)를 비운다 — 전체 합계 하나뿐이라 POD 로 거를 수 없다."""
    if pods is not None and not pods:
        return []
    with connect() as conn:                          # 가장 최근 스냅샷 기준 days 일만 읽는다 — 범위가 없으면 표 전체를 두 번 읽었다(스펙 2026-10-24-006 R2)
        newest = conn.execute("SELECT MAX(ts) ts FROM snapshots").fetchone()["ts"]
    if not newest:
        return []
    start = (datetime.fromisoformat(newest) - timedelta(days=days - 1)).date().isoformat()
    where, params = "", [start, days]
    if pods is not None:
        where = " WHERE (s.profile NOT LIKE '%/%' OR " + " OR ".join("s.profile LIKE ? ESCAPE '!'" for _ in pods) + ")"
        params += [p.replace("!", "!!").replace("%", "!%").replace("_", "!_") + "/%" for p in pods]
    sql = (f"SELECT d.day, d.ts, {TREND_SUMS}, t.live_incidents, t.settled_incidents, t.muted_jobs, t.muted_incidents FROM snapshots s "
           "JOIN (SELECT substr(ts,1,10) AS day, MAX(ts) ts FROM snapshots WHERE ts >= ? GROUP BY substr(ts,1,10) ORDER BY day DESC LIMIT ?) d ON s.ts = d.ts "
           f"LEFT JOIN snapshot_totals t ON t.ts = d.ts{where} "
           "GROUP BY d.day, d.ts, t.live_incidents, t.settled_incidents, t.muted_jobs, t.muted_incidents ORDER BY d.day")
    with connect() as conn:
        rows = [dict(r) for r in conn.execute(sql, tuple(params)).fetchall()]
    out = []
    for r in rows:
        r.pop("ts", None)
        if not totals:
            r.update(dict.fromkeys(TOTAL_KEYS))
        out.append(r)
    return out


# ---- 대시보드(계획 2026-10-14-014 R1·R10): 리더 수집 바퀴가 쓰고 /api/dashboard 가 읽는다 --------------------------
SUMMARY_KEYS = ("profiles", "gateways_up", "profiles_bad", "creds_expiring", "jobs", "jobs_active", "failed_jobs", "stalled_jobs", "open_incidents",
                "messengers_connected", "messengers_total")


def save_pod_summary(pod: str, checked: str, values: dict | None, reason: str = "") -> None:
    """POD 하나의 요약. values 가 없으면(수집 실패) 지난 값과 그 시각(ts)을 두고 실패와 확인 시각만 적는다(디자인 DD4·DD5)."""
    with connect() as conn:
        if values is None:
            conn.execute("INSERT INTO pod_summary (pod, checked, ok, reason) VALUES (?,?,0,?) "
                         "ON CONFLICT (pod) DO UPDATE SET checked=excluded.checked, ok=0, reason=excluded.reason", (pod, checked, reason[:200]))
            return
        cols = ("pod", "ts", "checked", "ok", "reason", *SUMMARY_KEYS)
        conn.execute(db.upsert("pod_summary", cols, ("pod",)), (pod, checked, checked, 1, "", *(int(values.get(k) or 0) for k in SUMMARY_KEYS)))


def pod_summaries() -> dict[str, dict]:
    with connect() as conn:
        return {r["pod"]: dict(r) for r in conn.execute("SELECT * FROM pod_summary").fetchall()}


def save_usage_days(pod: str, days: dict[str, dict]) -> None:
    """day(YYYY-MM-DD) → {sessions, messages, input_tokens, output_tokens}. 같은 날을 다시 넣으면 값을 바꾼다."""
    cols = ("pod", "day", "sessions", "messages", "input_tokens", "output_tokens")
    with connect() as conn:
        for day, v in days.items():
            conn.execute(db.upsert("usage_daily", cols, ("pod", "day")), (pod, day, *(int(v.get(k) or 0) for k in cols[2:])))


def usage_days(pods: list[str] | None, since: str) -> list[dict]:
    """since(YYYY-MM-DD) 이후의 날별 합계(POD 를 더한다). pods 가 None 이면 모두."""
    if pods is not None and not pods:
        return []
    where, params = "day >= ?", [since]
    if pods is not None:
        where += " AND pod IN (" + ",".join("?" * len(pods)) + ")"
        params += pods
    with connect() as conn:
        return [dict(r) for r in conn.execute(
            "SELECT day, SUM(sessions) sessions, SUM(messages) messages, SUM(input_tokens) input_tokens, SUM(output_tokens) output_tokens "
            f"FROM usage_daily WHERE {where} GROUP BY day ORDER BY day", tuple(params)).fetchall()]


def usage_last_days(pods: list[str]) -> dict[str, str]:
    """POD 마다 일별 사용량을 마지막으로 쌓은 날. 대시보드가 에이전트마다 따로 물으면 DB 왕복이 에이전트 수만큼 늘었다(스펙 2026-10-24-006 §6)."""
    if not pods:
        return {}
    with connect() as conn:
        rows = conn.execute(f"SELECT pod, MAX(day) d FROM usage_daily WHERE pod IN ({','.join('?' * len(pods))}) GROUP BY pod", tuple(pods)).fetchall()
    return {r["pod"]: r["d"] for r in rows if r["d"]}


def usage_last_day(pod: str) -> str | None:
    with connect() as conn:
        row = conn.execute("SELECT MAX(day) d FROM usage_daily WHERE pod=?", (pod,)).fetchone()
    return row["d"] if row else None

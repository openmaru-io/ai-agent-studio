# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""Hermes Agent 데이터 읽기 — AAS 에서 Hermes 의 파일·DB 구조를 아는 유일한 곳.

전부 읽기 전용이다. Hermes 볼륨에는 쓰지 않는다.
SQLite 는 immutable=1 로 연다 — 호스트(macOS 바인드 마운트)에서는 mode=ro 가
WAL 공유 메모리를 잡지 못해 열리지 않는다(오류 14). immutable 은 WAL 에만 있는
최신 기록을 놓칠 수 있으므로 호출자가 stale 여부를 따로 판정한다.
"""
from __future__ import annotations

import json
import os
import re
import sqlite3
from dataclasses import dataclass
from datetime import datetime, timezone
import posixpath
from pathlib import Path

from ..common import config
from ..common.i18n import tr
from .readers import remote as _remote

EXPECTED_INCIDENT_COLS = {"id", "job_id", "state", "first_seen_at", "last_seen_at", "error"}
EXPECTED_EXEC_COLS = {"id", "job_id", "status", "claimed_at"}


class SchemaMismatch(RuntimeError):
    """Hermes 내부 구조가 기대와 다르다. 0건으로 뭉개지 않고 실패로 알린다."""


def hermes_home():
    """기본 Hermes 홈. AAS_SIDECAR_URL 이 있으면 읽기 사이드카를 통해 읽는 RemotePath, 없으면 로컬 폴더."""
    sidecar = config.get("AAS_SIDECAR_URL")
    if sidecar:
        from . import readers
        return readers.remote_home(sidecar)
    return config.hermes_home()


@dataclass(frozen=True)
class Profile:
    name: str
    path: Path


def profiles(home: Path | None = None) -> list[Profile]:
    """루트("default")와 profiles/* 를 자동 발견한다. 고정 목록을 쓰지 않는다."""
    home = home or hermes_home()
    if not home.is_dir():
        raise FileNotFoundError(tr(f"Hermes 데이터 디렉터리가 없습니다: {home}", f"The Hermes data directory does not exist: {home}"))
    # 주 프로파일(main)을 쓰는 POD 는 루트를 목록에서 뺀다(스펙 2026-10-14-003 §4-3). 폴더의 사이드카 이름이 POD id 다
    label = getattr(getattr(home, "_b", None), "label", "")
    from ..fleet import primary
    found = [] if label and label in primary.target_ids() else [Profile("default", home)]
    pdir = home / "profiles"
    if pdir.is_dir():
        entries = sorted(pdir.iterdir())
        # Hermes 는 지운 프로파일에 profiles/.deleted/<이름> 표시를 남기고, 같은 이름의 빈 폴더가 다시 생겨도 프로파일로 치지 않는다(스펙 2026-10-26-008 §10)
        gone = {t.name for t in (pdir / ".deleted").iterdir()} if any(p.name == ".deleted" for p in entries) else set()
        for p in entries:
            if p.is_dir() and not p.name.startswith(".") and p.name not in gone:
                found.append(Profile(p.name, p))
    return found


def parse_ts(value) -> datetime | None:
    if not value:
        return None
    try:
        dt = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt


def read_jobs(profile: Profile) -> list[dict] | None:
    """cron/jobs.json 의 작업 목록. 파일이 없으면 None(작업 없음과 구분)."""
    f = profile.path / "cron" / "jobs.json"
    if not f.is_file():
        return None
    data = json.loads(f.read_text(encoding="utf-8"))
    jobs = data.get("jobs") if isinstance(data, dict) else data
    if not isinstance(jobs, list):
        raise SchemaMismatch(tr(f"{f}: 'jobs' 목록을 찾지 못했습니다", f"{f}: the 'jobs' list was not found"))
    return jobs


def _connect_immutable(db: Path):
    """읽기 전용으로 연다(ADR-0007). 원격 Hermes(RemotePath)면 사이드카에 묻는 같은 모양의 연결을 낸다."""
    if isinstance(db, _remote.RemotePath):
        return _remote.connect(db)
    conn = sqlite3.connect(f"file:{db}?immutable=1", uri=True)
    conn.row_factory = sqlite3.Row
    return conn


class MissingDb(sqlite3.OperationalError):
    """DB 파일이 없다(사이드카 404, 로컬은 파일 없음). 파일 있음 확인을 건너뛴 읽기가 「DB 없음」으로 본다(스펙 2026-10-24-011 R1)."""


def query_batch(items: list[tuple]) -> list:
    """(DB 경로, SQL, 인자) 여러 개를 한 번에 실행한다(OMAI-1102). 원격이면 사이드카 요청 하나, 로컬이면 차례로.
    결과는 같은 차례의 행 목록(이름·번호로 읽는 행)이거나 sqlite3.Error 다 — 하나가 실패해도 나머지는 낸다."""
    out: list = [None] * len(items)
    remote_groups: dict = {}
    for i, (db, sql, params) in enumerate(items):
        if isinstance(db, _remote.RemotePath):
            remote_groups.setdefault(id(db.backend), (db.backend, []))[1].append((i, db, sql, params))
        elif not Path(db).exists():                  # 없는 파일을 열면 SQLite 가 빈 DB 로 연다 — 「표 없음」이 아니라 「DB 없음」이다
            out[i] = MissingDb(tr("DB 파일이 없습니다", "The DB file does not exist"))
        else:
            try:
                conn = _connect_immutable(db)
                try:
                    out[i] = [r for r in conn.execute(sql, tuple(params))]
                finally:
                    conn.close()
            except sqlite3.Error as exc:
                out[i] = exc
    for backend, group in remote_groups.values():
        try:
            results = backend.sqlite_batch([(db.rel, sql, list(params)) for _i, db, sql, params in group])
        except (OSError, ValueError, KeyError) as exc:
            results = [{"error": str(exc), "code": 500}] * len(group)
        for (i, _db, _sql, _params), res in zip(group, results):
            if "error" in res:
                out[i] = (MissingDb if res.get("code") == 404 else sqlite3.OperationalError)(str(res["error"]))
            elif res.get("truncated"):
                out[i] = sqlite3.OperationalError(tr("결과가 너무 많아 잘렸습니다", "Result truncated: too many rows"))
            else:
                cols = tuple(res["columns"])
                out[i] = [_remote.RemoteRow(cols, [_remote.RemoteConnection._cell(c) for c in r]) for r in res["rows"]]
    return out


def _columns(conn: sqlite3.Connection, table: str) -> set[str]:
    return {r["name"] for r in conn.execute(f"PRAGMA table_info({table})")}


@dataclass
class ExecData:
    status: str                    # ok | no_db | no_incident_table | error
    detail: str = ""
    incidents: list[dict] | None = None
    running: list[dict] | None = None
    latest_claimed_at: datetime | None = None
    recent_failed: int = 0
    recent_total: int = 0


_EXEC_QUERIES = (
    ("tables", "SELECT name FROM sqlite_master WHERE type='table'"),
    ("exec_cols", "PRAGMA table_info(executions)"),
    ("latest", "SELECT MAX(claimed_at) AS m FROM executions"),
    ("running", "SELECT id, job_id, status, claimed_at, started_at FROM executions WHERE status IN ('claimed','running')"),
    ("inc_cols", "PRAGMA table_info(cron_incidents)"),
    ("incidents", "SELECT * FROM cron_incidents"),
)
_RECENT_SQL = "SELECT COUNT(*) AS n, SUM(status='failed') AS f FROM executions WHERE claimed_at >= ?"


def read_executions(profile: Profile, since_iso: str | None = None) -> ExecData:
    out = read_executions_many([profile], since_iso)[profile.name]
    if isinstance(out, SchemaMismatch):
        raise out
    return out


def read_executions_many(profiles, since_iso: str | None = None, check_files: bool = True) -> dict:
    """프로파일 여러 개의 cron/executions.db 를 한 번에 읽는다(원격이면 사이드카 요청 하나, OMAI-1102).
    프로파일 이름 → ExecData. 컬럼이 다르면 그 프로파일만 SchemaMismatch 를 값으로 둔다(다른 프로파일은 읽는다).
    check_files=False: DB 가 있는 프로파일만 넘긴다(부른 쪽이 기억한 구성). 파일마다 있음을 묻지 않고, 그 사이 지워졌으면 「DB 없음」."""
    out: dict = {}
    items, plan = [], []
    for prof in profiles:
        db = prof.path / "cron" / "executions.db"
        if check_files and not db.is_file():
            out[prof.name] = ExecData("no_db")
            continue
        queries = [(k, q, ()) for k, q in _EXEC_QUERIES] + ([("recent", _RECENT_SQL, (since_iso,))] if since_iso else [])
        plan.append((prof, db, [k for k, _q, _p in queries], len(items)))
        items += [(db, q, ps) for _k, q, ps in queries]
    results = query_batch(items) if items else []
    for prof, db, keys, start in plan:
        got = dict(zip(keys, results[start:start + len(keys)]))
        if any(isinstance(v, MissingDb) for v in got.values()):
            out[prof.name] = ExecData("no_db")
            continue
        try:
            out[prof.name] = _exec_data(db, got, since_iso)
        except SchemaMismatch as exc:
            out[prof.name] = exc
    return out


def _exec_data(db, got: dict, since_iso: str | None) -> ExecData:
    """read_executions 의 판정 차례(테이블 → 컬럼 → 조회)를 그대로 따른다. 앞 단계에서 끝나면 뒤 쿼리의 결과는 보지 않는다."""
    def rows(key):
        value = got[key]
        if isinstance(value, Exception):
            raise value
        return value
    try:
        tables = {r["name"] for r in rows("tables")}
        if "executions" not in tables:
            return ExecData("error", tr("executions 테이블이 없습니다", "The executions table does not exist"))
        missing = EXPECTED_EXEC_COLS - {r["name"] for r in rows("exec_cols")}
        if missing:
            raise SchemaMismatch(tr(f"{db}: executions 컬럼 부재 {sorted(missing)}", f"{db}: missing executions columns {sorted(missing)}"))
        out = ExecData("ok")
        latest = rows("latest")
        out.latest_claimed_at = parse_ts(latest[0]["m"]) if latest else None
        out.running = [dict(r) for r in rows("running")]
        if since_iso:
            r = rows("recent")[0]
            out.recent_total, out.recent_failed = r["n"] or 0, r["f"] or 0
        if "cron_incidents" not in tables:
            out.status = "no_incident_table"
            return out
        missing = EXPECTED_INCIDENT_COLS - {r["name"] for r in rows("inc_cols")}
        if missing:
            raise SchemaMismatch(tr(f"{db}: cron_incidents 컬럼 부재 {sorted(missing)}", f"{db}: missing cron_incidents columns {sorted(missing)}"))
        out.incidents = [dict(r) for r in rows("incidents")]
        return out
    except sqlite3.Error as exc:
        return ExecData("error", tr(f"읽기 실패: {exc}", f"Read failed: {exc}"))


_KEY_LINE = re.compile(r"^  ([A-Za-z0-9_.-]+):\s*$")


def mcp_server_names(home: Path | None = None) -> dict[str, list[str]]:
    """config.yaml 의 mcp_servers 아래 **키 이름만** 읽는다. 값은 읽지 않는다."""
    home = home or hermes_home()
    result: dict[str, list[str]] = {}
    for prof in profiles(home):
        cfg = prof.path / "config.yaml"
        if not cfg.is_file():
            continue
        names, inside = [], False
        for line in cfg.read_text(encoding="utf-8", errors="replace").splitlines():
            if line.startswith("mcp_servers:"):
                inside = True
                continue
            if inside:
                if line and not line.startswith(" "):
                    break
                m = _KEY_LINE.match(line)
                if m:
                    names.append(m.group(1))
        if names:
            result[prof.name] = names
    return result


def skill_files(home: Path | None = None) -> list[tuple[str, Path]]:
    """(프로파일 이름, SKILL.md 경로). 점으로 시작하는 디렉터리(백업 등)는 제외."""
    home = home or hermes_home()
    out: list[tuple[str, Path]] = []
    for prof in profiles(home):
        root = prof.path / "skills"
        if not root.is_dir():
            continue
        for p in sorted(root.rglob("SKILL.md")):
            if any(part.startswith(".") for part in p.relative_to(root).parts[:-1]):
                continue                                   # 점으로 시작하는 폴더(백업 등)는 건너뛴다
            out.append((prof.name, p))
    return out


def shared_skill_files(home: Path | None = None) -> list[tuple[str, str, Path]]:
    """(프로파일 이름, 가져온 곳 이름, SKILL.md 경로). 프로파일 config.yaml 의 `skills.external_dirs` 가 가리키는 폴더의 스킬이다.
    외부 폴더는 /opt/data 아래만 보고, 프로파일 자기 skills 폴더는 건너뛴다(스펙 2026-10-15-011 D6)."""
    from ..ops import shared_skills
    home = home or hermes_home()
    out: list[tuple[str, str, Path]] = []
    for prof in profiles(home):
        cfg = prof.path / "config.yaml"
        try:
            text = cfg.read_text(encoding="utf-8", errors="replace") if cfg.is_file() else ""
        except OSError:
            continue
        for d in shared_skills.dirs_of(text):
            root = home / posixpath.relpath(d, shared_skills.DATA_DIR) if d != shared_skills.DATA_DIR else home
            if root == prof.path / "skills" or not root.is_dir():
                continue
            label = shared_skills.label_of(d)
            for p in sorted(root.rglob("SKILL.md")):
                if any(part.startswith(".") for part in p.relative_to(root).parts[:-1]):
                    continue
                out.append((prof.name, label, p))
    return out

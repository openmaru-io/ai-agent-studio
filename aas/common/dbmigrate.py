# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""SQLite(aas.db) → PostgreSQL 이전 도구. `python -m aas db-migrate [--data-dir DIR]`

서버를 멈춘 상태에서 쓴다(Deployment 를 0 으로 줄인 뒤 같은 볼륨을 마운트하는 일회성 Job). 순서:
1. 대상 PostgreSQL 에 표를 만든다.  2. 대상 표가 모두 비어 있는지 본다(비어 있지 않으면 거절).
3. 표 하나를 한 트랜잭션으로 복사한다.  4. 자동 증가 열의 시퀀스를 최대값 뒤로 맞춘다.
5. 표마다 모든 행의 모든 열을 두 데이터베이스에서 읽어 다중집합으로 비교한다(기본 키가 없는 표도 된다).
복사 중 오류가 나면 그 표의 트랜잭션을 되돌리고 어느 표인지 출력한 뒤 멈춘다. 다시 실행하려면 대상을 비운다.
약 100만 행 이하를 전제로 한다(표 전체를 메모리에 올린다).
"""
from __future__ import annotations

import sqlite3
from collections import Counter
from pathlib import Path

from . import config, db, store

IDENTITY_TABLES = ("admin_requests", "file_versions", "office_events", "office_messages", "office_rooms", "office_meeting_threads")


def schema_scripts() -> list[str]:
    """모듈마다 흩어진 표 정의(auth_sessions 는 제외, Auth 가 만든다)."""
    from ..assets import files, inventory
    from ..auth import mcp_limits, mcp_transfers, tokens
    from ..fleet import agents, primary, retained_volumes
    from ..fleet.pods import Registry
    from ..market import marketplace, publish_auto
    from ..office import hub_auto, meeting, office
    from . import settings
    from ..ops import admin_requests, approval_answers, chat_session_meta, cron_done, mutes, pc_import
    return [store.SCHEMA, office.SCHEMA, hub_auto.SCHEMA, meeting.SCHEMA, marketplace.SCHEMA, mutes.SCHEMA, cron_done.SCHEMA,
            agents.LIMIT_SCHEMA, agents.SIZE_SCHEMA, Registry.GRANT_SCHEMA, Registry.OWNER_SCHEMA, primary.SCHEMA, files.VERSION_SCHEMA, files.VERSION_INDEX, files.ACK_SCHEMA, inventory.REG_SCHEMA, admin_requests.SCHEMA, settings.GOAL_SCHEMA, settings.DEPT_SCHEMA, settings.TEAM_MANAGER_SCHEMA, settings._SCHEMA, retained_volumes.SCHEMA,
            pc_import.SCHEMA, tokens.SCHEMA, mcp_limits.SCHEMA, mcp_transfers.SCHEMA, approval_answers.SCHEMA, chat_session_meta.SCHEMA, publish_auto.SCHEMA]


def ensure_schema() -> None:
    """모든 모듈의 표 정의를 대상에 만든다(표는 모듈이 처음 쓸 때 만들어지므로 한꺼번에 만들어 둔다)."""
    from ..auth import auth
    from ..office import meeting, office
    with store.connect() as conn:
        for ddl in schema_scripts():
            conn.executescript(ddl)
    # 모듈이 옛 DB 에 ALTER 로 더하는 열도 만든다 — 표 정의만 만들면 원본의 그 열을 옮길 곳이 없다(계획 2026-10-13-014 재검토 D3)
    for open_db in (store.connect, office.connect, meeting._db):
        with open_db():
            pass
    auth.Auth()                                  # auth_sessions 표와 옛 DB 의 열 추가


# 옮기지 않는 표: 자리 표의 판 번호(트리거가 대상에서 자리를 옮길 때 다시 센다, 스펙 2026-10-24-006 R5)
SKIP_TABLES = ("office_seat_version",)


def _tables(src: sqlite3.Connection) -> list[str]:
    return [r[0] for r in src.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
            if r[0] not in SKIP_TABLES]


def _cols(src: sqlite3.Connection, table: str) -> list[str]:
    return [r[1] for r in src.execute(f"PRAGMA table_info({table})")]


def migrate(src_path: Path, say=print) -> int:
    """0 성공, 2 대상이 비어 있지 않음, 3 복사 실패, 4 비교 불일치, 5 설정 오류."""
    if db.backend() != "postgres":
        say("AAS_DB_BACKEND=postgres 로 대상 PostgreSQL 을 지정해야 합니다")  # i18n-ignore: 명령줄 출력
        return 5
    if not src_path.is_file():
        say(f"원본 SQLite 파일이 없습니다: {src_path}")  # i18n-ignore: 명령줄 출력
        return 5
    ensure_schema()
    src = sqlite3.connect(f"file:{src_path}?mode=ro", uri=True)
    tables = _tables(src)
    with store.connect() as dst:
        known = db.table_names(dst)
        missing = [t for t in tables if t not in known]
        if missing:
            say(f"대상에 없는 표가 원본에 있습니다: {', '.join(missing)}")  # i18n-ignore: 명령줄 출력
            return 3
        filled = [t for t in tables if dst.execute(f"SELECT 1 FROM {t} LIMIT 1").fetchone()]
    if filled:
        say(f"대상 PostgreSQL 의 표가 비어 있지 않아 거절합니다: {', '.join(filled)}")  # i18n-ignore: 명령줄 출력
        return 2
    cols = {t: _cols(src, t) for t in tables}
    for t in tables:
        rows = src.execute(f"SELECT {','.join(cols[t])} FROM {t}").fetchall()
        sql = f"INSERT INTO {t} ({','.join(cols[t])}) VALUES ({','.join('?' * len(cols[t]))})"
        try:
            with store.connect() as dst:
                for row in rows:
                    dst.execute(sql, tuple(row))
        except Exception as exc:
            say(f"{t}: 복사에 실패해 이 표를 되돌렸습니다 ({type(exc).__name__}: {exc})")  # i18n-ignore: 명령줄 출력
            return 3
        say(f"{t}: {len(rows)}행 복사")  # i18n-ignore: 명령줄 출력
    with store.connect() as dst:
        for t in IDENTITY_TABLES:
            if t in tables:
                dst.execute(f"SELECT setval(pg_get_serial_sequence('{t}', 'id'), COALESCE((SELECT MAX(id) FROM {t}), 1), "
                            f"(SELECT MAX(id) FROM {t}) IS NOT NULL)")
    return verify(src, tables, cols, say)


def verify(src: sqlite3.Connection, tables: list[str], cols: dict[str, list[str]], say=print) -> int:
    bad = []
    for t in tables:
        want = Counter(tuple(r) for r in src.execute(f"SELECT {','.join(cols[t])} FROM {t}"))
        with store.connect() as dst:
            got = Counter(tuple(r) for r in dst.execute(f"SELECT {','.join(cols[t])} FROM {t}"))
        if want != got:
            bad.append(t)
            say(f"{t}: 원본과 대상이 다릅니다 (원본 {sum(want.values())}행, 대상 {sum(got.values())}행)")  # i18n-ignore: 명령줄 출력
    if bad:
        return 4
    say(f"모든 표 {len(tables)}개의 모든 행·열이 일치합니다")  # i18n-ignore: 명령줄 출력
    return 0


def main(data_dir: str | None = None, say=print) -> int:
    base = Path(data_dir) if data_dir else config.data_dir_default()
    return migrate(base / "aas.db", say)

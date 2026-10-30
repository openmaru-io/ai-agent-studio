# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""SQLite → PostgreSQL 이전 도구 시험(AAS_DB_BACKEND=postgres 일 때만)."""
import os
import sqlite3
import tempfile
import unittest
from pathlib import Path

TMP = tempfile.TemporaryDirectory()
os.environ.setdefault("AAS_DATA_DIR", str(Path(TMP.name) / "data"))

from aas.common import config, db, dbmigrate, store  # noqa: E402

PG = config.db_backend() == "postgres"
AUTH = ("CREATE TABLE auth_sessions (hash TEXT PRIMARY KEY, email TEXT NOT NULL, name TEXT, created REAL NOT NULL, expires REAL NOT NULL, "
        "sub TEXT NOT NULL DEFAULT '', admin INTEGER NOT NULL DEFAULT 0)")


def make_source(path: Path, bad_type: bool = False) -> None:
    conn = sqlite3.connect(path)
    for ddl in dbmigrate.schema_scripts():
        conn.executescript(ddl)
    conn.execute(AUTH)
    conn.execute("INSERT INTO usage (ts, kind, note) VALUES ('t1', 'k', 'n')")
    conn.execute("INSERT INTO usage (ts, kind, note) VALUES ('t1', 'k', 'n')")      # 기본 키 없는 표: 같은 행 둘
    conn.execute("INSERT INTO meta VALUES ('baseline_ts', '2026-10-12T10:00:00+09:00')")
    conn.execute("INSERT INTO auth_sessions VALUES ('h', 'a@x.com', '', 1791709332.75, 1791709999.5, 's', 1)")
    conn.execute("INSERT INTO office_events (id, board, ts, body) VALUES (7, 'b', 1791709332.75, '{}')")
    conn.execute("INSERT INTO office_messages (id, room, role, author, content, ts) VALUES (4, 1, 'user', 'me', '안녕', 't')")
    if bad_type:
        conn.execute("INSERT INTO office_cron VALUES ('a', 'j', 'x', 'y')")
        conn.execute("INSERT INTO office_cards VALUES ('b', 't', 'p', 's', 'a', 'title', 'not-a-number')")   # INTEGER 열에 문자열
    conn.commit()
    conn.close()


@unittest.skipUnless(PG, "PostgreSQL 백엔드에서만")
class MigrateTest(unittest.TestCase):
    def setUp(self):
        self.d = tempfile.TemporaryDirectory()
        os.environ["AAS_DATA_DIR"] = self.d.name          # AAS_DB_SCHEMA=auto: 시험마다 빈 스키마
        self.out = []

    def tearDown(self):
        self.d.cleanup()

    def run_migrate(self):
        return dbmigrate.migrate(Path(self.d.name) / "aas.db", self.out.append)

    def test_모든_행과_열을_옮기고_시퀀스를_최대값_뒤로_맞춘다(self):
        make_source(Path(self.d.name) / "aas.db")
        self.assertEqual(self.run_migrate(), 0, self.out)
        with store.connect() as conn:
            self.assertEqual(len(conn.execute("SELECT 1 FROM usage").fetchall()), 2)
            row = conn.execute("SELECT created, expires FROM auth_sessions").fetchone()
            self.assertEqual((row["created"], row["expires"]), (1791709332.75, 1791709999.5))
            new_event = conn.execute("INSERT INTO office_events (board, ts, body) VALUES ('b', 1, '{}') RETURNING id").fetchone()[0]
            new_msg = conn.execute("INSERT INTO office_messages (room, role, author, content, ts) VALUES (1,'u','a','c','t') RETURNING id").fetchone()[0]
        self.assertEqual((new_event, new_msg), (8, 5))

    def test_자리_판_번호_표는_옮기지_않고_대상의_트리거가_다시_센다(self):
        """판 번호(office_seat_version)는 캐시용 값이다. 옮기면 대상 트리거가 자리를 넣으며 올린 값과 달라 비교가 실패한다(스펙 2026-10-24-006 R5)."""
        src = Path(self.d.name) / "aas.db"
        make_source(src)
        conn = sqlite3.connect(src)
        conn.execute("INSERT INTO office_seats (alias, pod, profile, ts) VALUES ('kim', 'p1', 'main', 't')")
        conn.execute("INSERT INTO office_seat_version (id, n) VALUES (1, 37)")
        conn.commit()
        conn.close()
        self.assertEqual(self.run_migrate(), 0, self.out)
        self.assertFalse(any("office_seat_version" in line for line in self.out), self.out)
        with store.connect() as dst:
            self.assertEqual(dst.execute("SELECT alias FROM office_seats").fetchone()[0], "kim")
            self.assertNotEqual(dst.execute("SELECT n FROM office_seat_version WHERE id=1").fetchone()[0], 37)

    def test_원본에_ALTER_로_더한_열도_옮긴다(self):
        # 표 정의(SCHEMA)만 만들면 모듈이 옛 DB 에 나중에 더한 열이 대상에 없어 복사가 실패한다(계획 2026-10-13-014 재검토 D3)
        path = Path(self.d.name) / "aas.db"
        make_source(path)
        conn = sqlite3.connect(path)
        conn.execute("ALTER TABLE office_layouts ADD COLUMN preset TEXT")
        conn.execute("ALTER TABLE office_rooms ADD COLUMN kind TEXT NOT NULL DEFAULT 'tft'")
        conn.execute("ALTER TABLE office_rooms ADD COLUMN team_key TEXT NOT NULL DEFAULT ''")
        conn.execute("ALTER TABLE office_seats ADD COLUMN team_src TEXT NOT NULL DEFAULT ''")
        conn.execute("INSERT INTO office_rooms (id, name, seats, ts, kind, team_key) VALUES (3, '개발팀', '[]', 't', 'team', 'dev')")
        conn.execute("INSERT INTO usage (ts, kind, note, pod) VALUES ('t2', 'profile_soul', 'n', 'kim')")
        conn.execute("UPDATE office_messages SET kind='soul_changed', data='{\"pod\":\"kim\"}' WHERE id=4")
        conn.commit()
        conn.close()
        self.assertEqual(self.run_migrate(), 0, self.out)
        with store.connect() as conn:
            self.assertEqual(tuple(conn.execute("SELECT kind, team_key FROM office_rooms WHERE id=3").fetchone()), ("team", "dev"))
            self.assertEqual(conn.execute("SELECT pod FROM usage WHERE ts='t2'").fetchone()[0], "kim")
            self.assertEqual(conn.execute("SELECT kind FROM office_messages WHERE id=4").fetchone()[0], "soul_changed")
            self.assertIn("team_src", db.columns(conn, "office_seats"))

    def test_대상이_비어_있지_않으면_거절한다(self):
        make_source(Path(self.d.name) / "aas.db")
        dbmigrate.ensure_schema()
        with store.connect() as conn:
            conn.execute("INSERT INTO meta VALUES ('k', 'v')")
        self.assertEqual(self.run_migrate(), 2)
        with store.connect() as conn:
            self.assertEqual(len(conn.execute("SELECT 1 FROM usage").fetchall()), 0)

    def test_타입이_맞지_않는_값은_그_표를_되돌리고_멈춘다(self):
        make_source(Path(self.d.name) / "aas.db", bad_type=True)
        self.assertEqual(self.run_migrate(), 3)
        self.assertTrue(any("office_cards" in line for line in self.out), self.out)
        with store.connect() as conn:
            self.assertEqual(len(conn.execute("SELECT 1 FROM office_cards").fetchall()), 0)

    def test_다른_값이_있으면_비교가_실패한다(self):
        make_source(Path(self.d.name) / "aas.db")
        self.assertEqual(self.run_migrate(), 0)
        with store.connect() as conn:
            conn.execute("UPDATE usage SET note='달라짐' WHERE kind='k'")
        src = sqlite3.connect(Path(self.d.name) / "aas.db")
        cols = {t: dbmigrate._cols(src, t) for t in dbmigrate._tables(src)}
        self.assertEqual(dbmigrate.verify(src, ["usage"], cols, self.out.append), 4)

    def test_SQLite_백엔드에서는_설정_오류로_멈춘다(self):
        old = os.environ["AAS_DB_BACKEND"]
        os.environ["AAS_DB_BACKEND"] = "sqlite"
        try:
            self.assertEqual(self.run_migrate(), 5)
        finally:
            os.environ["AAS_DB_BACKEND"] = old


if __name__ == "__main__":
    unittest.main()

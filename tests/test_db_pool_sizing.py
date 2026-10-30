# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""DB 연결 풀 크기·풀 대기 기록·`/readyz` 확인 연결·다시 시작 뒤 풀 점검·잠깐 쓰는 표(스펙 2026-10-24-010)."""
import os
import tempfile
import threading
import unittest
from pathlib import Path
from unittest import mock

TMP = tempfile.TemporaryDirectory()
os.environ.setdefault("AAS_DATA_DIR", str(Path(TMP.name) / "data"))

from aas.common import config, db, store  # noqa: E402

PG = config.db_backend() == "postgres"


class PoolSettingsTest(unittest.TestCase):
    def settings(self, **env):
        keep = {k: v for k, v in os.environ.items() if not k.startswith("AAS_DB_POOL_")}
        with mock.patch.dict(os.environ, {**keep, **env}, clear=True):
            return config.db_settings()

    def test_기본값은_최소_5_최대_20(self):
        got = self.settings()
        self.assertEqual((got["pool_min"], got["pool_max"]), (5, 20))

    def test_환경_변수로_바꾸고_최소가_최대보다_크면_최대로_맞춘다(self):
        got = self.settings(AAS_DB_POOL_MIN="8", AAS_DB_POOL_MAX="30")
        self.assertEqual((got["pool_min"], got["pool_max"]), (8, 30))
        got = self.settings(AAS_DB_POOL_MIN="5", AAS_DB_POOL_MAX="1")
        self.assertEqual((got["pool_min"], got["pool_max"]), (1, 1))


class PoolReportTest(unittest.TestCase):
    def test_기다림_실패_끊김이_없으면_남기지_않는다(self):
        self.assertIsNone(db.pool_report_line({}))
        self.assertIsNone(db.pool_report_line({"pool_size": 5, "pool_available": 5, "pool_max": 20}))

    def test_기다림이_있으면_한_줄을_남긴다(self):
        line = db.pool_report_line({"requests_queued": 4, "requests_wait_ms": 100, "pool_size": 7, "pool_max": 20,
                                    "pool_available": 1, "requests_errors": 1})
        self.assertIn("기다림 4건 합계 100ms 평균 25ms", line)
        self.assertIn("연결 7/최대 20", line)
        self.assertIn("실패 1", line)

    def test_끊긴_연결만_있어도_남긴다(self):
        self.assertIn("끊김 2", db.pool_report_line({"connections_lost": 2}))

    @unittest.skipIf(PG, "SQLite 에서만")
    def test_SQLite_는_풀이_없어_빈_값(self):
        self.assertEqual(db.pool_stats(), {})


class ServerPoolReportTest(unittest.TestCase):
    def test_5분마다_한_번만_풀_값을_읽고_기다림이_있을_때만_남긴다(self):
        from aas.web import server
        server._pool_report_at["t"] = 0.0
        with mock.patch.object(db, "pool_stats", return_value={"requests_queued": 2, "requests_wait_ms": 10}) as stats:
            self.assertIsNone(server._pool_report(1000.0))                 # 처음은 시각만 잡는다
            self.assertIsNone(server._pool_report(1200.0))
            self.assertEqual(stats.call_count, 0)
            self.assertIn("기다림 2건", server._pool_report(1300.0))
            self.assertEqual(stats.call_count, 1)
        with mock.patch.object(db, "pool_stats", return_value={}):
            self.assertIsNone(server._pool_report(1600.0))

    def test_알림_연결이_다시_붙으면_풀을_점검한다(self):
        from aas.web import server
        with mock.patch.object(db, "check_pool") as check:
            server._shared_reconnected()
        check.assert_called_once()


@unittest.skipUnless(PG, "PostgreSQL 백엔드에서만")
class PgPoolTest(unittest.TestCase):
    def setUp(self):
        self.d = tempfile.TemporaryDirectory()
        os.environ["AAS_DATA_DIR"] = self.d.name
        db.reset()
        self.addCleanup(db.reset)

    def tearDown(self):
        self.d.cleanup()

    def test_풀_최소_크기가_설정대로_들어간다(self):
        store.connect().execute("SELECT 1")
        c = config.db_settings()
        self.assertEqual(db.pool_stats()["pool_min"], c["pool_min"])

    def test_풀이_가득_차_기다린_요청은_다음_기록에_남는다(self):
        with mock.patch.dict(os.environ, {"AAS_DB_POOL_MAX": "1", "AAS_DB_POOL_TIMEOUT": "5"}):
            db.reset()
            store.connect().execute("SELECT 1")
            db.pool_stats()                                       # 여기까지의 값을 비운다
            with store.connect() as held:
                held.execute("SELECT 1")
                t = threading.Thread(target=lambda: store.connect().execute("SELECT 1"))
                t.start()
                threading.Event().wait(0.3)
            t.join(10)
            line = db.pool_report_line(db.pool_stats())
        self.assertIsNotNone(line)
        self.assertIn("기다림 1건", line)

    def test_다시_시작_뒤_풀_점검은_끊긴_연결을_버린다(self):
        """PostgreSQL 이 다시 시작되면 풀에 쉬던 연결이 끊긴 채로 남아 첫 사용에서 오류가 났다(리뷰 D8)."""
        store.connect().execute("SELECT 1")
        pool = db._backend().pool
        pids = [c.info.backend_pid for c in list(pool._pool)]
        self.assertTrue(pids)
        killer = db.session_connection()
        try:
            for pid in pids:
                killer.execute("SELECT pg_terminate_backend(%s)", (pid,))
        finally:
            killer.close()
        threading.Event().wait(0.3)
        db.check_pool()
        for _ in range(len(pids) + 1):                           # 쉬던 연결을 모두 한 번씩 빌린다
            self.assertEqual(store.connect().execute("SELECT 1").fetchone()[0], 1)


@unittest.skipUnless(PG, "PostgreSQL 백엔드에서만")
class PingTest(unittest.TestCase):
    def setUp(self):
        db.reset()
        self.addCleanup(db.reset)
        import psycopg
        self.real = psycopg.connect
        self.calls = 0

        def counting(*a, **k):
            self.calls += 1
            return self.real(*a, **k)
        p = mock.patch("psycopg.connect", side_effect=counting)
        p.start()
        self.addCleanup(p.stop)
        self.now = [1000.0]
        c = mock.patch.object(db, "_ping_clock", lambda: self.now[0])
        c.start()
        self.addCleanup(c.stop)

    def test_60초_안에는_연결을_다시_쓰고_지나면_새로_맺는다(self):
        self.assertTrue(db.ping(2))
        self.now[0] += 30
        self.assertTrue(db.ping(2))
        self.assertEqual(self.calls, 1)
        self.now[0] += 31
        self.assertTrue(db.ping(2))
        self.assertEqual(self.calls, 2)

    def test_확인_연결은_autocommit_이라_트랜잭션_중_쉼이_되지_않는다(self):
        import psycopg
        self.assertTrue(db.ping(2))
        conn = db._ping["conn"]
        self.assertTrue(conn.autocommit)
        self.assertEqual(conn.info.transaction_status, psycopg.pq.TransactionStatus.IDLE)

    def test_끊긴_연결은_다시_맺어_참(self):
        self.assertTrue(db.ping(2))
        pid = db._ping["conn"].info.backend_pid
        killer = db.session_connection()
        try:
            killer.execute("SELECT pg_terminate_backend(%s)", (pid,))
        finally:
            killer.close()
        threading.Event().wait(0.3)
        self.assertTrue(db.ping(2))
        self.assertEqual(self.calls, 3)                           # 처음·끊긴 것 다시(세션 연결은 따로 1)

    def test_다른_확인이_잠금을_쥐고_있으면_새_연결로_확인한다(self):
        self.assertTrue(db.ping(2))
        with db._ping_lock:
            self.assertTrue(db.ping(2))
        self.assertEqual(self.calls, 2)
        self.assertTrue(db.ping(2))                               # 쓰던 확인 연결은 그대로 남는다
        self.assertEqual(self.calls, 2)

    def test_reset_은_확인_연결도_닫는다(self):
        self.assertTrue(db.ping(2))
        conn = db._ping["conn"]
        db.reset()
        self.assertTrue(conn.closed)
        self.assertIsNone(db._ping["conn"])


@unittest.skipUnless(PG, "PostgreSQL 백엔드에서만")
class UnloggedTest(unittest.TestCase):
    """걸음·말풍선 중계 표는 WAL 을 쓰지 않아 커밋 때 디스크 동기화를 기다리지 않는다. 서버 살아 있음 표는 보통 표(리뷰 D6·D7)."""

    def setUp(self):
        self.d = tempfile.TemporaryDirectory()
        os.environ["AAS_DATA_DIR"] = self.d.name

    def tearDown(self):
        self.d.cleanup()

    def persistence(self, conn, name):
        row = conn.execute("SELECT relpersistence FROM pg_class WHERE oid = to_regclass(?)", (name,)).fetchone()
        return row[0] if row else None

    def test_걸음_중계_표는_UNLOGGED_살아_있음_표는_보통(self):
        from aas.office import presence, shared
        with presence._connect():
            pass
        with shared._connect() as conn:
            got = {t: self.persistence(conn, t) for t in ("office_presence", "office_relay", "office_relay_id_seq", "office_servers")}
        self.assertEqual(got, {"office_presence": "u", "office_relay": "u", "office_relay_id_seq": "u", "office_servers": "p"})

    def test_예전에_보통_표로_만든_표도_UNLOGGED_로_바꾼다(self):
        with store.connect() as conn:
            conn.execute("SELECT 1")
        conn = store.connect()
        conn.execute("CREATE TABLE IF NOT EXISTS unlogged_probe (id INTEGER PRIMARY KEY AUTOINCREMENT, ts REAL NOT NULL)")
        conn.execute("CREATE TABLE IF NOT EXISTS unlogged_probe /* unlogged */ (id INTEGER PRIMARY KEY AUTOINCREMENT, ts REAL NOT NULL)")
        with store.connect() as conn:
            self.assertEqual(self.persistence(conn, "unlogged_probe"), "u")

    def test_바꾸기가_잠금을_못_얻어도_오류를_내지_않는다(self):
        conn = store.connect()
        conn.execute("CREATE TABLE IF NOT EXISTS unlogged_busy (id INTEGER)")
        holder = db.session_connection()
        try:
            holder.execute("SET search_path TO " + db._tl_schema())
            holder.execute("BEGIN")
            holder.execute("LOCK TABLE unlogged_busy IN ACCESS SHARE MODE")
            with mock.patch.object(db, "UNLOGGED_LOCK_TIMEOUT", "200ms"):
                conn.execute("CREATE TABLE IF NOT EXISTS unlogged_busy /* unlogged */ (id INTEGER)")
            holder.execute("ROLLBACK")
        finally:
            holder.close()
        with store.connect() as c:
            self.assertEqual(self.persistence(c, "unlogged_busy"), "p")    # 다음 기동에 다시 해 본다


if __name__ == "__main__":
    unittest.main()

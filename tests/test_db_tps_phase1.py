# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""PostgreSQL 문장 수 줄이기 1차(스펙 2026-10-26-002 6절): 반복 한 바퀴 안의 같은 읽기 한 번(R1), 무시한 크론 표 만들기 한 번(E1),
자동 업그레이드 확인 질의 하나(R2·E8), 진행 카드 10초 기억(R5·E7), 살아 있는 서버 5초 기억(R6), readyz 의 최근 성공(R12)."""
import os
import sqlite3
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

from aas.common import db, store
from aas.market import updates
from aas.office import office, shared
from aas.ops import mutes
from aas.web import server


class DataDir(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.old = os.environ.get("AAS_DATA_DIR")
        os.environ["AAS_DATA_DIR"] = str(Path(self.tmp.name) / "data")

    def tearDown(self):
        if self.old is None:
            os.environ.pop("AAS_DATA_DIR", None)
        else:
            os.environ["AAS_DATA_DIR"] = self.old
        self.tmp.cleanup()

    def count_sql(self, needle: str):
        """이 시험 동안 DB 로 나간 문장 중 needle 이 든 것을 센다(SQLite 는 trace, PostgreSQL 은 PgConn.execute)."""
        seen: list[str] = []
        if db.backend() == "postgres":
            real_exec = db.PgConn.execute

            def execute(conn, sql, params=None):
                seen.append(sql)
                return real_exec(conn, sql, params)
            patcher = mock.patch.object(db.PgConn, "execute", execute)
        else:
            real = sqlite3.connect

            def connect(*a, **k):
                c = real(*a, **k)
                c.set_trace_callback(seen.append)
                return c
            patcher = mock.patch.object(sqlite3, "connect", side_effect=connect)
        patcher.start()
        self.addCleanup(patcher.stop)
        # 연결 하나에 trace 는 하나뿐이라 두 번 부르면 앞 카운터가 아무것도 못 센다 — 다른 문장은 같은 카운터에 needle 을 넘겨 센다
        return lambda other=needle: sum(1 for s in seen if other in s)


class CollectInOneReadScopeTest(DataDir):
    """R1: 모든 서버가 5초마다 도는 재료 수집은 에이전트마다 무시한 크론을 읽었다(요청 범위 메모 밖)."""

    def test_재료_수집은_같은_읽기_한_번_범위_안에서_돈다(self):
        seen = []
        with mock.patch.object(server.leader, "is_leader", return_value=False), \
                mock.patch.object(server, "_collect_mine", side_effect=lambda reg: seen.append(store._MEMO.get() is not None)), \
                mock.patch.object(server, "registry", return_value=SimpleNamespace(pods=[])):
            server._office_tick()
        self.assertEqual(seen, [True])

    def test_범위_안에서는_에이전트가_여럿이어도_무시한_크론을_한_번_읽는다(self):
        mutes.rows()                                                     # 표를 만든다
        n = self.count_sql("FROM cron_muted")
        with store.request_memo():
            for _ in range(10):
                mutes.apply({"jobs": []})
        self.assertEqual(n(), 1)


class MutesSchemaOnceTest(DataDir):
    """E1: 무시한 크론을 읽을 때마다 CREATE TABLE 을 먼저 보냈다(SQLite 에서 읽기마다 왕복 하나 더)."""

    def test_새_데이터_폴더에서_처음_읽어도_표가_생기고_그_뒤에는_표를_만들지_않는다(self):
        n = self.count_sql("CREATE TABLE IF NOT EXISTS cron_muted")
        self.assertEqual(mutes.rows(), [])
        mutes.mute("main", "j1", "job", by="a@x.co")
        self.assertEqual([r["job_id"] for r in mutes.rows()], ["j1"])
        mutes.unmute("main", "j1")
        self.assertEqual(mutes.rows(), [])
        self.assertEqual(n(), 1)

    @unittest.skipIf(db.backend() == "postgres", "SQLite 파일 이야기")
    def test_같은_폴더의_DB_파일이_새로_생기면_표를_다시_만든다(self):
        mutes.rows()
        (Path(os.environ["AAS_DATA_DIR"]) / "aas.db").unlink()           # 시험·복구로 DB 파일이 새로 생겼다
        self.assertEqual(mutes.rows(), [])

    @unittest.skipIf(db.backend() == "postgres", "SQLite 파일 이야기")
    def test_새_DB_파일이_지운_파일의_inode_를_다시_받아도_표를_만든다(self):
        # Docker 의 파일 시스템은 지운 파일의 inode 번호를 새 파일에 다시 준다. 기억 열쇠에 inode 를 넣었더니 표를 다시 만들지 않아
        # 「no such table: cron_muted」로 시험이 가끔 실패했다(2026-10-26, python:3.12-slim 3번 중 1번)
        with mock.patch.object(mutes, "_file_id", return_value=7, create=True):
            mutes.rows()
            (Path(os.environ["AAS_DATA_DIR"]) / "aas.db").unlink()
            self.assertEqual(mutes.rows(), [])
            mutes.mute("main", "j3", "job")
            self.assertEqual([r["job_id"] for r in mutes.rows()], ["j3"])
            mutes.unmute("main", "j3")
            (Path(os.environ["AAS_DATA_DIR"]) / "aas.db").unlink()
            mutes.mute("main", "j4", "job")                              # 쓰기가 먼저 와도
            self.assertEqual([r["job_id"] for r in mutes.rows()], ["j4"])

    def test_데이터_폴더가_바뀌면_그_폴더에도_표를_만든다(self):
        mutes.rows()
        other = Path(self.tmp.name) / "other"
        with mock.patch.dict(os.environ, {"AAS_DATA_DIR": str(other)}):
            mutes.mute("main", "j2", "job")
            self.assertEqual([r["job_id"] for r in mutes.rows()], ["j2"])


@unittest.skipIf(db.backend() == "postgres", "SQLite 연결 이야기 — PostgreSQL 은 db.PgConn.executescript 가 따로 한 번만 한다")
class SqliteSchemaOnceTest(DataDir):
    """§9-16: SQLite 연결마다 모듈의 표 정의 묶음(CREATE … IF NOT EXISTS)을 다시 실행해 compose 의 문장 96% 가 표 만들기였다.
    같은 DB 파일·같은 묶음은 schema_version 이 그대로인 동안 한 번만 한다."""

    STORE_CREATE = "CREATE TABLE IF NOT EXISTS snapshots"

    def setUp(self):
        super().setUp()
        store.forget_schema()

    def db_file(self) -> Path:
        return Path(os.environ["AAS_DATA_DIR"]) / "aas.db"

    def warm(self) -> int:
        """기억이 수렴할 때까지 연결하고(add_columns 의 인덱스가 값을 한 번 올린다) 그때의 schema_version 을 돌려준다."""
        for _ in range(2):
            with store.connect() as conn:
                conn.execute("SELECT 1")
        with store.connect() as conn:
            return conn.execute("PRAGMA schema_version").fetchone()[0]

    def same_version_without_tables(self, version: int) -> None:
        """DB 파일을 지우고, 표는 다른 것뿐이지만 schema_version 이 같은 새 파일을 만든다(기억이 우연히 맞는 경우)."""
        self.db_file().unlink()
        raw = sqlite3.connect(self.db_file())
        for i in range(version):
            raw.execute(f"CREATE TABLE t{i} (x)")
        self.assertEqual(raw.execute("PRAGMA schema_version").fetchone()[0], version)
        raw.close()

    def test_같은_DB_로_여러_번_연결해도_표_만들기는_다시_하지_않는다(self):
        self.warm()
        sql = self.count_sql(self.STORE_CREATE)
        for _ in range(10):
            with store.connect() as conn:
                conn.execute("SELECT count(*) FROM snapshots")
        self.assertEqual(sql(), 0)
        self.assertEqual(sql("PRAGMA schema_version"), 10)

    def test_같은_폴더의_DB_파일이_새로_생기면_표를_다시_만든다(self):
        self.warm()
        self.db_file().unlink()
        with store.connect() as conn:
            self.assertEqual(conn.execute("SELECT count(*) FROM snapshots").fetchone()[0], 0)

    def test_새_파일의_schema_version_이_우연히_같아도_첫_문장에서_표를_만들고_성공한다(self):
        self.same_version_without_tables(self.warm())
        with store.connect() as conn:
            self.assertEqual(conn.execute("SELECT count(*) FROM snapshots").fetchone()[0], 0)
            conn.execute("INSERT INTO meta (key, value) VALUES ('k', 'v')")
        with store.connect() as conn:
            self.assertEqual(conn.execute("SELECT value FROM meta WHERE key='k'").fetchone()[0], "v")

    def test_트랜잭션_안에서_표가_없으면_다시_하지_않고_앞선_쓰기도_남지_않는다(self):
        self.same_version_without_tables(self.warm())
        with self.assertRaisesRegex(sqlite3.OperationalError, "no such table: snapshots"):
            with store.connect() as conn:
                conn.execute("INSERT INTO t0 (x) VALUES (1)")           # 쓰기로 트랜잭션이 열렸다
                conn.execute("SELECT count(*) FROM snapshots")
        raw = sqlite3.connect(self.db_file())
        self.assertEqual(raw.execute("SELECT count(*) FROM t0").fetchone()[0], 0)
        raw.close()

    def test_다른_모듈이_표를_더_만들면_한_번_더_돌고_다시_건너뛴다(self):
        self.warm()
        office.connect().close()                                       # office 표가 생겨 schema_version 이 오른다
        creates = self.count_sql(self.STORE_CREATE)
        for _ in range(3):
            with store.connect() as conn:
                conn.execute("SELECT 1")
        self.assertEqual(creates(), 1)

    def test_받침이_고칠_수_없는_표는_한_번만_다시_하고_원래_오류를_낸다(self):
        self.warm()
        creates = self.count_sql(self.STORE_CREATE)
        with store.connect() as conn:
            with self.assertRaisesRegex(sqlite3.OperationalError, "no such table: nope"):
                conn.execute("SELECT * FROM nope")
        self.assertEqual(creates(), 1)                                   # 건너뛴 묶음을 한 번 다시 했다
        self.assertEqual(mutes.rows(), [])                                # mutes 의 자기 받침은 그대로 동작


class AutoUpgradeSettleOneQueryTest(DataDir):
    """R2·E8: 리더가 5초마다 에이전트 수만큼 market_update_auto 를 물었다(초당 1.80건)."""

    def _queue(self, pod: str, request: str = "r1"):
        with updates._conn() as conn:
            conn.execute("INSERT INTO market_update_auto (pod, profile, package, version, request, status, message, ts) VALUES (?,?,?,?,?,?,?,?)",
                         (pod, "main", "pkg", "1.0", request, "queued", "", updates._now()))

    def test_기다리는_줄이_없으면_에이전트가_열이어도_질의_하나(self):
        updates.auto_rows("p0")                                          # 표를 만든다
        n = self.count_sql("FROM market_update_auto")
        with mock.patch.object(updates.marketplace, "requests") as reqs:
            updates.settle_auto_all([f"p{i}" for i in range(10)])
        self.assertEqual(n(), 1)
        reqs.assert_not_called()

    def test_기다리는_줄이_있는_에이전트만_요청을_보고_짝짓는다(self):
        updates.auto_rows("p0")
        self._queue("p2", "r9")
        done = [{"id": "r9", "status": "done", "message": ""}]
        with mock.patch.object(updates.marketplace, "requests", return_value=done) as reqs:
            updates.settle_auto_all(["p1", "p2", "p3"])
        reqs.assert_called_once_with("p2", 2000)
        self.assertEqual(updates.auto_rows("p2")[0]["status"], "done")

    def test_다른_에이전트의_줄은_넘긴_목록에_없으면_건드리지_않는다(self):
        updates.auto_rows("p0")
        self._queue("gone", "r1")
        with mock.patch.object(updates.marketplace, "requests") as reqs:
            updates.settle_auto_all(["p1"])
        reqs.assert_not_called()

    def test_리더_주기는_에이전트마다_묻지_않는다(self):
        reg = SimpleNamespace(pods=[SimpleNamespace(id=f"p{i}", hermes_home=None) for i in range(10)])
        with mock.patch.object(server.market_updates, "settle_auto_all") as settle, \
                mock.patch.object(server.market_updates, "auto_enabled", return_value=False), \
                mock.patch.object(server.market_updates, "drain", return_value=[]):
            server.market_update_cycle(reg)
        settle.assert_called_once_with([f"p{i}" for i in range(10)])


class RunningCardsTenSecondsTest(DataDir):
    """R5·E7: 「일하는 중」 뒤 새로 고침이 에이전트마다 진행 카드 DISTINCT 를 물었다. 메모 물려받기에 기대지 않고 10초 기억한다."""

    def setUp(self):
        super().setUp()
        server._running_cards_clear()
        self.addCleanup(server._running_cards_clear)

    def test_메모_밖에서도_10초_안에는_한_번만_읽는다(self):
        calls = []
        now = [100.0]
        with mock.patch.object(server, "_running_cards_read", side_effect=lambda: calls.append(1) or {"p1": {"kim"}}), \
                mock.patch.object(server, "_cards_clock", side_effect=lambda: now[0]), \
                mock.patch.object(server.office, "seats", return_value=[{"alias": "kim", "pod": "p1", "profile": "main"}]):
            for p in ("p1", "p2", "p3"):
                server._card_running(SimpleNamespace(id=p))
            self.assertEqual(len(calls), 1)
            now[0] += 9.9
            server._card_running(SimpleNamespace(id="p1"))
            self.assertEqual(len(calls), 1)
            now[0] += 0.2                                                # 10초가 지났다
            self.assertEqual(server._card_running(SimpleNamespace(id="p1")), {"main"})
            self.assertEqual(len(calls), 2)

    def test_이_서버가_카드_표를_쓰면_10초를_기다리지_않고_다시_읽는다(self):
        # 칸반 「진행」으로 보낸 직후 오피스 상태가 working 이 되어야 한다(test_office_api 칸반 시험이 순서에 따라 깨졌다)
        from aas.office import hub_auto
        calls = []
        with mock.patch.object(server, "_running_cards_read", side_effect=lambda: calls.append(1) or {}):
            server._running_cards()
            server._running_cards()
            hub_auto.cards_written()
            server._running_cards()
        self.assertEqual(len(calls), 2)

    def test_읽는_사이에_카드_표가_바뀌면_읽은_값을_다음에_쓰지_않는다(self):
        from aas.office import hub_auto
        calls = []

        def read():
            calls.append(1)
            if len(calls) == 1:
                hub_auto.cards_written()                                 # 읽는 도중 이 서버가 카드를 썼다
            return {}
        with mock.patch.object(server, "_running_cards_read", side_effect=read):
            server._running_cards()
            server._running_cards()
        self.assertEqual(len(calls), 2)

    def test_돌려준_값을_고쳐도_기억한_값은_그대로다(self):
        with mock.patch.object(server, "_running_cards_read", return_value={"p1": {"kim"}}):
            got = server._running_cards()
            got["p1"].add("lee")
            self.assertEqual(server._running_cards(), {"p1": {"kim"}})


class AliveServersFiveSecondsTest(DataDir):
    """R6: 살아 있는 서버 목록을 읽을 때마다 물었다(초당 1.02건). 신호가 5초마다라 5초 동안 기억한다(새 서버는 최대 5초 늦게 안다)."""

    def test_5초_안에는_한_번만_읽고_지나면_다시_읽는다(self):
        now = [1000.0]
        s = shared.Shared(origin="me", clock=lambda: now[0])
        other = shared.Shared(origin="other", clock=lambda: now[0])
        first = s.alive_servers()                                        # PostgreSQL 시험은 다른 시험의 서버 줄이 남아 있을 수 있다
        n = self.count_sql("FROM office_servers WHERE ts")
        other.heartbeat()
        self.assertEqual(s.alive_servers(), first)                       # 기억한 값(새 서버를 아직 모른다)
        now[0] += shared.ALIVE_MEMO + 0.1                               # 신호 간격만큼 기억한다(§9-12 에서 5 → 10초)
        self.assertIn("other", s.alive_servers())
        self.assertEqual(n(), 1)


class ReadyzRecentSuccessTest(unittest.TestCase):
    """R12: /readyz 가 프로브마다 SELECT 1 을 보냈다. 같은 프로세스의 DB 문장이 최근 10초 안에 성공했으면 보내지 않는다."""

    def setUp(self):
        self.old = dict(db._pool_ok)
        self.addCleanup(lambda: db._pool_ok.update(self.old))

    def test_최근_성공이_있으면_확인_문장을_보내지_않는다(self):
        now = [500.0]
        db._pool_ok["at"] = 495.0
        with mock.patch.object(db, "backend", return_value="postgres"), mock.patch.object(db, "_ping_clock", side_effect=lambda: now[0]), \
                mock.patch.object(db, "_ping_once") as once:
            self.assertTrue(db.ping())
        once.assert_not_called()

    def test_최근_성공이_10초보다_오래면_확인한다(self):
        db._pool_ok["at"] = 480.0
        with mock.patch.object(db, "backend", return_value="postgres"), mock.patch.object(db, "_ping_clock", return_value=500.0), \
                mock.patch.object(db, "_ping_once", return_value=False) as once:
            self.assertFalse(db.ping())
        once.assert_called_once()


if __name__ == "__main__":
    unittest.main()

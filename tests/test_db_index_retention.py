# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""데이터가 쌓여도 느려지지 않게(스펙 2026-10-24-006): 인덱스, 추세 조회 범위, 31일 보관, 자리 목록 캐시.
시험마다 자기 데이터 폴더(PostgreSQL 은 AAS_DB_SCHEMA=auto 로 자기 스키마)를 쓴다."""
import os
import tempfile
import unittest
from datetime import datetime, timedelta

from aas.common import db, store
from aas.office import office


class DataDir(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.old = os.environ.get("AAS_DATA_DIR")
        os.environ["AAS_DATA_DIR"] = self.tmp.name

    def tearDown(self):
        if self.old is None:
            os.environ.pop("AAS_DATA_DIR", None)
        else:
            os.environ["AAS_DATA_DIR"] = self.old
        self.tmp.cleanup()


def index_names(conn, table: str) -> set[str]:
    if db.is_pg(conn):
        return {r[0] for r in conn.execute("SELECT indexname FROM pg_indexes WHERE schemaname=current_schema() AND tablename=?", (table,))}
    return {r[1] for r in conn.execute(f"PRAGMA index_list({table})")}


def snapshot(ts: str, name: str = "a/main") -> dict:
    prof = {"name": name, "jobs_status": "ok", "exec_status": "ok", "open_incidents": 1, "new_incidents": 0, "failed_jobs": 0,
            "stalled_jobs": 0, "silent_jobs": 0, "jobs_total": 1, "jobs_active": 1, "runs_7d": 1, "runs_failed_7d": 0}
    return {"collected_at": ts, "profiles": [prof], "incidents": [], "muted": [], "jobs": []}


class IndexTest(DataDir):
    """자주 쓰는 조회에 맞는 인덱스가 없어 표 전체를 읽었다(100만 줄: 변경 기록 105ms, 판 목록 38ms)."""

    def test_usage_ts_file_versions_pod_path_auth_sessions_email_인덱스가_생긴다(self):
        from aas.assets import files
        from aas.auth.auth import Auth
        Auth()
        with store.connect() as conn:
            files.ensure_schema(conn)
            got = {t: index_names(conn, t) for t in ("usage", "file_versions", "auth_sessions")}
        self.assertIn("usage_ts", got["usage"])
        self.assertIn("file_versions_pod_path", got["file_versions"])
        self.assertIn("auth_sessions_email", got["auth_sessions"])


class RetentionTest(DataDir):
    """usage·snapshots·snapshot_totals 를 지우는 코드가 없어 계속 커졌다. 31일이 지난 줄을 지운다(사용자 결정 2026-10-24)."""

    def test_31일이_지난_줄만_지우고_기준_시점_스냅샷은_남긴다(self):
        now = datetime(2026, 10, 24, 12, 0).astimezone()
        iso = lambda d: (now - timedelta(days=d)).isoformat(timespec="seconds")
        for d in (40, 32, 30, 1):
            store.record_snapshot(snapshot(iso(d)))
        with store.connect() as conn:
            for d in (40, 32, 30, 1):
                conn.execute("INSERT INTO usage (ts, kind, note, pod) VALUES (?,?,?,?)", (iso(d), "login", "a@x.com", ""))
            conn.execute(db.upsert("meta", ("key", "value"), ("key",)), ("baseline_ts", iso(40)))   # 평가가 견주는 기준 시점
        gone = store.prune_old(now)
        self.assertEqual(gone, {"usage": 2, "snapshots": 1, "snapshot_totals": 1})
        with store.connect() as conn:
            self.assertEqual(sorted(r[0] for r in conn.execute("SELECT ts FROM usage")), [iso(30), iso(1)])
            self.assertEqual(sorted(r[0] for r in conn.execute("SELECT ts FROM snapshots")), [iso(40), iso(30), iso(1)])
            self.assertEqual(sorted(r[0] for r in conn.execute("SELECT ts FROM snapshot_totals")), [iso(40), iso(30), iso(1)])
        self.assertIsNotNone(store.totals_at(iso(40)))
        self.assertEqual(store.prune_old(now), {"usage": 0, "snapshots": 0, "snapshot_totals": 0})


class TrendRangeTest(DataDir):
    """추세가 날짜 범위 없이 표 전체를 두 번 읽었다(100만 줄 243ms). 가장 최근 스냅샷 기준 days 일만 읽는다."""

    def test_가장_최근_스냅샷보다_days_일_앞선_날은_넣지_않는다(self):
        for day in ("2026-08-01", "2026-10-10", "2026-10-11", "2026-10-12"):
            store.record_snapshot(snapshot(f"{day}T09:00:00+09:00"))
        self.assertEqual([r["day"] for r in store.trend(30)], ["2026-10-10", "2026-10-11", "2026-10-12"])
        self.assertEqual([r["day"] for r in store.trend(2)], ["2026-10-11", "2026-10-12"])

    def test_스냅샷이_없으면_빈_목록(self):
        self.assertEqual(store.trend(30), [])


class SeatCacheTest(DataDir):
    """seats() 가 부를 때마다 자리 표 전체를 읽었다(자리 5,000개 8.6ms, 오피스 화면이 몇 초마다 여러 번).
    바뀌지 않았으면 저장해 둔 목록을 쓰고, 바뀜은 DB 트리거가 올리는 판 번호로 안다 — 서버가 둘이어도 맞다."""

    def setUp(self):
        super().setUp()
        office.set_seat({"pod": "p1", "profile": "main", "alias": "kim"}, "me", {"p1": {"main"}})

    def full_reads(self, fn) -> int:
        seen, real = [], office.connect

        class Spy:
            def __init__(self, conn):
                self.conn = conn

            def __enter__(self):
                self.conn.__enter__()
                return self

            def __exit__(self, *exc):
                return self.conn.__exit__(*exc)

            def execute(self, sql, *args):
                seen.append(sql)
                return self.conn.execute(sql, *args)
        office.connect = lambda: Spy(real())
        try:
            fn()
        finally:
            office.connect = real
        return sum(1 for s in seen if s.startswith("SELECT * FROM office_seats"))

    def test_바뀌지_않았으면_표를_다시_읽지_않는다(self):
        office.seats()
        self.assertEqual(self.full_reads(lambda: [office.seats() for _ in range(3)]), 0)

    def test_SQL_로_직접_바꿔도_다음_호출에_보인다(self):
        self.assertEqual(office.seats()[0]["title"], "")
        with store.connect() as conn:
            conn.execute("UPDATE office_seats SET title='팀장' WHERE alias='kim'")
        self.assertEqual(office.seats()[0]["title"], "팀장")
        with store.connect() as conn:
            conn.execute("DELETE FROM office_seats")
        self.assertEqual(office.seats(), [])

    def test_돌려받은_목록을_고쳐도_다음_호출에_번지지_않는다(self):
        office.seats()[0]["title"] = "바꿈"
        self.assertEqual(office.seats()[0]["title"], "")

    def test_다른_데이터_폴더의_목록을_돌려주지_않는다(self):
        self.assertEqual([s["alias"] for s in office.seats()], ["kim"])
        other = tempfile.TemporaryDirectory()
        self.addCleanup(other.cleanup)
        os.environ["AAS_DATA_DIR"] = other.name
        self.assertEqual(office.seats(), [])


if __name__ == "__main__":
    unittest.main()

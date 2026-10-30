# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""구문 변환 지점마다 동등성 시험 — INSERT OR REPLACE/IGNORE 를 ON CONFLICT 로 바꾼 곳이 SQLite 와 PostgreSQL 에서 같은 행을 남기는지 본다.
같은 시험을 두 백엔드에서 돌린다(AAS_DB_BACKEND=postgres, AAS_DB_SCHEMA=auto)."""
import os
import tempfile
import threading
import unittest
from pathlib import Path

TMP = tempfile.TemporaryDirectory()
os.environ.setdefault("AAS_DATA_DIR", str(Path(TMP.name) / "data"))

from aas.common import db, store  # noqa: E402


def health(ts, open_n=1, status="ok", profile="p1"):
    return {"collected_at": ts, "profiles": [{"name": profile, "jobs_status": status, "exec_status": "ok", "open_incidents": open_n,
                                              "new_incidents": 0, "failed_jobs": 0, "stalled_jobs": 0, "silent_jobs": 0, "jobs_total": 2,
                                              "jobs_active": 1, "runs_7d": 3, "runs_failed_7d": 0}],
            "incidents": [], "muted": [], "jobs": []}


class DialectTest(unittest.TestCase):
    def setUp(self):
        self.d = tempfile.TemporaryDirectory()
        os.environ["AAS_DATA_DIR"] = self.d.name

    def tearDown(self):
        self.d.cleanup()

    def one(self, sql, params=()):
        with store.connect() as conn:
            return conn.execute(sql, params).fetchall()

    def test_스냅샷을_같은_시각에_다시_넣으면_값이_바뀌고_행은_늘지_않는다(self):
        store.record_snapshot(health("2026-10-12T10:00:00+09:00", open_n=1))
        store.record_snapshot(health("2026-10-12T10:00:00+09:00", open_n=5))
        rows = self.one("SELECT open_incidents FROM snapshots")
        self.assertEqual([r[0] for r in rows], [5])
        self.assertEqual(len(self.one("SELECT 1 FROM snapshot_totals")), 1)

    def test_baseline_ts_는_처음_값을_지킨다(self):
        store.record_snapshot(health("2026-10-12T10:00:00+09:00"))
        store.record_snapshot(health("2026-10-12T11:00:00+09:00"))
        self.assertEqual(store.baseline_ts(), "2026-10-12T10:00:00+09:00")

    def test_baseline_ts_는_두_호출이_겹쳐도_스냅샷을_잃지_않는다(self):
        errors = []

        def run(i):
            try:
                store.record_snapshot(health(f"2026-10-12T10:0{i}:00+09:00", profile=f"p{i}"))
            except Exception as exc:
                errors.append(exc)

        threads = [threading.Thread(target=run, args=(i,)) for i in range(4)]
        [t.start() for t in threads]
        [t.join() for t in threads]
        self.assertEqual(errors, [])
        self.assertEqual(len(self.one("SELECT 1 FROM snapshots")), 4)
        self.assertIn(store.baseline_ts(), {f"2026-10-12T10:0{i}:00+09:00" for i in range(4)})

    def test_불리언_합은_수집_오류_수를_센다(self):
        store.record_snapshot(health("2026-10-12T10:00:00+09:00", status="error"))
        totals = store.totals_at("2026-10-12T10:00:00+09:00")
        self.assertEqual((totals["profiles"], totals["collect_errors"]), (1, 1))

    def test_수집_바퀴_기록은_덮어쓴다(self):
        from aas.ops import collect_all
        collect_all.save_round({"a": 1}, 1.0)
        collect_all.save_round({"a": 2}, 2.0)
        self.assertEqual(collect_all.last_round()["pods"], {"a": 2})
        self.assertEqual(len(self.one("SELECT 1 FROM meta WHERE key='collect_round'")), 1)

    def test_크론_무시는_메모를_바꾸고_행은_하나다(self):
        from aas.ops import mutes
        mutes.mute("p", "j1", "job", "첫 메모", "me")
        mutes.mute("p", "j1", "job", "둘째 메모", "me2")
        rows = mutes.rows()
        self.assertEqual([(r["note"], r["by"]) for r in rows], [("둘째 메모", "me2")])

    def test_마켓_권한은_다시_주면_작성자가_바뀐다(self):
        from aas.market import marketplace
        marketplace.set_grant("pod1", "free", True, "a")
        marketplace.set_grant("pod1", "free", True, "b")
        self.assertEqual([g["by"] for g in marketplace.grants()], ["b"])

    def test_에이전트_한도는_다시_정하면_값이_바뀐다(self):
        from aas.fleet import agents
        agents.set_limit("a@x.com", 3, "me")
        agents.set_limit("a@x.com", 7, "me")
        self.assertEqual(agents.limit_for("a@x.com"), 7)

    def test_접근_권한은_다시_주면_역할이_바뀐다(self):
        from aas.fleet.pods import Registry
        pods = Registry.__new__(Registry)
        pods.pods = []
        pods.grant("a@x.com", "viewer", [], "me")
        pods.grant("a@x.com", "admin", [], "me")
        self.assertEqual(pods.grants()["a@x.com"]["role"], "admin")

    def test_오피스_핀은_다시_정하면_값이_바뀐다(self):
        from aas.office import office
        office.set_pin("hermes", "v1", "me")
        office.set_pin("hermes", "v2", "me")
        with office.connect() as conn:
            rows = conn.execute("SELECT value FROM office_pins").fetchall()
        self.assertEqual([r[0] for r in rows], ["v2"])

    def test_점검_기록은_같은_대상과_시각이면_덮어쓴다(self):
        from aas.office import office
        sql = db.upsert("office_checks", ("ts", "target", "status", "version", "detail"), ("target", "ts"))
        with office.connect() as conn:
            conn.execute(sql, ("t1", "pod:a", "ok", "1", ""))
            conn.execute(sql, ("t1", "pod:a", "down", "2", "x"))
            rows = conn.execute("SELECT status, version FROM office_checks").fetchall()
        self.assertEqual([(r[0], r[1]) for r in rows], [("down", "2")])

    def test_방_만들기는_번호를_돌려주고_메시지_번호가_늘어난다(self):
        from aas.office import meeting, office
        office.set_seat({"pod": "yj", "profile": "sa"}, "me", {"yj": {"sa"}})
        rid = office.set_room({"name": "t", "seats": ["sa"]}, "me")["id"]
        self.assertIsInstance(rid, int)
        a = meeting._append(rid, "user", "me", "하나")
        b = meeting._append(rid, "user", "me", "둘")
        self.assertGreater(b, a)


if __name__ == "__main__":
    unittest.main()

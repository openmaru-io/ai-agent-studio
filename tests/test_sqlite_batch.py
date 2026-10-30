# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""사이드카 sqlite_batch(OMAI-1102) — 크론 실행 기록·활동 집계의 sqlite 조회를 요청 하나로 묶고, 결과는 로컬과 같다."""
import json
import os
import time
import shutil
import sqlite3
import sys
import tempfile
import threading
import unittest
from pathlib import Path

TMP = tempfile.TemporaryDirectory()
os.environ.setdefault("AAS_DATA_DIR", str(Path(TMP.name) / "data"))
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "sidecar"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from aas_sidecar import ops as sc_ops, server as sc_server  # noqa: E402

from aas.hermes import hermes_reader as hr  # noqa: E402
from aas.hermes.readers import remote  # noqa: E402
from aas.ops import activity, cron_health  # noqa: E402
from test_aas import NOW, make_home  # noqa: E402
from test_readers_remote import add_state_db  # noqa: E402

TOKEN = "batch-token-0123456789abcdef"


def build_home(root: Path) -> Path:
    home = make_home(root)
    add_state_db(home)
    # 컬럼이 표준과 다른 활동 DB(api_call_count·model 없음)와, 컬럼이 다른 실행 기록 DB 를 가진 프로파일
    odd = home / "profiles" / "odd"
    (odd / "cron").mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(odd / "state.db")
    db.execute("CREATE TABLE sessions (id TEXT, source TEXT, started_at REAL, message_count INTEGER, input_tokens INTEGER)")
    db.execute("INSERT INTO sessions VALUES ('o1', 'cli', ?, 3, 10)", (time.time() - 60,))     # 집계 창은 지금 시각 기준 7일
    db.commit()
    db.close()
    db = sqlite3.connect(odd / "cron" / "executions.db")
    db.execute("CREATE TABLE executions (id TEXT, job_id TEXT)")
    db.commit()
    db.close()
    return home


class Counting(remote.RemoteBackend):
    def __init__(self, *a, **kw):
        super().__init__(*a, **kw)
        self.calls = []

    def _call(self, method, path, body=None, timeout=None):
        self.calls.append(path)
        return super()._call(method, path, body, timeout)


def strip(value):
    return json.loads(json.dumps(value, default=str))


class SqliteBatchTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.home = build_home(Path(cls.tmp.name))
        cls.httpd = sc_server.make_server("127.0.0.1", 0, sc_ops.Ops(cls.home), TOKEN)
        threading.Thread(target=cls.httpd.serve_forever, daemon=True).start()
        cls.url = f"http://127.0.0.1:{cls.httpd.server_port}"

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()
        cls.tmp.cleanup()

    def remote_root(self, batch=True):
        b = Counting(self.url, TOKEN, label="t")
        b._has_tree = False                                     # sqlite 호출만 센다
        if not batch:
            orig = b._call

            def no_batch(method, path, body=None):
                if path == "/v1/sqlite_batch":
                    b.calls.append(path)
                    raise FileNotFoundError("없는 경로입니다")
                return orig(method, path, body)
            b._call = no_batch
        return b, remote.RemotePath(b, "")

    def test_health_and_activity_ask_the_sidecar_once_with_the_same_result(self):
        for name, fn in (("health", lambda h: cron_health.collect(now=NOW, home=h)), ("activity", lambda h: activity.collect(7, home=h))):
            with self.subTest(name=name):
                b, root = self.remote_root()
                local = fn(self.home)
                got = fn(root)
                local.pop("collected_at", None); got.pop("collected_at", None)
                for out in (local, got):                         # 오류 문장의 DB 경로는 로컬·원격 표기가 다르다(전부터 같음)
                    for row in out.get("profiles", []):
                        row["detail"] = str(row.get("detail", "")).split(": ")[-1]
                self.assertEqual(strip(got), strip(local))
                self.assertEqual(b.calls.count("/v1/sqlite"), 0)
                self.assertEqual(b.calls.count("/v1/sqlite_batch"), 1 if name == "health" else 2)   # 활동은 컬럼이 다른 프로파일 하나를 다시 읽는다

    def test_old_sidecar_without_batch_gives_the_same_result(self):
        b, root = self.remote_root(batch=False)
        local = activity.collect(7, home=self.home)
        got = activity.collect(7, home=root)
        local.pop("collected_at"); got.pop("collected_at")
        self.assertEqual(strip(got), strip(local))
        self.assertGreater(b.calls.count("/v1/sqlite"), 3)                # 하나씩 묻는다
        self.assertIs(b._has_batch, False)

    def test_nonstandard_columns_are_read_again_only_for_that_profile(self):
        b, root = self.remote_root()
        got = {p["name"]: p for p in activity.collect(7, home=root)["profiles"]}
        self.assertEqual((got["odd"]["status"], got["odd"]["sessions"], got["odd"]["messages"]), ("ok", 1, 3))
        self.assertEqual(b.calls.count("/v1/sqlite_batch"), 2)

    def test_schema_mismatch_in_one_profile_does_not_stop_the_others(self):
        _b, root = self.remote_root()
        profs = list(hr.profiles(root))
        out = hr.read_executions_many(profs, "2000-01-01T00:00:00+00:00")
        self.assertIsInstance(out["odd"], hr.SchemaMismatch)
        self.assertEqual(out["alpha"].status, hr.read_executions(next(p for p in hr.profiles(self.home) if p.name == "alpha"),
                                                                 "2000-01-01T00:00:00+00:00").status)
        with self.assertRaises(hr.SchemaMismatch):
            hr.read_executions(next(p for p in profs if p.name == "odd"))

    def test_sidecar_batch_reports_errors_per_query_and_limits_size(self):
        o = sc_ops.Ops(self.home)
        out = o.sqlite_batch([{"path": "state.db", "sql": "SELECT COUNT(*) FROM sessions", "params": []},
                              {"path": "state.db", "sql": "DELETE FROM sessions", "params": []},
                              {"path": "nope.db", "sql": "SELECT 1", "params": []},
                              "bad"])["results"]
        self.assertEqual(out[0]["rows"], [[3]])
        self.assertEqual((out[1]["code"], out[2]["code"], out[3]["code"]), (400, 404, 400))
        with self.assertRaises(sc_ops.OpError):
            o.sqlite_batch([{"path": "state.db", "sql": "SELECT 1"}] * (sc_ops.MAX_BATCH + 1))


if __name__ == "__main__":
    unittest.main()

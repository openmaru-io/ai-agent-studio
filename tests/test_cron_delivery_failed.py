# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""Cron 작업의 결과 전달 실패(delivery_failed)는 실행 실패가 아니다(OMAI-1292).
OKE 에서 마지막 실행은 성공했고 결과 전달만 실패한 작업이 빨간 「실패 0회」로 보이고 「지금도 실패 중인 문제」로 세어졌다."""
import json
import os
import sqlite3
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

TMP = tempfile.TemporaryDirectory()
os.environ.setdefault("AAS_DATA_DIR", str(Path(TMP.name) / "data"))

from aas.assets import flow  # noqa: E402
from aas.ops import cron_health  # noqa: E402

NOW = datetime(2026, 10, 17, 14, 50, tzinfo=timezone.utc)


def iso(**kw) -> str:
    return (NOW - timedelta(**kw)).isoformat()


JOBS = [
    {"id": "d1", "name": "weekly-report", "enabled": True, "deliver": "bot-chat:main", "last_status": "delivery_failed", "failure_streak": 0,
     "last_delivery_error": "bot-chat delivery to profile 'main' failed (exit 1): Error: Profile 'main' does not exist",
     "last_run_at": iso(hours=6), "next_run_at": iso(hours=-18), "skills": ["weekly-review-planning"], "schedule_display": "0 9 * * *"},
    {"id": "e1", "name": "broken", "enabled": True, "deliver": "telegram:1", "last_status": "error", "failure_streak": 2,
     "last_error": "boom", "last_run_at": iso(hours=2), "next_run_at": iso(hours=-22), "schedule_display": "0 9 * * *"},
    {"id": "e2", "name": "odd-error", "enabled": True, "deliver": "telegram:1", "last_status": "error", "failure_streak": 0,
     "last_run_at": iso(hours=2), "next_run_at": iso(hours=-22), "schedule_display": "0 9 * * *"},
]


def make_home(root: Path) -> Path:
    home = root / "hermes"
    p = home / "profiles" / "main"
    (p / "cron").mkdir(parents=True)
    (home / "cron").mkdir(parents=True)
    (home / "config.yaml").write_text("model:\n  default: m\n")
    (p / "cron" / "jobs.json").write_text(json.dumps({"jobs": JOBS}))
    db = sqlite3.connect(p / "cron" / "executions.db")
    db.executescript("""
      CREATE TABLE executions (id TEXT PRIMARY KEY, job_id TEXT NOT NULL, source TEXT, process_id TEXT,
        pid INTEGER, process_started_at INTEGER, status TEXT NOT NULL, claimed_at TEXT NOT NULL,
        started_at TEXT, finished_at TEXT, error TEXT);
      CREATE TABLE cron_incidents (id TEXT PRIMARY KEY, job_id TEXT NOT NULL, error_sig TEXT NOT NULL,
        state TEXT NOT NULL, failure_type TEXT NOT NULL DEFAULT 'unknown', first_seen_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL, acked_at TEXT, closed_at TEXT, error TEXT NOT NULL, output_file TEXT);""")
    # 10월 15일에 난 옛 실패 사건 둘(이미 그 뒤 실행은 성공했다)
    for n, ft in (("a", "agent"), ("b", "unknown")):
        db.execute("INSERT INTO cron_incidents VALUES (?,?,?,?,?,?,?,NULL,NULL,?,NULL)",
                   (f"i-{n}", "d1", f"sig-{n}", "detected", ft, iso(days=2), iso(days=2), "RuntimeError: Connection error."))
    db.execute("INSERT INTO cron_incidents VALUES ('i-e','e1','sig-e','detected','agent',?,?,NULL,NULL,'boom',NULL)", (iso(hours=3), iso(hours=3)))
    db.commit(); db.close()
    return home


class DeliveryFailedHealthTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.home = make_home(Path(TMP.name))
        cls.health = cron_health.collect(now=NOW, home=cls.home)

    def test_a_delivery_failure_is_not_a_failed_run(self):
        names = [j["job"] for j in self.health["failed_jobs"]]
        self.assertNotIn("weekly-report", names)                     # 마지막 실행은 성공했다
        self.assertEqual(sorted(names), ["broken", "odd-error"])      # 진짜 실행 실패는 그대로 센다
        row = next(r for r in self.health["profiles"] if r["name"] == "main")
        self.assertEqual(row["failed_jobs"], 2)

    def test_the_delivery_problem_is_still_reported_as_silent(self):
        silent = {j["job"]: j for j in self.health["silent"]}
        self.assertIn("weekly-report", silent)
        self.assertIn("전달", silent["weekly-report"]["reason"])      # 「마지막 전달이 실패함」 — 전달 문제는 여기서 알린다

    def test_old_incidents_of_a_job_whose_last_run_succeeded_are_not_failing_now(self):
        now = {i["id"]: i["now"] for i in self.health["incidents"]}
        self.assertEqual(now["i-a"], "ok")                           # 전에는 failing(지금도 실패 중인 문제)이었다
        self.assertEqual(now["i-b"], "ok")
        self.assertEqual(now["i-e"], "failing")                      # 마지막 실행이 실패인 작업의 사건은 그대로


class DeliveryFailedBadgeTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        home = make_home(Path(TMP.name) / "flow")
        ix = flow.build(home)
        cls.starts = {s["label"]: s for s in flow.starts(ix)}

    def test_delivery_failed_shows_a_delivery_badge_not_a_failure_count(self):
        s = self.starts["weekly-report"]
        self.assertIn("전달 실패", s["badges"])
        self.assertFalse([b for b in s["badges"] if b.startswith("실패")])    # 「실패 0회」 가 아니다
        self.assertEqual(s["status"], "ok")                                   # 실행은 성공했다

    def test_a_real_failure_keeps_the_count_and_never_shows_zero(self):
        self.assertIn("실패 2회", self.starts["broken"]["badges"])
        self.assertEqual(self.starts["broken"]["status"], "bad")
        self.assertIn("실패 1회", self.starts["odd-error"]["badges"])         # streak 이 0 이어도 실패면 0회로 보이지 않는다


if __name__ == "__main__":
    unittest.main()

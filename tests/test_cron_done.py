# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""크론 완료 알림 시험(스펙 2026-10-15-003 R3·R4): 최근 성공만 모으고, 사람별 확인을 기록하고, 받은편지함에서 한 번만 낸다."""
import json
import os
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest import mock

TMP = tempfile.TemporaryDirectory()
os.environ.setdefault("AAS_DATA_DIR", str(Path(TMP.name) / "data"))

from aas.common import dbmigrate, store  # noqa: E402
from aas.fleet import primary  # noqa: E402
from aas.fleet.pods import Pod  # noqa: E402
from aas.ops import cron_done  # noqa: E402
from aas.web import server  # noqa: E402

NOW = datetime(2026, 10, 15, 12, 0, tzinfo=timezone.utc)
ME, OTHER = "kim@x.com", "lee@x.com"


def ago(**kw) -> str:
    return (NOW - timedelta(**kw)).isoformat()


def make_home(jobs_by_profile: dict[str, list[dict]]) -> Path:
    home = Path(tempfile.mkdtemp(dir=TMP.name))
    for name, jobs in jobs_by_profile.items():
        d = home / "profiles" / name / "cron"
        d.mkdir(parents=True)
        (d / "jobs.json").write_text(json.dumps({"jobs": jobs}), encoding="utf-8")
    return home


def job(jid, status="ok", ran=None, **kw):
    return {"id": jid, "name": f"작업-{jid}", "enabled": True, "last_status": status, "last_run_at": ago(hours=1) if ran is None else ran, "deliver": "local", **kw}


class RecentSuccessTest(unittest.TestCase):
    def test_24시간_안의_성공만_모으고_실패_빈_상태_멈춘_작업_옛_실행은_뺀다(self):
        home = make_home({"main": [job("a"), job("b", status="error"), job("c", status=""), job("d", status="completed"),
                                   job("e", ran=ago(hours=30)), job("f", enabled=False), job("g", status="delivery_failed"), job("h", ran=""),
                                   job("i", state="paused"), job("j", paused_at=ago(hours=2)), job("k", state="completed", enabled=False), job("l", enabled=False, state="scheduled")]})
        got = cron_done.recent_success(home, NOW)
        self.assertEqual(sorted(r["job_id"] for r in got), ["a", "d", "k"])      # k: 한 번만 도는 작업은 끝나면 completed·enabled=False 이지만 알린다. l: 사람이 끈 작업은 뺀다

    def test_프로파일마다_모으고_읽지_못한_프로파일은_건너뛴다(self):
        home = make_home({"main": [job("a")], "ops": [job("b")]})
        (home / "profiles" / "bad" / "cron").mkdir(parents=True)
        (home / "profiles" / "bad" / "cron" / "jobs.json").write_text("{not json", encoding="utf-8")
        self.assertEqual(sorted((r["profile"], r["job_id"]) for r in cron_done.recent_success(home, NOW)), [("main", "a"), ("ops", "b")])


class ItemsTest(unittest.TestCase):
    def setUp(self):
        with store.connect() as conn:
            conn.execute(cron_done.SCHEMA)
            conn.execute("DELETE FROM cron_done_ack")

    def done(self, **kw):
        return {"profile": "main", "job_id": "a", "job": "아침 보고", "run_at": ago(hours=1), "deliver": "local", **kw}

    def test_항목에_프로파일과_작업_id_가_있다_링크가_작업_서랍을_열_수_있다(self):
        # 오피스 자리 이름(alias)은 Cron 표의 검색 글(작업·프로파일·오류…)에 없어 q=alias 링크가 빈 표를 만들었다
        got = cron_done.items_for([self.done()], "p1", {("p1", "main"): "aas-agent-x-8c07"}, False)
        self.assertEqual((got[0]["alias"], got[0]["profile"], got[0]["job_id"], got[0]["pod"]), ("aas-agent-x-8c07", "main", "a", "p1"))

    def test_실패한_크론_항목에도_프로파일과_작업_id_가_있다(self):
        from aas.office import inbox
        got = inbox.crons_for([{"pod": "p1", "profile": "main", "job_id": "a", "job": "주간 보고", "alias": "aas-agent-x-8c07", "error": "x"}], "a@b")
        self.assertEqual((got[0]["alias"], got[0]["profile"], got[0]["job_id"], got[0]["pod"]), ("aas-agent-x-8c07", "main", "a", "p1"))

    def test_실행_하나가_항목_하나이고_같은_작업의_다음_실행은_새_항목(self):
        first = cron_done.items_for([self.done()], "p1", {("p1", "main"): "ma"}, False)
        self.assertEqual([(i["kind"], i["alias"], i["text"]) for i in first], [("cron_done", "ma", "아침 보고")])
        again = cron_done.items_for([self.done()], "p1", {("p1", "main"): "ma"}, False)
        self.assertEqual(first[0]["id"], again[0]["id"])
        newer = cron_done.items_for([self.done(run_at=ago(minutes=5))], "p1", {}, False)
        self.assertNotEqual(first[0]["id"], newer[0]["id"])

    def test_채널로_보내는_작업도_낸다_R4(self):
        self.assertEqual(len(cron_done.items_for([self.done(deliver="telegram:123")], "p1", {}, False)), 1)

    def test_숨긴_루트의_작업은_내지_않는다(self):
        self.assertEqual(cron_done.items_for([self.done(profile=primary.ROOT)], "p1", {}, True), [])
        self.assertEqual(len(cron_done.items_for([self.done(profile=primary.ROOT)], "p1", {}, False)), 1)

    def test_확인한_항목은_그_사람에게만_사라진다(self):
        item = cron_done.items_for([self.done()], "p1", {}, False)[0]
        cron_done.ack(ME, item["id"])
        self.assertEqual(cron_done.unacked([item], ME), [])
        self.assertEqual(cron_done.unacked([item], OTHER), [item])
        cron_done.ack(ME, item["id"])                                          # 두 번 확인해도 오류가 아니다

    def test_5분_주기_작업은_작업당_항목_1건(self):
        jobs = [self.done(run_at=ago(minutes=m)) for m in (5, 10)]              # recent_success 는 작업마다 최신 1건만 주므로 한 작업이 여러 건이면 호출한 쪽 오류
        self.assertEqual(len(cron_done.items_for(jobs[:1], "p1", {}, False)), 1)

    def test_오래된_확인_행은_읽을_때_지운다(self):
        old = (datetime.now(timezone.utc) - timedelta(hours=60)).isoformat(timespec="seconds")
        with store.connect() as conn:
            conn.execute("INSERT INTO cron_done_ack (email, item_id, ts) VALUES (?,?,?)", (ME, "cron_done|p1|main|a|x", old))
        cron_done.unacked([], ME)
        with store.connect() as conn:
            self.assertEqual(conn.execute("SELECT COUNT(*) FROM cron_done_ack").fetchone()[0], 0)

    def test_다른_종류의_id_는_확인하지_않는다(self):
        with self.assertRaises(ValueError):
            cron_done.ack(ME, "cron|p1|main|a")


class MigrateTest(unittest.TestCase):
    def test_확인_표는_PostgreSQL_이전_목록에_있다(self):
        self.assertIn(cron_done.SCHEMA, dbmigrate.schema_scripts())


class InboxTest(unittest.TestCase):
    """_office_inbox 가 주인에게만, 파일 읽기로, 한 번만 낸다."""

    def setUp(self):
        with store.connect() as conn:
            conn.execute(cron_done.SCHEMA)
            conn.execute("DELETE FROM cron_done_ack")
        self.home = make_home({"main": [job("a", ran=datetime.now(timezone.utc).isoformat())]})
        self.pod = Pod("p1", ME, self.home)
        self.reg = mock.Mock(pods=[self.pod])
        with server._lock:
            server._drop_locked("p1:crondone")

    def inbox(self, who):
        with mock.patch.object(primary, "is_target", return_value=False), mock.patch.object(server, "_health", return_value={"failed_jobs": []}):
            return [i for i in server._office_inbox(self.reg, {"email": who})["items"] if i["kind"] == "cron_done"]

    def test_주인에게만_한_번_보이고_확인하면_사라진다(self):
        got = self.inbox(ME)
        self.assertEqual([i["text"] for i in got], ["작업-a"])
        self.assertEqual(self.inbox(OTHER), [])
        server._office_inbox_answer(self.reg, {"email": ME}, True, {"id": got[0]["id"]})
        self.assertEqual(self.inbox(ME), [])

    def test_주인이_아니면_확인할_수_없다(self):
        got = self.inbox(ME)
        with self.assertRaises(Exception):
            server._office_inbox_answer(self.reg, {"email": OTHER}, True, {"id": got[0]["id"]})


if __name__ == "__main__":
    unittest.main()

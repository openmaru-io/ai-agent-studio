# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""세션 기록 집계를 시간 칸 표에 쌓기(스펙 2026-11-19-005 U1·R0): 커서 뒤만 읽기, 긴 세션, 구간 나누기와 「모름」, 잠금,
늦게 기록된 메시지, 이름 상한, runs 의 뜻, partial_profiles, 다른 복제본의 임대."""
import json
import os
import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest import mock

TMP = tempfile.TemporaryDirectory()
os.environ.setdefault("AAS_DATA_DIR", str(Path(TMP.name) / "data"))

from aas.common import store  # noqa: E402
from aas.hermes.readers import remote  # noqa: E402
from aas.ops import observed, usage_hours as uh  # noqa: E402

NOW = 1_800_000_000.0
DAY = 86400


def call(tool, **args):
    return {"function": {"name": tool, "arguments": json.dumps(args)}}


class Home:
    """Hermes 데이터 폴더 하나. 프로파일마다 state.db(메시지 시각·세션 끝 시각이 있는 새 모양)."""

    def __init__(self, root: Path, profiles=("default",)):
        self.root = root
        root.mkdir(parents=True)
        for p in profiles:
            path = root if p == "default" else root / "profiles" / p
            path.mkdir(parents=True, exist_ok=True)
            con = sqlite3.connect(path / "state.db")
            con.executescript("CREATE TABLE sessions (id TEXT PRIMARY KEY, source TEXT, started_at REAL, ended_at REAL);"
                              "CREATE TABLE messages (id INTEGER PRIMARY KEY, session_id TEXT, timestamp REAL, tool_calls TEXT);")
            con.commit()
            con.close()

    def db(self, profile="default"):
        return self.root / "state.db" if profile == "default" else self.root / "profiles" / profile / "state.db"

    def session(self, sid, started, ended=None, profile="default"):
        with sqlite3.connect(self.db(profile)) as con:
            con.execute("INSERT INTO sessions VALUES (?,?,?,?)", (sid, "cli", started, ended))

    def message(self, sid, at, *calls, profile="default"):
        with sqlite3.connect(self.db(profile)) as con:
            con.execute("INSERT INTO messages (session_id, timestamp, tool_calls) VALUES (?,?,?)", (sid, at, json.dumps(list(calls))))


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.home = Home(Path(self.tmp.name) / "h", profiles=("default", "b"))
        self.pod = f"obs-{self.id()}"
        self.addCleanup(self.clean)

    def clean(self):
        with store.connect() as conn:
            for table in ("skill_usage_hours", "skill_usage_sessions", "skill_usage_cursor"):
                conn.execute(f"DELETE FROM {table} WHERE pod=?", (self.pod,))

    def refresh(self, now=NOW):
        return observed.refresh(self.home.root, self.pod, now=now)

    def collect(self, now=NOW, days=14):
        with mock.patch.object(observed.time, "time", return_value=now):
            return observed.collect(self.home.root, days=days, pod=self.pod)

    def skill_total(self, name, since=0):
        return sum(r["n"] for r in uh.hours(self.pod, since) if r["kind"] == "skill" and r["name"] == name and not r["job"])


class Incremental(Base):
    def test_두_번째_차례는_새_기록만_세고_겹쳐_세지_않는다(self):
        self.home.session("s1", NOW - 3 * DAY)
        self.home.message("s1", NOW - 3 * DAY, call("skill_view", name="ops/digest"))
        self.refresh()
        self.home.message("s1", NOW + 600, call("skill_view", name="digest"))
        self.refresh(NOW + 1200)
        self.refresh(NOW + 1800)                                    # 아무것도 새로 생기지 않은 차례
        self.assertEqual(self.skill_total("digest"), 2)

    def test_커서보다_조금_앞에_늦게_기록된_메시지를_다음_차례에_센다(self):
        self.home.session("s1", NOW - DAY)
        self.refresh()
        self.home.message("s1", NOW - 3000, call("skill_view", name="late"))   # 지난 차례보다 앞 시각으로 늦게 들어왔다
        self.refresh(NOW + 600)
        self.assertEqual(self.skill_total("late"), 1)

    def test_오래_이어진_세션의_최근_사용을_센다(self):
        self.home.session("long", NOW - 89 * DAY)                    # 시작은 89일 전, 끝나지 않았다
        self.home.message("long", NOW - DAY, call("skill_view", name="chat-skill"))
        obs = self.collect()
        self.assertEqual(obs["profiles"]["default"]["skills"], {"chat-skill": 1})
        self.assertEqual(obs["profiles"]["default"]["runs"], 1)      # 기간 안에 메시지가 있던 세션

    def test_끝난_세션은_그_뒤_구간에서_고르지_않는다(self):
        self.home.session("done", NOW - 30 * DAY, ended=NOW - 29 * DAY)
        self.home.message("done", NOW - 29.5 * DAY, call("skill_view", name="x"))
        self.refresh()
        self.assertEqual(self.skill_total("x"), 1)

    def test_15일보다_오래된_구간은_skill_view_행만_읽는다(self):
        self.home.session("s", NOW - 40 * DAY)
        self.home.message("s", NOW - 40 * DAY, call("terminal", command="ls"))
        self.home.message("s", NOW - 39 * DAY, call("skill_view", name="old"))
        self.refresh()
        kinds = {(r["kind"], r["name"]) for r in uh.hours(self.pod, 0)}
        self.assertIn(("skill", "old"), kinds)
        self.assertNotIn(("tool", "terminal"), kinds)


class Splitting(Base):
    def test_상한에_닿으면_나눠_읽고_1시간도_넘치면_그_구간만_모름(self):
        self.home.session("s", NOW - 2 * DAY)
        busy_hour = NOW - DAY - (NOW - DAY) % 3600                   # 한 시간에 몰린 기록
        for i in range(5):
            self.home.message("s", busy_hour + i, call("skill_view", name="busy"))
        self.home.message("s", NOW - 1000, call("skill_view", name="calm"))
        with mock.patch.object(observed, "ROWS_FULL", 3):
            log = self.refresh()["log"]
        self.assertEqual(self.skill_total("calm"), 1)
        self.assertEqual(self.skill_total("busy"), 0)
        unknown = uh.cursor(self.pod, "default")["unknown"]
        self.assertEqual(unknown, [[busy_hour, busy_hour + 3600]])
        self.assertGreater(next(e for e in log if e["profile"] == "default")["queries"], 3)
        self.assertEqual({e["pod"] for e in log}, {self.pod})                 # 여러 에이전트가 섞인 로그에서 가를 수 있게
        with mock.patch.object(observed, "ROWS_FULL", 3):              # collect 도 먼저 읽는다 — 같은 상한이면 여전히 「모름」
            self.assertEqual(self.collect(NOW + 60)["partial_profiles"], ["default"])

    def test_모름_구간은_다음_차례에_다시_읽는다(self):
        self.home.session("s", NOW - 2 * DAY)
        busy_hour = NOW - DAY - (NOW - DAY) % 3600
        for i in range(5):
            self.home.message("s", busy_hour + i, call("skill_view", name="busy"))
        with mock.patch.object(observed, "ROWS_FULL", 3):
            self.refresh()
        self.refresh(NOW + 600)                                       # 상한이 넉넉해진 차례
        self.assertEqual(self.skill_total("busy"), 5)
        self.assertEqual(uh.cursor(self.pod, "default")["unknown"], [])

    def test_1시간_구간도_시간_초과면_남은_구간을_바로_모름으로(self):
        self.home.session("s", NOW - DAY)
        calls = []

        def slow(conn, sql, params, cap):
            calls.append(params)
            raise remote.SqlTimeout("late")
        with mock.patch.object(observed, "_exec", side_effect=slow):
            self.refresh()
        per_profile = len(calls) // 2                                 # 프로파일 둘
        self.assertLessEqual(per_profile, 1 + 4 + 6)                  # 하루 → 6시간 → 1시간 하나에서 멈춘다
        self.assertTrue(uh.cursor(self.pod, "default")["unknown"])

    def test_잠금은_한_번만_다시_묻고_나누지_않는다(self):
        self.home.session("s", NOW - DAY)
        n = []

        def busy(conn, sql, params, cap):
            n.append(1)
            raise remote.SqlBusy("locked")
        with mock.patch.object(observed, "_exec", side_effect=busy), mock.patch.object(observed.time, "sleep"):
            with mock.patch.object(observed, "FILL_DAYS", 1):
                observed.refresh(self.home.root, self.pod, now=NOW)
        self.assertEqual(len(n) % 2, 0)
        self.assertLessEqual(len(n), 2 * 2 * 2)                       # 프로파일 둘 × 하루 구간 둘 이하 × 두 번

    def test_한_프로파일이_실패해도_다른_프로파일은_센다(self):
        self.home.session("s", NOW - DAY, profile="b")
        self.home.message("s", NOW - 100, call("skill_view", name="ok"), profile="b")
        self.home.db("default").write_bytes(b"not a database")
        obs = self.collect()
        self.assertEqual(obs["profiles"]["b"]["skills"], {"ok": 1})
        self.assertTrue(any(n.startswith("default:") for n in obs["notes"]))


class Counting(Base):
    def test_크론_작업은_작업별로도_센다(self):
        sid = "cron_j1_20270115_080000"
        self.home.session(sid, NOW - 3600)
        self.home.message(sid, NOW - 3500, call("skill_view", name="digest"), call("mcp__OMDM__get_page", id="x"))
        obs = self.collect()
        self.assertEqual(obs["jobs"]["default/j1"]["skills"], {"digest": 1})
        self.assertEqual(obs["jobs"]["default/j1"]["mcp"], {"OMDM": {"get_page": 1}})
        self.assertEqual(obs["jobs"]["default/j1"]["runs"], 1)
        self.assertEqual(obs["profiles"]["default"]["skills"], {"digest": 1})   # 프로파일 전체에도 들어간다

    def test_시_칸_하나의_이름이_200개를_넘으면_나머지는_other(self):
        self.home.session("s", NOW - DAY)
        self.home.message("s", NOW - 100, *[call(f"tool_{i:03d}") for i in range(210)])
        self.refresh()
        names = {r["name"] for r in uh.hours(self.pod, 0) if r["kind"] == "tool"}
        self.assertIn("_other", names)
        self.assertEqual(len(names), observed.NAMES_PER_HOUR + 1)

    def test_대화_내용과_인자_값은_남기지_않는다(self):
        self.home.session("s", NOW - DAY)
        self.home.message("s", NOW - 100, call("terminal", command="TOKEN=hunter2 python3 /opt/data/scripts/send.py --to boss"))
        blob = json.dumps(self.collect(), ensure_ascii=False)
        for leak in ("hunter2", "boss"):
            self.assertNotIn(leak, blob)
        self.assertIn("scripts/send.py", blob)


class Replicas(Base):
    def test_다른_복제본이_임대를_쥐면_그_프로파일은_읽지_않는다(self):
        self.home.session("s", NOW - DAY)
        self.home.message("s", NOW - 100, call("skill_view", name="x"))
        uh.acquire(self.pod, "default", "other-server", now=NOW)
        self.refresh()
        self.assertEqual(self.skill_total("x"), 0)
        self.assertIsNone(uh.cursor(self.pod, "default"))
        uh.release(self.pod, "default", "other-server")
        self.refresh(NOW + 10)
        self.assertEqual(self.skill_total("x"), 1)


class OldShape(Base):
    def test_메시지_시각이_없는_옛_DB_는_세션_시작으로_거른다(self):
        root = Path(self.tmp.name) / "old"
        root.mkdir()
        con = sqlite3.connect(root / "state.db")
        con.executescript("CREATE TABLE sessions (id TEXT, source TEXT, started_at REAL);"
                          "CREATE TABLE messages (id INTEGER PRIMARY KEY, session_id TEXT, tool_calls TEXT);")
        con.execute("INSERT INTO sessions VALUES ('s','cli',?)", (NOW - DAY,))
        con.execute("INSERT INTO messages (session_id, tool_calls) VALUES ('s', ?)", (json.dumps([call("skill_view", name="y")]),))
        con.commit()
        con.close()
        with mock.patch.object(observed.time, "time", return_value=NOW):
            obs = observed.collect(root, pod=self.pod)
        self.assertEqual(obs["profiles"]["default"]["skills"], {"y": 1})


if __name__ == "__main__":
    unittest.main()

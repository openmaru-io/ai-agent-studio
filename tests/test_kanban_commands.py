# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""카드 실행 하나의 「실행한 명령」(스펙 2026-11-03-001 R11·R13·R14·R15, DD3·DD12, 외부 검토 M1·M2·M3, X2).

Hermes 대역: 칸반 DB(task_runs + aas_run_sessions)와 담당 프로파일의 state.db(sessions·messages)를 임시 폴더에 만든다.
서버가 하는 길(server._office_route → 접근 검사 → hub_auto.route)로 부른다. 시각은 hub_auto._now_ts 를 바꿔 넣는다."""
import json
import shutil
import sqlite3
import unittest
from unittest import mock

try:
    from tests import test_office_access as toa  # noqa: E402
except ImportError:                                            # unittest discover -s tests 로 돌릴 때
    import test_office_access as toa  # noqa: E402

from aas.office import hub_auto, office_access  # noqa: E402

BOARD = "office-cmds-0123456789"
NOW = 1_800_000_000.0
HOME = toa.HOMES["yj"]
KDB = HOME / "kanban" / "boards" / BOARD / "kanban.db"


def kanban_db(path, with_sessions_table=True):
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(path)
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS task_runs (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL, profile TEXT, status TEXT NOT NULL,
          started_at INTEGER NOT NULL, ended_at INTEGER, outcome TEXT, summary TEXT, metadata TEXT, error TEXT);""")
    if with_sessions_table:      # Lane B 의 Hermes 패치가 만드는 표. 옛 이미지에는 없다
        conn.execute("CREATE TABLE IF NOT EXISTS aas_run_sessions (run_id INTEGER, session_id TEXT, created_at REAL, PRIMARY KEY(run_id, session_id))")
    conn.commit()
    return conn


def state_db(profile):
    path = (HOME / "state.db") if profile == "default" else HOME / "profiles" / profile / "state.db"
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(path)
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, source TEXT NOT NULL, started_at REAL NOT NULL, ended_at REAL);
        CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT,
          tool_call_id TEXT, tool_calls TEXT, tool_name TEXT, timestamp REAL NOT NULL);""")
    conn.commit()
    return conn


def call(cid, name, args):
    return {"id": cid, "type": "function", "function": {"name": name, "arguments": json.dumps(args)}}


class CommandsBase(toa.AccessBase):
    def setUp(self):
        super().setUp()
        self.route(toa.ADMIN, "POST", "/api/office/kanban/boards", {"slug": BOARD, "name": "명령"})
        _, ma = self.route(toa.ADMIN, "POST", f"/api/office/kanban/tasks?board={BOARD}", {"title": "비공개 일", "assignee": "ma"})
        _, sa = self.route(toa.ADMIN, "POST", f"/api/office/kanban/tasks?board={BOARD}", {"title": "방 일", "assignee": "sa"})
        self.ma_task, self.sa_task = ma["task"]["id"], sa["task"]["id"]
        self.kdb = kanban_db(KDB)
        self.addCleanup(self.kdb.close)
        self.sdb = state_db("sa")
        self.addCleanup(self.sdb.close)
        self.addCleanup(shutil.rmtree, HOME / "kanban", True)
        self.addCleanup(lambda: [p.unlink() for p in (HOME / "profiles" / "sa").glob("state.db*")])
        self.clock = mock.patch.object(hub_auto, "_now_ts", return_value=NOW)
        self.clock.start()
        self.addCleanup(self.clock.stop)

    def run_row(self, task, profile="sa", ended=NOW - 3600):
        cur = self.kdb.execute("INSERT INTO task_runs (task_id, profile, status, started_at, ended_at) VALUES (?,?,?,?,?)",
                               (task, profile, "done" if ended else "running", int(NOW - 7200), None if ended is None else int(ended)))
        self.kdb.commit()
        return cur.lastrowid

    def link(self, run, *sids):
        for i, sid in enumerate(sids):
            self.kdb.execute("INSERT INTO aas_run_sessions VALUES (?,?,?)", (run, sid, NOW - 7000 + i))
        self.kdb.commit()

    def session(self, sid, *messages):
        self.sdb.execute("INSERT INTO sessions (id, source, started_at) VALUES (?,?,?)", (sid, "kanban", NOW - 7000))
        for m in messages:
            self.sdb.execute("INSERT INTO messages (session_id, role, content, tool_call_id, tool_calls, tool_name, timestamp) VALUES (?,?,?,?,?,?,?)",
                             (sid, m.get("role", "assistant"), m.get("content"), m.get("tool_call_id"),
                              json.dumps(m["calls"]) if "calls" in m else None, m.get("tool_name"), m.get("ts", NOW - 6000)))
        self.sdb.commit()

    def commands(self, run, task=None, who=toa.ADMIN):
        """거절(Fail)은 서버처럼 {"error","detail"} 본문으로. 접근 거절(Denied)은 그대로 올린다."""
        try:
            return self.route(who, "GET", f"/api/office/kanban/tasks/{task or self.sa_task}/runs/{run}/commands?board={BOARD}")
        except hub_auto.Fail as exc:
            return exc.status, {"error": exc.code, "detail": exc.detail}


class StateTest(CommandsBase):
    def test_끝나지_않은_실행은_running(self):
        run = self.run_row(self.sa_task, ended=None)
        self.link(run, "s1")
        self.session("s1", {"calls": [call("c1", "terminal", {"command": "ls"})]})
        st, out = self.commands(run)
        self.assertEqual((st, out["state"]), (200, "running"))
        self.assertEqual([c["command"] for c in out["commands"]], ["ls"])          # 도는 중에도 지금까지 쓴 명령은 보인다

    def test_명령이_있으면_ok_이고_id_순서(self):
        run = self.run_row(self.sa_task)
        self.link(run, "s1", "s2")                                                  # 압축으로 대화가 둘이 된 실행
        self.session("s1", {"calls": [call("c1", "terminal", {"command": "ls ./build"}), call("c2", "read_file", {"path": "a"})], "ts": 10.0},
                     {"role": "tool", "tool_call_id": "c1", "tool_name": "terminal", "content": "a b"})
        self.session("s2", {"calls": [call("c3", "terminal", {"command": "cat report.txt"})], "ts": 20.0})
        st, out = self.commands(run)
        self.assertEqual((st, out["state"], out["read_mode"], out["more"]), (200, "ok", "ro", False))
        self.assertEqual([(c["command"], c["time"], c["blocked"], c["truncated"]) for c in out["commands"]],
                         [("ls ./build", 10.0, False, False), ("cat report.txt", 20.0, False, False)])

    def test_끝난_지_10분_안이고_명령이_없으면_pending(self):
        run = self.run_row(self.sa_task, ended=NOW - 599)
        self.link(run, "s1")
        self.session("s1", {"role": "assistant", "content": "생각만 함"})
        self.assertEqual(self.commands(run)[1]["state"], "pending")
        run2 = self.run_row(self.sa_task, ended=NOW - 30)                           # 세션도 아직 안 보임
        self.assertEqual(self.commands(run2)[1]["state"], "pending")

    def test_10분이_지나고_세션은_있는데_터미널_호출이_없으면_none(self):
        run = self.run_row(self.sa_task, ended=NOW - 601)
        self.link(run, "s1")
        self.session("s1", {"calls": [call("c1", "read_file", {"path": "x"})]})
        self.assertEqual(self.commands(run)[1]["state"], "none")

    def test_10분이_지나도_세션이_없으면_lost(self):
        run = self.run_row(self.sa_task, ended=NOW - 601)
        self.link(run, "gone")                                                      # 짝은 있는데 대화 기록에 없음(지워짐)
        self.assertEqual(self.commands(run)[1]["state"], "lost")
        run2 = self.run_row(self.sa_task, ended=NOW - 601)                          # 짝 자체가 없음
        self.assertEqual(self.commands(run2)[1]["state"], "lost")

    def test_immutable_로_읽은_빈_목록은_none_lost_가_아니라_pending(self):
        run = self.run_row(self.sa_task, ended=NOW - 3600)
        self.link(run, "s1")
        self.session("s1", {"calls": [call("c1", "read_file", {"path": "x"})]})
        run2 = self.run_row(self.sa_task, ended=NOW - 3600)
        real = sqlite3.connect

        def connect(target, *a, **kw):
            if "mode=ro" in str(target):
                exc = sqlite3.OperationalError("unable to open database file")   # 실제 읽기 전용 마운트처럼 오류 코드를 단다
                exc.sqlite_errorcode, exc.sqlite_errorname = 14, "SQLITE_CANTOPEN"
                raise exc
            return real(target, *a, **kw)
        with mock.patch("aas.hermes.hermes_reader.sqlite3.connect", side_effect=connect):
            for r in (run, run2):
                out = self.commands(r)[1]
                self.assertEqual((out["state"], out["read_mode"]), ("pending", "immutable"))

    def test_aas_run_sessions_표가_없는_옛_이미지는_짝_없음으로(self):
        self.kdb.execute("DROP TABLE aas_run_sessions")
        self.kdb.commit()
        run = self.run_row(self.sa_task, ended=NOW - 601)
        st, out = self.commands(run)
        self.assertEqual((st, out["state"], out["commands"]), (200, "lost", []))
        run2 = self.run_row(self.sa_task, ended=NOW - 60)
        self.assertEqual(self.commands(run2)[1]["state"], "pending")

    def test_다른_카드의_실행이나_없는_실행은_404(self):
        other = self.run_row(self.ma_task, profile="ma")
        for run in (other, 9999):
            with self.subTest(run=run):
                st, out = self.commands(run)
                self.assertEqual((st, out.get("error")), (404, "run_not_found"))


class ListTest(CommandsBase):
    def test_201개면_200개와_more(self):
        run = self.run_row(self.sa_task)
        self.link(run, "s1")
        self.session("s1", *[{"calls": [call(f"c{i}", "terminal", {"command": f"echo {i}"})], "ts": float(i)} for i in range(201)])
        out = self.commands(run)[1]
        self.assertEqual((len(out["commands"]), out["more"]), (200, True))
        self.assertEqual((out["commands"][0]["command"], out["commands"][-1]["command"]), ("echo 0", "echo 199"))
        self.assertLess(200 + 1, hub_auto.DEFAULT_SIDECAR_MAX_ROWS)                 # M3: LIMIT 201 은 사이드카 max_rows(20,000)보다 작다

    def test_200개면_more_없음(self):
        run = self.run_row(self.sa_task)
        self.link(run, "s1")
        self.session("s1", *[{"calls": [call(f"c{i}", "terminal", {"command": f"echo {i}"})]} for i in range(200)])
        out = self.commands(run)[1]
        self.assertEqual((len(out["commands"]), out["more"]), (200, False))

    def test_앞_200자만_가리고_잘림_표시(self):
        run = self.run_row(self.sa_task)
        self.link(run, "s1")
        token = "sk-" + "A1b2C3d4" * 6
        long_cmd = "curl -H 'Authorization: Bearer " + token + "' https://x/ " + "--data a.b " * 40
        self.session("s1", {"calls": [call("c1", "terminal", {"command": long_cmd}), call("c2", "terminal", {"command": f"export OPENAI_API_KEY={token}"})]})
        cmds = self.commands(run)[1]["commands"]
        self.assertTrue(cmds[0]["truncated"])
        self.assertEqual(len(cmds[0]["command"]), 200)
        self.assertFalse(cmds[1]["truncated"])
        for c in cmds:
            self.assertNotIn(token, c["command"])
        self.assertEqual(cmds[1]["command"], hub_auto._mask_text(f"export OPENAI_API_KEY={token}"))   # 댓글·요약과 같은 가림

    def test_도구_결과가_BLOCKED_로_시작하면_막힘(self):
        run = self.run_row(self.sa_task)
        self.link(run, "s1")
        self.session("s1", {"calls": [call("c1", "terminal", {"command": "find ./build -delete"}), call("c2", "terminal", {"command": "ls"})]},
                     {"role": "tool", "tool_call_id": "c1", "tool_name": "terminal", "content": "BLOCKED: find -delete 는 무인 실행에서 막힙니다"},
                     {"role": "tool", "tool_call_id": "c2", "tool_name": "terminal", "content": "ok BLOCKED: 아님"})
        cmds = self.commands(run)[1]["commands"]
        self.assertEqual([(c["command"], c["blocked"]) for c in cmds], [("find ./build -delete", True), ("ls", False)])

    def test_터미널_도구의_JSON_결과에서_error_가_BLOCKED_면_막힘(self):
        # Hermes tools/terminal_tool.py _error_json 이 내는 실제 모양(2026-11-03 OKE 카나리아에서 확인). 출력에 BLOCKED: 가 섞인 것은 막힘이 아니다
        run = self.run_row(self.sa_task)
        self.link(run, "s1")
        blocked = json.dumps({"output": "", "exit_code": -1, "error": "BLOCKED: Command flagged as dangerous (find -delete) but ...",
                              "status": "blocked"}, ensure_ascii=False)
        printed = json.dumps({"output": "BLOCKED: 이건 출력", "exit_code": 0, "error": None}, ensure_ascii=False)
        self.session("s1", {"calls": [call("c1", "terminal", {"command": "find /srv/x -delete"}), call("c2", "terminal", {"command": "cat note"})]},
                     {"role": "tool", "tool_call_id": "c1", "tool_name": "terminal", "content": blocked},
                     {"role": "tool", "tool_call_id": "c2", "tool_name": "terminal", "content": printed})
        cmds = self.commands(run)[1]["commands"]
        self.assertEqual([(c["command"], c["blocked"]) for c in cmds], [("find /srv/x -delete", True), ("cat note", False)])

    def test_default_보드는_루트_kanban_db_와_루트_프로파일(self):
        self.route(toa.ADMIN, "POST", "/api/office/kanban/boards", {"slug": "default", "name": "기본"})
        _, t = self.route(toa.ADMIN, "POST", "/api/office/kanban/tasks?board=default", {"title": "기본 일", "assignee": "sa"})
        kdb = kanban_db(HOME / "kanban.db")
        self.addCleanup(lambda: [p.unlink() for p in HOME.glob("kanban.db*")])
        self.addCleanup(lambda: [p.unlink() for p in HOME.glob("state.db*")])
        self.addCleanup(kdb.close)
        run = kdb.execute("INSERT INTO task_runs (task_id, profile, status, started_at, ended_at) VALUES (?,?,?,?,?)",
                          (t["task"]["id"], "default", "done", int(NOW - 99), int(NOW - 9))).lastrowid
        kdb.execute("INSERT INTO aas_run_sessions VALUES (?,?,?)", (run, "r1", NOW - 90))
        kdb.commit()
        root = state_db("default")
        self.addCleanup(root.close)
        root.execute("INSERT INTO sessions (id, source, started_at) VALUES ('r1','kanban',1)")
        root.execute("INSERT INTO messages (session_id, role, tool_calls, timestamp) VALUES ('r1','assistant',?,5)",
                     (json.dumps([call("c1", "terminal", {"command": "pwd"})]),))
        root.commit()
        st, out = self.route(toa.ADMIN, "GET", f"/api/office/kanban/tasks/{t['task']['id']}/runs/{run}/commands?board=default")
        self.assertEqual((st, [c["command"] for c in out["commands"]]), (200, ["pwd"]))


class AccessTest(CommandsBase):
    def test_보이지_않는_자리의_카드는_거절(self):
        run = self.run_row(self.ma_task, profile="ma")
        with self.assertRaises(office_access.Denied):
            self.commands(run, task=self.ma_task, who=toa.C)

    def test_구성원인_방의_자리_카드는_읽는다(self):
        run = self.run_row(self.sa_task)
        st, out = self.commands(run, who=toa.C)
        self.assertEqual((st, out["state"]), (200, "lost"))


class LocalReadModeTest(unittest.TestCase):
    """로컬 읽기(hermes_reader._connect_read)도 사이드카와 같은 규칙: 열기·IO 계열 오류만 immutable 로 다시 연다(스펙 2026-11-03-002 D3·D9·D10)."""

    def setUp(self):
        import tempfile
        from pathlib import Path
        self.tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp, True)

    def test_busy_is_raised_not_read_as_immutable(self):
        from aas.hermes import hermes_reader as hr
        db = self.tmp / "busy.db"
        writer = sqlite3.connect(db, timeout=0)
        self.addCleanup(writer.close)
        writer.execute("CREATE TABLE t (x)")
        writer.commit()
        writer.execute("PRAGMA locking_mode=EXCLUSIVE")
        writer.execute("BEGIN EXCLUSIVE")
        with self.assertRaises(sqlite3.OperationalError):
            hr._connect_read(db)

    def test_read_only_folder_falls_back_to_immutable(self):
        import os
        from aas.hermes import hermes_reader as hr
        if hasattr(os, "geteuid") and os.geteuid() == 0:
            self.skipTest("root 는 읽기 전용 폴더에도 쓸 수 있다")
        ro = self.tmp / "ro"
        ro.mkdir()
        conn = sqlite3.connect(ro / "w.db")
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("CREATE TABLE t (x)")
        conn.execute("INSERT INTO t VALUES (5)")
        conn.commit()
        conn.close()
        ro.chmod(0o555)
        self.addCleanup(ro.chmod, 0o755)
        got, mode = hr._connect_read(ro / "w.db")
        self.addCleanup(got.close)
        self.assertEqual((got.execute("SELECT x FROM t").fetchall()[0][0], mode), (5, "immutable"))


if __name__ == "__main__":
    unittest.main()

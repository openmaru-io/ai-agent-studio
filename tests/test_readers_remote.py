# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""원격 읽기 백엔드 — RemotePath 가 pathlib 과 같은 답을 내고, 읽기 함수들이 로컬·원격에서 같은 결과를 낸다(이중 실행)."""
import aasserver  # 실제 uvicorn 앱을 띄우는 시험 하네스(OMAI-1100)
import json
import re
import os
import socket
import sqlite3
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path, PurePosixPath
from unittest import mock

TMP = tempfile.TemporaryDirectory()
os.environ.setdefault("AAS_DATA_DIR", str(Path(TMP.name) / "data"))
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "sidecar"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from aas_sidecar import ops as sc_ops, server as sc_server  # noqa: E402

from aas.hermes.readers import remote  # noqa: E402
from test_aas import NOW, make_home  # noqa: E402

TOKEN = "dual-run-token-0123456789"


def add_state_db(home: Path) -> None:
    """활동·실행 기록 시험용 세션 DB 를 프로파일 둘에 만든다."""
    for rel in ("state.db", "profiles/alpha/state.db"):
        db = sqlite3.connect(home / rel)
        db.executescript("""
          CREATE TABLE sessions (id TEXT PRIMARY KEY, source TEXT, model TEXT, started_at REAL, last_activity_at REAL,
            message_count INTEGER, tool_call_count INTEGER, input_tokens INTEGER, output_tokens INTEGER);
          CREATE TABLE messages (id INTEGER PRIMARY KEY, session_id TEXT, tool_calls TEXT);""")
        t = NOW.timestamp()
        rows = [("cron_j1_20261004_090000", "cron", "m-main", t - 3600, t - 3500, 4, 2, 1000, 200),
                ("s2", "telegram", "m-main", t - 7200, t - 7000, 9, 1, 3000, 400),
                ("s3", "cli", "", t - 86400 * 3, t - 86400 * 3 + 60, 2, 0, 50, 10)]
        db.executemany("INSERT INTO sessions VALUES (?,?,?,?,?,?,?,?,?)", rows)
        calls = json.dumps([{"function": {"name": "mcp_OMDM_create_page", "arguments": "{\"a\": 1}"}}])
        db.execute("INSERT INTO messages (session_id, tool_calls) VALUES ('cron_j1_20261004_090000', ?)", (calls,))
        db.commit()
        db.close()


def add_libraries(home: Path) -> None:
    """파이썬 환경(site-packages 안의 dist-info)과 Node 패키지를 만들어 원격 글롭 경로(`**/site-packages`, `mcp/*/package.json`)를 탄다."""
    site = home / "profiles" / "alpha" / ".venvs" / "tools" / "lib" / "python3.12" / "site-packages"
    (site / "requests-2.31.0.dist-info").mkdir(parents=True)
    (site / "requests-2.31.0.dist-info" / "top_level.txt").write_text("requests\n", encoding="utf-8")
    pkg = home / "profiles" / "alpha" / "mcp" / "crm"
    (pkg / "node_modules" / "lodash").mkdir(parents=True)
    (pkg / "package.json").write_text(json.dumps({"dependencies": {"lodash": "^4", "left-pad": "^1"}}), encoding="utf-8")
    (pkg / "node_modules" / "lodash" / "package.json").write_text(json.dumps({"version": "4.17.21"}), encoding="utf-8")
    script = home / "profiles" / "alpha" / "scripts" / "run.sh"
    script.parent.mkdir(parents=True, exist_ok=True)
    script.write_text("#!/bin/sh\necho hi\n", encoding="utf-8")
    script.chmod(0o755)
    add_dependency_dirs(home)


def add_dependency_dirs(home: Path) -> None:
    """건너뛰는 의존성 폴더(스펙 2026-11-03-003 D9). `.hermes/.venv` 아래 라이브러리는 그대로 보여야 하고, 스킬 안 node_modules 의
    파일은 스킬 파일·사용처에서 빠져야 한다. secrets 참조 찾기 길도 타게 한다."""
    site = home / "profiles" / "alpha" / ".hermes" / ".venv" / "lib" / "python3.12" / "site-packages" / "six-1.16.0.dist-info"
    site.mkdir(parents=True)
    (site / "top_level.txt").write_text("six\n", encoding="utf-8")
    (home / "secrets").mkdir(exist_ok=True)
    (home / "secrets" / "deploy.json").write_text('{"token": "x"}', encoding="utf-8")
    (home / "secrets" / "mail.json").write_text('{"token": "y"}', encoding="utf-8")
    deps = home / "skills" / "ops" / "deps"
    (deps / "node_modules" / "p").mkdir(parents=True)
    (deps / "SKILL.md").write_text("---\nname: deps\ndescription: 의존성\n---\n본문\n", encoding="utf-8")
    (deps / "node_modules" / "p" / "a.js").write_text("read('secrets/deploy.json')\n", encoding="utf-8")
    mail = home / "skills" / "ops" / "mail"
    mail.mkdir(parents=True)
    (mail / "SKILL.md").write_text("---\nname: mail\ndescription: 메일\n---\nsecrets/mail.json 를 읽는다\n", encoding="utf-8")


class RemoteBase(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.local = make_home(Path(cls.tmp.name))
        add_state_db(cls.local)
        add_libraries(cls.local)
        cls.httpd = sc_server.make_server("127.0.0.1", 0, sc_ops.Ops(cls.local), TOKEN)
        threading.Thread(target=cls.httpd.serve_forever, daemon=True).start()
        cls.backend = remote.RemoteBackend(f"http://127.0.0.1:{cls.httpd.server_port}", TOKEN, label="t")
        cls.remote = remote.RemotePath(cls.backend, "")

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()
        cls.tmp.cleanup()


class SidecarDownMemoTest(unittest.TestCase):
    """사이드카가 가벼운 연산에 시간 초과를 내면 잠시 「응답 없음」으로 기억해 다른 호출이 10초씩 기다리지 않는다
    (스펙 2026-10-24-002 R4·검토 D4). OMAI-1459 때 프로파일마다 읽기가 10초씩 걸려 채팅 목록 하나가 40초를 넘겼다."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        home = make_home(Path(self.tmp.name))
        self.slow = {"stat": threading.Event(), "tree": threading.Event(), "read": threading.Event()}   # 이벤트가 서 있지 않으면 그 연산이 멈춘다
        self.calls = []
        test = self

        class Slow(sc_ops.Ops):
            def stat(self, rel):
                test.calls.append("stat")
                test.slow["stat"].wait(2)
                return super().stat(rel)

            def tree(self, *a, **kw):
                test.calls.append("tree")
                test.slow["tree"].wait(2)
                return super().tree(*a, **kw)

            def read(self, paths):
                test.calls.append("read")
                test.slow["read"].wait(2)
                return super().read(paths)
        self.httpd = sc_server.make_server("127.0.0.1", 0, Slow(home), TOKEN)
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()
        self.addCleanup(self.httpd.server_close)
        self.addCleanup(self.httpd.shutdown)
        self.addCleanup(lambda: [e.set() for e in self.slow.values()])
        self.backend = remote.RemoteBackend(f"http://127.0.0.1:{self.httpd.server_port}", TOKEN, timeout=0.3, label="t", fail_memo=30.0)
        tree_limit = mock.patch.object(remote, "TREE_TIMEOUT", 0.3)   # 묶음도 짧은 한도로 — 묶음이 끊긴 뒤의 동작을 본다
        tree_limit.start()
        self.addCleanup(tree_limit.stop)

    def test_가벼운_연산이_시간_초과면_시험_호출_하나만_가고_나머지는_바로_실패한다(self):
        with self.assertRaises(remote.SidecarError):
            self.backend.stat_now("config.yaml")                  # 0.3초 시간 초과 → 기억
        trial = threading.Thread(target=lambda: self._quiet(self.backend.stat_now, "config.yaml"), daemon=True)
        trial.start()                                         # 시험 호출 하나는 사이드카로 간다
        time.sleep(0.05)
        began = time.monotonic()
        with self.assertRaises(remote.SidecarError):
            self.backend.list_now("", "*")
        self.assertLess(time.monotonic() - began, 0.1)
        trial.join(2)
        self.assertEqual(self.calls, ["stat", "stat"])

    def test_시험_호출이_성공하면_기억이_풀린다(self):
        with self.assertRaises(remote.SidecarError):
            self.backend.stat_now("config.yaml")
        self.slow["stat"].set()                               # 사이드카가 돌아왔다
        self.assertTrue(self.backend.stat_now("config.yaml"))     # 시험 호출
        self.assertTrue(self.backend.stat_now("config.yaml"))     # 기억이 풀려 그대로 간다
        self.assertEqual(self.calls.count("stat"), 3)

    def test_tree_시간_초과는_기억하지_않는다(self):
        self.slow["stat"].set()
        self.assertFalse(self.backend.snapshot())             # tree 가 늦어 묶음을 못 받는다 — 하나씩 묻는 길로
        self.assertTrue(self.backend.stat_now("config.yaml"))     # 가벼운 읽기는 그대로 사이드카로 간다
        self.assertEqual(self.calls, ["tree", "stat"])

    def test_여러_파일을_묶은_read_시간_초과는_기억하지_않는다(self):
        """묶음 read 는 합계가 크면 사이드카에서 tree 와 같은 무거운 잠금 뒤에 줄 선다(R20). 늦었다고 「응답 없음」을 켜면
        멀쩡한 사이드카의 작은 읽기가 30초 동안 모두 실패했다(스펙 2026-10-24-002 외부 검토 4)."""
        with self.assertRaises(remote.SidecarError):
            self.backend.read(["config.yaml", "SOUL.md"])
        self.assertEqual(self.backend._down_at, 0.0)

    def test_파일_하나_read_시간_초과는_기억한다(self):
        with self.assertRaises(remote.SidecarError):
            self.backend.read(["config.yaml"])
        self.assertGreater(self.backend._down_at, 0.0)

    def test_tree_가_실패하면_잠시_다시_받지_않고_하나씩_묻는다(self):
        """tree 잠금 뒤에 줄 선 스레드가 저마다 tree 를 다시 받아 기다림이 N × 10초가 됐다(스펙 2026-10-24-002 R13).
        실패를 잠시 기억해 그동안은 묶음 없이 하나씩 묻는다 — 검토 D4 로 tree 시간 초과는 「응답 없음」 기억을 켜지 않는다."""
        self.slow["stat"].set()
        self.assertFalse(self.backend.snapshot())
        began = time.monotonic()
        self.assertFalse(self.backend.snapshot())             # 사이드카에 tree 를 또 보내지 않는다
        self.assertLess(time.monotonic() - began, 0.1)
        self.assertEqual(self.calls, ["tree"])

    @staticmethod
    def _quiet(fn, *a):
        try:
            fn(*a)
        except remote.SidecarError:
            pass


class RemoteBatchReadTest(unittest.TestCase):
    """스킬이 많은 Hermes 에서 자격증명 목록이 파일마다 사이드카를 부르면 느리다(OKE 실측: read 310회, 10초). 묶어서 읽는다."""

    def test_자격증명_수집은_파일마다_왕복하지_않고_묶어서_읽는다(self):
        from aas.assets import inventory
        with tempfile.TemporaryDirectory() as tmp:
            home = make_home(Path(tmp))
            for i in range(12):
                d = home / "skills" / "bulk" / f"s{i}"
                d.mkdir(parents=True)
                (d / "SKILL.md").write_text(f"# s{i}\nuses OPENAI_API_KEY and TOKEN_{i}\n", encoding="utf-8")
                (d / "run.py").write_text(f"print('TOKEN_{i}')\n", encoding="utf-8")
            httpd = sc_server.make_server("127.0.0.1", 0, sc_ops.Ops(home), TOKEN)
            threading.Thread(target=httpd.serve_forever, daemon=True).start()
            try:
                backend = remote.RemoteBackend(f"http://127.0.0.1:{httpd.server_port}", TOKEN, label="t")
                calls = []
                orig = backend.read
                backend.read = lambda rels: (calls.append(len(rels)), orig(rels))[1]
                got = inventory.credentials(remote.RemotePath(backend, ""))
                want = inventory.credentials(home)
                self.assertEqual([(i["name"], i["used_by"]) for i in got["items"]], [(i["name"], i["used_by"]) for i in want["items"]])
                self.assertLessEqual(len(calls), 4, f"read 왕복 {len(calls)}회: {calls}")
                self.assertGreaterEqual(sum(calls), 24)                        # 묶었어도 스킬 파일은 모두 읽었다
            finally:
                httpd.shutdown()
                httpd.server_close()


class ChannelsBatchReadTest(unittest.TestCase):
    """채널 상태 모으기가 프로파일마다 파일 4개를 하나씩 읽어, 사이드카가 늦으면 프로파일 3개에 40초가 넘었다(OMAI-1459).
    필요한 파일을 모아 사이드카 read 한 번으로 읽는다(스펙 2026-10-24-002 R5)."""

    def test_채널_모으기는_read_를_한_번만_부르고_결과는_로컬과_같다(self):
        from aas.ops import channels
        with tempfile.TemporaryDirectory() as tmp:
            home = make_home(Path(tmp))
            for name in ("ch-one", "ch-two"):
                d = home / "profiles" / name
                (d / "cron").mkdir(parents=True, exist_ok=True)
                (d / "config.yaml").write_text("platforms:\n  telegram:\n    enabled: true\n", encoding="utf-8")
                (d / ".env").write_text("SLACK_BOT_TOKEN=x\n", encoding="utf-8")
                (d / "gateway_state.json").write_text(json.dumps({"gateway_state": "running", "pid": 7}), encoding="utf-8")
            httpd = sc_server.make_server("127.0.0.1", 0, sc_ops.Ops(home), TOKEN)
            threading.Thread(target=httpd.serve_forever, daemon=True).start()
            try:
                backend = remote.RemoteBackend(f"http://127.0.0.1:{httpd.server_port}", TOKEN, label="t")
                calls = []
                orig = backend._call
                backend._call = lambda m, path, body=None, timeout=None: (calls.append(path), orig(m, path, body, timeout))[1]
                got = channels.collect(remote.RemotePath(backend, ""))
                self.assertEqual(got, channels.collect(home))
                self.assertEqual(calls.count("/v1/read"), 1, calls)
                self.assertLessEqual(len(calls), 4, calls)            # 프로파일 목록(stat·list) + read 한 번. 고치기 전 33번
            finally:
                httpd.shutdown()
                httpd.server_close()


class RemoteTreeSkipsTokenFilesTest(unittest.TestCase):
    """MCP OAuth 토큰 파일(mcp-tokens/*.json, 리프레시 토큰 포함)의 내용은 폴더 묶음(tree)으로 AAS 에 오지 않는다(스펙 2026-10-16-010 12절 O3·D29).
    있는지는 따로 묻는 목록으로 계속 볼 수 있다(이름·크기·시각만)."""

    def test_tree_bundle_does_not_carry_token_file_contents(self):
        with tempfile.TemporaryDirectory() as tmp:
            home = make_home(Path(tmp))
            secret = "REFRESH-TOKEN-must-not-leave-the-pod"
            for d in (home / "mcp-tokens", home / "profiles" / "alpha" / "mcp-tokens"):
                d.mkdir(parents=True, exist_ok=True)
                (d / "jira.json").write_text(json.dumps({"access_token": "a", "refresh_token": secret}), encoding="utf-8")
            httpd = sc_server.make_server("127.0.0.1", 0, sc_ops.Ops(home), TOKEN)
            threading.Thread(target=httpd.serve_forever, daemon=True).start()
            try:
                backend = remote.RemoteBackend(f"http://127.0.0.1:{httpd.server_port}", TOKEN, label="t")
                self.assertTrue(backend.snapshot())
                tree = backend.current_tree()
                held = b"".join(tree.content(p) for p in tree.data)          # AAS 가 묶음으로 들고 있는 파일 내용(압축을 푼 것)
                self.assertNotIn(secret.encode(), held)
                self.assertNotIn("mcp-tokens/jira.json", tree.data)
                self.assertNotIn("profiles/alpha/mcp-tokens/jira.json", tree.data)
                names = sorted(p.name for p in (remote.RemotePath(backend, "") / "mcp-tokens").iterdir())
                self.assertEqual(names, ["jira.json"])                      # 있는지는 계속 보인다
            finally:
                httpd.shutdown()
                httpd.server_close()


class RemoteMcpListTest(unittest.TestCase):
    """도구 화면의 MCP 서버 목록(inventory.tools 의 mcp)이 사이드카 원격 홈에서도 로컬과 같다(OMAI-1249). 깨진 항목도 같은 방식으로 건너뛴다."""

    def test_mcp_servers_through_the_sidecar_match_local(self):
        from aas.assets import inventory
        with tempfile.TemporaryDirectory() as tmp:
            home = make_home(Path(tmp))
            (home / "profiles" / "mcpz").mkdir(parents=True)
            (home / "profiles" / "mcpz" / "config.yaml").write_text(
                "mcp_servers:\n  docs:\n    url: https://h.io/s/Abcdef0123456789TOKENxyz/mcp\n    headers:\n      Authorization: Bearer abcdefghijklmnop\n  bad: nope\n", encoding="utf-8")
            httpd = sc_server.make_server("127.0.0.1", 0, sc_ops.Ops(home), TOKEN)
            threading.Thread(target=httpd.serve_forever, daemon=True).start()
            try:
                backend = remote.RemoteBackend(f"http://127.0.0.1:{httpd.server_port}", TOKEN, label="t")
                got, want = inventory.tools(remote.RemotePath(backend, "")), inventory.tools(home)
                self.assertEqual(got["mcp"], want["mcp"])
                self.assertEqual([r["id"] for r in got["mcp"]], ["default:OMDM", "default:my-crm", "mcpz:docs"])      # make_home 의 기본 설정에 서버 둘이 이미 있다
                self.assertEqual(got["mcp_skipped"], want["mcp_skipped"])
                self.assertEqual(got["mcp_skipped"], [{"profile": "mcpz", "reason": "partial"}])
                self.assertEqual(next(r for r in got["mcp"] if r["id"] == "mcpz:docs")["target"], "https://h.io/…")
                self.assertNotIn("TOKENxyz", json.dumps(got["mcp"]))
            finally:
                httpd.shutdown()
                httpd.server_close()


class RemotePathParityTest(RemoteBase):
    def pair(self, rel):
        return self.local / rel, self.remote / rel

    def test_existence_and_kind(self):
        for rel in ("config.yaml", "profiles", "profiles/alpha/cron/jobs.json", "nope", "skills/ops/report/SKILL.md", ""):
            lp, rp = self.pair(rel)
            with self.subTest(rel=rel):
                self.assertEqual((rp.exists(), rp.is_file(), rp.is_dir()), (lp.exists(), lp.is_file(), lp.is_dir()))

    def test_names_and_relatives(self):
        lp, rp = self.pair("skills/ops/report/SKILL.md")
        self.assertEqual((rp.name, rp.suffix, rp.stem, rp.parent.name), (lp.name, lp.suffix, lp.stem, lp.parent.name))
        self.assertEqual(str(rp.relative_to(self.remote)), str(lp.relative_to(self.local)))
        self.assertIsInstance(rp.relative_to(self.remote), PurePosixPath)
        self.assertEqual([p.name for p in rp.parents][:3], [p.name for p in lp.parents][:3])
        self.assertIn(self.remote, rp.parents)
        self.assertEqual(self.remote.parent, self.remote)                         # 루트의 부모는 루트

    def test_join_equality_and_ordering(self):
        a, b = self.remote / "profiles" / "alpha", self.remote.joinpath("profiles", "alpha")
        self.assertEqual(a, b)
        self.assertEqual(hash(a), hash(b))
        self.assertEqual(sorted([self.remote / "b", self.remote / "a"])[0].name, "a")
        with self.assertRaises(ValueError):
            self.remote / "/etc/passwd"

    def test_read_text_bytes_and_errors(self):
        lp, rp = self.pair("config.yaml")
        self.assertEqual(rp.read_text(encoding="utf-8"), lp.read_text(encoding="utf-8"))
        self.assertEqual(rp.read_bytes(), lp.read_bytes())
        bad = self.local / "latin.txt"
        bad.write_bytes(b"caf\xe9")
        self.assertEqual((self.remote / "latin.txt").read_text(encoding="utf-8", errors="replace"), "caf�")
        with self.assertRaises(FileNotFoundError):
            (self.remote / "nope.txt").read_text()
        with self.assertRaises(IsADirectoryError):
            (self.remote / "profiles").read_text()

    def test_stat(self):
        lp, rp = self.pair("config.yaml")
        self.assertEqual(rp.stat().st_size, lp.stat().st_size)
        self.assertAlmostEqual(rp.stat().st_mtime, lp.stat().st_mtime, places=3)
        with self.assertRaises(FileNotFoundError):
            (self.remote / "nope").stat()

    def test_iterdir_glob_rglob_match_pathlib(self):
        for rel, kind, pattern in (("profiles", "iterdir", None), ("", "glob", "*.yaml"),
                                   ("skills", "rglob", "SKILL.md"), ("profiles", "glob", "*/cron/*.json"),
                                   ("", "glob", "**/jobs.json")):
            lp, rp = self.pair(rel)
            call = (lambda p: list(p.iterdir())) if kind == "iterdir" else (lambda p, k=kind, pat=pattern: list(getattr(p, k)(pat)))
            with self.subTest(rel=rel, kind=kind, pattern=pattern):
                want = sorted(str(p.relative_to(self.local)) for p in call(lp))
                got = sorted(str(p.relative_to(self.remote)) for p in call(rp))
                self.assertEqual(got, want)

    def test_iterdir_of_missing_dir_raises_and_glob_is_empty(self):
        with self.assertRaises(FileNotFoundError):
            list((self.remote / "nope").iterdir())
        self.assertEqual(list((self.remote / "nope").glob("*")), [])

    def test_listing_primes_stat_cache_so_is_file_costs_no_extra_request(self):
        calls = []
        orig = self.backend._call
        with mock.patch.object(self.backend, "_call", side_effect=lambda *a, **k: (calls.append(a[1]), orig(*a, **k))[1]):
            self.backend.invalidate()
            kids = list((self.remote / "profiles").iterdir())
            n = len(calls)
            [k.is_dir() for k in kids]
        self.assertEqual(len(calls), n)                                           # is_dir 는 목록에서 받은 값을 쓴다

    def test_resolve_and_containment_check_work_like_files_py(self):
        home = self.remote.resolve()
        inside = (self.remote / "profiles/alpha/../beta/config.yaml").resolve()
        self.assertIn(home, inside.parents)
        outside = (self.remote / "../etc/passwd").resolve()
        self.assertNotIn(home, outside.parents)                                    # 밖으로 나간 경로는 root 아래로 치지 않는다
        with self.assertRaises(OSError):
            outside.read_text()

    def test_backend_failures_become_oserror(self):
        dead = remote.RemotePath(remote.RemoteBackend("http://127.0.0.1:9", TOKEN, timeout=1, label="dead"), "")
        with self.assertRaises(OSError):
            dead.is_dir()
        wrong = remote.RemotePath(remote.RemoteBackend(self.backend.url, "wrong-token-0123456789", label="w"), "")
        with self.assertRaises(PermissionError):
            wrong.exists()

    def test_str_does_not_look_like_a_local_absolute_path(self):
        self.assertTrue(str(self.remote / "x").startswith("t:"))


class KeepAliveTest(RemoteBase):
    """사이드카 연결 재사용 — 호출마다 이름 조회·연결을 새로 하면 DNS 패킷 하나만 사라져도 glibc 가 5초를 기다린다(OMAI-1102)."""

    def fresh(self):
        b = remote.RemoteBackend(self.backend.url, TOKEN, label="k")
        b._has_tree = False                                  # 하나씩 묻는 호출만 센다
        return b

    def count_connects(self):
        import http.client
        orig, seen = http.client.HTTPConnection.connect, []

        def counted(conn):
            seen.append(1)
            return orig(conn)
        return mock.patch.object(http.client.HTTPConnection, "connect", counted), seen

    def test_calls_from_one_thread_share_one_connection(self):
        b, (patch, seen) = self.fresh(), self.count_connects()
        with patch:
            for _ in range(20):
                b._call("POST", "/v1/stat", {"path": "config.yaml"})
        self.assertEqual(len(seen), 1)

    def test_connection_closed_by_the_sidecar_is_reopened_once(self):
        b = self.fresh()
        b._call("POST", "/v1/stat", {"path": "config.yaml"})
        mine, peer = socket.socketpair()                     # 쉬던 연결을 사이드카가 닫은 상태(보내도 답 없이 끊긴다)
        peer.close()
        b._local.conn.sock.close()
        b._local.conn.sock = mine
        self.assertTrue(b._call("POST", "/v1/stat", {"path": "config.yaml"})["exists"])

    def test_error_response_and_long_idle_do_not_break_the_next_call(self):
        b, (patch, seen) = self.fresh(), self.count_connects()
        with patch:
            with self.assertRaises(FileNotFoundError):       # 사이드카는 오류 응답 뒤에 연결을 닫는다
                b._call("POST", "/v1/nope", {})
            self.assertTrue(b._call("POST", "/v1/stat", {"path": "config.yaml"})["exists"])
            b._local.used -= remote.IDLE_REUSE + 1            # 오래 쉰 연결은 쓰지 않고 새로 연다
            self.assertTrue(b._call("POST", "/v1/stat", {"path": "config.yaml"})["exists"])
        self.assertEqual(len(seen), 3)

    def average_call(self, nagle: bool) -> float:
        """사이드카가 Nagle 을 켠 채(옛 사이드카) 또는 끈 채로 연결을 다시 쓸 때 호출 하나의 평균 시간."""
        handler = self.httpd.RequestHandlerClass
        before = handler.disable_nagle_algorithm
        handler.disable_nagle_algorithm = not nagle
        try:
            b = self.fresh()
            b._call("POST", "/v1/stat", {"path": "config.yaml"})   # 새로 연 연결의 첫 응답은 바로 ACK 된다 — 다시 쓰는 연결만 잰다
            t = time.monotonic()
            for _ in range(20):
                b._call("POST", "/v1/stat", {"path": "config.yaml"})
            return (time.monotonic() - t) / 20
        finally:
            handler.disable_nagle_algorithm = before

    def test_sidecar_sends_the_body_without_waiting_for_an_ack(self):
        # 머리와 본문을 두 번에 보내므로, Nagle 이 켜져 있으면 본문이 머리의 ACK(지연 ACK, 리눅스 40ms)를 기다린다(OKE 실측 15→57ms)
        self.assertIs(sc_server.make_server("127.0.0.1", 0, sc_ops.Ops(self.local), TOKEN).RequestHandlerClass.disable_nagle_algorithm, True)
        self.assertLess(self.average_call(nagle=False), 0.02)

    @unittest.skipUnless(hasattr(socket, "TCP_QUICKACK"), "지연 ACK 를 끄는 소켓 옵션은 리눅스에만 있다")
    def test_old_sidecar_with_nagle_is_still_fast_because_the_client_acks_at_once(self):
        self.assertLess(self.average_call(nagle=True), 0.02)

    def test_new_connection_reuses_the_looked_up_address(self):
        # 오래 쉬어 새로 여는 연결도 DNS 를 다시 묻지 않는다(OKE 실측: 사이드카 이름 조회 5.01초, OMAI-1108)
        from aas.common import netcache
        netcache.clear()
        b = remote.RemoteBackend(self.backend.url.replace("127.0.0.1", "localhost"), TOKEN, label="dns")
        real, seen = socket.getaddrinfo, []

        def counted(host, *a, **k):
            seen.append(host)
            return real(host, *a, **k)
        with mock.patch.object(netcache.socket, "getaddrinfo", counted):
            b._call("POST", "/v1/stat", {"path": "config.yaml"})
            b._local.used -= remote.IDLE_REUSE + 1
            b._call("POST", "/v1/stat", {"path": "config.yaml"})
        self.assertEqual(seen, ["localhost"])

    def test_threads_do_not_share_a_connection(self):
        b, conns = self.fresh(), []

        def work():
            b._call("POST", "/v1/stat", {"path": "config.yaml"})
            conns.append(b._local.conn)
        threads = [threading.Thread(target=work) for _ in range(3)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        self.assertEqual(len({id(c) for c in conns}), 3)


class RemoteSqliteParityTest(RemoteBase):
    def test_rows_match_sqlite3_row(self):
        sql = "SELECT id, status, claimed_at FROM executions ORDER BY id"
        db = "profiles/alpha/cron/executions.db"
        lconn = sqlite3.connect(f"file:{self.local / db}?immutable=1", uri=True)
        lconn.row_factory = sqlite3.Row
        want = [tuple(r) for r in lconn.execute(sql)]
        rconn = remote.connect(self.remote / db)
        got = rconn.execute(sql).fetchall()
        self.assertEqual([tuple(r) for r in got], want)
        self.assertEqual(got[0]["id"], "e1")
        self.assertEqual(got[0][1], got[0]["status"])
        self.assertEqual(dict(got[0]), dict(lconn.execute(sql).fetchone()))
        self.assertEqual(sorted(got[0].keys()), ["claimed_at", "id", "status"])
        lconn.close()
        rconn.close()

    def test_fetchone_iteration_unpack_and_params(self):
        conn = remote.connect(self.remote / "state.db")
        n = conn.execute("SELECT COUNT(*) FROM sessions").fetchone()[0]
        self.assertEqual(n, 3)
        for sid, src in conn.execute("SELECT id, source FROM sessions WHERE source = ?", ("cron",)):
            self.assertEqual((sid, src), ("cron_j1_20261004_090000", "cron"))
        self.assertIsNone(conn.execute("SELECT id FROM sessions WHERE id = ?", ("zzz",)).fetchone())
        self.assertEqual({r["name"] for r in conn.execute("PRAGMA table_info(sessions)")} >= {"source", "started_at"}, True)

    def test_sqlite_errors_surface_as_sqlite3_error(self):
        conn = remote.connect(self.remote / "state.db")
        with self.assertRaises(sqlite3.Error):
            conn.execute("SELECT * FROM no_such_table")
        with self.assertRaises(sqlite3.Error):
            conn.execute("DELETE FROM sessions")
        with self.assertRaises(sqlite3.Error):
            remote.connect(self.remote / "nope.db").execute("SELECT 1")
        dead = remote.RemotePath(remote.RemoteBackend("http://127.0.0.1:9", TOKEN, timeout=1, label="dead"), "state.db")
        with self.assertRaises(sqlite3.Error):
            remote.connect(dead).execute("SELECT 1")

    def test_blob_roundtrip(self):
        db = sqlite3.connect(self.local / "blob.db")
        db.execute("CREATE TABLE t (b BLOB)")
        db.execute("INSERT INTO t VALUES (?)", (b"\x00\xff",))
        db.commit()
        db.close()
        self.assertEqual(remote.connect(self.remote / "blob.db").execute("SELECT b FROM t").fetchone()[0], b"\x00\xff")


class DualRunTest(RemoteBase):
    """같은 픽스처를 로컬 Path 와 RemotePath 로 읽어 결과가 같아야 한다(R11-2)."""

    def norm(self, obj, home):
        """호스트 경로 표기와 수집 시각만 지운다. 나머지 모든 값이 같아야 한다.
        로컬·원격 두 번 수집하는 사이에 시각이 넘어가면 `collected_at`·`built_at`(흐름 그래프를 만든 시각) 이 달라져 간헐적으로 실패했다."""
        text = json.dumps(obj, ensure_ascii=False, sort_keys=True, default=str)
        text = re.sub(r'("(?:collected_at|built_at)": ")[^"]*"', r'\1<T>"', text)
        return text.replace(str(self.local), "<H>").replace(str(home), "<H>")

    def both(self, fn, *args, **kwargs):
        want = fn(*args, home=self.local, **kwargs)
        got = fn(*args, home=self.remote, **kwargs)
        self.assertEqual(self.norm(got, self.remote), self.norm(want, self.local))
        return want

    def test_profiles_mcp_names_and_skill_files(self):
        from aas.hermes import hermes_reader as hr
        want = [(p.name) for p in hr.profiles(self.local)]
        self.assertEqual([p.name for p in hr.profiles(self.remote)], want)
        self.assertEqual(hr.mcp_server_names(self.remote), hr.mcp_server_names(self.local))
        self.assertEqual(sorted((n, str(p.relative_to(self.remote))) for n, p in hr.skill_files(self.remote)),
                         sorted((n, str(p.relative_to(self.local))) for n, p in hr.skill_files(self.local)))
        self.assertNotIn(".curator_backups", " ".join(str(p) for _, p in hr.skill_files(self.remote)))

    def test_cron_health(self):
        from aas.ops import cron_health
        want = self.both(cron_health.collect, now=NOW)
        self.assertTrue(want["incidents"])                                         # 비어 있는 결과끼리 같은 것이 아니다

    def test_activity(self):
        from aas.ops import activity
        # activity.collect 는 실제 현재 시각으로 7일 창을 계산한다. 시험 데이터는 NOW 기준이라, 시각을 고정하지 않으면 며칠 뒤부터
        # 세션이 창 밖이 되어 깨진다(2026-10-11 에 실제로 깨졌다).
        with mock.patch.object(activity.time, "time", return_value=NOW.timestamp()):
            want = self.both(activity.collect, 7)
        self.assertGreater(want["profiles"][0]["sessions"], 0)

    def test_observed(self):
        from aas.ops import observed
        # observed.collect 도 실제 현재 시각으로 14일 창을 계산한다. test_activity 와 같이 시각을 고정한다(2026-10-18 에 창 밖이 되어 깨졌다)
        with mock.patch.object(observed.time, "time", return_value=NOW.timestamp()):
            want = self.both(observed.collect)
        self.assertIn("alpha/j1", want["jobs"])

    def test_models_without_network(self):
        from aas.ops import models
        gw = {"url": "x", "reachable": False, "auth": "no_key", "key_source": "", "models": [], "error": "시험"}
        with mock.patch.object(models, "fetch_litellm", return_value=gw), \
             mock.patch.dict(os.environ, {"AAS_LITELLM_URL": "http://127.0.0.1:14400"}):
            self.both(models.collect, {"failed_jobs": [], "incidents": []})

    def test_inventory_credentials_tools_libraries(self):
        from aas.assets import inventory
        os.environ.setdefault("AAS_HERMES_COMPOSE_ENV", str(Path(self.tmp.name) / "no-compose-env"))
        for fn in (inventory.credentials, inventory.tools, inventory.libraries):
            with self.subTest(fn=fn.__name__):
                want = self.both(fn)
                self.assertTrue(want["items"], fn.__name__)          # 비어 있는 결과끼리 같은 것이 아니다
        libs = inventory.libraries(self.local)
        self.assertEqual({e["kind"] for e in libs["envs"]}, {"Python", "Node.js"})
        # 스펙 2026-11-03-003 D9: 건너뛰는 이름(.hermes/.venv) 아래 라이브러리도 원격에서 그대로 보이고, 스킬 안 node_modules 의
        # 파일은 사용처가 아니다(로컬·원격 모두). secrets 참조 찾기도 같은 결과
        self.assertIn("six", [i["name"] for i in inventory.libraries(self.remote)["items"]])
        creds = {i["name"]: i for i in inventory.credentials(self.remote)["items"]}
        self.assertTrue([u for u in creds["mail.json"]["used_by"] if "mail" in u])
        self.assertFalse([u for u in creds["deploy.json"]["used_by"] if "deps" in u])
        self.assertIn(True, [t["executable"] for t in inventory.tools(self.remote)["items"]])   # st_mode 가 원격에서도 온다

    def test_flow_and_skill_graph(self):
        from aas.assets import flow, skill_graph
        self.both(flow.build)
        self.both(skill_graph.build)

    def test_files_read_and_siblings(self):
        from aas.assets import files
        rel = "skills/ops/report/SKILL.md"
        want = files.read(self.local, rel)
        got = files.read(self.remote, rel)
        self.assertEqual(self.norm(got, self.remote), self.norm(want, self.local))
        self.assertEqual(files.siblings(self.remote, rel), files.siblings(self.local, rel))
        # 하위 폴더 파일에서도 스킬 폴더 전체를 같은 값으로 돌려준다(2026-10-17-020)
        # 함께 쓰는 홈에 파일을 잠깐 더하므로 앞뒤로 원격 묶음 캐시를 버린다. 남기면 뒤 시험(호출 흐름)이 60초 동안 옛 파일 수를 본다
        sub = Path(self.local) / "skills/ops/report/templates/t.html"
        sub.parent.mkdir()
        try:
            sub.write_text("<p>t</p>\n", encoding="utf-8")
            self.backend.invalidate()
            rel_sub = "skills/ops/report/templates/t.html"
            self.assertIn(rel, files.siblings(self.local, rel_sub))
            self.assertEqual(files.siblings(self.remote, rel_sub), files.siblings(self.local, rel_sub))
        finally:
            sub.unlink()
            sub.parent.rmdir()
            self.backend.invalidate()


class ServerEndToEndTest(RemoteBase):
    """서버 HTTP 를 거쳐도 로컬 POD 와 원격 POD(사이드카)의 응답이 같다."""

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        import http.client as hc
        from http.server import ThreadingHTTPServer
        from aas.auth import auth
        from aas.fleet import pods
        from aas.web import server
        cls.hc, cls.server = hc, server
        reg = Path(cls.tmp.name) / "e2e-pods.json"
        os.environ["AAS_T_E2E"] = TOKEN
        reg.write_text(json.dumps({"pods": [
            {"id": "loc", "owner": "t@example.com", "hermes_home": str(cls.local)},
            {"id": "rem", "owner": "t@example.com", "sidecar_url": f"http://127.0.0.1:{cls.httpd.server_port}",
             "sidecar_token_env": "AAS_T_E2E"}]}))
        cls.old = (server._auth, server._registry)
        server._auth = auth.Auth({"issuer": "https://accounts.google.com", "client_id": "", "client_secret": "", "domain": "",
                                  "public_url": "http://localhost:17900", "hours": 1,
                                  "users_file": Path(cls.tmp.name) / "no-users.json"})          # 로그인 꺼짐
        server._registry = pods.Registry(reg)
        server._cache.clear()
        cls.web = aasserver.start()

    @classmethod
    def tearDownClass(cls):
        cls.web.shutdown()
        cls.web.server_close()
        cls.server._auth, cls.server._registry = cls.old
        os.environ.pop("AAS_T_E2E", None)
        super().tearDownClass()

    def api(self, path, pod):
        c = self.hc.HTTPConnection("127.0.0.1", self.web.server_port, timeout=20)
        c.request("GET", path, headers={"Cookie": f"{self.server.POD_COOKIE}={pod}"})
        r = c.getresponse()
        body = r.read()
        c.close()
        return r.status, json.loads(body)

    def test_same_answers_from_local_and_remote_pods(self):
        for path in ("/api/health", "/api/skills", "/api/activity?days=7", "/api/credentials", "/api/tools"):
            with self.subTest(path=path):
                lcode, lbody = self.api(path, "loc")
                rcode, rbody = self.api(path, "rem")
                self.assertEqual((lcode, rcode), (200, 200), (lbody, rbody))
                strip = lambda o: json.dumps(o, ensure_ascii=False, sort_keys=True).replace(str(self.local), "<H>")  # noqa: E731
                lj, rj = json.loads(strip(lbody)), json.loads(strip(rbody))
                for volatile in ("collected_at", "built_at", "generated_at"):          # 매번 달라지는 시각만 뺀다
                    lj.pop(volatile, None); rj.pop(volatile, None)
                self.assertEqual(rj, lj)

    def test_unreachable_sidecar_is_a_stated_failure_like_a_missing_local_home(self):
        """못 읽으면 0건이 아니라 이유가 적힌 실패다(ADR-0008). 로컬 홈이 없을 때와 같은 모양이다."""
        from aas.fleet import pods
        reg = Path(self.tmp.name) / "e2e-dead.json"
        reg.write_text(json.dumps({"pods": [
            {"id": "dead", "owner": "t@example.com", "sidecar_url": "http://127.0.0.1:9"},
            {"id": "nolocal", "owner": "t@example.com", "hermes_home": str(Path(self.tmp.name) / "absent")}]}))
        old = self.server._registry
        self.server._registry = pods.Registry(reg)
        self.server._cache.clear()
        try:
            for path in ("/api/health", "/api/skills", "/api/activity?days=7"):
                with self.subTest(path=path):
                    dcode, dbody = self.api(path, "dead")
                    lcode, _ = self.api(path, "nolocal")
                    self.assertEqual((dcode, lcode), (500, 500))
                    self.assertIn("사이드카에 연결할 수 없습니다", dbody["error"])
                    self.assertNotIn("profiles", dbody)
        finally:
            self.server._registry = old
            self.server._cache.clear()


class TombstonedProfileTest(unittest.TestCase):
    """Hermes 는 지운 프로파일에 profiles/.deleted/<이름> 표시를 남기고, 같은 이름의 빈 폴더가 다시 생겨도 프로파일로 치지 않는다.
    AAS 가 그 폴더를 프로파일로 읽어 compose 자동 자리가 지운 프로파일을 다시 앉혔다(스펙 2026-10-26-008 §10)."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.home = Path(self.tmp.name)
        for name in ("alive", "gone"):
            (self.home / "profiles" / name).mkdir(parents=True)
        (self.home / "profiles" / ".deleted").mkdir()
        (self.home / "profiles" / ".deleted" / "gone").write_text("deleted", encoding="utf-8")
        self.httpd = sc_server.make_server("127.0.0.1", 0, sc_ops.Ops(self.home), TOKEN)
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()
        self.remote = remote.RemotePath(remote.RemoteBackend(f"http://127.0.0.1:{self.httpd.server_port}", TOKEN, label="t"), "")

    def tearDown(self):
        self.httpd.shutdown()
        self.httpd.server_close()
        self.tmp.cleanup()

    def test_tombstoned_profile_is_not_listed(self):
        from aas.hermes import hermes_reader as hr
        self.assertEqual([p.name for p in hr.profiles(self.home)], ["default", "alive"])
        self.assertEqual([p.name for p in hr.profiles(self.remote)], ["default", "alive"])

    def test_profile_recreated_after_delete_is_listed(self):
        """Hermes 는 같은 이름으로 다시 만들 때 표시를 지운다 — 표시가 없으면 다시 목록에 나온다."""
        from aas.hermes import hermes_reader as hr
        (self.home / "profiles" / ".deleted" / "gone").unlink()
        self.assertEqual([p.name for p in hr.profiles(self.remote)], ["default", "alive", "gone"])


if __name__ == "__main__":
    unittest.main()

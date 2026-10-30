# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""사이드카 묶음 읽기(tree, OMAI-1102) — 묶음으로 답한 stat·list·read 가 하나씩 물은 결과와 같고, 왕복이 줄어든다."""
import json
import os
import sys
import tempfile
import threading
import unittest
import unittest.mock
from pathlib import Path

TMP = tempfile.TemporaryDirectory()
os.environ.setdefault("AAS_DATA_DIR", str(Path(TMP.name) / "data"))
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "sidecar"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from aas_sidecar import ops as sc_ops, server as sc_server  # noqa: E402

from aas.assets import inventory, skill_graph  # noqa: E402
from aas.hermes.readers import remote  # noqa: E402
from test_aas import make_home  # noqa: E402
from test_readers_remote import add_libraries, add_state_db  # noqa: E402

TOKEN = "tree-token-0123456789abcdef"
# 읽기 모듈이 실제로 쓰는 패턴(aas/ 의 glob·rglob) + 경계 몇 가지
PATTERNS = ["*", "*.json", "**/*", "**/SKILL.md", "scripts/*/package.json", "mcp/*/package.json", "**/site-packages", "*.dist-info",
            "*/*", "**/*.md", ".*", "**"]


def build_home(root: Path) -> Path:
    home = make_home(root)
    add_state_db(home)
    add_libraries(home)
    # 에이전트 홈은 묶음이 건너뛴다 — 자산 목록이 읽는 home/.local 의 site-packages 는 사이드카에 따로 물어 같은 답을 내야 한다
    dist = home / "profiles" / "alpha" / "home" / ".local" / "lib" / "python3.12" / "site-packages" / "rich-13.7.0.dist-info"
    dist.mkdir(parents=True)
    (dist / "top_level.txt").write_text("rich\n", encoding="utf-8")
    (home / ".hidden.json").write_text("{}", encoding="utf-8")
    (home / "logs").mkdir(exist_ok=True)
    (home / "logs" / "agent.log").write_text("x\n", encoding="utf-8")
    (home / "skills" / "big").mkdir(parents=True, exist_ok=True)
    (home / "skills" / "big" / "SKILL.md").write_text("---\nname: big\n---\n" + "y" * 300_000, encoding="utf-8")   # 내용 상한보다 크다
    outside = root / "outside"
    outside.mkdir(exist_ok=True)
    (outside / "secret.txt").write_text("no", encoding="utf-8")
    (home / "escape").symlink_to(outside, target_is_directory=True)            # root 밖을 가리키는 심링크
    (home / "linked-skills").symlink_to(home / "skills", target_is_directory=True)   # root 안을 가리키는 심링크 폴더
    return home


class Counting(remote.RemoteBackend):
    def __init__(self, *a, **kw):
        super().__init__(*a, **kw)
        self.calls = []

    def _call(self, method, path, body=None, timeout=None):
        self.calls.append(path)
        return super()._call(method, path, body, timeout)


class TreeTest(unittest.TestCase):
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

    def backend(self):
        return Counting(self.url, TOKEN, label="t")

    def walk_answers(self, root: remote.RemotePath) -> dict:
        """폴더마다 패턴·stat·읽기 결과를 모은다(묶음 유무에 따라 같아야 한다)."""
        out = {}
        dirs = [""] + [e["path"] for e in root.backend.list("", "**/*") if e["type"] == "dir"]
        for d in dirs:
            base = root / d if d else root
            for pat in PATTERNS:
                try:
                    out[f"glob {d} {pat}"] = sorted(str(p.rel) for p in base.glob(pat))
                except Exception as exc:
                    out[f"glob {d} {pat}"] = type(exc).__name__
        for rel in ["", "config.yaml", "nope.txt", "skills", "skills/big/SKILL.md", "logs/agent.log", "logs/none", "escape",
                    "escape/secret.txt", "linked-skills", "linked-skills/big/SKILL.md", ".hidden.json", "profiles/alpha/state.db"]:
            p = root / rel if rel else root
            out[f"stat {rel}"] = (p.exists(), p.is_file(), p.is_dir())
            try:
                out[f"read {rel}"] = p.read_bytes()[:64]
            except Exception as exc:
                out[f"read {rel}"] = type(exc).__name__
        return out

    def test_tree_answers_match_one_by_one_answers(self):
        plain = self.backend()
        plain._has_tree = False                                 # 묶음을 쓰지 않는다(옛 사이드카처럼)
        expected = self.walk_answers(remote.RemotePath(plain, ""))
        bundled = self.backend()
        self.assertTrue(bundled.snapshot())
        got = self.walk_answers(remote.RemotePath(bundled, ""))
        diff = {k: (expected[k], got.get(k)) for k in expected if expected[k] != got.get(k)}
        self.assertEqual(diff, {})

    def test_sidecar_tree_skips_marks_partial_and_keeps_secrets_outside(self):
        out = sc_ops.Ops(self.home).tree("", skip_dirs=["logs"], no_content=[".db"], max_file=262_144)
        paths = {e["path"]: e for e in out["entries"]}
        self.assertIn("logs", paths)
        self.assertNotIn("logs/agent.log", paths)                 # 건너뛴 폴더는 항목만
        self.assertIn("logs", out["partial"])
        self.assertIn("linked-skills", out["partial"])            # 심링크 폴더는 안을 보지 않는다
        self.assertNotIn("escape", paths)                        # root 밖을 가리키는 것은 없는 것처럼
        self.assertNotIn("data_b64", paths["profiles/alpha/state.db"])
        self.assertNotIn("data_b64", paths["skills/big/SKILL.md"])  # 상한보다 큰 파일은 내용 없이
        self.assertIn("data_b64", paths["config.yaml"])

    def test_sidecar_tree_total_cap(self):
        out = sc_ops.Ops(self.home).tree("", max_file=262_144, max_total=10)
        self.assertLessEqual(out["content_bytes"], 10)

    @unittest.mock.patch.object(remote, "BURST_CALLS", 12)        # 시험 폴더는 작아 수집 한 번이 30번 안팎이다(실제는 수백 번)
    def test_heavy_collectors_use_the_bundle_and_give_the_same_result(self):
        plain = self.backend()
        plain._has_tree = False
        bundled = self.backend()
        for fn in (skill_graph.build, inventory.tools, inventory.libraries, inventory.credentials):
            with self.subTest(fn=fn.__name__):
                plain.calls.clear(); bundled.calls.clear(); bundled.invalidate()
                a = fn(remote.RemotePath(plain, ""))
                b = fn(remote.RemotePath(bundled, ""))
                strip = lambda v: json.loads(json.dumps(v, default=str).replace(self.url, ""))   # noqa: E731
                a, b = strip(a), strip(b)
                # 수집 시각은 초 단위라 두 번 부르는 사이에 초가 넘어가면 다르다(CI 에서 실패한 적이 있다).
                # skill_graph.build 는 built_at 이다(2026-10-30 GitHub Actions 에서 실패)
                if isinstance(a, dict) and isinstance(b, dict):
                    for key in ("collected_at", "built_at"):
                        a.pop(key, None); b.pop(key, None)
                self.assertEqual(a, b)
                self.assertTrue({"/v1/tree", "/v1/changes"} & set(bundled.calls), bundled.calls)   # 묶음(처음) 또는 바뀐 것만(1.5)
                self.assertLess(len(bundled.calls), len(plain.calls) / 2, (len(bundled.calls), len(plain.calls)))

    def test_light_reads_do_not_fetch_the_bundle(self):
        b = self.backend()
        root = remote.RemotePath(b, "")
        for rel in ("config.yaml", "SOUL.md", "nope"):
            (root / rel).exists()
        self.assertNotIn("/v1/tree", b.calls)

    def test_slow_bundle_gets_its_own_longer_time_limit(self):
        """느린 노드(OKE worker-5)에서 묶음 7.6MB 가 11초 걸려 10초 한도에 매번 끊겼다. 끊기면 30초 동안 하나씩 묻기로 떨어져
        초당 75번을 불렀다. 묶음만 따로 긴 한도를 쓰고, 다른 연산은 짧은 한도를 그대로 쓴다."""
        import time
        orig_tree, orig_stat = sc_ops.Ops.tree, sc_ops.Ops.stat

        def slow_tree(self_, *a, **kw):
            time.sleep(0.6)
            return orig_tree(self_, *a, **kw)

        def slow_stat(self_, *a, **kw):
            time.sleep(0.6)
            return orig_stat(self_, *a, **kw)
        b = Counting(self.url, TOKEN, label="t", timeout=0.3)
        with unittest.mock.patch.object(sc_ops.Ops, "tree", slow_tree), unittest.mock.patch.object(remote, "TREE_TIMEOUT", 3.0):
            self.assertTrue(b.snapshot())
        self.assertFalse(b._tree_failed_at)
        with unittest.mock.patch.object(sc_ops.Ops, "stat", slow_stat):
            with self.assertRaises(remote.SidecarError):
                b.stat_now("config.yaml")                    # 같은 스레드의 연결이 묶음의 긴 한도를 들고 있지 않다

    def test_old_sidecar_without_tree_keeps_working(self):
        b = self.backend()
        orig = b._call

        def no_tree(method, path, body=None, timeout=None):
            if path == "/v1/tree":
                raise FileNotFoundError("없는 경로입니다")
            return orig(method, path, body)
        b._call = no_tree
        self.assertFalse(b.snapshot())
        self.assertIs(b._has_tree, False)
        self.assertTrue((remote.RemotePath(b, "") / "config.yaml").is_file())

    def test_invalidate_drops_the_bundle(self):
        b = self.backend()
        self.assertTrue(b.snapshot())
        b.invalidate()
        self.assertIsNone(b._tree)


class SecondRoundTest(unittest.TestCase):
    """두 번째 개선(OMAI-1102): 같은 묶음 안에서 한 번만, 묶음 먼저, 지문이 같으면 내용 없이, 묶음에서 바로 읽기."""

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

    def root(self):
        b = Counting(self.url, TOKEN, label="t")
        return b, remote.RemotePath(b, "")

    def test_flow_builds_the_skill_graph_once_and_starts_with_the_bundle(self):
        from aas.assets import flow
        b, root = self.root()
        real = skill_graph._build
        count = []
        with unittest.mock.patch.object(skill_graph, "_build", side_effect=lambda *a, **k: count.append(1) or real(*a, **k)):
            flow.build(root)
        self.assertEqual(len(count), 1)                            # 전에는 스킬 그래프·도구·라이브러리가 각자 만들어 세 번
        self.assertEqual(b.calls[0], "/v1/tree")                   # 하나씩 묻기 전에 묶음부터

    def test_same_bundle_returns_the_same_result_and_new_bundle_rebuilds(self):
        b, root = self.root()
        first = inventory.tools(root)
        self.assertIs(inventory.tools(root), first)
        b.invalidate()
        self.assertIsNot(inventory.tools(root), first)

    def test_unchanged_folder_is_not_sent_again(self):
        """바뀐 것이 없으면 목록만 받고 내용은 다시 받지 않는다(스펙 2026-10-24-013 R1 — 사이드카 지문 대신 목록 견주기)."""
        from aas_sidecar import index as sc_index
        reuse = unittest.mock.patch.object(sc_index, "REUSE", 0.0)       # 시험은 2초 안에 파일을 바꾼다
        reuse.start()
        self.addCleanup(reuse.stop)
        b, root = self.root()
        self.assertTrue(b.snapshot())
        first = inventory.tools(root)
        b._tree.taken -= remote.TREE_TTL + 1                        # 시간이 지났다
        self.assertIsNone(b._fresh_tree())
        b.calls.clear()
        self.assertTrue(b.snapshot())
        self.assertEqual(b.calls, ["/v1/changes"])                 # 바뀐 것만 묻는다(사이드카 1.5)
        self.assertIs(inventory.tools(root), first)                # 지문이 같아 무거운 결과를 넘겨받는다
        (self.home / "config.yaml").write_text("model: changed\n", encoding="utf-8")
        os.utime(self.home / "config.yaml", (1, 1))
        b._tree.taken -= remote.TREE_TTL + 1
        b._fresh_tree()
        b.calls.clear()
        self.assertTrue(b.snapshot())
        self.assertEqual(b.calls, ["/v1/changes", "/v1/read"])
        self.assertEqual((root / "config.yaml").read_text(), "model: changed\n")

    def test_gateway_status_files_are_read_fresh_not_from_the_bundle(self):
        # 게이트웨이가 쓰는 상태 파일은 묶음(60초)의 내용으로 답하면 MCP 로그인 뒤 「연결됨」을 60초 늦게 본다(OKE 2026-10-17, 스펙 2026-10-16-010 14-15)
        names = ("aas-mcp-status.json", "gateway_state.json")
        try:
            for n in names:
                (self.home / n).write_text('{"v": 1}', encoding="utf-8")
            b, root = self.root()
            self.assertTrue(b.snapshot())
            for n in names:
                (self.home / n).write_text('{"v": 2}', encoding="utf-8")
            for n in names:
                self.assertEqual((root / n).read_text(), '{"v": 2}', n)
        finally:
            for n in names:
                (self.home / n).unlink(missing_ok=True)

    def test_gateway_status_file_created_after_the_bundle_is_seen(self):
        # 새 파드는 MCP 서버를 처음 더할 때 상태 파일이 생긴다. 묶음이 「없음」을 들고 있으면 60초 동안 없다고 답한다(OKE 2026-10-17, 14-17)
        name = "aas-mcp-status.json"
        try:
            (self.home / name).unlink(missing_ok=True)
            b, root = self.root()
            self.assertTrue(b.snapshot())
            self.assertFalse((root / name).exists())
            (self.home / name).write_text('{"v": 3}', encoding="utf-8")
            self.assertTrue((root / name).exists())
            self.assertEqual((root / name).read_text(), '{"v": 3}')
        finally:
            (self.home / name).unlink(missing_ok=True)

    def test_reads_inside_the_bundle_do_not_ask_the_sidecar(self):
        b, root = self.root()
        self.assertTrue(b.snapshot())
        b.calls.clear()
        self.assertTrue((root / "config.yaml").read_bytes())
        self.assertEqual(b.calls, [])


class StaleWhileRefreshTest(unittest.TestCase):
    """만료된 캐시 값은 바로 돌려주고 뒤에서 다시 만든다. 너무 오래됐으면 기다린다(OMAI-1102)."""

    def test_stale_value_is_returned_and_refreshed_in_background(self):
        import time
        from aas.web import server
        server._cache["t:swr"] = (time.time() - 100, "old")        # 유효 시간 60초가 지났지만 10배 안
        started = threading.Event()

        def slow():
            started.set()
            time.sleep(0.3)
            return "new"
        t0 = time.time()
        self.assertEqual(server._cached("t:swr", 60, slow, per_lang=False), "old")
        self.assertLess(time.time() - t0, 0.1)
        self.assertTrue(started.wait(2))
        for _ in range(50):
            if server._cache["t:swr"][1] == "new":
                break
            time.sleep(0.05)
        self.assertEqual(server._cached("t:swr", 60, slow, per_lang=False), "new")

    def test_too_old_value_waits_for_a_fresh_one(self):
        import time
        from aas.web import server
        server._cache["t:old"] = (time.time() - 100000, "ancient")
        self.assertEqual(server._cached("t:old", 60, lambda: "fresh", per_lang=False), "fresh")


class SingleBuildTest(unittest.TestCase):
    """만료된 값을 여러 요청이 동시에 다시 만들지 않는다 — 사이드카에 같은 일이 겹쳐 쌓이지 않게(OMAI-1102)."""

    def test_concurrent_requests_build_once(self):
        import time
        from aas.web import server
        built = []

        def slow():
            built.append(1)
            time.sleep(0.3)
            return "v"
        server._cache.pop("t:single", None)
        out = []
        threads = [threading.Thread(target=lambda: out.append(server._cached("t:single", 60, slow, per_lang=False))) for _ in range(8)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        self.assertEqual((len(built), out), (1, ["v"] * 8))


class ToolCacheSkipTest(unittest.TestCase):
    """OMAI-1175: 에이전트 도구가 홈(profiles/<이름>/home/.cache)에 쌓은 캐시는 묶음에서 안을 보지 않는다.
    OKE 의 한 에이전트는 이 폴더에 파일 11,787개(176MB)가 있어, 묶음이 모두 훑어 서버가 기다리다 끊고(BrokenPipe) 사이드카 메모리가 늘었다."""

    def test_dot_cache_in_agent_home_is_listed_but_not_walked(self):
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp)
            cache = home / "profiles" / "main" / "home" / ".cache" / "pip"
            cache.mkdir(parents=True)
            for i in range(40):
                (cache / f"f{i}.bin").write_bytes(b"x" * 10)
            skill = home / "profiles" / "main" / "skills" / "x"
            skill.mkdir(parents=True)
            (skill / "SKILL.md").write_text("# x\n", encoding="utf-8")
            out = sc_ops.Ops(home).tree("", skip_dirs=remote.TREE_SKIP_DIRS, no_content=remote.TREE_NO_CONTENT, max_file=remote.TREE_MAX_FILE)
            paths = [e["path"] for e in out["entries"]]
            self.assertIn("profiles/main/home", paths)                             # 폴더 항목은 낸다(홈 전체를 건너뛴다)
            self.assertIn("profiles/main/home", out["partial"])                    # 안을 보지 않았다고 알린다
            self.assertEqual([p for p in paths if "/.cache/" in p], [])             # 안의 파일은 훑지 않는다
            self.assertIn("profiles/main/skills/x/SKILL.md", paths)                # 다른 파일은 그대로 읽는다

    def test_whole_agent_home_is_listed_but_not_walked(self):
        """캐시 이름을 하나씩 더하지 않고 에이전트 홈 전체를 건너뛴다. OKE YJBot 의 home/.npm(npm 캐시 2,769개)이
        묶음을 10초 넘게 끌어 사이드카가 끊긴 요청까지 처리하느라 막혔고, 프로파일 화면이 「응답 없음」이 됐다."""
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp)
            npm = home / "profiles" / "main" / "home" / ".npm" / "_cacache" / "index-v5"
            npm.mkdir(parents=True)
            for i in range(40):
                (npm / f"i{i}").write_text("{}", encoding="utf-8")
            site = home / "profiles" / "main" / "home" / ".local" / "lib" / "python3.12" / "site-packages"
            site.mkdir(parents=True)
            (site / "a.py").write_text("x = 1\n", encoding="utf-8")
            (home / "profiles" / "main" / "config.yaml").write_text("model: m\n", encoding="utf-8")
            out = sc_ops.Ops(home).tree("", skip_dirs=remote.TREE_SKIP_DIRS, no_content=remote.TREE_NO_CONTENT, max_file=remote.TREE_MAX_FILE)
            paths = [e["path"] for e in out["entries"]]
            self.assertIn("profiles/main/home", out["partial"])
            self.assertEqual([p for p in paths if p.startswith("profiles/main/home/")], [])
            self.assertIn("profiles/main/config.yaml", paths)


if __name__ == "__main__":
    unittest.main()

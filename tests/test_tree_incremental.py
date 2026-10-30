# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""사이드카 묶음을 목록만 받고 바뀐 파일만 읽기, 서버 지문, 나눠 읽기, 압축·한 벌 보관, 최근 사용 순 정리, 호출 세기
(스펙 2026-10-24-013 1단계 R0~R8)."""
import gc
import os
import sys
import tempfile
import threading
import time
import unittest
import unittest.mock
from pathlib import Path

TMP = tempfile.TemporaryDirectory()
os.environ.setdefault("AAS_DATA_DIR", str(Path(TMP.name) / "data"))
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "sidecar"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from aas_sidecar import index as sc_index, ops as sc_ops, server as sc_server  # noqa: E402

from aas.assets import inventory  # noqa: E402
from aas.hermes.readers import remote, secret_scrub, tree_cache  # noqa: E402
from test_aas import make_home  # noqa: E402

TOKEN = "incremental-token-0123456789abcdef"


class Recording(remote.RemoteBackend):
    def __init__(self, *a, **kw):
        super().__init__(*a, **kw)
        self.calls = []

    def _call(self, method, path, body=None, timeout=None):
        self.calls.append((path, list((body or {}).get("paths") or [])))
        return super()._call(method, path, body, timeout)


class Base(unittest.TestCase):
    max_total = None

    def setUp(self):
        reuse = unittest.mock.patch.object(sc_index, "REUSE", 0.0)   # 시험은 2초 안에 파일을 바꾼다 — 사이드카가 매번 다시 훑게
        reuse.start()
        self.addCleanup(reuse.stop)
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.home = make_home(Path(self.tmp.name))
        (self.home / "skills" / "alpha").mkdir(parents=True, exist_ok=True)
        (self.home / "skills" / "alpha" / "SKILL.md").write_text("---\nname: alpha\n---\n" + "본문 " * 400, encoding="utf-8")
        (self.home / "cron").mkdir(exist_ok=True)
        (self.home / "cron" / "ticker_heartbeat").write_text("1", encoding="utf-8")
        kw = {"max_total": self.max_total} if self.max_total else {}
        self.httpd = sc_server.make_server("127.0.0.1", 0, sc_ops.Ops(self.home, **kw), TOKEN)
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()
        self.addCleanup(self.httpd.server_close)
        self.addCleanup(self.httpd.shutdown)
        self.url = f"http://127.0.0.1:{self.httpd.server_port}"

    def backend(self, label="t"):
        return Recording(self.url, TOKEN, label=label)

    def expire(self, b):
        b._tree.taken -= remote.TREE_TTL + 1
        b._fresh_tree()

    def touch_file(self, rel, text):
        p = self.home / rel
        p.write_text(text, encoding="utf-8")
        os.utime(p, (time.time() + 5, time.time() + 5))       # 같은 초 안에 바뀌어도 시각이 달라지게


class IncrementalTest(Base):
    def test_두_번째_묶음은_목록과_바뀐_파일만_받는다(self):
        b = self.backend()
        self.assertTrue(b.snapshot())
        self.expire(b)
        b.calls.clear()
        self.assertTrue(b.snapshot())
        self.assertEqual(b.calls, [("/v1/changes", [])])                    # 바뀐 것이 없으면 변경 묻기만(사이드카 1.5)
        self.touch_file("config.yaml", "model: changed\n")
        self.expire(b)
        b.calls.clear()
        self.assertTrue(b.snapshot())
        self.assertEqual(b.calls, [("/v1/changes", []), ("/v1/read", ["config.yaml"])])
        self.assertEqual((remote.RemotePath(b, "") / "config.yaml").read_text(), "model: changed\n")

    def test_없어진_파일은_묶음에서도_없다(self):
        b = self.backend()
        self.assertTrue(b.snapshot())
        (self.home / "skills" / "alpha" / "SKILL.md").unlink()
        self.expire(b)
        self.assertTrue(b.snapshot())
        self.assertNotIn("skills/alpha/SKILL.md", b._tree.data)
        self.assertFalse((remote.RemotePath(b, "") / "skills" / "alpha" / "SKILL.md").exists())

    def test_invalidate_뒤에도_바뀌지_않은_파일은_다시_읽지_않는다(self):
        """AAS 가 쓸 때마다 묶음 전체를 다시 읽으면 두 서버가 5~14MB 씩 다시 받았다(외부 검토 OV2)."""
        b = self.backend()
        root = remote.RemotePath(b, "")
        self.assertTrue(b.snapshot())
        first = inventory.tools(root)
        held = b._tree.data["config.yaml"]
        b.invalidate()
        b.calls.clear()
        self.assertTrue(b.snapshot())
        self.assertEqual(b.calls, [("/v1/changes", [])])
        self.assertIs(b._tree.data["config.yaml"], held)                    # 받은 내용을 그대로 넘겨받았다
        self.assertIsNot(inventory.tools(root), first)                     # 결과(memo)는 다시 만든다

    def test_상태_파일만_바뀌면_무거운_결과를_다시_쓰고_스킬이_바뀌면_다시_만든다(self):
        b = self.backend()
        root = remote.RemotePath(b, "")
        self.assertTrue(b.snapshot())
        first = inventory.tools(root)
        self.touch_file("cron/ticker_heartbeat", "2")
        self.expire(b)
        self.assertTrue(b.snapshot())
        self.assertIs(inventory.tools(root), first)
        self.touch_file("skills/alpha/SKILL.md", "---\nname: alpha\n---\n바뀜\n")
        self.expire(b)
        self.assertTrue(b.snapshot())
        self.assertIsNot(inventory.tools(root), first)

    def test_넘겨받는_결과는_최대_나이가_있다(self):
        b = self.backend()
        root = remote.RemotePath(b, "")
        self.assertTrue(b.snapshot())
        first = inventory.tools(root)
        b._tree.memo_born -= remote.MEMO_MAX_AGE + 1
        self.expire(b)
        self.assertTrue(b.snapshot())
        self.assertIsNot(inventory.tools(root), first)

    def test_안을_보지_않는_폴더가_바뀌면_지문이_바뀐다(self):
        """mcp-tokens 안 토큰 생김은 그 폴더의 시각으로만 안다(외부 검토 OV3)."""
        b = self.backend()
        (self.home / "mcp-tokens").mkdir(exist_ok=True)
        self.assertTrue(b.snapshot())
        before = b._tree.server_fp
        (self.home / "mcp-tokens" / "jira.json").write_text("{}", encoding="utf-8")
        os.utime(self.home / "mcp-tokens", (time.time() + 5, time.time() + 5))
        self.expire(b)
        self.assertTrue(b.snapshot())
        self.assertNotEqual(b._tree.server_fp, before)

    def test_지문만_묻기는_내용을_읽지_않는다(self):
        b = self.backend()
        fp = b.fingerprint()
        self.assertTrue(fp)
        self.assertEqual([c[0] for c in b.calls], ["/v1/tree"])
        self.assertEqual(b.fingerprint(), fp)


class ChunkTest(Base):
    max_total = 3000                                                    # 사이드카 read 한 번의 총량을 작게

    def test_상한보다_큰_폴더도_모든_내용이_묶음에_들어간다(self):
        b = self.backend()
        with unittest.mock.patch.object(remote, "READ_CHUNK", 2000):
            self.assertTrue(b.snapshot())
        tree = b._tree
        for rel in ("config.yaml", "skills/alpha/SKILL.md", "cron/ticker_heartbeat"):
            self.assertEqual(tree.content(rel), (self.home / rel).read_bytes(), rel)
        self.assertGreater(sum(1 for c in b.calls if c[0] == "/v1/read"), 1)

    def test_한_조각이_실패해도_받은_조각은_남는다(self):
        b = self.backend()
        orig = remote.RemoteBackend._call
        n = {"read": 0}

        def flaky(self_, method, path, body=None, timeout=None):
            if path == "/v1/read":
                n["read"] += 1
                if n["read"] == 2:
                    raise remote.SidecarError("끊김")
            return orig(self_, method, path, body, timeout)
        with unittest.mock.patch.object(remote, "READ_CHUNK", 2000), unittest.mock.patch.object(remote.RemoteBackend, "_call", flaky):
            self.assertTrue(b.snapshot())
        self.assertTrue(b._tree.data)                                   # 첫 조각은 남았다
        root = remote.RemotePath(b, "")
        for rel in ("config.yaml", "skills/alpha/SKILL.md"):
            self.assertEqual((root / rel).read_bytes(), (self.home / rel).read_bytes())   # 빠진 것은 따로 묻는다


class StoreTest(Base):
    def test_압축해_둔_내용은_원문과_같고_작은_파일은_원문_그대로(self):
        big = ("반복되는 스킬 설명 " * 300).encode()
        blob = tree_cache.Blob(big)
        self.assertEqual(blob.bytes(), big)
        self.assertLess(blob.held, len(big))
        tiny = tree_cache.Blob(b"1")
        self.assertEqual((tiny.bytes(), tiny.held), (b"1", 1))

    def test_같은_내용은_한_벌만_두고_묶음을_모두_버리면_비워진다(self):
        a, b = self.backend("a"), self.backend("b")
        self.assertTrue(a.snapshot())
        self.assertTrue(b.snapshot())
        rel = "skills/alpha/SKILL.md"
        self.assertIs(a._tree.data[rel], b._tree.data[rel])
        a.drop()
        self.assertEqual(b._tree.content(rel), (self.home / rel).read_bytes())
        key = tree_cache.digest((self.home / rel).read_bytes())
        b.drop()
        gc.collect()
        self.assertNotIn(key, tree_cache._store)

    def test_자격증명_파일은_한_벌_저장소에_넣지_않는다(self):
        (self.home / ".env").write_text("API_KEY=raw-secret-value\n", encoding="utf-8")
        b = self.backend()
        self.assertTrue(b.snapshot())
        blob = b._tree.data.get(".env")
        self.assertIsNotNone(blob)
        self.assertNotIn(b"raw-secret-value", blob.bytes())
        self.assertNotIn(blob, list(tree_cache._store.values()))
        self.assertTrue(secret_scrub.is_credential(".env"))


class SweepTest(Base):
    def test_사람이_쓰지_않은_묶음은_10분_뒤_버리고_쓴_묶음은_남긴다(self):
        used, idle = self.backend("used"), self.backend("idle")
        self.assertTrue(used.snapshot())
        self.assertTrue(idle.snapshot())                                # 배경 작업은 「사용」이 아니다
        now = time.monotonic()
        token = tree_cache.HUMAN.set(True)
        try:
            used.stat("config.yaml")
        finally:
            tree_cache.HUMAN.reset(token)
        dropped = tree_cache.sweep([used, idle], now=now + 60)
        self.assertEqual(dropped, ["idle"])
        self.assertIsNotNone(used._tree)
        self.assertEqual(tree_cache.sweep([used], now=now + tree_cache.IDLE_DROP + 1), ["used"])

    def test_상한을_넘으면_오래_쓰지_않은_것부터_버린다(self):
        a, b = self.backend("old"), self.backend("new")
        tree_cache._used["old"], tree_cache._used["new"] = time.monotonic() - 100, time.monotonic()
        self.assertTrue(a.snapshot())
        self.assertTrue(b.snapshot())
        with unittest.mock.patch.object(tree_cache, "cap_bytes", lambda: 1):
            dropped = tree_cache.sweep([a, b], now=time.monotonic())
        self.assertEqual(dropped[0], "old")

    def test_버린_묶음의_연결은_닫는다(self):
        b = self.backend()
        self.assertTrue(b.snapshot())
        conn = b._local.conn
        self.assertIsNotNone(conn.sock)
        b.drop()
        self.assertIsNone(conn.sock)


class CallStatsTest(Base):
    def test_연산별_횟수와_바이트가_쌓이고_기록_뒤_0으로(self):
        remote.call_stats()                                             # 앞 시험의 값을 비운다
        b = self.backend("counted")
        self.assertTrue(b.snapshot())
        st = remote.call_stats()
        self.assertGreaterEqual(st["ops"]["/v1/tree"]["n"], 1)
        self.assertGreater(st["ops"]["/v1/tree"]["bytes"], 0)
        self.assertIn("counted", st["agents"])
        self.assertEqual(remote.call_stats()["ops"], {})
        line = remote.call_report_line(st)
        self.assertIn("/v1/tree", line)


class SidecarFifteenTest(Base):
    """사이드카 1.5: 파일 해시로 아는 내용은 읽지 않고, 커서로 바뀐 것만 묻는다(스펙 2026-10-24-013 R7·R10)."""

    def test_다른_에이전트가_이미_받은_내용은_읽지_않는다(self):
        a, b = self.backend("a"), self.backend("b")
        self.assertTrue(a.snapshot())
        self.assertTrue(b.snapshot())
        self.assertEqual([c for c in b.calls if c[0] == "/v1/read"], [])
        rel = "skills/alpha/SKILL.md"
        self.assertIs(b._tree.data[rel], a._tree.data[rel])

    def test_옛_사이드카면_목록_전체를_받는다(self):
        b = self.backend()
        self.assertTrue(b.snapshot())
        orig = remote.RemoteBackend._call

        def no_changes(self_, method, path, body=None, timeout=None):
            if path == "/v1/changes":
                raise FileNotFoundError("없는 경로입니다")
            return orig(self_, method, path, body, timeout)
        self.expire(b)
        with unittest.mock.patch.object(remote.RemoteBackend, "_call", no_changes):
            self.assertTrue(b.snapshot())
        self.assertIs(b._has_changes, False)
        self.assertEqual([c[0] for c in b.calls][-1], "/v1/tree")

    def test_고친_직후에는_사이드카가_2초_재사용_없이_다시_훑는다(self):
        """AAS 가 고친 바로 뒤 invalidate 를 하면, 사이드카가 2초 안의 옛 훑기를 돌려줘 60초 동안 옛 내용이 보였다."""
        with unittest.mock.patch.object(sc_index, "REUSE", 2.0):
            b = self.backend()
            self.assertTrue(b.snapshot())
            self.touch_file("config.yaml", "model: fixed\n")
            b.invalidate()
            self.assertEqual((remote.RemotePath(b, "") / "config.yaml").read_text(), "model: fixed\n")
            self.assertTrue(b.snapshot())
            self.assertEqual(b._tree.content("config.yaml"), b"model: fixed\n")

    def test_없어진_파일과_생긴_파일이_변경으로_온다(self):
        b = self.backend()
        self.assertTrue(b.snapshot())
        (self.home / "skills" / "alpha" / "SKILL.md").unlink()
        self.touch_file("new.md", "새 파일")
        self.expire(b)
        self.assertTrue(b.snapshot())
        self.assertNotIn("skills/alpha/SKILL.md", b._tree.entries)
        self.assertEqual(b._tree.content("new.md"), "새 파일".encode())


class ChangeIndexTest(unittest.TestCase):
    def test_2초_안에는_다시_훑지_않고_커서가_맞지_않으면_처음부터(self):
        now = [100.0]
        listing = {"entries": [{"path": "a", "type": "file", "size": 1, "mtime": 1.0}], "partial": []}
        scans = []
        idx = sc_index.ChangeIndex(lambda p: scans.append(1) or listing, clock=lambda: now[0])
        cursor = idx.record(("k",), listing)
        out = idx.changes(("k",), cursor, {})
        self.assertEqual((out["reset"], out["entries"], scans), (False, [], []))   # 2초 안 — 다시 훑지 않음
        now[0] += 3
        listing = {"entries": [{"path": "a", "type": "file", "size": 2, "mtime": 2.0}], "partial": []}
        out = idx.changes(("k",), cursor, {})
        self.assertEqual((len(scans), [e["path"] for e in out["entries"]]), (1, ["a"]))
        self.assertTrue(idx.changes(("k",), "other-epoch:0", {})["reset"])     # 사이드카가 다시 시작됨
        self.assertTrue(idx.changes(("k",), "", {})["reset"])

    def test_사이드카_목록에_파일_해시가_실린다(self):
        import hashlib
        with tempfile.TemporaryDirectory() as tmp:
            home = make_home(Path(tmp))
            out = sc_ops.Ops(home).tree("", skip_dirs=remote.TREE_SKIP_DIRS, no_content=[""], max_file=remote.TREE_MAX_FILE,
                                        hashes=remote.TREE_NO_CONTENT, cursor=True)
            got = {e["path"]: e.get("sha256") for e in out["entries"]}
            self.assertEqual(got["config.yaml"], hashlib.sha256((home / "config.yaml").read_bytes()).hexdigest())
            self.assertTrue(out["cursor"])


class ServerTest(unittest.TestCase):
    def test_흐름_그래프_미리_만들기_루프가_없다(self):
        """화면이 열 때 `_flow` 가 지난 값을 먼저 주고 뒤에서 새로 만든다 — 5분마다 모든 에이전트를 돌 필요가 없다(D7)."""
        from aas.web import server
        self.assertFalse(hasattr(server, "_warm_flows"))

    def test_태그용_스킬은_지문이_바뀐_에이전트만_다시_모은다(self):
        from aas.web import server
        b = unittest.mock.Mock()
        b.fingerprint.return_value = "fp1"
        pod = unittest.mock.Mock(id="pod-a", hermes_home=unittest.mock.Mock(backend=b))
        reg = unittest.mock.Mock(pods=[pod])
        server._tag_seen.clear()
        skills = {"skills": [{"name": "s", "description": "d", "origin": "o"}]}
        with unittest.mock.patch.object(server, "registry", return_value=reg), \
                unittest.mock.patch.object(server, "_skills", return_value=skills) as got:
            first, ok = server._all_skills_for_tags()
            again, _ = server._all_skills_for_tags()
            self.assertEqual(got.call_count, 1)                    # 지문이 같으면 다시 모으지 않는다
            b.fingerprint.return_value = "fp2"
            server._all_skills_for_tags()
            self.assertEqual(got.call_count, 2)
        self.assertTrue(ok)
        self.assertEqual(first, again)

    def test_오래_쓰지_않은_에이전트의_결과_캐시를_버린다(self):
        from aas.web import server
        reg = unittest.mock.Mock(pods=[unittest.mock.Mock(id="idle-pod", hermes_home=None),
                                       unittest.mock.Mock(id="busy-pod", hermes_home=None)])
        tree_cache._used["busy-pod"] = time.monotonic()
        tree_cache._used.pop("idle-pod", None)
        with server._lock:
            server._cache["idle-pod:flow"] = (time.time(), 1)
            server._cache["busy-pod:flow"] = (time.time(), 2)
        with unittest.mock.patch.object(server, "registry", return_value=reg):
            server._tree_sweep()
        self.assertNotIn("idle-pod:flow", server._cache)
        self.assertIn("busy-pod:flow", server._cache)
        server._cache.pop("busy-pod:flow", None)

    def test_사람_요청의_결과_캐시_조회는_사용으로_친다(self):
        from aas.web import server
        tree_cache._used.pop("seen-pod", None)
        token = tree_cache.HUMAN.set(True)
        try:
            server._cached("seen-pod:x", 60, lambda: 1)
        finally:
            tree_cache.HUMAN.reset(token)
        self.assertFalse(tree_cache.idle("seen-pod"))


if __name__ == "__main__":
    unittest.main()

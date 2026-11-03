# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""파일이 많은 Hermes 데이터 폴더(GitHub #1, 스펙 2026-11-03-003). 사이드카 항목 상한·의존성 폴더 건너뛰기·잘린 묶음 기억·
변경분 잘림·해시 캐시·찾기용 재귀 목록·색인 없는 자격증명·라이브러리 묶어 읽기."""
import contextlib
import hashlib
import io
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

from aas_sidecar import index as sc_index, ops as sc_ops, server as sc_server  # noqa: E402

from aas.assets import inventory  # noqa: E402
from aas.hermes import hermes_reader as hr  # noqa: E402
from aas.hermes.readers import remote  # noqa: E402
from test_aas import make_home  # noqa: E402

TOKEN = "large-home-token-0123456789abcdef"


class Recording(remote.RemoteBackend):
    def __init__(self, *a, **kw):
        super().__init__(*a, **kw)
        self.calls = []

    def _call(self, method, path, body=None, timeout=None):
        self.calls.append((path, dict(body or {})))
        return super()._call(method, path, body, timeout)

    def count(self, path):
        return sum(1 for p, _ in self.calls if p == path)


def write(path: Path, text: str = "x") -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


class SidecarBase(unittest.TestCase):
    max_entries = sc_ops.DEFAULT_MAX_ENTRIES

    def setUp(self):
        reuse = unittest.mock.patch.object(sc_index, "REUSE", 0.0)
        reuse.start()
        self.addCleanup(reuse.stop)
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.home = make_home(Path(self.tmp.name))
        self.ops = sc_ops.Ops(self.home, max_entries=self.max_entries)
        self.httpd = sc_server.make_server("127.0.0.1", 0, self.ops, TOKEN)
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()
        self.addCleanup(self.httpd.server_close)
        self.addCleanup(self.httpd.shutdown)

    def backend(self):
        return Recording(f"http://127.0.0.1:{self.httpd.server_port}", TOKEN, label="t")


class SidecarLimitTest(unittest.TestCase):
    """R1·D10: 기본 상한 50,000, 환경변수로 바꾼다. 잘못된 값이면 기본값."""

    def test_기본_상한은_50000(self):
        self.assertEqual(sc_ops.DEFAULT_MAX_ENTRIES, 50_000)

    def test_환경변수로_상한을_정하고_잘못된_값은_기본값(self):
        self.assertEqual(sc_ops.max_entries_from_env({"AAS_SIDECAR_MAX_ENTRIES": "150000"}), 150_000)
        self.assertEqual(sc_ops.max_entries_from_env({}), 50_000)
        for bad in ("", "abc", "0", "-5"):
            with self.subTest(bad=bad):
                self.assertEqual(sc_ops.max_entries_from_env({"AAS_SIDECAR_MAX_ENTRIES": bad}), 50_000)

    def test_사이드카_판은_AAS_판을_따른다(self):
        """사이드카는 AAS 와 같은 판(이미지 빌드 인자 AAS_VERSION → AAS_SIDECAR_VERSION)을 알린다. 없으면 dev(사용자 지시 2026-11-03)."""
        import subprocess
        code = "from aas_sidecar import ops; print(ops.Ops('.').version()['sidecar'])"
        side = str(Path(__file__).resolve().parents[1] / "sidecar")
        run = lambda env: subprocess.run([sys.executable, "-c", code], cwd=side, env={**os.environ, **env},
                                         capture_output=True, text=True, check=True).stdout.strip()
        self.assertEqual(run({"AAS_SIDECAR_VERSION": "1.0.5"}), "1.0.5")
        self.assertEqual(run({"AAS_SIDECAR_VERSION": ""}), "dev")

    def test_상한에_닿으면_그_폴더부터_partial_로_끊고_안은_stat_하지_않는다(self):
        """후속 F1(스펙 2026-11-03-003 D15·D17): 상한에 닿으면 목록 전체를 버리지 않는다. 다음 폴더를 열면 상한을 넘을 때 그 폴더와
        아직 열지 않은 폴더를 partial 로 적고 받은 만큼 낸다. 끊긴 폴더 안은 stat·해시하지 않는다(NFS 에서 하나에 8~20ms)."""
        with tempfile.TemporaryDirectory() as d:
            for i in range(8):
                write(Path(d) / "sub" / f"f{i}.txt")
            ops = sc_ops.Ops(Path(d), max_entries=5)
            with unittest.mock.patch.object(sc_ops.os, "lstat", wraps=os.lstat) as lst, \
                    unittest.mock.patch.object(sc_ops.Ops, "_sha256", side_effect=AssertionError("해시하면 안 된다")):
                out = ops.tree("", hashes=[], _listing=True)
        self.assertFalse(out["truncated"])
        self.assertTrue(out["cut"])
        self.assertEqual(out["partial"], ["sub"])
        self.assertEqual([e["path"] for e in out["entries"]], ["sub"])
        self.assertFalse([c for c in lst.call_args_list if "/sub/" in str(c.args[0])])

    def test_끊는_자리는_늘_같고_먼저_연_폴더는_온전하다(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            for name in ("a", "b", "c"):
                for i in range(3):
                    write(root / name / f"f{i}.txt")
            ops = sc_ops.Ops(root, max_entries=8)
            one, two = ops.tree("", _listing=True), ops.tree("", _listing=True)
        self.assertEqual(one, two)
        self.assertTrue(one["cut"])
        self.assertEqual(one["partial"], ["a", "b"])                 # 스택에서 c 를 먼저 연다(이름순으로 넣고 뒤에서 꺼냄)
        self.assertEqual(sorted(e["path"] for e in one["entries"]), ["a", "b", "c", "c/f0.txt", "c/f1.txt", "c/f2.txt"])
        self.assertLessEqual(len(one["entries"]), 8)

    def test_루트_폴더만으로_상한을_넘으면_예전처럼_잘림(self):
        with tempfile.TemporaryDirectory() as d:
            for i in range(8):
                write(Path(d) / f"f{i}.txt")
            ops = sc_ops.Ops(Path(d), max_entries=5)
            with unittest.mock.patch.object(sc_ops.Ops, "_sha256", side_effect=AssertionError("해시하면 안 된다")):
                out = ops.tree("", hashes=[], _listing=True)
        self.assertTrue(out["truncated"])
        self.assertEqual(out["entry_count"], 8)

    def test_상한_안이면_결과가_예전과_같다(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            for i in range(30):
                write(root / f"d{i % 3}" / f"f{i}.txt", f"v{i}")
            os.symlink(root / "d0", root / "link")
            out = sc_ops.Ops(root).tree("", hashes=[], _listing=True)
        self.assertFalse(out["truncated"])
        self.assertEqual(len(out["entries"]), 34)                     # 폴더 3 + 파일 30 + 심링크 폴더 1
        self.assertEqual([e["path"] for e in out["entries"]], sorted(e["path"] for e in out["entries"]))
        self.assertIn("link", out["partial"])
        self.assertTrue(all("sha256" in e for e in out["entries"] if e["type"] == "file"))
        self.assertTrue(all(e["size"] == len(f"v{e['path'].split('/f')[1][:-4]}") for e in out["entries"] if e["type"] == "file"))


class SidecarGlobSkipTest(unittest.TestCase):
    """R5: /v1/list 의 skip_dirs 는 그 이름의 폴더 안으로 들어가지 않는다. 키가 없으면 지금과 같다(옛 서버)."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        root = Path(self.tmp.name)
        write(root / "skills" / "a" / "SKILL.md")
        write(root / "skills" / "a" / "node_modules" / "p" / "SKILL.md")
        write(root / "skills" / "a" / "lib" / "b" / "SKILL.md")
        self.ops = sc_ops.Ops(root)

    def test_건너뛸_이름_안은_훑지_않는다(self):
        walked = []
        real = os.scandir

        def spy(path):
            walked.append(str(path))
            return real(path)
        with unittest.mock.patch.object(sc_ops.os, "scandir", side_effect=spy):
            out = self.ops.glob("skills", "**/SKILL.md", skip_dirs=["node_modules"])
        self.assertEqual([e["path"] for e in out["entries"]], ["skills/a/SKILL.md", "skills/a/lib/b/SKILL.md"])
        self.assertFalse([w for w in walked if "node_modules" in w])

    def test_키가_없으면_지금처럼_모두_찾는다(self):
        out = self.ops.glob("skills", "**/SKILL.md")
        self.assertEqual(len(out["entries"]), 3)


class SidecarHashCacheTest(unittest.TestCase):
    """R8·D13: 해시 캐시 상한은 상한에 비례하고, 목록마다 없는 키를 지워 통째로 비우지 않는다."""

    def test_캐시_상한은_항목_상한에_비례한다(self):
        with tempfile.TemporaryDirectory() as d:
            self.assertEqual(sc_ops.Ops(Path(d)).hash_cap, 100_000)
            self.assertEqual(sc_ops.Ops(Path(d), max_entries=150_000).hash_cap, 300_000)
            self.assertEqual(sc_ops.Ops(Path(d), max_entries=10).hash_cap, 50_000)

    def test_파일_하나를_고쳐도_다른_파일은_다시_해시하지_않고_옛_키는_지운다(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            for i in range(3):
                write(root / f"f{i}.txt", f"v{i}")
            ops = sc_ops.Ops(root)
            ops.tree("", hashes=[], _listing=True)
            self.assertEqual(len(ops._hashes), 3)
            write(root / "f1.txt", "changed and longer")
            with unittest.mock.patch.object(sc_ops.hashlib, "sha256", wraps=hashlib.sha256) as sha:
                ops.tree("", hashes=[], _listing=True)
            self.assertEqual(sha.call_count, 1)
            self.assertEqual(len(ops._hashes), 3)

    def test_다른_범위의_키는_지우지_않는다(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            write(root / "a" / "x.txt")
            write(root / "b" / "y.txt")
            ops = sc_ops.Ops(root)
            ops.tree("b", hashes=[], _listing=True)
            ops.tree("a", hashes=[], _listing=True)
            self.assertEqual(sorted(k[0] for k in ops._hashes), ["a/x.txt", "b/y.txt"])


class SidecarChangesTruncatedTest(SidecarBase):
    """R7·D12·F1: 커서 뒤 목록이 상한에 닿으면 끊긴 폴더를 partial 로 알린다. 없어졌다고 알리는 경로는 모두 끊긴 폴더 안이다
    (서버가 있는 파일을 「없음」으로 답하지 않는다). 루트만으로 넘으면 reset·truncated."""

    def test_끊기면_없어짐은_끊긴_폴더_안뿐(self):
        first = self.ops.tree("", cursor=True, hashes=[], _listing=False)
        self.ops.max_entries = len(first["entries"]) + 1
        for i in range(5):
            write(self.home / "skills" / "big" / f"f{i}.md")
        out = self.ops.changes(first["cursor"], "", hashes=[])
        self.assertFalse(out.get("truncated"))
        self.assertTrue(out["partial"])
        cut = tuple(p + "/" for p in out["partial"])
        self.assertTrue(all(p.startswith(cut) for p in out.get("removed", [])), (out.get("removed"), out["partial"]))

    def test_루트만으로_넘으면_reset_과_truncated(self):
        first = self.ops.tree("", cursor=True, hashes=[], _listing=False)
        self.ops.max_entries = 2                                       # 시험 폴더 루트에 항목이 4개
        out = self.ops.changes(first["cursor"], "", hashes=[])
        self.assertTrue(out["reset"])
        self.assertTrue(out["truncated"])
        self.assertNotIn("removed", out)


class TruncatedTreeMemoTest(SidecarBase):
    """R3·D6: 잘린 묶음은 10분 동안 실패로 기억해 /v1/tree 를 다시 받지 않는다. 경고는 에이전트마다 한 번.
    기존 실패 기억(fail_memo 30초)과 따로 둔다. 후속 F1 뒤에는 루트 폴더만으로 상한을 넘을 때만 잘린다."""

    max_entries = 3                                                   # 시험 폴더 루트에 항목이 4개

    def test_잘린_묶음은_한_번만_받고_경고는_한_번(self):
        b = self.backend()
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            self.assertFalse(b.snapshot())
            self.assertFalse(b.snapshot())
            self.assertIsNone(b.fingerprint())
        self.assertEqual(b.count("/v1/tree"), 1)
        self.assertEqual(buf.getvalue().count("AAS_SIDECAR_MAX_ENTRIES"), 1)
        self.assertEqual(b._tree_failed_at, 0.0)                     # 30초 실패 기억은 쓰지 않는다
        self.assertEqual(remote.TRUNCATED_MEMO, 600.0)

    def test_기억이_끝나면_다시_받는다(self):
        b = self.backend()
        with contextlib.redirect_stdout(io.StringIO()):
            b.snapshot()
            b._tree_truncated_at -= remote.TRUNCATED_MEMO + 1
            b.snapshot()
        self.assertEqual(b.count("/v1/tree"), 2)


class CutTreeServerTest(SidecarBase):
    """후속 F1: 사이드카가 끊어 보낸 묶음(cut)을 서버가 그대로 쓴다. 끊긴 폴더 안은 사이드카에 묻고, 경고는 한 번, 잘림 기억은 없다.
    커서를 받은 뒤 폴더가 상한을 넘어도 있는 파일을 「없음」으로 답하지 않는다(R7)."""

    def setUp(self):
        super().setUp()
        for i in range(6):
            write(self.home / "skills" / "bulk" / f"d{i}" / "x.md", "x")

    def test_끊긴_묶음을_쓰고_끊긴_폴더_안은_사이드카에_묻는다(self):
        b = self.backend()
        self.ops.max_entries = 20
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            self.assertTrue(b.snapshot())
            b.fingerprint()
        tree = b.current_tree()
        self.assertTrue(tree.partial)
        self.assertEqual(b._tree_truncated_at, 0.0)
        self.assertEqual(buf.getvalue().count("끊었습니다"), 1)
        for rel in ("config.yaml", "skills/bulk/d0/x.md", "skills/bulk/d5/x.md", "skills/ops/report/SKILL.md"):
            self.assertTrue(remote.RemotePath(b, rel).exists(), rel)
        local = sorted(str(p.relative_to(self.home)) for p in hr.search_rglob(self.home / "skills", "*.md"))
        got = sorted(str(p.relative_to(remote.RemotePath(b, ""))) for p in hr.search_rglob(remote.RemotePath(b, "skills"), "*.md"))
        self.assertEqual(got, local)

    def test_변경분이_끊겨도_있는_파일을_없다고_하지_않는다(self):
        b = self.backend()
        self.assertTrue(b.snapshot())
        self.ops.max_entries = b.entry_count() + 1
        for i in range(5):
            write(self.home / "skills" / "big" / f"f{i}.md")
        b._tree.taken -= remote.TREE_TTL + 1
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertTrue(b.snapshot())
        for rel in ("skills/big/f4.md", "config.yaml", "skills/bulk/d3/x.md"):
            self.assertTrue(remote.RemotePath(b, rel).exists(), rel)


class SkipDirsTest(unittest.TestCase):
    """R2: 의존성 이름은 기본으로 건너뛰고, 환경변수로 더하기만 한다. mcp-tokens·home 은 늘 남는다."""

    def test_기본_목록에_의존성_이름이_들고_보안_이름이_남는다(self):
        names = remote.tree_skip_dirs({})
        for n in ("mcp-tokens", "home", "node_modules", "site-packages", ".venv", "lazy-packages", ".gradle", ".terraform"):
            self.assertIn(n, names)
        for n in ("vendor", "target", "build", "env"):
            self.assertNotIn(n, names)

    def test_환경변수는_더하기만_하고_잘못된_이름은_버린다(self):
        names = remote.tree_skip_dirs({"AAS_TREE_SKIP_DIRS_EXTRA": " vendor, ,a/b,..,target ,mcp-tokens"})
        self.assertIn("vendor", names)
        self.assertIn("target", names)
        self.assertNotIn("a/b", names)
        self.assertNotIn("..", names)
        self.assertNotIn("", names)
        self.assertEqual(names.count("mcp-tokens"), 1)
        self.assertIn("home", names)

    def test_찾기용_이름에는_보안_폴더와_홈이_없다(self):
        names = remote.search_skip_dirs({"AAS_TREE_SKIP_DIRS_EXTRA": "vendor"})
        for n in (".git", "cache", ".cache", "logs", "__pycache__", "node_modules", ".venv", "vendor"):
            self.assertIn(n, names)
        for n in ("mcp-tokens", "home", "workspace", "sessions"):
            self.assertNotIn(n, names)


class SearchRglobTest(SidecarBase):
    """R5·D11: 찾기·집계용 재귀 목록은 의존성 폴더를 건너뛴다. 묶음이 있으면 사이드카에 묻지 않고, 없으면 skip_dirs 를 싣고
    받은 결과를 서버가 한 번 더 거른다. 로컬 Path 와 같은 결과."""

    def setUp(self):
        super().setUp()
        s = self.home / "skills" / "dev" / "web"
        write(s / "SKILL.md", "---\nname: web\n---\n")
        write(s / "node_modules" / "p" / "SKILL.md", "---\nname: inner\n---\n")
        write(s / ".venv" / "lib" / "x.py", "x")
        write(s / "tool.py", "print(1)")

    def rels(self, paths, base):
        return sorted(str(p.relative_to(base)) for p in paths)

    def test_묶음이_있으면_사이드카에_묻지_않고_로컬과_같다(self):
        b = self.backend()
        self.assertTrue(b.snapshot())
        before = b.count("/v1/list")
        got = self.rels(hr.search_rglob(remote.RemotePath(b, "skills"), "*"), remote.RemotePath(b, "skills"))
        want = self.rels(hr.search_rglob(self.home / "skills", "*"), self.home / "skills")
        self.assertEqual(got, want)
        self.assertEqual(b.count("/v1/list"), before)
        self.assertFalse([p for p in got if "node_modules" in p or ".venv" in p])
        self.assertIn("dev/web/tool.py", got)

    def test_묶음이_없으면_skip_dirs_를_싣고_결과를_거른다(self):
        b = self.backend()
        got = self.rels(hr.search_rglob(remote.RemotePath(b, "skills"), "SKILL.md"), remote.RemotePath(b, "skills"))
        self.assertEqual(got, self.rels(hr.search_rglob(self.home / "skills", "SKILL.md"), self.home / "skills"))
        sent = [body for p, body in b.calls if p == "/v1/list"]
        self.assertTrue(sent and "node_modules" in sent[-1].get("skip_dirs", []))

    def test_옛_사이드카가_skip_dirs_를_무시해도_결과가_같다(self):
        real = sc_ops.Ops.glob
        with unittest.mock.patch.object(sc_ops.Ops, "glob", lambda self, rel, pattern, skip_dirs=None: real(self, rel, pattern)):
            b = self.backend()
            got = self.rels(hr.search_rglob(remote.RemotePath(b, "skills"), "SKILL.md"), remote.RemotePath(b, "skills"))
        self.assertNotIn("dev/web/node_modules/p/SKILL.md", got)

    def test_스킬_찾기는_의존성_폴더_안_SKILL_md_를_스킬로_보지_않는다(self):
        names = [md.parent.name for _, md in hr.skill_files(self.home)]
        self.assertIn("web", names)
        self.assertNotIn("p", names)


class CredentialsNoUsageTest(SidecarBase):
    """R4·D5: 색인 없는 자격증명은 사용처 집계와 secrets 참조 찾기를 하지 않고 「쓰는 곳 없음」을 붙이지 않는다.
    같은 묶음에서 색인 있는 결과와 섞이지 않는다(OV1)."""

    def setUp(self):
        super().setUp()
        write(self.home / "secrets" / "gmail.json", '{"token": "abc"}')
        write(self.home / "skills" / "ops" / "mail" / "SKILL.md", "---\nname: mail\n---\nsecrets/gmail.json 를 읽는다\n")

    def test_색인_없이는_집계를_부르지_않는다(self):
        with unittest.mock.patch.object(inventory, "_usage_index", side_effect=AssertionError("부르면 안 된다")):
            items = inventory.credentials(self.home, usage=False)["items"]
        self.assertTrue(items)
        self.assertFalse([i for i in items if "쓰는 곳을 찾지 못함" in i["flags"]])
        self.assertFalse([i for i in items if "_fname" in i])

    def test_같은_묶음에서_두_결과가_섞이지_않는다(self):
        b = self.backend()
        home = remote.RemotePath(b, "")
        self.assertTrue(b.snapshot())
        quick = inventory.credentials(home, usage=False)["items"]
        full = inventory.credentials(home)["items"]
        mail = [i for i in full if i["name"] == "gmail.json"]
        self.assertTrue(mail and mail[0]["used_count"] >= 1, mail)
        self.assertTrue(all(i["used_count"] == 0 for i in quick))
        self.assertEqual(sorted(i["id"] for i in quick), sorted(i["id"] for i in full))


class ConsumersUseNoUsageTest(unittest.TestCase):
    """D5·OV1: 홈 요약 수집과 프로파일 줄은 색인 없는 자격증명을 쓰고, 프로파일 줄은 서버 캐시 키도 따로 쓴다."""

    def test_홈_요약은_색인_없이(self):
        from aas.ops import dashboard
        pod = unittest.mock.Mock(hermes_home=Path("/nowhere"), container="c")
        totals = {"profiles": 1, "gateways_up": 1, "profiles_with_bad": 0, "messengers_connected": 0, "messengers_total": 0}
        creds = unittest.mock.Mock(return_value={"items": [{"flags": ["3일 뒤 만료"]}]})
        with unittest.mock.patch("aas.ops.channels.collect", return_value={"totals": totals}), \
                unittest.mock.patch.object(inventory, "credentials", creds):
            out = dashboard.pod_values(pod)
        creds.assert_called_once_with(pod.hermes_home, usage=False)
        self.assertEqual(out["creds_expiring"], 1)

    def test_프로파일_줄은_색인_없는_결과를_따로_된_캐시_키로(self):
        from aas.web import server
        pod = unittest.mock.Mock(id="p1", hermes_home=Path("/nowhere"))
        keys = []

        def cached(key, ttl, fn, *a, **kw):
            keys.append(key)
            return fn()
        creds = unittest.mock.Mock(return_value={"items": []})
        with unittest.mock.patch.object(server, "_cached", side_effect=cached), \
                unittest.mock.patch.object(server.inventory, "credentials", creds), \
                unittest.mock.patch.object(server, "HermesAPI"), unittest.mock.patch.object(server, "hub"), \
                unittest.mock.patch.object(server, "_agents"), unittest.mock.patch.object(server, "_channels"), \
                unittest.mock.patch.object(server, "_models"), unittest.mock.patch.object(server, "_health"), \
                unittest.mock.patch.object(server.activity, "collect"), \
                unittest.mock.patch.object(server.cron_health.hr, "mcp_server_names", return_value=[]), \
                unittest.mock.patch.object(server.profiles, "summarize", return_value=[]):
            server._profile_rows(pod)
        creds.assert_called_once_with(pod.hermes_home, usage=False)
        self.assertIn("p1:credentials_nousage", keys)
        self.assertNotIn("p1:credentials", keys)


class LibrariesBatchReadTest(SidecarBase):
    """R9·D14: 라이브러리 목록은 top_level.txt 를 패키지마다 읽지 않고 묶어 읽는다."""

    def test_사이드카_read_호출이_패키지_수보다_적다(self):
        site = self.home / "profiles" / "alpha" / ".venvs" / "tools" / "lib" / "python3.12" / "site-packages"
        for i in range(8):
            d = site / f"pkg{i}-1.0.dist-info"
            write(d / "top_level.txt", f"pkg{i}\n")
        b = self.backend()
        self.assertTrue(b.snapshot())
        before = b.count("/v1/read")
        got = inventory.libraries(remote.RemotePath(b, ""))
        want = inventory.libraries(self.home)
        self.assertLess(b.count("/v1/read") - before, 8)
        names = lambda r: sorted(i["name"] for i in r["items"] if i.get("env", "").startswith("profiles/alpha/.venvs"))
        self.assertEqual(names(got), names(want))
        self.assertTrue([n for n in names(got) if n.startswith("pkg")])


if __name__ == "__main__":
    unittest.main()

# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""스킬 묶음과 템플릿 참고 파일에서 의존성·실행 기록 폴더를 뺀다(스펙 2026-11-18-019, OMAI-2119).
로컬과 원격(묶음 길·사이드카 대체 길)이 같은 결과를 내고, 원격에서 그 폴더 안을 사이드카에 묻지 않는다. 뺀 것은 한 줄로 보인다."""
import io
import json
import os
import sys
import tempfile
import threading
import unittest
import unittest.mock
import zipfile
from pathlib import Path
from unittest import mock

TMP = tempfile.TemporaryDirectory()
os.environ.setdefault("AAS_DATA_DIR", str(Path(TMP.name) / "data"))
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "sidecar"))

from aas_sidecar import index as sc_index, ops as sc_ops, server as sc_server  # noqa: E402

from aas.hermes.readers import remote  # noqa: E402
from aas.market import market_publish as mp, marketplace as mk, profile_template as pt, skill_keep  # noqa: E402
from aas.market.marketplace import MarketError  # noqa: E402
from aas.web import skill_files  # noqa: E402

TOKEN = "bundle-skip-token-0123456789abcdef"
SKILL = "---\nname: web\ndescription: Builds the weekly sales report every Monday\n---\nbody"


def write(path: Path, text: str = "x") -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


class Recording(remote.RemoteBackend):
    def __init__(self, *a, **kw):
        super().__init__(*a, **kw)
        self.calls = []

    def _call(self, method, path, body=None, timeout=None):
        self.calls.append((path, dict(body or {})))
        return super()._call(method, path, body, timeout)

    def count(self, path):
        return sum(1 for p, _ in self.calls if p == path)


def skill_tree(s: Path) -> None:
    """스킬 하나: 담을 것과 뺄 것을 섞는다."""
    write(s / "SKILL.md", SKILL)
    write(s / "scripts" / "run.py", "print(1)")
    write(s / "site-packages" / "pkg" / "a.py")             # 의존성 — 어느 깊이든 뺀다
    write(s / "lib" / "venv" / "b.py")
    write(s / "logs" / "run.log")                           # 실행 기록 — 바로 아래 폴더만 뺀다
    write(s / "cache" / "c.json")
    write(s / "sessions" / "s.json")
    write(s / "terminal-sessions" / "t.txt")
    write(s / "mcp-tokens" / "tok.json")
    write(s / "data" / "mcp-tokens" / "tok.json")           # mcp-tokens 는 어느 깊이든 뺀다
    write(s / "templates" / "sessions" / "x.md", "keep")    # 더 깊은 같은 이름은 담는다
    write(s / "data" / "cache" / "i.json", "keep")
    write(s / "backup" / "state.json", "keep")              # D5
    write(s / "__pycache__" / "x.pyc")                      # 실행 부산물 — 줄에 넣지 않는다
    write(s / ".github" / "logs" / "w.txt")                 # 점 조상 — 줄에 넣지 않는다


KEEP = ["SKILL.md", "backup/state.json", "data/cache/i.json", "scripts/run.py", "templates/sessions/x.md"]
SKIPPED = ["cache", "data/mcp-tokens", "lib/venv", "logs", "mcp-tokens", "sessions", "site-packages", "terminal-sessions"]


class LocalCollectTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(dir=TMP.name))
        self.s = self.tmp / "skills" / "dev" / "web"
        skill_tree(self.s)

    def test_실행_기록은_바로_아래만_의존성은_어디든_뺀다(self):
        skipped: list = []
        rels = [r for r, _ in mp.collect(self.s, skipped=skipped)]
        self.assertEqual(rels, KEEP)
        self.assertEqual(skipped, SKIPPED)

    def test_바로_아래_같은_이름의_파일은_담는다(self):
        s2 = self.tmp / "skills" / "dev" / "two"
        write(s2 / "SKILL.md", SKILL)
        write(s2 / "cache", "file")
        self.assertIn("cache", [r for r, _ in mp.collect(s2)])

    def test_EXTRA_는_묶음_내용에_쓰지_않는다(self):
        write(self.s / "myvendor" / "v.py")
        with mock.patch.dict(os.environ, {"AAS_TREE_SKIP_DIRS_EXTRA": "myvendor"}):
            self.assertIn("myvendor/v.py", [r for r, _ in mp.collect(self.s)])

    def test_한도에_걸려도_뺀_목록은_완전하다(self):
        for i in range(mp.MAX_FILES + 1):
            write(self.s / "many" / f"{i:03}.txt")
        skipped: list = []
        with self.assertRaises(MarketError):
            mp.collect(self.s, skipped=skipped)
        self.assertEqual(skipped, SKIPPED)

    def test_부산물과_점_폴더만_있으면_목록이_비었다(self):
        s = self.tmp / "skills" / "dev" / "plain"
        write(s / "SKILL.md", SKILL)
        write(s / "__pycache__" / "a.pyc")
        write(s / ".venv" / "logs" / "x")
        skipped: list = []
        mp.collect(s, skipped=skipped)
        self.assertEqual(skipped, [])
        self.assertIsNone(mp.skipped_line(skipped))

    def test_덮기_판정_digest_는_그대로(self):
        d = skill_keep.digest(self.s)
        self.assertIn("logs/run.log", d)                    # 019 는 walk·digest 를 고치지 않는다
        self.assertIn("cache/c.json", d)

    def test_실행_기록_이름은_사이드카_목록의_부분_집합(self):
        self.assertLessEqual(mp.RUN_LOG_DIRS, set(remote.TREE_SKIP_DIRS))


class SkippedLineTest(unittest.TestCase):
    def test_문구(self):
        line = mp.skipped_line(["lib/site-packages", "logs"])
        self.assertIn("lib/site-packages, logs", line["message"])
        self.assertIn("requirements", line["message"])      # 의존성이 빠졌으면 설치 안내
        self.assertIn("data/logs", line["message"])          # 실행 기록이 빠졌으면 한 단계 아래로
        self.assertEqual(line["paths"], ["lib/site-packages", "logs"])
        self.assertTrue(line["doc"])
        only_log = mp.skipped_line(["logs"])["message"]
        self.assertNotIn("requirements", only_log)

    def test_다섯_개와_외_N개(self):
        names = [f"x{i}/site-packages" for i in range(7)]
        line = mp.skipped_line(names)
        self.assertIn("2", line["message"].split(names[4])[1])
        self.assertEqual(len(line["paths"]), 7)

    def test_원격_확인_못함(self):
        a = mp.skipped_line(["logs"])["message"]
        b = mp.skipped_line(["logs"], incomplete=["skills/x"])["message"]
        self.assertGreater(len(b), len(a))                  # 대체 길이면 「목록이 완전하지 않을 수 있다」를 붙인다
        self.assertIsNotNone(mp.skipped_line([], incomplete=["skills/x"]))


class SidecarBase(unittest.TestCase):
    def setUp(self):
        reuse = unittest.mock.patch.object(sc_index, "REUSE", 0.0)
        reuse.start()
        self.addCleanup(reuse.stop)
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.home = Path(self.tmp.name) / "hermes"
        self.s = self.home / "skills" / "dev" / "web"
        skill_tree(self.s)
        self.ops = sc_ops.Ops(self.home)
        self.httpd = sc_server.make_server("127.0.0.1", 0, self.ops, TOKEN)
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()
        self.addCleanup(self.httpd.server_close)
        self.addCleanup(self.httpd.shutdown)

    def backend(self, snap=True):
        b = Recording(f"http://127.0.0.1:{self.httpd.server_port}", TOKEN, label="t")
        if snap:
            self.assertTrue(b.snapshot())
        return b


class RemoteCollectTest(SidecarBase):
    def test_묶음_길은_로컬과_같고_실행_기록_안을_묻지_않는다(self):
        b = self.backend()
        before = b.count("/v1/list")
        skipped: list = []
        incomplete: list = []
        rels = [r for r, _ in mp.collect(remote.RemotePath(b, "skills/dev/web"), skipped=skipped, incomplete=incomplete)]
        self.assertEqual(rels, KEEP)
        self.assertEqual(skipped, SKIPPED)
        self.assertEqual(incomplete, [])                    # 깊은 같은 이름 폴더 다시 훑기는 「불완전」으로 치지 않는다(OKE 실화면 2026-11-18)
        # 깊은 같은 이름 폴더(templates/sessions·data/cache)만 하나씩 다시 훑는다(사이드카가 안을 보지 않은 폴더)
        self.assertEqual(b.count("/v1/list") - before, 2)

    def test_실행_기록_폴더만_있으면_사이드카에_묻지_않는다(self):
        s = self.home / "skills" / "dev" / "plain"
        write(s / "SKILL.md", SKILL)
        write(s / "logs" / "a.log")
        write(s / "cache" / "b")
        b = self.backend()
        before = b.count("/v1/list")
        rels = [r for r, _ in mp.collect(remote.RemotePath(b, "skills/dev/plain"))]
        self.assertEqual(rels, ["SKILL.md"])
        self.assertEqual(b.count("/v1/list"), before)

    def test_대체_길은_한_번만_묻고_불완전을_알린다(self):
        write(self.s / "home" / "note.md", "keep")           # home 은 묶음이 안을 보지 않는다 → 대체 길
        b = self.backend()
        before = b.count("/v1/list")
        skipped: list = []
        incomplete: list = []
        rels = [r for r, _ in mp.collect(remote.RemotePath(b, "skills/dev/web"), skipped=skipped, incomplete=incomplete)]
        self.assertEqual(rels, sorted(KEEP + ["home/note.md"]))
        self.assertEqual(b.count("/v1/list") - before, 1)
        self.assertTrue(incomplete)
        self.assertFalse([p for p in skipped if "incomplete" in p])   # 표지는 경로 목록에 섞이지 않는다
        self.assertIn("logs", skipped)                       # 바로 아래 실행 기록은 대체 길에서도 안다

    def test_기본값은_018_처럼_건너뛴_이름을_다시_묻는다(self):
        b = self.backend(snap=False)                       # 묶음 없음 — 대체 길
        found: set = set()
        remote.search_rglob(remote.RemotePath(b, "skills/dev/web"), "*", frozenset(["site-packages"]), skipped=found)
        self.assertGreater(b.count("/v1/list"), 1)          # skipped_probe 기본 True — 018 walk(skipped=…) 동작 그대로
        self.assertIn("site-packages", found)
        b2 = self.backend(snap=False)
        inc: list = []
        remote.search_rglob(remote.RemotePath(b2, "skills/dev/web"), "*", frozenset(["site-packages"]), skipped=set(),
                            skipped_probe=False, incomplete=inc)
        self.assertEqual(b2.count("/v1/list"), 1)
        self.assertEqual(inc, ["skills/dev/web"])


class PublishCheckTest(unittest.TestCase):
    def setUp(self):
        self.home = Path(tempfile.mkdtemp(dir=TMP.name))
        self.root = self.home / "profiles" / "ma"
        skill_tree(self.root / "skills" / "local" / "web")
        self._p = [mock.patch.object(mk, "settings", return_value={"url": "http://hub", "token_file": "", "namespaces": ["free", "paid"]}),
                   mock.patch.object(mk, "install_state", return_value={"enabled": True}),
                   mock.patch.object(mk, "fetch", side_effect=MarketError("없음", 404))]
        for p in self._p:
            p.start()
            self.addCleanup(p.stop)

    def test_점검에_뺀_폴더_줄(self):
        out = mp.check_publish("p1", self.home, "kim@x.io", False, "ma", "skills/local/web", hub=False)
        line = next(c for c in out["checks"] if c["id"] == "skipped_dirs")
        self.assertEqual(line["level"], "warn")
        self.assertEqual(line["paths"], SKIPPED)

    def test_한도_실패와_줄이_함께_files_먼저(self):
        for i in range(mp.MAX_FILES + 1):
            write(self.root / "skills" / "local" / "web" / "many" / f"{i:03}.txt")
        out = mp.check_publish("p1", self.home, "kim@x.io", False, "ma", "skills/local/web", hub=False)
        ids = [c["id"] for c in out["checks"]]
        self.assertIn("skipped_dirs", ids)
        self.assertLess(ids.index("files"), ids.index("skipped_dirs"))


class DownloadTest(unittest.TestCase):
    def setUp(self):
        self.home = Path(tempfile.mkdtemp(dir=TMP.name))
        skill_tree(self.home / "profiles" / "ma" / "skills" / "local" / "web")

    def test_EXCLUDED_txt_폴더_구역과_반환값(self):
        dirs: list = []
        name, blob, excluded = skill_files.build_download(self.home, "ma", "skills/local/web", skipped_dirs=dirs)
        self.assertEqual(excluded, [])
        self.assertEqual(dirs, SKIPPED)
        z = zipfile.ZipFile(io.BytesIO(blob))
        note = z.read(skill_files.EXCLUDED_NOTE).decode()
        self.assertIn("site-packages", note)
        self.assertNotIn("logs/run.log", z.namelist())

    def test_뺀_폴더가_없으면_EXCLUDED_txt_없음(self):
        s = self.home / "profiles" / "ma" / "skills" / "local" / "plain"
        write(s / "SKILL.md", SKILL)
        dirs: list = []
        _n, blob, _e = skill_files.build_download(self.home, "ma", "skills/local/plain", skipped_dirs=dirs)
        self.assertEqual(dirs, [])
        self.assertNotIn(skill_files.EXCLUDED_NOTE, zipfile.ZipFile(io.BytesIO(blob)).namelist())


class TemplateTest(unittest.TestCase):
    def setUp(self):
        self.home = Path(tempfile.mkdtemp(dir=TMP.name))
        ws = self.home / "workspace"
        write(ws / "report.md")
        write(ws / "venv" / "a.md")
        write(ws / "lib" / "site-packages" / "b.md")
        write(ws / "logs" / "keep.md")
        write(ws / "cache" / "keep.md")

    def test_참고_파일_후보에서_의존성만_뺀다(self):
        got = sorted(f["path"] for f in pt.workspace_files(self.home))
        self.assertEqual(got, ["cache/keep.md", "logs/keep.md", "report.md"])

    def test_고른_파일의_의존성_경로는_거절(self):
        errs = []

        def err(code, message, **extra):
            errs.append({"code": code, "message": message, **extra})
        for rel in ["venv/a.md", "VENV/a.md", "lib/site-packages/b.md"]:
            errs.clear()
            out, _needs = pt.reference_files(self.home, [{"path": rel}], err)
            self.assertEqual(out, [], rel)
            self.assertEqual(errs[0]["code"], "file_path", rel)
        errs.clear()
        pt.reference_files(self.home, [{"path": "venv/a.md"}], err)
        self.assertEqual(errs[0].get("reason"), "dependency_dir")
        self.assertIn("venv", errs[0]["message"])
        errs.clear()
        out, _ = pt.reference_files(self.home, [{"path": "logs/keep.md"}], err)
        self.assertEqual([r["path"] for r in out], ["logs/keep.md"])

    def test_설치_경로_검사는_그대로(self):
        from aas.market import template_checks
        self.assertEqual(template_checks.file_path_problem("logs/a.md"), "")
        self.assertEqual(template_checks.file_path_problem("venv/a.md"), "")


if __name__ == "__main__":
    unittest.main()

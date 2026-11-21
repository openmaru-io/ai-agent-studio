# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""프로파일 템플릿 3단계 시험(스펙 2026-11-18-002) — AGENTS.md·참고 파일 담기(D5 파일마다 확인, E10 경로), 설치 뒤 단계의 색인·다시 하기·
retryable 아님·「확인할 것」, 허브 스킬을 적힌 판으로(E6)."""
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import yaml

TMP = tempfile.TemporaryDirectory()
os.environ["AAS_DATA_DIR"] = str(Path(TMP.name) / "data")

from aas.market import market_dispatch, market_publish as mp, marketplace as mk, profile_template as pt, template_post as tp  # noqa: E402


def put(root: Path, files: dict):
    for rel, data in files.items():
        p = root / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        (p.write_bytes if isinstance(data, bytes) else p.write_text)(data)


class FilesBuildTest(unittest.TestCase):
    def setUp(self):
        self.home = Path(tempfile.mkdtemp(dir=TMP.name))
        put(self.home / "profiles" / "sales", {"SOUL.md": "나는 영업 도우미", "AGENTS.md": "견적은 표로 정리한다"})
        put(self.home / "workspace", {"양식/견적서.xlsx": b"PK\x03\x04\x00\x00binary", "안내.md": "제안서 작성 순서", "비밀.txt": "token glpat-AAAAAAAAAAAAAAAAAAAAAAAA",
                                      ".hidden": "x", "node_modules/a.js": "x"})
        for f in mp._dir().glob("*"):
            f.unlink()
        self._p = [mock.patch.object(mk, "settings", return_value={"url": "http://hub", "token_file": "", "namespaces": ["free", "paid"]}),
                   mock.patch.object(mk, "fetch", side_effect=mk.MarketError("없음", 404)), mock.patch.object(mk, "default_packages", return_value=[])]
        for p in self._p:
            p.start()

    def tearDown(self):
        for p in self._p:
            p.stop()

    def build(self, **kw):
        return pt.build("p1", self.home, "sales", name="sales", description="영업 제안서와 견적을 돕는 프로파일입니다", namespace="paid", author="김", who="kim@x.io", **kw)

    def test_agents_and_text_file_go_in_and_binary_waits_for_confirmation(self):
        out = self.build(ref_files=[{"path": "안내.md"}, {"path": "양식/견적서.xlsx"}])
        files = dict(out["files"])
        self.assertEqual(files["template/AGENTS.md"].decode(), "견적은 표로 정리한다")
        self.assertIn("template/files/안내.md", files)
        self.assertNotIn("template/files/양식/견적서.xlsx", files)
        self.assertEqual(out["needs_confirmation"], ["양식/견적서.xlsx"])
        out = self.build(ref_files=[{"path": "양식/견적서.xlsx", "confirmed": True}], agents=False)
        files = dict(out["files"])
        self.assertIn("template/files/양식/견적서.xlsx", files)
        self.assertNotIn("template/AGENTS.md", files)
        meta = yaml.safe_load(files["agent/distribution.yaml"])["aas"]
        self.assertEqual(meta["files"][0]["confirmed_by"], "kim@x.io")
        self.assertFalse(meta["agents"])

    def test_text_file_with_secret_and_bad_paths_are_errors(self):
        codes = [e["code"] for e in self.build(ref_files=[{"path": "비밀.txt"}])["errors"]]
        self.assertIn("secret_found", codes)
        for bad in ("../etc/passwd", "/abs", "a/.env", "없는파일.txt"):
            self.assertIn("file_path", [e["code"] for e in self.build(ref_files=[{"path": bad}])["errors"]], bad)

    def test_agents_over_limit_is_refused(self):
        put(self.home / "profiles" / "sales", {"AGENTS.md": "가" * (pt.MAX_AGENTS + 1)})
        self.assertIn("agents_too_long", [e["code"] for e in self.build()["errors"]])
        self.assertEqual(self.build(agents=False)["errors"], [])

    def test_workspace_listing_skips_hidden_and_skip_dirs(self):
        self.assertEqual([f["path"] for f in pt.workspace_files(self.home)], ["비밀.txt", "안내.md", "양식/견적서.xlsx"])

    def test_publish_returns_needs_confirmation_without_publishing(self):
        with mock.patch.object(mp, "_post") as post:
            out = pt.publish("p1", self.home, "sales", "kim@x.io", admin=False, name="sales", description="영업 제안서와 견적을 돕는 프로파일입니다",
                             namespace="paid", author="김", ref_files=[{"path": "양식/견적서.xlsx"}])
        self.assertEqual(out["status"], "needs_confirmation")
        post.assert_not_called()
        self.assertEqual(pt.used_today("kim@x.io"), [])


ROW = {"id": "20261118100000000000-abcdef", "pod": "p1", "profile": "sales", "package": "paid/sales", "namespace": "paid", "name": "sales", "version": "1.0.0",
       "kind": "agent", "mode": "install", "status": "queued", "who": "kim@x.io", "ts": "2026-11-18T10:00:00+09:00", "template": "paid/sales",
       "template_version": "1.0.0", "env_names": [], "waiting_mcp": []}


class PostStepsTest(unittest.TestCase):
    def setUp(self):
        for d in ("queue", "done"):
            for p in mk._dir(d).glob("*"):
                p.unlink()
        for p in tp._dir().glob("*"):
            p.unlink()

    def finish(self, **kw):
        row = {**ROW, **kw}
        market_dispatch._write("queue", row)
        market_dispatch._close(row, "done", "설치했습니다")
        return row

    def test_done_template_row_is_indexed_and_steps_recorded(self):
        self.finish()
        self.assertEqual([e["id"] for e in tp.entries()], [ROW["id"]])
        seen = []
        ops = {s: (lambda s: lambda r: seen.append(s) or "")(s) for s in tp.STEPS}
        tp.cycle(lambda r: ops)
        self.assertEqual(seen, list(tp.STEPS))
        rec = next(r for r in mk.installed("p1") if r["profile"] == "sales")
        self.assertEqual({k: v["state"] for k, v in rec["post"].items()}, {s: "ok" for s in tp.STEPS})
        self.assertEqual(tp.entries(), [])

    def test_failed_step_retries_only_itself_then_waits_for_a_person(self):
        self.finish()
        calls = {"b": 0, "c": 0}

        def b(_r):
            calls["b"] += 1
            return ""

        def c(_r):
            calls["c"] += 1
            raise tp.StepError("download 503")
        ops = {"b": b, "c": c}
        now = 1000.0
        for _ in range(5):
            entry = next(iter(tp.entries()), None)
            if entry is None:
                break
            tp.run_one(entry, ops, now=now)
            now += tp.RETRY_GAP + 1
        self.assertEqual((calls["b"], calls["c"]), (1, tp.MAX_TRIES))       # 성공한 단계는 다시 하지 않는다
        self.assertEqual(tp.entries(), [])
        rec = next(r for r in mk.installed("p1") if r["profile"] == "sales")
        self.assertEqual((rec["post"]["c"]["tries"], rec["post"]["c"]["reason"]), (3, "download 503"))
        issue = tp.issues("p1", "sales", mk.installed("p1"))
        self.assertEqual((issue[0]["code"], issue[0]["retry"]), ("template_post", ROW["id"]))
        self.assertTrue(tp.retry(ROW["id"]))
        tp.run_one(tp.entries()[0], {"c": lambda r: "1"}, now=now)
        rec = next(r for r in mk.installed("p1") if r["profile"] == "sales")
        self.assertEqual(rec["post"]["c"]["state"], "ok")
        self.assertEqual(tp.issues("p1", "sales", mk.installed("p1")), [])

    def test_model_missing_is_not_retried(self):
        self.finish()

        def a(_r):
            raise tp.StepError("모델 없음", retryable=False)
        tp.run_one(tp.entries()[0], {"a": a}, now=0)
        self.assertEqual(tp.entries(), [])
        rec = next(r for r in mk.installed("p1") if r["profile"] == "sales")
        self.assertEqual((rec["post"]["a"]["state"], rec["post"]["a"]["retryable"], rec["post"]["a"]["tries"]), ("failed", False, 1))

    def test_non_template_rows_are_not_indexed(self):
        self.finish(template=None)
        self.assertEqual(tp.entries(), [])


class CompanionVersionTest(unittest.TestCase):
    def test_version_is_passed_and_reasons_collected(self):
        pkg = {"id": "free/docx", "namespace": "free", "name": "docx", "version": "2.0.0", "kind": "skill", "paid": False,
               "versions": [{"version": "2.0.0"}, {"version": "1.0.3"}], "status": "ACTIVE"}
        with mock.patch.object(mk, "package", return_value=pkg), mock.patch.object(mk, "installed", return_value=[]), \
                mock.patch.object(mk, "request_install") as req:
            self.assertEqual(mk.install_companion("p1", "c", "sales", "free/docx", "a", "1.0.3"), "queued")
        self.assertEqual(req.call_args.args[3], "1.0.3")
        why: list = []
        with mock.patch.object(mk, "package", return_value={**pkg, "status": "ARCHIVED"}), mock.patch.object(mk, "installed", return_value=[]):
            self.assertEqual(mk.install_companion("p1", "c", "sales", "free/docx", "a", "1.0.3", why), "failed")
        self.assertTrue(why)


class NewVersionMergeTest(unittest.TestCase):
    """템플릿 새 판 합치기: 더함·바뀜만, 없어진 것은 지우지 않고 알림, KEY 가 비면 꺼 둠, 사용자가 꺼 둔 것은 켜지 않음."""

    def test_diff_and_merge(self):
        from aas.market import template_checks as tc
        current = {"jira": {"url": "https://j/mcp", "headers": {"A": "${JIRA_TOKEN}"}}, "docs": {"url": "https://d/old", "enabled": False},
                   "mine": {"url": "https://m/mcp"}, "old": {"url": "https://o/mcp"}}
        new = {"jira": {"url": "https://j/mcp", "headers": {"A": "${JIRA_TOKEN}"}}, "docs": {"url": "https://d/new"},
               "wiki": {"url": "https://w/mcp", "headers": {"A": "${WIKI_KEY}"}}, "plain": {"url": "https://p/mcp"}}
        self.assertEqual(tc.mcp_diff(current, new), {"added": ["plain", "wiki"], "changed": ["docs"], "kept": ["mine", "old"]})
        merged, waiting, gone = tc.merge_mcp(current, new, {"JIRA_TOKEN"}, base={"jira": {}, "docs": {}, "old": {}})
        self.assertEqual(waiting, ["wiki"])
        self.assertIs(merged["wiki"]["enabled"], False)
        self.assertNotIn("enabled", merged["plain"])
        self.assertIs(merged["docs"]["enabled"], False)               # 사용자가 꺼 둔 것은 켜지 않는다
        self.assertEqual(merged["docs"]["url"], "https://d/new")
        self.assertIn("mine", merged)
        self.assertIn("old", merged)                                  # 템플릿에서 없어진 것도 지우지 않는다
        self.assertEqual(gone, ["old"])                               # 사용자가 더한 mine 은 「없어짐」이 아니다

    def test_update_rows_run_update_steps_only(self):
        self.assertEqual(tp.steps_of({"mode": "update"}), ("m", "d"))
        self.assertEqual(tp.steps_of({"mode": "install"}), tp.STEPS)

    def test_template_update_requires_stdio_consent_in_stage(self):
        import io as _io
        import zipfile as _zip
        from aas.market import market_stage as ms, template_checks as tc
        cfg = yaml.safe_dump({"mcp_servers": {"fs": {"command": "npx", "args": ["-y", "@s/fs@2.0.0"]}}})
        man = yaml.safe_dump({"name": "sales", "version": "1.1.0", "aas": {"template": 1}, "env_requires": []})
        files = {"SKILL.md": "---\nname: sales\n---\n", "agent/distribution.yaml": man, "agent/SOUL.md": "s", "agent/config.yaml": cfg}
        buf = _io.BytesIO()
        with _zip.ZipFile(buf, "w") as z:
            for k, v in files.items():
                z.writestr(k, v)
        pkg = Path(tempfile.mkdtemp(dir=TMP.name)) / "pkg"
        ms.extract(buf.getvalue(), pkg, {})
        req = {"id": "20261118110000000000-abcdef", "namespace": "paid", "name": "sales", "package": "paid/sales", "version": "1.1.0", "profile": "sales",
               "kind": "agent", "mode": "update", "pod": "p1"}
        with self.assertRaises(ms.Refuse) as cm:
            ms.stage(req, pkg, Path(tempfile.mkdtemp(dir=TMP.name)) / "o")
        self.assertEqual(cm.exception.code, "consent_required")
        man_ = ms.stage({**req, "consents": [tc.consent_hash("npx", ["-y", "@s/fs@2.0.0"])]}, pkg, Path(tempfile.mkdtemp(dir=TMP.name)) / "o2")
        self.assertNotIn("config.yaml", man_["distribution_owned"])    # 올리기는 config 를 지킨다 — MCP 는 설치 뒤 (m) 이 합친다

    def test_update_request_keeps_previous_version_and_waiting(self):
        pkg = {"id": "paid/sales", "namespace": "paid", "name": "sales", "version": "1.1.0", "kind": "agent", "paid": False, "versions": [{"version": "1.1.0"}],
               "bytes": 10, "status": "ACTIVE"}
        rec = {"profile": "sales", "package": "paid/sales", "version": "1.0.0", "kind": "agent", "mode": "install", "waiting_mcp": ["jira"]}
        for d in ("queue", "done"):
            for p_ in mk._dir(d).glob("*"):
                p_.unlink()
        with mock.patch.object(mk, "installed", return_value=[rec]), mock.patch.object(mk, "install_state", return_value={"enabled": True}):
            row = mk.request_install("p1", "c", pkg, "1.1.0", "sales", "update", "a@x.io", ["sales"], consents=["b" * 64])
        self.assertEqual((row["from_version"], row["prev_waiting"], row["consents"]), ("1.0.0", ["jira"], ["b" * 64]))


class LeftoverTest(unittest.TestCase):
    def test_mcp_test_error_hides_env_values_in_urls(self):
        from aas.market import template_checks as tc
        env = "JIRA_TOKEN=abcd1234secret\nSHORT=ab\n# X=commentedvalue\n"
        msg = "GET https://j.example/mcp?key=abcd1234secret failed: 401 ab"
        self.assertEqual(tc.mask_values(msg, env), "GET https://j.example/mcp?key=***** failed: 401 ab")

    def test_problem_body_has_code_type_and_fix(self):
        body = pt.problem(pt.TemplateError("하루 한도", 429, reason="publish_daily_limit"))
        self.assertEqual((body["code"], body["status"], body["type"]), ("publish_daily_limit", 429, "/docs/errors/template#publish_daily_limit"))
        self.assertIn("AAS_TEMPLATE_DAILY_LIMIT", body["fix"])
        self.assertNotIn("fix", pt.problem(pt.TemplateError("x", 400, reason="unknown_code")))


class SidecarPathTest(unittest.TestCase):
    """쿠버네티스에서는 home 이 사이드카 경로(RemotePath)라 is_symlink 가 없다 — OKE 시험(2026-11-18)에서 참고 파일 미리 보기가 500 이었다."""

    class Remote:
        def __init__(self, p):
            self._p = Path(p)

        def __truediv__(self, o):
            return type(self)(self._p / o)

        def is_dir(self):
            return self._p.is_dir()

        def is_file(self):
            return self._p.is_file()

        def read_bytes(self):
            return self._p.read_bytes()

        def read_text(self, encoding="utf-8", errors="strict"):
            return self._p.read_text(encoding=encoding, errors=errors)

        def relative_to(self, other):
            return self._p.relative_to(other._p)

        def stat(self):
            return self._p.stat()

        def rglob(self, pattern, skip=frozenset()):
            return [type(self)(x) for x in self._p.rglob(pattern) if not skip.intersection(x.relative_to(self._p).parts)]

        def __lt__(self, other):
            return str(self._p) < str(other._p)

    def test_reference_files_and_listing_work_without_is_symlink(self):
        home = Path(tempfile.mkdtemp(dir=TMP.name))
        put(home / "workspace", {"a/guide.md": "순서", "node_modules/x.js": "x", "b.xlsx": b"PK\x03\x04bin"})
        remote = self.Remote(home)
        self.assertFalse(hasattr(remote, "is_symlink"))
        listed = [f["path"] for f in pt.workspace_files(remote)]
        self.assertEqual(listed, ["a/guide.md", "b.xlsx"])
        errors = []
        got, needs = pt.reference_files(remote, [{"path": "a/guide.md"}, {"path": "b.xlsx"}], lambda c, m: errors.append(c))
        self.assertEqual(([f["path"] for f in got], needs, errors), (["a/guide.md"], ["b.xlsx"], []))


if __name__ == "__main__":
    unittest.main()

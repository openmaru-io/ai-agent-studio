# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""마켓 설치·새 판의 준비 단계: 고친 스킬·같은 이름·크론·MCP 를 지키고 덮기 전에 백업한다(스펙 2026-10-14-015 리뷰 R3·R7·R8·R9)."""
import io
import json
import os
import tarfile
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest import mock

TMP = tempfile.TemporaryDirectory()
os.environ.setdefault("AAS_DATA_DIR", str(Path(TMP.name) / "data"))

from aas.market import market_dispatch, market_stage as ms, skill_keep as sk  # noqa: E402


def zipped(files: dict) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        for name, text in files.items():
            z.writestr(name, text)
    return buf.getvalue()


def put(root: Path, files: dict):
    for rel, text in files.items():
        p = root / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(text, encoding="utf-8")


V1 = {"SKILL.md": "---\nname: hello\n---\n원본 1.0", "scripts/run.py": "print(1)\n"}
V2 = {"SKILL.md": "---\nname: hello\n---\n원본 2.0", "scripts/run.py": "print(2)\n"}
AG1 = {"SKILL.md": "x", "agent/distribution.yaml": "name: bot\n", "agent/SOUL.md": "소울1", "agent/skills/a/b/SKILL.md": "---\nname: ab\n---\n1"}
AG2 = {**AG1, "agent/SOUL.md": "소울2", "agent/skills/a/b/SKILL.md": "---\nname: ab\n---\n2",
       "agent/cron/jobs.json": json.dumps({"jobs": [{"id": "p1", "name": "패키지"}]})}


def fake_download(versions: dict):
    """{버전: 파일들} — SkillHub 대신 그 판의 묶음을 풀어 준다."""
    def download(req, dest):
        files = versions.get(req["version"])
        if files is None:
            raise ms.Refuse("마켓플레이스가 거절했습니다 (HTTP 404)")
        return ms.extract(zipped(files), dest, {})
    return download


class PrepareTest(unittest.TestCase):
    def setUp(self):
        self.home = Path(tempfile.mkdtemp(dir=TMP.name))
        self.root = self.home / "profiles" / "ma"
        self.root.mkdir(parents=True)
        self.req = {"id": "20261014090000000000-abcdef", "namespace": "free", "name": "hello", "package": "free/hello", "version": "2.0.0",
                    "profile": "ma", "container": "hermes", "kind": "skill", "mode": "update", "pod": "p1"}
        self.rec = {"profile": "ma", "package": "free/hello", "version": "1.0.0", "kind": "skill", "mode": "install"}

    def run_prepare(self, files, req=None, record="default"):
        versions = {"1.0.0": V1, "2.0.0": files}
        rec = self.rec if record == "default" else record
        with mock.patch.object(ms, "download", fake_download(versions)):
            return ms.prepare(req or self.req, self.home, rec)

    def test_unmodified_market_skill_updates_and_is_backed_up(self):
        put(self.root, {f"skills/market/hello/{k}": v for k, v in V1.items()})
        res = self.run_prepare(V2)
        self.assertTrue(res["payload"])
        self.assertEqual(res["manifest"]["distribution_owned"], ["skills/market/hello"])
        with tarfile.open(sk.backup_dir() / res["backup"]) as tar:                       # 덮기 전에 지금 폴더를 남겼다
            self.assertIn("skills/market/hello/SKILL.md", tar.getnames())

    def test_modified_skill_stops_and_asks(self):
        put(self.root, {f"skills/market/hello/{k}": v for k, v in V1.items()})
        (self.root / "skills/market/hello/SKILL.md").write_text("---\nname: hello\n---\n내가 고침", encoding="utf-8")
        with self.assertRaises(ms.NeedsChoice) as cm:
            self.run_prepare(V2)
        self.assertEqual(cm.exception.needs["modified"], ["skills/market/hello"])         # 화면이 이 목록으로 선택 대화 상자를 그린다
        self.assertEqual((self.root / "skills/market/hello/SKILL.md").read_text(encoding="utf-8"), "---\nname: hello\n---\n내가 고침")   # 아무것도 바뀌지 않았다

    def test_keep_choice_leaves_modified_skill_and_finishes_with_nothing_to_do(self):
        put(self.root, {f"skills/market/hello/{k}": v for k, v in V1.items()})
        (self.root / "skills/market/hello/SKILL.md").write_text("---\nname: hello\n---\n내가 고침", encoding="utf-8")
        res = self.run_prepare(V2, {**self.req, "on_modified": "keep"})
        self.assertEqual((res["payload"], res["skipped"]), ("", ["skills/market/hello"]))
        self.assertEqual(res["manifest"]["distribution_owned"], [])

    def test_overwrite_choice_backs_up_then_replaces(self):
        put(self.root, {f"skills/market/hello/{k}": v for k, v in V1.items()})
        (self.root / "skills/market/hello/SKILL.md").write_text("---\nname: hello\n---\n내가 고침", encoding="utf-8")
        res = self.run_prepare(V2, {**self.req, "on_modified": "overwrite"})
        self.assertTrue(res["payload"])
        with tarfile.open(sk.backup_dir() / res["backup"]) as tar:
            self.assertEqual(tar.extractfile("skills/market/hello/SKILL.md").read().decode(), "---\nname: hello\n---\n내가 고침")   # 고친 내용이 백업에 있다

    def test_unknown_original_asks(self):
        put(self.root, {f"skills/market/hello/{k}": v for k, v in V1.items()})
        with self.assertRaises(ms.NeedsChoice):                                           # 설치 기록이 없는 같은 경로 = 사용자가 만든 것일 수 있다
            self.run_prepare(V2, record=None)
        with mock.patch.object(ms, "download", fake_download({"2.0.0": V2})):             # 설치된 판을 SkillHub 에서 못 받으면 「모름」으로 묻는다
            with self.assertRaises(ms.NeedsChoice):
                ms.prepare(self.req, self.home, self.rec)

    def test_runtime_leftovers_do_not_count_as_modified(self):
        put(self.root, {f"skills/market/hello/{k}": v for k, v in V1.items()})
        put(self.root, {"skills/market/hello/scripts/__pycache__/run.cpython-311.pyc": "b"})
        self.assertTrue(self.run_prepare(V2)["payload"])                                  # 실행 부산물만 있으면 고치지 않은 것(리뷰 O8)

    def test_same_name_elsewhere_stops_with_a_clear_message(self):
        put(self.root, {"skills/local/mine/SKILL.md": "---\nname: hello\n---\n"})
        with self.assertRaises(ms.Refuse) as cm:
            self.run_prepare(V2, {**self.req, "mode": "install"}, record=None)
        self.assertNotIsInstance(cm.exception, ms.NeedsChoice)
        self.assertIn("같은 이름", str(cm.exception))                                      # 둘 다 쓰지 못하게 되는 설치는 하지 않는다(리뷰 O1)

    def test_agent_update_keeps_other_skills_cron_and_backs_them_up(self):
        put(self.root, {"skills/a/b/SKILL.md": "---\nname: ab\n---\n1", "skills/mine/SKILL.md": "---\nname: mine\n---\n나",
                        "cron/jobs.json": json.dumps({"jobs": [{"id": "u1", "name": "내 작업"}]}), "mcp.json": "{}"})
        req = {**self.req, "package": "free/bot", "name": "bot", "kind": "agent"}
        rec = {"profile": "ma", "package": "free/bot", "version": "1.0.0", "kind": "agent", "mode": "install"}
        with mock.patch.object(ms, "download", fake_download({"1.0.0": AG1, "2.0.0": AG2})):
            res = ms.prepare(req, self.home, rec)
        owned = res["manifest"]["distribution_owned"]
        self.assertIn("skills/a/b", owned)
        self.assertNotIn("skills", owned)                                                  # 사용자 스킬 skills/mine 은 owned 밖이라 남는다
        self.assertIn("cron/jobs.json", owned)
        with tarfile.open(sk.backup_dir() / res["backup"]) as tar:
            self.assertIn("cron/jobs.json", tar.getnames())                                # 덮이는 크론도 백업

    def test_unreachable_sidecar_stops_instead_of_overwriting(self):
        home = mock.MagicMock()
        home.__truediv__.return_value.__truediv__.return_value.__truediv__.return_value.is_dir.side_effect = OSError("사이드카에 연결할 수 없습니다")
        with mock.patch.object(ms, "download", fake_download({"1.0.0": V1, "2.0.0": V2})):
            with self.assertRaises(ms.Refuse) as cm:
                ms.prepare(self.req, home, self.rec)
        self.assertIn("읽지 못해", str(cm.exception))                                       # 못 읽은 것을 「없다」로 읽고 덮지 않는다


class DispatchTest(unittest.TestCase):
    def test_needs_choice_closes_the_request_with_the_choices(self):
        row = {"id": "20261014090000000001-abcdef", "pod": "p1", "namespace": "free", "name": "hello", "package": "free/hello", "version": "2.0.0",
               "profile": "ma", "kind": "skill", "mode": "update", "status": "queued"}
        err = ms.NeedsChoice("고친 스킬이 있습니다", {"modified": ["skills/market/hello"], "occupied": []})
        with mock.patch.object(ms, "prepare", side_effect=err), mock.patch.object(market_dispatch.marketplace, "installed", return_value=[]):
            out = market_dispatch._dispatch(mock.MagicMock(), row, {"p1"}, get_home=lambda pod: Path("/x"))
        self.assertEqual(out["status"], "failed")
        self.assertEqual(out["needs"], {"modified": ["skills/market/hello"], "occupied": []})

    def test_nothing_to_do_closes_as_done_without_a_task(self):
        row = {"id": "20261014090000000002-abcdef", "pod": "p1", "namespace": "free", "name": "hello", "package": "free/hello", "version": "2.0.0",
               "profile": "ma", "kind": "skill", "mode": "update", "status": "queued", "on_modified": "keep"}
        res = {"payload": "", "manifest": {"distribution_owned": []}, "backup": "", "skipped": ["skills/market/hello"]}
        client = mock.MagicMock()
        with mock.patch.object(ms, "prepare", return_value=res), mock.patch.object(market_dispatch.marketplace, "installed", return_value=[]):
            out = market_dispatch._dispatch(client, row, {"p1"}, get_home=lambda pod: Path("/x"))
        self.assertEqual(out["status"], "done")
        self.assertFalse(client.create_task.called)                                       # 바꿀 것이 없으면 작업을 만들지 않는다
        self.assertIn("그대로", out["message"])

    def test_backup_name_is_kept_on_the_request(self):
        row = {"id": "20261014090000000003-abcdef", "pod": "p1", "namespace": "free", "name": "hello", "package": "free/hello", "version": "2.0.0",
               "profile": "ma", "kind": "skill", "mode": "update", "status": "queued"}
        res = {"payload": "UEs=", "manifest": {"distribution_owned": ["skills/market/hello"]}, "backup": "x.tar.gz", "skipped": []}
        client = mock.MagicMock()
        client.namespace = "ns"
        with mock.patch.object(ms, "prepare", return_value=res), mock.patch.object(market_dispatch.marketplace, "installed", return_value=[]):
            out = market_dispatch._dispatch(client, row, {"p1"}, get_home=lambda pod: Path("/x"))
        self.assertEqual((out["status"], out["backup"]), ("running", "x.tar.gz"))
        self.assertTrue(client.create_task.called)

    def test_copy_choice_runs_skillcopy_first_then_installs_the_new_version(self):
        row = {"id": "20261014090000000004-abcdef", "pod": "p1", "namespace": "free", "name": "hello", "package": "free/hello", "version": "2.0.0",
               "profile": "ma", "kind": "skill", "mode": "update", "status": "queued", "on_modified": "copy"}
        res = {"payload": "UEs=", "manifest": {"distribution_owned": ["skills/market/hello"]}, "backup": "x.tar.gz", "skipped": []}
        client = mock.MagicMock()
        client.namespace = "ns"
        seen = []
        with mock.patch.object(ms, "prepare", side_effect=lambda req, *a: seen.append(req["on_modified"]) or res), \
                mock.patch.object(market_dispatch.marketplace, "installed", return_value=[]):
            out = market_dispatch._dispatch(client, row, {"p1"}, get_home=lambda pod: Path("/x"))
            first = client.create_task.call_args[0][0]
            self.assertEqual((out["status"], out["stage"], first["spec"]["type"], first["spec"]["skillName"]), ("running", "copy", "SkillCopy", "hello"))
            self.assertEqual(first["metadata"]["name"], market_dispatch.task_name(row["id"]) + "-copy")
            client.get_task.return_value = {"status": {"phase": "Succeeded", "message": "복사했습니다 — skills/local/hello-local-2"}}
            out = market_dispatch._poll(client, out, {"p1"}, lambda pod: Path("/x"))     # 복사가 끝나면 새 판 설치를 이어 보낸다
        second = client.create_task.call_args[0][0]
        self.assertEqual((out["local_copy"], out["task"], second["spec"]["type"]), ("hello-local-2", market_dispatch.task_name(row["id"]), "ProfileInstall"))
        self.assertNotIn("stage", out)
        self.assertEqual(seen, ["copy", "overwrite"])                                      # 복사 뒤에는 이미 사본이 있으니 덮기로 준비한다
        client.get_task.return_value = {"status": {"phase": "Succeeded", "message": "설치했습니다"}}
        done = market_dispatch._poll(client, out, {"p1"}, lambda pod: Path("/x"))
        self.assertIn("skills/local/hello-local-2", done["message"])

    def test_restore_request_is_sent_as_a_skillrestore_task_without_preparing_a_package(self):
        row = {"id": "20261014090000000006-abcdef", "pod": "p1", "namespace": "", "name": "old-skill", "package": "", "version": "",
               "profile": "ma", "kind": "skill", "mode": "restore", "status": "queued"}
        client = mock.MagicMock()
        client.namespace = "ns"
        with mock.patch.object(ms, "prepare", side_effect=AssertionError("패키지를 받지 않는다")):
            out = market_dispatch._dispatch(client, row, {"p1"}, get_home=lambda pod: Path("/x"))
        spec = client.create_task.call_args[0][0]["spec"]
        self.assertEqual((out["status"], spec["type"], spec["skillName"], spec["profile"]), ("running", "SkillRestore", "old-skill", "ma"))


class CopyChoiceRulesTest(unittest.TestCase):
    def test_copy_is_refused_for_agent_packages_and_for_non_market_paths(self):
        home = Path(tempfile.mkdtemp(dir=TMP.name))
        root = home / "profiles" / "ma"
        put(root, {f"skills/market/hello/{k}": v for k, v in V1.items()})
        (root / "skills/market/hello/SKILL.md").write_text("---\nname: hello\n---\n내가 고침", encoding="utf-8")
        req = {"id": "20261014090000000005-abcdef", "namespace": "free", "name": "hello", "package": "free/hello", "version": "2.0.0",
               "profile": "ma", "container": "hermes", "kind": "skill", "mode": "update", "pod": "p1", "on_modified": "copy"}
        rec = {"profile": "ma", "package": "free/hello", "version": "1.0.0", "kind": "skill", "mode": "install"}
        with mock.patch.object(ms, "download", fake_download({"1.0.0": V1, "2.0.0": V2})):
            self.assertTrue(ms.prepare(req, home, rec)["payload"])                          # 마켓 스킬 하나 → 허용
            put(root, {"skills/market/hello/SKILL.md": "---\nname: hello\n---\n내가 고침 2"})
            with self.assertRaises(ms.Refuse):
                ms.prepare({**req, "kind": "agent", "name": "bot", "package": "free/bot"}, home, rec)


if __name__ == "__main__":
    unittest.main()


class DeletedProfileTest(unittest.TestCase):
    """지운 프로파일에 설치 요청이 배달되지 않는다(스펙 2026-11-07-001 §6, OKE 2026-11-07: 지우기와 겹친 기본 스킬 배달이
    Hermes CLI 로 프로파일 폴더를 다시 만들어 지운 프로파일 폴더가 남음)."""

    def setUp(self):
        for d in ("queue", "done"):
            for p in market_dispatch.marketplace._dir(d).glob("*.json"):
                p.unlink()

    def _row(self, n, **kw):
        row = {"id": f"2026110715110000000{n}-abcdef", "pod": "p1", "namespace": "free", "name": "hello", "package": "free/hello",
               "version": "2.0.0", "profile": "gone", "kind": "skill", "mode": "install", "status": "queued", **kw}
        market_dispatch._write("queue", row)
        return row

    def test_request_for_a_profile_that_is_gone_is_closed_without_a_task(self):
        row = self._row(1)
        client = mock.MagicMock()
        with mock.patch.object(ms, "prepare") as prep:
            out = market_dispatch._dispatch(client, row, {"p1"}, get_home=lambda pod: Path("/x"), profile_gone=lambda pod, prof: prof == "gone")
        self.assertEqual(out["status"], "failed")
        self.assertIn("없어 설치하지 않았습니다", out["message"])
        self.assertFalse(client.create_task.called)
        self.assertFalse(prep.called)
        # 새 프로파일을 만드는 에이전트 설치는 아직 프로파일이 없어도 보낸다
        agent = self._row(2, kind="agent")
        res = {"payload": "", "manifest": {"distribution_owned": ["x"]}, "backup": "", "skipped": []}
        with mock.patch.object(ms, "prepare", return_value=res), mock.patch.object(market_dispatch.marketplace, "installed", return_value=[]), \
                mock.patch.object(market_dispatch, "_send", side_effect=lambda c, r, m, n, stage="": {**r, "status": "running"}):
            out = market_dispatch._dispatch(client, agent, {"p1"}, get_home=lambda pod: Path("/x"), profile_gone=lambda pod, prof: True)
        self.assertEqual(out["status"], "running")

    def test_pending_for_and_cancel_queued(self):
        self._row(3)
        self._row(4, task="aas-market-x", status="running")
        self._row(5, profile="other")
        queued, running = market_dispatch.pending_for("p1", "gone")
        self.assertEqual((len(queued), len(running)), (1, 1))
        self.assertEqual(market_dispatch.cancel_queued("p1", "gone", "프로파일을 지워 취소했습니다"), 1)
        queued, running = market_dispatch.pending_for("p1", "gone")
        self.assertEqual((len(queued), len(running)), (0, 1))
        self.assertEqual(len(market_dispatch.pending_for("p1", "other")[0]), 1)

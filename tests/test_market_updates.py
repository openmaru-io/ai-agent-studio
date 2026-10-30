# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""스킬 새 버전 찾기 시험(스펙 2026-10-24-003) — 가짜 Hermes 데이터 폴더와 가짜 허브 목록으로 판 비교·건너뛰기·대기 표·자동 올리기를 본다."""
import json
import os
import tempfile
import types
import unittest
from pathlib import Path
from unittest import mock

TMP = tempfile.TemporaryDirectory()
os.environ.setdefault("AAS_DATA_DIR", str(Path(TMP.name) / "data"))

from aas.market import marketplace as mk, updates  # noqa: E402

CAT = [{"id": "free/outline", "namespace": "free", "name": "outline", "version": "0.1.2", "paid": False},
       {"id": "free/docmost", "namespace": "free", "name": "docmost", "version": "0.1.3", "paid": False},
       {"id": "free/twin", "namespace": "free", "name": "twin", "version": "1.0.0", "paid": False},
       {"id": "paid/twin", "namespace": "paid", "name": "twin", "version": "1.0.0", "paid": True},
       {"id": "paid/secret", "namespace": "paid", "name": "secret", "version": "2.0.0", "paid": True},
       {"id": "free/bot", "namespace": "free", "name": "bot", "version": "1.1.0", "paid": False}]


def rec(profile, package, version, kind="skill", mode="install"):
    ns, _, name = package.partition("/")
    return {"profile": profile, "package": package, "namespace": ns, "name": name, "version": version, "kind": kind, "mode": mode}


class UpdatesTestBase(unittest.TestCase):
    def setUp(self):
        self.home = Path(tempfile.mkdtemp(dir=TMP.name))
        for d in ("queue", "done"):
            for p in mk._dir(d).glob("*"):
                p.unlink()
        with updates._conn() as conn:
            for t in ("market_update_skips", "market_update_pending", "market_update_auto"):
                conn.execute(f"DELETE FROM {t}")
            conn.execute("DELETE FROM meta WHERE key=?", (updates.AUTO_KEY,))

    def skill(self, profile, name, version="", body="본문"):
        root = self.home if profile == "default" else self.home / "profiles" / profile
        d = root / "skills" / "market" / name
        d.mkdir(parents=True, exist_ok=True)
        head = f"---\nname: {name}\n" + (f"version: {version}\n" if version else "") + "---\n"
        (d / "SKILL.md").write_text(head + body, encoding="utf-8")
        return d

    def scan(self, records=(), granted=(), skips=None):
        return updates.scan("p1", self.home, CAT, list(records), set(granted), skips or {})


class ScanTest(UpdatesTestBase):
    def test_record_lower_file_version_is_update(self):
        self.skill("work", "outline", "0.1.1")
        rows = self.scan([rec("work", "free/outline", "0.1.1")])
        self.assertEqual([(r["profile"], r["package"], r["current"], r["latest"], r["basis"], r["state"]) for r in rows],
                         [("work", "free/outline", "0.1.1", "0.1.2", "record", "update")])
        self.assertEqual(len(updates.alerts(rows)), 1)

    def test_same_version_has_no_row(self):
        self.skill("work", "outline", "0.1.2")
        self.assertEqual(self.scan([rec("work", "free/outline", "0.1.2")]), [])

    def test_folder_name_only_when_one_package(self):
        self.skill("work", "outline", "0.1.0")            # 기록 없음 — 허브에 outline 은 하나
        self.skill("work", "twin", "0.9.0")               # 기록 없음 — free·paid 둘 다 있어 판단하지 않는다(R4)
        rows = self.scan()
        self.assertEqual([(r["skill"], r["basis"]) for r in rows], [("outline", "folder")])

    def test_kept_when_record_newer_than_file(self):
        self.skill("work", "outline", "0.1.0")            # 「내 것 지키기」로 0.1.1 을 받았지만 파일은 고친 0.1.0
        rows = self.scan([rec("work", "free/outline", "0.1.1")])
        self.assertEqual([r["state"] for r in rows], ["kept"])
        self.assertEqual(updates.alerts(rows), [])

    def test_blocked_root_and_paid_without_grant(self):
        self.skill("default", "outline", "0.1.0")
        self.skill("work", "secret", "1.0.0")
        rows = self.scan([rec("default", "free/outline", "0.1.0"), rec("work", "paid/secret", "1.0.0")])
        self.assertEqual(sorted((r["skill"], r["state"], r["reason"]) for r in rows),
                         [("outline", "blocked", "root"), ("secret", "blocked", "grant")])
        granted = self.scan([rec("work", "paid/secret", "1.0.0")], granted={"paid"})
        self.assertEqual([r["state"] for r in granted if r["skill"] == "secret"], ["update"])

    def test_skip_hides_that_version_only(self):
        self.skill("work", "outline", "0.1.1")
        rows = self.scan([rec("work", "free/outline", "0.1.1")], skips={("work", "free/outline"): "0.1.2"})
        self.assertEqual([r["state"] for r in rows], ["skipped"])
        older = self.scan([rec("work", "free/outline", "0.1.1")], skips={("work", "free/outline"): "0.1.1"})
        self.assertEqual([r["state"] for r in older], ["update"])     # 건너뛴 판보다 새 판이 나왔다 — 다시 알린다

    def test_file_without_version_uses_record(self):
        self.skill("work", "outline")
        rows = self.scan([rec("work", "free/outline", "0.1.1")])
        self.assertEqual([(r["current"], r["state"]) for r in rows], [("0.1.1", "update")])
        self.skill("work", "docmost")                      # 기록도 판도 없다
        self.assertIn(("docmost", "unreadable"), [(r["skill"], r["state"]) for r in self.scan([rec("work", "free/outline", "0.1.1")])])

    def test_agent_package_compares_record(self):
        (self.home / "profiles" / "bot1").mkdir(parents=True)
        rows = self.scan([rec("bot1", "free/bot", "1.0.0", kind="agent")])
        self.assertEqual([(r["kind"], r["current"], r["latest"], r["mode"]) for r in rows], [("agent", "1.0.0", "1.1.0", "update")])
        skills_only = self.scan([rec("bot1", "free/bot", "1.0.0", kind="agent", mode="skills")])
        self.assertEqual([r["mode"] for r in skills_only], ["skills"])

    def test_skip_table_round_trip_and_follows_rename(self):
        updates.skip("p1", "work", "free/outline", "0.1.2", "a@x.io")
        self.assertEqual(updates.skipped("p1"), {("work", "free/outline"): "0.1.2"})
        updates.follow_profile("p1", "work", "rename", "work2")
        self.assertEqual(updates.skipped("p1"), {("work2", "free/outline"): "0.1.2"})
        updates.skip("p1", "work2", "free/outline", "0.1.2", "a@x.io", undo=True)
        self.assertEqual(updates.skipped("p1"), {})


PKG = {"id": "free/outline", "namespace": "free", "name": "outline", "version": "0.1.2", "kind": "skill", "paid": False, "bytes": 0,
       "versions": [{"version": "0.1.2"}, {"version": "0.1.1"}]}
DOC = {"id": "free/docmost", "namespace": "free", "name": "docmost", "version": "0.1.3", "kind": "skill", "paid": False, "bytes": 0,
       "versions": [{"version": "0.1.3"}]}
POD = types.SimpleNamespace(id="p1", container="hermes-agent")


class QueueTest(UpdatesTestBase):
    def setUp(self):
        super().setUp()
        self.pkg = mock.patch.object(mk, "package", lambda ns, name: {"outline": PKG, "docmost": DOC}[name])
        self.pkg.start()

    def tearDown(self):
        self.pkg.stop()

    def queued(self):
        return sorted((r["profile"], r["package"]) for r in mk.requests("p1") if r["status"] == "queued")

    def test_one_request_per_profile_per_cycle(self):
        updates.queue("p1", [{"profile": "work", "package": "free/outline", "version": "0.1.2"},
                             {"profile": "work", "package": "free/docmost", "version": "0.1.3"}], "a@x.io")
        updates.drain([POD], lambda pod: ["work"])
        self.assertEqual(len(self.queued()), 1)
        self.assertEqual(len(updates.pending("p1")), 1)                 # 둘째 줄은 대기
        updates.drain([POD], lambda pod: ["work"])                       # 첫 요청이 아직 안 끝났다 — 409, 그대로 대기
        self.assertEqual(len(updates.pending("p1")), 1)
        for p in mk._dir("queue").glob("*.json"):                         # 배달기가 끝냈다
            row = json.loads(p.read_text())
            p.unlink()
            (mk._dir("done") / p.name).write_text(json.dumps({**row, "status": "done"}))
        updates.drain([POD], lambda pod: ["work"])
        self.assertEqual(updates.pending("p1"), [])
        self.assertEqual(len(self.queued()), 1)

    def test_auto_queue_once_and_report(self):
        self.skill("work", "outline", "0.1.1")
        rows = self.scan([rec("work", "free/outline", "0.1.1")])
        with mock.patch.object(mk, "default_packages", lambda: ["free/outline"]), mock.patch.object(updates, "modified", lambda home, r: "same"):
            self.assertEqual(updates.auto_queue(rows, self.home), 1)
            self.assertEqual(updates.auto_queue(rows, self.home), 0)     # 같은 판은 한 번만(R11)
        updates.drain([POD], lambda pod: ["work"])
        p = next(mk._dir("queue").glob("*.json"))
        row = json.loads(p.read_text())
        p.unlink()
        (mk._dir("done") / p.name).write_text(json.dumps({**row, "status": "failed", "message": "디스크 가득"}))
        updates.settle_auto_all(["p1"])
        issues = updates.auto_issues("p1", "work")
        self.assertEqual([(i["code"], i["level"]) for i in issues], [("market_auto_failed", "bad")])
        self.assertIn("디스크 가득", issues[0]["text"])

    def test_auto_done_notice_can_be_marked_seen(self):
        """자동 올리기 안내는 사람이 확인하면 7일을 기다리지 않고 빠진다. 실패 줄은 확인으로 바뀌지 않는다(2026-10-30)."""
        with updates._conn() as conn:
            for pkg, status in (("free/outline", "done"), ("free/docmost", "failed")):
                conn.execute("INSERT INTO market_update_auto (pod, profile, package, version, status, ts) VALUES (?,?,?,?,?,?)",
                             ("p1", "work", pkg, "0.2.0", status, updates._now()))
        issues = updates.auto_issues("p1", "work")
        self.assertEqual(sorted((i["code"], i.get("ack", False)) for i in issues), [("market_auto_done", True), ("market_auto_failed", False)])
        self.assertEqual(updates.mark_seen("p1", "work", "free/outline", "0.2.0"), 1)
        self.assertEqual(updates.mark_seen("p1", "work", "free/outline", "0.2.0"), 0)        # 두 번 눌러도 그대로
        self.assertEqual(updates.mark_seen("p1", "work", "free/docmost", "0.2.0"), 0)        # 실패는 올려야 사라진다
        self.assertEqual([i["code"] for i in updates.auto_issues("p1", "work")], ["market_auto_failed"])
        with self.assertRaises(mk.MarketError):
            updates.mark_seen("p1", "../x", "free/outline", "0.2.0")

    def test_auto_skips_modified_and_non_default(self):
        self.skill("work", "outline", "0.1.1")
        self.skill("work", "docmost", "0.1.0")
        rows = self.scan([rec("work", "free/outline", "0.1.1"), rec("work", "free/docmost", "0.1.0")])
        with mock.patch.object(mk, "default_packages", lambda: ["free/outline"]), mock.patch.object(updates, "modified", lambda home, r: "changed"):
            self.assertEqual(updates.auto_targets(rows, self.home), [])
        with mock.patch.object(mk, "default_packages", lambda: ["free/outline"]), mock.patch.object(updates, "modified", lambda home, r: "same"):
            self.assertEqual([r["package"] for r in updates.auto_targets(rows, self.home)], ["free/outline"])


class ModifiedTest(UpdatesTestBase):
    def test_reference_downloaded_once(self):
        folder = self.skill("work", "outline", "0.1.1", body="원본")
        row = self.scan([rec("work", "free/outline", "0.1.1")])[0]
        calls = []

        def download(req, dest):
            calls.append(req["version"])
            (dest / "SKILL.md").write_text((folder / "SKILL.md").read_text(encoding="utf-8"), encoding="utf-8")
            return ["SKILL.md"]
        with mock.patch.object(updates.market_stage, "download", download):
            self.assertEqual(updates.modified(self.home, row), "same")
            (folder / "SKILL.md").write_text("---\nname: outline\nversion: 0.1.1\n---\n고쳤다", encoding="utf-8")
            self.assertEqual(updates.modified(self.home, row), "changed")
        self.assertEqual(calls, ["0.1.1"])                                # 두 번째는 남긴 기준값을 쓴다(R17)

    def test_folder_basis_is_unknown(self):
        self.skill("work", "outline", "0.1.0")
        row = self.scan()[0]
        self.assertEqual(updates.modified(self.home, row), "unknown")


if __name__ == "__main__":
    unittest.main()

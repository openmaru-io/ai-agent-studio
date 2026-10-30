# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""관리자 직접 게시·다시 게시·허브에서 숨기기·설치 수(스펙 2026-10-29-002 R2·R9~R16, DD10~DD14). 허브는 가짜로 바꾼다."""
import json
import os
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

TMP = tempfile.TemporaryDirectory()
os.environ["AAS_DATA_DIR"] = str(Path(TMP.name) / "data")

from aas.market import hub_admin as ha, hub_hide as hh, market_publish as mp, marketplace as mk, skill_bundle  # noqa: E402

MD = "---\nname: {name}\ndescription: 매주 월요일에 지난주 보고서를 만든다\n{extra}---\n본문"


def files(name="weekly-report", extra="", more=()):
    return [("SKILL.md", MD.format(name=name, extra=extra).encode()), *more]


def info(name="weekly-report", scripts=()):
    return {"name": name, "description": "매주 월요일에 지난주 보고서를 만든다", "files": [], "scripts": list(scripts)}


class FakeHub:
    """허브: {ns/name: {"status": .., "versions": [{version,status,files}]}}"""

    def __init__(self):
        self.pkgs: dict = {}

    def fetch(self, path, cfg=None):
        parts = path.split("/")[4:]                     # /api/v1/skills/{ns}/{name}[/versions[/{v}[/files]]]
        key = "/".join(parts[:2])
        if key not in self.pkgs:
            raise mk.MarketError("없음", 404)
        p = self.pkgs[key]
        if len(parts) == 2:
            pub = [v for v in p["versions"] if v["status"] == "PUBLISHED"]
            return {"status": p.get("status", "ACTIVE"), "publishedVersion": {"version": pub[-1]["version"]} if pub else None}
        if len(parts) == 3:
            return {"items": [{"version": v["version"], "status": v["status"]} for v in p["versions"]]}
        v = next(v for v in p["versions"] if v["version"] == parts[3])
        return [{"filePath": f, "fileSize": n, **({"sha256": v["sha"][f]} if v.get("sha") else {})} for f, n in v["files"].items()]

    def add(self, ns, name, version, status="PUBLISHED", flist=None, sha=None):
        self.pkgs.setdefault(f"{ns}/{name}", {"versions": []})["versions"].append({"version": version, "status": status, "files": flist or {"SKILL.md": 10}, "sha": sha})


class Base(unittest.TestCase):
    def setUp(self):
        for f in mp._dir().glob("*"):
            f.unlink()
        self.hub = FakeHub()
        self.cfg = {"url": "http://hub", "token_file": "", "namespaces": ["free", "paid"], "readonly": ["community"]}
        self.posted = []
        patches = [mock.patch.object(mk, "settings", return_value=self.cfg), mock.patch.object(mk, "fetch", side_effect=self.hub.fetch),
                   mock.patch.object(mp, "_post", side_effect=self._post), mock.patch.object(skill_bundle, "names", return_value=["business-card-ocr"])]
        for p in patches:
            p.start()
            self.addCleanup(p.stop)

    def _post(self, ns, name, version, blob, token=None):
        self.posted.append((ns, name, version))
        self.hub.add(ns, name, version)
        return 200, {"code": 0, "data": {"status": "PUBLISHED"}}

    def direct(self, version="1.0.0", ns="paid", fl=None, inf=None, confirm=False):
        return ha.direct(fl or files(), inf or info(), "h" * 64, ns, version, confirm, "admin@x.io")


class DirectTest(Base):
    def test_new_skill_publishes_with_record_fields_and_no_admin_review_note(self):
        row = self.direct()
        self.assertEqual((row["status"], row["origin"], row["namespace"], row["version"], row["hash"], row["auto"]),
                         ("published", "admin_upload", "paid", "1.0.0", "h" * 64, False))
        self.assertEqual(self.posted, [("paid", "weekly-report", "1.0.0")])
        self.assertEqual(mp.auto_versions(), {})                                         # 관리자 직접 게시는 「검토 없이 게시된 판」이 아니다(R6)

    def test_new_version_is_fixed_to_its_namespace_and_must_be_newer(self):
        self.hub.add("paid", "weekly-report", "1.0.3")
        with self.assertRaises(mk.MarketError) as cm:
            self.direct(version="1.0.3", ns="free")
        self.assertEqual(cm.exception.code, 409)
        self.assertEqual(self.direct(version="1.0.4", ns="free")["namespace"], "paid")

    def test_recheck_at_publish_catches_a_newer_hub_version_and_pending_review(self):
        self.hub.add("paid", "weekly-report", "1.0.3")
        self.assertEqual(ha.preview(files(), info(), [])["next_version"], "1.0.4")
        self.hub.add("paid", "weekly-report", "1.0.4", status="PENDING_REVIEW")      # 미리 보기 뒤 검토 대기 판이 생김(R2·R10)
        with self.assertRaises(mk.MarketError):
            self.direct(version="1.0.4")
        self.assertEqual(ha.next_version("paid", "weekly-report"), "1.0.5")

    def test_blockers(self):
        cases = {"bundle": files(name="business-card-ocr"), "mirror": files(name="pdf")}
        self.hub.add("community", "pdf", "1.0.0")
        with self.assertRaises(mk.MarketError):
            self.direct(fl=cases["bundle"], inf=info("business-card-ocr"))
        with self.assertRaises(mk.MarketError) as cm:
            self.direct(fl=cases["mirror"], inf=info("pdf"))
        self.assertIn("공개 미러", str(cm.exception))
        with self.assertRaises(mk.MarketError):                                           # 스크립트 확인 없음(R4)
            self.direct(inf=info(scripts=[{"path": "scripts/run.py"}]))
        self.assertEqual(self.direct(inf=info(scripts=[{"path": "scripts/run.py"}]), confirm=True)["status"], "published")

    def test_waiting_request_blocks_and_approve_refuses_admin_records(self):
        row = self.direct()
        row.update(status="failed")
        mp._write(row)
        with self.assertRaises(mk.MarketError) as cm:
            mp.approve(row["id"], "admin@x.io", "paid")                                   # 일반 승인으로 다시 보내지 않는다(R9)
        self.assertEqual(cm.exception.code, 404)
        fresh = {**row, "id": "20991231235959000000-abcdef", "status": "publishing", "ts": mp._now(), "version": "2.0.0"}
        mp._write(fresh)
        with self.assertRaises(mk.MarketError):
            self.direct(version="3.0.0")                                                  # 게시 중인 같은 이름

    def test_internal_refs_public_list_ignores_author_mail(self):
        with mock.patch("aas.market.publish_auto.config", return_value={"domains": ["corp.example"]}):
            only_author = files(extra='author: "Kim <kim@corp.example>"\n')
            refs = ha.internal_refs(only_author)
            self.assertEqual((refs["public"], bool(refs["member"])), ([], True))
            self.assertEqual(self.direct(fl=only_author, ns="free")["status"], "published")
            with self.assertRaises(mk.MarketError):
                self.direct(fl=files(name="other-one", more=[("a.md", b"see https://wiki.corp.example/x")]), inf=info("other-one"), ns="free")

    def test_changed_files_against_hub_list_ignores_header(self):
        self.hub.add("paid", "weekly-report", "1.0.0", flist={"SKILL.md": len(mp.set_header(MD.format(name="weekly-report", extra=""), name="weekly-report", version="1.0.0").encode()), "old.md": 3})
        out = ha.changed_files("paid", "weekly-report", files(more=[("new.md", b"x")]))
        self.assertEqual((out["basis"], out["added"], out["removed"], out["changed"]), ("hub_size", ["new.md"], ["old.md"], []))
        import hashlib
        md = mp.set_header(MD.format(name="weekly-report", extra=""), name="weekly-report", version="1.0.1").encode()
        self.hub.add("paid", "weekly-report", "1.0.1", flist={"SKILL.md": len(md), "a.md": 1}, sha={"SKILL.md": hashlib.sha256(md).hexdigest(), "a.md": hashlib.sha256(b"y").hexdigest()})
        out = ha.changed_files("paid", "weekly-report", files(more=[("a.md", b"x")]))         # 크기는 같고 내용만 바뀜 — sha256 으로 잡는다
        self.assertEqual((out["basis"], out["changed"]), ("hub", ["a.md"]))

    def test_scanning_response_is_pending_review(self):
        with mock.patch.object(mp, "_post", return_value=(200, {"code": 0, "data": {"status": "SCANNING"}})):
            self.assertEqual(self.direct()["status"], "pending_review")                     # T0: 일반 구성원 게시는 SCANNING 으로 온다

    def test_stale_publishing_is_shown_as_unknown_failure(self):
        row = self.direct()
        row.update(status="publishing", ts="2020-01-01T00:00:00+09:00")
        mp._write(row)
        view = next(r for r in mp.requests() if r["id"] == row["id"])
        self.assertEqual((view["status"], view["stale"]), ("failed", True))
        self.assertEqual(mp.get(row["id"])["status"], "publishing")                       # 디스크 값은 그대로


class RetryTest(Base):
    def stale_row(self, version="1.0.0"):
        row = self.direct(version=version)
        row.update(status="publishing", ts="2020-01-01T00:00:00+09:00")
        return mp._write(row)

    def test_reconcile_when_hub_has_the_same_bundle(self):
        row = self.stale_row()
        self.hub.pkgs["paid/weekly-report"]["versions"][-1]["files"] = {r: len(d) for r, d in mp._unzip(mp.bundle_path(row["id"]).read_bytes())}
        out, how = ha.retry(row["id"], "admin@x.io", False)
        self.assertEqual((how, out["status"], len(self.posted)), ("reconciled", "published", 1))   # 다시 보내지 않았다

    def test_different_bundle_or_pending_review(self):
        row = self.stale_row()
        with self.assertRaises(mk.MarketError) as cm:
            ha.retry(row["id"], "admin@x.io", False)                                       # 허브 파일 목록이 다르다
        self.assertEqual(cm.exception.code, 409)
        v = self.hub.pkgs["paid/weekly-report"]["versions"][-1]
        v.update(status="PENDING_REVIEW", files={r: len(d) for r, d in mp._unzip(mp.bundle_path(row["id"]).read_bytes())})
        out, how = ha.retry(row["id"], "admin@x.io", False)
        self.assertEqual((how, out["status"]), ("reconciled", "pending_review"))

    def test_republish_when_hub_lacks_it_and_refuse_fresh_publishing(self):
        row = self.stale_row()
        self.hub.pkgs.clear()
        out, how = ha.retry(row["id"], "admin@x.io", False)
        self.assertEqual((how, out["status"]), ("republished", "published"))
        fresh = {**out, "status": "publishing", "ts": mp._now()}
        mp._write(fresh)
        with self.assertRaises(mk.MarketError) as cm:
            ha.retry(row["id"], "admin@x.io", False)                                       # 10분 안 된 게시 중
        self.assertEqual(cm.exception.code, 409)


class InstalledTest(unittest.TestCase):
    def test_one_scan_folds_per_pod_and_skips_dead_pods(self):
        rows = [{"id": "3", "pod": "p1", "status": "done", "mode": "install", "profile": "a", "package": "paid/x"},
                {"id": "2", "pod": "p1", "status": "done", "mode": "rename", "profile": "b", "to": "c"},
                {"id": "1", "pod": "p1", "status": "done", "mode": "install", "profile": "b", "package": "paid/x"},
                {"id": "4", "pod": "gone", "status": "done", "mode": "install", "profile": "a", "package": "paid/x"}]
        mk._ALL.clear()
        with mock.patch.object(mk, "requests", return_value=rows) as req:
            self.assertEqual(ha.installed_count("paid", "x", ["p1", "p2"]), 2)
            self.assertEqual(req.call_count, 1)
            self.assertEqual([r["profile"] for r in mk.installed_all(["p1"])["p1"]], ["a", "c"])


class HideTest(Base):
    def setUp(self):
        super().setUp()
        self.hub.add("paid", "weekly-report", "1.0.0")
        with hh._conn() as conn:
            conn.execute("DELETE FROM market_hub_hidden")

    def call(self, ok, archived):
        def fn(ns, name, action):
            if ok:
                self.hub.pkgs[f"{ns}/{name}"]["status"] = "ARCHIVED" if action == "archive" else "ACTIVE"
            return (200 if ok else 500), {}
        self.hub.pkgs["paid/weekly-report"]["status"] = "ARCHIVED" if archived else "ACTIVE"
        return mock.patch.object(hh, "_call", side_effect=fn)

    def test_hub_failure_writes_no_record(self):
        with self.call(ok=False, archived=False):
            with self.assertRaises(mk.MarketError):
                hh.hide("paid", "weekly-report", "admin@x.io")
        self.assertEqual(hh.records(), [])

    def test_hide_then_show_idempotent_and_listing_follows_hub(self):
        with self.call(ok=True, archived=False):
            hh.hide("paid", "weekly-report", "admin@x.io")
        self.assertEqual([r["name"] for r in hh.listing()], ["weekly-report"])
        with self.assertRaises(mk.MarketError):
            self.direct(version="2.0.0")                                                    # 숨긴 이름(DD12)
        self.hub.pkgs["paid/weekly-report"]["status"] = "ACTIVE"                           # 다른 경로로 다시 보이게 함
        self.assertEqual(hh.listing(), [])
        with self.call(ok=False, archived=False):
            self.assertFalse(hh.show("paid", "weekly-report", "admin@x.io")["hidden"])    # 이미 보이면 성공
        with self.assertRaises(mk.MarketError) as cm:
            hh.hide("paid", "business-card-ocr", "admin@x.io")
        self.assertEqual(cm.exception.code, 403)


if __name__ == "__main__":
    unittest.main()

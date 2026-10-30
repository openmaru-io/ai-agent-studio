# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""내 스킬 올리기(스펙 2026-10-14-015 T5, 리뷰 R4·R10·R11): 묶음 규칙·이름·유료 차단·같은 이름·게시 상태."""
import json
import os
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest import mock

TMP = tempfile.TemporaryDirectory()
os.environ["AAS_DATA_DIR"] = str(Path(TMP.name) / "data")

from aas.market import market_publish as mp, marketplace as mk  # noqa: E402

GOOD = "---\nname: weekly-report\ndescription: 매주 월요일에 지난주 보고서를 만든다\n---\n본문"


def put(root: Path, files: dict):
    for rel, text in files.items():
        p = root / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(text, encoding="utf-8")


class PublishTest(unittest.TestCase):
    def setUp(self):
        self.home = Path(tempfile.mkdtemp(dir=TMP.name))
        self.root = self.home / "profiles" / "ma"
        put(self.root, {"skills/local/weekly-report/SKILL.md": GOOD, "skills/local/weekly-report/scripts/run.py": "print(1)\n"})
        for f in mp._dir().glob("*"):
            f.unlink()
        self.cfg = {"url": "http://hub", "token_file": "", "namespaces": ["free", "paid"]}
        self._p = [mock.patch.object(mk, "settings", return_value=self.cfg), mock.patch.object(mk, "install_state", return_value={"enabled": True})]
        for p in self._p:
            p.start()
        self.missing = mock.patch.object(mk, "fetch", side_effect=mk.MarketError("없음", 404))
        self.missing.start()

    def tearDown(self):
        self.missing.stop()
        for p in self._p:
            p.stop()

    def ask(self, **kw):
        args = dict(pod_id="p1", home=self.home, who="kim@x.io", admin=False, profile="ma", skill_path="skills/local/weekly-report", name="weekly-report", version="1.0.0")
        args.update(kw)
        return mp.request_publish(**args)

    def test_request_builds_bundle_with_fixed_header_and_keeps_it(self):
        row = self.ask(name="weekly-report-kr")
        self.assertEqual((row["status"], row["origin"], row["derived_from"]), ("requested", "local", ""))
        with zipfile.ZipFile(mp.bundle_path(row["id"])) as z:
            self.assertEqual(sorted(z.namelist()), ["SKILL.md", "scripts/run.py"])
            head = mp.header_of(z.read("SKILL.md").decode())
        self.assertEqual((head["name"], head["version"]), ("weekly-report-kr", "1.0.0"))          # 올린 패키지 이름만 마켓 규칙으로, 원본 스킬은 그대로
        self.assertIn("name: weekly-report", (self.root / "skills/local/weekly-report/SKILL.md").read_text(encoding="utf-8"))

    def test_bundle_rules(self):
        folder = self.root / "skills/local/weekly-report"
        put(folder, {".env": "KEY=1", ".usage.json": "{}", "scripts/__pycache__/x.pyc": "b"})
        row = self.ask()
        with zipfile.ZipFile(mp.bundle_path(row["id"])) as z:
            self.assertEqual(sorted(z.namelist()), ["SKILL.md", "scripts/run.py"])               # 점 파일·실행 부산물은 들어가지 않는다
        for f in mp._dir().glob("*"):
            f.unlink()
        put(folder, {"notes.md": "token sk-abcdefghijklmnopqrstuvwxyz0123456789"})
        with self.assertRaises(mk.MarketError) as cm:
            self.ask()
        self.assertIn("비밀값", str(cm.exception))
        (folder / "notes.md").unlink()
        (folder / "link.txt").symlink_to(self.root / "skills/local/weekly-report/SKILL.md")
        with self.assertRaises(mk.MarketError):
            self.ask()                                                                             # 심볼릭 링크는 거절
        (folder / "link.txt").unlink()
        put(folder, {"big.txt": "x" * (mp.MAX_FILE_BYTES + 1)})
        with self.assertRaises(mk.MarketError):
            self.ask()

    def test_name_version_and_description_rules(self):
        for bad in ("Weekly Report", "x", "-a"):
            with self.assertRaises(mk.MarketError):
                self.ask(name=bad)
        with self.assertRaises(mk.MarketError):
            self.ask(version="1.0")
        put(self.root, {"skills/local/short/SKILL.md": "---\nname: short\ndescription: 짧다\n---\n"})
        with self.assertRaises(mk.MarketError):
            self.ask(skill_path="skills/local/short", name="short")
        for path in ("skills/../x", "other/x", "skills/.archive/a"):
            with self.assertRaises(mk.MarketError):
                self.ask(skill_path=path)

    def test_bundled_unmodified_and_hub_are_refused(self):
        put(self.root, {"skills/.hub/lock.json": json.dumps({"installed": {"weekly-report": {}}})})
        with self.assertRaises(mk.MarketError):
            self.ask()

    def test_paid_original_is_blocked_and_free_original_is_recorded(self):
        put(self.root, {"skills/market/report/SKILL.md": GOOD.replace("weekly-report", "report")})
        rec = [{"profile": "ma", "kind": "skill", "name": "report", "namespace": "paid", "version": "1.2.0", "package": "paid/report"}]
        with mock.patch.object(mk, "installed", return_value=rec), mock.patch.object(mk, "package", return_value={"paid": True}):
            with self.assertRaises(mk.MarketError) as cm:
                self.ask(skill_path="skills/market/report", name="report-kr")
        self.assertIn("허용이 필요한", str(cm.exception))                                       # 「유료」를 쓰지 않는다(스펙 2026-10-28-010 T3)
        self.assertNotIn("유료", str(cm.exception))
        with mock.patch.object(mk, "installed", return_value=[{**rec[0], "namespace": "free", "package": "free/report"}]), mock.patch.object(mk, "package", return_value={"paid": False}):
            row = self.ask(skill_path="skills/market/report", name="report-kr")
        self.assertEqual(row["derived_from"], "free/report@1.2.0")                               # 원본 이름·판을 머리말에 남긴다
        with zipfile.ZipFile(mp.bundle_path(row["id"])) as z:
            self.assertEqual(mp.header_of(z.read("SKILL.md").decode())["derived_from"], "free/report@1.2.0")

    def test_same_name_in_market_is_refused_unless_it_is_a_newer_version_of_my_own(self):
        with mock.patch.object(mk, "fetch", return_value={"publishedVersion": {"version": "1.0.0"}}):
            with self.assertRaises(mk.MarketError) as cm:
                self.ask()
            self.assertEqual(cm.exception.code, 409)
        row = self.ask()
        mp._write({**row, "status": "published", "namespace": "free"})
        with mock.patch.object(mk, "fetch", return_value={"publishedVersion": {"version": "1.0.0"}}):
            with self.assertRaises(mk.MarketError):
                self.ask(version="1.0.0")                                                         # 같은 판은 안 된다
            self.assertEqual(self.ask(version="1.1.0")["status"], "requested")                    # 올린 사람의 새 판은 된다
            with self.assertRaises(mk.MarketError):
                self.ask(who="lee@x.io", version="2.0.0")                                         # 남의 이름은 안 된다

    def test_approve_publishes_and_records_status_as_is(self):
        row = self.ask()
        with mock.patch.object(mp, "_post", return_value=(200, {"code": 0, "data": {"status": "PENDING_REVIEW"}})) as post:
            out = mp.approve(row["id"], "admin@x.io", "free")
        self.assertEqual((out["status"], out["namespace"], out["decided_by"]), ("pending_review", "free", "admin@x.io"))
        self.assertEqual(post.call_args[0][:3], ("free", "weekly-report", "1.0.0"))
        self.assertTrue(mp.bundle_path(row["id"]))                                                # 올린 묶음은 판별로 남는다
        with self.assertRaises(mk.MarketError):
            mp.approve(row["id"], "admin@x.io", "free")                                           # 이미 처리한 요청

    def test_label_namespace_is_stored_as_slug(self):
        """스펙 2026-10-28-010 D7: 올리기·승인에 표시 이름(shared·restricted)을 보내면 slug 로 저장하고, 오류 문장은 표시 이름을 쓴다."""
        row = self.ask(namespace="restricted")
        self.assertEqual(row["want_namespace"], "paid")
        with mock.patch.object(mp, "_post", return_value=(200, {"code": 0, "data": {"status": "PUBLISHED"}})) as post:
            out = mp.approve(row["id"], "admin@x.io", "restricted")
        self.assertEqual((out["namespace"], post.call_args[0][0]), ("paid", "paid"))
        other = self.ask(name="another-one")
        with mock.patch.object(mp, "_exists", return_value={"namespace": "paid", "version": "1.0.0"}):
            with self.assertRaises(mk.MarketError) as cm:
                mp.approve(other["id"], "admin@x.io", "shared")
        self.assertEqual(cm.exception.code, 409)
        self.assertIn("(제한)", str(cm.exception))                                               # 시험은 한국어(기본)로 돈다
        self.assertNotIn("paid", str(cm.exception))
        from aas.common import i18n                                                               # 영어 요청은 영어 이름(§6-3)
        self.addCleanup(i18n.set_lang, i18n.DEFAULT)
        i18n.set_lang("en")
        with mock.patch.object(mp, "_exists", return_value={"namespace": "paid", "version": "1.0.0"}):
            with self.assertRaises(mk.MarketError) as cm:
                mp.approve(other["id"], "admin@x.io", "공용")                                     # 한국어 이름도 slug 로
        self.assertIn("(restricted)", str(cm.exception))

    def test_failed_publish_can_be_approved_again_and_reject_records_reason(self):
        row = self.ask()
        with mock.patch.object(mp, "_post", return_value=(500, {"msg": "서버 오류"})):
            self.assertEqual(mp.approve(row["id"], "a", "free")["status"], "failed")
        with mock.patch.object(mp, "_post", return_value=(200, {"code": 0, "data": {"status": "PUBLISHED"}})):
            self.assertEqual(mp.approve(row["id"], "a", "free")["status"], "published")
        other = self.ask(name="another-one")
        out = mp.reject(other["id"], "admin", "중복입니다")
        self.assertEqual((out["status"], out["message"]), ("rejected", "중복입니다"))
        with self.assertRaises(mk.MarketError):
            mp.approve("20260101000000000000-abcdef", "a", "free")
        with self.assertRaises(mk.MarketError):
            mp.approve(row["id"], "a", "unknown")


if __name__ == "__main__":
    unittest.main()

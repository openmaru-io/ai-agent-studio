# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""주인 스킬 자동 승인(스펙 2026-10-28-001 Q14·D6·D11·R18): 만든 기록·판정·자동 게시·실패하면 관리자 대기·사내 주소·비밀 문자열."""
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

TMP = tempfile.TemporaryDirectory()
os.environ["AAS_DATA_DIR"] = str(Path(TMP.name) / "data")

from aas.market import market_publish as mp, marketplace as mk, publish_auto as pa  # noqa: E402

GOOD = "---\nname: weekly-report\ndescription: 매주 월요일에 지난주 보고서를 만든다\n---\n본문"


def put(root: Path, files: dict):
    for rel, text in files.items():
        p = root / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(text, encoding="utf-8")


class AutoTest(unittest.TestCase):
    def setUp(self):
        self.home = Path(tempfile.mkdtemp(dir=TMP.name))
        self.root = self.home / "profiles" / "ma"
        put(self.root, {"skills/uploaded/weekly-report/SKILL.md": GOOD, "skills/uploaded/weekly-report/scripts/run.py": "print(1)\n"})
        for f in mp._dir().glob("*"):
            f.unlink()
        with pa._conn() as conn:
            conn.execute("DELETE FROM skill_authored")
        pa.set_config(True, "", ["free", "paid"])
        self.cfg = {"url": "http://hub", "token_file": "", "namespaces": ["free", "paid"]}
        self._p = [mock.patch.object(mk, "settings", return_value=self.cfg), mock.patch.object(mk, "install_state", return_value={"enabled": True}),
                   mock.patch.object(mk, "fetch", side_effect=mk.MarketError("없음", 404))]
        for p in self._p:
            p.start()

    def tearDown(self):
        for p in self._p:
            p.stop()

    def ask(self, **kw):
        args = dict(pod_id="p1", home=self.home, who="kim@x.io", admin=False, profile="ma", skill_path="skills/uploaded/weekly-report",
                    name="weekly-report", version="1.0.0")
        args.update(kw)
        return mp.request_publish(**args)

    def test_만든_사람이고_그대로면_자동_대상(self):
        self.assertTrue(pa.record_folder("p1", self.home, "ma", "skills/uploaded/weekly-report", "Kim@x.io"))
        row = self.ask()
        self.assertEqual(pa.eligible(row, owner=True, admin=False), (True, ""))
        self.assertEqual(pa.eligible(row, owner=False, admin=False), (False, "not_owner"))
        self.assertEqual(pa.eligible(row, owner=True, admin=True), (False, "admin"))       # 관리자는 지금처럼 직접 승인
        self.assertEqual(pa.eligible({**row, "who": "lee@x.io"}, owner=True, admin=False), (False, "other_author"))
        self.assertEqual(pa.eligible({**row, "origin": "bundled_modified"}, True, False), (False, "origin_bundled_modified"))
        self.assertEqual(pa.eligible({**row, "origin": "agent"}, True, False), (True, ""))

    def test_만든_뒤_바뀌면_관리자_승인(self):
        pa.record_folder("p1", self.home, "ma", "skills/uploaded/weekly-report", "kim@x.io")
        (self.root / "skills/uploaded/weekly-report/scripts/run.py").write_text("print(2)\n", encoding="utf-8")   # AI 에이전트가 고쳤다
        self.assertEqual(pa.eligible(self.ask(), True, False), (False, "changed_since"))
        with pa._conn() as conn:
            conn.execute("DELETE FROM skill_authored")
        self.assertEqual(pa.eligible(self.ask(name="weekly-report-b"), True, False), (False, "no_record"))

    def test_자동_승인은_auto_로_게시하고_실패하면_관리자_대기(self):
        row = self.ask()
        with mock.patch.object(mp, "_post", return_value=(200, {"code": 0, "data": {"status": "PUBLISHED"}})):
            out = mp.auto_approve(row["id"], "paid")
        self.assertEqual((out["status"], out["decided_by"], out["auto"], out["namespace"]), ("published", "auto:kim@x.io", True, "paid"))
        # 설치하는 모든 사용자가 보므로 이메일 대신 이름(모르면 이메일 앞부분)을 보낸다(2026-10-30)
        self.assertEqual(mp.auto_versions(), {"paid/weekly-report": [{"version": "1.0.0", "by": "kim"}]})
        other = self.ask(name="another-one")
        with mock.patch.object(mp, "_post", return_value=(500, {"msg": "서버 오류"})):
            out = mp.auto_approve(other["id"], "paid")
        self.assertEqual((out["status"], out.get("auto_failed")), ("requested", True))    # 관리자가 승인할 수 있게 남는다(F11)
        self.assertNotIn("paid/another-one", mp.auto_versions())

    def test_사내_주소는_공개면_거절하고_구성원이면_경고(self):
        put(self.root, {"skills/uploaded/weekly-report/notes.md": "위키: https://intra.example.openmaru.io/x\n서버 10.0.0.5 와 8.8.8.8\n"
                                                                     "게이트웨이 http://hermes.svc.local:9119\n공개 https://example.com\n"})
        row = self.ask()
        self.assertEqual(row["internal_refs"], ["notes.md:1", "notes.md:2", "notes.md:3"])             # x.local 같은 내부 전용 이름도
        with mock.patch.object(mp, "_post", return_value=(200, {"code": 0, "data": {"status": "PUBLISHED"}})):
            with self.assertRaises(mk.MarketError) as cm:
                mp.approve(row["id"], "admin@x.io", "free")
            self.assertIn("notes.md:1", str(cm.exception))
            out = mp.auto_approve(row["id"], "free")                                       # 자동도 같은 검사 — 관리자 대기로
            self.assertEqual(out["status"], "requested")
            self.assertEqual(mp.approve(row["id"], "admin@x.io", "paid")["status"], "published")   # 구성원 네임스페이스는 된다

    def test_공개_게시는_author_의_이메일을_지우고_이름만_남긴다(self):
        """2026-10-28 OKE 시험: AAS 가 머리말에 넣는 author 이메일이 사내 주소로 잡혀 직원 스킬은 공개 게시가 모두 막혔다. 사용자 결정 B."""
        import io
        import zipfile
        head = "---\nname: weekly-report\ndescription: 매주 월요일에 지난주 보고서를 만든다\nauthor: \"kim@team.example.openmaru.io\"\n---\n본문"
        put(self.root, {"skills/uploaded/weekly-report/SKILL.md": head})
        row = self.ask()
        self.assertEqual(row["internal_refs"], ["SKILL.md:4"])                             # 구성원 네임스페이스에는 경고로 남는다
        sent = {}

        def post(ns, name, version, blob):
            sent["md"] = zipfile.ZipFile(io.BytesIO(blob)).read("SKILL.md").decode()
            return 200, {"code": 0, "data": {"status": "PUBLISHED"}}
        with mock.patch.object(mp, "_post", side_effect=post):
            out = mp.approve(row["id"], "admin@x.io", "free")
        self.assertEqual(out["status"], "published")
        self.assertIn('author: "kim"', sent["md"])
        self.assertNotIn("@", sent["md"])
        with zipfile.ZipFile(mp.bundle_path(row["id"])) as z:                              # 보관한 묶음도 게시한 그대로
            self.assertNotIn("@", z.read("SKILL.md").decode())
        put(self.root, {"skills/uploaded/weekly-report/SKILL.md": head, "skills/uploaded/weekly-report/notes.md": "https://intra.example.openmaru.io\n"})
        other = self.ask(name="weekly-two")
        with mock.patch.object(mp, "_post", side_effect=post):
            with self.assertRaises(mk.MarketError) as cm:                                  # 본문의 사내 주소는 그대로 거절
                mp.approve(other["id"], "admin@x.io", "free")
        self.assertIn("notes.md:1", str(cm.exception))
        self.assertNotIn("SKILL.md", str(cm.exception))
        self.assertEqual(mp.public_author('"Kim Minsu <kim@x.io>"'), "Kim Minsu")

    def test_비밀_문자열_패턴을_넓혔다(self):
        for token in ("ghp_" + "a" * 36, "xoxb-1234567890-abcdef", "AIza" + "B" * 35, "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.c2lnbmF0dXJlLXZhbHVl"):
            put(self.root, {"skills/uploaded/weekly-report/conf.txt": f"key={token}\n"})
            with self.assertRaises(mk.MarketError, msg=token):
                self.ask()

    def test_설정(self):
        self.assertEqual(pa.config(["free", "paid"])["namespace"], "paid")                 # 기본: 공개가 아닌 첫 네임스페이스
        self.assertTrue(pa.config(["free", "paid"])["auto"])
        cfg = pa.set_config(False, "free", ["free", "paid"])
        self.assertEqual((cfg["auto"], cfg["namespace"]), (False, "free"))
        with self.assertRaises(ValueError):
            pa.set_config(None, "nowhere", ["free", "paid"])

    def test_서버는_조건이_맞을_때만_뒤에서_자동_승인한다(self):
        import types
        from aas.web import server
        pod = types.SimpleNamespace(id="p1", hermes_home=self.home)
        pa.record_folder("p1", self.home, "ma", "skills/uploaded/weekly-report", "kim@x.io")
        row = self.ask()
        ran = []

        class Now:                                         # 뒤 작업을 바로 돌린다
            def __init__(self, target, daemon=True):
                self.target = target

            def start(self):
                ran.append(1)
                self.target()
        with mock.patch.object(server.threading, "Thread", Now), mock.patch.object(server, "_forget_market_catalog"), \
                mock.patch.object(mp, "_post", return_value=(200, {"code": 0, "data": {"status": "PUBLISHED"}})):
            out = server._maybe_auto_publish(pod, row, owner=True, admin=False)
            self.assertEqual((out["auto"], out["auto_namespace"]), ("pending", "paid"))
            self.assertEqual(mp.get(row["id"])["status"], "published")
            other = self.ask(name="another-one")
            pa.set_config(False, None, ["free", "paid"])
            out = server._maybe_auto_publish(pod, other, owner=True, admin=False)
            self.assertEqual(out["auto_reason"], "off")                                    # 관리자가 끄면 모두 관리자 승인
            self.assertEqual(mp.get(other["id"])["status"], "requested")
        self.assertEqual(len(ran), 1)

    def test_이름으로_스킬_폴더를_찾는다(self):
        put(self.root, {"skills/hello/SKILL.md": GOOD})
        self.assertEqual(pa.find_skill_dir(self.home, "ma", "hello"), "skills/hello")
        self.assertEqual(pa.find_skill_dir(self.home, "ma", "weekly-report"), "skills/uploaded/weekly-report")
        self.assertIsNone(pa.find_skill_dir(self.home, "ma", "nope"))

    def test_파일_경로에서_스킬_폴더를_찾는다(self):
        self.assertEqual(pa.skill_folder_of(self.home, "profiles/ma/skills/uploaded/weekly-report/scripts/run.py"),
                         ("ma", "skills/uploaded/weekly-report"))
        self.assertEqual(pa.skill_folder_of(self.home, "profiles/ma/skills/uploaded/weekly-report/SKILL.md"), ("ma", "skills/uploaded/weekly-report"))
        self.assertIsNone(pa.skill_folder_of(self.home, "profiles/ma/config.yaml"))


if __name__ == "__main__":
    unittest.main()

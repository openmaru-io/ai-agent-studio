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

    def reject_in_gap(self, rid: str):
        """auto_approve 가 상태를 본 뒤, 잠금을 잡기 전에 관리자가 반려한 상황. approve 는 잠금 전에 ns_slug 를 부른다."""
        real = mk.ns_slug

        def hook(ns):
            hook.n += 1
            if hook.n == 1:
                mp.reject(rid, "admin@x.io", "다시 보내세요")
            return real(ns)
        hook.n = 0
        return mock.patch.object(mk, "ns_slug", side_effect=hook)

    def test_반려된_요청은_자동_승인이_되살리지_않는다(self):
        """B0(스펙 2026-11-20-009 §3-2 2): 반려가 끼어들면 approve 의 404 를 받아 requested 로 덮어썼다 — 반려가 사라졌다."""
        row = self.ask()
        with self.reject_in_gap(row["id"]), mock.patch.object(mp, "_post", return_value=(200, {"code": 0, "data": {"status": "PUBLISHED"}})) as post:
            mp.auto_approve(row["id"], "paid")
        self.assertEqual(mp.get(row["id"])["status"], "rejected")
        post.assert_not_called()

    def test_네임스페이스_오류와_반려가_겹쳐도_반려_유지(self):
        """엔지니어링 H2: 네임스페이스 검사 실패를 받아 되돌리는 쓰기도 잠금 안에서 상태를 다시 본다."""
        row = self.ask()
        with self.reject_in_gap(row["id"]):
            mp.auto_approve(row["id"], "nowhere")
        self.assertEqual(mp.get(row["id"])["status"], "rejected")

    def test_네임스페이스_오류만이면_관리자_대기로_남는다(self):
        row = self.ask()
        out = mp.auto_approve(row["id"], "nowhere")
        self.assertEqual((out["status"], out.get("auto_failed")), ("requested", True))

    def test_자동_승인이_게시하는_동안_반려는_기다리지_않고_busy(self):
        """엔지니어링 M3·H3: 게시 중(허브 호출 최대 120초) 잠금을 쥐므로 반려는 바로 busy. 잠금은 다른 스레드가 쥐고 제한 시간으로 끝낸다."""
        import threading
        row = self.ask()
        entered, release = threading.Event(), threading.Event()

        def slow_post(*a, **k):
            entered.set()
            release.wait(5)
            return 200, {"code": 0, "data": {"status": "PUBLISHED"}}
        with mock.patch.object(mp, "_post", side_effect=slow_post):
            th = threading.Thread(target=mp.auto_approve, args=(row["id"], "paid"))
            th.start()
            try:
                self.assertTrue(entered.wait(5))
                with self.assertRaises(mp.MarketError) as cm:
                    mp.reject(row["id"], "admin@x.io", "")
                self.assertEqual((cm.exception.code, getattr(cm.exception, "reason", "")), (409, "busy"))
            finally:
                release.set()
                th.join(5)
        self.assertFalse(th.is_alive())
        self.assertEqual(mp.get(row["id"])["status"], "published")

    # ---- 거두기(이슈 #25, 스펙 2026-11-20-009 §3-2) ----
    def refused(self, rid, who="kim@x.io"):
        with self.assertRaises(mk.MarketError) as cm:
            mp.withdraw(rid, who)
        return cm.exception.code, cm.exception.reason, (getattr(cm.exception, "extra", None) or {}).get("status")

    def test_거두기는_요청자만_하고_같은_이름을_다시_보낼_수_있다(self):
        row = self.ask()
        self.assertEqual(self.refused(row["id"], "lee@x.io")[:2], (403, "forbidden"))           # POD 주인·관리자라도 남의 요청은 안 된다
        out = mp.withdraw(row["id"], "KIM@x.io")                                                # 이메일 대소문자는 가리지 않는다
        self.assertEqual((out["status"], out["decided_by"], out["message"]), ("withdrawn", "kim@x.io", ""))
        self.assertTrue(mp.bundle_path(row["id"]))                                               # 묶음은 남는다(반려와 같다)
        self.assertEqual(self.refused(row["id"]), (409, "state", "withdrawn"))
        again = self.ask()                                                                       # 이름 막기가 풀렸다
        self.assertEqual(again["status"], "requested")
        self.assertEqual(self.refused("20990101000000000000-abcdef")[:2], (404, "not_found"))

    def test_거둘_수_없는_상태는_상태별로_409(self):
        row = self.ask()
        for status in ("published", "pending_review", "rejected", "failed"):
            mp._write({**mp.get(row["id"]), "status": status})
            self.assertEqual(self.refused(row["id"]), (409, "state", status))
        mp._write({**mp.get(row["id"]), "status": "publishing", "ts": "2000-01-01T00:00:00+00:00"})
        self.assertEqual(self.refused(row["id"]), (409, "state", "failed"))                      # 오래된 publishing 은 화면처럼 실패로 본다

    def test_거둔_요청은_자동_승인이_게시하지_않는다(self):
        row = self.ask()
        mp.withdraw(row["id"], "kim@x.io")
        with mock.patch.object(mp, "_post", return_value=(200, {"code": 0, "data": {"status": "PUBLISHED"}})) as post:
            mp.auto_approve(row["id"], "paid")
        self.assertEqual(mp.get(row["id"])["status"], "withdrawn")
        post.assert_not_called()

    def test_자동_승인_실패_뒤에는_거둘_수_있다(self):
        row = self.ask()
        with mock.patch.object(mp, "_post", return_value=(500, {"msg": "서버 오류"})):
            self.assertEqual(mp.auto_approve(row["id"], "paid")["status"], "requested")
        self.assertEqual(mp.withdraw(row["id"], "kim@x.io")["status"], "withdrawn")

    def test_게시하는_동안_거두기는_바로_busy(self):
        """다른 스레드가 잠금을 쥔 채 허브에 게시하는 중 — 거두기는 기다리지 않는다(엔지니어링 H3: Event·join 제한 시간)."""
        import threading
        row = self.ask()
        entered, release = threading.Event(), threading.Event()

        def slow_post(*a, **k):
            entered.set()
            release.wait(5)
            return 200, {"code": 0, "data": {"status": "PUBLISHED"}}
        with mock.patch.object(mp, "_post", side_effect=slow_post):
            th = threading.Thread(target=mp.auto_approve, args=(row["id"], "paid"))
            th.start()
            try:
                self.assertTrue(entered.wait(5))
                self.assertEqual(self.refused(row["id"])[:2], (409, "busy"))
            finally:
                release.set()
                th.join(5)
        self.assertFalse(th.is_alive())
        self.assertEqual(self.refused(row["id"]), (409, "state", "published"))

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

    # ---- 보내기 전 자동 승인 미리 알림(이슈 #26, 스펙 2026-11-20-009 §3-3) ----
    def auto_of(self, owner=True, admin=False, namespace="", who="kim@x.io"):
        out = mp.check_publish("p1", self.home, who, admin, "ma", "profiles/ma/skills/uploaded/weekly-report", "weekly-report", "1.0.0",
                               hub=False, owner=owner, namespace=namespace)
        return out["auto"], [c["id"] for c in out["checks"]]

    def test_점검은_요청과_같은_판정으로_자동_승인을_예상한다(self):
        pa.record_folder("p1", self.home, "ma", "skills/uploaded/weekly-report", "kim@x.io")
        auto, _ = self.auto_of()
        self.assertEqual((auto["will"], auto["reason"], auto["namespace"], auto["public"]), (True, "", "paid", False))
        self.assertEqual(self.auto_of(owner=False)[0]["reason"], "not_owner")
        self.assertEqual(self.auto_of(admin=True)[0]["reason"], "admin")
        self.assertEqual(self.auto_of(who="lee@x.io")[0]["reason"], "other_author")
        (self.root / "skills/uploaded/weekly-report/scripts/run.py").write_text("print(9)\n", encoding="utf-8")
        self.assertEqual(self.auto_of()[0]["reason"], "changed_since")
        with pa._conn() as conn:
            conn.execute("DELETE FROM skill_authored")
        self.assertEqual(self.auto_of()[0]["reason"], "no_record")
        pa.set_config(False, None, ["free", "paid"])
        self.assertEqual(self.auto_of()[0]["reason"], "off")

    def test_점검의_해시는_요청의_해시와_같다_제외_파일이_있어도(self):
        put(self.root, {"skills/uploaded/weekly-report/.hidden": "x", "skills/uploaded/weekly-report/logs/run.log": "x"})
        pa.record_folder("p1", self.home, "ma", "skills/uploaded/weekly-report", "kim@x.io")
        self.assertTrue(self.auto_of()[0]["will"])
        row = self.ask()
        self.assertEqual(pa.eligible(row, True, False), (True, ""))                    # 같은 묶음 해시 — 예상과 실제가 같다

    def test_공개_대상은_공개본에_사내_주소가_있으면_예상이_안_됨이고_author_이메일만이면_됨(self):
        head = "---\nname: weekly-report\ndescription: 매주 월요일에 지난주 보고서를 만든다\nauthor: \"kim@team.example.openmaru.io\"\n---\n본문"
        put(self.root, {"skills/uploaded/weekly-report/SKILL.md": head})
        pa.record_folder("p1", self.home, "ma", "skills/uploaded/weekly-report", "kim@x.io")
        auto, ids = self.auto_of(namespace="free")
        self.assertEqual((auto["will"], auto["public"]), (True, True))                 # 엔지니어링 H1: author 이메일은 게시 때 지워진다
        self.assertNotIn("internal", ids)                                              # 「공개에는 올라가지 않습니다」 거짓 경고도 없다
        put(self.root, {"skills/uploaded/weekly-report/notes.md": "https://intra.example.openmaru.io\n"})
        pa.record_folder("p1", self.home, "ma", "skills/uploaded/weekly-report", "kim@x.io")
        auto, ids = self.auto_of(namespace="free")
        self.assertEqual((auto["will"], auto["reason"]), (False, "internal_refs"))
        self.assertIn("internal", ids)
        self.assertTrue(self.auto_of(namespace="paid")[0]["will"])                    # 구성원 구역은 사내 주소로 막지 않는다

    def test_판정이_실패해도_점검은_돌고_unknown(self):
        with mock.patch.object(pa, "predict", side_effect=RuntimeError("x")):
            auto, ids = self.auto_of()
        self.assertEqual(auto, {"will": False, "reason": "unknown"})
        self.assertIn("origin", ids)

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

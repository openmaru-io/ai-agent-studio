# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""마켓 시험 — 가짜 SkillHub 응답으로 목록·종류 판정·유료 허용·요청 검사를 보고, 받은 패키지를 어떻게 검사하고 배포판 모양으로 만드는지 본다. 컨테이너 안 명령은 오퍼레이터(Go 시험·kind)가 본다."""
import aasserver  # 실제 uvicorn 앱을 띄우는 시험 하네스(OMAI-1100)
import hashlib
import io
import json
import os
import tempfile
import unittest
from unittest import mock
import zipfile
from pathlib import Path

TMP = tempfile.TemporaryDirectory()
os.environ.setdefault("AAS_DATA_DIR", str(Path(TMP.name) / "data"))

from aas.market import market_stage as agent, marketplace as mk
from aas.common import store  # noqa: E402     (agent = 받은 패키지를 Hermes 배포판 모양으로 만드는 서버 쪽 모듈)

CFG = {"url": "http://hub", "token_file": "", "namespaces": ["free", "paid"]}
FILES = {"hello": ["SKILL.md", "scripts/hello.py"], "bot": ["SKILL.md", "agent/distribution.yaml", "agent/SOUL.md", "agent/skills/x/y/SKILL.md"]}


def fake_fetch(path, cfg=None):
    if path.startswith("/api/web/skills?namespace="):
        ns = path.split("=")[1].split("&")[0]
        rows = {"free": [("hello", "PUBLIC", "0.2.0"), ("bot", "PUBLIC", "1.0.0")], "paid": [("hello", "NAMESPACE_ONLY", "0.1.0")], "community": []}[ns]
        return {"items": [{"slug": s, "namespace": ns, "status": "ACTIVE", "visibility": v, "summary": "요약", "publishedVersion": {"version": ver}} for s, v, ver in rows]
                + [{"slug": "draft", "namespace": ns, "status": "ACTIVE", "visibility": v, "publishedVersion": None} for _, v, _ in rows[:1]]}
    ns, name = path.split("/")[4:6]
    ver = {"free/hello": "0.2.0", "free/bot": "1.0.0", "paid/hello": "0.1.0"}.get(f"{ns}/{name}")
    if not ver:
        raise mk.MarketError("없음", 404)
    if path.endswith("/files"):
        return [{"filePath": p, "fileSize": 10} for p in FILES[name]]
    if path.endswith("/versions"):
        return {"items": [{"version": ver, "status": "PUBLISHED"}, {"version": "0.0.1", "status": "PUBLISHED"}, {"version": "9.9.9", "status": "PENDING_REVIEW"}]}
    if "/versions/" in path:
        return {"parsedMetadataJson": json.dumps({"body": "# 본문"})}
    return {"summary": "요약", "visibility": "NAMESPACE_ONLY" if ns == "paid" else "PUBLIC", "publishedVersion": {"version": ver}}


class MarketTest(unittest.TestCase):
    def setUp(self):
        self.old, mk.fetch = mk.fetch, fake_fetch
        for d in ("queue", "done"):
            for p in mk._dir(d).glob("*"):
                p.unlink()
        with mk._conn() as conn:
            conn.execute("DELETE FROM market_grants")

    def tearDown(self):
        mk.fetch = self.old

    def ask(self, pkg, profile, mode="install", version="", pod="p1", have=("ma", "sa")):
        return mk.request_install(pod, "hermes-agent", pkg, version, profile, mode, "a@x.io", list(have))

    def finish(self, row, status="done"):
        (mk._dir("queue") / f"{row['id']}.json").unlink()
        (mk._dir("done") / f"{row['id']}.json").write_text(json.dumps({**row, "status": status, "message": "glpat-AAAAAAAAAAAAAAAAAAAAAAAA 끝"}))

    def test_catalog_keeps_only_published_and_marks_paid(self):
        rows = mk.catalog(CFG)
        self.assertEqual([(r["id"], r["paid"]) for r in rows], [("free/bot", False), ("free/hello", False), ("paid/hello", True)])

    def test_readonly_namespace_is_listed_but_not_a_publish_target(self):
        """C3: 미러 번들 네임스페이스(community)는 마켓에 보이지만 게시 대상 목록(namespaces)에는 없다."""
        seen = []
        mk.fetch = lambda path, cfg=None: seen.append(path) or {"items": []}
        mk.catalog({**CFG, "readonly": ["community"]})
        self.assertEqual([p.split("namespace=")[1].split("&")[0] for p in seen], ["free", "paid", "community"])
        self.assertNotIn("community", mk.settings()["namespaces"])
        self.assertEqual(mk.settings()["readonly"], ["community"])

    def test_missing_readonly_namespace_does_not_hide_the_rest(self):
        def fetch_without_community(path, cfg=None):
            if "namespace=community" in path:
                raise mk.MarketError("없음", 404)
            return fake_fetch(path, cfg)
        mk.fetch = fetch_without_community
        self.assertEqual(len(mk.catalog({**CFG, "readonly": ["community"]})), 3)

    def test_catalog_reads_every_page(self):
        """C1: 한 쪽(100개)이 넘으면 다음 쪽도 읽는다. page 를 무시하는 서버가 같은 쪽을 되풀이해도 멈춘다."""
        calls = []

        def paged(path, cfg=None):
            page = int(path.split("page=")[1].split("&")[0])
            calls.append(page)
            n = 100 if page == 0 else 30
            return {"total": 130, "items": [{"slug": f"s{page}-{i}", "namespace": "free", "status": "ACTIVE", "visibility": "PUBLIC",
                                             "publishedVersion": {"version": "1.0.0"}} for i in range(n)]}
        mk.fetch = paged
        rows = mk.catalog({**CFG, "namespaces": ["free"]})
        self.assertEqual((len(rows), calls), (130, [0, 1]))

        calls.clear()
        mk.fetch = lambda path, cfg=None: {"items": [{"slug": f"s{i}", "namespace": "free", "status": "ACTIVE", "publishedVersion": {"version": "1.0.0"}} for i in range(100)]}
        self.assertEqual(len(mk.catalog({**CFG, "namespaces": ["free"]})), 100)

    def test_pack_gives_files_the_install_time(self):
        """설치한 스킬의 수정 시각이 1970-01-01 로 보이지 않게 묶을 때의 시각을 넣는다(2026-10-28, 올리기 묶음과 같은 원인)."""
        import tarfile
        import time
        with tempfile.TemporaryDirectory() as d:
            (Path(d) / "skills" / "x").mkdir(parents=True)
            (Path(d) / "skills" / "x" / "SKILL.md").write_text("---\nname: x\n---\n")
            before = time.time()
            tar = tarfile.open(fileobj=io.BytesIO(agent.pack(Path(d))), mode="r:gz")
            for m in tar.getmembers():
                self.assertGreaterEqual(m.mtime, int(before), m.name)

    def test_package_kind_comes_from_agent_manifest(self):
        self.assertEqual(mk.package("free", "hello", CFG)["kind"], "skill")
        bot = mk.package("free", "bot", CFG)
        self.assertEqual((bot["kind"], bot["body"]), ("agent", "# 본문"))
        self.assertEqual([v["version"] for v in bot["versions"]], ["1.0.0", "0.0.1"])           # 검토 중인 판은 내놓지 않는다
        for ns, name in (("free", "../x"), ("other", "hello")):
            with self.assertRaises(mk.MarketError):
                mk.package(ns, name, CFG)

    def test_origin_comes_from_the_mirror_table_and_own_for_user_namespaces(self):
        path = store.data_dir() / "market" / mk.ORIGINS
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps({"community/x": {"kind": "github", "url": "https://github.com/o/r/tree/abc/skills/x", "license": "MIT"},
                                    "community/y": {"kind": "clawhub", "url": "javascript:alert(1)", "license": "MIT-0"}}), encoding="utf-8")
        try:
            cfg = {**CFG, "readonly": ["community"]}
            self.assertEqual(mk.origin_of("community", "x", cfg), {"kind": "github", "url": "https://github.com/o/r/tree/abc/skills/x", "license": "MIT"})
            self.assertEqual(mk.origin_of("community", "y", cfg)["url"], "")                    # http(s) 가 아닌 주소는 버린다
            self.assertEqual(mk.origin_of("community", "none", cfg)["kind"], "unknown")
            self.assertEqual(mk.origin_of("free", "hello", cfg)["kind"], "own")
            self.assertEqual({r["id"]: r["origin"]["kind"] for r in mk.catalog(CFG)}, {"free/hello": "own", "free/bot": "own", "paid/hello": "own"})
            self.assertEqual(mk.package("free", "hello", CFG)["origin"]["kind"], "own")
        finally:
            path.unlink()

    def test_package_size_is_shown_and_only_hopeless_ones_are_blocked_before_the_request(self):
        pkg = mk.package("free", "hello", CFG)
        self.assertEqual((pkg["bytes"], pkg["limit"]), (20, mk.PAYLOAD_LIMIT))
        self.ask(pkg, "ma")                                                                    # 작으면 그대로 줄에 선다
        big = {**pkg, "bytes": mk.PAYLOAD_LIMIT * mk.MAX_PACKING_RATIO + 1}
        with self.assertRaises(mk.MarketError) as cm:
            self.ask(big, "sa")
        self.assertIn("너무 큽니다", str(cm.exception))
        self.ask({**pkg, "bytes": mk.PAYLOAD_LIMIT * 3}, "sa")                                  # 한도를 넘어도 눌러서 들어갈 수 있으면 막지 않는다

    def test_paid_needs_grant_for_that_pod(self):
        paid = mk.package("paid", "hello", CFG)
        with self.assertRaises(mk.MarketError) as cm:
            self.ask(paid, "ma")
        self.assertEqual(cm.exception.code, 403)
        mk.set_grant("p1", "paid", True, "admin@x.io")
        self.assertEqual(self.ask(paid, "ma")["status"], "queued")
        with self.assertRaises(mk.MarketError):                      # 다른 설치본에는 허용이 번지지 않는다
            self.ask(paid, "ma", pod="p2")
        mk.set_grant("p1", "paid", False, "admin@x.io")
        self.assertFalse(mk.allowed("p1", paid))
        msg = str(cm.exception)                                       # 거절 문장은 표시 이름으로, 「유료」·slug 없이(스펙 2026-10-28-010 T3). 시험은 한국어(기본)로 돈다
        self.assertIn("'제한'", msg)
        self.assertNotIn("유료", msg)
        self.assertNotIn("paid", msg)

    def test_namespace_label_and_slug(self):
        """스펙 2026-10-28-010 D6·D7: 사람이 읽는 이름과 slug(free·paid) 를 오간다. 이름은 요청 언어를 따른다 — 한국어 공용·제한, 영어 shared·restricted(§6-3)."""
        from aas.common import i18n
        self.addCleanup(i18n.set_lang, i18n.DEFAULT)
        base = {"namespaces": ["free", "paid"], "readonly": ["community"]}
        clash = {"namespaces": ["free", "paid", "shared"], "readonly": ["community"]}      # 어떤 사이트가 진짜 slug shared 를 쓴다
        labels = {"ko": ((base, "free", "공용"), (base, "paid", "제한"), (base, "community", "community"), (base, "team", "team"),
                         (clash, "free", "공용"), (clash, "paid", "제한"), (clash, "shared", "shared")),     # 한국어 이름은 slug shared 와 겹치지 않는다
                  "en": ((base, "free", "shared"), (base, "paid", "restricted"), (base, "community", "community"), (base, "team", "team"),
                         (clash, "free", "free"), (clash, "paid", "restricted"), (clash, "shared", "shared"))}
        pkgs = {"ko": (("free/x@1", "공용/x@1"), ("paid/report", "제한/report")), "en": (("free/x@1", "shared/x@1"), ("paid/report", "restricted/report"))}
        whole = {"ko": {"free": "공용", "paid": "제한", "community": "community"}, "en": {"free": "shared", "paid": "restricted", "community": "community"}}
        for lang in ("ko", "en"):
            i18n.set_lang(lang)
            for cfg, slug, label in labels[lang]:
                with self.subTest(lang=lang, cfg=cfg["namespaces"], slug=slug):
                    self.assertEqual(mk.ns_label(slug, cfg), label)
            # 입력은 언어와 관계없이 두 언어 이름을 모두 받는다. 설정된 진짜 slug 가 먼저다(clash 의 shared)
            for cfg, name, slug in ((base, "shared", "free"), (base, "restricted", "paid"), (base, "공용", "free"), (base, "제한", "paid"),
                                    (base, "free", "free"), (base, "paid", "paid"), (base, "community", "community"), (base, "nope", "nope"), (base, "", ""),
                                    (clash, "shared", "shared"), (clash, "restricted", "paid"), (clash, "공용", "free"), (clash, "제한", "paid")):
                with self.subTest(lang=lang, cfg=cfg["namespaces"], name=name):
                    self.assertEqual(mk.ns_slug(name, cfg), slug)
            for pkg, label in (*pkgs[lang], ("freebie/x", "freebie/x"), ("community/free", "community/free"), ("", "")):
                with self.subTest(lang=lang, pkg=pkg):
                    self.assertEqual(mk.pkg_label(pkg, base), label)
                    self.assertEqual(mk.pkg_slug(label, base), pkg)
            self.assertEqual(mk.ns_labels(base), whole[lang])
        for pkg in ("공용/x@1", "shared/x@1"):                                                   # 다른 언어 화면에서 온 패키지 ID 도 slug 로
            self.assertEqual(mk.pkg_slug(pkg, base), "free/x@1")

    def test_grant_by_label_is_stored_as_slug(self):
        """set_grant 는 이름 검사(NAME)만 하므로 표시 이름을 받으면 쓸모없는 허용 행이 조용히 남았다(스펙 2026-10-28-010 §7-7 O7)."""
        mk.set_grant("p1", "restricted", True, "admin@x.io")
        self.assertEqual([g["namespace"] for g in mk.grants() if g["pod"] == "p1"], ["paid"])
        self.assertTrue(mk.allowed("p1", mk.package("paid", "hello", CFG)))
        mk.set_grant("p1", "restricted", False, "admin@x.io")
        self.assertEqual([g for g in mk.grants() if g["pod"] == "p1"], [])

    def test_skill_goes_to_existing_profile_only(self):
        hello = mk.package("free", "hello", CFG)
        for profile in ("nope", "default", "Bad Name", ""):
            with self.assertRaises(mk.MarketError):
                self.ask(hello, profile)
        with self.assertRaises(mk.MarketError):                      # 공개되지 않은 판
            self.ask(hello, "ma", version="9.9.9")
        row = self.ask(hello, "ma")
        self.assertEqual((row["mode"], row["version"], row["kind"], row["container"]), ("install", "0.2.0", "skill", "hermes-agent"))
        self.assertTrue((mk._dir("queue") / f"{row['id']}.json").exists())
        with self.assertRaises(mk.MarketError) as cm:                # 같은 프로파일에 끝나지 않은 요청
            self.ask(hello, "ma")
        self.assertEqual(cm.exception.code, 409)
        self.finish(row)
        self.assertEqual(self.ask(hello, "ma")["mode"], "update")    # 이미 깔린 스킬은 다시 설치가 곧 갱신

    def test_agent_makes_new_profile_and_updates_only_its_own(self):
        bot = mk.package("free", "bot", CFG)
        with self.assertRaises(mk.MarketError):                      # 있는 프로파일을 덮지 않는다
            self.ask(bot, "ma")
        with self.assertRaises(mk.MarketError):                      # 이 패키지로 만든 적 없는 프로파일은 올리지 않는다
            self.ask(bot, "ma", mode="update")
        row = self.ask(bot, "newbot", version="0.0.1")
        self.finish(row)
        self.assertEqual(self.ask(bot, "newbot", mode="update", have=("ma", "newbot"))["mode"], "update")

    def test_agent_skills_only_into_existing_profile(self):
        """에이전트 패키지의 스킬만 있는 프로파일에(2026-10-14-002). 그 프로파일을 마켓 프로파일로 치지 않는다."""
        bot, hello = mk.package("free", "bot", CFG), mk.package("free", "hello", CFG)
        self.assertEqual(mk.agent_skills(bot), ["agent/skills/x/y"])
        for profile in ("nope", "default"):                          # 없는 프로파일·공용 프로파일
            with self.assertRaises(mk.MarketError):
                self.ask(bot, profile, mode="skills")
        with self.assertRaises(mk.MarketError):                      # 스킬 패키지에는 쓰지 않는다
            self.ask(hello, "ma", mode="skills")
        with self.assertRaises(mk.MarketError):                      # 스킬이 없는 에이전트 패키지
            self.ask({**bot, "files": [f for f in bot["files"] if "/skills/" not in f["path"]]}, "ma", mode="skills")
        row = self.ask(bot, "ma", mode="skills")
        self.assertEqual((row["mode"], row["kind"], row["profile"]), ("skills", "agent", "ma"))
        self.finish(row)
        self.assertEqual([(r["profile"], r["mode"]) for r in mk.installed("p1")], [("ma", "skills")])
        with self.assertRaises(mk.MarketError):                      # 올리기는 SOUL 을 덮으므로 막는다
            self.ask(bot, "ma", mode="update")
        self.finish(self.ask(bot, "ma", mode="skills"))              # 새 판 스킬은 다시 스킬만 설치로
        self.finish(self.ask(bot, "newbot", version="0.0.1"))
        self.finish(self.ask(bot, "newbot", mode="skills", have=("ma", "newbot")))   # 패키지 프로파일에도 스킬만(SOUL 은 그대로)
        rec = next(r for r in mk.installed("p1") if r["profile"] == "newbot")
        self.assertEqual((rec["mode"], rec["version"], rec["skills_version"]), ("install", "0.0.1", "1.0.0"))   # 프로파일 기록은 그대로
        self.assertEqual(self.ask(bot, "newbot", mode="update", have=("ma", "newbot"))["mode"], "update")      # 올리기도 그대로 된다

    def test_restore_request_is_queued_and_does_not_touch_install_records(self):
        hello = mk.package("free", "hello", CFG)
        self.finish(self.ask(hello, "ma"))
        row = mk.request_restore("p1", "hermes-agent", "ma", "old-skill", "a@x.io")
        self.assertEqual((row["mode"], row["kind"], row["name"], row["profile"]), ("restore", "skill", "old-skill", "ma"))
        with self.assertRaises(mk.MarketError) as cm:                # 같은 프로파일에 끝나지 않은 요청이 있으면 막는다
            mk.request_restore("p1", "hermes-agent", "ma", "other-skill", "a@x.io")
        self.assertEqual(cm.exception.code, 409)
        self.finish(row)
        self.assertEqual([(r["profile"], r["package"]) for r in mk.installed("p1")], [("ma", "free/hello")])      # 설치 기록은 그대로
        for bad in (("default", "x-skill"), ("ma", "Bad Name"), ("ma", "")):
            with self.assertRaises(mk.MarketError):
                mk.request_restore("p1", "hermes-agent", *bad, "a@x.io")

    def test_remove_only_what_aas_installed(self):
        hello, bot = mk.package("free", "hello", CFG), mk.package("free", "bot", CFG)
        with self.assertRaises(mk.MarketError) as cm:                # 설치 기록이 없는 것
            mk.request_remove("p1", "hermes-agent", "free/hello", "ma", "a@x.io")
        self.assertEqual(cm.exception.code, 404)
        self.finish(self.ask(hello, "ma"))
        self.finish(self.ask(bot, "newbot"))
        with self.assertRaises(mk.MarketError):                      # 에이전트 패키지는 프로파일째 지운다
            mk.request_remove("p1", "hermes-agent", "free/bot", "newbot", "a@x.io")
        with self.assertRaises(mk.MarketError):                      # 다른 설치본의 기록으로는 못 지운다
            mk.request_remove("p2", "hermes-agent", "free/hello", "ma", "a@x.io")
        row = mk.request_remove("p1", "hermes-agent", "free/hello", "ma", "a@x.io")
        self.assertEqual((row["mode"], row["kind"], row["name"], row["version"]), ("remove", "skill", "hello", "0.2.0"))
        self.finish(row, "failed")                                   # 지우기가 실패했으면 아직 설치된 것이다
        self.assertIn(("ma", "free/hello"), [(r["profile"], r["package"]) for r in mk.installed("p1")])
        self.finish(mk.request_remove("p1", "hermes-agent", "free/hello", "ma", "a@x.io"))
        self.assertEqual([(r["profile"], r["package"]) for r in mk.installed("p1")], [("newbot", "free/bot")])
        self.assertEqual(self.ask(hello, "ma")["mode"], "install")   # 지운 뒤에는 다시 설치가 된다

    def test_records_follow_the_profile(self):
        hello, bot = mk.package("free", "hello", CFG), mk.package("free", "bot", CFG)
        self.assertIsNone(mk.note_profile("p1", "ma", "forget", "a@x.io"))            # 마켓으로 설치한 것이 없으면 남길 것도 없다
        self.finish(self.ask(hello, "ma"))
        self.finish(self.ask(bot, "newbot"))
        self.finish(self.ask(hello, "newbot", have=("ma", "newbot")))
        row = mk.note_profile("p1", "newbot", "rename", "a@x.io", "bot2")              # 이름이 바뀌면 기록이 따라간다
        self.assertIn("2건", row["name"])
        self.assertEqual(sorted((r["profile"], r["package"]) for r in mk.installed("p1")), [("bot2", "free/bot"), ("bot2", "free/hello"), ("ma", "free/hello")])
        mk.note_profile("p1", "bot2", "forget", "a@x.io")                              # 지우면 그 프로파일 것만 내려간다
        self.assertEqual([(r["profile"], r["package"]) for r in mk.installed("p1")], [("ma", "free/hello")])
        self.assertEqual(self.ask(bot, "bot2")["mode"], "install")                     # 같은 이름으로 다시 만들 수 있다
        self.assertEqual(mk.installed("p2"), [])

    def test_reconcile_drops_profiles_hermes_no_longer_has(self):
        hello = mk.package("free", "hello", CFG)
        self.finish(self.ask(hello, "ma"))
        self.finish(self.ask(hello, "sa"))
        self.assertEqual(mk.reconcile("p1", []), [])                                   # 목록을 못 읽었으면 아무것도 안 한다
        self.assertEqual(mk.reconcile("p1", ["ma"]), [])                               # 방금 설치한 것은 기다린다
        self.assertEqual(mk.reconcile("p1", ["ma"], grace=0), ["sa"])
        self.assertEqual([r["profile"] for r in mk.installed("p1")], ["ma"])
        self.assertEqual(mk.reconcile("p1", ["ma"], grace=0), [])                      # 두 번 적지 않는다
        self.ask(hello, "ma")                                                          # 끝나지 않은 요청이 있는 프로파일은 그대로 둔다
        self.assertEqual(mk.reconcile("p1", ["zz"], grace=0), [])
        self.assertIn("없어", next(r for r in mk.requests("p1") if r.get("mode") == "forget")["message"])

    def test_results_and_overview(self):
        hello = mk.package("free", "hello", CFG)
        a = self.ask(hello, "ma", version="0.0.1")
        self.finish(a)
        b = self.ask(hello, "sa")
        self.finish(b, "failed")
        self.assertEqual([(r["profile"], r["version"]) for r in mk.installed("p1")], [("ma", "0.0.1")])
        c = self.ask(hello, "ma")                                                             # 곧바로 새 판 — 같은 초에 끝나도 나중 것이 이긴다
        self.finish(c)
        self.assertEqual([(r["profile"], r["version"]) for r in mk.installed("p1")], [("ma", "0.2.0")])
        self.assertNotIn("glpat-AAAA", mk.requests("p1")[0]["message"])                       # 결과 글의 비밀값 모양은 가린다
        os.environ.update(AAS_SKILLHUB_URL="http://hub")
        try:
            ov = mk.overview("p1")
        finally:
            os.environ.pop("AAS_SKILLHUB_URL")
        pk = {p["id"]: p for p in ov["packages"]}
        self.assertFalse(pk["free/hello"]["update"])
        self.assertFalse(pk["paid/hello"]["allowed"])
        self.assertEqual(ov["namespace_labels"], {"free": "공용", "paid": "제한", "community": "community"})   # 스펙 2026-10-28-010 응답 계약(요청 밖이라 한국어)
        self.assertEqual({k: (p["restricted"], p["paid"]) for k, p in pk.items()},
                         {"free/hello": (False, False), "free/bot": (False, False), "paid/hello": (True, True)})       # restricted 를 더하고 paid 는 같은 값(D3)
        one = mk.package("paid", "hello", CFG)
        self.assertEqual((one["restricted"], one["paid"]), (True, True))
        self.assertEqual(mk.package("restricted", "hello", CFG)["id"], "paid/hello")                                   # 표시 이름으로 물어도 slug 로(D7)
        self.assertFalse(ov["helper"]["alive"])
        self.assertEqual(mk.overview("p1", {**CFG, "url": ""})["configured"], False)


def zipped(files: dict) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        for name, text in files.items():
            z.writestr(name, text)
    return buf.getvalue()


SKILL = {"SKILL.md": "---\nname: hello\n---\n", "scripts/hello.py": "print(1)\n"}
AGENT = {"SKILL.md": "---\nname: bot\n---\n", "agent/distribution.yaml": "name: bot\nversion: 9.9.9\ndescription: 봇\nenv_requires:\n  - name: K\n", "agent/SOUL.md": "나는 봇",
         "agent/config.yaml": "model: m\n", "agent/skills/a/b/SKILL.md": "x", "agent/cron/jobs.json": "[]"}
REQ = {"id": "20261006090000000000-abcdef", "namespace": "free", "name": "hello", "package": "free/hello", "version": "0.2.0", "profile": "ma",
       "container": "hermes-agent", "kind": "skill", "mode": "install"}


class HubNotFoundTest(unittest.TestCase):
    """실제 SkillHub 는 없는 스킬에 404 가 아니라 HTTP 400 과 {"msg": "Skill not found: x"} 를 준다(OKE 에서 확인, OMAI-1204 후속).
    그래서 처음 올리는 이름의 조회(_exists)가 「마켓플레이스 오류 (HTTP 400)」로 막혔다. 그 응답을 「없음(404)」으로 읽어야 한다."""

    @staticmethod
    def hub(status, body):
        import io
        import urllib.error

        def urlopen(req, timeout=0):
            raise urllib.error.HTTPError(req.full_url, status, "x", {}, io.BytesIO(body))
        return mock.patch.object(mk.urllib.request, "urlopen", urlopen)

    def test_http_400_skill_not_found_is_a_missing_package(self):
        body = json.dumps({"code": 400, "msg": "Skill not found: testskill", "data": None}).encode()
        with self.hub(400, body):
            with self.assertRaises(mk.MarketError) as cm:
                mk.fetch("/api/v1/skills/free/testskill", CFG)
        self.assertEqual(cm.exception.code, 404)

    def test_other_http_400_stays_a_marketplace_error(self):
        body = json.dumps({"code": 400, "msg": "Invalid namespace", "data": None}).encode()
        with self.hub(400, body):
            with self.assertRaises(mk.MarketError) as cm:
                mk.fetch("/api/v1/skills/free/x", CFG)
        self.assertEqual(cm.exception.code, 502)
        self.assertIn("400", str(cm.exception))

    def test_publish_lookup_treats_it_as_new_name(self):
        from aas.market import market_publish as mp
        body = json.dumps({"code": 400, "msg": "Skill not found: testskill", "data": None}).encode()
        with self.hub(400, body), mock.patch.object(mk, "settings", return_value=CFG):
            self.assertIsNone(mp._exists("testskill"))


class StageTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(dir=TMP.name))

    def test_validate_refuses_odd_requests(self):
        agent.validate(dict(REQ))
        for key, bad in (("profile", "default"), ("profile", "../x"), ("name", "a b"), ("version", "1.0"), ("kind", "plugin"), ("mode", "format")):
            with self.assertRaises(agent.Refuse, msg=f"{key}={bad}"):
                agent.validate({**REQ, key: bad})
        with self.assertRaises(agent.Refuse):
            agent.validate({**REQ, "kind": "agent", "mode": "remove"})                           # 에이전트 패키지는 여기서 지우지 않는다

    def test_extract_checks_paths_and_hashes(self):
        want = {k: hashlib.sha256(v.encode()).hexdigest() for k, v in SKILL.items()}
        self.assertEqual(sorted(agent.extract(zipped(SKILL), self.tmp / "ok", want)), sorted(SKILL))
        for files, w in (({**SKILL, "../evil": "x"}, {}), ({**SKILL, "scripts/hello.py": "print(2)\n"}, want), ({**SKILL, "extra.sh": "x"}, want), ({"a.txt": "x"}, {})):
            with self.assertRaises(agent.Refuse):
                agent.extract(zipped(files), self.tmp / hashlib.md5(repr(files).encode()).hexdigest(), w)
        with self.assertRaises(agent.Refuse):
            agent.extract(b"not a zip", self.tmp / "nz", {})

    def unpack(self, files):
        pkg = Path(tempfile.mkdtemp(dir=self.tmp))
        agent.extract(zipped(files), pkg, {})
        return pkg

    def test_stage_skill_owns_only_its_folder(self):
        out = self.tmp / "s"
        m = agent.stage(dict(REQ), self.unpack(SKILL), out)
        self.assertEqual((m["name"], m["distribution_owned"]), ("ma", ["skills/market/hello"]))
        self.assertTrue((out / "skills/market/hello/scripts/hello.py").exists())
        self.assertEqual(sorted(p.name for p in out.iterdir()), ["distribution.yaml", "skills"])

    def test_stage_agent_allowlist_and_config_kept_on_update(self):
        req = {**REQ, "name": "bot", "kind": "agent", "profile": "newbot"}
        m = agent.stage(req, self.unpack(AGENT), self.tmp / "a1")
        self.assertEqual((m["name"], m["version"]), ("newbot", "0.2.0"))                         # 이름·버전은 요청이 정한다
        self.assertEqual(m["distribution_owned"], ["SOUL.md", "config.yaml", "cron", "skills/a/b"])     # 스킬은 폴더마다 — 프로파일의 다른 스킬이 지워지지 않는다(스펙 2026-10-14-015)
        self.assertEqual(m["env_requires"], [{"name": "K"}])
        m = agent.stage({**req, "mode": "update"}, self.unpack(AGENT), self.tmp / "a2")
        self.assertNotIn("config.yaml", m["distribution_owned"])
        for extra in ({"agent/.env": "K=1"}, {"agent/auth.json": "{}"}, {"agent/memories/x": "1"}):
            with self.assertRaises(agent.Refuse):
                agent.stage(req, self.unpack({**AGENT, **extra}), self.tmp / next(iter(extra)).replace("/", "_"))
        no_soul = {k: v for k, v in AGENT.items() if k != "agent/SOUL.md"}
        with self.assertRaises(agent.Refuse):
            agent.stage(req, self.unpack(no_soul), self.tmp / "a3")

    def test_stage_agent_update_keeps_other_skills_and_merges_cron_and_mcp(self):
        """새 판은 패키지의 스킬 폴더만 owned 로 적고, 크론·MCP 는 사용자 것과 합쳐 그 파일만 owned 로 둔다(리뷰 R9)."""
        pkg_files = {**AGENT, "agent/cron/jobs.json": json.dumps({"jobs": [{"id": "p1", "name": "새 패키지"}, {"id": "p2", "name": "새 작업"}]}),
                     "agent/mcp.json": json.dumps({"mcpServers": {"shared": {"url": "new"}}})}
        req = {**REQ, "name": "bot", "kind": "agent", "profile": "newbot", "mode": "update"}
        cur = {"cron/jobs.json": json.dumps({"jobs": [{"id": "u1", "name": "내 작업"}, {"id": "p1", "name": "옛"}]}),
               "mcp.json": json.dumps({"mcpServers": {"mine": {"url": "u"}, "shared": {"url": "old"}}})}
        out = self.tmp / "u1"
        m = agent.stage(req, self.unpack(pkg_files), out, current=cur)
        self.assertEqual(m["distribution_owned"], ["SOUL.md", "cron/jobs.json", "mcp.json", "skills/a/b"])    # config.yaml 은 지킨다, cron 은 파일 하나만
        jobs = json.loads((out / "cron/jobs.json").read_text(encoding="utf-8"))["jobs"]
        self.assertEqual([(j["id"], j["name"]) for j in jobs], [("u1", "내 작업"), ("p1", "새 패키지"), ("p2", "새 작업")])
        self.assertEqual(sorted(json.loads((out / "mcp.json").read_text(encoding="utf-8"))["mcpServers"]), ["mine", "shared"])
        with self.assertRaises(agent.Refuse):                                                                # 사용자 파일 형식이 깨졌으면 덮지 않고 멈춘다
            agent.stage(req, self.unpack(pkg_files), self.tmp / "u2", current={"cron/jobs.json": "not json"})
        m = agent.stage({**req, "mode": "install"}, self.unpack(pkg_files), self.tmp / "u3")                 # 새 프로파일에는 그대로(합칠 것이 없다)
        self.assertEqual(m["distribution_owned"], ["SOUL.md", "config.yaml", "cron", "mcp.json", "skills/a/b"])

    def test_stage_skip_leaves_the_users_own_skill_out_of_the_distribution(self):
        files = {**AGENT, "agent/skills/c/d/SKILL.md": "y"}
        req = {**REQ, "name": "bot", "kind": "agent", "profile": "newbot", "mode": "update"}
        out = self.tmp / "k1"
        m = agent.stage(req, self.unpack(files), out, skip={"skills/a/b"})
        self.assertEqual(m["distribution_owned"], ["SOUL.md", "cron/jobs.json", "skills/c/d"])
        self.assertFalse((out / "skills/a/b").exists())                                                      # 지키기로 한 스킬은 배포판에서도 빠진다
        sm = agent.stage({**REQ}, self.unpack(SKILL), self.tmp / "k2", skip={"skills/market/hello"})
        self.assertEqual(sm["distribution_owned"], [])

    def test_planned_skills_for_the_conflict_check(self):
        self.assertEqual(agent.planned_skills(dict(REQ), self.unpack(SKILL)), {"skills/market/hello": "hello"})
        ag = {**REQ, "name": "bot", "kind": "agent", "mode": "update"}
        files = {**AGENT, "agent/skills/a/b/SKILL.md": "---\nname: ab\n---\n"}
        self.assertEqual(agent.planned_skills(ag, self.unpack(files)), {"skills/a/b": "ab"})
        self.assertEqual(agent.planned_skills({**ag, "mode": "remove"}, self.unpack(files)), {})

    def test_stage_agent_skills_only(self):
        """스킬만 설치: 배포판에 스킬 폴더만 넣고 SOUL·설정·크론은 넣지 않는다(2026-10-14-002)."""
        req = {**REQ, "name": "bot", "package": "free/bot", "kind": "agent", "mode": "skills"}
        extra = {"agent/skills/a/b/examples/SKILL.md": "예시", "agent/skills/c/d/SKILL.md": "y"}
        m = agent.stage(req, self.unpack({**AGENT, **extra}), self.tmp / "s1")
        self.assertEqual(m["distribution_owned"], ["skills/a/b", "skills/c/d"])           # 스킬 안의 SKILL.md 는 따로 세지 않는다
        self.assertEqual(m["name"], "ma")
        out = self.tmp / "s1"
        self.assertTrue((out / "skills/a/b/examples/SKILL.md").exists())
        self.assertEqual(sorted(p.name for p in out.iterdir()), ["distribution.yaml", "skills"])
        no_skills = {k: v for k, v in AGENT.items() if "/skills/" not in k}
        with self.assertRaises(agent.Refuse):
            agent.stage(req, self.unpack(no_skills), self.tmp / "s2")
        with self.assertRaises(agent.Refuse):
            agent.validate({**req, "kind": "skill"})
        from aas.market import market_dispatch
        self.assertTrue(market_dispatch._manifest({**req, "pod": "p1", "id": req["id"]}, type("C", (), {"namespace": "ns"})())["spec"]["force"])


class RouteTest(unittest.TestCase):
    """서버 경로 — 로그인이 꺼진 시험 서버로 목록·허용·설치 요청이 이어지는지."""
    @classmethod
    def setUpClass(cls):
        import threading
        from http.server import ThreadingHTTPServer
        from aas.auth import auth
        from aas.fleet import pods
        from aas.web import server
        cls.server, cls.old_env = server, {k: os.environ.get(k) for k in ("AAS_ALLOWED_HOSTS", "AAS_SKILLHUB_URL")}
        os.environ.pop("AAS_ALLOWED_HOSTS", None)
        os.environ["AAS_SKILLHUB_URL"] = "http://hub"
        home = Path(TMP.name) / "route-hermes"
        (home / "profiles").mkdir(parents=True, exist_ok=True)
        reg = Path(TMP.name) / "route-pods.json"
        reg.write_text(json.dumps({"pods": [{"id": "p9", "owner": "t@example.com", "hermes_home": str(home), "container": "hermes-agent"}]}))
        server._auth = auth.Auth({"issuer": "https://accounts.google.com", "client_id": "", "client_secret": "", "domain": "", "public_url": "http://localhost:17900",
                                  "hours": 1, "users_file": Path(TMP.name) / "no-users.json"})
        server._registry = pods.Registry(reg)
        cls.old = (mk.fetch, server.HermesAPI.call)
        mk.fetch = fake_fetch
        server.HermesAPI.call = lambda self, method, path, body=None, query=None: {"profiles": [{"name": "default"}, {"name": "ma"}]}
        cls.httpd = aasserver.start()

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        mk.fetch, cls.server.HermesAPI.call = cls.old
        cls.server._auth = cls.server._registry = None
        for k, v in cls.old_env.items():
            os.environ.pop(k, None) if v is None else os.environ.__setitem__(k, v)

    def call(self, method, path, body=None, headers=None):
        import http.client
        c = http.client.HTTPConnection("127.0.0.1", self.httpd.server_port, timeout=5)
        c.request(method, path, json.dumps(body) if body is not None else None, {"Content-Type": "application/json", "X-AAS": "1", **(headers or {})})
        r = c.getresponse()
        return r.status, json.loads(r.read() or b"{}")

    def test_package_summary_is_translated_on_korean_screens(self):
        """스펙 2026-10-19-017 §9: 스킬 허브 패키지 요약도 한국어 화면이면 번역·summary_src·summary_by, 영어면 원문만. 목록과 상세 둘 다."""
        from aas.market import skill_desc
        fake = lambda n, d: ("번역된 요약", "seed") if skill_desc.get_lang() == "ko" else None
        with mock.patch.object(skill_desc, "find", side_effect=fake):
            ko = self.call("GET", "/api/market", headers={"Accept-Language": "ko"})[1]["packages"][0]
            en = self.call("GET", "/api/market", headers={"Accept-Language": "en"})[1]["packages"][0]
            one = self.call("GET", "/api/market/package?ns=free&name=bot", headers={"Accept-Language": "ko"})[1]
        self.assertEqual((ko["summary"], ko["summary_by"]), ("번역된 요약", "seed"))
        self.assertTrue(ko["summary_src"])
        self.assertNotIn("summary_src", en)
        self.assertEqual((one["summary"], one["summary_by"]), ("번역된 요약", "seed"))

    def test_list_grant_install(self):
        code, ov = self.call("GET", "/api/market")
        self.assertEqual((code, ov["admin"], len(ov["packages"])), (200, True, 3))
        self.assertEqual(self.call("GET", "/api/market/package?ns=free&name=bot")[1]["kind"], "agent")
        self.assertEqual(self.call("GET", "/api/market/package?ns=free&name=nope")[0], 404)
        ask = {"namespace": "paid", "name": "hello", "profile": "ma"}
        self.assertEqual(self.call("POST", "/api/market/install", ask)[0], 403)                    # 허용 전
        self.assertEqual(self.call("POST", "/api/market/grant", {"namespace": "paid", "allow": True})[0], 200)
        code, out = self.call("POST", "/api/market/install", ask)
        self.assertEqual((code, out["request"]["pod"], out["request"]["container"], out["request"]["status"]), (200, "p9", "hermes-agent", "queued"))
        self.assertEqual(self.call("POST", "/api/market/install", {"namespace": "free", "name": "hello", "profile": "ghost"})[0], 400)
        self.assertEqual(self.call("POST", "/api/market/install", ask, {"X-AAS": "0"})[0], 403)    # 다른 사이트가 보낸 요청
        self.assertEqual(self.call("POST", "/api/market/remove", {"namespace": "free", "name": "hello", "profile": "ma"})[0], 404)   # 설치한 적 없는 것
        from aas.ops import changes
        kinds = [r["kind"] for r in changes.rows(1)]
        self.assertIn("market_install", kinds)
        self.assertIn("market_grant", kinds)

    def test_labels_in_responses_and_label_inputs(self):
        """스펙 2026-10-28-010: 응답의 namespace_labels·restricted, 입력의 표시 이름(shared·restricted)은 slug 로 바꿔 저장한다(D7)."""
        def cleanup():
            with mk._conn() as conn:
                conn.execute("DELETE FROM market_grants WHERE pod='p9'")
            for d in ("queue", "done"):
                for p in mk._dir(d).glob("*.json"):
                    if json.loads(p.read_text()).get("pod") == "p9" and json.loads(p.read_text()).get("profile") == "ma":
                        p.unlink()
        cleanup()
        self.addCleanup(cleanup)
        code, ov = self.call("GET", "/api/market", headers={"Accept-Language": "ko"})
        self.assertEqual((code, ov["namespace_labels"]), (200, {"free": "공용", "paid": "제한", "community": "community"}))      # 한국어 화면(§6-3)
        code, en = self.call("GET", "/api/market", headers={"Accept-Language": "en"})
        self.assertEqual((code, en["namespace_labels"]), (200, {"free": "shared", "paid": "restricted", "community": "community"}))
        self.assertEqual(self.call("GET", "/api/market")[1]["namespace_labels"]["free"], "공용")                               # 헤더가 없으면 한국어
        self.assertTrue(all(p["restricted"] == p["paid"] for p in ov["packages"]))
        code, one = self.call("GET", "/api/market/package?ns=restricted&name=hello")
        self.assertEqual((code, one["id"], one["restricted"], one["paid"]), (200, "paid/hello", True, True))
        self.assertEqual(self.call("POST", "/api/market/grant", {"namespace": "restricted", "allow": True})[0], 200)
        self.assertEqual([g["namespace"] for g in mk.grants() if g["pod"] == "p9"], ["paid"])
        code, out = self.call("POST", "/api/market/install", {"namespace": "restricted", "name": "hello", "profile": "ma"})
        self.assertEqual((code, out["request"]["package"], out["request"]["namespace"]), (200, "paid/hello", "paid"))
        with store.connect() as conn:                                                              # 사용 기록도 slug 로 저장한다(D10, 읽을 때 바꾼다)
            notes = [r["note"] for r in conn.execute("SELECT note FROM usage WHERE pod='p9' AND kind IN ('market_grant', 'market_install') ORDER BY ts DESC LIMIT 2")]
        self.assertTrue(notes and all("restricted" not in n and "paid" in n for n in notes), notes)
        code, pub = self.call("GET", "/api/market/publish", headers={"Accept-Language": "ko"})
        self.assertEqual((code, pub["namespace_labels"]["free"], pub["namespace_labels"]["paid"]), (200, "공용", "제한"))
        code, pub = self.call("GET", "/api/market/publish", headers={"Accept-Language": "en"})
        self.assertEqual((code, pub["namespace_labels"]["free"], pub["namespace_labels"]["paid"]), (200, "shared", "restricted"))

    def test_owner_installs_but_cannot_grant_and_others_cannot_install(self):
        """주인은 설치, 유료 허용은 관리자만, 남의 POD 는 403(OMAI-1126 리뷰 R2)."""
        reg = self.server._registry
        old = (self.server._auth, reg.is_admin)
        who = {"email": "t@example.com", "name": ""}
        class On:
            enabled = True
            def user(self, cookie): return dict(who)
        self.server._auth = On(); reg.is_admin = lambda u: False
        old_call = self.server.HermesAPI.call                          # 앞 시험이 ma 에 남긴 설치 요청과 겹치지 않게 다른 프로파일을 쓴다
        self.server.HermesAPI.call = lambda s, method, path, body=None, query=None: {"profiles": [{"name": "default"}, {"name": "ma"}, {"name": "mb"}]}
        try:
            code, ov = self.call("GET", "/api/market")
            self.assertEqual((code, ov["admin"], ov["can_install"]), (200, False, True))
            self.assertEqual(self.call("POST", "/api/market/install", {"namespace": "free", "name": "hello", "profile": "mb"})[0], 200)
            self.assertEqual(self.call("POST", "/api/market/grant", {"namespace": "paid", "allow": True})[0], 403)
            reg.grant("viewer@example.com", "user", ["p9"], "admin@example.com")   # 화면 권한으로 보기만 받은 사람
            who["email"] = "viewer@example.com"
            self.assertEqual(self.call("GET", "/api/market")[1]["can_install"], False)
            self.assertEqual(self.call("POST", "/api/market/install", {"namespace": "free", "name": "hello", "profile": "mb"})[0], 403)
        finally:
            self.server._auth, reg.is_admin = old
            self.server.HermesAPI.call = old_call
            reg.grant("viewer@example.com", "user", [], "admin@example.com")


if __name__ == "__main__":
    unittest.main()

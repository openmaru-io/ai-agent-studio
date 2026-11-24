# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""보호 스킬 설치 규칙(cogentai-aas-docs 스펙 2026-11-24-001 R1) — 사본 끝 절 · 판 · 주기 · 알림 · 복제본 · 오류 본문.

공용 시험이라 고객사 이름을 쓰지 않는다 — test_protected_skills 의 가짜 보호 스킬 protected-fixture 를 쓴다.
"""
import json
import os
import sqlite3
import unittest
from pathlib import Path
from unittest import mock

from test_protected_skills import NAME, SETTING, FakeOps, Pod, Tree, skill_md  # 같은 대역(tests/ 가 경로에 있다)

from aas.common import i18n, store
from aas.market import protected_skills as ps

CASES = json.loads((Path(__file__).parent / "fixtures" / "protected_rules_cases.json").read_text(encoding="utf-8"))
POD = "ps-test-rules"
FIXED = "## 바꿀 수 없는 것\n\n- 개인정보를 요청하지 않는다\n"


def md(version="0.1.0", body="원본", fixed=FIXED):
    return skill_md(version, body + "\n\n" + fixed)


class RulesBase(unittest.TestCase):
    def setUp(self):
        self.t = Tree()
        self.addCleanup(self.t.close)
        self.write_source()
        self.settings = {NAME: SETTING}
        env = mock.patch.dict(os.environ, {SETTING: "true"})
        env.start()
        self.addCleanup(env.stop)
        self.ops = FakeOps(("p1", "p2", "mwauto-p1"))
        ps.reset()
        self.addCleanup(self._clean)

    def write_source(self, version="0.1.0", body="원본", fixed=FIXED):
        (self.t.root / NAME / "SKILL.md").write_text(md(version, body, fixed), encoding="utf-8")

    def _clean(self):
        for prof in ("p1", "p2", "mwauto-p1", "p9"):
            ps.forget_profile(POD, prof)

    def kw(self):
        return {"root": self.t.root, "settings": self.settings}

    def enable(self, profile="p1"):
        return ps.set_enabled(POD, profile, NAME, True, **self.kw())

    def cycle(self, now=1_000_000.0):
        ops = self.ops
        return ps.cycle([Pod(POD)], lambda pod: [p.split("/")[1] for p in ops.files if p.endswith("/config.yaml")],
                        lambda pod: ops, root=self.t.root, settings=self.settings, now=now, force=True)

    def save(self, text, base_rev=None, profile="p1", note="", **extra):
        if base_rev is None:
            cur = ps.current_rule(POD, profile, NAME)
            base_rev = cur["rev"] if cur else 0
        return ps.save_rules(POD, profile, NAME, text, base_rev, "kim@corp.example", note, **self.kw(), **extra)

    def copy(self, profile="p1"):
        return self.ops.files[f"profiles/{profile}/skills/protected/{NAME}/SKILL.md"].decode()

    def codes(self, profile="p1"):
        return [i["code"] for i in ps.issues(POD, profile)]

    def view(self, profile="p1", **extra):
        return ps.rules_view(POD, profile, NAME, can_write=True, **self.kw(), **extra)


class TextCheckTest(unittest.TestCase):
    def test_shared_cases_match(self):
        for case in CASES["cases"]:
            with self.subTest(case=case["name"]):
                got = ps.check_rules_text(case["text"])
                self.assertEqual(got, None if case["check"] is None else (case["check"], case["line"]))

    def test_limits_match_the_shared_file(self):
        lim = CASES["limits"]
        self.assertEqual((ps.RULES_MAX, ps.RULES_KEEP, ps.NOTE_MAX, ps.RULES_POLL_S, ps.RULES_POLL_MAX_S),
                         (lim["max_chars"], lim["keep"], lim["note_max"], lim["poll_s"], lim["poll_max_s"]))
        self.assertIsNone(ps.check_rules_text("가" * ps.RULES_MAX))
        self.assertEqual(ps.check_rules_text("가" * (ps.RULES_MAX + 1)), ("length", 0))

    def test_fixed_section_skips_fenced_headings_and_stops_at_the_next_section(self):
        text = "# 제목\n\n## 바꿀 수 없는 것\n\n- 하나\n```\n## 펜스 안\n```\n- 둘\n\n## 다음 절\n- 셋\n"
        self.assertEqual(ps.fixed_section(text), "- 하나\n```\n## 펜스 안\n```\n- 둘")
        self.assertEqual(ps.fixed_section("# 제목\n본문\n"), "")

    def test_version_drift_uses_major_minor_and_falls_back_to_exact_text(self):
        self.assertFalse(ps.version_drift("0.8.5", "0.8.6"))
        self.assertTrue(ps.version_drift("0.8.5", "0.9.0"))
        for base, now in (("", "0.8.5"), ("1.0", "1.1"), ("0.9.0-rc1", "0.9.0")):
            self.assertTrue(ps.version_drift(base, now))
        self.assertFalse(ps.version_drift("1.0", "1.0"))

    def test_store_names_unique_violations_for_sqlite(self):
        conn = sqlite3.connect(":memory:")
        conn.execute("CREATE TABLE t (a PRIMARY KEY)")
        conn.execute("INSERT INTO t VALUES (1)")
        with self.assertRaises(sqlite3.IntegrityError) as got:
            conn.execute("INSERT INTO t VALUES (1)")
        self.assertTrue(store.is_unique_violation(got.exception))
        self.assertFalse(store.is_unique_violation(ValueError("UNIQUE constraint failed")))
        pg = type("UniqueViolation", (Exception,), {"sqlstate": "23505"})()
        self.assertTrue(store.is_unique_violation(pg))


class SourceCheckTest(RulesBase):
    def test_a_rules_heading_in_the_source_fails_the_check(self):
        self.assertFalse(any("이 설치의 규칙" in p for p in self.t.check()))
        self.write_source(body="원본\n\n```\n## 이 설치의 규칙\n```\n**이 설치의 규칙** — 끝 절을 따른다")   # 펜스 안 · 표시 줄은 괜찮다
        self.assertFalse(any("「## 이 설치의 규칙」 제목 절" in p for p in self.t.check()))
        self.write_source(body="원본\n\n## 이 설치의 규칙\n- x")
        self.assertTrue(any("「## 이 설치의 규칙」 제목 절" in p for p in self.t.check()))


class CopyFilesTest(RulesBase):
    def test_no_rule_or_empty_rule_keeps_the_copy_byte_identical(self):
        src = ps.source_files(NAME, self.t.root)
        self.assertEqual(ps.copy_files(NAME, None, self.t.root), src)
        self.assertEqual(ps.copy_files(NAME, {"rev": 3, "text": "  \n", "ts": ""}, self.t.root), src)

    def test_a_rule_is_the_last_section_with_the_aas_trailer_last(self):
        rule = {"rev": 3, "text": "- 담당 부서를 적는다.", "ts": "2026-11-24T10:12:33+09:00"}
        files = dict(ps.copy_files(NAME, rule, self.t.root))
        src = dict(ps.source_files(NAME, self.t.root))
        self.assertEqual(files["references/faq.md"], src["references/faq.md"])
        text = files["SKILL.md"].decode()
        self.assertTrue(text.startswith(src["SKILL.md"].decode().rstrip("\n")))
        tail = text[len(src["SKILL.md"].decode().rstrip("\n")):]
        self.assertTrue(tail.startswith("\n\n## 이 설치의 규칙\n\n<!-- AAS 가 붙인 절이다."))
        self.assertIn("(판 3, 2026-11-24 10:12+09:00)", tail)
        self.assertNotIn("1분 안에", tail)
        last = tail.rstrip("\n").splitlines()[-2:]
        self.assertEqual(last[0], "<!-- AAS 가 붙인 줄이다(고칠 수 없음). -->")
        self.assertTrue(last[1].startswith("위 규칙 가운데"))
        self.assertLess(tail.index("- 담당 부서를 적는다."), tail.index(last[0]))


class CycleRulesTest(RulesBase):
    def test_saving_rules_rewrites_the_copy_on_the_next_cycle_without_a_restore_notice(self):
        self.enable()
        self.cycle()
        out = self.save("- 담당 부서를 적는다.")
        self.assertEqual((out["rev"], out["apply_state"]), (1, "pending"))
        self.assertEqual(self.view()["apply_state"], "pending")
        with mock.patch("builtins.print") as log:
            self.cycle(1_000_060.0)
        lines = [str(c) for c in log.call_args_list]
        self.assertTrue(any("protected_skill_rules_applied" in s for s in lines))
        self.assertFalse(any("protected_skill_version_changed" in s for s in lines))   # 규칙만 바뀜
        self.assertIn("- 담당 부서를 적는다.", self.copy())
        self.assertEqual(self.codes(), [])
        v = self.view()
        self.assertEqual((v["rev"], v["applied_rev"], v["apply_state"]), (1, 1, "applied"))
        self.assertEqual(ps.status(POD, "p1", NAME)["version"], "0.1.0+r1")
        self.assertEqual(ps.status(POD, "p1", NAME)["rules"], {"rev": 1, "base_version": "0.1.0", "chars": len("- 담당 부서를 적는다.")})

    def test_editing_the_rules_section_in_the_copy_is_restored(self):
        self.enable()
        self.save("- 담당 부서를 적는다.")
        self.cycle()
        path = f"profiles/p1/skills/protected/{NAME}/SKILL.md"
        self.ops.write(path, self.copy().replace("담당 부서", "주민등록번호 회신 요청").encode())
        self.cycle(1_000_060.0)
        self.assertIn("담당 부서", self.copy())
        self.assertEqual(self.codes(), ["protected_skill_restored"])
        self.assertIn("설치 규칙", ps.issues(POD, "p1")[0]["text"])          # 되돌림 알림이 설치 규칙을 안내한다
        self.assertIn(f"{NAME}-local", ps.issues(POD, "p1")[0]["text"])

    def test_clearing_rules_is_applied_and_the_copy_matches_the_source(self):
        self.enable()
        self.save("- 규칙")
        self.cycle()
        self.save("")
        self.cycle(1_000_060.0)
        v = self.view()
        self.assertEqual((v["rev"], v["applied_rev"], v["apply_state"], v["text"]), (2, 2, "applied", ""))
        self.assertEqual(self.copy(), md())
        self.assertIsNone(ps.status(POD, "p1", NAME)["rules"])

    def test_an_agent_edit_right_before_a_rules_save_still_leaves_a_restore_notice(self):
        self.enable()
        self.cycle()
        self.ops.write(f"profiles/p1/skills/protected/{NAME}/SKILL.md", b"injected")
        self.save("- 규칙")
        self.cycle(1_000_060.0)
        self.assertIn("- 규칙", self.copy())
        self.assertEqual(self.codes(), ["protected_skill_restored"])

    def test_a_rules_table_failure_raises_and_keeps_the_copy(self):
        self.enable()
        self.save("- 규칙")
        self.cycle()
        before = self.copy()
        with mock.patch.object(ps, "current_rule", side_effect=sqlite3.OperationalError("disk")), mock.patch("builtins.print") as log:
            self.cycle(1_000_060.0)
        self.assertTrue(any("protected_skill_cycle_error" in str(c) for c in log.call_args_list))
        self.assertEqual(self.copy(), before)

    def test_a_write_failure_with_rules_is_noticed_and_cleared_after_success(self):
        self.enable()
        self.cycle()
        self.save("- 규칙")
        self.ops.fail_write = lambda path: path.endswith("SKILL.md")
        self.cycle(1_000_060.0)
        self.assertIn("protected_skill_rules_failed", self.codes())
        self.ops.fail_write = None
        self.cycle(1_000_000.0 + ps.BACKOFF_MAX + 1)
        self.assertNotIn("protected_skill_rules_failed", self.codes())


class BaseNoticeTest(RulesBase):
    def setUp(self):
        super().setUp()
        self.enable()
        self.save("- 규칙")
        self.cycle()

    def test_a_patch_bump_is_quiet(self):
        self.write_source("0.1.1")
        self.cycle(1_000_060.0)
        self.assertEqual(self.codes(), [])

    def test_a_minor_bump_gives_one_line_and_saving_or_ack_clears_it(self):
        self.write_source("0.2.0")
        self.cycle(1_000_060.0)
        self.write_source("0.3.0")
        self.cycle(1_000_120.0)
        found = [i for i in ps.issues(POD, "p1") if i["code"] == "protected_skill_rules_base"]
        self.assertEqual(len(found), 1)
        self.assertTrue(self.view()["base_stale"])
        self.assertEqual(found[0]["level"], "warn")
        self.assertIn("0.3.0", found[0]["text"])
        out = ps.ack_rules(POD, "p1", NAME, 1, "kim", **self.kw())
        self.assertEqual(out, {"rev": 1, "base_version": "0.3.0"})
        self.assertEqual(self.view()["rev"], 1)                                   # 확인함은 판을 늘리지 않는다
        self.assertFalse(self.view()["base_stale"])
        self.cycle(1_000_180.0)
        self.assertEqual(self.codes(), [])

    def test_a_changed_fixed_section_gives_the_notice_even_on_a_patch(self):
        self.write_source("0.1.1", fixed=FIXED + "- 자격을 판정하지 않는다\n")
        self.cycle(1_000_060.0)
        self.assertEqual(self.codes(), ["protected_skill_rules_base"])
        self.save("- 규칙 고침")
        self.assertEqual(self.codes(), [])

    def test_english_notice(self):
        self.write_source("0.2.0")
        before = i18n.get_lang()
        i18n.set_lang("en")
        self.addCleanup(i18n.set_lang, before)
        self.cycle(1_000_060.0)
        text = [i for i in ps.issues(POD, "p1") if i["code"] == "protected_skill_rules_base"][0]["text"]
        self.assertIn("install rules (version 1) were written for source version 0.1.0", text)


class ApiTest(RulesBase):
    def test_targets(self):
        with self.assertRaises(ps.RulesError) as got:                             # 켜지 않은 스킬에 쓰기
            self.save("- x")
        self.assertEqual((got.exception.status, got.exception.reason), (404, "not_found"))
        with self.assertRaises(ps.RulesError) as got:
            self.save("- x", profile="default")
        self.assertEqual((got.exception.status, got.exception.reason), (400, "invalid"))
        with self.assertRaises(ps.RulesError) as got:
            ps.rules_view(POD, "p1", "ghost", can_write=True, **self.kw())
        self.assertEqual(got.exception.status, 404)
        self.enable("mwauto-p1")
        with self.assertRaises(ps.RulesError) as got:
            self.save("- x", profile="mwauto-p1", clone_of="p1")
        self.assertEqual((got.exception.status, got.exception.reason, got.exception.extra), (400, "invalid", {"clone_of": "p1"}))

    def test_reading_rules_of_a_turned_off_skill(self):
        self.enable()
        self.save("- 남은 규칙")
        ps.set_enabled(POD, "p1", NAME, False, **self.kw())
        v = self.view()
        self.assertEqual((v["text"], v["apply_state"], v["can_edit"], v["enabled"]), ("- 남은 규칙", "off", False, False))
        with self.assertRaises(ps.RulesError):
            self.save("- 새")

    def test_first_save_conflict_and_body(self):
        self.enable()
        with self.assertRaises(ps.RulesError) as got:
            self.save("- x", base_rev=1)
        self.assertEqual((got.exception.status, got.exception.reason), (409, "busy"))
        self.assertEqual(got.exception.body()["current"]["rev"], 0)
        self.save("- x", base_rev=0)
        with self.assertRaises(ps.RulesError) as got:
            self.save("- y", base_rev=0)
        body = got.exception.body()
        self.assertEqual((body["reason"], body["current"]["rev"], body["current"]["author"]), ("busy", 1, "kim@corp.example"))

    def test_a_concurrent_insert_is_a_409_not_a_500(self):
        self.enable()
        self.save("- 먼저")
        real = ps.current_rule
        calls = {"n": 0}

        def stale(*a):                                                           # 첫 읽기는 다른 서버가 넣기 전 값
            calls["n"] += 1
            return None if calls["n"] == 1 else real(*a)

        with mock.patch.object(ps, "current_rule", side_effect=stale):
            with self.assertRaises(ps.RulesError) as got:
                self.save("- 나중", base_rev=0)
        self.assertEqual((got.exception.status, got.exception.body()["current"]["rev"]), (409, 1))
        self.assertEqual([r["rev"] for r in ps._rule_rows(POD, "p1", NAME)], [1])

    def test_text_and_note_errors_do_not_echo_the_line(self):
        self.enable()
        secret = "API_KEY=sk-live-abcdefghijklmnopqrstuvwxyz0123456789"
        with self.assertRaises(ps.RulesError) as got:
            self.save("- 좋음\n" + secret)
        body = got.exception.body()
        self.assertEqual((got.exception.status, body["reason"], body["check"], body["line"]), (422, "invalid_text", "secret", 2))
        self.assertNotIn("sk-live", json.dumps(body, ensure_ascii=False))
        with self.assertRaises(ps.RulesError) as got:
            self.save("- 좋음", note=secret)
        self.assertEqual((got.exception.body()["field"], got.exception.body()["check"]), ("note", "secret"))
        with self.assertRaises(ps.RulesError) as got:
            self.save("- 좋음", note="가" * (ps.NOTE_MAX + 1))
        self.assertEqual(got.exception.body()["check"], "length")

    def test_restore_and_keep_limit(self):
        self.enable()
        for i in range(1, 5):
            self.save(f"- 판 {i}")
        out = ps.restore_rules(POD, "p1", NAME, 2, 4, "kim", **self.kw())
        self.assertEqual(out["rev"], 5)
        self.assertEqual(ps.rules_at(POD, "p1", NAME, 5, **self.kw())["text"], "- 판 2")
        for i in range(6, ps.RULES_KEEP + 2):
            self.save(f"- 판 {i}")
        revs = [v["rev"] for v in self.view()["versions"]]
        self.assertEqual(len(revs), ps.RULES_KEEP)
        self.assertEqual(min(revs), 2)
        with self.assertRaises(ps.RulesError) as got:
            ps.restore_rules(POD, "p1", NAME, 1, max(revs), "kim", **self.kw())
        self.assertEqual((got.exception.status, got.exception.reason, got.exception.extra["oldest_rev"]), (404, "rev_gone", 2))

    def test_preview_does_not_save(self):
        self.enable()
        self.save("- 있음")
        out = ps.preview_rules(POD, "p1", NAME, "- 새 규칙", **self.kw())
        self.assertEqual(out["rev"], 2)
        self.assertTrue(out["tail"].startswith("## 이 설치의 규칙\n"))
        self.assertRegex(out["tail"], r"\(판 2, \d{4}-\d\d-\d\d \d\d:\d\d[+-]\d\d:\d\d\)")
        self.assertEqual(self.view()["rev"], 1)
        with self.assertRaises(ps.RulesError) as got:
            ps.preview_rules(POD, "p1", NAME, "## 절", **self.kw())
        self.assertEqual(got.exception.status, 422)

    def test_view_fields(self):
        self.enable()
        v = self.view()
        self.assertEqual((v["rev"], v["text"], v["reads_rules"], v["can_edit"]), (0, "", False, True))
        self.assertEqual(v["fixed_rules"], "- 개인정보를 요청하지 않는다")
        self.write_source(body="**이 설치의 규칙** — 끝 절을 따른다")
        self.assertTrue(self.view()["reads_rules"])
        self.assertFalse(ps.rules_view(POD, "p1", NAME, can_write=False, **self.kw())["can_edit"])
        self.assertFalse(self.view(clone_of="p1")["can_edit"])

    def test_ack_with_an_old_rev_is_busy(self):
        self.enable()
        self.save("- a")
        self.save("- b")
        with self.assertRaises(ps.RulesError) as got:
            ps.ack_rules(POD, "p1", NAME, 1, "kim", **self.kw())
        self.assertEqual(got.exception.status, 409)


class CloneRulesTest(RulesBase):
    def test_clone_gets_the_same_rev_and_follows_the_template(self):
        self.enable()
        self.enable("mwauto-p1")
        self.save("- a")
        self.save("- b")
        self.assertEqual(ps.copy_rules(POD, "p1", "mwauto-p1", NAME), 2)
        rows = ps._rule_rows(POD, "mwauto-p1", NAME)
        self.assertEqual([(r["rev"], r["text"], r["clone_of"]) for r in rows], [(2, "- b", "p1")])
        self.cycle()
        self.assertIn("- b", self.copy("mwauto-p1"))
        self.assertEqual(self.copy("mwauto-p1"), self.copy("p1"))                  # 같은 ts 를 복사해 바이트까지 같다
        self.save("- c")
        self.cycle(1_000_060.0)
        self.assertIn("- b", self.copy("mwauto-p1"))                               # 카드 사이에는 옛 규칙 그대로
        self.assertNotIn("protected_skill_restored", self.codes("mwauto-p1"))
        self.assertEqual(ps.copy_rules(POD, "p1", "mwauto-p1", NAME), 3)

    def test_template_recreated_with_rev_one_replaces_the_clone_row(self):
        self.enable()
        self.save("- a")
        self.save("- b")
        ps.copy_rules(POD, "p1", "mwauto-p1", NAME)
        ps.forget_profile(POD, "p1")
        self.assertEqual(ps.copy_rules(POD, "p1", "mwauto-p1", NAME), 0)
        self.assertEqual(ps._rule_rows(POD, "mwauto-p1", NAME), [])
        self.enable()
        self.save("- 새 글")
        ps.copy_rules(POD, "p1", "mwauto-p1", NAME)
        self.assertEqual([(r["rev"], r["text"]) for r in ps._rule_rows(POD, "mwauto-p1", NAME)], [(1, "- 새 글")])

    def test_no_base_notice_for_a_clone(self):
        self.enable()
        self.enable("mwauto-p1")
        self.save("- a")
        ps.copy_rules(POD, "p1", "mwauto-p1", NAME)
        self.cycle()
        self.write_source("0.2.0")
        self.cycle(1_000_060.0)
        self.assertIn("protected_skill_rules_base", self.codes("p1"))
        self.assertNotIn("protected_skill_rules_base", self.codes("mwauto-p1"))


class ProfileRenameTest(RulesBase):
    def test_rename_moves_rules_and_clone_pointers_and_forget_removes_them(self):
        self.enable()
        self.save("- a")
        ps.copy_rules(POD, "p1", "mwauto-p1", NAME)
        ps.rename_profile(POD, "p1", "p9")
        self.assertEqual(ps.current_rule(POD, "p9", NAME)["text"], "- a")
        self.assertIsNone(ps.current_rule(POD, "p1", NAME))
        self.assertEqual(ps.current_rule(POD, "mwauto-p1", NAME)["clone_of"], "p9")
        ps.forget_profile(POD, "p9")
        self.assertIsNone(ps.current_rule(POD, "p9", NAME))


if __name__ == "__main__":
    unittest.main()

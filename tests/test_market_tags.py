# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""스킬 허브 태그 시험(OMAI-1275) — LLM 분류 결과 검사, 저장·재분류 규칙, catalog 연결. LiteLLM 은 가짜 함수로 바꾼다.
답 모양은 {"work": 업무, "tags": [기능…]}, 저장 값은 [업무, 기능…](스펙 2026-11-17-003)."""
import aasserver  # noqa: F401  (시험 하네스)
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

TMP = tempfile.TemporaryDirectory()
os.environ.setdefault("AAS_DATA_DIR", str(Path(TMP.name) / "data"))

from aas.common import store  # noqa: E402
from aas.market import marketplace as mk, tags  # noqa: E402

def ans(*kinds, work="common"):
    """가짜 LLM 답: 업무 하나와 기능 태그들."""
    return json.dumps({"work": work, "tags": list(kinds)})


ROWS = [
    {"id": "community/code-review", "namespace": "community", "name": "code-review", "summary": "Conducts multi-axis code review.", "version": "0.0.1"},
    {"id": "community/brandkit", "namespace": "community", "name": "brandkit", "summary": "Brand-kit image generation skill.", "version": "0.0.1"},
]


class TagsBase(unittest.TestCase):
    def setUp(self):
        self.path = store.data_dir() / "market" / tags.TAGS
        self.path.parent.mkdir(parents=True, exist_ok=True)
        if self.path.exists():
            self.path.unlink()
        self.cat = mock.patch.object(mk, "catalog", return_value=[dict(r) for r in ROWS])
        self.cat.start()

    def tearDown(self):
        self.cat.stop()
        if self.path.exists():
            self.path.unlink()


class ParseAnswerTest(unittest.TestCase):
    def test_work_first_then_only_vocabulary_kinds_in_order_without_duplicates_up_to_two(self):
        got = tags.parse_answer(ans("code-quality", "design", "code-quality", "nope", "docs", work="engineering"))
        self.assertEqual(got, ["engineering", "code-quality", "design"])

    def test_work_alone_is_enough(self):
        self.assertEqual(tags.parse_answer(ans(work="sales")), ["sales"])

    def test_accepts_json_inside_text_or_code_fence(self):
        self.assertEqual(tags.parse_answer('답: ```json\n{"work": "marketing", "tags": ["data"]}\n``` 입니다'), ["marketing", "data"])

    def test_a_kind_id_in_the_work_place_moves_to_kinds_and_a_work_id_in_tags_is_dropped(self):
        # 업무 자리에 기능 id(COP 실측, temperature 0 이라 다시 물어도 같다) → 기능으로 옮기고 공통 업무
        self.assertEqual(tags.parse_answer('{"work": "design", "tags": ["design"]}'), ["common", "design"])
        self.assertEqual(tags.parse_answer(ans("docs", work="image")), ["common", "image", "docs"])
        self.assertEqual(tags.parse_answer(ans("sales", "docs", work="sales")), ["sales", "docs"])   # 기능 자리의 업무 id 는 버린다

    def test_garbage_empty_missing_work_or_the_old_array_answer_gives_empty_list(self):
        # 업무가 없는 행을 남기지 않는다 — 실패로 세어 다시 묻는다. 옛 배열 답(업무 없음)도 실패다
        for bad in ("", "I cannot", "[]", '{"a": 1}', '{"tags": ["docs"]}', ans(work="unknown"), '["docs", "data"]', '{"work": 3}'):
            self.assertEqual(tags.parse_answer(bad), [], bad)

    def test_vocabulary_ids_are_unique_lowercase_slugs(self):
        self.assertEqual(len(set(tags.VOCAB)), len(tags.VOCAB))
        self.assertTrue(all(v == v.lower() and v.replace("-", "").isalnum() for v in tags.VOCAB))

    def test_work_ids_are_the_role_templates_plus_common_and_never_clash_with_kinds(self):
        from aas.common.soul_templates import CATALOG
        self.assertEqual(list(tags.WORK), [c[0] for c in CATALOG] + ["common"])        # 업무 템플릿과 같은 id·순서
        self.assertFalse(set(tags.WORK) & set(tags.VOCAB))                              # 목록 하나에 섞어 담아도 구분된다
        self.assertLessEqual(1 + tags.MAX_KIND, tags.MAX_TAGS)

    def test_prompt_lists_both_vocabularies_with_the_department_keywords(self):
        system = tags._prompt("sa-makequote", "견적 작성")[0]["content"]
        for word in ("sales", "영업", "marketing", "홍보", "common", "code-quality", '"work"'):
            self.assertIn(word, system)


class RequestBodyTest(unittest.TestCase):
    def test_turns_thinking_off_so_a_reasoning_model_spends_its_tokens_on_the_answer(self):
        # OKE 의 cogentai-aas 는 추론 모델이라 max_tokens 60 을 생각에 다 써서 답이 비었다(51개 모두 실패, 2026-10-17)
        body = tags.request_body([{"role": "user", "content": "x"}])
        self.assertEqual(body["chat_template_kwargs"], {"enable_thinking": False})
        self.assertEqual(body["temperature"], 0)
        self.assertEqual(body["model"], "cogentai-aas")



class GuardrailModelTest(unittest.TestCase):
    """사람이 친 글이 없는 AI 보조(스킬 태그·요약·번역)는 쿠버네티스에서 가드레일 제외 별칭으로 보낸다(OMAI-1500, 2026-10-27-003 G1).
    SKILL.md 를 주 모델로 보내 가드레일이 jailbreak 로 막았다(OKE 2026-10-27 11:30, `name: suitecrm-crm …`)."""

    def test_kubernetes_sends_skill_assist_calls_to_the_excluded_alias(self):
        from aas.market import skill_desc, summary
        with mock.patch.dict(os.environ, {"AAS_K8S_NAMESPACE": "cogentai-aas"}, clear=False):
            for var in ("AAS_MARKET_TAG_MODEL", "AAS_SKILL_SUMMARY_MODEL", "AAS_SKILL_DESC_MODEL", "AAS_GUARDRAIL_EXCLUDE_MODELS"):
                os.environ.pop(var, None)
            self.assertEqual(tags._model(), "cogentai-aas-aux")
            self.assertEqual(summary._model(), "cogentai-aas-aux")
            self.assertEqual(skill_desc._model(), "cogentai-aas-aux")
            with mock.patch.dict(os.environ, {"AAS_MARKET_TAG_MODEL": "my-model"}):
                self.assertEqual(tags._model(), "my-model")        # 설치가 정한 값이 우선

    def test_compose_keeps_the_main_alias(self):
        with mock.patch.dict(os.environ, {}, clear=False):
            for var in ("AAS_K8S_NAMESPACE", "AAS_MARKET_TAG_MODEL"):
                os.environ.pop(var, None)
            self.assertEqual(tags._model(), "cogentai-aas")

    def test_typed_text_assist_calls_stay_on_the_checked_agent_model(self):
        """슬로건·카드 나누기는 사람이 친 값이라 가드레일이 검사하는 에이전트 모델로 보낸다(태그 별칭을 따르지 않는다)."""
        with mock.patch.dict(os.environ, {"AAS_K8S_NAMESPACE": "cogentai-aas", "HERMES_LLM_MODEL": "cogentai-aas"}):
            self.assertEqual(tags.typed_text_model(), "cogentai-aas")
        with mock.patch.dict(os.environ, {"HERMES_LLM_MODEL": "llama3"}):
            self.assertEqual(tags.typed_text_model(), "llama3")


class SyncTest(TagsBase):
    def test_tags_untagged_packages_and_saves_atomically_with_version(self):
        asked = []

        def ask(messages):
            asked.append(messages)
            return ans("code-quality") if "code review" in messages[-1]["content"].lower() else ans("design", "image")

        r = tags.sync_once(ask=ask)
        self.assertEqual((r["tagged"], r["failed"], r["pending"]), (2, 0, 0))
        table = json.loads(self.path.read_text(encoding="utf-8"))
        self.assertEqual(table["community/code-review"]["tags"], ["common", "code-quality"])
        self.assertEqual(table["community/brandkit"]["tags"], ["common", "design", "image"])
        self.assertEqual(table["community/brandkit"]["for"], "0.0.1")
        self.assertEqual(table["community/brandkit"]["v"], tags.TAG_SCHEMA)
        self.assertIn("code-review", asked[0][-1]["content"])                      # 이름과 설명을 보낸다
        self.assertFalse(list(self.path.parent.glob("*.tmp")))                      # 임시 파일을 남기지 않는다

    def test_already_tagged_same_version_is_not_asked_again_but_a_new_version_is(self):
        tags.sync_once(ask=lambda m: ans("testing"))
        ask = mock.Mock(return_value=ans("docs"))
        self.assertEqual(tags.sync_once(ask=ask)["tagged"], 0)
        ask.assert_not_called()
        rows = [dict(ROWS[0], version="0.0.2"), dict(ROWS[1])]
        with mock.patch.object(mk, "catalog", return_value=rows):
            r = tags.sync_once(ask=ask)
        self.assertEqual(r["tagged"], 1)
        self.assertEqual(json.loads(self.path.read_text(encoding="utf-8"))["community/code-review"]["tags"], ["common", "docs"])

    def test_bad_answers_are_not_saved_as_tags_and_stop_after_three_tries(self):
        ask = mock.Mock(return_value="모르겠습니다")
        for _ in range(5):
            tags.sync_once(ask=ask)
        self.assertEqual(ask.call_count, 2 * tags.MAX_TRIES)                         # 패키지 둘 × 3번까지만
        table = json.loads(self.path.read_text(encoding="utf-8"))
        self.assertEqual(table["community/brandkit"]["tags"], [])
        self.assertEqual(table["community/brandkit"]["tries"], tags.MAX_TRIES)

    def test_failures_from_the_model_call_count_as_tries_and_do_not_raise(self):
        def boom(_):
            raise OSError("LiteLLM down")
        r = tags.sync_once(ask=boom)
        self.assertEqual((r["tagged"], r["failed"]), (0, 2))

    def test_limit_per_cycle_and_pending_count(self):
        ask = mock.Mock(return_value=ans("agent"))
        r = tags.sync_once(ask=ask, limit=1)
        self.assertEqual((r["tagged"], r["pending"]), (1, 1))

    def test_no_litellm_means_silently_nothing(self):
        with mock.patch.dict(os.environ, {"AAS_LITELLM_URL": "", "AAS_LITELLM_KEY": ""}):
            r = tags.sync_once()
        self.assertEqual((r["tagged"], r["failed"]), (0, 0))
        self.assertFalse(self.path.exists())

    def test_reset_marks_everything_stale_but_keeps_the_old_tags_visible(self):
        tags.sync_once(ask=lambda m: ans("testing"))
        self.assertEqual(tags.reset(), 2)
        self.assertEqual(tags.row_tags(tags.load(), "community/code-review"), ["common", "testing"])   # 새 값이 올 때까지 옛 태그를 보인다
        ask = mock.Mock(return_value=ans("docs"))
        tags.sync_once(ask=ask)
        self.assertEqual(ask.call_count, 2)
        self.assertEqual(tags.row_tags(tags.load(), "community/code-review"), ["common", "docs"])


SKILLS = [
    {"name": "apple-notes", "description": "Manage Apple Notes via memo CLI.", "origin": "bundled"},
    {"name": "arxiv", "description": "Search arXiv papers.", "origin": "bundled"},
]


class SkillTagsTest(TagsBase):
    """스킬 화면의 태그(OMAI-1283): 마켓과 같은 표·어휘, 키는 이름+설명 내용."""

    def test_key_follows_the_content_not_only_the_name(self):
        a = tags.skill_key("weekly", "Writes a weekly report.")
        self.assertTrue(a.startswith("skill:"))
        self.assertEqual(a, tags.skill_key("weekly", "Writes a weekly report."))
        self.assertNotEqual(a, tags.skill_key("weekly", "Something else entirely."))   # 같은 이름·다른 내용은 서로 덮지 않는다
        self.assertNotEqual(a, tags.skill_key("monthly", "Writes a weekly report."))

    def test_skills_are_classified_with_the_same_vocabulary_and_saved_by_content_key(self):
        ask = mock.Mock(return_value=ans("automation", "not-in-vocab"))
        r = tags.sync_once(ask=ask, skills=SKILLS)
        self.assertEqual(r["tagged"], 2 + len(ROWS))                                    # 마켓 둘 + 스킬 둘
        table = tags.load()
        key = tags.skill_key("apple-notes", "Manage Apple Notes via memo CLI.")
        self.assertEqual(table[key]["tags"], ["common", "automation"])                  # 어휘 밖의 값은 버린다
        self.assertNotIn("Apple", json.dumps(table))                                    # 이름·설명은 저장하지 않는다

    def test_same_content_is_asked_once_even_if_many_pods_have_it(self):
        ask = mock.Mock(return_value=ans("data"))
        tags.sync_once(ask=ask, skills=SKILLS + [dict(SKILLS[0], profile="other")] * 3)
        names = [c.args[0][-1]["content"] for c in ask.call_args_list if "apple-notes" in c.args[0][-1]["content"]]
        self.assertEqual(len(names), 1)

    def test_a_skill_installed_from_the_market_reuses_the_market_tags_without_a_call(self):
        tags.sync_once(ask=lambda m: ans("design"))                                      # 마켓 행이 먼저 생긴다
        table = tags.load()
        got = tags.skill_tags(table, "brandkit", "anything", "market")
        self.assertEqual(got, ["common", "design"])                                     # community/brandkit 의 태그
        ask = mock.Mock(return_value=ans("docs"))
        r = tags.sync_once(ask=ask, skills=[{"name": "brandkit", "description": "anything", "origin": "market"}])
        self.assertEqual(r["tagged"], 0)
        ask.assert_not_called()                                                         # 마켓 행이 있으면 스킬 행을 따로 만들지 않는다

    def test_skills_with_other_origins_ignore_a_market_package_of_the_same_name(self):
        tags.sync_once(ask=lambda m: ans("design"))
        self.assertEqual(tags.skill_tags(tags.load(), "brandkit", "mine", "local"), [])  # 이름이 같아도 직접 만든 스킬은 따로 분류한다

    def test_rows_of_skills_that_are_gone_are_pruned_but_market_rows_stay(self):
        tags.sync_once(ask=lambda m: ans("agent"), skills=SKILLS)
        gone = tags.skill_key("arxiv", "Search arXiv papers.")
        self.assertIn(gone, tags.load())
        tags.sync_once(ask=lambda m: ans("agent"), skills=SKILLS[:1])
        table = tags.load()
        self.assertNotIn(gone, table)
        self.assertIn("community/code-review", table)

    def test_prune_false_keeps_old_rows_when_the_list_is_partial(self):
        tags.sync_once(ask=lambda m: ans("agent"), skills=SKILLS)
        tags.sync_once(ask=lambda m: ans("agent"), skills=SKILLS[:1], prune=False)
        self.assertIn(tags.skill_key("arxiv", "Search arXiv papers."), tags.load())

    def test_without_a_skills_argument_existing_skill_rows_are_left_alone(self):
        tags.sync_once(ask=lambda m: ans("agent"), skills=SKILLS)
        tags.sync_once(ask=lambda m: ans("agent"))                                        # 스킬을 모으지 못한 주기에 지우지 않는다
        self.assertIn(tags.skill_key("arxiv", "Search arXiv papers."), tags.load())

    def test_reset_makes_skill_rows_classify_again(self):
        tags.sync_once(ask=lambda m: ans("agent"), skills=SKILLS)
        tags.reset()
        ask = mock.Mock(return_value=ans("docs"))
        tags.sync_once(ask=ask, skills=SKILLS)
        self.assertEqual(ask.call_count, 2 + len(ROWS))
        self.assertEqual(tags.skill_tags(tags.load(), "arxiv", "Search arXiv papers.", "bundled"), ["common", "docs"])

    def test_skill_without_description_is_classified_by_name(self):
        ask = mock.Mock(return_value=ans("agent"))
        tags.sync_once(ask=ask, skills=[{"name": "skill-creator", "description": "", "origin": "bundled"}])
        self.assertTrue(any("skill-creator" in c.args[0][-1]["content"] for c in ask.call_args_list))

    def test_skill_tags_is_empty_without_table_or_row(self):
        self.assertEqual(tags.skill_tags({}, "x", "y", "bundled"), [])


class SchemaUpgradeTest(TagsBase):
    """업무 태그가 생기기 전(v 없음)의 행은 관리자 다시 분류 없이 다시 매긴다. 그동안 옛 태그를 그대로 보인다."""

    def _old_rows(self):
        old = {r["id"]: {"tags": ["automation"], "for": r["version"], "tries": 0, "by": "llm"} for r in ROWS}
        old[tags.skill_key(*[SKILLS[0][k] for k in ("name", "description")])] = {"tags": ["docs"], "for": tags.SKILL_VERSION, "tries": 0}
        self.path.write_text(json.dumps(old), encoding="utf-8")

    def test_rows_without_the_schema_are_classified_again_and_keep_old_tags_until_then(self):
        self._old_rows()
        self.assertEqual(tags.row_tags(tags.load(), "community/brandkit"), ["automation"])
        ask = mock.Mock(return_value=ans("docs", work="sales"))
        r = tags.sync_once(ask=ask, skills=SKILLS[:1], limit=1)
        self.assertEqual((r["tagged"], r["pending"]), (1, 2))
        table = tags.load()
        upgraded = [k for k, v in table.items() if v.get("v") == tags.TAG_SCHEMA]
        self.assertEqual(len(upgraded), 1)
        still_old = [k for k in table if k not in upgraded]
        self.assertTrue(all(tags.row_tags(table, k) for k in still_old))                # 아직 안 한 행은 옛 태그를 보인다
        tags.sync_once(ask=ask, skills=SKILLS[:1])
        self.assertTrue(all(v.get("v") == tags.TAG_SCHEMA for v in tags.load().values()))
        self.assertEqual(tags.row_tags(tags.load(), "community/brandkit"), ["sales", "docs"])

    def test_upgraded_rows_are_not_asked_again(self):
        self._old_rows()
        tags.sync_once(ask=lambda m: ans(work="marketing"), skills=SKILLS[:1])
        ask = mock.Mock(return_value=ans(work="sales"))
        tags.sync_once(ask=ask, skills=SKILLS[:1])
        ask.assert_not_called()

    def test_an_old_row_that_keeps_failing_stops_after_three_tries_and_keeps_its_old_tags(self):
        self._old_rows()
        ask = mock.Mock(return_value='["docs"]')                                        # 옛 모양 답(업무 없음)은 실패
        for _ in range(5):
            tags.sync_once(ask=ask)
        self.assertEqual(ask.call_count, len(ROWS) * tags.MAX_TRIES)
        self.assertEqual(tags.row_tags(tags.load(), "community/brandkit"), ["automation"])


class WorkPrefixTest(TagsBase):
    """이름 접두어 → 업무(관리자 설정, 스펙 2026-11-17-003). COP 의 sa-·ma- 스킬 11개가 「하는 일」로 공통·개발 등에 갔다."""
    RULES = [{"prefix": "sa-", "work": "sales"}, {"prefix": "ma-", "work": "marketing"}]

    def tearDown(self):
        tags.set_work_prefixes([])
        super().tearDown()

    def test_clean_checks_and_normalizes_rules(self):
        got = tags.clean_prefixes([{"prefix": " SA- ", "work": "sales"}, {"prefix": "", "work": ""}, {"prefix": "sa-", "work": "support"}])
        self.assertEqual(got, [{"prefix": "sa-", "work": "support"}])                # 소문자, 빈 줄 무시, 같은 접두어는 뒤의 것
        for bad in ([{"prefix": "sa-", "work": "docs"}], [{"prefix": "sa-", "work": "nope"}], [{"prefix": "s a", "work": "sales"}],
                    [{"prefix": "", "work": "sales"}], [{"prefix": "x" * 30, "work": "sales"}], "sa-=sales",
                    [{"prefix": f"p{i}-", "work": "sales"} for i in range(tags.PREFIX_MAX + 1)]):
            with self.assertRaises(ValueError, msg=str(bad)[:40]):
                tags.clean_prefixes(bad)

    def test_prefix_replaces_only_the_work_and_keeps_kinds(self):
        self.assertEqual(tags.with_prefix("sa-minutes", ["common", "docs", "automation"], self.RULES), ["sales", "docs", "automation"])
        self.assertEqual(tags.with_prefix("MA-wp-audit", ["engineering", "code-quality"], self.RULES), ["marketing", "code-quality"])
        self.assertEqual(tags.with_prefix("hwp-to-markdown", ["common", "docs"], self.RULES), ["common", "docs"])   # 맞지 않으면 그대로
        self.assertEqual(tags.with_prefix("sa-new", [], self.RULES), ["sales"])          # 아직 분류 전이어도 업무는 보인다
        self.assertEqual(tags.with_prefix("sa-x", ["automation"], self.RULES), ["sales", "automation"])   # 옛 행(업무 없음)

    def test_longest_prefix_wins(self):
        rules = self.RULES + [{"prefix": "sa-cs-", "work": "support"}]
        self.assertEqual(tags.prefix_work("sa-cs-faq", rules), "support")
        self.assertEqual(tags.prefix_work("sa-crm", rules), "sales")

    def test_saved_rules_apply_to_market_rows_and_skills_and_can_be_cleared(self):
        tags.sync_once(ask=lambda m: ans("docs", work="common"), skills=[{"name": "sa-minutes", "description": "회의록", "origin": "bundled"}])
        table = tags.load()
        table["free/ma-wp-audit"] = {"tags": ["engineering", "code-quality"], "for": "1", "v": tags.TAG_SCHEMA}
        self.assertEqual(tags.row_tags(table, "free/ma-wp-audit"), ["engineering", "code-quality"])
        self.assertEqual(tags.set_work_prefixes(self.RULES, "admin@x"), self.RULES)
        self.assertEqual(tags.work_prefixes(), self.RULES)                              # DB 설정 표에 남는다
        self.assertEqual(tags.row_tags(table, "free/ma-wp-audit"), ["marketing", "code-quality"])
        self.assertEqual(tags.skill_tags(tags.load(), "sa-minutes", "회의록", "bundled"), ["sales", "docs"])
        self.assertEqual(tags.load()[tags.skill_key("sa-minutes", "회의록")]["tags"], ["common", "docs"])   # 분류 결과는 그대로
        tags.set_work_prefixes([])
        self.assertEqual(tags.skill_tags(tags.load(), "sa-minutes", "회의록", "bundled"), ["common", "docs"])

    def test_a_market_installed_skill_is_still_found_by_its_classified_row(self):
        table = {"free/sa-crm": {"tags": ["sales", "automation"], "for": "1", "v": tags.TAG_SCHEMA}}
        self.assertEqual(tags.skill_tags(table, "sa-crm", "x", "market", self.RULES), ["sales", "automation"])
        self.assertEqual(tags.skill_tags({}, "sa-crm", "x", "market", self.RULES), ["sales"])   # 마켓 행이 없어도 규칙은 적용


class RefreshAuthTest(unittest.TestCase):
    def test_only_admins_may_refresh_when_login_is_on(self):
        self.assertTrue(tags.may_refresh(False, False))
        self.assertTrue(tags.may_refresh(True, True))
        self.assertFalse(tags.may_refresh(True, False))


class CatalogTest(unittest.TestCase):
    def test_row_tags_is_empty_without_table_or_row_and_only_returns_vocabulary(self):
        self.assertEqual(tags.row_tags({}, "community/x"), [])
        self.assertEqual(tags.row_tags({"community/x": {"tags": ["sales", "design", "zzz", 5]}}, "community/x"), ["sales", "design"])
        self.assertEqual(tags.row_tags({"community/x": "oops"}, "community/x"), [])

    def test_catalog_and_package_carry_tags(self):
        table = store.data_dir() / "market" / tags.TAGS
        table.parent.mkdir(parents=True, exist_ok=True)
        table.write_text(json.dumps({"free/hello": {"tags": ["automation"], "for": "1.0.0"}}), encoding="utf-8")
        try:
            def fetch(path, cfg=None):
                if "/api/web/skills" in path:
                    return {"items": [{"namespace": "free", "slug": "hello", "status": "ACTIVE", "visibility": "PUBLIC", "summary": "x" * 30,
                                       "publishedVersion": {"version": "1.0.0"}}], "total": 1}
                raise AssertionError(path)
            with mock.patch.object(mk, "fetch", side_effect=fetch):
                rows = mk.catalog({"url": "http://hub", "token_file": "", "namespaces": ["free"]})
            self.assertEqual(rows[0]["tags"], ["automation"])
        finally:
            table.unlink()


if __name__ == "__main__":
    unittest.main()

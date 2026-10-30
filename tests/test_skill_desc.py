# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""스킬 설명 번역 시험(스펙 2026-10-19-017) — 키, 찾기, 대기 기록, LLM 번역 검사, 리더 일괄, 다시 번역. LiteLLM 은 가짜 함수로 바꾼다."""
import aasserver  # noqa: F401  (시험 하네스)
import json
import os
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

TMP = tempfile.TemporaryDirectory()
os.environ.setdefault("AAS_DATA_DIR", str(Path(TMP.name) / "data"))

from aas.common import i18n, store  # noqa: E402
from aas.hermes import skill_commands  # noqa: E402
from aas.market import skill_desc as sd  # noqa: E402

BOX = "Box manages cloud files, sharing, search, and metadata through the Box API for teams and enterprise accounts with folders."
BOX_KO = "Box API 로 클라우드 파일·공유·검색·메타데이터를 관리합니다."   # i18n-ignore: 시험 값


class Base(unittest.TestCase):
    def setUp(self):
        self.dir = store.data_dir() / "market"
        self.dir.mkdir(parents=True, exist_ok=True)
        self._clean()
        self.seed = Path(TMP.name) / "seed.json"
        self.seed.write_text("{}", encoding="utf-8")
        self.env = mock.patch.dict(os.environ, {"AAS_SKILL_DESC_SEED": str(self.seed)})
        self.env.start()
        sd._missing.clear()
        i18n.set_lang("ko")

    def tearDown(self):
        self.env.stop()
        self._clean()
        sd._missing.clear()
        i18n.set_lang("ko")

    def _clean(self):
        for p in list(self.dir.glob("skill_desc*.json")):
            p.unlink()

    def write_seed(self, rows: dict):
        self.seed.write_text(json.dumps(rows, ensure_ascii=False), encoding="utf-8")

    def write_table(self, rows: dict):
        sd._write_json(sd._table_path(), rows)


class KeyTest(unittest.TestCase):
    def test_truncated_and_reflowed_descriptions_share_a_key(self):
        k = sd.desc_key("box", BOX)
        self.assertEqual(sd.desc_key("box", BOX[:159] + "…"), k)          # / 목록 160자
        self.assertEqual(sd.desc_key("Box", "  " + BOX.replace(" ", "  ")[:400]), k)   # 공백·대소문자
        self.assertNotEqual(sd.desc_key("box2", BOX), k)

    def test_worth_skips_short_yaml_marks_and_hangul(self):
        self.assertFalse(sd.worth(">-"))
        self.assertFalse(sd.worth("|"))
        self.assertFalse(sd.worth("short"))
        self.assertFalse(sd.worth("주간 업무를 요약하는 스킬입니다"))   # i18n-ignore: 시험 값
        self.assertTrue(sd.worth(BOX))


class FindTest(Base):
    def test_table_wins_over_seed_and_english_gets_nothing(self):
        k = sd.desc_key("box", BOX)
        self.write_seed({k: {"ko": "미리 만든 번역"}})   # i18n-ignore: 시험 값
        self.assertEqual(sd.find("box", BOX), ("미리 만든 번역", "seed"))   # i18n-ignore: 시험 값
        self.write_table({k: {"ko": BOX_KO}})
        self.assertEqual(sd.find("box", BOX), (BOX_KO, "llm"))
        i18n.set_lang("en")
        self.assertIsNone(sd.find("box", BOX))

    def test_seed_is_used_even_for_mixed_language_description(self):
        mixed = "AAS 사용법을 알려 줍니다 / Explains how to use AAS"   # i18n-ignore: 시험 값
        self.write_seed({sd.desc_key("aas-help", mixed): {"ko": "AAS 사용법을 알려 줍니다"}})   # i18n-ignore: 시험 값
        self.assertEqual(sd.find("aas-help", mixed)[1], "seed")

    def test_table_is_not_reread_until_it_changes(self):
        self.write_table({sd.desc_key("box", BOX): {"ko": BOX_KO}})
        sd.find("box", BOX)
        n = sd.reads["n"]
        for _ in range(5):
            sd.find("box", BOX)
        self.assertEqual(sd.reads["n"], n)


class ApplyTest(Base):
    def test_ko_gets_translation_src_and_by_and_full_field_is_removed(self):
        self.write_table({sd.desc_key("box", BOX): {"ko": BOX_KO * 5}})
        rows = [{"name": "box", "description": BOX[:160], "description_full": BOX}]
        out = sd.apply(rows, 160)
        self.assertLessEqual(len(out[0]["description"]), 160)                    # 번역도 그 길의 한도로 자른다
        self.assertEqual(out[0]["description_src"], BOX[:160])
        self.assertEqual(out[0]["description_by"], "llm")
        self.assertNotIn("description_full", out[0])
        self.assertEqual(rows[0]["description"], BOX[:160])                      # 저장값은 고치지 않는다

    def test_en_returns_original_without_src(self):
        self.write_table({sd.desc_key("box", BOX): {"ko": BOX_KO}})
        i18n.set_lang("en")
        out = sd.apply([{"name": "box", "description": BOX, "description_full": BOX}], 240)
        self.assertEqual(out[0], {"name": "box", "description": BOX})

    def test_missing_goes_to_pending_with_redacted_text_and_raw_key(self):
        secret = BOX + " see https://example.com/x?token=abc123"
        sd.apply([{"name": "box", "description": secret}], 240)
        k = sd.desc_key("box", secret)
        self.assertIn(k, sd._missing)
        self.assertNotIn("abc123", sd._missing[k]["text"])                        # 대기 파일에 비밀값을 두지 않는다
        sd.apply([{"name": "short", "description": ">-"}], 240)
        self.assertEqual(len(sd._missing), 1)                                    # 의미 없는 설명은 오르지 않는다


class FlushTest(Base):
    def test_flush_writes_only_when_changed_and_per_host(self):
        sd.note_missing("box", BOX)
        with mock.patch.object(sd, "_host", return_value="pod-a"):
            self.assertTrue(sd.flush())
            self.assertFalse(sd.flush())                                         # 바뀐 것이 없으면 쓰지 않는다
        sd.note_missing("other", BOX + " other")
        with mock.patch.object(sd, "_host", return_value="pod-b"):
            sd.flush()
        names = sorted(p.name for p in self.dir.glob("skill_desc_pending.*.json"))
        self.assertEqual(names, ["skill_desc_pending.pod-a.json", "skill_desc_pending.pod-b.json"])
        self.assertEqual(len(sd._pending_items()), 2)                            # 두 서버의 대기가 서로를 지우지 않는다

    def test_done_rows_are_removed_on_next_flush(self):
        sd.note_missing("box", BOX)
        with mock.patch.object(sd, "_host", return_value="pod-a"):
            sd.flush()
            self.write_table({sd.desc_key("box", BOX): {"ko": BOX_KO, "len": len(BOX), "ts": time.time()}})
            self.assertTrue(sd.flush())
        self.assertFalse((self.dir / "skill_desc_pending.pod-a.json").exists())

    def test_temp_file_name_has_host(self):
        with mock.patch.object(sd, "_host", return_value="pod-z"), mock.patch.object(sd.os, "replace") as rep:
            sd._write_json(sd._table_path(), {})
        self.assertIn("pod-z", rep.call_args[0][0].name)


class TranslateTest(Base):
    def test_answer_checks(self):
        self.assertEqual(sd.parse_answer("번역: 「클라우드 파일을 관리합니다」", BOX), "클라우드 파일을 관리합니다")   # i18n-ignore: 시험 값
        self.assertIsNone(sd.parse_answer("Manages cloud files.", BOX))           # 한글 없음
        self.assertIsNone(sd.parse_answer("가" * 500, BOX))                        # i18n-ignore: 시험 값 — 너무 김
        self.assertEqual(sd.parse_answer("첫 줄\n둘째 줄", BOX), "첫 줄 둘째 줄")   # i18n-ignore: 시험 값

    def test_retranslate_shows_previous_and_raises_temperature(self):
        seen = {}

        def ask(messages, temperature):
            seen["t"], seen["msg"] = temperature, messages[-1]["content"]
            return BOX_KO
        sd.translate_once("box", BOX, previous="옛 번역", ask=ask)   # i18n-ignore: 시험 값
        self.assertEqual(seen["t"], 0.3)
        self.assertIn("옛 번역", seen["msg"])   # i18n-ignore: 시험 값

    def test_blocked_is_a_failure(self):
        def ask(messages, temperature):
            raise sd.Blocked()
        self.assertIsNone(sd.translate_once("box", BOX, ask=ask))

    def test_not_configured_does_not_call(self):
        with mock.patch.object(sd, "_configured", return_value=False):
            sd.note_missing("box", BOX)
            sd.flush()
            self.assertEqual(sd.sync_once(), {"done": 0, "failed": 0, "pending": 0})


class SyncTest(Base):
    def run_once(self, answer=BOX_KO, **kw):
        calls = []

        def ask(messages, temperature):
            calls.append(messages[-1]["content"])
            return answer
        got = sd.sync_once(ask=ask, **kw)
        return got, calls

    def test_translates_pending_and_skill_list_up_to_limit(self):
        skills = [{"name": f"s{i}", "description": f"{BOX} number {i}"} for i in range(10)]
        got, calls = self.run_once(skills=skills, limit=8)
        self.assertEqual((got["done"], got["pending"]), (8, 2))
        self.assertEqual(len(calls), 8)

    def test_leader_does_not_recompute_pending_key(self):
        secret = BOX + " https://example.com/a?token=abc123"
        sd.note_missing("box", secret)
        sd.flush()
        self.run_once()
        self.assertIn(sd.desc_key("box", secret), sd.load())                      # 원문 키 그대로(가린 글로 다시 내지 않는다)
        self.assertEqual(sd.find("box", secret)[0], BOX_KO)

    def test_three_failures_stop_and_longer_source_retranslates(self):
        sd.note_missing("box", BOX[:100] + " and more words")
        sd.flush()
        for _ in range(4):
            self.run_once(answer="no hangul")
        k = sd.desc_key("box", BOX[:100] + " and more words")
        self.assertEqual(sd.load()[k]["tries"], 3)
        _, calls = self.run_once()
        self.assertEqual(calls, [])                                              # 그만둔 키는 다시 부르지 않는다

    def test_longer_source_gets_retranslated(self):
        short = BOX[:120]
        sd.note_missing("box", short)
        sd.flush()
        self.run_once()
        sd.note_missing("box", BOX)                                              # 앞 120자가 같은 더 긴 원문
        sd.flush()
        _, calls = self.run_once(answer=BOX_KO + " 추가")   # i18n-ignore: 시험 값
        self.assertEqual(len(calls), 1)
        self.assertEqual(sd.load()[sd.desc_key("box", BOX)]["len"], len(BOX))

    def test_force_retranslates_once_even_over_seed(self):
        k = sd.desc_key("box", BOX)
        self.write_seed({k: {"ko": "미리 만든 번역"}})   # i18n-ignore: 시험 값
        _, calls = self.run_once(skills=[{"name": "box", "description": BOX}])
        self.assertEqual(calls, [])                                              # 미리 만든 번역이 있으면 하지 않는다
        sd.request_retranslate("box", BOX)
        _, calls = self.run_once()
        self.assertEqual(len(calls), 1)
        self.assertIn("미리 만든 번역", calls[0])   # i18n-ignore: 시험 값 — 이전 번역을 보인다
        self.assertEqual(sd.find("box", BOX), (BOX_KO, "llm"))                   # 새 번역이 앞선다
        _, calls = self.run_once()
        self.assertEqual(calls, [])                                              # 반복하지 않는다
        sd.flush()
        self.assertEqual(sd._pending_items(), {})                                # 그 서버가 행을 뺀다

    def test_stale_pending_file_is_removed(self):
        p = self.dir / "skill_desc_pending.gone.json"
        p.write_text(json.dumps({"k": {"name": "x", "text": BOX, "len": 1}}), encoding="utf-8")
        old = time.time() - sd.PENDING_STALE - 10
        os.utime(p, (old, old))
        sd._pending_items()
        self.assertFalse(p.exists())


class CatalogDifferenceTest(Base):
    def test_catalog_and_skill_graph_texts_each_get_translated(self):
        """여러 줄 YAML 설명: skill_graph 는 「>-」, catalog 는 YAML 로 읽은 글. 화면이 보이는 글이 각자 대기에 오른다(D7)."""
        sd.apply([{"name": "box", "description": ">-"}], 240)                     # 스킬 화면 — 의미 없으니 오르지 않는다
        rows = skill_commands.parse({"skills": {"/box": {}}, "pairs": [["/box", BOX]]})["skills"]
        sd.apply(rows, skill_commands.DESC_MAX)
        self.assertEqual(list(sd._missing), [sd.desc_key("box", BOX)])


class FlowExplainTest(Base):
    def test_flow_skill_node_description_is_translated_in_korean_only(self):
        from aas.assets import flow
        node = {"id": "skill:default/box", "kind": "skill", "label": "box", "sub": "공용 · 스킬", "badges": [], "meta": {"설명": BOX}}   # i18n-ignore: 시험 값
        self.write_table({sd.desc_key("box", BOX): {"ko": BOX_KO}})
        self.assertEqual(flow._localize_node(node)["meta"]["설명"], BOX_KO)   # i18n-ignore: 데이터 키
        self.assertEqual(node["meta"]["설명"], BOX)                            # i18n-ignore: 데이터 키 — 캐시된 노드는 그대로
        i18n.set_lang("en")
        self.assertEqual(flow._localize_node(node)["meta"]["Description"], BOX)

    def test_explain_summary_reads_the_raw_node_on_english_screens(self):
        from aas.assets import explain
        raw = {"mcp:x": {"meta": {"설명": "server notes"}}}   # i18n-ignore: 데이터 키
        self.assertEqual(explain._summary({"id": "mcp:x", "meta": {"Description": "server notes"}}, raw), "server notes")


class SeedFileTest(unittest.TestCase):
    def test_every_row_has_hangul_and_a_matching_key(self):
        path = sd._SEED_DEFAULT
        rows = json.loads(path.read_text(encoding="utf-8"))
        self.assertTrue(rows)
        for k, row in rows.items():
            self.assertTrue(sd.has_hangul(row["ko"]), row)
            self.assertEqual(sd.desc_key(row["name"], row["src"]), k, row["name"])


if __name__ == "__main__":
    unittest.main()

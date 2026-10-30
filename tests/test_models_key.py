# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""모델 화면의 LiteLLM 조회 — 키가 없을 때의 안내 문구(한국어·영어)와, 키가 있으면 그 키로 묻는지 시험한다."""
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

TMP = tempfile.TemporaryDirectory()
os.environ.setdefault("AAS_DATA_DIR", str(Path(TMP.name) / "data"))

from aas.common import i18n  # noqa: E402
from aas.ops import models  # noqa: E402


class _Resp:
    def __init__(self, body: bytes = b"{}"):
        self.body = body

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def read(self):
        return self.body


class LitellmKeyTest(unittest.TestCase):
    def setUp(self):
        # 운영(쿠버네티스) LiteLLM 경로의 시험이다. compose 의 OpenAI 호환 경로는 test_models_openai_compat.py
        self.patch = mock.patch.dict(os.environ, {"AAS_LITELLM_URL": "http://litellm.test:4000", "AAS_K8S_NAMESPACE": "ns"})
        self.patch.start()

    def tearDown(self):
        self.patch.stop()
        i18n.set_lang("ko")

    def test_missing_key_message(self):
        with mock.patch("aas.common.netcache.urlopen", return_value=_Resp()):
            for lang, text in (("ko", "모델 목록을 조회할 키가 없습니다"), ("en", "There is no key to query the model list")):
                i18n.set_lang(lang)
                out = models.fetch_litellm("", "")
                self.assertEqual((out["reachable"], out["auth"], out["error"]), (True, "no_key", text))

    def test_key_is_sent_as_bearer(self):
        seen = []

        def fake(req, timeout=0):
            seen.append(getattr(req, "headers", {}).get("Authorization"))
            return _Resp(json.dumps({"data": [{"id": "m1"}]}).encode())

        with mock.patch("aas.common.netcache.urlopen", side_effect=fake):
            out = models.fetch_litellm("sk-test", "AAS_LITELLM_KEY")
        self.assertEqual(out["auth"], "ok")
        self.assertIn("Bearer sk-test", seen)

    def test_key_source_names_the_setting(self):
        with mock.patch.dict(os.environ, {"AAS_LITELLM_KEY": "sk-own"}):
            self.assertEqual(models._resolve_key("sk-agent"), ("sk-own", "AAS_LITELLM_KEY"))   # 서버 설정이 에이전트 설정보다 먼저
        with mock.patch.dict(os.environ, {"AAS_LITELLM_KEY": ""}):
            key, source = models._resolve_key("sk-agent")
            self.assertEqual(key, "sk-agent")
            self.assertTrue(source)


CONFIG = """model:
  provider: "custom:litellm"
  default: "${HERMES_LLM_MODEL}"
providers:
  litellm:
    base_url: "${HERMES_LLM_BASE_URL}"
    api_key: "${HERMES_LLM_API_KEY}"
    default_model: "${HERMES_LLM_MODEL}"
"""


class PlaceholderTest(unittest.TestCase):
    """오퍼레이터가 만든 에이전트 설정의 모델·주소 자리표시자를 서버 설정 값으로 풀어 보이는지 시험한다."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = Path(self.tmp.name) / "config.yaml"
        self.path.write_text(CONFIG, encoding="utf-8")

    def tearDown(self):
        self.tmp.cleanup()

    def test_model_and_base_url_are_resolved_but_key_is_not(self):
        env = {"HERMES_LLM_MODEL": "openmaru-cogentai", "HERMES_LLM_BASE_URL": "http://litellm.test:4000/v1", "HERMES_LLM_API_KEY": "sk-secret"}
        with mock.patch.dict(os.environ, env):
            cfg = models._load_yaml(self.path)
        self.assertEqual(cfg["model"]["default"], "openmaru-cogentai")
        self.assertEqual(cfg["providers"]["litellm"]["default_model"], "openmaru-cogentai")
        self.assertEqual(cfg["providers"]["litellm"]["base_url"], "http://litellm.test:4000/v1")
        self.assertEqual(cfg["providers"]["litellm"]["api_key"], "${HERMES_LLM_API_KEY}")     # 키는 서버 설정에 있어도 풀지 않는다

    def test_unset_values_stay_as_placeholders(self):
        with mock.patch.dict(os.environ, {"HERMES_LLM_MODEL": "", "HERMES_LLM_BASE_URL": ""}):
            cfg = models._load_yaml(self.path)
        self.assertEqual(cfg["model"]["default"], "${HERMES_LLM_MODEL}")


LITELLM_IDS = ["cogentai-aas", "cogentai-aas-aux", "openmaru-cogentai-agent", "openmaru-cogentai-plan"]
OLD_ALIAS_CONFIG = """model:
  provider: custom
  default: openmaru-cogentai-agent
  base_url: http://litellm.test:4000/v1
auxiliary:
  compression:
    model: cogentai-aas-aux
    base_url: http://litellm.test:4000/v1
"""


def _fake_litellm(req, timeout=0):
    url = req if isinstance(req, str) else req.full_url
    if url.endswith("/v1/models"):
        return _Resp(json.dumps({"data": [{"id": m} for m in LITELLM_IDS]}).encode())
    return _Resp()


class PrefixFilterTest(unittest.TestCase):
    """AAS 모델 화면은 AAS_LITELLM_MODEL_PREFIX(기본 cogentai-aas)로 시작하는 모델만 보인다(계획 2026-10-12-005 §7)."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.home = Path(self.tmp.name)
        (self.home / "config.yaml").write_text(OLD_ALIAS_CONFIG, encoding="utf-8")
        env = {"AAS_LITELLM_URL": "http://litellm.test:4000", "AAS_LITELLM_KEY": "sk-test"}
        self.patch = mock.patch.dict(os.environ, env)
        self.patch.start()
        for k in ("AAS_LITELLM_MODEL_PREFIX", "AAS_GUARDRAIL_EXCLUDE_MODELS"):
            os.environ.pop(k, None)

    def tearDown(self):
        self.patch.stop()
        self.tmp.cleanup()
        i18n.set_lang("ko")

    def collect(self):
        with mock.patch("aas.common.netcache.urlopen", side_effect=_fake_litellm):
            return models.collect(home=self.home)

    def test_only_prefixed_models_are_listed_and_the_rest_counted_as_hidden(self):   # ①
        with mock.patch("aas.common.netcache.urlopen", side_effect=_fake_litellm):
            gw = models.fetch_litellm("sk-test", "AAS_LITELLM_KEY")
        self.assertEqual(gw["models"], ["cogentai-aas"])                                # 보조 별칭(가드레일 제외)도 숨긴다
        self.assertEqual(gw["all_models"], sorted(LITELLM_IDS))
        self.assertEqual((gw["hidden"], gw["prefix"]), (3, "cogentai-aas"))

    def test_aux_alias_is_never_listed_even_while_a_profile_uses_it(self):           # ①-1 (OMAI-1269)
        # 새 사용자의 시드 설정이 보조 작업을 이 별칭으로 보내므로 행이 남던 것을, 쓰고 있어도 모델 행으로 보이지 않게 바꿨다
        d = self.collect()
        self.assertNotIn("cogentai-aas-aux", {m["id"] for m in d["models"]})
        default = next(p for p in d["profiles"] if p["name"] == "default")
        self.assertEqual([(a["task"], a["model"]) for a in default["auxiliary"]], [("compression", "cogentai-aas-aux")])  # 프로파일 정보는 그대로
        with mock.patch.dict(os.environ, {"AAS_GUARDRAIL_EXCLUDE_MODELS": ""}):          # 제외 목록을 비우면 쓰는 동안 행으로 보인다(전과 같다)
            rows = {m["id"]: m for m in self.collect()["models"]}
        self.assertEqual(rows["cogentai-aas-aux"]["auxiliary"], ["default:compression"])

    def test_tells_the_aas_default_model(self):
        """2026-10-18: 모델 화면이 기본 모델 이름 옆에 「기본 모델」 뱃지를 보이도록 서버 설정의 기본 모델을 준다."""
        with mock.patch.dict(os.environ, {"HERMES_LLM_MODEL": "cogentai-aas"}):
            self.assertEqual(self.collect()["default_model"], "cogentai-aas")
        with mock.patch.dict(os.environ, {"HERMES_LLM_MODEL": ""}):
            self.assertEqual(self.collect()["default_model"], "")

    def test_old_alias_used_by_a_profile_stays_as_a_warning_not_missing(self):      # ②
        d = self.collect()
        rows = {m["id"]: m for m in d["models"]}
        self.assertEqual(sorted(rows), ["cogentai-aas", "openmaru-cogentai-agent"])   # aux 별칭·plan 은 숨김
        old = rows["openmaru-cogentai-agent"]
        self.assertEqual((old["in_litellm"], old["aas_model"], old["primary"]), (True, False, ["default"]))
        self.assertTrue(rows["cogentai-aas"]["aas_model"])
        issues = next(p for p in d["profiles"] if p["name"] == "default")["issues"]
        self.assertEqual([i["level"] for i in issues], ["warn"])
        self.assertIn("AAS 모델이 아닌 `openmaru-cogentai-agent`", issues[0]["text"])
        self.assertEqual((d["totals"]["litellm_models"], d["totals"]["unused_models"], d["totals"]["profiles_with_bad"]), (1, 1, 0))
        i18n.set_lang("en")
        issues = next(p for p in self.collect()["profiles"] if p["name"] == "default")["issues"]
        self.assertIn("`openmaru-cogentai-agent`, which is not an AAS model", issues[0]["text"])

    def test_empty_prefix_lists_everything(self):                                     # ③
        with mock.patch.dict(os.environ, {"AAS_LITELLM_MODEL_PREFIX": ""}):
            d = self.collect()
        self.assertEqual(sorted(m["id"] for m in d["models"]), sorted(LITELLM_IDS))
        self.assertEqual(d["litellm"]["hidden"], 0)
        self.assertTrue(all(m["aas_model"] for m in d["models"]))
        self.assertEqual(next(p for p in d["profiles"] if p["name"] == "default")["issues"], [])

    def test_chat_models_leave_out_the_aux_alias_and_other_models(self):            # ④
        from aas.fleet import profiles
        self.assertEqual(profiles.chat_models(self.collect()["models"]), ["cogentai-aas"])
        with mock.patch.dict(os.environ, {"AAS_GUARDRAIL_EXCLUDE_MODELS": ""}):
            self.assertEqual(profiles.chat_models(self.collect()["models"]), ["cogentai-aas", "cogentai-aas-aux"])


if __name__ == "__main__":
    unittest.main()

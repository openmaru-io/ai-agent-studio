# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""모델 화면·AI 보조의 LLM 연결 — 쿠버네티스면 LiteLLM, 아니면 OpenAI 호환 기본 주소(스펙 2026-10-21-015 단계 3, 리뷰 R5·R10·R11)."""
import json
import os
import tempfile
import unittest
import urllib.error
from pathlib import Path
from unittest import mock

TMP = tempfile.TemporaryDirectory()
os.environ.setdefault("AAS_DATA_DIR", str(Path(TMP.name) / "data"))

from aas.common import i18n  # noqa: E402
from aas.market import tags  # noqa: E402
from aas.ops import models  # noqa: E402

CLEAR = {"AAS_K8S_NAMESPACE": "", "AAS_LITELLM_URL": "", "AAS_LITELLM_KEY": "", "HERMES_LLM_BASE_URL": "",
         "HERMES_LLM_API_KEY": "", "HERMES_LLM_MODEL": "", "AAS_CHAT_TEMPLATE_KWARGS": ""}
MODELS = json.dumps({"data": [{"id": "qwen3:8b"}, {"id": "llama3.2"}]}).encode()


class _Resp:
    def __init__(self, body: bytes = b"{}"):
        self.body = body

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def read(self):
        return self.body


class Calls:
    """netcache.urlopen 대역. 부른 주소·헤더·본문을 남기고, 주소별로 정한 답(또는 HTTP 오류 코드)을 준다."""

    def __init__(self, answers: dict):
        self.answers, self.seen = answers, []

    def __call__(self, req, timeout=0):
        url = req if isinstance(req, str) else req.full_url
        headers = {} if isinstance(req, str) else {k.lower(): v for k, v in req.header_items()}
        body = None if isinstance(req, str) or req.data is None else json.loads(req.data)
        self.seen.append({"url": url, "auth": headers.get("authorization"), "body": body})
        ans = self.answers.get(url)
        if isinstance(ans, int):
            raise urllib.error.HTTPError(url, ans, "x", {}, None)
        if ans is None:
            raise urllib.error.URLError("refused")
        return _Resp(ans)


def env(**kw):
    return mock.patch.dict(os.environ, {**CLEAR, **kw})


class NotKubernetes(unittest.TestCase):
    def tearDown(self):
        i18n.set_lang("ko")

    def test_기본_주소에_models_만_붙이고_키가_없어도_묻는다(self):
        calls = Calls({"http://llm.test:11434/v1/models": MODELS})
        with env(HERMES_LLM_BASE_URL="http://llm.test:11434/v1/"), mock.patch("aas.common.netcache.urlopen", calls):
            out = models.fetch_litellm(*models._resolve_key(""))
        self.assertEqual([c["url"] for c in calls.seen], ["http://llm.test:11434/v1/models"])     # LiteLLM 전용 liveliness 를 부르지 않는다
        self.assertIsNone(calls.seen[0]["auth"])                                                    # 키가 없으면 헤더도 없다(Ollama)
        self.assertEqual((out["reachable"], out["auth"], out["error"]), (True, "ok", ""))
        self.assertEqual(out["all_models"], ["llama3.2", "qwen3:8b"])

    def test_v1_이_아닌_기본_주소도_그대로_쓴다(self):
        calls = Calls({"https://gen.test/v1beta/openai/models": MODELS})
        with env(HERMES_LLM_BASE_URL="https://gen.test/v1beta/openai", HERMES_LLM_API_KEY="k-gem"), \
                mock.patch("aas.common.netcache.urlopen", calls):
            out = models.fetch_litellm(*models._resolve_key(""))
        self.assertEqual(out["auth"], "ok")
        self.assertEqual(calls.seen[0]["auth"], "Bearer k-gem")

    def test_키가_거절되면_어느_설정을_볼지_알린다(self):
        for code in (401, 403):
            calls = Calls({"http://llm.test/v1/models": code})
            with env(HERMES_LLM_BASE_URL="http://llm.test/v1", HERMES_LLM_API_KEY="bad"), \
                    mock.patch("aas.common.netcache.urlopen", calls):
                out = models.fetch_litellm(*models._resolve_key(""))
            self.assertEqual(out["auth"], "rejected")
            self.assertTrue(out["reachable"])
            self.assertEqual(out["error"], f"키가 거절됐습니다(HERMES_LLM_API_KEY 확인, HTTP {code})")

    def test_연결이_안_되면_LiteLLM_이_아니라_LLM_서버라고_한다(self):
        with env(HERMES_LLM_BASE_URL="http://llm.test/v1"), mock.patch("aas.common.netcache.urlopen", Calls({})):
            out = models.fetch_litellm(*models._resolve_key(""))
        self.assertFalse(out["reachable"])
        self.assertEqual(out["error"], "LLM 서버에 연결할 수 없습니다: URLError")
        i18n.set_lang("en")
        with env(HERMES_LLM_BASE_URL="http://llm.test/v1"), mock.patch("aas.common.netcache.urlopen", Calls({})):
            self.assertEqual(models.fetch_litellm("", "")["error"], "Cannot reach the LLM server: URLError")

    def test_기본_주소가_없으면_AAS_LITELLM_URL_에_v1_을_붙인다(self):
        calls = Calls({"http://litellm.test:4000/v1/models": MODELS})
        with env(AAS_LITELLM_URL="http://litellm.test:4000"), mock.patch("aas.common.netcache.urlopen", calls):
            out = models.fetch_litellm(*models._resolve_key(""))
        self.assertEqual([c["url"] for c in calls.seen], ["http://litellm.test:4000/v1/models"])     # 붙기 compose
        self.assertEqual(out["auth"], "ok")

    def test_주소가_하나도_없으면_두_설정_이름을_알린다(self):
        with env():
            out = models.fetch_litellm("", "")
        self.assertEqual(out["error"], "LLM 주소(HERMES_LLM_BASE_URL 또는 AAS_LITELLM_URL)가 설정되지 않았습니다")

    def test_AI_보조는_주소만_있으면_켜지고_기본_주소에_chat_completions_를_붙인다(self):
        with env():
            self.assertFalse(tags._configured())
        calls = Calls({"http://llm.test/v1/chat/completions": json.dumps({"choices": [{"message": {"content": "ok"}}]}).encode()})
        with env(HERMES_LLM_BASE_URL="http://llm.test/v1"), mock.patch("aas.common.netcache.urlopen", calls):
            self.assertTrue(tags._configured())
            self.assertEqual(tags._chat([{"role": "user", "content": "hi"}], model="qwen3:8b"), "ok")
        self.assertIsNone(calls.seen[0]["auth"])
        self.assertEqual(calls.seen[0]["body"]["model"], "qwen3:8b")
        self.assertEqual(calls.seen[0]["body"]["chat_template_kwargs"], {"enable_thinking": False})   # 기본은 지금처럼 보낸다

    def test_chat_template_kwargs_는_설정으로_뺀다(self):
        with env(AAS_CHAT_TEMPLATE_KWARGS="off"):
            self.assertNotIn("chat_template_kwargs", tags.request_body([{"role": "user", "content": "hi"}]))

    def test_시험_호출도_기본_주소로_키_없이_간다(self):
        calls = Calls({"http://llm.test/v1/chat/completions": json.dumps({"choices": []}).encode()})
        with env(HERMES_LLM_BASE_URL="http://llm.test/v1"), mock.patch("aas.common.netcache.urlopen", calls):
            out = models.probe("qwen3:8b", home=Path(tempfile.mkdtemp(dir=TMP.name)))     # 프로파일 없는 빈 데이터 폴더
        self.assertTrue(out["ok"], out)
        self.assertIsNone(calls.seen[0]["auth"])

    def test_설정의_모델_자리표시자는_서버의_HERMES_LLM_MODEL_로_보인다(self):
        with env(HERMES_LLM_MODEL="qwen3:8b"):
            self.assertEqual(models._expand({"default": "${HERMES_LLM_MODEL}"}), {"default": "qwen3:8b"})


    def test_프로파일_목록의_모델_이름도_자리표시자를_푼다(self):
        from aas.fleet import profiles
        empty = {"profiles": []}
        hp = [{"name": "default", "is_default": True, "model": "${HERMES_LLM_MODEL}", "provider": "custom"}]
        with env(HERMES_LLM_MODEL="qwen3:8b"):
            rows = profiles.summarize(hp, [], empty, empty, empty, [], empty, {})
        self.assertEqual(rows[0]["model"], "qwen3:8b")                  # 단계 0 스파이크에서 화면에 ${HERMES_LLM_MODEL} 로 보였다
        with env():
            self.assertEqual(profiles.summarize(hp, [], empty, empty, empty, [], empty, {})[0]["model"], "${HERMES_LLM_MODEL}")


class Kubernetes(unittest.TestCase):
    """쿠버네티스 모드는 지금 동작 그대로(LiteLLM liveliness → /v1/models, 키 필요). 401·403 문구만 같은 꼴로."""

    def test_liveliness_다음에_v1_models_를_묻는다(self):
        calls = Calls({"http://litellm.test:4000/health/liveliness": b"ok", "http://litellm.test:4000/v1/models": MODELS})
        with env(AAS_K8S_NAMESPACE="ns", AAS_LITELLM_URL="http://litellm.test:4000", AAS_LITELLM_KEY="k-own",
                 HERMES_LLM_BASE_URL="http://ignored.test/v1"), mock.patch("aas.common.netcache.urlopen", calls):
            out = models.fetch_litellm(*models._resolve_key(""))
        self.assertEqual([c["url"] for c in calls.seen], ["http://litellm.test:4000/health/liveliness", "http://litellm.test:4000/v1/models"])
        self.assertEqual(out["auth"], "ok")

    def test_키가_거절되면_AAS_LITELLM_KEY_를_보라고_한다(self):
        calls = Calls({"http://litellm.test:4000/health/liveliness": b"ok", "http://litellm.test:4000/v1/models": 401})
        with env(AAS_K8S_NAMESPACE="ns", AAS_LITELLM_URL="http://litellm.test:4000", AAS_LITELLM_KEY="bad"), \
                mock.patch("aas.common.netcache.urlopen", calls):
            out = models.fetch_litellm(*models._resolve_key(""))
        self.assertEqual((out["auth"], out["error"]), ("rejected", "키가 거절됐습니다(AAS_LITELLM_KEY 확인, HTTP 401)"))

    def test_AI_보조는_키까지_있어야_켜진다(self):
        with env(AAS_K8S_NAMESPACE="ns", AAS_LITELLM_URL="http://litellm.test:4000"):
            self.assertFalse(tags._configured())
        with env(AAS_K8S_NAMESPACE="ns", AAS_LITELLM_URL="http://litellm.test:4000", AAS_LITELLM_KEY="k"):
            self.assertTrue(tags._configured())

    def test_컨테이너의_HERMES_LLM_API_KEY_는_키로_쓰지_않는다(self):
        with env(AAS_K8S_NAMESPACE="ns", AAS_LITELLM_URL="http://litellm.test:4000", HERMES_LLM_API_KEY="k-hermes"):
            self.assertEqual(models._resolve_key(""), ("", ""))


if __name__ == "__main__":
    unittest.main()

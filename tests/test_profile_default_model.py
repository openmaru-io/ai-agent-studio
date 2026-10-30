# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""프로파일 주 모델의 「AAS 기본 모델」(설정의 ${HERMES_LLM_MODEL}) — 고를 수 있고, 지금 이름을 화면에 알린다."""
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

TMP = tempfile.TemporaryDirectory()
os.environ.setdefault("AAS_DATA_DIR", str(Path(TMP.name) / "data"))

from aas.fleet import profiles  # noqa: E402


class DefaultModelTest(unittest.TestCase):
    def test_자리표시자는_오퍼레이터가_쓰는_글자_그대로다(self):
        self.assertEqual(profiles.DEFAULT_MODEL_REF, "${HERMES_LLM_MODEL}")

    def test_지금_기본_모델_이름은_서버_설정에서_읽는다(self):
        with mock.patch.dict(os.environ, {"HERMES_LLM_MODEL": "cogentai-aas"}):
            self.assertEqual(profiles.default_model(), "cogentai-aas")
        with mock.patch.dict(os.environ, {"HERMES_LLM_MODEL": ""}), mock.patch("aas.common.config.read_env_file", return_value={}):
            self.assertEqual(profiles.default_model(), "")

    def test_고를_수_있는_값은_대화용_모델과_AAS_기본_모델이다(self):
        choices = ["cogentai-aas", "gpt-x"]
        self.assertTrue(profiles.model_choice_ok("gpt-x", choices))
        self.assertTrue(profiles.model_choice_ok("${HERMES_LLM_MODEL}", choices))   # 기본 모델을 따르게 되돌리기
        self.assertFalse(profiles.model_choice_ok("${HERMES_LLM_API_KEY}", choices))  # 다른 자리표시자는 안 된다
        self.assertFalse(profiles.model_choice_ok("other", choices))
        self.assertFalse(profiles.model_choice_ok("", choices))


if __name__ == "__main__":
    unittest.main()

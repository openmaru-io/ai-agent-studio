# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""시작 점검 — 쿠버네티스 모드에서는 전역 Hermes 대시보드 주소를 요구하지 않고, LiteLLM 주소는 어느 모드에서든 요구한다."""
import os
import tempfile
import unittest
from pathlib import Path

TMP = tempfile.TemporaryDirectory()
os.environ.setdefault("AAS_DATA_DIR", str(Path(TMP.name) / "data"))

from aas.web import server  # noqa: E402


class StartupChecksTest(unittest.TestCase):
    def setUp(self):
        self.old = os.environ.get("AAS_K8S_NAMESPACE")

    def tearDown(self):
        if self.old is None:
            os.environ.pop("AAS_K8S_NAMESPACE", None)
        else:
            os.environ["AAS_K8S_NAMESPACE"] = self.old

    def test_single_mode_requires_dashboard_and_litellm(self):
        os.environ.pop("AAS_K8S_NAMESPACE", None)
        self.assertEqual(sorted(server._required_settings().values()), ["AAS_DASHBOARD_URL", "AAS_LITELLM_URL"])

    def test_k8s_mode_does_not_require_global_dashboard(self):
        os.environ["AAS_K8S_NAMESPACE"] = "agents"
        self.assertEqual(list(server._required_settings().values()), ["AAS_LITELLM_URL"])


if __name__ == "__main__":
    unittest.main()

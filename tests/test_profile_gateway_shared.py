# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""쿠버네티스(사이드카로 읽는 파드)의 이름 있는 프로파일은 게이트웨이를 루트 게이트웨이가 함께 돌린다(multiplex, 2026-10-14).
컨테이너 안 Hermes 는 프로파일별 「gateway start」를 하지 않는다("Service start is not applicable inside a Docker container")."""
import os
import tempfile
import unittest
from pathlib import Path

TMP = tempfile.TemporaryDirectory()
os.environ.setdefault("AAS_DATA_DIR", str(Path(TMP.name) / "data"))

from aas.fleet import profiles  # noqa: E402


class GatewaySharedTest(unittest.TestCase):
    def test_사이드카로_읽는_파드의_이름_있는_프로파일만_함께_쓴다(self):
        self.assertTrue(profiles.gateway_shared(in_k8s=True, profile="main"))
        self.assertFalse(profiles.gateway_shared(in_k8s=True, profile=None))      # 루트는 자기 게이트웨이
        self.assertFalse(profiles.gateway_shared(in_k8s=False, profile="main"))   # compose·로컬은 프로파일마다 띄운다

    def test_따로_쓰면_전처럼_프로파일에_보낸다(self):
        for op in ("start", "stop", "restart"):
            self.assertEqual(profiles.gateway_request(op, "main", shared=False), (f"/api/gateway/{op}", {"profile": "main"}))

    def test_함께_쓰면_다시_시작은_루트_게이트웨이로(self):
        self.assertEqual(profiles.gateway_request("restart", "main", shared=True), ("/api/gateway/restart", {}))

    def test_함께_쓰면_시작_멈추기는_안내와_함께_거절한다(self):
        for op in ("start", "stop"):
            with self.assertRaises(ValueError) as cm:
                profiles.gateway_request(op, "main", shared=True)
            self.assertIn("함께", str(cm.exception))

    def test_모르는_요청은_거절한다(self):
        with self.assertRaises(ValueError):
            profiles.gateway_request("kill", "main", shared=False)


if __name__ == "__main__":
    unittest.main()

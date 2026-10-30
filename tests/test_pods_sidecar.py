# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""POD 등록부가 읽기 사이드카를 가리킬 수 있다 — Pod.hermes_home 이 RemotePath 가 된다."""
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

TMP = tempfile.TemporaryDirectory()
os.environ.setdefault("AAS_DATA_DIR", str(Path(TMP.name) / "data"))

from aas.hermes import hermes_reader as hr
from aas.fleet import pods  # noqa: E402
from aas.hermes.readers import remote  # noqa: E402


def registry(entries, admins=()):
    path = Path(TMP.name) / f"reg-{len(os.listdir(TMP.name))}.json"
    path.write_text(json.dumps({"admins": list(admins), "pods": entries}), encoding="utf-8")
    return pods.Registry(path)


class PodSidecarTest(unittest.TestCase):
    def setUp(self):
        patcher = mock.patch.dict(os.environ, {}, clear=False)
        patcher.start()
        self.addCleanup(patcher.stop)
        for k in ("AAS_SIDECAR_URL", "AAS_SIDECAR_TOKEN", "AAS_T_R1"):
            os.environ.pop(k, None)

    def test_pod_with_sidecar_url_reads_remotely_and_needs_no_local_home(self):
        reg = registry([{"id": "r1", "owner": "A@X.com", "sidecar_url": "http://sc-r1:17950/",
                         "sidecar_token_env": "AAS_T_R1", "dashboard_url": "http://dash-r1:9119"}])
        self.assertEqual(reg.error, "")
        pod = reg.pods[0]
        self.assertIsInstance(pod.hermes_home, remote.RemotePath)
        self.assertEqual(pod.hermes_home.backend.url, "http://sc-r1:17950")
        self.assertEqual(pod.sidecar_url, "http://sc-r1:17950")
        self.assertEqual(pod.owner, "a@x.com")

    def test_token_is_read_when_used_not_when_registered(self):
        pod = registry([{"id": "r1", "owner": "a@x.com", "sidecar_url": "http://sc:1", "sidecar_token_env": "AAS_T_R1"}]).pods[0]
        backend = pod.hermes_home.backend
        self.assertEqual(backend._token(), "")
        os.environ["AAS_T_R1"] = "first-token-0123456789"
        self.assertEqual(backend._token(), "first-token-0123456789")
        os.environ["AAS_T_R1"] = "rotated-token-0123456789"                      # Secret 이 바뀌면 다음 호출부터 새 값
        self.assertEqual(backend._token(), "rotated-token-0123456789")

    def test_local_pods_are_unchanged(self):
        reg = registry([{"id": "l1", "owner": "a@x.com", "hermes_home": "/opt/data-l1"}])
        self.assertEqual(reg.pods[0].hermes_home, Path("/opt/data-l1"))
        self.assertEqual(reg.pods[0].sidecar_url, "")

    def test_pod_without_home_or_sidecar_is_a_registry_error(self):
        reg = registry([{"id": "bad", "owner": "a@x.com"}])
        self.assertEqual(reg.pods, [])
        self.assertIn("POD 등록부를 읽지 못했습니다", reg.error)

    def test_default_pod_uses_sidecar_when_env_is_set(self):
        os.environ["AAS_SIDECAR_URL"] = "http://hermes-sidecar:17950"
        reg = pods.Registry(Path(TMP.name) / "absent.json")
        self.assertIsInstance(reg.pods[0].hermes_home, remote.RemotePath)
        self.assertIsInstance(hr.hermes_home(), remote.RemotePath)
        del os.environ["AAS_SIDECAR_URL"]
        self.assertNotIsInstance(hr.hermes_home(), remote.RemotePath)

    def test_default_pod_owner_comes_from_env(self):
        with mock.patch.dict(os.environ, {"AAS_DEFAULT_POD_OWNER": " Admin@Example.com "}):
            reg = pods.Registry(Path(TMP.name) / "absent.json")
        self.assertEqual(reg.pods[0].owner, "admin@example.com")        # 빠른 시작: 첫 관리자가 기본 POD 의 주인(스펙 2026-10-21-015 R2)
        self.assertTrue(reg.pods[0].owned_by({"email": "admin@example.com"}))

    def test_default_pod_is_everyones_when_owner_is_unset(self):
        with mock.patch.dict(os.environ, {"AAS_DEFAULT_POD_OWNER": ""}):
            reg = pods.Registry(Path(TMP.name) / "absent.json")
        self.assertEqual(reg.pods[0].owner, "*")                         # 지금까지의 동작

    def test_same_sidecar_shares_one_backend_so_the_stat_cache_is_shared(self):
        a = registry([{"id": "r1", "owner": "a@x.com", "sidecar_url": "http://sc:1"}]).pods[0].hermes_home
        b = registry([{"id": "r1", "owner": "a@x.com", "sidecar_url": "http://sc:1"}]).pods[0].hermes_home
        self.assertIs(a.backend, b.backend)


if __name__ == "__main__":
    unittest.main()

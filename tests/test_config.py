# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""설정 한 곳(aas/common/config.py) — 운영 맥 경로·루프백 기본값이 없고, 값이 없으면 그 기능만 꺼진다."""
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from aas.common import config

KEYS = ("AAS_CONFIG_DIR", "AAS_HERMES_HOME", "AAS_DATA_DIR", "AAS_DASHBOARD_URL", "AAS_LITELLM_URL",
        "AAS_HERMES_COMPOSE_ENV", "AAS_PODS_FILE", "AAS_USERS_FILE", "AAS_CONSOLE_URL", "AAS_PUBLIC_URL")


class ConfigTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)
        patcher = mock.patch.dict(os.environ, {}, clear=False)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.addCleanup(self.tmp.cleanup)
        for k in KEYS:
            os.environ.pop(k, None)

    def test_defaults_have_no_operator_machine_values(self):
        paths = [config.config_dir(), config.env_file(), config.pods_file(), config.users_file(),
                 config.hermes_home(), config.data_dir_default()]
        for p in paths:
            text = str(p)
            self.assertNotIn("/Users/", text)
            self.assertFalse(text.startswith(str(Path.home())), text)   # 사용자 홈에 기대지 않는다
        self.assertEqual(config.config_dir(), Path("/etc/aas"))

    def test_db_host_defaults_to_shared_postgres(self):
        # 차트의 공용 PostgreSQL 이름(aas-postgres)과 같아야 한다. 옛 이름(aas-keycloak-postgres)은 OMAI-1098 에서 없앴다.
        with mock.patch.dict(os.environ, {}, clear=False):
            os.environ.pop("AAS_DB_HOST", None)
            self.assertEqual(config.db_settings()["host"], "aas-postgres")
            os.environ["AAS_DB_HOST"] = "db.example"
            self.assertEqual(config.db_settings()["host"], "db.example")

    def test_urls_default_to_empty_not_loopback(self):
        for k in ("AAS_DASHBOARD_URL", "AAS_LITELLM_URL", "AAS_CONSOLE_URL"):
            self.assertEqual(config.get(k), "", k)
        self.assertIsNone(config.compose_env_file())

    def test_environment_wins_over_env_file(self):
        os.environ["AAS_CONFIG_DIR"] = str(self.dir)
        (self.dir / "aas.env").write_text("AAS_LITELLM_URL=http://from-file\n# c\nAAS_X=\"quoted\"\n", encoding="utf-8")
        self.assertEqual(config.get("AAS_LITELLM_URL"), "http://from-file")
        self.assertEqual(config.get("AAS_X"), "quoted")
        os.environ["AAS_LITELLM_URL"] = "http://from-env"
        self.assertEqual(config.get("AAS_LITELLM_URL"), "http://from-env")

    def test_missing_env_file_gives_default(self):
        os.environ["AAS_CONFIG_DIR"] = str(self.dir / "nope")
        self.assertEqual(config.get("AAS_ANYTHING", "dflt"), "dflt")

    def test_blank_value_is_kept_apart_from_unset(self):
        os.environ["AAS_CONFIG_DIR"] = str(self.dir)
        os.environ.pop("AAS_Y", None)
        self.assertEqual(config.get_or_empty("AAS_Y", "dflt"), "dflt")              # 적지 않으면 기본값
        (self.dir / "aas.env").write_text("AAS_Y=\n", encoding="utf-8")
        self.assertEqual(config.get_or_empty("AAS_Y", "dflt"), "")                  # 환경 파일에 빈 값 = 끄기
        os.environ["AAS_Y"] = ""
        self.assertEqual(config.get_or_empty("AAS_Y", "dflt"), "")                  # 환경변수에 빈 값 = 끄기
        os.environ["AAS_Y"] = "v"
        self.assertEqual(config.get_or_empty("AAS_Y", "dflt"), "v")
        os.environ.pop("AAS_Y")

    def test_config_paths_follow_config_dir(self):
        os.environ["AAS_CONFIG_DIR"] = str(self.dir)
        self.assertEqual(config.pods_file(), self.dir / "pods.json")
        self.assertEqual(config.users_file(), self.dir / "users.json")
        os.environ["AAS_PODS_FILE"] = str(self.dir / "other.json")
        self.assertEqual(config.pods_file(), self.dir / "other.json")

    def test_missing_report_names_only_blank_settings(self):
        os.environ["AAS_DASHBOARD_URL"] = "http://dash"
        missing = config.missing({"대시보드": "AAS_DASHBOARD_URL", "LiteLLM": "AAS_LITELLM_URL"})
        self.assertEqual(missing, ["LiteLLM (AAS_LITELLM_URL)"])


class WithoutLiteLLMUrlTest(unittest.TestCase):
    """AAS_LITELLM_URL 이 없으면 모델 화면만 꺼진다. 기본 주소로 몰래 묻지 않는다."""

    def setUp(self):
        patcher = mock.patch.dict(os.environ, {}, clear=False)
        patcher.start()
        self.addCleanup(patcher.stop)
        os.environ.pop("AAS_LITELLM_URL", None)
        os.environ["AAS_CONFIG_DIR"] = "/nonexistent-aas-config"

    def test_gateway_reports_unset_url_without_network(self):
        from aas.ops import models
        with mock.patch("aas.common.netcache.urlopen") as opened:
            out = models.fetch_litellm("sk-x", "시험")
        opened.assert_not_called()
        self.assertFalse(out["reachable"])
        self.assertIn("AAS_LITELLM_URL", out["error"])

    def test_probe_reports_unset_url_without_network(self):
        from aas.ops import models
        with mock.patch("aas.common.netcache.urlopen") as opened, \
             mock.patch.object(models.hr, "profiles", return_value=[]):
            out = models.probe("m")
        opened.assert_not_called()
        self.assertFalse(out["ok"])
        self.assertIn("AAS_LITELLM_URL", out["error"])

if __name__ == "__main__":
    unittest.main()

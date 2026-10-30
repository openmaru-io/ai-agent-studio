# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""API 키·토큰 표에서 AAS 가 넣는 기본 값을 감춘다(스펙 2026-10-28-006 H1·H2·H3, 리뷰 R1·R10).

쿠버네티스(사이드카)에서는 auth.json·.env 값이 토큰으로 오므로 글자 비교가 아니라 지문으로 견준다.
그래서 파일을 직접 읽을 때와 사이드카로 읽을 때 같은 결과인지 둘 다 본다.
"""
import json
import os
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from unittest import mock

TMP = tempfile.TemporaryDirectory()
os.environ.setdefault("AAS_DATA_DIR", str(Path(TMP.name) / "data"))
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "sidecar"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from aas_sidecar import ops as sc_ops, server as sc_server  # noqa: E402

from aas.assets import inventory  # noqa: E402
from aas.hermes import stt_config  # noqa: E402
from aas.hermes.readers import remote  # noqa: E402
from aas.ops import models  # noqa: E402

TOKEN = "hidden-token-0123456789abcdef"
SERVER_KEY = "sk-aas-litellm-0123456789abcdef"
USER_KEY = "sk-user-own-0123456789abcdefgh"
REF = 'api_key: "${HERMES_LLM_API_KEY}"'


def _profile(home: Path, name: str, config: str = "", env: str = "", auth=None) -> None:
    d = home / "profiles" / name
    d.mkdir(parents=True, exist_ok=True)
    (d / "config.yaml").write_text(config or "model:\n  default: m\n", encoding="utf-8")
    if env:
        (d / ".env").write_text(env, encoding="utf-8")
    if auth is not None:
        (d / "auth.json").write_text(auth if isinstance(auth, str) else json.dumps(auth), encoding="utf-8")


def build_home(root: Path) -> Path:
    home = root / "hermes"
    home.mkdir(parents=True)
    litellm = f"providers:\n  litellm:\n    api: \"${{HERMES_LLM_BASE_URL}}\"\n    {REF}\n"
    (home / "config.yaml").write_text("model:\n  default: m\n" + litellm, encoding="utf-8")
    derived = {"version": 1, "providers": {}, "credential_pool": {"custom:litellm": [{"source": "config:litellm", "label": "litellm",
                                                                                         "auth_type": "api_key", "access_token": SERVER_KEY}]}}
    (home / "auth.json").write_text(json.dumps(derived), encoding="utf-8")                      # 루트: 설정 사본 → 감춤
    anon = {"version": 1, "providers": {"nous": {"auth_method": "anonymous", "account_tier": "anonymous", "anon_token": "anon_abcdefghijklmnop"}},
            "credential_pool": {}}
    _profile(home, "main", litellm, f"HERMES_LLM_API_KEY={SERVER_KEY}\n", anon)                  # 모두 감춤
    _profile(home, "work", f"providers:\n  own:\n    api_key: {USER_KEY}\n    base_url: https://llm.example.com/v1\n",
             f"MCP_OUTLINE_API_KEY={USER_KEY}\nHERMES_LLM_API_KEY=sk-someone-else-0123456789ab\n",
             {"version": 1, "providers": {"nous": {"auth_method": "device_code", "access_token": "real-login-0123456789"}}})
    _profile(home, "pool", litellm, "", {"credential_pool": {"openrouter": [{"source": "manual", "access_token": "manual-0123456789ab"}]}})
    _profile(home, "broken", litellm, "", "{not json")
    _profile(home, "legacy", "model: m\n", "", {"pool": [{"refresh": "pool-refresh-0123456789"}]})   # 모르는 모양 → 보임
    return home


class CredentialsHiddenTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.home = build_home(Path(cls.tmp.name))
        cls.compose_env = Path(cls.tmp.name) / "compose.env"
        cls.compose_env.write_text(f"AAS_ADMIN_PASSWORD=pw-0123456789\nAAS_SIDECAR_TOKEN=tok-0123456789abcdef\nHERMES_LLM_API_KEY={SERVER_KEY}\n",
                                   encoding="utf-8")
        cls.httpd = sc_server.make_server("127.0.0.1", 0, sc_ops.Ops(cls.home), TOKEN)
        threading.Thread(target=cls.httpd.serve_forever, daemon=True).start()
        cls.url = f"http://127.0.0.1:{cls.httpd.server_port}"

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()
        cls.tmp.cleanup()

    def setUp(self):
        for p in (mock.patch.object(models, "server_llm_key", return_value=(SERVER_KEY, "AAS_LITELLM_KEY")),
                  mock.patch.dict(os.environ, {"AAS_HERMES_COMPOSE_ENV": str(self.compose_env)})):
            p.start()
            self.addCleanup(p.stop)

    def roots(self):
        backend = remote.RemoteBackend(self.url, TOKEN, label="t")
        self.assertTrue(backend.snapshot())
        return {"files": self.home, "sidecar": remote.RemotePath(backend, "")}

    def test_기본_값은_감추고_사용자_값은_보인다(self):
        for mode, root in self.roots().items():
            with self.subTest(mode=mode):
                got = inventory._credentials(root)
                shown = {(i["profile"], i["name"]) for i in got["items"]}
                self.assertEqual(shown, {
                    ("work", "api_key"), ("work", "MCP_OUTLINE_API_KEY"), ("work", "HERMES_LLM_API_KEY"), ("work", "auth.json"),
                    ("pool", "auth.json"), ("broken", "auth.json"), ("legacy", "auth.json"),
                })
                hidden = got["hidden"]
                # 루트: 참조 api_key·설정 사본 auth.json·compose 운영 값 셋 / main: 참조·.env 의 서버 키·익명 auth.json / pool·broken: 참조
                self.assertEqual(hidden["by_profile"], {"": 5, "main": 3, "pool": 1, "broken": 1})
                self.assertEqual(hidden["count"], 10)
                self.assertEqual(hidden["kinds"], ["auth_anonymous", "auth_derived", "compose_env", "llm_default"])

    def test_감춘_값은_같은_값_묶음을_만들지_않는다(self):
        """work 의 MCP 키와 providers.own.api_key 는 같은 사용자 값이라 묶이고, 감춘 서버 키와는 묶이지 않는다."""
        for mode, root in self.roots().items():
            with self.subTest(mode=mode):
                items = inventory._credentials(root)["items"]
                groups = {i["name"]: i["shared_group"] for i in items if i["profile"] == "work"}
                self.assertIsNotNone(groups["MCP_OUTLINE_API_KEY"])
                self.assertEqual(groups["MCP_OUTLINE_API_KEY"], groups["api_key"])
                self.assertIsNone(groups["HERMES_LLM_API_KEY"])
                self.assertEqual(inventory._credentials(root)["totals"]["shared_groups"], 1)

    def test_서버_키를_모르면_env_의_키를_감추지_않는다(self):
        with mock.patch.object(models, "server_llm_key", return_value=("", "")):
            items = inventory._credentials(self.home)["items"]
        self.assertIn(("main", "HERMES_LLM_API_KEY"), {(i["profile"], i["name"]) for i in items})

    def test_참조_글자는_시드와_음성_인식_절과_같다(self):
        """같은 글자를 쓰는 곳이 여럿이라 하나만 바뀌면 감추기가 조용히 멈춘다(리뷰 9-3 #1)."""
        import yaml
        seed = Path(__file__).resolve().parents[1] / "deploy" / "compose" / "hermes-config.seed.yaml"
        self.assertEqual(yaml.safe_load(seed.read_text(encoding="utf-8"))["model"]["api_key"], inventory.AAS_LLM_KEY_REF)
        self.assertIn(f'api_key: "{inventory.AAS_LLM_KEY_REF}"', stt_config.stt_block("whisper"))
        self.assertIs(yaml.safe_load(seed.read_text(encoding="utf-8"))["nous"]["guest"], False)


if __name__ == "__main__":
    unittest.main()

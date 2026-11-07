# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""모델 화면의 「허용되지 않은 경로」와 관리자 받은편지함 blocked_route(OMAI-1857, 스펙 cogentai-aas-docs 2026-11-06-005 M2·디자인 D5·D10·D19, 재검토 H1·L2)."""
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

TMP = tempfile.TemporaryDirectory()
os.environ.setdefault("AAS_DATA_DIR", str(Path(TMP.name) / "data"))

from aas.common import store  # noqa: E402
from aas.ops import models  # noqa: E402
from aas.ops import workspace_notices as wn  # noqa: E402

GW = "http://litellm.test:4000/v1"
ENV = {"HERMES_LLM_BASE_URL": GW}


def home_with(profiles: dict[str, str]) -> Path:
    home = Path(tempfile.mkdtemp(dir=TMP.name))
    for name, cfg in profiles.items():
        d = home if name == "default" else home / "profiles" / name
        d.mkdir(parents=True, exist_ok=True)
        (d / "config.yaml").write_text(cfg, encoding="utf-8")
    return home


SAME = "model:\n  default: aas/qwen\n  provider: custom\n  base_url: http://litellm.test:4000/v1\n"
PLACEHOLDER = "model:\n  default: aas/qwen\n  provider: custom\n  base_url: ${HERMES_LLM_BASE_URL}\n"
DGX = "model:\n  default: qwen3\n  provider: custom\n  base_url: http://10.0.0.151:8000/v1\n"
NAMED = "model:\n  default: claude-x\n  provider: anthropic\n"
FALLBACK_OUT = SAME + "fallback_providers:\n  - model: gpt-x\n    provider: custom\n    base_url: https://api.example.com/v1\n"
# 오퍼레이터가 쓰는 표준 꼴(OKE·COP 운영 config.yaml 그대로): 주소는 providers.litellm.api 의 자리표시자다
OPERATOR = ("model:\n  provider: custom:litellm\n  default: ${HERMES_LLM_MODEL}\n"
            "providers:\n  litellm:\n    api: ${HERMES_LLM_BASE_URL}\n    api_key: ${HERMES_LLM_API_KEY}\n"
            "auxiliary:\n  compression:\n    provider: custom:litellm\n    model: cogentai-aas-aux\n")
# 보고자 프로파일의 옮기기 전 꼴: custom_providers 의 이름으로 DGX 를 부른다
NAMED_DGX = ("model:\n  base_url: ''\n  default: qwen_3.8_27b\n  provider: custom:dgx-direct\n"
             "custom_providers:\n  - name: dgx-direct\n    base_url: http://192.168.23.171:9100/v1/\n    model: qwen_3.8_27b\n")


class BlockedHostTest(unittest.TestCase):
    def test_judgement(self):
        with mock.patch.dict(os.environ, ENV, clear=False):
            os.environ.pop("AAS_K8S_NAMESPACE", None)
            self.assertEqual(models.blocked_host(GW), "")
            self.assertEqual(models.blocked_host("${HERMES_LLM_BASE_URL}"), "", "자리표시자는 LiteLLM")
            self.assertEqual(models.blocked_host("http://10.0.0.151:8000/v1"), "10.0.0.151:8000")
            self.assertEqual(models.blocked_host("https://api.example.com/v1"), "api.example.com:443")
            self.assertEqual(models.blocked_host("", "openrouter"), "openrouter", "주소 없는 이름 있는 제공자")
            self.assertEqual(models.blocked_host("", "custom"), "")
        with mock.patch.dict(os.environ, {"HERMES_LLM_BASE_URL": "", "AAS_LITELLM_URL": ""}, clear=False):
            self.assertEqual(models.blocked_host("http://10.0.0.151:8000/v1"), "", "LiteLLM 주소를 모르면 판정하지 않는다")

    def test_routes_per_workspace(self):
        with mock.patch.dict(os.environ, ENV, clear=False):
            os.environ.pop("AAS_K8S_NAMESPACE", None)
            home = home_with({"default": SAME, "ph": PLACEHOLDER, "dgx": DGX, "named": NAMED, "fb": FALLBACK_OUT})
            got = sorted((r["profile"], r["model"], r["role"], r["host"]) for r in models.blocked_routes(home))
        self.assertEqual(got, [("dgx", "qwen3", "primary", "10.0.0.151:8000"), ("fb", "gpt-x", "fallback", "api.example.com:443"),
                               ("named", "claude-x", "primary", "anthropic")])

    def test_named_custom_provider_resolves_address(self):
        """provider: custom:<이름> 은 providers.<이름>.api·base_url 이나 custom_providers 의 같은 이름 주소로 판정한다(2026-11-07 OKE·COP 전수 조사에서
        표준 설정 100건이 모두 막힘으로 잡혔다)."""
        with mock.patch.dict(os.environ, ENV, clear=False):
            os.environ.pop("AAS_K8S_NAMESPACE", None)
            home = home_with({"default": OPERATOR, "dgx": NAMED_DGX,
                              "lost": "model:\n  default: m\n  provider: custom:nowhere\n"})
            got = sorted((r["profile"], r["model"], r["host"]) for r in models.blocked_routes(home))
        self.assertEqual(got, [("dgx", "qwen_3.8_27b", "192.168.23.171:9100")], "표준 설정·모르는 이름은 막힘이 아니다")

    def test_collect_marks_profile_bad_and_model_row(self):
        with mock.patch.dict(os.environ, ENV, clear=False):
            os.environ.pop("AAS_K8S_NAMESPACE", None)
            home = home_with({"default": SAME, "dgx": DGX})
            gw = {"url": GW, "reachable": True, "auth": "ok", "key_source": "", "prefix": "", "models": ["aas/qwen"], "all_models": ["aas/qwen"], "hidden": 0, "error": ""}
            with mock.patch.object(models, "fetch_litellm", return_value=gw):
                out = models.collect({}, home=home)
        prof = {p["name"]: p for p in out["profiles"]}
        self.assertTrue(any(i["level"] == "bad" and "10.0.0.151:8000" in i["text"] for i in prof["dgx"]["issues"]))
        self.assertFalse(any("LiteLLM 목록에 없음" in i["text"] for i in prof["dgx"]["issues"]), "다른 주소는 「목록에 없음」으로 세지 않는다")
        self.assertEqual(prof["default"]["blocked_routes"], [])
        row = {m["id"]: m for m in out["models"]}
        self.assertTrue(row["qwen3"]["blocked_route"])
        self.assertEqual(row["qwen3"]["blocked_profiles"], [{"profile": "dgx", "host": "10.0.0.151:8000"}])
        self.assertFalse(row["aas/qwen"]["blocked_route"])
        self.assertEqual(out["totals"]["blocked_routes"], 1)


class RouteItemsTest(unittest.TestCase):
    def setUp(self):
        with store.connect() as conn:
            conn.executescript(wn.SCHEMA)
            conn.execute("DELETE FROM workspace_notice_ack")

    ROUTES = {"pod-a": [{"profile": "dgx", "model": "qwen3", "role": "primary", "host": "10.0.0.151:8000"},
                        {"profile": "dgx", "model": "qwen3-mini", "role": "fallback", "host": "10.0.0.151:8000"}]}

    def test_one_item_per_profile_host_and_ack(self):
        items = wn.route_items(self.ROUTES, "admin@x.com", label=lambda p: "A")
        self.assertEqual([(i["kind"], i["pod"], i["profile"], i["host"], i["models"], i["alias"]) for i in items],
                         [("blocked_route", "pod-a", "dgx", "10.0.0.151:8000", ["qwen3", "qwen3-mini"], "A")])
        self.assertEqual(wn.pod_of(items[0]["id"]), "pod-a")
        self.assertTrue(wn.owns(items[0]["id"]))
        wn.ack("admin@x.com", items[0]["id"])
        self.assertEqual(wn.route_items(self.ROUTES, "admin@x.com"), [])

    def test_resolved_route_clears_ack_and_comes_back(self):
        item = wn.route_items(self.ROUTES, "admin@x.com")[0]
        wn.ack("admin@x.com", item["id"])
        self.assertEqual(wn.prune_routes({"pod-b": []}), 0, "읽지 못한(멈춘) 작업공간의 확인 기록은 둔다(L2)")
        self.assertEqual(wn.route_items(self.ROUTES, "admin@x.com"), [])
        self.assertEqual(wn.prune_routes({"pod-a": []}), 1, "해소되면 확인 기록을 지운다(H1)")
        self.assertEqual(len(wn.route_items(self.ROUTES, "admin@x.com")), 1, "다시 생기면 다시 알린다")


if __name__ == "__main__":
    unittest.main()

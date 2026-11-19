# Copyright 2026 The OPENMARU Authors.
"""카탈로그 항목에 딸린 Hermes 플러그인(OMAI-1850): 부동산 질문 안내와 설치·삭제."""
import importlib.util
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from aas.hermes.hermes_api import HermesError  # noqa: E402
from aas.ops import catalog_plugins, mcp_servers  # noqa: E402

NAME = "cogentai-reb-route"


def _plugin():
    spec = importlib.util.spec_from_file_location("reb_route", catalog_plugins.PLUGINS_DIR / NAME / "__init__.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


class FakeAPI:
    def __init__(self, enabled=None, missing_dir=False):
        self.enabled = list(enabled or [])
        self.files, self.calls, self.missing_dir = {}, [], missing_dir

    def call(self, method, path, body=None, query=None, timeout=30):
        self.calls.append((method, path))
        if (method, path) == ("GET", "/api/config"):
            return {"plugins": {"enabled": list(self.enabled)}} if self.enabled else {}
        if (method, path) == ("PUT", "/api/config"):
            self.enabled = body["config"]["plugins"]["enabled"]
            return {"ok": True}
        if (method, path) == ("POST", "/api/fs/write-text"):
            self.files[body["path"]] = body["content"]
            return {"ok": True, "path": body["path"]}
        if (method, path) == ("DELETE", "/api/files") and self.missing_dir:
            raise HermesError("Path not found", 404)
        return {"ok": True}


class RebRouteNoteTest(unittest.TestCase):
    def test_real_estate_questions_get_the_note(self):
        p = _plugin()
        for q in ("청약 넣으면 될까?", "우리 동네는 괜찮아?", "2025년 시도별 경쟁률", "집값 어때?"):
            out = p.on_pre_llm_call(user_message=q, session_id="s")
            self.assertIn("ask_subscription_statistics", out["context"], q)
            self.assertIn("그대로 넘긴다", out["context"])                   # 11-5: 긴 질문을 요약해 넘겼다

    def test_other_messages_get_nothing(self):
        p = _plugin()
        for q in ("도와줘", "뭘 물어볼 수 있어?", None, {"text": "청약"}):
            self.assertIsNone(p.on_pre_llm_call(user_message=q))

    def test_register_uses_pre_llm_call_and_pre_tool_call(self):
        hooks = []
        _plugin().register(type("Ctx", (), {"register_hook": lambda self, n, cb: hooks.append(n)})())
        self.assertEqual(hooks, ["pre_llm_call", "pre_tool_call"])

    def test_clarify_keeps_only_questions_with_choices(self):
        # OKE C10: 후보 질문 뒤에 선택지 없는 질문을 덧붙여 카드가 두 번째 답을 기다리며 멈췄다
        p = _plugin()
        args = {"questions": [{"question": "이런 질문인가요?", "choices": ["2025년 전국 공급세대수", "2025년 미달 주택형 수"]},
                              {"question": "그 외에 구체적으로 알고 싶으신 정보가 있다면 말씀해 주세요."}]}
        out = p.on_pre_tool_call(tool_name="clarify", args=args)
        self.assertEqual(out["action"], "modify")
        self.assertEqual([q["question"] for q in out["args"]["questions"]], ["이런 질문인가요?"])
        self.assertEqual(len(args["questions"]), 2)                                     # 원래 인자는 그대로
        self.assertIsNone(p.on_pre_tool_call(tool_name="clarify", args={"questions": [{"question": "무엇을 볼까요?"}]}))
        self.assertIsNone(p.on_pre_tool_call(tool_name="clarify", args={"questions": [{"question": "a"}, {"question": "b"}]}))
        self.assertIsNone(p.on_pre_tool_call(tool_name="terminal", args=args))


class CatalogPluginTest(unittest.TestCase):
    def test_reb_entry_carries_the_plugin(self):
        self.assertEqual(mcp_servers.COGENTAI_REB.plugin, NAME)
        self.assertEqual(mcp_servers.COGENTAI.plugin, "")

    def test_install_writes_files_and_appends_to_enabled(self):
        api = FakeAPI(enabled=["other"])
        self.assertEqual(catalog_plugins.install(api, "main", "/opt/data/profiles/main", NAME), {"ok": True})
        base = f"/opt/data/profiles/main/plugins/{NAME}"
        self.assertEqual(sorted(api.files), [f"{base}/__init__.py", f"{base}/plugin.yaml"])
        self.assertIn(("POST", "/api/files/mkdir"), api.calls)
        self.assertEqual(api.enabled, ["other", NAME])
        catalog_plugins.install(api, "main", "/opt/data/profiles/main", NAME)   # 다시 넣어도 하나
        self.assertEqual(api.enabled, ["other", NAME])

    def test_remove_disables_and_deletes_and_keeps_others(self):
        api = FakeAPI(enabled=["other", NAME])
        self.assertEqual(catalog_plugins.remove(api, "main", "/opt/data/profiles/main", NAME), {"ok": True})
        self.assertEqual(api.enabled, ["other"])
        self.assertIn(("DELETE", "/api/files"), api.calls)
        self.assertEqual(catalog_plugins.remove(FakeAPI(missing_dir=True), "main", "/p", NAME), {"ok": True})

    def test_failure_is_reported_not_raised(self):
        class Broken(FakeAPI):
            def call(self, method, path, body=None, query=None, timeout=30):
                raise HermesError("down", 503)
        self.assertFalse(catalog_plugins.install(Broken(), "main", "/p", NAME)["ok"])
        self.assertFalse(catalog_plugins.remove(Broken(), "main", "/p", NAME)["ok"])


if __name__ == "__main__":
    unittest.main()

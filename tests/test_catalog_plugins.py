# Copyright 2026 The OPENMARU Authors.
"""카탈로그 항목에 딸린 Hermes 플러그인(OMAI-1850)을 프로파일에 넣고 뺀다."""
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from aas.hermes.hermes_api import HermesError  # noqa: E402
from aas.ops import catalog_plugins, mcp_servers  # noqa: E402

NAME = "demo-route"


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


class CatalogPluginTest(unittest.TestCase):
    def setUp(self):
        # 플러그인이 딸린 항목은 고객사 판뿐이라(사내 전용) 임시 폴더의 가짜 플러그인으로 넣고 빼기를 본다(스펙 2026-11-21-001)
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        for f, body in (("plugin.yaml", "name: demo-route\n"), ("__init__.py", "def register(ctx):\n    pass\n")):
            (Path(self.tmp.name) / NAME).mkdir(exist_ok=True)
            (Path(self.tmp.name) / NAME / f).write_text(body, encoding="utf-8")
        patcher = mock.patch.object(catalog_plugins, "PLUGINS_DIR", Path(self.tmp.name))
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_general_entries_carry_no_plugin(self):
        self.assertEqual(mcp_servers.COGENTAI.plugin, "")
        self.assertEqual(mcp_servers.COGENTAI_CHART.plugin, "")

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

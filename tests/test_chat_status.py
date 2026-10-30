# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""/api/chat/status 의 본문(_chat_status) 시험 — 에이전트 파드가 다시 뜨는 동안에도 500 을 내지 않는다(OMAI-1101 §10-5)."""
import os
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

TMP = tempfile.TemporaryDirectory()
os.environ.setdefault("AAS_DATA_DIR", str(Path(TMP.name) / "data"))     # _chat_status 가 주 프로파일 기록(DB)을 읽는다

from aas.hermes.readers.remote import SidecarError  # noqa: E402
from aas.web import server  # noqa: E402


class FakeHub:
    def status(self):
        return {"configured": True, "connected": False, "error": "", "sessions": []}


POD = SimpleNamespace(id="p1", hermes_home=None)


class ChatStatusTest(unittest.TestCase):
    def test_sidecar_down_returns_status_without_profiles_instead_of_500(self):
        def down(_home):
            raise SidecarError("사이드카에 연결할 수 없습니다 (p1): URLError")
        with mock.patch.object(server, "hub", return_value=FakeHub()), \
                mock.patch.object(server.cron_health.hr, "profiles", side_effect=down):
            out = server._chat_status(POD)
        self.assertEqual(out["profiles"], [])
        self.assertEqual(out["agents"], [])
        self.assertFalse(out["connected"])
        self.assertIn("사이드카", out["error"])          # 화면이 이유를 보인다

    def test_hub_error_is_kept_when_sidecar_is_down(self):
        class Hub(FakeHub):
            def status(self):
                return {**super().status(), "error": "연결이 끊겼습니다: ConnectionClosedError"}
        with mock.patch.object(server, "hub", return_value=Hub()), \
                mock.patch.object(server.cron_health.hr, "profiles", side_effect=SidecarError("x")):
            out = server._chat_status(POD)
        self.assertEqual(out["error"], "연결이 끊겼습니다: ConnectionClosedError")

    def test_normal_status_lists_profiles_and_agents(self):
        profs = [SimpleNamespace(name="default"), SimpleNamespace(name="ma")]
        with mock.patch.object(server, "hub", return_value=FakeHub()), \
                mock.patch.object(server.cron_health.hr, "profiles", return_value=profs), \
                mock.patch.object(server, "_agents", return_value=[{"name": "default"}]):
            out = server._chat_status(POD)
        self.assertEqual(out["profiles"], ["default", "ma"])
        self.assertEqual(out["agents"], [{"name": "default"}])
        self.assertEqual(out["error"], "")

    def test_status_names_the_primary_profile_so_the_screen_can_replace_a_hidden_root(self):
        """루트 default 가 숨겨진 POD 에서 화면이 default 로 대화를 열면 서버가 「없는 프로파일」로 거절한다(2026-10-15) — 화면이 바꿀 수 있게 주 에이전트를 준다."""
        profs = [SimpleNamespace(name="main")]
        with mock.patch.object(server, "hub", return_value=FakeHub()), \
                mock.patch.object(server.cron_health.hr, "profiles", return_value=profs), \
                mock.patch.object(server, "_agents", return_value=[{"name": "main"}]), \
                mock.patch.object(server.primary, "primary_of", return_value="main"):
            out = server._chat_status(POD)
        self.assertEqual(out["primary"], "main")
        with mock.patch.object(server, "hub", return_value=FakeHub()), \
                mock.patch.object(server.cron_health.hr, "profiles", side_effect=SidecarError("x")), \
                mock.patch.object(server.primary, "primary_of", return_value="main"):
            self.assertEqual(server._chat_status(POD)["primary"], "main")        # 사이드카가 내려가 있어도

    def test_status_gives_the_chat_default_profile_and_falls_back_when_it_is_gone(self):
        """2026-10-19-001 R3: 채팅이 먼저 여는 프로파일. 저장한 이름이 목록에 없으면 주 프로파일로 돌아간다."""
        from aas.fleet import chat_default
        from aas.common import store
        with store.connect() as conn:
            conn.execute(chat_default.SCHEMA)
            conn.execute("DELETE FROM pod_default_profile")
        chat_default.save("p1", "ops", "kim@x.com")
        for names, want in ((["main", "ops"], "ops"), (["main"], "main")):
            with mock.patch.object(server, "hub", return_value=FakeHub()), \
                    mock.patch.object(server.cron_health.hr, "profiles", return_value=[SimpleNamespace(name=n) for n in names]), \
                    mock.patch.object(server, "_agents", return_value=[]), \
                    mock.patch.object(server.primary, "primary_of", return_value="main"):
                self.assertEqual(server._chat_status(POD)["chat_default"], want, names)


if __name__ == "__main__":
    unittest.main()

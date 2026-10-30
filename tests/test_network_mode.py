# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""외부 접속 가능 여부 판정(aas/ops/network_mode.py)을 시험한다(스펙 2026-10-16-010 4-7, 11-2 V2, 9절 Q6·Q8, OMAI-1263).

- 판정은 설정(AAS_NETWORK_MODE·AAS_EGRESS_ALLOW)과 주소만으로 한다. AAS 서버는 사용자가 넣은 주소로 요청하지 않는다(DNS 조회 포함, 10-2 R8).
- 기본 모드는 online 이다(Q6, 2026-10-16 사용자 답).
- 사내 주소는 허용 목록, 사설·루프백 IP, 클러스터 주소(*.svc·*.svc.cluster.local·점 없는 이름)다. 도메인 이름으로 짐작하지 않는다(Q8).
- 링크 로컬(169.254.0.0/16·fe80::/10, 클라우드 메타데이터 주소)은 어느 모드에서도 쓸 수 없다.
"""
import os
import socket
import tempfile
import unittest
from pathlib import Path
from unittest import mock

TMP = tempfile.TemporaryDirectory()
os.environ.setdefault("AAS_DATA_DIR", str(Path(TMP.name) / "data"))

from aas.common import i18n  # noqa: E402
from aas.ops import network_mode  # noqa: E402


def _no_network(*_a, **_k):
    raise AssertionError("판정이 네트워크를 썼다")


class NetworkModeTest(unittest.TestCase):
    def setUp(self):
        i18n.set_lang("ko")
        self._env = mock.patch.dict(os.environ, {}, clear=False)
        self._env.start()
        for key in ("AAS_NETWORK_MODE", "AAS_EGRESS_ALLOW"):
            os.environ.pop(key, None)
        self._dns = mock.patch.object(socket, "getaddrinfo", _no_network)
        self._conn = mock.patch.object(socket, "create_connection", _no_network)
        self._dns.start()
        self._conn.start()

    def tearDown(self):
        self._conn.stop()
        self._dns.stop()
        self._env.stop()

    def check(self, url, mode=None, allow=None):
        if mode is not None:
            os.environ["AAS_NETWORK_MODE"] = mode
        if allow is not None:
            os.environ["AAS_EGRESS_ALLOW"] = allow
        return network_mode.check(url)

    def test_default_mode_is_online(self):
        self.assertEqual(network_mode.mode(), "online")
        os.environ["AAS_NETWORK_MODE"] = "AIRGAP "
        self.assertEqual(network_mode.mode(), "airgap")                     # 대소문자·공백은 다듬는다
        os.environ["AAS_NETWORK_MODE"] = "sometimes"
        self.assertEqual(network_mode.mode(), "online")                     # 모르는 값은 기본값과 같다

    def test_verdict_table(self):
        rows = [
            # (모드, 허용 목록, 주소, 판정)
            ("online", "", "https://mcp.notion.com/mcp", "external"),
            ("online", "", "http://10.0.0.5:8080/mcp", "internal"),
            ("online", "", "http://mcp-jira.tools.svc:8080/mcp", "internal"),
            ("online", "", "http://mcp-jira.tools.svc.cluster.local/mcp", "internal"),
            ("online", "", "http://mcp-jira/mcp", "internal"),
            ("online", "", "http://127.0.0.1:9000/mcp", "internal"),
            ("online", "", "http://[fd00::1]/mcp", "internal"),
            ("restricted", "", "https://mcp.notion.com/mcp", "blocked"),
            ("restricted", "*.notion.com, github.com", "https://mcp.notion.com/mcp", "internal"),
            ("restricted", "*.notion.com", "https://notion.com/mcp", "blocked"),     # *.x 는 x 자신과 같지 않다
            ("restricted", "github.com", "https://GitHub.com/mcp", "internal"),       # 호스트 이름은 대소문자를 가리지 않는다
            ("restricted", "", "http://192.168.1.20/mcp", "internal"),
            ("airgap", "", "https://mcp.notion.com/mcp", "blocked"),
            ("airgap", "", "https://mcp.corp.example.com/mcp", "blocked"),           # 도메인 이름으로 짐작하지 않는다(Q8)
            ("airgap", "*.corp.example.com", "https://mcp.corp.example.com/mcp", "internal"),
            ("airgap", "", "http://mcp-jira.tools.svc:8080/mcp", "internal"),
        ]
        for mode, allow, url, want in rows:
            with self.subTest(mode=mode, allow=allow, url=url):
                self.assertEqual(self.check(url, mode, allow)["verdict"], want)

    def test_metadata_address_is_blocked_in_every_mode(self):
        for mode in ("online", "restricted", "airgap"):
            for url in ("http://169.254.169.254/latest/meta-data/", "http://[fe80::1]/x"):
                with self.subTest(mode=mode, url=url):
                    got = self.check(url, mode, "*")
                    self.assertEqual(got["verdict"], "blocked")
                    self.assertEqual(got["reason"], "link_local")

    def test_blocked_reason_names_the_mode(self):
        got = self.check("https://mcp.notion.com/mcp", "airgap")
        self.assertEqual(got["reason"], "airgap")
        self.assertIn("에어갭", got["message"])
        got = self.check("https://mcp.notion.com/mcp", "restricted")
        self.assertEqual(got["reason"], "not_allowed")
        self.assertIn("허용 목록", got["message"])

    def test_messages_match_the_add_dialog_labels(self):
        # 추가하기 전의 표시 세 가지(11-2 V2). 「사용 가능」은 추가한 뒤에만 쓴다
        self.assertEqual(self.check("http://10.0.0.5/mcp", "online")["message"], "사내 주소 · 추가 뒤 확인")
        self.assertEqual(self.check("https://mcp.notion.com/mcp", "online")["message"], "외부 주소 · 추가 뒤 확인")
        self.assertTrue(self.check("https://mcp.notion.com/mcp", "airgap")["message"].startswith("이 환경에서 쓸 수 없음"))

    def test_invalid_or_non_http_address(self):
        for url in ("", "mcp.notion.com", "ftp://h/x", "https://"):
            with self.subTest(url=url):
                self.assertEqual(self.check(url, "online")["verdict"], "invalid")


if __name__ == "__main__":
    unittest.main()

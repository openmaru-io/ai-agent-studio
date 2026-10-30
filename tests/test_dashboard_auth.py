# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""대시보드 티켓 발급(DashboardAuth.ticket) 시험. 에이전트 파드가 다시 뜨는 동안 연결이 거부되면(OKE 2026-10-15 17:32)
바로 실패하지 않고 몇 번 더 시도하며, 끝내 실패하면 원인과 안내를 담은 문장을 낸다."""
import os
import tempfile
import unittest
import urllib.error
from pathlib import Path

TMP = tempfile.TemporaryDirectory()
os.environ.setdefault("AAS_DATA_DIR", str(Path(TMP.name) / "data"))

from aas.hermes.hermes_chat import ChatUnavailable, DashboardAuth  # noqa: E402

SETTINGS = {"url": "http://agent:9119", "user": "u", "password": "SECRET-PW", "provider": "basic"}
REFUSED = urllib.error.URLError(ConnectionRefusedError(111, "Connection refused"))


class Auth(DashboardAuth):
    """_post 를 순서대로 준비한 결과(예외면 던지고 값이면 돌려준다)로 바꾼 시험용 인증."""

    def __init__(self, results, **kw):
        self.sleeps: list[float] = []
        super().__init__(SETTINGS, sleep=self.sleeps.append, **kw)
        self.results = list(results)
        self.calls: list[str] = []

    def _post(self, path, body=None):
        self.calls.append(path)
        r = self.results.pop(0)
        if isinstance(r, Exception):
            raise r
        return r


class TicketTest(unittest.TestCase):
    def test_연결이_거부되었다가_돌아오면_다시_시도해_티켓을_받는다(self):
        a = Auth([{}, REFUSED, REFUSED, {"ticket": "t1"}])      # 로그인 → 거부 2번 → 성공
        self.assertEqual(a.ticket(), "t1")
        self.assertEqual(a.sleeps, [2, 4])
        self.assertEqual(a.calls.count("/auth/password-login"), 1)   # 연결 오류에는 다시 로그인하지 않는다

    def test_끝내_실패하면_원인과_안내를_담고_비밀번호는_담지_않는다(self):
        a = Auth([{}, REFUSED, REFUSED, REFUSED])
        with self.assertRaises(ChatUnavailable) as cm:
            a.ticket()
        msg = str(cm.exception)
        self.assertIn("ConnectionRefusedError: Connection refused", msg)   # 예외 종류 이름만으로는 원인을 알 수 없었다
        self.assertIn("다시 시작", msg)
        self.assertNotIn("URLError", msg)
        self.assertNotIn("SECRET-PW", msg)
        self.assertNotIn("agent:9119", msg)
        self.assertEqual(a.sleeps, [2, 4])                                  # 시도는 세 번이다

    def test_세션_만료는_한_번_다시_로그인한다_옛_동작_유지(self):
        expired = urllib.error.HTTPError("http://agent/api/auth/ws-ticket", 401, "x", {}, None)
        a = Auth([{}, expired, {}, {"ticket": "t2"}])
        self.assertEqual(a.ticket(), "t2")
        self.assertEqual(a.calls, ["/auth/password-login", "/api/auth/ws-ticket", "/auth/password-login", "/api/auth/ws-ticket"])
        self.assertEqual(a.sleeps, [])

    def test_HTTP_오류는_다시_시도하지_않고_코드를_알린다(self):
        err = urllib.error.HTTPError("http://agent/api/auth/ws-ticket", 500, "x", {}, None)
        a = Auth([{}, err])
        with self.assertRaises(ChatUnavailable) as cm:
            a.ticket()
        self.assertIn("HTTP 500", str(cm.exception))
        self.assertEqual(a.sleeps, [])

    def test_시간_초과도_원인_이름을_알린다(self):
        a = Auth([{}, urllib.error.URLError(TimeoutError("timed out"))] + [urllib.error.URLError(TimeoutError("timed out"))] * 2)
        with self.assertRaises(ChatUnavailable) as cm:
            a.ticket()
        self.assertIn("TimeoutError", str(cm.exception))


if __name__ == "__main__":
    unittest.main()

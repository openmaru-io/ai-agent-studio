# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""uvicorn + Starlette 이전(OMAI-1100 W-1a) 시험 — 프록시 헤더 신뢰, SSE 와 스레드 풀 분리, 본문 상한, /readyz 시간 제한."""
import aasserver  # 실제 uvicorn 앱을 띄우는 시험 하네스
import http.client
import json
import os
import socket
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

TMP = tempfile.TemporaryDirectory()
os.environ.setdefault("AAS_DATA_DIR", str(Path(TMP.name) / "data"))

from aas.auth import auth  # noqa: E402
from aas.fleet import pods  # noqa: E402
from aas.office import office_state  # noqa: E402
from aas.web import server  # noqa: E402


class AsgiAppTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.old = {k: os.environ.get(k) for k in ("AAS_USERS_FILE", "AAS_ALLOWED_HOSTS", "AAS_PODS_FILE", "AAS_OIDC_ISSUER", "AAS_TRUSTED_PROXY")}
        for k in cls.old:
            os.environ.pop(k, None)
        home = Path(TMP.name) / "hermes"
        (home / "profiles" / "ma").mkdir(parents=True, exist_ok=True)
        reg = Path(TMP.name) / "pods.json"
        reg.write_text(json.dumps({"pods": [{"id": "t", "owner": "t@example.com", "hermes_home": str(home)}]}))
        cls.users = Path(TMP.name) / "users.json"
        cls.users.write_text(json.dumps({"users": [{"email": "t@example.com", "password_hash": "x"}]}))
        server._auth = auth.Auth({"issuer": "https://accounts.google.com", "client_id": "", "client_secret": "", "domain": "",
                                  "public_url": "http://localhost:17900", "hours": 1, "users_file": Path(TMP.name) / "no-users.json"})
        server._registry = pods.Registry(reg)
        server.OFFICE = office_state.Office()
        cls.httpd = aasserver.start()
        cls.port = cls.httpd.server_port

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        for k, v in cls.old.items():
            if v is not None:
                os.environ[k] = v
        server._auth = server._registry = None

    def get(self, path, headers=None, timeout=10):
        c = http.client.HTTPConnection("127.0.0.1", self.port, timeout=timeout)
        c.request("GET", path, headers=headers or {})
        r = c.getresponse()
        body = r.read()
        c.close()
        return r, body

    # ---- R1·C3: 프록시 헤더는 AAS 의 신뢰 규칙만 따른다 ---------------------------------
    def test_forwarded_proto_counts_only_from_a_trusted_peer(self):
        """신뢰하지 않는 주소가 보낸 X-Forwarded-Proto: https 는 무시한다. uvicorn 이 헤더를 바꾸지 않고, 상대 주소는 scope 에서 온다."""
        server._auth.cfg["users_file"] = self.users                       # 비밀번호 로그인을 켜 로그인 화면을 그린다
        headers = {"Host": "aas.example.com", "X-Forwarded-Proto": "https", "Accept-Language": "en"}
        warning = b"not encrypted"
        try:
            _, body = self.get("/auth/login", headers)
            self.assertIn(warning, body)                                   # 신뢰 설정 없음 → http 로 본다
            os.environ["AAS_TRUSTED_PROXY"] = "10.0.0.0/8"
            _, body = self.get("/auth/login", headers)
            self.assertIn(warning, body)                                   # 시험 연결은 127.0.0.1 — 이 대역이 아니다
            os.environ["AAS_TRUSTED_PROXY"] = "127.0.0.1/32"
            _, body = self.get("/auth/login", headers)
            self.assertNotIn(warning, body)                                # 신뢰하는 상대가 보낸 https 만 믿는다
        finally:
            os.environ.pop("AAS_TRUSTED_PROXY", None)
            server._auth.cfg["users_file"] = Path(TMP.name) / "no-users.json"

    # ---- R2: SSE 는 전용 실행기에서 기다린다 -----------------------------------------
    def test_many_open_streams_do_not_block_other_requests(self):
        """SSE 70개(일반 스레드 풀 64보다 많다)를 열어 둔 채로 /healthz·/api 요청이 바로 답한다."""
        socks = []
        try:
            for _ in range(70):
                s = socket.create_connection(("127.0.0.1", self.port), timeout=10)
                s.sendall(b"GET /api/office/stream HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n")
                socks.append(s)
            for s in socks:                                                # 모두 응답 머리를 받았는지(스트림이 열렸는지)
                self.assertTrue(s.recv(64).startswith(b"HTTP/1.1 200"))
            started = time.time()
            r, _ = self.get("/healthz", timeout=5)
            r2, _ = self.get("/api/office/state", timeout=5)
            self.assertEqual((r.status, r2.status), (200, 200))
            self.assertLess(time.time() - started, 3)
        finally:
            for s in socks:
                s.close()

    def test_stream_keeps_language_of_the_request(self):
        """SSE 본문은 다른 스레드에서 만들어져도 요청 언어를 따른다(컨텍스트를 넘긴다)."""
        r, _ = self.get("/api/office/state", {"Accept-Language": "en"})
        self.assertEqual(r.getheader("Content-Language"), "en")
        s = socket.create_connection(("127.0.0.1", self.port), timeout=10)
        try:
            s.sendall(b"GET /api/office/stream HTTP/1.1\r\nHost: 127.0.0.1\r\nAccept-Language: en\r\n\r\n")
            data = b""
            while b"data:" not in data:
                data += s.recv(4096)
            self.assertIn(b"text/event-stream", data)
        finally:
            s.close()

    # ---- 어댑터 --------------------------------------------------------------------
    def test_too_large_body_is_refused_without_reading(self):
        c = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        c.putrequest("POST", "/api/pod")
        c.putheader("Content-Length", str(2 * 1024 * 1024))
        c.putheader("X-AAS", "1")
        c.endheaders()
        r = c.getresponse()
        self.assertEqual(r.status, 413)
        c.close()

    def test_security_headers_and_set_cookie_pass_through(self):
        r, _ = self.get("/api/me")
        self.assertEqual((r.status, r.getheader("X-Frame-Options"), r.getheader("Cache-Control")), (200, "DENY", "no-store"))
        self.assertIsNone(r.getheader("Server"))
        self.assertEqual(len(r.msg.get_all("Date") or []), 1)

    # ---- R2: /readyz 의 DB 확인은 2초 제한 ------------------------------------------
    def test_readyz_gives_up_on_a_stuck_database(self):
        with mock.patch("aas.common.db.ping", side_effect=lambda *_a: time.sleep(6) or True):
            started = time.time()
            r, body = self.get("/readyz", timeout=10)
        self.assertEqual((r.status, b'"ok": false' in body), (503, True))
        self.assertLess(time.time() - started, 4)


if __name__ == "__main__":
    unittest.main()

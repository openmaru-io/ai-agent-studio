# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""이름 조회 결과 다시 쓰기(OMAI-1108) — LiteLLM 을 부를 때마다 DNS 를 새로 묻다 패킷 하나가 사라지면 glibc 가 5초를 기다렸다."""
import http.server
import socket
import threading
import time
import unittest
import urllib.error
import urllib.request
from unittest import mock

from aas.common import netcache


class _Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):  # noqa: N802
        code = 404 if self.path == "/missing" else 200
        body = b'{"ok": true}'
        self.send_response(code)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass


class NetcacheTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.httpd = http.server.ThreadingHTTPServer(("127.0.0.1", 0), _Handler)
        threading.Thread(target=cls.httpd.serve_forever, daemon=True).start()
        cls.port = cls.httpd.server_port
        cls.url = f"http://localhost:{cls.port}"

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()

    def setUp(self):
        netcache.clear()

    def count_lookups(self, delay: float = 0.0):
        real, seen = socket.getaddrinfo, []

        def counted(host, *a, **k):
            seen.append(host)
            time.sleep(delay)
            return [r for r in real(host, *a, **k) if r[0] == socket.AF_INET]   # 시험 서버는 IPv4 에만 있다
        return mock.patch.object(netcache.socket, "getaddrinfo", counted), seen

    def get(self, path="/x"):
        with netcache.urlopen(urllib.request.Request(self.url + path), timeout=5) as resp:
            return resp.read()

    def test_second_call_does_not_ask_dns_again(self):
        patch, seen = self.count_lookups()
        with patch:
            self.assertEqual(self.get(), b'{"ok": true}')
            self.get()
        self.assertEqual(seen, ["localhost"])

    def test_expired_address_is_used_at_once_and_refreshed_behind(self):
        patch, seen = self.count_lookups(delay=1.0)
        with patch:
            self.get()                                                   # 처음 보는 호스트는 그 자리에서 조회한다
            netcache._cache[("localhost", self.port)].taken -= netcache.TTL + 1
            t = time.monotonic()
            self.get()
            self.assertLess(time.monotonic() - t, 0.5)                    # 조회(1초)를 기다리지 않는다
            for _ in range(40):
                if len(seen) == 2 and not netcache._refreshing:
                    break
                time.sleep(0.05)
        self.assertEqual(len(seen), 2)
        self.assertLess(time.monotonic() - netcache._cache[("localhost", self.port)].taken, netcache.TTL)

    def test_stale_address_that_fails_is_dropped_and_looked_up_again(self):
        with socket.socket() as s:                                       # 아무도 듣지 않는 포트
            s.bind(("127.0.0.1", 0))
            dead = s.getsockname()[1]
        patch, seen = self.count_lookups()
        with patch:
            netcache._cache[("localhost", self.port)] = netcache._Entry(
                [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("127.0.0.1", dead))], time.monotonic())
            self.assertEqual(self.get(), b'{"ok": true}')
        self.assertEqual(seen, ["localhost"])

    def test_ip_address_is_not_cached(self):
        patch, _ = self.count_lookups()
        with patch, netcache.urlopen(f"http://127.0.0.1:{self.port}/x", timeout=5) as resp:
            resp.read()
        self.assertNotIn(("127.0.0.1", self.port), netcache._cache)

    def test_http_errors_are_raised_like_urlopen(self):
        with self.assertRaises(urllib.error.HTTPError) as ctx:
            self.get("/missing")
        self.assertEqual(ctx.exception.code, 404)
        ctx.exception.close()

    def test_unknown_host_fails_like_urlopen(self):
        with mock.patch.object(netcache.socket, "getaddrinfo", side_effect=socket.gaierror("no such host")):
            with self.assertRaises(urllib.error.URLError):
                netcache.urlopen("http://nowhere.invalid/x", timeout=1)


if __name__ == "__main__":
    unittest.main()

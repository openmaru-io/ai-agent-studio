# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""M2-10 / R1: Ingress 가 TLS 를 끝낼 때 서버의 https 판단(_secure_request).
AAS_TRUSTED_PROXY 가 켜진 경우에만 X-Forwarded-Proto/Host 를 믿는다. 값은 true(모든 연결) 또는 신뢰할 프록시의 CIDR 목록."""
import os
import ssl
import tempfile
import unittest
from pathlib import Path
from unittest import mock

TMP = tempfile.TemporaryDirectory()
os.environ["AAS_DATA_DIR"] = str(Path(TMP.name) / "data")

from aas.web import server  # noqa: E402


class Fake:
    """Handler 의 _secure_request·_effective_host 만 부르기 위한 최소 객체."""

    def __init__(self, headers, peer="10.0.0.9", tls=False):
        self.headers = {k: v for k, v in headers.items()}
        self.client_address = (peer, 40000)
        self.connection = mock.Mock(spec=ssl.SSLSocket) if tls else object()

    def get(self, name, default=""):
        return self.headers.get(name, default)

    _tls = server.Handler._tls
    _trusts_proxy = server.Handler._trusts_proxy
    _secure_request = server.Handler._secure_request
    _effective_host = server.Handler._effective_host
    _is_local_host = server.Handler._is_local_host
    _secrets_ok = server.Handler._secrets_ok


class H(dict):
    def get(self, k, d=""):
        return super().get(k, d)


def handler(headers, **kw):
    f = Fake({}, **kw)
    f.headers = H(headers)
    return f


class SecureRequestTest(unittest.TestCase):
    def setUp(self):
        os.environ.pop("AAS_TRUSTED_PROXY", None)

    def tearDown(self):
        os.environ.pop("AAS_TRUSTED_PROXY", None)

    def test_신뢰가_꺼져_있으면_헤더가_있어도_http(self):
        self.assertFalse(handler({"Host": "aas.example.com", "X-Forwarded-Proto": "https"})._secure_request())

    def test_신뢰가_켜지고_헤더가_https_이면_https(self):
        os.environ["AAS_TRUSTED_PROXY"] = "true"
        self.assertTrue(handler({"Host": "aas.example.com", "X-Forwarded-Proto": "https"})._secure_request())

    def test_신뢰가_켜져도_헤더가_없거나_http_이면_http(self):
        os.environ["AAS_TRUSTED_PROXY"] = "true"
        self.assertFalse(handler({"Host": "aas.example.com"})._secure_request())
        self.assertFalse(handler({"Host": "aas.example.com", "X-Forwarded-Proto": "http"})._secure_request())

    def test_프록시_여러_단이_보낸_목록은_맨_앞_값을_본다(self):
        os.environ["AAS_TRUSTED_PROXY"] = "true"
        self.assertTrue(handler({"X-Forwarded-Proto": "https, http"})._secure_request())
        self.assertFalse(handler({"X-Forwarded-Proto": "http, https"})._secure_request())
        self.assertFalse(handler({"X-Forwarded-Proto": "HTTPS-ish"})._secure_request())

    def test_자기_소켓이_TLS_이면_설정과_무관하게_https(self):
        self.assertTrue(handler({"Host": "x"}, tls=True)._secure_request())

    def test_CIDR_로_정하면_그_프록시에서_온_연결만_믿는다(self):
        os.environ["AAS_TRUSTED_PROXY"] = "10.1.0.0/16, 192.168.5.7/32"
        hdr = {"X-Forwarded-Proto": "https"}
        self.assertTrue(handler(hdr, peer="10.1.2.3")._secure_request())
        self.assertTrue(handler(hdr, peer="192.168.5.7")._secure_request())
        self.assertFalse(handler(hdr, peer="10.2.0.1")._secure_request())        # 프록시를 거치지 않고 직접 닿은 연결이 꾸민 헤더
        self.assertFalse(handler(hdr, peer="not-an-ip")._secure_request())

    def test_잘못된_설정은_신뢰하지_않는다(self):
        os.environ["AAS_TRUSTED_PROXY"] = "yes-please"
        self.assertFalse(handler({"X-Forwarded-Proto": "https"})._secure_request())
        os.environ["AAS_TRUSTED_PROXY"] = "false"
        self.assertFalse(handler({"X-Forwarded-Proto": "https"})._secure_request())

    def test_실제_접속_주소는_신뢰할_때만_X_Forwarded_Host_를_본다(self):
        h = {"Host": "10.0.0.5:17900", "X-Forwarded-Host": "aas.example.com"}
        self.assertEqual(handler(h)._effective_host(), "10.0.0.5:17900")
        os.environ["AAS_TRUSTED_PROXY"] = "true"
        self.assertEqual(handler(h)._effective_host(), "aas.example.com")
        self.assertEqual(handler({"Host": "a:1", "X-Forwarded-Host": "first.example.com, second.example.com"})._effective_host(), "first.example.com")
        self.assertEqual(handler({"Host": "a:1"})._effective_host(), "a:1")

    def test_localhost_는_지금처럼_허용한다(self):
        self.assertTrue(handler({"Host": "localhost:17900"})._is_local_host())
        os.environ["AAS_TRUSTED_PROXY"] = "true"
        self.assertTrue(handler({"Host": "localhost:17900"})._is_local_host())
        # 신뢰하는 프록시 뒤에서 Host 가 localhost 로 꾸며져도 X-Forwarded-Host 가 실제 이름이면 localhost 로 보지 않는다
        self.assertFalse(handler({"Host": "localhost:17900", "X-Forwarded-Host": "aas.example.com"})._is_local_host())


class SecretsOkTest(unittest.TestCase):
    """비밀값을 받아도 되는 연결인가(스펙 2026-10-19-015 A3·S5). 화면 표시와 실제 동작이 이 함수 하나로 판단한다."""
    KEYS = ("AAS_TRUSTED_PROXY", "AAS_ALLOW_LOCALHOST_SECRETS", "KUBERNETES_SERVICE_HOST")

    def setUp(self):
        self.saved = {k: os.environ.pop(k, None) for k in self.KEYS}

    def tearDown(self):
        for k, v in self.saved.items():
            os.environ.pop(k, None)
            if v is not None:
                os.environ[k] = v

    def test_https_는_어디서나_허용(self):
        os.environ["KUBERNETES_SERVICE_HOST"] = "10.96.0.1"
        self.assertTrue(handler({"Host": "aas.example.com"}, tls=True)._secrets_ok())

    def test_로컬_시험_환경은_localhost_http_를_허용(self):
        self.assertTrue(handler({"Host": "localhost:17900"})._secrets_ok())
        self.assertFalse(handler({"Host": "10.0.0.5:17900"})._secrets_ok())

    def test_쿠버네티스에서는_Host_localhost_로_꾸민_http_를_거절(self):
        os.environ["KUBERNETES_SERVICE_HOST"] = "10.96.0.1"
        self.assertFalse(handler({"Host": "localhost:17900"})._secrets_ok())

    def test_설정으로_기본값을_바꾼다(self):
        os.environ["KUBERNETES_SERVICE_HOST"] = "10.96.0.1"
        os.environ["AAS_ALLOW_LOCALHOST_SECRETS"] = "true"
        self.assertTrue(handler({"Host": "localhost:17900"})._secrets_ok())
        os.environ.pop("KUBERNETES_SERVICE_HOST")
        os.environ["AAS_ALLOW_LOCALHOST_SECRETS"] = "false"
        self.assertFalse(handler({"Host": "localhost:17900"})._secrets_ok())


if __name__ == "__main__":
    unittest.main()

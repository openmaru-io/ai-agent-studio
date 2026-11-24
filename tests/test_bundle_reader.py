# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""허브 없는 설치본(compose)의 기본 스킬 쓰기 — 서버의 읽기 함수(스펙 2026-10-29-001 R10, OMAI-2031).

기본 스킬을 쓰기 전에 profiles/<이름>/config.yaml 을 읽어 프로파일이 아직 있는지 본다(2026-11-07). Hermes v0.22.2 파일 API 는
config.yaml 을 민감한 파일로 보고 403 「Access to sensitive files is not allowed」를 돌려준다 — 그 오류가 주기 전체를 멈춰
compose 설치에는 기본 스킬이 하나도 들어가지 않았다(2026-11-17 로컬 compose 확인). 403 민감 파일은 「있음」으로 읽는다.
"""
import base64
import os
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

TMP = tempfile.TemporaryDirectory()
os.environ.setdefault("AAS_DATA_DIR", str(Path(TMP.name) / "data"))

from aas.hermes.hermes_api import HermesError  # noqa: E402
from aas.web import server  # noqa: E402


class API:
    def __init__(self, auth=None):
        pass

    def call(self, method, path, body=None, query=None, timeout=30):
        p = query["path"]
        if p.endswith("config.yaml"):
            raise HermesError("Access to sensitive files is not allowed", 502)   # HermesAPI 는 403 을 502 로 올린다
        if p.endswith("missing/SKILL.md"):
            raise HermesError("File not found", 404)
        if p.endswith("denied.md"):
            raise HermesError("File is not readable", 502)
        return {"data_url": "data:text/plain;base64," + base64.b64encode(b"hello").decode()}


class BundleReaderTest(unittest.TestCase):
    def setUp(self):
        for p in (mock.patch.object(server, "HermesAPI", API), mock.patch.object(server, "hub", return_value=SimpleNamespace(auth=None))):
            p.start()
            self.addCleanup(p.stop)
        self.read = server._bundle_reader(SimpleNamespace(id="pod"))

    def test_sensitive_file_counts_as_present(self):
        self.assertIsNotNone(self.read("profiles/p/config.yaml"))

    def test_missing_and_plain_files(self):
        self.assertIsNone(self.read("profiles/p/skills/market/missing/SKILL.md"))
        self.assertEqual(self.read("profiles/p/skills/market/x/SKILL.md"), b"hello")

    def test_other_403_still_raises(self):
        with self.assertRaises(HermesError):
            self.read("profiles/p/denied.md")

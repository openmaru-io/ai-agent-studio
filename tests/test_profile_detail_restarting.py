# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""프로파일 상세가 「작업공간이 다시 뜨는 중」을 알린다(스펙 2026-10-23-008, OMAI-1458). 대시보드가 없는 동안 URLError 만 보이던 문제."""
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

TMP = tempfile.TemporaryDirectory()
os.environ.setdefault("AAS_DATA_DIR", str(Path(TMP.name) / "data"))

from aas.fleet.pods import Pod  # noqa: E402
from aas.hermes.hermes_api import HermesError  # noqa: E402
from aas.web import server  # noqa: E402


class DownAPI:
    def __init__(self, *_):
        pass

    def call(self, *_, **__):
        raise HermesError("Hermes API 서버에 연결할 수 없습니다: URLError", 503)


class ProfileDetailRestartingTest(unittest.TestCase):
    def detail(self, pod: Pod) -> dict:
        with mock.patch.object(server, "_profile_rows", return_value=[{"name": "main", "is_default": False}]), \
                mock.patch.object(server, "HermesAPI", DownAPI), mock.patch.object(server, "hub", lambda pod: mock.Mock(auth=None)), \
                mock.patch.object(server, "_agents_detail", return_value=({}, "")), \
                mock.patch.object(server, "_models", return_value={"models": []}):
            return server._profile_detail(pod, "main")

    def test_다시_뜨는_중인_작업공간이면_restarting_을_준다(self):
        out = self.detail(Pod("p1", "a@x.com", Path(TMP.name), restarting=True))
        self.assertTrue(out["restarting"])
        self.assertTrue(out["notes"])                     # 읽지 못한 부분은 그대로 적는다(화면이 안내를 고른다)

    def test_준비된_작업공간이면_restarting_이_없다(self):
        out = self.detail(Pod("p1", "a@x.com", Path(TMP.name)))
        self.assertNotIn("restarting", out)


if __name__ == "__main__":
    unittest.main()

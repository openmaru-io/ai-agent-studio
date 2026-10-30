# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""스킬 문서 저장 뒤 다시 읽기가 사이드카의 옛 묶음을 읽지 않는다(OMAI-1513, 2026-10-28 OKE 실제 Claude Code 확인에서 발견).

쿠버네티스에서 AAS 는 Hermes 폴더를 사이드카 묶음(tree, 60초)으로 읽는다. files.save 는 Hermes 에 저장한 뒤 파일을 다시 읽어
바뀌었는지 보는데, 60초 안에 같은 폴더를 읽은 적이 있으면 옛 묶음을 읽어 「저장했다는데 파일이 그대로」(502)로 실패했다
(Hermes 쪽 파일은 실제로 바뀜). 저장 요청 직후 그 POD 의 묶음을 버려야 한다.
"""
import os
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

TMP = tempfile.TemporaryDirectory()
os.environ.setdefault("AAS_DATA_DIR", str(Path(TMP.name) / "data"))


class FakeBackend:
    def __init__(self):
        self.calls = []

    def invalidate(self):
        self.calls.append("invalidate")


class SkillSaveFreshReadTest(unittest.TestCase):
    def test_저장을_보낸_뒤_사이드카_묶음을_버린다(self):
        from aas.web import server
        backend = FakeBackend()
        pod = SimpleNamespace(id="ssf-p", hermes_home=SimpleNamespace(backend=backend))
        order = []

        class API:
            def __init__(self, auth):
                pass

            def call(self, method, path, body=None, query=None, **kw):
                order.append((method, path))
                if method == "GET":
                    return {"path": "/opt/data/profiles/main/skills/demo/SKILL.md"}
                backend.calls.append("put")
                return {}
        with mock.patch.object(server, "HermesAPI", API), mock.patch.object(server, "hub", lambda p: SimpleNamespace(auth=None)):
            server._skill_sender(pod)("profiles/main/skills/demo/SKILL.md", "old", "new")
        self.assertEqual(order, [("GET", "/api/skills/content"), ("PUT", "/api/skills/content")])
        self.assertEqual(backend.calls, ["put", "invalidate"])                          # 다시 읽기 전에 묶음이 버려진다


if __name__ == "__main__":
    unittest.main()

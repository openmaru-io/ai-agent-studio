# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""대화를 누가 열었나·Claude Code 가 쓰는 중인가(스펙 2026-10-28-001 §3-7 ⑤, 재검토 F8, OMAI-1513)."""
import os
import tempfile
import unittest
from pathlib import Path

TMP = tempfile.TemporaryDirectory()
os.environ.setdefault("AAS_DATA_DIR", str(Path(TMP.name) / "data"))


class ChatSessionMetaTest(unittest.TestCase):
    def tearDown(self):
        from aas.ops import chat_session_meta as m
        with m._conn() as conn:
            conn.execute("DELETE FROM chat_session_meta WHERE pod LIKE 'csm-%'")

    def test_쓰는_중은_마지막으로_건드린_뒤_90초(self):
        from aas.ops import chat_session_meta as m
        m.opened("csm-a", "s1", "", "main", "Kim@corp", "token", "skill-test", now=1000.0)
        self.assertEqual(m.for_stored("csm-a", ["st1"], now=1001.0), {})                 # 저장 번호를 아직 모른다
        self.assertTrue(m.touch("csm-a", "s1", "st1", now=1001.0))                       # 첫 제목 뒤에 채운다
        self.assertEqual(m.for_stored("csm-a", ["st1"], now=1080.0), {"st1": {"via": "token", "purpose": "skill-test", "active": True}})
        self.assertFalse(m.for_stored("csm-a", ["st1"], now=1091.0)["st1"]["active"])
        self.assertFalse(m.touch("csm-a", "s1", "", now=1030.0))                        # 50초 안에는 다시 쓰지 않는다
        self.assertTrue(m.touch("csm-a", "s1", "", now=1100.0))
        self.assertTrue(m.for_stored("csm-a", ["st1"], now=1180.0)["st1"]["active"])

    def test_모르는_목적은_비우고_다른_에이전트는_따로(self):
        from aas.ops import chat_session_meta as m
        m.opened("csm-a", "s2", "st2", "main", "k", "token", "nonsense", now=1000.0)
        m.opened("csm-b", "s2", "st2", "main", "k", "screen", "", now=1000.0)
        self.assertEqual(m.for_stored("csm-a", ["st2"], now=1001.0)["st2"]["purpose"], "")
        self.assertEqual(m.for_stored("csm-b", ["st2"], now=1001.0)["st2"]["via"], "screen")
        self.assertEqual(m.for_stored("csm-a", [], now=1001.0), {})

    def test_DB_이전_표_목록에_들어_있다(self):
        from aas.common import dbmigrate
        from aas.ops import chat_session_meta
        self.assertIn(chat_session_meta.SCHEMA, dbmigrate.schema_scripts())


if __name__ == "__main__":
    unittest.main()

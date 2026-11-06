# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""세션 칸에서 닫은 대화의 저장 번호(스펙 2026-11-06-002 D2·E1~E4, OMAI-1851)."""
import os
import tempfile
import unittest
from pathlib import Path

TMP = tempfile.TemporaryDirectory()
os.environ.setdefault("AAS_DATA_DIR", str(Path(TMP.name) / "data"))


class ChatHiddenTest(unittest.TestCase):
    def tearDown(self):
        from aas.ops import chat_hidden as h
        with h._conn() as conn:
            conn.execute("DELETE FROM chat_hidden WHERE pod LIKE 'chd-%'")

    def test_사용자와_에이전트마다_따로(self):
        from aas.ops import chat_hidden as h
        self.assertEqual(h.hide("Me@Corp", "chd-a", ["st1", "st1", ""]), 1)          # 대소문자·중복·빈 값
        self.assertEqual(h.hide("me@corp", "chd-a", ["st1"]), 0)                       # 이미 있음
        h.hide("other@corp", "chd-a", ["st2"])
        h.hide("me@corp", "chd-b", ["st3"])
        self.assertEqual(h.stored_ids("me@corp", ["chd-a", "chd-b", "chd-c"]), {"chd-a": {"st1"}, "chd-b": {"st3"}, "chd-c": set()})
        self.assertEqual(h.stored_ids("", ["chd-a"]), {"chd-a": set()})
        self.assertEqual(h.stored_ids("me@corp", []), {})

    def test_다시_열면_풀리고_90일_지나면_지운다(self):
        from aas.ops import chat_hidden as h
        h.hide("me@corp", "chd-a", ["old"], now=1000.0)
        h.hide("me@corp", "chd-a", ["keep"], now=1000.0 + h.KEEP)
        self.assertEqual(h.stored_ids("me@corp", ["chd-a"], now=1001.0 + h.KEEP), {"chd-a": {"keep"}})    # 읽을 때 90일 지난 것은 뺀다
        h.hide("me@corp", "chd-a", ["new"], now=1001.0 + h.KEEP)                                           # 쓸 때 지운다
        with h._conn() as conn:
            left = {r["stored_id"] for r in conn.execute("SELECT stored_id FROM chat_hidden WHERE pod='chd-a'").fetchall()}
        self.assertEqual(left, {"keep", "new"})
        h.unhide("me@corp", "chd-a", "keep")
        h.unhide("me@corp", "chd-a", "")
        self.assertEqual(h.stored_ids("me@corp", ["chd-a"], now=1002.0 + h.KEEP), {"chd-a": {"new"}})

    def test_DB_이전_표_목록에_들어_있다(self):
        from aas.common import dbmigrate
        from aas.ops import chat_hidden
        self.assertIn(chat_hidden.SCHEMA, dbmigrate.schema_scripts())


if __name__ == "__main__":
    unittest.main()

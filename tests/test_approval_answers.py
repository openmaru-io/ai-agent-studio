# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""승인·되묻기에 먼저 답한 쪽이 이긴다(스펙 2026-10-28-001 §3-7 ④, 재검토 F4, OMAI-1513)."""
import os
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

TMP = tempfile.TemporaryDirectory()
os.environ.setdefault("AAS_DATA_DIR", str(Path(TMP.name) / "data"))


class ApprovalAnswersTest(unittest.TestCase):
    def tearDown(self):
        from aas.ops import approval_answers
        with approval_answers._conn() as conn:
            conn.execute("DELETE FROM approval_answers WHERE pod LIKE 'aa-%'")

    def test_먼저_적은_쪽이_이기고_늦은_쪽은_그_줄을_받는다(self):
        from aas.ops import approval_answers as aa
        k = aa.key("aa-p", "r1")
        self.assertIsNone(aa.claim(k, "aa-p", "s", "approval", "once", "Kim@corp", "token", now=100.0))
        late = aa.claim(k, "aa-p", "s", "approval", "deny", "lee@corp", "screen", now=101.0)
        self.assertEqual((late["by_email"], late["via"], late["choice"]), ("kim@corp", "token", "once"))
        aa.release(k)                                                                   # 보내기 실패 — 다시 답할 수 있다
        self.assertIsNone(aa.claim(k, "aa-p", "s", "approval", "deny", "lee@corp", "screen", now=102.0))

    def test_열쇠는_에이전트와_질문마다_따로(self):
        from aas.ops import approval_answers as aa
        self.assertNotEqual(aa.key("aa-a", "r1"), aa.key("aa-b", "r1"))
        self.assertNotEqual(aa.key("aa-a", "r1", "q1"), aa.key("aa-a", "r1", "q2"))

    def test_실패하면_줄을_지우고_다시_던진다(self):
        from aas.ops import approval_answers as aa
        from aas.web import server
        pod = SimpleNamespace(id="aa-p2")

        def boom():
            raise RuntimeError("hermes down")
        with self.assertRaises(RuntimeError):
            server._answer_once(pod, "s", "approval", "r9", None, "once", "kim@corp", boom)
        self.assertIsNone(aa.get(aa.key("aa-p2", "r9")))
        self.assertEqual(server._answer_once(pod, "s", "approval", "r9", None, "once", "kim@corp", lambda: {"ok": 1}), {"ok": 1})
        with self.assertRaises(server.AlreadyAnswered) as cm:
            server._answer_once(pod, "s", "approval", "r9", None, "deny", "lee@corp", lambda: {"ok": 2})
        self.assertEqual((cm.exception.body["reason"], cm.exception.body["by"]), ("already_answered", "kim@corp"))
        self.assertEqual(server._answer_once(pod, "s", "approval", None, None, "once", "x", lambda: "old"), "old")   # 요청 번호 없는 옛 승인

    def test_DB_이전_표_목록에_들어_있다(self):
        from aas.common import dbmigrate
        from aas.ops import approval_answers
        self.assertIn(approval_answers.SCHEMA, dbmigrate.schema_scripts())


if __name__ == "__main__":
    unittest.main()

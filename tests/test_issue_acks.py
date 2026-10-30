# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""프로파일 「확인할 것」의 주의·안내 확인(스펙 2026-10-24-003 §13, 사용자 지시 2026-10-30)."""
import os
import tempfile
import unittest
from pathlib import Path

TMP = tempfile.TemporaryDirectory()
os.environ.setdefault("AAS_DATA_DIR", str(Path(TMP.name) / "data"))

from aas.ops import issue_acks as ia  # noqa: E402

SKILLS4 = {"level": "warn", "code": "pc_import_skills", "n": 4, "text": "컨테이너에서 읽히지 않는 스킬 4개"}
BAD = {"level": "bad", "text": "게이트웨이 꺼짐"}
OLD = {"level": "warn", "text": "비밀값 파일(.env)이 없습니다", "from": "설정"}


def rows(*issues):
    return [{"name": "main", "issues": list(issues)}]


class IssueAckTest(unittest.TestCase):
    def setUp(self):
        with ia._conn() as conn:
            conn.execute("DELETE FROM issue_acks")

    def test_sig_ignores_text_and_link_but_follows_values(self):
        self.assertEqual(ia.sig(SKILLS4), ia.sig({**SKILLS4, "text": "4 skills that cannot load", "to": {"view": "x"}}))   # 언어가 바뀌어도 같다
        self.assertNotEqual(ia.sig(SKILLS4), ia.sig({**SKILLS4, "n": 5}))
        self.assertNotEqual(ia.sig(OLD), ia.sig({**OLD, "text": "다른 문장"}))                                         # code 가 없으면 문장으로

    def test_only_warn_and_info_get_ack_and_acked_ones_disappear(self):
        out = ia.apply("p1", rows(SKILLS4, BAD, OLD), True)[0]["issues"]
        self.assertEqual([(i["level"], i.get("ack", False)) for i in out], [("warn", True), ("bad", False), ("warn", True)])
        ia.ack("p1", "main", out[0]["sig"], "kim@x.io")
        after = ia.apply("p1", rows(SKILLS4, BAD, OLD), True)[0]["issues"]
        self.assertEqual([i["level"] for i in after], ["bad", "warn"])
        self.assertEqual(len(ia.apply("p1", rows({**SKILLS4, "n": 5}), True)[0]["issues"]), 1)     # 값이 바뀌면 다시 보인다
        self.assertEqual(len(ia.apply("p2", rows(SKILLS4), True)[0]["issues"]), 1)                 # 다른 작업공간은 따로

    def test_viewers_who_cannot_ack_see_no_button_but_acks_still_apply(self):
        done = ia.apply("p1", rows(SKILLS4), True)[0]["issues"][0]["sig"]
        ia.ack("p1", "main", done, "kim@x.io")
        self.assertEqual(ia.apply("p1", rows(SKILLS4, {**OLD, "ack": True}), False)[0]["issues"], [OLD])   # 버튼 표시는 지운다
        rs = rows(SKILLS4)
        ia.apply("p1", rs, True)
        self.assertNotIn("sig", rs[0]["issues"][0])                                                # 받은 줄은 고치지 않는다

    def test_ack_all_at_once_and_cache_notices_writes(self):
        out = ia.apply("p1", rows(SKILLS4, BAD, OLD), True)[0]["issues"]
        sigs = [i["sig"] for i in out if i.get("ack")]
        self.assertEqual(ia.ack("p1", "main", sigs + sigs[:1], "kim@x.io"), 2)               # 「모두 확인」, 같은 지문은 한 번
        self.assertEqual([i["level"] for i in ia.apply("p1", rows(SKILLS4, BAD, OLD), True)[0]["issues"]], ["bad"])
        with self.assertRaises(ValueError):
            ia.ack("p1", "main", ["0" * 16, "bad"], "kim@x.io")                               # 하나라도 잘못되면 아무것도 적지 않는다
        with self.assertRaises(ValueError):
            ia.ack("p1", "main", ["%016x" % k for k in range(ia.MAX_PER_CALL + 1)], "kim@x.io")
        from aas.common import table_cache
        self.assertIn("issue_acks", table_cache.TABLES)   # 빠지면 쓴 뒤 60초 동안 옛 값을 준다(2026-10-30 OKE 에서 겪음)

    def test_bad_signature_is_refused(self):
        for s in ("", "xyz", "0" * 15, "g" * 16):
            with self.assertRaises(ValueError):
                ia.ack("p1", "main", s, "kim@x.io")
        with self.assertRaises(ValueError):
            ia.ack("p1", "", "0" * 16, "kim@x.io")


if __name__ == "__main__":
    unittest.main()

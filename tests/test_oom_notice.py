# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""작업공간 메모리 초과 안내 판정(스펙 cogentai-aas-docs 2026-11-06-005 §5 O2, 디자인 D8, OMAI-1856)."""
import unittest
from datetime import datetime, timedelta, timezone

from aas.fleet import agents

NOW = datetime(2026, 11, 6, 12, 0, tzinfo=timezone.utc)


def row(reason="OOMKilled", ago=timedelta(hours=1), then="4Gi", cur=None):
    return {"name": "aas-agent-a", "size": {"memory_limit": cur},
            "last_termination": {"reason": reason, "finished_at": (NOW - ago).isoformat().replace("+00:00", "Z"), "limit_memory": then}}


class OomNoticeTest(unittest.TestCase):
    def test_recent_oom_is_shown_with_stable_id(self):
        n = agents.oom_notice(row(), NOW)
        self.assertEqual(n["limit_memory"], "4Gi")
        self.assertTrue(n["id"].startswith("oom|aas-agent-a|2026-11-06T11:00:00"))

    def test_hidden_after_seven_days(self):
        self.assertIsNone(agents.oom_notice(row(ago=timedelta(days=7, minutes=1)), NOW))
        self.assertIsNotNone(agents.oom_notice(row(ago=timedelta(days=6, hours=23)), NOW))

    def test_hidden_when_limit_was_raised_with_unit_normalised(self):
        self.assertIsNone(agents.oom_notice(row(then="4Gi", cur="8Gi"), NOW))
        self.assertIsNotNone(agents.oom_notice(row(then="4Gi", cur="4096Mi"), NOW), "단위만 다르고 같은 값")
        self.assertIsNotNone(agents.oom_notice(row(then="4Gi", cur=None), NOW), "지금 한도를 모르면 늘린 적 없음")

    def test_only_oomkilled(self):
        self.assertIsNone(agents.oom_notice(row(reason="Error"), NOW))
        self.assertIsNone(agents.oom_notice({"name": "a", "size": {}}, NOW))
        self.assertIsNone(agents.oom_notice({"name": "a", "last_termination": {"reason": "OOMKilled", "finished_at": "bad"}}, NOW))

    def test_view_carries_operator_status(self):
        item = {"metadata": {"name": "aas-agent-a"}, "spec": {}, "status": {"phase": "Ready", "lastTermination": {
            "container": "hermes", "reason": "OOMKilled", "exitCode": 137, "finishedAt": "2026-11-06T11:00:00Z", "limitMemory": "4Gi"}}}
        lt = agents.view(item)["last_termination"]
        self.assertEqual((lt["reason"], lt["exit_code"], lt["limit_memory"]), ("OOMKilled", 137, "4Gi"))
        self.assertIsNone(agents.view({"metadata": {"name": "x"}, "spec": {}, "status": {}})["last_termination"])


if __name__ == "__main__":
    unittest.main()

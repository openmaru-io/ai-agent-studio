# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""작업공간 메모리 초과 안내·메모리 늘리기 요청 결과(스펙 cogentai-aas-docs 2026-11-06-005 O2, 디자인 D9·D16·D21, 재검토 R10·C1·H1)."""
import os
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

TMP = tempfile.TemporaryDirectory()
os.environ.setdefault("AAS_DATA_DIR", str(Path(TMP.name) / "data"))

from aas.common import store  # noqa: E402
from aas.ops import admin_requests as ar  # noqa: E402
from aas.ops import workspace_notices as wn  # noqa: E402

OWNER, OTHER = "t@example.com", "u@example.com"
NOW = datetime.now(timezone.utc)
ENDED = (NOW - timedelta(hours=1)).isoformat().replace("+00:00", "Z")


def agent(name="aas-agent-a", owner=OWNER, limit="4Gi", reason="OOMKilled", phase="NotReady"):
    return {"name": name, "owner": owner, "display_name": "A", "phase": phase, "size": {"memory_limit": None},
            "last_termination": {"reason": reason, "finished_at": ENDED, "limit_memory": limit}}


def resize(name, agent_states, memory="8Gi", created="2026-11-07T00:00:00Z"):
    return {"metadata": {"name": name, "creationTimestamp": created},
            "spec": {"kind": "resize", "resize": {"targets": [{"agent": a, "resources": {"limits": {"memory": memory}}} for a in agent_states]}},
            "status": {"agents": [{"name": a, "state": s, "message": f"{a} {s}"} for a, s in agent_states.items()]}}


def clear():
    with store.connect() as conn:
        conn.executescript(ar.SCHEMA + ";" + wn.SCHEMA)
        conn.execute("DELETE FROM admin_requests")
        conn.execute("DELETE FROM workspace_notice_ack")


class OomItemsTest(unittest.TestCase):
    def setUp(self):
        clear()

    def test_owner_sees_oom_even_when_not_ready_and_ack_hides_it(self):
        rows = [agent(), agent("aas-agent-b", OTHER)]
        items = wn.oom_items(rows, OWNER, NOW)
        self.assertEqual([i["pod"] for i in items], ["aas-agent-a"], "다시 시작 중(NotReady)도, 자기 것만")
        self.assertEqual(items[0]["kind"], "workspace_oom")
        wn.ack(OWNER, items[0]["id"], NOW)
        self.assertEqual(wn.oom_items(rows, OWNER, NOW), [], "확인(서랍 [닫기]와 같음)하면 사라진다")
        self.assertEqual(len(wn.oom_items(rows, OTHER, NOW)), 1, "다른 사람의 확인은 섞이지 않는다")
        self.assertEqual(wn.oom_items(rows, "", NOW), [])

    def test_ack_kept_longer_than_notice(self):
        # 재검토 H1: 48시간에 지우면 7일 안내가 다시 뜬다
        item = wn.oom_items([agent()], OWNER, NOW)[0]
        wn.ack(OWNER, item["id"], NOW - timedelta(days=6))
        wn.ack(OWNER, "oom|other|x", NOW)                # 다른 확인을 쓸 때 오래된 것을 지운다
        self.assertIn(item["id"], wn.acked(OWNER))
        wn.ack(OWNER, "oom|other|y", NOW + timedelta(days=3))
        self.assertNotIn(item["id"], wn.acked(OWNER), "8일이 지나면 지운다")

    def test_pod_of(self):
        self.assertEqual(wn.pod_of("oom|aas-agent-a|2026-11-06T11:00:00Z"), "aas-agent-a")
        self.assertEqual(wn.pod_of("sizefail|hro-1|aas-agent-a"), "aas-agent-a")
        self.assertTrue(wn.owns("oom|a|b") and wn.owns("sizefail|r|a") and not wn.owns("cron_done|x"))


class SettleTest(unittest.TestCase):
    def setUp(self):
        clear()

    def test_done_resize_with_more_memory_closes_pending_requests(self):
        rid = ar.create("aas-agent-a", ar.WORKSPACE, OWNER, "workspace_size", "")
        self.assertEqual(wn.settle([resize("hro-1", {"aas-agent-a": "done"})], [agent()], NOW), 1)
        res = {r["id"]: r for r in ar.result_items(OWNER, lambda p, q: p)}[f"{ar.RESULT_PREFIX}{rid}"]
        self.assertEqual((res["memory_from"], res["memory_to"]), (4 * 2**30, 8 * 2**30))

    def test_not_closed_when_failed_running_smaller_or_unknown(self):
        ar.create("aas-agent-a", ar.WORKSPACE, OWNER, "workspace_size", "")
        cases = [
            [resize("hro-f", {"aas-agent-a": "failed"})],                  # 실패 → 대기 유지(재검토 R10)
            [resize("hro-r", {"aas-agent-a": "running"})],                 # 진행 중
            [resize("hro-s", {"aas-agent-a": "done"}, memory="2Gi")],      # 메모리 감소
            [resize("hro-c", {"aas-agent-a": "done"}, memory="4096Mi")],   # 같음(단위만 다름)
        ]
        for rollouts in cases:
            self.assertEqual(wn.settle(rollouts, [agent()], NOW), 0, rollouts[0]["metadata"]["name"])
        self.assertEqual(wn.settle([resize("hro-u", {"aas-agent-a": "done"})], [agent(limit="")], NOW), 0, "이전 한도를 모르면 닫지 않는다")
        self.assertEqual(len(ar.waiting_pods(OWNER, "workspace_size")), 1)

    def test_no_pending_means_no_work(self):
        self.assertEqual(wn.settle([resize("hro-1", {"aas-agent-a": "done"})], [agent()], NOW), 0)

    def test_latest_rollout_wins(self):
        ar.create("aas-agent-a", ar.WORKSPACE, OWNER, "workspace_size", "")
        older = resize("hro-old", {"aas-agent-a": "done"}, created="2026-11-06T00:00:00Z")
        newer = resize("hro-new", {"aas-agent-a": "failed"}, created="2026-11-07T00:00:00Z")
        self.assertEqual(wn.settle([newer, older], [agent()], NOW), 0, "마지막 결과(실패)로 판정")


class FailedItemsTest(unittest.TestCase):
    def setUp(self):
        clear()

    def test_requester_sees_failure_reason_until_ack(self):
        ar.create("aas-agent-a", ar.WORKSPACE, OWNER, "workspace_size", "")
        rollouts = [resize("hro-f", {"aas-agent-a": "failed"})]
        items = wn.failed_items(rollouts, OWNER)
        self.assertEqual([(i["kind"], i["text"]) for i in items], [("size_failed", "aas-agent-a failed")])
        self.assertEqual(wn.failed_items(rollouts, OTHER), [], "요청하지 않은 사람에게는 없다")
        wn.ack(OWNER, items[0]["id"])
        self.assertEqual(wn.failed_items(rollouts, OWNER), [])


if __name__ == "__main__":
    unittest.main()


class LlmBlockTest(unittest.TestCase):
    """가드가 OKE 카나리에서 실제로 낸 문구(tests/fixtures/llm_guard_block.txt)를 알아본다 — 화면 시험도 같은 파일을 읽는다."""
    def test_fixture_is_recognised_and_explained(self):
        from aas.office import inbox
        from aas.ops import llm_block
        text = (Path(__file__).parent / "fixtures" / "llm_guard_block.txt").read_text(encoding="utf-8").strip()
        self.assertTrue(llm_block.blocked(text))
        self.assertNotIn(llm_block.MARK, llm_block.explain(text))
        self.assertEqual(llm_block.explain("timeout"), "timeout")
        item = inbox.crons_for([{"pod": "p", "profile": "main", "job_id": "j", "job": "j", "error": text}], OWNER)[0]
        self.assertNotIn(llm_block.MARK, item["error"])

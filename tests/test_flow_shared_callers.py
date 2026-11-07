# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""공용 스킬 원본의 연결도: 예약 작업·다른 스킬은 자기 AI 에이전트의 사본을 가리키므로, 사본으로 들어오는 연결도 원본의 「부르는 곳」으로 그린다."""
import unittest

from aas.assets import flow

ORIG = "skill:default:skills/team/report"
COPY = "skill:ops:skills/team/report"
COPY2 = "skill:dev:skills/team/report"
OWN = "skill:ops:profiles/ops/skills/team/report"          # 같은 이름의 프로파일 전용 스킬 — 사본이 아니다
CRON = "cron:ops/abc"
CALLER = "skill:ops:profiles/ops/skills/team/repair"
TALK = "skill:ma:profiles/ma/skills/team/talk"


def node(nid, kind="skill", profile="default"):
    return {"id": nid, "kind": kind, "label": nid.rsplit("/", 1)[-1], "sub": "", "badges": [], "status": "", "profile": profile, "meta": {}}


def edge(a, b, kind="runs", conf="config"):
    return {"from": a, "to": b, "kind": kind, "conf": conf, "meta": {}, "evidence": []}


def index(*edges):
    nodes = {ORIG: node(ORIG), COPY: node(COPY, profile="ops"), COPY2: node(COPY2, profile="dev"), OWN: node(OWN, profile="ops"),
             CRON: node(CRON, "cron", "ops"), CALLER: node(CALLER, profile="ops"), TALK: node(TALK, profile="ma")}
    out, inc = {}, {}
    for e in edges:
        out.setdefault(e["from"], []).append(e)
        inc.setdefault(e["to"], []).append(e)
    return {"nodes": nodes, "out": out, "inc": inc, "built_at": "now"}


class SharedCallers(unittest.TestCase):
    def test_copies_are_found_by_path_not_by_name(self):
        self.assertEqual(sorted(flow.shared_copies(index(), ORIG)), sorted([COPY, COPY2]))
        self.assertEqual(flow.shared_copies(index(), COPY), [])

    def test_callers_of_copies_show_up_on_the_original(self):
        ix = index(edge(CRON, COPY), edge(CALLER, COPY, "refers", "doc"), edge(COPY2, COPY, "refers", "doc"),
                   edge(TALK, COPY, "refers", "mention"))
        sub = flow.subgraph(ix, ORIG)
        ups = sorted(n["id"] for n in sub["nodes"] if n["depth"] == -1)
        self.assertEqual(ups, sorted([CRON, CALLER]))          # 사본끼리·언급은 빼고
        self.assertTrue(all(e["to"] == ORIG for e in sub["edges"] if e["from"] in (CRON, CALLER)))
        self.assertEqual({e["meta"].get("via") for e in sub["edges"] if e["from"] == CRON}, {"ops"})

    def test_one_caller_through_two_copies_counts_once(self):
        ix = index(edge(CRON, COPY), edge(CRON, COPY2))
        sub = flow.subgraph(ix, ORIG)
        self.assertEqual([n["id"] for n in sub["nodes"] if n["depth"] == -1], [CRON])

    def test_a_copy_root_is_unchanged(self):
        ix = index(edge(CRON, COPY))
        self.assertEqual([n["id"] for n in flow.subgraph(ix, COPY)["nodes"] if n["depth"] == -1], [CRON])


if __name__ == "__main__":
    unittest.main()

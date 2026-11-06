# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""스킬 지우기 전 「부르는 곳」 판정(skill_deps): 예약 작업·머리말 related_skills 는 막고, 본문 언급은 알림만,
공용 스킬은 사본으로 들어오는 연결까지 센다."""
import unittest

from aas.assets import skill_deps


def row(pid, name, prof, shared_from=None):
    r = {"id": f"{prof}:skills/{name}", "name": name, "profile": prof}
    if shared_from:
        r["shared_from"] = shared_from
    return r


def edge(a, b, kind, conf):
    return {"from": a, "to": b, "kind": kind, "conf": conf}


BASE = row(0, "report", "default")
COPY = row(0, "report", "ops", shared_from="default")
CALLER = row(0, "caller", "default")
TALKER = row(0, "talker", "ma")
LONE = row(0, "lone", "default")
SKILLS = [BASE, COPY, CALLER, TALKER, LONE]


def index(*edges):
    nodes = {"skill:" + s["id"]: {"kind": "skill", "label": s["name"], "profile": s["profile"]} for s in SKILLS}
    nodes["cron:ops/daily"] = {"kind": "cron", "label": "daily", "profile": "ops"}
    inc = {}
    for e in edges:
        inc.setdefault(e["to"], []).append(e)
    return {"nodes": nodes, "inc": inc}


class Deps(unittest.TestCase):
    def test_cron_on_shared_copy_blocks_the_origin(self):
        ix = index(edge("cron:ops/daily", "skill:" + COPY["id"], "runs", "config"))
        d = skill_deps.dependents(ix, SKILLS, BASE)
        self.assertEqual([x["label"] for x in d["block"]], ["daily"])
        self.assertEqual(d["agents"], ["ops"])
        self.assertEqual(skill_deps.summary(ix, SKILLS)[BASE["id"]]["n_block"], 1)

    def test_frontmatter_refers_blocks_mention_only_warns(self):
        ix = index(edge("skill:" + CALLER["id"], "skill:" + BASE["id"], "refers", "doc"),
                   edge("skill:" + TALKER["id"], "skill:" + BASE["id"], "refers", "mention"))
        d = skill_deps.dependents(ix, SKILLS, BASE)
        self.assertEqual([x["label"] for x in d["block"]], ["caller"])
        self.assertEqual([x["label"] for x in d["warn"]], ["talker"])

    def test_edges_between_copies_do_not_count(self):
        ix = index(edge("skill:" + COPY["id"], "skill:" + BASE["id"], "refers", "doc"))
        self.assertEqual(skill_deps.dependents(ix, SKILLS, BASE)["block"], [])

    def test_no_index_means_not_checked(self):
        d = skill_deps.dependents(None, SKILLS, LONE)
        self.assertFalse(d["checked"])
        self.assertFalse(skill_deps.summary(None, SKILLS)[LONE["id"]]["checked"])

    def test_unreferenced_skill_is_free(self):
        s = skill_deps.summary(index(), SKILLS)[LONE["id"]]
        self.assertEqual((s["n_block"], s["n_warn"], s["n_agents"], s["checked"]), (0, 0, 0, True))


if __name__ == "__main__":
    unittest.main()

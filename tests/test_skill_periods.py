# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""스킬 기간 사용(스펙 2026-11-19-005 2단계 R1·R2): 쌓아 둔 시간 칸에서 7·30·90일 합, 「모름」·집계 전, 공유 원본 합산, 실행 수."""
import os
import tempfile
import unittest
from pathlib import Path

TMP = tempfile.TemporaryDirectory()
os.environ.setdefault("AAS_DATA_DIR", str(Path(TMP.name) / "data"))

from aas.common import store  # noqa: E402
from aas.ops import skill_periods as sp  # noqa: E402
from aas.ops import usage_hours as uh  # noqa: E402

POD = "sp-test"
NOW = 1_800_000_000.0
DAY = 86400


def hour(days_ago: float) -> int:
    return int(NOW - days_ago * DAY) // 3600


def clean():
    with store.connect() as conn:
        for table in ("skill_usage_hours", "skill_usage_sessions", "skill_usage_cursor"):
            conn.execute(f"DELETE FROM {table} WHERE pod=?", (POD,))


def fill(profile: str, hours: dict, sessions=(), unknown=()):
    """profile 의 칸을 90일 전부터 지금까지 읽은 것으로 쓴다."""
    uh.acquire(POD, profile, "t", now=NOW)
    assert uh.save(POD, profile, "t", spans=[(hour(91), hour(0))], hours=hours, sessions=list(sessions), ts=NOW,
                   unknown=list(unknown), filled_from=NOW - 90 * DAY)
    uh.release(POD, profile, "t")


def row(profile, name, *, shared_from="", cron=None):
    return {"id": f"{profile}:{name}", "profile": profile, "name": name, "shared_from": shared_from, "cron": cron or []}


class Periods(unittest.TestCase):
    def setUp(self):
        clean()

    tearDown = setUp

    def test_기간마다_시간_칸을_더한다(self):
        fill("ma", {(hour(1), "skill", "weekly", ""): 2, (hour(10), "skill", "weekly", "j1"): 3, (hour(60), "skill", "weekly", ""): 4})
        rows, _agents = sp.compute(POD, [row("ma", "weekly")], {}, now=NOW)
        r = rows["ma:weekly"]
        self.assertEqual((r["uses_7"], r["uses_30"], r["uses_90"]), (2, 5, 9))
        self.assertEqual((r["covered_7"], r["covered_30"], r["covered_90"]), (True, True, True))
        self.assertEqual((r["unused_7"], r["unused_30"], r["unused_90"]), (False, False, False))

    def test_안_씀은_세_조건이_모두_없을_때(self):
        fill("ma", {(hour(40), "skill", "old", ""): 1})
        last = {"ma:viewed": "2027-01-14T12:00:00"}                         # .usage.json 마지막 사용(NOW 하루 전)
        rows, _ = sp.compute(POD, [row("ma", "old"), row("ma", "viewed"), row("ma", "cronned", cron=[{"last_status": "ok"}])],
                             last, now=NOW)
        self.assertEqual((rows["ma:old"]["unused_30"], rows["ma:old"]["unused_90"]), (True, False))
        self.assertFalse(rows["ma:viewed"]["unused_7"])                      # 사용 파일만 기간 안 — 「쓴 것」
        self.assertTrue(rows["ma:viewed"]["file_only_7"])
        self.assertFalse(rows["ma:cronned"]["unused_30"])                    # 크론 결과가 있으면 「쓴 것」

    def test_모름_구간이_기간에_걸치면_셀_수_없다(self):
        fill("ma", {(hour(1), "skill", "weekly", ""): 1}, unknown=[[NOW - 20 * DAY, NOW - 19 * DAY]])
        r = sp.compute(POD, [row("ma", "weekly"), row("ma", "idle")], {}, now=NOW)[0]
        self.assertEqual((r["ma:weekly"]["covered_7"], r["ma:weekly"]["covered_30"]), (True, False))
        self.assertEqual(sp.compute(POD, [], {}, now=NOW)[1]["ma"]["usage_unknown"], [[sp.iso(NOW - 20 * DAY), sp.iso(NOW - 19 * DAY)]])
        self.assertIsNone(r["ma:idle"]["unused_30"])                          # 「모름」이면 안 씀이라 하지 않는다
        self.assertTrue(r["ma:idle"]["unused_7"])

    def test_집계_전_프로파일은_값이_없다(self):
        rows, agents = sp.compute(POD, [row("new", "x")], {}, now=NOW)
        self.assertEqual((rows["new:x"]["uses_30"], rows["new:x"]["unused_30"], rows["new:x"]["covered_30"]), (None, None, False))
        self.assertFalse(agents["new"]["usage_ready"])

    def test_공유_원본은_자신과_사본의_합과_쓰는_에이전트(self):
        fill("default", {(hour(2), "skill", "digest", ""): 1})
        fill("ma", {(hour(2), "skill", "digest", ""): 3})
        fill("mb", {})
        skills = [row("default", "digest"), row("ma", "digest", shared_from="default"), row("mb", "digest", shared_from="default")]
        r = sp.compute(POD, skills, {}, now=NOW)[0]["default:digest"]
        self.assertEqual((r["uses_30"], r["shared_uses_30"]), (1, 4))         # 자기 사용과 합을 따로
        self.assertEqual([u["profile"] for u in r["used_by"]], ["ma", "default"])   # 쓴 것만, 많이 쓴 순
        self.assertFalse(r["shared_unused_30"])

    def test_사본_프로파일이_모름이면_원본의_합은_셀_수_없다(self):
        fill("default", {})
        fill("ma", {}, unknown=[[NOW - 3 * DAY, NOW - 2 * DAY]])
        skills = [row("default", "digest"), row("ma", "digest", shared_from="default")]
        r = sp.compute(POD, skills, {}, now=NOW)[0]["default:digest"]
        self.assertIsNone(r["shared_unused_7"])
        self.assertFalse(r["shared_covered_7"])

    def test_실행_수는_기간_안에_메시지가_있던_세션(self):
        fill("ma", {}, sessions=[{"session_id": "a", "started_at": NOW - 100 * DAY, "last_at": NOW - 1 * DAY},
                                 {"session_id": "b", "started_at": NOW - 20 * DAY, "last_at": NOW - 20 * DAY},
                                 {"session_id": "c", "started_at": NOW - 50 * DAY, "last_at": NOW - 50 * DAY}])
        agents = sp.compute(POD, [], {}, now=NOW)[1]
        a = agents["ma"]
        self.assertEqual((a["runs_7"], a["runs_30"], a["runs_90"]), (1, 2, 3))
        self.assertTrue(a["usage_ready"])
        self.assertEqual(a["runs_since"], sp.iso(NOW - 90 * DAY))


class TopSkillsTest(unittest.TestCase):
    """「많이 쓴 스킬」(U5, R5): 공용 사본은 원본과 한 줄, 같은 이름의 전용 스킬은 따로, 순서는 합 → 에이전트 수 → 이름."""
    def r(self, profile, name, u30, *, shared_from="", covered=True):
        return {"id": f"{profile}:{name}", "profile": profile, "name": name, "shared_from": shared_from,
                "uses_7": 0, "uses_30": u30, "uses_90": u30, "covered_7": True, "covered_30": covered, "covered_90": covered}

    def test_groups_by_origin_and_orders(self):
        rows = [self.r("default", "digest", 1), self.r("ma", "digest", 3, shared_from="default"),
                self.r("mb", "digest", 0, shared_from="default", covered=False),
                self.r("ma", "notes", 4), self.r("mb", "notes", 1), self.r("mb", "idle", 0)]
        top = sp.top_skills(rows)["30"]
        self.assertEqual([(g["key"], g["n"]) for g in top], [("default/digest", 4), ("ma/notes", 4), ("mb/notes", 1)])
        self.assertTrue(top[0]["shared"] and top[0]["partial"])                     # 사본 하나가 「모름」이면 일부
        self.assertEqual([p["profile"] for p in top[0]["profiles"]], ["ma", "default"])   # 쓴 에이전트만, 많이 쓴 순
        self.assertEqual(sp.top_skills(rows)["7"], [])

    def test_top_50(self):
        top = sp.top_skills([self.r("ma", f"s{i:03d}", i + 1) for i in range(60)])["30"]
        self.assertEqual((len(top), top[0]["name"]), (50, "s059"))


class AnnotateTest(unittest.TestCase):
    """annotate(pod_id=…) 가 줄·에이전트에 기간 값을 붙이고, 「안 쓰임」을 30일 기준으로 본다(셀 수 없으면 「안 쓰임」 아님)."""
    def setUp(self):
        clean()
        self.home = Path(tempfile.mkdtemp(dir=TMP.name))
        for prof in ("ma", "mb"):
            d = self.home / "profiles" / prof
            (d / "skills").mkdir(parents=True)
            (d / "config.yaml").write_text("model: x\n")

    def tearDown(self):
        clean()

    def test_readiness_follows_30_days_and_unknown_is_not_unused(self):
        from types import SimpleNamespace
        from aas.assets import agent_skills
        now = __import__("time").time()
        uh.acquire(POD, "ma", "t", now=now)
        uh.save(POD, "ma", "t", spans=[(int(now - 91 * DAY) // 3600, int(now) // 3600)],
                hours={(int(now - 40 * DAY) // 3600, "skill", "old", ""): 2, (int(now - DAY) // 3600, "skill", "fresh", ""): 1},
                sessions=[{"session_id": "s", "last_at": now - DAY}], ts=now, unknown=[], filled_from=now - 90 * DAY)
        base = {"required_env": [], "cron": [], "scripts": [], "mcp": [], "rest": [], "shared_from": ""}
        skills = [{**base, "id": f"{p}:{n}", "profile": p, "name": n} for p, n in (("ma", "old"), ("ma", "fresh"), ("mb", "never"))]
        profiles = [SimpleNamespace(name=p, path=self.home / "profiles" / p) for p in ("ma", "mb")]
        states, agents = agent_skills.annotate(self.home, profiles, skills, None, pod_id=POD)
        self.assertEqual(states["ma:old"]["readiness"], "unused")             # 40일 전에만 씀 — 30일 기준 안 씀
        self.assertEqual(states["ma:fresh"]["readiness"], "ok")
        self.assertEqual(states["mb:never"]["readiness"], "ok")              # 집계 전 — 안 쓰임이라 하지 않는다
        self.assertEqual(states["ma:old"]["uses_90"], 2)
        by = {a["profile"]: a for a in agents}
        self.assertEqual((by["ma"]["runs_7"], by["ma"]["usage_ready"], by["mb"]["usage_ready"]), (1, True, False))
        self.assertEqual(by["ma"]["unused"], 1)


if __name__ == "__main__":
    unittest.main()

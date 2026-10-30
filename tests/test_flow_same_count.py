# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""스킬 서랍·목록의 외부 호스트 수와 스킬 연결도 중심 패널의 수가 같은지(스펙 2026-10-28-013 디자인 D5·재검토 R1·D2·D3).

두 화면은 script_refs 의 규칙 한 벌을 쓴다. 어긋나던 경우를 하나씩 넣는다:
스크립트가 부르는 스크립트(깊이 3 까지), .ts 참조, 스크립트 목록에 없는 스크립트, 2000자 넘는 줄,
두 스킬이 같은 스크립트를 다른 깊이로 부르는 경우(읽는 순서), README 에만 나온 호스트.
"""
import os
import tempfile
import unittest
from collections import defaultdict
from pathlib import Path

TMP = tempfile.TemporaryDirectory()
os.environ.setdefault("AAS_DATA_DIR", str(Path(TMP.name) / "data"))

from aas.assets import flow, script_refs, skill_graph  # noqa: E402

LONG = "x = '" + "a" * 2100 + " https://longline.io/v1'"


def make_home(root: Path) -> Path:
    home = root / "hermes"
    p5 = home / "skills" / "creative" / "p5"
    (p5 / "scripts").mkdir(parents=True)
    (home / "scripts").mkdir()
    (home / "workspace").mkdir()
    (p5 / "SKILL.md").write_text(
        "---\nname: p5\ndescription: 스케치\n---\n# p5\n\n"
        "<script src=\"https://cdn.jsdelivr.net/npm/p5.js\"></script>\n"
        "실행: `bash /opt/data/scripts/run.sh` 와 `node /opt/data/scripts/tool.ts`\n"
        "임시: `/opt/data/workspace/x.sh`\n")
    (p5 / "README.md").write_text("[p5.js](https://p5js.org/) · CDN https://cdn.jsdelivr.net/npm/p5.js\n")
    (p5 / "scripts" / "export.js").write_text(
        "const fs = require('fs');\nconst path = require('path');\nconst puppeteer = require('puppeteer');\n"
        "fetch('https://unpkg.com/p5.js-svg@1.6.0');\n" + LONG + "\n")
    (p5 / "scripts" / "setup.sh").write_text("#!/bin/sh\nbash helper.sh\n")
    (p5 / "scripts" / "helper.sh").write_text("#!/bin/sh\ncurl -fsSL https://nodejs.org/dist/index.json\n")
    chain = ["run", "b", "c", "d", "e"]
    for i, name in enumerate(chain):
        nxt = f"bash /opt/data/scripts/{chain[i + 1]}.sh\n" if i + 1 < len(chain) else ""
        host = f"curl https://api.deep{i}.io/v1\n" if i else ""
        (home / "scripts" / f"{name}.sh").write_text("#!/bin/sh\n" + host + nxt)
    (home / "scripts" / "tool.ts").write_text("await fetch('https://ts.host.io/');\n")
    (home / "workspace" / "x.sh").write_text("curl https://unlisted.io/\n")
    zz = home / "skills" / "ops" / "zz-other"                 # p5 다음에 읽힌다: d.sh 를 깊이 0 으로 부른다
    zz.mkdir(parents=True)
    (zz / "SKILL.md").write_text("---\nname: zz-other\ndescription: 다른\n---\n`bash /opt/data/scripts/d.sh`\n")
    return home


def reach_hosts(sub: dict) -> set[str]:
    """중심 패널 「외부 호스트 N」의 규칙: 뿌리에서 스크립트만 거쳐 닿는 호스트(mention 제외, 스크립트 깊이 3 까지)."""
    out = defaultdict(list)
    for e in sub["edges"]:
        if e["conf"] != "mention":
            out[e["from"]].append(e["to"])
    hosts, best, queue = set(), {}, [(sub["root"], -1)]
    while queue:
        cur, depth = queue.pop(0)
        for to in out[cur]:
            if to.startswith("host:"):
                hosts.add(to[5:])
            elif to.startswith("script:") and depth + 1 <= script_refs.MAX_DEPTH and best.get(to, 99) > depth + 1:
                best[to] = depth + 1
                queue.append((to, depth + 1))
    return hosts


class SameCountTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.home = make_home(Path(TMP.name))
        cls.sg = skill_graph.build(cls.home, jobs_by_profile={})
        cls.ix = flow.build(cls.home)
        cls.by_name = {s["name"]: s for s in cls.sg["skills"]}

    def sub(self, name: str, **kw) -> dict:
        return flow.subgraph(self.ix, "skill:" + self.by_name[name]["id"], **kw)

    def test_drawer_count_equals_center_panel_count(self):
        expected = {"cdn.jsdelivr.net", "unpkg.com", "nodejs.org", "api.deep1.io", "api.deep2.io", "api.deep3.io", "ts.host.io"}
        p5 = self.by_name["p5"]
        self.assertEqual({r["host"] for r in p5["rest"]}, expected)
        self.assertEqual(reach_hosts(self.sub("p5")), expected)
        self.assertEqual(self.sub("p5")["root_hosts"], len(expected))

    def test_two_skills_reach_the_same_script_at_different_depths(self):
        # p5 는 d.sh 를 깊이 3 으로 먼저 만나 e.sh 를 읽지 않는다. 뒤의 zz-other 는 d.sh 를 깊이 0 으로 부르므로 e.sh 까지 읽어야 한다
        want = {"api.deep3.io", "api.deep4.io"}
        self.assertEqual({r["host"] for r in self.by_name["zz-other"]["rest"]}, want)
        self.assertEqual(reach_hosts(self.sub("zz-other")), want)
        self.assertNotIn("api.deep4.io", reach_hosts(self.sub("p5")))

    def test_unlisted_script_long_line_and_doc_only_host_are_not_calls(self):
        hosts = {r["host"] for r in self.by_name["p5"]["rest"]}
        for h in ("unlisted.io", "longline.io", "p5js.org"):
            self.assertNotIn(h, hosts)
        self.assertEqual(self.by_name["p5"]["rest_doc"], [{"host": "p5js.org", "files": ["README.md"]}])
        self.assertNotIn("p5js.org", self.sg["by_host"])
        self.assertEqual(skill_graph.list_row(self.by_name["p5"])["n_rest"], 7)
        hidden = self.sub("p5")
        self.assertNotIn("host:p5js.org", {n["id"] for n in hidden["nodes"]})
        shown = self.sub("p5", mentions=True)
        e = next(e for e in shown["edges"] if e["to"] == "host:p5js.org")
        self.assertEqual((e["conf"], e["evidence"][0]["file"], e["evidence"][0]["line"]), ("mention", "skills/creative/p5/README.md", 1))

    def test_node_builtins_are_not_libraries_and_node_packages_do_not_warn(self):
        ids = {n["id"]: n for n in self.ix["nodes"].values()}
        self.assertNotIn("lib:fs", ids)
        self.assertNotIn("lib:path", ids)
        pup = ids["lib:puppeteer"]
        self.assertEqual((pup["status"], pup["badges"], pup["sub"]), (None, [], "Node 패키지 · 설치 확인 안 함"))

    def test_truncated_graph_keeps_the_full_host_count(self):
        saved = flow.MAX_NODES
        flow.MAX_NODES = 3
        try:
            sub = self.sub("p5")
        finally:
            flow.MAX_NODES = saved
        self.assertTrue(sub["truncated"])
        self.assertEqual(sub["root_hosts"], 7)
        self.assertLess(len(reach_hosts(sub)), 7)


if __name__ == "__main__":
    unittest.main()

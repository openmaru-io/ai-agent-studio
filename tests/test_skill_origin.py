# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""스킬 출처 판정(스펙 2026-10-14-015 §4-2): 기본·고친 기본·허브·마켓·에이전트·직접 만든 것."""
import hashlib
import json
import os
import tempfile
import unittest
from pathlib import Path

TMP = tempfile.TemporaryDirectory()
os.environ.setdefault("AAS_DATA_DIR", str(Path(TMP.name) / "data"))

from aas.assets import skill_graph, skill_origin as so  # noqa: E402


def put(root: Path, files: dict):
    for rel, text in files.items():
        p = root / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(text, encoding="utf-8")


def md5_of(root: Path, rel_dir: str) -> str:
    folder = root / rel_dir
    h = hashlib.md5()
    for f in sorted(folder.rglob("*")):
        if f.is_file():
            h.update(str(f.relative_to(folder)).encode())
            h.update(f.read_bytes())
    return h.hexdigest()


class OriginTest(unittest.TestCase):
    def setUp(self):
        self.home = Path(tempfile.mkdtemp(dir=TMP.name))
        put(self.home, {"skills/base/SKILL.md": "---\nname: base\n---\n원본", "skills/base/scripts/a.py": "1",
                        "skills/edited/SKILL.md": "---\nname: edited\n---\n원본",
                        "skills/hubbed/SKILL.md": "---\nname: hubbed\n---\n", "skills/market/pkg/SKILL.md": "---\nname: pkg\n---\n",
                        "skills/mine/SKILL.md": "---\nname: mine\n---\n", "skills/bot-made/SKILL.md": "---\nname: bot-made\n---\n",
                        "profiles/ma/skills/mine2/SKILL.md": "---\nname: mine2\n---\n"})
        base_hash, edited_hash = md5_of(self.home, "skills/base"), md5_of(self.home, "skills/edited")
        (self.home / "skills/edited/SKILL.md").write_text("---\nname: edited\n---\n내가 고침", encoding="utf-8")   # 매니페스트 해시는 원본 기준
        put(self.home, {"skills/.bundled_manifest": f"base:{base_hash}\nedited:{edited_hash}\n",
                        "skills/.hub/lock.json": json.dumps({"version": 1, "installed": {"hubbed": {}}}),
                        "skills/.usage.json": json.dumps({"bot-made": {"created_by": "agent"}, "mine": {"created_by": "user"}})})

    def origins(self):
        g = skill_graph.build(self.home, jobs_by_profile={})
        return {s["name"]: s["origin"] for s in g["skills"]}

    def test_each_origin(self):
        got = self.origins()
        self.assertEqual(got["base"], "bundled")
        self.assertEqual(got["edited"], "bundled_modified")            # 매니페스트 해시와 다르면 「고친 기본」
        self.assertEqual(got["hubbed"], "hub")
        self.assertEqual(got["pkg"], "market")
        self.assertEqual(got["bot-made"], "agent")
        self.assertEqual(got["mine"], "local")
        self.assertEqual(got["mine2"], "local")                         # 이름 있는 프로파일은 그 프로파일의 근거를 쓴다

    def test_archived_usage_record_is_not_evidence_of_an_agent_skill(self):
        """2026-10-29-005 R13: Hermes 는 보관할 때 사용 기록을 지우지 않고 state 만 archived 로 둔다(OKE T0 실측 — 같은 이름으로 다시 만든 뒤에도 남음).
        사람이 같은 이름으로 다시 올린 스킬이 「에이전트가 만듦」으로 보이지 않아야 한다."""
        put(self.home, {"skills/.usage.json": json.dumps({"bot-made": {"created_by": "agent", "state": "archived"}, "mine": {"created_by": "user"}})})
        self.assertEqual(self.origins()["bot-made"], "local")

    def test_runtime_leftovers_do_not_make_a_bundled_skill_modified(self):
        put(self.home, {"skills/base/scripts/__pycache__/a.pyc": "bin"})
        self.assertEqual(self.origins()["base"], "bundled")

    def test_legacy_manifest_without_hash_is_bundled_and_list_row_carries_origin_and_sha(self):
        put(self.home, {"skills/.bundled_manifest": "base\nedited\n"})
        g = skill_graph.build(self.home, jobs_by_profile={})
        self.assertEqual({s["name"]: s["origin"] for s in g["skills"]}["edited"], "bundled")
        row = skill_graph.list_row(next(s for s in g["skills"] if s["name"] == "mine"))
        self.assertEqual(row["origin"], "local")
        self.assertEqual(len(next(s for s in g["skills"] if s["name"] == "mine")["md_sha"]), 64)


if __name__ == "__main__":
    unittest.main()

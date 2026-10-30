# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""마켓 설치·새 판이 사용자 스킬·크론·MCP 를 지키는지(스펙 2026-10-14-015 리뷰 R3·R7·R8·R9)."""
import json
import os
import tarfile
import tempfile
import time
import unittest
from pathlib import Path

TMP = tempfile.TemporaryDirectory()
os.environ.setdefault("AAS_DATA_DIR", str(Path(TMP.name) / "data"))

from aas.market import skill_keep as sk  # noqa: E402


def put(root: Path, files: dict):
    for rel, text in files.items():
        p = root / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(text, encoding="utf-8")


class SkillKeepTest(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp(dir=TMP.name))

    def test_digest_ignores_runtime_leftovers(self):
        put(self.root, {"skills/market/a/SKILL.md": "x", "skills/market/a/scripts/run.py": "1",
                        "skills/market/a/scripts/__pycache__/run.cpython-311.pyc": "bin", "skills/market/a/.DS_Store": "m"})
        d = sk.digest(self.root / "skills/market/a")
        self.assertEqual(sorted(d), ["SKILL.md", "scripts/run.py"])               # 실행 부산물 때문에 「고쳤다」로 읽히지 않는다(리뷰 O8)
        self.assertEqual(sk.digest(self.root / "nope"), {})

    def test_modified_same_changed_unknown_absent(self):
        put(self.root, {"skills/market/a/SKILL.md": "원본"})
        ref = sk.digest(self.root / "skills/market/a")
        self.assertEqual(sk.modified(self.root, "skills/market/a", ref), "same")
        (self.root / "skills/market/a/SKILL.md").write_text("내가 고침", encoding="utf-8")
        self.assertEqual(sk.modified(self.root, "skills/market/a", ref), "changed")
        self.assertEqual(sk.modified(self.root, "skills/market/a", None), "unknown")             # 원본을 못 받았다 → 모름
        self.assertEqual(sk.modified(self.root, "skills/market/zz", ref), "absent")
        put(self.root, {"skills/market/a/extra.md": "더함"})
        self.assertEqual(sk.modified(self.root, "skills/market/a", {"SKILL.md": ref["SKILL.md"]}), "changed")   # 파일을 더해도 고친 것

    def test_skill_name_from_frontmatter_or_folder(self):
        put(self.root, {"skills/x/SKILL.md": "---\nname: hello-skill\ndescription: d\n---\n본문", "skills/y/SKILL.md": "본문만"})
        self.assertEqual(sk.skill_name(self.root / "skills/x"), "hello-skill")
        self.assertEqual(sk.skill_name(self.root / "skills/y"), "y")

    def test_installed_skills_skips_examples_inside_a_skill(self):
        put(self.root, {"skills/a/b/SKILL.md": "---\nname: ab\n---\n", "skills/a/b/examples/SKILL.md": "예시", "skills/c/SKILL.md": "---\nname: c\n---\n"})
        self.assertEqual(sk.installed_skills(self.root), {"skills/a/b": "ab", "skills/c": "c"})

    def test_inspect_same_path_and_same_name(self):
        put(self.root, {"skills/market/mine/SKILL.md": "---\nname: mine\n---\n", "skills/local/other/SKILL.md": "---\nname: hello\n---\n"})
        planned = {"skills/market/hello": "hello", "skills/market/mine": "mine"}
        r = sk.inspect(self.root, planned, ours=set())
        self.assertEqual(r["occupied"], ["skills/market/mine"])                           # 설치 기록 없는 같은 경로 → 묻는다
        self.assertEqual(r["clash"], [{"path": "skills/market/hello", "name": "hello", "other": "skills/local/other"}])   # 같은 이름 → 둘 다 막힌다(리뷰 O1)
        r2 = sk.inspect(self.root, {"skills/market/mine": "mine"}, ours={"skills/market/mine"})
        self.assertEqual(r2, {"occupied": [], "clash": []})                              # AAS 가 설치한 것은 덮어도 된다

    def test_merge_jobs_keeps_user_jobs_and_lets_package_win_on_same_id(self):
        cur = json.dumps({"jobs": [{"id": "u1", "name": "내 작업"}, {"id": "p1", "name": "옛 패키지"}], "updated_at": "t"})
        pkg = json.dumps({"jobs": [{"id": "p1", "name": "새 패키지"}, {"id": "p2", "name": "새 작업"}]})
        out = json.loads(sk.merge_jobs(cur, pkg))
        self.assertEqual([(j["id"], j["name"]) for j in out["jobs"]], [("u1", "내 작업"), ("p1", "새 패키지"), ("p2", "새 작업")])
        self.assertEqual(out["updated_at"], "t")
        self.assertEqual(json.loads(sk.merge_jobs(None, "[]")), [])                       # 사용자 것이 없으면 패키지 것
        with self.assertRaises(ValueError):
            sk.merge_jobs("{\"jobs\": 3}", pkg)                                          # 형식이 깨졌으면 합치지 않고 멈춘다
        with self.assertRaises(ValueError):
            sk.merge_jobs("not json", pkg)

    def test_merge_mcp_package_wins_on_same_server(self):
        cur = json.dumps({"mcpServers": {"mine": {"url": "u1"}, "shared": {"url": "old", "keep": 1}}})
        pkg = json.dumps({"mcpServers": {"shared": {"url": "new"}, "added": {"url": "u2"}}})
        out = json.loads(sk.merge_mcp(cur, pkg))["mcpServers"]
        self.assertEqual(sorted(out), ["added", "mine", "shared"])
        self.assertEqual(out["shared"], {"url": "new"})                                   # 같은 서버 이름은 패키지 것 통째로
        self.assertEqual(out["mine"], {"url": "u1"})

    def test_backup_keeps_only_given_paths_and_fails_over_limit(self):
        put(self.root, {"skills/a/SKILL.md": "나", "skills/a/__pycache__/x.pyc": "b", "cron/jobs.json": "[]", "state.db": "큰 DB"})
        name = sk.backup(self.root, "20261014000000000000-abcdef", ["skills/a", "cron/jobs.json"])
        with tarfile.open(sk.backup_dir() / name) as tar:
            self.assertEqual(sorted(tar.getnames()), ["cron/jobs.json", "skills/a/SKILL.md"])      # 덮일 것만, 실행 부산물·다른 파일은 없다
        self.assertEqual(sk.backup(self.root, "20261014000000000001-abcdef", ["nope"]), "")        # 남길 것이 없으면 빈 값
        put(self.root, {"skills/big/SKILL.md": "x" * 10})
        with self.assertRaises(OSError):
            old = sk.MAX_BACKUP
            sk.MAX_BACKUP = 5
            try:
                sk.backup(self.root, "20261014000000000002-abcdef", ["skills/big"])
            finally:
                sk.MAX_BACKUP = old

    def test_archived_lists_curator_archive_per_profile_and_strips_the_timestamp(self):
        put(self.root, {"skills/.archive/old-one/SKILL.md": "a", "skills/.archive/dup-20261001120000/SKILL.md": "b",
                        "profiles/ma/skills/.archive/mine/SKILL.md": "c", "profiles/ma/skills/live/SKILL.md": "d"})
        self.assertEqual(sk.archived(self.root), [
            {"profile": "default", "skill": "dup", "dir": "dup-20261001120000"},
            {"profile": "default", "skill": "old-one", "dir": "old-one"},
            {"profile": "ma", "skill": "mine", "dir": "mine"}])
        self.assertEqual(sk.archived(Path(tempfile.mkdtemp(dir=TMP.name))), [])

    def test_purge_removes_backups_older_than_the_limit(self):
        put(self.root, {"skills/a/SKILL.md": "나"})
        fresh = sk.backup(self.root, "20261014000000000003-abcdef", ["skills/a"])
        old = sk.backup(self.root, "20261014000000000004-abcdef", ["skills/a"])
        past = time.time() - 40 * 86400
        os.utime(sk.backup_dir() / old, (past, past))
        self.assertEqual(sk.purge_backups(), 1)
        self.assertTrue((sk.backup_dir() / fresh).exists())
        self.assertFalse((sk.backup_dir() / old).exists())


if __name__ == "__main__":
    unittest.main()

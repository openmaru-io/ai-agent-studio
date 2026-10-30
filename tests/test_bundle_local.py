# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""스킬 허브가 없는 설치본(compose)에 AAS 기본 스킬 묶음을 직접 쓴다(스펙 2026-10-29-001 R10, OMAI-1534).

- 모든 프로파일(default 제외)의 skills/market/<이름>/ 에 묶음 파일을 쓰고, SKILL.md 는 마지막에 쓴다(반쯤 쓴 스킬이 보이지 않게).
- 쓴 판과 파일마다의 해시를 기록한다. 묶음 판이 높아지면 기록한 파일을 읽어 그대로일 때만 새 판으로 바꾼다.
  사용자가 고쳤으면 그대로 두고 「확인할 것」에 알린다. 지웠으면(SKILL.md 없음) 다시 넣지 않는다.
- 처음 넣을 때 그 자리에 이미 스킬이 있으면(사용자 것) 덮지 않는다.
- 쓰기가 실패하면 그 판에 한 번만 — 「확인할 것」에 보인다.
"""
import hashlib
import os
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

TMP = tempfile.TemporaryDirectory()
os.environ.setdefault("AAS_DATA_DIR", str(Path(TMP.name) / "data"))

from aas.common import store  # noqa: E402
from aas.market import bundle_local, skill_bundle  # noqa: E402

NAMES = skill_bundle.names()
POD = SimpleNamespace(id="pod-c")


class Disk:
    """Hermes 파일 API 대역(/opt/data 아래 상대 경로)."""

    def __init__(self):
        self.files: dict[str, bytes] = {}
        self.writes: list[str] = []
        self.fail = False

    def read(self, path):
        return self.files.get(path)

    def write(self, path, data):
        if self.fail:
            return 502
        self.files[path] = data
        self.writes.append(path)
        return 200


def _skill_dir(profile, name):
    return f"profiles/{profile}/skills/market/{name}"


class LocalTest(unittest.TestCase):
    def setUp(self):
        with store.connect() as conn:
            conn.executescript(bundle_local.SCHEMA)
            conn.execute("DELETE FROM market_bundle_local")
        bundle_local.reset()
        self.disk = Disk()

    def _run(self, profiles=("main", "work", "default")):
        bundle_local.reset()
        return bundle_local.install([POD], lambda pod: list(profiles), lambda pod: self.disk.read, lambda pod: self.disk.write)

    def test_writes_every_package_to_every_profile_but_the_root(self):
        self._run()
        for profile in ("main", "work"):
            for name in NAMES:
                self.assertIn(f"{_skill_dir(profile, name)}/SKILL.md", self.disk.files)
        self.assertFalse(any(p.startswith("profiles/default/") or p.startswith("skills/") for p in self.disk.files))
        self.assertEqual(self.disk.files[f"{_skill_dir('main', 'markdown-to-doc')}/scripts/md_to_xlsx.py"],
                         (skill_bundle.PACKAGES_DIR / "markdown-to-doc/scripts/md_to_xlsx.py").read_bytes())

    def test_skill_md_is_written_last_for_each_package(self):
        self._run(profiles=("main",))
        for name in NAMES:
            mine = [p for p in self.disk.writes if p.startswith(_skill_dir("main", name) + "/")]
            self.assertTrue(mine[-1].endswith("/SKILL.md"), mine)

    def test_second_run_writes_nothing(self):
        self._run(profiles=("main",))
        n = len(self.disk.writes)
        self._run(profiles=("main",))
        self.assertEqual(len(self.disk.writes), n)

    def test_existing_skill_of_the_user_is_not_overwritten(self):
        mine = f"{_skill_dir('main', NAMES[0])}/SKILL.md"
        self.disk.files[mine] = b"---\nname: mine\n---\n"
        self._run(profiles=("main",))
        self.assertEqual(self.disk.files[mine], b"---\nname: mine\n---\n")
        self.assertEqual(bundle_local.record(POD.id, "main", NAMES[0])["status"], "kept")

    def _bump(self, name, version="9.9.9"):
        real = skill_bundle.front
        return mock.patch.object(skill_bundle, "front", lambda n, root=skill_bundle.PACKAGES_DIR:
                                 {**real(n, root), "version": version} if n == name else real(n, root))

    def test_new_version_replaces_untouched_files(self):
        self._run(profiles=("main",))
        name = "markdown-to-doc"
        before = len(self.disk.writes)
        with self._bump(name):
            self._run(profiles=("main",))
        self.assertGreater(len(self.disk.writes), before)
        self.assertEqual(bundle_local.record(POD.id, "main", name)["version"], "9.9.9")

    def test_modified_skill_is_kept_and_reported(self):
        self._run(profiles=("main",))
        name = "markdown-to-doc"
        self.disk.files[f"{_skill_dir('main', name)}/SKILL.md"] += b"\n# my note\n"
        before = len(self.disk.writes)
        with self._bump(name):
            self._run(profiles=("main",))
        self.assertEqual(len(self.disk.writes), before)
        self.assertEqual(bundle_local.record(POD.id, "main", name)["status"], "modified")
        self.assertEqual([i["code"] for i in bundle_local.issues(POD.id, "main")], ["market_default_modified"])

    def test_deleted_skill_is_not_put_back(self):
        self._run(profiles=("main",))
        name = "markdown-to-doc"
        for p in [p for p in self.disk.files if p.startswith(_skill_dir("main", name) + "/")]:
            del self.disk.files[p]
        with self._bump(name):
            self._run(profiles=("main",))
        self.assertNotIn(f"{_skill_dir('main', name)}/SKILL.md", self.disk.files)

    def test_write_failure_is_tried_once_per_version_and_reported(self):
        self.disk.fail = True
        self._run(profiles=("main",))
        self.disk.fail = False
        self._run(profiles=("main",))
        self.assertEqual(self.disk.writes, [])
        self.assertEqual({i["code"] for i in bundle_local.issues(POD.id, "main")}, {"market_default_failed"})

    def test_manifest_hashes_match_the_bundle(self):
        self._run(profiles=("main",))
        rec = bundle_local.record(POD.id, "main", "markdown-to-doc")
        files = bundle_local.manifest(rec)
        self.assertEqual(files["SKILL.md"], hashlib.sha256((skill_bundle.PACKAGES_DIR / "markdown-to-doc/SKILL.md").read_bytes()).hexdigest())

    def test_runs_at_most_once_per_interval(self):
        bundle_local.reset()
        bundle_local.install([POD], lambda pod: ["main"], lambda pod: self.disk.read, lambda pod: self.disk.write)
        n = len(self.disk.writes)
        self.disk.files.clear()
        bundle_local.install([POD], lambda pod: ["main"], lambda pod: self.disk.read, lambda pod: self.disk.write)
        self.assertEqual(len(self.disk.writes), n)


if __name__ == "__main__":
    unittest.main()

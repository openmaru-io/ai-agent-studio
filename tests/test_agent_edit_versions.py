# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""Hermes 가 대화로 고친 SKILL.md 의 판 기록(스펙 2026-10-14-015 T4, 리뷰 R12): 비밀값 건너뛰기·별도 한도·사람 판 보호."""
import os
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

TMP = tempfile.TemporaryDirectory()
os.environ.setdefault("AAS_DATA_DIR", str(Path(TMP.name) / "data"))

from aas.assets import files  # noqa: E402
from aas.web import server  # noqa: E402

REL = "skills/mine/SKILL.md"


def sha(t):
    return files.text_sha(t)


class RecordTest(unittest.TestCase):
    def setUp(self):
        self.pod = f"p{id(self)}"

    def test_first_edit_same_and_secret(self):
        self.assertEqual(files.record_agent_edit(self.pod, REL, "ma", "---\nname: mine\n---\n1", sha("---\nname: mine\n---\n1")), "first")
        self.assertEqual(files.record_agent_edit(self.pod, REL, "ma", "---\nname: mine\n---\n1", sha("---\nname: mine\n---\n1")), "same")
        self.assertEqual(files.record_agent_edit(self.pod, REL, "ma", "---\nname: mine\n---\n2", sha("---\nname: mine\n---\n2")), "recorded")
        secret = "---\nname: mine\n---\nOPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyz0123456789\n"
        self.assertEqual(files.record_agent_edit(self.pod, REL, "ma", secret, sha(secret)), "secret")
        rows = files.versions(self.pod, REL)
        self.assertEqual([r["by"] for r in rows], ["hermes:ma", "hermes:ma", ""])             # 최신순: 비밀값, 고침, 처음 본 판
        self.assertEqual(files.version_content(self.pod, REL, rows[0]["id"]), "")             # 비밀값이 든 판은 내용을 저장하지 않았다
        self.assertEqual(rows[0]["note"], "비밀값이 있어 기록하지 않음")
        self.assertNotIn("sk-abcdefghij", str([files.version_content(self.pod, REL, r["id"]) for r in rows]))

    def test_hermes_versions_have_their_own_limit_and_do_not_push_out_human_versions(self):
        human = [files._remember(self.pod, REL, f"사람 {i}", "kim@x.io", "저장") for i in range(3)]
        for i in range(files.MAX_AGENT_VERSIONS + 5):
            text = f"---\nname: mine\n---\n헤르메스 {i}"
            files.record_agent_edit(self.pod, REL, "ma", text, sha(text))
        rows = files.versions(self.pod, REL)
        self.assertEqual(sum(1 for r in rows if (r["by"] or "").startswith("hermes:")), files.MAX_AGENT_VERSIONS)
        self.assertEqual({r["id"] for r in rows if not (r["by"] or "").startswith("hermes:")} & set(human), set(human) - {None})   # 사람 판은 그대로

    def test_latest_shas(self):
        files._remember(self.pod, REL, "하나", "", "x")
        self.assertEqual(files.latest_shas(self.pod), {REL: sha("하나")})


class SyncTest(unittest.TestCase):
    def test_only_changed_skills_are_read_and_recorded(self):
        home = Path(tempfile.mkdtemp(dir=TMP.name))
        text = "---\nname: mine\n---\n새 내용"
        (home / "skills/mine").mkdir(parents=True)
        (home / "skills/mine/SKILL.md").write_text(text, encoding="utf-8")
        pod = SimpleNamespace(id="sync-pod", hermes_home=home)
        graph = {"skills": [{"path": "skills/mine", "name": "mine", "profile": "default", "origin": "local", "md_sha": sha(text)},
                            {"path": "skills/base", "name": "base", "profile": "default", "origin": "bundled", "md_sha": "x"}]}
        with mock.patch.object(server, "_skills", return_value=graph):
            reg = SimpleNamespace(pods=[pod])
            self.assertEqual(server.agent_edit_sync_once(reg), 0)               # 처음 본 스킬 = 기준 판만 남기고 「고침」으로 세지 않는다
            self.assertEqual([r["note"] for r in files.versions("sync-pod", REL)], ["처음 본 버전"])
            text2 = "---\nname: mine\n---\n헤르메스가 고침"
            (home / "skills/mine/SKILL.md").write_text(text2, encoding="utf-8")
            graph["skills"][0]["md_sha"] = sha(text2)
            self.assertEqual(server.agent_edit_sync_once(reg), 1)
            self.assertEqual(server.agent_edit_sync_once(reg), 0)               # 같은 내용은 두 번 기록하지 않는다
        self.assertEqual(files.versions("sync-pod", REL)[0]["by"], "hermes:default")

    def test_a_skill_deleted_meanwhile_does_not_stop_the_others(self):
        """2026-10-29-005 OV6: 캐시된 목록에 남은, 그사이 보관된 스킬의 SKILL.md 를 읽다 OSError 가 나면 예전에는 그 POD 의 나머지를 그 주기 동안 건너뛰었다."""
        home = Path(tempfile.mkdtemp(dir=TMP.name))
        text = "---\nname: kept\n---\n내용"
        (home / "skills/kept").mkdir(parents=True)
        (home / "skills/kept/SKILL.md").write_text(text, encoding="utf-8")
        pod = SimpleNamespace(id="sync-gone", hermes_home=home)
        graph = {"skills": [{"path": "skills/gone", "name": "gone", "profile": "default", "origin": "local", "md_sha": "x"},
                            {"path": "skills/kept", "name": "kept", "profile": "default", "origin": "local", "md_sha": sha(text)}]}
        with mock.patch.object(server, "_skills", return_value=graph):
            server.agent_edit_sync_once(SimpleNamespace(pods=[pod]))
        self.assertEqual([r["note"] for r in files.versions("sync-gone", "skills/kept/SKILL.md")], ["처음 본 버전"])


if __name__ == "__main__":
    unittest.main()

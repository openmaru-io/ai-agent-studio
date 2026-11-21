# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""작업공간 구성원과 권한 나누기(스펙 2026-11-17-008 단계 1, §3-2·§3-3).

  보기·대화  allowed()         — 관리자·주인·팀 관리자·access_grants·구성원(대화·편집)
  내용 편집  _edits_pod()      — 위 중 주인·팀 관리자·관리자 + 「편집」 구성원(SOUL·지침·스킬 켜기·도구·크론·스킬 문서)
  주인 일    _manages_pod()    — 비밀값·메신저 연결·페어링·설정 파일·MCP·이름·프로파일 만들기·마켓 설치는 편집 구성원도 못 한다
  위험 명령 승인은 may_approve() — 보기만 받은 사람·「대화」 구성원은 자기 대화의 승인도 못 하고, 요청은 주인과 편집 구성원에게 간다."""
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

TMP = tempfile.TemporaryDirectory()
os.environ.setdefault("AAS_DATA_DIR", str(Path(TMP.name) / "data"))

from aas.common import store  # noqa: E402
from aas.fleet import pods  # noqa: E402
from aas.office.inbox import Pending  # noqa: E402

OWNER = {"email": "kim@x.com", "sub": "sub-kim"}
EDITOR = {"email": "editor@x.com", "sub": "sub-editor"}
USER = {"email": "user@x.com", "sub": "sub-user"}
VIEWER = {"email": "viewer@x.com", "sub": "sub-viewer"}          # 관리자가 준 보기(access_grants)
STRANGER = {"email": "nobody@x.com", "sub": "sub-nobody"}
ADMIN = {"email": "root@x.com", "sub": "sub-root", "admin": True}


def clear_members():
    with store.connect() as conn:
        conn.execute(pods.Registry.MEMBER_SCHEMA)
        conn.execute("DELETE FROM workspace_members")


class MembersTest(unittest.TestCase):
    def setUp(self):
        from aas.web import server
        clear_members()
        self.addCleanup(clear_members)
        self.server = server
        self.kim, self.lee = pods.Pod("kim", "kim@x.com", "/tmp"), pods.Pod("lee", "lee@x.com", "/tmp")
        reg = pods.Registry.__new__(pods.Registry)
        reg.pods, reg.admins = [self.kim, self.lee], set()
        reg.grants = lambda: {"viewer@x.com": {"role": "user", "pods": ["kim"]}}
        reg.is_admin = lambda u: bool((u or {}).get("admin"))
        reg.team_pods = lambda u: []
        self.reg = reg
        reg.set_member("kim", "Editor@x.com", "edit", "kim@x.com")
        reg.set_member("kim", "user@x.com", "use", "kim@x.com")
        for target, value in ((server, "registry"),):
            patcher = mock.patch.object(target, value, lambda: reg)
            patcher.start()
            self.addCleanup(patcher.stop)

    # ---- 표 ----
    def test_구성원_역할을_읽고_바꾸고_뺀다(self):
        self.assertEqual(self.reg.members(), {"editor@x.com": {"kim": "edit"}, "user@x.com": {"kim": "use"}})
        self.assertEqual(self.reg.member_role(EDITOR, "kim"), "edit")
        self.assertEqual(self.reg.member_role(EDITOR, "lee"), "")
        self.reg.set_member("kim", "user@x.com", "edit", "kim@x.com")
        self.assertEqual(self.reg.member_role(USER, "kim"), "edit")
        self.reg.set_member("kim", "user@x.com", "none", "kim@x.com")
        self.assertEqual(self.reg.member_role(USER, "kim"), "")
        with self.assertRaises(ValueError):
            self.reg.set_member("kim", "user@x.com", "owner", "kim@x.com")

    def test_등록부에_없는_작업공간_줄은_무시한다(self):
        self.reg.set_member("gone", "user@x.com", "edit", "kim@x.com")
        self.assertEqual(self.reg.members()["user@x.com"], {"kim": "use"})

    def test_구성원은_공유받은_작업공간을_보고_다른_것은_못_본다(self):
        ids = lambda u: [p.id for p in self.reg.allowed(u, True)]       # noqa: E731
        self.assertEqual(ids(EDITOR), ["kim"])
        self.assertEqual(ids(USER), ["kim"])
        self.assertEqual(ids(STRANGER), [])
        self.assertEqual(ids(OWNER), ["kim"])

    # ---- 권한 나누기(§3-2) ----
    def test_편집_구성원은_내용만_고친다(self):
        s = self.server
        for action in ("soul", "agents", "skill", "toolset"):
            self.assertTrue(s.may_change_profile(action, self.kim, EDITOR, True, False), action)
        for action in ("env_set", "channel_save", "pairing_approve", "config", "mcp_add", "rename", "create"):
            self.assertFalse(s.may_change_profile(action, self.kim, EDITOR, True, False), action)
        self.assertEqual(s.content_gate(self.kim, EDITOR, True, False, "main"), "")
        self.assertTrue(s.may_change_cron(self.kim, EDITOR, True, False))
        self.assertFalse(s.may_use_market("/api/market/install", self.kim, EDITOR, True, False))
        self.assertFalse(s._manages_pod(self.kim, EDITOR, True))

    def test_편집_구성원도_남의_작업공간은_못_고친다(self):
        s = self.server
        self.assertFalse(s.may_change_profile("soul", self.lee, EDITOR, True, False))
        self.assertNotEqual(s.content_gate(self.lee, EDITOR, True, False, "main"), "")
        self.assertFalse(s.may_change_cron(self.lee, EDITOR, True, False))

    def test_대화_구성원과_보기만_받은_사람은_고치지_못한다(self):
        s = self.server
        for who in (USER, VIEWER):
            self.assertFalse(s.may_change_profile("soul", self.kim, who, True, False), who["email"])
            self.assertNotEqual(s.content_gate(self.kim, who, True, False, "main"), "", who["email"])
            self.assertFalse(s.may_change_cron(self.kim, who, True, False), who["email"])

    def test_주인은_예전과_같다(self):
        s = self.server
        for action in ("soul", "env_set", "channel_save", "config", "create"):
            self.assertTrue(s.may_change_profile(action, self.kim, OWNER, True, False), action)
        self.assertTrue(s.may_use_market("/api/market/install", self.kim, OWNER, True, False))

    # ---- 위험 명령 승인(§3-3) ----
    def test_승인할_수_있는_사람(self):
        s = self.server
        self.assertTrue(s.may_approve(self.kim, OWNER, True))
        self.assertTrue(s.may_approve(self.kim, EDITOR, True))
        self.assertTrue(s.may_approve(self.kim, ADMIN, True))
        self.assertFalse(s.may_approve(self.kim, USER, True))
        self.assertFalse(s.may_approve(self.kim, VIEWER, True))
        self.assertTrue(s.may_approve(self.kim, USER, False))         # 로그인을 끈 설치는 예전처럼

    def test_승인_요청_받는_사람(self):
        s = self.server
        a = mock.Mock(enabled=True)
        with mock.patch.object(s, "auth", return_value=a):
            self.assertEqual(s.approval_recipients("kim", "kim@x.com", "kim@x.com"), ["kim@x.com"])
            self.assertEqual(s.approval_recipients("kim", "editor@x.com", "kim@x.com"), ["editor@x.com"])
            self.assertEqual(s.approval_recipients("kim", "user@x.com", "kim@x.com"), ["kim@x.com", "editor@x.com"])
            self.assertEqual(s.approval_recipients("kim", "viewer@x.com", "kim@x.com"), ["kim@x.com", "editor@x.com"])
            self.assertEqual(s.approval_recipients("kim", "", "kim@x.com"), ["kim@x.com"])
            self.assertEqual(s.approval_recipients("lee", "user@x.com", "lee@x.com"), ["lee@x.com"])          # 편집 구성원 없는 작업공간
            self.assertEqual(s.approval_recipients("lee", "user@x.com", "aas:deleted-owner"), ["user@x.com"])  # 받을 사람이 없으면 시작한 사람(답은 관리자만)
        with mock.patch.object(s, "auth", return_value=mock.Mock(enabled=False)):
            self.assertEqual(s.approval_recipients("kim", "user@x.com", "kim@x.com"), ["user@x.com"])

    def test_받은편지함의_승인은_답하는_순간_역할을_다시_본다(self):
        s = self.server
        a = mock.Mock(enabled=True)
        p = Pending(clock=lambda: 1.0)
        p.route_approval = lambda pod_id, by, owner: ["user@x.com", "kim@x.com"]     # 요청이 생길 때는 user 도 받는 사람이었다
        p.on_chat("kim", "s1", "ma", "kim@x.com", "aas.user", {"_by": "user@x.com"})
        p.on_chat("kim", "s1", "ma", "kim@x.com", "approval.request", {"request_id": "r1", "command": "rm x"})
        item_id = p.for_person("user@x.com")[0]["id"]
        with mock.patch.object(s, "INBOX", p), mock.patch.object(s, "auth", return_value=a):
            with self.assertRaises(s.office_access.Denied):
                s._office_inbox_answer(self.reg, USER, True, {"id": item_id, "choice": "once"})


class PendingRouteTest(unittest.TestCase):
    """받은편지함이 승인 요청을 route_approval 로 보내는가. 되묻기는 그대로 시작한 사람에게."""

    def setUp(self):
        self.p = Pending(clock=lambda: 1.0)
        self.p.route_approval = lambda pod, by, owner: ["owner@x.com", "editor@x.com"] if by == "user@x.com" else [by or owner]

    def test_대화_구성원의_승인은_주인과_편집_구성원에게(self):
        self.p.on_chat("pod", "s1", "ma", "owner@x.com", "aas.user", {"_by": "user@x.com"})
        self.p.on_chat("pod", "s1", "ma", "owner@x.com", "approval.request", {"request_id": "r1", "command": "rm x"})
        self.assertEqual(self.p.for_person("user@x.com"), [])
        self.assertEqual(len(self.p.for_person("owner@x.com")), 1)
        self.assertEqual(len(self.p.for_person("editor@x.com")), 1)

    def test_되묻기는_시작한_사람에게(self):
        self.p.on_chat("pod", "s1", "ma", "owner@x.com", "aas.user", {"_by": "user@x.com"})
        self.p.on_chat("pod", "s1", "ma", "owner@x.com", "clarify.request", {"request_id": "r2", "question": "어느 파일?"})
        self.assertEqual(len(self.p.for_person("user@x.com")), 1)
        self.assertEqual(self.p.for_person("owner@x.com"), [])

    def test_권한을_못_읽으면_예전처럼_시작한_사람에게(self):
        def boom(*_):
            raise RuntimeError("db")
        self.p.route_approval = boom
        self.p.on_chat("pod", "s1", "ma", "owner@x.com", "aas.user", {"_by": "user@x.com"})
        self.p.on_chat("pod", "s1", "ma", "owner@x.com", "approval.request", {"request_id": "r1"})
        self.assertEqual(len(self.p.for_person("user@x.com")), 1)


if __name__ == "__main__":
    unittest.main()

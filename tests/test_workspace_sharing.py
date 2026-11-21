# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""작업공간 공유 단계 2(스펙 2026-11-17-008 §3-4·§3-5·§3-6·§4): 공유 API·설치 스위치·새로 공유받음 알림·관리자 현황·지난 대화의 시작한 사람."""
import os
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest import mock

TMP = tempfile.TemporaryDirectory()
os.environ.setdefault("AAS_DATA_DIR", str(Path(TMP.name) / "data"))

from aas.common import settings, store  # noqa: E402
from aas.fleet import pods, sharing  # noqa: E402
from aas.ops import chat_session_meta, workspace_notices  # noqa: E402

OWNER = {"email": "kim@x.com", "sub": "sub-kim"}
EDITOR = {"email": "editor@x.com", "sub": "sub-editor"}
USER = {"email": "user@x.com", "sub": "sub-user"}
STRANGER = {"email": "nobody@x.com", "sub": "sub-nobody"}
ADMIN = {"email": "root@x.com", "sub": "sub-root", "admin": True}


def clear():
    with store.connect() as conn:
        conn.execute(pods.Registry.MEMBER_SCHEMA)
        conn.execute("DELETE FROM workspace_members")
        conn.execute(sharing.SHARE_SCHEMA)
        conn.execute("DELETE FROM workspace_share")
        conn.execute("DELETE FROM meta WHERE key LIKE 'owner_sharing%'")
    sharing._cache.clear()


class SharingApiTest(unittest.TestCase):
    def setUp(self):
        from aas.web import server, sharing_api
        clear()
        self.addCleanup(clear)
        self.server, self.api = server, sharing_api
        self.kim, self.lee = pods.Pod("kim", "kim@x.com", "/tmp"), pods.Pod("lee", "lee@x.com", "/tmp")
        reg = pods.Registry.__new__(pods.Registry)
        reg.pods, reg.admins = [self.kim, self.lee], set()
        reg.grants = lambda: {"viewer@x.com": {"role": "user", "pods": ["kim"], "by": "root@x.com", "ts": "2026-11-01T00:00:00+09:00"}}
        reg.is_admin = lambda u: bool((u or {}).get("admin"))
        reg.team_pods = lambda u: []
        self.reg = reg
        for name in ("registry",):
            p = mock.patch.object(server, name, lambda: reg)
            p.start()
            self.addCleanup(p.stop)
        for name, fake in (("_scene_scope_changed", lambda: None), ("_messenger_sync", lambda pod: [])):   # 메신저 쪽은 test_messenger_links
            p = mock.patch.object(server, name, fake)
            p.start()
            self.addCleanup(p.stop)

    def put(self, user, email, role, **kw):
        return self.api.write(self.reg, user, True, {"pod": "kim", "op": "set", "email": email, "role": role, **kw})

    def test_주인이_넣고_바꾸고_뺀다(self):
        self.assertEqual(self.put(OWNER, "User@x.com", "use")["event"], "member_add")
        self.assertEqual(self.put(OWNER, "user@x.com", "edit")["event"], "member_role")
        self.assertEqual(self.reg.member_role(USER, "kim"), "edit")
        self.assertEqual(self.put(OWNER, "user@x.com", "none")["event"], "member_remove")
        self.assertEqual(self.reg.member_role(USER, "kim"), "")
        self.assertTrue(self.put(OWNER, "user@x.com", "none").get("unchanged"))

    def test_처음_공유하면_시각을_적고_숨김은_기본_켬(self):
        out = self.put(OWNER, "user@x.com", "use")
        self.assertTrue(out["since"])
        self.assertEqual(out["hide_before"], out["since"])
        again = self.put(OWNER, "editor@x.com", "edit", hide_before=False)    # 두 번째부터는 처음 고른 값 그대로
        self.assertEqual(again["hide_before"], out["since"])

    def test_숨기지_않기를_고를_수_있다(self):
        self.assertEqual(self.put(OWNER, "user@x.com", "use", hide_before=False)["hide_before"], "")
        self.assertEqual(sharing.hide_before_epoch("kim"), 0.0)

    def test_주인만_바꾼다(self):
        self.put(OWNER, "editor@x.com", "edit")
        for who in (EDITOR, USER, STRANGER):
            with self.assertRaises(self.api.ShareError) as cm:
                self.put(who, "x@x.com", "use")
            self.assertEqual(cm.exception.code, 403)
        self.assertEqual(self.put(ADMIN, "x@x.com", "use")["event"], "member_add")

    def test_입력_검사(self):
        for email, role in (("not-an-email", "use"), ("u@x.com", "owner"), ("kim@x.com", "use")):
            with self.assertRaises(self.api.ShareError):
                self.put(OWNER, email, role)

    def test_보기는_볼_수_있는_사람만_목록은_주인_화면과_같다(self):
        self.put(OWNER, "user@x.com", "use")
        got = self.api.view(self.reg, USER, True, "kim")
        self.assertEqual((got["my_role"], got["can_manage"]), ("use", False))
        self.assertEqual([m["email"] for m in got["members"]], ["user@x.com"])
        self.assertEqual([g["email"] for g in got["granted"]], ["viewer@x.com"])   # 관리자가 준 보기
        self.assertTrue(self.api.view(self.reg, OWNER, True, "kim")["can_manage"])
        with self.assertRaises(self.api.ShareError):
            self.api.view(self.reg, STRANGER, True, "kim")

    def test_안내_한_줄(self):
        self.assertEqual(self.api.write(self.reg, OWNER, True, {"pod": "kim", "op": "note", "note": "  주간 보고는  여기서  "})["note"],
                         "주간 보고는 여기서")
        with self.assertRaises(self.api.ShareError):
            self.api.write(self.reg, OWNER, True, {"pod": "kim", "op": "note", "note": "가" * (sharing.NOTE_MAX + 1)})

    def test_설치에서_공유를_끄면_권한이_사라지고_바꿀_수_없다(self):
        self.put(OWNER, "user@x.com", "edit")
        self.assertEqual([p.id for p in self.reg.allowed(USER, True)], ["kim"])
        sharing.set_enabled(False, "root@x.com")
        self.assertEqual(self.reg.allowed(USER, True), [])
        self.assertEqual(self.reg.memberships("user@x.com"), [])
        self.assertFalse(self.server._edits_pod(self.kim, USER, True))
        with self.assertRaises(self.api.ShareError):
            self.put(OWNER, "editor@x.com", "use")
        self.assertEqual(len(self.reg.member_rows("kim")), 1)                # 행은 남는다
        sharing.set_enabled(True, "root@x.com")
        self.assertEqual([p.id for p in self.reg.allowed(USER, True)], ["kim"])

    def test_찾기는_로그인_기록으로_돌아간다(self):
        settings.set_department("park@x.com", "영업팀")
        settings.reset_cache()
        with mock.patch.object(self.server, "_users_mode", return_value=("aas", None)):
            got = self.api.search(mock.Mock(enabled=True), self.reg, "영업")["people"]
            self.assertIn("park@x.com", [p["email"] for p in got])
            self.assertEqual(self.api.search(mock.Mock(enabled=True), self.reg, "영")["people"], [])   # 두 글자부터

    def test_찾기는_Keycloak_사용자를_먼저(self):
        kc = mock.Mock()
        kc.list_users.return_value = [{"email": "New@x.com", "firstName": "길동", "lastName": "홍", "username": "hong", "enabled": True},
                                      {"email": "off@x.com", "username": "off", "enabled": False}]
        with mock.patch.object(self.server, "_users_mode", return_value=("keycloak", kc)), \
                mock.patch.object(self.server, "_cached", side_effect=lambda key, ttl, fn, **kw: fn()):
            got = self.api.search(mock.Mock(enabled=True), self.reg, "x.com")["people"]
        self.assertEqual([p["email"] for p in got], ["new@x.com"])

    def test_관리자_현황과_CSV(self):
        self.put(OWNER, "user@x.com", "edit")
        rows = self.api.overview(self.reg)
        self.assertEqual({(r["email"], r["role"], r["source"]) for r in rows}, {("user@x.com", "edit", "owner"), ("viewer@x.com", "use", "admin")})
        csv = self.api.overview_csv(rows)
        self.assertTrue(csv.startswith("﻿pod,owner,member_email"))
        self.assertIn("user@x.com", csv)

    def test_자격(self):
        self.put(OWNER, "user@x.com", "use")
        role = lambda u: self.server._pod_role(self.reg, u, True, self.kim)   # noqa: E731
        self.assertEqual([role(OWNER), role(ADMIN), role(USER), role({"email": "viewer@x.com"})], ["owner", "admin", "use", "viewer"])
        self.assertEqual(self.server._actor_role(self.kim, USER, True), "member")


class SharedNoticeTest(unittest.TestCase):
    def setUp(self):
        with store.connect() as conn:
            conn.executescript(workspace_notices.SCHEMA)
            conn.execute("DELETE FROM workspace_notice_ack")

    def test_7일_안의_확인하지_않은_공유만(self):
        now = datetime(2026, 11, 17, tzinfo=timezone.utc)
        recent, old = (now - timedelta(days=1)).isoformat(), (now - timedelta(days=8)).isoformat()
        rows = [{"pod": "kim", "role": "use", "ts": recent, "alias": "영업 도우미", "owner_name": "김소유"},
                {"pod": "lee", "role": "edit", "ts": old}]
        got = workspace_notices.shared_items(rows, "user@x.com", now)
        self.assertEqual([(i["kind"], i["pod"], i["alias"]) for i in got], [("workspace_shared", "kim", "영업 도우미")])
        self.assertTrue(workspace_notices.owns(got[0]["id"]))
        self.assertEqual(workspace_notices.pod_of(got[0]["id"]), "kim")
        workspace_notices.ack("user@x.com", got[0]["id"])
        self.assertEqual(workspace_notices.shared_items(rows, "user@x.com", now), [])


class StarterTest(unittest.TestCase):
    def setUp(self):
        with chat_session_meta._conn() as conn:
            conn.execute("DELETE FROM chat_session_meta")

    def test_화면_대화의_시작한_사람을_적고_Claude_줄은_덮지_않는다(self):
        chat_session_meta.opened("kim", "s-token", "st-1", "main", "a@x.com", "token", now=1000.0)
        n = chat_session_meta.note_starters("kim", [("s-token", "st-1", "main", "b@x.com"), ("s-web", "st-2", "main", "User@x.com"),
                                                    ("s-new", "", "main", "c@x.com")], now=1000.0)
        self.assertEqual(n, 1)
        got = chat_session_meta.for_stored("kim", ["st-1", "st-2"], now=1000.0)
        self.assertEqual((got["st-1"]["via"], got["st-1"]["by"]), ("token", "a@x.com"))
        self.assertEqual((got["st-2"]["via"], got["st-2"]["by"]), ("screen", "user@x.com"))

    def test_화면_줄은_30일이_지나도_남는다(self):
        chat_session_meta.note_starters("kim", [("s-web", "st-2", "main", "u@x.com")], now=1000.0)
        chat_session_meta.opened("kim", "s-token", "st-1", "main", "a@x.com", "token", now=1000.0)
        later = 1000.0 + chat_session_meta.KEEP + 10
        chat_session_meta.note_starters("kim", [("s-x", "st-3", "main", "u@x.com")], now=later)     # 정리가 돈다
        got = chat_session_meta.for_stored("kim", ["st-1", "st-2"], now=later)
        self.assertIn("st-2", got)
        self.assertNotIn("st-1", got)


class StreamEndTest(unittest.TestCase):
    def test_권한을_잃으면_스트림이_끝난다(self):
        from aas.web import server
        h = mock.Mock()
        h.events_after.return_value = []
        allowed = iter([True, False])
        out = list(server._chat_event_stream(h, "s1", 0, lambda: next(allowed)))
        self.assertEqual(out, [b": keepalive\n\n"])


if __name__ == "__main__":
    unittest.main()

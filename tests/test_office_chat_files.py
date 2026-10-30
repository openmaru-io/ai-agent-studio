# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""오피스 장면 대화창(스펙 2026-10-20-002 R4·R13).

- 대화 이름은 이메일 전체 기준이고, 옛 이름(이메일 앞부분) 대화는 같은 앞부분의 다른 사람이 없을 때만 이어 받는다(R13)
- 대화창 받기 경로(/api/office/chat/files)가 열어 주는 범위: require_use + workspace/ 아래, 주인 업로드는 owner_private(R4)
실제로 흘려보내는 것은 test_chat_files.FilesHttpTest 가 사이드카로 본다.
"""
import unittest
from unittest import mock

from aas.office import office, office_access, relay
from aas.web import files as web_files, server

try:
    from tests.test_office_access import ADMIN, A, C, AccessBase, Reg, acc  # noqa: E402
except ImportError:                                            # unittest discover -s tests 로 돌릴 때
    from test_office_access import ADMIN, A, C, AccessBase, Reg, acc  # noqa: E402


class RegG(Reg):
    """시험 등록부에 접근 허용 표(grants)를 더한다 — 실제 Registry 처럼 이메일을 알려 준다."""
    @staticmethod
    def grants():
        return {"grant-kim@z.com": {"role": "user"}}


def admin(email):
    return office_access.Access(RegG, {"email": email, "admin": True}, True)


class TitleBase(AccessBase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        server._registry = RegG

    def setUp(self):
        super().setUp()
        self.addCleanup(self.clear_sessions)
        self.clear_sessions()

    @staticmethod
    def clear_sessions():
        with office.connect() as conn:
            conn.execute("DELETE FROM office_sessions WHERE alias='sa'")

    def send(self, email, text="안녕"):
        """보내기의 대화 행(bridge.start 의 셋째 인자)."""
        turn = relay.Turn("run_t", "sa", "ofc")
        bridge = server._auto.bridge
        with mock.patch.object(bridge, "start", return_value=turn) as start, mock.patch.object(server.store, "log_usage"):
            server._office_route(admin(email), "POST", "/api/office/chat/send", {}, {"alias": "sa", "text": text}, email)
        return start.call_args.args[2]


class OfficeChatTitleTest(TitleBase):
    def test_같은_앞부분의_두_사람은_대화가_나뉜다(self):
        a, b = self.send("kim@a.com"), self.send("kim@b.com")
        self.assertEqual((a["title"], b["title"]), ("office-kim@a.com-sa", "office-kim@b.com-sa"))
        self.assertNotEqual(a["id"], b["id"])
        self.assertEqual(self.send("kim@a.com")["id"], a["id"])                  # 다시 보내면 같은 대화

    def test_이메일은_소문자로_맞춘다(self):
        self.assertEqual(self.send("Lee@X.com")["title"], "office-lee@x.com-sa")

    def test_옛_이름_대화는_앞부분이_겹치는_사람이_없으면_이어_받는다(self):
        old, _ = office.session_create("sa", "office-lee-sa")
        office.session_stored(old["id"], "stored-1")
        bridge = server._auto.bridge
        with mock.patch.object(bridge, "history", return_value={"messages": [], "turn": None}) as history:
            server._office_route(admin("lee@x.com"), "GET", "/api/office/chat/history", {"alias": ["sa"]}, {}, "lee@x.com")
        self.assertEqual((history.call_args.args[0]["id"], history.call_args.args[0]["stored_id"]), (old["id"], "stored-1"))
        row = self.send("lee@x.com")
        self.assertEqual((row["id"], row["title"]), (old["id"], "office-lee@x.com-sa"))
        self.assertIsNone(office.session_find("sa", "office-lee-sa"))

    def test_앞부분이_겹치는_사람이_있으면_옛_대화를_잇지_않는다(self):
        """방 구성원(c@x.com)·등록부 주인(a@x.com)·접근 허용 표(grant-kim@z.com)가 앞부분을 쓰고 있으면 새로 시작한다."""
        for prefix, email in (("c", "c@other.com"), ("a", "a@other.com"), ("grant-kim", "grant-kim@y.com")):
            with self.subTest(email):
                old, _ = office.session_create("sa", f"office-{prefix}-sa")
                row = self.send(email)
                self.assertNotEqual(row["id"], old["id"])
                self.assertEqual(row["title"], f"office-{email}-sa")
                self.assertIsNotNone(office.session_find("sa", f"office-{prefix}-sa"))   # 옛 대화는 그대로 남는다

    def test_새_이름_대화가_있으면_옛_대화를_건드리지_않는다(self):
        new = self.send("lee@x.com")
        old, _ = office.session_create("sa", "office-lee-sa")
        self.assertEqual(self.send("lee@x.com")["id"], new["id"])
        self.assertEqual(office.session_find("sa", "office-lee-sa")["id"], old["id"])


class OfficeFileTargetTest(AccessBase):
    """R4(D12): 대화창 받기는 require_use + workspace/ 아래, 단 주인 업로드는 owner_private."""

    class WS:
        def supported(self):
            return True

    def target(self, email, alias, path):
        with mock.patch.object(server, "_workspace_for_pod_id", return_value=self.WS()) as wf:
            ws = web_files.office_target(acc(email), alias, path)
        return ws, wf

    def code(self, email, alias, path):
        try:
            self.target(email, alias, path)
        except web_files._Denied as d:
            return d.status, d.code
        return 200, ""

    def test_방_구성원은_에이전트_결과와_회의_공유_파일을_받는다(self):
        for path in ("workspace/report/summary.md", "workspace/uploads/aas-shared/1/d/회의록.md",
                     "workspace/uploads/aas-shared-out/1/sa/d/out.csv"):
            self.assertEqual(self.code(C, "sa", path), (200, ""), path)
        _ws, wf = self.target(C, "sa", "workspace/a.txt")
        wf.assert_called_once_with("yj")                                         # 그 자리의 설치본 작업 폴더

    def test_주인_업로드는_방_구성원도_주인도_받지_못한다(self):
        for email in (C, A, ADMIN):
            self.assertEqual(self.code(email, "sa", "workspace/uploads/2026-10-20/개인.pdf"), (403, "owner_private"), email)

    def test_쓸_수_없는_에이전트는_거절한다(self):
        self.assertEqual(self.code(C, "ma", "workspace/a.txt"), (403, "forbidden"))   # 비공개 방
        self.assertEqual(self.code(C, "", "workspace/a.txt"), (400, "bad_request"))
        self.assertEqual(self.code(ADMIN, "nobody", "workspace/a.txt"), (404, "not_found"))

    def test_작업_폴더_밖과_숨은_파일은_outside(self):
        for path in ("state.db", "workspace/../state.db", "/opt/data/workspace/a.txt", "workspace/.env", "workspace/a.csv.upload", ""):
            self.assertEqual(self.code(C, "sa", path), (400, "outside"), path)

    def test_파일_기능이_없는_설치본은_unsupported(self):
        with mock.patch.object(server, "_workspace_for_pod_id", return_value=None):
            with self.assertRaises(web_files._Denied) as cm:
                web_files.office_target(acc(C), "sa", "workspace/a.txt")
        self.assertEqual((cm.exception.status, cm.exception.code), (501, "unsupported"))


if __name__ == "__main__":
    unittest.main()

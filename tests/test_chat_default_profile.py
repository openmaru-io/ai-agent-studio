# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""루트(default)가 숨겨진 POD 에서 default 로 온 채팅 요청은 주 에이전트로 본다(OMAI-1199).
주 에이전트(main)를 쓰는 POD 는 루트를 프로파일 목록에서 빼서, default 를 그대로 받으면 「없는 프로파일」로 거절돼 화면이 막혔다."""
import aasserver  # 실제 uvicorn 앱을 띄우는 시험 하네스(OMAI-1100)
import http.client
import json
import os
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

TMP = tempfile.TemporaryDirectory()
os.environ.setdefault("AAS_DATA_DIR", str(Path(TMP.name) / "data"))

from aas.fleet import primary  # noqa: E402
from aas.web import server  # noqa: E402


class HelperTest(unittest.TestCase):
    POD = SimpleNamespace(id="p1")

    def test_default_becomes_the_primary_only_when_the_root_is_hidden(self):
        with mock.patch.object(primary, "is_target", return_value=True), mock.patch.object(primary, "primary_of", return_value="main"):
            self.assertEqual(server._chat_profile(self.POD, "default"), "main")
            self.assertEqual(server._chat_profile(self.POD, ""), "main")          # 비어 있으면 주 에이전트
            self.assertEqual(server._chat_profile(self.POD, "ops"), "ops")        # 다른 이름은 그대로(엉뚱한 에이전트와 말하지 않게)
        with mock.patch.object(primary, "is_target", return_value=False), mock.patch.object(primary, "primary_of", return_value="default"):
            self.assertEqual(server._chat_profile(self.POD, "default"), "default")   # 대상 기록이 없는 POD 는 지금처럼


class FakeHub:
    calls: list = []

    def history(self, profile, limit=80):
        FakeHub.calls.append(("history", profile))
        return []

    def create_session(self, profile, by=""):
        FakeHub.calls.append(("session", profile))
        return {"session_id": "s1", "profile": profile, "title": ""}

    def resume(self, profile, stored, by=""):
        FakeHub.calls.append(("resume", profile))
        return {"session_id": "s2", "profile": profile, "title": ""}


class HttpTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        from aas.auth import auth
        from aas.fleet import pods
        cls.old = {k: os.environ.get(k) for k in ("AAS_OIDC_ISSUER", "AAS_OIDC_CLIENT_FILE", "AAS_USERS_FILE", "AAS_ALLOWED_HOSTS", "AAS_PODS_FILE")}
        for k in cls.old:
            os.environ.pop(k, None)
        os.environ["AAS_USERS_FILE"] = str(Path(TMP.name) / "no-users.json")
        os.environ["AAS_PODS_FILE"] = str(Path(TMP.name) / "no-pods.json")
        home = Path(TMP.name) / "hermes"
        (home / "profiles" / "main").mkdir(parents=True, exist_ok=True)
        reg = Path(TMP.name) / "pods.json"
        reg.write_text('{"pods": [{"id": "t", "owner": "t@example.com", "hermes_home": "%s"}]}' % home)
        server._auth = auth.Auth({"issuer": "https://accounts.google.com", "client_id": "", "client_secret": "", "domain": "",
                                  "public_url": "http://localhost:17900", "hours": 1, "users_file": Path(TMP.name) / "no-users.json"})
        server._registry = pods.Registry(reg)
        cls.httpd = aasserver.start()
        cls.port = cls.httpd.server_port

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        for k, v in cls.old.items():
            if v is not None:
                os.environ[k] = v
        server._auth = server._registry = None

    def req(self, method, path, body=None):
        c = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        c.request(method, path, body=json.dumps(body) if body is not None else None, headers={"Content-Type": "application/json", "X-AAS": "1"})
        r = c.getresponse()
        data = json.loads(r.read() or b"{}")
        c.close()
        return r.status, data

    def setUp(self):
        FakeHub.calls = []
        main_only = [SimpleNamespace(name="main")]                       # 루트가 숨겨진 POD 의 프로파일 목록
        self.patches = [mock.patch.object(server, "hub", return_value=FakeHub()),
                        mock.patch.object(server.cron_health.hr, "profiles", return_value=main_only),
                        mock.patch.object(primary, "is_target", return_value=True),
                        mock.patch.object(primary, "primary_of", return_value="main")]
        for p in self.patches:
            p.start()

    def tearDown(self):
        for p in self.patches:
            p.stop()

    def test_default_is_served_as_the_primary_agent(self):
        self.assertEqual(self.req("GET", "/api/chat/history?profile=default")[0], 200)
        self.assertEqual(self.req("POST", "/api/chat/session", {"profile": "default"})[0], 200)
        self.assertEqual(self.req("POST", "/api/chat/resume", {"profile": "default", "stored_id": "x"})[0], 200)
        self.assertEqual(FakeHub.calls, [("history", "main"), ("session", "main"), ("resume", "main")])

    def test_resume_of_missing_session_is_404(self):
        """Hermes 에 대화가 없으면 503 이 아니라 404 — 화면이 지워진 대화를 5분 동안 다시 열지 않게(스펙 2026-10-20-030 R9)."""
        from aas.hermes.hermes_chat import ChatNotFound

        def gone(profile, stored, by=""):
            raise ChatNotFound("session not found")
        with mock.patch.object(FakeHub, "resume", side_effect=gone, autospec=False):
            status, data = self.req("POST", "/api/chat/resume", {"profile": "main", "stored_id": "x"})
        self.assertEqual((status, data.get("code")), (404, "not_found"))

    def test_history_hides_sessions_made_by_office_meetings(self):
        """회의 「새 대화」마다 에이전트별 회의 세션이 늘어 주인의 대화를 80개 밖으로 밀어냈다(스펙 2026-10-20-027 R11)."""
        from aas.office import office
        rows = [{"id": "st-meet"}, {"id": "st-mine"}, {"id": "st-1on1"}]
        with office.connect() as conn:
            conn.execute("INSERT INTO office_sessions (id, alias, title, stored_id, ts) VALUES (?,?,?,?,?)", ("ofc_t1", "ma", "meeting-77-t3", "st-meet", "t"))
            conn.execute("INSERT INTO office_sessions (id, alias, title, stored_id, ts) VALUES (?,?,?,?,?)", ("ofc_t2", "ma", "office-a-ma", "st-1on1", "t"))
        seen = {}
        try:
            with mock.patch.object(FakeHub, "history", lambda self, profile, limit=80: seen.setdefault("limit", limit) and rows):
                st, out = self.req("GET", "/api/chat/history?profile=main")
        finally:
            with office.connect() as conn:
                conn.execute("DELETE FROM office_sessions WHERE id IN ('ofc_t1', 'ofc_t2')")
        self.assertEqual(st, 200)
        self.assertEqual([r["id"] for r in out["sessions"]], ["st-mine", "st-1on1"])      # 1:1 오피스 대화는 남는다
        self.assertEqual(seen["limit"], 200)

    def test_history_excludes_hidden_only_when_asked_and_resume_unhides(self):
        """세션 칸 「완료」만 닫은 대화를 뺀다(exclude_hidden=1). 「지난 대화」 서랍은 그대로 보이고, 다시 열면 숨김이 풀린다(스펙 2026-11-06-002 E2·E3)."""
        from aas.ops import chat_hidden
        rows = [{"id": "st-closed"}, {"id": "st-open"}]
        chat_hidden.hide("", "t", ["st-closed"])                          # 로그인이 꺼진 설치는 email ''
        try:
            with mock.patch.object(FakeHub, "history", lambda self, profile, limit=80: rows):
                done = [r["id"] for r in self.req("GET", "/api/chat/history?profile=main&exclude_hidden=1")[1]["sessions"]]
                drawer = [r["id"] for r in self.req("GET", "/api/chat/history?profile=main")[1]["sessions"]]
                self.assertEqual(self.req("POST", "/api/chat/resume", {"profile": "main", "stored_id": "st-closed"})[0], 200)
                again = [r["id"] for r in self.req("GET", "/api/chat/history?profile=main&exclude_hidden=1")[1]["sessions"]]
        finally:
            chat_hidden.unhide("", "t", "st-closed")
        self.assertEqual(done, ["st-open"])
        self.assertEqual(drawer, ["st-closed", "st-open"])
        self.assertEqual(again, ["st-closed", "st-open"])

    def test_history_limit_is_capped(self):
        """세션 칸의 「1주일」은 limit=200 으로 묻는다. 기본은 80, 상한 200, 잘못된 값은 기본(스펙 2026-11-06 세션 칸)."""
        rows = [{"id": f"st-{i}"} for i in range(250)]
        with mock.patch.object(FakeHub, "history", lambda self, profile, limit=80: rows):
            self.assertEqual(len(self.req("GET", "/api/chat/history?profile=main")[1]["sessions"]), 80)
            self.assertEqual(len(self.req("GET", "/api/chat/history?profile=main&limit=200")[1]["sessions"]), 200)
            self.assertEqual(len(self.req("GET", "/api/chat/history?profile=main&limit=999")[1]["sessions"]), 200)
            self.assertEqual(len(self.req("GET", "/api/chat/history?profile=main&limit=x")[1]["sessions"]), 80)

    def test_other_unknown_names_are_still_refused(self):
        self.assertEqual(self.req("GET", "/api/chat/history?profile=ghost")[0], 400)
        self.assertEqual(self.req("POST", "/api/chat/session", {"profile": "ghost"})[0], 400)
        self.assertEqual(FakeHub.calls, [])


if __name__ == "__main__":
    unittest.main()

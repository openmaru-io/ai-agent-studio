# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""칸반 카드 첨부 내려받기 라우트 시험(스펙 office/kanban-card-structured-brief §3-9, T7).

실제 uvicorn 앱 + 실제 HermesAPI(로그인·세션 쿠키) + 가짜 Hermes 대시보드(HTTP 서버). 접근 규칙은 실제 office_access.
"""
import aasserver  # 실제 uvicorn 앱을 띄우는 시험 하네스
import http.client
import json
import os
import re
import tempfile
import threading
import unittest
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest import mock

TMP = tempfile.TemporaryDirectory()
os.environ.setdefault("AAS_DATA_DIR", str(Path(TMP.name) / "data"))

from aas.common import store  # noqa: E402
from aas.fleet import pods  # noqa: E402
from aas.hermes.hermes_api import HermesAPI  # noqa: E402
from aas.hermes.hermes_chat import DashboardAuth  # noqa: E402
from aas.office import hub_auto, office, relay  # noqa: E402
from aas.web import files as web_files, kanban_files, server  # noqa: E402

BOARD = "kbfiles-test"
NAME = 'a"b\n보고서 1.txt'
BIG = 30 * 1024 * 1024


class FakeHermes(ThreadingHTTPServer):
    """설치본 하나의 Hermes 대시보드: 비밀번호 로그인·카드 상세(첨부 목록)·첨부 내려받기."""

    def __init__(self):
        super().__init__(("127.0.0.1", 0), FakeHandler)
        self.tokens: set[str] = set()
        self.logins = 0
        self.down = False
        self.no_length = False
        self.tasks = {
            "t_mine": [{"id": 11, "task_id": "t_mine", "filename": NAME, "content_type": "text/html", "size": 11, "uploaded_by": "sa",
                        "stored_path": "/opt/data/kanban/attachments/t_mine/x", "created_at": 10},
                       {"id": 12, "task_id": "t_mine", "filename": "big.bin", "content_type": "application/zip", "size": BIG, "uploaded_by": "sa",
                        "stored_path": "/opt/data/y", "created_at": 11},
                       {"id": 13, "task_id": "t_mine", "filename": "gone.txt", "content_type": "text/plain", "size": 1, "uploaded_by": "sa",
                        "stored_path": "/opt/data/z", "created_at": 12}],
            "t_other": [{"id": 21, "task_id": "t_other", "filename": "other.txt", "content_type": "text/plain", "size": 5, "uploaded_by": "sb",
                         "stored_path": "/opt/data/o", "created_at": 10}],
            "t_free": [{"id": 31, "task_id": "t_free", "filename": "free.txt", "content_type": "text/plain", "size": 4, "uploaded_by": "dashboard",
                        "stored_path": "/opt/data/f", "created_at": 10}],
        }
        self.blobs = {11: b"<html>hi</>", 21: b"other", 31: b"free"}
        threading.Thread(target=self.serve_forever, daemon=True).start()

    @property
    def url(self):
        return f"http://127.0.0.1:{self.server_address[1]}"


class FakeHandler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _send(self, code, body=b"", ctype="application/json", length=True, cookie=""):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        if length:
            self.send_header("Content-Length", str(len(body)))
        if cookie:
            self.send_header("Set-Cookie", cookie)
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):  # noqa: N802
        self.rfile.read(int(self.headers.get("Content-Length") or 0))
        if self.path == "/auth/password-login":
            self.server.logins += 1
            tok = f"tok{self.server.logins}"
            self.server.tokens.add(tok)
            self._send(200, b"{}", cookie=f"hsess={tok}; Path=/")
            return
        self._send(404, b"{}")

    def do_GET(self):  # noqa: N802
        srv = self.server
        if srv.down:
            self._send(503, b"{}")
            return
        m = re.search(r"hsess=(\w+)", self.headers.get("Cookie") or "")
        if not m or m.group(1) not in srv.tokens:
            self._send(401, b'{"detail": "login"}')
            return
        url = urllib.parse.urlsplit(self.path)
        if urllib.parse.parse_qs(url.query).get("board") != [BOARD]:
            self._send(404, b'{"detail": "board"}')
            return
        t = re.fullmatch(r"/api/plugins/kanban/tasks/([^/]+)", url.path)
        if t and t.group(1) in srv.tasks:
            tid = t.group(1)
            self._send(200, json.dumps({"task": {"id": tid, "title": tid, "assignee": None, "status": "done"}, "comments": [], "events": [],
                                        "attachments": srv.tasks[tid], "links": {}, "runs": []}).encode())
            return
        a = re.fullmatch(r"/api/plugins/kanban/attachments/(\d+)", url.path)
        if a and int(a.group(1)) in srv.blobs:
            self._send(200, srv.blobs[int(a.group(1))], ctype="text/html", length=not srv.no_length)
            return
        self._send(404, b'{"detail": "attachment not found"}')


class KanbanFilesTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        root = Path(TMP.name)
        home = root / "kh"; (home / "profiles").mkdir(parents=True, exist_ok=True)
        reg = root / "kanban-files-pods.json"
        reg.write_text(json.dumps({"pods": [
            {"id": "p", "owner": "u@example.com", "hermes_home": str(home), "dashboard_url": "http://127.0.0.1:9"},
            {"id": "q", "owner": "other@example.com", "hermes_home": str(home), "dashboard_url": "http://127.0.0.1:9"}]}))
        cls.old = (server._auth, server._registry, server._auto)
        server._registry = pods.Registry(reg)
        cls.hermes = FakeHermes()
        cls.auths = {pid: DashboardAuth({"url": cls.hermes.url, "user": "u", "password": "pw", "provider": "basic"}) for pid in ("p", "q")}
        server._auto = hub_auto.Auto(relay.Bridge(server._registry, hub_factory=lambda pod: None), lambda pid: HermesAPI(cls.auths[pid]))
        with office.connect() as conn:
            conn.execute("DELETE FROM office_seats")
        office.set_seat({"pod": "p", "profile": "sa", "alias": "kf-mine"}, "me", {"p": {"sa"}, "q": {"sb"}})
        office.set_seat({"pod": "q", "profile": "sb", "alias": "kf-other"}, "me", {"p": {"sa"}, "q": {"sb"}})
        with hub_auto._db() as conn:
            conn.execute("INSERT INTO office_boards (slug, name, ts) VALUES (?,?,?) ON CONFLICT DO NOTHING", (BOARD, BOARD, "now"))
            for tid, pod, who in (("t_mine", "p", "kf-mine"), ("t_other", "q", "kf-other"), ("t_free", "p", "")):
                conn.execute("INSERT INTO office_cards (board, task_id, pod, status, assignee) VALUES (?,?,?,?,?)", (BOARD, tid, pod, "done", who))
        cls.app = aasserver.start()

    @classmethod
    def tearDownClass(cls):
        cls.app.shutdown()
        cls.hermes.shutdown()
        with hub_auto._db() as conn:
            conn.execute("DELETE FROM office_cards WHERE board=?", (BOARD,))
            conn.execute("DELETE FROM office_boards WHERE slug=?", (BOARD,))
        with office.connect() as conn:
            conn.execute("DELETE FROM office_seats")
        with store.connect() as conn:
            conn.execute("DELETE FROM usage WHERE kind='kanban_attachment_download'")
        server._auth, server._registry, server._auto = cls.old
        server._hubs.clear(); server._cache.clear()

    def setUp(self):
        self.hermes.down = self.hermes.no_length = False
        self.as_user("u@example.com")

    def as_user(self, email, admin=False):
        reg = server._registry
        old = (server._auth, reg.is_admin)

        class On:
            enabled = True
            def user(s, cookie): return {"email": email, "name": ""} if email else None
        server._auth = On(); reg.is_admin = lambda u: admin
        self.addCleanup(lambda: (setattr(server, "_auth", old[0]), setattr(reg, "is_admin", old[1])))

    def req(self, method, task, att, board=BOARD):
        c = http.client.HTTPConnection("127.0.0.1", self.app.server_port, timeout=10)
        c.request(method, f"/api/office/kanban/tasks/{task}/attachments/{att}?board={board}", headers={"X-AAS": "1"})
        r = c.getresponse()
        body = r.read()
        c.close()
        return r, body

    def test_get_streams_the_file_with_safe_headers(self):
        r, body = self.req("GET", "t_mine", 11)
        self.assertEqual((r.status, body), (200, b"<html>hi</>"))
        self.assertEqual(r.getheader("Content-Type"), "application/octet-stream")       # Hermes 의 text/html 을 쓰지 않는다
        self.assertEqual(r.getheader("X-Content-Type-Options"), "nosniff")
        self.assertEqual(r.getheader("Cache-Control"), "no-store")
        cd = r.getheader("Content-Disposition")
        self.assertEqual(cd, "attachment; filename=\"download\"; filename*=UTF-8''" + urllib.parse.quote(NAME, safe=""))
        self.assertNotIn("\n", cd)
        self.assertNotIn('"b', cd)                                                      # 이름의 따옴표가 머리를 깨지 않는다
        self.assertEqual(urllib.parse.unquote(cd.split("UTF-8''", 1)[1]), NAME)
        with store.connect() as conn:
            notes = [row["note"] for row in conn.execute("SELECT note FROM usage WHERE kind='kanban_attachment_download'")]
        self.assertIn(f"u@example.com {BOARD} t_mine 11", notes)

    def test_head_checks_without_a_body(self):
        r, body = self.req("HEAD", "t_mine", 11)
        self.assertEqual((r.status, body), (200, b""))

    def test_attachment_of_another_card_is_not_found(self):
        self.as_user("root@example.com", admin=True)
        for method in ("HEAD", "GET"):
            r, body = self.req(method, "t_mine", 21)                                    # 21 은 t_other 의 첨부(Hermes 는 보드 단위로 준다)
            self.assertEqual((r.status, r.getheader("X-AAS-Code"), body), (404, "not_found", b""))

    def test_user_who_cannot_use_the_assignee_is_forbidden(self):
        for method in ("HEAD", "GET"):
            r, body = self.req(method, "t_other", 21)
            self.assertEqual((r.status, r.getheader("X-AAS-Code"), body), (403, "forbidden", b""))
        self.as_user("root@example.com", admin=True)
        self.assertEqual(self.req("GET", "t_other", 21)[0].status, 200)

    def test_card_without_an_assignee_follows_the_card_detail_rule(self):
        r, body = self.req("GET", "t_free", 31)                                         # R7: 담당이 비면 카드 상세처럼 막지 않는다
        self.assertEqual((r.status, body), (200, b"free"))

    def test_over_25mb_is_refused(self):
        for method in ("HEAD", "GET"):
            r, _ = self.req(method, "t_mine", 12)
            self.assertEqual((r.status, r.getheader("X-AAS-Code")), (413, "too_large"))

    def test_stream_is_cut_when_hermes_sends_more_than_the_limit(self):
        self.hermes.no_length = True                                                    # 길이를 알리지 않고 목록 크기(3)보다 많이(11) 보낸다
        att = self.hermes.tasks["t_mine"][0]
        att["size"] = 3
        self.addCleanup(att.update, {"size": 11})
        with mock.patch.object(kanban_files, "MAX_BYTES", 5):
            c = http.client.HTTPConnection("127.0.0.1", self.app.server_port, timeout=10)
            c.request("GET", f"/api/office/kanban/tasks/t_mine/attachments/11?board={BOARD}")
            r = c.getresponse()
            self.assertEqual(r.status, 200)
            with self.assertRaises((http.client.IncompleteRead, ConnectionError)):
                r.read()
            c.close()

    def test_transfer_limit_is_busy(self):
        taken = 0
        while web_files.SLOTS.take():
            taken += 1
        try:
            for method in ("HEAD", "GET"):
                r, _ = self.req(method, "t_mine", 11)
                self.assertEqual((r.status, r.getheader("X-AAS-Code")), (429, "busy"))
        finally:
            for _ in range(taken):
                web_files.SLOTS.give()

    def test_expired_hermes_session_logs_in_again(self):
        self.req("GET", "t_mine", 11)
        before = self.hermes.logins
        self.hermes.tokens.clear()                                                        # Hermes 가 세션을 버렸다
        r, body = self.req("GET", "t_mine", 11)
        self.assertEqual((r.status, body), (200, b"<html>hi</>"))
        self.assertGreater(self.hermes.logins, before)

    def test_file_missing_on_hermes_is_not_found(self):
        r, body = self.req("GET", "t_mine", 13)                                          # 목록에는 있지만 Hermes 가 404
        self.assertEqual((r.status, r.getheader("X-AAS-Code"), body), (404, "not_found", b""))

    def test_hermes_down_is_agent_unreachable(self):
        self.hermes.down = True
        r, _ = self.req("GET", "t_mine", 11)
        self.assertEqual((r.status, r.getheader("X-AAS-Code")), (503, "agent_unreachable"))

    def test_not_signed_in_and_head_without_x_aas(self):
        self.as_user("")
        r, _ = self.req("GET", "t_mine", 11)
        self.assertEqual((r.status, r.getheader("X-AAS-Code")), (401, "login"))
        self.as_user("u@example.com")
        c = http.client.HTTPConnection("127.0.0.1", self.app.server_port, timeout=10)
        c.request("HEAD", f"/api/office/kanban/tasks/t_mine/attachments/11?board={BOARD}")
        self.assertEqual(c.getresponse().status, 403)
        c.close()

    def test_card_detail_lists_attachments_without_stored_path(self):
        d = server._auto.detail(BOARD, "t_mine")
        self.assertEqual([a["id"] for a in d["attachments"]], [13, 12, 11])
        self.assertNotIn("stored_path", json.dumps(d))
        self.assertEqual(d["attachments"][0]["uploaded_by"], "kf-mine")


if __name__ == "__main__":
    unittest.main()

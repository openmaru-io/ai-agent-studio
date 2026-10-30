# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""오피스 상태·스트림 HTTP 시험(계획 003 §3 A안) — 실제 서버를 띄워 /api/office/state, /api/office/stream 을 본다."""
import aasserver  # 실제 uvicorn 앱을 띄우는 시험 하네스(OMAI-1100)
import http.client
import json
import os
import tempfile
import threading
import unittest
from http.server import ThreadingHTTPServer
from pathlib import Path

TMP = tempfile.TemporaryDirectory()
os.environ.setdefault("AAS_DATA_DIR", str(Path(TMP.name) / "data"))

from aas.auth import auth
from aas.office import hub_auto, office, office_state, relay
from aas.fleet import pods
from aas.web import server  # noqa: E402

try:
    from tests.test_hub_auto import FakeDash  # noqa: E402
except ImportError:                                            # unittest discover -s tests 로 돌릴 때
    from test_hub_auto import FakeDash  # noqa: E402


def read_events(resp, want: int, timeout: float = 5.0) -> list[dict]:
    """SSE 본문에서 data: 줄을 want 개 읽는다(keepalive 주석은 건너뛴다)."""
    out, cur = [], {}
    resp.fp.raw._sock.settimeout(timeout)
    while len(out) < want:
        line = resp.fp.readline().decode()
        if not line:
            break
        line = line.rstrip("\n")
        if line.startswith("id:"):
            cur["id"] = int(line[3:].strip())
        elif line.startswith("data:"):
            cur["data"] = json.loads(line[5:].strip())
        elif line == "" and "data" in cur:
            out.append(cur)
            cur = {}
    return out


class OfficeApiTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.old = {k: os.environ.get(k) for k in ("AAS_USERS_FILE", "AAS_ALLOWED_HOSTS", "AAS_PODS_FILE", "AAS_OIDC_ISSUER")}
        for k in cls.old:
            os.environ.pop(k, None)
        home = Path(TMP.name) / "hermes"
        (home / "profiles" / "ma").mkdir(parents=True, exist_ok=True)
        (home / "profiles" / "ops").mkdir(parents=True, exist_ok=True)
        reg = Path(TMP.name) / "pods.json"
        reg.write_text(json.dumps({"pods": [{"id": "t", "owner": "t@example.com", "hermes_home": str(home)}]}))
        server._auth = auth.Auth({"issuer": "https://accounts.google.com", "client_id": "", "client_secret": "", "domain": "",
                                  "public_url": "http://localhost:17900", "hours": 1, "users_file": Path(TMP.name) / "no-users.json"})
        server._registry = pods.Registry(reg)
        server.OFFICE = office_state.Office()                  # 시험마다 새 버스
        office.set_seat({"pod": "t", "profile": "ma", "alias": "ma", "title": "마케팅"}, "t", {"t": {"ma", "ops"}})
        office.set_seat({"pod": "t", "profile": "ops", "alias": "ops"}, "t", {"t": {"ma", "ops"}})
        cls.httpd = aasserver.start()
        cls.port = cls.httpd.server_port

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        for k, v in cls.old.items():
            if v is not None:
                os.environ[k] = v

    def send(self, method, path, body=None):
        c = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        c.request(method, path, body=json.dumps(body) if body is not None else None, headers={"X-AAS": "1"})
        r = c.getresponse()
        out = json.loads(r.read() or b"{}")
        c.close()
        return r.status, out

    def get(self, path, headers=None):
        c = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        c.request("GET", path, headers=headers or {})
        return c, c.getresponse()

    def test_state_는_자리마다_상태와_소개를_준다(self):
        c, r = self.get("/api/office/state")
        body = json.loads(r.read())
        c.close()
        self.assertEqual(r.status, 200)
        byname = {a["alias"]: a for a in body["agents"]}
        self.assertLessEqual({"ma", "ops"}, set(byname))              # 같은 데이터 폴더를 쓰는 다른 시험의 자리가 섞여 있을 수 있다
        self.assertEqual(byname["ma"]["title"], "마케팅")
        self.assertIn(byname["ma"]["status"], {"idle", "working", "error"})
        self.assertIn("seq", body)

    def test_채팅이_진행_중이면_working_으로_보인다(self):
        server.OFFICE.tracker.on_chat("sx", "t", "ops", "aas.user", {})
        try:
            c, r = self.get("/api/office/state")
            body = json.loads(r.read())
            c.close()
            self.assertEqual({a["alias"]: a["status"] for a in body["agents"]}["ops"], "working")
        finally:
            server.OFFICE.tracker.on_chat("sx", "t", "ops", "message.complete", {})

    def test_stream_은_처음에_snapshot_을_주고_이어서_이벤트를_흘린다(self):
        c, r = self.get("/api/office/stream")
        self.assertEqual(r.status, 200)
        self.assertIn("text/event-stream", r.getheader("Content-Type"))
        first = read_events(r, 1)[0]
        self.assertEqual(first["data"]["type"], "snapshot")
        self.assertLessEqual({"ma", "ops"}, {a["alias"] for a in first["data"]["payload"]["agents"]})
        seq = server.OFFICE.bus.publish("tool", {"alias": "ma", "name": "web"})
        ev = read_events(r, 1)[0]
        self.assertEqual((ev["id"], ev["data"]["type"], ev["data"]["payload"]["name"]), (seq, "tool", "web"))
        c.close()

    def test_Last_Event_ID_로_이어_받으면_snapshot_없이_그_뒤_이벤트만_온다(self):
        a = server.OFFICE.bus.publish("tool", {"alias": "ma", "name": "one"})
        b = server.OFFICE.bus.publish("tool", {"alias": "ma", "name": "two"})
        c, r = self.get("/api/office/stream", {"Last-Event-ID": str(a)})
        ev = read_events(r, 1)[0]
        c.close()
        self.assertEqual((ev["id"], ev["data"]["type"], ev["data"]["payload"]["name"]), (b, "tool", "two"))

    def test_밀려난_이벤트를_이어_받으려_하면_snapshot_부터_다시_준다(self):
        keep, server.OFFICE = server.OFFICE, office_state.Office()
        server.OFFICE.bus = office_state.OfficeBus(keep=2)
        server.OFFICE.tracker.bus = server.OFFICE.bus
        try:
            for i in range(5):
                server.OFFICE.bus.publish("tool", {"alias": "ma", "name": str(i)})
            c, r = self.get("/api/office/stream", {"Last-Event-ID": "1"})
            first = read_events(r, 1)[0]
            c.close()
            self.assertEqual(first["data"]["type"], "snapshot")
        finally:
            server.OFFICE = keep

    def test_다른_출처에서_온_스트림_요청은_막는다(self):
        c, r = self.get("/api/office/stream", {"Sec-Fetch-Site": "cross-site"})
        r.read()
        c.close()
        self.assertEqual(r.status, 403)

    def test_칸반_크론_API_가_서버_경로로_열려_있다(self):
        dash = FakeDash("t")
        server._auto = hub_auto.Auto(relay.Bridge(server.registry(), lambda pod: None), lambda pod: dash)
        with hub_auto._db() as conn:
            for t in ("office_boards", "office_board_pods", "office_cards", "office_events", "office_cron"):
                conn.execute(f"DELETE FROM {t}")
        try:
            board = "office-0123456789abcdef"
            self.assertEqual(self.send("POST", "/api/office/kanban/boards", {"slug": board, "name": "오피스"})[0], 201)
            st, made = self.send("POST", f"/api/office/kanban/tasks?board={board}", {"title": "견적서", "assignee": "ma"})
            self.assertEqual((st, made["task"]["assignee"]), (201, "ma"))
            tid = made["task"]["id"]
            st, view = self.send("GET", f"/api/office/kanban/board?board={board}")
            self.assertEqual(st, 200)
            self.assertEqual([t["id"] for col in view["columns"] if col["name"] == "ready" for t in col["tasks"]], [tid])
            self.assertEqual(self.send("PATCH", f"/api/office/kanban/tasks/{tid}?board={board}", {"title": "견적서 2"})[0], 200)
            # 진행 칸의 카드는 담당 자리를 working 으로 만든다
            self.assertEqual(self.send("POST", f"/api/office/kanban/dispatch?board={board}", {})[0], 200)
            server._cache.pop("t:running", None)
            c, r = self.get("/api/office/state")
            states = {a["alias"]: a["status"] for a in json.loads(r.read())["agents"]}
            c.close()
            self.assertEqual(states["ma"], "working")
            self.assertEqual(self.send("DELETE", f"/api/office/kanban/tasks/{tid}?board={board}")[1], {"ok": True})
            st, jobs = self.send("GET", "/api/office/cron/ma/jobs")
            self.assertEqual((st, jobs), (200, {"jobs": []}))
            self.assertEqual(self.send("GET", "/api/office/cron/ghost/jobs")[1]["error"], "profile_not_found")
            self.assertEqual(self.send("GET", f"/api/office/kanban/board?board=nope")[0], 404)
            st, ev = self.send("GET", f"/api/office/events?board={board}")
            self.assertEqual(st, 200)
            self.assertIn("cursor", ev)
        finally:
            server._auto = None

    def test_회의_API_는_거절_사유를_본문에_준다(self):
        server._auto = hub_auto.Auto(relay.Bridge(server.registry(), lambda pod: None), lambda pod: FakeDash("t"))
        server._meeting_obj = None
        try:
            self.assertEqual(self.send("GET", "/api/office/meeting?room=999")[0], 404)
            self.assertEqual(self.send("GET", "/api/office/meeting?room=abc")[0], 400)
            rid = office.set_room({"name": "시험 방", "seats": []}, "t")["id"]
            st, out = self.send("POST", "/api/office/meeting/say", {"room": rid, "text": "안녕"})
            self.assertEqual(st, 409)
            self.assertIn("앉은 AI 에이전트가 없습니다", out["error"])
            self.assertEqual(self.send("POST", "/api/office/meeting/say", {"room": rid, "text": " "})[0], 400)
            st, view = self.send("GET", f"/api/office/meeting?room={rid}")
            self.assertEqual((st, view["room"]["name"], view["messages"], view["pending"]), (200, "시험 방", [], []))
            office.delete_room(rid)
        finally:
            server._auto, server._meeting_obj = None, None

    def test_회의_새_대화와_지난_대화_API(self):
        """스펙 2026-10-20-027 S8: 새 대화 → 차례 목록 → 지난 차례 읽기. 다른 방의 차례는 404, 끝난 방은 409 closed."""
        server._auto = hub_auto.Auto(relay.Bridge(server.registry(), lambda pod: None), lambda pod: FakeDash("t"))
        server._meeting_obj = None
        rid = office.set_room({"name": "새 대화 방", "seats": []}, "t")["id"]
        other = office.set_room({"name": "다른 방", "seats": []}, "t")["id"]
        closed = office.set_room({"name": "끝난 방", "seats": [], "status": "closed"}, "t")["id"]
        try:
            st, out = self.send("POST", "/api/office/meeting/new", {"room": rid})
            self.assertEqual(st, 200)
            tid = out["thread"]
            st, view = self.send("GET", f"/api/office/meeting?room={rid}")
            self.assertEqual((st, view["thread"], view["viewing"]), (200, tid, tid))
            self.assertEqual([m["kind"] for m in view["messages"]], ["thread_started"])
            st, got = self.send("GET", f"/api/office/meeting/threads?room={rid}")
            self.assertEqual((st, got["current"], [t["id"] for t in got["threads"]]), (200, tid, [tid]))
            self.assertEqual(self.send("GET", f"/api/office/meeting?room={rid}&thread=0")[0], 200)
            other_tid = self.send("POST", "/api/office/meeting/new", {"room": other})[1]["thread"]
            st, err = self.send("GET", f"/api/office/meeting?room={rid}&thread={other_tid}")
            self.assertEqual((st, err.get("reason")), (404, "not_found"))
            st, err = self.send("POST", "/api/office/meeting/new", {"room": closed})
            self.assertEqual((st, err.get("reason")), (409, "closed"))
        finally:
            from aas.office import meeting
            with meeting._db() as conn:
                for r in (rid, other, closed):
                    conn.execute("DELETE FROM office_messages WHERE room=?", (r,))
                    conn.execute("DELETE FROM office_meeting_threads WHERE room=?", (r,))
            for r in (rid, other, closed):
                office.delete_room(r)
            server._auto, server._meeting_obj = None, None

    def test_오피스_대화의_지난_말을_읽는다(self):
        """새로 고친 뒤 대화 창을 다시 채우는 경로(2026-10-16 사용자 보고). 대화가 없으면 빈 목록이고 Hermes 에 가지 않는다."""
        server._auto = hub_auto.Auto(relay.Bridge(server.registry(), lambda pod: None), lambda pod: FakeDash("t"))
        try:
            self.assertEqual(self.send("GET", "/api/office/chat/history?alias=ma"), (200, {"messages": [], "turn": None}))
            self.assertEqual(self.send("GET", "/api/office/chat/history?alias=ghost")[0], 404)
        finally:
            server._auto = None

    def test_칸반_바꾸기는_다른_사이트가_보낼_수_없다(self):
        c = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        c.request("DELETE", "/api/office/kanban/tasks/t_x?board=b")      # X-AAS 헤더가 없다
        self.assertEqual(c.getresponse().status, 403)
        c.close()
        c = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        c.request("PUT", "/api/office/state", headers={"X-AAS": "1"})    # 칸반·크론 밖의 경로는 PUT 을 받지 않는다
        self.assertEqual(c.getresponse().status, 404)
        c.close()


if __name__ == "__main__":
    unittest.main()

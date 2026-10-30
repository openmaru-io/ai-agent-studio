# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""웹소켓 /ws 와 토픽 허브 시험(OMAI-1100 W0·W1). 실제 uvicorn 서버에 websockets 클라이언트로 붙는다."""
import aasserver  # 실제 uvicorn 앱을 띄우는 시험 하네스
import asyncio
import http.client
import json
import os
import signal
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest import mock

TMP = tempfile.TemporaryDirectory()
os.environ.setdefault("AAS_DATA_DIR", str(Path(TMP.name) / "data"))

from websockets.exceptions import ConnectionClosed, InvalidStatus  # noqa: E402
from websockets.sync.client import connect  # noqa: E402

from aas.auth import auth  # noqa: E402
from aas.fleet import pods  # noqa: E402
from aas.web import protocol, server, topics, ws  # noqa: E402

ADMIN, ALICE, BOB = "boss@example.com", "alice@example.com", "bob@example.com"


class WsBase(unittest.TestCase):
    """실제 서버·로그인·등록부를 준비하고 연결 도우미를 둔다(시험은 하위 클래스에)."""

    @classmethod
    def setUpClass(cls):
        cls.old = {k: os.environ.get(k) for k in ("AAS_USERS_FILE", "AAS_ALLOWED_HOSTS", "AAS_PODS_FILE", "AAS_OIDC_ISSUER", "AAS_WS", "AAS_TRUSTED_PROXY")}
        for k in cls.old:
            os.environ.pop(k, None)
        os.environ["AAS_WS"] = "on"
        root = Path(TMP.name)
        for name in ("a", "b"):
            (root / f"home_{name}" / "profiles").mkdir(parents=True, exist_ok=True)
        reg = root / "pods.json"
        reg.write_text(json.dumps({"admins": [ADMIN], "pods": [
            {"id": "a", "owner": ALICE, "hermes_home": str(root / "home_a")},
            {"id": "b", "owner": BOB, "hermes_home": str(root / "home_b")}]}))
        users = root / "users.json"
        users.write_text(json.dumps({"users": [{"email": ALICE, "password_hash": "x"}]}))
        server._auth = auth.Auth({"issuer": "https://accounts.google.com", "client_id": "", "client_secret": "", "domain": "",
                                  "public_url": "http://localhost:17900", "hours": 1, "users_file": users})
        server._registry = pods.Registry(reg)
        cls.httpd = aasserver.start()
        cls.port = cls.httpd.server_port
        cls.url = f"ws://127.0.0.1:{cls.port}/ws"
        cls.origin = f"http://127.0.0.1:{cls.port}"
        cls.health_calls = 0

        def fake_health(pod):
            cls.health_calls += 1
            return {"pod": pod.id, "totals": {"jobs": 1}, "stalled": []}
        cls.patches = [mock.patch.object(server, "health_payload", side_effect=fake_health)]
        for p in cls.patches:
            p.start()

    @classmethod
    def tearDownClass(cls):
        for p in cls.patches:
            p.stop()
        cls.httpd.shutdown()
        for k, v in cls.old.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        server._auth = server._registry = None

    # ---- 도우미 ----------------------------------------------------------------
    def session(self, email):
        return f"aas_session={server.auth()._new_session(email, email.split('@')[0])}"

    def open(self, email=ALICE, origin=None, hello=True, headers=None, lang="ko"):
        h = {"Cookie": self.session(email)} if email else {}
        h.update(headers or {})
        c = connect(self.url, origin=self.origin if origin is None else (origin or None), additional_headers=h, open_timeout=5)
        if hello:
            c.send(json.dumps({"v": 1, "t": "hello", "lang": lang, "resume": []}))
            w = self.recv(c, "welcome")
            self.assertEqual(w["server"], ws.STARTED)
        return c

    def recv(self, c, want=None, timeout=5.0):
        deadline = time.time() + timeout
        while True:
            msg = json.loads(c.recv(timeout=max(0.05, deadline - time.time())))
            if want is None or msg["t"] == want:
                return msg

    def closed_code(self, c, timeout=5.0):
        """bye 를 받고 닫힐 때까지 읽어 (bye 코드, close 코드) 를 돌려준다."""
        bye = None
        try:
            deadline = time.time() + timeout
            while time.time() < deadline:
                msg = json.loads(c.recv(timeout=max(0.05, deadline - time.time())))
                if msg["t"] == "bye":
                    bye = msg["code"]
        except ConnectionClosed:
            pass
        return bye, c.close_code

    def run_on_server(self, coro):
        return asyncio.run_coroutine_threadsafe(coro, self.httpd.loop).result(10)


class WsTest(WsBase):
    # ---- 핸드셰이크 -------------------------------------------------------------
    def test_feature_flag_off_refuses_before_accept(self):
        with mock.patch.dict(os.environ, {"AAS_WS": "off"}):
            with self.assertRaises(InvalidStatus) as cm:
                self.open(hello=False)
        self.assertEqual(cm.exception.response.status_code, 403)

    def test_websocket_is_on_unless_turned_off(self):
        with mock.patch.dict(os.environ, {}, clear=False):
            os.environ.pop("AAS_WS", None)
            with mock.patch.object(server.config, "read_env_file", return_value={}):
                self.assertTrue(server.ws_enabled())                     # 설정이 없으면 켜진다
            for off in ("off", "0", "false", "no", "OFF"):
                os.environ["AAS_WS"] = off
                self.assertFalse(server.ws_enabled())
            os.environ["AAS_WS"] = "on"

    def test_disallowed_host_refuses_before_accept(self):
        with mock.patch.dict(os.environ, {"AAS_ALLOWED_HOSTS": "only.example.com"}):
            with self.assertRaises(InvalidStatus):
                self.open(hello=False)

    def test_origin_is_required_and_must_match(self):
        bad = [False, "null", "http://evil.example.com", f"http://sub.127.0.0.1:{self.port}", "http://127.0.0.1:1", f"https://127.0.0.1:{self.port}"]
        for origin in bad:
            with self.subTest(origin=origin):
                c = self.open(origin=origin, hello=False)
                self.assertEqual(self.closed_code(c), (4403, 4403))

    def test_cross_site_fetch_metadata_is_refused(self):
        c = self.open(hello=False, headers={"Sec-Fetch-Site": "same-site"})
        self.assertEqual(self.closed_code(c), (4403, 4403))

    def test_no_session_closes_with_4401(self):
        c = self.open(email=None, hello=False)
        self.assertEqual(self.closed_code(c), (4401, 4401))

    def test_hello_must_come_first_and_within_time(self):
        c = self.open(hello=False)
        c.send(json.dumps({"v": 1, "t": "sub", "topic": "agents"}))
        self.assertEqual(self.closed_code(c)[1], 1008)
        with mock.patch.object(ws, "HELLO_TIMEOUT", 0.3):
            c = self.open(hello=False)
            self.assertEqual(self.closed_code(c)[1], 1008)

    # ---- 메시지 ----------------------------------------------------------------
    def test_bad_and_unknown_messages_do_not_close(self):
        c = self.open()
        c.send("{not json")
        self.assertEqual(self.recv(c, "error")["code"], "bad_message")
        c.send(json.dumps({"v": 1, "t": "something-new"}))      # 앞뒤 판이 섞여도 무시한다
        c.send(json.dumps({"v": 1, "t": "sub", "topic": "nope"}))
        err = self.recv(c, "error")
        self.assertEqual((err["code"], err["topic"]), ("unknown_topic", "nope"))
        c.close()

    def test_rate_limit_closes_with_1008(self):
        c = self.open()
        try:
            for _ in range(60):
                c.send(json.dumps({"v": 1, "t": "ping"}))
        except ConnectionClosed:
            pass                                                # 느린 장비에서는 서버가 먼저 닫아 남은 보내기가 실패한다
        self.assertEqual(self.closed_code(c)[1], 1008)

    def test_too_big_message_closes_with_1009(self):
        c = self.open()
        c.send(json.dumps({"v": 1, "t": "ping", "pad": "x" * 70000}))
        self.assertEqual(self.closed_code(c)[1], 1009)

    # ---- 토픽 ------------------------------------------------------------------
    def test_agents_topic_and_invalidation_reach_another_tab(self):
        """에이전트가 생기면 다른 탭에 2초 안에 나타난다(W1 수용 기준)."""
        reg = server.registry()
        c1, c2 = self.open(), self.open()
        for c in (c1, c2):
            c.send(json.dumps({"v": 1, "t": "sub", "topic": "agents"}))
            snap = self.recv(c, "snap")
            self.assertEqual(snap["topic"], "agents")
            self.assertEqual(snap["data"]["agents"], [])
        started = time.time()
        reg.agents.append({"name": "aas-agent-x", "owner": ALICE, "ready": True})
        try:
            topics.invalidate("agents")
            snap = self.recv(c2, "snap", timeout=2)
            self.assertEqual([a["name"] for a in snap["data"]["agents"]], ["aas-agent-x"])
            self.assertLess(time.time() - started, 2)
        finally:
            reg.agents.clear()
            c1.close(); c2.close()

    def test_agents_view_is_filtered_per_user(self):
        reg = server.registry()
        reg.agents.extend([{"name": "mine", "owner": ALICE, "ready": True}, {"name": "theirs", "owner": BOB, "ready": True}])
        try:
            alice, boss = self.open(ALICE), self.open(ADMIN)
            for c in (alice, boss):
                c.send(json.dumps({"v": 1, "t": "sub", "topic": "agents"}))
            self.assertEqual([a["name"] for a in self.recv(alice, "snap")["data"]["agents"]], ["mine"])
            self.assertEqual([a["name"] for a in self.recv(boss, "snap")["data"]["agents"]], ["mine", "theirs"])
            alice.close(); boss.close()
        finally:
            reg.agents.clear()

    def test_pod_topic_needs_access_and_adds_dashboard_url(self):
        c = self.open(ALICE)
        c.send(json.dumps({"v": 1, "t": "sub", "topic": "pod:a:health"}))
        snap = self.recv(c, "snap")
        self.assertEqual(snap["data"]["pod"], "a")
        self.assertTrue(snap["data"]["dashboard_url"].startswith("http://127.0.0.1:"))
        c.send(json.dumps({"v": 1, "t": "sub", "topic": "pod:b:health"}))
        err = self.recv(c, "error")
        self.assertEqual((err["code"], err["topic"]), ("forbidden", "pod:b:health"))
        c.close()

    def test_mcp_login_topic_pushes_states_and_marks_who_started(self):
        # 로그인 상태를 화면이 3초마다 다시 읽지 않고 서버가 바뀌면 보낸다(스펙 2026-10-16-010 14-22)
        from aas.ops import mcp_oauth_relay as relay
        alice_key = relay._user_key(server.auth().user(self.session(ALICE)))[0]
        snap_value = {"servers": {"jira": {"state": "logging_in", "mine": False, "_by": alice_key},
                                  "docs": {"state": "connected", "tools": 2}}}
        with mock.patch.object(server, "mcp_login_snapshot", return_value=snap_value) as snap:
            alice, boss = self.open(ALICE), self.open(ADMIN)
            for c in (alice, boss):
                c.send(json.dumps({"v": 1, "t": "sub", "topic": "pod:a:mcp:main"}))
            got_a, got_b = self.recv(alice, "snap")["data"]["servers"], self.recv(boss, "snap")["data"]["servers"]
            self.assertEqual(got_a["jira"], {"state": "logging_in", "mine": True})        # 시작한 사람만 mine, _by 는 보내지 않는다
            self.assertEqual(got_b["jira"], {"state": "logging_in", "mine": False})
            self.assertEqual(got_a["docs"], {"state": "connected", "tools": 2})
            self.assertEqual(snap.call_args.args[1], "main")
            alice.send(json.dumps({"v": 1, "t": "sub", "topic": "pod:b:mcp:main"}))
            err = self.recv(alice, "error")
            self.assertEqual((err["code"], err["topic"]), ("forbidden", "pod:b:mcp:main"))
            alice.close(); boss.close()

    def test_mcp_login_topic_reads_often_only_while_a_login_settles(self):
        self.assertEqual(ws._mcp_login_interval({"servers": {"a": {"state": "logging_in", "connecting": True}}}), 2.0)
        self.assertEqual(ws._mcp_login_interval({"servers": {"a": {"state": "connected"}}}), 30.0)
        self.assertEqual(ws._mcp_login_interval(None), 30.0)
        self.assertIsNone(ws.resolve("pod:a:mcp:../x"))

    def test_login_change_wakes_the_mcp_login_topic(self):
        with mock.patch.object(server.topics, "invalidate") as inv:
            server._forget_mcp_login("a", "main")
        inv.assert_any_call("pod:a:mcp:main")

    def test_same_topic_is_read_once_for_many_subscribers(self):
        before = type(self).health_calls
        conns = [self.open(ADMIN) for _ in range(5)]
        for c in conns:
            c.send(json.dumps({"v": 1, "t": "sub", "topic": "pod:b:health"}))
        for c in conns:
            self.recv(c, "snap")
        self.assertLessEqual(type(self).health_calls - before, 2)
        for c in conns:
            c.close()

    def test_resume_with_current_seq_sends_nothing(self):
        c = self.open(ADMIN)
        c.send(json.dumps({"v": 1, "t": "sub", "topic": "pod:a:health"}))
        seq = self.recv(c, "snap")["seq"]
        c.close()
        c = self.open(ADMIN, hello=False)
        c.send(json.dumps({"v": 1, "t": "hello", "lang": "ko", "resume": [{"topic": "pod:a:health", "after": seq}]}))
        self.recv(c, "welcome")
        with self.assertRaises(TimeoutError):
            self.recv(c, "snap", timeout=0.5)
        c.close()

    def test_unsubscribed_topic_has_no_subscriber_left(self):
        c = self.open()
        c.send(json.dumps({"v": 1, "t": "sub", "topic": "pod:a:health"}))
        self.recv(c, "snap")
        c.close()
        deadline = time.time() + 3
        while topics.hub().subscriber_count("pod:a:health") and time.time() < deadline:
            time.sleep(0.05)
        self.assertEqual(topics.hub().subscriber_count("pod:a:health"), 0)

    # ---- 권한·세션 --------------------------------------------------------------
    def test_permission_change_unsubscribes_and_revoked_admin_is_closed(self):
        reg = server.registry()
        reg.grant(BOB, "user", ["a", "b"], ADMIN)
        bob = self.open(BOB)
        bob.send(json.dumps({"v": 1, "t": "sub", "topic": "pod:a:health"}))
        self.recv(bob, "snap")
        reg.grant(BOB, "user", ["b"], ADMIN)                       # a 를 뺀다 — 세션은 남는다
        topics.user_changed(BOB)
        err = self.recv(bob, "error")
        self.assertEqual((err["code"], err["topic"]), ("forbidden", "pod:a:health"))
        bob.close()
        reg.grant("carol@example.com", "admin", [], ADMIN)
        carol = self.open("carol@example.com")
        reg.grant("carol@example.com", "user", ["b"], ADMIN)
        topics.user_changed("carol@example.com")
        self.assertEqual(self.closed_code(carol), (4403, 4403))
        reg.grant(BOB, "none", [], ADMIN)

    def test_logout_elsewhere_closes_with_4401(self):
        c = self.open(ALICE)
        with server.store.connect() as conn:
            conn.execute("DELETE FROM auth_sessions WHERE email=?", (ALICE,))
        topics.user_changed(ALICE)
        self.assertEqual(self.closed_code(c), (4401, 4401))

    # ---- 한 번 읽기(W4) ----------------------------------------------------------
    def req(self, c, rid, path, method="get"):
        c.send(json.dumps({"v": 1, "t": "req", "id": rid, "method": method, "params": {"path": path}}))
        while True:
            msg = self.recv(c, "res")
            if msg["id"] == rid:
                return msg

    def test_req_get_runs_the_same_handler_as_http(self):
        c = self.open(ALICE, lang="en")
        res = self.req(c, "1", "/api/me")
        self.assertTrue(res["ok"])
        self.assertEqual((res["data"]["status"], res["data"]["body"]["user"]["email"]), (200, ALICE))
        res = self.req(c, "2", "/api/users")                     # 관리자만 — HTTP 와 같은 403 과 요청 언어의 문장
        self.assertEqual(res["data"]["status"], 403)
        self.assertEqual(res["data"]["body"]["error"], "Only admins can view this")
        c.close()

    def test_req_get_follows_the_pod_chosen_over_http_after_the_connection_opened(self):
        """연결을 연 뒤 HTTP 로 /api/pod 를 바꾸면 그 연결의 읽기(req)도 새 에이전트를 본다(2026-10-18).
        예전에는 연결을 열 때의 쿠키(aas_pod)를 그대로 써서, 화면이 새로고침 없이 에이전트를 바꾸면 데이터가 옛 에이전트 것으로 남았다."""
        session = self.session(ADMIN)
        c = self.open(None, headers={"Cookie": f"{session}; aas_pod=a"})
        self.assertEqual(self.req(c, "1", "/api/me")["data"]["body"]["pod"]["id"], "a")
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        conn.request("POST", "/api/pod", body=json.dumps({"id": "b"}), headers={"Cookie": f"{session}; aas_pod=a", "X-AAS": "1"})
        r = conn.getresponse()
        r.read()
        conn.close()
        self.assertEqual(r.status, 200)
        self.assertEqual(self.req(c, "2", "/api/me")["data"]["body"]["pod"]["id"], "b")
        other = self.open(None, headers={"Cookie": f"{self.session(ALICE)}; aas_pod=a"})            # 다른 사람의 연결은 바뀌지 않는다
        self.assertEqual(self.req(other, "3", "/api/me")["data"]["body"]["pod"]["id"], "a")
        other.close()
        c.close()

    def test_req_refuses_streams_other_paths_and_methods(self):
        c = self.open(ALICE)
        for rid, path, method in (("a", "/api/office/stream", "get"), ("b", "/auth/logout", "get"), ("c", "/api/me", "post"),
                                  ("d", "/api/me HTTP/1.1\r\nX: y", "get")):
            res = self.req(c, rid, path, method)
            self.assertFalse(res["ok"])
            self.assertIn(res["error"]["code"], ("bad_path", "unknown_method"))
        c.close()

    def test_req_refuses_paths_only_the_starlette_routes_serve(self):
        # 회의 파일 목록(/api/office/meeting/files)은 Starlette 라우트만 처리한다. 웹소켓 req 가 옛 Handler 로 보내면 404 not_found 가 나와
        # 화면의 「회의 자료」가 「자료 목록을 불러오지 못했습니다: not_found」였다(OMAI-1204, OKE). bad_path 로 거절해 화면이 HTTP 로 다시 읽게 한다.
        c = self.open(ALICE)
        for rid, path in (("a", "/api/office/meeting/files?room=1"), ("b", "/api/office/meeting/files/abc?room=1"),
                          ("c", "/api/office/meeting/out?room=1&path=x"), ("d", "/api/office/meeting/agent-file?room=1&msg=1&n=0")):
            res = self.req(c, rid, path)
            self.assertFalse(res["ok"], path)
            self.assertEqual(res["error"]["code"], "bad_path", path)
        c.close()

    def test_req_too_large_tells_the_screen_to_use_http(self):
        with mock.patch.object(ws, "REQ_MAX_BYTES", 10):
            c = self.open(ALICE)
            res = self.req(c, "x", "/api/me")
            self.assertEqual(res["error"]["code"], "too_large")
            c.close()

    # ---- 상한·종료 --------------------------------------------------------------
    def test_per_user_limit_replaces_the_oldest(self):
        first = self.open("dave@example.com")
        with mock.patch.object(ws._manager, "per_user", 2):
            second = self.open("dave@example.com")
            third = self.open("dave@example.com")
            self.assertEqual(self.closed_code(first), (4409, 4409))
            second.send(json.dumps({"v": 1, "t": "ping"}))
            third.send(json.dumps({"v": 1, "t": "ping"}))
        second.close(); third.close()

    def test_drain_sends_bye_1012_with_retry_window(self):
        c = self.open()
        self.run_on_server(ws.drain())
        bye = None
        try:
            while True:
                msg = json.loads(c.recv(timeout=5))
                if msg["t"] == "bye":
                    bye = msg
        except ConnectionClosed:
            pass
        self.assertEqual((bye["code"], c.close_code), (1012, 1012))
        self.assertTrue(5000 <= bye["retry_after_ms"] <= 30000)

    def test_idle_connection_is_closed(self):
        with mock.patch.object(ws, "HB_SECONDS", 0.2), mock.patch.dict(os.environ, {"AAS_WS_IDLE_SECONDS": "1"}):
            c = self.open()
            self.assertEqual(self.closed_code(c, timeout=5)[1], 1001)

    def test_metrics_line_is_logged_periodically(self):
        import contextlib
        import io
        buf = io.StringIO()

        async def once():
            m = ws.Manager(asyncio.get_running_loop())
            m.stats["replaced"] += 2
            with mock.patch.object(ws, "REPORT_SECONDS", 0.05), contextlib.redirect_stdout(buf):
                task = asyncio.create_task(ws._report(m))
                await asyncio.sleep(0.12)
                task.cancel()
        asyncio.run(once())
        self.assertIn("replaced=2", buf.getvalue())
        self.assertEqual(buf.getvalue().count("웹소켓: 연결"), 1)          # 지표가 비었으면 다시 남기지 않는다

    def test_heartbeat_is_sent(self):
        with mock.patch.object(ws, "HB_SECONDS", 0.2):
            c = self.open()
            self.assertIn("ts", self.recv(c, "hb", timeout=3))
            c.close()


class FakeChatHub:
    """채팅 허브 대역: 세션 s1 의 번호 붙은 이벤트 줄."""

    def __init__(self):
        self.events = [{"seq": i, "type": "message.delta", "payload": {"text": f"m{i}"}} for i in (1, 2, 3)]
        self.cond = threading.Condition()

    def events_after(self, sid, after, wait=0):
        if sid != "s1":
            from aas.hermes.hermes_chat import ChatUnavailable
            raise ChatUnavailable("unknown session")
        deadline = time.time() + wait
        with self.cond:
            while True:
                out = [e for e in self.events if e["seq"] > after]
                if out or time.time() >= deadline:
                    return out
                self.cond.wait(max(0.01, deadline - time.time()))

    def add(self, text):
        with self.cond:
            self.events.append({"seq": self.events[-1]["seq"] + 1, "type": "message.delta", "payload": {"text": text}})
            self.cond.notify_all()


class EventTopicTest(WsBase):
    """오피스·채팅 이벤트 토픽(W2): 스냅샷, 실시간 delta, 이어 받기, 놓쳤을 때 gap+snap, 보이지 않는 이벤트는 번호만."""

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        from aas.office import office_state
        server.OFFICE = office_state.Office()
        cls.chat = FakeChatHub()
        cls.patches.append(mock.patch.object(server, "hub", return_value=cls.chat))
        cls.patches[-1].start()

    def sub(self, c, topic, after=None):
        msg = {"v": 1, "t": "sub", "topic": topic}
        if after is not None:
            msg["after"] = after
        c.send(json.dumps(msg))

    def test_office_snapshot_then_live_events(self):
        c = self.open(ADMIN)
        self.sub(c, "office:state")
        snap = self.recv(c, "snap")
        self.assertEqual(snap["data"]["type"], "snapshot")
        seq = server.OFFICE.bus.publish("agent.status", {"alias": "x", "status": "working"})
        delta = self.recv(c, "delta", timeout=3)
        self.assertEqual((delta["seq"], delta["data"]["type"], delta["data"]["payload"]["alias"]), (seq, "agent.status", "x"))
        c.close()

    def test_office_resume_gets_only_missed_events(self):
        c = self.open(ADMIN)
        self.sub(c, "office:state")
        self.recv(c, "snap")
        first = server.OFFICE.bus.publish("agent.status", {"alias": "x"})
        self.recv(c, "delta")
        c.close()
        missed = server.OFFICE.bus.publish("agent.status", {"alias": "y"})
        c = self.open(ADMIN, hello=False)
        c.send(json.dumps({"v": 1, "t": "hello", "lang": "ko", "resume": [{"topic": "office:state", "after": first}]}))
        self.recv(c, "welcome")
        d = self.recv(c, None)
        self.assertEqual((d["t"], d["seq"], d["data"]["payload"]["alias"]), ("delta", missed, "y"))
        c.close()

    def test_office_too_old_resume_gets_gap_then_snapshot(self):
        c = self.open(ADMIN, hello=False)
        with mock.patch.object(server.OFFICE.bus, "oldest", return_value=10**9):
            c.send(json.dumps({"v": 1, "t": "hello", "lang": "ko", "resume": [{"topic": "office:state", "after": 1}]}))
            self.recv(c, "welcome")
            self.assertEqual(self.recv(c, None)["t"], "gap")
            self.assertEqual(self.recv(c, None)["t"], "snap")
        c.close()

    def test_seat_removed_reaches_everyone(self):
        """장면 이벤트는 보기 범위로 거르지 않는다(스펙 2026-10-21-022 리뷰 R3·D6): 지운 자리가 장면에 남지 않게 자리 빠짐은 모두에게 간다."""
        c = self.open(ALICE)
        self.sub(c, "office:state")
        self.recv(c, "snap")
        seq = server.OFFICE.bus.publish("seat.removed", {"alias": "someone-elses"})
        d = self.recv(c, "delta")
        self.assertEqual((d["seq"], d.get("skip"), d["data"]["type"]), (seq, None, "seat.removed"))
        c.close()

    def test_invisible_office_event_only_moves_the_number(self):
        c = self.open(ALICE)
        self.sub(c, "office:state")
        self.recv(c, "snap")
        # 남의 대화 답 글은 대화 당사자·주인에게만 간다(계획 007 R1) — 다른 사람에게는 번호만 건너뛴다
        seq = server.OFFICE.bus.publish("chat.delta", {"alias": "someone-elses", "text": "비밀", "_to": ["owner@x.com"]})
        d = self.recv(c, "delta")
        self.assertEqual((d["seq"], d.get("skip"), "data" in d), (seq, True, False))
        c.close()

    def test_presence_pub_reaches_others_without_email_and_is_rate_limited(self):
        """내 아바타로 걷기(계획 007 P6b): pub 은 office:presence 에만, 오피스 신호를 보낸 사람만, 1초 4번까지."""
        server.PRESENCE = __import__("aas.office.presence", fromlist=["Presence"]).Presence()
        server.PRESENCE.beat(ALICE, "앨리스", "")
        bob = self.open(BOB)
        self.sub(bob, "office:presence")
        snap = self.recv(bob, "snap")
        self.assertEqual([p["name"] for p in snap["data"]["payload"]["people"]], ["앨리스"])
        alice = self.open(ALICE)
        alice.send(json.dumps({"v": 1, "t": "pub", "topic": "office:state", "data": {"x": 1, "y": 1, "f": 0}}))
        self.assertEqual(self.recv(alice, "error")["code"], "bad_pub")
        alice.send(json.dumps({"v": 1, "t": "pub", "topic": "office:presence", "data": {"x": "nan", "y": 1, "f": 0}}))
        self.assertEqual(self.recv(alice, "error")["code"], "bad_pub")
        server.presence_tick()                                     # 바탕(서버마다 0.3초마다 도는 일을 시험에서는 손으로 부른다)
        for i in range(8):
            alice.send(json.dumps({"v": 1, "t": "pub", "topic": "office:presence", "data": {"x": i, "y": 2, "f": 0, "sit": "chair_1"}}))
        time.sleep(0.5)
        server.presence_tick()
        got = []
        try:
            while True:
                d = self.recv(bob, "delta", timeout=1.0)
                got.append(d["data"]["payload"])
        except TimeoutError:
            pass
        self.assertEqual(len(got), 1, got)                           # DB 에는 마지막 걸음만 남는다
        self.assertEqual(got[0]["sit"], "chair_1")
        self.assertLessEqual(got[0]["x"], 3)                         # 1초 4번을 넘은 걸음(x 4~7)은 버려졌다
        self.assertNotIn("email", json.dumps(got))
        alice.close()
        bob.close()

    def test_chat_topic_replays_then_streams_and_resumes(self):
        c = self.open(ALICE)
        self.sub(c, "pod:a:chat:s1")
        got = [self.recv(c, "delta")["seq"] for _ in range(3)]
        self.assertEqual(got, [1, 2, 3])
        self.chat.add("live")
        d = self.recv(c, "delta")
        self.assertEqual(d["data"]["payload"]["text"], "live")
        c.close()
        self.chat.add("missed")
        c = self.open(ALICE)
        self.sub(c, "pod:a:chat:s1", after=d["seq"])
        d2 = self.recv(c, "delta")
        self.assertEqual((d2["seq"], d2["data"]["payload"]["text"]), (d["seq"] + 1, "missed"))
        c.close()

    def test_chat_topic_checks_pod_and_session(self):
        c = self.open(ALICE)
        with mock.patch("builtins.print") as out:
            self.sub(c, "pod:b:chat:s1")                              # 남의 POD
            self.assertEqual(self.recv(c, "error")["code"], "forbidden")
            self.sub(c, "pod:a:chat:nope")                            # 없는 세션
            self.assertEqual(self.recv(c, "error")["code"], "forbidden")
        c.close()
        # 거절한 이유가 로그에 남는다(답이 화면에 오지 않던 일을 다음에는 로그로 가리려고, 2026-10-14)
        lines = [" ".join(map(str, call.args)) for call in out.call_args_list]
        self.assertTrue(any("대화 구독 거절" in s and "pod:b:chat:s1" in s and "POD" in s for s in lines), lines)
        self.assertTrue(any("대화 구독 거절" in s and "pod:a:chat:nope" in s and "ChatUnavailable" in s for s in lines), lines)

    def test_chat_topic_long_history_does_not_close_as_slow_client(self):
        """밀린 이벤트가 큐 상한(256)의 몇 배여도 연결이 닫히지 않고 모두 받는다. 전에는 한꺼번에 큐에 넣어
        1013 slow_client 로 닫혔고, 화면이 같은 토픽을 다시 구독해 끝없이 다시 붙었다(2026-10-23 OKE)."""
        long = FakeChatHub()                               # 다른 시험의 토픽(pod:a)과 섞이지 않게 pod:b 와 따로 된 허브
        long.events = [{"seq": i, "type": "message.delta", "payload": {"text": f"m{i}"}} for i in range(1, 1201)]
        with mock.patch.object(server, "hub", return_value=long):
            c = self.open(BOB)
            self.sub(c, "pod:b:chat:s1")
            seqs = []
            while len(seqs) < 1200:
                msg = self.recv(c)
                self.assertNotEqual(msg["t"], "bye", msg)
                if msg["t"] == "delta":
                    seqs.append(msg["seq"])
            self.assertEqual(seqs, list(range(1, 1201)))
            c.close()


class PollingTopicTest(WsBase):
    """회의·칸반·마켓 토픽(W3): 화면별 폴링을 대신한다."""

    def sub(self, c, topic):
        c.send(json.dumps({"v": 1, "t": "sub", "topic": topic}))

    def test_kanban_board_is_read_once_and_filtered_per_user(self):
        from aas.office import hub_auto, office_access
        board = {"columns": [{"name": "todo", "tasks": [{"id": "1", "assignee": "mine"}, {"id": "2", "assignee": "other"}, {"id": "3"}]}]}
        calls = []

        def route(_auto, method, path, query, body):
            calls.append(path)
            return 200, board
        visible = mock.patch.object(office_access.Access, "visible_aliases", return_value={"mine"})
        with mock.patch.object(hub_auto, "route", side_effect=route), mock.patch.object(server, "office_auto", return_value=None), visible:
            alice, boss = self.open(ALICE), self.open(ADMIN)
            self.sub(alice, "office:kanban:main")
            self.sub(boss, "office:kanban:main")
            a_ids = [t["id"] for t in self.recv(alice, "snap")["data"]["columns"][0]["tasks"]]
            b_ids = [t["id"] for t in self.recv(boss, "snap")["data"]["columns"][0]["tasks"]]
            self.assertEqual((a_ids, b_ids), (["1", "3"], ["1", "2", "3"]))
            self.assertLessEqual(len(calls), 2)
            board["columns"][0]["tasks"].append({"id": "4", "assignee": "mine"})
            topics.invalidate("office:kanban:")
            self.assertEqual([t["id"] for t in self.recv(alice, "snap", timeout=3)["data"]["columns"][0]["tasks"]], ["1", "3", "4"])
            alice.close(); boss.close()

    def test_people_topic_takes_ws_beats_and_lists_people_per_viewer(self):
        """사람 목록 토픽(스펙 2026-10-26-001 §4-2): 신호는 pub 으로, 목록은 구독자마다 거른 값으로. 연결이 끊기면 서버가 더 붙잡지 않는다."""
        from aas.office import office_access, presence
        server.PRESENCE = presence.Presence()
        def clear():                                                    # 같은 데이터 폴더를 쓰는 다른 시험과 사람 행이 섞이지 않게
            with presence._connect() as conn:
                conn.execute("DELETE FROM office_presence")
        clear()
        self.addCleanup(clear)
        everyone = mock.patch.object(office_access.Access, "scene_people", lambda self: None if self.admin else {ALICE, BOB})
        with everyone:
            alice, boss = self.open(ALICE), self.open(ADMIN)
            self.sub(alice, "office:people")
            self.sub(boss, "office:people")
            self.assertEqual(self.recv(alice, "snap")["data"], {"people": []})
            self.recv(boss, "snap")
            server.presence_tick()                                      # 바탕(돌던 서버에서는 반복이 이미 잡아 두었다)
            alice.send(json.dumps({"v": 1, "t": "pub", "topic": "office:people", "data": {"beat": "room", "email": "boss@x.co"}}))
            deadline = time.time() + 5
            while ALICE not in server.PRESENCE.held_emails() and time.time() < deadline:
                time.sleep(0.05)
            server.presence_tick()                                      # 서버마다 도는 반복을 손으로 — 들어옴을 보고 토픽을 다시 읽게 한다
            mine = self.recv(alice, "snap", timeout=3)["data"]["people"]
            seen = self.recv(boss, "snap", timeout=3)["data"]["people"]
            self.assertEqual([(p["name"], p["me"]) for p in mine], [(ALICE.split("@")[0], True)])
            self.assertNotIn("email", mine[0])                              # 일반 사용자에게 이메일 없음
            self.assertEqual([(p["email"], p["me"]) for p in seen], [(ALICE, False)])   # 관리자에게만 이메일, 이메일은 연결의 로그인 정보
            alice.close()
            deadline = time.time() + 5
            while server.PRESENCE.held_emails() and time.time() < deadline:
                time.sleep(0.05)
            self.assertEqual(server.PRESENCE.held_emails(), set())
            boss.close()

    def test_office_changed_topic_sends_only_numbers(self):
        """오피스 정보 변경 신호(스펙 2026-10-26-001 §4-1): 값은 번호 둘뿐이고, 올리면 곧바로 새 값이 간다."""
        from aas.office import office_changed
        c = self.open(ALICE)
        self.sub(c, "office:changed")
        first = self.recv(c, "snap")["data"]
        self.assertEqual(set(first), {"n", "admin"})
        office_changed.bump("rooms")
        self.assertEqual(self.recv(c, "snap", timeout=3)["data"]["n"], first["n"] + 1)
        c.close()

    def test_meeting_room_needs_membership(self):
        from aas.office import office_access
        view = {"messages": [{"id": 1, "content": "hi"}], "pending": []}
        fake_meeting = mock.Mock(view=mock.Mock(return_value=view))

        def require_room(self, room):
            if room != 7:
                raise office_access.Denied("no")
        with mock.patch.object(server, "office_meeting", return_value=fake_meeting), \
                mock.patch.object(office_access.Access, "require_room", require_room):
            c = self.open(ALICE)
            self.sub(c, "office:meeting:7")
            self.assertEqual(self.recv(c, "snap")["data"]["messages"][0]["content"], "hi")
            self.sub(c, "office:meeting:8")
            self.assertEqual(self.recv(c, "error")["code"], "forbidden")
            c.close()

    def test_market_topic_adds_admin_flag_and_checks_pod(self):
        from aas.market import marketplace
        with mock.patch.object(marketplace, "overview", return_value={"requests": [], "packages": []}):
            alice, boss = self.open(ALICE), self.open(ADMIN)
            self.sub(alice, "pod:a:market")
            self.sub(boss, "pod:a:market")
            self.assertEqual((self.recv(alice, "snap")["data"]["admin"], self.recv(boss, "snap")["data"]["admin"]), (False, True))
            self.sub(alice, "pod:b:market")
            self.assertEqual(self.recv(alice, "error")["code"], "forbidden")
            alice.close(); boss.close()

    def test_market_topic_gives_can_install_to_owner_not_viewer(self):
        """REST 와 같은 설치 권한을 토픽에도 넣는다(OMAI-1126 리뷰 R1). 빠지면 웹소켓 값이 REST 값을 덮어 주인 단추가 꺼진다."""
        from aas.market import marketplace
        server.registry().grant(BOB, "user", ["a", "b"], ADMIN)       # bob 은 a 를 보기만 한다
        with mock.patch.object(marketplace, "overview", return_value={"requests": [], "packages": []}):
            alice, boss, bob = self.open(ALICE), self.open(ADMIN), self.open(BOB)
            for c in (alice, boss, bob):
                self.sub(c, "pod:a:market")
            got = [self.recv(c, "snap")["data"]["can_install"] for c in (alice, boss, bob)]
            self.assertEqual(got, [True, True, False])
            alice.close(); boss.close(); bob.close()


class OfficePushTest(WsBase):
    """받은편지함·카드 신호, 진행 중인 회의, 오피스 대화 답 토픽(스펙 2026-10-17-004)."""

    def sub(self, c, topic, after=None):
        c.send(json.dumps({"v": 1, "t": "sub", "topic": topic, **({"after": after} if after is not None else {})}))

    def test_inbox_signal_topic_is_only_for_that_person_and_changes_with_items(self):
        sig = {"v": "a1", "n": 1}
        calls = []

        def signal(me):
            calls.append(me)
            return dict(sig)
        with mock.patch.object(server, "office_inbox_signal", side_effect=signal):
            alice = self.open(ALICE)
            self.sub(alice, f"office:inbox:{ALICE}")
            self.assertEqual(self.recv(alice, "snap")["data"], {"v": "a1", "n": 1})
            self.assertEqual(calls[-1], ALICE)
            self.sub(alice, f"office:inbox:{BOB}")                                  # 남의 받은편지함
            self.assertEqual((self.recv(alice, "error")["code"]), "forbidden")
            self.sub(alice, f"office:inbox:{ALICE.upper()}")                       # 이름은 소문자로만 받는다
            self.assertEqual((self.recv(alice, "error")["code"]), "forbidden")
            self.sub(alice, "office:inbox:local")                                   # 로그인을 켠 실행에서 local 은 아무의 것도 아니다
            self.assertEqual((self.recv(alice, "error")["code"]), "forbidden")
            sig["v"] = "a2"
            topics.invalidate(server.inbox_topic(ALICE), exact=True)
            self.assertEqual(self.recv(alice, "snap", timeout=3)["data"]["v"], "a2")
            alice.close()

    def test_market_topic_view_translates_package_summary_per_language(self):
        """스펙 2026-10-19-017 §9: 스킬 허브 토픽도 REST 와 같이 요약에 번역을 붙인다. 안 붙이면 토픽 값이 REST 값을 덮어 영어로 돌아간다(OKE 화면에서 찾음)."""
        from aas.common import i18n
        from aas.market import skill_desc
        spec = ws._market_spec("p1")
        v = {"packages": [{"id": "c/box", "name": "box", "summary": "Box manages cloud files."}], "requests": []}
        fake = lambda n, d: ("번역", "seed") if skill_desc.get_lang() == "ko" else None
        with mock.patch.object(skill_desc, "find", side_effect=fake), mock.patch.object(server, "registry"), mock.patch.object(server, "_owns_pod", return_value=False):
            i18n.set_lang("ko")
            ko = spec.view(v, {"admin": True})["packages"][0]
            i18n.set_lang("en")
            en = spec.view(v, {"admin": True})["packages"][0]
            i18n.set_lang("ko")
        self.assertEqual((ko["summary"], ko["summary_src"], ko["summary_by"]), ("번역", "Box manages cloud files.", "seed"))
        self.assertEqual(en, {"id": "c/box", "name": "box", "summary": "Box manages cloud files."})
        self.assertEqual(v["packages"][0]["summary"], "Box manages cloud files.")      # 토픽 저장값은 그대로

    def test_inbox_topic_names_and_spec(self):
        self.assertEqual(server.inbox_topic("Alice@Example.com"), "office:inbox:alice@example.com")
        self.assertEqual(server.inbox_topic(""), "office:inbox:local")
        spec = ws.resolve("office:inbox:alice@example.com")
        self.assertEqual(spec.interval(None), 15.0)
        self.assertFalse(spec.per_lang)
        self.assertIsNone(ws.resolve("office:inbox:a b"))

    def test_inbox_signal_reads_only_the_shared_db_side(self):
        # 크론·MCP 로그인처럼 파드 파일을 읽는 항목은 신호에 넣지 않는다(L5): health·crondone 캐시를 부르지 않는다
        with mock.patch.object(server.INBOX, "for_person", return_value=[{"id": "p|s|r|"}]), \
                mock.patch.object(server, "_health") as health, mock.patch.object(server, "_cached") as cached:
            one = server.office_inbox_signal(ALICE)
            with mock.patch.object(server.INBOX, "for_person", return_value=[{"id": "p|s|r|"}, {"id": "p|s|r2|"}]):
                two = server.office_inbox_signal(ALICE)
        health.assert_not_called(); cached.assert_not_called()
        self.assertNotEqual(one["v"], two["v"])
        self.assertEqual(two["n"] - one["n"], 1)

    def test_cards_signal_topic_pushes_when_the_number_changes(self):
        value = {"event": 3, "cards": 2}
        with mock.patch.object(server, "office_cards_signal", side_effect=lambda: dict(value)):
            c = self.open(ALICE)
            self.sub(c, "office:cards")
            self.assertEqual(self.recv(c, "snap")["data"], {"event": 3, "cards": 2})
            value["cards"] = 3                                                    # 조용한 첫 동기화: 이벤트 없이 줄만 늘었다
            server._cards_changed()
            self.assertEqual(self.recv(c, "snap", timeout=3)["data"], {"event": 3, "cards": 3})
            c.close()

    def test_meeting_active_topic_is_read_once_and_hides_other_rooms(self):
        from aas.office import office_access
        rows = [{"room": 7, "name": "기획", "seats": ["a"], "pending": ["a"], "speaker": "a", "at": 1.0, "partial": {"a": "hi"}, "last": []},
                {"room": 8, "name": "인사", "seats": ["b"], "pending": [], "speaker": None, "at": 1.0, "partial": {}, "last": []}]
        calls = []

        def active():
            calls.append(1)
            return rows
        member = mock.patch.object(office_access.Access, "member_of", lambda self, room: room == 7 or self.admin)
        with mock.patch.object(server, "office_meeting_active", side_effect=active), member:
            alice, boss = self.open(ALICE), self.open(ADMIN)
            self.sub(alice, "office:meeting:active")
            self.sub(boss, "office:meeting:active")
            a, b = self.recv(alice, "snap")["data"]["meetings"], self.recv(boss, "snap")["data"]["meetings"]
            self.assertEqual(a[0]["partial"], {"a": "hi"})
            self.assertNotIn("name", a[1]); self.assertNotIn("partial", a[1])      # 구성원이 아닌 방은 위치만
            self.assertEqual(b[1]["name"], "인사")
            self.assertEqual(len(calls), 1)
            self.assertEqual(ws._meeting_active_spec().interval(rows), 1.5)
            self.assertEqual(ws._meeting_active_spec().interval(rows[1:]), 5.0)
            alice.close(); boss.close()

    def test_office_chat_turn_topic_streams_items_and_rests_when_done(self):
        from aas.office import office_access, relay
        turn = relay.Turn("run_ab12", "mine", "s1")
        turn.add("delta", "안")
        bridge = mock.Mock(turn=lambda tid, alias: turn if (tid, alias) == ("run_ab12", "mine") else None)
        use = mock.patch.object(office_access.Access, "require_use", lambda self, alias: None if alias == "mine" else (_ for _ in ()).throw(office_access.Denied("no")))
        with mock.patch.object(server, "office_auto", return_value=mock.Mock(bridge=bridge)), use:
            c = self.open(ALICE)
            self.sub(c, "office:chat:mine:run_ab12")
            first = self.recv(c, "delta")
            self.assertEqual((first["seq"], first["data"]["payload"]), (1, {"kind": "delta", "text": "안", "done": False}))
            turn.add("delta", "녕")
            turn.add("final", "안녕")
            got = [self.recv(c, "delta", timeout=3) for _ in range(2)]
            self.assertEqual([g["seq"] for g in got], [2, 3])
            self.assertTrue(got[1]["data"]["payload"]["done"])
            self.sub(c, "office:chat:other:run_ab12")                              # 쓸 수 없는 자리
            self.assertEqual(self.recv(c, "error")["code"], "forbidden")
            c.close()
        # 끝난 대화: 새 조각이 없으면 곧바로 빈 목록을 돌려 쉬지 않고 돌던 것(L3)을 막는다
        # ws.time 은 전역 time 모듈이라 다른 스레드(서버·앞 시험의 대기 고리)의 sleep 도 걸린다 — 이 스레드 것만 센다(2026-10-20)
        spec = ws._turn_spec("mine", "run_ab12")
        me, naps, real = threading.get_ident(), [], time.sleep
        nap = lambda s: naps.append(s) if threading.get_ident() == me else real(s)  # noqa: E731
        with mock.patch.object(server, "office_auto", return_value=mock.Mock(bridge=bridge)), mock.patch.object(ws.time, "sleep", side_effect=nap):
            self.assertEqual(spec.after(3, 20.0), [])
        self.assertEqual(naps, [ws.TURN_IDLE])


class FakeWs:
    async def send_text(self, _):
        await asyncio.sleep(3600)

    async def close(self, _code):
        pass


class QueueTest(unittest.TestCase):
    """송신 큐 상한·합치기·서버 전체 예산(R4). 실제 소켓 없이 Conn·Manager 만 본다."""

    def make(self, budget_mb=64, n=1):
        loop = asyncio.new_event_loop()
        m = ws.Manager(loop)
        m.budget = int(budget_mb * 1024 * 1024)
        conns = []
        for i in range(n):
            c = ws.Conn(FakeWs(), m, {"email": f"u{i}@x"}, {}, "")
            m.add(c)
            conns.append(c)
        return loop, m, conns

    def test_state_snaps_are_coalesced(self):
        _loop, m, (c,) = self.make()
        c.push("agents", '{"a":1}', "snap")
        c.push("agents", '{"a":2}', "snap")
        self.assertEqual([q[2] for q in c.queue], ['{"a":2}'])
        self.assertEqual(m.total, len('{"a":2}'))

    def test_queue_over_256_messages_closes_with_1013(self):
        _loop, _m, (c,) = self.make()
        for i in range(300):
            c.push("", f'{{"i":{i}}}', "res")
        self.assertEqual(c.closing, (1013, "slow_client"))
        self.assertEqual(len(c.queue), 1)                      # bye 만 남는다

    def test_queue_over_1mb_closes(self):
        _loop, _m, (c,) = self.make()
        c.push("", "x" * (1024 * 1024 + 1), "res")
        self.assertEqual(c.closing[0], 1013)

    def test_server_budget_kicks_the_biggest_queue(self):
        """느린 연결 100개가 모두 큐를 채워도 서버 전체 예산(여기서는 1MB)을 넘지 않는다."""
        _loop, m, conns = self.make(budget_mb=1, n=100)
        for i, c in enumerate(conns):
            for _ in range(20):
                c.push("", "y" * (1000 + i), "res")
        self.assertLessEqual(m.total, m.budget)
        self.assertGreater(m.stats["budget_kicks"], 0)
        kicked = [c for c in conns if c.closing == (1013, "server_busy")]
        self.assertTrue(kicked)

    def test_event_overflow_drops_that_topics_deltas_and_sends_gap(self):
        loop, m, (c,) = self.make()
        resynced = []

        async def fake_resync(topic, sub):
            resynced.append(topic)
        with mock.patch.object(topics.hub(), "resync", side_effect=fake_resync):
            c.push("agents", '{"s":1}', "snap")
            for i in range(300):
                c.push("office:state", f'{{"i":{i}}}', "delta")
            loop.run_until_complete(asyncio.sleep(0))
        kinds = [(q[0], q[1]) for q in c.queue]
        self.assertIsNone(c.closing)
        self.assertIn(("agents", "snap"), kinds)
        self.assertIn(("office:state", "gap"), kinds)
        self.assertLess(len(c.queue), 256)
        self.assertEqual(resynced, ["office:state"])

    def test_close_with_releases_bytes(self):
        _loop, m, (c,) = self.make()
        c.push("", "z" * 1000, "res")
        c.close_with(4409, "replaced")
        self.assertEqual(m.total, 0)


class Sub:
    def __init__(self, lang="ko"):
        self.ctx = {"lang": lang}
        self.topics = set()
        self.got = []

    def push(self, topic, msg, kind):
        self.got.append((topic, kind, json.loads(msg)))

    async def room(self):
        pass


class HubTest(unittest.TestCase):
    """토픽 허브: 동시 읽기 상한, 느린 생산자, 값이 같으면 보내지 않음, 실패 때 stale(R5)."""

    def run_async(self, coro):
        return asyncio.run(coro)

    def test_concurrent_reads_never_exceed_the_limit(self):
        async def main():
            hub = topics.Hub(readers=8, timeout=5)
            hub.start(asyncio.get_running_loop())
            live = {"now": 0, "max": 0}
            lock = threading.Lock()

            def slow():
                with lock:
                    live["now"] += 1
                    live["max"] = max(live["max"], live["now"])
                time.sleep(0.1)
                with lock:
                    live["now"] -= 1
                return {"ok": 1}
            hub.add(lambda name: topics.Spec(source=slow, interval=lambda _v: 60) if name.startswith("t") else None)
            subs = [Sub() for _ in range(100)]
            for i, s in enumerate(subs):
                await hub.subscribe(f"t{i}", s)
            for _ in range(100):
                if all(s.got for s in subs):
                    break
                await asyncio.sleep(0.05)
            self.assertTrue(all(s.got for s in subs))
            self.assertLessEqual(live["max"], 8)
            self.assertLessEqual(hub.stats["in_flight_max"], 8)
        self.run_async(main())

    def test_slow_producer_does_not_block_other_topics(self):
        async def main():
            hub = topics.Hub(readers=8, timeout=0.3)
            hub.start(asyncio.get_running_loop())
            hub.add(lambda name: topics.Spec(source=(lambda: time.sleep(2) or 1) if name == "slow" else (lambda: {"fast": 1}),
                                             interval=lambda _v: 60))
            slow, fast = Sub(), Sub()
            await hub.subscribe("slow", slow)
            started = time.monotonic()
            await hub.subscribe("fast", fast)
            while not fast.got and time.monotonic() - started < 2:
                await asyncio.sleep(0.02)
            self.assertTrue(fast.got)
            self.assertLess(time.monotonic() - started, 1)
            await asyncio.sleep(0.4)
            self.assertEqual(hub.stats["timeouts"], 1)
        self.run_async(main())

    def test_a_read_still_running_after_timeout_is_not_started_again(self):
        """15초 뒤 포기한 읽기도 스레드는 계속 돈다. 같은 토픽의 다음 회차가 또 읽기를 보내면 느린 읽기가 공용 스레드 8개를
        차지해 모든 사용자의 실시간 갱신이 멈춘다(스펙 2026-10-24-002 R10)."""
        async def main():
            hub = topics.Hub(readers=4, timeout=0.1)
            hub.start(asyncio.get_running_loop())
            calls = {"slow": 0}
            release = threading.Event()

            def slow():
                calls["slow"] += 1
                release.wait(3)
                return {"slow": 1}
            hub.add(lambda name: topics.Spec(source=slow if name == "slow" else (lambda: {"fast": 1}), interval=lambda _v: 60))
            s = Sub()
            await hub.subscribe("slow", s)
            for _ in range(10):                                   # 화면이 다시 읽게 해도
                hub.invalidate("slow")
                await asyncio.sleep(0.15)
            self.assertEqual(calls["slow"], 1)                     # 아직 도는 읽기를 또 보내지 않는다
            fast = Sub()
            await hub.subscribe("fast", fast)
            for _ in range(50):
                if fast.got:
                    break
                await asyncio.sleep(0.02)
            self.assertTrue(fast.got)                              # 다른 토픽은 막히지 않는다
            release.set()
        self.run_async(main())

    def test_unchanged_value_is_not_sent_again_and_failure_keeps_last_value(self):
        async def main():
            hub = topics.Hub(readers=2, timeout=1)
            hub.start(asyncio.get_running_loop())
            box = {"v": {"n": 1}, "fail": False}

            def read():
                if box["fail"]:
                    raise OSError("down")
                return box["v"]
            hub.add(lambda name: topics.Spec(source=read, interval=lambda _v: 60) if name == "x" else None)
            s = Sub()
            await hub.subscribe("x", s)
            while not s.got:
                await asyncio.sleep(0.01)
            hub.invalidate("x")
            await asyncio.sleep(0.2)
            self.assertEqual(len(s.got), 1)                       # 값이 같으면 보내지 않는다
            box["fail"] = True
            hub.invalidate("x")
            for _ in range(50):
                if len(s.got) > 1:
                    break
                await asyncio.sleep(0.02)
            last = s.got[-1][2]
            self.assertEqual((last["data"], last.get("stale"), last.get("error")), ({"n": 1}, True, "OSError"))
        self.run_async(main())

    def test_language_specific_topics_are_read_per_language(self):
        async def main():
            from aas.common import i18n
            hub = topics.Hub(readers=2)
            hub.start(asyncio.get_running_loop())
            hub.add(lambda name: topics.Spec(source=lambda: {"lang": i18n.get_lang()}, interval=lambda _v: 60) if name == "l" else None)
            ko, en = Sub("ko"), Sub("en")
            await hub.subscribe("l", ko)
            await hub.subscribe("l", en)
            while not (ko.got and en.got):
                await asyncio.sleep(0.01)
            self.assertEqual((ko.got[0][2]["data"]["lang"], en.got[0][2]["data"]["lang"]), ("ko", "en"))
        self.run_async(main())

    def test_exact_invalidate_wakes_only_that_name(self):
        # 받은편지함 a@x.co 를 다시 읽게 할 때 a@x.com 은 깨우지 않는다(스펙 2026-10-17-004 L9)
        hub = topics.Hub()
        short, long_ = mock.Mock(), mock.Mock()
        hub.topics = {("office:inbox:a@x.co", ""): short, ("office:inbox:a@x.com", ""): long_}
        hub._wake_matching("office:inbox:a@x.co", True)
        short.wake.set.assert_called_once(); long_.wake.set.assert_not_called()
        hub._wake_matching("office:inbox:", False)
        long_.wake.set.assert_called_once()

    def test_jitter_spreads_intervals(self):
        hub = topics.Hub(readers=1)
        t = topics.Topic("x", "", topics.Spec(source=lambda: 1, interval=lambda _v: 10))
        t.value = 1
        delays = {round(hub._delay(t), 3) for _ in range(50)}
        self.assertTrue(all(8 <= d <= 12 for d in delays))
        self.assertGreater(len(delays), 10)


class ShutdownTest(unittest.TestCase):
    """실제 프로세스(반복 스레드를 켠 채)에 SIGTERM 을 보내면 웹소켓이 bye 1012 를 받고 닫힌다(R8·R13)."""

    def test_sigterm_sends_bye_before_uvicorn_closes(self):
        with socket.socket() as s:
            s.bind(("127.0.0.1", 0))
            port = s.getsockname()[1]
        d = Path(tempfile.mkdtemp())
        (d / "pods.json").write_text(json.dumps({"pods": []}))
        env = {**os.environ, "AAS_DATA_DIR": str(d), "AAS_PODS_FILE": str(d / "pods.json"), "AAS_WS": "on",
               "PYTHONPATH": str(Path(__file__).resolve().parent.parent)}
        for k in ("AAS_USERS_FILE", "AAS_OIDC_ISSUER", "AAS_ALLOWED_HOSTS"):
            env.pop(k, None)
        proc = subprocess.Popen([sys.executable, "-m", "aas", "serve", "--host", "127.0.0.1", "--port", str(port)], env=env,
                                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        try:
            deadline = time.time() + 15
            while True:
                try:
                    c = connect(f"ws://127.0.0.1:{port}/ws", origin=f"http://127.0.0.1:{port}", open_timeout=2)
                    break
                except OSError:
                    if time.time() > deadline:
                        raise
                    time.sleep(0.2)
            c.send(json.dumps({"v": 1, "t": "hello", "lang": "ko"}))
            self.assertEqual(json.loads(c.recv(timeout=5))["t"], "welcome")
            proc.send_signal(signal.SIGTERM)
            bye = None
            try:
                while True:
                    msg = json.loads(c.recv(timeout=10))
                    if msg["t"] == "bye":
                        bye = msg
            except ConnectionClosed:
                pass
            self.assertEqual((bye or {}).get("code"), protocol.RESTART)
            self.assertEqual(c.close_code, 1012)
            self.assertEqual(proc.wait(timeout=20), 0)
        finally:
            if proc.poll() is None:
                proc.kill()


if __name__ == "__main__":
    unittest.main()

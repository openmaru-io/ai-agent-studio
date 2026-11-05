# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""Session list for the session-centric chat: owner, state, Hermes auto-title, relay exclusion."""
import threading
import time
import unittest
from unittest import mock

from aas.hermes.hermes_chat import ChatHub
from tests.test_chat import SETTINGS, FakeWS


def ev(sid, etype, payload):
    return {"method": "event", "params": {"type": etype, "session_id": sid, "payload": payload}}


class LiveSessionsTest(unittest.TestCase):
    def setUp(self):
        self.ws = FakeWS()
        self.hub = ChatHub(SETTINGS, connect=lambda: self.ws, reconnect_delays=())

    def tearDown(self):
        self.ws.close()

    def test_create_session_records_owner(self):
        out = self.hub.create_session("default", by="a@example.com")
        self.assertEqual(self.hub.sessions[out["session_id"]]["by"], "a@example.com")
        rows = self.hub.live_sessions("a@example.com")
        self.assertEqual([r["session_id"] for r in rows], ["s1"])
        self.assertEqual(rows[0]["state"], "idle")
        self.assertEqual(self.hub.live_sessions("b@example.com"), [])
        self.assertEqual(len(self.hub.live_sessions(None)), 1)      # no login: everyone's sessions

    def test_state_order_waiting_running_idle_closed(self):
        now = time.time()
        self.hub.sessions.update({
            "w": {"profile": "p", "created": now, "title": "", "requests": {"r": {"method": "clarify", "request_id": "r"}}},
            "r": {"profile": "p", "created": now, "title": "", "running": now},
            "t": {"profile": "p", "created": now, "title": "", "turn_open": True},
            "i": {"profile": "p", "created": now, "title": ""},
            "c": {"profile": "p", "created": now, "title": "", "closed": True},
        })
        got = {r["session_id"]: r["state"] for r in self.hub.live_sessions()}
        self.assertEqual(got, {"w": "waiting", "r": "running", "t": "running", "i": "idle", "c": "closed"})
        waiting = next(r for r in self.hub.live_sessions() if r["session_id"] == "w")
        self.assertEqual(waiting["pending"], ["clarify"])

    def test_relay_sessions_are_hidden(self):
        self.hub.sessions["m"] = {"profile": "p", "created": time.time(), "title": "", "relay": True}
        self.assertEqual(self.hub.live_sessions(), [])

    def test_hermes_auto_title_replaces_first_line_title(self):
        self.hub.sessions["x"] = {"profile": "p", "created": 1.0, "title": "first line of my question"}
        self.hub._on_frame(ev("x", "session.title", {"session_id": "stored-1", "title": "Quarterly report summary"}))
        meta = self.hub.sessions["x"]
        self.assertEqual(meta["title"], "Quarterly report summary")
        self.assertEqual(meta["stored_id"], "stored-1")
        self.assertGreater(meta["last_at"], 1.0)

    def test_title_event_without_title_keeps_title(self):
        self.hub.sessions["x"] = {"profile": "p", "created": 1.0, "title": "keep me"}
        self.hub._on_frame(ev("x", "session.title", {"session_id": "stored-1"}))
        self.assertEqual(self.hub.sessions["x"]["title"], "keep me")

    def test_most_recent_activity_first(self):
        self.hub.sessions["old"] = {"profile": "p", "created": 1.0, "title": ""}
        self.hub.sessions["new"] = {"profile": "p", "created": 2.0, "title": ""}
        self.hub._on_frame(ev("old", "message.delta", {"text": "hi"}))
        self.assertEqual([r["session_id"] for r in self.hub.live_sessions()], ["old", "new"])

    def test_hide_only_my_sessions_and_drop_from_list(self):
        self.hub.sessions["m"] = {"profile": "p", "created": 1.0, "title": "", "by": "me@example.com"}
        self.hub.sessions["o"] = {"profile": "p", "created": 1.0, "title": "", "by": "other@example.com"}
        self.assertEqual(self.hub.hide_sessions(["m", "o", "missing"], "me@example.com"), ["m"])
        self.assertEqual(self.hub.live_sessions("me@example.com"), [])
        self.assertEqual([r["session_id"] for r in self.hub.live_sessions("other@example.com")], ["o"])
        self.assertIn("m", self.hub.sessions)                       # 숨김일 뿐 대화는 남는다
        self.assertEqual(self.hub.hide_sessions(["o"], None), ["o"])  # 로그인이 꺼져 있으면 누구 것이든

    def test_prune_keeps_running_and_waiting(self):
        now = 100000.0
        self.hub.sessions.update({
            "old": {"profile": "p", "created": 1.0, "title": "", "last_at": 10.0},
            "oldrun": {"profile": "p", "created": 1.0, "title": "", "last_at": 10.0, "turn_open": True},
            "oldwait": {"profile": "p", "created": 1.0, "title": "", "last_at": 10.0, "requests": {"r": {"method": "approval"}}},
            "relay": {"profile": "p", "created": 1.0, "title": "", "last_at": 10.0, "relay": True},
            "fresh": {"profile": "p", "created": 1.0, "title": "", "last_at": now - 60},
        })
        self.hub._events["old"] = None
        self.assertEqual(self.hub.prune(3600, now), ["old"])
        self.assertEqual(set(self.hub.sessions), {"oldrun", "oldwait", "relay", "fresh"})
        self.assertNotIn("old", self.hub._events)
        self.assertEqual(self.hub.prune(0, now), [])                  # 0 이면 끔

    def test_prune_keeps_goal_loop_and_resting_sessions(self):
        """목표·반복이 켜져 있거나 쉬는 중(resting)인 세션은 뒤에서 일하는 중이라 걷어내지 않는다(스펙 2026-11-05-005 RQ6)."""
        now = 100000.0
        self.hub.sessions.update({
            "goal": {"profile": "p", "created": 1.0, "title": "", "last_at": 10.0, "control": {"goal": {"status": "active"}}},
            "loop": {"profile": "p", "created": 1.0, "title": "", "last_at": 10.0, "control": {"loop": {"status": "active"}}},
            "rest": {"profile": "p", "created": 1.0, "title": "", "last_at": 10.0, "resting": True},
            "done": {"profile": "p", "created": 1.0, "title": "", "last_at": 10.0, "control": {"goal": {"status": "done"}}},
        })
        with mock.patch.object(self.hub, "request"):
            self.assertEqual(self.hub.prune(3600, now), ["done"])
        self.assertEqual(set(self.hub.sessions), {"goal", "loop", "rest"})

    def test_prune_closes_the_hermes_session(self):
        """AAS 메모리만 지우면 Hermes 는 연결이 살아 있는 한 그 세션을 메모리에 둔다(Hermes 의 자동 정리는 끊긴 연결만 본다).
        걷어낼 때 session.close 도 보낸다(스펙 2026-11-05-005 F1·RQ3). 다시 열기는 저장 대화 resume 으로 된다."""
        now = 100000.0
        self.hub.sessions.update({
            "old": {"profile": "p", "created": 1.0, "title": "", "last_at": 10.0, "stored_id": "st-1"},
            "fresh": {"profile": "p", "created": 1.0, "title": "", "last_at": now - 60},
        })
        closed = threading.Event()
        calls = []

        def fake_request(method, params=None, timeout=None):
            calls.append((method, params))
            closed.set()
            return {}

        with mock.patch.object(self.hub, "request", side_effect=fake_request):
            self.assertEqual(self.hub.prune(3600, now), ["old"])
            self.assertTrue(closed.wait(2))
        self.assertEqual(calls, [("session.close", {"session_id": "old"})])
        self.assertNotIn("old", self.hub.sessions)

    def test_prune_survives_a_failed_close(self):
        now = 100000.0
        self.hub.sessions["old"] = {"profile": "p", "created": 1.0, "title": "", "last_at": 10.0}
        tried = threading.Event()

        def boom(*a, **k):
            tried.set()
            raise RuntimeError("hermes down")

        with mock.patch.object(self.hub, "request", side_effect=boom):
            self.assertEqual(self.hub.prune(3600, now), ["old"])
            self.assertTrue(tried.wait(2))
        self.assertNotIn("old", self.hub.sessions)


class ChatSessionsRouteTest(unittest.TestCase):
    """GET /api/chat/sessions body: my sessions across my agents, newest activity first."""

    def test_collects_my_sessions_across_pods(self):
        from types import SimpleNamespace
        from unittest import mock

        from aas.web import server
        hub_a = ChatHub(SETTINGS, connect=lambda: None, reconnect_delays=())
        hub_a.sessions.update({
            "a1": {"profile": "main", "created": 1.0, "title": "mine old", "by": "me@example.com", "last_at": 10.0},
            "a2": {"profile": "main", "created": 2.0, "title": "someone else", "by": "other@example.com", "last_at": 30.0},
        })
        hub_b = ChatHub(SETTINGS, connect=lambda: None, reconnect_delays=())
        hub_b.sessions["b1"] = {"profile": "ops", "created": 3.0, "title": "mine new", "by": "me@example.com", "last_at": 20.0}
        pods = [SimpleNamespace(id="a"), SimpleNamespace(id="b"), SimpleNamespace(id="c")]   # c has no hub yet: skipped, no new connection
        with mock.patch.object(server, "_my_agent_pods", return_value=(pods, {"a": "Agent A", "b": "Agent B"}, None)), \
                mock.patch.dict(server._hubs, {"a": hub_a, "b": hub_b}, clear=True), \
                mock.patch.dict("os.environ", {"AAS_CHAT_SESSION_TTL_HOURS": "0"}):
            rows = server._chat_sessions(None, {"email": "me@example.com"}, True, pods[0])
            everyone = server._chat_sessions(None, None, False, pods[0])
        self.assertEqual([(r["session_id"], r["pod"], r["agent_name"]) for r in rows], [("b1", "b", "Agent B"), ("a1", "a", "Agent A")])
        self.assertEqual({r["session_id"] for r in everyone}, {"a1", "a2", "b1"})   # login off: no owner filter

    def test_hidden_ids_are_mine_only(self):
        """다른 기기에서 닫은(숨긴) 내 세션 id 를 함께 준다 — 그 세션을 열고 있는 탭도 목록에서 뺀다(스펙 2026-11-05-005 7-6)."""
        from types import SimpleNamespace
        from unittest import mock

        from aas.web import server
        hub = ChatHub(SETTINGS, connect=lambda: None, reconnect_delays=())
        hub.sessions.update({
            "h1": {"profile": "main", "created": 1.0, "title": "t", "by": "me@example.com", "hidden": True},
            "h2": {"profile": "main", "created": 1.0, "title": "t", "by": "other@example.com", "hidden": True},
            "v1": {"profile": "main", "created": 1.0, "title": "t", "by": "me@example.com"},
        })
        pods = [SimpleNamespace(id="a")]
        with mock.patch.object(server, "_my_agent_pods", return_value=(pods, {"a": "A"}, None)), \
                mock.patch.dict(server._hubs, {"a": hub}, clear=True):
            self.assertEqual(server._chat_hidden(None, {"email": "me@example.com"}, True, pods[0]), ["h1"])
            self.assertEqual(sorted(server._chat_hidden(None, None, False, pods[0])), ["h1", "h2"])

    def test_reading_the_list_does_not_prune(self):
        """목록 읽기(GET)는 허브 상태를 바꾸지 않는다. 정리는 shared_tick 60초 블록에서 한다(스펙 2026-11-05-005 D4)."""
        from types import SimpleNamespace
        from unittest import mock

        from aas.web import server
        hub = ChatHub(SETTINGS, connect=lambda: None, reconnect_delays=())
        hub.sessions["old"] = {"profile": "main", "created": 1.0, "title": "t", "by": "me@example.com", "last_at": 1.0}
        pods = [SimpleNamespace(id="a")]
        with mock.patch.object(server, "_my_agent_pods", return_value=(pods, {"a": "A"}, None)), \
                mock.patch.dict(server._hubs, {"a": hub}, clear=True), \
                mock.patch.dict("os.environ", {"AAS_CHAT_SESSION_TTL_HOURS": "1"}):
            rows = server._chat_sessions(None, {"email": "me@example.com"}, True, pods[0])
        self.assertEqual([r["session_id"] for r in rows], ["old"])
        self.assertIn("old", hub.sessions)

    def test_periodic_cleanup_prunes_every_hub(self):
        from unittest import mock

        from aas.web import server
        hubs = {"a": mock.Mock(), "b": mock.Mock()}
        hubs["b"].prune.side_effect = RuntimeError("one bad hub")       # 한 허브가 실패해도 나머지는 정리한다
        with mock.patch.dict(server._hubs, hubs, clear=True), \
                mock.patch.dict("os.environ", {"AAS_CHAT_SESSION_TTL_HOURS": "2"}):
            server._prune_chat_hubs()
        hubs["a"].prune.assert_called_once_with(7200.0)
        hubs["b"].prune.assert_called_once_with(7200.0)


if __name__ == "__main__":
    unittest.main()

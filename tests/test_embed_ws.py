# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""채팅 임베드 위젯의 웹소켓(OMAI-1873): 등록 출처·첫 메시지 auth·4401·쿠키 무시·경로 허용 목록·인증 전 정원·재인증.

test_ws 의 하네스(WsBase)를 그대로 쓴다 — 실제 uvicorn 서버에 websockets 클라이언트로 붙는다.
"""
import json
import time
import unittest
from unittest import mock

import embed_keys
from test_ws import ADMIN, ALICE, BOB, WsBase  # 하네스(시험 메서드가 없는 바탕 클래스)

from websockets.exceptions import ConnectionClosed
from websockets.sync.client import connect

from aas.auth import embed
from aas.web import protocol, ws

KC_ORIGIN, OTHER_ORIGIN, EVIL = "http://cop.ws-embed.example:8000", "https://portal.ws-embed.example", "https://evil.ws-embed.example"


class EmbedWsTest(WsBase):
    def setUp(self):
        with embed._conn() as conn:
            for t in ("embed_apps", "embed_origins", "embed_tokens"):
                conn.execute(f"DELETE FROM {t}")
        self.app = embed.add_app("COP", [KC_ORIGIN], "keycloak", app_id="ws-kc", issuer="https://kc.example/realms/cop",
                                 jwks_url="https://kc.internal/certs", audience="aas-embed")
        self.other = embed.add_app("Portal", [OTHER_ORIGIN], "host-signed", app_id="ws-host",
                                   public_jwk=json.dumps(embed_keys.key("host").jwk()))
        self.alice, _ = embed.issue(self.app, KC_ORIGIN, ALICE)

    def tearDown(self):
        with embed._conn() as conn:
            for t in ("embed_apps", "embed_origins", "embed_tokens"):
                conn.execute(f"DELETE FROM {t}")

    # ---- 도우미 ----------------------------------------------------------------
    def embed_open(self, token=None, origin=KC_ORIGIN, pod="a", cookie_of=None, hello=True):
        h = {"Cookie": self.session(cookie_of)} if cookie_of else {}
        c = connect(self.url, origin=origin, additional_headers=h, open_timeout=5)
        if token is None:
            return c
        c.send(json.dumps({"v": 1, "t": "auth", "token": token, "pod": pod}))
        authed = self.recv(c, "authed")
        if hello:
            c.send(json.dumps({"v": 1, "t": "hello", "lang": "ko", "resume": []}))
            self.recv(c, "welcome")
        c.authed = authed
        return c

    def bye(self, c, timeout=5.0):
        """(bye 코드, bye 이유, close 코드)."""
        code = reason = None
        try:
            deadline = time.time() + timeout
            while time.time() < deadline:
                msg = json.loads(c.recv(timeout=max(0.05, deadline - time.time())))
                if msg["t"] == "bye":
                    code, reason = msg["code"], msg["reason"]
        except ConnectionClosed:
            pass
        return code, reason, c.close_code

    def req(self, c, path, rid="r1"):
        c.send(json.dumps({"v": 1, "t": "req", "id": rid, "method": "get", "params": {"path": path}}))
        while True:
            msg = self.recv(c, "res")
            if msg["id"] == rid:
                return msg

    def wait_for(self, fn, timeout=3.0):
        deadline = time.time() + timeout
        while time.time() < deadline:
            if fn():
                return True
            time.sleep(0.02)
        return False

    # ---- 시험 -----------------------------------------------------------------
    def test_등록되지_않은_출처는_닫힌다(self):
        c = connect(self.url, origin=EVIL, open_timeout=5)
        self.assertEqual(self.bye(c)[::2], (protocol.FORBIDDEN, protocol.FORBIDDEN))

    def test_5초_안에_auth_가_없으면_4401(self):
        with mock.patch.object(ws, "EMBED_AUTH_TIMEOUT", 0.3):
            c = self.embed_open()
            self.assertEqual(self.bye(c), (protocol.UNAUTHORIZED, "auth_timeout", protocol.UNAUTHORIZED))

    def test_첫_메시지가_auth_가_아니거나_토큰이_틀리면_4401(self):
        c = self.embed_open(cookie_of=ALICE)                                 # 쿠키가 있어도 hello 로는 들어오지 못한다
        c.send(json.dumps({"v": 1, "t": "hello", "lang": "ko", "resume": []}))
        self.assertEqual(self.bye(c)[:2], (protocol.UNAUTHORIZED, "auth_first"))
        for token in ("aas_emb_wrong", "", None):
            c = self.embed_open()
            c.send(json.dumps({"v": 1, "t": "auth", "token": token, "pod": "a"}))
            self.assertEqual(self.bye(c)[:2], (protocol.UNAUTHORIZED, "token_invalid"), token)
        other, _ = embed.issue(self.other, OTHER_ORIGIN, ALICE)              # 다른 출처에 묶인 토큰
        c = self.embed_open()
        c.send(json.dumps({"v": 1, "t": "auth", "token": other, "pod": "a"}))
        self.assertEqual(self.bye(c)[:2], (protocol.UNAUTHORIZED, "token_invalid"))

    def test_쿠키는_버리고_auth_의_사용자로(self):
        c = self.embed_open(self.alice, cookie_of=ADMIN)                     # 같은 상위 도메인이면 관리자 쿠키가 실린다
        self.assertEqual((c.authed["user"], c.authed["pod"]), (ALICE, "a"))
        self.assertAlmostEqual(c.authed["expires"], time.time() + embed.TOKEN_TTL, delta=30)
        res = self.req(c, "/api/me")
        self.assertTrue(res["ok"])
        body = res["data"]["body"]
        self.assertEqual((res["data"]["status"], body["user"]["email"], body["admin"]), (200, ALICE, False))
        c.close()

    def test_관리_경로_대신_요청은_거절(self):
        c = self.embed_open(self.alice)
        for i, path in enumerate(("/api/users", "/api/admin/users", "/api/office", "/api/chat/transcribe", "/api/tokens")):
            res = self.req(c, path, rid=f"x{i}")
            self.assertEqual((res["ok"], res["error"]["code"]), (False, "forbidden"), path)
        res = self.req(c, "/api/chat/status?pod=b", rid="y")                   # 허용 목록 밖의 에이전트
        self.assertEqual(res["data"]["status"], 403)
        c.close()

    def test_대화_토픽만_구독하고_오피스에_쓰지_않는다(self):
        c = self.embed_open(self.alice)
        for topic in ("agents", "office:state", "notices", "pod:a:health"):
            c.send(json.dumps({"v": 1, "t": "sub", "topic": topic}))
            err = self.recv(c, "error")
            self.assertEqual((err["code"], err.get("topic")), ("forbidden", topic))
        c.send(json.dumps({"v": 1, "t": "pub", "topic": "office:presence", "data": {"x": 1, "y": 1, "f": 0}}))
        self.assertEqual(self.recv(c, "error")["code"], "bad_pub")
        c.close()

    def test_인증_전_연결은_정원에_넣지_않고_출처마다_센다(self):
        m = ws._manager
        before = len(m.conns) if m else 0
        with mock.patch.object(ws, "EMBED_PENDING_PER_ORIGIN", 2):
            a, b = self.embed_open(), self.embed_open()
            key = embed.normalize_origin(KC_ORIGIN)
            self.assertTrue(self.wait_for(lambda: ws._manager is not None and ws._manager.embed_pending.get(key) == 2))
            self.assertEqual(len(ws._manager.conns), before)                  # 정원(Manager.add)에는 아직 없다
            third = self.embed_open()
            self.assertEqual(self.bye(third)[:2], (protocol.TRY_AGAIN, "server_full"))
            a.send(json.dumps({"v": 1, "t": "auth", "token": self.alice, "pod": "a"}))
            self.recv(a, "authed")
            self.assertTrue(self.wait_for(lambda: len(ws._manager.conns) == before + 1))
            self.assertEqual(ws._manager.embed_pending.get(key), 1)
            a.close()
            b.close()
        self.assertTrue(self.wait_for(lambda: key not in ws._manager.embed_pending))

    def test_같은_연결에_auth_를_다시_보내면_갱신_다른_사람이면_닫힘(self):
        c = self.embed_open(self.alice)
        newer, _ = embed.issue(self.app, KC_ORIGIN, ALICE)
        c.send(json.dumps({"v": 1, "t": "auth", "token": newer, "pod": "a"}))
        self.assertEqual(self.recv(c, "authed")["user"], ALICE)
        embed.revoke(self.alice, KC_ORIGIN)                                   # 옛 토큰이 끝나도 새 토큰으로 이어 간다
        self.run_on_server(ws._manager.user_changed(ALICE))
        self.assertTrue(self.req(c, "/api/me")["ok"])
        bob, _ = embed.issue(self.app, KC_ORIGIN, BOB)
        c.send(json.dumps({"v": 1, "t": "auth", "token": bob, "pod": "b"}))
        self.assertEqual(self.bye(c)[:2], (protocol.UNAUTHORIZED, "user_changed"))

    def test_토큰을_폐기하면_다시_검사할_때_4401(self):
        c = self.embed_open(self.alice)
        embed.revoke(self.alice, KC_ORIGIN)
        self.run_on_server(ws._manager.user_changed(ALICE))
        self.assertEqual(self.bye(c)[:2], (protocol.UNAUTHORIZED, "token_ended"))

    def test_만료된_토큰의_대신_요청은_닫는다(self):
        c = self.embed_open(self.alice)
        conn = next(x for x in ws._manager.conns.values() if x.embed is not None and x.email == ALICE)
        conn.embed["expires"] = time.time() - 1
        c.send(json.dumps({"v": 1, "t": "req", "id": "z", "method": "get", "params": {"path": "/api/me"}}))
        self.assertEqual(self.bye(c)[:2], (protocol.UNAUTHORIZED, "token_expired"))

    def test_받아쓰기_스트림은_임베드_출처를_거절(self):
        c = connect(f"ws://127.0.0.1:{self.port}/api/chat/transcribe/stream?pod=a", origin=KC_ORIGIN,
                    additional_headers={"Cookie": self.session(ALICE)}, open_timeout=5)
        msg = json.loads(c.recv(timeout=5))
        self.assertEqual((msg["type"], msg["code"]), ("error", "forbidden"))
        c.close()

    def test_같은_출처_화면은_그대로(self):
        c = self.open(ALICE)                                                   # 쿠키·같은 출처 — auth 메시지 없이 hello 로
        c.send(json.dumps({"v": 1, "t": "auth", "token": self.alice}))        # 일반 연결의 auth 는 무시하고 오류만
        self.assertEqual(self.recv(c, "error")["code"], "bad_message")
        c.close()


if __name__ == "__main__":
    unittest.main()

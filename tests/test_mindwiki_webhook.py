# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""MindWiki 자동화 웹훅(스펙 2026-11-15-002 A5·D20~D24). Hermes 는 가짜 HermesAPI 다.
서명·시각·이전 비밀, 원장(다시 받음·설치 id·한도·시간대 경계), 도구 묶음 맞추기, 카드 본문, 응답 표, 본문 크기를 본다."""
import hashlib
import hmac
import json
import os
import tempfile
import time
import unittest
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

TMP = tempfile.TemporaryDirectory()
os.environ.setdefault("AAS_DATA_DIR", str(Path(TMP.name) / "data"))

import anyio  # noqa: E402
from starlette.requests import Request  # noqa: E402

from aas.common import store  # noqa: E402
from aas.hermes.hermes_api import HermesError  # noqa: E402
from aas.ops import mindwiki_connect  # noqa: E402
from aas.ops import mindwiki_webhook as mw  # noqa: E402
from aas.web import mindwiki_webhook as route  # noqa: E402

SECRET = "s" * 32


def _sig(body: bytes, t: int, install="inst-1", delivery="7", secret=SECRET):
    mac = hmac.new(secret.encode(), f"{t}.{install}.{delivery}.".encode() + body, hashlib.sha256).hexdigest()
    return f"t={t},sha256={mac}"


def _payload(sub="sub-a", web=False, instruction="요약 칸을 채워", page="row-1"):
    return json.dumps({"source": {"type": "automation", "name": "회사 조사"}, "workspaceId": "ws-9", "data": {"type": "page", "id": page, "title": "오픈마루"},
                       "agent": {"instruction": instruction, "web": web, "author": {"sub": sub, "email": f"{sub}@x", "name": "앨리스"},
                                 "target": {"pageId": page, "databaseId": "db-1"}}}).encode()


def _clear():
    with store.connect() as conn:
        conn.executescript(mw.SCHEMA)
        conn.execute("DELETE FROM mindwiki_webhook_ledger")


class OpsTest(unittest.TestCase):
    def setUp(self):
        p = mock.patch.dict(os.environ, {"AAS_MINDWIKI_WEBHOOK_SECRET": SECRET, "AAS_MINDWIKI_WEBHOOK_SECRET_PREV": "",
                                         "AAS_TIMEZONE": "Asia/Seoul", "AAS_MINDWIKI_WEBHOOK_LIMIT_AUTHOR": "2", "AAS_MINDWIKI_WEBHOOK_LIMIT_INSTALL": "3"})
        p.start()
        self.addCleanup(p.stop)
        _clear()
        self.addCleanup(_clear)

    def h(self, body, t=None, install="inst-1", delivery="7", secret=SECRET):
        t = int(time.time()) if t is None else t
        return {"x-mindwiki-installation": install, "x-mindwiki-delivery": delivery, "x-mindwiki-signature": _sig(body, t, install, delivery, secret)}

    def test_서명(self):
        b = _payload()
        self.assertEqual(mw.verify(self.h(b), b), ("inst-1", "7"))
        with self.assertRaises(mw.Reject) as cm:
            mw.verify(self.h(b, secret="x" * 32), b)
        self.assertEqual((cm.exception.status, cm.exception.reason), (401, "bad_signature"))
        bad = self.h(b)
        bad["x-mindwiki-delivery"] = "8"                                  # delivery 를 바꿔 다시 보내면 맞지 않는다(리뷰 Eng E6)
        with self.assertRaises(mw.Reject) as cm:
            mw.verify(bad, b)
        self.assertEqual(cm.exception.reason, "bad_signature")
        with self.assertRaises(mw.Reject) as cm:
            mw.verify(self.h(b, t=int(time.time()) - 400), b)
        self.assertEqual((cm.exception.status, cm.exception.reason), (401, "stale_timestamp"))
        self.assertTrue(cm.exception.detail.startswith("4"))
        with mock.patch.dict(os.environ, {"AAS_MINDWIKI_WEBHOOK_SECRET": "n" * 32, "AAS_MINDWIKI_WEBHOOK_SECRET_PREV": SECRET}):
            self.assertEqual(mw.verify(self.h(b), b)[1], "7")               # 바꾸는 동안 이전 비밀도 받는다
        with mock.patch.dict(os.environ, {"AAS_MINDWIKI_WEBHOOK_SECRET": ""}):
            with self.assertRaises(mw.Reject) as cm:
                mw.verify(self.h(b), b)
            self.assertEqual((cm.exception.status, cm.exception.reason), (503, "webhook_disabled"))

    def test_원장_다시_받음과_설치_id(self):
        self.assertIsNone(mw.begin("inst-1", "7", "sub-a"))
        with self.assertRaises(mw.Reject) as cm:                          # 같은 delivery 가 동시에 왔다 — 카드 둘을 막는다
            mw.begin("inst-1", "7", "sub-a")
        self.assertEqual((cm.exception.status, cm.exception.reason), (503, "in_progress"))
        mw.release("inst-1", "7")                                        # 앞 시도가 카드를 못 만들고 끝났다
        self.assertIsNone(mw.begin("inst-1", "7", "sub-a"))              # 다시 한다(한도는 다시 세지 않는다)
        self.assertIsNone(mw.begin("inst-1", "7", "sub-a", now=time.time() + mw.HOLD + 1))   # 멈춘 시도도 HOLD 뒤에는 다시
        mw.finish("inst-1", "7", "t_1", "ok")
        self.assertEqual(mw.begin("inst-1", "7", "sub-a")["card_id"], "t_1")
        self.assertIsNone(mw.begin("inst-2", "7", "sub-a"))              # 같은 delivery 다른 설치는 따로(리뷰 Eng F11)

    def test_한도는_작성자마다와_설치_전체_422(self):
        mw.begin("i", "1", "a")
        mw.begin("i", "2", "a")
        with self.assertRaises(mw.Reject) as cm:
            mw.begin("i", "3", "a")
        self.assertEqual((cm.exception.status, cm.exception.reason), (422, "author_daily_limit"))
        self.assertIsNone(mw.begin("i", "4", "b"))                        # A 가 넘어도 B 는 된다
        with self.assertRaises(mw.Reject) as cm:
            mw.begin("i", "5", "c")
        self.assertEqual((cm.exception.status, cm.exception.reason), (422, "install_daily_limit"))

    def test_하루_경계는_AAS_TIMEZONE_의_자정(self):
        kst = 9 * 3600
        before = datetime(2026, 11, 15, 23, 59, 59, tzinfo=timezone.utc).timestamp() - kst
        self.assertEqual((mw.day_of(before), mw.day_of(before + 1)), ("2026-11-15", "2026-11-16"))
        mw.begin("i", "1", "a", now=before)
        mw.begin("i", "2", "a", now=before)
        self.assertIsNone(mw.begin("i", "3", "a", now=before + 1))        # 자정이 지나 새 하루

    def test_도구_묶음은_웹만_남긴다(self):
        rows = [{"name": "web", "enabled": True}, {"name": "terminal", "enabled": True}, {"name": "kanban", "enabled": False}, {"name": "file", "enabled": True}]
        self.assertEqual(mw.toolset_changes(rows, False), [("web", False), ("terminal", False), ("file", False)])
        self.assertEqual(mw.toolset_changes([{"name": "web", "enabled": False}, {"name": "file", "enabled": True}], True), [("web", True), ("file", False)])

    def test_카드_본문(self):
        w = mw.parse(_payload(instruction="요약 ```끝``` 채워"))
        c = mw.card(w, "inst-1", "7")
        self.assertEqual(c["idempotency_key"], "mw:inst-1:7")
        self.assertIn("automation_run: 7", c["body"])
        self.assertIn("row_id=row-1", c["body"])
        self.assertIn("\n````\n요약 ```끝``` 채워\n````\n", c["body"])   # 울타리가 내용보다 길다
        with self.assertRaises(mw.Reject):
            mw.parse(b'{"agent": {"instruction": "x"}}')

    def test_자동화_전용_프로파일의_쓰기_토큰은_automation(self):
        self.assertTrue(mindwiki_connect.token_body("mindwiki-auto", True)["automation"])
        self.assertNotIn("automation", mindwiki_connect.token_body("mindwiki-auto", False))
        self.assertNotIn("automation", mindwiki_connect.token_body("main", True))


class FakeAPI:
    calls: list = []
    profiles: list = []
    toolsets: list = []
    fail: HermesError | None = None
    tasks: dict = {}

    def __init__(self, auth):
        pass

    def call(self, method, path, body=None, query=None, timeout=30):
        FakeAPI.calls.append((method, path, body, query))
        if FakeAPI.fail is not None:
            raise FakeAPI.fail
        if (method, path) == ("GET", "/api/profiles"):
            return {"profiles": [{"name": n} for n in FakeAPI.profiles]}
        if (method, path) == ("POST", "/api/profiles"):
            FakeAPI.profiles.append(body["name"])
            return {"ok": True}
        if (method, path) == ("GET", "/api/tools/toolsets"):
            return FakeAPI.toolsets
        if method == "POST" and path == "/api/plugins/kanban/tasks":
            tid = FakeAPI.tasks.setdefault(body["idempotency_key"], f"t_{len(FakeAPI.tasks) + 1}")
            return {"task": {"id": tid}}
        return {}


class Pod(SimpleNamespace):
    def owned_by(self, user):
        return user.get("sub") == self.owner_sub or user.get("email") == self.owner


def _post(body: bytes, headers: dict, chunks: list | None = None):
    hs = [(k.lower().encode(), v.encode()) for k, v in headers.items()]
    scope = {"type": "http", "method": "POST", "path": route.PATH, "query_string": b"", "headers": hs, "scheme": "https",
             "server": ("aas.corp", 443), "client": ("10.0.0.1", 1), "root_path": ""}
    parts = list(chunks) if chunks is not None else [body]

    async def receive():
        if not parts:
            return {"type": "http.disconnect"}
        part = parts.pop(0)
        return {"type": "http.request", "body": part, "more_body": bool(parts)}

    resp = anyio.run(route.receive, Request(scope, receive))
    return resp.status_code, json.loads(resp.body)


class RouteTest(unittest.TestCase):
    def setUp(self):
        p = mock.patch.dict(os.environ, {"AAS_MINDWIKI_WEBHOOK_SECRET": SECRET, "AAS_TIMEZONE": "Asia/Seoul"})
        p.start()
        self.addCleanup(p.stop)
        _clear()
        self.addCleanup(_clear)
        FakeAPI.calls, FakeAPI.profiles, FakeAPI.fail, FakeAPI.tasks = [], [], None, {}
        FakeAPI.toolsets = [{"name": "web", "enabled": True}, {"name": "terminal", "enabled": True}, {"name": "mcp", "enabled": True}]
        route._BOARDS.clear()
        route._MAKING.clear()
        self.sub = "sub-" + os.urandom(3).hex()
        self.pods = [Pod(id="pod-a", owner="a@x", owner_sub=self.sub)]
        for target, new in ((route, "HermesAPI"),):
            q = mock.patch.object(target, new, FakeAPI)
            q.start()
            self.addCleanup(q.stop)
        for name, fn in (("registry", lambda: SimpleNamespace(pods=self.pods)), ("hub", lambda pod: SimpleNamespace(auth=None))):
            q = mock.patch.object(route.server, name, fn)
            q.start()
            self.addCleanup(q.stop)
        q = mock.patch.object(route.primary, "primary_of", lambda pod_id: "main")
        q.start()
        self.addCleanup(q.stop)
        self.addCleanup(self._forget)
        self.delivery = 100

    def _forget(self):
        with mindwiki_connect._conn() as conn:                            # 시험이 함께 쓰는 데이터 폴더 — 넣은 행을 지운다
            conn.execute("DELETE FROM connector_tokens WHERE sub=?", (self.sub,))

    def send(self, body=None, delivery=None, **kw):
        body = _payload(self.sub, **kw) if body is None else body
        delivery = str(self.delivery if delivery is None else delivery)
        h = {"x-mindwiki-installation": "inst-1", "x-mindwiki-delivery": delivery, "x-mindwiki-signature": _sig(body, int(time.time()), delivery=delivery),
             "content-type": "application/json", "content-length": str(len(body))}
        return _post(body, h)

    def connect(self, profile="mindwiki-auto", write=1, expires="2099-01-01T00:00:00+00:00"):
        with mindwiki_connect._conn() as conn:
            conn.execute("INSERT INTO connector_tokens (product, sub, pod, profile, tid, workspace, write, status, expires_at, created_at) "
                         "VALUES ('mindwiki', ?, 'pod-a', ?, 'tid', 'ws', ?, 'connected', ?, '') ON CONFLICT DO NOTHING", (self.sub, profile, write, expires))

    def wait_made(self):
        for _ in range(100):
            if not route._MAKING:
                return
            time.sleep(0.02)
        self.fail("profile thread did not finish")

    def test_쓰기_연결이_없으면_202_막힘이고_다음_로그인을_기다린다(self):
        code, out = self.send()
        self.assertEqual((code, out["reason"]), (202, "blocked_no_write_token"))
        # 프로파일이 없으면 만들기를 뒤로 돌리고 곧바로 답한다(MindWiki 웹훅 제한 10초, OKE 첫 웹훅 약 11초)
        self.assertFalse(any(c[:2] == ("POST", "/api/profiles") for c in FakeAPI.calls[:2]))
        self.wait_made()
        self.assertIn("mindwiki-auto", FakeAPI.profiles)                  # 프로파일은 뒤에서 만든다(사람에게 보인다)
        self.assertIn(("/api/tools/toolsets/terminal", False), [(c[1], c[2]["enabled"]) for c in FakeAPI.calls if c[0] == "PUT"])
        row = mindwiki_connect._row(self.sub, "pod-a", "mindwiki-auto")
        self.assertEqual((row["status"], row["workspace"]), ("idle", "ws-9"))   # 자동 첫 연결은 자동화의 워크스페이스로
        self.assertFalse(any(c[1] == "/api/plugins/kanban/tasks" for c in FakeAPI.calls))
        self.assertTrue(out["trace_id"].startswith("mw_"))

    def test_카드는_자동화_전용_프로파일로_도구는_웹만(self):
        FakeAPI.profiles.append("mindwiki-auto")
        self.connect()
        code, out = self.send()
        self.assertEqual((code, out["reason"], out["card_id"]), (202, "ok", "t_1"))
        puts = [(c[1], c[2]["enabled"]) for c in FakeAPI.calls if c[0] == "PUT"]
        self.assertEqual(puts, [("/api/tools/toolsets/web", False), ("/api/tools/toolsets/terminal", False), ("/api/tools/toolsets/mcp", False)])
        task = next(c for c in FakeAPI.calls if c[1] == "/api/plugins/kanban/tasks")
        self.assertEqual((task[2]["assignee"], task[2]["idempotency_key"], task[3]), ("mindwiki-auto", f"mw:inst-1:{self.delivery}", {"board": "mindwiki"}))
        # 같은 delivery 를 다시 받으면 첫 카드(새 카드 없음)
        n = len(FakeAPI.calls)
        code, out = self.send()
        self.assertEqual((code, out["card_id"]), (200, "t_1"))
        self.assertEqual(len(FakeAPI.calls), n)

    def test_웹_조사를_켠_자동화는_웹_프로파일(self):
        FakeAPI.profiles.append("mindwiki-auto-web")
        self.connect("mindwiki-auto-web")
        code, out = self.send(web=True)
        self.assertEqual((code, out["reason"]), (202, "ok"))
        task = next(c for c in FakeAPI.calls if c[1] == "/api/plugins/kanban/tasks")
        self.assertEqual(task[2]["assignee"], "mindwiki-auto-web")
        self.assertNotIn(("/api/tools/toolsets/web", False), [(c[1], c[2]["enabled"]) for c in FakeAPI.calls if c[0] == "PUT"])

    def test_Hermes_가_시작_중이면_503이고_다시_받으면_카드_하나(self):
        FakeAPI.profiles.append("mindwiki-auto")
        self.connect()
        FakeAPI.fail = HermesError("starting", 503)
        code, out = self.send()
        self.assertEqual((code, out["reason"]), (503, "hermes_not_ready"))
        FakeAPI.fail = None
        code, out = self.send()
        self.assertEqual((code, out["reason"], out["card_id"]), (202, "ok", "t_1"))

    def test_주_에이전트가_없으면_422(self):
        self.pods.clear()
        code, out = self.send()
        self.assertEqual((code, out["reason"]), (422, "no_agent"))

    def test_서명_틀림_시각_지남_꺼짐(self):
        body = _payload(self.sub)
        h = {"x-mindwiki-installation": "inst-1", "x-mindwiki-delivery": "5", "x-mindwiki-signature": _sig(body, int(time.time()), secret="x" * 32)}
        self.assertEqual(_post(body, h)[1]["reason"], "bad_signature")
        h["x-mindwiki-signature"] = _sig(body, int(time.time()) - 600, delivery="5")
        code, out = _post(body, h)
        self.assertEqual((code, out["reason"]), (401, "stale_timestamp"))
        with mock.patch.dict(os.environ, {"AAS_MINDWIKI_WEBHOOK_SECRET": ""}):
            self.assertEqual(self.send()[0], 503)

    def test_256KiB_넘는_본문은_413(self):
        big = b"x" * (mw.MAX_BODY + 1)
        self.assertEqual(_post(big, {"content-length": str(len(big))})[0], 413)
        # 길이를 거짓으로 적거나 chunked 로 보내도 흘려 읽다가 끊는다
        self.assertEqual(_post(b"", {"content-length": "10"}, chunks=[b"x" * 200_000, b"x" * 200_000])[0], 413)
        self.assertEqual(_post(b"", {}, chunks=[b"x" * 200_000, b"x" * 200_000])[0], 413)

    def test_429_를_쓰지_않는다(self):
        with mock.patch.dict(os.environ, {"AAS_MINDWIKI_WEBHOOK_LIMIT_AUTHOR": "1"}):
            FakeAPI.profiles.append("mindwiki-auto")
            self.connect()
            self.assertEqual(self.send()[0], 202)
            code, out = self.send(delivery=self.delivery + 1)
            self.assertEqual((code, out["reason"]), (422, "author_daily_limit"))


if __name__ == "__main__":
    unittest.main()

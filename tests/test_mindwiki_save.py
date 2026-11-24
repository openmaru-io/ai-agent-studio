# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""「MindWiki 에 저장」(스펙 2026-11-15-002 A4·D11·D19, 리뷰 Eng E5·E12·F8). MindWiki 는 이 프로세스의 가짜 HTTP 서버다.
머리글(Idempotency-Key·X-Workspace·한글 파일 이름), 이유 코드, 끝 줄, 확인 기억, 저장 위치, 주인만·Keycloak 만, 사용 기록을 본다."""
import http.server
import json
import os
import tempfile
import threading
import unittest
from datetime import datetime, timezone
from email.header import decode_header, make_header
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

TMP = tempfile.TemporaryDirectory()
os.environ.setdefault("AAS_DATA_DIR", str(Path(TMP.name) / "data"))

import anyio  # noqa: E402
from starlette.requests import Request  # noqa: E402

from aas.common import store  # noqa: E402
from aas.ops import mindwiki_save as ms  # noqa: E402
from aas.web import files, mindwiki_save as route, server  # noqa: E402


class Wiki(http.server.BaseHTTPRequestHandler):
    seen: list = []
    answers: dict = {}

    def log_message(self, *a):
        pass

    def _reply(self):
        n = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(n) if n else b""
        Wiki.seen.append({"method": self.command, "path": self.path, "headers": dict(self.headers), "body": body})
        status, out = Wiki.answers.get((self.command, self.path.split("?")[0]), (404, {}))
        raw = json.dumps(out).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    do_GET = do_POST = do_PUT = _reply


class OpsTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.httpd = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Wiki)
        threading.Thread(target=cls.httpd.serve_forever, daemon=True).start()
        cls.url = f"http://127.0.0.1:{cls.httpd.server_address[1]}"

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()

    def setUp(self):
        Wiki.seen, Wiki.answers = [], {}
        ms.clear_cache()
        p = mock.patch.dict(os.environ, {"AAS_MINDWIKI_URL": self.url, "AAS_TIMEZONE": "Asia/Seoul"})
        p.start()
        self.addCleanup(p.stop)
        self.sub = "sub-" + os.urandom(3).hex()
        self.addCleanup(lambda: ms.forget_targets("pod-s"))

    def test_답은_요청_id·워크스페이스와_함께_가고_끝_줄을_붙인다(self):
        Wiki.answers[("POST", "/api/connector/pages")] = (201, {"pageId": "p-new", "url": "https://wiki/p/p-new"})
        out = ms.save_answer("at-1", "ws-1", parent="p-parent", title="  배포   절차 ", markdown="# 답\n\n본문", key="c1:m1:p-parent",
                             agent="main", aas_url="https://aas.corp/")
        self.assertEqual(out, {"page_id": "p-new", "url": "https://wiki/p/p-new", "replayed": False, "body_failed": False})
        h, body = Wiki.seen[0]["headers"], json.loads(Wiki.seen[0]["body"])
        self.assertEqual((h["Idempotency-Key"], h["X-Workspace"], h["Authorization"]), ("c1:m1:p-parent", "ws-1", "Bearer at-1"))
        self.assertEqual((body["parentId"], body["title"]), ("p-parent", "배포 절차"))
        self.assertRegex(body["markdown"], r"^# 답\n\n본문\n\n---\n\nAAS 대화에서 저장: main · \d{4}-\d\d-\d\d \d\d:\d\d · \[대화 열기\]\(https://aas\.corp/#/chat\)$")

    def test_같은_키의_둘째는_replayed(self):
        Wiki.answers[("POST", "/api/connector/pages")] = (200, {"pageId": "p-new"})
        self.assertTrue(ms.save_answer("t", "w", parent="p", title="x", markdown="y", key="k", agent="a", aas_url="")["replayed"])

    def test_이유_코드(self):
        for status, out, want in ((404, {}, "old_mindwiki"), (403, {"code": "not_connector"}, "old_mindwiki"), (403, {"code": "connector_scope"}, "old_mindwiki"),
                                  (409, {"code": "in_progress"}, "in_progress"), (429, {"code": "rate_limited"}, "rate_limited"),
                                  (403, {"code": "write_disabled"}, "write_disabled"), (404, {"code": "parent_not_found"}, "parent_not_found"),
                                  (403, {"code": "forbidden_parent"}, "forbidden_parent"), (409, {"code": "need_workspace"}, "need_workspace"),
                                  (413, {"code": "attachment_too_large"}, "attachment_too_large"), (401, {}, "session_ended"), (500, {}, "mindwiki_5xx")):
            Wiki.answers[("POST", "/api/connector/pages")] = (status, out)
            with self.assertRaises(ms.SaveError) as cm:
                ms.save_answer("secret-token", "w", parent="p", title="x", markdown="y", key="k", agent="a", aas_url="")
            self.assertEqual(cm.exception.reason, want, (status, out))
            self.assertNotIn("secret-token", repr(cm.exception))          # 토큰은 오류에 넣지 않는다(리뷰 DX)

    def test_위치가_없거나_글이_비면_부르지_않는다(self):
        for kw, want in (({"parent": ""}, "need_target"), ({"markdown": " "}, "invalid"), ({"title": ""}, "invalid")):
            args = {"parent": "p", "title": "x", "markdown": "y", "key": "k", "agent": "a", "aas_url": "", **kw}
            with self.assertRaises(ms.SaveError) as cm:
                ms.save_answer("t", "w", **args)
            self.assertEqual(cm.exception.reason, want)
        self.assertEqual(Wiki.seen, [])

    def test_파일은_흘려_보내고_한글_이름은_RFC2047(self):
        Wiki.answers[("POST", "/api/connector/pages/p-parent/attachments")] = (201, {"pageId": "p-files", "attachmentId": "a1", "name": "보고서.pdf"})
        data = b"%PDF-1.4 " * 1000
        import io
        out = ms.save_file("t", "ws-1", parent="p-parent", name="보고서.pdf", stream=io.BytesIO(data), length=len(data), key="f1")
        self.assertEqual((out["page_id"], out["attachment_id"]), ("p-files", "a1"))
        seen = Wiki.seen[0]
        self.assertEqual(seen["path"], "/api/connector/pages/p-parent/attachments?container=aas-files")
        self.assertEqual(seen["body"], data)
        self.assertEqual(str(make_header(decode_header(seen["headers"]["X-File-Name"]))), "보고서.pdf")
        self.assertEqual(seen["headers"]["Content-Type"], "application/octet-stream")

    def test_확인은_설치_단위로_10분_기억한다(self):
        Wiki.answers[("GET", "/api/connector/capabilities")] = (200, {"save": 1, "writeDisabled": False})
        self.assertIsNone(ms.cached_capabilities())
        self.assertEqual(ms.capabilities("t", "w")["reason"], "")
        ms.capabilities("t", "w")
        self.assertEqual(len(Wiki.seen), 1)
        self.assertEqual(ms.cached_capabilities()["save"], True)
        ms.clear_cache()
        Wiki.answers[("GET", "/api/connector/capabilities")] = (404, {})   # 옛 MindWiki
        self.assertEqual(ms.capabilities("t", "w")["reason"], "old_mindwiki")

    def test_저장_위치는_사람·작업공간·프로파일마다(self):
        ms.set_target(self.sub, "pod-s", "main", workspace="ws-1", teamspace="ts", parent_id="p1", parent_title="메모", path="팀")
        ms.set_target(self.sub, "pod-s", "main", workspace="ws-1", teamspace="ts", parent_id="p2", parent_title="새 메모", path="팀")
        self.assertEqual(ms.target(self.sub, "pod-s", "main")["parent_id"], "p2")
        self.assertIsNone(ms.target(self.sub, "pod-s", "other"))
        self.assertIsNone(ms.target("someone-else", "pod-s", "main"))
        self.assertEqual(ms.forget_targets("pod-s", "main"), 1)

    def test_끝_줄의_시각은_AAS_TIMEZONE(self):
        at = datetime(2026, 11, 15, 15, 30, tzinfo=timezone.utc)
        self.assertEqual(ms.footer("main", "", at), "AAS 대화에서 저장: main · 2026-11-16 00:30")
        with mock.patch.dict(os.environ, {"AAS_TIMEZONE": "UTC"}):
            self.assertEqual(ms.footer("main", "", at), "AAS 대화에서 저장: main · 2026-11-15 15:30")


class FakeAuth:
    enabled, oidc_enabled = True, True

    def __init__(self):
        self.token = ("at-1", "")

    def access_token(self, cookie):
        return self.token


class Reply:
    def __init__(self, resp):
        self.status_code, self._body = resp.status_code, resp.body

    def json(self):
        return json.loads(self._body)


class Client:
    """Starlette 경로 처리 함수에 ASGI 요청을 직접 넣는다(이 환경에는 TestClient 가 쓰는 httpx 가 없다)."""
    def __init__(self, routes):
        self.routes = routes

    def _call(self, method, path, params=None, json_body=None):
        from urllib.parse import urlencode
        raw = json.dumps(json_body).encode() if json_body is not None else b""
        scope = {"type": "http", "method": method, "path": path, "query_string": urlencode(params or {}).encode(),
                 "headers": [(b"host", b"aas.corp"), (b"content-type", b"application/json"), (b"cookie", b"aas_session=c")],
                 "scheme": "https", "server": ("aas.corp", 443), "client": ("127.0.0.1", 1), "root_path": ""}
        sent = {"done": False}

        async def receive():
            if sent["done"]:
                return {"type": "http.disconnect"}
            sent["done"] = True
            return {"type": "http.request", "body": raw, "more_body": False}

        return Reply(anyio.run(self.routes[path], Request(scope, receive)))

    def get(self, path, params=None):
        return self._call("GET", path, params=params)

    def post(self, path, json=None):
        return self._call("POST", path, json_body=json)

    def put(self, path, json=None):
        return self._call("PUT", path, json_body=json)


class RouteTest(unittest.TestCase):
    def setUp(self):
        self.auth = FakeAuth()
        self.owner = {"sub": "sub-owner", "email": "o@corp"}
        self.user = self.owner
        self.pod = SimpleNamespace(id="pod-r")
        self.saved = []
        patches = [
            mock.patch.object(server, "auth", lambda: self.auth),
            mock.patch.object(server, "request_user", lambda a, r: self.user),
            mock.patch.object(server, "registry", lambda: SimpleNamespace(allowed=lambda u, e: [self.pod])),
            mock.patch.object(server, "_owns_pod", lambda pod, user, e: user is self.owner),
            mock.patch.object(files._View, "_host_ok", lambda self: True),
            mock.patch.object(files._View, "_same_origin", lambda self: True),
            mock.patch.object(ms, "connected_workspace", lambda sub, pod, profile: "ws-1"),
            mock.patch.object(ms, "save_answer", lambda token, ws, **kw: self.saved.append((token, ws, kw)) or {"page_id": "p-new", "url": "u", "replayed": False}),
            mock.patch.dict(os.environ, {"AAS_MINDWIKI_URL": "https://wiki.example.com"}),   # 함께 설치한 곳(스펙 2026-11-23-019 G1)
        ]
        for p in patches:
            p.start()
            self.addCleanup(p.stop)
        self.client = Client({r.path: r.endpoint for r in route.routes()})
        self.addCleanup(lambda: ms.forget_targets("pod-r"))
        with store.connect() as conn:
            conn.execute("DELETE FROM usage WHERE kind='mindwiki_save'")

    def answer(self, **kw):
        body = {"pod": "pod-r", "profile": "main", "key": "c:m:p", "title": "t", "markdown": "m", **kw}
        return self.client.post("/api/mindwiki/save/answer", json=body)

    def test_주인만_저장하고_관리자도_남의_것은_못한다(self):
        self.user = {"sub": "admin", "email": "admin@corp"}
        r = self.answer(parent_id="p1")
        self.assertEqual((r.status_code, r.json()["reason"]), (403, "not_owner"))
        self.assertEqual(self.saved, [])

    def test_Keycloak_로그인이_아니면_단추를_숨긴다(self):
        self.auth.oidc_enabled = False
        r = self.client.get("/api/mindwiki/save/state", params={"pod": "pod-r", "profile": "main"})
        self.assertEqual(r.json(), {"available": False, "hidden": True, "reason": "no_keycloak"})
        self.assertEqual(self.answer(parent_id="p1").json()["reason"], "no_keycloak")

    def test_저장_위치를_기억하고_그_위치로_저장한다(self):
        self.assertEqual(self.answer().json()["reason"], "need_target")
        r = self.client.put("/api/mindwiki/save/target", json={"pod": "pod-r", "profile": "main", "parent_id": "p9", "parent_title": "메모", "path": "팀"})
        self.assertEqual(r.json()["target"]["parent_id"], "p9")
        st = self.client.get("/api/mindwiki/save/state", params={"pod": "pod-r", "profile": "main"}).json()
        self.assertEqual((st["available"], st["target"]["parent_title"]), (True, "메모"))
        r = self.answer()
        self.assertEqual((r.status_code, r.json()["page_id"]), (200, "p-new"))
        token, ws, kw = self.saved[0]
        # 옛 화면이 보낸 key 는 서버 키의 대상으로만 쓴다(스펙 2026-11-23-019 P8)
        self.assertEqual((token, ws, kw["parent"], kw["key"]), ("at-1", "ws-1", "p9", ms.save_key("answer", "pod-r", "main", "page", "p9", "key", "c:m:p")))
        with store.connect() as conn:
            rows = [dict(x) for x in conn.execute("SELECT note, pod FROM usage WHERE kind='mindwiki_save'")]
        self.assertEqual(rows, [{"note": "main answer p-new", "pod": "pod-r"}])     # 본문은 남기지 않는다

    def test_대화_열기_주소는_AAS_PUBLIC_URL(self):
        """ingress 뒤에서는 요청 주소가 http:// 다 — 끝 줄 링크는 설치 값 공개 주소로(OKE 2026-11-15)."""
        with mock.patch.dict(os.environ, {"AAS_PUBLIC_URL": "https://aas.oke.example/"}):
            self.answer(parent_id="p1")
        self.assertEqual(self.saved[-1][2]["aas_url"], "https://aas.oke.example")
        with mock.patch.dict(os.environ, {"AAS_PUBLIC_URL": ""}):
            self.answer(parent_id="p1", key="c:m:p2")
        self.assertEqual(self.saved[-1][2]["aas_url"], "https://aas.corp")          # 설치 값이 없으면 요청 주소

    def test_로그인_세션이_끝나면_다시_로그인(self):
        self.auth.token = ("", "session_ended")
        r = self.answer(parent_id="p1")
        self.assertEqual((r.status_code, r.json()["reason"]), (409, "session_ended"))   # 화면 전역의 401 이동을 타지 않는다
        self.auth.token = ("", "keycloak_unavailable")
        self.assertEqual(self.answer(parent_id="p1").status_code, 503)

    def test_연결_워크스페이스가_없으면_need_workspace(self):
        with mock.patch.object(ms, "connected_workspace", lambda *a: ""):
            r = self.answer(parent_id="p1")
            self.assertEqual((r.status_code, r.json()["reason"]), (409, "need_workspace"))
            st = self.client.get("/api/mindwiki/save/state", params={"pod": "pod-r", "profile": "main"}).json()
            self.assertEqual((st["available"], st["reason"]), (False, "need_workspace"))

    def test_워크스페이스가_바뀌면_기억한_위치를_쓰지_않는다(self):
        ms.set_target("sub-owner", "pod-r", "main", workspace="ws-old", teamspace="", parent_id="p1", parent_title="", path="")
        self.assertEqual(self.answer().json()["reason"], "need_target")
        st = self.client.get("/api/mindwiki/save/state", params={"pod": "pod-r", "profile": "main"}).json()
        self.assertIsNone(st["target"])

    def test_키가_없으면_거절(self):
        self.assertEqual(self.answer(parent_id="p1", key="").json()["reason"], "invalid")

    # ---- 스펙 2026-11-23-019 1a ----------------------------------------------------------------------------------------------
    def test_MindWiki_를_함께_설치하지_않으면_숨기고_다른_경로는_409(self):
        with mock.patch.dict(os.environ, {"AAS_MINDWIKI_URL": ""}):
            r = self.client.get("/api/mindwiki/save/state", params={"pod": "pod-r", "profile": "main"})
            self.assertEqual(r.json(), {"available": False, "hidden": True, "reason": "no_mindwiki"})
            r = self.answer(parent_id="p1")
            self.assertEqual((r.status_code, r.json()["reason"]), (409, "no_mindwiki"))
        self.assertEqual(self.saved, [])

    def test_검사_순서는_로그인_다음_no_mindwiki_다음_no_keycloak(self):
        self.auth.oidc_enabled = False
        with mock.patch.dict(os.environ, {"AAS_MINDWIKI_URL": ""}):
            self.assertEqual(self.answer(parent_id="p1").json()["reason"], "no_mindwiki")   # 둘 다 해당하면 no_mindwiki
            self.user = None
            r = self.answer(parent_id="p1")
            self.assertEqual((r.status_code, r.json()["reason"]), (401, "session_ended"))  # 로그인하지 않았으면 로그인이 먼저

    def test_답_키는_서버가_대화_메시지로_만든다(self):
        self.answer(parent_id="p1", key=None, conversation="conv-1", message="msg-1")
        self.assertEqual(self.saved[-1][2]["key"], ms.save_key("answer", "pod-r", "main", "page", "p1", "conv-1", "msg-1"))
        self.answer(parent_id="p1", key=None, conversation="conv-1", message="msg-1")
        self.assertEqual(self.saved[-1][2]["key"], self.saved[-2][2]["key"])                # 같은 답·같은 위치는 같은 키
        self.answer(parent_id="p2", key=None, conversation="conv-1", message="msg-1")
        self.assertNotEqual(self.saved[-1][2]["key"], self.saved[-2][2]["key"])             # 위치가 다르면 다른 키


class Stage2OpsTest(OpsTest):
    """저장 위치 넓히기(스펙 2026-11-23-019 2단계) — MindWiki 로 가는 모양. OpsTest 의 가짜 MindWiki 를 그대로 쓴다."""

    def test_판_번호는_정수로_새_데이터베이스_가능_여부와_함께(self):
        ms.clear_cache()
        Wiki.answers[("GET", "/api/connector/capabilities")] = (200, {"save": 2, "makeDatabase": True})
        cap = ms.capabilities("at", "ws")
        self.assertEqual((cap["save_level"], cap["make_database"], ms.save_level()), (2, True, 2))
        ms.clear_cache()

    def test_데이터베이스_저장은_parentKind_와_body_failed(self):
        Wiki.answers[("POST", "/api/connector/pages")] = (201, {"pageId": "row-1", "url": "u", "bodyFailed": True})
        out = ms.save_answer("at", "ws", parent="db-1", title="t", markdown="m", key="k", agent="a", aas_url="", kind="database")
        self.assertTrue(out["body_failed"])
        self.assertEqual(json.loads(Wiki.seen[-1]["body"])["parentKind"], "database")
        ms.save_answer("at", "ws", parent="p", title="t", markdown="m", key="k2", agent="a", aas_url="")
        self.assertNotIn("parentKind", json.loads(Wiki.seen[-1]["body"]))     # 페이지는 옛 MindWiki 와 같은 본문

    def test_목록은_판_2_에서만_kinds_를_보내고_이름을_바꾼다(self):
        Wiki.answers[("GET", "/api/connector/pages")] = (200, {"pages": [{"id": "d", "title": "DB", "path": "", "kind": "database", "hasChildren": False}]})
        out = ms.pages("at", "ws", teamspace="t", kinds=True)
        self.assertIn("kinds=page%2Cdatabase", Wiki.seen[-1]["path"])
        self.assertEqual(out["pages"][0], {"id": "d", "title": "DB", "path": "", "kind": "database", "has_children": False})
        ms.pages("at", "ws", teamspace="t")
        self.assertNotIn("kinds", Wiki.seen[-1]["path"])

    def test_팀스페이스의_canCreateTop_을_snake_로(self):
        Wiki.answers[("GET", "/api/connector/teamspaces")] = (200, {"teamspaces": [{"id": "t", "name": "팀", "canCreateTop": True}, {"id": "u", "name": "옛"}]})
        self.assertEqual(ms.teamspaces("at", "ws"), [{"id": "t", "name": "팀", "can_create_top": True}, {"id": "u", "name": "옛", "can_create_top": False}])

    def test_새_페이지는_빈_본문_새_데이터베이스는_databases(self):
        Wiki.answers[("POST", "/api/connector/pages")] = (201, {"pageId": "np"})
        Wiki.answers[("POST", "/api/connector/databases")] = (201, {"databaseId": "nd"})
        self.assertEqual(ms.create_location("at", "ws", make="page", parent="t", parent_kind="teamspace", title="새", key="k")["id"], "np")
        self.assertEqual(json.loads(Wiki.seen[-1]["body"]), {"parentId": "t", "title": "새", "parentKind": "teamspace", "markdown": ""})
        self.assertEqual(ms.create_location("at", "ws", make="database", parent="p", parent_kind="page", title="표", key="k2")["id"], "nd")
        self.assertEqual(Wiki.seen[-1]["path"], "/api/connector/databases")

    def test_kind_열은_옛_표에도_생기고_기억된다(self):
        ms.set_target("s2", "pod-k", "main", workspace="w", teamspace="t", parent_id="db", parent_title="DB", path="", kind="database")
        self.assertEqual(ms.target("s2", "pod-k", "main")["kind"], "database")
        ms.set_target("s2", "pod-k", "main", workspace="w", teamspace="t", parent_id="p", parent_title="P", path="")
        self.assertEqual(ms.target("s2", "pod-k", "main")["kind"], "page")
        ms.forget_targets("pod-k")


class Stage2RouteTest(RouteTest):
    """경로(스펙 2026-11-23-019 2단계): 판 가드·기억 위치 지우기·새로 만들기."""

    def test_판이_낮으면_데이터베이스_저장을_부르지_않고_need_upgrade_기억_위치는_남긴다(self):
        ms.set_target("sub-owner", "pod-r", "main", workspace="ws-1", teamspace="t", parent_id="db", parent_title="DB", path="", kind="database")
        with mock.patch.object(ms, "save_level", lambda: 1):
            r = self.answer(key=None, conversation="c", message="m")
        self.assertEqual((r.status_code, r.json()["reason"]), (409, "need_upgrade"))
        self.assertEqual(self.saved, [])
        self.assertIsNotNone(ms.target("sub-owner", "pod-r", "main"))

    def test_위치가_지워졌으면_기억_위치를_지운다_row_rejected_는_남긴다(self):
        ms.set_target("sub-owner", "pod-r", "main", workspace="ws-1", teamspace="t", parent_id="p9", parent_title="P", path="")
        with mock.patch.object(ms, "save_answer", side_effect=ms.SaveError("row_rejected", 422)):
            self.answer(key=None, conversation="c", message="m")
        self.assertIsNotNone(ms.target("sub-owner", "pod-r", "main"))
        with mock.patch.object(ms, "save_answer", side_effect=ms.SaveError("parent_not_found", 404)):
            r = self.answer(key=None, conversation="c", message="m")
        self.assertEqual(r.json()["reason"], "parent_not_found")
        self.assertIsNone(ms.target("sub-owner", "pod-r", "main"))

    def create(self, **kw):
        body = {"pod": "pod-r", "profile": "main", "make": "page", "parent_id": "p1", "parent_kind": "page", "title": "새", "nonce": "n1", **kw}
        return self.client.post("/api/mindwiki/save/create", json=body)

    def test_새로_만들기는_nonce_키_결과_모름은_한_번만_다시(self):
        calls = []

        def fake(token, ws, **kw):
            calls.append(kw)
            if len(calls) == 1:
                raise ms.SaveError("timeout", 504)
            return {"id": "np", "url": "u", "kind": kw["make"], "title": kw["title"], "replayed": False}
        with mock.patch.object(ms, "save_level", lambda: 2), mock.patch.object(ms, "create_location", fake):
            r = self.create()
        self.assertEqual(r.json()["id"], "np")
        self.assertEqual(len(calls), 2)
        self.assertEqual(calls[0]["key"], calls[1]["key"])
        self.assertEqual(calls[0]["key"], ms.save_key("make", "pod-r", "main", "page", "p1", "n1"))
        self.assertNotEqual(calls[0]["key"], ms.save_key("answer", "pod-r", "main", "page", "p1", "c", "m"))   # 답 저장 키와 겹치지 않는다

    def test_새_데이터베이스는_MindWiki_가_허락할_때만(self):
        with mock.patch.object(ms, "save_level", lambda: 2), mock.patch.object(ms, "cached_capabilities", lambda: {"make_database": False}):
            self.assertEqual(self.create(make="database").json()["reason"], "need_upgrade")


class SaveKeyTest(unittest.TestCase):
    """요청 키(스펙 2026-11-23-019 P8, 리뷰 Eng H2). 예전 파일 키는 경로를 넣고 200자에서 잘라 위치 id 가 빠졌다."""

    def test_긴_경로라도_위치가_다르면_키가_다르다(self):
        path = "/opt/data/" + "아주긴폴더이름/" * 40 + "report.md"
        a = ms.save_key("file", "pod", "main", "page", "parent-a", path, 10, "")
        b = ms.save_key("file", "pod", "main", "page", "parent-b", path, 10, "")
        self.assertNotEqual(a, b)
        self.assertLessEqual(max(len(a), len(b)), 200)

    def test_프로파일이_다르면_같은_경로라도_키가_다르다(self):
        self.assertNotEqual(ms.save_key("file", "pod", "main", "page", "p", "/out/r.md", 10, ""),
                            ms.save_key("file", "pod", "other", "page", "p", "/out/r.md", 10, ""))

    def test_같은_파일을_두_번_누르면_같은_키_고친_파일은_다른_키(self):
        one = ms.save_key("file", "pod", "main", "page", "p", "/out/r.md", 10, "Mon, 23 Nov 2026 10:00:00 GMT")
        self.assertEqual(one, ms.save_key("file", "pod", "main", "page", "p", "/out/r.md", 10, "Mon, 23 Nov 2026 10:00:00 GMT"))
        self.assertNotEqual(one, ms.save_key("file", "pod", "main", "page", "p", "/out/r.md", 12, "Mon, 23 Nov 2026 11:00:00 GMT"))


class ForgetTest(unittest.TestCase):
    """기억한 위치를 지우는 자리(스펙 2026-11-23-019 R2·1a). 예전에는 forget_targets 를 부르는 운영 코드가 없었다."""

    def test_프로파일을_지우거나_연결을_끊으면_기억한_위치가_지워진다(self):
        from aas.ops import mindwiki_connect
        for prof in ("del-me", "opt-me"):
            ms.set_target("s", "pod-f", prof, workspace="w", teamspace="t", parent_id="p", parent_title="P", path="")
        mindwiki_connect.forget("pod-f", "del-me")                 # 프로파일 지우기
        mindwiki_connect.forget("pod-f", "opt-me", opt_out=True)   # MindWiki MCP 서버 지우기(연결 끊기)
        self.assertIsNone(ms.target("s", "pod-f", "del-me"))
        self.assertIsNone(ms.target("s", "pod-f", "opt-me"))


class RecentOpsTest(unittest.TestCase):
    """최근 위치(스펙 2026-11-23-019 R2·R3): (사람, 작업공간, 프로파일, 워크스페이스)마다 다섯 줄, 넣기와 지우기는 한 트랜잭션."""

    def setUp(self):
        self.sub = "sub-" + os.urandom(3).hex()
        self.addCleanup(lambda: ms.forget_targets("pod-rc"))

    def add(self, parent, ws="ws-1", **kw):
        ms.add_recent(self.sub, "pod-rc", "main", workspace=ws, parent_id=parent, title=f"T{parent}", **kw)

    def ids(self, ws="ws-1"):
        return [r["parent_id"] for r in ms.recent(self.sub, "pod-rc", "main", ws)]

    def test_다섯_줄만_새것_먼저_다시_저장하면_맨_앞으로(self):
        for i in range(7):
            self.add(f"p{i}")
        self.assertEqual(self.ids(), ["p6", "p5", "p4", "p3", "p2"])
        self.add("p3", kind="database", path="팀 › 위")
        self.assertEqual(self.ids(), ["p3", "p6", "p5", "p4", "p2"])
        row = ms.recent(self.sub, "pod-rc", "main", "ws-1")[0]
        self.assertEqual({k: row[k] for k in ("parent_title", "path", "kind")}, {"parent_title": "Tp3", "path": "팀 › 위", "kind": "database"})
        with store.connect() as conn:
            n = conn.execute("SELECT COUNT(*) FROM mindwiki_save_recent WHERE sub=? AND pod='pod-rc'", (self.sub,)).fetchone()[0]
        self.assertEqual(n, 5)                                         # 표에도 다섯 줄만 남는다(보이는 것만 자르지 않는다)

    def test_워크스페이스마다_따로(self):
        for i in range(5):
            self.add(f"a{i}", ws="ws-a")
        self.add("b0", ws="ws-b")
        self.assertEqual(len(self.ids("ws-a")), 5)
        self.assertEqual(self.ids("ws-b"), ["b0"])
        self.assertEqual(self.ids(""), [])

    def test_동시에_저장해도_다섯_줄을_넘지_않는다(self):
        for i in range(4):
            self.add(f"old{i}")
        errors = []

        def one(i):
            try:
                self.add(f"new{i}")
            except Exception as e:  # noqa: BLE001
                errors.append(e)
        threads = [threading.Thread(target=one, args=(i,)) for i in range(6)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        self.assertEqual(errors, [])
        with store.connect() as conn:
            n = conn.execute("SELECT COUNT(*) FROM mindwiki_save_recent WHERE sub=? AND pod='pod-rc'", (self.sub,)).fetchone()[0]
        self.assertEqual(n, 5)

    def test_forget_targets_와_연결_끊기가_최근_줄도_지운다(self):
        from aas.ops import mindwiki_connect
        self.add("p1")
        ms.add_recent(self.sub, "pod-rc", "other", workspace="ws-1", parent_id="p2")
        ms.forget_targets("pod-rc", "main")
        self.assertEqual(self.ids(), [])
        self.assertEqual(len(ms.recent(self.sub, "pod-rc", "other", "ws-1")), 1)   # 다른 프로파일은 남는다
        mindwiki_connect.forget("pod-rc", "other", opt_out=True)
        self.assertEqual(ms.recent(self.sub, "pod-rc", "other", "ws-1"), [])


class RecentRouteTest(RouteTest):
    """경로(스펙 2026-11-23-019 3단계): 저장 성공마다 최근 줄, 실패는 넣지 않음, R3 지우기, state 의 recent."""

    def state(self):
        return self.client.get("/api/mindwiki/save/state", params={"pod": "pod-r", "profile": "main"}).json()

    def save(self, parent, **kw):
        return self.answer(key=None, conversation="c", message=f"m-{parent}", parent_id=parent, **kw)

    def test_성공한_저장은_최근에_넣고_기억을_꺼도_넣는다(self):
        r = self.save("p1", parent_title="메모", parent_path="팀 › 위", teamspace="t1", kind="page")
        self.assertEqual(r.status_code, 200)
        self.assertIsNone(ms.target("sub-owner", "pod-r", "main"))       # 「이 위치 기억」 끔 — 기억 위치는 없다
        rec = self.state()["recent"]
        self.assertEqual(len(rec), 1)
        self.assertEqual({k: rec[0][k] for k in ("teamspace", "parent_id", "parent_title", "path", "kind")},
                         {"teamspace": "t1", "parent_id": "p1", "parent_title": "메모", "path": "팀 › 위", "kind": "page"})
        self.assertTrue(rec[0]["saved_at"])

    def test_제목이_없는_옛_화면은_기억한_위치의_값_아니면_id_만(self):
        ms.set_target("sub-owner", "pod-r", "main", workspace="ws-1", teamspace="t", parent_id="p9", parent_title="기억", path="팀")
        self.answer(key=None, conversation="c", message="m1")              # 기억한 위치로(본문에 parent_id 없음)
        self.save("p9")                                                    # 같은 부모 — 기억한 값
        self.save("p7")                                                    # 다른 부모 — id 만
        rec = {r["parent_id"]: r for r in self.state()["recent"]}
        self.assertEqual((rec["p9"]["parent_title"], rec["p9"]["path"], rec["p9"]["teamspace"]), ("기억", "팀", "t"))
        self.assertEqual((rec["p7"]["parent_title"], rec["p7"]["path"]), ("", ""))

    def test_실패한_저장은_넣지_않는다(self):
        for reason, status in (("row_rejected", 422), ("timeout", 504), ("mindwiki_5xx", 502)):
            with mock.patch.object(ms, "save_answer", side_effect=ms.SaveError(reason, status)):
                self.save("p1")
        with mock.patch.object(ms, "save_level", lambda: 1):
            self.assertEqual(self.save("db", kind="database").json()["reason"], "need_upgrade")
        self.assertEqual(self.state()["recent"], [])

    def test_위치가_지워지면_최근_줄을_지우고_row_rejected_need_upgrade_는_남긴다(self):
        self.save("p1")
        with mock.patch.object(ms, "save_level", lambda: 2):
            self.save("db", kind="database")
        with mock.patch.object(ms, "save_answer", side_effect=ms.SaveError("row_rejected", 422)), mock.patch.object(ms, "save_level", lambda: 2):
            self.save("db", kind="database")
        with mock.patch.object(ms, "save_level", lambda: 1):
            self.save("db", kind="database")                                # need_upgrade
        self.assertEqual({r["parent_id"] for r in self.state()["recent"]}, {"p1", "db"})
        with mock.patch.object(ms, "save_answer", side_effect=ms.SaveError("forbidden_parent", 403)), mock.patch.object(ms, "save_level", lambda: 2):
            self.save("db", kind="database")
        with mock.patch.object(ms, "save_answer", side_effect=ms.SaveError("parent_not_found", 404)):
            self.save("p1")
        self.assertEqual(self.state()["recent"], [])

    def test_state_는_지금_워크스페이스만_새것_먼저(self):
        ms.add_recent("sub-owner", "pod-r", "main", workspace="ws-other", parent_id="x1")
        for p in ("p1", "p2", "p3"):
            self.save(p)
        self.assertEqual([r["parent_id"] for r in self.state()["recent"]], ["p3", "p2", "p1"])
        with mock.patch.object(ms, "connected_workspace", lambda *a: "ws-other"):
            self.assertEqual([r["parent_id"] for r in self.state()["recent"]], ["x1"])

    def test_파일_저장도_최근에_넣는다(self):
        class Resp:
            def getheader(self, name):
                return {"X-File-Name": "r.md", "Content-Length": "3", "Last-Modified": "Mon, 23 Nov 2026 10:00:00 GMT"}.get(name)
        wsx = SimpleNamespace(supported=lambda: True, backend=SimpleNamespace(open_download=lambda path: (200, "", Resp(), SimpleNamespace(close=lambda: None))))
        out = {"page_id": "f", "attachment_id": "a", "name": "r.md", "url": "u", "replayed": False, "attach_failed": False}
        with mock.patch.object(server, "workspace_for", lambda pod: wsx), mock.patch.object(ms, "save_file", lambda *a, **kw: out):
            r = self.client.post("/api/mindwiki/save/file", json={"pod": "pod-r", "profile": "main", "path": "workspace/out/r.md", "parent_id": "pf",
                                                                  "parent_title": "파일 둘 곳", "parent_path": "팀", "kind": "page"})
        self.assertEqual(r.status_code, 200)
        self.assertEqual([(x["parent_id"], x["parent_title"], x["path"]) for x in self.state()["recent"]], [("pf", "파일 둘 곳", "팀")])   # path 는 파일 경로, 위치 경로는 parent_path


class PublicUrlTest(unittest.TestCase):
    """브라우저용 MindWiki 주소(스펙 2026-11-23-019 G4·G5)와 시작 로그 경고(4-7)."""

    def url(self, **env):
        from aas.ops import mcp_servers
        with mock.patch.dict(os.environ, {"AAS_MINDWIKI_URL": "", "AAS_MINDWIKI_PUBLIC_URL": "", **env}):
            return mcp_servers.mindwiki_public_url(), mcp_servers.mindwiki_url_warning()

    def test_서버용_주소가_없으면_빈_값(self):
        self.assertEqual(self.url(AAS_MINDWIKI_PUBLIC_URL="https://wiki.example.com")[0], "")

    def test_브라우저용_값이_있으면_그_값_없으면_서버용(self):
        self.assertEqual(self.url(AAS_MINDWIKI_URL="https://wiki.example.com")[0], "https://wiki.example.com")
        self.assertEqual(self.url(AAS_MINDWIKI_URL="http://mindwiki-api.ns.svc:8080", AAS_MINDWIKI_PUBLIC_URL="https://wiki.example.com/")[0],
                         "https://wiki.example.com")

    def test_시작_경고(self):
        self.assertIn("AAS_MINDWIKI_PUBLIC_URL", self.url(AAS_MINDWIKI_URL="http://mindwiki-api.ns.svc:8080")[1])     # 클러스터 안 주소
        self.assertIn("http(s)://", self.url(AAS_MINDWIKI_URL="https://wiki.example.com", AAS_MINDWIKI_PUBLIC_URL="wiki.example.com")[1])
        self.assertEqual(self.url(AAS_MINDWIKI_URL="https://wiki.example.com")[1], "")


if __name__ == "__main__":
    unittest.main()

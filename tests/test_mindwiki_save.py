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
        self.assertEqual(out, {"page_id": "p-new", "url": "https://wiki/p/p-new", "replayed": False})
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
        self.assertEqual((token, ws, kw["parent"], kw["key"]), ("at-1", "ws-1", "p9", "c:m:p"))
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


if __name__ == "__main__":
    unittest.main()

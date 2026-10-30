# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""SkillHub 첫 설정 모듈(aas/ops/skillhub_bootstrap.py) — 스펙 2026-10-29-001 R11·R13·F7(OMAI-1534).

옛 deploy/k8s/skillhub/bootstrap.py 를 서버 이미지 안으로 옮기고, 기본 스킬 게시 전용 계정 aas_admin 과 그 토큰을 더했다(계정 이름은 영문·숫자·밑줄만 된다 — §9-6a).
SkillHub v0.2.22 동작(소스 확인): 관리자 계정을 만드는 API 는 없고 회원가입(/api/v1/auth/local/register)으로 만든다.
SUPER_ADMIN 만 검토 없이 바로 게시된다(SkillPublishService autoPublish) — 그래서 aas_admin 에 SUPER_ADMIN 을 준다.
가짜 SkillHub(HTTP 서버)로 그 순서와 쿠키·XSRF 머리를 확인한다.
"""
import json
import os
import re
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from aas.ops import skillhub_bootstrap as boot


class FakeHub:
    def __init__(self, users=None, namespaces=()):
        self.users = dict(users or {"admin": {"id": "usr_admin", "pw": "admin-pw", "roles": ["SUPER_ADMIN"]}})
        self.namespaces = set(namespaces)
        self.sessions: dict[str, str] = {}
        self.log: list[tuple] = []
        hub = self

        class H(BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def _who(self):
                for part in (self.headers.get("Cookie") or "").split(";"):
                    k, _, v = part.strip().partition("=")
                    if k == "SESSION":
                        return hub.sessions.get(v)
                return None

            def _send(self, code, data=None, msg="", cookies=()):
                body = json.dumps({"code": 0 if code == 200 else 1, "msg": msg, "data": data}).encode()
                self.send_response(code)
                for c in cookies:
                    self.send_header("Set-Cookie", c)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(body)

            def _body(self):
                n = int(self.headers.get("Content-Length") or 0)
                return json.loads(self.rfile.read(n) or b"{}")

            def do_GET(self):
                who = self._who()
                hub.log.append(("GET", self.path, who))
                if self.path == "/api/v1/auth/methods":
                    return self._send(200, [], cookies=["XSRF-TOKEN=x1; Path=/"])
                if self.path.startswith("/api/v1/admin/users"):
                    if who != "admin":
                        return self._send(403)
                    q = self.path.partition("search=")[2].split("&")[0]
                    items = [{"id": u["id"], "username": n, "platformRoles": u["roles"]} for n, u in hub.users.items() if q in n]
                    return self._send(200, {"items": items, "total": len(items)})
                self._send(404)

            def do_POST(self):
                who, body = self._who(), self._body()
                hub.log.append(("POST", self.path, who, self.headers.get("X-XSRF-TOKEN")))
                if self.path.startswith("/api/v1/auth/local/") and self.headers.get("X-XSRF-TOKEN") != "x1":
                    return self._send(401, msg="Session expired")    # 진짜 v0.2.22 도 XSRF 없는 로그인·회원가입을 이렇게 거절한다
                if self.path == "/api/v1/auth/local/login":
                    u = hub.users.get(body["username"])
                    if not u or u["pw"] != body["password"]:
                        return self._send(401, msg="bad credentials")
                    sid = f"s{len(hub.sessions)}"
                    hub.sessions[sid] = body["username"]
                    return self._send(200, {"platformRoles": u["roles"]}, cookies=[f"SESSION={sid}; Path=/; Secure"])
                if self.path == "/api/v1/auth/local/register":
                    if not re.fullmatch(r"[A-Za-z0-9_]{3,64}", body["username"]):   # 진짜 v0.2.22: 하이픈 안 됨
                        return self._send(400, msg="Username must be 3-64 characters and contain only letters, numbers, or underscores")
                    if body["username"] in hub.users:
                        return self._send(409, msg="error.auth.local.username.exists")
                    hub.users[body["username"]] = {"id": "usr_" + body["username"], "pw": body["password"], "roles": [],
                                                   "email": body["email"]}
                    return self._send(200, {"userId": "usr_" + body["username"]})
                if self.path == "/api/v1/namespaces":
                    if who != "admin":
                        return self._send(403)
                    if body["slug"] in hub.namespaces:
                        return self._send(400, msg="Namespace already exists")
                    hub.namespaces.add(body["slug"])
                    return self._send(200, {"slug": body["slug"]})
                if self.path == "/api/v1/tokens":
                    if not who:
                        return self._send(401)
                    return self._send(200, {"token": f"sk_{who}_{body['name']}"})
                self._send(404)

            def do_PUT(self):
                who, body = self._who(), self._body()
                hub.log.append(("PUT", self.path, who, body))
                if self.path.startswith("/api/v1/admin/users/") and self.path.endswith("/role"):
                    if who != "admin":
                        return self._send(403)
                    uid = self.path.split("/")[5]
                    for u in hub.users.values():
                        if u["id"] == uid:
                            u["roles"] = [body["role"]]
                            return self._send(200, {"id": uid})
                    return self._send(404)
                self._send(404)

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), H)
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}"
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def close(self):
        self.server.shutdown()
        self.server.server_close()


class BootstrapTest(unittest.TestCase):
    def setUp(self):
        self.dir = Path(tempfile.mkdtemp())
        self.addCleanup(lambda: [p.unlink() for p in self.dir.iterdir()] and None)

    def _hub(self, **kw):
        hub = FakeHub(**kw)
        self.addCleanup(hub.close)
        return hub

    def test_namespaces_are_made_once(self):
        hub = self._hub(namespaces={"paid"})
        boot.run(hub.url, "admin-pw")
        self.assertEqual(hub.namespaces, {"free", "paid", "community"})
        boot.run(hub.url, "admin-pw")                              # 두 번 돌려도 안전하다
        self.assertEqual(hub.namespaces, {"free", "paid", "community"})

    def test_server_token_only_when_asked(self):
        hub = self._hub()
        out = self.dir / "tok"
        boot.run(hub.url, "admin-pw", token_out=str(out))
        self.assertEqual(out.read_text(encoding="utf-8"), "sk_admin_aas-server")
        boot.run(hub.url, "admin-pw")
        self.assertFalse(any(e[1] == "/api/v1/tokens" and e[2] == "admin" for e in hub.log[-3:]))

    def test_publish_account_is_registered_made_super_admin_and_gets_a_token(self):
        hub = self._hub()
        pw_out, tok_out = self.dir / "pw", self.dir / "ptok"
        boot.run(hub.url, "admin-pw", publish_token_out=str(tok_out), publish_password_out=str(pw_out))
        user = hub.users[boot.PUBLISH_USER]
        self.assertEqual(user["roles"], ["SUPER_ADMIN"])                # SUPER_ADMIN 이어야 검토 없이 게시된다
        self.assertEqual(user["pw"], pw_out.read_text(encoding="utf-8"))
        self.assertGreaterEqual(len(user["pw"]), 24)
        self.assertEqual(tok_out.read_text(encoding="utf-8"), f"sk_{boot.PUBLISH_USER}_{boot.PUBLISH_TOKEN_NAME}")
        posts = [e for e in hub.log if e[0] == "POST" and e[1] == "/api/v1/auth/local/login"]
        self.assertTrue(all(e[3] == "x1" for e in posts))           # 로그인마다 XSRF 머리를 싣는다

    def test_existing_publish_account_uses_the_given_password(self):
        hub = self._hub(users={"admin": {"id": "usr_admin", "pw": "admin-pw", "roles": ["SUPER_ADMIN"]},
                               boot.PUBLISH_USER: {"id": "usr_p", "pw": "kept-pw-0123456789abcdef", "roles": []}})
        tok_out = self.dir / "ptok"
        boot.run(hub.url, "admin-pw", publish_token_out=str(tok_out), publish_password="kept-pw-0123456789abcdef")
        self.assertEqual(hub.users[boot.PUBLISH_USER]["roles"], ["SUPER_ADMIN"])
        self.assertTrue(tok_out.read_text(encoding="utf-8").startswith(f"sk_{boot.PUBLISH_USER}_"))
        self.assertFalse(any(e[1] == "/api/v1/auth/local/register" for e in hub.log))

    def test_existing_publish_account_without_password_stops(self):
        hub = self._hub(users={"admin": {"id": "usr_admin", "pw": "admin-pw", "roles": ["SUPER_ADMIN"]},
                               boot.PUBLISH_USER: {"id": "usr_p", "pw": "unknown", "roles": []}})
        with self.assertRaises(boot.BootstrapError) as ctx:
            boot.run(hub.url, "admin-pw", publish_token_out=str(self.dir / "ptok"))
        self.assertIn(boot.PUBLISH_USER, str(ctx.exception))

    def test_wrong_admin_password_stops(self):
        hub = self._hub()
        with self.assertRaises(boot.BootstrapError):
            boot.run(hub.url, "nope")

    def test_main_reads_environment_and_does_not_print_secrets(self):
        hub = self._hub()
        import contextlib
        import io
        tok, ptok, ppw = self.dir / "t", self.dir / "pt", self.dir / "pp"
        env = {"HUB": hub.url, "ADMIN_PW": "admin-pw", "MAKE_TOKEN": "1", "TOKEN_OUT": str(tok),
               "MAKE_PUBLISH_TOKEN": "1", "PUBLISH_TOKEN_OUT": str(ptok), "PUBLISH_PW_OUT": str(ppw)}
        buf = io.StringIO()
        from unittest import mock
        with mock.patch.dict(os.environ, env), contextlib.redirect_stdout(buf):
            self.assertEqual(boot.main(), 0)
        printed = buf.getvalue()
        for secret in (tok.read_text(), ptok.read_text(), ppw.read_text(), "admin-pw"):
            self.assertNotIn(secret, printed)


if __name__ == "__main__":
    unittest.main()

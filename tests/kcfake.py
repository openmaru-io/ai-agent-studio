# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""시험용 가짜 Keycloak 관리 API(realm aas). 표준 라이브러리 http.server 를 스레드로 띄운다.

사용자·그룹·역할 상태를 메모리에 두고, 받은 요청(메서드·경로·본문)을 seen 에 남긴다(스펙 2026-10-14-011 §7).
실제 Keycloak 26 처럼 PUT /users/{id} 는 받은 표현으로 통째로 바꾼다 — 일부만 보내면 attributes 가 사라진다(O7).
"""
from __future__ import annotations

import itertools
import json
import re
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, unquote, urlsplit

SECRET = "kc-secret"
ADMIN_ROLE = {"id": "r-admin", "name": "aas-admin"}


class FakeKC(BaseHTTPRequestHandler):
    users: dict = {}
    groups: dict = {}
    members: dict = {}            # 그룹 id → {사용자 id}
    role_users: set = set()       # 역할 aas-admin 을 직접 받은 사용자 id
    role_groups: list = []        # 역할 aas-admin 이 붙은 그룹 id
    passwords: dict = {}          # 사용자 id → (값, 임시인가)
    seen: list = []
    fail: dict = {}               # (메서드, 경로 정규식) → HTTP 상태. 맞는 요청을 그 상태로 거절한다
    deny_writes = False           # 참이면 GET 이 아닌 관리 요청을 403 으로(manage-users 없음)
    _ids = itertools.count(1)

    @classmethod
    def reset(cls):
        cls.users, cls.passwords, cls.seen, cls.fail, cls.deny_writes = {}, {}, [], {}, False
        cls.groups = {"g-users": {"id": "g-users", "name": "aas-users", "path": "/aas-users"},
                      "g-admins": {"id": "g-admins", "name": "aas-admins", "path": "/aas-admins"}}
        cls.members = {"g-users": set(), "g-admins": set()}
        cls.role_users, cls.role_groups = set(), ["g-admins"]

    @classmethod
    def add(cls, uid: str, username: str, email: str, groups=(), enabled=True, direct_admin=False, **extra) -> dict:
        cls.users[uid] = {"id": uid, "username": username, "email": email, "firstName": extra.pop("firstName", "길동"),
                          "lastName": extra.pop("lastName", "홍"), "enabled": enabled, "emailVerified": True,
                          "attributes": extra.pop("attributes", {}), **extra}
        for g in groups:
            cls.members[g].add(uid)
        if direct_admin:
            cls.role_users.add(uid)
        return cls.users[uid]

    @classmethod
    def calls(cls, method: str, pattern: str) -> list:
        return [s for s in cls.seen if s[0] == method and re.fullmatch(pattern, s[1])]

    def log_message(self, *a):
        pass

    def _send(self, code: int, obj=None, headers=None):
        body = b"" if obj is None else json.dumps(obj).encode()
        self.send_response(code)
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    @staticmethod
    def _brief(u: dict) -> dict:
        return {k: u[k] for k in ("id", "username", "email", "enabled") if k in u}

    @staticmethod
    def _page(rows: list, q: dict) -> list:
        first, size = int(q.get("first", ["0"])[0]), int(q.get("max", ["100"])[0])
        return rows[first:first + size]

    def _route(self, method: str):
        url = urlsplit(self.path)
        path, q = unquote(url.path), parse_qs(url.query)
        n = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(n) if n else b""
        if path.endswith("/protocol/openid-connect/token"):
            form = parse_qs(raw.decode())
            FakeKC.seen.append((method, path, None))
            if form.get("client_secret", [""])[0] != SECRET:
                return self._send(401, {"error": "unauthorized_client"})
            return self._send(200, {"access_token": "t"})
        body = json.loads(raw) if raw else None
        FakeKC.seen.append((method, path, body))
        for (m, pattern), code in FakeKC.fail.items():
            if m == method and re.fullmatch(pattern, path):
                return self._send(code, {"errorMessage": "fail"})
        prefix = "/admin/realms/aas"
        if not path.startswith(prefix):
            return self._send(404, {"error": "no route"})
        if FakeKC.deny_writes and method != "GET":
            return self._send(403, {"error": "unknown_error"})
        p = path[len(prefix):]
        U, G = FakeKC.users, FakeKC.groups
        if p == "/users" and method == "GET":
            rows = sorted(U.values(), key=lambda u: u["username"])
            if "email" in q:
                rows = [u for u in rows if str(u.get("email") or "").lower() == q["email"][0].lower()]
            return self._send(200, self._page(rows, q))
        if p == "/users" and method == "POST":
            for key in ("username", "email"):
                if any(str(u.get(key) or "").lower() == str(body.get(key) or "").lower() for u in U.values()):
                    return self._send(409, {"errorMessage": f"User exists with same {key}"})
            uid = f"kc-{next(FakeKC._ids)}"
            rep = {k: v for k, v in body.items() if k not in ("credentials", "groups")}
            U[uid] = {**rep, "id": uid}
            for c in body.get("credentials") or []:
                FakeKC.passwords[uid] = (c["value"], c.get("temporary"))
            for gp in body.get("groups") or []:
                gid = next(g["id"] for g in G.values() if g["path"] == gp)
                FakeKC.members[gid].add(uid)
            return self._send(201, None, {"Location": f"http://kc{prefix}/users/{uid}"})
        m = re.fullmatch(r"/users/([^/]+)(/.*)?", p)
        if m:
            uid, rest = m.group(1), m.group(2) or ""
            if uid not in U:
                return self._send(404, {"error": "User not found"})
            if rest == "" and method == "GET":
                return self._send(200, U[uid])
            if rest == "" and method == "PUT":
                U[uid] = {**body, "id": uid}                       # 통째로 바꾼다(실제 Keycloak 26 처럼 빠진 attributes 는 사라진다)
                return self._send(204)
            if rest == "" and method == "DELETE":
                del U[uid]
                for s in FakeKC.members.values():
                    s.discard(uid)
                FakeKC.role_users.discard(uid)
                return self._send(204)
            if rest == "/groups" and method == "GET":
                return self._send(200, [G[g] for g, s in FakeKC.members.items() if uid in s])
            mg = re.fullmatch(r"/groups/([^/]+)", rest)
            if mg and method in ("PUT", "DELETE"):
                (FakeKC.members[mg.group(1)].add if method == "PUT" else FakeKC.members[mg.group(1)].discard)(uid)
                return self._send(204)
            if rest == "/role-mappings/realm" and method == "GET":
                return self._send(200, [ADMIN_ROLE] if uid in FakeKC.role_users else [])
            if rest == "/role-mappings/realm" and method == "DELETE":
                if any(r.get("name") == "aas-admin" for r in body or []):
                    FakeKC.role_users.discard(uid)
                return self._send(204)
            if rest == "/reset-password" and method == "PUT":
                FakeKC.passwords[uid] = (body["value"], body.get("temporary"))
                return self._send(204)
            if rest == "/logout" and method == "POST":
                return self._send(204)
        if p == "/groups" and method == "GET":
            name = q.get("search", [""])[0]
            return self._send(200, [g for g in G.values() if name in g["name"]])
        m = re.fullmatch(r"/groups/([^/]+)/members", p)
        if m and method == "GET":
            rows = sorted((self._brief(U[i]) for i in FakeKC.members.get(m.group(1), set()) if i in U), key=lambda u: u["username"])
            return self._send(200, self._page(rows, q))
        if p == "/roles/aas-admin/users" and method == "GET":
            return self._send(200, self._page([self._brief(U[i]) for i in sorted(FakeKC.role_users) if i in U], q))
        if p == "/roles/aas-admin/groups" and method == "GET":
            return self._send(200, self._page([G[g] for g in FakeKC.role_groups], q))
        return self._send(404, {"error": "no route " + p})

    do_GET = lambda self: self._route("GET")        # noqa: E731
    do_POST = lambda self: self._route("POST")      # noqa: E731
    do_PUT = lambda self: self._route("PUT")        # noqa: E731
    do_DELETE = lambda self: self._route("DELETE")  # noqa: E731


def start() -> tuple[ThreadingHTTPServer, str]:
    """(서버, 발급자 주소). 끝나면 서버.shutdown()."""
    FakeKC.reset()
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), FakeKC)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd, f"http://127.0.0.1:{httpd.server_port}/realms/aas"


def admin(issuer: str, secret: str = SECRET):
    from aas.auth import keycloak
    return keycloak.KeycloakAdmin(issuer, "aas-admin", secret, "aas-users", "aas-admin")

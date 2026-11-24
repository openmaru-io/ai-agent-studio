# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""보호 스킬 설치 규칙 화면 API 의 문(cogentai-aas-docs 스펙 2026-11-24-001 4-3) — 실제 서버로.

쓰기 POST 셋은 사람의 화면 세션만: MCP 도구(via=token)와 임베드 위젯(via=embed)은 같은 프로세스 안에서 principal 을 싣고
부르므로 _same_origin 을 지난다 — 그래서 principal 을 먼저 본다. 미리보기는 읽기 권한만. 쓰기 경로 넷은 POST 허용 목록에 있다.
규칙 내용(판 · 사본)은 test_protected_skill_rules 가 본다. 여기서는 어떤 보호 스킬도 켜지 않은 설치로 문만 본다.
"""
import aasserver  # 실제 uvicorn 앱을 띄우는 시험 하네스(OMAI-1100)
import http.client
import json
import os
import tempfile
import unittest
from pathlib import Path

TMP = tempfile.TemporaryDirectory()
os.environ.setdefault("AAS_DATA_DIR", str(Path(TMP.name) / "data"))

OWNER = "rules-owner@corp.example"
PASSWORD = "correct horse battery"
RULES = "/api/protected-skills/rules"


class RulesHttpTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        from aas.auth import auth
        from aas.fleet import pods
        from aas.web import server
        root = Path(TMP.name)
        cls.users = root / "rules-users.json"
        auth.save_user(OWNER, PASSWORD, cls.users)
        (root / "rules_home" / "profiles" / "p1").mkdir(parents=True, exist_ok=True)
        reg = root / "rules-pods.json"
        reg.write_text(json.dumps({"admins": [], "pods": [{"id": "rules-a", "owner": OWNER, "hermes_home": str(root / "rules_home")}]}))
        cls.app = aasserver.start()
        cls.port = cls.app.server_port
        cls.saved = (server._auth, server._registry)
        server._auth = auth.Auth({"issuer": "", "client_id": "", "client_secret": "", "domain": "",
                                  "public_url": f"http://127.0.0.1:{cls.port}", "hours": 1, "users_file": cls.users})
        server._registry = pods.Registry(reg)
        cls.server = server

    @classmethod
    def tearDownClass(cls):
        cls.app.shutdown()
        cls.server._auth, cls.server._registry = cls.saved

    def req(self, method, path, cookie="", body=None, headers=None):
        c = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        h = {"Cookie": cookie} if cookie else {}
        h.update(headers or {})
        c.request(method, path, body=json.dumps(body) if body is not None else None, headers=h)
        r = c.getresponse()
        data = r.read()
        return r.status, (json.loads(data) if data[:1] in (b"{", b"[") else data)

    def login(self):
        c = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        c.request("POST", "/auth/password", body=f"email={OWNER}&password=correct+horse+battery&next=/",
                  headers={"Content-Type": "application/x-www-form-urlencoded"})
        r = c.getresponse(); r.read()
        return r.getheader("Set-Cookie").split(";")[0]

    def dispatch(self, path, body, via="token"):
        from aas.web import legacy
        user = {"email": OWNER, "name": "N", "sub": "sub-" + OWNER, "admin": False, "via": via}
        status, _, out = legacy.dispatch("POST", path, {"user": user, "pod": "rules-a"}, [(b"host", f"127.0.0.1:{self.port}".encode())],
                                         ("127.0.0.1", 50000), False, json.dumps(body).encode())
        return status, json.loads(out)

    BODY = {"pod": "rules-a", "profile": "p1", "skill": "protected-fixture", "text": "- 규칙", "base_rev": 0, "rev": 1}

    def test_mcp_and_embed_cannot_write(self):
        for via in ("token", "embed"):
            for suffix in ("", "/restore", "/ack"):
                with self.subTest(via=via, path=suffix):
                    status, out = self.dispatch(RULES + suffix, self.BODY, via)
                    self.assertEqual((status, out.get("reason")), (403, "human_only"))

    def test_preview_through_mcp_is_a_read(self):
        status, out = self.dispatch(RULES + "/preview", self.BODY)
        self.assertEqual((status, out.get("reason")), (404, "not_found"))      # 문을 지나 대상 검사까지 갔다(켠 보호 스킬이 없다)

    def test_the_screen_session_reaches_the_rules_code(self):
        cookie = self.login()
        for suffix in ("", "/restore", "/preview", "/ack"):
            with self.subTest(path=suffix):
                status, out = self.req("POST", RULES + suffix, cookie, self.BODY, {"X-AAS": "1"})
                self.assertEqual((status, out.get("reason")), (404, "not_found"))
        status, out = self.req("GET", f"{RULES}?pod=rules-a&profile=p1&skill=protected-fixture", cookie)
        self.assertEqual((status, out.get("reason")), (404, "not_found"))

    def test_gates_before_the_rules_code(self):
        cookie = self.login()
        status, _ = self.req("POST", RULES, cookie, self.BODY)                                       # X-AAS 없음
        self.assertEqual(status, 403)
        status, _ = self.req("POST", RULES + "/other", cookie, self.BODY, {"X-AAS": "1"})          # 허용 목록 밖
        self.assertEqual(status, 404)
        status, out = self.req("POST", RULES, cookie, {**self.BODY, "pod": "other"}, {"X-AAS": "1"})
        self.assertEqual((status, out.get("reason")), (400, "invalid"))
        status, _ = self.req("POST", RULES, "", self.BODY, {"X-AAS": "1"})                           # 로그인 없음
        self.assertEqual(status, 401)


if __name__ == "__main__":
    unittest.main()

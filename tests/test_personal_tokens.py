# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""Claude Code 연결 — 개인 접근 토큰 표·발급·폐기(스펙 2026-10-28-001 T1, OMAI-1513).

토큰 모듈은 직접, /api/tokens 는 실제 서버를 띄워 비밀번호 로그인으로 본다. 시험이 넣은 줄은 끝에서 지운다(데이터 폴더를 함께 쓴다).
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

EMAILS = ("pat-alice@corp.example", "pat-bob@corp.example", "pat-web@corp.example")


def _clean():
    from aas.auth import tokens
    with tokens._conn() as conn:
        for e in EMAILS:
            conn.execute("DELETE FROM personal_tokens WHERE user_email=?", (e,))
            conn.execute("DELETE FROM token_notice_acks WHERE email=?", (e,))


class TokenModuleTest(unittest.TestCase):
    def setUp(self):
        _clean()

    tearDown = setUp

    def user(self, email=EMAILS[0]):
        return {"email": email, "name": "A", "sub": "sub-" + email, "admin": False}

    def test_원문은_한_번만_돌려주고_DB_에는_해시만_둔다(self):
        from aas.auth import tokens
        view, raw = tokens.issue(self.user(), "  내   노트북 ", "skill-dev", 30, now=1000.0)
        self.assertTrue(raw.startswith("aas_pat_")); self.assertGreater(len(raw), 40)
        self.assertEqual((view["name"], view["kind"], view["state"], view["expires"]), ("내 노트북", "pat", "active", 1000.0 + 30 * 86400))
        self.assertEqual(view["prefix"], raw[8:16])
        self.assertNotIn("secret", view); self.assertNotIn("token_hash", view)
        with tokens._conn() as conn:
            row = dict(conn.execute("SELECT * FROM personal_tokens WHERE id=?", (view["id"],)).fetchone())
        self.assertNotIn(raw, json.dumps(row))                              # 원문은 어느 열에도 없다
        self.assertEqual(row["scopes"].split(), list(tokens.BUNDLES["skill-dev"]))
        self.assertEqual(tokens.lookup(raw, now=1001.0)["id"], view["id"])
        self.assertIsNone(tokens.lookup(raw + "x", now=1001.0))
        self.assertEqual(tokens.lookup_state("", now=1001.0), ("unknown", None))

    def test_만료와_폐기는_살아_있지_않고_이유를_구분한다(self):
        from aas.auth import tokens
        v, raw = tokens.issue(self.user(), "n", "read", 7, now=1000.0)
        self.assertEqual(tokens.lookup_state(raw, now=1000.0 + 7 * 86400 + 1)[0], "expired")
        self.assertTrue(tokens.revoke(v["id"], EMAILS[0], now=1001.0))
        self.assertEqual(tokens.lookup_state(raw, now=1002.0)[0], "revoked")
        self.assertFalse(tokens.revoke(v["id"], EMAILS[0], now=1003.0))     # 이미 끊었다
        self.assertIsNone(tokens.lookup(raw, now=1002.0))

    def test_남의_연결은_끊지_못한다(self):
        from aas.auth import tokens
        v, raw = tokens.issue(self.user(), "n", "read", 30, now=1000.0)
        self.assertFalse(tokens.revoke(v["id"], EMAILS[1], now=1001.0))
        self.assertEqual(tokens.lookup_state(raw, now=1002.0)[0], "active")

    def test_입력_검사(self):
        from aas.auth import tokens
        for name, bundle, days, field in (("", "read", 30, "name"), ("x" * 61, "read", 30, "name"), ("n", "admin", 30, "bundle"),
                                          ("n", "read", 365, "days"), ("n", "read", 0, "days")):
            with self.subTest(field=field, days=days):
                with self.assertRaises(tokens.TokenError) as cm:
                    tokens.issue(self.user(), name, bundle, days, now=1000.0)
                self.assertEqual((cm.exception.code, cm.exception.reason), (400, field))
        with self.assertRaises(tokens.TokenError) as cm:
            tokens.issue({"email": ""}, "n", "read", 30)
        self.assertEqual(cm.exception.code, 401)

    def test_사람당_10개까지이고_끊으면_다시_만든다(self):
        from aas.auth import tokens
        made = [tokens.issue(self.user(), f"n{i}", "read", 30, now=1000.0)[0] for i in range(tokens.MAX_ACTIVE)]
        with self.assertRaises(tokens.TokenError) as cm:
            tokens.issue(self.user(), "over", "read", 30, now=1000.0)
        self.assertEqual((cm.exception.code, cm.exception.reason), (409, "limit"))
        tokens.issue(self.user(EMAILS[1]), "other", "read", 30, now=1000.0)  # 다른 사람은 따로 센다
        tokens.revoke(made[0]["id"], EMAILS[0], now=1001.0)
        tokens.issue(self.user(), "again", "read", 30, now=1002.0)
        self.assertEqual(tokens.active_count(EMAILS[0], now=1003.0), tokens.MAX_ACTIVE)
        self.assertEqual(tokens.active_count(EMAILS[0], now=1000.0 + 31 * 86400), 0)   # 만료된 것은 세지 않는다

    def test_마지막_사용은_60초에_한_번만_쓴다(self):
        from aas.auth import tokens
        v, _ = tokens.issue(self.user(), "n", "read", 30, now=1000.0)
        self.assertTrue(tokens.mark_used(v["id"], "10.0.0.1", now=2000.0))
        self.assertFalse(tokens.mark_used(v["id"], "10.0.0.2", now=2059.0))
        self.assertTrue(tokens.mark_used(v["id"], "10.0.0.3", now=2061.0))
        got = tokens.list_for(EMAILS[0], now=2062.0)[0]
        self.assertEqual((got["last_used"], got["last_ip"]), (2061.0, "10.0.0.3"))

    def test_목록은_살아_있는_것만_끝난_것은_30일_안만(self):
        from aas.auth import tokens
        a, _ = tokens.issue(self.user(), "a", "read", 30, now=1000.0)
        b, _ = tokens.issue(self.user(), "b", "read", 30, now=1001.0)
        tokens.revoke(a["id"], EMAILS[0], now=1002.0)
        self.assertEqual([t["id"] for t in tokens.list_for(EMAILS[0], now=1003.0)], [b["id"]])
        ended = tokens.list_for(EMAILS[0], include_ended=True, now=1003.0)
        self.assertEqual({t["id"]: t["state"] for t in ended}, {a["id"]: "revoked", b["id"]: "active"})
        later = tokens.list_for(EMAILS[0], include_ended=True, now=1002.0 + 31 * 86400)      # a 는 끊은 지 31일, b 는 만료된 지 하루
        self.assertEqual({t["id"]: t["state"] for t in later}, {b["id"]: "expired"})
        self.assertEqual(tokens.list_for(EMAILS[0], include_ended=True, now=1001.0 + 61 * 86400), [])

    def test_모두_끊기(self):
        from aas.auth import tokens
        raws = [tokens.issue(self.user(), f"n{i}", "read", 30, now=1000.0)[1] for i in range(3)]
        _, keep = tokens.issue(self.user(EMAILS[1]), "b", "read", 30, now=1000.0)
        self.assertEqual(tokens.revoke_all(EMAILS[0], now=1001.0), 3)
        self.assertTrue(all(tokens.lookup_state(r, now=1002.0)[0] == "revoked" for r in raws))
        self.assertEqual(tokens.lookup_state(keep, now=1002.0)[0], "active")

    def test_요약은_연결_수와_7일_안_만료_수동_토큰(self):
        from aas.auth import tokens
        tokens.issue(self.user(), "week", "read", 7, now=1000.0)
        tokens.issue(self.user(), "month", "read", 30, now=1000.0)
        self.assertEqual(tokens.summary(EMAILS[0], now=1000.0), {"active": 2, "expiring": 1})
        self.assertEqual(tokens.summary(EMAILS[0], now=1000.0 + 24 * 86400), {"active": 1, "expiring": 1})
        self.assertEqual(tokens.summary("nobody@corp.example", now=1000.0), {"active": 0, "expiring": 0})

    def test_받은편지함_만료_예정과_남이_끊음(self):
        from aas.auth import tokens
        week, _ = tokens.issue(self.user(), "week", "read", 7, now=1000.0)
        month, _ = tokens.issue(self.user(), "month", "read", 30, now=1000.0)
        mine, _ = tokens.issue(self.user(), "mine", "read", 30, now=1000.0)
        tokens.revoke(mine["id"], EMAILS[0], now=1001.0)                               # 내가 끊은 것은 알리지 않는다
        items = tokens.inbox_items(EMAILS[0], now=1002.0)
        self.assertEqual([(i["status"], i["name"]) for i in items], [("expiring", "week")])
        tokens.revoke(month["id"], EMAILS[0], by="boss@corp.example", reason="퇴사 정리", now=1003.0)
        items = tokens.inbox_items(EMAILS[0], now=1004.0)
        self.assertEqual(sorted((i["status"], i["name"]) for i in items), [("expiring", "week"), ("revoked", "month")])
        exp = next(i for i in items if i["status"] == "expiring")
        tokens.notice_ack(exp["id"], EMAILS[0], now=1005.0)
        self.assertEqual([i["status"] for i in tokens.inbox_items(EMAILS[0], now=1006.0)], ["revoked"])
        with self.assertRaises(ValueError):
            tokens.notice_ack(exp["id"], EMAILS[1])                                       # 남의 알림
        self.assertEqual(tokens.inbox_items(EMAILS[0], now=1003.0 + tokens.NOTICE_KEEP + 10), [])   # 14일 뒤(만료 지난 week 도 빠짐)

    def test_DB_이전_표_목록에_들어_있다(self):
        from aas.auth import tokens
        from aas.common import dbmigrate
        self.assertIn(tokens.SCHEMA, dbmigrate.schema_scripts())


class TokenApiTest(unittest.TestCase):
    """/api/tokens — 쿠키 로그인한 본인의 연결만."""

    @classmethod
    def setUpClass(cls):
        from aas.auth import auth
        from aas.fleet import pods
        from aas.web import server
        root = Path(TMP.name)
        cls.users = root / "pat-users.json"
        auth.save_user(EMAILS[2], "correct horse battery", cls.users)
        auth.save_user(EMAILS[1], "correct horse battery", cls.users)       # 관리자(사용자 관리 「Claude Code 연결」 탭)
        reg = root / "pat-pods.json"
        (root / "pat_home" / "profiles" / "main").mkdir(parents=True, exist_ok=True)   # 받은편지함은 에이전트가 있는 사람만 연다
        reg.write_text(json.dumps({"admins": [EMAILS[1]], "pods": [{"id": "pat-p", "owner": EMAILS[2], "hermes_home": str(root / "pat_home")}]}))
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
        _clean()

    def setUp(self):
        _clean()

    def req(self, method, path, cookie="", body=None, headers=None):
        c = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        h = {"Cookie": cookie} if cookie else {}
        if method == "POST":
            h["X-AAS"] = "1"
        h.update(headers or {})
        c.request(method, path, body=json.dumps(body) if body is not None else None, headers=h)
        r = c.getresponse()
        return r, json.loads(r.read() or b"{}")

    def login(self, email=EMAILS[2]):
        c = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        c.request("POST", "/auth/password", body=f"email={email}&password=correct+horse+battery&next=/",
                  headers={"Content-Type": "application/x-www-form-urlencoded"})
        r = c.getresponse(); r.read()
        self.assertEqual(r.status, 302)
        return r.getheader("Set-Cookie").split(";")[0]

    def test_관리자_탭_목록과_강제_끊기는_사유와_함께(self):
        from aas.auth import tokens
        view, _ = tokens.issue({"email": EMAILS[2]}, "web CI", "read", 30)
        me, admin = self.login(), self.login(EMAILS[1])
        self.assertEqual(self.req("GET", "/api/tokens/all", me)[0].status, 403)          # 관리자만
        r, got = self.req("GET", "/api/tokens/all", admin)
        self.assertEqual((r.status, [(t["email"], t["name"]) for t in got["tokens"]]), (200, [(EMAILS[2], "web CI")]))
        r, out = self.req("POST", "/api/tokens/admin-revoke", me, {"id": view["id"], "email": EMAILS[2], "reason": "퇴사"})
        self.assertEqual(r.status, 403)
        r, out = self.req("POST", "/api/tokens/admin-revoke", admin, {"id": view["id"], "email": EMAILS[2], "reason": " "})
        self.assertEqual((r.status, out.get("field")), (400, "reason"))
        r, out = self.req("POST", "/api/tokens/admin-revoke", admin, {"id": view["id"], "email": EMAILS[2], "reason": "쓰지 않는 CI"})
        self.assertEqual(r.status, 200)
        row = tokens.list_for(EMAILS[2], include_ended=True)[0]
        self.assertEqual((row["state"], row["revoked_by"], row["revoke_reason"]), ("revoked", EMAILS[1], "쓰지 않는 CI"))
        r, inbox = self.req("GET", "/api/office/inbox", me)                            # 주인의 받은편지함에 알림
        mine = [i for i in inbox["items"] if i["kind"] == "connection"]
        self.assertEqual([(i["status"], i["by"], i["reason"]) for i in mine], [("revoked", EMAILS[1], "쓰지 않는 CI")])
        r, _ = self.req("POST", "/api/office/inbox/answer", admin, {"id": mine[0]["id"]})
        self.assertNotEqual(r.status, 200)                                                # 남의 알림은 지우지 못한다
        r, _ = self.req("POST", "/api/office/inbox/answer", me, {"id": mine[0]["id"]})
        self.assertEqual(r.status, 200)
        r, inbox = self.req("GET", "/api/office/inbox", me)
        self.assertEqual([i for i in inbox["items"] if i["kind"] == "connection"], [])

    def test_로그인_없이는_401(self):
        r, _ = self.req("GET", "/api/tokens")
        self.assertEqual(r.status, 401)
        r, _ = self.req("POST", "/api/tokens/create", body={"name": "n", "bundle": "read", "days": 30})
        self.assertEqual(r.status, 401)

    def test_만들기_목록_끊기(self):
        cookie = self.login()
        r, got = self.req("GET", "/api/tokens", cookie)
        self.assertEqual(r.status, 200)
        self.assertEqual((got["tokens"], got["max"], got["expiry_days"]), ([], 10, [7, 30, 60, 90]))
        self.assertEqual(got["mcp_url"], f"http://127.0.0.1:{self.port}/mcp")
        self.assertEqual(set(got["bundles"]), {"all", "skill-dev", "read"})
        r, made = self.req("POST", "/api/tokens/create", cookie, {"name": "CI", "bundle": "skill-dev", "days": 60})
        self.assertEqual(r.status, 200)
        self.assertTrue(made["secret"].startswith("aas_pat_"))
        r, got = self.req("GET", "/api/tokens", cookie)
        self.assertEqual([t["name"] for t in got["tokens"]], ["CI"])
        self.assertNotIn(made["secret"], json.dumps(got))                  # 목록에는 원문이 없다
        r, bad = self.req("POST", "/api/tokens/create", cookie, {"name": "x", "bundle": "read", "days": 365})
        self.assertEqual((r.status, bad.get("field")), (400, "days"))
        r, _ = self.req("POST", "/api/tokens/revoke", cookie, {"id": made["token"]["id"]})
        self.assertEqual(r.status, 200)
        r, _ = self.req("POST", "/api/tokens/revoke", cookie, {"id": made["token"]["id"]})
        self.assertEqual(r.status, 404)
        r, got = self.req("GET", "/api/tokens?ended=1", cookie)
        self.assertEqual([t["state"] for t in got["tokens"]], ["revoked"])
        r, me = self.req("GET", "/api/me", cookie)
        self.assertEqual(me["connections"], {"active": 0, "expiring": 0})              # 메뉴 배지·계정 서랍(§3-7 ②)

    def test_POST_는_X_AAS_없이_막힌다(self):
        cookie = self.login()
        c = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        c.request("POST", "/api/tokens/create", body=json.dumps({"name": "n", "bundle": "read", "days": 30}), headers={"Cookie": cookie})
        r = c.getresponse(); r.read()
        self.assertEqual(r.status, 403)

    def test_모두_끊기는_확인을_받고_로그인_세션도_끝낸다(self):
        cookie = self.login()
        for i in range(2):
            self.req("POST", "/api/tokens/create", cookie, {"name": f"n{i}", "bundle": "read", "days": 30})
        other = self.login()                                                 # 같은 사람의 다른 브라우저
        r, bad = self.req("POST", "/api/tokens/revoke-all", cookie, {"confirm": "someone@corp.example"})
        self.assertEqual((r.status, bad.get("field")), (400, "confirm"))
        r, out = self.req("POST", "/api/tokens/revoke-all", cookie, {"confirm": "PAT-web@corp.example"})
        self.assertEqual((r.status, out["revoked"]), (200, 2))
        self.assertIn("Max-Age=0", r.getheader("Set-Cookie"))
        self.assertEqual(self.req("GET", "/api/tokens", cookie)[0].status, 401)
        self.assertEqual(self.req("GET", "/api/tokens", other)[0].status, 401)    # 다른 세션도 끝났다

    def test_로그인을_끈_설치에서는_쓰지_않는다(self):
        from aas.auth import auth
        saved = self.server._auth
        self.server._auth = auth.Auth({"issuer": "", "client_id": "", "client_secret": "", "domain": "",
                                       "public_url": f"http://127.0.0.1:{self.port}", "hours": 1, "users_file": Path(TMP.name) / "none.json"})
        try:
            r, out = self.req("GET", "/api/tokens")
            self.assertEqual((r.status, out.get("reason")), (404, "login_off"))
            r, out = self.req("POST", "/api/tokens/create", body={"name": "n", "bundle": "read", "days": 30})
            self.assertEqual((r.status, out.get("reason")), (404, "login_off"))
        finally:
            self.server._auth = saved


if __name__ == "__main__":
    unittest.main()

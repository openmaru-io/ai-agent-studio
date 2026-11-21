# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""로그인 도메인 → 회사 도메인(스펙 2026-11-15-005, OMAI-2037). 범위는 2-1절: 관리자 「전원 바꾸기」와 새로 온 사람의 로그인 처리.

가짜 Keycloak 관리 API(kcfake)와, 코드·리프레시 두 grant 를 흉내 내는 가짜 OIDC 토큰 주소를 쓴다.
"""
import base64
import json
import os
import re
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest import mock
from urllib.parse import parse_qs

TMP = tempfile.TemporaryDirectory()
os.environ["AAS_DATA_DIR"] = str(Path(TMP.name) / "data")

import kcfake  # noqa: E402
from aas.auth import auth, keycloak, login_alias  # noqa: E402
from aas.common import dbmigrate, store  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]


def b64(obj) -> str:
    return base64.urlsafe_b64encode(json.dumps(obj).encode()).rstrip(b"=").decode()


def jwt(claims: dict) -> str:
    return f"{b64({'alg': 'none'})}.{b64(claims)}.x"


def save(**over):
    body = {"mode": "on", "pairs": ["legacy.example.com:openmaru.io"], "providers": ["google"], "exclude": [], **over}
    return login_alias.save(body, "admin@openmaru.io")


def clear_tables():
    with store.connect() as conn:
        conn.executescript(login_alias.SCHEMA)
        for t in ("login_merges", "login_alias_locks", "login_idp_seen"):
            conn.execute(f"DELETE FROM {t}")
        conn.execute("DELETE FROM meta WHERE key=?", (login_alias.META_KEY,))


class ConfigTest(unittest.TestCase):
    def setUp(self):
        clear_tables()

    def test_도메인_짝은_설치_값_꼴과_줄마다_꼴을_같은_함수로_읽는다(self):
        self.assertEqual(login_alias.parse_pairs("legacy.example.com:openmaru.io,a.co:b.co"), [["legacy.example.com", "openmaru.io"], ["a.co", "b.co"]])
        self.assertEqual(login_alias.parse_pairs("@legacy.example.com : openmaru.io\n"), [["legacy.example.com", "openmaru.io"]])

    def test_잘못된_값은_400_본문에_칸_줄_값_기대를_담는다(self):
        for value, code, line in (("legacy.example.com", "bad_pair", 1), ("a.co:b.co\nnot a domain:b.co", "bad_pair", 2),
                                  ("a.co:a.co", "same_domain", 1), ("a.co:b.co\na.co:c.co", "duplicate", 2),
                                  ("a.co:b.co\nb.co:c.co", "chained", 2)):
            with self.assertRaises(login_alias.ConfigError, msg=value) as cm:
                login_alias.validate({"mode": "on", "pairs": value, "providers": "google"})
            body = cm.exception.body()
            self.assertEqual((body["code"], body["field"], body["line"]), (code, "pairs", line), value)
            self.assertEqual(set(body), {"error", "code", "field", "line", "value", "expected"})
        with self.assertRaises(login_alias.ConfigError) as cm:
            login_alias.validate({"mode": "on", "pairs": "a.co:b.co", "providers": "google", "exclude": "kim"})
        self.assertEqual((cm.exception.field, cm.exception.code), ("exclude", "bad_email"))
        with self.assertRaises(login_alias.ConfigError) as cm:
            login_alias.validate({"mode": "on", "pairs": "a.co:b.co", "providers": "go ogle"})
        self.assertEqual(cm.exception.field, "providers")
        with self.assertRaises(login_alias.ConfigError) as cm:
            login_alias.validate({"mode": "on", "pairs": "", "providers": "google"})
        self.assertEqual(cm.exception.code, "pairs_required")
        self.assertEqual(login_alias.validate({"mode": "off"})["mode"], "off")   # 끄기는 빈 값이어도 된다

    def test_설치_값은_도메인_짝만_채우고_켜지_않으며_화면에서_저장하면_화면_값이_이긴다(self):
        with mock.patch.dict(os.environ, {"AAS_LOGIN_DOMAIN_ALIASES": "legacy.example.com:openmaru.io"}):
            cfg, source = login_alias.load()
            self.assertEqual((cfg["mode"], cfg["pairs"], source), ("off", [["legacy.example.com", "openmaru.io"]], "install"))
            save(mode="record")
            cfg, source = login_alias.load()
            self.assertEqual((cfg["mode"], source), ("record", "screen"))
            login_alias.reset("admin@openmaru.io")
            self.assertEqual(login_alias.load()[1], "install")
        with mock.patch.dict(os.environ, {"AAS_LOGIN_DOMAIN_ALIASES": "틀린값"}):
            self.assertEqual(login_alias.load()[0]["pairs"], [])                 # 틀린 설치 값은 짝 없이(로그만)


class DecideTest(unittest.TestCase):
    CFG = {"mode": "on", "pairs": [["legacy.example.com", "openmaru.io"]], "providers": ["google"], "exclude": ["kim@legacy.example.com"]}

    def case(self, cfg=None, **claims):
        c = {"email": "hong@legacy.example.com", "email_verified": True, "identity_provider": "google", **claims}
        return login_alias.decide(cfg or self.CFG, c)

    def test_판단은_대역_없이_경우_이름을_돌려준다(self):
        d = self.case()
        self.assertEqual((d["case"], d["company_email"]), ("target", "hong@openmaru.io"))
        self.assertEqual(self.case(cfg={**self.CFG, "mode": "off"})["case"], "off")
        self.assertEqual(self.case(email="hong@openmaru.io")["case"], "not_target")
        self.assertEqual(self.case(email_verified=False)["case"], "not_target")
        self.assertEqual(self.case(email="kim@legacy.example.com")["case"], "excluded")        # 제외 목록이 판단 맨 앞
        self.assertEqual(self.case(identity_provider="")["case"], "no_claim")             # 비밀번호 로그인·매퍼 없는 client
        self.assertEqual(self.case(identity_provider="github")["case"], "not_provider")
        self.assertEqual(self.case(cfg={**self.CFG, "mode": "record"})["case"], "target")


class RenameRecordsTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        dbmigrate.ensure_schema()

    def test_실행_때_스키마에서_이메일_열을_찾고_기본_키가_겹치면_새_쪽을_남긴다(self):
        with store.connect() as conn:
            conn.execute("DELETE FROM access_grants")
            conn.execute("DELETE FROM agent_limits")
            conn.execute("DELETE FROM admin_requests")
            conn.execute("INSERT INTO access_grants (email, role, pods, by, ts) VALUES ('hong@legacy.example.com','user','[]','a','t')")
            conn.execute("INSERT INTO agent_limits (email, max, by, ts) VALUES ('hong@legacy.example.com', 2, 'a', 't')")
            conn.execute("INSERT INTO agent_limits (email, max, by, ts) VALUES ('hong@openmaru.io', 5, 'a', 't')")   # 관리자가 미리 넣은 값
            conn.execute("INSERT INTO admin_requests (pod, profile, requester, kind, created_at) VALUES ('p','x','hong@legacy.example.com','other',?)",
                         ("2026-11-15T10:00:00+09:00",))
        self.addCleanup(self._clean)                                  # 데이터 폴더를 다른 시험과 함께 쓴다(CLAUDE.md)
        changed = login_alias.rename_records("hong@legacy.example.com", "hong@openmaru.io")
        self.assertEqual(changed.get("access_grants.email"), 1)
        self.assertEqual(changed.get("admin_requests.requester"), 1)
        with store.connect() as conn:
            self.assertEqual(conn.execute("SELECT email FROM access_grants").fetchall()[0][0], "hong@openmaru.io")
            self.assertEqual([tuple(r) for r in conn.execute("SELECT email, max FROM agent_limits ORDER BY email")], [("hong@openmaru.io", 5)])
            self.assertEqual(conn.execute("SELECT by FROM access_grants").fetchone()[0], "a")      # 처리 기록 열은 그대로

    @staticmethod
    def _clean():
        with store.connect() as conn:
            for t in ("access_grants", "agent_limits"):
                conn.execute(f"DELETE FROM {t} WHERE email LIKE 'hong@%'")
            conn.execute("DELETE FROM admin_requests WHERE requester LIKE 'hong@%'")

    def test_소스의_모든_표_정의의_email_owner_열이_바꿀_목록이나_예외에_있다(self):
        """새 표에 이메일 열이 생기면 이 시험이 실패한다 — email_columns 의 이름 규칙에 걸리는지, 예외라면 NOT_EMAIL 에 이유와 함께 넣는다."""
        found = set()
        for p in (ROOT / "aas").rglob("*.py"):
            text = p.read_text(encoding="utf-8")
            joined = re.sub(r'"\s*\n\s*(?:f?")', "", text)                    # 이어 쓴 문자열 조각을 붙인다
            for m in re.finditer(r"CREATE TABLE IF NOT EXISTS (\w+)(?:\s*/\*[^*]*\*/)?\s*\(", joined):
                depth, i = 1, m.end()
                while depth and i < len(joined):
                    depth += {"(": 1, ")": -1}.get(joined[i], 0)
                    i += 1
                body = joined[m.end():i - 1]
                parts, depth, cur = [], 0, ""
                for ch in body:
                    depth += {"(": 1, ")": -1}.get(ch, 0)
                    if ch == "," and depth == 0:
                        parts.append(cur)
                        cur = ""
                    else:
                        cur += ch
                parts.append(cur)
                for part in parts:
                    name = part.strip().split(" ")[0].strip('"')
                    if re.search(r"email|owner", name, re.I) and name.upper() not in ("PRIMARY", "UNIQUE"):
                        found.add((m.group(1), name))
        self.assertIn(("access_grants", "email"), found)
        self.assertIn(("personal_tokens", "user_email"), found)
        unknown = {k for k in found if k in login_alias.NOT_EMAIL}
        self.assertEqual(unknown, {("connector_tokens", "lease_owner"), ("login_merges", "login_email"), ("login_merges", "company_email")})
        with store.connect() as conn:
            cols = set(login_alias.email_columns(conn))
        for key in found:                                                      # 지금 DB 에 만든 표는 모두 이름 규칙으로 잡힌다
            if key not in login_alias.NOT_EMAIL and key[0] in {t for t, _ in cols}:
                self.assertIn(key, cols)
        for key in login_alias.EXTRA_EMAIL:
            self.assertIn(key, cols)


class FakeK8s:
    def __init__(self, items):
        self.items, self.patched = items, []

    def list_agents(self):
        return self.items

    def patch_agent(self, name, patch):
        self.patched.append((name, patch))
        for it in self.items:
            if it["metadata"]["name"] == name:
                it["spec"].update(patch["spec"])


class KCBase(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        dbmigrate.ensure_schema()
        cls.httpd, cls.issuer = kcfake.start()

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()

    def setUp(self):
        kcfake.FakeKC.reset()
        clear_tables()
        self.kc = kcfake.admin(self.issuer)
        self.k8s = FakeK8s([{"metadata": {"name": "aas-agent-hong-1"}, "spec": {"ownerEmail": "hong@legacy.example.com", "ownerSub": "u-hong"}},
                            {"metadata": {"name": "hag-old"}, "spec": {"ownerEmail": "hong@legacy.example.com", "ownerSub": "hong@legacy.example.com"}},
                            {"metadata": {"name": "other"}, "spec": {"ownerEmail": "kim@legacy.example.com", "ownerSub": "u-kim"}}])
        k = mock.patch.object(login_alias, "_k8s", return_value=self.k8s)
        k.start()
        self.addCleanup(k.stop)
        self.renamed = []
        login_alias.ON_RENAMED.append(self._renamed)
        self.addCleanup(login_alias.ON_RENAMED.remove, self._renamed)

    def _renamed(self, old, new):
        self.renamed.append((old, new))


class BulkTest(KCBase):
    def add_people(self):
        kcfake.FakeKC.add("u-hong", "hong@legacy.example.com", "hong@legacy.example.com", groups=["g-users"])
        kcfake.FakeKC.add("u-kim", "kim@legacy.example.com", "kim@legacy.example.com", groups=["g-users"])
        kcfake.FakeKC.add("u-lee", "lee@legacy.example.com", "lee@legacy.example.com", groups=["g-users"])
        kcfake.FakeKC.add("u-lee2", "lee", "lee@openmaru.io", groups=["g-users"])                 # 회사 이메일 사용자가 이미 있다
        kcfake.FakeKC.add("u-admin", "aas-admin", "aas-admin@cop.openmaru.local", groups=["g-admins"])

    def test_미리_보기는_Keycloak_에_쓰지_않고_겹침과_제외를_보인다(self):
        self.add_people()
        save(mode="off", exclude=["kim@legacy.example.com"])
        rows = login_alias.preview(self.kc)
        self.assertEqual([(r["login_email"], r["company_email"], r["conflict"], r["excluded"]) for r in rows],
                         [("hong@legacy.example.com", "hong@openmaru.io", False, False), ("kim@legacy.example.com", "kim@openmaru.io", False, True),
                          ("lee@legacy.example.com", "lee@openmaru.io", True, False)])
        self.assertFalse([s for s in kcfake.FakeKC.seen if s[0] != "GET" and "/admin/" in s[1]])

    def test_기록만은_판단만_남기고_실행은_사람마다_세_단계를_한다(self):
        self.add_people()
        save(mode="off", exclude=["kim@legacy.example.com"])
        out = login_alias.bulk(self.kc, "record", "admin@openmaru.io", self.k8s)
        self.assertEqual((out["recorded"], out["done"]), (2, 0))
        self.assertFalse(kcfake.FakeKC.calls("PUT", r"/admin/realms/aas/users/.*"))
        self.assertEqual(self.k8s.patched, [])
        with store.connect() as conn:
            conn.execute("DELETE FROM access_grants")
            conn.execute("INSERT INTO access_grants (email, role, pods, by, ts) VALUES ('hong@legacy.example.com','user','[]','a','t')")
        self.addCleanup(RenameRecordsTest._clean)
        out = login_alias.bulk(self.kc, "run", "admin@openmaru.io", self.k8s)
        self.assertEqual((out["done"], out["rejected"], out["skipped"], out["failed"]), (1, 1, 1, 0))
        self.assertEqual(kcfake.FakeKC.users["u-hong"]["email"], "hong@openmaru.io")
        self.assertTrue(kcfake.FakeKC.users["u-hong"]["emailVerified"])
        self.assertEqual(kcfake.FakeKC.users["u-hong"]["username"], "hong@legacy.example.com")       # 아이디는 그대로(E4)
        self.assertEqual(kcfake.FakeKC.users["u-lee"]["email"], "lee@legacy.example.com")              # 겹친 사람은 손대지 않는다
        self.assertEqual(kcfake.FakeKC.users["u-kim"]["email"], "kim@legacy.example.com")              # 제외
        specs = {i["metadata"]["name"]: i["spec"] for i in self.k8s.items}
        self.assertEqual(specs["aas-agent-hong-1"], {"ownerEmail": "hong@openmaru.io", "ownerSub": "u-hong"})
        self.assertEqual(specs["hag-old"], {"ownerEmail": "hong@openmaru.io", "ownerSub": "u-hong"})
        self.assertEqual(specs["other"]["ownerEmail"], "kim@legacy.example.com")
        with store.connect() as conn:
            self.assertEqual(conn.execute("SELECT email FROM access_grants").fetchone()[0], "hong@openmaru.io")
        self.assertEqual(self.renamed, [("hong@legacy.example.com", "hong@openmaru.io")])            # 세션 끝내기·캐시 버리기
        att = login_alias.attention()
        self.assertEqual([(r["login_email"], r["kase"], r["result"]) for r in att], [("lee@legacy.example.com", "needs_admin", "rejected")])

    def test_중간에_실패한_사람은_멈추고_다시_누르면_남은_단계부터_한다(self):
        kcfake.FakeKC.add("u-hong", "hong@legacy.example.com", "hong@legacy.example.com", groups=["g-users"])
        save(mode="off")
        with mock.patch.object(login_alias, "rename_agents", side_effect=RuntimeError("k8s down")):
            out = login_alias.bulk(self.kc, "run", "admin@openmaru.io", self.k8s)
        self.assertEqual(out["failed"], 1)
        row = login_alias.records()[0]
        self.assertEqual((row["result"], row["step"]), ("failed", "renamed"))
        self.assertIn("RuntimeError", row["error"])
        self.assertEqual([r["login_email"] for r in login_alias.attention()], ["hong@legacy.example.com"])
        puts = len(kcfake.FakeKC.calls("PUT", r"/admin/realms/aas/users/u-hong"))
        out = login_alias.bulk(self.kc, "run", "admin@openmaru.io", self.k8s)               # Keycloak 이메일은 이미 바뀌어 미리 보기에 없다
        self.assertEqual(out["done"], 1)
        self.assertEqual(len(kcfake.FakeKC.calls("PUT", r"/admin/realms/aas/users/u-hong")), puts)   # 이메일 PUT 을 다시 하지 않는다
        self.assertEqual(self.k8s.items[0]["spec"]["ownerEmail"], "hong@openmaru.io")
        self.assertEqual(login_alias.attention(), [])
        self.assertEqual(login_alias.unfinished(), [])

    def test_그사이_회사_사용자가_생겨_이메일_PUT_이_409_면_확인_필요로_간다(self):
        kcfake.FakeKC.add("u-hong", "hong@legacy.example.com", "hong@legacy.example.com")
        save(mode="off")
        real = login_alias.preview

        def racing(kc, cfg=None):
            rows = real(kc, cfg)
            kcfake.FakeKC.add("u-new", "hong", "hong@openmaru.io")
            return rows
        with mock.patch.object(login_alias, "preview", side_effect=racing):
            out = login_alias.bulk(self.kc, "run", "admin@openmaru.io", self.k8s)
        self.assertEqual(out["rejected"], 1)
        self.assertEqual(login_alias.attention()[0]["kase"], "needs_admin")
        self.assertEqual(kcfake.FakeKC.users["u-hong"]["email"], "hong@legacy.example.com")


class TokenOIDC(BaseHTTPRequestHandler):
    """코드 grant 와 refresh grant. refresh 는 가짜 Keycloak(kcfake) 사용자의 지금 이메일로 id_token 을 만든다(실제 Keycloak 처럼)."""
    issuer = ""
    claims: dict = {}
    seen: list = []
    refresh_sub = ""

    def do_GET(self):
        base = f"http://127.0.0.1:{self.server.server_port}"
        body = json.dumps({"issuer": base, "authorization_endpoint": base + "/auth", "token_endpoint": base + "/token"}).encode()
        self.send_response(200); self.send_header("Content-Length", str(len(body))); self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        form = parse_qs(self.rfile.read(int(self.headers["Content-Length"])).decode())
        grant = form["grant_type"][0]
        TokenOIDC.seen.append(grant)
        c = dict(TokenOIDC.claims)
        if grant == "refresh_token":
            c.pop("nonce", None)
            u = kcfake.FakeKC.users.get(c["sub"]) or {}
            c["email"] = u.get("email", c["email"])
            if TokenOIDC.refresh_sub:
                c["sub"] = TokenOIDC.refresh_sub
        body = json.dumps({"id_token": jwt(c), "access_token": jwt({"realm_access": {"roles": []}, "groups": ["/aas-users"]}),
                           "refresh_token": "rt-" + grant}).encode()
        self.send_response(200); self.send_header("Content-Length", str(len(body))); self.end_headers()
        self.wfile.write(body)

    def log_message(self, *a):
        pass


class LoginTest(KCBase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.idp = ThreadingHTTPServer(("127.0.0.1", 0), TokenOIDC)
        threading.Thread(target=cls.idp.serve_forever, daemon=True).start()
        cls.oidc = f"http://127.0.0.1:{cls.idp.server_port}"

    @classmethod
    def tearDownClass(cls):
        cls.idp.shutdown()
        super().tearDownClass()

    def setUp(self):
        super().setUp()
        TokenOIDC.seen, TokenOIDC.refresh_sub = [], ""
        p = mock.patch.object(keycloak, "admin_from_config", return_value=self.kc)
        p.start()
        self.addCleanup(p.stop)
        kcfake.FakeKC.add("u-hong", "hong@legacy.example.com", "hong@legacy.example.com", groups=["g-users"])
        with store.connect() as conn:
            conn.execute("DELETE FROM auth_sessions WHERE email LIKE ?", ("hong@%",))

    def make(self, **over) -> auth.Auth:
        return auth.Auth({"issuer": self.oidc, "client_id": "aas", "client_secret": "sec", "domain": "openmaru.io",
                          "users_group": "aas-users", "admin_role": "aas-admin", "groups_claim": "groups",
                          "public_url": "http://127.0.0.1:17900", "hours": 1, **over})

    def login(self, a: auth.Auth, **claims):
        TokenOIDC.claims = {"iss": self.oidc, "aud": "aas", "exp": time.time() + 300, "nonce": "n1", "sub": "u-hong",
                            "email": "hong@legacy.example.com", "email_verified": True, "identity_provider": "google", **claims}
        return a._finish("code", {"nonce": "n1", "verifier": "v", "base": "http://127.0.0.1:17900", "next": "/"}, False)

    def session(self, token):
        with store.connect() as conn:
            import hashlib
            return conn.execute("SELECT email, sub, login_idp FROM auth_sessions WHERE hash=?",
                                (hashlib.sha256(token.encode()).hexdigest(),)).fetchone()

    def test_꺼져_있으면_지금처럼_허용_도메인_밖은_거절된다(self):
        save(mode="off")
        with self.assertRaises(auth.AuthError) as cm:
            self.login(self.make())
        self.assertNotEqual(cm.exception.reason, "login_alias")
        self.assertEqual(kcfake.FakeKC.users["u-hong"]["email"], "hong@legacy.example.com")

    def test_새로_온_사람은_이메일이_회사_도메인으로_바뀌고_리프레시한_토큰으로_들어온다(self):
        save()
        token, _ = self.login(self.make())
        self.assertEqual(TokenOIDC.seen, ["authorization_code", "refresh_token"])
        row = self.session(token)
        self.assertEqual((row["email"], row["sub"], row["login_idp"]), ("hong@openmaru.io", "u-hong", "idp:google"))
        self.assertEqual(kcfake.FakeKC.users["u-hong"]["email"], "hong@openmaru.io")
        self.assertEqual(self.k8s.items[0]["spec"]["ownerEmail"], "hong@openmaru.io")
        rec = login_alias.records()[0]
        self.assertEqual((rec["kase"], rec["result"], rec["step"], rec["source"]), ("rename", "done", "agents_renamed", "login"))
        self.assertEqual([r["alias"] for r in login_alias.observed()], ["google"])
        # 두 번째 로그인: 이메일이 이미 회사 도메인이라 조건 불일치(Keycloak 을 다시 쓰지 않는다)
        TokenOIDC.seen = []
        puts = len(kcfake.FakeKC.calls("PUT", r"/admin/realms/aas/users/u-hong"))
        self.login(self.make(), email="hong@openmaru.io")
        self.assertEqual(TokenOIDC.seen, ["authorization_code"])
        self.assertEqual(len(kcfake.FakeKC.calls("PUT", r"/admin/realms/aas/users/u-hong")), puts)

    def test_기록만이면_Keycloak_에_쓰지_않고_판단만_남긴다(self):
        save(mode="record")
        with self.assertRaises(auth.AuthError):                     # 허용 도메인(openmaru.io) 밖이라 지금처럼 거절
            self.login(self.make())
        self.assertFalse(kcfake.FakeKC.calls("PUT", r"/admin/realms/aas/users/.*"))
        self.assertEqual([(r["kase"], r["result"]) for r in login_alias.records()], [("rename", "recorded")])

    def test_비밀번호_로그인_claim_없음_대상_제공자_아님은_처리하지_않는다(self):
        save()
        for claims in ({"identity_provider": ""}, {"identity_provider": "github"}):
            with self.assertRaises(auth.AuthError):
                self.login(self.make(), **claims)
        self.assertFalse(kcfake.FakeKC.calls("PUT", r"/admin/realms/aas/users/.*"))
        self.assertEqual(login_alias.records(), [])

    def test_identity_provider_가_액세스_토큰에만_있으면_처리하지_않는다(self):
        save()
        a = self.make()
        claims = {"email": "hong@legacy.example.com", "email_verified": True}
        a._merge_access_claims(claims, jwt({"identity_provider": "google", "realm_access": {"roles": []}}))
        self.assertNotIn("identity_provider", claims)
        self.assertEqual(login_alias.decide(login_alias.load()[0], claims)["case"], "no_claim")

    def test_회사_이메일_사용자가_이미_있으면_합치지_않고_NEEDS_ADMIN_으로_거절한다(self):
        save()
        kcfake.FakeKC.add("u-io", "hong", "hong@openmaru.io", groups=["g-users"])
        with self.assertRaises(auth.AuthError) as cm:
            self.login(self.make())
        exc = cm.exception
        self.assertEqual((exc.status, exc.code), (403, "AAS-LM-NEEDS-ADMIN"))
        ref = login_alias.records()[0]["id"]
        self.assertIn(f"AAS-LM-NEEDS-ADMIN, 추적 {ref}", str(exc))
        self.assertEqual(kcfake.FakeKC.users["u-hong"]["email"], "hong@legacy.example.com")
        self.assertEqual(login_alias.attention()[0]["kase"], "needs_admin")

    def test_관리_API_오류면_RETRY_503_이고_원인은_기록에_남긴다(self):
        save()
        kcfake.FakeKC.fail[("PUT", r"/admin/realms/aas/users/u-hong")] = 500
        with self.assertRaises(auth.AuthError) as cm:
            self.login(self.make())
        self.assertEqual((cm.exception.status, cm.exception.code), (503, "AAS-LM-RETRY"))
        rec = login_alias.records()[0]
        self.assertEqual(rec["result"], "failed")
        self.assertIn("KeycloakError 500", rec["error"])
        self.assertNotIn("rt-", rec["error"])

    def test_리프레시가_다른_sub_를_주면_거절한다(self):
        save()
        TokenOIDC.refresh_sub = "u-other"
        with self.assertRaises(auth.AuthError) as cm:
            self.login(self.make())
        self.assertEqual(cm.exception.code, "AAS-LM-RETRY")

    def test_갱신_모드는_nonce_대신_처음_토큰과_iss_aud_sub_를_비교한다(self):
        a = self.make()
        first = {"iss": self.oidc, "aud": "aas", "sub": "u-hong"}
        good = {**first, "exp": time.time() + 60, "email": "hong@openmaru.io", "email_verified": True, "groups": ["aas-users"]}
        self.assertEqual(a._validate(good, "", first=first)["email"], "hong@openmaru.io")
        with self.assertRaises(auth.AuthError):
            a._validate({**good, "sub": "u-x"}, "", first=first)
        with self.assertRaises(auth.AuthError):
            a._validate(good, "n1")                                   # 갱신 모드가 아니면 nonce 를 본다

    def test_잠금을_다른_서버가_쥐고_있으면_LOCK_TIMEOUT_만료된_잠금은_넘겨받는다(self):
        save()
        with store.connect() as conn:
            conn.execute("INSERT INTO login_alias_locks (key, owner, until) VALUES (?,?,?)", ("hong@openmaru.io", "other", time.time() + 30))
        with mock.patch.object(login_alias, "LOCK_WAIT", 0.3), self.assertRaises(auth.AuthError) as cm:
            self.login(self.make())
        self.assertEqual((cm.exception.status, cm.exception.code), (503, "AAS-LM-LOCK-TIMEOUT"))
        with store.connect() as conn:
            conn.execute("UPDATE login_alias_locks SET until=?", (time.time() - 1,))
        token, _ = self.login(self.make())
        self.assertEqual(self.session(token)["email"], "hong@openmaru.io")
        with store.connect() as conn:
            self.assertEqual(conn.execute("SELECT COUNT(*) FROM login_alias_locks").fetchone()[0], 0)

    def test_두_구글_계정이_한_회사_이메일을_동시에_노리면_하나만_잡는다(self):
        a = login_alias.lock("x@openmaru.io", wait=0)
        b = login_alias.lock("X@openmaru.io", wait=0)                  # 열쇠는 소문자
        self.assertIsNotNone(a)
        self.assertIsNone(b)
        login_alias.unlock("x@openmaru.io", a)
        self.assertIsNotNone(login_alias.lock("x@openmaru.io", wait=0))

    def test_세션의_로그인_방식은_claim_이_온_적이_있는_client_에서만_password(self):
        login_alias.observe("aas", "")
        self.assertEqual(login_alias.login_idp({}, "aas"), "unknown")
        login_alias.observe("aas", "google")
        self.assertEqual(login_alias.login_idp({}, "aas"), "password")
        self.assertEqual(login_alias.login_idp({"identity_provider": "google"}, "aas"), "idp:google")

    def test_관찰은_8일_지나면_지운다(self):
        old = time.time() - 9 * 86400
        login_alias.observe("aas", "google", now=old)
        login_alias.observe("aas", "google")
        with store.connect() as conn:
            self.assertEqual(conn.execute("SELECT COUNT(*) FROM login_idp_seen").fetchone()[0], 1)


class ViewTest(KCBase):
    def test_설정_화면과_위젯_앱_화면이_받는_값(self):
        from aas.web import server
        save(mode="record")
        login_alias.observe("aas", "")
        fake = mock.Mock(cfg={"client_id": "aas", "issuer": "https://kc/realms/aas"})
        with mock.patch.object(server, "auth", return_value=fake), mock.patch.object(keycloak, "admin_from_config", return_value=None):
            v = server._login_alias_view()
            self.assertTrue(v["no_claim"])                                    # aas client 에 claim 이 한 번도 오지 않았다
            self.assertEqual(v["unseen_providers"], ["google"])
            self.assertFalse(v["keycloak"])
            login_alias.observe("aas", "google")
            login_alias.observe("wiki-login", "google")
            v = server._login_alias_view()
            self.assertFalse(v["no_claim"])
            self.assertEqual(v["unseen_providers"], [])
            w = server._login_claim_view(fake)
        self.assertEqual((w["login_alias_on"], w["aas_issuer"], w["login_claim_clients"]), (True, "https://kc/realms/aas", ["aas", "wiki-login"]))


class EmbedTest(KCBase):
    def test_앱_토큰_교환은_로그인_도메인이면_AAS_에_먼저_로그인하라고_돌려준다(self):
        from aas.auth import embed
        from aas.web import embed_routes
        save()
        app = {"app_id": "a1", "mode": "keycloak", "issuer": "x"}
        fake_auth = mock.Mock(enabled=True, cfg={"public_url": ""})
        with mock.patch.object(embed_routes.server, "auth", return_value=fake_auth), \
                mock.patch.object(embed, "app_for_origin", return_value=app), \
                mock.patch.object(embed, "verify_keycloak", return_value={"email": "hong@legacy.example.com", "email_verified": True}), \
                mock.patch.object(embed_routes.mcp_limits, "hit", return_value=0):
            with self.assertRaises(embed.EmbedError) as cm:
                embed_routes.exchange("https://wiki", "assertion", "1.2.3.4")
        self.assertEqual((cm.exception.status, cm.exception.code), (403, "AAS-LM-LOGIN-AAS-FIRST"))

    def test_팝업_로그인은_앱_issuer_가_AAS_영역과_같을_때만_처리한다(self):
        from aas.web import embed_routes
        save()
        fake_auth = mock.Mock(cfg={"issuer": "https://kc/realms/aas"})
        with mock.patch.object(embed_routes.server, "auth", return_value=fake_auth), \
                mock.patch.object(login_alias, "at_login") as at:
            out = embed_routes._alias_claims({"issuer": "https://other/realms/x"}, {"t": 1}, {"c": 1})
            self.assertEqual(out, ({"t": 1}, {"c": 1}))
            at.assert_not_called()
            at.return_value = ({"t": 2}, {"c": 2})
            out = embed_routes._alias_claims({"issuer": "https://kc/realms/aas", "login_client_id": "wiki", "app_id": "a"}, {"t": 1}, {"c": 1})
            self.assertEqual(out, ({"t": 2}, {"c": 2}))
            self.assertEqual(at.call_args.kwargs["source"], "embed")
            self.assertEqual(at.call_args.args[2], "wiki")


if __name__ == "__main__":
    unittest.main()

# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""프로파일 화면의 내 에이전트 전체 목록과 만들 에이전트 고르기(스펙 2026-10-19-018 A1·B3, 리뷰 D3·D4·D6·I4·I5·I6·I8).
범위는 채팅 묶음과 같고, 한 에이전트가 실패하거나 시간을 넘기면 그 묶음만 error 다. 만들기는 target_pod 의 에이전트에 만든다."""
import aasserver  # 실제 uvicorn 앱을 띄우는 시험 하네스(OMAI-1100)
import http.client
import json
import os
import tempfile
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

TMP = tempfile.TemporaryDirectory()
os.environ.setdefault("AAS_DATA_DIR", str(Path(TMP.name) / "data"))

from aas.common import i18n  # noqa: E402
from aas.fleet import chat_default, primary  # noqa: E402
from aas.web import server  # noqa: E402


class Reg:
    def __init__(self, pods, admin_emails=(), grants=None, agents=()):
        self.pods, self._admins, self._grants, self.agents = pods, set(admin_emails), grants or {}, list(agents)

    def is_admin(self, user):
        return (user or {}).get("email") in self._admins

    def allowed(self, user, enabled):
        if self.is_admin(user):
            return list(self.pods)
        extra = set(self._grants.get(user["email"], []))
        return [p for p in self.pods if p.owned_by(user) or p.id in extra]


def pod(pid, owner):
    return SimpleNamespace(id=pid, owner=owner, owned_by=lambda u, o=owner: (u or {}).get("email") == o)


def row(name, **kw):
    return {"name": name, "issues": [], **kw}


class AllTest(unittest.TestCase):
    KIM = {"email": "kim@x.com"}

    def setUp(self):
        server._profiles_all_slow.clear()
        self.patches = [mock.patch.object(server, "_agent_names", return_value={"a": "마케팅", "b": "시험", "c": "남의 것"}),
                        mock.patch.object(server, "_pod_owner_name", side_effect=lambda p: "이영희" if p.owner == "lee@x.com" else "김철수"),
                        mock.patch.object(primary, "primary_of", return_value="main"),
                        mock.patch.object(chat_default, "resolve", side_effect=lambda pid, names, main: "research" if pid == "b" and "research" in names else main),
                        mock.patch.object(server.owner_guard, "profile_limit", return_value=5),
                        mock.patch.object(server.owner_guard, "profile_count", side_effect=lambda names, hidden: len(names)),
                        mock.patch.object(server.cron_policy, "root_hidden", return_value=False),
                        mock.patch.object(server.profiles, "default_model", return_value="")]
        for p in self.patches:
            p.start()

    def tearDown(self):
        for p in self.patches:
            p.stop()
        server._profiles_all_slow.clear()

    def run_all(self, reg, user, current, rows):
        def visible(p, admin):
            value = rows[p.id]
            if isinstance(value, Exception):
                raise value
            return value() if callable(value) else value
        with mock.patch.object(server, "_visible_profile_rows", side_effect=visible):
            return server._profiles_all(reg, user, True, current)

    def test_범위와_줄의_에이전트_정보_묶음의_권한(self):
        a, b, c = pod("a", "kim@x.com"), pod("b", "kim@x.com"), pod("c", "lee@x.com")
        reg = Reg([a, b, c], grants={"kim@x.com": ["c"]})
        out = self.run_all(reg, self.KIM, a, {"a": [row("main"), row("profile2")], "b": [row("main"), row("research")], "c": [row("main")]})
        self.assertEqual([g["pod"] for g in out["groups"]], ["a", "c", "b"])                 # 지금(a) → 이름순(남의 것 < 시험)
        by = {g["pod"]: g for g in out["groups"]}
        self.assertTrue(by["a"]["current"] and by["a"]["can_create"])
        self.assertEqual(by["a"]["profile_limit"], {"used": 2, "max": 5})                    # 주인에게만 상한
        self.assertTrue(by["c"]["shared"])
        self.assertFalse(by["c"]["can_create"])                                              # 나눠 받은 에이전트에는 만들지 못한다
        self.assertNotIn("profile_limit", by["c"])
        self.assertEqual((by["b"]["primary"], by["b"]["chat_default"]), ("main", "research"))
        self.assertTrue(by["a"].get("owner"))                                                # 전용 뱃지(리뷰 I10)
        mains = [(r["pod"], r["pod_name"], r["pod_owner_name"], r["primary"], r["chat_default"]) for r in out["profiles"] if r["name"] == "main"]
        self.assertEqual(mains, [("a", "마케팅", "", True, True), ("c", "남의 것", "이영희", True, True), ("b", "시험", "", True, False)])

    def test_숨긴_루트는_관리자에게도_줄로_보이지_않는다(self):
        """사용자 2026-10-19: 에이전트마다 「사용 금지」 default 줄이 붙어 목록이 길었다(2026-10-14-003 리뷰 D8 을 모은 목록에서 번복)."""
        a = pod("a", "admin@x.com")
        out = self.run_all(Reg([a], admin_emails={"admin@x.com"}), {"email": "admin@x.com"}, a,
                           {"a": [row("main"), row("default", is_default=True, hidden_root=True)]})
        self.assertEqual([r["name"] for r in out["profiles"]], ["main"])
        self.assertEqual(out["groups"][0]["count"], 1)

    def test_관리자는_자기_것과_지금_에이전트만(self):
        a, c, d = pod("a", "admin@x.com"), pod("c", "lee@x.com"), pod("d", "lee@x.com")
        reg = Reg([a, c, d], admin_emails={"admin@x.com"})
        out = self.run_all(reg, {"email": "admin@x.com"}, c, {"a": [row("main")], "c": [row("main")], "d": [row("main")]})
        self.assertEqual([g["pod"] for g in out["groups"]], ["c", "a"])
        self.assertTrue(all(g["can_create"] for g in out["groups"]))
        self.assertTrue(all("profile_limit" not in g for g in out["groups"]))                # 관리자는 상한이 없다

    def test_한_에이전트가_실패해도_나머지_줄과_묶음은_나온다(self):
        a, b = pod("a", "kim@x.com"), pod("b", "kim@x.com")
        out = self.run_all(Reg([a, b]), self.KIM, a, {"a": [row("main")], "b": OSError("사이드카 응답 없음")})
        self.assertEqual([(g["pod"], g["state"]) for g in out["groups"]], [("a", "ok"), ("b", "error")])
        self.assertIn("사이드카", out["groups"][1]["error"])
        self.assertEqual([r["pod"] for r in out["profiles"]], ["a"])

    def test_프로파일이_없는_에이전트와_멈춘_에이전트도_묶음으로_남는다(self):
        a, b = pod("a", "kim@x.com"), pod("b", "kim@x.com")
        reg = Reg([a, b], agents=[{"name": "z", "owner": "kim@x.com", "suspended": True, "display_name": "멈춘 것"},
                                  {"name": "y", "owner": "kim@x.com", "suspended": False, "display_name": "새것"}])
        out = self.run_all(reg, self.KIM, a, {"a": [row("main")], "b": []})
        self.assertEqual([(g["pod"], g["state"], g.get("count")) for g in out["groups"]],
                         [("a", "ok", 1), ("b", "ok", 0), ("z", "stopped", None), ("y", "starting", None)])

    def test_시간을_넘긴_에이전트는_응답_없음이고_30초_동안_다시_부르지_않는다(self):
        a, b = pod("a", "kim@x.com"), pod("b", "kim@x.com")
        calls = []

        def slow():
            calls.append("b")
            time.sleep(0.5)
            return [row("main")]
        with mock.patch.object(server, "_PROFILES_ALL_TIMEOUT", 0.1):
            out = self.run_all(Reg([a, b]), self.KIM, a, {"a": [row("main")], "b": slow})
            self.assertEqual(out["groups"][1]["state"], "error")
            self.assertEqual(out["groups"][1]["error"], "응답 없음")
            again = self.run_all(Reg([a, b]), self.KIM, a, {"a": [row("main")], "b": slow})
        self.assertEqual(calls, ["b"])                                                       # 두 번째는 부르지 않았다
        self.assertEqual(again["groups"][1]["state"], "error")
        server._profiles_all_slow["b"] -= 31                                                 # 30초가 지나면 다시 부른다
        third = self.run_all(Reg([a, b]), self.KIM, a, {"a": [row("main")], "b": [row("main")]})
        self.assertEqual(third["groups"][1]["state"], "ok")
        self.assertNotIn("b", server._profiles_all_slow)

    def test_시간을_넘긴_읽기가_끝나면_30초_안이라도_다시_읽는다(self):
        # 재기동 직후 첫 읽기(사이드카 묶음 받기)가 10초를 넘겨도 뒤에서 끝나면 캐시가 찬다. 그 뒤에도 30초 동안 「응답 없음」을 내면
        # 화면이 정상 자료를 받지 못한다(스펙 2026-11-02-002). 아직 읽는 중일 때만 건너뛴다
        a, b = pod("a", "kim@x.com"), pod("b", "kim@x.com")
        calls = []

        def slow():
            calls.append("slow")
            time.sleep(0.3)
            return [row("main")]
        with mock.patch.object(server, "_PROFILES_ALL_TIMEOUT", 0.1):
            first = self.run_all(Reg([a, b]), self.KIM, a, {"a": [row("main")], "b": slow})
            self.assertEqual(first["groups"][1]["error"], "응답 없음")
            time.sleep(0.5)                                                                  # 뒤에서 하던 읽기가 끝났다
            again = self.run_all(Reg([a, b]), self.KIM, a, {"a": [row("main")], "b": [row("main")]})
        self.assertEqual(calls, ["slow"])
        self.assertEqual(again["groups"][1]["state"], "ok")
        self.assertNotIn("b", server._profiles_all_slow)

    def test_나란히_읽는_스레드도_요청_언어를_쓴다(self):
        a, b = pod("a", "kim@x.com"), pod("b", "kim@x.com")
        seen = []

        def lang():
            seen.append(i18n.get_lang())
            return [row("main")]
        token = i18n._lang.set("en")
        try:
            self.run_all(Reg([a, b]), self.KIM, a, {"a": lang, "b": lang})
        finally:
            i18n._lang.reset(token)
        self.assertEqual(seen, ["en", "en"])


class HttpTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        from aas.auth import auth
        from aas.fleet import pods
        cls.old = {k: os.environ.get(k) for k in ("AAS_OIDC_ISSUER", "AAS_OIDC_CLIENT_FILE", "AAS_USERS_FILE", "AAS_ALLOWED_HOSTS", "AAS_PODS_FILE")}
        for k in cls.old:
            os.environ.pop(k, None)
        os.environ["AAS_USERS_FILE"] = str(Path(TMP.name) / "no-users.json")
        os.environ["AAS_PODS_FILE"] = str(Path(TMP.name) / "no-pods.json")
        homes = {}
        for pid in ("t", "u"):
            homes[pid] = Path(TMP.name) / f"hermes-{pid}"
            (homes[pid] / "profiles" / "main").mkdir(parents=True, exist_ok=True)
        reg = Path(TMP.name) / "pods.json"
        reg.write_text(json.dumps({"pods": [{"id": pid, "owner": f"{pid}@example.com", "hermes_home": str(h)} for pid, h in homes.items()]}))
        server._auth = auth.Auth({"issuer": "https://accounts.google.com", "client_id": "", "client_secret": "", "domain": "",
                                  "public_url": "http://localhost:17900", "hours": 1, "users_file": Path(TMP.name) / "no-users.json"})
        server._registry = pods.Registry(reg)
        cls.httpd = aasserver.start()
        cls.port = cls.httpd.server_port

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        for k, v in cls.old.items():
            if v is not None:
                os.environ[k] = v
        server._auth = server._registry = None

    def req(self, method, path, body=None):
        c = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        c.request(method, path, body=json.dumps(body) if body is not None else None, headers={"Content-Type": "application/json", "X-AAS": "1"})
        r = c.getresponse()
        data = json.loads(r.read() or b"{}")
        c.close()
        return r.status, data

    def setUp(self):
        self.made = []
        self.patches = [mock.patch.object(server, "_profile_action", side_effect=lambda p, body, who: self.made.append((p.id, body.get("name"))) or {"ok": True, "name": body.get("name")}),
                        mock.patch.object(server.cron_health.hr, "profiles", return_value=[SimpleNamespace(name="main")]),
                        mock.patch.object(server, "_visible_profile_rows", side_effect=lambda p, admin: [row("main")])]
        for p in self.patches:
            p.start()

    def tearDown(self):
        for p in self.patches:
            p.stop()

    def test_만들기는_target_pod_의_에이전트에_만든다(self):
        code, _ = self.req("POST", "/api/profile/action", {"action": "create", "name": "research", "target_pod": "u"})
        self.assertEqual(code, 200)
        self.assertEqual(self.made, [("u", "research")])                                    # 쿠키(첫 에이전트 t)가 아니라 고른 u

    def test_target_pod_가_범위_밖이거나_만들기가_아니면_403(self):
        self.assertEqual(self.req("POST", "/api/profile/action", {"action": "create", "name": "x", "target_pod": "ghost"})[0], 403)
        self.assertEqual(self.req("POST", "/api/profile/action", {"action": "delete", "name": "main", "target_pod": "u"})[0], 403)
        self.assertEqual(self.made, [])

    def test_target_pod_가_있어도_expect_pod_는_쿠키와_비교한다(self):
        self.assertEqual(self.req("POST", "/api/profile/action", {"action": "create", "name": "x", "target_pod": "u", "expect_pod": "u"})[0], 409)
        self.assertEqual(self.made, [])

    def test_가져오기_후보는_고른_에이전트를_빼고_지금_에이전트를_넣는다(self):
        plain = self.req("GET", "/api/profiles/importable")[1]["sources"]
        self.assertEqual([s["pod"] for s in plain], ["u"])
        target = self.req("GET", "/api/profiles/importable?target=u")[1]["sources"]
        self.assertEqual([s["pod"] for s in target], ["t"])

    def test_all_1_은_묶음과_줄을_주고_기본_응답은_그대로(self):
        code, out = self.req("GET", "/api/profiles?all=1")
        self.assertEqual(code, 200)
        self.assertEqual([g["pod"] for g in out["groups"]], ["t", "u"])
        self.assertEqual([r["pod"] for r in out["profiles"]], ["t", "u"])
        plain = self.req("GET", "/api/profiles")[1]
        self.assertNotIn("groups", plain)
        self.assertNotIn("pod", plain["profiles"][0])


if __name__ == "__main__":
    unittest.main()

# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""「제한 스킬·템플릿 설치 허용」 — 허용이 필요한 네임스페이스를 한곳에서(스펙 2026-11-18-015)."""
import aasserver  # 실제 uvicorn 앱을 띄우는 시험 하네스(OMAI-1100)
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

TMP = tempfile.TemporaryDirectory()
os.environ.setdefault("AAS_DATA_DIR", str(Path(TMP.name) / "data"))

from aas.common import store  # noqa: E402
from aas.market import marketplace as mk  # noqa: E402
from aas.ops import admin_requests  # noqa: E402
from test_market import fake_fetch  # noqa: E402

PODS = ("g1", "g2")                       # 이 시험만 쓰는 작업공간 id — 공용 데이터 폴더의 다른 시험과 겹치지 않게
COLS = {"slugs": ["paid"], "complete": True}


def wipe():
    with mk._conn() as conn:
        conn.execute("DELETE FROM market_grants WHERE pod IN (?, ?, ?, ?)", (*PODS, mk.ALL_PODS, "gnew"))
    with admin_requests._conn() as conn:
        conn.execute("DELETE FROM admin_requests WHERE pod IN (?, ?)", PODS)


def usage_notes(pod):
    with store.connect() as conn:
        return [r["note"] for r in conn.execute("SELECT note FROM usage WHERE pod=? AND kind='market_grant'", (pod,))]


class GrantLogicTest(unittest.TestCase):
    """판정 한 곳(granted_namespaces)과 쓰기 한 곳(apply_grants)."""
    def setUp(self):
        wipe()
        self.addCleanup(wipe)

    def test_all_pods_row_allows_every_workspace_including_new_ones(self):
        mk.apply_grants("paid", mk.ALL_PODS, True, "admin@x.io")
        self.assertEqual(mk.granted_namespaces("gnew"), {"paid"})                 # 나중에 생긴 작업공간도
        self.assertTrue(mk.allowed("gnew", {"paid": True, "namespace": "paid"}))
        self.assertEqual(mk.allowed_by("gnew", "paid"), "all")

    def test_allowed_by_prefers_all_when_both_rows_exist(self):
        mk.apply_grants("paid", ["g1"], True, "admin@x.io")
        self.assertEqual(mk.allowed_by("g1", "paid"), "pod")
        mk.apply_grants("paid", mk.ALL_PODS, True, "admin@x.io")
        self.assertEqual(mk.allowed_by("g1", "paid"), "all")
        self.assertEqual(mk.allowed_by("g2", "paid"), "all")

    def test_turning_all_off_keeps_rows_granted_one_by_one(self):
        mk.apply_grants("paid", ["g1"], True, "admin@x.io")
        mk.apply_grants("paid", mk.ALL_PODS, True, "admin@x.io")
        out = mk.apply_grants("paid", mk.ALL_PODS, False, "admin@x.io")
        self.assertEqual(out["changed"], ["*"])
        self.assertEqual(mk.granted_namespaces("g1"), {"paid"})
        self.assertEqual(mk.granted_namespaces("g2"), set())

    def test_changed_comes_from_rowcount_so_a_repeat_changes_nothing(self):
        """같은 칸을 두 번 켜면 둘째는 바뀐 것이 없다 — by·ts 도, 사용 기록도 그대로(E1)."""
        first = mk.apply_grants("paid", ["g1", "g1"], True, "a@x.io")
        before = [g for g in mk.grants() if g["pod"] == "g1"]
        second = mk.apply_grants("paid", ["g1"], True, "b@x.io")
        self.assertEqual((first["changed"], second["changed"]), (["g1"], []))
        self.assertEqual([g for g in mk.grants() if g["pod"] == "g1"], before)
        self.assertEqual(len([n for n in usage_notes("g1") if "a@x.io" in n or "b@x.io" in n]), 1)
        self.assertEqual(mk.apply_grants("paid", ["g1"], False, "a@x.io")["changed"], ["g1"])
        self.assertEqual(mk.apply_grants("paid", ["g1"], False, "a@x.io")["changed"], [])

    def test_releasing_a_workspace_under_all_warns(self):
        mk.apply_grants("paid", ["g1"], True, "a@x.io")
        mk.apply_grants("paid", mk.ALL_PODS, True, "a@x.io")
        out = mk.apply_grants("paid", ["g1"], False, "a@x.io")
        self.assertEqual((out["changed"], out.get("warning")), (["g1"], "all_granted"))
        self.assertTrue(mk.allowed("g1", {"paid": True, "namespace": "paid"}))   # 실제 허용은 그대로

    def test_one_failing_cleanup_does_not_stop_the_rest(self):
        """'*' 뒷일 하나가 실패해도 나머지를 하고 실패한 id 를 stale 에(DX 2). 같은 상태 재요청도 뒷일을 다시 돈다."""
        seen = []

        def after(pid):
            seen.append(pid)
            if pid == "g1":
                raise RuntimeError("sidecar down")
        out = mk.apply_grants("paid", mk.ALL_PODS, True, "a@x.io", after=after, every=list(PODS))
        self.assertEqual((out["changed"], out["stale"], seen), (["*"], ["g1"], ["g1", "g2"]))
        again = mk.apply_grants("paid", mk.ALL_PODS, True, "a@x.io", after=lambda pid: seen.append(pid), every=list(PODS))
        self.assertEqual((again["changed"], seen[-2:]), ([], ["g1", "g2"]))

    def test_a_failed_write_changes_no_row(self):
        """여러 행 쓰기는 한 트랜잭션 — 중간에 실패하면 아무 행도 남지 않는다(transaction-semantics)."""
        calls = []
        real = mk._now

        def boom():
            calls.append(1)
            if len(calls) == 2:
                raise RuntimeError("disk")
            return real()
        with mock.patch.object(mk, "_now", boom), self.assertRaises(RuntimeError):
            mk.apply_grants("paid", list(PODS), True, "a@x.io")
        self.assertEqual([g for g in mk.grants() if g["pod"] in PODS], [])

    def test_workspace_delete_removes_its_rows_but_keeps_the_all_row(self):
        from aas.fleet import lifecycle
        mk.apply_grants("paid", ["g1"], True, "a@x.io")
        mk.apply_grants("paid", mk.ALL_PODS, True, "a@x.io")
        lifecycle.cascade("g1")
        pods = {g["pod"] for g in mk.grants()}
        self.assertNotIn("g1", pods)
        self.assertIn(mk.ALL_PODS, pods)

    def test_overview_marks_packages_allowed_under_all(self):
        mk.apply_grants("paid", mk.ALL_PODS, True, "a@x.io")
        cat = {"items": [{"id": "paid/hello", "namespace": "paid", "name": "hello", "version": "0.1.0", "paid": True}], "error": ""}
        out = mk.overview("g2", {"url": "http://hub", "token_file": "", "namespaces": ["free", "paid"], "readonly": []}, cat)
        self.assertTrue(out["packages"][0]["allowed"])
        self.assertEqual(out["grants"], [])                                         # 작업공간 행만 — 화면은 allowed 를 쓴다

    def test_check_codes(self):
        known = set(PODS)

        def code(namespace="paid", pods=("g1",), allow=True, cols=COLS):
            with self.assertRaises(mk.GrantError) as ctx:
                mk.check_grants(namespace, list(pods) if isinstance(pods, tuple) else pods, allow, known, cols)
            return ctx.exception.reason, ctx.exception.extra
        self.assertEqual(code(allow=None)[0], "allow_required")
        self.assertEqual(code(allow="false")[0], "allow_required")
        self.assertEqual(code(pods=[])[0], "pods_invalid")
        self.assertEqual(code(pods="g1")[0], "pods_invalid")
        self.assertEqual(code(pods=[f"x{i}" for i in range(201)]), ("too_many_pods", {"limit": 200}))
        self.assertEqual(code(pods=["g1", "ghost"]), ("unknown_pods", {"pods": ["ghost"]}))
        self.assertEqual(code(pods=["*"])[0], "unknown_pods")                       # 배열 안의 "*" 는 작업공간이 아니다(E4)
        self.assertEqual(code(namespace="free")[0], "namespace_not_restricted")
        self.assertEqual(code(namespace="Bad Name!", allow=False)[0], "namespace_not_restricted")   # 해제에도 이름 검사(E5)
        incomplete = {"slugs": ["paid"], "complete": False}
        self.assertEqual(code(namespace="community", cols=incomplete)[0], "hub_unreachable")
        self.assertEqual(mk.check_grants("restricted", ["g1", "g1"], True, known, COLS), ("paid", ["g1"]))   # 표시 이름·중복
        self.assertEqual(mk.check_grants("free", mk.ALL_PODS, False, known, COLS), ("free", "*"))          # 해제는 열과 상관없이

    def test_restricted_namespaces(self):
        cfg = {"url": "http://hub", "token_file": "", "namespaces": ["free", "paid"], "readonly": ["community"]}
        cat = {"ok": True, "items": [{"namespace": "free", "paid": True}, {"namespace": "community", "paid": False}]}
        self.assertEqual(mk.restricted_namespaces(cfg, cat), {"slugs": ["paid", "free"], "complete": True})   # 공개가 아닌 패키지가 생긴 free
        self.assertEqual(mk.restricted_namespaces(cfg, {"ok": False, "items": []}), {"slugs": ["paid"], "complete": False})
        mk.apply_grants("community", ["g1"], True, "a@x.io")                        # 허용 행이 남은 구역도 열에(끌 수 있게)
        self.assertIn("community", mk.restricted_namespaces(cfg, cat)["slugs"])

    def test_close_namespace_grant_only_closes_that_zone(self):
        a = admin_requests.create("g1", admin_requests.WORKSPACE, "kim@x.io", "namespace_grant", "ns=paid 템플릿을 쓰고 싶어요")
        b = admin_requests.create("g2", admin_requests.WORKSPACE, "lee@x.io", "namespace_grant", "ns=other")
        self.assertEqual(admin_requests.close_namespace_grant(list(PODS), "paid"), 1)
        with admin_requests._conn() as conn:
            got = {r[0]: (r[1], r[2]) for r in conn.execute("SELECT id, status, reason FROM admin_requests WHERE id IN (?, ?)", (a, b))}
        self.assertEqual(got, {a: ("handled", "grant:paid"), b: ("pending", None)})


class GrantRouteTest(unittest.TestCase):
    """GET·POST /api/market/grants 와 옛 /api/market/grant — 로그인을 끈 시험 서버(관리자), 필요하면 로그인을 켜 권한을 본다."""
    @classmethod
    def setUpClass(cls):
        from aas.auth import auth
        from aas.fleet import pods
        from aas.web import server
        cls.server, cls.old_env = server, {k: os.environ.get(k) for k in ("AAS_ALLOWED_HOSTS", "AAS_SKILLHUB_URL")}
        os.environ.pop("AAS_ALLOWED_HOSTS", None)
        os.environ["AAS_SKILLHUB_URL"] = "http://hub"
        reg = Path(TMP.name) / "grant-pods.json"
        rows = []
        for pid in PODS:
            home = Path(TMP.name) / f"grant-{pid}"
            (home / "profiles").mkdir(parents=True, exist_ok=True)
            rows.append({"id": pid, "owner": f"{pid}@example.com", "hermes_home": str(home), "container": "hermes-agent"})
        reg.write_text(json.dumps({"pods": rows}))
        server._auth = auth.Auth({"issuer": "https://accounts.google.com", "client_id": "", "client_secret": "", "domain": "", "public_url": "http://localhost:17900",
                                  "hours": 1, "users_file": Path(TMP.name) / "no-users.json"})
        server._registry = pods.Registry(reg)
        cls.old = (mk.fetch, server.HermesAPI.call)
        mk.fetch = fake_fetch
        server.HermesAPI.call = lambda self, method, path, body=None, query=None: {"profiles": [{"name": "default"}, {"name": "ma"}]}
        server._forget_market_catalog()
        cls.httpd = aasserver.start()

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        mk.fetch, cls.server.HermesAPI.call = cls.old
        cls.server._auth = cls.server._registry = None
        cls.server._forget_market_catalog()
        for k, v in cls.old_env.items():
            os.environ.pop(k, None) if v is None else os.environ.__setitem__(k, v)

    def setUp(self):
        wipe()
        self.addCleanup(wipe)
        for d in ("queue", "done"):
            for p in mk._dir(d).glob("*.json"):
                if json.loads(p.read_text()).get("pod") in PODS:
                    p.unlink()

    def call(self, method, path, body=None, headers=None):
        import http.client
        c = http.client.HTTPConnection("127.0.0.1", self.httpd.server_port, timeout=5)
        c.request(method, path, json.dumps(body) if body is not None else None, {"Content-Type": "application/json", "X-AAS": "1", **(headers or {})})
        r = c.getresponse()
        return r.status, json.loads(r.read() or b"{}")

    def as_user(self, email, admin):
        reg = self.server._registry
        old = (self.server._auth, reg.is_admin)

        class On:
            enabled = True
            def user(self, cookie): return {"email": email, "name": ""}
        self.server._auth = On()
        reg.is_admin = lambda u: admin
        self.addCleanup(lambda: (setattr(self.server, "_auth", old[0]), setattr(reg, "is_admin", old[1])))

    def test_view_lists_columns_workspaces_and_rows(self):
        self.call("POST", "/api/market/grants", {"namespace": "paid", "pods": ["g2"], "allow": True})
        code, out = self.call("GET", "/api/market/grants", headers={"Accept-Language": "ko"})
        self.assertEqual(code, 200)
        self.assertEqual(out["namespaces"], [{"slug": "paid", "label": "제한", "packages": 1, "items": [{"name": "hello", "kind": "skill", "summary": "요약"}]}])
        self.assertEqual([p["id"] for p in out["pods"]], list(PODS))
        g2 = next(p for p in out["pods"] if p["id"] == "g2")
        self.assertEqual(set(g2["grants"]), {"paid"})
        self.assertEqual((out["all"], out["limit"]), ({}, 200))
        self.assertNotIn("error", out)

    def test_view_marks_templates_among_the_zone_packages(self):
        """구역 요약을 펼치면 보이는 목록: 스킬 허브 카드와 같은 판별로 템플릿을 가린다(2026-11-18 사용자 — 무엇이 제한인지 몰랐다)."""
        with mock.patch.object(self.server.market_templates, "listing", lambda items, cfg=None: {"items": [{"namespace": "paid", "name": "hello"}], "failed": 0}):
            out = self.call("GET", "/api/market/grants")[1]
        self.assertEqual(out["namespaces"][0]["items"], [{"name": "hello", "kind": "template", "summary": "요약"}])

    def test_post_writes_to_body_workspaces_not_the_cookie_one(self):
        code, out = self.call("POST", "/api/market/grants", {"namespace": "restricted", "pods": ["g2"], "allow": True})
        self.assertEqual((code, out["changed"], out["stale"]), (200, ["g2"], []))
        self.assertEqual(mk.granted_namespaces("g1"), set())
        self.assertEqual(mk.granted_namespaces("g2"), {"paid"})

    def test_all_grant_lets_the_cookie_workspace_install_and_list(self):
        """전체 허용만 있을 때 설치 요청·목록·서랍·템플릿 목록 모두 허용(X1). 설치 요청은 MCP·템플릿 설치도 같은 request_install 을 거친다."""
        ask = {"namespace": "paid", "name": "hello", "profile": "ma"}
        self.assertEqual(self.call("POST", "/api/market/install", ask)[0], 403)
        code, out = self.call("POST", "/api/market/grants", {"namespace": "paid", "pods": "*", "allow": True})
        self.assertEqual((code, out["changed"]), (200, ["*"]))
        listed = self.call("GET", "/api/market")[1]["packages"]
        self.assertTrue(next(p for p in listed if p["id"] == "paid/hello")["allowed"])
        one = self.call("GET", "/api/market/package?ns=paid&name=hello")[1]
        self.assertEqual((one["allowed"], one["allowed_by"]), (True, "all"))
        self.assertEqual(self.call("POST", "/api/market/install", ask)[0], 200)
        self.assertEqual(self.call("POST", "/api/market/grants", {"namespace": "paid", "pods": "*", "allow": True})[1]["changed"], [])

    def test_errors_carry_codes(self):
        cases = [({"namespace": "paid", "pods": ["g1"]}, "allow_required"),
                 ({"namespace": "paid", "pods": [], "allow": True}, "pods_invalid"),
                 ({"namespace": "paid", "pods": ["ghost"], "allow": True}, "unknown_pods"),
                 ({"namespace": "free", "pods": ["g1"], "allow": True}, "namespace_not_restricted")]
        for body, want in cases:
            code, out = self.call("POST", "/api/market/grants", body)
            self.assertEqual((code, out.get("code")), (400, want), body)
        self.assertEqual(self.call("POST", "/api/market/grants", {"namespace": "paid", "pods": ["ghost"], "allow": True})[1]["pods"], ["ghost"])
        self.assertEqual(mk.grants() and [g for g in mk.grants() if g["pod"] in PODS], [])

    def test_old_route_rejects_string_false_and_free(self):
        """옛 /api/market/grant 는 bool() 로 "false" 가 허용이 됐다 — 이제 400(DX 4). free 허용도 400(E8)."""
        code, out = self.call("POST", "/api/market/grant", {"namespace": "paid", "allow": "false"})
        self.assertEqual((code, out.get("code")), (400, "allow_required"))
        self.assertEqual(self.call("POST", "/api/market/grant", {"namespace": "free", "allow": True})[1].get("code"), "namespace_not_restricted")
        self.assertEqual(mk.granted_namespaces("g1"), set())
        self.assertEqual(self.call("POST", "/api/market/grant", {"namespace": "paid", "allow": True}), (200, {"ok": True}))
        self.assertEqual(mk.granted_namespaces("g1"), {"paid"})
        self.assertTrue(any("→ 허용" in n for n in usage_notes("g1")))

    def test_only_admins(self):
        """팀 관리자·주인도 403 — may_use_market 는 경로 이름이 /api/market/grant 일 때만 관리자 전용이다."""
        self.as_user("g1@example.com", False)
        self.assertEqual(self.call("GET", "/api/market/grants")[0], 403)
        self.assertEqual(self.call("POST", "/api/market/grants", {"namespace": "paid", "pods": ["g1"], "allow": True})[0], 403)
        self.assertEqual(mk.granted_namespaces("g1"), set())

    def test_owner_request_closes_when_an_admin_allows_the_zone(self):
        """X2: 주인이 「관리자에게 허용 요청」(프로파일 없이) → 관리자가 전체 허용 → 요청이 닫힌다."""
        self.as_user("g1@example.com", False)
        code, out = self.call("POST", "/api/requests", {"kind": "namespace_grant", "namespace": "restricted", "detail": "템플릿을 쓰고 싶어요"})
        self.assertEqual(code, 200, out)
        self.assertEqual(self.call("POST", "/api/requests", {"kind": "namespace_grant", "namespace": "paid"})[0], 409)   # 대기 중 하나만
        self.server._registry.is_admin = lambda u: True
        self.assertEqual(self.call("POST", "/api/market/grants", {"namespace": "paid", "pods": "*", "allow": True})[0], 200)
        with admin_requests._conn() as conn:
            row = conn.execute("SELECT status, reason, detail FROM admin_requests WHERE id=?", (out["id"],)).fetchone()
        self.assertEqual(tuple(row), ("handled", "grant:paid", "ns=paid 템플릿을 쓰고 싶어요"))
        shown = self.server._grant_request_text({"req_kind": "namespace_grant", "text": row[2], "reason": row[1]})
        self.assertEqual((shown["namespace"], shown["text"], shown["reason"]), ("paid", "'제한' 스킬·템플릿 설치 허용 요청 — 템플릿을 쓰고 싶어요", "관리자가 '제한' 을 허용했습니다"))


if __name__ == "__main__":
    unittest.main()

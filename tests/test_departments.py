# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""회사의 부서 목록 시험(스펙 2026-10-15-026, OMAI-1242).

- StoreTest: aas.common.settings 의 부서 목록(만들기·정규화·동시성·캐시·처음 옮기기·이름 바꾸기 단계·삭제·슬로건 자동 등록)
- ApiTest: 실제 AAS 서버 + 가짜 OIDC 공급자(FakeIdP) + 가짜 Keycloak 관리 API(kcfake). 소속 판정은 Keycloak 목록 기준(R1),
  쓰기 검증은 캐시가 아니라 DB(R3/D6), 이름 바꾸기 부분 실패와 재시도(6절), 회귀 5+1(R4)
"""
import aasserver  # 실제 uvicorn 앱을 띄우는 시험 하네스
import http.client
import json
import os
import tempfile
import threading
import time
import unittest
from http.server import ThreadingHTTPServer
from pathlib import Path
from unittest import mock
from urllib.parse import parse_qs, urlsplit

import test_auth as TA

TMP = tempfile.TemporaryDirectory()
os.environ["AAS_DATA_DIR"] = str(Path(TMP.name) / "data")

from aas.common import settings, store  # noqa: E402
from aas.office import office  # noqa: E402


def clear():
    with store.connect() as conn:
        for ddl in (settings.GOAL_SCHEMA, settings._SCHEMA, settings.DEPT_SCHEMA):
            conn.execute(ddl)
        for t in ("department_goals", "user_directory", "departments"):
            conn.execute(f"DELETE FROM {t}")
        conn.execute("DELETE FROM meta WHERE key LIKE 'departments_seeded' OR key LIKE 'rename_pending:%'")
    with office.connect() as conn:
        conn.execute("DELETE FROM office_seats")
    settings.reset_cache()


def sql(query, *params):
    with store.connect() as conn:
        conn.execute(query, params)
    settings.reset_cache()


class StoreTest(unittest.TestCase):
    def setUp(self):
        clear()

    # ---- 만들기·정규화·동시성 ----
    def test_create_cleans_spaces_and_refuses_the_same_team_key(self):
        self.assertEqual(settings.create_department("  개발   팀 ", "a@x.com"), "개발 팀")
        with self.assertRaises(settings.DepartmentError) as e:
            settings.create_department("개발 팀")
        self.assertEqual(e.exception.code, "exists")
        settings.create_department("Dev Team")
        with self.assertRaises(settings.DepartmentError):
            settings.create_department("dev  team")                          # 띄어쓰기·대소문자만 다른 것은 같은 부서
        with self.assertRaises(settings.DepartmentError) as e:
            settings.create_department("   ")
        self.assertEqual(e.exception.code, "empty")
        self.assertEqual([r["name"] for r in settings.department_rows()], ["Dev Team", "개발 팀"])

    def test_the_same_key_created_at_once_makes_one_row_and_one_winner(self):
        wins = []
        gate = threading.Barrier(8)

        def go(i):
            gate.wait()
            wins.append(settings.ensure_department(f"동시 {'  ' * (i % 2)}부서", f"u{i}")[1])

        threads = [threading.Thread(target=go, args=(i,)) for i in range(8)]
        [t.start() for t in threads]
        [t.join() for t in threads]
        self.assertEqual(sum(wins), 1)                                         # 새로 더한 쪽은 하나뿐(두 번째는 500 이 아니라 exists)
        self.assertEqual(len(settings.department_rows()), 1)

    # ---- 캐시: 읽기 화면만 쓰고 쓰기 검증은 쓰지 않는다 ----
    def test_write_validation_reads_the_db_while_the_list_is_cached(self):
        settings.create_department("개발")
        self.assertEqual([r["name"] for r in settings.department_rows()], ["개발"])      # 목록 캐시를 채운다
        with store.connect() as conn:                                                    # 다른 복제본이 지운 것을 흉내: 이 프로세스 캐시는 그대로
            conn.execute("DELETE FROM departments")
        self.assertEqual([r["name"] for r in settings.department_rows()], ["개발"])      # 읽기 화면은 TTL 동안 옛 값(알려진 한계)
        self.assertFalse(settings.department_exists("개발"))                              # 쓰기 검증은 즉시 알아본다
        self.assertIsNone(settings.listed_name("개발"))
        with store.connect() as conn:                                                    # 다른 복제본이 방금 만든 것도 바로 통과한다
            conn.execute("INSERT INTO departments (team_key, name, by, ts) VALUES ('영업','영업','x','t')")
        self.assertEqual(settings.listed_name(" 영업 "), "영업")

    def test_the_person_to_department_map_is_cached_five_seconds_and_cleared_by_set_department(self):
        settings.set_department("a@x.com", "개발")
        self.assertEqual(settings.departments(), {"a@x.com": "개발"})
        with store.connect() as conn:
            conn.execute("UPDATE user_directory SET department='영업'")
        self.assertEqual(settings.departments(), {"a@x.com": "개발"})                    # TTL 안에서는 캐시
        now = time.monotonic()
        with mock.patch.object(settings.time, "monotonic", return_value=now + settings.MAP_TTL + 1):
            self.assertEqual(settings.departments(), {"a@x.com": "영업"})                # TTL 이 지나면 다시 읽는다
        settings.set_department("a@x.com", "기획")
        self.assertEqual(settings.departments(), {"a@x.com": "기획"})                    # 쓰기가 비운다

    def test_the_returned_map_is_a_copy(self):
        settings.set_department("a@x.com", "개발")
        settings.departments()["a@x.com"] = "망가짐"
        self.assertEqual(settings.departments()["a@x.com"], "개발")

    # ---- 처음 옮기기 ----
    def test_seed_merges_every_source_picks_the_most_used_spelling_and_breaks_ties_by_order(self):
        for i, d in enumerate(["개발 팀", "개발 팀", "개발  팀 ", "Sales", "sales"]):
            settings.set_department(f"u{i}@x.com", d)
        settings.set_goal("기획", "문구", "a")
        with office.connect() as conn:
            conn.execute("INSERT INTO office_seats (alias, pod, profile, enabled, title, team, team_src, by, ts) VALUES ('s','p','x',1,'','운영','dept','t','t')")
            conn.execute("INSERT INTO office_seats (alias, pod, profile, enabled, title, team, team_src, by, ts) VALUES ('t','p','y',1,'','손으로 정한 팀','','t','t')")
        added = settings.ensure_seeded(["키클록만 있는 부서", "개발 팀"], final=True)
        names = sorted(r["name"] for r in settings.department_rows())
        self.assertEqual(names, ["Sales", "개발 팀", "기획", "운영", "키클록만 있는 부서"])      # 「개발 팀」 은 가장 많이 쓴 표기, 「Sales」 는 동률이라 앞선 표기
        self.assertNotIn("손으로 정한 팀", names)                                            # 사람이 정한 팀은 부서가 아니다
        self.assertGreaterEqual(added, 1)
        self.assertTrue(settings.seeded())

    def test_seed_without_keycloak_does_not_leave_the_done_mark_and_is_idempotent(self):
        settings.set_department("a@x.com", "개발")
        settings.ensure_seeded(None, final=False)
        self.assertFalse(settings.seeded())                                                # Keycloak 에 닿지 않았으면 표시를 남기지 않는다
        settings.ensure_seeded(["영업"], final=True)                                        # 다음에 Keycloak 이 닿으면 다시 하고 표시를 남긴다
        self.assertTrue(settings.seeded())
        self.assertEqual(settings.ensure_seeded(["영업"], final=True), 0)                   # 표시가 있으면 더하지 않는다
        self.assertEqual(sorted(r["name"] for r in settings.department_rows()), ["개발", "영업"])

    def test_seed_runs_even_after_set_goal_registered_a_row_first(self):
        settings.set_department("a@x.com", "개발")
        settings.set_goal("먼저", "문구", "a")                                              # set_goal 이 목록에 행을 먼저 넣는다
        settings.ensure_seeded(["영업"], final=True)
        self.assertEqual(sorted(r["name"] for r in settings.department_rows()), ["개발", "먼저", "영업"])   # 「표가 비면」이 기준이면 건너뛰어졌을 것

    def test_seeding_twice_at_once_gives_the_same_result(self):
        settings.set_department("a@x.com", "개발")
        threads = [threading.Thread(target=settings.ensure_seeded, args=(["영업"], True)) for _ in range(4)]
        [t.start() for t in threads]
        [t.join() for t in threads]
        self.assertEqual(sorted(r["name"] for r in settings.department_rows()), ["개발", "영업"])

    # ---- 슬로건 자동 등록(R2) ----
    def test_saving_a_goal_registers_the_department_once_and_clearing_it_keeps_the_department(self):
        settings.ensure_seeded(None, final=True)
        settings.set_goal("새 부서", "문구", "a")
        settings.set_goal("새  부서", "다른 문구", "a")                                       # 같은 team_key 는 중복 등록하지 않는다
        self.assertEqual([r["name"] for r in settings.department_rows()], ["새 부서"])
        settings.set_goal("새 부서", "", "a")                                               # 비워 지워도 부서는 남는다
        self.assertEqual([(r["name"], r["goal"]) for r in settings.department_rows()], [("새 부서", "")])
        settings.set_goal("없는데 비움", "", "a")                                            # 문구가 없으면 등록하지 않는다
        self.assertFalse(settings.department_exists("없는데 비움"))

    # ---- 이름 바꾸기 단계 ----
    def test_rename_registers_the_new_name_first_keeps_the_old_one_and_finish_moves_everything(self):
        settings.create_department("개발팀")
        settings.set_goal("개발팀", "문구", "a")
        settings.set_department("a@x.com", "개발팀")
        settings.rename_register("개발팀", "개발본부", "root")
        self.assertEqual(sorted(r["name"] for r in settings.department_rows()), ["개발본부", "개발팀"])      # 두 이름이 모두 목록에 있다
        settings.rename_finish("개발팀", "개발본부")
        self.assertEqual([(r["name"], r["goal"]) for r in settings.department_rows()], [("개발본부", "문구")])
        self.assertEqual(settings.departments(), {"a@x.com": "개발본부"})
        with store.connect() as conn:
            self.assertIsNone(conn.execute("SELECT 1 FROM meta WHERE key LIKE 'rename_pending:%'").fetchone())

    def test_rename_that_only_changes_spacing_or_case_changes_the_name_and_is_not_a_conflict(self):
        settings.create_department("dev")
        self.assertEqual(settings.rename_register("dev", "Dev", "root"), "Dev")
        settings.rename_finish("dev", "Dev")
        self.assertEqual([r["name"] for r in settings.department_rows()], ["Dev"])

    def test_rename_into_another_listed_department_is_a_conflict_but_a_retry_of_the_same_rename_goes_on(self):
        settings.create_department("A")
        settings.create_department("B")
        with self.assertRaises(settings.DepartmentError) as e:
            settings.rename_register("A", "B", "root")
        self.assertEqual(e.exception.code, "exists")
        settings.rename_register("A", "C", "root")                                         # 부분 실패로 끝났다고 하자
        self.assertEqual(settings.rename_register("A", "C", "root"), "C")                   # 같은 요청을 다시 보내면 이어서 한다
        with self.assertRaises(settings.DepartmentError):
            settings.rename_register("B", "C", "root")                                      # 다른 부서가 그 이름으로 바꾸려 하면 겹침

    def test_rename_of_an_unlisted_department_adds_the_new_name_or_merges_into_an_existing_one(self):
        settings.create_department("기존")
        self.assertEqual(settings.rename_register("목록밖", "기존", "root"), "기존")        # 합치기: 겹침이 아니다
        self.assertEqual(settings.rename_register("목록밖2", "새로", "root"), "새로")
        self.assertEqual(sorted(r["name"] for r in settings.department_rows()), ["기존", "새로"])

    def test_delete_removes_the_department_and_its_goal(self):
        settings.create_department("영업")
        settings.set_goal("영업", "문구", "a")
        self.assertTrue(settings.delete_department("영업"))
        self.assertFalse(settings.delete_department("영업"))
        self.assertEqual((settings.department_rows(), settings.goals()), ([], {}))

    # ---- 회귀(R4): claim 의 목록 밖 부서는 막지 않는다 ----
    def test_a_login_claim_outside_the_list_is_still_saved_and_still_drives_the_office_team(self):
        settings.create_department("목록에 있는 부서")
        settings.set_department("x@x.com", "목록 밖 부서")
        self.assertEqual(settings.departments()["x@x.com"], "목록 밖 부서")
        with office.connect() as conn:
            conn.execute("INSERT INTO office_seats (alias, pod, profile, enabled, title, team, team_src, by, ts) VALUES ('s','p','x',1,'','','','t','t')")
        self.assertEqual(office.default_teams({"p": "x@x.com"}, settings.departments()), ["s"])
        with office.connect() as conn:
            self.assertEqual(conn.execute("SELECT team FROM office_seats WHERE alias='s'").fetchone()["team"], "목록 밖 부서")


class ApiTest(unittest.TestCase):
    """Keycloak 방식 서버(가짜 Keycloak). TA.KeycloakUsersTest 의 틀을 필요한 만큼만 쓴다."""

    @classmethod
    def setUpClass(cls):
        import kcfake
        from aas.auth import auth
        from aas.fleet import pods
        from aas.web import server
        cls.kcfake, cls.K = kcfake, kcfake.FakeKC
        cls.idp = TA.start(ThreadingHTTPServer(("127.0.0.1", 0), TA.FakeIdP))
        cls.issuer = f"http://127.0.0.1:{cls.idp.server_port}"
        cls.kc_httpd, cls.kc_issuer = kcfake.start()
        root = Path(TMP.name) / "deptapi"
        (root / "home_a" / "profiles").mkdir(parents=True, exist_ok=True)
        reg = root / "pods.json"
        reg.write_text(json.dumps({"admins": ["root@corp.example"], "pods": [
            {"id": "ka", "owner": "alice@corp.example", "hermes_home": str(root / "home_a")}]}))
        cls.app = aasserver.start()
        cls.port = cls.app.server_port
        cls.server = server
        cls.old = (server._auth, server._registry)
        server._auth = auth.Auth({"issuer": cls.issuer, "client_id": "cid", "client_secret": "sec", "domain": "corp.example",
                                  "users_group": "", "admin_role": "aas-admin",
                                  "public_url": f"http://127.0.0.1:{cls.port}", "hours": 1})
        server._registry = pods.Registry(reg)
        cls.kc_patch = mock.patch.object(server, "_kc_admin", lambda: kcfake.admin(cls.kc_issuer))
        cls.kc_patch.start()

    @classmethod
    def tearDownClass(cls):
        cls.kc_patch.stop()
        cls.idp.shutdown(); cls.app.shutdown(); cls.kc_httpd.shutdown()
        cls.server._auth, cls.server._registry = cls.old

    def setUp(self):
        clear()
        K = self.K
        K.reset()
        K.add("kc-kim", "kim", "kim@corp.example", groups=["g-admins"], firstName="민수", lastName="김")
        K.add("kc-lee", "lee", "lee@corp.example", groups=["g-users"], attributes={"department": ["영업팀"]}, firstName="영희", lastName="이")
        K.add("kc-new", "newbie", "newbie@corp.example", groups=["g-users"], attributes={"department": ["영업팀"]}, firstName="철수", lastName="박")   # 로그인한 적 없다
        K.add("kc-dev", "dev1", "dev1@corp.example", groups=["g-users"], attributes={"department": ["개발팀"]})
        K.add("kc-sa", "service-account-aas-admin", "", serviceAccountClientId="aas-admin")
        self.kim = self.login("kim@corp.example", "kc-kim", admin=True)
        self.lee = self.login("lee@corp.example", "kc-lee")

    def tearDown(self):
        reg = self.server._registry
        for e in ("kim@corp.example", "lee@corp.example", "hong@corp.example", "newbie@corp.example", "dev1@corp.example"):
            reg.grant(e, "none", [], "test")

    def req(self, method, path, cookie="", body=None):
        c = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        h = {"Cookie": cookie} if cookie else {}
        if method != "GET":
            h["X-AAS"] = "1"
        c.request(method, path, body=json.dumps(body) if body is not None else None, headers=h)
        r = c.getresponse()
        data = r.read()
        c.close()
        return r.status, (json.loads(data) if data else {})

    def login(self, email, sub, admin=False):
        r, _ = self.req_raw("/auth/oidc")
        q = parse_qs(urlsplit(r.getheader("Location")).query)
        TA.FakeIdP.claims = {"iss": self.issuer, "aud": "cid", "exp": time.time() + 300, "nonce": q["nonce"][0], "sub": sub,
                             "email": email, "email_verified": True, "name": "N",
                             **({"realm_access": {"roles": ["aas-admin"]}} if admin else {})}
        r, _ = self.req_raw(f"/auth/callback?code=abc&state={q['state'][0]}")
        return r.getheader("Set-Cookie").split(";")[0]

    def req_raw(self, path, cookie=""):
        c = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        c.request("GET", path, headers={"Cookie": cookie} if cookie else {})
        r = c.getresponse()
        body = r.read()
        c.close()
        return r, body

    def names(self):
        code, out = self.req("GET", "/api/departments", self.kim)
        self.assertEqual(code, 200, out)
        return sorted(d["name"] for d in out["departments"])

    # ---- 목록 ----
    def test_the_list_is_admin_only_and_is_seeded_from_keycloak_including_people_who_never_logged_in(self):
        self.assertEqual(self.req("GET", "/api/departments", self.lee)[0], 403)
        self.assertEqual(self.names(), ["개발팀", "영업팀"])                                  # newbie(로그인한 적 없음)·dev1 의 부서도 들어온다
        self.assertTrue(settings.seeded())

    def test_when_keycloak_is_unreachable_the_seed_leaves_no_done_mark_and_runs_again_later(self):
        self.K.fail = {("GET", r"/admin/realms/aas/users"): 500}
        code, out = self.req("GET", "/api/departments", self.kim)
        self.assertEqual(code, 200)
        self.assertFalse(settings.seeded())
        self.K.fail = {}
        self.assertEqual(self.names(), ["개발팀", "영업팀"])
        self.assertTrue(settings.seeded())

    # ---- 만들기·삭제 ----
    def test_create_conflicts_and_delete_is_blocked_by_people_known_only_to_keycloak(self):
        self.names()
        self.assertEqual(self.req("POST", "/api/departments/create", self.kim, {"name": "기획"})[0], 200)
        code, out = self.req("POST", "/api/departments/create", self.kim, {"name": " 기획 "})
        self.assertEqual((code, out["field"]), (409, "name"))                              # 같은 이름은 500 이 아니라 409
        self.assertEqual(self.req("POST", "/api/departments/create", self.kim, {"name": ""})[0], 400)
        self.assertEqual(self.req("POST", "/api/departments/create", self.lee, {"name": "x"})[0], 403)
        # 영업팀 사람은 둘이고 newbie 는 user_directory 에 없다 — 둘 다 센다(R1)
        code, out = self.req("POST", "/api/departments/delete", self.kim, {"name": "영업팀"})
        self.assertEqual((code, out["people"]), (409, 2))
        self.assertTrue(settings.department_exists("영업팀"))
        self.assertEqual(self.req("POST", "/api/departments/delete", self.kim, {"name": "기획"})[0], 200)   # 사람이 없으면 지워진다
        self.assertEqual(self.req("POST", "/api/departments/delete", self.kim, {"name": "기획"})[0], 404)

    def test_delete_and_rename_stop_with_503_when_keycloak_cannot_be_reached_but_listing_and_creating_still_work(self):
        self.names()
        self.K.fail = {("GET", r"/admin/realms/aas/users"): 500}
        self.assertEqual(self.req("POST", "/api/departments/delete", self.kim, {"name": "개발팀"})[0], 503)
        self.assertEqual(self.req("POST", "/api/departments/rename", self.kim, {"name": "개발팀", "new_name": "개발본부"})[0], 503)
        self.assertTrue(settings.department_exists("개발팀"))
        self.assertEqual(self.req("POST", "/api/departments/create", self.kim, {"name": "기획"})[0], 200)
        self.assertEqual(self.req("GET", "/api/departments", self.kim)[0], 200)

    # ---- 이름 바꾸기 ----
    def test_rename_changes_every_keycloak_user_including_those_who_never_logged_in(self):
        self.names()
        settings.set_department("lee@corp.example", "영업팀")
        code, out = self.req("POST", "/api/departments/rename", self.kim, {"name": "영업팀", "new_name": "영업본부"})
        self.assertEqual((code, out["changed"], out["total"], out.get("partial")), (200, 2, 2, None), out)
        for uid in ("kc-lee", "kc-new"):
            self.assertEqual(self.K.users[uid]["attributes"]["department"], ["영업본부"])     # 로그인한 적 없는 newbie 까지
        self.assertEqual(settings.departments().get("lee@corp.example"), "영업본부")
        self.assertEqual(self.names(), ["개발팀", "영업본부"])                                # 옛 이름은 마지막에 지워진다

    def test_rename_that_only_changes_case_is_not_a_conflict(self):
        self.req("POST", "/api/departments/create", self.kim, {"name": "dev"})
        code, out = self.req("POST", "/api/departments/rename", self.kim, {"name": "dev", "new_name": "Dev"})
        self.assertEqual((code, out["name"]), (200, "Dev"))

    def test_rename_into_another_listed_department_is_409_and_an_unlisted_one_merges(self):
        self.names()
        code, out = self.req("POST", "/api/departments/rename", self.kim, {"name": "영업팀", "new_name": "개발팀"})
        self.assertEqual((code, out["field"]), (409, "new_name"))
        self.K.add("kc-odd", "odd", "odd@corp.example", groups=["g-users"], attributes={"department": ["영업 팀(오타)"]})
        code, out = self.req("POST", "/api/departments/rename", self.kim, {"name": "영업 팀(오타)", "new_name": "영업팀"})   # 목록 밖 → 기존 부서에 합친다
        self.assertEqual((code, out["changed"]), (200, 1), out)
        self.assertEqual(self.K.users["kc-odd"]["attributes"]["department"], ["영업팀"])
        self.assertEqual(self.req("POST", "/api/departments/rename", self.kim, {"name": "아무도 없는 부서", "new_name": "x"})[0], 404)

    def test_a_partial_failure_keeps_both_names_and_a_retry_finishes_the_rest(self):
        self.names()
        self.K.fail = {("PUT", r"/admin/realms/aas/users/kc-new"): 500}
        code, out = self.req("POST", "/api/departments/rename", self.kim, {"name": "영업팀", "new_name": "영업본부"})
        self.assertEqual((code, out["partial"], out["changed"], out["total"]), (200, True, 1, 2), out)
        self.assertEqual([f["username"] for f in out["failed"]], ["newbie"])
        self.assertEqual(self.names(), ["개발팀", "영업본부", "영업팀"])                      # 어느 사용자도 목록 밖 부서가 되지 않는다
        self.K.fail = {}
        code, out = self.req("POST", "/api/departments/rename", self.kim, {"name": "영업팀", "new_name": "영업본부"})   # 같은 요청을 다시 보낸다
        self.assertEqual((code, out.get("partial"), out["changed"], out["total"]), (200, None, 1, 1), out)   # 이미 새 이름인 사람은 건너뛴다
        self.assertEqual(self.names(), ["개발팀", "영업본부"])
        self.assertEqual(self.K.users["kc-new"]["attributes"]["department"], ["영업본부"])

    def test_a_401_on_one_user_gets_a_fresh_admin_token_and_one_more_try(self):
        self.names()
        calls = []
        real = self.kcfake.admin(self.kc_issuer).__class__.update_user

        def flaky(inst, uid, changes, token=None):
            calls.append(uid)
            if uid == "kc-new" and calls.count(uid) == 1:
                raise self.server.keycloak.KeycloakError("expired", 401)
            return real(inst, uid, changes, token)

        with mock.patch.object(self.server.keycloak.KeycloakAdmin, "update_user", flaky):
            code, out = self.req("POST", "/api/departments/rename", self.kim, {"name": "영업팀", "new_name": "영업본부"})
        self.assertEqual((code, out["changed"], out.get("partial")), (200, 2, None), out)
        self.assertEqual(calls.count("kc-new"), 2)

    # ---- 사용자 추가·수정의 목록 대조(D2) ----
    BASE = {"username": "hong", "email": "hong@corp.example", "first_name": "길동", "last_name": "홍", "role": "user", "pods": [],
            "password": "Temp-pass-1", "create_agent": False}

    def test_create_refuses_a_department_outside_the_list_and_stores_the_listed_spelling(self):
        self.req("POST", "/api/departments/create", self.kim, {"name": "개발 본부"})
        code, out = self.req("POST", "/api/users/create", self.kim, {**self.BASE, "department": "목록에 없는 부서"})
        self.assertEqual((code, out["field"]), (400, "department"))
        self.assertEqual([u for u in self.K.users.values() if u["username"] == "hong"], [])   # 계정도 만들지 않는다
        code, out = self.req("POST", "/api/users/create", self.kim, {**self.BASE, "department": " 개발   본부 "})
        self.assertEqual(code, 200, out)
        self.assertEqual(self.K.users[out["id"]]["attributes"]["department"], ["개발 본부"])  # 목록의 표기로 저장한다

    def test_create_with_an_empty_department_is_still_allowed(self):
        code, out = self.req("POST", "/api/users/create", self.kim, {**self.BASE, "department": ""})
        self.assertEqual(code, 200, out)
        self.assertEqual(self.K.users[out["id"]]["attributes"], {})

    def test_update_does_not_check_the_department_when_it_is_not_changed_and_keeps_it(self):
        # 목록에 없는 부서를 가진 기존 사용자의 이름만 고친다(R4 보존 동작 1·4): department 키가 없으면 그대로, 같은 값이어도 통과
        self.K.users["kc-lee"]["attributes"]["department"] = ["목록 밖"]
        self.K.users["kc-lee"]["attributes"]["locale"] = ["ko"]
        self.names()
        code, out = self.req("POST", "/api/users/update", self.kim, {"id": "kc-lee", "first_name": "영숙", "last_name": "이"})
        self.assertEqual(code, 200, out)
        self.assertEqual(self.K.users["kc-lee"]["attributes"], {"department": ["목록 밖"], "locale": ["ko"]})
        code, out = self.req("POST", "/api/users/update", self.kim, {"id": "kc-lee", "department": "목록 밖", "first_name": "영희"})   # 같은 값
        self.assertEqual(code, 200, out)
        code, out = self.req("POST", "/api/users/update", self.kim, {"id": "kc-lee", "department": "또 다른 목록 밖"})              # 바꾸려는 값
        self.assertEqual((code, out["field"]), (400, "department"))
        self.assertEqual(self.K.users["kc-lee"]["attributes"]["department"], ["목록 밖"])

    def test_update_to_a_listed_department_and_to_empty_are_allowed(self):
        self.names()
        self.assertEqual(self.req("POST", "/api/users/update", self.kim, {"id": "kc-lee", "department": "개발팀"})[0], 200)
        self.assertEqual(self.K.users["kc-lee"]["attributes"]["department"], ["개발팀"])
        self.assertEqual(self.req("POST", "/api/users/update", self.kim, {"id": "kc-lee", "department": ""})[0], 200)   # 비움은 허용(보존 동작 5)
        self.assertNotIn("department", self.K.users["kc-lee"]["attributes"])

    def test_a_department_deleted_elsewhere_is_refused_at_once_although_this_process_has_it_cached(self):
        self.names()
        self.req("POST", "/api/departments/create", self.kim, {"name": "곧 지울 부서"})
        settings.department_rows()                                                           # 이 프로세스의 목록 캐시에 들어 있다
        with store.connect() as conn:                                                        # 다른 복제본이 지웠다
            conn.execute("DELETE FROM departments WHERE team_key=?", (settings._team_key("곧 지울 부서"),))
        code, out = self.req("POST", "/api/users/create", self.kim, {**self.BASE, "department": "곧 지울 부서"})
        self.assertEqual((code, out["field"]), (400, "department"))

    # ---- 설정 화면(R2·R5) ----
    def test_a_slogan_for_a_new_name_registers_the_department_and_the_settings_rows_follow_the_list(self):
        self.names()
        code, out = self.req("POST", "/api/settings/goal", self.kim, {"team": "신설 부서", "goal": "시작"})
        self.assertEqual(code, 200, out)
        self.assertIn("신설 부서", self.names())
        got = self.req("GET", "/api/settings", self.kim)[1]
        self.assertIn(("신설 부서", "시작"), [(r["team"], r["goal"]) for r in got["department_goals"]])
        self.req("POST", "/api/departments/delete", self.kim, {"name": "신설 부서"})
        got = self.req("GET", "/api/settings", self.kim)[1]
        self.assertNotIn("신설 부서", [r["team"] for r in got["department_goals"]])          # 지우면 설정 화면 줄도 사라진다


if __name__ == "__main__":
    unittest.main()

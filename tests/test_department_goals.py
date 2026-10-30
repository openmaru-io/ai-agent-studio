# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""부서 슬로건·목표(스펙 2026-10-15-018): 저장·목록·현수막용 응답·권한(관리자는 모든 부서, 일반 사용자는 자기 부서만)."""
import aasserver  # 실제 uvicorn 앱을 띄우는 시험 하네스(OMAI-1100)
import http.client
import json
import os
import tempfile
import unittest
from pathlib import Path

TMP = tempfile.TemporaryDirectory()
os.environ.setdefault("AAS_DATA_DIR", str(Path(TMP.name) / "data"))

from aas.auth import auth  # noqa: E402
from aas.common import dbmigrate, settings, store  # noqa: E402
from aas.fleet import pods  # noqa: E402
from aas.office import office  # noqa: E402
from aas.web import server  # noqa: E402


def clear():
    with store.connect() as conn:
        conn.execute(settings.GOAL_SCHEMA)
        conn.execute(settings._SCHEMA)
        conn.execute("DELETE FROM department_goals")
        conn.execute("DELETE FROM user_directory")
        conn.execute(settings.DEPT_SCHEMA)
        conn.execute("DELETE FROM departments")
        conn.execute("DELETE FROM meta WHERE key LIKE 'departments_seeded' OR key LIKE 'rename_pending:%'")
    with office.connect() as conn:
        conn.execute("DELETE FROM office_seats")
    settings.reset_cache()


class StoreTest(unittest.TestCase):
    def setUp(self):
        clear()

    def test_saves_one_line_per_department_and_cleans_spaces(self):
        self.assertEqual(settings.set_goal("  개발 팀 ", "  함께\n만든다  ", "a@x.com"), {"team": "개발 팀", "goal": "함께 만든다"})
        self.assertEqual(settings.goals()[office.team_key("개발 팀")]["goal"], "함께 만든다")

    def test_same_department_with_other_spelling_is_one_row_and_keeps_the_first_spelling(self):
        settings.set_goal("Dev Team", "하나", "a")
        settings.set_goal("dev  team", "둘", "b")
        rows = settings.goals()
        self.assertEqual(len(rows), 1)
        self.assertEqual(list(rows.values())[0], {"team": "Dev Team", "goal": "둘"})

    def test_empty_goal_removes_the_row_and_bad_input_is_refused(self):
        settings.set_goal("영업", "목표", "a")
        settings.set_goal("영업", "   ", "a")
        self.assertEqual(settings.goals(), {})
        with self.assertRaises(ValueError):
            settings.set_goal("", "x", "a")
        with self.assertRaises(ValueError):
            settings.set_goal("영업", "가" * (settings.GOAL_MAX + 1), "a")
        settings.set_goal("영업", "가" * settings.GOAL_MAX, "a")                       # 60자는 된다

    def test_banners_hide_departments_nobody_belongs_to(self):
        # 사용자의 부서를 바꾸면 옛 부서 이름의 슬로건이 남아 3D 오피스에 계속 보였다(OMAI-1236). 사람도 자리 팀도 없는 부서는 현수막에서 뺀다
        settings.set_goal("옛 부서", "남은 문구", "a")
        settings.set_goal("개발", "빠르게", "a")
        active = {office.team_key("개발")}
        out = settings.banners("개발", active=active)
        self.assertEqual(out, {"banners": [{"team": "개발", "goal": "빠르게"}], "mine": "개발"})
        self.assertEqual(settings.banners("옛 부서", active=active)["mine"], "")        # 사람이 없는 부서는 mine 도 비어 있다
        self.assertEqual([b["team"] for b in settings.banners("개발")["banners"]], ["개발", "옛 부서"])   # active 를 안 주면 거르지 않는다(설정 화면 등)

    def test_goal_rows_come_from_the_department_list_which_was_seeded_from_the_old_sources(self):
        # 설정 화면의 부서 줄은 부서 목록(departments) 기준이다. 처음 옮기기가 user_directory·슬로건·오피스 자리 팀을 목록으로 옮긴다(R5)
        settings.set_department("a@x.com", "개발")
        settings.set_department("b@x.com", "개발")
        settings.set_department("c@x.com", "영업")
        settings.set_goal("기획", "미리 적음", "a")
        with office.connect() as conn:
            conn.execute("INSERT INTO office_seats (alias, pod, profile, enabled, title, team, team_src, by, ts) VALUES ('s','p','x',1,'','운영','dept','t','t')")
        rows = {r["team"]: r for r in settings.goal_rows()}
        self.assertEqual({k: (v["goal"], v["people"]) for k, v in rows.items()},
                         {"개발": ("", 2), "영업": ("", 1), "기획": ("미리 적음", 0), "운영": ("", 0)})

    def test_goal_rows_do_not_resurrect_a_deleted_department_from_other_sources(self):
        settings.set_department("a@x.com", "개발")
        self.assertEqual([r["team"] for r in settings.goal_rows()], ["개발"])
        settings.ensure_seeded(None, final=True)                                         # 완료 표시 뒤에는 다시 옮기지 않는다
        settings.delete_department("개발")
        self.assertEqual(settings.goal_rows(), [])

    def test_own_goal_row_is_shown_even_when_the_department_is_not_in_the_list(self):
        settings.ensure_seeded(None, final=True)
        settings.set_department("u@x.com", "새로 들어온 부서")                              # claim 으로 들어와 목록에 없다
        rows = settings.own_goal_rows("u@x.com")
        self.assertEqual([(r["team"], r["goal"], r["people"]) for r in rows], [("새로 들어온 부서", "", 1)])
        settings.set_goal("새로 들어온 부서", "문구", "u@x.com")                           # 저장하면 목록에 등록된다
        self.assertTrue(settings.department_exists("새로 들어온 부서"))

    def test_banners_only_departments_with_a_goal_and_mine_follows_the_department(self):
        settings.set_goal("개발", "빠르게", "a")
        settings.set_goal("영업", "", "a")
        out = settings.banners("개발")
        self.assertEqual(out, {"banners": [{"team": "개발", "goal": "빠르게"}], "mine": "개발"})
        self.assertEqual(settings.banners("영업")["mine"], "")                          # 문구가 없는 부서는 mine 이 비어 있다
        self.assertEqual(settings.banners("")["mine"], "")

    def test_registered_for_postgres_migration(self):
        self.assertIn(settings.GOAL_SCHEMA, dbmigrate.schema_scripts())
        self.assertIn(settings.DEPT_SCHEMA, dbmigrate.schema_scripts())
        self.assertIn(settings.TEAM_MANAGER_SCHEMA, dbmigrate.schema_scripts())
        self.assertIn(settings._SCHEMA, dbmigrate.schema_scripts())          # user_directory(사람의 부서), 팀 관리자 판정이 읽는다


class ApiTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        root = Path(TMP.name)
        home = root / "ph"; (home / "profiles").mkdir(parents=True)
        reg = root / "dg-pods.json"
        reg.write_text(json.dumps({"pods": [{"id": "p", "owner": "t@example.com", "hermes_home": str(home), "dashboard_url": "http://127.0.0.1:9"}]}))
        server._auth = auth.Auth({"issuer": "https://accounts.google.com", "client_id": "", "client_secret": "", "domain": "",
                                  "public_url": "http://localhost:17900", "hours": 1, "users_file": root / "none.json"})
        server._registry = pods.Registry(reg)
        cls.app = aasserver.start()

    @classmethod
    def tearDownClass(cls):
        cls.app.shutdown()
        server._auth = server._registry = None
        server._hubs.clear(); server._cache.clear()

    def setUp(self):
        clear()

    def as_user(self, email, admin=False):
        reg = server._registry
        old = (server._auth, reg.is_admin)
        class On:
            enabled = True
            def user(s, cookie): return {"email": email, "name": ""}
        server._auth = On(); reg.is_admin = lambda u: admin
        self.addCleanup(lambda: (setattr(server, "_auth", old[0]), setattr(reg, "is_admin", old[1])))

    def req(self, method, path, body=None):
        c = http.client.HTTPConnection("127.0.0.1", self.app.server_port, timeout=10)
        c.request(method, path, body=json.dumps(body) if body is not None else None, headers={"Content-Type": "application/json", "X-AAS": "1"})
        r = c.getresponse(); data = json.loads(r.read() or b"{}"); c.close()
        return r.status, data

    def test_admin_sees_every_department_and_saves_any(self):
        self.as_user("root@example.com", admin=True)
        code, out = self.req("POST", "/api/settings/goal", {"team": "개발", "goal": "빠르게"})
        self.assertEqual((code, out["goal"]), (200, "빠르게"))
        got = self.req("GET", "/api/settings")[1]
        self.assertEqual((got["goal_max"], [(r["team"], r["goal"]) for r in got["department_goals"]]), (settings.GOAL_MAX, [("개발", "빠르게")]))
        self.assertEqual((got["goal_scope"], got["can_edit_goal"], got["can_edit"]), ("all", True, True))

    def test_a_user_sees_and_saves_only_their_own_department(self):
        settings.set_goal("영업", "꾸준히", "a")
        settings.set_goal("개발", "빠르게", "a")
        settings.set_department("u@example.com", "영업")
        self.as_user("u@example.com")
        got = self.req("GET", "/api/settings")[1]
        self.assertEqual([(r["team"], r["goal"]) for r in got["department_goals"]], [("영업", "꾸준히")])     # 다른 부서는 목록에 없다
        self.assertEqual((got["goal_scope"], got["can_edit_goal"], got["can_edit"]), ("own", True, False))      # 회사 이름은 여전히 관리자만
        code, out = self.req("POST", "/api/settings/goal", {"team": "영업", "goal": "함께 만든다"})
        self.assertEqual((code, out["goal"]), (200, "함께 만든다"))
        with store.connect() as conn:                                                                          # 고친 사람이 남는다
            self.assertEqual(conn.execute("SELECT by FROM department_goals WHERE team_key=?", (office.team_key("영업"),)).fetchone()["by"], "u@example.com")
        self.assertEqual(self.req("POST", "/api/settings/goal", {"team": "영업", "goal": ""})[0], 200)         # 비워 지우기도 자기 부서만큼은 된다

    def test_a_user_cannot_save_another_department_or_save_without_one(self):
        settings.set_goal("개발", "빠르게", "a")
        settings.set_department("u@example.com", "영업")
        self.as_user("u@example.com")
        self.assertEqual(self.req("POST", "/api/settings/goal", {"team": "개발", "goal": "바꿈"})[0], 403)
        self.assertEqual(self.req("POST", "/api/settings/goal", {"team": "새부서", "goal": "x"})[0], 403)       # 목록에 없는 부서를 새로 만들 수 없다
        self.assertEqual(settings.goals()[office.team_key("개발")]["goal"], "빠르게")
        self.as_user("nodept@example.com")                                                                     # 부서가 없는 사용자
        self.assertEqual(self.req("POST", "/api/settings/goal", {"team": "영업", "goal": "x"})[0], 403)
        got = self.req("GET", "/api/settings")[1]
        self.assertEqual((got["department_goals"], got["can_edit_goal"], got["goal_scope"]), ([], False, "own"))

    def test_the_own_department_matches_by_team_key_not_by_exact_spelling(self):
        settings.set_department("u@example.com", "Dev Team")
        self.as_user("u@example.com")
        self.assertEqual(self.req("POST", "/api/settings/goal", {"team": "dev  team", "goal": "ok"})[0], 200)
        self.assertEqual(len(settings.goals()), 1)

    def test_save_validation_messages(self):
        self.as_user("root@example.com", admin=True)
        self.assertEqual(self.req("POST", "/api/settings/goal", {"team": "", "goal": "x"})[0], 400)
        code, out = self.req("POST", "/api/settings/goal", {"team": "개발", "goal": "가" * 61})
        self.assertEqual(code, 400); self.assertIn("60", out["error"])

    def test_office_response_carries_banners_for_everyone_with_mine(self):
        settings.set_goal("개발", "빠르게", "a")
        settings.set_goal("영업", "꾸준히", "a")
        settings.set_department("d@example.com", "개발")                                 # 사람이 있는 부서만 현수막이 보인다(OMAI-1236)
        settings.set_department("t@example.com", "영업")
        self.as_user("t@example.com")                                                    # 에이전트(파드)를 가진 일반 사용자
        code, out = self.req("GET", "/api/office")
        self.assertEqual(code, 200, out)
        self.assertEqual(([b["team"] for b in out["banners"]], out["mine"]), (["개발", "영업"], "영업"))
        self.as_user("root@example.com", admin=True)
        self.assertEqual(self.req("GET", "/api/office")[1]["mine"], "")                 # 관리자는 부서가 없으면 mine 이 비어 있다


class ActiveTeamsTest(unittest.TestCase):
    def setUp(self):
        clear()

    def test_active_teams_are_people_departments_and_seat_teams(self):
        settings.set_department("a@x.com", "개발")
        with office.connect() as conn:
            conn.execute("INSERT INTO office_seats (alias, pod, profile, enabled, title, role, team, avatar, note, by, ts) "
                         "VALUES ('s1','p1','default',1,'','','기획','','','t','t')")
        self.assertEqual(server._active_team_keys(), {office.team_key("개발"), office.team_key("기획")})
        settings.set_department("a@x.com", "")                                          # 부서를 지우면 그 부서에는 사람이 없다
        self.assertEqual(server._active_team_keys(), {office.team_key("기획")})


if __name__ == "__main__":
    unittest.main()

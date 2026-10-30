# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""팀 관리자 저장(스펙 2026-10-22-001, OMAI-1434 작업 1): team_managers 표의 저장·부서 이름 바꾸기·부서 지우기."""
import os
import dataclasses
import tempfile
import types
import unittest
from pathlib import Path

TMP = tempfile.TemporaryDirectory()
os.environ.setdefault("AAS_DATA_DIR", str(Path(TMP.name) / "data"))

from aas.common import db, settings, store  # noqa: E402
from aas.office import office  # noqa: E402


def clear():
    with store.connect() as conn:
        conn.execute(settings.TEAM_MANAGER_SCHEMA)
        conn.execute("DELETE FROM team_managers")
        conn.execute(settings.DEPT_SCHEMA)
        conn.execute("DELETE FROM departments")
        conn.execute(settings.GOAL_SCHEMA)
        conn.execute("DELETE FROM department_goals")
        conn.execute("DELETE FROM meta WHERE key LIKE 'rename_pending:%'")
    settings.reset_cache()


def rows(department):
    with store.connect() as conn:
        conn.execute(settings.TEAM_MANAGER_SCHEMA)
        return {r["email"]: (r["ts"], r["by"]) for r in
                conn.execute("SELECT email, ts, by FROM team_managers WHERE team_key=?", (office.team_key(department),)).fetchall()}


class TeamManagerStoreTest(unittest.TestCase):
    def setUp(self):
        clear()

    def tearDown(self):
        clear()

    def test_다시_저장해도_남는_사람의_지정_시각은_같다(self):
        settings.set_team_managers("개발 1팀", ["a@x.com"], "boss@x.com")
        with store.connect() as conn:
            conn.execute("UPDATE team_managers SET ts='2020-01-01T00:00:00'")      # 시각이 같아 보이는 우연을 막는다
        before = rows("개발 1팀")["a@x.com"]
        settings.set_team_managers("개발 1팀", ["a@x.com", "b@x.com"], "other@x.com")
        after = rows("개발 1팀")
        self.assertEqual(after["a@x.com"], before)
        self.assertEqual(after["a@x.com"][1], "boss@x.com")
        self.assertEqual(after["b@x.com"][1], "other@x.com")

    def test_부서의_팀_관리자를_통째로_바꾼다(self):
        self.assertEqual(settings.set_team_managers("개발 1팀", ["B@x.com", "a@x.com", "a@x.com"]), ["a@x.com", "b@x.com"])
        self.assertEqual(settings.team_managers()["개발 1팀"], ["a@x.com", "b@x.com"])
        self.assertEqual(settings.set_team_managers("개발 1팀", ["a@x.com"]), ["a@x.com"])
        self.assertEqual(settings.team_managers()[office.team_key("개발 1팀")], ["a@x.com"])

    def test_이름을_바꾸면_행이_새_키로_옮겨진다(self):
        settings.create_department("개발 1팀")
        settings.set_team_managers("개발 1팀", ["a@x.com"])
        settings.rename_register("개발 1팀", "플랫폼팀")
        settings.rename_finish("개발 1팀", "플랫폼팀")
        managers = settings.team_managers()
        self.assertNotIn(office.team_key("개발 1팀"), managers)
        self.assertEqual(managers[office.team_key("플랫폼팀")], ["a@x.com"])

    def test_부서를_지우면_행도_지운다(self):
        settings.create_department("빈팀")
        settings.set_team_managers("빈팀", ["a@x.com"])
        settings.delete_department("빈팀")
        self.assertNotIn(office.team_key("빈팀"), settings.team_managers())


JANG = {"email": "jang@x.com", "sub": "sub-jang"}
KIM = {"email": "kim@x.com", "sub": "sub-kim"}
PARK = {"email": "park@x.com", "sub": "sub-park"}
ADMIN = {"email": "root@x.com", "sub": "sub-root", "admin": True}


def clear_people():
    with store.connect() as conn:
        conn.execute(settings._SCHEMA)
        conn.execute("DELETE FROM user_directory")
    settings.reset_cache()


class TeamPodsTest(unittest.TestCase):
    """팀 에이전트 판정(스펙 2026-10-22-001 §3·§5-2, 작업 2)."""

    def setUp(self):
        from unittest import mock
        from aas.fleet import pods
        from aas.web import server
        clear()
        clear_people()
        self.pods_mod, self.server = pods, server
        self.kim, self.park, self.lee, self.base = (pods.Pod("kim", "kim@x.com", "/tmp"), pods.Pod("park", "park@x.com", "/tmp"),
                                                    pods.Pod("lee", "lee@x.com", "/tmp"), pods.Pod("base", "*", "/tmp"))
        reg = pods.Registry.__new__(pods.Registry)
        reg.pods, reg.admins = [self.kim, self.park, self.lee, self.base], set()
        reg.grants = lambda: {}
        reg.is_admin = lambda u: bool((u or {}).get("admin"))
        self.reg = reg
        patcher = mock.patch.object(server, "registry", lambda: reg)
        patcher.start()
        self.addCleanup(patcher.stop)
        for email, dept in (("kim@x.com", "개발 1팀"), ("park@x.com", "개발 1팀"), ("jang@x.com", "개발 1팀"), ("lee@x.com", "영업팀")):
            settings.set_department(email, dept)
        settings.set_team_managers("개발 1팀", ["jang@x.com"])
        settings.reset_cache()

    def tearDown(self):
        clear()
        clear_people()

    def ids(self, pods):
        return [p.id for p in pods]

    def test_팀_관리자는_같은_부서_에이전트를_받는다(self):
        self.assertEqual(self.ids(self.reg.allowed(JANG, True)), ["kim", "park"])

    def test_팀_관리자가_아닌_같은_부서_사람은_받지_않는다(self):
        self.assertEqual(self.ids(self.reg.allowed(PARK, True)), ["park"])

    def test_부서를_옮기면_권한이_없다(self):
        settings.set_department("jang@x.com", "영업팀")
        settings.reset_cache()
        self.assertEqual(self.reg.team_pods(JANG), [])

    def test_부서가_빈_사람끼리는_팀이_아니다(self):
        settings.set_department("kim@x.com", "")
        settings.set_department("jang@x.com", "")
        settings.set_team_managers("", ["jang@x.com"])
        settings.reset_cache()
        self.assertEqual(self.reg.team_of_manager(JANG), "")
        self.assertEqual(self.reg.team_pods(JANG), [])

    def test_주인을_지운_에이전트는_팀_에이전트가_아니다(self):
        self.reg.pods.append(self.pods_mod.Pod("gone", "", "/tmp"))
        self.assertEqual(self.ids(self.reg.team_pods(JANG)), ["kim", "park"])

    def test_목록에_같은_에이전트가_두_번_나오지_않는다(self):
        self.reg.grants = lambda: {"jang@x.com": {"pods": ["kim"]}}
        self.assertEqual(self.ids(self.reg.allowed(JANG, True)), ["kim", "park"])
        self.reg.pods.append(self.pods_mod.Pod("jang", "jang@x.com", "/tmp"))
        self.assertEqual(self.ids(self.reg.allowed(JANG, True)), ["kim", "park", "jang"])
        self.assertEqual(self.ids(self.reg.managed(JANG, True)), ["kim", "park", "jang"])

    def test_관리자는_전부_받고_두_번_넣지_않는다(self):
        settings.set_team_managers("개발 1팀", ["jang@x.com", "root@x.com"])
        settings.set_department("root@x.com", "개발 1팀")
        settings.reset_cache()
        self.assertEqual(self.ids(self.reg.allowed(ADMIN, True)), ["kim", "park", "lee", "base"])
        self.assertEqual(self.ids(self.reg.managed(ADMIN, True)), ["kim", "park", "lee", "base"])

    def test_managed_는_접근_권한을_넣지_않는다(self):
        self.reg.grants = lambda: {"park@x.com": {"pods": ["lee"]}}
        self.assertEqual(self.ids(self.reg.allowed(PARK, True)), ["park", "lee"])
        self.assertEqual(self.ids(self.reg.managed(PARK, True)), ["park"])
        self.assertEqual(self.ids(self.reg.managed(None, False)), ["kim", "park", "lee", "base"])

    def test_manages_pod(self):
        s = self.server
        self.assertTrue(s._manages_pod(self.kim, JANG, True))
        self.assertFalse(s._manages_pod(self.lee, JANG, True))
        self.assertFalse(s._manages_pod(self.kim, PARK, True))
        self.assertFalse(s._manages_pod(None, JANG, True))
        self.assertTrue(s._acts_as_team_manager(self.kim, JANG, True))
        self.assertFalse(s._acts_as_team_manager(self.kim, KIM, True))
        self.assertFalse(s._acts_as_team_manager(self.kim, ADMIN, True))
        self.assertFalse(s._acts_as_team_manager(self.kim, JANG, False))

    def test_로그인을_끈_환경은_모두_통과한다(self):
        clear()
        self.assertTrue(self.server._manages_pod(self.kim, None, False))
        self.assertFalse(self.server._acts_as_team_manager(self.kim, None, False))

    def test_팀_관리자가_없으면_allowed_가_바뀌지_않는다(self):
        clear()
        self.reg.grants = lambda: {"lee@x.com": {"pods": ["kim"]}}
        self.assertEqual(self.ids(self.reg.allowed(KIM, True)), ["kim"])
        self.assertEqual(self.ids(self.reg.allowed(JANG, True)), [])
        self.assertEqual(self.ids(self.reg.allowed({"email": "lee@x.com", "sub": "s"}, True)), ["kim", "lee"])
        self.assertEqual(self.ids(self.reg.allowed(ADMIN, True)), ["kim", "park", "lee", "base"])
        self.assertEqual(self.ids(self.reg.allowed(None, False)), ["kim", "park", "lee", "base"])

    def test_쿠키가_없으면_내_에이전트가_기본이다(self):
        self.reg.pods.append(self.pods_mod.Pod("jang", "jang@x.com", "/tmp"))
        self.assertEqual(self.reg.pick(JANG, True, "").id, "jang")
        self.assertEqual(self.reg.pick(JANG, True, "없는값").id, "jang")                     # restarting 이 없는 등록부도 같다
        self.assertEqual(self.reg.pick(JANG, True, "없는값").id, "jang")
        self.assertEqual(self.reg.pick(JANG, True, "kim").id, "kim")
        self.reg.grants = lambda: {"lee@x.com": {"pods": ["kim"]}}
        lee = {"email": "lee@x.com", "sub": "s"}
        self.assertEqual(self.reg.pick(lee, True, "").id, "lee")

    def test_pick_keeps_the_cookie_workspace_while_it_restarts(self):
        """쿠키의 작업공간이 다시 뜨는 중이면 다른 곳으로 넘기지 않는다(스펙 2026-10-23-006). 권한 규칙은 같고, 기본값은 준비된 것만 본다."""
        from aas.fleet import pods
        held = dataclasses.replace(pods.Pod("held", "kim@x.com", "/tmp"), restarting=True)
        self.reg.restarting = [held]
        try:
            self.assertEqual(self.reg.pick(KIM, True, "held"), held)                       # 주인: 다시 뜨는 중인 그것
            self.assertTrue(self.reg.pick(KIM, True, "held").restarting)
            self.assertEqual(self.reg.pick(PARK, True, "held").id, "park")                 # 권한이 없으면 지금처럼 내 작업공간
            self.assertEqual(self.reg.pick(ADMIN, True, "held"), held)                      # 관리자도 넘어가지 않는다
            self.assertNotIn("held", [p.id for p in self.reg.allowed(ADMIN, True)])          # 볼 수 있는 목록(고르개)에는 없다
            self.assertIn("held", [p.id for p in self.reg.allowed(ADMIN, True, restarting=True)])
            # 쿠키가 없는 사용자(바꾼 적 없음)의 기본값도 넘어가지 않는다 — HermesAgent 목록 순서로 고른다(OKE 재시험, 5-1)
            self.reg.agents = [{"name": "held"}, {"name": "kim"}, {"name": "park"}, {"name": "lee"}, {"name": "base"}]
            self.assertEqual(self.reg.pick(KIM, True, ""), held)
            self.assertEqual(self.reg.pick(KIM, True, "없는값"), held)
            self.reg.restarting = []
            self.assertEqual(self.reg.pick(KIM, True, "").id, "kim")                        # 다 뜨면 원래대로
        finally:
            self.reg.restarting = []
            self.reg.__dict__.pop("agents", None)


class TeamGateTest(unittest.TestCase):
    """주인 권한 검사가 팀 관리자도 통과시키는가(스펙 2026-10-22-001 §4, 작업 4)."""

    def setUp(self):
        TeamPodsTest.setUp(self)                        # 같은 등록부 대역: jang 은 「개발 1팀」 팀 관리자
        self.addCleanup(self.tearDown)

    def tearDown(self):
        clear()
        clear_people()

    def test_팀_관리자는_주인_권한_검사를_통과한다(self):
        from aas.web import server
        for pod, expected in ((self.kim, True), (self.lee, False)):
            self.assertEqual(server.may_change_profile("soul", pod, JANG, True, False), expected, pod.id)
            self.assertEqual(server.content_gate(pod, JANG, True, False, "main") == "", expected, pod.id)
            self.assertEqual(server.may_change_cron(pod, JANG, True, False), expected, pod.id)
            self.assertEqual(server.may_use_market("/api/market/install", pod, JANG, True, False), expected, pod.id)

    def test_팀_관리자도_유료_허용은_못_한다(self):
        from aas.web import server
        self.assertFalse(server.may_use_market("/api/market/grant", self.kim, JANG, True, False))

    def test_팀_관리자도_주인과_같은_제한을_받는다(self):
        from unittest import mock
        from aas.fleet import primary
        from aas.ops import cron_policy, owner_guard
        from aas.web import server
        with mock.patch.object(cron_policy, "root_hidden", return_value=True):
            got = server.content_gate(self.kim, JANG, True, False, primary.ROOT)
            self.assertNotEqual(got, "")
            self.assertEqual(got, owner_guard.root_error(self.kim.id, primary.ROOT))

    def test_보기만_받은_사람과_다른_부서는_통과하지_못한다(self):
        from aas.web import server
        self.reg.grants = lambda: {"park@x.com": {"pods": ["kim"]}}
        self.assertFalse(server.may_change_profile("soul", self.kim, PARK, True, False))
        self.assertFalse(server.may_change_profile("soul", self.lee, JANG, True, False))

    def _files(self, user, pod_id):
        from unittest import mock
        from aas.web import files, server
        a = types.SimpleNamespace(enabled=True, user=lambda cookie: user)
        req = types.SimpleNamespace(headers={"Sec-Fetch-Site": "same-origin"}, query_params={"pod": pod_id})
        view = types.SimpleNamespace(_host_ok=lambda: True, _same_origin=lambda: True)
        ws = types.SimpleNamespace(supported=lambda: True)
        with mock.patch.object(files, "_View", return_value=view), mock.patch.object(server, "auth", return_value=a), \
                mock.patch.object(server, "workspace_for", return_value=ws):
            try:
                return files._context(req, write=True)[0].id
            except files._Denied as d:
                return d.status

    def test_팀_관리자는_팀원_작업_폴더에_쓸_수_있다(self):
        self.assertEqual(self._files(JANG, "kim"), "kim")
        self.assertEqual(self._files(KIM, "kim"), "kim")
        self.assertEqual(self._files(JANG, "lee"), 403)

    def _pc(self, user, pod_id, admin=False):
        from unittest import mock
        from aas.web import pc_import_routes as routes, server
        self.reg.pods = [dataclasses.replace(p, sidecar_url="http://s") for p in self.reg.pods]
        a = types.SimpleNamespace(enabled=True, user=lambda cookie: user)
        req = types.SimpleNamespace(headers={"Sec-Fetch-Site": "same-origin"}, query_params={"pod": pod_id})
        view = types.SimpleNamespace(_host_ok=lambda: True, _same_origin=lambda: True)
        self.reg.is_admin = lambda u: admin
        with mock.patch.object(routes.files, "_View", return_value=view), mock.patch.object(server, "auth", return_value=a), \
                mock.patch.object(routes, "_k8s_ready", return_value=True):
            try:
                pod, _user, is_admin, by_admin = routes._context(req, write=True)
                return pod.id, is_admin, by_admin
            except routes._Denied as d:
                return d.status

    def test_팀_관리자는_PC_가져오기를_통과하고_알림이_없다(self):
        self.assertEqual(self._pc(JANG, "kim"), ("kim", False, False))
        self.assertEqual(self._pc(JANG, "lee"), 403)
        self.assertEqual(self._pc(ADMIN, "kim", admin=True), ("kim", True, True))


class TeamLogTest(unittest.TestCase):
    """변경 기록의 팀 관리자 표시(스펙 2026-10-22-001 §5-4, 작업 5)."""

    def setUp(self):
        TeamPodsTest.setUp(self)
        self._clean_usage()

    def tearDown(self):
        from aas.common import store as st
        st.actor_role.set("")
        self._clean_usage()
        with store.connect() as conn:
            conn.execute(self.pods_mod.Registry.OWNER_SCHEMA)
            conn.execute("DELETE FROM pod_owners WHERE pod IN ('kim','park','lee','base')")
        clear()
        clear_people()

    def _clean_usage(self):
        with store.connect() as conn:
            conn.execute("DELETE FROM usage WHERE pod IN ('kim','park','lee','base')")

    def _log_as(self, role, kind, note, pod="kim"):
        token = store.actor_role.set(role)
        try:
            store.log_usage(kind, note, pod=pod)
        finally:
            store.actor_role.reset(token)

    def test_팀_관리자가_한_일은_주인에게_이름이_보인다(self):
        from aas.ops import changes
        self._log_as("team", "profile_soul", "jang@x.com main")
        self._log_as("", "profile_soul", "root@x.com main")
        by = {r["who"]: r for r in changes.rows(pod="kim")}
        self.assertTrue(by["jang@x.com"]["by_team_manager"])
        self.assertEqual(by["jang@x.com"]["detail"], "main")
        self.assertFalse(by["root@x.com"].get("by_team_manager", False))

    def test_권한을_잃은_뒤에도_표시가_같다(self):
        from aas.ops import changes
        self._log_as("team", "profile_soul", "jang@x.com main")
        before = changes.rows(pod="kim")
        settings.set_team_managers("개발 1팀", [])
        settings.reset_cache()
        self.assertEqual(changes.rows(pod="kim"), before)
        self.assertTrue(before[0]["by_team_manager"])

    def test_채팅이_많아도_설정_기록이_밀려나지_않는다(self):
        from aas.ops import changes
        store.log_usage("profile_soul", "kim@x.com main", pod="kim")
        with store.connect() as conn:
            ts = "2099-01-01T00:00:00+09:00"
            rows = ([(ts, "chat_send", "jang@x.com main", "kim")] * 5000
                    + [(ts, "chat_send_failed", "jang@x.com main", "kim")] * 10
                    + [(ts, "office_command", "park@x.com seatA", "kim")] * 3
                    + [(ts, "office_command", "park@x.com seatB", "kim")] * 2)
            for i in range(0, len(rows), 500):               # PostgreSQL 연결(PgConn)에는 executemany 가 없다 — 여러 줄 VALUES 로 묶는다
                part = rows[i:i + 500]
                conn.execute("INSERT INTO usage (ts, kind, note, pod) VALUES " + ",".join(["(?,?,?,?)"] * len(part)), [v for r in part for v in r])
        rows = changes.rows(pod="kim")
        self.assertTrue([r for r in rows if r["kind"] == "profile_soul"])
        chat = [r for r in rows if r["kind"] == "chat_send" and not r["failed"]]
        self.assertEqual([(r["who"], r["detail"], r["count"]) for r in chat], [("jang@x.com", "main", 5000)])
        office = sorted((r["detail"], r["count"]) for r in rows if r["kind"] == "office_command")
        self.assertEqual(office, [("seatA", 3), ("seatB", 2)])

    def test_일_시키기_기록이_주인에게_보인다(self):
        from aas.ops import changes
        for kind in ("chat_send", "office_command", "pc_import_start", "pc_export"):
            store.log_usage(kind, "jang@x.com main", pod="kim")
        rows = changes.rows(pod="kim")
        self.assertEqual(sorted(r["kind"] for r in rows), ["chat_send", "office_command", "pc_export", "pc_import_start"])
        for r in rows:
            self.assertEqual((r["group"], r["who"], r["count"]), ("일 시키기", "jang@x.com", 1), r["kind"])

    def test_소유권_이전_전_기록은_팀_관리자에게_보이지_않는다(self):
        self.reg.owner_since = self.pods_mod.Registry.owner_since.__get__(self.reg)
        self.reg.owner_since(self.kim)
        with store.connect() as conn:
            conn.execute("INSERT INTO usage (ts, kind, note, pod) VALUES (?,?,?,?)",
                         ("2000-01-01T00:00:00+09:00", "profile_soul", "old@x.com main", "kim"))
        self._log_as("team", "profile_soul", "jang@x.com main")
        rows = self.server._owner_change_rows(self.kim, JANG, 30)
        self.assertEqual([r["who"] for r in rows], ["jang@x.com"])

    def test_주인_화면은_관리자_이름만_가린다(self):
        self.reg.owner_since = self.pods_mod.Registry.owner_since.__get__(self.reg)
        self.reg.owner_since(self.kim)
        self._log_as("team", "profile_soul", "jang@x.com main")
        self._log_as("", "profile_soul", "root@x.com main")
        self._log_as("", "profile_soul", "kim@x.com main")
        for viewer in (KIM, JANG):
            rows = self.server._owner_change_rows(self.kim, viewer, 30)
            self.assertEqual(sorted(r["who"] for r in rows), ["", "jang@x.com", "kim@x.com"])
            self.assertTrue([r for r in rows if r["who"] == "" and r.get("by_admin")])

    def _stub_raising(self):
        def stub(handler, *args):
            handler._role_token = store.actor_role.set("team")        # 표시를 켠 뒤 처리 도중 예외가 난다
            raise RuntimeError("처리 중 오류")
        return stub

    def test_표시는_요청이_끝나면_남지_않는다(self):
        from unittest import mock
        from aas.ops import changes
        Handler = self.server.Handler
        cases = (("do_POST", "_do_post"), ("do_PUT", "_office_rest_other_inner"), ("do_PATCH", "_office_rest_other_inner"),
                 ("do_DELETE", "_office_rest_other_inner"))
        for entry, inner in cases:
            with self.subTest(entry), mock.patch.object(Handler, inner, self._stub_raising()):
                with self.assertRaises(RuntimeError):
                    getattr(Handler.__new__(Handler), entry)()
                self.assertEqual(store.actor_role.get(), "")
        store.log_usage("profile_soul", "kim@x.com main", pod="kim")
        self.assertFalse(changes.rows(pod="kim")[0].get("by_team_manager", False))

    def test_팀_관리자의_PC_내보내기_기록은_팀_관리자_표시가_붙는다(self):
        from aas.ops import changes
        from aas.web import pc_import_routes as routes
        a = types.SimpleNamespace(enabled=True)
        from unittest import mock
        with mock.patch.object(self.server, "auth", return_value=a):
            routes._log_work("pc_export", self.kim, JANG, "main")
            routes._log_work("pc_export", self.kim, ADMIN, "main")
        self.assertEqual(store.actor_role.get(), "")
        by = {r["who"]: r for r in changes.rows(pod="kim")}
        self.assertTrue(by["jang@x.com"]["by_team_manager"])
        self.assertFalse(by["root@x.com"].get("by_team_manager", False))


class ActorRoleLogTest(TeamLogTest):
    """작성자 역할 표시(D15): 관리자가 한 일만 「관리자가 함」으로 가리고, 주인·팀 관리자 아닌 사람은 이름과 by_other 로 보인다."""

    def setUp(self):
        super().setUp()
        # owner_since 는 행이 없으면 지금(초 단위)을 적는다. 기록을 남긴 뒤 부르면 초 경계에서 기록보다 늦어져 줄이 빠지므로,
        # 주인 시작 시각을 기록보다 먼저 과거로 적어 둔다. 지우는 일은 TeamLogTest.tearDown 이 한다.
        with store.connect() as conn:
            conn.execute(self.pods_mod.Registry.OWNER_SCHEMA)
            conn.execute(db.upsert("pod_owners", ("pod", "owner", "since"), ("pod",)),
                         (self.kim.id, self.kim.owner, "2000-01-01T00:00:00+00:00"))

    def _mark_and_log(self, user, kind="profile_soul", detail="main", pod=None, enabled=True):
        """요청 시작의 표시 판정(_mark_actor_role)을 거쳐 기록을 남긴다."""
        pod = pod or self.kim
        h = self.server.Handler.__new__(self.server.Handler)
        h._role_token = None
        h._mark_actor_role(types.SimpleNamespace(enabled=enabled), user, pod)
        try:
            store.log_usage(kind, f"{(user or {}).get('email', 'local')} {detail}", pod=pod.id)
        finally:
            if h._role_token is not None:
                store.actor_role.reset(h._role_token)
        self.assertEqual(store.actor_role.get(), "")

    def _owner_rows(self, viewer=KIM):
        self.reg.owner_since = self.pods_mod.Registry.owner_since.__get__(self.reg)
        self.reg.owner_since(self.kim)
        return self.server._owner_change_rows(self.kim, viewer, 30)

    def test_역할_판정(self):
        s = self.server
        self.assertEqual(s._actor_role(self.kim, KIM, True), "")
        self.assertEqual(s._actor_role(self.kim, ADMIN, True), "admin")
        self.assertEqual(s._actor_role(self.kim, JANG, True), "team")
        self.assertEqual(s._actor_role(self.kim, PARK, True), "other")       # 같은 부서지만 팀 관리자가 아니다(접근 권한만 받은 사람과 같다)
        self.assertEqual(s._actor_role(self.lee, JANG, True), "other")       # 다른 부서 에이전트
        self.assertEqual(s._actor_role(self.kim, PARK, False), "")           # 로그인을 끈 설치에는 주인 개념이 없다
        self.assertEqual(s._actor_role(None, PARK, True), "")

    def test_다른_사람의_채팅은_주인에게_이름과_by_other_로_보인다(self):
        self._mark_and_log(PARK, kind="chat_send")
        for viewer in (KIM, JANG):
            row = next(r for r in self._owner_rows(viewer) if r["kind"] == "chat_send")
            self.assertEqual(row["who"], "park@x.com")
            self.assertTrue(row["by_other"])
            self.assertFalse(row.get("by_admin", False))
            self.assertFalse(row.get("by_team_manager", False))

    def test_관리자가_한_일은_가리고_by_admin(self):
        self._mark_and_log(ADMIN)
        row = self._owner_rows()[0]
        self.assertEqual((row["who"], row.get("by_admin"), row.get("by_other", False)), ("", True, False))

    def test_팀_관리자가_한_일은_by_team_manager(self):
        self._mark_and_log(JANG)
        row = self._owner_rows()[0]
        self.assertEqual((row["who"], row.get("by_team_manager"), row.get("by_other", False), row.get("by_admin", False)),
                         ("jang@x.com", True, False, False))

    def test_주인이_한_일에는_표시가_없다(self):
        self._mark_and_log(KIM)
        row = self._owner_rows()[0]
        self.assertEqual(row["who"], "kim@x.com")
        self.assertFalse(any(row.get(k) for k in ("by_admin", "by_team_manager", "by_other")))

    def test_역할이_없는_옛_기록은_관리자가_함으로_가린다(self):
        store.log_usage("profile_soul", "park@x.com main", pod="kim")              # 이 기능 전 기록: 역할 없음
        row = self._owner_rows()[0]
        self.assertEqual((row["who"], row.get("by_admin"), row.get("by_other", False)), ("", True, False))

    def test_다른_사람의_채팅도_날짜별로_한_줄로_묶인다(self):
        for _ in range(5):
            self._mark_and_log(PARK, kind="chat_send")
        chat = [r for r in self._owner_rows() if r["kind"] == "chat_send"]
        self.assertEqual([(r["who"], r["detail"], r["count"], r.get("by_other")) for r in chat], [("park@x.com", "main", 5, True)])

    def test_쿠키_에이전트와_기록_에이전트가_달라도_주인_자신의_줄에는_표시가_없다(self):
        # 프로파일 만들기(target_pod)처럼 요청 시작의 쿠키 에이전트(lee)와 기록 에이전트(kim)가 다른 경로(검토 지적 1)
        kim_admin = {**KIM, "admin": True}
        for user in (KIM, kim_admin):                                   # 쿠키 에이전트 기준 자격은 other·admin
            h = self.server.Handler.__new__(self.server.Handler)
            h._role_token = None
            h._mark_actor_role(types.SimpleNamespace(enabled=True), user, self.lee)
            try:
                self.assertIn(store.actor_role.get(), ("other", "admin"))
                store.log_usage("profile_create", "KIM@x.com newprof", pod="kim")
            finally:
                store.actor_role.reset(h._role_token)
        rows = self._owner_rows()
        self.assertEqual(len(rows), 2)
        for r in rows:
            self.assertEqual(r["who"], "KIM@x.com")
            self.assertFalse(any(r.get(k) for k in ("by_admin", "by_team_manager", "by_other")), r)

    def test_AAS_자동_기록의_자격_표시는_무시한다(self):
        from aas.ops import changes
        for role in ("admin", "other"):
            self._log_as(role, "profile_soul", "aas main")
        for r in changes.rows(pod="kim"):
            self.assertEqual((r["actor"], r["detail"]), ("aas", "main"))
            self.assertFalse(any(r.get(k) for k in ("by_admin", "by_team_manager", "by_other")), r)
        for r in self._owner_rows():
            self.assertFalse(r.get("by_admin", False), r)

    def test_관리자_화면은_이름을_가리지_않는다(self):
        self._mark_and_log(ADMIN)
        self._mark_and_log(PARK)
        self._mark_and_log(JANG)
        rows = self.server._admin_change_rows(30)
        by = {r["who"]: r for r in rows if r.get("pod") == "kim"}
        self.assertEqual(sorted(by), ["jang@x.com", "park@x.com", "root@x.com"])
        self.assertFalse(any(r.get("by_admin") or r.get("by_other") for r in by.values()))
        self.assertTrue(by["jang@x.com"]["by_team_manager"])
        self.assertEqual(by["root@x.com"]["detail"], "main")


class TeamOfficeAuditTest(TeamLogTest):
    """오피스 명령 기록의 팀 관리자 표시는 쿠키 에이전트가 아니라 시킨 자리의 에이전트로 정한다(최종 리뷰 M1)."""

    def _audit(self, seat_pod):
        from unittest import mock
        a = types.SimpleNamespace(enabled=True)
        acc = types.SimpleNamespace(acting_on_others=lambda alias: True, seat_of=lambda alias: {"pod": seat_pod})
        with mock.patch.object(self.server, "auth", return_value=a):
            token = store.actor_role.set("team")                      # 쿠키로 고른 에이전트가 팀원 것이라 이미 켜져 있는 상태
            try:
                self.server._office_audit(acc, JANG["email"], "seatA")
                self.assertEqual(store.actor_role.get(), "team")        # 기록 뒤에는 원래 값으로 돌아온다
            finally:
                store.actor_role.reset(token)

    def test_다른_부서_자리에는_팀_관리자_표시가_붙지_않는다(self):
        from aas.ops import changes
        self._audit("lee")
        row = next(r for r in changes.rows(pod="lee") if r["who"] == "jang@x.com")
        self.assertFalse(row.get("by_team_manager", False))
        self.assertTrue(row["by_other"])                                 # 주인·팀 관리자 아닌 사람(D15)

    def test_같은_부서_자리에는_팀_관리자_표시가_붙는다(self):
        from aas.ops import changes
        self._audit("kim")
        row = next(r for r in changes.rows(pod="kim") if r["who"] == "jang@x.com")
        self.assertTrue(row["by_team_manager"])


class TeamMeFlagsTest(unittest.TestCase):
    """화면에 알리는 팀 관리자 상태(스펙 2026-10-22-001 §14-1 DD2·DD5·DD6·DD9, 작업 7)."""

    def setUp(self):
        TeamPodsTest.setUp(self)
        self.addCleanup(self.tearDown)

    def tearDown(self):
        clear()
        clear_people()

    def test_me_는_팀_관리자_여부를_준다(self):
        got = self.server._me_team_flags(self.reg, self.kim, JANG, True)
        self.assertTrue(got["team_manager"])
        self.assertEqual(got["owner_name"], office.display_name("kim@x.com", office.people()))
        self.assertFalse(self.server._me_team_flags(self.reg, self.kim, KIM, True)["team_manager"])
        self.assertFalse(self.server._me_team_flags(self.reg, self.lee, JANG, True)["team_manager"])

    def test_지정_시각은_팀_관리자에게만_준다(self):
        self.assertTrue(self.server._me_team_flags(self.reg, self.kim, JANG, True)["team_manager_since"])
        self.assertEqual(self.server._me_team_flags(self.reg, self.kim, KIM, True)["team_manager_since"], "")
        settings.set_department("jang@x.com", "영업팀")      # 부서를 옮기면 지정 시각도 없다
        settings.reset_cache()
        self.assertEqual(self.server._me_team_flags(self.reg, self.kim, JANG, True)["team_manager_since"], "")

    def test_pods_와_채팅_묶음의_team_은_주인이_아닌_팀_에이전트만_참이다(self):
        ids = self.server._team_pod_ids(self.reg, JANG, True)
        self.assertEqual(ids, {"kim", "park"})
        self.assertTrue(self.server._pod_public(self.kim, {}, {}, ids)["team"])
        self.assertFalse(self.server._pod_public(self.lee, {}, {}, ids)["team"])
        # 팀 관리자 자신의 에이전트는 주인이라 팀이 아니다
        jang = self.pods_mod.Pod("jang", "jang@x.com", "/tmp")
        self.reg.pods.append(jang)
        self.assertFalse(self.server._pod_public(jang, {}, {}, self.server._team_pod_ids(self.reg, JANG, True))["team"])
        self.assertEqual(self.server._team_pod_ids(self.reg, JANG, False), set())     # 로그인을 끄면 팀 개념이 없다

    def test_변경_기록은_주인에게_지금_팀_관리자만_알린다(self):
        settings.set_team_managers("개발 1팀", ["jang@x.com", "park@x.com"])
        settings.set_department("park@x.com", "영업팀")      # 부서를 옮긴 사람은 뺀다
        settings.reset_cache()
        names = self.server._pod_team_manager_names(self.kim)
        self.assertEqual(names, [office.display_name("jang@x.com", office.people())])
        self.assertEqual(self.server._pod_team_manager_names(self.lee), [])
        self.assertEqual(self.server._pod_team_manager_names(self.base), [])

    def test_변경_기록의_팀_관리자_목록에_주인_자신은_없다(self):
        settings.set_team_managers("개발 1팀", ["jang@x.com", "kim@x.com"])      # 주인(kim)이 팀 관리자이기도 하다
        settings.reset_cache()
        self.assertEqual(self.server._pod_team_manager_names(self.kim), [office.display_name("jang@x.com", office.people())])


class TeamManagerApiTest(unittest.TestCase):
    """관리자가 부서마다 팀 관리자를 지정하는 API(스펙 §3, 작업 6)."""

    def setUp(self):
        clear()
        clear_people()
        from aas.web import server
        self.server = server
        settings.set_department("jang@x.com", "개발 1팀")
        settings.set_department("lee@x.com", "개발 2팀")
        settings.create_department("개발 1팀")

    def tearDown(self):
        clear()
        clear_people()

    def write(self, user, emails, name="개발 1팀"):
        from unittest import mock
        a = types.SimpleNamespace(enabled=True)
        with mock.patch.object(self.server, "_users_mode", return_value=("legacy", None)):
            return self.server._departments_write(a, user, "/api/departments/managers", {"name": name, "emails": emails})

    def view_row(self, name="개발 1팀"):
        from unittest import mock
        a = types.SimpleNamespace(enabled=True)
        with mock.patch.object(self.server, "_users_mode", return_value=("legacy", None)):
            rows = self.server._departments_view(a)["departments"]
        return next(r for r in rows if r["name"] == name)

    def test_관리자가_아니면_지정할_수_없다(self):
        out, code = self.write(PARK, ["jang@x.com"])
        self.assertEqual(code, 403)
        self.assertEqual(settings.team_managers(), {})

    def test_다른_부서_사람은_지정할_수_없다(self):
        out, code = self.write(ADMIN, ["jang@x.com", "lee@x.com"])
        self.assertEqual(code, 400)
        self.assertEqual(out["emails"], ["lee@x.com"])
        self.assertEqual(out["field"], "emails")
        self.assertEqual(settings.team_managers(), {})

    def test_로그인한_적이_없는_사람은_지정할_수_없다(self):
        out, code = self.write(ADMIN, ["nobody@x.com"])
        self.assertEqual(code, 400)
        self.assertEqual(out["emails"], ["nobody@x.com"])
        self.assertIn("로그인한 적이 없는", out["error"])

    def test_지정하면_목록에_나오고_옮긴_사람은_moved(self):
        out, code = self.write(ADMIN, ["Jang@x.com"])
        self.assertEqual((code, out), (200, {"ok": True, "managers": ["jang@x.com"]}))
        row = self.view_row()
        self.assertEqual((row["managers"], row["moved"]), (["jang@x.com"], []))
        settings.set_department("jang@x.com", "개발 2팀")
        row = self.view_row()
        self.assertEqual((row["managers"], row["moved"]), ([], ["jang@x.com"]))
        self.assertEqual(settings.current_team_managers(office.team_key("개발 1팀")), [])

    def test_Keycloak에_닿지_않아도_지정된다(self):
        from unittest import mock
        from aas.auth import keycloak
        a = types.SimpleNamespace(enabled=True)
        kc = mock.Mock()
        kc.list_users.side_effect = keycloak.KeycloakError("down")
        with mock.patch.object(self.server, "_users_mode", return_value=("keycloak", kc)):
            out, code = self.server._departments_write(a, ADMIN, "/api/departments/managers", {"name": "개발 1팀", "emails": ["jang@x.com"]})
        self.assertEqual(code, 200)

    def test_지정과_해제는_열린_세션과_오피스_범위를_다시_검사시킨다(self):
        from unittest import mock
        settings.set_department("kim@x.com", "개발 1팀")
        self.write(ADMIN, ["jang@x.com"])
        with mock.patch.object(self.server.topics, "user_changed") as changed, mock.patch.object(self.server, "_scene_scope_changed") as scope:
            self.write(ADMIN, ["kim@x.com"])                              # jang 은 빠지고 kim 은 들어온다
        self.assertEqual({c.args[0] for c in changed.call_args_list}, {"jang@x.com", "kim@x.com"})
        scope.assert_called()

    def test_빈_목록은_모두_해제한다(self):
        self.write(ADMIN, ["jang@x.com"])
        out, code = self.write(ADMIN, [])
        self.assertEqual((code, out["managers"]), (200, []))

    def test_이미_행이_있는_옮긴_사람은_그대로_다시_보내도_된다(self):
        settings.set_department("kim@x.com", "개발 1팀")
        self.write(ADMIN, ["jang@x.com"])
        settings.set_department("jang@x.com", "개발 2팀")              # 옮긴 사람(행은 남아 있다)
        out, code = self.write(ADMIN, ["jang@x.com", "kim@x.com"])
        self.assertEqual(code, 200, out)
        row = self.view_row()
        self.assertEqual((row["managers"], row["moved"]), (["kim@x.com"], ["jang@x.com"]))

    def test_행이_없는_다른_부서_사람은_새로_넣을_수_없다(self):
        self.write(ADMIN, ["jang@x.com"])
        settings.set_department("jang@x.com", "개발 2팀")
        out, code = self.write(ADMIN, ["jang@x.com", "lee@x.com"])
        self.assertEqual((code, out["emails"], out["field"]), (400, ["lee@x.com"], "emails"))
        self.assertEqual(settings.team_managers()[office.team_key("개발 1팀")], ["jang@x.com"])

    def test_emails_가_없거나_목록이_아니면_400_이고_지우지_않는다(self):
        self.write(ADMIN, ["jang@x.com"])
        from unittest import mock
        a = types.SimpleNamespace(enabled=True)
        for body in ({"name": "개발 1팀"}, {"name": "개발 1팀", "emails": "jang@x.com"}, {"name": "개발 1팀", "emails": None}):
            with mock.patch.object(self.server, "_users_mode", return_value=("legacy", None)):
                out, code = self.server._departments_write(a, ADMIN, "/api/departments/managers", body)
            self.assertEqual((code, out["field"]), (400, "emails"), body)
        self.assertEqual(settings.team_managers()[office.team_key("개발 1팀")], ["jang@x.com"])

    def test_변경_기록_종류가_있다(self):
        from aas.ops import changes
        self.assertEqual(changes.LABELS["department_managers"], ("접속", "팀 관리자를 바꿈"))


if __name__ == "__main__":
    unittest.main()

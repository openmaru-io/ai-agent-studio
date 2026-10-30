# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""「설정」 회사 이름 → SOUL 첫 문장, Keycloak 부서 → 오피스 기본 팀(계획 2026-10-13-008)."""
import os
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

TMP = tempfile.TemporaryDirectory()
os.environ.setdefault("AAS_DATA_DIR", str(Path(TMP.name) / "data"))

from aas.common import settings, store  # noqa: E402
from aas.fleet import identity  # noqa: E402
from aas.office import office  # noqa: E402
from aas.web import server  # noqa: E402

HERMES = identity.HERMES_DEFAULT + " Be direct: match the length of your reply."


def clear():
    with store.connect() as conn:
        conn.execute("DELETE FROM meta WHERE key IN ('company_name', 'company_by', 'identity_history')")
        conn.execute(settings._SCHEMA)
        conn.execute("DELETE FROM user_directory")
    settings.reset_cache()                                   # 부서 조회는 서버 캐시를 거친다 — DB 를 직접 지웠으면 비운다
    with office.connect() as conn:
        for t in ("office_desk_assignments", "office_seat_optout", "office_seats"):
            conn.execute(f"DELETE FROM {t}")


class Base(unittest.TestCase):
    def setUp(self):
        clear()

    tearDown = staticmethod(clear)


class CompanyTest(Base):
    def test_정하지_않으면_OPENMARU_를_쓴다(self):
        self.assertEqual(settings.company_name(), "")
        self.assertEqual(settings.identity_sentence(), "You are CogentAI AAS Agent, built by OPENMARU, Inc.")

    def test_저장하면_공백을_줄이고_문장에_쓴다(self):
        self.assertEqual(settings.set_company_name("  오픈마루\n  주식회사 ", "a@x.com"), "오픈마루 주식회사")
        self.assertEqual(settings.identity_sentence(), "You are CogentAI AAS Agent, built by 오픈마루 주식회사.")
        self.assertEqual(settings.company_by(), "a@x.com")

    def test_옛_문장_AAS_Agent_는_알아보고_새_문장으로_바꾼다(self):
        # 제품 이름을 「CogentAI AAS」로 맞추며 문장을 바꿨다. 전에 넣은 옛 문장은 기록에 없어도
        # (템플릿 적용으로 들어간 것 등) 알아봐야 자동 교체가 새 문장으로 바꾼다
        settings.set_company_name("오픈마루")
        known = settings.identity_history()
        self.assertIn("You are AAS Agent, built by 오픈마루.", known)
        self.assertEqual(identity.rewrite("You are AAS Agent, built by 오픈마루. Be brief.", settings.identity_sentence(), known),
                         "You are CogentAI AAS Agent, built by 오픈마루. Be brief.")
        self.assertIsNone(identity.rewrite("You are CogentAI AAS Agent, built by 오픈마루. x", settings.identity_sentence(), known))

    def test_너무_긴_이름은_거절한다(self):
        with self.assertRaises(ValueError):
            settings.set_company_name("가" * (settings.COMPANY_MAX + 1))


class CompanyCacheTest(Base):
    """회사 이름은 /api/me·서버 페이지마다 읽어 30초 캐시한다. 바꾸면 이 서버는 바로, 다른 서버는 cache_epoch 로 버린다(스펙 2026-10-24-009 3-3)."""

    def _db_set(self, name):
        with store.connect() as conn:
            conn.execute("INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", ("company_name", name))

    def test_캐시는_바꾸면_바로_비우고_DB_만_바뀌면_유효_시간_동안_그대로(self):
        settings.set_company_name("가나", "a@x.co")
        self.assertEqual(settings.company_name(), "가나")
        self._db_set("다른 서버가 쓴 값")                                # 이 서버 캐시는 그대로
        if not __import__("aas.common.cache_epoch", fromlist=["x"]).enabled():
            self.assertEqual(settings.company_name(), "가나")
        settings.set_company_name("다라", "a@x.co")                    # 이 서버에서 바꾸면 바로
        self.assertEqual(settings.company_name(), "다라")
        self._db_set("마바")
        import time as _t
        now = _t.monotonic()
        with mock.patch.object(settings.time, "monotonic", return_value=now + settings.COMPANY_TTL + 1):
            self.assertEqual(settings.company_name(), "마바")            # 유효 시간이 지나면 다시 읽는다

    def test_다른_서버가_바꾸면_cache_epoch_로_다음_읽기에_새_값(self):
        from aas.common import cache_epoch
        if not cache_epoch.enabled():
            self.skipTest("cache_epoch 는 PostgreSQL(서버 여럿)에서만 동작한다")
        settings.set_company_name("가나", "a@x.co")
        self.assertEqual(settings.company_name(), "가나")
        self._db_set("다른 서버 값")
        with store.connect() as conn:                                   # 다른 서버의 bump 를 흉내: 토큰을 새로 쓰고 알림이 온다
            conn.execute("INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                         (cache_epoch.KEY + settings.COMPANY_EPOCH, "other-token"))
        cache_epoch.on_notify(f"other-origin|{settings.COMPANY_EPOCH}")   # 1초 표 읽기는 OMAI-1477 에서 알림으로 바뀌었다
        self.assertEqual(settings.company_name(), "다른 서버 값")


class RewriteTest(unittest.TestCase):
    S = "You are AAS Agent, built by OPENMARU, Inc."

    def test_Hermes_기본_첫_문장만_바꾼다(self):
        self.assertEqual(identity.rewrite(HERMES, self.S, []), self.S + " Be direct: match the length of your reply.")

    def test_이미_맞으면_바꾸지_않는다(self):
        self.assertIsNone(identity.rewrite(self.S + " rest", self.S, []))

    def test_사람이_고친_첫_문장은_두고_전에_넣은_문장은_바꾼다(self):
        self.assertIsNone(identity.rewrite("You are Kim's helper. Be brief.", self.S, ["You are AAS Agent, built by A."]))
        self.assertEqual(identity.rewrite("You are AAS Agent, built by A. Be brief.", self.S, ["You are AAS Agent, built by A."]),
                         self.S + " Be brief.")

    def test_마침표가_든_회사_이름도_문장_단위로_맞춘다(self):
        old = "You are AAS Agent, built by A.B Corp."
        self.assertEqual(identity.rewrite(old + " x", "You are AAS Agent, built by A.", [old]), "You are AAS Agent, built by A. x")

    def test_빈_SOUL_은_건드리지_않는다(self):
        self.assertIsNone(identity.rewrite("  \n", self.S, []))


class FakeAPI:
    souls = {}

    def __init__(self, auth=None):
        pass

    def call(self, method, path, body=None, query=None):
        if path == "/api/profiles":
            return {"profiles": [{"name": n, "is_default": n == "default"} for n in self.souls]}
        name = path.split("/")[3]
        if method == "GET":
            return {"content": self.souls[name]}
        self.souls[name] = body["content"]
        return {"ok": True}


class SyncTest(Base):
    def run_sync(self, souls):
        FakeAPI.souls = dict(souls)
        reg = SimpleNamespace(pods=[SimpleNamespace(id="p1", hermes_home=None)])
        with mock.patch.object(server, "HermesAPI", FakeAPI), mock.patch.object(server, "hub", return_value=SimpleNamespace(auth=None)):
            done = server.identity_sync_once(reg)
        return done, FakeAPI.souls

    def test_회사_이름을_바꾸면_모든_프로파일의_첫_문장만_바뀌고_고친_SOUL_은_남는다(self):
        done, souls = self.run_sync({"default": HERMES, "ma": "You are Kim's helper."})
        self.assertEqual(done, ["p1/default"])
        self.assertTrue(souls["default"].startswith("You are CogentAI AAS Agent, built by OPENMARU, Inc. Be direct"))
        self.assertEqual(souls["ma"], "You are Kim's helper.")
        settings.set_company_name("오픈마루", "a@x.com")
        done, souls = self.run_sync(souls)
        self.assertEqual(done, ["p1/default"])
        self.assertTrue(souls["default"].startswith("You are CogentAI AAS Agent, built by 오픈마루. Be direct"))
        self.assertEqual(self.run_sync(souls)[0], [])                          # 두 번째는 바꿀 것이 없다
        with store.connect() as conn:
            notes = [r["note"] for r in conn.execute("SELECT note FROM usage WHERE kind='profile_soul_identity'")]
        self.assertIn("a@x.com p1/default", notes)

    def test_닿지_않는_설치본은_건너뛴다(self):
        class Down(FakeAPI):
            def call(self, *a, **k):
                raise OSError("down")
        reg = SimpleNamespace(pods=[SimpleNamespace(id="p1", hermes_home=None)])
        with mock.patch.object(server, "HermesAPI", Down), mock.patch.object(server, "hub", return_value=SimpleNamespace(auth=None)):
            self.assertEqual(server.identity_sync_once(reg), [])


def seat(alias, team="", pod=None):
    pod = pod or alias
    office.set_seat({"pod": pod, "profile": "default", "alias": alias, "team": team}, "admin", {pod: {"default"}})


def team_of(alias):
    with office.connect() as conn:
        r = conn.execute("SELECT team, team_src FROM office_seats WHERE alias=?", (alias,)).fetchone()
    return r["team"], r["team_src"]


class DepartmentTest(Base):
    def test_부서는_빈_팀을_채우고_부서가_바뀌면_따라간다(self):
        seat("kim")
        settings.set_department("Kim@X.com", "  마케팅팀 ")
        owners = {"kim": "kim@x.com"}
        self.assertEqual(office.default_teams(owners, settings.departments()), ["kim"])
        self.assertEqual(team_of("kim"), ("마케팅팀", "dept"))
        self.assertEqual(office.default_teams(owners, settings.departments()), [])        # 같으면 다시 쓰지 않는다
        settings.set_department("kim@x.com", "영업팀")
        office.default_teams(owners, settings.departments())
        self.assertEqual(team_of("kim"), ("영업팀", "dept"))

    def test_사람이_정한_팀은_부서가_덮지_않는다(self):
        seat("lee", team="TFT 결제")
        settings.set_department("lee@x.com", "연구소")
        self.assertEqual(office.default_teams({"lee": "lee@x.com"}, settings.departments()), [])
        self.assertEqual(team_of("lee"), ("TFT 결제", ""))

    def test_부서로_채운_팀을_사람이_바꾸면_그_뒤로는_덮지_않고_팀을_그대로_두면_따라간다(self):
        seat("park")
        settings.set_department("park@x.com", "총무팀")
        office.default_teams({"park": "park@x.com"}, settings.departments())
        seat("park", team="총무팀")                        # 팀은 그대로 두고 저장(다른 칸만 고침)
        self.assertEqual(team_of("park"), ("총무팀", "dept"))
        seat("park", team="회계팀")                        # 사람이 팀을 바꿈
        settings.set_department("park@x.com", "인사팀")
        office.default_teams({"park": "park@x.com"}, settings.departments())
        self.assertEqual(team_of("park"), ("회계팀", ""))

    def test_부서를_지워도_팀은_남는다(self):
        seat("choi")
        settings.set_department("choi@x.com", "엔지니어팀")
        office.default_teams({"choi": "choi@x.com"}, settings.departments())
        settings.set_department("choi@x.com", "")
        self.assertEqual(settings.departments(), {})
        office.default_teams({"choi": "choi@x.com"}, settings.departments())
        self.assertEqual(team_of("choi"), ("엔지니어팀", "dept"))


class LoginClaimTest(Base):
    def test_로그인_claim_의_department_를_적는다(self):
        from aas.auth.auth import Auth
        Auth._remember_department("a@x.com", {"department": "연구소"})
        self.assertEqual(settings.departments(), {"a@x.com": "연구소"})
        Auth._remember_department("a@x.com", {})
        self.assertEqual(settings.departments(), {})


if __name__ == "__main__":
    unittest.main()

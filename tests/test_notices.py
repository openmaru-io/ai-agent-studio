# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""관리자 공지 시험(스펙 2026-10-24-007, OMAI-1468).

- StoreTest: aas.ops.notices 의 기간 경계·대상 거르기·검사(field)·장애 닫기 불가·주소 허용 목록·다시 보이기·연장·내림·순서·부서 이름 옮기기
- ApiTest: 실제 AAS 서버 + 가짜 OIDC 공급자 + 가짜 Keycloak. 관리자만(403), 저장 응답의 대상 사람 수(R9), 연장 409, /api/me 의 notices,
  작업공간이 없는 사람의 서버 페이지 띠(이스케이프·시각·#/ 빼기), 관리 목록 1,000행 상한(R3)
"""
import aasserver  # 실제 uvicorn 앱을 띄우는 시험 하네스
import http.client
import json
import os
import tempfile
import time
import unittest
from datetime import datetime, timedelta, timezone
from http.server import ThreadingHTTPServer
from pathlib import Path
from unittest import mock
from urllib.parse import parse_qs, urlsplit

import test_auth as TA

TMP = tempfile.TemporaryDirectory()
os.environ["AAS_DATA_DIR"] = str(Path(TMP.name) / "data")

from aas.common import settings, store  # noqa: E402
from aas.ops import notices  # noqa: E402

T0 = datetime(2026, 10, 25, 12, 0, tzinfo=timezone.utc)


def iso(dt: datetime) -> str:
    return dt.isoformat()


def clear():
    with store.connect() as conn:
        conn.execute(notices.SCHEMA)
        conn.execute("DELETE FROM notices")
        for ddl in (settings._SCHEMA, settings.DEPT_SCHEMA, settings.GOAL_SCHEMA):
            conn.execute(ddl)
        for t in ("user_directory", "departments", "department_goals"):
            conn.execute(f"DELETE FROM {t}")
        conn.execute("DELETE FROM meta WHERE key LIKE 'departments_seeded' OR key LIKE 'rename_pending:%'")
    settings.reset_cache()


def make(at=T0, **kw):
    body = {"kind": "info", "title": "제목", "body": "", "starts_at": iso(at - timedelta(hours=1)), "ends_at": iso(at + timedelta(hours=1)),
            "audience": "all", "dismissible": True, **kw}
    return notices.save(body, "root@corp.example", ["개발팀", "영업팀"], at=at)


class StoreTest(unittest.TestCase):
    def setUp(self):
        clear()

    tearDown = setUp

    def test_shown_from_the_start_until_just_before_the_end(self):
        make(starts_at=iso(T0), ends_at=iso(T0 + timedelta(hours=2)), at=T0 - timedelta(hours=1))
        self.assertEqual(notices.for_user("", {}, at=T0 - timedelta(seconds=1)), [])          # 시작 직전
        self.assertEqual(len(notices.for_user("", {}, at=T0)), 1)                              # 시작 시각부터
        self.assertEqual(len(notices.for_user("", {}, at=T0 + timedelta(hours=2, seconds=-1))), 1)
        self.assertEqual(notices.for_user("", {}, at=T0 + timedelta(hours=2)), [])             # 끝 시각에 사라진다

    def test_department_notices_go_only_to_that_department_matched_by_team_key(self):
        make(title="전체")
        make(title="영업만", audience=["영업팀"])
        people = {"lee@corp.example": " 영업팀 ", "dev@corp.example": "개발팀"}
        titles = lambda email: sorted(n["title"] for n in notices.for_user(email, people, at=T0))   # noqa: E731
        self.assertEqual(titles("lee@corp.example"), ["영업만", "전체"])                     # 앞뒤 공백이 달라도 같은 부서
        self.assertEqual(titles("LEE@corp.example"), ["영업만", "전체"])                     # 이메일 대소문자
        self.assertEqual(titles("dev@corp.example"), ["전체"])
        self.assertEqual(titles("nobody@corp.example"), ["전체"])                           # 부서 없는 사람은 전체 공지만
        self.assertEqual(titles(""), ["전체"])                                             # 로그인을 끈 실행

    def test_people_get_only_public_fields(self):
        make(audience=["영업팀"])
        n = notices.for_user("lee@corp.example", {"lee@corp.example": "영업팀"}, at=T0)[0]
        self.assertEqual(set(n), set(notices.PUBLIC))                                      # 대상·쓴 사람은 가지 않는다(O7)

    def test_topic_view_filters_per_person_and_never_sends_the_people_map(self):
        make(title="전체")
        make(title="개발만", audience=["개발팀"])
        with mock.patch.object(notices, "now", return_value=T0):
            value = notices.topic_source({"dev@corp.example": "개발팀"})
            dev, other = notices.topic_view(value, "dev@corp.example"), notices.topic_view(value, "x@corp.example")
        self.assertEqual(value["people"], {"dev@corp.example": "개발팀"})
        self.assertEqual(sorted(n["title"] for n in dev), ["개발만", "전체"])
        self.assertEqual([n["title"] for n in other], ["전체"])
        self.assertNotIn("people", json.dumps(dev, ensure_ascii=False))

    def test_order_is_outage_maintenance_deprecation_feature_info_then_newest_start(self):
        for kind in ("info", "feature", "deprecation", "maintenance", "outage"):
            make(kind=kind, title=kind)
        make(kind="info", title="info-new", starts_at=iso(T0 - timedelta(minutes=5)))
        self.assertEqual([n["title"] for n in notices.for_user("", {}, at=T0)],
                         ["outage", "maintenance", "deprecation", "feature", "info-new", "info"])

    def test_outage_is_always_saved_not_dismissible(self):
        self.assertFalse(make(kind="outage", dismissible=True)["dismissible"])
        self.assertTrue(make(kind="maintenance", dismissible=True)["dismissible"])

    def test_link_allows_only_app_paths_and_http(self):
        self.assertEqual(make(link="#/agents")["link"], "#/agents")
        self.assertEqual(make(link="https://intra.example/notice")["link"], "https://intra.example/notice")
        for bad in ("javascript:alert(1)", "JAVASCRIPT:alert(1)", "data:text/html,x", "//evil.example", "/x", "https://a b"):
            with self.assertRaises(notices.NoticeError) as e:
                make(link=bad)
            self.assertEqual(e.exception.field, "link", bad)

    def test_check_errors_name_the_form_field(self):
        cases = [({"kind": "urgent"}, "kind"), ({"title": "  "}, "title"), ({"title": "가" * 81}, "title"), ({"body": "가" * 301}, "body"),
                 ({"ends_at": iso(T0 - timedelta(hours=1))}, "ends_at"),                     # 끝 = 시작
                 ({"starts_at": "2026-10-25T12:00:00"}, "starts_at"),                         # 시간대 없는 값
                 ({"audience": ["없는부서"]}, "audience"), ({"audience": []}, "audience")]
        for kw, field in cases:
            with self.assertRaises(notices.NoticeError) as e:
                make(**kw)
            self.assertEqual((e.exception.field, e.exception.code), (field, 400), kw)

    def test_a_new_notice_that_already_ended_is_refused(self):
        with self.assertRaises(notices.NoticeError) as e:
            make(starts_at=iso(T0 - timedelta(hours=3)), ends_at=iso(T0 - timedelta(hours=2)))
        self.assertEqual(e.exception.field, "ends_at")

    def test_body_newlines_are_folded_and_times_are_stored_in_utc(self):
        row = make(body="첫 줄\n둘째 줄", starts_at="2026-10-25T20:00:00+09:00", ends_at="2026-10-25T22:00:00+09:00",
                   at=datetime(2026, 10, 25, 10, 0, tzinfo=timezone.utc))
        self.assertEqual(row["body"], "첫 줄 둘째 줄")
        self.assertEqual((row["starts_at"], row["ends_at"]), ("2026-10-25T11:00:00+00:00", "2026-10-25T13:00:00+00:00"))

    def test_reshow_ts_changes_only_when_asked(self):
        row = make()
        first = row["reshow_ts"]
        later = T0 + timedelta(minutes=10)
        body = {**{k: row[k] for k in ("id", "kind", "title", "body", "link", "starts_at", "ends_at", "dismissible")}, "audience": "all"}
        kept = notices.save({**body, "title": "고침"}, "root@corp.example", [], at=later)
        self.assertEqual((kept["reshow_ts"], kept["updated_ts"]), (first, iso(later)))
        again = notices.save({**body, "reshow": True}, "root@corp.example", [], at=later + timedelta(minutes=1))
        self.assertEqual(again["reshow_ts"], iso(later + timedelta(minutes=1)))

    def test_extend_adds_one_hour_to_the_seen_end(self):
        row = make()
        seen = datetime.fromisoformat(row["ends_at"]).astimezone(timezone(timedelta(hours=9))).isoformat()   # 같은 시각, 다른 글자
        out = notices.extend(row["id"], seen, "root@corp.example", at=T0)
        self.assertEqual(out["ends_at"], iso(T0 + timedelta(hours=2)))

    def test_extend_with_an_old_end_is_a_conflict_so_two_clicks_do_not_add_two_hours(self):
        row = make()
        notices.extend(row["id"], row["ends_at"], "a", at=T0)
        with self.assertRaises(notices.NoticeError) as e:
            notices.extend(row["id"], row["ends_at"], "b", at=T0)
        self.assertEqual((e.exception.code, e.exception.reason), (409, "changed"))

    def test_extend_refuses_ended_and_removed_notices(self):
        row = make()
        with self.assertRaises(notices.NoticeError) as e:
            notices.extend(row["id"], row["ends_at"], "a", at=T0 + timedelta(hours=1))      # 끝 시각이 지났다
        self.assertEqual(e.exception.code, 400)
        notices.remove(row["id"], "a", at=T0)
        with self.assertRaises(notices.NoticeError) as e:
            notices.extend(row["id"], row["ends_at"], "a", at=T0)
        self.assertEqual(e.exception.code, 404)

    def test_remove_keeps_the_row_and_hides_it(self):
        row = make()
        gone = notices.remove(row["id"], "root@corp.example", at=T0)
        self.assertTrue(gone["deleted"])
        self.assertEqual(notices.for_user("", {}, at=T0), [])
        self.assertEqual(notices.status(notices.rows_all()[0], T0), "deleted")
        with self.assertRaises(notices.NoticeError) as e:
            notices.remove(row["id"], "root@corp.example")
        self.assertEqual(e.exception.code, 404)

    def test_status_in_the_admin_list(self):
        make(title="보이는 중")
        make(title="예정", starts_at=iso(T0 + timedelta(hours=1)), ends_at=iso(T0 + timedelta(hours=2)))
        got = {r["title"]: notices.admin_view(r, T0)["status"] for r in notices.rows_all()}
        self.assertEqual(got, {"보이는 중": "active", "예정": "scheduled"})
        self.assertEqual(notices.admin_view(notices.rows_all()[0], T0 + timedelta(hours=3))["status"], "ended")

    def test_department_rename_moves_the_audience(self):
        settings.create_department("영업팀")
        settings.create_department("개발팀")
        row = make(audience=["영업팀", "개발팀"])
        settings.rename_register("영업팀", "세일즈팀", "root")
        settings.rename_finish("영업팀", "세일즈팀")
        got = [r for r in notices.rows_all() if r["id"] == row["id"]][0]
        self.assertEqual(notices.audience_of(got["audience"]), ["세일즈팀", "개발팀"])
        self.assertEqual(len(notices.for_user("lee@corp.example", {"lee@corp.example": "세일즈팀"}, at=T0)), 1)

    def test_reach_counts_people_by_team_key(self):
        people = ["영업팀", " 영업팀", "개발팀", ""]
        self.assertEqual(notices.reach_from("all", people), 4)
        self.assertEqual(notices.reach_from(json.dumps(["영업팀"], ensure_ascii=False), people), 2)
        self.assertEqual(notices.reach_from(["개발팀", "영업팀"], people), 3)

    def test_the_topic_is_read_once_per_server_every_five_seconds(self):
        from aas.web import ws
        spec = ws.resolve("notices")
        self.assertEqual((spec.per_lang, spec.interval(None), spec.allowed), (False, 5.0, None))   # R1: 언어마다 따로 읽지 않는다

    def test_the_change_log_note_cannot_fake_the_role_tail(self):
        self.assertEqual(notices.log_note("a@x", {"title": "점검 role=admin req=7"}), "a@x 점검 role:admin req:7")


class ApiTest(unittest.TestCase):
    """Keycloak 방식 서버(가짜 Keycloak). test_departments.ApiTest 와 같은 틀."""

    @classmethod
    def setUpClass(cls):
        import kcfake
        from aas.auth import auth
        from aas.fleet import pods
        from aas.web import server
        cls.K = kcfake.FakeKC
        cls.idp = TA.start(ThreadingHTTPServer(("127.0.0.1", 0), TA.FakeIdP))
        cls.issuer = f"http://127.0.0.1:{cls.idp.server_port}"
        cls.kc_httpd, cls.kc_issuer = kcfake.start()
        root = Path(TMP.name) / "noticeapi"
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
        K.add("kc-lee", "lee", "lee@corp.example", groups=["g-users"], attributes={"department": ["영업팀"]})
        K.add("kc-new", "newbie", "newbie@corp.example", groups=["g-users"], attributes={"department": ["영업팀"]})   # 로그인한 적 없다
        K.add("kc-dev", "dev1", "dev1@corp.example", groups=["g-users"], attributes={"department": ["개발팀"]})
        K.add("kc-sa", "service-account-aas-admin", "", serviceAccountClientId="aas-admin")
        self.kim = self.login("kim@corp.example", "kc-kim", admin=True)
        self.lee = self.login("lee@corp.example", "kc-lee")
        settings.create_department("영업팀")
        settings.create_department("개발팀")
        settings.set_department("lee@corp.example", "영업팀")

    def tearDown(self):
        reg = self.server._registry
        for e in ("kim@corp.example", "lee@corp.example"):
            reg.grant(e, "none", [], "test")
        clear()

    def req(self, method, path, cookie="", body=None):
        c = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        h = {"Cookie": cookie} if cookie else {}
        if method != "GET":
            h["X-AAS"] = "1"
        c.request(method, path, body=json.dumps(body) if body is not None else None, headers=h)
        r = c.getresponse()
        data = r.read()
        c.close()
        return r.status, (json.loads(data) if data and r.getheader("Content-Type", "").startswith("application/json") else data)

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

    def save(self, cookie=None, **kw):
        now = datetime.now(timezone.utc)
        body = {"action": "save", "kind": "maintenance", "title": "판 올리기", "starts_at": iso(now - timedelta(minutes=5)),
                "ends_at": iso(now + timedelta(hours=2)), "audience": "all", **kw}
        return self.req("POST", "/api/notices", cookie or self.kim, body)

    def test_only_admins_list_and_write(self):
        self.assertEqual(self.req("GET", "/api/notices", self.lee)[0], 403)
        self.assertEqual(self.save(self.lee)[0], 403)
        code, out = self.req("GET", "/api/notices", self.kim)
        self.assertEqual((code, out["notices"], out["limit"]), (200, [], 1000))

    def test_save_answers_reach_from_keycloak_and_logs_the_change(self):
        code, out = self.save()
        self.assertEqual(code, 200, out)
        self.assertEqual(out["reach"], 4)                                                   # Keycloak 사용자 4명(서비스 계정 빼고, R9)
        code, out = self.save(audience=["영업팀"])
        self.assertEqual(out["reach"], 2)                                                   # 로그인한 적 없는 newbie 도 센다
        self.assertEqual(self.req("POST", "/api/notices", self.kim, {"action": "reach", "audience": ["개발팀"]})[1], {"reach": 1})
        n = self.req("GET", "/api/notices", self.kim)[1]["notices"][0]
        self.assertEqual(n["author"], "kim@corp.example")
        self.assertTrue(n["author_name"] and "@" not in n["author_name"])                 # 화면은 이메일 대신 이름을 보인다(작성자 열)
        with store.connect() as conn:
            kinds = [r["kind"] for r in conn.execute("SELECT kind FROM usage WHERE kind LIKE 'notice_%'").fetchall()]
        self.assertIn("notice_save", kinds)

    def test_save_errors_carry_the_field(self):
        code, out = self.save(link="javascript:alert(1)")
        self.assertEqual((code, out.get("field")), (400, "link"))
        code, out = self.save(ends_at=iso(datetime.now(timezone.utc) - timedelta(hours=1)))
        self.assertEqual((code, out.get("field")), (400, "ends_at"))

    def test_extend_conflict_and_remove(self):
        _, out = self.save()
        n = out["notice"]
        code, out = self.req("POST", "/api/notices", self.kim, {"action": "extend", "id": n["id"], "ends_at": n["ends_at"]})
        self.assertEqual(code, 200, out)
        self.assertEqual(datetime.fromisoformat(out["notice"]["ends_at"]) - datetime.fromisoformat(n["ends_at"]), timedelta(hours=1))
        code, out = self.req("POST", "/api/notices", self.kim, {"action": "extend", "id": n["id"], "ends_at": n["ends_at"]})
        self.assertEqual((code, out.get("reason")), (409, "changed"))
        code, out = self.req("POST", "/api/notices", self.kim, {"action": "remove", "id": n["id"]})
        self.assertEqual((code, out["notice"]["status"]), (200, "deleted"))

    def test_me_carries_notices_for_this_person_only(self):
        self.save(title="전체 공지")
        self.save(title="개발 공지", audience=["개발팀"])
        code, me = self.req("GET", "/api/me", self.lee)
        self.assertEqual(code, 200)
        self.assertEqual([n["title"] for n in me["notices"]], ["전체 공지"])
        self.assertNotIn("audience", me["notices"][0])

    def test_server_page_without_a_workspace_draws_an_escaped_band(self):
        self.save(title="<b>점검</b>", body="곧 끝납니다", link="#/agents")
        self.save(kind="info", title="안내", link="https://intra.example/x")
        r, page = self.req_raw("/", self.lee)                                               # lee 는 작업공간이 없다 — 서버가 그리는 안내 페이지
        text = page.decode()
        self.assertIn("aas-nbar", text)
        self.assertIn("&lt;b&gt;점검&lt;/b&gt;", text)
        self.assertNotIn("<b>점검</b>", text)
        self.assertNotIn("#/agents", text)                                                  # 작업공간이 없으면 갈 수 없는 경로는 뺀다
        self.assertIn("https://intra.example/x", text)
        self.assertIn("<time datetime=", text)
        self.assertIn("UTC+00:00", text)                                                    # 스크립트가 없을 때 보이는 글자
        self.assertNotIn('role="alert"', text)
        self.assertNotIn("role=status", text)

    def test_the_login_page_has_no_band(self):
        self.save(title="로그인 화면에는 없음")
        _, page = self.req_raw("/auth/login")
        self.assertNotIn("aas-nbar", page.decode())

    def test_admin_list_is_capped_at_one_thousand_rows(self):
        stamp = iso(datetime.now(timezone.utc))
        with store.connect() as conn:
            conn.execute(notices.SCHEMA)
            for i in range(1001):
                conn.execute("INSERT INTO notices (kind, title, starts_at, ends_at, ts, updated_ts, reshow_ts) VALUES (?,?,?,?,?,?,?)",
                             ("info", f"n{i}", f"2026-01-01T00:{i // 60:02d}:{i % 60:02d}+00:00", "2026-01-02T00:00:00+00:00", stamp, stamp, stamp))
        code, out = self.req("GET", "/api/notices", self.kim)
        self.assertEqual((code, len(out["notices"]), out["limited"]), (200, 1000, True))
        self.assertEqual(out["notices"][0]["title"], "n1000")                               # 시작이 늦은 것부터


if __name__ == "__main__":
    unittest.main()

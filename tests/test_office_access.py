# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""방 구성원 권한 시험(계획 003 §8-1, R9·R21): 누가 어느 에이전트를 보고 시킬 수 있는가, 칸반 카드는 실행할 때 다시 검사하는가."""
import os
import tempfile
import unittest
from pathlib import Path

TMP = tempfile.TemporaryDirectory()
os.environ.setdefault("AAS_DATA_DIR", str(Path(TMP.name) / "data"))

from aas.office import hub_auto, meeting, office, office_access, relay
from aas.web import server
from aas.common import db, settings, store  # noqa: E402
from aas.fleet.pods import Pod  # noqa: E402

try:
    from tests.test_hub_auto import FakeDash  # noqa: E402
except ImportError:                                            # unittest discover -s tests 로 돌릴 때
    from test_hub_auto import FakeDash  # noqa: E402

KNOWN = {"yj": {"sa", "ma"}, "scdf": {"scdf-doc"}}
ADMIN, A, B, C = "admin@x.com", "a@x.com", "b@x.com", "c@x.com"          # A 는 yj, B 는 scdf 의 주인, C 는 설치본이 없다


HOMES = {"yj": Path(TMP.name) / "yj", "scdf": Path(TMP.name) / "scdf"}
for _home, _profiles in ((HOMES["yj"], ("sa", "ma")), (HOMES["scdf"], ("scdf-doc",))):
    for _p in _profiles:
        (_home / "profiles" / _p).mkdir(parents=True, exist_ok=True)


class Reg:
    pods = [Pod("yj", A, HOMES["yj"]), Pod("scdf", B, HOMES["scdf"])]

    @staticmethod
    def is_admin(user):
        user = user or {}
        return bool(user.get("admin")) or user.get("email") == ADMIN       # 실제 Registry.is_admin 과 같다(세션의 관리자 표시를 따른다)

    grants: dict = {}                                                       # 접근 권한(access_grants.pods) 대역: {이메일: {pod id}}. 필요한 시험만 채운다

    @classmethod
    def allowed(cls, user, enabled):
        email = (user or {}).get("email")
        return list(cls.pods) if cls.is_admin(user) else [p for p in cls.pods if p.owner == email or p.id in cls.grants.get(email, ())]

    @classmethod
    def managed(cls, user, enabled):
        """주인인 것만(팀 관리자 없음). 접근 권한으로 받은 것은 뺀다."""
        email = (user or {}).get("email")
        return list(cls.pods) if cls.is_admin(user) else [p for p in cls.pods if p.owner == email]


def acc(email):
    return office_access.Access(Reg, {"email": email}, True)


class Stub:
    """회의 대역 — 접근 검사까지만 본다."""
    calls = []

    def view(self, room, after=0, thread=None):
        return {"room": {"id": room}, "messages": [], "pending": [], "participants": []}

    def threads(self, room):
        return {"threads": [], "current": 0}

    def new_thread(self, room, who):
        Stub.calls.append((room, who, "new_thread", None))
        return {"thread": 1}

    kw: dict = {}

    def say(self, room, who, text, targets=None, **kw):
        Stub.calls.append((room, who, text, targets))
        Stub.kw = kw
        return {"ok": True, "message": 1, "targets": targets or ["sa", "scdf-doc"]}


class AccessBase(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.dash = {"yj": FakeDash("yj"), "scdf": FakeDash("scdf")}
        cls._old = (server._registry, server._auto, server._meeting_obj)
        server._registry = Reg
        server._auto = hub_auto.Auto(relay.Bridge(Reg, lambda pod: None), lambda pod: cls.dash[pod])
        server._auto.allowed = server._owner_may_use
        server._meeting_obj = Stub()

    @classmethod
    def tearDownClass(cls):
        server._registry, server._auto, server._meeting_obj = cls._old
        cls.wipe()                                                # 데이터 폴더를 다른 시험과 함께 쓴다 — 남기지 않는다

    @staticmethod
    def wipe():
        with hub_auto._db() as conn:
            for t in ("office_seats", "office_rooms", "office_room_members", "office_card_owner", "office_people", "office_boards", "office_board_pods", "office_cards", "office_events", "office_cron"):
                conn.execute(f"DELETE FROM {t}")

    def setUp(self):
        self.wipe()
        office.set_seat({"pod": "yj", "profile": "sa"}, "me", KNOWN)
        office.set_seat({"pod": "yj", "profile": "ma"}, "me", KNOWN)
        office.set_seat({"pod": "scdf", "profile": "scdf-doc", "alias": "doc"}, "me", KNOWN)
        self.r1 = office.set_room({"name": "제안", "seats": ["sa", "doc"], "members": [C]}, "me")["id"]
        self.r2 = office.set_room({"name": "비공개", "seats": ["ma"]}, "me")["id"]
        Stub.calls.clear()

    def route(self, email, method, path, body=None):
        from urllib.parse import parse_qs, urlsplit
        url = urlsplit(path)
        return server._office_route(acc(email), method, url.path, parse_qs(url.query), body or {}, email)


class VisibilityTest(AccessBase):
    def test_보이는_자리는_내_설치본과_내가_구성원인_방(self):
        self.assertEqual(acc(ADMIN).visible_aliases(), {"sa", "ma", "doc"})
        self.assertEqual(acc(A).visible_aliases(), {"sa", "ma"})                 # 내 설치본(yj)
        self.assertEqual(acc(B).visible_aliases(), {"doc"})
        self.assertEqual(acc(C).visible_aliases(), {"sa", "doc"})                # 설치본은 없지만 방 구성원

    def test_끝난_방은_구성원이어도_자리가_보이지_않는다(self):
        office.set_room({"id": self.r1, "name": "제안", "seats": ["sa", "doc"], "status": "closed"}, "me")
        self.assertEqual(acc(C).visible_aliases(), set())

    def test_구성원에서_빠지면_바로_보이지_않는다(self):
        office.set_room({"id": self.r1, "name": "제안", "seats": ["sa", "doc"], "members": []}, "me")
        self.assertEqual(acc(C).visible_aliases(), set())
        self.assertEqual(acc(C).rooms(), [])

    def test_구성원은_이메일_모양만_받고_통째로_바뀐다(self):
        with self.assertRaises(office.OfficeError):
            office.set_room({"id": self.r1, "name": "제안", "members": ["김대리"]}, "me")
        office.set_room({"id": self.r1, "name": "제안", "members": [" A@X.com ", "a@x.com", "d@x.com"]}, "me")
        self.assertEqual(next(r for r in office.rooms() if r["id"] == self.r1)["members"], ["a@x.com", "d@x.com"])
        office.set_room({"id": self.r1, "name": "제안 2"}, "me")                  # members 를 보내지 않으면 그대로
        self.assertEqual(next(r for r in office.rooms() if r["id"] == self.r1)["members"], ["a@x.com", "d@x.com"])
        office.delete_room(self.r1)
        self.assertEqual(office.member_rooms("a@x.com"), set())

    def test_장면은_보이는_자리만_주고_내_것과_주인_이름을_붙인다(self):
        """보기 범위(스펙 2026-10-21-022 §3-1, 계획 007 R5 를 바꿈): 내 것·내 TFT 방·내 부서 팀 자리만. 주인 이메일은 관리자만(R6)."""
        from unittest import mock
        office.person_touch(A, "에이")
        agents = [{"alias": "sa", "pod": "yj", "profile": "sa", "status": "idle"}, {"alias": "doc", "pod": "scdf", "profile": "scdf-doc", "status": "working"},
                  {"alias": "ma", "pod": "yj", "profile": "ma", "status": "idle"}]
        with mock.patch.object(server, "_office_snapshot", return_value={"agents": agents, "seq": 1}):
            c = server._office_snapshot_for(acc(C))
            a = server._office_snapshot_for(acc(A))
            admin = server._office_snapshot_for(acc(ADMIN))
        self.assertEqual([x["alias"] for x in c["agents"]], ["sa", "doc"])                     # C 는 구성원인 방(제안)의 자리만, 비공개 방의 ma 는 없다
        self.assertEqual([x["alias"] for x in admin["agents"]], ["sa", "doc", "ma"])
        self.assertEqual([x["owner_name"] for x in c["agents"]], ["에이", "b"])                # 이름을 모르면 이메일 앞부분
        self.assertEqual([x["mine"] for x in a["agents"]], [True, True])                      # A 는 yj 의 sa·ma 만(doc 는 B 의 것)
        self.assertTrue(all("owner_email" not in x and "@" not in x["owner_name"] for x in c["agents"]))
        self.assertEqual(admin["agents"][0]["owner_email"], A)

    def test_받은편지함은_내가_맡긴_카드와_내게_온_승인만_주고_남은_답하지_못한다(self):
        """계획 007 P4: 받는 사람별로 거른다. 승인 답은 채팅 채널의 approve 로 넘긴다."""
        from unittest import mock
        with hub_auto._db() as conn:
            conn.execute("INSERT INTO office_cards (board, task_id, pod, status, assignee, title) VALUES ('bd','t1','yj','review','sa','검토할 보고서')")
            conn.execute("INSERT INTO office_cards (board, task_id, pod, status, assignee, title) VALUES ('bd','t2','yj','review','sa','남의 카드')")
        with office.connect() as conn:
            conn.execute("INSERT INTO office_card_owner (board, task_id, email, ts) VALUES ('bd','t1',?,'t')", (A,))
            conn.execute("INSERT INTO office_card_owner (board, task_id, email, ts) VALUES ('bd','t2',?,'t')", (B,))
        server.INBOX.on_chat("yj", "s1", "sa", A, "aas.user", {"_by": A})
        server.INBOX.on_chat("yj", "s1", "sa", A, "approval.request", {"request_id": "r1", "command": "ls"})
        try:
            with mock.patch.object(server, "_health", return_value={"failed_jobs": [{"profile": "sa", "job_id": "j1", "job": "아침 보고", "error": "x"}]}):
                got = server._office_inbox(Reg, {"email": A})["items"]
            self.assertEqual(sorted(i["kind"] for i in got), ["approval", "cron_failed", "review"])
            self.assertEqual(server._office_inbox(Reg, {"email": C})["items"], [])
            item = next(i for i in got if i["kind"] == "approval")
            with self.assertRaises(office_access.Denied):
                server._office_inbox_answer(Reg, {"email": C}, True, {"id": item["id"], "choice": "once"})
            fake = mock.Mock()
            fake.approve.return_value = {"ok": 1}
            with mock.patch.object(server, "hub", return_value=fake):
                server._office_inbox_answer(Reg, {"email": A}, True, {"id": item["id"], "choice": "once"})
            fake.approve.assert_called_once_with("s1", "once", "r1")
        finally:
            server.INBOX.on_chat("yj", "s1", "sa", A, "message.complete", {})
            with hub_auto._db() as conn:
                conn.execute("DELETE FROM office_cards WHERE board='bd'")

    def test_다른_서버에_열린_대화의_승인도_여기서_답하면_그_서버가_처리한다(self):
        """복제본 2개(OMAI-1105): 대화는 서버 A 에, 답하는 사람은 서버 B 에 붙었다. B 는 DB 에 답을 적고 A 의 처리 결과를 돌려준다."""
        import threading
        from unittest import mock
        from aas.office import inbox, shared
        other = shared.Shared("other-server")
        other.heartbeat()
        pa = inbox.Pending(shared=other)
        pa.on_chat("yj", "s9", "sa", A, "aas.user", {"_by": A})
        pa.on_chat("yj", "s9", "sa", A, "approval.request", {"request_id": "r9", "command": "ls"})
        item_id = inbox.Pending.item_id("yj", "s9", "r9")
        self.assertEqual([i["id"] for i in server.INBOX.for_person(A) if i["id"] == item_id], [item_id])   # B 에서도 보인다
        fake = mock.Mock()
        fake.approve.return_value = {"ok": 1}

        def server_a():                                    # 서버 A 의 shared_tick 이 하는 일
            for _ in range(50):
                for ans in other.answers_for_me():
                    other.answer_done(ans["id"], server._inbox_apply(Reg, pa.local(ans["id"]), ans["body"]))
                    return
                threading.Event().wait(0.05)
        t = threading.Thread(target=server_a)
        try:
            with mock.patch.object(server, "hub", return_value=fake):
                t.start()
                out = server._office_inbox_answer(Reg, {"email": A}, True, {"id": item_id, "choice": "session"})
                t.join(5)
            self.assertEqual(out, {"ok": True, "result": {"ok": 1}})
            fake.approve.assert_called_once_with("s9", "session", "r9")
        finally:
            pa.on_chat("yj", "s9", "sa", A, "message.complete", {})

    def test_장면_카드_목록은_칸반과_같은_규칙으로_거른다(self):
        with hub_auto._db() as conn:
            conn.execute("INSERT INTO office_boards (slug, ts) VALUES ('bx','t')")
            conn.execute("INSERT INTO office_cards (board, task_id, pod, status, assignee, title) VALUES ('bx','1','yj','running','ma','비공개 방 카드')")
            conn.execute("INSERT INTO office_cards (board, task_id, pod, status, assignee, title) VALUES ('bx','2','yj','todo','sa','제안 방 카드')")
            conn.execute("INSERT INTO office_cards (board, task_id, pod, status, assignee, title) VALUES ('bx','3','yj','todo','','담당 없음')")
        try:
            self.assertEqual([c["title"] for c in server._office_cards(acc(C))["cards"]], ["제안 방 카드", "담당 없음"])
            self.assertEqual(len(server._office_cards(acc(ADMIN))["cards"]), 3)
        finally:
            with hub_auto._db() as conn:
                conn.execute("DELETE FROM office_cards WHERE board='bx'")
                conn.execute("DELETE FROM office_boards WHERE slug='bx'")

    def test_장면_안_대화는_주인과_방_구성원만_하고_남의_에이전트는_기록에_남긴다(self):
        """계획 007 P2·H4: 채팅 API 는 주인·grants 만이라, 방 구성원은 오피스 경로로 말한다."""
        from unittest import mock
        turn = relay.Turn("run_x", "sa", "ofc")
        turn.add("delta", "안녕")
        turn.add("final", "안녕하세요")
        bridge = server._auto.bridge
        with mock.patch.object(bridge, "start", return_value=turn) as start, \
             mock.patch.object(bridge, "turn", side_effect=lambda tid, alias: turn if tid == "run_x" and alias == "sa" else None), \
             mock.patch.object(server.store, "log_usage") as log:
            with self.assertRaises(office_access.Denied):
                server._office_route(acc(C), "POST", "/api/office/chat/send", {}, {"alias": "ma", "text": "x"}, C)   # 비공개 방
            status, out = server._office_route(acc(C), "POST", "/api/office/chat/send", {}, {"alias": "sa", "text": "안녕"}, C)
            self.assertEqual((status, out), (202, {"turn": "run_x"}))
            self.assertEqual(start.call_args.kwargs["by"], C)                        # 승인 요청이 C 의 받은편지함으로 간다
            self.assertTrue(any(c.args[0] == "office_command" for c in log.call_args_list))
            status, out = server._office_route(acc(C), "GET", "/api/office/chat/turn", {"alias": ["sa"], "turn": ["run_x"], "after": ["0"]}, {}, C)
            self.assertEqual(([i["kind"] for i in out["items"]], out["done"]), (["delta", "final"], True))
            log.reset_mock()
            server._office_route(acc(A), "POST", "/api/office/chat/send", {}, {"alias": "sa", "text": "내 것"}, A)
            self.assertFalse(any(c.args[0] == "office_command" for c in log.call_args_list))   # 주인은 기록 대상이 아니다

    def test_주인_관리자가_아닌_사람의_오피스_대화는_위키_쓰기_도구를_막는다(self):
        """스펙 2026-10-23-004 15-9: 방 구성원이 남의 에이전트에게 시키면 주인의 위키 계정으로 쓰지 못한다. 읽기는 그대로다."""
        from unittest import mock
        turn = relay.Turn("run_w", "sa", "ofc")
        turn.add("final", "ok")
        bridge = server._auto.bridge
        with mock.patch.object(bridge, "start", return_value=turn) as start, mock.patch.object(server.store, "log_usage"):
            server._office_route(acc(C), "POST", "/api/office/chat/send", {}, {"alias": "sa", "text": "써 줘"}, C)
            blocked = start.call_args.kwargs["blocked_tools"]
            for t in ("mcp__*__create_document", "mcp__*__update_document", "mcp__*__delete_document", "mcp__*__create_page"):
                self.assertIn(t, blocked)
            self.assertFalse([t for t in blocked if t.split("__")[-1] in ("fetch", "list_documents", "search_pages", "get_page")])
            for who in (A, ADMIN):                                               # 주인·관리자는 막지 않는다
                server._office_route(acc(who), "POST", "/api/office/chat/send", {}, {"alias": "sa", "text": "써 줘"}, who)
                self.assertNotIn("blocked_tools", start.call_args.kwargs)

    def test_개요는_보이는_것만_주고_구성원_이메일은_관리자만_본다(self):
        c = server._office(Reg, {"email": C}, True)
        self.assertEqual({s["alias"] for s in c["seats"]}, {"sa", "doc"})
        self.assertEqual([r["name"] for r in c["rooms"]], ["제안"])
        self.assertTrue(all("members" not in r for r in c["rooms"]))
        # 2026-10-18: 사람은 구성원(이메일)에서 만들어지므로 관리자가 아닌 사람에게는 표시 이름만 간다(이메일 전체는 관리자만, 계획 007 R6)
        self.assertTrue(all("@" not in x for r in c["rooms"] for x in [*r["people"], r["owner"]]), c["rooms"])
        self.assertEqual((c["can_edit"], c["can_act"], c["pins"], c["problems"]), (False, True, {}, []))
        admin = server._office(Reg, {"email": ADMIN}, True)
        self.assertEqual(next(r for r in admin["rooms"] if r["id"] == self.r1)["members"], [C])
        self.assertTrue(admin["can_edit"])
        self.assertTrue(admin["pods"] and all(p["primary"] for p in admin["pods"]))   # TFT 방이 구성원의 주 프로파일 자리를 고를 때 쓴다(2026-10-18)

    def test_일반_사용자는_담당_없는_카드를_만들_수_없다(self):
        """담당 없는 카드는 첫 번째 설치본(다른 사람의 Hermes)에 들어가 분류 대기로 남는다(스펙 2026-10-17-003 P3, D2)."""
        board = "office-bbbbbbbbbbbb"
        self.route(ADMIN, "POST", "/api/office/kanban/boards", {"slug": board, "name": "t"})
        with self.assertRaises(office_access.Denied) as cm:
            self.route(A, "POST", f"/api/office/kanban/tasks?board={board}", {"title": "담당 없음"})
        self.assertEqual(cm.exception.code, 400)
        st, out = self.route(ADMIN, "POST", f"/api/office/kanban/tasks?board={board}", {"title": "관리자는 비워도 된다"})
        self.assertEqual((st, out["task"]["status"]), (201, "triage"))

    def test_개요는_내_자리를_알려_준다(self):
        """「카드 추가」 담당의 처음 값(스펙 2026-10-17-003 P2). 내 설치본의 자리, 없으면 빈 값."""
        self.assertEqual(server._office(Reg, {"email": A}, True)["my_seat"], "ma")      # 주 프로파일 자리가 없으면 이름 순 첫 자리
        self.assertEqual(server._office(Reg, {"email": B}, True)["my_seat"], "doc")
        self.assertEqual(server._office(Reg, {"email": C}, True)["my_seat"], "")
        self.assertEqual(server._office(Reg, {"email": ADMIN}, True)["my_seat"], "")

    def test_장면_이벤트는_종류별_공개_범위를_따른다(self):
        """하나의 오피스(계획 007 R5): 자리·상태·도구 이름은 모두에게, 답 글은 대화 당사자·주인만(R1), 표에 없는 종류는 아무에게도(M2)."""
        view = office_access.event_view
        self.assertEqual(view("agent.status", {"alias": "ma", "status": "error"}, "x@y.com", False), {"alias": "ma", "status": "error"})
        self.assertEqual(view("tool", {"alias": "ma", "name": "web"}, "", False), {"alias": "ma", "name": "web"})
        delta = {"alias": "ma", "text": "답", "_to": ["me@x.com", "owner@x.com"]}
        self.assertEqual(view("chat.delta", delta, "ME@x.com", False), {"alias": "ma", "text": "답"})     # _to 는 빼고 보낸다
        self.assertIsNone(view("chat.delta", delta, "other@x.com", False))
        self.assertEqual(view("chat.delta", delta, "", True), {"alias": "ma", "text": "답"})
        self.assertIsNone(view("새로운.종류", {"alias": "ma"}, "me@x.com", True))


class SceneScopeTest(AccessBase):
    """3D 장면의 보기 범위(스펙 2026-10-21-022): 내 것 + 열린 TFT 방 자리 + 자리 팀이 내 부서와 같은 자리. 시키는 범위는 그대로."""
    D, E = "d@x.com", "e@x.com"                                     # D 는 설치본도 방도 없고 부서만 있다

    def setUp(self):
        super().setUp()
        self.depts = []

    def tearDown(self):
        with store.connect() as conn:                               # 부서 표는 다른 시험과 함께 쓴다 — 넣은 것만 지운다
            for email in self.depts:
                conn.execute("DELETE FROM user_directory WHERE email=?", (email,))
        settings.reset_cache()

    def dept(self, email, name):
        settings.set_department(email, name)
        self.depts.append(email.lower())

    def team(self, alias, pod, profile, name):
        office.set_seat({"pod": pod, "profile": profile, "alias": alias, "team": name}, "me", KNOWN)

    def test_같은_부서_팀_자리는_보이고_시키지는_못한다(self):
        self.dept(self.D, "개발본부")
        self.team("ma", "yj", "ma", " 개발본부 ")                     # 앞뒤 공백·대소문자는 가리지 않는다(team_key)
        self.team("sa", "yj", "sa", "영업")
        self.assertEqual(acc(self.D).scene_aliases(), {"ma"})
        self.assertEqual(acc(self.D).visible_aliases(), set())      # 같은 부서라도 시킬 수는 없다(계획 2026-10-13-011 리뷰 A1)
        self.assertEqual(acc(A).scene_aliases(), {"sa", "ma"})       # 내 것은 부서와 상관없이

    def test_부서가_없으면_내_것과_TFT_방_자리만(self):
        self.team("ma", "yj", "ma", "")
        self.assertEqual(acc(C).scene_aliases(), {"sa", "doc"})      # 팀이 빈 자리와 빈 부서를 같다고 보지 않는다(D3)
        self.assertEqual(acc(self.E).scene_aliases(), set())

    def test_관리자와_로그인을_끈_실행은_모든_자리(self):
        self.assertEqual(acc(ADMIN).scene_aliases(), {"sa", "ma", "doc"})
        self.assertEqual(office_access.Access(Reg, None, False).scene_aliases(), {"sa", "ma", "doc"})

    def test_끝난_TFT_방의_자리는_보이지_않는다(self):
        office.set_room({"id": self.r1, "name": "제안", "seats": ["sa", "doc"], "status": "closed"}, "me")
        self.assertEqual(acc(C).scene_aliases(), set())

    def test_80자를_넘는_부서도_같은_팀으로_본다(self):
        long = "가" * 90
        self.dept(self.D, long)
        self.team("ma", "yj", "ma", long)                           # 자리 팀은 80자로 잘려 들어간다(office._text)
        self.assertEqual(acc(self.D).scene_aliases(), {"ma"})

    def test_비구성원_회의_행은_보이는_자리로_줄이고_행은_남긴다(self):
        rows = [{"room": self.r2, "seats": ["ma"], "name": "비공개", "partial": {"ma": "…"}, "last": []},
                {"room": self.r1, "seats": ["sa", "doc"], "name": "제안", "partial": {}, "last": []}]
        out = server.meeting_active_for(rows, acc(C))["meetings"]
        self.assertEqual(out[0], {"room": self.r2, "seats": []})        # 명패 「회의 중」은 room 으로 정해진다 — 행은 남긴다(리뷰 R2)
        self.assertEqual(out[1]["seats"], ["sa", "doc"])                # 구성원 방은 그대로
        self.assertEqual(server.meeting_active_for(rows, acc(ADMIN))["meetings"][0]["seats"], ["ma"])

    def test_사람_목록은_같은_부서와_같은_TFT_구성원만(self):
        from aas.office import presence
        old = server.PRESENCE
        server.PRESENCE = presence.Presence()
        everyone = (A, B, C, self.D, ADMIN)
        try:
            self.dept(self.D, "개발본부")
            self.dept(B, "개발본부")
            office.set_room({"id": self.r1, "name": "제안", "seats": ["sa", "doc"], "members": [C, A]}, "me")
            for email in everyone:
                server.PRESENCE.beat(email, email.split("@")[0], "")
            names = lambda email: sorted(p["name"] for p in server._office_people(acc(email)))   # noqa: E731
            self.assertEqual(names(self.D), ["b", "d"])                 # 같은 부서
            self.assertEqual(names(C), ["a", "c"])                      # 같은 TFT 구성원
            self.assertEqual(names(ADMIN), ["a", "admin", "b", "c", "d"])
            self.assertTrue(all("email" not in p for p in server._office_people(acc(C))))
            self.assertTrue(all("email" in p for p in server._office_people(acc(ADMIN))))
        finally:
            for email in everyone:
                server.PRESENCE.leave(email)
            server.PRESENCE = old

    def test_자리_팀을_바꾸면_장면이_다시_받는다(self):
        seq = server.OFFICE.bus.seq
        server._office_action(Reg, {"action": "seat.set", "pod": "yj", "profile": "ma", "alias": "ma", "team": "개발본부"}, "me")
        self.assertIn("desks.changed", [e["type"] for e in server.OFFICE.bus.after(seq, wait=0)])

    # ---- 관리자의 부서 고르기(스펙 2026-10-22-002) ----
    def test_관리자_오피스_자료에_방_구성원_부서와_부서_이름을_싣는다(self):
        """A1·A8: 관리자 /api/office 의 rooms[].teams(구성원 부서 team_key, 80자 자름, 부서 없는 구성원 제외)와 departments."""
        long = "나" * 90
        self.dept(C, " 개발본부 ")
        self.dept(self.D, long)
        office.set_room({"id": self.r1, "name": "제안", "seats": ["sa", "doc"], "members": [C, self.D, self.E]}, "me")
        out = server._office_base(Reg, {"email": ADMIN}, True)
        r1 = next(r for r in out["rooms"] if r["id"] == self.r1)
        self.assertEqual(sorted(r1["teams"]), sorted(["개발본부", "나" * 80]))      # E 는 부서가 없어 빠진다
        self.assertEqual(next(r for r in out["rooms"] if r["id"] == self.r2)["teams"], [])
        user = server._office_base(Reg, {"email": C}, True)
        self.assertNotIn("departments", user)
        self.assertTrue(all("teams" not in r for r in user["rooms"]))

    def test_고를_부서는_AAS_부서_목록이고_내_부서가_없으면_더한다(self):
        """A8(사용자 정정 2026-10-22): 사람 부서 기록·자리 팀은 목록에 넣지 않는다 — 옛 시험 계정의 부서(OKE 「AAS 개발부」)가 섞였다.
        관리자 본인 부서가 목록에 없을 때만 그 하나를 더해 처음 값(D1)이 「전체」로 떨어지지 않게 한다."""
        from unittest import mock
        self.dept(C, "옛부서")                                       # 사람 부서 기록에만 있다
        self.team("ma", "yj", "ma", "자리팀")                         # 자리 팀에만 있다
        self.dept(ADMIN, "운영본부")                                  # 관리자 본인 부서, 목록에 없다
        # 부서 목록은 대역으로 둔다 — 시험 DB 는 Keycloak 옮기기 완료 표시가 없어, set_department 뒤 department_rows 가 사람 부서를 목록으로 다시 옮긴다
        with mock.patch.object(settings, "department_rows", return_value=[{"name": "기획실", "goal": "", "ts": ""}]):
            names = server._office_base(Reg, {"email": ADMIN}, True)["departments"]
        self.assertIn("기획실", names)
        self.assertIn("운영본부", names)
        self.assertNotIn("옛부서", names)
        self.assertNotIn("자리팀", names)

    def test_관리자_사람_목록에는_부서가_있고_일반_사용자에게는_없다(self):
        """A2: 관리자가 부서로 사람 아바타를 거를 수 있게 한다. 일반 사용자 응답에는 부서도 이메일도 없다."""
        from aas.office import presence
        old = server.PRESENCE
        server.PRESENCE = presence.Presence()
        try:
            self.dept(C, "개발본부")
            for email in (C, ADMIN):
                server.PRESENCE.beat(email, email.split("@")[0], "")
            admin_rows = {p["email"]: p for p in server._office_people(acc(ADMIN))}
            self.assertEqual((admin_rows[C]["department"], admin_rows[ADMIN]["department"]), ("개발본부", ""))
            self.assertTrue(all("department" not in p and "email" not in p for p in server._office_people(acc(C))))
        finally:
            for email in (C, ADMIN):
                server.PRESENCE.leave(email)
            server.PRESENCE = old


class OwnerRecheckTest(AccessBase):
    def test_Keycloak_역할로_관리자인_사람이_맡긴_카드는_다시_점검에서_막히지_않는다(self):
        """관리자 신분은 세션(토큰의 역할)에만 있다. 20초 주기 점검이 이메일만 넘기면 관리자가 맡긴 카드가 모두 막힘으로 간다(OKE 실측)."""
        import time
        from aas.auth import auth
        auth.Auth()                                                           # auth_sessions 표를 만든다
        with store.connect() as conn:
            conn.execute(db.upsert("auth_sessions", ("hash", "email", "name", "created", "expires", "sub", "admin"), ("hash",)),
                         ("h-boss", "kc-boss@x.com", "", time.time(), time.time() + 3600, "s1", 1))
            conn.execute(db.upsert("auth_sessions", ("hash", "email", "name", "created", "expires", "sub", "admin"), ("hash",)),
                         ("h-old", "kc-old@x.com", "", time.time() - 7200, time.time() - 3600, "s2", 1))
        try:
            self.assertTrue(server._owner_may_use("kc-boss@x.com", "아무-자리"))
            self.assertFalse(server._owner_may_use("kc-old@x.com", "아무-자리"))       # 만료된 세션의 관리자 표시는 믿지 않는다
            self.assertFalse(server._owner_may_use("kc-none@x.com", "아무-자리"))
        finally:
            with store.connect() as conn:
                conn.execute("DELETE FROM auth_sessions WHERE hash IN ('h-boss','h-old')")


class MeetingAccessTest(AccessBase):
    def test_구성원만_회의를_보고_말한다(self):
        self.assertEqual(self.route(C, "GET", f"/api/office/meeting?room={self.r1}")[0], 200)
        self.assertEqual(self.route(C, "POST", "/api/office/meeting/say", {"room": self.r1, "text": "안녕"})[0], 202)
        for who in (A, B):
            with self.assertRaises(office_access.Denied) as cm:
                self.route(who, "GET", f"/api/office/meeting?room={self.r1}")
            self.assertEqual(cm.exception.code, 403)
        with self.assertRaises(office_access.Denied):
            self.route(A, "POST", "/api/office/meeting/say", {"room": self.r1, "text": "x"})
        self.assertEqual([c[:2] for c in Stub.calls], [(self.r1, C)])             # 거절된 말은 중계되지 않는다
        # 「새 대화」·「지난 대화」도 방 구성원만(스펙 2026-10-20-027 D5·DR7)
        self.assertEqual(self.route(C, "GET", f"/api/office/meeting/threads?room={self.r1}")[0], 200)
        self.assertEqual(self.route(C, "GET", f"/api/office/meeting?room={self.r1}&thread=0")[0], 200)
        self.assertEqual(self.route(C, "POST", "/api/office/meeting/new", {"room": self.r1})[0], 200)
        for path, method, body in ((f"/api/office/meeting/threads?room={self.r1}", "GET", None), ("/api/office/meeting/new", "POST", {"room": self.r1})):
            with self.assertRaises(office_access.Denied) as cm:
                self.route(A, method, path, body)
            self.assertEqual(cm.exception.code, 403)
        self.assertEqual([c[:3] for c in Stub.calls][-1], (self.r1, C, "new_thread"))

    def test_회의는_말한_사람이_관리하는_자리를_넘긴다(self):
        """스펙 2026-10-23-004 15-9: 관리하지 않는 에이전트에게는 위키 쓰기 도구를 막고 보낸다."""
        self.route(C, "POST", "/api/office/meeting/say", {"room": self.r1, "text": "안녕"})
        self.assertEqual(Stub.kw["managed"], set())                              # C 는 방 구성원일 뿐이다
        self.route(ADMIN, "POST", "/api/office/meeting/say", {"room": self.r1, "text": "안녕"})
        self.assertEqual(Stub.kw["managed"], {"sa", "ma", "doc"})

    def test_관리자는_모든_방에_들어가고_없는_방은_404(self):
        self.assertEqual(self.route(ADMIN, "GET", f"/api/office/meeting?room={self.r2}")[0], 200)
        with self.assertRaises(office_access.Denied) as cm:
            self.route(ADMIN, "GET", "/api/office/meeting?room=999")
        self.assertEqual(cm.exception.code, 404)

    def test_남의_에이전트를_시킨_회의는_변경_기록에_남는다(self):
        self.route(C, "POST", "/api/office/meeting/say", {"room": self.r1, "text": "안녕", "targets": ["sa"]})
        with store.connect() as conn:
            notes = [r["note"] for r in conn.execute("SELECT note FROM usage WHERE kind='office_command'")]
        self.assertTrue(any(n == f"{C} sa" for n in notes), notes)


class CronAndKanbanAccessTest(AccessBase):
    def test_크론은_보이는_자리에만(self):
        self.assertEqual(self.route(C, "GET", "/api/office/cron/sa/jobs")[0], 200)
        with self.assertRaises(office_access.Denied):
            self.route(C, "GET", "/api/office/cron/ma/jobs")                      # ma 는 비공개 방의 자리
        self.assertEqual(self.route(A, "GET", "/api/office/cron/ma/jobs")[0], 200)  # 주인

    def test_크론_쓰기는_관리자와_주인만(self):
        """R1(스펙 2026-10-15-003): 같은 방 구성원(C)은 sa 의 크론을 읽을 수 있어도(R7) 만들거나 바꿀 수 없다."""
        new = {"name": "n", "schedule": "every 1h", "prompt": "x"}
        for who, alias in ((C, "sa"), (B, "sa")):                                  # 같은 방 구성원, 남의 파드 주인
            for method, path, body in (("POST", f"/api/office/cron/{alias}/jobs", new), ("PUT", f"/api/office/cron/{alias}/jobs/j1", {"updates": {"prompt": "y"}}),
                                       ("DELETE", f"/api/office/cron/{alias}/jobs/j1", {}), ("POST", f"/api/office/cron/{alias}/jobs/j1/run", {})):
                with self.assertRaises(office_access.Denied, msg=(who, method, path)):
                    self.route(who, method, path, body)
        self.assertEqual(self.route(A, "POST", "/api/office/cron/sa/jobs", new)[0], 201)      # 주인
        self.assertEqual(self.route(ADMIN, "POST", "/api/office/cron/sa/jobs", new)[0], 201)  # 관리자

    def test_주인의_전달_대상은_local_origin_채널_이름만(self):
        base = {"name": "n", "schedule": "every 1h", "prompt": "x"}
        with self.assertRaises(hub_auto.Fail) as cm:
            self.route(A, "POST", "/api/office/cron/sa/jobs", {**base, "deliver": "telegram:123"})
        self.assertEqual(cm.exception.status, 400)
        with self.assertRaises(hub_auto.Fail):
            self.route(A, "PUT", "/api/office/cron/sa/jobs/j1", {"updates": {"deliver": "bot-chat:ma"}})
        self.assertEqual(self.route(A, "POST", "/api/office/cron/sa/jobs", {**base, "deliver": "local"})[0], 201)
        self.assertEqual(self.route(ADMIN, "POST", "/api/office/cron/sa/jobs", {**base, "deliver": "telegram:123"})[0], 201)

    def test_카드는_보이는_자리에만_맡기고_보이지_않는_카드는_보드에서_빠진다(self):
        board = "office-aaaaaaaaaaaa"
        self.route(ADMIN, "POST", "/api/office/kanban/boards", {"slug": board, "name": "t"})
        st, mine = self.route(C, "POST", f"/api/office/kanban/tasks?board={board}", {"title": "내 일", "assignee": "sa"})
        self.assertEqual(st, 201)
        with self.assertRaises(office_access.Denied):
            self.route(C, "POST", f"/api/office/kanban/tasks?board={board}", {"title": "남의 일", "assignee": "ma"})
        self.route(ADMIN, "POST", f"/api/office/kanban/tasks?board={board}", {"title": "비공개 일", "assignee": "ma"})
        _, view = self.route(C, "GET", f"/api/office/kanban/board?board={board}")
        titles = sorted(t["title"] for c in view["columns"] for t in c["tasks"])
        self.assertEqual(titles, ["내 일"])
        _, full = self.route(ADMIN, "GET", f"/api/office/kanban/board?board={board}")
        self.assertEqual(sorted(t["title"] for c in full["columns"] for t in c["tasks"]), ["내 일", "비공개 일"])
        # 비공개 카드의 상세·변경은 거절
        ma_id = next(t["id"] for c in full["columns"] for t in c["tasks"] if t["title"] == "비공개 일")
        for method, path in (("GET", f"/api/office/kanban/tasks/{ma_id}?board={board}"), ("DELETE", f"/api/office/kanban/tasks/{ma_id}?board={board}")):
            with self.assertRaises(office_access.Denied):
                self.route(C, method, path)
        # 담당을 보이지 않는 자리로 바꾸는 것도 거절
        with self.assertRaises(office_access.Denied):
            self.route(C, "POST", f"/api/office/kanban/tasks/{mine['task']['id']}/reassign?board={board}", {"profile": "ma"})

    def test_보드_만들기·실행·이름_바꾸기는_관리자만(self):
        """OMAI-1122(스펙 2026-10-13-012 D3): 예전에는 보드 만들기·dispatch 를 누구나 했다."""
        board = "office-bbbbbbbbbbbb"
        with self.assertRaises(office_access.Denied):
            self.route(C, "POST", "/api/office/kanban/boards", {"slug": board, "name": "내 보드"})
        self.route(ADMIN, "POST", "/api/office/kanban/boards", {"slug": board, "name": "내 보드"})
        with self.assertRaises(office_access.Denied):
            self.route(C, "POST", f"/api/office/kanban/dispatch?board={board}", {})
        with self.assertRaises(office_access.Denied):
            self.route(C, "PATCH", f"/api/office/kanban/boards/{board}", {"name": "바꿈"})
        self.assertEqual(self.route(ADMIN, "PATCH", f"/api/office/kanban/boards/{board}", {"name": "바꿈"})[0], 200)

    def test_맡긴_사람이_방에서_빠지면_실행할_때_카드가_보류된다(self):
        board = "office-cccccccccccc"
        self.route(ADMIN, "POST", "/api/office/kanban/boards", {"slug": board, "name": "t"})
        _, made = self.route(C, "POST", f"/api/office/kanban/tasks?board={board}", {"title": "방 일", "assignee": "sa"})
        tid = made["task"]["id"]
        _, adm = self.route(ADMIN, "POST", f"/api/office/kanban/tasks?board={board}", {"title": "관리자 일", "assignee": "sa"})
        office.set_room({"id": self.r1, "name": "제안", "seats": ["sa", "doc"], "members": []}, "me")      # C 가 방에서 빠졌다
        _, out = self.route(ADMIN, "POST", f"/api/office/kanban/dispatch?board={board}", {})
        spawned = {s["task_id"] for s in out["spawned"]}
        self.assertNotIn(tid, spawned)                                                # C 의 카드는 실행되지 않았다
        self.assertIn(adm["task"]["id"], spawned)                                     # 관리자가 맡긴 카드는 그대로 돈다
        status = {t["id"]: t["status"] for c in self.route(ADMIN, "GET", f"/api/office/kanban/board?board={board}")[1]["columns"] for t in c["tasks"]}
        self.assertEqual(status[tid], "blocked")
        with hub_auto._db() as conn:
            kinds = [r["body"] for r in conn.execute("SELECT body FROM office_events WHERE body LIKE '%task.held%'")]
        self.assertEqual(len(kinds), 1)

    def test_실행_중인_카드도_멈추고_보류한다(self):
        board = "office-dddddddddddd"
        self.route(ADMIN, "POST", "/api/office/kanban/boards", {"slug": board, "name": "t"})
        _, made = self.route(C, "POST", f"/api/office/kanban/tasks?board={board}", {"title": "돌던 일", "assignee": "sa"})
        tid = made["task"]["id"]
        self.route(ADMIN, "POST", f"/api/office/kanban/dispatch?board={board}", {})          # 구성원일 때 실행됨
        self.assertEqual(self.dash["yj"].boards[board]["tasks"][tid]["status"], "running")
        office.delete_seat("sa")                                                              # 자리를 뺐다 — 더는 시킬 수 없다
        office.set_seat({"pod": "yj", "profile": "sa", "alias": "sa2"}, "me", KNOWN)
        self.route(ADMIN, "POST", f"/api/office/kanban/dispatch?board={board}", {})
        self.assertEqual(self.dash["yj"].boards[board]["tasks"][tid]["status"], "blocked")


if __name__ == "__main__":
    unittest.main()


class GrantsOnlyTest(AccessBase):
    """D12: 접근 권한(access_grants.pods)만 받은 사람은 보고 시킬 수는 있어도 오피스 예약 작업 쓰기·TFT 방 넣기는 못 한다."""
    def setUp(self):
        super().setUp()
        Reg.grants = {C: {"yj"}}                                   # C 는 yj 를 접근 권한으로만 받았다
        self.addCleanup(lambda: setattr(Reg, "grants", {}))

    def test_접근_권한만_받은_사람은_오피스_예약_작업을_못_쓴다(self):
        """D12: C 는 grants 로 yj 를 보지만 주인이 아니다. 오피스 예약 작업 쓰기는 may_change_cron 처럼 막힌다."""
        self.assertEqual(self.route(C, "GET", "/api/office/cron/sa/jobs")[0], 200)              # 읽기는 된다
        with self.assertRaises(office_access.Denied):
            self.route(C, "POST", "/api/office/cron/sa/jobs", {"name": "n", "schedule": "every 1h", "prompt": "x"})

    def test_접근_권한만_받은_사람은_TFT_방에_넣지_못한다(self):
        office.set_room({"id": self.r1, "name": "제안", "seats": ["doc"], "owner": C, "members": [C]}, "me")
        with self.assertRaises(office_access.Denied):
            acc(C).room_edit({"action": "room.set", "id": self.r1, "seats": ["doc", "sa"]})

    def test_접근_권한만_받은_사람이_시킨_일은_기록된다(self):
        self.assertTrue(acc(C).acting_on_others("sa"))
        self.assertFalse(acc(A).acting_on_others("sa"))
        self.assertFalse(acc(ADMIN).acting_on_others("sa"))


class RoomLabelTest(AccessBase):
    """계획 2026-10-13-001 R6: TFT 회의실 문 위 이름은 구성원·관리자에게만. 회의 상태 API 도 같은 규칙."""

    def setUp(self):
        super().setUp()
        with office.connect() as conn:
            for t in ("office_layouts", "office_room_places", "office_desk_assignments"):
                conn.execute(f"DELETE FROM {t}")
        office.ensure_default_layout()
        office.assign_room_places()

    def tearDown(self):
        with office.connect() as conn:
            for t in ("office_layouts", "office_room_places", "office_desk_assignments"):
                conn.execute(f"DELETE FROM {t}")

    def label(self, email, rid):
        return next(r["label"] for r in server._office_room_labels(acc(email)) if r.get("room") == rid)

    def test_구성원과_관리자는_TFT_이름을_보고_나머지는_사용_중만(self):
        self.assertEqual(self.label(C, self.r1), "제안")
        self.assertEqual(self.label(ADMIN, self.r2), "비공개")
        self.assertEqual(self.label(B, self.r2), "TFT 회의실 2 · 사용 중")
        self.assertNotIn("비공개", str(server._office_room_labels(acc(B))))

    def test_회의_상태_API_는_구성원이_아니면_방_이름을_뺀다(self):
        from unittest import mock
        rows = [{"room": self.r2, "name": "비공개", "seats": ["ma"], "pending": [], "speaker": None, "at": 1}]
        # 토픽 값은 회의 한 번 읽기(active_with_last, 스펙 2026-10-26-002 R7)에서 온다 — 쓰는 중인 글·마지막 답이 붙은 줄
        with mock.patch.object(server._meeting_obj, "active_with_last", return_value=[{**r, "partial": {}, "last": []} for r in rows], create=True):
            status, out = self.route(B, "GET", "/api/office/meeting/active")
        self.assertEqual(status, 200)
        self.assertNotIn("name", out["meetings"][0])
        self.assertEqual(out["meetings"][0]["seats"], [])                    # ma 는 B 의 장면에 없다 — 행은 남고 자리만 준다(스펙 2026-10-21-022 리뷰 R2)
        self.assertEqual(out["meetings"][0]["room"], self.r2)

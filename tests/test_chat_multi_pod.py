# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""채팅에 내 에이전트를 모두 보인다(스펙 2026-10-19-001 R2, 리뷰 D8·D9).
채팅 요청은 pod 인자로 에이전트를 고르고(없으면 쿠키), 허용 목록에 없는 에이전트는 첫 에이전트로 바꾸지 않고 403 이다."""
import aasserver  # 실제 uvicorn 앱을 띄우는 시험 하네스(OMAI-1100)
import http.client
import json
import os
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

TMP = tempfile.TemporaryDirectory()
os.environ.setdefault("AAS_DATA_DIR", str(Path(TMP.name) / "data"))

from aas.fleet import primary  # noqa: E402
from aas.web import server  # noqa: E402


class FakeHub:
    calls: list = []

    def __init__(self, pid):
        self.pid = pid
        self.sessions = {"s-u": {"profile": "main"}}      # 실제 허브처럼 세션별 프로파일을 가진다(chat_send 기록이 읽는다)

    def status(self):
        return {"configured": True, "connected": True, "error": "", "sessions": []}

    def history(self, profile, limit=80):
        FakeHub.calls.append((self.pid, "history", profile))
        return []

    def create_session(self, profile, by=""):
        FakeHub.calls.append((self.pid, "session", profile))
        return {"session_id": f"s-{self.pid}", "profile": profile, "title": ""}

    busy = False

    def send(self, sid, text, by="", files=None, **kw):
        if kw.get("skill") and FakeHub.busy:
            from aas.hermes.hermes_chat import SessionBusy
            raise SessionBusy("앞의 말에 아직 답하는 중입니다")
        FakeHub.calls.append((self.pid, "send", sid) + ((text, kw) if kw else ()))
        return {}

    def interrupt(self, sid):
        FakeHub.calls.append((self.pid, "interrupt", sid))
        return {}

    # 다시 열기·메모리 초과 원인 줄(스펙 2026-11-07-001 E6·E7·디자인 2A·재검토 R2-1~R2-4)
    disconnected_at = 0.0
    resume_error = None                                   # 예외를 넣으면 resume 이 그것을 던진다
    notices: list = []

    def resume(self, profile, stored_id, relay=False, by=""):
        FakeHub.calls.append((self.pid, "resume", profile))
        if FakeHub.resume_error is not None:
            raise FakeHub.resume_error
        return {"session_id": f"r-{self.pid}", "profile": profile}

    def notice_once(self, sid, key, payload):
        FakeHub.notices.append((sid, key, payload))
        return True


class _HttpBase(unittest.TestCase):
    """실제 서버를 띄우고 허브를 가짜로 바꾸는 공통 준비. 시험은 이어받는 쪽에 둔다."""

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
        FakeHub.calls = []
        main_only = [SimpleNamespace(name="main")]
        self.patches = [mock.patch.object(server, "hub", side_effect=lambda pod: FakeHub(pod.id)),
                        mock.patch.object(server.cron_health.hr, "profiles", return_value=main_only),
                        mock.patch.object(server, "_agents", side_effect=lambda pod: [{"name": "main"}]),
                        mock.patch.object(primary, "is_target", return_value=True),
                        mock.patch.object(primary, "primary_of", return_value="main")]
        for p in self.patches:
            p.start()

    def tearDown(self):
        for p in self.patches:
            p.stop()


class HttpTest(_HttpBase):
    def test_pod_인자가_없으면_지금_에이전트_있으면_그_에이전트(self):
        self.assertEqual(self.req("GET", "/api/chat/history?profile=main")[0], 200)
        self.assertEqual(self.req("GET", "/api/chat/history?profile=main&pod=u")[0], 200)
        self.assertEqual(self.req("POST", "/api/chat/session", {"profile": "main", "pod": "u"})[0], 200)
        self.assertEqual(self.req("POST", "/api/chat/send", {"session_id": "s-u", "text": "안녕", "pod": "u"})[0], 200)
        self.assertEqual(self.req("POST", "/api/chat/interrupt", {"session_id": "s-u", "pod": "u"})[0], 200)
        self.assertEqual(FakeHub.calls, [("t", "history", "main"), ("u", "history", "main"), ("u", "session", "main"),
                                         ("u", "send", "s-u"), ("u", "interrupt", "s-u")])

    def test_스킬_목록은_고른_에이전트_기준이고_남의_에이전트는_403(self):
        """입력창 / 목록(스펙 2026-10-19-012 P1). 채팅과 같은 pod 규칙, 없는 프로파일은 400, 이름 겹침 목록은 내보내지 않는다."""
        got = {"skills": [{"command": "/요약", "name": "요약", "description": "", "usage": 0}], "blocked": ["/deploy"], "warning": ""}
        with mock.patch.object(server.skill_commands, "cached", return_value=got) as cached:
            status, body = self.req("GET", "/api/chat/skills?profile=main&pod=u")
            self.assertEqual(status, 200)
            self.assertEqual(cached.call_args[0][0].pid, "u")
            self.assertEqual((body["profile"], body["skills"][0]["command"], body["warning"]), ("main", "/요약", ""))
            self.assertNotIn("blocked", body)
            self.assertEqual(self.req("GET", "/api/chat/skills?profile=main&pod=ghost")[0], 403)
            self.assertEqual(self.req("GET", "/api/chat/skills?profile=nope")[0], 400)

    def test_goal_loop_는_주인_관리자에게만_목록에_보이고_실행도_막는다(self):
        """스펙 2026-10-27-002 R12: grants 로 들어온 사람은 goal·loop 와 memory 쓰기를 쓰지 못한다."""
        from aas.hermes import chat_commands as cc
        got = {"skills": [], "blocked": [], "warning": "", "commands": list(cc.NAMES), "commands_blocked": []}
        with mock.patch.object(server.skill_commands, "cached", return_value=got), mock.patch.object(server, "_chat_manages", return_value=False):
            names = {r["name"] for r in self.req("GET", "/api/chat/skills?profile=main&pod=u")[1]["commands"]}
            self.assertFalse({"goal", "loop"} & names)
            self.assertIn("memory", names)
            with mock.patch.object(server.chat_commands, "run", wraps=lambda *a, **k: {"kind": "output", "manages": k["manages"]}) as run:
                status, body = self.req("POST", "/api/chat/command", {"session_id": "s-u", "pod": "u", "command": "goal", "arg": "x"})
            self.assertEqual((status, body["result"]["manages"]), (200, False))
            self.assertFalse(run.call_args.kwargs["manages"])
        with mock.patch.object(server.skill_commands, "cached", return_value=got):
            names = {r["name"] for r in self.req("GET", "/api/chat/skills?profile=main&pod=u")[1]["commands"]}
            self.assertTrue({"goal", "loop"} <= names)                       # 로그인을 끈 설치는 모두 주인이다
        a = SimpleNamespace(enabled=True)
        pod = SimpleNamespace(id="u", owner="u@example.com")
        with mock.patch.object(server, "registry", return_value=SimpleNamespace(is_admin=lambda u: False)), \
                mock.patch.object(server, "_manages_pod", side_effect=lambda p, u, e: (u or {}).get("email") == "u@example.com"):
            self.assertTrue(server._chat_manages(a, {"email": "u@example.com"}, pod))
            self.assertFalse(server._chat_manages(a, {"email": "shared@example.com"}, pod))
        self.assertTrue(server._chat_manages(SimpleNamespace(enabled=False), None, pod))

    def test_스킬_목록_설명은_요청_언어로_번역을_붙이고_원문은_따로(self):
        """스펙 2026-10-19-017 P5: ko 면 번역·description_src·description_by, en 이면 원문만. 자르기 전 설명은 응답에 없다. 저장값은 섞이지 않는다."""
        from aas.market import skill_desc
        desc = "Box manages cloud files, sharing, search, and metadata."
        got = {"skills": [{"command": "/box", "name": "box", "description": desc, "usage": 0, "description_full": desc}], "blocked": [], "warning": ""}

        def ask(lang):
            c = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
            c.request("GET", "/api/chat/skills?profile=main&pod=u", headers={"X-AAS": "1", "Accept-Language": lang})
            r = c.getresponse()
            body = json.loads(r.read())
            c.close()
            return body["skills"][0]
        with mock.patch.object(server.skill_commands, "cached", return_value=got), \
                mock.patch.object(skill_desc, "find", side_effect=lambda n, d: ("박스 파일 관리", "seed") if skill_desc.get_lang() == "ko" else None):
            ko, en = ask("ko"), ask("en")
        self.assertEqual((ko["description"], ko["description_src"], ko["description_by"]), ("박스 파일 관리", desc, "seed"))
        self.assertNotIn("description_full", ko)
        self.assertEqual(en, {"command": "/box", "name": "box", "description": desc, "usage": 0})
        self.assertEqual(got["skills"][0]["description"], desc)                             # 저장값은 그대로

    def test_스킬을_고른_말은_그_낱말을_떼어_보내고_친_글은_display_로(self):
        status, _ = self.req("POST", "/api/chat/send", {"session_id": "s-u", "text": "/요약 이번 주", "skill": "요약", "pod": "u"})
        self.assertEqual(status, 200)
        self.assertEqual(FakeHub.calls[-1], ("u", "send", "s-u", "이번 주", {"skill": "요약", "display": "/요약 이번 주"}))
        self.req("POST", "/api/chat/send", {"session_id": "s-u", "text": "그냥 말", "pod": "u"})
        self.assertEqual(FakeHub.calls[-1], ("u", "send", "s-u"))                          # 스킬이 없으면 옛 호출 그대로
        FakeHub.busy = True
        try:
            self.assertEqual(self.req("POST", "/api/chat/send", {"session_id": "s-u", "text": "/요약 또", "skill": "요약", "pod": "u"})[0], 409)
        finally:
            FakeHub.busy = False

    def test_명령은_채팅과_같은_pod_거름이고_거절은_안내_문장으로(self):
        """스펙 2026-10-26-010 R4·11-4: 볼 수 없는 에이전트의 명령은 403, 거절은 200 + ok false + code."""
        from aas.hermes import chat_commands
        self.assertEqual(self.req("POST", "/api/chat/command", {"session_id": "s-u", "command": "status", "pod": "ghost"})[0], 403)
        with mock.patch.object(server.chat_commands, "run", return_value={"kind": "output", "command": "/status", "text": "ok"}) as run:
            status, body = self.req("POST", "/api/chat/command", {"session_id": "s-u", "command": "status", "arg": "", "pod": "u"})
            self.assertEqual((status, body["result"]["text"]), (200, "ok"))
            self.assertEqual(run.call_args.args[1:4], ("s-u", "status", ""))
        with mock.patch.object(server.chat_commands, "run", side_effect=chat_commands.CommandError("busy", "답이 끝난 뒤에")):
            status, body = self.req("POST", "/api/chat/command", {"session_id": "s-u", "command": "retry", "pod": "u"})
            self.assertEqual((status, body["ok"], body["error"]["code"]), (200, False, "busy"))
        self.assertEqual(self.req("POST", "/api/chat/queue", {"session_id": "s-u", "op": "nope", "pod": "u"})[0], 400)

    def test_허용_목록에_없는_에이전트는_첫_에이전트로_바꾸지_않고_403(self):
        self.assertEqual(self.req("GET", "/api/chat/history?profile=main&pod=ghost")[0], 403)
        self.assertEqual(self.req("POST", "/api/chat/session", {"profile": "main", "pod": "ghost"})[0], 403)
        self.assertEqual(FakeHub.calls, [])

    def test_다시_뜨는_중인_에이전트는_403_이_아니라_503(self):
        # Hermes 가 다시 뜨는 동안 등록부에서 빠진 에이전트를 403 으로 거절하면 화면이 다시 열기를 바로 포기했다(OKE 2026-10-24, 스펙 2026-10-24-008)
        from aas.fleet import pods
        server._registry.restarting = [pods.Pod("r", "r@example.com", Path(TMP.name) / "hermes-r", restarting=True)]
        try:
            st, data = self.req("POST", "/api/chat/resume", {"profile": "main", "stored_id": "x", "pod": "r"})
            self.assertEqual(st, 503)
            self.assertIn("다시 시작", data["error"])
            self.assertEqual(self.req("GET", "/api/chat/history?profile=main&pod=r")[0], 503)
            self.assertEqual(self.req("POST", "/api/chat/resume", {"profile": "main", "stored_id": "x", "pod": "ghost"})[0], 403)
            self.assertEqual(FakeHub.calls, [])
        finally:
            server._registry.restarting = []

    def test_status_all_은_에이전트별_묶음을_지금_에이전트부터_준다(self):
        code, out = self.req("GET", "/api/chat/status?all=1")
        self.assertEqual(code, 200)
        self.assertEqual([g["pod"] for g in out["groups"]], ["t", "u"])
        self.assertTrue(out["groups"][0]["current"])
        self.assertEqual(out["groups"][1]["agents"], [{"name": "main"}])
        code, plain = self.req("GET", "/api/chat/status")                    # 기본 응답 모양은 그대로(스킬 허브 useAgents 가 쓴다)
        self.assertNotIn("groups", plain)
        self.assertEqual(plain["pod"], "t")
        self.assertEqual(self.req("GET", "/api/chat/status?pod=u")[1]["pod"], "u")         # 끊긴 대화의 생존 확인은 그 대화의 에이전트에 묻는다(R-LATE L2)


class GroupScopeTest(unittest.TestCase):
    def setUp(self):
        server._cache.clear()                              # 작업공간별 상태를 캐시로 읽는다 — 시험끼리 값이 남지 않게
        self.addCleanup(server._cache.clear)

    """D9: 주인인 것 + 관리자가 나눠 준 것 + 지금 에이전트. 관리자는 허용 목록이 전체라 자기 것 + 지금 에이전트만."""

    class Reg:
        def __init__(self, pods, admin_emails=(), grants=None, agents=()):
            self.pods, self._admins, self._grants, self.agents = pods, set(admin_emails), grants or {}, list(agents)

        def is_admin(self, user):
            return (user or {}).get("email") in self._admins

        def team_pods(self, user):                  # 팀 관리자 개념은 이 시험 밖
            return []

        def allowed(self, user, enabled):
            if self.is_admin(user):
                return list(self.pods)
            extra = set(self._grants.get(user["email"], []))
            return [p for p in self.pods if p.owned_by(user) or p.id in extra]

    @staticmethod
    def pod(pid, owner):
        return SimpleNamespace(id=pid, owner=owner, owned_by=lambda u, o=owner: (u or {}).get("email") == o)

    def ids(self, reg, user, current):
        with mock.patch.object(server, "_chat_status", side_effect=lambda pod: {"pod": pod.id, "agents": [], "configured": True}), \
                mock.patch.object(server, "_agent_names", return_value={"b": "가나", "a": "다라"}):
            return [g["pod"] for g in server._chat_groups(reg, user, True, current)]

    def test_사용자는_주인인_것과_나눠_받은_것_지금_에이전트가_먼저(self):
        a, b, c, d = self.pod("a", "kim@x.com"), self.pod("b", "kim@x.com"), self.pod("c", "lee@x.com"), self.pod("d", "lee@x.com")
        reg = self.Reg([a, b, c, d], grants={"kim@x.com": ["c"]})
        self.assertEqual(self.ids(reg, {"email": "kim@x.com"}, a), ["a", "c", "b"])     # 지금(a) → 나머지는 이름순(이름이 없으면 id: "c" < "가나")

    def test_관리자는_전체가_아니라_자기_것과_지금_에이전트(self):
        a, c, d = self.pod("a", "admin@x.com"), self.pod("c", "lee@x.com"), self.pod("d", "lee@x.com")
        reg = self.Reg([a, c, d], admin_emails={"admin@x.com"})
        self.assertEqual(self.ids(reg, {"email": "admin@x.com"}, c), ["c", "a"])

    def test_멈추거나_준비_중인_내_에이전트도_묶음으로_보인다(self):
        a = self.pod("a", "kim@x.com")
        reg = self.Reg([a], agents=[{"name": "a", "owner": "kim@x.com", "ready": True, "suspended": False, "display_name": "다라"},
                                    {"name": "z", "owner": "kim@x.com", "ready": False, "suspended": True, "display_name": "멈춘 것"}])
        with mock.patch.object(server, "_chat_status", side_effect=lambda pod: {"pod": pod.id, "agents": [], "configured": True}), \
                mock.patch.object(server, "_agent_names", return_value={}):
            groups = server._chat_groups(reg, {"email": "kim@x.com"}, True, a)
        self.assertEqual([(g["pod"], g.get("state")) for g in groups], [("a", "ok"), ("z", "stopped")])
        self.assertEqual(groups[1]["name"], "멈춘 것")

    def test_한_에이전트를_읽다_실패해도_나머지_묶음은_나온다(self):
        a, b = self.pod("a", "kim@x.com"), self.pod("b", "kim@x.com")
        reg = self.Reg([a, b])

        def status(pod):
            if pod.id == "b":
                raise OSError("사이드카 응답 없음")
            return {"pod": pod.id, "agents": [{"name": "main"}], "configured": True}
        with mock.patch.object(server, "_chat_status", side_effect=status), mock.patch.object(server, "_agent_names", return_value={}):
            groups = server._chat_groups(reg, {"email": "kim@x.com"}, True, a)
        self.assertEqual([(g["pod"], g["state"]) for g in groups], [("a", "ok"), ("b", "error")])
        self.assertIn("사이드카", groups[1]["error"])


    def test_작업공간_하나가_느려도_목록은_한도_안에_오고_그_묶음만_오류다(self):
        """가장 느린 작업공간을 시간 한도 없이 기다려 채팅 목록이 몇 분씩 걸렸다(OMAI-1459, 스펙 2026-10-24-002 R2)."""
        import threading
        import time
        # 버려진 느린 읽기가 시험 뒤에 끝나며 캐시에 값을 넣으므로 다른 시험과 겹치지 않는 이름을 쓴다
        a, b = self.pod("slow-a", "kim@x.com"), self.pod("slow-b", "kim@x.com")
        reg = self.Reg([a, b])
        release = threading.Event()
        self.addCleanup(release.set)

        def status(pod):
            if pod.id == "slow-b":
                release.wait(10)
            return {"pod": pod.id, "agents": [{"name": "main"}], "configured": True}
        with mock.patch.object(server, "_chat_status", side_effect=status), mock.patch.object(server, "_agent_names", return_value={}), \
                mock.patch.object(server, "CHAT_GROUP_TIMEOUT", 0.5):
            began = time.monotonic()
            groups = server._chat_groups(reg, {"email": "kim@x.com"}, True, a)
            took = time.monotonic() - began
        self.assertLess(took, 3)
        self.assertEqual([(g["pod"], g["state"]) for g in groups], [("slow-a", "ok"), ("slow-b", "error")])

    def test_채팅_목록은_3초가_지난_상태를_돌려주지_않는다(self):
        """만료된 값을 바로 돌려주고 뒤에서 새로 만들어, Hermes 가 다시 붙은 뒤에도 「연결 없음」이 한 번 더 보였다
        (스펙 2026-10-24-002 외부 검토 3). 기다림은 CHAT_GROUP_TIMEOUT 이 끊는다."""
        a = self.pod("fresh-a", "kim@x.com")
        reg = self.Reg([a])
        n = []

        def status(pod):
            n.append(1)
            return {"pod": pod.id, "agents": [{"name": f"v{len(n)}"}], "configured": True}
        with mock.patch.object(server, "_chat_status", side_effect=status), mock.patch.object(server, "_agent_names", return_value={}):
            first = server._chat_groups(reg, {"email": "kim@x.com"}, True, a)
            for k in [k for k in server._cache if "fresh-a:chatstatus" in k]:
                ts, value = server._cache[k]
                server._cache[k] = (ts - 10, value)               # 3초가 지났다
            second = server._chat_groups(reg, {"email": "kim@x.com"}, True, a)
        self.assertEqual([g["name"] for g in first[0]["agents"]], ["v1"])
        self.assertEqual([g["name"] for g in second[0]["agents"]], ["v2"])

    def test_같은_작업공간에_동시_요청이_와도_상태_읽기는_하나다(self):
        """한도를 넘긴 작업은 결과만 버리고 스레드는 계속 돈다(collect_all.map_pods). 요청마다 새로 읽으면 막힌
        작업공간에 스레드가 쌓인다 — 작업공간별 캐시로 읽기를 하나로 묶는다(검토 D3)."""
        import threading
        a = self.pod("same-a", "kim@x.com")
        reg = self.Reg([a])
        calls, release = [], threading.Event()
        self.addCleanup(release.set)

        def status(pod):
            calls.append(pod.id)
            release.wait(10)
            return {"pod": pod.id, "agents": [], "configured": True}
        with mock.patch.object(server, "_chat_status", side_effect=status), mock.patch.object(server, "_agent_names", return_value={}), \
                mock.patch.object(server, "CHAT_GROUP_TIMEOUT", 0.3):
            threads = [threading.Thread(target=server._chat_groups, args=(reg, {"email": "kim@x.com"}, True, a), daemon=True) for _ in range(5)]
            for t in threads:
                t.start()
            for t in threads:
                t.join(5)
            self.assertEqual(calls, ["same-a"])
            release.set()


if __name__ == "__main__":
    unittest.main()


class ReopenOomTest(_HttpBase):
    """다시 연 대화의 메모리 초과 원인 줄·지우는 중·없는 프로파일 코드(스펙 2026-11-07-001)."""

    def setUp(self):
        super().setUp()
        import time as _t
        FakeHub.resume_error, FakeHub.notices = None, []
        self.now = _t.time()
        FakeHub.disconnected_at = self.now - 30
        self.hub_t = FakeHub("t")
        self.extra = [mock.patch.object(server, "hub", side_effect=lambda pod: self.hub_t),
                      mock.patch.object(server._registry, "refresh", lambda ttl=0: None),
                      mock.patch.dict(server._hubs, {"t": self.hub_t, "r": self.hub_t})]
        for p in self.extra:
            p.start()
        self.old_agents = server._registry.agents

    def tearDown(self):
        server._registry.agents = self.old_agents
        for p in self.extra:
            p.stop()
        FakeHub.resume_error = None
        super().tearDown()

    def _oom_row(self, pid, ended):
        from datetime import datetime, timezone
        at = datetime.fromtimestamp(ended, timezone.utc).isoformat().replace("+00:00", "Z")
        return {"name": pid, "owner": f"{pid}@example.com", "size": {"memory_limit": None},
                "last_termination": {"reason": "OOMKilled", "finished_at": at, "limit_memory": "4Gi"}}

    def test_끊긴_시각_앞뒤_120초의_OOM_만_원인_줄(self):
        cases = [(self.now - 40, True), (self.now - 30 + 115, True), (self.now - 30 - 200, False), (self.now - 30 + 200, False)]
        for ended, want in cases:
            FakeHub.notices = []
            server._registry.agents = [self._oom_row("t", ended)]
            st, data = self.req("POST", "/api/chat/resume", {"profile": "main", "stored_id": "x", "pod": "t"})
            self.assertEqual(st, 200)
            self.assertEqual(bool(FakeHub.notices), want, ended - self.now)
            if want:
                sid, key, payload = FakeHub.notices[0]
                self.assertEqual((sid, payload["code"], payload["limit_memory"]), ("r-t", "oom_restart", "4Gi"))
        server._registry.agents = [{**self._oom_row("t", self.now - 40), "last_termination": {"reason": "Error", "finished_at": "2026-11-07T00:00:00Z"}}]
        FakeHub.notices = []
        self.req("POST", "/api/chat/resume", {"profile": "main", "stored_id": "x", "pod": "t"})
        self.assertEqual(FakeHub.notices, [], "OOMKilled 가 아니면 없다")
        FakeHub.disconnected_at = 0.0
        server._registry.agents = [self._oom_row("t", self.now - 40)]
        self.req("POST", "/api/chat/resume", {"profile": "main", "stored_id": "x", "pod": "t"})
        self.assertEqual(FakeHub.notices, [], "끊긴 적이 없으면(compose·새 서버) 없다")

    def test_다시_열기_실패_응답에_원인을_싣는다(self):
        from aas.hermes.hermes_chat import ChatUnavailable
        server._registry.agents = [self._oom_row("t", self.now - 40)]
        FakeHub.resume_error = ChatUnavailable("Hermes API 서버 연결이 끊겼습니다")
        st, data = self.req("POST", "/api/chat/resume", {"profile": "main", "stored_id": "x", "pod": "t"})
        self.assertEqual((st, data["oom"]["limit_memory"]), (503, "4Gi"))
        server._registry.agents = []
        self.assertNotIn("oom", self.req("POST", "/api/chat/resume", {"profile": "main", "stored_id": "x", "pod": "t"})[1])
        # 다시 시작 중(등록부에서 잠시 빠짐) 503 에도 싣는다
        from aas.fleet import pods
        server._registry.agents = [self._oom_row("r", self.now - 40)]
        server._registry.restarting = [pods.Pod("r", "r@example.com", Path(TMP.name) / "hermes-r", restarting=True)]
        try:
            st, data = self.req("POST", "/api/chat/resume", {"profile": "main", "stored_id": "x", "pod": "r"})
            self.assertEqual((st, data["oom"]["limit_memory"]), (503, "4Gi"))
        finally:
            server._registry.restarting = []

    def test_지우는_중과_없는_프로파일은_코드로(self):
        from aas.hermes.hermes_chat import ProfileDeleting
        FakeHub.resume_error = ProfileDeleting("이 프로파일을 지우는 중입니다")
        st, data = self.req("POST", "/api/chat/resume", {"profile": "main", "stored_id": "x", "pod": "t"})
        self.assertEqual((st, data["code"]), (409, "profile_deleting"))
        st, data = self.req("POST", "/api/chat/resume", {"profile": "gone", "stored_id": "x", "pod": "t"})
        self.assertEqual((st, data["code"]), (400, "profile_not_found"))
        st, data = self.req("POST", "/api/chat/session", {"profile": "gone", "pod": "t"})
        self.assertEqual((st, data["code"]), (400, "profile_not_found"))

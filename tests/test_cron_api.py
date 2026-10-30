# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""크론 조작과 실행 기록 시험 — 가짜 Hermes 대시보드를 띄워 AAS 가 무엇을 보내는지 본다."""
import aasserver  # 실제 uvicorn 앱을 띄우는 시험 하네스(OMAI-1100)
import http.client
import json
import os
import sqlite3
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

TMP = tempfile.TemporaryDirectory()
os.environ.setdefault("AAS_DATA_DIR", str(Path(TMP.name) / "data"))

from aas.auth import auth
from aas.assets import flow
from aas.ops import observed
from aas.fleet import pods
from aas.web import server  # noqa: E402
from aas.hermes.hermes_chat import ChatHub  # noqa: E402


class FakeHermes(BaseHTTPRequestHandler):
    calls: list = []
    logins = 0
    expire_once = False
    skill_path = ""
    real_file = ""
    jobs_status = 200                                                  # GET /api/cron/jobs 가 돌려줄 상태(401·403 시험용)

    def _send(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code); self.send_header("Content-Type", "application/json")
        if self.path.startswith("/auth/password-login"):
            self.send_header("Set-Cookie", "sid=ok; Path=/")
        self.send_header("Content-Length", str(len(body))); self.end_headers(); self.wfile.write(body)

    def _handle(self, method):
        u = urlsplit(self.path)
        body = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)) or b"{}")
        if u.path == "/auth/password-login":
            FakeHermes.logins += 1
            return self._send(200, {})
        if "sid=ok" not in (self.headers.get("Cookie") or ""):
            return self._send(401, {"detail": "login"})
        if FakeHermes.expire_once:
            FakeHermes.expire_once = False
            return self._send(401, {"detail": "expired"})
        FakeHermes.calls.append((method, u.path, parse_qs(u.query), body))
        if method == "PUT" and body.get("updates", {}).get("schedule") == "nonsense":
            return self._send(400, {"detail": "Invalid schedule 'nonsense' token=abcdefghijklmnop1234"})
        if u.path == "/api/cron/jobs" and method == "GET":
            if FakeHermes.jobs_status != 200:
                return self._send(FakeHermes.jobs_status, {"detail": "no"})
            return self._send(200, {"jobs": [{"id": "j1", "name": "digest-daily", "enabled": True, "schedule": {"display": "0 9 * * *"}, "prompt": "do it with password='supersecretvalue1234'",
                                              "deliver": "local", "last_run_at": "2026-10-15T01:00:00+09:00", "last_status": "ok", "hermes_home": "/opt/data"}]})
        if u.path == "/api/skills/content" and method == "GET":
            return self._send(200, {"name": "digest", "content": "", "path": FakeHermes.skill_path})
        if u.path == "/api/skills/content" and method == "PUT":
            if "FORBIDDEN" in body["content"]:
                return self._send(400, {"detail": "frontmatter invalid"})
            Path(FakeHermes.real_file).write_text(body["content"], encoding="utf-8")
            return self._send(200, {"success": True})
        if u.path.endswith("/runs"):
            return self._send(200, {"runs": [{"id": "cron_j1_20261005_090000", "started_at": 1.0, "ended_at": 31.0, "secret_field": "x"}]})
        return self._send(200, {"id": "j1", "name": "digest-daily", "enabled": True, "schedule": {"kind": "cron", "expr": "0 9 * * *", "display": "0 9 * * *"},
                                "prompt": "do it with password='supersecretvalue1234'", "deliver": "local", "hermes_home": "/opt/data"})

    def do_GET(self): self._handle("GET")
    def do_POST(self): self._handle("POST")
    def do_PUT(self): self._handle("PUT")
    def do_DELETE(self): self._handle("DELETE")
    def log_message(self, *a): pass


class CronApiTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        root = Path(TMP.name)
        cls.fake = ThreadingHTTPServer(("127.0.0.1", 0), FakeHermes)
        threading.Thread(target=cls.fake.serve_forever, daemon=True).start()
        home = root / "h"; (home / "profiles" / "ma").mkdir(parents=True)
        (home / "skills" / "ops" / "digest").mkdir(parents=True); (home / "scripts").mkdir()
        cls.md = home / "skills" / "ops" / "digest" / "SKILL.md"
        cls.md.write_text("---\nname: digest\ndescription: 요약\n---\n# digest\n처음 내용\n", encoding="utf-8")
        (home / "scripts" / "send.py").write_text("print('hi')\n")
        FakeHermes.skill_path, FakeHermes.real_file = "/opt/data/skills/ops/digest/SKILL.md", str(cls.md)
        reg = root / "cron-pods.json"
        reg.write_text(json.dumps({"pods": [{"id": "t", "owner": "t@example.com", "hermes_home": str(home),
                                              "dashboard_url": f"http://127.0.0.1:{cls.fake.server_port}"}]}))
        server._auth = auth.Auth({"issuer": "https://accounts.google.com", "client_id": "", "client_secret": "", "domain": "",
                                  "public_url": "http://localhost:17900", "hours": 1, "users_file": root / "none.json"})
        server._registry = pods.Registry(reg)
        pod = server._registry.pods[0]
        server._hubs[pod.id] = ChatHub({"url": pod.dashboard_url, "provider": "basic", "user": "u", "password": "p"})
        cls.app = aasserver.start()

    @classmethod
    def tearDownClass(cls):
        cls.app.shutdown(); cls.fake.shutdown()
        server._auth = server._registry = None
        server._hubs.clear()

    def req(self, method, path, body=None, headers=None):
        c = http.client.HTTPConnection("127.0.0.1", self.app.server_port, timeout=10)
        c.request(method, path, body=json.dumps(body) if body is not None else None, headers={"Content-Type": "application/json", **(headers or {})})
        r = c.getresponse(); data = json.loads(r.read() or b"{}"); c.close()
        return r.status, data

    def test_job_view_is_trimmed_and_masked(self):
        code, d = self.req("GET", "/api/cron/job?profile=ma&id=j1")
        self.assertEqual(code, 200)
        self.assertEqual((d["job"]["schedule_display"], d["can_edit"]), ("0 9 * * *", True))
        self.assertNotIn("supersecretvalue1234", json.dumps(d))
        self.assertNotIn("hermes_home", d["job"])                        # 정해 둔 항목만 내보낸다
        self.assertEqual(d["runs"], [{"id": "cron_j1_20261005_090000", "started_at": 1.0, "ended_at": 31.0}])

    def test_actions_go_to_hermes_api_with_profile(self):
        FakeHermes.calls.clear()
        X = {"X-AAS": "1"}
        self.assertEqual(self.req("POST", "/api/cron/action", {"profile": "ma", "id": "j1", "action": "pause"}, X)[0], 200)
        self.assertEqual(self.req("POST", "/api/cron/action", {"profile": "ma", "id": "j1", "action": "schedule", "schedule": " 30 8  * * 1-5 "}, X)[0], 200)
        self.assertEqual(FakeHermes.calls[0][:3], ("POST", "/api/cron/jobs/j1/pause", {"profile": ["ma"]}))
        self.assertEqual(FakeHermes.calls[1], ("PUT", "/api/cron/jobs/j1", {"profile": ["ma"]}, {"updates": {"schedule": "30 8 * * 1-5"}}))
        code, d = self.req("POST", "/api/cron/action", {"profile": "ma", "id": "j1", "action": "schedule", "schedule": "nonsense"}, X)
        self.assertEqual(code, 400)                                       # Hermes 의 거절을 그대로 알린다(비밀값 모양은 가린다)
        self.assertIn("Invalid schedule", d["error"]); self.assertNotIn("abcdefghijklmnop1234", d["error"])
        FakeHermes.calls.clear()
        self.assertEqual(self.req("POST", "/api/cron/action", {"profile": "ma", "id": "j1", "action": "deliver", "deliver": "telegram"}, X)[0], 200)
        self.assertEqual(FakeHermes.calls[-1], ("PUT", "/api/cron/jobs/j1", {"profile": ["ma"]}, {"updates": {"deliver": "telegram"}}))
        FakeHermes.calls.clear()
        self.assertEqual(self.req("POST", "/api/cron/action", {"profile": "ma", "id": "j1", "action": "delete", "job_name": "digest-daily", "confirm": "digest"}, X)[0], 400)
        self.assertEqual(self.req("POST", "/api/cron/action", {"profile": "ma", "id": "j1", "action": "delete", "job_name": "other", "confirm": "other"}, X)[0], 409)   # Hermes 의 이름과 다르면 지우지 않는다
        self.assertFalse(any(c[0] == "DELETE" for c in FakeHermes.calls))
        self.assertEqual(self.req("POST", "/api/cron/action", {"profile": "ma", "id": "j1", "action": "delete", "job_name": "digest-daily", "confirm": "digest-daily"}, X)[0], 200)
        self.assertEqual(FakeHermes.calls[-1][:2], ("DELETE", "/api/cron/jobs/j1"))
        FakeHermes.calls.clear()
        new = {"profile": "ma", "action": "create", "job_name": "weekly", "schedule": "0 9 * * 1", "skill": "digest", "deliver": "buzz"}
        self.assertEqual(self.req("POST", "/api/cron/action", new, X)[0], 200)
        self.assertEqual(FakeHermes.calls[-1], ("POST", "/api/cron/jobs", {"profile": ["ma"]}, {"name": "weekly", "schedule": "0 9 * * 1", "prompt": "", "skills": ["digest"], "deliver": "buzz"}))
        for bad in ({**new, "job_name": ""}, {**new, "skill": "", "prompt": ""}, {**new, "schedule": ""}, {**new, "profile": "nope"}):
            self.assertEqual(self.req("POST", "/api/cron/action", bad, X)[0], 400, bad)
        for bad in ({"profile": "ma", "id": "j1", "action": "explode"}, {"profile": "ma", "id": "", "action": "pause"}, {"profile": "ma", "id": "j1", "action": "schedule", "schedule": ""}):
            self.assertEqual(self.req("POST", "/api/cron/action", bad, X)[0], 400)
        self.assertEqual(self.req("POST", "/api/cron/action", {"profile": "ma", "id": "j1", "action": "pause"})[0], 403)   # 전용 헤더 없이는 거절

    def test_relogin_when_session_expires(self):
        before = FakeHermes.logins
        FakeHermes.expire_once = True
        self.assertEqual(self.req("GET", "/api/cron/job?profile=ma&id=j1")[0], 200)
        self.assertEqual(FakeHermes.logins, before + 1)

    def test_skill_doc_edit_goes_through_hermes_and_keeps_versions(self):
        X, rel = {"X-AAS": "1"}, "skills/ops/digest/SKILL.md"
        code, f = self.req("GET", f"/api/file?path={rel}")
        self.assertEqual((code, f["editable"], f["versions"]), (200, True, 0))
        new = "\n".join(f["lines"]).replace("처음 내용", "고친 내용") + "\n"
        code, d = self.req("POST", "/api/file/preview", {"path": rel, "content": new}, X)
        self.assertEqual((d["added"], d["removed"], d["problem"]), (1, 1, ""))
        self.assertEqual(self.req("POST", "/api/file/save", {"path": rel, "content": new, "base_sha": "stale"}, X)[0], 409)   # 그사이 바뀐 파일
        code, r = self.req("POST", "/api/file/save", {"path": rel, "content": new, "base_sha": f["sha"]}, X)
        self.assertEqual((code, r["saved"], r["exact"], r["versions"]), (200, True, True, 2))
        self.assertIn("고친 내용", self.md.read_text(encoding="utf-8"))
        put = [c for c in FakeHermes.calls if c[0] == "PUT" and c[1] == "/api/skills/content"][-1]
        self.assertEqual((put[3]["name"], put[3]["profile"]), ("ops/digest", None))                # Hermes API 로 보냈다 — 이름이 아니라 skills 아래 경로로(같은 이름 스킬과 헷갈리지 않게)
        get = [c for c in FakeHermes.calls if c[0] == "GET" and c[1] == "/api/skills/content"][-1]
        self.assertEqual(get[2]["name"], ["ops/digest"])
        vs = self.req("GET", f"/api/file/versions?path={rel}")[1]["versions"]
        self.assertEqual([v["note"] for v in vs], ["저장", "고치기 전"])
        code, d = self.req("GET", f"/api/file/diff?path={rel}&id={vs[1]['id']}")
        self.assertEqual((d["added"], d["removed"]), (1, 1))
        code, r2 = self.req("POST", "/api/file/revert", {"path": rel, "id": vs[1]["id"], "base_sha": r["sha"]}, X)
        self.assertEqual(code, 200); self.assertIn("처음 내용", self.md.read_text(encoding="utf-8"))
        # 거절되는 경우들
        cur = self.req("GET", f"/api/file?path={rel}")[1]
        self.assertEqual(self.req("POST", "/api/file/save", {"path": rel, "content": "머리말 없음", "base_sha": cur["sha"]}, X)[0], 422)
        code, e = self.req("POST", "/api/file/save", {"path": rel, "content": "---\nname: digest\n---\nFORBIDDEN\n", "base_sha": cur["sha"]}, X)
        self.assertEqual((code, "frontmatter" in e["error"]), (400, True))                         # Hermes 의 거절을 그대로 알린다
        self.assertIn("처음 내용", self.md.read_text(encoding="utf-8"))
        FakeHermes.skill_path = "/opt/data/profiles/x/skills/digest/SKILL.md"                      # Hermes 가 다른 스킬을 가리키면 보내지 않는다
        try:
            self.assertEqual(self.req("POST", "/api/file/save", {"path": rel, "content": new, "base_sha": cur["sha"]}, X)[0], 422)   # 다른 스킬을 가리키면 저장하지 않는다(판 충돌 409 와 구분)
        finally:
            FakeHermes.skill_path = "/opt/data/skills/ops/digest/SKILL.md"
        self.assertEqual(self.req("POST", "/api/file/save", {"path": rel, "content": new, "base_sha": cur["sha"]})[0], 403)   # 전용 헤더 없이는 거절

    def test_job_memo_prompt_and_version_tools(self):
        X = {"X-AAS": "1"}
        code, d = self.req("GET", "/api/cron/job?profile=ma&id=j1")
        self.assertEqual((d["note_doc"]["lines"], d["note_doc"]["versions"], d["prompt_doc"]["versions"]), ([], 0, 0))
        self.assertNotIn("supersecretvalue1234", json.dumps(d["prompt_doc"]))            # 지시문 속 비밀값은 가려서 보여 준다
        self.assertEqual(d["prompt_doc"]["masked_lines"], [1])
        # 작업 메모: AAS 에만 남는 글. 저장 메모와 판이 남는다
        code, n1 = self.req("POST", "/api/cron/note", {"profile": "ma", "id": "j1", "content": "# 요약\n매일 아침 보고", "base_sha": d["note_doc"]["sha"], "note": "처음 씀"}, X)
        self.assertEqual((code, n1["lines"][0], n1["versions"]), (200, "# 요약", 1))
        self.assertEqual(self.req("POST", "/api/cron/note", {"profile": "ma", "id": "j1", "content": "x", "base_sha": "stale"}, X)[0], 409)
        self.assertEqual(self.req("POST", "/api/cron/note", {"profile": "ma", "id": "j1", "content": "token='abcdefghijklmnop1234'", "base_sha": n1["sha"]}, X)[0], 422)
        code, n2 = self.req("POST", "/api/cron/note", {"profile": "ma", "id": "j1", "content": "# 요약\n매일 아침 보고\n담당 yj", "base_sha": n1["sha"]}, X)
        key = "jobnote:ma/j1"
        vs = self.req("GET", f"/api/text/versions?key={key}")[1]["versions"]
        self.assertEqual([v["note"] for v in vs], ["저장", "처음 씀"])
        code, df = self.req("GET", f"/api/text/diff2?key={key}&a={vs[1]['id']}&b={vs[0]['id']}")
        self.assertEqual((df["added"], df["removed"]), (1, 0))
        self.assertEqual(self.req("GET", f"/api/text/version?key={key}&id={vs[1]['id']}")[1]["lines"], ["# 요약", "매일 아침 보고"])
        self.assertEqual(self.req("POST", "/api/text/label", {"key": key, "id": vs[0]["id"], "note": "담당자 추가"}, X)[0], 200)
        self.assertEqual(self.req("GET", f"/api/text/versions?key={key}")[1]["versions"][0]["note"], "담당자 추가")
        for bad in ("../x", "secrets/x.json", "jobnote:../../x", "soul:a b"):
            self.assertEqual(self.req("GET", f"/api/text/versions?key={bad.replace(' ', '%20')}")[0], 400, bad)
        self.assertEqual(self.req("POST", "/api/text/label", {"key": key, "id": 99999, "note": "x"}, X)[0], 404)
        # 스킬 바꾸기는 Hermes 로
        FakeHermes.calls.clear()
        self.assertEqual(self.req("POST", "/api/cron/action", {"profile": "ma", "id": "j1", "action": "skill", "skill": "weekly"}, X)[0], 200)
        self.assertEqual(FakeHermes.calls[-1], ("PUT", "/api/cron/jobs/j1", {"profile": ["ma"]}, {"updates": {"skills": ["weekly"]}}))
        # 지시문에 비밀값이 박혀 있으면 여기서 고칠 수 없다
        code, e = self.req("POST", "/api/cron/action", {"profile": "ma", "id": "j1", "action": "prompt", "content": "새 지시", "base_sha": d["prompt_doc"]["sha"]}, X)
        self.assertEqual(code, 403)
        from tests.test_cron_api import FakeHermes as F
        self.assertFalse(any(c[0] == "PUT" and "prompt" in json.dumps(c[3]) for c in F.calls))

    def test_zz_file_save_keeps_the_save_note(self):
        X, rel = {"X-AAS": "1"}, "skills/ops/digest/SKILL.md"
        f = self.req("GET", f"/api/file?path={rel}")[1]
        new = "\n".join(f["lines"]) + "\n메모 시험 줄\n"
        code, r = self.req("POST", "/api/file/save", {"path": rel, "content": new, "base_sha": f["sha"], "note": "시험 줄 추가"}, X)
        self.assertEqual(code, 200)
        vs = self.req("GET", f"/api/text/versions?key={rel}")[1]["versions"]
        self.assertEqual(vs[0]["note"], "시험 줄 추가")
        self.req("POST", "/api/file/revert", {"path": rel, "id": vs[-1]["id"], "base_sha": r["sha"]}, X)

    def test_scripts_are_view_only(self):
        code, f = self.req("GET", "/api/file?path=scripts/send.py")
        self.assertEqual((code, f["editable"]), (200, False)); self.assertIn("보기만", f["why_not"])
        code, e = self.req("POST", "/api/file/save", {"path": "scripts/send.py", "content": "print('x')\n", "base_sha": f["sha"]}, {"X-AAS": "1"})
        self.assertEqual(code, 403)
        self.assertEqual((Path(self.md).parents[3] / "scripts" / "send.py").read_text(), "print('hi')\n")       # 파일은 그대로

    def test_owner_can_change_own_pod_but_deliver_is_limited(self):
        """스펙 2026-10-15-003 R1·R6: 주인은 자기 파드의 크론을 바꾸되 전달 대상은 local·origin·채널 이름만."""
        reg = server._registry
        old = (server._auth, reg.is_admin)
        class On:
            enabled = True
            def user(self, cookie): return {"email": "t@example.com", "name": ""}      # 파드 t 의 주인
        server._auth = On(); reg.is_admin = lambda u: False
        X = {"X-AAS": "1"}
        try:
            FakeHermes.calls.clear()
            self.assertEqual(self.req("POST", "/api/cron/action", {"profile": "ma", "id": "j1", "action": "trigger"}, X)[0], 200)
            new = {"profile": "ma", "action": "create", "job_name": "mine", "schedule": "0 9 * * 1", "prompt": "p"}
            self.assertEqual(self.req("POST", "/api/cron/action", {**new, "deliver": "telegram"}, X)[0], 200)
            for bad in ("telegram:123", "bot-chat:ma"):
                code, d = self.req("POST", "/api/cron/action", {**new, "deliver": bad}, X)
                self.assertEqual(code, 403, bad); self.assertIn("관리자", d["error"])
            self.assertEqual(self.req("POST", "/api/cron/action", {"profile": "ma", "id": "j1", "action": "deliver", "deliver": "slack:C1"}, X)[0], 403)
        finally:
            server._auth, reg.is_admin = old

    def test_hidden_root_is_refused_for_create_only_when_pod_is_main_target(self):
        from unittest import mock
        from aas.fleet import primary
        X = {"X-AAS": "1"}
        new = {"profile": "default", "action": "create", "job_name": "r", "schedule": "0 9 * * 1", "prompt": "p"}
        with mock.patch.object(primary, "is_target", return_value=True):
            self.assertEqual(self.req("POST", "/api/cron/action", new, X)[0], 400)
        FakeHermes.calls.clear()
        with mock.patch.object(primary, "is_target", return_value=False):          # 대상 기록이 없으면 막지 않는다(없는 프로파일 사유로 400 이 날 수 있어 Hermes 호출 전 거절만 본다)
            self.req("POST", "/api/cron/action", new, X)
        self.assertFalse(any("hidden root" in json.dumps(c) for c in FakeHermes.calls))

    def test_job_list_is_trimmed_and_hermes_rejection_becomes_502(self):
        """서랍 「크론」 탭의 목록(스펙 2026-10-15-003 R2): Hermes 목록을 정해 둔 항목만, 비밀값 모양은 가려 내보낸다."""
        FakeHermes.calls.clear()
        code, d = self.req("GET", "/api/cron/jobs?profile=ma")
        self.assertEqual(code, 200)
        self.assertEqual([j["id"] for j in d["jobs"]], ["j1"])
        self.assertEqual((d["jobs"][0]["schedule_display"], d["can_edit"]), ("0 9 * * *", True))
        self.assertNotIn("supersecretvalue1234", json.dumps(d)); self.assertNotIn("hermes_home", d["jobs"][0])
        self.assertEqual(FakeHermes.calls[-1][:3], ("GET", "/api/cron/jobs", {"profile": ["ma"]}))
        FakeHermes.jobs_status = 403
        try:
            self.assertEqual(self.req("GET", "/api/cron/jobs?profile=ma")[0], 502)          # 로그인 거절을 상태 코드로 그대로 넘기지 않는다
        finally:
            FakeHermes.jobs_status = 200

    def test_owner_may_edit_skill_docs_and_see_the_cron_drawer_as_editable(self):
        """스펙 2026-10-15-011 D10: 주인은 자기 파드의 스킬 문서와 크론 메모·무시를 고친다. 숨긴 루트의 문서는 못 고친다."""
        from unittest import mock
        from aas.fleet import primary
        reg = server._registry
        old = (server._auth, reg.is_admin)
        class On:
            enabled = True
            email = "t@example.com"                                                     # 파드 t 의 주인
            def user(self, cookie): return {"email": self.email, "name": ""}
        server._auth = On(); reg.is_admin = lambda u: False
        rel = "skills/ops/digest/SKILL.md"
        try:
            self.assertTrue(self.req("GET", f"/api/file?path={rel}")[1]["editable"])
            self.assertTrue(self.req("GET", "/api/cron/job?profile=ma&id=j1")[1]["can_edit"])
            with mock.patch.object(primary, "is_target", return_value=True):            # 루트가 숨겨진 파드: 루트 스킬은 주인에게 닫힌다
                self.assertFalse(self.req("GET", f"/api/file?path={rel}")[1]["editable"])
        finally:
            server._auth, reg.is_admin = old

    def test_non_admin_cannot_change(self):
        reg = server._registry
        old = (server._auth, reg.is_admin)
        class On:                                                        # 로그인이 켜져 있고 관리자가 아닌 사용자
            enabled = True
            email = "x@example.com"                                                    # 파드 t 의 주인이 아니다
            def user(self, cookie): return {"email": self.email, "name": ""}
        server._auth = On(); reg.is_admin = lambda u: False
        try:
            code, d = self.req("POST", "/api/cron/action", {"profile": "ma", "id": "j1", "action": "trigger"}, {"X-AAS": "1"})
            self.assertEqual(code, 403)                                                # 파드를 가지지 않은 사용자는 파드를 찾는 단계에서 거절된다
            # 스킬 문서 저장은 관리자와 파드 주인만(스펙 2026-10-15-011 D10). 파드를 가지지 않은 사용자는 거절
            code, d = self.req("POST", "/api/file/save", {"path": "skills/ops/digest/SKILL.md", "content": "---\nx\n", "base_sha": "x"}, {"X-AAS": "1"})
            self.assertEqual(code, 403)
        finally:
            server._auth, reg.is_admin = old


class ObservedTest(unittest.TestCase):
    def test_reads_names_only_and_overlays(self):
        from tests.test_flow import make_home
        home = make_home(Path(TMP.name) / "obs")
        db = home / "profiles" / "ma" / "state.db"
        con = sqlite3.connect(db)
        con.execute("CREATE TABLE sessions (id TEXT, source TEXT, started_at REAL)")
        con.execute("CREATE TABLE messages (id INTEGER PRIMARY KEY, session_id TEXT, role TEXT, content TEXT, tool_calls TEXT, tool_name TEXT)")
        import time
        now = time.time()
        con.execute("INSERT INTO sessions VALUES ('cron_j1_20261005_090000','cron',?)", (now - 60,))
        con.execute("INSERT INTO sessions VALUES ('old','cron',?)", (now - 90 * 86400,))
        calls = [{"function": {"name": "skill_view", "arguments": json.dumps({"name": "ops/digest"})}},
                 {"function": {"name": "terminal", "arguments": json.dumps({"command": "TOKEN=hunter2hunter2 python3 /opt/data/scripts/send.py --to boss; cat /opt/data/secrets/hook.json"})}},
                 {"function": {"name": "mcp__OMDM__get_page", "arguments": json.dumps({"id": "private-page"})}}]
        con.execute("INSERT INTO messages (session_id, role, content, tool_calls) VALUES ('cron_j1_20261005_090000','assistant','비밀 대화 내용',?)", (json.dumps(calls),))
        con.execute("INSERT INTO messages (session_id, role, content, tool_calls) VALUES ('old','assistant','x',?)", (json.dumps(calls),))
        con.commit(); con.close()
        obs = observed.collect(home)
        job = obs["jobs"]["ma/j1"]
        self.assertEqual((job["runs"], job["skills"], job["scripts"], job["mcp"]), (1, {"digest": 1}, {"scripts/send.py": 1}, {"OMDM": {"get_page": 1}}))
        blob = json.dumps(obs, ensure_ascii=False)
        for leak in ("hunter2", "비밀 대화", "private-page", "boss", "hook.json"):
            self.assertNotIn(leak, blob)
        ix = flow.build(home)
        root = next(s["id"] for s in flow.starts(ix) if s["label"] == "digest-daily")
        sub = flow.overlay(ix, flow.subgraph(ix, root), obs)
        by = {(e["to"].split(":", 1)[1].split("/")[-1], e["conf"]): e["meta"].get("observed") for e in sub["edges"]}
        self.assertEqual(by[("digest", "config")], 1)                    # 설정에 있고 실행에서도 확인
        self.assertEqual(by[("OMDM", "observed")], 1)                    # 파일에는 없고 실행에서만 보임
        self.assertEqual(sub["observed"]["scope"], "이 작업의 실행")
        self.assertIsNone(ix["out"][root][0]["meta"].get("observed"))    # 캐시된 그래프는 건드리지 않는다
        quiet = next(s["id"] for s in flow.starts(ix) if s["label"] == "send-only")
        self.assertEqual(flow.overlay(ix, flow.subgraph(ix, quiet), obs)["observed"]["scope"], "기록 없음")


if __name__ == "__main__":
    unittest.main()

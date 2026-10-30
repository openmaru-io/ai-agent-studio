# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""프로파일 관리 시험 — 가짜 Hermes 대시보드를 띄워, AAS 가 바꾸는 요청을 어디로 무엇을 보내는지와 막아야 할 것을 본다."""
import aasserver  # 실제 uvicorn 앱을 띄우는 시험 하네스(OMAI-1100)
import http.client
import json
import os
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest import mock
from urllib.parse import parse_qs, urlsplit

TMP = tempfile.TemporaryDirectory()
os.environ.setdefault("AAS_DATA_DIR", str(Path(TMP.name) / "data"))

from aas.auth import auth
from aas.fleet import pods, profiles
from aas.web import server  # noqa: E402
from aas.hermes.hermes_chat import ChatHub  # noqa: E402


class Fake(BaseHTTPRequestHandler):
    calls: list = []
    soul = "# 마케팅 에이전트\n규칙 하나\n"
    profiles = ["default", "ma", "sa"]
    export_ok = True
    gets: list = []                                                    # GET 요청 경로(캐시 시험용)
    catalog_extra: dict = {}                                           # GET /api/env 에 더할 변수(주인 시험용: 모델 제공자 키 등)
    env_down = False                                                   # GET /api/env 가 실패하는가(카탈로그를 못 읽는 경우)
    config = "# 주석\nmodel:\n  default: m1\n  provider: custom\ntimezone: Asia/Seoul\n"

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
            return self._send(200, {})
        if method == "GET":
            Fake.gets.append(u.path)
        if method != "GET":
            Fake.calls.append((method, u.path, {k: v[0] for k, v in parse_qs(u.query).items()}, body))
        if u.path == "/api/profiles" and method == "GET":
            return self._send(200, {"profiles": [{"name": n, "is_default": n == "default", "model": "m1", "provider": "custom", "has_env": True,
                                                  "path": "/opt/data" if n == "default" else f"/opt/data/profiles/{n}",
                                                  "skill_count": 3, "gateway_running": n == "ma", "description": f"{n} 소개"} for n in Fake.profiles]})
        if u.path == "/api/fs/read-text":                              # 작업 지침(AGENTS.md)은 없다 — 시험은 tests/test_profile_agents.py
            return self._send(404, {"detail": "File not found"})
        if u.path.endswith("/soul"):
            if method == "PUT":
                Fake.soul = body["content"]
            return self._send(200, {"content": Fake.soul, "exists": True})
        if u.path == "/api/config/raw":
            if method == "PUT":
                import yaml
                Fake.config = yaml.safe_dump(yaml.safe_load(body["yaml_text"]), allow_unicode=True, sort_keys=False)   # Hermes 는 다시 써서 주석이 사라진다
            return self._send(200, {"yaml": Fake.config, "path": "/opt/data/profiles/ma/config.yaml"})
        if u.path == "/api/messaging/platforms" and method == "GET":
            return self._send(200, {"platforms": [
                {"id": "telegram", "name": "Telegram", "enabled": True, "configured": True, "gateway_running": True, "state": "connected", "error_message": None, "home_channel": "",
                 "env_vars": [{"key": "TELEGRAM_BOT_TOKEN", "required": True, "is_set": True, "redacted_value": "1234…wxyz"}, {"key": "TELEGRAM_ALLOWED_USERS", "required": False, "is_set": False, "redacted_value": None}]},
                {"id": "slack", "name": "Slack", "enabled": False, "configured": False, "gateway_running": True, "state": "disabled", "env_vars": []},
                {"id": "whatsapp", "name": "WhatsApp", "enabled": False, "configured": False, "state": "disabled", "env_vars": []}]})
        if u.path == "/api/pairing" and method == "GET":
            return self._send(200, {"pending": [{"platform": "telegram", "request_id": "r1", "user_id": "42", "user_name": "kim", "code": "ABCD1234"}], "approved": [{"platform": "telegram", "user_id": "7"}]})
        if u.path.startswith("/api/messaging/platforms/") and u.path.endswith("/test"):
            return self._send(200, {"ok": False, "state": "startup_failed", "message": "Unauthorized token=abcdefghijklmnop1234"})
        if u.path.startswith("/api/messaging/platforms/") and method == "PUT":
            if (body.get("env") or {}).get("SLACK_BOT_TOKEN") == "conflict":
                return self._send(409, {"detail": "Cannot enable 'slack': already served"})
            return self._send(200, {"ok": True, "platform": u.path.rsplit("/", 1)[1], "hot_served": True})
        if u.path == "/api/env" and method == "GET" and Fake.env_down:
            return self._send(500, {"detail": "down"})
        if u.path == "/api/env" and method == "GET":
            return self._send(200, {**Fake.catalog_extra, "BUZZ_PRIVATE_KEY": {"is_set": True, "redacted_value": "nsec…9xyz", "description": "버즈 키", "category": "messaging", "channel_managed": True},
                                    "LAW_OC": {"is_set": False, "redacted_value": None, "description": "법령 키"}})
        if u.path == "/api/tools/toolsets":
            return self._send(200, [{"name": "web", "label": "웹", "description": "검색", "enabled": True, "tools": ["a", "b"]}])
        if u.path == "/api/skills":
            return self._send(200, [{"name": "ga4", "description": "지표", "enabled": True, "usage": 4, "provenance": "agent"}])
        if u.path == "/api/mcp/catalog" and method == "GET":
            return self._send(200, {"entries": [{"name": "ctx", "auth_type": "none", "needs_install": False, "transport": "http", "description": "문서"},
                                                {"name": "gh", "auth_type": "oauth", "needs_install": False, "transport": "http"}], "diagnostics": []})
        if u.path == "/api/mcp/servers":
            return self._send(200, {"servers": [{"name": "OMDM", "transport": "stdio", "command": "/opt/hermes/.venv/bin/python3", "args": ["/opt/data/scripts/bridge.py"],
                                                 "env": {"OMDM_TOKEN": "tok-abcdefghijklmnopqrstuvwxyz0123"}, "enabled": True}]})
        if u.path.endswith("/export"):
            return self._send(200, {"path": "/opt/data/exports/x.tar.gz"}) if Fake.export_ok else self._send(500, {"detail": "disk full"})
        if u.path.endswith("/test"):
            return self._send(200, {"ok": True, "tools": [1, 2, 3]})
        if method == "PATCH" and body.get("new_name") == "busy":
            return self._send(400, {"detail": "gateway is running"})
        return self._send(200, {"ok": True})

    def do_GET(self): self._handle("GET")
    def do_POST(self): self._handle("POST")
    def do_PUT(self): self._handle("PUT")
    def do_PATCH(self): self._handle("PATCH")
    def do_DELETE(self): self._handle("DELETE")
    def log_message(self, *a): pass


class ProfileTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        root = Path(TMP.name)
        cls.fake = ThreadingHTTPServer(("127.0.0.1", 0), Fake)
        threading.Thread(target=cls.fake.serve_forever, daemon=True).start()
        home = root / "ph"; (home / "profiles").mkdir(parents=True)
        reg = root / "prof-pods.json"
        reg.write_text(json.dumps({"pods": [{"id": "p", "owner": "t@example.com", "hermes_home": str(home),
                                              "dashboard_url": f"http://127.0.0.1:{cls.fake.server_port}"}]}))
        server._auth = auth.Auth({"issuer": "https://accounts.google.com", "client_id": "", "client_secret": "", "domain": "",
                                  "public_url": "http://localhost:17900", "hours": 1, "users_file": root / "none.json"})
        server._registry = pods.Registry(reg)
        cls.pod = server._registry.pods[0]
        server._hubs[cls.pod.id] = ChatHub({"url": cls.pod.dashboard_url, "provider": "basic", "user": "u", "password": "p"})
        cls.app = aasserver.start()

    @classmethod
    def tearDownClass(cls):
        cls.app.shutdown(); cls.fake.shutdown()
        server._auth = server._registry = None
        server._hubs.clear(); server._cache.clear()

    def setUp(self):
        Fake.calls.clear(); Fake.export_ok = True; Fake.profiles = ["default", "ma", "sa"]
        self.seed()
        self.old_forget = server._forget
        server._forget = lambda pod, keep=("flow",): (self.old_forget(pod, keep), self.seed())     # 수집기 대신 채워 둔 값을 쓴다
        self.old_rebuild = server._rebuild_flow
        server._rebuild_flow = lambda pod: None

    def tearDown(self):
        server._forget, server._rebuild_flow = self.old_forget, self.old_rebuild

    def seed(self):
        now, pid = time.time() + 3600, self.pod.id
        server._cache.update({
            f"{pid}:agents": (now, [{"name": "ma", "title": "Marketing Agent", "description": ""}]),
            f"{pid}:channels": (now, {"profiles": [{"name": "ma", "running": True, "platforms": [{"name": "telegram", "state": "connected"}], "issues": []},
                                                    {"name": "sa", "running": False, "platforms": [], "issues": [{"level": "bad", "text": "게이트웨이가 꺼져 있는데 크론이 있음"}]}]}),
            f"{pid}:models": (now, {"profiles": [{"name": "ma", "issues": []}], "models": [{"id": "m1", "in_litellm": True, "aas_model": True}, {"id": "m2", "in_litellm": True, "aas_model": True},
                                                                                 {"id": "ghost", "in_litellm": False, "aas_model": True}, {"id": "bge-m3-ko", "in_litellm": True, "aas_model": True},
                                                                                 {"id": "cogentai-aas-aux", "in_litellm": True, "aas_model": True},
                                                                                 {"id": "openmaru-cogentai-agent", "in_litellm": True, "aas_model": False}]}),
            f"{pid}:health": (now, {"profiles": [{"name": "ma", "jobs_total": 5, "jobs_active": 4, "failed_jobs": 1, "open_incidents": 2}]}),
            f"{pid}:credentials": (now, {"items": [{"profile": "ma", "flags": ["만료됨"]}, {"profile": "ma", "flags": []}, {"profile": "", "flags": []}]}),
            f"{pid}:activity7": (now, {"profiles": [{"name": "ma", "sessions": 9, "last_activity": "2026-10-05T06:20"}]})})

    def req(self, method, path, body=None, headers=None):
        c = http.client.HTTPConnection("127.0.0.1", self.app.server_port, timeout=10)
        c.request(method, path, body=json.dumps(body) if body is not None else None, headers={"Content-Type": "application/json", **(headers or {})})
        r = c.getresponse(); data = json.loads(r.read() or b"{}"); c.close()
        return r.status, data

    def act(self, name, action, **extra):
        return self.req("POST", "/api/profile/action", {"name": name, "action": action, **extra}, {"X-AAS": "1"})

    def test_list_and_detail_gather_everything_without_secrets(self):
        code, d = self.req("GET", "/api/profiles")
        self.assertEqual(code, 200)
        ma = next(r for r in d["profiles"] if r["name"] == "ma")
        self.assertEqual((ma["title"], ma["running"], ma["jobs_active"], ma["failed_jobs"], ma["creds"], ma["creds_expiring"], ma["sessions_7d"]),
                         ("Marketing Agent", True, 4, 1, 2, 1, 9))
        self.assertEqual({i["from"] for i in ma["issues"]}, {"크론", "자격증명"})
        self.assertEqual([r["name"] for r in d["profiles"]], ["ma", "sa", "default"])     # 문제가 있는 것이 위로, 기본은 맨 아래
        code, det = self.req("GET", "/api/profile?name=ma")
        self.assertEqual((det["soul"]["lines"][0], det["skills"][0]["name"], det["toolsets"][0]["tools"], det["models"]), ("# 마케팅 에이전트", "ga4", 2, ["m1", "m2"]))
        self.assertEqual(det["mcp"][0]["env_names"], ["OMDM_TOKEN"])
        self.assertNotIn("tok-abcdefghijklmnop", json.dumps(det))                         # MCP 의 인증값은 이름만
        # 없는 프로파일은 404 — 화면이 「그 에이전트에 이 이름이 없음」을 상태 코드로 가린다(스펙 2026-10-19-011 R8)
        code, out = self.req("GET", "/api/profile?name=nope")
        self.assertEqual((code, out.get("reason")), (404, "profile_not_found"))

    def test_action_refuses_when_the_agent_changed(self):
        """2026-10-19-011 R1 ③: 화면이 보던 에이전트(expect_pod)와 쿠키의 에이전트가 다르면 409, Hermes 에는 보내지 않는다. 같거나 없으면 통과."""
        Fake.calls.clear()
        code, out = self.act("ma", "describe", description="x", expect_pod="other-pod")
        self.assertEqual((code, out.get("reason"), Fake.calls), (409, "agent_changed", []))
        code, _ = self.act("ma", "describe", description="x", expect_pod=self.pod.id)
        self.assertEqual(code, 200)
        self.assertNotIn("expect_pod", Fake.calls[-1][3])                                     # Hermes 로 보내는 본문에는 싣지 않는다
        self.assertEqual(self.act("ma", "describe", description="x")[0], 200)                 # 옛 화면(expect_pod 없음)은 그대로

    def test_changes_go_to_the_right_hermes_api(self):
        want = [
            (("ma", "describe"), {"description": "새 소개"}, ("PUT", "/api/profiles/ma/description", {}, {"description": "새 소개"})),
            (("ma", "model"), {"model": "m2"}, ("PUT", "/api/profiles/ma/model", {}, {"provider": "custom", "model": "m2"})),
            (("ma", "gateway"), {"op": "restart"}, ("POST", "/api/gateway/restart", {"profile": "ma"}, {})),
            (("ma", "mcp_apply"), {"op": "stop"}, ("POST", "/api/gateway/restart", {"profile": "ma"}, {})),   # 다시 시작만. op 는 무시한다
            (("default", "gateway"), {"op": "start"}, ("POST", "/api/gateway/start", {}, {})),               # 기본 프로파일은 이름 없이
            (("ma", "skill"), {"target": "ga4", "enabled": False}, ("PUT", "/api/skills/toggle", {"profile": "ma"}, {"name": "ga4", "enabled": False, "profile": "ma"})),
            (("ma", "toolset"), {"target": "web", "enabled": True}, ("PUT", "/api/tools/toolsets/web", {"profile": "ma"}, {"enabled": True, "profile": "ma"})),
            (("ma", "mcp"), {"target": "OMDM", "enabled": False}, ("PUT", "/api/mcp/servers/OMDM/enabled", {"profile": "ma"}, {"enabled": False})),
            (("sa", "rename"), {"new_name": "sales"}, ("PATCH", "/api/profiles/sa", {}, {"new_name": "sales"})),
        ]
        for (name, action), extra, sent in want:
            Fake.calls.clear()
            code, out = self.act(name, action, **extra)
            self.assertEqual((code, Fake.calls[-1]), (200, sent), (name, action, out))
        code, out = self.act("ma", "mcp_test", target="OMDM")
        self.assertEqual((code, out["test"]), (200, {"ok": True, "tools": 3, "error": ""}))

    def test_refusals(self):
        for name, action, extra in [("ma", "model", {"model": "ghost"}), ("ma", "model", {"model": "bge-m3-ko"}), ("ma", "model", {"model": "nope"}), ("ma", "model", {"model": "cogentai-aas-aux"}), ("ma", "model", {"model": "openmaru-cogentai-agent"}),
                                    ("ma", "gateway", {"op": "kill"}), ("ma", "explode", {}),
                                    ("Bad Name", "create", {}), ("ma", "create", {}), ("x", "create", {"clone_from": "nope"}),
                                    ("default", "rename", {"new_name": "z"}), ("ma", "rename", {"new_name": "sa"}), ("ma", "rename", {"new_name": "../x"}), ("ma", "skill", {"target": ""})]:
            Fake.calls.clear()
            code, out = self.act(name, action, **extra)
            self.assertEqual((code, Fake.calls), (400, []), (name, action, out))           # Hermes 에는 아무것도 보내지 않는다
        Fake.calls.clear()
        code, out = self.act("nope", "describe", description="x")                          # 없는 프로파일은 404(스펙 2026-10-19-011 R8)
        self.assertEqual((code, Fake.calls), (404, []), out)
        code, out = self.act("ma", "rename", new_name="busy")
        self.assertEqual((code, out["error"]), (400, "gateway is running"))                # Hermes 의 거절은 그대로 알린다
        self.assertEqual(self.req("POST", "/api/profile/action", {"name": "ma", "action": "describe", "description": "x"})[0], 403)   # 전용 헤더 없이는 거절

    def test_only_create_rename_delete_refresh_the_agent_list_profiles(self):
        """2026-10-19-006 R3·C2: 프로파일 이름이 바뀌는 동작만 에이전트 목록의 저장값을 지우고 토픽 agents 를 깨운다. 소개·모델 저장은 둘 다 하지 않는다."""
        with mock.patch.object(server.profile_names, "forget") as forget, mock.patch.object(server.topics, "invalidate") as wake:
            self.assertEqual(self.act("ma", "describe", description="새 소개")[0], 200)
            self.assertEqual(self.act("ma", "model", model="m2")[0], 200)
            self.assertEqual((forget.call_count, [c for c in wake.call_args_list if c.args == ("agents",)]), (0, []))
            self.assertEqual(self.act("sa", "rename", new_name="sales")[0], 200)
            forget.assert_called_once_with(self.pod.id)
            self.assertIn(mock.call("agents"), wake.call_args_list)

    def test_market_records_follow_delete_and_rename(self):
        from aas.market import marketplace as mk
        def seed(profile, n):
            row = {"id": f"2026010100000000000{n}-aaaaaa", "ts": "2026-01-01T00:00:00+09:00", "pod": "p", "package": "free/hello", "namespace": "free", "name": "hello",
                   "version": "0.1.0", "kind": "skill", "profile": profile, "mode": "install", "status": "done"}
            (mk._dir("done") / (row["id"] + ".json")).write_text(json.dumps(row))
        for f in mk._dir("done").glob("*.json"):
            f.unlink()
        seed("ma", 1); seed("sa", 2)
        self.assertEqual(self.act("ma", "rename", new_name="ma2")[0], 200)
        self.assertEqual(self.act("sa", "delete", confirm="nope", skip_export=True)[0], 400)           # 거절된 삭제는 기록을 건드리지 않는다
        self.assertEqual(sorted(r["profile"] for r in mk.installed("p")), ["ma2", "sa"])
        self.assertEqual(self.act("sa", "delete", confirm="sa", skip_export=True)[0], 200)
        self.assertEqual([r["profile"] for r in mk.installed("p")], ["ma2"])
        for f in mk._dir("done").glob("*.json"):
            f.unlink()

    def test_delete_needs_typed_name_and_exports_first(self):
        for name, extra in [("default", {"confirm": "default"}), ("sa", {"confirm": "SA"}), ("sa", {})]:
            Fake.calls.clear()
            self.assertEqual((self.act(name, "delete", **extra)[0], Fake.calls), (400, []))
        Fake.export_ok = False
        code, out = self.act("sa", "delete", confirm="sa")
        self.assertEqual(code, 502); self.assertFalse(any(c[0] == "DELETE" for c in Fake.calls))   # 내보내기가 실패하면 지우지 않는다
        self.assertIn("삭제하지 않았습니다", out["error"])
        Fake.calls.clear()
        self.assertEqual(self.act("sa", "delete", confirm="nope", skip_export=True)[0], 400)   # 내보내기를 건너뛰어도 이름 확인은 필요하다
        code, out = self.act("sa", "delete", confirm="sa", skip_export=True)
        self.assertEqual((code, out["deleted"], [(c[0], c[1]) for c in Fake.calls]), (200, "sa", [("DELETE", "/api/profiles/sa")]))
        Fake.export_ok = True; Fake.calls.clear()
        code, out = self.act("sa", "delete", confirm="sa")
        self.assertEqual((code, out["deleted"], out["archive"]), (200, "sa", "/opt/data/exports/x.tar.gz"))
        self.assertEqual([(c[0], c[1]) for c in Fake.calls], [("POST", "/api/profiles/sa/export"), ("DELETE", "/api/profiles/sa")])
        server._hubs[self.pod.id].sessions["s1"] = {"profile": "ma", "title": "", "created": 1.0}
        try:
            code, out = self.act("ma", "delete", confirm="ma")
            self.assertEqual(code, 400); self.assertIn("열려 있는 대화", out["error"])
        finally:
            server._hubs[self.pod.id].sessions.clear()

    def test_soul_edit_keeps_versions_and_can_revert(self):
        Fake.soul = "# 마케팅 에이전트\n규칙 하나\n"
        sha = self.req("GET", "/api/profile?name=ma")[1]["soul"]["sha"]
        new = "# 마케팅 에이전트\n규칙 하나\n규칙 둘"
        code, pv = self.act("ma", "soul_preview", content=new)
        self.assertEqual((pv["added"], pv["removed"], pv["problem"]), (1, 0, ""))
        self.assertEqual(self.act("ma", "soul", content=new, base_sha="stale")[0], 409)
        code, out = self.act("ma", "soul", content=new, base_sha=sha)
        self.assertEqual((code, out["soul"]["versions"], Fake.soul), (200, 2, new + "\n"))
        vs = self.req("GET", "/api/profile/soul/versions?name=ma")[1]["versions"]
        self.assertEqual([v["note"] for v in vs], ["저장", "고치기 전"])
        code, d = self.req("GET", f"/api/profile/soul/diff?name=ma&id={vs[1]['id']}")
        self.assertEqual((d["added"], d["removed"]), (1, 0))
        code, out = self.act("ma", "soul_revert", id=vs[1]["id"], base_sha=out["soul"]["sha"])
        self.assertEqual((code, Fake.soul), (200, "# 마케팅 에이전트\n규칙 하나\n"))
        self.assertEqual(self.act("ma", "soul", content="x «가림» y", base_sha=out["soul"]["sha"])[0], 422)
        Fake.soul = "token = 'abcdefghijklmnopqrstuvwx'\n"                                # 비밀값이 든 글은 가려서 보여 주고 고치기를 막는다
        det = self.req("GET", "/api/profile?name=ma")[1]
        self.assertNotIn("abcdefghijklmnopqrstuvwx", json.dumps(det)); self.assertEqual(det["soul"]["masked_lines"], [1])
        self.assertEqual(self.act("ma", "soul", content="바꿈\n", base_sha=det["soul"]["sha"])[0], 403)

    def test_config_edit_is_validated_and_versioned(self):
        Fake.config = "# 주석\nmodel:\n  default: m1\n  provider: custom\ntimezone: Asia/Seoul\n"
        det = self.req("GET", "/api/profile?name=ma")[1]
        self.assertEqual(det["config"]["lines"][0], "# 주석")
        sha = det["config"]["sha"]
        for bad, why in [("model: [unclosed", "YAML"), ("- a\n- b\n", "이름: 값"), ("timezone: Asia/Seoul\n", "model 항목")]:
            code, pv = self.act("ma", "config_preview", content=bad)
            self.assertIn(why, pv["problem"])
            Fake.calls.clear()
            self.assertEqual((self.act("ma", "config", content=bad, base_sha=sha)[0], [c for c in Fake.calls if c[0] == "PUT"]), (422, []))
        new = Fake.config.replace("Asia/Seoul", "UTC")
        code, out = self.act("ma", "config", content=new, base_sha=sha)
        self.assertEqual((code, out["config"]["versions"]), (200, 2)); self.assertIn("timezone: UTC", Fake.config)
        self.assertEqual(Fake.calls[-1], ("PUT", "/api/config/raw", {"profile": "ma"}, {"yaml_text": new, "profile": "ma"}))
        vs = self.req("GET", "/api/profile/soul/versions?kind=config&name=ma")[1]["versions"]
        code, out = self.act("ma", "config_revert", id=vs[-1]["id"], base_sha=out["config"]["sha"])
        self.assertEqual(code, 200); self.assertIn("Asia/Seoul", Fake.config)
        Fake.config = "model:\n  default: m1\nproviders:\n  x:\n    api_key: 'sk-abcdefghijklmnopqrstuvwx'\n"             # 비밀값이 박힌 설정
        det = self.req("GET", "/api/profile?name=ma")[1]
        self.assertNotIn("sk-abcdefghijklmnop", json.dumps(det))
        self.assertEqual(self.act("ma", "config", content="model:\n  default: m2\n", base_sha=det["config"]["sha"])[0], 403)

    def test_actions_that_change_the_mcp_list_drop_the_tools_cache(self):
        """OMAI-1249 D9: 도구 화면의 MCP 목록이 낡지 않게, config.yaml 의 서버 목록을 바꾸는 동작은 <pod>:tools 를 지운다. 그 밖의 동작은 남긴다.
        (config·config_revert 는 설정 버전을 남겨 다른 시험의 개수를 바꾸므로 test_config_change_drops_the_credentials_cache 에서 본다.)"""
        key = f"{self.pod.id}:tools"
        Fake.config = "# 주석\nmodel:\n  default: m1\n  provider: custom\ntimezone: Asia/Seoul\n"

        def seed():
            server._cache[key] = (time.time() + 3600, {"stale": True, "items": []})
        for action, extra in [("mcp_add", dict(server="docs", kind="url", url="https://example.com/mcp", auth="header", bearer_token="tok-very-secret-1")),
                              ("mcp", dict(target="OMDM", enabled=False)), ("mcp_remove", dict(target="OMDM")), ("mcp_install", dict(server="ctx"))]:
            with self.subTest(action=action):
                seed()
                self.assertEqual(self.act("ma", action, **extra)[0], 200)
                self.assertNotIn(key, server._cache)
        for action, extra in [("env_set", dict(target="LAW_OC", value="super-secret-value-123")), ("mcp_apply", {"op": "stop"}), ("model", {"model": "m2"})]:
            with self.subTest(action=action, keeps=True):
                seed()
                self.assertEqual(self.act("ma", action, **extra)[0], 200)
                self.assertIn(key, server._cache)                          # 서버 목록을 바꾸지 않는 동작은 도구 목록 캐시를 그대로 둔다
        with self.subTest(step="GET /api/tools after an mcp change"):
            seed()
            self.assertEqual(self.act("ma", "mcp_remove", target="OMDM")[0], 200)
            code, tools = self.req("GET", "/api/tools")
            self.assertEqual(code, 200)
            self.assertNotIn("stale", tools)                               # 옛 캐시가 아니라 지금 설정으로 다시 만든 응답이다
            self.assertIn("mcp", tools)

    def test_secrets_names_only_and_set_over_secure_connection_only(self):
        det = self.req("GET", "/api/profile?name=ma")[1]
        self.assertEqual([(v["name"], v["set"]) for v in det["env"]], [("BUZZ_PRIVATE_KEY", True), ("LAW_OC", False)])
        self.assertNotIn("9xyz", json.dumps(det)); self.assertTrue(det["secure"])              # Hermes 가 준 일부 가린 값도 내보내지 않는다
        Fake.calls.clear()
        code, out = self.act("ma", "env_set", target="LAW_OC", value="super-secret-value-123")
        self.assertEqual((code, Fake.calls[-1]), (200, ("PUT", "/api/env", {"profile": "ma"}, {"key": "LAW_OC", "value": "super-secret-value-123", "profile": "ma"})))
        self.assertNotIn("super-secret", json.dumps(out))
        from aas.common import store
        with store.connect() as conn:
            notes = " ".join(str(r["note"]) for r in conn.execute("SELECT note FROM usage WHERE kind LIKE 'profile_env%'"))
        self.assertIn("LAW_OC", notes); self.assertNotIn("super-secret", notes)                # 기록에는 이름만
        for key, raw, sent in (("MCP_DOCMOST_API_KEY", "Bearer key-1", "key-1"), ("MCP_JIRA_API_KEY", "bearer  key-2", "key-2"),   # MCP 토큰은 앞의 Bearer 를 뗀다(스펙 2026-10-23-002 R7)
                               ("LAW_OC", "Bearer key-3", "Bearer key-3")):                       # 다른 비밀값은 그대로
            Fake.calls.clear()
            self.assertEqual(self.act("ma", "env_set", target=key, value=raw)[0], 200)
            self.assertEqual(Fake.calls[-1][3]["value"], sent, key)
        Fake.calls.clear()
        self.assertEqual((self.act("ma", "env_set", target="MCP_DOCMOST_API_KEY", value="Bearer ")[0], Fake.calls), (400, []))
        for extra in ({"target": "lower_case", "value": "x"}, {"target": "LAW_OC", "value": ""}, {"target": "LAW_OC", "value": "a\nb"}, {"target": "PATH;rm", "value": "x"}):
            Fake.calls.clear()
            self.assertEqual((self.act("ma", "env_set", **extra)[0], Fake.calls), (400, []))
        self.assertEqual(self.act("ma", "env_clear", target="LAW_OC", confirm="nope")[0], 400)
        Fake.calls.clear()
        self.assertEqual(self.act("ma", "env_clear", target="LAW_OC", confirm="LAW_OC")[0], 200)
        self.assertEqual(Fake.calls[-1], ("DELETE", "/api/env", {"profile": "ma"}, {"key": "LAW_OC", "profile": "ma"}))
        Fake.calls.clear()                                                                      # 사내 IP(http)로 온 요청은 받지 않는다
        code, out = self.req("POST", "/api/profile/action", {"name": "ma", "action": "env_set", "target": "LAW_OC", "value": "x1"}, {"X-AAS": "1", "Host": "10.0.0.5:17900"})
        self.assertEqual((code, Fake.calls), (403, [])); self.assertIn("암호화", out["error"])
        self.assertFalse(self.req("GET", "/api/profile?name=ma", headers={"Host": "10.0.0.5:17900"})[1]["secure"])

    def test_secret_change_records_whether_it_was_set(self):
        """사용 기록에 바꾸기 전 값이 있었는지(was_set)를 남긴다. 값은 남기지 않는다(스펙 2026-10-19-015 A4·S6)."""
        from aas.common import store

        def last_note():
            # 앞 호출 뒤에 남은 기록 하나를 읽고 지운다. usage 에는 순서 열이 없어 「마지막 줄」을 PostgreSQL 에서 가릴 수 없다
            # (ctid 는 지운 자리를 다시 쓰면 쓴 순서와 달라진다)
            with store.connect() as conn:
                rows = conn.execute("SELECT note FROM usage WHERE kind LIKE 'profile_env%'").fetchall()
                conn.execute("DELETE FROM usage WHERE kind LIKE 'profile_env%'")
            self.assertEqual(len(rows), 1)
            return str(rows[0]["note"])
        with store.connect() as conn:
            conn.execute("DELETE FROM usage WHERE kind LIKE 'profile_env%'")
        self.assertEqual(self.act("ma", "env_set", target="LAW_OC", value="first-secret-value")[0], 200)
        self.assertIn("was_set=false", last_note())
        self.assertEqual(self.act("ma", "env_set", target="BUZZ_PRIVATE_KEY", value="next-secret-value")[0], 200)
        self.assertIn("was_set=true", last_note())
        self.assertEqual(self.act("ma", "env_clear", target="BUZZ_PRIVATE_KEY", confirm="BUZZ_PRIVATE_KEY")[0], 200)
        note = last_note()
        self.assertIn("was_set=true", note)
        self.assertNotIn("secret-value", note)
        Fake.env_down = True                                                                    # 목록을 못 읽어도 관리자는 저장하고 unknown 으로 남긴다
        try:
            self.assertEqual(self.act("ma", "env_set", target="LAW_OC", value="third-secret-value")[0], 200)
        finally:
            Fake.env_down = False
        self.assertIn("was_set=unknown", last_note())

    def as_owner(self):
        """로그인이 켜져 있고 관리자가 아닌 파드 주인(t@example.com)으로 요청하게 한다. 끝나면 되돌린다."""
        reg = server._registry
        old = (server._auth, reg.is_admin)
        class On:
            enabled = True
            email = "t@example.com"
            def user(self, cookie): return {"email": self.email, "name": ""}
        server._auth = On(); reg.is_admin = lambda u: False
        Fake.catalog_extra = {"OPENAI_API_KEY": {"category": "provider", "is_set": False}, "SERPER_API_KEY": {"category": "tool", "is_set": False}}
        def restore():
            server._auth, reg.is_admin = old
            Fake.catalog_extra, Fake.env_down = {}, False
        self.addCleanup(restore)
        return On

    def test_detail_names_the_owner_only_to_an_admin_who_is_not_the_owner(self):
        """스펙 2026-10-15-011 D9·단계 1a: 관리자가 남의 에이전트를 열면 「<이름>님 전용」을 보이려고 주인 표시 이름을 준다. 그 밖에는 주지 않는다."""
        on = self.as_owner()
        self.assertNotIn("owner_name", self.req("GET", "/api/profile?name=ma")[1])                     # 주인 본인
        on.email = "x@example.com"; server._registry.is_admin = lambda u: True                          # 주인이 아닌 관리자
        d = self.req("GET", "/api/profile?name=ma")[1]
        self.assertEqual((d["owner"], d["owner_name"]), (False, "t"))                                   # 이메일 앞부분(이름을 모를 때), 이메일 전체는 주지 않는다
        self.assertNotIn("t@example.com", json.dumps(d))
        server._registry.is_admin = lambda u: False                                                     # 둘 다 아닌 사람
        self.assertNotIn("owner_name", self.req("GET", "/api/profile?name=ma")[1])

    def test_detail_says_whether_the_viewer_manages_it_apart_from_owner(self):
        """스펙 2026-10-22-001: owner 는 「내 전용」 표시라 주인만 참이고, 편집 권한은 manages(주인 또는 팀 관리자)로 알린다.
        OKE 실화면에서 팀 관리자에게 상세가 「보기 전용」으로 보인 결함(화면이 owner 로 편집을 판단)."""
        on = self.as_owner()
        reg = server._registry
        d = self.req("GET", "/api/profile?name=ma")[1]
        self.assertEqual((d["owner"], d["manages"]), (True, True))                                     # 주인
        on.email = "lead@example.com"                                                                  # 같은 팀의 팀 관리자
        reg.team_pods = lambda u: list(reg.pods) if (u or {}).get("email") == "lead@example.com" else []
        self.addCleanup(lambda: reg.__dict__.pop("team_pods", None))
        d = self.req("GET", "/api/profile?name=ma")[1]
        self.assertEqual((d["owner"], d["manages"], d["caps"]["skills"]["can"]), (False, True, True))
        on.email = "x@example.com"                                                                     # 주인도 팀 관리자도 아닌 사람은 상세를 받지 못한다
        self.assertFalse(self.req("GET", "/api/profile?name=ma")[1].get("manages"))

    def test_activity_tells_whose_agent_it_is_like_the_profile_list(self):
        """2026-10-18: 사용량 화면도 프로파일 이름 옆에 「내 전용」·「<이름>님 전용」을 보이도록 목록과 같은 owner·owner_name 을 준다."""
        on = self.as_owner()
        out = self.req("GET", "/api/activity")[1]
        self.assertIs(out.get("owner"), True)
        self.assertNotIn("owner_name", out)
        on.email = "x@example.com"; server._registry.is_admin = lambda u: True                          # 주인이 아닌 관리자
        out = self.req("GET", "/api/activity")[1]
        self.assertEqual((out.get("owner"), out.get("owner_name")), (None, "t"))
        server._registry.is_admin = lambda u: False
        self.assertNotIn("owner_name", self.req("GET", "/api/activity")[1])

    def test_owner_edits_the_settings_file_but_not_the_locked_keys(self):
        """스펙 2026-10-15-011 D4·단계 1b: 주인은 설정 파일을 고치되 model·providers 같은 잠글 키는 지금 값과 같아야 한다."""
        self.as_owner()
        old_config = Fake.config
        self.addCleanup(lambda: setattr(Fake, "config", old_config))
        Fake.config = "# 주석\nmodel:\n  default: m1\n  provider: custom\ntimezone: Asia/Seoul\n"
        det = self.req("GET", "/api/profile?name=ma")[1]
        sha = det["config"]["sha"]
        unlocked = Fake.config.replace("timezone: Asia/Seoul", "timezone: UTC")
        locked = Fake.config.replace("default: m1", "default: gpt-9")
        Fake.calls.clear()
        code, out = self.act("ma", "config", content=locked, base_sha=sha)
        self.assertEqual(code, 403); self.assertIn("model", out["error"])
        self.assertFalse(any(c[1] == "/api/config/raw" for c in Fake.calls))                        # 잠글 키를 바꾼 저장은 Hermes 로 가지 않았다
        code, prev = self.act("ma", "config_preview", content=locked)
        self.assertEqual(code, 200); self.assertIn("model", prev["problem"])                         # 미리 보기에서도 같은 문구
        self.assertEqual(self.act("ma", "config_preview", content=unlocked)[1]["problem"], "")
        self.assertEqual(self.act("ma", "config", content=unlocked, base_sha=sha)[0], 200)
        self.assertEqual(Fake.calls[-1][:2], ("PUT", "/api/config/raw"))

    def test_owner_may_run_mcp_and_rename_but_main_stays_protected(self):
        from unittest import mock
        from aas.fleet import primary
        self.as_owner()
        self.assertEqual(self.act("ma", "mcp", target="OMDM", enabled=False)[0], 200)
        self.assertEqual(self.act("ma", "mcp_test", target="OMDM")[0], 200)
        self.assertEqual(self.act("sa", "rename", new_name="sa2")[0], 200)
        with mock.patch.object(primary, "state", return_value={"profile": "ma", "state": "templated"}):
            self.assertEqual(self.act("ma", "rename", new_name="ma2")[0], 400)                       # 주 프로파일은 이름을 못 바꾼다

    def test_owner_skill_docs_notes_and_mutes_follow_the_pod_owner_and_the_hidden_root(self):
        from unittest import mock
        from aas.fleet import primary
        on = self.as_owner()
        X = {"X-AAS": "1"}
        self.assertNotEqual(self.req("POST", "/api/file/preview", {"path": "profiles/ma/skills/ops/digest/SKILL.md", "content": "---\nname: x\n---\n"}, X)[0], 403)
        # 권한을 넘는지만 본다. 일부러 모자란 요청을 보내 400 으로 끝나게 해 AAS 기록(무시·판 이름)을 바꾸지 않는다
        self.assertEqual(self.req("POST", "/api/cron/mute", {"profile": "ma"}, X)[0], 400)
        self.assertEqual(self.req("POST", "/api/text/label", {"key": "nope"}, X)[0], 400)
        with mock.patch.object(primary, "is_target", return_value=True):                           # 숨긴 루트는 주인에게 닫힌다
            self.assertEqual(self.req("POST", "/api/file/preview", {"path": "skills/ops/digest/SKILL.md", "content": "x"}, X)[0], 403)
            self.assertEqual(self.req("POST", "/api/cron/mute", {"profile": "default", "id": "j1", "mute": True}, X)[0], 403)
            self.assertEqual(self.req("POST", "/api/skill/create", {"name": "x-y", "profile": "default", "description": "x"}, X)[0], 403)
        on.email = "x@example.com"                                                                 # 이 파드의 주인이 아니다
        self.assertEqual(self.req("POST", "/api/file/preview", {"path": "profiles/ma/skills/ops/digest/SKILL.md", "content": "x"}, X)[0], 403)
        self.assertEqual(self.req("POST", "/api/cron/mute", {"profile": "ma"}, X)[0], 403)

    def drop_profile_cache(self):
        """프로파일 목록은 20초 캐시라, 가짜 Hermes 의 목록을 바꾼 뒤에는 캐시를 버려야 서버가 새 목록을 본다."""
        with server._lock:
            server._drop_locked(f"{self.pod.id}:profiles")

    def test_owner_creates_only_clones_of_the_primary_within_the_limit(self):
        """스펙 2026-10-15-011 D5·단계 2: 주인은 주 프로파일 복제만(스킬 포함), 파드당 상한(루트를 빼고 main 을 포함해 센다)."""
        from unittest import mock
        from aas.fleet import primary
        from aas.ops import owner_guard
        self.as_owner()
        with mock.patch.object(primary, "primary_of", return_value="ma"), mock.patch.object(primary, "is_target", return_value=True), \
                mock.patch.object(owner_guard, "profile_limit", return_value=3):
            Fake.calls.clear()
            self.assertEqual(self.act("new1", "create")[0], 200)                                         # 원본을 안 주면 주 프로파일(ma)
            self.assertEqual(Fake.calls[-1][:2], ("POST", "/api/profiles"))
            self.assertEqual((Fake.calls[-1][3]["clone_from"], Fake.calls[-1][3]["no_skills"]), ("ma", False))
            sent = len(Fake.calls)
            self.assertEqual(self.act("new2", "create", clone_from="sa")[0], 403)                        # 주 프로파일이 아닌 원본
            self.assertEqual(self.act("new2", "create", clone_from="ma", no_skills=True)[0], 403)        # 스킬 빼기는 관리자
            self.assertEqual(len(Fake.calls), sent)
            Fake.profiles = ["default", "ma", "sa", "side"]                                              # 루트를 빼고 main·sa·side = 3 = 상한
            self.drop_profile_cache()
            code, out = self.act("new3", "create")
            self.assertEqual(code, 409); self.assertIn("3", out["error"])
            self.assertEqual(len(Fake.calls), sent)
        with mock.patch.object(primary, "primary_of", return_value="ma"), mock.patch.object(primary, "is_target", return_value=False), \
                mock.patch.object(owner_guard, "profile_limit", return_value=3):
            Fake.profiles = ["default", "ma", "sa"]                                                       # 루트가 보이는 파드는 루트도 센다(3)
            self.drop_profile_cache()
            self.assertEqual(self.act("new3", "create")[0], 409)
        Fake.profiles = ["default", "ma", "sa"]
        self.drop_profile_cache()
        self.assertEqual(self.act("new4", "create", clone_from="sa", no_skills=True)[0], 403)            # 상한과 별개로 관리자 아닌 사람의 규칙은 그대로

    def test_share_skills_hooks_the_source_skills_folder_into_the_new_profiles_config(self):
        """스펙 2026-10-15-011 D6·단계 3: 스킬을 복사하지 않고 원본의 skills 폴더를 새 프로파일 설정에 건다. 주인도 쓸 수 있다.
        Hermes 는 복제와 no_skills 를 함께 받지 않으므로 빈 프로파일을 만들고 원본의 SOUL·설정을 직접 옮긴다(OKE 에서 확인한 오류)."""
        from unittest import mock
        from aas.fleet import primary
        from aas.ops import shared_skills
        self.as_owner()
        Fake.config = "model: x\ntelegram:\n  allowed_users: ['1']\n"
        Fake.soul = "# 원본 성격\n"
        with mock.patch.object(primary, "primary_of", return_value="ma"), mock.patch.object(primary, "is_target", return_value=True):
            Fake.calls.clear()
            code, out = self.act("shared1", "create", share_skills=True)
            self.assertEqual((code, out.get("shared_skills_from"), out.get("share_error")), (200, "ma", None), out)
            self.assertEqual(Fake.calls[0][:2], ("POST", "/api/profiles"))
            self.assertEqual((Fake.calls[0][3]["clone_from"], Fake.calls[0][3]["no_skills"]), (None, True))      # 복제하지 않고 스킬도 없이 만든다
            put = next(c for c in Fake.calls if c[1] == "/api/config/raw" and c[0] == "PUT")
            self.assertEqual(put[2], {"profile": "shared1"})
            self.assertEqual(shared_skills.dirs_of(put[3]["yaml_text"]), ["/opt/data/profiles/ma/skills"])
            self.assertIn("model: x", put[3]["yaml_text"])                                                       # 모델 같은 설정은 원본 그대로
            self.assertNotIn("telegram", put[3]["yaml_text"])                                                    # 채널 블록은 옮기지 않는다
            self.assertTrue(any(c[0] == "PUT" and c[1] == "/api/profiles/shared1/soul" and c[3]["content"] == "# 원본 성격\n" for c in Fake.calls))
            Fake.calls.clear()
            self.assertEqual(self.act("shared2", "create")[0], 200)                                              # 켜지 않으면 일반 복제
            self.assertEqual([c[1] for c in Fake.calls], ["/api/profiles"])
            self.assertEqual((Fake.calls[0][3]["clone_from"], Fake.calls[0][3]["no_skills"]), ("ma", False))

    def test_admin_clone_without_skills_copies_config_and_soul_without_clone_flag(self):
        Fake.config = "model: x\ntelegram:\n  allowed_users: ['1']\n"
        Fake.calls.clear()
        code, out = self.act("fresh", "create", clone_from="ma", no_skills=True, description="시험")
        self.assertEqual((code, out.get("copy_error")), (200, None), out)
        self.assertEqual(Fake.calls[0], ("POST", "/api/profiles", {}, {"name": "fresh", "clone_from": None, "no_skills": True, "description": "시험"}))
        self.assertTrue(any(c[0] == "PUT" and c[1] == "/api/config/raw" for c in Fake.calls))

    def test_share_skills_failure_to_edit_config_keeps_the_profile_and_reports(self):
        Fake.config = "a: [\n"                                                                                  # 읽을 수 없는 설정
        Fake.calls.clear()
        code, out = self.act("shared3", "create", clone_from="sa", share_skills=True)
        self.assertEqual(code, 200); self.assertIn("share_error", out); self.assertNotIn("shared_skills_from", out)
        self.assertFalse(any(c[0] == "PUT" for c in Fake.calls))
        self.assertEqual(self.act("shared4", "create", share_skills=True)[0], 400)                              # 원본이 없으면 거절(복제할 프로파일을 고르세요)

    def test_rejections_carry_a_reason_code_and_the_field(self):
        """디자인 결정 2A(TD3): 거절 응답은 문장과 함께 reason 코드와 거절된 칸(field)을 준다."""
        self.as_owner()
        code, out = self.act("ma", "env_set", target="OPENAI_API_KEY", value="sk-test-value-123")
        self.assertEqual((code, out["reason"], out["field"]), (403, "provider_key", "OPENAI_API_KEY"))
        self.assertEqual(self.act("ma", "env_set", target="OPENAI_BASE_URL", value="http://x")[1]["reason"], "url_proxy")
        self.assertEqual(self.act("ma", "env_set", target="HERMES_X", value="x1")[1]["reason"], "platform_var")
        code, out = self.act("ma", "channel_save", platform="telegram", enabled=True, env={"TELEGRAM_ALLOWED_USERS": "*"})
        self.assertEqual((code, out["reason"], out["field"]), (403, "allow_list_invalid", "TELEGRAM_ALLOWED_USERS"))
        code, out = self.act("ma", "channel_save", platform="telegram", enabled=True, env={"TELEGRAM_WEBHOOK_URL": "http://x"})
        self.assertEqual((out["reason"], out["field"]), ("auth_var_blocked", "TELEGRAM_WEBHOOK_URL"))
        old_config = Fake.config
        self.addCleanup(lambda: setattr(Fake, "config", old_config))
        Fake.config = "model:\n  default: m1\n  provider: custom\n"
        sha = self.req("GET", "/api/profile?name=ma")[1]["config"]["sha"]
        code, out = self.act("ma", "config", content=Fake.config.replace("m1", "gpt-9"), base_sha=sha)
        self.assertEqual((code, out.get("reason"), out.get("field")), (403, "config_locked", "model"), out)

    def test_detail_caps_give_each_tab_its_permission_and_reason(self):
        """디자인 결정 1A(TD1): 상세 응답이 탭별 권한과 막힌 이유 코드를 준다."""
        self.as_owner()
        caps = self.req("GET", "/api/profile?name=ma", headers={"Host": "localhost"})[1]["caps"]
        self.assertEqual((caps["soul"], caps["config"]), ({"can": True, "reason": ""}, {"can": True, "reason": ""}))
        self.assertEqual(caps["model"], {"can": False, "reason": "admin_only_model"})
        self.assertEqual(caps["delete"]["can"], True)
        server._registry.is_admin = lambda u: True
        caps = self.req("GET", "/api/profile?name=ma")[1]["caps"]
        self.assertEqual(caps["model"], {"can": True, "reason": ""})

    def test_main_cannot_be_renamed_even_by_admin(self):
        """2026-10-17-016: main(주 프로파일)은 관리자도 이름을 바꾸지 못한다. 상세 caps 가 그렇게 알리고 서버도 거절한다."""
        from unittest import mock
        from aas.fleet import primary
        with mock.patch.object(server._registry, "is_admin", lambda u: True), \
             mock.patch.object(primary, "state", return_value={"profile": "ma", "state": "templated"}):   # 바꾼 관리자 판정은 시험이 끝나면 되돌린다(뒤 시험에 새지 않게)
            caps = self.req("GET", "/api/profile?name=ma")[1]["caps"]
            self.assertEqual(caps["rename"], {"can": False, "reason": "main_fixed"})
            self.assertEqual(self.act("ma", "rename", new_name="ma2")[0], 400)
        with mock.patch.object(server._registry, "is_admin", lambda u: True):
            caps = self.req("GET", "/api/profile?name=ma")[1]["caps"]                   # main 이 아니면 관리자는 바꾼다
        self.assertEqual(caps["rename"], {"can": True, "reason": ""})

    def test_profile_list_tells_whose_agent_it_is(self):
        """2026-10-17-016: 목록에 「내 전용」·「<이름>님 전용」 뱃지를 보이도록 주인 여부와(관리자가 남의 것을 볼 때) 주인 표시 이름을 준다."""
        self.as_owner()
        out = self.req("GET", "/api/profiles")[1]
        self.assertIs(out["owner"], True)
        self.assertNotIn("owner_name", out)

    def test_team_manager_cannot_import_from_an_agent_of_another_department(self):
        """최종 리뷰 m5: 팀 관리자는 같은 부서 에이전트에서만 가져온다. 다른 부서 에이전트가 원본이면 403."""
        from unittest import mock
        from aas.common import settings
        from aas.fleet import pods as fp, primary
        on = self.as_owner()
        on.email = "tm@example.com"                                                    # 팀 관리자: 파드 p(주인 t)와 같은 부서
        mate = fp.Pod(id="other-mate", owner="m@example.com", hermes_home=self.pod.hermes_home, dashboard_url=self.pod.dashboard_url)
        outsider = fp.Pod(id="other-out", owner="o@example.com", hermes_home=self.pod.hermes_home, dashboard_url=self.pod.dashboard_url)
        reg = server._registry
        old = list(reg.pods)
        reg.pods.extend([mate, outsider])
        self.addCleanup(lambda: reg.pods.__setitem__(slice(None), old))
        server._hubs[mate.id] = server._hubs[outsider.id] = server._hubs[self.pod.id]
        for email, dept in (("t@example.com", "개발 1팀"), ("tm@example.com", "개발 1팀"), ("m@example.com", "개발 1팀"), ("o@example.com", "영업팀")):
            settings.set_department(email, dept)
        settings.set_team_managers("개발 1팀", ["tm@example.com"])
        settings.reset_cache()
        def cleanup():
            with server.store.connect() as conn:
                conn.execute("DELETE FROM team_managers WHERE email='tm@example.com'")
                conn.execute("DELETE FROM user_directory WHERE email IN ('t@example.com','tm@example.com','m@example.com','o@example.com')")
            settings.reset_cache()
        self.addCleanup(cleanup)
        with mock.patch.object(primary, "primary_of", return_value="ma"), mock.patch.object(primary, "is_target", return_value=True):
            self.assertEqual(self.act("imp1", "create", import_from={"pod": "other-out", "profile": "ma"})[0], 403)    # 다른 부서
            self.assertNotEqual(self.act("imp1", "create", import_from={"pod": "other-mate", "profile": "ma"})[0], 403)  # 같은 부서는 통과

    def test_import_from_another_agent_needs_ownership_of_the_source_and_sends_only_safe_parts(self):
        """스펙 2026-10-15-011 D8·단계 4: 원본 파드는 내 것이어야 하고, 설정은 받는 쪽 잠글 값을 지킨 채 SOUL·안전한 키만 얹는다."""
        from unittest import mock
        from aas.fleet import pods as fp, primary
        self.as_owner()
        mine = fp.Pod(id="other-mine", owner="t@example.com", hermes_home=self.pod.hermes_home, dashboard_url=self.pod.dashboard_url)
        theirs = fp.Pod(id="other-theirs", owner="z@example.com", hermes_home=self.pod.hermes_home, dashboard_url=self.pod.dashboard_url)
        (Path(self.pod.hermes_home) / "profiles" / "ma").mkdir(parents=True, exist_ok=True)                            # 원본 프로파일 폴더(읽기 사이드카가 보는 곳)
        reg = server._registry
        old = list(reg.pods)
        reg.pods.extend([mine, theirs])
        self.addCleanup(lambda: reg.pods.__setitem__(slice(None), old))
        server._hubs[mine.id] = server._hubs[theirs.id] = server._hubs[self.pod.id]
        with mock.patch.object(primary, "primary_of", return_value="ma"), mock.patch.object(primary, "is_target", return_value=True):
            self.assertEqual(self.act("imp1", "create", import_from={"pod": "other-theirs", "profile": "ma"})[0], 403)    # 남의 에이전트
            self.assertEqual(self.act("imp1", "create", import_from={"pod": self.pod.id, "profile": "ma"})[0], 403)       # 지금 보는 에이전트 자신
            Fake.calls.clear()
            code, out = self.act("imp1", "create", import_from={"pod": "other-mine", "profile": "ma"})
            self.assertEqual((code, out.get("import_error")), (200, None), out)
            self.assertEqual(out["imported"]["pod"], "other-mine")
            self.assertEqual((Fake.calls[0][1], Fake.calls[0][3]["clone_from"], Fake.calls[0][3]["no_skills"]), ("/api/profiles", "ma", False))      # 받는 쪽 주 프로파일 복제로 시작
            self.assertEqual(self.act("imp2", "create", import_from={"pod": "other-mine", "profile": "ghost"})[0], 400)
            temp = Path(self.pod.hermes_home) / "profiles" / "pcimp-abc123abc123"                                       # PC 가져오기 임시 프로파일(OMAI-1444 ROV7)
            temp.mkdir()
            self.addCleanup(temp.rmdir)
            src = self.req("GET", "/api/profiles/importable")
            self.assertEqual(src[0], 200)
            self.assertEqual([s["pod"] for s in src[1]["sources"]], ["other-mine"])                                        # 내 다른 에이전트만 보인다
            self.assertIn("ma", src[1]["sources"][0]["profiles"])
            self.assertNotIn(temp.name, src[1]["sources"][0]["profiles"])                                                  # 고르개에서 뺀다
            with mock.patch.object(server.office, "agent_names_provider", return_value={"other-mine": "둘째 에이전트"}):
                one = self.req("GET", "/api/profiles/importable")[1]["sources"][0]
            self.assertEqual((one["name"], one["owner_name"]), ("둘째 에이전트", "t"))                                     # 화면이 「주인 · 에이전트 › 프로파일」로 그린다(2026-10-19-003)

    def test_admin_create_has_no_owner_restrictions(self):
        from unittest import mock
        from aas.ops import owner_guard
        with mock.patch.object(owner_guard, "profile_limit", return_value=1):
            self.assertEqual(self.act("adm1", "create", clone_from="sa", no_skills=True)[0], 200)

    def test_owner_deletes_any_profile_except_main_and_the_seats_follow(self):
        from unittest import mock
        from aas.fleet import primary
        self.as_owner()
        with mock.patch.object(primary, "state", return_value={"profile": "ma", "state": "templated"}), \
                mock.patch.object(server.office, "forget_profile", return_value={"seats": 1, "rooms": 1}) as forget:
            Fake.calls.clear()
            code, out = self.act("sa", "delete", confirm="sa")
            self.assertEqual(code, 200)
            self.assertEqual(Fake.calls[-1][:2], ("DELETE", "/api/profiles/sa"))
            forget.assert_called_once_with("p", "sa", "t@example.com")                                   # 삭제가 성공한 뒤에 자리·방을 정리한다
            forget.reset_mock()
            self.assertEqual(self.act("ma", "delete", confirm="ma")[0], 400)                              # 주 프로파일은 지울 수 없다
            self.assertEqual(self.act("default", "delete", confirm="default")[0], 403)                    # 숨긴 루트는 주인에게 닫힌다(is_target 참일 때)
            forget.assert_not_called()

    def test_failed_delete_keeps_the_seats(self):
        from unittest import mock
        self.as_owner()
        Fake.export_ok = False                                                                            # 내보내기가 실패하면 삭제하지 않는다
        with mock.patch.object(server.office, "forget_profile") as forget:
            code, _ = self.act("sa", "delete", confirm="sa")
            self.assertEqual(code, 502)
            forget.assert_not_called()

    def test_profiles_list_tells_the_owner_whether_adding_is_allowed(self):
        from unittest import mock
        from aas.ops import owner_guard
        self.as_owner()
        with mock.patch.object(owner_guard, "profile_limit", return_value=5):
            d = self.req("GET", "/api/profiles")[1]
        self.assertEqual((d["can_create"], d["profile_limit"]), (True, {"used": 3, "max": 5}))            # default·ma·sa
        server._registry.is_admin = lambda u: False
        self.assertFalse(self.req("GET", "/api/profiles")[1]["can_edit"])

    def test_owner_detail_marks_blocked_variables_with_a_reason_but_admin_does_not(self):
        """디자인 결정 2C(TD5): 주인 화면의 상세 응답은 서버가 막는 변수에 잠금 사유를 붙이고, 관리자 응답에는 없다."""
        self.as_owner()
        env = {r["name"]: r for r in self.req("GET", "/api/profile?name=ma")[1]["env"]}
        self.assertTrue(env["OPENAI_API_KEY"]["locked"] and env["SERPER_API_KEY"]["locked"] == "")      # 모델 제공자 키는 잠금, 도구 키는 열림
        self.assertIn("OPENAI_API_KEY", env["OPENAI_API_KEY"]["locked"])
        server._registry.is_admin = lambda u: True
        self.assertNotIn("locked", self.req("GET", "/api/profile?name=ma")[1]["env"][0])

    def test_owner_secrets_follow_the_name_rules(self):
        """스펙 2026-10-15-011 D3: 주인은 도구·스킬 키와 새 이름만, 모델 제공자 키·동작·채널 변수는 거절."""
        self.as_owner()
        Fake.calls.clear()
        self.assertEqual(self.act("ma", "env_set", target="SERPER_API_KEY", value="serper-secret-1")[0], 200)
        self.assertEqual(self.act("ma", "env_set", target="MY_SKILL_KEY", value="x-secret-2")[0], 200)
        self.assertEqual(self.act("ma", "env_clear", target="MY_SKILL_KEY", confirm="MY_SKILL_KEY")[0], 200)
        sent = len(Fake.calls)
        for key in ("OPENAI_API_KEY", "HERMES_LLM_API_KEY", "GATEWAY_ALLOW_ALL_USERS", "TERMINAL_ENV", "OPENAI_BASE_URL", "BUZZ_PRIVATE_KEY"):
            code, out = self.act("ma", "env_set", target=key, value="v1-secret-xyz")
            self.assertEqual(code, 403, key)
            self.assertNotIn("v1-secret-xyz", json.dumps(out))
        self.assertEqual(self.act("ma", "env_clear", target="HERMES_LLM_API_KEY", confirm="HERMES_LLM_API_KEY")[0], 403)    # 지우기도 같은 규칙
        self.assertEqual(len(Fake.calls), sent)                                                                              # 거절한 것은 Hermes 로 가지 않았다

    def test_owner_secret_is_refused_when_the_variable_list_cannot_be_read(self):
        self.as_owner()
        Fake.env_down = True
        Fake.calls.clear()
        self.assertEqual(self.act("ma", "env_set", target="SERPER_API_KEY", value="serper-secret-1")[0], 403)        # fail-closed
        self.assertFalse(any(c[1] == "/api/env" for c in Fake.calls))

    def test_owner_channel_saves_token_and_user_ids_but_not_open_bot_settings(self):
        self.as_owner()
        Fake.calls.clear()
        ok = self.chan("channel_save", platform="telegram", enabled=True, env={"TELEGRAM_BOT_TOKEN": "123:tok", "TELEGRAM_ALLOWED_USERS": "42,77"})
        self.assertEqual(ok[0], 200)
        self.assertEqual(Fake.calls[-1][1], "/api/messaging/platforms/telegram")
        sent = len(Fake.calls)
        bad = [{"TELEGRAM_ALLOWED_USERS": "*"}, {"TELEGRAM_ALLOWED_USERS": "42,,77"}, {"TELEGRAM_ALLOW_ALL_USERS": "true"}, {"GATEWAY_ALLOWED_USERS": "42"},
               {"TELEGRAM_GROUP_ALLOWED_USERS": "42"}, {"OPENAI_API_KEY": "sk-x"}, {"TELEGRAM_PROXY": "http://x"}]
        for env in bad:
            code, out = self.chan("channel_save", platform="telegram", enabled=True, env=env)
            self.assertEqual(code, 403, env)
        self.assertEqual(self.chan("channel_save", platform="telegram", clear_env=["HERMES_LLM_API_KEY"])[0], 403)
        self.assertEqual(self.chan("channel_save", platform="telegram", clear_env=["TELEGRAM_ALLOWED_USERS"])[0], 200)
        self.assertEqual(self.chan("channel_test", platform="telegram")[0], 200)
        self.assertEqual(self.chan("pairing_approve", platform="telegram", request_id="r1")[0], 200)
        self.assertEqual(len(Fake.calls), sent + 3)                                                                          # 거절한 것은 Hermes 로 가지 않았다

    def test_owner_sees_the_pairing_list_and_admin_only_actions_stay_closed(self):
        self.as_owner()
        code, out = self.req("GET", "/api/channels/platforms?profile=ma")
        self.assertEqual(code, 200)
        self.assertEqual([r["request_id"] for r in out["pairing"]["pending"]], ["r1"])
        self.assertEqual(self.act("ma", "config", content="model:\n  default: m1\n", base_sha="x")[0], 403)     # 설정 파일은 단계 1b 전까지 관리자만

    def test_owner_actions_on_the_hidden_root_are_refused_but_admin_may(self):
        from unittest import mock
        from aas.fleet import primary
        on = self.as_owner()
        with mock.patch.object(primary, "is_target", return_value=True):
            for action, extra in (("env_set", {"target": "SERPER_API_KEY", "value": "serper-secret-1"}), ("env_clear", {"target": "SERPER_API_KEY", "confirm": "SERPER_API_KEY"}),
                                  ("channel_save", {"platform": "telegram", "enabled": False}), ("toolset", {"target": "web", "enabled": True}), ("soul", {"content": "x", "base_sha": "x"})):
                code, _ = self.req("POST", "/api/profile/action", {"name": "default", "action": action, **extra}, {"X-AAS": "1"})
                self.assertEqual(code, 403, action)
            reg = server._registry
            reg.is_admin = lambda u: True                                                                                        # 관리자는 루트(숨김)를 지금처럼 다룬다
            self.assertEqual(self.req("POST", "/api/profile/action", {"name": "default", "action": "env_set", "target": "SERPER_API_KEY", "value": "serper-secret-1"}, {"X-AAS": "1"})[0], 200)

    def test_mcp_add_remove_catalog_and_install_go_to_hermes_and_keep_secrets_out_of_the_log(self):
        """스펙 2026-10-15-025: 새 동작 4개의 요청 모양, 비밀 값이 기록에 없는 것, 읽기(카탈로그)는 기록하지 않는 것."""
        Fake.calls.clear()
        code, out = self.act("ma", "mcp_add", server="docs", kind="url", url="https://example.com/mcp", auth="header", bearer_token="tok-very-secret-1")
        self.assertEqual((code, out["ok"]), (200, True))
        self.assertEqual(Fake.calls[-1], ("POST", "/api/mcp/servers", {"profile": "ma"},
                                          {"name": "docs", "profile": "ma", "url": "https://example.com/mcp", "auth": "header", "bearer_token": "tok-very-secret-1"}))
        Fake.calls.clear()
        code, out = self.act("ma", "mcp_add", server="mem", kind="stdio", command="uvx", args=["mcp-server-time"], env={"API_TOKEN": "env-very-secret-2"})
        self.assertEqual(code, 200)
        put, post = Fake.calls[0], Fake.calls[1]
        self.assertEqual(put[:2], ("PUT", "/api/env")); self.assertRegex(put[3]["key"], r"^MCP_MEM__API_TOKEN__[0-9A-F]{4}$")
        self.assertEqual(post[3]["env"], {"API_TOKEN": "${" + put[3]["key"] + "}"})
        Fake.calls.clear()
        self.assertEqual(self.act("ma", "mcp_remove", target="OMDM")[0], 200)
        self.assertEqual(Fake.calls[-1], ("DELETE", "/api/mcp/servers/OMDM", {"profile": "ma"}, {}))
        code, cat = self.act("ma", "mcp_catalog")
        self.assertEqual(([e["name"] for e in cat["entries"]], cat["hidden"]["oauth"]), (["docmost", "outline", "ctx"], 1))   # AAS 의 Docmost·Outline 항목이 늘 맨 앞(스펙 2026-10-23-002 12-6, 2026-10-23-004)
        Fake.calls.clear()
        self.assertEqual(self.act("ma", "mcp_install", server="ctx")[0], 200)
        self.assertEqual(Fake.calls[-1], ("POST", "/api/mcp/catalog/install", {"profile": "ma"}, {"name": "ctx", "env": {}, "enable": True, "profile": "ma"}))
        self.assertEqual(self.act("ma", "mcp_install", server="gh")[0], 400)                          # OAuth 항목은 서버가 거절한다
        self.assertEqual(self.act("ma", "mcp_docmost_write", write=True)[0], 404)                    # Docmost 를 설치하지 않은 프로파일(스펙 2026-10-23-002 12-6)
        self.assertEqual(self.act("ma", "mcp_outline_write", write=True)[0], 404)                    # Outline 도 같다(스펙 2026-10-23-004)
        from aas.common import store
        with store.connect() as conn:
            rows = [(r["kind"], str(r["note"])) for r in conn.execute("SELECT kind, note FROM usage WHERE kind LIKE 'profile_mcp%'")]
        notes = " ".join(n for _, n in rows)
        self.assertNotIn("very-secret", notes)
        self.assertIn("docs", notes)                                                                   # 서버 이름·방식은 남는다
        self.assertNotIn("profile_mcp_catalog", [k for k, _ in rows])                                  # 읽기는 기록하지 않는다

    def test_docmost_install_also_requests_the_docmost_skill_for_that_profile(self):
        """스펙 2026-10-23-002 12-8: 카탈로그 Docmost 설치가 성공하면 서버가 같은 프로파일에 docmost 스킬 설치를 요청하고 결과를 알린다."""
        from aas.market import marketplace
        from aas.ops import mcp_servers
        calls = []
        with mock.patch.object(mcp_servers, "install", return_value={"ok": True, "name": "docmost", "skill_package": "free/docmost"}), \
             mock.patch.object(marketplace, "install_companion", side_effect=lambda *a: calls.append(a) or "queued"):
            code, out = self.act("ma", "mcp_install", server="docmost", env={})
        self.assertEqual((code, out.get("skill")), (200, "queued"))
        self.assertEqual((calls[0][0], calls[0][2], calls[0][3]), (self.pod.id, "ma", "free/docmost"))
        with mock.patch.object(mcp_servers, "install", return_value={"ok": True, "name": "ctx"}), \
             mock.patch.object(marketplace, "install_companion") as comp:
            self.assertEqual(self.act("ma", "mcp_install", server="ctx")[0], 200)
        comp.assert_not_called()                                                                      # 다른 카탈로그 항목은 스킬을 함께 설치하지 않는다

    def test_mcp_secrets_are_refused_over_an_unencrypted_connection(self):
        Fake.calls.clear()
        code, out = self.req("POST", "/api/profile/action", {"name": "ma", "action": "mcp_add", "server": "docs", "kind": "url", "url": "https://example.com/mcp",
                                                              "auth": "header", "bearer_token": "tok-1"}, {"X-AAS": "1", "Host": "10.0.0.5:17900"})
        self.assertEqual((code, Fake.calls), (403, [])); self.assertIn("암호화", out["error"])
        code, _ = self.req("POST", "/api/profile/action", {"name": "ma", "action": "mcp_add", "server": "docs", "kind": "url", "url": "https://example.com/mcp"}, {"X-AAS": "1", "Host": "10.0.0.5:17900"})
        self.assertEqual(code, 200)                                                                    # 비밀이 없으면 http 화면에서도 된다

    def test_mcp_new_actions_refuse_the_hidden_root_and_non_owners_and_other_people(self):
        from unittest import mock
        from aas.fleet import primary
        on = self.as_owner()
        calls = (("mcp_add", {"server": "docs", "kind": "url", "url": "https://example.com/mcp"}), ("mcp_remove", {"target": "OMDM"}), ("mcp_catalog", {}), ("mcp_install", {"server": "ctx"}))
        for action, extra in calls:                                                                    # 주인은 모두 할 수 있다
            self.assertEqual(self.act("ma", action, **extra)[0], 200, action)
        with mock.patch.object(primary, "is_target", return_value=True):
            for action, extra in calls:
                code, _ = self.req("POST", "/api/profile/action", {"name": "default", "action": action, **extra}, {"X-AAS": "1"})
                self.assertEqual(code, 403, action)                                                    # 숨긴 루트는 처리기 경로에서 거절한다
        on.email = "x@example.com"                                                                     # 이 파드의 주인이 아니다
        for action, extra in calls:
            self.assertEqual(self.act("ma", action, **extra)[0], 403, action)

    def test_only_mcp_test_waits_longer_than_thirty_seconds_and_a_timeout_is_not_an_error(self):
        from unittest import mock
        from aas.hermes.hermes_api import HermesAPI, HermesError
        orig, seen = HermesAPI.call, []
        def spy(self, method, path, body=None, query=None, timeout=30):
            seen.append((path.rsplit("/", 1)[-1] if "/test" in path else path, timeout))
            if path.endswith("/test") and getattr(spy, "slow", False):
                raise HermesError("slow", 504, "timeout")
            return orig(self, method, path, body, query, timeout)
        with mock.patch.object(HermesAPI, "call", spy):
            self.act("ma", "mcp_test", target="OMDM")
            self.act("ma", "mcp", target="OMDM", enabled=False)
            self.act("ma", "toolset", target="web", enabled=True)
            self.assertEqual([t for p, t in seen if p == "test"], [45])
            self.assertTrue(all(t == 30 for p, t in seen if p != "test"))
            spy.slow = True
            code, out = self.act("ma", "mcp_test", target="OMDM")
        self.assertEqual((code, out["test"]["ok"], out["test"].get("timeout")), (200, False, True))

    def test_non_owner_cannot_use_secret_or_channel_actions(self):
        on = self.as_owner()
        on.email = "x@example.com"                                                                                               # 이 파드의 주인이 아니다
        self.assertEqual(self.act("ma", "env_set", target="SERPER_API_KEY", value="serper-secret-1")[0], 403)
        self.assertEqual(self.chan("channel_save", platform="telegram", enabled=False)[0], 403)

    def chan(self, action, **extra):
        return self.req("POST", "/api/profile/action", {"name": "ma", "action": action, **extra}, {"X-AAS": "1"})

    def test_channel_save_goes_to_hermes_and_keeps_values_out_of_logs(self):
        """스펙 2026-10-15-003 단계 2: 채널 연결은 profile/action 동작이고 env_set 과 같은 규칙(https·값 비공개)을 따른다."""
        Fake.calls.clear()
        code, out = self.chan("channel_save", platform="telegram", enabled=True, env={"TELEGRAM_BOT_TOKEN": " 1234567:secret-token-xyz ", "TELEGRAM_ALLOWED_USERS": "42"}, clear_env=["TELEGRAM_HOME_CHANNEL"])
        self.assertEqual((code, out["hot_served"]), (200, True))
        self.assertEqual(Fake.calls[-1], ("PUT", "/api/messaging/platforms/telegram", {"profile": "ma"},
                                          {"enabled": True, "env": {"TELEGRAM_BOT_TOKEN": "1234567:secret-token-xyz", "TELEGRAM_ALLOWED_USERS": "42"}, "clear_env": ["TELEGRAM_HOME_CHANNEL"]}))
        self.assertNotIn("secret-token", json.dumps(out))
        from aas.common import store
        with store.connect() as conn:
            notes = " ".join(str(r["note"]) for r in conn.execute("SELECT note FROM usage WHERE kind LIKE 'profile_channel%'"))
        self.assertIn("TELEGRAM_BOT_TOKEN", notes); self.assertNotIn("secret-token", notes)             # 기록에는 이름만

    def test_channel_save_refuses_bad_input_and_insecure_connections(self):
        for extra in ({"platform": "whatsapp", "enabled": True}, {"platform": "telegram"},                      # 1단계 밖의 채널, 바꿀 것이 없음
                      {"platform": "telegram", "env": {"lower": "x"}}, {"platform": "telegram", "env": {"TELEGRAM_BOT_TOKEN": "a\nb"}},
                      {"platform": "telegram", "clear_env": ["bad name"]}):
            Fake.calls.clear()
            self.assertEqual((self.chan("channel_save", **extra)[0], Fake.calls), (400, []), extra)
        Fake.calls.clear()
        code, out = self.req("POST", "/api/profile/action", {"name": "ma", "action": "channel_save", "platform": "telegram", "env": {"TELEGRAM_BOT_TOKEN": "x1"}},
                             {"X-AAS": "1", "Host": "10.0.0.5:17900"})
        self.assertEqual((code, Fake.calls), (403, [])); self.assertIn("암호화", out["error"])
        self.assertEqual(self.chan("channel_save", platform="telegram", enabled=False)[0], 200)             # 값이 없는 끄기는 받는다

    def test_channel_save_passes_hermes_conflict_through(self):
        code, out = self.chan("channel_save", platform="slack", enabled=True, env={"SLACK_BOT_TOKEN": "conflict"})
        self.assertEqual(code, 409); self.assertIn("already served", out["error"])

    def test_channel_test_returns_masked_message_and_pairing_goes_to_hermes(self):
        code, out = self.chan("channel_test", platform="telegram")
        self.assertEqual((code, out["test"]["ok"], out["test"]["state"]), (200, False, "startup_failed"))
        self.assertNotIn("abcdefghijklmnop1234", json.dumps(out))
        Fake.calls.clear()
        self.assertEqual(self.chan("pairing_approve", platform="telegram", request_id="r1")[0], 200)
        self.assertEqual(Fake.calls[-1], ("POST", "/api/pairing/approve", {"profile": "ma"}, {"platform": "telegram", "request_id": "r1", "profile": "ma"}))
        self.assertEqual(self.chan("pairing_revoke", platform="telegram", user_id="7")[0], 200)
        self.assertEqual(Fake.calls[-1], ("POST", "/api/pairing/revoke", {"profile": "ma"}, {"platform": "telegram", "user_id": "7", "profile": "ma"}))
        self.assertEqual(self.chan("pairing_approve", platform="telegram")[0], 400)

    def test_channel_actions_refuse_hidden_root(self):
        from unittest import mock
        from aas.fleet import primary
        with mock.patch.object(primary, "is_target", return_value=True):
            code, _ = self.req("POST", "/api/profile/action", {"name": "default", "action": "channel_save", "platform": "telegram", "enabled": True}, {"X-AAS": "1"})
        self.assertEqual(code, 400)

    def test_channel_platforms_read_is_trimmed_cached_and_dropped_on_save(self):
        Fake.gets.clear()
        code, out = self.req("GET", "/api/channels/platforms?profile=ma")
        self.assertEqual(code, 200)
        self.assertEqual([p["id"] for p in out["platforms"]], ["telegram", "slack"])                  # whatsapp 은 1단계 밖
        tg = out["platforms"][0]
        self.assertEqual([(v["key"], v["is_set"]) for v in tg["env_vars"]], [("TELEGRAM_BOT_TOKEN", True), ("TELEGRAM_ALLOWED_USERS", False)])
        self.assertNotIn("wxyz", json.dumps(out))                                                      # 가린 값도 내보내지 않는다
        self.assertEqual([p["request_id"] for p in out["pairing"]["pending"]], ["r1"])
        self.req("GET", "/api/channels/platforms?profile=ma")
        self.assertEqual(Fake.gets.count("/api/messaging/platforms"), 1)                               # 20초 캐시
        self.assertEqual(self.chan("channel_save", platform="telegram", enabled=True)[0], 200)
        self.req("GET", "/api/channels/platforms?profile=ma")
        self.assertEqual(Fake.gets.count("/api/messaging/platforms"), 2)                               # 저장하면 비운다
        self.assertEqual(self.req("GET", "/api/channels/platforms?profile=nope")[0], 400)

    def test_skill_create_goes_to_hermes_with_frontmatter(self):
        server._cache[f"{self.pod.id}:skills"] = (time.time() + 3600, {"skills": [{"name": "ga4", "profile": "default"}]})
        (self.pod.hermes_home / "profiles" / "ma").mkdir(parents=True, exist_ok=True)
        X = {"X-AAS": "1"}
        mk = lambda **b: self.req("POST", "/api/skill/create", b, X)            # noqa: E731
        Fake.calls.clear()
        code, out = mk(name="weekly-report", profile="ma", category="ops", description="주간 보고를 만든다", body="# weekly-report\n\n## 실행\n1. 모은다")
        self.assertEqual((code, out["name"]), (200, "weekly-report"))
        sent = Fake.calls[-1]
        self.assertEqual((sent[0], sent[1], sent[3]["name"], sent[3]["category"], sent[3]["profile"]), ("POST", "/api/skills", "weekly-report", "ops", "ma"))
        self.assertTrue(sent[3]["content"].startswith('---\nname: weekly-report\ndescription: "주간 보고를 만든다"\nversion: 1.0.0\n---\n\n# weekly-report'))
        # 머리말에 필요한 환경 변수·태그·관련 스킬(이 프로파일에서 보이는 스킬만)을 넣는다(2026-10-28-004 §9)
        server._cache[f"{self.pod.id}:skills"] = (time.time() + 3600, {"skills": [{"name": "ga4", "profile": "default"}]})
        Fake.calls.clear()
        code, _ = mk(name="weekly-mail", profile="ma", description="보낸다", body="# weekly-mail\n\n소개", env=["SMTP_PASSWORD"], tags=["메일"], related=["ga4"])
        self.assertEqual(code, 200)
        self.assertIn('version: 1.0.0\nrequired_environment_variables: ["SMTP_PASSWORD"]\nmetadata:\n  hermes:\n    tags: ["메일"]\n    related_skills: ["ga4"]\n---\n', Fake.calls[-1][3]["content"])
        for bad in (dict(name="Bad Name", profile="ma", description="x"), dict(name="ga4", profile="ma", description="x"), dict(name="new-one", profile="nope", description="x"),
                    dict(name="new-one", profile="ma", description=""), dict(name="new-one", profile="ma", description="x", body="token = 'abcdefghijklmnopqrstuvwx'"),
                    dict(name="new-one", profile="ma", description="x", env=["1BAD"]), dict(name="new-one", profile="ma", description="x", tags=["a,b"]),
                    dict(name="new-one", profile="ma", description="x", related=["nope"]), dict(name="new-one", profile="ma", description="x", related=["new-one"])):
            Fake.calls.clear()
            server._cache[f"{self.pod.id}:skills"] = (time.time() + 3600, {"skills": [{"name": "ga4", "profile": "default"}]})   # 만든 뒤에는 목록을 새로 읽으므로 다시 채운다
            self.assertEqual((mk(**bad)[0], Fake.calls), (400, []), bad)
        self.assertEqual(self.req("POST", "/api/skill/create", {"name": "x-y", "profile": "ma", "description": "x"})[0], 403)

    def test_skill_create_on_a_pod_with_a_hidden_root(self):
        """OMAI-1195: 주 에이전트(main)를 쓰는 POD 는 루트(default)를 숨긴다. 화면이 공용(default)을 기본으로 보내 「없는 프로파일입니다」로 거절됐다.
        루트가 숨겨진 POD 에서 default 는 무엇을 바꿔야 하는지 알려 주는 400, 주 에이전트 이름은 성공, 루트가 보이는 POD 의 default 는 지금처럼 성공."""
        (self.pod.hermes_home / "profiles" / "ma").mkdir(parents=True, exist_ok=True)
        X = {"X-AAS": "1"}
        mk = lambda profile: self.req("POST", "/api/skill/create", {"name": "weekly-report", "profile": profile, "description": "주간 보고를 만든다"}, X)   # noqa: E731
        fill = lambda: server._cache.__setitem__(f"{self.pod.id}:skills", (time.time() + 3600, {"skills": []}))   # 만든 뒤에는 목록을 새로 읽으므로 다시 채운다
        with mock.patch.object(server.cron_policy, "root_hidden", return_value=True):
            fill(); Fake.calls.clear()
            code, out = mk("default")
            self.assertEqual((code, Fake.calls), (400, []))                          # Hermes 로 아무것도 보내지 않는다
            self.assertIn("main", out["error"])                                       # 무엇을 고르면 되는지 알려 준다
            self.assertNotEqual(out["error"], "없는 프로파일입니다")
            fill(); Fake.calls.clear()
            code, out = mk("ma")
            self.assertEqual((code, Fake.calls[-1][3]["profile"]), (200, "ma"))
        with mock.patch.object(server.cron_policy, "root_hidden", return_value=False):
            fill(); Fake.calls.clear()
            code, out = mk("default")                                                 # 루트가 보이는 POD 는 지금처럼
            self.assertEqual((code, out["profile"], Fake.calls[-1][3]["profile"]), (200, "default", None))

    def test_skills_list_tells_the_screen_where_a_new_skill_can_go(self):
        """OMAI-1195: 화면이 위치 목록을 서버가 준 값으로 만든다. 루트가 숨겨진 POD 에서는 default 가 목록에 없고 주 에이전트 이름을 함께 준다."""
        server._cache[f"{self.pod.id}:skills"] = (time.time() + 3600, {"built_at": "x", "totals": {}, "skills": [], "by_mcp": {}, "by_host": {}, "mcp_configured": []})
        (self.pod.hermes_home / "profiles" / "ma").mkdir(parents=True, exist_ok=True)
        with mock.patch.object(server.cron_policy, "root_hidden", return_value=True), mock.patch.object(server.primary, "primary_of", return_value="ma"):
            code, d = self.req("GET", "/api/skills")
            self.assertEqual(code, 200)
            self.assertNotIn("default", d["profiles"])
            self.assertIn("ma", d["profiles"])
            self.assertEqual(d["primary"], "ma")
        with mock.patch.object(server.cron_policy, "root_hidden", return_value=False):
            code, d = self.req("GET", "/api/skills")
            self.assertIn("default", d["profiles"])                                   # 루트가 보이는 POD 는 공용이 있다

    def test_skill_list_translation_keeps_tags_and_cache(self):
        """스펙 2026-10-19-017 P5·D9: 태그는 원문 설명으로 찾고, 번역은 응답 사본에만 붙는다(저장값의 설명은 원문)."""
        from aas.market import skill_desc
        desc = "Box manages cloud files, sharing, search, and metadata."
        row = {"id": "default/box", "name": "box", "profile": "default", "description": desc, "modified": "", "origin": "bundled",
               "mcp": [], "rest": [], "scripts": [], "external_scripts": [], "cron": []}
        graph = {"built_at": "x", "totals": {}, "skills": [row], "by_mcp": {}, "by_host": {}, "mcp_configured": []}
        from aas.common import i18n
        for lang in ("ko", "en"):                                                     # 스킬 묶음 저장값은 언어별(_cached per_lang)
            i18n.set_lang(lang)
            server._cache[server._lang_key(f"{self.pod.id}:skills", True)] = (time.time() + 3600, graph)
        i18n.set_lang("ko")
        self.addCleanup(server._cache.clear)
        seen = []
        with mock.patch.object(server.cron_policy, "root_hidden", return_value=False), \
                mock.patch.object(server.market_tags, "skill_tags", side_effect=lambda t, n, d, o: seen.append(d) or ["docs"]), \
                mock.patch.object(skill_desc, "find", side_effect=lambda n, d: ("박스 파일 관리", "llm") if skill_desc.get_lang() == "ko" else None):
            code, d = self.req("GET", "/api/skills", headers={"Accept-Language": "ko"})
            code1, one = self.req("GET", "/api/skill?id=default/box", headers={"Accept-Language": "ko"})
            code2, en = self.req("GET", "/api/skills", headers={"Accept-Language": "en"})
        got = d["skills"][0]
        self.assertEqual((code, got["description"], got["description_src"], got["description_by"], got["tags"]), (200, "박스 파일 관리", desc, "llm", ["docs"]))
        self.assertEqual((code1, one["description"], one["tags"]), (200, "박스 파일 관리", ["docs"]))
        self.assertEqual((code2, en["skills"][0]["description"]), (200, desc))
        self.assertNotIn("description_src", en["skills"][0])
        self.assertEqual(set(seen), {desc})                                           # 태그는 원문으로 찾는다
        self.assertEqual(row["description"], desc)                                     # 저장값은 그대로

    def test_env_change_drops_the_credentials_cache(self):
        """OMAI-1175: 비밀값을 넣거나 지우면 자격증명 표 캐시(120초)의 옛 값을 버려 바로 새로 읽는다. 도구 목록 같은 다른 캐시는 남긴다.
        버린 뒤에는 열린 화면용 갱신이 곧바로 새 값을 채울 수 있으므로, 없음이 아니라 「옛 표식이 남지 않음」으로 본다."""
        key = f"{self.pod.id}:credentials"
        self.addCleanup(server._cache.clear)                                  # 표식을 다른 시험에 남기지 않는다
        def fill():
            for k in (key, key + "|en", f"{self.pod.id}:tools"):
                server._cache[k] = (time.time() + 3600, {"items": [], "old": True})
        def old(k):
            hit = server._cache.get(k)
            return bool(hit and hit[1].get("old"))
        fill()
        self.assertEqual(self.act("ma", "env_set", target="LAW_OC", value="super-secret-value-123")[0], 200)
        self.assertFalse(old(key)); self.assertFalse(old(key + "|en"))
        self.assertTrue(old(f"{self.pod.id}:tools"))                          # 비밀값은 도구 목록을 바꾸지 않는다
        fill()
        self.assertEqual(self.act("ma", "env_clear", target="LAW_OC", confirm="LAW_OC")[0], 200)
        self.assertFalse(old(key)); self.assertFalse(old(key + "|en"))
        self.assertTrue(old(f"{self.pod.id}:tools"))

    def test_model_change_drops_the_credentials_cache(self):
        """OMAI-1175: 모델을 바꾸면 Hermes 가 config.yaml 을 다시 쓰면서(providers 에 base_url 등) 표의 「대상」·수정 시각이 바뀐다. 캐시의 옛 값을 버린다."""
        key = f"{self.pod.id}:credentials"
        self.addCleanup(server._cache.clear)
        def fill():
            for k in (key, key + "|en", f"{self.pod.id}:tools"):
                server._cache[k] = (time.time() + 3600, {"items": [], "old": True})
        def old(k):
            hit = server._cache.get(k)
            return bool(hit and hit[1].get("old"))
        fill()
        self.assertEqual(self.act("ma", "model", model="m2")[0], 200)
        self.assertFalse(old(key)); self.assertFalse(old(key + "|en"))
        self.assertTrue(old(f"{self.pod.id}:tools"))

    def test_config_change_drops_the_credentials_cache(self):
        """OMAI-1175: 설정 파일(config.yaml)을 고치거나 되돌리면 자격증명 표(providers 의 api_key, mcp_servers 의 env·headers)가 바뀌므로 캐시의 옛 값을 버린다."""
        key = f"{self.pod.id}:credentials"
        self.addCleanup(server._cache.clear)                                  # 버전 기록이 다른 설정 시험(ma)과 겹치지 않게 sa 로 시험한다
        Fake.config = "model:\n  default: m1\n  provider: custom\n"
        sha = self.req("GET", "/api/profile?name=sa")[1]["config"]["sha"]
        def fill():
            for k in (key, key + "|en", f"{self.pod.id}:tools"):
                server._cache[k] = (time.time() + 3600, {"items": [], "old": True})
        def old(k):
            hit = server._cache.get(k)
            return bool(hit and hit[1].get("old"))
        fill()
        code, out = self.act("sa", "config", content="model:\n  default: m2\n  provider: custom\n", base_sha=sha)
        self.assertEqual(code, 200)
        self.assertFalse(old(key)); self.assertFalse(old(key + "|en"))
        self.assertFalse(old(f"{self.pod.id}:tools"))                         # OMAI-1249: 도구 화면의 MCP 서버 목록도 config.yaml 의 mcp_servers 를 읽으므로 tools 도 버린다
        vs = self.req("GET", "/api/profile/soul/versions?kind=config&name=sa")[1]["versions"]
        fill()
        self.assertEqual(self.act("sa", "config_revert", id=vs[-1]["id"], base_sha=out["config"]["sha"])[0], 200)
        self.assertFalse(old(key)); self.assertFalse(old(key + "|en"))
        self.assertFalse(old(f"{self.pod.id}:tools"))
        fill()
        self.assertEqual(self.act("sa", "config_preview", content="model:\n  default: m3\n  provider: custom\n")[0], 200)   # 미리 보기는 아무것도 바꾸지 않는다
        self.assertTrue(old(key))
        self.assertTrue(old(f"{self.pod.id}:tools"))

    def test_change_log_and_users(self):
        self.act("ma", "describe", description="기록 시험")
        self.act("ma", "model", model="ghost")                                    # 거절되는 요청
        self.act("ma", "env_set", target="LAW_OC", value="super-secret-value-123")
        code, d = self.req("GET", "/api/changes?days=7")
        rows = d["rows"]
        hit = next(r for r in rows if r["kind"] == "profile_describe")
        self.assertEqual((hit["group"], hit["what"], hit["who"], hit["failed"]), ("프로파일", "소개를 고침", "local", False))
        self.assertTrue(any(r["kind"] == "profile_model" and r["failed"] for r in rows))
        env = next(r for r in rows if r["kind"] == "profile_env_set")
        self.assertEqual(env["group"], "비밀값"); self.assertIn("LAW_OC", env["detail"])
        self.assertNotIn("super-secret", json.dumps(d, ensure_ascii=False))       # 값은 기록에 없다
        code, u = self.req("GET", "/api/users")
        self.assertEqual(code, 200)
        self.assertEqual([p["id"] for p in u["pods"]], ["p"])
        self.assertTrue(any(x["email"] == "t@example.com" and x["pods"] == ["p"] for x in u["users"]))
        self.assertEqual(self.req("POST", "/api/users/logout", {"email": "t@example.com"}, {"X-AAS": "1"})[1]["ended"], 0)

    def test_non_admin_cannot_change(self):
        reg = server._registry
        old = (server._auth, reg.is_admin)
        class On:
            enabled = True
            def user(self, cookie): return {"email": "t@example.com", "name": ""}
        server._auth = On(); reg.is_admin = lambda u: False
        try:
            Fake.calls.clear()
            code, d = self.act("ma", "gateway", op="stop")
            self.assertEqual((code, "관리자" in d["error"], Fake.calls), (403, True, []))
            self.assertEqual(self.req("GET", "/api/profiles")[1]["can_edit"], False)
            self.assertEqual(self.req("GET", "/api/users")[0], 403)
            self.assertNotEqual(self.req("POST", "/api/skill/create", {"name": "x-y", "profile": "ma", "description": "x"}, {"X-AAS": "1"})[0], 403)   # 주인은 권한 검사를 넘는다(스펙 2026-10-15-011 D10). 이 시험 환경에는 스킬 폴더가 없어 만들기 자체는 400
            self.assertEqual(self.req("POST", "/api/users/logout", {"email": "t@example.com"}, {"X-AAS": "1"})[0], 403)
        finally:
            server._auth, reg.is_admin = old

    def test_owner_can_save_soul_but_not_gateway_and_viewer_cannot(self):
        """주인은 SOUL 만, 보기만 받은 사람은 아무것도(OMAI-1126 리뷰 R2). 처리기가 판정 함수를 부르지 않게 바뀌면 깨진다."""
        reg = server._registry
        old = (server._auth, reg.is_admin)
        who = {"email": "t@example.com", "name": ""}                                   # 이 POD 의 주인(registry owner)
        class On:
            enabled = True
            def user(self, cookie): return dict(who)
        server._auth = On(); reg.is_admin = lambda u: False
        try:
            Fake.soul = "# 마케팅 에이전트\n"
            code, det = self.req("GET", "/api/profile?name=sa")
            self.assertEqual((code, det.get("can_edit"), det.get("owner")), (200, False, True), det)
            self.assertIs(self.req("GET", "/api/profiles")[1]["owner"], True)         # 목록 「내 전용」 뱃지가 쓴다(2026-10-17-016). R3 는 쓰는 곳이 없어 뺐었다
            code, saved = self.act("sa", "soul", content="# 주인이 고침\n", base_sha=det["soul"]["sha"], note="주인")
            self.assertEqual((code, Fake.soul, saved.get("notice")), (200, "# 주인이 고침\n", {"rooms": 0}))   # 앉은 방이 없다
            Fake.calls.clear()
            self.assertEqual((self.act("sa", "gateway", op="stop")[0], Fake.calls), (403, []))
            reg.grant("viewer@example.com", "user", [self.pod.id], "admin@example.com")   # 화면 권한으로 보기만 받은 사람
            who["email"] = "viewer@example.com"
            code, det = self.req("GET", "/api/profile?name=sa")
            self.assertEqual((code, det.get("owner")), (200, False), det)
            self.assertEqual(self.act("sa", "soul", content="# 남이 고침\n", base_sha=det["soul"]["sha"])[0], 403)
            self.assertEqual(Fake.soul, "# 주인이 고침\n")
        finally:
            server._auth, reg.is_admin = old
            reg.grant("viewer@example.com", "user", [], "admin@example.com")

    def test_owner_delete_cannot_skip_export_and_reports_the_market_package(self):
        """주인은 내보내기를 건너뛰지 못하고, 마켓 패키지로 만든 프로파일이면 그 정보를 받는다(OMAI-1126 리뷰 O4·T6, 디자인 결정 11A·12A. 마켓 기록이 없는 프로파일도 지우는 것은 스펙 2026-10-15-011 단계 2)."""
        from aas.market import marketplace as mk
        for f in mk._dir("done").glob("*.json"):
            f.unlink()
        row = {"id": "20260101000000000009-bbbbbb", "ts": "2026-01-01T00:00:00+09:00", "pod": "p", "package": "free/helper", "namespace": "free",
               "name": "helper", "version": "1.0", "kind": "agent", "profile": "sa", "mode": "install", "status": "done"}
        (mk._dir("done") / (row["id"] + ".json")).write_text(json.dumps(row))
        reg = server._registry
        old = (server._auth, reg.is_admin)
        class On:
            enabled = True
            def user(self, cookie): return {"email": "t@example.com", "name": ""}           # 이 POD 의 주인
        server._auth = On(); reg.is_admin = lambda u: False
        try:
            det = self.req("GET", "/api/profile?name=sa")[1]
            self.assertEqual((det["can_delete"], det["market_package"], det["places"]), (True, "free/helper", {"seats": 0, "rooms": 0, "channels": 0}))
            self.assertTrue(self.req("GET", "/api/profile?name=ma")[1]["can_delete"])       # 단계 2: 마켓 기록이 없어도 main 이 아니면 주인이 지운다(이 시험 파드는 주 프로파일 기록이 없다)
            Fake.calls.clear()
            code, out = self.act("sa", "delete", confirm="sa", skip_export=True)
            self.assertEqual((code, out["market_package"]), (200, "free/helper"), out)
            self.assertEqual([(c[0], c[1]) for c in Fake.calls], [("POST", "/api/profiles/sa/export"), ("DELETE", "/api/profiles/sa")])   # 건너뛰기는 무시
            self.assertEqual(mk.installed("p"), [])
        finally:
            server._auth, reg.is_admin = old
            for f in mk._dir("done").glob("*.json"):
                f.unlink()

    def test_owner_sees_only_own_pod_history_with_admin_hidden_and_viewer_gets_403(self):
        """주인은 지금 POD·주인 기간 기록만, 다른 사람 이메일은 「관리자」로(OMAI-1126 O7·L6). 보기만 받은 사람은 403."""
        from aas.common import store
        reg = server._registry
        old = (server._auth, reg.is_admin)
        who = {"email": "t@example.com", "name": ""}
        class On:
            enabled = True
            def user(self, cookie): return dict(who)
        server._auth = On(); reg.is_admin = lambda u: False
        try:
            reg.owner_since(self.pod)
            with store.connect() as conn:                      # 주인이 되기 전 기록은 보이지 않는다
                conn.execute("UPDATE pod_owners SET since='2000-01-01T00:00:00+09:00' WHERE pod=?", (self.pod.id,))
            store.log_usage("profile_soul", "t@example.com sa", pod=self.pod.id)
            store.log_usage("profile_model", "boss@example.com sa model=m2", pod=self.pod.id)
            store.log_usage("profile_soul", "t@example.com other", pod="someone-else")
            code, out = self.req("GET", "/api/changes?days=7")
            self.assertEqual((code, out["owner"], out["pod"]), (200, True, self.pod.id), out)
            mine = {r["kind"]: r for r in out["rows"]}
            self.assertEqual(mine["profile_soul"]["who"], "t@example.com")
            self.assertEqual((mine["profile_model"]["who"], mine["profile_model"]["by_admin"]), ("", True))
            self.assertNotIn("boss@example.com", json.dumps(out))
            self.assertEqual(self.req("GET", "/api/me")[1]["owner"], True)
            reg.grant("viewer@example.com", "user", [self.pod.id], "admin@example.com")
            who["email"] = "viewer@example.com"
            code, out = self.req("GET", "/api/changes?days=7")
            self.assertEqual(code, 403)
            self.assertIn("소유자가 아니어서", out["error"])
        finally:
            server._auth, reg.is_admin = old
            reg.grant("viewer@example.com", "user", [], "admin@example.com")
            with store.connect() as conn:
                conn.execute("DELETE FROM usage WHERE pod IN (?, 'someone-else')", (self.pod.id,))
                conn.execute("DELETE FROM pod_owners WHERE pod=?", (self.pod.id,))

    def test_name_rule(self):
        self.assertTrue(all(profiles.NAME.match(n) for n in ("ma", "aas-test", "m3", "a_b")))
        self.assertFalse(any(profiles.NAME.match(n) for n in ("", "Ma", "-x", "a/b", "a b", "../x", "x" * 60)))


if __name__ == "__main__":
    unittest.main()

# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""내 스킬 지우기(스펙 2026-10-29-005) — 가짜 Hermes 가 지우기 요청을 받으면 실제 폴더를 skills/.archive 로 옮긴다.
스킬 목록은 진짜 폴더에서 다시 만든다(skill_graph). 출처·같은 이름·이름 규칙·권한·실패 재확인·버전 기록 정리를 본다."""
import aasserver  # 실제 uvicorn 앱을 띄우는 시험 하네스(OMAI-1100)
import http.client
import json
import os
import shutil
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest import mock
from urllib.parse import parse_qs, urlsplit

TMP = tempfile.TemporaryDirectory()
os.environ.setdefault("AAS_DATA_DIR", str(Path(TMP.name) / "data"))

from aas.auth import auth  # noqa: E402
from aas.fleet import pods  # noqa: E402
from aas.hermes.hermes_chat import ChatHub  # noqa: E402
from aas.web import mcp_server, server  # noqa: E402

HOME = Path(TMP.name) / "home"


class Fake(BaseHTTPRequestHandler):
    calls: list = []
    mode = "archive"          # archive: 폴더를 옮기고 ok / pinned: 400 pinned / late: 옮긴 뒤 500(시간 초과처럼 결과를 모름)

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
        if method != "GET":
            Fake.calls.append((method, u.path, {k: v[0] for k, v in parse_qs(u.query).items()}, body))
        if u.path == "/api/learning/node" and method == "DELETE":
            if Fake.mode == "pinned":
                return self._send(400, {"detail": f"'{body['id']}' is pinned — unpin it first (hermes curator unpin {body['id']})"})
            root = HOME / "profiles" / body["profile"] if body.get("profile") else HOME
            hit = next((p.parent for p in (root / "skills").rglob("SKILL.md") if ".archive" not in p.parts and f"name: {body['id']}\n" in p.read_text()), None)
            if hit is None:
                return self._send(400, {"detail": f"skill '{body['id']}' not found"})
            (root / "skills" / ".archive").mkdir(parents=True, exist_ok=True)
            shutil.move(str(hit), str(root / "skills" / ".archive" / body["id"]))
            return self._send(500, {"detail": "boom"}) if Fake.mode == "late" else self._send(200, {"ok": True, "message": "archived"})
        return self._send(200, {"ok": True})

    def do_GET(self): self._handle("GET")
    def do_POST(self): self._handle("POST")
    def do_DELETE(self): self._handle("DELETE")
    def log_message(self, *a): pass


def put(rel: str, name: str) -> None:
    d = HOME / rel
    d.mkdir(parents=True, exist_ok=True)
    (d / "SKILL.md").write_text(f"---\nname: {name}\ndescription: 시험\n---\n# {name}\n", encoding="utf-8")


class SkillDeleteTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        root = Path(TMP.name)
        cls.fake = ThreadingHTTPServer(("127.0.0.1", 0), Fake)
        threading.Thread(target=cls.fake.serve_forever, daemon=True).start()
        (HOME / "profiles" / "ma").mkdir(parents=True)
        reg = root / "del-pods.json"
        reg.write_text(json.dumps({"pods": [{"id": "p", "owner": "t@example.com", "hermes_home": str(HOME),
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
        shutil.rmtree(HOME / "profiles" / "ma" / "skills", ignore_errors=True)
        shutil.rmtree(HOME / "skills", ignore_errors=True)
        Fake.calls.clear(); Fake.mode = "archive"
        server._cache.clear()
        self.old_rebuild, self.old_reload = server._rebuild_flow, server._reload_skill_commands
        server._rebuild_flow = lambda pod: None
        server._reload_skill_commands = lambda pod, profile: "ok"

    def tearDown(self):
        server._rebuild_flow, server._reload_skill_commands = self.old_rebuild, self.old_reload

    def req(self, method, path, body=None):
        c = http.client.HTTPConnection("127.0.0.1", self.app.server_port, timeout=10)
        c.request(method, path, body=json.dumps(body) if body is not None else None, headers={"Content-Type": "application/json", "X-AAS": "1"})
        r = c.getresponse(); data = json.loads(r.read() or b"{}"); c.close()
        return r.status, data

    def rows(self):
        return {r["id"]: r for r in self.req("GET", "/api/skills")[1]["skills"]}

    def delete(self, sid):
        return self.req("POST", "/api/skill/delete", {"id": sid})

    def test_my_skill_goes_to_the_archive_and_versions_are_forgotten(self):
        put("profiles/ma/skills/uploaded/weekly-report", "weekly-report")
        sid = "ma:profiles/ma/skills/uploaded/weekly-report"
        self.assertEqual(self.rows()[sid]["delete_block"], "")
        with mock.patch.object(server.files, "forget_key") as forget:
            code, out = self.delete(sid)
        self.assertEqual((code, out["name"], out["profile"]), (200, "weekly-report", "ma"))
        sent = [c for c in Fake.calls if c[1] == "/api/learning/node"][-1]
        self.assertEqual((sent[0], sent[3], sent[2]), ("DELETE", {"id": "weekly-report", "profile": "ma"}, {"profile": "ma"}))
        forget.assert_called_once_with("p", "profiles/ma/skills/uploaded/weekly-report/SKILL.md")   # 같은 경로로 다시 올리면 옛 버전과 비교되지 않게(R2)
        self.assertTrue((HOME / "profiles/ma/skills/.archive/weekly-report/SKILL.md").is_file())
        self.assertNotIn(sid, self.rows())                                                          # 목록 캐시도 비웠다

    def test_other_origins_same_name_and_bad_names_are_refused_before_hermes(self):
        put("profiles/ma/skills/market/hub-one", "hub-one")                    # 스킬 허브 스킬(출처 market)
        put("profiles/ma/skills/uploaded/twin", "twin")
        put("profiles/ma/skills/ops/twin", "twin")                             # 같은 머리말 이름이 둘(R1)
        put("profiles/ma/skills/uploaded/odd", "memory:memory:0")              # Hermes 가 메모리로 읽는 이름(R10)
        rows = self.rows()
        by = {r["name"]: r for r in rows.values()}
        self.assertEqual((by["hub-one"]["delete_block"], by["twin"]["delete_block"], by["memory:memory:0"]["delete_block"]), ("origin", "same_name", "name"))
        for sid, code in (("ma:profiles/ma/skills/market/hub-one", 403), ("ma:profiles/ma/skills/uploaded/twin", 409),
                          ("ma:profiles/ma/skills/uploaded/odd", 400), ("ma:profiles/ma/skills/nope", 404)):
            got, out = self.delete(sid)
            self.assertEqual(got, code, sid)
        self.assertEqual([c for c in Fake.calls if c[1] == "/api/learning/node"], [])            # 하나도 Hermes 에 보내지 않았다

    def test_permission_is_checked_with_the_profile_of_the_found_skill(self):
        put("skills/shared-one", "shared-one")                                 # 루트(default)의 공용 스킬
        with mock.patch.object(server, "content_gate", return_value="거절") as gate:
            code, out = self.delete("default:skills/shared-one")
        self.assertEqual((code, out["error"]), (403, "거절"))
        self.assertEqual(gate.call_args[0][-1], "default")                     # 본문이 아니라 서버가 찾은 항목의 프로파일로 본다(R8)
        self.assertEqual([c for c in Fake.calls if c[1] == "/api/learning/node"], [])

    def test_root_skill_is_sent_without_a_profile(self):
        put("skills/shared-two", "shared-two")
        self.assertEqual(self.delete("default:skills/shared-two")[0], 200)
        sent = [c for c in Fake.calls if c[1] == "/api/learning/node"][-1]
        self.assertEqual((sent[3], sent[2]), ({"id": "shared-two", "profile": None}, {}))

    def test_failure_rereads_the_list_pinned_is_409_and_late_archive_is_success(self):
        put("profiles/ma/skills/uploaded/pinned-one", "pinned-one")
        Fake.mode = "pinned"
        code, out = self.delete("ma:profiles/ma/skills/uploaded/pinned-one")
        self.assertEqual((code, out["reason"]), (409, "pinned"))
        self.assertIn("고정", out["error"])
        self.assertIn("pinned", out["detail"])                                 # Hermes 원문은 「자세히」로(DD5)
        put("profiles/ma/skills/uploaded/late-one", "late-one")
        server._cache.clear()
        Fake.mode = "late"                                                     # 보관은 됐는데 응답이 실패 — 목록에 없으니 성공(R11)
        self.assertEqual(self.delete("ma:profiles/ma/skills/uploaded/late-one")[0], 200)
        Fake.mode = "archive"                                                  # 두 번 누르기: 이미 없는 스킬은 404(목록에 없음)
        self.assertEqual(self.delete("ma:profiles/ma/skills/uploaded/late-one")[0], 404)

    def test_change_log_kind_and_mcp_tool_scope(self):
        from aas.ops import changes
        self.assertIn("skill_delete", changes.LABELS)
        tool = mcp_server.TOOLS["skill_delete"]
        self.assertEqual(tool["scope"], "profile:write")                      # 「스킬 개발」 묶음(skills:write)은 지우기를 얻지 않는다(R5)


if __name__ == "__main__":
    unittest.main()

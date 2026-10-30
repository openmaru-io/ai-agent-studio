# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""프로파일 작업 지침(AGENTS.md) 편집 시험(스펙 2026-10-19-004 §4-5·§10-3). 가짜 Hermes 대시보드(프로파일 목록·표지·범용 파일 API)를 띄워
경로·읽기 세 갈래·링크·표지·크기 경고·판 기록·에이전트 변경·확인함·복제·이름 바꾸기를 본다. 끝에 자기 판·확인·사용 기록을 지운다."""
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
from urllib.parse import parse_qs, urlsplit

TMP = tempfile.TemporaryDirectory()
os.environ.setdefault("AAS_DATA_DIR", str(Path(TMP.name) / "data"))

from aas.assets import files  # noqa: E402
from aas.auth import auth  # noqa: E402
from aas.common import dbmigrate, store  # noqa: E402
from aas.fleet import pods  # noqa: E402
from aas.hermes.hermes_chat import ChatHub  # noqa: E402
from aas.web import server  # noqa: E402

ROOT = "/opt/data"
POD = "agents-md-pod"
NOTION = "https://www.notion.so/team/abcdefghijklmnopqrstuvwxyz0123456789"   # 「주소 속 긴 조각」 규칙에 걸리는 주소
TOKEN = "api_key = 'abcdefghijklmnopqrstuvwx'"                               # 토큰 규칙에 걸리는 줄


def path_of(name):
    return ROOT if name == "default" else f"{ROOT}/profiles/{name}"


class Fake(BaseHTTPRequestHandler):
    """Hermes 대시보드 대역: 프로파일 목록(path)·표지·SOUL·설정·/api/fs/read-text·/api/fs/write-text."""

    def _send(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code); self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body))); self.end_headers(); self.wfile.write(body)

    def _handle(self, method):
        u = urlsplit(self.path)
        q = {k: v[0] for k, v in parse_qs(u.query).items()}
        body = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)) or b"{}")
        S = Fake.state
        if u.path == "/auth/password-login":
            return self._send(200, {})
        if u.path == "/api/profiles" and method == "GET":
            return self._send(200, {"profiles": [{"name": n, "is_default": n == "default", "path": S["paths"].get(n, path_of(n)), "model": "m1",
                                                  "provider": "custom", "has_env": True, "skill_count": 0} for n in S["profiles"]]})
        if u.path == "/api/profiles" and method == "POST":
            S["profiles"].append(body["name"])
            return self._send(200, {"ok": True})
        parts = u.path.split("/")
        if u.path.startswith("/api/profiles/") and len(parts) == 4 and method == "PATCH":
            old, new = parts[3], body["new_name"]
            S["profiles"][S["profiles"].index(old)] = new
            if f"{path_of(old)}/AGENTS.md" in S["files"]:
                S["files"][f"{path_of(new)}/AGENTS.md"] = S["files"].pop(f"{path_of(old)}/AGENTS.md")
            return self._send(200, {"ok": True})
        if u.path.startswith("/api/profiles/") and len(parts) == 4 and method == "DELETE":
            S["profiles"].remove(parts[3])
            return self._send(200, {"ok": True})
        if u.path.endswith("/instructions"):
            code, obj = S["marker"].get(parts[3], (200, {"profile_instructions": True, "context_file_max_chars": 100}))
            return self._send(code, obj)
        if u.path.endswith("/soul"):
            if method == "PUT":
                S["soul"] = body["content"]
            return self._send(200, {"content": S["soul"]})
        if u.path == "/api/config/raw":
            if method == "PUT":
                S["config"] = body["yaml_text"]
            return self._send(200, {"yaml": S["config"]})
        if u.path == "/api/fs/read-text":
            S["reads"].append(q)
            p = q["path"]
            if p in S["read_fail"]:
                return self._send(500, {"detail": "boom"})
            target = S["links"].get(p, p)
            if target not in S["files"]:
                return self._send(404, {"detail": "File not found"})
            return self._send(200, {"path": target, "text": S["files"][target], "truncated": p in S["truncated"], "binary": p in S["binary"],
                                    "byteSize": len(S["files"][target].encode())})
        if u.path == "/api/fs/write-text":
            p = body["path"]
            target = S["links"].get(p, p)
            S["files"][target] = body["content"]
            S["writes"].append((p, body["content"], q))
            return self._send(200, {"ok": True, "path": S["write_redirect"].get(p, target)})
        if u.path in ("/api/tools/toolsets", "/api/skills"):
            return self._send(200, [])
        if u.path == "/api/mcp/servers":
            return self._send(200, {"servers": []})
        if u.path == "/api/env":
            return self._send(200, {})
        return self._send(200, {"ok": True})

    def do_GET(self): self._handle("GET")
    def do_POST(self): self._handle("POST")
    def do_PUT(self): self._handle("PUT")
    def do_PATCH(self): self._handle("PATCH")
    def do_DELETE(self): self._handle("DELETE")
    def log_message(self, *a): pass


def fresh_state():
    return {"profiles": ["default", "main", "ma"], "paths": {}, "files": {}, "links": {}, "write_redirect": {}, "truncated": set(), "binary": set(),
            "read_fail": set(), "marker": {}, "writes": [], "reads": [], "soul": "# 성격\n", "config": "model:\n  default: m1\n"}


class AgentsMdTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        root = Path(TMP.name)
        cls.fake = ThreadingHTTPServer(("127.0.0.1", 0), Fake)
        threading.Thread(target=cls.fake.serve_forever, daemon=True).start()
        home = root / "agents-home"; (home / "profiles").mkdir(parents=True, exist_ok=True)
        reg = root / "agents-pods.json"
        reg.write_text(json.dumps({"pods": [{"id": POD, "owner": "t@example.com", "hermes_home": str(home),
                                              "dashboard_url": f"http://127.0.0.1:{cls.fake.server_port}"}]}))
        cls.saved = (server._auth, server._registry)
        server._auth = auth.Auth({"issuer": "https://accounts.google.com", "client_id": "", "client_secret": "", "domain": "",
                                  "public_url": "http://localhost:17900", "hours": 1, "users_file": root / "none.json"})
        server._registry = pods.Registry(reg)
        cls.pod = server._registry.pods[0]
        server._hubs[cls.pod.id] = ChatHub({"url": cls.pod.dashboard_url, "provider": "basic", "user": "u", "password": "p"})
        cls.app = aasserver.start()

    @classmethod
    def tearDownClass(cls):
        cls.app.shutdown(); cls.fake.shutdown()
        server._auth, server._registry = cls.saved
        server._hubs.pop(cls.pod.id, None)
        for k in [k for k in server._cache if k.startswith(POD + ":")]:
            server._cache.pop(k, None)

    def setUp(self):
        Fake.state = fresh_state()
        self.seed()
        self.old_forget, self.old_rebuild = server._forget, server._rebuild_flow
        server._forget = lambda pod, keep=("flow",), notify=True: (self.old_forget(pod, keep, notify), self.seed())
        server._rebuild_flow = lambda pod: None
        self.addCleanup(self.cleanup)

    def cleanup(self):
        server._forget, server._rebuild_flow = self.old_forget, self.old_rebuild
        for name in ("default", "main", "ma", "ma2", "fresh", "sa"):            # 이 시험이 남긴 판·확인·사용 기록(AAS_DATA_DIR 공유)
            files.forget_key(POD, f"agents:{name}")
            files.forget_key(POD, f"soul:{name}")
        with store.connect() as conn:
            conn.execute("DELETE FROM usage WHERE pod=?", (POD,))

    def seed(self):
        now = time.time() + 3600
        names = Fake.state["profiles"] if hasattr(Fake, "state") else ["default", "main", "ma"]
        server._cache.update({
            f"{POD}:agents": (now, []),
            f"{POD}:channels": (now, {"profiles": [{"name": n, "running": False, "platforms": [], "issues": []} for n in names]}),
            f"{POD}:models": (now, {"profiles": [], "models": [{"id": "m1", "in_litellm": True, "aas_model": True}]}),
            f"{POD}:health": (now, {"profiles": []}),
            f"{POD}:credentials": (now, {"items": []}),
            f"{POD}:activity7": (now, {"profiles": []})})
        server._cache.pop(f"{POD}:profiles", None)

    # ---- 도우미 ----
    def req(self, method, path, body=None, headers=None):
        c = http.client.HTTPConnection("127.0.0.1", self.app.server_port, timeout=10)
        c.request(method, path, body=json.dumps(body) if body is not None else None, headers={"Content-Type": "application/json", **(headers or {})})
        r = c.getresponse(); data = json.loads(r.read() or b"{}"); c.close()
        return r.status, data

    def act(self, name, action, **extra):
        return self.req("POST", f"/api/profile/action?pod={POD}", {"name": name, "action": action, **extra}, {"X-AAS": "1"})

    def detail(self, name="ma"):
        code, d = self.req("GET", f"/api/profile?pod={POD}&name={name}")
        self.assertEqual(code, 200, d)
        return d

    def put_file(self, name, text):
        Fake.state["files"][f"{path_of(name)}/AGENTS.md"] = text

    def file(self, name="ma"):
        return Fake.state["files"].get(f"{path_of(name)}/AGENTS.md")

    def usage(self):
        """이 에이전트의 사용 기록 종류(정렬). usage 에는 순서 열이 없어 쓴 순서를 PostgreSQL 에서 가릴 수 없다."""
        with store.connect() as conn:
            return sorted(r["kind"] for r in conn.execute("SELECT kind FROM usage WHERE pod=?", (POD,)).fetchall())

    def as_user(self, email, admin=False):
        reg = server._registry
        old = (server._auth, reg.is_admin)

        class On:
            enabled = True
            def user(self, cookie): return {"email": email, "name": ""}
        server._auth = On(); reg.is_admin = lambda u: admin
        self.addCleanup(lambda: (setattr(server, "_auth", old[0]), setattr(reg, "is_admin", old[1])))

    # ---- 읽기·경로 ----
    def test_detail_shape_path_limit_chars_and_size_warning(self):
        self.put_file("ma", "  " + "가" * 120 + "\n\n")
        a = self.detail()["agents"]
        self.assertEqual((a["exists"], a["path"], a["limit"], a["chars"], a["readonly_reason"]), (True, "profiles/ma/AGENTS.md", 100, 120, None))
        self.assertEqual(len(a["warnings"]), 1); self.assertIn("120", a["warnings"][0])
        self.assertEqual((a["versions"], a["agent_change"], a["never_saved"]), (1, None, True))       # 처음 본 판만. 사람 판이 없어 출처 모름(D8)
        self.assertEqual(a["sha"], files.text_sha("  " + "가" * 120 + "\n\n"))
        self.assertEqual(self.detail()["caps"]["agents"], {"can": True, "reason": ""})
        self.assertTrue(all("profile" not in r for r in Fake.state["reads"]))                         # fs API 에 profile 인자를 넘기지 않는다(O12)
        self.assertEqual(self.detail("default")["agents"]["path"], "AGENTS.md")                       # 기본 프로파일은 데이터 폴더 바로 아래

    def test_missing_file_is_empty_and_first_save_creates_it_without_an_empty_version(self):
        a = self.detail()["agents"]
        self.assertEqual((a["exists"], a["lines"], a["sha"], a["versions"], a["never_saved"]), (False, [], files.text_sha(""), 0, False))
        self.assertEqual(self.act("ma", "agents", content="# 지침\n", base_sha="stale")[0], 409)
        code, out = self.act("ma", "agents", content="# 지침\n", base_sha=a["sha"], note="처음", path="/etc/passwd")   # 요청 경로는 무시한다(R2)
        self.assertEqual((code, out["agents"]["lines"], out["agents"]["versions"]), (200, ["# 지침"], 1), out)
        self.assertEqual([(p, c) for p, c, _ in Fake.state["writes"]], [(f"{ROOT}/profiles/ma/AGENTS.md", "# 지침\n")])
        self.assertEqual(Fake.state["writes"][0][2], {})                                             # profile 인자 없음(O12)
        vs = self.req("GET", f"/api/profile/soul/versions?pod={POD}&kind=agents&name=ma")[1]["versions"]
        self.assertEqual([(v["by"], v["note"]) for v in vs], [("local", "처음")])
        self.assertEqual(self.detail()["agents"]["never_saved"], False)

    def test_profile_path_outside_the_default_profile_folder_is_refused(self):
        Fake.state["paths"]["ma"] = "/etc"
        code, out = self.act("ma", "agents", content="x\n", base_sha=files.text_sha(""))
        self.assertEqual((code, out.get("reason")), (403, "path_outside"), out)
        Fake.state["paths"]["ma"] = f"{ROOT}/profiles/../../etc"
        self.assertEqual(self.act("ma", "agents", content="x\n", base_sha=files.text_sha(""))[0], 403)
        self.assertEqual(Fake.state["writes"], [])
        a = self.detail()
        self.assertEqual(a["agents"]["readonly_reason"], "read_error")
        self.assertFalse(any(n.startswith("agents:") for n in a["notes"]))                            # 고정된 이유는 notes 에 넣지 않는다(M4)

    def test_read_error_locks_editing_and_goes_to_notes(self):
        self.put_file("ma", "# 지침\n")
        Fake.state["read_fail"].add(f"{ROOT}/profiles/ma/AGENTS.md")
        d = self.detail()
        self.assertEqual((d["agents"]["readonly_reason"], d["agents"]["lines"]), ("read_error", []))
        self.assertTrue(any(n.startswith("agents:") for n in d["notes"]), d["notes"])                # D15: 서랍 위 notes 에도
        code, out = self.act("ma", "agents", content="새 내용\n", base_sha=files.text_sha(""))
        self.assertEqual(code, 502, out)                                                              # 빈 글로 보고 덮어쓰지 않는다(R3)
        self.assertEqual((Fake.state["writes"], self.file()), ([], "# 지침\n"))

    def test_truncated_and_binary_are_read_only_and_the_server_refuses_saving(self):
        self.put_file("ma", "# 앞부분\n")
        for flag in ("truncated", "binary"):
            Fake.state["truncated"].clear(); Fake.state["binary"].clear()
            Fake.state[flag].add(f"{ROOT}/profiles/ma/AGENTS.md")
            d = self.detail()
            self.assertEqual(d["agents"]["readonly_reason"], "truncated", flag)
            self.assertFalse(any(n.startswith("agents:") for n in d["notes"]))                        # 너무 큼은 notes 에 넣지 않는다(M4)
            code, out = self.act("ma", "agents", content="새 내용\n", base_sha=d["agents"]["sha"])
            self.assertEqual((code, out.get("reason")), (409, "truncated"), flag)
        self.assertEqual(Fake.state["writes"], [])
        self.assertEqual(files.versions(POD, "agents:ma"), [])                                        # 잘린 읽기로는 판을 남기지 않는다(H2)

    def test_symlink_is_read_only_and_the_write_path_is_checked_again(self):
        Fake.state["files"]["/opt/data/.env"] = "SECRET=1\n"
        Fake.state["links"][f"{ROOT}/profiles/ma/AGENTS.md"] = "/opt/data/.env"
        d = self.detail()
        self.assertEqual(d["agents"]["readonly_reason"], "link")
        self.assertFalse(any(n.startswith("agents:") for n in d["notes"]))
        code, out = self.act("ma", "agents", content="덮어쓰기\n", base_sha=d["agents"]["sha"])
        self.assertEqual((code, out.get("reason")), (409, "link"))
        self.assertEqual((Fake.state["writes"], Fake.state["files"]["/opt/data/.env"]), ([], "SECRET=1\n"))
        Fake.state["links"].clear()
        Fake.state["write_redirect"][f"{ROOT}/profiles/ma/AGENTS.md"] = "/somewhere/else"              # 읽은 뒤 링크로 바뀐 경우: 쓰기 응답 경로도 본다(O4)
        code, out = self.act("ma", "agents", content="새 내용\n", base_sha=files.text_sha(""))
        self.assertEqual((code, out.get("reason")), (502, "link"), out)

    def test_marker_missing_is_unsupported_and_marker_failure_is_a_read_error(self):
        self.put_file("ma", "# 지침\n")
        for marker in [(404, {"detail": "Not Found"}), (200, {"profile_instructions": False}), (200, {})]:
            Fake.state["marker"]["ma"] = marker
            d = self.detail()
            self.assertEqual((d["agents"]["readonly_reason"], d["agents"]["lines"], d["agents"]["limit"]), ("unsupported", ["# 지침"], 20000), marker)
            self.assertFalse(any(n.startswith("agents:") for n in d["notes"]))
            code, out = self.act("ma", "agents", content="새 내용\n", base_sha=d["agents"]["sha"])
            self.assertEqual((code, out.get("reason")), (409, "unsupported"))
        self.assertEqual((Fake.state["writes"], files.versions(POD, "agents:ma")), ([], []))         # 기능 꺼짐에서는 판을 남기지 않는다(H2)
        Fake.state["marker"]["ma"] = (500, {"detail": "down"})
        d = self.detail()
        self.assertEqual(d["agents"]["readonly_reason"], "read_error")                                # 표지 응답 실패 ≠ 기능 꺼짐(M5)
        self.assertTrue(any(n.startswith("agents:") for n in d["notes"]))
        Fake.state["marker"]["ma"] = (404, {})
        Fake.state["read_fail"].add(f"{ROOT}/profiles/ma/AGENTS.md")
        self.assertEqual(self.detail()["agents"]["readonly_reason"], "unsupported")                   # 우선순위: 기능 꺼짐 > 읽기 오류

    def test_size_warning_is_separate_from_problem_and_does_not_block_saving(self):
        big = "나" * 150 + "\n"
        code, pv = self.act("ma", "agents_preview", content=big)
        self.assertEqual((code, pv["problem"], len(pv["warnings"]), pv["added"]), (200, "", 1, 1))
        self.assertEqual(self.act("ma", "agents_preview", content="짧다\n")[1]["warnings"], [])
        self.assertIn("가림", self.act("ma", "agents_preview", content="x «가림» y")[1]["problem"])
        code, out = self.act("ma", "agents", content=big, base_sha=files.text_sha(""))
        self.assertEqual(code, 200, out)
        self.assertEqual(self.detail()["agents"]["chars"], 150)

    def test_versions_diff_revert_and_text_api_accept_agents(self):
        self.put_file("ma", "하나\n")
        sha = self.detail()["agents"]["sha"]
        code, out = self.act("ma", "agents", content="하나\n둘\n", base_sha=sha)
        self.assertEqual(code, 200, out)
        vs = self.req("GET", f"/api/profile/soul/versions?pod={POD}&kind=agents&name=ma")[1]["versions"]
        self.assertEqual([v["by"] for v in vs], ["local", ""])                                        # 저장, 처음 본 판(고치기 전 판은 내용이 같아 남지 않는다)
        d = self.req("GET", f"/api/profile/soul/diff?pod={POD}&kind=agents&name=ma&id={vs[-1]['id']}")[1]
        self.assertEqual((d["added"], d["removed"]), (1, 0))
        self.assertEqual(self.req("GET", f"/api/text/versions?pod={POD}&key=agents:ma")[0], 200)
        self.assertEqual(self.req("GET", f"/api/text/version?pod={POD}&key=agents:ma&id={vs[0]['id']}")[1]["lines"], ["하나", "둘"])
        code, out = self.act("ma", "agents_revert", id=vs[-1]["id"], base_sha=out["agents"]["sha"])
        self.assertEqual((code, self.file()), (200, "하나\n"), out)
        self.assertEqual(files.versions(POD, "agents:ma")[0]["note"], f"버전 {vs[-1]['id']} 으로 되돌림")
        self.assertEqual(self.usage(), ["profile_agents", "profile_agents_revert"])                  # 미리 보기는 기록하지 않는다
        self.act("ma", "agents_preview", content="x")
        self.assertEqual(self.usage(), ["profile_agents", "profile_agents_revert"])

    # ---- 가림(O7·H4) ----
    def test_long_url_ids_do_not_lock_agents_but_tokens_still_do(self):
        self.put_file("ma", f"참고: {NOTION}\n")
        a = self.detail()["agents"]
        self.assertEqual((a["readonly_reason"], a["masked_lines"], a["lines"][0]), (None, [], f"참고: {NOTION}"))
        code, out = self.act("ma", "agents", content=f"참고: {NOTION}\n더함\n", base_sha=a["sha"])
        self.assertEqual(code, 200, out)
        vs = files.versions(POD, "agents:ma")
        self.assertFalse(any(v["withheld"] for v in vs))                                              # 판 기록에도 내용이 남는다
        d = self.req("GET", f"/api/profile/soul/diff?pod={POD}&kind=agents&name=ma&id={vs[-1]['id']}")[1]
        self.assertNotIn("«가림»", json.dumps(d, ensure_ascii=False))
        self.put_file("ma", f"{TOKEN}\n")
        a = self.detail()["agents"]
        self.assertEqual((a["readonly_reason"], a["masked_lines"]), ("masked", [1]))
        self.assertNotIn("abcdefghijklmnopqrstuvwx", json.dumps(a))
        self.assertEqual(self.act("ma", "agents", content="바꿈\n", base_sha=a["sha"])[0], 403)
        self.assertEqual(files.mask_line(NOTION), "https://www.notion.so/team/«가림»")               # SOUL·설정·스킬은 그대로 가린다

    def test_secret_agent_version_is_withheld_and_cannot_be_compared_or_restored(self):
        self.put_file("ma", "하나\n")
        sha = self.detail()["agents"]["sha"]
        self.assertEqual(self.act("ma", "agents", content="둘\n", base_sha=sha)[0], 200)
        self.put_file("ma", f"{TOKEN}\n")                                                             # 에이전트가 비밀값을 적었다
        a = self.detail()["agents"]
        vs = files.versions(POD, "agents:ma")
        self.assertTrue(vs[0]["withheld"]); self.assertEqual(files.version_content(POD, "agents:ma", vs[0]["id"]), "")
        self.assertEqual((a["agent_change"]["compare_id"], a["agent_change"]["revert_id"]), (vs[1]["id"], vs[1]["id"]))
        self.assertEqual(self.req("GET", f"/api/profile/soul/diff?pod={POD}&kind=agents&name=ma&id={vs[0]['id']}")[0], 422)
        self.assertEqual(self.req("GET", f"/api/text/version?pod={POD}&key=agents:ma&id={vs[0]['id']}")[0], 422)

    # ---- 에이전트 변경·확인함(O3·D7·D8·D17·D20·H3) ----
    def test_agent_edit_is_recorded_once_shown_and_acknowledged_without_touching_the_file(self):
        self.put_file("ma", "사람 판\n")
        sha = self.detail()["agents"]["sha"]
        code, out = self.act("ma", "agents", content="사람이 고침\n", base_sha=sha)
        human = files.versions(POD, "agents:ma")[0]["id"]
        self.put_file("ma", "에이전트가 고침\n")
        a = self.detail()["agents"]
        ch = a["agent_change"]
        self.assertEqual((ch["deleted"], ch["compare_id"], ch["revert_id"], a["never_saved"]), (False, human, human, False))
        self.assertTrue(ch["at"])
        n = a["versions"]
        self.assertEqual(self.detail()["agents"]["versions"], n)                                      # 같으면 다시 남기지 않는다
        self.assertEqual(self.act("ma", "agents_ack", version_id=human)[0], 409)                      # 마지막 hermes 판이 아니다
        Fake.state["writes"].clear()
        code, out = self.act("ma", "agents_ack", version_id=ch["id"])
        self.assertEqual((code, out), (200, {"ok": True}))
        self.assertEqual((Fake.state["writes"], self.file()), ([], "에이전트가 고침\n"))              # 파일은 그대로
        self.assertIsNone(self.detail()["agents"]["agent_change"])
        self.assertEqual(self.act("ma", "agents_ack", version_id=ch["id"])[0], 200)                   # 두 번 눌러도 된다
        self.assertIn("profile_agents_ack", self.usage())
        code, out = self.act("ma", "agents_revert", id=ch["revert_id"], base_sha=a["sha"])            # 이전 판으로 되돌리기
        self.assertEqual((code, self.file()), (200, "사람이 고침\n"), out)

    def test_without_a_human_version_compare_uses_the_first_seen_version_and_revert_is_off(self):
        self.put_file("ma", "처음\n")
        self.detail()
        first = files.versions(POD, "agents:ma")[0]["id"]
        self.put_file("ma", "에이전트\n")
        a = self.detail()["agents"]
        self.assertEqual((a["agent_change"]["compare_id"], a["agent_change"]["revert_id"], a["never_saved"]), (first, None, True))

    def test_deleted_file_leaves_a_deleted_version_and_revert_recreates_it(self):
        self.assertEqual(self.detail()["agents"]["versions"], 0)                                     # 판이 없고 404 면 아무것도 남기지 않는다(H2)
        self.assertEqual(self.act("ma", "agents", content="지침\n", base_sha=files.text_sha(""))[0], 200)
        del Fake.state["files"][f"{ROOT}/profiles/ma/AGENTS.md"]
        a = self.detail()["agents"]
        self.assertEqual((a["exists"], a["agent_change"]["deleted"]), (False, True))
        self.assertEqual(self.detail()["agents"]["versions"], a["versions"])                          # 지움 판은 한 번만
        self.assertTrue(files.versions(POD, "agents:ma")[0]["deleted"])
        code, out = self.act("ma", "agents_revert", id=a["agent_change"]["id"], base_sha=a["sha"])   # 지움 판으로 되돌리기 = 지움 직전 사람 판으로 다시 만들기
        self.assertEqual((code, self.file()), (200, "지침\n"), out)
        self.put_file("ma", "지침\n")
        self.assertIsNone(self.detail()["agents"]["agent_change"])

    def test_dirty_reads_never_record_agent_versions(self):
        self.put_file("ma", "처음\n")
        self.detail()
        n = len(files.versions(POD, "agents:ma"))
        self.put_file("ma", "에이전트가 고침\n")
        p = f"{ROOT}/profiles/ma/AGENTS.md"
        for setup, undo in [(lambda: Fake.state["read_fail"].add(p), lambda: Fake.state["read_fail"].clear()),
                            (lambda: Fake.state["truncated"].add(p), lambda: Fake.state["truncated"].clear()),
                            (lambda: Fake.state["links"].update({p: "/opt/data/x.md"}) or Fake.state["files"].update({"/opt/data/x.md": "다른 파일\n"}),
                             lambda: Fake.state["links"].clear()),
                            (lambda: Fake.state["marker"].update({"ma": (404, {})}), lambda: Fake.state["marker"].clear())]:
            setup()
            self.detail()
            undo()
            self.assertEqual(len(files.versions(POD, "agents:ma")), n)

    # ---- 권한(D2·H3) ----
    def test_owner_edits_viewer_is_view_only_and_hidden_root_is_read_only(self):
        self.put_file("ma", "# 지침\n")
        self.as_user("t@example.com")                                                                  # 이 파드의 주인
        a = self.detail()
        self.assertEqual((a["caps"]["agents"]["can"], a["agents"]["readonly_reason"]), (True, None))
        self.assertEqual(self.act("ma", "agents", content="# 주인\n", base_sha=a["agents"]["sha"])[0], 200)
        self.put_file("ma", "# 에이전트\n")
        vid = self.detail()["agents"]["agent_change"]["id"]
        server._registry.grant("viewer@example.com", "user", [POD], "admin@example.com")
        self.addCleanup(lambda: server._registry.grant("viewer@example.com", "user", [], "admin@example.com"))
        self.as_user("viewer@example.com")
        a = self.detail()
        self.assertEqual((a["caps"]["agents"], a["agents"]["readonly_reason"]), ({"can": False, "reason": "not_owner"}, "view_only"))
        for action, extra in [("agents", {"content": "x\n", "base_sha": a["agents"]["sha"]}), ("agents_ack", {"version_id": vid}),
                              ("agents_revert", {"id": vid, "base_sha": a["agents"]["sha"]}), ("agents_preview", {"content": "x"})]:
            self.assertEqual(self.act("ma", action, **extra)[0], 403, action)
        self.assertEqual(self.file(), "# 에이전트\n")

    def test_hidden_root_is_read_only(self):
        from aas.fleet import primary
        orig = primary.hide_root
        primary.hide_root = lambda pod_id, admin: "readonly"
        self.addCleanup(lambda: setattr(primary, "hide_root", orig))
        self.put_file("default", "# 루트\n")
        a = self.detail("default")
        self.assertEqual((a["caps"]["agents"]["reason"], a["agents"]["readonly_reason"]), ("hidden_root", "hidden_root"))

    # ---- 복제·이름 바꾸기·삭제(R7·M1) ----
    def test_clone_without_skills_copies_agents_md_and_reports_failure(self):
        self.put_file("ma", "# 원본 지침\n")
        code, out = self.act("fresh", "create", clone_from="ma", no_skills=True)
        self.assertEqual((code, out.get("copy_error")), (200, None), out)
        self.assertEqual(self.file("fresh"), "# 원본 지침\n")
        self.assertEqual(self.detail("fresh")["agents"]["never_saved"], False)                       # AAS 가 사람의 요청으로 옮긴 판
        Fake.state["read_fail"].add(f"{ROOT}/profiles/main/AGENTS.md")
        code, out = self.act("sa", "create", clone_from="main", no_skills=True)
        self.assertEqual(code, 200); self.assertIn("copy_error", out)                                 # 프로파일은 두고 이유를 알린다
        Fake.state["writes"].clear()
        self.assertEqual(self.act("ma2", "create", clone_from="default", no_skills=True)[0], 200)     # 원본 지침이 없으면 쓰지 않는다
        self.assertFalse(any(p.endswith("ma2/AGENTS.md") for p, _, _ in Fake.state["writes"]))

    def test_rename_moves_versions_and_acks_and_delete_forgets_them(self):
        self.put_file("ma", "처음\n")
        self.detail()
        self.put_file("ma", "에이전트\n")
        vid = self.detail()["agents"]["agent_change"]["id"]
        self.assertEqual(self.act("ma", "agents_ack", version_id=vid)[0], 200)
        n = len(files.versions(POD, "agents:ma"))
        self.assertEqual(self.act("ma", "rename", new_name="ma2")[0], 200)
        self.assertEqual((len(files.versions(POD, "agents:ma2")), files.versions(POD, "agents:ma")), (n, []))
        a = self.detail("ma2")["agents"]
        self.assertIsNone(a["agent_change"])                                                         # 확인 기록도 따라왔다
        self.assertEqual(self.act("ma2", "delete", confirm="ma2", skip_export=True)[0], 200)
        self.assertEqual(files.versions(POD, "agents:ma2"), [])


class AgentsVersionStoreTest(unittest.TestCase):
    """files 쪽 규칙: 잠금(H1)·사람 판(M1)·확인 표(M2)·종류별 가림(H4)."""

    def setUp(self):
        self.pod = f"agents-store-{id(self)}"
        self.key = "agents:ma"
        self.addCleanup(lambda: files.forget_key(self.pod, self.key))

    def test_save_and_agent_edit_record_share_a_lock(self):
        """쓰기와 사람 판 기록 사이에 상세 읽기가 끼어도 사람 판으로 남는다(H1)."""
        disk = {"v": "옛 내용\n"}
        sent, go = threading.Event(), threading.Event()

        def send(text):
            disk["v"] = text
            sent.set()
            go.wait(5)
        result = {}

        def detail_read():                                       # 상세: 잠금 안에서 읽고 기록한다
            sent.wait(5)
            with files.text_lock(self.pod, self.key):
                text = disk["v"]
                result["what"] = files.record_agent_edit(self.pod, self.key, "ma", text, files.text_sha(text))
        t = threading.Thread(target=detail_read)
        t.start()
        saver = threading.Thread(target=lambda: files.save_text(self.pod, self.key, "옛 내용\n", "새 내용\n", files.text_sha("옛 내용\n"), "kim@x.io",
                                                                send, lambda: disk["v"], "저장"))
        saver.start()
        sent.wait(5)
        time.sleep(0.2)
        self.assertNotIn("what", result)                         # 저장이 끝날 때까지 기다린다
        go.set(); saver.join(5); t.join(5)
        self.assertEqual(result["what"], "same")
        self.assertEqual([v["by"] for v in files.versions(self.pod, self.key)], ["kim@x.io", ""])

    def test_human_version_definition(self):
        self.assertEqual([files.is_human(b) for b in ("kim@x.io", "local", "", None, "hermes:ma")], [True, True, False, False, False])

    def test_ack_rows_follow_pruned_versions_and_the_schema_is_migrated(self):
        files.record_agent_edit(self.pod, self.key, "ma", "0", files.text_sha("0"))
        files.record_agent_edit(self.pod, self.key, "ma", "1", files.text_sha("1"))
        vid = files.versions(self.pod, self.key)[0]["id"]
        files.ack(self.pod, self.key, vid, "kim@x.io")
        for i in range(files.MAX_AGENT_VERSIONS + 2):
            files.record_agent_edit(self.pod, self.key, "ma", f"v{i}", files.text_sha(f"v{i}"))
        with store.connect() as conn:
            left = conn.execute("SELECT COUNT(*) FROM file_acks WHERE pod=? AND path=?", (self.pod, self.key)).fetchone()[0]
        self.assertEqual(left, 0)                                # 판을 지울 때 확인 행도 지웠다(M2)
        self.assertIn(files.ACK_SCHEMA, dbmigrate.schema_scripts())

    def test_masking_rule_depends_on_the_kind(self):
        text = f"참고 {NOTION}\n"
        self.assertEqual(files.record_agent_edit(self.pod, self.key, "ma", text, files.text_sha(text)), "first")
        self.assertEqual(files.version_content(self.pod, self.key, files.versions(self.pod, self.key)[0]["id"]), text)
        self.assertFalse(files.has_secrets(text, "agents")); self.assertTrue(files.has_secrets(text))
        self.assertIsNotNone(files.remember_version(self.pod, self.key, "새 " + text, "kim@x.io", "x"))
        self.assertIsNone(files.remember_version(self.pod, self.key, TOKEN, "kim@x.io", "x"))


if __name__ == "__main__":
    unittest.main()

# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""AAS MCP 서버 /mcp(스펙 2026-10-28-001 §3-2·§3-3 T5a, OMAI-1513).

프로토콜 왕복(가짜 클라이언트) · Bearer 인증과 거절 이유 · 범위로 거른 도구 목록 · 대화 도구(가짜 대화 허브)·오류 낱말 · 한도 · Keycloak 확인.
"""
import aasserver  # 실제 uvicorn 앱을 띄우는 시험 하네스(OMAI-1100)
import http.client
import json
import os
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest import mock

TMP = tempfile.TemporaryDirectory()
os.environ.setdefault("AAS_DATA_DIR", str(Path(TMP.name) / "data"))

ALICE, BOSS = "mcp-alice@corp.example", "mcp-boss@corp.example"
PASSWORD = "correct horse battery"


class FakeHub:
    """대화 허브 대역. 이벤트는 실제 허브처럼 seq 를 붙여 쌓고, events_after 가 기다린다."""

    def __init__(self, pid):
        self.pid, self.sessions, self.calls = pid, {}, []
        self._events, self._seq = {}, {}
        self.cond = threading.Condition()
        self.explode = False

    def status(self):                                     # 실제 ChatHub.status 처럼 안쪽 값(대시보드 주소·설정 파일 경로)도 담는다
        return {"configured": True, "connected": True, "error": "", "sessions": [], "dashboard": "http://hermes.internal:9119",
                "env_file": "/etc/aas/aas.env"}

    history_rows: list = []

    def history(self, profile, limit=80):
        return list(self.history_rows)

    def create_session(self, profile, by=""):
        sid = f"s-{self.pid}-{len(self.sessions) + 1}"
        self.sessions[sid] = {"profile": profile, "title": "", "created": time.time()}
        return {"session_id": sid, "profile": profile}

    def resume(self, profile, stored, by=""):
        sid = f"r-{stored}"
        self.sessions[sid] = {"profile": profile, "title": "", "created": time.time()}
        return {"session_id": sid, "profile": profile, "stored_id": stored}

    def send(self, sid, text, by="", files=None, **kw):
        self.calls.append(("send", sid, text, by, kw.get("skill")))
        return {}

    def interrupt(self, sid):
        if self.explode:
            raise RuntimeError("boom secret-detail")
        self.calls.append(("interrupt", sid))
        return {}

    def approve(self, sid, choice, request_id=None):
        self.calls.append(("approve", sid, choice, request_id))
        return {}

    def clarify(self, sid, request_id, answer, question_id=None):
        self.calls.append(("clarify", sid, request_id, answer))
        return {}

    def seq(self, sid):
        with self.cond:
            return self._seq.get(sid, 0)

    def push(self, sid, etype, payload):
        with self.cond:
            n = self._seq.get(sid, 0) + 1
            self._seq[sid] = n
            self._events.setdefault(sid, []).append({"seq": n, "type": etype, "payload": payload})
            self.cond.notify_all()

    def events_after(self, sid, after, wait=25.0):
        from aas.hermes.hermes_chat import ChatUnavailable
        if sid not in self.sessions:
            from aas.common.i18n import tr
            raise ChatUnavailable(tr("이 서버가 만든 세션이 아닙니다", "This session was not created by this server"))   # 실제 허브와 같은 문장
        deadline = time.time() + wait
        with self.cond:
            while True:
                out = [e for e in self._events.get(sid, ()) if e["seq"] > after]
                if out or deadline - time.time() <= 0:
                    return out
                self.cond.wait(deadline - time.time())


class McpServerTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        from aas.auth import auth, tokens
        from aas.fleet import pods
        from aas.web import mcp_server, server
        root = Path(TMP.name)
        cls.users = root / "mcp-users.json"
        for e in (ALICE, BOSS):
            auth.save_user(e, PASSWORD, cls.users)
        for name in ("mcp_home_a", "mcp_home_c"):
            (root / name / "profiles" / "main").mkdir(parents=True, exist_ok=True)
        reg = root / "mcp-pods.json"
        reg.write_text(json.dumps({"admins": [BOSS], "pods": [
            {"id": "mcp-a", "owner": ALICE, "hermes_home": str(root / "mcp_home_a")},
            {"id": "mcp-c", "owner": BOSS, "hermes_home": str(root / "mcp_home_c")}]}))
        cls.app = aasserver.start()
        cls.port = cls.app.server_port
        cls.saved = (server._auth, server._registry)
        server._auth = auth.Auth({"issuer": "", "client_id": "", "client_secret": "", "domain": "",
                                  "public_url": f"http://127.0.0.1:{cls.port}", "hours": 1, "users_file": cls.users})
        server._registry = pods.Registry(reg)
        cls.hubs = {"mcp-a": FakeHub("mcp-a"), "mcp-c": FakeHub("mcp-c")}
        cls.hub_patch = mock.patch.object(server, "hub", lambda pod: cls.hubs[pod.id])
        cls.hub_patch.start()
        cls.kc_patch = mock.patch.object(mcp_server, "_keycloak", lambda: None)     # 비밀번호 로그인 설치 — Keycloak 확인 없음
        cls.kc_patch.start()
        user = {"email": ALICE, "sub": "sub-alice"}
        cls.all_view, cls.all_raw = tokens.issue(user, "all", "all", 30)
        cls.read_view, cls.read_raw = tokens.issue(user, "read", "read", 30)
        cls.server, cls.mcp = server, mcp_server

    @classmethod
    def tearDownClass(cls):
        cls.hub_patch.stop()
        cls.kc_patch.stop()
        cls.app.shutdown()
        cls.server._auth, cls.server._registry = cls.saved
        from aas.auth import tokens
        with tokens._conn() as conn:
            for e in (ALICE, BOSS):
                conn.execute("DELETE FROM personal_tokens WHERE user_email=?", (e,))
                conn.execute("DELETE FROM mcp_rate WHERE user_email=?", (e,))
                conn.execute("DELETE FROM mcp_waits WHERE user_email=?", (e,))

    # ---- 도우미 ----------------------------------------------------------------------------------
    def post(self, msg, token=None, session=None, headers=None, method="POST"):
        c = http.client.HTTPConnection("127.0.0.1", self.port, timeout=70)
        h = {"Content-Type": "application/json", "Accept": "application/json, text/event-stream"}
        if token:
            h["Authorization"] = f"Bearer {token}"
        if session:
            h["Mcp-Session-Id"] = session
        h.update(headers or {})
        c.request(method, "/mcp", body=json.dumps(msg) if msg is not None else None, headers=h)
        r = c.getresponse()
        data = r.read()
        return r, (json.loads(data) if data[:1] == b"{" else data)

    def session(self, token=None):
        r, out = self.post({"jsonrpc": "2.0", "id": 1, "method": "initialize",
                            "params": {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "t", "version": "1"}}},
                           token or self.all_raw)
        self.assertEqual(r.status, 200, out)
        return r.getheader("Mcp-Session-Id")

    def call(self, name, args=None, token=None):
        token = token or self.all_raw
        r, out = self.post({"jsonrpc": "2.0", "id": 7, "method": "tools/call", "params": {"name": name, "arguments": args or {}}},
                           token, self.session(token))
        self.assertEqual(r.status, 200, out)
        res = out["result"]
        return res["isError"], json.loads(res["content"][0]["text"])

    # ---- 프로토콜 --------------------------------------------------------------------------------
    def test_initialize_세션_번호_ping_알림(self):
        r, out = self.post({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2025-03-26"}}, self.all_raw)
        self.assertEqual((r.status, out["result"]["protocolVersion"]), (200, "2025-03-26"))
        self.assertIn("tools", out["result"]["capabilities"])
        sid = r.getheader("Mcp-Session-Id")
        self.assertTrue(sid)
        r, out = self.post({"jsonrpc": "2.0", "id": 2, "method": "initialize", "params": {"protocolVersion": "1999-01-01"}}, self.all_raw)
        self.assertEqual(out["result"]["protocolVersion"], "2025-06-18")                  # 모르는 판이면 우리 기본
        r, _ = self.post({"jsonrpc": "2.0", "method": "notifications/initialized"}, self.all_raw, sid)
        self.assertEqual(r.status, 202)
        r, out = self.post({"jsonrpc": "2.0", "id": 3, "method": "ping"}, self.all_raw, sid)
        self.assertEqual((r.status, out["result"]), (200, {}))
        r, out = self.post({"jsonrpc": "2.0", "id": 4, "method": "nope"}, self.all_raw, sid)
        self.assertEqual(out["error"]["code"], -32601)
        r, out = self.post({"jsonrpc": "2.0", "id": 5, "method": "ping"}, self.all_raw)                       # 번호 없음
        self.assertEqual(r.status, 400)
        r, out = self.post({"jsonrpc": "2.0", "id": 6, "method": "ping"}, self.all_raw, sid[:-1] + ("0" if sid[-1] != "0" else "1"))
        self.assertEqual(r.status, 404)                                                                     # 위조 → 다시 initialize
        r, out = self.post({"jsonrpc": "2.0", "id": 7, "method": "ping"}, self.read_raw, sid)
        self.assertEqual(r.status, 404)                                                                     # 다른 연결의 번호
        r, out = self.post(None, self.all_raw, headers={"Content-Type": "application/json"}, method="POST")
        self.assertEqual(r.status, 400)
        c = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        c.request("POST", "/mcp", body=b"{not json", headers={"Authorization": f"Bearer {self.all_raw}"})
        r = c.getresponse()
        self.assertEqual((r.status, json.loads(r.read())["error"]["code"]), (400, -32700))
        r, _ = self.post(None, self.all_raw, method="GET")
        self.assertEqual(r.status, 405)
        r, _ = self.post(None, self.all_raw, sid, method="DELETE")
        self.assertEqual(r.status, 204)

    def test_인증_거절과_이유(self):
        from aas.auth import tokens
        r, out = self.post({"jsonrpc": "2.0", "id": 1, "method": "initialize"})
        self.assertEqual((r.status, out["error"]), (401, "auth"))
        self.assertIn("Bearer", r.getheader("WWW-Authenticate"))
        r, out = self.post({"jsonrpc": "2.0", "id": 1, "method": "initialize"}, "aas_pat_wrong")
        self.assertEqual((r.status, out["reason"]), (401, "invalid_token"))
        view, raw = tokens.issue({"email": ALICE}, "gone", "read", 7)
        tokens.revoke(view["id"], ALICE)
        self.assertEqual(self.post({"jsonrpc": "2.0", "id": 1, "method": "initialize"}, raw)[1]["reason"], "revoked")
        view, raw = tokens.issue({"email": ALICE}, "old", "read", 7)
        with tokens._conn() as conn:
            conn.execute("UPDATE personal_tokens SET expires=? WHERE id=?", (time.time() - 1, view["id"]))
        self.assertEqual(self.post({"jsonrpc": "2.0", "id": 1, "method": "initialize"}, raw)[1]["reason"], "expired")
        r, out = self.post({"jsonrpc": "2.0", "id": 1, "method": "initialize"}, self.all_raw, headers={"Origin": "http://evil.example"})
        self.assertEqual((r.status, out["reason"]), (403, "origin"))                    # 브라우저 안 스크립트
        c = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)                 # 화면 쿠키만으로는 /mcp 를 못 쓴다
        c.request("POST", "/auth/password", body=f"email={ALICE}&password=correct+horse+battery&next=/",
                  headers={"Content-Type": "application/x-www-form-urlencoded"})
        r = c.getresponse(); r.read()
        cookie = r.getheader("Set-Cookie").split(";")[0]
        r, out = self.post({"jsonrpc": "2.0", "id": 1, "method": "initialize"}, headers={"Cookie": cookie})
        self.assertEqual(r.status, 401)

    def test_로그인을_끈_설치에는_mcp_가_없다(self):
        from aas.auth import auth
        saved = self.server._auth
        self.server._auth = auth.Auth({"issuer": "", "client_id": "", "client_secret": "", "domain": "", "public_url": "",
                                       "hours": 1, "users_file": Path(TMP.name) / "none.json"})
        try:
            self.assertFalse(self.server._auth.enabled)
            r, _ = self.post({"jsonrpc": "2.0", "id": 1, "method": "initialize"}, self.all_raw)
            self.assertEqual(r.status, 404)
        finally:
            self.server._auth = saved

    def test_mark_used_와_기록(self):
        from aas.auth import tokens
        from aas.common import store
        with tokens._conn() as conn:
            conn.execute("UPDATE personal_tokens SET last_used=0 WHERE id=?", (self.all_view["id"],))
        self.call("agents_list")
        row = next(t for t in tokens.list_for(ALICE) if t["id"] == self.all_view["id"])
        self.assertIsNotNone(row["last_used"])
        self.assertEqual(row["last_ip"], "127.0.0.1")
        with store.connect() as conn:                     # 시각 순이 아니라 내용으로(같은 초의 기록 순서는 정해지지 않는다)
            notes = [r["note"] for r in conn.execute("SELECT note FROM usage WHERE kind='mcp_call' AND note LIKE ?", (f"{ALICE} agents_list %",))]
        self.assertIn(f"{ALICE} agents_list pod= ok via=token", notes)

    # ---- 도구 목록·범위 --------------------------------------------------------------------------
    def test_도구_목록은_범위로_거른다(self):
        def names(token):
            r, out = self.post({"jsonrpc": "2.0", "id": 2, "method": "tools/list"}, token, self.session(token))
            return {t["name"] for t in out["result"]["tools"]}
        every = names(self.all_raw)
        self.assertEqual(every, set(self.mcp.TOOLS))
        read = names(self.read_raw)
        self.assertNotIn("approval_respond", read)
        self.assertNotIn("command_run", read)
        self.assertIn("chat_wait", read)
        self.assertIn("files_list", read)
        err, out = self.call("approval_respond", {"pod": "mcp-a", "session_id": "x", "choice": "once"}, self.read_raw)
        self.assertEqual((err, out["error"]), (True, "forbidden"))                     # 목록에 없어도 부를 때 다시 본다
        r, out = self.post({"jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": {"name": "nope"}},
                           self.all_raw, self.session())
        self.assertEqual(out["error"]["code"], -32602)
        for spec in self.mcp.tools_for(set(self.mcp.tokens.SCOPES)):
            self.assertEqual(spec["inputSchema"]["type"], "object")

    # 묶음별 도구 목록 계약(스펙 2026-11-03-001 R9). 「전체」·「스킬 개발용」은 바꾸기 전(2026-11-03)에 잡은 목록과 같아야 하고,
    # 「읽기만」은 보내기 도구 3개(chat_start·chat_send·chat_interrupt)만 빠진 18개다
    SKILL_DEV_TOOLS = {
        "agents_list", "approval_respond", "chat_interrupt", "chat_read", "chat_send", "chat_start", "chat_wait", "clarify_answer",
        "credential_clear", "credential_request", "credential_set", "credential_upload_command", "credentials_status", "cron_get",
        "cron_list", "env_upload_command", "file_get", "file_put", "files_list", "market_list", "market_publish_status", "mcp_list",
        "profile_get", "profile_text_versions", "secret_clear", "secret_request", "secret_set", "secrets_status", "skill_apply",
        "skill_create", "skill_file_read", "skill_get", "skill_toggle", "skill_update", "skill_upload", "skills_list", "token_rotate"}
    ALL_TOOLS = SKILL_DEV_TOOLS | {
        "channel_list", "channel_save", "channel_test", "channel_token_upload_command", "command_run", "cron_create", "cron_delete",
        "cron_run", "cron_update", "market_install", "market_publish", "market_remove", "mcp_add", "mcp_apply", "mcp_catalog",
        "mcp_install", "mcp_login_link", "mcp_remove", "mcp_test", "mcp_toggle", "pairing_answer", "profile_create", "profile_delete",
        "profile_rename", "profile_text_preview", "profile_text_revert", "profile_text_set", "toolset_set", "skill_delete"}
    READ_TOOLS = {
        "agents_list", "chat_read", "chat_wait", "credentials_status", "cron_get", "cron_list", "file_get", "files_list",
        "market_list", "market_publish_status", "mcp_list", "profile_get", "profile_text_versions", "secrets_status",
        "skill_file_read", "skill_get", "skills_list", "token_rotate"}
    READ_ONLY_SEND = ('This connection is read-only ("Read only" bundle) and cannot send messages to agents. To send, reconnect with the '
                      '"Skill development" or "Everything (my AI agents)" bundle in Settings › Claude Code connections.')

    def test_묶음별_도구_목록_계약(self):
        from aas.auth import tokens
        self.assertEqual((len(self.ALL_TOOLS), len(self.SKILL_DEV_TOOLS), len(self.READ_TOOLS)), (66, 37, 18))
        dev_view, dev_raw = tokens.issue({"email": ALICE, "sub": "s"}, "dev", "skill-dev", 30)
        try:
            for bundle, raw, want in (("all", self.all_raw, self.ALL_TOOLS), ("skill-dev", dev_raw, self.SKILL_DEV_TOOLS),
                                      ("read", self.read_raw, self.READ_TOOLS)):
                with self.subTest(bundle=bundle):
                    r, out = self.post({"jsonrpc": "2.0", "id": 2, "method": "tools/list"}, raw, self.session(raw))
                    self.assertEqual({t["name"] for t in out["result"]["tools"]}, want)
                    self.assertEqual({t["name"] for t in self.mcp.tools_for(set(tokens.BUNDLES[bundle]))}, want)
        finally:
            tokens.revoke(dev_view["id"], ALICE)

    def test_읽기만_토큰은_보내지_못하고_안내를_받는다(self):
        for name, args in (("chat_start", {"pod": "mcp-a"}), ("chat_send", {"pod": "mcp-a", "session_id": "x", "text": "hi"}),
                           ("chat_interrupt", {"pod": "mcp-a", "session_id": "x"})):
            with self.subTest(tool=name):
                err, out = self.call(name, args, self.read_raw)
                self.assertEqual((err, out["error"], out["message"]), (True, "forbidden", self.READ_ONLY_SEND))
        err, out = self.call("approval_respond", {"pod": "mcp-a", "session_id": "x", "choice": "once"}, self.read_raw)
        self.assertEqual(out["message"], "this connection does not have the `approve` scope")   # 다른 범위의 문구는 그대로
        self.assertFalse(any(c[0] == "send" for c in self.hubs["mcp-a"].calls if len(c) > 2 and c[2] == "hi"))

    def test_읽기만_토큰도_지난_대화를_읽는다(self):
        """chat_read 는 안에서 chat_start(resume)를 함수로 부른다 — 범위 검사는 바깥 도구(chat)만 본다."""
        hub = self.hubs["mcp-a"]
        orig = hub.resume

        def resume(profile, stored, by=""):
            out = orig(profile, stored, by)
            hub.push(out["session_id"], "aas.history", {"messages": [{"role": "assistant", "text": "old answer", "timestamp": 2}]})
            return out
        with mock.patch.object(hub, "resume", resume):
            err, out = self.call("chat_read", {"pod": "mcp-a", "profile": "main", "stored_id": "20261103_r1", "last": 1}, self.read_raw)
        self.assertFalse(err, out)
        self.assertEqual(out["messages"][-1]["text"], "old answer")

    # ---- 대화 ------------------------------------------------------------------------------------
    def test_에이전트_목록은_내_것만(self):
        err, out = self.call("agents_list")
        self.assertFalse(err)
        ids = json.dumps(out)
        self.assertIn("mcp-a", ids)
        self.assertNotIn("env_file", ids)                                                # 서버 안쪽 값은 넘기지 않는다
        self.assertNotIn("dashboard", ids)
        self.assertEqual(out["agents"][0]["agents"][0].keys() - set(self.mcp.PROFILE_KEYS), set())
        self.assertNotIn("mcp-c", ids)                                                   # 관리자 BOSS 의 것

    def test_대화_흐름_보내기_기다리기_답과_바뀐_파일(self):
        hub = self.hubs["mcp-a"]
        err, start = self.call("chat_start", {"pod": "mcp-a", "profile": "main"})
        self.assertFalse(err, start)
        sid = start["session_id"]
        hub.push(sid, "aas.history", {"messages": []})                                 # 보내기 전 이벤트는 이번 턴이 아니다
        err, sent = self.call("chat_send", {"pod": "mcp-a", "session_id": sid, "text": "안녕"})
        self.assertFalse(err, sent)
        self.assertEqual(sent["after"], 1)
        self.assertEqual(hub.calls[-1][:4], ("send", sid, "안녕", ALICE))

        def answer():
            time.sleep(0.2)
            hub.push(sid, "message.start", {})
            hub.push(sid, "message.delta", {"text": "반갑"})
            hub.push(sid, "tool.start", {"tool_id": "t1", "name": "terminal", "context": "ls -la /secret"})
            hub.push(sid, "tool.complete", {"tool_id": "t1", "result": "x" * 5000})
            hub.push(sid, "message.complete", {"text": "반갑습니다", "status": "complete"})
            time.sleep(0.3)
            hub.push(sid, "aas.files", {"turn": 1, "files": [{"path": "out.txt", "change": "added"}], "truncated": False})
        threading.Thread(target=answer, daemon=True).start()
        err, got = self.call("chat_wait", {"pod": "mcp-a", "session_id": sid, "after": sent["after"], "timeout": 10})
        self.assertFalse(err, got)
        self.assertEqual((got["state"], got["text"]), ("done", "반갑습니다"))
        self.assertEqual(got["tools"], [{"name": "terminal", "state": "done"}])         # 도구는 이름·상태만(D9)
        self.assertNotIn("/secret", json.dumps(got))
        self.assertEqual(got["files"][0]["files"][0]["path"], "out.txt")
        self.assertEqual(got["after"], 7)

    def test_기다리기_시간이_지나면_running_과_같은_after(self):
        err, start = self.call("chat_start", {"pod": "mcp-a", "profile": "main"})
        t0 = time.time()
        err, got = self.call("chat_wait", {"pod": "mcp-a", "session_id": start["session_id"], "after": 0, "timeout": 0.3})
        self.assertFalse(err)
        self.assertEqual((got["state"], got["after"]), ("running", 0))
        self.assertLess(time.time() - t0, 5)

    def test_승인과_되묻기(self):
        hub = self.hubs["mcp-a"]
        err, start = self.call("chat_start", {"pod": "mcp-a", "profile": "main"})
        sid = start["session_id"]
        hub.push(sid, "message.start", {})
        hub.push(sid, "approval.request", {"request_id": "q1", "command": "rm -rf build", "srq_id": "srq-1"})
        err, got = self.call("chat_wait", {"pod": "mcp-a", "session_id": sid, "after": 0, "timeout": 5})
        self.assertEqual(got["state"], "approval")
        self.assertEqual(got["approvals"], [{"request_id": "q1", "command": "rm -rf build"}])   # 서버 요청 번호는 넘기지 않는다
        err, out = self.call("approval_respond", {"pod": "mcp-a", "session_id": sid, "request_id": "q1", "choice": "once"})
        self.assertFalse(err, out)
        self.assertEqual(hub.calls[-1], ("approve", sid, "once", "q1"))
        err, out = self.call("approval_respond", {"pod": "mcp-a", "session_id": sid, "choice": "maybe"})
        self.assertEqual(out["error"], "invalid")
        err, out = self.call("approval_respond", {"pod": "mcp-a", "session_id": sid, "request_id": "q1", "choice": "deny"})
        self.assertEqual(out["error"], "invalid")                                        # 같은 카드에 두 번째 답(§3-7 ④)
        self.assertIn("Claude Code", out["message"])
        self.assertEqual(hub.calls[-1], ("approve", sid, "once", "q1"))                  # 두 번째 답은 Hermes 에 가지 않았다
        from aas.office import office
        with self.assertRaises(office.OfficeError) as cm:                               # 받은편지함에서 늦게 누른 사람
            self.server._inbox_apply(self.server.registry(), {"pod": "mcp-a", "sid": sid, "kind": "approval", "request_id": "q1",
                                                              "question_id": ""}, {"choice": "deny"}, BOSS)
        self.assertIn("이미 Claude Code 가 답했습니다", str(cm.exception))
        hub.push(sid, "aas.approval.answered", {"choice": "once", "request_id": "q1"})
        hub.push(sid, "clarify.request", {"request_id": "c1", "question": "어느 쪽?", "choices": ["A", "B"]})
        err, got = self.call("chat_wait", {"pod": "mcp-a", "session_id": sid, "after": 2, "timeout": 5})
        self.assertEqual((got["state"], got["clarify"][0]["request_id"]), ("clarify", "c1"))
        err, out = self.call("clarify_answer", {"pod": "mcp-a", "session_id": sid, "request_id": "c1", "answer": "A"})
        self.assertFalse(err, out)
        self.assertEqual(hub.calls[-1], ("clarify", sid, "c1", "A"))

    def test_오류_낱말(self):
        hub = self.hubs["mcp-a"]
        err, out = self.call("chat_send", {"session_id": "x", "text": "hi"})
        self.assertEqual((err, out["error"]), (True, "invalid"))                       # 쓰기 도구는 pod 필수(F1)
        err, out = self.call("chat_send", {"pod": "mcp-c", "session_id": "x", "text": "hi"})
        self.assertEqual(out["error"], "forbidden")                                      # 남의 에이전트
        err, out = self.call("chat_wait", {"pod": "mcp-a", "session_id": "gone", "timeout": 0.1})
        self.assertEqual(out["error"], "reconnect")                                      # 파드가 바뀌어 세션이 없다(D4)
        self.assertIn("chat_start", out["next"])
        hub.explode = True
        try:
            err, out = self.call("chat_interrupt", {"pod": "mcp-a", "session_id": "x"})
        finally:
            hub.explode = False
        self.assertEqual(out["error"], "unavailable")
        self.assertNotIn("secret-detail", json.dumps(out))                               # 500 본문은 넘기지 않는다
        err, out = self.call("files_list", {})                                           # pod 를 비우면 볼 수 있는 첫 에이전트
        self.assertEqual((out["error"], out["message"]), ("unavailable", "unsupported"))  # Starlette 경로의 code 를 설명으로
        err, out = self.call("credentials_status", {"pod": "mcp-c", "profile": "main"})
        self.assertEqual(out["error"], "forbidden")

    def test_Claude_Code_가_연_대화는_목록에_표시되고_쓰는_중이다(self):
        from aas.web import legacy
        hub = self.hubs["mcp-a"]
        err, out = self.call("chat_start", {"pod": "mcp-a", "profile": "main", "resume": "stored-test", "purpose": "skill-test"})
        self.assertFalse(err, out)
        err, out = self.call("chat_start", {"pod": "mcp-a", "profile": "main", "purpose": "work"})
        self.assertEqual(out["error"], "invalid")
        hub.history_rows = [{"id": "stored-test", "title": "t"}, {"id": "stored-human", "title": "h"}]
        try:
            status, _h, raw = legacy.dispatch("GET", "/api/chat/history?pod=mcp-a&profile=main",
                                              {"user": {"email": ALICE, "via": "token"}, "pod": "mcp-a"},
                                              [(b"host", f"127.0.0.1:{self.port}".encode())], ("127.0.0.1", 1), False)
        finally:
            hub.history_rows = []
        rows = {r["id"]: r for r in json.loads(raw)["sessions"]}
        self.assertEqual(status, 200)
        self.assertEqual(rows["stored-test"]["claude"], {"purpose": "skill-test", "active": True})
        self.assertNotIn("claude", rows["stored-human"])                                 # 사람이 연 대화는 그대로

    def test_다시_열기(self):
        err, out = self.call("chat_start", {"pod": "mcp-a", "profile": "main", "resume": "stored-9"})
        self.assertFalse(err, out)
        self.assertEqual(out["session_id"], "r-stored-9")
        self.assertEqual(out["stored_id"], "stored-9")                                   # 나중에 resume 에 쓸 번호

    def test_서버가_바뀌면_다시_열_번호를_알려_준다(self):
        """2026-10-28 문서를 쓰다 확인: reconnect 가 resume=<stored_id> 를 하라는데 어느 도구도 stored_id 를 주지 않았다.
        대화 메타 테이블에 남은 번호로 바로 쓸 값을 알려 주고, 모르면 새 대화를 열게 한다."""
        from aas.ops import chat_session_meta
        chat_session_meta.opened("mcp-a", "gone-known", "stored-77", "main", ALICE, "token")
        try:
            err, out = self.call("chat_wait", {"pod": "mcp-a", "session_id": "gone-known", "timeout": 0.1})
            self.assertEqual(out["error"], "reconnect")
            self.assertIn("resume=stored-77", out["next"])
            self.assertIn("profile=main", out["next"])
            err, out = self.call("chat_wait", {"pod": "mcp-a", "session_id": "gone-unknown", "timeout": 0.1})
            self.assertEqual(out["error"], "reconnect")
            self.assertIn("new chat", out["next"])
            self.assertNotIn("<stored_id>", out["next"])
        finally:
            with chat_session_meta._conn() as conn:
                conn.execute("DELETE FROM chat_session_meta WHERE pod='mcp-a' AND session_id='gone-known'")

    def test_M2_프로파일_글_도구는_화면과_같은_경로로(self):
        """M2 ① 성격·작업 지침·설정(스펙 §3-6-1). 화면의 /api/profile·/api/profile/action 을 같은 꼴로 부른다."""
        calls = []

        async def fake(ctx, method, path, pod="", query=None, body=None):
            calls.append((method, path, query, body))
            if path == "/api/profile":
                return {"profile": {"name": "main", "description": "d", "is_default": True, "secret": "x"},
                        "soul": {"lines": ["# 성격", "API_KEY=«가림»"], "masked_lines": [2], "sha": "s1", "versions": 3},
                        "agents": {"lines": ["지침"], "masked_lines": [], "sha": "a1", "versions": 0, "readonly_reason": None},
                        "config": {"lines": ["model:", "  default: m"], "masked_lines": [], "sha": "c1", "versions": 1},
                        "toolsets": [{"name": "web", "label": "Web", "enabled": True, "configured": True, "tools": 3}],
                        "caps": {"soul": {"can": True}, "agents": {"can": True}, "config": {"can": False}, "tools": {"can": True}}}
            return {"ok": True}
        with mock.patch.object(self.mcp.Ctx, "call", fake):
            err, out = self.call("profile_get", {"pod": "mcp-a", "profile": "main"})
            self.assertFalse(err, out)
            self.assertEqual(out["soul"], {"text": "# 성격\nAPI_KEY=«가림»", "sha": "s1", "versions": 3, "masked_lines": [2]})
            self.assertNotIn("secret", out["profile"])                                    # 아는 칸만 넘긴다
            self.assertEqual(out["can_edit"], {"soul": True, "agents": True, "config": False, "tools": True})
            self.assertEqual(out["toolsets"], [{"name": "web", "label": "Web", "enabled": True, "configured": True}])
            err, _ = self.call("profile_text_set", {"pod": "mcp-a", "profile": "main", "kind": "agents", "content": "새 지침", "base_sha": "a1"})
            self.assertFalse(err)
            self.assertEqual(calls[-1][1:], ("/api/profile/action", None, {"pod": "mcp-a", "action": "agents", "name": "main",
                                                                         "content": "새 지침", "base_sha": "a1", "note": ""}))
            self.call("profile_text_preview", {"pod": "mcp-a", "profile": "main", "kind": "config", "content": "model: {}"})
            self.assertEqual(calls[-1][3]["action"], "config_preview")
            self.call("profile_text_revert", {"pod": "mcp-a", "profile": "main", "kind": "soul", "version_id": 2})
            self.assertEqual((calls[-1][3]["action"], calls[-1][3]["id"]), ("soul_revert", 2))
            self.call("profile_text_versions", {"pod": "mcp-a", "profile": "main", "kind": "config"})
            self.assertEqual(calls[-1][1:3], ("/api/profile/soul/versions", {"pod": "mcp-a", "name": "main", "kind": "config"}))
            self.call("toolset_set", {"pod": "mcp-a", "profile": "main", "toolset": "web", "enabled": False})
            self.assertEqual(calls[-1][3], {"pod": "mcp-a", "action": "toolset", "name": "main", "target": "web", "enabled": False})
            self.call("profile_delete", {"pod": "mcp-a", "profile": "side", "confirm": "side"})
            self.assertEqual(calls[-1][3], {"pod": "mcp-a", "action": "delete", "name": "side", "confirm": "side"})
            err, out = self.call("profile_text_set", {"pod": "mcp-a", "profile": "main", "kind": "secrets", "content": "x"})
            self.assertEqual(out["error"], "invalid")                                     # soul·agents·config 만
            err, out = self.call("toolset_set", {"pod": "mcp-a", "profile": "main", "toolset": "web", "enabled": "no"})
            self.assertEqual(out["error"], "invalid")

    def test_M2_예약_작업_도구는_화면과_같은_경로로(self):
        calls = []

        async def fake(ctx, method, path, pod="", query=None, body=None):
            calls.append((method, path, query, body))
            return {"ok": True}
        with mock.patch.object(self.mcp.Ctx, "call", fake):
            self.call("cron_list", {"pod": "mcp-a", "profile": "main"})
            self.assertEqual(calls[-1][:3], ("GET", "/api/cron/jobs", {"pod": "mcp-a", "profile": "main"}))
            err, out = self.call("cron_create", {"pod": "mcp-a", "profile": "main", "name": "daily", "schedule": "0 9 * * *", "skill": "hello-echo"})
            self.assertFalse(err, out)
            self.assertEqual(calls[-1][3], {"pod": "mcp-a", "action": "create", "profile": "main", "job_name": "daily", "schedule": "0 9 * * *",
                                            "prompt": "", "skill": "hello-echo", "deliver": ""})
            err, out = self.call("cron_create", {"pod": "mcp-a", "profile": "main", "name": "x", "schedule": "every 1h"})
            self.assertEqual(out["error"], "invalid")                                     # 스킬도 지시문도 없다
            n = len(calls)
            self.call("cron_update", {"pod": "mcp-a", "profile": "main", "id": "j1", "schedule": "every 2h", "prompt": "새 지시", "base_sha": "p1"})
            self.assertEqual([c[3]["action"] for c in calls[n:]], ["schedule", "prompt"])  # 준 칸만, 화면처럼 하나씩
            self.assertEqual((calls[-1][3]["content"], calls[-1][3]["base_sha"]), ("새 지시", "p1"))
            err, out = self.call("cron_run", {"pod": "mcp-a", "profile": "main", "id": "j1", "op": "trigger"})
            self.assertEqual((calls[-1][3]["action"], "chat_read" in out["next"]), ("trigger", True))
            err, out = self.call("cron_run", {"pod": "mcp-a", "profile": "main", "id": "j1", "op": "delete"})
            self.assertEqual(out["error"], "invalid")                                     # 지우기는 cron_delete 로만
            self.call("cron_delete", {"pod": "mcp-a", "profile": "main", "id": "j1", "name": "daily", "confirm": "daily"})
            self.assertEqual(calls[-1][3], {"pod": "mcp-a", "action": "delete", "profile": "main", "id": "j1", "job_name": "daily", "confirm": "daily"})

    def test_M2_MCP_서버_도구는_화면과_같은_경로로(self):
        calls = []

        async def fake(ctx, method, path, pod="", query=None, body=None):
            calls.append((method, path, query, body))
            if path == "/api/profile":
                return {"mcp": [{"name": "docs", "transport": "http", "enabled": True, "target": "https://x/mcp", "env_names": ["MCP_DOCS_API_KEY"],
                                 "auth": "header", "secret": "no"}], "caps": {"mcp": {"can": True}}}
            return {"ok": True}
        with mock.patch.object(self.mcp.Ctx, "call", fake):
            err, out = self.call("mcp_list", {"pod": "mcp-a", "profile": "main"})
            self.assertFalse(err, out)
            self.assertEqual(out["servers"][0]["env_names"], ["MCP_DOCS_API_KEY"])
            self.assertNotIn("secret", out["servers"][0])
            self.call("mcp_add", {"pod": "mcp-a", "profile": "main", "server": "docs", "kind": "url", "url": "https://x/mcp", "auth": "none"})
            self.assertEqual(calls[-1][3], {"pod": "mcp-a", "action": "mcp_add", "name": "main", "server": "docs", "kind": "url",
                                            "url": "https://x/mcp", "auth": "none"})
            err, out = self.call("mcp_add", {"pod": "mcp-a", "profile": "main", "server": "docs", "kind": "ftp"})
            self.assertEqual(out["error"], "invalid")
            err, out = self.call("mcp_remove", {"pod": "mcp-a", "profile": "main", "server": "docs", "confirm": "doc"})
            self.assertEqual(out["error"], "invalid")                                     # 확인용 이름이 다르면 보내지 않는다
            self.call("mcp_remove", {"pod": "mcp-a", "profile": "main", "server": "docs", "confirm": "docs"})
            self.assertEqual(calls[-1][3], {"pod": "mcp-a", "action": "mcp_remove", "name": "main", "target": "docs"})
            self.call("mcp_toggle", {"pod": "mcp-a", "profile": "main", "server": "docs", "enabled": False})
            self.assertEqual(calls[-1][3]["action"], "mcp")
            err, out = self.call("mcp_apply", {"pod": "mcp-a", "profile": "main"})
            self.assertEqual((calls[-1][3]["action"], "NEW chat" in out["next"]), ("mcp_apply", True))
            err, out = self.call("mcp_login_link", {"pod": "mcp-a", "profile": "main", "server": "docs"})
            self.assertEqual(out["error"], "invalid")                                     # 헤더 인증 서버 — 로그인할 것이 없다
            rows = [{"name": "wiki", "transport": "http", "enabled": True, "target": "https://w/mcp", "env_names": [], "auth": "oauth"}]

            async def oauth(ctx, method, path, pod="", query=None, body=None):
                return {"mcp": rows, "caps": {"mcp": {"can": True}}}
            with mock.patch.object(self.mcp.Ctx, "call", oauth):
                err, out = self.call("mcp_login_link", {"pod": "mcp-a", "profile": "main", "server": "wiki"})
            self.assertFalse(err, out)
            self.assertIn("/#/profiles?pod=mcp-a&name=main&pane=tools&server=wiki", out["url"])

    def test_지난_대화와_예약_작업_실행을_읽는다(self):
        """2026-10-28 OKE: cron_get 은 실행 정보만 주어 예약 작업으로 돌린 스킬의 답을 볼 수 없었다. 다시 열기의 aas.history 를 정리해 준다."""
        hub = self.hubs["mcp-a"]
        orig = hub.resume

        def resume(profile, stored, by=""):
            out = orig(profile, stored)
            hub.push(out["session_id"], "aas.history", {"messages": [
                {"role": "user", "text": "hello", "timestamp": 1}, {"role": "tool", "name": "terminal", "text": "x" * 5000},
                {"role": "assistant", "text": "ECHO-3 hello", "timestamp": 2}]})
            return out
        with mock.patch.object(hub, "resume", resume):
            err, out = self.call("chat_read", {"pod": "mcp-a", "profile": "main", "stored_id": "cron_j1_20261028_165526", "last": 2})
        self.assertFalse(err, out)
        self.assertEqual(out["messages"][-1], {"role": "assistant", "timestamp": 2, "text": "ECHO-3 hello"})
        self.assertEqual(len(out["messages"]), 2)
        self.assertTrue(out["messages"][0]["text"].endswith("…"))                          # 긴 도구 글은 자른다
        self.assertEqual(out["session_id"], "r-cron_j1_20261028_165526")

    def test_M2_프로파일_쓰기는_profile_write_범위가_있어야(self):
        from aas.auth import tokens
        view, raw = tokens.issue({"email": ALICE, "sub": "s"}, "dev", "skill-dev", 30)
        try:
            names = {t["name"] for t in self.mcp.tools_for(set(tokens.BUNDLES["skill-dev"]))}
            self.assertIn("profile_get", names)                                           # 읽기는 chat
            self.assertNotIn("profile_text_set", names)
            err, out = self.call("profile_text_set", {"pod": "mcp-a", "profile": "main", "kind": "soul", "content": "x"}, raw)
            self.assertEqual(out["error"], "forbidden")
        finally:
            tokens.revoke(view["id"], ALICE)

    def test_오류의_설명과_안내는_같은_언어(self):
        """2026-10-28 OKE: reconnect 의 message 는 한국어(서버 기본), next 는 영어였다. Claude Code 는 Accept-Language 를 보내지 않는다.
        헤더가 없으면 도구 설명과 같은 영어, 헤더가 있으면 그 언어로 맞춘다. chat_wait 의 기다림은 다른 실행기에서 돌아 언어를 잃었다."""
        def wait(headers=None):
            tok = self.all_raw
            sess = self.session(tok)
            r, out = self.post({"jsonrpc": "2.0", "id": 9, "method": "tools/call",
                                "params": {"name": "chat_wait", "arguments": {"pod": "mcp-a", "session_id": "gone-lang", "timeout": 0.1}}},
                               tok, sess, headers)
            return json.loads(out["result"]["content"][0]["text"])
        out = wait()
        self.assertEqual(out["error"], "reconnect")
        self.assertEqual(out["message"], "This session was not created by this server")
        self.assertIn("new chat", out["next"])
        out = wait({"Accept-Language": "ko"})
        self.assertEqual(out["message"], "이 서버가 만든 세션이 아닙니다")
        self.assertIn("새 대화", out["next"])

    def test_에이전트_목록_설명은_돌려주는_것만(self):
        spec = next(t for t in self.mcp.tools_for({"chat"}) if t["name"] == "agents_list")
        self.assertNotIn("recent chats", spec["description"])                            # 최근 대화는 돌려주지 않는다

    # ---- 한도 ------------------------------------------------------------------------------------
    def test_분당_호출_한도(self):
        from aas.auth import mcp_limits
        with mock.patch.object(mcp_limits, "per_minute", lambda: 1):
            with mcp_limits._conn() as conn:
                conn.execute("DELETE FROM mcp_rate WHERE user_email=?", (ALICE,))
            self.assertFalse(self.call("agents_list")[0])
            err, out = self.call("agents_list")
            self.assertEqual((err, out["error"]), (True, "busy"))
        with mcp_limits._conn() as conn:
            conn.execute("DELETE FROM mcp_rate WHERE user_email=?", (ALICE,))

    def test_사람당_동시_기다리기_한도(self):
        from aas.auth import mcp_limits
        err, start = self.call("chat_start", {"pod": "mcp-a", "profile": "main"})
        held = [mcp_limits.wait_begin(ALICE) for _ in range(3)]                          # 다른 파드가 잡은 자리 셋
        try:
            self.assertTrue(all(held))
            self.assertIsNone(mcp_limits.wait_begin(ALICE))
            err, out = self.call("chat_wait", {"pod": "mcp-a", "session_id": start["session_id"], "timeout": 0.1})
            self.assertEqual(out["error"], "busy")
        finally:
            for w in held:
                mcp_limits.wait_end(w)
        err, out = self.call("chat_wait", {"pod": "mcp-a", "session_id": start["session_id"], "timeout": 0.1})
        self.assertFalse(err, out)

    # ---- Keycloak 확인(D12) ---------------------------------------------------------------------
    def test_Keycloak_에서_빠진_사람은_연결이_모두_끊긴다(self):
        from aas.auth import tokens

        class Gone:
            def is_member(self, email):
                return email != "mcp-carol@corp.example"

        class Down:
            def is_member(self, email):
                raise OSError("unreachable")

        view, raw = tokens.issue({"email": "mcp-carol@corp.example"}, "c", "read", 7)
        other, raw2 = tokens.issue({"email": "mcp-carol@corp.example"}, "c2", "read", 7)
        self.mcp._members.clear()
        with mock.patch.object(self.mcp, "_keycloak", lambda: Down()):
            r, out = self.post({"jsonrpc": "2.0", "id": 1, "method": "initialize"}, raw)
            self.assertEqual((r.status, out["reason"]), (503, "member_check"))         # 확인하지 못하면 막는다
        with mock.patch.object(self.mcp, "_keycloak", lambda: Gone()):
            r, out = self.post({"jsonrpc": "2.0", "id": 1, "method": "initialize"}, raw)
            self.assertEqual((r.status, out["reason"]), (401, "removed"))
        self.assertEqual(tokens.lookup_state(raw2)[0], "revoked")
        self.mcp._members.clear()
        with tokens._conn() as conn:
            conn.execute("DELETE FROM personal_tokens WHERE user_email='mcp-carol@corp.example'")

    def test_Keycloak_확인은_5분_기억한다(self):
        n = []

        class Count:
            def is_member(self, email):
                n.append(email)
                return True
        self.mcp._members.clear()
        with mock.patch.object(self.mcp, "_keycloak", lambda: Count()):
            self.assertTrue(self.mcp.member("x@corp.example", now=1000.0))
            self.assertTrue(self.mcp.member("x@corp.example", now=1200.0))
            self.assertEqual(len(n), 1)
            self.assertTrue(self.mcp.member("x@corp.example", now=1301.0))
            self.assertEqual(len(n), 2)
        self.mcp._members.clear()


    # ---- 1회용 전송(T5b, D3) ---------------------------------------------------------------------
    def raw(self, method, url, body=b"", headers=None):
        path = url.split(f"127.0.0.1:{self.port}", 1)[-1]
        c = http.client.HTTPConnection("127.0.0.1", self.port, timeout=30)
        c.request(method, path, body=body if method != "GET" else None, headers=headers or {})
        r = c.getresponse()
        data = r.read()
        return r, (json.loads(data) if data[:1] == b"{" else data)

    @staticmethod
    def skill_zip(name="mcp-demo"):
        import io
        import zipfile
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w") as z:
            z.writestr("SKILL.md", f"---\nname: {name}\ndescription: 시험 스킬\n---\n\n# {name}\n")
        return buf.getvalue()

    def test_스킬_zip_올리기는_curl_명령으로_한_번만(self):
        err, out = self.call("skill_upload", {"pod": "mcp-a", "profile": "main", "source": "/tmp/my skill.zip"})
        self.assertFalse(err, out)
        self.assertIn("'/tmp/my skill.zip'", out["command"])                           # 경로는 셸 따옴표로
        self.assertIn("/mcp/transfer/", out["url"])
        self.assertTrue(out["url"].startswith(f"http://127.0.0.1:{self.port}/mcp/transfer/"))
        blob = self.skill_zip()
        r, got = self.raw("GET", out["url"])                                             # 방향이 다르면 키를 쓰지 않는다
        self.assertEqual(r.status, 404)
        r, got = self.raw("PUT", out["url"], blob, {"Content-Type": "application/octet-stream"})
        self.assertEqual(r.status, 200, got)
        self.assertEqual(got["name"], "mcp-demo")
        self.assertRegex(got["hash"], "^[0-9a-f]{64}$")
        r, again = self.raw("PUT", out["url"], blob)
        self.assertEqual((r.status, again["reason"]), (410, "used"))
        from aas.common import store
        want, notes = f"{ALICE} up skill pod=mcp-a status=200 via=token", []
        for _ in range(40):                                   # 흘려보내기 기록은 응답을 다 보낸 뒤에 남는다 — 잠깐 기다린다
            with store.connect() as conn:
                notes = [r["note"] for r in conn.execute("SELECT note FROM usage WHERE kind='mcp_transfer'").fetchall()]
            if want in notes:
                break
            time.sleep(0.05)
        self.assertIn(want, notes)
        err, out = self.call("skill_upload", {"pod": "mcp-c", "profile": "main"})
        self.assertEqual(out["error"], "forbidden")                                      # 남의 에이전트에는 주소를 만들지 않는다

    def test_전송_주소_거절(self):
        from aas.auth import mcp_transfers, tokens
        row = tokens.lookup(self.all_raw)
        key = mcp_transfers.create(row, "skill", "up", "mcp-a", {"profile": "main"})
        url = f"/mcp/transfer/{key}"
        r, out = self.raw("PUT", "/mcp/transfer/nope", b"x")
        self.assertEqual(r.status, 404)
        r, out = self.raw("PUT", url, b"x", {"Origin": "http://evil.example"})
        self.assertEqual(r.status, 403)
        r, out = self.raw("PUT", url, b"x" * 10, {"Content-Length": str(10 ** 9)})
        self.assertEqual((r.status, out["reason"]), (413, "too_large"))                # 한도를 넘는 길이는 읽지 않는다
        key = mcp_transfers.create(row, "skill", "up", "mcp-a", {"profile": "main"})
        with mcp_transfers._conn() as conn:
            conn.execute("UPDATE mcp_transfers SET expires=? WHERE key_hash=?", (time.time() - 1, mcp_transfers._hash(key)))
        r, out = self.raw("PUT", f"/mcp/transfer/{key}", self.skill_zip())
        self.assertEqual((r.status, out["reason"]), (410, "expired"))
        view, raw = tokens.issue({"email": ALICE}, "tmp", "read", 7)                    # 범위에 skills:write 가 없다
        key = mcp_transfers.create(tokens.lookup(raw), "skill", "up", "mcp-a", {"profile": "main"})
        r, out = self.raw("PUT", f"/mcp/transfer/{key}", self.skill_zip())
        self.assertEqual((r.status, out["reason"]), (403, "scope"))
        key = mcp_transfers.create(tokens.lookup(raw), "answer", "down", "mcp-a", {}, "hello")
        tokens.revoke(view["id"], ALICE)                                                  # 주소를 만든 뒤 연결을 끊었다
        r, out = self.raw("GET", f"/mcp/transfer/{key}")
        self.assertEqual((r.status, out["reason"]), (401, "revoked"))

    def test_긴_답은_받기_주소로_전체를(self):
        hub = self.hubs["mcp-a"]
        err, start = self.call("chat_start", {"pod": "mcp-a", "profile": "main"})
        sid = start["session_id"]
        long = "보고서 " * 6000
        hub.push(sid, "message.start", {})
        hub.push(sid, "message.complete", {"text": long, "status": "complete"})
        hub.push(sid, "aas.files", {"turn": 1, "files": []})
        err, got = self.call("chat_wait", {"pod": "mcp-a", "session_id": sid, "after": 0, "timeout": 5})
        self.assertTrue(got["truncated"])
        self.assertNotIn("_full", got)
        r, body = self.raw("GET", got["full_answer"]["url"])
        self.assertEqual((r.status, body.decode()), (200, long))
        self.assertIn("--create-dirs -o aas-files/answer.md", got["full_answer"]["command"])   # 로컬 파일을 덮지 않게 따로

    def test_스킬_폴더_zip_받기(self):
        import io
        import zipfile
        from aas.auth import mcp_transfers, tokens
        folder = Path(TMP.name) / "mcp_home_a" / "profiles" / "main" / "skills" / "demo"
        folder.mkdir(parents=True, exist_ok=True)
        (folder / "SKILL.md").write_text("---\nname: demo\ndescription: d\n---\n")
        (folder / "run.py").write_text("print('hi')\n")
        key = mcp_transfers.create(tokens.lookup(self.all_raw), "skill", "down", "mcp-a", {"profile": "main", "path": "skills/demo"})
        r, body = self.raw("GET", f"/mcp/transfer/{key}")
        self.assertEqual(r.status, 200)
        self.assertEqual(sorted(zipfile.ZipFile(io.BytesIO(body)).namelist()), ["SKILL.md", "run.py"])

    def test_스킬_보기는_이름으로도_찾고_본문을_준다(self):
        """2026-10-28 OKE 에서 Claude Code 가 skill_get(id=이름) 으로 「없는 스킬」을 받고, 본문이 없어 skill_file_read 를 따로 불렀다."""
        home = Path(TMP.name) / "mcp_home_a" / "profiles"
        for prof in ("main", "side"):
            folder = home / prof / "skills" / "twin"
            folder.mkdir(parents=True, exist_ok=True)
            (folder / "SKILL.md").write_text(f"---\nname: twin\ndescription: d\n---\n\nbody-{prof}\n")
        for k in [k for k in self.server._cache if k.startswith("mcp-a:skills")]:   # 언어별 키(앞 시험이 만든 300초 캐시)
            self.server._cache.pop(k, None)         # 앞 시험이 만든 스킬 목록 캐시(300초)
        err, out = self.call("skill_get", {"pod": "mcp-a", "id": "twin", "profile": "side"})
        self.assertFalse(err, out)
        self.assertEqual((out["name"], out["profile"]), ("twin", "side"))
        self.assertIn("body-side", out["skill_md"]["text"])
        self.assertRegex(out["skill_md"]["sha"], "^[0-9a-f]{64}$")
        self.assertEqual(out["skill_md"]["path"], "profiles/side/skills/twin/SKILL.md")
        err, again = self.call("skill_get", {"pod": "mcp-a", "id": out["id"]})          # skills_list 의 id 도 그대로 된다
        self.assertFalse(err, again)
        self.assertIn("body-side", again["skill_md"]["text"])
        err, out = self.call("skill_get", {"pod": "mcp-a", "id": "twin"})               # 두 프로파일에 같은 이름: 고르게 한다
        self.assertEqual(out["error"], "invalid")
        self.assertIn("profile", out["message"])
        err, out = self.call("skill_get", {"pod": "mcp-a", "id": "no-such-skill"})
        self.assertEqual(out["error"], "invalid")

    def test_비밀값_올리기_명령은_값을_읽지_않는다(self):
        err, out = self.call("env_upload_command", {"pod": "mcp-a", "profile": "main", "name": "OPENWEATHER_API_KEY",
                                                    "source_env": "MY_KEY"})
        self.assertFalse(err, out)
        self.assertTrue(out["command"].startswith('printf %s "${MY_KEY}" | curl '), out["command"])
        self.assertIn("--data-binary @-", out["command"])
        err, out = self.call("env_upload_command", {"pod": "mcp-a", "profile": "main", "name": "OPENWEATHER_API_KEY",
                                                    "source_file": "~/.config/aas/keys/weather"})
        self.assertIn("--data-binary @'~/.config/aas/keys/weather'", out["command"])
        for bad in ({"name": "lower"}, {"name": "OK_NAME"}, {"name": "OK_NAME", "source_env": "A", "source_file": "b"}):
            err, out = self.call("env_upload_command", {"pod": "mcp-a", "profile": "main", **bad})
            self.assertEqual(out["error"], "invalid", bad)
        err, out = self.call("credential_upload_command", {"pod": "mcp-a", "profile": "main", "slot": "../etc", "source_file": "a.json"})
        self.assertEqual(out["error"], "invalid")
        err, out = self.call("credential_upload_command", {"pod": "mcp-a", "profile": "main", "slot": "secret:svc", "source_file": "sa.json"})
        self.assertFalse(err, out)
        self.assertLessEqual(out["max_bytes"], 64 * 1024)

    def test_비밀값_값은_기록에_남지_않는다(self):
        from aas.auth import mcp_transfers, tokens
        from aas.common import store
        sent = []

        def act(pod, body, who):                          # Hermes 대신 받는다 — 경로·권한 검사는 지금 화면 그대로
            sent.append(dict(body))
            return {"ok": True}
        key = mcp_transfers.create(tokens.lookup(self.all_raw), "env", "up", "mcp-a", {"profile": "main", "name": "WEATHER_KEY"})
        with mock.patch.object(self.server, "_profile_action", act):
            r, out = self.raw("PUT", f"/mcp/transfer/{key}", b"sk-very-secret-123\n")
        self.assertEqual(r.status, 200, out)
        self.assertEqual(out, {"ok": True, "name": "WEATHER_KEY", "profile": "main"})
        self.assertEqual((sent[0]["action"], sent[0]["target"], sent[0]["value"], sent[0]["name"]),
                         ("env_set", "WEATHER_KEY", "sk-very-secret-123", "main"))       # 끝 줄바꿈 하나는 뗀다
        with store.connect() as conn:                     # 다른 시험의 기록도 같은 표에 쌓인다 — 시각 순 앞 몇 줄이 아니라 내용으로 찾는다
            leaked = conn.execute("SELECT COUNT(*) AS n FROM usage WHERE note LIKE ?", ("%sk-very-secret%",)).fetchone()["n"]
            notes = [r["note"] for r in conn.execute("SELECT note FROM usage WHERE kind='mcp_transfer'").fetchall()]
        self.assertEqual(leaked, 0)
        self.assertIn(f"{ALICE} up env pod=mcp-a name=WEATHER_KEY status=200 via=token", notes)

    def test_M2_봇_토큰은_채널_저장으로_값은_기록에_없다(self):
        """M2 ④: 주인은 채널 변수를 env_set 으로 못 넣는다. 1회용 전송(kind=channel)이 화면의 채널 저장(channel_save)으로 보낸다."""
        from aas.auth import mcp_transfers, tokens
        from aas.common import store
        sent = []

        def act(pod, body, who):
            sent.append(dict(body))
            return {"ok": True}
        err, out = self.call("channel_token_upload_command", {"pod": "mcp-a", "profile": "main", "platform": "telegram",
                                                              "name": "TELEGRAM_BOT_TOKEN", "source_env": "MY_BOT"})
        self.assertFalse(err, out)
        self.assertIn('printf %s "${MY_BOT}"', out["command"])                             # 값이 아니라 변수 이름만
        key = mcp_transfers.create(tokens.lookup(self.all_raw), "channel", "up", "mcp-a",
                                   {"profile": "main", "platform": "telegram", "name": "TELEGRAM_BOT_TOKEN"})
        with mock.patch.object(self.server, "_profile_action", act):
            r, body = self.raw("PUT", f"/mcp/transfer/{key}", b"123:bot-secret-xyz\n")
        self.assertEqual(r.status, 200, body)
        self.assertEqual((sent[0]["action"], sent[0]["platform"], sent[0]["env"]),
                         ("channel_save", "telegram", {"TELEGRAM_BOT_TOKEN": "123:bot-secret-xyz"}))
        with store.connect() as conn:
            leaked = conn.execute("SELECT COUNT(*) AS n FROM usage WHERE note LIKE ?", ("%bot-secret-xyz%",)).fetchone()["n"]
        self.assertEqual(leaked, 0)

    def test_M2_채널_도구(self):
        calls = []

        async def fake(ctx, method, path, pod="", query=None, body=None):
            calls.append((method, path, query, body))
            return {"ok": True}
        with mock.patch.object(self.mcp.Ctx, "call", fake):
            self.call("channel_list", {"pod": "mcp-a", "profile": "main"})
            self.assertEqual(calls[-1][:3], ("GET", "/api/channels/platforms", {"pod": "mcp-a", "profile": "main"}))
            err, out = self.call("channel_save", {"pod": "mcp-a", "profile": "main", "platform": "telegram",
                                                  "env": {"TELEGRAM_BOT_TOKEN": "x"}})
            self.assertEqual(out["error"], "invalid")                                     # 토큰은 값이 대화에 남지 않는 길로
            self.call("channel_save", {"pod": "mcp-a", "profile": "main", "platform": "telegram",
                                       "env": {"TELEGRAM_ALLOWED_USERS": "12345"}, "enabled": True})
            self.assertEqual(calls[-1][3], {"pod": "mcp-a", "action": "channel_save", "name": "main", "platform": "telegram",
                                            "env": {"TELEGRAM_ALLOWED_USERS": "12345"}, "enabled": True})
            err, out = self.call("channel_test", {"pod": "mcp-a", "profile": "main", "platform": "whatsapp"})
            self.assertEqual(out["error"], "invalid")
            self.call("pairing_answer", {"pod": "mcp-a", "profile": "main", "platform": "telegram", "op": "approve", "request_id": "r1"})
            self.assertEqual((calls[-1][3]["action"], calls[-1][3]["request_id"]), ("pairing_approve", "r1"))

    def test_M2_마켓_도구(self):
        calls = []

        async def fake(ctx, method, path, pod="", query=None, body=None):
            calls.append((method, path, query, body))
            if path == "/api/market":
                return {"packages": [{"namespace": "free", "name": "weather", "summary": "날씨 알림", "version": "1.0.0", "inner": "x",
                                      "auto_versions": [{"version": "1.0.0", "by": "kim"}]},
                                     {"namespace": "team", "name": "report", "summary": "주간 보고", "version": "2.0.0"}], "can_install": True}
            return {"ok": True, "request": {"id": "r1"}}
        with mock.patch.object(self.mcp.Ctx, "call", fake):
            err, out = self.call("market_list", {"pod": "mcp-a", "query": "날씨"})
            self.assertFalse(err, out)
            self.assertEqual((out["total"], out["packages"]), (1, [{"namespace": "free", "namespace_label": "shared", "name": "weather", "summary": "날씨 알림",
                                                                  "version": "1.0.0", "auto_versions": [{"version": "1.0.0", "by": "kim"}]}]))
            err, out = self.call("market_list", {"pod": "mcp-a", "query": "shared"})                # 표시 이름으로 찾는다(스펙 2026-10-28-010 D11)
            self.assertEqual([p["name"] for p in out["packages"]], ["weather"])
            err, out = self.call("market_list", {"pod": "mcp-a"})
            self.assertEqual([p["namespace_label"] for p in out["packages"]], ["shared", "team"])     # 표에 없는 slug 는 그대로
            r, res = self.post({"jsonrpc": "2.0", "id": 8, "method": "tools/call", "params": {"name": "market_list", "arguments": {"pod": "mcp-a"}}},
                               self.all_raw, self.session(), {"Accept-Language": "ko"})           # 한국어를 보낸 클라이언트는 한국어 이름(§6-3). 없으면 영어(위)
            self.assertEqual([p["namespace_label"] for p in json.loads(res["result"]["content"][0]["text"])["packages"]], ["공용", "team"])
            err, out = self.call("market_install", {"pod": "mcp-a", "profile": "main", "namespace": "free", "name": "weather"})
            self.assertEqual(calls[-1][1:], ("/api/market/install", None, {"pod": "mcp-a", "profile": "main", "namespace": "free", "name": "weather",
                                                                         "version": "", "mode": "install"}))
            self.assertIn("NEW chat", out["next"])
            err, out = self.call("market_publish", {"pod": "mcp-a", "profile": "main", "path": "profiles/main/skills/hello", "name": "hello", "version": "1.0.0"})
            self.assertEqual(calls[-1][1], "/api/market/publish")
            self.assertIn("admin", out["next"])
            self.assertEqual(calls[-1][3]["namespace"], "")

        async def auto(ctx, method, path, pod="", query=None, body=None):
            return {"ok": True, "request": {"id": "r2", "auto": "pending", "auto_namespace": "paid", "auto_namespace_label": "restricted"}}
        with mock.patch.object(self.mcp.Ctx, "call", auto):
            err, out = self.call("market_publish", {"pod": "mcp-a", "profile": "main", "path": "skills/hello", "name": "hello", "version": "1.0.0"})
        self.assertIn("without admin review", out["next"])
        self.assertIn("publishing to restricted", out["next"])

        async def status(ctx, method, path, pod="", query=None, body=None):
            return {"items": [{"id": "r3", "namespace": "paid", "want_namespace": "free"}, {"id": "r4", "namespace": "", "want_namespace": ""}],
                    "namespace_labels": {"free": "shared", "paid": "restricted"}, "admin": False, "can": True}
        with mock.patch.object(self.mcp.Ctx, "call", status):
            err, out = self.call("market_publish_status", {"pod": "mcp-a"})
        self.assertFalse(err, out)
        self.assertEqual([(r["namespace_label"], r["want_namespace_label"]) for r in out["items"]], [("restricted", "shared"), ("", "")])
        self.assertIn("namespace_label", self.mcp.TOOLS["market_list"]["spec"]["description"])

    def test_파일_받기는_지원하지_않는_서버면_unavailable(self):
        err, out = self.call("file_get", {"pod": "mcp-a", "path": "uploads/a.txt"})
        self.assertEqual((out["error"], out["message"]), ("unavailable", "unsupported"))
        err, out = self.call("file_put", {"pod": "mcp-a", "name": "a.txt", "source": "./a.txt"})
        self.assertFalse(err, out)
        self.assertIn("--data-binary @./a.txt", out["command"])


    # ---- 쓰기 도구(T5c) --------------------------------------------------------------------------
    def test_비밀값_넣기_지우기는_화면의_프로파일_바꾸기로(self):
        from aas.common import store
        sent = []

        def act(pod, body, who):
            sent.append((pod.id, {k: v for k, v in body.items() if not k.startswith("_")}))
            return {"ok": True}
        with mock.patch.object(self.server, "_profile_action", act):
            err, out = self.call("secret_set", {"pod": "mcp-a", "profile": "main", "name": "WEATHER_KEY", "value": "sk-inline-777"})
            self.assertEqual((err, out), (False, {"ok": True, "name": "WEATHER_KEY", "profile": "main"}))   # 값은 돌려주지 않는다
            err, out = self.call("secret_clear", {"pod": "mcp-a", "profile": "main", "name": "WEATHER_KEY", "confirm": "WEATHER_KEY"})
            self.assertFalse(err, out)
            err, out = self.call("skill_toggle", {"pod": "mcp-a", "profile": "main", "name": "demo", "enabled": False})
            self.assertFalse(err, out)
            err, out = self.call("skill_toggle", {"pod": "mcp-a", "profile": "main", "name": "demo", "enabled": "no"})
            self.assertEqual(out["error"], "invalid")
            err, out = self.call("secret_set", {"pod": "mcp-c", "profile": "main", "name": "WEATHER_KEY", "value": "x"})
            self.assertEqual(out["error"], "forbidden")                                  # 남의 에이전트
        self.assertEqual([b["action"] for _, b in sent], ["env_set", "env_clear", "skill"])
        self.assertEqual(sent[0], ("mcp-a", {"pod": "mcp-a", "action": "env_set", "name": "main", "target": "WEATHER_KEY",
                                             "value": "sk-inline-777"}))
        self.assertEqual(sent[2][1]["enabled"], False)
        with store.connect() as conn:
            leaked = conn.execute("SELECT COUNT(*) AS n FROM usage WHERE note LIKE ?", ("%sk-inline%",)).fetchone()["n"]
        self.assertEqual(leaked, 0)

    def test_화면_링크(self):
        err, out = self.call("secret_request", {"pod": "mcp-a", "profile": "main", "names": ["A_KEY", "B_KEY"]})
        self.assertEqual(out["links"][0]["url"],
                         f"http://127.0.0.1:{self.port}/#/profiles?pod=mcp-a&name=main&pane=env&key=A_KEY")
        err, out = self.call("secret_request", {"pod": "mcp-a", "profile": "main", "names": ["bad name"]})
        self.assertEqual(out["error"], "invalid")
        err, out = self.call("credential_request", {"pod": "mcp-a", "profile": "main", "slot": "secret:svc"})
        self.assertTrue(out["url"].endswith("pane=env&file=secrets%2Fsvc.json"), out["url"])

    def test_인증_파일_넣기_지우기(self):
        err, out = self.call("credential_set", {"pod": "mcp-a", "profile": "main", "slot": "secret:svc", "json": {"type": "x"}})
        self.assertEqual((out["error"], out["message"]), ("unavailable", "unsupported"))   # 지금 경로의 거절 그대로(쿠버네티스에서만)
        err, out = self.call("credential_clear", {"pod": "mcp-a", "profile": "main", "slot": "secret:svc", "confirm": "secret:other"})
        self.assertEqual(out["error"], "invalid")
        err, out = self.call("credential_set", {"pod": "mcp-a", "profile": "main", "slot": "secret:svc", "json": "x" * 70000})
        self.assertEqual(out["error"], "invalid")

    def test_스킬_파일_읽고_고치기(self):
        folder = Path(TMP.name) / "mcp_home_a" / "profiles" / "main" / "skills" / "edit-me"
        folder.mkdir(parents=True, exist_ok=True)
        (folder / "SKILL.md").write_text("---\nname: edit-me\ndescription: d\n---\n\nold\n")
        rel = "profiles/main/skills/edit-me/SKILL.md"
        err, got = self.call("skill_file_read", {"pod": "mcp-a", "path": rel})
        self.assertFalse(err, got)
        self.assertRegex(got["sha"], "^[0-9a-f]{64}$")
        saved = []

        def sender(pod):
            def send(rel_, current, content):                 # files.save 가 부르는 꼴(rel, 지금 내용, 새 내용)
                saved.append((rel_, content))
                (Path(TMP.name) / "mcp_home_a" / rel_).write_text(content)
            return send
        with mock.patch.object(self.server, "_skill_sender", sender):
            err, out = self.call("skill_update", {"pod": "mcp-a", "path": rel, "content": "---\nname: edit-me\ndescription: d\n---\n\nnew\n",
                                                  "base_sha": "0" * 64})
            self.assertEqual(out["error"], "busy")                                       # 그 사이 바뀐 판(409)
            err, out = self.call("skill_update", {"pod": "mcp-a", "path": rel, "content": "---\nname: edit-me\ndescription: d\n---\n\nnew\n"})
            self.assertFalse(err, out)
        self.assertTrue(saved and saved[-1][1].endswith("new\n"), saved)
        err, out = self.call("skill_update", {"pod": "mcp-c", "path": rel, "content": "x"})
        self.assertEqual(out["error"], "forbidden")

    def test_새_스킬_만들기(self):
        calls = []

        class API:
            def __init__(self, auth):
                pass

            def call(self, method, path, body=None, query=None, **kw):
                calls.append((method, path, body))
                return {}
        self.hubs["mcp-a"].auth = None
        with mock.patch.object(self.server, "HermesAPI", API):
            err, out = self.call("skill_create", {"pod": "mcp-a", "profile": "main", "name": "weekly-report",
                                                  "description": "주간 보고서를 만든다", "body": "# 주간 보고\n"})
            self.assertFalse(err, out)
            err, out = self.call("skill_create", {"pod": "mcp-a", "profile": "main", "name": "Bad Name", "description": "d"})
            self.assertEqual(out["error"], "invalid")
        post = next(c for c in calls if c[:2] == ("POST", "/api/skills"))
        self.assertEqual((post[2]["name"], post[2]["profile"]), ("weekly-report", "main"))
        self.assertIn("description: \"주간 보고서를 만든다\"", post[2]["content"])

    def test_토큰_바꾸기(self):
        from aas.auth import tokens
        view, raw = tokens.issue({"email": ALICE, "sub": "s"}, "ci", "skill-dev", 30)
        err, out = self.call("token_rotate", {"days": 7}, raw)
        self.assertFalse(err, out)
        new = out["token"]
        self.assertTrue(new.startswith("aas_pat_"))
        self.assertNotEqual(new, raw)
        self.assertEqual(self.post({"jsonrpc": "2.0", "id": 1, "method": "initialize"}, new)[0].status, 200)
        old = tokens.lookup(raw)
        self.assertLessEqual(old["expires"], time.time() + tokens.ROTATE_GRACE + 1)       # 옛 토큰은 1시간 뒤 끝난다
        fresh = tokens.lookup(new)
        self.assertEqual((fresh["name"], fresh["bundle"]), ("ci", "skill-dev"))
        self.assertLess(fresh["expires"], time.time() + 8 * 86400)
        err, out = self.call("token_rotate", {"days": 3}, new)
        self.assertEqual(out["error"], "invalid")
        with self.assertRaises(tokens.TokenError):                                      # OAuth 연결은 refresh 로 바뀐다
            tokens.rotate({**fresh, "kind": "oauth"})
        tokens.revoke(fresh["id"], ALICE)
        tokens.revoke(view["id"], ALICE)


class ErrorWordTest(unittest.TestCase):
    def test_502_는_안내_문장을_넘기고_500_은_넘기지_않는다(self):
        from aas.web import mcp_server
        with self.assertRaises(mcp_server.ToolError) as cm:
            mcp_server._ok(502, {"error": "Hermes 가 저장했다고 답했지만 파일이 그대로입니다"})
        self.assertEqual((cm.exception.word, cm.exception.message), ("unavailable", "Hermes 가 저장했다고 답했지만 파일이 그대로입니다"))
        with self.assertRaises(mcp_server.ToolError) as cm:
            mcp_server._ok(500, {"error": "KeyError: 'secret'"})
        self.assertEqual((cm.exception.word, cm.exception.message), ("unavailable", ""))


class SummaryTest(unittest.TestCase):
    def test_긴_답은_앞부분만(self):
        from aas.web import mcp_server
        events = [{"seq": 1, "type": "message.start", "payload": {}},
                  {"seq": 2, "type": "message.complete", "payload": {"text": "가" * 10000, "status": "complete"}}]
        out = mcp_server.summarize(events)
        self.assertTrue(out["truncated"])
        self.assertEqual(out["length"], 30000)
        self.assertLessEqual(len(out["text"].encode()), mcp_server.TEXT_MAX)

    def test_오류와_끊김(self):
        from aas.web import mcp_server
        self.assertEqual(mcp_server.summarize([{"seq": 1, "type": "error", "payload": {"message": "quota"}}])["error"], "quota")
        self.assertEqual(mcp_server.summarize([{"seq": 1, "type": "aas.disconnected", "payload": {}}])["state"], "disconnected")
        out = mcp_server.summarize([{"seq": 1, "type": "message.delta", "payload": {"text": "a"}},
                                    {"seq": 2, "type": "message.delta", "payload": {"text": "b"}}])
        self.assertEqual((out["state"], out["text"]), ("running", "ab"))

    def test_세션_번호_서명(self):
        from aas.auth import mcp_limits
        sid = mcp_limits.session_id("fam1", now=100)
        self.assertEqual(mcp_limits.session_family(sid), "fam1")
        self.assertIsNone(mcp_limits.session_family(sid.replace("fam1", "fam2")))
        self.assertIsNone(mcp_limits.session_family("fam1.100"))
        self.assertIsNone(mcp_limits.session_family(""))


if __name__ == "__main__":
    unittest.main()

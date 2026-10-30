# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""MCP 서버 OAuth 로그인 중개(aas/ops/mcp_oauth_relay.py)와 경로(/oauth/mcp/start·/oauth/mcp/callback·/api/mcp/oauth/*)를 시험한다
(스펙 2026-10-16-010 4-1~4-4·11-4·14절, OMAI-1263). Hermes 는 대역이다(실제 흐름은 deploy/compose/verify-oauth.py 가 본다).
"""
import aasserver  # 실제 uvicorn 앱을 띄우는 시험 하네스(OMAI-1100)
import http.client
import json
import os
import tempfile
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock
from urllib.parse import parse_qs, urlencode, urlsplit

TMP = tempfile.TemporaryDirectory()
os.environ.setdefault("AAS_DATA_DIR", str(Path(TMP.name) / "data"))

from aas.common import i18n, store  # noqa: E402
from aas.hermes.hermes_api import HermesError  # noqa: E402
from aas.ops import mcp_oauth_relay as relay  # noqa: E402

PUBLIC = "https://aas.example.com"
CALLBACK = PUBLIC + "/oauth/mcp/callback"


class FakeHermes:
    """Hermes 대시보드의 MCP 부분: 설정 원본, 흐름 시작·상태·취소, 공개 콜백."""

    def __init__(self):
        self.servers = {"jira": {"url": "https://mcp.example.com/mcp", "auth": "oauth", "enabled": True},
                        "hdr": {"url": "https://mcp.example.com/mcp", "headers": {"Authorization": "Bearer ${MCP_HDR_API_KEY}"}}}
        self.flows: dict = {}
        self.calls: list = []
        self.start_result = None          # dict 면 그대로 돌려준다(status:error 흉내), HermesError 면 던진다
        self.auth_scheme = "https"

    def call(self, method, path, body=None, query=None, timeout=30):
        self.calls.append((method, path, dict(query or {})))
        if method == "GET" and path == "/api/config":
            return {"mcp_servers": json.loads(json.dumps(self.servers))}
        if method == "PUT" and path == "/api/mcp/servers":
            self.servers = json.loads(json.dumps(body["servers"]))
            return {"ok": True}
        if method == "POST" and path.endswith("/auth"):
            if isinstance(self.start_result, list):              # 차례대로 쓰고, 다 쓰면 정상 시작
                nxt = self.start_result.pop(0) if self.start_result else None
                if isinstance(nxt, Exception):
                    raise nxt
            elif isinstance(self.start_result, Exception):
                raise self.start_result
            if isinstance(self.start_result, dict):
                return self.start_result
            name = path.split("/")[4]
            fid, state = f"f{len(self.flows) + 1}", f"st{len(self.flows) + 1}x"
            redirect = (self.servers[name].get("oauth") or {}).get("redirect_uri")
            self.flows[fid] = {"server": name, "state": state, "status": "authorization_required", "iss": None}
            url = f"{self.auth_scheme}://idp.example.com/authorize?" + urlencode({"state": state, "redirect_uri": redirect, "code_challenge": "c"})
            return {"flow_id": fid, "status": "authorization_required", "authorization_url": url}
        if path.startswith("/api/mcp/oauth/flows/"):
            fid = path.rsplit("/", 1)[1]
            if fid not in self.flows:
                raise HermesError("OAuth flow not found or expired", 404)
            if method == "DELETE":
                self.flows[fid]["status"] = "error"
                return {"ok": True}
            f = self.flows[fid]
            return {"flow_id": fid, "status": f["status"], "error": None, "tools": [{"name": "whoami"}] if f["status"] == "approved" else []}
        raise AssertionError(f"예상하지 못한 호출: {method} {path}")

    def call_text(self, method, path, query=None, timeout=30):
        self.calls.append(("CB", path, dict(query or {})))
        flow = next((f for f in self.flows.values() if f["state"] == (query or {}).get("state") and f["status"] == "authorization_required"), None)
        if flow is None:
            return 404, "<h1>OAuth flow expired</h1>"
        if (query or {}).get("error"):
            flow["status"] = "error"
            return 400, "<h1>Authorization failed</h1>"
        flow["status"], flow["iss"] = "approved", (query or {}).get("iss")
        return 200, "<h1>Authorization received</h1>"


ALICE = {"sub": "sub-alice", "email": "alice@example.com"}
BOB = {"sub": "sub-bob", "email": "bob@example.com"}


def wipe():
    from aas.assets import files
    with store.connect() as conn:
        conn.execute(relay.SCHEMA)
        conn.execute(files.VERSION_SCHEMA)
        conn.execute("DELETE FROM mcp_oauth_relays")
        conn.execute("DELETE FROM file_versions WHERE pod LIKE ?", ("relay-%",))


class RelayUnitTest(unittest.TestCase):
    def setUp(self):
        i18n.set_lang("ko")
        wipe()
        self.api = FakeHermes()

    def tearDown(self):
        wipe()

    def start(self, server="jira", user=ALICE, **kw):
        return relay.start(self.api, pod="relay-p", profile="main", prof="main", server=server, user=user, public_url=PUBLIC, **kw)

    def test_start_writes_the_aas_callback_and_records_state(self):
        out = self.start()
        self.assertEqual(self.api.servers["jira"]["oauth"], {"redirect_uri": CALLBACK, "application_type": "web", "timeout": 600})   # R1·R5
        # 대시보드 흐름은 연결 한 번이 connect_timeout(기본 60초)을 넘으면 다시 시도하며 state 를 바꾼다 — 콜백 대기(300초)만큼 늘린다(14-8)
        self.assertEqual(self.api.servers["jira"]["connect_timeout"], relay.LOGIN_CONNECT_TIMEOUT)
        q = parse_qs(urlsplit(out["authorization_url"]).query)
        self.assertEqual((q["redirect_uri"][0], out["host"], out["insecure"]), (CALLBACK, "idp.example.com", False))
        row = relay.by_state(out["state"])
        self.assertEqual((row["user_sub"], row["profile"], row["server"], row["status"]), ("sub-alice", "main", "jira", "pending"))
        writes = [c for c in self.api.calls if c[0] == "PUT"]
        self.start()
        self.assertEqual(len([c for c in self.api.calls if c[0] == "PUT"]), len(writes))   # 이미 맞으면 다시 쓰지 않는다

    def test_longer_connect_timeout_is_kept(self):
        self.api.servers["jira"]["connect_timeout"] = 900
        self.start()
        self.assertEqual(self.api.servers["jira"]["connect_timeout"], 900)

    def test_restart_cancels_the_unfinished_flow(self):
        first = self.start()
        second = self.start()
        self.assertIn(("DELETE", "/api/mcp/oauth/flows/f1", {}), self.api.calls)            # R4: 이전 흐름을 Hermes 에서 취소
        self.assertEqual(relay.by_state(first["state"])["status"], "cancelled")
        with self.assertRaises(relay.RelayError) as ctx:
            relay.claim(first["state"], ALICE)
        self.assertEqual(ctx.exception.reason, "superseded")
        self.assertEqual(relay.by_state(second["state"])["status"], "pending")

    def test_start_failures_are_mapped(self):
        self.api.start_result = {"flow_id": "x", "status": "error", "error": "Could not discover OAuth metadata", "authorization_url": None}
        with self.assertRaises(relay.RelayError) as ctx:
            self.start()
        self.assertEqual(ctx.exception.reason, "unreachable")
        self.assertIn("인가 서버에 닿지 않", str(ctx.exception))
        for exc, reason in ((HermesError("MCP OAuth for 'jira' is already in progress", 409), "busy"),
                            (HermesError("Too many", 429), "busy"), (HermesError("missing", 404), "not_found")):
            self.api.start_result = exc
            with mock.patch.object(relay, "BUSY_RETRY_SECONDS", 0.05), mock.patch.object(relay, "BUSY_RETRY_EVERY", 0.01):
                with self.assertRaises(relay.RelayError) as ctx:
                    self.start()
            self.assertEqual(ctx.exception.reason, reason)

    def test_busy_right_after_a_cancel_is_retried(self):
        # 취소한 흐름의 작업자가 첫 연결 재시도를 마칠 때까지 Hermes 가 몇 초 409 를 준다(14-10). 잠시 기다렸다 다시 시작한다
        busy = HermesError("MCP OAuth for 'jira' is already in progress", 409)
        self.api.start_result = [busy, busy]
        with mock.patch.object(relay, "BUSY_RETRY_EVERY", 0.01):
            out = self.start()
        self.assertTrue(out["authorization_url"])
        self.assertEqual(len([c for c in self.api.calls if c[0] == "POST" and c[1].endswith("/auth")]), 3)

    def test_header_server_must_be_switched_first(self):
        with self.assertRaises(relay.RelayError) as ctx:
            self.start(server="hdr")
        self.assertEqual((ctx.exception.code, ctx.exception.reason), (409, "header_auth"))
        self.assertIn("headers", self.api.servers["hdr"])                                      # 아무것도 쓰지 않았다

    def test_http_authorization_url_needs_the_setting(self):
        self.api.auth_scheme = "http"
        with mock.patch.dict(os.environ, {"AAS_MCP_OAUTH_ALLOW_HTTP": ""}):
            with self.assertRaises(relay.RelayError) as ctx:
                self.start()
            self.assertEqual(ctx.exception.reason, "insecure_authorization_url")
            self.assertIn(("DELETE", "/api/mcp/oauth/flows/f1", {}), self.api.calls)      # Hermes 에 남은 흐름을 취소한다(다음 시작이 409 에 걸리지 않게)
        with mock.patch.dict(os.environ, {"AAS_MCP_OAUTH_ALLOW_HTTP": "on"}):
            self.assertTrue(self.start()["insecure"])                                          # V18: 허용하면 열고 경고를 보인다

    def test_claim_refuses_missing_unknown_used_expired_and_other_user(self):
        cases = []
        for state, user, prep in (("", ALICE, None), ("nope", ALICE, None)):
            with self.assertRaises(relay.RelayError) as ctx:
                relay.claim(state, user)
            cases.append(ctx.exception.reason)
        self.assertEqual(cases, ["missing_state", "unknown_state"])
        s = self.start()["state"]
        with self.assertRaises(relay.RelayError) as ctx:
            relay.claim(s, BOB)
        self.assertEqual(ctx.exception.reason, "other_user")
        self.assertEqual(relay.by_state(s)["status"], "pending")                              # 다른 사용자는 기록을 태우지 못한다
        self.assertEqual(relay.claim(s, ALICE)["state"], s)
        with self.assertRaises(relay.RelayError) as ctx:
            relay.claim(s, ALICE)
        self.assertEqual(ctx.exception.reason, "used")                                         # 일회용
        old = self.start()["state"]
        with store.connect() as conn:
            conn.execute("UPDATE mcp_oauth_relays SET created_at=? WHERE state=?", (time.time() - relay.RECORD_TTL - 1, old))
        with self.assertRaises(relay.RelayError) as ctx:
            relay.claim(old, ALICE)
        self.assertEqual(ctx.exception.reason, "expired")                                      # R7: 660초

    def test_deliver_passes_iss_and_status_records_success(self):
        s = self.start()["state"]
        row = relay.claim(s, ALICE)
        out = relay.deliver(self.api, row, code="c1", state=s, error="", iss="https://idp.example.com/realms/r")
        self.assertTrue(out["ok"])
        cb = [c for c in self.api.calls if c[0] == "CB"][-1]
        self.assertEqual(cb[1], "/api/mcp/oauth/callback/jira")
        self.assertEqual(cb[2], {"code": "c1", "state": s, "error": "", "iss": "https://idp.example.com/realms/r"})   # 14-3: iss 를 그대로 넘긴다
        st = relay.status(self.api, relay.by_state(s))
        self.assertEqual((st["status"], st["tools"]), ("approved", 1))
        self.assertIsNotNone(relay.last_login_at("relay-p", "main", "jira"))                    # D28 의 기준 시각
        self.assertTrue(relay.recent_login("relay-p", "main", 90))                              # 14-15: 막 로그인한 프로파일
        self.assertFalse(relay.recent_login("relay-p", "other", 90))
        self.assertFalse(relay.recent_login("relay-p", "main", -1))                             # 그보다 오래전
        self.assertEqual(relay.latest_status(self.api, pod="relay-p", profile="main", server="jira")["status"], "approved")

    def test_denied_and_lost_flows(self):
        s = self.start()["state"]
        out = relay.deliver(self.api, relay.claim(s, ALICE), code="", state=s, error="access_denied", iss="")
        self.assertEqual((out["ok"], out["reason"]), (False, "denied"))
        self.assertIn("취소", out["message"])
        s2 = self.start()["state"]
        self.api.flows.clear()                                                                 # Hermes 가 다시 시작해 흐름을 잃었다
        out = relay.deliver(self.api, relay.claim(s2, ALICE), code="c", state=s2, error="", iss="")
        self.assertEqual(out["reason"], "flow_lost")
        self.assertEqual(relay.status(self.api, relay.by_state(s2))["reason"], "flow_lost")

    def test_cancel(self):
        s = self.start()["state"]
        self.assertEqual(relay.cancel(self.api, pod="relay-p", profile="main", server="jira"), 1)
        self.assertEqual(relay.by_state(s)["status"], "cancelled")
        self.assertEqual(relay.status(self.api, relay.by_state(s))["status"], "cancelled")


class LoginStateTest(unittest.TestCase):
    """서버 행 상태 판정(decide·annotate, 11-3·12절 D22·D28·O5·O9)과 그 읽기(token_times·gateway_records)."""

    NOW = 1_800_000_000.0

    def setUp(self):
        i18n.set_lang("ko")
        wipe()

    def tearDown(self):
        wipe()

    def decide(self, entry=None, **kw):
        args = {"url": "https://mcp.example.com/mcp", "token_at": None, "records": None, "pending": None, "ok_at": None,
                "now": self.NOW, "user_sub": "sub-alice"}
        args.update(kw)
        return relay.decide({"name": "jira", "auth": "oauth", "enabled": True, **(entry or {})}, **args)

    def test_state_table(self):
        n = self.NOW
        pending = {"created_at": n - 30, "user_sub": "sub-alice"}
        cases = [
            ("헤더 서버는 상태 없음", {"entry": {"auth": "header"}}, None),
            ("에어갭의 외부 주소", {"url": "https://mcp.example.com/mcp", "_mode": "airgap"}, "unavailable"),
            ("토큰 없음", {}, "login_required"),
            ("꺼진 서버, 토큰 없음", {"entry": {"enabled": False}}, "login_required"),
            ("내가 시작한 흐름", {"pending": pending}, "logging_in"),
            ("흐름보다 늦은 토큰이면 끝난 것", {"pending": pending, "token_at": n - 10, "records": {}}, "unknown"),
            ("오래된 흐름은 무시", {"pending": {"created_at": n - relay.RECORD_TTL - 1, "user_sub": "sub-alice"}}, "login_required"),
            ("꺼짐 · 로그인됨", {"entry": {"enabled": False}, "token_at": n - 100}, "disabled_logged_in"),
            ("옛 이미지(상태 파일 없음)", {"token_at": n - 100, "records": None}, "unknown"),
            ("연결됨", {"token_at": n - 100, "records": {"jira": {"state": "connected", "at": n - 50, "tools": 3}}}, "connected"),
            ("실행 중 인증 실패", {"token_at": n - 100, "records": {"jira": {"state": "auth_failed", "at": n - 50}}}, "reauth_required"),
            ("토큰 거절로 대기", {"token_at": n - 100, "records": {"jira": {"state": "parked_auth", "at": n - 50}}}, "reauth_required"),
            ("연결 실패", {"token_at": n - 100, "records": {"jira": {"state": "failed", "at": n - 50, "error": "connection refused"}}}, "connect_failed"),
            ("로그인 직후 붙기 전", {"token_at": n - 10, "records": {}, "ok_at": n - 10}, "logging_in"),
            # 게이트웨이는 config.yaml 의 바뀜을 60초 주기 작업으로 읽고, 기다리는 서버는 30초마다 다시 본다(Hermes gateway/run.py
            # housekeeping, tools/mcp_tool.py _PARKED_RETRY_INTERVAL). OKE 에서 로그인 뒤 61초에 붙었다(14-18)
            ("게이트웨이 주기 작업을 기다린다", {"token_at": n - 95, "records": {}, "ok_at": n - 95}, "logging_in"),
            # 게이트웨이가 토큰이 생기기 전에 붙여 보고 기다리는 상태로 둔 기록(파드 시계)이 토큰(파드 시계)보다 이르면 지난 기록이다.
            # 로그인 성공(AAS 시계)과 5초 안이라 D28 로는 가리지 못해 「다시 로그인 필요」에서 멈췄다(OKE 2026-10-17, 14-20)
            ("토큰보다 이른 기다림 기록", {"token_at": n - 8, "records": {"jira": {"state": "parked_auth", "at": n - 10}}, "ok_at": n - 7}, "logging_in"),
            ("토큰보다 늦은 인증 실패는 그대로", {"token_at": n - 100, "records": {"jira": {"state": "auth_failed", "at": n - 50}}, "ok_at": n - 52}, "reauth_required"),
        ]
        for label, kw, want in cases:
            with self.subTest(label):
                mode = kw.pop("_mode", "online")
                with mock.patch.dict(os.environ, {"AAS_NETWORK_MODE": mode}):
                    got = self.decide(**kw)
                self.assertEqual(got and got["state"], want)
        self.assertEqual(self.decide(token_at=n, records={"jira": {"state": "connected", "at": n, "tools": 3}})["tools"], 3)
        self.assertFalse(self.decide(pending={"created_at": n - 30, "user_sub": "sub-bob"})["mine"])

    def test_newer_login_ignores_the_old_failure(self):
        n = self.NOW
        failed = {"jira": {"state": "auth_failed", "at": n - 100}}
        # 토큰은 실패보다 이르다(실패 뒤 다시 쓰이지 않았다). 실패보다 늦게 쓰인 토큰은 아래 「토큰보다 이른 기다림 기록」(14-20)
        self.assertEqual(self.decide(token_at=n - 120, records=failed, ok_at=n - 100 + relay.CLOCK_SLACK)["state"], "reauth_required")  # 여유 안
        self.assertEqual(self.decide(token_at=n - 120, records=failed, ok_at=n - 20)["state"], "logging_in")      # 다시 로그인, 붙기 전
        older = {"jira": {"state": "auth_failed", "at": n - relay.CONNECT_GRACE - 50}}                # 실패보다 늦게 로그인했고 유예가 지났다
        self.assertEqual(self.decide(token_at=n - 20, records=older, ok_at=n - relay.CONNECT_GRACE - 1)["state"], "unknown")

    def test_token_times_reads_names_and_times_only(self):
        home = Path(TMP.name) / "ls-home"
        self.assertEqual(relay.token_times(home), {})
        (home / "mcp-tokens").mkdir(parents=True, exist_ok=True)
        for name in ("jira.json", "jira.client.json", "jira.meta.json", "notes.txt"):
            (home / "mcp-tokens" / name).write_text('{"access_token": "secret"}')
        self.assertEqual(list(relay.token_times(home)), ["jira"])

    def test_gateway_records_trust_only_the_running_gateway(self):
        root = Path(TMP.name) / "ls-root"
        root.mkdir(exist_ok=True)
        self.assertIsNone(relay.gateway_records(root))                              # 옛 이미지
        (root / "gateway_state.json").write_text(json.dumps({"pid": 10, "start_time": 5.0}))
        (root / relay.STATUS_FILE).write_text(json.dumps({"pid": 9, "start_time": 4.0, "servers": {"main": {"jira": {"state": "connected"}}}}))
        self.assertIsNone(relay.gateway_records(root))                              # 앞 게이트웨이가 남긴 파일(O5)
        (root / relay.STATUS_FILE).write_text(json.dumps({"pid": 10, "start_time": 5.0, "servers": {"main": {"jira": {"state": "connected"}}}}))
        self.assertEqual(relay.gateway_records(root), {"main": {"jira": {"state": "connected"}}})
        (root / relay.STATUS_FILE).write_text('{"pid": 10, "start')                  # 쓰는 중인 파일
        self.assertIsNone(relay.gateway_records(root))

    def test_annotate_marks_only_oauth_rows_and_sees_the_relay_record(self):
        api = FakeHermes()
        relay.start(api, pod="relay-p", profile="main", prof="main", server="jira", user=ALICE, public_url=PUBLIC)
        rows = [{"name": "jira", "auth": "oauth", "enabled": True}, {"name": "hdr", "auth": "header", "enabled": True}]
        relay.annotate(rows, {"jira": "https://mcp.example.com/mcp"}, pod="relay-p", profile="main", tokens={}, records=None, user=ALICE)
        self.assertEqual(rows[0]["login_state"], {"state": "logging_in", "mine": True})
        self.assertNotIn("login_state", rows[1])
        rows = [{"name": "jira", "auth": "oauth", "enabled": True}]
        relay.annotate(rows, {}, pod="relay-p", profile="main", tokens=None, records=None, user=ALICE)
        self.assertEqual(rows[0]["login_state"]["state"], "unknown")                # 사이드카에 닿지 않음(V3)

    def test_callback_handed_over_counts_as_in_progress(self):
        api = FakeHermes()
        out = relay.start(api, pod="relay-p", profile="main", prof="main", server="jira", user=ALICE, public_url=PUBLIC)
        relay.claim(out["state"], ALICE)                                            # 콜백을 넘김, approved 는 아직 아무도 묻지 않음
        rows = [{"name": "jira", "auth": "oauth", "enabled": True}]
        relay.annotate(rows, {}, pod="relay-p", profile="main", tokens={}, records=None, user=ALICE)
        self.assertEqual(rows[0]["login_state"]["state"], "logging_in")


class LoginInboxTest(unittest.TestCase):
    """받은편지함 「MCP 로그인 필요」(T8·V14·O7·O9): 읽을 때 계산하고, 판정은 decide 하나를 쓴다."""

    def setUp(self):
        i18n.set_lang("ko")
        wipe()
        self.root = Path(tempfile.mkdtemp(dir=TMP.name))
        self.main = self.root / "profiles" / "main"
        self.main.mkdir(parents=True)
        (self.main / "config.yaml").write_text(
            "mcp_servers:\n"
            "  jira:\n    url: https://mcp.example.com/mcp\n    auth: oauth\n"
            "  wiki:\n    url: https://wiki.example.com/mcp\n    auth: oauth\n    enabled: false\n"
            "  hdr:\n    url: https://h.example.com/mcp\n    headers:\n      Authorization: Bearer ${X}\n")
        (self.root / "gateway_state.json").write_text(json.dumps({"pid": 7, "start_time": 1.0}))

    def tearDown(self):
        wipe()

    def items(self):
        return relay.login_items("relay-p", self.root, [("main", self.main)], lambda pod, prof: "도우미")

    def status(self, servers):
        (self.root / relay.STATUS_FILE).write_text(json.dumps({"pid": 7, "start_time": 1.0, "servers": {"main": servers}}))

    def test_old_image_without_status_file_is_skipped(self):
        self.assertEqual(self.items(), [])                                         # O9

    def test_enabled_oauth_server_without_token_needs_login_and_disappears_after_login(self):
        self.status({})
        (item,) = self.items()                                                     # 꺼진 wiki·헤더 hdr 은 없다
        self.assertEqual((item["id"], item["kind"], item["alias"], item["server"], item["reauth"]),
                         ("mcp_login|relay-p|main|jira", "mcp_login", "도우미", "jira", False))
        (self.main / "mcp-tokens").mkdir()
        (self.main / "mcp-tokens" / "jira.json").write_text("{}")
        self.status({"jira": {"state": "connected", "at": time.time(), "tools": 1}})
        self.assertEqual(self.items(), [])

    def test_auth_failure_asks_to_sign_in_again(self):
        (self.main / "mcp-tokens").mkdir()
        (self.main / "mcp-tokens" / "jira.json").write_text("{}")
        self.status({"jira": {"state": "auth_failed", "at": time.time()}})
        self.assertTrue(self.items()[0]["reauth"])


class CredentialTokenTest(unittest.TestCase):
    """자산 › 자격증명의 MCP OAuth 토큰 행(T7): 있음·수정 시각만, 토큰 값은 읽지 않는다(D29)."""

    def test_token_row_shows_presence_without_the_value(self):
        from aas.assets import inventory
        home = Path(tempfile.mkdtemp(dir=TMP.name))
        (home / "config.yaml").write_text("mcp_servers:\n  jira:\n    url: https://mcp.example.com/mcp\n    auth: oauth\n"
                                          "  wiki:\n    url: https://wiki.example.com/mcp\n    auth: oauth\n")
        (home / "mcp-tokens").mkdir()
        (home / "mcp-tokens" / "jira.json").write_text(json.dumps({"access_token": "SECRET-ACCESS-123", "expires_at": 1}))
        out = inventory.credentials(home)
        by = {i["name"]: i for i in out["items"]}
        jira, wiki = by["jira (OAuth)"], by["wiki (OAuth)"]
        self.assertEqual((jira["set"], jira["interface"], jira["location"], jira["flags"]), (True, "MCP: jira", "mcp-tokens/jira.json", []))
        self.assertTrue(jira["modified"])
        self.assertEqual((wiki["set"], wiki["flags"]), (False, ["로그인 필요"]))                # 「비어 있음」 대신
        self.assertNotIn("SECRET-ACCESS-123", json.dumps(out, ensure_ascii=False))


class LoginSnapshotTest(unittest.TestCase):
    """웹소켓 토픽 pod:<id>:mcp:<프로파일> 이 보내는 로그인 상태(14-22). Hermes API 없이 config.yaml·토큰·게이트웨이 기록만 읽는다."""

    def setUp(self):
        from aas.web import server
        self.server = server
        self.home = Path(TMP.name) / "snap-home"
        prof = self.home / "profiles" / "main"
        prof.mkdir(parents=True, exist_ok=True)
        (prof / "config.yaml").write_text(
            "mcp_servers:\n  jira:\n    url: https://mcp.example.com/mcp\n    auth: oauth\n"
            "  docs:\n    url: https://docs.example.com/mcp\n    headers: {Authorization: x}\n", encoding="utf-8")
        self.pod = SimpleNamespace(id="snap-p", hermes_home=self.home)
        self.rows = mock.patch.object(server, "_profile_rows", return_value=[{"name": "main", "is_default": False}])
        self.rows.start()

    def tearDown(self):
        self.rows.stop()
        self.server._forget(self.pod)
        tok = self.home / "profiles" / "main" / "mcp-tokens" / "jira.json"
        tok.unlink(missing_ok=True)

    def test_only_oauth_servers_and_their_state(self):
        with mock.patch.object(self.server, "HermesAPI", side_effect=AssertionError("no Hermes API")):
            out = self.server.mcp_login_snapshot(self.pod, "main")
            self.assertEqual(out, {"servers": {"jira": {"state": "login_required"}}})        # 헤더 서버(docs)는 넣지 않는다
            tok = self.home / "profiles" / "main" / "mcp-tokens"
            tok.mkdir(exist_ok=True)
            (tok / "jira.json").write_text("{}")
            self.server._forget_mcp_login(self.pod.id, "main")
            self.assertEqual(self.server.mcp_login_snapshot(self.pod, "main")["servers"]["jira"]["state"], "unknown")

    def test_unknown_profile_raises(self):
        with self.assertRaises(ValueError):
            self.server.mcp_login_snapshot(self.pod, "nope")


class FreshCacheTest(unittest.TestCase):
    """로그인 상태 읽기의 캐시: 지난 값을 돌려주지 않고, _forget 뒤 늦게 끝난 계산은 버린다(D30)."""

    def setUp(self):
        from aas.web import server
        self.server = server
        self.pod = SimpleNamespace(id="cache-p", hermes_home=Path(TMP.name))

    def tearDown(self):
        self.server._forget(self.pod)

    def test_expired_value_is_not_returned_when_stale_is_off(self):
        calls = []
        fn = lambda: calls.append(1) or len(calls)                                     # noqa: E731
        key = "cache-p:mcplogin:main"
        self.assertEqual(self.server._cached(key, 30, fn, per_lang=False, stale_ok=False), 1)
        with self.server._lock:
            t, v = self.server._cache[key]
            self.server._cache[key] = (t - 31, v)                                     # 만료
        self.assertEqual(self.server._cached(key, 30, fn, per_lang=False, stale_ok=False), 2)

    def test_login_state_cache_is_short_right_after_a_login(self):
        # 로그인 성공 뒤 유예(60초) 동안 30초 캐시를 쓰면, 게이트웨이가 유예 끝 무렵 붙을 때 유예가 지난 뒤 「확인 전」이 나온다(14-15)
        seen = []
        real = self.server._cached
        def spy(key, ttl, fn, **kw):
            seen.append(ttl)
            return real(key, ttl, fn, **kw)
        with mock.patch.object(self.server, "_cached", side_effect=spy), \
                mock.patch.object(relay, "token_times", return_value={}), mock.patch.object(relay, "gateway_records", return_value=None):
            with mock.patch.object(relay, "recent_login", return_value=True):
                self.server._mcp_login_reads(self.pod, "main", False)
            self.server._forget(self.pod)
            with mock.patch.object(relay, "recent_login", return_value=False):
                self.server._mcp_login_reads(self.pod, "main", False)
        self.assertEqual(seen, [self.server.MCP_LOGIN_SETTLE_TTL, 30])

    def test_value_built_before_forget_is_dropped(self):
        key = "cache-p:mcplogin:main"

        def fn():
            self.server._forget(self.pod)                                            # 만드는 사이에 로그인이 끝났다
            return "old"
        self.assertEqual(self.server._cached(key, 30, fn, per_lang=False, stale_ok=False), "old")
        self.assertNotIn(key, self.server._cache)                                    # 다음 읽기는 새로 만든다


class RouteTest(unittest.TestCase):
    """실제 서버: 비밀번호 로그인을 켜고 alice(주인)·bob(주인 아님)으로 경로를 부른다."""

    @classmethod
    def setUpClass(cls):
        from aas.auth import auth
        from aas.fleet import pods
        from aas.web import server
        cls.server = server
        cls.old = {k: os.environ.get(k) for k in ("AAS_OIDC_ISSUER", "AAS_OIDC_CLIENT_FILE", "AAS_ALLOWED_HOSTS", "AAS_PODS_FILE", "AAS_ADMINS")}
        for k in cls.old:
            os.environ.pop(k, None)
        users = Path(TMP.name) / "relay-users.json"
        for email in ("alice@example.com", "bob@example.com"):
            auth.save_user(email, "correct horse battery", users)
        home = Path(TMP.name) / "relay-hermes"
        (home / "profiles" / "main").mkdir(parents=True, exist_ok=True)
        reg = Path(TMP.name) / "relay-pods.json"
        reg.write_text('{"pods": [{"id": "relay-p", "owner": "alice@example.com", "hermes_home": "%s"}]}' % home)
        cls.old_auth, cls.old_reg = server._auth, server._registry
        server._auth = auth.Auth({"issuer": "", "client_id": "", "client_secret": "", "domain": "", "public_url": PUBLIC,
                                  "hours": 1, "users_file": users})
        server._registry = pods.Registry(reg)
        cls.fake = FakeHermes()
        cls.patches = [mock.patch.object(server, "HermesAPI", lambda _auth: cls.fake),
                       mock.patch.object(server, "hub", lambda pod: SimpleNamespace(auth=None)),
                       mock.patch.object(server, "_profile_rows", lambda pod: [{"name": "default", "is_default": True}, {"name": "main", "is_default": False}])]
        for p in cls.patches:
            p.start()
        cls.httpd = aasserver.start()
        cls.port = cls.httpd.server_port
        cls.alice = cls._cookie(server._auth._new_session("alice@example.com", "Alice"))
        cls.bob = cls._cookie(server._auth._new_session("bob@example.com", "Bob"))

    @classmethod
    def _cookie(cls, token):
        return cls.server._auth.set_cookie(token, False).split(";")[0]

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        for p in cls.patches:
            p.stop()
        cls.server._auth, cls.server._registry = cls.old_auth, cls.old_reg
        for k, v in cls.old.items():
            if v is not None:
                os.environ[k] = v
        wipe()

    def setUp(self):
        wipe()
        self.fake.__init__()

    def req(self, method, path, cookie="", body=None):
        c = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        headers = {"Content-Type": "application/json", "X-AAS": "1", "Accept-Language": "ko"}
        if cookie:
            headers["Cookie"] = cookie
        c.request(method, path, body=json.dumps(body) if body is not None else None, headers=headers)
        r = c.getresponse()
        return r, r.read().decode()

    def test_owner_flow_start_callback_status(self):
        r, page = self.req("GET", "/oauth/mcp/start?" + urlencode({"pod": "relay-p", "profile": "main", "server": "jira"}), self.alice)
        self.assertEqual(r.status, 200)
        self.assertIn("relay-p · main · jira", page)
        self.assertIn("[hidden]{display:none!important}", page)        # .btn 의 display:flex 가 숨긴 「계속」을 준비 전부터 보이게 했다(14-10)
        self.assertIn("id=go hidden", page)
        self.assertIn("/api/mcp/oauth/start", page)
        self.assertIn("인가 뒤 AAS 로그인을 한 번 더", page)                      # 접속 주소(127.0.0.1)가 공개 주소와 다르다(Q1·V11)
        r, body = self.req("POST", "/api/mcp/oauth/start", self.alice, {"pod": "relay-p", "profile": "main", "server": "jira"})
        out = json.loads(body)
        self.assertEqual((r.status, out["host"]), (200, "idp.example.com"))
        self.assertEqual(self.fake.calls[-1][2], {"profile": "main"})              # main 은 이름 있는 프로파일로 부른다
        state = parse_qs(urlsplit(out["authorization_url"]).query)["state"][0]
        r, page = self.req("GET", "/oauth/mcp/callback?" + urlencode({"code": "SECRET-CODE-1", "state": state, "iss": "https://idp.example.com"}), self.alice)
        self.assertEqual(r.status, 200)
        self.assertIn("로그인을 마무리하는 중", page)
        self.assertIn("/#/profiles?name=main&amp;pane=tools&amp;server=jira", page)
        r, body = self.req("GET", "/api/mcp/oauth/status?" + urlencode({"state": state}), self.alice)
        self.assertEqual(json.loads(body)["status"], "approved")
        r, body = self.req("GET", "/api/mcp/oauth/status?" + urlencode({"pod": "relay-p", "profile": "main", "server": "jira"}), self.alice)
        self.assertEqual(json.loads(body)["status"], "approved")
        with store.connect() as conn:                                              # 6절: 인가 코드는 기록에 남지 않는다
            logged = " ".join(str(r["note"]) for r in conn.execute("SELECT note FROM usage WHERE note LIKE ?", ("%jira%",)))
        self.assertNotIn("SECRET-CODE-1", logged)

    def test_non_owner_cannot_start_and_hidden_root_is_refused(self):
        r, body = self.req("POST", "/api/mcp/oauth/start", self.bob, {"pod": "relay-p", "profile": "main", "server": "jira"})
        self.assertEqual(r.status, 403)
        r, page = self.req("GET", "/oauth/mcp/start?" + urlencode({"pod": "relay-p", "profile": "main", "server": "jira"}), self.bob)
        self.assertEqual(r.status, 403)
        self.assertIn("창 닫기", page)
        from aas.ops import cron_policy
        with mock.patch.object(cron_policy, "root_hidden", lambda pod_id: True):     # 주 에이전트(main)를 쓰는 POD 는 루트(default)를 숨긴다
            r, body = self.req("POST", "/api/mcp/oauth/start", self.alice, {"pod": "relay-p", "profile": "default", "server": "jira"})
        self.assertEqual(r.status, 403)                                            # 주인은 숨긴 루트를 못 만진다
        self.assertIn("main", json.loads(body)["error"])

    def test_callback_with_another_users_session_is_refused(self):
        r, body = self.req("POST", "/api/mcp/oauth/start", self.alice, {"pod": "relay-p", "profile": "main", "server": "jira"})
        state = parse_qs(urlsplit(json.loads(body)["authorization_url"]).query)["state"][0]
        r, page = self.req("GET", "/oauth/mcp/callback?" + urlencode({"code": "c", "state": state}), self.bob)
        self.assertEqual(r.status, 403)
        self.assertIn("로그인을 시작한 사용자와 지금 로그인한 사용자가 다릅니다", page)
        self.assertNotIn("CB", [c[0] for c in self.fake.calls])                    # Hermes 콜백을 부르지 않았다
        r, body = self.req("GET", "/api/mcp/oauth/status?" + urlencode({"state": state}), self.bob)
        self.assertEqual(json.loads(body)["status"], "none")                        # 남의 흐름 상태도 보이지 않는다

    def test_callback_without_session_keeps_the_query_through_login(self):
        target = "/oauth/mcp/callback?" + urlencode({"code": "c", "state": "s"})
        r, _ = self.req("GET", target)
        self.assertEqual(r.status, 302)
        loc = r.getheader("Location")
        self.assertTrue(loc.startswith("/auth/login?"))
        self.assertEqual(parse_qs(urlsplit(loc).query)["next"][0], target)          # 4-4: 경로와 쿼리를 함께 넘긴다
        r, page = self.req("GET", loc)
        self.assertIn(f"value='{target.replace('&', '&amp;')}'", page)               # 비밀번호 폼의 next
        self.assertNotIn("aas-login", page)                                          # V11: 팝업 스크립트가 없다(이미 팝업 안)

    def test_cancel_route(self):
        self.req("POST", "/api/mcp/oauth/start", self.alice, {"pod": "relay-p", "profile": "main", "server": "jira"})
        r, body = self.req("POST", "/api/mcp/oauth/cancel", self.alice, {"pod": "relay-p", "profile": "main", "server": "jira"})
        self.assertEqual((r.status, json.loads(body)["cancelled"]), (200, 1))

    def test_profile_detail_adds_login_state_to_oauth_rows(self):
        listed = {"servers": [{"name": "jira", "transport": "http", "url": "https://mcp.example.com/mcp", "auth": "oauth", "enabled": True},
                              {"name": "hdr", "transport": "http", "url": "https://mcp.example.com/mcp", "auth": "header", "enabled": True}]}
        base = self.fake.call

        def call(method, path, body=None, query=None, timeout=30):
            if method == "GET" and path == "/api/mcp/servers":
                return listed
            if path.endswith("/auth") or path.startswith("/api/mcp/oauth/") or path in ("/api/config", "/api/mcp/servers"):
                return base(method, path, body, query, timeout)
            raise HermesError("대역에 없는 경로", 404)
        from aas.ops import mcp_servers
        mcp_servers.note_forced("relay-p", "main", "hdr", "admin@x", "airgap")
        self.addCleanup(mcp_servers.forget_forced, "relay-p", "main", "hdr")
        with mock.patch.object(self.fake, "call", call), mock.patch.object(self.server, "_models", lambda pod: {"models": []}):
            self.req("POST", "/api/mcp/oauth/start", self.alice, {"pod": "relay-p", "profile": "main", "server": "jira"})
            r, body = self.req("GET", "/api/profile?" + urlencode({"pod": "relay-p", "name": "main"}), self.alice)
        self.assertEqual(r.status, 200, body)
        self.assertEqual((json.loads(body)["pod"], json.loads(body)["mcp_oauth_callback"]), ("relay-p", CALLBACK))   # 화면의 로그인 경로·복사 칸(T6·V7)
        rows = {m["name"]: m for m in json.loads(body)["mcp"]}
        self.assertEqual(rows["jira"]["login_state"], {"state": "logging_in", "mine": True})
        self.assertNotIn("login_state", rows["hdr"])
        self.assertTrue(rows["hdr"]["forced"])                                    # 「판정과 다르게 추가함」(V16)
        self.assertNotIn("forced", rows["jira"])


if __name__ == "__main__":
    unittest.main()

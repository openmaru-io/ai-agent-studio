# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""MindWiki 계정으로 연결(스펙 2026-11-14-001 2단계, OMAI-2018). MindWiki 는 _call 대역, Hermes 에 붙이기는 attach 대역이다.
임대·워크스페이스 고르기·발급·교체·예전 토큰 지우기·지울 일·이유 코드·만료 상태·토큰 비노출을 본다."""
import json
import os
import tempfile
import threading
import time
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest import mock

TMP = tempfile.TemporaryDirectory()
os.environ.setdefault("AAS_DATA_DIR", str(Path(TMP.name) / "data"))

from aas.assets.files import FileError  # noqa: E402
from aas.hermes.hermes_api import HermesError  # noqa: E402
from aas.ops import mindwiki_connect as mc  # noqa: E402

POD, PROFILE = "pod-mw", "main"
SETTINGS = {"AAS_MINDWIKI_URL": "https://wiki.corp.example", "AAS_MINDWIKI_ACCOUNT_CONNECT": "true", "AAS_MINDWIKI_WORKSPACE": ""}


class FakeWiki:
    def __init__(self, workspaces=None):
        self.workspaces = workspaces if workspaces is not None else [{"id": "ws-1", "name": "개발", "slug": "dev", "role": "member"}]
        self.tokens: dict[str, dict] = {}
        self.calls: list[tuple] = []
        self.fail: dict[tuple, Exception] = {}
        self.no_write = False                                          # WIKI_CONNECTOR_ALLOW_WRITE=false 인 MindWiki
        self.n = 0

    def __call__(self, method, path, token, workspace="", body=None):
        self.calls.append((method, path, token, workspace, body))
        err = self.fail.get((method, path.split("/")[2] if path.count("/") >= 2 else path))
        if err:
            raise err
        if (method, path) == ("GET", "/api/me"):
            return {"workspaces": self.workspaces}
        if (method, path) == ("POST", "/api/tokens"):
            if self.no_write and body["write"]:
                raise mc.MindwikiHTTPError(400, "connector_token_rejected", "this wiki does not let connector clients make write tokens")
            self.n += 1
            tid = f"tid-{self.n}"
            self.tokens[tid] = {"id": tid, "name": body["name"], "write": body["write"], "days": body["days"], "automation": bool(body.get("automation"))}
            exp = (datetime.now(timezone.utc) + timedelta(days=body["days"])).isoformat()
            return {"token": {"id": tid, "name": body["name"], "expiresAt": exp}, "text": f"wiki_pat_secret{self.n}"}
        if (method, path) == ("GET", "/api/tokens"):
            return {"tokens": list(self.tokens.values())}
        if method == "DELETE":
            tid = path.rsplit("/", 1)[1]
            if tid not in self.tokens:
                raise mc.MindwikiHTTPError(404)
            del self.tokens[tid]
            return {}
        raise AssertionError((method, path))


class ConnectTest(unittest.TestCase):
    def setUp(self):
        self.sub = "sub-" + os.urandom(4).hex()
        self.wiki = FakeWiki()
        self.attached: list[tuple] = []
        self.logs: list[str] = []
        self.attach_error = None
        for p in (mock.patch.dict(os.environ, SETTINGS), mock.patch.object(mc, "_call", self.wiki)):
            p.start()
            self.addCleanup(p.stop)
        self.addCleanup(self._clean)

    def _clean(self):
        with mc._conn() as conn:
            conn.execute("DELETE FROM connector_tokens WHERE sub=?", (self.sub,))
            conn.execute("DELETE FROM connector_jobs WHERE sub=?", (self.sub,))

    def attach(self, key, write):
        if self.attach_error:
            raise self.attach_error
        self.attached.append((key, write))
        return {"ok": True}

    def connect(self, write=False, workspace="", token=("at-1", "")):
        """start 와 같은 임대를 잡고 뒤 작업을 이 스레드에서 돌린다."""
        job = "job-" + os.urandom(3).hex()
        self.assertTrue(mc._lease(self.sub, POD, PROFILE, job, 60))
        mc._run(job=job, sub=self.sub, pod=POD, profile=PROFILE, write=write, workspace=workspace, cookie="aas_session=c",
                access_token=lambda cookie: token, attach=self.attach, log=self.logs.append)
        return mc.state(self.sub, POD, PROFILE)

    def test_first_connect_makes_a_read_token_and_attaches_it(self):
        st = self.connect()
        self.assertEqual((st["status"], st["write"], st["tool_count"], st["workspace"], st["connected"]), ("connected", False, 18, "ws-1", True))
        made = self.wiki.tokens["tid-1"]
        self.assertTrue(made["name"].startswith("AAS ") and made["name"].endswith(" main"))
        self.assertEqual((made["write"], made["days"]), (False, 90))
        self.assertEqual(self.attached, [("wiki_pat_secret1", False)])
        create = next(c for c in self.wiki.calls if c[:2] == ("POST", "/api/tokens"))
        self.assertEqual((create[2], create[3]), ("at-1", "ws-1"))          # AAS 액세스 토큰 + X-Workspace
        dump = json.dumps(mc._row(self.sub, POD, PROFILE)) + "".join(self.logs)
        self.assertNotIn("wiki_pat_", dump)                                  # 토큰 원문은 DB·로그에 없다
        self.assertNotIn("at-1", dump)

    def test_write_tokens_live_30_days_and_reconnect_keeps_the_old_token_until_applied(self):
        self.connect()
        st = self.connect(write=True)
        self.assertEqual((st["status"], st["write"], st["tool_count"]), ("connected", True, 33))   # 읽기 18 + 쓰기 15(suggest_edit·첨부 올리기 둘, 스펙 2026-11-15-002)
        # 3단계(스펙 2026-11-14-012 A13): 예전 토큰은 바로 지우지 않는다 — 게이트웨이가 「지금 적용」 전까지 그 키를 쓴다
        self.assertEqual(sorted(self.wiki.tokens), ["tid-1", "tid-2"])
        self.assertEqual(mc._row(self.sub, POD, PROFILE)["prev_tid"], "tid-1")
        self.assertTrue(st["needs_apply"])
        self.assertEqual(self.wiki.tokens["tid-2"]["days"], 30)
        self.assertEqual(self.attached[-1], ("wiki_pat_secret2", True))

    def test_workspace_choice(self):
        self.wiki.workspaces = []
        self.assertEqual(self.connect()["reason"], "no_workspace")
        self.wiki.workspaces = [{"id": "ws-1", "name": "개발", "slug": "dev"}, {"id": "ws-2", "name": "영업", "slug": "sales"}]
        st = self.connect()
        self.assertEqual((st["status"], st["reason"]), ("failed", "need_workspace"))
        self.assertEqual([w["slug"] for w in st["detail"]], ["dev", "sales"])
        self.assertEqual(self.connect(workspace="sales")["workspace"], "ws-2")   # slug 로 고른다
        with mock.patch.dict(os.environ, {"AAS_MINDWIKI_WORKSPACE": "ws-1"}):
            self.assertEqual(self.connect()["workspace"], "ws-1")             # 설치 값이 있으면 고정
        self.assertEqual(self.connect(workspace="nope")["reason"], "no_workspace")

    # OKE 실화면(2026-11-14): 워크스페이스가 둘인 사람이 「다시 연결」을 누르면 need_workspace 로 다시 고르라고 했다
    def test_reconnect_keeps_the_workspace_it_is_connected_to(self):
        self.wiki.workspaces = [{"id": "ws-1", "name": "개발", "slug": "dev"}, {"id": "ws-2", "name": "영업", "slug": "sales"}]
        self.assertEqual(self.connect(workspace="sales")["workspace"], "ws-2")
        st = self.connect()                                                   # 화면은 다시 연결 때 워크스페이스를 보내지 않는다
        self.assertEqual((st["status"], st["workspace"]), ("connected", "ws-2"))
        self.assertEqual(mc._row(self.sub, POD, PROFILE)["prev_tid"], "tid-1")   # 같은 워크스페이스에서 교체, 예전 토큰은 prev 로(A13)
        with mock.patch.dict(os.environ, {"AAS_MINDWIKI_WORKSPACE": "dev"}):
            self.assertEqual(self.connect()["workspace"], "ws-1")             # 설치 값이 있으면 그것이 먼저다
        self.wiki.workspaces = [{"id": "ws-2", "name": "영업", "slug": "sales"}, {"id": "ws-3", "name": "기획", "slug": "plan"}]
        st = self.connect()                                                   # 연결된 워크스페이스(ws-1)에서 빠졌으면 다시 고른다
        self.assertEqual((st["status"], st["reason"]), ("failed", "need_workspace"))

    def test_reason_codes(self):
        for token, reason in ((("", "session_ended"), "session_ended"), (("", "no_refresh_token"), "no_refresh_token"),
                              (("", "keycloak_unavailable"), "keycloak_unavailable"), (("", "lease_busy"), "lease_busy")):
            self.assertEqual(self.connect(token=token)["reason"], reason)
        cases = [(("GET", "me"), mc.MindwikiHTTPError(401), "iss_or_client_rejected"),
                 (("GET", "me"), mc.MindwikiHTTPError(403, "connector_scope"), "connector_scope"),
                 (("GET", "me"), mc.MindwikiHTTPError(403, "", "user disabled"), "account_disabled"),
                 (("POST", "tokens"), mc.MindwikiHTTPError(403, "", "guests cannot use tokens"), "guest"),
                 (("POST", "tokens"), mc.MindwikiHTTPError(400, "connector_token_rejected"), "token_request_rejected"),
                 # MindWiki 가 연결 client 의 쓰기 토큰을 막았다(WIKI_CONNECTOR_ALLOW_WRITE=false, OKE 2026-11-14) — 읽기로는 된다고 알린다
                 (("POST", "tokens"), mc.MindwikiHTTPError(400, "connector_token_rejected",
                                                          "this wiki does not let connector clients make write tokens"), "write_disabled"),
                 (("POST", "tokens"), mc.MindwikiHTTPError(429, "connector_daily_limit"), "daily_limit"),
                 (("POST", "tokens"), mc.MindwikiHTTPError(503), "mindwiki_5xx"),
                 (("GET", "me"), mc.MindwikiTLSError("SSLCertVerificationError"), "tls"),
                 (("GET", "me"), mc.MindwikiTimeout(), "timeout")]
        for key, err, reason in cases:
            self.wiki.fail = {key: err}
            self.assertEqual(self.connect()["reason"], reason, (key, err))
        self.assertEqual(set(mc.REASONS) >= {r for _, _, r in cases}, True)

    def test_token_limit_lists_aas_tokens_and_keeps_the_old_token(self):
        self.connect()
        self.wiki.fail = {("POST", "tokens"): mc.MindwikiHTTPError(409)}
        st = self.connect()
        self.assertEqual((st["status"], st["reason"]), ("failed", "token_limit"))
        self.assertEqual(len(st["detail"]), 1)
        self.assertIn("tid-1", self.wiki.tokens)
        self.assertTrue(mc._row(self.sub, POD, PROFILE)["tid"] == "tid-1")   # 붙어 있던 토큰은 그대로

    def test_timeout_on_create_removes_a_token_it_may_have_made(self):
        def slow(method, path, token, workspace="", body=None):
            if (method, path) == ("POST", "/api/tokens"):
                FakeWiki.__call__(self.wiki, method, path, token, workspace, body)   # MindWiki 는 만들었지만 답이 늦었다
                raise mc.MindwikiTimeout()
            return FakeWiki.__call__(self.wiki, method, path, token, workspace, body)
        with mock.patch.object(mc, "_call", slow):
            self.assertEqual(self.connect()["reason"], "timeout")
        self.assertEqual(self.wiki.tokens, {})

    def test_attach_failure_deletes_the_new_token(self):
        self.attach_error = FileError("x", 400, reason="mindwiki_key_rejected")
        self.assertEqual(self.connect()["reason"], "hermes_reload")
        self.attach_error = HermesError("down", 503)
        self.assertEqual(self.connect()["reason"], "hermes_not_ready")
        self.assertEqual(self.wiki.tokens, {})

    def test_forget_queues_the_token_and_the_next_connect_deletes_it(self):
        self.connect()
        self.assertEqual(mc.forget(POD, PROFILE), 1)
        self.assertEqual(mc.state(self.sub, POD, PROFILE)["status"], "none")
        self.assertIn("tid-1", self.wiki.tokens)                              # 액세스 토큰이 없어 아직 못 지웠다
        self.connect()
        self.assertEqual(list(self.wiki.tokens), ["tid-2"])
        with mc._conn() as conn:
            self.assertEqual(conn.execute("SELECT count(*) FROM connector_jobs WHERE sub=?", (self.sub,)).fetchone()[0], 0)

    def test_delete_jobs_give_up_after_five_failures(self):
        with mc._conn() as conn:
            mc._queue_delete(conn, self.sub, POD, PROFILE, "tid-gone", "ws-1")
        self.wiki.fail = {("DELETE", "tokens"): mc.MindwikiTimeout()}
        for _ in range(mc.DELETE_ATTEMPTS):
            mc._drain_deletes("at", self.sub)
        with mc._conn() as conn:
            self.assertEqual(conn.execute("SELECT count(*) FROM connector_jobs WHERE sub=?", (self.sub,)).fetchone()[0], 0)

    def test_lease_and_stale_pending(self):
        with mock.patch.object(threading, "Thread"):                         # 뒤 작업은 띄우지 않는다
            out = mc.start(sub=self.sub, pod=POD, profile=PROFILE, write=False, workspace="", cookie="c",
                           access_token=lambda c: ("", ""), attach=self.attach, log=self.logs.append)
            self.assertEqual(out["status"], "pending")
            with self.assertRaises(FileError) as cm:                          # 두 번 누름
                mc.start(sub=self.sub, pod=POD, profile=PROFILE, write=False, workspace="", cookie="c",
                         access_token=lambda c: ("", ""), attach=self.attach, log=self.logs.append)
            self.assertEqual((cm.exception.code, cm.exception.reason), (409, "lease_busy"))
        self.assertEqual(mc.state(self.sub, POD, PROFILE)["status"], "pending")
        with mc._conn() as conn:                                              # 작업 중 프로세스가 죽어 임대가 지났다
            conn.execute("UPDATE connector_tokens SET lease_until=? WHERE sub=?", (time.time() - 1, self.sub))
        self.assertEqual((mc.state(self.sub, POD, PROFILE)["status"], mc.state(self.sub, POD, PROFILE)["reason"]), ("failed", "internal"))
        self.assertTrue(mc._lease(self.sub, POD, PROFILE, "next", 60))       # 지난 임대는 다시 잡힌다
        self.assertFalse(mc._update(self.sub, POD, PROFILE, "old-owner", status="connected"))   # 주인이 아니면 고치지 못한다

    def test_expiry_states(self):
        self.connect()
        now = datetime.now(timezone.utc)
        self.assertEqual(mc.state(self.sub, POD, PROFILE, now + timedelta(days=80))["status"], "soon")
        self.assertEqual(mc.state(self.sub, POD, PROFILE, now + timedelta(days=91))["reason"], "expired")

    def test_disabled_or_anonymous(self):
        with mock.patch.dict(os.environ, {"AAS_MINDWIKI_ACCOUNT_CONNECT": "false"}):
            self.assertFalse(mc.state(self.sub, POD, PROFILE)["enabled"])
            with self.assertRaises(FileError):
                mc.start(sub=self.sub, pod=POD, profile=PROFILE, write=False, workspace="", cookie="", access_token=lambda c: ("", ""),
                         attach=self.attach, log=self.logs.append)
        with self.assertRaises(FileError) as cm:
            mc.start(sub="", pod=POD, profile=PROFILE, write=False, workspace="", cookie="", access_token=lambda c: ("", ""),
                     attach=self.attach, log=self.logs.append)
        self.assertEqual(cm.exception.reason, "forbidden")
        with mock.patch.dict(os.environ, {"AAS_MINDWIKI_URL": "", "AAS_MINDWIKI_ACCOUNT_CONNECT": "true"}):
            self.assertFalse(mc.enabled())
            self.assertIn("AAS_MINDWIKI_ACCOUNT_CONNECT", mc.config_warning())


class ReasonsMatchUiTest(unittest.TestCase):
    def test_mindwiki_reasons_match_ui(self):
        """이유 코드마다 화면 문구(ko·en)가 있다. 반대쪽은 ui MindwikiAccount.test.ts 가 본다(스펙 4절 이유 코드)."""
        root = Path(__file__).resolve().parent.parent / "ui" / "src" / "i18n"
        for lang in ("ko", "en"):
            text = (root / lang / "profiles.ts").read_text(encoding="utf-8")
            missing = [r for r in mc.REASONS if f"'profiles.mcp.mindwikiReason.{r}'" not in text]
            self.assertEqual(missing, [], lang)


if __name__ == "__main__":
    unittest.main()

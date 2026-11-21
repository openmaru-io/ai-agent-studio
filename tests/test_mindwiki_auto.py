# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""MindWiki 3단계 자동 점검(스펙 2026-11-14-012): 로그인·갱신 때 회수 감지·기한 전 재발급·자동 첫 연결, 「지금 적용」 세대 번호.
MindWiki 는 FakeWiki(test_mindwiki_connect)로, Hermes 붙이기는 Host 대역으로, 시각은 mc.now 를 바꿔 넣는다."""
from __future__ import annotations

import base64
import json
import os
import sqlite3
import sys
import time
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from aas.common import store  # noqa: E402
from aas.hermes.hermes_api import HermesError  # noqa: E402
from aas.ops import mindwiki_connect as mc  # noqa: E402
from tests.test_mindwiki_connect import POD, PROFILE, SETTINGS, FakeWiki  # noqa: E402

T0 = float(int(time.time()))                            # 시작 시각을 고정한다(대역 MindWiki 의 기한이 실제 시각 기준이라 실제 시각에 맞춘다)
DAY = 86400


def jwt(exp: float) -> str:
    body = base64.urlsafe_b64encode(json.dumps({"exp": exp}).encode()).decode().rstrip("=")
    return f"h.{body}.s"


class Host:
    def __init__(self, test):
        self.t = test
        self.owner = True
        self.targets: list = []
        self.attach_error = None

    def attach_for(self, sub, email, pod, profile):
        if not self.owner:
            return None
        return {"attach": self._attach, "detach": lambda: self.t.detached.append(profile), "refresh": lambda: self.t.refreshed.append(profile) or self.t.refresh_changes}

    def _attach(self, key, write):
        if self.attach_error:
            raise self.attach_error
        self.t.attached.append((key, write))
        return {"ok": True}

    def primary_for(self, sub, email):
        return list(self.targets)


class AutoTest(unittest.TestCase):
    def setUp(self):
        self.sub = "sub-" + os.urandom(4).hex()
        self.wiki = FakeWiki()
        self.attached: list = []
        self.detached: list = []
        self.refreshed: list = []
        self.refresh_changes = False
        self.clock = [T0]
        self.host = Host(self)
        sync = mock.patch.object(mc.threading, "Thread", lambda target, name=None, daemon=None, kwargs=None: type(
            "T", (), {"start": staticmethod(lambda: target(**(kwargs or {})))})())
        for p in (mock.patch.dict(os.environ, SETTINGS), mock.patch.object(mc, "_call", self.wiki),
                  mock.patch.object(mc, "now", lambda: self.clock[0]), sync, mock.patch.object(mc, "_HOST", self.host)):
            p.start()
            self.addCleanup(p.stop)
        self.addCleanup(self._clean)

    def _clean(self):
        with mc._conn() as conn:
            conn.execute("DELETE FROM connector_tokens WHERE sub=?", (self.sub,))
            conn.execute("DELETE FROM connector_jobs WHERE sub=?", (self.sub,))

    def token(self, left=300.0):
        return jwt(self.clock[0] + left)

    def connect(self, write=False, profile=PROFILE):
        """2단계 버튼 연결(사람)로 연결된 행을 만든다."""
        job = "job-" + os.urandom(3).hex()
        self.assertTrue(mc._lease(self.sub, POD, profile, job, 60))
        mc._run(job=job, sub=self.sub, pod=POD, profile=profile, write=write, workspace="", cookie="c",
                access_token=lambda c: ("at-human", ""), attach=self.host._attach, log=lambda m: None)
        return mc._row(self.sub, POD, profile)

    def login(self):
        return mc.on_login(self.sub, "a@corp", self.token())

    def jobs(self):
        with mc._conn() as conn:
            return {r["tid"] for r in conn.execute("SELECT tid FROM connector_jobs WHERE sub=?", (self.sub,)).fetchall()}

    def set_row(self, **cols):
        with mc._conn() as conn:
            conn.execute(f"UPDATE connector_tokens SET {', '.join(k + '=?' for k in cols)} WHERE sub=?", (*cols.values(), self.sub))

    def calls(self, method, path):
        return [c for c in self.wiki.calls if c[:2] == (method, path)]

    # ---- 점검 시점 ------------------------------------------------------------------------------------------------

    def test_refresh_within_12h_does_not_call_mindwiki(self):
        self.connect()
        self.wiki.calls.clear()
        self.assertEqual(self.login(), 0)                                   # 사람 연결이 next_check_at 을 12시간 뒤로 두었다
        self.clock[0] += mc.CHECK_EVERY + 1
        self.assertEqual(self.login(), 1)
        self.assertEqual(len(self.calls("GET", "/api/tokens")), 1)
        self.assertEqual(self.login(), 0)                                   # 성공 뒤 다시 12시간
        self.assertEqual(mc._row(self.sub, POD, PROFILE)["auto_reason"], "")

    def test_switch_off_and_bad_values(self):
        self.connect()
        self.clock[0] += mc.CHECK_EVERY + 1
        with mock.patch.dict(os.environ, {"AAS_MINDWIKI_AUTO_CHECK": "false"}):
            self.assertEqual(self.login(), 0)
        with mock.patch.dict(os.environ, {"AAS_MINDWIKI_AUTO_CHECK": "yes"}):
            self.assertFalse(mc.auto_check_enabled())                       # true·false 만 받는다
            self.assertIn("AAS_MINDWIKI_AUTO_CHECK", mc.config_warning())
        self.assertTrue(mc.auto_connect_enabled())                          # 자동 첫 연결은 기본 켬(2026-11-15)
        with mock.patch.dict(os.environ, {"AAS_MINDWIKI_AUTO_CONNECT": "false"}):
            self.assertFalse(mc.auto_connect_enabled())                     # false 를 적을 때만 끈다
        with mock.patch.dict(os.environ, {"AAS_MINDWIKI_AUTO_CONNECT": "yes"}):
            self.assertFalse(mc.auto_connect_enabled())                     # 잘못된 값은 꺼짐
            self.assertIn("AAS_MINDWIKI_AUTO_CONNECT", mc.config_warning())

    def test_short_lived_access_token_does_not_call_mindwiki(self):
        self.connect()
        self.clock[0] += mc.CHECK_EVERY + 1
        self.wiki.calls.clear()
        mc.on_login(self.sub, "a@corp", jwt(self.clock[0] + 10))           # 30초 미만 남음
        self.assertEqual(self.wiki.calls, [])

    def test_busy_workers_skip_the_auto_check(self):
        self.connect()
        self.clock[0] += mc.CHECK_EVERY + 1
        self.wiki.calls.clear()
        held = [mc.WORKERS.acquire() for _ in range(4)]
        try:
            self.login()
        finally:
            for _ in held:
                mc.WORKERS.release()
        self.assertEqual(self.wiki.calls, [])                               # 사람 작업이 뒤에 줄 서지 않게 건너뛴다

    # ---- 회수 감지 ------------------------------------------------------------------------------------------------

    def test_revoked_only_on_a_full_200_list(self):
        self.connect()
        for err, reason, retry in ((mc.MindwikiHTTPError(503), "mindwiki_5xx", mc.RETRY_AFTER), (mc.MindwikiTimeout(), "timeout", mc.RETRY_AFTER),
                                   (mc.MindwikiHTTPError(401), "idp_token_rejected", mc.RETRY_AFTER),
                                   (mc.MindwikiHTTPError(403, "", "not a member"), "no_workspace", mc.CHECK_EVERY)):
            self.clock[0] += mc.CHECK_EVERY + 1
            self.wiki.fail = {("GET", "tokens"): err}
            self.login()
            r = mc._row(self.sub, POD, PROFILE)
            self.assertEqual((r["status"], r["auto_reason"], r["tid"]), ("connected", reason, "tid-1"), reason)
            self.assertEqual(r["next_check_at"], self.clock[0] + retry, reason)
        self.wiki.fail = {}
        self.clock[0] += mc.CHECK_EVERY + 1
        self.login()
        self.assertEqual(mc._row(self.sub, POD, PROFILE)["auto_reason"], "")   # 다음 점검이 성공하면 경고가 사라진다

    def test_token_deleted_in_mindwiki_becomes_revoked_and_is_not_reconnected(self):
        self.connect()
        del self.wiki.tokens["tid-1"]
        self.clock[0] += mc.CHECK_EVERY + 1
        self.login()
        st = mc.state(self.sub, POD, PROFILE)
        self.assertEqual((st["status"], st["connected"], st["needs_apply"]), ("revoked", False, True))
        self.assertEqual(self.detached, [PROFILE])                          # 걷어낸 키
        self.clock[0] += mc.CHECK_EVERY + 1
        self.wiki.calls.clear()
        self.assertEqual(self.login(), 0)                                   # revoked 는 자동으로 다시 하지 않는다
        self.connect()                                                      # 사람이 버튼을 누르면 풀린다
        self.assertEqual(mc.state(self.sub, POD, PROFILE)["status"], "connected")

    def test_revoke_check_uses_the_row_workspace(self):
        self.connect()
        self.clock[0] += mc.CHECK_EVERY + 1
        self.login()
        self.assertEqual(self.calls("GET", "/api/tokens")[-1][3], "ws-1")  # X-Workspace = 행의 워크스페이스

    # ---- 재발급과 예전 토큰 ------------------------------------------------------------------------------------------

    def test_reissue_keeps_the_old_token_until_applied(self):
        self.connect()
        self.set_row(expires_at=mc._iso(datetime.fromtimestamp(T0, timezone.utc) + timedelta(days=31)))
        self.clock[0] += mc.CHECK_EVERY + 1
        self.login()
        r = mc._row(self.sub, POD, PROFILE)
        self.assertEqual(r["tid"], "tid-1")                                 # 31일 남음: 아직
        self.set_row(expires_at=mc._iso(datetime.fromtimestamp(self.clock[0], timezone.utc) + timedelta(days=29)), next_check_at=0)
        self.login()
        r = mc._row(self.sub, POD, PROFILE)
        self.assertEqual((r["tid"], r["prev_tid"]), ("tid-2", "tid-1"))
        self.assertNotIn("tid-1", self.jobs())                              # 바로 지우지 않는다
        self.assertIn("tid-1", self.wiki.tokens)
        self.assertTrue(mc.state(self.sub, POD, PROFILE)["needs_apply"])
        self.assertEqual(self.attached[-1], ("wiki_pat_secret2", False))
        # 「지금 적용」 성공 → 표시가 사라지고, 기다린 뒤 다음 점검이 예전 토큰을 지운다
        mc.mark_applied(mc.apply_snapshot(POD, [PROFILE]))
        self.assertFalse(mc.state(self.sub, POD, PROFILE)["needs_apply"])
        self.clock[0] += mc.APPLY_GRACE + 1
        self.login()
        self.assertEqual(mc._row(self.sub, POD, PROFILE)["prev_tid"], "")
        # 같은 점검에서 지운다. 지울 일 처리가 정리보다 먼저면 12시간 뒤 다음 로그인까지 MindWiki 에 남았다(OKE 2026-11-15)
        self.assertNotIn("tid-1", self.wiki.tokens)
        self.assertNotIn("tid-1", self.jobs())

    def test_write_token_reissues_at_10_days(self):
        self.connect(write=True)
        self.set_row(expires_at=mc._iso(datetime.fromtimestamp(T0, timezone.utc) + timedelta(days=11)), next_check_at=0)
        self.login()
        self.assertEqual(mc._row(self.sub, POD, PROFILE)["tid"], "tid-1")
        self.set_row(expires_at=mc._iso(datetime.fromtimestamp(T0, timezone.utc) + timedelta(days=9)), next_check_at=0)
        self.login()
        r = mc._row(self.sub, POD, PROFILE)
        self.assertEqual((r["tid"], r["write"]), ("tid-2", 1))
        self.assertEqual(self.wiki.tokens["tid-2"]["days"], 30)

    def test_apply_during_a_key_change_keeps_the_mark(self):
        self.connect()
        snap = mc.apply_snapshot(POD, [PROFILE])                            # 다시 시작을 시작했다
        self.connect()                                                      # 그 사이 키가 또 바뀌었다
        mc.mark_applied(snap)
        self.assertTrue(mc.state(self.sub, POD, PROFILE)["needs_apply"])

    def test_shared_gateway_marks_every_profile_of_the_pod(self):
        self.connect(profile="main")
        self.connect(profile="ops")
        mc.mark_applied(mc.apply_snapshot(POD, None))                      # 쿠버네티스: 루트 게이트웨이 하나
        self.assertFalse(mc.state(self.sub, POD, "main")["needs_apply"])
        self.assertFalse(mc.state(self.sub, POD, "ops")["needs_apply"])
        self.connect(profile="main")
        mc.mark_applied(mc.apply_snapshot(POD, ["ops"]))                   # compose: 그 프로파일만
        self.assertTrue(mc.state(self.sub, POD, "main")["needs_apply"])

    def test_reissue_timeout_keeps_current_and_prev_tokens(self):
        self.connect()
        self.connect()                                                      # tid-2, prev tid-1
        self.set_row(expires_at=mc._iso(datetime.fromtimestamp(T0, timezone.utc) + timedelta(days=5)), next_check_at=0)
        self.wiki.fail = {("POST", "tokens"): mc.MindwikiTimeout()}
        self.login()
        self.assertEqual(sorted(self.wiki.tokens), ["tid-1", "tid-2"])       # 같은 이름이어도 지금·예전 토큰은 지우지 않는다
        self.assertEqual(mc._row(self.sub, POD, PROFILE)["auto_reason"], "timeout")

    def test_attach_failure_queues_the_new_token_and_keeps_the_current(self):
        self.connect()
        self.set_row(expires_at=mc._iso(datetime.fromtimestamp(T0, timezone.utc) + timedelta(days=5)), next_check_at=0)
        self.host.attach_error = HermesError("down", 503)
        self.login()
        r = mc._row(self.sub, POD, PROFILE)
        self.assertEqual((r["tid"], r["prev_tid"], r["status"], r["auto_reason"]), ("tid-1", "", "connected", "hermes_not_ready"))
        self.assertIn("tid-2", self.jobs())                                 # ① 먼저 지울 일에 — 다음 점검이 치운다
        self.host.attach_error = None
        self.clock[0] += mc.RETRY_AFTER + 1
        self.login()
        self.assertNotIn("tid-2", self.wiki.tokens)

    # OKE(2026-11-15, #604): 서버 두 대가 같은 행을 거의 동시에 골라, 먼저 끝난 쪽이 임대를 푼 뒤 다른 쪽이 한 번 더 점검했다
    def test_a_row_checked_by_another_server_is_not_checked_again(self):
        self.connect()
        self.set_row(next_check_at=0)
        rows = [(POD, PROFILE, False)]                                      # 두 서버가 각자 고른 목록
        mc._auto(sub=self.sub, email="a@corp", token=self.token(), rows=rows)
        self.wiki.calls.clear()
        mc._auto(sub=self.sub, email="a@corp", token=self.token(), rows=rows)
        self.assertEqual(self.wiki.calls, [])

    def test_human_button_wins_over_an_auto_lease(self):
        self.connect()
        self.set_row(next_check_at=0)
        self.assertTrue(mc._auto_lease(self.sub, POD, PROFILE, "auto-x", False))
        job = "job-human"
        self.assertTrue(mc._lease(self.sub, POD, PROFILE, job, 60))        # lease_busy 없이 사람이 가져간다
        mc._auto_finish(self.sub, POD, PROFILE, "auto-x", "timeout", "")   # 자동 작업의 결과는 버려진다
        self.assertEqual(mc._row(self.sub, POD, PROFILE)["auto_reason"], "")

    def test_unexpected_error_is_recorded_with_a_correlation_id(self):
        self.connect()
        self.set_row(expires_at=mc._iso(datetime.fromtimestamp(T0, timezone.utc) + timedelta(days=5)), next_check_at=0)
        self.host.attach_error = RuntimeError("boom")
        with mock.patch("builtins.print") as out:
            self.login()
        r = mc._row(self.sub, POD, PROFILE)
        self.assertEqual(r["status"], "connected")
        self.assertTrue(r["auto_reason"].startswith("internal_error:"))
        logged = " ".join(str(c) for c in out.call_args_list)
        self.assertIn("Traceback", logged)
        self.assertNotIn("wiki_pat_", logged)
        self.assertNotIn(self.token(), logged)

    def test_check_refreshes_the_tool_list(self):
        """연결된 행의 점검은 예전 판이 적은 도구 목록에 새 도구를 채운다(스펙 2026-11-15-002, OKE 2026-11-15)."""
        self.connect(write=True)
        self.set_row(next_check_at=0)
        gen = lambda: int(mc._row(self.sub, POD, PROFILE)["apply_gen"])
        before = gen()
        self.login()
        self.assertEqual(self.refreshed, [PROFILE])
        self.assertEqual(gen(), before)                                         # 목록이 이미 맞으면 「지금 적용」 세대를 올리지 않는다
        self.refresh_changes = True
        self.set_row(next_check_at=0)
        self.login()
        self.assertEqual(gen(), before + 1)                                     # 다시 썼으면 떠 있는 게이트웨이에 「지금 적용」

    def test_idp_401_backs_off_after_24(self):
        self.connect()
        self.set_row(auto_streak=mc.IDP_STREAK - 1, next_check_at=0)
        self.wiki.fail = {("GET", "tokens"): mc.MindwikiHTTPError(401)}
        self.login()
        self.assertEqual(mc._row(self.sub, POD, PROFILE)["next_check_at"], self.clock[0] + mc.CHECK_EVERY)

    def test_drain_is_capped_per_check(self):
        self.connect()
        with mc._conn() as conn:
            for i in range(12):
                mc._queue_delete(conn, self.sub, POD, PROFILE, f"gone-{i}", "ws-1")
        self.set_row(next_check_at=0)
        self.wiki.calls.clear()
        self.login()
        self.assertEqual(len([c for c in self.wiki.calls if c[0] == "DELETE"]), mc.MAX_DRAIN)

    def test_owner_changed_rows_are_not_checked(self):
        self.connect()
        self.set_row(next_check_at=0)
        self.host.owner = False
        self.wiki.calls.clear()
        self.login()
        self.assertEqual(self.wiki.calls, [])

    # ---- 자동 첫 연결(UC1: 넣음) -------------------------------------------------------------------------------------

    def test_auto_first_connect_and_opt_out(self):
        self.host.targets = [(POD, PROFILE)]
        with mock.patch.dict(os.environ, {"AAS_MINDWIKI_AUTO_CONNECT": "true"}):
            self.assertEqual(self.login(), 1)
            st = mc.state(self.sub, POD, PROFILE)
            # 자동 첫 연결도 쓰기 허용으로 연결한다(사용자 결정 2026-11-15). 쓰기 토큰은 30일
            self.assertEqual((st["status"], st["write"], st["auto_connected"]), ("connected", True, True))
            self.assertEqual(self.wiki.tokens["tid-1"]["days"], 30)
            self.assertEqual(self.attached[-1][1], True)
            mc.ack(self.sub, POD, PROFILE)
            self.assertFalse(mc.state(self.sub, POD, PROFILE)["auto_connected"])
            self.assertEqual(mc.forget(POD, PROFILE, opt_out=True), 1)    # 사람이 MCP 서버를 지웠다
            self.assertEqual(mc.state(self.sub, POD, PROFILE)["status"], "opted_out")
            self.clock[0] += mc.CHECK_EVERY + 1
            self.assertEqual(self.login(), 0)                               # 다시 연결하지 않는다
        self.assertIn("tid-1", self.jobs())

    def test_auto_first_connect_falls_back_to_read_only_when_write_tokens_are_off(self):
        self.host.targets = [(POD, PROFILE)]
        self.wiki.no_write = True                                          # 쓰기 토큰을 막은 MindWiki 설치에서도 자동 연결은 된다(읽기로)
        with mock.patch.dict(os.environ, {"AAS_MINDWIKI_AUTO_CONNECT": "true"}):
            self.assertEqual(self.login(), 1)
        st = mc.state(self.sub, POD, PROFILE)
        self.assertEqual((st["status"], st["write"], st["auto_connected"], st["auto_reason"]), ("connected", False, True, ""))
        self.assertEqual(self.wiki.tokens["tid-1"]["days"], 90)

    def test_automation_profile_connects_to_the_automations_workspace(self):
        """자동화 전용 프로파일(스펙 2026-11-15-002 D23·D24): 워크스페이스가 여럿이어도 웹훅이 적어 둔 워크스페이스로, 자동화 전용 쓰기 토큰."""
        self.wiki.workspaces = [{"id": "ws-1", "slug": "dev"}, {"id": "ws-2", "slug": "sales"}]
        mc.want_auto(self.sub, POD, "mindwiki-auto", "ws-2")
        self.addCleanup(lambda: mc.forget(POD, "mindwiki-auto"))
        with mock.patch.dict(os.environ, {"AAS_MINDWIKI_AUTO_CONNECT": "true"}):
            self.assertEqual(self.login(), 1)
        r = mc._row(self.sub, POD, "mindwiki-auto")
        self.assertEqual((r["status"], r["workspace"], r["write"]), ("connected", "ws-2", 1))
        self.assertTrue(self.wiki.tokens[r["tid"]].get("automation"))

    def test_automation_profile_does_not_fall_back_to_read_only(self):
        self.wiki.no_write = True
        mc.want_auto(self.sub, POD, "mindwiki-auto", "ws-1")
        self.addCleanup(lambda: mc.forget(POD, "mindwiki-auto"))
        with mock.patch.dict(os.environ, {"AAS_MINDWIKI_AUTO_CONNECT": "true"}):
            self.login()
        r = mc._row(self.sub, POD, "mindwiki-auto")
        self.assertEqual((r["status"], r["tid"], r["auto_reason"]), ("idle", "", "write_disabled"))   # 읽기 토큰을 받지 않는다

    def test_auto_first_connect_skips_when_the_workspace_is_ambiguous(self):
        self.host.targets = [(POD, PROFILE)]
        self.wiki.workspaces = [{"id": "ws-1", "slug": "dev"}, {"id": "ws-2", "slug": "sales"}]
        with mock.patch.dict(os.environ, {"AAS_MINDWIKI_AUTO_CONNECT": "true"}):
            self.login()
            r = mc._row(self.sub, POD, PROFILE)
            self.assertEqual((r["status"], r["tid"], r["auto_reason"]), ("idle", "", "need_workspace"))
            self.wiki.calls.clear()
            self.assertEqual(self.login(), 0)                               # 12시간 안에는 다시 묻지 않는다
            self.clock[0] += mc.CHECK_EVERY + 1
            self.assertEqual(self.login(), 1)


class MigrationTest(unittest.TestCase):
    """2단계 표만 있는 DB(OKE)에 3단계 칸이 생긴다(A12)."""

    def test_old_table_gets_new_columns(self):
        with mock.patch.dict(os.environ, {"AAS_DATA_DIR": str(Path(os.environ.get("AAS_DATA_DIR", "/tmp")) / ("mw-mig-" + os.urandom(3).hex()))}):
            store.data_dir().mkdir(parents=True, exist_ok=True)
            old = mc.SCHEMA.split("prev_tid TEXT")[0].rstrip().rstrip(",") + ", PRIMARY KEY (product, sub, pod, profile));"
            conn = sqlite3.connect(store.data_dir() / "aas.db")
            conn.executescript(old)
            conn.close()
            with mc._conn() as c:
                cols = {r[1] for r in c.execute("PRAGMA table_info(connector_tokens)")}
            self.assertTrue({"prev_tid", "apply_gen", "next_check_at", "auto_reason"} <= cols)
            mc._MIGRATED.clear()
            with mc._conn():                                                # 두 번 돌아도(다른 서버) 실패하지 않는다
                pass



class HostTest(unittest.TestCase):
    """server._MindwikiHost: 요청 밖에서 붙이기 공장을 만든다(3-1)."""

    def setUp(self):
        from aas.web import server
        self.server = server
        self.pod = mock.Mock(id=POD, container="c")
        self.pod.owned_by = lambda who: who["sub"] == "me"
        reg = mock.Mock(pods=[self.pod])
        self.patches = [mock.patch.object(server, "registry", return_value=reg), mock.patch.object(server, "hub", return_value=mock.Mock(auth=None))]
        for p in self.patches:
            p.start()

    def tearDown(self):
        for p in self.patches:
            p.stop()

    def test_another_owner_gets_nothing(self):
        with mock.patch.object(self.server, "_profile_rows", return_value=[{"name": PROFILE, "is_default": True}]):
            self.assertIsNone(self.server._MindwikiHost().attach_for("someone", "x@corp", POD, PROFILE))
            self.assertIsNotNone(self.server._MindwikiHost().attach_for("me", "a@corp", POD, PROFILE))

    # OKE(2026-11-15): 「지금 적용」 직후 게이트웨이가 다시 뜨는 동안 프로파일 목록에 main 이 없어 주인이 바뀐 것처럼
    # skipped_owner 로 12시간을 미뤘다. 프로파일을 지우면 행도 지우므로(forget) 목록에 없음은 잠시 준비 안 됨이다
    def test_profile_missing_while_gateway_restarts_is_not_ready(self):
        with mock.patch.object(self.server, "_profile_rows", return_value=[]):
            with self.assertRaises(mc.Failed) as cm:
                self.server._MindwikiHost().attach_for("me", "a@corp", POD, PROFILE)
        self.assertEqual(cm.exception.reason, "hermes_not_ready")


if __name__ == "__main__":
    unittest.main()

# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""「메신저 연결」의 「연결 삭제」 — profile/action channel_remove(스펙 2026-11-24-005, OMAI-2200).

  화면 확인 → channel_remove {platform}
    ├─ Hermes 직접 읽기(캐시 없음) → is_set 이름 + 승인 목록
    ├─ 주인이면 owner_guard 허용 이름만 지우고 나머지는 kept
    ├─ Hermes PUT {clear_env, enabled:false}  ── 실패하면 여기서 멈춘다
    ├─ 캐시 버리기(channels·chanhermes) → _messenger_sync
    ├─ 다시 시작 필요 기록(hot_served 와 상관없이 — 켜져 있던 봇은 다시 시작해야 멈춘다)
    └─ 승인 철회: messenger_links 줄 + 그 밖의 승인 사용자

Hermes 대시보드 API 는 대역(FakeApi)으로 바꾼다."""
import copy
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

TMP = tempfile.TemporaryDirectory()
os.environ.setdefault("AAS_DATA_DIR", str(Path(TMP.name) / "data"))

from aas.common import store  # noqa: E402
from aas.fleet import pods  # noqa: E402
from aas.hermes.hermes_api import HermesError  # noqa: E402
from aas.ops import messenger_links  # noqa: E402
from aas.ops import restart_pending as rp  # noqa: E402

POD = "rmkim"


class FakeApi:
    """slack 은 켜져 있고(봇이 돈다) 토큰 둘·관리자가 넣은 인가 변수 하나가 있다. 승인 사용자는 연결 줄이 있는 U1 과 없는 U2(외부인)."""

    def __init__(self):
        self.calls = []
        self.hot_served = True
        self.put_fail = False
        self.revoke_fail = False
        self.env_vars = [{"key": "SLACK_BOT_TOKEN", "required": True, "is_set": True},
                         {"key": "SLACK_APP_TOKEN", "required": True, "is_set": True},
                         {"key": "SLACK_ALLOWED_USERS", "required": False, "is_set": False},
                         {"key": "SLACK_ALLOW_ALL_USERS", "required": False, "is_set": True}]
        self.error_message = ""
        self.approved = [{"platform": "slack", "user_id": "U1", "user_name": "kim"}, {"platform": "slack", "user_id": "U2", "user_name": "guest"},
                         {"platform": "telegram", "user_id": "42", "user_name": "tg"}]

    def call(self, method, path, body=None, query=None, timeout=30):
        self.calls.append((method, path, copy.deepcopy(body), copy.deepcopy(query)))
        if path == "/api/messaging/platforms" and method == "GET":
            return {"platforms": [{"id": "slack", "name": "Slack", "enabled": True, "configured": True, "state": "connected",
                                   "error_message": self.error_message, "env_vars": copy.deepcopy(self.env_vars)}]}
        if path == "/api/pairing" and method == "GET":
            return {"pending": [], "approved": copy.deepcopy(self.approved)}
        if path.startswith("/api/messaging/platforms/") and method == "PUT":
            if self.put_fail:
                raise HermesError("boom", 500)
            return {"ok": True, "hot_served": self.hot_served}
        if path == "/api/pairing/revoke":
            if self.revoke_fail:
                raise HermesError("down", 502)
            return {"ok": True}
        return {"ok": True}

    def puts(self):
        return [c for c in self.calls if c[0] == "PUT"]

    def revoked(self):
        return sorted((c[2]["platform"], c[2]["user_id"]) for c in self.calls if c[1] == "/api/pairing/revoke")


def clean():
    with store.connect() as conn:
        for table in ("restart_pending", "restart_lock"):
            conn.execute(f"DELETE FROM {table} WHERE pod=?", (POD,))
    with messenger_links._conn() as conn:
        for table in ("messenger_links", "messenger_revoke_queue"):
            conn.execute(f"DELETE FROM {table} WHERE pod=?", (POD,))
    rp._starts.clear()


class ChannelRemoveTest(unittest.TestCase):
    def setUp(self):
        from aas.web import messenger_api, server
        clean()
        self.addCleanup(clean)
        self.s = server
        self.pod = pods.Pod(POD, "kim@x.com", "/tmp")
        reg = pods.Registry.__new__(pods.Registry)
        reg.pods, reg.admins, reg.restarting = [self.pod], set(), []
        reg.is_admin = lambda u: False
        self.api = FakeApi()
        self.order = []
        rows = [{"name": "default", "is_default": True}, {"name": "main", "is_default": False}, {"name": "work", "is_default": False}]
        for target, name, value in ((server, "registry", lambda: reg), (server, "_profile_rows", lambda pod: rows),
                                    (server, "hub", lambda pod: mock.Mock(auth=None)), (server, "HermesAPI", lambda auth: self.api),
                                    (messenger_api, "HermesAPI", lambda auth: self.api),
                                    (server, "_messenger_sync", lambda pod: self.order.append("sync") or []),
                                    (server, "_drop_pod_key", lambda pod, *keys: self.order.append(("drop", *keys)))):
            p = mock.patch.object(target, name, value)
            p.start()
            self.addCleanup(p.stop)
        messenger_links.record(POD, "main", "slack", {"user_id": "U1", "user_name": "kim", "chat_id": "D1"}, "kim@x.com")
        messenger_links.record(POD, "work", "slack", {"user_id": "U9", "user_name": "kim", "chat_id": "D9"}, "kim@x.com")      # 다른 프로파일
        messenger_links.record(POD, "main", "telegram", {"user_id": "42", "user_name": "tg", "chat_id": "42"}, "kim@x.com")   # 다른 메신저

    def act(self, owner=True, **body):
        return self.s._profile_action(self.pod, {"action": "channel_remove", "name": "main", "platform": "slack", "_owner": owner, **body}, "kim@x.com")

    def links(self):
        return sorted((r["profile"], r["platform"], r["platform_user_id"]) for r in messenger_links.links(POD))

    def test_주인은_허용_이름만_지우고_끄며_남은_이름을_kept_로(self):
        out = self.act()
        (put,) = self.api.puts()
        self.assertEqual(put[1], "/api/messaging/platforms/slack")
        self.assertEqual((sorted(put[2]["clear_env"]), put[2]["enabled"], put[2]["env"]), (["SLACK_APP_TOKEN", "SLACK_BOT_TOKEN"], False, {}))
        self.assertEqual((sorted(out["cleared"]), out["kept"]), (["SLACK_APP_TOKEN", "SLACK_BOT_TOKEN"], ["SLACK_ALLOW_ALL_USERS"]))
        self.assertEqual(put[3], {"profile": "main"})

    def test_관리자는_설정된_변수를_모두_지운다(self):
        out = self.act(owner=False)
        self.assertEqual(sorted(self.api.puts()[0][2]["clear_env"]), ["SLACK_ALLOW_ALL_USERS", "SLACK_APP_TOKEN", "SLACK_BOT_TOKEN"])
        self.assertEqual(out["kept"], [])

    def test_채널_캐시를_거치지_않고_Hermes_를_읽는다(self):
        stale = {"platforms": [{"id": "slack", "enabled": True, "configured": True,
                                "env_vars": [{"key": "SLACK_BOT_TOKEN", "required": True, "is_set": True}]}], "pairing": {"pending": [], "approved": []}}
        with mock.patch.object(self.s, "_profile_channels", lambda *a: stale):
            out = self.act()
        self.assertEqual(sorted(out["cleared"]), ["SLACK_APP_TOKEN", "SLACK_BOT_TOKEN"])

    def test_https_가_아니어도_지운다(self):
        out = self.act(_secure=False)
        self.assertTrue(out["ok"])

    def test_hot_served_여도_다시_시작_필요를_기록한다(self):
        self.api.hot_served = True
        out = self.act()
        self.assertIn({"profile": "main", "kind": "channel", "target": "slack"}, out["restart_pending"])
        self.assertIn(("main", "channel", "slack"), [(r["profile"], r["kind"], r["target"]) for r in rp.all_items(POD)])

    def test_캐시는_messenger_sync_앞에서_버린다(self):
        self.act()
        drops = [i for i, x in enumerate(self.order) if isinstance(x, tuple) and "channels" in x]
        self.assertTrue(drops, self.order)
        self.assertLess(drops[0], self.order.index("sync"))
        self.assertIn(("drop", "channels", "chanhermes:main:0", "chanhermes:main:1"), self.order)

    def test_그_메신저의_승인을_모두_철회한다(self):
        out = self.act()
        self.assertEqual(self.api.revoked(), [("slack", "U1"), ("slack", "U2")])     # 연결 줄이 있는 U1, 없는 외부인 U2. telegram 42 는 그대로
        self.assertEqual(self.links(), [("main", "telegram", "42"), ("work", "slack", "U9")])
        self.assertEqual(out["revoked"], 2)

    def test_철회가_실패하면_재시도_큐에(self):
        self.api.revoke_fail = True
        self.act()
        with messenger_links._conn() as conn:
            queued = sorted(r[0] for r in conn.execute("SELECT platform_user_id FROM messenger_revoke_queue WHERE pod=?", (POD,)).fetchall())
        self.assertEqual(queued, ["U1", "U2"])

    def test_PUT_이_실패하면_철회하지_않는다(self):
        self.api.put_fail = True
        with self.assertRaises(HermesError):
            self.act()
        self.assertEqual(self.api.revoked(), [])
        self.assertIn(("main", "slack", "U1"), self.links())

    def test_같은_토큰_중복_오류가_있었으면_duplicate(self):
        self.api.error_message = "Profile 'personal_agenta' and 'main' both configure slack with the same credential."
        self.assertTrue(self.act()["duplicate"])

    def test_숨긴_루트는_막는다(self):
        with mock.patch.object(self.s.cron_policy, "root_hidden", lambda pid: True), self.assertRaises(ValueError):
            self.s._profile_action(self.pod, {"action": "channel_remove", "name": "default", "platform": "slack", "_owner": False}, "kim@x.com")


class GuardTextTest(unittest.TestCase):
    def test_채널_변수_안내는_메신저_연결_탭(self):
        from aas.ops import owner_guard
        msg = owner_guard.env_key_error("SLACK_BOT_TOKEN", {"SLACK_BOT_TOKEN": "messaging"})
        self.assertIn("「메신저 연결」", msg)
        self.assertNotIn("「채널」", msg)

    def test_주인이_할_수_있는_동작에_channel_remove(self):
        from aas.web import server
        self.assertIn("channel_remove", server.OWNER_PROFILE_ACTIONS)
        self.assertNotIn("channel_remove", server.EDIT_MEMBER_ACTIONS)


if __name__ == "__main__":
    unittest.main()

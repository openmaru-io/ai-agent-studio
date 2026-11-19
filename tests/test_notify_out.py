# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""알림 전달 단계 4(스펙 2026-11-17-008 §6): 한 번만·한도·끄기·받는 곳·글·서명·웹훅 경로·예약 작업 키·정책 예외·홈 채널."""
import hashlib
import hmac
import json
import os
import tempfile
import threading
import unittest
from pathlib import Path
from unittest import mock

TMP = tempfile.TemporaryDirectory()
os.environ.setdefault("AAS_DATA_DIR", str(Path(TMP.name) / "data"))

from aas.common import store  # noqa: E402
from aas.ops import cron_policy, notify_out as n, owner_guard  # noqa: E402


def clear():
    with store.connect() as conn:
        conn.executescript(n.SCHEMA)
        for t in ("notify_sent", "notify_rate", "notify_secrets", "notify_prefs", "cron_creators"):
            conn.execute(f"DELETE FROM {t}")
        conn.execute("DELETE FROM meta WHERE key=?", (n.SETTING_KEY,))
    n._routes_done.clear()


class FakeApi:
    def __init__(self):
        self.files, self.calls = {}, []

    def call(self, method, path, body=None, query=None):
        self.calls.append((method, path))
        if path == "/api/fs/read-text":
            if query["path"] not in self.files:
                raise FileNotFoundError(query["path"])
            return {"content": self.files[query["path"]]}
        if path == "/api/fs/write-text":
            self.files[body["path"]] = body["content"]
            return {"path": body["path"]}
        return {}


LINK = {"pod": "kim", "profile": "main", "platform": "telegram", "platform_user_id": "777", "dm_chat_id": "", "email": "lee@x.com", "lang": "ko"}
POD = mock.Mock(id="kim", dashboard_url="http://hag-kim.agents.svc:9119")


class NotifyTest(unittest.TestCase):
    def setUp(self):
        clear()
        self.addCleanup(clear)
        p = mock.patch.dict(os.environ, {"AAS_NOTIFY_WEBHOOK": "1", "AAS_PUBLIC_URL": "https://aas.example"})
        p.start()
        self.addCleanup(p.stop)
        self.api = FakeApi()
        self.posts = []
        q = mock.patch.object(n, "post", side_effect=lambda url, secret, text, chat, key: self.posts.append((url, text, chat)) or True)
        q.start()
        self.addCleanup(q.stop)

    def send(self, key="item-1", links=(LINK,), email="lee@x.com", kind="approval", now=1000.0):
        return n.deliver(POD, email, kind, "영업 도우미", "https://aas.example/#/chat", key, api=self.api, root_home="/opt/data",
                         is_root_profile=lambda p: False, links=list(links), now=now)

    def test_보내고_같은_알림은_한_번만(self):
        self.assertEqual(self.send(), "sent")
        self.assertEqual(self.send(), "skipped")
        url, text, chat = self.posts[0]
        self.assertEqual((url, chat), ("http://hag-kim.agents.svc:8644/p/main/webhooks/aas-notify-main-telegram", "777"))
        self.assertIn("위험 명령 승인 요청 · 영업 도우미", text)
        self.assertIn("https://aas.example/#/chat", text)

    def test_두_스레드가_동시에_보내도_한_번(self):
        out = []
        ts = [threading.Thread(target=lambda: out.append(self.send(key="race"))) for _ in range(2)]
        [t.start() for t in ts]
        [t.join() for t in ts]
        self.assertEqual(sorted(out), ["sent", "skipped"])
        self.assertEqual(len(self.posts), 1)

    def test_끄면_안_보낸다(self):
        with mock.patch.dict(os.environ, {"AAS_NOTIFY_WEBHOOK": ""}):
            self.assertEqual(self.send(), "skipped")           # 설치에서 웹훅 길이 없다
        n.set_admin_enabled(False)
        self.assertEqual(self.send(key="a"), "skipped")         # 관리자가 껐다
        n.set_admin_enabled(True)
        n.set_person_off("lee@x.com", True)
        self.assertEqual(self.send(key="b"), "skipped")         # 그 사람이 껐다
        self.assertEqual(self.posts, [])

    def test_1분_5개_한도는_묶는다(self):
        got = [self.send(key=f"k{i}", now=1000.0 + i) for i in range(n.RATE_MAX + 2)]
        self.assertEqual(got.count("sent"), n.RATE_MAX)
        self.assertEqual(got[-1], "folded")
        self.assertEqual(self.send(key="later", now=1000.0 + n.RATE_WINDOW + 10), "sent")

    def test_받는_곳(self):
        mm = {**LINK, "platform": "mattermost", "platform_user_id": "u1", "dm_chat_id": ""}
        self.assertEqual(n.targets([mm]), [])                                    # DM id 없는 Mattermost 는 못 보낸다
        self.assertEqual(n.targets([{**mm, "dm_chat_id": "dm9"}])[0]["chat_id"], "dm9")
        self.assertEqual(n.targets([LINK])[0]["chat_id"], "777")                 # 텔레그램은 사람 id 로
        self.assertEqual(self.send(links=[mm]), "skipped")

    def test_글에는_명령을_넣지_않고_받는_사람_언어로(self):
        self.assertEqual(n.message("approval", "영업", "https://x", "en"), "[CogentAI AAS] Approval request for a risky command · 영업\nhttps://x")
        self.assertIn("알림 3개가 더 있습니다", n.message("cron_failed", "영업", "https://x", "ko", extra=3))

    def test_웹훅_경로는_루트_파일에_프로파일_키로(self):
        self.send()
        routes = json.loads(self.api.files["/opt/data/webhook_subscriptions.json"])
        entry = routes["aas-notify-main-telegram"]
        self.assertEqual((entry["profile"], entry["deliver"], entry["deliver_only"], entry["deliver_extra"], entry["prompt"]),
                         ("main", "telegram", True, {"chat_id": "{chat_id}"}, "{message}"))
        self.api.files["/opt/data/webhook_subscriptions.json"] = json.dumps({"other": {"secret": "s"}, **routes})
        n._routes_done.clear()
        self.send(key="again")
        self.assertIn("other", json.loads(self.api.files["/opt/data/webhook_subscriptions.json"]))   # 다른 경로는 그대로
        root = n.route_entry(None, "slack", "s")
        self.assertNotIn("profile", root)                                        # 루트 프로파일은 profile 키 없이(default)

    def test_서명은_Hermes_V2_와_같다(self):
        body = b'{"message":"x"}'
        h = n.sign("sec", body, ts=1700000000)
        self.assertEqual(h["X-Webhook-Timestamp"], "1700000000")
        self.assertEqual(h["X-Webhook-Signature-V2"], hmac.new(b"sec", b"1700000000." + body, hashlib.sha256).hexdigest())

    def test_작업공간마다_비밀은_하나(self):
        self.assertEqual(n._secret("kim"), n._secret("kim"))
        self.assertNotEqual(n._secret("kim"), n._secret("lee"))

    def test_예약_작업을_만든_사람(self):
        n.note_cron_creator("kim", "main", "j1", "Lee@x.com")
        self.assertEqual(n.cron_creator("kim", "main", "j1"), "lee@x.com")
        self.assertEqual(n.creators_to_owner("kim", "lee@x.com"), 1)
        self.assertEqual(n.cron_creator("kim", "main", "j1"), "")


class CronKeyTest(unittest.TestCase):
    def test_첫_실패는_실행마다_계속_실패는_하루_한_번(self):
        from aas.web import notify_hooks
        first = notify_hooks._cron_key("kim", {"profile": "main", "job_id": "j", "streak": 1, "last_run_at": "t1"}, 0)
        again = notify_hooks._cron_key("kim", {"profile": "main", "job_id": "j", "streak": 4, "last_run_at": "t4"}, 0)
        later = notify_hooks._cron_key("kim", {"profile": "main", "job_id": "j", "streak": 5, "last_run_at": "t5"}, 3600)
        self.assertEqual(first, ("cron|kim|main|j|t1", "cron_failed"))
        self.assertEqual(again[1], "cron_still_failing")
        self.assertEqual(again[0], later[0])                                       # 같은 날이면 같은 키 — 한 번만


class PolicyTest(unittest.TestCase):
    def test_연결표의_대화방만_주인에게_열린다(self):
        self.assertTrue(cron_policy.deliver_error("kim", "telegram:999", False))
        self.assertEqual(cron_policy.deliver_error("kim", "telegram:777", False, {"telegram:777"}), "")
        self.assertEqual(cron_policy.deliver_error("kim", "telegram", False), "")      # 홈 채널(팀 공지)은 예전처럼

    def test_팀_공지_대화방_id_형식(self):
        self.assertEqual(owner_guard.channel_env_check("telegram", "TELEGRAM_HOME_CHANNEL", "-1001234567890"), ("", ""))
        self.assertEqual(owner_guard.channel_env_check("telegram", "TELEGRAM_HOME_CHANNEL", "abc")[0], "home_channel_invalid")
        self.assertEqual(owner_guard.channel_env_check("slack", "SLACK_HOME_CHANNEL", "C0123ABCD"), ("", ""))
        self.assertEqual(owner_guard.channel_env_check("mattermost", "MATTERMOST_HOME_CHANNEL", "a" * 26), ("", ""))


class InboxHookTest(unittest.TestCase):
    def test_새_승인_항목은_메신저로도(self):
        from aas.office.inbox import Pending
        p, got = Pending(clock=lambda: 1.0), []
        p.on_new = lambda k, v: got.append((v["kind"], v["to"]))
        p.on_chat("kim", "s1", "ma", "kim@x.com", "aas.user", {"_by": "lee@x.com"})
        p.on_chat("kim", "s1", "ma", "kim@x.com", "approval.request", {"request_id": "r1", "command": "rm x"})
        p.on_chat("kim", "s1", "ma", "kim@x.com", "message.delta", {"text": "..."})       # 항목이 그대로면 다시 부르지 않는다
        self.assertEqual(got, [("approval", ["lee@x.com"])])


if __name__ == "__main__":
    unittest.main()

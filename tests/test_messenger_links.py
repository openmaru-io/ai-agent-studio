# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""메신저 연결 단계 3(스펙 2026-11-17-008 §5): 내 메신저 계정 연결·한도·철회와 다시 시도·페어링 켜고 끄기·소유자 알림.
Hermes 대시보드 API 는 대역(FakeApi)으로 바꾼다."""
import os
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

TMP = tempfile.TemporaryDirectory()
os.environ.setdefault("AAS_DATA_DIR", str(Path(TMP.name) / "data"))

from aas.common import store  # noqa: E402
from aas.fleet import pods, sharing  # noqa: E402
from aas.hermes.hermes_api import HermesError  # noqa: E402
from aas.ops import messenger_links as ml, workspace_notices  # noqa: E402

OWNER = {"email": "kim@x.com", "sub": "sub-kim"}
USER = {"email": "user@x.com", "sub": "sub-user"}
STRANGER = {"email": "nobody@x.com", "sub": "sub-nobody"}


class FakeApi:
    """Hermes 대시보드 API 대역. calls 에 (method, path, body, query) 를 남긴다."""
    def __init__(self):
        self.calls, self.config, self.fail = [], {}, None
        self.approve = {"ok": True, "user": {"user_id": "777", "user_name": "@user", "chat_id": "dm-777"}}

    def call(self, method, path, body=None, query=None):
        self.calls.append((method, path, body, query))
        if self.fail:
            raise self.fail
        if path == "/api/pairing/approve":
            return self.approve
        if path == "/api/config" and method == "GET":
            return self.config
        if path == "/api/config" and method == "PUT":
            plat = body["config"]["platforms"]
            for name, v in plat.items():
                self.config.setdefault("platforms", {}).setdefault(name, {}).setdefault("extra", {}).update(v["extra"])
            return {"ok": True}
        return {"ok": True}


def clear():
    with store.connect() as conn:
        conn.executescript(ml.SCHEMA)
        for t in ("messenger_links", "messenger_revoke_queue", "messenger_link_tries"):
            conn.execute(f"DELETE FROM {t}")
        conn.execute(pods.Registry.MEMBER_SCHEMA)
        conn.execute("DELETE FROM workspace_members")
        conn.execute("DELETE FROM meta WHERE key LIKE 'messenger_restart:%' OR key LIKE 'owner_sharing%'")
        conn.execute("DELETE FROM restart_pending WHERE pod='kim'")       # 다시 시작 장부(스펙 2026-11-18-016)
        conn.executescript(workspace_notices.SCHEMA)
        conn.execute("DELETE FROM workspace_notice_ack")
    sharing._cache.clear()


class MessengerTest(unittest.TestCase):
    def setUp(self):
        from aas.web import messenger_api, server
        clear()
        self.addCleanup(clear)
        self.server, self.m = server, messenger_api
        self.kim = pods.Pod("kim", "kim@x.com", "/tmp")
        reg = pods.Registry.__new__(pods.Registry)
        reg.pods, reg.admins = [self.kim], set()
        reg.grants = lambda: {}
        reg.is_admin = lambda u: bool((u or {}).get("admin"))
        reg.team_pods = lambda u: []
        self.reg = reg
        reg.set_member("kim", "user@x.com", "use", "kim@x.com")
        self.api = FakeApi()
        chans = {"profiles": [{"name": "main", "platforms": [{"name": "telegram", "configured": True, "state": "connected"},
                                                             {"name": "whatsapp", "configured": True, "state": "connected"}]}]}
        for target, name, value in ((server, "registry", lambda: reg), (server, "_channels", lambda pod: chans),
                                    (server, "_profile_rows", lambda pod: [{"name": "main", "is_default": False}]),
                                    (server, "hub", lambda pod: mock.Mock(auth=None)), (server, "_drop_pod_key", lambda *a: None),
                                    (messenger_api, "HermesAPI", lambda auth: self.api)):
            p = mock.patch.object(target, name, value)
            p.start()
            self.addCleanup(p.stop)

    def link(self, who=USER, code="abcd 2345", **kw):
        return self.m.link(self.reg, who, True, {"pod": "kim", "op": "link", "profile": "main", "platform": "telegram", "code": code, **kw})

    def test_봇_목록은_네_메신저만(self):
        self.assertEqual([b["platform"] for b in self.m.bots(self.kim)], ["telegram"])

    def test_구성원이_코드로_잇고_소유자가_알림을_받는다(self):
        out = self.link()
        self.assertEqual((out["link"]["platform_user_id"], out["link"]["dm_chat_id"], out["delivery"]), ("777", "dm-777", True))
        sent = [c for c in self.api.calls if c[1] == "/api/pairing/approve"][0]
        self.assertEqual(sent[2], {"platform": "telegram", "code": "ABCD2345", "profile": "main"})     # code 로만, request_id 없음
        self.assertEqual([r["email"] for r in ml.links("kim")], ["user@x.com"])
        items = self.m.owner_items(self.reg, "kim@x.com")
        self.assertEqual([(i["kind"], i["user_name"]) for i in items], [("messenger_linked", "@user")])
        self.assertEqual(self.m.owner_items(self.reg, "user@x.com"), [])

    def test_구성원이_아니면_못_잇는다(self):
        with self.assertRaises(self.m.MessengerError) as cm:
            self.link(STRANGER)
        self.assertEqual(cm.exception.code, 403)

    def test_형식이_틀린_코드는_Hermes_를_부르지_않는다(self):
        for bad in ("abc", "ABCD234O", "A" * 16):
            with self.assertRaises(self.m.MessengerError) as cm:
                self.link(code=bad)
            self.assertEqual(cm.exception.reason, "code_format")
        self.assertEqual(self.api.calls, [])

    def test_틀린_코드와_잠김(self):
        self.api.fail = HermesError("not found", 404)
        with self.assertRaises(self.m.MessengerError) as cm:
            self.link()
        self.assertEqual(cm.exception.reason, "code_invalid")
        self.api.fail = HermesError("locked", 429)
        with self.assertRaises(self.m.MessengerError) as cm:
            self.link()
        self.assertEqual(cm.exception.reason, "hermes_locked")

    def test_사람마다_한도와_봇마다_한도(self):
        self.api.fail = HermesError("not found", 404)
        for _ in range(ml.PER_PERSON):
            with self.assertRaises(self.m.MessengerError):
                self.link()
        with self.assertRaises(self.m.MessengerError) as cm:
            self.link()
        self.assertEqual(cm.exception.reason, "aas_limit")
        self.reg.set_member("kim", "two@x.com", "use", "kim@x.com")
        with self.assertRaises(self.m.MessengerError):         # 봇 전체 4번째
            self.link({"email": "two@x.com"})
        with self.assertRaises(self.m.MessengerError) as cm:
            self.link({"email": "two@x.com"})
        self.assertEqual(cm.exception.reason, "aas_limit")

    def test_해제는_본인과_소유자만_Hermes_에서도_뺀다(self):
        self.link()
        with self.assertRaises(self.m.MessengerError):
            self.m.unlink(self.reg, STRANGER, True, {"pod": "kim", "profile": "main", "platform": "telegram", "user_id": "777"})
        self.m.unlink(self.reg, OWNER, True, {"pod": "kim", "profile": "main", "platform": "telegram", "user_id": "777"})
        self.assertEqual(ml.links("kim"), [])
        self.assertIn(("POST", "/api/pairing/revoke"), [(c[0], c[1]) for c in self.api.calls])

    def test_구성원을_빼면_철회하고_실패하면_큐에서_다시(self):
        self.link()
        self.api.fail = ConnectionError("pod down")
        self.assertEqual(self.m.member_removed(self.reg, self.kim, "user@x.com"), 1)
        self.assertEqual(ml.links("kim"), [])
        self.assertEqual(len(ml.due_revokes(now=10**12)), 1)
        self.api.fail = None
        with mock.patch.object(ml.time, "time", return_value=10**12):
            self.assertEqual(self.m.retry_revokes(self.reg), 1)
        self.assertEqual(ml.due_revokes(now=10**13), [])

    def test_페어링은_구성원이_있으면_켜고_없으면_끈다(self):
        self.assertEqual(self.m.sync_pairing(self.reg, self.kim), ["main"])
        self.assertEqual(self.api.config["platforms"]["telegram"]["extra"]["dm_policy"], "pairing")
        self.assertEqual(self.m._restart_needed("kim"), ["main"])
        self.assertEqual(self.m.sync_pairing(self.reg, self.kim), [])                 # 같은 값이면 다시 쓰지 않는다
        self.reg.set_member("kim", "user@x.com", "none", "kim@x.com")
        self.assertEqual(self.m.sync_pairing(self.reg, self.kim), ["main"])
        self.assertEqual(self.api.config["platforms"]["telegram"]["extra"]["dm_policy"], "")

    def test_직접_고른_다른_정책은_건드리지_않는다(self):
        self.api.config = {"platforms": {"telegram": {"extra": {"dm_policy": "allowlist"}}}}
        self.assertEqual(self.m.sync_pairing(self.reg, self.kim), [])
        self.assertEqual(self.api.config["platforms"]["telegram"]["extra"]["dm_policy"], "allowlist")

    def test_다시_시작은_소유자만_적어_둔_프로파일을(self):
        self.m.sync_pairing(self.reg, self.kim)
        with self.assertRaises(self.m.MessengerError):
            self.m.apply(self.reg, USER, True, {"pod": "kim"})
        from aas.ops import restart_pending
        self.assertEqual([(r["kind"], r["target"]) for r in restart_pending.all_items("kim")], [("pairing", "telegram")])

        def mcp_apply(pod, body, who):                      # 기록 지우기는 mcp_apply 가 한다(스펙 2026-11-18-016 4-3)
            restart_pending.clear(pod.id, [body["name"]], before=time.time() + 1)
            return {"ok": True}
        with mock.patch.object(self.server, "_profile_action", side_effect=mcp_apply) as act:
            self.assertEqual(self.m.apply(self.reg, OWNER, True, {"pod": "kim"})["restarted"], ["main"])
        act.assert_called_once()
        self.assertEqual(act.call_args.args[1], {"action": "mcp_apply", "name": "main"})
        self.assertEqual(self.m._restart_needed("kim"), [])

    def test_보기는_내_연결과_봇(self):
        self.link()
        got = self.m.view(self.reg, USER, True, "kim")
        self.assertEqual((got["can_link"], [b["platform"] for b in got["bots"]], [x["platform_user_id"] for x in got["mine"]]), (True, ["telegram"], ["777"]))
        self.assertEqual(got["restart_needed"], [])                  # 구성원에게는 보이지 않는다


class CodeTest(unittest.TestCase):
    def test_코드_정리(self):
        self.assertEqual(ml.clean_code(" abcd 2345 "), "ABCD2345")
        self.assertEqual(ml.clean_code("0123ABCD"), "")             # 0·1 은 Hermes 코드에 없다
        self.assertEqual(ml.clean_code("ABCDEFGHJK"), "")


if __name__ == "__main__":
    unittest.main()

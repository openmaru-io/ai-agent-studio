# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""MindWiki 가 항목 주인의 프로파일 목록을 묻는 끝점 /api/mindwiki/profiles(스펙 2026-11-21-002 §3-6, 위키 스펙 2026-11-23-003).
서명(delivery 0 만), 몸 검사, 주인 파드만 보기, 웹훅이 거절할 이름 빼기, 여러 파드에 있는 이름, 답하지 않은 파드, 복제본 세 상태를 본다.
Hermes 는 가짜다."""
import hashlib
import hmac
import json
import os
import tempfile
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

TMP = tempfile.TemporaryDirectory()
os.environ.setdefault("AAS_DATA_DIR", str(Path(TMP.name) / "data"))

import anyio  # noqa: E402
from starlette.requests import Request  # noqa: E402

from aas.ops import mindwiki_auto_clone as clones  # noqa: E402
from aas.web import mindwiki_webhook as route  # noqa: E402

SECRET = "d" * 32
INSTALL = "inst-profiles"


def _post(body: bytes, delivery="0", secret=SECRET):
    t = int(time.time())
    mac = hmac.new(secret.encode(), f"{t}.{INSTALL}.{delivery}.".encode() + body, hashlib.sha256).hexdigest()
    headers = {"x-mindwiki-installation": INSTALL, "x-mindwiki-delivery": delivery, "x-mindwiki-signature": f"t={t},sha256={mac}"}
    scope = {"type": "http", "method": "POST", "path": route.PROFILES_PATH, "query_string": b"", "scheme": "https",
             "headers": [(k.encode(), v.encode()) for k, v in headers.items()], "server": ("aas", 443), "client": ("10.0.0.1", 1), "root_path": ""}
    parts = [body]

    async def receive():
        if not parts:
            return {"type": "http.disconnect"}
        return {"type": "http.request", "body": parts.pop(0), "more_body": False}

    resp = anyio.run(route.profiles_list, Request(scope, receive))
    return resp.status_code, json.loads(resp.body)


def _body(sub="alice", email=""):
    return json.dumps({"owner": {"sub": sub, "email": email}}).encode()


class Pod(SimpleNamespace):
    def owned_by(self, user):
        return (bool(user.get("sub")) and user.get("sub") == self.owner_sub) or (bool(user.get("email")) and user.get("email") == self.owner)


PROFILES: dict = {}     # 파드 id → [Hermes 프로파일 줄]
CONFIG: dict = {}       # (파드 id, 프로파일) → 설정 글
SLOW: set = set()


class FakeAPI:
    def __init__(self, auth):
        self.pod = auth

    def call(self, method, path, body=None, query=None, timeout=30):
        if self.pod in SLOW:
            time.sleep(1.5)
        if (method, path) == ("GET", "/api/profiles"):
            return {"profiles": PROFILES[self.pod]}
        if (method, path) == ("GET", "/api/config/raw"):
            return {"yaml": CONFIG.get((self.pod, query["profile"]), "")}
        raise AssertionError((method, path))


class ProfilesTest(unittest.TestCase):
    def setUp(self):
        self.shas: dict = {}
        for p in (mock.patch.dict(os.environ, {"AAS_MINDWIKI_WEBHOOK_SECRET": SECRET}),
                  mock.patch.object(route, "HermesAPI", FakeAPI),
                  mock.patch.object(route.server, "hub", lambda pod: SimpleNamespace(auth=pod.id)),
                  mock.patch.object(route.server, "_pod_label", lambda pod, names=None: {"name": f"에이전트 {pod.id}", "owner_name": "앨리스"}),
                  mock.patch.object(route, "office_names", lambda: {}),
                  mock.patch.object(route.clones, "get", lambda pod, name: {"template_sha": self.shas[(pod, name)]} if (pod, name) in self.shas else None),
                  mock.patch.object(route, "PROFILES_DEADLINE", 1.0)):
            p.start()
            self.addCleanup(p.stop)
        PROFILES.clear()
        CONFIG.clear()
        SLOW.clear()
        self.reg = SimpleNamespace(pods=[Pod(id="pod-a", owner_sub="alice", owner="alice@x"), Pod(id="pod-b", owner_sub="bob", owner="bob@x")],
                                   restarting=[])
        p = mock.patch.object(route.server, "registry", lambda: self.reg)
        p.start()
        self.addCleanup(p.stop)

    def test_웹훅이_거절할_이름은_빼고_주인_파드만_본다(self):
        PROFILES["pod-a"] = [{"name": n} for n in ("default", "mindwiki-auto", "mindwiki-auto-web", "mwauto-team", "web-x", "pcimp-1", "Upper")] + [
            {"name": "team", "display_name": "업무 초안", "description": "민원 초안", "model": "qwen"}, {"name": "zeta", "is_default": True}]
        PROFILES["pod-b"] = [{"name": "bobs"}]
        status, body = _post(_body())
        self.assertEqual((status, body["reason"]), (200, "ok"))
        self.assertEqual([p["pod"] for p in body["pods"]], ["pod-a"])          # 남의 파드는 보지 않는다
        pod = body["pods"][0]
        self.assertEqual((pod["name"], pod["owner_name"], pod["reachable"]), ("에이전트 pod-a", "앨리스", True))
        self.assertEqual(pod["profiles"], [{"name": "team", "title": "업무 초안", "description": "민원 초안", "model": "qwen", "clone": "ready",
                                            "web_clone": "none"}])
        self.assertEqual(body["ambiguous"], [])

    def test_이메일로도_주인을_알아보고_파드가_없으면_빈_목록(self):
        PROFILES["pod-b"] = [{"name": "bobs"}]
        status, body = _post(_body(sub="other", email="bob@x"))
        self.assertEqual([p["pod"] for p in body["pods"]], ["pod-b"])
        status, body = _post(_body(sub="nobody"))
        self.assertEqual((status, body["pods"], body["ambiguous"]), (200, [], []))

    def test_여러_파드에_있는_이름과_답하지_않는_파드(self):
        self.reg.pods.append(Pod(id="pod-a2", owner_sub="alice", owner="alice@x"))
        self.reg.restarting = [Pod(id="pod-a3", owner_sub="alice", owner="alice@x")]
        PROFILES["pod-a"] = [{"name": "same"}, {"name": "only"}]
        PROFILES["pod-a2"] = [{"name": "same"}]
        status, body = _post(_body())
        self.assertEqual(body["ambiguous"], ["same"])
        self.assertEqual({p["pod"]: p["reachable"] for p in body["pods"]}, {"pod-a": True, "pod-a2": True, "pod-a3": False})
        SLOW.add("pod-a2")
        status, body = _post(_body())
        self.assertEqual({p["pod"]: (p["reachable"], len(p["profiles"])) for p in body["pods"]},
                         {"pod-a": (True, 2), "pod-a2": (False, 0), "pod-a3": (False, 0)})

    def test_복제본_세_상태(self):
        PROFILES["pod-a"] = [{"name": "t"}, {"name": "mwauto-t"}, {"name": "mwauto-web-t"}, {"name": "u"}]
        CONFIG[("pod-a", "t")] = "model: a\n"
        self.shas[("pod-a", "mwauto-t")] = clones.sha("model: a\n")
        self.shas[("pod-a", "mwauto-web-t")] = clones.sha("model: old\n")
        status, body = _post(_body())
        got = {p["name"]: (p["clone"], p["web_clone"]) for p in body["pods"][0]["profiles"]}
        self.assertEqual(got, {"t": ("ready", "stale"), "u": ("none", "none")})

    def test_기본_파드와_채팅_기본_프로파일(self):
        """MindWiki 가 아직 고르지 않은 사람의 처음 값(스펙 2026-11-21-002 §3-7): 위젯이 여는 파드에 default, 파드마다 chat_default."""
        self.reg.pods.append(Pod(id="pod-a2", owner_sub="alice", owner="alice@x"))
        self.reg.pick = lambda user, auth, wanted="": self.reg.pods[2]
        PROFILES["pod-a"] = [{"name": "one"}]
        PROFILES["pod-a2"] = [{"name": "two"}]
        with mock.patch.object(route.server, "_chat_default_of", lambda pod: {"pod-a": "one", "pod-a2": "default"}[pod.id]):
            status, body = _post(_body())
        self.assertEqual({p["pod"]: (p["default"], p["chat_default"]) for p in body["pods"]}, {"pod-a": (False, "one"), "pod-a2": (True, "default")})
        self.reg.pick = lambda user, auth, wanted="": self.reg.pods[1]                    # 남의 파드를 고르면 표시하지 않는다
        status, body = _post(_body())
        self.assertFalse(any(p["default"] for p in body["pods"]))

    def test_서명과_몸을_검사한다(self):
        self.assertEqual(_post(_body(), secret="x" * 32)[0], 401)
        status, body = _post(_body(), delivery="7")                       # 웹훅 서명 자리는 받지 않는다
        self.assertEqual((status, body["reason"]), (400, "invalid"))
        for bad in (b"{", b"[]", json.dumps({"owner": {}}).encode(), json.dumps({"owner": "a"}).encode(), _body(sub="x" * 81)):
            self.assertEqual(_post(bad)[0], 400, bad[:40])
        with mock.patch.dict(os.environ, {"AAS_MINDWIKI_WEBHOOK_SECRET": ""}):
            self.assertEqual(_post(_body())[0], 503)


if __name__ == "__main__":
    unittest.main()

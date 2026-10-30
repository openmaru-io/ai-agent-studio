# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""쿠버네티스 모드 시험(M2-3): HermesAgent 를 등록부로 읽고, 계정 Secret 을 읽고, HermesAgent 를 만들고 지운다.
가짜 쿠버네티스 API 서버(표준 라이브러리)를 띄워 실제 HTTP 로 확인한다."""
import base64
import json
import os
import re
import tempfile
import threading
import time
import unittest
from unittest import mock
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

TMP = tempfile.TemporaryDirectory()
os.environ.setdefault("AAS_DATA_DIR", str(Path(TMP.name) / "data"))

from aas.fleet import agents, k8s, lifecycle, pods
from aas.assets import credentials
from aas.hermes import readers
from aas.web import server  # noqa: E402

NS = "cogentai-aas-agents"
B64 = lambda v: base64.b64encode(v.encode()).decode()  # noqa: E731


class FakeAPI(BaseHTTPRequestHandler):
    tasks: dict = {}
    rollouts: dict | None = {}                       # None 이면 HermesRollout CRD 가 없는 클러스터(404)
    agents: dict = {}
    secrets: dict = {}
    configmaps: dict = {}                            # 이름 → data(남은 자리 aas-capacity, 스펙 2026-10-30-003 §4-8)
    quotas: dict = {}                                # 이름 → ResourceQuota
    pvcs: list = []
    patches: list = []                               # (이름, 본문) — HermesAgent PATCH 본문(null 포함)
    seen: list = []
    down = False
    slow = 0.0                                       # 응답 지연(OKE etcd 가 몇 초씩 멈추는 것을 흉내)

    def log_message(self, *a):
        pass

    def _send(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _route(self, method):
        FakeAPI.seen.append((method, self.path, self.headers.get("Authorization"), self.headers.get("Content-Type")))
        if FakeAPI.slow:
            time.sleep(FakeAPI.slow)
        if FakeAPI.down:
            return self._send(500, {"message": "boom"})
        n = int(self.headers.get("Content-Length") or 0)
        body = json.loads(self.rfile.read(n) or b"{}") if n else {}
        base = f"/apis/aas.openmaru.io/v1alpha1/namespaces/{NS}/hermesagents"
        if self.path == base and method == "GET":
            return self._send(200, {"items": list(FakeAPI.agents.values())})
        if self.path == base and method == "POST":
            name = body["metadata"]["name"]
            if name in FakeAPI.agents:
                return self._send(409, {"message": f'hermesagents "{name}" already exists'})
            FakeAPI.agents[name] = {**body, "metadata": {**body["metadata"], "creationTimestamp": "2026-10-10T00:00:00Z"}}
            return self._send(201, FakeAPI.agents[name])
        rbase = f"/apis/aas.openmaru.io/v1alpha1/namespaces/{NS}/hermesrollouts"
        if self.path.startswith(rbase) and FakeAPI.rollouts is None:
            return self._send(404, {"message": "the server could not find the requested resource"})
        if self.path == rbase and method == "GET":
            return self._send(200, {"items": list(FakeAPI.rollouts.values())})
        if self.path == rbase and method == "POST":
            name = body["metadata"]["name"]
            FakeAPI.rollouts[name] = {**body, "metadata": {**body["metadata"], "creationTimestamp": f"2026-10-29T00:00:{len(FakeAPI.rollouts):02d}Z"}, "status": {}}
            return self._send(201, FakeAPI.rollouts[name])
        mr = re.fullmatch(re.escape(rbase) + r"/([^/]+)", self.path)
        if mr and method == "PATCH":
            if mr.group(1) not in FakeAPI.rollouts:
                return self._send(404, {"message": "not found"})
            FakeAPI.rollouts[mr.group(1)]["spec"].update(body.get("spec", {}))
            return self._send(200, FakeAPI.rollouts[mr.group(1)])
        tbase = f"/apis/aas.openmaru.io/v1alpha1/namespaces/{NS}/hermestasks"
        if self.path == tbase and method == "POST":
            name = body["metadata"]["name"]
            if name in FakeAPI.tasks:
                return self._send(409, {"message": f'hermestasks "{name}" already exists'})
            FakeAPI.tasks[name] = {**body, "status": {}}
            return self._send(201, FakeAPI.tasks[name])
        mt = re.fullmatch(re.escape(tbase) + r"/([^/]+)", self.path)
        if mt:
            name = mt.group(1)
            if name not in FakeAPI.tasks:
                return self._send(404, {"message": f'hermestasks "{name}" not found'})
            if method == "GET":
                return self._send(200, FakeAPI.tasks[name])
            if method == "DELETE":
                del FakeAPI.tasks[name]
                return self._send(200, {"status": "Success"})
        m = re.fullmatch(re.escape(base) + r"/([^/]+)", self.path)
        if m:
            name = m.group(1)
            if name not in FakeAPI.agents:
                return self._send(404, {"message": f'hermesagents "{name}" not found'})
            if method == "GET":
                return self._send(200, FakeAPI.agents[name])
            if method == "DELETE":
                del FakeAPI.agents[name]
                return self._send(200, {"status": "Success"})
            if method == "PATCH":
                FakeAPI.patches.append((name, body))
                merge(FakeAPI.agents[name]["spec"], body.get("spec", {}))
                ann = FakeAPI.agents[name]["metadata"].setdefault("annotations", {})
                for k, v in ((body.get("metadata") or {}).get("annotations") or {}).items():
                    ann.pop(k, None) if v is None else ann.__setitem__(k, v)       # merge-patch: null 은 지운다
                return self._send(200, FakeAPI.agents[name])
        m = re.fullmatch(rf"/api/v1/namespaces/{NS}/(configmaps|resourcequotas)/([^/]+)", self.path)
        if m and method == "GET":
            src = FakeAPI.configmaps if m.group(1) == "configmaps" else FakeAPI.quotas
            if m.group(2) not in src:
                return self._send(404, {"message": "not found"})
            return self._send(200, {"data": src[m.group(2)]} if m.group(1) == "configmaps" else src[m.group(2)])
        if self.path == f"/api/v1/namespaces/{NS}/persistentvolumeclaims" and method == "GET":
            return self._send(200, {"items": FakeAPI.pvcs})
        m = re.fullmatch(rf"/api/v1/namespaces/{NS}/secrets/([^/]+)", self.path)
        if m and method == "GET":
            if m.group(1) not in FakeAPI.secrets:
                return self._send(404, {"message": "secret not found"})
            return self._send(200, {"data": {k: B64(v) for k, v in FakeAPI.secrets[m.group(1)].items()}})
        self._send(404, {"message": "no route " + self.path})

    do_GET = lambda self: self._route("GET")        # noqa: E731
    do_POST = lambda self: self._route("POST")      # noqa: E731
    do_DELETE = lambda self: self._route("DELETE")  # noqa: E731
    do_PATCH = lambda self: self._route("PATCH")    # noqa: E731


def merge(target: dict, patch: dict) -> None:
    """JSON merge-patch: null 은 지우고 dict 는 안으로 합친다."""
    for k, v in patch.items():
        if v is None:
            target.pop(k, None)
        elif isinstance(v, dict):
            if not isinstance(target.get(k), dict):
                target[k] = {}
            merge(target[k], v)
        else:
            target[k] = v


def agent(name, owner, phase="Ready", **status):
    st = {"phase": phase, "dashboardURL": f"http://{name}.{NS}.svc:9119", "sidecarURL": f"http://{name}.{NS}.svc:17950",
          "credentialsSecret": f"{name}-credentials", "readyReplicas": 1 if phase == "Ready" else 0, **status}
    return {"apiVersion": "aas.openmaru.io/v1alpha1", "kind": "HermesAgent", "metadata": {"name": name, "namespace": NS, "creationTimestamp": "x"},
            "spec": {"ownerSub": "sub-" + name, "ownerEmail": owner}, "status": st}


class K8sBase(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.httpd = ThreadingHTTPServer(("127.0.0.1", 0), FakeAPI)
        threading.Thread(target=cls.httpd.serve_forever, daemon=True).start()
        cls.old = {k: os.environ.get(k) for k in ("AAS_K8S_NAMESPACE", "AAS_K8S_API", "AAS_K8S_TOKEN_FILE", "AAS_ADMINS")}
        tok = Path(TMP.name) / "token"
        tok.write_text("sa-token\n")
        os.environ.update({"AAS_K8S_NAMESPACE": NS, "AAS_K8S_API": f"http://127.0.0.1:{cls.httpd.server_port}", "AAS_K8S_TOKEN_FILE": str(tok), "AAS_ADMINS": "admin@x.com"})

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        for k, v in cls.old.items():
            os.environ.pop(k, None) if v is None else os.environ.__setitem__(k, v)
        k8s.client()

    def setUp(self):
        FakeAPI.agents, FakeAPI.secrets, FakeAPI.seen, FakeAPI.down, FakeAPI.tasks, FakeAPI.slow, FakeAPI.rollouts = {}, {}, [], False, {}, 0.0, {}
        FakeAPI.configmaps, FakeAPI.quotas, FakeAPI.pvcs, FakeAPI.patches = {}, {}, [], []
        credentials.forget()


class ClientTest(K8sBase):
    def test_토큰을_붙이고_HermesAgent_를_읽고_쓰고_지운다(self):
        c = k8s.client()
        self.assertEqual(c.namespace, NS)
        c.create_agent(agents.manifest("hag-kim", NS, "sub", "kim@x.com"))
        self.assertEqual([i["metadata"]["name"] for i in c.list_agents()], ["hag-kim"])
        self.assertEqual(c.get_agent("hag-kim")["spec"]["ownerEmail"], "kim@x.com")
        c.patch_agent("hag-kim", {"spec": {"suspended": True}})
        self.assertTrue(FakeAPI.agents["hag-kim"]["spec"]["suspended"])
        c.delete_agent("hag-kim")
        self.assertEqual(c.list_agents(), [])
        self.assertTrue(all(s[2] == "Bearer sa-token" for s in FakeAPI.seen))             # 서비스 계정 토큰을 붙인다
        self.assertEqual([s[3] for s in FakeAPI.seen if s[0] == "PATCH"], ["application/merge-patch+json"])

    def test_거절과_닿지_않음을_사유와_함께_알린다(self):
        c = k8s.client()
        with self.assertRaises(k8s.K8sError) as cm:
            c.get_agent("없는-것")
        self.assertEqual(cm.exception.code, 404)
        self.assertIn("not found", str(cm.exception))
        FakeAPI.down = True
        with self.assertRaises(k8s.K8sError) as cm:
            c.list_agents()
        self.assertEqual(cm.exception.code, 500)
        dead = k8s.K8s(NS, api="http://127.0.0.1:9")
        with self.assertRaises(k8s.K8sError) as cm:
            dead.list_agents()
        self.assertEqual(cm.exception.code, 503)

    def test_Secret_값을_풀어서_읽는다(self):
        FakeAPI.secrets["s"] = {"dashboard-user": "aas", "dashboard-password": "p@ss", "sidecar-token": "t" * 20}
        self.assertEqual(k8s.client().secret("s")["dashboard-password"], "p@ss")

    def test_네임스페이스가_없으면_쿠버네티스_모드가_꺼진다(self):
        ns = os.environ.pop("AAS_K8S_NAMESPACE")
        try:
            self.assertIsNone(k8s.client())
        finally:
            os.environ["AAS_K8S_NAMESPACE"] = ns


class AgentsTest(K8sBase):
    def test_이름은_쿠버네티스_규칙에_맞고_매번_다르다(self):
        a, b = agents.new_name("Kim.Min+x@Example.com"), agents.new_name("kim.min+x@example.com")
        self.assertNotEqual(a, b)
        for n in (a, b):
            self.assertRegex(n, r"^aas-agent-kim-min-x-[0-9a-f]{4}$")
        self.assertRegex(agents.new_name("@x.com"), r"^aas-agent-user-")
        # StatefulSet 이름은 52자 이하여야 파드의 controller-revision-hash 레이블(이름-해시10자)이 63자를 넘지 않는다
        self.assertLessEqual(len(agents.new_name("a" * 64 + "@x.com")), 52)

    def test_만들기_검증과_충돌(self):
        c = k8s.client()
        with self.assertRaises(agents.AgentError):
            agents.create(c, "이메일아님")
        with self.assertRaises(agents.AgentError):
            agents.create(c, "a@x.com", name="Bad_Name")
        made = agents.create(c, "A@X.com", owner_sub="kc-1", display_name="내 Hermes", name="hag-a")
        self.assertEqual((made["spec"]["ownerEmail"], made["spec"]["ownerSub"], made["spec"]["displayName"]), ("a@x.com", "kc-1", "내 Hermes"))
        with self.assertRaises(agents.AgentError) as cm:
            agents.create(c, "a@x.com", name="hag-a")
        self.assertEqual(cm.exception.code, 409)

    def test_화면용_요약에는_Secret_값이_없고_Pod_는_준비된_것만(self):
        ready, wait = agent("hag-a", "a@x.com"), agent("hag-b", "b@x.com", "Provisioning", dashboardURL="", sidecarURL="")
        v = agents.view(ready)
        self.assertEqual((v["name"], v["owner"], v["phase"], v["ready"]), ("hag-a", "a@x.com", "Ready", True))
        self.assertNotIn("password", json.dumps(v).lower())
        self.assertEqual(agents.view(wait)["phase"], "Provisioning")
        self.assertIsNone(agents.pod_from(wait))
        pod = agents.pod_from(ready)
        self.assertEqual((pod.id, pod.owner, pod.dashboard_url, pod.credentials_secret), ("hag-a", "a@x.com", "http://hag-a.cogentai-aas-agents.svc:9119", "hag-a-credentials"))
        self.assertIsInstance(pod.hermes_home, readers.RemotePath)


    def test_다시_뜨는_중인_에이전트는_restarting_Pod_이고_pods_에는_없다(self):
        """Ready 였다가 게이트웨이를 다시 시작하면 NotReady, 롤아웃은 readyPodUID 가 남은 Provisioning 이다(스펙 2026-10-23-006)."""
        cases = [(agent("a", "a@x.com", "NotReady"), True), (agent("b", "b@x.com", "Provisioning", readyPodUID="uid-1"), True),
                 (agent("c", "c@x.com", "Provisioning"), False), (agent("d", "d@x.com"), False), (agent("e", "e@x.com", "Pending"), False),
                 (agent("f", "f@x.com", "NotReady", sidecarURL=""), False)]
        stopped = agent("g", "g@x.com", "NotReady")
        stopped["spec"]["suspended"] = True
        cases.append((stopped, False))
        for item, want in cases:
            pod = agents.restarting_pod_from(item)
            self.assertEqual(bool(pod), want, item["metadata"]["name"])
            if pod:
                self.assertTrue(pod.restarting)
                self.assertEqual(pod.public()["restarting"], True)
                self.assertIsNone(agents.pod_from(item))                                    # 준비된 목록에는 없다
        self.assertNotIn("restarting", agents.pod_from(agent("d", "d@x.com")).public())


class CredentialsTest(K8sBase):
    def test_Secret_은_짧게_캐시하고_forget_하면_다시_읽는다(self):
        FakeAPI.secrets["s"] = {"sidecar-token": "one" * 6}
        self.assertEqual(credentials.sidecar_token("s"), "one" * 6)
        FakeAPI.secrets["s"] = {"sidecar-token": "two" * 6}
        self.assertEqual(credentials.sidecar_token("s"), "one" * 6)                    # TTL 안에는 읽어 둔 값
        credentials.forget("s")
        self.assertEqual(credentials.sidecar_token("s"), "two" * 6)
        self.assertEqual(len([s for s in FakeAPI.seen if "/secrets/" in s[1]]), 2)

    def _expire(self):
        """읽어 둔 Secret 을 모두 TTL 이 지난 것으로 만든다."""
        with credentials._lock:
            for k, (ts, v) in list(credentials._cache.items()):
                credentials._cache[k] = (ts - credentials.TTL - 1, v)

    def _wait_behind(self):
        deadline = time.monotonic() + 5
        while credentials._refreshing and time.monotonic() < deadline:
            time.sleep(0.01)
        self.assertFalse(credentials._refreshing)

    def test_TTL_이_지나면_지난_값을_바로_주고_뒤에서_다시_읽는다(self):
        FakeAPI.secrets["s"] = {"sidecar-token": "one" * 6}
        self.assertEqual(credentials.sidecar_token("s"), "one" * 6)
        FakeAPI.secrets["s"] = {"sidecar-token": "two" * 6}
        self._expire()
        FakeAPI.slow = 1.0                                                              # API 가 느려도 요청은 기다리지 않는다
        t = time.monotonic()
        self.assertEqual(credentials.sidecar_token("s"), "one" * 6)
        self.assertLess(time.monotonic() - t, 0.5)
        self._wait_behind()
        FakeAPI.slow = 0.0
        self.assertEqual(credentials.sidecar_token("s"), "two" * 6)                    # 뒤에서 읽은 새 값

    def test_쿠버네티스_API_가_멈추면_지난_값을_계속_쓴다(self):
        FakeAPI.secrets["s"] = {"sidecar-token": "one" * 6}
        credentials.sidecar_token("s")
        FakeAPI.down = True                                                             # OKE etcd 장애로 API 가 답하지 않는다(2026-10-13)
        for _ in range(3):
            self._expire()
            self.assertEqual(credentials.sidecar_token("s"), "one" * 6)
            self._wait_behind()
        FakeAPI.down = False
        self._expire()
        credentials.sidecar_token("s")
        self._wait_behind()
        self.assertIn("s", credentials._cache)

    def test_뒤에서_다시_읽기는_이름마다_한_번만_돈다(self):
        FakeAPI.secrets["s"] = {"sidecar-token": "one" * 6}
        credentials.sidecar_token("s")
        self._expire()
        FakeAPI.slow = 0.3
        before = len([x for x in FakeAPI.seen if "/secrets/" in x[1]])
        for _ in range(5):
            credentials.sidecar_token("s")
        self._wait_behind()
        self.assertEqual(len([x for x in FakeAPI.seen if "/secrets/" in x[1]]) - before, 1)

    def test_Secret_이_지워지면_지난_값을_버린다(self):
        FakeAPI.secrets["s"] = {"sidecar-token": "one" * 6}
        credentials.sidecar_token("s")
        del FakeAPI.secrets["s"]                                                        # 에이전트를 지워 Secret 도 없어졌다
        self._expire()
        credentials.sidecar_token("s")
        self._wait_behind()
        with self.assertRaises(k8s.K8sError) as cm:
            credentials.sidecar_token("s")
        self.assertEqual(cm.exception.code, 404)

    def test_처음_읽을_때_API_가_답하지_않으면_오류를_알린다(self):
        FakeAPI.down = True
        with self.assertRaises(k8s.K8sError):
            credentials.sidecar_token("s")

    def test_계정은_Secret_에서_없으면_환경변수에서(self):
        FakeAPI.secrets["hag-a-credentials"] = {"dashboard-user": "aas", "dashboard-password": "pw-from-secret"}
        from_secret = agents.pod_from(agent("hag-a", "a@x.com"))
        self.assertEqual(credentials.dashboard(from_secret), ("aas", "pw-from-secret"))
        os.environ["T_USER"], os.environ["T_PW"] = "u", "p"
        try:
            self.assertEqual(credentials.dashboard(pods.Pod("x", "o", Path("/x"), dashboard_user_env="T_USER", dashboard_password_env="T_PW")), ("u", "p"))
        finally:
            del os.environ["T_USER"], os.environ["T_PW"]

    def test_서버의_hub_는_Secret_계정으로_만들고_계정이_바뀌면_다시_만든다(self):
        FakeAPI.secrets["hag-h-credentials"] = {"dashboard-user": "aas", "dashboard-password": "pw1"}
        pod = agents.pod_from(agent("hag-h", "h@x.com"))
        server._hubs.pop("hag-h", None)
        first = server.hub(pod)
        self.assertEqual((first.settings["user"], first.settings["password"]), ("aas", "pw1"))
        self.assertIs(server.hub(pod), first)
        FakeAPI.secrets["hag-h-credentials"] = {"dashboard-user": "aas", "dashboard-password": "pw2"}      # 같은 이름으로 다시 만들어졌다
        credentials.forget()
        second = server.hub(pod)
        self.assertIsNot(second, first)
        self.assertEqual(second.settings["password"], "pw2")
        server._hubs.pop("hag-h", None)


class RegistryTest(K8sBase):
    def test_준비된_HermesAgent_만_Pod_로_열고_목록에는_모두_보인다(self):
        FakeAPI.agents = {"hag-a": agent("hag-a", "a@x.com"), "hag-b": agent("hag-b", "b@x.com", "Provisioning"), "hag-c": agent("hag-c", "c@x.com", "Failed", message="exceeded quota")}
        reg = pods.Registry(Path(TMP.name) / "없는-등록부.json")
        self.assertEqual([p.id for p in reg.pods], ["hag-a"])
        self.assertEqual({a["name"]: a["phase"] for a in reg.agents}, {"hag-a": "Ready", "hag-b": "Provisioning", "hag-c": "Failed"})
        self.assertEqual(reg.agents[2]["message"], "exceeded quota")
        self.assertEqual(reg.admins, {"admin@x.com"})
        self.assertEqual([p.id for p in reg.allowed({"email": "a@x.com"}, True)], ["hag-a"])
        self.assertEqual(reg.allowed({"email": "b@x.com"}, True), [])                  # 준비 전이라 아직 못 연다
        self.assertEqual([p.id for p in reg.allowed({"email": "admin@x.com"}, True)], ["hag-a"])

    def test_refresh_는_간격마다_다시_읽고_준비되면_따라간다(self):
        FakeAPI.agents = {"hag-b": agent("hag-b", "b@x.com", "Provisioning")}
        reg = pods.Registry()
        self.assertEqual(reg.pods, [])
        FakeAPI.agents["hag-b"] = agent("hag-b", "b@x.com")
        reg.refresh(ttl=3600)
        self.assertEqual(reg.pods, [])                                                  # 간격 안이라 다시 읽지 않는다
        reg.refresh(ttl=0)
        self.assertEqual([p.id for p in reg.pods], ["hag-b"])

    def test_API_에_닿지_않으면_마지막_목록을_두고_오류를_알린다(self):
        FakeAPI.agents = {"hag-a": agent("hag-a", "a@x.com")}
        reg = pods.Registry()
        FakeAPI.down = True
        reg.refresh(ttl=0)
        self.assertEqual([p.id for p in reg.pods], ["hag-a"])
        self.assertIn("HermesAgent 를 읽지 못했습니다", reg.error)
        FakeAPI.down = False
        reg.refresh(ttl=0)
        self.assertEqual(reg.error, "")

    def list_reads(self):
        return sum(1 for m, p, *_ in FakeAPI.seen if m == "GET" and p.endswith("/hermesagents"))

    def test_간격이_지난_refresh_는_느린_API_를_기다리지_않고_뒤에서_다시_읽는다(self):
        # OKE etcd 가 약 3.5분마다 몇 초씩 멈춰 채널·프로파일 화면이 3~10초 멈췄다(OMAI-1109)
        FakeAPI.agents = {"hag-b": agent("hag-b", "b@x.com", "Provisioning")}
        reg = pods.Registry()
        FakeAPI.agents["hag-b"] = agent("hag-b", "b@x.com")
        FakeAPI.slow = 1.0
        reg._loaded -= 11
        t = time.monotonic()
        reg.refresh()
        self.assertLess(time.monotonic() - t, 0.3)
        self.assertEqual(reg.pods, [])                                                  # 지금 목록으로 바로 답한다
        for _ in range(60):
            if reg.pods:
                break
            time.sleep(0.05)
        self.assertEqual([p.id for p in reg.pods], ["hag-b"])

    def test_뒤에서_다시_읽기는_한_번에_하나만_돈다(self):
        FakeAPI.agents = {"hag-a": agent("hag-a", "a@x.com")}
        reg = pods.Registry()
        before = self.list_reads()
        FakeAPI.slow = 0.5
        reg._loaded -= 11
        for _ in range(5):
            reg.refresh()
        for _ in range(40):
            if not reg._refreshing:
                break
            time.sleep(0.05)
        self.assertEqual(self.list_reads() - before, 1)

    def test_채널_상태는_마지막_목록에서_읽고_없을_때만_API_를_부른다(self):
        from aas.ops import channels
        FakeAPI.agents = {"hag-a": agent("hag-a", "a@x.com", channels=[{"name": "telegram", "up": True}], channelsCheckedAt="t")}
        pods.Registry()                                                                  # 목록을 한 번 읽는다
        FakeAPI.seen = []
        self.assertEqual(channels.service_status("hag-a"), {"telegram": {"up": True, "disabled": False, "status": ""}})
        self.assertTrue(channels.services_checked("hag-a"))
        self.assertEqual([p for _m, p, *_ in FakeAPI.seen], [])                         # API 를 부르지 않았다
        self.assertEqual(channels.service_status("hag-zz"), {})                          # 목록에 없으면 API 에 묻는다(404 → 빈 값)
        self.assertTrue(any(p.endswith("/hermesagents/hag-zz") for _m, p, *_ in FakeAPI.seen))

    def test_쿠버네티스_모드가_아니면_refresh_는_아무것도_하지_않는다(self):
        ns = os.environ.pop("AAS_K8S_NAMESPACE")
        try:
            reg = pods.Registry(Path(TMP.name) / "없는-등록부.json")
            before = list(FakeAPI.seen)
            reg.refresh(ttl=0)
            self.assertEqual(FakeAPI.seen, before)
        finally:
            os.environ["AAS_K8S_NAMESPACE"] = ns


class ServerApiTest(K8sBase):
    def setUp(self):
        super().setUp()
        FakeAPI.agents = {"hag-a": agent("hag-a", "a@x.com"), "hag-b": agent("hag-b", "b@x.com")}
        self.reg = pods.Registry(Path(TMP.name) / "없는-등록부.json")

    def test_목록은_관리자는_전부_사용자는_내_것만(self):
        admin = server._agents_list(self.reg, {"email": "admin@x.com"}, True)
        self.assertEqual((admin["enabled"], admin["can_create"], [a["name"] for a in admin["agents"]]), (True, True, ["hag-a", "hag-b"]))
        mine = server._agents_list(self.reg, {"email": "a@x.com"}, True)
        self.assertEqual((mine["can_create"], [a["name"] for a in mine["agents"]], mine["limit"], mine["count"]), (True, ["hag-a"], 3, 1))
        self.assertNotIn("limits", mine)                                                       # 사람별 한도 표는 관리자만 본다
        self.assertNotIn("collect", mine)
        from aas.ops import collect_all
        collect_all.save_round({"ok": 1, "total": 2, "failed": [{"pod": "hag-b", "reason": "시간 초과(60초)"}]}, 61.5)
        info = server._agents_list(self.reg, {"email": "admin@x.com"}, True)["collect"]
        self.assertEqual((info["pods"]["ok"], info["pods"]["failed"][0]["pod"], info["seconds"]), (1, "hag-b", 61.5))
        self.assertEqual(len(server._agents_list(self.reg, None, False)["agents"]), 2)         # 로그인을 끄면 관리자와 같다

    def test_목록은_만들기_칸에_넣을_추천_이름을_준다(self):
        """스펙 2026-10-21-019: 「+」 만들기 칸의 기본 값. 남의 에이전트와 겹쳐도 번호를 붙인다(이름 자체는 내보내지 않는다)."""
        FakeAPI.agents["hag-b"]["spec"]["displayName"] = "홍길동의 AI 에이전트 작업공간"
        self.reg.refresh(ttl=0)
        out = server._agents_list(self.reg, {"email": "a@x.com", "name": "홍길동"}, True)
        self.assertEqual(out["suggested_name"], "홍길동의 AI 에이전트 작업공간 2")
        self.assertNotIn("hag-b", [a["name"] for a in out["agents"]])
        self.assertEqual(server._agents_list(self.reg, {"email": "a@x.com"}, True)["suggested_name"], "a의 AI 에이전트 작업공간")   # 이름을 모르면 이메일 앞부분

    def test_남의_Hermes_만들기와_지우기는_관리자만(self):
        out, code = server._agents_write(self.reg, {"email": "admin@x.com"}, True, "/api/agents", {"owner_email": "new@x.com", "name": "hag-new"})
        self.assertEqual((code, out["agent"]["name"]), (201, "hag-new"))
        self.assertIn("hag-new", FakeAPI.agents)
        self.assertIn("hag-new", [a["name"] for a in self.reg.agents])                         # 만든 뒤 목록을 바로 다시 읽는다
        with self.assertRaises(agents.AgentError) as cm:
            server._agents_write(self.reg, {"email": "a@x.com"}, True, "/api/agents", {"owner_email": "b@x.com"})
        self.assertEqual(cm.exception.code, 403)
        with self.assertRaises(agents.AgentError) as cm:
            server._agents_write(self.reg, {"email": "a@x.com"}, True, "/api/agents/delete", {"name": "hag-b", "confirm_name": "hag-b"})
        self.assertEqual(cm.exception.code, 403)                                               # 남의 Hermes
        self.assertEqual(server._agents_write(self.reg, {"email": "admin@x.com"}, True, "/api/agents/delete", {"name": "hag-new", "confirm_name": "hag-new"})[1], 200)
        self.assertNotIn("hag-new", FakeAPI.agents)
        with self.assertRaises(agents.AgentError) as cm:
            server._agents_write(self.reg, {"email": "admin@x.com"}, True, "/api/agents/delete", {"name": "없는-것", "confirm_name": "없는-것"})
        self.assertEqual(cm.exception.code, 404)

    def test_쿠버네티스_모드가_아니면_404(self):
        ns = os.environ.pop("AAS_K8S_NAMESPACE")
        try:
            with self.assertRaises(agents.AgentError) as cm:
                server._agents_write(self.reg, {"email": "admin@x.com"}, True, "/api/agents", {"owner_email": "a@x.com"})
            self.assertEqual(cm.exception.code, 404)
            self.assertFalse(server._agents_list(self.reg, {"email": "admin@x.com"}, True)["enabled"])
        finally:
            os.environ["AAS_K8S_NAMESPACE"] = ns


class LimitTest(K8sBase):
    """R14: 사용자가 자기 Hermes 를 한도 안에서 만든다. 한도는 기본 3, 관리자가 사람마다 바꾼다."""

    def setUp(self):
        super().setUp()
        FakeAPI.agents = {}
        self.reg = pods.Registry(Path(TMP.name) / "없는-등록부.json")
        os.environ.pop("AAS_AGENT_LIMIT", None)
        from aas.common import store
        with store.connect() as conn:
            conn.execute(agents.LIMIT_SCHEMA)
            conn.execute("DELETE FROM agent_limits")
        self.kim = {"email": "Kim@X.com", "sub": "sub-kim"}

    def make(self, user, **body):
        return server._agents_write(self.reg, user, True, "/api/agents", body)

    def test_사용자는_자기_것을_한도까지_만들고_넘으면_409(self):
        for i in range(3):
            out, code = self.make(self.kim, display_name=f"내 {i}")
            self.assertEqual((code, out["agent"]["owner"]), (201, "kim@x.com"))
        spec = [v["spec"] for v in FakeAPI.agents.values()][0]
        self.assertEqual((spec["ownerSub"], spec["ownerEmail"]), ("sub-kim", "kim@x.com"))
        with self.assertRaises(agents.AgentError) as cm:
            self.make(self.kim)
        self.assertEqual(cm.exception.code, 409)
        self.assertIn("3개까지", str(cm.exception))
        self.assertEqual(len(FakeAPI.agents), 3)
        info = server._agents_list(self.reg, self.kim, True)
        self.assertEqual((info["count"], info["limit"], info["can_create"]), (3, 3, False))
        self.make({"email": "lee@x.com", "sub": "sub-lee"})                                # 다른 사람의 한도에는 영향이 없다

    def test_준비_전이나_실패한_것도_센다(self):
        FakeAPI.agents = {"hag-1": agent("hag-1", "kim@x.com", "Failed", message="exceeded quota"),
                          "hag-2": agent("hag-2", "kim@x.com", "Provisioning"), "hag-3": agent("hag-3", "kim@x.com")}
        with self.assertRaises(agents.AgentError) as cm:
            self.make(self.kim)
        self.assertEqual(cm.exception.code, 409)

    def test_사용자가_owner_를_꾸며도_남의_이름으로_못_만든다(self):
        with self.assertRaises(agents.AgentError) as cm:
            self.make(self.kim, owner_email="lee@x.com")
        self.assertEqual(cm.exception.code, 403)
        out, _ = self.make(self.kim, owner_email="KIM@x.com")                               # 자기 이메일이면 자기 것
        self.assertEqual(out["agent"]["owner"], "kim@x.com")

    def test_관리자가_사람별_한도를_바꾸면_바로_반영된다(self):
        admin = {"email": "admin@x.com"}
        server._agents_write(self.reg, admin, True, "/api/agents/limit", {"email": "kim@x.com", "limit": 1})
        self.make(self.kim)
        with self.assertRaises(agents.AgentError):
            self.make(self.kim)
        server._agents_write(self.reg, admin, True, "/api/agents/limit", {"email": "kim@x.com", "limit": 2})
        self.make(self.kim)
        self.assertEqual(server._agents_list(self.reg, admin, True)["limits"], {"kim@x.com": 2})
        server._agents_write(self.reg, admin, True, "/api/agents/limit", {"email": "kim@x.com", "limit": None})   # 기본값으로
        self.assertEqual(agents.limit_for("kim@x.com"), 3)
        server._agents_write(self.reg, admin, True, "/api/agents/limit", {"email": "kim@x.com", "limit": 0})
        with self.assertRaises(agents.AgentError):
            self.make(self.kim)

    def test_한도_바꾸기는_관리자만_값_검사(self):
        with self.assertRaises(agents.AgentError) as cm:
            server._agents_write(self.reg, self.kim, True, "/api/agents/limit", {"email": "kim@x.com", "limit": 50})
        self.assertEqual(cm.exception.code, 403)
        admin = {"email": "admin@x.com"}
        for bad in ({"email": "kim@x.com", "limit": -1}, {"email": "kim@x.com", "limit": 99}, {"email": "kim@x.com", "limit": "3"},
                    {"email": "kim@x.com", "limit": True}, {"email": "not-email", "limit": 2}):
            with self.assertRaises(agents.AgentError, msg=str(bad)):
                server._agents_write(self.reg, admin, True, "/api/agents/limit", bad)

    def test_더하기로_만든_에이전트도_main_대상으로_기록하고_지우면_기록도_지운다(self):
        """2026-10-19-001 R7: 첫 로그인만 main 을 받던 것을 에이전트를 만들 때마다로 넓힌다. 설정이 꺼져 있으면 지금처럼 기록하지 않는다."""
        from aas.common import store
        from aas.fleet import primary
        with store.connect() as conn:
            conn.execute(primary.SCHEMA)
            conn.execute("DELETE FROM pod_primary")
        with mock.patch.dict(os.environ, {"AAS_PRIMARY_MAIN": ""}):
            out, _ = self.make(self.kim, display_name="꺼짐")
            self.assertIsNone(primary.state(out["agent"]["name"]))
        with mock.patch.dict(os.environ, {"AAS_PRIMARY_MAIN": "1"}):
            out, _ = self.make(self.kim, display_name="마케팅 도우미")
            name = out["agent"]["name"]
            self.assertEqual((primary.state(name) or {}).get("state"), "target")
            self.assertEqual(primary.primary_of(name), "main")
            out2, _ = server._agents_write(self.reg, {"email": "admin@x.com"}, True, "/api/agents", {"owner_email": "lee@x.com", "name": "hag-lee"})
            self.assertEqual((primary.state("hag-lee") or {}).get("state"), "target")        # 관리자가 남의 것을 만들어도 같다
        row = lambda: next(a for a in server._agents_list(self.reg, self.kim, True)["agents"] if a["name"] == name)   # noqa: E731
        self.assertTrue(row()["primary_preparing"])                                       # 표의 「main 준비 중」(디자인 D11)
        primary.set_state(name, "templated")
        self.assertFalse(row()["primary_preparing"])
        lifecycle.cascade(name)                                                                   # 같은 이름으로 다시 만들 때 옛 상태를 물려받지 않게
        self.assertIsNone(primary.state(name))

    def test_main_을_기다리는_에이전트가_있으면_30초_뒤_없으면_5분_뒤_다시_본다(self):
        from aas.common import store
        from aas.fleet import primary
        with store.connect() as conn:
            conn.execute(primary.SCHEMA)
            conn.execute("DELETE FROM pod_primary")
        self.assertEqual(server._identity_wait(300.0), 300.0)
        with mock.patch.dict(os.environ, {"AAS_PRIMARY_MAIN": "1"}):
            primary.mark("hag-wait")
        self.assertEqual(server._identity_wait(300.0), 30.0)
        primary.set_state("hag-wait", "templated")
        self.assertEqual(server._identity_wait(300.0), 300.0)

    def test_기본_한도는_설치_값을_따른다(self):
        os.environ["AAS_AGENT_LIMIT"] = "1"
        try:
            self.make(self.kim)
            with self.assertRaises(agents.AgentError):
                self.make(self.kim)
        finally:
            os.environ.pop("AAS_AGENT_LIMIT", None)

    def test_쿼터로_실패한_이유가_목록에_보인다(self):
        FakeAPI.agents = {"hag-1": agent("hag-1", "kim@x.com", "Failed", message="pods is forbidden: exceeded quota")}
        self.reg.refresh(ttl=0)
        mine = server._agents_list(self.reg, self.kim, True)["agents"][0]
        self.assertEqual((mine["phase"], mine["message"]), ("Failed", "pods is forbidden: exceeded quota"))


class FakeKeycloak(BaseHTTPRequestHandler):
    """관리 API 흉내: 토큰, 그룹 검색, 그룹 구성원(쪽 나누기), 역할 보유자."""
    group_members: list = []
    role_users: list = []
    group_exists = True
    role_status = 200            # 역할 보유자 조회가 403(권한 부족)·404(역할 없음)을 주게 할 수 있다
    role_groups: list = []       # 역할을 가진 그룹(예: aas-admins → aas-admin). 구성원은 role_group_members
    role_group_members: list = []
    seen: list = []

    def log_message(self, *a):
        pass

    def _send(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code); self.send_header("Content-Type", "application/json"); self.send_header("Content-Length", str(len(body))); self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        n = int(self.headers.get("Content-Length") or 0)
        form = dict(x.split("=", 1) for x in self.rfile.read(n).decode().split("&"))
        FakeKeycloak.seen.append(("POST", self.path, form.get("client_id")))
        if form.get("client_secret") != "kc-secret":
            return self._send(401, {"error": "unauthorized_client"})
        self._send(200, {"access_token": "kc-token"})

    def do_GET(self):
        from urllib.parse import urlsplit, parse_qs
        u = urlsplit(self.path); q = parse_qs(u.query)
        FakeKeycloak.seen.append(("GET", u.path, self.headers.get("Authorization")))
        if self.headers.get("Authorization") != "Bearer kc-token":
            return self._send(401, {})
        first, mx = int(q.get("first", ["0"])[0]), int(q.get("max", ["100"])[0])
        if u.path == "/admin/realms/openmaru/groups":
            return self._send(200, [{"id": "g1", "name": "aas-users"}] if FakeKeycloak.group_exists else [])
        if u.path == "/admin/realms/openmaru/groups/g1/members":
            return self._send(200, FakeKeycloak.group_members[first:first + mx])
        if u.path == "/admin/realms/openmaru/roles/aas-admin/groups":
            if FakeKeycloak.role_status != 200:
                return self._send(FakeKeycloak.role_status, {})
            return self._send(200, FakeKeycloak.role_groups[first:first + mx])
        if u.path == "/admin/realms/openmaru/groups/ga/members":
            return self._send(200, FakeKeycloak.role_group_members[first:first + mx])
        if u.path == "/admin/realms/openmaru/roles/aas-admin/users":
            if FakeKeycloak.role_status != 200:
                return self._send(FakeKeycloak.role_status, {})
            return self._send(200, FakeKeycloak.role_users[first:first + mx])
        self._send(404, {})


class AgentEditTest(K8sBase):
    """2026-10-19-001 R5·R3: 에이전트 서랍의 「수정」 — 주인·관리자가 이름과 채팅 기본 프로파일을 고친다. 두 값을 모두 검사한 뒤에 쓴다."""

    def setUp(self):
        super().setUp()
        FakeAPI.agents = {"hag-kim": agent("hag-kim", "kim@x.com"), "hag-lee": agent("hag-lee", "lee@x.com")}
        self.reg = pods.Registry(Path(TMP.name) / "없는-등록부.json")
        from aas.common import store
        from aas.fleet import chat_default
        with store.connect() as conn:
            conn.execute(chat_default.SCHEMA)
            conn.execute("DELETE FROM pod_default_profile")
        self.kim = {"email": "kim@x.com", "sub": "sub-kim"}
        self.names = mock.patch.object(server, "_agent_profile_names", side_effect=lambda reg, name: ["main", "ops"] if name in ("hag-kim", "hag-lee") else None)
        self.names.start()

    def tearDown(self):
        self.names.stop()

    def edit(self, user, **body):
        return server._agents_write(self.reg, user, True, "/api/agents/update", body)

    def test_주인과_관리자는_이름을_바꾸고_남은_403(self):
        self.assertEqual(self.edit(self.kim, name="hag-kim", display_name=" 마케팅 도우미 ")[1], 200)
        self.assertEqual(FakeAPI.agents["hag-kim"]["spec"]["displayName"], "마케팅 도우미")
        self.assertEqual(self.edit({"email": "admin@x.com"}, name="hag-lee", display_name="이씨 것")[1], 200)
        with self.assertRaises(agents.AgentError) as cm:
            self.edit(self.kim, name="hag-lee", display_name="남의 것")
        self.assertEqual(cm.exception.code, 403)

    def test_이름_검사와_채팅_기본_검사를_모두_한_뒤에_쓴다(self):
        from aas.fleet import chat_default
        for bad in ({"display_name": ""}, {"display_name": "가" * 81}, {"chat_default": "없는것"}, {"chat_default": "default"}):
            with self.assertRaises(agents.AgentError, msg=str(bad)) as cm:
                self.edit(self.kim, name="hag-kim", **({"display_name": "새 이름"} | bad))
            self.assertEqual(cm.exception.code, 400)
        self.assertNotEqual(FakeAPI.agents["hag-kim"]["spec"].get("displayName"), "새 이름")   # 채팅 기본이 틀리면 이름도 쓰지 않는다
        self.assertEqual(chat_default.stored("hag-kim"), "")
        self.assertEqual(self.edit(self.kim, name="hag-kim", chat_default="ops")[1], 200)
        self.assertEqual(chat_default.stored("hag-kim"), "ops")

    def test_준비되지_않은_에이전트의_채팅_기본은_409(self):
        FakeAPI.agents["hag-new"] = agent("hag-new", "kim@x.com", "Provisioning")
        with self.assertRaises(agents.AgentError) as cm:
            self.edit(self.kim, name="hag-new", chat_default="main")
        self.assertEqual(cm.exception.code, 409)

    def test_수정_대화_상자의_프로파일_목록은_주인과_관리자만(self):
        out = server._agent_profiles(self.reg, self.kim, True, "hag-kim")
        self.assertEqual((out["profiles"], out["chat_default"]), (["main", "ops"], "main"))
        with self.assertRaises(agents.AgentError) as cm:
            server._agent_profiles(self.reg, self.kim, True, "hag-lee")
        self.assertEqual(cm.exception.code, 403)

    def test_채팅_기본은_목록에_없으면_주_프로파일로_돌아간다(self):
        from aas.fleet import chat_default
        chat_default.save("hag-kim", "ops", "kim@x.com")
        self.assertEqual(chat_default.resolve("hag-kim", ["main", "ops"], "main"), "ops")
        self.assertEqual(chat_default.resolve("hag-kim", ["main"], "main"), "main")     # ops 를 지웠다
        lifecycle.cascade("hag-kim")
        self.assertEqual(chat_default.stored("hag-kim"), "")

    def test_수정_창과_저장_검사는_목록_저장값이_아니라_새_목록을_읽는다(self):
        """2026-10-19-006 R4: 목록용 저장값이 옛 목록이어도 방금 만든 프로파일을 고르고 저장할 수 있다. 한 층 아래(hr.profiles)를 바꿔 끼운다(C3)."""
        from aas.fleet import profile_names
        self.names.stop()
        profile_names._values["hag-kim"] = (time.monotonic(), ["main"])                   # 목록 저장값은 아직 옛 목록
        Prof = type("Prof", (), {})
        def read(_home):
            out = []
            for n in ("main", "ops", "new"):
                p = Prof(); p.name = n; out.append(p)
            return out
        try:
            with mock.patch.object(server.cron_health.hr, "profiles", side_effect=read):
                self.assertEqual(server._agent_profiles(self.reg, self.kim, True, "hag-kim")["profiles"], ["main", "ops", "new"])
                self.assertEqual(self.edit(self.kim, name="hag-kim", chat_default="new")[1], 200)
        finally:
            profile_names.forget("hag-kim")
            self.names.start()


class AgentListProfilesTest(K8sBase):
    """2026-10-19-006 R1·D5: 에이전트 목록의 프로파일 칸 — 목록은 저장값만 보고 사이드카를 기다리지 않는다. 읽기는 뒤에서 에이전트마다 하나씩."""

    def setUp(self):
        super().setUp()
        from aas.common import store
        from aas.fleet import chat_default, profile_names
        FakeAPI.agents = {"hag-a": agent("hag-a", "a@x.com"), "hag-b": agent("hag-b", "b@x.com"), "hag-c": agent("hag-c", "c@x.com", "Provisioning")}
        self.reg = pods.Registry(Path(TMP.name) / "없는-등록부.json")
        with store.connect() as conn:
            conn.execute(chat_default.SCHEMA)
            conn.execute("DELETE FROM pod_default_profile")
        self.pn = profile_names
        for pid in ("hag-a", "hag-b", "hag-c"):
            profile_names.forget(pid)
        self.names = {"hag-a": ["main", "ops"], "hag-b": []}
        self.calls, self.gate, self.fail = [], threading.Event(), set()
        self.gate.set()
        self.patch = mock.patch.object(server.cron_health.hr, "profiles", side_effect=self.read)
        self.patch.start()

    def tearDown(self):
        self.gate.set()
        self.patch.stop()
        for pid in ("hag-a", "hag-b", "hag-c"):
            self.pn.forget(pid)

    def read(self, home):
        pid = home._b.label                             # 사이드카 이름이 POD id 다(hermes_reader.profiles 와 같은 판정)
        self.calls.append(pid)
        self.gate.wait(5)
        if pid in self.fail:
            raise OSError("sidecar down")
        Prof = type("Prof", (), {})
        out = []
        for n in self.names[pid]:
            p = Prof(); p.name = n; out.append(p)
        return out

    def rows(self):
        return {a["name"]: a for a in server._agents_list(self.reg, {"email": "admin@x.com"}, True)["agents"]}

    def settle(self):
        """뒤 읽기가 끝날 때까지(최대 3초)."""
        end = time.monotonic() + 3
        while self.pn._running and time.monotonic() < end:
            time.sleep(0.01)
        self.assertFalse(self.pn._running)

    def test_처음엔_null_이고_읽기가_끝나면_이름과_채팅_기본을_준다(self):
        from aas.fleet import chat_default
        first = self.rows()
        self.assertEqual([first[n]["profiles"] for n in ("hag-a", "hag-b", "hag-c")], [None, None, None])   # 저장값이 없으면 기다리지 않고 null
        self.settle()
        rows = self.rows()
        self.assertEqual((rows["hag-a"]["profiles"], rows["hag-a"]["chat_default"]), (["main", "ops"], "main"))
        self.assertEqual((rows["hag-b"]["profiles"], rows["hag-b"]["chat_default"]), ([], ""))          # main 을 만드는 중이면 빈 목록, 채팅 기본도 빈 값(C5)
        self.assertEqual((rows["hag-c"]["profiles"], rows["hag-c"]["chat_default"]), (None, ""))        # 준비되지 않은 에이전트는 읽지 않는다
        self.assertNotIn("hag-c", self.calls)
        chat_default.save("hag-a", "ops", "a@x.com")
        self.assertEqual(self.rows()["hag-a"]["chat_default"], "ops")

    def test_사이드카가_멈춰도_목록은_바로_돌아오고_읽기는_에이전트마다_하나(self):
        self.gate.clear()
        started = time.monotonic()
        for _ in range(3):
            self.assertIsNone(self.rows()["hag-a"]["profiles"])
        self.assertLess(time.monotonic() - started, 1.0)
        self.assertEqual(sorted(self.calls), ["hag-a", "hag-b"])                                      # 세 번 불러도 에이전트마다 한 번
        self.gate.set()
        self.settle()
        self.assertEqual(self.rows()["hag-a"]["profiles"], ["main", "ops"])

    def test_읽기_실패는_None_으로_저장하고_30초_안에는_다시_읽지_않는다(self):
        self.fail.add("hag-a")
        self.rows()
        self.settle()
        self.assertIsNone(self.rows()["hag-a"]["profiles"])
        self.settle()
        self.assertEqual(self.calls.count("hag-a"), 1)
        with mock.patch.object(self.pn, "TTL", 0.0):                                                   # 30초가 지나면 다시 읽는다
            self.fail.clear()
            self.rows()
            self.settle()
        self.assertEqual((self.calls.count("hag-a"), self.rows()["hag-a"]["profiles"]), (2, ["main", "ops"]))

    def test_지우면_다시_읽고_지우기_전에_시작한_읽기는_저장하지_않는다(self):
        self.rows()
        self.settle()
        self.gate.clear()
        self.pn.forget("hag-a")
        self.rows()                                     # 다시 읽기 시작(멈춰 있음)
        self.names["hag-a"] = ["main", "ops", "new"]
        self.pn.forget("hag-a")                         # 읽는 중에 프로파일이 또 바뀌었다 — 그 읽기 결과는 버린다
        self.gate.set()
        self.settle()
        self.assertIsNone(self.rows()["hag-a"]["profiles"])
        self.settle()
        self.assertEqual(self.rows()["hag-a"]["profiles"], ["main", "ops", "new"])


class LifecycleTest(K8sBase):
    """R19: 본인 삭제(이름 재입력·내보내기·연쇄 정리), 다시 띄우기, 소유권 이전, 미사용 멈춤, Keycloak 대조."""

    def setUp(self):
        super().setUp()
        FakeAPI.agents = {"hag-a": agent("hag-a", "a@x.com"), "hag-b": agent("hag-b", "b@x.com")}
        self.reg = pods.Registry(Path(TMP.name) / "없는-등록부.json")
        self.a = {"email": "a@x.com", "sub": "sub-hag-a"}
        self.admin = {"email": "admin@x.com"}

    def w(self, user, path, **body):
        return server._agents_write(self.reg, user, True, path, body)

    # ---- 지우기 ----
    def test_주인은_이름을_다시_입력하면_자기_Hermes_를_지운다(self):
        with self.assertRaises(agents.AgentError) as cm:
            self.w(self.a, "/api/agents/delete", name="hag-a")
        self.assertEqual(cm.exception.code, 400)
        with self.assertRaises(agents.AgentError) as cm:
            self.w(self.a, "/api/agents/delete", name="hag-a", confirm_name="hag-A")
        self.assertEqual(cm.exception.code, 400)
        self.assertIn("hag-a", FakeAPI.agents)
        out, code = self.w(self.a, "/api/agents/delete", name="hag-a", confirm_name="hag-a")
        self.assertEqual((code, out["ok"]), (200, True))
        self.assertNotIn("hag-a", FakeAPI.agents)

    def test_남의_Hermes_는_주인이_아니면_못_지운다_관리자는_된다(self):
        with self.assertRaises(agents.AgentError) as cm:
            self.w(self.a, "/api/agents/delete", name="hag-b", confirm_name="hag-b")
        self.assertEqual(cm.exception.code, 403)
        self.assertEqual(self.w(self.admin, "/api/agents/delete", name="hag-b", confirm_name="hag-b")[1], 200)

    def test_이메일이_바뀌어도_sub_로_주인을_알아본다(self):
        FakeAPI.agents["hag-a"]["spec"]["ownerEmail"] = "renamed@x.com"
        self.assertEqual(self.w(self.a, "/api/agents/delete", name="hag-a", confirm_name="hag-a")[1], 200)

    def test_지우면_그_Hermes_를_가리키는_AAS_기록을_정리한다_스냅샷은_남긴다(self):
        import json as _json
        from aas.office import office, hub_auto
        from aas.common import store
        with store.connect() as c:
            c.executescript(office.SCHEMA + hub_auto.SCHEMA + "CREATE TABLE IF NOT EXISTS market_grants (pod TEXT NOT NULL, namespace TEXT NOT NULL, by TEXT, ts TEXT, PRIMARY KEY (pod, namespace));")
            c.executescript("DELETE FROM office_seats; DELETE FROM office_rooms; DELETE FROM office_cards; DELETE FROM office_board_pods; DELETE FROM market_grants;")
            c.execute("INSERT INTO office_seats (alias, pod, profile, ts) VALUES ('ma','hag-a','default','t'), ('qa','hag-b','default','t')")
            c.execute("INSERT INTO office_rooms (name, seats, ts) VALUES ('TFT', ?, 't')", (_json.dumps(["ma", "qa"]),))
            c.execute("INSERT INTO office_cards (board, task_id, pod) VALUES ('b','1','hag-a'), ('b','2','hag-b')")
            c.execute("INSERT INTO office_board_pods VALUES ('b','hag-a'), ('b','hag-b')")
            c.execute("INSERT INTO market_grants VALUES ('hag-a','ns','x','t')")
        self.reg.grant("a@x.com", "user", ["hag-a"], "admin")
        out, _ = self.w(self.a, "/api/agents/delete", name="hag-a", confirm_name="hag-a")
        self.assertGreaterEqual(out["cleaned"]["seats"], 1)
        with store.connect() as c:
            self.assertEqual([r["alias"] for r in c.execute("SELECT alias FROM office_seats")], ["qa"])
            self.assertEqual(_json.loads(c.execute("SELECT seats FROM office_rooms").fetchone()[0]), ["qa"])
            self.assertEqual([r["task_id"] for r in c.execute("SELECT task_id FROM office_cards")], ["2"])
            self.assertEqual([r["pod"] for r in c.execute("SELECT pod FROM office_board_pods")], ["hag-b"])
            self.assertEqual(c.execute("SELECT COUNT(*) FROM market_grants").fetchone()[0], 0)
        self.assertEqual(self.reg.grants()["a@x.com"]["pods"], [])
        with store.connect() as c:
            c.executescript("DELETE FROM office_seats; DELETE FROM office_rooms; DELETE FROM office_cards; DELETE FROM office_board_pods;")
        self.reg.grant("a@x.com", "none", [], "admin")

    def test_내보내기_묶음은_허용_목록만_담고_키_값은_가린다(self):
        import tarfile
        from aas.fleet import export
        home = Path(TMP.name) / "export-home"
        (home / "skills" / "s1").mkdir(parents=True); (home / "memories").mkdir(); (home / "cron").mkdir()
        (home / "config.yaml").write_text('model:\n  api_key: sk-real-secret\n  base_url: "${HERMES_LLM_BASE_URL}"\n  token: ${X}\n')
        (home / "skills" / "s1" / "SKILL.md").write_text("# skill")
        (home / "memories" / "m.md").write_text("memo")
        (home / "cron" / "jobs.json").write_text("[]")
        (home / ".env").write_text("SECRET=1")
        (home / "state.db").write_bytes(b"sqlite")
        (home / "auth.json").write_text("{}")
        path = export.bundle(home, "hag-x")
        with tarfile.open(path) as tar:
            names = sorted(tar.getnames())
            cfg = tar.extractfile("config.yaml").read().decode()
        self.assertEqual(names, ["config.yaml", "cron/jobs.json", "memories/m.md", "skills/s1/SKILL.md"])
        self.assertNotIn("sk-real-secret", cfg)
        self.assertIn("api_key: ***", cfg)
        self.assertIn("${HERMES_LLM_BASE_URL}", cfg)                                           # 환경변수 참조는 그대로
        self.assertEqual(oct(path.stat().st_mode & 0o777), "0o600")
        self.assertIsNone(export.bundle(Path(TMP.name) / "없는-폴더", "hag-y"))

    # ---- 멈춤·다시 띄우기 ----
    def test_주인은_멈춘_Hermes_를_다시_띄우고_남의_것은_못_띄운다(self):
        lifecycle.suspend(k8s.client(), "hag-a", "idle", 1_700_000_000)
        ann = FakeAPI.agents["hag-a"]["metadata"]["annotations"]
        self.assertEqual((FakeAPI.agents["hag-a"]["spec"]["suspended"], ann["aas.openmaru.io/suspended-reason"]), (True, "idle"))
        self.reg.refresh(ttl=0)
        v = [x for x in server._agents_list(self.reg, self.a, True)["agents"] if x["name"] == "hag-a"][0]
        self.assertEqual((v["suspended"], v["suspended_reason"]), (True, "idle"))
        with self.assertRaises(agents.AgentError) as cm:
            self.w({"email": "b@x.com", "sub": "sub-hag-b"}, "/api/agents/resume", name="hag-a")
        self.assertEqual(cm.exception.code, 403)
        self.w(self.a, "/api/agents/resume", name="hag-a")
        self.assertFalse(FakeAPI.agents["hag-a"]["spec"]["suspended"])
        self.assertNotIn("aas.openmaru.io/suspended-reason", FakeAPI.agents["hag-a"]["metadata"].get("annotations", {}))

    # ---- 소유권 이전 ----
    def test_관리자만_소유권을_옮기고_아는_sub_를_쓴다(self):
        from aas.common import store
        with self.assertRaises(agents.AgentError) as cm:
            self.w(self.a, "/api/agents/owner", name="hag-a", owner_email="c@x.com")
        self.assertEqual(cm.exception.code, 403)
        seq = server.OFFICE.bus.seq
        self.w(self.admin, "/api/agents/owner", name="hag-a", owner_email="C@x.com")
        self.assertIn("desks.changed", [e["type"] for e in server.OFFICE.bus.after(seq, wait=0)])   # 주인이 바뀌면 장면이 다시 받는다(스펙 2026-10-21-022 리뷰 R8)
        spec = FakeAPI.agents["hag-a"]["spec"]
        self.assertEqual((spec["ownerEmail"], spec["ownerSub"]), ("c@x.com", "c@x.com"))        # 아직 로그인한 적 없으면 이메일이 임시 식별자
        from aas.common import db
        with store.connect() as c:
            c.execute("CREATE TABLE IF NOT EXISTS auth_sessions (hash TEXT PRIMARY KEY, email TEXT NOT NULL, name TEXT, created REAL NOT NULL, expires REAL NOT NULL, sub TEXT NOT NULL DEFAULT '', admin INTEGER NOT NULL DEFAULT 0)")
            c.execute(db.upsert("auth_sessions", ("hash", "email", "name", "created", "expires", "sub", "admin"), ("hash",)), ("h1", "d@x.com", "", 1, 2, "kc-d", 0))
        self.w(self.admin, "/api/agents/owner", name="hag-a", owner_email="d@x.com")
        self.assertEqual(FakeAPI.agents["hag-a"]["spec"]["ownerSub"], "kc-d")
        with self.assertRaises(agents.AgentError):
            self.w(self.admin, "/api/agents/owner", name="hag-a", owner_email="not-email")

    def test_이메일만_적힌_Hermes_는_첫_로그인에서_sub_를_이어_받는다(self):
        FakeAPI.agents["hag-a"]["spec"]["ownerSub"] = "c@x.com"
        FakeAPI.agents["hag-a"]["spec"]["ownerEmail"] = "c@x.com"
        self.reg.refresh(ttl=0)
        self.assertEqual(agents.link_sub(k8s.client(), self.reg.agents, "kc-c", "C@x.com"), ["hag-a"])
        self.assertEqual(FakeAPI.agents["hag-a"]["spec"]["ownerSub"], "kc-c")
        self.reg.refresh(ttl=0)
        self.assertEqual(agents.link_sub(k8s.client(), self.reg.agents, "kc-c", "c@x.com"), [])      # 이미 같으면 건드리지 않는다

    # ---- 「사용자·권한」의 사용 중지·삭제(스펙 2026-10-14-011 R1·R3) ----
    def test_사용_중지와_삭제로_멈춘_Hermes_는_대조가_다시_켜지_않는다(self):
        client = k8s.client()
        lifecycle.suspend(client, "hag-a", "disabled")
        lifecycle.orphan(client, "hag-b", "b@x.com")
        everyone = self.members(("sub-hag-a", "a@x.com"), ("sub-hag-b", "b@x.com"))
        out = lifecycle.reconcile(client, client.list_agents(), everyone)
        self.assertEqual((out["suspended"], out["resumed"]), ([], []))
        self.assertTrue(FakeAPI.agents["hag-a"]["spec"]["suspended"] and FakeAPI.agents["hag-b"]["spec"]["suspended"])
        self.assertIn("disabled", lifecycle.REASONS)
        self.assertIn("deleted", lifecycle.REASONS)

    def test_관리자가_다시_띄운_주인_없는_Hermes_를_대조가_다시_멈추지_않는다(self):
        """OKE 2026-10-23: 지운 사람의 Hermes(ownerSub=DELETED_SUB)를 관리자가 「다시 시작」하면 이유 표시가 지워진다. 다음 대조가 주인을
        Keycloak 구성원에서 찾지 못해 「OIDC 그룹에서 빠져 멈춤」(keycloak)으로 다시 멈췄다. 주인이 없는 Hermes 는 대조할 주인이 없으므로 건드리지 않는다."""
        client = k8s.client()
        lifecycle.orphan(client, "hag-b", "b@x.com")
        lifecycle.resume(client, "hag-b")                                                    # 관리자의 「다시 시작」
        out = lifecycle.reconcile(client, client.list_agents(), self.members(("sub-hag-a", "a@x.com")))
        self.assertEqual(out["suspended"], [])
        self.assertFalse(FakeAPI.agents["hag-b"]["spec"]["suspended"])

    def test_지운_사람의_Hermes_는_주인을_비워_같은_이메일의_새_계정에_잇지_않는다(self):
        client = k8s.client()
        lifecycle.orphan(client, "hag-b", "b@x.com")
        item = FakeAPI.agents["hag-b"]
        ann = item["metadata"]["annotations"]
        self.assertEqual((ann["aas.openmaru.io/deleted-owner"], ann["aas.openmaru.io/suspended-reason"]), ("b@x.com", "deleted"))
        self.assertEqual((item["spec"]["ownerSub"], item["spec"].get("ownerEmail")), (agents.DELETED_SUB, None))
        self.reg.refresh(ttl=0)
        v = next(a for a in self.reg.agents if a["name"] == "hag-b")
        self.assertEqual((v["owner"], v["owner_sub"], v["deleted_owner"]), ("", "", "b@x.com"))
        self.assertEqual(agents.link_sub(client, self.reg.agents, "kc-new-b", "b@x.com"), [])
        self.assertFalse(agents.is_owner(item, "kc-new-b", "b@x.com"))
        out = lifecycle.reconcile(client, client.list_agents(), self.members(("sub-hag-a", "a@x.com"), ("kc-new-b", "b@x.com")))
        self.assertEqual(out["resumed"], [])
        # 관리자가 소유권을 옮기면 지운 주인 표시가 사라진다
        self.w(self.admin, "/api/agents/owner", name="hag-b", owner_email="c@x.com")
        self.assertNotIn("aas.openmaru.io/deleted-owner", FakeAPI.agents["hag-b"]["metadata"]["annotations"])
        self.assertEqual(FakeAPI.agents["hag-b"]["spec"]["ownerEmail"], "c@x.com")

    def test_사람_추가와_첫_로그인은_같은_마련_함수를_쓰고_두_번_만들지_않는다(self):
        """C4: 추가한 사람도 main 프로파일 대상이 되고(primary.mark), 첫 로그인은 이미 있으면 만들지 않는다."""
        from unittest import mock
        from aas.common import store
        from aas.fleet import primary
        mine = [""]
        old = server._registry
        server._registry = self.reg
        try:
            with mock.patch.dict(os.environ, {"AAS_PRIMARY_MAIN": "1"}):
                self.assertEqual(server._provision("kc-new", "new@x.com", "홍길동"), "created")
                mine = [n for n, a in FakeAPI.agents.items() if a["spec"].get("ownerEmail") == "new@x.com"]
                self.assertEqual(len(mine), 1)
                self.assertEqual(FakeAPI.agents[mine[0]]["spec"]["ownerSub"], "kc-new")       # Keycloak id 가 곧 sub
                self.assertTrue(primary.state(mine[0]))
                self.assertEqual(server._provision("kc-new", "new@x.com"), "exists")
                server._first_login({"sub": "kc-new", "email": "new@x.com", "name": "홍길동"})
                self.assertEqual(len([a for a in FakeAPI.agents.values() if a["spec"].get("ownerEmail") == "new@x.com"]), 1)
        finally:
            server._registry = old
            with store.connect() as c:
                c.execute(primary.SCHEMA)
                c.execute("DELETE FROM pod_primary WHERE pod=?", (mine[0],))

    def _cleanup_primary(self, emails):
        from aas.common import store
        from aas.fleet import primary
        names = [n for n, a in FakeAPI.agents.items() if a["spec"].get("ownerEmail") in emails]
        with store.connect() as c:
            c.execute(primary.SCHEMA)
            for n in names:
                c.execute("DELETE FROM pod_primary WHERE pod=?", (n,))

    def test_이미_에이전트가_있는_사람의_로그인은_쿠버네티스를_부르지_않는다(self):
        """로그인마다 서버 전체 잠금 안에서 k8s 목록을 1~3번(각 10초) 읽었다. etcd 가 느리면 로그인이 한 줄로 섰다(스펙 2026-10-24-002 R9)."""
        import time
        old = server._registry
        server._registry = self.reg
        self.addCleanup(setattr, server, "_registry", old)
        self.addCleanup(self._cleanup_primary, {"have@x.com"})
        self.assertEqual(server._provision("kc-have", "have@x.com"), "created")
        FakeAPI.seen.clear()
        FakeAPI.slow = 1.0
        self.addCleanup(setattr, FakeAPI, "slow", 0)
        began = time.monotonic()
        self.assertEqual(server._provision("kc-have", "have@x.com"), "exists")
        self.assertLess(time.monotonic() - began, 0.5)
        self.assertEqual([s for s in FakeAPI.seen if s[0] == "GET" and s[1].endswith("/hermesagents")], [])

    def test_서로_다른_사람의_첫_로그인은_줄을_서지_않고_같은_사람은_하나만_만든다(self):
        """사람별 잠금으로 바꿔도 같은 사람이 동시에 두 번 들어오면 HermesAgent 가 둘 생기면 안 된다(검토 D5)."""
        import threading
        import time
        old = server._registry
        server._registry = self.reg
        self.addCleanup(setattr, server, "_registry", old)
        self.addCleanup(self._cleanup_primary, {"p1@x.com", "p2@x.com", "same@x.com"})
        FakeAPI.slow = 0.3
        self.addCleanup(setattr, FakeAPI, "slow", 0)
        began = time.monotonic()
        one = [threading.Thread(target=server._provision, args=(f"kc-p{i}", f"p{i}@x.com")) for i in (1, 2)]
        for t in one:
            t.start()
        for t in one:
            t.join(20)
        both = time.monotonic() - began
        began = time.monotonic()
        server._provision("kc-p3", "p3@x.com")
        single = time.monotonic() - began
        self._cleanup_primary({"p3@x.com"})
        self.assertLess(both, single * 1.6, (both, single))     # 둘이 함께여도 한 사람과 비슷하다(줄을 서면 두 배)
        same = [threading.Thread(target=server._provision, args=("kc-same", "same@x.com")) for _ in range(3)]
        for t in same:
            t.start()
        for t in same:
            t.join(20)
        self.assertEqual(len([a for a in FakeAPI.agents.values() if a["spec"].get("ownerEmail") == "same@x.com"]), 1)

    # ---- 미사용 멈춤 ----
    def _home(self, last: float | None, name="idle-home"):
        import sqlite3
        home = Path(TMP.name) / name
        home.mkdir(exist_ok=True)
        db = home / "state.db"
        db.unlink(missing_ok=True)
        conn = sqlite3.connect(db)
        conn.execute("CREATE TABLE sessions (id TEXT, source TEXT, started_at REAL, last_activity_at REAL)")
        if last is not None:
            conn.execute("INSERT INTO sessions VALUES ('1','cli',?,?)", (last - 10, last))
        conn.commit(); conn.close()
        return home

    def test_30일_넘게_안_쓴_Ready_Hermes_만_멈춘다(self):
        now = 1_800_000_000.0
        old, fresh = now - 40 * 86400, now - 2 * 86400
        homes = {"hag-a": self._home(old, "h-a"), "hag-b": self._home(fresh, "h-b")}
        pod_of = lambda n: pods.Pod(n, "o", homes[n])
        items = [FakeAPI.agents["hag-a"], FakeAPI.agents["hag-b"]]
        stopped = lifecycle.run_idle(k8s.client(), items, {n: pod_of(n) for n in homes}, now=now, days=30)
        self.assertEqual(stopped, ["hag-a"])
        self.assertEqual(FakeAPI.agents["hag-a"]["metadata"]["annotations"]["aas.openmaru.io/suspended-reason"], "idle")
        self.assertFalse(FakeAPI.agents["hag-b"]["spec"].get("suspended"))

    def test_만든_지_얼마_안_됐거나_활동을_읽지_못하면_멈추지_않는다(self):
        now = 1_800_000_000.0
        new = agent("hag-n", "n@x.com"); new["metadata"]["creationTimestamp"] = "2027-01-14T00:00:00Z"        # now(2027-01-15) 하루 전
        FakeAPI.agents["hag-n"] = new
        homes = {"hag-n": self._home(None, "h-n"), "hag-a": Path(TMP.name) / "없는-집"}
        items = [FakeAPI.agents["hag-n"], FakeAPI.agents["hag-a"]]
        stopped = lifecycle.run_idle(k8s.client(), items, {n: pods.Pod(n, "o", h) for n, h in homes.items()}, now=now, days=30)
        self.assertEqual(stopped, [])                                                          # hag-n 은 새것, hag-a 는 기록이 없어 알 수 없다
        stopped = lifecycle.run_idle(k8s.client(), [dict(FakeAPI.agents["hag-a"], status={"phase": "Provisioning"})], {"hag-a": pods.Pod("hag-a", "o", self._home(1.0, "h-old"))}, now=now, days=30)
        self.assertEqual(stopped, [])                                                          # 준비되지 않은 것은 건드리지 않는다

    def test_크론_실행도_활동으로_센다(self):
        now = 1_800_000_000.0
        home = self._home(now - 90 * 86400, "h-cron")
        (home / "cron").mkdir(exist_ok=True)
        import datetime as dt
        recent = dt.datetime.fromtimestamp(now - 86400, dt.timezone.utc).isoformat()
        (home / "cron" / "jobs.json").write_text(json.dumps({"jobs": [{"id": "j", "name": "j", "last_run_at": recent}]}))
        self.assertEqual(lifecycle.run_idle(k8s.client(), [FakeAPI.agents["hag-a"]], {"hag-a": pods.Pod("hag-a", "o", home)}, now=now, days=30), [])

    # ---- Keycloak 대조 ----
    def members(self, *pairs):
        return [{"id": i, "email": e} for i, e in pairs]

    def test_Keycloak_에서_빠진_사람의_Hermes_를_멈추고_돌아오면_다시_띄운다(self):
        client = k8s.client()
        items = lambda: client.list_agents()
        out = lifecycle.reconcile(client, items(), self.members(("sub-hag-a", "a@x.com")))
        self.assertEqual(out["suspended"], ["hag-b"])
        self.assertEqual(FakeAPI.agents["hag-b"]["metadata"]["annotations"]["aas.openmaru.io/suspended-reason"], "keycloak")
        self.assertFalse(FakeAPI.agents["hag-a"]["spec"].get("suspended"))
        out = lifecycle.reconcile(client, items(), self.members(("sub-hag-a", "a@x.com"), ("kc-b", "b@x.com")))      # 이메일로도 알아본다
        self.assertEqual((out["suspended"], out["resumed"]), ([], ["hag-b"]))
        self.assertFalse(FakeAPI.agents["hag-b"]["spec"]["suspended"])

    def test_관리자가_멈춘_것과_미사용으로_멈춘_것은_Keycloak_대조가_다시_띄우지_않는다(self):
        client = k8s.client()
        lifecycle.suspend(client, "hag-a", "admin"); lifecycle.suspend(client, "hag-b", "idle")
        out = lifecycle.reconcile(client, client.list_agents(), self.members(("sub-hag-a", "a@x.com"), ("sub-hag-b", "b@x.com")))
        self.assertEqual(out["resumed"], [])
        self.assertTrue(FakeAPI.agents["hag-a"]["spec"]["suspended"] and FakeAPI.agents["hag-b"]["spec"]["suspended"])

    def test_구성원이_0명이거나_절반_넘게_멈추게_되면_설정_오류로_보고_중단한다(self):
        client = k8s.client()
        out = lifecycle.reconcile(client, client.list_agents(), [])
        self.assertIn("0명", out["skipped"])
        FakeAPI.agents.update({"hag-c": agent("hag-c", "c@x.com"), "hag-d": agent("hag-d", "d@x.com")})
        out = lifecycle.reconcile(client, client.list_agents(), self.members(("sub-hag-a", "a@x.com")))        # 4개 중 3개를 멈추게 된다
        self.assertEqual(out["suspended"], [])
        self.assertIn("중단", out["skipped"])
        self.assertFalse(any(a["spec"].get("suspended") for a in FakeAPI.agents.values()))

    def test_관리자_역할을_가진_그룹의_구성원도_AAS_사용자로_센다(self):
        """aas-admins 그룹에 역할 aas-admin 을 붙이면(스펙 2026-10-13-012 D1) 그룹 구성원은 역할을 직접 받지 않는다.
        /roles/{role}/users 는 직접 받은 사람만 주므로, 그룹 구성원을 빼면 aas-users 밖의 관리자가 「빠진 사람」이 되어 Hermes 가 멈춘다."""
        from aas.auth import keycloak
        httpd = ThreadingHTTPServer(("127.0.0.1", 0), FakeKeycloak)
        threading.Thread(target=httpd.serve_forever, daemon=True).start()
        try:
            FakeKeycloak.seen, FakeKeycloak.group_exists, FakeKeycloak.role_status = [], True, 200
            FakeKeycloak.group_members = [{"id": "u1", "email": "u1@x.com"}]
            FakeKeycloak.role_users = []
            FakeKeycloak.role_groups = [{"id": "ga", "name": "aas-admins"}]
            FakeKeycloak.role_group_members = [{"id": "kim", "email": "Kim@x.com"}, {"id": "u1", "email": "u1@x.com"}]
            kc = keycloak.KeycloakAdmin(f"http://127.0.0.1:{httpd.server_port}/realms/openmaru", "aas-admin-client", "kc-secret", "aas-users", "aas-admin")
            got = kc.members()
            self.assertIn({"id": "kim", "email": "kim@x.com"}, got)
            self.assertEqual(len(got), 2)                                                      # u1 은 두 곳에 있어도 하나
        finally:
            FakeKeycloak.role_groups, FakeKeycloak.role_group_members = [], []
            httpd.shutdown()

    def test_관리_API_클라이언트는_그룹_구성원과_관리자_역할_보유자를_쪽마다_읽는다(self):
        from aas.auth import keycloak
        httpd = ThreadingHTTPServer(("127.0.0.1", 0), FakeKeycloak)
        threading.Thread(target=httpd.serve_forever, daemon=True).start()
        try:
            FakeKeycloak.seen, FakeKeycloak.group_exists = [], True
            FakeKeycloak.group_members = [{"id": f"u{i}", "email": f"U{i}@x.com"} for i in range(230)]      # 100 단위 쪽 3개
            FakeKeycloak.role_users = [{"id": "boss", "email": "Boss@x.com"}, {"id": "u1", "email": "u1@x.com"}]
            kc = keycloak.KeycloakAdmin(f"http://127.0.0.1:{httpd.server_port}/realms/openmaru", "aas-admin-client", "kc-secret", "aas-users", "aas-admin")
            got = kc.members()
            self.assertEqual(len(got), 231)                                                    # 230명 + 관리자 1명(중복은 하나로)
            self.assertIn({"id": "boss", "email": "boss@x.com"}, got)
            self.assertEqual(len([s for s in FakeKeycloak.seen if s[1].endswith("/members")]), 3)
            FakeKeycloak.role_status = 404                                                      # 역할이 없으면 관리자가 없는 것이다
            self.assertEqual(len(kc.members()), 230)
            FakeKeycloak.role_status = 403                                                      # 권한 부족은 삼키지 않고 오류로 올린다(그룹 밖 관리자가 「빠진 사람」이 되지 않게)
            with self.assertRaises(keycloak.KeycloakError) as cm:
                kc.members()
            self.assertEqual(cm.exception.code, 403)
            FakeKeycloak.role_status = 200
            FakeKeycloak.group_exists = False
            with self.assertRaises(keycloak.KeycloakError):                                    # 그룹이 없으면 빈 목록이 아니라 오류
                kc.members()
            bad = keycloak.KeycloakAdmin(f"http://127.0.0.1:{httpd.server_port}/realms/openmaru", "c", "wrong", "aas-users", "aas-admin")
            with self.assertRaises(keycloak.KeycloakError):
                bad.members()
            with self.assertRaises(keycloak.KeycloakError):
                keycloak.KeycloakAdmin("http://x/not-a-realm", "c", "s", "g", "r")
        finally:
            httpd.shutdown()

    def test_하루_점검은_한쪽이_실패해도_다른_쪽을_하고_결과를_남긴다(self):
        class Boom:
            def members(self):
                from aas.auth import keycloak
                raise keycloak.KeycloakError("Keycloak 에 연결할 수 없습니다")
        out = server.lifecycle_once(Boom())
        self.assertIn("Keycloak 대조", out["errors"][0])
        self.assertEqual(out["idle"], [])
        class Ok:
            def members(self):
                return [{"id": "sub-hag-a", "email": "a@x.com"}, {"id": "sub-hag-b", "email": "b@x.com"}]
        self.assertEqual(server.lifecycle_once(Ok())["keycloak"]["suspended"], [])

    def test_설정이_없으면_관리_클라이언트를_만들지_않는다(self):
        from aas.auth import keycloak
        for k in ("AAS_OIDC_ISSUER", "AAS_KEYCLOAK_ADMIN_CLIENT_ID", "AAS_KEYCLOAK_ADMIN_CLIENT_SECRET"):
            os.environ.pop(k, None)
        self.assertIsNone(keycloak.admin_from_config())

    def test_관리_클라이언트는_내부_발견_주소가_있으면_그_주소로_닿는다(self):
        from unittest import mock
        from aas.auth import keycloak
        env = {"AAS_OIDC_ISSUER": "https://aas-sso.example.com/realms/aas", "AAS_KEYCLOAK_ADMIN_CLIENT_ID": "aas-admin",
               "AAS_KEYCLOAK_ADMIN_CLIENT_SECRET": "s", "AAS_OIDC_DISCOVERY_URL": "http://aas-keycloak.cogentai-aas.svc:8080/realms/aas"}
        with mock.patch.dict(os.environ, env):
            kc = keycloak.admin_from_config()
            self.assertEqual(kc.base, "http://aas-keycloak.cogentai-aas.svc:8080")
            self.assertEqual(kc.realm, "aas")
        env.pop("AAS_OIDC_DISCOVERY_URL")
        with mock.patch.dict(os.environ, env):
            self.assertEqual(keycloak.admin_from_config().base, "https://aas-sso.example.com")


class FakeSkillHub(BaseHTTPRequestHandler):
    """SkillHub 흉내: 스킬 패키지 하나(free/web-search 1.0.0)의 파일 목록과 zip."""
    files = {"SKILL.md": b"# web search\nuse it", "scripts/run.py": b"print('hi')"}
    tamper = False

    def log_message(self, *a):
        pass

    @classmethod
    def zip_bytes(cls) -> bytes:
        import io, zipfile
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w") as z:
            for name, data in cls.files.items():
                z.writestr(name, data)
        return buf.getvalue()

    def do_GET(self):
        import hashlib
        base = "/api/v1/skills/free/web-search/versions/1.0.0"
        if self.path == base + "/files":
            listing = [{"filePath": n, "sha256": hashlib.sha256(d if not FakeSkillHub.tamper else b"x").hexdigest()} for n, d in FakeSkillHub.files.items()]
            body = json.dumps({"data": listing}).encode()
        elif self.path == base + "/download":
            body = FakeSkillHub.zip_bytes()
        else:
            self.send_response(404); self.end_headers(); return
        self.send_response(200); self.send_header("Content-Length", str(len(body))); self.end_headers()
        self.wfile.write(body)


class MarketDispatchTest(K8sBase):
    """R4: 마켓 설치·지우기 요청(파일 큐)을 HermesTask 로 보내고 결과를 done 에 적는다. 서버에는 exec 권한이 없다."""

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.hub = ThreadingHTTPServer(("127.0.0.1", 0), FakeSkillHub)
        threading.Thread(target=cls.hub.serve_forever, daemon=True).start()
        cls.old_hub = os.environ.get("AAS_SKILLHUB_URL")
        os.environ["AAS_SKILLHUB_URL"] = f"http://127.0.0.1:{cls.hub.server_port}"

    @classmethod
    def tearDownClass(cls):
        cls.hub.shutdown()
        os.environ.pop("AAS_SKILLHUB_URL", None) if cls.old_hub is None else os.environ.__setitem__("AAS_SKILLHUB_URL", cls.old_hub)
        super().tearDownClass()

    def setUp(self):
        super().setUp()
        self.wipe()
        FakeSkillHub.tamper = False
        self.client = k8s.client()
        self.n = 0

    def tearDown(self):
        self.wipe()                                  # 시험들이 AAS 데이터 폴더를 함께 쓴다 — 심장박동·done 기록을 남기면 다른 시험(test_market)이 어긋난다

    @staticmethod
    def wipe():
        import shutil
        from aas.common import store
        shutil.rmtree(store.data_dir() / "market", ignore_errors=True)

    def row(self, **over):
        self.n += 1
        row = {"id": f"2026101012000000000{self.n}-abc12{self.n}", "ts": "2026-10-10T12:00:00+09:00", "who": "admin@x.com", "pod": "hag-kim", "container": "hag-kim",
               "package": "free/web-search", "namespace": "free", "name": "web-search", "version": "1.0.0", "kind": "skill", "profile": "ma", "mode": "install", "status": "queued"}
        row.update(over)
        from aas.market import market_dispatch
        market_dispatch._write("queue", row)
        return row

    def tick(self, names=("hag-kim",)):
        from aas.market import market_dispatch
        return market_dispatch.tick(self.client, set(names))

    def rows(self, kind):
        from aas.market import marketplace
        return {r["id"]: r for r in (marketplace._read(p) for p in marketplace._dir(kind).glob("*.json")) if r}

    def test_스킬_설치_요청은_HermesTask_가_되고_결과가_done_으로_온다(self):
        import base64, io, tarfile
        row = self.row()
        self.tick()
        task = FakeAPI.tasks["mkt-" + row["id"]]
        spec = task["spec"]
        self.assertEqual((spec["agent"], spec["type"], spec["profile"], spec["force"], spec["requestedBy"]), ("hag-kim", "ProfileInstall", "ma", True, "admin@x.com"))
        names = tarfile.open(fileobj=io.BytesIO(base64.b64decode(spec["payload"])), mode="r:gz").getnames()
        self.assertIn("distribution.yaml", names)
        self.assertIn("skills/market/web-search/SKILL.md", names)
        queued = self.rows("queue")[row["id"]]
        self.assertEqual((queued["status"], queued["task"]), ("running", "mkt-" + row["id"]))
        self.tick()                                                                   # 아직 진행 중이면 그대로
        self.assertEqual(self.rows("queue")[row["id"]]["status"], "running")
        FakeAPI.tasks["mkt-" + row["id"]]["status"] = {"phase": "Succeeded", "message": "설치했습니다"}
        self.tick()
        done = self.rows("done")[row["id"]]
        self.assertEqual((done["status"], done["message"]), ("done", "설치했습니다"))
        self.assertNotIn(row["id"], self.rows("queue"))
        self.assertEqual(FakeAPI.tasks, {})                                           # 결과를 가져간 작업은 지운다
        from aas.market import marketplace
        self.assertEqual([(r["profile"], r["package"], r["version"]) for r in marketplace.installed("hag-kim")], [("ma", "free/web-search", "1.0.0")])

    def test_오퍼레이터가_실패로_끝내면_이유가_그대로_done_에_남는다(self):
        row = self.row()
        self.tick()
        FakeAPI.tasks["mkt-" + row["id"]]["status"] = {"phase": "Failed", "message": "Hermes 가 설치를 거절했습니다: profile 'ma' already exists"}
        self.tick()
        done = self.rows("done")[row["id"]]
        self.assertEqual(done["status"], "failed")
        self.assertIn("already exists", done["message"])
        from aas.market import marketplace
        self.assertEqual(marketplace.installed("hag-kim"), [])                       # 실패는 설치 기록이 되지 않는다

    def test_지우기_요청은_payload_없는_SkillRemove_작업이다(self):
        row = self.row(mode="remove")
        self.tick()
        spec = FakeAPI.tasks["mkt-" + row["id"]]["spec"]
        self.assertEqual((spec["type"], spec["skillName"], spec["profile"]), ("SkillRemove", "web-search", "ma"))
        self.assertNotIn("payload", spec)

    def test_받은_묶음의_해시가_다르면_작업을_만들지_않고_실패로_닫는다(self):
        FakeSkillHub.tamper = True
        row = self.row()
        self.tick()
        self.assertEqual(FakeAPI.tasks, {})
        done = self.rows("done")[row["id"]]
        self.assertEqual(done["status"], "failed")
        self.assertIn("해시", done["message"])

    def test_없는_Hermes_나_잘못된_요청은_바로_실패(self):
        a = self.row(pod="hag-none")
        b = self.row(profile="default")
        c = self.row(profile="Bad Name")
        self.tick()
        done = self.rows("done")
        self.assertIn("없습니다", done[a["id"]]["message"])
        self.assertIn("공용", done[b["id"]]["message"])
        self.assertIn("profile", done[c["id"]]["message"])
        self.assertEqual(FakeAPI.tasks, {})

    def test_보낸_뒤_기록하기_전에_멈췄어도_이어_간다(self):
        row = self.row()
        from aas.market import market_dispatch
        self.tick()
        r = self.rows("queue")[row["id"]]
        r.pop("task"); r["status"] = "queued"                                       # 작업은 만들어졌는데 요청 기록은 되돌아간 상태
        market_dispatch._write("queue", r)
        self.tick()                                                                  # 409 → 만들어진 것으로 보고 이어 간다
        self.assertEqual(len(FakeAPI.tasks), 1)
        self.assertEqual(self.rows("queue")[row["id"]]["status"], "running")

    def test_작업이_사라지거나_너무_오래_걸리면_실패로_닫는다(self):
        gone = self.row()
        self.tick()
        FakeAPI.tasks.clear()
        self.tick()
        self.assertIn("사라졌습니다", self.rows("done")[gone["id"]]["message"])
        slow = self.row()
        self.tick()
        from aas.market import market_dispatch
        r = self.rows("queue")[slow["id"]]
        r["dispatched"] = "2026-10-10T11:00:00+09:00"                                # 한참 전에 보냈다
        market_dispatch._write("queue", r)
        self.tick()
        self.assertIn("시간 안에", self.rows("done")[slow["id"]]["message"])
        self.assertEqual(FakeAPI.tasks, {})

    def test_쿠버네티스에_잠깐_닿지_않으면_요청을_그대로_두고_다음에_다시_본다(self):
        row = self.row()
        self.tick()
        FakeAPI.down = True
        self.tick()
        self.assertEqual(self.rows("queue")[row["id"]]["status"], "running")
        FakeAPI.down = False
        FakeAPI.tasks["mkt-" + row["id"]]["status"] = {"phase": "Succeeded", "message": "설치했습니다"}
        self.tick()
        self.assertEqual(self.rows("done")[row["id"]]["status"], "done")

    def test_배달기는_심장박동을_남겨_화면의_도우미_상태가_산다(self):
        from aas.market import marketplace
        self.tick()
        st = marketplace.helper_status()
        self.assertTrue(st["alive"])
        self.row(profile="default")
        self.tick()
        self.assertIn("공용", marketplace.helper_status()["error"])

    def test_묶음은_같은_입력이면_같은_바이트고_너무_크면_거절한다(self):
        from aas.market import market_stage
        req = {"namespace": "free", "name": "web-search", "version": "1.0.0", "profile": "ma", "kind": "skill", "mode": "install", "package": "free/web-search"}
        a, _ = market_stage.build_payload(req)
        b, _ = market_stage.build_payload(req)
        self.assertEqual(a, b)
        old = dict(FakeSkillHub.files)
        import os as _os
        FakeSkillHub.files = {"SKILL.md": b"# x", "big.bin": _os.urandom(700 * 1024)}           # 압축이 안 되는 700KiB
        try:
            with self.assertRaises(market_stage.Refuse) as cm:
                market_stage.build_payload(req)
            self.assertIn("너무 큽니다", str(cm.exception))
        finally:
            FakeSkillHub.files = old

    def test_채널_상태는_HermesAgent_status_에서_읽는다(self):
        from aas.ops import channels
        FakeAPI.agents = {"hag-kim": agent("hag-kim", "kim@x.com", channels=[{"name": "telegram", "up": True, "status": "up (pid 9) 100 seconds"},
                                                                                {"name": "buzz", "up": False, "disabled": True, "status": "down"}],
                                         channelsCheckedAt="2026-10-10T12:00:00Z")}
        got = channels.service_status("hag-kim")
        self.assertEqual((got["telegram"]["up"], got["buzz"]["disabled"]), (True, True))
        v = agents.view(FakeAPI.agents["hag-kim"])
        self.assertEqual((len(v["channels"]), v["channels_checked"], v["channels_error"]), (2, "2026-10-10T12:00:00Z", ""))
        FakeAPI.down = True
        self.assertEqual(channels.service_status("hag-kim"), {})                           # 못 읽으면 「모름」

    def test_s6_없는_이미지는_읽었는데_비어_있어도_서비스_상태를_안_것으로_본다(self):
        """오퍼레이터가 컨테이너를 읽었는데(확인 시각 있고 오류 없음) s6 서비스가 없으면 s6 를 쓰지 않는 이미지다.
        읽지 못한 것이 아니므로 화면이 「서비스 상태를 읽지 못했다」고 경고하면 안 된다."""
        import tempfile
        from unittest import mock
        from aas.ops import channels
        FakeAPI.down = False
        FakeAPI.agents = {"hag-kim": agent("hag-kim", "kim@x.com", channelsCheckedAt="2026-10-11T09:00:00Z")}   # channels 없음
        self.assertEqual(channels.service_status("hag-kim"), {})
        self.assertTrue(channels.services_checked("hag-kim"))
        with tempfile.TemporaryDirectory() as home:
            self.assertTrue(channels.collect(Path(home), "hag-kim")["services_known"])
        # 읽다가 실패했다: 오퍼레이터가 이유를 적어 둔다 → 모름
        FakeAPI.agents = {"hag-kim": agent("hag-kim", "kim@x.com", channelsCheckedAt="2026-10-11T09:00:00Z",
                                         channelsError="채널 상태를 읽지 못했습니다: container not found")}
        self.assertFalse(channels.services_checked("hag-kim"))
        with tempfile.TemporaryDirectory() as home:
            self.assertFalse(channels.collect(Path(home), "hag-kim")["services_known"])
        # 아직 한 번도 읽지 않았다 → 모름
        FakeAPI.agents = {"hag-kim": agent("hag-kim", "kim@x.com")}
        self.assertFalse(channels.services_checked("hag-kim"))
        # 클러스터를 읽지 못한다 → 모름
        FakeAPI.agents = {"hag-kim": agent("hag-kim", "kim@x.com", channelsCheckedAt="2026-10-11T09:00:00Z")}
        FakeAPI.down = True
        self.assertFalse(channels.services_checked("hag-kim"))
        FakeAPI.down = False
        # 서비스 목록이 있으면 그대로 안다
        FakeAPI.agents = {"hag-kim": agent("hag-kim", "kim@x.com", channels=[{"name": "default", "up": True, "status": "up"}],
                                         channelsCheckedAt="2026-10-11T09:00:00Z")}
        with tempfile.TemporaryDirectory() as home:
            self.assertTrue(channels.collect(Path(home), "hag-kim")["services_known"])

    def test_쿠버네티스_모드가_아니면_서비스_상태를_모른다(self):
        import tempfile
        from unittest import mock
        from aas.ops import channels
        with mock.patch("aas.fleet.k8s.client", return_value=None), tempfile.TemporaryDirectory() as home:
            self.assertFalse(channels.services_checked("hag-kim"))
            self.assertFalse(channels.collect(Path(home), "hag-kim")["services_known"])



# ---- 순차 롤아웃(스펙 2026-10-28-015 §4-4·§4-6, 디자인 리뷰 DD1~DD19) -------------------------------------
H1 = "reg.local/hermes@sha256:" + "1" * 64
H2 = "reg.local/hermes@sha256:" + "2" * 64
S2 = "reg.local/sidecar@sha256:" + "4" * 64


def rollout(name, phase="", image=H2, created="2026-10-29T00:00:00Z", agents_=(), **spec_status):
    spec = {"versionName": "1.0.6", "image": image, "batchSize": 2, **{k: v for k, v in spec_status.items() if not k.startswith("st_")}}
    st = {"phase": phase, "agents": list(agents_), **{k[3:]: v for k, v in spec_status.items() if k.startswith("st_")}}
    return {"metadata": {"name": name, "creationTimestamp": created}, "spec": spec, "status": st}


class RolloutViewTest(unittest.TestCase):
    def test_롤아웃이_한_번도_없으면_오래됨을_알_수_없다(self):
        from aas.fleet import rollouts
        a = agent("hag-a", "a@x.com", image=H1)
        f = rollouts.agent_fields(a, [])
        self.assertEqual((f["outdated"], f["version"], f["image_digest"], f["pinned"]), (None, "", H1, False))
        self.assertEqual(rollouts.summary([], [a])["rollout"], None)

    def test_마지막_Done_의_기본값과_digest_로_오래됨을_가른다(self):
        from aas.fleet import rollouts
        done = rollout("r1", "Done", st_completionTime="2026-10-29T01:00:00Z", st_defaultImage=H2)
        old, new = agent("hag-a", "a@x.com", image=H1), agent("hag-b", "b@x.com", image=H2)
        self.assertTrue(rollouts.agent_fields(old, [done])["outdated"])
        f = rollouts.agent_fields(new, [done])
        self.assertEqual((f["outdated"], f["version"]), (False, "1.0.6"))
        pinned = agent("hag-c", "c@x.com", image="custom/h:1")
        pinned["spec"]["image"] = "custom/h:1"
        self.assertEqual((rollouts.agent_fields(pinned, [done])["pinned"], rollouts.agent_fields(pinned, [done])["outdated"]), (True, False))

    def test_목표가_digest_없는_태그인_컨테이너는_오래됨을_가르지_않는다(self):
        # 2026-10-29 OKE: Hermes 만 바꾸는 롤아웃은 목표 사이드카가 차트 태그(`…-sidecar:1.0.5`)라 digest 가 비어,
        # 같은 Hermes digest 로 도는 에이전트 9개가 모두 「오래됨」으로 보였다
        from aas.fleet import rollouts
        r = rollout("r1", "Canary", st_defaultImage=H2, st_defaultSidecarImage="reg.local/sidecar:1.0.5")
        a = agent("hag-a", "a@x.com", image=H2)
        a["status"]["sidecarImage"] = "reg.local/sidecar@sha256:" + "7" * 64
        self.assertEqual(rollouts.agent_fields(a, [r])["outdated"], False)
        b = agent("hag-b", "b@x.com", image=H1)
        b["status"]["sidecarImage"] = a["status"]["sidecarImage"]
        self.assertTrue(rollouts.agent_fields(b, [r])["outdated"])
        c = agent("hag-c", "c@x.com", image="custom/h:1")
        c["spec"]["image"] = "custom/h:1"
        self.assertEqual(rollouts.agent_fields(c, [r])["pinned"], True)  # 사이드카는 바뀌지 않으므로 Hermes 만 덮어써도 빠진다

    def test_abort_받은_롤아웃과_Failed_는_진행_중이_아니다(self):
        from aas.fleet import rollouts
        self.assertTrue(rollouts.blocking(rollout("r", "Rolling")))
        self.assertFalse(rollouts.blocking(rollout("r", "Failed")))
        self.assertFalse(rollouts.blocking(rollout("r", "Rolling", abort=True)))
        cur = rollouts.current([rollout("old", "Done", created="2026-10-28T00:00:00Z"), rollout("new", "Failed", created="2026-10-29T00:00:00Z")])
        self.assertEqual(cur["metadata"]["name"], "new")                                   # 진행 중이 없으면 가장 최근 것

    def test_요약은_분모와_다음_묶음과_대화_중_미룸을_준다(self):
        from datetime import datetime, timezone
        from aas.fleet import rollouts
        ags = [{"name": "a1", "state": "done"}, {"name": "a2", "state": "waiting"}, {"name": "a3", "state": "waiting"},
               {"name": "a4", "state": "waiting", "suspended": True}, {"name": "a5", "state": "updating"}]
        ro = rollout("r1", "Rolling", agents_=ags, st_excluded=["pin"], st_batch=2)
        busy = agent("a2", "x@x.com")
        busy["metadata"]["annotations"] = {rollouts.ANN_BUSY: "2026-10-29T09:02:00Z"}
        out = rollouts.summary([ro], [busy, agent("a3", "y@x.com")], now=datetime(2026, 10, 29, 9, 0, tzinfo=timezone.utc))["rollout"]
        self.assertEqual((out["total"], out["done"], out["waiting"], out["updating"], out["excluded"], out["suspended"]), (5, 1, 3, ["a5"], ["pin"], 1))
        self.assertEqual((out["next_batch"], out["deferred_busy"]), (["a3", "a4"], 1))      # 대화 중(a2)은 뒤로
        self.assertEqual(out["phase"], "Rolling")

    def test_차트_값과_다르면_알린다(self):
        from aas.fleet import rollouts
        done = rollout("r1", "Done", st_completionTime="t", st_defaultImage=H2, st_chartImage=H1)
        self.assertTrue(rollouts.summary([done], [])["chart_differs"])
        same = rollout("r1", "Done", st_completionTime="t", st_defaultImage=H2, st_chartImage=H2)
        self.assertFalse(rollouts.summary([same], [])["chart_differs"])

    def test_차트_태그가_롤아웃_버전_이름과_같으면_같은_판으로_본다(self):
        # 2026-10-29 OKE: 롤아웃은 digest(`…@sha256:c2da…`), 차트는 태그(`…:1.0.5-0.22.2`)라 글자가 늘 달라
        # 태그가 같은 이미지를 가리키는데도 「차트 값과 다릅니다」가 떴다
        from aas.fleet import rollouts
        def done(chart, image=H2, version="1.0.5-0.22.2"):
            return rollout("r1", "Done", image=image, versionName=version, st_completionTime="t",
                           st_defaultImage=image, st_chartImage=chart)
        self.assertFalse(rollouts.summary([done("reg.local/hermes:1.0.5-0.22.2")], [])["chart_differs"])
        self.assertTrue(rollouts.summary([done("reg.local/hermes:1.0.5-0.22.1")], [])["chart_differs"])   # 다른 판
        self.assertTrue(rollouts.summary([done("other.local/hermes:1.0.5-0.22.2")], [])["chart_differs"])  # 다른 저장소
        self.assertTrue(rollouts.summary([done("reg.local/hermes")], [])["chart_differs"])                 # 태그 없음
        self.assertTrue(rollouts.summary([done(H1)], [])["chart_differs"])                                 # 다른 digest
        self.assertTrue(rollouts.summary([done("reg.local:8443/hermes:1.0.6", image="reg.local:8443/hermes:1.0.5", version="1.0.6")], [])["chart_differs"])  # 롤아웃이 태그면 글자로만


class RolloutWriteTest(K8sBase):
    def setUp(self):
        super().setUp()
        FakeAPI.agents = {"hag-a": agent("hag-a", "a@x.com"), "hag-b": agent("hag-b", "b@x.com")}
        self.reg = pods.Registry(Path(TMP.name) / "없는-등록부.json")
        self.admin = {"email": "admin@x.com"}

    def write(self, path, body, user=None):
        return server._agents_write(self.reg, user or self.admin, True, path, body)

    def test_시작은_형식을_검사하고_관리자만(self):
        bad = [({"image": H2}, "버전 이름"), ({"version_name": "v"}, "하나 이상"), ({"version_name": "v", "image": "reg/h:1.0"}, "sha256"),
               ({"version_name": "v", "image": H2, "canary": ["없음"]}, "카나리"), ({"version_name": "v", "image": H2, "batch_size": 9}, "묶음")]
        for body, word in bad:
            with self.assertRaises(agents.AgentError) as cm:
                self.write("/api/agents/rollout", body)
            self.assertIn(word, str(cm.exception))
        with self.assertRaises(agents.AgentError) as cm:
            self.write("/api/agents/rollout", {"version_name": "v", "image": H2}, user={"email": "a@x.com"})
        self.assertEqual(cm.exception.code, 403)
        out, code = self.write("/api/agents/rollout", {"version_name": "1.0.6", "image": H2, "sidecar_image": S2, "canary": ["hag-a"], "batch_size": 3, "skip_busy": False})
        spec = FakeAPI.rollouts[out["rollout"]]["spec"]
        self.assertEqual((code, spec["image"], spec["sidecarImage"], spec["canary"], spec["batchSize"], spec["skipBusy"]), (201, H2, S2, ["hag-a"], 3, False))
        self.assertEqual(FakeAPI.rollouts[out["rollout"]]["metadata"]["annotations"]["aas.openmaru.io/created-by"], "admin@x.com")
        with self.assertRaises(agents.AgentError) as cm:                                    # 진행 중(phase 가 아직 없음)이면 두 번째는 409
            self.write("/api/agents/rollout", {"version_name": "1.0.7", "image": H2})
        self.assertEqual(cm.exception.code, 409)

    def test_계속은_멈춤이면_paused_승인_대기면_approved(self):
        FakeAPI.rollouts = {"r1": rollout("r1", "WaitingApproval", canary=["hag-a"])}
        self.write("/api/agents/rollout/action", {"name": "r1", "action": "resume"})
        self.assertTrue(FakeAPI.rollouts["r1"]["spec"]["approved"])
        self.write("/api/agents/rollout/action", {"name": "r1", "action": "pause"})
        self.assertTrue(FakeAPI.rollouts["r1"]["spec"]["paused"])
        self.write("/api/agents/rollout/action", {"name": "r1", "action": "resume"})
        self.assertFalse(FakeAPI.rollouts["r1"]["spec"]["paused"])
        FakeAPI.rollouts["r1"]["status"]["phase"] = "Done"
        with self.assertRaises(agents.AgentError) as cm:
            self.write("/api/agents/rollout/action", {"name": "r1", "action": "pause"})
        self.assertEqual(cm.exception.code, 409)

    def test_되돌리기는_진행_중이면_abort_뒤_rollbackOf_롤아웃을_만든다(self):
        FakeAPI.rollouts = {"r1": rollout("r1", "Paused", agents_=[{"name": "hag-a", "state": "done"}, {"name": "hag-b", "state": "waiting"}])}
        out, code = self.write("/api/agents/rollout/action", {"name": "r1", "action": "rollback"})
        self.assertTrue(FakeAPI.rollouts["r1"]["spec"]["abort"])
        back = FakeAPI.rollouts[out["rollout"]]["spec"]
        self.assertEqual((code, back["rollbackOf"], "image" in back, "canary" in back), (200, "r1", False, False))
        with self.assertRaises(agents.AgentError) as cm:                                    # 되돌리기를 다시 되돌리지는 않는다
            self.write("/api/agents/rollout/action", {"name": out["rollout"], "action": "rollback"})
        self.assertEqual(cm.exception.code, 409)

    def test_목록의_버전_칸과_요약은_관리자에게만(self):
        FakeAPI.agents["hag-a"]["status"]["image"] = H1
        FakeAPI.rollouts = {"r1": rollout("r1", "Done", st_completionTime="2026-10-29T01:00:00Z", st_defaultImage=H2)}
        self.reg.refresh(ttl=0)
        admin = server._agents_list(self.reg, self.admin, True)
        a = next(x for x in admin["agents"] if x["name"] == "hag-a")
        self.assertEqual((a["outdated"], a["image_digest"], admin["target"]["image"], admin["rollout"]["name"]), (True, H1, H2, "r1"))
        user = server._agents_list(self.reg, {"email": "a@x.com"}, True)
        self.assertNotIn("rollout", user)
        self.assertNotIn("image_digest", user["agents"][0])

    def test_CRD_가_없는_클러스터에서도_목록은_뜬다(self):
        FakeAPI.rollouts = None
        self.reg.refresh(ttl=0)
        out = server._agents_list(self.reg, self.admin, True)
        self.assertEqual((len(out["agents"]), out["rollout"], self.reg.rollouts), (2, None, []))

    def test_대화_중_표시는_1분_넘게_남으면_다시_쓰지_않는다(self):
        from aas.fleet import rollouts
        rollouts._busy_until.clear()
        c = k8s.client()
        self.assertTrue(rollouts.mark_busy(c, "hag-a", now=1000.0))
        self.assertIn(rollouts.ANN_BUSY, FakeAPI.agents["hag-a"]["metadata"]["annotations"])
        self.assertFalse(rollouts.mark_busy(c, "hag-a", now=1050.0))                       # 70초 남음
        self.assertTrue(rollouts.mark_busy(c, "hag-a", now=1065.0))                        # 55초 남음
        self.assertEqual(len([s for s in FakeAPI.seen if s[0] == "PATCH"]), 2)

    def test_롤아웃이_바꾸는_중이면_다시_뜨는_이유가_update(self):
        item = agent("hag-a", "a@x.com", phase="Provisioning", readyPodUID="u1")
        item["metadata"]["annotations"] = {"aas.openmaru.io/rollout-updating": "r1@2026-10-29T00:00:00Z"}
        pod = agents.restarting_pod_from(item)
        self.assertEqual((pod.restart_reason, pod.public()["restart_reason"], agents.view(item)["updating"]), ("update", "update", True))
        plain = agents.restarting_pod_from(agent("hag-b", "b@x.com", phase="NotReady"))
        self.assertNotIn("restart_reason", plain.public())


from datetime import datetime, timezone  # noqa: E402


def cap_doc(checked="2026-10-30T10:00:00Z", pending=0, w5_pods=42, **over):
    """aas-capacity 의 capacity.json(스펙 2026-10-30-003 §4-8). 숫자는 §5-3 OKE 실측과 같아 합계 15, 14개가 worker-5."""
    doc = {
        "version": 1, "computedAt": checked, "checkedAt": checked,
        "defaults": {"resources": {"requests": {"cpu": "500m", "memory": "1280Mi"}, "limits": {"cpu": "4", "memory": "4Gi"}}, "storage": "5Gi"},
        "podExtra": {"cpu": "10m", "memory": "64Mi"},
        "nodes": [
            {"name": "oke-worker-1", "allocatable": {"cpu": "16", "memory": "31881Mi"}, "maxPods": 110, "pods": 42,
             "requests": {"cpu": "14070m", "memory": "31100Mi"}, "limits": {"cpu": "55500m", "memory": "93918Mi"},
             "fixedRequests": {"cpu": "600m", "memory": "900Mi"},
             "agents": [{"name": "hag-kim", "requests": {"cpu": "510m", "memory": "1344Mi"}}]},
            {"name": "oke-worker-2", "allocatable": {"cpu": "32", "memory": "31881Mi"}, "maxPods": 110, "pods": 40,
             "requests": {"cpu": "19335m", "memory": "30419Mi"}, "limits": {"cpu": "40", "memory": "56110Mi"},
             "fixedRequests": {"cpu": "600m", "memory": "900Mi"}, "agents": []},
            {"name": "oke-worker-5", "allocatable": {"cpu": "20", "memory": "47616Mi"}, "maxPods": 110, "pods": w5_pods,
             "requests": {"cpu": "11955m", "memory": "28642Mi"}, "limits": {"cpu": "30", "memory": "47140Mi"},
             "fixedRequests": {"cpu": "600m", "memory": "900Mi"}, "agents": [{"name": "hag-kim2", "requests": {"cpu": "510m", "memory": "1344Mi"}}]},
        ],
        "pendingHermes": {"count": pending, "cpu": f"{510 * pending}m", "memory": f"{1344 * pending}Mi"},
    }
    doc.update(over)
    return {"capacity.json": json.dumps(doc)}


NOW = datetime(2026, 10, 30, 10, 0, 30, tzinfo=timezone.utc)


class SizeTest(K8sBase):
    """스펙 2026-10-30-003 §9-3 T4~T9·T16·T17·T20: 작업공간 크기(사람 → 관리자 기본값 → 설치값), 저장 전 검사, 크기 롤아웃, 남은 자리."""

    def setUp(self):
        super().setUp()
        self.reg = pods.Registry(Path(TMP.name) / "없는-등록부.json")
        self.admin = {"email": "admin@x.com"}
        agents.forget_capacity()
        self.addCleanup(self.clear)
        self.clear()

    def clear(self):
        from aas.common import store
        with store.connect() as conn:                          # 다른 시험과 같은 데이터 폴더를 쓴다 — 넣은 행을 지운다
            conn.execute(agents.SIZE_SCHEMA)
            conn.execute("DELETE FROM agent_sizes")
        agents.forget_capacity()

    def write(self, path, body, user=None):
        return server._agents_write(self.reg, user or self.admin, True, path, body)

    def size(self, email, force=False, **vals):
        return self.write("/api/agents/size", {"email": email, **{f: None for f in agents.SIZE_FIELDS}, **vals, **({"force": True} if force else {})})

    def kim(self, n=1):
        for name in ["hag-kim", "hag-kim2"][:n]:
            FakeAPI.agents[name] = agent(name, "kim@x.com")
        FakeAPI.agents["hag-lee"] = agent("hag-lee", "lee@x.com")

    def resize_rollouts(self):
        return [r for r in FakeAPI.rollouts.values() if r["spec"].get("kind") == "resize"]

    # T4: 칸마다 사람 → 관리자 기본값, 둘 다 없으면 빈 칸. 만들 때 spec 에 넣는다. 관리자 기본값 저장은 새 작업공간에만(D5)
    def test_T4_우선순위는_칸마다_사람_관리자_순이고_만들_때_spec_에_넣는다(self):
        self.kim()
        out, code = self.size("*", cpu_request="1", memory_limit="8Gi", storage="10Gi")
        self.assertEqual((code, out.get("rollout"), self.resize_rollouts(), FakeAPI.patches), (200, None, [], []))   # 기존 작업공간은 그대로
        self.size("kim@x.com", memory_limit="16Gi")
        self.assertEqual(agents.desired("kim@x.com"), {"cpu_request": "1", "memory_request": None, "cpu_limit": None, "memory_limit": "16Gi", "storage": "10Gi"})
        self.assertEqual(agents.desired("lee@x.com")["memory_limit"], "8Gi")
        out, _ = self.write("/api/agents", {"owner_email": "kim@x.com", "name": "hag-kim-new"})
        spec = FakeAPI.agents["hag-kim-new"]["spec"]
        self.assertEqual((spec["resources"], spec["storage"]), ({"requests": {"cpu": "1"}, "limits": {"memory": "16Gi"}}, {"size": "10Gi"}))
        self.assertEqual(out["agent"]["size"]["memory_limit"], "16Gi")
        self.clear()
        self.write("/api/agents", {"owner_email": "lee@x.com", "name": "hag-lee-new"})
        self.assertNotIn("resources", FakeAPI.agents["hag-lee-new"]["spec"])                 # 정한 값이 없으면 지금과 같다(§4-1)

    # T5: 사람별 저장 → 그 사람의 작업공간 모두를 targets 로 한 크기 롤아웃(D14). spec 은 서버가 직접 고치지 않는다
    def test_T5_사람별_저장은_그_사람_작업공간으로_크기_롤아웃을_만든다(self):
        self.kim(2)
        self.size("*", cpu_request="1")
        out, code = self.size("kim@x.com", memory_request="2Gi", memory_limit="8Gi")
        ro = FakeAPI.rollouts[out["rollout"]]
        self.assertEqual((code, ro["spec"]["kind"], ro["spec"]["batchSize"], ro["spec"]["versionName"]), (200, "resize", 1, "kim@x.com 크기"))
        want = {"requests": {"cpu": "1", "memory": "2Gi"}, "limits": {"memory": "8Gi"}}             # 관리자 기본값 칸도 함께 들어간다(R12)
        self.assertEqual(ro["spec"]["resize"]["targets"], [{"agent": "hag-kim", "resources": want}, {"agent": "hag-kim2", "resources": want}])
        self.assertEqual(ro["metadata"]["annotations"]["aas.openmaru.io/created-by"], "admin@x.com")
        self.assertEqual(FakeAPI.patches, [])
        self.assertEqual(sorted(out["targets"]), ["hag-kim", "hag-kim2"])

    # T6: 지우면 관리자 기본값으로 간다(F3). 칸을 모두 비우면 행이 없어진다
    def test_T6_사람_값을_지우면_관리자_기본값으로_간다(self):
        self.kim()
        self.size("*", memory_limit="6Gi")
        self.size("kim@x.com", memory_limit="16Gi", cpu_limit="3")
        FakeAPI.rollouts = {}
        out, _ = self.size("kim@x.com")                                                       # 다섯 칸 모두 null
        self.assertNotIn("kim@x.com", agents.sizes())
        self.assertEqual(FakeAPI.rollouts[out["rollout"]]["spec"]["resize"]["targets"], [{"agent": "hag-kim", "resources": {"limits": {"memory": "6Gi"}}}])
        FakeAPI.rollouts = {}
        self.size("*")
        out, _ = self.size("kim@x.com")
        self.assertEqual(FakeAPI.rollouts[out["rollout"]]["spec"]["resize"]["targets"][0]["resources"], {})   # 빈 값: 오퍼레이터가 spec.resources 를 지운다(§4-8)
        self.assertEqual(agents.sizes(), {})

    # T7: 수량 모양·0·단위 섞임 거절(칸 이름과 함께), 요청 ≤ 한도는 설치 기본값까지 합친 값으로
    def test_T7_수량과_요청_한도를_검사하고_관리자만(self):
        for f, v in (("cpu_request", "abc"), ("cpu_request", "500Mi"), ("memory_limit", "2m"), ("memory_request", "0"), ("storage", "-1Gi"), ("cpu_limit", "1e3")):
            with self.assertRaises(agents.AgentError, msg=f"{f}={v}") as cm:
                self.size("*", **{f: v})
            self.assertEqual((cm.exception.code, cm.exception.field), (400, f))
        with self.assertRaises(agents.AgentError) as cm:
            self.size("not-email", cpu_request="1")
        self.assertEqual(cm.exception.code, 400)
        with self.assertRaises(agents.AgentError) as cm:
            self.size("*", cpu_request="2", cpu_limit="1")
        self.assertEqual(cm.exception.field, "cpu_request")
        FakeAPI.configmaps["aas-capacity"] = cap_doc()
        with self.assertRaises(agents.AgentError) as cm:                                      # 설치 한도 4Gi 보다 큰 요청
            self.size("*", memory_request="6Gi")
        self.assertIn("한도", str(cm.exception))
        with self.assertRaises(agents.AgentError) as cm:
            self.write("/api/agents/size", {"email": "*", "cpu_request": "1"}, user={"email": "kim@x.com"})
        self.assertEqual(cm.exception.code, 403)
        self.assertEqual(agents.sizes(), {})

    # T8: 어느 노드에도 안 들어가면 거절(F5), 도는 작업공간이 다시 뜨지 못하면 409 + blocked, force 로 저장(D6). 경고는 저장을 막지 않는다
    def test_T8_노드_자리_검사_거절_막힘_force_경고(self):
        self.kim()
        FakeAPI.configmaps["aas-capacity"] = cap_doc()
        with self.assertRaises(agents.AgentError) as cm:
            self.size("kim@x.com", memory_request="60Gi", memory_limit="60Gi")
        self.assertEqual(cm.exception.code, 400)
        self.assertIn("어느 노드에도", str(cm.exception))
        with self.assertRaises(agents.AgentError) as cm:                                      # worker-5 여유 18974Mi 보다 크다
            self.size("kim@x.com", memory_request="20Gi", memory_limit="24Gi")
        self.assertEqual(cm.exception.code, 409)
        blocked = cm.exception.extra["blocked"]
        self.assertEqual((blocked["agents"], [n["name"] for n in blocked["nodes"]]), (["hag-kim"], ["oke-worker-1", "oke-worker-2", "oke-worker-5"]))
        self.assertAlmostEqual(blocked["nodes"][2]["free_memory"] / 2 ** 20, 18974)
        self.assertEqual((agents.sizes(), FakeAPI.rollouts), ({}, {}))                     # 막히면 저장하지 않는다
        out, code = self.size("kim@x.com", force=True, memory_request="20Gi", memory_limit="24Gi")
        self.assertEqual((code, bool(out["rollout"])), (200, True))
        self.assertTrue(any("노드 oke-worker-1" in w and "%" in w for w in out["warnings"]))      # D9 한도 합 경고
        self.assertTrue(any("새 AI 에이전트 작업공간" in w for w in out["warnings"]))
        FakeAPI.rollouts = {}
        out, code = self.size("kim@x.com", memory_request="4Gi", memory_limit="8Gi")             # worker-5 로 옮겨 뜰 수 있다 — 막지 않는다
        self.assertEqual(code, 200)

    # T9: 주인 바꾸기 patch 에 새 주인의 크기를 넣고 옛 칸은 null 로 지운다(D8). 크기가 바뀌어 다시 뜰 자리가 없으면 409, force 로 통과
    def test_T9_주인_바꾸기는_새_주인의_크기를_같은_patch_에(self):
        self.kim()
        FakeAPI.agents["hag-kim"]["spec"]["resources"] = {"limits": {"memory": "16Gi", "cpu": "3"}}
        self.size("lee@x.com", memory_limit="8Gi")
        FakeAPI.rollouts, FakeAPI.patches = {}, []
        self.write("/api/agents/owner", {"name": "hag-kim", "owner_email": "lee@x.com"})
        name, body = FakeAPI.patches[-1]
        self.assertEqual((name, body["spec"]["ownerEmail"], body["spec"]["resources"]), ("hag-kim", "lee@x.com", {"limits": {"memory": "8Gi", "cpu": None}}))
        self.assertEqual(FakeAPI.agents["hag-kim"]["spec"]["resources"], {"limits": {"memory": "8Gi"}})
        FakeAPI.patches = []
        self.write("/api/agents/owner", {"name": "hag-lee", "owner_email": "park@x.com"})       # 정한 값이 없고 spec 도 비면 크기를 건드리지 않는다
        self.assertNotIn("resources", FakeAPI.patches[-1][1]["spec"])
        FakeAPI.configmaps["aas-capacity"] = cap_doc()
        agents.set_size("big@x.com", {"memory_request": "20Gi", "memory_limit": "24Gi"}, "t")
        with self.assertRaises(agents.AgentError) as cm:
            self.write("/api/agents/owner", {"name": "hag-kim", "owner_email": "big@x.com"})
        self.assertEqual((cm.exception.code, cm.exception.extra["blocked"]["agents"]), (409, ["hag-kim"]))
        self.write("/api/agents/owner", {"name": "hag-kim", "owner_email": "big@x.com", "force": True})
        self.assertEqual(FakeAPI.agents["hag-kim"]["spec"]["resources"]["requests"]["memory"], "20Gi")

    # T20: 진행 중인 롤아웃이 있으면 사람별 저장은 값만 저장하고(after_rollout), 「기존에도 적용」은 409(디자인 1C·7A)
    def test_T20_롤아웃_진행_중이면_값만_저장하고_기존에도_적용은_409(self):
        self.kim(2)
        FakeAPI.rollouts = {"r1": {"metadata": {"name": "r1", "creationTimestamp": "2026-10-30T00:00:00Z"}, "spec": {"versionName": "1.0.6", "image": H2}, "status": {"phase": "Rolling"}}}
        out, code = self.size("kim@x.com", memory_limit="8Gi")
        self.assertEqual((code, out.get("after_rollout"), list(FakeAPI.rollouts)), (200, True, ["r1"]))
        self.assertEqual(agents.sizes()["kim@x.com"]["memory_limit"], "8Gi")
        with self.assertRaises(agents.AgentError) as cm:
            self.write("/api/agents/size/apply", {})
        self.assertEqual(cm.exception.code, 409)
        FakeAPI.rollouts["r1"]["status"]["phase"] = "Done"
        self.size("*", cpu_request="1")
        self.reg.refresh(ttl=0)
        rows = {a["name"]: a for a in server._agents_list(self.reg, self.admin, True)["agents"]}
        self.assertEqual({n: a["size_differs"] for n, a in rows.items()}, {"hag-kim": True, "hag-kim2": True, "hag-lee": True})
        out, code = self.write("/api/agents/size/apply", {"names": ["hag-kim"]})                # 행 메뉴 「다시 적용」
        ro = FakeAPI.rollouts[out["rollout"]]["spec"]
        self.assertEqual((code, ro["kind"], ro["versionName"], [t["agent"] for t in ro["resize"]["targets"]]), (201, "resize", "kim@x.com 크기", ["hag-kim"]))
        with self.assertRaises(agents.AgentError) as cm:                                      # 크기 롤아웃도 진행 중이면 막는다(종류와 관계없이 하나)
            self.write("/api/agents/rollout", {"version_name": "1.0.7", "image": H2})
        self.assertEqual(cm.exception.code, 409)
        FakeAPI.rollouts = {}
        out, _ = self.write("/api/agents/size/apply", {})
        targets = FakeAPI.rollouts[out["rollout"]]["spec"]["resize"]["targets"]
        self.assertEqual((FakeAPI.rollouts[out["rollout"]]["spec"]["versionName"], sorted(t["agent"] for t in targets)), ("기본 크기", ["hag-kim", "hag-kim2", "hag-lee"]))
        self.assertEqual(next(t for t in targets if t["agent"] == "hag-lee")["resources"], {"requests": {"cpu": "1"}})

    def test_설정과_다름은_설치_기본값을_더해_비교한다(self):
        """R13: spec 이 설치값과 같은 값을 따로 적었으면 같다. spec 이 비었는데 관리자 기본값이 있으면 다르다. 설치값을 모르면 spec 과 desired 만."""
        install = agents.install_defaults(json.loads(cap_doc()["capacity.json"]))
        item = agent("a", "x@x.com")
        item["spec"]["resources"] = {"requests": {"cpu": "0.5"}}
        self.assertFalse(agents.size_differs(item, agents.desired("x@x.com", {}), install))     # 0.5 = 500m(설치값)
        self.assertTrue(agents.size_differs(item, agents.desired("x@x.com", {}), None))
        self.assertTrue(agents.size_differs(agent("b", "x@x.com"), agents.desired("x@x.com", {"*": {"memory_limit": "8Gi"}}), install))
        self.assertFalse(agents.size_differs(agent("b", "x@x.com"), agents.desired("x@x.com", {"*": {"memory_limit": "4096Mi"}}), install))

    # T16: 노드별 min(CPU, 메모리, maxPods−파드 수), Pending Hermes·총량 상한 빼기, 몰린 노드, 오래됨·모름·오류
    def test_T16_남은_자리_공식(self):
        doc = lambda **kw: json.loads(cap_doc(**kw)["capacity.json"])                         # noqa: E731
        out = agents.capacity("ok", doc(), {}, now=NOW)
        self.assertEqual((out["state"], out["slots"], [n["slots"] for n in out["by_node"]]), ("ok", 15, [0, 1, 14]))
        self.assertEqual((out["top_node"], out["by_node"][0]["memory_request_pct"], out["by_node"][0]["memory_limit_pct"]), ({"name": "oke-worker-5", "slots": 14}, 98, 295))
        self.assertAlmostEqual(out["pod"]["memory"] / 2 ** 20, 1344)
        self.assertEqual(out["short"], {"memory": 1})
        # 노드 전체 용량(allocatable)도 함께 준다 — 화면이 「남음 / 전체」를 보인다(2026-10-30)
        w1 = out["by_node"][0]
        self.assertEqual((w1["total_cpu"], w1["total_memory"] / 2 ** 20), (16, 31881))
        self.assertEqual(agents.capacity("ok", doc(w5_pods=108), {}, now=NOW)["slots"], 3)          # maxPods 110 − 108
        self.assertEqual(agents.capacity("ok", doc(pending=2), {}, now=NOW)["slots"], 13)
        quota = {"status": {"hard": {"pods": "10", "requests.memory": "100Gi"}, "used": {"pods": "8", "requests.memory": "10Gi"}}}
        q = agents.capacity("ok", doc(), {}, quota, now=NOW)
        self.assertEqual((q["slots"], q["quota_limited"]), (2, True))
        big = agents.capacity("ok", doc(), {"memory_request": "4Gi"}, now=NOW)                       # 관리자 기본값(또는 입력 창 값)으로 센다
        self.assertEqual([n["slots"] for n in big["by_node"]], [0, 0, 4])
        self.assertEqual(agents.capacity("ok", doc(checked="2026-10-30T09:57:00Z"), {}, now=NOW)["state"], "stale")
        self.assertEqual(agents.capacity("unknown", None, {})["slots"], None)
        # API: ConfigMap 없음 → unknown, 쿠버네티스 오류 → error, 있으면 ok(관리자 기본값으로 센다)
        self.assertEqual(server._agents_capacity(self.reg, self.admin, True, {})["state"], "unknown")
        FakeAPI.configmaps["aas-capacity"] = cap_doc(checked=datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"))
        self.size("*", memory_request="2Gi")
        out = server._agents_capacity(self.reg, self.admin, True, {})
        self.assertEqual((out["state"], [n["slots"] for n in out["by_node"]]), ("ok", [0, 0, 8]))                       # 2112Mi 로 18974Mi 여유
        self.assertEqual([n["slots"] for n in server._agents_capacity(self.reg, self.admin, True, {"memory_request": ["4Gi"]})["by_node"]], [0, 0, 4])
        FakeAPI.quotas["agents-quota"] = {"status": {"hard": {"pods": "3"}, "used": {"pods": "2"}}}
        self.assertEqual(server._agents_capacity(self.reg, self.admin, True, {})["slots"], 1)
        FakeAPI.configmaps["aas-capacity"] = {"capacity.json": "{깨짐"}
        self.assertEqual(server._agents_capacity(self.reg, self.admin, True, {})["state"], "error")

    # T17: 일반 사용자는 숫자 없이 available 만(D10)
    def test_T17_사용자에게는_available_만(self):
        user = {"email": "kim@x.com"}
        self.assertEqual(server._agents_capacity(self.reg, user, True, {}), {"available": None})
        stamp = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        FakeAPI.configmaps["aas-capacity"] = cap_doc(checked=stamp)
        self.assertEqual(server._agents_capacity(self.reg, user, True, {}), {"available": True})
        FakeAPI.configmaps["aas-capacity"] = cap_doc(checked=stamp, nodes=[])
        self.assertEqual(server._agents_capacity(self.reg, user, True, {"memory_request": ["1Gi"]}), {"available": False})
        with self.assertRaises(agents.AgentError) as cm:
            server._agents_sizes(self.reg, user, True)
        self.assertEqual(cm.exception.code, 403)

    def test_크기_목록은_설치값_관리자값_사람별_값과_PVC_실제_크기(self):
        self.kim()
        FakeAPI.agents["hag-kim"]["spec"]["resources"] = {"limits": {"memory": "8Gi"}}
        FakeAPI.configmaps["aas-capacity"] = cap_doc()
        FakeAPI.pvcs = [{"metadata": {"name": "data-hag-kim-0"}, "status": {"capacity": {"storage": "5Gi"}}}]
        self.size("*", cpu_request="1")
        self.size("kim@x.com", storage="20Gi")
        self.reg.refresh(ttl=0)
        out = server._agents_sizes(self.reg, self.admin, True)
        self.assertEqual((out["install"]["memory_request"], out["admin"]["cpu_request"], out["admin"]["storage"], out["people"]["kim@x.com"]["storage"]),
                         ("1280Mi", "1", None, "20Gi"))
        self.assertEqual((out["agents"]["hag-kim"]["size"]["memory_limit"], out["agents"]["hag-kim"]["pvc"], out["agents"]["hag-lee"]["pvc"]), ("8Gi", "5Gi", None))

    def test_노드_자리_기다림과_크기를_view_에_싣는다(self):
        item = agent("hag-w", "w@x.com", "Provisioning", waitReason="Unschedulable", message="노드 자리가 없어 기다립니다")
        item["spec"]["storage"] = {"size": "10Gi"}
        v = agents.view(item)
        self.assertEqual((v["wait_reason"], v["size"]["storage"], v["size"]["cpu_request"]), ("Unschedulable", "10Gi", None))
        self.assertEqual(agents.view(agent("hag-r", "w@x.com"))["wait_reason"], "")

    def test_크기_롤아웃은_이미지_목표를_바꾸지_않고_그만두기만_되고_되돌리기는_없다(self):
        from aas.fleet import rollouts
        done = rollout("r0", "Done", st_completionTime="2026-10-29T01:00:00Z", st_defaultImage=H2)
        resize = {"metadata": {"name": "r1", "creationTimestamp": "2026-10-30T00:00:00Z"}, "spec": {"kind": "resize", "versionName": "기본 크기", "resize": {"targets": []}},
                  "status": {"phase": "Paused", "agents": [{"name": "hag-a", "state": "done"}]}}
        self.assertEqual(rollouts.target([done, resize])["image"], H2)                         # 크기 롤아웃에는 이미지가 없다
        self.assertEqual(rollouts.summary([done, resize], [])["rollout"]["kind"], "resize")
        FakeAPI.rollouts = {"r1": resize}
        self.reg.refresh(ttl=0)
        with self.assertRaises(agents.AgentError) as cm:
            self.write("/api/agents/rollout/action", {"name": "r1", "action": "rollback"})
        self.assertEqual(cm.exception.code, 409)
        self.write("/api/agents/rollout/action", {"name": "r1", "action": "abort"})
        self.assertTrue(FakeAPI.rollouts["r1"]["spec"]["abort"])


class SizeRouteTest(K8sBase):
    """T10: 새 경로가 실제 서버(uvicorn 앱)에서 404 가 아니다 — POST 허용 목록(F13)과 GET 경로."""

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        import sys
        sys.path.insert(0, str(Path(__file__).resolve().parent))
        import aasserver
        cls.old_server = (server._auth, server._registry)
        server._registry = pods.Registry(Path(TMP.name) / "없는-등록부.json")
        server._registry.is_admin = lambda u: True

        class On:
            enabled = True

            def user(self, cookie):
                return {"email": "admin@x.com", "name": ""}
        server._auth = On()
        cls.app = aasserver.start()

    @classmethod
    def tearDownClass(cls):
        cls.app.shutdown()
        server._auth, server._registry = cls.old_server
        super().tearDownClass()

    def setUp(self):
        super().setUp()
        FakeAPI.agents = {"hag-a": agent("hag-a", "a@x.com")}
        server._registry.refresh(ttl=0)
        agents.forget_capacity()
        from aas.common import store
        with store.connect() as conn:
            conn.execute(agents.SIZE_SCHEMA)
            conn.execute("DELETE FROM agent_sizes")
        self.addCleanup(self.cleanup)

    def cleanup(self):
        from aas.common import store
        with store.connect() as conn:
            conn.execute("DELETE FROM agent_sizes")

    def req(self, method, path, body=None):
        import http.client
        c = http.client.HTTPConnection("127.0.0.1", self.app.server_port, timeout=10)
        c.request(method, path, body=json.dumps(body) if body is not None else None, headers={"Content-Type": "application/json", "X-AAS": "1"})
        r = c.getresponse()
        data = json.loads(r.read() or b"{}")
        c.close()
        return r.status, data

    def test_T10_새_경로가_막히지_않는다(self):
        self.assertEqual(self.req("POST", "/api/agents/size", {"email": "*", "cpu_request": "1"})[0], 200)
        code, out = self.req("POST", "/api/agents/size/apply", {})
        self.assertEqual((code, len(FakeAPI.rollouts)), (201, 1))                              # hag-a 가 관리자 기본값과 다르다
        self.assertEqual(self.req("GET", "/api/agents/capacity")[0], 200)
        self.assertEqual(self.req("GET", "/api/agents/sizes")[1]["admin"]["cpu_request"], "1")
        code, out = self.req("POST", "/api/agents/size", {"email": "*", "cpu_request": "1", "cpu_limit": "0.5"})
        self.assertEqual((code, out.get("field")), (400, "cpu_request"))                       # 칸 오류는 field 로


if __name__ == "__main__":
    unittest.main()

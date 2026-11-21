# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""화면 지연의 원인을 가르는 로그(스펙 2026-11-20-001 1단계).

A7: 사이드카 묶음 잠금을 오래 기다렸거나 묶음 받기가 오래 걸리면 에이전트·까닭·스레드를 한 줄 남긴다.
A9: 요청이 캐시 값을 기다려 만들며 오래 멈췄으면 키·기다림·만들기 시간을 한 줄 남긴다.
같은 에이전트·키는 60초에 한 줄만 남긴다.
2단계: 받은편지함 「MCP 로그인 필요」를 다시 만들 때 연달아 읽어도 묶음을 받으러 가지 않는다(OKE 에서 11초 멈춤)."""
import contextlib
import io
import json
import os
import sys
import tempfile
import threading
import time
import unittest
import unittest.mock
from pathlib import Path
from types import SimpleNamespace

TMP = tempfile.TemporaryDirectory()
os.environ.setdefault("AAS_DATA_DIR", str(Path(TMP.name) / "data"))
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "sidecar"))

from aas_sidecar import ops as sc_ops, server as sc_server  # noqa: E402

from aas.hermes.readers import remote  # noqa: E402
from aas.ops import mcp_oauth_relay as relay  # noqa: E402
from aas.web import server  # noqa: E402

TOKEN = "slow-wait-token-0123456789abcdef"
PROFILES = 15


class SlowFetch(remote.RemoteBackend):
    """사이드카 없이 묶음 받기만 흉내 낸다. gate 가 풀릴 때까지 받기가 멈춘다."""

    def __init__(self):
        super().__init__("http://127.0.0.1:9", "t", label="agent-x")
        self.entered = threading.Event()
        self.gate = threading.Event()
        self.fetches = 0

    def _fetch_locked(self, base, deadline=None):           # 진짜 _fetch_locked 처럼 잠금 안 마감을 받는다
        self.fetches += 1
        self.entered.set()
        self.gate.wait(5)
        self._tree = remote._Tree([], [], {}, time.monotonic())
        return True, None


def capture():
    out = io.StringIO()
    return out, contextlib.redirect_stdout(out)


class TreeLockWaitLogTest(unittest.TestCase):
    def test_waiting_request_and_slow_fetch_are_logged_once(self):
        b = SlowFetch()
        out, redirect = capture()
        with redirect, unittest.mock.patch.object(remote, "SLOW_LOG", 0.05):
            first = threading.Thread(target=b.snapshot, name="req-1")
            first.start()
            self.assertTrue(b.entered.wait(2))
            second = threading.Thread(target=b.snapshot, name="req-2")
            second.start()
            time.sleep(0.3)                                  # 둘째 요청이 잠금 앞에서 기다린다
            b.gate.set()
            first.join(5)
            second.join(5)
        lines = out.getvalue().splitlines()
        fetch = [ln for ln in lines if ln.startswith("묶음 받기 느림 agent-x")]
        wait = [ln for ln in lines if ln.startswith("묶음 잠금 대기 agent-x")]
        self.assertEqual(len(fetch), 1, lines)
        self.assertIn("까닭=처음", fetch[0])
        self.assertIn("스레드=req-1", fetch[0])
        self.assertEqual(len(wait), 1, lines)
        self.assertIn("앞 받기=처음", wait[0])
        self.assertIn("스레드=req-2", wait[0])
        self.assertEqual(b.fetches, 1)                       # 둘째는 앞 요청이 받은 묶음을 쓴다

        # 60초 안의 다음 느린 받기는 로그를 남기지 않는다
        b._tree = None
        b.gate.set()
        out2, redirect2 = capture()
        with redirect2, unittest.mock.patch.object(remote, "SLOW_LOG", -1.0):
            b.snapshot()
        self.assertEqual(out2.getvalue(), "")

    def test_reason_tells_first_fetch_from_after_edit_and_expiry(self):
        b = SlowFetch()
        b.gate.set()
        b.snapshot()
        self.assertTrue(b._fetch_note.startswith("처음 "))
        b.invalidate()                                       # AAS 가 고쳤다 — 묶음이 견줄 기준으로 남는다
        b.snapshot()
        self.assertTrue(b._fetch_note.startswith("고친뒤 "))
        b._tree.taken -= remote.TREE_TTL + 1                 # 60초가 지났다
        b.snapshot()
        self.assertTrue(b._fetch_note.startswith("만료 "))

    def test_fast_fetch_logs_nothing(self):
        b = SlowFetch()
        b.gate.set()
        out, redirect = capture()
        with redirect:
            self.assertTrue(b.snapshot())
        self.assertEqual(out.getvalue(), "")


class SlowCacheBuildLogTest(unittest.TestCase):
    def setUp(self):
        for key in ("t:slowbuild", "t:fastbuild"):
            server._cache.pop(key, None)
            server._slow_built.pop(key, None)

    def test_slow_build_on_request_thread_is_logged_once_a_minute(self):
        def slow():
            time.sleep(0.2)
            return "v"
        out, redirect = capture()
        with redirect, unittest.mock.patch.object(server, "SLOW_BUILD", 0.05):
            self.assertEqual(server._cached("t:slowbuild", 60, slow, per_lang=False, stale_ok=False), "v")
            server._cache.pop("t:slowbuild")
            server._cached("t:slowbuild", 60, slow, per_lang=False, stale_ok=False)
        lines = [ln for ln in out.getvalue().splitlines() if ln.startswith("캐시 만들기 느림 t:slowbuild ")]
        self.assertEqual(len(lines), 1, out.getvalue())
        self.assertIn("만들기 0.", lines[0])
        self.assertIn(f"스레드={threading.current_thread().name}", lines[0])

    def test_request_waiting_for_another_builder_counts_the_wait(self):
        started = threading.Event()

        def slow():
            started.set()
            time.sleep(0.3)
            return "v"
        out, redirect = capture()
        with redirect, unittest.mock.patch.object(server, "SLOW_BUILD", 0.05), \
                unittest.mock.patch.object(server, "SLOW_BUILD_EVERY", 0.0):
            builder = threading.Thread(target=server._cached, args=("t:slowbuild", 60, slow),
                                       kwargs={"per_lang": False, "stale_ok": False})
            builder.start()
            self.assertTrue(started.wait(2))
            self.assertEqual(server._cached("t:slowbuild", 60, lambda: "other", per_lang=False, stale_ok=False), "v")
            builder.join(5)
        lines = [ln for ln in out.getvalue().splitlines() if ln.startswith("캐시 만들기 느림 t:slowbuild ")]
        self.assertTrue(any("· 만들기 0.0)" in ln for ln in lines), lines)   # 기다리기만 한 요청

    def test_fast_build_logs_nothing(self):
        out, redirect = capture()
        with redirect:
            server._cached("t:fastbuild", 60, lambda: "v", per_lang=False, stale_ok=False)
        self.assertEqual(out.getvalue(), "")


class Counting(remote.RemoteBackend):
    def __init__(self, *a, **kw):
        super().__init__(*a, **kw)
        self.calls = []

    def _call(self, method, path, body=None, timeout=None):
        self.calls.append(path)
        return super()._call(method, path, body, timeout)


def login_home(root: Path, with_status: bool = True) -> Path:
    """게이트웨이 상태 파일과 OAuth MCP 서버를 둔 프로파일 여러 개 — 읽기가 연달아 묻기 기준(40번)을 넘는다."""
    home = root / "home"
    (home / "profiles").mkdir(parents=True)
    (home / "gateway_state.json").write_text(json.dumps({"pid": 7, "start_time": 1.0}))
    if with_status:
        (home / relay.STATUS_FILE).write_text(json.dumps({"pid": 7, "start_time": 1.0, "servers": {}}))
    for i in range(PROFILES):
        prof = home / "profiles" / f"p{i:02d}"
        (prof / "mcp-tokens").mkdir(parents=True)
        (prof / "config.yaml").write_text("mcp_servers:\n  jira:\n    url: https://mcp.example.com/mcp\n    auth: oauth\n")
        if i % 2:
            (prof / "mcp-tokens" / "jira.json").write_text("{}")
    return home


class LoginInboxNoBundleTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.home = login_home(Path(self.tmp.name))
        self.httpd = sc_server.make_server("127.0.0.1", 0, sc_ops.Ops(self.home), TOKEN)
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()
        self.url = f"http://127.0.0.1:{self.httpd.server_port}"

    def tearDown(self):
        self.httpd.shutdown()
        self.httpd.server_close()
        self.tmp.cleanup()

    def pod(self):
        b = Counting(self.url, TOKEN, label="login-x")
        return SimpleNamespace(id="login-x", hermes_home=remote.RemotePath(b, "")), b

    def test_plain_reads_would_fetch_the_bundle(self):
        """전제: 같은 읽기를 그냥 하면 연달아 묻기가 되어 묶음을 받는다 — OKE 에서 이 받기가 11초 걸렸다."""
        pod, b = self.pod()
        relay.login_items(pod.id, pod.hermes_home,
                          lambda: [(p.name, p.path) for p in server.cron_health.hr.profiles(pod.hermes_home)], lambda *_: None)
        self.assertTrue({"/v1/tree", "/v1/changes"} & set(b.calls), b.calls)

    def test_inbox_login_items_do_not_fetch_the_bundle_and_give_the_same_items(self):
        pod, b = self.pod()
        items = server._mcp_login_items(pod, {})
        self.assertFalse({"/v1/tree", "/v1/changes"} & set(b.calls), b.calls)
        self.assertEqual(len(items), (PROFILES + 1) // 2)              # 토큰이 없는 프로파일만 로그인 필요
        pod2, b2 = self.pod()
        self.assertTrue(b2.snapshot())                                  # 신선한 묶음이 있으면 그것으로 답한다
        before = len(b2.calls)
        self.assertEqual(sorted(i["id"] for i in server._mcp_login_items(pod2, {})), sorted(i["id"] for i in items))
        self.assertNotIn("/v1/tree", b2.calls[before:])
        self.assertLess(len(b2.calls) - before, len(b.calls))

    def test_no_bundle_ends_with_the_context(self):
        pod, b = self.pod()
        with remote.no_bundle():
            self.assertTrue(remote._NO_BUNDLE.get())
        self.assertFalse(remote._NO_BUNDLE.get())

    def test_old_image_without_status_file_does_not_walk_profiles(self):
        (self.home / relay.STATUS_FILE).unlink()
        walked = []
        self.assertEqual(relay.login_items("x", self.home, lambda: walked.append(1) or [], lambda *_: None), [])
        self.assertEqual(walked, [])


class StepTimerTest(unittest.TestCase):
    """받은편지함 단계별 시간(스펙 2026-11-20-001 §3-5): 합이 2초를 넘으면 오래 걸린 단계부터, 가장 느린 작업공간과 함께 한 줄."""

    def test_slow_request_lists_steps_by_time_with_slowest_pod(self):
        clock = iter([0.0, 0.01, 0.31, 2.31, 2.5]).__next__
        with unittest.mock.patch.object(server.time, "monotonic", clock), unittest.mock.patch.object(server, "SLOW_BUILD", 2.0):
            steps = server._Steps("받은편지함")
            steps.mark("pending")                                       # 0.01
            steps.mark("cards")                                         # 0.30
            steps.pod("routes", "pod-a", 0.4)
            steps.pod("routes", "pod-b", 1.2)
            steps.pod("routes", "pod-c", 0.3)
            steps.mark("routes")                                        # 2.00
            out, redirect = capture()
            with redirect:
                steps.report()                                          # 합 2.5초
        self.assertEqual(out.getvalue().strip(), "받은편지함 느림 2.5초 routes=2.0(최대 pod-b 1.2) cards=0.3")

    def test_fast_request_logs_nothing(self):
        steps = server._Steps("받은편지함")
        steps.mark("pending")
        out, redirect = capture()
        with redirect:
            steps.report()
        self.assertEqual(out.getvalue(), "")



class RoutesInBackgroundTest(unittest.TestCase):
    """관리자 받은편지함의 「허용되지 않은 LLM 경로」(스펙 2026-11-20-001 3단계): 지난 값으로 바로 답하고 뒤에서 다시 읽는다.
    OKE 에서 이 단계가 요청 스레드에서 1.9~2.9초, 만료 묶음 받기가 섞이면 13~27초 걸렸다(§3-5)."""

    def setUp(self):
        server._route_cache.clear()
        server._route_refreshing.clear()
        self.reg = SimpleNamespace(pods=[SimpleNamespace(id="rt-a", hermes_home="a"), SimpleNamespace(id="rt-b", hermes_home="b")])
        self.gate = threading.Event()
        self.seen = []

        def read(home=None):
            self.seen.append((home, remote._NO_BUNDLE.get(), threading.current_thread().name))
            self.gate.wait(5)
            return [{"profile": "p", "model": f"new-{home}"}]
        patcher = unittest.mock.patch.object(server.models, "blocked_routes", read)
        patcher.start()
        self.addCleanup(patcher.stop)

    def tearDown(self):
        self.gate.set()
        for t in threading.enumerate():
            if t.name == "aas-route-refresh":
                t.join(5)
        server._route_cache.clear()

    def test_expired_value_is_answered_at_once_and_read_again_behind(self):
        old = time.time() - server._ROUTE_TTL - 1
        for pod in self.reg.pods:
            server._route_cache[pod.id] = (old, [{"profile": "p", "model": "old"}])
        began = time.monotonic()
        out = server._blocked_routes_by_pod(self.reg)
        self.assertLess(time.monotonic() - began, 1.0)                  # 다시 읽기를 기다리지 않는다
        self.assertEqual({k: v[0]["model"] for k, v in out.items()}, {"rt-a": "old", "rt-b": "old"})
        server._blocked_routes_by_pod(self.reg)                         # 다시 읽는 중이면 또 띄우지 않는다
        self.gate.set()
        for t in threading.enumerate():
            if t.name == "aas-route-refresh":
                t.join(5)
        self.assertEqual(sorted(h for h, _, _ in self.seen), ["a", "b"])
        self.assertTrue(all(nb and name == "aas-route-refresh" for _, nb, name in self.seen), self.seen)
        out = server._blocked_routes_by_pod(self.reg)
        self.assertEqual({k: v[0]["model"] for k, v in out.items()}, {"rt-a": "new-a", "rt-b": "new-b"})

    def test_first_read_and_too_old_value_wait_but_do_not_fetch_the_bundle(self):
        server._route_cache["rt-a"] = (time.time() - max(server._ROUTE_TTL * server.STALE_FACTOR, server.STALE_MIN) - 1, [])
        self.gate.set()
        out = server._blocked_routes_by_pod(self.reg)
        self.assertEqual({k: v[0]["model"] for k, v in out.items()}, {"rt-a": "new-a", "rt-b": "new-b"})
        self.assertTrue(all(nb for _, nb, _ in self.seen), self.seen)   # 요청 스레드에서 읽어도 묶음을 받지 않는다

    def test_failed_read_behind_keeps_the_old_value(self):
        server._route_cache["rt-a"] = (time.time() - server._ROUTE_TTL - 1, [{"profile": "p", "model": "old"}])
        self.reg.pods = self.reg.pods[:1]

        def broken(home=None):
            raise OSError("sidecar")
        out = io.StringIO()
        with unittest.mock.patch.object(server.models, "blocked_routes", broken), contextlib.redirect_stdout(out):
            server._blocked_routes_by_pod(self.reg)
            for t in threading.enumerate():
                if t.name == "aas-route-refresh":
                    t.join(5)
        self.assertEqual(server._route_cache["rt-a"][1][0]["model"], "old")
        self.assertNotIn("rt-a", server._route_refreshing)


class LoginInboxStaleTest(unittest.TestCase):
    """받은편지함 「MCP 로그인 필요」(3단계): 만료되면 지난 값으로 답하고 뒤에서 다시 만든다. 로그인하면 캐시를 버려 바로 사라진다(V14)."""
    POD = "lis-x"

    def setUp(self):
        self.pod = SimpleNamespace(id=self.POD, hermes_home="h")
        self.key = f"{self.POD}:mcplogin_inbox"
        self.gate = threading.Event()
        self.value = [{"id": "new"}]

        def build(pod, by_pod):
            self.gate.wait(5)
            return list(self.value)
        patcher = unittest.mock.patch.object(server, "_mcp_login_items", build)
        patcher.start()
        self.addCleanup(patcher.stop)

    def tearDown(self):
        self.gate.set()
        for t in threading.enumerate():
            if t.name == "aas-cache-refresh":
                t.join(5)
        with server._lock:
            server._cache.pop(self.key, None)

    def test_expired_items_answer_at_once_and_login_drops_them(self):
        with server._lock:
            server._cache[self.key] = (time.time() - 31, [{"id": "old"}])
        began = time.monotonic()
        self.assertEqual(server._mcp_login_inbox(self.pod, {}), [{"id": "old"}])
        self.assertLess(time.monotonic() - began, 1.0)
        self.gate.set()
        for t in threading.enumerate():
            if t.name == "aas-cache-refresh":
                t.join(5)
        self.assertEqual(server._mcp_login_inbox(self.pod, {}), [{"id": "new"}])
        self.value = []                                                 # 로그인했다
        with unittest.mock.patch.object(server.topics, "invalidate"), unittest.mock.patch.object(server.cache_epoch, "bump"):
            server._forget_mcp_login(self.POD, "p")
        self.assertEqual(server._mcp_login_inbox(self.pod, {}), [])     # 지난 값이 아니라 곧바로 새 값


if __name__ == "__main__":
    unittest.main()

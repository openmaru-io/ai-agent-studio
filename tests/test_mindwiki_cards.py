# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""MindWiki 가 자동화 카드의 상태를 묻는 끝점 /api/mindwiki/cards(스펙 2026-11-22-008 A2)와 카드를 멈추는 끝점
/api/mindwiki/cards/cancel · 묻기 때 막힌 줄 풀기(스펙 2026-11-24-003 C1 · C2).
서명(delivery 0 만), 몸 검사, 다른 설치, Hermes 상태 → 위키 상태, 카드 없음 → gone, 느린·다시 뜨는 파드 → unknown 을 본다. Hermes 는 가짜다
(실제 보드 꼴 columns: [{name, tasks}], 2026-11-22-008 §4)."""
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

from aas.common import store  # noqa: E402
from aas.hermes.hermes_api import HermesError  # noqa: E402
from aas.ops import mindwiki_webhook as mw  # noqa: E402
from aas.web import mindwiki_webhook as route  # noqa: E402

SECRET = "c" * 32
INSTALL = "inst-cards"


def _clear():
    with store.connect() as conn:
        conn.executescript(mw.SCHEMA)
        conn.execute("DELETE FROM mindwiki_webhook_ledger WHERE install IN (?, ?)", (INSTALL, "inst-other"))


def _ledger(delivery, author, card, install=INSTALL, status="done"):
    with store.connect() as conn:
        conn.executescript(mw.SCHEMA)
        conn.execute("INSERT INTO mindwiki_webhook_ledger (install, delivery, author, day, status, card_id, created, tried) VALUES (?,?,?,?,?,?,?,?)",
                     (install, delivery, author, "2026-11-22", status, card, time.time(), time.time()))


def _post(body: bytes, delivery="0", secret=SECRET, install=INSTALL, path=None):
    path = path or route.CARDS_PATH
    t = int(time.time())
    mac = hmac.new(secret.encode(), f"{t}.{install}.{delivery}.".encode() + body, hashlib.sha256).hexdigest()
    headers = {"x-mindwiki-installation": install, "x-mindwiki-delivery": delivery, "x-mindwiki-signature": f"t={t},sha256={mac}"}
    scope = {"type": "http", "method": "POST", "path": path, "query_string": b"", "scheme": "https",
             "headers": [(k.encode(), v.encode()) for k, v in headers.items()], "server": ("aas", 443), "client": ("10.0.0.1", 1), "root_path": ""}
    parts = [body]

    async def receive():
        if not parts:
            return {"type": "http.disconnect"}
        return {"type": "http.request", "body": parts.pop(0), "more_body": False}

    handler = route.cancel if path == route.CANCEL_PATH else route.cards
    resp = anyio.run(handler, Request(scope, receive))
    return resp.status_code, json.loads(resp.body)


def _body(*ids):
    return json.dumps({"deliveries": list(ids)}).encode()


class Pod(SimpleNamespace):
    def owned_by(self, user):
        return bool(user.get("sub")) and user.get("sub") == self.owner_sub


BOARDS: dict = {}       # 파드 id → {상태: [카드 id]}
SLOW: set = set()
LINKS: dict = {}        # 뒤 카드 → 선행 카드들
PATCH_FAIL: dict = {}   # 카드 → PATCH 에서 낼 HermesError
DELETE_FAIL: dict = {}  # (선행, 뒤) → 이음 DELETE 에서 낼 HermesError
PATCH_SLOW: set = set()  # PATCH 가 마감보다 오래 걸리는 카드


def _move(pod, card, status):
    cols = BOARDS[pod]
    for ids in cols.values():
        if card in ids:
            ids.remove(card)
    cols.setdefault(status, []).append(card)


class FakeAPI:
    queries: list = []
    calls: list = []    # (파드, 방법, 경로, 몸, 질의) — 보드 읽기 밖의 호출

    def __init__(self, auth):
        self.pod = auth

    def call(self, method, path, body=None, query=None, timeout=30):
        if (method, path) == ("GET", "/api/plugins/kanban/board"):
            FakeAPI.queries.append(query)
            if self.pod in SLOW:
                time.sleep(1.5)
            cols = BOARDS[self.pod]
            return {"columns": [{"name": k, "tasks": [{"id": i, "assignee": "mwauto-main", "link_counts": {"parents": len(LINKS.get(i, [])), "children": 0}}
                                                      for i in v]} for k, v in cols.items()]}
        FakeAPI.calls.append((self.pod, method, path, body, query))
        card = path.rsplit("/", 1)[1]
        if method == "PATCH" and path.startswith("/api/plugins/kanban/tasks/"):
            if card in PATCH_SLOW:
                time.sleep(1.5)
            if card in PATCH_FAIL:
                raise PATCH_FAIL[card]
            _move(self.pod, card, body["status"])
            return {"task": {"id": card}}
        if method == "GET" and path.startswith("/api/plugins/kanban/tasks/"):
            return {"links": {"parents": list(LINKS.get(card, [])), "children": []}}
        if (method, path) == ("DELETE", "/api/plugins/kanban/links"):
            key = (query["parent_id"], query["child_id"])
            if key in DELETE_FAIL:
                raise DELETE_FAIL[key]
            LINKS[query["child_id"]] = [x for x in LINKS.get(query["child_id"], []) if x != query["parent_id"]]
            return {"ok": True}
        raise AssertionError(f"부르지 않아야 할 호출: {method} {path}")


class _FakeHermesTest(unittest.TestCase):
    def setUp(self):
        for p in (mock.patch.dict(os.environ, {"AAS_MINDWIKI_WEBHOOK_SECRET": SECRET}),
                  mock.patch.object(route, "HermesAPI", FakeAPI),
                  mock.patch.object(route.server, "hub", lambda pod: SimpleNamespace(auth=pod.id)),
                  mock.patch.object(route, "CARDS_DEADLINE", 1.0)):
            p.start()
            self.addCleanup(p.stop)
        _clear()
        self.addCleanup(_clear)
        for d in (BOARDS, LINKS, PATCH_FAIL, DELETE_FAIL):
            d.clear()
        SLOW.clear()
        PATCH_SLOW.clear()
        FakeAPI.queries = []
        FakeAPI.calls = []
        self.reg = SimpleNamespace(pods=[Pod(id="pod-a", owner_sub="alice"), Pod(id="pod-b", owner_sub="bob")], restarting=[])
        p = mock.patch.object(route.server, "registry", lambda: self.reg)
        p.start()
        self.addCleanup(p.stop)


class CardsTest(_FakeHermesTest):
    def test_Hermes_상태를_위키_상태로_바꾼다(self):
        BOARDS["pod-a"] = {"todo": ["t1"], "ready": ["t2"], "running": ["t3"], "done": ["t4"], "archived": ["t5"], "blocked": ["t6"], "review": ["t7"],
                           "triage": ["t8"]}
        want = {"1": "waiting", "2": "waiting", "3": "running", "4": "done", "5": "done", "6": "blocked", "7": "review", "8": "waiting"}
        for i in range(1, 9):
            _ledger(str(i), "alice", f"t{i}")
        status, body = _post(_body(*want))
        self.assertEqual(status, 200)
        self.assertEqual({d: v["state"] for d, v in body["cards"].items()}, want)
        self.assertEqual(FakeAPI.queries, [{"board": "mindwiki", "include_archived": "true"}])   # 파드마다 보드 한 번, 치운 카드까지

    def test_카드가_어느_보드에도_없으면_gone_원장에_없으면_unknown(self):
        BOARDS["pod-a"] = {"running": []}
        _ledger("10", "alice", "t_lost")
        _ledger("11", "nobody", "t_x")                                     # 작성자의 파드가 없다
        _ledger("12", "alice", "", status="pending")                       # 카드를 아직 못 만든 줄
        _ledger("13", "alice", "t_other", install="inst-other")            # 다른 설치
        status, body = _post(_body("10", "11", "12", "13", "14"))
        self.assertEqual(status, 200)
        self.assertEqual({d: v["state"] for d, v in body["cards"].items()},
                         {"10": "gone", "11": "gone", "12": "unknown", "13": "unknown", "14": "unknown"})

    def test_느린_파드와_다시_뜨는_파드는_unknown(self):
        BOARDS["pod-a"] = {"running": []}
        BOARDS["pod-b"] = {"running": ["t_b"]}
        SLOW.add("pod-a")
        _ledger("20", "alice", "t_a")
        _ledger("21", "bob", "t_b")
        status, body = _post(_body("20", "21"))
        self.assertEqual((body["cards"]["20"]["state"], body["cards"]["21"]["state"]), ("unknown", "running"))
        SLOW.clear()
        self.reg.restarting = [Pod(id="pod-a2", owner_sub="alice")]
        status, body = _post(_body("20"))
        self.assertEqual(body["cards"]["20"]["state"], "unknown")          # 카드가 다시 뜨는 파드에 있을 수 있다

    def test_서명과_몸을_검사한다(self):
        self.assertEqual(_post(_body("1"), secret="x" * 32)[0], 401)
        status, body = _post(_body("1"), delivery="7")                    # 웹훅 서명 자리는 받지 않는다
        self.assertEqual((status, body["reason"]), (400, "invalid"))
        for bad in (b"{", b"[]", json.dumps({"deliveries": "1"}).encode(), json.dumps({"deliveries": [1]}).encode(),
                    json.dumps({"deliveries": ["x"]}).encode(), _body(*[str(i) for i in range(101)])):
            self.assertEqual(_post(bad)[0], 400, bad[:40])
        with mock.patch.dict(os.environ, {"AAS_MINDWIKI_WEBHOOK_SECRET": ""}):
            self.assertEqual(_post(_body("1"))[0], 503)


def _states(body):
    return {d: v["state"] for d, v in body["cards"].items()}


class CancelTest(_FakeHermesTest):
    """POST /api/mindwiki/cards/cancel(스펙 2026-11-24-003 C1)."""

    def _cancel(self, *ids, **kw):
        return _post(_body(*ids), path=route.CANCEL_PATH, **kw)

    def test_서명과_delivery_0_을_검사한다(self):
        self.assertEqual(self._cancel("1", secret="x" * 32)[0], 401)
        status, body = self._cancel("1", delivery="7")
        self.assertEqual((status, body["reason"]), (400, "invalid"))
        self.assertEqual(_post(b"{", path=route.CANCEL_PATH)[0], 400)
        self.assertEqual(FakeAPI.calls, [])

    def test_도는_카드는_보관하고_끝난_카드는_done(self):
        BOARDS["pod-a"] = {"running": ["t1"], "todo": ["t2"], "blocked": ["t3"], "done": ["t4"], "archived": ["t5"]}
        for i in range(1, 6):
            _ledger(str(i), "alice", f"t{i}")
        with mock.patch.object(route, "_log") as log:
            status, body = self._cancel("1", "2", "3", "4", "5")
        self.assertEqual(status, 200)
        self.assertEqual(_states(body), {"1": "cancelled", "2": "cancelled", "3": "cancelled", "4": "done", "5": "done"})
        patched = sorted((c[2], c[3], c[4]) for c in FakeAPI.calls)
        self.assertEqual(patched, [(f"/api/plugins/kanban/tasks/t{i}", {"status": "archived"}, {"board": "mindwiki"}) for i in (1, 2, 3)])
        self.assertEqual(set(BOARDS["pod-a"]["archived"]), {"t1", "t2", "t3", "t5"})
        logged = {c.kwargs["delivery"]: (c.kwargs["card"], c.kwargs["pod"], c.kwargs["result"]) for c in log.call_args_list
                  if c.args == ("mindwiki_auto_cancelled",)}
        self.assertEqual(logged["1"], ("t1", "pod-a", "cancelled"))
        self.assertEqual(logged["4"], ("t4", "pod-a", "done"))

    def test_원장에_없거나_다른_설치_카드_없음은_gone(self):
        BOARDS["pod-a"] = {"running": ["t_run"]}
        _ledger("10", "alice", "t_lost")                                   # 파드가 모두 답했는데 카드가 없다
        _ledger("11", "nobody", "t_x")                                     # 작성자의 파드가 없다
        _ledger("12", "alice", "")                                         # 끝났는데 카드 id 가 없는 줄
        _ledger("13", "alice", "t_run", install="inst-other")              # 다른 설치
        status, body = self._cancel("10", "11", "12", "13", "14")
        self.assertEqual(_states(body), {"10": "gone", "11": "gone", "12": "gone", "13": "gone", "14": "gone"})
        self.assertEqual(FakeAPI.calls, [])                                # 다른 설치의 카드를 멈추지 않는다
        self.assertEqual(BOARDS["pod-a"]["running"], ["t_run"])

    def test_카드를_아직_만드는_중인_배달은_unknown(self):
        BOARDS["pod-a"] = {"running": []}
        _ledger("30", "alice", "", status="pending")                       # 웹훅이 카드를 만드는 중 — gone 이면 위키가 다시 보내지 않는다
        _ledger("31", "alice", "t_x", install="inst-other", status="pending")   # 다른 설치의 pending 은 gone
        self.assertEqual(_states(self._cancel("30", "31")[1]), {"30": "unknown", "31": "gone"})
        self.assertEqual(FakeAPI.calls, [])

    def test_답하지_않은_파드와_다시_뜨는_파드는_unknown(self):
        BOARDS["pod-a"] = {"running": []}
        SLOW.add("pod-a")
        _ledger("20", "alice", "t_a")
        self.assertEqual(_states(self._cancel("20")[1]), {"20": "unknown"})
        SLOW.clear()
        self.reg.restarting = [Pod(id="pod-a2", owner_sub="alice")]
        self.assertEqual(_states(self._cancel("20")[1]), {"20": "unknown"})

    def test_PATCH_409_는_done_그_밖의_실패는_unknown(self):
        BOARDS["pod-a"] = {"running": ["t1", "t2"]}
        PATCH_FAIL["t1"] = HermesError("already archived", 409)
        PATCH_FAIL["t2"] = HermesError("Hermes rejected the request (HTTP 500)", 502)
        _ledger("1", "alice", "t1")
        _ledger("2", "alice", "t2")
        self.assertEqual(_states(self._cancel("1", "2")[1]), {"1": "done", "2": "unknown"})

    def test_마감을_넘긴_보관은_unknown(self):
        BOARDS["pod-a"] = {"running": ["t1"]}
        PATCH_SLOW.add("t1")
        _ledger("1", "alice", "t1")
        started = time.monotonic()
        self.assertEqual(_states(self._cancel("1")[1]), {"1": "unknown"})
        self.assertLess(time.monotonic() - started, 1.4)                   # 마감(시험 1초) 안에 답한다

    def test_reclaim_을_부르지_않는다(self):
        BOARDS["pod-a"] = {"running": ["t1"], "ready": ["t2"], "review": ["t3"]}
        for i in range(1, 4):
            _ledger(str(i), "alice", f"t{i}")
        self._cancel("1", "2", "3")
        self.assertTrue(FakeAPI.calls)
        for _, method, path, body, _ in FakeAPI.calls:
            self.assertNotIn("reclaim", path)
            self.assertEqual((method, body), ("PATCH", {"status": "archived"}))


class UnstickTest(_FakeHermesTest):
    """/cards 가 묻는 때 선행 카드가 모두 막힌 todo 카드를 푼다(스펙 2026-11-24-003 C2)."""

    def setUp(self):
        super().setUp()
        p = mock.patch.object(route, "CARDS_DEADLINE", 8.0)
        p.start()
        self.addCleanup(p.stop)

    def _ready_calls(self):
        return [c[2].rsplit("/", 1)[1] for c in FakeAPI.calls if c[1] == "PATCH" and c[3] == {"status": "ready"}]

    def test_선행_카드가_모두_막혔으면_이음을_지우고_ready(self):
        BOARDS["pod-a"] = {"blocked": ["t_bad"], "review": ["t_rev"], "todo": ["t_wait"]}
        LINKS["t_wait"] = ["t_bad", "t_rev"]
        _ledger("1", "alice", "t_wait")
        with mock.patch.object(route, "_log") as log:
            status, body = _post(_body("1"))
        self.assertEqual(_states(body), {"1": "waiting"})                 # 이번 답은 그대로
        self.assertEqual(LINKS["t_wait"], [])
        self.assertEqual(self._ready_calls(), ["t_wait"])
        self.assertIn("t_wait", BOARDS["pod-a"]["ready"])
        self.assertTrue(any(c.args == ("mindwiki_auto_queue_unstuck",) and c.kwargs["task"] == "t_wait" for c in log.call_args_list))
        self.assertEqual(_states(_post(_body("1"))[1]), {"1": "waiting"})  # ready 도 waiting(Hermes 가 가져가면 running)

    def test_선행_카드_하나라도_돌면_그대로(self):
        BOARDS["pod-a"] = {"blocked": ["t_bad"], "running": ["t_run"], "todo": ["t_wait"]}
        LINKS["t_wait"] = ["t_bad", "t_run"]
        _ledger("1", "alice", "t_wait")
        _post(_body("1"))
        self.assertEqual(self._ready_calls(), [])
        self.assertFalse(any(c[1] == "DELETE" for c in FakeAPI.calls))
        self.assertEqual(LINKS["t_wait"], ["t_bad", "t_run"])

    def test_남은_시간이_2초보다_적으면_풀지_않는다(self):
        BOARDS["pod-a"] = {"blocked": ["t_bad"], "todo": ["t_wait"]}
        LINKS["t_wait"] = ["t_bad"]
        _ledger("1", "alice", "t_wait")
        with mock.patch.object(route, "CARDS_DEADLINE", 1.5):
            self.assertEqual(_states(_post(_body("1"))[1]), {"1": "waiting"})
        self.assertEqual(FakeAPI.calls, [])
        self.assertEqual(LINKS["t_wait"], ["t_bad"])

    def test_한_번에_5개까지(self):
        waits = [f"t_w{i}" for i in range(7)]
        BOARDS["pod-a"] = {"blocked": ["t_bad"], "todo": list(waits)}
        for i, w in enumerate(waits):
            LINKS[w] = ["t_bad"]
            _ledger(str(i + 1), "alice", w)
        _post(_body(*[str(i + 1) for i in range(7)]))
        self.assertEqual(len(self._ready_calls()), 5)
        _post(_body(*[str(i + 1) for i in range(7)]))                      # 다음 물음이 나머지를 푼다
        self.assertEqual(sorted(self._ready_calls()), sorted(waits))

    def test_이음이_이미_없으면_404_를_넘어간다(self):
        BOARDS["pod-a"] = {"blocked": ["t_bad"], "todo": ["t_wait"]}
        LINKS["t_wait"] = ["t_bad"]
        DELETE_FAIL[("t_bad", "t_wait")] = HermesError("not found", 404)
        _ledger("1", "alice", "t_wait")
        _post(_body("1"))
        self.assertEqual(self._ready_calls(), ["t_wait"])

    def test_이음_지우기의_다른_실패는_로그만_남기고_답한다(self):
        BOARDS["pod-a"] = {"blocked": ["t_bad"], "todo": ["t_wait"]}
        LINKS["t_wait"] = ["t_bad"]
        DELETE_FAIL[("t_bad", "t_wait")] = HermesError("boom", 502)
        _ledger("1", "alice", "t_wait")
        status, body = _post(_body("1"))
        self.assertEqual((status, _states(body)), (200, {"1": "waiting"}))
        self.assertEqual(self._ready_calls(), [])


if __name__ == "__main__":
    unittest.main()

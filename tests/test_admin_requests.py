# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""관리자에게 요청(스펙 2026-10-15-011 단계 5, §12): 표·만들기 검증·받은편지함 항목·처리/거절/확인·동시성."""
import aasserver  # 실제 uvicorn 앱을 띄우는 시험 하네스(OMAI-1100)
import http.client
import json
import os
import tempfile
import threading
import unittest
from datetime import datetime, timedelta
from pathlib import Path
from unittest import mock

TMP = tempfile.TemporaryDirectory()
os.environ.setdefault("AAS_DATA_DIR", str(Path(TMP.name) / "data"))

from aas.auth import auth  # noqa: E402
from aas.common import dbmigrate, store  # noqa: E402
from aas.fleet import pods  # noqa: E402
from aas.ops import admin_requests as ar  # noqa: E402
from aas.web import server  # noqa: E402

LABEL = lambda pod, prof: f"{pod}/{prof}"   # noqa: E731
OWNER, OTHER, ADMIN = "t@example.com", "u@example.com", "root@example.com"


def clear():
    with store.connect() as conn:
        conn.executescript(ar.SCHEMA)
        conn.execute("DELETE FROM admin_requests")


class ModuleTest(unittest.TestCase):
    def setUp(self):
        clear()

    def test_workspace_size_closes_only_on_its_pods_and_keeps_numbers(self):
        # 스펙 2026-11-06-005 O2·디자인 D16·재검토 R10·M2: 작업공간 단위 요청, 메모리가 커진 크기 롤아웃이 끝나면 그 사람 작업공간 것만 닫는다
        a = ar.create("pod-a", ar.WORKSPACE, OWNER, "workspace_size", "OOMKilled 21:15, 4Gi")
        b = ar.create("pod-b", ar.WORKSPACE, OWNER, "workspace_size", "")
        other = ar.create("pod-c", ar.WORKSPACE, OTHER, "workspace_size", "")
        with self.assertRaises(ar.RequestError):          # 같은 작업공간의 대기 요청은 하나(부분 유니크 색인)
            ar.create("pod-a", ar.WORKSPACE, OWNER, "workspace_size", "again")
        model = ar.create("pod-a", "main", OWNER, "model_change", "")
        self.assertEqual(ar.close_workspace_size(["pod-a", "pod-b"], 4 * 2**30, 8 * 2**30), 2)
        self.assertEqual(ar.close_workspace_size([], 1, 2), 0)
        self.assertEqual(ar.close_workspace_size(["pod-a"], 1, 2), 0, "이미 닫힌 요청은 다시 닫지 않는다")
        rows = {r["id"]: r for r in ar.result_items(OWNER, LABEL)}
        got = rows[f"{ar.RESULT_PREFIX}{a}"]
        self.assertEqual((got["status"], got["memory_from"], got["memory_to"]), ("handled", 4 * 2**30, 8 * 2**30))
        self.assertIn(f"{ar.RESULT_PREFIX}{b}", rows)
        pending = {r["id"] for r in ar.admin_items(LABEL)}
        self.assertEqual(pending, {f"{ar.ADMIN_PREFIX}{other}", f"{ar.ADMIN_PREFIX}{model}"}, "다른 사람·다른 종류는 그대로")

    def test_size_change_parses_only_its_own_reason(self):
        self.assertEqual(ar.size_change("size:1:2"), {"memory_from": 1, "memory_to": 2})
        for bad in ("", "size:x:2", "자리 부족", "size:1", "other:1:2"):
            self.assertIsNone(ar.size_change(bad), bad)

    def test_create_validates_kind_and_redacts_detail(self):
        with self.assertRaises(ar.RequestError):
            ar.create("p", "ma", OWNER, "nope", "x")
        rid = ar.create("p", "ma", OWNER.upper(), "model_change", "모델을 바꿔 주세요  token=abcdefghijklmnop1234 " + "가" * 400)
        row = ar.admin_items(LABEL)[0]
        self.assertEqual((row["id"], row["requester"], row["req_kind"], row["alias"]), (f"areq|{rid}", OWNER, "model_change", "p/ma"))   # 요청자 이메일은 소문자로
        self.assertLessEqual(len(row["text"]), ar.DETAIL_MAX)
        self.assertEqual(row["requester_name"], OWNER)                                   # 이름 함수가 없으면 이메일
        named = ar.admin_items(LABEL, name_of=lambda email: {OWNER: "김영주"}.get(email, email.split("@")[0]))[0]
        self.assertEqual((named["requester"], named["requester_name"]), (OWNER, "김영주"))   # 화면은 이름, 이메일은 풍선말
        self.assertNotIn("abcdefghijklmnop1234", row["text"])

    def test_same_pending_request_is_refused_until_it_is_handled(self):
        first = ar.create("p", "ma", OWNER, "profile_limit", "")
        with self.assertRaises(ar.RequestError) as cm:
            ar.create("p", "ma", OTHER, "profile_limit", "")                   # 요청자가 달라도 (파드, 프로파일, 종류)가 같으면 한 건
        self.assertEqual(cm.exception.code, 409)
        ar.create("p", "ma", OWNER, "model_change", "")                          # 종류가 다르면 된다
        ar.decide(f"areq|{first}", "handled", ADMIN, "")
        ar.create("p", "ma", OWNER, "profile_limit", "")                         # 처리된 뒤에는 다시 요청할 수 있다

    def test_pending_cap_per_requester(self):
        with mock.patch.object(ar, "pending_max", return_value=2):
            ar.create("p", "ma", OWNER, "model_change", ""); ar.create("p", "ma", OWNER, "other", "")
            with self.assertRaises(ar.RequestError) as cm:
                ar.create("p", "sa", OWNER, "other", "")
            self.assertEqual(cm.exception.code, 429)
            ar.create("p", "zz", OTHER, "other", "")                              # 다른 사람의 한도에는 영향이 없다

    def test_admin_items_oldest_first_with_waiting_days_and_stale_flag(self):
        now = datetime.now().astimezone()
        ar.create("p", "a", OWNER, "other", "old", now - timedelta(days=9))
        ar.create("p", "b", OWNER, "other", "new", now - timedelta(days=1))
        items = ar.admin_items(LABEL, now)
        self.assertEqual([(i["text"], i["waiting_days"], i["stale"]) for i in items], [("old", 9, True), ("new", 1, False)])

    def test_decide_is_won_by_exactly_one_admin_and_sets_the_result(self):
        rid = ar.create("p", "ma", OWNER, "other", "부탁")
        results, barrier = [], threading.Barrier(2)
        def go(status):
            barrier.wait()
            try:
                ar.decide(f"areq|{rid}", status, ADMIN, "사유"); results.append("ok")
            except ar.RequestError as exc:
                results.append(exc.code)
        ts = [threading.Thread(target=go, args=(s,)) for s in ("handled", "declined")]
        [t.start() for t in ts]; [t.join() for t in ts]
        self.assertEqual(sorted(map(str, results)), ["409", "ok"])               # 진 쪽은 「이미 처리된 요청입니다」
        self.assertEqual(ar.admin_items(LABEL), [])
        with self.assertRaises(ar.RequestError):
            ar.decide("areq|abc", "handled", ADMIN, "")
        with self.assertRaises(ar.RequestError):
            ar.decide(f"areq|{rid}", "bogus", ADMIN, "")

    def test_requester_result_item_hides_the_admin_and_ack_is_owner_only_and_idempotent(self):
        rid = ar.create("p", "ma", OWNER, "model_change", "부탁")
        self.assertEqual(ar.result_items(OWNER, LABEL), [])                      # 처리 전에는 결과가 없다
        ar.decide(f"areq|{rid}", "declined", ADMIN, "지금은 어렵습니다")
        item = ar.result_items(OWNER, LABEL)[0]
        self.assertEqual((item["id"], item["status"], item["reason"]), (f"areq_res|{rid}", "declined", "지금은 어렵습니다"))
        self.assertNotIn(ADMIN, json.dumps(item))
        self.assertEqual(ar.result_items(OTHER, LABEL), [])
        with self.assertRaises(ar.RequestError) as cm:
            ar.ack(f"areq_res|{rid}", OTHER)
        self.assertEqual(cm.exception.code, 403)
        ar.ack(f"areq_res|{rid}", OWNER); ar.ack(f"areq_res|{rid}", OWNER)       # 두 번 눌러도 같다
        self.assertEqual(ar.result_items(OWNER, LABEL), [])

    def test_result_expires_after_days_and_old_rows_are_pruned(self):
        rid = ar.create("p", "ma", OWNER, "other", "")
        ar.decide(f"areq|{rid}", "handled", ADMIN, "", datetime.now().astimezone() - timedelta(days=8))
        self.assertEqual(ar.result_items(OWNER, LABEL), [])                      # 확인하지 않아도 7일 뒤 사라진다
        rid2 = ar.create("p", "sa", OWNER, "other", "")
        ar.decide(f"areq|{rid2}", "handled", ADMIN, "", datetime.now().astimezone() - timedelta(days=91))
        ar.prune()
        with store.connect() as conn:
            self.assertEqual([r[0] for r in conn.execute("SELECT id FROM admin_requests ORDER BY id")], [rid])      # 90일 지난 행만 지운다

    def test_schema_is_registered_for_the_postgres_migration(self):
        self.assertIn(ar.SCHEMA, dbmigrate.schema_scripts())
        self.assertIn("admin_requests", dbmigrate.IDENTITY_TABLES)


class ServerTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        root = Path(TMP.name)
        home = root / "ph"; (home / "profiles" / "ma").mkdir(parents=True)
        reg = root / "ar-pods.json"
        reg.write_text(json.dumps({"pods": [{"id": "p", "owner": OWNER, "hermes_home": str(home), "dashboard_url": "http://127.0.0.1:9"}]}))
        server._auth = auth.Auth({"issuer": "https://accounts.google.com", "client_id": "", "client_secret": "", "domain": "",
                                  "public_url": "http://localhost:17900", "hours": 1, "users_file": root / "none.json"})
        server._registry = pods.Registry(reg)
        cls.app = aasserver.start()

    @classmethod
    def tearDownClass(cls):
        cls.app.shutdown()
        server._auth = server._registry = None
        server._hubs.clear(); server._cache.clear()

    def setUp(self):
        clear()

    def as_user(self, email, admin=False, enabled=True):
        reg = server._registry
        old = (server._auth, reg.is_admin)
        class On:
            def __init__(s): s.enabled = enabled; s.email = email
            def user(s, cookie): return {"email": s.email, "name": ""}
        server._auth = On(); reg.is_admin = lambda u: admin
        def restore():
            server._auth, reg.is_admin = old
        self.addCleanup(restore)

    def req(self, method, path, body=None):
        c = http.client.HTTPConnection("127.0.0.1", self.app.server_port, timeout=10)
        c.request(method, path, body=json.dumps(body) if body is not None else None, headers={"Content-Type": "application/json", "X-AAS": "1"})
        r = c.getresponse(); data = json.loads(r.read() or b"{}"); c.close()
        return r.status, data

    def ask(self, **extra):
        return self.req("POST", "/api/requests", {"profile": "ma", "kind": "model_change", "detail": "모델 변경", **extra})

    def test_create_validations(self):
        self.as_user(OWNER)
        self.assertEqual(self.ask()[0], 200)
        self.assertEqual(self.ask()[0], 409)                                     # 같은 요청이 대기 중
        self.assertEqual(self.ask(kind="nope")[0], 400)
        self.assertEqual(self.ask(profile="ghost")[0], 400)
        with mock.patch.object(server.cron_policy, "root_hidden", return_value=True):
            self.assertEqual(self.ask(profile="default", kind="other")[0], 400)  # 숨긴 루트는 거절(R5)

    def test_only_the_owner_or_an_admin_may_request_and_local_mode_is_refused(self):
        self.as_user(OTHER)
        self.assertEqual(self.ask()[0], 403)
        self.as_user(OWNER, enabled=False)
        self.assertEqual(self.ask()[0], 400)
        self.as_user(ADMIN, admin=True)
        self.assertEqual(self.ask(kind="other")[0], 200)

    def test_flow_owner_asks_admin_handles_owner_sees_the_result_and_acks(self):
        self.as_user(OWNER)
        self.assertEqual(self.ask()[0], 200)
        code, out = self.req("GET", "/api/requests")
        self.assertEqual((code, [w["kind"] for w in out["waiting"]]), (200, ["model_change"]))
        items = self.req("GET", "/api/office/inbox")[1]["items"]
        self.assertEqual([i["kind"] for i in items if i["kind"].startswith("admin_request")], [])           # 주인에게는 관리자 항목이 안 보인다
        self.as_user(ADMIN, admin=True)
        items = self.req("GET", "/api/office/inbox")[1]["items"]
        req = next(i for i in items if i["kind"] == "admin_request")
        self.assertEqual((req["requester"], req["profile"], req["text"]), (OWNER, "ma", "모델 변경"))
        self.as_user(OWNER)
        self.assertEqual(self.req("POST", "/api/office/inbox/answer", {"id": req["id"], "choice": "handled"})[0], 403)       # 처리는 관리자만
        self.as_user(ADMIN, admin=True)
        self.assertEqual(self.req("POST", "/api/office/inbox/answer", {"id": req["id"], "choice": "declined", "reason": "정책상 어렵습니다"})[0], 200)
        code, out = self.req("POST", "/api/office/inbox/answer", {"id": req["id"], "choice": "handled"})
        self.assertEqual(code, 409)                                              # 이미 처리됨
        self.assertEqual([i for i in self.req("GET", "/api/office/inbox")[1]["items"] if i["kind"] == "admin_request"], [])
        self.as_user(OWNER)
        res = next(i for i in self.req("GET", "/api/office/inbox")[1]["items"] if i["kind"] == "admin_request_result")
        self.assertEqual((res["status"], res["reason"]), ("declined", "정책상 어렵습니다"))
        self.as_user(OTHER)
        self.assertEqual(self.req("POST", "/api/office/inbox/answer", {"id": res["id"]})[0], 403)                            # 본인만 확인
        self.as_user(OWNER)
        self.assertEqual(self.req("POST", "/api/office/inbox/answer", {"id": res["id"]})[0], 200)
        self.assertEqual([i for i in self.req("GET", "/api/office/inbox")[1]["items"] if i["kind"] == "admin_request_result"], [])

    def test_an_admin_who_is_also_a_requester_gets_two_distinct_ids(self):
        self.as_user(ADMIN, admin=True)
        self.assertEqual(self.ask(kind="other")[0], 200)
        rid = next(i for i in self.req("GET", "/api/office/inbox")[1]["items"] if i["kind"] == "admin_request")["id"]
        self.assertEqual(self.req("POST", "/api/office/inbox/answer", {"id": rid, "choice": "handled"})[0], 200)
        res = next(i for i in self.req("GET", "/api/office/inbox")[1]["items"] if i["kind"] == "admin_request_result")
        self.assertEqual((rid.split("|")[0], res["id"].split("|")[0]), ("areq", "areq_res"))


if __name__ == "__main__":
    unittest.main()


class KindsMatchScreenTest(unittest.TestCase):
    def test_server_kinds_equal_screen_request_kinds(self):
        # 손으로 맞추는 목록(스펙 2026-11-06-005 Section 2 #1): 서버 KINDS 와 화면 REQUEST_KINDS 가 같아야 한다
        import re
        src = (Path(__file__).resolve().parents[1] / "ui" / "src" / "features" / "requests" / "RequestAdminButton.tsx").read_text(encoding="utf-8")
        m = re.search(r"REQUEST_KINDS: readonly RequestKind\[\] = \[([^\]]*)\]", src)
        self.assertIsNotNone(m)
        self.assertEqual(tuple(re.findall(r"'([a-z_]+)'", m.group(1))), ar.KINDS)

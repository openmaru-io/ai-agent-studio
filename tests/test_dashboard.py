# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""대시보드(계획 2026-10-14-014): 추이 질의·역할 거름, 수집 바퀴의 POD 요약·일별 사용량, /api/dashboard·/api/trend 역할별 응답.
시험마다 자기 데이터 폴더를 쓰고 끝나면 원래 값으로 돌린다(다른 시험과 AAS_DATA_DIR 을 함께 쓰지 않게)."""
import aasserver  # 실제 uvicorn 앱을 띄우는 시험 하네스(OMAI-1100)
import base64
import http.client
import json
import os
import sqlite3
import tempfile
import threading
import time
import unittest
from datetime import datetime, timedelta
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from types import SimpleNamespace
from unittest import mock
from urllib.parse import parse_qs, urlsplit

from aas.common import store
from aas.ops import activity, dashboard


class DataDir:
    """이 시험만의 AAS_DATA_DIR. 끝나면 원래 값으로 돌린다."""

    def __init__(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.old = os.environ.get("AAS_DATA_DIR")
        os.environ["AAS_DATA_DIR"] = self.tmp.name

    def close(self):
        if self.old is None:
            os.environ.pop("AAS_DATA_DIR", None)
        else:
            os.environ["AAS_DATA_DIR"] = self.old
        self.tmp.cleanup()


def health(ts, rows, failed=()):
    """rows: (프로파일 이름, 열린 사건, 실패, 멈춤) 목록."""
    profs = [{"name": n, "jobs_status": "ok", "exec_status": "ok", "open_incidents": o, "new_incidents": 0, "failed_jobs": f,
              "stalled_jobs": s, "silent_jobs": 0, "jobs_total": 3, "jobs_active": 2, "runs_7d": 5, "runs_failed_7d": f} for n, o, f, s in rows]
    return {"collected_at": ts, "profiles": profs, "incidents": [], "muted": [], "jobs": [],
            "pods": {"failed": [{"pod": p, "reason": "시간 초과"} for p in failed]}}


def old_trend(days=35):
    """바꾸기 전의 추이(날짜마다 질의) — 한 번에 묻는 새 질의와 결과를 비교한다(R11)."""
    with store.connect() as conn:
        rows = conn.execute("SELECT substr(ts,1,10) AS day, MAX(ts) ts FROM snapshots GROUP BY day ORDER BY day DESC LIMIT ?", (days,)).fetchall()
    return [{"day": r["day"], **store.totals_at(r["ts"])} for r in reversed(rows) if store.totals_at(r["ts"])]


class PreparingAgentOwnerTest(unittest.TestCase):
    """2026-10-18 OKE 에서 찾음: 준비 중인 에이전트(등록부에 아직 없음) 행의 주인 이름을 만들 때 변수 이름이 겹쳐
    「'set' object has no attribute 'get'」으로 대시보드 전체가 깨졌다."""
    def setUp(self):
        self.d = DataDir()

    def tearDown(self):
        self.d.close()

    def test_preparing_agent_row_has_the_owner_name(self):
        from aas.ops import dashboard
        class Reg:
            agents = [{"name": "aas-agent-new", "owner": "kim@x.com", "phase": "Pending"}]
            def is_admin(self, user): return True
            def allowed(self, user, enabled): return []
        out = dashboard.view(Reg(), {"email": "boss@x.com"}, True)
        row = next(r for r in out["pods"] if r["id"] == "aas-agent-new")
        self.assertEqual((row["owner"], row["owner_name"], row["ready"]), ("kim@x.com", "kim", False))

    def test_rows_carry_the_agent_name(self):
        """에이전트 이름(displayName)을 행마다 준다. 이름이 없으면 빈 값 — 화면이 id 를 쓴다(스펙 2026-10-18-013)."""
        from aas.ops import dashboard
        class P:
            def __init__(self, id): self.id, self.owner = id, "kim@x.com"
            def owned_by(self, user): return True
        class Reg:
            agents = [{"name": "aas-agent-a", "display_name": "AAS 관리자", "owner": "kim@x.com", "phase": "Ready"},
                      {"name": "aas-agent-new", "display_name": "새 에이전트", "owner": "kim@x.com", "phase": "Pending"}]
            def is_admin(self, user): return True
            def allowed(self, user, enabled): return [P("aas-agent-a"), P("aas-agent-b")]
        out = dashboard.view(Reg(), {"email": "boss@x.com"}, True)
        self.assertEqual({r["id"]: r["name"] for r in out["pods"]},
                         {"aas-agent-a": "AAS 관리자", "aas-agent-b": "", "aas-agent-new": "새 에이전트"})


class LastDayTest(unittest.TestCase):
    """대시보드가 에이전트마다 usage_last_day 로 DB 를 따로 불렀다(에이전트 9개면 9번). DB 와 먼 노드의 서버에서는
    연결 한 번이 22ms 라 그대로 늘었다(스펙 2026-10-24-006 §6). 한 번에 묻는다."""
    def setUp(self):
        self.d = DataDir()

    def tearDown(self):
        self.d.close()

    def test_마지막_날을_한_번에_묻고_값은_에이전트마다_같다(self):
        with store.connect() as conn:
            for pod, day in (("a", "2026-10-20"), ("a", "2026-10-22"), ("b", "2026-10-21")):
                conn.execute("INSERT INTO usage_daily (pod, day, sessions, messages, input_tokens, output_tokens) VALUES (?,?,0,0,0,0)", (pod, day))
        self.assertEqual(store.usage_last_days(["a", "b", "c"]), {"a": "2026-10-22", "b": "2026-10-21"})
        self.assertEqual(store.usage_last_days([]), {})

        class P:
            def __init__(self, id): self.id, self.owner = id, "kim@x.com"
            def owned_by(self, user): return True

        class Reg:
            agents = []
            def is_admin(self, user): return True
            def allowed(self, user, enabled): return [P("a"), P("b"), P("c")]
        with mock.patch.object(store, "usage_last_day", side_effect=AssertionError("에이전트마다 따로 물었다")):
            out = dashboard.view(Reg(), {"email": "boss@x.com"}, True)
        self.assertEqual({r["id"]: r["last_day"] for r in out["pods"]}, {"a": "2026-10-22", "b": "2026-10-21", "c": None})


class TrendTest(unittest.TestCase):
    def setUp(self):
        self.d = DataDir()
        for day, n in (("2026-10-10", 1), ("2026-10-11", 2), ("2026-10-12", 3)):
            store.record_snapshot(health(f"{day}T09:00:00+09:00", [("a/ma", n, n, 0), ("b/ops", 10, 0, n), ("ab_c/x", 7, 7, 7)]))
            store.record_snapshot(health(f"{day}T18:00:00+09:00", [("a/ma", n + 1, n, 1), ("b/ops", 20, 1, n), ("ab_c/x", 7, 7, 7)]))

    def tearDown(self):
        self.d.close()

    def test_한_번에_묻는_추이가_예전_결과와_같다(self):
        self.assertEqual(store.trend(35), old_trend(35))
        self.assertEqual(store.trend(2), old_trend(2))
        self.assertEqual([r["day"] for r in store.trend(35)], ["2026-10-10", "2026-10-11", "2026-10-12"])

    def test_POD_로_거르면_그_POD_줄만_더하고_밑줄이_든_이름도_글자_그대로_맞춘다(self):
        only_a = store.trend(35, ["a"])
        self.assertEqual([(r["open_incidents"], r["profiles"]) for r in only_a], [(2, 1), (3, 1), (4, 1)])
        self.assertEqual([r["open_incidents"] for r in store.trend(35, ["ab_c"])], [7, 7, 7])
        self.assertEqual(store.trend(35, ["a_"]), [])                 # 「_」 가 아무 글자로 맞지 않는다
        self.assertEqual(store.trend(35, []), [])

    def test_전체_합계_값은_관리자에게만(self):
        self.assertIsNone(store.trend(35, ["a"], totals=False)[0]["live_incidents"])
        self.assertIsNotNone(store.trend(35)[0]["live_incidents"])

    def test_POD_하나_설치는_접두어가_없어_전부_그_POD(self):
        with store.connect() as conn:
            conn.execute("DELETE FROM snapshots")
        store.record_snapshot(health("2026-10-13T09:00:00+09:00", [("ma", 2, 1, 0), ("ops", 1, 0, 0)]))
        self.assertEqual(store.trend(35, ["only"])[0]["open_incidents"], 3)


class Pod(SimpleNamespace):
    def owned_by(self, user):
        return bool(user) and user.get("email") == self.owner


class RoundTest(unittest.TestCase):
    def setUp(self):
        self.d = DataDir()
        self.pods = [Pod(id="a", owner="alice@x.com", hermes_home=None, container="a"),
                     Pod(id="b", owner="bob@x.com", hermes_home=None, container="b")]
        self.litellm = mock.patch.object(dashboard.models, "fetch_litellm", return_value={"reachable": True, "error": ""})
        self.litellm.start()

    def tearDown(self):
        self.litellm.stop()
        self.d.close()

    def test_바퀴마다_POD_요약을_쓰고_실패한_POD_는_지난_값을_둔다(self):
        read = lambda p: {"profiles": 3, "gateways_up": 2, "profiles_bad": 1, "creds_expiring": 4}   # noqa: E731
        h = health("2026-10-14T09:00:00+09:00", [("a/ma", 1, 2, 1), ("b/ops", 0, 0, 0)])
        dashboard.record_round(self.pods, h, read=read)
        s = store.pod_summaries()
        self.assertEqual((s["a"]["ok"], s["a"]["failed_jobs"], s["a"]["stalled_jobs"], s["a"]["gateways_up"], s["a"]["creds_expiring"]), (1, 2, 1, 2, 4))
        first_ts = s["b"]["ts"]

        def broken(p):
            raise OSError("사이드카 없음")
        dashboard.record_round(self.pods, health("2026-10-14T09:30:00+09:00", [("a/ma", 0, 0, 0)], failed=["b"]), read=broken)
        s = store.pod_summaries()
        self.assertEqual((s["b"]["ok"], s["b"]["reason"], s["b"]["ts"], s["b"]["gateways_up"]), (0, "시간 초과", first_ts, 2))   # 지난 값·시각 그대로
        self.assertEqual((s["a"]["ok"], s["a"]["failed_jobs"]), (0, 2))                                                          # 요약을 못 읽은 POD 도 실패
        self.assertIn("사이드카 없음", s["a"]["reason"])

    def test_요약에_메신저_연결_수가_들어가고_옛_DB_에도_열이_더해진다(self):
        # 게이트웨이가 실행 중이어도 메신저가 하나도 없을 수 있다(2026-10-18) — 「메신저 연결」 칸은 게이트웨이 수가 아니라 이 값을 보인다
        read = lambda p: {"profiles": 1, "gateways_up": 1, "profiles_bad": 0, "creds_expiring": 0, "messengers_connected": 0, "messengers_total": 0}   # noqa: E731
        dashboard.record_round(self.pods, health("2026-10-14T09:00:00+09:00", [("a/ma", 0, 0, 0)]), read=read)
        a = store.pod_summaries()["a"]
        self.assertEqual((a["gateways_up"], a["messengers_connected"], a["messengers_total"]), (1, 0, 0))
        with store.connect() as conn:                                   # 옛 DB: 두 열이 없는 pod_summary
            conn.execute("DROP TABLE pod_summary")
            conn.execute("CREATE TABLE pod_summary (pod TEXT PRIMARY KEY, ts TEXT, checked TEXT NOT NULL, ok INTEGER NOT NULL, reason TEXT, profiles INTEGER, gateways_up INTEGER, profiles_bad INTEGER, creds_expiring INTEGER, jobs INTEGER, jobs_active INTEGER, failed_jobs INTEGER, stalled_jobs INTEGER, open_incidents INTEGER)")
            conn.execute("INSERT INTO pod_summary (pod, ts, checked, ok, gateways_up) VALUES ('old', 't', 't', 1, 2)")
        store._MIGRATED.clear()
        with store.connect() as conn:
            pass
        old = store.pod_summaries()["old"]
        self.assertEqual((old["gateways_up"], old["messengers_connected"], old["messengers_total"]), (2, None, None))   # 옛 행은 모르는 값(None)

    def test_일별_사용량은_처음에_추이_기간을_채우고_다음에는_마지막_날부터(self):
        now = datetime(2026, 10, 14, 0, 31).astimezone()
        calls = []

        def read(since, until, home=None):
            calls.append((since, until))
            return {"2026-10-13": {"sessions": 2, "messages": 5, "input_tokens": 100, "output_tokens": 10}}
        self.assertTrue(dashboard.usage_due(now))
        dashboard.record_usage(self.pods[:1], now, read=read)
        today = now.replace(hour=0, minute=0)
        self.assertEqual(calls[0], ((today - timedelta(days=dashboard.TREND_DAYS)).timestamp(), today.timestamp()))   # 30일(보관 31일 안, 스펙 2026-10-24-006)
        self.assertFalse(dashboard.usage_due(now))                      # 오늘은 이미 쌓았다
        self.assertFalse(dashboard.usage_due(now.replace(day=15, minute=10)))   # 다음 날 00:10 은 아직
        self.assertTrue(dashboard.usage_due(now.replace(day=15)))
        dashboard.record_usage(self.pods[:1], now.replace(day=15), read=read)
        self.assertEqual(datetime.fromtimestamp(calls[1][0]).date().isoformat(), "2026-10-13")
        self.assertEqual(store.usage_days(["a"], "2026-10-01"), [{"day": "2026-10-13", "sessions": 2, "messages": 5, "input_tokens": 100, "output_tokens": 10}])
        self.assertEqual(store.usage_days([], "2026-10-01"), [])

    def test_세션_DB_를_서버_시간대의_날짜로_묶는다(self):
        home = Path(self.d.tmp.name) / "home"
        (home / "profiles" / "ma").mkdir(parents=True)
        c = sqlite3.connect(home / "profiles" / "ma" / "state.db")
        c.execute("CREATE TABLE sessions (id TEXT, source TEXT, started_at REAL, message_count INT, input_tokens INT, output_tokens INT)")
        noon = datetime(2026, 10, 12, 12, 0).astimezone().timestamp()
        c.executemany("INSERT INTO sessions VALUES (?,?,?,?,?,?)", [("1", "cli", noon, 3, 10, 1), ("2", "cli", noon + 60, 1, 5, 1),
                                                                     ("3", "cli", noon + 86400, 2, 1, 1)])
        c.commit(); c.close()
        got = activity.daily(noon - 86400, noon + 2 * 86400, home=home)
        self.assertEqual(got["2026-10-12"], {"sessions": 2, "messages": 4, "input_tokens": 15, "output_tokens": 2})
        self.assertEqual(got["2026-10-13"]["sessions"], 1)


def b64(obj) -> str:
    return base64.urlsafe_b64encode(json.dumps(obj).encode()).rstrip(b"=").decode()


class FakeIdP(BaseHTTPRequestHandler):
    claims: dict = {}

    def do_GET(self):
        base = f"http://127.0.0.1:{self.server.server_port}"
        body = json.dumps({"issuer": base, "authorization_endpoint": base + "/authorize", "token_endpoint": base + "/token"}).encode()
        self.send_response(200); self.send_header("Content-Length", str(len(body))); self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        self.rfile.read(int(self.headers["Content-Length"]))
        body = json.dumps({"id_token": f"{b64({'alg': 'none'})}.{b64(FakeIdP.claims)}.x"}).encode()
        self.send_response(200); self.send_header("Content-Length", str(len(body))); self.end_headers()
        self.wfile.write(body)

    def log_message(self, *a):
        pass


class DashboardApiTest(unittest.TestCase):
    """관리자 boss, 주인 alice(a)·bob(b), 보기 권한자 carol(b 를 받음)."""

    @classmethod
    def setUpClass(cls):
        from aas.auth import auth
        from aas.fleet import pods
        from aas.web import server
        cls.d = DataDir()
        cls.idp = ThreadingHTTPServer(("127.0.0.1", 0), FakeIdP)
        threading.Thread(target=cls.idp.serve_forever, daemon=True).start()
        cls.issuer = f"http://127.0.0.1:{cls.idp.server_port}"
        root = Path(cls.d.tmp.name)
        for name in ("home_a", "home_b"):
            (root / name / "profiles" / "p").mkdir(parents=True)
        reg = root / "pods.json"
        reg.write_text(json.dumps({"admins": ["boss@corp.example"], "pods": [
            {"id": "a", "owner": "alice@corp.example", "hermes_home": str(root / "home_a")},
            {"id": "b", "owner": "bob@corp.example", "hermes_home": str(root / "home_b")}]}))
        cls.app = aasserver.start()
        cls.port = cls.app.server_port
        cls.old = (server._auth, server._registry)
        server._auth = auth.Auth({"issuer": cls.issuer, "client_id": "cid", "client_secret": "sec",
                                  "domain": "corp.example", "public_url": f"http://127.0.0.1:{cls.port}", "hours": 1})
        server._registry = pods.Registry(reg)
        server._registry.grant("carol@corp.example", "user", ["b"], "test")
        cls.server = server
        for day in ("2026-10-12", "2026-10-13"):
            store.record_snapshot(health(f"{day}T09:00:00+09:00", [("a/ma", 1, 1, 0), ("b/ops", 5, 2, 1)]))
        store.save_pod_summary("a", "2026-10-13T09:00:00+09:00", {"gateways_up": 1, "failed_jobs": 1, "creds_expiring": 2, "profiles_bad": 1})
        store.save_pod_summary("b", "2026-10-13T09:00:00+09:00", {"gateways_up": 2, "failed_jobs": 2, "stalled_jobs": 1})
        store.save_pod_summary("b", "2026-10-13T09:30:00+09:00", None, "시간 초과")
        store.save_usage_days("a", {"2026-10-13": {"sessions": 1, "input_tokens": 10}})
        store.save_usage_days("b", {"2026-10-13": {"sessions": 4, "input_tokens": 40}})
        cls.cookies = {who: cls.login(f"{who}@corp.example") for who in ("boss", "alice", "carol")}

    @classmethod
    def tearDownClass(cls):
        cls.idp.shutdown(); cls.app.shutdown()
        cls.server._auth, cls.server._registry = cls.old
        cls.d.close()

    @classmethod
    def req(cls, path, cookie=""):
        c = http.client.HTTPConnection("127.0.0.1", cls.port, timeout=10)
        c.request("GET", path, headers={"Cookie": cookie} if cookie else {})
        r = c.getresponse()
        return r, r.read()

    @classmethod
    def login(cls, email):
        r, _ = cls.req("/auth/oidc")
        q = parse_qs(urlsplit(r.getheader("Location")).query)
        FakeIdP.claims = {"iss": cls.issuer, "aud": "cid", "exp": time.time() + 300, "nonce": q["nonce"][0],
                          "sub": "sub-" + email, "email": email, "email_verified": True, "name": "N"}
        r, _ = cls.req(f"/auth/callback?code=abc&state={q['state'][0]}")
        return r.getheader("Set-Cookie").split(";")[0]

    def get(self, who, path):
        r, body = self.req(path, self.cookies[who])
        self.assertEqual(r.status, 200, body)
        return json.loads(body)

    def test_추이는_관리자에게_전부_그_밖에는_볼_수_있는_POD_만(self):
        boss = self.get("boss", "/api/trend")["trend"]
        self.assertEqual([r["open_incidents"] for r in boss], [6, 6])
        self.assertIsNotNone(boss[0]["live_incidents"])
        alice = self.get("alice", "/api/trend")["trend"]
        self.assertEqual([r["open_incidents"] for r in alice], [1, 1])
        self.assertIsNone(alice[0]["live_incidents"])
        self.assertEqual([r["open_incidents"] for r in self.get("carol", "/api/trend")["trend"]], [5, 5])

    def test_대시보드는_역할로_거르고_관리자_전용_값을_빼며_수집_실패를_밝힌다(self):
        boss = self.get("boss", "/api/dashboard")
        self.assertTrue(boss["admin"])
        self.assertEqual(sorted((p["id"], p["owner"]) for p in boss["pods"]), [("a", "alice@corp.example"), ("b", "bob@corp.example")])
        # 2026-10-18: 주인 칸은 이메일 대신 사람 이름으로 보인다(이름을 모르면 이메일 앞부분)
        self.assertEqual(sorted((p["id"], p["owner_name"]) for p in boss["pods"]), [("a", "alice"), ("b", "bob")])
        t = boss["totals"]
        # b 는 이번 수집에 실패해 합계에서 빠진다 — 「2개 중 1개 기준 · 1개 수집 실패」(DD5)
        self.assertEqual((t["agents_ready"], t["agents_total"], t["counted"], t["countable"], t["failed"]), (2, 2, 1, 2, 1))
        self.assertEqual((t["failed_stalled"], t["creds_expiring"], t["profiles_bad"]), (1, 2, 1))
        b = next(p for p in boss["pods"] if p["id"] == "b")
        self.assertEqual((b["ok"], b["reason"], b["ts"], b["values"]["failed_jobs"]), (False, "시간 초과", "2026-10-13T09:00:00+09:00", 2))
        self.assertIn("ops", boss)
        self.assertEqual(sum(u["sessions"] for u in boss["usage"]), 5)

        alice = self.get("alice", "/api/dashboard")
        self.assertFalse(alice["admin"])
        self.assertEqual([(p["id"], p["owner_me"]) for p in alice["pods"]], [("a", True)])
        self.assertNotIn("owner", alice["pods"][0])                  # 주인 이메일은 관리자에게만
        self.assertNotIn("ops", alice)
        self.assertEqual(sum(u["sessions"] for u in alice["usage"]), 1)
        carol = self.get("carol", "/api/dashboard")
        self.assertEqual([(p["id"], p["owner_me"]) for p in carol["pods"]], [("b", False)])

    def test_대시보드_요청은_에이전트와_사이드카를_부르지_않는다(self):
        boom = mock.Mock(side_effect=AssertionError("부르면 안 된다"))
        with mock.patch("aas.ops.channels.collect", boom), mock.patch("aas.assets.inventory.credentials", boom), \
                mock.patch("aas.hermes.hermes_api.HermesAPI.call", boom), mock.patch("aas.ops.activity.collect", boom):
            self.get("boss", "/api/dashboard")
            self.get("alice", "/api/dashboard")
        boom.assert_not_called()


if __name__ == "__main__":
    unittest.main()

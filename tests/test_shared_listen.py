# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""서버끼리 맞추기를 0.3초 반복 읽기에서 LISTEN/NOTIFY 로(스펙 2026-10-24-009 4절).

- PlanTest: 이번 주기에 무엇을 읽을지(알림이 온 종류, 5초 반복, 0.3초 상한, SQLite 는 지금처럼 매번)
- NotifyParseTest: 알림 내용 → 읽을 종류(내 서버의 걸음 알림도 읽음, 남의 답은 무시)
- PresenceTest: 걸음 읽기는 만료 행을 지우지 않고 시각으로 거른다, 오래된 행의 신호는 위치를 비운다
- PgListenTest(PostgreSQL): 쓰기와 같은 트랜잭션의 알림이 듣기 연결에 닿는다, 되돌린 쓰기는 알림이 없다, 끊기면 다시 붙는다
"""
import os
import tempfile
import threading
import time
import unittest

from aas.common import config, db, store
from aas.office import presence, shared

PG = config.db_backend() == "postgres"


class DataDir(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.old = os.environ.get("AAS_DATA_DIR")
        os.environ["AAS_DATA_DIR"] = self.tmp.name

    def tearDown(self):
        if self.old is None:
            os.environ.pop("AAS_DATA_DIR", None)
        else:
            os.environ["AAS_DATA_DIR"] = self.old
        self.tmp.cleanup()


class PlanTest(unittest.TestCase):
    KINDS = {"presence", "relay", "answer"}

    def plan(self, now, pending=(), last=None, last_full=0.0, pg=True, listening=True):
        return shared.due_reads(now, set(pending), dict(last or {}), last_full, pg, listening=listening)

    def test_SQLite_는_지금처럼_매번_셋을_읽는다(self):
        reads, left, full = self.plan(100.0, pg=False, last={"presence": 99.9, "relay": 99.9, "answer": 99.9}, last_full=99.9)
        self.assertEqual((reads, left), (self.KINDS, set()))

    def test_듣기_연결_정상이면_60초_전에는_알림_없이_읽지_않는다(self):
        reads, left, full = self.plan(104.0, last_full=100.0, listening=True)
        self.assertEqual((reads, left, full), (set(), set(), False))
        reads, left, full = self.plan(159.0, last_full=100.0, listening=True)
        self.assertEqual((reads, left, full), (set(), set(), False))

    def test_듣기_연결_정상이면_60초가_지나면_알림이_없어도_셋을_읽는다(self):
        reads, left, full = self.plan(160.1, last_full=100.0, listening=True)
        self.assertEqual((reads, full), (self.KINDS, True))

    def test_듣기_연결이_끊기면_5초가_지나면_셋을_읽는다(self):
        reads, left, full = self.plan(105.1, last_full=100.0, listening=False)
        self.assertEqual((reads, full), (self.KINDS, True))

    def test_알림이_온_종류는_바로_읽고_0_3초_안에_다시_오면_다음_주기로_미룬다(self):
        reads, left, _ = self.plan(100.0, pending={"presence"}, last={"presence": 99.0}, last_full=99.0)
        self.assertEqual((reads, left), ({"presence"}, set()))
        reads, left, _ = self.plan(100.1, pending={"presence", "relay"}, last={"presence": 100.0}, last_full=99.0)
        self.assertEqual((reads, left), ({"relay"}, {"presence"}))

    def test_중계_되돌아보는_창은_65초다(self):
        self.assertEqual(shared.RELAY_WINDOW, 65.0)


class NotifyParseTest(unittest.TestCase):
    def test_알림_내용을_읽을_종류로(self):
        me = "srv-a"
        self.assertEqual(shared.parse_notify("presence", me), "presence")             # 내 서버가 낸 걸음도 읽는다(리뷰 C6)
        self.assertEqual(shared.parse_notify("relay:srv-b", me), "relay")
        self.assertIsNone(shared.parse_notify("relay:srv-a", me))                    # 내 말풍선은 이미 내 화면에 나갔다
        self.assertEqual(shared.parse_notify("answer:srv-a", me), "answer")
        self.assertIsNone(shared.parse_notify("answer:srv-b", me))                   # 남의 서버로 간 답
        self.assertEqual(shared.parse_notify("desks", me), "desks")                  # 오피스 자리 맞춤 트리거 알림(스펙 2026-10-25-001 D5)
        self.assertIsNone(shared.parse_notify("??", me))

    def test_채널_이름은_스키마마다_다르고_63바이트_안(self):
        a = shared.channel_for("public")
        self.assertNotEqual(a, shared.channel_for("t_abc"))
        self.assertTrue(a.startswith("aas_shared_") and len(a.encode()) <= 63)


class PresenceTest(DataDir):
    def setUp(self):
        super().setUp()
        self.now = [1000.0]
        self.p = presence.Presence(ttl=30.0, clock=lambda: self.now[0])

    def rows(self):
        with presence._connect() as conn:
            return {r["email"]: (r["x"], r["ts"]) for r in conn.execute("SELECT email, x, ts FROM office_presence")}

    def test_걸음_읽기와_보기는_만료_행을_지우지_않고_시각으로_거른다(self):
        self.p.beat("a@x.co", "A", "s")
        self.p.move("a@x.co", 1, 2, 0)
        self.p.changes()
        self.now[0] += 31
        self.assertEqual(self.p.changes(), [("person.leave", {"id": presence.person_id("a@x.co")})])
        self.assertEqual(self.p.view("", False), [])
        self.assertIn("a@x.co", self.rows())                                # 지우기는 60초 정리(expire)가 한다
        self.p.expire()
        self.assertEqual(self.rows(), {})

    def test_오래된_행에_신호가_오면_옛_위치를_비운다(self):
        self.p.beat("a@x.co", "A", "s")
        self.p.move("a@x.co", 5, 5, 0)
        self.now[0] += 31
        self.p.beat("a@x.co", "A", "s")                                     # 탭이 깨어나 다시 신호 — 옛 자리로 나타나지 않는다
        self.assertEqual(self.rows()["a@x.co"][0], None)
        self.now[0] += 5
        self.p.beat("a@x.co", "A", "s")
        self.p.move("a@x.co", 7, 7, 0)
        self.now[0] += 5
        self.p.beat("a@x.co", "A", "s")                                     # 살아 있는 동안의 신호는 위치를 그대로 둔다
        self.assertEqual(self.rows()["a@x.co"][0], 7)


class TickTest(unittest.TestCase):
    """server.shared_tick: 알림이 반복 스레드를 깨우고(외부 검토 H3), 듣는 중인데 알림 없이 찾은 것은 놓친 알림으로 센다(외부 검토 M7)."""

    def setUp(self):
        from aas.web import server
        self.server = server
        with server._shared_lock:
            server._shared_pending.clear()
        server._shared_wake.clear()

    def test_알림이_오면_읽을_종류를_남기고_반복_스레드를_깨운다(self):
        s = self.server
        s._shared_notified("presence")
        s._shared_notified(f"relay:{s.SHARED.origin}")                    # 내 말풍선 — 읽지 않는다
        self.assertTrue(s._shared_wake.is_set())
        self.assertEqual(s._shared_pending, {"presence"})

    def test_듣는_중인데_5초_반복에서_알림_없이_찾은_것을_센다(self):
        from unittest import mock
        s = self.server

        class Up:
            connected = True
        found = {"presence": 2, "relay": 0, "answer": 1}
        with mock.patch.object(s.db, "backend", return_value="postgres"), \
                mock.patch.object(s, "SHARED_LISTENER", Up()), \
                mock.patch.object(s, "_shared_read", side_effect=lambda k: found[k]), \
                mock.patch.object(s.SHARED, "heartbeat"), mock.patch.object(s.SHARED, "set_busy"), \
                mock.patch.dict(s._shared_at, {"beat": 1e18, "clean": 1e18, "sweep": 1e18, "full": 0.0, "missed_log": 1e18}), \
                mock.patch.dict(s._shared_missed, {"n": 0}):
            s._shared_notified("presence")                                  # 걸음은 알림이 왔다 — 놓친 것이 아니다
            s.shared_tick()
            self.assertEqual(s._shared_missed["n"], 1)                     # 답 1건만 알림 없이 찾았다


@unittest.skipUnless(PG, "PostgreSQL 백엔드에서만")
class PgListenTest(DataDir):
    def setUp(self):
        super().setUp()
        self.got, self.connects = [], []
        self.ev = threading.Event()

        def on_notify(payload):
            self.got.append(payload)
            self.ev.set()
        self.listener = shared.Listener(on_notify, lambda: self.connects.append(time.time()), retry=0.2)
        self.listener.start()
        self.wait(lambda: self.listener.connected)

    def tearDown(self):
        self.listener.stop()
        super().tearDown()

    def wait(self, cond, timeout=5.0):
        end = time.time() + timeout
        while time.time() < end:
            if cond():
                return True
            time.sleep(0.02)
        self.fail("기다린 일이 일어나지 않았다")

    def test_쓰기와_같은_트랜잭션의_알림이_듣기_연결에_닿고_되돌린_쓰기는_알림이_없다(self):
        with store.connect() as conn:
            conn.execute("CREATE TABLE IF NOT EXISTS listen_probe (id INTEGER)")
        try:
            with store.connect() as conn:
                conn.execute("INSERT INTO listen_probe VALUES (1)")
                shared.notify(conn, "relay:other")
                raise ValueError("되돌림")
        except ValueError:
            pass
        time.sleep(0.3)
        self.assertEqual(self.got, [])
        with store.connect() as conn:
            conn.execute("INSERT INTO listen_probe VALUES (2)")
            shared.notify(conn, "presence")
        self.wait(lambda: self.got == ["presence"])

    def test_듣기_연결이_끊기면_다시_붙고_붙을_때마다_알린다(self):
        self.assertEqual(len(self.connects), 1)
        with store.connect() as conn:
            conn.execute("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE query LIKE 'LISTEN%' AND pid <> pg_backend_pid()")
        self.wait(lambda: len(self.connects) >= 2)
        self.wait(lambda: self.listener.connected)
        with store.connect() as conn:
            conn.execute("SELECT 1 FROM pg_class LIMIT 1")
            shared.notify(conn, "presence")
        self.wait(lambda: "presence" in self.got)


if __name__ == "__main__":
    unittest.main()

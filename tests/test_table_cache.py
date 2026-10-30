# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""자주 바뀌지 않는 표의 프로세스 캐시와 「표 바뀜」 알림(스펙 2026-10-26-002 R10, 리뷰 C1·H1·H2·E2·E3·E4·E9)."""
import threading
import time
import unittest
from unittest import mock

from aas.common import db, store, table_cache
from aas.office import office
from aas.ops import notices

try:
    from tests.test_db_tps_phase1 import DataDir
    from tests.test_office import KNOWN
except ImportError:                                            # unittest discover -s tests 로 돌릴 때
    from test_db_tps_phase1 import DataDir
    from test_office import KNOWN

PG = db.backend() == "postgres"


class CacheOn(DataDir):
    """캐시를 켠 상태(듣기 연결이 붙었다고 본다). SQLite 에서는 트리거 달기를 건너뛴다."""

    def setUp(self):
        super().setUp()
        table_cache.clear_for_test()
        self.addCleanup(table_cache.clear_for_test)
        p = mock.patch.object(table_cache, "listening", lambda: True)
        p.start()
        self.addCleanup(p.stop)
        if not PG:                                             # SQLite 에는 트리거가 없다 — 캐시 규칙만 본다
            for name in ("enabled", "_ready"):
                q = mock.patch.object(table_cache, name, return_value=True)
                q.start()
                self.addCleanup(q.stop)


class RulesTest(CacheOn):
    """캐시 규칙: 버리면 다음 읽기는 새 값(E2), 읽는 사이 바뀌면 남기지 않음(H1), TTL, 다시 붙으면 모두 버림, 돌려준 값을 고쳐도 번지지 않음."""

    def setUp(self):
        super().setUp()
        self.calls = []
        self.value = {"n": 1}
        q = mock.patch.object(table_cache, "_ready", return_value=True)   # 규칙 시험은 트리거 없이(표가 없어도) 본다
        q.start()
        self.addCleanup(q.stop)

    def read(self):
        self.calls.append(1)
        return dict(self.value)

    def get(self):
        return table_cache.get("t.key", ("notices",), self.read)

    def test_두_번째부터는_읽지_않고_버리면_다시_읽는다(self):
        self.assertEqual(self.get(), {"n": 1})
        self.assertEqual(self.get(), {"n": 1})
        self.assertEqual(len(self.calls), 1)
        self.value = {"n": 2}
        table_cache.on_notify("notices")                            # 다른 서버가 썼다
        self.assertEqual(self.get(), {"n": 2})
        self.assertEqual(len(self.calls), 2)

    def test_대상이_아닌_표의_알림은_버리지_않는다(self):
        self.get()
        table_cache.on_notify("office_presence")
        table_cache.on_notify("meta")                               # E9: meta 는 대상이 아니다
        self.get()
        self.assertEqual(len(self.calls), 1)

    def test_읽는_사이에_바뀌면_읽은_값을_남기지_않는다(self):
        def racing():
            self.calls.append(1)
            if len(self.calls) == 1:
                table_cache.on_notify("notices")                    # 읽는 도중 알림이 왔다
            return {"n": len(self.calls)}
        table_cache.get("t.race", ("notices",), racing)
        self.assertEqual(table_cache.get("t.race", ("notices",), racing), {"n": 2})

    def test_TTL_이_지나면_다시_읽는다(self):
        now = [100.0]
        with mock.patch.object(table_cache, "_clock", side_effect=lambda: now[0]):
            self.get()
            now[0] += table_cache.TTL + 1
            self.get()
        self.assertEqual(len(self.calls), 2)

    def test_다시_붙으면_모두_버린다(self):
        self.get()
        table_cache.reset_all()
        self.get()
        self.assertEqual(len(self.calls), 2)

    def test_듣기_연결이_끊기면_캐시를_쓰지_않는다(self):
        with mock.patch.object(table_cache, "listening", lambda: False), mock.patch.object(table_cache, "enabled", wraps=lambda: False):
            self.get()
            self.get()
        self.assertEqual(len(self.calls), 2)

    def test_돌려준_값을_고쳐도_캐시는_그대로(self):
        self.get()["n"] = 99
        self.assertEqual(self.get(), {"n": 1})

    def test_같은_열쇠는_한_스레드만_읽는다(self):
        gate = threading.Event()

        def slow():
            self.calls.append(1)
            gate.wait(2)
            return {"n": 1}
        ts = [threading.Thread(target=lambda: table_cache.get("t.slow", ("notices",), slow)) for _ in range(4)]
        for t in ts:
            t.start()
        time.sleep(0.2)
        gate.set()
        for t in ts:
            t.join(3)
        self.assertEqual(len(self.calls), 1)


class ReadersTest(CacheOn):
    """감싼 읽기 함수들: 캐시가 켜져 있으면 두 번째 읽기는 DB 에 가지 않는다. 결과는 끈 때와 같다."""

    def test_자리는_캐시가_맞으면_판_번호도_묻지_않는다(self):
        office.set_seat({"pod": "yj", "profile": "sa"}, "me", KNOWN)
        office.seats()                                              # 처음: 읽은 뒤 트리거를 단다(남기지 않음)
        first = office.seats()                                      # 둘째: 읽어서 남긴다
        n = self.count_sql("office_seat_version")
        self.assertEqual(office.seats(), first)
        self.assertEqual(n(), 0)                                    # E4

    def test_방_공지_배치_책상_무시한_크론_같은_값(self):
        office.set_seat({"pod": "yj", "profile": "sa"}, "me", KNOWN)
        office.set_room({"name": "A", "purpose": "p", "seats": ["sa"], "people": ["kim"]}, "me")
        from aas.ops import mutes
        mutes.mute("main", "j1", "job")
        funcs = (office.rooms, office.layout, office.desk_assignments, office.room_places, office.people, mutes.rows, notices.active_rows)
        [f() for f in funcs]                                        # 처음: 읽은 뒤 트리거를 단다(남기지 않음)
        first = [f() for f in funcs]
        n = self.count_sql("SELECT")
        self.assertEqual([f() for f in funcs], first)
        self.assertEqual(n(), 0)

    def test_공지는_끝난_것을_캐시에서도_거른다(self):
        from datetime import timedelta
        at = notices.now()
        notices.save({"kind": "info", "title": "곧 끝남", "body": "", "starts_at": notices._iso(at - timedelta(minutes=5)),
                      "ends_at": notices._iso(at + timedelta(seconds=30)), "audience": "all", "dismissible": True}, "a@x.co", [], at=at)
        self.assertEqual(len(notices.active_rows(at)), 1)
        self.assertEqual(notices.active_rows(at + timedelta(minutes=1)), [])   # 캐시된 줄이어도 끝 시각이 지나면 빠진다


@unittest.skipUnless(PG, "트리거·LISTEN 은 PostgreSQL 에서만")
class PgTriggerTest(CacheOn):
    """H2: 바뀐 행이 있을 때만 알린다. C1: 이 프로세스의 쓰기는 알림 없이 곧바로 반영. E3: 쓰기 트랜잭션 안의 읽기는 남기지 않는다."""

    def listen(self):
        import psycopg
        conn = psycopg.connect(db._backend().conninfo(2), autocommit=True)
        self.addCleanup(conn.close)
        conn.execute(f'LISTEN "{table_cache.channel()}"')
        return lambda: [n.payload for n in conn.notifies(timeout=0.5, stop_after=10)]

    def test_첫_읽기는_읽은_뒤_트리거를_달고_남기지_않는다(self):
        n = self.count_sql("FROM office_people")
        office.people()
        office.people()
        office.people()
        self.assertEqual(n(), 2)                                    # 처음(달기)·둘째(남기기)만 읽는다

    def test_바뀐_행이_있을_때만_알린다(self):
        office.people()                                             # 트리거를 단다
        got = self.listen()
        office.person_touch("kim@x.co", "김")
        self.assertIn("office_people", got())
        office.person_touch("kim@x.co", "김")                       # 이름이 같다 — 0행
        self.assertNotIn("office_people", got())

    def test_이_서버가_쓰면_알림을_기다리지_않고_새_값(self):
        office.set_seat({"pod": "yj", "profile": "sa"}, "me", KNOWN)
        before = office.rooms()
        rid = office.set_room({"name": "새 방", "purpose": "p", "seats": ["sa"], "people": ["kim"]}, "me")["id"]
        self.assertIn(rid, [r["id"] for r in office.rooms()])
        self.assertEqual(len(office.rooms()), len(before) + 1)

    def test_쓰기_트랜잭션_안에서_읽은_값은_롤백_뒤_남지_않는다(self):
        office.people()
        try:
            with store.connect() as conn:
                conn.execute("INSERT INTO office_people (email, name, ts) VALUES ('ghost@x.co', '유령', 't')")
                self.assertIn("ghost@x.co", office.people())
                raise RuntimeError("되돌린다")
        except RuntimeError:
            pass
        self.assertNotIn("ghost@x.co", office.people())


if __name__ == "__main__":
    unittest.main()

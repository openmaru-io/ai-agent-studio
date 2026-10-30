# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""요청 하나 안에서는 같은 DB 읽기를 한 번만(스펙 2026-10-24-006 §6). 오피스 상태 한 번에 DB 질의가 34번이었고, 그중 무시한 크론
목록(cron_muted)을 에이전트마다 9번, 자리·방·배치를 2~3번씩 다시 읽었다. 서버가 DB 와 먼 노드에 뜨면 왕복마다 시간이 늘었다."""
import os
import tempfile
import unittest
from unittest import mock

from aas.common import store
from aas.office import office
from aas.ops import mutes


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

    def reads(self, table: str, fn) -> int:
        """fn 을 부르는 동안 table 을 읽은 SELECT 수."""
        seen, real = [], store.connect

        class Spy:
            def __init__(self, conn):
                self.conn = conn

            def __enter__(self):
                self.conn.__enter__()
                return self

            def __exit__(self, *exc):
                return self.conn.__exit__(*exc)

            def __getattr__(self, name):
                return getattr(self.conn, name)

            def execute(self, sql, *args):
                seen.append(sql)
                return self.conn.execute(sql, *args)
        with mock.patch.object(store, "connect", side_effect=lambda: Spy(real())):
            fn()
        return sum(1 for s in seen if s.lstrip().upper().startswith("SELECT") and f"FROM {table}" in s)


class MemoTest(DataDir):
    def test_범위_밖에서는_부를_때마다_읽는다(self):
        calls = []
        store.memo("k", lambda: calls.append(1) or [1])
        store.memo("k", lambda: calls.append(1) or [1])
        self.assertEqual(len(calls), 2)

    def test_범위_안에서는_한_번만_읽고_돌려받은_값을_고쳐도_번지지_않는다(self):
        calls = []
        with store.request_memo():
            first = store.memo("k", lambda: calls.append(1) or [{"a": 1}])
            first[0]["a"] = 2
            self.assertEqual(store.memo("k", lambda: calls.append(1) or [{"a": 9}]), [{"a": 1}])
        self.assertEqual(len(calls), 1)

    def test_범위가_겹치면_바깥_범위를_그대로_쓰고_나오면_끝난다(self):
        calls = []
        with store.request_memo():
            store.memo("k", lambda: calls.append(1) or 1)
            with store.request_memo():
                store.memo("k", lambda: calls.append(1) or 1)
            store.memo("k", lambda: calls.append(1) or 1)
        store.memo("k", lambda: calls.append(1) or 1)
        self.assertEqual(len(calls), 2)


class OfficeReadsTest(DataDir):
    def setUp(self):
        super().setUp()
        office.set_seat({"pod": "p1", "profile": "main", "alias": "kim"}, "me", {"p1": {"main"}})

    def test_요청_안에서_무시_목록_자리_방_배치를_한_번씩만_읽는다(self):
        def many():
            with store.request_memo():
                for _ in range(3):
                    mutes.rows()
                    office.seats()
                    office.rooms()
                    office.layout()
        self.assertEqual(self.reads("cron_muted", many), 1)
        self.assertEqual(self.reads("office_seat_version", many), 1)
        self.assertEqual(self.reads("office_rooms", many), 1)
        self.assertEqual(self.reads("office_layouts", many), 1)

    def test_범위_밖에서는_바뀐_값을_바로_읽는다(self):
        with store.request_memo():
            self.assertEqual(mutes.rows(), [])
        mutes.mute("main", "j1", "job")
        self.assertEqual([r["job_id"] for r in mutes.rows()], ["j1"])



class WiderMemoTest(DataDir):
    """요청 안 한 번 읽기를 넓힌다(스펙 2026-10-24-009 3-2): 권한 목록·사람 목록·방 구성원·회사 이름, /api/me, 토픽 한 바퀴."""

    def test_권한_사람_방_구성원_회사_이름을_범위_안에서_한_번씩만_읽는다(self):
        import json
        from pathlib import Path
        from aas.common import settings
        from aas.fleet import pods
        reg_file = Path(self.tmp.name) / "pods.json"
        reg_file.write_text(json.dumps({"admins": ["root@x.co"], "pods": [{"id": "p1", "owner": "a@x.co", "hermes_home": self.tmp.name}]}))
        reg = pods.Registry(reg_file)
        settings.reset_cache()
        reg.grants(), office.people(), office.member_rooms("a@x.co")      # 표를 먼저 만든다(엿보기 대역 밖에서 PostgreSQL 첫 준비가 돌게)
        settings.reset_cache()

        def many():
            with store.request_memo():
                for _ in range(3):
                    reg.grants()
                    office.people()
                    office.member_rooms("a@x.co")
                    settings.company_name()
        self.assertEqual(self.reads("access_grants", many), 1)
        self.assertEqual(self.reads("office_people", many), 1)
        self.assertEqual(self.reads("office_room_members", many), 1)
        self.assertLessEqual(self.reads("meta", many), 1)

    def test_방_구성원은_사람마다_따로_기억한다(self):
        office.member_rooms("a@x.co")                                  # 표를 만든다
        with office.connect() as conn:
            conn.execute("INSERT INTO office_room_members (room, email, ts) VALUES (?, ?, ?)", (7, "a@x.co", "t"))
        with store.request_memo():
            self.assertEqual((office.member_rooms("a@x.co"), office.member_rooms("b@x.co")), ({7}, set()))

    def test_토픽_한_바퀴의_구독자별_거르기는_같은_읽기를_한_번만_한다(self):
        import asyncio
        from aas.web import topics
        reads = []

        def view(value, ctx):
            return store.memo("probe", lambda: reads.append(1) or {"n": 1})["n"] + value

        class Sub:
            def __init__(self, i):
                self.ctx = {"user": {"email": f"u{i}@x.co"}}
        hub = topics.Hub(readers=2)
        loop = asyncio.new_event_loop()
        try:
            hub.start(loop)
            topic = topics.Topic("probe", "", topics.Spec(source=lambda: 1, view=view))
            topic.value = 1
            subs = [Sub(i) for i in range(3)]
            topic.subs = {s: None for s in subs}
            loop.run_until_complete(hub._send_views(topic, subs, silent=True))
        finally:
            loop.close()
            hub.pool.shutdown(wait=True)
        self.assertEqual(len(reads), 1)
        self.assertEqual(set(topic.subs.values()), {"2"})


class MeMemoTest(DataDir):
    def test_api_me_는_권한_목록과_사람_목록을_한_번씩만_읽는다(self):
        import http.client
        import sys
        sys.path.insert(0, os.path.dirname(__file__))
        import aasserver
        import json
        from pathlib import Path
        from aas.fleet import pods
        from aas.web import server
        reg_file = Path(self.tmp.name) / "pods.json"
        (Path(self.tmp.name) / "h" / "profiles").mkdir(parents=True)
        reg_file.write_text(json.dumps({"admins": [], "pods": [{"id": "p1", "owner": "a@x.co", "hermes_home": str(Path(self.tmp.name) / "h")}]}))
        old_reg = server._registry
        server._registry = pods.Registry(reg_file)                    # 주인 이메일이 있는 작업공간 — 주인 이름을 사람 목록에서 찾는다
        self.addCleanup(setattr, server, "_registry", old_reg)
        app = aasserver.start()
        try:
            def get():
                c = http.client.HTTPConnection("127.0.0.1", app.server_port, timeout=10)
                c.request("GET", "/api/me")
                r = c.getresponse()
                r.read()
                c.close()
                self.assertEqual(r.status, 200)
            get()                                                       # 표 만들기·캐시 데우기
            self.assertLessEqual(self.reads("office_people", get), 1)
            self.assertLessEqual(self.reads("access_grants", get), 1)
        finally:
            app.shutdown()


class PersonTouchTest(DataDir):
    def test_같은_이름이면_오피스_신호가_사람_표를_고치지_않는다(self):
        """오피스 신호(10초)마다 office_people 에 썼다. ts 를 읽는 곳이 없어 이름이 바뀔 때만 쓴다(스펙 2026-10-24-009 3-4)."""
        def ts():
            with office.connect() as conn:
                return conn.execute("SELECT name, ts FROM office_people WHERE email='a@x.co'").fetchone()
        with mock.patch.object(office, "_now", return_value="t1"):
            office.person_touch("a@x.co", "김")
        with mock.patch.object(office, "_now", return_value="t2"):
            office.person_touch("a@x.co", "김")
            office.person_touch("a@x.co", "")
        self.assertEqual(tuple(ts()), ("김", "t1"))
        with mock.patch.object(office, "_now", return_value="t3"):
            office.person_touch("a@x.co", "김민")
        self.assertEqual(tuple(ts()), ("김민", "t3"))

if __name__ == "__main__":
    unittest.main()

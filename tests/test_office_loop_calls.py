# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""오피스 5초 반복이 에이전트·DB 에 보내는 호출(스펙 2026-10-24-011). OKE 에서 서버 하나가 사이드카에 에이전트당 초당 약 1번(stat 64%),
DB 에 초당 11.5문장을 보냈고 서버 2개가 각자 돌았다."""
import os
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

from aas.common import store
from aas.hermes import hermes_reader as hr
from aas.office import office, office_state
from aas.web import server

try:
    from tests.test_aas import make_home
except ImportError:
    from test_aas import make_home


class DataDir(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.old = os.environ.get("AAS_DATA_DIR")
        os.environ["AAS_DATA_DIR"] = str(Path(self.tmp.name) / "data")
        self.home = make_home(Path(self.tmp.name))

    def tearDown(self):
        if self.old is None:
            os.environ.pop("AAS_DATA_DIR", None)
        else:
            os.environ["AAS_DATA_DIR"] = self.old
        self.tmp.cleanup()


class ExecutionsWithoutFileCheckTest(DataDir):
    def test_파일_있음_확인_없이_읽고_지워진_DB_는_DB_없음으로_본다(self):
        profs = [p for p in hr.profiles(self.home) if (p.path / "cron" / "executions.db").is_file()]
        self.assertTrue(profs)
        (profs[0].path / "cron" / "executions.db").unlink()               # 구성을 기억한 뒤 지워졌다
        out = hr.read_executions_many(profs, check_files=False)
        self.assertEqual(out[profs[0].name].status, "no_db")


class RunningProfilesTest(DataDir):
    def setUp(self):
        super().setUp()
        self.pod = SimpleNamespace(id="loop-p1", hermes_home=self.home, owner="kim@x.com")
        self.addCleanup(lambda: server._forget(self.pod, notify=False))

    def test_프로파일_구성은_기억하고_실행_기록만_다시_읽는다(self):
        real = hr.profiles
        with mock.patch.object(server.cron_health.hr, "profiles", side_effect=real) as profiles:
            server._running_profiles(self.pod)
            with server._lock:
                for k in [k for k in server._cache if k.startswith("loop-p1:running")]:
                    server._cache.pop(k)                                   # 「일하는 중」 캐시가 끝났다
            server._running_profiles(self.pod)
            self.assertEqual(profiles.call_count, 1)                      # 폴더·파일 있음은 다시 묻지 않는다
            server._forget(self.pod, notify=False)                         # AAS 가 이 에이전트를 고쳤다
            server._running_profiles(self.pod)
            self.assertEqual(profiles.call_count, 2)

    def test_일하는_중_캐시는_10초(self):
        self.assertEqual(server.RUNNING_TTL, 10)


class CardRunningTest(DataDir):
    def test_반복_한_번_안에서_진행_카드는_한_번만_묻는다(self):
        from aas.office import hub_auto
        with hub_auto._db() as conn:
            conn.execute("DELETE FROM office_cards")
            for pod, who in (("p1", "kim"), ("p2", "lee")):
                conn.execute("INSERT INTO office_cards (board, task_id, pod, status, assignee, title) VALUES ('b', ?, ?, 'running', ?, 't')", (pod + who, pod, who))
        seats = [{"alias": "kim", "pod": "p1", "profile": "main", "enabled": True}, {"alias": "lee", "pod": "p2", "profile": "ops", "enabled": True}]
        calls = []
        real = server._running_cards_read

        def count():
            calls.append(1)
            return real()
        with mock.patch.object(office, "seats", return_value=seats), mock.patch.object(server, "_running_cards_read", side_effect=count):
            with store.request_memo():
                got = [server._card_running(SimpleNamespace(id=p)) for p in ("p1", "p2", "p3")]
        self.assertEqual(got, [{"main"}, {"ops"}, set()])
        self.assertEqual(len(calls), 1)


class LeaderOnlyLoopTest(DataDir):
    """5초 반복: 모든 서버가 자기가 맡은 에이전트의 재료만 읽어 적고, 자리 맞추기·상태 계산·중계는 리더만(스펙 2026-10-24-013 R11,
    2026-10-24-011 R3 의 「사이드카를 겹쳐 읽지 않는다」를 서버 수만큼 나눠 지킨다)."""

    def test_리더가_아니면_내_몫_재료만_적는다(self):
        with mock.patch.object(server.leader, "is_leader", return_value=False), mock.patch.object(server, "_collect_mine") as mine, \
                mock.patch.object(server, "_office_space") as space, mock.patch.object(server, "_office_snapshot") as snap:
            self.assertFalse(server._office_tick())
        mine.assert_called_once()
        space.assert_not_called()
        snap.assert_not_called()

    def test_리더는_자리를_맞추고_상태는_같은_읽기_한_번_범위에서_계산한다(self):
        server._office_space_state.update({"last_t": 0.0, "pod_hash": "", "leader_was": False, "triggered": False})
        seen = []
        with mock.patch.object(server.leader, "is_leader", return_value=True), mock.patch.object(server, "_office_space"), \
                mock.patch.object(server, "_collect_mine"), \
                mock.patch.object(server, "_office_snapshot", side_effect=lambda reg: seen.append(store._MEMO.get() is not None)), \
                mock.patch.object(server, "registry", return_value=SimpleNamespace(pods=[])):
            self.assertTrue(server._office_tick())
        self.assertEqual(seen, [True])                                        # 같은 읽기 한 번 범위 안

    def test_자리맞춤은_매_틱이_아니라_60초_주기_또는_변경시에만_돌린다(self):
        server._office_space_state.update({"last_t": 0.0, "pod_hash": "", "leader_was": False, "triggered": False})
        now = [100.0]
        reg = SimpleNamespace(pods=[SimpleNamespace(id="p1", owner="kim@x.com")])
        with mock.patch.object(server.leader, "is_leader", return_value=True), \
                mock.patch.object(server, "_collect_mine"), \
                mock.patch.object(server, "_office_snapshot"), \
                mock.patch.object(server, "registry", return_value=reg), \
                mock.patch.object(server.time, "time", lambda: now[0]), \
                mock.patch.object(server, "_office_space") as space:
            # 1. 새 리더 선출 직후: 1회 실행
            self.assertTrue(server._office_tick())
            self.assertEqual(space.call_count, 1)

            # 2. 5초 뒤: 변화 없으므로 실행 안 됨
            now[0] += 5.0
            self.assertTrue(server._office_tick())
            self.assertEqual(space.call_count, 1)

            # 3. 비-리더 변경 트리거(_notify_desks 또는 desks 알림 수신): 즉시 실행
            server._shared_notified("desks")
            self.assertTrue(server._office_tick())
            self.assertEqual(space.call_count, 2)

            # 4. 5초 뒤: 트리거 소비 후 변화 없으므로 실행 안 됨
            now[0] += 5.0
            self.assertTrue(server._office_tick())
            self.assertEqual(space.call_count, 2)

            # 5. 파드 목록 변경: 즉시 실행
            reg.pods = [SimpleNamespace(id="p1", owner="kim@x.com"), SimpleNamespace(id="p2", owner="lee@x.com")]
            self.assertTrue(server._office_tick())
            self.assertEqual(space.call_count, 3)

            # 6. 60초 경과: 정기 실행
            now[0] += 61.0
            self.assertTrue(server._office_tick())
            self.assertEqual(space.call_count, 4)


class SharedCollectedTest(DataDir):
    def snap(self, rows):
        reg = SimpleNamespace(pods=[SimpleNamespace(id="p1", owner="kim@x.com")])
        seats = [{"alias": "kim", "pod": "p1", "profile": "main", "enabled": True}]
        with mock.patch.object(office, "seats", return_value=seats), \
                mock.patch.object(server.SHARED, "get_collected_pods", return_value=rows), \
                mock.patch.object(server, "_health", return_value={"failed_jobs": []}) as health, \
                mock.patch.object(server, "_running_profiles", return_value={"main"}) as running:
            out = server._office_snapshot(reg)
        return out, health.call_count, running.call_count

    def test_담당_서버가_적은_줄이_있으면_사이드카를_읽지_않는다(self):
        out, health, running = self.snap({"p1": (set(), {("p1", "main")}, False)})
        self.assertEqual((health, running), (0, 0))
        self.assertEqual(out["agents"][0]["status"], "working")

    def test_줄이_없으면_직접_계산한다(self):
        _out, health, running = self.snap({})
        self.assertEqual((health, running), (1, 1))

    def test_서버가_하나면_모든_에이전트를_읽어_적는다(self):
        server._collect_state.clear()
        reg = SimpleNamespace(pods=[SimpleNamespace(id="p1", owner="kim@x.com")])
        seats = [{"alias": "kim", "pod": "p1", "profile": "main", "enabled": True}]
        with mock.patch.object(office, "seats", return_value=seats), \
                mock.patch.object(server.SHARED, "alive_servers", return_value=[server.SHARED.origin]), \
                mock.patch.object(server.SHARED, "put_collected_pods") as put, \
                mock.patch.object(server, "_health", return_value={"failed_jobs": []}), \
                mock.patch.object(server, "_running_profiles", return_value={"main"}):
            server._collect_mine(reg)
        self.assertEqual(put.call_args[0][0], {"p1": (set(), {("p1", "main")}, False)})

    def test_에이전트_상태가_같으면_DB_쓰기를_생략하고_10초_후_생존_갱신한다(self):
        server._collect_state.clear()
        now = [100.0]
        reg = SimpleNamespace(pods=[SimpleNamespace(id="p1", owner="kim@x.com")])
        seats = [{"alias": "kim", "pod": "p1", "profile": "main", "enabled": True}]
        with mock.patch.object(office, "seats", return_value=seats), \
                mock.patch.object(server.SHARED, "alive_servers", return_value=[server.SHARED.origin]), \
                mock.patch.object(server.SHARED, "put_collected_pods") as put, \
                mock.patch.object(server, "_health", return_value={"failed_jobs": []}), \
                mock.patch.object(server, "_running_profiles", return_value={"main"}), \
                mock.patch.object(server.time, "time", lambda: now[0]):
            # 1. 첫 수집: 쓰기 발생
            server._collect_mine(reg)
            self.assertEqual(put.call_count, 1)

            # 2. 5초 뒤: 상태 동일하므로 쓰기 생략
            now[0] += 5.0
            server._collect_mine(reg)
            self.assertEqual(put.call_count, 1)

            # 3. 10초 경과: 생존 갱신을 위해 다시 쓰기
            now[0] += 5.1
            server._collect_mine(reg)
            self.assertEqual(put.call_count, 2)

    def test_put_collected_pods_단일_배치_실행_및_빈_목록_방어(self):
        with mock.patch.object(server.shared, "_connect") as conn_mock:
            conn = mock.Mock()
            conn_mock.return_value.__enter__.return_value = conn
            # 빈 목록이면 아무 execute 도 안 함
            server.SHARED.put_collected_pods({})
            conn.execute.assert_not_called()

            # 2개 에이전트여도 execute 1회만 단일 문장으로 실행
            server.SHARED.put_collected_pods({
                "p1": (set(), set(), False),
                "p2": (set(), set(), False),
            })
            self.assertEqual(conn.execute.call_count, 1)
            sql = conn.execute.call_args[0][0]
            self.assertIn("office_collected_pod", sql)
            self.assertIn("ON CONFLICT", sql)

    def test_COLLECTED_MAX_AGE는_60초다(self):
        self.assertEqual(server.COLLECTED_MAX_AGE, 60.0)


class RemoteStatusTest(unittest.TestCase):
    def test_건너온_상태를_기억해_같은_변화를_다시_내지_않는다(self):
        bus = office_state.OfficeBus()
        t = office_state.StateTracker(bus)
        t.update([{"alias": "kim", "pod": "p1", "profile": "main", "status": "idle"}])
        t.apply_remote("agent.status", {"alias": "kim", "status": "working"})
        t.apply_remote("seat.added", {"alias": "lee", "status": "idle"})
        t.update([{"alias": "kim", "pod": "p1", "profile": "main", "status": "working"}, {"alias": "lee", "pod": "p2", "profile": "ops", "status": "idle"}])
        self.assertEqual([e["type"] for e in bus.after(0, wait=0)], [])


if __name__ == "__main__":
    unittest.main()

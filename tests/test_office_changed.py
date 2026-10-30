# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""오피스 정보 변경 번호와 신호 토픽 office:changed(스펙 2026-10-26-001 §4-1, 시험 T1~T4a).

폐기한 2026-10-25-002 는 사용자 없이 만든 스냅샷을 공개 이벤트로 보냈다. 여기서는 번호 둘 {n, admin} 만 보내고, 화면은 번호가
바뀌면 자기 권한으로 /api/office 를 다시 읽는다."""
import os
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

from aas.common import cache_epoch, settings
from aas.office import office, office_access, office_changed, shared
from aas.web import server, ws


class DataDir(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.old = os.environ.get("AAS_DATA_DIR")
        os.environ["AAS_DATA_DIR"] = str(Path(self.tmp.name) / "data")
        settings.reset_cache()
        self.after = mock.patch.object(office_changed, "after", mock.Mock())
        self.woke = self.after.start()
        self.addCleanup(self.after.stop)

    def tearDown(self):
        if self.old is None:
            os.environ.pop("AAS_DATA_DIR", None)
        else:
            os.environ["AAS_DATA_DIR"] = self.old
        settings.reset_cache()
        self.tmp.cleanup()


class CountersTest(DataDir):
    def test_관리자에게만_보이는_종류만_바뀌면_admin_번호만_오른다(self):
        office_changed.bump("pins", "problems")
        self.assertEqual(office_changed.value(), {"n": 0, "admin": 1})
        office_changed.bump("departments", "rooms", "banners")          # 하나라도 모두에게 보이는 종류가 있으면 n
        self.assertEqual(office_changed.value(), {"n": 1, "admin": 1})

    def test_올리면_이_서버의_토픽을_다시_읽게_한다(self):
        office_changed.bump("rooms")
        self.woke.assert_called_once()

    def test_모르는_종류는_거절한다(self):
        with self.assertRaises(ValueError):
            office_changed.bump("snapshot")

    def test_토픽_값은_번호뿐이고_모두에게_같다(self):
        """T2: 사람별 값이 없다. 공개 이벤트(PUBLIC_EVENTS)를 늘리지 않는다."""
        office_changed.bump("seats")
        spec = ws.resolve("office:changed")
        self.assertIsNone(spec.view)
        self.assertEqual(set(spec.source()), {"n", "admin"})
        self.assertNotIn("office.changed", office_access.PUBLIC_EVENTS)
        self.assertNotIn("snapshot", office_access.PUBLIC_EVENTS)

    def test_다른_서버의_알림을_받으면_신호_토픽을_다시_읽는다(self):
        """T3: 알림 종류 office_changed 는 보낸 서버 자신도 받는다(다시 읽기 한 번 더여도 같다)."""
        self.assertEqual(shared.parse_notify("office_changed", "me"), "office_changed")
        with mock.patch.object(server.topics, "invalidate") as inv:
            server._shared_notified("office_changed")
        inv.assert_called_once_with("office:changed", exact=True)


class Reg:
    pods = [SimpleNamespace(id="yj", owner="me@x.com", hermes_home=Path("/nonexistent"))]


class ActionsTest(DataDir):
    """T1: 바꾸는 곳마다 어느 번호가 오르는지 표로 검사한다. 실패하면 오르지 않는다."""

    def setUp(self):
        super().setUp()
        with office.connect() as conn:
            for t in ("office_seats", "office_rooms"):
                conn.execute(f"DELETE FROM {t}")

    def act(self, body):
        with mock.patch.object(server, "_notify_desks"):
            return server._office_action(Reg, body, "me@x.com")

    def test_방을_만들고_지우면_n_이_오른다(self):
        out = self.act({"action": "room.set", "name": "새 TFT"})
        self.assertEqual(office_changed.value()["n"], 1)
        self.act({"action": "room.delete", "id": out["id"]})
        self.assertEqual(office_changed.value()["n"], 2)

    def test_방_만들기가_실패하면_번호가_오르지_않는다(self):
        with self.assertRaises(office.OfficeError):
            self.act({"action": "room.set", "name": ""})
        self.assertEqual(office_changed.value(), {"n": 0, "admin": 0})

    def test_핀은_admin_번호만_올린다(self):
        self.act({"action": "pin.set", "key": "hermes", "value": "v1"})
        self.assertEqual(office_changed.value(), {"n": 0, "admin": 1})

    def test_보기_범위가_바뀌면_n_이_오른다(self):
        """자리 팀·접근 권한·주인 변경은 모두 _scene_scope_changed 를 거친다."""
        server._scene_scope_changed()
        self.assertEqual(office_changed.value()["n"], 1)


class DepartmentsTest(DataDir):
    def setUp(self):
        super().setUp()
        self.hook = mock.Mock()
        patcher = mock.patch.object(settings, "changed_hook", self.hook)
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_사람_부서가_실제로_바뀔_때만_알린다(self):
        """로그인마다 같은 부서로 부르므로 바뀌지 않으면 알리지 않는다(외부 검토 M3)."""
        self.assertTrue(settings.set_department("kim@x.com", "개발팀"))
        self.assertFalse(settings.set_department("kim@x.com", "개발팀"))
        self.hook.assert_called_once_with("rooms", "banners", "departments")

    def test_부서를_만들거나_지우거나_목표를_바꾸면_알린다(self):
        settings.create_department("영업팀")
        self.hook.assert_called_with("departments")
        settings.set_goal("영업팀", "올해 목표")
        self.hook.assert_called_with("banners")
        settings.delete_department("영업팀")
        self.hook.assert_called_with("departments", "rooms", "banners")

    def test_다른_서버가_부서를_바꾸면_다음_읽기가_새_목록을_준다(self):
        """T3a: 부서 캐시는 프로세스마다 30초다. cache_epoch 로 다른 서버가 바꾼 것을 알면 캐시를 버린다(외부 검토 H1)."""
        settings.create_department("영업팀")
        self.assertEqual([r["name"] for r in settings.department_rows()], ["영업팀"])
        with settings.store.connect() as conn:                       # 다른 서버가 쓴 것처럼 DB 만 바꾼다
            conn.execute("INSERT INTO departments (team_key, name, by, ts) VALUES ('개발팀', '개발팀', 'other', '')")
        self.assertEqual([r["name"] for r in settings.department_rows()], ["영업팀"])      # 아직 캐시
        with mock.patch.object(cache_epoch, "changed", lambda prefix: prefix == settings.DEPT_EPOCH):
            names = [r["name"] for r in settings.department_rows()]
        self.assertEqual(sorted(names), ["개발팀", "영업팀"])


class ChecksTest(DataDir):
    """T4: 문제 띠는 점검 함수가 전후를 (대상, 수준)으로 비교해 알린다. 리더 반복은 문제 띠를 읽지 않는다."""

    def setUp(self):
        super().setUp()
        with office.connect() as conn:
            for t in ("office_seats", "office_checks"):
                conn.execute(f"DELETE FROM {t}")
            conn.execute("INSERT INTO office_seats (alias, pod, profile, enabled, by, ts) VALUES ('a', 'p1', 'default', 1, 'me', '')")
        self.pods = [SimpleNamespace(id="p1", dashboard_url="http://p1")]

    def test_같은_결과면_알리지_않고_닿지_않게_되면_한_번_알린다(self):
        with mock.patch.object(office, "_probe", return_value=("ok", "v1", "")):
            office.run_checks(self.pods)
        self.assertEqual(office_changed.value()["admin"], 0)            # 처음 ok — 띠가 없던 대로
        with mock.patch.object(office, "_probe", return_value=("down", "", "URLError")):
            office.run_checks(self.pods)
        self.assertEqual(office_changed.value(), {"n": 0, "admin": 1})
        with mock.patch.object(office, "_probe", return_value=("down", "", "timeout")):
            office.run_checks(self.pods)                                 # 상세만 다르고 같은 (대상, 수준)
        self.assertEqual(office_changed.value()["admin"], 1)

    def test_다시_보기에서_살아나면_알린다(self):
        with mock.patch.object(office, "_probe", return_value=("down", "", "URLError")):
            office.run_checks(self.pods)
        office._rechecked.clear()
        with mock.patch.object(office, "_probe", return_value=("ok", "v1", "")):
            office.recheck_failed(self.pods)
        self.assertEqual(office_changed.value()["admin"], 2)


class PodsTest(DataDir):
    """T4a: 리더 반복이 작업공간 목록 변화를 알린다. 새 리더의 첫 반복은 바탕만 잡는다(외부 검토 M6)."""

    def test_새_리더의_첫_반복은_알리지_않고_목록이_바뀌면_한_번_알린다(self):
        server._office_space_state.update({"last_t": 0.0, "pod_hash": "", "leader_was": False, "triggered": False, "pods_seen": ""})
        reg = SimpleNamespace(pods=[SimpleNamespace(id="p1", owner="kim@x.com")])
        with mock.patch.object(server.leader, "is_leader", return_value=True), mock.patch.object(server, "_collect_mine"), \
                mock.patch.object(server, "_office_snapshot"), mock.patch.object(server, "_office_space"), \
                mock.patch.object(server, "registry", return_value=reg):
            server._office_tick()
            server._office_tick()
            self.assertEqual(office_changed.value()["n"], 0)
            reg.pods = reg.pods + [SimpleNamespace(id="p2", owner="lee@x.com")]
            server._office_tick()
            self.assertEqual(office_changed.value()["n"], 1)
            server._office_tick()
            self.assertEqual(office_changed.value()["n"], 1)

    def test_리더가_바뀐_첫_반복도_알리지_않는다(self):
        server._office_space_state.update({"last_t": 0.0, "pod_hash": "", "leader_was": False, "triggered": False, "pods_seen": "옛 리더 때 값"})
        reg = SimpleNamespace(pods=[SimpleNamespace(id="p1", owner="kim@x.com")])
        with mock.patch.object(server.leader, "is_leader", return_value=True), mock.patch.object(server, "_collect_mine"), \
                mock.patch.object(server, "_office_snapshot"), mock.patch.object(server, "_office_space"), \
                mock.patch.object(server, "registry", return_value=reg):
            server._office_tick()
        self.assertEqual(office_changed.value()["n"], 0)


if __name__ == "__main__":
    unittest.main()

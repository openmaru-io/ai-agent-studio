# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""서버 복제본 사이 캐시 세대 공유 시험(OMAI-1287). 다른 복제본은 같은 DB 의 meta 표를 직접 고쳐 흉내 낸다."""
import os
import tempfile
import types
import unittest
from pathlib import Path
from unittest import mock

TMP = tempfile.TemporaryDirectory()
os.environ.setdefault("AAS_DATA_DIR", str(Path(TMP.name) / "data"))

from aas.common import cache_epoch, store  # noqa: E402
from aas.web import server  # noqa: E402


def other_replica_bumps(prefix: str, notify: bool = True) -> None:
    """다른 서버 프로세스가 바꾸는 요청을 받아 토큰을 새로 쓴 것."""
    with store.connect() as conn:
        conn.execute("INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                     (cache_epoch.KEY + prefix, f"other-{os.urandom(4).hex()}"))
    if notify:
        cache_epoch.on_notify(prefix)


class EpochTestBase(unittest.TestCase):
    def setUp(self):
        with store.connect() as conn:
            conn.execute("DELETE FROM meta WHERE key LIKE ?", (cache_epoch.KEY + "%",))
        cache_epoch.reset_for_test()
        server._cache.clear()
        server._generation.clear()
        self.enabled = mock.patch.object(cache_epoch, "enabled", return_value=True)
        self.poll = mock.patch.object(cache_epoch, "POLL", 0.0)
        self.enabled.start()
        self.poll.start()

    def tearDown(self):
        self.poll.stop()
        self.enabled.stop()
        cache_epoch.reset_for_test()
        server._cache.clear()
        server._generation.clear()


class ChangedTest(EpochTestBase):
    def test_a_token_written_by_another_replica_is_seen_once(self):
        cache_epoch.changed("p1")                                  # 처음 본다: 기록만
        other_replica_bumps("p1")
        self.assertTrue(cache_epoch.changed("p1"))
        self.assertFalse(cache_epoch.changed("p1"))                # 같은 토큰은 한 번만 알린다

    def test_first_sight_of_a_prefix_is_not_a_change(self):
        other_replica_bumps("p1")                                  # 서버를 막 띄웠을 때 이미 토큰이 있다 — 캐시가 비어 있어 버릴 것이 없다
        self.assertFalse(cache_epoch.changed("p1"))

    def test_own_bump_is_not_reported_back(self):
        cache_epoch.changed("p1")
        cache_epoch.bump("p1")
        self.assertFalse(cache_epoch.changed("p1"))

    def test_another_replicas_notify_right_after_own_bump_is_kept(self):
        # 자기 알림을 시각(1초)으로 가려 바로 뒤 다른 서버의 알림까지 버렸다(OMAI-1477 검토) — 보낸 서버로 가린다
        cache_epoch.changed("p1")
        cache_epoch.bump("p1")
        cache_epoch.on_notify(f"{cache_epoch.ORIGIN}|p1")          # 내가 보낸 알림이 돌아왔다
        self.assertFalse(cache_epoch.changed("p1"))
        cache_epoch.on_notify("other-origin|p1")                    # 0.5초 뒤 다른 서버가 같은 접두사를 바꿨다
        self.assertTrue(cache_epoch.changed("p1"))

    def test_notify_payload_keeps_colons_in_the_prefix(self):
        cache_epoch.changed("settings:company")
        cache_epoch.on_notify("other-origin|settings:company")
        self.assertTrue(cache_epoch.changed("settings:company"))

    def test_other_prefixes_are_independent(self):
        cache_epoch.changed("p1")
        cache_epoch.changed("p2")
        other_replica_bumps("p1")
        self.assertTrue(cache_epoch.changed("p1"))
        self.assertFalse(cache_epoch.changed("p2"))

    def test_평상시_changed는_DB_조회를_하지_않고_sync때만_읽는다(self):
        cache_epoch.sync()                                        # Cold start 동기화
        with mock.patch.object(cache_epoch, "_read", wraps=cache_epoch._read) as read:
            cache_epoch.changed("p1")
            cache_epoch.changed("p1")
            cache_epoch.changed("p2")
            self.assertEqual(read.call_count, 0)                  # 평상시 DB 조회 0건 (LISTEN/NOTIFY 기반)
            cache_epoch.sync()
            self.assertEqual(read.call_count, 1)                  # 재연결 복구 시 1회 일괄 조회

    def test_재연결_복구_시_알림_놓친_변경을_sync_로_감지한다(self):
        cache_epoch.sync()                                        # Cold start
        self.assertFalse(cache_epoch.changed("p1"))
        other_replica_bumps("p1", notify=False)                   # 끊긴 동안의 알림 유실 시뮬레이션
        self.assertFalse(cache_epoch.changed("p1"))               # sync 전엔 메모리 조회만 하므로 거짓
        cache_epoch.sync()                                        # 재연결 시 일괄 동기화(D3)
        self.assertTrue(cache_epoch.changed("p1"))                # 변경 감지
        self.assertFalse(cache_epoch.changed("p1"))               # 한 번만 참

    def test_disabled_or_failing_db_means_no_change(self):
        with mock.patch.object(cache_epoch, "enabled", return_value=False):
            cache_epoch.bump("p1")
            other_replica_bumps("p1")
            self.assertFalse(cache_epoch.changed("p1"))
        cache_epoch.changed("p1")
        other_replica_bumps("p1")
        with mock.patch.object(cache_epoch, "_read", side_effect=OSError("db down")):
            cache_epoch.sync()                                     # 오류가 화면을 막지 않는다
        with mock.patch.object(store, "connect", side_effect=OSError("db down")):
            cache_epoch.bump("p1")                                 # 쓰기 오류도 삼킨다


class ServerCacheTest(EpochTestBase):
    def test_another_replicas_write_makes_this_replica_rebuild_before_the_ttl(self):
        calls = []
        make = lambda: calls.append(1) or f"v{len(calls)}"
        self.assertEqual(server._cached("p1:skills", 300, make), "v1")
        self.assertEqual(server._cached("p1:skills", 300, make), "v1")        # 그냥은 캐시를 쓴다
        other_replica_bumps("p1")
        self.assertEqual(server._cached("p1:skills", 300, make), "v2")        # 다른 복제본이 바꿨다 — 바로 다시 만든다(전에는 옛 값을 줬다)

    def test_own_write_through_forget_does_not_drop_the_fresh_value_again(self):
        calls = []
        make = lambda: calls.append(1) or f"v{len(calls)}"
        server._cached("p1:skills", 300, make)
        server._forget(types.SimpleNamespace(id="p1", hermes_home=None))
        self.assertEqual(server._cached("p1:skills", 300, make), "v2")
        self.assertEqual(server._cached("p1:skills", 300, make), "v2")        # 자기 토큰으로는 두 번 버리지 않는다

    def test_other_pods_and_the_flow_graph_are_kept(self):
        calls = []
        server._cached("p1:skills", 300, lambda: calls.append("s") or 1)
        server._cached("p2:skills", 300, lambda: calls.append("o") or 1)
        server._cached("p1:flow", 900, lambda: calls.append("f") or 1, per_lang=False)
        other_replica_bumps("p1")
        server._cached("p1:skills", 300, lambda: calls.append("s") or 2)
        server._cached("p2:skills", 300, lambda: calls.append("o") or 2)
        server._cached("p1:flow", 900, lambda: calls.append("f") or 2, per_lang=False)
        self.assertEqual(calls, ["s", "o", "f", "s"])                         # p1 의 skills 만 다시, p2 와 flow 는 그대로

    def test_a_value_being_built_while_another_replica_writes_is_not_stored(self):
        def slow():
            other_replica_bumps("p1")                                         # 만드는 사이에 다른 복제본이 썼다
            server._cached("p1:probe", 300, lambda: "x")                      # 이 호출이 변화를 본다
            return "stale-build"
        server._cached("p1:skills", 300, slow)
        self.assertNotIn("p1:skills", server._cache)                          # 옛 값이 캐시에 앉지 않는다

    def test_first_start_with_an_existing_token_keeps_nothing_to_drop(self):
        other_replica_bumps("p1")
        calls = []
        server._cached("p1:skills", 300, lambda: calls.append(1) or "v")
        server._cached("p1:skills", 300, lambda: calls.append(1) or "v")
        self.assertEqual(len(calls), 1)

    def test_drop_helper_writes_the_signal_after_the_local_drop(self):
        server._cached("p1:skills", 300, lambda: "v")
        backend = mock.Mock()
        pod = types.SimpleNamespace(id="p1", hermes_home=types.SimpleNamespace(backend=backend))
        with mock.patch.object(cache_epoch, "bump") as bump:
            server._drop_pod_key(pod, "skills")
        bump.assert_called_once_with("p1")
        self.assertNotIn("p1:skills", server._cache)

    def test_drop_helper_also_drops_the_sidecar_tree_cache_of_the_writer(self):
        # OKE 에서 스킬을 올린 복제본만 목록이 최대 60초 옛 값이었다 — 키만 버리면 다시 만들 때 사이드카의 폴더 묶음(TREE_TTL 60초)을 그대로 읽는다
        backend = mock.Mock()
        pod = types.SimpleNamespace(id="p1", hermes_home=types.SimpleNamespace(backend=backend))
        server._drop_pod_key(pod, "skills")
        backend.invalidate.assert_called_once_with()


if __name__ == "__main__":
    unittest.main()

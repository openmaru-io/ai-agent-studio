# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""PostgreSQL 문장 수 줄이기 남은 항목(스펙 2026-10-26-002 R8·R11·R13·R15)."""
import hashlib
import os
import time
import unittest
from pathlib import Path
from unittest import mock

from aas.auth import auth
from aas.common import cache_epoch, db, store, table_cache
from aas.office import presence, shared
from aas.web import server, topics, ws

try:
    from tests.test_db_tps_phase1 import DataDir
    from tests.test_table_cache import CacheOn
except ImportError:                                            # unittest discover -s tests 로 돌릴 때
    from test_db_tps_phase1 import DataDir
    from test_table_cache import CacheOn


class MeetingRoomWarmTest(unittest.TestCase):
    """R8: 토픽은 마지막 구독자가 떠난 뒤 5분 더 돈다. 회의방 토픽은 화면을 떠나면 30초만 더 돈다(떠난 뒤 최대 초당 2건)."""

    def drop(self, spec: topics.Spec) -> float:
        hub = topics.Hub()
        key = ("t", "ko")
        sub = type("Sub", (), {})()                            # 구독자 대역(해시되는 객체)
        sub.topics = {key}
        topic = topics.Topic(name="t", lang="ko", spec=spec)
        topic.subs[sub] = ""
        hub.topics[key] = topic
        before = time.monotonic()
        hub._drop(key, sub)
        return topic.warm_until - before

    def test_회의방_토픽은_30초(self):
        self.assertEqual(ws._meeting_spec(1).warm, 30.0)
        self.assertAlmostEqual(self.drop(ws._meeting_spec(1)), 30.0, delta=1.0)

    def test_다른_토픽은_허브_기본값(self):
        self.assertAlmostEqual(self.drop(topics.Spec(source=lambda: None)), topics.Hub().warm, delta=1.0)


class LeaderReadsOneStatementTest(DataDir):
    """R13: 리더 스냅샷이 재료(office_collected_pod)와 일하는 중(office_busy)을 따로 읽었다. PostgreSQL 은 한 문장, SQLite 는 그대로 둘.
    결과는 따로 읽을 때와 같다."""

    def setUp(self):
        super().setUp()
        self.now = [5000.0]
        self.me = shared.Shared(origin="me", clock=lambda: self.now[0])
        self.other = shared.Shared(origin="other", clock=lambda: self.now[0])
        self.dead = shared.Shared(origin="dead", clock=lambda: self.now[0] - 1000)
        for s in (self.me, self.other, self.dead):
            s.heartbeat()
        self.other.set_busy({("p1", "main")})
        self.dead.set_busy({("p2", "ops")})
        self.other.put_collected_pods({"p1": ({("p1", "main")}, set(), False)})
        self.now[0] -= 100
        self.other.put_collected_pods({"p9": (set(), set(), True)})      # 오래된 줄
        self.now[0] += 100

    def test_같은_결과(self):
        self.assertEqual(self.me.get_collected_pods(60), {"p1": ({("p1", "main")}, set(), False)})
        self.assertEqual(self.me.remote_busy(), {("p1", "main")})       # 죽은 서버의 일하는 중은 빠진다

    def test_요청_범위_안에서는_두_표를_한_번에_읽는다(self):
        self.me.alive_servers()                                         # 살아 있는 서버 목록은 5초 기억(R6) — 여기서는 세지 않는다
        n = self.count_sql("SELECT")
        with store.request_memo():
            self.me.get_collected_pods(60)
            self.me.remote_busy()
        self.assertEqual(n(), 1 if db.backend() == "postgres" else 2)


class SessionMemoTest(DataDir):
    """R11: 로그인 세션 줄을 30초 기억한다. 끝낸 세션은 이 서버에서 곧바로, 다른 서버에서는 알림으로 버린다(M3).
    기억한 줄로 끝나 보이면 DB 를 다시 읽는다 — 다른 서버의 touch 가 마감을 밀었을 수 있다(F3)."""

    def setUp(self):
        super().setUp()
        cache_epoch.reset_for_test()
        auth._forget()
        self.addCleanup(auth._forget)
        self.addCleanup(cache_epoch.reset_for_test)
        for target, name in ((auth, "_memo_on"), (cache_epoch, "enabled")):   # 듣기 연결이 붙은 PostgreSQL 서버로 본다
            p = mock.patch.object(target, name, return_value=True)
            p.start()
            self.addCleanup(p.stop)
        self.a = auth.Auth({"hours": 12, "idle_minutes": 120})
        self.token = self.a._new_session("kim@x.co", "김")
        self.cookie = f"{auth.COOKIE}={self.token}"
        self.h = hashlib.sha256(self.token.encode()).hexdigest()

    def sql(self, q, *args):
        with store.connect() as conn:
            conn.execute(q, args)

    def test_두_번째_요청은_세션_표를_읽지_않는다(self):
        self.assertEqual(self.a.user(self.cookie)["email"], "kim@x.co")
        n = self.count_sql("FROM auth_sessions")
        self.assertEqual(self.a.user(self.cookie)["email"], "kim@x.co")
        self.assertEqual(n(), 0)

    def test_로그아웃하면_곧바로_끝난다(self):
        self.a.user(self.cookie)
        self.a.logout(self.cookie)
        self.assertIsNone(self.a.user(self.cookie))

    def test_이메일로_끝내면_곧바로_끝난다(self):
        self.a.user(self.cookie)
        self.a.revoke("kim@x.co")
        self.assertIsNone(self.a.user(self.cookie))

    def test_다른_서버가_끝내면_알림으로_버린다(self):
        self.a.user(self.cookie)
        self.sql("DELETE FROM auth_sessions WHERE hash=?", self.h)      # 다른 서버의 로그아웃
        self.assertIsNotNone(self.a.user(self.cookie))                  # 알림 전에는 기억한 줄(받아들인 위험, 최대 30초)
        cache_epoch.on_notify("other|auth")
        self.assertIsNone(self.a.user(self.cookie))

    def test_기억한_줄로_끝나_보이면_DB_를_다시_읽는다(self):
        self.a.user(self.cookie)
        now = time.time()
        self.sql("UPDATE auth_sessions SET expires=? WHERE hash=?", now + 3 * 3600, self.h)   # 다른 서버의 touch 가 마감을 밀었다
        with mock.patch.object(auth.time, "time", return_value=now + 2 * 3600 + 60):           # 기억한 줄의 유휴 마감(2시간)이 지났다
            got = self.a.user(self.cookie)
        self.assertEqual(got["email"], "kim@x.co")

    def test_touch_는_기억이_아니라_DB_를_읽는다(self):
        self.a.user(self.cookie)
        n = self.count_sql("FROM auth_sessions")
        self.a.touch(self.cookie)
        self.assertGreaterEqual(n(), 1)

    def test_TTL_이_지나면_다시_읽는다(self):
        self.a.user(self.cookie)
        later = time.monotonic() + auth.SESSION_MEMO + 1
        n = self.count_sql("FROM auth_sessions")
        with mock.patch.object(auth.time, "monotonic", return_value=later):
            self.a.user(self.cookie)
        self.assertEqual(n(), 1)

    def test_듣기_연결이_없으면_기억하지_않는다(self):
        with mock.patch.object(auth, "_memo_on", return_value=False):
            self.a.user(self.cookie)
            n = self.count_sql("FROM auth_sessions")
            self.a.user(self.cookie)
        self.assertEqual(n(), 1)


class OfficeIdleTest(DataDir):
    """R15: 오피스에 아무도 없으면(어느 서버든) 재료 수집·리더 스냅샷을 30초마다. 사람이 들어오거나 자리가 바뀌면 바로 한 바퀴(E10).
    판단은 이미 하는 걸음 읽기(changes)의 결과로 한다 — 따로 읽지 않는다."""

    def setUp(self):
        super().setUp()
        self.p = presence.Presence()
        q = mock.patch.object(server, "PRESENCE", self.p)
        q.start()
        self.addCleanup(q.stop)
        server._office_wake.clear()
        self.addCleanup(server._office_wake.clear)

    def test_읽기_전에는_있다고_본다(self):
        self.assertEqual(server._office_every(5.0), 5.0)

    def test_아무도_없으면_30초_있으면_5초(self):
        self.p.changes()
        self.assertEqual(server._office_every(5.0), server.OFFICE_IDLE_EVERY)
        self.p.beat("kim@x.co", "김", "s")
        self.p.changes()
        self.assertEqual(server._office_every(5.0), 5.0)

    def test_판단은_DB_를_더_읽지_않는다(self):
        self.p.changes()
        n = self.count_sql("office_presence")
        server._office_every(5.0)
        self.assertEqual(n(), 0)

    def test_사람이_들어오면_깨운다(self):
        server._shared_read("presence")                          # 바탕(아무도 없음)
        self.assertFalse(server._office_wake.is_set())
        self.p.beat("kim@x.co", "김", "s")
        with mock.patch.object(server.topics, "invalidate"):
            server._shared_read("presence")
        self.assertTrue(server._office_wake.is_set())

    def test_자리가_바뀌면_깨운다(self):
        with mock.patch.object(server.shared, "parse_notify", return_value="desks"), \
                mock.patch.object(server.topics, "invalidate"):
            server._shared_notified("x")                           # 다른 서버가 자리를 바꿨다
        self.assertTrue(server._office_wake.is_set())
        server._office_wake.clear()
        with mock.patch.object(server.shared, "notify"):
            server._notify_desks()                                 # 이 서버가 자리를 바꿨다
        self.assertTrue(server._office_wake.is_set())


class AgentsTopicSettledTest(unittest.TestCase):
    """에이전트 목록 토픽은 준비 중인 에이전트가 있으면 2초마다 쿠버네티스를 다시 읽고 구독자마다 목록을 다시 만든다. 일시 정지된 에이전트
    (phase Suspended)도 준비 중으로 쳐 2초 반복이 끝나지 않았다(OKE 2026-10-26, 에이전트 화면을 연 동안 DB 읽기 초당 약 4.4건)."""

    @staticmethod
    def agent(phase, ready=False, suspended=False):
        return {"name": "a", "phase": phase, "ready": ready, "suspended": suspended}

    def interval(self, *agents):
        return ws._agents_interval({"agents": list(agents)})

    def test_멈춘_에이전트는_준비_중이_아니다(self):
        self.assertEqual(self.interval(self.agent("Suspended", suspended=True), self.agent("Ready", ready=True)), 5.0)

    def test_멈추는_중과_다시_켜는_중은_준비_중이다(self):
        self.assertEqual(self.interval(self.agent("NotReady", suspended=True)), 2.0)       # 멈추라고 했지만 아직 멈추지 않음
        self.assertEqual(self.interval(self.agent("Suspended", suspended=False)), 2.0)     # 다시 켜라고 했지만 아직 멈춘 상태

    def test_실패와_준비됨은_그대로(self):
        self.assertEqual(self.interval(self.agent("Failed")), 5.0)
        self.assertEqual(self.interval(self.agent("Provisioning")), 2.0)

    def test_멈춘_에이전트만_있으면_쿠버네티스를_다시_읽지_않는다(self):
        reg = mock.Mock(agents=[self.agent("Suspended", suspended=True)], error="", rollouts=[])     # 진행 중인 롤아웃도 없다(스펙 2026-10-28-015)
        with mock.patch.object(ws.server, "registry", return_value=reg):
            ws._agents_source()
        reg.refresh.assert_not_called()


class PrimaryStateCachedTest(CacheOn):
    """주 프로파일 기록을 읽기만 하는 곳(is_target·primary_of·hide_root)이 에이전트 하나씩 `pod_primary WHERE pod=?` 를 읽었다.
    에이전트 목록의 프로파일 이름 읽기(30초마다 에이전트마다)가 부르는 루트 숨김 판단이 그 길이라, 에이전트 화면을 연 동안 OKE 에서
    초당 약 0.5건이었다(2026-10-26). 이제 표 캐시(R10)의 records() 에서 꺼낸다. 읽은 값으로 쓰기를 정하는 곳(ensure·adopt)은 DB 를 읽는다."""

    def setUp(self):
        super().setUp()
        from aas.fleet import primary
        self.primary = primary
        with primary._connect() as conn:
            conn.execute("INSERT INTO pod_primary (pod, profile, state, ts) VALUES ('p1', 'main', 'target', 't')")
        primary.records()                                          # 처음: 읽은 뒤 트리거를 단다(남기지 않음)
        primary.records()

    def test_읽기만_하는_곳은_DB_를_읽지_않는다(self):
        n = self.count_sql("FROM pod_primary")
        self.assertTrue(self.primary.is_target("p1"))
        self.assertFalse(self.primary.is_target("p9"))
        self.assertEqual(self.primary.primary_of("p1"), "main")
        self.assertEqual(self.primary.primary_of("p9"), self.primary.ROOT)
        self.assertEqual(self.primary.hide_root("p1", False), "drop")
        self.assertEqual(self.primary.state("p1")["state"], "target")
        self.assertEqual(n(), 0)

    def test_fresh_는_DB_를_읽는다(self):
        n = self.count_sql("FROM pod_primary WHERE pod")
        self.assertEqual(self.primary.state("p1", fresh=True)["profile"], "main")
        self.assertEqual(n(), 1)

    @unittest.skipUnless(db.backend() == "postgres", "이 서버 쓰기의 곧바로 반영(C1)은 PostgreSQL 연결에서 한다")
    def test_이_서버가_바꾸면_곧바로_보인다(self):
        self.primary.set_state("p1", "templated")
        self.assertEqual(self.primary.state("p1")["state"], "templated")

    def test_돌려준_값을_고쳐도_캐시는_그대로(self):
        self.primary.state("p1")["profile"] = "x"
        self.assertEqual(self.primary.state("p1")["profile"], "main")


class RemainingReadsTest(CacheOn):
    """9-11 뒤 남은 상위 읽기(스펙 2026-10-26-002 §9-12): 설정 한 번 맞추기 표시(meta)·자동 올리기 켜짐(meta)·Hermes 판 기록(meta)·
    에이전트 한도(agent_limits)·살아 있는 서버(office_servers)."""

    def test_한_번_맞춘_설정_표시는_다시_묻지_않는다(self):
        with store.connect() as conn:
            conn.execute("INSERT INTO meta (key, value) VALUES ('curator:p1/main', '1')")
        api = mock.Mock()
        pod = type("Pod", (), {"id": "p1"})()
        prow = {"name": "main", "is_default": False}
        self.assertEqual(server._config_once(pod, api, prow, "curator", lambda *_: None, "n", "u"), "")
        n = self.count_sql("FROM meta")
        self.assertEqual(server._config_once(pod, api, prow, "curator", lambda *_: None, "n", "u"), "")
        self.assertEqual(n(), 0)
        api.call.assert_not_called()

    def test_한_번_맞춘_설정_표시_기억은_데이터_폴더마다(self):
        server._config_once_seen_add("curator:p2/main")
        with mock.patch.dict(os.environ, {"AAS_DATA_DIR": str(Path(self.tmp.name) / "other")}):
            self.assertFalse(server._config_once_seen("curator:p2/main"))

    def test_Hermes_판이_같으면_다시_읽지_않는다(self):
        from aas.fleet import primary
        self.assertFalse(primary.pod_version_changed("p1", "1.0"))
        n = self.count_sql("FROM meta")
        self.assertFalse(primary.pod_version_changed("p1", "1.0"))
        self.assertEqual(n(), 0)
        self.assertTrue(primary.pod_version_changed("p1", "1.1"))

    def test_자동_올리기_켜짐은_기억하고_바꾸면_곧바로_다른_서버는_알림으로(self):
        from aas.market import updates
        cache_epoch.reset_for_test()
        self.addCleanup(cache_epoch.reset_for_test)
        with mock.patch.object(cache_epoch, "enabled", return_value=True):
            updates.set_auto(True)
            self.assertTrue(updates.auto_enabled())
            n = self.count_sql("FROM meta")
            self.assertTrue(updates.auto_enabled())
            self.assertEqual(n(), 0)
            updates.set_auto(False)                                     # 이 서버가 바꿈 — 곧바로
            self.assertFalse(updates.auto_enabled())
            with store.connect() as conn:                               # 다른 서버가 바꿈
                conn.execute("UPDATE meta SET value='on' WHERE key=?", (updates.AUTO_KEY,))
            self.assertFalse(updates.auto_enabled())
            cache_epoch.on_notify("other|" + updates.AUTO_EPOCH)
            self.assertTrue(updates.auto_enabled())

    def test_에이전트_한도는_표_캐시로_읽는다(self):
        from aas.fleet import agents
        agents.set_limit("kim@x.co", 5, "admin")
        agents.limits()                                                 # 처음: 읽은 뒤 트리거를 단다(남기지 않음)
        agents.limits()
        n = self.count_sql("agent_limits")
        self.assertEqual(agents.limits(), {"kim@x.co": 5})
        self.assertEqual(agents.limit_for("kim@x.co"), 5)
        self.assertEqual(n(), 0)

    def test_회의는_서버의_살아_있는_서버_기억을_쓴다(self):
        m = server.office_meeting()
        self.assertIs(getattr(m.alive_source, "__self__", None), server.SHARED)
        n = self.count_sql("office_servers")
        with store.connect() as conn:
            got = mock.Mock(return_value={"a", "b"})
            with mock.patch.object(m, "alive_source", got):
                self.assertEqual(m._alive(conn), {"a", "b"})
        self.assertEqual(n(), 0)

    def test_살아_있음_신호는_10초마다_판정은_30초(self):
        self.assertEqual(shared.BEAT_EVERY, 10.0)
        self.assertEqual(shared.ALIVE_MEMO, shared.BEAT_EVERY)
        self.assertGreaterEqual(shared.ALIVE, 3 * shared.BEAT_EVERY)


class SteadyReadsTest(CacheOn):
    """§9-13: 활동과 관계없이 도는 읽기 — 오피스 변경 번호(신호·사람 목록 토픽), 사람 열쇠 비밀 값, 회의 답 기다림 정리의 살아 있는 서버."""

    def test_오피스_변경_번호는_기억하고_올리거나_알림을_받으면_버린다(self):
        from aas.office import office_changed
        office_changed.forget()
        self.addCleanup(office_changed.forget)
        first = office_changed.value()
        n = self.count_sql("FROM meta")
        self.assertEqual(office_changed.value(), first)
        self.assertEqual(n(), 0)
        office_changed.bump("rooms")                                 # 이 서버가 올림 — 곧바로
        self.assertEqual(office_changed.value()["n"], first["n"] + 1)
        with store.connect() as conn:                                # 다른 서버가 올림
            conn.execute("UPDATE meta SET value='99' WHERE key=?", (office_changed.KEY_N,))
        self.assertEqual(office_changed.value()["n"], first["n"] + 1)   # 알림 전에는 기억한 값(아래 시험이 알림을 본다)

    def test_다른_서버_알림이면_오피스_변경_번호를_다시_읽는다(self):
        from aas.office import office_changed
        office_changed.forget()
        self.addCleanup(office_changed.forget)
        office_changed.value()
        with store.connect() as conn:
            conn.execute("INSERT INTO meta (key, value) VALUES (?, '42') ON CONFLICT (key) DO UPDATE SET value='42'", (office_changed.KEY_N,))
        with mock.patch.object(server.shared, "parse_notify", return_value="office_changed"), mock.patch.object(server.topics, "invalidate"):
            server._shared_notified("x")
        self.assertEqual(office_changed.value()["n"], 42)

    def test_사람_열쇠_비밀_값은_한_번만_읽는다(self):
        from aas.office import office
        office._person_secret_forget()
        self.addCleanup(office._person_secret_forget)
        first = office._person_secret()
        n = self.count_sql("office_person_key")
        self.assertEqual(office._person_secret(), first)
        self.assertEqual(n(), 0)

    def test_회의_답_기다림_정리는_살아_있는_서버를_따로_읽지_않는다(self):
        from aas.office import meeting
        n = self.count_sql("FROM office_servers")
        meeting.sweep_lost("me", alive=lambda conn: {"me"})
        self.assertEqual(n(), 0)

    def test_서버는_정리에_SHARED_의_기억을_넘긴다(self):
        with mock.patch.object(server.meeting, "sweep_lost") as sweep:
            server._sweep_meetings()
        self.assertIs(getattr(sweep.call_args.kwargs.get("alive"), "__self__", None), server.SHARED)


class QuietQueuesTest(CacheOn):
    """§9-14: 대기 줄(배달 대기·자동 올리기 시도·회의 답 기다림)은 값을 캐시하지 않는다(옛 값으로 같은 일을 두 번 할 수 있다, R10).
    대신 지난번에 비어 있었고 그 뒤 표가 바뀐 적이 없으면 읽지 않는다. 바뀜은 표 바뀜 트리거(R10)로 알고, TTL 이 지나면 그래도 읽는다."""

    def setUp(self):
        super().setUp()
        from aas.market import updates
        self.updates = updates
        updates.pending()                                          # 표를 만든다
        updates.settle_auto_all([])

    def test_배달_대기_줄이_비었고_바뀌지_않았으면_읽지_않는다(self):
        self.updates.drain([])
        n = self.count_sql("FROM market_update_pending")
        self.updates.drain([])
        self.assertEqual(n(), 0)
        table_cache.on_notify("market_update_pending")             # 다른 서버가 줄을 넣었다
        self.updates.drain([])
        self.assertEqual(n(), 1)

    def test_자동_올리기_시도도_같다(self):
        self.updates.settle_auto_all(["p1"])
        n = self.count_sql("FROM market_update_auto")
        self.updates.settle_auto_all(["p1"])
        self.assertEqual(n(), 0)
        table_cache.on_notify("market_update_auto")
        self.updates.settle_auto_all(["p1"])
        self.assertEqual(n(), 1)

    def test_TTL_이_지나면_비어_있어도_다시_읽는다(self):
        self.updates.drain([])
        now = [table_cache._clock() + table_cache.TTL + 1]
        n = self.count_sql("FROM market_update_pending")
        with mock.patch.object(table_cache, "_clock", side_effect=lambda: now[0]):
            self.updates.drain([])
        self.assertEqual(n(), 1)

    def test_줄이_있으면_매번_읽는다(self):
        with store.connect() as conn:
            conn.execute("INSERT INTO market_update_pending (pod, profile, package, version, on_modified, origin, by, ts) "
                         "VALUES ('gone', 'main', 'ns/x', '1', 'keep', 'manual', 'a', 't')")
        table_cache.on_notify("market_update_pending")
        self.updates.drain([])                                     # 작업공간이 없어 줄은 남는다
        n = self.count_sql("FROM market_update_pending")
        self.updates.drain([])
        self.assertEqual(n(), 1)

    def test_회의_답_기다림_정리도_비었으면_건너뛴다(self):
        from aas.office import meeting
        with meeting._db():                                        # 표를 먼저 만든다 — 없는 표에는 트리거를 달지 못해 60초 뒤 다시 해 본다(R10)
            pass
        meeting.sweep_lost("me", alive=lambda conn: {"me"})
        n = self.count_sql("office_meeting_")
        meeting.sweep_lost("me", alive=lambda conn: {"me"})
        self.assertEqual(n(), 0)
        table_cache.on_notify("office_meeting_pending")
        meeting.sweep_lost("me", alive=lambda conn: {"me"})
        self.assertGreaterEqual(n(), 1)


class SignalTopicsCachedTest(CacheOn):
    """§9-14: 받은편지함 신호(15초, 사람마다)와 진행 카드가 같은 표를 계속 읽었다. 표 캐시(R10)로 읽는다."""

    def test_받은편지함_신호는_두_번째부터_표를_읽지_않는다(self):
        server.office_inbox_signal("kim@x.co")                     # 처음: 읽은 뒤 트리거를 단다(남기지 않음)
        first = server.office_inbox_signal("kim@x.co")
        n = self.count_sql("SELECT")
        self.assertEqual(server.office_inbox_signal("kim@x.co"), first)
        self.assertEqual(n(), 0)

    def test_진행_카드도_표_캐시로(self):
        server._running_cards_read()
        server._running_cards_read()
        n = self.count_sql("FROM office_cards")
        server._running_cards_read()
        self.assertEqual(n(), 0)


class CardSyncWritesOnlyChangesTest(DataDir):
    """§9-14 후속: 칸반 동기화가 바뀌지 않은 카드까지 매번 upsert 했다. PostgreSQL 은 값이 같아도 갱신으로 쳐 표 바뀜 알림이 가고
    이 서버의 쓰기 감지도 캐시를 버려, 카드 표 캐시(받은편지함 신호·진행 카드)가 동기화마다 버려졌다(OKE 2026-10-26)."""

    def setUp(self):
        super().setUp()
        from aas.office import hub_auto
        self.auto = hub_auto.Auto(mock.Mock())
        self.auto.alias_of = lambda pod, profile: profile or ""
        with hub_auto._db() as conn:
            conn.execute("INSERT INTO office_boards (slug, synced, ts) VALUES ('b', 1, 't')")
        self.cards = [("p1", {"id": "t1", "status": "todo", "assignee": "sa", "title": "x"}),
                      ("p1", {"id": "t2", "status": "running", "assignee": "sa", "title": "y"})]

    def test_바뀌지_않은_카드는_쓰지_않는다(self):
        self.assertTrue(self.auto._diff_rows("b", self.cards, {"p1"}))
        n = self.count_sql("INSERT INTO office_cards")
        self.assertFalse(self.auto._diff_rows("b", self.cards, {"p1"}))
        self.assertEqual(n(), 0)

    def test_바뀐_카드만_쓴다(self):
        self.auto._diff_rows("b", self.cards, {"p1"})
        n = self.count_sql("INSERT INTO office_cards")
        changed = [self.cards[0], ("p1", {**self.cards[1][1], "status": "review"})]
        self.assertTrue(self.auto._diff_rows("b", changed, {"p1"}))
        self.assertEqual(n(), 1)
        with store.connect() as conn:
            self.assertEqual(conn.execute("SELECT status FROM office_cards WHERE task_id='t2'").fetchone()[0], "review")


class InboxRestUsesSameCacheTest(CacheOn):
    """§9-14 후속: REST 받은편지함(화면이 30초마다)도 신호 토픽과 같은 표 캐시로 카드·맡긴 사람을 읽는다."""

    def test_REST_받은편지함은_카드_표를_다시_읽지_않는다(self):
        reg = type("Reg", (), {"pods": [], "is_admin": lambda self, u: False})()
        server._office_inbox(reg, {"email": "kim@x.co"})
        server._office_inbox(reg, {"email": "kim@x.co"})
        n = self.count_sql("office_card")
        server._office_inbox(reg, {"email": "kim@x.co"})
        self.assertEqual(n(), 0)


if __name__ == "__main__":
    unittest.main()

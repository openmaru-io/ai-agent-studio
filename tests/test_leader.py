# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""리더 잠금 시험 — 서버 복제본 여러 개 중 하나만 주기 작업을 돌린다(OMAI-1105)."""
import unittest

from aas.common.leader import LOCK_LEADER, Leader


class FakePg:
    """PostgreSQL 한 대 흉내. advisory 잠금은 세션(연결)이 쥐고, 연결이 닫히면 풀린다."""

    def __init__(self):
        self.holder = None


class FakeConn:
    def __init__(self, pg: FakePg):
        self.pg = pg
        self.dead = False
        self.closed = False

    def execute(self, sql, params=()):
        if self.dead or self.closed:
            raise OSError("connection lost")
        if "pg_try_advisory_lock" in sql:
            assert params == (LOCK_LEADER,)
            if self.pg.holder in (None, self):
                self.pg.holder = self
                return _Result(True)
            return _Result(False)
        return _Result(1)

    def close(self):
        self.closed = True
        if self.pg.holder is self:
            self.pg.holder = None


class _Result:
    def __init__(self, value):
        self.value = value

    def fetchone(self):
        return (self.value,)


def leader_on(pg: FakePg, conns: list) -> Leader:
    def connect():
        c = FakeConn(pg)
        conns.append(c)
        return c
    return Leader(connect=connect, backend=lambda: "postgres")


class LeaderTest(unittest.TestCase):
    def test_only_one_of_two_is_leader(self):
        pg, ca, cb = FakePg(), [], []
        a, b = leader_on(pg, ca), leader_on(pg, cb)
        self.assertTrue(a.check_once())
        self.assertFalse(b.check_once())
        self.assertTrue(a.check_once())          # 쥔 쪽은 계속 리더
        self.assertFalse(b.check_once())

    def test_other_takes_over_when_leader_connection_dies(self):
        pg, ca, cb = FakePg(), [], []
        a, b = leader_on(pg, ca), leader_on(pg, cb)
        a.check_once()
        b.check_once()
        ca[-1].dead = True                       # 리더 파드가 죽거나 연결이 끊겼다
        self.assertFalse(a.check_once())         # 끊긴 것을 알면 곧바로 리더를 내려놓는다
        self.assertTrue(ca[-1].closed)
        self.assertTrue(b.check_once())          # PostgreSQL 이 잠금을 풀어 다른 서버가 이어받는다
        self.assertFalse(a.check_once())         # 다시 붙은 옛 리더는 기다린다

    def test_connect_failure_means_not_leader(self):
        def connect():
            raise OSError("refused")
        x = Leader(connect=connect, backend=lambda: "postgres")
        self.assertFalse(x.check_once())

    def test_sqlite_is_always_leader_without_connecting(self):
        def connect():
            raise AssertionError("SQLite 에서는 연결하지 않는다")
        x = Leader(connect=connect, backend=lambda: "sqlite")
        self.assertTrue(x.is_leader())


if __name__ == "__main__":
    unittest.main()

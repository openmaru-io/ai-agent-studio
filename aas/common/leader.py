# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""서버 복제본 여러 개 중 하나만 주기 작업을 돌리게 하는 리더 잠금(OMAI-1105).

부수 효과가 있는 주기 작업(수집 ticker·수명주기·마켓 배포·칸반)은 `is_leader()` 가 참일 때만 돈다.
메모리에만 쓰는 작업(오피스 상태·흐름 그래프 캐시)은 그 서버의 화면이 읽으므로 서버마다 돈다.

- PostgreSQL: 전용 연결 하나가 `pg_try_advisory_lock(LOCK_LEADER)` 를 쥔다. 잠금은 세션 단위라 서버가 죽거나
  연결이 끊기면 PostgreSQL 이 풀고, 다른 서버가 다음 확인(CHECK_EVERY 초)에서 이어받는다. 풀(pool)을 쓰지 않는다 —
  풀의 연결은 돌려쓰므로 세션 잠금을 쥘 수 없다.
- SQLite(compose·단위 시험): 서버가 하나뿐이라 늘 리더다. 연결하지 않는다.

스펙: cogentai-aas-docs docs-plan/deploy/aas-server-replicas.md (2026-10-12-008)
"""
from __future__ import annotations

import threading
import time

from . import config

LOCK_LEADER = 7243003            # 주기 작업 리더 advisory 잠금 키(db.py 의 7243001·7243002 와 겹치지 않게)
CHECK_EVERY = 10.0               # 잠금을 확인·다시 잡아 보는 간격(초)


def _default_connect():
    import psycopg

    from . import db
    return psycopg.connect(db._backend().conninfo(5), autocommit=True)


class Leader:
    def __init__(self, connect=None, backend=None, check_every: float = CHECK_EVERY):
        self._connect = connect or _default_connect
        self._backend = backend or config.db_backend
        self.check_every = check_every
        self._conn = None
        self._leader = False
        self._started = False
        self._lock = threading.Lock()

    def is_leader(self) -> bool:
        if self._backend() != "postgres":
            return True
        self._start()
        return self._leader

    def _start(self) -> None:
        with self._lock:
            if self._started:
                return
            self._started = True
        self.check_once()                      # 첫 확인은 바로 한다 — 기동 직후 첫 주기를 건너뛰지 않게
        threading.Thread(target=self._run, daemon=True, name="aas-leader").start()

    def _run(self) -> None:
        while True:
            time.sleep(self.check_every)
            self.check_once()

    def check_once(self) -> bool:
        """잠금을 쥐고 있으면 연결이 살아 있는지 보고, 아니면 잡아 본다. 연결이 끊겼으면 버리고 다음에 다시 연다."""
        try:
            if self._conn is None:
                self._conn = self._connect()
                self._leader = False
            if self._leader:
                self._conn.execute("SELECT 1")
            else:
                row = self._conn.execute("SELECT pg_try_advisory_lock(%s)", (LOCK_LEADER,)).fetchone()
                if row and row[0]:
                    self._leader = True
                    print("리더 잠금을 쥐었습니다 — 이 서버가 주기 작업을 돌립니다", flush=True)   # i18n-ignore: 운영자가 읽는 로그
        except Exception as exc:
            if self._leader:
                print(f"리더 잠금 연결을 잃었습니다({type(exc).__name__}) — 주기 작업을 멈춥니다", flush=True)   # i18n-ignore: 운영자가 읽는 로그
            self._leader = False
            self._drop()
        return self._leader

    def _drop(self) -> None:
        conn, self._conn = self._conn, None
        if conn is not None:
            try:
                conn.close()
            except Exception:
                pass


_LEADER = Leader()


def is_leader() -> bool:
    return _LEADER.is_leader()

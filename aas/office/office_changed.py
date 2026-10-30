# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""오피스 정보 변경 번호(스펙 2026-10-26-001 §4-1, 리뷰 D9·D13).

`/api/office` 가 주는 오피스 정보(자리·방·핀·문제 띠·부서·현수막·작업공간)가 바뀌면 번호를 올린다. 화면은 신호 토픽
`office:changed` 로 번호만 받고, 번호가 바뀌면 자기 권한으로 `/api/office` 를 다시 읽는다. 번호 말고는 아무것도 보내지 않는다
— 사람마다 다른 값은 REST 가 준다(R-A·R-B). 폐기한 2026-10-25-002 는 사용자 없이 만든 스냅샷을 공개 이벤트로 보냈다.

- 번호는 둘이다. 관리자에게만 보이는 종류(핀·문제 띠·부서)만 바뀌면 `admin` 을, 그 밖의 종류가 하나라도 있으면 `n` 을 올린다.
  일반 사용자의 `/api/office` 는 그 셋이 비어 있어 다시 읽을 까닭이 없다(D13).
- 번호는 공유 DB `meta` 에 두고, 올린 뒤 `shared` 알림으로 다른 서버를 깨운다. 알림을 놓쳐도 토픽의 보조 주기(30초)가 맞춘다.
- `after` 는 서버가 넣는다(이 서버의 `office:changed` 토픽을 곧바로 다시 읽게 한다). CLI 에서는 아무것도 하지 않는다.
"""
from __future__ import annotations

import os
import threading
import time
from typing import Callable

from ..common import db, store, table_cache

KINDS = frozenset({"seats", "rooms", "pods", "pins", "problems", "departments", "banners"})
ADMIN_ONLY = frozenset({"pins", "problems", "departments"})
KEY_N = "office_changed"
KEY_ADMIN = "office_changed_admin"

after: Callable[[], None] = lambda: None
MEMO = 25.0                                    # 번호를 기억하는 시간(초). 알림을 놓쳐도 토픽의 보조 주기(30초) 안에 맞춘다

_lock = threading.Lock()
_memo: dict[tuple, tuple[float, int, dict]] = {}   # (데이터 폴더, 스키마) → (읽은 시각, 세대, 값)
_gen = [0]


def counters(kinds) -> tuple[str, ...]:
    """이 종류들이 바뀌면 올릴 번호(meta 키)."""
    kinds = set(kinds)
    unknown = kinds - KINDS
    if unknown:
        raise ValueError(f"unknown office change kind: {sorted(unknown)}")
    if not kinds:
        return ()
    return (KEY_ADMIN,) if kinds <= ADMIN_ONLY else (KEY_N,)


def bump(*kinds: str) -> None:
    """바꾸는 요청이 성공한 뒤에 부른다. DB 오류는 삼킨다 — 번호를 못 올려도 바꾼 사람의 요청은 성공이고, 다른 화면은 다시 열 때 맞춰진다."""
    keys = counters(kinds)
    if not keys:
        return
    from . import shared                                       # 시험이 shared 없이 번호만 볼 때를 위해 늦게 가져온다
    try:
        with store.connect() as conn:
            for key in keys:
                conn.execute("INSERT INTO meta (key, value) VALUES (?, '1') ON CONFLICT (key) DO UPDATE "
                             "SET value=CAST(CAST(meta.value AS INTEGER) + 1 AS TEXT)", (key,))
            shared.notify(conn, "office_changed")
    except Exception as exc:
        print(f"오피스 변경 번호를 올리지 못했습니다: {type(exc).__name__}", flush=True)   # i18n-ignore: 로그
        return
    forget()
    try:
        after()
    except Exception:                                          # 토픽 허브가 아직 없으면(시험·CLI) 아무것도 하지 않는다
        pass


def value() -> dict:
    """신호 토픽 `office:changed` 의 값 {n, admin}. 모든 구독자가 같은 값을 받는다.
    신호 토픽(30초)과 사람 목록 토픽(10초)이 서버마다 읽었다(OKE 2026-10-26 초당 약 0.13건). PostgreSQL 이고 듣기 연결이 붙어 있으면
    MEMO 초 기억한다. 이 서버가 올리면(bump) 곧바로, 다른 서버가 올리면 office_changed 알림으로 버린다(스펙 2026-10-26-002 §9-13)."""
    memo_on = table_cache.enabled()
    where = (os.environ.get("AAS_DATA_DIR", ""), db._tl_schema() if db.backend() == "postgres" else "")
    if memo_on:
        with _lock:
            hit, gen = _memo.get(where), _gen[0]
        if hit is not None and hit[1] == gen and 0 <= time.monotonic() - hit[0] < MEMO:
            return dict(hit[2])
    with store.connect() as conn:
        rows = {str(r["key"]): str(r["value"] or "0")
                for r in conn.execute("SELECT key, value FROM meta WHERE key IN (?, ?)", (KEY_N, KEY_ADMIN))}
    out = {"n": int(rows.get(KEY_N, "0") or 0), "admin": int(rows.get(KEY_ADMIN, "0") or 0)}
    if memo_on:
        with _lock:
            if _gen[0] == gen:                         # 읽는 사이 버렸으면 남기지 않는다
                _memo[where] = (time.monotonic(), gen, dict(out))
    return out


def forget() -> None:
    """기억한 번호를 버린다(이 서버가 올렸거나, 다른 서버의 알림을 받았거나, 듣기 연결이 다시 붙음)."""
    with _lock:
        _gen[0] += 1
        _memo.clear()

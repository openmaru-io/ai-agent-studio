# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""허브에서 숨기기·다시 보이기(스펙 2026-10-29-002 R3·R15, 디자인 DD10·DD16).

  기준     숨겼는지는 허브 상태로 판정한다(hidden). AAS 기록(market_hub_hidden)은 누가·언제만 담는다 —
           베스천 API 처럼 다른 경로로 다시 보이게 해도 AAS 가 잘못 막지 않게.
  순서     허브 archive/unarchive 가 성공한 뒤에만 기록을 쓰거나 지운다. 이름 잠금 안에서 한다(서버 두 대).
  완전 삭제(DELETE)는 하지 않는다 — 되돌릴 수 없다.
"""
from __future__ import annotations

import json
import urllib.error
import urllib.parse
import urllib.request

from ..common import db, store
from ..common.i18n import tr
from . import market_publish as mp, marketplace, skill_bundle
from .marketplace import NAME, MarketError

SCHEMA = """
CREATE TABLE IF NOT EXISTS market_hub_hidden (
  namespace TEXT NOT NULL, name TEXT NOT NULL, by TEXT, ts TEXT, PRIMARY KEY (namespace, name));
"""
ACTIVE = ("", "ACTIVE")                       # 허브가 숨기지 않은 패키지의 상태 값(T0 확인 — §7)


def _conn():
    conn = store.connect()
    conn.executescript(SCHEMA)
    return conn


def records() -> list[dict]:
    """AAS 가 숨긴 기록(누가·언제). 「허브에서 숨김」 탭이 읽는다."""
    with _conn() as conn:
        return [dict(r) for r in conn.execute("SELECT namespace, name, by, ts FROM market_hub_hidden ORDER BY ts DESC")]


def hub_status(ns: str, name: str) -> str:
    """허브의 패키지 상태(대문자). 없으면 빈 값."""
    try:
        info = marketplace.fetch(f"/api/v1/skills/{ns}/{name}")
    except MarketError as exc:
        if exc.code == 404:
            return ""
        raise
    return str((info or {}).get("status") or "").upper()


def hidden(ns: str, name: str) -> bool:
    """허브에서 숨긴 패키지인가 — 허브 상태가 기준(R15)."""
    return hub_status(ns, name) not in ACTIVE


def surely_hidden(ns: str, name: str) -> bool:
    """허브가 숨김이라고 분명히 답할 때만 참. 허브에 닿지 못하면 거짓 — 그 경우는 뒤따르는 허브 호출이 실패를 알린다."""
    try:
        return hidden(ns, name)
    except MarketError:
        return False


def _call(ns: str, name: str, action: str) -> tuple[int, dict]:
    cfg = marketplace.settings()
    path = f"/api/v1/skills/{urllib.parse.quote(ns)}/{urllib.parse.quote(name)}/{action}"
    req = urllib.request.Request(cfg["url"] + path, data=b"{}", method="POST",
                                 headers={"Accept": "application/json", "Content-Type": "application/json"})   # 본문 {} 과 JSON 헤더가 없으면 415(미러 작업 확인)
    token = marketplace._token(cfg["token_file"])
    if token:
        req.add_header("Authorization", "Bearer " + token)
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return resp.status, json.loads(resp.read() or b"{}")
    except urllib.error.HTTPError as exc:
        try:
            return exc.code, json.loads(exc.read() or b"{}")
        except ValueError:
            return exc.code, {}
    except OSError as exc:
        return 0, {"msg": type(exc).__name__}


def _check(ns: str, name: str) -> None:
    ns_ok = ns in marketplace.settings()["namespaces"]
    if not (ns_ok and NAME.match(name or "")):
        raise MarketError(tr("이 스킬 허브에서 다루지 않는 패키지입니다", "This skill hub does not serve that package"), 404)
    if name in skill_bundle.names():
        raise MarketError(tr("AAS 기본 스킬은 AAS 서버가 관리합니다", "AAS built-in skills are managed by the AAS server"), 403)


def hide(ns: str, name: str, who: str) -> dict:
    ns = marketplace.ns_slug(ns)
    _check(ns, name)
    with mp.name_lock(name):
        code, res = _call(ns, name, "archive")
        if not (200 <= code < 300) and not hidden(ns, name):
            raise MarketError(tr(f"스킬 허브가 숨기지 못했습니다 (HTTP {code} {res.get('msg') or ''})".strip(),
                                 f"The skill hub could not hide it (HTTP {code} {res.get('msg') or ''})".strip()), 502)
        with _conn() as conn:
            conn.execute(db.upsert("market_hub_hidden", ("namespace", "name", "by", "ts"), ("namespace", "name")), (ns, name, who, mp._now()))
    return {"namespace": ns, "name": name, "hidden": True}


def show(ns: str, name: str, who: str) -> dict:
    """다시 보이기. 허브가 이미 보이는 상태여도 성공으로 보고 기록을 지운다(R15)."""
    ns = marketplace.ns_slug(ns)
    _check(ns, name)
    with mp.name_lock(name):
        code, res = _call(ns, name, "unarchive")
        if not (200 <= code < 300) and hidden(ns, name):
            raise MarketError(tr(f"스킬 허브가 다시 보이게 하지 못했습니다 (HTTP {code} {res.get('msg') or ''})".strip(),
                                 f"The skill hub could not show it again (HTTP {code} {res.get('msg') or ''})".strip()), 502)
        with _conn() as conn:
            conn.execute("DELETE FROM market_hub_hidden WHERE namespace=? AND name=?", (ns, name))
    return {"namespace": ns, "name": name, "hidden": False, "by": who}


def listing() -> list[dict]:
    """「허브에서 숨김」 탭 목록 — AAS 기록 중 허브에서 지금도 숨겨진 것(허브가 기준). 허브에서 다시 보이게 된 기록은 지운다."""
    out = []
    for r in records():
        try:
            still = hidden(r["namespace"], r["name"])
        except MarketError:
            still = True                                                      # 허브에 닿지 못하면 기록대로 보인다
        if still:
            out.append(r)
        else:
            with _conn() as conn:
                conn.execute("DELETE FROM market_hub_hidden WHERE namespace=? AND name=?", (r["namespace"], r["name"]))
    return out

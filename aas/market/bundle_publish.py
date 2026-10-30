# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""AAS 기본 스킬 묶음(skill_bundle)을 스킬 허브 free 네임스페이스에 게시한다(스펙 2026-10-29-001 R1·R13·F7, OMAI-1534).

  언제     리더의 스킬 허브 주기(market_dispatch.loop 의 after_tick)마다 부르되, INTERVAL 안에는 다시 허브를 묻지 않는다.
  무엇을   허브에 그 패키지가 없거나 허브 판이 묶음 판보다 낮을 때만. 같거나 높으면 건너뛴다 — 허브 판을 되돌리지 않는다.
  토큰     게시 전용 aas_admin 토큰. AAS_SKILLHUB_PUBLISH_TOKEN_FILE, 비었으면 서버 토큰 파일 옆의 publish-token
           (COP 차트가 Secret aas-skillhub-token 전체를 붙인다 — §9-6a). 목록 읽기·사용자 스킬 게시는 기존 토큰 그대로(R13)
           — 같은 패키지의 새 판은 처음 게시한 계정만 올릴 수 있어서, 기본 스킬은 처음부터 이 계정 하나로만 게시한다.
  기록     meta 의 `bundle_publish:<이름>` = {version, status, message, ts}. 검토 대기(pending_review)·실패(failed)인 판은
           같은 판을 다시 보내지 않는다(같은 오류를 주기마다 되풀이하지 않게). 판을 올리면 다시 게시한다.
"""
from __future__ import annotations

import json
import os
import threading
import time
from datetime import datetime
from pathlib import Path

from ..common import store
from . import market_publish, marketplace, skill_bundle

TOKEN_ENV = "AAS_SKILLHUB_PUBLISH_TOKEN_FILE"
NAMESPACE = "free"
KEY = "bundle_publish:"
INTERVAL = 600.0                                   # 허브를 다시 묻는 간격(초). 서버 반영 뒤 10분 안에 새 판이 게시된다
_last = [0.0]
_lock = threading.Lock()


def reset() -> None:
    """다음 부름이 시간 제한 없이 돌게 한다(시험·관리자 다시 시도)."""
    _last[0] = 0.0


def state(name: str) -> dict | None:
    with store.connect() as conn:
        row = conn.execute("SELECT value FROM meta WHERE key=?", (KEY + name,)).fetchone()
    return json.loads(row[0]) if row else None


def _save(name: str, version: str, status: str, message: str = "") -> None:
    value = json.dumps({"version": version, "status": status, "message": message[:300],
                        "ts": datetime.now().astimezone().isoformat(timespec="seconds")}, ensure_ascii=False)
    with store.connect() as conn:
        conn.execute("INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", (KEY + name, value))


def package_zip(name: str) -> bytes:
    pkg = skill_bundle.PACKAGES_DIR / name
    return market_publish.zip_of([(p.relative_to(pkg).as_posix(), p.read_bytes()) for p in skill_bundle._files(pkg)])


def token_file(cfg: dict) -> str:
    if os.environ.get(TOKEN_ENV, ""):
        return os.environ[TOKEN_ENV]
    return str(Path(cfg["token_file"]).with_name("publish-token")) if cfg.get("token_file") else ""


def _hub_version(name: str, cfg: dict) -> str:
    """허브의 게시된 버전. 없으면 빈 값. 허브에 닿지 않으면 MarketError(그 주기는 건너뛴다)."""
    try:
        info = marketplace.fetch(f"/api/v1/skills/{NAMESPACE}/{name}", cfg)
    except marketplace.MarketError as exc:
        if exc.code == 404:
            return ""
        raise
    return str(((info or {}).get("publishedVersion") or {}).get("version") or "")


def publish_once() -> list[str]:
    """게시를 요청한 「이름 버전」 목록. 토큰·허브 주소가 없거나 시간 제한 안이면 빈 목록."""
    with _lock:
        if time.monotonic() - _last[0] < INTERVAL and _last[0]:
            return []
        _last[0] = time.monotonic()
    cfg = marketplace.settings()
    token = marketplace._token(token_file(cfg))
    if not cfg["url"] or not token:
        return []
    done: list[str] = []
    for name in skill_bundle.names():
        version = skill_bundle.front(name)["version"]
        prev = state(name)
        if prev and prev["version"] == version and prev["status"] in ("pending_review", "failed", "published"):
            continue
        try:
            hub = _hub_version(name, cfg)
        except marketplace.MarketError as exc:            # 허브에 닿지 않음 — 기록하지 않고 다음 주기에 다시 본다
            print(f"기본 스킬 게시: 허브를 읽지 못했습니다 ({name}): {exc}", flush=True)   # i18n-ignore: 로그
            return done
        if hub and marketplace._ver(hub) >= marketplace._ver(version):
            _save(name, version, "published", f"hub {hub}")
            continue
        try:
            code, res = market_publish._post(NAMESPACE, name, version, package_zip(name), token=token)
        except OSError as exc:
            code, res = 0, {"msg": type(exc).__name__}
        msg = str(res.get("msg") or "")
        if code == 200 and res.get("code") == 0:
            status = str((res.get("data") or {}).get("status") or "published").lower()
            _save(name, version, "pending_review" if "pending" in status or "review" in status else "published", status)
        elif "already exist" in msg.lower():               # 다른 복제본이 먼저 게시했다
            _save(name, version, "published", msg)
        else:
            _save(name, version, "failed", f"HTTP {code} {msg}")
            print(f"기본 스킬 게시 실패 ({name} {version}): HTTP {code} {msg[:120]}", flush=True)   # i18n-ignore: 로그
            continue
        done.append(f"{name} {version}")
    return done

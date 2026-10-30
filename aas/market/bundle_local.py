# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""스킬 허브가 없는 설치본(compose)에 AAS 기본 스킬 묶음을 직접 쓴다(스펙 2026-10-29-001 R10, OMAI-1534).

compose 는 스킬 허브가 없고 마켓 설치가 꺼져 있다(AAS_MARKET_INSTALL=off). 그래서 서버가 Hermes 파일 API(upload-stream, /opt/data
아래 상대 경로)로 프로파일마다 skills/market/<이름>/ 에 묶음 파일을 쓴다. 허브 설치와 같은 자리라 Hermes 가 같은 스킬로 읽는다.

  처음      그 자리에 SKILL.md 가 없을 때만 쓴다. 있으면 사용자 것으로 보고 덮지 않는다(kept).
  순서      SKILL.md 를 마지막에 쓴다 — 반쯤 쓴 스킬이 Hermes 에 보이지 않게.
  기록      market_bundle_local = (판, 파일마다 해시). 묶음 판이 높아지면 기록한 파일을 읽어 모두 그대로일 때만 새 판으로 바꾼다.
            하나라도 다르면 그대로 두고 「확인할 것」에 알린다(modified). SKILL.md 가 없으면 사용자가 지운 것 — 다시 넣지 않는다.
  실패      쓰기가 실패하면 그 판에 한 번만(failed) — 「확인할 것」에 보인다. 묶음 판이 바뀌면 다시 한다.
  루트 default 프로파일은 뺀다(허브 길과 같은 규칙, R3).
"""
from __future__ import annotations

import hashlib
import json
import threading
import time
from datetime import datetime

from ..common import store
from ..common.i18n import tr
from . import skill_bundle

INTERVAL = 60.0
SCHEMA = """
CREATE TABLE IF NOT EXISTS market_bundle_local (
  pod TEXT NOT NULL, profile TEXT NOT NULL, package TEXT NOT NULL, version TEXT NOT NULL, files TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL, message TEXT NOT NULL DEFAULT '', ts TEXT, PRIMARY KEY (pod, profile, package));
"""
_last = [0.0]
_lock = threading.Lock()


def _now() -> str:
    return datetime.now().astimezone().isoformat(timespec="seconds")


def _conn():
    conn = store.connect()
    conn.executescript(SCHEMA)
    return conn


def reset() -> None:
    _last[0] = 0.0


def record(pod_id: str, profile: str, name: str) -> dict | None:
    with _conn() as conn:
        row = conn.execute("SELECT * FROM market_bundle_local WHERE pod=? AND profile=? AND package=?", (pod_id, profile, name)).fetchone()
    return dict(row) if row else None


def manifest(row: dict | None) -> dict[str, str]:
    try:
        return json.loads((row or {}).get("files") or "{}")
    except ValueError:
        return {}


def _put(pod_id: str, profile: str, name: str, version: str, status: str, files: dict | None = None, message: str = "") -> None:
    with _conn() as conn:
        conn.execute("INSERT INTO market_bundle_local (pod, profile, package, version, files, status, message, ts) VALUES (?,?,?,?,?,?,?,?) "
                     "ON CONFLICT(pod, profile, package) DO UPDATE SET version=excluded.version, files=excluded.files, "
                     "status=excluded.status, message=excluded.message, ts=excluded.ts",
                     (pod_id, profile, name, version, json.dumps(files or {}, sort_keys=True), status, message[:300], _now()))


def _package_files(name: str) -> list[tuple[str, bytes]]:
    """(상대 경로, 내용) — SKILL.md 를 맨 끝에."""
    pkg = skill_bundle.PACKAGES_DIR / name
    files = [(p.relative_to(pkg).as_posix(), p.read_bytes()) for p in skill_bundle._files(pkg)]
    return sorted(files, key=lambda f: (f[0] == "SKILL.md", f[0]))


def _sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _write_all(base: str, files: list[tuple[str, bytes]], write) -> str:
    """빈 값이면 성공, 아니면 실패 이유."""
    for rel, data in files:
        status = write(f"{base}/{rel}", data)
        if status != 200:
            return f"{rel}: HTTP {status}"
    return ""


def install(pods: list, profiles_of, reader_of, writer_of) -> list[str]:
    """한 주기. reader_of(pod)(경로) → 바이트 또는 None(없음), writer_of(pod)(경로, 바이트) → HTTP 상태(덮어쓰기)."""
    with _lock:
        if _last[0] and time.monotonic() - _last[0] < INTERVAL:
            return []
        _last[0] = time.monotonic()
    done: list[str] = []
    for pod in pods:
        read, write = reader_of(pod), writer_of(pod)
        for profile in [p for p in profiles_of(pod) if p != "default"]:
            for name in skill_bundle.names():
                version = skill_bundle.front(name)["version"]
                base = f"profiles/{profile}/skills/market/{name}"
                row = record(pod.id, profile, name)
                if row and row["version"] == version:      # 이 판은 이미 끝났다(done·kept·modified·failed)
                    continue
                if row and row["status"] in ("kept",):     # 사용자 것은 판과 상관없이 두지 않는다
                    continue
                files = _package_files(name)
                if row and row["status"] in ("done", "modified"):
                    old = manifest(row)
                    current = {rel: read(f"{base}/{rel}") for rel in old}
                    if current.get("SKILL.md") is None:    # 사용자가 지웠다 — 다시 넣지 않는다
                        continue
                    if any(data is None or _sha(data) != old[rel] for rel, data in current.items()):
                        _put(pod.id, profile, name, version, "modified", old, tr("사용자가 고쳐 새 버전으로 바꾸지 않았습니다", "Kept because the user changed it"))
                        continue
                elif not row or row["status"] == "failed":
                    if not row and read(f"{base}/SKILL.md") is not None:
                        _put(pod.id, profile, name, version, "kept")
                        continue
                why = _write_all(base, files, write)
                if why:
                    _put(pod.id, profile, name, version, "failed", manifest(row), why)
                    continue
                _put(pod.id, profile, name, version, "done", {rel: _sha(data) for rel, data in files})
                done.append(f"{pod.id}/{profile} {name} {version}")
    return done


def issues(pod_id: str, profile: str) -> list[dict]:
    with _conn() as conn:
        rows = [dict(r) for r in conn.execute("SELECT package, version, status, message FROM market_bundle_local WHERE pod=? AND profile=? "
                                              "AND status IN ('failed', 'modified')", (pod_id, profile))]
    out = []
    for r in rows:
        if r["status"] == "failed":
            out.append({"code": "market_default_failed", "level": "bad", "package": r["package"], "version": r["version"],
                        "text": tr(f"기본 스킬 {r['package']} v{r['version']} 을 넣지 못했습니다: {r['message']}",
                                   f"Could not add the default skill {r['package']} v{r['version']}: {r['message']}")})
        else:
            out.append({"code": "market_default_modified", "level": "info", "package": r["package"], "version": r["version"],
                        "text": tr(f"고친 기본 스킬 {r['package']} 은 새 버전 v{r['version']} 으로 바꾸지 않았습니다",
                                   f"The changed default skill {r['package']} was not replaced with v{r['version']}")})
    return out

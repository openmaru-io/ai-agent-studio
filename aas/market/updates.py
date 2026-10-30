# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""스킬 허브에 새 버전이 나온 스킬을 찾는다 — 프로파일의 스킬 판과 허브 목록을 비교한다(스펙 2026-10-24-003, OMAI-1463).

  판의 정본      스킬 패키지 = 프로파일 skills/market/<이름>/SKILL.md 의 version(R19). 파일에 version 이 없으면 설치 기록의 판.
                 에이전트 패키지 = 설치 기록의 판(R15).
  패키지 찾기    설치 기록 → 없으면 폴더 이름. 같은 이름 패키지가 읽을 수 있는 네임스페이스에 하나뿐일 때만(R4).
  줄의 상태      update(새 버전 있음) · kept(기록 판 > 파일 판, 사용자가 「내 것 지키기」로 올림) · blocked(올릴 수 없음: root·grant, R21)
                 · unreadable(판을 읽지 못함) · skipped(이 버전 건너뜀, R3). 알림·배지·자동 올리기는 update 만 쓴다.

알림·배지는 버전만 비교한다. 고친 내용 판정(modified)은 목록 API 와 자동 올리기에서만 한다(R17) — 옛 판의 원본 기준값은 AAS 데이터 폴더에
영구로 남겨 허브 다운로드는 (패키지, 판)마다 한 번이다. Hermes 의 파일은 읽기만 한다.
"""
from __future__ import annotations

import json
import os
import re
import tempfile
import threading
import time
from datetime import datetime, timedelta
from pathlib import Path

from ..common import cache_epoch, db, store, table_cache
from ..common.i18n import tr
from . import market_stage, marketplace, skill_keep

MARKET_DIR = "skills/" + market_stage.SKILL_CATEGORY
_VERSION = re.compile(r"^version:\s*['\"]?([^'\"\s#]+)['\"]?\s*(?:#.*)?$", re.M)
NOTICE_DAYS = 7                                # 자동 올리기 안내를 「확인할 것」에 두는 날 수(D11)
SCHEMA = """
CREATE TABLE IF NOT EXISTS market_update_skips (
  pod TEXT NOT NULL, profile TEXT NOT NULL, package TEXT NOT NULL, version TEXT NOT NULL, by TEXT, ts TEXT,
  PRIMARY KEY (pod, profile, package));
CREATE TABLE IF NOT EXISTS market_update_pending (
  pod TEXT NOT NULL, profile TEXT NOT NULL, package TEXT NOT NULL, version TEXT NOT NULL, on_modified TEXT NOT NULL DEFAULT '',
  origin TEXT NOT NULL DEFAULT 'manual', by TEXT, ts TEXT, PRIMARY KEY (pod, profile, package));
CREATE TABLE IF NOT EXISTS market_update_auto (
  pod TEXT NOT NULL, profile TEXT NOT NULL, package TEXT NOT NULL, version TEXT NOT NULL, request TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'queued', message TEXT NOT NULL DEFAULT '', ts TEXT, PRIMARY KEY (pod, profile, package, version));
"""
AUTO_KEY = "market_auto_upgrade"               # meta 표의 관리자 설정. 저장한 적 없으면 켬(스펙 2026-10-29-001 R7, 처음엔 기본 꺼짐 R2)
AUTO_EPOCH = "market_auto"                     # 켜짐을 바꾸면 다른 서버의 기억도 버린다(cache_epoch, 스펙 2026-10-26-002 §9-12)
AUTO_MEMO = 60.0                               # 알림을 놓칠 때를 위한 기억 시간(초)


def _now() -> str:
    return datetime.now().astimezone().isoformat(timespec="seconds")


def _conn():
    conn = store.connect()
    conn.executescript(SCHEMA)
    return conn


def file_version(md_text: str) -> str:
    """SKILL.md 머리말의 version(x.y.z). 없거나 형식이 다르면 빈 값."""
    if not md_text.startswith("---") or md_text.count("---") < 2:
        return ""
    m = _VERSION.search(md_text.split("---", 2)[1])
    v = m.group(1).strip() if m else ""
    return v if marketplace.VERSION.match(v) else ""


def _newer(a: str, b: str) -> bool:
    return marketplace._ver(a) > marketplace._ver(b)


def _market_skills(home) -> list[tuple[str, str, str]]:
    """(프로파일, 폴더 이름, SKILL.md 글) — 각 프로파일의 skills/market/<이름>/SKILL.md. 읽지 못한 파일은 글이 None 이 아니라 빈 값이다."""
    from ..hermes import hermes_reader
    out = []
    for prof in hermes_reader.profiles(home):
        base = prof.path / MARKET_DIR
        if not base.is_dir():
            continue
        for d in sorted(base.iterdir(), key=lambda p: p.name):
            md = d / "SKILL.md"
            if not d.is_dir() or d.name.startswith(".") or not md.is_file():
                continue
            try:
                text = md.read_text(encoding="utf-8", errors="replace")[:4000]
            except OSError:
                text = ""
            out.append((prof.name, d.name, text))
    return out


def scan(pod_id: str, home, cat: list[dict], records: list[dict] | None = None, granted: set[str] | None = None,
         skips: dict | None = None) -> list[dict]:
    """이 작업공간에서 허브 판이 지금 판보다 높은 줄. cat = marketplace.catalog() 결과, records = marketplace.installed(pod_id).
    granted = 허용받은 네임스페이스(허용이 필요한 곳), skips = {(프로파일, 패키지): 건너뛴 판}. 읽지 못하면(사이드카) 예외를 그대로 올린다."""
    records = marketplace.installed(pod_id) if records is None else records
    granted = {g["namespace"] for g in marketplace.grants() if g["pod"] == pod_id} if granted is None else granted
    skips = skipped(pod_id) if skips is None else skips
    by_id = {p["id"]: p for p in cat}
    by_name: dict[str, list[dict]] = {}
    for p in cat:
        by_name.setdefault(p["name"], []).append(p)
    rec = {(r["profile"], r["package"]): r for r in records}
    rows: list[dict] = []

    def add(profile: str, pkg: dict, current: str, basis: str, kind: str, folder: str, record: dict | None, state: str = "") -> None:
        if not state and not _newer(pkg["version"], current):
            return
        row = {"pod": pod_id, "profile": profile, "package": pkg["id"], "namespace": pkg["namespace"], "name": pkg["name"],
               "skill": folder or pkg["name"], "kind": kind, "current": current, "latest": pkg["version"], "basis": basis,
               "mode": "skills" if (record or {}).get("mode") == "skills" else "update", "state": state or "update", "reason": ""}
        if row["state"] == "update":
            if profile == "default":
                row.update(state="blocked", reason="root")
            elif pkg["paid"] and pkg["namespace"] not in granted:
                row.update(state="blocked", reason="grant")
            elif skips.get((profile, pkg["id"])) == pkg["version"]:
                row["state"] = "skipped"
        rows.append(row)

    for profile, folder, text in _market_skills(home):
        r = next((x for x in records if x["profile"] == profile and x["kind"] == "skill" and x["name"] == folder), None)
        if r is not None:
            pkg, basis = by_id.get(r["package"]), "record"
        else:
            same = by_name.get(folder, [])
            pkg, basis = (same[0] if len(same) == 1 else None), "folder"   # 둘 이상이면 어느 것인지 모른다 — 판단하지 않는다(R4)
        if pkg is None:
            continue
        have = file_version(text)
        recorded = str((r or {}).get("version") or "")
        if have and recorded and _newer(recorded, have):            # 「내 것 지키기」로 올렸다 — 기록은 새 판, 파일은 고친 옛 판(R19)
            if _newer(pkg["version"], have):
                add(profile, pkg, have, basis, "skill", folder, r, state="kept")
            continue
        current = have or recorded
        if not current:
            add(profile, pkg, "", basis, "skill", folder, r, state="unreadable")
            continue
        add(profile, pkg, current, basis, "skill", folder, r)
    for r in records:                                                # 에이전트 패키지는 설치 기록으로만 비교한다(R15)
        pkg = by_id.get(r["package"])
        if r.get("kind") != "agent" or pkg is None:
            continue
        add(r["profile"], pkg, str(r.get("version") or ""), "record", "agent", "", rec.get((r["profile"], r["package"])))
    return sorted(rows, key=lambda x: (x["profile"], x["skill"], x["package"]))


def alerts(rows: list[dict]) -> list[dict]:
    """알림·배지·자동 올리기가 쓰는 줄 — 올릴 수 있는 새 버전만."""
    return [r for r in rows if r["state"] == "update"]


def by_profile(rows: list[dict]) -> dict[str, list[dict]]:
    out: dict[str, list[dict]] = {}
    for r in alerts(rows):
        out.setdefault(r["profile"], []).append(r)
    return out


# ---- 고친 내용 판정(목록 API·자동 올리기만, R17) ------------------------------------------------------

def _ref_path(package_id: str, version: str) -> Path:
    ns, _, name = package_id.partition("/")
    d = store.data_dir() / "market" / "refs" / ns
    d.mkdir(parents=True, exist_ok=True)
    return d / f"{name}@{version}.json"


def reference(row: dict) -> dict | None:
    """그 버전 원본의 {경로: sha256}. 처음 한 번만 허브에서 받고 AAS 데이터 폴더에 남긴다. 받지 못하면 None(= 모름)."""
    path = _ref_path(row["package"], row["current"])
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else None
    except (OSError, ValueError):
        pass
    try:
        with tempfile.TemporaryDirectory(prefix="aas-ref-") as tmp:
            market_stage.download({"namespace": row["namespace"], "name": row["name"], "version": row["current"]}, Path(tmp))
            ref = skill_keep.digest(Path(tmp))
    except (market_stage.Refuse, marketplace.MarketError, OSError):
        return None
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(ref, ensure_ascii=False), encoding="utf-8")
    tmp.rename(path)
    return ref


def modified(home, row: dict) -> str:
    """'same' 고치지 않음 / 'changed' 고침 / 'unknown' 모름. 기록 없는 폴더(R4)와 에이전트 패키지는 모름이다 —
    배달기가 덮기 전에 다시 묻는다(R21). 읽지 못하면(사이드카) 모름."""
    if row["kind"] != "skill" or row["basis"] != "record":
        return "unknown"
    try:
        got = skill_keep.modified(skill_keep.profile_root(home, row["profile"]), f"{MARKET_DIR}/{row['skill']}", reference(row))
    except OSError:
        return "unknown"
    return "same" if got == "same" else "unknown" if got in ("unknown", "absent") else "changed"


# ---- 건너뛰기(R3·D18) ------------------------------------------------------------------------------

def skipped(pod_id: str) -> dict:
    with _conn() as conn:
        return {(r["profile"], r["package"]): r["version"] for r in conn.execute(
            "SELECT profile, package, version FROM market_update_skips WHERE pod=?", (pod_id,))}


def skip(pod_id: str, profile: str, package_id: str, version: str, who: str, undo: bool = False) -> None:
    """그 버전의 알림을 숨기거나(undo=False) 되살린다. 더 새 버전이 나오면 버전이 달라져 저절로 다시 알린다."""
    if not marketplace.PROFILE.match(profile or "") or not marketplace.VERSION.match(version or "") or "/" not in package_id:
        raise marketplace.MarketError("잘못된 요청입니다")  # i18n-ignore: 화면이 잘못 보낸 요청에만 나온다
    with _conn() as conn:
        if undo:
            conn.execute("DELETE FROM market_update_skips WHERE pod=? AND profile=? AND package=?", (pod_id, profile, package_id))
        else:
            conn.execute(db.upsert("market_update_skips", ("pod", "profile", "package", "version", "by", "ts"), ("pod", "profile", "package")),
                         (pod_id, profile, package_id, version, who, _now()))


def mark_seen(pod_id: str, profile: str, package_id: str, version: str) -> int:
    """자동 올리기 안내(market_auto_done)를 사람이 확인했다 — 7일을 기다리지 않고 「확인할 것」에서 뺀다(사용자 지시 2026-10-30).
    끝난(done) 줄만 seen 으로 바꾼다. 실패 줄은 올리면 사라지는 할 일이라 그대로 둔다. 바꾼 줄 수를 돌려준다."""
    if not marketplace.PROFILE.match(profile or "") or not marketplace.VERSION.match(version or "") or "/" not in package_id:
        raise marketplace.MarketError("잘못된 요청입니다")  # i18n-ignore: 화면이 잘못 보낸 요청에만 나온다
    with _conn() as conn:
        return conn.execute("UPDATE market_update_auto SET status='seen' WHERE pod=? AND profile=? AND package=? AND version=? AND status='done'",
                            (pod_id, profile, package_id, version)).rowcount


# ---- 대기 표: 고른 것 올리기·자동 올리기(R6·R18) -----------------------------------------------------

def queue(pod_id: str, items: list[dict], who: str, origin: str = "manual") -> int:
    """줄을 대기 표에 넣는다. items = [{profile, package, version, on_modified}]. 새로 넣은 줄 수. 같은 (프로파일, 패키지)는 덮는다."""
    made = 0
    with _conn() as conn:
        for it in items:
            profile, pkg, version = str(it.get("profile") or ""), str(it.get("package") or ""), str(it.get("version") or "")
            choice = str(it.get("on_modified") or "")
            if not (marketplace.PROFILE.match(profile) and marketplace.VERSION.match(version) and "/" in pkg) or choice not in ("", "copy", "overwrite"):
                continue
            conn.execute(db.upsert("market_update_pending", ("pod", "profile", "package", "version", "on_modified", "origin", "by", "ts"),
                                   ("pod", "profile", "package")), (pod_id, profile, pkg, version, choice, origin, who, _now()))
            made += 1
    return made


def pending(pod_id: str | None = None) -> list[dict]:
    with _conn() as conn:
        sql = "SELECT pod, profile, package, version, on_modified, origin, by, ts FROM market_update_pending"
        rows = conn.execute(sql + (" WHERE pod=?" if pod_id else "") + " ORDER BY ts, profile, package", (pod_id,) if pod_id else ()).fetchall()
    return [dict(r) for r in rows]


def drain(pods: list, profiles_of=None) -> list[str]:
    """대기 표를 설치 요청으로 바꾼다(대표 서버 주기). 한 프로파일에 한 주기 하나, 409(끝나지 않은 요청)는 남겨 다음 주기에 다시.
    다른 실패는 기록하고 지운다. 자동 올리기 줄은 시도 표에 요청 번호·실패를 적는다(R11). profiles_of(pod) = 그 작업공간의 프로파일 이름들."""
    by_id = {p.id: p for p in pods}
    done: list[str] = []
    busy: set[tuple[str, str]] = set()
    # 대기 줄이 비었고 그 뒤 바뀐 적이 없으면 읽지 않는다 — 리더가 5초마다 읽었다(스펙 2026-10-26-002 §9-14). 값은 캐시하지 않는다
    if table_cache.quiet("updates.pending", ("market_update_pending",)):
        return done
    token = table_cache.quiet_token(("market_update_pending",))
    rows = pending()
    if not rows:
        table_cache.mark_quiet("updates.pending", token)
    for row in rows:
        pod = by_id.get(row["pod"])
        where = (row["pod"], row["profile"])
        if pod is None or where in busy:
            continue
        busy.add(where)
        ns, _, name = row["package"].partition("/")
        result, message, request = "failed", "", ""
        try:
            from . import hub_hide
            if hub_hide.surely_hidden(ns, name):                      # 허브에서 숨긴 패키지는 쌓인 대기 줄도 설치하지 않는다(스펙 2026-10-29-002 R15)
                raise marketplace.MarketError(tr("허브에서 내려짐", "Withdrawn from the skill hub"), 410)
            pkg = marketplace.package(ns, name)
            names = profiles_of(pod) if profiles_of else [row["profile"]]
            mode = "skills" if pkg["kind"] == "agent" and _record_mode(pod.id, row["profile"], row["package"]) == "skills" else "update"
            req = marketplace.request_install(pod.id, pod.container, pkg, row["version"], row["profile"], mode, row["by"] or "aas", list(names), row["on_modified"])
            result, request = "queued", req["id"]
        except marketplace.MarketError as exc:
            if exc.code == 409:
                continue
            message = str(exc)[:300]
        except Exception as exc:                                      # 스킬 허브에 닿지 않는 등
            message = type(exc).__name__
        with _conn() as conn:
            conn.execute("DELETE FROM market_update_pending WHERE pod=? AND profile=? AND package=?", (row["pod"], row["profile"], row["package"]))
            if row["origin"] == "auto":
                conn.execute("UPDATE market_update_auto SET request=?, status=?, message=?, ts=? WHERE pod=? AND profile=? AND package=? AND version=?",
                             (request, result, message, _now(), row["pod"], row["profile"], row["package"], row["version"]))
        store.log_usage("market_update_" + result, f"{row['pod']}/{row['profile']} {row['package']} {row['version']} {message}".strip(), pod=row["pod"])
        if result == "queued":
            done.append(f"{row['pod']}/{row['profile']} {row['package']}")
    return done


def _record_mode(pod_id: str, profile: str, package_id: str) -> str:
    return str(next((r.get("mode") for r in marketplace.installed(pod_id) if r["profile"] == profile and r["package"] == package_id), "") or "")


# ---- 자동 올리기(R2·R11·D11) --------------------------------------------------------------------------

_auto_lock = threading.Lock()
_auto_memo: dict[tuple, tuple[float, int, bool]] = {}   # (데이터 폴더, 스키마) → (읽은 시각, 세대, 켜짐)
_auto_gen = [0]


def _auto_where() -> tuple:
    return (os.environ.get("AAS_DATA_DIR", ""), db._tl_schema() if db.backend() == "postgres" else "")


def auto_enabled() -> bool:
    """자동 올리기가 켜져 있나. 리더가 5초마다 meta 를 읽었다(OKE 2026-10-26 초당 약 0.2건). PostgreSQL 이고 서버 사이 듣기 연결이
    붙어 있으면 기억하고, 바꾸면(set_auto) 그 서버는 곧바로, 다른 서버는 cache_epoch 알림으로 버린다(스펙 2026-10-26-002 §9-12)."""
    memo_on = cache_epoch.enabled() and table_cache.listening()
    where = _auto_where()
    if memo_on:
        if cache_epoch.changed(AUTO_EPOCH):
            _auto_forget()
        with _auto_lock:
            hit, gen = _auto_memo.get(where), _auto_gen[0]
        if hit is not None and hit[1] == gen and 0 <= time.monotonic() - hit[0] < AUTO_MEMO:
            return hit[2]
    with _conn() as conn:
        row = conn.execute("SELECT value FROM meta WHERE key=?", (AUTO_KEY,)).fetchone()
    on = not row or str(row[0]) == "on"                    # 저장한 적 없으면 켬(스펙 2026-10-29-001 R7)
    if memo_on:
        with _auto_lock:
            if _auto_gen[0] == gen:                          # 읽는 사이 버렸으면 남기지 않는다
                _auto_memo[where] = (time.monotonic(), gen, on)
    return on


def _auto_forget() -> None:
    with _auto_lock:
        _auto_gen[0] += 1
        _auto_memo.clear()


def set_auto(enabled: bool) -> None:
    with _conn() as conn:
        conn.execute("INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", (AUTO_KEY, "on" if enabled else "off"))
    _auto_forget()
    cache_epoch.bump(AUTO_EPOCH)


def auto_targets(rows: list[dict], home) -> list[dict]:
    """자동으로 올릴 줄: 기본 스킬(AAS_DEFAULT_SKILLS)이고 고친 내용이 없는 새 버전, 아직 시도하지 않은 버전. 건너뜀·지킴·올릴 수 없음은 빠진다."""
    defaults = set(marketplace.default_packages())
    out = []
    for r in alerts(rows):
        if r["package"] not in defaults or r["kind"] != "skill" or attempted(r["pod"], r["profile"], r["package"], r["latest"]):
            continue
        if modified(home, r) == "same":
            out.append(r)
    return out


def attempted(pod_id: str, profile: str, package_id: str, version: str) -> bool:
    with _conn() as conn:
        return bool(conn.execute("SELECT 1 FROM market_update_auto WHERE pod=? AND profile=? AND package=? AND version=?",
                                 (pod_id, profile, package_id, version)).fetchone())


def auto_queue(rows: list[dict], home) -> int:
    """자동 올리기 줄을 시도 표에 먼저 적고(고유 키 — 두 번 요청하지 않는다) 대기 표에 넣는다."""
    made = 0
    for r in auto_targets(rows, home):
        with _conn() as conn:
            fresh = conn.execute("INSERT INTO market_update_auto (pod, profile, package, version, status, ts) VALUES (?,?,?,?,?,?) ON CONFLICT DO NOTHING",
                                 (r["pod"], r["profile"], r["package"], r["latest"], "queued", _now())).rowcount
        if not fresh:                                                 # 다른 주기·복제본이 먼저 적었다
            continue
        made += queue(r["pod"], [{"profile": r["profile"], "package": r["package"], "version": r["latest"]}], "aas", origin="auto")
    return made


def settle_auto_all(pod_ids: list[str]) -> None:
    """배달기가 끝낸 요청을 시도 표에 짝지어 적는다. 기다리는 줄은 질의 하나로 모두 읽고, 줄이 있는 작업공간만 요청을 본다 —
    리더가 5초마다 작업공간 수만큼 물었다(스펙 2026-10-26-002 R2·E8). 넘긴 목록에 없는 작업공간(지워진 것)의 줄은 건드리지 않는다."""
    wanted = set(pod_ids)
    if table_cache.quiet("updates.settle", ("market_update_auto",)):   # 기다리는 시도가 없고 표가 그대로다(§9-14)
        return
    token = table_cache.quiet_token(("market_update_auto",))
    with _conn() as conn:
        rows = [dict(r) for r in conn.execute("SELECT pod, profile, package, version, request FROM market_update_auto WHERE status='queued' AND request<>''")]
    if not rows:
        table_cache.mark_quiet("updates.settle", token)
    waiting: dict[str, list[dict]] = {}
    for r in rows:
        if r["pod"] in wanted:
            waiting.setdefault(r["pod"], []).append(r)
    for pod_id, items in waiting.items():
        _settle(pod_id, items)


def _settle(pod_id: str, waiting: list[dict]) -> None:
    """끝난 요청을 짝지어 적는다(done → done, failed → failed + 원인 한 줄)."""
    done = {str(r["id"]): r for r in marketplace.requests(pod_id, 2000) if r["status"] in ("done", "failed")}
    with _conn() as conn:
        for w in waiting:
            r = done.get(w["request"])
            if r is not None:
                conn.execute("UPDATE market_update_auto SET status=?, message=?, ts=? WHERE pod=? AND profile=? AND package=? AND version=?",
                             (r["status"], str(r.get("message") or "")[:300], _now(), pod_id, w["profile"], w["package"], w["version"]))


def auto_rows(pod_id: str) -> list[dict]:
    with _conn() as conn:
        return [dict(r) for r in conn.execute("SELECT profile, package, version, request, status, message, ts FROM market_update_auto WHERE pod=?", (pod_id,))]


def affected(rows: list[dict]) -> int:
    """자동 올리기를 켜면 올라갈 수 있는 프로파일 수(확인 창, D11) — 기본 스킬의 새 버전이 있는 프로파일. 고친 내용 판정 전이라 위쪽 어림이다."""
    defaults = set(marketplace.default_packages())
    return len({(r["pod"], r["profile"]) for r in alerts(rows) if r["package"] in defaults and r["kind"] == "skill"})


def auto_issues(pod_id: str, profile: str) -> list[dict]:
    """「확인할 것」 항목: 자동 올리기 실패(bad, 사람이 올리거나 다음 버전까지) · 저절로 올렸다는 안내(info, 7일 또는 사람이 확인할 때까지)."""
    since = (datetime.now().astimezone() - timedelta(days=NOTICE_DAYS)).isoformat(timespec="seconds")
    with _conn() as conn:
        rows = [dict(r) for r in conn.execute("SELECT package, version, status, message, ts FROM market_update_auto WHERE pod=? AND profile=? ORDER BY ts",
                                              (pod_id, profile))]
    out = []
    for r in rows:
        name = r["package"].split("/", 1)[-1]
        why = r["message"] or tr("원인 모름", "unknown cause")
        if r["status"] == "failed":
            out.append({"code": "market_auto_failed", "level": "bad", "package": r["package"], "version": r["version"],
                        "text": tr(f"{name} 스킬을 v{r['version']} 로 자동 업그레이드 하지 못했습니다. 스킬 허브에서 직접 업그레이드 하세요: {why}", f"Could not upgrade the {name} skill to v{r['version']} automatically: {why}")})
        elif r["status"] == "done" and str(r["ts"] or "") >= since:
            out.append({"code": "market_auto_done", "level": "info", "package": r["package"], "version": r["version"], "ack": True,   # 확인 버튼으로 뺄 수 있다
                        "text": tr(f"{name} 스킬을 v{r['version']} 로 자동 업그레이드 했습니다", f"{name} was upgraded to v{r['version']} automatically")})
    return out


def issue(profile: str, mine: list[dict]) -> dict:
    """「확인할 것」의 새 버전 항목 하나(안내 단계, D13). 누르면 스킬 허브 「새 버전 있음」 탭이 그 프로파일로 걸러져 열린다(D5)."""
    names = ", ".join(f"{m['skill']} {m['current']} → {m['latest']}" for m in mine[:5]) + (" …" if len(mine) > 5 else "")
    return {"code": "market_update", "level": "info", "n": len(mine),
            "text": tr(f"스킬 {len(mine)}개에 새 버전이 있습니다: {names}", f"{len(mine)} skills have a new version: {names}"),
            "to": {"view": "market", "params": {"tab": "updates", "scope": "pod", "q": profile}}}


# ---- 프로파일 이름 바꾸기·지우기를 따라간다(외부 검토 13) --------------------------------------------

def follow_profile(pod_id: str, profile: str, mode: str, to: str = "") -> None:
    from . import bundle_defaults
    bundle_defaults.follow_profile(pod_id, profile, mode, to)      # 기본 스킬 배달 기록도(스펙 2026-10-29-001 F8)
    with _conn() as conn:
        for table in ("market_update_skips", "market_update_pending", "market_update_auto"):
            if mode == "forget":
                conn.execute(f"DELETE FROM {table} WHERE pod=? AND profile=?", (pod_id, profile))
            elif mode == "rename" and to:
                conn.execute(f"UPDATE {table} SET profile=? WHERE pod=? AND profile=?", (to, pod_id, profile))

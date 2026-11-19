# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""게이트웨이를 다시 시작해야 반영되는 변경의 장부(스펙 2026-11-18-016 4-1~4-3).

  기록   AAS 가 Hermes 에 쓴 뒤 needs_restart 가 「필요」라고 한 변경만 add 한다. 값은 남기지 않고 이름만 남긴다.
  보기   items(pod) — 표 + 옛 메신저 장부(meta) + MindWiki 키 재발급(needs_apply) 을 합친다. 읽기만 한다.
  지우기 AAS 가 다시 시작하면 clear(요청 시각 전 기록), AAS 밖에서 다시 시작했으면 prune(게이트웨이 시작 시각 - 여유 전 기록).
  잠금   restart_gate(pod) — 다시 시작 요청이 작업공간마다 하나씩만 돈다. DB 행이라 AAS 서버가 여럿이어도 겹치지 않는다.

요청 하나 동안의 기록은 recording() 범위가 모은다. _profile_action 이 범위를 열고, 기록하는 곳은 note() 만 부른다.
"""
from __future__ import annotations

import concurrent.futures
import contextvars
import json
import os
import threading
import time
import uuid
from contextlib import contextmanager

from ..common import store
from ..common.redact import redact

KINDS = ("mcp", "channel", "pairing", "env", "config", "mindwiki")
CUT = 120                       # target·note 길이(4-3)
SHOW = 20                       # /api/me 에 싣는 기록 수(4-4)
STARTS_TTL = 15.0               # 게이트웨이 시작 시각 캐시(4-3)
READ_LIMIT = 2.0                # 사이드카에서 시작 시각을 읽는 시간 제한(4-3)
LOG_EVERY = 600.0               # 시작 시각을 읽지 못한 로그는 작업공간마다 10분에 한 번(4-3)
STARTS_FILE = "gateway-starts.log"
LEGACY_KEY = "messenger_restart:"   # 옛 메신저 장부(messenger_api). 이번 판 동안 items 가 함께 읽는다(4-3)


def skew() -> float:
    """AAS 서버와 Hermes 의 시계 차이 여유(초). 애매하면 기록을 남기는 쪽으로 쓴다."""
    try:
        return max(0.0, float(os.environ.get("AAS_RESTART_CLOCK_SKEW_S") or 5))
    except ValueError:
        return 5.0


def _cut(text) -> str:
    return str(text or "")[:CUT]


# ---- 판정 --------------------------------------------------------------------------------------------------------------

def _refs(cfg: dict, name: str) -> bool:
    """설정의 mcp_servers·platforms 값 어딘가에 ${name} 이 있는가."""
    token = "${" + name + "}"
    for key in ("mcp_servers", "platforms"):
        if token in json.dumps((cfg or {}).get(key) or {}, ensure_ascii=False, default=str):
            return True
    return False


def _section(cfg, key: str) -> dict:
    got = cfg.get(key) if isinstance(cfg, dict) else None
    return got if isinstance(got, dict) else {}


def needs_restart(kind: str, *, before=None, after=None, name: str = "", hot_served=None, managed: bool = False) -> list[tuple[str, str]]:
    """이 변경이 게이트웨이 다시 시작을 요구하면 기록할 (kind, target) 목록. Hermes 동작(2-2 표)이 바뀌면 여기만 고친다.
    mcp: 서버 항목 내용(name). channel: hot_served 가 거짓이면(name=플랫폼). pairing: 페어링 정책(name=플랫폼, 모르면 *).
    env: 채널 관리 변수(managed)이거나 before(원본 설정)의 mcp_servers·platforms 가 ${name} 으로 쓰면. before 가 None(읽기 실패)이면 기록한다.
    config: before·after(원본 설정 dict)를 비교해 platforms.<p> 는 channel, 있던 mcp_servers.<s> 의 내용 변경은 mcp. 더하기·지우기는 기록하지 않는다.
    mindwiki: 키 재발급."""
    if kind == "mcp":
        return [("mcp", _cut(name))] if name else []
    if kind == "channel":
        return [] if hot_served else [("channel", _cut(name or "*"))]
    if kind == "pairing":
        return [("pairing", _cut(name or "*"))]
    if kind == "env":
        if not name:
            return []
        return [("env", _cut(name))] if managed or before is None or _refs(before, name) else []
    if kind == "config":
        if not isinstance(before, dict) or not isinstance(after, dict):
            return [("config", "config.yaml")]                 # 비교할 원본을 읽지 못했다 — 놓치는 것보다 거짓 표시가 안전하다
        out = []
        b, a = _section(before, "platforms"), _section(after, "platforms")
        out += [("channel", _cut(p)) for p in sorted(set(b) | set(a)) if b.get(p) != a.get(p)]
        b, a = _section(before, "mcp_servers"), _section(after, "mcp_servers")
        out += [("mcp", _cut(s)) for s in sorted(set(b) & set(a)) if b.get(s) != a.get(s)]
        return out
    if kind == "mindwiki":
        return [("mindwiki", "mindwiki")]
    return []


# ---- 표 -----------------------------------------------------------------------------------------------------------------

def add(pod: str, profile: str, kind: str, target: str, note: str = "", by: str = "", *, by_kind: str = "person", now: float | None = None) -> None:
    """같은 (pod, profile, kind, target) 이면 한 줄을 고친다(시각·사람만 바뀐다). Hermes 쓰기가 성공한 뒤에만 부른다."""
    if kind not in KINDS:
        raise ValueError(kind)
    at = time.time() if now is None else now
    with store.connect() as conn:
        conn.execute("INSERT INTO restart_pending (pod, profile, kind, target, note, who, by_kind, ts) VALUES (?,?,?,?,?,?,?,?) "
                     "ON CONFLICT (pod, profile, kind, target) DO UPDATE SET note=excluded.note, who=excluded.who, by_kind=excluded.by_kind, ts=excluded.ts",
                     (pod, profile, kind, _cut(target), _cut(note), _cut(by), by_kind, at))


def _rows(pod: str) -> list[dict]:
    with store.connect() as conn:
        rows = conn.execute("SELECT profile, kind, target, note, who, by_kind, ts FROM restart_pending WHERE pod=?", (pod,)).fetchall()
    return [{"profile": r["profile"], "kind": r["kind"], "target": r["target"], "note": r["note"] or "", "by": r["who"] or "",
             "by_kind": r["by_kind"] or "person", "at": float(r["ts"] or 0)} for r in rows]


def _legacy(pod: str) -> list[str]:
    """옛 메신저 장부(meta 의 messenger_restart:<pod>)에 적힌 프로파일. 롤아웃 중 옛 서버가 아직 쓸 수 있다(4-3)."""
    with store.connect() as conn:
        row = conn.execute("SELECT value FROM meta WHERE key=?", (LEGACY_KEY + pod,)).fetchone()
    try:
        got = json.loads(row["value"]) if row else []
    except (ValueError, TypeError):
        got = []
    return [str(x) for x in got] if isinstance(got, list) else []


def _set_legacy(conn, pod: str, profiles: list[str]) -> None:
    if profiles:
        conn.execute("UPDATE meta SET value=? WHERE key=?", (json.dumps(sorted(set(profiles))), LEGACY_KEY + pod))
    else:
        conn.execute("DELETE FROM meta WHERE key=?", (LEGACY_KEY + pod,))


def _mindwiki(pod: str) -> list[dict]:
    from . import mindwiki_connect
    try:
        return [{"profile": r["profile"], "kind": "mindwiki", "target": "mindwiki", "note": "", "by": "", "by_kind": "auto", "at": r["at"]}
                for r in mindwiki_connect.pending_apply(pod)]
    except Exception as exc:                                    # MindWiki 표를 읽지 못해도 나머지 기록은 보인다
        print(f"MindWiki 적용 대기를 읽지 못했습니다({pod}): {type(exc).__name__}", flush=True)   # i18n-ignore: 로그
        return []


def all_items(pod: str, *, starts: dict | None = None) -> list[dict]:
    """작업공간의 모든 기록(최근 순). starts(프로파일 → 게이트웨이 시작 시각)를 주면 바깥 다시 시작으로 지워질 기록은 뺀다(읽기만)."""
    rows = _rows(pod)
    if starts:
        cut = skew()
        rows = [r for r in rows if not (starts.get(r["profile"]) and r["at"] < starts[r["profile"]] - cut)]
    have = {(r["profile"], r["kind"]) for r in rows}
    rows += [{"profile": p, "kind": "pairing", "target": "*", "note": "", "by": "", "by_kind": "auto", "at": 0.0}
             for p in _legacy(pod) if (p, "pairing") not in have]
    rows += _mindwiki(pod)
    rows.sort(key=lambda r: (-(r["at"] or 0), r["profile"], r["kind"], r["target"]))
    return rows


def items(pod: str, *, starts: dict | None = None) -> dict:
    """/api/me 의 모양: {items(최대 20, 최근 순), total}."""
    rows = all_items(pod, starts=starts)
    return {"items": rows[:SHOW], "total": len(rows)}


def profiles_with(pod: str, kinds: tuple = KINDS) -> list[str]:
    return sorted({r["profile"] for r in all_items(pod) if r["kind"] in kinds})


def prune(pod: str, starts: dict, *, now: float | None = None) -> int:
    """AAS 밖에서 다시 시작했다: 프로파일마다 게이트웨이 시작 시각보다 여유 넘게 먼저 쓴 기록을 지운다. MindWiki 는 이 표에 없다(D7)."""
    cut, n = skew(), 0
    with store.connect() as conn:
        for profile, started in (starts or {}).items():
            if started:
                n += conn.execute("DELETE FROM restart_pending WHERE pod=? AND profile=? AND ts<?", (pod, profile, float(started) - cut)).rowcount
    return n


def clear(pod: str, profiles: list[str] | None, before: float) -> int:
    """AAS 가 다시 시작했다: 그 게이트웨이가 맡은 프로파일(None 이면 작업공간 전체)의 기록 가운데 요청 시각 전에 쓴 것만 지운다."""
    with store.connect() as conn:
        if profiles is None:
            n = conn.execute("DELETE FROM restart_pending WHERE pod=? AND ts<?", (pod, before)).rowcount
        else:
            n = sum(conn.execute("DELETE FROM restart_pending WHERE pod=? AND profile=? AND ts<?", (pod, p, before)).rowcount for p in profiles)
        legacy = _legacy(pod)
        if legacy:
            _set_legacy(conn, pod, [] if profiles is None else [p for p in legacy if p not in profiles])
    ctx = _CTX.get()
    if ctx is not None and ctx["pod"] == pod:                   # 같은 요청 안의 다시 시작(템플릿 MCP 켜기)이 반영했다 — 응답에 싣지 않는다
        ctx["made"] = [m for m in ctx["made"] if profiles is not None and m[0] not in profiles]
    return n


def dismiss(pod: str, profile: str, kind: str, target: str) -> int:
    """사람이 「반영됨으로 표시」. 없는 기록도 0 으로 끝난다(멱등)."""
    with store.connect() as conn:
        n = conn.execute("DELETE FROM restart_pending WHERE pod=? AND profile=? AND kind=? AND target=?", (pod, profile, kind, target)).rowcount
        if kind == "pairing" and target == "*":
            legacy = _legacy(pod)
            if profile in legacy:
                _set_legacy(conn, pod, [p for p in legacy if p != profile])
                n += 1
    return n


def dismiss_all(pod: str) -> int:
    """「모두 반영됨으로 표시」. MindWiki 줄은 빼고 지운다(4-3)."""
    with store.connect() as conn:
        n = conn.execute("DELETE FROM restart_pending WHERE pod=?", (pod,)).rowcount
        _set_legacy(conn, pod, [])
    return n


def rename(pod: str, old: str, new: str) -> None:
    """프로파일 이름을 바꿨다: 기록이 새 이름을 따라간다. 새 이름에 같은 열쇠가 있으면 덮어쓴다."""
    with store.connect() as conn:
        rows = conn.execute("SELECT kind, target, note, who, by_kind, ts FROM restart_pending WHERE pod=? AND profile=?", (pod, old)).fetchall()
        for r in rows:
            conn.execute("INSERT INTO restart_pending (pod, profile, kind, target, note, who, by_kind, ts) VALUES (?,?,?,?,?,?,?,?) "
                         "ON CONFLICT (pod, profile, kind, target) DO UPDATE SET note=excluded.note, who=excluded.who, by_kind=excluded.by_kind, ts=excluded.ts",
                         (pod, new, r["kind"], r["target"], r["note"], r["who"], r["by_kind"], r["ts"]))
        conn.execute("DELETE FROM restart_pending WHERE pod=? AND profile=?", (pod, old))


def drop(pod: str, profile: str | None = None) -> None:
    """작업공간(profile=None)이나 프로파일을 지웠다."""
    with store.connect() as conn:
        if profile is None:
            conn.execute("DELETE FROM restart_pending WHERE pod=?", (pod,))
            conn.execute("DELETE FROM restart_lock WHERE pod=?", (pod,))
            conn.execute("DELETE FROM meta WHERE key=?", (LEGACY_KEY + pod,))
        else:
            conn.execute("DELETE FROM restart_pending WHERE pod=? AND profile=?", (pod, profile))
    with _starts_lock:
        if profile is None:
            _starts.pop(pod, None)


def migrate_meta() -> int:
    """옛 메신저 장부를 이 표로 옮긴다(서버 시작 때 한 번). 표에 쓰기(겹치면 무시) → meta 지우기 — 여러 서버가 동시에 돌려도 같다."""
    moved = 0
    try:
        with store.connect() as conn:
            keys = [r["key"] for r in conn.execute("SELECT key FROM meta WHERE key LIKE ?", (LEGACY_KEY + "%",)).fetchall()]
        for key in keys:
            pod = key[len(LEGACY_KEY):]
            now = time.time()
            with store.connect() as conn:
                for p in _legacy(pod):
                    moved += conn.execute("INSERT INTO restart_pending (pod, profile, kind, target, note, who, by_kind, ts) VALUES (?,?,?,?,?,?,?,?) "
                                          "ON CONFLICT (pod, profile, kind, target) DO NOTHING", (pod, p, "pairing", "*", "", "", "auto", now)).rowcount
                conn.execute("DELETE FROM meta WHERE key=?", (key,))
    except Exception as exc:                                    # 서버 시작을 막지 않는다
        print(f"옛 메신저 다시 시작 장부를 옮기지 못했습니다: {type(exc).__name__}", flush=True)   # i18n-ignore: 로그
    return moved


# ---- 요청 하나의 기록 범위 -------------------------------------------------------------------------------------------------

_CTX: contextvars.ContextVar[dict | None] = contextvars.ContextVar("aas_restart_pending", default=None)


@contextmanager
def recording(pod: str, profile: str, by: str):
    """이 요청에서 생긴 기록을 모은다. 바깥 범위가 있으면 그것을 그대로 쓴다(템플릿 자동 다시 시작처럼 안쪽에서 다시 부를 때)."""
    cur = _CTX.get()
    if cur is not None and cur["pod"] == pod:
        prev = cur["profile"]
        cur["profile"] = profile
        try:
            yield cur
        finally:
            cur["profile"] = prev
        return
    state = {"pod": pod, "profile": profile, "by": by, "made": [], "unrecorded": False}
    token = _CTX.set(state)
    try:
        yield state
    finally:
        _CTX.reset(token)


def note(pairs: list[tuple[str, str]], note_text: str = "", *, pod: str = "", profile: str = "") -> None:
    """기록하는 곳이 부른다. 범위 밖이면 pod·profile 을 직접 받는다(메신저 페어링 맞추기). DB 오류는 로그만 남기고 원 요청은 성공으로 둔다."""
    ctx = _CTX.get()
    pod = pod or (ctx or {}).get("pod") or ""
    profile = profile or (ctx or {}).get("profile") or ""
    if not pod or not profile or not pairs:
        return
    by = (ctx or {}).get("by") or ""
    by_kind = "mcp_tool" if store.actor_via.get() == "token" else ("person" if by else "auto")
    for kind, target in pairs:
        try:
            add(pod, profile, kind, target, note_text, by, by_kind=by_kind)
            if kind == "channel" and ctx is not None and (profile, "pairing", target) in [(p, k, t) for p, k, t in ctx["made"]]:
                with store.connect() as conn:                   # 한 요청이 channel 과 pairing 을 함께 만들면 channel 한 줄(4-3)
                    conn.execute("DELETE FROM restart_pending WHERE pod=? AND profile=? AND kind='pairing' AND target=?", (pod, profile, target))
                ctx["made"] = [m for m in ctx["made"] if m != (profile, "pairing", target)]
        except Exception as exc:
            print(f"다시 시작 기록을 남기지 못했습니다({pod} {profile} {kind} {target}): {type(exc).__name__}", flush=True)   # i18n-ignore: 로그
            if ctx is not None:
                ctx["unrecorded"] = True
            continue
        if ctx is not None and (profile, kind, target) not in ctx["made"]:
            ctx["made"].append((profile, kind, target))


def outcome(state: dict | None):
    """응답에 실을 restart_pending: 기록이 생겼으면 [{profile, kind, target}], 기록에 실패했으면 "unrecorded", 없으면 None."""
    if not state:
        return None
    if state["unrecorded"]:
        return "unrecorded"
    return [{"profile": p, "kind": k, "target": t} for p, k, t in state["made"]] or None


# ---- 게이트웨이 시작 시각(바깥 다시 시작 판별) ---------------------------------------------------------------------------

_starts_lock = threading.Lock()
_starts: dict[str, tuple[float, dict | None]] = {}      # pod → (읽은 시각, 프로파일 → 시작 시각 또는 None=읽기 실패)
_refreshing: set[str] = set()
_logged: dict[str, float] = {}
_pool = concurrent.futures.ThreadPoolExecutor(max_workers=4, thread_name_prefix="aas-restart-starts")


def last_start(text: str) -> float | None:
    """gateway-starts.log(Hermes 가 시작마다 에포크 초를 한 줄씩, 마지막 40줄 안팎만 남긴다)의 마지막 시작 시각."""
    for line in reversed(str(text or "").splitlines()):
        try:
            return float(line.strip())
        except ValueError:
            continue
    return None


def read_starts(home, *, shared_all: bool) -> dict:
    """프로파일 이름 → 그 게이트웨이의 마지막 시작 시각. shared_all(쿠버네티스)이면 모두 루트 게이트웨이의 시각이다.
    compose 의 이름 있는 프로파일은 자기 폴더(HERMES_HOME)에 파일이 생긴다."""
    from ..hermes import hermes_reader as hr, readers
    root_home = home or hr.hermes_home()
    profs = hr.profiles(home)
    texts = readers.read_texts([root_home / STARTS_FILE] + [p.path / STARTS_FILE for p in profs])
    root = last_start(texts[0])
    return {p.name: (root if shared_all or p.path == root_home else last_start(texts[1 + i])) for i, p in enumerate(profs)}


def _log_once(pod: str, what: str, exc: Exception) -> None:
    now = time.time()
    if now - _logged.get(pod, 0) < LOG_EVERY:
        return
    _logged[pod] = now
    print(f"게이트웨이 시작 시각을 읽지 못했습니다({pod} {what}): {type(exc).__name__} {redact(str(exc), 200)}", flush=True)   # i18n-ignore: 로그


def cached_starts(pod: str) -> dict | None:
    with _starts_lock:
        hit = _starts.get(pod)
    return hit[1] if hit else None


def refresh_starts(pod: str, reader, *, where: str = "", now: float | None = None) -> dict | None:
    """시작 시각을 읽어(READ_LIMIT 안에) 캐시하고 prune 한다. 읽지 못하면 지우지 않고 그 실패도 캐시한다."""
    fut = _pool.submit(contextvars.copy_context().run, reader)
    try:
        got = fut.result(timeout=READ_LIMIT)
    except Exception as exc:
        _log_once(pod, where, exc)
        got = None
    with _starts_lock:
        _starts[pod] = (time.time() if now is None else now, got)
    if got:
        try:
            prune(pod, got)
        except Exception as exc:
            _log_once(pod, "prune", exc)
    return got


def starts_for_view(pod: str, reader, *, where: str = "") -> dict | None:
    """/api/me 가 부른다: 캐시한 시작 시각을 돌려주고, 15초보다 오래됐으면 백그라운드 갱신을 한 번 건다(응답을 기다리게 하지 않는다)."""
    now = time.time()
    with _starts_lock:
        hit = _starts.get(pod)
        stale = hit is None or now - hit[0] >= STARTS_TTL
        go = stale and pod not in _refreshing
        if go:
            _refreshing.add(pod)
    if go:
        def run():
            try:
                refresh_starts(pod, reader, where=where)
            finally:
                with _starts_lock:
                    _refreshing.discard(pod)
        threading.Thread(target=contextvars.copy_context().run, args=(run,), daemon=True, name="aas-restart-pending").start()
    return hit[1] if hit else None


def forget_starts(pod: str) -> None:
    with _starts_lock:
        _starts.pop(pod, None)


# ---- 작업공간마다 다시 시작 하나(4-4) --------------------------------------------------------------------------------------

class Locked(Exception):
    def __init__(self, retry_after: int):
        super().__init__(f"locked {retry_after}s")
        self.retry_after = retry_after


_HELD: contextvars.ContextVar[dict | None] = contextvars.ContextVar("aas_restart_gate", default=None)


class _Gate:
    def __init__(self, pod: str, token: str, step: float):
        self.pod, self.token, self.step = pod, token, step

    def extend(self, seconds: float | None = None) -> None:
        """대상 하나를 시작할 때 만료를 늘린다."""
        with store.connect() as conn:
            conn.execute("UPDATE restart_lock SET expires=? WHERE pod=? AND token=?", (time.time() + (seconds or self.step), self.pod, self.token))


@contextmanager
def restart_gate(pod: str, *, targets: int = 1, step: float = 60.0, now: float | None = None):
    """잠금을 얻는다. 다른 요청이 쥐고 있으면 Locked(남은 초). 같은 요청 안에서 다시 들어오면(apply → mcp_apply) 그대로 지난다.
    만료 = 대상 수 × step(Hermes 다시 시작 요청 시간 제한) + 30초. 성공·실패 모두 finally 에서 푼다."""
    held = _HELD.get() or {}
    if pod in held:
        yield held[pod]
        return
    at = time.time() if now is None else now
    token = uuid.uuid4().hex
    with store.connect() as conn:
        conn.execute("INSERT INTO restart_lock (pod, expires, token) VALUES (?,?,?) "
                     "ON CONFLICT (pod) DO UPDATE SET expires=excluded.expires, token=excluded.token WHERE restart_lock.expires < ?",
                     (pod, at + max(1, targets) * step + 30, token, at))
        row = conn.execute("SELECT expires, token FROM restart_lock WHERE pod=?", (pod,)).fetchone()
    if row is None or row["token"] != token:
        raise Locked(max(1, int((float(row["expires"]) if row else at) - at + 0.999)))
    gate = _Gate(pod, token, step)
    mark = _HELD.set({**held, pod: gate})
    try:
        yield gate
    finally:
        _HELD.reset(mark)
        try:
            with store.connect() as conn:
                conn.execute("DELETE FROM restart_lock WHERE pod=? AND token=?", (pod, token))
        except Exception as exc:                                # 만료가 대신 푼다
            print(f"다시 시작 잠금을 풀지 못했습니다({pod}): {type(exc).__name__}", flush=True)   # i18n-ignore: 로그

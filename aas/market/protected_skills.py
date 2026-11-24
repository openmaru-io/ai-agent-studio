# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""보호 스킬 — 고객사 전용 스킬을 켠 프로파일에만 배달하고 바뀐 사본을 원본으로 되돌린다(cogentai-aas-docs 스펙 2026-11-21-003).

  자리      aas/assets/protected_skills/<이름>/ (SKILL.md + 그 밖 파일). 기본 스킬 묶음(aas_skill_packages)과 따로 둔다 —
            skill_bundle.names()·enabled_names()·build_lock 은 이 폴더를 모른다(기본 묶음 동작은 그대로, 스펙 G5).
            폴더째 공개본에서 뺀다(.gitattributes 두 줄). 공개본에는 폴더가 없어 보호 스킬이 없다.
  판        SKILL.md 머리말 version. 잠금은 그 폴더의 versions.lock.json(꼴은 skill_bundle 과 같다 — 판을 올리지 않고 내용을
            고치면 lock 이 거절한다).
  설정      보호 스킬마다 설치 값 하나. 이름 표는 사내 전용 aas/common/edition.py 의 PROTECTED_SKILLS(없으면 빈 표).
            설치 값을 켠 설치에만 목록·스위치·배달에 보인다(protected_enabled).

  python -m aas.market.protected_skills lock    잠금 파일을 다시 쓴다(판을 올린 뒤)
  python -m aas.market.protected_skills check   보호 스킬을 더하거나 판을 올린 뒤 빠진 곳을 찾는다(make check-protected-skills)
"""
from __future__ import annotations

import fcntl
import hashlib
import importlib
import json
import re
import sys
import threading
import time
import traceback
from contextlib import contextmanager
from datetime import datetime
from pathlib import Path

from ..common import store
from ..common.i18n import tr
from . import skill_bundle

REPO = Path(__file__).resolve().parents[2]
PROTECTED_DIR = REPO / "aas" / "assets" / "protected_skills"
LOCK = "versions.lock.json"
ATTRIBUTES = REPO / ".gitattributes"
RULES = REPO / "bin" / "export-public" / "rules.txt"
_DIR_REL = "aas/assets/protected_skills"

try:                                        # 공개본에는 사내 전용 모듈이 없다(skill_bundle 과 같은 꼴)
    _edition = importlib.import_module("aas.common.edition")
except ModuleNotFoundError as exc:
    if exc.name != "aas.common.edition":
        raise
    _edition = None
SETTINGS: dict[str, str] = dict(getattr(_edition, "PROTECTED_SKILLS", {}) or {})   # 스킬 이름 → 설치 값 이름


def protected_names(root: Path = PROTECTED_DIR) -> list[str]:
    """폴더에 있는 보호 스킬 전체(설치 값과 상관없음). 허브 같은 이름 올리기 거절도 이것으로 본다."""
    if not root.is_dir():
        return []
    return skill_bundle.names(root)


def protected_enabled(root: Path = PROTECTED_DIR, settings: dict[str, str] | None = None) -> list[str]:
    """설치 값을 켠 보호 스킬 — 목록·스위치·배달이 쓴다. 표에 설정 이름이 없는 스킬은 켜지 않는다."""
    table = SETTINGS if settings is None else settings
    return [n for n in protected_names(root) if n in table and skill_bundle._on(table[n])]


def read_lock(root: Path = PROTECTED_DIR) -> dict:
    path = root / LOCK
    return json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}


def write_lock(root: Path = PROTECTED_DIR) -> dict:
    """잠금 파일을 다시 쓴다. 판이 같은데 내용이 바뀐 스킬이 있으면 skill_bundle.BundleError."""
    lock = skill_bundle.build_lock(root, read_lock(root))
    skill_bundle._write_json(root / LOCK, lock)
    return lock


def _rules(path: Path) -> list[re.Pattern]:
    out = []
    for raw in path.read_text(encoding="utf-8").splitlines():
        parts = raw.strip().split(None, 2)
        if len(parts) == 3 and parts[0] == "deny":
            out.append(re.compile(parts[2]))
    return out


def check(root: Path = PROTECTED_DIR, settings: dict[str, str] | None = None,
          attributes: Path = ATTRIBUTES, rules: Path = RULES, dir_rel: str = _DIR_REL) -> list[str]:
    """빠진 곳 목록(빈 목록이면 통과). 보호 스킬이 없으면(공개본 포함) 볼 것이 없다.
    잠금 줄·판·sha, 설정 이름 표(양쪽), .gitattributes 의 폴더 두 줄, 공개 흔적 규칙이 스킬 이름과 설정 이름을 잡는지."""
    table = SETTINGS if settings is None else settings
    names = protected_names(root)
    problems: list[str] = []
    for name in sorted(set(table) - set(names)):
        problems.append(f"{name}: 설정 이름 표에는 있는데 {dir_rel}/{name}/SKILL.md 가 없습니다")   # i18n-ignore: 개발자 점검 명령의 출력
    if not names:
        return problems
    try:
        built = skill_bundle.build_lock(root, read_lock(root))
    except skill_bundle.BundleError as err:
        problems.append(str(err))
        built = None
    if built is not None and built != read_lock(root):
        problems.append(f"{dir_rel}/{LOCK} 이 원본과 다릅니다. python -m aas.market.protected_skills lock 으로 다시 쓰세요")   # i18n-ignore: 개발자 점검 명령의 출력
    for name in names:
        if name not in table:
            problems.append(f"{name}: 설정 이름 표(aas/common/edition.py PROTECTED_SKILLS)에 없습니다")   # i18n-ignore: 개발자 점검 명령의 출력
    lines = {tuple(l.split()) for l in attributes.read_text(encoding="utf-8").splitlines()} if attributes.exists() else set()
    for pattern in (dir_rel, f"{dir_rel}/**"):
        if (pattern, "export-ignore") not in lines:
            problems.append(f".gitattributes 에 「{pattern} export-ignore」 줄이 없습니다(공개본에 보호 스킬이 나갑니다)")   # i18n-ignore: 개발자 점검 명령의 출력
    for name in names:                                       # 원본에 설치 규칙 절 제목이 있으면 사본 끝 절이 두 번 생긴다(스펙 2026-11-24-001 5절)
        if _has_rules_heading(_source_md(name, root)):
            problems.append(f"{name}: 원본 SKILL.md 에 「{RULES_TITLE}」 제목 절이 있습니다. 이 절은 AAS 가 사본에만 붙입니다")   # i18n-ignore: 개발자 점검 명령의 출력
    deny = _rules(rules) if rules.exists() else []
    for name in names:
        for word in (name, table.get(name, "")):
            if word and not any(r.search(word) for r in deny):
                problems.append(f"{word}: 공개 흔적 규칙(bin/export-public/rules.txt)이 이 낱말을 잡지 않습니다")   # i18n-ignore: 개발자 점검 명령의 출력
    return problems



# ---- 3단계: 기록 표·잠금·쓰기·점검·되돌리기(스펙 §3-2·§3-3) ------------------------------------------------------------
#
#   표        protected_skill = (파드, 프로파일, 스킬) → 상태 on·off·failed·retired, 쓴 판, 파일마다 sha·(크기, 수정 시각).
#             행이 없으면 꺼짐. 켜기·끄기는 행만 바꾸고(set_enabled) 실제 쓰기·지우기는 리더의 주기(cycle)가 한다.
#   쓰기      Hermes 파일 API 로 profiles/<p>/skills/protected/<이름>/ 에, SKILL.md 를 마지막에.
#   점검      주기마다 폴더 목록으로 크기·수정 시각이 기록과 다른 파일만 읽고, 행마다 FULL_EVERY 에 한 번은 모든 파일을 읽어 sha 를 견준다
#             (크기·시각은 touch -r 로 맞출 수 있다). 다르거나 없거나 원본에 없는 파일이 있으면 원본으로 되돌린다.
#   판 바뀜   원본 sha 가 기록과 다르면 새 원본을 쓴다 — 알림 없이 로그 protected_skill_version_changed 하나.
#   retire    설치 값을 끄거나 원본이 사라지면 사본만 지우고 행은 retired. 다시 켜지면 on 으로 되살린다.

INTERVAL = 60.0          # 주기(초). AAS_PROTECTED_SKILL_INTERVAL_S 로 바꾼다
FULL_EVERY = 300.0       # 행마다 모든 파일 sha 를 견주는 간격
NAME_EVERY = 300.0       # 같은 이름 스킬·Hermes 쪽 끔을 보는 간격(GET /api/skills 는 호출당 1~2초)
ORPHAN_EVERY = 600.0     # 행 없는 사본 정리 간격
ORPHAN_MAX = 3           # 한 번에 지우는 행 없는 사본 상한 — 넘으면 지우지 않고 알린다(DB 를 비운 뒤 정상 사본을 모두 지우지 않게)
BUDGET = 60.0            # 주기 한 번의 상한(초). 넘으면 남은 행을 다음 주기로 미룬다
BACKOFF_MAX = 600.0      # 쓰기 실패 뒤 다시 하는 간격 상한
FAIL_NOTICE = 3          # 이어진 실패 몇 번째에 「확인할 것」에 보이나
STALL = 300.0            # 마지막으로 끝난 주기가 이만큼 지나면 멈춘 것으로 본다
SCHEMA = """
CREATE TABLE IF NOT EXISTS protected_skill (
  pod TEXT NOT NULL, profile TEXT NOT NULL, skill TEXT NOT NULL, state TEXT NOT NULL, version TEXT NOT NULL DEFAULT '',
  files TEXT NOT NULL DEFAULT '{}', meta TEXT NOT NULL DEFAULT '{}', failures INTEGER NOT NULL DEFAULT 0,
  last_error_code TEXT NOT NULL DEFAULT '', last_error TEXT NOT NULL DEFAULT '', next_try_at REAL NOT NULL DEFAULT 0,
  check_requested_at REAL NOT NULL DEFAULT 0, last_restored_at TEXT NOT NULL DEFAULT '', last_full_at REAL NOT NULL DEFAULT 0,
  ts TEXT, PRIMARY KEY (pod, profile, skill));
CREATE TABLE IF NOT EXISTS protected_skill_notice (
  pod TEXT NOT NULL, profile TEXT NOT NULL, skill TEXT NOT NULL, kind TEXT NOT NULL, version TEXT NOT NULL DEFAULT '',
  text TEXT NOT NULL, level TEXT NOT NULL DEFAULT 'warn', ts TEXT, PRIMARY KEY (pod, profile, skill, kind, version));
CREATE TABLE IF NOT EXISTS protected_skill_rules (
  pod TEXT NOT NULL, profile TEXT NOT NULL, skill TEXT NOT NULL, rev INTEGER NOT NULL, text TEXT NOT NULL,
  base_version TEXT NOT NULL DEFAULT '', author TEXT NOT NULL DEFAULT '', note TEXT NOT NULL DEFAULT '',
  clone_of TEXT NOT NULL DEFAULT '', base_fixed_sha TEXT NOT NULL DEFAULT '', ts TEXT, PRIMARY KEY (pod, profile, skill, rev));
"""
_TOKENISH = re.compile(r"(?i)(bearer\s+)?[A-Za-z0-9_\-]{24,}")
_state = {"last_done": 0.0, "last_names": 0.0, "last_orphan": 0.0}
_cycle_lock = threading.Lock()


class ProtectedError(Exception):
    """켜기·끄기 거절(스펙 §3-2 거절 표). code = MCP ToolError 코드, status = HTTP 상태."""

    def __init__(self, code: str, status: int, message: str):
        super().__init__(message)
        self.code, self.status = code, status


def _now() -> str:
    return datetime.now().astimezone().isoformat(timespec="seconds")


def _conn():
    conn = store.connect()
    conn.executescript(SCHEMA)
    return conn


def interval() -> float:
    try:
        return max(5.0, float(skill_bundle.config.get("AAS_PROTECTED_SKILL_INTERVAL_S", "") or INTERVAL))
    except ValueError:
        return INTERVAL


def reset() -> None:
    """시험용: 주기 시각을 처음으로."""
    _state.update(last_done=0.0, last_names=0.0, last_orphan=0.0)


def _row(pod: str, profile: str, skill: str) -> dict | None:
    with _conn() as conn:
        r = conn.execute("SELECT * FROM protected_skill WHERE pod=? AND profile=? AND skill=?", (pod, profile, skill)).fetchone()
    return dict(r) if r else None


def rows(pod: str | None = None) -> list[dict]:
    with _conn() as conn:
        q = "SELECT * FROM protected_skill" + (" WHERE pod=?" if pod else "") + " ORDER BY pod, profile, skill"
        return [dict(r) for r in conn.execute(q, (pod,) if pod else ())]


def _save(row: dict) -> None:
    keys = ("pod", "profile", "skill", "state", "version", "files", "meta", "failures", "last_error_code", "last_error",
            "next_try_at", "check_requested_at", "last_restored_at", "last_full_at", "ts")
    full = {"version": "", "files": "{}", "meta": "{}", "failures": 0, "last_error_code": "", "last_error": "", "next_try_at": 0.0,
            "check_requested_at": 0.0, "last_restored_at": "", "last_full_at": 0.0, **row, "ts": _now()}
    sets = ", ".join(f"{k}=excluded.{k}" for k in keys[3:])
    with _conn() as conn:
        conn.execute(f"INSERT INTO protected_skill ({', '.join(keys)}) VALUES ({', '.join('?' * len(keys))}) "
                     f"ON CONFLICT(pod, profile, skill) DO UPDATE SET {sets}", tuple(full[k] for k in keys))


def _delete_row(pod: str, profile: str, skill: str) -> None:
    with _conn() as conn:
        conn.execute("DELETE FROM protected_skill WHERE pod=? AND profile=? AND skill=?", (pod, profile, skill))
        conn.execute("DELETE FROM protected_skill_notice WHERE pod=? AND profile=? AND skill=?", (pod, profile, skill))
        conn.execute("DELETE FROM protected_skill_rules WHERE pod=? AND profile=? AND skill=?", (pod, profile, skill))


def _notice(pod: str, profile: str, skill: str, kind: str, text: str, version: str = "", level: str = "warn") -> None:
    """「확인할 것」 한 줄. 같은 키로 다시 생기면 글과 시각만 갱신한다."""
    with _conn() as conn:
        conn.execute("INSERT INTO protected_skill_notice (pod, profile, skill, kind, version, text, level, ts) VALUES (?,?,?,?,?,?,?,?) "
                     "ON CONFLICT(pod, profile, skill, kind, version) DO UPDATE SET text=excluded.text, level=excluded.level, ts=excluded.ts",
                     (pod, profile, skill, kind, version, text[:500], level, _now()))


def _clear_notice(pod: str, profile: str, skill: str, kind: str) -> None:
    with _conn() as conn:
        conn.execute("DELETE FROM protected_skill_notice WHERE pod=? AND profile=? AND skill=? AND kind=?", (pod, profile, skill, kind))


def issues(pod: str, profile: str) -> list[dict]:
    """프로파일 「확인할 것」 항목(bundle_local.issues 와 같은 꼴)."""
    with _conn() as conn:
        found = [dict(r) for r in conn.execute("SELECT * FROM protected_skill_notice WHERE pod=? AND profile=? ORDER BY ts", (pod, profile))]
    out = [{"code": f"protected_skill_{n['kind']}", "level": n["level"], "package": n["skill"], "version": n["version"], "text": n["text"]}
           for n in found]
    if _state["last_done"] and time.time() - _state["last_done"] > STALL and any(r["profile"] == profile for r in rows(pod)):
        out.append({"code": "protected_skill_stalled", "level": "bad", "package": "", "version": "",
                    "text": tr("보호 스킬 점검이 5분 넘게 돌지 않았습니다. AAS 서버 로그의 protected_skill_cycle_error 를 확인하세요",
                               "Protected skill checks have not run for over 5 minutes. Check protected_skill_cycle_error in the AAS server log")})
    return out


def status(pod: str, profile: str, skill: str) -> dict | None:
    """skills_list·skill_get 의 protected 값. 행이 없으면 None(꺼짐)."""
    r = _row(pod, profile, skill)
    if not r:
        return None
    state = "pending" if r["state"] == "on" and not json.loads(r["files"] or "{}") else r["state"]
    return {"state": state, "version": r["version"], "last_restored_at": r["last_restored_at"], "failures": r["failures"],
            "last_error_code": r["last_error_code"], "rules": rules_summary(pod, profile, skill)}


def set_enabled(pod: str, profile: str, skill: str, enabled: bool, *, settings: dict[str, str] | None = None,
                root: Path = PROTECTED_DIR, listed: list[dict] | None = None) -> dict:
    """켜기·끄기는 행만 바꾼다(쓰기는 리더 주기). 같은 값으로 다시 켜면 바로 점검을 부탁한다(check_requested_at).
    listed = 그 프로파일의 Hermes 스킬 목록. 처음 켤 때(켜져 있지 않던 행) 보호 자리 밖에 같은 이름이 있으면 거절한다(§3-2 conflict) —
    켠 뒤 생긴 같은 이름은 주기가 알린다. 권한은 부르는 쪽(화면 API 의 may_change_profile)이 먼저 본다."""
    if skill not in protected_enabled(root, settings):
        raise ProtectedError("not_found", 404, tr(f"{skill} 스킬이 없습니다", f"There is no skill named {skill}"))
    if not profile or profile == "default":
        raise ProtectedError("invalid", 400, tr(
            "보호 스킬은 이름 있는 프로파일에서만 켤 수 있습니다. 예: skill_toggle profile=<프로파일> name=<스킬> enabled=true",
            "Protected skills can be turned on only in a named profile. Example: skill_toggle profile=<profile> name=<skill> enabled=true"))
    row = _row(pod, profile, skill) or {"pod": pod, "profile": profile, "skill": skill, "state": "off"}
    if enabled and row["state"] not in ("on", "failed") and listed:
        where = duplicates(listed, skill)
        if where:
            raise ProtectedError("conflict", 409, tr(f"{', '.join(where)} 에 같은 이름 스킬이 있습니다. 이름을 바꾸거나 지운 뒤 다시 켜세요",
                                                     f"A skill with the same name is at {', '.join(where)}. Rename or delete it, then turn this on again"))
    if enabled:
        if row["state"] in ("on", "failed"):
            row["check_requested_at"] = time.time()
        else:
            row.update(state="on", failures=0, next_try_at=0.0, check_requested_at=time.time())
    else:
        row.update(state="off", check_requested_at=time.time())
    _save(row)
    applied = enabled and row["state"] == "on" and bool(json.loads(row.get("files") or "{}"))
    return {"kind": "protected", "enabled": enabled, "applied": applied if enabled else not json.loads(row.get("files") or "{}"),
            "state": ("on" if applied else "pending") if enabled else "off", "next_check_within_s": int(interval())}


def rename_profile(pod: str, old: str, new: str) -> None:
    with _conn() as conn:
        conn.execute("UPDATE protected_skill SET profile=? WHERE pod=? AND profile=?", (new, pod, old))
        conn.execute("UPDATE protected_skill_notice SET profile=? WHERE pod=? AND profile=?", (new, pod, old))
        conn.execute("UPDATE protected_skill_rules SET profile=? WHERE pod=? AND profile=?", (new, pod, old))
        conn.execute("UPDATE protected_skill_rules SET clone_of=? WHERE pod=? AND clone_of=?", (new, pod, old))   # 복제본이 가리키는 원래 프로파일


def forget_profile(pod: str, profile: str) -> None:
    with _conn() as conn:
        conn.execute("DELETE FROM protected_skill WHERE pod=? AND profile=?", (pod, profile))
        conn.execute("DELETE FROM protected_skill_notice WHERE pod=? AND profile=?", (pod, profile))
        conn.execute("DELETE FROM protected_skill_rules WHERE pod=? AND profile=?", (pod, profile))


def requested() -> bool:
    """바로 점검을 부탁한 행이 있나(리더 스레드가 5초마다 본다)."""
    with _conn() as conn:
        return conn.execute("SELECT 1 FROM protected_skill WHERE check_requested_at > 0 LIMIT 1").fetchone() is not None


@contextmanager
def protected_lock(pod: str, profile: str, wait: float = 0.0):
    """(파드, 프로파일) 단위 잠금. 주기는 wait=0(못 잡으면 False 를 받고 건너뜀), 복제 단계는 wait=10 으로 기다린다.
    공유 데이터 폴더(NFS)의 flock 은 읽기로도 연 파일이어야 해 "a+" 로 연다(marketplace.create_lock 과 같다)."""
    d = store.data_dir() / "market" / "protected-locks"
    d.mkdir(parents=True, exist_ok=True)
    safe = re.sub(r"[^A-Za-z0-9_.-]", "_", f"{pod}__{profile}")[:160]
    with open(d / f"{safe}.lock", "a+") as fh:
        end = time.monotonic() + wait
        while True:
            try:
                fcntl.flock(fh, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if time.monotonic() >= end:
                    yield False
                    return
                time.sleep(0.2)
        try:
            yield True
        finally:
            fcntl.flock(fh, fcntl.LOCK_UN)


def _sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def source_files(skill: str, root: Path = PROTECTED_DIR) -> list[tuple[str, bytes]]:
    """(상대 경로, 내용) — SKILL.md 를 맨 끝에."""
    pkg = root / skill
    files = [(p.relative_to(pkg).as_posix(), p.read_bytes()) for p in skill_bundle._files(pkg)]
    return sorted(files, key=lambda f: (f[0] == "SKILL.md", f[0]))


def _base(profile: str, skill: str) -> str:
    return f"profiles/{profile}/skills/protected/{skill}"


def _walk(ops, base: str) -> dict[str, tuple] | None:
    """사본 폴더의 파일 → (크기, 수정 시각). 폴더가 없으면 None. Hermes 목록은 한 단계라 하위 폴더를 따라 내려간다."""
    top = ops.listdir(base)
    if top is None:
        return None
    out: dict[str, tuple] = {}
    todo = [("", top)]
    while todo:
        prefix, entries = todo.pop()
        for e in entries:
            rel = f"{prefix}{e['name']}"
            if e.get("is_directory"):
                todo.append((rel + "/", ops.listdir(f"{base}/{rel}") or []))
            else:
                out[rel] = (e.get("size"), e.get("mtime"))
    return out


def _redact(text: str) -> str:
    return _TOKENISH.sub("*****", text)[:120]


class _WriteFailed(Exception):
    def __init__(self, code: str, detail: str):
        super().__init__(detail)
        self.code = code


def _write(ops, base: str, files: list[tuple[str, bytes]]) -> None:
    for rel, data in files:
        try:
            code = ops.write(f"{base}/{rel}", data)
        except TimeoutError as exc:
            raise _WriteFailed("timeout", str(exc)) from exc
        except OSError as exc:
            raise _WriteFailed("hermes_unreachable", str(exc)) from exc
        if code != 200:                                       # web.files._post_upload: 504 = 시간 제한, 502 = 연결 끊김
            raise _WriteFailed({504: "timeout", 502: "hermes_unreachable"}.get(code, "write_failed"), f"{rel}: HTTP {code}")


def _log(event: str, **kv) -> None:
    print(" ".join([event] + [f"{k}={v}" for k, v in kv.items()]), flush=True)   # i18n-ignore: 로그


def _apply(row: dict, ops, root: Path, now: float) -> None:
    """켠 행 하나: 처음 쓰기·판 맞추기·점검·되돌리기. 실패는 _WriteFailed 로 올린다."""
    pod, profile, skill = row["pod"], row["profile"], row["skill"]
    base = _base(profile, skill)
    rule = current_rule(pod, profile, skill)                  # 설치 규칙(2026-11-24-001). 읽기 실패는 올린다 — 규칙 빠진 사본을 정상으로 쓰지 않게
    src = copy_files(skill, rule, root)
    src_sha = {rel: _sha(data) for rel, data in src}
    version = skill_bundle.front(skill, root).get("version", "")
    recorded = json.loads(row.get("files") or "{}")
    meta = json.loads(row.get("meta") or "{}")
    _rules_base(pod, profile, skill, rule, version, root)
    if recorded != src_sha:                                   # 처음 쓰기(빈 기록)·판 바뀜·규칙 바뀜·옛 판으로 되돌림 — 되돌림 알림이 아니다
        listing = _walk(ops, base) or {}
        tampered = _tampered(ops, base, recorded, listing) if recorded else []   # 맞추기 전에 사본이 이미 바뀌어 있었으면 흔적을 남긴다(E5)
        _write(ops, base, src)
        for rel in sorted(set(listing) - set(src_sha)):
            ops.delete(f"{base}/{rel}", False)
        old_version, old_rev = _split_version(row.get("version") or "")
        if recorded and old_version != version:
            _log("protected_skill_version_changed", pod=pod, profile=profile, skill=skill, version=version)
        if rule is not None and old_rev != rule["rev"]:
            _log("protected_skill_rules_applied", pod=pod, profile=profile, skill=skill, rev=rule["rev"])
        after = _walk(ops, base) or {}
        row.update(files=json.dumps(src_sha, sort_keys=True), meta=json.dumps({k: list(after.get(k, ())) for k in src_sha}, sort_keys=True),
                   version=f"{version}+r{rule['rev']}" if rule is not None else version, last_full_at=now)
        if tampered:
            row["last_restored_at"] = _now()
            _restored(pod, profile, skill, tampered, version)
        return
    listing = _walk(ops, base)
    full = now - float(row.get("last_full_at") or 0) >= FULL_EVERY
    changed: list[str] = []
    for rel, sha in src_sha.items():
        seen = (listing or {}).get(rel)
        if seen is None:
            changed.append(rel)
        elif full or list(seen) != meta.get(rel):
            data = ops.read(f"{base}/{rel}")
            if data is None or _sha(data) != sha:
                changed.append(rel)
    extra = sorted(set(listing or {}) - set(src_sha))
    if full:
        row["last_full_at"] = now
    if not changed and not extra:
        if listing is not None:                               # 같은 내용인데 시각만 바뀐 파일 — 다시 읽지 않게 기록을 맞춘다
            row["meta"] = json.dumps({k: list(listing.get(k, ())) for k in src_sha}, sort_keys=True)
        return
    _write(ops, base, [(rel, data) for rel, data in src if rel in changed or (rel == "SKILL.md" and changed)])
    for rel in extra:
        ops.delete(f"{base}/{rel}", False)
    after = _walk(ops, base) or {}
    row.update(meta=json.dumps({k: list(after.get(k, ())) for k in src_sha}, sort_keys=True), last_restored_at=_now())
    _restored(pod, profile, skill, changed + extra, version)


def _restored(pod: str, profile: str, skill: str, files_: list[str], version: str) -> None:
    names = ", ".join(files_)
    _log("protected_skill_restored", pod=pod, profile=profile, skill=skill, files=names)
    _notice(pod, profile, skill, "restored", tr(
        f"보호 스킬 {skill} 이 바뀌어 원본으로 되돌렸습니다(바뀐 파일: {names}, 감지 {_now()}). 같은 시각의 웹훅 실행 기록을 확인하세요. "
        f"규칙을 더하려면 AAS 스킬 화면의 「설치 규칙」을 쓰세요. 고쳐 쓰려면 {skill}-local 로 복사하세요",
        f"The protected skill {skill} was changed and restored (files: {names}, detected {_now()}). Check the webhook runs at that time. "
        f"To add rules, use Install rules on the AAS skill screen. To edit it, copy it to {skill}-local"), version)


def _tampered(ops, base: str, recorded: dict, listing: dict) -> list[str]:
    """판 맞추기 직전 사본이 지난 기록(recorded)과 다른 파일 — 없어진 것·더해진 것 포함."""
    out = [rel for rel in sorted(recorded) if rel not in listing]
    for rel in sorted(set(recorded) & set(listing)):
        data = ops.read(f"{base}/{rel}")
        if data is None or _sha(data) != recorded[rel]:
            out.append(rel)
    return out + sorted(set(listing) - set(recorded))


def _remove_copy(row: dict, ops) -> None:
    if ops.listdir(_base(row["profile"], row["skill"])) is not None:
        ops.delete(_base(row["profile"], row["skill"]), True)
    row.update(files="{}", meta="{}")


def _fail(row: dict, err: _WriteFailed, now: float) -> None:
    n = int(row.get("failures") or 0) + 1
    row.update(state="failed", failures=n, last_error_code=err.code, last_error=_redact(str(err)),
               next_try_at=now + min(BACKOFF_MAX, interval() * (2 ** (n - 1))))
    _log("protected_skill_write_failed", pod=row["pod"], profile=row["profile"], skill=row["skill"], code=err.code)
    if n >= FAIL_NOTICE:
        _notice(row["pod"], row["profile"], row["skill"], "failed", tr(
            f"보호 스킬 {row['skill']} 을 {n}번 넣지 못했습니다({err.code}). Hermes 파일 API 응답을 확인하고, skill_toggle enabled=false 뒤 다시 켜세요",
            f"Could not write the protected skill {row['skill']} ({n} tries, {err.code}). Check the Hermes file API, then turn it off and on again "
            f"with skill_toggle"), level="bad")


def enabled_for(pod: str, profile: str, root: Path = PROTECTED_DIR, settings: dict[str, str] | None = None) -> list[str]:
    """그 프로파일에서 켠(on·failed) 보호 스킬 가운데 설치 값이 켜진 것. MindWiki 자동화 복제본이 T 에서 물려받는다(2026-11-21-002)."""
    allowed = set(protected_enabled(root, settings))
    return sorted(r["skill"] for r in rows(pod) if r["profile"] == profile and r["state"] in ("on", "failed") and r["skill"] in allowed)


def preload_for(pod: str, profile: str, root: Path = PROTECTED_DIR, settings: dict[str, str] | None = None,
                message: str | None = None) -> list[str]:
    """MindWiki 자동화 카드에 미리 실을 보호 스킬(카드 skills 칸 → Hermes 카드 실행기의 --skills). skills 도구 묶음을 끈
    mindwiki-auto 는 스킬 목록도 skill_view 도 없어 켠 보호 스킬을 한 번도 읽지 못했다(2026-11-21 OKE state.db). 사본이 쓰인(on)
    것만, 같은 이름 알림이 있는 것은 뺀다 — Hermes 는 --skills 이름을 하나도 찾지 못하면 카드 실행을 실패로 끝낸다.
    message 는 자동화의 맡길 일(webhook 의 instruction)이다. 첫 구절이 보호 스킬 이름을 가리키면 그 하나만 싣는다(preload_pick)."""
    with _conn() as conn:
        dup = {r[0] for r in conn.execute("SELECT skill FROM protected_skill_notice WHERE pod=? AND profile=? AND kind='duplicate'", (pod, profile))}
    known = protected_enabled(root, settings)
    allowed = set(known)
    ready = sorted(r["skill"] for r in rows(pod) if r["profile"] == profile and r["skill"] in allowed and r["skill"] not in dup
                   and (status(pod, profile, r["skill"]) or {}).get("state") == "on")
    if message is None:
        return ready
    got, named = preload_pick(ready, known, message)
    if named and not got:
        _log("WARNING protected_skill_preload_not_ready", pod=pod, profile=profile, skill=named)
    return got


_LEAD = " \t\r\n\"'`「『“‘(<[*"


def named_skill(known: list[str], message: str) -> str:
    """맡길 일 첫 구절 「<이름> 스킬로」가 가리키는 보호 스킬 이름("" 없음). 낱말 단위로 맞춘다 — 이름 뒤에 「 스킬로」가 바로
    와야 해서 team-alpha 와 team-alpha-faq 를 앞부분으로 헷갈리지 않는다. 앞의 공백 · 따옴표 · 괄호는 건너뛴다."""
    head = (message or "").lstrip(_LEAD)
    hits = [n for n in known if head.startswith(n) and head[len(n):].lstrip(" `'\"」』”’").startswith("스킬로")]   # i18n-ignore: 자동화 메시지 꼴(사람이 쓴 지시문)
    return max(hits, key=len) if hits else ""


def preload_pick(ready: list[str], known: list[str], message: str) -> tuple[list[str], str]:
    """미리 실을 보호 스킬(AAS 스펙 2026-11-24-002 D8 (가)): 맡길 일이 보호 스킬 이름을 가리키면 그것이 준비됐을 때(on) 그 하나만,
    준비되지 않았으면(꺼짐 · failed · 같은 이름 알림) 아무것도 싣지 않는다 — 모두 실으면 다른 스킬이 그 카드를 잡는다. 어떤 이름도
    가리키지 않을 때만 준비된 것을 모두 싣는다. 이 필터는 미리 싣기만 줄인다: 복제본은 skill_view 로 켠 스킬을 모두 읽을 수 있어,
    다른 스킬을 고르지 못하게 막는 것은 각 스킬의 접두 확인이다. (실을 것, 가리킨 이름)."""
    named = named_skill(known, message)
    if not named:
        return ready, ""
    return ([named] if named in ready else []), named


def apply_now(pod: str, profile: str, skill: str, ops, *, root: Path = PROTECTED_DIR, wait: float = 10.0) -> bool:
    """복제 단계·자동화 카드 직전(2026-11-21-002): 그 프로파일의 보호 스킬을 켬으로 두고 지금 바로 쓰거나 맞춘다(바뀌었으면 되돌린다).
    주기와 같은 쓰기 함수(_apply)와 같은 잠금(protected_lock, wait 초 기다림)을 쓴다. 사본이 원본과 같아졌으면 True.
    잠금을 못 잡거나 쓰기에 실패하면 False(행은 failed — 주기가 다시 한다)."""
    row = _row(pod, profile, skill) or {"pod": pod, "profile": profile, "skill": skill, "state": "off"}
    if row["state"] not in ("on", "failed"):
        row.update(state="on", failures=0, next_try_at=0.0)
    with protected_lock(pod, profile, wait=wait) as got:
        if not got:
            _save(row)
            return False
        try:
            _apply(row, ops, root, time.time())
            row.update(state="on", failures=0, last_error_code="", last_error="", next_try_at=0.0)
            _clear_notice(pod, profile, skill, "rules_failed")
            ok = True
        except _WriteFailed as err:
            _fail(row, err, time.time())
            _rules_failed(row, err)
            ok = False
        _save(row)
    return ok


def duplicates(listed: list[dict], skill: str) -> list[str]:
    """Hermes 스킬 목록(GET /api/skills)에서 보호 자리 밖의 같은 이름 스킬 자리(「market/x」 꼴). 같은 이름이 둘이면 Hermes 는
    load_name 을 상대 경로로 돌려준다(1b). 처음 켤 때 거절(§3-2 conflict)과 주기의 같은 이름 알림이 같이 쓴다."""
    others = [s for s in listed if (s.get("name") == skill and s.get("category") != "protected")
              or (str(s.get("name", "")).endswith("/" + skill) and not str(s.get("name")).startswith("protected/"))]
    return sorted(str(s.get("name")) if "/" in str(s.get("name")) else f"{s.get('category') or ''}/{skill}".lstrip("/") for s in others)


OFF = {"state": "off", "version": "", "last_restored_at": "", "failures": 0, "last_error_code": ""}


def skill_id(profile: str, skill: str) -> str:
    """스킬 목록(skill_graph)의 id 와 같은 꼴 — 쓰기 전(pending·off) 줄과 쓴 뒤 줄이 같은 id 를 갖는다."""
    return f"{profile}:profiles/{profile}/skills/protected/{skill}"


def _description(skill: str, root: Path) -> str:
    try:
        return str(skill_bundle.front(skill, root).get("description") or "").strip().strip('"')
    except (OSError, skill_bundle.BundleError):
        return ""


def _on(st: dict | None) -> bool:
    return bool(st) and st["state"] in ("on", "pending", "failed")


def merge_profile_skills(pod: str, profile: str, skills: list[dict], *, root: Path = PROTECTED_DIR,
                         settings: dict[str, str] | None = None) -> list[dict]:
    """프로파일 서랍의 스킬 줄(profiles.skills_view — Hermes 목록)에 보호 스킬을 맞춘다(§3-2 화면). 설치 값이 꺼진 보호 스킬은 뺀다.
    켬·끔은 Hermes 값이 아니라 AAS 기록이다. 이름 있는 프로파일에는 아직 쓰지 않은 보호 스킬 줄도 더한다(켜는 스위치가 있어야 한다)."""
    names, on = set(protected_names(root)), set(protected_enabled(root, settings))
    if not names:
        return skills
    out, seen = [], set()
    for s in skills:
        full = str(s.get("name") or "")
        base = full.rpartition("/")[2]
        if base in names and (s.get("category") == "protected" or full.startswith("protected/")):
            if base not in on:
                continue
            st = status(pod, profile, base)
            s = {**s, "enabled": _on(st), "protected": st or dict(OFF)}
            seen.add(base)
        out.append(s)
    if profile and profile != "default":
        for skill in sorted(on - seen):
            st, desc = status(pod, profile, skill), _description(skill, root)
            out.append({"name": skill, "description": desc[:200], "category": "protected", "enabled": _on(st), "usage": 0,
                        "provenance": "protected", "description_full": desc, "protected": st or dict(OFF)})
    return out


def merge_list_rows(pod: str, rows: list[dict], profiles: list[str], *, root: Path = PROTECTED_DIR,
                    settings: dict[str, str] | None = None) -> list[dict]:
    """스킬 화면 목록(/api/skills 의 줄, origin 판정 뒤)에 보호 스킬을 맞춘다. 줄 꼴은 skill_graph.list_row + 상태."""
    names, on = set(protected_names(root)), set(protected_enabled(root, settings))
    if not names:
        return rows
    out, seen = [], set()
    for r in rows:
        if r.get("origin") == "protected":
            if r.get("name") not in on:
                continue
            st = status(pod, str(r.get("profile") or ""), str(r["name"]))
            r = {**r, "enabled": _on(st), "protected": st or dict(OFF)}
            seen.add((r.get("profile"), r["name"]))
        out.append(r)
    for profile in profiles:
        if not profile or profile == "default":
            continue
        for skill in sorted(on):
            if (profile, skill) in seen:
                continue
            st = status(pod, profile, skill)
            out.append(pending_row(profile, skill, st, root))
    return out


def pending_row(profile: str, skill: str, st: dict | None, root: Path = PROTECTED_DIR) -> dict:
    """아직 쓰지 않은 보호 스킬의 목록 줄(스킬 화면·skill_get)."""
    return {"id": skill_id(profile, skill), "name": skill, "profile": profile, "description": _description(skill, root)[:240],
            "modified": "", "origin": "protected", "shared_from": "", "n_mcp": 0, "n_rest": 0, "n_scripts": 0, "n_cron": 0, "urls": [],
            "tags": [], "delete_block": "origin", "dependents_n": 0, "mentions_n": 0, "agents_n": 0,
            "enabled": _on(st), "protected": st or dict(OFF)}


def _names_check(row: dict, ops) -> None:
    """같은 이름 스킬·Hermes 쪽 끔(NAME_EVERY 마다). 같은 이름은 옮기지 않고 알린다 — Hermes 의 provenance 「agent」는 사람이 만든
    스킬도 포함하고 .usage.json 은 이름으로 기록해 겹친 두 스킬을 가를 수 없다(스펙 §9 2026-11-21 3단계)."""
    listed = ops.skills(row["profile"])
    if listed is None:
        return
    skill = row["skill"]
    where = ", ".join(duplicates(listed, skill))
    if where:
        _notice(row["pod"], row["profile"], skill, "duplicate", tr(
            f"보호 스킬 {skill} 과 같은 이름 스킬이 있습니다({where}). Hermes 가 이름으로 고르지 못해 보호 스킬이 쓰이지 않을 수 있습니다. 그 스킬의 이름을 바꾸거나 지우세요",
            f"Another skill has the same name as the protected skill {skill} ({where}). Hermes cannot pick by name, so the protected skill may "
            f"not be used. Rename or delete that skill"))
        _log("protected_skill_duplicate", pod=row["pod"], profile=row["profile"], skill=skill, where=where)
    else:
        _clear_notice(row["pod"], row["profile"], skill, "duplicate")
    mine = [s for s in listed if s.get("name") in (skill, f"protected/{skill}")]
    if mine and not any(s.get("enabled", True) for s in mine):
        _notice(row["pod"], row["profile"], skill, "hermes_disabled", tr(
            f"보호 스킬 {skill} 이 Hermes 쪽에서 꺼져 있습니다. AAS 는 다시 켜지 않습니다 — 스킬 목록에서 켜세요",
            f"The protected skill {skill} is turned off in Hermes. AAS does not turn it back on; turn it on in the skill list"))
        _log("protected_skill_hermes_disabled", pod=row["pod"], profile=row["profile"], skill=skill)
    else:
        _clear_notice(row["pod"], row["profile"], skill, "hermes_disabled")


def _orphans(pod, profile: str, ops, names: list[str], live: set[str]) -> None:
    found = [n for n in names if n not in live and ops.listdir(_base(profile, n)) is not None]
    if not found:
        return
    if len(found) > ORPHAN_MAX:
        _log("protected_skill_orphans_held", pod=pod.id, profile=profile, count=len(found))
        for n in found:
            _notice(pod.id, profile, n, "orphan", tr(
                f"켬 기록 없이 남은 보호 스킬 사본이 {len(found)}개라 지우지 않았습니다. 기록이 사라진 것인지 확인하세요",
                f"{len(found)} protected skill copies have no record, so none were deleted. Check whether the records were lost"))
        return
    for n in found:
        ops.delete(_base(profile, n), True)
        _log("protected_skill_orphan_removed", pod=pod.id, profile=profile, skill=n)


def cycle(pods: list, profiles_of, ops_of, *, root: Path = PROTECTED_DIR, settings: dict[str, str] | None = None,
          now: float | None = None, force: bool = False) -> list[str]:
    """한 주기. ops_of(pod) 는 read(경로)→bytes|None, write(경로, bytes)→HTTP 상태, listdir(경로)→[{name,is_directory,size,mtime}]|None,
    delete(경로, recursive), skills(프로파일)→[{name,category,enabled}]|None 을 가진다(모두 시간 제한이 걸린 호출).
    리더만 부른다. 돌려주는 값은 한 일 목록(로그·시험용)."""
    if not _cycle_lock.acquire(blocking=False):
        return []
    try:
        return _cycle(pods, profiles_of, ops_of, root, settings, time.time() if now is None else now, force)
    finally:
        _cycle_lock.release()


def _cycle(pods, profiles_of, ops_of, root, settings, now, force) -> list[str]:
    started = time.monotonic()
    by_id = {p.id: p for p in pods}
    enabled = set(protected_enabled(root, settings))
    names = protected_names(root)
    done: list[str] = []
    todo = sorted(rows(), key=lambda r: -float(r.get("check_requested_at") or 0))   # 바로 점검을 부탁한 행 먼저
    names_due = force or now - _state["last_names"] >= NAME_EVERY
    orphan_due = force or now - _state["last_orphan"] >= ORPHAN_EVERY
    profiles_cache: dict[str, list[str]] = {}
    ops_cache: dict[str, object] = {}
    retired: dict[str, int] = {}
    for i, row in enumerate(todo):
        if time.monotonic() - started > BUDGET:
            _log("protected_skill_cycle_skipped", seconds=int(time.monotonic() - started), left=len(todo) - i)
            break
        pod = by_id.get(row["pod"])
        try:
            if pod is None:                                    # 지운 작업공간 — 끝없이 다시 하지 않게
                if row["state"] != "retired":
                    row.update(state="retired")
                    _save(row)
                continue
            if row["pod"] not in profiles_cache:
                profiles_cache[row["pod"]] = list(profiles_of(pod))
                ops_cache[row["pod"]] = ops_of(pod)
            ops = ops_cache[row["pod"]]
            if row["profile"] not in profiles_cache[row["pod"]]:   # 지운 프로파일 — 행 정리(이름 바꾸기는 rename_profile 이 먼저 옮긴다)
                _delete_row(row["pod"], row["profile"], row["skill"])
                continue
            with protected_lock(row["pod"], row["profile"]) as got:
                if not got:
                    continue
                row["check_requested_at"] = 0.0
                if row["skill"] not in enabled:
                    if row["state"] in ("on", "failed"):
                        _remove_copy(row, ops)
                        row.update(state="retired")
                        retired[row["skill"]] = retired.get(row["skill"], 0) + 1
                        done.append(f"retired {row['pod']}/{row['profile']} {row['skill']}")
                    _save(row)
                    continue
                if row["state"] == "retired":
                    row.update(state="on", files="{}", meta="{}", failures=0)
                if row["state"] == "off":
                    if json.loads(row.get("files") or "{}"):
                        _remove_copy(row, ops)
                        done.append(f"removed {row['pod']}/{row['profile']} {row['skill']}")
                    _save(row)
                    continue
                if row["state"] == "failed" and now < float(row.get("next_try_at") or 0):
                    _save(row)
                    continue
                if ops.read(f"profiles/{row['profile']}/config.yaml") is None:   # 목록 뒤 지워진 프로파일 — 쓰면 폴더가 다시 생긴다
                    continue
                try:
                    before = row.get("last_restored_at")
                    _apply(row, ops, root, now)
                    row.update(state="on", failures=0, last_error_code="", last_error="", next_try_at=0.0)
                    _clear_notice(row["pod"], row["profile"], row["skill"], "failed")
                    _clear_notice(row["pod"], row["profile"], row["skill"], "rules_failed")
                    done.append(("restored " if row.get("last_restored_at") != before else "ok ") + f"{row['pod']}/{row['profile']} {row['skill']}")
                except _WriteFailed as err:
                    _fail(row, err, now)
                    _rules_failed(row, err)
                if names_due:
                    _names_check(row, ops)
                _save(row)
        except Exception as exc:                              # 한 행의 예외가 다른 행을 막지 않는다 — 보호가 조용히 멈추지 않게 남긴다
            _log("protected_skill_cycle_error", pod=row["pod"], profile=row["profile"], skill=row["skill"], error=type(exc).__name__)
            traceback.print_exc()
    for skill, n in retired.items():
        _log("protected_skill_retired", skill=skill, profiles=n)
    if orphan_due:
        live: dict[tuple[str, str], set[str]] = {}
        for r in rows():
            if r["state"] in ("on", "failed"):
                live.setdefault((r["pod"], r["profile"]), set()).add(r["skill"])
        for pod in pods:
            try:
                profs = profiles_cache.get(pod.id) or list(profiles_of(pod))
                ops = ops_cache.get(pod.id) or ops_of(pod)
                for profile in profs:
                    if profile != "default":
                        _orphans(pod, profile, ops, names, live.get((pod.id, profile), set()))
            except Exception as exc:
                _log("protected_skill_cycle_error", pod=pod.id, profile="", skill="", error=type(exc).__name__)
                traceback.print_exc()
        _state["last_orphan"] = now
    if names_due:
        _state["last_names"] = now
    _state["last_done"] = time.time()
    return done


# ---- 설치 규칙(cogentai-aas-docs 스펙 2026-11-24-001) ------------------------------------------------------------------
#
#   사람이 AAS 화면에서 쓴 규칙 글을 그 (파드, 프로파일)의 사본 SKILL.md 끝 절로 붙인다. 되돌림 기준이 「원본 + 규칙」이 된다.
#   판      protected_skill_rules 의 가장 큰 rev 가 지금 규칙. 빈 글도 판(규칙 지우기). RULES_KEEP 판까지 둔다.
#   복제본  MindWiki 자동화 복제본은 T 의 지금 판 한 행만 같은 rev 로 갖는다(clone_of=T). 화면에서 고치지 않는다.
#   쓰기    사람의 화면 세션만(부르는 쪽이 MCP·임베드를 거절한다). 이 모듈은 글 검사·판·사본 모양을 맡는다.

RULES_MAX = 8000          # 글 상한(글자)
RULES_KEEP = 20           # 판 보관 수
NOTE_MAX = 200            # 「바꾼 까닭」 상한
RULES_POLL_S = 10         # 화면이 저장 뒤 다시 읽는 간격
RULES_POLL_MAX_S = 120    # 화면이 다시 읽기를 멈추는 때
# i18n-ignore: 스킬 본문에 붙는 절 제목(모델이 읽는다, 원본 SKILL.md 의 「이 설치의 규칙」 문장과 글자 그대로 같아야 한다)
RULES_TITLE = "## 이 설치의 규칙"
# i18n-ignore: 원본 SKILL.md 의 절 제목(스펙 004 §4-3 · 이 스펙 5절)
FIXED_TITLE = "## 바꿀 수 없는 것"
# i18n-ignore: 원본이 설치 규칙을 읽는다는 표시 줄(5절)
READS_MARK = "**이 설치의 규칙**"
# i18n-ignore: 사본 SKILL.md 에 붙는 주석(모델 · 사람이 읽는 스킬 본문)
_RULES_HEAD = "<!-- AAS 가 붙인 절이다. AAS 화면 「설치 규칙」에서 고친다(판 {rev}, {ts}). 여기를 직접 고치면 곧 원본과 규칙으로 되돌아간다. -->"
# i18n-ignore: 사본 SKILL.md 에 붙는 맺음 주석
_RULES_TRAILER_MARK = "<!-- AAS 가 붙인 줄이다(고칠 수 없음). -->"
# i18n-ignore: 사본 SKILL.md 에 붙는 맺음 문장 — R0 에서 고정 규칙 막음을 높였다(스펙 9-1)
_RULES_TRAILER = ("위 규칙 가운데 이 파일 앞쪽 「바꿀 수 없는 것」과 다른 줄은 쓰지 않는다. 그런 줄이 있으면 「## 답변 초안」의 「담당자 확인 필요」에 "
                  # i18n-ignore: 위 문장의 뒷부분
                  "「설치 규칙: 바꿀 수 없는 규칙이라 쓰지 않음 — <그 줄 요약>」을 적는다. 고객 지침 페이지와 겹치는 항목은 지침 페이지를 따른다.")
_HEADING = re.compile(r"^ {0,3}#{1,2}(\s|$)")
_SETEXT = re.compile(r"^ {0,3}(=+|-+)\s*$")
_HR = re.compile(r"^ {0,3}([-*_]\s*){3,}$")
_FENCE = re.compile(r"^ {0,3}(```|~~~)")
_SEMVER = re.compile(r"^(\d+)\.(\d+)\.(\d+)$")
_REDACTED = "«가림»"   # i18n-ignore: 가림 표시를 맞대어 보는 값(files.mask_line 이 넣는 글자)


class RulesError(Exception):
    """설치 규칙 API 거절. status = HTTP 상태, reason = 오류 본문의 reason, extra = 더하는 칸(스펙 4-3 오류 표)."""

    def __init__(self, status: int, reason: str, message: str, **extra):
        super().__init__(message)
        self.status, self.reason, self.extra = status, reason, extra

    def body(self) -> dict:
        return {"error": str(self), "reason": self.reason, **self.extra}


def check_rules_text(text: str) -> tuple[str, int] | None:
    """글 검사(4-3). 걸리면 (check, 줄 번호 1부터 · 줄과 상관없으면 0). 걸린 줄의 글은 돌려주지 않는다."""
    from ..assets import files                                 # 늦게 부른다(files 가 보호 사본 판정에 이 모듈을 쓴다)
    if "\x00" in text:
        return "nul", 0
    if len(text) > RULES_MAX:
        return "length", 0
    for i, line in enumerate(text.splitlines(), 1):
        if _HEADING.match(line):
            return "heading", i
        if _SETEXT.match(line):
            return "setext", i
        if _HR.match(line):
            return "hr", i
        if "<!--" in line or "-->" in line:
            return "comment", i
        if _REDACTED in line:
            return "redaction", i
        if files.mask_line(line) != line:
            return "secret", i
    return None


def _check_note(note: str) -> tuple[str, int] | None:
    from ..assets import files
    if "\x00" in note:
        return "nul", 0
    if len(note) > NOTE_MAX:
        return "length", 0
    return ("secret", 0) if files.has_secrets(note) else None


def _invalid_text(found: tuple[str, int], field: str = "text") -> RulesError:
    check, line = found
    msg = tr(f"{line} 번째 줄을 고치세요", f"Fix line {line}") if line else {
        "length": tr(f"{RULES_MAX if field == 'text' else NOTE_MAX:,}자까지 쓸 수 있습니다", f"Up to {RULES_MAX if field == 'text' else NOTE_MAX:,} characters"),
        "nul": tr("글이 아닌 내용이 섞여 있습니다", "The content includes non-text data"),
        "secret": tr("비밀값처럼 보이는 글은 쓸 수 없습니다", "Text that looks like a secret cannot be saved"),
    }.get(check, tr("글을 고치세요", "Fix the text"))
    return RulesError(422, "invalid_text", msg, check=check, line=line, field=field)


def fixed_section(md: str) -> str:
    """원본 SKILL.md 의 「## 바꿀 수 없는 것」 절 본문. 코드 펜스 안의 제목 줄은 건너뛰고 다음 1 · 2단 제목 앞까지. 없으면 빈 글."""
    out: list[str] = []
    inside = fence = False
    for line in md.splitlines():
        if not fence and _HEADING.match(line):
            if inside:
                break
            inside = line.strip() == FIXED_TITLE
            continue
        if _FENCE.match(line):
            fence = not fence
        if inside:
            out.append(line)
    return "\n".join(out).strip()


def _has_rules_heading(md: str) -> bool:
    """코드 펜스 밖에 「## 이 설치의 규칙」 제목 줄이 있는가."""
    fence = False
    for line in md.splitlines():
        if _FENCE.match(line):
            fence = not fence
        elif not fence and _HEADING.match(line) and line.strip() == RULES_TITLE:
            return True
    return False


def _source_md(skill: str, root: Path) -> str:
    return (root / skill / "SKILL.md").read_text(encoding="utf-8")


def _fixed_sha(skill: str, root: Path) -> str:
    body = fixed_section(_source_md(skill, root))
    return _sha(body.encode()) if body else ""


def version_drift(base: str, now: str) -> bool:
    """알림을 낼 판 차이인가 — major.minor 가 다르면. 둘 중 하나라도 major.minor.patch 로 읽지 못하면 글자 그대로 견준다."""
    a, b = _SEMVER.match(base or ""), _SEMVER.match(now or "")
    if a and b:
        return a.groups()[:2] != b.groups()[:2]
    return (base or "") != (now or "")


def _split_version(v: str) -> tuple[str, int]:
    """행의 version(「0.8.5+r3」) → (원본 판, 붙은 규칙 판 · 없으면 0)."""
    head, sep, tail = v.rpartition("+r")
    return (head, int(tail)) if sep and tail.isdigit() else (v, 0)


def _stamp(ts: str) -> str:
    """주석 줄 시각 YYYY-MM-DD HH:MM±HH:MM(ISO 에서 자름, 시간대 오프셋을 남긴다 — 파드 시간대가 사용자와 다를 수 있다)."""
    ts = ts or ""
    off = ts[19:] if len(ts) > 19 else ""
    return f"{ts[:10]} {ts[11:16]}{off}".strip()


def rules_tail(rule: dict) -> str:
    """사본 SKILL.md 끝에 붙는 절(빈 줄로 시작). 사람 글 뒤에 AAS 맺음 줄을 둔다(R0, 스펙 9-1)."""
    return (f"\n\n{RULES_TITLE}\n\n{_RULES_HEAD.format(rev=rule['rev'], ts=_stamp(str(rule.get('ts') or '')))}\n\n"
            f"{str(rule['text']).strip()}\n\n{_RULES_TRAILER_MARK}\n{_RULES_TRAILER}\n")


def copy_files(skill: str, rule: dict | None, root: Path = PROTECTED_DIR) -> list[tuple[str, bytes]]:
    """사본에 쓸 파일 — 원본(source_files)에 규칙 절을 붙인 SKILL.md. 규칙이 없거나 빈 글이면 원본과 바이트까지 같다."""
    src = source_files(skill, root)
    if not rule or not str(rule.get("text") or "").strip():
        return src
    return [(rel, data.rstrip(b"\n") + rules_tail(rule).encode() if rel == "SKILL.md" else data) for rel, data in src]


def _rule_rows(pod: str, profile: str, skill: str) -> list[dict]:
    with _conn() as conn:
        return [dict(r) for r in conn.execute("SELECT * FROM protected_skill_rules WHERE pod=? AND profile=? AND skill=? ORDER BY rev DESC",
                                              (pod, profile, skill))]


def current_rule(pod: str, profile: str, skill: str) -> dict | None:
    with _conn() as conn:
        r = conn.execute("SELECT * FROM protected_skill_rules WHERE pod=? AND profile=? AND skill=? ORDER BY rev DESC LIMIT 1",
                         (pod, profile, skill)).fetchone()
    return dict(r) if r else None


def rules_summary(pod: str, profile: str, skill: str) -> dict | None:
    """스킬 목록 · skill_get 의 protected.rules(글은 싣지 않는다). 규칙이 없거나 지운 판이면 None."""
    r = current_rule(pod, profile, skill)
    if not r or not str(r["text"]).strip():
        return None
    return {"rev": r["rev"], "base_version": r["base_version"], "chars": len(r["text"])}


def _base_stale(rule: dict | None, skill: str, root: Path) -> bool:
    """원본이 올라 규칙을 다시 볼 때인가(4-4) — 고정 절이 바뀌었거나 major.minor 가 다르다. 복제본 · 빈 규칙은 아니다."""
    if not rule or not str(rule["text"]).strip() or rule.get("clone_of"):
        return False
    version = skill_bundle.front(skill, root).get("version", "")
    return rule["base_fixed_sha"] != _fixed_sha(skill, root) or version_drift(rule["base_version"], version)


def _rules_base(pod: str, profile: str, skill: str, rule: dict | None, version: str, root: Path) -> None:
    """원본이 올라 규칙을 다시 볼 때인가(4-4): 고정 절이 바뀌었거나 major.minor 가 다르면 한 줄. 복제본 · 빈 규칙에는 만들지 않는다."""
    if not _base_stale(rule, skill, root):
        _clear_notice(pod, profile, skill, "rules_base")
        return
    _notice(pod, profile, skill, "rules_base", tr(
        f"보호 스킬 {skill} 의 원본이 {version} 버전으로 바뀌었습니다. 설치 규칙(버전 {rule['rev']})은 원본 {rule['base_version']} 버전에서 썼습니다. "
        f"규칙이 아직 맞는지 확인하고 다시 저장하거나 「이 원본 버전에서 다시 확인함」을 누르세요",
        f"The source of the protected skill {skill} is now version {version}. The install rules (version {rule['rev']}) were written for "
        f"source version {rule['base_version']}. Check that they still fit, then save them again or click Reviewed for this source version"), "", "warn")


def _rules_failed(row: dict, err: Exception) -> None:
    rule = current_rule(row["pod"], row["profile"], row["skill"])
    if not rule or not str(rule["text"]).strip():
        return
    _notice(row["pod"], row["profile"], row["skill"], "rules_failed", tr(
        f"설치 규칙(버전 {rule['rev']})을 사본에 넣지 못했습니다({getattr(err, 'code', type(err).__name__)}). 사본은 이전 내용 그대로입니다. "
        f"{int(interval())}초 안에 다시 점검합니다",
        f"Could not add install rules (version {rule['rev']}) to the copy ({getattr(err, 'code', type(err).__name__)}). The copy keeps its "
        f"previous content. The next check is within {int(interval())} seconds"), "", "bad")


def _rules_target(pod: str, profile: str, skill: str, *, write: bool, clone_of: str, root: Path, settings: dict[str, str] | None) -> dict | None:
    """대상 검사(4-3). 돌려주는 값은 보호 스킬 행(없으면 None)."""
    if skill not in protected_enabled(root, settings):
        raise RulesError(404, "not_found", tr(f"{skill} 스킬이 없습니다", f"There is no skill named {skill}"))
    if not profile or profile == "default":
        raise RulesError(400, "invalid", tr("이름 있는 프로파일을 고르세요", "Choose a named profile"))
    row = _row(pod, profile, skill)
    if write and clone_of:
        raise RulesError(400, "invalid", tr(f"원래 프로파일 {clone_of} 에서 고치세요", f"Edit it in the original profile {clone_of}"), clone_of=clone_of)
    if write and (not row or row["state"] not in ("on", "failed")):
        raise RulesError(404, "not_found", tr(f"{skill} 스킬이 없습니다", f"There is no skill named {skill}"))
    return row


def _busy(cur: dict | None) -> RulesError:
    rev = cur["rev"] if cur else 0
    return RulesError(409, "busy", tr(f"다른 사람이 먼저 저장했습니다. 먼저 저장된 버전({rev})을 불러와 비교한 뒤 다시 저장하세요",
                                      f"Someone saved first. Load version {rev}, compare, then save again"),
                      current={"rev": rev, "author": (cur or {}).get("author", ""), "ts": (cur or {}).get("ts") or ""})


def _apply_state(row: dict | None, rev: int) -> tuple[int, str]:
    """(사본에 붙은 판, 반영 상태). 화면은 이 값만 쓴다(E2). 빈 글 판도 행 version 에 +r 이 남아 지운 판도 applied 가 된다(E1)."""
    if not row or row["state"] not in ("on", "failed"):
        return 0, "off"
    applied = _split_version(row.get("version") or "")[1]
    if row["state"] == "failed":
        return applied, "failed"
    if applied != rev or not json.loads(row.get("files") or "{}"):
        return applied, "pending"
    return applied, "applied"


def rules_view(pod: str, profile: str, skill: str, *, can_write: bool, clone_of: str = "", root: Path = PROTECTED_DIR,
               settings: dict[str, str] | None = None) -> dict:
    """GET /api/protected-skills/rules — 지금 판 · 판 목록 · 반영 상태 · 원본에서 뽑은 고정 절."""
    row = _rules_target(pod, profile, skill, write=False, clone_of=clone_of, root=root, settings=settings)
    found = _rule_rows(pod, profile, skill)
    cur = found[0] if found else None
    rev = cur["rev"] if cur else 0
    applied_rev, state = _apply_state(row, rev)
    md = _source_md(skill, root)
    return {"rev": rev, "text": cur["text"] if cur else "", "base_version": cur["base_version"] if cur else "",
            "author": cur["author"] if cur else "", "ts": (cur or {}).get("ts") or "", "note": cur["note"] if cur else "",
            "source_version": skill_bundle.front(skill, root).get("version", ""),
            "versions": [{"rev": r["rev"], "author": r["author"], "ts": r.get("ts") or "", "chars": len(r["text"]), "note": r["note"]} for r in found],
            "applied_rev": applied_rev, "apply_state": state, "clone_of": clone_of, "base_stale": _base_stale(cur, skill, root),
            "can_edit": bool(can_write and not clone_of and row and row["state"] in ("on", "failed")),
            "enabled": bool(row and row["state"] in ("on", "failed")), "reads_rules": READS_MARK in md, "fixed_rules": fixed_section(md),
            "limits": {"max_chars": RULES_MAX, "keep": RULES_KEEP, "note_max": NOTE_MAX, "poll_s": RULES_POLL_S, "poll_max_s": RULES_POLL_MAX_S}}


def rules_at(pod: str, profile: str, skill: str, rev: int, *, clone_of: str = "", root: Path = PROTECTED_DIR,
             settings: dict[str, str] | None = None) -> dict:
    """GET …/rules?rev=N — 그 판의 글."""
    _rules_target(pod, profile, skill, write=False, clone_of=clone_of, root=root, settings=settings)
    found = _rule_rows(pod, profile, skill)
    hit = next((r for r in found if r["rev"] == rev), None)
    if hit is None:
        raise _rev_gone(found)
    return {"rev": hit["rev"], "text": hit["text"], "author": hit["author"], "ts": hit.get("ts") or "", "note": hit["note"],
            "base_version": hit["base_version"]}


def _rev_gone(found: list[dict]) -> RulesError:
    oldest = min((r["rev"] for r in found), default=0)
    return RulesError(404, "rev_gone", tr(f"그 버전은 지워졌습니다. 남아 있는 버전({oldest}부터)에서 고르세요",
                                          f"That version was removed. Choose a kept version (from version {oldest})"), oldest_rev=oldest)


def _insert_rule(pod: str, profile: str, skill: str, rule: dict) -> None:
    """한 판 넣기 — INSERT 하나만 하는 트랜잭션. 기본 키 충돌은 그대로 올린다(부르는 쪽이 409 로)."""
    with _conn() as conn:
        conn.execute("INSERT INTO protected_skill_rules (pod, profile, skill, rev, text, base_version, author, note, clone_of, base_fixed_sha, ts) "
                     "VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                     (pod, profile, skill, rule["rev"], rule["text"], rule.get("base_version", ""), rule.get("author", ""), rule.get("note", ""),
                      rule.get("clone_of", ""), rule.get("base_fixed_sha", ""), rule.get("ts") or _now()))


def save_rules(pod: str, profile: str, skill: str, text: str, base_rev, author: str, note: str = "", *, clone_of: str = "",
               root: Path = PROTECTED_DIR, settings: dict[str, str] | None = None) -> dict:
    """POST /api/protected-skills/rules — 새 판. 순서는 INSERT(한 문장 트랜잭션) → 충돌이면 409 → 성공하면 오래된 판 정리(E4).
    PostgreSQL 은 고유 키 위반 뒤 그 트랜잭션을 더 쓰지 못하므로 정리를 다른 트랜잭션으로 한다."""
    _rules_target(pod, profile, skill, write=True, clone_of=clone_of, root=root, settings=settings)
    text, note = str(text if text is not None else ""), str(note or "").strip()
    found = check_rules_text(text)
    if found:
        raise _invalid_text(found)
    bad_note = _check_note(note)
    if bad_note:
        raise _invalid_text(bad_note, "note")
    try:
        base_rev = int(base_rev)
    except (TypeError, ValueError):
        raise RulesError(400, "invalid", tr("base_rev 가 없습니다", "base_rev is missing"), field="base_rev") from None
    cur = current_rule(pod, profile, skill)
    if (cur["rev"] if cur else 0) != base_rev:
        raise _busy(cur)
    rule = {"rev": base_rev + 1, "text": text.rstrip() if text.strip() else "", "base_version": skill_bundle.front(skill, root).get("version", ""),
            "author": author, "note": note, "base_fixed_sha": _fixed_sha(skill, root), "ts": _now()}
    try:
        _insert_rule(pod, profile, skill, rule)
    except Exception as exc:
        if store.is_unique_violation(exc):                    # 다른 서버가 같은 base_rev 로 먼저 넣었다(OKE 는 서버가 둘)
            raise _busy(current_rule(pod, profile, skill)) from None
        raise
    with _conn() as conn:
        conn.execute("DELETE FROM protected_skill_rules WHERE pod=? AND profile=? AND skill=? AND rev<=?", (pod, profile, skill, rule["rev"] - RULES_KEEP))
        conn.execute("UPDATE protected_skill SET check_requested_at=? WHERE pod=? AND profile=? AND skill=?", (time.time(), pod, profile, skill))
    _clear_notice(pod, profile, skill, "rules_base")
    _log("protected_skill_rules_saved", pod=pod, profile=profile, skill=skill, rev=rule["rev"], chars=len(rule["text"]))   # 글은 남기지 않는다
    return {"rev": rule["rev"], "applied": False, "state": "pending", "apply_state": "pending", "next_check_within_s": int(interval())}


def restore_rules(pod: str, profile: str, skill: str, rev, base_rev, author: str, *, clone_of: str = "", root: Path = PROTECTED_DIR,
                  settings: dict[str, str] | None = None) -> dict:
    """POST …/rules/restore — 그 판의 글로 새 판."""
    _rules_target(pod, profile, skill, write=True, clone_of=clone_of, root=root, settings=settings)
    try:
        rev = int(rev)
    except (TypeError, ValueError):
        raise RulesError(400, "invalid", tr("rev 가 없습니다", "rev is missing"), field="rev") from None
    found = _rule_rows(pod, profile, skill)
    hit = next((r for r in found if r["rev"] == rev), None)
    if hit is None:
        raise _rev_gone(found)
    return save_rules(pod, profile, skill, hit["text"], base_rev, author, tr(f"버전({rev})으로 되돌림", f"Restored version {rev}"),
                      clone_of=clone_of, root=root, settings=settings)


def preview_rules(pod: str, profile: str, skill: str, text: str, *, clone_of: str = "", root: Path = PROTECTED_DIR,
                  settings: dict[str, str] | None = None) -> dict:
    """POST …/rules/preview — 저장하면 사본 끝이 어떻게 되는지(판 · 시각은 예상값). 저장하지 않는다."""
    _rules_target(pod, profile, skill, write=False, clone_of=clone_of, root=root, settings=settings)
    text = str(text or "")
    found = check_rules_text(text)
    if found:
        raise _invalid_text(found)
    cur = current_rule(pod, profile, skill)
    rule = {"rev": (cur["rev"] if cur else 0) + 1, "text": text, "ts": _now()}
    tail = rules_tail(rule) if text.strip() else ""
    return {"rev": rule["rev"], "tail": tail.lstrip("\n"), "source_tail": "\n".join(_source_md(skill, root).rstrip("\n").splitlines()[-4:])}


def ack_rules(pod: str, profile: str, skill: str, rev, author: str, *, clone_of: str = "", root: Path = PROTECTED_DIR,
              settings: dict[str, str] | None = None) -> dict:
    """POST …/rules/ack — 「이 원본 판에서 다시 확인함」. 새 판 없이 지금 판의 base_version · base_fixed_sha 만 지금 원본으로(D5)."""
    _rules_target(pod, profile, skill, write=True, clone_of=clone_of, root=root, settings=settings)
    cur = current_rule(pod, profile, skill)
    try:
        rev = int(rev)
    except (TypeError, ValueError):
        raise RulesError(400, "invalid", tr("rev 가 없습니다", "rev is missing"), field="rev") from None
    if not cur or cur["rev"] != rev:
        raise _busy(cur)
    version = skill_bundle.front(skill, root).get("version", "")
    with _conn() as conn:
        conn.execute("UPDATE protected_skill_rules SET base_version=?, base_fixed_sha=? WHERE pod=? AND profile=? AND skill=? AND rev=?",
                     (version, _fixed_sha(skill, root), pod, profile, skill, rev))
    _clear_notice(pod, profile, skill, "rules_base")
    _log("protected_skill_rules_ack", pod=pod, profile=profile, skill=skill, rev=rev, version=version)
    return {"rev": rev, "base_version": version}


def copy_rules(pod: str, template: str, clone: str, skill: str) -> int:
    """MindWiki 자동화 복제본에 T 의 지금 판을 같은 rev 로(4-5). 복제본은 그 한 행만 둔다. 돌려주는 값은 rev(없으면 0).
    DB 오류는 올린다 — 부르는 쪽이 카드를 규칙 없이 돌리지 않는다."""
    src = current_rule(pod, template, skill)
    mine = _rule_rows(pod, clone, skill)
    if src is None:
        if mine:
            with _conn() as conn:
                conn.execute("DELETE FROM protected_skill_rules WHERE pod=? AND profile=? AND skill=?", (pod, clone, skill))
        return 0
    if len(mine) == 1 and mine[0]["rev"] == src["rev"] and mine[0]["text"] == src["text"] and mine[0]["clone_of"] == template:
        return src["rev"]
    with _conn() as conn:
        conn.execute("DELETE FROM protected_skill_rules WHERE pod=? AND profile=? AND skill=?", (pod, clone, skill))
        conn.execute("INSERT INTO protected_skill_rules (pod, profile, skill, rev, text, base_version, author, note, clone_of, base_fixed_sha, ts) "
                     "VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                     (pod, clone, skill, src["rev"], src["text"], src["base_version"], src["author"], "", template, src["base_fixed_sha"], src["ts"]))
    return src["rev"]


if __name__ == "__main__":
    cmd = sys.argv[1:]
    if cmd == ["lock"]:
        try:
            for name, row in write_lock().items():
                print(f"{name} {row['version']} {row['sha256'][:12]}")
        except skill_bundle.BundleError as err:
            print(err, file=sys.stderr)
            sys.exit(1)
    elif cmd == ["check"]:
        found = check()
        for line in found:
            print(line, file=sys.stderr)
        print(f"보호 스킬 {len(protected_names())}개, 빠진 곳 {len(found)}개")   # i18n-ignore: 개발자 점검 명령의 출력
        sys.exit(1 if found else 0)
    else:
        print("사용: python -m aas.market.protected_skills lock|check", file=sys.stderr)   # i18n-ignore: 개발자 점검 명령의 출력
        sys.exit(64)

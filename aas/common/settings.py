# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""AAS 전체 설정(「설정」 메뉴)과 사용자 부서 기록. 계획 2026-10-13-008.

- 회사 이름: `meta` 표의 `company_name`. 비어 있으면 `OPENMARU, Inc.` 를 쓴다(결정 D2).
- 에이전트 소개 문장 기록: `meta` 의 `identity_history`(JSON 목록). AAS 가 SOUL 첫 문장으로 넣었던 문장을 모두 남겨,
  회사 이름을 다시 바꿀 때 그 문장을 찾아 바꾼다(identity.rewrite). 정규식으로 찾지 않는 이유는 회사 이름에 마침표가 들어갈 수
  있어서다(`OPENMARU, Inc.`).
- 부서: `user_directory` 표(email, department). Keycloak 로그인·토큰 갱신 때 claim `department` 로 채운다.
- 부서 슬로건·목표: `department_goals` 표(team_key, team, goal, by, ts). 부서마다 한 줄이고 3D 오피스 위 현수막에 쓴다
  (스펙 2026-10-15-018). 부서 이름은 `office.team_key` 로 묶는다.
- 부서 목록: `departments` 표(team_key, name, by, ts). 관리자가 정한 회사의 부서이고 사용자 추가·수정의 부서 칸은 이 목록에서만 고른다
  (스펙 2026-10-15-026). 사용자의 부서(정본)는 Keycloak 속성 `department` 이고, 이 목록은 그 값이 갈라지지 않게 하는 선택지다.
"""
from __future__ import annotations

import json
import threading
import time
from collections import Counter
from datetime import datetime

from . import db, store, table_cache

DEFAULT_COMPANY = "OPENMARU, Inc."
COMPANY_MAX = 80
DEPARTMENT_MAX = 80

GOAL_MAX = 60
GOAL_SCHEMA = ("CREATE TABLE IF NOT EXISTS department_goals (team_key TEXT PRIMARY KEY, team TEXT NOT NULL, goal TEXT NOT NULL, "
               "by TEXT NOT NULL DEFAULT '', ts TEXT NOT NULL DEFAULT '')")

DEPT_SCHEMA = ("CREATE TABLE IF NOT EXISTS departments (team_key TEXT PRIMARY KEY, name TEXT NOT NULL, "
               "by TEXT NOT NULL DEFAULT '', ts TEXT NOT NULL DEFAULT '')")
# 팀 관리자(스펙 2026-10-22-001 5-1): 부서(team_key)마다 이메일 목록. by 는 지정한 관리자, ts 는 지정 시각
TEAM_MANAGER_SCHEMA = ("CREATE TABLE IF NOT EXISTS team_managers (team_key TEXT NOT NULL, email TEXT NOT NULL, "
                       "by TEXT NOT NULL DEFAULT '', ts TEXT NOT NULL DEFAULT '', PRIMARY KEY (team_key, email))")
LIST_TTL, MAP_TTL = 30.0, 5.0              # 부서 목록과 이메일 → 부서 조회의 서버 캐시 유효 시간(스펙 2026-10-15-026 5-5)

_SCHEMA = "CREATE TABLE IF NOT EXISTS user_directory (email TEXT PRIMARY KEY, department TEXT NOT NULL DEFAULT '', ts TEXT NOT NULL DEFAULT '')"


def _now() -> str:
    return datetime.now().astimezone().isoformat(timespec="seconds")


def _meta(conn, key: str) -> str | None:
    row = conn.execute("SELECT value FROM meta WHERE key=?", (key,)).fetchone()
    return None if row is None else str(row["value"] or "")


def _set_meta(conn, key: str, value: str) -> None:
    conn.execute("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value=excluded.value", (key, value))


# ---- 서버 캐시(프로세스 안, 스펙 2026-10-15-026 5-5) ------------------------------------------------------------------
# 서버는 복제본이 둘이라 다른 복제본의 캐시는 비워지지 않는다. 그래서 쓰기 검증(department_exists)은 캐시를 읽지 않고,
# 캐시는 읽기 화면(부서 목록·이메일 → 부서)에만 쓴다. 키에 DB 위치를 넣어 시험이 데이터 폴더를 바꿔도 섞이지 않는다.
_cache: dict = {}
_cache_lock = threading.Lock()
_local_seeded: set = set()


def _db_key() -> tuple:
    import os
    return (db.backend(), os.environ.get("AAS_DATA_DIR", ""), os.environ.get("AAS_DB_SCHEMA", ""))


def _cached(name: str, ttl: float, fn):
    key = (name, _db_key())
    with _cache_lock:
        hit = _cache.get(key)
        if hit is not None and time.monotonic() - hit[0] < ttl:
            return hit[1]
    value = fn()
    with _cache_lock:
        _cache[key] = (time.monotonic(), value)
    return value


def _forget(name: str) -> None:
    with _cache_lock:
        _cache.pop((name, _db_key()), None)


def reset_cache() -> None:
    """이 프로세스의 부서 캐시를 모두 비운다(쓰기 뒤, 그리고 DB 를 직접 고친 시험)."""
    with _cache_lock:
        _cache.clear()
        _local_seeded.clear()


DEPT_EPOCH = "settings:departments"   # 부서 캐시를 다른 서버까지 비우는 cache_epoch 접두사(스펙 2026-10-26-001 리뷰 D10)
# 오피스 정보 변경 번호를 올리는 함수(office_changed.bump). aas/common 은 오피스를 모르므로 서버가 넣는다. 시험·CLI 에서는 None
changed_hook = None


def _written(*kinds: str) -> None:
    """부서 쓰기 뒤: 이 프로세스 캐시를 비우고, 다른 서버 캐시도 비우게 알리고, 오피스 화면이 다시 읽게 번호를 올린다.
    다른 서버 캐시를 비우지 않으면 그 서버에 붙은 화면이 변경 신호를 받고 다시 읽어도 30초 동안 옛 부서를 받는다(외부 검토 H1)."""
    reset_cache()
    from . import cache_epoch
    cache_epoch.bump(DEPT_EPOCH)
    if changed_hook is not None and kinds:
        try:
            changed_hook(*kinds)
        except Exception:                 # 번호를 못 올려도 부서 쓰기는 끝났다
            pass


def _drop_remote() -> None:
    """다른 서버가 부서를 바꿨으면 부서 캐시(목록·이메일 → 부서·부서 관리자)를 버린다. DB 를 읽지 않는다(cache_epoch 는 메모리 확인)."""
    from . import cache_epoch
    if cache_epoch.changed(DEPT_EPOCH):
        with _cache_lock:
            for name in ("list", "people", "team_managers"):
                _cache.pop((name, _db_key()), None)


def clean_company(value) -> str:
    """앞뒤·중복 공백을 줄인다. 줄바꿈은 공백이 된다."""
    return " ".join(str(value or "").split())


COMPANY_TTL = 30.0              # 회사 이름 서버 캐시(초). 바꾸면 cache_epoch 로 다른 서버도 1초 안에 버린다(스펙 2026-10-24-009 3-3)
COMPANY_EPOCH = "settings:company"


def company_name() -> str:
    """관리자가 정한 회사 이름(정하지 않았으면 빈 문자열). /api/me 와 서버 페이지마다 읽어 짧게 캐시한다."""
    from . import cache_epoch
    if cache_epoch.changed(COMPANY_EPOCH):
        _forget("company")

    def read() -> str:
        with store.connect() as conn:
            return _meta(conn, "company_name") or ""
    return _cached("company", COMPANY_TTL, read)


def effective_company() -> str:
    return company_name() or DEFAULT_COMPANY


IDENTITY_PREFIX = "You are CogentAI AAS Agent, built by "
# 전에 쓰던 앞부분. 제품 이름을 「CogentAI AAS」로 맞추며 바꿨다.
# 이 앞부분으로 넣은 문장은 기록(identity_history)에 없을 수 있어(템플릿 적용 등) 지금 회사 이름으로 만든 옛 문장도 알아본다.
LEGACY_IDENTITY_PREFIXES = ("You are AAS Agent, built by ",)


def identity_sentence(company: str | None = None, prefix: str = IDENTITY_PREFIX) -> str:
    """`You are CogentAI AAS Agent, built by <회사명>.` 회사 이름이 마침표로 끝나면(`OPENMARU, Inc.`) 마침표를 하나 더 붙이지 않는다."""
    name = company if company else effective_company()
    return f"{prefix}{name}" + ("" if name.endswith(".") else ".")


def identity_history() -> list[str]:
    with store.connect() as conn:
        raw = _meta(conn, "identity_history")
    try:
        out = json.loads(raw) if raw else []
    except ValueError:
        out = []
    seen = [str(x) for x in out if isinstance(x, str)]
    legacy = [identity_sentence(prefix=p) for p in LEGACY_IDENTITY_PREFIXES]
    return seen + [x for x in legacy if x not in seen]


def remember_identity(sentence: str) -> None:
    """이 문장을 SOUL 에 넣었다고 남긴다(다음에 회사 이름을 바꿀 때 찾을 수 있게)."""
    with store.connect() as conn:
        raw = _meta(conn, "identity_history")
        try:
            seen = json.loads(raw) if raw else []
        except ValueError:
            seen = []
        if sentence not in seen:
            _set_meta(conn, "identity_history", json.dumps([*seen, sentence][-50:], ensure_ascii=False))


def set_company_name(value, who: str = "local") -> str:
    """회사 이름을 저장하고 돌려준다. 맞지 않으면 ValueError. 바꾼 사람은 SOUL 자동 교체 기록의 「누가」로 쓴다."""
    name = clean_company(value)
    if len(name) > COMPANY_MAX:
        raise ValueError(f"company name is longer than {COMPANY_MAX} characters")
    with store.connect() as conn:
        _set_meta(conn, "company_name", name)
        _set_meta(conn, "company_by", str(who or "local"))
    from . import cache_epoch
    _forget("company")
    cache_epoch.bump(COMPANY_EPOCH)
    return name


def company_by() -> str:
    with store.connect() as conn:
        return _meta(conn, "company_by") or "local"


def set_department(email: str, department) -> bool:
    """Keycloak claim 으로 받은 부서를 적는다. 바뀌지 않았으면 쓰지 않는다. 실제로 바꿨는지 돌려준다 —
    로그인마다 부르므로 바뀐 경우에만 오피스 화면에 알린다(스펙 2026-10-26-001, 외부 검토 M3)."""
    email = str(email or "").strip().lower()
    if not email:
        return False
    dept = " ".join(str(department or "").split())[:DEPARTMENT_MAX]
    with store.connect() as conn:
        conn.execute(_SCHEMA)
        row = conn.execute("SELECT department FROM user_directory WHERE email=?", (email,)).fetchone()
        if row is not None and str(row["department"]) == dept:
            return False
        conn.execute("INSERT INTO user_directory (email, department, ts) VALUES (?,?,?) "
                     "ON CONFLICT (email) DO UPDATE SET department=excluded.department, ts=excluded.ts", (email, dept, _now()))
    _written("rooms", "banners", "departments")   # 방 구성원 부서(teams)·현수막·관리자 본인 부서
    return True


def default_template() -> str:
    """부서에 맞는 SOUL 템플릿이 없는 새 사용자에게 쓸 템플릿(「id.lang」, 비면 없음). 스펙 2026-10-14-003 리뷰 D9."""
    with store.connect() as conn:
        return _meta(conn, "soul_default_template") or ""


def set_default_template(value: str, who: str = "local") -> str:
    value = str(value or "").strip()[:120]
    with store.connect() as conn:
        _set_meta(conn, "soul_default_template", value)
        _set_meta(conn, "soul_default_template_by", f"{who} {_now()}")
    return value


def departments() -> dict[str, str]:
    """{email: 부서}. 부서가 빈 사람은 뺀다. 서버 캐시 TTL 5초(오피스 갱신 주기와 같다, 스펙 2026-10-15-026 R7)."""
    def read() -> dict[str, str]:
        with store.connect() as conn:
            conn.execute(_SCHEMA)
            return {str(r["email"]): str(r["department"]) for r in conn.execute("SELECT email, department FROM user_directory") if r["department"]}
    _drop_remote()
    # 5초 캐시가 끝날 때마다 다시 읽었다 — 표 바뀜 알림으로 버리는 프로세스 캐시를 그 아래에 둔다(스펙 2026-10-26-002 R10)
    return dict(_cached("people", MAP_TTL, lambda: table_cache.get("settings.departments", ("user_directory",), read, dict)))


# ---- 부서 목록(스펙 2026-10-15-026) -----------------------------------------------------------------------------------
class DepartmentError(ValueError):
    """code: empty(이름 없음) · exists(이미 있음) · missing(없음)."""

    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


def _dept_name(name) -> str:
    return " ".join(str(name or "").split())[:DEPARTMENT_MAX]


def ensure_department(name, who: str = "local") -> tuple[str, bool]:
    """목록에 없으면 더한다. (목록에 있는 이름, 새로 더했는가). 같은 team_key 가 이미 있으면 그 이름을 돌려준다.
    같은 이름을 동시에 더해도(복제본 둘) 기본 키 충돌을 ON CONFLICT 로 받아 한 줄만 남기고 새로 더한 쪽만 참을 돌려준다."""
    clean = _dept_name(name)
    if not clean:
        raise DepartmentError("empty")
    key = _team_key(clean)
    with store.connect() as conn:
        conn.execute(DEPT_SCHEMA)
        row = conn.execute("SELECT name FROM departments WHERE team_key=?", (key,)).fetchone()
        if row is not None:
            return str(row["name"]), False
        cur = conn.execute("INSERT INTO departments (team_key, name, by, ts) VALUES (?,?,?,?) ON CONFLICT (team_key) DO NOTHING",
                           (key, clean, str(who or "local"), _now()))
        created = cur.rowcount != 0
        if not created:
            clean = str(conn.execute("SELECT name FROM departments WHERE team_key=?", (key,)).fetchone()["name"])
    if created:
        _written("departments")
    return clean, created


def create_department(name, who: str = "local") -> str:
    """부서를 만든다. 이미 있으면 DepartmentError('exists')."""
    shown, created = ensure_department(name, who)
    if not created:
        raise DepartmentError("exists")
    return shown


def listed_name(name) -> str | None:
    """목록에 있는 그 부서의 이름(띄어쓰기·대소문자 무시)을 돌려준다. 없으면 None. 캐시를 읽지 않고 DB 에서 확인한다 — 다른 복제본이
    방금 지우거나 바꾼 부서가 TTL 동안 통과하지 않게 한다(스펙 2026-10-15-026 R3/D6)."""
    key = _team_key(_dept_name(name))
    if not key:
        return None
    with store.connect() as conn:
        conn.execute(DEPT_SCHEMA)
        row = conn.execute("SELECT name FROM departments WHERE team_key=?", (key,)).fetchone()
    return None if row is None else str(row["name"])


def department_exists(name) -> bool:
    return listed_name(name) is not None


def seeded() -> bool:
    """Keycloak 까지 포함한 처음 옮기기를 마쳤는가."""
    with store.connect() as conn:
        return bool(_meta(conn, "departments_seeded"))


def department_rows() -> list[dict]:
    """부서 목록 [{name, goal, ts}] 이름 순(서버 캐시 TTL 30초). 목록이 처음이면 기존 부서를 한 번 옮긴다(ensure_seeded)."""
    def read() -> list[dict]:
        ensure_seeded()
        with store.connect() as conn:
            conn.execute(DEPT_SCHEMA)
            rows = [(str(r["team_key"]), str(r["name"]), str(r["ts"])) for r in conn.execute("SELECT team_key, name, ts FROM departments")]
        have = goals()
        return sorted(({"name": n, "goal": have.get(k, {}).get("goal", ""), "ts": t} for k, n, t in rows), key=lambda r: _team_key(r["name"]))
    _drop_remote()
    return [dict(r) for r in _cached("list", LIST_TTL, read)]


def ensure_seeded(kc_departments=None, final: bool = False) -> int:
    """기존 부서를 목록으로 한 번 옮긴다(스펙 5-3). 출처: Keycloak 사용자의 department(kc_departments, 있을 때), user_directory,
    department_goals, 오피스 자리의 팀(team_src='dept'). 같은 team_key 는 가장 많이 쓰인 표기를 고르고 동률이면 앞선 표기다.
    final 이 참일 때만 완료 표시(meta departments_seeded)를 남긴다 — Keycloak 에 닿지 않았을 때는 표시를 남기지 않아 다음에 다시 한다.
    표시는 「표가 비었는가」가 아니라 이 값 하나로 정한다: set_goal 자동 등록이 먼저 행을 넣어도 옮기기가 건너뛰어지지 않는다.
    넣기가 ON CONFLICT DO NOTHING 이라 반복·동시 실행(복제본 둘)해도 결과가 같다. 새로 넣은 부서 수를 돌려준다."""
    key = _db_key()
    with store.connect() as conn:
        conn.execute(DEPT_SCHEMA)
        conn.execute(GOAL_SCHEMA)
        conn.execute(_SCHEMA)
        if _meta(conn, "departments_seeded"):
            return 0
    if kc_departments is None and not final and key in _local_seeded:
        return 0
    names = [_dept_name(n) for n in (kc_departments or [])]
    with store.connect() as conn:
        names += [_dept_name(r["department"]) for r in conn.execute("SELECT department FROM user_directory")]
        names += [_dept_name(r["team"]) for r in conn.execute("SELECT team FROM department_goals")]
    from ..office import office
    with office.connect() as oconn:
        names += [_dept_name(r["team"]) for r in oconn.execute("SELECT team FROM office_seats WHERE team_src='dept'")]
    seen: dict[str, Counter] = {}
    for n in names:
        if n:
            seen.setdefault(_team_key(n), Counter())[n] += 1
    added = 0
    with store.connect() as conn:
        for k, counts in seen.items():
            shown = sorted(counts, key=lambda n: (-counts[n], n))[0]
            cur = conn.execute("INSERT INTO departments (team_key, name, by, ts) VALUES (?,?,?,?) ON CONFLICT (team_key) DO NOTHING",
                               (k, shown, "system", _now()))
            added += 1 if cur.rowcount != 0 else 0
        if final:
            _set_meta(conn, "departments_seeded", _now())
    reset_cache()
    with _cache_lock:
        _local_seeded.add(key)
    return added


def rename_register(old, new, who: str = "local") -> str:
    """이름 바꾸기 1단계: 새 이름을 목록에 먼저 넣는다(옛 이름은 그대로, 스펙 6절 2). 옛 이름과 team_key 가 같으면 이름 칸만 바꾼다.
    옛 이름이 목록에 있으면 다른 부서와 겹칠 때 DepartmentError('exists')다. 옛 이름이 목록에 없으면(목록 밖 부서, 스펙 R6) 새 이름이
    이미 있어도 그 부서에 합치는 것이라 겹침이 아니다. 목록에 있는 새 이름을 돌려준다."""
    new_name, old_key = _dept_name(new), _team_key(_dept_name(old))
    if not new_name:
        raise DepartmentError("empty")
    new_key = _team_key(new_name)
    with store.connect() as conn:
        conn.execute(DEPT_SCHEMA)
        listed = conn.execute("SELECT 1 FROM departments WHERE team_key=?", (old_key,)).fetchone() is not None
    if not listed:
        return ensure_department(new_name, who)[0]          # 목록 밖 부서: 새 이름을 더하거나 기존 부서에 합친다
    with store.connect() as conn:
        if new_key == old_key:
            conn.execute("UPDATE departments SET name=?, by=?, ts=? WHERE team_key=?", (new_name, str(who or "local"), _now(), old_key))
        else:
            pending = _meta(conn, f"rename_pending:{new_key}")
            if pending is not None and pending == old_key:
                pass                                        # 앞선 시도가 부분 실패로 끝나 같은 이름 바꾸기를 이어서 한다(스펙 6절 6)
            else:
                cur = conn.execute("INSERT INTO departments (team_key, name, by, ts) VALUES (?,?,?,?) ON CONFLICT (team_key) DO NOTHING",
                                   (new_key, new_name, str(who or "local"), _now()))
                if cur.rowcount == 0:
                    raise DepartmentError("exists")         # 다른 부서와 겹친다
                _set_meta(conn, f"rename_pending:{new_key}", old_key)
    _written("departments")
    return new_name


def rename_finish(old, new) -> None:
    """이름 바꾸기 마지막 단계: 사용자 기록(user_directory)·슬로건을 새 이름으로 옮기고 옛 이름을 목록에서 지운다(옛 이름과 같은 team_key 면 지우지 않는다).
    오피스 자리의 팀은 5초마다 도는 자리 맞추기(office.default_teams)가 user_directory 를 따라 바꾼다."""
    new_name, old_key = _dept_name(new), _team_key(_dept_name(old))
    new_key = _team_key(new_name)
    with store.connect() as conn:
        conn.execute(DEPT_SCHEMA)
        conn.execute(GOAL_SCHEMA)
        conn.execute(_SCHEMA)
        for r in conn.execute("SELECT email, department FROM user_directory").fetchall():
            if _team_key(r["department"]) == old_key:
                conn.execute("UPDATE user_directory SET department=?, ts=? WHERE email=?", (new_name, _now(), r["email"]))
        from ..ops import notices                           # 공지 대상 부서 이름도 옮긴다(스펙 2026-10-24-007 R7). 순환 import 를 피해 여기서 부른다
        notices.rename_department(conn, old_key, new_name)
        row = conn.execute("SELECT goal, by FROM department_goals WHERE team_key=?", (old_key,)).fetchone()
        if new_key == old_key:
            conn.execute("UPDATE department_goals SET team=? WHERE team_key=?", (new_name, old_key))
        else:
            if row is not None:
                conn.execute("INSERT INTO department_goals (team_key, team, goal, by, ts) VALUES (?,?,?,?,?) ON CONFLICT (team_key) DO NOTHING",
                             (new_key, new_name, str(row["goal"]), str(row["by"]), _now()))
                conn.execute("DELETE FROM department_goals WHERE team_key=?", (old_key,))
            conn.execute("DELETE FROM departments WHERE team_key=?", (old_key,))
            # 팀 관리자 행도 새 키로 옮긴다. 새 키에 이미 있는 사람은 그대로 둔다(ON CONFLICT DO NOTHING)
            conn.execute(TEAM_MANAGER_SCHEMA)
            conn.execute("INSERT INTO team_managers (team_key, email, by, ts) SELECT ?, email, by, ts FROM team_managers WHERE team_key=? "
                         "ON CONFLICT (team_key, email) DO NOTHING", (new_key, old_key))
            conn.execute("DELETE FROM team_managers WHERE team_key=?", (old_key,))
        conn.execute("DELETE FROM meta WHERE key=?", (f"rename_pending:{new_key}",))
    _written("departments", "rooms", "banners")


def delete_department(name) -> bool:
    """부서와 그 슬로건을 지운다. 지웠으면 참. 소속 사용자 확인은 부르는 쪽(Keycloak 기준)이 한다."""
    key = _team_key(_dept_name(name))
    with store.connect() as conn:
        conn.execute(DEPT_SCHEMA)
        conn.execute(GOAL_SCHEMA)
        gone = conn.execute("DELETE FROM departments WHERE team_key=?", (key,)).rowcount != 0
        conn.execute("DELETE FROM department_goals WHERE team_key=?", (key,))
        conn.execute(TEAM_MANAGER_SCHEMA)
        conn.execute("DELETE FROM team_managers WHERE team_key=?", (key,))
    _written("departments", "rooms", "banners")
    return gone


# ---- 팀 관리자 ------------------------------------------------------------------------------------------------------
def team_managers() -> dict[str, list[str]]:
    """{team_key: [이메일, …]}(이메일은 소문자·정렬). 5초 캐시 — 권한 판정이 요청마다 여러 번 부른다."""
    def read():
        out: dict[str, list[str]] = {}
        with store.connect() as conn:
            conn.execute(TEAM_MANAGER_SCHEMA)
            for r in conn.execute("SELECT team_key, email FROM team_managers ORDER BY team_key, email").fetchall():
                out.setdefault(str(r["team_key"]), []).append(str(r["email"]))
        return out
    _drop_remote()
    return {k: list(v) for k, v in _cached("team_managers", MAP_TTL, read).items()}


def current_team_managers(team_key: str) -> list[str]:
    """그 부서의 팀 관리자 중 지금도 그 부서 사람인 이메일(정렬). 행은 있지만 부서를 옮긴 사람은 뺀다(스펙 §3)."""
    depts = departments()
    return [e for e in team_managers().get(team_key, []) if depts.get(e) and _team_key(depts[e]) == team_key]


def team_manager_since(email: str, team_key: str) -> str:
    """그 사람이 그 부서의 팀 관리자로 지정된 시각(ts). 행이 없으면 빈 값. 화면의 처음 안내 띠가 쓴다(디자인 DD9)."""
    with store.connect() as conn:
        conn.execute(TEAM_MANAGER_SCHEMA)
        row = conn.execute("SELECT ts FROM team_managers WHERE team_key=? AND email=?", (team_key, str(email or "").lower())).fetchone()
    return str(row["ts"]) if row else ""


def set_team_managers(department: str, emails: list[str], who: str = "local") -> list[str]:
    """그 부서의 팀 관리자를 이 목록으로 맞춘다. 목록에 없는 행만 지우고 새 이메일만 넣어, 그대로 남는 사람의 지정 시각(ts)·지정자(by)를 지킨다.
    부서에 속한 사람인지는 검사하지 않는다(부르는 서버가 한다). 저장한 이메일(소문자·중복 제거·정렬)을 돌려준다."""
    key = _team_key(_dept_name(department))
    keep = sorted({str(e or "").strip().lower() for e in emails or [] if str(e or "").strip()})
    with store.connect() as conn:
        conn.execute(TEAM_MANAGER_SCHEMA)
        for r in conn.execute("SELECT email FROM team_managers WHERE team_key=?", (key,)).fetchall():
            if r["email"] not in keep:
                conn.execute("DELETE FROM team_managers WHERE team_key=? AND email=?", (key, r["email"]))
        for e in keep:
            conn.execute("INSERT INTO team_managers (team_key, email, by, ts) VALUES (?,?,?,?) ON CONFLICT (team_key, email) DO NOTHING",
                         (key, e, str(who or "local"), _now()))
    _written("departments")
    return keep


# ---- 부서 슬로건·목표 -----------------------------------------------------------------------------------------------
def clean_goal(value) -> str:
    """앞뒤·중복 공백을 줄이고 줄바꿈을 공백으로 바꾼다."""
    return " ".join(str(value or "").split())


def _team_key(team) -> str:
    from ..office import office            # office 는 settings 를 읽지 않는다. 순환을 피하려고 함수 안에서 가져온다
    return office.team_key(team)


def set_goal(team, goal, who: str = "local") -> dict:
    """부서 한 곳의 문구를 저장한다. 문구가 비면 그 부서의 행을 지운다. 부서 이름이 비었거나 문구가 길면 ValueError."""
    name = " ".join(str(team or "").split())[:DEPARTMENT_MAX]
    text = clean_goal(goal)
    if not name:
        raise ValueError("department name is empty")
    if len(text) > GOAL_MAX:
        raise ValueError(f"goal is longer than {GOAL_MAX} characters")
    key = _team_key(name)
    with store.connect() as conn:
        conn.execute(GOAL_SCHEMA)
        if not text:
            conn.execute("DELETE FROM department_goals WHERE team_key=?", (key,))
        else:
            row = conn.execute("SELECT team FROM department_goals WHERE team_key=?", (key,)).fetchone()
            shown = str(row["team"]) if row is not None else name       # 처음 적은 표기를 지킨다
            conn.execute("INSERT INTO department_goals (team_key, team, goal, by, ts) VALUES (?,?,?,?,?) "
                         "ON CONFLICT (team_key) DO UPDATE SET goal=excluded.goal, by=excluded.by, ts=excluded.ts",
                         (key, shown, text, str(who or "local"), _now()))
    if text:
        ensure_department(name, who)          # 슬로건이 있는 부서는 목록에도 있게 한다(스펙 2026-10-15-026 R2). 슬로건을 지워도 부서는 지우지 않는다
    _written("banners")
    return {"team": name, "goal": text}


def goals() -> dict[str, dict]:
    """{team_key: {team, goal}} 문구가 있는 부서만."""
    with store.connect() as conn:
        conn.execute(GOAL_SCHEMA)
        return {str(r["team_key"]): {"team": str(r["team"]), "goal": str(r["goal"])} for r in conn.execute("SELECT team_key, team, goal FROM department_goals")}


def goal_rows() -> list[dict]:
    """회사 정보 화면의 부서 줄: 부서 목록(departments)의 부서마다 {team, goal, people}. people 은 그 부서 사람 수(user_directory, 표시용).
    부서 이름 순. 슬로건만 있고 목록에 없던 부서는 처음 옮기기(ensure_seeded)가 목록으로 옮긴다(스펙 2026-10-15-026 R5)."""
    people: Counter = Counter(_team_key(d) for d in departments().values())
    return [{"team": r["name"], "goal": r["goal"], "people": people.get(_team_key(r["name"]), 0)} for r in department_rows()]


def own_department(email) -> str:
    """로그인으로 알게 된 그 사람의 부서(없으면 빈 값). 일반 사용자가 고칠 수 있는 부서를 서버가 정하는 기준이다."""
    return departments().get(str(email or "").strip().lower(), "")


def own_goal_rows(email) -> list[dict]:
    """일반 사용자에게 보이는 부서 목록: 자기 부서 한 줄(부서가 없으면 빈 목록). {team, goal, people}.
    자기 부서가 목록에 없어도 한 줄은 보인다 — 저장하면 목록에 등록된다(OMAI-1230 규칙 유지, 스펙 2026-10-15-026 R5)."""
    dept = own_department(email)
    if not dept:
        return []
    key = _team_key(dept)
    for r in goal_rows():
        if _team_key(r["team"]) == key:
            return [r]
    people = sum(1 for d in departments().values() if _team_key(d) == key)
    return [{"team": dept, "goal": goals().get(key, {}).get("goal", ""), "people": people}]


def may_set_goal(email, team) -> bool:
    """일반 사용자가 이 부서의 문구를 고칠 수 있는가: 자기 부서(띄어쓰기·대소문자 무시)일 때만."""
    dept = own_department(email)
    return bool(dept) and _team_key(dept) == _team_key(team)


def banners(department: str = "", active=None) -> dict:
    """오피스 현수막용: 문구가 있는 부서 목록 [{team, goal}]과 보는 사람의 부서 표시(mine, 문구가 있는 부서 이름일 때만).
    active(팀 키 집합)를 주면 그 안의 부서만 낸다 — 사람도 자리 팀도 없는 부서의 옛 문구가 3D 오피스에 남지 않게 한다(OMAI-1236).
    주지 않으면 거르지 않는다(설정 화면은 문구가 있는 부서를 모두 보여야 지울 수 있다)."""
    have = goals()
    if active is not None:
        have = {k: v for k, v in have.items() if k in active}
    items = sorted(have.values(), key=lambda r: _team_key(r["team"]))
    mine = have.get(_team_key(department), {}).get("team", "") if department else ""
    return {"banners": items, "mine": mine}

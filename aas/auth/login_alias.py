# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""로그인 도메인(구글 Workspace 의 옛 도메인)으로 들어온 사람을 회사 도메인 사람으로 바꾼다(스펙 2026-11-15-005, OMAI-2037).

구글 로그인은 `@legacy.example.com` 으로만 되고 회사 이메일은 `@openmaru.io` 다. 이메일 앞부분이 같으면 같은 사람이다(U1).
정본은 Keycloak 사용자 하나이고, 그 사용자의 이메일을 회사 도메인으로 바꾼다. 아이디(username)와 sub 는 그대로다.

범위(2-1절, 사용자 결정 2026-11-15):
- 관리자 「전원 바꾸기」: 미리 보기 → 기록만 → 실행. 사람마다 Keycloak 이메일 → AAS 이메일 열 → HermesAgent 주인 이메일 순서로 하고
  단계를 진행 행(login_merges)에 남긴다. 실패하면 그 사람만 멈추고, 다시 누르면 남은 단계부터 한다.
- 새로 온 사람: 로그인 때(콜백에서 토큰 교환과 _validate 사이) 같은 일을 한 사람만 한다.
- 회사 이메일 사용자가 이미 있으면 합치지 않고 AAS-LM-NEEDS-ADMIN 으로 거절한다. 관리자가 Keycloak 에서 손으로 정리한다.

설정은 meta 표의 `login_alias`(JSON)다. 화면에서 저장한 적이 없으면 설치 값 AAS_LOGIN_DOMAIN_ALIASES(도메인 짝만, 켜지 않음)를 쓴다.
로그인마다 DB 를 한 번 읽는다 — 서버 메모리에 두지 않아 다른 서버에 알릴 것이 없다.
기록에는 토큰과 요청 본문을 남기지 않는다(HTTP 상태·Keycloak 오류 문자열·user id 만).
"""
from __future__ import annotations

import json
import logging
import os
import re
import socket
import threading
import time
from datetime import datetime, timedelta, timezone

from ..common import config, db, store
from ..common.i18n import tr

LOG = logging.getLogger("aas.auth")

META_KEY = "login_alias"
INSTALL_ENV = "AAS_LOGIN_DOMAIN_ALIASES"
MODES = ("off", "record", "on")
DEFAULT_PROVIDERS = ("google",)               # 차트 keycloak-google.sh 가 만드는 구글 제공자 alias
LOCK_TTL, LOCK_WAIT = 30.0, 10.0              # 사람별 잠금: 30초 만료(잡은 채 죽은 서버를 넘겨받는다), 10초 기다린 뒤 거절
SEEN_DAYS = 8                                 # 로그인 제공자 관찰을 남기는 날 수(화면은 7일을 보인다)
STALE_RUNNING = 3600.0                        # 이만큼 지난 「진행 중」 행은 「확인 필요」에 올린다(C-T3)
LIST_MAX = 100

# 오류 코드(T5). HTTP 상태와 함께 로그인 거절 화면·위젯 팝업 통보에 쓴다
NEEDS_ADMIN, RETRY, LOCK_TIMEOUT, LOGIN_AAS_FIRST = "AAS-LM-NEEDS-ADMIN", "AAS-LM-RETRY", "AAS-LM-LOCK-TIMEOUT", "AAS-LM-LOGIN-AAS-FIRST"
STATUS = {NEEDS_ADMIN: 403, RETRY: 503, LOCK_TIMEOUT: 503, LOGIN_AAS_FIRST: 403}

# 단계(진행 행 step). 앞에서부터 한다
STEPS = ("", "email_changed", "renamed", "agents_renamed")

SCHEMA = """
CREATE TABLE IF NOT EXISTS login_merges (
  id INTEGER PRIMARY KEY AUTOINCREMENT, created REAL NOT NULL, updated REAL NOT NULL, source TEXT NOT NULL DEFAULT '',
  mode TEXT NOT NULL DEFAULT '', kase TEXT NOT NULL DEFAULT '', result TEXT NOT NULL DEFAULT '', step TEXT NOT NULL DEFAULT '',
  user_id TEXT NOT NULL DEFAULT '', login_email TEXT NOT NULL DEFAULT '', company_email TEXT NOT NULL DEFAULT '',
  alias TEXT NOT NULL DEFAULT '', error TEXT NOT NULL DEFAULT '', attempts INTEGER NOT NULL DEFAULT 0, by TEXT NOT NULL DEFAULT '');
CREATE INDEX IF NOT EXISTS login_merges_user ON login_merges (user_id, id);
CREATE TABLE IF NOT EXISTS login_alias_locks (key TEXT PRIMARY KEY, owner TEXT NOT NULL, until REAL NOT NULL);
CREATE TABLE IF NOT EXISTS login_idp_seen (client TEXT NOT NULL, alias TEXT NOT NULL, day TEXT NOT NULL, n INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (client, alias, day));
"""

# ---- 이메일 열 이름 바꾸기(5절, E-T5) ---------------------------------------------------------------------------------
# 이름에 email·owner 가 든 열은 실행 때 스키마에서 찾는다 — 모듈이 처음 쓸 때 만드는 표도 운영 DB 에는 있다(T0: 29개).
# 값이 옛 이메일과 똑같은 행만 바꾸므로 이메일이 아닌 열이 섞여도 바뀌지 않는다. 아래 두 목록은 그 규칙의 예외다.
NOT_EMAIL = {
    ("connector_tokens", "lease_owner"),      # 임대를 잡은 서버 id
    ("login_merges", "login_email"),          # 이 기능의 처리 기록(바꾸기 전 값을 남긴다)
    ("login_merges", "company_email"),
}
EXTRA_EMAIL = {                               # 이름에 email·owner 가 없지만 사람을 가리는 열(처리 기록 by·handled_by 등은 그대로 둔다)
    ("admin_requests", "requester"),          # 「내 요청」 목록이 이 값으로 찾는다
    ("pc_imports", "by_user"), ("pc_exports", "by_user"),
    ("chat_session_meta", "opened_by"),
    ("skill_authored", "who"),
}
_EMAILISH = re.compile(r"email|owner", re.I)

DOMAIN = re.compile(r"^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$")
ALIAS = re.compile(r"^[A-Za-z0-9._-]{1,64}$")
EMAIL = re.compile(r"^[^@\s]{1,64}@[a-z0-9.-]{1,253}$")


class ConfigError(ValueError):
    """설정 저장 거절. 화면이 그 칸의 그 줄에 표시한다(400 {code, field, line, value, expected})."""

    def __init__(self, code: str, field: str, line: int, value: str, expected: str, message: str):
        super().__init__(message)
        self.code, self.field, self.line, self.value, self.expected = code, field, line, value, expected

    def body(self) -> dict:
        return {"error": str(self), "code": self.code, "field": self.field, "line": self.line, "value": self.value,
                "expected": self.expected}


class AliasError(Exception):
    """로그인을 멈춘다. code 는 위 오류 코드, ref 는 진행 행 id(설정 화면 처리 기록에서 찾는다)."""

    def __init__(self, code: str, message: str, ref: int = 0):
        super().__init__(message)
        self.code, self.ref, self.status = code, ref, STATUS.get(code, 403)

    def text(self) -> str:
        ref = f", {tr('추적', 'ref')} {self.ref}" if self.ref else ""
        return f"{self} ({self.code}{ref})"


def _conn():
    conn = store.connect()
    conn.executescript(SCHEMA)
    return conn


# ---- 설정 ------------------------------------------------------------------------------------------------------------
def _lines(value) -> list[str]:
    if isinstance(value, list):
        return [str(x) for x in value]
    return str(value or "").replace(",", "\n").splitlines()


def parse_pairs(value, field: str = "pairs") -> list[list[str]]:
    """도메인 짝. 문자열이면 `a:b,c:d` 또는 줄마다 `a:b`(설치 값과 화면이 같은 함수). 목록이면 [[a, b], …] 또는 ["a:b", …]."""
    raw = value if isinstance(value, list) else _lines(value)
    out, seen = [], set()
    for n, item in enumerate(raw, 1):
        if isinstance(item, (list, tuple)):
            text = ":".join(str(x) for x in item)
        else:
            text = str(item)
        text = text.strip()
        if not text:
            continue
        login, sep, company = (s.strip().lower().lstrip("@") for s in text.partition(":"))
        if not sep or not DOMAIN.match(login) or not DOMAIN.match(company):
            raise ConfigError("bad_pair", field, n, text, "login.example:company.example",
                              tr(f"{n}번째 줄의 도메인 짝이 틀렸습니다. 「로그인도메인:회사도메인」 꼴로 적으세요",
                                 f"Line {n}: the domain pair is invalid. Use login-domain:company-domain"))
        if login == company:
            raise ConfigError("same_domain", field, n, text, "login.example:company.example",
                              tr(f"{n}번째 줄: 로그인 도메인과 회사 도메인이 같습니다", f"Line {n}: the login and company domains are the same"))
        if login in seen:
            raise ConfigError("duplicate", field, n, text, "login.example:company.example",
                              tr(f"{n}번째 줄: 로그인 도메인 {login} 이 두 번 나옵니다", f"Line {n}: login domain {login} appears twice"))
        seen.add(login)
        out.append([login, company])
    companies = {c for _, c in out}
    for n, (login, _) in enumerate(out, 1):
        if login in companies:                 # a→b, b→c 처럼 이어지면 두 번 바뀐다
            raise ConfigError("chained", field, n, login, "login.example:company.example",
                              tr(f"{login} 이 로그인 도메인이면서 회사 도메인입니다", f"{login} is both a login and a company domain"))
    return out


def _parse_providers(value) -> list[str]:
    out = []
    for n, item in enumerate(_lines(value), 1):
        item = item.strip()
        if not item:
            continue
        if not ALIAS.match(item):
            raise ConfigError("bad_alias", "providers", n, item, "google",
                              tr(f"{n}번째 로그인 제공자 이름이 틀렸습니다(영문·숫자·. _ -)", f"Login provider {n} is invalid (letters, digits, . _ -)"))
        if item not in out:
            out.append(item)
    return out


def _parse_exclude(value) -> list[str]:
    out = []
    for n, item in enumerate(_lines(value), 1):
        item = item.strip().lower()
        if not item:
            continue
        if not EMAIL.match(item):
            raise ConfigError("bad_email", "exclude", n, item, "name@login.example",
                              tr(f"{n}번째 줄이 이메일 꼴이 아닙니다", f"Line {n} is not an email address"))
        if item not in out:
            out.append(item)
    return out


def validate(body: dict) -> dict:
    """화면이 보낸 설정을 검사해 저장할 꼴로 만든다. 틀리면 ConfigError."""
    mode = str(body.get("mode") or "off")
    if mode not in MODES:
        raise ConfigError("bad_mode", "mode", 0, mode, "|".join(MODES), tr("켜기 값이 틀렸습니다", "Invalid mode"))
    cfg = {"mode": mode, "pairs": parse_pairs(body.get("pairs") or []), "providers": _parse_providers(body.get("providers") or []),
           "exclude": _parse_exclude(body.get("exclude") or [])}
    if mode != "off" and not cfg["pairs"]:
        raise ConfigError("pairs_required", "pairs", 0, "", "login.example:company.example",
                          tr("켜려면 도메인 짝이 하나 이상 있어야 합니다", "Add at least one domain pair to turn this on"))
    if mode != "off" and not cfg["providers"]:
        raise ConfigError("providers_required", "providers", 0, "", "google",
                          tr("켜려면 대상 로그인 제공자가 하나 이상 있어야 합니다", "Add at least one login provider to turn this on"))
    return cfg


def install_config() -> dict:
    """설치 값. 도메인 짝만 채우고 켜지 않는다. 값이 틀리면 짝 없이(서버 로그에 남긴다)."""
    raw = config.get(INSTALL_ENV, "")
    try:
        pairs = parse_pairs(raw, "install")
    except ConfigError as exc:
        LOG.warning("login_alias_install_value_invalid line=%s code=%s", exc.line, exc.code)
        pairs = []
    return {"mode": "off", "pairs": pairs, "providers": list(DEFAULT_PROVIDERS), "exclude": []}


def load() -> tuple[dict, str]:
    """(설정, 출처). 출처: screen(화면에서 저장) · install(설치 값)."""
    try:
        with store.connect() as conn:
            row = conn.execute("SELECT value FROM meta WHERE key=?", (META_KEY,)).fetchone()
        if row and row["value"]:
            data = json.loads(row["value"])
            cfg = {"mode": data.get("mode") if data.get("mode") in MODES else "off", "pairs": data.get("pairs") or [],
                   "providers": data.get("providers") or [], "exclude": data.get("exclude") or [],
                   "by": data.get("by") or "", "ts": data.get("ts") or ""}
            return cfg, "screen"
    except Exception as exc:                       # 설정을 읽지 못하면 끈 것으로 본다(로그인은 지금처럼)
        LOG.warning("login_alias_load_failed %s", type(exc).__name__)
        return {"mode": "off", "pairs": [], "providers": [], "exclude": []}, "error"
    return install_config(), "install"


def save(body: dict, by: str) -> dict:
    cfg = validate(body)
    cfg["by"], cfg["ts"] = by, datetime.now().astimezone().isoformat(timespec="seconds")
    with store.connect() as conn:
        conn.execute("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value=excluded.value",
                     (META_KEY, json.dumps(cfg, ensure_ascii=False)))
    store.log_usage("login_alias_settings", f"{by} mode={cfg['mode']} pairs={len(cfg['pairs'])}")
    return cfg


def reset(by: str) -> dict:
    """화면 값을 지우고 설치 값으로 되돌린다."""
    with store.connect() as conn:
        conn.execute("DELETE FROM meta WHERE key=?", (META_KEY,))
    store.log_usage("login_alias_settings", f"{by} reset")
    return install_config()


def company_of(cfg: dict, email: str) -> str:
    """로그인 도메인 이메일이면 회사 이메일, 아니면 빈 문자열."""
    local, _, dom = str(email or "").lower().rpartition("@")
    for login, company in cfg.get("pairs") or []:
        if local and dom == login:
            return f"{local}@{company}"
    return ""


# ---- 판단(순수 함수, C-T2) ------------------------------------------------------------------------------------------
def decide(cfg: dict, claims: dict) -> dict:
    """이번 로그인에 할 일. case: off · not_target · excluded · no_claim · not_provider · target.
    target 일 때만 Keycloak 을 읽는다(회사 이메일 사용자가 있으면 needs_admin, 없으면 rename)."""
    email = str(claims.get("email") or "").lower()
    alias = str(claims.get("identity_provider") or "")
    out = {"case": "off", "login_email": email, "company_email": "", "alias": alias}
    if cfg.get("mode") not in ("record", "on") or not cfg.get("pairs"):
        return out
    company = company_of(cfg, email)
    if not company or claims.get("email_verified") is not True:
        return {**out, "case": "not_target"}
    out["company_email"] = company
    if email in (cfg.get("exclude") or []):
        return {**out, "case": "excluded"}
    if not alias:
        return {**out, "case": "no_claim"}
    if alias not in (cfg.get("providers") or []):
        return {**out, "case": "not_provider"}
    return {**out, "case": "target"}


def login_idp(claims: dict, client: str) -> str:
    """세션에 남길 로그인 방식(관찰용): idp:<alias> · password(그 client 에 claim 이 온 적이 있고 이번에는 없음) · unknown."""
    alias = str(claims.get("identity_provider") or "")
    if alias:
        return "idp:" + alias[:64]
    try:
        with _conn() as conn:
            seen = conn.execute("SELECT 1 FROM login_idp_seen WHERE client=? AND alias<>'' LIMIT 1", (client,)).fetchone()
    except Exception:
        return "unknown"
    return "password" if seen else "unknown"


def observe(client: str, alias: str, now: float | None = None) -> None:
    """로그인 제공자 관찰(D-T1): client 별·날짜별로 alias(없으면 빈 값) 수를 센다. 실패해도 로그인은 막지 않는다."""
    now = time.time() if now is None else now
    day = datetime.fromtimestamp(now, timezone.utc).strftime("%Y-%m-%d")
    try:
        with _conn() as conn:
            conn.execute("INSERT INTO login_idp_seen (client, alias, day, n) VALUES (?,?,?,1) "
                         "ON CONFLICT (client, alias, day) DO UPDATE SET n=login_idp_seen.n+1", (client[:120], alias[:64], day))
            old = (datetime.fromtimestamp(now, timezone.utc) - timedelta(days=SEEN_DAYS)).strftime("%Y-%m-%d")
            conn.execute("DELETE FROM login_idp_seen WHERE day<?", (old,))
    except Exception as exc:
        LOG.warning("login_idp_observe_failed %s", type(exc).__name__)


def observed(days: int = 7, now: float | None = None) -> list[dict]:
    now = time.time() if now is None else now
    since = (datetime.fromtimestamp(now, timezone.utc) - timedelta(days=days - 1)).strftime("%Y-%m-%d")
    with _conn() as conn:
        rows = conn.execute("SELECT client, alias, SUM(n) AS n FROM login_idp_seen WHERE day>=? GROUP BY client, alias "
                            "ORDER BY client, alias", (since,)).fetchall()
    return [{"client": r["client"], "alias": r["alias"], "n": int(r["n"] or 0)} for r in rows]


# ---- 진행 행 ---------------------------------------------------------------------------------------------------------
_COLS = "id, created, updated, source, mode, kase, result, step, user_id, login_email, company_email, alias, error, attempts, by"


def _row(r) -> dict:
    return {k: r[k] for k in _COLS.split(", ")}


def record(source: str, mode: str, kase: str, result: str, d: dict, user_id: str = "", by: str = "", error: str = "") -> int:
    now = time.time()
    with _conn() as conn:
        r = conn.execute("INSERT INTO login_merges (created, updated, source, mode, kase, result, step, user_id, login_email, company_email, "
                         "alias, error, attempts, by) VALUES (?,?,?,?,?,?,'',?,?,?,?,?,0,?) RETURNING id",
                         (now, now, source, mode, kase, result, user_id, d.get("login_email", ""), d.get("company_email", ""),
                          d.get("alias", ""), error[:300], by)).fetchone()
    store.log_usage("login_merge", f"{source} {kase} {result} {d.get('login_email', '')} -> {d.get('company_email', '')}")
    return int(r[0])


def _update(row_id: int, **cols) -> None:
    cols["updated"] = time.time()
    keys = ", ".join(f"{k}=?" for k in cols)
    with _conn() as conn:
        conn.execute(f"UPDATE login_merges SET {keys} WHERE id=?", (*cols.values(), row_id))


def get(row_id: int) -> dict | None:
    with _conn() as conn:
        r = conn.execute(f"SELECT {_COLS} FROM login_merges WHERE id=?", (row_id,)).fetchone()
    return _row(r) if r else None


def records(limit: int = LIST_MAX) -> list[dict]:
    with _conn() as conn:
        rows = conn.execute(f"SELECT {_COLS} FROM login_merges ORDER BY id DESC LIMIT ?", (limit,)).fetchall()
    return [_row(r) for r in rows]


def unfinished() -> list[dict]:
    """끝나지 않은 이름 바꾸기 행(running·failed). 같은 사람의 더 늦은 행이 끝냈으면 뺀다."""
    with _conn() as conn:
        rows = conn.execute(f"SELECT {_COLS} FROM login_merges WHERE kase='rename' AND result IN ('running','failed') ORDER BY id").fetchall()
        done = {(r["user_id"], r["company_email"], int(r["id"])) for r in
                conn.execute("SELECT user_id, company_email, id FROM login_merges WHERE kase='rename' AND result='done'").fetchall()}
    out = []
    for r in rows:
        if any(u == r["user_id"] and c == r["company_email"] and i > int(r["id"]) for u, c, i in done):
            continue
        out.append(_row(r))
    return out


def attention(now: float | None = None) -> list[dict]:
    """「확인 필요」: 거절(회사 이메일 사용자가 이미 있음)·실패, 1시간 넘게 진행 중인 행. 같은 사람이 뒤에 끝났으면 뺀다."""
    now = time.time() if now is None else now
    with _conn() as conn:
        rows = conn.execute(f"SELECT {_COLS} FROM login_merges WHERE result IN ('rejected','failed','running') AND kase IN ('rename','needs_admin') "
                            "ORDER BY id DESC LIMIT ?", (LIST_MAX * 5,)).fetchall()
        done = conn.execute("SELECT login_email, MAX(id) AS id FROM login_merges WHERE result='done' GROUP BY login_email").fetchall()
    last_done = {r["login_email"]: int(r["id"]) for r in done}
    out, seen = [], set()
    for r in rows:
        if r["result"] == "running" and now - float(r["updated"]) < STALE_RUNNING:
            continue
        if last_done.get(r["login_email"], 0) > int(r["id"]) or r["login_email"] in seen:
            continue
        seen.add(r["login_email"])
        out.append(_row(r))
    return out[:LIST_MAX]


# ---- 사람별 잠금(E-T3): 열쇠는 회사 이메일(소문자) ----------------------------------------------------------------------
_OWNER = f"{socket.gethostname()}:{os.getpid()}"


def _try_lock(key: str, owner: str, now: float) -> bool:
    with _conn() as conn:
        n = conn.execute("INSERT INTO login_alias_locks (key, owner, until) VALUES (?,?,?) ON CONFLICT (key) DO UPDATE "
                         "SET owner=excluded.owner, until=excluded.until WHERE login_alias_locks.until<?",
                         (key, owner, now + LOCK_TTL, now)).rowcount
    return n == 1


def lock(key: str, wait: float | None = None) -> str | None:
    """잡으면 소유 표시(풀 때 넘긴다), wait 초(기본 LOCK_WAIT) 안에 못 잡으면 None. 만료된 잠금은 넘겨받는다."""
    owner = f"{_OWNER}:{threading.get_ident()}:{time.monotonic_ns()}"
    end = time.monotonic() + (LOCK_WAIT if wait is None else wait)
    while True:
        if _try_lock(key.lower(), owner, time.time()):
            return owner
        if time.monotonic() >= end:
            return None
        time.sleep(0.2)


def unlock(key: str, owner: str) -> None:
    try:
        with _conn() as conn:
            conn.execute("DELETE FROM login_alias_locks WHERE key=? AND owner=?", (key.lower(), owner))
    except Exception as exc:
        LOG.warning("login_alias_unlock_failed %s", type(exc).__name__)


# ---- 이름 바꾸기 ------------------------------------------------------------------------------------------------------
def email_columns(conn) -> list[tuple[str, str]]:
    """바꿀 (표, 열). 이름에 email·owner 가 든 열 + EXTRA_EMAIL − NOT_EMAIL. 지금 DB 에 있는 것만."""
    out = []
    for table in sorted(db.table_names(conn)):
        if table.startswith("sqlite_"):
            continue
        for col in sorted(db.columns(conn, table)):
            key = (table, col)
            if key in NOT_EMAIL:
                continue
            if _EMAILISH.search(col) or key in EXTRA_EMAIL:
                out.append(key)
    return out


def _pk(conn, table: str) -> list[str]:
    if db.is_pg(conn):
        rows = conn.execute("SELECT a.attname FROM pg_index i JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=ANY(i.indkey) "
                            "WHERE i.indrelid=to_regclass(?) AND i.indisprimary", (table,)).fetchall()
        return [r[0] for r in rows]
    return [r[1] for r in sorted((r for r in conn.execute(f"PRAGMA table_info({table})") if r[5]), key=lambda r: r[5])]


def rename_records(old: str, new: str) -> dict:
    """AAS 의 이메일 기준 기록을 옛 이메일 → 새 이메일로 바꾼다. {표.열: 바꾼 행 수}.
    기본 키에 든 열은 행마다 본다: 새 이메일의 같은 행이 이미 있으면(관리자가 미리 넣은 권한 등) 새 쪽을 남기고 옛 행을 지운다."""
    old, new = old.strip().lower(), new.strip().lower()
    done: dict[str, int] = {}
    with store.connect() as conn:
        cols = email_columns(conn)
    for table, col in cols:
        with store.connect() as conn:
            pk = _pk(conn, table)
            if col not in pk:
                n = conn.execute(f"UPDATE {table} SET {col}=? WHERE lower({col})=?", (new, old)).rowcount
            else:
                n = 0
                rest = [c for c in pk if c != col]
                for r in conn.execute(f"SELECT {', '.join(pk)} FROM {table} WHERE lower({col})=?", (old,)).fetchall():
                    key = {c: r[c] for c in rest}
                    where = " AND ".join([f"{col}=?", *[f"{c}=?" for c in rest]])
                    clash = conn.execute(f"SELECT 1 FROM {table} WHERE {where}", (new, *key.values())).fetchone()
                    own = " AND ".join([f"lower({col})=?", *[f"{c}=?" for c in rest]])
                    if clash:
                        conn.execute(f"DELETE FROM {table} WHERE {own}", (old, *key.values()))
                    else:
                        conn.execute(f"UPDATE {table} SET {col}=? WHERE {own}", (new, old, *key.values()))
                    n += 1
        if n:
            done[f"{table}.{col}"] = n
    return done


def rename_agents(client, old: str, new: str, sub: str) -> list[str]:
    """HermesAgent 주인 이메일(ownerEmail)을 바꾼다. ownerSub 가 옛 이메일이던 것(sub 를 모를 때 만든 것)은 sub 로 고친다."""
    if client is None:
        return []
    out = []
    for item in client.list_agents():
        spec = item.get("spec") or {}
        if str(spec.get("ownerEmail") or "").lower() != old:
            continue
        patch = {"ownerEmail": new}
        if str(spec.get("ownerSub") or "").lower() == old:
            patch["ownerSub"] = sub or new
        name = (item.get("metadata") or {}).get("name", "")
        client.patch_agent(name, {"spec": patch})
        out.append(name)
    return out


ON_RENAMED: list = []                         # (옛 이메일, 새 이메일) 을 받는 함수. 서버가 세션 끝내기·캐시 버리기를 넣는다


def _k8s():
    try:
        from ..fleet import k8s
        return k8s.client()
    except Exception:
        return None


def _err(exc: Exception) -> str:
    """기록에 남길 원인: 오류 이름·HTTP 상태·Keycloak 오류 문자열. 토큰·본문은 넣지 않는다."""
    code = getattr(exc, "code", "")
    detail = getattr(exc, "detail", "")
    return " ".join(str(x) for x in (type(exc).__name__, code, detail) if x)[:300]


class Conflict(Exception):
    """회사 이메일이 Keycloak 에 이미 있다(이메일 PUT 409)."""


def run_person(kc, token: str, row_id: int, user_id: str, old: str, new: str, k8s_client=None, end_sessions: bool = True) -> dict:
    """한 사람: Keycloak 이메일 → AAS 이메일 열 → HermesAgent 주인. 진행 행의 단계부터 이어 한다. 실패하면 행을 failed 로 두고 올린다."""
    row = get(row_id) or {}
    step = row.get("step") or ""
    _update(row_id, result="running", attempts=int(row.get("attempts") or 0) + 1, error="")
    try:
        if STEPS.index(step) < 1:
            rep = kc.get_user(user_id, token)
            if str(rep.get("email") or "").lower() != new:
                try:
                    kc.set_email(user_id, new, token)
                except Exception as exc:
                    if getattr(exc, "code", 0) == 409:
                        raise Conflict(str(exc)) from None
                    raise
            step = "email_changed"
            _update(row_id, step=step)
        if STEPS.index(step) < 2:
            changed = rename_records(old, new)
            step = "renamed"
            _update(row_id, step=step, error=json.dumps(changed)[:300] if changed else "")
        if STEPS.index(step) < 3:
            rename_agents(k8s_client if k8s_client is not None else _k8s(), old, new, user_id)
            step = "agents_renamed"
            _update(row_id, step=step)
    except Conflict:
        _update(row_id, result="rejected", kase="needs_admin", error="409 company email exists")
        raise
    except Exception as exc:
        _update(row_id, result="failed", error=_err(exc))
        raise
    _update(row_id, result="done")
    if end_sessions:
        for fn in ON_RENAMED:
            try:
                fn(old, new)
            except Exception as exc:
                LOG.warning("login_alias_on_renamed_failed %s", type(exc).__name__)
    store.log_usage("login_merge", f"rename done {old} -> {new} ref={row_id}")
    return get(row_id) or {}


def _company_users(kc, token: str, company: str, user_id: str) -> list[dict]:
    return [u for u in kc.find_by_email(company, token) if u.get("id") != user_id]


def _needs_admin(company: str, ref: int) -> AliasError:
    return AliasError(NEEDS_ADMIN, tr(f"회사 이메일 계정({company})이 이미 있어 로그인을 이어 갈 수 없습니다. 관리자에게 계정 정리를 요청하세요",
                                      f"A company account ({company}) already exists, so sign-in cannot continue. Ask an admin to tidy up the accounts"), ref)


# ---- 로그인 때(4절 나) -------------------------------------------------------------------------------------------------
def at_login(claims: dict, tokens: dict, client: str, refresh, source: str = "login", kc=None) -> tuple[dict, dict] | None:
    """로그인 콜백에서 토큰 교환 뒤·_validate 앞에 부른다. 할 일이 없으면 None(지금처럼 계속).
    이메일을 바꿨으면 (새 tokens, 새 id_token claim) — refresh(refresh_token) 이 다시 받아 검사까지 한 값이다. 멈추면 AliasError."""
    cfg, _ = load()
    observe(client, str(claims.get("identity_provider") or ""))
    d = decide(cfg, claims)
    if d["case"] != "target":
        if d["case"] in ("excluded", "no_claim", "not_provider"):
            LOG.info("login_alias_skip case=%s client=%s", d["case"], client)
        return None
    mode, user_id = cfg["mode"], str(claims.get("sub") or "")
    if kc is None:
        from . import keycloak
        kc = keycloak.admin_from_config()
    if kc is None:
        ref = record(source, mode, "rename", "failed", d, user_id, error="no_admin_client")
        if mode == "record":
            return None
        raise AliasError(RETRY, tr("Keycloak 관리 설정이 없어 로그인을 처리하지 못했습니다. 관리자에게 알려 주세요",
                                   "Sign-in could not be processed: the Keycloak admin client is not configured. Tell an admin"), ref)
    owner = lock(d["company_email"])
    if owner is None:
        raise AliasError(LOCK_TIMEOUT, tr("다른 창에서 로그인을 처리하고 있습니다. 잠시 뒤 다시 로그인하세요",
                                          "Sign-in is being processed in another window. Sign in again shortly"))
    try:
        try:
            token = kc.token()
            company = _company_users(kc, token, d["company_email"], user_id)
        except Exception as exc:
            ref = record(source, mode, "rename", "failed", d, user_id, error=_err(exc))
            if mode == "record":
                return None
            raise AliasError(RETRY, tr("로그인을 처리하지 못했습니다. 1분 뒤 다시 로그인하세요", "Sign-in could not be processed. Sign in again in a minute"), ref) from None
        if company:
            ref = record(source, mode, "needs_admin", "rejected" if mode == "on" else "recorded", d, user_id)
            if mode == "on":
                raise _needs_admin(d["company_email"], ref)
            return None
        if mode == "record":
            record(source, mode, "rename", "recorded", d, user_id)
            return None
        ref = record(source, mode, "rename", "running", d, user_id)
        try:
            run_person(kc, token, ref, user_id, d["login_email"], d["company_email"])
        except Conflict:
            raise _needs_admin(d["company_email"], ref) from None
        except Exception:
            raise AliasError(RETRY, tr("로그인을 처리하지 못했습니다. 1분 뒤 다시 로그인하세요", "Sign-in could not be processed. Sign in again in a minute"), ref) from None
        rt = str(tokens.get("refresh_token") or "")
        try:
            if not rt:
                raise ValueError("no refresh token")
            new_tokens, new_claims = refresh(rt)
        except Exception as exc:
            _update(ref, error=("refresh " + _err(exc))[:300])
            raise AliasError(RETRY, tr("이메일을 회사 도메인으로 바꿨습니다. 다시 로그인하세요", "Your email was changed to the company domain. Sign in again"), ref) from None
        if str(new_claims.get("email") or "").lower() != d["company_email"] or str(new_claims.get("sub") or "") != user_id:
            _update(ref, error="refresh returned another identity")
            raise AliasError(RETRY, tr("이메일을 회사 도메인으로 바꿨습니다. 다시 로그인하세요", "Your email was changed to the company domain. Sign in again"), ref)
        return new_tokens, new_claims
    finally:
        unlock(d["company_email"], owner)


def is_login_domain(email: str) -> bool:
    """설정이 꺼지지 않았고 이 이메일이 로그인 도메인인가. 임베드 앱 토큰 교환이 쓴다(E-T4)."""
    cfg, _ = load()
    return cfg.get("mode") in ("record", "on") and bool(company_of(cfg, email))


def login_aas_first() -> AliasError:
    return AliasError(LOGIN_AAS_FIRST, tr("AAS 에 한 번 로그인하면 이어집니다", "Sign in to AAS once, then this continues"))


# ---- 관리자 「전원 바꾸기」(2-1절) ----------------------------------------------------------------------------------------
def preview(kc, cfg: dict | None = None) -> list[dict]:
    """Keycloak 의 로그인 도메인 사용자와 바뀔 회사 이메일(읽기만). conflict: 회사 이메일 사용자가 이미 있음. excluded: 제외 목록."""
    cfg = cfg or load()[0]
    token = kc.token()
    users = kc.list_users(token)
    by_email = {str(u.get("email") or "").lower(): u for u in users}
    out = []
    for u in users:
        email = str(u.get("email") or "").lower()
        company = company_of(cfg, email)
        if not company:
            continue
        other = by_email.get(company)
        out.append({"user_id": u["id"], "username": u.get("username") or "", "login_email": email, "company_email": company,
                    "enabled": u.get("enabled", True) is not False, "excluded": email in (cfg.get("exclude") or []),
                    "conflict": bool(other and other.get("id") != u["id"])})
    return sorted(out, key=lambda r: r["login_email"])


def bulk(kc, action: str, by: str, k8s_client=None) -> dict:
    """action: record(판단만 남김) · run(실행). 끝나지 않은 행을 먼저 이어 하고, 미리 보기의 사람을 차례로 한다.
    한 사람이 실패해도 다음 사람으로 간다. {done, recorded, rejected, failed, skipped, rows}."""
    if action not in ("record", "run"):
        raise ValueError(action)
    cfg = load()[0]
    if not cfg.get("pairs"):
        raise ConfigError("pairs_required", "pairs", 0, "", "login.example:company.example",
                          tr("도메인 짝이 없습니다. 먼저 설정을 저장하세요", "No domain pairs. Save the settings first"))
    token = kc.token()
    counts = {"done": 0, "recorded": 0, "rejected": 0, "failed": 0, "skipped": 0}
    rows: list[int] = []

    def one(row_id: int, user_id: str, old: str, new: str) -> None:
        owner = lock(new, wait=2.0)
        if owner is None:
            _update(row_id, result="failed", error="lock busy")
            counts["failed"] += 1
            return
        try:
            run_person(kc, token, row_id, user_id, old, new, k8s_client)
            counts["done"] += 1
        except Conflict:
            counts["rejected"] += 1
        except Exception:
            counts["failed"] += 1
        finally:
            unlock(new, owner)

    resumed = set()
    if action == "run":
        for r in unfinished():
            resumed.add(r["user_id"])
            rows.append(r["id"])
            one(r["id"], r["user_id"], r["login_email"], r["company_email"])
    for p in preview(kc, cfg):
        if p["user_id"] in resumed:
            continue
        d = {"login_email": p["login_email"], "company_email": p["company_email"], "alias": ""}
        if p["excluded"]:
            counts["skipped"] += 1
            continue
        if p["conflict"]:
            rows.append(record("bulk", action, "needs_admin", "rejected" if action == "run" else "recorded", d, p["user_id"], by))
            counts["rejected" if action == "run" else "recorded"] += 1
            continue
        if action == "record":
            rows.append(record("bulk", action, "rename", "recorded", d, p["user_id"], by))
            counts["recorded"] += 1
            continue
        ref = record("bulk", action, "rename", "running", d, p["user_id"], by)
        rows.append(ref)
        one(ref, p["user_id"], p["login_email"], p["company_email"])
    store.log_usage("login_alias_bulk", f"{by} {action} " + " ".join(f"{k}={v}" for k, v in counts.items()))
    return {**counts, "rows": rows}

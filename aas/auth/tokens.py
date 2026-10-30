# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""Claude Code 연결 — 개인 접근 토큰과 OAuth 연결(스펙 2026-10-28-001 §3-1·§3-1-2, OMAI-1513).

원문은 만들 때 한 번만 돌려주고 DB 에는 sha256 만 둔다(auth_sessions 와 같은 방식).
줄 하나가 「연결 하나」다(디자인 D5): 수동 토큰은 토큰 하나, OAuth 는 같은 family 의 refresh 계보.
권한은 발급한 사람 그대로이고, 토큰 요청에서는 관리자 권한을 쓰지 않는다(D5 — Registry.is_admin 이 본다).
"""
from __future__ import annotations

import hashlib
import secrets
import time

from ..common import store
from ..common.i18n import tr


def _person(value: str) -> str:
    """기록의 「누가」(이메일) → 화면에 보일 이름(2026-10-30). 오피스 모듈을 늦게 부른다."""
    from ..office import office
    return office.person_name(value)

SCHEMA = """
CREATE TABLE IF NOT EXISTS personal_tokens (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, family TEXT NOT NULL,
  user_sub TEXT NOT NULL DEFAULT '', user_email TEXT NOT NULL, name TEXT NOT NULL,
  bundle TEXT NOT NULL, scopes TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, prefix TEXT NOT NULL,
  created REAL NOT NULL, expires REAL NOT NULL, last_used REAL NOT NULL DEFAULT 0, last_ip TEXT NOT NULL DEFAULT '',
  revoked REAL NOT NULL DEFAULT 0, revoked_by TEXT NOT NULL DEFAULT '', revoke_reason TEXT NOT NULL DEFAULT '');
CREATE INDEX IF NOT EXISTS personal_tokens_email ON personal_tokens (user_email);
CREATE TABLE IF NOT EXISTS oauth_clients (client_id TEXT PRIMARY KEY, name TEXT NOT NULL, redirect_uris TEXT NOT NULL, created REAL NOT NULL);
CREATE TABLE IF NOT EXISTS oauth_codes (
  code_hash TEXT PRIMARY KEY, client_id TEXT NOT NULL, user_email TEXT NOT NULL, user_sub TEXT NOT NULL DEFAULT '',
  redirect_uri TEXT NOT NULL, challenge TEXT NOT NULL, bundle TEXT NOT NULL, expires REAL NOT NULL, used REAL NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS oauth_refresh (
  family TEXT PRIMARY KEY, client_id TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, prev_hash TEXT NOT NULL DEFAULT '',
  prev_until REAL NOT NULL DEFAULT 0, grace_blob TEXT NOT NULL DEFAULT '', access_expires REAL NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS token_notice_acks (item_id TEXT PRIMARY KEY, email TEXT NOT NULL, ts REAL NOT NULL);
"""

PAT_PREFIX = "aas_pat_"
SCOPES = ("chat", "files:read", "files:write", "skills:write", "secrets:write", "approve", "commands",
          "profile:write", "cron", "mcp:write", "channels", "market")
BUNDLES = {                                                   # 묶음(§3-1, Q9). 동의 화면·만들기 창은 묶음만 고른다
    "all": SCOPES,
    "skill-dev": ("chat", "files:read", "files:write", "skills:write", "secrets:write", "approve"),
    "read": ("chat", "files:read"),
}
EXPIRY_DAYS = (7, 30, 60, 90)                                 # 수동 토큰(Q5, 재검토 D2). 무기한 없음
DEFAULT_DAYS = 30
MAX_ACTIVE = 10                                               # 사람당 연결 수(Q6, 재검토 D3)
NAME_MAX = 60
USED_EVERY = 60.0                                             # 마지막 사용 시각은 60초에 한 번만 쓴다(D10)
KEEP_ENDED = 30 * 86400                                       # 끝난 연결은 30일 보인다(디자인 D5)


class TokenError(Exception):
    def __init__(self, message: str, code: int = 400, reason: str = ""):
        super().__init__(message)
        self.code, self.reason = code, reason


def _conn():
    conn = store.connect()
    conn.executescript(SCHEMA)
    return conn


def _hash(raw: str) -> str:
    return hashlib.sha256(raw.encode()).hexdigest()


def _view(r, now: float) -> dict:
    """화면에 보이는 한 줄. 원문·해시는 넣지 않는다."""
    state = "revoked" if r["revoked"] else "expired" if r["expires"] < now else "active"
    return {"id": r["id"], "kind": r["kind"], "name": r["name"], "bundle": r["bundle"], "scopes": r["scopes"].split(),
            "prefix": r["prefix"], "created": r["created"], "expires": r["expires"], "last_used": r["last_used"] or None,
            "last_ip": r["last_ip"], "state": state, "ended": r["revoked"] or (r["expires"] if state == "expired" else None),
            "revoked_by": r["revoked_by"], "revoke_reason": r["revoke_reason"]}


def active_count(email: str, now: float | None = None) -> int:
    now = time.time() if now is None else now
    with _conn() as conn:
        row = conn.execute("SELECT COUNT(DISTINCT family) AS n FROM personal_tokens WHERE user_email=? AND revoked=0 AND expires>=?",
                           (email.lower(), now)).fetchone()
    return int(row["n"] or 0)


def issue(user: dict, name: str, bundle: str, days: int, now: float | None = None) -> tuple[dict, str]:
    """수동 토큰을 만든다. (화면 한 줄, 원문). 원문은 이때 한 번만 돌려준다."""
    now = time.time() if now is None else now
    email = str((user or {}).get("email") or "").lower()
    if not email:
        raise TokenError(tr("로그인이 필요합니다", "Sign in required"), 401, "auth")
    name = " ".join(str(name or "").split())
    if not name:
        raise TokenError(tr("이름을 적으세요", "Enter a name"), 400, "name")
    if len(name) > NAME_MAX:
        raise TokenError(tr(f"이름은 {NAME_MAX}자 이하로 적습니다", f"Use {NAME_MAX} characters or fewer"), 400, "name")
    if bundle not in BUNDLES:
        raise TokenError(tr("알 수 없는 묶음입니다", "Unknown bundle"), 400, "bundle")
    if days not in EXPIRY_DAYS:
        raise TokenError(tr("만료는 7·30·60·90일 중에서 고릅니다", "Choose 7, 30, 60 or 90 days"), 400, "days")
    if active_count(email, now) >= MAX_ACTIVE:
        raise TokenError(tr(f"연결은 {MAX_ACTIVE}개까지입니다. 더 만들려면 안 쓰는 것을 끊으세요",
                            f"Up to {MAX_ACTIVE} connections. Disconnect one you no longer use"), 409, "limit")
    raw = PAT_PREFIX + secrets.token_urlsafe(32)
    tid = secrets.token_hex(8)
    row = {"id": tid, "kind": "pat", "family": tid, "user_sub": str(user.get("sub") or ""), "user_email": email, "name": name,
           "bundle": bundle, "scopes": " ".join(BUNDLES[bundle]), "token_hash": _hash(raw), "prefix": raw[len(PAT_PREFIX):][:8],
           "created": now, "expires": now + days * 86400, "last_used": 0, "last_ip": "", "revoked": 0, "revoked_by": "",
           "revoke_reason": ""}
    with _conn() as conn:
        conn.execute("INSERT INTO personal_tokens (id, kind, family, user_sub, user_email, name, bundle, scopes, token_hash, prefix, "
                     "created, expires) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
                     (tid, "pat", tid, row["user_sub"], email, name, bundle, row["scopes"], row["token_hash"], row["prefix"],
                      now, row["expires"]))
    store.log_usage("pat_create", f"{email} {tid} bundle={bundle} days={days}")
    return _view(row, now), raw


ROTATE_GRACE = 3600.0                                         # 바꾼 뒤 옛 토큰을 쓸 수 있는 시간(Claude Code 설정을 바꿀 여유)


def rotate(row: dict, days: int = DEFAULT_DAYS, now: float | None = None) -> tuple[dict, str]:
    """수동 토큰을 새것으로 바꾼다(token_rotate, §3-1-1 B). 이름·묶음은 그대로, 옛 토큰은 1시간 뒤 끝난다.
    연결 수 상한은 보지 않는다 — 같은 연결을 이어 쓰는 것이라서다."""
    now = time.time() if now is None else now
    if row.get("kind") != "pat":
        raise TokenError(tr("화면에서 만든 토큰만 바꿀 수 있습니다", "Only tokens made on the screen can be rotated"), 400, "kind")
    if days not in EXPIRY_DAYS:
        raise TokenError(tr("만료는 7·30·60·90일 중에서 고릅니다", "Choose 7, 30, 60 or 90 days"), 400, "days")
    raw = PAT_PREFIX + secrets.token_urlsafe(32)
    tid = secrets.token_hex(8)
    expires = now + days * 86400
    with _conn() as conn:
        conn.execute("INSERT INTO personal_tokens (id, kind, family, user_sub, user_email, name, bundle, scopes, token_hash, prefix, "
                     "created, expires) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
                     (tid, "pat", tid, row["user_sub"], row["user_email"], row["name"], row["bundle"], row["scopes"], _hash(raw),
                      raw[len(PAT_PREFIX):][:8], now, expires))
        conn.execute("UPDATE personal_tokens SET expires=?, revoke_reason=? WHERE id=? AND expires>?",
                     (now + ROTATE_GRACE, "rotated", row["id"], now + ROTATE_GRACE))
        new = conn.execute("SELECT * FROM personal_tokens WHERE id=?", (tid,)).fetchone()
    store.log_usage("pat_rotate", f"{row['user_email']} {row['id']} -> {tid} days={days}")
    return _view(new, now), raw


EXPIRING_DAYS = 7                                             # 메뉴 배지·만료 알림(디자인 D10)


def summary(email: str, now: float | None = None) -> dict:
    """메뉴 배지·계정 서랍 한 줄: 살아 있는 연결 수와 7일 안에 끝나는 수동 토큰 수(OAuth 는 쓰면 늘어나 세지 않는다)."""
    now = time.time() if now is None else now
    rows = list_for(email, now=now)
    return {"active": len({r["id"] for r in rows}),
            "expiring": sum(1 for r in rows if r["kind"] == "pat" and r["expires"] - now <= EXPIRING_DAYS * 86400)}


NOTICE_PREFIX = "conn|"
NOTICE_KEEP = 14 * 86400                                      # 남이 끊은 연결의 알림을 보이는 기간


def inbox_items(email: str, now: float | None = None) -> list[dict]:
    """받은편지함(스펙 2026-10-28-001 §3-7 ③, 디자인 D10·D19): 7일 안에 끝나는 연결, 다른 사람(관리자·AAS)이 끊은 연결.
    연결마다 한 번 — 「확인」하면 지운다. 만료 알림 id 에 만료 시각을 넣어, OAuth 가 쓰여 늘어난 뒤 다시 다가오면 새 알림이 된다."""
    now = time.time() if now is None else now
    email = (email or "").lower()
    if not email:
        return []
    with _conn() as conn:
        acked = {r["item_id"] for r in conn.execute("SELECT item_id FROM token_notice_acks WHERE email=?", (email,))}
    out = []
    for r in list_for(email, include_ended=True, now=now):
        base = {"kind": "connection", "alias": "", "text": "", "name": r["name"], "token_kind": r["kind"], "expires": r["expires"]}
        if r["state"] == "active" and r["expires"] - now <= EXPIRING_DAYS * 86400:
            item = {**base, "id": f"{NOTICE_PREFIX}exp|{r['id']}|{int(r['expires'])}", "status": "expiring", "at": r["expires"] - EXPIRING_DAYS * 86400}
        elif (r["state"] == "revoked" and r["revoked_by"] and r["revoked_by"] not in (email, "keycloak")
              and now - float(r["ended"] or 0) <= NOTICE_KEEP):
            item = {**base, "id": f"{NOTICE_PREFIX}rev|{r['id']}", "status": "revoked", "by": r["revoked_by"], "by_name": _person(r["revoked_by"]), "reason": r["revoke_reason"],
                    "at": r["ended"]}
        else:
            continue
        if item["id"] not in acked:
            out.append(item)
    return out


def notice_ack(item_id: str, email: str, now: float | None = None) -> None:
    """그 사람의 알림만 지운다. 남의 연결 알림이면 ValueError."""
    now = time.time() if now is None else now
    email = (email or "").lower()
    parts = item_id[len(NOTICE_PREFIX):].split("|")
    if len(parts) < 2 or parts[0] not in ("exp", "rev"):
        raise ValueError("unknown")
    with _conn() as conn:
        r = conn.execute("SELECT user_email FROM personal_tokens WHERE id=?", (parts[1],)).fetchone()
        if r is None or r["user_email"] != email:
            raise ValueError("not yours")
        conn.execute("INSERT INTO token_notice_acks (item_id, email, ts) VALUES (?,?,?) ON CONFLICT (item_id) DO NOTHING", (item_id, email, now))


def list_for(email: str, include_ended: bool = False, now: float | None = None) -> list[dict]:
    """그 사람의 연결. 끝난 줄은 include_ended 일 때 30일 안의 것만."""
    now = time.time() if now is None else now
    with _conn() as conn:
        rows = conn.execute("SELECT * FROM personal_tokens WHERE user_email=? ORDER BY created DESC", (email.lower(),)).fetchall()
    out = []
    for r in rows:
        v = _view(r, now)
        if v["state"] == "active" or (include_ended and now - float(v["ended"] or 0) <= KEEP_ENDED):
            out.append(v)
    return out


def list_all(include_ended: bool = False, now: float | None = None) -> list[dict]:
    """관리자 화면(디자인 D19)."""
    now = time.time() if now is None else now
    with _conn() as conn:
        rows = conn.execute("SELECT * FROM personal_tokens ORDER BY created DESC").fetchall()
    out = []
    for r in rows:
        v = _view(r, now)
        if v["state"] == "active" or (include_ended and now - float(v["ended"] or 0) <= KEEP_ENDED):
            out.append({**v, "email": r["user_email"]})
    return out


def revoke(token_id: str, email: str, by: str = "", reason: str = "", now: float | None = None) -> bool:
    """email 의 연결 하나를 끊는다(같은 family 모두). 끊었으면 True, 없거나 이미 끝났으면 False."""
    now = time.time() if now is None else now
    with _conn() as conn:
        r = conn.execute("SELECT family FROM personal_tokens WHERE id=? AND user_email=?", (token_id, email.lower())).fetchone()
        if r is None:
            return False
        n = conn.execute("UPDATE personal_tokens SET revoked=?, revoked_by=?, revoke_reason=? WHERE family=? AND revoked=0",
                         (now, (by or email).lower(), reason[:200], r["family"])).rowcount
    if n:
        store.log_usage("pat_revoke", f"{(by or email).lower()} {token_id} of={email.lower()}" + (f" reason={reason[:200]}" if reason else ""))
    return bool(n)


def revoke_all(email: str, by: str = "", now: float | None = None) -> int:
    """그 사람의 연결을 모두 끊는다. 끊은 줄 수."""
    now = time.time() if now is None else now
    with _conn() as conn:
        n = conn.execute("UPDATE personal_tokens SET revoked=?, revoked_by=? WHERE user_email=? AND revoked=0",
                         (now, (by or email).lower(), email.lower())).rowcount
    store.log_usage("pat_revoke_all", f"{(by or email).lower()} of={email.lower()} n={n}")
    return n


def lookup(raw: str, now: float | None = None) -> dict | None:
    """Bearer 원문 → 살아 있는 줄. 틀렸거나 끝났으면 None. 끝난 이유는 reason 으로 따로 본다(lookup_state)."""
    state, row = lookup_state(raw, now)
    return row if state == "active" else None


def lookup_state(raw: str, now: float | None = None) -> tuple[str, dict | None]:
    """('active'|'expired'|'revoked'|'unknown', 줄)."""
    now = time.time() if now is None else now
    if not raw:
        return "unknown", None
    with _conn() as conn:
        r = conn.execute("SELECT * FROM personal_tokens WHERE token_hash=?", (_hash(raw),)).fetchone()
    if r is None:
        return "unknown", None
    d = dict(r)
    if d["revoked"]:
        return "revoked", d
    if d["expires"] < now:
        return "expired", d
    if d["kind"] == "oauth":                                  # OAuth 줄의 expires 는 연결(refresh) 만료다. 접근 토큰은 1시간(§3-1-1 A)
        with _conn() as conn:
            ref = conn.execute("SELECT access_expires FROM oauth_refresh WHERE family=?", (d["family"],)).fetchone()
        if ref is None or float(ref["access_expires"]) < now:
            return "expired", d
    return "active", d


def mark_used(token_id: str, ip: str, now: float | None = None) -> bool:
    """마지막 사용 시각·IP. 앞 기록에서 60초가 지났을 때만 쓴다(D10). 썼으면 True."""
    now = time.time() if now is None else now
    with _conn() as conn:
        n = conn.execute("UPDATE personal_tokens SET last_used=?, last_ip=? WHERE id=? AND last_used<=?",
                         (now, ip[:64], token_id, now - USED_EVERY)).rowcount
    return bool(n)

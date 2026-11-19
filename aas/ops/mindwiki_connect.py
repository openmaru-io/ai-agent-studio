# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""MindWiki 계정으로 연결(스펙 2026-11-14-001 2단계). 프로파일 주인이 버튼을 누르면 AAS 서버가 그 사람의 Keycloak 액세스 토큰으로
MindWiki 에 개인 토큰(wiki_pat_)을 받아 그 프로파일의 MindWiki MCP 서버에 붙인다.

  흐름    start() 가 임대(connector_tokens 행 pending)를 잡고 뒤 작업을 띄운 뒤 곧바로 돌아간다. 화면은 카탈로그를 다시 읽어 상태를 본다.
  토큰    Keycloak 액세스 토큰은 Auth.access_token 으로 갱신해서만 얻고 메모리로만 쓴다. wiki_pat_ 는 Hermes .env 에만 들어가고
          DB·로그·응답에는 남기지 않는다(DB 에는 MindWiki 의 토큰 id·이름·기한만).
  MindWiki 쪽은 연결 client(aas)로 GET /api/me 와 /api/tokens 만 쓸 수 있다(MindWiki 스펙 2026-11-14-006).
  지울 일  MCP 서버·프로파일을 지우면 MindWiki 토큰을 지울 일(connector_jobs)로 남긴다. 액세스 토큰은 버튼을 누를 때만 있으므로
          그 사람이 다음에 연결 버튼을 누를 때 지운다. 다섯 번 실패하면 만료(최대 90일)에 맡긴다.
  자동 점검(스펙 2026-11-14-012 3단계) 로그인·갱신 때 받은 액세스 토큰으로 next_check_at 이 지난 행을 점검한다:
          회수 감지(200 + tokens 일 때만 revoked), 기한 전 재발급(예전 토큰은 prev_tid 로 두고 「지금 적용」 뒤 지운다),
          설치 값을 켜면 주 프로파일 자동 첫 연결. 사람 작업이 늘 먼저다(자동 임대는 status 를 덮지 않고, 결과를 쓸 때 주인을 다시 본다).

  행 상태    idle ─버튼→ pending ─→ connected ─(회수)→ revoked ─버튼→ pending
                                   │  └(MCP 서버 지움, 자동 연결 켜짐)→ opted_out ─버튼→ pending
                                   └(실패) failed
          자동 점검은 status 를 바꾸지 않고 auto_reason·next_check_at 만 고친다(revoked 만 예외).
"""
from __future__ import annotations

import base64
import hashlib
import json
import os
import secrets
import ssl
import threading
import time
import traceback
import urllib.error
import urllib.request
from collections.abc import Callable
from datetime import datetime, timedelta, timezone

from ..assets.files import FileError
from ..common import config, db, store
from ..hermes.hermes_api import HermesAPI, HermesError
from . import mcp_servers

PRODUCT = "mindwiki"
SOON_DAYS = 14
MAX_DAYS = 90
WRITE_DAYS = 30            # 에이전트 도구가 프로파일 .env 를 읽을 수 있다(0-11) — 쓰기 토큰은 기한을 줄인다(스펙 5-3)
DELETE_ATTEMPTS = 5
WORKERS = threading.BoundedSemaphore(4)
# 3단계 자동 점검의 숫자(스펙 2026-11-14-012 A11). 설치 값으로 바꾸지 않는다
CHECK_EVERY = 12 * 3600                # 성공 뒤 다음 점검
RETRY_AFTER = 3600                     # 일시적 실패 뒤 다음 점검
REISSUE_DAYS, REISSUE_WRITE_DAYS = 30, 10
AUTO_LEASE = 60                        # 자동 점검 임대(호출 넷 × 시간 초과 + 여유)
MAX_DRAIN = 5                          # 점검 한 번에 처리하는 지울 일
IDP_STREAK = 24                        # MindWiki 401 이 이만큼 이어지면 12시간 간격으로 내린다
APPLY_GRACE = 600                      # 「지금 적용」 성공 뒤 예전 토큰을 지우기까지 기다리는 시간
MIN_TOKEN_LEFT = 30                    # 액세스 토큰이 이보다 덜 남았으면 MindWiki 를 부르지 않는다
TRANSIENT = ("timeout", "mindwiki_5xx", "hermes_not_ready", "keycloak_unavailable", "idp_token_rejected")

# 화면·로그가 쓰는 이유 코드(스펙 4절 「이유 코드」). 화면 문구는 ui 의 profiles.mcp.mindwikiReason.<코드>
REASONS = ("iss_or_client_rejected", "no_workspace", "need_workspace", "token_limit", "token_request_rejected", "write_disabled",
           "daily_limit", "guest", "account_disabled", "connector_scope", "no_refresh_token", "session_ended", "keycloak_unavailable",
           "timeout", "mindwiki_5xx", "tls", "forbidden", "hermes_not_ready", "hermes_reload", "lease_busy", "expired", "internal",
           "idp_token_rejected", "internal_error")

SCHEMA = """
CREATE TABLE IF NOT EXISTS connector_tokens (
  product TEXT NOT NULL, sub TEXT NOT NULL, pod TEXT NOT NULL, profile TEXT NOT NULL, tid TEXT NOT NULL DEFAULT '',
  workspace TEXT NOT NULL DEFAULT '', write INTEGER NOT NULL DEFAULT 0, name TEXT NOT NULL DEFAULT '', expires_at TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending', reason TEXT NOT NULL DEFAULT '', detail TEXT NOT NULL DEFAULT '', tool_count INTEGER NOT NULL DEFAULT 0,
  lease_until REAL NOT NULL DEFAULT 0, lease_owner TEXT NOT NULL DEFAULT '', last_checked TEXT NOT NULL DEFAULT '',
  notified_at TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT '',
  prev_tid TEXT NOT NULL DEFAULT '', prev_expires_at TEXT NOT NULL DEFAULT '', prev_workspace TEXT NOT NULL DEFAULT '',
  apply_gen INTEGER NOT NULL DEFAULT 0, applied_gen INTEGER NOT NULL DEFAULT 0, applied_at REAL NOT NULL DEFAULT 0,
  next_check_at REAL NOT NULL DEFAULT 0, auto_reason TEXT NOT NULL DEFAULT '', auto_streak INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (product, sub, pod, profile));
CREATE TABLE IF NOT EXISTS connector_jobs (
  product TEXT NOT NULL, sub TEXT NOT NULL, pod TEXT NOT NULL, profile TEXT NOT NULL, kind TEXT NOT NULL, tid TEXT NOT NULL,
  workspace TEXT NOT NULL DEFAULT '', attempts INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, PRIMARY KEY (product, sub, tid));
"""


class MindwikiTimeout(Exception):
    pass


class MindwikiTLSError(Exception):
    pass


class MindwikiHTTPError(Exception):
    def __init__(self, status: int, code: str = "", message: str = ""):
        super().__init__(f"HTTP {status} {code}")
        self.status, self.code, self.message = status, code, message


class Failed(Exception):
    """이유 코드로 끝낸다. detail 은 화면에 보일 값(워크스페이스 목록·AAS 토큰 목록)."""
    def __init__(self, reason: str, detail=None):
        super().__init__(reason)
        self.reason, self.detail = reason, detail


# ---- 설치 값 ---------------------------------------------------------------------------------------------------------

def enabled() -> bool:
    """「MindWiki 계정으로 연결」 버튼. 주소(AAS_MINDWIKI_URL)가 없으면 켜도 꺼진 것으로 본다."""
    return bool(mcp_servers.mindwiki_url()) and config.get("AAS_MINDWIKI_ACCOUNT_CONNECT", "").strip().lower() in ("1", "true", "yes", "on")


def _flag(name: str, default: bool) -> bool:
    """true·false 만 받는다. 그 밖의 값은 꺼짐(config_warning 이 알린다)."""
    raw = config.get(name, "").strip().lower()
    return default if raw == "" else raw == "true"


def auto_check_enabled() -> bool:
    """재발급·회수 점검(스펙 2026-11-14-012 A10). 기본 켬. 거짓 revoked·한도 소진 때 운영자가 끈다."""
    return enabled() and _flag("AAS_MINDWIKI_AUTO_CHECK", True)


def auto_connect_enabled() -> bool:
    """주 프로파일 자동 첫 연결(A1). 기본 켬(2026-11-15, 처음에는 꺼짐). 점검이 꺼져 있으면 함께 꺼진다."""
    return auto_check_enabled() and _flag("AAS_MINDWIKI_AUTO_CONNECT", True)


def config_warning() -> str:
    """서버 시작 때 한 줄. 주소 없이 다른 값만 있으면 기능이 꺼진다고 알린다. 3단계 스위치의 잘못된 값도 알린다."""
    others = [k for k in ("AAS_MINDWIKI_ACCOUNT_CONNECT", "AAS_MINDWIKI_WORKSPACE") if config.get(k).strip()]
    if others and not mcp_servers.mindwiki_url():
        return f"AAS_MINDWIKI_URL 이 없어 {', '.join(others)} 를 쓰지 않습니다(MindWiki 계정으로 연결 꺼짐)"   # i18n-ignore: 서버 로그
    bad = [k for k in ("AAS_MINDWIKI_AUTO_CHECK", "AAS_MINDWIKI_AUTO_CONNECT") if config.get(k, "").strip().lower() not in ("", "true", "false")]
    if bad:
        return f"{', '.join(bad)} 는 true·false 만 받습니다. 꺼짐으로 봅니다"   # i18n-ignore: 서버 로그
    return ""


def timeout_s() -> float:
    try:
        return min(max(float(config.get("AAS_MINDWIKI_TIMEOUT_S", "5")), 1.0), 30.0)
    except ValueError:
        return 5.0


def token_days(write: bool) -> int:
    try:
        days = int(config.get("AAS_MINDWIKI_TOKEN_DAYS", str(MAX_DAYS)))
    except ValueError:
        days = MAX_DAYS
    days = min(max(days, 1), MAX_DAYS)
    return min(days, WRITE_DAYS) if write else days


def token_body(profile: str, write: bool) -> dict:
    """POST /api/tokens 본문. 자동화 전용 프로파일(mindwiki-auto…)의 쓰기 토큰은 자동화 전용이다(스펙 2026-11-15-002 D24): MindWiki 가 그
    토큰의 쓰기를 열린 자동화 실행의 대상으로만 받는다."""
    from .mindwiki_webhook import AUTO_PROFILES
    body = {"name": token_name(profile), "write": write, "days": token_days(write)}
    if write and profile in AUTO_PROFILES:
        body["automation"] = True
    return body


def want_auto(sub: str, pod: str, profile: str, workspace: str = "") -> None:
    """자동 첫 연결을 기다리는 빈 행(idle)을 둔다. 다음 로그인·갱신 때 on_login 이 잇는다(자동 첫 연결이 켜진 설치).
    workspace 는 자동화가 있는 MindWiki 워크스페이스다. 워크스페이스가 여럿인 사람도 그것으로 연결한다(need_workspace 로 건너뛰지 않게).
    MindWiki 는 실행의 워크스페이스와 토큰의 워크스페이스가 같아야 그 쓰기를 받는다."""
    with _conn() as conn:
        conn.execute("INSERT INTO connector_tokens (product, sub, pod, profile, workspace, status, created_at) VALUES (?,?,?,?,?,'idle',?) "
                     "ON CONFLICT (product, sub, pod, profile) DO NOTHING", (PRODUCT, sub, pod, profile, workspace[:80], _iso(_now())))
        if workspace:                                                  # 아직 잇지 못한 빈 행이면 워크스페이스를 고친다
            conn.execute("UPDATE connector_tokens SET workspace=? WHERE product=? AND sub=? AND pod=? AND profile=? AND tid='' AND status='idle'",
                         (workspace[:80], PRODUCT, sub, pod, profile))


def token_name(profile: str) -> str:
    """MindWiki 는 연결 client 가 만드는 토큰 이름이 「AAS 」로 시작해야 받는다(80자까지). 설치마다 다른 8자로 다른 AAS 설치와 가른다."""
    install = hashlib.sha256(config.get("AAS_PUBLIC_URL", "aas").encode()).hexdigest()[:8]
    return f"AAS {install} {profile}"[:80]


# ---- DB ---------------------------------------------------------------------------------------------------------------

# 3단계에서 더한 칸. 2단계 표가 이미 있는 설치(OKE)는 CREATE TABLE IF NOT EXISTS 로 칸이 생기지 않는다(스펙 2026-11-14-012 A12)
NEW_COLUMNS = ("prev_tid TEXT NOT NULL DEFAULT ''", "prev_expires_at TEXT NOT NULL DEFAULT ''", "prev_workspace TEXT NOT NULL DEFAULT ''",
               "apply_gen INTEGER NOT NULL DEFAULT 0", "applied_gen INTEGER NOT NULL DEFAULT 0", "applied_at REAL NOT NULL DEFAULT 0",
               "next_check_at REAL NOT NULL DEFAULT 0", "auto_reason TEXT NOT NULL DEFAULT ''", "auto_streak INTEGER NOT NULL DEFAULT 0")
_MIGRATED: set = set()


def _conn():
    conn = store.connect()
    conn.executescript(SCHEMA)
    key = (db.backend(), os.environ.get("AAS_DATA_DIR", ""), os.environ.get("AAS_DB_SCHEMA", ""))
    if key not in _MIGRATED:                                       # 프로세스·DB 마다 한 번. 서버 두 대가 함께 더해도 add_column 이 견딘다
        have = db.columns(conn, "connector_tokens")
        for ddl in NEW_COLUMNS:
            if ddl.split()[0] not in have:
                db.add_column(conn, "connector_tokens", ddl)
        _MIGRATED.add(key)
    return conn


def now() -> float:
    """모든 시각 비교의 한 곳. 시험은 이것을 바꿔 넣는다(스펙 2026-11-14-012 A12)."""
    return time.time()


def _now() -> datetime:
    return datetime.fromtimestamp(now(), timezone.utc)


def _iso(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).isoformat(timespec="seconds")


def _row(sub: str, pod: str, profile: str) -> dict | None:
    with _conn() as conn:
        r = conn.execute("SELECT * FROM connector_tokens WHERE product=? AND sub=? AND pod=? AND profile=?", (PRODUCT, sub, pod, profile)).fetchone()
    return dict(r) if r else None


def _update(sub: str, pod: str, profile: str, owner: str, **cols) -> bool:
    """임대 주인일 때만 고친다. 주인이 바뀌었으면(다른 작업이 잡음) False."""
    keys = list(cols)
    with _conn() as conn:
        n = conn.execute(f"UPDATE connector_tokens SET {', '.join(k + '=?' for k in keys)} WHERE product=? AND sub=? AND pod=? AND profile=? AND lease_owner=?",
                         (*[cols[k] for k in keys], PRODUCT, sub, pod, profile, owner)).rowcount
    return n == 1


def _lease(sub: str, pod: str, profile: str, owner: str, seconds: float) -> bool:
    t = now()
    with _conn() as conn:
        conn.execute("INSERT INTO connector_tokens (product, sub, pod, profile, status, created_at) VALUES (?,?,?,?,'idle',?) "
                     "ON CONFLICT (product, sub, pod, profile) DO NOTHING", (PRODUCT, sub, pod, profile, _iso(_now())))
        n = conn.execute("UPDATE connector_tokens SET lease_until=?, lease_owner=?, status='pending', reason='', detail='' "
                         "WHERE product=? AND sub=? AND pod=? AND profile=? AND (status<>'pending' OR lease_until<?)",
                         (t + seconds, owner, PRODUCT, sub, pod, profile, t)).rowcount
    return n == 1


def _queue_delete(conn, sub: str, pod: str, profile: str, tid: str, workspace: str) -> None:
    if tid:
        conn.execute("INSERT INTO connector_jobs (product, sub, pod, profile, kind, tid, workspace, attempts, created_at) VALUES (?,?,?,?,'delete',?,?,0,?) "
                     "ON CONFLICT (product, sub, tid) DO NOTHING", (PRODUCT, sub, pod, profile, tid, workspace, _iso(_now())))


def forget(pod: str, profile: str, opt_out: bool = False) -> int:
    """MindWiki MCP 서버나 프로파일을 지웠다. AAS 가 만든 토큰(지금·예전 둘 다)을 지울 일로 옮긴다. 옮긴 수.
    opt_out(사람이 MCP 서버를 지움): 행을 opted_out 으로 남겨 자동 첫 연결이 다시 하지 않게 한다(스펙 2026-11-14-012 A3).
    프로파일을 지울 때는 행을 지운다. 사용자가 붙여 넣은 토큰(1단계)은 행이 없으므로 건드리지 않는다."""
    with _conn() as conn:
        rows = conn.execute("SELECT sub, tid, workspace, prev_tid, prev_workspace FROM connector_tokens WHERE product=? AND pod=? AND profile=?",
                            (PRODUCT, pod, profile)).fetchall()
        for r in rows:
            _queue_delete(conn, r["sub"], pod, profile, r["tid"], r["workspace"])
            _queue_delete(conn, r["sub"], pod, profile, r["prev_tid"], r["prev_workspace"] or r["workspace"])
        if opt_out:
            conn.execute("UPDATE connector_tokens SET status='opted_out', reason='', detail='', tid='', prev_tid='', prev_expires_at='', prev_workspace='', "
                         "auto_reason='', lease_until=0 WHERE product=? AND pod=? AND profile=?", (PRODUCT, pod, profile))
        else:
            conn.execute("DELETE FROM connector_tokens WHERE product=? AND pod=? AND profile=?", (PRODUCT, pod, profile))
    return sum((1 if r["tid"] else 0) + (1 if r["prev_tid"] else 0) for r in rows)


# ---- 상태(화면) ----------------------------------------------------------------------------------------------------

def state(sub: str, pod: str, profile: str, at: datetime | None = None) -> dict:
    """카탈로그의 MindWiki 항목에 붙일 연결 상태. 겹치면 expired > failed > soon > pending > connected(스펙 4절 화면 상태)."""
    out: dict = {"enabled": enabled(), "status": "none", "write_days": WRITE_DAYS, "days": token_days(False)}
    r = _row(sub, pod, profile) if sub else None
    if not r:
        return out
    at = at or _now()
    status, reason = r["status"], r["reason"]
    if status == "pending" and float(r["lease_until"] or 0) < now():
        status, reason = "failed", "internal"                     # 작업 중 프로세스가 죽었다
    expires = _parse(r["expires_at"])
    if r["tid"] and expires and expires <= at:
        status, reason = "expired", "expired"
    elif status == "connected" and expires and expires - at <= timedelta(days=SOON_DAYS):
        status = "soon"
    try:
        detail = json.loads(r["detail"]) if r["detail"] else None
    except ValueError:
        detail = None
    nca = float(r["next_check_at"] or 0)
    out.update({"status": status, "reason": reason, "detail": detail, "write": bool(r["write"]), "expires_at": r["expires_at"],
                "tool_count": int(r["tool_count"] or 0), "workspace": r["workspace"], "last_checked": r["last_checked"],
                "connected": bool(r["tid"]),
                # 3단계(스펙 2026-11-14-012 3-4): 화면이 순위를 고른다
                "needs_apply": int(r["apply_gen"] or 0) > int(r["applied_gen"] or 0), "prev_expires_at": r["prev_expires_at"] or "",
                "auto_reason": r["auto_reason"] or "", "next_check_at": _iso(datetime.fromtimestamp(nca, timezone.utc)) if nca else "",
                "auto_connected": r["notified_at"] == "auto"})
    return out


def ack(sub: str, pod: str, profile: str) -> dict:
    """자동 첫 연결 안내의 「그대로 두기」(3-4). 안내를 닫는다."""
    with _conn() as conn:
        conn.execute("UPDATE connector_tokens SET notified_at='' WHERE product=? AND sub=? AND pod=? AND profile=? AND notified_at='auto'",
                     (PRODUCT, sub, pod, profile))
    return {"ok": True}


def _parse(value: str) -> datetime | None:
    try:
        dt = datetime.fromisoformat(value)
    except (TypeError, ValueError):
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


# ---- MindWiki 호출 ---------------------------------------------------------------------------------------------------

def _call(method: str, path: str, token: str, workspace: str = "", body: dict | None = None):
    url = mcp_servers.mindwiki_url() + path
    headers = {"Authorization": f"Bearer {token}", "Accept": "application/json"}
    data = None
    if body is not None:
        data, headers["Content-Type"] = json.dumps(body).encode(), "application/json"
    if workspace:
        headers["X-Workspace"] = workspace
    req = urllib.request.Request(url, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=timeout_s(), context=mcp_servers._probe_context()) as resp:
            raw = resp.read()
    except urllib.error.HTTPError as exc:
        try:
            err = json.loads(exc.read() or b"{}")
        except ValueError:
            err = {}
        raise MindwikiHTTPError(exc.code, str(err.get("code") or ""), str(err.get("error") or "")[:200]) from None
    except (ssl.SSLError, ssl.CertificateError) as exc:
        raise MindwikiTLSError(type(exc).__name__) from None
    except urllib.error.URLError as exc:
        if isinstance(exc.reason, (ssl.SSLError, ssl.CertificateError)):
            raise MindwikiTLSError(type(exc.reason).__name__) from None
        if isinstance(exc.reason, TimeoutError):
            raise MindwikiTimeout() from None
        raise MindwikiHTTPError(502, "unreachable") from None
    except TimeoutError:
        raise MindwikiTimeout() from None
    return json.loads(raw) if raw else {}


def _http_reason(exc: MindwikiHTTPError, step: str) -> str:
    if exc.status == 401:
        return "iss_or_client_rejected"
    if exc.status == 403:
        if exc.code == "connector_scope":
            return "connector_scope"
        if "disabled" in exc.message:
            return "account_disabled"
        if "guest" in exc.message:
            return "guest"
        return "no_workspace" if "member" in exc.message else "connector_scope"
    if exc.status == 409 and step == "create":
        return "token_limit"
    if exc.status == 429:
        return "daily_limit" if exc.code == "connector_daily_limit" else "mindwiki_5xx"
    if exc.status == 400 and exc.code == "connector_token_rejected":
        # 같은 코드로 두 가지를 거절한다(MindWiki tokens.go). 쓰기를 막은 설치는 읽기로는 되므로 따로 알린다
        return "write_disabled" if "write tokens" in exc.message else "token_request_rejected"
    return "mindwiki_5xx"


def _pick_workspace(me: dict, wanted: str, previous: str = "") -> str:
    """고른 것 > 설치 값 > 지금 연결된 워크스페이스(다시 연결, 아직 그 워크스페이스에 있을 때) > 하나뿐인 것 순서다."""
    wss = [w for w in me.get("workspaces") or [] if isinstance(w, dict) and w.get("id")]
    fixed = wanted or config.get("AAS_MINDWIKI_WORKSPACE", "").strip()
    if not fixed and previous and any(str(w["id"]) == previous for w in wss):
        return previous
    if fixed:
        hit = next((w for w in wss if fixed in (str(w["id"]), str(w.get("slug") or ""))), None)
        if hit is None:
            raise Failed("no_workspace")
        return str(hit["id"])
    if not wss:
        raise Failed("no_workspace")
    if len(wss) > 1:
        raise Failed("need_workspace", [{"id": str(w["id"]), "name": str(w.get("name") or ""), "slug": str(w.get("slug") or "")} for w in wss])
    return str(wss[0]["id"])


def _drain_deletes(token: str, sub: str, limit: int | None = None) -> None:
    """그 사람의 지울 일을 한다. 404 는 이미 지워진 것. 실패는 횟수를 올리고 다섯 번이면 버린다(만료에 맡김).
    limit: 자동 점검은 한 번에 MAX_DRAIN 건만(임대 시간을 넘지 않게, 스펙 2026-11-14-012 A11)."""
    with _conn() as conn:
        jobs = [dict(r) for r in conn.execute("SELECT * FROM connector_jobs WHERE product=? AND sub=? ORDER BY created_at", (PRODUCT, sub)).fetchall()]
    if limit is not None:
        jobs = jobs[:limit]
    for job in jobs:
        try:
            _call("DELETE", f"/api/tokens/{job['tid']}", token, job["workspace"])
            done = True
        except MindwikiHTTPError as exc:
            done = exc.status == 404
        except (MindwikiTimeout, MindwikiTLSError):
            done = False
        with _conn() as conn:
            if done or job["attempts"] + 1 >= DELETE_ATTEMPTS:
                conn.execute("DELETE FROM connector_jobs WHERE product=? AND sub=? AND tid=?", (PRODUCT, sub, job["tid"]))
            else:
                conn.execute("UPDATE connector_jobs SET attempts=attempts+1 WHERE product=? AND sub=? AND tid=?", (PRODUCT, sub, job["tid"]))


def _delete_or_queue(token: str, sub: str, pod: str, profile: str, tid: str, workspace: str) -> None:
    try:
        _call("DELETE", f"/api/tokens/{tid}", token, workspace)
        return
    except MindwikiHTTPError as exc:
        if exc.status == 404:
            return
    except (MindwikiTimeout, MindwikiTLSError):
        pass
    with _conn() as conn:
        _queue_delete(conn, sub, pod, profile, tid, workspace)


def _aas_tokens(token: str, workspace: str) -> list[dict]:
    try:
        res = _call("GET", "/api/tokens", token, workspace)
    except (MindwikiHTTPError, MindwikiTimeout, MindwikiTLSError):
        return []
    return [{"id": str(t.get("id") or ""), "name": str(t.get("name") or ""), "expiresAt": t.get("expiresAt")}
            for t in res.get("tokens") or [] if isinstance(t, dict)]


# ---- 시작과 뒤 작업 ----------------------------------------------------------------------------------------------------

def start(*, sub: str, pod: str, profile: str, write: bool, workspace: str, cookie: str, access_token: Callable[[str], tuple[str, str]],
          attach: Callable[[str, bool], dict], log: Callable[[str], None]) -> dict:
    """임대를 잡고 뒤 작업을 띄운다. 이미 진행 중이면 409 lease_busy.
    access_token(cookie) → (토큰, 이유), attach(wiki_pat, write) → Hermes 에 붙인 결과(FileError·HermesError 를 올린다)."""
    if not enabled():
        raise FileError("MindWiki 계정으로 연결이 꺼져 있습니다", 400, reason="catalog_hidden")   # i18n-ignore: 화면은 버튼을 숨긴다
    if not sub:
        raise FileError("로그인한 사람만 연결할 수 있습니다", 403, reason="forbidden")   # i18n-ignore: 로그인 없는 시험 환경
    job = secrets.token_hex(8)
    if not _lease(sub, pod, profile, job, 3 * timeout_s() + 60):
        raise FileError("이미 연결하는 중입니다", 409, reason="lease_busy")   # i18n-ignore: 화면은 reason 으로 문구를 고른다
    threading.Thread(target=_run, name=f"mindwiki-connect-{job}", daemon=True,
                     kwargs={"job": job, "sub": sub, "pod": pod, "profile": profile, "write": bool(write), "workspace": workspace,
                             "cookie": cookie, "access_token": access_token, "attach": attach, "log": log}).start()
    return {"ok": True, "job": job, "status": "pending"}


def _run(*, job: str, sub: str, pod: str, profile: str, write: bool, workspace: str, cookie: str,
         access_token: Callable[[str], tuple[str, str]], attach: Callable[[str, bool], dict], log: Callable[[str], None]) -> None:
    with WORKERS:
        reason, detail, step = "", None, "token"
        try:
            token, why = access_token(cookie)
            cookie = ""                                                    # 쿠키 원문은 여기서 버린다
            if why:
                raise Failed(why)
            step = "me"
            old = _row(sub, pod, profile) or {}
            ws = _pick_workspace(_call("GET", "/api/me", token), workspace, str(old.get("workspace") or "") if old.get("tid") else "")
            _drain_deletes(token, sub)
            started = _now()
            step = "create"
            body = token_body(profile, write)
            try:
                made = _call("POST", "/api/tokens", token, ws, body)
            except MindwikiTimeout:
                _cleanup_after_timeout(token, sub, pod, profile, ws, body["name"], old)
                raise
            except MindwikiHTTPError as exc:
                if exc.status == 409:
                    raise Failed("token_limit", [t["name"] for t in _aas_tokens(token, ws)]) from None
                raise
            text = str(made.get("text") or "")
            tid = str((made.get("token") or {}).get("id") or "")
            expires = str((made.get("token") or {}).get("expiresAt") or "")
            if not text.startswith(mcp_servers.MINDWIKI_PAT) or not tid:
                raise MindwikiHTTPError(502, "bad_response")
            _update(sub, pod, profile, job, lease_until=now() + 3 * timeout_s() + 60)
            with _conn() as conn:                                          # ① 붙이기 전에 지울 일로 — 도중에 죽어도 버려진 토큰이 남지 않는다(3단계 3-2 의 5)
                _queue_delete(conn, sub, pod, profile, tid, ws)
            step = "attach"
            try:
                attach(text, write)
            except (FileError, HermesError) as exc:
                _delete_or_queue(token, sub, pod, profile, tid, ws)      # 붙이지 못한 토큰은 남기지 않는다. 예전 토큰은 그대로 둔다
                raise Failed("hermes_not_ready" if isinstance(exc, HermesError) and getattr(exc, "code", 0) in (0, 502, 503) else "hermes_reload") from None
            finally:
                text = ""
            # 예전 토큰은 바로 지우지 않고 prev_tid 로 옮긴다 — 게이트웨이가 「지금 적용」 전까지 그 키를 쓴다(3단계 A13)
            _commit_new(sub, pod, profile, job, tid=tid, ws=ws, write=write, name=body["name"],
                        expires_at=_iso(_parse(expires) or started + timedelta(days=body["days"])), old=old, notified="")
            log(f"mindwiki connect ok profile={profile} job={job} write={int(write)}")
            return
        except Failed as exc:
            reason, detail = exc.reason, exc.detail
        except MindwikiHTTPError as exc:
            reason = _http_reason(exc, step)
            log(f"mindwiki connect failed code={reason} step={step} mindwiki_status={exc.status} mindwiki_error={exc.code} url={mcp_servers.mindwiki_url()}/api profile={profile} job={job}")
        except MindwikiTimeout:
            reason = "timeout"
        except MindwikiTLSError:
            reason = "tls"
        except Exception:                                                   # 뒤 작업의 가장 바깥: 트레이스백과 작업 id 를 남긴다
            reason = "internal"
            print(f"mindwiki connect internal job={job}\n{traceback.format_exc()}", flush=True)   # i18n-ignore: 서버 로그
        if reason not in REASONS:
            reason = "internal"
        _update(sub, pod, profile, job, status="failed", reason=reason, detail=json.dumps(detail, ensure_ascii=False) if detail else "", lease_until=0)
        if reason not in ("need_workspace",):
            log(f"mindwiki connect failed code={reason} step={step} profile={profile} job={job} doc=OPERATIONS.md#mindwiki-{reason}")


def _cleanup_after_timeout(token: str, sub: str, pod: str, profile: str, ws: str, name: str, old: dict) -> None:
    """발급 요청이 시간 초과: 결과를 모른다. 같은 이름의 토큰 가운데 지금·예전 토큰과 이미 지울 일에 있는 것을 빼고 지운다.
    token_name 이 프로파일마다 같은 이름을 주므로 이름만 보면 살아 있는 prev_tid 까지 지운다(스펙 2026-11-14-012 A13·H1)."""
    keep = {str(old.get("tid") or ""), str(old.get("prev_tid") or "")} - {""}
    with _conn() as conn:
        keep |= {r["tid"] for r in conn.execute("SELECT tid FROM connector_jobs WHERE product=? AND sub=?", (PRODUCT, sub)).fetchall()}
    for t in _aas_tokens(token, ws):
        if t["name"] == name and t["id"] not in keep:
            _delete_or_queue(token, sub, pod, profile, t["id"], ws)


def _commit_new(sub: str, pod: str, profile: str, owner: str, *, tid: str, ws: str, write: bool, name: str, expires_at: str, old: dict,
                notified: str | None = None) -> bool:
    """새 토큰을 행에 확정한다(③). 임대 주인이 아니면 아무것도 하지 않는다(False, 먼저 넣어 둔 지울 일이 새 토큰을 치운다).
    같은 워크스페이스의 지금 토큰은 prev_tid 로 옮기고, 있던 prev_tid 와 다른 워크스페이스의 예전 토큰은 지울 일로 보낸다.
    새 tid 의 지울 일은 같은 트랜잭션에서 뺀다."""
    old_tid, old_ws = str(old.get("tid") or ""), str(old.get("workspace") or ws)
    old_prev, old_prev_ws = str(old.get("prev_tid") or ""), str(old.get("prev_workspace") or old_ws)
    keep_prev = bool(old_tid) and old_tid != tid and old_ws == ws
    cols = {"tid": tid, "workspace": ws, "write": 1 if write else 0, "name": name, "expires_at": expires_at, "status": "connected", "reason": "",
            "detail": "", "tool_count": len(mcp_servers._mindwiki_tools(write)), "lease_until": 0, "last_checked": _iso(_now()),
            "prev_tid": old_tid if keep_prev else "", "prev_expires_at": str(old.get("expires_at") or "") if keep_prev else "",
            "prev_workspace": old_ws if keep_prev else "", "auto_reason": "", "auto_streak": 0, "next_check_at": now() + CHECK_EVERY}
    if notified is not None:
        cols["notified_at"] = notified
    keys = list(cols)
    with _conn() as conn:
        n = conn.execute(f"UPDATE connector_tokens SET {', '.join(k + '=?' for k in keys)}, apply_gen=apply_gen+1 "
                         "WHERE product=? AND sub=? AND pod=? AND profile=? AND lease_owner=?",
                         (*[cols[k] for k in keys], PRODUCT, sub, pod, profile, owner)).rowcount
        if n != 1:
            return False
        conn.execute("DELETE FROM connector_jobs WHERE product=? AND sub=? AND tid=?", (PRODUCT, sub, tid))
        if old_prev and old_prev != tid:
            _queue_delete(conn, sub, pod, profile, old_prev, old_prev_ws)
        if old_tid and old_tid != tid and not keep_prev:
            _queue_delete(conn, sub, pod, profile, old_tid, old_ws)
    return True


def attach_with(api: HermesAPI, prof: str | None, *, owner: bool, profs: list[str | None], pod: str, by: str, profile: str,
                after_install: Callable[[], None]) -> Callable[[str, bool], dict]:
    """뒤 작업이 부를 「Hermes 에 붙이기」. 처음 설치면 사용 규칙 스킬도 함께 설치한다(1단계와 같다)."""
    def attach(key: str, write: bool) -> dict:
        out = mcp_servers.connect_mindwiki(api, prof, key, write, owner=owner, profs=profs, pod=pod, by=by, profile=profile)
        if out.get("skill_package"):
            after_install()
        return out
    return attach


# ---- 3단계: 로그인·갱신 때 자동 점검(스펙 2026-11-14-012) --------------------------------------------------------------
#
#   on_login(sub, email, access_token) ─ 곧바로 돌아간다
#     └ 뒤 작업(세마포어 non-blocking, exp ≥ 30초)
#         └ 행마다 _auto_one: 임대(status 안 덮음) → 지울 일 ≤5 → [첫 연결 | 회수 판정 → 재발급] → prev 정리 → 결과(주인 확인)
#
# 서버가 등록하는 Host: attach_for(sub, email, pod, profile) → {"attach": fn(key, write), "detach": fn()} 또는 None(주인 아님·프로파일 없음),
#                      primary_for(sub, email) → [(pod, profile)](자동 첫 연결 대상).

_HOST = None


def register_host(host) -> None:
    global _HOST
    _HOST = host


def _token_exp(token: str) -> float:
    """액세스 토큰(JWT)의 exp. 서명은 보지 않는다 — 남은 시간을 재는 데만 쓴다. 읽지 못하면 0(모름)."""
    try:
        part = token.split(".")[1]
        return float(json.loads(base64.urlsafe_b64decode(part + "=" * (-len(part) % 4))).get("exp") or 0)
    except (IndexError, ValueError, TypeError):
        return 0.0


def on_login(sub: str, email: str, access_token: str) -> int:
    """로그인 콜백·갱신 성공 뒤 Auth 가 부른다. 점검할 행이 있으면 뒤 작업을 띄우고 그 수를 돌려준다(로그인을 늦추지 않는다)."""
    if not (sub and access_token and _HOST is not None and auto_check_enabled()):
        return 0
    t = now()
    with _conn() as conn:
        due = [(r["pod"], r["profile"], False) for r in conn.execute(
            "SELECT pod, profile FROM connector_tokens WHERE product=? AND sub=? AND tid<>'' AND status NOT IN ('revoked','opted_out','pending') "
            "AND next_check_at<=?", (PRODUCT, sub, t)).fetchall()]
        if auto_connect_enabled():                                         # 자동 첫 연결이 실패해 남은 빈 행(idle)도 다음 시각에 다시
            due += [(r["pod"], r["profile"], True) for r in conn.execute(
                "SELECT pod, profile FROM connector_tokens WHERE product=? AND sub=? AND tid='' AND status='idle' AND next_check_at<=?",
                (PRODUCT, sub, t)).fetchall()]
            known = {(r["pod"], r["profile"]) for r in conn.execute(
                "SELECT pod, profile FROM connector_tokens WHERE product=? AND sub=?", (PRODUCT, sub)).fetchall()}
            try:
                targets = list(_HOST.primary_for(sub, email))
            except Exception:                                              # 호스트 오류는 로그인을 막지 않는다. 다음 갱신에 다시
                print(f"mindwiki auto primary_for failed sub={sub[:8]}\n{traceback.format_exc()}", flush=True)   # i18n-ignore: 서버 로그
                targets = []
            due += [(pod, profile, True) for pod, profile in targets if (pod, profile) not in known]
    if not due:
        return 0
    threading.Thread(target=_auto, name=f"mindwiki-auto-{sub[:8]}", daemon=True,
                     kwargs={"sub": sub, "email": email, "token": access_token, "rows": due}).start()
    return len(due)


def _auto(*, sub: str, email: str, token: str, rows: list) -> None:
    if not WORKERS.acquire(blocking=False):                                # 사람 작업이 자동 점검 뒤에 줄 서지 않게. 다음 갱신에 다시
        return
    try:
        exp = _token_exp(token)
        for pod, profile, first in rows:
            if exp and exp - now() < MIN_TOKEN_LEFT:                       # 줄 서는 동안 만료가 가까워졌다 — 401 대신 다음으로 미룬다
                return
            _auto_one(sub=sub, email=email, token=token, pod=pod, profile=profile, first=first)
    finally:
        WORKERS.release()


def _auto_lease(sub: str, pod: str, profile: str, owner: str, first: bool) -> bool:
    """자동 점검 임대. status·reason 은 덮지 않는다(연결된 행이 「연결 중」·「실패」로 보이지 않게). 사람 작업(pending)이 있으면 못 잡는다."""
    t = now()
    with _conn() as conn:
        if first:
            conn.execute("INSERT INTO connector_tokens (product, sub, pod, profile, status, created_at) VALUES (?,?,?,?,'idle',?) "
                         "ON CONFLICT (product, sub, pod, profile) DO NOTHING", (PRODUCT, sub, pod, profile, _iso(_now())))
        # next_check_at<=? 도 다시 본다: 서버 두 대가 같은 행을 거의 동시에 고르면, 먼저 끝난 쪽이 임대를 푼 뒤 다른 쪽이 한 번 더 점검했다(OKE #604)
        n = conn.execute("UPDATE connector_tokens SET lease_until=?, lease_owner=? WHERE product=? AND sub=? AND pod=? AND profile=? "
                         "AND status NOT IN ('pending','revoked','opted_out') AND lease_until<? AND next_check_at<=?",
                         (t + AUTO_LEASE, owner, PRODUCT, sub, pod, profile, t, t)).rowcount
    return n == 1


def _list_strict(token: str, ws: str) -> set[str]:
    """회수 판정용 목록. 오류는 그대로 올린다 — _aas_tokens 는 오류를 [] 로 삼켜 거짓 회수가 난다(A6).
    200 이고 tokens 배열이 있을 때만 집합을 돌려준다(연결 client 목록은 쪽 나눔이 없다)."""
    res = _call("GET", "/api/tokens", token, ws)
    toks = res.get("tokens") if isinstance(res, dict) else None
    if not isinstance(toks, list):
        raise MindwikiHTTPError(502, "bad_response")
    return {str(t.get("id") or "") for t in toks if isinstance(t, dict)}


def _auto_reason(exc: Exception) -> str:
    if isinstance(exc, Failed):
        return exc.reason if exc.reason in REASONS else "internal_error"
    if isinstance(exc, MindwikiTimeout):
        return "timeout"
    if isinstance(exc, MindwikiTLSError):
        return "tls"
    if isinstance(exc, MindwikiHTTPError):
        if exc.status == 401:
            return "idp_token_rejected"                                    # 자동 점검의 401 은 액세스 토큰 문제일 수 있다(일시적)
        if exc.status == 429:
            return "daily_limit" if exc.code == "connector_daily_limit" else "mindwiki_5xx"
        if exc.status == 403:
            return _http_reason(exc, "me")
        return "mindwiki_5xx" if exc.status >= 500 else _http_reason(exc, "create")
    return "internal_error"


def _auto_one(*, sub: str, email: str, token: str, pod: str, profile: str, first: bool) -> None:
    owner = "auto-" + secrets.token_hex(6)
    if not _auto_lease(sub, pod, profile, owner, first):
        return
    result, http, corr = "ok", "", ""
    try:
        host = _HOST.attach_for(sub, email, pod, profile)
        if host is None:                                                   # 주인이 바뀌었거나 프로파일이 없다 — 예전 주인의 토큰을 다시 받지 않는다
            result = "skipped_owner"
            return
        row = _row(sub, pod, profile) or {}
        if first and not row.get("tid"):
            result = _auto_first(sub, pod, profile, owner, token, host, row)
        else:
            result = _auto_check(sub, pod, profile, owner, token, host, row)
        # 지울 일은 점검 뒤에 한다: 점검이 넣은 예전 토큰(정리·회수)까지 이번에 지운다. 앞에서 하면 12시간 뒤 다음 로그인까지 남았다(OKE 2026-11-15)
        _drain_deletes(token, sub, limit=MAX_DRAIN)
    except (Failed, MindwikiHTTPError, MindwikiTimeout, MindwikiTLSError) as exc:
        result = _auto_reason(exc)
        http = str(getattr(exc, "status", "") or "")
    except Exception:                                                      # 예상하지 못한 오류: 삼키지 않고 상관 id 로 남긴다(3-2 의 6)
        result, corr = "internal_error", secrets.token_hex(4)
        print(f"mindwiki auto internal corr={corr} sub={sub[:8]} profile={profile}\n{traceback.format_exc()}", flush=True)   # i18n-ignore: 서버 로그
    finally:
        _auto_finish(sub, pod, profile, owner, result, corr)
        print(f"mindwiki auto check sub={sub[:8]} profile={profile} result={result} http={http} next_check_at="   # i18n-ignore: 서버 로그
              f"{_iso(datetime.fromtimestamp(_next_check(result, sub, pod, profile), timezone.utc))}", flush=True)


def _next_check(result: str, sub: str, pod: str, profile: str) -> float:
    if result in ("ok", "reissued", "connected", "revoked", "skipped_owner") or result not in TRANSIENT:
        return now() + CHECK_EVERY
    if result == "idp_token_rejected":
        r = _row(sub, pod, profile) or {}
        if int(r.get("auto_streak") or 0) + 1 >= IDP_STREAK:              # 계속되는 401 은 설정 문제일 수 있다 — 매시간 부르지 않는다
            return now() + CHECK_EVERY
    return now() + RETRY_AFTER


def _auto_finish(sub: str, pod: str, profile: str, owner: str, result: str, corr: str) -> None:
    """결과를 적고 임대를 푼다. 주인이 아니면(사람 작업이 가져감) 아무것도 쓰지 않는다."""
    nxt = _next_check(result, sub, pod, profile)
    ok = result in ("ok", "reissued", "connected", "revoked", "skipped_owner")
    reason = "" if ok else (f"internal_error:{corr}" if result == "internal_error" and corr else result)
    with _conn() as conn:
        conn.execute("UPDATE connector_tokens SET next_check_at=?, last_checked=?, auto_reason=?, "
                     "auto_streak=CASE WHEN ?='idp_token_rejected' THEN auto_streak+1 ELSE 0 END, lease_until=0, lease_owner='' "
                     "WHERE product=? AND sub=? AND pod=? AND profile=? AND lease_owner=?",
                     (nxt, _iso(_now()), reason, result, PRODUCT, sub, pod, profile, owner))


def _issue(token: str, sub: str, pod: str, profile: str, owner: str, ws: str, write: bool, old: dict, host: dict, notified: str | None) -> str:
    """새 토큰을 받아 ① 지울 일 ② 붙이기 ③ 확정 순으로 바꾼다(3-2 의 5). 확정하면 tid, 주인이 아니면 ''."""
    name, days = token_name(profile), token_days(write)
    started = _now()
    try:
        made = _call("POST", "/api/tokens", token, ws, token_body(profile, write))
    except MindwikiTimeout:
        _cleanup_after_timeout(token, sub, pod, profile, ws, name, old)
        raise
    text = str(made.get("text") or "")
    tid = str((made.get("token") or {}).get("id") or "")
    expires = str((made.get("token") or {}).get("expiresAt") or "")
    if not text.startswith(mcp_servers.MINDWIKI_PAT) or not tid:
        raise MindwikiHTTPError(502, "bad_response")
    with _conn() as conn:                                                  # ①
        _queue_delete(conn, sub, pod, profile, tid, ws)
    try:
        host["attach"](text, write)                                        # ②
    except (FileError, HermesError) as exc:
        raise Failed("hermes_not_ready" if isinstance(exc, HermesError) and getattr(exc, "code", 0) in (0, 502, 503) else "hermes_reload") from None
    finally:
        text = ""
    ok = _commit_new(sub, pod, profile, owner, tid=tid, ws=ws, write=write, name=name,     # ③
                     expires_at=_iso(_parse(expires) or started + timedelta(days=days)), old=old, notified=notified)
    return tid if ok else ""


def _auto_first(sub: str, pod: str, profile: str, owner: str, token: str, host: dict, row: dict) -> str:
    """주 프로파일 자동 첫 연결(A1·A2): 쓰기 허용(사용자 결정 2026-11-15, 처음에는 읽기 전용), 워크스페이스가 정해질 때만.
    연결되면 행에 안내 표시(notified_at='auto'). MindWiki 가 연결 client 의 쓰기 토큰을 막았으면(write_disabled) 읽기로 연결한다."""
    # 여럿이면 need_workspace → 건너뜀(화면은 2단계 고르기 안내). 자동화 전용 프로파일은 웹훅이 적어 둔 워크스페이스로(want_auto)
    from .mindwiki_webhook import AUTO_PROFILES
    auto = profile in AUTO_PROFILES
    ws = _pick_workspace(_call("GET", "/api/me", token), str(row.get("workspace") or "") if auto else "", "")
    try:
        tid = _issue(token, sub, pod, profile, owner, ws, True, row, host, "auto")
    except MindwikiHTTPError as exc:
        if _http_reason(exc, "create") != "write_disabled" or auto:      # 자동화 전용 프로파일에 읽기 토큰은 쓸모가 없다 — 실패로 둔다
            raise
        tid = _issue(token, sub, pod, profile, owner, ws, False, row, host, "auto")   # 발급 요청이 거절됐을 뿐 아무것도 바뀌지 않았다
    return "connected" if tid else "lost_lease"


def _auto_check(sub: str, pod: str, profile: str, owner: str, token: str, host: dict, row: dict) -> str:
    """연결된 행: 회수 판정 → 예전 토큰 정리 → 기한 전 재발급."""
    ws, tid = str(row.get("workspace") or ""), str(row.get("tid") or "")
    alive = _list_strict(token, ws)                                        # 행의 워크스페이스로(X-Workspace) — 다른 워크스페이스 목록으로 판정하지 않는다
    if tid not in alive:                                                   # MindWiki 설정에서 지웠다
        try:
            host["detach"]()
        except (FileError, HermesError):
            pass                                                           # 키를 못 걷어도 토큰은 이미 무효다. 상태는 바꾼다
        with _conn() as conn:
            n = conn.execute("UPDATE connector_tokens SET status='revoked', tid='', apply_gen=apply_gen+1 "
                             "WHERE product=? AND sub=? AND pod=? AND profile=? AND lease_owner=?", (PRODUCT, sub, pod, profile, owner)).rowcount
            if n == 1:
                _queue_delete(conn, sub, pod, profile, str(row.get("prev_tid") or ""), str(row.get("prev_workspace") or ws))
                conn.execute("UPDATE connector_tokens SET prev_tid='', prev_expires_at='', prev_workspace='' "
                             "WHERE product=? AND sub=? AND pod=? AND profile=?", (PRODUCT, sub, pod, profile))
        return "revoked"
    _prune_prev(sub, pod, profile, row)
    refresh = host.get("refresh")
    if refresh is not None:                                                # 예전 판이 적은 도구 목록에 새 도구 채우기(스펙 2026-11-15-002)
        try:
            changed = refresh()
        except (FileError, HermesError):
            changed = False                                                # 다음 점검에 다시. 토큰 점검 결과는 그대로 둔다
        if changed:                                                        # 떠 있는 게이트웨이는 새 목록을 읽지 않는다 — 「지금 적용」을 띄운다(OKE 2026-11-15)
            with _conn() as conn:
                conn.execute("UPDATE connector_tokens SET apply_gen=apply_gen+1 WHERE product=? AND sub=? AND pod=? AND profile=? AND lease_owner=?",
                             (PRODUCT, sub, pod, profile, owner))
    expires = _parse(row.get("expires_at") or "")
    write = bool(row.get("write"))
    edge = timedelta(days=REISSUE_WRITE_DAYS if write else REISSUE_DAYS)
    if expires and expires - _now() <= edge:
        return "reissued" if _issue(token, sub, pod, profile, owner, ws, write, row, host, None) else "lost_lease"
    return "ok"


def _prune_prev(sub: str, pod: str, profile: str, row: dict) -> None:
    """「지금 적용」 뒤(APPLY_GRACE 지남) 또는 기한이 지난 예전 토큰을 지울 일로 보내고 칸을 비운다(A8)."""
    prev = str(row.get("prev_tid") or "")
    if not prev:
        return
    applied = int(row.get("applied_gen") or 0) >= int(row.get("apply_gen") or 0) and now() - float(row.get("applied_at") or 0) >= APPLY_GRACE
    pexp = _parse(row.get("prev_expires_at") or "")
    if not (applied or (pexp and pexp <= _now())):
        return
    with _conn() as conn:
        _queue_delete(conn, sub, pod, profile, prev, str(row.get("prev_workspace") or row.get("workspace") or ""))
        conn.execute("UPDATE connector_tokens SET prev_tid='', prev_expires_at='', prev_workspace='' WHERE product=? AND sub=? AND pod=? AND profile=? AND prev_tid=?",
                     (PRODUCT, sub, pod, profile, prev))


# ---- 「지금 적용」(게이트웨이 다시 시작)과 세대 번호(A9) ------------------------------------------------------------------

def apply_snapshot(pod: str, profiles: list[str] | None) -> dict:
    """다시 시작을 시작할 때의 apply_gen. profiles 가 None 이면 그 파드 전체(쿠버네티스의 공유 게이트웨이)."""
    with _conn() as conn:
        if profiles is None:
            rows = conn.execute("SELECT sub, profile, apply_gen FROM connector_tokens WHERE product=? AND pod=?", (PRODUCT, pod)).fetchall()
        else:
            marks = ",".join("?" * len(profiles)) or "''"
            rows = conn.execute(f"SELECT sub, profile, apply_gen FROM connector_tokens WHERE product=? AND pod=? AND profile IN ({marks})",
                                (PRODUCT, pod, *profiles)).fetchall()
    return {"pod": pod, "rows": [(r["sub"], r["profile"], int(r["apply_gen"] or 0)) for r in rows]}


def pending_apply(pod: str) -> list[dict]:
    """키를 다시 받았지만 게이트웨이가 아직 읽지 않은 프로파일(apply_gen > applied_gen) — 다시 시작 장부가 합쳐 보인다(스펙 2026-11-18-016 4-2).
    at 은 마지막 점검 시각(없으면 만든 시각), 모르면 0."""
    with _conn() as conn:
        rows = conn.execute("SELECT profile, last_checked, created_at FROM connector_tokens WHERE product=? AND pod=? AND apply_gen>applied_gen",
                            (PRODUCT, pod)).fetchall()
    out: dict[str, float] = {}
    for r in rows:
        dt = _parse(r["last_checked"] or "") or _parse(r["created_at"] or "")
        out[r["profile"]] = max(out.get(r["profile"], 0.0), dt.timestamp() if dt else 0.0)
    return [{"profile": p, "at": at} for p, at in sorted(out.items())]


def mark_applied(snap: dict) -> int:
    """다시 시작이 성공했다. 시작 때의 세대까지 적용됨으로 적는다 — 그 사이 키가 또 바뀌었으면 표시가 남는다. 다음 점검이 예전 토큰을 지우도록 당긴다."""
    t, n = now(), 0
    with _conn() as conn:
        for sub, profile, gen in snap.get("rows") or []:
            n += conn.execute("UPDATE connector_tokens SET applied_gen=CASE WHEN applied_gen<? THEN ? ELSE applied_gen END, applied_at=?, "
                              "next_check_at=CASE WHEN prev_tid<>'' AND next_check_at>? THEN ? ELSE next_check_at END "
                              "WHERE product=? AND sub=? AND pod=? AND profile=?",
                              (gen, gen, t, t + APPLY_GRACE, t + APPLY_GRACE, PRODUCT, sub, snap["pod"], profile)).rowcount
    return n


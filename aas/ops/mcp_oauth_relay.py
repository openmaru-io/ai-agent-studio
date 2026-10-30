# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""MCP 서버 OAuth 로그인 중개(스펙 2026-10-16-010 4-1~4-4, OMAI-1263).

인가 서버는 AAS 의 https 콜백(<AAS_PUBLIC_URL>/oauth/mcp/callback, Q1)으로 돌아온다. AAS 는 state 기록으로 어느 파드·프로파일·서버의
흐름인지 찾고, 시작한 사용자와 지금 로그인한 사용자가 같은지 본 뒤, 받은 code·state·error·iss 를 그 파드의 Hermes 대시보드 콜백으로
그대로 넘긴다. PKCE verifier·토큰 교환·저장·갱신은 파드 안 Hermes 가 한다 — AAS 는 토큰을 보지 않는다.

  상태 표    mcp_oauth_relays(state 기본 키). 660초(R7: oauth.timeout 600 + 60) 지나면 받지 않고, 한 번 쓰면 다시 받지 않는다.
             복제본이 여럿이어도 같은 DB 를 본다. ok_at 은 흐름이 approved 된 시각(옛 실패 기록 무시, 12절 D28).
  시작       redirect_uri 확인·바로잡기(R5) → 같은 (파드, 프로파일, 서버)의 끝나지 않은 흐름 취소(R4) → Hermes 흐름 시작 → 기록.
             같은 키의 시작은 key_lock 으로 한 번에 하나만.
  iss        인가 서버가 준 값을 그대로 넘긴다. 만들거나 바꾸지 않는다(발급자 혼동 공격 검증, 14-3). 패치 없는 Hermes 는 무시한다.
"""
from __future__ import annotations

import json
import time

import yaml
from urllib.parse import parse_qs, quote, urlsplit

from ..assets.files import FileError
from ..common import config, store
from ..common.i18n import tr
from ..common.redact import redact
from ..hermes.hermes_api import HermesAPI, HermesError
from . import mcp_servers, network_mode

CALLBACK_PATH = "/oauth/mcp/callback"
OAUTH_TIMEOUT = 600                    # oauth.timeout(R7). CLI 로그인용이다 — 대시보드 흐름은 이 값을 쓰지 않고 300초를 기다린다(14-8)
# 대시보드 흐름은 연결 한 번이 connect_timeout(기본 60초)을 넘으면 끊고 다시 시도하면서 state 를 새로 만든다. 사용자가 60초 넘게
# 인가 화면에 머물면 처음 state 로 돌아온 콜백이 404 가 됐다(14-8, 실제 화면 확인). 콜백 대기(wait_for_callback 기본 300초)만큼 늘린다
LOGIN_CONNECT_TIMEOUT = 300
RECORD_TTL = OAUTH_TIMEOUT + 60        # 기록을 받는 시간(R7)
START_TIMEOUT = 40                     # Hermes 는 인가 URL 을 최대 30초 기다린다(web_routers/mcp.py:272). 그보다 길게
BUSY_RETRY_SECONDS = 20               # 「이미 진행 중」(409)을 다시 시도하는 시간. 취소한 흐름의 작업자는 취소 뒤에도 첫 연결 재시도를
BUSY_RETRY_EVERY = 2                  # 다 거친 다음 끝나 몇 초 409 를 준다(14-10). 시작 전에 끝나지 않은 흐름은 이미 취소했으므로(R4) 기다리면 된다
KEEP_SECONDS = 86400                   # 끝난 기록을 남겨 두는 시간(오래된 것은 시작할 때 지운다)

SCHEMA = ("CREATE TABLE IF NOT EXISTS mcp_oauth_relays (state TEXT PRIMARY KEY, user_sub TEXT NOT NULL, user_email TEXT, "
          "pod TEXT NOT NULL, profile TEXT NOT NULL, server TEXT NOT NULL, flow_id TEXT NOT NULL, created_at REAL NOT NULL, "
          "used_at REAL, ok_at REAL, status TEXT NOT NULL)")
COLUMNS = "state, user_sub, user_email, pod, profile, server, flow_id, created_at, used_at, ok_at, status"


class RelayError(FileError):
    """사람이 읽는 이유(message)와 화면이 보는 판정 코드(reason)."""


def callback_url(public_url: str) -> str:
    return public_url.rstrip("/") + CALLBACK_PATH


def _user_key(user: dict | None) -> tuple[str, str]:
    """(비교에 쓰는 사용자 키, 이메일). 로그인을 끈 설치는 'local'."""
    if not user:
        return "local", ""
    return str(user.get("sub") or user.get("email") or "local"), str(user.get("email") or "")


def _rows(sql: str, args: tuple) -> list[dict]:
    with store.connect() as conn:
        conn.execute(SCHEMA)
        return [dict(r) for r in conn.execute(sql, args)]


def _exec(sql: str, args: tuple) -> int:
    with store.connect() as conn:
        conn.execute(SCHEMA)
        return conn.execute(sql, args).rowcount


def allow_http() -> bool:
    """사내 시험 환경에서 http 인가 주소를 열어 주는가(9절 Q3: 기본은 https 만)."""
    return config.get("AAS_MCP_OAUTH_ALLOW_HTTP", "").strip().lower() in ("1", "on", "true", "yes")


def _auth_url_check(url: str) -> tuple[str, bool]:
    """(인가 서버 호스트, 암호화되지 않은 주소인가). https 가 아니고 허용하지도 않으면 RelayError(V18)."""
    parts = urlsplit(url)
    host = parts.hostname or ""
    if parts.scheme == "https" and host:
        return host, False
    loopback = host in ("localhost", "127.0.0.1", "::1")
    if parts.scheme == "http" and host and (loopback or allow_http()):
        return host, not loopback
    raise RelayError(tr("인가 주소가 https 가 아니어서 열지 않았습니다", "The authorization address is not https, so it was not opened"),
                     400, reason="insecure_authorization_url")


def ensure_redirect(api: HermesAPI, prof: str | None, server: str, callback: str, *, pod: str, by: str) -> bool:
    """서버 설정의 oauth.redirect_uri·application_type·timeout 이 맞는지 보고, 아니면 지도 전체 쓰기로 바로잡는다(R1·R5·13절).
    바꿨으면 True. 헤더 인증 서버는 OAuth 로 바꾸기를 먼저 해야 한다."""
    def build(entry: dict) -> dict:
        if not entry.get("url"):
            raise RelayError(tr("원격 주소 MCP 서버만 OAuth 로 로그인합니다", "Only remote-address MCP servers sign in with OAuth"), 400, reason="not_remote")
        if entry.get("headers") and entry.get("auth") != "oauth":
            raise RelayError(tr("토큰(헤더) 인증 서버입니다. 먼저 「OAuth 로 바꾸기」를 하세요", "This server uses a token header. Use 「Switch to OAuth」 first"),
                             409, reason="header_auth")
        entry["auth"] = "oauth"
        oauth = dict(entry.get("oauth") or {})
        oauth.update(redirect_uri=callback, application_type="web", timeout=OAUTH_TIMEOUT)
        entry["oauth"] = oauth
        try:
            current = float(entry.get("connect_timeout") or 0)
        except (TypeError, ValueError):
            current = 0
        if current < LOGIN_CONNECT_TIMEOUT:                      # 더 길게 둔 값은 그대로 둔다
            entry["connect_timeout"] = LOGIN_CONNECT_TIMEOUT
        return entry
    return bool(mcp_servers.replace_server(api, prof, server, build, pod=pod, by=by, note="MCP OAuth 콜백 주소 맞추기")["changed"])   # i18n-ignore: 판 메모


def _cancel_pending(api: HermesAPI, pod: str, profile: str, server: str, now: float) -> int:
    """같은 키의 끝나지 않은 흐름을 Hermes 에서 취소하고 기록을 취소로 바꾼다(R4). 취소한 수."""
    rows = _rows("SELECT state, flow_id FROM mcp_oauth_relays WHERE pod=? AND profile=? AND server=? AND status=?",
                 (pod, profile, server, "pending"))
    for r in rows:
        try:
            api.call("DELETE", f"/api/mcp/oauth/flows/{quote(r['flow_id'], safe='')}")
        except HermesError:
            pass                                           # 이미 사라진 흐름(Hermes 재시작 등)은 취소된 것과 같다
        _exec("UPDATE mcp_oauth_relays SET status=?, used_at=? WHERE state=? AND status=?", ("cancelled", now, r["state"], "pending"))
    return len(rows)


def _start_error(exc: HermesError) -> RelayError:
    if exc.code == 404:
        return RelayError(tr("없는 서버입니다", "That server does not exist"), 404, reason="not_found")
    if exc.code in (409, 429):
        return RelayError(tr("진행 중인 로그인이 많습니다. 잠시 뒤 다시 시도하세요", "Too many sign-ins are in progress. Try again shortly"), 409, reason="busy")
    if exc.reason == "timeout":
        return RelayError(tr("Hermes 가 시간 안에 로그인 화면을 준비하지 못했습니다", "Hermes did not prepare the sign-in page in time"), 504, reason="timeout")
    return RelayError(tr(f"로그인을 시작하지 못했습니다: {redact(str(exc), 200)}", f"Could not start the sign-in: {redact(str(exc), 200)}"), 502, reason="start_failed")


def start(api: HermesAPI, *, pod: str, profile: str, prof: str | None, server: str, user: dict | None, public_url: str) -> dict:
    """로그인 흐름을 시작한다. {state, authorization_url, host, insecure}. 실패는 RelayError.
    profile: 프로파일 이름(기록의 키, 화면 주소에 쓴다). prof: Hermes API 의 profile 값(루트는 None)."""
    if not mcp_servers.NAME.match(server or ""):
        raise RelayError(tr("서버 이름이 맞지 않습니다", "Invalid server name"), 400, reason="bad_server")
    now = time.time()
    sub, email = _user_key(user)
    _exec("DELETE FROM mcp_oauth_relays WHERE created_at < ?", (now - KEEP_SECONDS,))
    callback = callback_url(public_url)
    ensure_redirect(api, prof, server, callback, pod=pod, by=email or sub)
    with mcp_servers.key_lock(f"mcp_oauth:{pod}:{profile}:{server}"):
        _cancel_pending(api, pod, profile, server, now)
        deadline = time.monotonic() + BUSY_RETRY_SECONDS
        while True:
            try:
                res = api.call("POST", f"/api/mcp/servers/{quote(server, safe='')}/auth", {}, {"profile": prof}, timeout=START_TIMEOUT)
                break
            except HermesError as exc:
                if exc.code == 409 and time.monotonic() + BUSY_RETRY_EVERY < deadline:
                    time.sleep(BUSY_RETRY_EVERY)
                    continue
                raise _start_error(exc) from None
        if not isinstance(res, dict) or res.get("status") == "error" or not res.get("authorization_url"):
            detail = redact(str((res or {}).get("error") or ""), 200) if isinstance(res, dict) else ""
            # 메타데이터를 못 읽거나 30초를 넘기면 HTTP 200 에 status:error 가 온다(4-7, 8절 8)
            raise RelayError(tr(f"이 환경에서 인가 서버에 닿지 않거나 로그인 정보를 읽지 못했습니다: {detail}",
                                f"The authorization server is not reachable from here, or its sign-in details could not be read: {detail}"),
                             502, reason="unreachable")
        url, flow_id = str(res["authorization_url"]), str(res.get("flow_id") or "")
        state = (parse_qs(urlsplit(url).query).get("state") or [""])[0]
        try:
            if not state:
                raise RelayError(tr("로그인 주소에 state 가 없습니다", "The sign-in address has no state"), 502, reason="no_state")
            host, insecure = _auth_url_check(url)
        except RelayError:
            # Hermes 에는 이미 흐름이 있다. 기록하지 않고 거절하면 AAS 가 모르는 흐름이 남아 다음 시작이 409 에 걸린다 — 취소한다
            try:
                api.call("DELETE", f"/api/mcp/oauth/flows/{quote(flow_id, safe='')}")
            except HermesError:
                pass
            raise
        _exec(f"INSERT INTO mcp_oauth_relays ({COLUMNS}) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
              (state, sub, email, pod, profile, server, flow_id, now, None, None, "pending"))
    return {"state": state, "authorization_url": url, "host": host, "insecure": insecure}


def claim(state: str, user: dict | None) -> dict:
    """콜백의 state 를 일회용으로 쓴다. 기록을 돌려준다. 없음·만료·이미 씀·다른 사용자면 RelayError(4-3, 6절)."""
    if not state:
        raise RelayError(tr("로그인 응답에 state 가 없습니다", "The sign-in response has no state"), 400, reason="missing_state")
    rows = _rows(f"SELECT {COLUMNS} FROM mcp_oauth_relays WHERE state=?", (state,))
    if not rows:
        raise RelayError(tr("알 수 없는 로그인 응답입니다. 다시 로그인하세요", "Unknown sign-in response. Sign in again"), 400, reason="unknown_state")
    row, now = rows[0], time.time()
    if row["status"] == "cancelled":
        raise RelayError(tr("다른 창에서 로그인을 다시 시작해 이 창은 끝났습니다", "Sign-in was restarted in another window, so this one has ended"), 409, reason="superseded")
    if row["used_at"] is not None or row["status"] != "pending":
        raise RelayError(tr("이미 처리한 로그인 응답입니다", "This sign-in response was already handled"), 409, reason="used")
    if now - float(row["created_at"]) > RECORD_TTL:
        raise RelayError(tr("로그인 시간이 지났습니다. 다시 로그인하세요", "The sign-in took too long. Sign in again"), 410, reason="expired")
    if _user_key(user)[0] != row["user_sub"]:
        raise RelayError(tr("로그인을 시작한 사용자와 지금 로그인한 사용자가 다릅니다", "The user who started the sign-in is not the one signed in now"), 403, reason="other_user")
    if _exec("UPDATE mcp_oauth_relays SET used_at=?, status=? WHERE state=? AND status=?", (now, "used", state, "pending")) != 1:
        raise RelayError(tr("이미 처리한 로그인 응답입니다", "This sign-in response was already handled"), 409, reason="used")     # 같은 응답이 동시에 두 번 온 경우
    return row


def deliver(api: HermesAPI, row: dict, *, code: str, state: str, error: str, iss: str) -> dict:
    """받은 응답을 그 파드의 Hermes 콜백에 넘긴다. {ok, reason}. ok 면 흐름이 토큰 교환을 이어 간다."""
    try:
        status, body = api.call_text("GET", f"/api/mcp/oauth/callback/{quote(row['server'], safe='')}",
                                     {"code": code, "state": state, "error": error, "iss": iss})
    except HermesError as exc:
        return {"ok": False, "reason": "hermes_down", "message": str(exc)}
    if status == 200:
        return {"ok": True, "reason": ""}
    if error:
        return {"ok": False, "reason": "denied" if error == "access_denied" else "auth_error",
                "message": tr("로그인을 취소했습니다", "You cancelled the sign-in") if error == "access_denied"
                else tr(f"인가 서버가 거절했습니다: {redact(error, 100)}", f"The authorization server refused: {redact(error, 100)}")}
    if status == 404:
        return {"ok": False, "reason": "flow_lost", "message": tr("Hermes 가 다시 시작돼 로그인 정보를 잃었습니다", "Hermes restarted and lost the sign-in")}
    return {"ok": False, "reason": "hermes_rejected", "message": tr(f"Hermes 가 로그인 응답을 받지 않았습니다(HTTP {status})", f"Hermes did not accept the sign-in response (HTTP {status})")}


def _latest(pod: str, profile: str, server: str) -> dict | None:
    rows = _rows(f"SELECT {COLUMNS} FROM mcp_oauth_relays WHERE pod=? AND profile=? AND server=? ORDER BY created_at DESC LIMIT 1",
                 (pod, profile, server))
    return rows[0] if rows else None


def started_by(pod: str, profile: str, server: str) -> str:
    """진행 중인 로그인(pending·used)을 시작한 사용자 키. 없으면 "". 웹소켓 토픽이 구독자마다 「내가 시작한 로그인」을 가린다(14-22)."""
    row = _latest(pod, profile, server)
    return str(row["user_sub"]) if row and row["status"] in IN_PROGRESS else ""


def by_state(state: str) -> dict | None:
    rows = _rows(f"SELECT {COLUMNS} FROM mcp_oauth_relays WHERE state=?", (state or "",))
    return rows[0] if rows else None


def status(api: HermesAPI, row: dict | None) -> dict:
    """기록 하나의 지금 상태. status: none·waiting·approved·error·cancelled·expired. 팝업과 원래 창이 2초마다 묻는다(4-1 6단계)."""
    if row is None:
        return {"status": "none"}
    base = {"server": row["server"], "profile": row["profile"], "started_at": row["created_at"]}
    if row["status"] == "cancelled":
        return {**base, "status": "cancelled"}
    if row["status"] == "approved":
        return {**base, "status": "approved", "ok_at": row["ok_at"]}
    if row["status"] == "error":
        return {**base, "status": "error"}
    try:
        flow = api.call("GET", f"/api/mcp/oauth/flows/{quote(row['flow_id'], safe='')}")
    except HermesError as exc:
        if exc.code == 404:                                   # Hermes 가 흐름을 지웠다(15분, 재시작)
            gone = time.time() - float(row["created_at"]) > RECORD_TTL
            return {**base, "status": "expired" if gone else "error", "reason": "expired" if gone else "flow_lost"}
        return {**base, "status": "waiting", "reason": "unreadable"}
    state = str(flow.get("status") or "")
    if state == "approved":
        now = time.time()
        _exec("UPDATE mcp_oauth_relays SET status=?, ok_at=? WHERE state=?", ("approved", now, row["state"]))
        return {**base, "status": "approved", "ok_at": now, "tools": len(flow.get("tools") or [])}
    if state == "error":
        _exec("UPDATE mcp_oauth_relays SET status=? WHERE state=?", ("error", row["state"]))
        return {**base, "status": "error", "error": redact(str(flow.get("error") or ""), 300)}
    if time.time() - float(row["created_at"]) > RECORD_TTL:
        return {**base, "status": "expired", "reason": "expired"}
    return {**base, "status": "waiting"}


def latest_status(api: HermesAPI, *, pod: str, profile: str, server: str) -> dict:
    return status(api, _latest(pod, profile, server))


def cancel(api: HermesAPI, *, pod: str, profile: str, server: str) -> int:
    """「취소」: 끝나지 않은 흐름을 취소한다. 취소한 수."""
    with mcp_servers.key_lock(f"mcp_oauth:{pod}:{profile}:{server}"):
        return _cancel_pending(api, pod, profile, server, time.time())


def last_login_at(pod: str, profile: str, server: str) -> float | None:
    """그 서버가 마지막으로 로그인에 성공한 시각(12절 D28: 이보다 이른 실패 기록은 무시한다)."""
    rows = _rows("SELECT MAX(ok_at) AS ok FROM mcp_oauth_relays WHERE pod=? AND profile=? AND server=? AND ok_at IS NOT NULL",
                 (pod, profile, server))
    return float(rows[0]["ok"]) if rows and rows[0]["ok"] is not None else None


def recent_login(pod: str, profile: str, within: float) -> bool:
    """그 프로파일의 어느 서버든 within 초 안에 로그인에 성공했나. 막 로그인한 동안 상태 읽기 캐시를 짧게 둔다(14-15)."""
    rows = _rows("SELECT MAX(ok_at) AS ok FROM mcp_oauth_relays WHERE pod=? AND profile=? AND ok_at IS NOT NULL", (pod, profile))
    return bool(rows and rows[0]["ok"] is not None and time.time() - float(rows[0]["ok"]) <= within)


# ---- 서버 행 상태(11-3, 12절 D22·D28·O5·O6·O9) ------------------------------------------------------------
# 판정은 decide 하나가 한다. 화면 목록(annotate)과 받은편지함(T8)이 같은 함수를 쓴다.
#   읽는 것: 토큰 파일의 있음·수정 시각(값은 읽지 않는다, 6절), 중개 기록(로그인 중·마지막 성공 시각),
#            게이트웨이 상태 파일(E-T2 Hermes 패치가 루트 홈에 쓴다. 없으면 옛 이미지로 보고 연결 여부는 「확인 전」, O9).
STATUS_FILE = "aas-mcp-status.json"
# 상태 파일 형식(E-T2 패치와 맞춘다): {"pid", "start_time", "servers": {<프로파일 이름>: {<서버>: {"state", "at", "tools", "error"}}}}
#   state: connected · parked_auth(토큰 없음·거절로 대기) · auth_failed(실행 중 갱신 실패·401) · failed(그 밖의 연결 실패)
#   pid·start_time 이 루트 gateway_state.json 과 같을 때만 믿는다 — 앞 게이트웨이가 남긴 파일은 쓰지 않는다(O5)
# 로그인 성공 뒤 게이트웨이가 붙기를 기다리는 동안 「로그인 중」. 게이트웨이는 config.yaml 의 바뀜(로그인 시작 때 콜백 주소를 쓴다)을
# 60초 주기 작업으로 읽고, 기다리는 서버는 30초마다 다시 본다(Hermes gateway/run.py housekeeping, tools/mcp_tool.py
# _PARKED_RETRY_INTERVAL). 그래서 붙기까지 최대 약 90초다(OKE 확인 2~61초). 여유 30초를 더한다(14-18). 로컬 확인 11~26초(14-2·14-5)
CONNECT_GRACE = 120
CLOCK_SLACK = 5         # 실패 기록 시각(파드 시계)과 로그인 성공 시각(AAS 시계)의 차이를 감안하는 여유(D28)
IN_PROGRESS = ("pending", "used")   # used: 콜백을 넘겼고 Hermes 가 토큰을 바꾸는 중(approved 를 아직 아무도 묻지 않음)
STATES = ("unknown", "login_required", "logging_in", "disabled_logged_in", "connected", "reauth_required", "connect_failed", "unavailable")


def token_times(home) -> dict[str, float]:
    """mcp-tokens/<서버>.json 의 수정 시각. 파일 내용은 읽지 않는다. 폴더가 없으면 {}. 읽지 못하면 OSError(사이드카 오류 포함)."""
    folder = home / "mcp-tokens"
    if not folder.is_dir():
        return {}
    out = {}
    for p in folder.glob("*.json"):
        name = p.name
        if name.endswith((".client.json", ".meta.json")):
            continue
        out[name[:-5]] = float(p.stat().st_mtime)
    return out


def _json_file(path) -> dict | None:
    try:
        data = json.loads(path.read_text())
    except FileNotFoundError:
        return None
    except ValueError:
        return None                                        # 쓰는 중인 파일·깨진 파일은 없는 것으로 본다
    return data if isinstance(data, dict) else None


def gateway_records(root) -> dict | None:
    """지금 게이트웨이가 쓴 서버별 기록 {프로파일: {서버: 기록}}. 패치가 없는 옛 이미지거나 다른 프로세스가 쓴 것이면 None(O5·O9).
    읽지 못하면 OSError."""
    status, gw = _json_file(root / STATUS_FILE), _json_file(root / "gateway_state.json")
    if not status or not gw or status.get("pid") is None:
        return None
    if status.get("pid") != gw.get("pid") or status.get("start_time") != gw.get("start_time"):
        return None
    servers = status.get("servers")
    return servers if isinstance(servers, dict) else None


def decide(entry: dict, *, url: str = "", token_at: float | None, records: dict | None, pending: dict | None,
           ok_at: float | None, now: float, user_sub: str = "") -> dict | None:
    """OAuth 서버 행 하나의 상태 {state, ...}. OAuth 서버가 아니면 None. 순서가 판정이다(11-3).
    records: 그 프로파일의 게이트웨이 기록({서버: 기록}). None 이면 옛 이미지(연결 여부를 모름)."""
    if entry.get("auth") != "oauth":
        return None
    if url:
        net = network_mode.check(url)
        if net["verdict"] == "blocked":
            return {"state": "unavailable", "reason": net["reason"], "message": net["message"]}
    if (pending is not None and now - float(pending["created_at"]) <= RECORD_TTL
            and (token_at is None or token_at < float(pending["created_at"]))):
        return {"state": "logging_in", "mine": bool(user_sub) and pending["user_sub"] == user_sub}
    if token_at is None:
        return {"state": "login_required"}
    if entry.get("enabled") is False:
        return {"state": "disabled_logged_in"}
    rec = (records or {}).get(entry.get("name")) if records is not None else None
    def newer_login(at: float) -> bool:                    # D28: 실패 기록보다 늦게 다시 로그인했으면 그 실패는 무시한다
        # 토큰 파일 시각과 기록 시각은 둘 다 파드 시계라 여유 없이 비교한다. 게이트웨이는 설정 확인이 5초마다라
        # 토큰이 생기기 전에 붙여 보고 기다리는 경우가 흔하다 — 그 기록은 토큰보다 이르다(14-20)
        if token_at is not None and token_at > at:
            return True
        return ok_at is not None and ok_at > at + CLOCK_SLACK
    if isinstance(rec, dict):
        state, at = str(rec.get("state") or ""), float(rec.get("at") or 0)
        if state == "connected":
            return {"state": "connected", "tools": rec.get("tools")}
        if state in ("parked_auth", "auth_failed") and not newer_login(at):
            return {"state": "reauth_required"}
        if state == "failed" and not newer_login(at):
            return {"state": "connect_failed", "message": redact(str(rec.get("error") or ""), 200)}
    if ok_at is not None and now - ok_at < CONNECT_GRACE:
        return {"state": "logging_in", "mine": False, "connecting": True}
    return {"state": "unknown", "reason": "no_gateway_status" if records is None else "no_record"}


def annotate(rows: list[dict], urls: dict[str, str], *, pod: str, profile: str, tokens: dict[str, float] | None,
             records: dict | None, user: dict | None, now: float | None = None) -> list[dict]:
    """서버 목록의 OAuth 행마다 login_state 를 붙인다(D31: mcp_view 는 그대로 두고 부르는 곳에서 덧붙인다).
    tokens 가 None 이면 토큰을 읽지 못한 것(사이드카에 닿지 않음) → 「확인 전」. records 는 그 프로파일의 게이트웨이 기록."""
    now = time.time() if now is None else now
    sub = _user_key(user)[0]
    for row in rows:
        if row.get("auth") != "oauth":
            continue
        if tokens is None:
            row["login_state"] = {"state": "unknown", "reason": "unreadable"}
            continue
        name = row["name"]
        latest = _latest(pod, profile, name)
        row["login_state"] = decide(row, url=urls.get(name, ""), token_at=tokens.get(name), records=records,
                                    pending=latest if latest and latest["status"] in IN_PROGRESS else None,
                                    ok_at=last_login_at(pod, profile, name), now=now, user_sub=sub)
    return rows


# ---- 받은편지함 「MCP 로그인 필요」(T8·V14·O7·O9) -------------------------------------------------------------
LOGIN_ITEM = "mcp_login"


def oauth_servers(home) -> dict[str, dict]:
    """그 프로파일 config.yaml 의 OAuth MCP 서버 {이름: {name, auth, enabled, url}}. 다른 칸(헤더 등)은 버린다. 없으면 {}."""
    cfg = home / "config.yaml"
    if not cfg.is_file():
        return {}
    try:
        data = yaml.safe_load(cfg.read_text(encoding="utf-8", errors="replace")) or {}
    except yaml.YAMLError:
        return {}
    servers = data.get("mcp_servers") if isinstance(data, dict) else None
    out = {}
    for name, v in (servers or {}).items():
        if isinstance(v, dict) and str(v.get("auth") or "").lower() == "oauth":
            out[str(name)] = {"name": str(name), "auth": "oauth", "enabled": v.get("enabled", True) is not False, "url": str(v.get("url") or "")}
    return out


def login_items(pod: str, root, profiles: list[tuple[str, object]], alias_of, now: float | None = None) -> list[dict]:
    """한 파드의 「MCP 로그인 필요」 항목. 읽을 때 계산하므로 로그인하면 다음 읽기에서 사라진다(V14). 서버마다 Hermes API 를 부르지 않는다(O7).
    profiles: (프로파일 이름, 홈). 게이트웨이 상태 파일이 없는 옛 이미지는 건너뛴다(O9). 읽지 못하면 OSError."""
    records = gateway_records(root)
    if records is None:
        return []
    now = time.time() if now is None else now
    items = []
    for name, home in profiles:
        servers = oauth_servers(home)
        if not servers:
            continue
        tokens = token_times(home)
        for server, entry in sorted(servers.items()):
            if not entry["enabled"]:
                continue                                         # 꺼진 서버는 에이전트가 쓰지 않는다. 행에는 「로그인」이 그대로 있다(V17)
            latest = _latest(pod, name, server)
            state = decide(entry, url=entry["url"], token_at=tokens.get(server), records=records.get(name) or {},
                           pending=latest if latest and latest["status"] in IN_PROGRESS else None,
                           ok_at=last_login_at(pod, name, server), now=now)
            if state and state["state"] in ("login_required", "reauth_required"):
                items.append({"id": f"{LOGIN_ITEM}|{pod}|{name}|{server}", "kind": LOGIN_ITEM, "alias": alias_of(pod, name) or name,
                              "pod": pod, "profile": name, "server": server, "text": server,
                              "reauth": state["state"] == "reauth_required"})
    return items

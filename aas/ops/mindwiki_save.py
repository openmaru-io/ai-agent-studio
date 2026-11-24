# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""「MindWiki 에 저장」(스펙 2026-11-15-002 A4·D3·D11, MindWiki 2026-11-15-004 W6).

사람이 고른 답 하나·파일 하나를 모델 없이 MindWiki 에 옮긴다.
  토큰    누르는 순간 로그인한 사람의 Keycloak 액세스 토큰(client aas, Auth.access_token 으로 갱신)으로 MindWiki 의 연결 저장 경로를
          부른다. AAS 서버는 개인 토큰 wiki_pat_ 을 읽지도 저장하지도 않는다(그것은 Hermes .env 에만, mindwiki_connect 머리말).
  워크스페이스  그 프로파일이 연결된 MindWiki 워크스페이스(connector_tokens.workspace) 하나만 쓴다. 연결이 없으면 need_workspace.
  저장 위치  사람·작업공간·프로파일마다 mindwiki_save_targets 에 기억한다(리뷰 Eng E12: 파드 이름은 넣지 않는다 — pod 는 AAS 의 작업공간 id).
  최근 위치  저장에 성공할 때마다 mindwiki_save_recent 에 (사람·작업공간·프로파일·워크스페이스·위치 id)로 한 줄, 다섯 줄만 남긴다(스펙 2026-11-23-019 R2).
          「이 위치 기억」을 끄고 저장해도 넣는다. 위치가 지워졌거나 권한을 잃으면(parent_not_found·forbidden_parent) 그 줄을 지운다(R3).
  요청 id  서버가 save_key()로 정한 키를 Idempotency-Key 로 넘긴다. MindWiki 가 같은 키의 둘째 요청에 첫 결과를 준다.
          키는 작업공간·프로파일·위치 종류·위치 id 와, 답은 (대화, 메시지)·파일은 (경로, 크기, 수정 시각)의 해시로 만든다(스펙 2026-11-23-019
          P8·리뷰 Eng H2). 예전에는 화면이 경로를 넣은 키를 200자에서 잘라 위치 id 가 빠지고, 다른 프로파일의 같은 경로가 앞 결과를 받았다.
  파일    사이드카 download 를 흘려 읽어 그대로 MindWiki 로 보낸다(크기 한도는 MindWiki 의 첨부 한도).
"""
from __future__ import annotations

import hashlib
import json
import os
import ssl
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone

from ..common import db, store
from . import mcp_servers, mindwiki_connect

SCHEMA = """
CREATE TABLE IF NOT EXISTS mindwiki_save_targets (
  sub TEXT NOT NULL, pod TEXT NOT NULL, profile TEXT NOT NULL, workspace TEXT NOT NULL DEFAULT '',
  teamspace TEXT NOT NULL DEFAULT '', parent_id TEXT NOT NULL DEFAULT '', parent_title TEXT NOT NULL DEFAULT '', path TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT '', PRIMARY KEY (sub, pod, profile));
CREATE TABLE IF NOT EXISTS mindwiki_save_recent (
  sub TEXT NOT NULL, pod TEXT NOT NULL, profile TEXT NOT NULL, workspace TEXT NOT NULL, parent_id TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'page', title TEXT NOT NULL DEFAULT '', path TEXT NOT NULL DEFAULT '', teamspace TEXT NOT NULL DEFAULT '',
  saved_at TEXT NOT NULL DEFAULT '', PRIMARY KEY (sub, pod, profile, workspace, parent_id));
"""

RECENT_MAX = 5           # (사람, 작업공간, 프로파일, 워크스페이스)마다 남기는 최근 위치 수(스펙 2026-11-23-019 R2)
LOCK_RECENT = 1297568323 # 최근 위치 「넣기 → 다섯 넘는 줄 지우기」를 한 줄로 세우는 advisory 잠금 첫 키('MWRC'). 둘째 키가 사람·프로파일 해시
CAP_TTL = 600            # capabilities 결과를 설치 단위로 기억하는 초(리뷰 Eng F8)
MAX_MARKDOWN = 1 << 20   # MindWiki connectorSaveBytes 와 같다
MAX_TITLE = 200

# 화면이 문장으로 바꾸는 이유 코드(ui i18n chat.mwSave.reason.<코드>)
REASONS = ("no_mindwiki", "row_rejected", "need_upgrade", "no_keycloak", "not_owner", "session_ended", "no_refresh_token", "lease_busy", "keycloak_unavailable", "need_workspace",
           "write_disabled", "old_mindwiki", "parent_not_found", "forbidden_parent", "attachment_too_large", "rate_limited", "in_progress",
           "need_target", "invalid", "timeout", "mindwiki_5xx", "not_found", "not_file", "agent_unreachable", "busy")


class SaveError(Exception):
    def __init__(self, reason: str, status: int = 400, detail: str = ""):
        super().__init__(reason)
        self.reason, self.status, self.detail = reason, status, detail


_cap: dict = {}
_cap_lock = threading.Lock()
_migrated = False

KINDS = ("page", "database", "teamspace")   # 저장 위치 종류(스펙 2026-11-23-019 R1)


def _conn():
    global _migrated
    conn = store.connect()
    conn.executescript(SCHEMA)
    if not _migrated:
        # 옛 표에 kind 열(R1). 날 SQL ALTER 대신 이전 도우미 — 서버 여럿이 함께 시작해도 중복 열로 실패하지 않는다(리뷰 DX CAP6-3)
        db.add_column(conn, "mindwiki_save_targets", "kind TEXT NOT NULL DEFAULT 'page'")
        _migrated = True
    return conn


def timezone_name() -> str:
    return os.environ.get("AAS_TIMEZONE", "").strip() or "Asia/Seoul"


def target(sub: str, pod: str, profile: str) -> dict | None:
    with _conn() as conn:
        r = conn.execute("SELECT * FROM mindwiki_save_targets WHERE sub=? AND pod=? AND profile=?", (sub, pod, profile)).fetchone()
    return dict(r) if r else None


def set_target(sub: str, pod: str, profile: str, *, workspace: str, teamspace: str, parent_id: str, parent_title: str, path: str,
               kind: str = "page") -> dict:
    vals = (sub, pod, profile, workspace[:80], teamspace[:80], parent_id[:80], parent_title[:300], path[:600],
            datetime.now(timezone.utc).isoformat(timespec="seconds"), kind if kind in KINDS else "page")
    with _conn() as conn:
        conn.execute("INSERT INTO mindwiki_save_targets (sub, pod, profile, workspace, teamspace, parent_id, parent_title, path, updated_at, kind) "
                     "VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(sub, pod, profile) DO UPDATE SET workspace=excluded.workspace, "
                     "teamspace=excluded.teamspace, parent_id=excluded.parent_id, parent_title=excluded.parent_title, path=excluded.path, "
                     "updated_at=excluded.updated_at, kind=excluded.kind", vals)
    return target(sub, pod, profile) or {}


def forget_target_if(sub: str, pod: str, profile: str, parent_id: str) -> bool:
    """기억한 위치가 이 부모면 지운다(R3: 지워졌거나 권한을 잃은 위치로 바로 저장할 때마다 같은 실패가 되풀이되지 않게)."""
    with _conn() as conn:
        return conn.execute("DELETE FROM mindwiki_save_targets WHERE sub=? AND pod=? AND profile=? AND parent_id=?",
                            (sub, pod, profile, parent_id)).rowcount > 0


def _lock_recent(conn, sub: str, pod: str, profile: str) -> None:
    """같은 (사람, 작업공간, 프로파일)의 동시 저장을 한 줄로 세운다. PostgreSQL READ COMMITTED 에서는 두 트랜잭션이 서로의 새 줄을
    보지 못해 각자 다섯으로 줄이고 여섯이 남는다(리뷰 Eng L-d). SQLite 는 BEGIN IMMEDIATE 로 쓰기 잠금을 먼저 쥔다."""
    if db.is_pg(conn):
        h = int.from_bytes(hashlib.sha256(f"{sub}\x1f{pod}\x1f{profile}".encode()).digest()[:4], "big", signed=True)
        conn.execute("SELECT pg_advisory_xact_lock(?, ?)", (LOCK_RECENT, h))
    elif not conn.in_transaction:
        conn.execute("BEGIN IMMEDIATE")


def add_recent(sub: str, pod: str, profile: str, *, workspace: str, parent_id: str, kind: str = "page", title: str = "", path: str = "",
               teamspace: str = "") -> None:
    """저장에 성공한 위치를 최근 목록에 넣거나 시각을 고치고, 그 워크스페이스의 다섯 줄만 남긴다 — 넣기와 지우기는 한 트랜잭션(R2)."""
    if not (workspace and parent_id):
        return
    now = datetime.now(timezone.utc).isoformat(timespec="microseconds")   # 같은 초에 두 번 저장해도 순서가 갈리게
    vals = (sub, pod, profile, workspace[:80], parent_id[:80], kind if kind in KINDS else "page", title[:300], path[:600], teamspace[:80], now)
    key = (sub, pod, profile, workspace[:80])
    with _conn() as conn:
        _lock_recent(conn, sub, pod, profile)
        conn.execute("INSERT INTO mindwiki_save_recent (sub, pod, profile, workspace, parent_id, kind, title, path, teamspace, saved_at) "
                     "VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(sub, pod, profile, workspace, parent_id) DO UPDATE SET kind=excluded.kind, "
                     "title=excluded.title, path=excluded.path, teamspace=excluded.teamspace, saved_at=excluded.saved_at", vals)
        old = [r[0] for r in conn.execute("SELECT parent_id FROM mindwiki_save_recent WHERE sub=? AND pod=? AND profile=? AND workspace=? "
                                          "ORDER BY saved_at DESC, parent_id", key).fetchall()[RECENT_MAX:]]
        for parent in old:
            conn.execute("DELETE FROM mindwiki_save_recent WHERE sub=? AND pod=? AND profile=? AND workspace=? AND parent_id=?", (*key, parent))


def recent(sub: str, pod: str, profile: str, workspace: str) -> list[dict]:
    """그 워크스페이스의 최근 위치(새것 먼저). 다른 워크스페이스의 줄은 주지 않는다(R3)."""
    if not workspace:
        return []
    with _conn() as conn:
        rows = conn.execute("SELECT teamspace, parent_id, title, path, kind, saved_at FROM mindwiki_save_recent "
                            "WHERE sub=? AND pod=? AND profile=? AND workspace=? ORDER BY saved_at DESC, parent_id LIMIT ?",
                            (sub, pod, profile, workspace, RECENT_MAX)).fetchall()
    return [{"teamspace": r["teamspace"], "parent_id": r["parent_id"], "parent_title": r["title"], "path": r["path"],
             "kind": r["kind"] if r["kind"] in KINDS else "page", "saved_at": r["saved_at"]} for r in rows]


def forget_recent(sub: str, pod: str, profile: str, parent_id: str) -> int:
    """지워졌거나 권한을 잃은 위치의 최근 줄을 지운다(R3). 워크스페이스는 가리지 않는다 — 위치 id 는 MindWiki 전체에서 하나다."""
    with _conn() as conn:
        return conn.execute("DELETE FROM mindwiki_save_recent WHERE sub=? AND pod=? AND profile=? AND parent_id=?",
                            (sub, pod, profile, parent_id)).rowcount


def save_key(kind: str, pod: str, profile: str, where: str, parent: str, *parts: object) -> str:
    """Idempotency-Key(길이 고정). kind 는 answer·file, where 는 위치 종류(page·database·teamspace).
    같은 (작업공간, 프로파일, 위치, 대상)은 같은 키 — 두 번 눌러도 MindWiki 에 한 번만 생긴다. 대상은 SHA-256 앞 16자로 줄여 위치 id 가 잘리지 않게 한다."""
    digest = hashlib.sha256("\x1f".join(str(p) for p in parts).encode()).hexdigest()[:16]
    pod_h = hashlib.sha256(f"{pod}\x1f{profile}".encode()).hexdigest()[:12]   # 프로파일 이름이 길어도 키가 200자를 넘지 않게
    return f"{kind}:{pod_h}:{where}:{parent[:80]}:{digest}"


def forget_targets(pod: str, profile: str | None = None) -> int:
    """작업공간·프로파일을 지우면 기억한 위치와 최근 위치(R2)를 함께 지운다. 돌려주는 값은 지운 기억 위치 수."""
    where, args = ("pod=?", (pod,)) if profile is None else ("pod=? AND profile=?", (pod, profile))
    with _conn() as conn:
        conn.execute(f"DELETE FROM mindwiki_save_recent WHERE {where}", args)
        return conn.execute(f"DELETE FROM mindwiki_save_targets WHERE {where}", args).rowcount


def connected_workspace(sub: str, pod: str, profile: str) -> str:
    row = mindwiki_connect._row(sub, pod, profile)
    return str((row or {}).get("workspace") or "") if row and row.get("status") in ("connected", "revoked", "opted_out") else ""


def _reason_of(status: int, code: str) -> str:
    if status == 404 and not code:
        return "old_mindwiki"                          # W6 이 없는 MindWiki(옛 판)
    if status == 403 and code in ("connector_scope", "not_connector"):
        return "old_mindwiki"                          # 연결 client 로 이 경로를 못 부른다 — 이 경로가 없는 판이거나 허용 목록이 옛것
    if status == 401:
        return "session_ended"
    if code in REASONS:
        return code
    if status == 429:
        return "rate_limited"
    if status == 413:
        return "attachment_too_large"
    return "mindwiki_5xx" if status >= 500 or status == 502 else "invalid"


def call(method: str, path: str, token: str, workspace: str, *, body: dict | None = None, data=None, length: int = 0,
         headers: dict | None = None) -> tuple[int, dict]:
    """MindWiki 를 부른다. 실패는 SaveError(이유 코드). Authorization 머리글·토큰은 오류·로그에 넣지 않는다(리뷰 DX)."""
    url = mcp_servers.mindwiki_url().rstrip("/") + path
    h = {"Authorization": f"Bearer {token}", "Accept": "application/json", "X-Workspace": workspace, **(headers or {})}
    payload = None
    if body is not None:
        payload, h["Content-Type"] = json.dumps(body).encode(), "application/json"
    elif data is not None:
        payload, h["Content-Type"], h["Content-Length"] = data, "application/octet-stream", str(length)
    req = urllib.request.Request(url, data=payload, method=method, headers=h)
    try:
        with urllib.request.urlopen(req, timeout=max(mindwiki_connect.timeout_s(), 60.0 if data is not None else 0),
                                    context=mcp_servers._probe_context()) as resp:
            raw = resp.read()
            return resp.status, (json.loads(raw) if raw else {})
    except urllib.error.HTTPError as exc:
        try:
            err = json.loads(exc.read() or b"{}")
        except ValueError:
            err = {}
        status = 409 if exc.code == 401 else exc.code if exc.code < 500 else 502   # 화면 전역의 401 이동을 타지 않게
        raise SaveError(_reason_of(exc.code, str(err.get("code") or "")), status) from None
    except (ssl.SSLError, ssl.CertificateError):
        raise SaveError("mindwiki_5xx", 502, "tls") from None
    except urllib.error.URLError as exc:
        if isinstance(exc.reason, TimeoutError):
            raise SaveError("timeout", 504) from None
        raise SaveError("mindwiki_5xx", 502, "unreachable") from None
    except TimeoutError:
        raise SaveError("timeout", 504) from None


def capabilities(token: str, workspace: str) -> dict:
    """「미리 막힘」 확인. 설치 단위로 10분 기억한다 — 화면을 열 때마다 Keycloak 토큰을 갱신하지 않게(리뷰 Eng F8)."""
    key = mcp_servers.mindwiki_url()
    with _cap_lock:
        got = _cap.get(key)
        if got and time.time() - got[0] < CAP_TTL:
            return got[1]
    try:
        _, out = call("GET", "/api/connector/capabilities", token, workspace)
        try:
            level = int(out.get("save") or 0)                 # 판 번호를 정수로 둔다 — 참·거짓으로 바꾸면 2 를 알 수 없다(스펙 2026-11-23-019 P7)
        except (TypeError, ValueError):
            level = 1 if out.get("save") else 0
        cap = {"save": level > 0, "save_level": level, "make_database": bool(out.get("makeDatabase")),
               "write_disabled": bool(out.get("writeDisabled")), "reason": "write_disabled" if out.get("writeDisabled") else ""}
    except SaveError as e:
        if e.reason not in ("old_mindwiki",):
            raise
        cap = {"save": False, "save_level": 0, "make_database": False, "write_disabled": False, "reason": "old_mindwiki"}
    with _cap_lock:
        _cap[key] = (time.time(), cap)
    return cap


def cached_capabilities() -> dict | None:
    """토큰 없이 볼 수 있는 기억한 결과(화면을 열 때 Keycloak 을 부르지 않으려고)."""
    with _cap_lock:
        got = _cap.get(mcp_servers.mindwiki_url())
    return got[1] if got and time.time() - got[0] < CAP_TTL else None


def clear_cache() -> None:
    with _cap_lock:
        _cap.clear()


def save_level() -> int:
    """기억한 판 번호(토큰 없이). 기억이 없으면 0 — 서버 가드(need_upgrade)는 모르면 막는다."""
    return int((cached_capabilities() or {}).get("save_level") or 0)


def teamspaces(token: str, workspace: str) -> list:
    _, out = call("GET", "/api/connector/teamspaces", token, workspace)
    # MindWiki 는 camelCase, AAS 경로는 snake_case — 여기서 한 번 바꾼다(리뷰 DX A2). 옛 MindWiki 는 canCreateTop 이 없다(만들 수 없다고 본다)
    return [{**{k: v for k, v in t.items() if k != "canCreateTop"}, "can_create_top": bool(t.get("canCreateTop"))}
            for t in (out.get("teamspaces") or []) if isinstance(t, dict)]


def pages(token: str, workspace: str, *, parent: str = "", teamspace: str = "", q: str = "", kinds: bool = False) -> dict:
    """kinds 가 참이면 데이터베이스도 받는다(W1, 판 2 이상). 없으면 옛 MindWiki 와 같은 요청 — 페이지만."""
    params = [("parent", parent), ("teamspace", teamspace), ("q", q[:100]), ("kinds", "page,database" if kinds else "")]
    qs = urllib.parse.urlencode({k: v for k, v in params if v})
    _, out = call("GET", "/api/connector/pages" + (f"?{qs}" if qs else ""), token, workspace)
    items = [{"id": p.get("id", ""), "title": p.get("title", ""), "path": p.get("path", ""), "kind": p.get("kind") or "page",
              "has_children": bool(p.get("hasChildren"))} for p in (out.get("pages") or []) if isinstance(p, dict)]
    return {"pages": items, "more": bool(out.get("more"))}


def footer(agent: str, aas_url: str, at: datetime | None = None) -> str:
    """저장 페이지 끝 줄(리뷰 Design 문구): 「AAS 대화에서 저장: <에이전트> · <YYYY-MM-DD HH:mm> · [대화 열기]」"""
    try:
        from zoneinfo import ZoneInfo
        zone = ZoneInfo(timezone_name())
    except Exception:  # noqa: BLE001 — 틀린 시간대 이름은 UTC 로
        zone = timezone.utc
    stamp = (at or datetime.now(timezone.utc)).astimezone(zone).strftime("%Y-%m-%d %H:%M")
    # 화면은 해시 경로다(#/chat). /chat 은 서버가 404 를 준다(OKE 2026-11-15)
    # i18n-ignore: MindWiki 페이지에 남는 글이다 — 저장한 사람의 화면 언어가 아니라 정해진 한 줄로 둔다(리뷰 Design 문구)
    link = f" · [대화 열기]({aas_url.rstrip('/')}/#/chat)" if aas_url else ""
    # i18n-ignore: 위와 같은 페이지 끝 줄
    return f"AAS 대화에서 저장: {agent} · {stamp}{link}"


def save_answer(token: str, workspace: str, *, parent: str, title: str, markdown: str, key: str, agent: str, aas_url: str,
                kind: str = "page") -> dict:
    """kind: page(하위 페이지)·database(새 행 + 본문)·teamspace(맨 위 페이지). 행 본문 쓰기가 실패하면 body_failed(W2, P8)."""
    title = " ".join(str(title or "").split())[:MAX_TITLE]
    if not parent:
        raise SaveError("need_target")
    if not title or not markdown.strip() or len(markdown.encode()) > MAX_MARKDOWN - 4096:
        raise SaveError("invalid")
    body = {"parentId": parent, "title": title, "markdown": markdown.rstrip() + "\n\n---\n\n" + footer(agent, aas_url)}
    if kind != "page":
        body["parentKind"] = kind                            # 옛 MindWiki 에는 보내지 않는다 — 서버 가드가 판 2 미만이면 막는다(need_upgrade)
    status, out = call("POST", "/api/connector/pages", token, workspace, body=body, headers={"Idempotency-Key": key[:200]})
    return {"page_id": str(out.get("pageId") or ""), "url": str(out.get("url") or ""), "replayed": status == 200,
            "body_failed": bool(out.get("bodyFailed"))}


def create_location(token: str, workspace: str, *, make: str, parent: str, parent_kind: str, title: str, key: str) -> dict:
    """고르기 창의 「새 페이지」·「새 데이터베이스」(P3·P4·W3). 새 페이지는 기존 pages 경로에 빈 본문, 새 데이터베이스는 databases 경로.
    요청 키는 답 저장과 따로(make:…:nonce) — 같은 답에서 만들기 뒤 저장이 만들기 결과를 돌려받지 않게(리뷰 spec2 5-1)."""
    title = " ".join(str(title or "").split())[:MAX_TITLE]
    if not parent or not title or make not in ("page", "database") or parent_kind not in ("page", "teamspace"):
        raise SaveError("invalid")
    body = {"parentId": parent, "title": title}
    if parent_kind != "page":
        body["parentKind"] = parent_kind
    path = "/api/connector/pages" if make == "page" else "/api/connector/databases"
    if make == "page":
        body["markdown"] = ""
    status, out = call("POST", path, token, workspace, body=body, headers={"Idempotency-Key": key[:200]})
    return {"id": str(out.get("pageId") or out.get("databaseId") or out.get("id") or ""), "url": str(out.get("url") or ""),
            "kind": make, "title": title, "replayed": status == 200}


def save_file(token: str, workspace: str, *, parent: str, name: str, stream, length: int, key: str, kind: str = "page") -> dict:
    if not parent:
        raise SaveError("need_target")
    from email.header import Header
    q = "container=aas-files" + (f"&kind={kind}" if kind != "page" else "")   # 데이터베이스·팀스페이스 id 는 kind 를 함께 보낼 때만(W4, 옛 AAS 보호)
    status, out = call("POST", f"/api/connector/pages/{urllib.parse.quote(parent)}/attachments?{q}", token, workspace,
                       data=stream, length=length, headers={"Idempotency-Key": key[:200], "X-File-Name": Header(name, "utf-8").encode()})
    return {"page_id": str(out.get("pageId") or ""), "attachment_id": str(out.get("attachmentId") or ""), "name": str(out.get("name") or name),
            "url": str(out.get("url") or ""), "replayed": status == 200, "attach_failed": bool(out.get("attachFailed"))}

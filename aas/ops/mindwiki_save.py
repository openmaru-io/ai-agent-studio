# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""「MindWiki 에 저장」(스펙 2026-11-15-002 A4·D3·D11, MindWiki 2026-11-15-004 W6).

사람이 고른 답 하나·파일 하나를 모델 없이 MindWiki 에 옮긴다.
  토큰    누르는 순간 로그인한 사람의 Keycloak 액세스 토큰(client aas, Auth.access_token 으로 갱신)으로 MindWiki 의 연결 저장 경로를
          부른다. AAS 서버는 개인 토큰 wiki_pat_ 을 읽지도 저장하지도 않는다(그것은 Hermes .env 에만, mindwiki_connect 머리말).
  워크스페이스  그 프로파일이 연결된 MindWiki 워크스페이스(connector_tokens.workspace) 하나만 쓴다. 연결이 없으면 need_workspace.
  저장 위치  사람·작업공간·프로파일마다 mindwiki_save_targets 에 기억한다(리뷰 Eng E12: 파드 이름은 넣지 않는다 — pod 는 AAS 의 작업공간 id).
  요청 id  화면이 (대화, 메시지, 저장 위치)로 정한 키를 Idempotency-Key 로 넘긴다. MindWiki 가 같은 키의 둘째 요청에 첫 결과를 준다.
  파일    사이드카 download 를 흘려 읽어 그대로 MindWiki 로 보낸다(크기 한도는 MindWiki 의 첨부 한도).
"""
from __future__ import annotations

import json
import os
import ssl
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone

from ..common import store
from . import mcp_servers, mindwiki_connect

SCHEMA = """
CREATE TABLE IF NOT EXISTS mindwiki_save_targets (
  sub TEXT NOT NULL, pod TEXT NOT NULL, profile TEXT NOT NULL, workspace TEXT NOT NULL DEFAULT '',
  teamspace TEXT NOT NULL DEFAULT '', parent_id TEXT NOT NULL DEFAULT '', parent_title TEXT NOT NULL DEFAULT '', path TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT '', PRIMARY KEY (sub, pod, profile));
"""

CAP_TTL = 600            # capabilities 결과를 설치 단위로 기억하는 초(리뷰 Eng F8)
MAX_MARKDOWN = 1 << 20   # MindWiki connectorSaveBytes 와 같다
MAX_TITLE = 200

# 화면이 문장으로 바꾸는 이유 코드(ui i18n chat.mwSave.reason.<코드>)
REASONS = ("no_keycloak", "not_owner", "session_ended", "no_refresh_token", "lease_busy", "keycloak_unavailable", "need_workspace",
           "write_disabled", "old_mindwiki", "parent_not_found", "forbidden_parent", "attachment_too_large", "rate_limited", "in_progress",
           "need_target", "invalid", "timeout", "mindwiki_5xx", "not_found", "not_file", "agent_unreachable", "busy")


class SaveError(Exception):
    def __init__(self, reason: str, status: int = 400, detail: str = ""):
        super().__init__(reason)
        self.reason, self.status, self.detail = reason, status, detail


_cap: dict = {}
_cap_lock = threading.Lock()


def _conn():
    conn = store.connect()
    conn.executescript(SCHEMA)
    return conn


def timezone_name() -> str:
    return os.environ.get("AAS_TIMEZONE", "").strip() or "Asia/Seoul"


def target(sub: str, pod: str, profile: str) -> dict | None:
    with _conn() as conn:
        r = conn.execute("SELECT * FROM mindwiki_save_targets WHERE sub=? AND pod=? AND profile=?", (sub, pod, profile)).fetchone()
    return dict(r) if r else None


def set_target(sub: str, pod: str, profile: str, *, workspace: str, teamspace: str, parent_id: str, parent_title: str, path: str) -> dict:
    vals = (sub, pod, profile, workspace[:80], teamspace[:80], parent_id[:80], parent_title[:300], path[:600],
            datetime.now(timezone.utc).isoformat(timespec="seconds"))
    with _conn() as conn:
        conn.execute("INSERT INTO mindwiki_save_targets (sub, pod, profile, workspace, teamspace, parent_id, parent_title, path, updated_at) "
                     "VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(sub, pod, profile) DO UPDATE SET workspace=excluded.workspace, "
                     "teamspace=excluded.teamspace, parent_id=excluded.parent_id, parent_title=excluded.parent_title, path=excluded.path, "
                     "updated_at=excluded.updated_at", vals)
    return target(sub, pod, profile) or {}


def forget_targets(pod: str, profile: str | None = None) -> int:
    """작업공간·프로파일을 지우면 기억한 위치도 지운다."""
    with _conn() as conn:
        if profile is None:
            return conn.execute("DELETE FROM mindwiki_save_targets WHERE pod=?", (pod,)).rowcount
        return conn.execute("DELETE FROM mindwiki_save_targets WHERE pod=? AND profile=?", (pod, profile)).rowcount


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
        cap = {"save": bool(out.get("save")), "write_disabled": bool(out.get("writeDisabled")), "reason": "write_disabled" if out.get("writeDisabled") else ""}
    except SaveError as e:
        if e.reason not in ("old_mindwiki",):
            raise
        cap = {"save": False, "write_disabled": False, "reason": "old_mindwiki"}
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


def teamspaces(token: str, workspace: str) -> list:
    _, out = call("GET", "/api/connector/teamspaces", token, workspace)
    return list(out.get("teamspaces") or [])


def pages(token: str, workspace: str, *, parent: str = "", teamspace: str = "", q: str = "") -> dict:
    qs = urllib.parse.urlencode({k: v for k, v in (("parent", parent), ("teamspace", teamspace), ("q", q[:100])) if v})
    _, out = call("GET", "/api/connector/pages" + (f"?{qs}" if qs else ""), token, workspace)
    return {"pages": list(out.get("pages") or []), "more": bool(out.get("more"))}


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


def save_answer(token: str, workspace: str, *, parent: str, title: str, markdown: str, key: str, agent: str, aas_url: str) -> dict:
    title = " ".join(str(title or "").split())[:MAX_TITLE]
    if not parent:
        raise SaveError("need_target")
    if not title or not markdown.strip() or len(markdown.encode()) > MAX_MARKDOWN - 4096:
        raise SaveError("invalid")
    body = {"parentId": parent, "title": title, "markdown": markdown.rstrip() + "\n\n---\n\n" + footer(agent, aas_url)}
    status, out = call("POST", "/api/connector/pages", token, workspace, body=body, headers={"Idempotency-Key": key[:200]})
    return {"page_id": str(out.get("pageId") or ""), "url": str(out.get("url") or ""), "replayed": status == 200}


def save_file(token: str, workspace: str, *, parent: str, name: str, stream, length: int, key: str) -> dict:
    if not parent:
        raise SaveError("need_target")
    from email.header import Header
    status, out = call("POST", f"/api/connector/pages/{urllib.parse.quote(parent)}/attachments?container=aas-files", token, workspace,
                       data=stream, length=length, headers={"Idempotency-Key": key[:200], "X-File-Name": Header(name, "utf-8").encode()})
    return {"page_id": str(out.get("pageId") or ""), "attachment_id": str(out.get("attachmentId") or ""), "name": str(out.get("name") or name),
            "url": str(out.get("url") or ""), "replayed": status == 200}

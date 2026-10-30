# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""MCP 서버 추가·삭제·카탈로그(스펙 2026-10-15-025 §9). Hermes 대시보드 API 로 보낼 요청을 검사해 만들고 결과를 화면에 낼 만큼만 줄인다.

  서버 키    Hermes 가 토큰 변수(`MCP_<키>_API_KEY`)를 만드는 식과 같은 계산(대문자, 영문·숫자·_ 외는 _, 앞뒤 _ 제거). 이름 중복 검사와 변수 이름에 같은 키를 쓴다.
  비밀 값    stdio 환경변수 값은 프로파일 `.env` 의 `MCP_<키>__<이름>__<4자리>` 로 쓰고 설정에는 `${…}` 참조만 남긴다(설정 탭이 읽기 전용이 되지 않게).
             원격 주소의 토큰은 Hermes 가 `.env` 에 쓴다(bearer_token). 두 경우 모두 암호화된 요청(_secure)에서만 받는다.
  롤백       Hermes 가 400·409 로 분명히 거절했을 때만 이번 요청에서 쓴 `.env` 줄을 지운다. 시간 초과·5xx 는 저장 여부를 읽어 보고 없을 때만 지운다.
  삭제       그 서버 설정이 참조하는 `MCP_` 변수 줄 중 다른 서버가 참조하지 않는 것도 함께 지운다.
  상한       파드 전체에서 켜진 stdio 서버 수(원격 주소 서버는 세지 않는다). 읽지 못하면 거절한다.
  설정 쓰기  서버 항목의 키를 빼야 할 때(헤더→OAuth, oauth 되돌리기)는 replace_server 로 지도 전체를 쓴다. Hermes 의 PUT /api/config 는
             깊은 병합이라 키를 지우지 못한다(스펙 2026-10-16-010 13절).
  Docmost    카탈로그 맨 앞에 AAS 가 만든 `docmost` 항목을 늘 보인다. 사용자가 MCP 주소와 키를 넣는다(설치 값 AAS_DOCMOST_MCP_URL 은 주소 칸을 미리 채운다).
             설치는 원격 주소 + 토큰으로 추가하고 tools.include 를 읽기 도구(고르면 쓰기 도구까지)로 채운 뒤 그 프로파일의 browser 도구 묶음을 끈다
             (스펙 2026-10-23-002 R2·R6·12-5·12-6). 사내 주소를 코드에 두지 않는다(공개 소스 내보내기 규칙).
  Outline    Docmost 옆에 `outline` 항목을 둔다(스펙 2026-10-23-004). 같은 순서로 설치하고 browser 와 connections 도구 묶음을 함께 끈다.
             삭제 도구는 쓰기를 켜도 등록하지 않는다(Q3). Docmost 코드와 같은 규칙을 두 벌로 둔다 — 한쪽을 고치면 다른 쪽도 고친다(Q1).
"""
from __future__ import annotations

import copy
import hashlib
import json
import re
import secrets
import threading
import time
from contextlib import contextmanager
from urllib.parse import quote, urlsplit

import yaml

from ..assets import files
from ..assets.files import FileError, mask_line
from ..common import config, db, store
from ..common.i18n import tr
from ..common.redact import redact
from ..hermes.hermes_api import HermesAPI, HermesError
from . import network_mode, owner_guard

NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,40}$")
ENV_NAME = re.compile(r"^[A-Z][A-Z0-9]*(_[A-Z0-9]+)*$")
REF = re.compile(r"\$\{(MCP_[A-Z0-9_]+)\}")
RUNNERS = ("npx", "uvx", "uv", "python", "python3", "node")      # 직접 입력도 받지만 흔한 실행 파일만 안내한다(화면)
TEST_TIMEOUT = 45                                                 # 연결 시험은 Hermes 가 30초만 기다린다(스펙 R14)
STDIO_LIMIT_DEFAULT = 10                                          # 실측 전 임시 값(Phase 0.4)
BEARER = re.compile(r"^\s*bearer\s+", re.I)
DOCMOST = "docmost"                                               # 서버 이름. Skill(docmost)이 mcp__docmost__* 도구 이름으로 가리킨다
DOCMOST_KEY = "MCP_DOCMOST_API_KEY"                               # Hermes 가 bearer_token 을 쓰는 변수 이름(MCP_<서버 키>_API_KEY)
DOCMOST_URL_FIELD = "DOCMOST_MCP_URL"                             # 카탈로그 항목의 주소 칸. .env 에 쓰지 않고 서버 주소로만 쓴다
BROWSER_TOOLSET = "browser"
CONNECTIONS_TOOLSET = "connections"                               # manage_connections. 링크·동의 창이 AAS 화면에 오지 않고 몇 분 멈춘다(12-8)
DOCMOST_SKILL = "free/docmost"                                    # 카탈로그 Docmost 설치 때 함께 설치할 스킬(12-8). 없으면 모델이 엉뚱한 도구를 고른다
DOCMOST_READ_TOOLS = ("search_pages", "get_page", "list_pages", "list_child_pages", "get_space", "list_spaces",
                      "get_comments", "search_attachments", "list_workspace_members", "get_current_user")
DOCMOST_WRITE_TOOLS = ("create_page", "update_page", "duplicate_page", "copy_page_to_space", "move_page", "move_page_to_space",
                       "create_space", "update_space", "create_comment", "update_comment")   # 설치 때 고르거나 나중에 켠다(12-6)
OUTLINE = "outline"                                               # 서버 이름. Skill(outline)이 mcp__outline__* 도구 이름으로 가리킨다(스펙 2026-10-23-004)
OUTLINE_KEY = "MCP_OUTLINE_API_KEY"
OUTLINE_URL_FIELD = "OUTLINE_MCP_URL"
OUTLINE_SKILL = "free/outline"
OUTLINE_READ_TOOLS = ("list_documents", "fetch", "list_collections", "list_collection_documents", "list_comments", "list_templates", "list_users")
OUTLINE_WRITE_TOOLS = ("create_document", "update_document", "move_document", "restore_document", "create_collection", "update_collection",
                       "create_comment", "update_comment", "create_attachment")   # delete_document·delete_collection·delete_comment 는 두지 않는다(Q3)
OUTLINE_DELETE_TOOLS = ("delete_document", "delete_collection", "delete_comment")


def foreign_write_blocks() -> list[str]:
    """주인·관리자·팀 관리자가 아닌 사람이 오피스·회의에서 시킨 턴에서 Hermes 가 막을 도구(스펙 2026-10-23-004 15-9).
    그 턴은 주인의 위키 계정으로 쓰면 안 된다. 서버를 다른 이름(예: opsknow-oauth)으로 더해도 막히게 mcp__*__<도구> 패턴으로 준다.
    삭제 도구는 카탈로그가 등록하지 않지만 「원격 주소」로 전부 등록했을 수 있어 같이 넣는다."""
    return [f"mcp__*__{t}" for t in dict.fromkeys(OUTLINE_WRITE_TOOLS + OUTLINE_DELETE_TOOLS + DOCMOST_WRITE_TOOLS)]


def strip_bearer(token: str) -> str:
    """토큰 앞의 `Bearer `(대소문자·공백 수 무시)를 뗀다. 문서 예시의 헤더 값을 통째로 붙여 넣으면 `Bearer Bearer …` 가 되어 401 이 난다(R3)."""
    return BEARER.sub("", token).strip()


def stdio_limit() -> int:
    try:
        return max(1, min(100, int(config.get("AAS_MCP_STDIO_LIMIT", str(STDIO_LIMIT_DEFAULT)))))
    except ValueError:
        return STDIO_LIMIT_DEFAULT


def server_key(name: str) -> str:
    return re.sub(r"[^A-Za-z0-9_]", "_", name.upper()).strip("_")


def _q(value: str) -> str:
    return quote(value, safe="")


def _servers(api: HermesAPI, prof: str | None) -> list[dict]:
    """프로파일의 서버 목록. 읽지 못하면 HermesError — 부르는 쪽은 거절한다(fail-closed)."""
    res = api.call("GET", "/api/mcp/servers", query={"profile": prof})
    rows = res.get("servers") if isinstance(res, dict) else res
    return [r for r in rows or [] if isinstance(r, dict) and r.get("name")]


def _unreadable() -> FileError:
    return FileError(tr("MCP 서버 목록을 읽지 못해 지금은 바꿀 수 없습니다. 잠시 뒤 다시 시도하세요.", "Cannot read the MCP server list now, so nothing can be changed. Try again shortly."),
                     503, reason="list_unreadable")


def check_name(name: str, existing: list[str]) -> str:
    """서버 이름 검사. 통과하면 서버 키를 돌려준다. 거절은 name 칸의 FileError."""
    if not NAME.match(name):
        raise FileError(tr("이름은 영문·숫자·-·_ 로 적고 영문이나 숫자로 시작해야 합니다(41자까지)", "Use letters, digits, - and _, starting with a letter or digit (up to 41 characters)"),
                        400, reason="name_format", field="name")
    key = server_key(name)
    if not key or "__" in key:
        raise FileError(tr("이름에 _ 를 연속해서 쓸 수 없습니다", "The name cannot contain consecutive underscores"), 400, reason="name_format", field="name")
    for other in existing:
        if server_key(other) == key:
            raise FileError(tr(f"이미 같은 이름으로 쓰이는 서버가 있습니다({other})", f"A server with the same name already exists ({other})"), 409, reason="name_exists", field="name")
    return key


def _plain(text: str, field: str) -> None:
    """주소·인자에 비밀 모양 글자가 있으면 거절한다. 비밀은 비밀값(.env)에 넣고 `${이름}` 으로 가리킨다."""
    if mask_line(text) != text:
        raise FileError(tr("주소나 인자에 비밀값처럼 보이는 글자가 있습니다. 비밀값은 비밀값 탭에 넣고 ${이름} 으로 가리키세요.",
                           "The address or arguments contain something that looks like a secret. Put secrets in the Secrets tab and refer to them as ${NAME}."),
                        400, reason="secret_like", field=field)


def _secure_needed(secure: bool) -> None:
    if not secure:
        raise FileError(tr("암호화되지 않은 주소(http, 사내 IP)에서는 비밀값을 다룰 수 없습니다. https 주소나 이 맥의 localhost 에서 여세요.",
                           "Secrets cannot be handled over an unencrypted address (http, internal IP). Open this page over https or on localhost of this Mac."), 403, reason="insecure")


def stdio_enabled(api: HermesAPI, profs: list[str | None]) -> int:
    """파드 전체에서 켜진 stdio 서버 수. 한 프로파일이라도 읽지 못하면 HermesError."""
    return sum(1 for p in profs for r in _servers(api, p) if r.get("transport") == "stdio" and r.get("enabled") is not False)


def limit_error(api: HermesAPI, profs: list[str | None]) -> None:
    try:
        count = stdio_enabled(api, profs)
    except HermesError:
        raise _unreadable() from None
    if count >= stdio_limit():
        raise FileError(tr(f"이 AI 에이전트 작업공간에 켜진 프로그램 실행 MCP 서버가 {count}개입니다. 하나를 끄거나 지우고 다시 추가하세요.",
                           f"This AI Agent Workspace already has {count} program-based MCP servers on. Turn one off or delete it, then add again."), 409, reason="mcp_limit")


def _env_catalog(api: HermesAPI, prof: str | None, owner: bool) -> dict[str, str] | None:
    if not owner:
        return {}
    try:
        return owner_guard.catalog_of(api.call("GET", "/api/env", query={"profile": prof}))
    except HermesError:
        return None


def _env_names_set(api: HermesAPI, prof: str | None) -> set[str]:
    try:
        res = api.call("GET", "/api/env", query={"profile": prof})
    except HermesError:
        return set()
    return set(res) if isinstance(res, dict) else set()


def _put_env(api: HermesAPI, prof: str | None, key: str, value: str) -> None:
    api.call("PUT", "/api/env", {"key": key, "value": value, "profile": prof}, {"profile": prof})


def _clear_env(api: HermesAPI, prof: str | None, keys: list[str]) -> int:
    """지우지 못한 줄 수. 이미 없는 줄(404)은 지운 것으로 본다."""
    left = 0
    for key in keys:
        try:
            api.call("DELETE", "/api/env", {"key": key, "profile": prof}, {"profile": prof})
        except HermesError as exc:
            if exc.code != 404:
                left += 1
    return left


HTTP_STATUS = re.compile(r"\bHTTP (401|403|404)\b")


def explain_test_error(error: str) -> str:
    """연결 시험 오류에 인증 거절·주소 없음이 있으면 알아보기 쉬운 안내를 앞에 붙인다. Hermes 의 원문은 길고 영어다
    (예: 「both Streamable HTTP and SSE transports failed (… HTTP 401 from POST …)」, OKE 2026-10-23 스펙 2026-10-23-004 15절)."""
    m = HTTP_STATUS.search(error or "")
    if not m:
        return error
    if m.group(1) == "404":
        hint = tr("서버가 이 주소에서 MCP 를 찾지 못했습니다(HTTP 404). 주소가 …/mcp 인지, 서버 쪽에서 MCP 가 켜져 있는지 확인하세요.",
                  "The server found no MCP at this address (HTTP 404). Check that the address ends with …/mcp and that MCP is turned on at the server.")
    else:
        hint = tr(f"서버가 인증을 거절했습니다(HTTP {m.group(1)}). 키가 맞는지, 만료·폐기되지 않았는지 확인하고 비밀값 탭에서 바꾸세요.",
                  f"The server rejected the credentials (HTTP {m.group(1)}). Check that the key is correct and not expired or revoked, and change it in the Secrets tab.")
    return f"{hint} — {error}"


def _message(exc: HermesError) -> HermesError:
    """Hermes 거절을 일상어로(스펙 R7): 상태 코드 먼저, 400 만 안전 검사 문구로 세분, 그 밖은 가려진 원문."""
    raw = redact(str(exc), 300)
    if exc.reason == "timeout":
        return HermesError(tr("Hermes 가 시간 안에 답하지 않았습니다. 서버 목록에서 저장됐는지 확인하세요.", "Hermes did not answer in time. Check the server list to see whether it was saved."), 504, "timeout")
    if exc.code == 409:
        return HermesError(tr("이미 같은 이름의 서버가 있습니다", "A server with that name already exists"), 409, "name_exists")
    if exc.code == 404:
        return HermesError(tr("없는 서버입니다", "That server does not exist"), 404, "not_found")
    if exc.code == 503:
        return HermesError(tr("Hermes 에 연결할 수 없습니다. 잠시 뒤 다시 시도하세요.", "Cannot reach Hermes. Try again shortly."), 503, "hermes_down")
    if exc.code == 400:
        if "suspicious" in raw or "rejected" in raw:
            return HermesError(tr("안전 검사에서 거절됐습니다(셸에서 외부로 내보내는 명령 등). 실행 파일과 인자를 확인하세요.", "Rejected by the safety check (for example a shell command that sends data out). Check the command and arguments."), 400, "unsafe")
        return HermesError(tr(f"입력이 맞지 않습니다: {raw}", f"The input is not valid: {raw}"), 400, "bad_input")
    return HermesError(tr(f"Hermes 가 요청을 처리하지 못했습니다: {raw}", f"Hermes could not process the request: {raw}"), 502, "hermes_error")


def _saved(api: HermesAPI, prof: str | None, name: str) -> bool | None:
    """Hermes 에 그 이름의 서버가 있는가. 읽지 못하면 None."""
    try:
        return any(r["name"] == name for r in _servers(api, prof))
    except HermesError:
        return None


def _add_body(body: dict) -> tuple[str, dict]:
    """(방식, Hermes 본문 재료). 방식은 url·stdio."""
    kind = str(body.get("kind") or "")
    if kind == "url":
        url = str(body.get("url") or "").strip()
        parts = urlsplit(url)
        if parts.scheme not in ("http", "https") or not parts.netloc or len(url) > 500:
            raise FileError(tr("주소는 http:// 나 https:// 로 시작해야 합니다", "The address must start with http:// or https://"), 400, reason="url_format", field="url")
        _plain(url, "url")
        auth = str(body.get("auth") or "none")
        if auth not in ("none", "header", "oauth"):                 # oauth: 추가한 뒤 「로그인」으로 토큰을 받는다(스펙 2026-10-16-010 T5·V9)
            raise FileError(tr("인증은 없음·토큰·OAuth 중에서 고릅니다", "Authentication must be none, a token or OAuth"), 400, reason="auth_format", field="auth")
        token = body.get("bearer_token")
        token = strip_bearer(token) if isinstance(token, str) else token
        if auth == "header" and (not isinstance(token, str) or not 0 < len(token) <= 4000 or any(c in token for c in "\r\n\x00")):
            raise FileError(tr("토큰이 비었거나 줄바꿈이 들어 있습니다", "The token is empty or contains a line break"), 400, reason="token_format", field="bearer_token")
        client = {}
        if auth == "oauth":                                          # 미리 등록한 클라이언트(스펙 2026-10-16-010 V7). 동적 등록을 받지 않는 인가 서버용
            raw = body.get("oauth_client") or {}
            if not isinstance(raw, dict):
                raise FileError(tr("클라이언트 정보 모양이 맞지 않습니다", "The client details are malformed"), 400, reason="client_format", field="oauth_client")
            for k in ("client_id", "client_secret", "scope"):
                v = raw.get(k)
                if v in (None, ""):
                    continue
                if not isinstance(v, str) or not 0 < len(v.strip()) <= (1000 if k == "scope" else 500) or any(c in v for c in "\r\n\x00"):
                    raise FileError(tr(f"{k} 가 비었거나 줄바꿈이 들어 있습니다", f"{k} is empty or contains a line break"), 400, reason="client_format", field=k)
                client[k] = v.strip()
            if client.get("client_secret") and not client.get("client_id"):
                raise FileError(tr("client_secret 을 넣으려면 client_id 도 넣어야 합니다", "Enter client_id together with client_secret"), 400, reason="client_format", field="client_id")
        return "url", {"url": url, "auth": auth, "bearer_token": token if auth == "header" else None, "client": client}
    if kind == "stdio":
        command = str(body.get("command") or "").strip()
        if not command or len(command) > 200 or any(c in command for c in " \t\r\n\x00"):
            raise FileError(tr("실행 파일 이름을 적으세요(공백 없이, 예: npx, uvx)", "Enter the executable name (no spaces, e.g. npx, uvx)"), 400, reason="command_format", field="command")
        args = body.get("args") or []
        if not isinstance(args, list) or len(args) > 40 or any(not isinstance(a, str) or len(a) > 500 or any(c in a for c in "\r\n\x00") for a in args):
            raise FileError(tr("인자는 줄바꿈 없는 글자 40개 이하여야 합니다", "Arguments must be up to 40 strings without line breaks"), 400, reason="args_format", field="args")
        _plain(" ".join([command] + args), "args")
        env = body.get("env") or {}
        if not isinstance(env, dict) or len(env) > 20:
            raise FileError(tr("환경변수는 20개까지입니다", "Up to 20 environment variables"), 400, reason="env_format", field="env")
        for k, v in env.items():
            if not isinstance(k, str) or not ENV_NAME.match(k) or len(k) > 64:
                raise FileError(tr(f"환경변수 이름은 영문 대문자·숫자·_ 로 적습니다(연속·앞뒤 _ 없이): {str(k)[:40]}", f"Environment variable names use uppercase letters, digits and _ (no leading, trailing or repeated _): {str(k)[:40]}"), 400, reason="env_name", field="env")
            if not isinstance(v, str) or not 0 < len(v) <= 4000 or any(c in v for c in "\r\n\x00"):
                raise FileError(tr(f"{k} 의 값이 비었거나 줄바꿈이 들어 있습니다", f"The value of {k} is empty or contains a line break"), 400, reason="env_value", field="env")
        return "stdio", {"command": command, "args": args, "env": dict(env)}
    raise FileError(tr("추가 방식은 원격 주소나 프로그램 실행입니다", "Choose remote address or program"), 400, reason="kind", field="kind")


FORCED_SCHEMA = ("CREATE TABLE IF NOT EXISTS mcp_forced (pod TEXT NOT NULL, profile TEXT NOT NULL, server TEXT NOT NULL, "
                 "by_who TEXT, at REAL NOT NULL, reason TEXT, PRIMARY KEY (pod, profile, server))")


def _forced_exec(sql: str, args: tuple) -> list[dict]:
    with store.connect() as conn:
        conn.execute(FORCED_SCHEMA)
        cur = conn.execute(sql, args)
        return [dict(r) for r in cur] if sql.lstrip().upper().startswith("SELECT") else []


def note_forced(pod: str, profile: str, server: str, by: str, reason: str) -> None:
    """관리자가 「쓸 수 없음」 판정을 무시하고 추가한 서버(스펙 2026-10-16-010 V16). 행 설명에 「판정과 다르게 추가함」을 보인다."""
    _forced_exec("DELETE FROM mcp_forced WHERE pod=? AND profile=? AND server=?", (pod, profile, server))
    _forced_exec("INSERT INTO mcp_forced (pod, profile, server, by_who, at, reason) VALUES (?,?,?,?,?,?)",
                 (pod, profile, server, by, time.time(), reason[:60]))


def forget_forced(pod: str, profile: str, server: str) -> None:
    _forced_exec("DELETE FROM mcp_forced WHERE pod=? AND profile=? AND server=?", (pod, profile, server))


def forced_servers(pod: str, profile: str) -> dict[str, dict]:
    """{서버: {by_who, at, reason}}"""
    rows = _forced_exec("SELECT server, by_who, at, reason FROM mcp_forced WHERE pod=? AND profile=?", (pod, profile))
    return {r["server"]: {"by_who": r["by_who"], "at": r["at"], "reason": r["reason"]} for r in rows}


def add(api: HermesAPI, prof: str | None, body: dict, *, owner: bool, secure: bool, profs: list[str | None], pod: str = "", by: str = "",
        profile: str = "", tools_include: list[str] | None = None) -> dict:
    """서버 한 개를 추가한다. 순서: 검사 → 중복·상한 → `.env` 쓰기 → Hermes 추가 → (실패하면) 쓴 줄 정리.
    tools_include(토큰 인증 원격 주소만): Hermes 추가 API 에는 tools 칸이 없어, 추가한 뒤 include 를 쓰면 그 사이 게이트웨이가 모든 도구를
    등록한다(OKE 2026-10-23, 삭제 도구까지 — 스펙 2026-10-23-004 15-3). 그래서 토큰을 Hermes 와 같은 변수(MCP_<키>_API_KEY)로 `.env` 에 먼저 쓰고,
    include 가 든 항목을 지도 전체 쓰기 한 번으로 만든다 — 게이트웨이는 처음부터 고른 도구만 본다."""
    name = str(body.get("server") or "").strip()
    kind, parts = _add_body(body)
    forced_reason = ""
    if kind == "url":                                                # 이 설치에서 쓸 수 없는 주소(스펙 2026-10-16-010 4-7·V16·Q7)
        net = network_mode.check(parts["url"])
        if net["verdict"] == "blocked":
            if not (body.get("force") and not owner):
                raise FileError(net["message"], 403, reason="network_" + net["reason"], field="url")   # 관리자만 「그래도 추가」(force)
            forced_reason = net["reason"]
    try:
        existing = [r["name"] for r in _servers(api, prof)]
    except HermesError:
        raise _unreadable() from None
    key = check_name(name, existing)
    client = parts.get("client") or {}
    wants_secret = bool(parts.get("bearer_token")) or bool(parts.get("env")) or bool(client.get("client_secret"))
    if wants_secret:
        _secure_needed(secure)
    if kind == "stdio":
        limit_error(api, profs)
    refs: dict[str, str] = {}
    written: list[str] = []
    secret_env = dict(parts["env"]) if kind == "stdio" else {}
    if client.get("client_secret"):                                  # 설정에는 ${VAR} 참조만 남긴다(Hermes 가 서버 설정을 보간한다)
        secret_env["CLIENT_SECRET"] = client["client_secret"]
    if secret_env:
        catalog = _env_catalog(api, prof, owner)
        taken = _env_names_set(api, prof)
        for env_name in secret_env:
            var = ""
            for _ in range(5):
                cand = f"MCP_{key}__{env_name}__{secrets.token_hex(2).upper()}"
                if cand not in taken and cand not in written and cand not in refs.values():
                    var = cand
                    break
            if not var:
                raise FileError(tr("변수 이름을 만들지 못했습니다. 다시 시도하세요.", "Could not create a variable name. Try again."), 409, reason="env_collision", field="env")
            if owner:
                why, refused = owner_guard.env_key_check(var, catalog)
                if refused:
                    raise FileError(refused, 403, reason=why, field="env")
            refs[env_name] = var
    atomic = tools_include is not None and kind == "url" and parts["auth"] == "header" and not client
    if atomic:
        refs["__bearer__"] = f"MCP_{key}_API_KEY"                    # Hermes _bearer_auth_headers 와 같은 이름
        secret_env["__bearer__"] = parts["bearer_token"]
    payload: dict = {"name": name, "profile": prof}
    if kind == "url":
        payload.update(url=parts["url"], auth=parts["auth"])
        if parts["bearer_token"]:
            payload["bearer_token"] = parts["bearer_token"]
    else:
        payload.update(command=parts["command"], args=parts["args"], env={k: "${" + v + "}" for k, v in refs.items()})
    try:
        for env_name, var in refs.items():
            _put_env(api, prof, var, secret_env[env_name])
            written.append(var)
        if atomic:
            _create_entry(api, prof, name, {"url": parts["url"], "headers": {"Authorization": "Bearer ${" + refs["__bearer__"] + "}"},
                                            "tools": {"include": list(tools_include)}}, pod=pod, by=by)
        else:
            api.call("POST", "/api/mcp/servers", payload, {"profile": prof})
        if client:                                                   # 추가 API 에 oauth 칸이 없다 — 지도 전체 쓰기로 더한다(13절)
            oauth = {k: v for k, v in client.items() if k != "client_secret"}
            if "CLIENT_SECRET" in refs:
                oauth["client_secret"] = "${" + refs["CLIENT_SECRET"] + "}"

            def build(entry: dict) -> dict:
                entry["oauth"] = {**(entry.get("oauth") or {}), **oauth}
                return entry
            try:
                replace_server(api, prof, name, build, pod=pod, by=by, note="MCP OAuth 클라이언트 정보")   # i18n-ignore: 판 메모
            except (HermesError, FileError) as exc:
                raise HermesError(tr(f"서버는 추가했지만 클라이언트 정보를 저장하지 못했습니다: {exc}", f"The server was added but the client details could not be saved: {exc}"), 502) from None
    except HermesError as exc:
        left = 0
        if exc.code in (400, 404, 409, 422):                       # 분명한 거절 — 쓴 줄을 지운다
            left = _clear_env(api, prof, written)
        elif written:                                                # 시간 초과·5xx — 저장됐는지 보고 없을 때만 지운다
            saved = _saved(api, prof, name)
            if saved is True:
                return {"ok": True, "name": name, "kind": kind, "env_written": len(written), "warn": "slow_save"}
            left = _clear_env(api, prof, written) if saved is False else len(written)
        err = _message(exc)
        if left:
            err = HermesError(str(err) + " " + tr(f"(비밀값 {left}개를 정리하지 못했습니다)", f"({left} secret values could not be cleaned up)"), err.code, err.reason)
        raise err from None
    if forced_reason and pod:
        note_forced(pod, profile, name, by, forced_reason)
    return {"ok": True, "name": name, "kind": kind, "env_written": len(written), **({"forced": True} if forced_reason else {})}


def _refs_of(cfg: object) -> set[str]:
    return set(REF.findall(yaml.safe_dump(cfg, allow_unicode=True))) if cfg else set()


def remove(api: HermesAPI, prof: str | None, name: str, config_text: str, *, pod: str = "", profile: str = "") -> dict:
    """서버를 지우고, 그 서버만 참조하던 `MCP_` 비밀값 줄도 지운다. config_text 는 지우기 전의 config.yaml."""
    try:
        servers = (yaml.safe_load(config_text) or {}).get("mcp_servers") or {}
    except yaml.YAMLError:
        servers = {}
    if not isinstance(servers, dict):
        servers = {}
    mine = _refs_of(servers.get(name))
    others = set().union(*[_refs_of(v) for k, v in servers.items() if k != name]) if len(servers) > 1 else set()
    doomed = sorted(mine - others)
    try:
        api.call("DELETE", f"/api/mcp/servers/{_q(name)}", None, {"profile": prof})
    except HermesError as exc:
        raise _message(exc) from None
    left = _clear_env(api, prof, doomed) if doomed else 0
    if pod:
        forget_forced(pod, profile, name)
    # Outline 을 설치할 때 끈 browser·connections 는 지워도 돌아오지 않는다 — 다시 켜지 않고 알리기만 한다(스펙 2026-10-23-004 R6·D9)
    return {"ok": True, "name": name, "env_cleared": len(doomed) - left, "env_left": left, **({"toolsets_off_notice": True} if name == OUTLINE else {})}


def to_oauth(api: HermesAPI, prof: str | None, name: str, *, pod: str, by: str) -> dict:
    """헤더(토큰) 인증 원격 서버를 OAuth 로 바꾼다(스펙 2026-10-16-010 V15·13절 X1). headers 를 실제로 빼고 auth: oauth 를 넣는다.
    켜짐 여부·도구 선택은 그대로 둔다. 이 서버만 참조하던 MCP_ 비밀값 줄(예: MCP_JIRA_API_KEY)도 지운다. 이어서 로그인해야 한다."""
    before = _raw_servers(api, prof)
    old = before.get(name)
    if not isinstance(old, dict):
        raise FileError(tr("없는 서버입니다", "That server does not exist"), 404, reason="not_found")
    if not old.get("url"):
        raise FileError(tr("원격 주소 MCP 서버만 OAuth 로 바꿉니다", "Only remote-address MCP servers can switch to OAuth"), 400, reason="not_remote")
    if str(old.get("auth") or "").lower() == "oauth":
        return {"ok": True, "name": name, "changed": False, "env_cleared": 0, "env_left": 0}
    mine = _refs_of(old.get("headers"))
    others = set().union(*[_refs_of(v) for k, v in before.items() if k != name]) if len(before) > 1 else set()

    def build(entry: dict) -> dict:
        entry.pop("headers", None)
        entry["auth"] = "oauth"
        return entry
    out = replace_server(api, prof, name, build, pod=pod, by=by, note="헤더 인증을 OAuth 로 바꾸기")   # i18n-ignore: 판 메모
    doomed = sorted(mine - others)
    left = _clear_env(api, prof, doomed) if doomed else 0
    return {**out, "env_cleared": len(doomed) - left, "env_left": left}


_WRITE_LOCKS: dict[str, threading.Lock] = {}
_WRITE_LOCKS_GUARD = threading.Lock()


def _write_lock(pod: str, prof: str | None):
    """(파드, 프로파일)마다 MCP 설정 쓰기를 한 번에 하나만."""
    return key_lock(f"mcp_servers:{pod}:{prof or ''}")


@contextmanager
def key_lock(key: str):
    """키마다 한 번에 하나만. 프로세스 안은 threading 잠금, 복제본 사이는 PostgreSQL advisory 잠금(MCP OAuth 시작도 쓴다).
    같은 스레드에서 같은 키를 겹쳐 잡지 않는다(다시 들어갈 수 없는 잠금이다)."""
    with _WRITE_LOCKS_GUARD:
        local = _WRITE_LOCKS.setdefault(key, threading.Lock())
    with local:
        if db.backend() != "postgres":
            yield
            return
        # 트랜잭션을 열지 않고 전용 연결의 세션 잠금으로 복제본 사이 순서를 맞춘다. 잠금 안에서 Hermes 를 30초씩 기다리는데,
        # 트랜잭션 안이면 「트랜잭션 중 쉼」 한도(스펙 2026-10-24-002 R6)에 걸려 저장이 끊기고, 풀 연결도 붙잡았다(R12, 검토 D2)
        lock_id = int.from_bytes(hashlib.sha1(key.encode()).digest()[:7], "big")
        conn = db.session_connection()
        try:
            conn.execute("SELECT pg_advisory_lock(%s)", (lock_id,))
            try:
                yield
            finally:
                try:
                    conn.execute("SELECT pg_advisory_unlock(%s)", (lock_id,))
                except Exception:                          # 끊긴 연결이면 본문 결과를 덮지 않는다 — 닫으면 잠금이 풀린다(외부 검토 1)
                    pass
        finally:
            conn.close()                                   # 연결이 끊기면 PostgreSQL 이 잠금을 푼다


def _raw_servers(api: HermesAPI, prof: str | None) -> dict:
    """원본 config.yaml 의 mcp_servers(`${VAR}` 참조를 풀지 않은 값, read_raw_config). 읽지 못하면 쓰지 않는다."""
    try:
        res = api.call("GET", "/api/config", query={"profile": prof, "include_defaults": "false"})
    except HermesError:
        raise _unreadable() from None
    servers = res.get("mcp_servers") if isinstance(res, dict) else None
    return copy.deepcopy(servers) if isinstance(servers, dict) else {}


def _create_entry(api: HermesAPI, prof: str | None, name: str, entry: dict, *, pod: str, by: str) -> None:
    """없는 서버 항목 하나를 지도 전체 쓰기로 만든다(add 의 tools_include). replace_server 와 같은 잠금과 버전 기록."""
    with _write_lock(pod, prof):
        try:                                                         # 읽지 못하면 HermesError 로 — add 가 쓴 키 줄을 정리한다
            servers = _raw_servers(api, prof)
        except FileError as exc:
            raise HermesError(str(exc), 502) from None
        if name in servers:
            raise HermesError(tr(f"이미 있는 서버입니다: {name}", f"That server already exists: {name}"), 409)
        api.call("PUT", "/api/mcp/servers", {"servers": {**servers, name: entry}, "profile": prof}, {"profile": prof})
        files.remember_version(pod, f"mcp_servers:{prof or ''}", json.dumps(servers, ensure_ascii=False, indent=2, sort_keys=True), by,
                               "MCP 서버 추가 전")                   # i18n-ignore: DB 에 저장하는 판 메모


def replace_server(api: HermesAPI, prof: str | None, name: str, build, *, pod: str, by: str, note: str = "") -> dict:
    """서버 항목 하나를 새로 만들어 mcp_servers 지도 전체를 PUT /api/mcp/servers 로 쓴다(스펙 2026-10-16-010 4-2·13절 X1).
    build(항목 사본) 이 새 항목을 돌려준다 — 지울 키는 실제로 뺀다(PUT /api/config 의 깊은 병합은 키를 지우지 못하고 null 은 null 로 남는다).
    순서: 잠금 → 원본 읽기 → 새 항목 → 쓰기 직전 다시 읽기(바뀌었으면 409) → 이전 지도를 판으로 → 쓰기. Hermes 가 모든 항목을 다시 검사한다."""
    with _write_lock(pod, prof):
        servers = _raw_servers(api, prof)
        if not isinstance(servers.get(name), dict):
            raise FileError(tr("없는 서버입니다", "That server does not exist"), 404, reason="not_found")
        entry = build(copy.deepcopy(servers[name]))
        if not isinstance(entry, dict):
            raise FileError(tr("서버 설정을 만들지 못했습니다", "Could not build the server configuration"), 500, reason="build")
        if entry == servers[name]:
            return {"ok": True, "name": name, "changed": False, "version": None}
        if _raw_servers(api, prof) != servers:
            raise FileError(tr("그사이 MCP 서버 설정이 바뀌었습니다. 목록을 다시 읽고 시도하세요.", "The MCP server settings changed in the meantime. Reload the list and try again."),
                            409, reason="changed")
        new_map = {k: (entry if k == name else v) for k, v in servers.items()}
        try:
            api.call("PUT", "/api/mcp/servers", {"servers": new_map, "profile": prof}, {"profile": prof})
        except HermesError as exc:
            raise _message(exc) from None
        before = json.dumps(servers, ensure_ascii=False, indent=2, sort_keys=True)
        version = files.remember_version(pod, f"mcp_servers:{prof or ''}", before, by, note or "MCP 서버 설정 바꾸기 전")  # i18n-ignore: DB 에 저장하는 판 메모
    return {"ok": True, "name": name, "changed": True, "version": version}


def catalog(api: HermesAPI, prof: str | None) -> dict:
    """카탈로그를 화면에 낼 만큼만. 인증 방식을 모르는 항목·git 설치가 필요한 항목은 숨기고 개수만 알린다.
    OAuth 항목은 원격 주소(http)만 보인다 — AAS 가 로그인을 중개한다(스펙 2026-10-16-010 Q5). stdio OAuth(공급자 계정 로그인)는 숨긴다."""
    try:
        res = api.call("GET", "/api/mcp/catalog", query={"profile": prof})
    except HermesError as exc:
        raise _message(exc) from None
    rows = [r for r in (res.get("entries") if isinstance(res, dict) else []) or [] if isinstance(r, dict) and r.get("name")]
    shown, hidden = [], {"oauth": 0, "install": 0, "unknown": 0}
    for r in rows:
        auth = r.get("auth_type")
        remote_oauth = auth == "oauth" and r.get("transport") == "http" and bool(r.get("url")) and r.get("needs_install") is False
        if auth == "oauth" and not remote_oauth:
            hidden["oauth"] += 1
        elif auth not in ("none", "api_key", "oauth"):
            hidden["unknown"] += 1
        elif r.get("needs_install") is not False:
            hidden["install"] += 1
        else:
            shown.append({"name": r["name"], "description": str(r.get("description") or "")[:300], "transport": r.get("transport") or "",
                          "auth_type": auth, "installed": bool(r.get("installed")), "enabled": bool(r.get("enabled")),
                          "required_env": [{"name": str(e.get("name")), "prompt": str(e.get("prompt") or "")[:200], "required": e.get("required") is not False}
                                           for e in r.get("required_env") or [] if isinstance(e, dict) and e.get("name")],
                          **({"url": str(r["url"])[:500], "network": network_mode.check(str(r["url"]))} if r.get("url") else {})})
    # 쓸 수 없는 주소(에어갭 등)는 목록 끝으로 — 쓸 수 있는 항목이 묻히지 않게(14-10). 같은 무리 안의 순서는 그대로
    shown.sort(key=lambda e: (e.get("network") or {}).get("verdict") == "blocked")
    own = [_docmost_entry(api, prof), _outline_entry(api, prof)]
    shown = own + [e for e in shown if e["name"] not in (DOCMOST, OUTLINE)]
    return {"entries": shown, "hidden": hidden}


def docmost_url() -> str:
    """주소 칸을 미리 채울 값(설치 값). 없어도 항목은 보인다 — 사용자가 주소를 넣는다(스펙 2026-10-23-002 12-6)."""
    return config.get("AAS_DOCMOST_MCP_URL", "").strip()


def _docmost_entry(api: HermesAPI, prof: str | None) -> dict:
    """AAS 가 만든 Docmost 항목(스펙 2026-10-23-002 R6·12-6). 주소(가리지 않음)와 키(가림)를 받는다. 설치돼 있으면 쓰기 도구가 켜졌는지도 알린다."""
    try:
        installed = any(r["name"] == DOCMOST for r in _servers(api, prof))
    except HermesError:
        installed = False
    mine = None
    if installed:                                                    # 쓰기 도구 상태는 설치돼 있을 때만 원본 설정에서 읽는다
        try:
            raw = _raw_servers(api, prof).get(DOCMOST)
        except FileError:
            raw = None
        mine = raw if isinstance(raw, dict) else {}
    include = ((mine or {}).get("tools") or {}).get("include") if isinstance((mine or {}).get("tools"), dict) else None
    write = bool(include) and all(t in include for t in DOCMOST_WRITE_TOOLS)
    return {"name": DOCMOST, "transport": "http", "auth_type": "api_key", "installed": installed, "enabled": installed,
            "builtin": True, "write": write,
            "description": tr("Docmost 위키. 내 API 키로 연결하고 기본은 읽기 도구만 등록합니다. 이 프로파일의 브라우저·외부 연결 도구는 끕니다.",
                              "Docmost wiki. Connects with your own API key and registers read tools by default. Turns off this profile's browser and connections tools."),
            "required_env": [{"name": DOCMOST_URL_FIELD, "required": True, "secret": False, "value": docmost_url()[:500],
                              "prompt": tr("Docmost 의 MCP 주소(예: https://wiki.example.com/mcp)", "Docmost MCP address (e.g. https://wiki.example.com/mcp)")},
                             {"name": DOCMOST_KEY, "required": True, "secret": True,
                              "prompt": tr("Docmost 설정 > API keys 에서 만든 키", "The key created in Docmost Settings > API keys")}]}


_PROBE_BODY = json.dumps({"jsonrpc": "2.0", "id": 1, "method": "initialize",
                          "params": {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "aas", "version": "1"}}}).encode()


def _docmost_probe(url: str, key: str) -> int:
    """키를 붙여 POST initialize 를 한 번 보내고 HTTP 상태를 돌려준다. 닿지 않으면 0. 설치 값 주소(관리자가 정함)에만 부른다 — 사용자가 적은 주소로
    AAS 서버가 요청하면 서버를 거쳐 내부망을 찌를 수 있다."""
    import ssl
    import urllib.error
    import urllib.request
    req = urllib.request.Request(url, data=_PROBE_BODY, method="POST", headers={
        "Authorization": f"Bearer {key}", "Content-Type": "application/json", "Accept": "application/json, text/event-stream"})
    try:
        with urllib.request.urlopen(req, timeout=10, context=ssl.create_default_context()) as resp:
            return int(resp.status)
    except urllib.error.HTTPError as exc:
        return int(exc.code)
    except (OSError, ValueError):
        return 0


def _docmost_tools(write: bool) -> list[str]:
    return list(DOCMOST_READ_TOOLS + (DOCMOST_WRITE_TOOLS if write else ()))


def _set_docmost_include(api: HermesAPI, prof: str | None, write: bool, *, pod: str, by: str) -> None:
    def build(item: dict) -> dict:
        item["tools"] = {**(item.get("tools") if isinstance(item.get("tools"), dict) else {}), "include": _docmost_tools(write)}
        return item
    replace_server(api, prof, DOCMOST, build, pod=pod, by=by, note="Docmost 도구 범위 바꾸기")   # i18n-ignore: 판 메모


def set_docmost_write(api: HermesAPI, prof: str | None, write: bool, *, pod: str, by: str) -> dict:
    """설치한 Docmost 서버의 쓰기 도구를 켜고 끈다(스펙 2026-10-23-002 12-6). 새 대화부터 바뀐다."""
    _set_docmost_include(api, prof, write, pod=pod, by=by)
    return {"ok": True, "name": DOCMOST, "write": write}


def _install_docmost(api: HermesAPI, prof: str | None, env: dict, write: bool, *, owner: bool, secure: bool, profs: list[str | None], pod: str, by: str,
                     profile: str) -> dict:
    """원격 주소 + 토큰으로 추가하고 tools.include 를 채운 뒤 브라우저 도구 묶음을 끈다. 주소·토큰 검사·.env 쓰기·롤백은 add 가 한다."""
    url = str(env.get(DOCMOST_URL_FIELD) or "").strip()
    key = str(env.get(DOCMOST_KEY) or "")
    if not url or not strip_bearer(key):
        raise FileError(tr("필요한 환경변수를 모두 넣으세요", "Fill in all required variables"), 400, reason="env_missing", field="env")
    if urlsplit(url).scheme not in ("http", "https"):
        raise FileError(tr("주소는 http:// 나 https:// 로 시작해야 합니다", "The address must start with http:// or https://"), 400, reason="url_format", field="url")
    _secure_needed(secure)
    if url == docmost_url():                                         # 관리자가 정한 주소만 서버에서 미리 묻는다
        status = _docmost_probe(url, strip_bearer(key))
        if status in (401, 403):                                     # Hermes 는 이 경우 GET 의 웹 화면(text/html)으로 「웹 페이지 주소」 오류를 낸다
            raise FileError(tr(f"Docmost 가 키를 거절했습니다(HTTP {status}). 키를 빠짐없이 복사했는지, 만료·폐기되지 않았는지 확인하세요. "
                               "Docmost 관리자가 설정 > AI settings > MCP 에서 「Enforce OAuth」를 켰으면 API 키로는 연결할 수 없습니다.",
                               f"Docmost rejected the key (HTTP {status}). Check that the whole key was copied and that it is not expired or revoked. "
                               "If a Docmost admin turned on \"Enforce OAuth\" in Settings > AI settings > MCP, API keys cannot connect."),
                            400, reason="docmost_key_rejected", field="env")
    try:
        out = add(api, prof, {"server": DOCMOST, "kind": "url", "url": url, "auth": "header", "bearer_token": key},
                  owner=owner, secure=secure, profs=profs, pod=pod, by=by, profile=profile)
    except HermesError as exc:
        if "not an MCP response" in str(exc):                        # Docmost 는 /mcp 의 GET 에 웹 화면을 준다 — 키를 붙인 POST 가 실패했다는 뜻이다(12-2a)
            raise FileError(tr("Docmost 가 MCP 로 답하지 않았습니다. 주소가 …/mcp 로 끝나는지 확인하세요. 주소가 맞으면 키가 거절된 것입니다 — "
                               "키가 맞는지, 만료·폐기되지 않았는지, Docmost 관리자가 「Enforce OAuth」를 켜지 않았는지 확인하세요.",
                               "Docmost did not answer as MCP. Check that the address ends with …/mcp. If it does, the key was rejected: check that it is correct, "
                               "not expired or revoked, and that a Docmost admin did not turn on \"Enforce OAuth\"."),
                            400, reason="docmost_not_mcp", field="env") from None
        raise
    try:
        _set_docmost_include(api, prof, write, pod=pod, by=by)
    except (HermesError, FileError) as exc:
        raise HermesError(tr(f"서버는 추가했지만 도구 범위를 정하지 못했습니다. 설정 탭에서 tools.include 를 확인하세요: {exc}",
                             f"The server was added but its tool list could not be set. Check tools.include in the config tab: {exc}"), 502) from None
    off = {}
    # browser: 쓰기 도구가 없을 때 브라우저로 Docmost 웹에 들어가는 우회(12-5). connections: 모델이 Docmost 를 커넥터로 보고
    # manage_connections 를 부르면 AAS 화면에 아무 안내 없이 최대 180초 멈춘다(12-8). AAS 는 MCP 로그인을 자체 화면으로 중개한다
    for toolset in (BROWSER_TOOLSET, CONNECTIONS_TOOLSET):
        try:
            api.call("PUT", f"/api/tools/toolsets/{toolset}", {"enabled": False, "profile": prof}, {"profile": prof})
            off[toolset] = True
        except HermesError:
            off[toolset] = False
    return {**out, "write": write, "browser_off": off[BROWSER_TOOLSET], "connections_off": off[CONNECTIONS_TOOLSET], "skill_package": DOCMOST_SKILL}


def outline_url() -> str:
    """주소 칸을 미리 채울 값(설치 값). 없어도 항목은 보인다(스펙 2026-10-23-004 D2)."""
    return config.get("AAS_OUTLINE_MCP_URL", "").strip()


def _outline_entry(api: HermesAPI, prof: str | None) -> dict:
    """AAS 가 만든 Outline 항목(스펙 2026-10-23-004 4-2). _docmost_entry 와 같은 꼴 — 한쪽을 고치면 다른 쪽도 고친다."""
    try:
        installed = any(r["name"] == OUTLINE for r in _servers(api, prof))
    except HermesError:
        installed = False
    mine = None
    if installed:
        try:
            raw = _raw_servers(api, prof).get(OUTLINE)
        except FileError:
            raw = None
        mine = raw if isinstance(raw, dict) else {}
    include = ((mine or {}).get("tools") or {}).get("include") if isinstance((mine or {}).get("tools"), dict) else None
    write = bool(include) and all(t in include for t in OUTLINE_WRITE_TOOLS)
    return {"name": OUTLINE, "transport": "http", "auth_type": "api_key", "installed": installed, "enabled": installed,
            "builtin": True, "write": write,
            "description": tr("Outline 위키. 내 API 키로 연결하고 기본은 읽기 도구만 등록합니다. 이 프로파일의 브라우저·외부 연결 도구는 끄고 Outline 사용 규칙 스킬을 설치합니다.",
                              "Outline wiki. Connects with your own API key and registers read tools by default. Turns off this profile's browser and connection tools and installs the Outline usage skill."),
            "required_env": [{"name": OUTLINE_URL_FIELD, "required": True, "secret": False, "value": outline_url()[:500],
                              "prompt": tr("Outline 의 MCP 주소(예: https://wiki.example.com/mcp)", "Outline MCP address (e.g. https://wiki.example.com/mcp)")},
                             {"name": OUTLINE_KEY, "required": True, "secret": True,
                              "prompt": tr("Outline 설정 > API 에서 만든 키. 읽기만 쓰려면 키를 만들 때 Scopes 에 read 를 적으세요",
                                           "The key created in Outline Settings > API. To read only, enter read in Scopes when you create the key")}]}


def _outline_tools(write: bool) -> list[str]:
    return list(OUTLINE_READ_TOOLS + (OUTLINE_WRITE_TOOLS if write else ()))


def _set_outline_include(api: HermesAPI, prof: str | None, write: bool, *, pod: str, by: str) -> None:
    def build(item: dict) -> dict:
        item["tools"] = {**(item.get("tools") if isinstance(item.get("tools"), dict) else {}), "include": _outline_tools(write)}
        return item
    replace_server(api, prof, OUTLINE, build, pod=pod, by=by, note="Outline 도구 범위 바꾸기")   # i18n-ignore: 판 메모


def set_outline_write(api: HermesAPI, prof: str | None, write: bool, *, pod: str, by: str) -> dict:
    """설치한 Outline 서버의 쓰기 도구를 켜고 끈다. 게이트웨이는 도구 범위 변경을 스스로 반영하지 않아 「지금 적용」 뒤 새 대화부터 바뀐다(2026-10-23-002 12-7)."""
    _set_outline_include(api, prof, write, pod=pod, by=by)
    return {"ok": True, "name": OUTLINE, "write": write}


def _toolset_off(api: HermesAPI, prof: str | None, name: str) -> bool:
    try:
        api.call("PUT", f"/api/tools/toolsets/{name}", {"enabled": False, "profile": prof}, {"profile": prof})
        return True
    except HermesError:
        return False


def _outline_key_check(api: HermesAPI, prof: str | None) -> None:
    """추가한 직후 사용자의 Hermes 로 연결 시험을 한 번 한다. Hermes 의 추가는 키가 틀려도(401) 저장하고 오류는 나중 연결 시험에서야 보인다
    (OKE 2026-10-23, 스펙 2026-10-23-004 15절). 401·403·404 면 서버와 키 줄을 지우고 거절한다. 시간 초과·그 밖의 결과는 설치를 그대로 둔다.
    요청은 사용자의 Hermes 가 보내므로 AAS 서버가 사용자가 적은 주소로 나가지 않는다."""
    try:
        res = api.call("POST", f"/api/mcp/servers/{_q(OUTLINE)}/test", {}, {"profile": prof}, timeout=TEST_TIMEOUT)
    except HermesError:
        return
    if not isinstance(res, dict) or res.get("ok") or res.get("success"):
        return
    m = HTTP_STATUS.search(str(res.get("error") or ""))
    if not m:
        return
    try:
        api.call("DELETE", f"/api/mcp/servers/{_q(OUTLINE)}", None, {"profile": prof})
        _clear_env(api, prof, [OUTLINE_KEY])
    except HermesError:
        pass                                                         # 지우지 못하면 서버 줄이 남는다 — 아래 거절 문장으로 알리고 사용자가 지운다
    if m.group(1) == "404":
        raise FileError(tr("Outline 에서 MCP 가 꺼져 있거나 주소가 …/mcp 가 아닙니다(HTTP 404). Outline 관리자에게 Settings → Workspace → AI 에서 MCP 를 켜 달라고 하세요. 추가한 서버는 지웠습니다.",
                           "MCP is turned off in Outline, or the address does not end with …/mcp (HTTP 404). Ask an Outline admin to turn on MCP in Settings → Workspace → AI. The added server was removed."),
                        400, reason="outline_mcp_off", field="env")
    raise FileError(tr(f"Outline 이 키를 거절했습니다(HTTP {m.group(1)}). 키를 빠짐없이 복사했는지, 만료·폐기되지 않았는지 확인하세요. 추가한 서버는 지웠습니다.",
                       f"Outline rejected the key (HTTP {m.group(1)}). Check that the whole key was copied and that it is not expired or revoked. The added server was removed."),
                    400, reason="outline_key_rejected", field="env")


def _install_outline(api: HermesAPI, prof: str | None, env: dict, write: bool, *, owner: bool, secure: bool, profs: list[str | None], pod: str, by: str,
                     profile: str) -> dict:
    """_install_docmost 와 같은 순서(스펙 2026-10-23-004 4-2). 다른 점: 404(MCP 꺼짐) 안내, connections 묶음도 끔, 삭제 도구 없음."""
    url = str(env.get(OUTLINE_URL_FIELD) or "").strip()
    key = str(env.get(OUTLINE_KEY) or "")
    if not url or not strip_bearer(key):
        raise FileError(tr("필요한 환경변수를 모두 넣으세요", "Fill in all required variables"), 400, reason="env_missing", field="env")
    if urlsplit(url).scheme not in ("http", "https"):
        raise FileError(tr("주소는 http:// 나 https:// 로 시작해야 합니다", "The address must start with http:// or https://"), 400, reason="url_format", field="url")
    _secure_needed(secure)
    if url == outline_url():                                         # 관리자가 정한 주소만 서버에서 미리 묻는다(Docmost 와 같은 이유)
        status = _docmost_probe(url, strip_bearer(key))              # 같은 POST initialize 묻기
        if status in (401, 403):
            raise FileError(tr(f"Outline 이 키를 거절했습니다(HTTP {status}). 키를 빠짐없이 복사했는지, 만료·폐기되지 않았는지 확인하세요.",
                               f"Outline rejected the key (HTTP {status}). Check that the whole key was copied and that it is not expired or revoked."),
                            400, reason="outline_key_rejected", field="env")
        if status == 404:                                            # MCP 를 끈 워크스페이스는 401 이 아니라 404 를 준다(Outline server/routes/mcp/index.ts, R2)
            raise FileError(tr("Outline 에서 MCP 가 꺼져 있거나 주소가 …/mcp 가 아닙니다. Outline 관리자에게 Settings → Workspace → AI 에서 MCP 를 켜 달라고 하세요.",
                               "MCP is turned off in Outline, or the address does not end with …/mcp. Ask an Outline admin to turn on MCP in Settings → Workspace → AI."),
                            400, reason="outline_mcp_off", field="env")
    # include 를 넣은 채로 만든다 — 추가 뒤에 쓰면 그 사이 게이트웨이가 삭제 도구까지 모두 등록한다(15-3)
    out = add(api, prof, {"server": OUTLINE, "kind": "url", "url": url, "auth": "header", "bearer_token": key},
              owner=owner, secure=secure, profs=profs, pod=pod, by=by, profile=profile, tools_include=_outline_tools(write))
    _outline_key_check(api, prof)
    return {**out, "write": write, "browser_off": _toolset_off(api, prof, BROWSER_TOOLSET),     # 쓰기 도구가 없을 때 브라우저로 위키 웹에 들어가는 우회(12-5)
            "connections_off": _toolset_off(api, prof, CONNECTIONS_TOOLSET), "skill_package": OUTLINE_SKILL}


def install(api: HermesAPI, prof: str | None, body: dict, *, owner: bool, secure: bool, profs: list[str | None], pod: str = "", by: str = "",
            profile: str = "") -> dict:
    """카탈로그 항목을 설치한다. 보이는 항목만, 항목이 선언한 환경변수 이름만 받는다."""
    name = str(body.get("server") or "").strip()
    entry = next((e for e in catalog(api, prof)["entries"] if e["name"] == name), None)
    if entry is None:
        raise FileError(tr("설치할 수 없는 항목입니다(OAuth·git 설치·알 수 없는 인증 방식은 이 화면에서 지원하지 않습니다)", "That entry cannot be installed here (OAuth, git installs and unknown authentication are not supported)"), 400, reason="catalog_hidden", field="name")
    net = entry.get("network")
    if net and net["verdict"] == "blocked":                          # 이 설치에서 닿지 않는 주소(4-7). 카탈로그에는 「그래도 추가」가 없다
        raise FileError(net["message"], 403, reason="network_" + net["reason"], field="name")
    env = body.get("env") or {}
    if entry.get("builtin"):                                         # AAS 가 만든 항목(Docmost·Outline) — Hermes 카탈로그 설치로 보내지 않는다
        allowed = {OUTLINE_KEY, OUTLINE_URL_FIELD} if name == OUTLINE else {DOCMOST_KEY, DOCMOST_URL_FIELD}
        if not isinstance(env, dict) or set(env) - allowed or any(not isinstance(v, str) or any(c in v for c in "\r\n\x00") for v in env.values()):
            raise FileError(tr("항목이 선언한 환경변수만 넣을 수 있고, 값에는 줄바꿈이 없어야 합니다", "Only the variables the entry declares can be set, and values cannot contain a line break"), 400, reason="env_undeclared", field="env")
        if entry["installed"]:
            raise FileError(tr("이미 추가한 서버입니다. 키는 비밀값 탭에서 바꿉니다.", "That server is already added. Change the key in the Secrets tab."), 409, reason="name_exists", field="name")
        installer = _install_outline if name == OUTLINE else _install_docmost
        return installer(api, prof, env, bool(body.get("write")), owner=owner, secure=secure, profs=profs, pod=pod, by=by, profile=profile)
    declared = {e["name"] for e in entry["required_env"]}
    if not isinstance(env, dict) or set(env) - declared or any(not isinstance(v, str) or any(c in v for c in "\r\n\x00") or len(v) > 4000 for v in env.values()):
        raise FileError(tr("항목이 선언한 환경변수만 넣을 수 있고, 값에는 줄바꿈이 없어야 합니다", "Only the variables the entry declares can be set, and values cannot contain a line break"), 400, reason="env_undeclared", field="env")
    env = {k: v for k, v in env.items() if v}
    if any(e["required"] and e["name"] not in env for e in entry["required_env"]) and not entry["installed"]:
        raise FileError(tr("필요한 환경변수를 모두 넣으세요", "Fill in all required variables"), 400, reason="env_missing", field="env")
    if env:
        _secure_needed(secure)
        if owner:
            catalog_env = _env_catalog(api, prof, True)
            for k in env:
                why, refused = owner_guard.env_key_check(k, catalog_env)
                if refused:
                    raise FileError(refused, 403, reason=why, field="env")
    enable = body.get("enable") is not False
    if enable and entry["transport"] == "stdio":
        limit_error(api, profs)
    try:
        api.call("POST", "/api/mcp/catalog/install", {"name": name, "env": env, "enable": enable, "profile": prof}, {"profile": prof})
    except HermesError as exc:
        raise _message(exc) from None
    return {"ok": True, "name": name, "env_written": len(env)}


def enable_error(api: HermesAPI, prof: str | None, name: str, profs: list[str | None]) -> None:
    """서버를 켜기 전 검사: stdio 서버를 켜서 상한을 넘기는가. 서버 종류를 읽지 못하면 거절한다."""
    try:
        row = next((r for r in _servers(api, prof) if r["name"] == name), None)
    except HermesError:
        raise _unreadable() from None
    if row is not None and row.get("transport") == "stdio" and row.get("enabled") is False:
        limit_error(api, profs)

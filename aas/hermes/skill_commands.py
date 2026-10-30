# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""채팅 입력창의 「/스킬」(스펙 2026-10-19-012).

Hermes 의 prompt.submit 은 「/스킬」을 명령으로 읽지 않는다. 같은 대시보드 WS 의 commands.catalog(스킬 목록)와
command.dispatch(SKILL.md 본문을 붙인 메시지)를 써서 AAS 가 보내기 직전에 펼친다(R1). Hermes 는 고치지 않는다.

- command.dispatch 는 quick → plugin → bundle → skill 순서로 처리하고, 빠른 명령(quick_commands, type exec)은 셸을 돈다.
  그래서 catalog 의 빠른·플러그인 명령 분류에 있는 이름과 같은 스킬은 목록에서 빼고 펼치지 않는다(R2).
- 화면 목록은 60초 저장값을 쓰지만, 보낼 때는 그 세션 기준으로 새로 읽는다. 못 읽으면 펼치지 않는다(R9, 닫힌 쪽으로 실패).
- 목록은 5초, 펼치기는 15초 제한(R5·R10). 넘으면 글만 보낸다.
"""
from __future__ import annotations

import re
import threading
import time

from . import chat_commands

CATALOG_TIMEOUT = 5.0
DISPATCH_TIMEOUT = 15.0
LIST_TTL = 60.0
DESC_MAX = 160

_cache: dict[tuple[int, str], tuple[float, dict]] = {}
_cache_lock = threading.Lock()


def parse(result) -> dict:
    """commands.catalog 응답에서 스킬과 허용 명령을 고른다. {skills: [...], blocked: [이름이 겹쳐 뺀 "/키"],
    commands: [쓸 수 있는 내장 명령 이름], commands_blocked: [빠른·플러그인 명령과 이름이 겹친 "/명령"]}(스펙 2026-10-26-010 R9).
    스킬 항목은 분류(categories)에 들어가지 않고 pairs 끝에 붙는다. 분류에 들어 있는 이름(내장·빠른·플러그인 명령)과 같은 스킬은 뺀다."""
    result = result if isinstance(result, dict) else {}
    skills = result.get("skills") if isinstance(result.get("skills"), dict) else {}
    taken = set()
    for cat in result.get("categories") or []:
        for pair in (cat.get("pairs") if isinstance(cat, dict) else None) or []:
            if isinstance(pair, (list, tuple)) and pair:
                taken.add(str(pair[0]).lower())
    desc: dict[str, str] = {}
    for pair in result.get("pairs") or []:
        if isinstance(pair, (list, tuple)) and len(pair) >= 2:
            desc[str(pair[0])] = str(pair[1] or "")
    rows, blocked = [], []
    for key, meta in skills.items():
        key = str(key)
        if not key.startswith("/") or len(key) < 2:
            continue
        if key.lower() in taken:
            blocked.append(key)
            continue
        meta = meta if isinstance(meta, dict) else {}
        try:
            usage = int(meta.get("usage") or 0)
        except (TypeError, ValueError):
            usage = 0
        rows.append({"command": key, "name": key[1:], "description": desc.get(key, "")[:DESC_MAX], "usage": usage,
                     "description_full": desc.get(key, "")})      # 번역 키용 자르기 전 설명. 응답에서는 skill_desc.apply 가 뺀다(스펙 2026-10-19-017 P5)
    rows.sort(key=lambda r: (-r["usage"], r["name"].lower()))
    cmds = chat_commands.pick(result)
    return {"skills": rows, "blocked": sorted(blocked), "commands": cmds["commands"], "commands_blocked": cmds["blocked"],
            "known": cmds.get("known") or [], "aliases": cmds.get("aliases") or {}}


def read(hub, profile: str = "", session_id: str = "", timeout: float | None = None) -> dict:
    """그 세션(없으면 그 프로파일) 기준의 스킬·명령 목록. 실패면 {skills: [], blocked: [], commands: [], warning: "unavailable"}.
    세션이 있으면 펼치기와 같은 기준(세션의 cwd)으로 찾는다 — 프로젝트 폴더 스킬이 목록과 펼치기에서 어긋나지 않게(OV-M3).
    세션이 없을 때 cwd 는 넘기지 않는다: commands.catalog 의 인자 계약(CommandsCatalogParams)은 session_id·profile 뿐이라
    cwd 를 넣으면 「Extra inputs are not permitted」로 거절된다(OKE 2026-10-19 화면 확인에서 찾음)."""
    params: dict = {}
    if session_id:
        params["session_id"] = session_id
    elif profile and profile != "default":
        params["profile"] = profile
    try:
        out = parse(hub.request("commands.catalog", params, timeout=CATALOG_TIMEOUT if timeout is None else timeout))
    except Exception:                                   # 연결 실패·시간 초과·모르는 RPC 모두 목록 없음으로
        return {"skills": [], "blocked": [], "commands": [], "commands_blocked": [], "warning": "unavailable"}
    return {**out, "warning": ""}


def cached(hub, profile: str, timeout: float | None = None) -> dict:
    """화면 목록용. 에이전트(hub)·프로파일마다 60초. 실패는 저장하지 않아 다음 요청이 다시 읽는다."""
    key = (id(hub), profile or "default")
    with _cache_lock:
        hit = _cache.get(key)
        if hit and time.time() - hit[0] < LIST_TTL:
            return hit[1]
    out = read(hub, profile=profile, timeout=timeout)
    if not out["warning"]:
        with _cache_lock:
            _cache[key] = (time.time(), out)
    return out


def forget() -> None:
    with _cache_lock:
        _cache.clear()


def strip_token(text: str, skill: str) -> str:
    """사용자가 친 글에서 「/스킬」 낱말 하나를 뺀 나머지(Hermes 로 갈 인자). 화면이 스킬 이름을 따로 보내므로(R7)
    여기서는 이름을 찾아 읽지 않고 그 낱말만 지운다. 글 맨 앞이나 공백 뒤의 첫 낱말이 대상이다(회의실은 앞에 @이름이 올 수 있다)."""
    name = str(skill or "").strip().lstrip("/")
    if not name:
        return text
    out = re.sub(r"(^|\s)/" + re.escape(name) + r"(?=\s|$)[ \t]?", r"\1", text, count=1, flags=re.IGNORECASE)
    return out.strip() if out.strip() else out


def expand(hub, sid: str, skill: str, text: str) -> tuple[str, str]:
    """(Hermes 로 보낼 글, 펼치지 못한 이유). 이유가 "" 이면 스킬 머리말이 맨 앞인 글이다.
    이유: noskill(그 세션에 없음) · collision(다른 명령과 이름이 같음) · error(목록을 못 읽음·다른 결과) · timeout."""
    name = str(skill or "").strip().lstrip("/")
    if not name or any(c.isspace() for c in name):
        return text, "noskill"
    cat = read(hub, session_id=sid)                     # 보낼 때마다 새로 읽는다(R9)
    if cat["warning"]:
        return text, "error"
    key = "/" + name.lower()
    if key in {b.lower() for b in cat["blocked"]}:
        return text, "collision"
    if key not in {r["command"].lower() for r in cat["skills"]}:
        return text, "noskill"
    from .hermes_chat import RequestTimeout             # 순환 import 를 피한다(hermes_chat 이 이 모듈을 부른다)
    try:
        res = hub.request("command.dispatch", {"session_id": sid, "name": name, "arg": text}, timeout=DISPATCH_TIMEOUT)
    except RequestTimeout:
        return text, "timeout"
    except Exception:
        return text, "error"
    if not isinstance(res, dict) or res.get("type") != "skill" or not str(res.get("message") or "").strip():
        return text, "error"
    return str(res["message"]), ""

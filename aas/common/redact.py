# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""저장·표시·발송 전에 통과시키는 마스킹. 토큰·키가 AAS 밖으로 나가지 않게 한다."""
from __future__ import annotations

import re
from pathlib import Path
from urllib.parse import urlsplit
from .i18n import tr

MAX_LEN = 300

_PATTERNS = [
    (re.compile(r"(?i)\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}"), r"\1 ***"),
    (re.compile(r"(?i)\b([a-z0-9_]*(?:token|secret|password|passwd|api[_-]?key|apikey|key))"
                r"(\s*[=:]\s*)(\"[^\"]*\"|'[^']*'|[^\s&,;]+)"), r"\1\2***"),
    (re.compile(r"\b\d{6,}:[A-Za-z0-9_-]{30,}\b"), "***"),          # 텔레그램 봇 토큰 모양
    (re.compile(r"\b(sk|pk|ghp|gho|glpat|glrt|xox[abp])[-_][A-Za-z0-9_-]{16,}\b"), "***"),
    (re.compile(r"\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}\b"), "***"),  # JWT
    (re.compile(r"\b[A-Za-z0-9+/_-]{40,}={0,2}\b"), "***"),          # 긴 불투명 문자열
    # OAuth 콜백 쿼리(상대 경로 /oauth/mcp/callback?code=…&state=…)의 인가 코드·state. ?·& 뒤의 쿼리 값만 가린다 — 「exit code=2」 같은 글은 그대로(스펙 2026-10-16-010 6절)
    (re.compile(r"(?i)([?&](?:code|state)=)[^\s&#]+"), r"\1***"),
]
_URL = re.compile(r"https?://[^\s\"'<>)\]}`]+")


_REDIRECT_PARAM = re.compile(r"(?i)([?&](?:code|state)=)[^\s&#\"'<>)\]}`]+")


def mask_oauth_redirect(text: str) -> str:
    """대화에 붙여넣은 OAuth 리디렉트 주소의 code·state 값을 가린다(스펙 2026-10-16-010 9절 Q4).
    쿼리에 code 와 state 가 함께 있는 주소만 바꾼다 — 「?code=」 하나만 있는 일반 주소·글은 그대로 둔다.
    에이전트에게 가는 원문은 바꾸지 않는다. AAS 가 화면·기록으로 내보낼 때만 쓴다."""
    if not isinstance(text, str) or "code=" not in text.lower():
        return text

    def one(m: re.Match) -> str:
        url = m.group(0)
        low = url.lower()
        if ("?code=" in low or "&code=" in low) and ("?state=" in low or "&state=" in low):
            return _REDIRECT_PARAM.sub(r"\1***", url)
        return url
    return _URL.sub(one, text)


def mask_oauth_redirect_deep(value):
    """dict·list 안의 모든 문자열에 mask_oauth_redirect. 바뀐 것이 없으면 같은 객체를 돌려준다."""
    if isinstance(value, str):
        return mask_oauth_redirect(value)
    if isinstance(value, dict):
        out = {k: mask_oauth_redirect_deep(v) for k, v in value.items()}
        return value if all(out[k] is value[k] for k in value) else out
    if isinstance(value, list):
        out = [mask_oauth_redirect_deep(v) for v in value]
        return value if all(a is b for a, b in zip(out, value)) else out
    return value


def clean_url(url: str) -> str:
    """scheme://host/path 만 남긴다. 쿼리스트링·사용자정보·프래그먼트는 버린다. 비었으면 빈 값(「://」 를 만들지 않는다)."""
    if not str(url or "").strip():
        return ""
    try:
        parts = urlsplit(url)
    except ValueError:
        return tr("(잘못된 URL)", "(invalid URL)")
    host = parts.hostname or ""
    if parts.port:
        host = f"{host}:{parts.port}"
    return f"{parts.scheme}://{host}{parts.path}".rstrip(".,;:")


_SECRET_OPTION = re.compile(r"key|token|secret|password|auth|bearer|credential", re.I)


def mcp_target(url, command, args) -> str:
    """MCP 서버 한 줄 표시(스펙 2026-10-16-002 D6·D7). profiles.mcp_view 와 inventory._mcp 가 함께 쓴다.
    http 서버: scheme://host[:port]/… 만 보인다. 경로·쿼리·사용자정보에 토큰이 들어 있을 수 있어서다(clean_url 은 경로를 남긴다).
    stdio 서버: 명령 이름 + 앞 두 인자. 이름에 key·token·secret·password·auth·bearer·credential 이 든 옵션의 값(--api-key abc, --api-key=abc)은 ***,
    그 밖의 인자는 mask_line 을 거친다. 이름 규칙 밖의 옵션(--pass 등)은 가려지지 않는다. 주소와 명령이 모두 없으면 빈 문자열."""
    if isinstance(url, str) and url.strip():
        try:
            parts = urlsplit(url.strip())
            host, port = parts.hostname or "", parts.port
        except ValueError:
            return tr("(잘못된 URL)", "(invalid URL)")
        if not parts.scheme or not host:
            return tr("(잘못된 URL)", "(invalid URL)")
        if ":" in host:
            host = f"[{host}]"
        return f"{parts.scheme}://{host}{f':{port}' if port else ''}/…"
    cmd = command if isinstance(command, str) else ""
    if not cmd.strip():
        return ""
    from ..assets.files import mask_line          # 지연 import: assets.files 가 common 을 쓴다
    shown, secret_next = [Path(cmd).name], False
    for a in (args if isinstance(args, (list, tuple)) else [])[:2]:
        raw = str(a)
        if secret_next:
            shown.append("***")
            secret_next = False
        elif raw.startswith("-") and "=" in raw:
            name, _, _value = raw.partition("=")
            shown.append(f"{name}=***" if _SECRET_OPTION.search(name) else mask_line(Path(raw).name))
        elif raw.startswith("-") and _SECRET_OPTION.search(raw):
            shown.append(raw)
            secret_next = True
        else:
            shown.append(mask_line(Path(raw).name))
    return " ".join(shown)


def redact(text, limit: int = MAX_LEN) -> str:
    if text is None:
        return ""
    s = str(text)
    s = _URL.sub(lambda m: clean_url(m.group(0)), s)
    for pat, repl in _PATTERNS:
        s = pat.sub(repl, s)
    s = " ".join(s.split())
    if len(s) > limit:
        s = s[: limit - 1] + "…"
    return s

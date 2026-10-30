# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""채널 연결(스펙 2026-10-15-003 단계 2). Hermes 대시보드의 메시징 API 로 보낼 요청을 검사해 만들고, 읽은 결과를 화면에 낼 만큼만 줄인다.

값(봇 토큰 등)은 저장 요청에만 실리고 응답·기록·읽기에는 나오지 않는다. 변수 이름이 그 채널의 것인지는 Hermes(`_check_allowed`)가 가리고,
여기서는 이름 모양과 연결할 수 있는 채널(telegram·discord·slack·mattermost)만 본다. Mattermost 는 스펙 2026-10-19-008.
"""
from __future__ import annotations

import re

from ..common.i18n import tr
from ..common.redact import redact
from ..fleet.profiles import ENV_KEY

PLATFORMS = ("telegram", "discord", "slack", "mattermost")
_BAD_CHARS = "\r\n\x00"


def platform(body: dict) -> str:
    value = str(body.get("platform") or "").lower().strip()
    if value not in PLATFORMS:
        raise ValueError(tr("연결할 수 있는 채널은 Telegram·Discord·Slack·Mattermost 입니다", "Only Telegram, Discord, Slack and Mattermost can be connected here"))
    return value


def save_payload(body: dict) -> dict:
    """PUT /api/messaging/platforms/{id} 의 본문. 비어 있는 값은 건너뛰고(그대로 둔다), 바꿀 것이 없으면 ValueError."""
    env_in, clear_in = body.get("env") or {}, body.get("clear_env") or []
    if not isinstance(env_in, dict) or not isinstance(clear_in, list):
        raise ValueError(tr("요청 모양이 맞지 않습니다", "The request is malformed"))
    env: dict[str, str] = {}
    for key, value in env_in.items():
        if not isinstance(key, str) or not ENV_KEY.match(key) or not isinstance(value, str) or any(c in value for c in _BAD_CHARS) or len(value) > 4000:
            raise ValueError(tr("변수 이름은 영문 대문자·숫자·_ 로 적고, 값에는 줄바꿈이 없어야 합니다", "Variable names use uppercase letters, digits and _, and values cannot contain a line break"))
        if value.strip():
            env[key] = value.strip()
    clear = [str(k) for k in clear_in]
    if any(not ENV_KEY.match(k) for k in clear):
        raise ValueError(tr("지울 변수 이름이 맞지 않습니다", "A variable name to clear is invalid"))
    enabled = body.get("enabled")
    if enabled is not None and not isinstance(enabled, bool):
        raise ValueError(tr("켜기·끄기 값이 맞지 않습니다", "The on/off value is invalid"))
    if not env and not clear and enabled is None:
        raise ValueError(tr("바꿀 내용이 없습니다", "There is nothing to change"))
    payload: dict = {"env": env, "clear_env": clear}
    if enabled is not None:
        payload["enabled"] = enabled
    return payload


# 「연결 시험」 결과 문장: Hermes(d923a5e `hermes_cli/web_routers/messaging.py` test_messaging_platform·_messaging_platform_posture)가
# 영어로만 주는 정해진 문장을 한국어로 바꾼다(2026-10-18, 화면에 영어가 그대로 보였다). 맞는 것이 없으면(메신저가 준 오류 등) 그대로 둔다.
# Hermes 판을 올릴 때 문장이 바뀌면 여기와 tests/test_channel_test_message.py 를 같이 본다.
_KO_TEST = [
    (r"(?P<n>.+) is disabled\. Enable it, then restart the gateway\.",
     lambda g, en: tr(f"{g['n']} 연결이 꺼져 있습니다. 필수 값을 넣고 「저장하고 켜기」를 누르세요.", en)),
    (r"Missing required setup: (?P<k>.+)", lambda g, en: tr(f"필수 값이 비어 있습니다: {g['k']}", en)),
    (r"Platform setup is incomplete\.", lambda g, en: tr("설정이 끝나지 않았습니다.", en)),
    (r"Gateway is not running\. Restart the gateway to connect this platform\.",
     lambda g, en: tr("게이트웨이가 꺼져 있습니다. 개요 탭에서 게이트웨이를 다시 시작하세요.", en)),
    (r"Gateway is open: (?P<e>\S+) is set\.", lambda g, en: tr(f"게이트웨이가 누구에게나 열려 있습니다({g['e']}).", en)),
    (r"(?P<n>.+) is open: (?P<e>\S+) is set\.", lambda g, en: tr(f"{g['n']} 이 누구에게나 열려 있습니다({g['e']}).", en)),
    (r"Connected\. (?P<c>\d+) users? allowlisted via (?P<e>\S+)\.", lambda g, en: tr(f"연결되어 있습니다. 허용 사용자 {g['c']}명({g['e']}).", en)),
    (r"Connected\. Access restricted by the configured allow_from policy\.",
     lambda g, en: tr("연결되어 있습니다. 설정한 allow_from 규칙으로 들어올 사람을 제한합니다.", en)),
    (r"Connected\. (?P<c>\d+) users? paired\.", lambda g, en: tr(f"연결되어 있습니다. 페어링으로 승인한 사용자 {g['c']}명.", en)),
    (r"(?P<n>.+) is connected, but no users are authorized yet — set (?P<e>\S+), approve a pairing request, or enable pairing for new users\."
     r"(?: (?P<p>\d+) pairing requests? pending approval\.)?",
     lambda g, en: tr(f"{g['n']} 에 연결되어 있지만 아직 대화할 수 있는 사용자가 없습니다. {g['e']} 를 넣거나 페어링 요청을 승인하세요."
                      + (f" 승인 대기 {g['p']}건." if g["p"] else ""), en)),
    (r"(?P<n>.+) is connected\.", lambda g, en: tr(f"{g['n']} 에 연결되어 있습니다.", en)),
    (r"Setup looks complete, but the gateway has not reported a connection yet\. Restart the gateway\.",
     lambda g, en: tr("설정은 끝났지만 게이트웨이가 아직 연결을 알리지 않았습니다. 잠시 뒤 다시 시험하고, 그래도 안 되면 게이트웨이를 다시 시작하세요.", en)),
]


def _test_message(message: str) -> str:
    """화면 언어에 맞는 연결 시험 문장. 영어 화면은 Hermes 문장 그대로"""
    for pat, ko in _KO_TEST:
        m = re.fullmatch(pat, message)
        if m:
            return ko({k: v or "" for k, v in m.groupdict().items()}, message)
    return message


def test_view(res: dict) -> dict:
    res = res if isinstance(res, dict) else {}
    message = redact(str(res.get("message") or ""), 300)
    return {"ok": bool(res.get("ok")), "state": str(res.get("state") or "")[:40], "message": _test_message(message)}


def _platform_view(p: dict) -> dict:
    return {"id": p.get("id"), "name": p.get("name"), "enabled": bool(p.get("enabled")), "configured": bool(p.get("configured")),
            "gateway_running": bool(p.get("gateway_running")), "state": p.get("state"), "error_message": redact(str(p.get("error_message") or ""), 300),
            "home_channel": bool(p.get("home_channel")), "ingress_url": p.get("ingress_url"),
            "env_vars": [{"key": v.get("key"), "required": bool(v.get("required")), "is_set": bool(v.get("is_set"))}     # 가린 값(redacted_value)도 내보내지 않는다
                         for v in (p.get("env_vars") or []) if isinstance(v, dict)]}


def read(api, profile: str | None, with_pairing: bool) -> dict:
    """Hermes 에서 이 프로파일의 채널 상태와(관리자에게만) 페어링 대기·승인 목록을 읽어 줄인다."""
    from ..hermes.hermes_api import HermesError
    res = api.call("GET", "/api/messaging/platforms", query={"profile": profile})
    platforms = [_platform_view(p) for p in (res.get("platforms") or []) if isinstance(p, dict) and p.get("id") in PLATFORMS]
    pairing = None
    if with_pairing:
        try:
            raw = api.call("GET", "/api/pairing", query={"profile": profile})
            keep = lambda rows: [{k: str(r.get(k) or "")[:80] for k in ("platform", "request_id", "user_id", "user_name")}      # noqa: E731 — 승인 코드는 내보내지 않는다
                                 for r in (rows or []) if isinstance(r, dict) and r.get("platform") in PLATFORMS]
            pairing = {"pending": keep(raw.get("pending")), "approved": keep(raw.get("approved"))}
        except HermesError:
            pairing = None
    return {"profile": profile, "platforms": platforms, "pairing": pairing}

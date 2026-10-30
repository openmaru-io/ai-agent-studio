# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""크론 쓰기 규칙(스펙 2026-10-15-003 R1·R6). 거절 문구를 돌려주고(빈 문자열이면 통과) 부르는 쪽이 상태 코드를 정한다.

  숨긴 루트   대상 파드(main)의 루트 프로파일 default 에는 크론을 만들지 않는다. 대상 기록이 없는 파드는 default 가 유일한 프로파일일 수 있어 막지 않는다.
  전달 대상   주인은 local·origin·채널 이름(telegram 같은 낱말)만 쓴다. `<채널>:<id>` 와 `bot-chat:*` 는 관리자만(연결된 봇으로 아무 상대에게 보내거나
              다른 에이전트의 모델 호출 비용을 일으키는 길이라서). 숨긴 루트의 `bot-chat:default` 는 관리자도 막는다.
"""
from __future__ import annotations

import re

from ..common.i18n import tr
from ..fleet import primary

_OWNER_DELIVER = frozenset({"local", "origin"})
_CHANNEL_NAME = re.compile(r"[a-z][a-z0-9_]*")


def root_hidden(pod_id: str) -> bool:
    return primary.hide_root(pod_id, True) != "show"


def profile_error(pod_id: str, profile: str) -> str:
    if profile == primary.ROOT and root_hidden(pod_id):
        return tr("이 AI 에이전트 작업공간의 루트(default)에는 예약 작업을 만들 수 없습니다. 주 프로파일(main)을 고르세요.", "Scheduled jobs cannot be created on the root (default). Choose the main profile.")
    return ""


def deliver_error(pod_id: str, deliver: str, admin: bool) -> str:
    deliver = deliver.strip()
    if not deliver:
        return ""
    if deliver == f"bot-chat:{primary.ROOT}" and root_hidden(pod_id):
        return tr("숨긴 루트로는 전달할 수 없습니다", "Cannot deliver to the hidden root")
    if admin or deliver in _OWNER_DELIVER or (_CHANNEL_NAME.fullmatch(deliver) and deliver != "bot-chat"):
        return ""
    return tr("AI 에이전트 작업공간 소유자는 전달 대상으로 local·origin·채널 이름만 쓸 수 있습니다. 특정 채팅이나 다른 AI 에이전트로 보내려면 관리자에게 요청하세요.",
              "AI Agent Workspace owners can deliver only to local, origin or a channel name. Ask an admin to target a specific chat or another AI Agent.")

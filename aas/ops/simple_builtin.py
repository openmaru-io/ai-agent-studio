# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""URL·키만 받는 MCP 카탈로그 항목의 모양(OMAI-1863). mcp_servers 와 고객사 판 모듈(mcp_edition)이 함께 쓴다."""
from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass


@dataclass(frozen=True)
class SimpleBuiltin:
    """URL·키만 받는 읽기 전용 builtin 항목(OMAI-1863). Docmost·Outline 과 달리 쓰기 스위치·끌 도구 묶음이 없다."""
    name: str                     # 서버 이름. 스킬이 mcp__<이름>__* 로 가리킨다
    key: str                      # Hermes 가 bearer_token 을 쓰는 변수(MCP_<서버 키>_API_KEY)
    url_field: str                # 카탈로그 주소 칸
    url_setting: str              # 주소 칸을 미리 채울 설치 값
    skill: str                    # 함께 설치할 스킬
    tools: tuple[str, ...]        # 등록할 도구(include)
    label: Callable[[], str]      # 문구는 부를 때 tr() 로 고른다(요청마다 화면 언어가 다르다)
    description: Callable[[], str]
    url_prompt: Callable[[], str]
    key_prompt: Callable[[], str]
    instructions: str = ""        # 설치하면 프로파일 작업 지침(AGENTS.md)에 넣을 블록 본문(비우면 넣지 않는다)
    plugin: str = ""              # 설치하면 프로파일에 넣고 켤 Hermes 플러그인(aas/assets/hermes_plugins/<이름>, 비우면 없음)

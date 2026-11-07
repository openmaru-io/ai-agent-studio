# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""LLM 가드 거절 문구 인식(OMAI-1857, 스펙 cogentai-aas-docs 2026-11-06-005 §6 디자인 D17·D18, 재검토 M6).

사용자 Hermes 이미지의 가드(openmaru-cogentai docker/hermes-llm-guard)가 허용 목록 밖 LLM 호출을 403 과 이 구절로 거절한다.
크론 실패 이유처럼 서버가 보이는 글에 구절이 있으면 사용자 언어의 안내로 바꾼다. 화면(ui/src/lib/llmBlock.ts)도 같은 구절을 본다 —
두 언어의 시험이 tests/fixtures/llm_guard_block.txt(가드가 실제로 낸 문구)를 함께 읽어 어긋나면 실패한다.
"""
from __future__ import annotations

from ..common.i18n import tr

MARK = "BLOCKED by CogentAI AAS"


def blocked(text: str) -> bool:
    return MARK in (text or "")


def explain(text: str) -> str:
    """구절이 있으면 번역 안내, 없으면 원문."""
    if not blocked(text):
        return text
    return tr("이 프로파일의 모델 설정이 AAS LiteLLM 을 거치지 않아 막혔습니다. 관리자에게 모델 변경을 요청하세요.",
              "Blocked: this profile's model setting does not go through AAS LiteLLM. Ask an admin to change the model.")

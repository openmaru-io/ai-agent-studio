# Copyright 2026 The OPENMARU Authors.
"""부동산 질문에 청약 통계 도구를 먼저 부르라는 안내를 붙이는 Hermes 플러그인 (OMAI-1850).

작업 지침(AGENTS.md)에 「답하거나 되묻기 전에 먼저 도구를 부른다」를 적어도 Gemma 는 「청약 넣으면 될까?」에
도구 없이 지역을 되물었다(OKE 2026-11-12, 3회 중 2회). 같은 안내를 사용자 메시지 바로 뒤에 붙이면 3회 모두 도구를
불렀다. `pre_llm_call` 이 돌려준 context 는 Hermes 가 그 차례의 사용자 메시지에 붙인다(시스템 프롬프트가 아니다).

clarify 로 후보를 물을 때 모델이 선택지 없는 질문(「그 외에 … 말씀해 주세요」)을 하나 더 넣으면, 사용자가 후보를
골라도 카드가 두 번째 질문의 답을 기다리며 멈춘다(OKE 2026-11-12 C10). `pre_tool_call` 의 modify 지시로 선택지가
있는 질문만 남긴다. 선택지가 없는 질문만 있으면 그대로 둔다.

이 파일은 Hermes 를 import 하지 않는다. AAS 레포 시험이 그대로 부른다.
"""

from __future__ import annotations

import re
from typing import Any

TOOL = "mcp__cogentai_database_reb__ask_subscription_statistics"
NOTE = (f"[CogentAI 청약 통계: 이 질문은 부동산 질문일 수 있다. 답하거나 되묻기 전에 먼저 {TOOL} 에 "
        "위 질문 원문을 고치거나 줄이지 말고 그대로 넘긴다.]")
# 부동산을 뜻할 수 있는 낱말. 「동네」·「집값」처럼 수치를 묻지 않는 말도 넣는다(O08 「우리 동네는 괜찮아?」).
REAL_ESTATE = re.compile(r"청약|분양|아파트|부동산|집값|주택|동네|전월세|전세|월세|시세|매매|경쟁률|당첨|입주|공급\s*세대|내\s*집")


def note_for(message: Any) -> str | None:
    """붙일 안내. 부동산 낱말이 없거나 글이 아니면 None."""
    if not isinstance(message, str) or not REAL_ESTATE.search(message):
        return None
    return NOTE


def on_pre_llm_call(user_message: Any = None, **_: Any) -> dict | None:
    note = note_for(user_message)
    return {"context": note} if note else None


def choice_questions_only(args: Any) -> dict | None:
    """clarify 인자에서 선택지 없는 질문을 뺀 새 인자. 뺄 것이 없으면 None."""
    qs = args.get("questions") if isinstance(args, dict) else None
    if not isinstance(qs, list) or len(qs) < 2:
        return None
    kept = [q for q in qs if isinstance(q, dict) and q.get("choices")]
    if not kept or len(kept) == len(qs):
        return None
    return {**args, "questions": kept}


def on_pre_tool_call(tool_name: str = "", args: Any = None, **_: Any) -> dict | None:
    if tool_name != "clarify":
        return None
    new = choice_questions_only(args)
    return {"action": "modify", "args": new} if new else None


def register(ctx) -> None:
    ctx.register_hook("pre_llm_call", on_pre_llm_call)
    ctx.register_hook("pre_tool_call", on_pre_tool_call)

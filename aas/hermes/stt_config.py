# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""프로파일 config.yaml 의 음성 인식(stt) 절 — 스펙 docs-plan/deploy/chat-voice-input-whisper.md (2026-10-22-005) §3-8.

새 에이전트는 차트의 hermes-seed 가 같은 절을 넣는다. 이 모듈은 이미 있는 프로파일에 한 번 넣을 글을 만든다.
주소와 키는 대화 제공자와 같은 ${HERMES_LLM_*} 참조라 파일에 값이 남지 않는다. 언어는 ko 다 — 자동 감지는
짧은 말(「네」·「다음」)을 다른 언어로 받아썼다(단계 0 실측, §8-1)."""
from __future__ import annotations

import re

import yaml

_STT_TOP = re.compile(r"^stt[ \t]*:", re.M)


def stt_block(model: str) -> str:
    """시드(namespace-agents.yaml hermes-seed)와 같은 절."""
    return ("stt:\n"
            "  enabled: true\n"
            "  provider: openai\n"
            '  language: "ko"\n'
            "  openai:\n"
            f'    model: "{model}"\n'
            '    base_url: "${HERMES_LLM_BASE_URL}"\n'
            '    api_key: "${HERMES_LLM_API_KEY}"\n'
            "    timeout: 60\n"
            "    max_retries: 1\n")


def with_stt(config_text: str, model: str) -> str | None:
    """config.yaml 글 끝에 stt 절을 덧붙인 글. 모델 이름이 없거나, 이미 stt 가 있거나(사람이 정한 값은 그대로), 읽을 수 없으면 None.
    덧붙이기만 하므로 주석과 다른 내용은 그대로 남는다."""
    model = (model or "").strip()
    if not model or not re.fullmatch(r"[A-Za-z0-9._:/-]+", model):
        return None
    text = config_text or ""
    try:
        cfg = yaml.safe_load(text) if text.strip() else {}
    except yaml.YAMLError:
        return None
    if cfg is None:
        cfg = {}
    if not isinstance(cfg, dict) or "stt" in cfg or _STT_TOP.search(text):
        return None
    out = text.rstrip("\n") + ("\n" if text.strip() else "") + stt_block(model)
    try:
        ok = (yaml.safe_load(out) or {}).get("stt", {}).get("openai", {}).get("model") == model
    except (yaml.YAMLError, AttributeError):
        ok = False
    return out if ok else None

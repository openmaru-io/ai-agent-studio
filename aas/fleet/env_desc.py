# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""비밀값(.env) 변수 설명의 한국어 번역(스펙 2026-10-21-003, OMAI-1407).

- 미리 만든 번역만 쓴다(이미지 안 `aas/assets/env_desc_ko.json`, 사람이 검토). Hermes 판이 정한 닫힌 목록이라 LLM 번역은 하지 않는다(D3).
- 키는 변수 이름, 값은 `[{"src": 원문, "ko": 번역}, ...]`. 이미지마다 같은 이름의 설명이 달라 원문을 여러 개 둔다.
- 응답 원문이 표의 원문과 다르면(Hermes 판을 올려 설명이 바뀌면) 번역을 쓰지 않고 원문을 보인다(D2).
- 표는 `bin/env_desc_seed.py` 로 만든다.
"""
from __future__ import annotations

from pathlib import Path

from ..common import config
from ..common.i18n import get_lang
from ..market.skill_desc import _read_json

MAX_CHARS = 160                   # env_view 가 설명을 자르는 길이. 번역은 이보다 짧게 쓴다(D7)
_SEED_DEFAULT = Path(__file__).resolve().parent.parent / "assets" / "env_desc_ko.json"


def _norm(text: str) -> str:
    return " ".join(str(text or "").split())


def _seed_path() -> Path:
    v = config.get_or_empty("AAS_ENV_DESC_SEED", "").strip()   # 시험이 다른 표를 쓰게 한다
    return Path(v) if v else _SEED_DEFAULT


def find(name: str, description: str) -> str | None:
    """한국어 화면이고 원문이 표와 같으면 번역, 아니면 None."""
    src = _norm(description)
    if get_lang() != "ko" or not src:
        return None
    variants = _read_json(_seed_path()).get(str(name or ""))
    for v in variants if isinstance(variants, list) else []:
        if isinstance(v, dict) and v.get("ko") and _norm(v.get("src", "")) == src:
            return str(v["ko"])
    return None

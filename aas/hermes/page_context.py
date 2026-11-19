# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""위젯이 메시지 앞에 붙이는 페이지 맥락 블록을 알아본다(스펙 2026-11-15-002 A1·X4).

블록 모양은 화면의 `ui/src/lib/pageContext.ts` 가 정한다: 울타리(``` 세 개 이상) + `aas-page-context` 로 시작하고
같은 울타리로 닫힌다. 서버는 블록을 고치지 않고 그대로 Hermes 에 넘긴다. 사용 기록(usage)에는 page_id 만 남기고
제목·주소·고른 글은 남기지 않는다.
"""
from __future__ import annotations

import re

TAG = "aas-page-context"
_HEAD = re.compile(r"^(`{3,})" + re.escape(TAG) + r"\n")
_LEAD = re.compile(r"^`{3,}" + re.escape(TAG) + r"\s")      # 닫혔는지 모르는 블록 머리(Hermes 가 자른 미리보기)
_PAGE = re.compile(r"^page_id: ([^\n]{1,200})$", re.M)


def _split(text: str) -> tuple[str, str] | None:
    """메시지가 닫힌 맥락 블록으로 시작하면 (블록 안, 블록 뒤 글), 아니면 None"""
    m = _HEAD.match(text or "")
    if not m:
        return None
    end = text.find("\n" + m.group(1), m.end() - 1)
    if end < 0:
        return None
    after = text[end + 1 + len(m.group(1)):]
    if after and not after[0].isspace():
        return None
    return text[m.end():end], after


def page_id(text: str) -> str | None:
    """메시지가 닫힌 맥락 블록으로 시작하면 그 page_id, 아니면 None"""
    parts = _split(text)
    if parts is None:
        return None
    p = _PAGE.search(parts[0])
    return re.sub(r"\s+", "", p.group(1))[:200] if p else ""


def strip(text: str) -> str:
    """맥락 블록을 뗀 사용자 글(대화 제목용). 블록이 없으면 글 그대로.
    블록 첫 줄(```aas-page-context)이 대화 제목이 되던 일을 막는다(OMAI-2056, 화면의 splitContextBlock 과 같다)."""
    parts = _split(text)
    return text if parts is None else parts[1].lstrip()


def preview(text: str) -> str | None:
    """지난 대화 목록의 미리보기(Hermes 가 첫 사용자 말을 약 60자로 자르고 줄바꿈을 공백으로 바꾼 글).
    블록으로 시작하지 않으면 None. 블록이 닫혀 있고 뒤에 글이 있으면 그 글, 아니면 빈 값 — 잘린 미리보기에는
    블록 뒤 글도 페이지 제목도 남지 않는다(OMAI-2056). 빈 값이면 부르는 쪽이 고정 문구를 쓴다."""
    text = text or ""
    parts = _split(text)
    if parts is not None:
        return parts[1].strip()
    return "" if _LEAD.match(text) else None

# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""SOUL 첫 문장(에이전트 소개)을 회사 이름에 맞춘다. 계획 2026-10-13-008 §2-2.

Hermes 는 처음 뜰 때 SOUL.md 에 `You are Hermes Agent, built by Nous Research. …` 를 넣는다
(hermes-agent/hermes_cli/default_soul.py). AAS 는 그 첫 문장만 `You are CogentAI AAS Agent, built by <회사명>.` 으로 바꾼다.
사용자가 첫 문장을 고친 SOUL 은 건드리지 않는다(결정 D1) — 알고 있는 문장으로 시작할 때만 바꾼다.
"""
from __future__ import annotations

HERMES_DEFAULT = "You are Hermes Agent, built by Nous Research."


def _starts(body: str, sentence: str) -> bool:
    """문장 단위로 시작하는가. `…built by A.` 가 `…built by A.B Corp.` 의 앞부분으로 잘못 맞지 않게, 뒤가 공백이나 끝이어야 한다."""
    return body.startswith(sentence) and (len(body) == len(sentence) or body[len(sentence)].isspace())


def rewrite(text: str, sentence: str, known: list[str]) -> str | None:
    """바꿔야 하면 새 글, 아니면 None.

    text 앞의 공백을 뺀 글이 Hermes 기본 문장이나 known(AAS 가 전에 넣은 문장) 중 하나로 시작하면 그 문장만 sentence 로 바꾼다.
    이미 sentence 로 시작하면 None. 빈 SOUL 은 Hermes 가 기본 문장을 쓰는 상태라 건드리지 않는다.
    """
    body = text.lstrip()
    if not body or _starts(body, sentence):
        return None
    lead = text[: len(text) - len(body)]
    for old in sorted({HERMES_DEFAULT, *known} - {sentence}, key=len, reverse=True):   # 긴 문장부터(한 문장이 다른 문장의 앞부분일 때)
        if old and _starts(body, old):
            return lead + sentence + body[len(old):]
    return None

# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""브라우저와 서버 사이 웹소켓 메시지 형식(버전 1, OMAI-1100).

모든 프레임은 UTF-8 JSON 텍스트 하나다. 봉투는 {"v": 1, "t": <종류>, ...}.
"""
from __future__ import annotations

import json

VERSION = 1

# 브라우저 → 서버
CLIENT_TYPES = {"hello", "sub", "unsub", "req", "ping", "pub"}            # pub: 내 아바타 위치(토픽 office:presence 만, 계획 007 P6b)

# close 코드(본문 §5.3 표)
NORMAL, GOING_AWAY, POLICY, TOO_BIG, INTERNAL, RESTART, TRY_AGAIN = 1000, 1001, 1008, 1009, 1011, 1012, 1013
BAD_REQUEST, UNAUTHORIZED, FORBIDDEN, REPLACED = 4400, 4401, 4403, 4409


class ProtocolError(ValueError):
    def __init__(self, reason: str):
        super().__init__(reason)
        self.reason = reason


def encode(t: str, **fields) -> str:
    """서버가 보내는 메시지 하나. 같은 문자열을 여러 연결이 나눠 쓴다(큐는 같은 객체를 가리킨다)."""
    return json.dumps({"v": VERSION, "t": t, **fields}, ensure_ascii=False, separators=(",", ":"))


def parse(text: str) -> dict:
    """브라우저 메시지 검증. 형식이 틀리면 ProtocolError. 알 수 없는 t 는 그대로 돌려준다(호출한 쪽이 무시한다)."""
    try:
        msg = json.loads(text)
    except (TypeError, ValueError):
        raise ProtocolError("not_json") from None
    if not isinstance(msg, dict):
        raise ProtocolError("not_object")
    if msg.get("v") != VERSION:
        raise ProtocolError("version")
    if not isinstance(msg.get("t"), str):
        raise ProtocolError("no_type")
    topic = msg.get("topic")
    if topic is not None and (not isinstance(topic, str) or len(topic) > 200):
        raise ProtocolError("bad_topic")
    after = msg.get("after")
    if after is not None and (isinstance(after, bool) or not isinstance(after, int)):
        raise ProtocolError("bad_after")
    return msg

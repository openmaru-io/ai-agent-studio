# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""서버가 화면에 보내는 문장의 언어. 요청의 Accept-Language 로 정하고 `tr(한국어, 영어)` 로 고른다.

요청을 처리하는 동안만 영어가 되고, 헤더가 없거나 알 수 없는 언어이거나 요청 밖(수집 스레드 등)이면 한국어다.
로그, 명령줄 출력, 에이전트(LLM)에 보내는 프롬프트, 데이터베이스에 저장하는 문장은 번역하지 않는다.
"""
from __future__ import annotations

import contextvars

SUPPORTED = ("ko", "en")
DEFAULT = "ko"

_lang: contextvars.ContextVar[str] = contextvars.ContextVar("aas_lang", default=DEFAULT)


def parse_accept_language(header: str | None) -> str:
    """Accept-Language 값에서 지원하는 첫 언어(q 값이 큰 순)를 고른다. 없으면 한국어."""
    best, best_q = DEFAULT, -1.0
    for part in (header or "").split(","):
        tag, _, params = part.strip().partition(";")
        primary = tag.strip().lower().split("-")[0]
        if primary not in SUPPORTED:
            continue
        q = 1.0
        for p in params.split(";"):
            k, _, v = p.strip().partition("=")
            if k.strip().lower() == "q":
                try:
                    q = float(v)
                except ValueError:
                    q = 0.0
        if q > 0 and q > best_q:
            best, best_q = primary, q
    return best


LANG_COOKIE = "aas-lang"   # 로그인 화면·콘솔에서 고른 언어. 콘솔 localStorage 키(ui/src/i18n LANG_KEY)와 같은 이름


def request_lang(accept_language: str | None, cookie_header: str | None) -> str:
    """요청의 언어. 화면에서 고른 언어(쿠키 aas-lang)가 있으면 그것, 없으면 Accept-Language.
    서버가 그리는 로그인 화면은 주소 이동이라 콘솔처럼 헤더를 바꿔 보낼 수 없어 쿠키로 고른 값을 받는다(스펙 2026-10-14-001 §13)."""
    for part in (cookie_header or "").split(";"):
        name, _, value = part.strip().partition("=")
        if name == LANG_COOKIE and value.strip() in SUPPORTED:
            return value.strip()
    return parse_accept_language(accept_language)


def set_lang(lang: str) -> None:
    _lang.set(lang if lang in SUPPORTED else DEFAULT)


def get_lang() -> str:
    return _lang.get()


def tr(ko: str, en: str) -> str:
    """현재 요청의 언어에 맞는 문장. 값이 들어가는 문장은 두 쪽 모두 f-string 으로 쓴다."""
    return en if _lang.get() == "en" else ko

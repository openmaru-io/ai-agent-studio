# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""프로파일 설정 복사(스펙 2026-10-15-011 D6·D8, 단계 3·4). config.yaml 글을 새 프로파일로 옮기는 변환만 한다.

  새 프로파일용   채널 블록(봇·허용 사용자 설정)을 뺀다. 나머지는 그대로(모델·제공자도 같은 파드의 원본에서 오므로 그대로 쓴다).
  가져오기용      다른 에이전트(파드)의 설정을 받는다. 받는 쪽 설정을 바탕으로 두고 원본에서 안전한 키만 얹는다:
                  잠글 키(모델·제공자·보조 모델·gateway·terminal 실행 위치)·채널 블록·MCP 서버(인증값이 들어 있을 수 있다)·skills 는 받는 쪽 값을 지킨다.
Hermes 가 설정 글을 다시 쓰므로 주석은 사라진다. 변환은 YAML 표를 다시 쓴다.
"""
from __future__ import annotations

import yaml

from ..common.i18n import tr
from . import owner_guard

_KEEP_DEST_TOP = owner_guard._LOCKED_TOP + tuple(owner_guard._CHANNEL_BLOCKS) + ("mcp_servers", "skills")


def _load(text: str) -> dict:
    try:
        cfg = yaml.safe_load(text or "")
    except yaml.YAMLError as exc:
        raise ValueError(tr(f"config.yaml 을 읽을 수 없습니다: {exc}", f"Cannot read config.yaml: {exc}")) from exc
    if cfg is None:
        return {}
    if not isinstance(cfg, dict):
        raise ValueError(tr("config.yaml 이 표 모양이 아닙니다", "config.yaml is not a mapping"))
    return cfg


def _dump(cfg: dict) -> str:
    return yaml.safe_dump(cfg, allow_unicode=True, sort_keys=False, default_flow_style=False)


def for_new_profile(src_text: str) -> str:
    """같은 파드의 원본 설정에서 채널 블록만 뺀 글."""
    cfg = _load(src_text)
    for block in owner_guard._CHANNEL_BLOCKS:
        cfg.pop(block, None)
    return _dump(cfg)


def import_overlay(dest_text: str, src_text: str) -> str:
    """받는 쪽 설정(dest) 위에 다른 에이전트의 설정(src)에서 안전한 키만 얹은 글."""
    dest, src = _load(dest_text), _load(src_text)
    out = dict(dest)
    for key, value in src.items():
        if key in _KEEP_DEST_TOP or key == "terminal":
            continue
        out[key] = value
    term_src = src.get("terminal") if isinstance(src.get("terminal"), dict) else {}
    if term_src:                                                          # terminal 은 실행 위치 키만 받는 쪽 값을 지키고 나머지(작업 폴더 등)는 가져온다
        term = dict(out.get("terminal") if isinstance(out.get("terminal"), dict) else {})
        for k, v in term_src.items():
            if not (k == "backend" or str(k).startswith(owner_guard._LOCKED_TERMINAL_PREFIX)):
                term[k] = v
        out["terminal"] = term
    return _dump(out)


def skipped_keys(src_text: str) -> list[str]:
    """가져오지 않고 받는 쪽 값을 지킨 최상위 키(원본에 있던 것만). 화면 안내용."""
    src = _load(src_text)
    return sorted(k for k in src if k in _KEEP_DEST_TOP)

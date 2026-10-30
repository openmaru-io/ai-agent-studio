# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""주인(관리자가 아닌 에이전트 주인)의 동작 검사(스펙 2026-10-15-011 D2·D3·R2·R5). 거절 문구를 돌려주고(빈 문자열이면 통과)
부르는 쪽이 403 으로 바꾼다. 관리자는 이 검사를 거치지 않는다. 이 검사는 AAS 화면·API 를 거치는 요청의 실수 방지이며, 에이전트가
파드 안 파일을 직접 고치는 것은 막지 못한다(R3, 모델·가드레일의 경계는 LiteLLM 가상 키다).

  비밀값(D3)   카탈로그 범주 tool·skill 과 카탈로그에 없는 이름만. provider·setting·messaging 범주, 동작·접속 변수 이름은 거절. 카탈로그를 읽지 못하면 거절.
  채널(D2·R2)  저장·삭제할 수 있는 변수는 `{채널}_BOT_TOKEN`·`SLACK_APP_TOKEN`·`{채널}_ALLOWED_USERS`(실제 사용자 ID 만) 뿐.
               `*`·빈 항목은 열린 봇이 되므로 거절하고, 그 밖의 인가 변수(`*_ALLOW*`·`GATEWAY_*`·`*_ROLES`·`*_DM_POLICY` 등)도 거절.
  숨긴 루트(R5) 루트 default 가 숨겨진 POD 에서는 주인의 모든 동작이 거절된다.
  설정 파일(D4)  저장하려는 글을 파싱한 값으로 「잠글 키」가 지금 값과 같은지 비교한다(주석·순서는 상관없고 YAML 앵커도 풀린 값으로 본다):
               model·providers·custom_providers·fallback_providers·auxiliary·gateway(블록 전체), terminal 의 backend·docker_*·singularity_*·modal_*·daytona_*·
               vercel_*·ssh_*, platforms·discord·matrix·mattermost 같은 채널 블록 안의 인가 키(allow*·*policy*·*roles*·owner·admin).
               gateway 는 Hermes 345cd2b 기본 설정에서 인가 키만 따로 고르지 않고 블록 전체를 잠갔다(스펙보다 엄격 — 키 이름 확인 전의 안전한 쪽).
               skills.external_dirs 는 /opt/data 아래 절대 경로만(`..` 정규화 뒤 접두사 검사, 심볼릭 링크는 따라가지 않는다). AAS 사용법 스킬 폴더 /opt/aas-skills 는 예외(2026-10-18-001).
"""
from __future__ import annotations

import posixpath
import re

import yaml

from ..common import config
from ..common.i18n import tr
from ..fleet import primary
from . import cron_policy

CHANNELS = ("telegram", "discord", "slack", "mattermost")
_BLOCKED_PREFIX = ("HERMES_", "GATEWAY_", "TERMINAL_", "AAS_", "LITELLM_", "PYTHON", "LD_")
_BLOCKED_EXACT = frozenset({"PATH", "HOME", "SHELL", "USER", "LANG", "TZ"})
_BLOCKED_SUFFIX = ("_BASE_URL", "_PROXY", "_ENDPOINT")
_BLOCKED_CATEGORY = frozenset({"provider", "setting", "messaging"})
_USER_ID = re.compile(r"^[A-Za-z0-9_.:@-]{1,80}$")
_SERVER_URL = re.compile(r"^https?://[^\s@/?#]+(?::\d{1,5})?(?:/[^\s@?#]*)?$")      # 메신저 서버 주소(Mattermost). 계정·공백·질의 문자열 없이


def root_error(pod_id: str, profile: str) -> str:
    """숨긴 루트 default 에 대한 주인의 동작 거절(R5). 대상 기록이 없는 POD 는 막지 않는다."""
    if profile == primary.ROOT and cron_policy.root_hidden(pod_id):
        return tr("이 AI 에이전트 작업공간의 루트(default)는 숨겨져 있어 바꿀 수 없습니다. 주 프로파일(main)을 고르세요.",
                  "The root (default) is hidden and cannot be changed. Choose the main profile.")
    return ""


def env_key_check(key: str, catalog: dict[str, str] | None) -> tuple[str, str]:
    """주인의 비밀값 이름 검사. (사유 코드, 문장). 통과면 ("", ""). 코드: list_unreadable·platform_var·url_proxy·channel_var·provider_key.
    catalog 는 이름 → 카탈로그 범주(tool·skill·provider·setting·messaging). 읽지 못했으면 None(거절)."""
    if catalog is None:
        return "list_unreadable", tr("변수 목록을 읽지 못해 지금은 비밀값을 바꿀 수 없습니다. 잠시 뒤 다시 시도하세요.", "Cannot read the variable list now, so secrets cannot be changed. Try again shortly.")
    if key.endswith(_BLOCKED_SUFFIX):
        return "url_proxy", tr(f"{key} 는 Hermes 접속 주소를 정하는 이름이라 관리자만 바꿉니다.", f"{key} sets a connection address; only admins can change it.")
    if key in _BLOCKED_EXACT or key.startswith(_BLOCKED_PREFIX):
        return "platform_var", tr(f"{key} 는 Hermes 동작·접속을 정하는 이름이라 관리자만 바꿉니다.", f"{key} controls Hermes behavior or connections; only admins can change it.")
    category = catalog.get(key, "")
    if category == "messaging":
        return "channel_var", tr(f"{key} 는 채널 변수입니다. 「채널」 탭에서 바꾸세요.", f"{key} is a channel variable. Change it in the Channels tab.")
    if category in _BLOCKED_CATEGORY:
        return "provider_key", tr(f"{key} 는 모델 제공자·동작 설정 값이라 관리자만 바꿉니다. 모델 키는 LiteLLM 으로 모아 관리합니다.",
                                 f"{key} is a model provider or behavior setting; only admins can change it. Model keys are managed through LiteLLM.")
    return "", ""


def env_key_error(key: str, catalog: dict[str, str] | None) -> str:
    return env_key_check(key, catalog)[1]


def _allowed_names(platform: str) -> set[str]:
    p = platform.upper()
    names = {f"{p}_BOT_TOKEN", f"{p}_ALLOWED_USERS"}
    if platform == "slack":
        names.add("SLACK_APP_TOKEN")
    if platform == "mattermost":                       # Mattermost 는 봇 토큰 이름이 다르고 서버 주소가 필수다(Hermes plugins/platforms/mattermost, 스펙 2026-10-19-008 D2)
        names = {"MATTERMOST_URL", "MATTERMOST_TOKEN", "MATTERMOST_ALLOWED_USERS"}
    return names


def channel_env_check(platform: str, key: str, value: str) -> tuple[str, str]:
    """주인이 채널 탭에서 저장하는 변수 한 개의 검사. (사유 코드, 문장). 코드: auth_var_blocked·allow_list_invalid·url_invalid."""
    if platform not in CHANNELS or key not in _allowed_names(platform):
        return "auth_var_blocked", tr(f"{key} 는 소유자가 바꿀 수 없는 변수입니다. 봇 토큰과 허용 사용자만 바꿀 수 있습니다.", f"{key} cannot be changed by the owner. Only the bot token and allowed users can be changed.")
    if key.endswith("_URL") and not _SERVER_URL.match(value.strip()):
        return "url_invalid", tr("서버 주소는 http:// 또는 https:// 로 시작하는 주소만 적습니다. 계정(@)이나 공백은 넣을 수 없습니다.",
                                 "Enter a server address starting with http:// or https://, without an account (@) or spaces.")
    if key.endswith("_ALLOWED_USERS"):
        entries = [e.strip() for e in value.split(",")]
        if not value.strip() or any(not e or e == "*" or not _USER_ID.match(e) for e in entries):
            return "allow_list_invalid", tr("허용 사용자에는 실제 사용자 ID 만 쉼표로 적습니다. `*` 나 빈 항목은 누구나 쓰는 열린 봇이 되므로 쓸 수 없습니다.",
                                           "List real user IDs separated by commas. `*` or empty entries would open the bot to everyone and are not allowed.")
    return "", ""


def channel_env_error(platform: str, key: str, value: str) -> str:
    return channel_env_check(platform, key, value)[1]


def channel_clear_error(platform: str, key: str) -> str:
    """주인이 지우는 채널 변수의 검사. 저장과 같은 이름 규칙이다."""
    if platform not in CHANNELS or key not in _allowed_names(platform):
        return tr(f"{key} 는 소유자가 지울 수 없는 변수입니다.", f"{key} cannot be cleared by the owner.")
    return ""


def catalog_of(rows) -> dict[str, str] | None:
    """Hermes `GET /api/env` 응답을 이름 → 범주로. 모양을 알아볼 수 없으면 None."""
    if isinstance(rows, dict) and "vars" in rows:
        rows = rows["vars"]
    items = rows.items() if isinstance(rows, dict) else [(r.get("key") or r.get("name"), r) for r in rows or [] if isinstance(r, dict)]
    out = {str(k): str(v.get("category") or "") for k, v in items if k and isinstance(v, dict)}
    return out or None


# ---- 프로파일 추가(D5·단계 2) -------------------------------------------------------------------------------------
PROFILE_LIMIT_MAX = 20


def profile_limit() -> int:
    """파드당 프로파일 수 상한. 설치 값(AAS_PROFILE_LIMIT, 기본 3). 숨긴 루트는 세지 않고 main 은 센다. 3 은 측정한 값이 아니다(스펙 확인 C5)."""
    try:
        return max(1, min(PROFILE_LIMIT_MAX, int(config.get("AAS_PROFILE_LIMIT", "3"))))
    except ValueError:
        return 3


def profile_count(names: list[str], root_hidden: bool) -> int:
    """상한 셈. 숨긴 루트와 PC 가져오기 임시 프로파일(pcimp-)은 세지 않는다 — 화면의 「지금 N개」와 같게(OMAI-1444 ROV8)."""
    from . import pc_import
    return len([n for n in names if not (root_hidden and n == primary.ROOT) and not pc_import.reserved_name(n)])


def create_error(pod_id: str, requested_from: str, no_skills: bool, names: list[str]) -> tuple[int, str]:
    """주인의 프로파일 추가 검사: 원본은 주 프로파일 하나, 스킬 빼기 금지, 파드당 상한. (상태 코드, 문구) — 통과면 (0, "")."""
    main = primary.primary_of(pod_id)
    if requested_from and requested_from != main:
        return 403, tr(f"소유자는 주 프로파일({main})을 복제해서만 프로파일을 추가합니다.", f"Owners can add a profile only by cloning the main profile ({main}).")
    if no_skills:
        return 403, tr("스킬을 빼고 만드는 것은 관리자만 합니다.", "Only admins can create a profile without skills.")
    limit, used = profile_limit(), profile_count(names, cron_policy.root_hidden(pod_id))
    if used >= limit:
        return 409, tr(f"이 작업 프로파일을 {limit}개까지 둘 수 있습니다(지금 {used}개). 쓰지 않는 프로파일을 지운 뒤 다시 하세요.",
                       f"This AI Agent Workspace can have up to {limit} profiles (now {used}). Delete one you do not use and try again.")
    return 0, ""


# ---- 설정 파일(config.yaml) 잠금 ---------------------------------------------------------------------------------
# approvals: 승인 설정(끄기·거절 규칙)은 관리자만(스펙 2026-10-24-001 D2). 데이터 폴더 보호는 Hermes hardline 이라 이 잠금과 무관한 편의 잠금이다
_LOCKED_TOP = ("model", "providers", "custom_providers", "fallback_providers", "auxiliary", "gateway", "approvals")
_LOCKED_TERMINAL_PREFIX = ("docker_", "singularity_", "modal_", "daytona_", "vercel_", "ssh_")
_AUTH_KEY = re.compile(r"allow|policy|roles|owner|admin", re.I)
_CHANNEL_BLOCKS = ("platforms", "discord", "matrix", "mattermost", "telegram", "slack", "whatsapp", "signal", "email")
DATA_DIR = "/opt/data"


def _load(text: str):
    try:
        data = yaml.safe_load(text)
    except yaml.YAMLError:
        return None
    return data if isinstance(data, dict) else None


def _auth_paths(node, path: str, out: dict) -> None:
    """채널 블록 안에서 키 이름이 인가처럼 보이는 곳(값 전체)을 모은다."""
    if isinstance(node, dict):
        for k, v in node.items():
            sub = f"{path}.{k}"
            if _AUTH_KEY.search(str(k)):
                out[sub] = v
            else:
                _auth_paths(v, sub, out)
    elif isinstance(node, list):
        for i, v in enumerate(node):
            _auth_paths(v, f"{path}[{i}]", out)


def _locked_view(cfg: dict) -> dict:
    view = {k: cfg.get(k) for k in _LOCKED_TOP if k in cfg}
    term = cfg.get("terminal") if isinstance(cfg.get("terminal"), dict) else {}
    for k, v in term.items():
        if k == "backend" or str(k).startswith(_LOCKED_TERMINAL_PREFIX):
            view[f"terminal.{k}"] = v
    for block in _CHANNEL_BLOCKS:
        if block in cfg:
            _auth_paths(cfg[block], block, view)
    return view


def config_locked_keys(old_yaml: str, new_yaml: str) -> list[str]:
    """저장하려는 설정에서 잠글 키가 바뀐 곳의 이름 목록(없으면 빈 목록). 파싱하지 못하는 글은 여기서 판단하지 않는다(형식 검사가 한다)."""
    old, new = _load(old_yaml), _load(new_yaml)
    if new is None:
        return []
    before, after = _locked_view(old or {}), _locked_view(new)
    return sorted(k for k in before.keys() | after.keys() if before.get(k) != after.get(k))


def config_dirs_error(new_yaml: str) -> str:
    """skills.external_dirs 가 /opt/data 밖이면 거절 문구. 정규화(`..`) 뒤 접두사만 본다 — 심볼릭 링크는 따라가지 않는다(O9).
    AAS 사용법 스킬 폴더(/opt/aas-skills, 읽기 전용 ConfigMap 마운트)는 서버가 넣는 값이라 허용한다(스펙 2026-10-18-001)."""
    from .help_skill import HELP_DIR
    cfg = _load(new_yaml) or {}
    skills = cfg.get("skills") if isinstance(cfg.get("skills"), dict) else {}
    dirs = skills.get("external_dirs") or []
    for d in dirs if isinstance(dirs, list) else [dirs]:
        path = posixpath.normpath(str(d)) if str(d).startswith("/") else ""
        if not path or not (path == DATA_DIR or path.startswith(DATA_DIR + "/") or path == HELP_DIR or path.startswith(HELP_DIR + "/")):
            return tr(f"skills.external_dirs 는 {DATA_DIR} 아래 경로만 쓸 수 있습니다: {d}", f"skills.external_dirs must stay under {DATA_DIR}: {d}")
    return ""


def config_error(old_yaml: str, new_yaml: str) -> str:
    """주인의 설정 저장 검사. 통과면 빈 문자열. 잠글 키가 바뀌었으면 어느 키인지 알린다."""
    keys = config_locked_keys(old_yaml, new_yaml)
    if keys:
        return tr("관리자만 바꾸는 설정이 바뀌었습니다: " + ", ".join(keys) + ". 그 부분은 원래대로 두고 저장하세요.",
                  "Settings only admins can change were modified: " + ", ".join(keys) + ". Keep them as they were and save again.")
    return config_dirs_error(new_yaml)

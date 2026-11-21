# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""스킬이 선언한 필요한 비밀값(스펙 2026-10-16-010 2단계, OMAI-1263).

Hermes 는 SKILL.md 머리(frontmatter)의 세 곳을 합쳐 「이 스킬에 필요한 환경변수」를 정한다(Hermes 345cd2b
tools/skills_tool_setup.py `_get_required_environment_variables`). 같은 규칙으로 이름·안내만 읽는다. 값은 다루지 않는다.
  required_environment_variables: [이름 | {name, prompt, help, required_for, optional}]
  setup.collect_secrets:          [{env_var, prompt, provider_url | url}]   (setup.help 는 공통 도움말)
  prerequisites.env_vars:         [이름]                                    (옛 형식)
메시징 채널에서는 스킬이 비밀값을 물을 수 없어, 화면이 이 목록을 보이고 비밀값 탭(env_set)으로 받는다.
"""
from __future__ import annotations

import logging
import re

import yaml

_log = logging.getLogger(__name__)

# AAS 가 LLM 접속값을 주는 이름(스펙 2026-11-19-002 D2, OMAI-2123). Hermes 사내 패치
# openmaru-cogentai docker/hermes-patches-aas/skill-llm-env-alias.patch 의 `_AAS_LLM_ALIAS` 키(LLM_*)와 값(HERMES_LLM_*)이다.
# 두 레포는 서로 가져올 수 없어 같은 목록을 양쪽 시험에 적는다(tests/test_skill_llm_env_managed.py ↔
# openmaru-cogentai tests/test_hermes_skill_llm_alias.py). 스킬이 선언한 이 이름은 묻지 않는다 — Hermes 가 프로파일
# .env 값이 「비어 있음」이면 파드의 HERMES_LLM_* 값으로 잇는다.
AAS_LLM_ALIAS = {"LLM_BASE_URL": "HERMES_LLM_BASE_URL", "LLM_API_KEY": "HERMES_LLM_API_KEY", "LLM_MODEL": "HERMES_LLM_MODEL"}
AAS_MANAGED = frozenset(AAS_LLM_ALIAS) | frozenset(AAS_LLM_ALIAS.values())
_UNRESOLVED_REF = re.compile(r"^\$\{[^}]*\}\Z")              # 값 전체가 ${이름} — Hermes 범위는 풀지 않는다

_ENV_NAME = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*\Z")       # Hermes _ENV_VAR_NAME_RE 와 같다
_ENV_LINE = re.compile(r"^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$")


def _list(raw) -> list:
    return [raw] if isinstance(raw, dict) else raw if isinstance(raw, list) else []


def _text(value) -> str:
    return value.strip() if isinstance(value, str) and value.strip() else ""


def frontmatter(md: str) -> dict:
    """SKILL.md 머리를 YAML 로. 없거나 깨졌으면 {}."""
    if not md.startswith("---"):
        return {}
    end = md.find("\n---", 3)
    if end == -1:
        return {}
    try:
        data = yaml.safe_load(md[3:end])
    except yaml.YAMLError:
        return {}
    return data if isinstance(data, dict) else {}


def required_env(meta: dict) -> list[dict]:
    """[{name, prompt, help?, required_for?, optional?}] — 이름이 겹치면 먼저 나온 것이 이긴다(Hermes 와 같다)."""
    setup = meta.get("setup") if isinstance(meta.get("setup"), dict) else {}
    setup_help = _text(setup.get("help"))
    prereqs = meta.get("prerequisites")
    legacy = (prereqs.get("env_vars") if isinstance(prereqs, dict) else None) or []
    legacy = [legacy] if isinstance(legacy, str) else legacy if isinstance(legacy, list) else []
    entries = [{"name": i} if isinstance(i, str) else i for i in _list(meta.get("required_environment_variables")) if isinstance(i, (str, dict))]
    entries += [{"name": i.get("env_var"), "prompt": i.get("prompt"), "url": _text(str(i.get("provider_url") or i.get("url") or "")) or None}
                for i in _list(setup.get("collect_secrets")) if isinstance(i, dict)]
    entries += [{"name": str(v)} for v in legacy if str(v).strip()]
    out: dict[str, dict] = {}
    for e in entries:
        name = str(e.get("name") or e.get("env_var") or "").strip()
        if not name or name in out or not _ENV_NAME.match(name):
            continue
        item = {"name": name, "prompt": str(e.get("prompt") or "").strip()[:200]}
        help_text = _text(e.get("help")) or _text(e.get("provider_url")) or _text(e.get("url")) or setup_help
        if help_text:
            item["help"] = help_text[:300]
        if _text(e.get("required_for")):
            item["required_for"] = _text(e.get("required_for"))[:120]
        if e.get("optional"):
            item["optional"] = True
        if name in AAS_MANAGED:
            # managed: 「AAS 가 관리하는 이름」이라는 고정 표시. 스킬 선언에서 정해지고 스킬 묶음 캐시에 남는다.
            # 실제 출처(aas·profile)는 요청마다 .env 를 읽어 정한다(managed_source).
            item["managed"] = "aas"
        out[name] = item
    return list(out.values())[:20]


def set_names(*env_files) -> set[str]:
    """`.env` 파일들에서 값이 있는 변수 이름만. 값은 돌려주지 않는다. 없는 파일은 건너뛴다."""
    names: set[str] = set()
    for path in env_files:
        try:
            if not path.is_file():
                continue
            text = path.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        names |= names_of(text)
    return names


def names_of(text: str) -> set[str]:
    """`.env` 글에서 값이 있는 변수 이름만. 여러 파일을 한 번에 읽은 쪽이 쓴다(스펙 2026-11-06-002 D3)."""
    names: set[str] = set()
    for line in (text or "").splitlines():
        m = _ENV_LINE.match(line)
        if m and m.group(2).strip().strip("\"'"):
            names.add(m.group(1))
    return names


def is_aas_managed(name) -> bool:
    """AAS 가 LLM 접속값을 주는 이름인가(스펙 2026-11-19-002 D2)."""
    return isinstance(name, str) and name in AAS_MANAGED


def is_empty_value(value) -> bool:
    """스펙 2026-11-19-002 §4-1 의 「비어 있음」: None, 빈 값·공백만, 값 전체가 `${이름}` 꼴인 풀리지 않은 참조.
    Hermes 패치(skill-llm-env-alias)와 같은 정의다. 값은 .env 파서가 따옴표·export·줄 끝 주석을 벗긴 뒤의 것."""
    if value is None:
        return True
    text = str(value).strip()
    return not text or bool(_UNRESOLVED_REF.match(text))


def _strip_inline_comment(value: str) -> str:
    """Hermes agent/secret_scope.py `_strip_inline_comment` 와 같다(python-dotenv 규칙)."""
    value = value.strip()
    if not value:
        return value
    quote = value[0]
    if quote in ("'", '"'):
        i = 1
        while i < len(value):
            ch = value[i]
            if quote == '"' and ch == "\\":
                i += 2
                continue
            if ch == quote:
                return value[: i + 1] if value[i + 1:].lstrip().startswith("#") else value
            i += 1
        return value
    return re.split(r"\s+#", value, maxsplit=1)[0].strip()


def _parse_env_value(raw: str) -> str:
    """Hermes agent/secret_scope.py `_parse_env_value` 와 같다(맨값, '작은따옴표', "큰따옴표"와 \\" · \\\\ 풀기)."""
    value = raw.strip()
    if len(value) >= 2 and value[0] == value[-1] == '"':
        quoted, out, i = value[1:-1], [], 0
        while i < len(quoted):
            escaped = quoted[i] == "\\" and quoted[i + 1:i + 2] in ('"', "\\")
            out.append(quoted[i + 1] if escaped else quoted[i])
            i += 2 if escaped else 1
        return "".join(out)
    if len(value) >= 2 and value[0] == value[-1] == "'":
        return value[1:-1]
    return value


def env_values_of(text: str) -> dict[str, str]:
    """`.env` 글 → {이름: 값}. Hermes `_parse_env_text` 와 같은 규칙(export·# 주석·따옴표, 같은 이름은 뒤가 이김).
    값을 화면·로그로 내보내지 않는다 — managed_source 가 「비어 있음」 판정에만 쓴다."""
    out: dict[str, str] = {}
    for raw_line in (text or "").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[len("export "):].lstrip()
        key, sep, value = line.partition("=")
        key = key.strip()
        if sep and key:
            out[key] = _parse_env_value(_strip_inline_comment(value))
    return out


def managed_source_of(name: str, values: dict) -> str:
    """이미 읽은 .env 값으로 출처를 정한다: 「비어 있음」이 아니면 profile, 그 밖은 aas."""
    return "aas" if is_empty_value(values.get(name)) else "profile"


def read_env_values(env_path) -> dict[str, str] | None:
    """프로파일 .env 를 읽어 {이름: 값}. 파일이 없으면 {}, 읽지 못하면 WARNING(경로·예외 종류만) 뒤 None."""
    try:
        if not env_path.is_file():
            return {}
        return env_values_of(env_path.read_text(encoding="utf-8", errors="replace"))
    except OSError as exc:
        _log.warning("스킬 LLM 접속값 출처를 정하려고 .env 를 읽지 못했습니다(AAS 값으로 봅니다): %s (%s)",   # i18n-ignore: 로그
                     env_path, type(exc).__name__)
        return None


def managed_source(name: str, env_path) -> str:
    """프로파일 .env 의 그 이름 값이 「비어 있음」이 아니면 "profile", 그 밖(없음·빈 값·공백·${이름} 참조·파일을 읽지 못함)은 "aas".
    값은 돌려주지 않는다. Hermes 범위의 외부 비밀값 출처·관리자 .env 는 AAS 가 쓰지 않아 보지 않는다(스펙 §7)."""
    values = read_env_values(env_path)
    return "aas" if values is None else managed_source_of(name, values)


def with_status(entries: list[dict], env_path) -> tuple[list[dict], bool]:
    """`/api/skill` 의 required_env 에 그때그때의 상태를 붙인다(값은 붙이지 않는다).
    일반 이름: set = .env 에 값이 있는가. managed 이름: set 은 늘 True, managed_source 는 .env 값의 출처(aas·profile).
    둘째 값 managed_mixed: 스킬이 선언한 LLM_* 이름이 둘 이상이고 그 출처가 갈리면 True — 주소·키·모델이 서로 다른 곳에서
    오면 같은 실패를 낸다(스펙 2026-11-19-002 §4-2 #3). set_names 는 ${…} 를 값 있음으로 보므로 관리 이름에는 쓰지 않는다."""
    have = set_names(env_path)
    values = read_env_values(env_path) if any(e.get("managed") for e in entries) else {}
    out = []
    for e in entries:
        if e.get("managed"):
            src = "aas" if values is None else managed_source_of(e["name"], values)
            out.append({**e, "set": True, "managed_source": src})
        else:
            out.append({**e, "set": e["name"] in have})
    llm = {e["managed_source"] for e in out if e.get("managed") and e["name"] in AAS_LLM_ALIAS}
    declared = sum(1 for e in out if e.get("managed") and e["name"] in AAS_LLM_ALIAS)
    return out, declared >= 2 and len(llm) > 1

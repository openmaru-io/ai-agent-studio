# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""스킬 허브 태그(OMAI-1275) — 스킬마다 정해진 어휘에서 1~3개를 LLM 이 골라 `AAS_DATA_DIR/market/tags.json` 에 둔다.
태그 목록의 맨 앞은 업무(WORK, 영업·마케팅… 하나), 나머지는 기능(VOCAB, 0~2개)이다(스펙 2026-11-17-003).

SkillHub 는 태그·라벨을 주지 않고 후보 스킬 머리말에도 태그가 없어서, 태그는 AAS 쪽 표로 관리한다(출처 표 origins.json 과 같은 자리).
입력은 패키지의 이름과 설명뿐이다(본문은 읽지 않는다). 폐쇄망에서는 클러스터 안 LiteLLM 으로 부른다. LiteLLM 이 없으면 조용히 건너뛰고
태그가 없는 화면은 칩 줄을 숨긴다. 버전이 바뀌면 다시 분류한다.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import time
import urllib.request
from pathlib import Path

from ..common import config, netcache, store

TAGS = "tags.json"            # {"<네임스페이스>/<이름>": {tags, for(분류한 버전), at, tries, try_for, by}}
MAX_TAGS = 3
MAX_TRIES = 3                 # 같은 버전을 이만큼 시도해도 못 고르면 그만둔다(다음 버전·다시 매기기에서 다시 한다)
MAX_PER_CYCLE = 8             # 한 번에 부르는 수. 서버가 느려지지 않게 나눠서 한다

TAG_SCHEMA = 2                # 행의 어휘 판(v). 업무 태그가 생긴 2 보다 옛 행은 다시 분류한다(그동안 옛 태그는 그대로 보인다)

# 기능 태그: id → LLM 에게 주는 뜻풀이(영어). 표시 이름은 화면 번역(market.tag.<id>)에 있다. 이 목록 밖의 값은 버린다.
VOCAB = {
    "code-quality": "code review, refactoring, simplification, debugging, code health",
    "dev-workflow": "software process: git, CI/CD, planning, TDD, migration, parallel/sub-agent workflows, shipping",
    "testing": "testing and verification of software or web apps",
    "api-design": "API, interface and architecture design",
    "design": "UI/UX, frontend design, branding, visual art, themes",
    "image": "image generation or image-to-code",
    "docs": "documentation, technical writing, communication, text editing",
    "agent": "using agents better: context engineering, skills authoring, memory, subagents, prompting",
    "automation": "tools and automation: browser, CLI, PDF, office suites, scheduled tasks",
    "data": "knowledge, ontology, data and information structuring",
    "learning": "guides, tutorials, learning resources",
    "trial": "internal install-path test packages",
}


def _work_vocab() -> dict[str, str]:
    """업무 태그: 업무 템플릿(soul_templates.CATALOG)과 같은 id 10개 + common. 뜻풀이는 그 표의 영어 이름과 부서 키워드를 그대로 쓴다
    — 에이전트의 부서·업무 템플릿과 같은 말로 이어지게(스펙 2026-11-17-003). 화면 순서는 이 순서다."""
    from ..common.soul_templates import CATALOG
    out = {tid: f"{en} ({kw})" for tid, _ko, en, kw in CATALOG}
    out["engineering"] += "; any software development, code, testing, devops or infrastructure work"
    out["common"] = ("not tied to one job: general tools any role uses — file/document conversion, OCR, notes, maps, search, "
                     "messaging, personal productivity, using the AI agent itself")
    return out


WORK = _work_vocab()
ALL = {**WORK, **VOCAB}         # 두 어휘는 id 가 겹치지 않는다(시험이 지킨다)
MAX_KIND = MAX_TAGS - 1         # 업무 하나 + 기능 둘까지


def _path() -> Path:
    return store.data_dir() / "market" / TAGS


def load() -> dict:
    try:
        data = json.loads(_path().read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def _save(table: dict) -> None:
    path = _path()
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f"{path.name}.{os.getpid()}.tmp")
    tmp.write_text(json.dumps(table, ensure_ascii=False, indent=1, sort_keys=True), encoding="utf-8")
    os.replace(tmp, path)                                  # 두 서버가 같은 볼륨에 써도 읽는 쪽은 늘 온전한 파일을 본다


# ---- 이름 접두어 → 업무(관리자 설정, 스펙 2026-11-17-003 §3-3) ----------------------------------------------------------
# 팀이 스킬 이름에 접두어를 붙이는 설치(COP: sa- 영업, ma- 마케팅)는 LLM 이 「하는 일」로 고른 업무 대신 팀 업무를 쓴다.
# 설치마다 규칙이 달라 코드에 넣지 않고 관리자가 화면에서 정한다. 분류 결과(tags.json)는 그대로 두고 읽을 때 바꾸므로 규칙을 바꾸면 바로 보인다.
PREFIX_MAX = 30                 # 규칙 수
PREFIX_LEN = 24                 # 접두어 길이
_PREFIX_RE = re.compile(r"^[a-z0-9][a-z0-9_.-]*$")


def clean_prefixes(rules) -> list[dict]:
    """[{prefix, work}] 를 검사해 정리한다(소문자, 앞뒤 공백 제거, 같은 접두어는 뒤의 것). 맞지 않으면 ValueError."""
    if not isinstance(rules, list):
        raise ValueError("rules must be a list")
    out: dict[str, str] = {}
    for r in rules:
        prefix = str((r or {}).get("prefix") or "").strip().lower() if isinstance(r, dict) else ""
        work = str((r or {}).get("work") or "").strip() if isinstance(r, dict) else ""
        if not prefix and not work:
            continue                                       # 화면의 빈 줄
        if not prefix or len(prefix) > PREFIX_LEN or not _PREFIX_RE.match(prefix):
            raise ValueError(f"bad prefix: {prefix!r}")
        if work not in WORK:
            raise ValueError(f"unknown work: {work!r}")
        out.pop(prefix, None)
        out[prefix] = work
    if len(out) > PREFIX_MAX:
        raise ValueError(f"too many rules (max {PREFIX_MAX})")
    return [{"prefix": k, "work": v} for k, v in out.items()]


def work_prefixes() -> list[dict]:
    """저장된 규칙. 읽지 못하거나 모양이 틀리면 빈 목록(태그 읽기를 막지 않는다)."""
    try:
        from ..common import settings
        raw = settings.work_prefixes_raw()
        return clean_prefixes(json.loads(raw)) if raw else []
    except Exception:
        return []


def set_work_prefixes(rules, who: str = "local") -> list[dict]:
    clean = clean_prefixes(rules)
    from ..common import settings
    settings.set_work_prefixes_raw(json.dumps(clean, ensure_ascii=False), who)
    return clean


def prefix_work(name: str, rules: list[dict]) -> str:
    """이름에 맞는 가장 긴 접두어의 업무(없으면 빈 문자열). 대소문자를 가리지 않는다."""
    low = (name or "").lower()
    hits = [r for r in rules if low.startswith(r["prefix"])]
    return max(hits, key=lambda r: len(r["prefix"]))["work"] if hits else ""


def with_prefix(name: str, got: list[str], rules: list[dict] | None = None) -> list[str]:
    """접두어 규칙이 맞으면 업무를 그 업무로 바꾼다(기능 태그는 그대로). 아직 분류하지 않은 스킬도 업무 하나는 보인다."""
    work = prefix_work(name, work_prefixes() if rules is None else rules)
    if not work:
        return got
    return [work, *[t for t in got if t not in WORK]][:MAX_TAGS]


def row_tags(table: dict, pkg_id: str, rules: list[dict] | None = None) -> list[str]:
    """표에서 이 패키지의 태그. 표가 없거나 행이 없거나 모양이 틀리면 빈 목록이고, 어휘 밖의 값은 거른다.
    마켓 행(`<네임스페이스>/<이름>`)은 이름 접두어 규칙을 적용한다. 스킬 행(내용 키)은 이름을 모르므로 skill_tags 가 적용한다."""
    row = table.get(pkg_id)
    got = row.get("tags") if isinstance(row, dict) else None
    clean = [t for t in got if isinstance(t, str) and t in ALL] if isinstance(got, list) else []
    if pkg_id.startswith(SKILL_PREFIX):
        return clean
    return with_prefix(pkg_id.rsplit("/", 1)[-1], clean, rules)


def parse_answer(text: str) -> list[str]:
    """모델 답 {"work": 업무, "tags": [기능…]} 에서 [업무, 기능…](기능은 어휘 안의 것만, 중복 없이 2개까지).
    업무가 없거나 어휘 밖이면 빈 목록이다(실패로 세어 다시 묻는다) — 업무가 없는 행을 남기지 않는다.
    업무 자리에 기능 id 를 쓴 답은 그 id 를 기능으로 옮기고 업무를 common 으로 둔다."""
    m = re.search(r"\{[^{}]*\}", text or "")
    if not m:
        return []
    try:
        obj = json.loads(m.group(0))
    except ValueError:
        return []
    work = obj.get("work") if isinstance(obj, dict) else None
    kinds: list[str] = []
    if isinstance(work, str) and work in VOCAB:            # 업무 자리에 기능 id(COP 실측: industrial-brutalist-ui → "design").
        kinds.append(work)                                 # temperature 0 이라 다시 물어도 같은 답이므로 기능으로 옮기고 공통으로 둔다
        work = "common"
    if not isinstance(work, str) or work not in WORK:
        return []
    got = obj.get("tags")
    for t in got if isinstance(got, list) else []:
        if isinstance(t, str) and t in VOCAB and t not in kinds:
            kinds.append(t)
    return [work, *kinds[:MAX_KIND]]


def _prompt(name: str, summary: str) -> list[dict]:
    work = "\n".join(f"- {k}: {v}" for k, v in WORK.items())
    vocab = "\n".join(f"- {k}: {v}" for k, v in VOCAB.items())
    system = ("You label AI-agent skills for a company catalog.\n"
              "1) work: the ONE job function whose people use this skill in their daily work. Use \"common\" only when it is not tied to a job. "
              f"Choose from:\n{work}\n"
              f"2) tags: 0 to {MAX_KIND} ids for what the skill does, from:\n{vocab}\n"
              "Answer with one JSON object and nothing else. Examples: a skill that drafts customer quotes as PDF -> "
              "{\"work\": \"sales\", \"tags\": [\"docs\"]}; a skill that converts HWP files to Markdown -> "
              "{\"work\": \"common\", \"tags\": [\"docs\", \"automation\"]}.")
    return [{"role": "system", "content": system}, {"role": "user", "content": f"name: {name}\ndescription: {summary[:400]}"}]


def assist_model(var: str) -> str:
    """사람이 친 글이 없는 AI 보조(스킬 태그·요약·번역)의 별칭. 설치가 정한 `var` 가 우선이고, 없으면 쿠버네티스는
    가드레일 제외 별칭(AAS_GUARDRAIL_EXCLUDE_MODELS, 기본 cogentai-aas-aux)으로 보낸다 — SKILL.md 를 주 모델로 보내
    가드레일이 jailbreak 로 막았다(OMAI-1500, 스펙 2026-10-27-003 G1). compose 에는 그 별칭이 없어 cogentai-aas 그대로다."""
    chosen = config.get_or_empty(var, "").strip()
    if chosen:
        return chosen
    from ..ops import models
    if models.k8s_mode():
        from ..fleet.profiles import DEFAULT_EXCLUDE_MODELS, excluded_models
        aux = excluded_models()
        if aux:
            return DEFAULT_EXCLUDE_MODELS if DEFAULT_EXCLUDE_MODELS in aux else sorted(aux)[0]
    return "cogentai-aas"


def typed_text_model() -> str:
    """사람이 친 값을 보내는 AI 보조(부서 슬로건·카드 나누기)의 별칭 — 에이전트와 같은 모델이라 가드레일이 검사한다."""
    return config.get_or_empty("HERMES_LLM_MODEL", "").strip() or "cogentai-aas"


def _model() -> str:
    return assist_model("AAS_MARKET_TAG_MODEL")


def _configured() -> bool:
    """AI 보조(태그·요약·슬로건·카드 나누기)를 켤 수 있는가. 쿠버네티스는 운영 LiteLLM 주소 + 키,
    아니면(compose) 주소만 있으면 된다 — 키 없는 Ollama 도 쓰게(스펙 2026-10-21-015 R10)."""
    from ..ops import models
    if models.k8s_mode():
        return bool(models.litellm_url() and models._resolve_key("")[0])
    return bool(models.api_base())


def request_body(messages: list[dict], model: str = "", max_tokens: int = 60, temperature: float = 0) -> dict:
    """대화 호출 본문. cogentai-aas 는 추론 모델이라 생각을 끄지 않으면 max_tokens 를 생각에 다 써서 답이 빈다(2026-10-17 OKE 확인).
    스킬 AI 요약(summary.py)도 같은 호출을 모델·길이만 바꿔 쓴다."""
    body = {"model": model or _model(), "messages": messages, "temperature": temperature, "max_tokens": max_tokens}
    # 생각 끄기는 vLLM 계열의 확장이다. 모르는 인자를 거절하는 서버(OpenAI 공식 API 등)면 AAS_CHAT_TEMPLATE_KWARGS=off 로 뺀다(R10)
    if config.get("AAS_CHAT_TEMPLATE_KWARGS").strip().lower() not in ("off", "0", "false", "no"):
        body["chat_template_kwargs"] = {"enable_thinking": False}
    return body


def _chat(messages: list[dict], timeout: float = 60, **opts) -> str:
    """LLM 대화 호출 하나(키·주소는 모델 화면과 같은 설정, models.api_base). opts 는 request_body 의 model·max_tokens·temperature.
    timeout 은 소켓 동작마다의 초다. 답 저장 채우기는 50초 마감의 남은 시간을 준다(스펙 2026-11-18-012 D24③)."""
    from ..ops import models
    key, _ = models._resolve_key("")
    body = json.dumps(request_body(messages, **opts)).encode()
    req = urllib.request.Request(models.api_base() + "/chat/completions", data=body,
                                 headers={**models._auth_headers(key), "Content-Type": "application/json"})
    with netcache.urlopen(req, timeout=max(1.0, float(timeout))) as resp:
        data = json.loads(resp.read())
    return str(((data.get("choices") or [{}])[0].get("message") or {}).get("content") or "")


# 가드레일이 200 답 본문을 바꿔 막은 경우를 알아보는 구절. 출처는 openmaru-cogentai docker/litellm-plugins/aas_guardrail_hook.py 의 BLOCKED_NOTICE
# (「🚫 죄송합니다. 입력하신 내용이 정책에 위반되어 처리할 수 없습니다.」). 핵심 구절만 보고, 정책을 설명하는 긴 답을 잘못 보지 않도록
# GUARD_MAX 자 이하일 때만 차단으로 본다. 회의(office/meeting.py)와 답 저장 채우기가 함께 쓴다(스펙 2026-10-20-026 R6, 2026-11-18-012 §8-6)
GUARD_PHRASE = "정책에 위반되어 처리할 수 없습니다"  # i18n-ignore: 훅 차단 안내를 알아보는 구절(비교용)
GUARD_MAX = 80


def guardrail_reply(text: str) -> bool:
    """가드레일이 200 답 본문을 차단 안내로 바꾼 답인가."""
    text = (text or "").strip()
    return 0 < len(text) <= GUARD_MAX and GUARD_PHRASE in text


def guardrail_blocked(exc: urllib.error.HTTPError) -> bool:
    """LiteLLM 가드레일이 거절한 응답인가(오류 본문에 guardrail·blocked). AI 보조 호출이 함께 쓴다 —
    카드 나누기·부서 슬로건·스킬 설명 번역·스킬 AI 요약·답 저장 채우기(스펙 2026-11-18-012 D24⑧)."""
    detail = error_detail(exc)
    return "guardrail" in detail or "blocked" in detail


def error_detail(exc: urllib.error.HTTPError) -> str:
    """오류 본문(소문자). 본문은 한 번만 읽을 수 있어 예외에 남겨 둔다 — 가드레일·맥락 길이 판별이 함께 본다."""
    cached = getattr(exc, "_aas_detail", None)
    if cached is None:
        try:
            cached = exc.read().decode("utf-8", errors="replace").lower()
        except Exception:
            cached = ""
        try:
            exc._aas_detail = cached
        except Exception:
            pass
    return cached

SKILL_PREFIX = "skill:"
SKILL_VERSION = "1"           # 스킬 행의 키가 내용(이름+설명)이라 버전 비교는 필요 없다. 다시 매기기(reset)가 「for」 를 비워 다시 분류하게 한다


def skill_key(name: str, description: str = "") -> str:
    """스킬 화면의 태그 행 키(OMAI-1283). 이름과 설명 내용으로 정한다 — 같은 내용(Hermes 기본 스킬은 모두 같다)은 한 번만 분류해 나누고,
    같은 이름이라도 설명이 다르면 서로의 태그를 덮지 않는다. 이름·설명 자체는 저장하지 않는다."""
    return SKILL_PREFIX + hashlib.sha1(f"{name}\n{description}".encode("utf-8")).hexdigest()[:12]


def _market_row_for(table: dict, name: str) -> str:
    """마켓 표에서 이름이 같은 패키지 행의 키(`<네임스페이스>/<이름>`). 분류한 태그가 있는 것만, 없으면 빈 문자열(접두어 규칙은 보지 않는다)."""
    for k in sorted(table):
        if not k.startswith(SKILL_PREFIX) and k.rsplit("/", 1)[-1] == name and row_tags(table, k, rules=[]):
            return k
    return ""


def skill_tags(table: dict, name: str, description: str, origin: str, rules: list[dict] | None = None) -> list[str]:
    """스킬 한 개의 태그. 마켓에서 설치한 스킬(origin=market)은 마켓의 같은 이름 패키지 태그를 그대로 쓴다(두 화면이 다른 태그를 달지 않게).
    이름 접두어 규칙(관리자 설정)을 적용한다. rules 를 주면 저장된 규칙을 다시 읽지 않는다(목록에서 행마다 부를 때)."""
    if origin == "market":
        k = _market_row_for(table, name)
        if k:
            return row_tags(table, k, rules)
    return with_prefix(name, row_tags(table, skill_key(name, description)), rules)


def _needs(row, version: str) -> bool:
    if not isinstance(row, dict):
        return True
    if row.get("v") != TAG_SCHEMA and row.get("try_v") != TAG_SCHEMA:
        return True                                        # 업무 태그 전의 옛 행(옛 태그는 새 값이 올 때까지 보인다)
    if row.get("for") == version and row.get("v") == TAG_SCHEMA:
        return False
    return not (row.get("try_for") == version and int(row.get("tries") or 0) >= MAX_TRIES)


def _skill_items(skills, table: dict) -> list[dict]:
    """분류할 스킬 항목: 내용 키마다 하나. 마켓에서 설치한 스킬은 마켓 태그가 있으면 건너뛴다."""
    seen: dict[str, dict] = {}
    for sk in skills:
        name, desc, origin = str(sk.get("name") or ""), str(sk.get("description") or ""), str(sk.get("origin") or "")
        if not name or (origin == "market" and _market_row_for(table, name)):
            continue
        key = skill_key(name, desc)
        seen.setdefault(key, {"id": key, "name": name, "summary": desc, "version": SKILL_VERSION})
    return list(seen.values())


def sync_once(ask=None, limit: int = MAX_PER_CYCLE, skills=None, prune: bool = True) -> dict:
    """태그가 없거나 버전이 바뀐 패키지·스킬을 limit 개까지 분류한다. 돌려주는 값: tagged·failed·pending(이번에 못 한 남은 수).
    skills 는 스킬 화면이 보이는 스킬 목록({name, description, origin}). None 이면(모으지 못한 주기) 스킬 행을 건드리지 않는다.
    prune=False 면 분류만 하고 옛 행은 지우지 않는다(일부 POD 를 못 읽어 목록이 모자랄 때)."""
    out = {"tagged": 0, "failed": 0, "pending": 0}
    if ask is None:
        if not _configured():
            return out
        ask = _chat
    from . import marketplace as mk
    try:
        rows = mk.catalog()
    except mk.MarketError:
        rows = []                                          # 마켓을 못 읽어도 스킬은 분류한다
    items = [{"id": r["id"], "name": r["name"], "summary": r["summary"], "version": r["version"]} for r in rows]
    if skills is not None:
        wanted = _skill_items(skills, load())
        items += wanted
        keep = {i["id"] for i in wanted} | {skill_key(str(s.get("name") or ""), str(s.get("description") or "")) for s in skills}
        table = load()
        stale = [k for k in table if prune and k.startswith(SKILL_PREFIX) and k not in keep]
        if stale:                                          # 내용이 바뀌거나 사라진 스킬의 옛 행을 정리한다. 마켓 행은 건드리지 않는다
            for k in stale:
                del table[k]
            _save(table)
    todo = [r for r in items if _needs(load().get(r["id"]), r["version"])]
    for r in todo[:limit]:
        table = load()                                     # 호출 직전에 다시 읽는다 — 그사이 다른 서버가 채웠을 수 있다
        old = table.get(r["id"]) if isinstance(table.get(r["id"]), dict) else {}
        if not _needs(old, r["version"]):
            continue
        try:
            got = parse_answer(ask(_prompt(r["name"], r["summary"])))
        except Exception:                                  # 모델 호출 실패는 시도로 센다(서버를 멈추지 않는다)
            got = []
        if got:
            table[r["id"]] = {"tags": got, "for": r["version"], "v": TAG_SCHEMA, "at": time.strftime("%Y-%m-%dT%H:%M:%S%z"), "tries": 0, "by": "llm"}
            out["tagged"] += 1
        else:
            tries = int(old.get("tries") or 0) + 1 if old.get("try_for") == r["version"] else 1
            table[r["id"]] = {**old, "tags": old.get("tags") or [], "for": old.get("for", ""), "try_for": r["version"], "try_v": TAG_SCHEMA, "tries": tries}
            out["failed"] += 1
        _save(table)
    out["pending"] = max(0, len(todo) - limit) if len(todo) > limit else 0
    return out


def may_refresh(auth_enabled: bool, admin: bool) -> bool:
    """전체 다시 분류는 관리자만(로그인을 쓰지 않는 설치는 모두)."""
    return (not auth_enabled) or admin


def reset() -> int:
    """모든 행을 「다시 분류할 것」으로 표시한다. 새 값이 올 때까지 옛 태그는 그대로 보인다. 표시한 행 수를 돌려준다."""
    table = load()
    for k, row in table.items():
        if isinstance(row, dict):
            row.update({"for": "", "tries": 0, "try_for": ""})
    if table:
        _save(table)
    return len(table)

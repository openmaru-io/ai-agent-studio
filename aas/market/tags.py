# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""스킬 허브 태그(OMAI-1275) — 스킬마다 정해진 어휘에서 1~3개를 LLM 이 골라 `AAS_DATA_DIR/market/tags.json` 에 둔다.

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

# id → LLM 에게 주는 뜻풀이(영어). 표시 이름은 화면 번역(market.tag.<id>)에 있다. 이 목록 밖의 값은 버린다.
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


def row_tags(table: dict, pkg_id: str) -> list[str]:
    """표에서 이 패키지의 태그. 표가 없거나 행이 없거나 모양이 틀리면 빈 목록이고, 어휘 밖의 값은 거른다."""
    row = table.get(pkg_id)
    got = row.get("tags") if isinstance(row, dict) else None
    return [t for t in got if isinstance(t, str) and t in VOCAB] if isinstance(got, list) else []


def parse_answer(text: str) -> list[str]:
    """모델 답에서 첫 JSON 배열을 찾아 어휘 안의 id 만 순서대로, 중복 없이 최대 3개."""
    m = re.search(r"\[[^\[\]]*\]", text or "")
    if not m:
        return []
    try:
        arr = json.loads(m.group(0))
    except ValueError:
        return []
    out: list[str] = []
    for t in arr if isinstance(arr, list) else []:
        if isinstance(t, str) and t in VOCAB and t not in out:
            out.append(t)
    return out[:MAX_TAGS]


def _prompt(name: str, summary: str) -> list[dict]:
    vocab = "\n".join(f"- {k}: {v}" for k, v in VOCAB.items())
    system = ("You label AI-agent skills for a catalog. Choose 1 to 3 tag ids that best describe what the skill does, "
              f"using ONLY ids from this list:\n{vocab}\nAnswer with a JSON array of tag ids and nothing else, e.g. [\"design\", \"image\"].")
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


def _chat(messages: list[dict], **opts) -> str:
    """LLM 대화 호출 하나(키·주소는 모델 화면과 같은 설정, models.api_base). opts 는 request_body 의 model·max_tokens·temperature."""
    from ..ops import models
    key, _ = models._resolve_key("")
    body = json.dumps(request_body(messages, **opts)).encode()
    req = urllib.request.Request(models.api_base() + "/chat/completions", data=body,
                                 headers={**models._auth_headers(key), "Content-Type": "application/json"})
    with netcache.urlopen(req, timeout=60) as resp:
        data = json.loads(resp.read())
    return str(((data.get("choices") or [{}])[0].get("message") or {}).get("content") or "")


SKILL_PREFIX = "skill:"
SKILL_VERSION = "1"           # 스킬 행의 키가 내용(이름+설명)이라 버전 비교는 필요 없다. 다시 매기기(reset)가 「for」 를 비워 다시 분류하게 한다


def skill_key(name: str, description: str = "") -> str:
    """스킬 화면의 태그 행 키(OMAI-1283). 이름과 설명 내용으로 정한다 — 같은 내용(Hermes 기본 스킬은 모두 같다)은 한 번만 분류해 나누고,
    같은 이름이라도 설명이 다르면 서로의 태그를 덮지 않는다. 이름·설명 자체는 저장하지 않는다."""
    return SKILL_PREFIX + hashlib.sha1(f"{name}\n{description}".encode("utf-8")).hexdigest()[:12]


def _market_row_for(table: dict, name: str) -> str:
    """마켓 표에서 이름이 같은 패키지 행의 키(`<네임스페이스>/<이름>`). 태그가 있는 것만, 없으면 빈 문자열."""
    for k in sorted(table):
        if not k.startswith(SKILL_PREFIX) and k.rsplit("/", 1)[-1] == name and row_tags(table, k):
            return k
    return ""


def skill_tags(table: dict, name: str, description: str, origin: str) -> list[str]:
    """스킬 한 개의 태그. 마켓에서 설치한 스킬(origin=market)은 마켓의 같은 이름 패키지 태그를 그대로 쓴다(두 화면이 다른 태그를 달지 않게)."""
    if origin == "market":
        k = _market_row_for(table, name)
        if k:
            return row_tags(table, k)
    return row_tags(table, skill_key(name, description))


def _needs(row, version: str) -> bool:
    if not isinstance(row, dict):
        return True
    if row.get("for") == version:
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
            table[r["id"]] = {"tags": got, "for": r["version"], "at": time.strftime("%Y-%m-%dT%H:%M:%S%z"), "tries": 0, "by": "llm"}
            out["tagged"] += 1
        else:
            tries = int(old.get("tries") or 0) + 1 if old.get("try_for") == r["version"] else 1
            table[r["id"]] = {**old, "tags": old.get("tags") or [], "for": old.get("for", ""), "try_for": r["version"], "tries": tries}
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

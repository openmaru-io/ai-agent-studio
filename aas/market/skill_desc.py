# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""스킬 설명의 한국어 번역(스펙 2026-10-19-017, OMAI-1356).

- 미리 만든 번역은 이미지 안 파일(`aas/assets/skill_desc_ko.json`, 사람이 검토), LLM 이 만든 번역은 데이터 폴더
  `AAS_DATA_DIR/market/skill_desc.json` 에 둔다(D1). 번역 표는 리더만 쓴다(D8).
- 키는 「이름 소문자 + 공백을 모은 설명 앞 120자」의 해시라 160·200·240자로 자른 같은 설명이 같은 번역을 찾는다(P1).
  키는 응답하는 서버가 가리지 않은 원문으로 내고, 리더는 다시 계산하지 않는다(redact 가 앞부분을 바꿔 키가 어긋난다, D8).
- 응답 길이 번역을 못 찾으면 (키·이름·가린 글)을 메모리에 모아 60초에 한 번 서버마다 따로 대기 파일에 쓴다(D7).
  리더 루프가 대기 파일들을 합쳐 10분마다 8개씩 번역한다(P4).
- 저장값(스킬 묶음·/ 목록·흐름)은 고치지 않고 응답 사본에만 붙인다. 태그 키·태그 분류가 원문을 보기 때문이다(D9).
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import socket
import threading
import time
import urllib.error
from pathlib import Path

from ..common import config, store
from ..common.i18n import get_lang
from ..common.redact import redact

TABLE = "skill_desc.json"
PENDING_PREFIX = "skill_desc_pending."
KEY_CHARS = 120
SRC_MAX = 400
MAX_TRIES = 3
MAX_PER_CYCLE = 8
FLUSH_EVERY = 60.0
PENDING_STALE = 1800.0            # 30분 넘게 바뀌지 않은 대기 파일은 사라진 서버의 것으로 보고 지운다
MIN_CHARS = 10                    # 공백을 뺀 글자가 이보다 적은 설명은 번역하지 않는다(D9)

_HANGUL = re.compile(r"[가-힣]")  # i18n-ignore: 한글 판정 패턴
_YAML_MARK = re.compile(r"^[>|][-+]?$")
_SEED_DEFAULT = Path(__file__).resolve().parent.parent / "assets" / "skill_desc_ko.json"

# 번역할 때 붙이는 용어 표(미리 만든 번역과 같은 표). 표기는 docs-kb/WRITING_STYLE.md 를 따른다
GLOSSARY = {  # i18n-ignore: LLM 프롬프트에 붙이는 용어 표
    "skill": "스킬", "agent": "에이전트", "repository": "저장소", "workflow": "작업 흐름", "prompt": "프롬프트",  # i18n-ignore: 용어 표
    "issue": "이슈", "pull request": "풀 리퀘스트", "commit": "커밋", "branch": "브랜치", "deploy": "배포",  # i18n-ignore: 용어 표
    "dashboard": "대시보드", "browser": "브라우저", "file": "파일", "folder": "폴더", "search": "검색",  # i18n-ignore: 용어 표
}


# ---- 키·판정 -----------------------------------------------------------------
def _norm(text: str) -> str:
    return " ".join(str(text or "").split())


def desc_key(name: str, description: str) -> str:
    """이름 + 공백을 모은 설명 앞 120자의 해시(16자). 자르는 길이가 다른 세 길이 같은 키를 낸다."""
    return hashlib.sha1(f"{str(name or '').lower()}\n{_norm(description)[:KEY_CHARS]}".encode("utf-8")).hexdigest()[:16]


def has_hangul(text: str) -> bool:
    return bool(_HANGUL.search(text or ""))


def worth(description: str) -> bool:
    """번역할 만한 설명인가: 공백을 뺀 글자가 10자 이상이고 YAML 블록 표시(>-·| 등)뿐이 아니고 한글이 없다."""
    s = _norm(description)
    return len(s.replace(" ", "")) >= MIN_CHARS and not _YAML_MARK.match(s) and not has_hangul(s)


# ---- 파일 읽기(바뀔 때만) -----------------------------------------------------------
def _dir() -> Path:
    return store.data_dir() / "market"


def _table_path() -> Path:
    return _dir() / TABLE


def _seed_path() -> Path:
    v = config.get_or_empty("AAS_SKILL_DESC_SEED", "").strip()   # 시험은 빈 파일 경로를 줘서 기존 기대값이 바뀌지 않게 한다
    return Path(v) if v else _SEED_DEFAULT


_files: dict[str, tuple[tuple, dict]] = {}
_files_lock = threading.Lock()
reads = {"n": 0}                   # 실제로 파일을 읽은 횟수(시험용)


def _read_json(path: Path) -> dict:
    """파일이 바뀌었을 때만(st_mtime_ns·st_ino·st_size) 다시 읽는다. os.replace 가 inode 를 바꾸고 NFS 는 속성을 늦게 갱신해 셋을 함께 본다."""
    try:
        st = path.stat()
    except OSError:
        return {}
    sig = (st.st_mtime_ns, st.st_ino, st.st_size)
    k = str(path)
    with _files_lock:
        hit = _files.get(k)
        if hit and hit[0] == sig:
            return hit[1]
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        data = data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        data = {}
    reads["n"] += 1
    with _files_lock:
        _files[k] = (sig, data)
    return data


def load() -> dict:
    return _read_json(_table_path())


def seed() -> dict:
    return _read_json(_seed_path())


def _host() -> str:
    return re.sub(r"[^A-Za-z0-9_.-]", "_", socket.gethostname() or "local")[:80]


def _write_json(path: Path, data: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f"{path.name}.{_host()}.{os.getpid()}.tmp")   # 컨테이너는 PID 가 대개 1이라 호스트 이름을 넣는다(D8)
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=1, sort_keys=True), encoding="utf-8")
    os.replace(tmp, path)


# ---- 찾기 -----------------------------------------------------------------
def find(name: str, description: str) -> tuple[str, str] | None:
    """(번역, 출처 "llm"|"seed") 또는 None. 한국어 화면에서만 찾는다. 미리 만든 번역은 한글이 섞인 설명에도 쓴다(D11)."""
    if get_lang() != "ko" or not _norm(description):
        return None
    k = desc_key(name, description)
    row = load().get(k)
    if isinstance(row, dict) and row.get("ko"):
        return str(row["ko"]), "llm"
    row = seed().get(k)
    if isinstance(row, dict) and row.get("ko"):
        return str(row["ko"]), "seed"
    return None


def _cut(text: str, limit: int) -> str:
    return text if len(text) <= limit else text[: limit - 1] + "…"


def apply(rows, limit: int, field: str = "description", full: str = "description_full") -> list[dict]:
    """응답 행의 사본에 번역을 붙인다: field(번역, limit 로 자름)·<field>_src(원문)·<field>_by("llm"|"seed").
    번역이 없으면 원문 그대로이고, 번역할 만한 설명이면 대기에 올린다. full 필드(자르기 전 설명)는 키에만 쓰고 응답에서 뺀다.
    스킬 허브 패키지는 field="summary" 로 부른다(summary_src·summary_by)."""
    out = []
    for r in rows or []:
        if not isinstance(r, dict):
            out.append(r)
            continue
        r = dict(r)
        src_full = str(r.pop(full, "") or r.get(field) or "")
        name = str(r.get("name") or "")
        shown = str(r.get(field) or "")
        if name and shown:
            hit = find(name, src_full)
            if hit:
                r[field], r[f"{field}_src"], r[f"{field}_by"] = _cut(hit[0], limit), shown, hit[1]
            elif get_lang() == "ko" and worth(src_full):
                note_missing(name, src_full)
        out.append(r)
    return out


def translate_text(name: str, description: str, limit: int = 240) -> str:
    """글 하나를 요청 언어로(없으면 원문). 흐름 노드·크론 서랍처럼 행이 아닌 곳에 쓴다."""
    hit = find(name, description)
    if hit:
        return _cut(hit[0], limit)
    if get_lang() == "ko" and worth(description):
        note_missing(name, description)
    return description


# ---- 대기 기록(모든 서버) -----------------------------------------------------------
_missing: dict[str, dict] = {}
_missing_lock = threading.Lock()


def _pending_path(host: str = "") -> Path:
    return _dir() / f"{PENDING_PREFIX}{host or _host()}.json"


def note_missing(name: str, description: str, force: float = 0.0) -> str:
    """번역 대기에 올린다(메모리). 키는 원문으로, 글은 가린 글로 둔다. 다음 flush 가 대기 파일에 쓴다."""
    k = desc_key(name, description)
    item = {"name": str(name)[:120], "text": redact(description, SRC_MAX), "len": len(_norm(description))}
    if force:
        item["force"] = force
    with _missing_lock:
        cur = _missing.get(k)
        if cur is None or item["len"] > cur.get("len", 0) or force:
            _missing[k] = {**(cur or {}), **item}
    return k


def request_retranslate(name: str, description: str) -> str:
    """관리자 「다시 번역」(D8). 이 서버의 대기 파일에 force 행을 바로 쓴다. 표는 리더만 쓴다."""
    k = note_missing(name, description, force=time.time())
    flush()
    return k


def _done(row, item: dict) -> bool:
    """대기 행이 끝났는가: 표에 번역이 있고 더 긴 원문이 아니며 force 이후에 만든 것. 또는 시도를 다 썼다."""
    if not isinstance(row, dict):
        return False
    if item.get("force"):
        return float(row.get("ts") or 0) >= float(item["force"]) or (row.get("try_force") == item["force"] and int(row.get("tries") or 0) >= MAX_TRIES)
    if row.get("ko") and int(row.get("len") or 0) >= int(item.get("len") or 0):
        return True
    return int(row.get("tries") or 0) >= MAX_TRIES and int(row.get("try_len") or 0) >= int(item.get("len") or 0)


def flush() -> bool:
    """메모리 대기분을 이 서버의 대기 파일에 합쳐 쓰고, 끝난 행은 뺀다. 바뀐 것이 있을 때만 쓴다."""
    with _missing_lock:
        fresh = dict(_missing)
        _missing.clear()
    path = _pending_path()
    try:
        cur = json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}
        cur = cur if isinstance(cur, dict) else {}
    except (OSError, ValueError):
        cur = {}
    table, seeded = load(), seed()
    nxt = dict(cur)
    for k, item in fresh.items():
        old = nxt.get(k) or {}
        if not item.get("force") and (k in seeded) and not old.get("force"):
            continue
        nxt[k] = {**old, **item} if item.get("len", 0) >= old.get("len", 0) or item.get("force") else {**item, **old}
    nxt = {k: v for k, v in nxt.items() if isinstance(v, dict) and not _done(table.get(k), v)}
    if nxt == cur:
        return False
    if nxt:
        _write_json(path, nxt)
    else:
        try:
            path.unlink()
        except OSError:
            pass
    return True


# ---- LLM 번역 -----------------------------------------------------------------
class Blocked(Exception):
    pass


def _model() -> str:
    from . import tags
    return tags.assist_model("AAS_SKILL_DESC_MODEL")      # 사람 글이 없어 쿠버네티스는 가드레일 제외 별칭(OMAI-1500)


def prompt(name: str, text: str, previous: str = "") -> list[dict]:
    terms = ", ".join(f"{k} → {v}" for k, v in GLOSSARY.items())
    system = ("소프트웨어 스킬의 한 줄 설명을 자연스러운 한국어 한 문장으로 옮긴다. 제품·서비스 이름(Box, Notion, arXiv, GitHub 등), "   # i18n-ignore: LLM 프롬프트
              f"명령, 파일 이름, 코드는 원문 그대로 둔다. 번역문만 답한다. 용어: {terms}")                                         # i18n-ignore: LLM 프롬프트
    user = f"스킬 이름: {name}\n설명: {text}"                                                                                       # i18n-ignore: LLM 프롬프트
    if previous:
        user += f"\n이전 번역: {previous}\n이와 다르게 더 자연스럽게 옮긴다."                                                             # i18n-ignore: LLM 프롬프트
    return [{"role": "system", "content": system}, {"role": "user", "content": user}]


_HEAD = re.compile(r"^\s*(번역(문)?|한국어|Korean|Translation)\s*[:：]\s*", re.I)   # i18n-ignore: 모델 답의 머리를 떼는 패턴


def parse_answer(text: str, source: str) -> str | None:
    """한 줄로 모으고 머리·따옴표를 떼어 검사한다. 한글이 없거나 원문 3배·400자를 넘으면 None."""
    s = _norm(text)
    s = _HEAD.sub("", s).strip()
    if len(s) >= 2 and s[0] in "\"'「“" and s[-1] in "\"'」”":
        s = s[1:-1].strip()
    if not s or not has_hangul(s) or len(s) > SRC_MAX or len(s) > 3 * max(len(_norm(source)), 20):
        return None
    return s


def _ask(messages: list[dict], temperature: float) -> str:
    from . import tags
    try:
        return tags._chat(messages, model=_model(), max_tokens=200, temperature=temperature)
    except urllib.error.HTTPError as exc:          # 가드레일 차단 판정은 스킬 AI 요약(summary.py)과 같다
        detail = ""
        try:
            detail = exc.read().decode("utf-8", errors="replace").lower()
        except Exception:
            pass
        if "guardrail" in detail or "blocked" in detail:
            raise Blocked() from exc
        raise


def translate_once(name: str, text: str, previous: str = "", ask=None) -> str | None:
    """번역 하나. 실패(차단·답 검사·호출 실패)면 None. 다시 번역은 이전 번역을 보이고 temperature 0.3(D9)."""
    temperature = 0.3 if previous else 0.0
    try:
        raw = (ask or _ask)(prompt(name, text, previous), temperature)
    except Blocked:
        store.log_usage("skill_desc_translate", f"{name} blocked")
        return None
    except Exception:
        return None
    got = parse_answer(raw, text)
    store.log_usage("skill_desc_translate", f"{name} {'ok' if got else 'bad_answer'}")
    return got


# ---- 리더 일괄 -----------------------------------------------------------------
def _configured() -> bool:
    from . import tags
    return tags._configured()


def _pending_items() -> dict[str, dict]:
    """모든 서버의 대기 파일을 합친다(같은 키는 force 가 늦은 것, 그다음 긴 원문). 30분 넘게 바뀌지 않은 파일은 지운다."""
    out: dict[str, dict] = {}
    now = time.time()
    try:
        files = sorted(_dir().glob(f"{PENDING_PREFIX}*.json"))
    except OSError:
        files = []
    for p in files:
        try:
            if now - p.stat().st_mtime > PENDING_STALE:
                p.unlink()
                continue
            data = json.loads(p.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        for k, v in (data.items() if isinstance(data, dict) else []):
            if not isinstance(v, dict) or not v.get("text"):
                continue
            cur = out.get(k)
            if cur is None or float(v.get("force") or 0) > float(cur.get("force") or 0) or (
                    not v.get("force") and not cur.get("force") and int(v.get("len") or 0) > int(cur.get("len") or 0)):
                out[k] = v
    return out


def sync_once(skills=None, ask=None, limit: int = MAX_PER_CYCLE) -> dict:
    """리더만 부른다. 대기 행 + skills(스킬 화면 목록 {name, description})에서 번역할 것을 limit 개까지. 돌려주는 값: done·failed·pending."""
    out = {"done": 0, "failed": 0, "pending": 0}
    if ask is None and not _configured():
        return out
    items = _pending_items()
    seeded = seed()
    for sk in skills or []:
        name, desc = str(sk.get("name") or ""), str(sk.get("description") or "")
        if not name or not worth(desc):
            continue
        k = desc_key(name, desc)
        if k in seeded or k in items:
            continue
        items[k] = {"name": name, "text": redact(desc, SRC_MAX), "len": len(_norm(desc))}
    table = load()
    todo = [(k, v) for k, v in items.items() if not _done(table.get(k), v)]
    for k, v in todo[:limit]:
        table = dict(load())
        old = table.get(k) if isinstance(table.get(k), dict) else {}
        if _done(old, v):
            continue
        previous = str(old.get("ko") or (seeded.get(k) or {}).get("ko") or "") if v.get("force") else ""
        got = translate_once(str(v.get("name") or ""), str(v["text"]), previous, ask)
        if got:
            table[k] = {"ko": got, "src": v["text"], "name": v.get("name", ""), "model": _model(),
                        "at": time.strftime("%Y-%m-%dT%H:%M:%S%z"), "ts": time.time(), "tries": 0, "len": int(v.get("len") or 0)}
            out["done"] += 1
        else:
            same = old.get("try_len") == v.get("len") and old.get("try_force") == v.get("force")
            tries = int(old.get("tries") or 0) + 1 if same else 1
            table[k] = {**old, "src": old.get("src") or v["text"], "name": v.get("name", ""), "tries": tries,
                        "try_len": int(v.get("len") or 0), **({"try_force": v["force"]} if v.get("force") else {})}
            out["failed"] += 1
        _write_json(_table_path(), table)
    out["pending"] = max(0, len(todo) - limit)
    return out

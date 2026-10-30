# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""회사 역할별 SOUL 템플릿. 계획 2026-10-13-009.

- 기본 템플릿: 이미지에 싣는 `aas/assets/soul_templates/<id>.<lang>.md`(읽기 전용). 이름·키워드는 아래 CATALOG.
- 고친 기본 템플릿과 사용자 템플릿: `soul_templates` 표, 키는 `(id, lang)`. 기본 템플릿을 고치면 같은 키로 행이 생기고,
  「처음으로 되돌리기」는 그 행을 지운다(파일 내용이 다시 보인다). 지우기는 행에 `deleted=1` 을 적는다(이전 판을 남기려고).
- 판: 저장할 때마다 `soul_template_versions` 에 그 판을 남긴다. 판 번호는 되돌리기 뒤에도 다시 쓰지 않는다.
- 적용 기록: `soul_template_uses`. 프로파일에 적용한 템플릿과 판을 남기고, 지금 판이 다르면 「템플릿이 바뀜」이다.
- 템플릿 본문에는 회사 소개 문장을 두지 않는다(결정 D1). 렌더할 때 `settings.identity_sentence()` 를 첫 줄로 붙인다.
"""
from __future__ import annotations

import re
import secrets
from datetime import datetime
from pathlib import Path

from . import settings, store
from .i18n import tr
from ..assets import files


def _person(value: str) -> str:
    """기록의 「누가」(이메일) → 화면에 보일 이름(2026-10-30). 오피스 모듈을 늦게 부른다."""
    from ..office import office
    return office.person_name(value)

LANGS = ("ko", "en")
NAME_MAX = 60
KEYWORDS_MAX = 300
ID = re.compile(r"^[a-z0-9][a-z0-9_-]{0,39}$")
PLACEHOLDERS = ("company", "department", "role", "agent")
ASSET_DIR = Path(__file__).resolve().parent.parent / "assets" / "soul_templates"

# 기본 템플릿 목록(화면 순서). keywords 는 부서 이름에 들어 있는지로 추천을 고를 때 쓴다(두 언어 공통).
CATALOG = (
    ("marketing", "마케팅", "Marketing", "마케팅, marketing, 홍보, 브랜드, brand, PR"),   # i18n-ignore: 템플릿 데이터(이름·부서 키워드)
    ("sales", "세일즈", "Sales", "세일즈, sales, 영업, 판매, 사업개발, business development"),   # i18n-ignore: 템플릿 데이터(이름·부서 키워드)
    ("research", "연구소", "Research", "연구, research, R&D, 랩, lab"),   # i18n-ignore: 템플릿 데이터(이름·부서 키워드)
    ("engineering", "엔지니어팀", "Engineering", "엔지니어, engineering, 개발, development, 기술, devops, SRE, 플랫폼"),   # i18n-ignore: 템플릿 데이터(이름·부서 키워드)
    ("general_affairs", "총무", "General affairs", "총무, general affairs, 경영지원, 구매, 시설, facilities"),   # i18n-ignore: 템플릿 데이터(이름·부서 키워드)
    ("accounting", "회계", "Accounting", "회계, accounting, 재무, finance, 경리"),   # i18n-ignore: 템플릿 데이터(이름·부서 키워드)
    ("hr", "인사", "HR", "인사, HR, human resources, 채용, 인재, people"),   # i18n-ignore: 템플릿 데이터(이름·부서 키워드)
    ("support", "고객지원", "Customer support", "고객지원, 고객, support, 기술지원, CS, 헬프데스크, helpdesk"),   # i18n-ignore: 템플릿 데이터(이름·부서 키워드)
    ("planning", "기획(PM)", "Planning (PM)", "기획, planning, PM, PMO, 프로덕트, product, 전략"),   # i18n-ignore: 템플릿 데이터(이름·부서 키워드)
    ("legal", "법무", "Legal", "법무, legal, 컴플라이언스, compliance, 계약"),   # i18n-ignore: 템플릿 데이터(이름·부서 키워드)
)

# Hermes 가 처음 뜰 때 SOUL.md 에 넣는 기본 문단에서 첫 문장을 뺀 나머지(hermes-agent/hermes_cli/default_soul.py, d10bb2ab6f).
# 첫 문장은 008 이 회사 문장으로 바꾸므로, 「기본 SOUL 뿐」은 첫 문장이 알고 있는 문장이고 나머지가 이 글과 같은지로 본다(리뷰 B1).
# Hermes 판을 올릴 때 default_soul.py 와 맞는지 본다(tests/test_soul_templates.py 가 사본을 지킨다).
HERMES_DEFAULT_REST = (
    "Be direct: match the length of your reply to the weight of "
    "the ask — a one-line question gets a one-line answer, and finished work gets a short report of what "
    "changed, what's verified, and what's left, never a replay of the process. No filler (\"Great question,\" "
    "\"I'd be happy to\"), no restating the request back, no re-summarizing what you already said, no narrating "
    "tool calls the user can see. Plain claims over adjectives; when unsure, say so plainly. Agree because it's "
    "right, not because the user said it. Depth is earned — give it when the user asks for detail, teaches, or "
    "the stakes demand it, not by default."
)

_SCHEMA = (
    "CREATE TABLE IF NOT EXISTS soul_templates (id TEXT NOT NULL, lang TEXT NOT NULL, name TEXT NOT NULL DEFAULT '', "
    "body TEXT NOT NULL DEFAULT '', keywords TEXT NOT NULL DEFAULT '', builtin INTEGER NOT NULL DEFAULT 0, rev INTEGER NOT NULL DEFAULT 0, "
    "updated_by TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL DEFAULT '', deleted INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (id, lang))",
    "CREATE TABLE IF NOT EXISTS soul_template_versions (id TEXT NOT NULL, lang TEXT NOT NULL, rev INTEGER NOT NULL, "
    "name TEXT NOT NULL DEFAULT '', body TEXT NOT NULL DEFAULT '', keywords TEXT NOT NULL DEFAULT '', by TEXT NOT NULL DEFAULT '', "
    "ts TEXT NOT NULL DEFAULT '', note TEXT NOT NULL DEFAULT '', PRIMARY KEY (id, lang, rev))",
    "CREATE TABLE IF NOT EXISTS soul_template_uses (pod TEXT NOT NULL, profile TEXT NOT NULL, template_id TEXT NOT NULL, "
    "lang TEXT NOT NULL, rev INTEGER NOT NULL DEFAULT 0, by TEXT NOT NULL DEFAULT '', ts TEXT NOT NULL DEFAULT '', PRIMARY KEY (pod, profile))",
)


class TemplateError(Exception):
    def __init__(self, message: str, code: int = 400):
        super().__init__(message)
        self.code = code


def _now() -> str:
    return datetime.now().astimezone().isoformat(timespec="seconds")


def _connect():
    conn = store.connect()
    for ddl in _SCHEMA:
        conn.execute(ddl)
    return conn


def _builtin_ids() -> list[str]:
    return [c[0] for c in CATALOG]


def builtin(tid: str, lang: str) -> dict | None:
    """이미지에 실린 기본 템플릿. 없으면 None."""
    meta = next((c for c in CATALOG if c[0] == tid), None)
    path = ASSET_DIR / f"{tid}.{lang}.md"
    if meta is None or lang not in LANGS or not path.is_file():
        return None
    return {"id": tid, "lang": lang, "name": meta[1] if lang == "ko" else meta[2], "body": path.read_text(encoding="utf-8"),
            "keywords": meta[3], "builtin": True, "rev": 0, "updated_by": "", "updated_at": "", "deleted": False, "modified": False}


def _row(r) -> dict:
    return {"id": str(r["id"]), "lang": str(r["lang"]), "name": str(r["name"]), "body": str(r["body"]), "keywords": str(r["keywords"]),
            "builtin": bool(r["builtin"]), "rev": int(r["rev"]), "updated_by": str(r["updated_by"]), "updated_by_name": _person(str(r["updated_by"])),
            "updated_at": str(r["updated_at"]),
            "deleted": bool(r["deleted"])}


def templates(include_deleted: bool = False) -> list[dict]:
    """기본 템플릿(CATALOG 순서, 언어별) 다음에 사용자 템플릿(이름 순). 고친 기본 템플릿은 표의 행이 파일보다 먼저다."""
    with _connect() as conn:
        rows = {(str(r["id"]), str(r["lang"])): _row(r) for r in conn.execute("SELECT * FROM soul_templates")}
    out = []
    for tid in _builtin_ids():
        for lang in LANGS:
            base = builtin(tid, lang)
            if base is None:
                continue
            row = rows.pop((tid, lang), None)
            item = {**row, "builtin": True, "modified": True} if row else base
            if item["deleted"] and not include_deleted:
                continue
            out.append(item)
    users = sorted((r for r in rows.values() if not r["builtin"]), key=lambda r: (r["name"].lower(), r["lang"]))
    out.extend({**r, "modified": False} for r in users if include_deleted or not r["deleted"])
    return out


def get(tid: str, lang: str, include_deleted: bool = False) -> dict | None:
    return next((t for t in templates(True) if t["id"] == tid and t["lang"] == lang and (include_deleted or not t["deleted"])), None)


def _clean_keywords(value) -> str:
    words = [" ".join(w.split()) for w in str(value or "").replace("\n", ",").split(",")]
    return ", ".join(w for w in words if w)[:KEYWORDS_MAX]


def _check_body(body: str) -> str:
    body = str(body or "").replace("\r\n", "\n")
    if not body.strip():
        raise TemplateError(tr("본문이 비어 있습니다", "The body is empty"))
    if "\x00" in body or len(body.encode("utf-8")) > files.MAX_BYTES:
        raise TemplateError(tr("저장할 수 없는 내용입니다", "This content cannot be saved"), 422)
    if files.MASK in body or files.has_secrets(body):
        raise TemplateError(tr("비밀값으로 보이는 줄이 있어 저장할 수 없습니다", "Lines that look like secrets cannot be saved"), 422)
    return body


def _next_rev(conn, tid: str, lang: str) -> int:
    row = conn.execute("SELECT MAX(rev) AS m FROM soul_template_versions WHERE id=? AND lang=?", (tid, lang)).fetchone()
    return int((row["m"] if row else 0) or 0) + 1


def save(body: dict, who: str) -> dict:
    """만들기(id 없음)·고치기. base_rev 가 지금 버전과 다르면 409(그사이 다른 사람이 고쳤다)."""
    tid, lang = str(body.get("id") or "").strip(), str(body.get("lang") or "").strip()
    if lang not in LANGS:
        raise TemplateError(tr("언어는 ko 나 en 이어야 합니다", "The language must be ko or en"))
    name = " ".join(str(body.get("name") or "").split())
    if not name or len(name) > NAME_MAX:
        raise TemplateError(tr(f"이름은 1~{NAME_MAX}자로 씁니다", f"The name must be 1 to {NAME_MAX} characters"))
    text = _check_body(str(body.get("body") or ""))
    keywords = _clean_keywords(body.get("keywords"))
    note = " ".join(str(body.get("note") or "").split())[:200]
    creating = not tid
    if creating:
        tid = "u_" + secrets.token_hex(4)
    elif not ID.match(tid):
        raise TemplateError(tr("템플릿 id 가 맞지 않습니다", "The template id is not valid"))
    is_builtin = tid in _builtin_ids()
    if is_builtin and builtin(tid, lang) is None:
        raise TemplateError(tr("없는 템플릿입니다", "Template not found"), 404)
    current = None if creating else get(tid, lang, include_deleted=True)
    if not creating and current is None:
        raise TemplateError(tr("없는 템플릿입니다", "Template not found"), 404)
    if current is not None and "base_rev" in body and int(body.get("base_rev") or 0) != current["rev"]:
        raise TemplateError(tr("그사이 다른 사람이 템플릿을 고쳤습니다. 다시 열어서 고쳐 주세요.",
                                "Someone changed the template in the meantime. Reopen it and edit again."), 409)
    if current is not None and not current["deleted"] and (current["name"], current["body"], current["keywords"]) == (name, text, keywords):
        raise TemplateError(tr("바뀐 내용이 없습니다", "Nothing has changed"))
    ts = _now()
    with _connect() as conn:
        rev = _next_rev(conn, tid, lang)
        conn.execute("INSERT INTO soul_template_versions (id, lang, rev, name, body, keywords, by, ts, note) VALUES (?,?,?,?,?,?,?,?,?)",
                     (tid, lang, rev, name, text, keywords, who, ts, note))
        conn.execute(store.db.upsert("soul_templates", ("id", "lang", "name", "body", "keywords", "builtin", "rev", "updated_by", "updated_at", "deleted"),
                                     ("id", "lang")), (tid, lang, name, text, keywords, int(is_builtin), rev, who, ts, 0))
    return get(tid, lang) or {}


def delete(tid: str, lang: str, who: str) -> None:
    """지운다. 기본 템플릿도 목록에서 빠지지만 「되돌리기」로 다시 살린다."""
    item = get(tid, lang)
    if item is None:
        raise TemplateError(tr("없는 템플릿입니다", "Template not found"), 404)
    with _connect() as conn:
        conn.execute(store.db.upsert("soul_templates", ("id", "lang", "name", "body", "keywords", "builtin", "rev", "updated_by", "updated_at", "deleted"),
                                     ("id", "lang")),
                     (tid, lang, item["name"], item["body"], item["keywords"], int(item["builtin"]), item["rev"], who, _now(), 1))


def reset(tid: str, lang: str) -> dict:
    """기본 템플릿을 처음(이미지의 파일) 내용으로 되돌린다. 지운 기본 템플릿도 다시 보인다. 이전 버전은 남는다."""
    if builtin(tid, lang) is None:
        raise TemplateError(tr("기본 템플릿만 처음으로 되돌릴 수 있습니다", "Only built-in templates can be reset"))
    with _connect() as conn:
        conn.execute("DELETE FROM soul_templates WHERE id=? AND lang=?", (tid, lang))
    return builtin(tid, lang) or {}


def versions(tid: str, lang: str) -> list[dict]:
    """저장한 버전(새 것부터). 기본 템플릿은 맨 끝에 처음 내용(버전 0)을 둔다."""
    with _connect() as conn:
        rows = [{"rev": int(r["rev"]), "name": str(r["name"]), "body": str(r["body"]), "keywords": str(r["keywords"]),
                 "by": str(r["by"]), "by_name": _person(str(r["by"])), "ts": str(r["ts"]), "note": str(r["note"])}
                for r in conn.execute("SELECT * FROM soul_template_versions WHERE id=? AND lang=? ORDER BY rev DESC", (tid, lang))]
    base = builtin(tid, lang)
    if base:
        rows.append({"rev": 0, "name": base["name"], "body": base["body"], "keywords": base["keywords"], "by": "", "ts": "", "note": ""})
    return rows


def revert(tid: str, lang: str, rev: int, who: str) -> dict:
    """이전 버전의 내용으로 새 버전을 만든다(버전 번호는 늘어난다)."""
    old = next((v for v in versions(tid, lang) if v["rev"] == rev), None)
    if old is None:
        raise TemplateError(tr("없는 버전입니다", "Version not found"), 404)
    return save({"id": tid, "lang": lang, "name": old["name"], "body": old["body"], "keywords": old["keywords"],
                 "note": f"버전 {rev} 으로 되돌림"}, who)   # i18n-ignore: 판 기록에 저장되는 메모


def fill(text: str, values: dict) -> str:
    """{company}·{department}·{role}·{agent} 만 채운다. 모르는 자리 표시는 그대로 둔다.
    빈 값(부서 없음)을 넣은 자리에 공백이 둘 남지 않게, 채운 자리 앞의 겹친 공백을 하나로 줄인다."""
    for key in PLACEHOLDERS:
        if key in values:
            value = " ".join(str(values[key] or "").split())
            text = re.sub(r"( ?)\{" + key + r"\}( ?)", (lambda m, v=value: f"{m.group(1)}{v}{m.group(2)}" if v else (m.group(1) or m.group(2))), text)
    return text


def render(item: dict, values: dict) -> str:
    """적용할 SOUL 전체. 첫 줄은 지금 회사 문장(008), 그 다음 빈 줄, 그 다음 자리 표시를 채운 본문."""
    company = settings.effective_company()
    body = fill(item["body"], {"company": company, "role": item["name"], **values}).strip("\n")
    return settings.identity_sentence() + "\n\n" + body + "\n"


def recommend(department: str, items: list[dict] | None = None, lang: str = "") -> dict | None:
    """부서 이름에 들어 있는 키워드가 가장 긴 템플릿. 길이가 같으면 목록 순서(리뷰 S3). lang 을 주면 그 언어만."""
    dept = (department or "").lower()
    if not dept:
        return None
    best, best_len = None, 0
    for item in items if items is not None else templates():
        if lang and item["lang"] != lang:
            continue
        for word in (w.strip().lower() for w in item["keywords"].split(",")):
            if word and word in dept and len(word) > best_len:
                best, best_len = item, len(word)
    return best


def is_default_soul(text: str) -> bool:
    """사람이 쓴 SOUL 이 아니라 Hermes 기본 문단(첫 문장만 회사 문장으로 바꾼 것 포함)이거나 비어 있는가."""
    body = (text or "").replace("\r\n", "\n").lstrip("﻿").strip()
    if not body:
        return True
    from ..fleet import identity
    heads = sorted({identity.HERMES_DEFAULT, settings.identity_sentence(), *settings.identity_history()}, key=len, reverse=True)
    rests = {HERMES_DEFAULT_REST, HERMES_DEFAULT_REST.replace("—", "--")}
    for head in heads:
        if body.startswith(head) and " ".join(body[len(head):].split()) in rests:
            return True
    return False


def record_use(pod: str, profile: str, tid: str, lang: str, rev: int, who: str) -> None:
    with _connect() as conn:
        conn.execute(store.db.upsert("soul_template_uses", ("pod", "profile", "template_id", "lang", "rev", "by", "ts"), ("pod", "profile")),
                     (pod, profile, tid, lang, int(rev), who, _now()))


def forget_use(pod: str, profile: str) -> None:
    with _connect() as conn:
        conn.execute("DELETE FROM soul_template_uses WHERE pod=? AND profile=?", (pod, profile))


def use_of(pod: str, profile: str) -> dict | None:
    """이 프로파일에 마지막으로 적용한 템플릿. 템플릿의 지금 버전이 적용한 버전과 다르면 changed=True."""
    with _connect() as conn:
        r = conn.execute("SELECT * FROM soul_template_uses WHERE pod=? AND profile=?", (pod, profile)).fetchone()
    if r is None:
        return None
    item = get(str(r["template_id"]), str(r["lang"]))
    rev = int(r["rev"])
    return {"template_id": str(r["template_id"]), "lang": str(r["lang"]), "rev": rev, "by": str(r["by"]), "ts": str(r["ts"]),
            "name": item["name"] if item else "", "exists": item is not None,
            "current_rev": item["rev"] if item else None, "changed": bool(item) and item["rev"] != rev}


def profile_hint(pod: str, profile: str, soul_text: str, department: str) -> dict:
    """프로파일 SOUL 창에 보일 것: 적용 기록, 기본 SOUL 뿐인지, 부서에 맞는 추천."""
    default = is_default_soul(soul_text)
    rec = recommend(department) if default else None
    return {"use": use_of(pod, profile), "is_default": default, "department": department,
            "recommend": {"id": rec["id"], "lang": rec["lang"], "name": rec["name"]} if rec else None}

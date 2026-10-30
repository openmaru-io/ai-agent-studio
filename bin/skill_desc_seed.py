#!/usr/bin/env python3
# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""미리 만든 스킬 설명 번역(aas/assets/skill_desc_ko.json)을 만든다 — 스펙 2026-10-19-017 P2.

SKILL.md 가 든 폴더(Hermes 이미지의 /opt/hermes/skills, 프로파일의 skills/ 등)를 읽어 스킬마다 두 형태의 설명을 낸다.
- catalog 형태: Hermes 가 YAML 로 읽은 description, 없으면 본문 첫 줄 80자(agent/skill_commands.py `_scan_skill_md`)
- skill_graph 형태: AAS 스킬 화면이 줄 단위로 읽은 description 을 redact(…, 240) 한 글
두 글이 다르면 키를 둘 다 넣어 `/` 목록과 스킬 화면이 같은 번역을 찾게 한다.

번역은 --translations 파일({"스킬 이름": "번역"})에서 가져오고, 없으면 --llm 일 때 서버와 같은 프롬프트로 LiteLLM 을 부른다.
이미 있는 행은 지우지 않고 빠진 것만 더한다. 만든 파일은 사람이 읽어 고친 뒤 커밋한다.

    python3 bin/skill_desc_seed.py DIR [DIR ...] --translations ko.json [--extra hub.json] [--llm] [--out aas/assets/skill_desc_ko.json]
    python3 bin/skill_desc_seed.py DIR --list            # 번역할 (이름, 설명) 목록만 JSON 으로
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from aas.assets import skill_graph  # noqa: E402
from aas.common.redact import redact  # noqa: E402
from aas.market import skill_desc  # noqa: E402

SKIP_PARTS = {".git", ".github", ".hub", ".archive"}


def _catalog_desc(text: str, folder: str) -> tuple[str, str]:
    """Hermes 와 같은 규칙의 (이름, 설명)."""
    import yaml
    fm, body = {}, text
    if text.startswith("---"):
        import re
        m = re.search(r"\n---\s*\n", text[3:])
        if m:
            try:
                got = yaml.safe_load(text[3:m.start() + 3])
                fm = got if isinstance(got, dict) else {}
            except Exception:
                fm = {}
            body = text[m.end() + 3:]
    name = str(fm.get("name") or folder)
    desc = str(fm.get("description") or "") or next(
        (ln.strip()[:80] for ln in body.strip().split("\n") if ln.strip() and not ln.strip().startswith("#")), "")
    return name, desc


def collect(dirs: list[str], extra: list[dict] | None = None) -> list[dict]:
    """[{name, forms: [설명...]}] — 이름마다 하나, 서로 다른 설명 형태를 모은다. extra 는 SKILL.md 없이 받은 목록(스킬 허브 패키지 요약)."""
    out: dict[str, dict] = {}
    for r in extra or []:
        name, desc = str(r.get("name") or ""), " ".join(str(r.get("description") or "").split())
        if name and desc:
            row = out.setdefault(name, {"name": name, "forms": []})
            for f in (desc, redact(desc, 240)):
                if f not in row["forms"]:
                    row["forms"].append(f)
    for d in dirs:
        for md in sorted(Path(d).rglob("SKILL.md")):
            if SKIP_PARTS & set(md.parts):
                continue
            text = md.read_text(encoding="utf-8-sig", errors="replace")
            name, cat = _catalog_desc(text, md.parent.name)
            graph = redact(skill_graph._frontmatter(text).get("description", ""), 240)
            row = out.setdefault(name, {"name": name, "forms": []})
            for f in (cat, graph):
                if f and f not in row["forms"]:
                    row["forms"].append(f)
    return sorted(out.values(), key=lambda r: r["name"])


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("dirs", nargs="+")
    ap.add_argument("--translations", default="")
    ap.add_argument("--llm", action="store_true")
    ap.add_argument("--extra", default="", help="[{name, description}] JSON — 스킬 허브 패키지 요약 등")
    ap.add_argument("--list", action="store_true")
    ap.add_argument("--out", default=str(ROOT / "aas" / "assets" / "skill_desc_ko.json"))
    a = ap.parse_args(argv)
    skills = collect(a.dirs, json.loads(Path(a.extra).read_text(encoding="utf-8")) if a.extra else None)
    if a.list:
        print(json.dumps([{"name": s["name"], "description": max(s["forms"], key=len)} for s in skills
                          if any(skill_desc.worth(f) or skill_desc.has_hangul(f) for f in s["forms"])], ensure_ascii=False, indent=1))
        return 0
    given = json.loads(Path(a.translations).read_text(encoding="utf-8")) if a.translations else {}
    out_path = Path(a.out)
    table = json.loads(out_path.read_text(encoding="utf-8")) if out_path.exists() else {}
    added = missing = 0
    for s in skills:
        forms = [f for f in s["forms"] if skill_desc.worth(f) or (skill_desc.has_hangul(f) and s["name"] in given)]
        if not forms:
            continue
        ko = given.get(s["name"], "")
        if not ko and a.llm:
            ko = skill_desc.translate_once(s["name"], redact(max(forms, key=len), skill_desc.SRC_MAX)) or ""
        if not ko:
            missing += 1
            print(f"번역 없음: {s['name']}", file=sys.stderr)   # i18n-ignore: 명령줄 출력
            continue
        for f in forms:
            k = skill_desc.desc_key(s["name"], f)
            if k not in table:
                table[k] = {"ko": ko, "name": s["name"], "src": " ".join(f.split())[:skill_desc.SRC_MAX]}
                added += 1
    out_path.write_text(json.dumps(table, ensure_ascii=False, indent=1, sort_keys=True) + "\n", encoding="utf-8")
    print(f"{out_path}: {added}행 더함, 번역 없음 {missing}개, 모두 {len(table)}행")   # i18n-ignore: 명령줄 출력
    return 0


if __name__ == "__main__":
    sys.exit(main())

#!/usr/bin/env python3
# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""미리 만든 비밀값(.env) 변수 설명 번역(aas/assets/env_desc_ko.json)을 만든다 — 스펙 2026-10-21-003 P3.

1. dump  — Hermes 이미지 안에서 GET /api/env 와 같은 함수(_get_env_vars_sync)를 불러 {이름: 원문} 을 받는다.
           컨테이너는 네트워크 없이 빈 HERMES_HOME 으로 띄운다. 사용자가 추가한 변수(custom)는 빼고 적는다.
2. diff  — 받은 목록(여러 이미지를 함께 줄 수 있다)과 표를 견주어 없는 것·원문이 바뀐 것·사라진 것을 보인다.
           --todo 를 주면 번역할 줄을 [{"name", "src"}] 로 쓴다.
3. merge — [{"name", "src", "ko"}] 번역 파일을 표에 합친다. 받은 목록에 없는 원문·변수는 지운다.

    python3 bin/env_desc_seed.py dump --image <Hermes 이미지> --out /tmp/env-hermes.json
    python3 bin/env_desc_seed.py diff /tmp/env-hermes.json /tmp/env-aas-hermes.json --todo /tmp/todo.json
    python3 bin/env_desc_seed.py merge /tmp/env-hermes.json /tmp/env-aas-hermes.json --translations /tmp/ko.json

만든 표는 사람이 읽어 고친 뒤 커밋한다. tests/test_env_desc.py 가 표 모양을 검사한다.
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from aas.fleet import env_desc  # noqa: E402

DUMP_CODE = """
import json, sys
from hermes_cli.web_routers.config_env import _get_env_vars_sync
rows = _get_env_vars_sync(None)
json.dump({k: v.get("description", "") for k, v in rows.items() if not v.get("custom")}, sys.stdout, ensure_ascii=False)
"""


def _norm(text: str) -> str:
    return " ".join(str(text or "").split())


def _load(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def _write(path: Path, data) -> None:
    path.write_text(json.dumps(data, ensure_ascii=False, indent=1, sort_keys=True) + "\n", encoding="utf-8")


def _sources(dumps: list[Path]) -> dict[str, list[str]]:
    """{이름: [원문, ...]} — 여러 이미지의 목록을 합친다. 빈 설명은 번역할 것이 없어 뺀다."""
    out: dict[str, list[str]] = {}
    for p in dumps:
        for name, desc in _load(p).items():
            src = _norm(desc)
            if src and src not in out.setdefault(name, []):
                out[name].append(src)
    return {k: v for k, v in out.items() if v}


def dump(args) -> int:
    cmd = ["docker", "run", "--rm", "--network", "none", "-e", "HERMES_HOME=/tmp/hh", "--entrypoint", "sh", args.image,
           "-c", f"mkdir -p /tmp/hh && cd /opt/hermes && python3 -c '{DUMP_CODE}'"]
    res = subprocess.run(cmd, capture_output=True, text=True)
    if res.returncode:
        print(res.stderr[-2000:], file=sys.stderr)
        return res.returncode
    rows = json.loads(res.stdout)
    _write(Path(args.out), rows)
    print(f"{args.image}: {len(rows)} 개 → {args.out}")  # i18n-ignore: 도구 출력
    return 0


def diff(args) -> int:
    srcs = _sources([Path(p) for p in args.dumps])
    table = _load(Path(args.table))
    have = {(n, _norm(v.get("src", ""))) for n, vs in table.items() for v in vs}
    todo = [{"name": n, "src": s} for n, ss in sorted(srcs.items()) for s in ss if (n, s) not in have]
    changed = sorted({t["name"] for t in todo if t["name"] in table})
    gone = sorted(set(table) - set(srcs))
    print(f"번역할 줄 {len(todo)} (원문이 바뀐 변수 {len(changed)}), 사라진 변수 {len(gone)}")  # i18n-ignore: 도구 출력
    for n in changed:
        print(f"  바뀜 {n}")  # i18n-ignore: 도구 출력
    for n in gone:
        print(f"  사라짐 {n}")  # i18n-ignore: 도구 출력
    if args.todo:
        _write(Path(args.todo), todo)
    return 1 if (todo or gone) and args.check else 0


def merge(args) -> int:
    srcs = _sources([Path(p) for p in args.dumps])
    table_path = Path(args.table)
    old = _load(table_path) if table_path.exists() else {}
    ko = {(n, _norm(v.get("src", ""))): v["ko"] for n, vs in old.items() for v in vs if v.get("ko")}
    for t in _load(Path(args.translations)) if args.translations else []:
        if t.get("ko"):
            ko[(t["name"], _norm(t["src"]))] = str(t["ko"]).strip()
    table, missing = {}, 0
    for name, ss in sorted(srcs.items()):
        rows = [{"src": s, "ko": ko[(name, s)]} for s in ss if (name, s) in ko]
        missing += len(ss) - len(rows)
        if rows:
            table[name] = rows
    too_long = [n for n, vs in table.items() for v in vs if len(v["ko"]) > env_desc.MAX_CHARS]
    _write(table_path, table)
    print(f"{table_path}: 변수 {len(table)}, 번역 없음 {missing}, {env_desc.MAX_CHARS}자 넘음 {too_long}")  # i18n-ignore: 도구 출력
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("dump")
    p.add_argument("--image", required=True)
    p.add_argument("--out", required=True)
    for name in ("diff", "merge"):
        p = sub.add_parser(name)
        p.add_argument("dumps", nargs="+")
        p.add_argument("--table", default=str(env_desc._SEED_DEFAULT))
    sub.choices["diff"].add_argument("--todo")
    sub.choices["diff"].add_argument("--check", action="store_true", help="번역할 줄이나 사라진 변수가 있으면 1 로 끝낸다")  # i18n-ignore: 도구 도움말
    sub.choices["merge"].add_argument("--translations")
    args = ap.parse_args()
    return {"dump": dump, "diff": diff, "merge": merge}[args.cmd](args)


if __name__ == "__main__":
    sys.exit(main())

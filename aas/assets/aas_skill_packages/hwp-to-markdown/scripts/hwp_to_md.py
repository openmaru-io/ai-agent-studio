#!/usr/bin/env python3
# Copyright 2026 The OPENMARU Authors.
"""한글 문서(HWP 5.0·HWPX·HWP 3.x)를 Markdown 으로 바꾼다 (OMAI-1497, 스킬 hwp-to-markdown).

사용: python hwp_to_md.py [--with-memos] <입력.hwp|.hwpx> <출력.md>

- 먼저 kordoc(HWP 3.x·5.x·HWPX·암호 문서, 병합 셀 표는 HTML 표), 실패하거나 결과가 비면 hwpforge 로 다시 한다.
  kordoc 은 한글 메모(검토 의견)를 읽지 않는다 — 메모가 필요하면 --with-memos 로 hwpforge 만 쓴다(메모가 HTML 주석으로 들어간다).
  두 도구 모두 amd64·arm64 에서 같은 결과를 낸다(스펙 2026-10-26-013 §2-4·§2-4-1).
- 끝에 쓴 도구·글자 수·표 수를 한 줄로 보인다.
- 종료 코드: 0 성공, 1 두 도구 모두 실패, 2 출력 파일이 이미 있음(덮지 않음).
"""

import subprocess
import sys
from pathlib import Path


def _hwpforge(src: Path) -> str:
    import hwpforge

    if src.suffix.lower() == ".hwpx":
        res = hwpforge.Document.open(str(src))
        doc = getattr(res, "value", res)
    else:
        res = hwpforge.convert_hwp5(src.read_bytes())
        doc = getattr(res, "value", None) or getattr(res, "document", None) or res
    md = doc.to_md()
    text = getattr(md, "value", None) or getattr(md, "text", None) or md
    return str(text)


def _kordoc(src: Path, dst: Path) -> str:
    tmp = dst.with_name(f".{dst.name}.kordoc.md")
    try:
        subprocess.run(["kordoc", str(src), "-o", str(tmp), "--silent", "--no-images"], check=True, timeout=600)
        return tmp.read_text(encoding="utf-8")
    finally:
        tmp.unlink(missing_ok=True)


def main(argv: list[str]) -> int:
    memos = "--with-memos" in argv
    argv = [a for a in argv if a != "--with-memos"]
    if len(argv) != 3:
        print("사용: python hwp_to_md.py [--with-memos] <입력.hwp|.hwpx> <출력.md>", file=sys.stderr)
        return 64
    src, dst = Path(argv[1]), Path(argv[2])
    if dst.exists():
        print(f"출력 파일이 이미 있습니다(덮지 않음): {dst}", file=sys.stderr)
        return 2
    dst.parent.mkdir(parents=True, exist_ok=True)
    errors, missing = [], []
    tools = [("kordoc", lambda: _kordoc(src, dst)), ("hwpforge", lambda: _hwpforge(src))]
    if memos:
        tools = tools[1:]
    for tool, run in tools:
        try:
            text = run()
        except (FileNotFoundError, ImportError):      # 도구가 없다(스펙 2026-10-29-001 D4)
            missing.append(tool)
            continue
        except Exception as exc:                      # 도구마다 오류 종류가 달라 다음 도구로 넘어간다
            errors.append(f"{tool}: {type(exc).__name__}: {str(exc)[:200]}")
            continue
        if text.strip():
            dst.write_text(text if text.endswith("\n") else text + "\n", encoding="utf-8")
            tables = text.count("<table") + sum(1 for line in text.splitlines() if line.lstrip().startswith("| ---"))
            print(f"{tool} 로 바꿨습니다: {dst} (글자 {len(text)}, 표 {tables})")
            return 0
        errors.append(f"{tool}: 결과가 비었습니다")
    if missing and not errors:
        print(f"이 스킬에 필요한 도구가 이 에이전트에 없습니다: {', '.join(missing)}", file=sys.stderr)
        return 6
    print("한글 문서를 읽지 못했습니다:\n  " + "\n  ".join(errors + [f'{t}: 없음' for t in missing]), file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))

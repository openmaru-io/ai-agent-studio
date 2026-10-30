/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 초점 링(DESIGN.md §1-1.5)은 키보드 초점에만 그린다. `:focus`·`:focus-within` 은 마우스로 눌러도 맞아서
// 칩·단추를 누를 때마다 테두리가 남았다(회의 받는 에이전트 칩, 2026-10-18). 이 시험은 초점 링이 걸린 규칙의 선택자가
// 키보드 초점(`:focus-visible`·`Mui-focusVisible`)인지 코드에서 본다 — jsdom 은 이 선택자를 계산하지 못한다.
// 링 색은 2026-10-19 에 빨강(#DA291C)에서 무채색 토큰(--aas-focus-ring, FOCUS_RING)으로 바꿨다(스펙 2026-10-19-014).
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { describe, expect, it } from 'vitest';

const SRC = join(__dirname, '..');

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return sources(p);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [p] : [];
  });
}

describe('키보드 초점 링', () => {
  it('마우스로 눌러도 맞는 선택자(:focus, :focus-within)에 초점 링을 걸지 않는다', () => {
    const bad: string[] = [];
    for (const file of sources(SRC)) {
      readFileSync(file, 'utf-8')
        .split('\n')
        .forEach((line, i) => {
          if (!/#DA291C|aas-focus-ring|FOCUS_RING/i.test(line) || !/(outline|boxShadow|border)/.test(line)) return;
          if (/:focus-within|:focus(?![-\w])/.test(line)) bad.push(`${relative(SRC, file)}:${i + 1}`);
        });
    }
    expect(bad).toEqual([]);
  });

  // 서랍을 ESC 로 닫으면 포커스가 연 단추로 돌아오며 키보드 포커스로 판정된다 — 마우스 사용자도 링을 본다. 빨강은 오류색이라
  // 경고처럼 읽혀 무채색 토큰 하나(--aas-focus-ring)로 모았다(2026-10-19-014). 포커스 규칙에 색을 글자 그대로 쓰지 않는다
  // 예외: 삭제 단추(tierButton 의 danger)는 단추 자체가 빨강이라 포커스 테두리도 같은 빨강이다.
  // 늘 어두운 면에 있는 상단 막대(topbarButton)·오피스 편집 패널(EditPanel)은 흰색을 고정으로 쓴다(모드를 따르는 토큰을 쓰면 밝은 화면에서 보이지 않는다)
  it('키보드 포커스 규칙에 빨강을 쓰지 않는다(삭제 단추만 예외)', () => {
    const bad: string[] = [];
    for (const file of sources(SRC)) {
      const rel = relative(SRC, file);
      readFileSync(file, 'utf-8')
        .split('\n')
        .forEach((line, i) => {
          if (!/(Mui-focusVisible|:focus-visible)/.test(line) || !/(outline|boxShadow|borderColor)/.test(line)) return;
          if (rel === join('components', 'tierButton.ts') && /218,\s*41,\s*28/.test(line)) return;
          if (/#DA291C|218,\s*41,\s*28/i.test(line)) bad.push(`${rel}:${i + 1}`);
        });
    }
    expect(bad).toEqual([]);
  });
});

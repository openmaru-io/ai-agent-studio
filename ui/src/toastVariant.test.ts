/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';

// notistack 은 variant 를 주지 않으면(default) 앞 아이콘 없이 띄운다. 알림(Toast)은 항상 variant 를 준다(성공·오류·경고·안내 아이콘).
const files = import.meta.glob(['./**/*.ts', './**/*.tsx', '!./**/*.test.ts', '!./**/*.test.tsx'], { query: '?raw', import: 'default', eager: true }) as Record<string, string>;

/** `enqueueSnackbar(` 호출마다 괄호가 닫힐 때까지의 글을 돌려준다. */
function calls(src: string): { line: number; text: string }[] {
  const out: { line: number; text: string }[] = [];
  const re = /enqueueSnackbar\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    let i = m.index + m[0].length;
    let depth = 1;
    while (i < src.length && depth > 0) {
      if (src[i] === '(') depth++;
      else if (src[i] === ')') depth--;
      i++;
    }
    out.push({ line: src.slice(0, m.index).split('\n').length, text: src.slice(m.index, i) });
  }
  return out;
}

describe('알림(Toast)', () => {
  it('모든 enqueueSnackbar 호출이 variant 를 준다(아이콘이 앞에 붙는다)', () => {
    const all = Object.entries(files).flatMap(([file, src]) => calls(src).map((c) => ({ file, ...c })));
    expect(all.length).toBeGreaterThan(50); // 검사 대상을 실제로 찾았는지
    const bad = all.filter((c) => !/variant\s*[:=]/.test(c.text) && !/,\s*\w+\s*\)$/.test(c.text)).map((c) => `${c.file}:${c.line}`);
    expect(bad).toEqual([]);
  });
});

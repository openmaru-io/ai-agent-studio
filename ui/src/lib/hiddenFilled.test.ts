/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';

import { hiddenFilled } from './hiddenFilled';

// 접힌 묶음의 「{n}칸 적음」(스펙 2026-10-19-005 G13·R13). 숨은 글 칸만 세고 우선순위 같은 선택 칸은 셈하지 않는다
describe('hiddenFilled', () => {
  const keys = ['goal', 'result', 'how', 'avoid', 'refs'] as const;
  const shown = ['goal', 'result'] as const;
  it.each([
    [{}, 0],
    [{ goal: '보고서', result: '파일' }, 0], // 보이는 칸은 세지 않는다
    [{ how: '  ' }, 0], // 빈칸만 있는 값은 적은 것이 아니다
    [{ how: '순서대로', refs: 'https://x' }, 2],
    [{ how: '순서대로', priority: 'high' } as Record<string, string>, 1], // 목록 밖 키(우선순위)는 세지 않는다
  ])('%o → %i', (values, n) => {
    expect(hiddenFilled(keys, shown, values)).toBe(n);
  });
});

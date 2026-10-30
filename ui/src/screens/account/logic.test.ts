/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';

import { canSubmit, passwordProblems } from './logic';

describe('비밀번호 입력 검사', () => {
  it('비어 있는 칸은 문제로 치지 않고 단추는 꺼져 있다', () => {
    expect(passwordProblems('', '', '')).toEqual({});
    expect(canSubmit('', '', '')).toBe(false);
    expect(canSubmit('old-password', '', '')).toBe(false);
  });

  it('8자 미만·현재와 같음·확인이 다름을 칸마다 알린다', () => {
    expect(passwordProblems('old-password', 'short', '')).toEqual({ new: 'account.tooShort' });
    expect(passwordProblems('old-password', 'old-password', '')).toEqual({ new: 'account.same' });
    expect(passwordProblems('old-password', 'new-password-1', 'new-password-2')).toEqual({ confirm: 'account.mismatch' });
  });

  it('세 칸이 차고 문제가 없을 때만 켠다', () => {
    expect(canSubmit('old-password', 'new-password-1', 'new-password-1')).toBe(true);
    expect(canSubmit('old-password', 'new-password-1', 'new-password-2')).toBe(false);
    expect(canSubmit('old-password', 'short', 'short')).toBe(false);
    expect(canSubmit('old-password', 'old-password', 'old-password')).toBe(false);
  });
});

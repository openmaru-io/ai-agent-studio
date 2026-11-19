/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';

import { cleanSecret, ENV_KEY, SECRET_MAX } from './credentialWrite';

describe('cleanSecret — 보낼 비밀값 다듬기(스펙 2026-11-18-004)', () => {
  it('붙여 넣은 값 앞뒤의 공백·줄바꿈만 지운다', () => {
    expect(cleanSecret('  tok-123\n')).toEqual({ value: 'tok-123' });
    expect(cleanSecret('a b')).toEqual({ value: 'a b' }); // 가운데 공백은 그대로
  });
  it('가운데 줄바꿈·NUL, 빈 값, 상한 초과는 이유를 돌려준다', () => {
    expect(cleanSecret('a\nb').error).toBe('newline');
    expect(cleanSecret('a\rb').error).toBe('newline');
    expect(cleanSecret('a\0b').error).toBe('newline');
    expect(cleanSecret(' \n ').error).toBe('empty');
    expect(cleanSecret('x'.repeat(SECRET_MAX + 1)).error).toBe('long');
    expect(cleanSecret('x'.repeat(SECRET_MAX)).error).toBeUndefined();
  });
  it('이름 규칙은 서버 ENV_KEY 와 같다 — 소문자 이름은 저장 경로가 받지 않는다', () => {
    expect(ENV_KEY.test('AIRTABLE_API_KEY')).toBe(true);
    expect(ENV_KEY.test('airtable_key')).toBe(false);
    expect(ENV_KEY.test('_X')).toBe(false);
  });
});

/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it } from 'vitest';

import { markCronSeen, seenCron } from './cronSeen';

beforeEach(() => window.localStorage.clear());

describe('크론 세션을 연 기록', () => {
  it('연 세션을 기억하고 같은 id 를 두 번 넣어도 한 번만 센다', () => {
    markCronSeen('a');
    markCronSeen('a');
    markCronSeen('b');
    expect([...seenCron()].sort()).toEqual(['a', 'b']);
  });

  it('300개를 넘으면 오래된 것부터 버린다', () => {
    for (let i = 0; i < 305; i++) markCronSeen(`s${i}`);
    const seen = seenCron();
    expect(seen.size).toBe(300);
    expect(seen.has('s0')).toBe(false);
    expect(seen.has('s304')).toBe(true);
  });

  it('저장된 값이 깨져 있어도 빈 집합으로 읽는다', () => {
    window.localStorage.setItem('aas.chat.cronSeen', '{not json');
    expect(seenCron().size).toBe(0);
  });
});

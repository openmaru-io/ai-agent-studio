/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';

import { backoffDelay, RetryBudget } from './backoff';

describe('backoffDelay', () => {
  const mid = () => 0.5; // 무작위 가운데 — jitter 가 0 이 된다

  it('1초에서 두 배씩 늘고 30초에서 멈춘다', () => {
    expect([1, 2, 3, 4, 5, 6, 7, 12].map((n) => backoffDelay(n, { random: mid }))).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000]);
  });

  it('무작위 값은 ±20% 안이다 — 모든 탭이 같은 순간에 다시 묻지 않는다', () => {
    expect(backoffDelay(3, { random: () => 0 })).toBeCloseTo(3200);
    expect(backoffDelay(3, { random: () => 1 })).toBeCloseTo(4800);
  });

  it('웹소켓은 0.5초에서 시작한다(ws.ts 와 같은 값)', () => {
    expect(backoffDelay(1, { base: 500, random: mid })).toBe(500);
    expect(backoffDelay(0, { base: 500, random: mid })).toBe(500);
  });
});

describe('RetryBudget', () => {
  it('12번 또는 5분을 넘으면 다 썼다', () => {
    const b = new RetryBudget(0);
    for (let i = 0; i < 11; i++) expect(b.fail(1000)).toBe(true);
    expect(b.fail(1000)).toBe(false);
    const t = new RetryBudget(0);
    expect(t.fail(5 * 60000)).toBe(false);
  });

  it('사람이 다시 누르면 횟수와 시작 시각을 새로 한다', () => {
    const b = new RetryBudget(0);
    b.fail(299000);
    b.reset(299000);
    expect([b.tries, b.since]).toEqual([0, 299000]);
    expect(b.fail(300000)).toBe(true);
  });
});

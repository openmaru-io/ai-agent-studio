/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { noteServerDate, serverClockSkew } from './serverClock';

// 초가 바뀌는 자리(0ms)에서 떨어진 정도를 바꿔 가며 본다 — Date 머리는 밀리초를 버린다
const BASE = Date.UTC(2026, 10, 17, 3, 0, 0);
const at = (ms: number) => new Date(Date.now() + ms).toUTCString();

describe('serverClock', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    noteServerDate(at(0));
    vi.useRealTimers();
  });

  it.each([0, 300, 999])('서버 시계가 3분 늦으면 −180초 안팎(밀리초 %d)', (ms) => {
    vi.setSystemTime(BASE + ms);
    noteServerDate(at(-180_000));
    expect(Math.abs(serverClockSkew() + 180_000)).toBeLessThanOrEqual(500);
  });

  it.each([0, 300, 999])('2초 미만 차이는 Date 머리 오차로 보고 0(밀리초 %d)', (ms) => {
    vi.setSystemTime(BASE + ms);
    noteServerDate(at(-1500));
    expect(serverClockSkew()).toBe(0);
    noteServerDate(at(1500));
    expect(serverClockSkew()).toBe(0);
  });

  it('Date 머리가 없거나 깨지면 앞 값을 둔다', () => {
    vi.setSystemTime(BASE);
    noteServerDate(at(-180_000));
    const before = serverClockSkew();
    noteServerDate(null);
    noteServerDate('nope');
    expect(serverClockSkew()).toBe(before);
  });
});

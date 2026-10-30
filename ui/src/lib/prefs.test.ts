/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it } from 'vitest';

import { displayTimeZone, formatInZone, setStoredTimeZone, storedTimeZone, TZ_KEY, zoneLabel } from './prefs';

describe('prefs 시간대(스펙 2026-10-14-013)', () => {
  afterEach(() => setStoredTimeZone(''));

  it('빈 값이면 브라우저 시간대, 고르면 그 시간대를 쓰고 이 브라우저에 기억한다', () => {
    setStoredTimeZone('');
    expect(storedTimeZone()).toBe('');
    expect(displayTimeZone()).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
    setStoredTimeZone('Asia/Seoul');
    expect(localStorage.getItem(TZ_KEY)).toBe('Asia/Seoul');
    expect(displayTimeZone()).toBe('Asia/Seoul');
  });

  it('모르는 시간대 이름은 저장하지 않는다', () => {
    setStoredTimeZone('Mars/Olympus');
    expect(storedTimeZone()).toBe('');
  });

  it('시간대 이름에 UTC 차이를 붙여 보인다', () => {
    const at = new Date('2026-10-14T00:00:00Z');
    expect(zoneLabel('Asia/Seoul', at)).toBe('(UTC+9) Asia/Seoul');
    expect(zoneLabel('UTC', at)).toBe('(UTC+0) UTC');
    expect(zoneLabel('Asia/Kolkata', at)).toBe('(UTC+5:30) Asia/Kolkata');
  });

  it('시각을 그 시간대의 YYYY-MM-DD HH:mm 으로 만든다(자정은 00시)', () => {
    expect(formatInZone(new Date('2026-10-13T15:00:00Z'), 'Asia/Seoul')).toBe('2026-10-14 00:00');
  });
});

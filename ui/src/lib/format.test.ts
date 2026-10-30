/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';

import { big, fmtClock, fmtTs, plural, profileName, seatLabel, zonedDate } from './format';
import { setStoredTimeZone } from './prefs';

describe('format', () => {
  it('fmtTs 는 ISO 시각을 YYYY-MM-DD HH:mm 으로 줄이고 비면 —(연도는 2026-10-13 부터)', () => {
    setStoredTimeZone('Asia/Seoul');
    expect(fmtTs('2026-10-10T14:05:09+09:00')).toBe('2026-10-10 14:05');
    expect(fmtTs('')).toBe('—');
    expect(fmtTs(null)).toBe('—');
    expect(fmtTs(undefined)).toBe('—');
    setStoredTimeZone('');
  });

  it('fmtTs 는 시간대가 있는 시각을 고른 시간대로 바꾸고, 시간대 없는 시각은 그대로 자른다(스펙 2026-10-14-013)', () => {
    setStoredTimeZone('Asia/Seoul');
    expect(fmtTs('2026-10-10T05:05:09Z')).toBe('2026-10-10 14:05');
    expect(fmtTs('2026-10-10T23:30:00+00:00')).toBe('2026-10-11 08:30');
    expect(fmtTs('2026-10-10 14:05:09')).toBe('2026-10-10 14:05');
    setStoredTimeZone('UTC');
    expect(fmtTs('2026-10-10T14:05:09+09:00')).toBe('2026-10-10 05:05');
    expect(fmtTs('2026-13-45T99:99+09:00')).toBe('2026-13-45 99:99');
    setStoredTimeZone('');
  });

  it('fmtClock·zonedDate 는 대화 시각·날짜 구분이 설정의 시간대를 따르게 한다(디자인 리뷰 7-1)', () => {
    const at = Date.parse('2026-10-10T23:30:00Z');
    setStoredTimeZone('Asia/Seoul');
    expect(fmtClock(at)).toBe('08:30');
    expect(zonedDate(at)).toEqual({ y: 2026, m: 10, d: 11 }); // 서울에서는 이미 다음 날
    setStoredTimeZone('UTC');
    expect(fmtClock(at)).toBe('23:30');
    expect(zonedDate(at)).toEqual({ y: 2026, m: 10, d: 10 });
    setStoredTimeZone('');
  });

  it('big 은 큰 수를 k·M·B 로 줄인다', () => {
    expect(big(0)).toBe('0');
    expect(big(9999)).toBe('9999');
    expect(big(10000)).toBe('10k');
    expect(big(15400)).toBe('15k');
    expect(big(2_500_000)).toBe('2.5M');
    expect(big(3_200_000_000)).toBe('3.2B');
    expect(big(undefined)).toBe('0');
  });

  it('profileName 은 default 를 기본 프로파일로 부른다', () => {
    expect(profileName('default')).toBe('기본 프로파일');
    expect(profileName('ma')).toBe('ma');
  });

  it('plural 은 개수와 단위를 붙인다', () => {
    expect(plural(3, '개')).toBe('3개');
  });
});

describe('seatLabel', () => {
  it('설치본 이름이 별칭과 다를 때만 괄호로 붙인다(같으면 같은 글자가 두 번 보인다)', () => {
    expect(seatLabel('sa', 'yj')).toBe('sa (yj)');
    expect(seatLabel('aas-agent-aas-test-a5f9', 'aas-agent-aas-test-a5f9')).toBe('aas-agent-aas-test-a5f9');
    expect(seatLabel('sa', '')).toBe('sa');
  });
});

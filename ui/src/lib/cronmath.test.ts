/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';

import { describe as explain, fmtNext, interval, nextRuns, parseCron } from './cronmath';

describe('interval', () => {
  it('분·시간·일 간격을 분으로 바꾼다', () => {
    expect(interval('30m')).toBe(30);
    expect(interval('every 2h')).toBe(120);
    expect(interval('1 day')).toBe(1440);
    expect(interval('Every 5 minutes')).toBe(5);
  });
  it('간격이 아니면 0', () => {
    expect(interval('0 9 * * *')).toBe(0);
    expect(interval('')).toBe(0);
    expect(interval(undefined)).toBe(0);
  });
});

describe('parseCron', () => {
  it('5칸 식을 풀고 범위·목록·간격을 지원한다', () => {
    const c = parseCron('*/15 9-11 * * 1,3');
    expect([...(c?.min ?? [])]).toEqual([0, 15, 30, 45]);
    expect([...(c?.hour ?? [])]).toEqual([9, 10, 11]);
    expect([...(c?.dow ?? [])]).toEqual([1, 3]);
    expect(c?.domAny).toBe(true);
    expect(c?.dowAny).toBe(false);
  });
  it('요일 7 은 일요일(0)', () => {
    expect([...(parseCron('0 0 * * 7')?.dow ?? [])]).toEqual([0]);
  });
  it('칸 수가 다르거나 범위를 벗어나면 null', () => {
    expect(parseCron('0 9 * *')).toBeNull();
    expect(parseCron('60 9 * * *')).toBeNull();
    expect(parseCron('0 24 * * *')).toBeNull();
    expect(parseCron('a b c d e')).toBeNull();
    expect(parseCron('')).toBeNull();
  });
});

describe('nextRuns', () => {
  const from = new Date(2026, 9, 10, 8, 30, 15); // 2026-10-10(토) 08:30:15
  it('간격은 지금부터 n 번째씩 더한다', () => {
    const r = nextRuns('30m', 3, from) as Date[];
    expect(r.map((d) => d.getTime() - from.getTime())).toEqual([1800000, 3600000, 5400000]);
  });
  it('cron 식은 다음 시각부터 순서대로 낸다', () => {
    const r = nextRuns('0 9 * * *', 3, from) as Date[];
    expect(r.map(fmtNext)).toEqual(['10/10(토) 09:00', '10/11(일) 09:00', '10/12(월) 09:00']);
  });
  it('이미 지난 오늘 시각은 건너뛴다', () => {
    const r = nextRuns('0 8 * * *', 1, from) as Date[];
    expect(fmtNext(r[0])).toBe('10/11(일) 08:00');
  });
  it('평일만', () => {
    const r = nextRuns('0 9 * * 1-5', 3, from) as Date[];
    expect(r.map(fmtNext)).toEqual(['10/12(월) 09:00', '10/13(화) 09:00', '10/14(수) 09:00']);
  });
  it('일과 요일을 모두 정하면 둘 중 하나만 맞아도 실행한다', () => {
    const r = nextRuns('0 9 15 * 1', 3, from) as Date[];
    expect(r.map(fmtNext)).toEqual(['10/12(월) 09:00', '10/15(목) 09:00', '10/19(월) 09:00']);
  });
  it('풀 수 없는 식은 null', () => {
    expect(nextRuns('아무 말', 3, from)).toBeNull();
  });
});

describe('describe', () => {
  it.each([
    ['30m', '30분마다'],
    ['every 2h', '2시간마다'],
    ['1d', '1일마다'],
    ['*/10 * * * *', '10분마다'],
    ['5 */2 * * *', '2시간마다 (05분에)'],
    ['15 * * * *', '매시 15분'],
    ['30 9 * * *', '매일 09:30'],
    ['0 9 * * 1-5', '평일(월–금) 09:00'],
    ['0 9 * * 1,3', '매주 월·수 09:00'],
    ['0 9 1,15 * *', '매월 1·15일 09:00'],
    ['0 9 * 3 *', ''],
    ['*/5 9 * * *', ''],
    ['엉터리', ''],
  ])('%s → %s', (expr, want) => {
    expect(explain(expr)).toBe(want);
  });
});

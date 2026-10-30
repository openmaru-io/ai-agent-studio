/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';

import { buildExpr, initialSchedule, ScheduleState, summaryLine } from './schedule';

const st = (over: Partial<ScheduleState> = {}): ScheduleState => ({
  mode: 'daily',
  time: '09:00',
  days: [1],
  dom: 1,
  n: 30,
  custom: '',
  ...over,
});

describe('initialSchedule', () => {
  it.each([
    ['30 9 * * *', 'daily', '09:30'],
    ['0 9 * * 1-5', 'weekdays', '09:00'],
    ['0 18 * * 1,3', 'weekly', '18:00'],
    ['0 9 15 * *', 'monthly', '09:00'],
    ['*/10 * * * *', 'minutes', '09:00'],
    ['0 */3 * * *', 'hours', '09:00'],
    ['30m', 'minutes', '09:00'],
    ['every 2h', 'hours', '09:00'],
    ['아무 말', 'custom', '09:00'],
    ['0 9 * 3 *', 'custom', '09:00'],
  ])('%s → %s', (expr, mode, time) => {
    const s = initialSchedule(expr);
    expect(s.mode).toBe(mode);
    expect(s.time).toBe(time);
  });

  it('요일·날짜·간격 값을 식에서 읽는다', () => {
    expect(initialSchedule('0 18 * * 1,3').days).toEqual([1, 3]);
    expect(initialSchedule('0 9 15 * *').dom).toBe(15);
    expect(initialSchedule('*/10 * * * *').n).toBe(10);
    expect(initialSchedule('0 */3 * * *').n).toBe(3);
    expect(initialSchedule('every 2h').n).toBe(2);
    expect(initialSchedule('45m').n).toBe(45);
  });

  it('식이 없으면 매일 09:00', () => {
    expect(initialSchedule('')).toMatchObject({ mode: 'custom', time: '09:00', custom: '' });
  });
});

describe('buildExpr', () => {
  it.each([
    [st(), '0 9 * * *'],
    [st({ mode: 'weekdays', time: '07:05' }), '5 7 * * 1-5'],
    [st({ mode: 'weekly', days: [3, 1] }), '0 9 * * 1,3'],
    [st({ mode: 'weekly', days: [] }), '0 9 * * 1'],
    [st({ mode: 'monthly', dom: 15 }), '0 9 15 * *'],
    [st({ mode: 'minutes', n: 5 }), '*/5 * * * *'],
    [st({ mode: 'minutes', n: 999 }), '*/59 * * * *'],
    [st({ mode: 'minutes', n: 0 }), '*/1 * * * *'],
    [st({ mode: 'hours', n: 2 }), '0 */2 * * *'],
    [st({ mode: 'hours', n: 99 }), '0 */23 * * *'],
    [st({ mode: 'custom', custom: '  30m ' }), '30m'],
  ])('%j → %s', (state, expr) => {
    expect(buildExpr(state)).toBe(expr);
  });
});

describe('summaryLine', () => {
  it('언제 누가 무엇을 하고 결과가 어디로 가는지 한 줄로', () => {
    expect(summaryLine({ profile: 'ma', schedule: '30 9 * * *', skill: 'report', deliver: 'telegram:123' })).toBe(
      '매일 09:30에 ma 이(가) report 스킬을 돌려 결과를 텔레그램(으)로 보낸다.'
    );
  });
  it('저장만 하는 전달, 지시문만, 스크립트, 에이전트 없이', () => {
    expect(summaryLine({ profile: 'ma', schedule: '0 9 * * 1-5', deliver: 'local' })).toBe(
      '평일(월–금) 09:00에 ma 이(가) 지시문대로 일하고 결과를 저장만 한다(알림 없음).'
    );
    expect(summaryLine({ profile: 'ma', schedule: '30m', script: 'run.py', deliver: 'buzz', noAgent: true })).toBe(
      '30분마다에 ma 이(가) AI 에이전트 없이 스크립트 run.py 를 돌려 결과를 버즈(으)로 보낸다.'
    );
  });
  it('주기를 풀 수 없으면 원문, 없으면 주기 미정', () => {
    expect(summaryLine({ profile: 'ma', schedule: '0 9 * 3 *' })).toContain('주기 0 9 * 3 *에');
    expect(summaryLine({ profile: 'ma', schedule: '' })).toContain('주기 미정에');
  });
});

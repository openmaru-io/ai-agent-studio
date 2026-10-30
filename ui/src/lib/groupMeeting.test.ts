/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';

import { groupMeeting, MeetingLine } from './groupMeeting';

const m = (role: MeetingLine['role'], author: string, ts: string, kind?: string): MeetingLine => ({ role, author, ts, kind });
const T = (sec: number) => new Date(Date.UTC(2026, 9, 10, 1, 0, sec)).toISOString();

describe('groupMeeting', () => {
  it('같은 에이전트가 1분 안에 이어 말하면 첫 줄에만 머리줄', () => {
    expect(groupMeeting([m('assistant', 'sa', T(0)), m('assistant', 'sa', T(30)), m('assistant', 'sa', T(60))])).toEqual([true, false, false]);
  });

  it('1분을 넘기면 머리줄을 다시 보인다(경계는 60초까지 이어 붙임)', () => {
    expect(groupMeeting([m('assistant', 'sa', T(0)), m('assistant', 'sa', T(61))])).toEqual([true, true]);
  });

  it('다른 에이전트·사람·시스템 알림이 끼면 끊긴다', () => {
    expect(groupMeeting([m('assistant', 'sa', T(0)), m('assistant', 'doc', T(1)), m('assistant', 'sa', T(2))])).toEqual([true, true, true]);
    expect(groupMeeting([m('assistant', 'sa', T(0)), m('user', 'kim', T(1)), m('assistant', 'sa', T(2))])).toEqual([true, true, true]);
    expect(groupMeeting([m('assistant', 'sa', T(0)), m('system', '', T(1), 'soul_changed'), m('assistant', 'sa', T(2))])).toEqual([true, true, true]);
  });

  it('시각을 읽을 수 없으면 묶지 않는다(머리줄이 사라져 누가 말했는지 모르는 것이 더 나쁘다)', () => {
    expect(groupMeeting([m('assistant', 'sa', 'x'), m('assistant', 'sa', T(1))])).toEqual([true, true]);
  });

  it('빈 기록은 빈 배열', () => {
    expect(groupMeeting([])).toEqual([]);
  });
});

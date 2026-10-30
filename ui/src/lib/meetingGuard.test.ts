/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';

import { blockedLast, guardGroups, isGuardBlocked } from './meetingGuard';

const row = (id: number, author: string, role = 'assistant', kind?: string) => ({ id, author, role, kind });

describe('meetingGuard (스펙 2026-10-20-026 F2)', () => {
  it('훅 차단 안내는 핵심 구절과 80자 이하로 알아보고, 긴 정책 설명은 답으로 둔다', () => {
    expect(isGuardBlocked('🚫 죄송합니다. 입력하신 내용이 정책에 위반되어 처리할 수 없습니다.')).toBe(true);
    expect(isGuardBlocked('입력하신 내용이 정책에 위반되어 처리할 수 없습니다')).toBe(true);
    expect(isGuardBlocked('🚫 죄송합니다. 입력하신 내용이 정책에')).toBe(false); // 쓰는 중 앞부분은 아직 모른다
    expect(isGuardBlocked('가'.repeat(60) + ' 입력하신 내용이 정책에 위반되어 처리할 수 없습니다')).toBe(false);
    expect(isGuardBlocked('그 요청은 정책상 처리할 수 없습니다')).toBe(false);
    expect(isGuardBlocked(undefined)).toBe(false);
  });

  it('바로 이어진 차단 행은 첫 행에 별칭을 모으고 나머지는 건너뛴다', () => {
    const rows = [
      row(1, 'kim', 'user'),
      row(2, 'sa', 'system', 'guard_blocked'),
      row(3, 'doc', 'system', 'guard_blocked'),
      row(4, 'pm', 'system', 'guard_blocked'),
      row(5, 'sa'),
      row(6, 'doc', 'system', 'guard_blocked'),
    ];
    expect(guardGroups(rows)).toEqual([null, ['sa', 'doc', 'pm'], 'skip', 'skip', null, ['doc']]);
  });

  it('마지막 답이 차단 행인 에이전트만 고른다(답 도착 알림에서 뺀다)', () => {
    const rows = [row(1, 'sa', 'system', 'guard_blocked'), row(2, 'sa'), row(3, 'doc'), row(4, 'doc', 'system', 'guard_blocked'), row(5, 'kim', 'user')];
    expect([...blockedLast(rows)]).toEqual(['doc']);
  });
});

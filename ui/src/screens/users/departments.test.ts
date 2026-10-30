/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';

import { buildDeptRows, DeptApiRow, movedDeptText } from './departments';
import type { KcUser } from './logic';

const user = (o: Partial<KcUser>): KcUser =>
  ({
    key: o.email ?? 'k',
    id: o.email ?? 'k',
    username: (o.email ?? 'k').split('@')[0],
    email: 'k@corp.example',
    first_name: '',
    last_name: '',
    name: '',
    department: '',
    enabled: true,
    member: true,
    admin: false,
    admin_group: false,
    fixed: false,
    status: 'ok',
    pods: [],
    own_pods: [],
    shared_pods: [],
    sessions: 0,
    logins: 0,
    last_login: null,
    until: null,
    password: false,
    agents_running: 0,
    agents_suspended: 0,
    ...o,
  }) as KcUser;

const DEV: DeptApiRow = { name: '개발팀', goal: '', ts: '2026-10-01T00:00:00Z', managers: ['kim@corp.example'], moved: ['lee@corp.example'] };

describe('buildDeptRows — 팀 관리자(OMAI-1434 DT1)', () => {
  it('목록 줄은 서버의 managers·moved 를 그대로 옮긴다', () => {
    const rows = buildDeptRows([DEV], [user({ email: 'kim@corp.example', department: '개발팀' })], true);
    expect(rows[0].managers).toEqual(['kim@corp.example']);
    expect(rows[0].moved).toEqual(['lee@corp.example']);
  });

  it('사람 수를 몰라도 managers·moved 는 그대로다', () => {
    const rows = buildDeptRows([DEV], [], false);
    expect(rows[0].people).toBeNull();
    expect(rows[0].managers).toEqual(['kim@corp.example']);
    expect(rows[0].moved).toEqual(['lee@corp.example']);
  });

  it('옛 서버처럼 값이 없거나 목록 밖 줄이면 빈 목록이다', () => {
    const old = { name: '영업팀', goal: '', ts: '' } as DeptApiRow;
    const rows = buildDeptRows([old], [user({ email: 'park@corp.example', department: '기획팀' })], true);
    for (const r of rows) {
      expect(r.managers).toEqual([]);
      expect(r.moved).toEqual([]);
    }
  });
});

describe('movedDeptText — 옮긴 사람의 지금 부서(DD4)', () => {
  const users = [user({ email: 'lee@corp.example', department: '영업팀' }), user({ email: 'park@corp.example', department: '개발팀' })];
  it('사용자 목록에 다른 부서가 있으면 그 부서 이름', () => {
    expect(movedDeptText('LEE@corp.example', users, '개발팀')).toBe('지금 부서: 영업팀');
  });
  it('목록에 없거나 부서가 비었거나 아직 같은 부서로 보이면 「다른 부서」', () => {
    expect(movedDeptText('nobody@corp.example', users, '개발팀')).toBe('지금 부서: 다른 부서');
    expect(movedDeptText('park@corp.example', users, ' 개발팀 ')).toBe('지금 부서: 다른 부서');
  });
});

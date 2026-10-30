/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ALL,
  departmentOptions,
  deptRooms,
  filterAgents,
  filterPeople,
  initialDepartment,
  readDepartment,
  teamKey,
  writeDepartment,
} from './adminScope';

// 관리자의 「볼 부서」 고르기(스펙 2026-10-22-002)

const agent = (alias: string, team: string, extra: Record<string, unknown> = {}) => ({ alias, team, ...extra });
const room = (seats: string[], members: string[], teams: string[], extra: Record<string, unknown> = {}) => ({
  id: seats.length,
  kind: 'tft' as const,
  status: 'open' as const,
  seats,
  members,
  teams,
  ...extra,
});

describe('teamKey', () => {
  it('공백을 정리하고 80자로 자르고 소문자로(서버 office.team_key(office._text(d, 80)) 와 같은 규칙, A3)', () => {
    expect(teamKey('  Sales   Team ')).toBe('sales team');
    expect(teamKey('가'.repeat(90))).toBe('가'.repeat(80));
    expect(teamKey(undefined)).toBe('');
  });
});

describe('deptRooms', () => {
  it('그 부서 사람이 구성원인 열린 TFT 방만(D3a). 끝난 방·팀 방은 빼고, 부서는 teamKey 로 비교한다', () => {
    const rooms = [
      room(['a'], ['x@x.com'], ['개발본부']),
      room(['b', 'c'], ['y@x.com'], ['영업']),
      room(['d'], ['x@x.com'], ['개발본부'], { status: 'closed' }),
      room(['e'], ['x@x.com'], ['개발본부'], { kind: 'team' }),
    ];
    expect(deptRooms(rooms, ' 개발본부 ').map((r) => r.seats)).toEqual([['a']]);
    expect(deptRooms(rooms, ALL)).toEqual([]);
  });
});

describe('filterAgents', () => {
  const agents = [agent('a1', '개발본부'), agent('a2', '영업'), agent('a3', '영업'), agent('mine', '영업', { mine: true })];
  const rooms = [room(['a2'], ['dev@x.com'], ['개발본부']), room(['a3'], ['me@x.com'], ['영업'])];

  it('고른 부서의 팀 자리 + 그 부서의 TFT 방 자리(A3)', () => {
    expect(filterAgents(agents, '개발본부', rooms).map((a) => a.alias)).toEqual(['a1', 'a2']);
  });

  it('관리자 자신의 에이전트·TFT 방이라도 그 부서와 관계없으면 빠진다(D3)', () => {
    expect(filterAgents(agents, '개발본부', rooms).map((a) => a.alias)).not.toContain('mine');
  });

  it('「전체」는 거르지 않는다', () => {
    expect(filterAgents(agents, ALL, rooms)).toBe(agents);
  });
});

describe('filterPeople', () => {
  const people = [
    { id: 'p1', email: 'dev@x.com', department: '개발본부', me: false },
    { id: 'p2', email: 'sales@x.com', department: '영업', me: false },
    { id: 'p3', email: 'tft@x.com', department: '영업', me: false },
    { id: 'me', email: 'admin@x.com', department: '', me: true },
  ];
  const rooms = [room(['a2'], ['dev@x.com', 'TFT@x.com'], ['개발본부', '영업'])];

  it('같은 부서 + 그 부서 TFT 방 구성원 + 나(A4)', () => {
    expect(filterPeople(people, '개발본부', rooms).map((p) => p.id)).toEqual(['p1', 'p3', 'me']);
  });

  it('「전체」는 거르지 않는다', () => {
    expect(filterPeople(people, ALL, rooms)).toBe(people);
  });
});

describe('departmentOptions', () => {
  it('서버가 준 부서 이름만 쓰고 teamKey 로 겹침을 없앤 뒤 한국어 정렬(한글 다음 로마자, A6). 자리 팀은 넣지 않는다(사용자 정정 2026-10-22)', () => {
    expect(departmentOptions(['개발본부', 'QA', ' 개발본부', '', 'qa', '영업'])).toEqual(['개발본부', '영업', 'QA']);
  });
});

describe('initialDepartment', () => {
  const options = ['개발본부', '영업'];

  it('기억한 값 → 내 부서 → 전체 순서(A5)', () => {
    expect(initialDepartment('영업', '개발본부', options)).toBe('영업');
    expect(initialDepartment(ALL, '개발본부', options)).toBe(ALL);
    expect(initialDepartment(null, ' 개발본부 ', options)).toBe('개발본부');
    expect(initialDepartment(null, '', options)).toBe(ALL);
  });

  it('목록에 없는 기억 값은 버린다', () => {
    expect(initialDepartment('없어진 부서', '영업', options)).toBe('영업');
  });
});

describe('readDepartment·writeDepartment', () => {
  afterEach(() => vi.restoreAllMocks());

  it('브라우저에 기억하고, 저장소가 막혀 있어도 오류 없이 null 을 돌려준다(A5)', () => {
    writeDepartment('영업');
    expect(readDepartment()).toBe('영업');
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(() => writeDepartment('개발본부')).not.toThrow();
    expect(readDepartment()).toBeNull();
  });
});

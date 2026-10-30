/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 부서 목록(스펙 2026-10-15-026)의 화면 로직. 화면과 따로 두어 Vitest 로 시험한다.
// - GET /api/departments: 관리자가 정한 부서 목록. 사용자 폼의 후보와 부서 탭이 같은 캐시(['departments'], staleTime 60초)를 쓴다
// - buildDeptRows: 목록 + Keycloak 사용자 목록 → 부서 탭의 줄. 사람 수는 Keycloak 값(결정 R1), 목록 밖 부서는 맨 위(R6/2C)
// - managers·moved: 팀 관리자(OMAI-1434). 서버가 지금 구성원인 팀 관리자(managers)와 부서를 옮겨 권한이 없는 사람(moved)을 나눠 준다
import { useQuery } from '@tanstack/react-query';

import { t } from '@/i18n';
import { get } from '@/lib/api';

import type { KcUser } from './logic';

export interface DeptApiRow {
  name: string;
  goal: string;
  ts: string;
  /** 팀 관리자 이메일(지금 이 부서 구성원인 사람만, OMAI-1434) */
  managers?: string[];
  /** 팀 관리자 행은 있지만 부서를 옮겼거나 부서를 모르는 사람의 이메일. 권한이 없다(디자인 DD4) */
  moved?: string[];
}

export interface DeptRow {
  key: string;
  name: string;
  goal: string;
  ts: string;
  /** 부서 목록에 있는가. 거짓이면 Keycloak 사용자에게만 있는 「목록에 없음」 */
  listed: boolean;
  members: KcUser[];
  /** 사람 수. Keycloak 사용자 목록을 알 수 없으면 null(「알 수 없음」, 0 이 아니다) */
  people: number | null;
  managers: string[];
  moved: string[];
}

export const DEPT_KEY = ['departments'];

/** 서버 team_key(office.team_key)와 같은 기준: 앞뒤·연속 공백을 정리하고 대소문자를 가리지 않는다 */
export const teamKey = (s: string | null | undefined) => (s ?? '').split(/\s+/).filter(Boolean).join(' ').toLowerCase();

export const useDepartments = (enabled = true) =>
  useQuery<{ departments: DeptApiRow[] }>({
    queryKey: DEPT_KEY,
    queryFn: () => get<{ departments: DeptApiRow[] }>('/api/departments'),
    staleTime: 60_000,
    enabled,
  });

/**
 * 부서 탭의 줄. usersKnown 이 거짓(Keycloak 에 닿지 않았거나 사용자 목록을 받지 못함)이면 사람 수를 모르는 것이라
 * people 은 null 이고 목록 밖 줄은 만들지 않는다(2C·결정 R1). 목록 밖 줄이 맨 위, 나머지는 이름 순이다.
 */
export function buildDeptRows(list: DeptApiRow[], users: KcUser[], usersKnown: boolean): DeptRow[] {
  const byKey = new Map<string, KcUser[]>();
  if (usersKnown)
    for (const u of users) {
      const k = teamKey(u.department);
      if (k) byKey.set(k, [...(byKey.get(k) ?? []), u]);
    }
  const listedKeys = new Set(list.map((d) => teamKey(d.name)));
  const listed: DeptRow[] = list.map((d) => {
    const members = byKey.get(teamKey(d.name)) ?? [];
    return {
      key: teamKey(d.name),
      name: d.name,
      goal: d.goal,
      ts: d.ts,
      listed: true,
      members,
      people: usersKnown ? members.length : null,
      managers: d.managers ?? [],
      moved: d.moved ?? [],
    };
  });
  const off: DeptRow[] = [];
  for (const [k, members] of byKey) {
    if (listedKeys.has(k)) continue;
    const spellings = new Map<string, number>();
    for (const m of members) spellings.set(m.department, (spellings.get(m.department) ?? 0) + 1);
    const name = [...spellings.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'ko'))[0][0];
    off.push({ key: k, name, goal: '', ts: '', listed: false, members, people: members.length, managers: [], moved: [] });
  }
  const byName = (a: DeptRow, b: DeptRow) => a.name.localeCompare(b.name, 'ko', { numeric: true, sensitivity: 'base' });
  return [...off.sort(byName), ...listed.sort(byName)];
}

/** 부서 탭 배지 숫자(목록 + 목록 밖 줄 수)와 주의 여부(목록 밖 줄이 있는가, 결정 7A) */
export const deptBadge = (rows: DeptRow[]) => ({ count: rows.length, attention: rows.some((r) => !r.listed) });

/** 부서를 옮긴 팀 관리자의 툴팁 「지금 부서: X」(디자인 DD4). 사용자 목록에서 다른 부서를 찾지 못하면 X 는 「다른 부서」다 */
export function movedDeptText(email: string, users: KcUser[], deptName: string): string {
  const u = users.find((x) => x.email.toLowerCase() === email.toLowerCase());
  const dept = u?.department.trim() && teamKey(u.department) !== teamKey(deptName) ? u.department.trim() : t('users.dept.managers.otherDept');
  return t('users.dept.managers.now', { dept });
}

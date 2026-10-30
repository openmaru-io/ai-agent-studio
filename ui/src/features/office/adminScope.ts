/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 관리자가 3D 오피스에서 볼 부서를 고른다(스펙 2026-10-22-002). 관리자는 이미 모든 데이터를 받으므로 화면에서 거른다.
// 부서를 고르면 그 부서 팀 자리와, 그 부서 사람이 구성원인 열린 TFT 방의 에이전트·사람이 보인다(D3·D3a). 관리자 자신의 TFT 방이 아니다.

/** 「전체」(거르지 않음). localStorage 에도 이 값으로 적는다. */
export const ALL = '*';

const PREF_KEY = 'aas.office.adminDepartment';

/** 부서·자리 팀 비교용 — 서버 `office.team_key(office._text(d, 80))` 와 같은 규칙. 서버는 casefold, 여기는 toLowerCase(스펙 §4-7). */
export function teamKey(name: string | null | undefined): string {
  return String(name ?? '')
    .split(/\s+/)
    .filter(Boolean)
    .join(' ')
    .slice(0, 80)
    .toLowerCase();
}

export interface ScopeRoom {
  kind?: 'tft' | 'team';
  status: 'open' | 'closed';
  seats: string[];
  /** 구성원 이메일(관리자에게만 온다). */
  members?: string[];
  /** 구성원 부서의 team_key(관리자에게만 온다). */
  teams?: string[];
}

/** 그 부서 사람이 구성원인 열린 TFT 방(D3a). 「전체」면 빈 목록. */
export function deptRooms<R extends ScopeRoom>(rooms: R[], dept: string): R[] {
  if (dept === ALL) return [];
  const key = teamKey(dept);
  return rooms.filter((r) => (r.kind ?? 'tft') === 'tft' && r.status !== 'closed' && (r.teams ?? []).includes(key));
}

/** 장면에 그릴 에이전트: 고른 부서의 팀 자리 + 그 부서의 TFT 방 자리. 「전체」면 그대로. */
export function filterAgents<A extends { alias: string; team?: string }>(agents: A[], dept: string, rooms: ScopeRoom[]): A[] {
  if (dept === ALL) return agents;
  const key = teamKey(dept);
  const seats = new Set(deptRooms(rooms, dept).flatMap((r) => r.seats));
  return agents.filter((a) => teamKey(a.team) === key || seats.has(a.alias));
}

/** 장면·사람 띠에 그릴 사람: 같은 부서 + 그 부서의 TFT 방 구성원 + 나. 「전체」면 그대로. */
export function filterPeople<P extends { email?: string; department?: string; me: boolean }>(people: P[], dept: string, rooms: ScopeRoom[]): P[] {
  if (dept === ALL) return people;
  const key = teamKey(dept);
  const members = new Set(deptRooms(rooms, dept).flatMap((r) => (r.members ?? []).map((m) => m.toLowerCase())));
  return people.filter((p) => p.me || teamKey(p.department) === key || members.has((p.email ?? '').toLowerCase()));
}

/** 콤보박스 항목: 서버가 준 부서 이름(AAS 부서 목록 + 목록에 없는 내 부서)을 teamKey 로 겹침 없이, 한국어 정렬.
 * 사람 부서 기록·자리 팀은 넣지 않는다 — 옛 시험 계정의 부서가 섞였다(사용자 정정 2026-10-22). */
export function departmentOptions(names: string[]): string[] {
  const byKey = new Map<string, string>();
  for (const name of names) {
    const key = teamKey(name);
    if (key && !byKey.has(key)) byKey.set(key, name);
  }
  return [...byKey.values()].sort((a, b) => teamKey(a).localeCompare(teamKey(b), 'ko'));
}

/** 처음 값(D1·D4): 기억한 값이 목록에 있으면 그 값 → 내 부서 → 「전체」. */
export function initialDepartment(saved: string | null, mine: string | null | undefined, options: string[]): string {
  if (saved === ALL) return ALL;
  const find = (name: string | null | undefined) => {
    const key = teamKey(name);
    return key ? options.find((o) => teamKey(o) === key) : undefined;
  };
  return find(saved) ?? find(mine) ?? ALL;
}

export function readDepartment(): string | null {
  try {
    return localStorage.getItem(PREF_KEY);
  } catch {
    return null;
  }
}

export function writeDepartment(dept: string): void {
  try {
    localStorage.setItem(PREF_KEY, dept);
  } catch {
    /* 저장소가 막혀 있으면 이번 화면에서만 기억한다 */
  }
}

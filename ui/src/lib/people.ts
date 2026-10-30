/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 사람을 고르는 입력(PersonPicker)의 후보(OMAI-1229). GET /api/users 의 사용자 — 관리자 전용 API 라 담당·새 주인을 쓸 수 있는 사람(관리자)과 권한이 같다.
// Keycloak 방식은 사용자마다 이름·이메일·부서가 있고, 옛 방식(mode=legacy)은 이메일만 있다(이름은 이메일의 @ 앞).
import { useQuery } from '@tanstack/react-query';
import { useCallback, useMemo } from 'react';

import { get } from './api';
import { useMe } from './data';

export interface Person {
  email: string;
  name: string;
  /** 로그인 아이디. 고르는 목록에 이메일 대신 보인다(2026-10-20). 없으면 아이디 줄을 비운다 */
  username?: string;
  department?: string;
}

interface RawUser {
  email?: string;
  name?: string;
  username?: string;
  department?: string;
  enabled?: boolean;
}

/** 쓸 수 있는 사용자(이메일이 있고 비활성이 아닌 사람)를 이름순으로. 목록을 읽지 못하면 빈 목록이다(입력은 직접 적기로 그대로 동작). */
export function toPeople(users: RawUser[] | undefined): Person[] {
  const seen = new Set<string>();
  const out: Person[] = [];
  for (const u of users ?? []) {
    const email = (u.email ?? '').trim();
    if (!email || u.enabled === false || seen.has(email)) continue;
    seen.add(email);
    // 옛 방식(legacy)은 아이디가 없어 이메일의 @ 앞을 아이디로 보인다(서버 _dept_members 와 같은 규칙)
    const username = (u.username ?? '').trim() || email.split('@')[0];
    out.push({ email, name: (u.name ?? '').trim() || email.split('@')[0], username, department: u.department?.trim() || undefined });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name, 'ko') || a.email.localeCompare(b.email));
}

export function usePeople(enabled: boolean): Person[] {
  const q = useQuery<{ users?: RawUser[] }>({ queryKey: ['users'], queryFn: () => get('/api/users'), enabled, staleTime: 60000 });
  return useMemo(() => toPeople(q.data?.users), [q.data]);
}

/** 이메일 → 사람 이름. 사용자 목록은 관리자만 읽으므로 관리자가 아니면 늘 undefined(화면은 이메일을 쓴다). 에이전트 글자(lib/agentLabel)에 넘긴다 */
export function useNameOfEmail(): (email: string) => string | undefined {
  const people = usePeople(!!useMe().data?.admin);
  return useCallback((email: string) => people.find((p) => p.email.toLowerCase() === email.toLowerCase())?.name, [people]);
}

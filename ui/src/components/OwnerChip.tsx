/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 소유자(이메일)를 사람 이름 칩으로(2026-10-18). 이름은 사용자 목록(GET /api/users, 관리자 전용)에서 찾는다.
// 소유자 이메일이 보이는 곳은 모두 관리자 화면이다. 관리자가 아니거나 목록에 없으면 이메일 그대로 보인다. 이메일은 칩의 풍선말.
import { useMe } from '@/lib/data';
import { usePeople } from '@/lib/people';

import { UserChip } from './UserChip';

// 서버가 이름(owner_name)을 함께 주면 그것을 쓴다 — 관리자가 아니어도 이름으로 보인다(2026-10-30)
export function OwnerChip({ email, size, name: given }: { email: string; size?: 'sm' | 'md'; name?: string }) {
  const admin = !!useMe().data?.admin;
  const people = usePeople(admin && !given);
  const name = given || people.find((p) => p.email.toLowerCase() === email.toLowerCase())?.name;
  return <UserChip name={name} email={email} size={size} />;
}

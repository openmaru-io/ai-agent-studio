/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { t } from '@/i18n';

/** Hermes provenance 중 「스킬」 탭 출처와 뜻이 같은 값(agent·external 은 뜻이 넓어 그대로 둔다) */
const SAME_AS_ORIGIN: Record<string, string> = { bundled: 'bundled', hub: 'hub' };

/**
 * 프로파일 패널 스킬 줄의 출처 이름표(스펙 2026-10-27-007 R6). 「스킬」 탭 목록에서 같은 프로파일·이름으로 찾은 origin 을 먼저 쓰고,
 * 못 찾으면 Hermes provenance 중 bundled·hub 만 같은 이름표로, 나머지는 받은 값 그대로 보인다. 다른 프로파일의 줄은 쓰지 않는다.
 */
export function skillOriginLabel(
  rows: { name: string; profile: string; origin?: string }[],
  profile: string,
  name: string,
  provenance?: string
): string {
  const origin = rows.find((r) => r.profile === profile && r.name === name)?.origin ?? SAME_AS_ORIGIN[provenance ?? ''];
  return origin ? t(`skills.origin.${origin}` as Parameters<typeof t>[0]) : provenance ?? '';
}

/** 「기본 제공」 출처(스펙 2026-10-27-011 R1): Hermes 기본·AAS 기본. 닫힌 목록이라 새 출처가 생기면 「내 스킬」 쪽에 보인다 */
export const BUILTIN_ORIGINS: ReadonlySet<string> = new Set(['bundled', 'aas']);

/** 내 스킬인가: 기본 제공이 아닌 것 전부(직접·에이전트·스킬 허브·Hermes 허브·기본을 바꾼 것). 출처가 빈 줄도 내 스킬로 센다 */
export const isMySkill = (origin?: string): boolean => !BUILTIN_ORIGINS.has(origin ?? '');

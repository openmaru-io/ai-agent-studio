/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 회의 기록의 가드레일 차단 줄(스펙 2026-10-20-026 F2). 서버(aas/office/meeting.py 의 GUARD_KIND·GUARD_PHRASE·GUARD_MAX)와 같은 값을 쓴다.

export const GUARD_KIND = 'guard_blocked';
/** 훅 차단 안내(openmaru-cogentai aas_guardrail_hook.py BLOCKED_NOTICE)를 알아보는 구절. 이모지·앞부분이 바뀌어도 알아본다 */
export const GUARD_PHRASE = '정책에 위반되어 처리할 수 없습니다'; // i18n-ignore: 훅 차단 안내를 알아보는 비교용 구절
/** 정책을 설명하는 긴 답을 차단으로 잘못 보지 않는 길이 한도(글자) */
export const GUARD_MAX = 80;

interface Row {
  author: string;
  role: string;
  kind?: string;
}

export function isGuardBlocked(text?: string | null): boolean {
  const s = (text ?? '').trim();
  return s.length > 0 && s.length <= GUARD_MAX && s.includes(GUARD_PHRASE);
}

/** 행마다: 차단 줄 묶음의 첫 행이면 그 묶음의 별칭들, 묶음의 뒷 행이면 'skip', 아니면 null.
 *  모두에게 보낸 말이 막히면 에이전트마다 행이 생기므로 바로 이어진 행을 한 줄·한 알림으로 묶는다(디자인 리뷰 DD6). */
export function guardGroups(rows: Row[]): (string[] | 'skip' | null)[] {
  const out: (string[] | 'skip' | null)[] = rows.map(() => null);
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].kind !== GUARD_KIND) continue;
    if (i > 0 && rows[i - 1].kind === GUARD_KIND) continue;
    const names: string[] = [];
    for (let j = i; j < rows.length && rows[j].kind === GUARD_KIND; j++) {
      if (!names.includes(rows[j].author)) names.push(rows[j].author);
      if (j > i) out[j] = 'skip';
    }
    out[i] = names;
  }
  return out;
}

/** 마지막 답(assistant 행 또는 차단 행)이 차단 행인 에이전트. 답 도착 알림에서 빼 차단 줄 알림과 어긋나지 않게 한다(DD12). */
export function blockedLast(rows: Row[]): Set<string> {
  const last = new Map<string, boolean>();
  for (const r of rows) {
    if (r.kind === GUARD_KIND) last.set(r.author, true);
    else if (r.role === 'assistant') last.set(r.author, false);
  }
  return new Set([...last].filter(([, blocked]) => blocked).map(([a]) => a));
}

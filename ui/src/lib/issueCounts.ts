/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 문제 수를 한 곳에서 센다(계획 2026-10-14-014 R4). 메뉴 숫자·대시보드 숫자·확인할 것이 이 함수들을 함께 쓴다.
// 메뉴와 대시보드는 다른 것을 세므로 이름을 나눈다:
//   cronBad       운영 메뉴 숫자 — 지금도 실패 중인 문제(옛 수집 결과면 열린 문제) + 마지막 실행이 실패한 작업
//   failedStalled 대시보드 숫자 「실패·멈춘 작업」 — 마지막 실행이 실패한 작업 + 멈춘 작업
type Totals = Record<string, number | undefined>;

export interface CredLike {
  flags?: string[];
}

export function cronBad(totals?: Totals | null): number {
  const t = totals ?? {};
  return (t.live_incidents ?? t.open_incidents ?? 0) + (t.failed_jobs || 0);
}

export function failedStalled(totals?: Totals | null): number {
  const t = totals ?? {};
  return (t.failed_jobs ?? 0) + (t.stalled ?? 0);
}

/** 만료됐거나 곧 만료되는 자격증명. 백업·임시 파일은 뺀다(서버 dashboard.expiring_credentials 와 같은 규칙). */
export function expiringCreds<T extends CredLike>(items: T[]): T[] {
  return items.filter((i) => (i.flags ?? []).some((f) => /만료/.test(f)) && !(i.flags ?? []).some((f) => /백업/.test(f)));
}

/**
 * 「확인할 것」 항목을 누가 고칠 수 있는가(디자인 DD7). 크론 실행·음소거, 프로파일 설정, 자격증명 파일은
 * 관리자만 바꾼다(server.py 의 cron/action·cron/mute·profile/action). 관리자가 아니면 줄을 보이되 누르지 못하게 한다.
 */
export type IssueKind = 'waiting' | 'failed' | 'stalled' | 'profiles' | 'creds' | 'tidy';
export const fixableBy = (kind: IssueKind): 'admin' | 'owner' => (kind === 'waiting' ? 'owner' : 'admin');

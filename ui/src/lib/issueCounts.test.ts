/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';

import { cronBad, expiringCreds, failedStalled, fixableBy } from './issueCounts';

describe('문제 수 세기(계획 2026-10-14-014 R4)', () => {
  const totals = { live_incidents: 2, open_incidents: 9, failed_jobs: 1, stalled: 4 };

  it('운영 메뉴 숫자는 지금도 실패 중인 문제 + 마지막 실행 실패, 옛 수집 결과면 열린 문제를 쓴다', () => {
    expect(cronBad(totals)).toBe(3);
    expect(cronBad({ open_incidents: 5, failed_jobs: 0 })).toBe(5);
    expect(cronBad(null)).toBe(0);
  });

  it('대시보드 「실패·멈춘 작업」 은 마지막 실행 실패 + 멈춤이다', () => {
    expect(failedStalled(totals)).toBe(5);
    expect(failedStalled(undefined)).toBe(0);
  });

  it('만료 자격증명은 백업 파일을 뺀다', () => {
    const items = [{ flags: ['만료됨'] }, { flags: ['30일 뒤 만료'] }, { flags: ['만료됨', '백업·임시 파일'] }, {}];
    expect(expiringCreds(items)).toHaveLength(2);
  });

  it('답을 기다리는 대화만 주인이 처리하고 나머지는 관리자가 고친다(디자인 DD7)', () => {
    expect(fixableBy('waiting')).toBe('owner');
    for (const k of ['failed', 'stalled', 'profiles', 'creds', 'tidy'] as const) expect(fixableBy(k)).toBe('admin');
  });
});

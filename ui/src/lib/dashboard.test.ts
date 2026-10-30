/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it } from 'vitest';

import { chartSpecs } from '@/screens/dashboard/trendData';

import { DashPod, filterPods, hoursOld, sortPods } from './dashboard';

const V = { profiles: 1, gateways_up: 1, profiles_bad: 0, creds_expiring: 0, jobs: 1, jobs_active: 1, failed_jobs: 0, stalled_jobs: 0, open_incidents: 0 };
const pod = (id: string, over: Partial<DashPod> = {}): DashPod => ({
  id,
  owner_me: false,
  ready: true,
  phase: 'Ready',
  collected: true,
  ok: true,
  reason: '',
  ts: null,
  checked: null,
  stale: false,
  values: V,
  last_day: null,
  ...over,
});

afterEach(() => sessionStorage.clear());

describe('대시보드 계산', () => {
  const pods = [
    pod('z'),
    pod('fail', { ok: false }),
    pod('bad', { values: { ...V, profiles_bad: 1 } }),
    pod('worse', { values: { ...V, failed_jobs: 2, creds_expiring: 1 } }),
    pod('new', { ready: false, collected: false, values: null }),
    pod('a'),
  ];

  it('표는 문제 수 → 수집 실패 → 이름 순, 준비 중은 끝', () => {
    expect(sortPods(pods).map((p) => p.id)).toEqual(['worse', 'bad', 'fail', 'a', 'z', 'new']);
  });

  it('거름: 실패·멈춤, 문제 프로파일, 수집 실패', () => {
    expect(filterPods(pods, 'failing').map((p) => p.id)).toEqual(['worse']);
    expect(filterPods(pods, 'profiles').map((p) => p.id)).toEqual(['bad']);
    expect(filterPods(pods, 'collect').map((p) => p.id)).toEqual(['fail']);
    expect(filterPods(pods, 'all')).toHaveLength(6);
  });

  it('1시간을 넘은 값만 몇 시간 전인지 센다', () => {
    const now = '2026-10-14T12:00:00+09:00';
    expect(hoursOld('2026-10-14T11:30:00+09:00', now)).toBe(0);
    expect(hoursOld('2026-10-14T09:59:00+09:00', now)).toBe(2);
    expect(hoursOld(null, now)).toBe(0);
  });

  it('추이 3장은 같은 날짜 축을 쓰고 없는 날은 비운다', () => {
    const specs = chartSpecs(
      [{ day: '2026-10-12', runs_7d: 4, failed_jobs: 1, stalled: 0, open_incidents: 2, collect_errors: 0 }],
      [{ day: '2026-10-13', sessions: 1, messages: 1, input_tokens: 10, output_tokens: 5 }]
    );
    expect(specs.map((s) => s.days)).toEqual([Array(2).fill(0).map((_, i) => `2026-10-1${i + 2}`), ['2026-10-12', '2026-10-13'], ['2026-10-12', '2026-10-13']]);
    expect(specs[0].series.map((s) => s.values)).toEqual([[4, null], [1, null], [0, null]]);
    expect(specs[2].series[0].values).toEqual([null, 15]);
    expect(specs[0].aria).toContain('2일');
  });
});

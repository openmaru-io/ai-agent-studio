/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { officeNeedsReread, officeRereadDelay, useOfficeChanged } from './officeChanged';

// 토픽 office:changed 의 받는 함수를 잡아 두고 시험이 서버 push 를 흉내 낸다
const pushed = vi.hoisted(() => ({ fn: null as ((d: unknown) => void) | null, topic: '' as string | null }));
vi.mock('@/lib/ws', async (orig) => ({
  ...(await orig<typeof import('@/lib/ws')>()),
  useTopic: (topic: string | null, onData: (d: unknown) => void) => {
    pushed.fn = onData;
    pushed.topic = topic;
    return true;
  },
}));

// 오피스 정보 변경 신호(스펙 2026-10-26-001 시험 T8·T9, 리뷰 D8·D13)
describe('다시 읽어야 하나', () => {
  it('처음 값은 읽지 않고, n 이 바뀌면 누구나 읽는다', () => {
    expect(officeNeedsReread(null, { n: 3, admin: 1 }, false)).toBe(false);
    expect(officeNeedsReread({ n: 3, admin: 1 }, { n: 4, admin: 1 }, false)).toBe(true);
  });
  it('관리자 전용 번호(admin)만 바뀌면 관리자만 읽는다', () => {
    expect(officeNeedsReread({ n: 3, admin: 1 }, { n: 3, admin: 2 }, false)).toBe(false);
    expect(officeNeedsReread({ n: 3, admin: 1 }, { n: 3, admin: 2 }, true)).toBe(true);
  });
  it('다시 읽기는 묶기 500ms 뒤 0~1,000ms 사이에서 퍼진다', () => {
    expect(officeRereadDelay(() => 0)).toBe(500);
    expect(officeRereadDelay(() => 0.999)).toBe(1499);
  });
});

describe('useOfficeChanged', () => {
  let qc: QueryClient;
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  beforeEach(() => {
    vi.useFakeTimers();
    qc = new QueryClient();
  });
  afterEach(() => vi.useRealTimers());

  it('office:changed 를 구독하고, 500ms 안에 온 신호 셋을 다시 읽기 한 번으로 묶는다', () => {
    const spy = vi.spyOn(qc, 'invalidateQueries');
    renderHook(() => useOfficeChanged(false, () => 0.5), { wrapper });
    expect(pushed.topic).toBe('office:changed');
    act(() => pushed.fn?.({ n: 1, admin: 0 }));                  // 처음 값 — 읽지 않는다
    act(() => {
      pushed.fn?.({ n: 2, admin: 0 });
      vi.advanceTimersByTime(200);
      pushed.fn?.({ n: 3, admin: 0 });
      vi.advanceTimersByTime(200);
      pushed.fn?.({ n: 4, admin: 0 });
    });
    act(() => vi.advanceTimersByTime(599));                       // 첫 신호 뒤 999ms: 아직(500 + 0.5×1,000)
    expect(spy).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1));
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith({ queryKey: ['office'] });
  });

  it('일반 사용자는 관리자 전용 번호만 바뀌면 다시 읽지 않고, 관리자는 읽는다', () => {
    const spy = vi.spyOn(qc, 'invalidateQueries');
    const { rerender } = renderHook(({ admin }) => useOfficeChanged(admin, () => 0), { wrapper, initialProps: { admin: false } });
    act(() => pushed.fn?.({ n: 1, admin: 1 }));
    act(() => pushed.fn?.({ n: 1, admin: 2 }));
    act(() => vi.advanceTimersByTime(2000));
    expect(spy).not.toHaveBeenCalled();
    rerender({ admin: true });                                    // 내 정보를 읽은 뒤 관리자로 알게 된 경우
    act(() => pushed.fn?.({ n: 1, admin: 3 }));
    act(() => vi.advanceTimersByTime(500));
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

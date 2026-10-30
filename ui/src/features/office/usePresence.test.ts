/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { stubApi } from '@/test/mountScreen';

import { PRESENCE_EVERY_MS, usePresence } from './usePresence';

// 웹소켓 상태와 클라이언트를 대역으로 바꾼다. 구독의 받는 함수·오류 함수를 잡아 시험이 서버를 흉내 낸다
const ws = vi.hoisted(() => ({
  state: 'live' as string,
  published: [] as { topic: string; data: Record<string, unknown> }[],
  onData: null as ((d: unknown) => void) | null,
  onError: null as ((code: string) => void) | null,
  subs: 0,
  order: [] as string[],
}));
vi.mock('@/lib/ws', () => ({
  useWsState: () => ws.state,
  wsClient: {
    subscribe: (_t: string, fn: (d: unknown) => void, onError?: (code: string) => void) => {
      ws.subs += 1;
      ws.order.push('sub');
      ws.onData = fn;
      ws.onError = onError ?? null;
      return () => undefined;
    },
    publish: (topic: string, data: Record<string, unknown>) => {
      ws.published.push({ topic, data });
      ws.order.push('pub');
      return true;
    },
  },
}));

const presencePosts = (fn: ReturnType<typeof stubApi>) =>
  fn.mock.calls.filter(([u]) => String(u) === '/api/office/presence').map(([, init]) => JSON.parse(String((init as RequestInit).body)));

// 사람 신호(스펙 2026-10-26-001 시험 T7b·T11·T11a, 회귀 계약 4)
describe('usePresence', () => {
  let fn: ReturnType<typeof stubApi>;
  beforeEach(() => {
    vi.useFakeTimers();
    ws.state = 'live';
    ws.published = [];
    ws.onData = ws.onError = null;
    ws.subs = 0;
    ws.order = [];
    fn = stubApi({ '/api/office/presence': { people: [{ id: 'p', name: 'POST', seed: 's', viewing: 'room', me: true }] }, '/api/office/face': { ok: true } });
  });
  afterEach(() => vi.useRealTimers());

  it('웹소켓이면 POST 를 보내지 않고 토픽으로 목록을 받으며, 10초 반복 신호를 보내지 않는다', () => {
    const { result } = renderHook(() => usePresence('room'));
    expect(ws.published).toEqual([{ topic: 'office:people', data: { beat: 'room' } }]);
    act(() => ws.onData?.({ people: [{ id: 'k', name: '김', seed: 's', viewing: 'room', me: true }] }));
    expect(result.current.people.map((p) => p.name)).toEqual(['김']);
    act(() => vi.advanceTimersByTime(PRESENCE_EVERY_MS * 3));
    expect(ws.published).toHaveLength(1);
    expect(presencePosts(fn)).toEqual([]);
  });

  it('신호를 구독보다 먼저 보낸다 — 서버가 차례로 처리해 첫 사람 목록에 내가 들어 있다', () => {
    renderHook(() => usePresence('room'));
    expect(ws.order).toEqual(['pub', 'sub']);
  });

  it('탭을 바꾸면 leave 없이 바뀐 탭의 신호 하나만 보내고, 화면을 떠날 때만 leave 를 보낸다(웹소켓)', () => {
    const { rerender, unmount } = renderHook(({ v }) => usePresence(v), { initialProps: { v: 'room' } });
    rerender({ v: 'kanban' });
    expect(ws.published.map((p) => p.data)).toEqual([{ beat: 'room' }, { beat: 'kanban' }]);
    unmount();
    expect(ws.published.at(-1)?.data).toEqual({ leave: true });
  });

  it('웹소켓이 없으면 지금처럼 POST 를 10초마다 보내고, 탭을 바꿔도 leave 를 보내지 않는다', async () => {
    ws.state = 'off';
    const { rerender, unmount } = renderHook(({ v }) => usePresence(v), { initialProps: { v: 'room' } });
    await act(async () => vi.advanceTimersByTime(PRESENCE_EVERY_MS));
    expect(presencePosts(fn)).toEqual([{ viewing: 'room' }, { viewing: 'room' }]);
    rerender({ v: 'kanban' });
    expect(presencePosts(fn).at(-1)).toEqual({ viewing: 'kanban' });
    expect(presencePosts(fn).some((b) => b.leave)).toBe(false);
    unmount();
    expect(presencePosts(fn).at(-1)).toEqual({ leave: true });
    expect(ws.published).toEqual([]);
  });

  it('옛 서버가 토픽을 모르면(unknown_topic) POST 로 돌아간다', () => {
    renderHook(() => usePresence('room'));
    act(() => ws.onError?.('unknown_topic'));
    expect(presencePosts(fn)).toEqual([{ viewing: 'room' }]);
  });

  it('얼굴을 바꾸면 신호를 한 번 바로 보낸다 — 사람 목록의 얼굴이 모두에게 바뀐다', async () => {
    const { result } = renderHook(() => usePresence('room'));
    await act(async () => {
      await result.current.changeFace('new-seed');
    });
    expect(ws.published.map((p) => p.data)).toEqual([{ beat: 'room' }, { beat: 'room' }]);
  });
});

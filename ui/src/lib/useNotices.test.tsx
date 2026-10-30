/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 공지 목록과 닫은 공지(스펙 2026-10-24-007 R4·3C·O8·E7·Q-b)
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DISMISSED_KEY, Notice, noticeStore, sortNotices, useNotices } from './useNotices';

// 웹소켓 토픽은 대역: live 여부와 받은 값을 시험이 정한다
const topic = vi.hoisted(() => ({ live: false, push: null as null | ((d: unknown) => void) }));
vi.mock('./ws', async (orig) => ({
  ...(await orig<typeof import('./ws')>()),
  useTopic: (_name: string, onData: (d: unknown) => void) => {
    topic.push = onData;
    return topic.live;
  },
}));

const N = (id: number, kind: Notice['kind'], extra: Partial<Notice> = {}): Notice => ({
  id,
  kind,
  title: `공지${id}`,
  body: '',
  link: '',
  starts_at: '2026-10-24T00:00:00+00:00',
  ends_at: '2099-01-01T00:00:00+00:00',
  dismissible: kind !== 'outage',
  updated_ts: 't',
  reshow_ts: 'r1',
  ...extra,
});

let meNotices: Notice[] = [];
function setup() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.resolve(new Response(JSON.stringify({ auth_enabled: true, admin: false, user: { email: 'a@x' }, pods: [], notices: meNotices }), { status: 200 })))
  );
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  return { qc, ...renderHook(() => useNotices(), { wrapper }) };
}

beforeEach(() => {
  localStorage.clear();
  noticeStore.reset();
  topic.live = false;
  topic.push = null;
  meNotices = [];
});
afterEach(() => vi.restoreAllMocks());

describe('useNotices', () => {
  it('서버와 같은 순서: 장애 → 작업 → 중단 예정 → 새 기능 → 안내, 같은 종류는 시작이 늦은 것 먼저', () => {
    const list = sortNotices([
      N(1, 'info'),
      N(2, 'feature'),
      N(3, 'maintenance', { starts_at: '2026-10-20T00:00:00+00:00' }),
      N(4, 'maintenance', { starts_at: '2026-10-22T00:00:00+00:00' }),
      N(5, 'outage'),
      N(6, 'deprecation'),
    ]);
    expect(list.map((n) => n.id)).toEqual([5, 4, 3, 6, 2, 1]);
  });

  it('웹소켓이 live 가 아니면 /api/me 의 notices 를 쓴다(R4)', async () => {
    meNotices = [N(1, 'info')];
    const { result } = setup();
    await waitFor(() => expect(result.current.all?.map((n) => n.id)).toEqual([1]));
  });

  it('토픽이 live 면 토픽 값을 쓰고, 배열이 아닌 값({error})은 버리고 지난 값을 둔다(O8)', async () => {
    meNotices = [N(1, 'info')];
    topic.live = true;
    const { result } = setup();
    act(() => topic.push?.([N(2, 'feature')]));
    await waitFor(() => expect(result.current.all?.map((n) => n.id)).toEqual([2]));
    act(() => topic.push?.({ error: 'boom' }));
    expect(result.current.all?.map((n) => n.id)).toEqual([2]);
  });

  it('닫으면 localStorage 에 id:reshow_ts 로 남고, reshow_ts 가 바뀌면(닫은 사람에게 다시 보이기) 다시 보인다(3C)', async () => {
    meNotices = [N(1, 'info')];
    const { result, qc } = setup();
    await waitFor(() => expect(result.current.visible).toHaveLength(1));
    act(() => result.current.dismiss(result.current.visible[0]));
    expect(result.current.visible).toHaveLength(0);
    expect(result.current.all).toHaveLength(1); // 계정 메뉴 「지금 공지」에는 남는다
    expect(JSON.parse(localStorage.getItem(DISMISSED_KEY)!)).toEqual(['1:r1']);

    meNotices = [N(1, 'info', { reshow_ts: 'r2' })];
    await act(() => qc.invalidateQueries({ queryKey: ['me'] }));
    await waitFor(() => expect(result.current.visible).toHaveLength(1));
    // 목록에 없는 키는 정리된다(Q-b)
    await waitFor(() => expect(JSON.parse(localStorage.getItem(DISMISSED_KEY)!)).toEqual([]));
  });

  it('「다시 띠에 보이기」로 닫은 공지를 되살린다', async () => {
    meNotices = [N(1, 'info')];
    const { result } = setup();
    await waitFor(() => expect(result.current.visible).toHaveLength(1));
    const n = result.current.visible[0];
    act(() => result.current.dismiss(n));
    expect(result.current.isDismissed(n)).toBe(true);
    act(() => result.current.restore(n));
    expect(result.current.visible).toHaveLength(1);
  });

  it('장애 공지는 닫은 기록이 있어도 늘 보인다(닫을 수 없음)', async () => {
    localStorage.setItem(DISMISSED_KEY, JSON.stringify(['5:r1']));
    noticeStore.reset();
    meNotices = [N(5, 'outage')];
    const { result } = setup();
    await waitFor(() => expect(result.current.visible.map((n) => n.id)).toEqual([5]));
  });

  it('저장소를 쓸 수 없어도 띠는 보이고 닫기는 이번 탭에서만 된다', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('denied');
    });
    noticeStore.reset();
    meNotices = [N(1, 'info')];
    const { result } = setup();
    await waitFor(() => expect(result.current.visible).toHaveLength(1));
    act(() => result.current.dismiss(result.current.visible[0]));
    expect(result.current.visible).toHaveLength(0);
  });
});

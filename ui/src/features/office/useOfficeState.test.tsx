/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useOfficeState } from '@/features/office/useOfficeState';
import { FakeES } from '@/test/fakeEventSource';
import { stubApi } from '@/test/mountScreen';

const agent = (alias: string, status = 'idle') => ({
  alias,
  pod: 'p1',
  profile: alias,
  status,
  title: '',
  role: '',
  team: '',
  avatar: '',
});

beforeEach(() => {
  FakeES.all = [];
  vi.stubGlobal('EventSource', FakeES);
});
afterEach(() => vi.unstubAllGlobals());

describe('useOfficeState', () => {
  it('snapshot 으로 시작하고 상태 이벤트를 반영한다', async () => {
    stubApi({ '/api/office/state': { agents: [agent('a')], seq: 1 } });
    const { result } = renderHook(() => useOfficeState());
    await waitFor(() => expect(result.current.state?.agents).toHaveLength(1));
    const es = FakeES.all[0];
    act(() => es.emit('snapshot', { agents: [agent('a'), agent('b')], seq: 5 }, '5'));
    expect(result.current.state?.agents.map((a) => a.alias)).toEqual(['a', 'b']);
    act(() => es.emit('chat.start', { alias: 'b' }, '6'));
    expect(result.current.state?.agents[1].status).toBe('working');
    expect(result.current.state?.seq).toBe(6);
    expect(result.current.live).toBe(true);
  });

  it('상태를 다시 받아도 방 이름표가 남는다 — snapshot 뒤에 /api/office/state 응답이 와도(OMAI-1121)', async () => {
    const rooms = [{ uid: 'kr_20', kind: 'team', label: 'QA팀 회의실', room: 3 }];
    stubApi({ '/api/office/state': { agents: [agent('a')], seq: 1, rooms } });
    const { result } = renderHook(() => useOfficeState());
    await waitFor(() => expect(result.current.state?.rooms).toEqual(rooms));
    act(() => FakeES.all[0].emit('snapshot', { agents: [agent('a')], seq: 2, rooms }, '2'));
    act(() => FakeES.all[0].emit('seat.added', { alias: 'z' }, '3'));     // 다시 받기
    await waitFor(() => expect(result.current.state?.rooms).toEqual(rooms));
  });

  it('응답에 rooms 가 없으면 받아 둔 이름표를 지우지 않는다', async () => {
    const rooms = [{ uid: 'kr_74', kind: 'tft', label: 'OKE 점검 회의', room: 1 }];
    stubApi({ '/api/office/state': { agents: [agent('a')], seq: 1 } });
    const { result } = renderHook(() => useOfficeState());
    await waitFor(() => expect(result.current.state).not.toBeNull());
    act(() => FakeES.all[0].emit('snapshot', { agents: [agent('a')], seq: 2, rooms }, '2'));
    act(() => FakeES.all[0].emit('seat.added', { alias: 'z' }, '3'));
    await new Promise((r) => setTimeout(r, 50));
    expect(result.current.state?.rooms).toEqual(rooms);
  });

  it('자리가 바뀌면 상태를 다시 받는다', async () => {
    const fn = stubApi({ '/api/office/state': { agents: [agent('a')], seq: 1 } });
    const { result } = renderHook(() => useOfficeState());
    await waitFor(() => expect(result.current.state).not.toBeNull());
    const before = fn.mock.calls.length;
    act(() => FakeES.all[0].emit('seat.added', { alias: 'z' }, '9'));
    await waitFor(() => expect(fn.mock.calls.length).toBe(before + 1));
  });

  it('자리·책상·배치 이벤트 뒤에만 onRefresh 를 부른다 — 관리자 화면이 /api/office 를 다시 읽는 데 쓴다(스펙 2026-10-26-001 회귀 계약 1)', async () => {
    stubApi({ '/api/office/state': { agents: [agent('a')], seq: 1 } });
    const onRefresh = vi.fn();
    const { result } = renderHook(() => useOfficeState(onRefresh));
    await waitFor(() => expect(result.current.state).not.toBeNull());
    act(() => FakeES.all[0].emit('tool', { alias: 'a', name: 'read' }, '2'));
    act(() => FakeES.all[0].emit('agent.status', { alias: 'a', status: 'working' }, '3'));
    expect(onRefresh).not.toHaveBeenCalled();
    act(() => FakeES.all[0].emit('seat.added', { alias: 'z' }, '4'));
    act(() => FakeES.all[0].emit('desks.changed', {}, '5'));
    act(() => FakeES.all[0].emit('layout.changed', { version: 2 }, '6'));
    expect(onRefresh).toHaveBeenCalledTimes(3);
  });

  it('스트림 오류에는 live 만 끄고 마지막 상태를 남긴다', async () => {
    stubApi({ '/api/office/state': { agents: [agent('a')], seq: 1 } });
    const { result } = renderHook(() => useOfficeState());
    await waitFor(() => expect(result.current.state).not.toBeNull());
    act(() => FakeES.all[0].emit('snapshot', { agents: [agent('a')], seq: 2 }, '2'));
    act(() => void FakeES.all[0].onerror?.());
    expect(result.current.live).toBe(false);
    expect(result.current.state?.agents).toHaveLength(1);
  });

  it('화면을 떠나면 스트림을 닫는다', async () => {
    stubApi({ '/api/office/state': { agents: [], seq: 0 } });
    const { unmount } = renderHook(() => useOfficeState());
    unmount();
    expect(FakeES.all[0].closed).toBe(true);
  });
});

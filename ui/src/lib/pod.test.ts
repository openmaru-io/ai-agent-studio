/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { chatStore } from './chatStore';
import { switchPod } from './pod';
import { wsClient } from './ws';

afterEach(() => vi.unstubAllGlobals());

describe('switchPod', () => {
  it('서버에 에이전트를 바꾸라고 보낸 뒤 채팅 목록을 다시 읽게 한다(2026-10-19-001 R1)', async () => {
    const fn = vi.fn(() => Promise.resolve(new Response('{"ok":true}', { status: 200 })));
    vi.stubGlobal('fetch', fn);
    chatStore.status = { configured: true, pod: 'a', agents: [{ name: 'main' }], sessions: [] };
    chatStore.profile = 'main';
    await switchPod('b');
    expect(fn).toHaveBeenCalledTimes(1);
    expect(String((fn.mock.calls[0] as unknown[])[0])).toBe('/api/pod');
    expect(chatStore.status).toBeNull(); // 다음 열기에서 묶음을 다시 읽는다(다른 에이전트의 대화는 닫지 않는다, R-LATE L1)
    expect(chatStore.groups).toEqual([]);
  });

  // 서버 파드가 둘이면 /api/pod 를 받은 파드와 웹소켓이 붙은 파드가 달라, 열린 연결이 옛 쿠키(옛 에이전트)로 읽었다(2026-10-19 OKE 시험)
  it('에이전트를 바꾸면 웹소켓을 다시 연결해 새 쿠키로 읽게 한다', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response('{"ok":true}', { status: 200 }))));
    const spy = vi.spyOn(wsClient, 'reconnect').mockImplementation(() => {});
    await switchPod('b');
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  it('서버가 거절하면 저장소를 그대로 두고 오류를 올린다', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response('{"error":"없는 에이전트"}', { status: 400 }))));
    chatStore.status = { configured: true, pod: 'a', agents: [{ name: 'main' }], sessions: [] };
    await expect(switchPod('x')).rejects.toThrow();
    expect(chatStore.status?.pod).toBe('a');
  });
});

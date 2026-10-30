/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 같은 토픽을 나중에 구독한 쪽과 거절된 토픽(스펙 2026-10-17-004 L2·L7)
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useTopic, WsClient } from './ws';

class FakeSocket {
  static all: FakeSocket[] = [];
  readyState = 0;
  sent: Record<string, unknown>[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: ((ev: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string) {
    FakeSocket.all.push(this);
  }
  send(text: string) {
    this.sent.push(JSON.parse(text));
  }
  close() {}
  msg(obj: Record<string, unknown>) {
    this.onmessage?.({ data: JSON.stringify({ v: 1, ...obj }) });
  }
  welcome() {
    this.readyState = 1;
    this.onopen?.();
    this.msg({ t: 'welcome', server: 1 });
  }
}

const sock = () => FakeSocket.all[FakeSocket.all.length - 1];

function make() {
  const client = new WsClient({
    WebSocketImpl: FakeSocket as unknown as typeof WebSocket,
    fetchImpl: vi.fn() as unknown as typeof fetch,
    url: () => 'ws://aas.test/ws',
    toLogin: vi.fn(),
  });
  client.configure(true);
  return client;
}

beforeEach(() => {
  FakeSocket.all = [];
});
afterEach(() => vi.restoreAllMocks());

describe('나중에 구독한 리스너', () => {
  it('앞 리스너가 받은 마지막 snap 을 곧바로 받는다', async () => {
    const client = make();
    const first = vi.fn();
    client.subscribe('office:inbox:a@x.com', first);
    sock().welcome();
    sock().msg({ t: 'snap', topic: 'office:inbox:a@x.com', seq: 1, data: { v: 'a1' } });
    const second = vi.fn();
    client.subscribe('office:inbox:a@x.com', second);
    await Promise.resolve();
    expect(second).toHaveBeenCalledWith({ v: 'a1' }, expect.objectContaining({ seq: 1 }));
    expect(sock().sent.filter((m) => m.t === 'sub')).toHaveLength(0); // 두 번째는 서버에 다시 구독하지 않는다(첫 구독은 hello.resume)
  });

  it('이벤트 토픽은 delta 가 온 뒤 스냅샷을 다시 넘기지 않는다', async () => {
    const client = make();
    client.subscribe('office:state', () => {});
    sock().welcome();
    sock().msg({ t: 'snap', topic: 'office:state', seq: 1, data: { type: 'snapshot' } });
    sock().msg({ t: 'delta', topic: 'office:state', seq: 2, data: { type: 'x' } });
    const late = vi.fn();
    client.subscribe('office:state', late);
    await Promise.resolve();
    expect(late).not.toHaveBeenCalled();
  });
});

describe('useTopic 이 거절을 받으면', () => {
  it('살아 있음을 끈다 — 화면이 HTTP 다시 읽기로 돌아간다', () => {
    const client = make();
    const { result } = renderHook(() => useTopic('office:cards', () => {}, client));
    act(() => {
      sock().welcome();
      sock().msg({ t: 'snap', topic: 'office:cards', seq: 1, data: { event: 1, cards: 1 } });
    });
    expect(result.current).toBe(true);
    act(() => sock().msg({ t: 'error', topic: 'office:cards', code: 'forbidden' }));
    expect(result.current).toBe(false);
  });
});

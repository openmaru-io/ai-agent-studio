/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 위젯 웹소켓(OMAI-1873): 주소에 aasu, 연결 직후 첫 메시지가 auth, 토큰을 다시 받으면 같은 연결에 다시 보낸다, HTTP 대체로 내리지 않는다
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { configureApi, resetApi } from '@/lib/api';
import { authMessage, WsClient,wsClient } from '@/lib/ws';

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
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  welcome() {
    this.open();
    this.onmessage?.({ data: JSON.stringify({ v: 1, t: 'welcome', server: 1 }) });
  }
  drop(code: number) {
    this.readyState = 3;
    this.onclose?.({ code });
  }
}

const last = () => FakeSocket.all[FakeSocket.all.length - 1];

beforeEach(() => {
  FakeSocket.all = [];
  vi.useFakeTimers();
  vi.spyOn(Math, 'random').mockReturnValue(0.5);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  resetApi();
});

function make(over: Partial<ConstructorParameters<typeof WsClient>[0]> = {}) {
  let token = 'emb-1';
  const fetchImpl = vi.fn(async () => ({ ok: true }) as Response);
  const client = new WsClient({
    WebSocketImpl: FakeSocket as unknown as typeof WebSocket,
    fetchImpl: fetchImpl as unknown as typeof fetch,
    url: () => 'wss://aas.test/ws?aasu=stk',
    toLogin: vi.fn(),
    auth: () => ({ token, pod: 'pod-a' }),
    ...over,
  });
  return { client, setToken: (t: string) => (token = t), fetchImpl };
}

describe('위젯 웹소켓 인증', () => {
  it('연결 직후 hello 보다 먼저 auth 를 보낸다(봉투 v·t 와 type 을 함께)', () => {
    const { client } = make();
    client.configure(true, 'pod-a');
    client.subscribe('pod:pod-a:chat:s1', () => {});
    last().open();
    expect(last().sent[0]).toEqual({ v: 1, t: 'auth', type: 'auth', token: 'emb-1', pod: 'pod-a' });
    expect(last().sent[1].t).toBe('hello');
  });

  it('토큰을 다시 받으면 같은 연결에 auth 를 다시 보낸다(연결을 끊지 않는다)', () => {
    const { client, setToken } = make();
    client.configure(true);
    client.subscribe('x', () => {});
    last().welcome();
    const n = FakeSocket.all.length;
    setToken('emb-2');
    expect(client.reauth()).toBe(true);
    expect(FakeSocket.all.length).toBe(n);
    expect(last().sent.at(-1)).toEqual({ v: 1, t: 'auth', type: 'auth', token: 'emb-2', pod: 'pod-a' });
  });

  it('auth 값이 없으면(쿠키 인증, AAS 화면) auth 를 보내지 않는다', () => {
    const { client } = make({ auth: undefined });
    client.configure(true);
    client.subscribe('x', () => {});
    last().open();
    expect(last().sent.map((m) => m.t)).toEqual(['hello']);
    expect(client.reauth()).toBe(false);
  });

  it('웹소켓 전용이면 welcome 전에 세 번 닫혀도 HTTP 대체로 내리지 않고 다시 시도한다', async () => {
    const { client } = make({ wsOnly: () => true });
    client.configure(true);
    client.subscribe('x', () => {});
    for (let i = 0; i < 3; i++) {
      last().drop(1006);
      await vi.advanceTimersByTimeAsync(40000);
    }
    expect(client.state).not.toBe('fallback-http');
    expect(client.usable).toBe(true);
  });

  it('닫힌 이유를 onClose 로 알린다(위젯이 원인을 가린다)', () => {
    const onClose = vi.fn();
    const { client } = make({ onClose });
    client.configure(true);
    client.subscribe('x', () => {});
    last().drop(1006);
    expect(onClose).toHaveBeenCalledWith(1006, '', false);
  });

  it('서버의 authed 답은 무시해도 오류가 없고, 그 뒤 welcome 으로 live 가 된다', () => {
    const { client } = make();
    client.configure(true);
    client.subscribe('pod:pod-a:chat:s1', () => {});
    last().open();
    last().onmessage?.({ data: JSON.stringify({ v: 1, t: 'authed', user: 'a@x', expires: 1, pod: 'pod-a' }) });
    expect(client.state).toBe('connecting');
    last().onmessage?.({ data: JSON.stringify({ v: 1, t: 'welcome', server: 1 }) });
    expect(client.state).toBe('live');
  });

  it('위젯은 대화 토픽만 구독하고 pub 을 보내지 않는다(서버가 agents·오피스 토픽을 거절한다)', async () => {
    const { client } = make({ topicAllowed: (t) => /^pod:.+:chat:/.test(t) });
    client.configure(true);
    const onError = vi.fn();
    client.subscribe('agents', () => {}, onError);
    expect(FakeSocket.all).toHaveLength(0); // 거절할 토픽으로는 연결도 열지 않는다
    await Promise.resolve();
    expect(onError).toHaveBeenCalledWith('forbidden');
    client.subscribe('pod:pod-a:chat:s1', () => {});
    last().welcome();
    client.subscribe('office:presence', () => {});
    expect(client.publish('office:presence', { x: 1 })).toBe(false);
    expect(last().sent.filter((m) => m.t === 'sub').map((m) => m.topic)).not.toContain('office:presence');
  });

  it('close 이유(reason)를 닫는 프레임에서도 읽는다(4401 user_changed 등)', () => {
    const onClose = vi.fn();
    const { client } = make({ onClose });
    client.configure(true);
    client.subscribe('x', () => {});
    last().welcome();
    last().readyState = 3;
    last().onclose?.({ code: 4401, reason: 'user_changed' } as unknown as { code: number });
    expect(onClose).toHaveBeenCalledWith(4401, 'user_changed', true);
  });

  it('공용 wsClient 는 configureApi 의 주소·쿼리·인증을 쓴다', () => {
    configureApi({ baseUrl: 'https://aas.example.com', extraQuery: () => ({ aasu: 'stk' }), wsAuth: () => ({ token: 't1' }) });
    const deps = (wsClient as unknown as { deps: { url: () => string; auth: () => unknown } }).deps;
    expect(deps.url()).toBe('wss://aas.example.com/ws?aasu=stk');
    expect(deps.auth()).toEqual({ token: 't1' });
    expect(authMessage({ token: 't1' })).toEqual({ v: 1, t: 'auth', type: 'auth', token: 't1' });
  });
});

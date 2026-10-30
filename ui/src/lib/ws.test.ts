/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { setLang } from '@/i18n';

import { topicSource, WsClient } from './ws';

class FakeSocket {
  static all: FakeSocket[] = [];
  readyState = 0;
  sent: Record<string, unknown>[] = [];
  closedWith: number | null = null;
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
  close(code: number) {
    this.closedWith = code;
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  msg(obj: Record<string, unknown>) {
    this.onmessage?.({ data: JSON.stringify({ v: 1, ...obj }) });
  }
  welcome(server = 1) {
    this.open();
    this.msg({ t: 'welcome', conn: 'c', server, hb: 20 });
  }
  drop(code: number, bye?: Record<string, unknown>) {
    if (bye) this.msg({ t: 'bye', code, ...bye });
    this.readyState = 3;
    this.onclose?.({ code });
  }
  types() {
    return this.sent.map((m) => m.t);
  }
}

const last = () => FakeSocket.all[FakeSocket.all.length - 1];

function make(fetchOk = true) {
  const toLogin = vi.fn();
  const fetchImpl = vi.fn(async () => ({ ok: fetchOk }) as Response);
  const client = new WsClient({
    WebSocketImpl: FakeSocket as unknown as typeof WebSocket,
    fetchImpl: fetchImpl as unknown as typeof fetch,
    url: () => 'ws://aas.test/ws',
    toLogin,
  });
  return { client, toLogin, fetchImpl };
}

beforeEach(() => {
  FakeSocket.all = [];
  vi.useFakeTimers();
  vi.spyOn(Math, 'random').mockReturnValue(0.5); // 지터 없이(±0)
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  setLang('ko');
});

describe('WsClient 연결 단계', () => {
  it('켜지고 구독이 생기면 연결하고, welcome 을 받아야 live 다', () => {
    const { client } = make();
    client.subscribe('agents', () => {});
    expect(FakeSocket.all).toHaveLength(0); // 아직 꺼져 있다
    client.configure(true);
    expect(client.state).toBe('connecting');
    last().open();
    expect(client.state).toBe('connecting'); // 열린 것만으로는 성공이 아니다
    expect(last().sent[0]).toMatchObject({ t: 'hello', resume: [{ topic: 'agents' }] });
    last().msg({ t: 'welcome', server: 1 });
    expect(client.state).toBe('live');
  });

  it('CONNECTING 에서 10초 넘게 멈추면 버리고 다시 시도한다', () => {
    const { client } = make();
    client.configure(true);
    client.subscribe('agents', () => {});
    const first = last();
    vi.advanceTimersByTime(10001);
    expect(first.closedWith).toBe(4000);
    vi.advanceTimersByTime(600);
    expect(FakeSocket.all.length).toBe(2);
  });

  it('StrictMode 처럼 같은 토픽을 두 번 구독해도 sub 는 한 번, 해지는 300ms 미룬다', () => {
    const { client } = make();
    client.configure(true);
    const un1 = client.subscribe('agents', () => {});
    last().welcome();
    const sock = last();
    un1();
    client.subscribe('agents', () => {}); // 바로 다시 마운트
    vi.advanceTimersByTime(400);
    expect(sock.types().filter((t) => t === 'unsub')).toHaveLength(0);
    client.subscribe('pod:a:health', () => {});
    expect(sock.sent.filter((m) => m.t === 'sub')).toEqual([{ v: 1, t: 'sub', topic: 'pod:a:health' }]);
  });
});

describe('WsClient 재연결', () => {
  it('백오프가 0.5초부터 두 배로 늘고, 5번이 넘으면 느린 재시도로 표시한다', () => {
    const { client } = make();
    client.configure(true);
    client.subscribe('agents', () => {});
    last().welcome();
    const delays = [500, 1000, 2000, 4000, 8000];
    for (const d of delays) {
      last().drop(1006);
      const before = FakeSocket.all.length;
      vi.advanceTimersByTime(d - 1);
      expect(FakeSocket.all.length).toBe(before);
      vi.advanceTimersByTime(1);
      expect(FakeSocket.all.length).toBe(before + 1);
      last().welcome(); // 붙었다가 또 끊긴다
      expect(client.state).toBe('live');
    }
    last().drop(1006);
    expect(['retrying-fast', 'retrying-slow']).toContain(client.state);
  });

  it('4401 이면 재연결을 멈추고 로그인으로 보낸다', () => {
    const { client, toLogin } = make();
    client.configure(true);
    client.subscribe('agents', () => {});
    last().welcome();
    last().drop(4401, { reason: 'session_ended' });
    expect(client.state).toBe('auth-failed');
    expect(toLogin).toHaveBeenCalled();
    vi.advanceTimersByTime(60000);
    expect(FakeSocket.all).toHaveLength(1);
  });

  it('4409 로 대체되면 자동으로 붙지 않고, 이 창에서 계속을 누르면 다시 붙는다', () => {
    const { client } = make();
    client.configure(true);
    client.subscribe('agents', () => {});
    last().welcome();
    last().drop(4409, { reason: 'replaced' });
    expect(client.state).toBe('replaced');
    vi.advanceTimersByTime(10 * 60000);
    expect(FakeSocket.all).toHaveLength(1);
    client.continueHere();
    expect(FakeSocket.all).toHaveLength(2);
    last().welcome();
    expect(client.state).toBe('live');
  });

  it('1012 는 서버가 알려 준 시간만큼 기다렸다 붙는다', () => {
    const { client } = make();
    client.configure(true);
    client.subscribe('agents', () => {});
    last().welcome();
    last().drop(1012, { retry_after_ms: 7000 });
    vi.advanceTimersByTime(6999);
    expect(FakeSocket.all).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(FakeSocket.all).toHaveLength(2);
  });

  it('welcome 전에 3번 닫히고 HTTP 는 되면 HTTP 대체로 내리고 5분 뒤 다시 시도한다', async () => {
    const { client, fetchImpl } = make(true);
    client.configure(true);
    client.subscribe('agents', () => {});
    for (let i = 0; i < 3; i++) {
      last().drop(1006);
      await vi.advanceTimersByTimeAsync(2100);
    }
    expect(fetchImpl).toHaveBeenCalledWith('/healthz', { cache: 'no-store' });
    expect(client.state).toBe('fallback-http');
    const n = FakeSocket.all.length;
    await vi.advanceTimersByTimeAsync(5 * 60000);
    expect(FakeSocket.all.length).toBe(n + 1);
  });

  it('배포 중처럼 HTTP 확인도 실패하면 HTTP 대체로 내리지 않고 계속 다시 시도한다', async () => {
    const { client } = make(false);
    client.configure(true);
    client.subscribe('agents', () => {});
    for (let i = 0; i < 3; i++) {
      last().drop(1006);
      await vi.advanceTimersByTimeAsync(2100);
    }
    expect(client.state).not.toBe('fallback-http');
    expect(['retrying-fast', 'retrying-slow']).toContain(client.state);
  });

  it('45초 동안 아무것도 못 받으면 연결을 버린다(반쯤 열린 연결)', () => {
    const { client } = make();
    client.configure(true);
    client.subscribe('agents', () => {});
    const sock = last();
    sock.welcome();
    vi.advanceTimersByTime(40000);
    expect(sock.closedWith).toBeNull();
    vi.advanceTimersByTime(10000);
    expect(sock.closedWith).toBe(4000);
  });

  it('25초마다 ping 을 보낸다', () => {
    const { client } = make();
    client.configure(true);
    client.subscribe('agents', () => {});
    const sock = last();
    sock.welcome();
    sock.msg({ t: 'hb' });
    vi.advanceTimersByTime(30000);
    expect(sock.types()).toContain('ping');
  });

  it('다시 붙으면 토픽마다 마지막 seq 를 hello.resume 에 싣고, 서버가 바뀌었으면 비운다', () => {
    const { client } = make();
    client.configure(true);
    client.subscribe('agents', () => {});
    last().welcome(1);
    last().msg({ t: 'snap', topic: 'agents', seq: 7, data: {} });
    last().drop(1006);
    vi.advanceTimersByTime(600);
    last().open();
    expect(last().sent[0]).toMatchObject({ t: 'hello', resume: [{ topic: 'agents', after: 7 }] });
    last().msg({ t: 'welcome', server: 2 }); // 서버가 재시작됐다
    last().drop(1006);
    vi.advanceTimersByTime(1100);
    last().open();
    expect((last().sent[0] as { resume: object[] }).resume).toEqual([{ topic: 'agents' }]); // seq 를 싣지 않는다 — 스냅샷부터
  });

  it('언어를 바꾸면 연결을 새로 열어 hello 에 새 언어를 싣고, 옛 언어의 seq 는 버린다(스펙 2026-10-21-007)', () => {
    const { client } = make();
    client.configure(true);
    client.subscribe('agents', () => {});
    const first = last();
    first.welcome(1);
    first.msg({ t: 'snap', topic: 'agents', seq: 7, data: {} });
    setLang('en');
    client.changeLang();
    expect(first.closedWith).toBe(1000);
    expect(last()).not.toBe(first);
    last().open();
    expect(last().sent[0]).toMatchObject({ t: 'hello', lang: 'en' });
    expect((last().sent[0] as { resume: object[] }).resume).toEqual([{ topic: 'agents' }]); // 새 언어의 스냅샷부터
  });
});

describe('WsClient 메시지', () => {
  it('옛 소켓에서 늦게 온 메시지는 버린다', () => {
    const { client } = make();
    client.configure(true);
    const got: unknown[] = [];
    client.subscribe('agents', (d) => got.push(d));
    const old = last();
    old.welcome();
    old.drop(1006);
    vi.advanceTimersByTime(600);
    last().welcome();
    old.msg({ t: 'snap', topic: 'agents', seq: 9, data: { late: true } });
    expect(got).toEqual([]);
  });

  it('delta 가 건너뛰면 다시 구독하고, 같거나 작은 seq 는 버린다', () => {
    const { client } = make();
    client.configure(true);
    const got: unknown[] = [];
    client.subscribe('office:state', (d) => got.push(d));
    const sock = last();
    sock.welcome();
    sock.msg({ t: 'snap', topic: 'office:state', seq: 1, data: 's' });
    sock.msg({ t: 'delta', topic: 'office:state', seq: 2, data: 'd2' });
    sock.msg({ t: 'delta', topic: 'office:state', seq: 2, data: 'dup' });
    sock.msg({ t: 'delta', topic: 'office:state', seq: 5, data: 'gap' });
    expect(got).toEqual(['s', 'd2']);
    expect(sock.sent.slice(-2)).toEqual([
      { v: 1, t: 'unsub', topic: 'office:state' },
      { v: 1, t: 'sub', topic: 'office:state' },
    ]);
  });

  it('끊기면 진행 중인 요청을 다시 시도 가능 오류로 끝낸다', async () => {
    const { client } = make();
    client.configure(true);
    client.subscribe('agents', () => {});
    last().welcome();
    const p = client.request('file', { path: 'x' });
    last().drop(1006);
    await expect(p).rejects.toThrow('ws_retryable');
  });

  it('끄면 소켓을 닫고 off 가 된다', () => {
    const { client } = make();
    client.configure(true);
    client.subscribe('agents', () => {});
    const sock = last();
    sock.welcome();
    client.configure(false);
    expect(sock.closedWith).toBe(1000);
    expect(client.state).toBe('off');
  });
});

describe('이벤트 토픽(W2)', () => {
  it('skip 은 번호만 넘기고, 첫 delta 는 seq 와 상관없이 받는다', () => {
    const { client } = make();
    client.configure(true);
    const got: unknown[] = [];
    client.subscribe('pod:a:chat:s1', (d) => got.push(d));
    const sock = last();
    sock.welcome();
    sock.msg({ t: 'delta', topic: 'pod:a:chat:s1', seq: 40, data: 'a' }); // 남은 이벤트를 중간부터 다시 보낸다
    sock.msg({ t: 'delta', topic: 'pod:a:chat:s1', seq: 41, skip: true });
    sock.msg({ t: 'delta', topic: 'pod:a:chat:s1', seq: 42, data: 'b' });
    expect(got).toEqual(['a', 'b']);
    expect(sock.types().filter((t) => t === 'unsub')).toHaveLength(0);
  });

  it('topicSource 는 EventSource 처럼 열림·메시지·오류를 넘긴다', async () => {
    const { client } = make();
    client.configure(true, 'a');
    const src = topicSource('office:state', client);
    const seen: { data: string; lastEventId: string }[] = [];
    const opened = vi.fn();
    const errored = vi.fn();
    src.onopen = opened;
    src.onmessage = (m) => seen.push(m);
    src.onerror = errored;
    const sock = last();
    sock.welcome();
    expect(opened).toHaveBeenCalledTimes(1);
    sock.msg({ t: 'snap', topic: 'office:state', seq: 3, data: { type: 'snapshot', payload: { seq: 3 } } });
    expect(seen).toEqual([{ data: JSON.stringify({ type: 'snapshot', payload: { seq: 3 } }), lastEventId: '3' }]);
    sock.msg({ t: 'error', topic: 'office:state', code: 'topic_ended' });
    expect(errored).toHaveBeenCalledTimes(1);
    sock.drop(1006);
    expect(errored).toHaveBeenCalledTimes(2); // live 에서 벗어남
    src.close();
    vi.advanceTimersByTime(400);
    expect(client.pod).toBe('a');
  });

  it('HTTP 대체로 내려가면 usable 이 거짓이 되어 화면이 EventSource 로 돌아간다', async () => {
    const { client } = make(true);
    client.configure(true);
    expect(client.usable).toBe(true);
    client.subscribe('agents', () => {});
    for (let i = 0; i < 3; i++) {
      last().drop(1006);
      await vi.advanceTimersByTimeAsync(2100);
    }
    expect(client.usable).toBe(false);
  });
});

describe('WsClient publish', () => {
  it('live 일 때만 pub 을 보낸다(계획 007 P6b)', () => {
    const { client } = make();
    client.subscribe('office:presence', () => {});
    expect(client.publish('office:presence', { x: 1 })).toBe(false);
    client.configure(true);
    last().welcome();
    expect(client.publish('office:presence', { x: 1, y: 2, f: 0, sit: '' })).toBe(true);
    expect(last().sent.at(-1)).toEqual({ v: 1, t: 'pub', topic: 'office:presence', data: { x: 1, y: 2, f: 0, sit: '' } });
  });
});

// 스펙 2026-10-20-030: 화면 단계(채팅 다시 열기·연결 대기)가 기대는 값
describe('WsClient 다시 열기에 쓰는 값', () => {
  it('거절된 토픽을 다시 구독하면 sub 를 다시 보낸다(대화를 다시 연 뒤 같은 이름의 토픽)', () => {
    const { client } = make();
    client.configure(true);
    const errs: string[] = [];
    const off = client.subscribe('pod:p1:chat:s1', () => {}, (c) => errs.push(c));
    last().welcome();
    last().msg({ t: 'error', topic: 'pod:p1:chat:s1', code: 'forbidden' });
    expect(errs).toEqual(['forbidden']);
    off();
    const before = last().sent.filter((m) => m.t === 'sub').length;
    client.subscribe('pod:p1:chat:s1', () => {}); // 300ms 안이라 같은 리스너 묶음이다
    expect(last().sent.filter((m) => m.t === 'sub').length).toBe(before + 1);
  });

  it('epoch 는 welcome 의 서버 번호다', () => {
    const { client } = make();
    client.configure(true);
    client.subscribe('agents', () => {});
    last().welcome(7);
    expect(client.epoch).toBe(7);
  });

  it('live 를 떠난 지 2초가 지나야 연결 대기다. 첫 접속과 pagehide 는 세지 않는다', () => {
    const { client } = make();
    client.configure(true);
    client.subscribe('agents', () => {});
    vi.advanceTimersByTime(3000);
    expect(client.connWaiting()).toBe(false); // 한 번도 live 가 아니었다
    last().welcome();
    last().drop(1006);
    expect(client.connWaiting()).toBe(false);
    vi.advanceTimersByTime(1999);
    expect(client.connWaiting()).toBe(false);
    vi.advanceTimersByTime(1);
    expect(client.connWaiting()).toBe(true);
    expect(client.connWaitAt()).toBeGreaterThan(0);
  });

  it('HTTP 대체·대체됨에서는 연결 대기가 아니다(화면은 SSE·HTTP 로 잇는다)', () => {
    const { client } = make();
    client.configure(true);
    client.subscribe('agents', () => {});
    last().welcome();
    last().drop(4409);
    vi.advanceTimersByTime(5000);
    expect(client.state).toBe('replaced');
    expect(client.connWaiting()).toBe(false);
  });
});

/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 웹소켓 토픽으로 대화를 받다가 연결이 끊긴 경우(스펙 2026-10-20-030 4-3·4-4, 외부 검토 H1·H3·H4).
// 웹소켓만 끊긴 것은 WsClient 가 구독을 잇는다 — 대화 단계는 사건(구독 거절·서버 번호 바뀜·토픽을 못 쓰는 상태)에만 다시 연다.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ws = vi.hoisted(() => {
  type Sub = { topic: string; fn: (data: unknown, meta: { seq: number }) => void; onError?: (code: string) => void; off: boolean };
  const subs: Sub[] = [];
  const listeners = new Set<() => void>();
  const client = {
    usable: true,
    pod: 'p1',
    state: 'live' as string,
    epoch: 1,
    waiting: false,
    subscribe(topic: string, fn: Sub['fn'], onError?: Sub['onError']) {
      const r: Sub = { topic, fn, onError, off: false };
      subs.push(r);
      return () => {
        r.off = true;
      };
    },
    onState(fn: () => void) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    connWaiting() {
      return client.waiting;
    },
    connWaitAt() {
      return 0;
    },
    set(state: string, epoch?: number) {
      client.state = state;
      if (epoch) client.epoch = epoch;
      client.usable = state !== 'fallback-http';
      listeners.forEach((f) => f());
    },
  };
  return { client, subs, listeners };
});

vi.mock('./ws', () => ({ wsClient: ws.client }));

import { ChatStore } from './chatStore';

class FakeES {
  static all: FakeES[] = [];
  onmessage: ((m: { data: string; lastEventId?: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  constructor(public url: string) {
    FakeES.all.push(this);
  }
  close() {
    this.closed = true;
  }
}

function api(resume: (n: number) => Record<string, unknown> | Response = () => ({ session_id: 's-new', profile: 'ma', reused: false, history: true })) {
  let n = 0;
  const calls: string[] = [];
  const fn = vi.fn((url: string) => {
    calls.push(url);
    if (url.startsWith('/api/chat/resume')) {
      const out = resume(++n);
      return Promise.resolve(out instanceof Response ? out : new Response(JSON.stringify(out), { status: 200 }));
    }
    const body: Record<string, unknown> = url.startsWith('/api/chat/status')
      ? { configured: true, agents: [{ name: 'ma' }], sessions: [] }
      : url.startsWith('/api/chat/history')
      ? { sessions: [] }
      : url.startsWith('/api/chat/session')
      ? { session_id: 's-new', profile: 'ma', title: '' }
      : { ok: true };
    return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
  });
  vi.stubGlobal('fetch', fn);
  return { calls, resumes: () => calls.filter((u) => u.startsWith('/api/chat/resume')).length };
}

const live = () => ws.subs.filter((x) => !x.off);
const emit = (seq: number, type: string, payload: Record<string, unknown> = {}) => live().at(-1)!.fn({ type, payload }, { seq });

async function opened() {
  const s = new ChatStore();
  await s.ask('ma', '고쳐 줘');
  emit(1, 'session.title', { session_id: 'st-1' });
  emit(2, 'aas.user', { text: '고쳐 줘' });
  emit(3, 'message.delta', { text: '계획' });
  return s;
}

beforeEach(() => {
  ws.subs.length = 0;
  ws.listeners.clear();
  ws.client.state = 'live';
  ws.client.usable = true;
  ws.client.epoch = 1;
  ws.client.waiting = false;
  FakeES.all = [];
  vi.stubGlobal('EventSource', FakeES);
});
afterEach(() => vi.unstubAllGlobals());

describe('대화 받기: 웹소켓 토픽', () => {
  it('웹소켓만 끊겼다 같은 서버에 다시 붙으면 대화 단계는 아무 요청도 하지 않는다(H4)', async () => {
    const a = api();
    const s = await opened();
    const before = a.calls.length;
    ws.client.set('retrying-fast');
    ws.client.set('live', 1);
    expect(a.calls.length).toBe(before);
    expect(s.current()!.closed).toBeFalsy();
    expect(FakeES.all).toHaveLength(0); // SSE 로 굳지 않는다
  });

  it('토픽 구독이 거절되면 끊긴 그 대화를 resume 하고 같은 토픽을 다시 구독해 목록에 합친다', async () => {
    const a = api();
    const s = await opened();
    live()[0].onError?.('forbidden');
    await vi.waitFor(() => expect(a.resumes()).toBe(1));
    await vi.waitFor(() => expect(live()).toHaveLength(1));
    expect(live()[0].topic).toBe('pod:p1:chat:s-new');
    expect(ws.subs[0].off).toBe(true);
    emit(1, 'aas.history', { messages: [{ role: 'user', text: '고쳐 줘' }, { role: 'assistant', text: '다 고쳤습니다' }] });
    expect(s.current()!.items.map((i) => [i.kind, i.text])).toEqual([['user', '고쳐 줘'], ['assistant', '다 고쳤습니다']]);
  });

  it('서버 번호가 바뀌면 resume 한다. 다른 탭처럼 옛 번호 뒤부터 받지 않고 처음부터 받는다(H1)', async () => {
    const a = api();
    const s = await opened();
    ws.client.set('retrying-fast');
    ws.client.set('live', 2);
    await vi.waitFor(() => expect(a.resumes()).toBe(1));
    await vi.waitFor(() => expect(s.current()!.closed).toBe(false));
    expect(s.current()!.lastSeq).toBe(0);
    expect(s.current()!.epoch).toBe(2);
  });

  it('다시 붙기를 기다리는 동안은 시도로 세지 않고, live 가 되면 바로 resume 한다', async () => {
    const a = api();
    const s = await opened();
    ws.client.state = 'retrying-slow';
    live()[0].onError?.('forbidden');
    await Promise.resolve();
    expect(s.reconnectView(s.current())).toEqual({ mode: 'wait', nextAt: 0 });
    expect(a.resumes()).toBe(0);
    ws.client.set('live', 2);
    await vi.waitFor(() => expect(a.resumes()).toBe(1));
  });

  it('4409 로 대체되면 사건으로 보고 SSE 로 다시 연다 — 연결 대기에 갇히지 않는다(H3)', async () => {
    const a = api(() => ({ session_id: 's-new', profile: 'ma', reused: true, history: false }));
    const s = await opened();
    ws.client.set('replaced');
    await vi.waitFor(() => expect(FakeES.all).toHaveLength(1));
    expect(a.calls).toContain('/healthz');
    expect(FakeES.all[0].url).toBe('/api/chat/events?session_id=s-new&after=3');
    expect(s.blocked(s.current())).toBe(false);
  });

  it('연결을 기다리는 동안에는 보내지 않는다(DR1·DR5)', async () => {
    const a = api();
    const s = await opened();
    ws.client.waiting = true;
    expect(s.reconnectView(s.current())).toEqual({ mode: 'wait', nextAt: 0 });
    expect(await s.send('지금 보내기')).toBe('reconnecting');
    expect(a.calls.filter((u) => u.startsWith('/api/chat/send'))).toHaveLength(0); // ask 는 입력칸만 채운다 — 보낸 것이 없다
  });
});

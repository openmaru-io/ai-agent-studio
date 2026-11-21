/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 한 탭이 토픽으로 받는 대화 수(OMAI-1863). 열었던 대화를 모두 구독한 채 두어 한 탭에서 100개를 넘게 열면 서버 구독 상한
// (연결당 100개)에 걸렸고, 화면은 거절을 「대화가 없어짐」으로 보고 다시 열기를 1초마다 끝없이 되풀이했다(OKE 2026-11-08).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ws = vi.hoisted(() => {
  type Sub = { topic: string; fn: (data: unknown, meta: { seq: number }) => void; onError?: (code: string) => void; after?: number; off: boolean };
  const subs: Sub[] = [];
  const client = {
    usable: true,
    pod: 'p1',
    state: 'live' as string,
    epoch: 1,
    subscribe(topic: string, fn: Sub['fn'], onError?: Sub['onError'], after?: number) {
      const r: Sub = { topic, fn, onError, after, off: false };
      subs.push(r);
      return () => {
        r.off = true;
      };
    },
    onState() {
      return () => {};
    },
    connWaiting() {
      return false;
    },
    connWaitAt() {
      return 0;
    },
  };
  return { client, subs };
});

vi.mock('./ws', () => ({ wsClient: ws.client }));

import { ChatStore } from './chatStore';

function api() {
  let n = 0;
  const calls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string) => {
      calls.push(url);
      const body: Record<string, unknown> = url.startsWith('/api/chat/status')
        ? { configured: true, agents: [{ name: 'ma' }], sessions: [] }
        : url.startsWith('/api/chat/history')
        ? { sessions: [] }
        : url.startsWith('/api/chat/session')
        ? { session_id: `s-${++n}`, profile: 'ma', title: '' }
        : { ok: true };
      return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
    })
  );
  return { resumes: () => calls.filter((u) => u.startsWith('/api/chat/resume')).length };
}

const topicOf = (id: string) => `pod:p1:chat:${id}`;
const liveSubs = () => ws.subs.filter((x) => !x.off);
const subOf = (id: string) => liveSubs().filter((x) => x.topic === topicOf(id)).at(-1);
type Inner = { sessions: Record<string, { id: string; parked?: boolean; lastSeq?: number; items: { kind: string; text?: string }[] }>; lastAt: Record<string, number> };
const inner = (s: ChatStore) => s as unknown as Inner;

/** 대화 n 개를 차례로 연다. 각 대화에 이벤트를 하나씩 보내고, 연 순서대로 마지막 활동 시각을 둔다 */
async function openMany(n: number) {
  const s = new ChatStore();
  for (let i = 1; i <= n; i++) {
    await s.ask('ma', `질문 ${i}`);
    subOf(`s-${i}`)!.fn({ type: 'session.title', payload: { session_id: `st-${i}` } }, { seq: 1 });
    inner(s).lastAt[`s-${i}`] = i;
  }
  return s;
}

beforeEach(() => {
  ws.subs.length = 0;
  ws.client.state = 'live';
  ws.client.usable = true;
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('토픽으로 받는 대화 수 상한(OMAI-1863)', () => {
  it('40개를 넘으면 보지 않는 대기 대화부터(오래 쉰 순서) 구독을 해제하고, 지금 보는 대화는 그대로 받는다', async () => {
    api();
    const s = await openMany(45);
    const chatSubs = liveSubs().filter((x) => x.topic.includes(':chat:'));
    expect(chatSubs).toHaveLength(40);
    for (let i = 1; i <= 5; i++) {
      expect(subOf(`s-${i}`)).toBeUndefined();
      expect(inner(s).sessions[`s-${i}`]!.parked).toBe(true);
    }
    expect(subOf('s-45')).toBeDefined(); // 지금 보는 대화
    expect(inner(s).sessions['s-6']!.parked).toBeFalsy();
  });

  it('구독을 해제했던 대화를 다시 열면 받던 번호 다음부터 받고, 그 이하로 다시 온 이벤트는 그리지 않는다', async () => {
    api();
    const s = await openMany(45);
    await s.focus('s-1');
    const sub = subOf('s-1')!;
    expect(sub.after).toBe(1);
    expect(inner(s).sessions['s-1']!.parked).toBe(false);
    const before = inner(s).sessions['s-1']!.items.length;
    sub.fn({ type: 'aas.user', payload: { text: '옛 질문' } }, { seq: 1 }); // 서버가 받던 번호를 잃고(gap) 처음부터 다시 보냈다
    expect(inner(s).sessions['s-1']!.items.length).toBe(before);
    sub.fn({ type: 'aas.user', payload: { text: '새 질문' } }, { seq: 2 });
    expect(inner(s).sessions['s-1']!.items.some((x) => x.kind === 'user' && x.text === '새 질문')).toBe(true);
  });

  it('구독 상한으로 거절되면 다시 열지 않는다 — 대기 대화를 모두 멈추고 한 번만 다시 구독한다', async () => {
    const a = api();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const s = await openMany(5);
    subOf('s-5')!.onError!('too_many_subs');
    expect(a.resumes()).toBe(0);
    for (let i = 1; i <= 4; i++) expect(subOf(`s-${i}`)).toBeUndefined();
    const n = ws.subs.length;
    vi.advanceTimersByTime(1000);
    expect(ws.subs.length).toBe(n + 1); // 지금 대화를 한 번 다시 구독
    expect(subOf('s-5')).toBeDefined();
    expect(s.current()!.closed).toBeFalsy();
  });

  it('다시 구독해도 또 상한으로 거절되면 「다시 여는 중」을 되풀이하지 않고 멈춘다', async () => {
    const a = api();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const s = await openMany(3);
    subOf('s-3')!.onError!('too_many_subs');
    vi.advanceTimersByTime(1000);
    subOf('s-3')!.onError!('too_many_subs');
    vi.advanceTimersByTime(60_000);
    expect(a.resumes()).toBe(0);
    expect(subOf('s-3')).toBeUndefined();
    expect(s.current()!.reconnect).toBeUndefined();
  });

  it('상한이 아닌 거절(새 서버에 대화가 없음)은 지금처럼 다시 연다', async () => {
    const a = api();
    await openMany(2);
    subOf('s-2')!.onError!('not_found');
    await vi.waitFor(() => expect(a.resumes()).toBeGreaterThan(0));
  });
});

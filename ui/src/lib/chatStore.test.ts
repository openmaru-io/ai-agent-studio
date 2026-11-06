/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ChatStore, cleanTitle, groupLabel, PRIMARY, rowTitle, singleProfile, targetTitle } from './chatStore';

class FakeES {
  static all: FakeES[] = [];
  onmessage: ((m: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  constructor(public url: string) {
    FakeES.all.push(this);
  }
  close() {
    this.closed = true;
  }
  seq = 0;
  emit(type: string, payload: Record<string, unknown> = {}) {
    this.onmessage?.({ data: JSON.stringify({ type, payload }), lastEventId: String(++this.seq) } as { data: string });
  }
}

const STATUS = {
  configured: true,
  agents: [{ name: 'ma', title: '마' }, { name: 'ops' }],
  sessions: [],
};

function api(over: Record<string, unknown | ((body: Record<string, unknown>) => unknown)> = {}) {
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  const fn = vi.fn((url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    calls.push({ url, body });
    const key = Object.keys({
      '/api/chat/status': 1,
      '/api/chat/history': 1,
      '/api/chat/resume': 1,
      '/api/chat/sessions': 1,
      '/api/chat/session': 1,
      '/api/chat/send': 1,
      '/api/chat/interrupt': 1,
      '/api/chat/approval': 1,
      '/api/chat/clarify': 1,
    }).find((k) => url.startsWith(k));
    const base: Record<string, unknown> = {
      '/api/chat/status': STATUS,
      '/api/chat/history': { sessions: [] },
      '/api/chat/sessions': { sessions: [] },
      '/api/chat/session': { session_id: 's-new', profile: body.profile, title: '' },
      '/api/chat/resume': { session_id: 's-old', profile: body.profile, title: '지난' },
      '/api/chat/send': { ok: true },
      '/api/chat/interrupt': { ok: true },
      '/api/chat/approval': { ok: true },
      '/api/chat/clarify': { ok: true },
      ...over,
    };
    const v = key ? base[key] : undefined;
    const out = typeof v === 'function' ? (v as (b: Record<string, unknown>) => unknown)(body) : v;
    if (out instanceof Response) return Promise.resolve(out);
    if (out instanceof Error)
      return Promise.resolve(new Response(JSON.stringify({ error: out.message }), { status: 400 }));
    return Promise.resolve(new Response(JSON.stringify(out ?? {}), { status: 200 }));
  });
  vi.stubGlobal('fetch', fn);
  return {
    fn,
    calls,
    posted: (path: string) =>
      calls.filter((c) => c.url.startsWith(path) && Object.keys(c.body).length).map((c) => c.body),
  };
}

beforeEach(() => {
  FakeES.all = [];
  vi.stubGlobal('EventSource', FakeES);
});
afterEach(() => vi.unstubAllGlobals());

describe('ChatStore', () => {
  it('상태를 받아 에이전트 목록을 채운다. 설정이 없으면 안내용 상태를 둔다', async () => {
    api();
    const s = new ChatStore();
    await s.preload();
    expect(s.status?.agents.map((a) => a.name)).toEqual(['ma', 'ops']);
    api({ '/api/chat/status': new Error('로그인 정보 없음') });
    const t = new ChatStore();
    await t.preload();
    expect(t.status).toMatchObject({ configured: false, error: '로그인 정보 없음', agents: [] });
  });

  it('에이전트를 열면 지난 AAS 대화를 이어 붙인다(resume)', async () => {
    const a = api({
      '/api/chat/history': {
        sessions: [
          { id: 'old1', source: 'cron' },
          { id: 'old2', source: 'aas' },
        ],
      },
    });
    const s = new ChatStore();
    await s.openAgent('ma');
    expect(a.posted('/api/chat/resume')).toEqual([{ profile: 'ma', stored_id: 'old2' }]);
    expect(s.current()?.id).toBe('s-old');
    expect(FakeES.all[0].url).toBe('/api/chat/events?session_id=s-old');
  });

  it('지난 AAS 대화가 없으면 대화 없이 비워 둔다', async () => {
    const a = api();
    const s = new ChatStore();
    await s.openAgent('ma');
    expect(s.profile).toBe('ma');
    expect(s.current()).toBeNull();
    expect(a.posted('/api/chat/resume')).toEqual([]);
  });

  it('보내기: 대화가 없으면 새로 시작하고 글을 보낸다', async () => {
    const a = api();
    const s = new ChatStore();
    await s.openAgent('ma');
    await s.send('안녕');
    expect(a.posted('/api/chat/session')).toEqual([{ profile: 'ma' }]);
    expect(a.posted('/api/chat/send')).toEqual([{ session_id: 's-new', text: '안녕' }]);
  });

  it('답하는 중에는 보내지 못한다. 빈 글도 보내지 않는다', async () => {
    const a = api();
    const s = new ChatStore();
    await s.openAgent('ma');
    await s.send('첫');
    FakeES.all[0].emit('aas.user', { text: '첫' });
    expect(s.current()?.busy).toBe(true);
    expect(await s.send('둘')).toBe('busy');
    expect(await s.send('   ')).toBe('empty');
    expect(a.posted('/api/chat/send')).toHaveLength(1);
  });

  it('보내기가 실패하면 다시 보내기 글이 달린 오류 줄을 남기고 busy 를 푼다', async () => {
    api({ '/api/chat/send': new Error('연결 거부') });
    const s = new ChatStore();
    await s.openAgent('ma');
    await s.send('안녕');
    const last = s.current()!.items.at(-1)!;
    expect(last).toMatchObject({ kind: 'error', retry: '안녕' });
    expect(last.text).toContain('보내지 못했습니다: 연결 거부');
    expect(s.current()!.busy).toBe(false);
  });

  it('이벤트가 들어오면 현재 대화를 갱신하고 구독자에게 알린다', async () => {
    api();
    const s = new ChatStore();
    const seen = vi.fn();
    s.subscribe(seen);
    await s.openAgent('ma');
    await s.send('안녕');
    seen.mockClear();
    FakeES.all[0].emit('message.delta', { text: '반' });
    FakeES.all[0].emit('message.delta', { text: '가워' });
    expect(s.current()!.items.at(-1)).toMatchObject({ kind: 'assistant', text: '반가워' });
    expect(seen).toHaveBeenCalled();
  });

  it('다른 에이전트의 대화에서 온 완료·요청 이벤트는 안 읽은 수로 센다. 승인 대기 수도 센다', async () => {
    api();
    const s = new ChatStore();
    await s.openAgent('ma');
    await s.send('a');
    await s.openAgent('ops');
    const es = FakeES.all[0];
    es.emit('message.complete', { text: '완료' });
    es.emit('approval.request', { request_id: 'r' });
    expect(s.sessionOf('ma')!.unread).toBe(2);
    expect(s.waiting()).toBe(1);
    await s.openAgent('ma');
    expect(s.sessionOf('ma')!.unread).toBe(0);
  });

  it('새 대화는 지금 대화를 놓고 새 세션을 연다', async () => {
    const a = api();
    const s = new ChatStore();
    await s.openAgent('ma');
    await s.send('a');
    await s.newChat();
    expect(a.posted('/api/chat/session')).toHaveLength(2);
  });

  it('중단·승인·되묻기 답은 현재 세션 id 와 함께 보낸다', async () => {
    const a = api();
    const s = new ChatStore();
    await s.openAgent('ma');
    await s.send('a');
    await s.interrupt();
    await s.approve('once', 'r1');
    await s.clarify('rq', 'qid', '답');
    expect(a.posted('/api/chat/interrupt')).toEqual([{ session_id: 's-new' }]);
    expect(a.posted('/api/chat/approval')).toEqual([{ session_id: 's-new', choice: 'once', request_id: 'r1' }]);
    expect(a.posted('/api/chat/clarify')).toEqual([
      { session_id: 's-new', request_id: 'rq', question_id: 'qid', answer: '답' },
    ]);
  });

  it('지난 대화를 골라 이어 쓴다', async () => {
    const a = api();
    const s = new ChatStore();
    await s.openAgent('ma');
    await s.resume('stored-9');
    expect(a.posted('/api/chat/resume')).toEqual([{ profile: 'ma', stored_id: 'stored-9' }]);
    expect(s.current()?.id).toBe('s-old');
  });

  it('fillDraft: 지금 대화의 입력창 초안만 채운다(새 세션도 보내기도 없다)', async () => {
    const a = api();
    const s = new ChatStore();
    await s.openAgent('ma');
    const seen = vi.fn();
    s.subscribe?.(seen);
    s.fillDraft('이 파일을 열어 줘');
    expect(s.draft).toBe('이 파일을 열어 줘');
    expect(a.posted('/api/chat/session')).toEqual([]);
    expect(a.posted('/api/chat/send')).toEqual([]);
  });

  it('ask: 새 대화를 열고 초안을 채운다(보내지는 않는다)', async () => {
    const a = api();
    const s = new ChatStore();
    await s.ask('ma', '이 스킬을 설명해 줘');
    expect(s.profile).toBe('ma');
    expect(s.draft).toBe('이 스킬을 설명해 줘');
    expect(a.posted('/api/chat/session')).toEqual([{ profile: 'ma' }]);
    expect(a.posted('/api/chat/send')).toEqual([]);
  });

  it('ask: 주 에이전트를 쓰는 POD 는 루트(default)가 없으므로 default 를 주 에이전트로 바꿔 연다(2026-10-15, 「없는 프로파일」)', async () => {
    const a = api({ '/api/chat/status': { ...STATUS, agents: [{ name: 'main' }], primary: 'main' } });
    const s = new ChatStore();
    await s.ask('default', '이 스킬을 설명해 줘');
    expect(s.profile).toBe('main');
    expect(a.posted('/api/chat/session')).toEqual([{ profile: 'main' }]);
    await s.openAgent('default');
    expect(s.profile).toBe('main');
    expect(a.calls.some((c) => c.url.includes('profile=default'))).toBe(false);
  });

  it('ask: 루트가 있는 POD 의 default 는 그대로 두고, 아는 이름이 아니어도 default 가 아니면 바꾸지 않는다', async () => {
    const a = api({ '/api/chat/status': { ...STATUS, agents: [{ name: 'default' }, { name: 'ma' }], primary: 'default' } });
    const s = new ChatStore();
    await s.ask('default', 'x');
    expect(a.posted('/api/chat/session')).toEqual([{ profile: 'default' }]);
    await s.ask('ghost', 'y');
    expect(s.profile).toBe('ghost');
  });

  it('ask: 앞선 실패의 안내는 새 대화를 열 때 지운다(성공했는데도 옛 「없는 프로파일」이 남아 보이던 문제)', async () => {
    api();
    const s = new ChatStore();
    await s.preload();
    s.notice = '없는 프로파일';
    await s.ask('ma', '설명해 줘');
    expect(s.notice).toBe('');
    expect(s.current()?.id).toBe('s-new');
  });

  // ---- 연결이 끊긴 대화를 저절로 다시 연다(스펙 2026-10-20-030). 여기는 SSE 경로 — 웹소켓 경로는 chatStore.fallback.test.ts ----
  /** 대화 하나를 SSE 로 열고 저장 대화 id(session.title)와 반쯤 받은 답을 넣어 둔다 */
  async function opened(over: Parameters<typeof api>[0] = {}) {
    const a = api({ '/api/chat/resume': (b: Record<string, unknown>) => ({ session_id: 's-new', profile: b.profile, reused: false, history: true }), ...over });
    const s = new ChatStore();
    await s.openAgent('ma');
    await s.send('a');
    const es = FakeES.all[0];
    es.emit('session.title', { session_id: 'st-1', title: 'a' });
    es.emit('aas.user', { text: 'a' });
    es.emit('message.delta', { text: '반쯤' });
    return { a, s, es };
  }

  it('SSE 가 끊기면 브라우저 재시도에 맡기지 않고 끊긴 그 대화를 resume 해 목록에 기록 끝부분만 합친다', async () => {
    const { a, s, es } = await opened();
    es.onerror?.();
    expect(es.closed).toBe(true);
    await vi.waitFor(() => expect(FakeES.all).toHaveLength(2));
    expect(a.posted('/api/chat/resume')).toEqual([{ profile: 'ma', stored_id: 'st-1' }]);
    expect(FakeES.all[1].url).toBe('/api/chat/events?session_id=s-new'); // 기록을 다시 보내므로 처음부터
    const S = s.current()!;
    expect(S.closed).toBe(false);
    expect(S.reconnect).toBeUndefined();
    FakeES.all[1].emit('aas.history', { messages: [{ role: 'user', text: 'a' }, { role: 'assistant', text: '끝난 답' }] });
    expect(S.items.map((i) => [i.kind, i.text])).toEqual([['user', 'a'], ['assistant', '끝난 답']]); // 「지난 대화」 구분선 없음(RD1)
    expect(s.announce).toBe('대화를 다시 열었습니다');
  });

  it('서버가 503 이면 1·2초… 간격을 늘려 다시 열고, 그동안 보내기·승인 답하기를 막는다', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    let n = 0;
    const { a, s, es } = await opened({
      '/api/chat/resume': () => (++n < 3 ? new Response('{}', { status: 503 }) : { session_id: 's-new', profile: 'ma', reused: true, history: false }),
    });
    try {
      es.onerror?.();
      await vi.advanceTimersByTimeAsync(0);
      expect(n).toBe(1);
      const S = s.current()!;
      expect(s.reconnectView(S)).toMatchObject({ mode: 'reopen' });
      expect(await s.send('보내지 마')).toBe('reconnecting');
      await s.interrupt();
      expect(a.posted('/api/chat/send')).toHaveLength(1);
      expect(a.posted('/api/chat/interrupt')).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(999);
      expect(n).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(n).toBe(2);
      await vi.advanceTimersByTimeAsync(2000);
      expect(n).toBe(3);
      expect(S.closed).toBe(false);
      expect(FakeES.all.at(-1)!.url).toContain('after='); // 같은 서버 — 받던 번호 뒤부터
    } finally {
      vi.useRealTimers();
    }
  });

  it('5분이 넘으면 「다시 열지 못했습니다」 줄과 「다시 열기」로 내리고, 누르면 한도를 새로 시작한다', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    let n = 0;
    const { s, es } = await opened({ '/api/chat/resume': () => (++n, new Response('{}', { status: 503 })) });
    try {
      es.onerror?.();
      await vi.advanceTimersByTimeAsync(6 * 60000);
      const S = s.current()!;
      expect(S.reconnect).toBeUndefined();
      expect(S.items.at(-1)).toMatchObject({ kind: 'error', text: '이 대화를 다시 열지 못했습니다.', reopen: true });
      expect(n).toBeLessThanOrEqual(12);
      const before = n;
      await s.reopen();
      await vi.advanceTimersByTimeAsync(0);
      expect(n).toBe(before + 1);
      expect(S.reconnect).toMatchObject({ tries: 1 });
    } finally {
      vi.useRealTimers();
    }
  });

  it('Hermes 에서 대화를 찾지 못하면(404) 바로 「새 대화」 줄로 내린다', async () => {
    const { a, s, es } = await opened({ '/api/chat/resume': () => new Response(JSON.stringify({ error: 'x', code: 'not_found' }), { status: 404 }) });
    es.onerror?.();
    await vi.waitFor(() => expect(s.current()!.reconnect).toBeUndefined());
    expect(s.current()!.items.at(-1)).toMatchObject({ kind: 'error', newChat: true });
    expect(a.posted('/api/chat/resume')).toHaveLength(1);
  });

  it('Hermes 대시보드가 끊겼다는 이벤트를 받으면 기다리지 않고 resume 한다(D6)', async () => {
    const { a, es } = await opened({ '/api/chat/resume': () => ({ session_id: 's-new', profile: 'ma', reused: false, history: false }) });
    es.emit('aas.disconnected', { code: 'hub_disconnected', text: 'x' });
    await vi.waitFor(() => expect(a.posted('/api/chat/resume')).toHaveLength(1));
    expect(a.calls.filter((c) => c.url.startsWith('/api/chat/status')).length).toBe(1); // 처음 목록 읽기뿐
    await vi.waitFor(() => expect(FakeES.all).toHaveLength(2));
    expect(FakeES.all[1].url).toContain('after='); // 같은 서버 프로세스라 기록을 다시 보내지 않는다
  });

  it('다른 아이디로 다시 열리면 지금 대화·목록을 새 아이디로 옮긴다', async () => {
    const { s, es } = await opened({ '/api/chat/resume': () => ({ session_id: 's-other', profile: 'ma', reused: false, history: true }) });
    es.onerror?.();
    await vi.waitFor(() => expect(s.current()?.id).toBe('s-other'));
    expect(s.sessionOf('ma')?.id).toBe('s-other');
    expect(s.current()!.items.map((i) => i.text)).toEqual(['a', '반쯤']);
  });

  it('다시 여는 중에 사람이 새 대화를 열면 그 대화는 그만둔다', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    try {
      const { a, s, es } = await opened({ '/api/chat/resume': () => new Response('{}', { status: 503 }) });
      es.onerror?.();
      await vi.advanceTimersByTimeAsync(0);
      const old = s.current()!;
      await s.newChat();
      await vi.advanceTimersByTimeAsync(60000);
      expect(old.reconnect).toBeUndefined();
      expect(a.posted('/api/chat/resume')).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  // 대시보드가 새로고침 없이 에이전트를 바꾼 뒤 채팅이 옛 에이전트의 main 을 보여 「없는 프로파일」이 나던 문제(2026-10-19-001 R1)
  it('podChanged: 에이전트를 바꾸면 목록을 다시 읽고, 이름만 넘긴 열기는 새 지금 에이전트에서 연다', async () => {
    let pod = 'a';
    const a = api({
      '/api/chat/status': () =>
        pod === 'a'
          ? { configured: true, pod: 'a', primary: 'main', agents: [{ name: 'main' }], sessions: [] }
          : { configured: true, pod: 'b', primary: 'default', agents: [{ name: 'default' }], sessions: [] },
    });
    const s = new ChatStore();
    await s.openAgent('main');
    expect(s.profile).toBe('main');
    pod = 'b';
    s.podChanged();
    expect(s.status).toBeNull();
    await s.preload();
    expect(s.status!.agents.map((x) => x.name)).toEqual(['default']);
    // 화면에 남아 있던 옛 이름으로 열어도 새 에이전트에 없는 이름이면 서버에 묻지 않고 주 에이전트를 연다
    a.calls.length = 0;
    await s.openAgent('main');
    expect(s.profile).toBe('default');
    expect(a.calls.some((c) => c.url.includes('profile=main'))).toBe(false);
  });

  it('podChanged: 바꾸기 전에 나간 옛 상태 요청의 응답은 버린다', async () => {
    let release: (v: Response) => void = () => {};
    let first = true;
    vi.stubGlobal(
      'fetch',
      vi.fn(() => {
        if (first) {
          first = false;
          return new Promise<Response>((r) => (release = r));
        }
        return Promise.resolve(new Response(JSON.stringify({ configured: true, pod: 'b', agents: [{ name: 'default' }] }), { status: 200 }));
      })
    );
    const s = new ChatStore();
    const old = s.preload();
    s.podChanged();
    await s.preload();
    release(new Response(JSON.stringify({ configured: true, pod: 'a', agents: [{ name: 'main' }] }), { status: 200 }));
    await old;
    expect(s.status!.pod).toBe('b');
  });

  // 2026-10-19-001 R2: 채팅에 내 에이전트를 모두 보인다. 에이전트마다 main 이 있어 이름만으로는 대화가 섞였다(발견 1·2)
  describe('여러 에이전트', () => {
    const GROUPS = {
      pod: 'a',
      groups: [
        { pod: 'a', current: true, configured: true, name: '관리자 AAS', primary: 'main', agents: [{ name: 'main' }], sessions: [] },
        { pod: 'b', configured: true, name: '마케팅 도우미', primary: 'main', agents: [{ name: 'main' }], sessions: [] },
      ],
    };

    it('두 에이전트의 main 은 따로 열리고, 요청·이벤트 주소에 대화의 에이전트가 실린다', async () => {
      const a = api({
        '/api/chat/status': GROUPS,
        '/api/chat/session': (b: Record<string, unknown>) => ({ session_id: `s-${b.pod}`, profile: b.profile, title: '' }),
      });
      const s = new ChatStore();
      await s.openAgent('main', 'a');
      await s.send('안녕');
      await s.openAgent('main', 'b');
      expect(s.currentId).toBeNull(); // a 의 대화를 b 의 main 으로 열지 않는다
      await s.send('반가워');
      expect(a.posted('/api/chat/session')).toEqual([{ profile: 'main', pod: 'a' }, { profile: 'main', pod: 'b' }]);
      expect(a.posted('/api/chat/send')).toEqual([
        { session_id: 's-a', text: '안녕', pod: 'a' },
        { session_id: 's-b', text: '반가워', pod: 'b' },
      ]);
      expect(FakeES.all.map((e) => e.url)).toEqual([
        '/api/chat/events?session_id=s-a&pod=a',
        '/api/chat/events?session_id=s-b&pod=b',
      ]);
      expect(a.calls.some((c) => c.url === '/api/chat/history?profile=main&pod=b')).toBe(true);
      await s.openAgent('main', 'a');
      expect(s.currentId).toBe('s-a'); // 다시 고르면 a 의 대화가 그대로 있다
      await s.interrupt();
      expect(a.posted('/api/chat/interrupt')).toEqual([{ session_id: 's-a', pod: 'a' }]);
    });

    it('이름만 넘긴 열기(링크·팝업)는 지금 에이전트에서 연다. PRIMARY 는 채팅 기본 → 주 프로파일', async () => {
      api({
        '/api/chat/status': {
          pod: 'b',
          groups: [
            { pod: 'b', current: true, configured: true, primary: 'main', chat_default: 'ops', agents: [{ name: 'main' }, { name: 'ops' }], sessions: [] },
            { pod: 'a', configured: true, primary: 'main', agents: [{ name: 'main' }], sessions: [] },
          ],
        },
      });
      const s = new ChatStore();
      await s.openAgent(PRIMARY);
      expect([s.status?.pod, s.profile]).toEqual(['b', 'ops']);
    });

    it('목록에서 진짜 루트 default 를 누르면 주 에이전트로 바꾸지 않는다', async () => {
      api({
        '/api/chat/status': { pod: 'a', groups: [{ pod: 'a', current: true, configured: true, primary: 'main', agents: [{ name: 'default' }, { name: 'main' }], sessions: [] }] },
      });
      const s = new ChatStore();
      await s.openAgent('default', 'a');
      expect(s.profile).toBe('default');
    });

    // 대시보드에서 바꾼 뒤 다시 읽으면 고른 묶음을 잊어, 대화는 b 의 것인데 머리는 a 로 나왔다(2026-10-19 OKE 시험)
    it('지금 에이전트가 바뀌어 다시 읽어도 대화 중이던 에이전트의 묶음을 그대로 고른다', async () => {
      let cur = 'a';
      api({ '/api/chat/status': () => ({ pod: cur, groups: GROUPS.groups.map((g) => ({ ...g, current: g.pod === cur })) }) });
      const s = new ChatStore();
      await s.openAgent('main', 'b');
      cur = 'b';
      s.podChanged();
      await s.preload();
      expect(s.status?.pod).toBe('b');
      expect(s.currentPod).toBe('b');
      cur = 'a';
      s.podChanged();
      await s.preload();
      expect(s.status?.pod).toBe('b'); // 지금 에이전트(a)로 바뀌어도 대화 중이던 b 를 고른 채로 둔다
    });

    it('다른 에이전트의 프로파일로 옮기면 첨부를 비운다(OMAI-1153 D6·D13)', async () => {
      api({ '/api/chat/status': { ...GROUPS, groups: GROUPS.groups.map((g) => ({ ...g, files: true })) } });
      const s = new ChatStore();
      await s.openAgent('main', 'a');
      s.addFiles([], [{ name: 'x.bin', code: 'type' }]);
      expect(s.uploads).toHaveLength(1);
      await s.openAgent('main', 'a');
      expect(s.uploads).toHaveLength(1); // 같은 에이전트면 남는다
      await s.openAgent('main', 'b');
      expect(s.uploads).toHaveLength(0);
    });
  });
});

// 2026-10-19-013: 프로파일이 하나뿐인 에이전트는 에이전트 이름만 보인다
describe('채팅 이름 규칙', () => {
  const g = (over: object = {}) => ({ configured: true, pod: 'aas-agent-x-1a2b', name: '관리자 AAS', primary: 'main', state: 'ok' as const, primary_ready: true, agents: [{ name: 'main' }], ...over });
  const main = { name: 'main' };
  const sales = { name: 'sales', title: '영업' };

  it('정상이고 프로파일이 1개일 때만 하나로 본다(R1·DD3)', () => {
    expect(singleProfile(g())).toBe(true);
    expect(singleProfile(g({ state: undefined }))).toBe(true);
    expect(singleProfile(g({ agents: [main, sales] }))).toBe(false);
    expect(singleProfile(g({ agents: [] }))).toBe(false);
    expect(singleProfile(g({ state: 'starting' }))).toBe(false);
    expect(singleProfile(g({ state: 'error' }))).toBe(false);
    expect(singleProfile(g({ primary_ready: false }))).toBe(false); // main 을 만드는 중(옛 POD 의 default 하나) — 대상이 바뀔 수 있다
    expect(singleProfile(null)).toBe(false);
  });

  it('줄 제목: 1개면 에이전트 이름, 이름이 없거나 여럿이면 프로파일 제목 — id 는 쓰지 않는다(R2)', () => {
    expect(rowTitle(g(), main)).toBe('관리자 AAS');
    expect(rowTitle(g({ name: '' }), main)).toBe('main');
    expect(rowTitle(g({ agents: [main, sales] }), sales)).toBe('영업');
    expect(rowTitle(undefined, sales)).toBe('영업');
  });

  it('대상 제목: 1개면 에이전트 이름, 여럿이고 묶음이 여럿이면 「이름 / 프로파일」, 이름이 없으면 프로파일만(C5)', () => {
    expect(targetTitle(g(), main, true)).toBe('관리자 AAS');
    expect(targetTitle(g({ agents: [main, sales] }), sales, true)).toBe('관리자 AAS / 영업');
    expect(targetTitle(g({ agents: [main, sales] }), sales, false)).toBe('영업');
    expect(targetTitle(g({ agents: [main, sales], name: '' }), sales, true)).toBe('영업');
  });

  it('묶음 머리 이름은 id 대신 주 프로파일 이름, 그것도 없으면 「이름 없는 에이전트」(DD14)', () => {
    expect(groupLabel(g())).toBe('관리자 AAS');
    expect(groupLabel(g({ name: '' }))).toBe('main');
    expect(groupLabel(g({ name: '', primary: '' }))).toBe('이름 없는 AI 에이전트 작업공간');
  });
});

// 스펙 2026-10-28-014 §4-2: 채팅 링크(agent·pod·session·text)로 여는 길
describe('ChatStore — 채팅 링크', () => {
  const GROUPS = {
    pod: 'a',
    groups: [
      { pod: 'a', current: true, configured: true, primary: 'main', agents: [{ name: 'main' }], sessions: [] },
      { pod: 'b', configured: true, primary: 'main', agents: [{ name: 'main' }, { name: 'plan' }], sessions: [] },
    ],
  };

  it('openStored: 가장 최근 대화가 있어도 링크의 대화만 그 묶음에서 잇는다(외부 검토 C1)', async () => {
    const a = api({ '/api/chat/status': GROUPS, '/api/chat/history': { sessions: [{ id: 'recent', source: 'aas' }] } });
    const s = new ChatStore();
    expect(await s.openStored('plan', 'b', 'y')).toBe(true);
    expect(a.posted('/api/chat/resume')).toEqual([{ profile: 'plan', stored_id: 'y', pod: 'b' }]);
    expect(a.calls.some((c) => c.url.startsWith('/api/chat/history'))).toBe(false);
    expect(s.status?.pod).toBe('b');
    expect(s.current()?.storedId).toBe('y');
    // 같은 대화가 열려 있으면 다시 묻지 않고 그것을 쓴다
    await s.openAgent('main', 'a');
    expect(await s.openStored('plan', 'b', 'y')).toBe(true);
    expect(a.posted('/api/chat/resume').filter((b) => b.stored_id === 'y')).toHaveLength(1); // a 의 main 은 최근 대화(recent)를 이었다
    expect(s.current()?.storedId).toBe('y');
  });

  it('openStored: 못 열면 거짓을 돌려주고 안내를 남긴다. 다른 대화를 대신 열지 않는다', async () => {
    api({ '/api/chat/status': GROUPS, '/api/chat/resume': new Error('없는 대화') });
    const s = new ChatStore();
    expect(await s.openStored('plan', 'b', 'gone')).toBe(false);
    expect(s.profile).toBe('plan');
    expect(s.current()).toBeNull();
    expect(s.opening).toBe('');
    expect(s.notice).toBe('링크의 대화를 열지 못했습니다: 없는 대화');
  });

  it('ask: pod 를 넘기면 그 묶음에서 새 대화를 연다(외부 검토 H2). 없으면 지금 에이전트', async () => {
    const a = api({ '/api/chat/status': GROUPS });
    const s = new ChatStore();
    await s.ask('plan', '설명해 줘', 'b');
    expect(s.status?.pod).toBe('b');
    expect(s.profile).toBe('plan');
    expect(s.draft).toBe('설명해 줘');
    await s.ask('main', '다시');
    expect(a.posted('/api/chat/session')).toEqual([
      { profile: 'plan', pod: 'b' },
      { profile: 'main', pod: 'a' },
    ]);
  });
});

// Session-centric chat: several sessions per agent run in parallel and show their state in one list
describe('ChatStore — parallel sessions', () => {
  const seq = () => {
    let n = 0;
    return (b: Record<string, unknown>) => ({ session_id: `s${++n}`, profile: b.profile, title: '' });
  };

  it('a new session keeps the previous one open and streaming', async () => {
    api({ '/api/chat/session': seq() });
    const s = new ChatStore();
    await s.startNew('ma');
    await s.send('first task');
    const first = s.currentId!;
    await s.startNew('ma');
    expect(s.currentId).not.toBe(first);
    expect(Object.keys(s.sessions)).toHaveLength(2);
    expect(FakeES.all.filter((e) => !e.closed)).toHaveLength(2); // both still receive events
  });

  it('lists sessions waiting > running > recent, and hides empty sessions that are not shown', async () => {
    api({ '/api/chat/session': seq() });
    const s = new ChatStore();
    await s.startNew('ma'); // s1: finishes after I moved on -> done (unread)
    FakeES.all[0].emit('aas.user', { text: 'quick one' });
    await s.startNew('ma'); // s2: running
    FakeES.all[1].emit('aas.user', { text: 'long job' });
    FakeES.all[0].emit('message.complete', { text: 'ok' });
    await s.startNew('ops'); // s3: waiting for my answer
    FakeES.all[2].emit('aas.user', { text: 'needs approval' });
    FakeES.all[2].emit('approval.request', { request_id: 'r1', command: 'rm x', choices: ['once', 'deny'] });
    await s.startNew('ma'); // s4: empty and current
    await s.startNew('ops'); // s5: empty and current, s4 now hidden
    const rows = s.sessionRows();
    expect(rows.slice(0, 2).map((r) => [r.id, r.state])).toEqual([
      ['s3', 'waiting'],
      ['s2', 'running'],
    ]);
    expect(rows.slice(2).map((r) => `${r.id}:${r.state}`).sort()).toEqual(['s1:done', 's5:idle']);
    expect(rows.map((r) => r.id)).not.toContain('s4');
    expect(rows.find((r) => r.id === 's1')?.unread).toBe(1); // finished while not shown
    expect(rows.find((r) => r.id === 's3')?.profile).toBe('ops');
  });

  it('focus switches to another session and clears its unread count', async () => {
    api({ '/api/chat/session': seq() });
    const s = new ChatStore();
    await s.startNew('ma');
    FakeES.all[0].emit('aas.user', { text: 'a' });
    await s.startNew('ops');
    FakeES.all[0].emit('message.complete', { text: 'done' });
    expect(s.sessions.s1.unread).toBe(1);
    expect(await s.focus('s1')).toBe(true);
    expect(s.currentId).toBe('s1');
    expect(s.profile).toBe('ma');
    expect(s.sessions.s1.unread).toBe(0);
  });

  it('interrupt and answers go to the given session, not only the one shown', async () => {
    const a = api({ '/api/chat/session': seq() });
    const s = new ChatStore();
    await s.startNew('ma');
    await s.startNew('ma');
    await s.interrupt('s1');
    expect(a.posted('/api/chat/interrupt')).toEqual([{ session_id: 's1' }]);
  });

  it('keeps a separate draft per session', async () => {
    api({ '/api/chat/session': seq() });
    const s = new ChatStore();
    await s.startNew('ma');
    s.stashDraft('s1', s.status?.pod, 'ma', 'half written');
    await s.startNew('ma');
    expect(s.draft).toBe('');
    await s.focus('s1');
    expect(s.draft).toBe('half written');
  });

  it('dismissMany hides on the server per agent and drops the rows here', async () => {
    const a = api({ '/api/chat/session': seq() });
    const s = new ChatStore();
    await s.startNew('ma');
    FakeES.all[0].emit('aas.user', { text: 'a' });
    await s.startNew('ops');
    FakeES.all[1].emit('aas.user', { text: 'b' });
    s.liveRows = [{ session_id: 'far', pod: 'other', profile: 'x', title: 'from my phone', state: 'idle', last_at: 1 }];
    s.dismissMany(['s1', 's2', 'far']);
    await Promise.resolve();
    const hidden = a.posted('/api/chat/sessions/hide');
    expect(hidden).toContainEqual({ ids: ['far'], pod: 'other' });
    expect(hidden.flatMap((b) => b.ids as string[]).sort()).toEqual(['far', 's1', 's2']);
    expect(s.sessionRows()).toEqual([]);
    expect(FakeES.all.every((e) => e.closed)).toBe(true);
  });

  it('dismissFinished keeps running, waiting, pinned and the shown session', async () => {
    api({ '/api/chat/session': seq() });
    const s = new ChatStore();
    await s.startNew('ma'); // s1 done
    FakeES.all[0].emit('aas.user', { text: 'done one' });
    FakeES.all[0].emit('message.complete', { text: 'ok' });
    await s.startNew('ma'); // s2 running
    FakeES.all[1].emit('aas.user', { text: 'long' });
    await s.startNew('ma'); // s3 waiting
    FakeES.all[2].emit('aas.user', { text: 'ask' });
    FakeES.all[2].emit('approval.request', { request_id: 'r', command: 'x', choices: ['once'] });
    await s.startNew('ma'); // s4 done + pinned
    FakeES.all[3].emit('aas.user', { text: 'keep me' });
    FakeES.all[3].emit('message.complete', { text: 'ok' });
    s.togglePin('s4');
    await s.startNew('ma'); // s5 current, done
    FakeES.all[4].emit('aas.user', { text: 'current' });
    FakeES.all[4].emit('message.complete', { text: 'ok' });
    expect(s.dismissFinished()).toBe(1);
    expect(s.sessionRows().map((r) => r.id).sort()).toEqual(['s2', 's3', 's4', 's5']);
    expect(s.sessionRows().find((r) => r.id === 's4')?.pinned).toBe(true);
  });

  it('countsByAgent counts running and waiting sessions per agent', async () => {
    api({ '/api/chat/session': seq() });
    const s = new ChatStore();
    await s.startNew('ma');
    FakeES.all[0].emit('aas.user', { text: 'a' });
    await s.startNew('ma');
    FakeES.all[1].emit('aas.user', { text: 'b' });
    FakeES.all[1].emit('clarify.request', { request_id: 'c', question: 'which?' });
    const c = s.countsByAgent()[`${s.status?.pod ?? ''}|ma`];
    expect(c).toMatchObject({ running: 1, waiting: 1, total: 2 });
  });

  it('dismiss closes the stream and removes the session from the list', async () => {
    api({ '/api/chat/session': seq() });
    const s = new ChatStore();
    await s.startNew('ma');
    FakeES.all[0].emit('aas.user', { text: 'a' });
    s.dismiss('s1');
    expect(FakeES.all[0].closed).toBe(true);
    expect(s.sessionRows()).toEqual([]);
    expect(s.currentId).toBeNull();
  });

  it('Hermes auto-title after the first turn becomes the session title', async () => {
    api({ '/api/chat/session': seq() });
    const s = new ChatStore();
    await s.startNew('ma');
    FakeES.all[0].emit('aas.user', { text: 'please summarise the weekly report and send it' });
    FakeES.all[0].emit('session.title', { session_id: 'stored-1', title: 'Weekly report summary' });
    expect(s.sessions.s1.title).toBe('Weekly report summary');
    expect(s.sessions.s1.storedId).toBe('stored-1');
  });

  it('server-only sessions (opened in another tab) appear in the list and can be opened', async () => {
    const a = api({
      '/api/chat/sessions': { sessions: [{ session_id: 'x9', pod: '', profile: 'ops', title: 'From another tab', stored_id: 'st9', state: 'running', last_at: 100 }] },
      '/api/chat/resume': { session_id: 'x9', profile: 'ops', title: 'From another tab', reused: true },
    });
    const s = new ChatStore();
    await s.preload();
    await s.loadSessions();
    expect(s.sessionRows().map((r) => [r.id, r.state, r.remote])).toEqual([['x9', 'running', true]]);
    expect(await s.focus('x9')).toBe(true);
    expect(a.posted('/api/chat/resume')).toEqual([{ profile: 'ops', stored_id: 'st9' }]);
    expect(s.currentId).toBe('x9');
  });
});

describe('ChatStore — 에이전트를 고르면 열린 세션으로(스펙 2026-11-05-005 D1)', () => {
  const seq = () => {
    let n = 0;
    return (b: Record<string, unknown>) => ({ session_id: `s${++n}`, profile: b.profile, title: '' });
  };

  it('그 에이전트의 열린 세션 중 최근 것을 고르고, 없으면 undefined', async () => {
    api({ '/api/chat/session': seq() });
    const s = new ChatStore();
    expect(s.openSessionFor('ma')).toBeUndefined();
    await s.startNew('ma'); // s1
    FakeES.all[0].emit('aas.user', { text: 'old task' });
    await s.startNew('ops'); // s2
    FakeES.all[1].emit('aas.user', { text: 'ops task' });
    await s.startNew('ma'); // s3 — 가장 최근
    FakeES.all[2].emit('aas.user', { text: 'new task' });
    await s.startNew('ops'); // 지금 보는 것은 ops
    expect(s.openSessionFor('ma')?.id).toBe('s3');
    expect(s.openSessionFor('ops')?.profile).toBe('ops');
    expect(s.openSessionFor('nobody')).toBeUndefined();
  });

  it('닫은(숨긴) 세션은 열린 세션으로 보지 않는다', async () => {
    api({ '/api/chat/session': seq(), '/api/chat/sessions/hide': () => ({ ok: true }) });
    const s = new ChatStore();
    await s.startNew('ma');
    FakeES.all[0].emit('aas.user', { text: 'task' });
    await s.startNew('ops');
    s.dismiss('s1');
    expect(s.openSessionFor('ma')).toBeUndefined();
  });

  it('다른 기기에서 숨긴 세션은 이 탭에서 열고 있어도 목록에서 빠진다', async () => {
    api({
      '/api/chat/session': seq(),
      '/api/chat/sessions': () => ({ sessions: [], hidden: ['s1'] }),
    });
    const s = new ChatStore();
    await s.startNew('ma');
    FakeES.all[0].emit('aas.user', { text: 'closed on my phone' });
    await s.startNew('ops');
    FakeES.all[1].emit('aas.user', { text: 'still here' });
    expect(s.sessionRows().map((r) => r.id).sort()).toEqual(['s1', 's2']);
    await s.loadSessions();
    expect(s.sessionRows().map((r) => r.id)).toEqual(['s2']);
  });
});

describe('ChatStore — 닫은 대화는 「완료」에서 빠진다(스펙 2026-11-06-002 E1~E3)', () => {
  const past = { sessions: [
    { id: 'st-a', source: 'aas', title: 'closed elsewhere', message_count: 3 },
    { id: 'st-b', source: 'aas', title: 'closed here', message_count: 2 },
    { id: 'st-c', source: 'aas', title: 'kept', message_count: 1 },
  ] };
  it('완료는 exclude_hidden 으로 읽고, 서버 숨김 표·이 탭에서 닫은 세션의 저장 줄을 뺀다', async () => {
    const a = api({
      '/api/chat/history': past,
      '/api/chat/sessions': () => ({ sessions: [{ session_id: 'live-b', profile: 'ma', title: 'closed here', state: 'idle', last_at: 1, stored_id: 'st-b' }],
        hidden: [], hidden_stored: ['st-a'] }),
    });
    const s = new ChatStore();
    await s.loadSessions();
    await s.loadPast(undefined, 'ma', true);
    expect(a.calls.some((c) => c.url.startsWith('/api/chat/history') && c.url.includes('exclude_hidden=1'))).toBe(true);
    expect(s.agentRows(undefined, 'ma').map((r) => r.id)).toEqual(['live-b', 'stored:st-c']);
    s.dismiss('live-b');
    // 표에 남기 전에 서버가 옛 목록을 줘도 바로 빠진다
    expect(s.agentRows(undefined, 'ma').map((r) => r.id)).toEqual(['stored:st-c']);
    expect(a.posted('/api/chat/sessions/hide')).toContainEqual({ ids: ['live-b'] });
  });

  it('닫았던 대화를 다시 열면 완료에 돌아온다', async () => {
    api({
      '/api/chat/history': past,
      '/api/chat/sessions': () => ({ sessions: [], hidden: [], hidden_stored: ['st-a'] }),
      '/api/chat/resume': { session_id: 's-a', profile: 'ma', title: 'closed elsewhere', stored_id: 'st-a' },
    });
    const s = new ChatStore();
    await s.loadSessions();
    await s.loadPast(undefined, 'ma', true);
    expect(s.agentRows(undefined, 'ma').some((r) => r.storedId === 'st-a')).toBe(false);
    await s.resume('st-a');
    expect(s.agentRows(undefined, 'ma').some((r) => r.storedId === 'st-a')).toBe(true);
  });
});

describe('ChatStore — 회귀 계약 ②: 세션마다 각자 다시 연다(스펙 2026-11-05-005 RQ4)', () => {
  it('두 세션이 함께 끊기면 각자 자기 저장 대화로 resume 한다(서버가 바뀌어도 이어진다, §5-1 U4)', async () => {
    let n = 0;
    const a = api({
      '/api/chat/session': (b: Record<string, unknown>) => ({ session_id: `s${++n}`, profile: b.profile, title: '' }),
      '/api/chat/resume': (b: Record<string, unknown>) => ({ session_id: `re-${String(b.stored_id)}`, profile: 'ma', reused: false, history: true }),
    });
    const s = new ChatStore();
    await s.startNew('ma');
    FakeES.all[0].emit('session.title', { session_id: 'st-1' });
    FakeES.all[0].emit('aas.user', { text: 'one' });
    await s.startNew('ma');
    FakeES.all[1].emit('session.title', { session_id: 'st-2' });
    FakeES.all[1].emit('aas.user', { text: 'two' });
    FakeES.all[0].emit('aas.disconnected', { code: 'hub_disconnected', text: 'x' });
    FakeES.all[1].emit('aas.disconnected', { code: 'hub_disconnected', text: 'x' });
    await vi.waitFor(() => expect(a.posted('/api/chat/resume')).toHaveLength(2));
    expect(a.posted('/api/chat/resume').map((b) => b.stored_id).sort()).toEqual(['st-1', 'st-2']);
    await vi.waitFor(() => expect(Object.keys(s.sessions).sort()).toEqual(['re-st-1', 're-st-2']));
  });
});

describe('cleanTitle', () => {
  it.each([
    ['"G:\\공유 드라이브\\영업\\계약.pdf" 요약해줘', '계약.pdf 요약해줘'],
    ['"G:\\공유 드라이브\\영업', '영업'],
    ['G:\\공유 드라이브\\a b\\보고서.docx 읽어줘', '보고서.docx 읽어줘'],
    ['/opt/data/home/report.md 확인', 'report.md 확인'],
    ['https://wiki.example.com/s/team/p/abc 실행해', 'wiki.example.com/…/abc 실행해'],
    ['뭐 해먹지', '뭐 해먹지'],
    ['and/or 비교', 'and/or 비교'],
  ])('%s', (raw, want) => expect(cleanTitle(raw)).toBe(want));
  it('cuts long titles at 60 characters', () => expect(cleanTitle('가'.repeat(80))).toHaveLength(60));
});

describe('ChatStore — opening a session that already has events (catch-up)', () => {
  const ROW = { session_id: 'x9', pod: '', profile: 'ops', title: 'Earlier chat', stored_id: 'st9', state: 'idle', last_at: 100 };

  async function openExisting(resume: Record<string, unknown>) {
    api({ '/api/chat/sessions': { sessions: [ROW] }, '/api/chat/resume': resume });
    const s = new ChatStore();
    await s.preload();
    await s.loadSessions();
    expect(await s.focus('x9')).toBe(true);
    return s;
  }

  it('replays past events without redrawing per token, then draws once at the server head', async () => {
    const s = await openExisting({ session_id: 'x9', profile: 'ops', title: 'Earlier chat', reused: true, history: false, seq: 5 });
    const S = s.sessions.x9;
    expect(S.catchUp).toBe(5);
    const es = FakeES.all[0];
    const v0 = s.version;
    es.emit('aas.user', { text: 'question' });
    es.emit('message.start');
    es.emit('message.delta', { text: 'an' });
    es.emit('message.delta', { text: 'swer' });
    expect(s.version).toBe(v0); // nothing redrawn while catching up
    expect(S.unread).toBe(0);
    es.emit('message.complete', { text: 'answer' }); // seq 5 = head
    expect(S.catchUp).toBeUndefined();
    expect(s.version).toBe(v0 + 1); // one redraw with the whole conversation
    expect(S.busy).toBe(false);
    expect(S.items.filter((x) => x.kind === 'assistant').map((x) => x.text)).toEqual(['answer']);
    es.emit('aas.user', { text: 'next' }); // live events redraw as before
    expect(s.version).toBe(v0 + 2);
  });

  it('a session row from the server list passes its head when there is no stored id', async () => {
    api({ '/api/chat/sessions': { sessions: [{ ...ROW, stored_id: '', seq: 3 }] } });
    const s = new ChatStore();
    await s.preload();
    await s.loadSessions();
    await s.focus('x9');
    expect(s.sessions.x9.catchUp).toBe(3);
  });

  it('older servers without seq keep the previous behaviour', async () => {
    const s = await openExisting({ session_id: 'x9', profile: 'ops', title: 'Earlier chat', reused: true });
    expect(s.sessions.x9.catchUp).toBeUndefined();
    const v0 = s.version;
    FakeES.all[0].emit('aas.user', { text: 'question' });
    expect(s.version).toBe(v0 + 1);
  });

  it('draws what it has if the head never arrives', async () => {
    vi.useFakeTimers();
    try {
      const s = await openExisting({ session_id: 'x9', profile: 'ops', title: 'Earlier chat', reused: true, seq: 50 });
      FakeES.all[0].emit('aas.user', { text: 'question' });
      expect(s.sessions.x9.catchUp).toBe(50);
      vi.advanceTimersByTime(8000);
      expect(s.sessions.x9.catchUp).toBeUndefined();
      expect(s.sessions.x9.items.some((x) => x.kind === 'user')).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('ChatStore — 화면 상태(스펙 2026-11-06-002 G9·G10·G11)', () => {
  it('G9: 지난 세션을 못 읽으면 실패를 표시하고, 다시 시도(force)가 성공하면 지운다', async () => {
    let fail = true;
    api({
      '/api/chat/history': () =>
        fail ? new Response(JSON.stringify({ error: 'down' }), { status: 502 }) : { sessions: [{ id: 'st-1', source: 'aas', title: 'back', message_count: 2 }] },
    });
    const s = new ChatStore();
    await s.loadPast(undefined, 'ma');
    expect(s.pastError(undefined, 'ma')).toBe(true);
    expect(s.agentRows(undefined, 'ma')).toEqual([]);
    fail = false;
    await s.loadPast(undefined, 'ma'); // 60초 안이면 다시 묻지 않는다 — 실패도 그대로
    expect(s.pastError(undefined, 'ma')).toBe(true);
    await s.loadPast(undefined, 'ma', true);
    expect(s.pastError(undefined, 'ma')).toBe(false);
    expect(s.agentRows(undefined, 'ma').map((r) => r.id)).toEqual(['stored:st-1']);
  });

  it('G10: 안전 시한에 끝 번호까지 못 받으면 partial 을 남기고, 다시 불러오기는 처음부터 다시 받는다', async () => {
    vi.useFakeTimers();
    try {
      api({ '/api/chat/sessions': { sessions: [{ session_id: 'x9', pod: '', profile: 'ops', title: 'Earlier', stored_id: 'st9', state: 'idle', last_at: 1 }] },
        '/api/chat/resume': { session_id: 'x9', profile: 'ops', title: 'Earlier', reused: true, seq: 50 } });
      const s = new ChatStore();
      await s.preload();
      await s.loadSessions();
      await s.focus('x9');
      const S = s.sessions.x9;
      FakeES.all[0].emit('aas.user', { text: 'question' });
      vi.advanceTimersByTime(8000);
      expect(S.catchUp).toBeUndefined();
      expect(S.partial).toBe(50);
      s.reloadPartial(S);
      expect(FakeES.all[0].closed).toBe(true);
      expect(FakeES.all).toHaveLength(2);
      expect(FakeES.all[1].url).not.toContain('after='); // 처음부터
      expect(S.partial).toBeUndefined();
      expect(S.catchUp).toBe(50);
      expect(S.items).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('G10: 시한 안에 끝 번호에 닿으면 partial 이 없다', async () => {
    vi.useFakeTimers();
    try {
      api({ '/api/chat/sessions': { sessions: [{ session_id: 'x9', pod: '', profile: 'ops', title: 'Earlier', stored_id: 'st9', state: 'idle', last_at: 1 }] },
        '/api/chat/resume': { session_id: 'x9', profile: 'ops', title: 'Earlier', reused: true, seq: 1 } });
      const s = new ChatStore();
      await s.preload();
      await s.loadSessions();
      await s.focus('x9');
      FakeES.all[0].emit('aas.user', { text: 'question' });
      vi.advanceTimersByTime(8000);
      expect(s.sessions.x9.partial).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  // 앞 시험이 닫은 live-b 는 이 브라우저(localStorage)에 남아 있어 다른 id 를 쓴다
  const live = { sessions: [{ session_id: 'live-g11', profile: 'ma', title: 'done one', state: 'idle', last_at: 1, stored_id: 'st-g11' }], hidden: [] };
  const past = { sessions: [{ id: 'st-g11', source: 'aas', title: 'done one', message_count: 2 }, { id: 'st-c', source: 'aas', title: 'kept', message_count: 1 }] };

  it('G11: hideSoon 은 줄을 바로 빼고, 되돌리면 숨김 요청을 보내지 않고 줄을 되살린다', async () => {
    const a = api({ '/api/chat/sessions': live, '/api/chat/history': past });
    const s = new ChatStore();
    await s.loadSessions();
    await s.loadPast(undefined, 'ma', true);
    const h = s.hideSoon(['live-g11']);
    expect(s.sessionRows().map((r) => r.id)).toEqual([]);
    expect(s.agentRows(undefined, 'ma').map((r) => r.id)).toEqual(['stored:st-c']); // 같은 대화의 저장 줄도 완료에 나오지 않는다
    h.undo();
    h.commit(); // 알림이 닫히며 부르는 commit 은 되돌린 뒤라 아무 일도 하지 않는다
    expect(s.sessionRows().map((r) => r.id)).toEqual(['live-g11']);
    await Promise.resolve();
    expect(a.posted('/api/chat/sessions/hide')).toEqual([]);
  });

  it('G11: 알림이 닫히면(commit) 서버에 숨김을 남긴다', async () => {
    const a = api({ '/api/chat/sessions': live, '/api/chat/history': past });
    const s = new ChatStore();
    await s.loadSessions();
    const h = s.hideSoon(['live-g11']);
    expect(a.posted('/api/chat/sessions/hide')).toEqual([]);
    h.commit();
    expect(a.posted('/api/chat/sessions/hide')).toEqual([{ ids: ['live-g11'] }]);
    expect(s.sessionRows()).toEqual([]);
  });
});

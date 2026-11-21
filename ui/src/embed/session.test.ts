/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 토큰 교환·다시 교환·사용자 바뀜·원인 가리기(OMAI-1873)
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { apiConfig, resetApi } from '@/lib/api';
import type { ChatStore } from '@/lib/chatStore';
import type { WsClient } from '@/lib/ws';

import { certPromptAllowed, diagnoseNoResponse, POLL_MAX_TRIES, promptCertApproval, resetCertCheck } from './certHelper';
import { resolveConfig } from './config';
import { RETRY } from './EmbedApp';
import { classifyHttp, EmbedSession, LOGIN_WAIT_MS, POPUP_LOGIN_MAX_MS, POPUP_LOGIN_POLL_MS, type SessionDeps } from './session';
import { createWidgetStore } from './state';
import { decodeJwt, parseExpires, pickAssertion, protocolAccepts, REFRESH_BEFORE_MS, resolveAssertion } from './token';

const b64 = (o: object) => btoa(JSON.stringify(o)).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
const jwt = (claims: object) => `h.${b64(claims)}.s`;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const BASE = 'https://aas.example.com';

function fakes() {
  const chat = {
    status: null as null | { pod?: string },
    groups: [{ pod: 'pod-a', agents: [{ name: 'main' }] }],
    profile: '',
    openAgent: vi.fn(async function (this: { status: unknown }) {
      chat.status = { pod: 'pod-a' };
      chat.profile = 'main';
    }),
    resetAll: vi.fn(),
  };
  const ws = {
    state: 'off',
    pod: '',
    configure: vi.fn(),
    reconnect: vi.fn(),
    reauth: vi.fn(() => true),
    onState: vi.fn(() => () => undefined),
  };
  return { chat, ws };
}

function setup(fetchImpl: typeof fetch, cookie = { cookie: '' }, cfg: Record<string, unknown> = {}, extra: Partial<SessionDeps> = {}) {
  const { chat, ws } = fakes();
  const store = createWidgetStore(resolveConfig({ backendUrl: BASE, accessTokenCookie: 'TK', ...cfg }));
  const promptCert = vi.fn(async () => ({ approved: false }));
  const box = document.createElement('div');
  const s = new EmbedSession({
    store,
    chat: chat as unknown as ChatStore,
    ws: ws as unknown as WsClient,
    fetchImpl,
    doc: cookie,
    certContainer: () => box,
    promptCert,
    pageProtocol: () => 'https:',
    ...extra,
  });
  return { s, store, chat, ws, promptCert };
}

beforeEach(() => {
  resetCertCheck();
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  resetApi();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('신원 토큰 고르기', () => {
  it('쿠키와 accessToken 이 둘 다 있으면 exp 가 늦은 쪽을 쓴다', () => {
    const early = jwt({ exp: 100, sub: 'a' });
    const late = jwt({ exp: 200, sub: 'a' });
    expect(pickAssertion({ accessToken: late, accessTokenCookie: 'TK' }, { cookie: `TK=${early}` })).toBe(late);
    expect(pickAssertion({ accessToken: early, accessTokenCookie: 'TK' }, { cookie: `x=1; TK=${late}` })).toBe(late);
    expect(pickAssertion({ accessToken: 'opaque', accessTokenCookie: 'TK' }, { cookie: '' })).toBe('opaque');
    expect(decodeJwt(late)).toMatchObject({ exp: 200, sub: 'a' });
  });

  it('expires 는 초·밀리초·ISO 를 받고, 판 범위는 숫자·배열·객체·문자열을 받는다', () => {
    expect(parseExpires(1_800_000_000, 0)).toBe(1_800_000_000_000);
    expect(parseExpires('2026-11-09T00:00:00Z', 0)).toBe(Date.parse('2026-11-09T00:00:00Z'));
    expect(protocolAccepts(undefined)).toBe(true);
    expect(protocolAccepts(1)).toBe(true);
    expect(protocolAccepts([2, 3])).toBe(false);
    expect(protocolAccepts({ min: 1, max: 2 })).toBe(true);
    expect(protocolAccepts('2-4')).toBe(false);
  });
});

describe('토큰 교환과 요청 계층', () => {
  it('교환 응답으로 요청 계층에 Bearer·aasu·pod 를 넣고 웹소켓·대화를 연다', async () => {
    const fetchImpl = vi.fn(async () => json({ token: 'emb-1', expires: Date.now() + 15 * 60_000, sticky: 'stk', protocol: [1, 1], ws: true }));
    const { s, store, chat, ws } = setup(fetchImpl as unknown as typeof fetch, { cookie: `TK=${jwt({ sub: 'u1', exp: 9e9 })}` }, { agent: 'pod-a' });
    await s.start();
    await vi.waitFor(() => expect(store.get().status).toBe('ready'));
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${BASE}/api/embed/token`);
    expect(init).toMatchObject({ method: 'POST', credentials: 'omit' });
    expect(JSON.parse(String(init.body))).toMatchObject({ assertion: jwt({ sub: 'u1', exp: 9e9 }), protocol: 1 });
    const cfg = apiConfig();
    expect(cfg.baseUrl).toBe(BASE);
    expect(cfg.authHeader?.()).toBe('Bearer emb-1');
    expect(cfg.extraQuery?.()).toEqual({ aasu: 'stk', pod: 'pod-a' });
    expect(cfg.wsAuth?.()).toEqual({ token: 'emb-1', pod: 'pod-a' });
    expect(ws.configure).toHaveBeenCalledWith(true, 'pod-a');
    expect(chat.openAgent).toHaveBeenCalledWith('@primary', 'pod-a');
  });

  it('만료 1분 전에 다시 교환하고, 같은 사용자면 같은 웹소켓에 auth 를 다시 보낸다', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    let n = 0;
    const fetchImpl = vi.fn(async () => json({ token: `emb-${++n}`, expires: Date.now() + 10 * 60_000, sticky: 'stk', ws: true }));
    const { s, ws, chat } = setup(fetchImpl as unknown as typeof fetch, { cookie: `TK=${jwt({ sub: 'u1' })}` });
    await s.start();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10 * 60_000 - REFRESH_BEFORE_MS - 1000);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2000);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(s.tokens.token).toBe('emb-2');
    expect(ws.reauth).toHaveBeenCalled();
    expect(chat.resetAll).not.toHaveBeenCalled();
    s.destroy();
  });

  it('getAccessToken 이 있으면 교환할 때마다 새 신원 토큰을 받아 보낸다(host-signed 는 한 번 쓴 토큰을 다시 받지 않는다)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    let n = 0;
    const fetchImpl = vi.fn(async () => json({ token: `emb-${n}`, expires: Date.now() + 15 * 60_000, sticky: 'stk', ws: true }));
    const getAccessToken = vi.fn(async () => jwt({ sub: 'u1', jti: `j${++n}` }));
    // 설정의 accessToken(처음 한 장)이 있어도 콜백이 먼저다 — 예전에는 이 한 장을 다시 보내 약 14분 뒤 401 이었다
    const { s } = setup(fetchImpl as unknown as typeof fetch, { cookie: '' }, { accessToken: jwt({ sub: 'u1', jti: 'first' }), getAccessToken });
    await s.start();
    await vi.advanceTimersByTimeAsync(15 * 60_000);
    expect(getAccessToken).toHaveBeenCalledTimes(2);
    const sent = fetchImpl.mock.calls.map((c) => JSON.parse(String((c as unknown as [string, RequestInit])[1].body)).assertion as string);
    expect(sent).toHaveLength(2);
    expect(sent[0]).not.toBe(sent[1]);
    expect(sent.every((a) => (decodeJwt(a) as { jti?: string } | null)?.jti !== 'first')).toBe(true);
    s.destroy();
  });

  it('쿠키의 토큰이 다른 사용자(sub)로 바뀌면 다시 교환하고 열린 대화를 닫은 뒤 새로 연다', async () => {
    const cookie = { cookie: `TK=${jwt({ sub: 'u1' })}` };
    let n = 0;
    const fetchImpl = vi.fn(async () => json({ token: `emb-${++n}`, expires: Date.now() + 15 * 60_000, sticky: 'stk', ws: true }));
    const { s, store, chat, ws } = setup(fetchImpl as unknown as typeof fetch, cookie);
    await s.start();
    expect(s.tokens.checkCookie()).toBe(false); // 같은 쿠키 — 다시 교환하지 않는다
    cookie.cookie = `TK=${jwt({ sub: 'u2' })}`;
    expect(s.tokens.checkCookie()).toBe(true);
    await vi.waitFor(() => expect(chat.resetAll).toHaveBeenCalledTimes(1));
    expect(store.get().notice).toBe('userChanged');
    expect(ws.reconnect).toHaveBeenCalledTimes(2);
    expect(chat.openAgent).toHaveBeenCalledTimes(2);
    s.destroy();
  });

  it('AI 에이전트 작업공간이 없는 사용자는 대화 대신 「AI 에이전트 없음」을 보인다(오류 묶음은 pod 가 없다)', async () => {
    const ok = () => json({ token: 't', expires: Date.now() + 15 * 60_000, sticky: 'stk', ws: true });
    // 서버가 「연결된 AI 에이전트 작업공간이 없습니다」를 pod 없는 오류 묶음으로 준 경우(OKE keycloak 모드에서 대화가 그대로 떴다)
    const a = setup(vi.fn(async () => ok()) as unknown as typeof fetch, { cookie: 'TK=x' });
    a.chat.groups = [{ error: 'no workspace', agents: [{ name: 'default' }] } as never];
    a.chat.openAgent.mockImplementation(async () => {
      a.chat.status = {};
      a.chat.profile = 'default';
    });
    await a.s.start();
    await vi.waitFor(() => expect(a.store.get().status).toBe('no_agent'));
    // 작업공간은 있으나 멈춤 등 오류가 있으면 지금처럼 대화 화면(그 안의 안내)을 보인다
    const b = setup(vi.fn(async () => ok()) as unknown as typeof fetch, { cookie: 'TK=x' });
    b.chat.groups = [{ pod: 'pod-a', error: 'stopped', agents: [] } as never];
    await b.s.start();
    await vi.waitFor(() => expect(b.store.get().status).toBe('ready'));
    // 교환 응답의 agent(앱에 등록한 기본 AI 에이전트)를 처음 고를 값으로 쓴다
    const c = setup(vi.fn(async () => json({ token: 't', ws: true, agent: 'pod-a' })) as unknown as typeof fetch, { cookie: 'TK=x' });
    await c.s.start();
    await vi.waitFor(() => expect(c.chat.openAgent).toHaveBeenCalledWith('@primary', 'pod-a'));
    expect(c.ws.configure).toHaveBeenCalledWith(true, 'pod-a');
  });

  it('401 이면 한 번 다시 교환하고, 그것도 401 이면 로그인 안내를 보인다', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(json({ token: 'emb-1', expires: Date.now() + 15 * 60_000, ws: true }))
      .mockResolvedValueOnce(json({ code: 'token_invalid' }, 401));
    const { s, store } = setup(fetchImpl as unknown as typeof fetch, { cookie: `TK=${jwt({ sub: 'u1' })}` });
    await s.start();
    apiConfig().onUnauthorized?.();
    await vi.waitFor(() => expect(store.get().status).toBe('login'));
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(console.error).toHaveBeenCalledWith(expect.stringMatching(/^\[CogentAIAASWidget\] token_invalid /));
  });

  it('ws:false 면 「위젯 연결을 지원하지 않습니다」, 판 범위 밖이면 판 안내를 보이고 연결하지 않는다', async () => {
    const a = setup(vi.fn(async () => json({ token: 't', ws: false })) as unknown as typeof fetch, { cookie: 'TK=x' });
    await a.s.start();
    expect(a.store.get().status).toBe('ws_off');
    expect(a.ws.configure).not.toHaveBeenCalled();
    const b = setup(vi.fn(async () => json({ token: 't', ws: true, protocol: [2, 3] })) as unknown as typeof fetch, { cookie: 'TK=x' });
    await b.s.start();
    expect(b.store.get().status).toBe('version');
    expect(b.chat.openAgent).not.toHaveBeenCalled();
  });

  it('destroy·resetUserSession 은 임베드 토큰을 revoke 한다', async () => {
    const fetchImpl = vi.fn(async (url: string) => (url.endsWith('/revoke') ? json({}) : json({ token: 'emb-1', ws: true })));
    const { s } = setup(fetchImpl as unknown as typeof fetch, { cookie: 'TK=x' });
    await s.start();
    await s.resetUserSession();
    s.destroy();
    const revokes = fetchImpl.mock.calls.filter((c) => String(c[0]).endsWith('/api/embed/token/revoke')) as unknown as [string, RequestInit][];
    expect(revokes).toHaveLength(2);
    expect(revokes[0][1].headers).toMatchObject({ Authorization: 'Bearer emb-1' });
    expect(apiConfig().baseUrl).toBe(''); // destroy 는 요청 계층을 기본값으로 되돌린다
  });

  it('https 화면에서 http backendUrl 은 혼합 콘텐츠 안내를 보이고 교환하지 않는다', async () => {
    const fetchImpl = vi.fn();
    const { s, store } = setup(fetchImpl as unknown as typeof fetch, { cookie: 'TK=x' }, { backendUrl: 'http://aas.example.com' });
    await s.start();
    expect(store.get().status).toBe('mixed');
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith(expect.stringMatching(/mixed_content/));
  });
});

describe('원인 가리기와 인증서 안내', () => {
  const failExchange = (healthz: 'ok' | 'fail') =>
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/healthz')) {
        expect(init?.mode).toBe('no-cors');
        if (healthz === 'fail') throw new TypeError('Failed to fetch');
        return new Response(null, { status: 200 });
      }
      throw new TypeError('Failed to fetch');
    });

  it('교환에 응답이 없고 no-cors /healthz 도 실패하면(인증서) 안내 창을 띄운다', async () => {
    const { s, store, promptCert } = setup(failExchange('fail') as unknown as typeof fetch, { cookie: 'TK=x' });
    await s.start();
    expect(promptCert).toHaveBeenCalledWith(BASE, expect.any(HTMLElement));
    expect(store.get().status).toBe('cert');
    expect(console.error).toHaveBeenCalledWith(expect.stringMatching(/cert_required/));
  });

  it('안내 창을 취소한 뒤 다시 시도(connect)하면 안내 창을 다시 띄운다 — 상태 패널의 cert 다시 시도 버튼', async () => {
    const { s, store, promptCert } = setup(failExchange('fail') as unknown as typeof fetch, { cookie: 'TK=x' });
    await s.start();
    expect(promptCert).toHaveBeenCalledTimes(1);
    await s.connect();
    expect(promptCert).toHaveBeenCalledTimes(2);
    expect(store.get().status).toBe('cert');
    expect(RETRY).toContain('cert');
  });

  it('no-cors /healthz 는 되면(사전 요청·출처 설정) 인증서 안내가 아니라 연결 설정 안내를 보인다', async () => {
    const { s, store, promptCert } = setup(failExchange('ok') as unknown as typeof fetch, { cookie: 'TK=x' });
    await s.start();
    expect(promptCert).not.toHaveBeenCalled();
    expect(store.get().status).toBe('connect_check');
  });

  it('403 origin_not_registered 는 인증서 안내가 아니라 「등록되지 않았습니다」를 보인다', async () => {
    const fetchImpl = vi.fn(async () => json({ code: 'origin_not_registered' }, 403));
    const { s, store, promptCert } = setup(fetchImpl as unknown as typeof fetch, { cookie: 'TK=x' });
    await s.start();
    expect(promptCert).not.toHaveBeenCalled();
    expect(store.get().status).toBe('origin');
    expect(console.error).toHaveBeenCalledWith(expect.stringMatching(/^\[CogentAIAASWidget\] origin_not_registered /));
  });

  it('서버 오류 본문({error: 코드})과 epoch 초 expires·{min,max} protocol 을 읽는다', async () => {
    const ok = setup(vi.fn(async () => json({ token: 'aas_emb_1', expires: 1_900_000_000, sticky: '0123456789abcdef', protocol: { min: 1, max: 1 }, ws: true })) as unknown as typeof fetch, { cookie: 'TK=x' });
    await ok.s.start();
    expect(ok.s.tokens.current).toMatchObject({ expiresAt: 1_900_000_000_000, sticky: '0123456789abcdef' });
    const bad = setup(vi.fn(async () => json({ error: 'user_unknown', message: 'no' }, 403)) as unknown as typeof fetch, { cookie: 'TK=x' });
    await bad.s.start();
    expect(bad.store.get().status).toBe('not_user');
    ok.s.destroy();
  });

  it('웹소켓이 4401 user_changed 로 닫히면 대화를 닫고 처음부터 다시 교환해 연다', async () => {
    let n = 0;
    const fetchImpl = vi.fn(async () => json({ token: `emb-${++n}`, ws: true }));
    const { s, store, chat } = setup(fetchImpl as unknown as typeof fetch, { cookie: 'TK=x' });
    await s.start();
    apiConfig().onWsClose?.(4401, 'user_changed', true);
    await vi.waitFor(() => expect(chat.openAgent).toHaveBeenCalledTimes(2));
    expect(chat.resetAll).toHaveBeenCalledTimes(1);
    expect(store.get().notice).toBe('userChanged');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    s.destroy();
  });

  it('교환 실패 코드를 상태 표의 칸으로 바꾼다', () => {
    expect(classifyHttp(403, 'auth_disabled').status).toBe('connect_check');
    expect(classifyHttp(403, 'user_unknown').status).toBe('not_user');
    expect(classifyHttp(503, 'idp_unreachable').status).toBe('idp');
    expect(classifyHttp(429, '').status).toBe('rate_limited');
    expect(classifyHttp(401, 'token_invalid').status).toBe('login');
  });

  it('http 주소는 no-cors 실패를 인증서가 아니라 네트워크 문제로 본다', async () => {
    const f = vi.fn(async () => {
      throw new TypeError('x');
    });
    expect(await diagnoseNoResponse('http://aas', f as unknown as typeof fetch)).toBe('unreachable');
    expect(await diagnoseNoResponse('https://aas', f as unknown as typeof fetch)).toBe('cert');
  });

  it('안내 창: 단추를 누른 순간 /embed/cert 새 창을 열고, no-cors /healthz 가 되면 창을 닫고 승인한다. 페이지마다 한 번', async () => {
    vi.useFakeTimers();
    const box = document.createElement('div');
    document.body.appendChild(box);
    const win = { closed: false, close: vi.fn() };
    const openWindow = vi.fn(() => win as unknown as Window);
    let up = false;
    const fetchImpl = vi.fn(async () => {
      if (!up) throw new TypeError('x');
      return new Response(null);
    });
    const p = promptCertApproval(BASE, box, { fetchImpl: fetchImpl as unknown as typeof fetch, openWindow });
    expect(box.querySelector('[data-testid="aas-cert-modal"]')).not.toBeNull();
    expect(certPromptAllowed()).toBe(false); // 떠 있는 동안 또 띄우지 않는다
    expect(openWindow).not.toHaveBeenCalled();
    (box.querySelectorAll('button')[1] as HTMLButtonElement).click();
    expect(openWindow).toHaveBeenCalledWith(`${BASE}/embed/cert`, '_blank', expect.stringContaining('width=700'));
    await vi.advanceTimersByTimeAsync(500); // 첫 시도 0.5초
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(750); // 1.5배
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    up = true;
    await vi.advanceTimersByTimeAsync(1125);
    await vi.advanceTimersByTimeAsync(800);
    await expect(p).resolves.toEqual({ approved: true });
    expect(win.close).toHaveBeenCalled();
    expect(box.querySelector('[data-testid="aas-cert-modal"]')).toBeNull();
    expect(certPromptAllowed()).toBe(false); // 페이지마다 한 번
    resetCertCheck();
    expect(certPromptAllowed()).toBe(true);
    box.remove();
    expect(POLL_MAX_TRIES).toBe(40);
  });
});

describe('resolveAssertion', () => {
  it('getAccessToken 값을 쓰고, 빈 값·실패·시간 초과면 쿠키·accessToken 으로 넘어간다', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const doc = { cookie: 'TK=from-cookie' };
    expect(await resolveAssertion({ getAccessToken: () => ' fresh ', accessToken: 'given' }, doc)).toBe('fresh');
    expect(await resolveAssertion({ getAccessToken: async () => '', accessToken: 'given' }, doc)).toBe('given');
    expect(await resolveAssertion({ getAccessToken: () => { throw new Error('boom'); }, accessTokenCookie: 'TK' }, doc)).toBe('from-cookie');
    expect(await resolveAssertion({ getAccessToken: () => new Promise<string>(() => {}), accessToken: 'given' }, doc, 20)).toBe('given');
    expect(await resolveAssertion({ accessToken: 'given' }, doc)).toBe('given');
    expect(warn).toHaveBeenCalledTimes(2);
    expect(String(warn.mock.calls[0][0])).toContain('[CogentAIAASWidget] get_access_token');
    warn.mockRestore();
  });
});

describe('로그인 필요 상태의 「로그인」(onLoginRequired, OMAI-1908)', () => {
  // 신원 토큰이 없어도 교환을 보낸다(OMAI-1911) — 빈 assertion 은 서버가 401 token_invalid 로 답한다
  const ok = () =>
    vi.fn(async (_u: string, init?: RequestInit) =>
      JSON.parse(String(init?.body ?? '{}')).assertion
        ? json({ token: 'emb-1', expires: Date.now() + 15 * 60_000, sticky: 'stk', ws: true })
        : json({ error: 'token_invalid', popup_login: false }, 401)
    );

  it('콜백을 첫 await 전에 동기로 부르고(팝업 차단을 피한다), 콜백이 끝나면 다시 교환해 대화를 연다', async () => {
    const fetchImpl = ok();
    const doc = { cookie: '' };
    let done!: () => void;
    const onLoginRequired = vi.fn(() => new Promise<void>((r) => (done = r)));
    const { s, store } = setup(fetchImpl as unknown as typeof fetch, doc, { onLoginRequired });
    await s.start();
    expect(store.get().status).toBe('login');
    expect(fetchImpl).toHaveBeenCalledTimes(1); // 빈 assertion 교환 → 401
    const p = s.login();
    expect(onLoginRequired).toHaveBeenCalledTimes(1); // 같은 틱 안에서 불렸다
    expect(fetchImpl).toHaveBeenCalledTimes(1); // 콜백이 끝나기 전에는 교환하지 않는다
    doc.cookie = `TK=${jwt({ sub: 'u1', exp: 9e9 })}`; // 호스트 팝업이 로그인을 마치고 쿠키를 갱신했다
    done();
    await p;
    await vi.waitFor(() => expect(store.get().status).toBe('ready'));
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('콜백이 실패하면 login_callback_failed 를 남기고 그래도 다시 교환한다(토큰이 없으면 login 에 남는다)', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    for (const onLoginRequired of [vi.fn(async () => Promise.reject(new Error('closed'))), vi.fn(() => { throw new Error('blocked'); })]) {
      const { s, store } = setup(ok() as unknown as typeof fetch, { cookie: '' }, { onLoginRequired });
      await s.start();
      err.mockClear();
      await s.login();
      expect(onLoginRequired).toHaveBeenCalledTimes(1);
      expect(err.mock.calls.some((c) => String(c[0]).includes('[CogentAIAASWidget] login_callback_failed'))).toBe(true);
      expect(err.mock.calls.some((c) => String(c[0]).includes('token_invalid'))).toBe(true); // 다시 교환을 시도했다
      expect(store.get().status).toBe('login');
    }
  });

  it('콜백을 기다리는 사이 다른 경로(쿠키 폴링·updateConfig)로 먼저 ready 가 되면, 콜백이 끝나도 다시 교환하지 않는다(대화창을 내리지 않는다)', async () => {
    const fetchImpl = ok();
    const doc = { cookie: '' };
    let done!: () => void;
    const { s, store } = setup(fetchImpl as unknown as typeof fetch, doc, { onLoginRequired: () => new Promise<void>((r) => (done = r)) });
    await s.start();
    const p = s.login();
    doc.cookie = `TK=${jwt({ sub: 'u1', exp: 9e9 })}`;
    await s.connect(); // 쿠키 폴링이 먼저 성공한 것과 같다
    await vi.waitFor(() => expect(store.get().status).toBe('ready'));
    const seen: string[] = [];
    store.subscribe(() => seen.push(store.get().status));
    done();
    await p;
    expect(seen).not.toContain('connecting');
    expect(store.get().status).toBe('ready');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('진행 중에 다시 부르면 같은 시도를 돌려주고 콜백은 한 번만 부른다', async () => {
    let done!: () => void;
    const onLoginRequired = vi.fn(() => new Promise<void>((r) => (done = r)));
    const { s } = setup(ok() as unknown as typeof fetch, { cookie: '' }, { onLoginRequired });
    await s.start();
    const a = s.login();
    const b = s.login();
    expect(b).toBe(a);
    expect(onLoginRequired).toHaveBeenCalledTimes(1);
    done();
    await a;
    void s.login(); // 끝난 뒤에는 새로 시도한다
    expect(onLoginRequired).toHaveBeenCalledTimes(2);
  });

  it('콜백을 기다리는 도중 위젯이 해제되면 다시 교환하지 않는다', async () => {
    const fetchImpl = ok();
    let done!: () => void;
    const { s } = setup(fetchImpl as unknown as typeof fetch, { cookie: '' }, { onLoginRequired: () => new Promise<void>((r) => (done = r)) });
    await s.start();
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const p = s.login();
    s.destroy();
    err.mockClear();
    done();
    await p;
    expect(fetchImpl).toHaveBeenCalledTimes(1); // start 의 교환 하나뿐이다
    expect(err.mock.calls.some((c) => String(c[0]).includes('token_invalid'))).toBe(false); // 교환을 시도하지 않았다
  });

  it('콜백이 10분 안에 끝나지 않으면 login_callback_timeout 을 남기고 다시 교환한다', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { s, store } = setup(ok() as unknown as typeof fetch, { cookie: '' }, { onLoginRequired: () => new Promise<void>(() => undefined) });
    await s.start();
    err.mockClear();
    const p = s.login();
    await vi.advanceTimersByTimeAsync(LOGIN_WAIT_MS);
    await p;
    expect(err.mock.calls.some((c) => String(c[0]).includes('login_callback_timeout'))).toBe(true);
    expect(err.mock.calls.some((c) => String(c[0]).includes('token_invalid'))).toBe(true); // 다시 교환을 시도했다
    expect(store.get().status).toBe('login');
  });

  it('콜백을 기다리는 사이 서버 주소가 바뀌어 세션이 다시 시작되면, 옛 시도는 다시 교환하지 않는다', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    let done!: () => void;
    const { s } = setup(ok() as unknown as typeof fetch, { cookie: '' }, { onLoginRequired: () => new Promise<void>((r) => (done = r)) });
    await s.start();
    const p = s.login();
    s.destroy(); // updateConfig({ backendUrl }) 와 같은 순서: destroy → start
    await s.start();
    err.mockClear();
    done();
    await p;
    expect(err.mock.calls.some((c) => String(c[0]).includes('token_invalid'))).toBe(false);
  });

  it('콜백이 없으면 다시 교환만 한다', async () => {
    const fetchImpl = ok();
    const doc = { cookie: '' };
    const { s, store } = setup(fetchImpl as unknown as typeof fetch, doc);
    await s.start();
    doc.cookie = `TK=${jwt({ sub: 'u1', exp: 9e9 })}`;
    await s.login();
    await vi.waitFor(() => expect(store.get().status).toBe('ready'));
  });
});


describe('401 의 두 갈래와 실패 처리(OMAI-1908)', () => {
  it('401 token_mismatch 는 로그인이 아니라 설정 불일치 상태다(「로그인」을 보이지 않는다)', async () => {
    expect(classifyHttp(401, 'token_mismatch')).toEqual({ status: 'auth_config', log: 'token_mismatch' });
    expect(classifyHttp(401, 'token_invalid').status).toBe('login');
    expect(classifyHttp(401, '').status).toBe('login'); // 옛 서버는 코드를 나누지 않는다
    expect(RETRY).toContain('auth_config');
    const fetchImpl = vi.fn(async () => json({ error: 'token_mismatch', message: 'aud' }, 401));
    const { s, store } = setup(fetchImpl as unknown as typeof fetch, { cookie: `TK=${jwt({ sub: 'u1', exp: 9e9 })}` });
    await s.start();
    expect(store.get().status).toBe('auth_config');
  });

  it('REST 401 의 다시 교환과 connect 가 겹쳐도 같은 실패를 콘솔에 한 줄만 남긴다', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const fetchImpl = vi.fn(async () => {
      await gate;
      return json({ error: 'token_invalid' }, 401);
    });
    const { s, store } = setup(fetchImpl as unknown as typeof fetch, { cookie: `TK=${jwt({ sub: 'u1', exp: 9e9 })}` });
    const started = s.start();
    const again = s.onUnauthorized(); // 같은 교환을 기다린다
    release();
    await Promise.all([started, again]);
    expect(err.mock.calls.filter((c) => String(c[0]).includes('token_invalid')).length).toBe(1);
    expect(store.get().status).toBe('login');
  });

  it('실패 처리 안의 예외(인증서 안내 창 오류)는 connect 밖으로 거부되지 않는다', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    });
    const { s, promptCert } = setup(fetchImpl as unknown as typeof fetch, { cookie: 'TK=x' });
    promptCert.mockRejectedValueOnce(new Error('dialog broke'));
    await expect(s.start()).resolves.toBeUndefined();
    expect(err.mock.calls.some((c) => String(c[0]).includes('internal_error'))).toBe(true);
  });
});

describe('내장 팝업 로그인(OMAI-1911)', () => {
  const B64URL = /^[A-Za-z0-9_-]{43}$/;
  type Body = Record<string, unknown>;
  type Handler = (b: Body) => Response | Promise<Response>;
  /** 신원 토큰이 없으면 401 + popup_login, login·refresh 는 handler 가 답한다 */
  const server = (onLogin: Handler, onRefresh: Handler = () => json({ error: 'token_invalid', popup_login: true }, 401)) =>
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/revoke')) return json({});
      const b = JSON.parse(String(init?.body ?? '{}')) as Body;
      if ('login' in b) return onLogin(b);
      if ('refresh' in b) return onRefresh(b);
      return b.assertion ? json({ token: 'emb-host', expires: Date.now() + 15 * 60_000, sticky: 'stk', ws: true }) : json({ error: 'token_invalid', popup_login: true }, 401);
    });
  const granted = (over: Body = {}) => json({ token: 'emb-1', expires: Date.now() + 15 * 60_000, sticky: 'stk', ws: true, refresh: true, email: 'u1@example.com', ...over });

  function popupSetup(fetchImpl: ReturnType<typeof server>, cfg: Record<string, unknown> = {}, doc = { cookie: '' }) {
    const listeners = new Set<(e: MessageEvent) => void>();
    const messageTarget = {
      addEventListener: vi.fn((_t: string, fn: (e: MessageEvent) => void) => void listeners.add(fn)),
      removeEventListener: vi.fn((_t: string, fn: (e: MessageEvent) => void) => void listeners.delete(fn)),
    };
    const win = { closed: false, close: vi.fn(), postMessage: vi.fn() };
    const openWindow = vi.fn((..._a: string[]) => win as unknown as Window);
    const r = setup(fetchImpl as unknown as typeof fetch, doc, cfg, { openWindow, messageTarget: messageTarget as unknown as SessionDeps['messageTarget'] });
    const send = (data: unknown, origin = BASE, source: unknown = win) => listeners.forEach((fn) => fn({ data, origin, source } as unknown as MessageEvent));
    const nonceOf = (i = 0) => new URL(String(openWindow.mock.calls[i][0])).searchParams.get('n')!;
    const bodies = () => fetchImpl.mock.calls.map((c) => JSON.parse(String((c as unknown as [string, RequestInit])[1]?.body ?? '{}')) as Body);
    return { ...r, listeners, messageTarget, win, openWindow, send, nonceOf, bodies };
  }

  it('신원 토큰이 없어도 빈 assertion 으로 교환을 보내고, 401 의 popup_login 을 상태에 둔다', async () => {
    const fetchImpl = server(() => json({ pending: true }, 202));
    const { s, store, bodies } = popupSetup(fetchImpl);
    await s.start();
    expect(bodies()[0]).toMatchObject({ assertion: '', protocol: 1 });
    expect(store.get().status).toBe('login');
    expect(store.get().popupLogin).toBe(true);
    expect(console.error).toHaveBeenCalledWith(expect.stringMatching(/^\[CogentAIAASWidget\] token_invalid /));
    expect(console.error).not.toHaveBeenCalledWith(expect.stringMatching(/no_token/));
  });

  it('「로그인」을 누른 같은 틱에 /embed/login 팝업을 연다(nonce 는 base64url 43자)', async () => {
    const { s, openWindow, messageTarget, nonceOf } = popupSetup(server(() => json({ pending: true }, 202)));
    await s.start();
    void s.login();
    expect(openWindow).toHaveBeenCalledTimes(1); // 첫 await 전에 열었다
    const [url, name, features] = openWindow.mock.calls[0];
    expect(url).toBe(`${BASE}/embed/login?o=${encodeURIComponent(location.origin)}&n=${nonceOf()}`);
    expect(nonceOf()).toMatch(B64URL);
    expect(name).toBe('aas-embed-login');
    expect(features).toBe('width=520,height=700');
    expect(messageTarget.addEventListener).toHaveBeenCalledWith('message', expect.any(Function));
    s.destroy();
  });

  it('popup_login 이 거짓이고 콜백이 없으면 팝업을 열지 않고 다시 교환만 한다', async () => {
    const fetchImpl = vi.fn(async () => json({ error: 'token_invalid', popup_login: false }, 401));
    const { s, store, openWindow } = popupSetup(fetchImpl as unknown as ReturnType<typeof server>);
    await s.start();
    expect(store.get().popupLogin).toBe(false);
    await s.login();
    expect(openWindow).not.toHaveBeenCalled();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('onLoginRequired 가 있으면 popup_login 이어도 콜백이 먼저다(팝업을 열지 않는다)', async () => {
    const onLoginRequired = vi.fn(async () => undefined);
    const { s, openWindow } = popupSetup(server(() => json({ pending: true }, 202)), { onLoginRequired });
    await s.start();
    await s.login();
    expect(onLoginRequired).toHaveBeenCalledTimes(1);
    expect(openWindow).not.toHaveBeenCalled();
  });

  it('다른 출처·다른 nonce 의 message 는 무시하고, 맞을 때만 e.source 에 verifier 를 AAS 출처로 답한다', async () => {
    const { s, send, win, nonceOf } = popupSetup(server(() => json({ pending: true }, 202)));
    await s.start();
    void s.login();
    const nonce = nonceOf();
    send({ aasEmbedLogin: nonce }, 'https://evil.example.com');
    send({ aasEmbedLogin: 'other' });
    send('hello');
    expect(win.postMessage).not.toHaveBeenCalled();
    send({ aasEmbedLogin: nonce });
    expect(win.postMessage).toHaveBeenCalledTimes(1);
    const [msg, target] = win.postMessage.mock.calls[0] as unknown as [{ aasEmbedLogin: string; verifier: string }, string];
    expect(target).toBe(new URL(BASE).origin);
    expect(msg.aasEmbedLogin).toBe(nonce);
    expect(msg.verifier).toMatch(B64URL);
    expect(msg.verifier).not.toBe(nonce);
    s.destroy();
  });

  it('2초마다 {login, verifier} 로 묻고, 202 를 지나 200 이면 대화를 열고 리스너를 지운다', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    let n = 0;
    const fetchImpl = server(() => (++n < 3 ? json({ pending: true }, 202) : granted()));
    const { s, store, send, win, nonceOf, bodies, listeners, chat } = popupSetup(fetchImpl);
    await s.start();
    const p = s.login();
    send({ aasEmbedLogin: nonceOf() });
    const verifier = (win.postMessage.mock.calls[0] as unknown as [{ verifier: string }])[0].verifier;
    await vi.advanceTimersByTimeAsync(POPUP_LOGIN_POLL_MS - 1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(bodies()[1]).toMatchObject({ login: nonceOf(), verifier });
    await vi.advanceTimersByTimeAsync(POPUP_LOGIN_POLL_MS * 2);
    await p;
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    await vi.waitFor(() => expect(store.get().status).toBe('ready'));
    expect(chat.openAgent).toHaveBeenCalled();
    expect(s.tokens.token).toBe('emb-1');
    expect(listeners.size).toBe(0);
    await vi.advanceTimersByTimeAsync(POPUP_LOGIN_POLL_MS * 3);
    expect(fetchImpl).toHaveBeenCalledTimes(4); // 더 묻지 않는다
    s.destroy();
  });

  it('5분 안에 승인되지 않으면 login_expired 를 남기고 멈춘다(popup.closed 는 보지 않는다)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    const fetchImpl = server(() => json({ pending: true }, 202));
    const { s, store, win, listeners } = popupSetup(fetchImpl);
    await s.start();
    const p = s.login();
    win.closed = true; // 창이 닫혀도 계속 묻는다 — 팝업이 opener 를 잃은 경우와 구분하지 않는다
    await vi.advanceTimersByTimeAsync(POPUP_LOGIN_POLL_MS * 3);
    expect(fetchImpl.mock.calls.length).toBeGreaterThan(2);
    await vi.advanceTimersByTimeAsync(POPUP_LOGIN_MAX_MS);
    await p;
    const calls = fetchImpl.mock.calls.length;
    expect(calls).toBeLessThanOrEqual(1 + POPUP_LOGIN_MAX_MS / POPUP_LOGIN_POLL_MS);
    await vi.advanceTimersByTimeAsync(POPUP_LOGIN_POLL_MS * 5);
    expect(fetchImpl).toHaveBeenCalledTimes(calls);
    expect(console.error).toHaveBeenCalledWith(expect.stringMatching(/^\[CogentAIAASWidget\] login_expired /));
    expect(store.get().status).toBe('login');
    expect(listeners.size).toBe(0);
  });

  it('묻는 중 401 이면 멈추고 로그인 필요 상태로 둔다', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    const fetchImpl = server(() => json({ error: 'token_invalid', popup_login: true }, 401));
    const { s, store, listeners } = popupSetup(fetchImpl);
    await s.start();
    const p = s.login();
    await vi.advanceTimersByTimeAsync(POPUP_LOGIN_POLL_MS);
    await p;
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(POPUP_LOGIN_POLL_MS * 3);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(store.get().status).toBe('login');
    expect(store.get().popupLogin).toBe(true);
    expect(listeners.size).toBe(0);
  });

  it('창이 열리지 않으면 login_popup_blocked 를 남기고 묻지 않는다', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    const fetchImpl = server(() => json({ pending: true }, 202));
    const { s, openWindow, listeners } = popupSetup(fetchImpl);
    openWindow.mockReturnValue(null as unknown as Window);
    await s.start();
    await s.login();
    await vi.advanceTimersByTimeAsync(POPUP_LOGIN_POLL_MS * 3);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(listeners.size).toBe(0);
    expect(console.error).toHaveBeenCalledWith(expect.stringMatching(/^\[CogentAIAASWidget\] login_popup_blocked /));
  });

  it('destroy·서버 주소 변경(destroy → start)이면 묻기를 끊고 리스너를 지운다', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    for (const restart of [false, true]) {
      const fetchImpl = server(() => json({ pending: true }, 202));
      const { s, listeners, messageTarget } = popupSetup(fetchImpl);
      await s.start();
      const p = s.login();
      await vi.advanceTimersByTimeAsync(POPUP_LOGIN_POLL_MS);
      expect(fetchImpl).toHaveBeenCalledTimes(2);
      s.destroy();
      if (restart) await s.start();
      await p; // 기다리던 「로그인」도 끝난다
      const calls = fetchImpl.mock.calls.length;
      await vi.advanceTimersByTimeAsync(POPUP_LOGIN_POLL_MS * 3);
      expect(fetchImpl.mock.calls.filter((c) => 'login' in JSON.parse(String((c as unknown as [string, RequestInit])[1]?.body ?? '{}')))).toHaveLength(1);
      expect(fetchImpl).toHaveBeenCalledTimes(calls);
      expect(listeners.size).toBe(0);
      expect(messageTarget.removeEventListener).toHaveBeenCalled();
      s.destroy();
    }
  });

  it('팝업으로 받은 토큰(refresh: true)은 만료 1분 전에 {refresh, verifier} 로 갱신하고, 401 이면 「로그인」으로 돌아간다', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    let r = 0;
    const fetchImpl = server(
      () => granted({ expires: Date.now() + 10 * 60_000 }),
      () => (++r === 1 ? json({ token: 'emb-2', expires: Date.now() + 10 * 60_000, sticky: 'stk', ws: true, refresh: true }) : json({ error: 'token_invalid', popup_login: true }, 401))
    );
    const { s, store, send, win, nonceOf, bodies, ws } = popupSetup(fetchImpl);
    await s.start();
    const p = s.login();
    send({ aasEmbedLogin: nonceOf() });
    const verifier = (win.postMessage.mock.calls[0] as unknown as [{ verifier: string }])[0].verifier;
    await vi.advanceTimersByTimeAsync(POPUP_LOGIN_POLL_MS);
    await p;
    await vi.waitFor(() => expect(store.get().status).toBe('ready'));
    await vi.advanceTimersByTimeAsync(10 * 60_000 - REFRESH_BEFORE_MS);
    expect(bodies()[2]).toEqual(expect.objectContaining({ refresh: 'emb-1', verifier }));
    expect(bodies()[2]).not.toHaveProperty('assertion');
    expect(s.tokens.token).toBe('emb-2');
    expect(ws.reauth).toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(10 * 60_000 - REFRESH_BEFORE_MS);
    expect(bodies()[3]).toEqual(expect.objectContaining({ refresh: 'emb-2', verifier }));
    await vi.waitFor(() => expect(store.get().status).toBe('login'));
    expect(store.get().popupLogin).toBe(true);
    s.destroy();
  });

  it('신원 토큰(assertion)이 생기면 팝업 토큰이어도 assertion 교환이 먼저다', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    const doc = { cookie: '' };
    const fetchImpl = server(() => granted({ expires: Date.now() + 10 * 60_000 }));
    const { s, store, bodies } = popupSetup(fetchImpl, {}, doc);
    await s.start();
    const p = s.login();
    await vi.advanceTimersByTimeAsync(POPUP_LOGIN_POLL_MS);
    await p;
    await vi.waitFor(() => expect(store.get().status).toBe('ready'));
    doc.cookie = `TK=${jwt({ sub: 'u1', exp: 9e9 })}`;
    await s.tokens.refresh();
    expect(bodies()[2]).toMatchObject({ assertion: jwt({ sub: 'u1', exp: 9e9 }) });
    expect(bodies()[2]).not.toHaveProperty('refresh');
    s.destroy();
  });

  it('위젯 둘(탭 둘)은 서로 다른 nonce·verifier 를 쓴다', async () => {
    const a = popupSetup(server(() => json({ pending: true }, 202)));
    const b = popupSetup(server(() => json({ pending: true }, 202)));
    await a.s.start();
    void a.s.login();
    a.send({ aasEmbedLogin: a.nonceOf() });
    a.s.destroy();
    await b.s.start();
    void b.s.login();
    b.send({ aasEmbedLogin: b.nonceOf() });
    expect(a.nonceOf()).not.toBe(b.nonceOf());
    const va = (a.win.postMessage.mock.calls[0] as unknown as [{ verifier: string }])[0].verifier;
    const vb = (b.win.postMessage.mock.calls[0] as unknown as [{ verifier: string }])[0].verifier;
    expect(va).not.toBe(vb);
    b.s.destroy();
  });

  it('진행 중에 다시 누르면 같은 시도를 돌려주고 창은 하나만 연다', async () => {
    const { s, openWindow } = popupSetup(server(() => json({ pending: true }, 202)));
    await s.start();
    const x = s.login();
    expect(s.login()).toBe(x);
    expect(openWindow).toHaveBeenCalledTimes(1);
    s.destroy();
    await x;
  });

  it('팝업 세션을 내릴 때 폐기 요청에 verifier 를 실어 호스트 refresh token 까지 폐기하게 한다', async () => {
    const fetchImpl = server(() => granted());
    const { s } = popupSetup(fetchImpl);
    await s.start();
    await s.tokens.redeemLogin('n'.repeat(43), 'v'.repeat(43));
    s.destroy();
    const revokes = fetchImpl.mock.calls.filter((c) => String(c[0]).endsWith('/api/embed/token/revoke')) as unknown as [string, RequestInit][];
    expect(revokes).toHaveLength(1);
    expect(JSON.parse(String(revokes[0][1].body))).toEqual({ verifier: 'v'.repeat(43) });
  });

  it('식별값의 종류가 다르면(팝업 토큰의 이메일 ↔ 이메일 없는 호스트 토큰의 sub) 사용자 바뀜으로 보지 않는다', async () => {
    const doc = { cookie: '' };
    const { s, store } = popupSetup(server(() => granted()), { accessTokenCookie: 'TK' }, doc);
    await s.start();
    await s.tokens.redeemLogin('n'.repeat(43), 'v'.repeat(43));
    doc.cookie = `TK=${jwt({ sub: 'kc-sub-1', exp: 9e9 })}`;
    await s.tokens.refresh();
    expect(store.get().notice).not.toBe('userChanged');
  });

  it('사용자는 이메일로 먼저 가린다 — 팝업 토큰 뒤 같은 이메일의 호스트 토큰이 와도 사용자 바뀜이 아니다', async () => {
    const doc = { cookie: '' };
    const fetchImpl = server(() => granted());
    const { s, store } = popupSetup(fetchImpl, { accessTokenCookie: 'TK' }, doc);
    await s.start();
    await s.tokens.redeemLogin('n'.repeat(43), 'v'.repeat(43));
    expect(s.tokens.current?.subject).toBe('u1@example.com');
    doc.cookie = `TK=${jwt({ sub: 'kc-sub-1', email: 'u1@example.com', exp: 9e9 })}`;
    await s.tokens.refresh();
    expect(store.get().notice).not.toBe('userChanged');
    doc.cookie = `TK=${jwt({ sub: 'kc-sub-2', email: 'u2@example.com', exp: 9e9 })}`;
    await s.tokens.refresh();
    expect(store.get().notice).toBe('userChanged');
  });
});

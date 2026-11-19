/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { setLang } from '@/i18n';

import { api, cached, del, forget, get, patch, post, SIDECAR_RETRY_MS } from './api';
import { wsClient } from './ws';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

describe('api', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
    api.toLogin = vi.fn();
    forget('/api/x');
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    setLang('ko');
  });

  it('GET 은 Accept-Language 만 붙여 보내고 JSON 을 돌려준다', async () => {
    vi.mocked(fetch).mockResolvedValue(json({ ok: 1 }));
    expect(await get('/api/x')).toEqual({ ok: 1 });
    expect(vi.mocked(fetch).mock.calls[0]).toEqual(['/api/x', { headers: { 'Accept-Language': 'ko' } }]);
  });

  it('화면 언어를 바꾸면 GET·POST 가 그 언어를 Accept-Language 로 보낸다', async () => {
    setLang('en');
    vi.mocked(fetch).mockImplementation(() => Promise.resolve(json({ ok: 1 })));
    await get('/api/x');
    await post('/api/y', {});
    const calls = vi.mocked(fetch).mock.calls as unknown as [string, RequestInit][];
    expect((calls[0][1].headers as Record<string, string>)['Accept-Language']).toBe('en');
    expect((calls[1][1].headers as Record<string, string>)['Accept-Language']).toBe('en');
  });

  it('cached 는 언어가 바뀌면 옛 언어의 응답을 쓰지 않는다', async () => {
    vi.mocked(fetch).mockImplementation(() => Promise.resolve(json({ n: 1 })));
    await cached('/api/x', 60000);
    setLang('en');
    await cached('/api/x', 60000);
    expect(fetch).toHaveBeenCalledTimes(2);
    forget('/api/x');
    setLang('ko');
    forget('/api/x');
  });

  it('POST 는 X-AAS 헤더와 JSON 본문을 붙인다(다른 사이트의 요청 차단용)', async () => {
    vi.mocked(fetch).mockResolvedValue(json({ saved: true }));
    await post('/api/cron/action', { id: 'j1' });
    const [url, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/cron/action');
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({ 'Content-Type': 'application/json', 'X-AAS': '1', 'Accept-Language': 'ko' });
    expect(init.body).toBe('{"id":"j1"}');
  });

  it('PATCH·DELETE 도 같은 헤더를 붙여 보낸다', async () => {
    const fn = vi.fn(() => Promise.resolve(new Response('{"ok":true}', { status: 200 })));
    vi.stubGlobal('fetch', fn);
    await patch('/x', { a: 1 });
    await del('/y');
    const calls = fn.mock.calls as unknown as [string, RequestInit][];
    expect(calls.map((c) => [c[0], c[1].method])).toEqual([
      ['/x', 'PATCH'],
      ['/y', 'DELETE'],
    ]);
    expect((calls[1][1].headers as Record<string, string>)['X-AAS']).toBe('1');
  });

  it('본문이 없는 POST 는 빈 객체를 보낸다', async () => {
    vi.mocked(fetch).mockResolvedValue(json({}));
    await post('/api/x');
    expect((vi.mocked(fetch).mock.calls[0]![1] as RequestInit).body).toBe('{}');
  });

  it('오류 응답은 서버가 준 error 문장을 예외로 던진다', async () => {
    vi.mocked(fetch).mockResolvedValue(json({ error: '관리자만 할 수 있습니다' }, 403));
    await expect(post('/api/x', {})).rejects.toThrow('관리자만 할 수 있습니다');
  });

  it('JSON 이 아닌 오류 응답은 상태 문구로 던진다', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response('oops', { status: 502, statusText: 'Bad Gateway' }));
    await expect(get('/api/x')).rejects.toThrow('Bad Gateway');
  });

  it('401 이면 로그인 화면으로 보내고(돌아올 주소 포함) 예외를 던진다', async () => {
    window.history.replaceState(null, '', '/legacy-test#cron?tab=jobs');
    vi.mocked(fetch).mockResolvedValue(json({ error: '로그인이 필요합니다' }, 401));
    await expect(get('/api/x')).rejects.toThrow('로그인이 필요합니다');
    expect(api.toLogin).toHaveBeenCalledWith('/auth/login?next=' + encodeURIComponent('/legacy-test#cron?tab=jobs'));
  });

  it('cached 는 TTL 안에서 같은 요청을 다시 보내지 않는다', async () => {
    vi.mocked(fetch).mockImplementation(() => Promise.resolve(json({ n: 1 })));
    await cached('/api/x', 60000);
    await cached('/api/x', 60000);
    expect(fetch).toHaveBeenCalledTimes(1);
    forget('/api/x');
    await cached('/api/x', 60000);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('cached 는 실패한 요청을 기억하지 않는다', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(json({ error: 'x' }, 500))
      .mockResolvedValueOnce(json({ n: 2 }));
    await expect(cached('/api/x')).rejects.toThrow('x');
    expect(await cached('/api/x')).toEqual({ n: 2 });
  });
});

describe('api.get 과 웹소켓(OMAI-1100 W4)', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
    api.toLogin = vi.fn();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    wsClient.state = 'off';
  });

  it('웹소켓이 live 면 req 로 읽고 HTTP 상태를 그대로 따른다', async () => {
    wsClient.state = 'live';
    const req = vi.spyOn(wsClient, 'request').mockResolvedValueOnce({ status: 200, body: { ok: 1 } });
    expect(await get('/api/x')).toEqual({ ok: 1 });
    expect(req).toHaveBeenCalledWith('get', { path: '/api/x' });
    expect(fetch).not.toHaveBeenCalled();
    req.mockResolvedValueOnce({ status: 403, body: { error: '관리자만', reason: 'admin' } });
    await expect(get('/api/users')).rejects.toMatchObject({ status: 403, reason: 'admin' });
    req.mockResolvedValueOnce({ status: 401, body: {} });
    await expect(get('/api/me')).rejects.toThrow();
    expect(api.toLogin).toHaveBeenCalled();
  });

  it('웹소켓이 못 하면(큰 응답·끊김) HTTP 로 다시 읽는다', async () => {
    wsClient.state = 'live';
    vi.spyOn(wsClient, 'request').mockRejectedValue(new Error('too_large'));
    vi.mocked(fetch).mockResolvedValue(json({ big: true }));
    expect(await get('/api/file?path=x')).toEqual({ big: true });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('live 가 아니면 HTTP 로만 읽는다', async () => {
    const req = vi.spyOn(wsClient, 'request');
    vi.mocked(fetch).mockResolvedValue(json({ ok: 2 }));
    expect(await get('/api/x')).toEqual({ ok: 2 });
    expect(req).not.toHaveBeenCalled();
  });

  describe('사이드카가 잠깐 응답하지 않으면(503 sidecar_unavailable) 다시 시도한다', () => {
    const busy = () => json({ error: '잠시 응답하지 않습니다', code: 'sidecar_unavailable' }, 503);
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('GET 은 1초·2초 뒤 다시 읽고, 성공하면 오류 없이 값을 돌려준다', async () => {
      vi.mocked(fetch)
        .mockResolvedValueOnce(busy())
        .mockResolvedValueOnce(busy())
        .mockResolvedValueOnce(json({ ok: 3 }));
      const p = get('/api/chat/history?profile=main');
      await vi.advanceTimersByTimeAsync(SIDECAR_RETRY_MS[0]);
      expect(fetch).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(SIDECAR_RETRY_MS[1]);
      await expect(p).resolves.toEqual({ ok: 3 });
      expect(fetch).toHaveBeenCalledTimes(3);
    });

    it('다 실패하면 서버 문장으로 실패한다(세 번만 보낸다)', async () => {
      vi.mocked(fetch).mockImplementation(() => Promise.resolve(busy()));
      const p = get('/api/chat/history?profile=main');
      const done = expect(p).rejects.toMatchObject({ status: 503, message: '잠시 응답하지 않습니다' });
      await vi.advanceTimersByTimeAsync(SIDECAR_RETRY_MS[0] + SIDECAR_RETRY_MS[1]);
      await done;
      expect(fetch).toHaveBeenCalledTimes(3);
    });

    it('다른 503 과 다른 오류는 다시 보내지 않는다', async () => {
      vi.mocked(fetch).mockResolvedValueOnce(json({ error: '다시 시작하는 중' }, 503));
      await expect(get('/api/chat/history')).rejects.toMatchObject({ status: 503 });
      vi.mocked(fetch).mockResolvedValueOnce(json({ error: 'x', code: 'sidecar_unavailable' }, 500));
      await expect(get('/api/chat/history')).rejects.toMatchObject({ status: 500 });
      expect(fetch).toHaveBeenCalledTimes(2);
    });

    it('POST 는 결과가 같은 resume 만 다시 보내고, 새 세션 만들기는 다시 보내지 않는다', async () => {
      vi.mocked(fetch)
        .mockResolvedValueOnce(busy())
        .mockResolvedValueOnce(json({ session_id: 's1' }));
      const p = post('/api/chat/resume', { profile: 'main', stored_id: 'x' });
      await vi.advanceTimersByTimeAsync(SIDECAR_RETRY_MS[0]);
      await expect(p).resolves.toEqual({ session_id: 's1' });
      vi.mocked(fetch).mockClear();
      vi.mocked(fetch).mockResolvedValueOnce(busy());
      await expect(post('/api/chat/session', { profile: 'main' })).rejects.toMatchObject({ status: 503 });
      expect(fetch).toHaveBeenCalledTimes(1);
    });
  });
});

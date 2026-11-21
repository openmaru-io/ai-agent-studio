/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 요청 계층 설정(configureApi, OMAI-1873): 기본값은 지금 요청 모양 그대로, 위젯 설정은 절대 주소·Bearer·쿠키 안 실음·aasu·pod·401 처리
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { api, apiFetch, appHref, configureApi, get, post, resetApi, withQuery } from '@/lib/api';
import { fileUrl, listFiles } from '@/lib/chatFiles';
import { wsClient } from '@/lib/ws';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const embed = (over: Parameters<typeof configureApi>[0] = {}) =>
  configureApi({
    baseUrl: 'https://aas.example.com/',
    embed: true,
    wsOnly: true,
    authHeader: () => 'Bearer emb-1',
    extraQuery: () => ({ aasu: 'stk', pod: 'pod-a' }),
    ...over,
  });

describe('configureApi', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(json({ ok: 1 }))));
    api.toLogin = vi.fn();
  });
  afterEach(() => {
    resetApi();
    vi.unstubAllGlobals();
    wsClient.state = 'off';
  });

  it('기본값에서는 지금과 같은 요청이 나간다(회귀) — 상대 주소, 인증 헤더·credentials·쿼리 없음', async () => {
    await get('/api/x');
    await post('/api/y', { a: 1 });
    await listFiles('p1');
    const calls = vi.mocked(fetch).mock.calls as unknown as [string, RequestInit][];
    expect(calls[0]).toEqual(['/api/x', { headers: { 'Accept-Language': 'ko' } }]);
    expect(calls[1]).toEqual(['/api/y', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-AAS': '1', 'Accept-Language': 'ko' }, body: '{"a":1}' }]);
    expect(calls[2]).toEqual(['/api/chat/files/list?pod=p1', { headers: { 'Accept-Language': 'ko' } }]);
    expect(withQuery('/api/x')).toBe('/api/x');
    expect(appHref('/agents?open=x')).toBe(`${window.location.pathname}#/agents?open=x`);
  });

  it('위젯 설정에서는 파일 목록을 서버에 묻지 않고 빈 목록을 돌려준다(서버가 403 으로 거절한다)', async () => {
    embed();
    await expect(listFiles('pod-a')).resolves.toEqual({ entries: [], truncated: false, used: null, quota: 0 });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('설정했다가 되돌리면 다시 기본 요청 모양이다', async () => {
    embed();
    resetApi();
    await get('/api/x');
    expect(vi.mocked(fetch).mock.calls[0]).toEqual(['/api/x', { headers: { 'Accept-Language': 'ko' } }]);
  });

  it('위젯 설정에서는 AAS 절대 주소·Bearer·credentials omit·aasu·pod 를 싣는다', async () => {
    embed();
    await get('/api/chat/status?all=1');
    await post('/api/chat/send', { session_id: 's' });
    await apiFetch(fileUrl('pod-a', '/w/a.txt'), { method: 'HEAD', headers: { 'X-AAS': '1' } });
    const calls = vi.mocked(fetch).mock.calls as unknown as [string, RequestInit][];
    expect(calls[0][0]).toBe('https://aas.example.com/api/chat/status?all=1&aasu=stk&pod=pod-a');
    expect(calls[0][1]).toEqual({ headers: { 'Accept-Language': 'ko', Authorization: 'Bearer emb-1' }, credentials: 'omit' });
    expect(calls[1][0]).toBe('https://aas.example.com/api/chat/send?aasu=stk&pod=pod-a');
    expect(calls[1][1]).toMatchObject({ method: 'POST', credentials: 'omit', headers: { Authorization: 'Bearer emb-1', 'X-AAS': '1' } });
    // 주소에 이미 pod 가 있으면 덮어쓰지 않는다
    expect(calls[2][0]).toBe('https://aas.example.com/api/chat/files?pod=pod-a&path=%2Fw%2Fa.txt&aasu=stk');
    expect(calls[2][1]).toMatchObject({ method: 'HEAD', credentials: 'omit', headers: { Authorization: 'Bearer emb-1' } });
    expect(appHref('/agents?open=x')).toBe('https://aas.example.com/#/agents?open=x');
  });

  it('위젯 설정의 401 은 /auth/login 으로 보내지 않고 onUnauthorized 를 부른다', async () => {
    const onUnauthorized = vi.fn();
    embed({ onUnauthorized });
    vi.mocked(fetch).mockResolvedValueOnce(json({ error: 'x' }, 401));
    await expect(get('/api/me')).rejects.toThrow();
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
    expect(api.toLogin).not.toHaveBeenCalled();
  });

  it('허용 경로 밖(401 path_not_allowed)은 다시 교환하지 않고 그 요청만 실패한다', async () => {
    const onUnauthorized = vi.fn();
    embed({ onUnauthorized });
    vi.mocked(fetch).mockResolvedValueOnce(json({ error: 'path_not_allowed', message: 'x' }, 401));
    await expect(get('/api/admin/x')).rejects.toMatchObject({ status: 401, reason: 'path_not_allowed' });
    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  it('429 는 onRateLimited 를 부르고 오류를 그대로 던진다', async () => {
    const onRateLimited = vi.fn();
    embed({ onRateLimited });
    vi.mocked(fetch).mockResolvedValueOnce(json({ error: 'busy' }, 429));
    await expect(post('/api/chat/send', {})).rejects.toMatchObject({ status: 429 });
    expect(onRateLimited).toHaveBeenCalledTimes(1);
  });

  it('웹소켓으로 읽을 때도 경로에 aasu·pod 를 싣는다', async () => {
    embed();
    wsClient.state = 'live';
    const req = vi.spyOn(wsClient, 'request').mockResolvedValueOnce({ status: 200, body: { ok: 1 } });
    await get('/api/chat/history?profile=main');
    expect(req).toHaveBeenCalledWith('get', { path: '/api/chat/history?profile=main&aasu=stk&pod=pod-a' });
    req.mockRestore();
  });
});

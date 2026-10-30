/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 서버 호출. 로그인이 풀렸으면 로그인 화면으로 보낸다. 바꾸는 요청에는 X-AAS 헤더가 붙는다(다른 사이트의 요청 차단).
// 모든 요청에 Accept-Language 로 화면에서 고른 언어를 보낸다. 서버가 오류와 안내 문장을 그 언어로 만든다.
import { getLang, t } from '@/i18n';

import { wsClient } from './ws';

export const api = {
  // 시험에서 바꿔 끼울 수 있게 객체 속성으로 둔다.
  toLogin(url: string): void {
    window.location.href = url;
  },
};

/** 서버가 거절한 요청. status 로 종류를 가린다(409 는 그사이 다른 곳에서 바뀐 것). 문장은 언어마다 달라 비교에 쓰지 않는다. */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly reason: string = '',
    /** 서버가 짚은 입력 칸(사용자 추가의 409·400 등). 칸 옆에 오류를 보인다 */
    readonly field: string = '',
    /** 일부만 바뀌었다(사용자 만들기의 되돌리기 실패 500) */
    readonly partial: boolean = false,
    /** 서버가 보낸 본문 전체(채팅 보내기 400 의 code·path 등, 스펙 2026-10-20-002 DD5) */
    readonly data: Record<string, unknown> = {}
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function handle<T>(r: Response): Promise<T> {
  if (r.status === 401) {
    api.toLogin('/auth/login?next=' + encodeURIComponent(window.location.pathname + window.location.hash));
    throw new Error(t('common.loginRequired'));
  }
  const body = await r.json().catch(() => ({}));
  if (!r.ok) {
    const b = body as { error?: string; reason?: string; field?: string; partial?: boolean };
    throw new ApiError(b.error || r.statusText, r.status, b.reason ?? '', b.field ?? '', b.partial === true, body as Record<string, unknown>);
  }
  return body as T;
}

const lang = (): Record<string, string> => ({ 'Accept-Language': getLang() });

const httpGet = <T = unknown>(url: string): Promise<T> => fetch(url, { headers: lang() }).then((r) => handle<T>(r));

/** 읽기. 웹소켓이 live 면 req 로 서버의 같은 처리기를 부르고(OMAI-1100 W4), 아니거나 웹소켓이 못 하면 HTTP 로 읽는다. */
export async function get<T = unknown>(url: string): Promise<T> {
  if (wsClient.state === 'live' && url.startsWith('/api/')) {
    let res: { status: number; body: unknown } | null = null;
    try {
      res = await wsClient.request<{ status: number; body: unknown }>('get', { path: url });
    } catch {
      res = null; // 끊김·큰 응답·바쁨 — HTTP 로 다시 읽는다
    }
    if (res) return handle<T>(new Response(JSON.stringify(res.body), { status: res.status, headers: { 'Content-Type': 'application/json' } }));
  }
  return httpGet<T>(url);
}

const send =
  (method: string) =>
  // signal: 요청을 중단할 수 있게(받아쓰기 취소, 스펙 2026-10-22-005 §10 2A)
  <T = unknown>(url: string, body?: unknown, opts?: { signal?: AbortSignal }): Promise<T> =>
    fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-AAS': '1', ...lang() },
      body: JSON.stringify(body ?? {}),
      ...(opts?.signal ? { signal: opts.signal } : {}),
    }).then((r) => handle<T>(r));

export const post = send('POST');
export const patch = send('PATCH');
export const put = send('PUT');
export const del = <T = unknown>(url: string): Promise<T> => send('DELETE')<T>(url);

const memo = new Map<string, { t: number; p: Promise<unknown> }>();

// 같은 화면을 다시 열 때 잠깐(기본 30초)은 받아 둔 것을 쓴다. 실패한 요청은 기억하지 않는다.
export function cached<T = unknown>(url: string, ttl = 30000): Promise<T> {
  const key = getLang() + ' ' + url;
  const hit = memo.get(key);
  if (hit && Date.now() - hit.t < ttl) return hit.p as Promise<T>;
  const p = get<T>(url);
  memo.set(key, { t: Date.now(), p });
  p.catch(() => memo.delete(key));
  return p;
}

export const forget = (url: string): boolean => memo.delete(getLang() + ' ' + url);

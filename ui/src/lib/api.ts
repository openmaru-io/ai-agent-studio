/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 서버 호출. 로그인이 풀렸으면 로그인 화면으로 보낸다. 바꾸는 요청에는 X-AAS 헤더가 붙는다(다른 사이트의 요청 차단).
// 모든 요청에 Accept-Language 로 화면에서 고른 언어를 보낸다. 서버가 오류와 안내 문장을 그 언어로 만든다.
import { getLang, t } from '@/i18n';

import { noteServerDate } from './serverClock';
import { wsClient } from './ws';

export const api = {
  // 시험에서 바꿔 끼울 수 있게 객체 속성으로 둔다.
  toLogin(url: string): void {
    window.location.href = url;
  },
};

/** 요청 계층 설정(OMAI-1873). 기본값은 같은 출처·쿠키라 AAS 화면의 요청은 바뀌지 않는다.
 *  다른 사이트에 붙는 채팅 위젯은 AAS 절대 주소·Bearer 임베드 토큰·쿠키 안 실음·서버 고정 쿼리를 넣는다. */
export interface ApiConfig {
  /** 서버 주소(끝 / 없이). 빈 값이면 같은 출처의 상대 주소를 그대로 쓴다 */
  baseUrl: string;
  /** 요청마다 붙일 Authorization 값(예: 'Bearer …'). 없으면 붙이지 않는다 */
  authHeader: (() => string | null) | null;
  /** REST·웹소켓 주소마다 붙일 쿼리(서버 고정 aasu, 에이전트 pod) */
  extraQuery: (() => Record<string, string>) | null;
  /** 401 을 받았을 때. 없으면 로그인 화면(/auth/login)으로 보낸다 */
  onUnauthorized: (() => void) | null;
  /** 웹소켓 연결 직후 첫 메시지로 보낼 인증 값. 없으면 보내지 않는다(쿠키 인증) */
  wsAuth: (() => { token: string; pod?: string } | null) | null;
  /** 429 를 받았을 때(요청 한도) */
  onRateLimited: (() => void) | null;
  /** 웹소켓이 닫혔을 때(코드·이유·한 번이라도 연결됐는가). 위젯이 연결 원인을 가리는 데 쓴다 */
  onWsClose: ((code: number, reason: string, welcomed: boolean) => void) | null;
  /** 다른 사이트에 붙은 위젯이다 — 파일 받기·새 창은 AAS 새 탭으로, 대화 파일 첨부는 끈다 */
  embed: boolean;
  /** 웹소켓으로만 받는다(EventSource·HTTP 대체 경로를 쓰지 않는다) */
  wsOnly: boolean;
}

const DEFAULT_API: ApiConfig = {
  baseUrl: '',
  authHeader: null,
  extraQuery: null,
  onUnauthorized: null,
  wsAuth: null,
  onRateLimited: null,
  onWsClose: null,
  embed: false,
  wsOnly: false,
};

let cfg: ApiConfig = DEFAULT_API;

/** 요청 계층 설정을 바꾼다. 넘긴 항목만 바뀐다 */
export function configureApi(next: Partial<ApiConfig>): void {
  cfg = { ...cfg, ...next, baseUrl: (next.baseUrl ?? cfg.baseUrl).replace(/\/+$/, '') };
}

/** 기본값(같은 출처·쿠키)으로 되돌린다 */
export function resetApi(): void {
  cfg = DEFAULT_API;
}

export const apiConfig = (): ApiConfig => cfg;

/** 주소에 설정 쿼리를 붙인다(이미 있는 이름은 덮어쓰지 않는다). 기본값이면 그대로 돌려준다 */
export function withQuery(url: string): string {
  const q = cfg.extraQuery?.();
  if (!q) return url;
  const add = Object.entries(q).filter(([k, v]) => v !== '' && !new RegExp(`[?&]${k}=`).test(url));
  if (!add.length) return url;
  return url + (url.includes('?') ? '&' : '?') + add.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
}

/** 요청 주소: 서버 주소 + 경로 + 설정 쿼리. 기본값이면 받은 주소 그대로다 */
export const apiUrl = (url: string): string => (url.startsWith('/') ? cfg.baseUrl : '') + withQuery(url);

/** 새 탭으로 여는 AAS 주소(쿼리를 붙이지 않는다 — 그 탭은 AAS 로그인 쿠키로 연다) */
export const aasUrl = (path: string): string => cfg.baseUrl + path;

/** AAS 화면의 한 곳(#/경로)을 새 창으로 열 주소. 같은 출처면 지금 주소, 위젯이면 AAS 주소 기준이다 */
export const appHref = (hash: string): string =>
  cfg.baseUrl ? `${cfg.baseUrl}/#${hash.replace(/^#/, '')}` : `${window.location.pathname}#${hash.replace(/^#/, '')}`;

/** 요청 옵션에 인증 헤더·쿠키 정책을 더한다. 기본값이면 받은 객체를 그대로 돌려준다(요청 모양이 같다) */
export function withAuth(init: RequestInit = {}): RequestInit {
  const auth = cfg.authHeader?.();
  if (!auth && !cfg.baseUrl) return init;
  const headers = { ...((init.headers as Record<string, string> | undefined) ?? {}), ...(auth ? { Authorization: auth } : {}) };
  return { ...init, headers, ...(cfg.embed ? { credentials: 'omit' as const } : {}) };
}

/** 설정을 탄 fetch. 기본값이면 fetch(url, init) 과 같다 */
export const apiFetch = (url: string, init?: RequestInit): Promise<Response> =>
  init === undefined && !cfg.baseUrl && !cfg.authHeader && !cfg.extraQuery ? fetch(url) : fetch(apiUrl(url), withAuth(init));

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
  noteServerDate(r.headers.get('Date'));
  if (r.status === 401) {
    if (cfg.onUnauthorized) {
      // 위젯에서 허용하지 않는 경로(path_not_allowed)는 토큰 문제가 아니다 — 다시 교환하지 않고 그 요청만 실패한다
      const b = (await r.clone().json().catch(() => ({}))) as { error?: string; code?: string };
      const code = b.code ?? b.error ?? '';
      if (code === 'path_not_allowed') throw new ApiError(t('common.loginRequired'), 401, code);
      cfg.onUnauthorized();
    }
    else api.toLogin('/auth/login?next=' + encodeURIComponent(window.location.pathname + window.location.hash));
    throw new Error(t('common.loginRequired'));
  }
  if (r.status === 429) cfg.onRateLimited?.();
  const body = await r.json().catch(() => ({}));
  if (!r.ok) {
    const b = body as { error?: string; reason?: string; field?: string; partial?: boolean };
    throw new ApiError(b.error || r.statusText, r.status, b.reason ?? '', b.field ?? '', b.partial === true, body as Record<string, unknown>);
  }
  return body as T;
}

const lang = (): Record<string, string> => ({ 'Accept-Language': getLang() });

/** 사이드카가 잠깐 응답하지 않은 채팅 요청(서버 503, code sidecar_unavailable)을 다시 보내기 전에 기다리는 시간(밀리초).
 *  공유 저장소(NFS)가 몇 초 느려져도 화면에 오류 띠가 바로 떴다(OMAI-1894). 다 실패하면 서버 문장을 그대로 보인다. */
export const SIDECAR_RETRY_MS = [1000, 2000];
/** 다시 보내도 결과가 같은 POST. 새 세션 만들기·보내기는 두 번 일어날 수 있어 넣지 않는다 */
const RETRY_POST = new Set(['/api/chat/resume']);
const sidecarBusy = (e: unknown): boolean => e instanceof ApiError && e.status === 503 && e.data.code === 'sidecar_unavailable';

async function retrySidecar<T>(run: () => Promise<T>): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await run();
    } catch (e) {
      if (!sidecarBusy(e) || i >= SIDECAR_RETRY_MS.length) throw e;
      await new Promise((r) => setTimeout(r, SIDECAR_RETRY_MS[i]));
    }
  }
}

const httpGet = <T = unknown>(url: string): Promise<T> => fetch(apiUrl(url), withAuth({ headers: lang() })).then((r) => handle<T>(r));

/** 읽기. 웹소켓이 live 면 req 로 서버의 같은 처리기를 부르고(OMAI-1100 W4), 아니거나 웹소켓이 못 하면 HTTP 로 읽는다. */
export function get<T = unknown>(url: string): Promise<T> {
  return retrySidecar(() => getOnce<T>(url));
}

async function getOnce<T>(url: string): Promise<T> {
  if (wsClient.state === 'live' && url.startsWith('/api/')) {
    let res: { status: number; body: unknown } | null = null;
    try {
      res = await wsClient.request<{ status: number; body: unknown }>('get', { path: withQuery(url) });
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
  <T = unknown>(url: string, body?: unknown, opts?: { signal?: AbortSignal }): Promise<T> => {
    const once = () =>
      fetch(
        apiUrl(url),
        withAuth({
          method,
          headers: { 'Content-Type': 'application/json', 'X-AAS': '1', ...lang() },
          body: JSON.stringify(body ?? {}),
          ...(opts?.signal ? { signal: opts.signal } : {}),
        })
      ).then((r) => handle<T>(r));
    return method === 'POST' && RETRY_POST.has(url.split('?')[0]) ? retrySidecar(once) : once();
  };

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

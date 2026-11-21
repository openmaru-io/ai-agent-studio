/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 호스트가 준 신원 토큰을 AAS 전용 짧은 임베드 토큰으로 바꾼다(OMAI-1873). 호스트 토큰을 AAS 의 모든 요청에 싣지 않는다.
// - 교환: POST {backendUrl}/api/embed/token {assertion} → {token, expires, sticky, protocol, ws}
// - 신원 토큰: accessTokenCookie 가 있으면 그 쿠키, 없으면 accessToken. 둘 다 있으면 exp 가 늦은 쪽(COP Console·Observ UI 가 기대하는 동작)
// - 다시 교환: 만료 1분 전, 쿠키의 토큰이 바뀌었을 때, 401 을 받았을 때. 호스트는 교환을 알 필요가 없다
// - 사용자가 바뀌면(sub 가 다르면) 부르는 쪽이 열린 대화를 닫는다(onChange 의 userChanged)
// - 내장 팝업 로그인(OMAI-1911): 신원 토큰이 없어도 빈 assertion 으로 교환을 보낸다 — 401 의 popup_login 으로 「로그인」을 보일지 정한다.
//   팝업 승인은 {login, verifier} 로 받고, 그렇게 받은 토큰(refresh: true)은 신원 토큰이 없을 때 {refresh, verifier} 로 갱신한다
import { getLang } from '@/i18n';

/** 이 위젯이 쓰는 임베드 API 판. 서버가 교환 응답의 protocol 로 받는 범위를 알린다 */
export const WIDGET_PROTOCOL = 1;
/** 만료 이만큼 전에 다시 교환한다 */
export const REFRESH_BEFORE_MS = 60_000;
/** 쿠키의 토큰이 바뀌었는지 보는 간격 */
export const COOKIE_POLL_MS = 5_000;

export interface Exchange {
  token: string;
  /** 만료 시각(ms) */
  expiresAt: number;
  /** 서버 고정 값(aasu 쿼리) */
  sticky: string;
  /** 서버가 받는 위젯 판 범위(모양은 protocolAccepts 참고) */
  protocol: unknown;
  /** 서버가 웹소켓을 켰는가 */
  ws: boolean;
  /** 이 토큰의 사용자(호스트 토큰의 sub, 없으면 email·서버가 준 값) */
  subject: string;
  /** 임베드 앱에 등록한 기본 AI 에이전트(없으면 ""). 위젯 설정의 agent 가 먼저다 */
  agent: string;
  /** 내장 팝업 로그인으로 받은 토큰이다 — 신원 토큰 없이 {refresh, verifier} 로 갱신한다(OMAI-1911) */
  refresh: boolean;
}

/** 교환 실패. network 는 응답을 받지 못했다(인증서·사전 요청·혼합 콘텐츠·네트워크).
 *  popupLogin: 401 본문의 popup_login — 앱에 로그인 클라이언트가 있어 위젯이 팝업 로그인을 열 수 있다(OMAI-1911) */
export class ExchangeError extends Error {
  constructor(
    readonly kind: 'network' | 'http',
    readonly status = 0,
    readonly code = '',
    readonly popupLogin = false
  ) {
    super(kind === 'http' ? `${status} ${code}` : kind);
    this.name = 'ExchangeError';
  }
}

interface Claims {
  exp?: number;
  sub?: string;
  email?: string;
}

/** JWT 의 본문을 읽는다(서명은 보지 않는다 — 서버가 검증한다). JWT 가 아니면 null */
export function decodeJwt(token: string): Claims | null {
  const part = token.split('.')[1];
  if (!part) return null;
  try {
    const b64 = part.replace(/-/g, '+').replace(/_/g, '/');
    const text = decodeURIComponent(
      Array.from(atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4)))
        .map((c) => '%' + c.charCodeAt(0).toString(16).padStart(2, '0'))
        .join('')
    );
    const v = JSON.parse(text);
    return v && typeof v === 'object' ? (v as Claims) : null;
  } catch {
    return null;
  }
}

export function readCookie(name: string, doc: Pick<Document, 'cookie'> = document): string {
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = doc.cookie.match(new RegExp(`(?:^|;\\s*)${esc}=([^;]*)`));
  if (!m) return '';
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return m[1];
  }
}

/** 교환에 쓸 신원 토큰. 쿠키와 accessToken 이 둘 다 있으면 exp 가 늦은 쪽, exp 를 모르면 쿠키(호스트가 갱신하는 쪽) */
export function pickAssertion(cfg: { accessToken?: string; accessTokenCookie?: string }, doc: Pick<Document, 'cookie'> = document): string {
  const fromCookie = cfg.accessTokenCookie ? readCookie(cfg.accessTokenCookie, doc) : '';
  const given = cfg.accessToken || '';
  if (!fromCookie || !given) return fromCookie || given;
  const a = decodeJwt(fromCookie)?.exp ?? -1;
  const b = decodeJwt(given)?.exp ?? -1;
  return b > a ? given : fromCookie;
}

/** expires 는 초·밀리초 숫자 또는 ISO 문자열을 받는다. 모르면 15분 */
export function parseExpires(v: unknown, now: number): number {
  if (typeof v === 'number' && Number.isFinite(v)) return v < 1e12 ? v * 1000 : v;
  if (typeof v === 'string') {
    const n = Number(v);
    if (Number.isFinite(n) && v.trim()) return parseExpires(n, now);
    const d = Date.parse(v);
    if (Number.isFinite(d)) return d;
  }
  return now + 15 * 60_000;
}

/** 서버가 받는 판 범위에 이 판이 있는가. 범위는 숫자(그 판만)·[최소, 최대]·{min, max}·"1"·"1-3" 을 받는다. 없으면 받는 것으로 본다 */
export function protocolAccepts(range: unknown, version = WIDGET_PROTOCOL): boolean {
  if (range === undefined || range === null || range === '') return true;
  let lo: number;
  let hi: number;
  if (typeof range === 'number') lo = hi = range;
  else if (Array.isArray(range)) [lo, hi] = [Number(range[0]), Number(range[range.length - 1])];
  else if (typeof range === 'object') {
    const r = range as { min?: unknown; max?: unknown };
    lo = r.min === undefined ? -Infinity : Number(r.min);
    hi = r.max === undefined ? Infinity : Number(r.max);
  } else {
    const m = String(range).match(/^\s*(\d+)\s*(?:-\s*(\d+)\s*)?$/);
    if (!m) return true;
    lo = Number(m[1]);
    hi = m[2] ? Number(m[2]) : lo;
  }
  if (!Number.isFinite(lo) && lo !== -Infinity) return true;
  return version >= lo && version <= hi;
}

/** 오류 본문의 코드(code·reason·error 순서) */
const codeOf = (body: unknown): string => {
  const b = (body ?? {}) as { code?: unknown; reason?: unknown; error?: unknown };
  return String(b.code ?? b.reason ?? (typeof b.error === 'string' && /^[a-z_]+$/.test(b.error) ? b.error : '') ?? '');
};

type PostOpts = { fetchImpl?: typeof fetch; now?: number; widgetInfo?: string };

/** POST /api/embed/token. 202(팝업 승인 대기)면 null 을 돌려준다 */
async function postToken(backendUrl: string, payload: Record<string, string>, opts: PostOpts, assertion = ''): Promise<Exchange | null> {
  const f = opts.fetchImpl ?? fetch;
  const now = opts.now ?? Date.now();
  let r: Response;
  try {
    r = await f(`${backendUrl}/api/embed/token`, {
      method: 'POST',
      credentials: 'omit',
      headers: { 'Content-Type': 'application/json', 'Accept-Language': getLang() },
      body: JSON.stringify({ ...payload, protocol: WIDGET_PROTOCOL, ...(opts.widgetInfo ? { widget_info: opts.widgetInfo } : {}) }),
    });
  } catch {
    throw new ExchangeError('network');
  }
  const body = (await r.json().catch(() => ({}))) as Record<string, unknown>;
  if (r.status === 202 && 'login' in payload) return null;
  if (!r.ok || typeof body.token !== 'string' || !body.token) throw new ExchangeError('http', r.ok ? 502 : r.status, codeOf(body), body.popup_login === true);
  const claims = assertion ? decodeJwt(assertion) : null;
  return {
    token: body.token,
    expiresAt: parseExpires(body.expires ?? body.expires_at, now),
    sticky: typeof body.sticky === 'string' ? body.sticky : '',
    protocol: body.protocol,
    ws: body.ws !== false,
    // 이메일이 먼저다(OMAI-1911) — 팝업 토큰은 서버가 준 email 만 있어, sub 를 먼저 쓰면 같은 사람의 호스트 토큰과 다르게 보인다
    subject: String(claims?.email ?? body.email ?? claims?.sub ?? body.sub ?? body.user ?? ''),
    agent: typeof body.agent === 'string' ? body.agent : '',
    refresh: body.refresh === true,
  };
}

/** 신원 토큰을 임베드 토큰으로 바꾼다. 신원 토큰이 없어도 빈 값으로 보낸다 — 서버의 401 popup_login 을 받아야 「로그인」을 보일 수 있다(OMAI-1911) */
export async function exchange(backendUrl: string, assertion: string, opts: PostOpts = {}): Promise<Exchange> {
  return (await postToken(backendUrl, { assertion }, opts, assertion))!;
}

/** 팝업 로그인 승인을 묻는다(OMAI-1911). 아직이면(202) null */
export function redeemLogin(backendUrl: string, nonce: string, verifier: string, opts: PostOpts = {}): Promise<Exchange | null> {
  return postToken(backendUrl, { login: nonce, verifier }, opts);
}

/** 팝업으로 받은 임베드 토큰을 갱신한다(OMAI-1911). 만료된 토큰도 서버의 세션 상한 안이면 받는다 */
export async function refreshLogin(backendUrl: string, token: string, verifier: string, opts: PostOpts = {}): Promise<Exchange> {
  return (await postToken(backendUrl, { refresh: token, verifier }, opts))!;
}

/** 임베드 토큰을 버린다(destroy·resetUserSession). 실패해도 15분 뒤 저절로 끝나므로 기다리지 않아도 된다 */
/** verifier: 팝업 로그인 토큰이면 함께 보낸다 — 서버가 호스트 refresh token 까지 Keycloak 에서 폐기한다(OMAI-1911) */
export async function revoke(backendUrl: string, token: string, fetchImpl: typeof fetch = fetch, verifier = ''): Promise<void> {
  if (!token) return;
  try {
    await fetchImpl(`${backendUrl}/api/embed/token/revoke`, {
      method: 'POST',
      credentials: 'omit',
      keepalive: true,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(verifier ? { verifier } : {}),
    });
  } catch {
    /* 네트워크 오류 — 서버가 만료로 지운다 */
  }
}

/** getAccessToken 을 기다리는 최대 시간 */
export const GET_TOKEN_TIMEOUT_MS = 10_000;

type AssertionSource = { accessToken?: string; accessTokenCookie?: string; getAccessToken?: () => string | Promise<string> };

/**
 * 교환에 쓸 신원 토큰을 정한다. getAccessToken 이 있으면 먼저 부르고, 값이 없거나 실패하면 pickAssertion(쿠키·accessToken)으로 넘어간다.
 * 호스트가 교환 때마다 새 토큰을 줄 수 있게 한다 — host-signed 토큰은 5분 안에 끝나고 jti 를 한 번만 받는다(OMAI-1873).
 */
export async function resolveAssertion(cfg: AssertionSource, doc: Pick<Document, 'cookie'> = document, timeoutMs = GET_TOKEN_TIMEOUT_MS): Promise<string> {
  if (typeof cfg.getAccessToken === 'function') {
    try {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const late = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs} ms`)), timeoutMs);
      });
      const v = await Promise.race([Promise.resolve().then(() => cfg.getAccessToken!()), late]).finally(() => clearTimeout(timer));
      if (typeof v === 'string' && v.trim()) return v.trim();
    } catch (e) {
      console.warn(`[CogentAIAASWidget] get_access_token getAccessToken failed (${(e as Error)?.message ?? e}); falling back to accessTokenCookie/accessToken`);
    }
  }
  return pickAssertion(cfg, doc);
}

export interface TokenDeps {
  config: () => { backendUrl: string; widgetInfo?: string } & AssertionSource;
  fetchImpl?: typeof fetch;
  doc?: Pick<Document, 'cookie'>;
  now?: () => number;
  /** 새 토큰을 받았다. userChanged: 앞 토큰과 사용자가 다르다(첫 교환은 거짓) */
  onChange: (ex: Exchange, prev: Exchange | null, userChanged: boolean) => void;
  /** 저절로 다시 교환하다 실패했다(만료 전·쿠키 변경) */
  onFailure: (e: ExchangeError) => void;
}

/** 임베드 토큰 하나를 들고 제때 다시 교환한다 */
export class TokenSession {
  current: Exchange | null = null;
  private assertion = '';
  /** 팝업 로그인의 verifier(OMAI-1911). 메모리에만 둔다 — 임베드 토큰만 훔쳐서는 갱신할 수 없게 */
  private verifier = '';

  /** 폐기 요청에 실을 팝업 로그인 verifier. stop() 이 지우므로 그 전에 읽는다 */
  get loginVerifier(): string {
    return this.verifier;
  }
  private timer: ReturnType<typeof setTimeout> | null = null;
  private poll: ReturnType<typeof setInterval> | null = null;
  private inflight: Promise<Exchange> | null = null;
  private stopped = false;

  constructor(private deps: TokenDeps) {}

  private now = () => (this.deps.now ?? Date.now)();

  get token(): string {
    return this.current?.token ?? '';
  }

  /** 지금 교환한다. 이미 하는 중이면 그 결과를 같이 기다린다 */
  refresh(): Promise<Exchange> {
    if (this.inflight) return this.inflight;
    this.stopped = false;
    const cfg = this.deps.config();
    const opts = { fetchImpl: this.deps.fetchImpl, now: this.now(), widgetInfo: cfg.widgetInfo };
    const p = resolveAssertion(cfg, this.deps.doc ?? document)
      .then((assertion) => {
        // 신원 토큰이 있으면 그것이 먼저다. 없고 지금 토큰이 팝업으로 받은 것이면 {refresh, verifier} 로 갱신한다(OMAI-1911)
        const cur = this.current;
        if (!assertion && cur?.refresh && this.verifier) return refreshLogin(cfg.backendUrl, cur.token, this.verifier, opts).then((ex) => this.adopt(ex, '', this.verifier));
        return exchange(cfg.backendUrl, assertion, opts).then((ex) => this.adopt(ex, assertion, ''));
      })
      .finally(() => {
        if (this.inflight === p) this.inflight = null;
      });
    this.inflight = p;
    // getAccessToken 이 있으면 그것이 신원 토큰의 정본이다 — 쿠키를 따로 지켜보면 값이 달라 5초마다 다시 교환한다
    if (cfg.accessTokenCookie && typeof cfg.getAccessToken !== 'function' && !this.poll) this.poll = setInterval(() => this.checkCookie(), COOKIE_POLL_MS);
    return p;
  }

  /** 새 토큰을 들고 다음 갱신을 잡는다 */
  private adopt(ex: Exchange, assertion: string, verifier: string): Exchange {
    if (this.stopped) return ex;
    const prev = this.current;
    this.assertion = assertion;
    this.verifier = ex.refresh ? verifier : '';
    this.current = ex;
    this.schedule(ex);
    // 식별값의 종류가 같을 때만 견준다(OMAI-1911) — 팝업 토큰은 이메일, 이메일 없는 호스트 토큰은 sub 라 같은 사람도 다르게 보인다
    const sameKind = !!prev && prev.subject.includes('@') === ex.subject.includes('@');
    this.deps.onChange(ex, prev, !!prev && !!prev.subject && !!ex.subject && sameKind && prev.subject !== ex.subject);
    return ex;
  }

  /** 팝업 로그인 승인을 한 번 묻는다(OMAI-1911). 승인되면 지금 교환 성공과 같은 경로(onChange)로 간다. 아직이면 null */
  async redeemLogin(nonce: string, verifier: string): Promise<Exchange | null> {
    const cfg = this.deps.config();
    const ex = await redeemLogin(cfg.backendUrl, nonce, verifier, { fetchImpl: this.deps.fetchImpl, now: this.now(), widgetInfo: cfg.widgetInfo });
    return ex && this.adopt(ex, '', verifier);
  }

  /** 쿠키의 신원 토큰이 바뀌었으면 다시 교환한다(CogentAI 위젯이 질문마다 쿠키를 다시 읽는 것과 같은 효과). 바뀌었으면 참 */
  checkCookie(): boolean {
    if (this.stopped || this.inflight || !this.current) return false;
    if (typeof this.deps.config().getAccessToken === 'function') return false;
    const next = pickAssertion(this.deps.config(), this.deps.doc ?? document);
    if (!next || next === this.assertion) return false;
    this.refresh().catch((e) => this.deps.onFailure(e as ExchangeError));
    return true;
  }

  private schedule(ex: Exchange) {
    if (this.timer) clearTimeout(this.timer);
    const wait = Math.max(5_000, ex.expiresAt - this.now() - REFRESH_BEFORE_MS);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.refresh().catch((e) => this.deps.onFailure(e as ExchangeError));
    }, wait);
  }

  /** 다시 교환하지 않는다. 들고 있던 토큰은 돌려준다(revoke 는 부르는 쪽이 정한다) */
  stop(): Exchange | null {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.poll) clearInterval(this.poll);
    this.timer = null;
    this.poll = null;
    this.inflight = null;
    const cur = this.current;
    this.current = null;
    this.assertion = '';
    this.verifier = '';
    return cur;
  }
}

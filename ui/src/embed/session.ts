/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 위젯의 연결 하나(OMAI-1873): 토큰 교환 → 요청 계층 설정(절대 주소·Bearer·aasu·pod) → 웹소켓 → 채팅 저장소.
// 실패는 상태 표의 한 칸과 콘솔 한 줄로 바꾼다. 인증서 안내는 응답이 없고 no-cors /healthz 도 실패할 때만 띄운다.
import { configureApi, resetApi } from '@/lib/api';
import { ChatStore, PRIMARY } from '@/lib/chatStore';
import { WsClient } from '@/lib/ws';

import { CertResult, diagnoseNoResponse, promptCertApproval, resetCertCheck } from './certHelper';
import type { ResolvedConfig } from './config';
import { ErrorCode, logError } from './errors';
import type { WidgetStatus, WidgetStore } from './state';
import { Exchange, ExchangeError, protocolAccepts, revoke, TokenSession } from './token';

export interface SessionDeps {
  store: WidgetStore;
  chat: ChatStore;
  ws: WsClient;
  fetchImpl?: typeof fetch;
  doc?: Pick<Document, 'cookie'>;
  /** 인증서 안내 창을 붙일 곳(Shadow DOM 안) */
  certContainer: () => HTMLElement | ShadowRoot | null;
  promptCert?: (backendUrl: string, container: HTMLElement | ShadowRoot) => Promise<CertResult>;
  /** 호스트 페이지가 https 인가(혼합 콘텐츠 판단) */
  pageProtocol?: () => string;
  /** 내장 팝업 로그인 창을 연다(OMAI-1911). 시험용 — 기본은 window.open */
  openWindow?: (url: string, name: string, features: string) => Window | null;
  /** 팝업의 message 를 받을 곳. 시험용 — 기본은 window */
  messageTarget?: Pick<Window, 'addEventListener' | 'removeEventListener'>;
}

/** 「로그인」 콜백을 기다리는 최대 시간(OMAI-1908). 지나면 기다리지 않고 다시 교환한다. 내장 팝업에는 걸지 않는다 */
export const LOGIN_WAIT_MS = 10 * 60_000;
/** 내장 팝업 로그인(OMAI-1911): 승인을 묻는 간격과 최대 시간. 서버의 embed_login 행도 5분이면 끝난다 */
export const POPUP_LOGIN_POLL_MS = 2_000;
export const POPUP_LOGIN_MAX_MS = 5 * 60_000;

/** 32바이트 무작위 값의 base64url(패딩 없이 43자) */
export function randomToken(): string {
  const b = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** 교환 실패의 HTTP 응답 → 상태·콘솔 코드 */
export function classifyHttp(status: number, code: string): { status: WidgetStatus; log: ErrorCode | null } {
  // token_mismatch 는 설정이 틀린 401 이다 — 다시 로그인해도 풀리지 않아 「로그인」을 보이지 않는다(OMAI-1908). 옛 서버는 token_invalid 하나만 준다
  if (status === 401) return code === 'token_mismatch' ? { status: 'auth_config', log: 'token_mismatch' } : { status: 'login', log: 'token_invalid' };
  if (status === 403) {
    if (/origin/.test(code) || !code) return { status: 'origin', log: 'origin_not_registered' };
    if (code === 'auth_disabled') return { status: 'connect_check', log: 'auth_disabled' }; // 로그인을 끈 AAS 는 위젯을 받지 않는다
    return { status: 'not_user', log: 'user_unknown' };
  }
  if (status === 429) return { status: 'rate_limited', log: 'rate_limited' };
  if (status === 503) return { status: 'idp', log: 'idp_unreachable' };
  return { status: 'connect_check', log: 'unreachable' };
}

export class EmbedSession {
  readonly tokens: TokenSession;
  private everLive = false;
  private diagnosing = false;
  private reauthing: Promise<void> | null = null;
  private loggingIn: Promise<void> | null = null;
  /** 진행 중인 내장 팝업 로그인을 끊는다(폴링·message 리스너). destroy 가 부른다 */
  private endPopup: (() => void) | null = null;
  /** destroy 마다 오른다. start 가 destroyed 를 되돌리므로 「로그인」을 기다리던 옛 시도를 이것으로 가린다 */
  private generation = 0;
  /** 마지막으로 처리한 실패. 같은 교환을 connect·onUnauthorized 가 함께 기다리면 같은 오류가 두 번 온다 */
  private lastFailure: unknown = null;
  private destroyed = false;
  private unState: (() => void) | null = null;

  constructor(private deps: SessionDeps) {
    this.tokens = new TokenSession({
      config: () => this.cfg,
      fetchImpl: deps.fetchImpl,
      doc: deps.doc,
      onChange: (ex, prev, userChanged) => this.onToken(ex, prev, userChanged),
      onFailure: (e) => this.failSafely(e),
    });
  }

  private get cfg(): ResolvedConfig {
    return this.deps.store.get().config;
  }

  private setStatus(status: WidgetStatus) {
    if (this.deps.store.get().status !== status) this.deps.store.set({ status });
  }

  /** 처음 고를 AI 에이전트: 위젯 설정의 agent, 없으면 임베드 앱에 등록한 기본 AI 에이전트 */
  private preferred(): string {
    return this.cfg.agent || this.tokens.current?.agent || '';
  }

  /** 지금 고른 AI 에이전트(작업공간). 대화 묶음을 읽기 전에는 처음 고를 값 */
  pod(): string {
    return this.deps.chat.status?.pod || this.preferred();
  }

  /** 대화할 AI 에이전트가 없는가(OMAI-1873):
   *  - 대화 묶음에 작업공간(pod)이 하나도 없다. 서버는 「연결된 작업공간이 없습니다」를 pod 없는 오류 묶음으로 준다 — 그것을 대화로 띄우지 않는다
   *  - 작업공간은 있는데 AI 에이전트가 없고 오류도 없다(오류가 있는 작업공간은 멈춤·준비 중 안내를 대화 화면이 보인다)
   *  웹소켓 authed 의 pod 는 위젯이 auth 에 실은 값을 돌려줄 뿐이라(첫 auth 는 목록을 읽기 전이라 비어 있다) 판단에 쓰지 않는다 */
  private noAgent(): boolean {
    const groups = this.deps.chat.groups;
    if (!groups.some((g) => !!g.pod)) return true;
    return !groups.some((g) => (g.agents ?? []).length > 0) && !groups.some((g) => g.error);
  }

  /** 요청 계층을 위젯용으로 바꾸고 첫 교환을 한다 */
  async start(): Promise<void> {
    this.destroyed = false;
    this.everLive = false;
    const cfg = this.cfg;
    if ((this.deps.pageProtocol?.() ?? location.protocol) === 'https:' && cfg.backendUrl.startsWith('http:')) {
      logError('mixed_content', cfg.backendUrl);
      this.setStatus('mixed');
      return;
    }
    configureApi({
      baseUrl: cfg.backendUrl,
      embed: true,
      wsOnly: true,
      authHeader: () => (this.tokens.token ? `Bearer ${this.tokens.token}` : null),
      extraQuery: () => {
        const q: Record<string, string> = {};
        const sticky = this.tokens.current?.sticky;
        if (sticky) q.aasu = sticky;
        const pod = this.pod();
        if (pod) q.pod = pod;
        return q;
      },
      wsAuth: () => (this.tokens.token ? { token: this.tokens.token, pod: this.pod() || undefined } : null),
      onUnauthorized: () => void this.onUnauthorized(),
      onRateLimited: () => {
        logError('rate_limited');
        this.deps.store.set({ notice: 'rateLimited' });
      },
      onWsClose: (code, reason, welcomed) => this.onWsClose(code, reason, welcomed),
    });
    this.unState ??= this.deps.ws.onState(() => {
      if (this.deps.ws.state === 'live') this.everLive = true;
    });
    await this.connect();
  }

  /** 교환하고 대화를 연다. 실패하면 상태를 바꾼다 */
  async connect(): Promise<void> {
    this.setStatus('connecting');
    try {
      await this.tokens.refresh();
    } catch (e) {
      await this.failSafely(e);
    }
  }

  /** 실패 처리가 거부되지 않게 한다 — 버튼·타이머처럼 기다리는 쪽이 없는 경로에서 처리되지 않은 거부가 남지 않게 */
  private failSafely(e: unknown): Promise<void> {
    return this.fail(e as ExchangeError).catch((err) => logError('internal_error', String((err as Error)?.message ?? err)));
  }

  /**
   * 「로그인」(OMAI-1908): 호스트의 onLoginRequired 를 부르고, 끝나면(성공·실패 모두) 다시 교환한다.
   * 콜백이 없고 마지막 401 이 popup_login 이면 내장 팝업 로그인을 연다(OMAI-1911).
   * 콜백·window.open 은 첫 await 전에 동기로 부른다 — 클릭 처리가 끝난 뒤 window.open 을 부르면 브라우저가 팝업을 막는다.
   * 진행 중이면 같은 시도를 돌려준다(두 번 눌러 팝업이 둘 뜨지 않게).
   */
  login(): Promise<void> {
    if (this.loggingIn) return this.loggingIn;
    const p = this.runLogin().finally(() => {
      if (this.loggingIn === p) this.loggingIn = null;
    });
    this.loggingIn = p;
    return p;
  }

  private async runLogin(): Promise<void> {
    if (this.destroyed) return;
    const gen = this.generation;
    const cb = this.cfg.onLoginRequired;
    if (typeof cb === 'function') {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const late = new Promise<'timeout'>((r) => (timer = setTimeout(() => r('timeout'), LOGIN_WAIT_MS)));
        const r = await Promise.race([Promise.resolve(cb()).then(() => 'done' as const), late]); // cb() 는 여기서 동기로 불린다
        if (r === 'timeout') logError('login_callback_timeout', `${LOGIN_WAIT_MS / 60_000} min`);
      } catch (e) {
        logError('login_callback_failed', String((e as Error)?.message ?? e));
      } finally {
        clearTimeout(timer);
      }
      if (this.destroyed || gen !== this.generation) return;
      // 기다리는 사이 쿠키 폴링·updateConfig 가 먼저 교환에 성공했다 — 다시 교환하면 connecting 을 거쳐 대화창이 내려간다
      if (this.deps.store.get().status !== 'login') return;
    } else if (this.deps.store.get().popupLogin) return this.popupLogin(gen);
    await this.connect();
  }

  /**
   * 내장 팝업 로그인(OMAI-1911). nonce(공개)·verifier(비밀)를 만들고 같은 틱에 /embed/login 창을 연다.
   * 연결 화면이 {aasEmbedLogin: nonce} 를 보내면 AAS 출처·nonce 가 맞을 때만 verifier 를 답한다 — 승인은 이 위젯이 연 창에서만 된다.
   * 2초마다 {login, verifier} 로 묻고 5분이면 멈춘다. popup.closed 는 보지 않는다(COOP 로 opener 가 끊기면 늘 닫힌 것으로 보인다).
   */
  private popupLogin(gen: number): Promise<void> {
    const backend = this.cfg.backendUrl;
    let aasOrigin: string;
    try {
      aasOrigin = new URL(backend).origin;
    } catch {
      logError('unreachable', backend);
      return Promise.resolve();
    }
    const nonce = randomToken();
    const verifier = randomToken();
    const open = this.deps.openWindow ?? ((u: string, n: string, f: string) => window.open(u, n, f));
    const win = open(`${backend}/embed/login?o=${encodeURIComponent(location.origin)}&n=${nonce}`, 'aas-embed-login', 'width=520,height=700');
    if (!win) {
      logError('login_popup_blocked', backend);
      return Promise.resolve();
    }
    const target = this.deps.messageTarget ?? window;
    const onMessage = (e: MessageEvent) => {
      if (e.origin !== aasOrigin || !e.source) return;
      const d = e.data as { aasEmbedLogin?: unknown } | null;
      if (!d || typeof d !== 'object' || d.aasEmbedLogin !== nonce) return;
      (e.source as Window).postMessage({ aasEmbedLogin: nonce, verifier }, e.origin);
    };
    target.addEventListener('message', onMessage);
    const deadline = Date.now() + POPUP_LOGIN_MAX_MS;
    return new Promise<void>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = () => {
        clearTimeout(timer);
        target.removeEventListener('message', onMessage);
        if (this.endPopup === finish) this.endPopup = null;
        resolve();
      };
      this.endPopup = finish;
      const tick = async () => {
        if (this.destroyed || gen !== this.generation) return finish();
        const st = this.deps.store.get().status;
        if (st === 'ready' || st === 'no_agent') return finish(); // 다른 경로(쿠키·updateConfig)로 먼저 연결됐다
        if (Date.now() >= deadline) {
          logError('login_expired');
          return finish();
        }
        try {
          if (await this.tokens.redeemLogin(nonce, verifier)) return finish(); // onChange 가 대화를 연다
        } catch (e) {
          if (this.destroyed || gen !== this.generation) return finish();
          // 401(만료·모름·verifier 불일치)·403 은 다시 물어도 같다 — 「로그인」으로 돌아간다. 네트워크·429·5xx 는 다음에 다시 묻는다
          if (e instanceof ExchangeError && e.kind === 'http' && (e.status === 401 || e.status === 403)) {
            finish();
            return void (await this.failSafely(e));
          }
        }
        if (this.endPopup === finish) timer = setTimeout(() => void tick(), POPUP_LOGIN_POLL_MS);
      };
      timer = setTimeout(() => void tick(), POPUP_LOGIN_POLL_MS);
    });
  }

  private async fail(e: ExchangeError): Promise<void> {
    if (this.destroyed) return;
    if (e === this.lastFailure) return; // 같은 교환의 같은 실패 — 한 번만 처리한다
    this.lastFailure = e;
    if (!(e instanceof ExchangeError)) {
      logError('unreachable', String(e));
      return this.setStatus('connect_check');
    }
    if (e.kind === 'http') {
      const c = classifyHttp(e.status, e.code);
      if (c.log) logError(c.log, `${e.status}${e.code ? ' ' + e.code : ''}`);
      if (e.status === 401 && this.deps.store.get().popupLogin !== e.popupLogin) this.deps.store.set({ popupLogin: e.popupLogin }); // 「로그인」을 보일지(OMAI-1911)
      return this.setStatus(c.status);
    }
    await this.diagnose();
  }

  /** 응답이 없었다 — 인증서인지 사전 요청(출처 설정)인지 가린다 */
  private async diagnose(fromWs = false): Promise<void> {
    if (this.diagnosing) return;
    this.diagnosing = true;
    try {
      const cause = await diagnoseNoResponse(this.cfg.backendUrl, this.deps.fetchImpl);
      if (this.destroyed) return;
      if (cause !== 'cert' && fromWs) return; // 웹소켓만 안 열린다 — 재연결 줄이 보이고, 원인은 서버 쪽이라 상태를 바꾸지 않는다
      if (cause !== 'cert') {
        logError('unreachable', cause === 'cors' ? 'no-cors /healthz answered; check the embed app origin' : this.cfg.backendUrl);
        return this.setStatus('connect_check');
      }
      logError('cert_required', this.cfg.backendUrl);
      this.setStatus('cert');
      const box = this.deps.certContainer();
      if (!box) return;
      const r = await (this.deps.promptCert ?? promptCertApproval)(this.cfg.backendUrl, box);
      if (r.approved && !this.destroyed) {
        this.deps.ws.reconnect();
        await this.connect();
      }
    } finally {
      this.diagnosing = false;
    }
  }

  private onToken(ex: Exchange, prev: Exchange | null, userChanged: boolean) {
    if (this.destroyed) return;
    if (!ex.ws) {
      logError('ws_unsupported');
      return this.setStatus('ws_off');
    }
    if (!protocolAccepts(ex.protocol)) {
      logError('version_mismatch', JSON.stringify(ex.protocol));
      return this.setStatus('version');
    }
    const ws = this.deps.ws;
    if (!prev || userChanged) {
      if (userChanged) {
        // 다른 사람의 대화를 그대로 보이지 않는다 — 닫고 새로 연다
        this.deps.chat.resetAll();
        this.deps.store.set({ notice: 'userChanged', epoch: this.deps.store.get().epoch + 1 });
      }
      ws.configure(true, this.preferred() || undefined);
      ws.reconnect(); // 새 사용자·새 토큰으로 연결을 새로 연다(첫 메시지가 auth)
      void this.openAgent();
      return;
    }
    if (prev.sticky !== ex.sticky || ws.state === 'auth-failed') ws.reconnect(); // 다른 서버로 고정됐거나 4401 로 닫혔다
    else ws.reauth(); // 같은 연결에 새 토큰을 다시 보낸다 — 연결을 끊지 않는다
    const st = this.deps.store.get().status;
    if (st !== 'ready' && st !== 'no_agent') this.setStatus(this.noAgent() ? 'no_agent' : 'ready');
  }

  /** 첫 AI 에이전트를 연다(설정의 agent·앱의 기본 AI 에이전트가 허용 목록에 있으면 그것). 쓸 AI 에이전트가 없으면 대화 대신 상태 표의 「AI 에이전트 없음」 */
  async openAgent(pod?: string): Promise<void> {
    const chat = this.deps.chat;
    await chat.openAgent(this.cfg.profile || PRIMARY, pod ?? (this.preferred() || undefined));
    if (this.destroyed) return;
    if (chat.status?.pod) this.deps.ws.pod = chat.status.pod;
    this.setStatus(this.noAgent() ? 'no_agent' : 'ready');
  }


  /** 고른 AI 에이전트로 바꾼다. 웹소켓의 pod 도 다시 알린다 */
  async pickAgent(pod: string, profile?: string): Promise<void> {
    await this.deps.chat.openAgent(profile || PRIMARY, pod);
    this.deps.ws.pod = pod;
    this.deps.ws.reauth();
  }

  /** REST·웹소켓이 401 — 한 번 다시 교환하고, 그것도 안 되면 로그인 안내 */
  onUnauthorized(): Promise<void> {
    if (this.reauthing) return this.reauthing;
    const p = this.tokens
      .refresh()
      .then(() => undefined)
      .catch((e) => this.failSafely(e))
      .finally(() => {
        this.reauthing = null;
      });
    this.reauthing = p;
    return p;
  }

  private onWsClose(code: number, reason: string, welcomed: boolean) {
    if (this.destroyed) return;
    if (code === 4401 && reason === 'user_changed') {
      // 같은 연결의 사용자가 바뀌었다 — 열린 대화를 닫고 처음부터 다시 교환해 새로 연다. 이어 오는 401 처리(onUnauthorized)는 같은 교환을 기다린다
      this.deps.chat.resetAll();
      this.deps.store.set({ notice: 'userChanged', epoch: this.deps.store.get().epoch + 1 });
      this.tokens.stop();
      void this.connect();
      return;
    }
    // 4401 token_expired·token_ended·token_invalid·auth_timeout 은 웹소켓이 onUnauthorized 를 불러 다시 교환한 뒤 다시 연결한다
    if (code === 1013 && reason === 'rate_limited') {
      logError('rate_limited', 'websocket');
      this.deps.store.set({ notice: 'rateLimited' });
      return;
    }
    if (code === 4403 && reason === 'origin') {
      logError('origin_not_registered', 'websocket');
      return this.setStatus('origin');
    }
    // 한 번도 열리지 못하고 끊겼다 — 인증서인지 가린다. 한 번 열린 뒤의 끊김은 기존 재연결 규칙을 따른다
    if (!welcomed && !this.everLive && code !== 4401 && code !== 1000) void this.diagnose(true);
  }

  /** resetUserSession: 임베드 토큰을 버리고 다시 교환한다 */
  async resetUserSession(): Promise<void> {
    const verifier = this.tokens.loginVerifier;
    const old = this.tokens.stop();
    if (old) void revoke(this.cfg.backendUrl, old.token, this.deps.fetchImpl, verifier);
    resetCertCheck();
    this.everLive = false;
    this.deps.chat.resetAll();
    this.deps.store.set({ epoch: this.deps.store.get().epoch + 1 });
    this.deps.ws.configure(false);
    await this.connect();
  }

  destroy(): void {
    this.destroyed = true;
    this.generation++;
    this.endPopup?.(); // 내장 팝업 로그인의 폴링·리스너를 끊는다(OMAI-1911)
    const verifier = this.tokens.loginVerifier;
    const old = this.tokens.stop();
    if (old) void revoke(this.cfg.backendUrl, old.token, this.deps.fetchImpl, verifier);
    this.unState?.();
    this.deps.ws.configure(false);
    this.deps.chat.resetAll();
    resetApi();
  }
}

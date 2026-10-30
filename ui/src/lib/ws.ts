/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 브라우저와 서버 사이 웹소켓 연결 관리자(OMAI-1100). 탭마다 연결 하나에 토픽 구독을 다중화한다.
// React 밖 모듈 전역에 하나만 둔다(StrictMode 가 두 번 마운트해도 연결은 하나). 화면은 useTopic·useWsState 로만 쓴다.
//
// - `welcome` 을 받아야 live 다. 열리자마자 닫히는 연결을 성공으로 치면 백오프가 0 으로 돌아가 재시도가 몰린다.
// - 브라우저는 핸드셰이크의 HTTP 상태 코드를 볼 수 없다. 서버는 받아들인 뒤 앱 close 코드(4401·4403·4409·1012·1013)로 이유를 알린다.
// - welcome 전에 닫히는 일이 3번 이어지면 /healthz 를 확인한다. HTTP 는 되는데 웹소켓만 안 되면 HTTP 대체로 내리고,
//   HTTP 도 안 되면(배포 중 503 등) 서버가 없는 것이므로 백오프로 다시 시도한다.
// - 백오프 0.5초→30초 ±20%, 횟수 제한 없음. 1분 동안 live 였으면 처음으로 돌린다.
// - 마지막으로 무엇이든 받은 뒤 45초가 지나면 죽은 연결로 보고 닫는다(서버는 20초마다 hb 를 보낸다).
// - 4409(같은 사용자의 탭이 상한을 넘음)로 닫힌 탭은 자동으로 다시 붙지 않는다. continueHere() 로 다시 붙는다.
import { useEffect, useState, useSyncExternalStore } from 'react';

import { getLang } from '@/i18n';

import { api } from './api';
import { backoffDelay } from './backoff';

export type WsState = 'off' | 'connecting' | 'live' | 'retrying-fast' | 'retrying-slow' | 'auth-failed' | 'fallback-http' | 'replaced';

type Listener = (data: unknown, meta: { seq: number; stale?: boolean; error?: string }) => void;

interface Msg {
  v: number;
  t: string;
  topic?: string;
  seq?: number;
  data?: unknown;
  stale?: boolean;
  error?: unknown;
  code?: number | string;
  reason?: string;
  retry_after_ms?: number;
  server?: number;
  id?: string;
  ok?: boolean;
}

export interface WsDeps {
  WebSocketImpl: typeof WebSocket;
  fetchImpl: typeof fetch;
  url: () => string | null;
  toLogin: () => void;
}

const CONNECT_TIMEOUT = 10000;
const SILENCE_TIMEOUT = 45000;
const PING_EVERY = 25000;
const UNSUB_DELAY = 300;
const FALLBACK_RETRY = 5 * 60000;
const RESET_AFTER = 60000;
const MAX_BACKOFF = 30000;
const SLOW_AFTER_TRIES = 5;
const SLOW_AFTER_MS = 10000;
/** live 를 떠난 뒤 이만큼 지나면 화면이 「연결 대기」를 보인다(스펙 2026-10-20-030 DR1). 짧은 끊김에는 아무것도 보이지 않는다 */
export const CONN_WAIT_MS = 2000;
const WAIT_STATES: WsState[] = ['connecting', 'retrying-fast', 'retrying-slow'];

function defaultUrl(): string | null {
  if (typeof location === 'undefined' || !location.host) return null;
  return (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws';
}

export class WsClient {
  state: WsState = 'off';
  /** 지금 보고 있는 POD(채팅 토픽 이름에 넣는다). */
  pod = '';
  private enabled = false;
  private errorListeners = new Map<string, Set<(code: string) => void>>();
  private sock: WebSocket | null = null;
  private gen = 0;
  private listeners = new Map<string, Set<Listener>>();
  private lastSeq = new Map<string, number>();
  /** 토픽마다 마지막 snap(그 뒤 delta 가 오지 않았을 때만). 같은 토픽을 나중에 구독한 리스너에게 곧바로 넘긴다(스펙 2026-10-17-004 L2). */
  private lastSnap = new Map<string, { data: unknown; meta: { seq: number; stale?: boolean; error?: string } }>();
  private unsubTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private stateListeners = new Set<() => void>();
  private tries = 0;
  private earlyCloses = 0;
  private policyCloses = 0;
  private downSince = 0;
  private lastRecv = 0;
  private liveSince = 0;
  private serverEpoch = 0;
  private timers: ReturnType<typeof setTimeout>[] = [];
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private watch: ReturnType<typeof setInterval> | null = null;
  private pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private reqId = 0;
  private bound = false;
  /** 서버가 거절했거나 끝난 토픽. 같은 이름을 다시 구독하면 sub 를 다시 보낸다(대화를 다시 연 뒤, 스펙 2026-10-20-030) */
  private refused = new Set<string>();
  /** live 를 떠난 시각(0 이면 live 이거나 아직 한 번도 live 가 아니었다). pagehide 로 떠난 것은 세지 않는다(재검토 2026-10-21) */
  private leftLiveAt = 0;
  private everLive = false;
  private quietLeave = false;

  constructor(private deps: WsDeps) {}

  // ---- 바깥에 보이는 것 ------------------------------------------------------
  /** 서버가 웹소켓을 켰는가(/api/me 의 ws). 꺼져 있으면 연결하지 않고 화면은 HTTP 로 읽는다. */
  configure(enabled: boolean, pod?: string): void {
    this.pod = pod ?? this.pod;
    if (enabled === this.enabled) return;
    this.enabled = enabled;
    if (enabled) {
      this.bindWindow();
      if (this.listeners.size) this.connect();
    } else {
      this.teardown(1000);
      this.setState('off');
    }
  }

  /** 연결을 새로 연다. 연결 읽기(req)는 연결을 열 때의 쿠키로 처리되므로, 쿠키로 정하는 값(aas_pod)을 HTTP 로 바꾼 뒤 부른다.
   *  서버의 ws.pod_changed 는 그 요청을 받은 서버 파드의 연결만 고친다 — 파드가 둘이면 다른 파드에 붙은 연결은 옛 에이전트로 읽었다
   *  (2026-10-19 OKE 시험, 스펙 2026-10-19-001). 다시 붙는 동안의 읽기는 HTTP 로 간다(get 은 live 일 때만 req). 구독은 hello 로 이어 받는다 */
  reconnect(): void {
    if (this.enabled) this.connect();
  }

  /** 화면 언어를 바꿨다. 연결 읽기(req)와 언어별 토픽은 hello 의 언어로 번역되므로 연결을 새로 연다. 옛 언어로 받은 seq 를
   *  이어 받으면 새 언어 스냅샷을 건너뛰므로 비운다(스펙 2026-10-21-007, 새로 고침해야 영어로 바뀌던 문제) */
  changeLang(): void {
    this.lastSeq.clear();
    this.lastSnap.clear();
    this.reconnect();
  }

  /** 서버가 웹소켓을 켰고 이 클라이언트가 쓰는 중인가. 거짓이면 화면은 HTTP(EventSource·폴링)로 읽는다. */
  get usable(): boolean {
    return this.enabled && this.state !== 'fallback-http';
  }

  /** welcome 의 서버 번호. 바뀌면 서버가 다시 시작됐다 — 채팅은 대화를 다시 연다(스펙 2026-10-20-030 R4) */
  get epoch(): number {
    return this.serverEpoch;
  }

  /** 연결을 기다리는 중인가: 다시 붙는 중이고 live 를 떠난 지 CONN_WAIT_MS 가 지났다. HTTP 대체·대체됨·로그인 만료는 아니다 */
  connWaiting(now = Date.now()): boolean {
    return this.enabled && WAIT_STATES.includes(this.state) && this.leftLiveAt > 0 && now - this.leftLiveAt >= CONN_WAIT_MS;
  }

  /** 연결 대기가 시작되는(된) 시각. 기다릴 일이 없으면 0 — 화면이 이 시각에 다시 그린다 */
  connWaitAt(): number {
    return this.enabled && WAIT_STATES.includes(this.state) && this.leftLiveAt > 0 ? this.leftLiveAt + CONN_WAIT_MS : 0;
  }

  subscribe(topic: string, fn: Listener, onError?: (code: string) => void): () => void {
    if (onError) {
      let es = this.errorListeners.get(topic);
      if (!es) this.errorListeners.set(topic, (es = new Set()));
      es.add(onError);
    }
    const timer = this.unsubTimers.get(topic);
    if (timer) {
      clearTimeout(timer);
      this.unsubTimers.delete(topic);
    }
    let set = this.listeners.get(topic);
    const fresh = !set;
    if (!set) {
      set = new Set();
      this.listeners.set(topic, set);
    }
    set.add(fn);
    const snap = fresh ? undefined : this.lastSnap.get(topic);
    if (snap) {
      // 서버는 같은 연결의 두 번째 구독을 따로 알리지 않는다 — 앞 리스너가 받은 값을 넘긴다
      queueMicrotask(() => {
        if (this.listeners.get(topic)?.has(fn) && this.lastSnap.get(topic) === snap) fn(snap.data, snap.meta);
      });
    }
    if (fresh || this.refused.has(topic)) {
      if (this.state === 'live') {
        this.refused.delete(topic);
        this.send({ v: 1, t: 'sub', topic, after: this.lastSeq.get(topic) });
      } else if (this.enabled && this.state === 'off') this.connect(); // 다시 시도를 기다리는 중이면 백오프를 지킨다
    }
    return () => {
      if (onError) this.errorListeners.get(topic)?.delete(onError);
      const s = this.listeners.get(topic);
      if (!s) return;
      s.delete(fn);
      if (s.size) return;
      // 화면 이동 때 해지·재구독이 반복되지 않게 300ms 미룬다
      this.unsubTimers.set(
        topic,
        setTimeout(() => {
          this.unsubTimers.delete(topic);
          if (this.listeners.get(topic)?.size) return;
          this.listeners.delete(topic);
          this.lastSeq.delete(topic);
          this.lastSnap.delete(topic);
          this.refused.delete(topic);
          if (this.state === 'live') this.send({ v: 1, t: 'unsub', topic });
        }, UNSUB_DELAY)
      );
    };
  }

  /** 4409 로 닫힌 탭을 다시 붙인다. 서버는 상한 규칙대로 가장 오래된 다른 연결을 닫는다. */
  continueHere(): void {
    if (this.state !== 'replaced' && this.state !== 'fallback-http') return;
    this.tries = 0;
    this.connect();
  }

  request<T = unknown>(method: string, params: Record<string, unknown> = {}, timeout = 15000): Promise<T> {
    if (this.state !== 'live') return Promise.reject(new Error('ws_not_live'));
    const id = String(++this.reqId);
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('ws_timeout'));
      }, timeout);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      this.send({ v: 1, t: 'req', id, method, params });
    });
  }

  /** 서버에 값을 올린다(지금은 토픽 office:presence 의 내 아바타 위치만, 계획 007 P6b). 연결이 없으면 보내지 않고 거짓. */
  publish(topic: string, data: Record<string, unknown>): boolean {
    if (this.state !== 'live') return false;
    this.send({ v: 1, t: 'pub', topic, data });
    return true;
  }

  onState(fn: () => void): () => void {
    this.stateListeners.add(fn);
    return () => this.stateListeners.delete(fn);
  }

  // ---- 연결 -------------------------------------------------------------------
  private setState(s: WsState): void {
    if (this.state === s) return;
    if (s === 'live') {
      this.leftLiveAt = 0;
      this.everLive = true;
    } else if (this.state === 'live') this.leftLiveAt = this.quietLeave ? 0 : Date.now();
    this.state = s;
    this.stateListeners.forEach((fn) => fn());
  }

  private connect(): void {
    if (!this.enabled) return;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    const url = this.deps.url();
    if (!url) return; // 주소를 만들 수 없으면 연결하지 않는다(new WebSocket(null) 무한 재시도 방지)
    this.teardown(1000);
    const gen = ++this.gen;
    let sock: WebSocket;
    try {
      sock = new this.deps.WebSocketImpl(url);
    } catch {
      this.scheduleRetry(gen, false);
      return;
    }
    this.sock = sock;
    if (this.state !== 'retrying-slow' && this.state !== 'retrying-fast') this.setState('connecting');
    this.lastRecv = Date.now();
    let welcomed = false;
    const connectTimer = setTimeout(() => {
      if (gen === this.gen && !welcomed) this.dropSocket(gen, false); // CONNECTING 에서 멈춘 소켓은 버린다
    }, CONNECT_TIMEOUT);
    this.timers.push(connectTimer);
    sock.onopen = () => {
      if (gen !== this.gen) return;
      const resume = [...this.listeners.keys()].map((topic) => ({ topic, after: this.lastSeq.get(topic) }));
      this.send({ v: 1, t: 'hello', lang: getLang(), client: 'aas-ui', resume });
    };
    sock.onmessage = (ev: MessageEvent) => {
      if (gen !== this.gen) return; // 옛 소켓에서 늦게 온 메시지는 버린다
      this.lastRecv = Date.now();
      let msg: Msg;
      try {
        msg = JSON.parse(String(ev.data)) as Msg;
      } catch {
        return;
      }
      if (msg.t === 'welcome') {
        welcomed = true;
        clearTimeout(connectTimer);
        this.onWelcome(msg);
      } else this.dispatch(msg, gen);
    };
    sock.onclose = (ev: CloseEvent) => {
      if (gen !== this.gen) return;
      clearTimeout(connectTimer);
      this.onClose(gen, ev.code, welcomed);
    };
    sock.onerror = () => {
      /* onclose 가 이어서 온다 */
    };
  }

  private onWelcome(msg: Msg): void {
    if (this.serverEpoch && msg.server !== this.serverEpoch) {
      this.lastSeq.clear(); // 서버가 바뀌었다 — 스냅샷부터 다시
      this.lastSnap.clear();
    }
    this.serverEpoch = msg.server ?? 0;
    this.earlyCloses = 0;
    this.policyCloses = 0;
    this.liveSince = Date.now();
    this.downSince = 0;
    this.setState('live');
    if (!this.watch) {
      this.watch = setInterval(() => this.tick(), 5000);
    }
  }

  private tick(): void {
    const now = Date.now();
    if (this.state !== 'live') return;
    if (now - this.lastRecv > SILENCE_TIMEOUT) {
      this.dropSocket(this.gen, true); // 45초 동안 아무것도 못 받았다 — 반쯤 열린 연결
      return;
    }
    if (this.liveSince && now - this.liveSince > RESET_AFTER) this.tries = 0;
    if (now - this.lastSentPing > PING_EVERY) this.ping();
  }

  private lastSentPing = 0;

  private ping(): void {
    this.lastSentPing = Date.now();
    this.send({ v: 1, t: 'ping', ts: this.lastSentPing });
  }

  private dispatch(msg: Msg, gen: number): void {
    if (msg.t === 'snap' && msg.topic) {
      const set = this.listeners.get(msg.topic);
      const seq = msg.seq ?? 0;
      this.lastSeq.set(msg.topic, seq);
      const meta = { seq, stale: msg.stale, error: typeof msg.error === 'string' ? msg.error : undefined };
      this.lastSnap.set(msg.topic, { data: msg.data, meta });
      set?.forEach((fn) => fn(msg.data, meta));
    } else if (msg.t === 'delta' && msg.topic) {
      this.lastSnap.delete(msg.topic); // 이벤트 토픽: 스냅샷만 넘기면 그 뒤 이벤트가 빠진다
      const last = this.lastSeq.get(msg.topic);
      const seq = msg.seq ?? 0;
      if (last !== undefined && seq <= last) return; // 중복
      if (last !== undefined && seq !== last + 1) {
        // 건너뛰었다 — 다시 구독해 스냅샷을 받는다
        this.lastSeq.delete(msg.topic);
        this.send({ v: 1, t: 'unsub', topic: msg.topic });
        this.send({ v: 1, t: 'sub', topic: msg.topic });
        return;
      }
      this.lastSeq.set(msg.topic, seq);
      if ((msg as { skip?: boolean }).skip) return; // 이 사람에게 보이지 않는 이벤트 — 번호만 넘긴다
      this.listeners.get(msg.topic)?.forEach((fn) => fn(msg.data, { seq }));
    } else if (msg.t === 'gap' && msg.topic) {
      this.lastSeq.delete(msg.topic);
      this.lastSnap.delete(msg.topic);
    } else if (msg.t === 'res' && msg.id) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      clearTimeout(p.timer);
      this.pending.delete(msg.id);
      if (msg.ok) p.resolve(msg.data);
      else p.reject(new Error(((msg.error as { code?: string }) ?? {}).code ?? 'ws_error'));
    } else if (msg.t === 'bye') {
      this.lastBye = msg;
    } else if (msg.t === 'error' && msg.topic) {
      const code = String(msg.code ?? 'error');
      this.lastSnap.delete(msg.topic);
      this.refused.add(msg.topic);
      this.errorListeners.get(msg.topic)?.forEach((fn) => fn(code));
    }
    void gen;
  }

  private lastBye: Msg | null = null;

  private onClose(gen: number, code: number, welcomed: boolean): void {
    const bye = this.lastBye;
    this.lastBye = null;
    const reason = bye?.reason ?? '';
    this.sock = null;
    this.failPending();
    if (!this.enabled) return;
    if (code === 4401) {
      this.setState('auth-failed');
      this.deps.toLogin();
      return;
    }
    if (code === 4409) {
      this.setState('replaced');
      return;
    }
    if (code === 4403 && reason === 'origin') {
      this.goFallback();
      return;
    }
    if (code === 1000) return;
    if (code === 1007 || code === 1008) {
      if (++this.policyCloses >= 3) {
        console.warn('[ws] closed 3 times for the same policy reason; reading over HTTP', reason);
        this.goFallback();
        return;
      }
    }
    if (!welcomed && code !== 1012) this.earlyCloses += 1;
    if (this.earlyCloses >= 3) {
      this.earlyCloses = 0;
      void this.probe(gen);
      return;
    }
    const wait = code === 1012 && bye?.retry_after_ms ? bye.retry_after_ms : undefined;
    this.scheduleRetry(gen, true, wait);
  }

  /** welcome 전에 3번 닫혔다: HTTP 로 서버가 살아 있으면 웹소켓만 막힌 것(프록시)이므로 HTTP 로 내린다. */
  private async probe(gen: number): Promise<void> {
    let httpOk = false;
    try {
      const r = await this.deps.fetchImpl('/healthz', { cache: 'no-store' });
      httpOk = r.ok;
    } catch {
      httpOk = false;
    }
    if (gen !== this.gen || !this.enabled) return;
    if (httpOk) this.goFallback();
    else this.scheduleRetry(gen, true);
  }

  private goFallback(): void {
    this.setState('fallback-http');
    this.clearRetry();
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.tries = 0;
      this.connect();
    }, FALLBACK_RETRY);
  }

  private scheduleRetry(gen: number, counted: boolean, waitMs?: number): void {
    if (gen !== this.gen) return;
    if (!this.downSince) this.downSince = Date.now();
    if (counted) this.tries += 1;
    const delay = waitMs ?? backoffDelay(this.tries, { base: 500, max: MAX_BACKOFF });
    const slow = this.tries >= SLOW_AFTER_TRIES || Date.now() - this.downSince >= SLOW_AFTER_MS;
    this.setState(slow ? 'retrying-slow' : 'retrying-fast');
    this.clearRetry();
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return; // online 이벤트를 기다린다
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.connect();
    }, delay);
  }

  private clearRetry(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  // onclose 를 기다리지 않는다: 처리기를 떼고 세대를 올린 뒤 새 소켓을 연다(CLOSING 에서 멈춘 소켓이 재연결을 막지 않는다).
  private dropSocket(gen: number, counted: boolean): void {
    const sock = this.sock;
    if (sock) {
      sock.onopen = sock.onmessage = sock.onclose = sock.onerror = null;
      try {
        sock.close(4000);
      } catch {
        /* 이미 닫혔다 */
      }
    }
    this.sock = null;
    this.gen += 1; // 옛 소켓의 늦은 사건은 모두 버린다
    this.failPending();
    this.scheduleRetry(this.gen, counted);
    void gen;
  }

  private teardown(code: number): void {
    this.clearRetry();
    this.timers.forEach(clearTimeout);
    this.timers = [];
    const sock = this.sock;
    this.sock = null;
    this.gen += 1;
    if (sock) {
      sock.onopen = sock.onmessage = sock.onclose = sock.onerror = null;
      try {
        sock.close(code);
      } catch {
        /* 이미 닫혔다 */
      }
    }
    this.failPending();
  }

  private failPending(): void {
    this.pending.forEach((p) => {
      clearTimeout(p.timer);
      p.reject(new Error('ws_retryable'));
    });
    this.pending.clear();
  }

  private send(obj: Record<string, unknown>): void {
    const sock = this.sock;
    if (!sock || sock.readyState !== 1) return;
    try {
      sock.send(JSON.stringify(obj));
    } catch {
      /* onclose 가 이어서 온다 */
    }
  }

  // ---- 창 사건 -----------------------------------------------------------------
  private bindWindow(): void {
    if (this.bound || typeof window === 'undefined') return;
    this.bound = true;
    const wake = () => {
      if (!this.enabled) return;
      if (this.state === 'retrying-fast' || this.state === 'retrying-slow' || (this.state === 'connecting' && !this.sock)) {
        this.tries = 0;
        this.downSince = 0;
        // pagehide 로 떠났다 돌아왔으면 여기서부터 센다 — 곧 다시 붙으면 「연결 대기」가 나오지 않는다
        if (this.everLive && !this.leftLiveAt) this.leftLiveAt = Date.now();
        this.connect();
      }
    };
    window.addEventListener('online', wake);
    window.addEventListener('pageshow', wake);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') wake();
    });
    window.addEventListener('offline', () => this.clearRetry());
    window.addEventListener('pagehide', () => {
      if (this.sock) this.teardown(1000); // bfcache 에 열린 소켓을 남기지 않는다
      if (this.enabled && this.state === 'live') {
        this.quietLeave = true;
        this.setState('retrying-fast');
        this.quietLeave = false;
      }
    });
  }
}

export const wsClient = new WsClient({
  WebSocketImpl: typeof WebSocket === 'undefined' ? (undefined as unknown as typeof WebSocket) : WebSocket,
  fetchImpl: (...a) => fetch(...a),
  url: defaultUrl,
  toLogin: () => api.toLogin('/auth/login?next=' + encodeURIComponent(window.location.pathname + window.location.hash)),
});

export function useWsState(client: WsClient = wsClient): WsState {
  return useSyncExternalStore(
    (fn) => client.onState(fn),
    () => client.state,
    () => client.state
  );
}

/** 「연결 대기」인가(스펙 2026-10-20-030 DR1). 끊긴 지 CONN_WAIT_MS 가 되는 순간 다시 그린다 — 오피스 대화·회의실이 쓴다 */
export function useConnWait(client: WsClient = wsClient): boolean {
  const state = useWsState(client);
  const [, tick] = useState(0);
  const at = client.connWaitAt();
  useEffect(() => {
    const ms = at - Date.now();
    if (!at || ms <= 0) return;
    const id = setTimeout(() => tick((n) => n + 1), ms);
    return () => clearTimeout(id);
  }, [at, state]);
  return client.connWaiting();
}

/**
 * 토픽을 구독해 값이 오면 onData 로 넘긴다. topic 이 null 이면 구독하지 않는다.
 * 돌려주는 값이 참이면 웹소켓으로 받고 있는 것이다 — 화면은 이때 HTTP 폴링을 끈다.
 * 서버가 구독을 거절하거나(forbidden) 토픽이 끝나면 거짓으로 돌아가 화면이 HTTP 로 다시 읽는다(스펙 2026-10-17-004 L7).
 */
export function useTopic<T>(topic: string | null, onData: (data: T) => void, client: WsClient = wsClient): boolean {
  const state = useWsState(client);
  const [got, setGot] = useState(false);
  useEffect(() => {
    setGot(false);
    if (!topic) return;
    return client.subscribe(
      topic,
      (data) => {
        setGot(true);
        onData(data as T);
      },
      () => setGot(false)
    );
    // onData 는 매번 새로 만들어지는 함수라 의존성에서 뺀다(토픽이 바뀔 때만 다시 구독한다)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [topic, client]);
  return state === 'live' && got;
}

/** EventSource 와 같은 모양으로 토픽을 넘긴다. 오피스·채팅의 기존 이벤트 처리 코드를 그대로 쓴다. */
export interface TopicSource {
  onopen: (() => void) | null;
  onmessage: ((m: { data: string; lastEventId: string }) => void) | null;
  onerror: (() => void | Promise<void>) | null;
  close(): void;
}

export function topicSource(topic: string, client: WsClient = wsClient): TopicSource {
  let wasLive = client.state === 'live';
  const src: TopicSource = { onopen: null, onmessage: null, onerror: null, close: () => {} };
  const unState = client.onState(() => {
    const live = client.state === 'live';
    if (live && !wasLive) src.onopen?.();
    if (!live && wasLive) void src.onerror?.();
    wasLive = live;
  });
  const unsub = client.subscribe(
    topic,
    (data, meta) => src.onmessage?.({ data: JSON.stringify(data), lastEventId: String(meta.seq) }),
    () => void src.onerror?.()
  );
  if (wasLive) queueMicrotask(() => src.onopen?.());
  src.close = () => {
    unState();
    unsub();
  };
  return src;
}

/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 위젯 객체(OMAI-1873). 메서드 이름·인자는 CogentAI 위젯(cogentai-ui/widget 의 WidgetWrapper.tsx, 301-api-reference)과 같다 —
// 호스트의 관리 코드(COP Console CogentAIManager.ts 등)를 전역 이름만 바꿔 그대로 쓴다.
import { QueryClient } from '@tanstack/react-query';
import { createRoot, type Root } from 'react-dom/client';

import { getLang, type Lang, setLang as setLangNow } from '@/i18n';
import { chatStore } from '@/lib/chatStore';
import { buildContextBlock, contextKey, normalizeContext } from '@/lib/pageContext';
import { wsClient } from '@/lib/ws';

import { type AASWidgetConfig, resolveConfig, type ResolvedConfig, type WidgetStatusEvent } from './config';
import { EmbedRoot } from './EmbedApp';
import { consoleLine, lookupFormat, type SaveAnswerConfig, type SaveAnswerError, type SaveAnswerRuntime, sourceOf, validateSaveAnswer } from './saveAnswer';
import { EmbedSession } from './session';
import { addFontFaces, createShadowParts, type ShadowParts } from './shadowDom';
import { createWidgetStore, type WidgetState, type WidgetStatus, type WidgetStore } from './state';

export interface WidgetDeps {
  fetchImpl?: typeof fetch;
  doc?: Document;
  /** 위젯 파일을 내보낸 출처(backendUrl 이 없을 때 쓴다) */
  scriptOrigin?: string;
}

/** 메서드 이름 — 301-api-reference 와 같은 13개 */
export const WIDGET_METHODS = [
  'open',
  'close',
  'toggle',
  'maximize',
  'restore',
  'destroy',
  'updateConfig',
  'updateTheme',
  'setLanguage',
  'getLanguage',
  'newConversation',
  'resetUserSession',
  'resizeEvent',
  'sendMessage',
  'setContext',
  'focus',
  'setAgent',
] as const;

/** 이 위젯 판이 지원하는 호스트 기능(스펙 2026-11-15-002 D17). 호스트는 이 목록을 보고 전환을 보일지 정한다 */
export const WIDGET_FEATURES = ['rect', 'context', 'headerAction', 'status', 'saveAnswer', 'agent'] as const;

export type OpenRect = { left: number; top: number; width: number; height: number };

const ERROR_STATUS: Partial<Record<WidgetStatus, Pick<WidgetStatusEvent, 'code' | 'retryable' | 'action'>>> = {
  login: { code: 'token_invalid', retryable: true, action: 'relogin' },
  cert: { code: 'cert_required', retryable: true, action: 'retry' },
  idp: { code: 'idp_unreachable', retryable: true, action: 'retry' },
  rate_limited: { code: 'rate_limited', retryable: true, action: 'retry' },
  connect_check: { code: 'unreachable', retryable: true, action: 'retry' },
  no_agent: { code: 'no_agent', retryable: false, action: 'open_aas' },
  origin: { code: 'origin_not_registered', retryable: false, action: 'contact_admin' },
  auth_config: { code: 'token_mismatch', retryable: false, action: 'contact_admin' },
  not_user: { code: 'user_unknown', retryable: false, action: 'contact_admin' },
  version: { code: 'version_mismatch', retryable: false, action: 'contact_admin' },
  ws_off: { code: 'ws_unsupported', retryable: false, action: 'contact_admin' },
  mixed: { code: 'mixed_content', retryable: false, action: 'contact_admin' },
};

/** 위젯 상태 → 호스트에 알리는 상태. 연결된 뒤 웹소켓이 다시 잇는 중이면 disconnected 다 */
export function statusEvent(s: Pick<WidgetState, 'status'>, wsState: string): WidgetStatusEvent {
  if (s.status === 'connecting') return { state: 'connecting' };
  if (s.status === 'ready') return wsState.startsWith('retrying') ? { state: 'disconnected', retryable: true, action: 'retry' } : { state: 'ready' };
  return { state: 'error', ...(ERROR_STATUS[s.status] ?? { code: 'internal_error', retryable: true, action: 'retry' }) };
}

const sameEvent = (a: WidgetStatusEvent | null, b: WidgetStatusEvent) => !!a && a.state === b.state && a.code === b.code && a.action === b.action;

/** 뷰포트 px 사각형인지 본다. 아니면 null */
function cleanRect(r: unknown): OpenRect | null {
  if (!r || typeof r !== 'object') return null;
  const o = r as Record<string, unknown>;
  const n = ['left', 'top', 'width', 'height'].map((k) => Number(o[k]));
  if (n.some((v) => !Number.isFinite(v)) || n[2] <= 0 || n[3] <= 0) return null;
  return { left: n[0], top: n[1], width: n[2], height: n[3] };
}

export class CogentAIAASWidgetWrapper {
  readonly store: WidgetStore;
  readonly session: EmbedSession;
  private parts: ShadowParts;
  private root: Root;
  private certBox: HTMLDivElement | null = null;
  private pending: string[] = [];
  private unsub: () => void;
  private destroyed = false;
  private lastStatus: WidgetStatusEvent | null = null;
  private lastListener: AASWidgetConfig['onStatusChange'] | null = null;
  private unWs: () => void;
  private queryClient = new QueryClient({ defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false, staleTime: 15000 } } });

  constructor(config: AASWidgetConfig, private deps: WidgetDeps = {}) {
    const doc = deps.doc ?? document;
    const cfg = resolveConfig(config, deps.scriptOrigin);
    if (cfg.langCode) setLangNow(cfg.langCode);
    this.store = createWidgetStore(cfg);
    addFontFaces(doc);
    this.parts = createShadowParts(doc);
    doc.body.appendChild(this.parts.container);
    this.session = new EmbedSession({
      store: this.store,
      chat: chatStore,
      ws: wsClient,
      fetchImpl: deps.fetchImpl,
      doc,
      certContainer: () => this.certBox,
    });
    this.root = createRoot(this.parts.widgetRoot);
    this.render();
    // 연결된 뒤 보내기를 미뤄 둔 질문(sendMessage)을 보낸다
    this.unsub = this.store.subscribe(() => {
      if (this.store.get().status === 'ready' && chatStore.profile && this.pending.length) {
        const list = this.pending.splice(0);
        void (async () => {
          for (const m of list) await chatStore.send(m);
        })();
      }
    });
    // 호스트에 상태를 알린다(D17). 같은 상태는 다시 알리지 않고, 늦게 등록한 콜백은 지금 상태를 한 번 받는다
    let wasOpen = this.store.get().open;
    const unStatus = this.store.subscribe(() => {
      this.emitStatus();
      const open = this.store.get().open;
      if (open === wasOpen) return;
      wasOpen = open;
      try {
        this.store.get().config.onOpenChange?.(open);
      } catch {
        /* 호스트 콜백의 오류가 위젯을 멈추지 않게 한다 */
      }
    });
    this.unWs = wsClient.onState(() => this.emitStatus());
    const unsub = this.unsub;
    this.unsub = () => {
      unsub();
      unStatus();
    };
    // 페이지 맥락(A1): 맥락이 처음 생기거나 바뀐 뒤의 첫 메시지에만 블록을 붙인다
    chatStore.outgoing = (text) => {
      const s = this.store.get();
      const c = s.context;
      if (!c || s.contextOff === c.pageId) return text;
      const key = contextKey(c);
      if (key === s.contextSent) return text;
      this.store.set({ contextSent: key });
      return `${buildContextBlock(c, s.contextTruncated)}\n\n${text}`;
    };
    this.emitStatus();
    // 답 저장(스펙 2026-11-18-012): 설정 검사는 바로, 형식 조회는 연결된 뒤 한 번(D16)
    const unSave = this.store.subscribe(() => {
      const st = this.store.get();
      if (st.status === 'ready' && st.saveAnswer.state === 'pending' && this.lookedUp !== st.saveAnswer.gen) void this.lookupSaveAnswer();
    });
    const prevUnsub = this.unsub;
    this.unsub = () => {
      prevUnsub();
      unSave();
    };
    this.applySaveAnswer();
    void this.session.start();
  }

  private lookedUp = -1;

  /** 설정을 검사하고 상태를 새로 둔다. 판이 열려 있으면 닫힌다(gen 이 바뀜, D18) */
  private applySaveAnswer() {
    const cfg = this.config.saveAnswer as SaveAnswerConfig | null | undefined;
    const prev = this.store.get().saveAnswer;
    const gen = prev.gen + 1;
    if (!cfg) {
      this.store.set({ saveAnswer: { state: 'disabled', gen } });
      return;
    }
    const v = validateSaveAnswer(cfg);
    if (!v.ok) {
      this.store.set({ saveAnswer: { state: 'disabled', gen, code: v.errors[0].code, path: v.errors[0].path } });
      for (const e of v.errors) this.reportSaveError(cfg, e);
      return;
    }
    const source = sourceOf(cfg);
    if (cfg.format && (cfg.label || cfg.instructions)) console.info(`[AAS saveAnswer] registered format: label and instructions from the page are ignored`); // D2·D10
    if (source === 'none') {
      this.store.set({ saveAnswer: { state: 'ready', gen, source, label: cfg.label } });
      return;
    }
    this.store.set({ saveAnswer: { state: 'pending', gen, source, label: cfg.label } });
    if (this.store.get().status === 'ready') void this.lookupSaveAnswer();
  }

  private async lookupSaveAnswer() {
    const cfg = this.config.saveAnswer as SaveAnswerConfig;
    const gen = this.store.get().saveAnswer.gen;
    this.lookedUp = gen;
    const out = await lookupFormat(cfg);
    const cur = this.store.get().saveAnswer;
    if (cur.gen !== gen) return; // 그사이 설정이 바뀌었다
    if (out.ok) {
      this.store.set({ saveAnswer: { ...cur, state: 'ready', label: out.label ?? cfg.label, version: out.version } });
      return;
    }
    const err: SaveAnswerError = { code: 'saveAnswer.lookup_failed', detail: { code: out.code, ...(out.requestId ? { requestId: out.requestId } : {}) } };
    this.store.set({ saveAnswer: { ...cur, state: 'disabled', code: err.code, detail: err.detail } });
    this.reportSaveError(cfg, err);
  }

  private reportSaveError(cfg: SaveAnswerConfig, e: SaveAnswerError) {
    console.warn(consoleLine(e, String(this.config.widgetInfo ?? ''), String(cfg.format ?? (cfg.schema ? 'page' : 'none'))));
    try {
      cfg.onError?.(e);
    } catch {
      /* 호스트 콜백의 오류가 위젯을 멈추지 않게 한다 */
    }
  }

  /** 답 저장 단추의 지금 상태(D21①) */
  saveAnswerState(): Omit<SaveAnswerRuntime, 'gen' | 'label' | 'version' | 'source'> {
    const s = this.store.get().saveAnswer;
    return { state: s.state, ...(s.code ? { code: s.code } : {}), ...(s.detail ? { detail: s.detail } : {}), ...(s.path ? { path: s.path } : {}) };
  }

  private emitStatus() {
    const fn = this.store.get().config.onStatusChange;
    if (!fn) return;
    const ev = statusEvent(this.store.get(), wsClient.state);
    if (fn === this.lastListener && sameEvent(this.lastStatus, ev)) return;
    this.lastListener = fn;
    this.lastStatus = ev;
    try {
      fn(ev);
    } catch {
      /* 호스트 콜백의 오류가 위젯을 멈추지 않게 한다 */
    }
  }

  /** 이 위젯 판이 지원하는 호스트 기능 */
  get features(): string[] {
    return [...WIDGET_FEATURES];
  }

  private render() {
    this.root.render(
      <EmbedRoot
        store={this.store}
        session={this.session}
        cache={this.parts.emotionCache}
        portal={this.parts.portalRoot}
        certBox={(el) => {
          this.certBox = el;
        }}
        queryClient={this.queryClient}
      />
    );
  }

  get config(): ResolvedConfig {
    return this.store.get().config;
  }

  /** 창을 연다. rect 를 주면 그 자리·크기로 연다(뷰포트 px, position 보다 앞, 폭 600px 미만에서는 전체 화면) */
  open(opts?: { rect?: OpenRect }): void {
    const rect = cleanRect(opts?.rect);
    this.store.set({ open: true, ...(rect ? { openRect: rect } : {}) });
    this.session.tokens.checkCookie(); // 쿠키의 토큰이 바뀌었으면 열 때 다시 교환한다
  }

  close(): void {
    this.store.set({ open: false });
  }

  toggle(): void {
    if (this.store.get().open) this.close();
    else this.open();
  }

  /** 창의 입력 칸에 초점을 둔다. 위젯은 Shadow DOM 안이라 호스트가 직접 찾을 수 없다(D15) */
  focus(): void {
    this.store.set({ focusTick: this.store.get().focusTick + 1 });
  }

  /** 지금 보는 페이지 맥락을 넘긴다. null 이면 지운다. 다른 페이지로 바뀌면 지웠던 칩이 다시 보인다(A1) */
  setContext(ctx: unknown): void {
    const prev = this.store.get();
    const r = ctx === null ? null : normalizeContext(ctx);
    if (ctx !== null && !r) return;
    const next = r?.ctx ?? null;
    this.store.set({
      context: next,
      contextTruncated: r?.truncated ?? false,
      ...(next?.pageId !== prev.context?.pageId ? { contextOff: null } : {}),
    });
  }

  maximize(): void {
    this.store.set({ maximized: true });
  }

  restore(): void {
    this.store.set({ maximized: false });
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.unsub();
    this.unWs();
    if (chatStore.outgoing) chatStore.outgoing = null;
    this.session.destroy();
    this.root.unmount();
    this.parts.container.remove();
    this.queryClient.clear();
    forgetInstance(this);
  }

  /** 설정을 바꾼다. 서버 주소·신원 토큰이 바뀌면 다시 교환한다 */
  updateConfig(next: Partial<AASWidgetConfig>): void {
    const prev = this.config;
    const cfg = resolveConfig({ ...prev, ...next }, this.deps.scriptOrigin);
    this.store.set({ config: cfg, ...(next.langCode ? { lang: cfg.langCode } : {}) });
    if ('saveAnswer' in next) this.applySaveAnswer();
    if (cfg.backendUrl !== prev.backendUrl) {
      this.session.destroy();
      // 다른 AAS — 처음부터 다시 연다(요청 계층·웹소켓·대화가 모두 전역 하나다)
      void this.session.start();
    } else if (
      cfg.accessToken !== prev.accessToken ||
      cfg.accessTokenCookie !== prev.accessTokenCookie ||
      cfg.getAccessToken !== prev.getAccessToken
    )
      void this.session.onUnauthorized();
  }

  /** AI 에이전트(작업공간)와 프로파일을 바꿔 연다(AAS 스펙 2026-11-21-002 §3-7, 기능 'agent'). 호스트가 사용자의 기본 에이전트를
   * 바꿨을 때 부른다. 허용 목록에 없는 에이전트면 지금 것을 그대로 둔다 */
  setAgent(pod: string, profile?: string): void {
    if (!pod) return;
    this.store.set({ config: { ...this.config, agent: pod, profile: profile || undefined } });
    void this.session.pickAgent(pod, profile);
  }

  updateTheme(theme: 'light' | 'dark'): void {
    this.store.set({ config: { ...this.config, theme: theme === 'dark' ? 'dark' : 'light' } });
  }

  setLanguage(lang: Lang): void {
    if (lang !== 'ko' && lang !== 'en') return;
    this.store.set({ lang });
  }

  getLanguage(): Lang {
    return this.store.get().lang ?? getLang();
  }

  /** 같은 AI 에이전트로 새 대화 */
  newConversation(): void {
    void chatStore.newChat();
  }

  /** 임베드 토큰을 버리고 다시 교환한다(인증서 확인 기록도 지운다) */
  resetUserSession(): void {
    void this.session.resetUserSession();
  }

  /** 호스트 화면의 크기에 맞춰 창 크기를 정한다(APM 등) */
  resizeEvent(_e: UIEvent | null, width: number, height: number): void {
    if (!Number.isFinite(width) || !Number.isFinite(height)) return;
    const cur = this.store.get().size;
    if (cur?.width === width && cur?.height === height) return;
    this.store.set({ size: { width, height } });
  }

  /** 질문을 보낸다. 창을 열고, 아직 연결 전이면 연결된 뒤 보낸다. displayMessage·language 는 CogentAI 와 같은 자리로 받기만 한다 */
  sendMessage(message: string, _displayMessage?: string, language?: Lang): boolean {
    if (!message?.trim()) return false;
    if (language) this.setLanguage(language);
    this.open();
    if (this.store.get().status === 'ready' && chatStore.profile) void chatStore.send(message);
    else this.pending.push(message);
    return true;
  }
}

// 페이지에 하나만 둔다. 위젯 파일을 두 번 불러 모듈이 둘이 되어도 같은 것을 쓰도록 window 에 둔다
const SLOT = '__cogentaiAasWidget';
type Slot = { [SLOT]?: CogentAIAASWidgetWrapper | null };
const slot = (): Slot => (typeof window === 'undefined' ? {} : (window as unknown as Slot));

function forgetInstance(w: CogentAIAASWidgetWrapper) {
  if (slot()[SLOT] === w) slot()[SLOT] = null;
}

export const currentWidget = (): CogentAIAASWidgetWrapper | null => slot()[SLOT] ?? null;

/** 위젯을 띄운다. 이미 떠 있으면 새로 만들지 않고 그것을 돌려준다 — 요청 계층·웹소켓·대화 저장소가 페이지에 하나라 둘을 둘 수 없다 */
export function createWidget(config: AASWidgetConfig = {}, deps: WidgetDeps = {}): CogentAIAASWidgetWrapper {
  const cur = currentWidget();
  if (cur) return cur;
  const w = new CogentAIAASWidgetWrapper(config, deps);
  slot()[SLOT] = w;
  return w;
}

/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 위젯 설정(OMAI-1873). 이름·기본값은 CogentAI 위젯(cogentai-ui/widget 의 202-configuration)과 같다 — 호스트가 같은 코드 모양으로 붙인다.
// AAS 전용은 agent(기본 AI 에이전트) 하나다. RAG·MCP 항목은 받기만 하고 쓰지 않는다(AAS 는 AI 에이전트가 정한다).

import type { ErrorCode } from './errors';
import type { SaveAnswerConfig } from './saveAnswer';

export type WidgetPosition = 'bottom-right' | 'bottom-left' | 'top-right' | 'top-left';

/** 위젯 연결 상태를 호스트에 알린다(스펙 2026-11-15-002 D17). action 은 호스트가 보일 다음 할 일이다 */
export interface WidgetStatusEvent {
  state: 'ready' | 'connecting' | 'error' | 'disconnected';
  code?: ErrorCode;
  retryable?: boolean;
  action?: 'relogin' | 'retry' | 'open_aas' | 'contact_admin';
}

/** 위젯 머리줄에 호스트가 넣는 단추(D15 「돌아가기」). 함수라 data-aas-* 속성으로는 받지 않는다 */
export interface HeaderAction {
  label: { ko: string; en: string };
  onClick: () => void;
}

export interface AASWidgetConfig {
  /** AAS 주소(절대 주소) */
  backendUrl?: string;
  /** 호스트가 넘기는 신원 토큰(Keycloak 액세스 토큰 또는 호스트 서버가 서명한 JWT) */
  accessToken?: string;
  /** 신원 토큰이 든 쿠키 이름. 있으면 그 쿠키를 읽는다(바뀌면 다시 교환한다) */
  accessTokenCookie?: string;
  /**
   * 교환할 때마다(처음·만료 1분 전·다시 시도) 새 신원 토큰을 받아 오는 함수(OMAI-1873).
   * host-signed 토큰은 5분 안에 끝나고 한 번만 받으므로, accessToken 하나만 주면 첫 임베드 토큰이 끝나는 약 14분 뒤 끊긴다.
   * 값을 돌려주면 그것을 쓰고, 빈 값·실패·10초 초과면 accessTokenCookie·accessToken 으로 넘어간다.
   */
  getAccessToken?: () => string | Promise<string>;
  /**
   * 로그인 필요 상태에서 「로그인」을 누르면 그 클릭 안에서 부른다(OMAI-1908). 호스트가 자기 로그인(팝업 등)을 연다.
   * 돌려준 Promise 가 끝나면 위젯이 다시 교환한다. 새 신원 토큰은 쿠키·getAccessToken·updateConfig 로 넘긴다 — 위젯은 로그인 결과를 모른다.
   * getAccessToken 은 10초만 기다려 사람의 로그인을 담을 수 없어 따로 둔다. 함수라 data-aas-* 속성으로는 받지 않는다.
   */
  onLoginRequired?: () => void | Promise<unknown>;
  theme?: 'light' | 'dark';
  langCode?: 'ko' | 'en';
  /** 떠 있는 단추 자리. CogentAI 위젯(bottom-right)과 겹치지 않게 기본은 bottom-left */
  position?: WidgetPosition;
  width?: string;
  height?: string;
  title?: string;
  /** 입력 칸 안내. AAS 대화 화면은 AI 에이전트 이름이 든 안내를 쓰므로 받기만 한다 */
  placeholder?: string | { ko?: string; en?: string };
  draggable?: boolean;
  resizable?: boolean;
  maximizable?: boolean;
  primaryColor?: string;
  fontFamily?: string;
  borderRadius?: string;
  /** 받기만 한다 — 신원은 토큰으로 정한다 */
  userId?: string;
  /** 사용 기록에 남길 호스트 표시 */
  widgetInfo?: string;
  /** 처음 고를 AI 에이전트(작업공간 id). 사용자의 허용 목록 안에 있어야 고른다 */
  agent?: string;
  /** 처음 열 프로파일(AAS 스펙 2026-11-21-002 §3-7, MindWiki 「내 AAS 에이전트」). 그 에이전트에 없으면 채팅 기본으로 돌아간다 */
  profile?: string;
  /** 떠 있는 캐릭터 단추를 그린다(기본 참). 거짓이면 호스트가 open()·close()·toggle() 로만 연다(A1b, D5) */
  showLauncher?: boolean;
  /** 위젯 머리줄의 호스트 단추(D15·D17) */
  headerAction?: HeaderAction;
  /** 연결 상태가 바뀔 때마다 부른다. 늦게 등록해도 지금 상태를 한 번 받는다(D17) */
  onStatusChange?: (s: WidgetStatusEvent) => void;
  /** 창이 열리거나 닫힐 때 부른다(머리줄의 닫기 포함). 호스트가 자기 단추를 다시 보일 때 쓴다(D15) */
  onOpenChange?: (open: boolean) => void;
  /** 답 말풍선의 저장 단추(스펙 2026-11-18-012). 함수라 data-aas-* 속성으로는 받지 않는다 */
  saveAnswer?: SaveAnswerConfig | null;
  /** CogentAI 위젯 설정 중 AAS 가 쓰지 않는 항목(ragEnabled·mcpServers·showTools 등)도 그대로 받는다 */
  [key: string]: unknown;
}

export interface ResolvedConfig extends AASWidgetConfig {
  backendUrl: string;
  theme: 'light' | 'dark';
  position: WidgetPosition;
  width: string;
  height: string;
  title: string;
  draggable: boolean;
  resizable: boolean;
  maximizable: boolean;
  borderRadius: string;
  showLauncher: boolean;
}

export const DEFAULT_CONFIG = {
  theme: 'light',
  position: 'bottom-left',
  width: '620px',
  height: '800px',
  title: 'CogentAI AAS',
  draggable: true,
  resizable: true,
  maximizable: true,
  borderRadius: '12px',
  showLauncher: true,
} as const;

const POSITIONS: WidgetPosition[] = ['bottom-right', 'bottom-left', 'top-right', 'top-left'];

/** 값이 없는 항목은 기본값으로 채운다. backendUrl 이 없으면 위젯 파일을 내보낸 AAS 로 본다(서버의 /static/js/aas-widget.js) */
export function resolveConfig(input: AASWidgetConfig, scriptOrigin = ''): ResolvedConfig {
  const given = Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined && v !== null && v !== ''));
  const out = { ...DEFAULT_CONFIG, ...given } as ResolvedConfig;
  out.backendUrl = String(out.backendUrl || scriptOrigin || '').replace(/\/+$/, '');
  if (!POSITIONS.includes(out.position)) out.position = DEFAULT_CONFIG.position;
  out.theme = out.theme === 'dark' ? 'dark' : 'light';
  out.showLauncher = out.showLauncher !== false;
  if (typeof out.onStatusChange !== 'function') delete out.onStatusChange;
  if (typeof out.onOpenChange !== 'function') delete out.onOpenChange;
  const h = out.headerAction;
  if (!h || typeof h.onClick !== 'function' || !h.label?.ko || !h.label?.en) delete out.headerAction;
  if (out.langCode !== 'en' && out.langCode !== 'ko') delete out.langCode;
  return out;
}

const bool = (v: string | null): boolean | undefined => (v === null ? undefined : v !== 'false');

/** script 태그의 data-aas-* 속성에서 설정을 읽는다. 속성 이름은 설정 이름의 kebab-case 다(data-aas-backend-url 등) */
export function readDataAttributes(el: Element): AASWidgetConfig {
  const s = (name: string) => el.getAttribute(`data-aas-${name}`) || undefined;
  return {
    backendUrl: s('backend-url'),
    accessToken: s('access-token'),
    accessTokenCookie: s('access-token-cookie'),
    theme: s('theme') as AASWidgetConfig['theme'],
    langCode: s('lang-code') as AASWidgetConfig['langCode'],
    position: s('position') as WidgetPosition | undefined,
    width: s('width'),
    height: s('height'),
    title: s('title'),
    placeholder: s('placeholder'),
    draggable: bool(el.getAttribute('data-aas-draggable')),
    resizable: bool(el.getAttribute('data-aas-resizable')),
    maximizable: bool(el.getAttribute('data-aas-maximizable')),
    primaryColor: s('primary-color'),
    fontFamily: s('font-family'),
    borderRadius: s('border-radius'),
    userId: s('user-id'),
    widgetInfo: s('widget-info'),
    agent: s('agent'),
    profile: s('profile'),
    showLauncher: bool(el.getAttribute('data-aas-show-launcher')),
  };
}

/** script 태그의 data-aas-page-* 속성에서 처음 페이지 맥락을 읽는다(D17). 없으면 null */
export function readPageAttributes(el: Element): { source: 'mindwiki'; pageId: string; title: string; url: string } | null {
  const pageId = el.getAttribute('data-aas-page-id');
  if (!pageId) return null;
  return { source: 'mindwiki', pageId, title: el.getAttribute('data-aas-page-title') || '', url: el.getAttribute('data-aas-page-url') || '' };
}

/** 자동 초기화할 script 태그. 이 속성 중 하나라도 있으면 자동으로 띄운다 */
export const AUTO_INIT_SELECTOR = 'script[data-aas-backend-url], script[data-aas-access-token-cookie], script[data-aas-access-token], script[data-aas-theme]';

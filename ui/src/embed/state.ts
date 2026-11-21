/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 위젯 하나의 화면 상태(OMAI-1873). 위젯 객체의 메서드(open·close·updateTheme 등)가 바꾸고, React 화면이 구독한다.
import { useSyncExternalStore } from 'react';

import type { Lang } from '@/i18n';
import type { PageContext } from '@/lib/pageContext';

import type { ResolvedConfig } from './config';
import type { SaveAnswerRuntime } from './saveAnswer';

/** 위젯이 보이는 상태(상태 표). ready 만 대화를 보인다 */
export type WidgetStatus =
  | 'connecting'
  | 'ready'
  | 'cert'
  | 'origin'
  | 'login'
  | 'auth_config'
  | 'not_user'
  | 'idp'
  | 'no_agent'
  | 'rate_limited'
  | 'version'
  | 'ws_off'
  | 'connect_check'
  | 'mixed';

/** 대화 위에 잠깐 띄우는 알림 */
export type WidgetNotice = '' | 'userChanged' | 'rateLimited';

export interface WidgetState {
  open: boolean;
  maximized: boolean;
  status: WidgetStatus;
  notice: WidgetNotice;
  config: ResolvedConfig;
  /** resizeEvent 로 호스트가 정한 창 크기(px) */
  size: { width: number; height: number } | null;
  /** setLanguage·langCode 로 정한 언어 */
  lang?: Lang;
  /** 바뀔 때마다 오른다 — 사용자가 바뀌어 대화를 다시 그릴 때 key 로 쓴다 */
  epoch: number;
  /** 마지막 401 의 popup_login(OMAI-1911). 참이면 콜백이 없어도 「로그인」이 내장 팝업을 연다 */
  popupLogin: boolean;
  /** 호스트가 open({rect}) 로 준 창 자리(뷰포트 px). position 보다 앞선다(D17) */
  openRect: { left: number; top: number; width: number; height: number } | null;
  /** 호스트가 setContext 로 준 페이지 맥락(A1) */
  context: PageContext | null;
  /** 고른 글을 4,000자에서 잘랐다 */
  contextTruncated: boolean;
  /** 사용자가 칩을 지운 페이지(그 페이지에만 적용, 다시 붙이기로 푼다) */
  contextOff: string | null;
  /** 마지막으로 메시지에 붙인 맥락 키 — 같은 맥락은 다시 붙이지 않는다 */
  contextSent: string | null;
  /** focus() 를 부를 때마다 오른다 — 창이 입력 칸에 초점을 둔다 */
  focusTick: number;
  /** 답 저장 단추의 상태(스펙 2026-11-18-012 D21) */
  saveAnswer: SaveAnswerRuntime;
  /** 열린 답 저장 판(한 번에 하나, D25⑤) */
  savePanel: SavePanelRequest | null;
  /** 이 위젯이 열려 있는 동안 저장에 성공한 답(answerKey) */
  savedKeys: string[];
}

/** 답 저장 판을 열 때 넘기는 그 답의 값 */
export interface SavePanelRequest {
  answerKey: string;
  markdown: string;
  question: string;
  session: string;
  agent: string;
  pod: string;
  profile: string;
  /** 연 때의 saveAnswer.gen — 설정이 바뀌면 판을 닫는다(D18) */
  gen: number;
}

export interface WidgetStore {
  get(): WidgetState;
  set(next: Partial<WidgetState>): void;
  subscribe(fn: () => void): () => void;
}

export function createWidgetStore(config: ResolvedConfig): WidgetStore {
  let state: WidgetState = { open: false, maximized: false, status: 'connecting', notice: '', config, size: null, epoch: 0, lang: config.langCode, popupLogin: false, openRect: null, context: null, contextTruncated: false, contextOff: null, contextSent: null, focusTick: 0, saveAnswer: { state: 'disabled', gen: 0 }, savePanel: null, savedKeys: [] };
  const subs = new Set<() => void>();
  return {
    get: () => state,
    set(next) {
      state = { ...state, ...next };
      subs.forEach((fn) => fn());
    },
    subscribe(fn) {
      subs.add(fn);
      return () => void subs.delete(fn);
    },
  };
}

export const useWidgetState = (store: WidgetStore): WidgetState => useSyncExternalStore(store.subscribe, store.get, store.get);

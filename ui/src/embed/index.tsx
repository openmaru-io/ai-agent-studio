/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 다른 웹 페이지에 붙이는 AAS 채팅 위젯의 입구(OMAI-1873). CogentAI 위젯(window.CogentAIWidget)과 같은 모양이다:
//  - window.CogentAIAASWidget.init(config)·create(config). 둘은 같은 하나를 돌려준다(두 번 불러도 위젯은 하나)
//  - script 태그에 data-aas-* 속성이 있으면 DOM 이 준비된 뒤 저절로 띄운다. 그 뒤 init() 을 또 불러도 같은 것을 돌려준다
import { type AASWidgetConfig,AUTO_INIT_SELECTOR, readDataAttributes, readPageAttributes } from './config';
import { type SaveAnswerError, validateSaveAnswer } from './saveAnswer';
import { CogentAIAASWidgetWrapper, createWidget, currentWidget } from './widget';

export interface CogentAIAASWidgetGlobal {
  init: (config?: AASWidgetConfig) => CogentAIAASWidgetWrapper;
  create: (config?: AASWidgetConfig) => CogentAIAASWidgetWrapper;
  /** 답 저장 설정을 서버 없이 검사한다(스펙 2026-11-18-012 D21④) */
  validateSaveAnswer: (config: unknown) => { ok: boolean; errors: SaveAnswerError[] };
}

declare global {
  interface Window {
    CogentAIAASWidget?: CogentAIAASWidgetGlobal;
  }
}

/** 이 파일을 불러온 script 의 출처. AAS 가 /static/js/aas-widget.js 로 내보낸 파일이면 backendUrl 을 적지 않아도 그 AAS 로 붙는다 */
function scriptOrigin(script: HTMLScriptElement | null): string {
  try {
    return script?.src ? new URL(script.src, location.href).origin : '';
  } catch {
    return '';
  }
}

const loadingScript = typeof document !== 'undefined' ? (document.currentScript as HTMLScriptElement | null) : null;

export const init = (config: AASWidgetConfig = {}): CogentAIAASWidgetWrapper => createWidget(config, { scriptOrigin: scriptOrigin(loadingScript) });
/** init 과 같다(CogentAI 위젯과 같은 두 이름) */
export const create = init;

/** data-aas-* 속성이 있는 script 를 찾아 띄운다. 이미 떠 있으면 아무것도 하지 않는다 */
export function autoInit(doc: Document = document): CogentAIAASWidgetWrapper | null {
  if (currentWidget()) return currentWidget();
  const tag = doc.querySelector<HTMLScriptElement>(AUTO_INIT_SELECTOR);
  if (!tag) return null;
  const w = createWidget(readDataAttributes(tag), { scriptOrigin: scriptOrigin(tag) });
  const page = readPageAttributes(tag); // data-aas-page-* 로 처음 페이지 맥락을 줄 수 있다(D17)
  if (page) w.setContext(page);
  return w;
}

/** 전역 객체를 건다. 이미 있으면(파일을 두 번 불렀다) 앞의 것을 그대로 둔다.
 *  UMD 감싸개는 모듈을 돌리기 전에 같은 이름에 빈 객체를 먼저 걸므로, 있는지가 아니라 init 이 있는지로 본다 */
export function install(win: Window = window): CogentAIAASWidgetGlobal {
  if (typeof win.CogentAIAASWidget?.init === 'function') return win.CogentAIAASWidget;
  const api: CogentAIAASWidgetGlobal = { init, create, validateSaveAnswer };
  win.CogentAIAASWidget = api;
  if (win.document.readyState === 'loading') win.document.addEventListener('DOMContentLoaded', () => autoInit(win.document), { once: true });
  else setTimeout(() => autoInit(win.document), 0);
  return api;
}

if (typeof window !== 'undefined') install(window);

export { CogentAIAASWidgetWrapper, createWidget };
export type { AASWidgetConfig };

/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 위젯을 호스트 페이지와 격리하는 Shadow DOM(OMAI-1873). CogentAI 위젯(cogentai-ui/widget 의 utils/widgetShadowDom.ts·
// focusIsolation.ts·fonts.ts)과 같은 구조다: 컨테이너 → open shadow root → #emotion-root(Emotion 이 스타일을 넣는 곳) → 위젯 루트.
// 컨테이너 id 는 CogentAI 위젯(#cogentai-widget-container)과 겹치지 않게 따로 둔다 — 두 위젯을 한 화면에 함께 띄운다.
import createCache, { type EmotionCache } from '@emotion/cache';

import monoLatinExt from '@/assets/fonts/jetbrains-mono/jetbrains-mono-latin-ext-wght-normal.woff2?inline';
import monoLatin from '@/assets/fonts/jetbrains-mono/jetbrains-mono-latin-wght-normal.woff2?inline';

export const CONTAINER_ID = 'cogentai-aas-widget-container';
export const FONT_STYLE_ID = 'cogentai-aas-widget-fonts';

export interface ShadowParts {
  container: HTMLElement;
  shadowRoot: ShadowRoot;
  emotionRoot: HTMLElement;
  widgetRoot: HTMLElement;
  /** MUI 포털(Menu·Dialog·Tooltip·Popover)을 붙일 곳 */
  portalRoot: HTMLElement;
  emotionCache: EmotionCache;
}

type Listenable = Pick<EventTarget, 'addEventListener'>;

/**
 * 위젯 안의 포커스 이벤트가 호스트 페이지의 포커스 가두기에 닿지 않게 한다(CogentAI 위젯 focusIsolation.ts 를 옮겼다).
 * Bootstrap 모달처럼 document 에서 포커스 이동을 듣고 「모달 밖으로 나간 포커스」를 되돌리는 코드가 있으면, body 끝에 붙은 위젯 입력창은
 * 포커스를 매번 빼앗긴다. document 에서는 대상이 섀도 호스트로 보이므로 대상이 호스트인 이벤트만 골라 막는다.
 * - 진짜 focusin: 호스트의 bubble 단계에서 멈춘다(위젯의 React onFocus 는 섀도 루트 안에서 먼저 받는다)
 * - jQuery 의 흉내 focusin(document 캡처 단계 focus): 그보다 앞선 window 캡처 단계에서 대상이 호스트인 focus 만 멈춘다
 */
export function isolateFocusEvents(host: Listenable, win: Listenable = window): void {
  host.addEventListener('focusin', (e: Event) => e.stopPropagation());
  win.addEventListener(
    'focus',
    (e: Event) => {
      if (e.target === host) e.stopPropagation();
    },
    true
  );
}

/** 섀도 루트 안의 @font-face 는 브라우저가 무시한다 — 글꼴 정의만 호스트 head 에 한 번 넣는다. 위젯 파일 하나로 배포하므로 base64 로 싣는다.
 *  Noto Sans KR(3.6MB)은 싣지 않는다. 호스트(OPENMARU 제품 화면)가 이미 싣고 있고, 없으면 시스템 글꼴로 내려간다 */
export function addFontFaces(doc: Document = document): void {
  if (doc.getElementById(FONT_STYLE_ID)) return;
  const face = (src: string, range: string) =>
    `@font-face{font-family:'JetBrains Mono';font-style:normal;font-weight:100 800;font-display:swap;src:url(${src}) format('woff2');unicode-range:${range};}`;
  const style = doc.createElement('style');
  style.id = FONT_STYLE_ID;
  style.textContent =
    face(monoLatinExt, 'U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF') +
    face(monoLatin, 'U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD');
  doc.head.appendChild(style);
}

export function createShadowParts(doc: Document = document): ShadowParts {
  const container = doc.createElement('div');
  container.id = CONTAINER_ID;
  // 크기 없는 자리만 잡는다. 단추와 창은 안에서 position: fixed 로 놓인다
  container.style.cssText = 'position:fixed;top:0;left:0;width:0;height:0;z-index:2147483000;';
  const shadowRoot = container.attachShadow({ mode: 'open' });
  isolateFocusEvents(container);

  const emotionRoot = doc.createElement('div');
  emotionRoot.id = 'emotion-root';
  shadowRoot.appendChild(emotionRoot);

  const widgetRoot = doc.createElement('div');
  widgetRoot.id = 'cogentai-aas-widget-root';
  emotionRoot.appendChild(widgetRoot);

  // 툴팁·메뉴·팝오버(MUI 포털)를 그리는 층. 화면 전체 크기의 고정 층으로 둔다 — 폭 0 인 컨테이너 안에 그냥 두면
  // Popper(position:absolute)의 기준 폭이 0 이 되어 툴팁 글자가 한 글자씩 세로로 줄바꿈됐다(OMAI-1873, COP Console 실화면).
  // 층 자체는 클릭을 받지 않고(호스트 화면을 가리지 않게), 안에 그려진 것만 받는다.
  const portalRoot = doc.createElement('div');
  portalRoot.id = 'cogentai-aas-widget-portal';
  // z-index 는 위젯 창(EmbedApp 의 zIndex 2)보다 위 — 없으면 툴팁이 창 뒤에 그려졌다(OKE 확인)
  portalRoot.style.cssText = 'position:fixed;top:0;right:0;bottom:0;left:0;pointer-events:none;z-index:10;';
  emotionRoot.appendChild(portalRoot);
  const portalStyle = doc.createElement('style');
  portalStyle.textContent = '#cogentai-aas-widget-portal > * { pointer-events: auto; }';
  shadowRoot.appendChild(portalStyle);

  // insertBefore 오류를 피하려고 speedy 를 끈다(CogentAI 위젯과 같다)
  const emotionCache = createCache({ key: 'aas-widget', container: emotionRoot, prepend: true, speedy: false });
  return { container, shadowRoot, emotionRoot, widgetRoot, portalRoot, emotionCache };
}

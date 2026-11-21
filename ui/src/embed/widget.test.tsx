/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 위젯 객체(OMAI-1873): CogentAI 위젯과 같은 전역 객체·메서드, init 두 번·data-* 자동 초기화에도 위젯은 하나
import { act } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { apiConfig } from '@/lib/api';

import { readDataAttributes, resolveConfig } from './config';
import { autoInit, install } from './index';
import { CONTAINER_ID } from './shadowDom';
import { currentWidget, WIDGET_METHODS } from './widget';

beforeEach(() => {
  // 교환 응답이 오지 않게 둔다 — 위젯 객체·화면 구조만 본다
  vi.stubGlobal('fetch', vi.fn(() => new Promise(() => undefined)));
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  act(() => currentWidget()?.destroy());
  document.querySelectorAll('script[data-aas-backend-url]').forEach((s) => s.remove());
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const containers = () => document.querySelectorAll(`#${CONTAINER_ID}`).length;

describe('전역 객체 CogentAIAASWidget', () => {
  it('init·create 가 있고, 두 번 불러도 같은 하나를 돌려준다', () => {
    const g = install(window);
    expect(window.CogentAIAASWidget).toBe(g);
    let a, b;
    act(() => {
      a = g.init({ backendUrl: 'https://aas.example.com', accessToken: 't' });
      b = g.create({ backendUrl: 'https://other.example.com' });
    });
    expect(a).toBe(b);
    expect(containers()).toBe(1);
    expect(install(window)).toBe(g); // 파일을 두 번 불러도 앞의 전역 객체를 그대로 둔다
  });

  it('script 의 data-aas-* 속성으로 자동 초기화하고, 그 뒤 init() 은 같은 것을 돌려준다', () => {
    const s = document.createElement('script');
    s.setAttribute('data-aas-backend-url', 'https://aas.example.com');
    s.setAttribute('data-aas-access-token-cookie', 'TK');
    s.setAttribute('data-aas-position', 'top-right');
    s.setAttribute('data-aas-draggable', 'false');
    document.body.appendChild(s);
    let w;
    act(() => {
      w = autoInit(document);
      autoInit(document);
    });
    expect(w).not.toBeNull();
    expect(containers()).toBe(1);
    expect(currentWidget()!.config).toMatchObject({ backendUrl: 'https://aas.example.com', accessTokenCookie: 'TK', position: 'top-right', draggable: false });
    let again;
    act(() => {
      again = install(window).init({});
    });
    expect(again).toBe(w);
    expect(containers()).toBe(1);
  });

  it('CogentAI 위젯과 같은 메서드(301-api-reference 의 13개 + sendMessage)와 호스트 API(setContext·focus, 스펙 2026-11-15-002 D17)를 모두 가진다', () => {
    let w: ReturnType<typeof install>['init'] extends (...a: never[]) => infer R ? R : never;
    act(() => {
      w = install(window).init({ backendUrl: 'https://aas.example.com', accessToken: 't' });
    });
    for (const m of WIDGET_METHODS) expect(typeof (w! as unknown as Record<string, unknown>)[m]).toBe('function');
  });

  it('Shadow DOM 컨테이너를 body 에 붙이고, 열기·닫기·최대화·테마·언어·크기 메서드가 상태를 바꾼다', () => {
    let w = null as unknown as NonNullable<ReturnType<typeof currentWidget>>;
    act(() => {
      w = install(window).init({ backendUrl: 'https://aas.example.com', accessToken: 't', langCode: 'en' });
    });
    const host = document.getElementById(CONTAINER_ID)!;
    expect(host.shadowRoot).not.toBeNull();
    expect(host.shadowRoot!.querySelector('[data-testid="aas-widget-button"]')).not.toBeNull();
    expect(document.getElementById('cogentai-aas-widget-fonts')).not.toBeNull(); // @font-face 는 호스트 head 에 한 번
    act(() => w.open());
    expect(w.store.get().open).toBe(true);
    act(() => w.toggle());
    expect(w.store.get().open).toBe(false);
    act(() => w.maximize());
    expect(w.store.get().maximized).toBe(true);
    act(() => w.restore());
    expect(w.store.get().maximized).toBe(false);
    act(() => w.updateTheme('dark'));
    expect(w.config.theme).toBe('dark');
    expect(w.getLanguage()).toBe('en');
    act(() => w.setLanguage('ko'));
    expect(w.getLanguage()).toBe('ko');
    act(() => w.resizeEvent(null, 500, 400));
    expect(w.store.get().size).toEqual({ width: 500, height: 400 });
    expect(apiConfig().embed).toBe(true);
    act(() => w.destroy());
    expect(document.getElementById(CONTAINER_ID)).toBeNull();
    expect(currentWidget()).toBeNull();
    expect(apiConfig().embed).toBe(false);
  });

  it('설정 이름·기본값은 CogentAI 위젯과 같고(위치만 bottom-left), RAG·MCP 항목은 받기만 한다', () => {
    const c = resolveConfig({ backendUrl: 'https://aas/', ragEnabled: true, mcpServers: ['a'] });
    expect(c).toMatchObject({ backendUrl: 'https://aas', theme: 'light', position: 'bottom-left', width: '620px', height: '800px', draggable: true, resizable: true, maximizable: true });
    const s = document.createElement('script');
    s.setAttribute('data-aas-agent', 'pod-a');
    s.setAttribute('data-aas-lang-code', 'en');
    expect(readDataAttributes(s)).toMatchObject({ agent: 'pod-a', langCode: 'en' });
  });
});

describe('로그인 필요 상태의 「로그인」 버튼(OMAI-1908·OMAI-1911)', () => {
  const panel = () => document.getElementById(CONTAINER_ID)!.shadowRoot!.querySelector('[data-testid="aas-widget-status-login"]');
  // 신원 토큰 없이 띄우면 빈 assertion 교환이 401 token_invalid 를 받는다(OMAI-1911). popup_login 은 서버가 정한다
  const answer401 = (popup: boolean) =>
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_u: string, init?: RequestInit) =>
        'login' in JSON.parse(String(init?.body ?? '{}'))
          ? new Response(JSON.stringify({ pending: true }), { status: 202 })
          : new Response(JSON.stringify({ error: 'token_invalid', popup_login: popup }), { status: 401 })
      )
    );
  beforeEach(() => answer401(false));

  it('onLoginRequired 가 있으면 「로그인」 버튼을 보이고, 누르면 그 클릭 안에서 콜백을 부른다', async () => {
    const onLoginRequired = vi.fn(() => new Promise<void>(() => undefined));
    let w = null as unknown as NonNullable<ReturnType<typeof currentWidget>>;
    act(() => {
      w = install(window).init({ backendUrl: 'https://aas.example.com', langCode: 'ko', onLoginRequired });
    });
    await vi.waitFor(() => expect(w.store.get().status).toBe('login')); // 토큰 없이 띄웠다 → 401 token_invalid
    act(() => w.open());
    const btn = panel()!.querySelector<HTMLButtonElement>('[data-testid="aas-widget-login"]')!;
    expect(btn).not.toBeNull();
    act(() => btn.click());
    expect(onLoginRequired).toHaveBeenCalledTimes(1);
    expect(panel()!.textContent).toContain('로그인 창에서 로그인을 마치세요.');
    expect(panel()!.querySelector<HTMLButtonElement>('[data-testid="aas-widget-login"]')!.disabled).toBe(true); // 기다리는 동안 다시 누를 수 없다
    act(() => btn.click());
    expect(onLoginRequired).toHaveBeenCalledTimes(1);
  });

  it('onLoginRequired 가 없으면 지금처럼 「다시 시도」만 보인다', async () => {
    let w = null as unknown as NonNullable<ReturnType<typeof currentWidget>>;
    act(() => {
      w = install(window).init({ backendUrl: 'https://aas.example.com', langCode: 'ko' });
    });
    await vi.waitFor(() => expect(w.store.get().status).toBe('login'));
    act(() => w.open());
    expect(panel()!.querySelector('[data-testid="aas-widget-login"]')).toBeNull();
    expect(panel()!.textContent).toContain('다시 시도');
  });

  it('콜백이 없어도 401 의 popup_login 이 참이면 「로그인」을 보이고, 누른 클릭 안에서 /embed/login 팝업을 연다', async () => {
    answer401(true);
    const open = vi.spyOn(window, 'open').mockImplementation(() => ({ closed: false, close: vi.fn() }) as unknown as Window);
    let w = null as unknown as NonNullable<ReturnType<typeof currentWidget>>;
    act(() => {
      w = install(window).init({ backendUrl: 'https://aas.example.com', langCode: 'ko' });
    });
    await vi.waitFor(() => expect(w.store.get().status).toBe('login'));
    expect(w.store.get().popupLogin).toBe(true);
    act(() => w.open());
    const btn = panel()!.querySelector<HTMLButtonElement>('[data-testid="aas-widget-login"]')!;
    expect(btn).not.toBeNull();
    act(() => btn.click());
    expect(open).toHaveBeenCalledTimes(1);
    expect(String(open.mock.calls[0][0])).toMatch(/^https:\/\/aas\.example\.com\/embed\/login\?o=[^&]+&n=[A-Za-z0-9_-]{43}$/);
    expect(open.mock.calls[0].slice(1)).toEqual(['aas-embed-login', 'width=520,height=700']);
    expect(panel()!.querySelector<HTMLButtonElement>('[data-testid="aas-widget-login"]')!.disabled).toBe(true);
    act(() => btn.click());
    expect(open).toHaveBeenCalledTimes(1);
  });
});

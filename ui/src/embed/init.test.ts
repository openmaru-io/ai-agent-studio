/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 주입 스크립트 aas-widget-init.js(OMAI-1873): window.__COGENTAI_AAS__ 를 읽어 CogentAIAASWidget.init() 을 한 번 부른다
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import source from './aas-widget-init.js?raw';

// 위젯 전역 객체의 실제 모양 대신 대역을 넣는다 — 이 시험은 주입 스크립트만 본다
const w = window as unknown as { __COGENTAI_AAS__?: unknown; CogentAIAASWidget?: unknown };

function fakeWidget() {
  const instance = { updateTheme: vi.fn() };
  const api = { init: vi.fn(() => instance), create: vi.fn() };
  w.CogentAIAASWidget = api;
  return { api, instance };
}

const run = () => new Function(source)();

const WIDGET_SRC = 'https://aas.example.com/static/js/aas-widget.js';
const widgetScript = () => document.querySelector<HTMLScriptElement>(`script[src="${WIDGET_SRC}"]`);
const loader = () => document.getElementById('cogentai-aas-widget-loader');
const inLoader = (id: string) => loader()?.shadowRoot?.querySelector<HTMLElement>(`[data-testid="${id}"]`) ?? null;

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  localStorage.removeItem('theme');
});
afterEach(() => {
  delete w.__COGENTAI_AAS__;
  delete w.CogentAIAASWidget;
  document.querySelectorAll('script[src]').forEach((s) => s.remove());
  loader()?.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('aas-widget-init.js', () => {
  it('설정을 그대로 넘겨 init() 을 부르고, 끝의 / 는 뗀다', () => {
    const { api } = fakeWidget();
    w.__COGENTAI_AAS__ = { backendUrl: 'https://aas.example.com/', accessTokenCookie: 'TK', title: 'AAS', agent: 'pod-a' };
    run();
    expect(api.init).toHaveBeenCalledTimes(1);
    expect(api.init).toHaveBeenCalledWith({ backendUrl: 'https://aas.example.com', accessTokenCookie: 'TK', title: 'AAS', agent: 'pod-a', theme: 'light' });
  });

  it('설정이 없거나 backendUrl 이 절대 주소가 아니면 띄우지 않고 콘솔에 한 줄 남긴다', () => {
    const { api } = fakeWidget();
    run();
    w.__COGENTAI_AAS__ = { backendUrl: '/aas' };
    run();
    w.__COGENTAI_AAS__ = { accessTokenCookie: 'TK' };
    run();
    expect(api.init).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledTimes(3);
    expect(console.error).toHaveBeenCalledWith(expect.stringMatching(/^\[CogentAIAASWidget\] init: .*backendUrl must be an absolute/));
  });

  it('위젯이 이미 있으면(기본 방식) 위젯 파일을 따로 불러오지 않는다', () => {
    fakeWidget();
    w.__COGENTAI_AAS__ = { backendUrl: 'https://aas.example.com' };
    run();
    expect(widgetScript()).toBeNull();
  });

  it('호스트(Outline)의 테마 신호를 따른다: 처음은 localStorage, 뒤는 theme-changed 이벤트', () => {
    const { api, instance } = fakeWidget();
    localStorage.setItem('theme', JSON.stringify('dark'));
    w.__COGENTAI_AAS__ = { backendUrl: 'https://aas.example.com', theme: 'light' };
    run();
    expect(api.init).toHaveBeenCalledWith(expect.objectContaining({ theme: 'dark' }));
    window.dispatchEvent(new CustomEvent('theme-changed', { detail: { isDark: false } }));
    expect(instance.updateTheme).toHaveBeenCalledWith('light');
  });

  it('콘솔 문구·코드는 ASCII 다(주석만 한글) — 호스트가 문자 집합을 알리지 않아도 깨지지 않는다', () => {
    // 안내 문구의 한국어는 \u 이스케이프로 둔다. 아래 「인증서 안내」 시험이 풀린 글자를 확인한다
    const code = source.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '');
    expect([...code].some((c) => c.charCodeAt(0) > 0x7f)).toBe(false);
  });
});

// 선택 방식: 이 파일만 호스트에 두고 위젯 파일은 이 파일이 AAS 에서 불러온다(사설 인증서 현장, 2026-11-14)
describe('aas-widget-init.js 가 위젯 파일을 불러오는 경우', () => {
  const ok = (): Promise<Response> => Promise.resolve(new Response(null));
  const fail = (): Promise<Response> => Promise.reject(new TypeError('Failed to fetch'));

  it('위젯이 없으면 <backendUrl>/static/js/aas-widget.js 를 불러오고, 받으면 init() 을 부른다', () => {
    w.__COGENTAI_AAS__ = { backendUrl: 'https://aas.example.com/' };
    run();
    const s = widgetScript();
    expect(s).not.toBeNull();
    const { api } = fakeWidget();
    s?.dispatchEvent(new Event('load'));
    expect(api.init).toHaveBeenCalledTimes(1);
    expect(api.init).toHaveBeenCalledWith(expect.objectContaining({ backendUrl: 'https://aas.example.com' }));
  });

  it('받지 못했는데 no-cors /healthz 가 되면 인증서 문제가 아니다: 안내 없이 콘솔에 주소·CSP 를 보라고 남긴다', async () => {
    const fetchMock = vi.fn(ok);
    vi.stubGlobal('fetch', fetchMock);
    w.__COGENTAI_AAS__ = { backendUrl: 'https://aas.example.com' };
    run();
    widgetScript()?.dispatchEvent(new Event('error'));
    await vi.waitFor(() => expect(console.error).toHaveBeenCalledWith(expect.stringMatching(/script-src/)));
    expect(fetchMock).toHaveBeenCalledWith('https://aas.example.com/healthz', expect.objectContaining({ mode: 'no-cors' }));
    expect(loader()).toBeNull();
  });

  it('http AAS 에 닿지 않으면 unreachable 만 남기고 인증서 안내는 띄우지 않는다', async () => {
    vi.stubGlobal('fetch', vi.fn(fail));
    w.__COGENTAI_AAS__ = { backendUrl: 'http://aas.example.com' };
    run();
    document.querySelector('script[src="http://aas.example.com/static/js/aas-widget.js"]')?.dispatchEvent(new Event('error'));
    await vi.waitFor(() => expect(console.error).toHaveBeenCalledWith(expect.stringMatching(/unreachable/)));
    expect(loader()).toBeNull();
  });

  it('인증서 안내: https 이고 /healthz 도 안 되면 안내를 띄우고, 새 창을 연 뒤 연결되면 위젯을 다시 불러온다', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(fail);
    vi.stubGlobal('fetch', fetchMock);
    const popup = { closed: false, close: vi.fn() } as unknown as Window;
    const open = vi.spyOn(window, 'open').mockReturnValue(popup);
    w.__COGENTAI_AAS__ = { backendUrl: 'https://aas.example.com', langCode: 'ko' };
    run();
    widgetScript()?.dispatchEvent(new Event('error'));
    await vi.waitFor(() => expect(inLoader('aas-loader-cert')).not.toBeNull());
    expect(widgetScript()).toBeNull(); // 실패한 태그는 지운다
    expect(console.error).toHaveBeenCalledWith(expect.stringMatching(/^\[CogentAIAASWidget\] cert_required /));
    expect(inLoader('aas-loader-cert')?.textContent).toContain('연결 설정 필요'); // \u 이스케이프가 풀린 글자
    expect(inLoader('aas-loader-setup')?.textContent).toBe('연결 설정하기');

    inLoader('aas-loader-setup')?.click();
    expect(open).toHaveBeenCalledWith('https://aas.example.com/embed/cert', '_blank', expect.stringContaining('width=700'));
    await vi.advanceTimersByTimeAsync(500); // 첫 시도: 아직 인증서를 받아들이지 않았다
    expect(widgetScript()).toBeNull();
    fetchMock.mockImplementation(ok); // 사용자가 새 창에서 받아들였다
    await vi.advanceTimersByTimeAsync(750);
    expect(inLoader('aas-loader-cert')?.textContent).toContain('연결되었습니다');
    expect(popup.close).toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(800);
    expect(loader()).toBeNull();
    const again = widgetScript();
    expect(again).not.toBeNull();
    const { api } = fakeWidget();
    again?.dispatchEvent(new Event('load'));
    expect(api.init).toHaveBeenCalledTimes(1);
  });

  it('인증서 안내는 「닫기」로 지우고, 40번 시도해도 안 되면 다시 누를 수 있게 둔다', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn(fail));
    vi.spyOn(window, 'open').mockReturnValue(null); // 팝업이 막혀도 시도는 한다
    w.__COGENTAI_AAS__ = { backendUrl: 'https://aas.example.com', langCode: 'en', position: 'bottom-right' };
    run();
    widgetScript()?.dispatchEvent(new Event('error'));
    await vi.waitFor(() => expect(inLoader('aas-loader-cert')).not.toBeNull());
    expect(loader()?.style.right).toBe('20px');
    const setup = inLoader('aas-loader-setup') as HTMLButtonElement;
    setup.click();
    expect(setup.disabled).toBe(true);
    await vi.advanceTimersByTimeAsync(40 * 3000);
    expect(setup.disabled).toBe(false);
    expect(inLoader('aas-loader-cert')?.textContent).toContain('Could not confirm the connection');
    inLoader('aas-loader-close')?.click();
    expect(loader()).toBeNull();
    expect(widgetScript()).toBeNull();
  });
});

/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// AAS ↔ MindWiki 탭 하나로 오가기(스펙 2026-11-23-019 L1~L5). 브라우저 정책은 0단계 실측이 정본이고, 여기서는 찾기 순서·판정·감지 규칙을 본다.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MINDWIKI_TAB, openProductTab, originOf, resetProductTab, startProductTab, tabHash, tabName, watchSwitch } from './productTab';

type FakeWin = { closed: boolean; focus: ReturnType<typeof vi.fn>; location: { href: string }; postMessage: ReturnType<typeof vi.fn> };
const fakeWin = (href = 'about:blank'): FakeWin => ({ closed: false, focus: vi.fn(), location: { href }, postMessage: vi.fn() });
/** 다른 출처 창: location.href 를 읽으면 오류, 쓰기는 된다 */
const crossOrigin = (): FakeWin => {
  const w = fakeWin();
  let href = '';
  Object.defineProperty(w, 'location', {
    value: Object.defineProperty({}, 'href', {
      get() {
        throw new DOMException('cross-origin', 'SecurityError');
      },
      set(v: string) {
        href = v;
      },
    }),
  });
  (w as unknown as { written: () => string }).written = () => href;
  return w;
};

const URL_WIKI = 'https://wiki.example.com';
const setOpener = (w: unknown) => Object.defineProperty(window, 'opener', { value: w, configurable: true, writable: true });
/** jsdom 의 MessageEvent 는 source 로 진짜 창만 받아, 받는 쪽이 보는 값(origin·data·source)을 그대로 넣은 사건을 보낸다 */
const message = (origin: string, data: unknown, source: unknown) => {
  const e = new MessageEvent('message', { origin, data });
  Object.defineProperty(e, 'source', { value: source });
  window.dispatchEvent(e);
};

beforeEach(() => {
  resetProductTab();
  vi.useFakeTimers();
});
afterEach(() => {
  setOpener(null);
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('이름(L1, 리뷰 Eng M1·DX A5)', () => {
  it('출처를 맞춘다 — 끝 /·기본 포트·대소문자·경로', () => {
    expect(originOf('HTTPS://Wiki.Example.com:443/wiki/')).toBe('https://wiki.example.com');
    expect(originOf('잘못된 주소')).toBe('');
  });
  it('FNV-1a 32비트 시험 벡터 — MindWiki 레포에도 같은 값을 둔다', () => {
    expect(tabHash('')).toBe('811c9dc5');
    expect(tabHash('a')).toBe('e40c292c');
    expect(tabHash('https://wiki.example.com')).toBe(tabHash(originOf('https://wiki.example.com/p/1')));
  });
  it('설치가 다르면 이름이 다르다', () => {
    expect(tabName(MINDWIKI_TAB, 'https://wiki-a.example.com')).not.toBe(tabName(MINDWIKI_TAB, 'https://wiki-b.example.com'));
    expect(tabName(MINDWIKI_TAB, URL_WIKI)).toMatch(/^cogentai-mindwiki-[0-9a-f]{8}$/);
  });
});

describe('열기(L2·L3)', () => {
  it('새 빈 창이면 주소를 넣고, 다시 누르면 같은 참조로 초점만(새 탭 없음)', async () => {
    const w = fakeWin();
    const open = vi.spyOn(window, 'open').mockReturnValue(w as unknown as Window);
    expect(await openProductTab(URL_WIKI, MINDWIKI_TAB)).toEqual({ kind: 'opened' });
    expect(w.location.href).toBe(URL_WIKI);
    expect(open).toHaveBeenCalledWith('', tabName(MINDWIKI_TAB, URL_WIKI));
    const p = openProductTab(URL_WIKI, MINDWIKI_TAB);
    window.dispatchEvent(new Event('blur')); // 전환됐다
    vi.spyOn(document, 'hasFocus').mockReturnValue(false);
    window.dispatchEvent(new Event('blur'));
    expect((await p).kind).toBe('focused');
    expect(open).toHaveBeenCalledTimes(1); // 기억한 참조를 쓴다
    expect(w.focus).toHaveBeenCalled();
  });

  it('다른 출처의 이미 있는 탭은 주소를 바꾸지 않고 초점만(읽기 오류 = 이미 있는 탭, CEO-F2)', async () => {
    const w = crossOrigin();
    vi.spyOn(window, 'open').mockReturnValue(w as unknown as Window);
    vi.spyOn(document, 'hasFocus').mockReturnValue(false);
    const p = openProductTab(URL_WIKI, MINDWIKI_TAB);
    window.dispatchEvent(new Event('blur'));
    expect((await p).kind).toBe('focused');
    expect((w as unknown as { written: () => string }).written()).toBe('');
  });

  it('같은 출처의 다른 주소도 이미 있는 탭이다', async () => {
    const w = fakeWin('https://wiki.example.com/p/3');
    vi.spyOn(window, 'open').mockReturnValue(w as unknown as Window);
    const p = openProductTab(URL_WIKI, MINDWIKI_TAB);
    vi.advanceTimersByTime(600);
    const r = await p;
    expect(r.kind).toBe('blocked'); // 변화가 없었다
    expect(w.location.href).toBe('https://wiki.example.com/p/3');
  });

  it('window.open 이 null 이면 마지막 안내(refused)', async () => {
    vi.spyOn(window, 'open').mockReturnValue(null);
    expect(await openProductTab(URL_WIKI, MINDWIKI_TAB)).toEqual({ kind: 'refused' });
  });

  it('전환이 막히면 다시 열기는 찾은 참조에 주소를 넣는다(이름으로 다시 열지 않음, spec3 5-1)', async () => {
    const w = fakeWin('https://wiki.example.com/p/3');
    const open = vi.spyOn(window, 'open').mockReturnValue(w as unknown as Window);
    const p = openProductTab(URL_WIKI, MINDWIKI_TAB);
    vi.advanceTimersByTime(600);
    const r = await p;
    expect(r.kind).toBe('blocked');
    const again = (r as { reopen: () => Promise<{ kind: string }> }).reopen();
    vi.advanceTimersByTime(600);
    expect((await again).kind).toBe('refused'); // 그래도 막혔다 → 탭 줄 안내, 새 탭 없음
    expect(w.location.href).toBe(URL_WIKI);
    expect(open).toHaveBeenCalledTimes(1);
  });

  it('navigate 는 찾은 탭의 주소를 바꾼다(L3b)', async () => {
    const w = fakeWin('https://wiki.example.com/p/3');
    vi.spyOn(window, 'open').mockReturnValue(w as unknown as Window);
    vi.spyOn(document, 'hasFocus').mockReturnValue(false);
    const p = openProductTab('https://wiki.example.com/p/9', MINDWIKI_TAB, { navigate: true });
    window.dispatchEvent(new Event('blur'));
    expect((await p).kind).toBe('navigated');
    expect(w.location.href).toBe('https://wiki.example.com/p/9');
  });
});

describe('전환 감지(L3a)', () => {
  it('500ms 안에 숨겨지거나 초점을 잃으면 성공, 아니면 실패', async () => {
    const ok = watchSwitch();
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    expect(await ok).toBe(true);
    vi.restoreAllMocks();
    const no = watchSwitch();
    vi.advanceTimersByTime(500);
    expect(await no).toBe(false);
  });
});

describe('opener 확인(L2-2·L1)', () => {
  it('상대 출처의 opener 가 pong 하면 그 opener 로 옮긴다 — focus() 뒤 이름으로 한 번 더 연다(Chrome 은 opener.focus() 를 막는다, 0단계 실측)', async () => {
    const op = fakeWin('https://wiki.example.com/');
    setOpener(op);
    const stop = startProductTab('cogentai-aas', URL_WIKI);
    expect(op.postMessage).toHaveBeenCalledWith({ type: 'cogentai-ping' }, URL_WIKI);
    message(URL_WIKI, { type: 'cogentai-pong' }, op);
    const open = vi.spyOn(window, 'open').mockReturnValue(op as unknown as Window);
    vi.spyOn(document, 'hasFocus').mockReturnValue(false);
    const p = openProductTab(URL_WIKI, MINDWIKI_TAB);
    window.dispatchEvent(new Event('blur'));
    expect((await p).kind).toBe('focused');
    expect(op.focus).toHaveBeenCalled();
    expect(open).toHaveBeenCalledWith('', tabName(MINDWIKI_TAB, URL_WIKI)); // 주소 없이 — opener 를 다시 읽지 않는다
    expect(op.location.href).toBe('https://wiki.example.com/');
    stop();
  });

  it('이름으로 열었는데 opener 가 아닌 새 빈 창이 오면 닫는다(이름이 다른 설치)', async () => {
    const op = fakeWin('https://wiki.example.com/');
    setOpener(op);
    const stop = startProductTab('cogentai-aas', URL_WIKI);
    message(URL_WIKI, { type: 'cogentai-pong' }, op);
    const stray = { ...fakeWin(), close: vi.fn() };
    vi.spyOn(window, 'open').mockReturnValue(stray as unknown as Window);
    const p = openProductTab(URL_WIKI, MINDWIKI_TAB);
    vi.advanceTimersByTime(600);
    expect((await p).kind).toBe('blocked');
    expect(stray.close).toHaveBeenCalled();
    stop();
  });

  it('출처가 다르거나 보낸 창이 opener 가 아니면 답하지 않는다(리뷰 Eng L-a)', () => {
    const op = fakeWin();
    const other = fakeWin();
    setOpener(op);
    const stop = startProductTab('cogentai-aas', URL_WIKI);
    message('https://evil.example', { type: 'cogentai-ping' }, op);
    message(URL_WIKI, { type: 'cogentai-ping' }, other);
    expect(op.postMessage).toHaveBeenCalledTimes(1); // 시작할 때 보낸 ping 하나뿐
    expect(other.postMessage).not.toHaveBeenCalled();
    message(URL_WIKI, { type: 'cogentai-ping' }, op);
    expect(op.postMessage).toHaveBeenLastCalledWith({ type: 'cogentai-pong' }, URL_WIKI);
    stop();
  });

  it('탭 이름은 자기 출처의 해시', () => {
    const stop = startProductTab('cogentai-aas', URL_WIKI);
    expect(window.name).toBe(tabName('cogentai-aas', window.location.origin));
    stop();
  });
});

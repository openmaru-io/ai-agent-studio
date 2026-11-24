/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 위젯 호스트 API(스펙 2026-11-15-002 D17·A1·A1b): showLauncher·open({rect})·focus·headerAction·onStatusChange·features·setContext
import { act } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { chatStore } from '@/lib/chatStore';

import { readPageAttributes } from './config';
import { autoInit, install } from './index';
import { CONTAINER_ID } from './shadowDom';
import { currentWidget, statusEvent, WIDGET_FEATURES } from './widget';

type W = NonNullable<ReturnType<typeof currentWidget>>;

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(() => new Promise(() => undefined)));
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  act(() => currentWidget()?.destroy());
  document.querySelectorAll('script[data-aas-backend-url]').forEach((s) => s.remove());
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const shadow = () => document.getElementById(CONTAINER_ID)!.shadowRoot!;
const make = (extra: Record<string, unknown> = {}): W => {
  let w = null as unknown as W;
  act(() => {
    w = install(window).init({ backendUrl: 'https://aas.example.com', accessToken: 't', langCode: 'ko', ...extra });
  });
  return w;
};
const page = { source: 'mindwiki', title: '회의록', url: 'https://wiki.example.com/p/1', pageId: 'p1' };

describe('창 전환 계약(D15·D17)', () => {
  it('showLauncher:false 면 캐릭터 단추가 없고 open() 으로만 열린다', () => {
    const w = make({ showLauncher: false });
    expect(shadow().querySelector('[data-testid="aas-widget-button"]')).toBeNull();
    act(() => w.open());
    expect(w.store.get().open).toBe(true);
  });

  it('open({rect}) 는 그 자리·크기로 열고, 숫자가 아닌 사각형은 무시한다', () => {
    const w = make();
    act(() => w.open({ rect: { left: 100, top: 80, width: 420, height: 500 } }));
    expect(w.store.get().openRect).toEqual({ left: 100, top: 80, width: 420, height: 500 });
    const win = shadow().querySelector<HTMLElement>('[data-testid="aas-widget-window"]')!;
    expect(win.style.display).not.toBe('none');
    act(() => w.open({ rect: { left: 'x', top: 0, width: 1, height: 1 } as never }));
    expect(w.store.get().openRect).toEqual({ left: 100, top: 80, width: 420, height: 500 });
  });

  it('headerAction 은 머리줄 단추로 그리고 누르면 호스트 함수를 부른다. 라벨이 모자라면 그리지 않는다', () => {
    const onClick = vi.fn();
    const w = make({ headerAction: { label: { ko: '빠른 답으로', en: 'Quick answers' }, onClick } });
    act(() => w.open());
    const btn = shadow().querySelector<HTMLButtonElement>('[data-testid="aas-widget-header-action"]')!;
    expect(btn.textContent).toBe('빠른 답으로');
    act(() => btn.click());
    expect(onClick).toHaveBeenCalledTimes(1);
    act(() => w.updateConfig({ headerAction: { label: { ko: '만', en: '' }, onClick } }));
    expect(shadow().querySelector('[data-testid="aas-widget-header-action"]')).toBeNull();
  });

  it('focus() 를 부를 때마다 초점 신호가 오른다', () => {
    const w = make();
    act(() => w.focus());
    act(() => w.focus());
    expect(w.store.get().focusTick).toBe(2);
  });

  it('features 는 rect·context·headerAction·status·saveAnswer 다', () => {
    expect(make().features).toEqual([...WIDGET_FEATURES]);
    expect(WIDGET_FEATURES).toEqual(['rect', 'context', 'headerAction', 'status', 'saveAnswer', 'agent']); // saveAnswer: 스펙 2026-11-18-012 D12, agent: 2026-11-21-002 §3-7
  });
});

describe('onStatusChange(D17)', () => {
  it('위젯 상태를 호스트 상태로 바꾼다', () => {
    expect(statusEvent({ status: 'connecting' }, 'off')).toEqual({ state: 'connecting' });
    expect(statusEvent({ status: 'ready' }, 'live')).toEqual({ state: 'ready' });
    expect(statusEvent({ status: 'ready' }, 'retrying-fast')).toMatchObject({ state: 'disconnected', action: 'retry' });
    expect(statusEvent({ status: 'login' }, 'off')).toEqual({ state: 'error', code: 'token_invalid', retryable: true, action: 'relogin' });
    expect(statusEvent({ status: 'no_agent' }, 'off')).toEqual({ state: 'error', code: 'no_agent', retryable: false, action: 'open_aas' });
    expect(statusEvent({ status: 'origin' }, 'off')).toMatchObject({ action: 'contact_admin' });
  });

  it('처음 등록하면 지금 상태를 받고, 같은 상태는 다시 받지 않으며, 늦게 등록해도 한 번 받는다', () => {
    const first = vi.fn();
    const w = make({ onStatusChange: first });
    expect(first).toHaveBeenCalledWith({ state: 'connecting' });
    const n = first.mock.calls.length;
    act(() => w.store.set({ notice: '' }));
    expect(first).toHaveBeenCalledTimes(n);
    act(() => w.store.set({ status: 'no_agent' }));
    expect(first).toHaveBeenLastCalledWith(expect.objectContaining({ state: 'error', code: 'no_agent' }));
    const late = vi.fn();
    act(() => w.updateConfig({ onStatusChange: late }));
    expect(late).toHaveBeenCalledTimes(1);
    expect(late).toHaveBeenCalledWith(expect.objectContaining({ code: 'no_agent' }));
  });

  it('호스트 콜백이 던져도 위젯은 멈추지 않는다', () => {
    const w = make({
      onStatusChange: () => {
        throw new Error('host bug');
      },
    });
    act(() => w.store.set({ status: 'ready' }));
    expect(w.store.get().status).toBe('ready');
  });
});

describe('페이지 맥락(A1)', () => {
  it('맥락이 생긴 뒤 첫 메시지에만 블록을 붙이고, 페이지가 바뀌면 다시 붙인다', () => {
    const w = make();
    act(() => w.setContext(page));
    const out = chatStore.outgoing!;
    expect(out('요약해 줘')).toMatch(/^```aas-page-context\n[\s\S]*page_id: p1[\s\S]*\n```\n\n요약해 줘$/);
    expect(out('하나 더')).toBe('하나 더');
    act(() => w.setContext({ ...page, pageId: 'p2', title: '다른 페이지' }));
    expect(out('이것도')).toContain('page_id: p2');
  });

  it('칩을 지우면 붙이지 않고, 다른 페이지로 바뀌면 칩이 다시 보인다', () => {
    const w = make();
    act(() => w.setContext(page));
    act(() => w.store.set({ contextOff: 'p1' }));
    expect(chatStore.outgoing!('질문')).toBe('질문');
    act(() => w.setContext(page)); // 같은 페이지 — 지운 상태를 그대로 둔다
    expect(w.store.get().contextOff).toBe('p1');
    act(() => w.setContext({ ...page, pageId: 'p2' }));
    expect(w.store.get().contextOff).toBeNull();
  });

  it('입력 칸 위 칩: 제목, 고른 글 글자 수, 4,000자 넘으면 「잘림」', () => {
    const w = make();
    act(() => w.store.set({ status: 'ready' }));
    act(() => w.open());
    act(() => w.setContext({ ...page, selection: 'ㄱ'.repeat(4100) }));
    expect(w.store.get().contextTruncated).toBe(true);
    expect(chatStore.outgoing!('q')).toContain('4000자에서 잘림');
    act(() => w.setContext(null));
    expect(w.store.get().context).toBeNull();
    expect(chatStore.outgoing!('q')).toBe('q');
  });

  it('잘못된 맥락은 무시하고 앞의 맥락을 둔다', () => {
    const w = make();
    act(() => w.setContext(page));
    act(() => w.setContext({ ...page, url: 'javascript:x' }));
    expect(w.store.get().context?.pageId).toBe('p1');
  });

  it('data-aas-page-* 속성으로 처음 맥락을 준다', () => {
    const s = document.createElement('script');
    s.setAttribute('data-aas-backend-url', 'https://aas.example.com');
    s.setAttribute('data-aas-page-id', 'p9');
    s.setAttribute('data-aas-page-title', '첫 페이지');
    s.setAttribute('data-aas-page-url', 'https://wiki.example.com/p/9');
    s.setAttribute('data-aas-show-launcher', 'false');
    document.body.appendChild(s);
    expect(readPageAttributes(s)).toEqual({ source: 'mindwiki', pageId: 'p9', title: '첫 페이지', url: 'https://wiki.example.com/p/9' });
    let w = null as unknown as W;
    act(() => {
      w = autoInit(document)!;
    });
    expect(w.store.get().context?.pageId).toBe('p9');
    expect(w.config.showLauncher).toBe(false);
  });

  it('위젯을 없애면 보내는 글을 더는 바꾸지 않는다', () => {
    const w = make();
    act(() => w.setContext(page));
    act(() => w.destroy());
    expect(chatStore.outgoing).toBeNull();
  });
});

describe('ContextChips(A1)', () => {
  it('제목 칩·고른 글 칩을 보이고, 지우면 「다시 붙이기」로 바뀐다', async () => {
    const { render, screen, fireEvent } = await import('@testing-library/react');
    const { ContextChips } = await import('./EmbedApp');
    const w = make();
    act(() => w.setContext({ ...page, selection: '세 글자' }));
    render(<ContextChips store={w.store} />);
    expect(screen.getByTestId('aas-context-chips').textContent).toContain('이 페이지: 회의록');
    expect(screen.getByTestId('aas-context-selection').textContent).toBe('고른 글 4자');
    fireEvent.click(screen.getByLabelText('이 맥락 빼기'));
    expect(w.store.get().contextOff).toBe('p1');
    fireEvent.click(screen.getByTestId('aas-context-readd'));
    expect(w.store.get().contextOff).toBeNull();
  });
});

describe('onOpenChange(D15)', () => {
  it('열고 닫을 때 한 번씩 부르고, 머리줄 닫기도 알린다', () => {
    const onOpenChange = vi.fn();
    const w = make({ onOpenChange });
    act(() => w.open());
    act(() => w.open());
    expect(onOpenChange.mock.calls).toEqual([[true]]);
    act(() => shadow().querySelector<HTMLButtonElement>('[data-testid="aas-widget-window"] button[aria-label="닫기"]')!.click());
    expect(onOpenChange.mock.calls).toEqual([[true], [false]]);
  });
});

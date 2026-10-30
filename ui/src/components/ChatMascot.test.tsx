/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { act, fireEvent, screen } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { resetChats } from '@/features/office/AgentChat';
import { setCardAreaTop } from '@/lib/cardArea';
import { chatPopupState, closeChat, openChat, setChatMinimized } from '@/lib/chatPopup';
import { chatStore } from '@/lib/chatStore';
import { mountScreen, stubApi } from '@/test/mountScreen';

import { avoidCards, CARD_GAP, ChatMascot, clampMascot, MASCOT_KEY, MASCOT_SIZE } from './ChatMascot';

const mount = () => mountScreen(<ChatMascot />, '/office');
const button = () => screen.getByRole('button', { name: '대화 창 열기(끌어서 옮길 수 있습니다)' });

// jsdom 에는 PointerEvent 가 없어 clientX·clientY 가 사라진다 — 좌표를 싣는 MouseEvent 로 대신한다
beforeAll(() => {
  if (!('PointerEvent' in window)) {
    class FakePointerEvent extends MouseEvent {
      pointerId: number;
      constructor(type: string, init: MouseEventInit & { pointerId?: number } = {}) {
        super(type, init);
        this.pointerId = init.pointerId ?? 1;
      }
    }
    Object.defineProperty(window, 'PointerEvent', { value: FakePointerEvent, configurable: true });
  }
});

let openAgent: { mockRestore: () => void };

beforeEach(() => {
  localStorage.clear();
  stubApi({ '/api/chat': { configured: true, agents: [] }, '/api/office/chat/history': { lines: [] } });
  openAgent = vi.spyOn(chatStore, 'openAgent').mockImplementation(async () => {});
});

afterEach(() => {
  act(() => closeChat());
  resetChats();
  openAgent.mockRestore(); // restoreAllMocks 는 시험 설정의 matchMedia 가짜까지 되돌린다
});

describe('clampMascot', () => {
  const view = { w: 1000, h: 700 };
  it('화면 안의 좌표는 그대로 둔다', () => {
    expect(clampMascot({ x: 100, y: 200 }, view)).toEqual({ x: 100, y: 200 });
  });
  it('화면 밖으로 나간 좌표는 캐릭터가 전부 보이는 곳으로 당긴다', () => {
    expect(clampMascot({ x: -50, y: -9 }, view)).toEqual({ x: 0, y: 0 });
    expect(clampMascot({ x: 5000, y: 5000 }, view)).toEqual({ x: 1000 - MASCOT_SIZE, y: 700 - MASCOT_SIZE });
  });
});

// 스펙 2026-10-23-005 디자인 D8: 채팅 화면의 승인·되묻기 카드와 겹치면 카드 위로 비킨다. 비킨 자리는 저장하지 않는다
describe('avoidCards', () => {
  it('카드가 없거나 겹치지 않으면 그대로다', () => {
    expect(avoidCards({ x: 10, y: 100 }, null)).toEqual({ x: 10, y: 100 });
    expect(avoidCards({ x: 10, y: 100 }, 100 + MASCOT_SIZE + CARD_GAP)).toEqual({ x: 10, y: 100 });
  });
  it('겹치면 카드 위 끝 위로 옮기고 화면 밖으로 나가지 않는다', () => {
    expect(avoidCards({ x: 10, y: 500 }, 400)).toEqual({ x: 10, y: 400 - CARD_GAP - MASCOT_SIZE });
    expect(avoidCards({ x: 10, y: 50 }, 30)).toEqual({ x: 10, y: 0 });
  });
});

describe('ChatMascot', () => {
  it('카드가 생기면 위로 비키고, 끌어 놓으면 보이는 자리에서 시작해 놓은 자리를 저장한다(R19)', () => {
    mount();
    act(() => setCardAreaTop(300));
    const top = 300 - CARD_GAP - MASCOT_SIZE;
    expect(button().style.top).toBe(`${top}px`);
    expect(localStorage.getItem(MASCOT_KEY)).toBeNull(); // 비킨 자리는 저장하지 않는다
    fireEvent.pointerDown(button(), { clientX: 50, clientY: 50, pointerId: 1 });
    fireEvent.pointerMove(button(), { clientX: 40, clientY: 30, pointerId: 1 });
    expect(button().style.top).toBe(`${top - 20}px`); // 보이는 자리에서 시작한다 — 튀지 않는다
    fireEvent.pointerUp(button(), { clientX: 40, clientY: 30, pointerId: 1 });
    expect(JSON.parse(localStorage.getItem(MASCOT_KEY) ?? 'null')?.y).toBe(top - 20);
    act(() => setCardAreaTop(null));
  });

  it('카드가 없어지면 원래 자리로 돌아온다', () => {
    mount();
    const before = button().getAttribute('style');
    act(() => setCardAreaTop(200));
    expect(button().getAttribute('style')).not.toBe(before);
    act(() => setCardAreaTop(null));
    expect(button().getAttribute('style')).toBe(before);
  });

  it('누르면 내 에이전트와의 대화 창이 열린다', () => {
    mount();
    fireEvent.pointerDown(button(), { clientX: 10, clientY: 10, pointerId: 1 });
    fireEvent.pointerUp(button(), { clientX: 10, clientY: 10, pointerId: 1 });
    expect(chatPopupState().target).toEqual({ kind: 'chat', agent: '@primary' });
  });

  it('5px 이하로 움직인 것은 끌기가 아니라 누름이다', () => {
    mount();
    fireEvent.pointerDown(button(), { clientX: 10, clientY: 10, pointerId: 1 });
    fireEvent.pointerMove(button(), { clientX: 13, clientY: 12, pointerId: 1 });
    fireEvent.pointerUp(button(), { clientX: 13, clientY: 12, pointerId: 1 });
    expect(chatPopupState().target).not.toBeNull();
  });

  it('끌면 위치가 바뀌고 기억하며 대화 창은 열리지 않는다', () => {
    mount();
    fireEvent.pointerDown(button(), { clientX: 400, clientY: 300, pointerId: 1 });
    fireEvent.pointerMove(button(), { clientX: 300, clientY: 200, pointerId: 1 });
    fireEvent.pointerUp(button(), { clientX: 300, clientY: 200, pointerId: 1 });
    expect(chatPopupState().target).toBeNull();
    const saved = JSON.parse(localStorage.getItem(MASCOT_KEY) ?? 'null');
    expect(saved).not.toBeNull();
    expect(button().style.left).toBe(`${saved.x}px`);
    expect(button().style.top).toBe(`${saved.y}px`);
  });

  it('기억한 위치로 다시 나타나고, 화면이 줄어 밖에 있으면 안으로 당긴다', () => {
    localStorage.setItem(MASCOT_KEY, JSON.stringify({ x: 99999, y: 99999 }));
    mount();
    expect(button().style.left).toBe(`${window.innerWidth - MASCOT_SIZE}px`);
    expect(button().style.top).toBe(`${window.innerHeight - MASCOT_SIZE}px`);
  });

  it('기억한 값이 깨졌으면 기본 위치(오른쪽 아래)를 쓴다', () => {
    localStorage.setItem(MASCOT_KEY, '{"x":"abc"');
    mount();
    expect(button().style.left).toBe('');
    expect(button().style.right).toBe('20px');
  });

  it('대화 창이 떠 있는 동안은 숨기고, 닫으면 다시 보인다', () => {
    mount();
    act(() => openChat({ kind: 'chat', agent: 'default' }));
    expect(screen.queryByRole('button', { name: '대화 창 열기(끌어서 옮길 수 있습니다)' })).toBeNull();
    act(() => setChatMinimized(true)); // 최소화해도 칩이 있으니 겹쳐 두지 않는다
    expect(screen.queryByRole('button', { name: '대화 창 열기(끌어서 옮길 수 있습니다)' })).toBeNull();
    act(() => closeChat());
    expect(button()).toBeInTheDocument();
  });

  it('키보드로도 열 수 있다(Enter)', () => {
    mount();
    fireEvent.keyDown(button(), { key: 'Enter' });
    fireEvent.click(button());
    expect(chatPopupState().target).not.toBeNull();
  });
});

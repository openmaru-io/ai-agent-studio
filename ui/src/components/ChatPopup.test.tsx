/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { act, fireEvent, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resetChats } from '@/features/office/AgentChat';
import { closeChat, openChat } from '@/lib/chatPopup';
import { chatStore } from '@/lib/chatStore';
import { mountScreen, stubApi } from '@/test/mountScreen';

import { ChatPopup } from './ChatPopup';
import { useUi } from './UiContext';
import { clampRect, MIN_H, MIN_W } from './useFloatingWindow';

function OpenDrawer() {
  const ui = useUi();
  return (
    <button type="button" onClick={() => ui.openDrawer({ title: '상세', body: <input aria-label="서랍 입력" /> })}>
      서랍 열기
    </button>
  );
}

const mount = () =>
  mountScreen(
    <>
      <OpenDrawer />
      <ChatPopup />
    </>,
    '/office'
  );

let openAgent: { mockRestore: () => void };

beforeEach(() => {
  localStorage.clear();
  stubApi({
    '/api/office/chat/history': { lines: [] },
    '/api/office/chat': {},
    '/api/health': { totals: {} },
    '/api/chat': { configured: true, agents: [] },
  });
  openAgent = vi.spyOn(chatStore, 'openAgent').mockImplementation(async (name: string) => {
    chatStore.status = { configured: true, agents: [{ name, title: '마케팅' }] };
    chatStore.profile = name;
    chatStore.notify();
  });
});

afterEach(() => {
  act(() => closeChat());
  resetChats();
  openAgent.mockRestore(); // restoreAllMocks 는 시험 설정의 matchMedia 가짜까지 되돌린다
  vi.unstubAllGlobals();
});

describe('ChatPopup (OMAI-1115)', () => {
  it('오피스 자리를 열면 오피스 대화를 보이고, 최소화해도 대화를 내리지 않으며 펼치고 닫는다', async () => {
    mount();
    act(() => openChat({ kind: 'office', alias: 'ops', title: '운영' }));
    const dlg = screen.getByRole('dialog', { name: '운영 와 대화' });
    expect(dlg.querySelector('[role=log]')).not.toBeNull();
    expect(screen.queryByRole('button', { name: '크게 보기' })).toBeNull(); // 채팅 화면은 내 에이전트만
    // 제목 앞 아이콘: 장식이라 읽어 주지 않고, 창의 이름은 제목 글자 그대로다
    expect(dlg.querySelector('[data-testid=ChatBubbleOutlineIcon]')).not.toBeNull();
    expect(dlg.querySelector('[data-testid=ChatBubbleOutlineIcon]')).toHaveAttribute('aria-hidden', 'true');

    fireEvent.click(screen.getByRole('button', { name: '최소화' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.querySelector('[role=log]')).not.toBeNull(); // 숨겨도 마운트된 채로 — 답을 계속 받아 온다
    fireEvent.click(screen.getByRole('button', { name: '운영 대화 펼치기' }));
    expect(screen.getByRole('dialog', { name: '운영 와 대화' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '대화 닫기' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.querySelector('[role=log]')).toBeNull();
  });

  // 스펙 2026-10-20-030 DR14: 최소화한 대화가 다시 열기를 그만두면 칩에 빨간 점과 「연결이 끊김」. 다시 잇는 중에는 더하지 않는다
  it('최소화한 대화가 다시 열기를 그만두면 칩이 알린다', async () => {
    mount();
    act(() => openChat({ kind: 'chat', agent: 'ma' }));
    await screen.findByRole('dialog');
    const S = { id: 's-x', profile: 'ma', title: '', items: [], busy: false, unread: 0, seen: 0, closed: true } as Parameters<typeof chatStore.reopenNow>[0];
    act(() => {
      chatStore.sessions['s-x'] = S;
      chatStore.currentId = 's-x';
      S.reconnect = { tries: 1, since: Date.now(), nextAt: Date.now() + 1000, reason: 'aas' };
      chatStore.notify();
    });
    fireEvent.click(screen.getByRole('button', { name: '최소화' }));
    expect(screen.getByRole('button', { name: /펼치기$/ })).toBeInTheDocument(); // 다시 잇는 중 — 알리지 않는다
    act(() => {
      S.reconnect = undefined;
      S.items.push({ kind: 'error', text: '이 대화를 다시 열지 못했습니다.', reopen: true });
      chatStore.notify();
    });
    expect(screen.getByRole('button', { name: /연결이 끊김$/ })).toBeInTheDocument();
    act(() => {
      delete chatStore.sessions['s-x'];
      chatStore.currentId = null;
    });
  });

  it('내 에이전트는 채팅 화면과 같은 대화를 보이고, 크게 보기는 채팅 화면으로 옮긴다', async () => {
    mount();
    act(() => openChat({ kind: 'chat', agent: 'ma' }));
    expect(chatStore.openAgent).toHaveBeenCalledWith('ma');
    expect(await screen.findByRole('dialog', { name: '마케팅 와 대화' })).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: /마케팅/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '크게 보기' }));
    expect(screen.getByTestId('loc')).toHaveTextContent('/chat?agent=ma');
    expect(screen.queryByRole('dialog', { name: /와 대화/ })).toBeNull();
  });

  // 스펙 2026-10-28-014 외부 검토 M4: 크게 보기는 팝업이 보이는 그 대화(묶음·저장된 대화)를 연다
  it('크게 보기는 agent·pod·session 을 함께 넘긴다', async () => {
    mount();
    act(() => openChat({ kind: 'chat', agent: 'plan', pod: 'b' }));
    await screen.findByRole('dialog');
    const S = { id: 's-p', profile: 'plan', pod: 'b', storedId: 'st-7', title: '', items: [], busy: false, unread: 0, seen: 0 } as Parameters<typeof chatStore.reopenNow>[0];
    act(() => {
      chatStore.status = { configured: true, pod: 'b', agents: [{ name: 'plan' }] };
      chatStore.sessions['s-p'] = S;
      chatStore.currentId = 's-p';
      chatStore.notify();
    });
    fireEvent.click(screen.getByRole('button', { name: '크게 보기' }));
    expect(screen.getByTestId('loc')).toHaveTextContent(/^\/chat\?agent=plan&pod=b&session=st-7$/);
    act(() => {
      delete chatStore.sessions['s-p'];
      chatStore.currentId = null;
    });
  });

  // 2026-10-19-013 C5·DD6: 팝업 제목도 채팅 화면과 같은 규칙. 묶음을 읽기 전에는 「대화」만
  it('프로파일이 하나뿐인 에이전트는 팝업 제목이 에이전트 이름이고, 읽기 전에는 「대화」', async () => {
    openAgent.mockRestore();
    openAgent = vi.spyOn(chatStore, 'openAgent').mockImplementation(async (name: string) => {
      const g = { pod: 'a', current: true, configured: true, name: '관리자 AAS', primary: 'main', agents: [{ name }] };
      chatStore.groups = [g];
      chatStore.status = g;
      chatStore.profile = name;
      chatStore.notify();
    });
    chatStore.status = null;
    mount();
    act(() => openChat({ kind: 'chat', agent: 'main' }));
    expect(await screen.findByRole('dialog', { name: '관리자 AAS 와 대화' })).toBeInTheDocument();
    chatStore.groups = [];
  });

  it('묶음을 읽기 전에는 팝업 제목에 프로파일 이름 대신 「대화」를 보인다(DD6)', () => {
    openAgent.mockRestore();
    openAgent = vi.spyOn(chatStore, 'openAgent').mockImplementation(async () => undefined);
    chatStore.status = null;
    mount();
    act(() => openChat({ kind: 'chat', agent: 'main' }));
    expect(screen.getByRole('dialog', { name: '대화' })).toBeInTheDocument();
  });

  it('서랍이 열려 있어도 팝업에 입력할 수 있다(서랍이 포커스를 붙잡지 않는다)', async () => {
    const user = userEvent.setup();
    mount();
    await user.click(screen.getByRole('button', { name: '서랍 열기' }));
    act(() => openChat({ kind: 'office', alias: 'ops', title: '운영' }));
    const box = screen.getByRole('textbox', { name: '메시지' });
    await user.click(box);
    await user.keyboard('안녕');
    expect(box).toHaveValue('안녕');
    expect(screen.getByRole('dialog', { name: '상세' })).toBeInTheDocument(); // 서랍도 그대로 열려 있다
  });

  it('팝업이 떠 있어도 서랍 입력·Esc 닫기·닫기 전 확인(close guard)은 그대로다', async () => {
    const user = userEvent.setup();
    const guard = vi.fn(() => false);
    function GuardedDrawer() {
      const ui = useUi();
      return (
        <button
          type="button"
          onClick={() => {
            ui.openDrawer({ id: 'd1', title: '고치는 중', body: <input aria-label="서랍 입력" /> });
            ui.setCloseGuard('d1', () => guard());
          }}
        >
          확인 서랍
        </button>
      );
    }
    mountScreen(
      <>
        <GuardedDrawer />
        <ChatPopup />
      </>,
      '/office'
    );
    await user.click(screen.getByRole('button', { name: '확인 서랍' }));
    act(() => openChat({ kind: 'office', alias: 'ops', title: '운영' }));
    const input = screen.getByRole('textbox', { name: '서랍 입력' });
    await user.click(input);
    await user.keyboard('메모');
    expect(input).toHaveValue('메모');
    await user.keyboard('{Escape}');
    expect(guard).toHaveBeenCalledTimes(1); // 저장 안 한 편집 확인이 돈다 — 거절하면 서랍이 남는다
    expect(screen.getByRole('dialog', { name: '고치는 중' })).toBeInTheDocument();
    guard.mockReturnValue(true);
    await user.click(input);
    await user.keyboard('{Escape}');
    await vi.waitFor(() => expect(screen.queryByRole('dialog', { name: '고치는 중' })).toBeNull());
    expect(screen.getByRole('dialog', { name: '운영 와 대화' })).toBeInTheDocument(); // 팝업은 그대로
  });

  it('머리를 끌거나 방향키로 옮기고, 화면 밖으로 나가지 않는다', () => {
    mount();
    act(() => openChat({ kind: 'office', alias: 'ops', title: '운영' }));
    const dlg = screen.getByRole('dialog', { name: '운영 와 대화' });
    const before = dlg.style.left;
    fireEvent.keyDown(screen.getByRole('button', { name: /대화 창 옮기기/ }), { key: 'ArrowLeft' });
    expect(dlg.style.left).not.toBe(before);
    for (let i = 0; i < 200; i++) fireEvent.keyDown(screen.getByRole('button', { name: /대화 창 옮기기/ }), { key: 'ArrowLeft' });
    expect(dlg.style.left).toBe('8px');
  });

  it('창을 자기 GPU 층으로 고정해 CPU 가 바쁠 때 아래 3D 장면이 비쳐 올라오지 않게 한다', () => {
    mount();
    act(() => openChat({ kind: 'office', alias: 'ops', title: '운영' }));
    const dlg = screen.getByRole('dialog', { name: '운영 와 대화' });
    expect(getComputedStyle(dlg).willChange).toBe('transform');
    expect(getComputedStyle(dlg).transform).toBe('translateZ(0)');
  });
});

describe('clampRect', () => {
  it('최소 크기를 지키고 화면 안에 둔다', () => {
    expect(clampRect({ x: -50, y: 5000, w: 10, h: 10 }, 1000, 800)).toEqual({ x: 8, y: 800 - MIN_H - 8, w: MIN_W, h: MIN_H });
    expect(clampRect({ x: 100, y: 100, w: 5000, h: 5000 }, 1000, 800)).toEqual({ x: 8, y: 8, w: 984, h: 784 });
  });
});

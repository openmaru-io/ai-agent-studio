/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resetChats } from '@/features/office/AgentChat';
import { closeChat, openChat } from '@/lib/chatPopup';
import { closeRoomChat, openRoomChat, roomChatPopupState } from '@/lib/roomChatPopup';
import { mountScreen, postedTo, stubApi } from '@/test/mountScreen';

import { ChatPopup } from './ChatPopup';
import { RoomChatPopup } from './RoomChatPopup';

const VIEW = {
  room: { id: 4, name: 'TFT 회의실 1', purpose: '제안', status: 'open', seats: ['sa'], people: [] },
  participants: [{ alias: 'sa', title: '영업', pod: 'kim', enabled: true }],
  messages: [{ id: 1, role: 'user', author: 'kim@x.com', content: '안건을 정리합시다', ts: '2026-10-16T10:00:00+09:00' }],
  pending: [],
};

const mount = () =>
  mountScreen(
    <>
      <ChatPopup />
      <RoomChatPopup />
    </>,
    '/office'
  );

beforeEach(() => {
  localStorage.clear();
  stubApi({
    '/api/office/meeting': VIEW,
    '/api/office/meeting/say': { targets: ['sa'] },
    '/api/office/chat/history': { lines: [] },
    '/api/office/chat': {},
    '/api/health': { totals: {} },
    '/api/chat': { configured: true, agents: [] },
  });
});

afterEach(() => {
  act(() => {
    closeRoomChat();
    closeChat();
  });
  resetChats();
  vi.unstubAllGlobals();
});

const leftOf = (n: string) => parseFloat((screen.getByRole('dialog', { name: n }) as HTMLElement).style.left);

describe('RoomChatPopup (OMAI-1257)', () => {
  it('방을 열면 회의 대화(기록·받는 에이전트·입력)를 창으로 보이고, 최소화해도 내리지 않으며 펼치고 닫는다', async () => {
    mount();
    act(() => openRoomChat({ room: 4, name: 'TFT 회의실 1', canAct: true }));
    const dlg = screen.getByRole('dialog', { name: 'TFT 회의실 1 회의 채팅' });
    expect(await screen.findByText('안건을 정리합시다')).toBeInTheDocument();
    expect(dlg.querySelector('[role=log]')).not.toBeNull();
    expect(screen.getByRole('textbox', { name: '메시지' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '최소화' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.querySelector('[role=log]')).not.toBeNull(); // 숨겨도 마운트된 채로 — 답을 계속 받아 온다
    fireEvent.click(screen.getByRole('button', { name: 'TFT 회의실 1 회의 채팅 펼치기' }));
    expect(screen.getByRole('dialog', { name: 'TFT 회의실 1 회의 채팅' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '대화 닫기' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(roomChatPopupState().target).toBeNull();
  });

  it('창에서 보낸 말이 회의 말하기 API 로 간다(@이름 호출과 받는 에이전트 규칙은 회의 화면과 같다)', async () => {
    const user = userEvent.setup();
    const fn = stubApi({ '/api/office/meeting': VIEW, '/api/office/meeting/say': { targets: ['sa'] } });
    mount();
    act(() => openRoomChat({ room: 4, name: 'TFT 회의실 1', canAct: true }));
    await user.type(await screen.findByRole('textbox', { name: '메시지' }), '다음 안건{Enter}');
    await waitFor(() => expect(postedTo(fn, '/api/office/meeting/say')[0]).toMatchObject({ room: 4, text: '다음 안건', targets: ['sa'] }));
  });

  it('권한이 없으면 입력 대신 안내를 보인다', async () => {
    mount();
    act(() => openRoomChat({ room: 4, name: 'TFT 회의실 1', canAct: false }));
    expect(await screen.findByText(/관리자만/)).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: '메시지' })).toBeNull();
  });

  it('서버와 짝이 없는 회의실은 안내와 「TFT 방 탭 열기」만 보이고 회의 API 를 부르지 않는다', async () => {
    const fn = stubApi({ '/api/office/meeting': VIEW });
    mount();
    act(() => openRoomChat({ room: null, name: '대회의실', canAct: true }));
    expect(screen.getByRole('dialog', { name: '대회의실 회의 채팅' })).toBeInTheDocument();
    expect(screen.getByText(/열려 있는 회의가 없습니다/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'TFT 방 탭 열기' })).toBeInTheDocument();
    expect(fn.mock.calls.some((c) => String(c[0]).startsWith('/api/office/meeting'))).toBe(false);
  });

  it('에이전트 채팅 창과 동시에 떠 있고, 하나를 닫아도 다른 하나는 남는다', async () => {
    mount();
    act(() => {
      openChat({ kind: 'office', alias: 'ops', title: '운영' });
      openRoomChat({ room: 4, name: 'TFT 회의실 1', canAct: true });
    });
    expect(screen.getByRole('dialog', { name: '운영 와 대화' })).toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: 'TFT 회의실 1 회의 채팅' })).toBeInTheDocument();
    // 기본 자리가 겹치지 않는다: 회의실 창은 에이전트 창의 왼쪽 옆
    expect(leftOf('TFT 회의실 1 회의 채팅')).toBeLessThan(leftOf('운영 와 대화'));

    fireEvent.click(screen.getAllByRole('button', { name: '대화 닫기' })[0]);
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
  });

  it('회의실 창을 먼저 열고 에이전트 창을 나중에 열면, 나중 창이 왼쪽 옆에 놓여 서로 가리지 않는다', () => {
    mount();
    act(() => openRoomChat({ room: 4, name: 'TFT 회의실 1', canAct: true }));
    act(() => openChat({ kind: 'office', alias: 'ops', title: '운영' }));
    expect(leftOf('운영 와 대화')).toBeLessThan(leftOf('TFT 회의실 1 회의 채팅'));
  });

  it('움직이지 않은 기본 자리는 저장하지 않는다(혼자 열 때 늘 오른쪽 아래, 옆자리가 굳지 않게). 끌어서 옮기면 저장한다', () => {
    mount();
    act(() => openChat({ kind: 'office', alias: 'ops', title: '운영' }));
    act(() => openRoomChat({ room: 4, name: 'TFT 회의실 1', canAct: true }));
    expect(localStorage.getItem('aas.chatPopup.rect')).toBeNull();
    expect(localStorage.getItem('aas.roomChatPopup.rect')).toBeNull();
    const handle = screen.getAllByRole('button', { name: '대화 창 옮기기 — 끌거나 방향키' })[1];
    fireEvent.keyDown(handle, { key: 'ArrowLeft' });
    expect(localStorage.getItem('aas.roomChatPopup.rect')).not.toBeNull();
  });
});

// 창의 머리줄은 방 이름과 단추(자료·회의록 요약)를 한 줄에 두고 단추를 오른쪽 끝에 붙인다(스펙 2026-10-20-028).
// 예전에는 세로로 쌓여 이름 · 자료 · 요약 단추가 세 줄을 차지했다.
describe('RoomChatPopup 머리줄 (스펙 2026-10-20-028)', () => {
  it('방 이름 옆 같은 줄 오른쪽 끝에 「자료」·「회의록 요약 내려받기」 단추가 있다', async () => {
    stubApi({ '/api/office/meeting': { ...VIEW, files: { enabled: true, limits: { file: 1000, room: 10000, total: 100000 }, max_per_message: 10 } } });
    mount();
    act(() => openRoomChat({ room: 4, name: 'TFT 회의실 1', canAct: true }));
    const files = await screen.findByRole('button', { name: '자료' });
    const summary = screen.getByRole('button', { name: '회의록 요약 내려받기' });
    const title = screen.getByRole('heading', { level: 2, name: 'TFT 회의실 1' });
    const head = title.closest('[class*=MuiStack-root]')!.parentElement as HTMLElement; // 이름 묶음의 부모 = 머리줄
    expect(head.contains(files) && head.contains(summary)).toBe(true);
    expect(getComputedStyle(head).flexDirection).toBe('row');
    expect(getComputedStyle(head).justifyContent).toBe('space-between');
    const buttons = files.parentElement as HTMLElement; // 단추 묶음
    expect(getComputedStyle(buttons).flexWrap).toBe('nowrap');
    expect(getComputedStyle(buttons).justifyContent).toBe('flex-end');
    expect(getComputedStyle(summary.closest('[class*=MuiBox-root]') as HTMLElement).width).not.toBe('100%');
  });
});

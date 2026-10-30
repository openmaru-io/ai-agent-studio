/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it } from 'vitest';

import { chatPopupState, closeChat, openChat } from './chatPopup';
import { closeRoomChat, openRoomChat, roomChatPopupState, setRoomChatMinimized } from './roomChatPopup';

afterEach(() => {
  closeRoomChat();
  closeChat();
});

describe('회의실 채팅 창 상태 (OMAI-1257)', () => {
  it('열고 최소화하고 닫는다. 닫힌 창은 최소화할 수 없다', () => {
    setRoomChatMinimized(true);
    expect(roomChatPopupState().minimized).toBe(false);
    openRoomChat({ room: 4, name: '제안 TFT', canAct: true });
    expect(roomChatPopupState().target).toEqual({ room: 4, name: '제안 TFT', canAct: true });
    setRoomChatMinimized(true);
    expect(roomChatPopupState().minimized).toBe(true);
    openRoomChat({ room: 5, name: '다른 방', canAct: false }); // 다른 방을 열면 펼친 채로 바뀐다
    expect(roomChatPopupState()).toMatchObject({ minimized: false, target: { room: 5 } });
    closeRoomChat();
    expect(roomChatPopupState().target).toBeNull();
  });

  it('에이전트 채팅 창 상태와 섞이지 않는다', () => {
    openChat({ kind: 'office', alias: 'ops', title: '운영' });
    openRoomChat({ room: 4, name: '제안 TFT', canAct: true });
    expect(chatPopupState().target).toEqual({ kind: 'office', alias: 'ops', title: '운영' });
    closeRoomChat();
    expect(chatPopupState().target).not.toBeNull();
  });
});

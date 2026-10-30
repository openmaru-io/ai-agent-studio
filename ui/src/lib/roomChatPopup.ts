/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 3D 오피스에서 회의실 빔 스크린을 누르면 뜨는 회의실 채팅 창의 상태(OMAI-1257).
// 에이전트 대화 팝업(chatPopup.ts)과 따로 둔다: 두 창을 함께 띄울 수 있고, 서로의 상태를 바꾸지 않는다.
import { useSyncExternalStore } from 'react';

import { nextOpenOrder, raisePopup } from './popupOrder';

/** 회의실 채팅 창의 위치·크기 기억 키이자 앞뒤 순서 key(FloatingChatShell rectKey) */
export const ROOM_CHAT_RECT_KEY = 'aas.roomChatPopup.rect';

export interface RoomChatTarget {
  /** 서버의 회의 방 번호. 서버와 짝이 없는 회의실(열린 회의가 없음)이면 null */
  room: number | null;
  /** 3D 방 이름표(창 제목) */
  name: string;
  /** 보내기 권한(오피스 상태의 can_act). 누를 때의 값을 가져온다 */
  canAct: boolean;
  /** 열린 회의가 없을 때 보일 안내(번역됨). 없으면 기본 안내(office.roomChatNone). 대회의실이 쓴다(스펙 2026-10-20-017 디자인 리뷰 이슈 4) */
  emptyNote?: string;
}

interface State {
  target: RoomChatTarget | null;
  minimized: boolean;
  /** 창이 닫혀 있다가 열린 순번(에이전트 대화 창과 먼저 열린 쪽을 가린다) */
  openedAt: number;
}

let state: State = { target: null, minimized: false, openedAt: 0 };
const listeners = new Set<() => void>();

function set(next: Partial<State>) {
  state = { ...state, ...next };
  listeners.forEach((fn) => fn());
}

export function openRoomChat(target: RoomChatTarget) {
  set({ target, minimized: false, openedAt: state.target ? state.openedAt : nextOpenOrder() });
  raisePopup(ROOM_CHAT_RECT_KEY); // 다시 열어도 앞으로 — 에이전트 창 뒤에 가려져 있었을 수 있다(스펙 2026-10-20-021 N5)
}

export function closeRoomChat() {
  set({ target: null, minimized: false });
}

export function setRoomChatMinimized(minimized: boolean) {
  if (state.target) set({ minimized });
}

export function roomChatPopupState(): State {
  return state;
}

export function useRoomChatPopup(): State {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => void listeners.delete(fn);
    },
    () => state
  );
}

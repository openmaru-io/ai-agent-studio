/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 화면 위 공통 대화 팝업의 상태(OMAI-1115). 한 번에 대화 하나 — 다른 에이전트를 열면 그 대화로 바뀐다.
// 대화 경로는 둘이다:
//  - chat: 내 에이전트(프로파일 이름). chatStore 의 대화를 그대로 쓰므로 채팅 화면과 같은 대화다. pod 가 없으면 지금 POD,
//    있으면 그 에이전트(채팅 목록의 묶음, 2026-10-19-001 R2) — 오피스의 다른 내 에이전트도 머리·첨부가 있는 이 경로로 연다.
//  - office: 오피스의 다른 사람 자리(alias). /api/office/chat 으로 말한다(방 구성원도 쓸 수 있다).
import { useSyncExternalStore } from 'react';

import { chatStore } from './chatStore';
import { nextOpenOrder } from './popupOrder';

export type ChatTarget =
  | { kind: 'chat'; agent: string; text?: string; pod?: string }
  | { kind: 'office'; alias: string; title: string };

interface State {
  target: ChatTarget | null;
  minimized: boolean;
  /** 창이 닫혀 있다가 열린 순번(회의실 채팅 창과 먼저 열린 쪽을 가린다) */
  openedAt: number;
}

let state: State = { target: null, minimized: false, openedAt: 0 };
const listeners = new Set<() => void>();

function set(next: Partial<State>) {
  state = { ...state, ...next };
  listeners.forEach((fn) => fn());
}

export function openChat(target: ChatTarget) {
  set({ target, minimized: false, openedAt: state.target ? state.openedAt : nextOpenOrder() });
  if (target.kind === 'chat') {
    if (target.pod) {
      // 고른 에이전트의 묶음으로 연다. 이미 그 대화가 열려 있으면 그대로 둔다
      if (chatStore.status?.pod !== target.pod || chatStore.profile !== target.agent || !chatStore.currentId) void chatStore.openAgent(target.agent, target.pod);
    } else if (target.text) void chatStore.ask(target.agent, target.text);
    // 이름만 넘기므로 지금 에이전트의 대화다. 채팅 화면에서 다른 에이전트의 같은 이름(main)과 대화 중이면 그 대화를 잇지 않는다(R-LATE L4)
    else if (chatStore.status?.pod !== chatStore.currentPod || chatStore.resolve(target.agent) !== chatStore.profile || !chatStore.currentId)
      void chatStore.openAgent(target.agent);
  }
}

export function closeChat() {
  set({ target: null, minimized: false });
}

export function setChatMinimized(minimized: boolean) {
  if (state.target) set({ minimized });
}

export function chatPopupState(): State {
  return state;
}

export function useChatPopup(): State {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => void listeners.delete(fn);
    },
    () => state
  );
}

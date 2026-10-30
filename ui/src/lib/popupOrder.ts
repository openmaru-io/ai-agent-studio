/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 떠 있는 대화 창이 둘일 때 어느 쪽이 먼저 열렸는지 가리는 순번(OMAI-1257).
// 나중에 열린 창을 먼저 열린 창의 왼쪽 옆에 놓아 서로 가리지 않게 한다.
let seq = 0;
export const nextOpenOrder = () => ++seq;

// 마지막으로 누른 창(rectKey). 모듈 전역이라 서로 다른 창 컴포넌트가 같은 값을 본다.
// FloatingChatShell 안에 있던 것을 여기로 옮겨, 창 밖(오피스 상태판의 회의실 말풍선)에서도 창을 앞으로 올린다(스펙 2026-10-20-021 N5).
let front = '';
const frontListeners = new Set<() => void>();
export function raisePopup(key: string) {
  if (front === key) return;
  front = key;
  frontListeners.forEach((fn) => fn());
}
/** 이 창이 앞인지: 아무도 누르지 않았으면 none, 누른 창이 있으면 그 창만 front */
export const popupStanding = (key: string) => (front === '' ? 'none' : front === key ? 'front' : 'back');
export const subscribePopupFront = (fn: () => void) => {
  frontListeners.add(fn);
  return () => void frontListeners.delete(fn);
};

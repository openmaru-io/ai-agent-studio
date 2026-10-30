/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */
import { useSyncExternalStore } from 'react';

// 채팅 화면(#/chat) 입력창 위 승인·되묻기 카드 묶음의 위 끝(화면 y 좌표). 카드가 없으면 null.
// 도움말 캐릭터(AppShell 의 ChatMascot)가 카드와 겹치면 그 위로 비킨다(스펙 2026-10-23-005 디자인 D8, 재리뷰 F12).
// 주소로 연 채팅 화면만 쓴다 — 대화 팝업 안의 채팅 화면이 닫히며 지우면 #/chat 의 카드를 캐릭터가 다시 가린다(재리뷰 R20).
let top: number | null = null;
const subs = new Set<() => void>();

export function setCardAreaTop(v: number | null) {
  if (v === top) return;
  top = v;
  subs.forEach((fn) => fn());
}

export const getCardAreaTop = () => top;

export function useCardAreaTop(): number | null {
  return useSyncExternalStore(
    (fn) => {
      subs.add(fn);
      return () => subs.delete(fn);
    },
    getCardAreaTop,
    getCardAreaTop
  );
}

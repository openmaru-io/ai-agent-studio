/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 대화 링크 시험 도우미(OMAI-1115). 링크가 채팅 화면으로 가지 않고 대화 팝업을 연다 — 무엇으로 열렸는지 읽는다.
// 팝업이 여는 대화 저장소의 네트워크 호출(ask·openAgent)은 막아 둔다.
import { vi } from 'vitest';

import { chatPopupState, closeChat } from '@/lib/chatPopup';
import { chatStore } from '@/lib/chatStore';

export function watchChatPopup() {
  vi.spyOn(chatStore, 'ask').mockResolvedValue(undefined);
  vi.spyOn(chatStore, 'openAgent').mockResolvedValue(undefined);
  closeChat();
  return () => chatPopupState().target;
}

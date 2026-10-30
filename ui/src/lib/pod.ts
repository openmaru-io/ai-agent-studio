/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 지금 에이전트(aas_pod 쿠키) 바꾸기. 화면에서 에이전트를 바꾸는 곳은 모두 이것을 부른다.
// React Query 밖의 전역 상태(채팅 저장소)도 함께 비운다 — 새로고침 없이 바꾸는 대시보드에서
// 채팅이 옛 에이전트의 목록을 보여 「없는 프로파일」이 났다(2026-10-19-001 R1). 새로고침은 부르는 쪽이 정한다.
import { post } from './api';
import { chatStore } from './chatStore';
import { wsClient } from './ws';

export async function switchPod(id: string): Promise<void> {
  await post('/api/pod', { id });
  wsClient.reconnect(); // 열린 웹소켓은 옛 쿠키로 읽는다 — 서버 파드가 둘이면 서버 쪽 고침(ws.pod_changed)이 닿지 않는다
  chatStore.podChanged();
}

/** 에이전트를 바꾼 뒤 그 화면의 목록 주소(`#/<화면>`)로 새로 고친다. 열어 둔 대상(?name= 등)은 새 에이전트에 없을 수 있어 버린다
 *  (스펙 2026-10-19-019 DD5). location.replace 는 해시만 다르면 새로 고치지 않아 주소를 바꾼 뒤 reload 한다. */
export function reloadAtView(viewId: string): void {
  window.history.replaceState(null, '', `#/${viewId}`);
  window.location.reload();
}

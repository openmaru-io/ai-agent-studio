/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 회의 기록 묶음(스펙 §4-8): 같은 에이전트가 1분 안에 이어 말하면 머리줄(이름·시각)을 한 번만 보인다.
// 확정된 메시지의 ts 만 쓴다. 쓰는 중인 부분 답은 이 함수에 넣지 않는다(시각이 없고 항상 머리줄을 보인다).

export const GROUP_GAP_MS = 60_000;

export interface MeetingLine {
  role: 'user' | 'assistant' | 'system';
  author: string;
  ts: string;
  kind?: string;
}

/** 각 메시지가 머리줄을 보여야 하는지 같은 길이의 배열로 돌려준다. 사람·시스템 알림은 항상 true. */
export function groupMeeting(messages: MeetingLine[]): boolean[] {
  return messages.map((m, i) => {
    if (m.role !== 'assistant') return true;
    const p = messages[i - 1];
    if (!p || p.role !== 'assistant' || p.author !== m.author) return true;
    const a = Date.parse(m.ts);
    const b = Date.parse(p.ts);
    if (Number.isNaN(a) || Number.isNaN(b)) return true;
    return a - b > GROUP_GAP_MS;
  });
}

/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 채팅 「지난 대화」의 크론 세션 중 이 브라우저에서 이미 연 것(스펙 2026-10-15-003 R8).
// Hermes 가 읽음 상태를 주는지 확인하지 못해 브라우저에 기억한다 — 다른 기기에서는 다시 새 결과로 보인다.
const KEY = 'aas.chat.cronSeen';
const MAX = 300;

function read(): string[] {
  try {
    const v = JSON.parse(window.localStorage.getItem(KEY) ?? '[]') as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

export const seenCron = (): Set<string> => new Set(read());

/** 연 세션을 기억한다(오래된 것부터 잘라 MAX 개까지). 저장소를 쓸 수 없으면 조용히 넘어간다 */
export function markCronSeen(id: string): void {
  try {
    const next = [...read().filter((x) => x !== id), id].slice(-MAX);
    window.localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* 저장소를 못 쓰는 브라우저에서는 점이 계속 보일 뿐이다 */
  }
}

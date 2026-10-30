/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

/** 접힌 묶음 안에서 값을 적은 글 칸 수(스펙 2026-10-19-005 G13·R13). 칸반 카드(cardBrief)와 TFT 방(roomBrief)이 함께 쓴다.
 *  keys 가운데 shown(늘 보이는 칸)이 아닌 것만, 앞뒤 빈칸을 뺀 값이 있을 때 센다. 우선순위 같은 선택 칸은 keys 에 없으므로 세지 않는다. */
export function hiddenFilled<K extends string>(keys: readonly K[], shown: readonly K[], values: Partial<Record<K, string>>): number {
  return keys.filter((k) => !shown.includes(k) && !!values[k]?.trim()).length;
}

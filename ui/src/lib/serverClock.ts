/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 서버 시계 − 화면(PC) 시계(ms). 서버 시각(aas_at)을 화면 시계로 셀 때 뺀다.
// HTTP 응답의 Date 머리(초 단위, 버림)로 잰다. 버린 몫은 평균 0.5초로 채우고, 2초 미만 차이는 같은 시계로 본다.

const SAME_CLOCK_MS = 2000;
const HALF_SECOND_MS = 500;

let skew = 0;

export const serverClockSkew = (): number => skew;

export function noteServerDate(date: string | null): void {
  const at = Date.parse(date ?? '');
  if (Number.isNaN(at)) return;
  const d = at + HALF_SECOND_MS - Date.now();
  skew = Math.abs(d) < SAME_CLOCK_MS ? 0 : d;
}

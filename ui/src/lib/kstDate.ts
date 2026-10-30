/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 빌드 날짜를 한국 시간으로 적는다. 이미지 빌드 컨테이너는 UTC 라 컴퓨터 시간대를 쓰면 「+0000」이 된다.
// 모양은 커밋 날짜(git --date=iso: 「2026-10-17 19:05:51 +0900」)와 같다.
export function formatKst(d: Date): string {
  const k = new Date(d.getTime() + 9 * 3600_000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${k.getUTCFullYear()}-${p(k.getUTCMonth() + 1)}-${p(k.getUTCDate())} ${p(k.getUTCHours())}:${p(k.getUTCMinutes())}:${p(k.getUTCSeconds())} +0900`;
}

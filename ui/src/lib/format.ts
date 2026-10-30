/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 옛 화면(삭제됨. 커밋 3e3319d 의 aas/web/js/ui.js)의 표시 보조와 같은 규칙.
import { t } from '@/i18n';

import { displayTimeZone, formatInZone } from './prefs';

const HAS_ZONE = /T\d{2}:\d{2}(:\d{2}(\.\d+)?)?([zZ]|[+-]\d{2}:?\d{2})$/;

// 연도까지 보인다(2026-10-13: 해가 바뀐 기록을 구분하지 못했다).
// 시간대가 적힌 시각은 설정 › 일반의 날짜 표시 시간대(기본 브라우저)로 바꿔 보인다(스펙 2026-10-14-013).
// 시간대가 없는 시각은 어느 시간대인지 모르므로 그대로 자른다.
export const fmtTs = (ts?: string | null): string => {
  if (!ts) return '—';
  const s = String(ts);
  if (HAS_ZONE.test(s)) {
    const at = new Date(s);
    if (!Number.isNaN(at.getTime())) return formatInZone(at, displayTimeZone());
  }
  return s.slice(0, 16).replace('T', ' ');
};

/** 설정 › 일반의 시간대로 본 'YYYY-MM-DD HH:mm'. 대화 시각·날짜 구분이 같은 시간대를 쓰게 한다(디자인 리뷰 7-1). */
const zoned = (ts: number): string => formatInZone(new Date(ts), displayTimeZone());
/** 그 시간대의 HH:mm */
export const fmtClock = (ts: number): string => zoned(ts).slice(11);
/** 그 시간대의 날짜 {y, m, d} */
export const zonedDate = (ts: number): { y: number; m: number; d: number } => {
  const z = zoned(ts);
  return { y: Number(z.slice(0, 4)), m: Number(z.slice(5, 7)), d: Number(z.slice(8, 10)) };
};

export const big = (n?: number | null): string =>
  n == null
    ? '0'
    : n >= 1e9
    ? (n / 1e9).toFixed(1) + 'B'
    : n >= 1e6
    ? (n / 1e6).toFixed(1) + 'M'
    : n >= 1e4
    ? Math.round(n / 1e3) + 'k'
    : String(n);

export const profileName = (p: string): string => (p === 'default' ? t('common.profileRoot') : p);

export const plural = (n: number, unit: string): string => `${n}${unit}`;

/** 자리(에이전트) 이름 표기. 설치본 이름이 별칭과 같으면 괄호를 붙이지 않는다(같은 글자가 두 번 보이던 것, OMAI-1187 후속). */
export const seatLabel = (alias: string, pod: string): string => (pod && pod !== alias ? `${alias} (${pod})` : alias);

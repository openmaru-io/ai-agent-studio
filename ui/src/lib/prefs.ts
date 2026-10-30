/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 날짜 표시 시간대(설정 › 일반, 스펙 2026-10-14-013). 이 브라우저에만 기억한다. 빈 값이면 브라우저 시간대.
// fmtTs 가 화면을 그릴 때마다 부르므로 저장소는 처음 한 번만 읽고 값은 모듈에 둔다.

export const TZ_KEY = 'aas-tz';

const isZone = (zone: string): boolean => {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
};

function readZone(): string {
  try {
    const v = localStorage.getItem(TZ_KEY) ?? '';
    return v && isZone(v) ? v : '';
  } catch {
    return '';
  }
}

let stored: string = readZone();

export const browserTimeZone = (): string => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
};

/** 고른 시간대(빈 값 = 브라우저를 따른다) */
export const storedTimeZone = (): string => stored;

/** 화면에 시각을 보일 시간대 */
export const displayTimeZone = (): string => stored || browserTimeZone();

/** 시간대를 고른다. 빈 값이면 브라우저를 따른다. 모르는 이름은 버린다(저장소를 못 쓰면 이번 방문에서만). */
export function setStoredTimeZone(zone: string): void {
  stored = zone && isZone(zone) ? zone : '';
  try {
    if (stored) localStorage.setItem(TZ_KEY, stored);
    else localStorage.removeItem(TZ_KEY);
  } catch {
    /* 저장소를 못 쓰면 기억하지 않는다 */
  }
}

/** 고를 수 있는 시간대 이름. 브라우저가 목록을 주지 않으면 몇 개만 */
export function timeZones(): string[] {
  const list = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.('timeZone') ?? [];
  const all = new Set(list.length ? list : ['UTC', 'Asia/Seoul', 'Asia/Tokyo', 'America/New_York', 'Europe/London']);
  all.add('UTC');
  all.add(browserTimeZone());
  return [...all].sort();
}

/** 그 시간대의 UTC 차이(분) */
function offsetMinutes(zone: string, at: Date): number {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'longOffset' }).formatToParts(at);
  const name = parts.find((p) => p.type === 'timeZoneName')?.value ?? 'GMT';
  const m = /GMT([+-])(\d{1,2})(?::?(\d{2}))?/.exec(name);
  if (!m) return 0;
  const v = Number(m[2]) * 60 + Number(m[3] ?? 0);
  return m[1] === '-' ? -v : v;
}

/** `(UTC+9) Asia/Seoul` 꼴 */
export function zoneLabel(zone: string, at: Date = new Date()): string {
  const off = offsetMinutes(zone, at);
  const abs = Math.abs(off);
  const hm = `${Math.floor(abs / 60)}${abs % 60 ? `:${String(abs % 60).padStart(2, '0')}` : ''}`;
  return `(UTC${off < 0 ? '-' : '+'}${hm}) ${zone}`;
}

/** 그 시간대의 `YYYY-MM-DD HH:mm` */
export function formatInZone(at: Date, zone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(at);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}`;
}

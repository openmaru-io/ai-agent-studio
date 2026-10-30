/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// cron 식(분 시 일 월 요일)과 간격 표기(30m·every 2h)의 풀이, 다음 실행 시각 계산. 화면 미리 보기용이며 저장할 때의 검사는 Hermes 가 한다.
import { t } from '@/i18n';

/** 요일 이름. 0=일 … 6=토 */
export const dowName = (d: number) => t(`schedule.dow_${d}`);
export const pad = (n: number | string) => String(n).padStart(2, '0');

export interface Cron {
  min: Set<number>;
  hour: Set<number>;
  dom: Set<number>;
  mon: Set<number>;
  dow: Set<number>;
  domAny: boolean;
  dowAny: boolean;
  raw: string[];
}

function field(expr: string, lo: number, hi: number): Set<number> | null {
  const out = new Set<number>();
  for (const part of String(expr).split(',')) {
    const m = /^(\*|\d+)(?:-(\d+))?(?:\/(\d+))?$/.exec(part.trim());
    if (!m) return null;
    const a = m[1] === '*' ? lo : Number(m[1]);
    const b = m[1] === '*' ? hi : m[2] != null ? Number(m[2]) : m[3] ? hi : a;
    const step = m[3] ? Number(m[3]) : 1;
    if (a < lo || b > hi + (hi === 6 ? 1 : 0) || a > b || !step) return null;
    for (let v = a; v <= b; v += step) out.add(hi === 6 && v === 7 ? 0 : v);
  }
  return out;
}

export function parseCron(expr: string | undefined | null): Cron | null {
  const p = String(expr || '')
    .trim()
    .split(/\s+/);
  if (p.length !== 5) return null;
  const f = [field(p[0], 0, 59), field(p[1], 0, 23), field(p[2], 1, 31), field(p[3], 1, 12), field(p[4], 0, 6)];
  if (f.some((x) => !x)) return null;
  const [min, hour, dom, mon, dow] = f as Set<number>[];
  return { min, hour, dom, mon, dow, domAny: p[2] === '*', dowAny: p[4] === '*', raw: p };
}

/** 간격 표기를 분으로 바꾼다. 간격이 아니면 0. */
export const interval = (s: string | undefined | null): number => {
  const m = /^(?:every\s+)?(\d+)\s*(m|min|minutes?|h|hours?|d|days?)$/i.exec(String(s || '').trim());
  return m ? Number(m[1]) * (/^m/i.test(m[2]) ? 1 : /^h/i.test(m[2]) ? 60 : 1440) : 0;
};

export function nextRuns(expr: string, n = 5, from = new Date()): Date[] | null {
  const every = interval(expr);
  if (every) return Array.from({ length: n }, (_, i) => new Date(from.getTime() + every * 60000 * (i + 1)));
  const c = parseCron(expr);
  if (!c) return null;
  const out: Date[] = [];
  const t = new Date(from);
  t.setSeconds(0, 0);
  t.setMinutes(t.getMinutes() + 1);
  for (let guard = 0; out.length < n && guard < 800; guard++) {
    // 날 단위로 건너뛰며 찾는다(최대 약 2년)
    const dayOk =
      c.mon.has(t.getMonth() + 1) &&
      (c.domAny && c.dowAny
        ? true
        : c.domAny
        ? c.dow.has(t.getDay())
        : c.dowAny
        ? c.dom.has(t.getDate())
        : c.dom.has(t.getDate()) || c.dow.has(t.getDay()));
    if (dayOk)
      for (const hr of [...c.hour].sort((a, b) => a - b))
        for (const mi of [...c.min].sort((a, b) => a - b)) {
          const d = new Date(t.getFullYear(), t.getMonth(), t.getDate(), hr, mi);
          if (d >= t && out.length < n) out.push(d);
        }
    t.setDate(t.getDate() + 1);
    t.setHours(0, 0, 0, 0);
  }
  return out;
}

/** 풀이의 종류. 화면 문구가 아니라 식의 모양이라 언어와 무관하다. */
export type Words =
  | { kind: 'intervalDays' | 'intervalHours' | 'intervalMinutes'; count: number }
  | { kind: 'minutes'; count: number }
  | { kind: 'hoursAt'; count: number; minute: string }
  | { kind: 'hourly'; minute: string }
  | { kind: 'daily' | 'weekdays'; time: string }
  | { kind: 'weekly'; days: number[]; time: string }
  | { kind: 'monthly'; days: number[]; time: string };

/** 식이나 간격 표기의 모양을 가른다. 풀지 못하면 null. */
export function wordsOf(expr: string | undefined | null): Words | null {
  const every = interval(expr);
  if (every)
    return every % 1440 === 0
      ? { kind: 'intervalDays', count: every / 1440 }
      : every % 60 === 0
      ? { kind: 'intervalHours', count: every / 60 }
      : { kind: 'intervalMinutes', count: every };
  const c = parseCron(expr);
  if (!c) return null;
  const [mi, hr, dom, mon, dow] = c.raw;
  const one = /^\d+$/.test(mi) && /^\d+$/.test(hr);
  const time = one ? `${pad(hr)}:${pad(mi)}` : '';
  if (mon !== '*') return null;
  if (/^\*\/\d+$/.test(mi) && hr === '*' && dom === '*' && dow === '*') return { kind: 'minutes', count: Number(mi.slice(2)) };
  if (/^\d+$/.test(mi) && /^\*\/\d+$/.test(hr) && dom === '*' && dow === '*')
    return { kind: 'hoursAt', count: Number(hr.slice(2)), minute: pad(mi) };
  if (/^\d+$/.test(mi) && hr === '*' && dom === '*' && dow === '*') return { kind: 'hourly', minute: pad(mi) };
  if (!one) return null;
  if (dom === '*' && dow === '*') return { kind: 'daily', time };
  if (dom === '*' && dow === '1-5') return { kind: 'weekdays', time };
  if (dom === '*') return { kind: 'weekly', days: [...c.dow].sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7)), time };
  if (dow === '*') return { kind: 'monthly', days: [...c.dom].sort((a, b) => a - b), time };
  return null;
}

/** 사람이 읽는 풀이. 풀지 못하면 빈 문자열. */
export function describe(expr: string | undefined | null): string {
  const w = wordsOf(expr);
  if (!w) return '';
  switch (w.kind) {
    case 'intervalDays':
      return t('schedule.everyDays', { count: w.count });
    case 'intervalHours':
      return t('schedule.everyHours', { count: w.count });
    case 'intervalMinutes':
    case 'minutes':
      return t('schedule.everyMinutes', { count: w.count });
    case 'hoursAt':
      return t('schedule.everyHoursAt', { count: w.count, minute: w.minute });
    case 'hourly':
      return t('schedule.hourly', { minute: w.minute });
    case 'daily':
      return t('schedule.daily', { time: w.time });
    case 'weekdays':
      return t('schedule.weekdays', { time: w.time });
    case 'weekly':
      return t('schedule.weekly', { days: w.days.map(dowName).join(t('schedule.listSep')), time: w.time });
    case 'monthly':
      return t('schedule.monthly', { days: w.days.join(t('schedule.listSep')), time: w.time });
  }
}

export const fmtNext = (d: Date) =>
  `${d.getMonth() + 1}/${d.getDate()}(${dowName(d.getDay())}) ${pad(d.getHours())}:${pad(d.getMinutes())}`;

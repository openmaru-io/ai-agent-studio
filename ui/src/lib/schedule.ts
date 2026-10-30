/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 크론 주기 편집기의 계산: 식 → 편집 상태, 편집 상태 → 식, 그리고 작업 한 줄 요약.
// 화면 미리 보기용이며 저장할 때의 검사는 Hermes 가 한다.
import { t } from '@/i18n';

import { describe, interval, pad, parseCron, wordsOf } from './cronmath';

export type ScheduleMode = 'daily' | 'weekdays' | 'weekly' | 'monthly' | 'minutes' | 'hours' | 'custom';

export interface ScheduleState {
  mode: ScheduleMode;
  time: string; // HH:mm
  days: number[]; // 0=일 … 6=토
  dom: number;
  n: number;
  custom: string;
}

export function initialSchedule(current: string | undefined | null): ScheduleState {
  const c = parseCron(current);
  const every = interval(current);
  const words = wordsOf(current)?.kind;
  const mode: ScheduleMode = every
    ? every % 60 === 0
      ? 'hours'
      : 'minutes'
    : !c
    ? 'custom'
    : words === 'daily'
    ? 'daily'
    : words === 'weekdays'
    ? 'weekdays'
    : words === 'weekly'
    ? 'weekly'
    : words === 'monthly'
    ? 'monthly'
    : words === 'minutes'
    ? 'minutes'
    : words === 'hoursAt'
    ? 'hours'
    : 'custom';
  const oneTime = c && /^\d+$/.test(c.raw[0]) && /^\d+$/.test(c.raw[1]);
  return {
    mode,
    time: oneTime ? `${pad(c.raw[1])}:${pad(c.raw[0])}` : '09:00',
    days: c && !c.dowAny ? [...c.dow].sort((a, b) => a - b) : [1],
    dom: c && !c.domAny ? [...c.dom][0] : 1,
    n: every
      ? every % 60 === 0
        ? every / 60
        : every
      : c && /^\*\/\d+$/.test(c.raw[0])
      ? Number(c.raw[0].slice(2))
      : c && /^\*\/\d+$/.test(c.raw[1])
      ? Number(c.raw[1].slice(2))
      : 30,
    custom: current || '',
  };
}

export function buildExpr(s: ScheduleState): string {
  const [hh, mm] = s.time.split(':').map(Number);
  switch (s.mode) {
    case 'daily':
      return `${mm} ${hh} * * *`;
    case 'weekdays':
      return `${mm} ${hh} * * 1-5`;
    case 'weekly':
      return `${mm} ${hh} * * ${[...s.days].sort((a, b) => a - b).join(',') || '1'}`;
    case 'monthly':
      return `${mm} ${hh} ${s.dom} * *`;
    case 'minutes':
      return `*/${Math.max(1, Math.min(59, s.n))} * * * *`;
    case 'hours':
      return `0 */${Math.max(1, Math.min(23, s.n))} * * *`;
    default:
      return s.custom.trim();
  }
}

const kind = (d: string) => String(d).split(':')[0];
const deliverWord = (d?: string) =>
  !d || d === 'local'
    ? t('schedule.deliverLocal')
    : t('schedule.deliverTo', {
        target: kind(d) === 'telegram' ? t('schedule.targetTelegram') : kind(d) === 'buzz' ? t('schedule.targetBuzz') : d,
      });

export interface JobContext {
  profile: string;
  schedule?: string;
  skill?: string;
  script?: string;
  deliver?: string;
  noAgent?: boolean;
}

export function summaryLine({ profile, schedule, skill, script, deliver, noAgent }: JobContext): string {
  const when =
    describe(schedule) || (schedule ? t('schedule.whenRaw', { schedule }) : t('schedule.whenNone'));
  const what = skill
    ? t('schedule.runSkill', { skill })
    : script
    ? t('schedule.runScript', { script })
    : t('schedule.followPrompt');
  return t(noAgent ? 'schedule.summaryNoAgent' : 'schedule.summary', { when, profile, what, deliver: deliverWord(deliver) });
}

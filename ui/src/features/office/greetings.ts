/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 3D 오피스에서 마주친 에이전트의 인사와 혼자 서 있는 에이전트의 혼잣말(스펙 2026-10-21-021, OMAI-1429).
// 전에는 둘 다 「...」만 보였다. 문구는 사전(office.greet.* · office.mutter.*)에 두고, 여기서는 언제 무엇을 고를지만 정한다.
// 시각·난수는 인자로 받아 시험에서 결과를 고정한다.
import { textWidthEm } from '@/features/office/scene3d/retro-office/core/nameplate';

/** 언제 쓰는 문구인가. again(다시 만남)·bump(쉼 안에 또 부딪힘)는 시각이 아니라 만남 기록으로 고른다 */
export type GreetWhen = 'any' | 'morning' | 'lunch' | 'afternoon' | 'evening' | 'monday' | 'friday' | 'again' | 'bump';

/** {name} 자리를 남긴 번역 문구. 먼저 하는 말의 {name} 은 답하는 쪽, 답의 {name} 은 먼저 말한 쪽 이름이다 */
export interface GreetPair {
  id: string;
  when: GreetWhen;
  open: string;
  reply: string;
}

export interface MutterLine {
  id: string;
  when: GreetWhen;
  text: string;
}

export interface GreetingLines {
  pairs: GreetPair[];
  mutters: MutterLine[];
}

/** 한 번 인사한 에이전트는 이 동안 새 인사 대신 부딪힘 문구를 쓴다 */
export const GREET_COOLDOWN_MS = 20_000;
/** 같은 짝이 이 안에 또 부딪히면 부딪힘 문구도 쓰지 않는다(1.5초 멈춤 + 1.2초 쉼이라 3초마다 부딪힐 수 있다) */
export const BUMP_LINE_COOLDOWN_MS = 8_000;
/** 같은 짝이 이 안에 다시 마주치면 다시 만남 문구 */
export const AGAIN_WINDOW_MS = 10 * 60_000;
export const GREET_REPLY_DELAY_MS = 700;
export const GREET_SHOW_MS = 2_400;
export const MUTTER_SHOW_MS = 2_500;
const MUTTER_MIN_MS = 18_000;
const MUTTER_MAX_MS = 26_000;
/** 이름은 한글 6자 폭까지 */
const NAME_MAX_EM = 6 * 0.95;

export const GREET_PAIRS: { id: string; when: GreetWhen }[] = [
  { id: 'hello', when: 'any' },
  { id: 'how', when: 'any' },
  { id: 'wellbeing', when: 'any' },
  { id: 'busy', when: 'any' },
  { id: 'effort', when: 'any' },
  { id: 'glad', when: 'any' },
  { id: 'where', when: 'any' },
  { id: 'work', when: 'any' },
  { id: 'thanks', when: 'any' },
  { id: 'coffee', when: 'any' },
  { id: 'condition', when: 'any' },
  { id: 'niceDay', when: 'any' },
  { id: 'morning', when: 'morning' },
  { id: 'early', when: 'morning' },
  { id: 'lunch', when: 'lunch' },
  { id: 'lunchMenu', when: 'lunch' },
  { id: 'sleepy', when: 'afternoon' },
  { id: 'evening', when: 'evening' },
  { id: 'stillHere', when: 'evening' },
  { id: 'monday', when: 'monday' },
  { id: 'friday', when: 'friday' },
  { id: 'again', when: 'again' },
  { id: 'againName', when: 'again' },
  { id: 'oops', when: 'bump' },
  { id: 'afterYou', when: 'bump' },
  { id: 'whoa', when: 'bump' },
  { id: 'narrow', when: 'bump' },
];

export const MUTTERS: { id: string; when: GreetWhen }[] = [
  { id: 'coffee', when: 'any' },
  { id: 'todo', when: 'any' },
  { id: 'idea', when: 'any' },
  { id: 'stretchUp', when: 'any' },
  { id: 'rest', when: 'any' },
  { id: 'next', when: 'any' },
  { id: 'mail', when: 'any' },
  { id: 'smooth', when: 'any' },
  { id: 'bug', when: 'any' },
  { id: 'test', when: 'any' },
  { id: 'docs', when: 'any' },
  { id: 'kanban', when: 'any' },
  { id: 'water', when: 'any' },
  { id: 'learned', when: 'any' },
  { id: 'stretch', when: 'any' },
  { id: 'going', when: 'any' },
  { id: 'cheerUp', when: 'morning' },
  { id: 'morningCoffee', when: 'morning' },
  { id: 'lunch', when: 'lunch' },
  { id: 'needCoffee', when: 'afternoon' },
  { id: 'wrapUp', when: 'evening' },
  { id: 'gotALot', when: 'evening' },
  { id: 'newWeek', when: 'monday' },
  { id: 'weekend', when: 'friday' },
];

/** 사전에서 문구를 꺼낸다. {name} 은 비워 두어 t 가 자리표시를 그대로 남긴다 */
export function greetingLines(t: (key: string) => string): GreetingLines {
  return {
    pairs: GREET_PAIRS.map((p) => ({
      ...p,
      open: t(`office.greet.${p.id}.open`),
      reply: t(`office.greet.${p.id}.reply`),
    })),
    mutters: MUTTERS.map((m) => ({ ...m, text: t(`office.mutter.${m.id}`) })),
  };
}

/** 브라우저 시각 기준. again·bump 는 시각으로 맞지 않는다 */
export function whenMatches(when: GreetWhen, date: Date): boolean {
  const min = date.getHours() * 60 + date.getMinutes();
  switch (when) {
    case 'any':
      return true;
    case 'morning':
      return min < 11 * 60;
    case 'lunch':
      return min >= 11 * 60 + 30 && min < 13 * 60 + 30;
    case 'afternoon':
      return min >= 14 * 60 && min < 16 * 60;
    case 'evening':
      return min >= 17 * 60;
    case 'monday':
      return date.getDay() === 1;
    case 'friday':
      return date.getDay() === 5;
    default:
      return false;
  }
}

/** 공백을 하나로 줄이고, 한글 6자 폭을 넘으면 자르고 … 를 붙인다 */
export function shortName(name: string): string {
  const normalized = name.replace(/\s+/g, ' ').trim();
  if (textWidthEm(normalized) <= NAME_MAX_EM) return normalized;
  const chars = Array.from(normalized);
  while (chars.length > 1 && textWidthEm(chars.join('')) > NAME_MAX_EM) chars.pop();
  return chars.join('').trimEnd() + '…';
}

export type GreetKind = 'fresh' | 'again' | 'bump';

/** 만남 기록으로 무엇을 말할지 정한다. null 이면 풍선을 보이지 않는다 */
export function greetKind(o: { now: number; cooldown?: boolean; pairGreetAt?: number; pairBumpAt?: number }): GreetKind | null {
  if (o.cooldown) {
    if (o.pairBumpAt !== undefined && o.now - o.pairBumpAt < BUMP_LINE_COOLDOWN_MS) return null;
    return 'bump';
  }
  if (o.pairGreetAt !== undefined && o.now - o.pairGreetAt < AGAIN_WINDOW_MS) return 'again';
  return 'fresh';
}

const fillName = (text: string, name: string) => text.replace(/\{name\}/g, name);

/** 인사 한 쌍을 고른다. 이름이 비어 채울 수 없는 쌍은 빼고, 고를 것이 둘 이상이면 바로 앞 쌍(avoid)도 뺀다 */
export function pickGreeting(o: {
  pairs: GreetPair[];
  kind: GreetKind;
  date: Date;
  rand: () => number;
  names: { opener: string; replier: string };
  avoid?: string;
}): { id: string; open: string; reply: string } | null {
  const opener = shortName(o.names.opener);
  const replier = shortName(o.names.replier);
  const fits = (p: GreetPair) => (replier || !p.open.includes('{name}')) && (opener || !p.reply.includes('{name}'));
  const inKind = (p: GreetPair) => (o.kind === 'fresh' ? whenMatches(p.when, o.date) : p.when === o.kind);
  let candidates = o.pairs.filter((p) => inKind(p) && fits(p));
  if (candidates.length > 1 && o.avoid) candidates = candidates.filter((p) => p.id !== o.avoid);
  if (!candidates.length) return null;
  const p = candidates[Math.min(candidates.length - 1, Math.floor(o.rand() * candidates.length))];
  return { id: p.id, open: fillName(p.open, replier), reply: fillName(p.reply, opener) };
}

function hash(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);

/** 에이전트마다 주기(18~26초)와 시작 어긋남을 id 로 정해, 여럿이 같은 순간에 말하지 않게 한다 */
export function mutterCycle(agentId: string): { period: number; offset: number } {
  const h = hash(agentId);
  const period = MUTTER_MIN_MS + (h % (MUTTER_MAX_MS - MUTTER_MIN_MS + 1));
  return { period, offset: (h >>> 8) % period };
}

/** 지금 보일 혼잣말. 주기마다 한 번, 2.5초 동안. 주기마다 문구를 한 칸씩(에이전트마다 다른 보폭) 옮겨 두 번 연속 같은 문구가 나오지 않는다.
 *  매 프레임 에이전트마다 부르므로 보이는 구간이 아니면 날짜를 만들지 않고 바로 끝낸다(date 를 생략하면 nowMs 로 만든다) */
export function mutterAt(agentId: string, nowMs: number, date: Date | undefined, lines: MutterLine[]): string | null {
  if (!lines.length) return null;
  const { period, offset } = mutterCycle(agentId);
  const cycle = Math.floor((nowMs + offset) / period);
  if (nowMs + offset - cycle * period >= MUTTER_SHOW_MS) return null;
  const when = date ?? new Date(nowMs);
  const candidates = lines.filter((l) => whenMatches(l.when, when));
  if (!candidates.length) return null;
  const n = candidates.length;
  if (n === 1) return candidates[0].text;
  const h = hash(`${agentId}:mutter`);
  let step = 1 + (h % (n - 1));
  while (gcd(step, n) !== 1) step = step === n - 1 ? 1 : step + 1;
  const index = (((h >>> 4) + cycle * step) % n + n) % n;
  return candidates[index].text;
}

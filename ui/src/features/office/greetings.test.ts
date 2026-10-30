/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';

import {
  AGAIN_WINDOW_MS,
  BUMP_LINE_COOLDOWN_MS,
  GREET_COOLDOWN_MS,
  GREET_PAIRS,
  greetingLines,
  greetKind,
  type GreetPair,
  MUTTER_SHOW_MS,
  mutterAt,
  mutterCycle,
  MUTTERS,
  pickGreeting,
  shortName,
  whenMatches,
} from '@/features/office/greetings';
import { fitLabel, textWidthEm } from '@/features/office/scene3d/retro-office/core/nameplate';
import { dictionaries, t } from '@/i18n';

// 2026-10-21 은 수요일이다
const at = (h: number, m = 0, day = 21) => new Date(2026, 9, day, h, m);
const fixed = (v: number) => () => v;

const pairs: GreetPair[] = [
  { id: 'hello', when: 'any', open: '{name}님, 안녕하세요!', reply: '네, 안녕하세요!' },
  { id: 'how', when: 'any', open: '오늘 어때요?', reply: '순조로워요!' },
  { id: 'morning', when: 'morning', open: '좋은 아침이에요!', reply: '좋은 아침입니다!' },
  { id: 'friday', when: 'friday', open: '벌써 금요일이에요!', reply: '주말 잘 보내세요' },
  { id: 'again', when: 'again', open: '또 뵙네요!', reply: '{name}님도요' },
  { id: 'oops', when: 'bump', open: '앗, 죄송해요!', reply: '괜찮아요~' },
];

describe('whenMatches', () => {
  it('시간대·요일 묶음은 그때만 맞는다', () => {
    expect(whenMatches('morning', at(10, 59))).toBe(true);
    expect(whenMatches('morning', at(11))).toBe(false);
    expect(whenMatches('lunch', at(11, 29))).toBe(false);
    expect(whenMatches('lunch', at(11, 30))).toBe(true);
    expect(whenMatches('lunch', at(13, 30))).toBe(false);
    expect(whenMatches('afternoon', at(14))).toBe(true);
    expect(whenMatches('afternoon', at(16))).toBe(false);
    expect(whenMatches('evening', at(16, 59))).toBe(false);
    expect(whenMatches('evening', at(17))).toBe(true);
    expect(whenMatches('monday', at(12, 0, 19))).toBe(true);
    expect(whenMatches('monday', at(12))).toBe(false);
    expect(whenMatches('friday', at(12, 0, 23))).toBe(true);
    expect(whenMatches('any', at(3))).toBe(true);
    expect(whenMatches('again', at(12))).toBe(false);
    expect(whenMatches('bump', at(12))).toBe(false);
  });
});

describe('shortName', () => {
  it('한글 6자 폭까지 두고 넘으면 자르고 … 를 붙인다', () => {
    expect(shortName('  YJ   Bot ')).toBe('YJ Bot');
    expect(shortName('관리자 Hermes')).toBe('관리자 Her…');
    const cut = shortName('omai1286-e2e-very-long');
    expect(cut.endsWith('…')).toBe(true);
    expect(textWidthEm(cut.slice(0, -1))).toBeLessThanOrEqual(6 * 0.95);
  });
});

describe('greetKind', () => {
  const now = 1_000_000;
  it('처음 만나면 인사, 10분 안이면 다시 만남, 쉼 안이면 부딪힘', () => {
    expect(greetKind({ now })).toBe('fresh');
    expect(greetKind({ now, pairGreetAt: now - GREET_COOLDOWN_MS - 1 })).toBe('again');
    expect(greetKind({ now, pairGreetAt: now - AGAIN_WINDOW_MS - 1 })).toBe('fresh');
    expect(greetKind({ now, cooldown: true })).toBe('bump');
    expect(greetKind({ now, cooldown: true, pairBumpAt: now - BUMP_LINE_COOLDOWN_MS + 1 })).toBeNull();
    expect(greetKind({ now, cooldown: true, pairBumpAt: now - BUMP_LINE_COOLDOWN_MS })).toBe('bump');
  });
});

describe('pickGreeting', () => {
  const names = { opener: 'YJBot', replier: '관리자 Hermes' };
  it('먼저 하는 말에는 답하는 쪽, 답에는 먼저 말한 쪽 이름을 넣는다', () => {
    const p = pickGreeting({ pairs, kind: 'fresh', date: at(12), rand: fixed(0), names });
    expect(p).toEqual({ id: 'hello', open: '관리자 Her…님, 안녕하세요!', reply: '네, 안녕하세요!' });
    const again = pickGreeting({ pairs, kind: 'again', date: at(12), rand: fixed(0), names });
    expect(again?.reply).toBe('YJBot님도요');
  });

  it('시간대·요일 묶음은 그때만 섞인다', () => {
    const ids = (date: Date) =>
      new Set([0, 0.2, 0.4, 0.6, 0.8, 0.99].map((r) => pickGreeting({ pairs, kind: 'fresh', date, rand: fixed(r), names })?.id));
    expect(ids(at(12))).toEqual(new Set(['hello', 'how']));
    expect(ids(at(9))).toEqual(new Set(['hello', 'how', 'morning']));
    expect(ids(at(12, 0, 23))).toEqual(new Set(['hello', 'how', 'friday']));
  });

  it('다시 만남·부딪힘은 그 묶음에서만 고른다', () => {
    expect(pickGreeting({ pairs, kind: 'again', date: at(9), rand: fixed(0.5), names })?.id).toBe('again');
    expect(pickGreeting({ pairs, kind: 'bump', date: at(9), rand: fixed(0.5), names })?.id).toBe('oops');
  });

  it('이름이 비면 이름이 들어간 쌍을 고르지 않는다', () => {
    for (const r of [0, 0.3, 0.6, 0.99]) {
      expect(pickGreeting({ pairs, kind: 'fresh', date: at(12), rand: fixed(r), names: { opener: 'A', replier: ' ' } })?.id).toBe('how');
    }
    expect(pickGreeting({ pairs, kind: 'again', date: at(12), rand: fixed(0), names: { opener: '', replier: 'B' } })).toBeNull();
  });

  it('바로 앞에 쓴 쌍은 피한다', () => {
    expect(pickGreeting({ pairs, kind: 'fresh', date: at(12), rand: fixed(0), names, avoid: 'hello' })?.id).toBe('how');
    // 고를 것이 하나뿐이면 그대로 쓴다
    expect(pickGreeting({ pairs, kind: 'bump', date: at(12), rand: fixed(0), names, avoid: 'oops' })?.id).toBe('oops');
  });
});

describe('mutterAt', () => {
  const lines = [
    { id: 'a', when: 'any' as const, text: 'A' },
    { id: 'b', when: 'any' as const, text: 'B' },
    { id: 'c', when: 'any' as const, text: 'C' },
    { id: 'm', when: 'morning' as const, text: 'M' },
  ];

  it('에이전트마다 18~26초 주기로 2.5초 동안만 보인다', () => {
    const { period, offset } = mutterCycle('agent-1');
    expect(period).toBeGreaterThanOrEqual(18_000);
    expect(period).toBeLessThanOrEqual(26_000);
    const start = period * 100 - offset;
    expect(mutterAt('agent-1', start, at(12), lines)).not.toBeNull();
    expect(mutterAt('agent-1', start + MUTTER_SHOW_MS - 1, at(12), lines)).toBe(mutterAt('agent-1', start, at(12), lines));
    expect(mutterAt('agent-1', start + MUTTER_SHOW_MS, at(12), lines)).toBeNull();
    expect(mutterAt('agent-1', start - 1, at(12), lines)).toBeNull();
  });

  it('두 주기 연속 같은 문구가 나오지 않고, 시간대 문구는 그때만 나온다', () => {
    const { period, offset } = mutterCycle('agent-2');
    const seen: string[] = [];
    for (let c = 1; c < 200; c += 1) seen.push(mutterAt('agent-2', c * period - offset, at(12), lines) ?? '');
    for (let i = 1; i < seen.length; i += 1) expect(seen[i]).not.toBe(seen[i - 1]);
    expect(seen).not.toContain('M');
    expect(seen).not.toContain('');
    const morning = new Set<string>();
    for (let c = 1; c < 200; c += 1) morning.add(mutterAt('agent-2', c * period - offset, at(9), lines) ?? '');
    expect(morning.has('M')).toBe(true);
  });

  it('에이전트마다 주기가 달라 같은 순간에 모두 말하지 않는다', () => {
    const cycles = ['a1', 'a2', 'a3', 'a4', 'a5'].map((id) => mutterCycle(id).period);
    expect(new Set(cycles).size).toBeGreaterThan(1);
  });

  it('문구가 없으면 아무것도 보이지 않는다', () => {
    const { period, offset } = mutterCycle('x');
    expect(mutterAt('x', period * 3 - offset, at(12), [])).toBeNull();
  });
});

describe('사전 문구', () => {
  it('모든 쌍·혼잣말 키가 두 사전에 있다', () => {
    for (const lang of ['ko', 'en'] as const) {
      for (const p of GREET_PAIRS) {
        expect(dictionaries[lang][`office.greet.${p.id}.open`], `${lang} ${p.id}.open`).toBeTruthy();
        expect(dictionaries[lang][`office.greet.${p.id}.reply`], `${lang} ${p.id}.reply`).toBeTruthy();
      }
      for (const m of MUTTERS) expect(dictionaries[lang][`office.mutter.${m.id}`], `${lang} ${m.id}`).toBeTruthy();
    }
  });

  it('스펙의 개수(인사 27쌍, 혼잣말 24개)와 같다', () => {
    expect(GREET_PAIRS).toHaveLength(27);
    expect(MUTTERS).toHaveLength(24);
  });

  it('greetingLines 는 {name} 자리를 남긴 채 번역한다', () => {
    const lines = greetingLines(t);
    expect(lines.pairs.find((p) => p.id === 'hello')?.open).toContain('{name}');
    expect(lines.mutters).toHaveLength(24);
  });

  it('가장 긴 이름을 넣어도 모든 문구가 알약 폭 1.4 안에 한 줄로 들어간다', () => {
    const longest = shortName('가나다라마바사아자차카');
    for (const lang of ['ko', 'en'] as const) {
      const d = dictionaries[lang];
      const texts = [
        ...GREET_PAIRS.flatMap((p) => [d[`office.greet.${p.id}.open`], d[`office.greet.${p.id}.reply`]]),
        ...MUTTERS.map((m) => d[`office.mutter.${m.id}`]),
      ].map((s) => s.replace('{name}', longest));
      for (const text of texts) expect(fitLabel(text, 1.4 - 0.1, 0.075, 0.06).text, `${lang}: ${text}`).toBe(text);
    }
  });
});

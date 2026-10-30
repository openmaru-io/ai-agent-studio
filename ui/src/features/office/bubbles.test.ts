/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';

import { bubbles, isAway, MAX_BUBBLES } from './bubbles';
import { applyOfficeEvent, ServerAgent } from './model';

const A = (alias: string, extra: Partial<ServerAgent> = {}): ServerAgent => ({
  alias,
  pod: 'p',
  profile: alias,
  status: 'idle',
  title: '',
  role: '',
  team: '',
  avatar: '',
  ...extra,
});
const words = { tool: (n: string) => `도구: ${n}`, private: '답하는 중 · 대화 비공개' };

describe('bubbles', () => {
  it('답 글이 있으면 글, 도구만 있으면 도구 이름, 둘 다 없으면 비공개 표시', () => {
    const out = bubbles([A('a'), A('b'), A('c')], { a: { text: '안녕', at: 1 }, b: { tool: 'web', at: 2 }, c: { at: 3 } }, words, null);
    expect(out).toEqual({ a: '안녕', b: '도구: web', c: '답하는 중 · 대화 비공개' });
  });

  it('동시에 최대 6개, 내 에이전트와 따라가는 에이전트가 먼저다', () => {
    const agents = Array.from({ length: 9 }, (_, i) => A(`x${i}`, { mine: i === 8 }));
    const act = Object.fromEntries(agents.map((a, i) => [a.alias, { tool: 't', at: i }]));
    const out = bubbles(agents, act, words, 'x0');
    expect(Object.keys(out)).toHaveLength(MAX_BUBBLES);
    expect(out).toHaveProperty('x8');
    expect(out).toHaveProperty('x0');
  });

  it('사람의 답을 기다리는 에이전트는 「응답 필요」가 가장 먼저다', () => {
    const agents = Array.from({ length: 8 }, (_, i) => A(`x${i}`, { mine: i === 0 }));
    const act = Object.fromEntries(agents.map((a, i) => [a.alias, { tool: 't', at: i }]));
    const out = bubbles(agents, act, { ...words, needsAnswer: '응답 필요' }, null, new Set(['x7', 'ghost']));
    expect(out.x7).toBe('응답 필요');
    expect(out).not.toHaveProperty('ghost'); // 장면에 없는 별칭은 그리지 않는다
    expect(Object.keys(out)[0]).toBe('x7');
  });

  it('30분 넘게 활동이 없으면 부재, 시각을 모르면 부재가 아니다', () => {
    expect(isAway(A('a', { last_seen: 0 }), 31 * 60)).toBe(true);
    expect(isAway(A('a', { last_seen: 0 }), 29 * 60)).toBe(false);
    expect(isAway(A('a'), 99999)).toBe(false);
    expect(isAway(A('a', { status: 'working', last_seen: 0 }), 99999)).toBe(false);
  });
});

describe('applyOfficeEvent — 활동', () => {
  const base = { agents: [A('ma')], seq: 1 };
  it('도구·답 글을 활동으로 쌓고 대화가 끝나면 지운다', () => {
    let s = applyOfficeEvent(base, 2, { type: 'tool', payload: { alias: 'ma', name: 'web' } }).state;
    s = applyOfficeEvent(s, 3, { type: 'chat.delta', payload: { alias: 'ma', text: '안녕' } }).state;
    expect(s.activity?.ma).toMatchObject({ tool: 'web', text: '안녕' });
    s = applyOfficeEvent(s, 4, { type: 'chat.end', payload: { alias: 'ma' } }).state;
    expect(s.activity?.ma).toBeUndefined();
  });

  it('마지막 활동 시각을 에이전트에 반영한다', () => {
    const s = applyOfficeEvent(base, 2, { type: 'agent.lastSeen', payload: { alias: 'ma', ts: 123 } }).state;
    expect(s.agents[0].last_seen).toBe(123);
  });
});

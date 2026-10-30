/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';

import { hueOf } from '@/lib/chatTokens';

import { applyOfficeEvent, OfficeState, toOfficeAgent } from './model';

const AGENT = (alias: string, status: 'idle' | 'working' | 'error' = 'idle', extra = {}) => ({
  alias,
  pod: 'p1',
  profile: alias,
  status,
  title: '',
  role: '',
  team: '',
  avatar: '',
  ...extra,
});

describe('toOfficeAgent', () => {
  it('별칭을 id 로, 제목이 있으면 제목을 이름으로 쓴다', () => {
    const a = toOfficeAgent(AGENT('ma', 'working', { title: '마케팅', role: '기획', team: '성장' }));
    expect(a).toMatchObject({ id: 'ma', name: '마케팅', status: 'working', subtitle: '기획 · 성장' });
  });

  it('내 에이전트 표시(mine)를 장면에 넘긴다. 값이 없으면 false 다(스펙 2026-10-21-012)', () => {
    expect(toOfficeAgent(AGENT('ma', 'idle', { mine: true })).mine).toBe(true);
    expect(toOfficeAgent(AGENT('ma', 'idle', { mine: false })).mine).toBe(false);
    expect(toOfficeAgent(AGENT('ma')).mine).toBe(false);
  });

  it('제목이 없으면 별칭, 역할·팀이 없으면 부제는 null', () => {
    expect(toOfficeAgent(AGENT('ops'))).toMatchObject({ name: 'ops', subtitle: null });
    expect(toOfficeAgent(AGENT('ops', 'idle', { role: '운영' })).subtitle).toBe('운영');
  });

  it('이름은 직함 > 서버가 준 화면 이름(label, 에이전트 이름) > 별칭 순이다. 색·물건·아바타는 별칭 기준이라 이름이 달라도 그대로다(2026-10-18-017)', () => {
    const named = toOfficeAgent(AGENT('aas-agent-x', 'idle', { label: 'AAS 관리자' }));
    expect(named.name).toBe('AAS 관리자');
    expect(named.id).toBe('aas-agent-x');
    expect(toOfficeAgent(AGENT('aas-agent-x', 'idle', { label: 'AAS 관리자', title: '운영 담당' })).name).toBe('운영 담당');
    expect(toOfficeAgent(AGENT('aas-agent-x', 'idle', { label: '' })).name).toBe('aas-agent-x');
    const plain = toOfficeAgent(AGENT('aas-agent-x'));
    expect([named.color, named.item]).toEqual([plain.color, plain.item]);
  });

  it('같은 별칭은 늘 같은 색·물건·아바타를 받는다(다시 열어도 모습이 바뀌지 않는다)', () => {
    const a = toOfficeAgent(AGENT('ma'));
    const b = toOfficeAgent(AGENT('ma'));
    expect(a.color).toBe(b.color);
    expect(a.item).toBe(b.item);
    expect(a.avatarProfile).toEqual(b.avatarProfile);
    expect(a.color).toMatch(/^#[0-9a-f]{6}$/i);
    // 3D 이름표 색은 화면 칩의 점 색과 같다
    expect(a.color).toBe(hueOf('ma'));
    expect(toOfficeAgent(AGENT('zzz')).color).not.toBe(a.color);
  });
});

describe('applyOfficeEvent', () => {
  const base: OfficeState = { agents: [AGENT('ma'), AGENT('ops')], seq: 3 };

  it('snapshot 은 통째로 바꾼다', () => {
    const next = applyOfficeEvent(base, 9, {
      type: 'snapshot',
      payload: { agents: [AGENT('x')], seq: 9, desks: { office_0: 'x' }, layout_version: 2 },
    });
    expect(next.state).toEqual({ agents: [AGENT('x')], seq: 9, desks: { office_0: 'x' }, layoutVersion: 2, rooms: [] });
    expect(next.refresh).toBe(false);
  });

  it('책상 배정·레이아웃이 바뀌면 상태를 다시 받는다(책상은 스냅샷에 실려 온다)', () => {
    for (const type of ['desks.changed', 'layout.changed']) {
      expect(applyOfficeEvent(base, 5, { type, payload: {} }).refresh).toBe(true);
    }
  });

  it('상태가 바뀌어도 책상 배정은 그대로 둔다', () => {
    const withDesks = { ...base, desks: { office_0: 'ma' }, layoutVersion: 1 };
    const next = applyOfficeEvent(withDesks, 6, { type: 'chat.start', payload: { alias: 'ma' } });
    expect(next.state.desks).toEqual({ office_0: 'ma' });
    expect(next.state.layoutVersion).toBe(1);
  });

  it('agent.status 는 그 자리의 상태만 바꾼다', () => {
    const next = applyOfficeEvent(base, 4, {
      type: 'agent.status',
      payload: { alias: 'ma', status: 'working', prev: 'idle' },
    });
    expect(next.state.agents.map((a) => [a.alias, a.status])).toEqual([
      ['ma', 'working'],
      ['ops', 'idle'],
    ]);
    expect(next.state.seq).toBe(4);
  });

  it('chat.start·chat.end 도 working/idle 로 바로 반영한다(5초 주기보다 빠르게)', () => {
    const s1 = applyOfficeEvent(base, 4, { type: 'chat.start', payload: { alias: 'ops', session: 's' } }).state;
    expect(s1.agents[1].status).toBe('working');
    const s2 = applyOfficeEvent(s1, 5, { type: 'chat.end', payload: { alias: 'ops', session: 's' } }).state;
    expect(s2.agents[1].status).toBe('idle');
  });

  it('chat.end 는 error 로 알려진 자리를 idle 로 덮지 않는다', () => {
    const s = applyOfficeEvent({ agents: [AGENT('ma', 'error')], seq: 1 }, 2, {
      type: 'chat.end',
      payload: { alias: 'ma', session: 's' },
    }).state;
    expect(s.agents[0].status).toBe('error');
  });

  it('자리가 늘거나 줄면 다시 받으라고 알린다', () => {
    expect(applyOfficeEvent(base, 4, { type: 'seat.added', payload: { alias: 'new', status: 'idle' } }).refresh).toBe(
      true
    );
    expect(applyOfficeEvent(base, 4, { type: 'seat.removed', payload: { alias: 'ma' } }).refresh).toBe(true);
  });

  it('모르는 별칭이나 이벤트는 상태를 그대로 두고 번호만 올린다', () => {
    expect(
      applyOfficeEvent(base, 5, { type: 'agent.status', payload: { alias: 'nobody', status: 'working' } }).state
    ).toEqual({ agents: base.agents, seq: 5 });
    expect(applyOfficeEvent(base, 6, { type: 'tool', payload: { alias: 'ma', name: 'web' } }).state.agents).toEqual(
      base.agents
    );
    expect(applyOfficeEvent(base, 7, { type: 'zzz', payload: {} }).state.seq).toBe(7);
  });

  it('원래 상태를 바꾸지 않는다', () => {
    applyOfficeEvent(base, 4, { type: 'agent.status', payload: { alias: 'ma', status: 'working' } });
    expect(base.agents[0].status).toBe('idle');
  });
});

/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';

import { countByStatus, deskOf, filterAgents, hudRooms, orderAgents, sceneStatus, statusChanges } from './hud';
import type { ServerAgent } from './model';

const A = (alias: string, status: string, extra: Partial<ServerAgent> = {}): ServerAgent => ({
  alias,
  pod: 'p',
  profile: alias,
  status: status as ServerAgent['status'],
  title: '',
  role: '',
  team: '',
  avatar: '',
  ...extra,
});

describe('hud', () => {
  it('서버가 모르는 상태 값은 숨기지 않고 확인 불가로 센다', () => {
    expect(sceneStatus(A('x', 'weird'))).toBe('unknown');
    expect(countByStatus([A('a', 'working'), A('b', 'idle'), A('c', 'error'), A('d', '???')])).toEqual({
      working: 1,
      idle: 1,
      error: 1,
      away: 0,
      unknown: 1,
    });
  });

  it('명단은 내 에이전트를 맨 위에 두고 그다음 오류·일함 순이다', () => {
    const list = [A('zed', 'idle'), A('bad', 'error'), A('busy', 'working'), A('mine', 'idle')];
    expect(orderAgents(list, (a) => a.alias === 'mine').map((a) => a.alias)).toEqual(['mine', 'bad', 'busy', 'zed']);
  });

  it('상태판에서 고른 상태로 명단을 거른다', () => {
    const list = [A('a', 'working'), A('b', 'idle')];
    expect(filterAgents(list, 'working').map((a) => a.alias)).toEqual(['a']);
    expect(filterAgents(list, null)).toHaveLength(2);
  });

  it('상태가 바뀐 에이전트만 알린다(새로 나온 자리는 알리지 않는다)', () => {
    const prev = [A('a', 'idle'), A('b', 'idle')];
    const next = [A('a', 'error'), A('b', 'idle'), A('c', 'working')];
    expect(statusChanges(prev, next).map((a) => a.alias)).toEqual(['a']);
  });

  it('책상 배정을 별칭 기준으로 뒤집는다', () => {
    expect(deskOf({ office_0: 'a', office_3: 'b' }).get('b')).toBe('office_3');
  });
});

// 스펙 2026-10-20-021: 상태판 「회의실」 탭의 판정(문구는 OfficeHud 가 만든다, N3)
describe('hudRooms', () => {
  const room = (id: number, name: string, extra: Record<string, unknown> = {}) => ({ id, name, purpose: '', seats: [] as string[], status: 'open', ...extra });
  const here = () => ({ point: { x: 1, y: 2 }, movedTo: null });
  const nowhere = () => ({ point: null, movedTo: null });

  it('닫힌 방을 빼고 팀 방을 앞으로, 같은 종류 안은 서버가 준 순서(최근 방 먼저)를 지킨다(R2·D7)', () => {
    const rows = hudRooms(
      [room(9, '나중 TFT'), room(8, '닫힌 TFT', { status: 'closed' }), room(5, '마케팅팀', { kind: 'team' }), room(3, '먼저 TFT', { kind: 'tft' })],
      [],
      new Set(),
      here
    );
    expect(rows.map((r) => r.id)).toEqual([5, 9, 3]);
  });

  it('회의가 시작돼도 순서가 바뀌지 않는다(누르려는 행이 움직이지 않게, R2)', () => {
    const rooms = [room(9, 'A'), room(3, 'B')];
    expect(hudRooms(rooms, [{ room: 3 }], new Set(), here).map((r) => r.id)).toEqual([9, 3]);
  });

  it('kind 가 없는 방은 TFT 방이다(F6)', () => {
    expect(hudRooms([room(1, 'x')], [], new Set(), here)[0].kind).toBe('tft');
  });

  it('회의 없음 idle, 짝 회의실에서 회의 중 live, 다른 회의실에 모이면 moved 와 그곳 이름', () => {
    const placeOf = (id: number) => (id === 2 ? { point: { x: 0, y: 0 }, movedTo: '대회의실' } : here());
    const [a, b, c] = hudRooms([room(1, 'a'), room(2, 'b'), room(3, 'c')], [{ room: 1 }, { room: 2 }], new Set(), placeOf);
    expect([a.state, a.placeLabel]).toEqual(['live', null]);
    expect([b.state, b.placeLabel]).toEqual(['moved', '대회의실']);
    expect([c.state, c.placeLabel]).toEqual(['idle', null]);
  });

  it('에이전트 수는 지금 오피스에 있는 에이전트만 센다(R10)', () => {
    expect(hudRooms([room(1, 'a', { seats: ['x', 'y', 'gone'] })], [], new Set(['x', 'y']), here)[0].agents).toBe(2);
  });

  it('장면에 자리가 없으면 place=false(행이 창을 연다, DR5)', () => {
    expect(hudRooms([room(1, 'a')], [], new Set(), nowhere)[0].place).toBe(false);
    expect(hudRooms([room(1, 'a')], [], new Set(), here)[0].place).toBe(true);
  });
});

/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';

import { agentSeats, applyPresence, freeSeats, pickTarget, PUB_EVERY_MS, SeatGeometry, seatOnRay, seatRefused, shouldPublish } from './people';

const SIZE: Record<string, [number, number]> = { desk_cubicle: [100, 55], chair: [24, 24], round_table: [120, 120], couch: [66, 28], beanbag: [40, 40] };
const sizeOf = (it: { type: string; w?: number; h?: number }) => [it.w ?? SIZE[it.type]?.[0] ?? 40, it.h ?? SIZE[it.type]?.[1] ?? 40];
// 시험용 모양: 모델 상자 = 항목 크기, 회전 = facing(도)
const geom: SeatGeometry = {
  box: (it) => ({ minX: 0, maxX: sizeOf(it)[0], minZ: 0, maxZ: sizeOf(it)[1] }),
  rotation: (it) => ((it.facing ?? 0) * Math.PI) / 180,
  place: (it, lx, lz) => {
    const [w, h] = sizeOf(it);
    const r = ((it.facing ?? 0) * Math.PI) / 180;
    const dx = lx - w / 2;
    const dz = lz - h / 2;
    return { x: it.x + w / 2 + Math.cos(r) * dx + Math.sin(r) * dz, y: it.y + h / 2 - Math.sin(r) * dx + Math.cos(r) * dz };
  },
};
const items = [
  { _uid: 'd1', type: 'desk_cubicle', x: 100, y: 100 },
  { _uid: 'c1', type: 'chair', x: 138, y: 170 }, // d1 앞 의자
  { _uid: 'd2', type: 'desk_cubicle', x: 400, y: 100 },
  { _uid: 'c2', type: 'chair', x: 438, y: 170 }, // d2 앞 의자
  { _uid: 'p1', type: 'plant', x: 0, y: 0 },
];

describe('freeSeats', () => {
  it('책상 앞 의자에 앉는다 — 에이전트 책상의 의자와 남이 앉은 의자는 뺀다', () => {
    expect(freeSeats(items, { d1: 'kim' }, new Set(), geom).map((s) => s.uid)).toEqual(['c2']);
    expect(freeSeats(items, {}, new Set(['c2']), geom).map((s) => s.uid)).toEqual(['c1']);
  });

  it('의자는 가까운 탁자·책상을 바라보고 그 반대쪽에서 들어온다', () => {
    const [c] = freeSeats([{ _uid: 't', type: 'round_table', x: 0, y: 0 }, { _uid: 'c', type: 'chair', x: 48, y: 140 }], {}, new Set(), geom);
    expect(Math.abs(c.f - Math.PI)).toBeLessThan(0.01); // 북쪽(탁자)을 본다
    expect(c.out.y).toBeGreaterThan(0.99); // 남쪽에서 들어온다
  });

  it('소파는 길이에 따라 여러 자리로 나누고 앉은 자리만 빠진다', () => {
    const seats = freeSeats([{ _uid: 'sofa', type: 'couch', x: 0, y: 0, w: 66, h: 28 }], {}, new Set(['sofa:0']), geom);
    expect(seats.map((s) => s.uid)).toEqual(['sofa:1']);
    expect(seats[0]).toMatchObject({ x: 49.5, y: 14 });
  });

  it('회전한 소파는 자리도 함께 돈다', () => {
    const seats = freeSeats([{ _uid: 's', type: 'couch', x: 0, y: 0, w: 66, h: 28, facing: 90 }], {}, new Set(), geom);
    expect(seats.map((s) => Math.round(s.x))).toEqual([33, 33]); // 세로로 섰다
    expect(seats.map((s) => s.y).sort((a, b) => a - b)).toEqual([-2.5, 30.5]);
  });

  it('빈백은 한 자리', () => {
    expect(freeSeats([{ _uid: 'bb', type: 'beanbag', x: 0, y: 0 }], {}, new Set(), geom).map((s) => s.uid)).toEqual(['bb']);
  });
});

describe('pickTarget', () => {
  const seats = freeSeats(items, {}, new Set(), geom);
  it('책상을 눌러도 그 앞 의자에 앉으러 간다', () => {
    expect(pickTarget(150, 130, seats).sit).toBe('c1');
  });
  it('멀리 누르면 그냥 그곳으로 걷는다', () => {
    expect(pickTarget(900, 900, seats)).toEqual({ x: 900, y: 900, f: 0, sit: '' });
  });
  it('책상 윗면을 눌러(바닥에서는 책상 뒤로 계산된다) 의자에서 멀어도 그 책상의 의자로 간다', () => {
    expect(pickTarget(150, 40, seats).sit).toBe(''); // 책상 상자 밖 뒤쪽 — 그냥 걷는다
    expect(pickTarget(150, 70, seats, 70, [{ x: 100, y: 100, w: 100, h: 55 }]).sit).toBe('c1');
    // 위아래 두 책상 사이를 누르면 더 가까운 책상의 의자
    const two = [{ x: 400, y: -100, w: 100, h: 55 }, { x: 100, y: 100, w: 100, h: 55 }];
    expect(pickTarget(150, 80, seats, 70, two).sit).toBe('c1');
  });
});

describe('seatOnRay', () => {
  // 섬 한 줄: 에이전트 책상 d1 의 의자 c1, 그 옆 팀장 책상 d2 의 빈 의자 c2
  const all = freeSeats(items, {}, new Set(), geom);
  const free = freeSeats(items, { d1: 'kim' }, new Set(), geom);
  const c1 = all.find((s) => s.uid === 'c1')!;
  it('바닥 점만 보면 에이전트 책상 의자를 눌러도 책상 가운데에서 가까운 다른 빈 의자로 간다', () => {
    expect(pickTarget(c1.x, c1.y - 30, free, 320, [{ x: 100, y: 100, w: 100, h: 55 }]).sit).toBe('c2');
  });
  it('광선이 지나간 의자를 고른다 — 바닥 점이 책상 쪽으로 밀려도', () => {
    const samples = [{ x: c1.x, y: c1.y + 20 }, { x: c1.x, y: c1.y + 5 }, { x: c1.x, y: c1.y - 30 }];
    expect(seatOnRay(samples, all, all)).toEqual({ x: c1.x, y: c1.y, f: c1.f, sit: 'c1' });
  });
  it('남의 자리(에이전트 책상 의자)를 누르면 다른 자리로 가지 않고 그 옆에 선다', () => {
    expect(seatOnRay([{ x: c1.x, y: c1.y }], free, all)).toEqual({ x: c1.x, y: c1.y, f: c1.f, sit: '' });
  });
  it('카메라에 가까운(먼저 지나간) 자리를 고른다', () => {
    const c2 = all.find((s) => s.uid === 'c2')!;
    expect(seatOnRay([{ x: c2.x, y: c2.y }, { x: c1.x, y: c1.y }], all, all)?.sit).toBe('c2');
  });
  it('자리 근처를 지나지 않으면 null — 바닥 걷기·책상 누르기로 넘긴다', () => {
    expect(seatOnRay([{ x: 900, y: 900 }, { x: 150, y: 120 }], all, all)).toBeNull();
  });
});

describe('agentSeats', () => {
  const all = freeSeats(items, {}, new Set(), geom);
  const c1 = all.find((s) => s.uid === 'c1')!;
  const agent = (over: Partial<{ x: number; y: number; targetX: number; targetY: number; state: string }>) => ({
    x: 900, y: 900, targetX: 900, targetY: 900, state: 'standing', ...over,
  });
  it('앉아 있는 에이전트의 자리와 앉으러 걸어오는 에이전트의 목적지 자리를 돌려준다', () => {
    expect([...agentSeats(all, [agent({ x: c1.x + 3, y: c1.y, state: 'sitting' })])]).toEqual(['c1']);
    expect([...agentSeats(all, [agent({ targetX: c1.x, targetY: c1.y - 2, state: 'walking' })])]).toEqual(['c1']);
  });
  it('배정만 되고 자리를 비운(서 있거나 다른 곳으로 걷는) 에이전트의 자리는 비어 있다', () => {
    expect(agentSeats(all, [agent({ x: c1.x, y: c1.y, state: 'standing' })]).size).toBe(0);
    expect(agentSeats(all, [agent({ x: c1.x, y: c1.y, targetX: 500, targetY: 500, state: 'walking' })]).size).toBe(0);
  });
});

describe('shouldPublish', () => {
  const a = { x: 10, y: 10, f: 0, sit: '' };
  it('처음은 보내고, 0.25초 안에는 보내지 않고, 바뀌지 않았으면 보내지 않는다', () => {
    expect(shouldPublish(null, a, 0, 0)).toBe(true);
    expect(shouldPublish(a, { ...a, x: 50 }, 1000, 1000 + PUB_EVERY_MS - 1)).toBe(false);
    expect(shouldPublish(a, { ...a, x: 50 }, 1000, 1000 + PUB_EVERY_MS)).toBe(true);
    expect(shouldPublish(a, { ...a, x: 10.4 }, 0, 5000)).toBe(false);
    expect(shouldPublish(a, { ...a, sit: 'd1' }, 0, 5000)).toBe(true);
  });
});

describe('seatRefused', () => {
  it('의자 자리에서 sit 없이 돌아오면 먼저 앉은 사람이 있다', () => {
    const asked = { x: 340, y: 95, f: 0, sit: 'd2' };
    expect(seatRefused(asked, { ...asked, sit: '' })).toBe(true);
    expect(seatRefused(asked, { x: 200, y: 95, f: 0, sit: '' })).toBe(false); // 걸어오는 중에 보낸 위치
    expect(seatRefused(asked, asked)).toBe(false);
  });
});

describe('applyPresence', () => {
  it('스냅샷으로 바꾸고, 걸음은 고치고, 떠나면 뺀다', () => {
    let m = applyPresence({ old: { x: 1, y: 1, f: 0, sit: '' } }, {
      type: 'snapshot',
      payload: { people: [{ id: 'a', pos: { x: 5, y: 5, f: 0, sit: '' } }, { id: 'b' }] },
    });
    expect(Object.keys(m)).toEqual(['a']);
    m = applyPresence(m, { type: 'person.move', payload: { id: 'b', x: 9, y: 9, f: 1, sit: 'c1' } });
    expect(m.b).toEqual({ x: 9, y: 9, f: 1, sit: 'c1' });
    m = applyPresence(m, { type: 'person.leave', payload: { id: 'a' } });
    expect(Object.keys(m)).toEqual(['b']);
  });
});

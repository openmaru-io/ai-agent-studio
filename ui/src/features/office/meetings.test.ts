/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { createElement, ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildAasKoreanOffice } from '@/features/office/scene3d/retro-office/core/aasKoreanOffice';
import { getMeetingSeatLocations } from '@/features/office/scene3d/retro-office/core/navigation';
import type { FurnitureItem } from '@/features/office/scene3d/retro-office/core/types';
import { stubApi } from '@/test/mountScreen';

import { meetingForRoom, meetingPlaceLabel, meetingPlaces, meetingSeatsByAgent, roomOfScreen, roomPlace, roomsInMeeting, roomStatuses, toStandup, useActiveMeetingsState } from './meetings';
import bigRoomFixture from './meetingsBigRoom.fixture.json';

// 대회의실 규칙(스펙 2026-10-20-017)은 대회의실(kind 'meeting')이 있는 배치에서 시험한다. 기본 배치는 kr-21 부터 대회의실이 없어
// (스펙 2026-10-26-007) kr-20 배치를 고정 파일로 둔다. 관리자가 편집으로 대회의실을 다시 두면 이 규칙이 그대로 돈다
const bigRoomLayout = () => bigRoomFixture.items as FurnitureItem[];

describe('toStandup', () => {
  it('장면에 있는 참가자만 회의실로 모으고, 말하는 에이전트의 글을 싣는다', () => {
    const s = toStandup(
      { room: 3, name: 'TFT', seats: ['a', 'b', 'gone'], pending: ['a'], speaker: 'a', at: 1, partial: { a: '지금 쓰는 답' } },
      new Set(['a', 'b']),
      (x) => x.toUpperCase()
    );
    expect(s?.participantOrder).toEqual(['a', 'b']);
    expect(s?.phase).toBe('in_progress');
    expect(s?.currentSpeakerAgentId).toBe('a');
    expect(s?.cards.find((c) => c.agentId === 'a')?.speech).toBe('지금 쓰는 답');
    expect(s?.cards.find((c) => c.agentId === 'b')?.agentName).toBe('B');
  });

  it('구성원이 아니면 글 없이 위치만, 장면에 아무도 없으면 회의를 그리지 않는다', () => {
    const s = toStandup({ room: 3, name: 'TFT', seats: ['a'], pending: [], speaker: null, at: 1 }, new Set(['a']), (x) => x);
    expect(s?.cards[0].speech).toBe('');
    expect(toStandup({ room: 3, name: 'TFT', seats: ['z'], pending: [], speaker: null, at: 1 }, new Set(['a']), (x) => x)).toBeNull();
    expect(toStandup(undefined, new Set(), (x) => x)).toBeNull();
  });
});

describe('meetingSeatsByAgent (계획 2026-10-13-001 R4)', () => {
  const items = bigRoomLayout();
  const tft = items.filter((i) => i.type === 'room' && i.kind === 'tft');
  const big = items.find((i) => i.type === 'room' && i.kind === 'meeting')!;
  const inside = (s: { x: number; y: number }, r: (typeof items)[number]) =>
    s.x >= r.x && s.x <= r.x + (r.w ?? 0) && s.y >= r.y && s.y <= r.y + (r.h ?? 0) + 30;
  const m = (room: number, seats: string[], at: number) => ({ room, seats, pending: [], speaker: null, at });

  it('회의마다 짝지어진 TFT 회의실 의자에 앉고, 짝이 없으면 대회의실을 쓴다', () => {
    const rooms = [
      { uid: tft[0]._uid, kind: 'tft', label: 'A', room: 1 },
      { uid: tft[1]._uid, kind: 'tft', label: 'B', room: 2 },
    ];
    const present = new Set(['a', 'b', 'c', 'd', 'e']);
    const seats = meetingSeatsByAgent([m(1, ['a', 'b'], 1), m(2, ['c'], 2), m(9, ['d'], 3)], rooms, items, present);
    expect(inside(seats.a, tft[0]) && inside(seats.b, tft[0])).toBe(true);
    expect(inside(seats.c, tft[1])).toBe(true);
    expect(inside(seats.d, big)).toBe(true);
    expect(seats.a).not.toEqual(seats.b);
    expect(seats.e).toBeUndefined();
  });

  it('의자가 모자라면 말하는 에이전트·답하는 중인 에이전트부터 앉힌다(계획 2026-10-13-011)', () => {
    const rooms = [{ uid: tft[0]._uid, kind: 'tft', label: 'A', room: 1 }];
    const chairs = 6;
    const seats = Array.from({ length: chairs + 2 }, (_, i) => `a${i}`);
    const present = new Set(seats);
    const got = meetingSeatsByAgent(
      [{ room: 1, seats, pending: ['a7'], speaker: 'a6', at: 1 }],
      rooms,
      items,
      present
    );
    const placed = (a: string) => inside(got[a], tft[0]) && got[a].facing !== Math.PI;
    expect(placed('a6') && placed('a7')).toBe(true);
    expect(seats.filter((a) => got[a]).length).toBe(seats.length);
  });

  it('두 회의에 든 에이전트는 먼저 시작한 회의로 간다', () => {
    const rooms = [
      { uid: tft[0]._uid, kind: 'tft', label: 'A', room: 1 },
      { uid: tft[1]._uid, kind: 'tft', label: 'B', room: 2 },
    ];
    const seats = meetingSeatsByAgent([m(2, ['x'], 5), m(1, ['x'], 1)], rooms, items, new Set(['x']));
    expect(inside(seats.x, tft[0])).toBe(true);
  });
});

describe('roomOfScreen (OMAI-1257)', () => {
  const items = buildAasKoreanOffice();

  it('모든 회의실 빔 스크린은 자기가 걸린 방 하나로 이어지고, 방마다 스크린 하나씩이다', () => {
    const screens = items.filter((i) => i.type === 'tv_meeting');
    const rooms = items.filter((i) => i.type === 'room');
    expect(screens).toHaveLength(rooms.length);
    const found = screens.map((s) => roomOfScreen(items, s._uid)?._uid);
    expect(found.every(Boolean)).toBe(true);
    expect(new Set(found).size).toBe(rooms.length);
  });

  it('대회의실 스크린은 대회의실 방으로 이어진다(대회의실이 있는 배치)', () => {
    const items = bigRoomLayout();
    const big = items.find((i) => i.type === 'room' && i.kind === 'meeting')!;
    const screen = items.find((i) => i.type === 'tv_meeting' && roomOfScreen(items, i._uid)?._uid === big._uid);
    expect(screen).toBeDefined();
  });

  it('스크린이 아니거나 어느 방에도 들지 않으면 undefined 다', () => {
    expect(roomOfScreen(items, items.find((i) => i.type === 'desk_cubicle')!._uid)).toBeUndefined();
    expect(roomOfScreen(items, 'nope')).toBeUndefined();
    const lone = { _uid: 'x', type: 'tv_meeting', x: 5000, y: 5000, w: 150, h: 6 };
    expect(roomOfScreen([...items, lone], 'x')).toBeUndefined();
  });
});

// 스펙 2026-10-26-007(사용자 결정): 기본 배치에 대회의실이 없으면 짝 회의실이 없는 회의는 회의실로 옮기지 않고 제자리에서 한다
describe('대회의실이 없는 기본 배치(kr-21)', () => {
  const items = buildAasKoreanOffice();
  const team = items.filter((i) => i.type === 'room' && i.kind === 'team');
  const m = (room: number, seats: string[], at: number) => ({ room, seats, pending: [], speaker: null, at });
  const rooms = team.map((t, k) => ({ uid: t._uid, kind: 'team', label: `팀${k} 회의실`, room: k + 1 }));

  it('북쪽 회의실은 모두 같은 팀 회의실 3개이고 의자가 10개씩이며, 대회의실이 없다', () => {
    expect(items.filter((i) => i.type === 'room' && i.kind === 'meeting')).toEqual([]);
    expect(team).toHaveLength(3);
    for (const t of team) expect(getMeetingSeatLocations(items, { x: t.x, y: t.y, w: t.w ?? 0, h: t.h ?? 0 }), t.label).toHaveLength(10);
  });

  it('짝 회의실이 없는 회의는 장소가 없고(제자리), 짝 있는 회의는 자기 회의실 의자에 앉는다', () => {
    const present = new Set(['a', 'b', 'z']);
    const meetings = [m(1, ['a', 'b'], 1), m(9, ['z'], 2)];
    expect(meetingPlaces(meetings, rooms, items).get(9)).toBeUndefined();
    expect([...roomsInMeeting(meetings, rooms, items)]).toEqual([team[0]._uid]);
    const seats = meetingSeatsByAgent(meetings, rooms, items, present);
    expect(seats.z).toBeUndefined();
    const t = team[0];
    expect(seats.a.x >= t.x && seats.a.x <= t.x + (t.w ?? 0) && seats.a.y <= t.y + (t.h ?? 0)).toBe(true);
  });

  it('팀 회의실 의자(10개)보다 에이전트가 많아도 옮겨 갈 대회의실이 없어 자기 회의실에 남는다', () => {
    const many = Array.from({ length: 12 }, (_, i) => `p${i}`);
    expect(meetingPlaces([m(2, many, 1)], rooms, items).get(2)).toBe(team[1]._uid);
  });
});

describe('roomsInMeeting (2026-10-16: 회의실 명패의 회의 중 표시)', () => {
  const items = bigRoomLayout();
  const tft = items.filter((i) => i.type === 'room' && i.kind === 'tft');
  const big = items.find((i) => i.type === 'room' && i.kind === 'meeting')!;
  const rooms = [
    { uid: tft[0]._uid, kind: 'tft', label: 'A', room: 1 },
    { uid: tft[1]._uid, kind: 'tft', label: 'B', room: 2 },
  ];
  const m = (room: number) => ({ room, seats: ['a'], pending: [], speaker: null, at: 1 });

  it('열린 회의가 짝지어진 방만 회의 중이다', () => {
    expect([...roomsInMeeting([m(2)], rooms, items)]).toEqual([tft[1]._uid]);
  });

  it('짝이 없는 회의는 회의 자리를 대회의실로 옮기는 규칙과 같이 대회의실이 회의 중이다', () => {
    expect([...roomsInMeeting([m(9)], rooms, items)]).toEqual([big._uid]);
  });

  it('열린 회의가 없으면 어느 방도 회의 중이 아니다', () => {
    expect(roomsInMeeting([], rooms, items).size).toBe(0);
  });
});

describe('meetingPlaces (스펙 2026-10-20-017: 큰 팀 회의는 대회의실)', () => {
  const items = bigRoomLayout();
  const team = items.filter((i) => i.type === 'room' && i.kind === 'team');
  const tft = items.filter((i) => i.type === 'room' && i.kind === 'tft');
  const big = items.find((i) => i.type === 'room' && i.kind === 'meeting')!;
  const rooms = [
    { uid: team[0]._uid, kind: 'team', label: '가팀 회의실', room: 1 },
    { uid: team[1]._uid, kind: 'team', label: '나팀 회의실', room: 2 },
    { uid: tft[0]._uid, kind: 'tft', label: 'TFT', room: 3 },
  ];
  const agents = (n: number, p = 'a') => Array.from({ length: n }, (_, i) => `${p}${i}`);
  const m = (room: number, seats: string[], at: number) => ({ room, seats, pending: [], speaker: null, at });
  const inside = (s: { x: number; y: number }, r: (typeof items)[number]) =>
    s.x >= r.x && s.x <= r.x + (r.w ?? 0) && s.y >= r.y && s.y <= r.y + (r.h ?? 0) + 30;
  // 남쪽을 보는 의자도 facing 이 π 라 서 있는 자리와 방향으로는 가르지 못한다 — 의자 좌표로 가른다
  const bigChairs = new Set(
    getMeetingSeatLocations(items, { x: big.x, y: big.y, w: big.w ?? 0, h: big.h ?? 0 }).map((c) => `${c.x},${c.y}`)
  );
  const onChair = (s: { x: number; y: number }) => bigChairs.has(`${s.x},${s.y}`);

  it('팀 회의실 의자(6개)보다 에이전트가 많은 팀 회의는 대회의실로 간다', () => {
    const seats = agents(7);
    const meetings = [m(1, seats, 1)];
    expect(meetingPlaces(meetings, rooms, items).get(1)).toBe(big._uid);
    expect([...roomsInMeeting(meetings, rooms, items)]).toEqual([big._uid]);
    const got = meetingSeatsByAgent(meetings, rooms, items, new Set(seats));
    expect(seats.every((a) => onChair(got[a]))).toBe(true);
  });

  it('의자가 충분한 팀 회의는 팀 회의실에 그대로 있다', () => {
    expect(meetingPlaces([m(1, agents(6), 1)], rooms, items).get(1)).toBe(team[0]._uid);
  });

  it('짝 없는 회의가 먼저 시작했으면 큰 팀은 자기 팀 회의실에 남는다(R2)', () => {
    const got = meetingPlaces([m(9, ['x'], 1), m(1, agents(7), 2)], rooms, items);
    expect(got.get(9)).toBe(big._uid);
    expect(got.get(1)).toBe(team[0]._uid);
  });

  it('큰 팀이 먼저면 늦게 온 짝 없는 회의가 대회의실을 같이 쓰고, 서 있는 자리까지 모든 자리가 다르다(R2·R6)', () => {
    const seats = agents(9);
    const meetings = [m(1, seats, 1), m(9, ['x', 'y', 'z'], 2)];
    const got = meetingPlaces(meetings, rooms, items);
    expect([got.get(1), got.get(9)]).toEqual([big._uid, big._uid]);
    const placed = meetingSeatsByAgent(meetings, rooms, items, new Set([...seats, 'x', 'y', 'z']));
    expect(seats.every((a) => onChair(placed[a]))).toBe(true);                  // 큰 팀이 먼저 앉는다
    expect(['x', 'y', 'z'].filter((a) => onChair(placed[a]))).toHaveLength(1);  // 남은 의자 하나, 둘은 선다
    const keys = Object.values(placed).map((p) => `${p.x},${p.y}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('늦게 시작한 큰 팀이 더 최근에 말해도 대회의실은 먼저 시작(since)한 팀이다(R1)', () => {
    const a = { ...m(1, agents(7), 900), since: 100 };                    // at 은 마지막 말 시각이라 순서 기준이 아니다
    const b = { ...m(2, agents(8, 'b'), 500), since: 200 };
    const got = meetingPlaces([b, a], rooms, items);
    expect(got.get(1)).toBe(big._uid);
    expect(got.get(2)).toBe(team[1]._uid);
  });

  it('since 가 없는 옛 응답은 at 으로 정렬한다', () => {
    expect(meetingPlaces([m(2, agents(8, 'b'), 5), m(1, agents(7), 1)], rooms, items).get(1)).toBe(big._uid);
  });

  it('먼저 시작한 큰 팀 회의가 끝나면 기다리던 큰 팀이 대회의실로 간다(R3)', () => {
    const later = { ...m(2, agents(8, 'b'), 5), since: 5 };
    expect(meetingPlaces([{ ...m(1, agents(7), 1), since: 1 }, later], rooms, items).get(2)).toBe(team[1]._uid);
    expect(meetingPlaces([later], rooms, items).get(2)).toBe(big._uid);
  });

  it('같이 쓰던 회의가 남은 대회의실로 큰 팀이 옮겨 오면 큰 팀이 먼저 앉는다(R5, 받아들인 동작)', () => {
    const u = { ...m(9, ['x', 'y', 'z'], 3), since: 3 };
    const b2 = { ...m(2, agents(8, 'b'), 2), since: 2 };
    const placed = meetingSeatsByAgent([b2, u], rooms, items, new Set([...agents(8, 'b'), 'x', 'y', 'z']));
    expect(agents(8, 'b').every((a) => onChair(placed[a]))).toBe(true);
    expect(['x', 'y', 'z'].filter((a) => onChair(placed[a]))).toHaveLength(2);
  });

  it('의자 6개 팀 회의실에 에이전트 10개면 서 있는 4개가 모두 다른 자리이고 회의실 안이다(R6)', () => {
    const small = [{ uid: team[0]._uid, kind: 'team', label: '가팀 회의실', room: 1 }];
    const seats = agents(10);
    const placed = meetingSeatsByAgent([{ ...m(1, seats, 1) }], small, items.filter((i) => i._uid !== big._uid), new Set(seats));
    const standing = seats.filter((a) => !getMeetingSeatLocations(items, { x: team[0].x, y: team[0].y, w: team[0].w ?? 0, h: team[0].h ?? 0 })
      .some((c) => c.x === placed[a].x && c.y === placed[a].y));
    expect(standing).toHaveLength(4);
    expect(new Set(standing.map((a) => `${placed[a].x},${placed[a].y}`)).size).toBe(4);
    expect(standing.every((a) => inside(placed[a], team[0]))).toBe(true);
  });

  it('큰 팀 회의가 둘이면 먼저 시작한 팀만 대회의실을 쓴다', () => {
    const got = meetingPlaces([m(2, agents(8, 'b'), 5), m(1, agents(7), 1)], rooms, items);
    expect(got.get(1)).toBe(big._uid);
    expect(got.get(2)).toBe(team[1]._uid);
  });

  it('TFT 회의는 의자가 모자라도 대회의실로 옮기지 않는다(D1)', () => {
    expect(meetingPlaces([m(3, agents(8), 1)], rooms, items).get(3)).toBe(tft[0]._uid);
  });

  it('대회의실 의자(10개)보다 많으면 10개가 앉고 나머지는 선다', () => {
    const seats = agents(12);
    const got = meetingSeatsByAgent([m(1, seats, 1)], rooms, items, new Set(seats));
    expect(seats.every((a) => inside(got[a], big))).toBe(true);
    expect(seats.filter((a) => onChair(got[a]))).toHaveLength(10);
  });
});

describe('roomStatuses·meetingForRoom (스펙 2026-10-20-017 디자인 리뷰 이슈 1·2·3·7)', () => {
  const items = bigRoomLayout();
  const team = items.filter((i) => i.type === 'room' && i.kind === 'team');
  const tft = items.filter((i) => i.type === 'room' && i.kind === 'tft');
  const big = items.find((i) => i.type === 'room' && i.kind === 'meeting')!;
  const rooms = [
    { uid: team[0]._uid, kind: 'team', label: '마케팅팀 회의실', name: '마케팅팀', room: 1 },
    { uid: tft[0]._uid, kind: 'tft', label: 'TFT 회의실 1 · 사용 중', room: 3 },
  ];
  const agents = (n: number) => Array.from({ length: n }, (_, i) => `a${i}`);
  const m = (room: number, seats: string[], at: number, name?: string) => ({ room, seats, pending: [], speaker: null, at, ...(name ? { name } : {}) });

  it('큰 팀이 대회의실로 가면 팀 회의실은 옮겨 감, 대회의실은 팀 이름으로 회의 중', () => {
    const st = roomStatuses([m(1, agents(7), 1)], rooms, items);
    expect(st[team[0]._uid]).toEqual({ state: 'moved', to: big._uid });
    expect(st[big._uid]).toEqual({ state: 'meeting', names: ['마케팅팀'] });
  });

  it('제자리 회의는 이름 없이 회의 중, 구성원이 아닌 TFT 회의는 이름을 보이지 않는다', () => {
    const st = roomStatuses([m(1, agents(3), 1), m(3, ['x'], 2)], rooms, items);
    expect(st[team[0]._uid]).toEqual({ state: 'meeting', names: [] });
    expect(st[tft[0]._uid]).toEqual({ state: 'meeting', names: [] });
  });

  it('대회의실을 둘이 쓰면 이름 목록에 둘 다(구성원에게 온 이름만) 들어간다', () => {
    const st = roomStatuses([m(1, agents(7), 1), m(9, ['x'], 2, '긴급 TFT')], rooms, items);
    expect(st[big._uid]).toEqual({ state: 'meeting', names: ['마케팅팀', '긴급 TFT'], count: 2 });
  });

  it('명패를 누르면 그 회의실의 회의 중 내가 구성원인(name 이 있는) 회의를 시작 순서로 먼저 고른다(R7)', () => {
    const meetings = [m(1, agents(7), 1), m(9, ['x'], 2, '긴급 TFT')];
    expect(meetingForRoom(meetings, rooms, items, big._uid)?.room).toBe(9);
    const mine = [{ ...m(1, agents(7), 1), name: '마케팅팀' }, m(9, ['x'], 2, '긴급 TFT')];
    expect(meetingForRoom(mine, rooms, items, big._uid)?.room).toBe(1);
    expect(meetingForRoom([m(9, ['x'], 2)], rooms, items, big._uid)?.room).toBe(9);           // 구성원 회의가 없으면 먼저 시작한 회의
    expect(meetingForRoom([], rooms, items, big._uid)).toBeUndefined();
  });

  it('회의 탭 장소: 진행 중이면 모인 회의실, 아니면 서버 짝 회의실, 짝도 없으면 없음(디자인 리뷰 이슈 8)', () => {
    expect(meetingPlaceLabel([m(1, agents(7), 1)], rooms, items, 1)).toBe('대회의실');
    expect(meetingPlaceLabel([], rooms, items, 1)).toBe('마케팅팀 회의실');
    expect(meetingPlaceLabel([], rooms, items, 42)).toBeNull();
    expect(meetingPlaceLabel([m(42, ['x'], 1)], rooms, items, 42)).toBe('대회의실');   // 짝 없는 회의는 대회의실
  });
});

// 스펙 2026-10-20-021 N2·N3: 상태판 회의실 행의 카메라 자리와 옮겨 간 곳
describe('roomPlace', () => {
  const items = bigRoomLayout();
  const team = items.find((i) => i.type === 'room' && i.kind === 'team')!;
  const big = items.find((i) => i.type === 'room' && i.kind === 'meeting')!;
  const rooms = [{ uid: team._uid, kind: 'team', label: '마케팅팀 회의실', name: '마케팅팀', room: 1 }];
  const mid = (r: { x: number; y: number; w?: number; h?: number }) => ({ x: r.x + (r.w ?? 0) / 2, y: r.y + (r.h ?? 0) / 2 });
  const m = (room: number, n: number) => ({ room, seats: Array.from({ length: n }, (_, i) => `a${i}`), pending: [], speaker: null, at: 1 });

  it('회의가 없으면 짝 회의실 가운데, 옮겨 간 곳 없음', () => {
    expect(roomPlace(1, [], rooms, items)).toEqual({ point: mid(team), movedTo: null, uid: team._uid });
  });

  it('짝 회의실에서 회의 중이면 그대로', () => {
    expect(roomPlace(1, [m(1, 2)], rooms, items)).toEqual({ point: mid(team), movedTo: null, uid: team._uid });
  });

  it('큰 팀 회의가 대회의실에 모이면 대회의실 가운데와 그 명패 글자', () => {
    expect(roomPlace(1, [m(1, 7)], rooms, items)).toEqual({ point: mid(big), movedTo: big.label, uid: big._uid });
  });

  it('짝도 회의도 없으면 자리가 없다(행이 창을 연다)', () => {
    expect(roomPlace(42, [], rooms, items)).toEqual({ point: null, movedTo: null, uid: null });
  });

  it('짝 없는 방의 회의는 대회의실에 모이므로 옮겨 간 곳이 대회의실이다', () => {
    expect(roomPlace(42, [m(42, 1)], rooms, items)).toEqual({ point: mid(big), movedTo: big.label, uid: big._uid });
  });
});

// 스펙 2026-10-20-021 N1: 회의 목록과 함께 읽기 상태(첫 응답 전·실패)를 내보낸다
describe('useActiveMeetingsState', () => {
  afterEach(() => vi.unstubAllGlobals());
  const wrap = () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client: qc }, children);
  };

  it('첫 응답 전에는 ready=false, 응답이 오면 ready=true·failed=false', async () => {
    stubApi({ '/api/office/meeting/active': { meetings: [{ room: 3, seats: [], pending: [], speaker: null, at: 1 }] } });
    const { result } = renderHook(() => useActiveMeetingsState(true), { wrapper: wrap() });
    expect(result.current.ready).toBe(false);
    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(result.current.failed).toBe(false);
    expect(result.current.meetings.map((x) => x.room)).toEqual([3]);
  });

  it('읽기에 실패하면 failed=true 이고 목록은 비어 있다', async () => {
    stubApi({ '/api/office/meeting/active': new Response(JSON.stringify({ error: 'x' }), { status: 500 }) });
    const { result } = renderHook(() => useActiveMeetingsState(true), { wrapper: wrap() });
    await waitFor(() => expect(result.current.failed).toBe(true));
    expect(result.current.ready).toBe(false);
    expect(result.current.meetings).toEqual([]);
  });
});

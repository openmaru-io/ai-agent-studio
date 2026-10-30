/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 진행 중인 회의 → 장면의 스탠드업(계획 007 P3, R7). 참가 에이전트가 회의실로 모이고 지금 말하는 에이전트의 글이 보인다.
// 회의는 동시에 묻는다 — 「말하는 에이전트」는 지금 가장 많이 쓴 에이전트다. 발언 글은 방 구성원에게만 온다(서버가 거른다).
import { useQuery, useQueryClient } from '@tanstack/react-query';

import type { RoomLabel } from '@/features/office/model';
import type { StandupMeeting } from '@/features/office/scene3d/lib/office/standup/types';
import { getMeetingSeatLocations } from '@/features/office/scene3d/retro-office/core/navigation';
import type { FurnitureItem } from '@/features/office/scene3d/retro-office/core/types';
import { get } from '@/lib/api';
import { useTopic } from '@/lib/ws';

export interface ActiveMeeting {
  room: number;
  /** 방 이름 — 구성원·관리자에게만 온다(계획 2026-10-13-001 R6). */
  name?: string;
  seats: string[];
  pending: string[];
  speaker: string | null;
  /** 마지막으로 말하거나 답한 시각(초). 순서 기준으로 쓰지 않는다 */
  at: number;
  /** 회의 시작 시각(초, 스펙 2026-10-20-017 R1). 옛 서버는 보내지 않는다 — 없으면 at 으로 갈음한다 */
  since?: number;
  partial?: Record<string, string>;
  last?: { author: string; content: string }[];
}

export function toStandup(m: ActiveMeeting | undefined, present: Set<string>, nameOf: (alias: string) => string): StandupMeeting | null {
  if (!m) return null;
  const order = m.seats.filter((a) => present.has(a));
  if (!order.length) return null;
  const now = new Date().toISOString();
  const lastBy = new Map((m.last ?? []).map((x) => [x.author, x.content]));
  return {
    id: `room-${m.room}`,
    trigger: 'manual',
    phase: 'in_progress',
    scheduledFor: null,
    startedAt: now,
    updatedAt: now,
    completedAt: null,
    currentSpeakerAgentId: m.speaker && order.includes(m.speaker) ? m.speaker : null,
    speakerStartedAt: now,
    speakerDurationMs: 0,
    participantOrder: order,
    arrivedAgentIds: [],
    cards: order.map((a) => ({
      agentId: a,
      agentName: nameOf(a),
      speech: (m.partial?.[a] ?? lastBy.get(a) ?? '').slice(-160),
      currentTask: '',
      blockers: [],
      recentCommits: [],
      activeTickets: [],
      manualNotes: [],
      sourceStates: [],
    })),
  };
}

export type Seat = { x: number; y: number; facing: number };

const startOf = (m: ActiveMeeting) => m.since ?? m.at;
const byStart = (meetings: ActiveMeeting[]) => [...meetings].sort((a, b) => startOf(a) - startOf(b));

/** 회의(방 번호)마다 모일 회의실(방 표시 항목 uid). 회의 자리·회의 중 표시·명패 누르기가 모두 이 결과를 쓴다(스펙 2026-10-20-017).
 *  회의 시작 순서(since, 없으면 at)로 한 번 돈다: 짝이 없는 회의(회의실이 모자람)는 언제나 대회의실(앞선 회의가 있으면 같이 쓴다, R2),
 *  방의 에이전트가 짝 팀 회의실 의자보다 많은 팀 회의는 먼저 시작한 회의가 대회의실에 없을 때만 대회의실, 나머지는 짝 회의실.
 *  at 은 마지막 말 시각이라 순서 기준으로 쓰면 말할 때마다 순서가 바뀐다(R1). 끝난 회의는 기억하지 않아 대회의실이 비면 기다리던 큰 팀이 옮겨 간다(R3).
 *  에이전트 수는 방의 seats 로 센다(D3). TFT 회의는 옮기지 않는다(D1). */
export function meetingPlaces(meetings: ActiveMeeting[], rooms: RoomLabel[], items: FurnitureItem[]): Map<number, string> {
  const out = new Map<number, string>();
  const roomItems = items.filter((i) => i.type === 'room');
  const big = roomItems.find((i) => i.kind === 'meeting');
  const chairs = (r: FurnitureItem) => getMeetingSeatLocations(items, { x: r.x, y: r.y, w: r.w ?? 0, h: r.h ?? 0 }).length;
  let bigTaken = false;
  for (const m of byStart(meetings)) {
    const place = roomItems.find((i) => i._uid === rooms.find((r) => r.room === m.room)?.uid);
    if (!place) {
      if (big) {
        out.set(m.room, big._uid);
        bigTaken = true;
      }
    } else if (big && !bigTaken && place.kind === 'team' && m.seats.length > chairs(place)) {
      out.set(m.room, big._uid);
      bigTaken = true;
    } else {
      out.set(m.room, place._uid);
    }
  }
  return out;
}

/** 의자가 모자라 서는 k번째(회의실마다 회의를 넘어 센다) 자리. 회의실 가운데 앞에서 시작해 가운데 → 오른쪽 → 왼쪽으로 26 간격,
 *  한 줄이 회의실 폭에 차면 26 아래 줄. 회의실 안(벽 여유 15)에 머문다(R6). 처음 계획한 4칸씩은 깊이 200 인 회의실에서 두 줄뿐이라
 *  8명 넘게 서면 다시 겹쳐, 줄 길이를 회의실 폭에 맞췄다. */
function standingSpot(bounds: { x: number; y: number; w: number; h: number }, k: number): Seat {
  const perRow = Math.max(1, Math.floor((bounds.w - 30) / 26));
  const col = k % perRow;
  const row = Math.floor(k / perRow);
  const dx = col === 0 ? 0 : Math.ceil(col / 2) * 26 * (col % 2 === 1 ? 1 : -1);
  const y = Math.min(bounds.y + bounds.h / 2 + 40 + row * 26, bounds.y + bounds.h - 15);
  return { x: bounds.x + bounds.w / 2 + dx, y, facing: Math.PI };
}

/** 진행 중인 회의마다 모일 회의실(meetingPlaces)의 의자에 참가 에이전트를 앉힌다(계획 2026-10-13-001 R4, 독립 검토 O3).
 *  의자는 회의 시작 순서로 나눈다 — 같이 쓰던 대회의실로 큰 팀이 옮겨 오면 큰 팀이 먼저 앉는다(R5, 받아들인 동작).
 *  한 에이전트가 두 회의에 들어 있으면 먼저 시작한 회의로 간다. 의자보다 참가자가 많으면 남는 참가자는 standingSpot 에 선다.
 *  돌려주는 것: 별칭 → 앉을 곳. */
export function meetingSeatsByAgent(
  meetings: ActiveMeeting[],
  rooms: RoomLabel[],
  items: FurnitureItem[],
  present: Set<string>
): Record<string, Seat> {
  const out: Record<string, Seat> = {};
  const places = meetingPlaces(meetings, rooms, items);
  const standing = new Map<string, number>();
  for (const m of byStart(meetings)) {
    const place = items.find((i) => i._uid === places.get(m.room));
    if (!place) continue;
    const bounds = { x: place.x, y: place.y, w: place.w ?? 0, h: place.h ?? 0 };
    const chairs = getMeetingSeatLocations(items, bounds);
    const taken = new Set(Object.values(out).map((s) => `${s.x},${s.y}`));
    const free = chairs.filter((c) => !taken.has(`${c.x},${c.y}`));
    // 의자가 모자라면 말하는 에이전트·답하는 중인 에이전트부터 앉힌다(계획 2026-10-13-011 §3-3). 나머지는 회의실 가운데 앞에 선다
    const rank = (a: string) => (a === m.speaker ? 0 : m.pending.includes(a) ? 1 : 2);
    const who = m.seats.filter((a) => present.has(a) && !out[a]).sort((a, b) => rank(a) - rank(b));
    who.forEach((alias, i) => {
      if (free[i]) {
        out[alias] = free[i];
        return;
      }
      const k = standing.get(place._uid) ?? 0;
      standing.set(place._uid, k + 1);
      out[alias] = standingSpot(bounds, k);
    });
  }
  return out;
}

/** 지금 회의가 열려 있는 방 표시(room) 항목의 uid. 회의 자리를 옮기는 규칙(meetingPlaces)과 같은 회의실이다. */
export function roomsInMeeting(meetings: ActiveMeeting[], rooms: RoomLabel[], items: FurnitureItem[]): Set<string> {
  return new Set(meetingPlaces(meetings, rooms, items).values());
}

/** 명패 둘째 줄을 정할 회의실 상태(스펙 2026-10-20-017 디자인 리뷰 이슈 1·2). 문구는 부르는 쪽이 번역해 만든다.
 *  meeting: 이 회의실에서 회의 중. names 는 다른 회의실에서 옮겨 온 회의의 이름(팀 회의는 서버 이름표의 팀 이름, 그 밖은 구성원에게만
 *  오는 회의 name) — 제자리 회의는 명패 글자가 이미 회의 이름이라 넣지 않는다. 회의가 둘 이상이면 count.
 *  moved: 짝 회의실의 회의가 다른 회의실(to)로 옮겨 감. 그 회의실에 다른 회의가 있으면 meeting 이 앞선다. */
export type RoomStatus = { state: 'meeting'; names: string[]; count?: number } | { state: 'moved'; to: string };

export function roomStatuses(meetings: ActiveMeeting[], rooms: RoomLabel[], items: FurnitureItem[]): Record<string, RoomStatus> {
  const places = meetingPlaces(meetings, rooms, items);
  const out: Record<string, RoomStatus> = {};
  const here = new Map<string, ActiveMeeting[]>();
  for (const m of byStart(meetings)) {
    const uid = places.get(m.room);
    if (uid) here.set(uid, [...(here.get(uid) ?? []), m]);
  }
  for (const [uid, list] of here) {
    const names: string[] = [];
    for (const m of list) {
      const own = rooms.find((r) => r.room === m.room);
      if (own?.uid === uid) continue;
      const name = own?.kind === 'team' ? own.name : m.name;
      if (name) names.push(name);
    }
    out[uid] = list.length > 1 ? { state: 'meeting', names, count: list.length } : { state: 'meeting', names };
  }
  for (const m of meetings) {
    const own = rooms.find((r) => r.room === m.room)?.uid;
    const to = places.get(m.room);
    if (own && to && own !== to && !out[own]) out[own] = { state: 'moved', to };
  }
  return out;
}

/** 회의실 명패·스크린을 눌렀을 때 열 회의. 그 회의실에 모인 회의 가운데 내가 구성원인 회의(서버가 name 을 준 행)를 시작 순서로 먼저,
 *  없으면 먼저 시작한 회의(R7). 회의가 없으면 undefined. */
export function meetingForRoom(meetings: ActiveMeeting[], rooms: RoomLabel[], items: FurnitureItem[], roomUid: string): ActiveMeeting | undefined {
  const places = meetingPlaces(meetings, rooms, items);
  const list = byStart(meetings).filter((m) => places.get(m.room) === roomUid);
  return list.find((m) => m.name) ?? list[0];
}

/** 회의 탭 머리줄의 「장소」(스펙 2026-10-20-017 디자인 리뷰 이슈 8): 진행 중이면 장면과 같은 규칙(meetingPlaces)으로 모인 회의실,
 *  아니면 서버 짝 회의실의 명패 글자. 짝도 없으면 null(보이지 않는다). */
export function meetingPlaceLabel(meetings: ActiveMeeting[], rooms: RoomLabel[], items: FurnitureItem[], roomId: number): string | null {
  const uid = meetingPlaces(meetings, rooms, items).get(roomId) ?? rooms.find((r) => r.room === roomId)?.uid;
  if (!uid) return null;
  return rooms.find((r) => r.uid === uid)?.label || items.find((i) => i._uid === uid)?.label || null;
}

/** 오피스 상태판의 회의실 행이 쓰는 장소(스펙 2026-10-20-021 N2·N3). point 는 카메라를 옮길 방 가운데 — 진행 중이면 장면과 같은 규칙(meetingPlaces)으로
 *  모인 회의실, 아니면 서버 짝 회의실. 어느 것도 배치에 없으면 null(행이 창을 연다, DR5). movedTo 는 회의가 짝 회의실이 아닌 곳(대회의실 등)에
 *  모였을 때 그곳의 명패 글자, 아니면 null(둘째 줄 「회의 중 · 대회의실」, DR7). */
export function roomPlace(
  roomId: number,
  meetings: ActiveMeeting[],
  rooms: RoomLabel[],
  items: FurnitureItem[]
): { point: { x: number; y: number } | null; movedTo: string | null; uid: string | null } {
  const paired = rooms.find((r) => r.room === roomId)?.uid;
  const placed = meetingPlaces(meetings, rooms, items).get(roomId);
  const uid = placed ?? paired;
  const item = uid ? items.find((i) => i._uid === uid && i.type === 'room') : undefined;
  const point = item ? { x: item.x + (item.w ?? 0) / 2, y: item.y + (item.h ?? 0) / 2 } : null;
  const movedTo = placed && placed !== paired ? rooms.find((r) => r.uid === placed)?.label || item?.label || null : null;
  // uid: 카메라가 가는 방 표시 항목. 장면이 그 방 바닥 테두리와 명패를 잠깐 표시한다(스펙 2026-10-21-012)
  return { point, movedTo, uid: item?._uid ?? null };
}

/** 회의 탭이 장소를 그릴 때 쓰는 값. 오피스 화면 밖(회의 탭·떠 있는 창)에서도 쓰므로 실시간 연결(useOfficeState)을 새로 열지 않고,
 *  방 이름표·배치는 react-query 로 한 번 읽어 둔다(30초). 회의 목록은 오피스 장면과 같은 캐시(useActiveMeetings)를 쓴다. */
export function useMeetingPlace(roomId: number): string | null {
  const st = useQuery<{ rooms?: RoomLabel[]; layout_version?: number }>({
    queryKey: ['office-state-rooms'],
    queryFn: () => get<{ rooms?: RoomLabel[]; layout_version?: number }>('/api/office/state'),
    staleTime: 30_000,
  });
  const layout = useQuery<{ items: FurnitureItem[] | null }>({
    queryKey: ['office-layout', st.data?.layout_version ?? -1],
    queryFn: () => get<{ items: FurnitureItem[] | null }>('/api/office/layout'),
    staleTime: Infinity,
    enabled: !!st.data,
  });
  const meetings = useActiveMeetings(true);
  return meetingPlaceLabel(meetings, st.data?.rooms ?? [], layout.data?.items ?? [], roomId);
}

/** 회의실 빔 스크린(tv_meeting)이 걸린 방 항목. 스크린에는 방 필드가 없어 가운데 점이 드는 방을 찾는다(양옆 벽 두께 8 여유, aasKoreanOffice.test.ts 와 같은 규칙).
 *  스크린이 아니거나 어느 방에도 들지 않으면 undefined. */
export function roomOfScreen(items: FurnitureItem[], screenUid: string): FurnitureItem | undefined {
  const sc = items.find((i) => i._uid === screenUid);
  if (!sc || sc.type !== 'tv_meeting') return undefined;
  const cx = sc.x + (sc.w ?? 0) / 2;
  const cy = sc.y + (sc.h ?? 0) / 2;
  return items.find(
    (r) => r.type === 'room' && cx >= r.x - 8 && cx <= r.x + (r.w ?? 0) + 8 && cy >= r.y && cy <= r.y + (r.h ?? 0)
  );
}

/** 진행 중인 회의 HTTP 다시 읽기 주기. 웹소켓 토픽 office:meeting:active 가 살아 있으면 끈다(스펙 2026-10-17-004). */
export function activeMeetingsRefetchMs(data: { meetings?: ActiveMeeting[] } | undefined, live: boolean): number | false {
  if (live) return false;
  return data?.meetings?.some((m) => m.pending?.length) ? 1500 : 5000;
}

/** 진행 중인 회의 목록과 읽기 상태. ready 는 첫 응답(HTTP 또는 웹소켓)이 왔는지, failed 는 마지막 HTTP 읽기가 실패했고 그 뒤 새 값이 없는지.
 *  오피스 화면(장면·상태판)은 이 훅 하나로 한 번만 구독한다(스펙 2026-10-20-021 N1·N4). 상태가 필요 없는 곳은 useActiveMeetings. */
export function useActiveMeetingsState(enabled: boolean): { meetings: ActiveMeeting[]; ready: boolean; failed: boolean } {
  const qc = useQueryClient();
  const live = useTopic<{ meetings: ActiveMeeting[] }>(enabled ? 'office:meeting:active' : null, (d) =>
    qc.setQueryData(['office-meetings-active'], d)
  );
  const q = useQuery<{ meetings: ActiveMeeting[] }>({
    queryKey: ['office-meetings-active'],
    queryFn: () => get<{ meetings: ActiveMeeting[] }>('/api/office/meeting/active'),
    refetchInterval: (query) => activeMeetingsRefetchMs(query.state.data, live),
    enabled,
    retry: false,
  });
  return {
    meetings: Array.isArray(q.data?.meetings) ? q.data.meetings : [],
    ready: q.data !== undefined,
    failed: q.isError && q.errorUpdatedAt >= q.dataUpdatedAt,
  };
}

/** 진행 중인 회의 목록만(읽기 상태가 필요 없는 곳: 회의 탭·떠 있는 창의 장소 표시) */
export function useActiveMeetings(enabled: boolean): ActiveMeeting[] {
  return useActiveMeetingsState(enabled).meetings;
}

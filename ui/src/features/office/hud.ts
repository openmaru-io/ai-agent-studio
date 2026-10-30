/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 오피스 상태판·명단의 순수 계산(계획 007 P0, §3-3). 화면과 네트워크에 기대지 않는다.
import { agentName, type ServerAgent } from '@/features/office/model';
import type { SceneStatus } from '@/features/office/tokens';

export const HUD_ORDER: SceneStatus[] = ['working', 'idle', 'error', 'away', 'unknown'];

export const STATUS_LABEL: Record<SceneStatus, string> = {
  working: 'office.statusWorking',
  idle: 'office.statusIdle',
  error: 'office.statusError',
  away: 'office.statusAway',
  unknown: 'office.statusUnknown',
};

/** 장면·명단에서 쓰는 상태. 서버가 모르는 값은 확인 불가로 본다(숨기지 않는다, G4). */
export function sceneStatus(a: Pick<ServerAgent, 'status'> & { away?: boolean }): SceneStatus {
  if (a.status === 'error') return 'error';
  if (a.status === 'working') return 'working';
  if (a.status !== 'idle') return 'unknown';
  return a.away ? 'away' : 'idle';
}

export function countByStatus(agents: ServerAgent[]): Record<SceneStatus, number> {
  const out: Record<SceneStatus, number> = { working: 0, idle: 0, error: 0, away: 0, unknown: 0 };
  for (const a of agents) out[sceneStatus(a)] += 1;
  return out;
}

/** 명단 순서: 내 에이전트 → 오류 → 일함 → 대기·부재·확인 불가 → 이름. */
export function orderAgents(agents: ServerAgent[], isMine: (a: ServerAgent) => boolean = () => false): ServerAgent[] {
  const rank: Record<SceneStatus, number> = { error: 0, working: 1, idle: 2, away: 3, unknown: 4 };
  return [...agents].sort(
    (a, b) =>
      Number(isMine(b)) - Number(isMine(a)) ||
      rank[sceneStatus(a)] - rank[sceneStatus(b)] ||
      agentName(a).localeCompare(agentName(b))
  );
}

export function filterAgents(agents: ServerAgent[], status: SceneStatus | null): ServerAgent[] {
  return status ? agents.filter((a) => sceneStatus(a) === status) : agents;
}

/** 상태가 바뀐 에이전트(스크린리더 알림용, G8). */
export function statusChanges(prev: ServerAgent[], next: ServerAgent[]): ServerAgent[] {
  const before = new Map(prev.map((a) => [a.alias, sceneStatus(a)]));
  return next.filter((a) => before.has(a.alias) && before.get(a.alias) !== sceneStatus(a));
}

/** 책상 배정 표(책상 → 별칭)를 별칭 → 책상으로 뒤집는다. */
export function deskOf(desks: Record<string, string>): Map<string, string> {
  return new Map(Object.entries(desks).map(([desk, alias]) => [alias, desk]));
}

/** 상태판 「회의실」 탭의 한 행(스펙 2026-10-20-021). 판정 값만 담는다 — 문구(둘째 줄·접근 이름)는 OfficeHud 가 만든다(N3). */
export interface HudRoom {
  id: number;
  name: string;
  kind: 'team' | 'tft';
  /** live = 짝 회의실에서 회의 중, moved = 다른 회의실(대회의실 등)에 모여 회의 중, idle = 회의 없음 */
  state: 'live' | 'moved' | 'idle';
  /** moved 일 때 모인 곳의 명패 글자 */
  placeLabel: string | null;
  /** 방 에이전트 중 지금 오피스에 있는 수(장면이 회의실에 모으는 기준과 같다, R10) */
  agents: number;
  purpose: string;
  /** 장면에 카메라를 옮길 자리가 있는지(DR5). 없으면 행이 창을 연다 */
  place: boolean;
}

/** 서버 방 중 이 계산에 쓰는 값 */
export interface HudRoomSource {
  id: number;
  name: string;
  purpose: string;
  seats: string[];
  status: string;
  kind?: string;
}

/** 방 번호 → 장면 자리와 옮겨 간 곳(meetings.ts roomPlace). 회의 계산 파일을 여기서 부르지 않도록 함수로 받는다(N2) */
export type HudRoomPlaceOf = (id: number) => { point: { x: number; y: number } | null; movedTo: string | null };

/** 상태판 회의실 목록. 닫힌 방을 빼고, 회의실 탭(Meeting.tsx)과 같은 순서 — 팀 방 먼저, 같은 종류 안은 서버 순서(최근 방 먼저).
 *  회의가 시작·끝나도 순서를 바꾸지 않는다(R2, 누르려는 행이 움직이지 않게). kind 가 없으면 TFT 방이다(forms.tsx). */
export function hudRooms(
  rooms: HudRoomSource[],
  meetings: { room: number }[],
  present: Set<string>,
  placeOf: HudRoomPlaceOf
): HudRoom[] {
  const live = new Set(meetings.map((m) => m.room));
  return rooms
    .filter((r) => r.status !== 'closed')
    .sort((a, b) => Number(b.kind === 'team') - Number(a.kind === 'team'))
    .map((r) => {
      const { point, movedTo } = placeOf(r.id);
      const meeting = live.has(r.id);
      return {
        id: r.id,
        name: r.name,
        kind: r.kind === 'team' ? 'team' : 'tft',
        state: !meeting ? 'idle' : movedTo ? 'moved' : 'live',
        placeLabel: meeting ? movedTo : null,
        agents: r.seats.filter((a) => present.has(a)).length,
        purpose: r.purpose,
        place: point !== null,
      };
    });
}

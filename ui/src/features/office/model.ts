/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 오피스 서버 상태(/api/office/state, /api/office/stream) → 3D 장면 입력. 화면과 네트워크에 기대지 않는 순수 함수다.
import { agentSeed, faceUrl } from '@/features/office/avatars/face';
import { createAgentAvatarProfileFromSeed } from '@/features/office/scene3d/lib/avatars/profile';
import type { OfficeAgent } from '@/features/office/scene3d/retro-office/core/types';
import { hueOf } from '@/lib/chatTokens';

export type Status = 'working' | 'idle' | 'error';

export interface ServerAgent {
  alias: string;
  pod: string;
  /** 화면에 보일 이름(서버가 준다): 자동 별칭이면 에이전트 이름, 관리자가 지은 별칭이면 별칭(2026-10-18-014) */
  label?: string;
  /** 설치본의 에이전트 이름(HermesAgent displayName). 없으면 빈 값 */
  pod_name?: string;
  profile: string;
  status: Status;
  title: string;
  role: string;
  team: string;
  avatar: string;
  /** 주인 표시 이름(이메일이 아니다, 계획 007 R6). */
  owner_name?: string;
  /** 주인 얼굴 시드. */
  owner_seed?: string;
  /** 보는 사람의 에이전트인가. */
  mine?: boolean;
  /** 관리자에게만 온다. */
  owner_email?: string;
  /** 마지막 활동 시각(초). 30분이 지나면 부재로 그린다(계획 007 P1). */
  last_seen?: number;
  /** 화면이 계산한 부재 표시(서버 값이 아니다). */
  away?: boolean;
}

/** 에이전트가 지금 하는 일(말풍선, 계획 007 P1). text 는 대화 당사자·주인에게만 온다(R1). */
export interface Activity {
  tool?: string;
  text?: string;
  at: number;
}

export interface RoomLabel {
  uid: string;
  kind: string;
  label: string;
  room?: number;
  /** 팀 회의실과 짝지어진 팀 방의 팀 이름(모두에게 같다). 대회의실 명패 둘째 줄에 쓴다(스펙 2026-10-20-017 디자인 리뷰 이슈 2) */
  name?: string;
}

export interface OfficeState {
  agents: ServerAgent[];
  seq: number;
  /** 책상 _uid → 자리 별칭(서버가 정한다, 계획 007 P−1). */
  desks?: Record<string, string>;
  /** 서버 레이아웃 판 번호. 0 이면 아직 판이 없다. */
  layoutVersion?: number;
  /** 배치의 방 표시마다 문 위 이름. TFT 회의실은 짝지어진 방 번호(room)가 붙는다(계획 2026-10-13-001 R4·R6). */
  rooms?: RoomLabel[];
  /** 별칭 → 지금 하는 일. 대화가 끝나면 지운다. */
  activity?: Record<string, Activity>;
}

export interface OfficeEvent {
  type: string;
  payload: Record<string, unknown>;
}

// Claw3D 원본(OfficeScreen.tsx)과 같은 규칙으로 이름에서 책상 위 물건을 정한다. 색은 화면의 칩·아바타와 같은 hueOf 를 쓴다(2026-10-16). 같은 이름은 늘 같은 모습이다.
const ITEMS = ['globe', 'books', 'coffee', 'palette', 'camera', 'waveform', 'shield', 'fire', 'plant', 'laptop'];

const hash = (s: string): number => {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = s.charCodeAt(i) + ((h << 5) - h);
  return h;
};
/** 화면에 보일 에이전트 이름: 직함 > 서버가 준 화면 이름(label: 자동 별칭이면 에이전트 이름, 2026-10-18-010) > 별칭.
 *  3D 이름표·명단·2D 목록·상태 안내·회의 알림이 같은 규칙을 쓴다. 색·물건·아바타는 별칭 기준이다. */
export const agentName = (a: Pick<ServerAgent, 'alias' | 'title' | 'label'>): string => a.title || a.label || a.alias;

export function toOfficeAgent(a: ServerAgent): OfficeAgent {
  return {
    id: a.alias,
    name: agentName(a),
    // 이름표 둘째 줄: 주인 이름(여러 사람의 에이전트가 한 오피스에 있다, 계획 007 P6a). 주인을 모르면 역할·팀
    subtitle: a.owner_name || [a.role, a.team].filter(Boolean).join(' · ') || null,
    status: a.status,
    color: hueOf(a.alias),
    item: ITEMS[Math.abs(hash(a.alias)) % ITEMS.length],
    avatarProfile: createAgentAvatarProfileFromSeed(a.avatar || a.alias),
    faceUrl: faceUrl(agentSeed(a), true),
    mine: Boolean(a.mine),
  };
}

export const toOfficeAgents = (list: ServerAgent[]): OfficeAgent[] => list.map(toOfficeAgent);

/** 이벤트 하나를 상태에 반영한다. refresh 가 true 면 자리 목록이 바뀌었으니 /api/office/state 를 다시 받는다. */
export function applyOfficeEvent(
  state: OfficeState,
  seq: number,
  ev: OfficeEvent
): { state: OfficeState; refresh: boolean } {
  const p = ev.payload as {
    alias?: string;
    status?: Status;
    agents?: ServerAgent[];
    seq?: number;
    desks?: Record<string, string>;
    layout_version?: number;
    rooms?: RoomLabel[];
    name?: string;
    text?: string;
    ts?: number;
  };
  const now = Date.now();
  const setActivity = (alias: string | undefined, next: Partial<Activity> | null): OfficeState => {
    if (!alias) return { ...state, seq };
    const activity = { ...(state.activity ?? {}) };
    if (next) activity[alias] = { ...activity[alias], ...next, at: now };
    else delete activity[alias];
    return { ...state, seq, activity };
  };
  const setStatus = (alias: string | undefined, status: Status, onlyFrom?: Status[]): OfficeState => ({
    ...state,
    seq,
    agents: state.agents.map((a) =>
      a.alias === alias && (!onlyFrom || onlyFrom.includes(a.status)) ? { ...a, status } : a
    ),
  });
  switch (ev.type) {
    case 'snapshot':
      return {
        state: {
          agents: p.agents ?? [],
          seq: p.seq ?? seq,
          desks: p.desks ?? {},
          layoutVersion: p.layout_version ?? 0,
          rooms: p.rooms ?? [],
        },
        refresh: false,
      };
    case 'agent.status':
      return { state: setStatus(p.alias, p.status as Status), refresh: false };
    case 'chat.start':
      return { state: setStatus(p.alias, 'working'), refresh: false };
    case 'chat.end': {
      // 실패 표시(error)는 대화가 끝났다고 지우지 않는다. 말풍선은 지운다
      const ended = setStatus(p.alias, 'idle', ['working']);
      const activity = { ...(ended.activity ?? {}) };
      if (p.alias) delete activity[p.alias];
      return { state: { ...ended, activity }, refresh: false };
    }
    case 'tool':
      return { state: setActivity(p.alias, { tool: p.name ?? 'tool' }), refresh: false };
    case 'chat.delta':
      return { state: setActivity(p.alias, { text: p.text ?? '' }), refresh: false };
    case 'agent.lastSeen':
      return {
        state: {
          ...state,
          seq,
          agents: state.agents.map((a) => (a.alias === p.alias ? { ...a, last_seen: p.ts } : a)),
        },
        refresh: false,
      };
    case 'seat.added':
    case 'seat.removed':
    case 'desks.changed': // 책상 배정·레이아웃이 바뀌었다 — 스냅샷에 실려 오므로 다시 받는다
    case 'layout.changed':
      return { state: { ...state, seq }, refresh: true };
    default:
      return { state: { ...state, seq }, refresh: false };
  }
}

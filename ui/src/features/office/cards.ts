/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 장면의 3D 칸반 보드와 에이전트 서랍이 쓰는 카드(계획 007 P4). 서버가 칸반과 같은 규칙으로 거른다.
// 웹소켓이면 신호 토픽 office:cards 의 값(마지막 카드 이벤트 번호·카드 수)이 바뀔 때 곧바로 다시 읽고 60초마다도 읽는다.
// 토픽이 살아 있지 않으면 20초마다 읽는다(스펙 2026-10-17-004 D6·D10).
import { useQuery } from '@tanstack/react-query';

import type { TaskBoardCard, TaskBoardStatus } from '@/features/office/scene3d/shims';
import { useSignalTopic } from '@/features/office/signalTopic';
import { get } from '@/lib/api';

export interface OfficeCard {
  board: string;
  task_id: string;
  status: string;
  assignee: string;
  title: string;
}

// AAS 칸반 열 → Claw3D 보드 칸. 3D 보드는 완료가 아닌 카드 수를 보인다(여러 보드의 합).
const COLUMN: Record<string, TaskBoardStatus> = {
  triage: 'todo',
  todo: 'todo',
  scheduled: 'todo',
  ready: 'todo',
  running: 'in_progress',
  blocked: 'blocked',
  review: 'review',
  done: 'done',
};

export function toBoard(cards: OfficeCard[]): Record<TaskBoardStatus, TaskBoardCard[]> {
  const out: Record<TaskBoardStatus, TaskBoardCard[]> = { todo: [], in_progress: [], blocked: [], review: [], done: [] };
  for (const c of cards) {
    const status = COLUMN[c.status] ?? 'todo';
    out[status].push({
      id: `${c.board}/${c.task_id}`,
      title: c.title,
      description: '',
      status,
      assignedAgentId: c.assignee || null,
      updatedAt: '',
    });
  }
  return out;
}

// 자료가 없을 때 매번 새 배열을 돌려주면 이 값을 의존성으로 보는 효과가 렌더마다 다시 돈다
const NO_CARDS: OfficeCard[] = [];

export const CARDS_EVERY_MS = 20_000;
export const CARDS_LIVE_EVERY_MS = 60_000;
const CARDS_KEY = ['office-cards'] as const;

export function useOfficeCards() {
  const live = useSignalTopic('office:cards', CARDS_KEY);
  const q = useQuery<{ cards: OfficeCard[] }>({
    queryKey: CARDS_KEY,
    queryFn: () => get<{ cards: OfficeCard[] }>('/api/office/cards'),
    refetchInterval: live ? CARDS_LIVE_EVERY_MS : CARDS_EVERY_MS,
    retry: false,
  });
  return q.data?.cards ?? NO_CARDS;
}

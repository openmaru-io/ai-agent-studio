/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { mountScreen, stubApi } from '@/test/mountScreen';

import { BoardPanel, ServerPanel } from './DevicePanels';
import { InboxPanel } from './InboxPanel';

afterEach(() => vi.unstubAllGlobals());

const seat = (alias: string, more: Record<string, string> = {}) => ({ alias, pod: 'p', profile: 'main', enabled: true, title: '', role: '', team: '', note: '', ...more });

describe('3D 오피스 장치 서랍은 id 대신 이름을 보인다(스펙 2026-10-20-029)', () => {
  it('칸반 보드: 담당은 3D 이름표와 같은 이름(직함 > 화면 이름 > 별칭), 별칭은 풍선말', async () => {
    stubApi({
      '/api/office/cards': {
        cards: [
          { board: 'b', task_id: '1', status: 'blocked', assignee: 'aas-admin', title: '회의실 버그' },
          { board: 'b', task_id: '2', status: 'running', assignee: 'aas-agent-kim-1a2b', title: '보고서' },
          { board: 'b', task_id: '3', status: 'todo', assignee: 'ghost', title: '자리 없는 담당' },
        ],
      },
      '/api/office': { seats: [seat('aas-admin', { title: 'Primary', label: 'aas-admin' }), seat('aas-agent-kim-1a2b', { label: '영업 도우미' })], rooms: [], pods: [], problems: [], can_edit: false },
    });
    mountScreen(<BoardPanel />, '/office');
    expect(await screen.findByText('Primary')).toBeInTheDocument();
    expect(screen.getByText('Primary').closest('[title]')).toHaveAttribute('title', 'aas-admin');
    expect(screen.getByText('영업 도우미')).toBeInTheDocument();
    expect(screen.queryByText('aas-admin')).toBeNull();
    expect(screen.queryByText('aas-agent-kim-1a2b')).toBeNull();
    expect(screen.getByText('ghost')).toBeInTheDocument(); // 자리가 없으면 별칭 그대로
  });

  it('에이전트 상태: 설치본 id 대신 에이전트 이름, 이름이 없으면 id, id 는 풍선말', async () => {
    stubApi({
      '/api/agents': {
        admin: true,
        enabled: true,
        agents: [
          { name: 'aas-agent-aas-test-a5f9', display_name: '테스트 도우미', owner: '', phase: 'Running', ready: true },
          { name: 'aas-agent-aas-user2-a2fd', display_name: '', owner: '', phase: 'Pending', ready: false },
        ],
      },
    });
    mountScreen(<ServerPanel />, '/office');
    expect(await screen.findByText('테스트 도우미')).toBeInTheDocument();
    expect(screen.getByText('테스트 도우미').closest('[title]')).toHaveAttribute('title', 'aas-agent-aas-test-a5f9');
    expect(screen.queryByText('aas-agent-aas-test-a5f9')).toBeNull();
    expect(screen.getByText('aas-agent-aas-user2-a2fd')).toBeInTheDocument();
  });

  it('실패한 예약 작업·막힌 카드: 항목 머리는 서버가 준 이름(label)', async () => {
    stubApi({
      '/api/office/inbox': {
        items: [
          { id: 'card|b|1', kind: 'blocked', alias: 'aas-agent-kim-1a2b', label: '영업 도우미', text: '회의실 버그', board: 'b', task_id: '1' },
          { id: 'cron|p|main|j', kind: 'cron_failed', alias: 'aas-agent-lee-9f9f', label: '분석 도우미', text: '아침 보고', error: 'timeout' },
          { id: 'q1', kind: 'clarify', alias: 'ops', text: '숨는 항목' },
        ],
      },
    });
    mountScreen(<InboxPanel kinds={['cron_failed', 'blocked']} />, '/office');
    expect(await screen.findByText(/· 영업 도우미$/)).toBeInTheDocument();
    expect(screen.getByText(/· 분석 도우미$/)).toBeInTheDocument();
    expect(screen.queryByText(/aas-agent-/)).toBeNull();
    expect(screen.queryByText('숨는 항목')).toBeNull();
  });
});

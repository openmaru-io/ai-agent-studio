/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { mountScreen, postedTo, stubApi } from '@/test/mountScreen';

import { AgentCron } from './AgentCron';

afterEach(() => vi.unstubAllGlobals());

describe('AgentCron', () => {
  it('다음 실행·마지막 결과를 보이고 지금 실행을 보낸다(멈춘 작업은 단추가 없다)', async () => {
    const fn = stubApi({
      '/api/office/cron/ops/jobs/j1/run': { accepted: true },
      '/api/office/cron/ops/jobs': {
        jobs: [
          { id: 'j1', name: '아침 보고', state: 'scheduled', last_status: 'error' },
          { id: 'j2', name: '멈춘 작업', state: 'paused' },
        ],
      },
    });
    mountScreen(<AgentCron alias="ops" canAct />, '/office');
    expect(await screen.findByText('아침 보고')).toBeInTheDocument();
    expect(screen.getByText(/마지막 error/)).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: '지금 실행' })).toHaveLength(1);
    await userEvent.click(screen.getByRole('button', { name: '지금 실행' }));
    expect(await screen.findByText(/아침 보고 을\(를\) 지금 한 번 실행합니다/)).toBeInTheDocument(); // 확인을 받는다(OMAI-1135)
    await userEvent.click(screen.getByRole('button', { name: '취소' }));
    expect(postedTo(fn, '/api/office/cron/ops/jobs/j1/run')).toHaveLength(0);
    await userEvent.click(await screen.findByRole('button', { name: '지금 실행' }));
    await userEvent.click(await screen.findByRole('button', { name: '확인' }));
    await waitFor(() => expect(postedTo(fn, '/api/office/cron/ops/jobs/j1/run')).toHaveLength(1));
    expect(await screen.findByText('아침 보고 를 실행했습니다')).toBeInTheDocument();
  });

  it('내 에이전트면 「새 크론」으로 프로파일을 고정해 만들고 목록을 다시 읽는다(스펙 2026-10-15-003)', async () => {
    const fn = stubApi({
      '/api/office/cron/ops/jobs': { jobs: [] },
    });
    mountScreen(<AgentCron alias="ops" canAct createProfile="main" />, '/office');
    await userEvent.click(await screen.findByRole('button', { name: '새 예약 작업' }));
    await userEvent.type(screen.getByLabelText('작업 이름'), 'weekly');
    await userEvent.type(screen.getByLabelText(/지시문/), '요약');
    await userEvent.click(screen.getByRole('button', { name: '작업 만들기' }));
    // 오피스 크론 라우트로 만든다(관리자가 남의 에이전트에 만들 때도 같은 길이다)
    await waitFor(() =>
      expect(postedTo(fn, '/api/office/cron/ops/jobs')).toContainEqual(
        expect.objectContaining({ name: 'weekly', prompt: '요약', deliver: 'local' })
      )
    );
    expect(postedTo(fn, '/api/cron/action')).toEqual([]);
  });

  it('작업이 없으면 안내 글 옆 단추 하나, 펼치면 「새 예약 작업 접기」, 만든 뒤 목록이 바뀌어도 포커스는 단추에 있다(스펙 2026-10-19-005 G2·G7·G8·V3)', async () => {
    let made = false;
    const base = stubApi({
      '/api/office/cron/ops/jobs': (_u: string, body: Record<string, unknown>) => {
        if (Object.keys(body ?? {}).length) {
          made = true;
          return { ok: true };
        }
        return { jobs: made ? [{ id: 'j9', name: 'weekly', state: 'scheduled' }] : [] };
      },
    });
    // 만든 뒤의 목록 다시 읽기는 늦게 온다(실제 네트워크처럼). 먼저 접으면 빈 상태 줄 단추에 포커스가 갔다가 목록이 바뀌며 잃는다
    vi.stubGlobal('fetch', (u: string, init?: RequestInit) =>
      made && !init?.body && u.startsWith('/api/office/cron/ops/jobs') ? new Promise((r) => setTimeout(() => r(base(u, init)), 50)) : base(u, init)
    );
    mountScreen(<AgentCron alias="ops" canAct createProfile="main" />, '/office');
    const open = await screen.findByRole('button', { name: '새 예약 작업' });
    expect(screen.getAllByRole('button', { name: /새 예약 작업/ })).toHaveLength(1);
    expect(open.parentElement).toHaveTextContent('예약 작업이 없습니다'); // 안내 글과 한 줄
    expect(open).toHaveAttribute('aria-expanded', 'false');
    await userEvent.click(open);
    const close = screen.getByRole('button', { name: '새 예약 작업 접기' });
    expect(close).toHaveAttribute('aria-expanded', 'true');
    expect(document.getElementById(close.getAttribute('aria-controls') as string)).toContainElement(screen.getByLabelText('작업 이름'));
    await userEvent.type(screen.getByLabelText('작업 이름'), 'weekly');
    await userEvent.type(screen.getByLabelText(/지시문/), '요약');
    await userEvent.click(screen.getByRole('button', { name: '작업 만들기' }));
    expect(await screen.findByText('weekly')).toBeInTheDocument();
    const again = screen.getByRole('button', { name: '새 예약 작업' });
    await waitFor(() => expect(again).toHaveFocus());
    expect(screen.queryByText('예약 작업이 없습니다')).toBeNull();
  });

  it('내 에이전트가 아니면 「새 크론」이 없다', async () => {
    stubApi({ '/api/office/cron/ops/jobs': { jobs: [] } });
    mountScreen(<AgentCron alias="ops" canAct />, '/office');
    await screen.findByText('예약 작업이 없습니다');
    expect(screen.queryByRole('button', { name: '새 예약 작업' })).not.toBeInTheDocument();
  });
});

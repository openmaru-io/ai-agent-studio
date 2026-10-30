/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AppProviders } from '@/components/AppProviders';
import { AppShell } from '@/components/AppShell';

// 처음 지정된 팀 관리자 안내 한 번(스펙 2026-10-22-001 DD9)
function stubMe(me: Record<string, unknown>) {
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string) => {
      const body = url.startsWith('/api/me') ? { user: { email: 'lee@corp.example' }, admin: false, auth_enabled: true, pods: [], department: '마케팅팀', ...me } : {};
      return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
    })
  );
}

function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/']}>
        <AppProviders>
          <AppShell>
            <div>본문</div>
          </AppShell>
        </AppProviders>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

const NOTICE = /마케팅팀 팀 관리자로 지정되었습니다/;

beforeEach(() => localStorage.clear());
// restoreAllMocks 는 setup 의 matchMedia 대역까지 되돌려 쓰지 않는다
const storageSpies: { mockRestore: () => void }[] = [];
afterEach(() => storageSpies.splice(0).forEach((s) => s.mockRestore()));

describe('처음 지정된 팀 관리자 안내', () => {
  it('지정 시각이 있으면 한 번 보이고, 닫은 뒤 다시 그리면 보이지 않는다', async () => {
    stubMe({ team_manager_since: '2026-10-22T09:00:00+09:00' });
    const first = mount();
    expect(await screen.findByText(NOTICE)).toBeInTheDocument();
    expect(screen.getByText(/'내 팀'에 있고/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /닫기|Close/ }));
    first.unmount();
    mount();
    await screen.findByText('본문');
    await new Promise((r) => setTimeout(r, 100));
    expect(screen.queryByText(NOTICE)).toBeNull();
  });

  it('새로 지정되어 시각이 달라지면 다시 보인다', async () => {
    localStorage.setItem('aas-team-manager-notice', '마케팅팀|2026-10-01T09:00:00+09:00');
    stubMe({ team_manager_since: '2026-10-22T09:00:00+09:00' });
    mount();
    expect(await screen.findByText(NOTICE)).toBeInTheDocument();
  });

  it('지정 시각이 비어 있으면 보이지 않는다', async () => {
    stubMe({ team_manager_since: '' });
    mount();
    await screen.findByText('본문');
    await new Promise((r) => setTimeout(r, 100));
    expect(screen.queryByText(NOTICE)).toBeNull();
  });

  it('저장소가 예외를 던져도 화면은 그려지고 안내는 보인다', async () => {
    const block = () => {
      throw new Error('blocked');
    };
    storageSpies.push(vi.spyOn(Storage.prototype, 'getItem').mockImplementation(block), vi.spyOn(Storage.prototype, 'setItem').mockImplementation(block));
    stubMe({ team_manager_since: '2026-10-22T09:00:00+09:00' });
    mount();
    expect(await screen.findByText('본문')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText(NOTICE)).toBeInTheDocument());
  });
});

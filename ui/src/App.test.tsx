/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { HashRouter, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { App } from './App';
import { AppProviders } from './components/AppProviders';
import { VIEWS } from './lib/views';
import { SCREENS } from './pages/screens';

function Where() {
  const l = useLocation();
  return <div data-testid="loc">{l.pathname + l.search}</div>;
}

function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <HashRouter>
        <AppProviders>
          <App />
          <Where />
        </AppProviders>
      </HashRouter>
    </QueryClientProvider>
  );
}

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.resolve(new Response('{"error":"시험"}', { status: 500 })))
  );
});

describe('옛 해시 주소가 그대로 열린다', () => {
  it.each([['#office?room=main', '/office', '?room=main', '오피스']])('%s', async (hash, path, search, title) => {
    window.location.hash = hash;
    mount();
    await waitFor(() => expect(screen.getByTestId('loc')).toHaveTextContent(path + search));
    expect(await screen.findByRole('heading', { level: 1, name: title })).toBeInTheDocument();
    expect(document.title).toBe(`${title} — AAS`);
  });

  it('주소가 비어 있으면 대시보드로 간다', async () => {
    window.location.hash = '';
    mount();
    await waitFor(() => expect(screen.getByTestId('loc')).toHaveTextContent('/dashboard'));
  });

  it('모르는 화면과 옛 주소 #/home 은 대시보드로 보낸다(넘김이 돌지 않는다)', async () => {
    window.location.hash = '#nope?x=1';
    mount();
    await waitFor(() => expect(screen.getByTestId('loc')).toHaveTextContent('/dashboard'));
    cleanup();
    window.location.hash = '#/home';
    mount();
    await waitFor(() => expect(screen.getByTestId('loc')).toHaveTextContent('/dashboard'));
    expect(await screen.findByRole('heading', { level: 1, name: '대시보드' })).toBeInTheDocument();
  });

  it('등록부에 없는 화면은 대시보드로 보낸다', async () => {
    // 옛 화면으로 잇던 통로(LegacyBridge)는 없어졌다(M1-10). 등록부에서 화면 하나를 빼면 홈으로 간다.
    const office = SCREENS.office;
    delete SCREENS.office;
    try {
      window.location.hash = '#office?room=main&seat=2';
      mount();
      await waitFor(() => expect(screen.getByTestId('loc')).toHaveTextContent('/dashboard'));
    } finally {
      SCREENS.office = office;
    }
  });

  it('화면 목록(views)의 모든 화면이 새 화면으로 등록되어 있다', () => {
    expect(VIEWS.filter((v) => !SCREENS[v.id]).map((v) => v.id)).toEqual([]);
  });
});

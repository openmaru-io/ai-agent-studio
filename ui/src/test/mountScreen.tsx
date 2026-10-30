/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 화면 시험 공통: 제공자·라우터·서랍을 갖춰 한 화면을 올리고, fetch 는 주소별 응답표로 바꿔 끼운다.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { ReactElement } from 'react';
import { MemoryRouter, useLocation, useNavigate } from 'react-router-dom';
import { vi } from 'vitest';

import { AppProviders } from '@/components/AppProviders';
import { DrawerHost } from '@/components/DrawerHost';
import { LazyFileViewer } from '@/components/files/LazyFileViewer';

export function Where() {
  const l = useLocation();
  return <div data-testid="loc">{l.pathname + l.search}</div>;
}

/** 브라우저 뒤로 가기(기록 한 칸 되감기). 주소 서랍 시험이 화면 옆에 둔다(스펙 2026-10-28-014 D9).
 *  서랍이 열리면 화면 읽기에서 가려지므로 `fireEvent.click(screen.getByRole('button', { name: '뒤로 가기', hidden: true }))` 로 누른다 */
export function HistoryBack() {
  const navigate = useNavigate();
  return (
    <button type="button" onClick={() => navigate(-1)}>
      뒤로 가기
    </button>
  );
}

type Reply = unknown | ((url: string, body: Record<string, unknown>) => unknown);

/** /api/me 응답: 기본은 관리자(로그인 꺼짐), NOT_ADMIN 은 로그인한 일반 사용자. */
export const ME_ADMIN = { auth_enabled: false, admin: true, user: null };
export const ME_USER = { auth_enabled: true, admin: false, user: { email: 'lee@x.com', name: 'lee' } };

export function stubApi(routes: Record<string, Reply>) {
  const fn = vi.fn((url: string, init?: RequestInit) => {
    const key = Object.keys(routes).find((k) => url.startsWith(k));
    // 화면들이 관리자 여부를 /api/me 로 안다(OMAI-1122). 시험이 따로 주지 않으면 로그인이 꺼진(=관리자) 상태로 답한다
    if (!key && url.split('?')[0] === '/api/me')
      return Promise.resolve(new Response(JSON.stringify(ME_ADMIN), { status: 200 }));
    if (!key) return Promise.resolve(new Response(JSON.stringify({ error: '없는 주소 ' + url }), { status: 404 }));
    const v = routes[key];
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    const out = typeof v === 'function' ? (v as (u: string, b: Record<string, unknown>) => unknown)(url, body) : v;
    if (out instanceof Response) return Promise.resolve(out); // 상태 코드가 필요한 시험(404·409)은 Response 를 그대로 돌려준다
    return Promise.resolve(new Response(JSON.stringify(out), { status: 200 }));
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

/** 시험에서 POST 본문만 모아 본다. */
export function postedTo(fn: ReturnType<typeof stubApi>, path: string): Record<string, unknown>[] {
  return fn.mock.calls
    .filter((c) => String(c[0]).startsWith(path) && (c[1] as RequestInit | undefined)?.body)
    .map((c) => JSON.parse(String((c[1] as RequestInit).body)));
}

export function mountScreen(ui: ReactElement, initial: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const out = render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[initial]}>
        <AppProviders>
          {ui}
          <DrawerHost />
          <LazyFileViewer />
          <Where />
        </AppProviders>
      </MemoryRouter>
    </QueryClientProvider>
  );
  return Object.assign(out, { qc });                     // 시험이 조회 캐시를 직접 무효화할 때 쓴다
}

/** 표 모드 목록의 행을 이름(행 안의 글자)으로 찾는다. 표의 행은 role row 이고, 「…」 메뉴 단추(「<이름> 동작」)와
 *  헷갈리지 않게 단추가 아니라 행으로 찾는다(OMAI-1127, 계획 2026-10-13-015 회귀 계약 11). */
export const rowByName = (name: RegExp | string) => screen.findByRole('row', { name: typeof name === 'string' ? new RegExp(name) : name });

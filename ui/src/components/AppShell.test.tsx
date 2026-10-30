/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation, useNavigate } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AppProviders } from '@/components/AppProviders';
import { AppShell } from '@/components/AppShell';
import { useUi } from '@/components/UiContext';
import { chatPopupState, closeChat, openChat, setChatMinimized } from '@/lib/chatPopup';
import { guideRunState, resetGuideRunForTest, startGuide } from '@/lib/guideRun';
import { reloadAtView } from '@/lib/pod';
import { noticeStore } from '@/lib/useNotices';
import { Agents } from '@/screens/Agents';
import { watchChatPopup } from '@/test/chatPopup';

// 에이전트를 바꾼 뒤의 새로 고침은 jsdom 이 하지 못해 대역으로 바꾼다(스펙 2026-10-19-019 DD5)
vi.mock('@/lib/pod', async (orig) => ({ ...(await orig<typeof import('@/lib/pod')>()), reloadAtView: vi.fn() }));

/** 넓은 화면(1200px 이상)으로 그린다. 시험 환경의 matchMedia 는 늘 거짓이다(src/test/setup.ts) */
function asWide() {
  const prev = window.matchMedia;
  window.matchMedia = vi.fn((query: string) => ({
    matches: /min-width:\s*1200/.test(query),
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })) as unknown as typeof window.matchMedia;
  return () => (window.matchMedia = prev);
}

/** /api/health·/api/me·/api/pod 응답을 정하고 나머지는 빈 값 */
function stubApi(opts: { health?: unknown; healthStatus?: number; me?: unknown; podStatus?: number }) {
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string) => {
      if (url.startsWith('/api/health')) return Promise.resolve(new Response(JSON.stringify(opts.health ?? health), { status: opts.healthStatus ?? 200 }));
      if (url.startsWith('/api/pod')) return Promise.resolve(new Response(JSON.stringify(opts.podStatus ? { error: '권한 없음' } : { ok: true }), { status: opts.podStatus ?? 200 }));
      const body = url.startsWith('/api/me') ? opts.me ?? { user: { email: 'dana@corp.example' }, admin: true, auth_enabled: true, pods: [] } : {};
      return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
    })
  );
}

function Where() {
  const loc = useLocation();
  return <div data-testid="where">{loc.pathname + loc.search}</div>;
}

function mount(initial = '/') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[initial]}>
        <AppProviders>
          <AppShell>
            <Where />
          </AppShell>
        </AppProviders>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

const health = {
  collected_at: '2026-10-10T14:00:00+09:00',
  totals: { profiles: 3, profiles_ok: 3, failed_jobs: 2, live_incidents: 1 },
  dashboard_url: 'http://hermes.local',
};

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string) => {
      const body = url.startsWith('/api/health')
        ? health
        : url.startsWith('/api/me')
        ? { user: { email: 'dana@corp.example' }, admin: true, auth_enabled: true, pods: [], department: '마케팅팀', company_name: 'ACME' }
        : {};
      return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
    })
  );
});

describe('AppShell', () => {
  it('본문(main)은 포커스를 받아도 외곽선이 없다(빈 곳을 누르고 Esc 를 누르면 Chrome 이 :focus-visible 로 바꿔 본문 전체에 테두리를 그렸다)', () => {
    mount();
    const main = screen.getByRole('main');
    expect(main).toHaveAttribute('tabindex', '-1');
    expect(main).toHaveStyle({ outline: 'none' });
  });

  it('받은편지함 종은 상단 막대 왼쪽, 로고 바로 오른쪽에 있고 검색창보다 앞이다(Observability 와 같은 자리, 2026-10-15)', async () => {
    mount();
    const header = await screen.findByRole('banner');
    const home = within(header).getByRole('link', { name: 'AAS 첫 화면' });
    const bell = await within(header).findByRole('button', { name: /받은편지함/ });
    const search = within(header).getByRole('button', { name: /검색/ });
    const follows = (a: Element, b: Element) => !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
    expect(follows(home, bell)).toBe(true);
    expect(follows(bell, search)).toBe(true); // 예전에는 오른쪽 아이콘 줄(언어 단추 앞)에 있었다
    expect(bell.parentElement).toBe(home.parentElement); // 로고와 같은 왼쪽 묶음 안
  });

  it('종의 개수 배지는 빨간 알림색이고 99 를 넘으면 99+ 로 줄인다', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) => {
        const body = url.startsWith('/api/office/inbox')
          ? { items: Array.from({ length: 120 }, (_, i) => ({ id: `c${i}`, kind: 'cron_done', alias: 'a', text: 't' })) }
          : url.startsWith('/api/me')
          ? { user: { email: 'a@x.com' }, admin: true, auth_enabled: true, pods: [] }
          : {};
        return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
      })
    );
    mount();
    const header = await screen.findByRole('banner');
    const bell = await within(header).findByRole('button', { name: '받은편지함 120건' });
    const badge = await within(bell).findByText('99+');
    expect(getComputedStyle(badge).backgroundColor).toBe('rgb(218, 41, 28)'); // DESIGN.md 알림색 #DA291C
  });

  it('상단 「다시 읽기」 단추가 화면의 데이터를 모두 다시 가져온다', async () => {
    const user = userEvent.setup();
    mount();
    const count = () => (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.filter((c) => String(c[0]).startsWith('/api/health')).length;
    await waitFor(() => expect(count()).toBeGreaterThan(0));
    const before = count();
    await user.click(screen.getByRole('button', { name: '다시 읽기' }));
    await waitFor(() => expect(count()).toBeGreaterThan(before));
    expect(await screen.findByText('화면의 데이터를 다시 읽었습니다')).toBeInTheDocument();
  });

  it('「다시 읽기」 알림(Toast)은 앞에 아이콘이 있다(variant 없이 띄우면 아이콘이 없었다)', async () => {
    const user = userEvent.setup();
    mount();
    await user.click(screen.getByRole('button', { name: '다시 읽기' }));
    const toast = (await screen.findByText('화면의 데이터를 다시 읽었습니다')).closest('.notistack-MuiContent');
    expect(toast).not.toBeNull();
    expect(toast!.querySelector('svg')).not.toBeNull();
  });

  it('에이전트 화면을 열어도 셸이 깨지지 않는다(쿼리 키가 겹치면 화면 전체가 사라졌다)', async () => {
    // 셸의 팔레트가 쓰는 에이전트 목록(배열)과 Hermes 화면의 목록(객체)이 같은 쿼리 키를 쓰면 .map 이 터져 빈 화면이 된다(OKE 에서 「구성」을 누르면 빈 화면)
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) => {
        const body = url.startsWith('/api/agents')
          ? { enabled: true, agents: [], limit: 3, default_limit: 3, count: 0, can_create: true, admin: true, error: '' }
          : url.startsWith('/api/chat/status')
          ? { agents: [{ name: 'ma', title: '마케팅' }] }
          : url.startsWith('/api/health')
          ? health
          : url.startsWith('/api/me')
          ? { user: { email: 'dana@corp.example' }, admin: true, auth_enabled: true, pods: [] }
          : {};
        return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
      })
    );
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={['/agents']}>
          <AppProviders>
            <AppShell>
              <Agents />
            </AppShell>
          </AppProviders>
        </MemoryRouter>
      </QueryClientProvider>
    );
    expect(await screen.findByRole('heading', { name: 'AI 에이전트 작업공간' })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('navigation', { name: '주 메뉴' })).toBeInTheDocument());
    // 셸이 에이전트 목록을 받아 팔레트에 올린 뒤에도 화면이 남아 있다
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.getByRole('heading', { name: 'AI 에이전트 작업공간' })).toBeInTheDocument();
  });

  it('좌측 메뉴의 오피스 항목은 회사·부서가 있어도 「오피스」다(OMAI-1121 — 회사·부서는 화면 제목에만)', async () => {
    mount('/office');
    const nav = screen.getByRole('navigation', { name: '주 메뉴' });
    await waitFor(() => expect(within(nav).getByRole('link', { name: '오피스' })).toBeInTheDocument());
    await new Promise((r) => setTimeout(r, 50)); // /api/me 가 온 뒤에도 바뀌지 않는다
    expect(within(nav).queryByRole('link', { name: /마케팅팀|ACME/ })).not.toBeInTheDocument();
  });

  it('상단에 로고가 있고 좌측 메뉴에 할 일 기준 묶음이 있다(OMAI-1313)', async () => {
    mount();
    expect(screen.getByRole('link', { name: 'AAS 첫 화면' })).toHaveAttribute('href', '/dashboard');
    expect(screen.getByRole('img', { name: 'OPENMARU CogentAI' })).toBeInTheDocument();   // 브랜드 값이 없으면 OPENMARU(OMAI-1299)
    const nav = screen.getByRole('navigation', { name: '주 메뉴' });
    for (const g of ['대시보드', '대화', '내 AI 에이전트', '스킬', '자동화', '기록', '설정'])
      expect(within(nav).getByRole('link', { name: new RegExp(g) })).toBeInTheDocument();
    // 「관리」는 관리자라는 응답(/api/me)이 온 뒤에 보인다
    await waitFor(() => expect(within(nav).getByRole('link', { name: /관리/ })).toBeInTheDocument());
  });

  it('상단 막대에 사이드바 접기·다크 라이트·전체 화면·계정 단추가 있다', () => {
    mount();
    for (const name of ['사이드바 접기', '언어', '라이트 모드', '전체 화면', /^계정/])
      expect(within(screen.getByRole('banner')).getByRole('button', { name })).toBeInTheDocument();
  });

  it('수집 시각은 막대에 글자로 보이지 않고 「다시 읽기」 단추의 설명과 풍선말 두 줄이다(스펙 2026-10-19-019 R1·R8)', async () => {
    const user = userEvent.setup();
    mount();
    const btn = screen.getByRole('button', { name: '다시 읽기' });
    await waitFor(() => expect(btn).toHaveAccessibleDescription('마지막 수집 2026-10-10 14:00 (3/3)'));
    expect(screen.getAllByText(/마지막 수집/)).toHaveLength(1); // 숨김 설명 하나뿐 — 막대에 보이던 수집 글자 줄은 없다
    expect(screen.queryByTestId('collect-warn')).toBeNull();
    await user.hover(btn);
    const tip = await screen.findByRole('tooltip');
    expect(within(tip).getByText('다시 읽기')).toBeInTheDocument();
    expect(within(tip).getByText('마지막 수집 2026-10-10 14:00 (3/3)')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '다시 읽기' })).toBe(btn); // 풍선말이 열려도 단추 이름은 그대로
    expect(within(screen.getByRole('link', { name: /자동화/ })).getByLabelText('3건')).toBeInTheDocument();
  });

  it('수집이 실패하면 경고 점과 화면 읽기 알림 「수집 실패」가 있고 단추 설명은 비운다(D3·O5)', async () => {
    stubApi({ healthStatus: 500, health: { error: 'x' } });
    mount();
    expect(await screen.findByTestId('collect-warn')).toBeInTheDocument();
    await waitFor(() => expect(within(screen.getByRole('banner')).getByRole('status')).toHaveTextContent('수집 실패'));
    expect(screen.getByRole('button', { name: '다시 읽기' })).not.toHaveAccessibleDescription(/수집/);
  });

  it('일부 프로파일만 수집되면 경고 점을 켜고 알림은 하지 않는다(DD7)', async () => {
    stubApi({ health: { ...health, totals: { ...health.totals, profiles_ok: 1 } } });
    mount();
    const btn = screen.getByRole('button', { name: '다시 읽기' });
    await waitFor(() => expect(btn).toHaveAccessibleDescription('마지막 수집 2026-10-10 14:00 (1/3)'));
    expect(screen.getByTestId('collect-warn')).toBeInTheDocument();
    expect(within(screen.getByRole('banner')).getByRole('status')).toHaveTextContent('');
  });

  describe('상단 막대 에이전트 고르개(스펙 2026-10-19-019)', () => {
    const me = {
      user: { email: 'dana@corp.example' },
      admin: true,
      auth_enabled: true,
      pod: { id: 'one', owner: 'dana@corp.example', name: '운영' },
      pods: [
        { id: 'one', owner: 'dana@corp.example', name: '운영' },
        { id: 'two', owner: 'lee@x.com', owner_name: '이사용', name: '시험' },
      ],
    };

    it('1200px 이상이면 막대에 고르개가 있고 계정 메뉴에는 「에이전트」 묶음이 없다(R5·O4)', async () => {
      stubApi({ me });
      const restore = asWide();
      try {
        mount();
        const header = await screen.findByRole('banner');
        expect(await within(header).findByRole('button', { name: 'AI 에이전트 작업공간: 운영' })).toBeInTheDocument();
        await userEvent.setup().click(within(header).getByRole('button', { name: /^계정/ }));
        expect(await screen.findByRole('menuitem', { name: '로그아웃' })).toBeInTheDocument();
        expect(screen.queryByRole('menuitemradio')).toBeNull();
      } finally {
        restore();
      }
    });

    it('좁은 화면이면 고르개가 없고 계정 메뉴의 「에이전트」 묶음에서 고른다', async () => {
      stubApi({ me });
      mount();
      const header = await screen.findByRole('banner');
      await userEvent.setup().click(within(header).getByRole('button', { name: /^계정/ }));
      expect(await screen.findByRole('menuitemradio', { name: 'AI 에이전트 작업공간 이사용 · 시험' })).toBeInTheDocument();
      expect(within(header).queryByRole('button', { name: /^AI 에이전트 작업공간:/ })).toBeNull();
    });

    it('다른 에이전트를 고르면 POST /api/pod 뒤 그 화면의 목록 주소로 새로 고친다(O6·DD5)', async () => {
      stubApi({ me });
      vi.mocked(reloadAtView).mockClear();
      const restore = asWide();
      try {
        const user = userEvent.setup();
        mount('/profiles?name=main');
        await user.click(await screen.findByRole('button', { name: 'AI 에이전트 작업공간: 운영' }));
        await user.click(await screen.findByRole('menuitemradio', { name: 'AI 에이전트 작업공간 이사용 · 시험' }));
        await waitFor(() => expect(reloadAtView).toHaveBeenCalledWith('profiles'));
        const calls = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.filter((c) => String(c[0]) === '/api/pod');
        expect(calls).toHaveLength(1);
        expect(JSON.parse(String((calls[0][1] as RequestInit).body))).toEqual({ id: 'two' });
        // 새로 고치기 전까지 단추는 고른 에이전트와 「바꾸는 중」(DD4)
        const btn = screen.getByRole('button', { name: 'AI 에이전트 작업공간: 이사용 · 시험' });
        expect(btn).toBeDisabled();
        expect(btn).toHaveAttribute('aria-busy', 'true');
        expect(screen.getByRole('button', { name: '다시 읽기' })).toBeDisabled();
      } finally {
        restore();
      }
    });

    it('바꾸기가 실패하면 원래 글자로 돌아오고 「에이전트를 바꾸지 못했습니다」 알림이 뜬다(DD9)', async () => {
      stubApi({ me, podStatus: 403 });
      vi.mocked(reloadAtView).mockClear();
      const restore = asWide();
      try {
        const user = userEvent.setup();
        mount();
        await user.click(await screen.findByRole('button', { name: 'AI 에이전트 작업공간: 운영' }));
        await user.click(await screen.findByRole('menuitemradio', { name: 'AI 에이전트 작업공간 이사용 · 시험' }));
        expect(await screen.findByText(/^AI 에이전트 작업공간을 바꾸지 못했습니다: /)).toBeInTheDocument();
        await waitFor(() => expect(screen.getByRole('button', { name: 'AI 에이전트 작업공간: 운영' })).not.toBeDisabled());
        expect(reloadAtView).not.toHaveBeenCalled();
      } finally {
        restore();
      }
    });
  });

  it('선택한 묶음만 펼쳐 화면 목록을 보인다', () => {
    mount('/cron');
    const nav = screen.getByRole('navigation', { name: '주 메뉴' });
    expect(within(nav).getByRole('link', { name: /예약 작업/ })).toHaveAttribute('aria-current', 'page');
    expect(within(nav).getByRole('link', { name: /메신저 연결/ })).toBeInTheDocument();
    expect(within(nav).queryByRole('link', { name: '스킬 허브' })).not.toBeInTheDocument();
  });

  it('스킬 허브 메뉴의 이름은 「스킬 허브」이다', () => {
    mount('/market');
    const nav = screen.getByRole('navigation', { name: '주 메뉴' });
    expect(within(nav).getByRole('link', { name: '스킬 허브' })).toHaveAttribute('aria-current', 'page');
  });

  it('대시보드는 펼치기 없는 한 줄이고 누르면 바로 대시보드로 간다(계획 2026-10-14-014 R3)', async () => {
    const user = userEvent.setup();
    mount('/cron');
    const nav = screen.getByRole('navigation', { name: '주 메뉴' });
    const item = within(nav).getByRole('link', { name: '대시보드' });
    expect(item).not.toHaveAttribute('aria-expanded');
    await user.click(item);
    expect(screen.getByTestId('where')).toHaveTextContent('/dashboard');
    expect(within(nav).getByRole('link', { name: '대시보드' })).toHaveAttribute('aria-current', 'page');
    expect(within(nav).getAllByRole('link', { name: '대시보드' })).toHaveLength(1); // 하위 목록이 따로 생기지 않는다
  });

  it('접힌 사이드바에서도 대시보드는 바로 가는 링크다', async () => {
    localStorage.clear();
    const user = userEvent.setup();
    mount('/cron');
    await user.click(within(screen.getByRole('banner')).getByRole('button', { name: '사이드바 접기' }));
    await user.click(within(screen.getByRole('navigation', { name: '주 메뉴' })).getByRole('link', { name: '대시보드' }));
    expect(screen.getByTestId('where')).toHaveTextContent('/dashboard');
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    localStorage.clear();
  });

  it('묶음을 누르면 그 묶음의 첫 화면으로 가고 목록이 펼쳐진다', async () => {
    const user = userEvent.setup();
    mount();
    await user.click(within(screen.getByRole('navigation', { name: '주 메뉴' })).getByRole('link', { name: /자동화/ }));
    expect(screen.getByTestId('where')).toHaveTextContent('/cron');
    await user.click(await screen.findByRole('link', { name: '메신저 연결' }));
    expect(screen.getByTestId('where')).toHaveTextContent('/channels');
  });

  it('사이드바를 접으면 아이콘만 남고 고른 상태를 기억한다', async () => {
    localStorage.clear();
    const user = userEvent.setup();
    mount('/cron');
    expect(screen.getByRole('link', { name: /예약 작업/ })).toBeInTheDocument();
    await user.click(within(screen.getByRole('banner')).getByRole('button', { name: '사이드바 접기' }));
    expect(screen.queryByRole('link', { name: /예약 작업/ })).not.toBeInTheDocument();
    expect(localStorage.getItem('aas-sidebar')).toBe('closed');
    await user.click(within(screen.getByRole('banner')).getByRole('button', { name: '사이드바 펼치기' }));
    expect(screen.getByRole('link', { name: /예약 작업/ })).toBeInTheDocument();
    expect(localStorage.getItem('aas-sidebar')).toBe('open');
  });

  it('접힌 사이드바에서 묶음 아이콘을 누르면 하위 화면 목록이 열려 들어갈 수 있다', async () => {
    localStorage.setItem('aas-sidebar', 'closed');
    const user = userEvent.setup();
    mount();
    // 접힌 상태에는 글자 링크가 없다. 아이콘 단추만 있다
    expect(screen.queryByRole('link', { name: /예약 작업/ })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /^자동화/ }));
    const menu = await screen.findByRole('menu');
    for (const n of ['예약 작업', '메신저 연결'])
      expect(within(menu).getByRole('menuitem', { name: new RegExp(n) })).toBeInTheDocument();
    await user.click(within(menu).getByRole('menuitem', { name: /예약 작업/ }));
    expect(screen.getByTestId('where')).toHaveTextContent('/cron');
    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument());
    localStorage.removeItem('aas-sidebar');
  });

  it('접힌 상태에서도 상단 막대의 단추(펼치기·다크 라이트·전체 화면·계정)가 모두 있다', () => {
    localStorage.setItem('aas-sidebar', 'closed');
    mount();
    for (const name of ['사이드바 펼치기', '라이트 모드', '전체 화면', /^계정/])
      expect(within(screen.getByRole('banner')).getByRole('button', { name })).toBeInTheDocument();
    localStorage.removeItem('aas-sidebar');
  });

  it('언어를 영어로 바꾸면 메뉴·상단 막대·계정 메뉴가 영어로 나오고 고른 값을 기억한다', async () => {
    localStorage.clear();
    const user = userEvent.setup();
    mount('/cron');
    expect(screen.getByRole('link', { name: /예약 작업/ })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '언어' }));
    // 언어 이름은 각 언어로 적혀 있다
    await user.click(await screen.findByRole('menuitem', { name: 'English' }));
    expect(localStorage.getItem('aas-lang')).toBe('en');
    const nav = await screen.findByRole('navigation', { name: 'Main menu' });
    expect(within(nav).getByRole('link', { name: /Automation/ })).toBeInTheDocument();
    expect(within(nav).getByRole('link', { name: /Scheduled jobs/ })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('button', { name: 'Language' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Light mode' })).toBeInTheDocument();
    expect(document.documentElement.lang).toBe('en');
    await user.click(await screen.findByRole('button', { name: /^Account/ }));
    expect(await screen.findByRole('menuitem', { name: 'Sign out' })).toHaveAttribute('href', '/auth/logout');
    // 다시 한국어로
    await user.keyboard('{Escape}');
    await user.click(screen.getByRole('button', { name: 'Language' }));
    await user.click(await screen.findByRole('menuitem', { name: '한국어' }));
    expect(localStorage.getItem('aas-lang')).toBe('ko');
    expect(await screen.findByRole('link', { name: /예약 작업/ })).toBeInTheDocument();
  });

  it('다크 라이트를 바꾸면 배경색이 바뀌고 고른 값을 기억한다', async () => {
    localStorage.clear();
    const user = userEvent.setup();
    mount();
    const bg = () => getComputedStyle(document.body).backgroundColor;
    const dark = bg();
    await user.click(screen.getByRole('button', { name: '라이트 모드' }));
    expect(localStorage.getItem('aas-theme')).toBe('light');
    expect(bg()).not.toBe(dark);
    expect(screen.getByRole('button', { name: '다크 모드' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '다크 모드' }));
    expect(localStorage.getItem('aas-theme')).toBe('dark');
    expect(bg()).toBe(dark);
  });

  it('기억해 둔 라이트 모드로 시작한다', () => {
    localStorage.setItem('aas-theme', 'light');
    mount();
    expect(screen.getByRole('button', { name: '다크 모드' })).toBeInTheDocument();
  });

  it('g 다음 글자로 화면을 옮긴다', async () => {
    mount();
    fireEvent.keyDown(document.body, { key: 'g' });
    fireEvent.keyDown(document.body, { key: 'r' });
    expect(screen.getByTestId('where')).toHaveTextContent('/cron');
    fireEvent.keyDown(document.body, { key: 'g' });
    fireEvent.keyDown(document.body, { key: 'k' });
    expect(screen.getByTestId('where')).toHaveTextContent('/credentials');
  });

  it('관리자가 아니면 메뉴·검색창·단축키에 「사용자·권한」 이 없다(눌러도 「관리자만 볼 수 있습니다」 오류만 나왔다)', async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) => {
        const body = url.startsWith('/api/health')
          ? health
          : url.startsWith('/api/me')
          ? { user: { email: 'lee@x.com' }, admin: false, owner: false, auth_enabled: true, pods: [] }
          : {};
        return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
      })
    );
    mount('/agents');
    await user.click(await screen.findByRole('button', { name: /^계정/ }));
    await screen.findByRole('menuitem', { name: '내 정보' }); // /api/me 가 온 뒤
    await user.keyboard('{Escape}');
    const nav = screen.getByRole('navigation', { name: '주 메뉴' });
    expect(within(nav).getByRole('link', { name: 'AI 에이전트 작업공간' })).toBeInTheDocument();
    expect(within(nav).queryByRole('link', { name: '사용자·권한' })).not.toBeInTheDocument();
    fireEvent.keyDown(document.body, { key: 'k', ctrlKey: true });
    const input = await screen.findByRole('combobox', { name: '검색어' });
    await user.type(input, '사용자');
    expect(screen.queryByRole('option', { name: /사용자·권한/ })).not.toBeInTheDocument();
    await user.keyboard('{Escape}');
    fireEvent.keyDown(document.body, { key: 'g' });
    fireEvent.keyDown(document.body, { key: 'u' });
    expect(screen.getByTestId('where')).toHaveTextContent('/agents');          // 옮겨 가지 않는다
  });

  it('입력창에 글자를 치는 중에는 단축키가 동작하지 않는다', async () => {
    const user = userEvent.setup();
    mount();
    await user.click(screen.getByRole('button', { name: /검색해서 이동/ }));
    const input = await screen.findByRole('combobox', { name: '검색어' });
    await user.type(input, 'gr');
    expect(screen.getByTestId('where')).toHaveTextContent('/');
    expect(screen.getByTestId('where')).not.toHaveTextContent('/cron');
  });

  it('g 를 누르고 1.5초가 지나면 다음 글자는 단축키가 아니다', async () => {
    vi.useFakeTimers();
    try {
      mount();
      fireEvent.keyDown(document.body, { key: 'g' });
      vi.advanceTimersByTime(1600);
      fireEvent.keyDown(document.body, { key: 'r' });
      expect(screen.getByTestId('where')).not.toHaveTextContent('/cron');
    } finally {
      vi.useRealTimers();
    }
  });

  it('Ctrl+K 로 팔레트를 열고 이름을 쳐서 화면으로 간다', async () => {
    const user = userEvent.setup();
    mount();
    fireEvent.keyDown(document.body, { key: 'k', ctrlKey: true });
    const input = await screen.findByRole('combobox', { name: '검색어' });
    await user.type(input, 'API 키');
    await user.keyboard('{Enter}');
    expect(screen.getByTestId('where')).toHaveTextContent('/credentials');
    await waitFor(() => expect(screen.queryByRole('combobox', { name: '검색어' })).not.toBeInTheDocument());
  });

  it('팔레트에서 에이전트 이름을 치면 그 에이전트와의 대화로 간다', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) => {
        const body = url.startsWith('/api/chat/status')
          ? { agents: [{ name: 'ma', title: '마케팅' }] }
          : url.startsWith('/api/health')
          ? health
          : {};
        return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
      })
    );
    const user = userEvent.setup();
    mount();
    fireEvent.keyDown(document.body, { key: 'k', ctrlKey: true });
    await user.type(await screen.findByRole('combobox', { name: '검색어' }), '마케팅');
    const popup = watchChatPopup();
    await user.keyboard('{Enter}');
    expect(popup()).toMatchObject({ kind: 'chat', agent: 'ma' }); // 화면을 떠나지 않고 대화 팝업으로 연다(OMAI-1115)
    expect(screen.getByTestId('where')).not.toHaveTextContent('/chat');
  });

  it('상단 막대의 AI 단추는 검색창 바로 오른쪽에 있고 내 에이전트(default → 주 에이전트)와의 대화 팝업을 열고 닫는다(OMAI-1218)', async () => {
    const user = userEvent.setup();
    mount();
    const popup = watchChatPopup();
    const header = await screen.findByRole('banner');
    const search = within(header).getByRole('button', { name: /검색/ });
    const ai = within(header).getByRole('button', { name: '내 AI 에이전트와 대화' });
    expect(search.compareDocumentPosition(ai) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(ai).toHaveAttribute('aria-pressed', 'false');
    await user.click(ai);
    expect(popup()).toMatchObject({ kind: 'chat', agent: '@primary' }); // @primary 는 chatStore.resolve 가 채팅 기본 → 주 에이전트로 바꾼다(2026-10-19-001 L5)
    expect(ai).toHaveAttribute('aria-pressed', 'true');
    await user.click(ai); // 열려 있으면 닫는다(대화는 chatStore 에 남는다)
    expect(popup()).toBeNull();
    expect(ai).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByTestId('where')).not.toHaveTextContent('/chat');
  });

  it('AI 단추: 최소화돼 있으면 펼치고, 다른 사람 자리 대화가 열려 있으면 내 에이전트로 바꾼다(OMAI-1218)', async () => {
    const user = userEvent.setup();
    mount();
    const popup = watchChatPopup();
    const ai = await screen.findByRole('button', { name: '내 AI 에이전트와 대화' });
    act(() => {
      openChat({ kind: 'chat', agent: 'default' });
      setChatMinimized(true);
    });
    await user.click(ai);
    expect(chatPopupState().minimized).toBe(false);
    expect(popup()).not.toBeNull();
    act(() => openChat({ kind: 'office', alias: 'kim', title: '김 대리' }));
    await waitFor(() => expect(ai).toHaveAttribute('aria-pressed', 'false')); // 내 에이전트 대화가 아니면 눌린 표시가 아니다
    await user.click(ai);
    expect(popup()).toMatchObject({ kind: 'chat', agent: '@primary' });
  });

  it('AI 단추 오른쪽에 3D 오피스로 가는 단추가 있고, 누르면 오피스 화면으로 가며 거기서는 현재 화면 표시가 선다(OMAI-1218)', async () => {
    const user = userEvent.setup();
    mount('/dashboard');
    const header = await screen.findByRole('banner');
    const ai = within(header).getByRole('button', { name: '내 AI 에이전트와 대화' });
    const office = within(header).getByRole('link', { name: '3D 오피스' });
    expect(ai.compareDocumentPosition(office) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(office).not.toHaveAttribute('aria-current');
    await user.click(office);
    expect(screen.getByTestId('where')).toHaveTextContent('/office');
    expect(within(header).getByRole('link', { name: '3D 오피스' })).toHaveAttribute('aria-current', 'page');
  });

  // 도움말 서랍(OMAI-1274 V1): `?` 와 계정 메뉴 「단축키」는 도움말 서랍의 「단축키」 탭을 연다. 단축키 표에 가이드 카드 이동 키가 있다
  it('? 를 누르면 도움말 서랍이 「단축키」 탭으로 열리고 Esc 로 닫힌다', async () => {
    mount();
    fireEvent.keyDown(document.body, { key: '?' });
    const dlg = await screen.findByRole('dialog', { name: '도움말' });
    expect(within(dlg).getByRole('tab', { name: '단축키' })).toHaveAttribute('aria-selected', 'true');
    expect(within(dlg).getByText(/g 다음 글자/)).toBeInTheDocument();
    expect(within(dlg).getByText('진행 중인 가이드 카드로 이동')).toBeInTheDocument();
    fireEvent.keyDown(document.body, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '도움말' })).not.toBeInTheDocument());
  });

  // 2026-10-19-013 R5: 프로파일이 하나뿐이면 팔레트도 에이전트 이름으로 보이고, 이름으로 찾아 그 프로파일과의 대화를 연다
  it('팔레트: 프로파일이 하나뿐이면 「main」 대신 에이전트 이름으로 찾는다', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) => {
        const body = url.startsWith('/api/chat/status')
          ? { agents: [{ name: 'main' }] }
          : url.startsWith('/api/health')
          ? health
          : url.startsWith('/api/me')
          ? { auth_enabled: false, pod: { id: 'aas-agent-x', owner: 'kim', name: '관리자 AAS' }, pods: [] }
          : {};
        return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
      })
    );
    const user = userEvent.setup();
    mount();
    fireEvent.keyDown(document.body, { key: 'k', ctrlKey: true });
    await user.type(await screen.findByRole('combobox', { name: '검색어' }), '관리자');
    const option = await screen.findByRole('option', { name: /관리자 AAS/ });
    expect(option).not.toHaveTextContent('main');
    const popup = watchChatPopup();
    await user.click(option); // 「관리」 메뉴도 함께 걸려 Enter 는 그쪽을 고를 수 있다
    expect(popup()).toMatchObject({ kind: 'chat', agent: 'main' });
  });

  // OMAI-1274 §4-2 (라): 명령 팔레트에서 가이드를 찾아 바로 시작한다
  it('Ctrl+K 팔레트에서 가이드 이름을 치면 「가이드」 묶음에 나오고 고르면 그 가이드를 시작한다', async () => {
    const user = userEvent.setup();
    closeChat();
    mount('/dashboard');
    await waitFor(() => expect(guideRunState().user).toBe('dana@corp.example'));
    fireEvent.keyDown(document.body, { key: 'k', ctrlKey: true });
    const input = await screen.findByRole('combobox');
    await user.type(input, '첫 대화');
    const item = await screen.findByRole('option', { name: /AI 에이전트와 첫 대화하기/ });
    expect(item).toHaveTextContent('가이드');
    await user.click(item);
    await waitFor(() => expect(guideRunState().run?.id).toBe('user.first-chat'));
    act(() => resetGuideRunForTest());
  });

  // OMAI-1274 V17: Alt·입력 중 조기 반환보다 앞에서 본다. Mac 의 Option+Shift+H 는 key 가 'Ó' 라 code 로 판정한다
  it('입력칸에 있어도 Alt+Shift+H 를 누르면 진행 중인 가이드 카드의 단계 제목으로 포커스가 간다. 한글 조합 중이면 아무 일도 없다', async () => {
    closeChat(); // 앞 시험이 연 대화 팝업이 남아 있으면 카드가 알약으로 접힌다
    mount('/agents');
    await waitFor(() => expect(guideRunState().user).toBe('dana@corp.example'));
    act(() => startGuide('user.my-agents'));
    const title = await screen.findByRole('heading', { name: 'AI 에이전트 작업공간 목록 보기' });
    const input = document.createElement('input');
    document.body.appendChild(input);
    input.focus();
    fireEvent.keyDown(input, { key: 'Ó', code: 'KeyH', altKey: true, shiftKey: true, isComposing: true });
    expect(document.activeElement).toBe(input);
    fireEvent.keyDown(input, { key: 'Ó', code: 'KeyH', altKey: true, shiftKey: true });
    await waitFor(() => expect(document.activeElement).toBe(title));
    input.remove();
    act(() => resetGuideRunForTest());
  });

  it('계정 메뉴 「단축키」도 도움말 서랍의 「단축키」 탭을 열고, 상단 막대 도움말 단추는 「사용자 가이드」 탭을 연다', async () => {
    const user = userEvent.setup();
    mount();
    await user.click(await screen.findByRole('button', { name: /dana/ }));
    await user.click(await screen.findByRole('menuitem', { name: /단축키/ }));
    let dlg = await screen.findByRole('dialog', { name: '도움말' });
    expect(within(dlg).getByRole('tab', { name: '단축키' })).toHaveAttribute('aria-selected', 'true');
    fireEvent.keyDown(document.body, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '도움말' })).not.toBeInTheDocument());
    await user.click(within(screen.getByRole('banner')).getByRole('button', { name: '도움말' }));
    dlg = await screen.findByRole('dialog', { name: '도움말' });
    expect(within(dlg).getByRole('tab', { name: '사용자 가이드' })).toHaveAttribute('aria-selected', 'true');
    expect(within(dlg).getByText('AI 에이전트와 첫 대화하기')).toBeInTheDocument();
  });

  it('계정 메뉴에 이메일과 관리자 표시, 로그아웃이 있다', async () => {
    const user = userEvent.setup();
    mount();
    await user.click(await screen.findByRole('button', { name: /dana/ }));
    const menu = await screen.findByRole('menu');
    expect(await within(menu).findByText('dana@corp.example')).toBeInTheDocument();
    expect(within(menu).getByText('관리자')).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: '로그아웃' })).toHaveAttribute('href', '/auth/logout');
    expect(screen.queryByRole('menuitem', { name: '새로 고침' })).not.toBeInTheDocument(); // 상단 막대에 새로 고침 단추가 있다(OMAI-1267)
    expect(screen.getByRole('menuitem', { name: '단축키' })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: /에이전트 대시보드/ })).not.toBeInTheDocument(); // 에이전트 대시보드로 나가는 링크는 두지 않는다(OMAI-1117)
  });

  it('계정 메뉴의 「내 정보」 가 서랍을 열고 본인 정보와 비밀번호 변경이 있다(스펙 2026-10-14-017)', async () => {
    const user = userEvent.setup();
    mount();
    await user.click(await screen.findByRole('button', { name: /dana/ }));
    await user.click(await screen.findByRole('menuitem', { name: '내 정보' }));
    const drawer = await screen.findByRole('dialog', { name: /내 정보/ });
    expect(within(drawer).getByText('dana@corp.example')).toBeInTheDocument();
    expect(within(drawer).getByText('마케팅팀')).toBeInTheDocument();
    expect(within(drawer).getByText('관리자')).toBeInTheDocument();
  });

  describe('화면을 옮기면 주소에 묶이지 않은 서랍은 닫힌다(OMAI-1284)', () => {
    function Openers() {
      const ui = useUi();
      const go = useNavigate();
      return (
        <>
          <button onClick={() => ui.openDrawer({ title: '임시 서랍', body: <p>임시 본문</p> })}>임시 열기</button>
          <button onClick={() => ui.openDrawer({ title: '고정 서랍', id: 'pin', keep: true, body: <p>고정 본문</p> })}>고정 열기</button>
          <button onClick={() => go('/flows')}>다른 화면</button>
          <button onClick={() => go('/skills?tag=automation')}>같은 화면 주소</button>
        </>
      );
    }
    const mountOpeners = (initial: string) => {
      const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      return render(
        <QueryClientProvider client={qc}>
          <MemoryRouter initialEntries={[initial]}>
            <AppProviders>
              <AppShell>
                <Openers />
              </AppShell>
            </AppProviders>
          </MemoryRouter>
        </QueryClientProvider>
      );
    };

    it('스킬 화면에서 연 서랍은 다른 화면으로 가면 닫힌다(남아서 새 화면 위에 보였다)', async () => {
      const user = userEvent.setup();
      mountOpeners('/skills');
      await user.click(screen.getByRole('button', { name: '임시 열기' }));
      expect(await screen.findByText('임시 본문')).toBeInTheDocument();
      fireEvent.click(screen.getByText('다른 화면'));
      await waitFor(() => expect(screen.queryByText('임시 본문')).not.toBeInTheDocument());
    });

    it('같은 화면 안에서 주소 값만 바뀌면(필터·탭) 서랍은 그대로다', async () => {
      const user = userEvent.setup();
      mountOpeners('/skills');
      await user.click(screen.getByRole('button', { name: '임시 열기' }));
      await screen.findByText('임시 본문');
      fireEvent.click(screen.getByText('같은 화면 주소'));
      expect(screen.getByText('임시 본문')).toBeInTheDocument();
    });

    it('keep 서랍(도움말처럼 화면을 옮겨도 보는 서랍)은 화면을 옮겨도 남는다', async () => {
      const user = userEvent.setup();
      mountOpeners('/skills');
      await user.click(screen.getByRole('button', { name: '고정 열기' }));
      await screen.findByText('고정 본문');
      fireEvent.click(screen.getByText('다른 화면'));
      expect(screen.getByText('고정 본문')).toBeInTheDocument();
    });
  });
});

// 공지 띠(스펙 2026-10-24-007 R2·6A·6B·E1·E4): 셸 배치 회귀와 숨은 읽기 영역
describe('AppShell 공지 띠', () => {
  const NOTICE = {
    id: 1, kind: 'outage', title: '로그인 장애', body: '', link: '', starts_at: '2026-10-24T00:00:00+00:00', ends_at: '2099-01-01T00:00:00+00:00',
    dismissible: false, updated_ts: 't', reshow_ts: 't',
  };
  let notices: unknown[] = [];
  beforeEach(() => {
    localStorage.clear();
    noticeStore.reset();
    notices = [];
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) => {
        const body = url.startsWith('/api/health') ? health : url.startsWith('/api/me') ? { user: { email: 'dana@corp.example' }, admin: true, auth_enabled: true, pods: [], notices } : {};
        return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
      })
    );
  });
  function mountWithQc() {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter>
          <AppProviders>
            <AppShell>
              <Where />
            </AppShell>
          </AppProviders>
        </MemoryRouter>
      </QueryClientProvider>
    );
    return qc;
  }

  it('공지가 없으면 띠가 없고 상단 막대가 맨 위다. 있으면 띠(aside 「공지」)가 상단 막대 앞에 있고 그 앞에 「본문으로 건너뛰기」가 있다', async () => {
    const qc = mountWithQc();
    await waitFor(() => expect(qc.getQueryData(['me'])).toBeTruthy());
    expect(screen.queryByRole('complementary', { name: '공지' })).toBeNull();
    const header = document.querySelector('header')!;
    const skip = screen.getByRole('button', { name: '본문으로 건너뛰기' });
    expect(skip.compareDocumentPosition(header) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    notices = [NOTICE];
    await act(() => qc.invalidateQueries({ queryKey: ['me'] }));
    const bar = await screen.findByRole('complementary', { name: '공지' });
    expect(bar.compareDocumentPosition(header) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(skip.compareDocumentPosition(bar) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // 본문 위가 아니라 화면 폭 전체(본문 main 밖)
    expect(document.getElementById('main')!.contains(bar)).toBe(false);

    fireEvent.click(skip);
    expect(document.activeElement).toBe(document.getElementById('main'));
  });

  it('숨은 읽기 영역은 늘 있고, 처음 받은 목록은 읽지 않으며 0 → 1 로 장애 공지가 생기면 alert 영역이 읽는다', async () => {
    const qc = mountWithQc();
    await waitFor(() => expect(qc.getQueryData(['me'])).toBeTruthy());
    const alert = document.querySelector('[data-notice-live="alert"]')!;
    const status = document.querySelector('[data-notice-live="status"]')!;
    expect(alert).toHaveAttribute('role', 'alert');
    expect(status).toHaveAttribute('role', 'status');
    expect(alert.textContent).toBe('');

    notices = [NOTICE];
    await act(() => qc.invalidateQueries({ queryKey: ['me'] }));
    await waitFor(() => expect(alert.textContent).toBe('장애: 로그인 장애'));
    expect(status.textContent).toBe('');
  });
});

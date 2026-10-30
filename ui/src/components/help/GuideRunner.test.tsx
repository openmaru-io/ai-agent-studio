/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 따라하기 진행 카드(OMAI-1274 V2~V6·V9·V11~V16·V18·V20·V21·V24). 스펙 §9-5·§11-3
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ReactNode, useState } from 'react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { closeChat, openChat } from '@/lib/chatPopup';
import { guideRunState, resetGuideRunForTest, setGuideStep, startGuide } from '@/lib/guideRun';
import type { Guide } from '@/lib/guides';

import { AppProviders } from '../AppProviders';
import { DrawerHost } from '../DrawerHost';
import { useUi } from '../UiContext';
import { findSpot, GuideHint, GuideRunner } from './GuideRunner';

// 목록 서랍(open) 단계가 있는 가이드는 아직 없다. 있는 가이드의 단계만 바꿔 끼워 도착 판단을 본다(스펙 2026-10-28-014 외부 검토 L3)
let override: Guide | null = null;
vi.mock('@/lib/guides', async (orig) => {
  const real = await orig<typeof import('@/lib/guides')>();
  return { ...real, guideById: (id: string | null | undefined) => (override && id === override.id ? override : real.guideById(id)) };
});

let ui: ReturnType<typeof useUi>;
function Grab() {
  ui = useUi();
  return null;
}
function Where() {
  const loc = useLocation();
  return <div data-testid="where">{loc.pathname + loc.search}</div>;
}

interface Opts {
  admin?: boolean;
  primary?: { profile: string; ready: boolean } | null;
  profile?: object;
  children?: ReactNode;
}

function mount(path: string, o: Opts = {}) {
  const admin = o.admin ?? true;
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string) => {
      const body = url.startsWith('/api/me')
        ? { auth_enabled: true, user: { email: 'kim@x' }, admin, owner: true, pods: [], primary: o.primary === undefined ? { profile: 'ma', ready: true } : o.primary }
        : url.startsWith('/api/profile')
        ? o.profile ?? { profile: { name: 'ma' }, caps: { model: { can: true, reason: '' } } }
        : {};
      return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
    })
  );
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>
        <AppProviders>
          <Grab />
          <Where />
          {o.children}
          <DrawerHost />
          <GuideRunner who={{ admin, owner: true }} mainLeft={240} />
        </AppProviders>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

const where = () => screen.getByTestId('where').textContent;
const card = () => screen.findByRole('region', { name: /^가이드:/ });
/** 진행 상태의 사용자가 정해진 뒤(useMe 응답) 시작한다 */
const start = async (id: string, step = 0) => {
  await waitFor(() => expect(guideRunState().user).toBe('kim@x'));
  act(() => startGuide(id, step));
};

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  resetGuideRunForTest();
  closeChat();
  document.documentElement.style.removeProperty('--aas-guide-offset');
});
// vi.restoreAllMocks 는 쓰지 않는다: 시험 설정(src/test/setup.ts)의 matchMedia mock 구현까지 지운다
afterEach(() => {
  closeChat();
  override = null;
});

describe('진행 카드', () => {
  it('따라하기를 시작하면 1단계 화면을 열고 단계 제목·설명을 보이며 라이브 영역이 읽는다(V15)', async () => {
    mount('/dashboard');
    await start('user.my-agents');
    await waitFor(() => expect(where()).toBe('/agents'));
    const c = await card();
    expect(within(c).getByRole('heading', { name: 'AI 에이전트 작업공간 목록 보기' })).toBeInTheDocument();
    expect(within(c).getByText('내 AI 에이전트 작업공간 확인하고 하나 더 만들기')).toBeInTheDocument();
    expect(c.querySelector('[data-guide-count]')).toHaveTextContent('1/2');
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('1/2단계, AI 에이전트 작업공간 목록 보기'));
  });

  it('V2·V3 다른 화면으로 가기 전에 쌓인 서랍의 저장 확인을 거친다: 거절하면 머물고, 승인하면 옮긴다', async () => {
    const user = userEvent.setup();
    let allow = false;
    const guard = vi.fn(async () => allow);
    mount('/dashboard');
    act(() => {
      ui.openDrawer({ id: 'edit', keep: true, title: '편집 중', body: <p>body</p> });
      ui.setCloseGuard('edit', guard);
    });
    await start('user.my-agents');
    await waitFor(() => expect(guard).toHaveBeenCalled());
    expect(where()).toBe('/dashboard');
    expect(screen.getByRole('dialog', { name: '편집 중' })).toBeInTheDocument();
    allow = true;
    await user.click(within(await card()).getByRole('button', { name: '이 화면 열기' }));
    await waitFor(() => expect(where()).toBe('/agents'));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '편집 중' })).toBeNull());
  });

  it('「이 화면 열기」가 보이면 「AI에게 묻기」는 아이콘만 두어 발 단추가 카드 폭 안에 든다', async () => {
    const user = userEvent.setup();
    let allow = false;
    mount('/dashboard');
    act(() => {
      ui.openDrawer({ id: 'edit', keep: true, title: '편집 중', body: <p>body</p> });
      ui.setCloseGuard('edit', async () => allow);
    });
    await start('user.my-agents');
    const c = await card();
    const open = await within(c).findByRole('button', { name: '이 화면 열기' });
    expect(within(c).getByRole('button', { name: 'AI에게 묻기' })).not.toHaveTextContent('AI에게 묻기');
    allow = true;
    await user.click(open);
    await waitFor(() => expect(where()).toBe('/agents'));
    await waitFor(() => expect(within(c).getByRole('button', { name: 'AI에게 묻기' })).toHaveTextContent('AI에게 묻기'));
  });

  it('V13 같은 프로파일 서랍의 다른 탭이면 서랍을 닫지 않고 저장 확인 뒤 탭만 바꾼다', async () => {
    const guard = vi.fn(async () => true);
    mount('/profiles?name=ma&pane=soul');
    act(() => {
      ui.openDrawer({ id: 'route:name', keep: true, title: 'ma', body: <p>detail</p> });
      ui.setCloseGuard('route:name', guard);
    });
    await start('admin.change-model');
    await waitFor(() => expect(where()).toBe('/profiles?name=ma'));
    expect(guard).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('dialog', { name: 'ma' })).toBeInTheDocument();
  });

  // 스펙 2026-10-26-003 외부 검토 H4: 서랍 안에서 다른 페이지로 옮겼으면 주소가 같아도 도착이 아니다. 저장 확인 뒤 첫 페이지로 되돌린다
  it('프로파일 서랍 안에서 다른 페이지로 옮긴 뒤 가이드 단계는 그 서랍을 첫 페이지로 되돌린다', async () => {
    const guard = vi.fn(async () => true);
    mount('/profiles?name=ma');
    act(() => void ui.openDrawer({ id: 'route:name', keep: true, title: 'ma', body: <p>detail</p> }));
    await act(() => ui.navigateDrawer({ kind: 'skill', id: 'ma:report' }));
    expect(ui.drawer?.history?.index).toBe(1);
    act(() => ui.setCloseGuard('route:name', guard));
    await start('admin.change-model');
    await waitFor(() => expect(ui.drawer?.history?.index).toBe(0));
    expect(guard).toHaveBeenCalledTimes(1);
    expect(screen.getByText('detail')).toBeInTheDocument();
    expect(where()).toBe('/profiles?name=ma');
  });

  // 스펙 2026-10-28-014 외부 검토 L3: 목록 서랍(route:open)도 첫 페이지일 때만 도착이고, 가이드 단계는 그 서랍을 첫 페이지로 되돌린다
  it('목록 서랍(open) 단계: 서랍 안에서 다른 페이지로 옮겼으면 첫 페이지로 되돌린 뒤에 강조한다', async () => {
    const at = { view: 'skills', params: { open: 'ma:report' } };
    override = { id: 'user.my-agents', audience: 'user', group: 'start', views: ['skills'], steps: [{ id: 'list', to: at }, { id: 'create', to: at, spot: 'agents.create' }] };
    const guard = vi.fn(async () => true);
    mount('/skills?open=ma:report', { children: <button data-guide="agents.create">만들기</button> });
    act(() => void ui.openDrawer({ id: 'route:open', keep: true, title: 'report', body: <p>detail</p> }));
    await act(() => ui.navigateDrawer({ kind: 'skill', id: 'ma:other' }));
    expect(ui.drawer?.history?.index).toBe(1);
    act(() => ui.setCloseGuard('route:open', guard));
    await start('user.my-agents', 1);
    await waitFor(() => expect(ui.drawer?.history?.index).toBe(0));
    expect(guard).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.getByRole('button', { name: '만들기', hidden: true })).toHaveAttribute('data-guide-active'));
    expect(where()).toBe('/skills?open=ma:report');
  });

  it('목록 서랍(open) 단계: 그 서랍이 다른 페이지를 보이는 동안은 도착이 아니라 강조하지 않는다', async () => {
    const at = { view: 'skills', params: { open: 'ma:report' } };
    override = { id: 'user.my-agents', audience: 'user', group: 'start', views: ['skills'], steps: [{ id: 'list', to: at }, { id: 'create', to: at, spot: 'agents.create' }] };
    mount('/skills?open=ma:report', { children: <button data-guide="agents.create">만들기</button> });
    act(() => void ui.openDrawer({ id: 'route:open', keep: true, title: 'report', body: <p>detail</p> }));
    await act(() => ui.navigateDrawer({ kind: 'skill', id: 'ma:other' }));
    act(() => ui.setCloseGuard('route:open', async () => false)); // 첫 페이지로 되돌리기를 거절
    await start('user.my-agents', 1);
    await within(await card()).findByRole('heading', { name: 'AI 에이전트 작업공간 만들기' });
    expect(ui.drawer?.history?.index).toBe(1);
    expect(screen.getByRole('button', { name: '만들기', hidden: true })).not.toHaveAttribute('data-guide-active');
  });

  it('V4 주 에이전트가 없거나 준비 중이면 옮기지 않고 안내만 보인다', async () => {
    mount('/dashboard', { primary: { profile: 'ma', ready: false } });
    await start('user.change-soul');
    expect(await within(await card()).findByText('AI 에이전트 작업공간이 준비되면 다시 시도하세요.')).toBeInTheDocument();
    expect(where()).toBe('/dashboard');
  });

  it('V12 서버 caps 가 막은 단계는 이유 문장을 보이고 강조하지 않는다', async () => {
    mount('/profiles?name=ma', {
      admin: false,
      profile: { profile: { name: 'ma' }, caps: { model: { can: false, reason: 'admin_only_model' } } },
      children: <div data-guide="profiles.model">model</div>,
    });
    await start('admin.change-model', 1);
    expect(await within(await card()).findByText(/모델은 관리자만 바꿉니다/)).toBeInTheDocument();
    expect(screen.getByText('model')).not.toHaveAttribute('data-guide-active');
  });

  it('V21·D11 주소가 단계와 같아지면 강조하고, 카드 제목이 그 칸을 가리킨다. 칸을 누르면 강조가 사라진다', async () => {
    const user = userEvent.setup();
    mount('/agents', { children: <button data-guide="agents.create">만들기</button> });
    await start('user.my-agents', 1);
    const btn = screen.getByRole('button', { name: '만들기' });
    await waitFor(() => expect(btn).toHaveAttribute('data-guide-active', 'out'));
    const title = within(await card()).getByRole('heading', { name: 'AI 에이전트 작업공간 만들기' });
    expect(title).toHaveAttribute('aria-describedby', btn.id);
    await user.click(btn);
    expect(btn).not.toHaveAttribute('data-guide-active');
  });

  // 프로파일 서랍은 데이터를 받은 뒤 본문을 다시 만든다(openDrawer 가 새 key 를 붙임). 강조가 옛 요소와 함께 사라지면 안 된다
  it('강조한 칸이 다시 그려져도 새 요소에 강조를 다시 붙인다', async () => {
    let remount: () => void = () => {};
    function Spot() {
      const [k, setK] = useState(0);
      remount = () => setK((n) => n + 1);
      return (
        <button key={k} data-guide="agents.create">
          만들기
        </button>
      );
    }
    mount('/agents', { children: <Spot /> });
    await start('user.my-agents', 1);
    await waitFor(() => expect(screen.getByRole('button', { name: '만들기' })).toHaveAttribute('data-guide-active'));
    act(() => remount());
    await waitFor(() => expect(screen.getByRole('button', { name: '만들기' })).toHaveAttribute('data-guide-active'));
  });

  it('V14 가려진 서랍(hidden) 안의 같은 칸은 고르지 않는다', () => {
    render(
      <>
        <div hidden>
          <span data-guide="x.y">hidden</span>
        </div>
        <span data-guide="x.y">shown</span>
      </>
    );
    expect(findSpot('x.y')?.textContent).toBe('shown');
  });

  it('V6 강조할 칸이 3초 안에 없으면 설명만 보이고 찾지 못했다고 알린다', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mount('/agents');
    await start('user.my-agents', 1);
    expect(await within(await card()).findByText(/칸을 찾지 못했습니다/, {}, { timeout: 5000 })).toBeInTheDocument();
    warn.mockRestore();
  }, 10000);

  it('V9·D10 대화 팝업이 열리면 카드를 본문 왼쪽 아래 알약으로 접고, 닫히면 다시 편다', async () => {
    mount('/agents');
    await start('user.my-agents');
    await card();
    act(() => openChat({ kind: 'office', alias: 'a', title: 'A' }));
    const pill = await screen.findByRole('button', { name: /가이드 카드 펴기/ });
    expect(pill).toHaveStyle({ left: '264px' });
    expect(screen.queryByRole('region', { name: /^가이드:/ })).toBeNull();
    act(() => closeChat());
    expect(await card()).toBeInTheDocument();
  });

  it('V18 좁은 화면에서 대화 팝업이 펴져 있으면 카드·알약을 그리지 않는다', async () => {
    const mm = window.matchMedia;
    window.matchMedia = vi.fn().mockImplementation((q: string) => ({
      matches: q.includes('max-width'),
      media: q,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));
    try {
      mount('/agents');
      await start('user.my-agents');
      await card();
      act(() => openChat({ kind: 'office', alias: 'a', title: 'A' }));
      await waitFor(() => expect(screen.queryByRole('region', { name: /^가이드:/ })).toBeNull());
      expect(screen.queryByRole('button', { name: /가이드 카드 펴기/ })).toBeNull();
    } finally {
      window.matchMedia = mm;
    }
  });

  it('V20 화면을 옮기는 동안(저장 확인 대기)에는 「다음」을 누를 수 없다', async () => {
    let release: (v: boolean) => void = () => {};
    mount('/dashboard');
    act(() => {
      ui.openDrawer({ id: 'edit', keep: true, title: '편집 중', body: <p>body</p> });
      ui.setCloseGuard('edit', () => new Promise<boolean>((r) => (release = r)));
    });
    await start('user.my-agents');
    const next = within(await card()).getByRole('button', { name: '다음' });
    await waitFor(() => expect(next).toBeDisabled());
    await act(async () => release(true));
    await waitFor(() => expect(where()).toBe('/agents'));
    await waitFor(() => expect(within(screen.getByRole('region', { name: /^가이드:/ })).getByRole('button', { name: '다음' })).toBeEnabled());
  });

  it('V24 마지막 단계에서 「끝냄」을 누르면 완료 카드와 다음 추천 가이드를 보인다', async () => {
    const user = userEvent.setup();
    mount('/agents', { children: <button data-guide="agents.create">만들기</button> });
    await start('user.my-agents', 1);
    await user.click(within(await card()).getByRole('button', { name: '끝냄' }));
    const done = await card();
    expect(within(done).getByRole('heading', { name: '다 했습니다' })).toBeInTheDocument();
    expect(within(done).getByRole('button', { name: /다음 추천: AI 에이전트와 첫 대화하기/ })).toBeInTheDocument();
    await user.click(within(done).getByRole('button', { name: '닫기' }));
    await waitFor(() => expect(screen.queryByRole('region', { name: /^가이드:/ })).toBeNull());
  });

  it('V11·9A 서랍이 열려 있어도 카드는 화면 읽기에서 가려지지 않는다', async () => {
    mount('/agents');
    act(() => ui.openDrawer({ title: '상세', body: <p>x</p> }));
    await start('user.my-agents');
    const c = await card();
    await waitFor(() => expect(c.closest('[aria-hidden="true"]')).toBeNull());
  });

  it('V16 서랍이 닫혀 있으면 카드 높이만큼 알림 자리를 올리고, 카드가 없으면 지운다', async () => {
    mount('/agents');
    await start('user.my-agents');
    await card();
    await waitFor(() => expect(document.documentElement.style.getPropertyValue('--aas-guide-offset')).not.toBe(''));
    act(() => setGuideStep(0));
    act(() => resetGuideRunForTest());
    await waitFor(() => expect(document.documentElement.style.getPropertyValue('--aas-guide-offset')).toBe(''));
  });

  // T4 (다): 그 자리에서 가이드를 바로 시작한다. 지금 화면과 맞는 첫 단계부터
  it('GuideHint 는 지금 화면과 맞는 단계부터 가이드를 시작한다', async () => {
    const user = userEvent.setup();
    mount('/cron', { children: <GuideHint guide="user.cron" /> });
    await waitFor(() => expect(guideRunState().user).toBe('kim@x'));
    await user.click(screen.getByRole('button', { name: '정해진 시각에 일 시키기(예약 작업) 따라하기' }));
    expect(guideRunState().run).toMatchObject({ id: 'user.cron', step: 2 });
    expect(where()).toBe('/cron');
  });

  it('GuideHint 의 관리자 가이드는 관리자가 아니면 그리지 않는다', async () => {
    mount('/agents', { admin: false, children: <GuideHint guide="admin.agent-limit" /> });
    await waitFor(() => expect(guideRunState().user).toBe('kim@x'));
    expect(screen.queryByRole('button', { name: /따라하기$/ })).toBeNull();
  });
});

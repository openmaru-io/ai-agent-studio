/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 도움말 서랍(OMAI-1274 V1·V10, 디자인 리뷰 1A·3A·8A·14A)
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { finishGuide, guideRunState, pauseGuide, resetGuideRunForTest, setGuideStep, setGuideUser, startGuide } from '@/lib/guideRun';

import { HelpDrawer } from './HelpDrawer';

function mount(path: string, admin: boolean, onStart = vi.fn()) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>
        <HelpDrawer who={{ admin, owner: true }} onStart={onStart} />
      </MemoryRouter>
    </QueryClientProvider>
  );
  return onStart;
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  resetGuideRunForTest();
  setGuideUser('kim@x');
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response('{}', { status: 200 }))));
});

describe('도움말 서랍', () => {
  it('V10 관리자가 아니면 「관리자 가이드」 탭이 없고, 관리자는 있다', async () => {
    mount('/dashboard', false);
    expect(screen.getByRole('tab', { name: '사용자 가이드' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.queryByRole('tab', { name: '관리자 가이드' })).toBeNull();
    expect(screen.getByRole('tab', { name: '단축키' })).toBeInTheDocument();
  });

  it('V10 관리자는 「관리자 가이드」 탭에서 관리자 가이드를 보고, 고른 탭을 기억한다', async () => {
    const user = userEvent.setup();
    mount('/dashboard', true);
    await user.click(screen.getByRole('tab', { name: '관리자 가이드' }));
    expect(screen.getByText('AI 에이전트의 주 모델 바꾸기')).toBeInTheDocument();
    expect(screen.queryByText('AI 에이전트와 첫 대화하기')).toBeNull();
    expect(localStorage.getItem('aas-guide-tab:kim@x')).toBe('admin');
  });

  it('1A 맨 위는 「이 화면에서 할 수 있는 일」이고, 그 가이드는 아래 주제 묶음에 다시 나오지 않는다', () => {
    mount('/profiles', false);
    const heads = screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent);
    expect(heads[0]).toBe('이 화면에서 할 수 있는 일');
    expect(screen.getAllByText('AI 에이전트 성격(SOUL) 바꾸기')).toHaveLength(1);
    expect(heads).toContain('시작하기');
  });

  it('14A 검색은 제목·설명만 찾고, 관리자는 관리자 가이드도 함께 찾아 표시를 붙인다', async () => {
    const user = userEvent.setup();
    mount('/dashboard', true);
    await user.type(screen.getByRole('searchbox', { name: '가이드 검색' }), '주 모델');
    expect(screen.getByText('AI 에이전트의 주 모델 바꾸기')).toBeInTheDocument();
    expect(screen.getByText('관리자')).toBeInTheDocument();
    expect(screen.queryByRole('tab')).toBeNull();
  });

  it('검색 결과가 없으면 빈 상태와 AI에게 묻기 단추를 보인다', async () => {
    const user = userEvent.setup();
    mount('/dashboard', false);
    await user.type(screen.getByRole('searchbox', { name: '가이드 검색' }), 'zzzz');
    expect(screen.getByText("'zzzz' 에 맞는 가이드가 없습니다")).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'AI에게 묻기' })).toBeInTheDocument();
  });

  it('8A 가이드를 누르면 단계를 보이고 「따라하기 시작」이 그 가이드를 시작한다. 「가이드 목록」으로 돌아간다', async () => {
    const user = userEvent.setup();
    const onStart = mount('/dashboard', false);
    await user.click(screen.getByText('내 AI 에이전트 작업공간 확인하고 하나 더 만들기'));
    // 상세는 무엇에 쓰는지·언제 필요한지·어떻게 하는지(단계 제목과 설명)를 사용자 말로 보인다
    expect(screen.getByRole('heading', { name: '무엇에 쓰나요' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '언제 필요한가요' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '어떻게 하나요' })).toBeInTheDocument();
    // 세 제목 앞에는 읽지 않는 아이콘이 있다
    for (const name of ['무엇에 쓰나요', '언제 필요한가요', '어떻게 하나요'])
      expect(screen.getByRole('heading', { name }).querySelector('svg[aria-hidden="true"]'), name).not.toBeNull();
    const steps = screen.getByRole('list');
    const items = within(steps).getAllByRole('listitem');
    expect(items.map((li) => li.querySelector('[data-step-title]')?.textContent)).toEqual(['AI 에이전트 작업공간 목록 보기', 'AI 에이전트 작업공간 만들기']);
    expect(items[1]).toHaveTextContent('제목 옆 + 버튼(AI 에이전트 작업공간 만들기)을 누르고');
    await user.click(screen.getByRole('button', { name: '따라하기 시작' }));
    expect(onStart).toHaveBeenCalledWith('user.my-agents');
    await user.click(screen.getByRole('button', { name: '가이드 목록' }));
    expect(screen.getByRole('tab', { name: '사용자 가이드' })).toBeInTheDocument();
  });

  it('3A 멈춘 가이드는 맨 위 「이어서 하기」로 같은 단계부터 다시 시작하고, 목록에는 진행 중으로 보인다', async () => {
    const user = userEvent.setup();
    startGuide('user.first-chat');
    setGuideStep(1);
    pauseGuide();
    mount('/dashboard', false);
    const row = screen.getByRole('button', { name: /이어서 하기: AI 에이전트와 첫 대화하기 2\/3/ });
    expect(screen.getAllByText('진행 중').length).toBeGreaterThan(0);
    await user.click(row);
    expect(guideRunState().run).toMatchObject({ id: 'user.first-chat', step: 1 });
  });

  it('끝낸 가이드는 「끝냄」으로 보인다', () => {
    startGuide('user.my-agents');
    finishGuide();
    mount('/dashboard', false);
    expect(screen.getByText('끝냄')).toBeInTheDocument();
  });
});

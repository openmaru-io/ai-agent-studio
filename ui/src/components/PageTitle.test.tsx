/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';

import { setHelpOpener } from '@/lib/guideRun';
import { VIEWS } from '@/lib/views';

import { PageTitle, VIEW_ICONS } from './PageTitle';

const at = (path: string, title = '제목') =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <PageTitle>{title}</PageTitle>
    </MemoryRouter>
  );

describe('PageTitle(본문 제목 앞 아이콘)', () => {
  it('지금 주소의 화면 아이콘을 제목 앞에 그리고, 아이콘은 읽는 이름에 섞이지 않는다', () => {
    at('/cron', 'Cron 작업');
    const h = screen.getByRole('heading', { level: 1, name: 'Cron 작업' });
    const svg = h.querySelector('svg') as SVGElement;
    expect(svg).toHaveAttribute('data-testid', 'ScheduleOutlinedIcon');
    expect(svg).toHaveAttribute('aria-hidden', 'true');
    expect(h.firstElementChild).toBe(svg); // 제목 글자보다 앞
  });

  it('모든 화면에 아이콘이 있고, 화면마다 다르다', () => {
    for (const v of VIEWS) expect(VIEW_ICONS[v.id], v.id).toBeDefined();
    expect(new Set(VIEWS.map((v) => VIEW_ICONS[v.id])).size).toBe(VIEWS.length);
  });

  it('주소의 쿼리는 무시하고, 모르는 주소면 아이콘 없이 제목만 그린다', () => {
    const { unmount } = at('/credentials?tab=all');
    expect(screen.getByRole('heading', { level: 1 }).querySelector('svg')).toHaveAttribute('data-testid', 'VpnKeyOutlinedIcon');
    unmount();
    at('/nowhere');
    expect(screen.getByRole('heading', { level: 1, name: '제목' }).querySelector('svg')).toBeNull();
  });
});

describe('PageTitle context(회사 맥락)', () => {
  it('맥락은 이름 앞의 작은 보조 글자와 화살표 아이콘으로 보이고, 읽는 이름은 「맥락 > 이름」이다', () => {
    render(
      <MemoryRouter initialEntries={['/office']}>
        <PageTitle context="오픈마루">OPENMARU 오피스</PageTitle>
      </MemoryRouter>
    );
    const h = screen.getByRole('heading', { level: 1 });
    expect(h).toHaveAccessibleName('오픈마루 > OPENMARU 오피스');
    const ctx = screen.getByText('오픈마루');
    expect(ctx).toHaveAttribute('data-title-context');
    expect(h.querySelector('[data-testid="ChevronRightRoundedIcon"]')).toHaveAttribute('aria-hidden', 'true'); // 화살표는 읽지 않는다
    expect(h.textContent).not.toContain('>'.repeat(2));
  });
  it('맥락이 없으면 옛 모양 그대로(화살표·보조 글자 없음)', () => {
    render(
      <MemoryRouter initialEntries={['/office']}>
        <PageTitle>오피스</PageTitle>
      </MemoryRouter>
    );
    const h = screen.getByRole('heading', { level: 1, name: '오피스' });
    expect(h.querySelector('[data-title-context]')).toBeNull();
    expect(h.querySelector('[data-testid="ChevronRightRoundedIcon"]')).toBeNull();
  });

  // OMAI-1274 §4-2 (나)·디자인 리뷰 12A: [제목][추가][도움말], 도움말은 h1 밖이고 이 화면의 가이드가 있을 때만
  it('셸이 도움말 서랍을 등록했고 이 화면의 가이드가 있으면, 추가 단추 뒤에 「이 화면 도움말」을 h1 밖에 둔다', () => {
    const opener = vi.fn();
    setHelpOpener(opener);
    try {
      const qc = new QueryClient();
      render(
        <QueryClientProvider client={qc}>
          <MemoryRouter initialEntries={['/agents']}>
            <PageTitle action={<button type="button">추가</button>}>에이전트</PageTitle>
          </MemoryRouter>
        </QueryClientProvider>
      );
      const h1 = screen.getByRole('heading', { level: 1 });
      const help = screen.getByRole('button', { name: '이 화면 도움말' });
      expect(h1).not.toContainElement(help);
      expect(h1).toHaveAccessibleName('에이전트');
      const add = screen.getByRole('button', { name: '추가' });
      expect(add.compareDocumentPosition(help) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      fireEvent.click(help);
      expect(opener).toHaveBeenCalled();
    } finally {
      setHelpOpener(null);
    }
  });

  it('셸 밖이거나 이 화면의 가이드가 없으면 도움말 단추가 없다', () => {
    const qc = new QueryClient();
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={['/agents']}>
          <PageTitle>에이전트</PageTitle>
        </MemoryRouter>
      </QueryClientProvider>
    );
    expect(screen.queryByRole('button', { name: '이 화면 도움말' })).toBeNull();
    setHelpOpener(() => {});
    try {
      render(
        <QueryClientProvider client={qc}>
          <MemoryRouter initialEntries={['/connections']}>
            <PageTitle>연결</PageTitle>
          </MemoryRouter>
        </QueryClientProvider>
      );
      expect(screen.queryByRole('button', { name: '이 화면 도움말' })).toBeNull();
    } finally {
      setHelpOpener(null);
    }
  });
});

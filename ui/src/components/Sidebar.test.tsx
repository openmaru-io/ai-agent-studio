/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';

import { Sidebar } from '@/components/Sidebar';
import type { MenuGroup } from '@/lib/menu';

const groups = [{ id: 'dashboard', label: '대시보드', items: [{ id: 'dashboard', label: '대시보드' }] }] as unknown as MenuGroup[];

const mount = (collapsed: boolean, onToggleCollapse?: () => void) =>
  render(
    <MemoryRouter>
      <Sidebar groups={groups} currentView="dashboard" currentGroup="dashboard" collapsed={collapsed} onToggleCollapse={onToggleCollapse} />
    </MemoryRouter>,
  );

describe('Sidebar 배지 설명(스펙 2026-11-02-001)', () => {
  it('배지에 설명(hint)이 있으면 그 문구를 접근 이름으로 쓴다 — 무엇의 건수인지 알 수 있게', () => {
    const g = [
      { id: 'agent', label: '내 AI 에이전트', badge: 1, tone: 'warn', hint: '처리 대기 1건', items: [{ id: 'profiles', label: '프로파일', badge: 1, tone: 'warn', hint: '처리 대기 1건' }, { id: 'agents', label: 'AI 에이전트 작업공간' }] },
    ] as unknown as MenuGroup[];
    render(
      <MemoryRouter>
        <Sidebar groups={g} currentView="profiles" currentGroup={'agent' as MenuGroup['id']} collapsed={false} />
      </MemoryRouter>,
    );
    expect(screen.getAllByLabelText('처리 대기 1건')).toHaveLength(2);
  });

  it('설명이 없으면 지금처럼 「N건」', () => {
    const g = [{ id: 'automation', label: '자동화', badge: 3, tone: 'bad', items: [{ id: 'cron', label: '예약 작업', badge: 3, tone: 'bad' }, { id: 'channels', label: '채널' }] }] as unknown as MenuGroup[];
    render(
      <MemoryRouter>
        <Sidebar groups={g} currentView="cron" currentGroup={'automation' as MenuGroup['id']} collapsed={false} />
      </MemoryRouter>,
    );
    expect(screen.getAllByLabelText('3건')).toHaveLength(2);
  });
});

describe('Sidebar 아래 줄(버전·메뉴 접기)', () => {
  it('펼친 메뉴에서는 버전 옆 「<」 단추가 메뉴를 접는다', () => {
    const toggle = vi.fn();
    mount(false, toggle);
    fireEvent.click(screen.getByRole('button', { name: '사이드바 접기' }));
    expect(toggle).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('ChevronLeftIcon')).toBeInTheDocument();
  });

  it('접힌 메뉴에서는 「>」 단추가 메뉴를 펼친다', () => {
    const toggle = vi.fn();
    mount(true, toggle);
    fireEvent.click(screen.getByRole('button', { name: '사이드바 펼치기' }));
    expect(toggle).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('ChevronRightIcon')).toBeInTheDocument();
  });

  it('접기 함수를 주지 않으면(모바일 서랍) 단추가 없다', () => {
    mount(false);
    expect(screen.queryByRole('button', { name: '사이드바 접기' })).toBeNull();
  });
});

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

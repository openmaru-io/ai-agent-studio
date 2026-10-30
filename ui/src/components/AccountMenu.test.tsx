/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { AccountMenu, AccountMenuProps } from './AccountMenu';

const ME = {
  user: { email: 'dana@corp.example', name: '이서연' },
  admin: true,
  auth_enabled: true,
  pod: { id: 'one', owner: 'kim' },
  pods: [{ id: 'one', owner: 'kim' }],
} as AccountMenuProps['me'];

function mount(over: Partial<AccountMenuProps> = {}) {
  const fns = { onClose: vi.fn(), onProfile: vi.fn(), onUsers: vi.fn(), onShortcuts: vi.fn(), onPod: vi.fn() };
  render(<AccountMenu anchorEl={document.body} me={ME} showUsers {...fns} {...over} />);
  return fns;
}

describe('AccountMenu (OMAI-1267)', () => {
  it('공지가 있으면 「지금 공지 N」이 있고 누르면 처리기가 불린다. 0개면 숨긴다(스펙 2026-10-24-007 3D)', () => {
    const onNotices = vi.fn();
    mount({ notices: 2, onNotices });
    fireEvent.click(screen.getByRole('menuitem', { name: '지금 공지 2' }));
    expect(onNotices).toHaveBeenCalled();
  });

  it('공지가 0개면 「지금 공지」 줄이 없다', () => {
    mount({ notices: 0, onNotices: vi.fn() });
    expect(screen.queryByRole('menuitem', { name: /지금 공지/ })).toBeNull();
  });

  it('머리에 이름·이메일·관리자 알약이 있고, 새로 고침은 없다(상단 막대 단추로 충분하다)', () => {
    mount();
    const menu = screen.getByRole('menu');
    expect(within(menu).getByText('이서연')).toBeInTheDocument();
    expect(within(menu).getByText('dana@corp.example')).toBeInTheDocument();
    expect(within(menu).getByText('관리자')).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: '새로 고침' })).toBeNull();
    for (const n of ['내 정보', '사용자·권한', '단축키']) expect(screen.getByRole('menuitem', { name: n })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: '로그아웃' })).toHaveAttribute('href', '/auth/logout');
  });

  it('이름이 없으면 이메일 앞부분을 이름으로 쓰고, 관리자가 아니면 알약과 「사용자·권한」이 없다', () => {
    mount({ me: { ...ME!, user: { email: 'lee@x.com' }, admin: false }, showUsers: false });
    const menu = screen.getByRole('menu');
    expect(within(menu).getByText('lee')).toBeInTheDocument();
    expect(within(menu).queryByText('관리자')).toBeNull();
    expect(screen.queryByRole('menuitem', { name: '사용자·권한' })).toBeNull();
  });

  it('항목을 누르면 맞는 처리기가 불리고 메뉴가 닫힌다', async () => {
    const user = userEvent.setup();
    const f = mount();
    await user.click(screen.getByRole('menuitem', { name: '내 정보' }));
    await user.click(screen.getByRole('menuitem', { name: '사용자·권한' }));
    await user.click(screen.getByRole('menuitem', { name: '단축키' }));
    expect(f.onProfile).toHaveBeenCalledTimes(1);
    expect(f.onUsers).toHaveBeenCalledTimes(1);
    expect(f.onShortcuts).toHaveBeenCalledTimes(1);
    expect(f.onClose.mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  it('에이전트가 둘 이상이면 「에이전트」 묶음에 고르는 항목이 나오고 지금 것에 체크가 선다. 하나면 묶음이 없다', async () => {
    const user = userEvent.setup();
    const f = mount({ me: { ...ME!, pods: [{ id: 'one', owner: 'kim' }, { id: 'two', owner: 'lee' }] } });
    const menu = screen.getByRole('menu');
    expect(within(menu).getByText('AI 에이전트 작업공간')).toBeInTheDocument();
    expect(screen.getByRole('menuitemradio', { name: 'AI 에이전트 작업공간 one' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('menuitemradio', { name: 'AI 에이전트 작업공간 two' })).toHaveAttribute('aria-checked', 'false');
    await user.click(screen.getByRole('menuitemradio', { name: 'AI 에이전트 작업공간 two' }));
    expect(f.onPod).toHaveBeenCalledWith('two');
  });

  it('남의 에이전트는 「주인 이름 · 에이전트 이름」, 내 것은 이름만 보이고 id 는 풍선말이다(스펙 2026-10-19-003)', () => {
    const pods = [
      { id: 'one', owner: 'dana@corp.example', owner_name: '이서연', name: '운영' },
      { id: 'two', owner: 'lee@x.com', owner_name: '이사용', name: '시험' },
    ];
    mount({ me: { ...ME!, pod: pods[0], pods } });
    expect(screen.getByRole('menuitemradio', { name: 'AI 에이전트 작업공간 운영' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('menuitemradio', { name: 'AI 에이전트 작업공간 이사용 · 시험' })).toBeInTheDocument();
    expect(screen.getByText('이사용 · 시험')).toHaveAttribute('title', 'two');
  });

  it('지금 에이전트 줄을 다시 누르면 메뉴만 닫고 바꾸지 않는다(스펙 2026-10-19-019 R9)', async () => {
    const user = userEvent.setup();
    const f = mount({ me: { ...ME!, pods: [{ id: 'one', owner: 'kim' }, { id: 'two', owner: 'lee' }] } });
    await user.click(screen.getByRole('menuitemradio', { name: 'AI 에이전트 작업공간 one' }));
    expect(f.onPod).not.toHaveBeenCalled();
    expect(f.onClose).toHaveBeenCalled();
  });

  it('넓은 화면(showAgents 거짓)이면 「에이전트」 묶음을 그리지 않는다 — CSS 로 숨기면 화살표 이동이 멈춘다(D1·R5)', () => {
    mount({ showAgents: false, me: { ...ME!, pods: [{ id: 'one', owner: 'kim' }, { id: 'two', owner: 'lee' }] } });
    expect(screen.queryByRole('menuitemradio')).toBeNull();
    expect(within(screen.getByRole('menu')).queryByText('AI 에이전트 작업공간')).toBeNull();
  });

  it('도움말 줄은 onHelp 를 넘길 때만 그린다(좁은 화면에서만, R6)', () => {
    const { unmount } = render(<AccountMenu anchorEl={document.body} me={ME} showUsers onClose={vi.fn()} onProfile={vi.fn()} onUsers={vi.fn()} onShortcuts={vi.fn()} onPod={vi.fn()} />);
    expect(screen.queryByRole('menuitem', { name: '도움말' })).toBeNull();
    unmount();
    mount({ onHelp: vi.fn() });
    expect(screen.getByRole('menuitem', { name: '도움말' })).toBeInTheDocument();
  });

  it('에이전트가 하나면 에이전트 묶음을 그리지 않는다', () => {
    mount();
    expect(screen.queryByRole('menuitemradio')).toBeNull();
  });

  it('지금 에이전트 줄이 없으면 열 때 첫 항목에 포커스가 가고 화살표로 「로그아웃」까지 간다(스펙 2026-10-19-019 §7)', async () => {
    // 머리(이니셜·이름)가 첫 자식이라 포커스가 메뉴 틀에 남아 화살표가 듣지 않았다
    const user = userEvent.setup();
    mount();
    await waitFor(() => expect(screen.getByRole('menuitem', { name: '내 정보' })).toHaveFocus());
    for (let i = 0; i < 3; i++) await user.keyboard('{ArrowDown}');
    expect(screen.getByRole('menuitem', { name: '로그아웃' })).toHaveFocus();
  });

  it('Esc 로 닫는다', () => {
    const f = mount();
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
    expect(f.onClose).toHaveBeenCalled();
  });
});

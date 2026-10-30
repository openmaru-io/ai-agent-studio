/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { mountScreen, postedTo, stubApi } from '@/test/mountScreen';

import { AccountDrawer } from './AccountDrawer';

const ME = (over: Record<string, unknown> = {}) => ({
  auth_enabled: true,
  admin: false,
  owner: true,
  user: { email: 'lee@x.com', name: '이몽룡' },
  department: '개발팀',
  pod: { id: 'a', owner: 'lee@x.com' },
  pods: [{ id: 'a', owner: 'lee@x.com' }, { id: 'b', owner: 'kim@x.com' }],
  own_pods: ['a'],
  account: { method: 'keycloak', can_change_password: true },
  ...over,
});

afterEach(() => vi.unstubAllGlobals());

const fill = async (user: ReturnType<typeof userEvent.setup>, cur: string, next: string, confirm: string) => {
  await user.type(await screen.findByLabelText('현재 비밀번호'), cur);
  await user.type(screen.getByLabelText('새 비밀번호'), next);
  await user.type(screen.getByLabelText('새 비밀번호 확인'), confirm);
};
const submit = () => screen.getByRole('button', { name: '비밀번호 변경' });

describe('내 정보 서랍', () => {
  it('「Claude Code 연결 n개 →」 한 줄은 그 화면으로 가고, 로그인을 끈 설치(connections 없음)에는 없다(스펙 2026-10-28-001 디자인 D4)', async () => {
    stubApi({ '/api/me': ME({ connections: { active: 3, expiring: 0 } }) });
    const { unmount } = mountScreen(<AccountDrawer />, '/dashboard');
    expect(await screen.findByRole('link', { name: '3개 →' })).toHaveAttribute('href', '#/connections');
    unmount();
    vi.unstubAllGlobals();
    stubApi({ '/api/me': ME({ connections: null }) });
    mountScreen(<AccountDrawer />, '/dashboard');
    expect(await screen.findByText('lee@x.com')).toBeInTheDocument();
    expect(screen.queryByText('Claude Code 연결')).toBeNull();
  });

  it('본인 정보를 읽기 전용으로 보인다', async () => {
    stubApi({ '/api/me': ME() });
    mountScreen(<AccountDrawer />, '/dashboard');
    expect(await screen.findByText('lee@x.com')).toBeInTheDocument();
    expect(screen.getByText('이몽룡')).toBeInTheDocument();
    expect(screen.getByText('개발팀')).toBeInTheDocument();
    expect(screen.getByText('AI 에이전트 작업공간 소유자')).toBeInTheDocument();
    expect(screen.getByText('a')).toBeInTheDocument();
    expect(screen.queryByText('a, b')).toBeNull();
    expect(screen.getByText('OIDC')).toBeInTheDocument();
  });

  it('관리자라도 내가 주인인 에이전트만 보인다(남의 에이전트는 빠진다, OMAI-1159)', async () => {
    stubApi({ '/api/me': ME({ admin: true, owner: false, user: { email: 'admin@x.com', name: '관리자' }, own_pods: [], pods: [{ id: 'a', owner: 'lee@x.com' }, { id: 'b', owner: 'kim@x.com' }] }) });
    mountScreen(<AccountDrawer />, '/dashboard');
    expect(await screen.findByText('없음')).toBeInTheDocument();
    expect(screen.queryByText(/a, b|\ba\b/)).toBeNull();
  });

  it('세 칸이 차고 새 비밀번호가 8자 이상이며 서로 같을 때만 단추가 켜진다', async () => {
    const user = userEvent.setup();
    stubApi({ '/api/me': ME() });
    mountScreen(<AccountDrawer />, '/dashboard');
    await fill(user, 'old-password', 'short', 'short');
    expect(submit()).toBeDisabled();
    expect(screen.getByText('8자 이상이어야 합니다')).toBeInTheDocument();
    await user.clear(screen.getByLabelText('새 비밀번호'));
    await user.clear(screen.getByLabelText('새 비밀번호 확인'));
    await user.type(screen.getByLabelText('새 비밀번호'), 'new-password-1');
    await user.type(screen.getByLabelText('새 비밀번호 확인'), 'new-password-2');
    expect(screen.getByText('새 비밀번호가 서로 다릅니다')).toBeInTheDocument();
    expect(submit()).toBeDisabled();
    await user.clear(screen.getByLabelText('새 비밀번호 확인'));
    await user.type(screen.getByLabelText('새 비밀번호 확인'), 'new-password-1');
    expect(submit()).toBeEnabled();
  });

  it('성공하면 현재·새 비밀번호를 서버로 보내고 입력칸을 비우며 다른 기기 로그인이 끝났다고 알린다', async () => {
    const user = userEvent.setup();
    const fn = stubApi({ '/api/me': ME(), '/api/users/me/password': { ok: true, other_sessions_ended: 2 } });
    mountScreen(<AccountDrawer />, '/dashboard');
    await fill(user, 'old-password', 'new-password-1', 'new-password-1');
    await user.click(submit());
    expect(await screen.findByText(/비밀번호를 바꿨습니다\. 다른 기기의 로그인은 끝났습니다\./)).toBeInTheDocument();
    expect(postedTo(fn, '/api/users/me/password')).toEqual([{ current: 'old-password', new: 'new-password-1' }]);
    expect(screen.getByLabelText('현재 비밀번호')).toHaveValue('');
    expect(screen.getByLabelText('새 비밀번호')).toHaveValue('');
    expect(screen.getByLabelText('새 비밀번호 확인')).toHaveValue('');
  });

  it('다른 세션이 없으면 앞 문장만 보인다', async () => {
    const user = userEvent.setup();
    stubApi({ '/api/me': ME(), '/api/users/me/password': { ok: true, other_sessions_ended: 0 } });
    mountScreen(<AccountDrawer />, '/dashboard');
    await fill(user, 'old-password', 'new-password-1', 'new-password-1');
    await user.click(submit());
    const ok = await screen.findByText(/비밀번호를 바꿨습니다\./);
    expect(ok.textContent).not.toContain('다른 기기');
  });

  it('현재 비밀번호가 틀리면(403) 그 칸에 알리고 비운 뒤 커서를 두며, 로그인 화면으로 보내지 않는다', async () => {
    const user = userEvent.setup();
    const toLogin = vi.fn();
    const { api } = await import('@/lib/api');
    api.toLogin = toLogin;
    const fn = vi.fn((url: string) =>
      Promise.resolve(
        url.startsWith('/api/users/me/password')
          ? new Response(JSON.stringify({ error: '현재 비밀번호가 맞지 않습니다', field: 'current', reason: 'wrong_password' }), { status: 403 })
          : new Response(JSON.stringify(ME()), { status: 200 })
      )
    );
    vi.stubGlobal('fetch', fn);
    mountScreen(<AccountDrawer />, '/dashboard');
    await fill(user, 'wrong-password', 'new-password-1', 'new-password-1');
    await user.click(submit());
    expect(await screen.findByText('현재 비밀번호가 맞지 않습니다')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByLabelText('현재 비밀번호')).toHaveFocus());
    expect(screen.getByLabelText('현재 비밀번호')).toHaveValue('');
    expect(screen.getByLabelText('새 비밀번호')).toHaveValue('new-password-1'); // 새 비밀번호는 남겨 다시 쓰지 않게 한다
    expect(toLogin).not.toHaveBeenCalled();
  });

  it('서버의 그 밖의 오류는 단추 위쪽 알림으로 보인다', async () => {
    const user = userEvent.setup();
    stubApi({ '/api/me': ME() });
    const fn = vi.fn((url: string) =>
      Promise.resolve(
        url.startsWith('/api/users/me/password')
          ? new Response(JSON.stringify({ error: 'Keycloak 에 연결할 수 없습니다', reason: 'unreachable' }), { status: 502 })
          : new Response(JSON.stringify(ME()), { status: 200 })
      )
    );
    vi.stubGlobal('fetch', fn);
    mountScreen(<AccountDrawer />, '/dashboard');
    await fill(user, 'old-password', 'new-password-1', 'new-password-1');
    await user.click(submit());
    expect(await screen.findByText(/비밀번호를 바꾸지 못했습니다: Keycloak 에 연결할 수 없습니다/)).toBeInTheDocument();
  });

  it('비밀번호를 바꿀 수 없는 로그인 방식이면 입력칸 대신 안내를 보인다', async () => {
    stubApi({ '/api/me': ME({ account: { method: 'none', can_change_password: false } }) });
    mountScreen(<AccountDrawer />, '/dashboard');
    expect(await screen.findByText(/이 로그인 방식에서는 AAS 에서 비밀번호를 바꿀 수 없습니다/)).toBeInTheDocument();
    expect(screen.queryByLabelText('현재 비밀번호')).not.toBeInTheDocument();
  });

  it('입력칸은 비밀번호 칸이고 브라우저에 현재·새 비밀번호를 구분해 알린다', async () => {
    stubApi({ '/api/me': ME() });
    mountScreen(<AccountDrawer />, '/dashboard');
    const cur = await screen.findByLabelText('현재 비밀번호');
    expect(cur).toHaveAttribute('type', 'password');
    expect(cur).toHaveAttribute('autocomplete', 'current-password');
    expect(screen.getByLabelText('새 비밀번호')).toHaveAttribute('autocomplete', 'new-password');
  });
});

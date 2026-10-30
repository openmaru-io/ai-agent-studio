/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { mountScreen, postedTo, stubApi } from '@/test/mountScreen';

import { ConnectionsTab } from './ConnectionsTab';

afterEach(() => vi.unstubAllGlobals());

const NOW = Date.now() / 1000;
const row = (over: Record<string, unknown>) => ({
  id: 't1',
  kind: 'pat',
  name: '빌드 서버',
  bundle: 'read',
  scopes: [],
  prefix: 'abcd',
  created: NOW - 100,
  expires: NOW + 30 * 86400,
  last_used: null,
  last_ip: '',
  state: 'active',
  ended: null,
  email: 'kim@x.com',
  ...over,
});

describe('사용자 관리 「Claude Code 연결」 탭(스펙 2026-10-28-001 디자인 D19)', () => {
  it('살아 있는 연결만 보이고, 사유를 적어야 강제로 끊는다', async () => {
    const user = userEvent.setup();
    const fn = stubApi({
      '/api/tokens/admin-revoke': { ok: true },
      '/api/tokens/all': { tokens: [row({}), row({ id: 'old', name: '옛 토큰', state: 'revoked' })] },
    });
    mountScreen(<ConnectionsTab />, '/users');
    expect(await screen.findByTestId('conn-admin-t1')).toHaveTextContent('kim@x.com');
    expect(screen.queryByText('옛 토큰')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'kim@x.com 의 빌드 서버 강제 끊기' }));
    const dlg = await screen.findByRole('dialog');
    const ok = within(dlg).getByRole('button', { name: '강제 끊기' });
    expect(ok).toBeDisabled();
    await user.type(within(dlg).getByRole('textbox', { name: '사유' }), '퇴사 정리');
    await user.click(ok);
    await waitFor(() => expect(postedTo(fn, '/api/tokens/admin-revoke')).toEqual([{ id: 't1', email: 'kim@x.com', reason: '퇴사 정리' }]));
  });

  it('연결이 없으면 안내', async () => {
    stubApi({ '/api/tokens/all': { tokens: [] } });
    mountScreen(<ConnectionsTab />, '/users');
    expect(await screen.findByText('아직 Claude Code 를 연결한 사람이 없습니다.')).toBeInTheDocument();
  });
});

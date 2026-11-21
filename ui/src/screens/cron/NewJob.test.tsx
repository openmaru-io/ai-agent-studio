/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 새 예약 작업의 「나에게(메신저 DM)」(스펙 2026-11-17-008 §6-3)
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { mountScreen, postedTo, stubApi } from '@/test/mountScreen';

import { NewJobBody } from './NewJob';

afterEach(() => vi.unstubAllGlobals());

const ME = { auth_enabled: true, admin: false, user: { email: 'lee@x.com', name: '이팀원' }, pod: { id: 'kim', owner: 'kim@x.com' } };
const LINKS = (profile: string) => ({
  pod: 'kim', can_link: true, owner_name: '김소유', restart_needed: [],
  bots: [{ profile: 'main', platform: 'telegram', state: 'connected', connected: true }],
  mine: [{ profile, platform: 'telegram', platform_user_id: '777', user_name: '@lee', dm_chat_id: '', ts: '' }],
});

function mount(profile = 'main') {
  return stubApi({
    '/api/messenger/links': LINKS(profile), // '/api/me' 보다 먼저 — 시험 대역은 앞부분 일치로 고른다
    '/api/me': ME,
    '/api/channels/platforms': new Response(JSON.stringify({ error: 'x' }), { status: 403 }),
    '/api/cron/action': { ok: true },
    '/api/explain': { text: '' },
  });
}

describe('예약 작업 결과를 나에게(메신저 DM)', () => {
  it('이 프로파일 봇에 내 계정을 이었으면 고를 수 있고, 서버가 대화방을 고르게 deliver_to=me 를 보낸다', async () => {
    const user = userEvent.setup();
    const fn = mount();
    mountScreen(<NewJobBody profiles={['main']} fixedProfile="main" onDone={() => {}} />, '/');
    const pick = screen.getByRole('combobox', { name: '결과 전달' });
    await waitFor(() => expect(screen.getByRole('option', { name: '나에게 (메신저 DM)' })).toBeInTheDocument());
    await user.selectOptions(pick, '@me');
    await user.type(screen.getByRole('textbox', { name: '작업 이름' }), '주간 보고');
    await user.type(screen.getByRole('textbox', { name: '지시문' }), '요약');
    await user.click(screen.getByRole('button', { name: '작업 만들기' }));
    await waitFor(() => expect(postedTo(fn, '/api/cron/action')).toHaveLength(1));
    expect(postedTo(fn, '/api/cron/action')[0]).toMatchObject({ action: 'create', deliver: '', deliver_to: 'me' });
  });

  it('다른 프로파일에만 이었으면 고를 수 없다', async () => {
    mount('ops');
    mountScreen(<NewJobBody profiles={['main']} fixedProfile="main" onDone={() => {}} />, '/');
    await waitFor(() => expect(screen.getByRole('combobox', { name: '결과 전달' })).toBeInTheDocument());
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByRole('option', { name: '나에게 (메신저 DM)' })).not.toBeInTheDocument();
  });
});

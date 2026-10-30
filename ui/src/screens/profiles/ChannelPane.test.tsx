/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { mountScreen, postedTo, stubApi } from '@/test/mountScreen';

import { ChannelPane } from './ChannelPane';
import type { ProfileDetailData } from './types';

afterEach(() => vi.unstubAllGlobals());

const D = (over: Partial<ProfileDetailData> = {}) =>
  ({ profile: { name: 'ma' }, can_edit: true, secure: true, ...over }) as unknown as ProfileDetailData;

const DATA = {
  platforms: [
    {
      id: 'telegram',
      name: 'Telegram',
      enabled: false,
      configured: false,
      state: 'not_configured',
      env_vars: [
        { key: 'TELEGRAM_BOT_TOKEN', required: true, is_set: false },
        { key: 'TELEGRAM_ALLOWED_USERS', required: false, is_set: false },
        { key: 'TELEGRAM_PROXY', required: false, is_set: false },
      ],
    },
    { id: 'slack', name: 'Slack', enabled: true, configured: true, state: 'connected', env_vars: [{ key: 'SLACK_BOT_TOKEN', required: true, is_set: true }] },
  ],
  pairing: {
    pending: [{ platform: 'telegram', request_id: 'r1', user_id: '42', user_name: 'kim' }],
    approved: [{ platform: 'telegram', request_id: '', user_id: '7', user_name: '' }],
  },
};

function mount(d = D(), data: unknown = DATA) {
  const fn = stubApi({
    '/api/channels/platforms': data,
    '/api/profile/action': (_u: string, b: Record<string, unknown>) =>
      b.action === 'channel_test'
        ? { ok: true, test: { ok: false, state: 'startup_failed', message: '토큰이 거절됐습니다' } }
        : b.action === 'channel_save'
        ? { ok: true, hot_served: true }
        : { ok: true },
  });
  mountScreen(<ChannelPane d={d} />, '/profiles');
  return fn;
}

/** 「+ 메신저 연결」 → ① 메신저 고르기 → ② 그 메신저의 칸(2026-10-18) */
async function openPick(name = 'Telegram') {
  await userEvent.click(await screen.findByRole('button', { name: '메신저 연결' }));
  const dlg = await screen.findByRole('dialog', { name: '연결할 메신저 고르기' });
  await userEvent.click(within(dlg).getByRole('button', { name: new RegExp('^' + name) }));
  return screen.findByRole('dialog', { name: new RegExp(name) });
}
/** 연결한 메신저 카드의 「설정」 → 같은 대화 상자의 ②단계 */
async function openCard(name = 'Slack') {
  await userEvent.click(await screen.findByRole('button', { name: `${name} 설정` }));
  return screen.findByRole('dialog', { name: `${name} 설정` });
}

describe('프로파일 서랍 「메신저 연결」 탭: 연결한 메신저 카드와 「+ 메신저 연결」 대화 상자(2026-10-18)', () => {
  it('연결한(켰거나 값을 넣은) 메신저만 카드로 보이고, 나머지는 대화 상자에서 고른다', async () => {
    mount();
    expect(await screen.findByRole('heading', { name: '연결한 메신저 1' })).toBeInTheDocument();
    expect(screen.getByText('Slack')).toBeInTheDocument();
    expect(screen.getByText('연결됨')).toBeInTheDocument();
    expect(screen.queryByText('Telegram')).not.toBeInTheDocument(); // 연결하지 않은 메신저는 펼치지 않는다
    expect(screen.queryByLabelText('TELEGRAM_BOT_TOKEN')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: '메신저 연결' }));
    const pick = await screen.findByRole('dialog', { name: '연결할 메신저 고르기' });
    expect(within(pick).getByRole('button', { name: /^Telegram/ })).toBeInTheDocument();
    expect(within(pick).getByRole('button', { name: /^Slack.*이미 연결했습니다/ })).toBeInTheDocument();
    await userEvent.click(within(pick).getByRole('button', { name: /^Telegram/ }));
    const form = await screen.findByRole('dialog', { name: 'Telegram 연결' });
    expect(within(form).getByLabelText('TELEGRAM_BOT_TOKEN')).toBeInTheDocument();
    await userEvent.click(within(form).getByRole('button', { name: '다른 메신저 고르기' }));
    expect(await screen.findByRole('dialog', { name: '연결할 메신저 고르기' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: '닫기' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('하나도 연결하지 않았으면 안내 문장과 「메신저 연결」 단추만 보인다', async () => {
    mount(D(), { ...DATA, platforms: [DATA.platforms[0]] });
    expect(await screen.findByText(/아직 연결한 메신저가 없습니다/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '메신저 연결' })).toBeEnabled();
  });

  it('주소에 add=1 이 있으면 고르기 대화 상자를 열고 시작한다(메신저 연결 화면의 「메신저 연결하기」)', async () => {
    stubApi({ '/api/channels/platforms': DATA });
    mountScreen(<ChannelPane d={D()} />, '/profiles?name=ma&pane=channels&add=1');
    expect(await screen.findByRole('dialog', { name: '연결할 메신저 고르기' })).toBeInTheDocument();
  });

  it('카드에 승인 대기 수를 보이고 「설정」은 고르기 없이 그 메신저의 칸을 연다', async () => {
    mount(D(), { ...DATA, pairing: { pending: [{ platform: 'slack', request_id: 'r9', user_id: 'U1', user_name: 'lee' }], approved: [] } });
    expect(await screen.findByText('승인 대기 1')).toBeInTheDocument();
    const dlg = await openCard('Slack');
    expect(within(dlg).getByLabelText('SLACK_BOT_TOKEN')).toBeInTheDocument();
    expect(within(dlg).queryByRole('button', { name: '다른 메신저 고르기' })).not.toBeInTheDocument();
  });

  it('채널 상태와 필수 값·허용 사용자만 보이고, 필수 값을 넣어야 저장할 수 있다', async () => {
    const fn = mount();
    await openPick('Telegram');
    expect(screen.getByText('설정 필요')).toBeInTheDocument();
    expect(screen.queryByLabelText('TELEGRAM_PROXY')).not.toBeInTheDocument(); // 나머지 변수는 「비밀값」 탭에서
    const save = screen.getByRole('button', { name: '저장하고 켜기' });
    expect(save).toBeDisabled();
    expect(screen.getByText(/허용 사용자\(메신저 ID\)가 비어 있으면/)).toBeInTheDocument();
    expect(screen.getByText(/@userinfobot/)).toBeInTheDocument(); // 내 ID 를 찾는 방법
    await userEvent.type(screen.getByLabelText('TELEGRAM_BOT_TOKEN'), '123:abc');
    await userEvent.type(screen.getByLabelText('TELEGRAM_ALLOWED_USERS'), '42');
    expect(save).toBeEnabled();
    await userEvent.click(save);
    await waitFor(() =>
      expect(postedTo(fn, '/api/profile/action')).toContainEqual({
        name: 'ma',
        action: 'channel_save',
        platform: 'telegram',
        enabled: true,
        env: { TELEGRAM_BOT_TOKEN: '123:abc', TELEGRAM_ALLOWED_USERS: '42' },
      })
    );
    // 저장 → 반영 → 연결 시험이 한 흐름이다. 시험이 실패하면 상태별 원인 문장을 보인다(디자인 결정 2B)
    expect(await screen.findByText(/저장했지만 연결에 실패했습니다. 봇 토큰이 맞는지 확인하세요. \(토큰이 거절됐습니다\)/)).toBeInTheDocument();
    expect(postedTo(fn, '/api/profile/action').map((b) => b.action)).toEqual(['channel_save', 'channel_test']);
    expect(screen.getByLabelText('TELEGRAM_BOT_TOKEN')).toHaveValue(''); // 저장한 뒤 값은 지워진다
  });

  it('Mattermost 는 서버 주소를 가리지 않는 칸으로 받고, 주소와 사용자 ID 찾는 법을 안내한다(스펙 2026-10-19-008)', async () => {
    const mm = {
      id: 'mattermost',
      name: 'Mattermost',
      enabled: false,
      configured: false,
      state: 'not_configured',
      env_vars: [
        { key: 'MATTERMOST_URL', required: true, is_set: false },
        { key: 'MATTERMOST_TOKEN', required: true, is_set: false },
        { key: 'MATTERMOST_ALLOWED_USERS', required: false, is_set: false },
        { key: 'MATTERMOST_REPLY_MODE', required: false, is_set: false },
      ],
    };
    const fn = mount(D(), { ...DATA, platforms: [...DATA.platforms, mm] });
    await openPick('Mattermost');
    expect(screen.getByLabelText('MATTERMOST_URL')).toHaveAttribute('type', 'text');
    expect(screen.getByLabelText('MATTERMOST_TOKEN')).toHaveAttribute('type', 'password');
    expect(screen.queryByLabelText('MATTERMOST_REPLY_MODE')).not.toBeInTheDocument(); // 나머지 변수는 「비밀값」 탭에서
    expect(screen.getByText(/회사 Mattermost 접속 주소입니다/)).toBeInTheDocument();
    expect(screen.getByText(/사용자 ID\(영문·숫자 26자\)/)).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText('MATTERMOST_URL'), 'https://mattermost.example.com');
    await userEvent.type(screen.getByLabelText('MATTERMOST_TOKEN'), 'tok');
    await userEvent.type(screen.getByLabelText('MATTERMOST_ALLOWED_USERS'), '3uo8dkh1p7g1mfk49ear5fzs5c');
    await userEvent.click(screen.getByRole('button', { name: '저장하고 켜기' }));
    await waitFor(() =>
      expect(postedTo(fn, '/api/profile/action')).toContainEqual({
        name: 'ma',
        action: 'channel_save',
        platform: 'mattermost',
        enabled: true,
        env: { MATTERMOST_URL: 'https://mattermost.example.com', MATTERMOST_TOKEN: 'tok', MATTERMOST_ALLOWED_USERS: '3uo8dkh1p7g1mfk49ear5fzs5c' },
      })
    );
  });

  it('저장 뒤 연결 시험이 통과하면 한 문장으로 알리고, 끄기는 시험하지 않는다', async () => {
    const fn = stubApi({
      '/api/channels/platforms': { ...DATA, pairing: { pending: [], approved: [{ platform: 'slack', request_id: '', user_id: '7', user_name: '' }] } },
      '/api/profile/action': (_u: string, b: Record<string, unknown>) =>
        b.action === 'channel_test' ? { ok: true, test: { ok: true, state: 'connected', message: '' } } : { ok: true, hot_served: true },
    });
    mountScreen(<ChannelPane d={D()} />, '/profiles');
    await openCard('Slack');
    await userEvent.click(screen.getByRole('button', { name: '저장하고 켜기' }));
    expect(await screen.findByText('저장하고 연결을 확인했습니다.')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: '끄기' }));                       // Slack 은 켜져 있어 끌 수 있다
    expect(await screen.findByText('저장하고 껐습니다.')).toBeInTheDocument();
    expect(postedTo(fn, '/api/profile/action').map((b) => b.action)).toEqual(['channel_save', 'channel_test', 'channel_save']);
  });

  it('연결 시험의 결과 문구를 그대로 보인다', async () => {
    mount();
    await openPick('Telegram');
    await userEvent.click(screen.getByRole('button', { name: '연결 시험' }));
    expect(await screen.findByText('토큰이 거절됐습니다')).toBeInTheDocument();
  });

  it('페어링 요청은 승인하고 허용된 사용자는 해제한다', async () => {
    const fn = mount();
    await openPick('Telegram');
    await userEvent.click(await screen.findByRole('button', { name: '승인' }));
    await waitFor(() =>
      expect(postedTo(fn, '/api/profile/action')).toContainEqual({ name: 'ma', action: 'pairing_approve', platform: 'telegram', request_id: 'r1' })
    );
    await userEvent.click(screen.getByRole('button', { name: '해제' }));
    await waitFor(() =>
      expect(postedTo(fn, '/api/profile/action')).toContainEqual({ name: 'ma', action: 'pairing_revoke', platform: 'telegram', user_id: '7' })
    );
  });

  it('관리자가 아니거나 암호화되지 않은 연결이면 입력과 단추가 막힌다', async () => {
    mount(D({ can_edit: false }));
    expect(await screen.findByText('관리자만 바꿀 수 있습니다.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '메신저 연결' })).toBeDisabled();
    await openCard('Slack'); // 연결한 메신저의 설정은 열어 볼 수 있지만 바꿀 수 없다
    expect(screen.getByLabelText('SLACK_BOT_TOKEN')).toBeDisabled();
    expect(screen.getByRole('button', { name: '연결 시험' })).toBeDisabled();
  });

  it('에이전트 주인은 관리자가 아니어도 입력하고 저장할 수 있다(스펙 2026-10-15-011 단계 1)', async () => {
    const fn = mount(D({ can_edit: false, owner: true }));
    await openPick('Telegram');
    await userEvent.type(await screen.findByLabelText('TELEGRAM_BOT_TOKEN'), '123:abc');
    await userEvent.type(screen.getByLabelText('TELEGRAM_ALLOWED_USERS'), '42');
    expect(screen.queryByText('관리자만 바꿀 수 있습니다.')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: '저장하고 켜기' }));
    await waitFor(() =>
      expect(postedTo(fn, '/api/profile/action')).toContainEqual(expect.objectContaining({ action: 'channel_save', platform: 'telegram' }))
    );
  });

  it('주인의 저장을 서버가 거절하면 그 문구를 그대로 보인다', async () => {
    stubApi({
      '/api/channels/platforms': DATA,
      '/api/profile/action': () => {
        throw new Error('허용 사용자에는 실제 사용자 ID 만 쉼표로 적습니다.');
      },
    });
    mountScreen(<ChannelPane d={D({ can_edit: false, owner: true })} />, '/profiles');
    await openPick('Telegram');
    await userEvent.type(await screen.findByLabelText('TELEGRAM_BOT_TOKEN'), '123:abc');
    await userEvent.type(screen.getByLabelText('TELEGRAM_ALLOWED_USERS'), '*');
    await userEvent.click(screen.getByRole('button', { name: '저장하고 켜기' }));
    expect(await screen.findByText(/실제 사용자 ID 만/)).toBeInTheDocument();
  });

  it('서버가 거절한 칸 아래에 문구를 보이고 그 칸으로 포커스를 옮긴다(디자인 결정 2A)', async () => {
    stubApi({ '/api/channels/platforms': DATA });
    const base = vi.mocked(globalThis.fetch);
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string, init?: RequestInit) =>
        url.startsWith('/api/profile/action')
          ? Promise.resolve(new Response(JSON.stringify({ error: '허용 사용자에는 실제 사용자 ID 만 적습니다.', reason: 'allow_list_invalid', field: 'TELEGRAM_ALLOWED_USERS' }), { status: 403 }))
          : base(url, init)
      )
    );
    mountScreen(<ChannelPane d={D({ can_edit: false, owner: true })} />, '/profiles');
    await openPick('Telegram');
    await userEvent.type(await screen.findByLabelText('TELEGRAM_BOT_TOKEN'), '123:abc');
    const allow = screen.getByLabelText('TELEGRAM_ALLOWED_USERS');
    await userEvent.type(allow, '*');
    await userEvent.click(screen.getByRole('button', { name: '저장하고 켜기' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('실제 사용자 ID 만 적습니다.');
    await waitFor(() => expect(allow).toHaveFocus());
  });

  it('페어링 목록이 없으면(관리자가 아님) 그 구역을 그리지 않는다', async () => {
    mount(D(), { ...DATA, pairing: null });
    await openPick('Telegram');
    expect(screen.queryByText('페어링 요청과 허용된 사용자')).not.toBeInTheDocument();
  });

  it('요청이 와 있고 허용 사용자가 비었으면 칸 아래에서 바로 승인한다', async () => {
    const fn = mount();
    await openPick('Telegram');
    await userEvent.click(await screen.findByRole('button', { name: 'kim 승인' }));
    await waitFor(() =>
      expect(postedTo(fn, '/api/profile/action')).toContainEqual({ name: 'ma', action: 'pairing_approve', platform: 'telegram', request_id: 'r1' })
    );
  });

  it('허용 사용자가 비어 있으면 켜기 전에 확인하고, 취소하면 저장하지 않는다', async () => {
    const fn = mount(D(), { ...DATA, pairing: { pending: [], approved: [] } });
    await openPick('Telegram');
    await userEvent.type(await screen.findByLabelText('TELEGRAM_BOT_TOKEN'), '123:abc');
    await userEvent.click(screen.getByRole('button', { name: '저장하고 켜기' }));
    const box = (await screen.findByText(/켜도 아무도 대화할 수 없습니다/)).closest('[role="dialog"]') as HTMLElement;
    await userEvent.click(within(box).getByRole('button', { name: /취소|아니오/ }));
    await waitFor(() => expect(screen.queryByText(/켜도 아무도 대화할 수 없습니다/)).not.toBeInTheDocument());
    expect(await screen.findByRole('dialog', { name: 'Telegram 연결' })).toBeInTheDocument(); // 확인 창만 닫히고 연결 대화 상자는 남는다
    expect(postedTo(fn, '/api/profile/action').filter((b) => b.action === 'channel_save')).toHaveLength(0);
  });
});

/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 「내 메신저 계정 연결」(스펙 2026-11-17-008 §5-2)과 다시 시작 안내(§5-1)
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { mountScreen, postedTo, stubApi } from '@/test/mountScreen';

import { MessengerLinkButton, type MessengerLinks } from './MessengerLink';

afterEach(() => vi.unstubAllGlobals());

const VIEW = (over: Partial<MessengerLinks> = {}): MessengerLinks => ({
  pod: 'kim',
  can_link: true,
  bots: [{ profile: 'main', platform: 'telegram', state: 'connected', connected: true }],
  mine: [],
  owner_name: '김소유',
  restart_needed: [],
  ...over,
});

describe('내 메신저 계정 연결', () => {
  it('이을 수 없는 사람에게는 그리지 않는다', async () => {
    const fn = stubApi({ '/api/messenger/links': VIEW({ can_link: false }) });
    mountScreen(<MessengerLinkButton pod="kim" />, '/');
    await waitFor(() => expect(fn).toHaveBeenCalled());
    expect(screen.queryByRole('button', { name: '내 메신저 계정 연결' })).not.toBeInTheDocument();
  });

  it('코드를 넣으면 잇고, 본인 계정이 아니면 해제하라고 알린다', async () => {
    const user = userEvent.setup();
    const fn = stubApi({
      '/api/messenger/links': (_u: string, b: Record<string, unknown>) =>
        b.op === 'link'
          ? { ok: true, delivery: true, link: { profile: 'main', platform: 'telegram', platform_user_id: '777', user_name: '@lee', dm_chat_id: '', ts: '' } }
          : VIEW(),
    });
    mountScreen(<MessengerLinkButton pod="kim" />, '/');
    await user.click(await screen.findByRole('button', { name: '내 메신저 계정 연결' }));
    const dlg = await screen.findByRole('dialog', { name: '내 메신저 계정 연결' });
    expect(within(dlg).getByText(/t.me 링크/)).toBeInTheDocument();
    await user.type(within(dlg).getByRole('textbox', { name: '연결 코드' }), 'abcd2345');
    await user.click(within(dlg).getByRole('button', { name: '연결' }));
    expect(await within(dlg).findByText(/@lee 이\(가\) 연결되었습니다. 본인 계정이 아니면 바로 해제하세요/)).toBeInTheDocument();
    expect(postedTo(fn, '/api/messenger/links')).toEqual([{ pod: 'kim', op: 'link', profile: 'main', platform: 'telegram', code: 'abcd2345' }]);
  });

  it('알림을 받을 수 없는 메신저면 알린다, 거절 문구는 그대로', async () => {
    const user = userEvent.setup();
    let n = 0;
    stubApi({
      '/api/messenger/links': (_u: string, b: Record<string, unknown>) => {
        if (b.op !== 'link') return VIEW({ bots: [{ profile: 'main', platform: 'mattermost', state: 'connected', connected: true }] });
        n += 1;
        return n === 1
          ? new Response(JSON.stringify({ error: '코드가 맞지 않거나 1시간이 지났습니다.' }), { status: 404 })
          : { ok: true, delivery: false, link: { profile: 'main', platform: 'mattermost', platform_user_id: 'u1', user_name: 'lee', dm_chat_id: '', ts: '' } };
      },
    });
    mountScreen(<MessengerLinkButton pod="kim" />, '/');
    await user.click(await screen.findByRole('button', { name: '내 메신저 계정 연결' }));
    const dlg = await screen.findByRole('dialog', { name: '내 메신저 계정 연결' });
    await user.type(within(dlg).getByRole('textbox', { name: '연결 코드' }), 'abcd2345');
    await user.click(within(dlg).getByRole('button', { name: '연결' }));
    expect(await within(dlg).findByText('코드가 맞지 않거나 1시간이 지났습니다.')).toBeInTheDocument();
    await user.click(within(dlg).getByRole('button', { name: '연결' }));
    expect(await within(dlg).findByText(/알림은 받지 못합니다/)).toBeInTheDocument();
  });

  it('봇이 없으면 소유자에게 요청하라고 하고, 연결한 것은 해제할 수 있다', async () => {
    const user = userEvent.setup();
    const mine = [{ profile: 'main', platform: 'telegram', platform_user_id: '777', user_name: '@lee', dm_chat_id: '', ts: '' }];
    const fn = stubApi({ '/api/messenger/links': (_u: string, b: Record<string, unknown>) => (b.op ? { ok: true } : VIEW({ bots: [], mine })) });
    mountScreen(<MessengerLinkButton pod="kim" />, '/');
    expect(await screen.findByText('연결한 메신저 1개')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '내 메신저 계정 연결' }));
    const dlg = await screen.findByRole('dialog', { name: '내 메신저 계정 연결' });
    expect(within(dlg).getByText(/아직 이 AI 에이전트에 메신저를 연결하지 않았습니다/)).toBeInTheDocument();
    await user.click(within(dlg).getByRole('button', { name: '해제' }));
    await waitFor(() =>
      expect(postedTo(fn, '/api/messenger/links')).toEqual([{ pod: 'kim', op: 'unlink', profile: 'main', platform: 'telegram', user_id: '777' }])
    );
  });
});

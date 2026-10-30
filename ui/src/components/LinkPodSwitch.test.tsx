/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Me } from '@/lib/data';
import { switchPod } from '@/lib/pod';
import { mountScreen, stubApi } from '@/test/mountScreen';

import { LinkPodSwitch, linkPodTarget, withoutPod } from './LinkPodSwitch';

vi.mock('@/lib/pod', async (orig) => ({ ...(await orig<typeof import('@/lib/pod')>()), switchPod: vi.fn(async () => {}) }));

afterEach(() => vi.unstubAllGlobals());

const ME = {
  auth_enabled: true,
  admin: false,
  user: { email: 'kim@x.com' },
  pod: { id: 'a', owner: 'kim@x.com', name: '김 에이전트' },
  pods: [
    { id: 'a', owner: 'kim@x.com', name: '김 에이전트' },
    { id: 'b', owner: 'kim@x.com', name: '보고서 봇' },
  ],
} as unknown as Me;

describe('링크의 pod 로 AI 에이전트 작업공간 바꾸기(스펙 2026-10-28-001 §3-7 ⑥)', () => {
  it('지금과 다르고 내 목록에 있는 pod 만 대상이다', () => {
    expect(linkPodTarget('?pod=b&name=main', ME)?.id).toBe('b');
    expect(linkPodTarget('?pod=a&name=main', ME)).toBeNull();
    expect(linkPodTarget('?pod=zz&name=main', ME)).toBeNull();
    expect(linkPodTarget('?name=main', ME)).toBeNull();
    expect(withoutPod('/profiles', '?pod=b&name=main&pane=env&key=X')).toBe('/profiles?name=main&pane=env&key=X');
    expect(withoutPod('/profiles', '?pod=b')).toBe('/profiles');
  });

  it('바꾸지 않으면 pod 만 지우고 다시 묻지 않는다', async () => {
    const user = userEvent.setup();
    stubApi({});
    mountScreen(<LinkPodSwitch me={ME} />, '/profiles?pod=b&name=main&pane=env&key=X');
    const dlg = await screen.findByRole('dialog');
    expect(dlg).toHaveTextContent('보고서 봇');
    await user.click(within(dlg).getByRole('button', { name: '취소' }));
    await waitFor(() => expect(screen.getByTestId('loc')).toHaveTextContent('/profiles?name=main&pane=env&key=X'));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('바꾸면 그 작업공간으로 바꾼 뒤 pod 를 뺀 같은 주소로 새로 고친다', async () => {
    const user = userEvent.setup();
    const reload = vi.fn();
    vi.stubGlobal('location', { ...window.location, reload });
    vi.mocked(switchPod).mockClear();
    stubApi({});
    mountScreen(<LinkPodSwitch me={ME} />, '/profiles?pod=b&name=main&pane=env&key=X');
    const dlg = await screen.findByRole('dialog');
    await user.click(within(dlg).getByRole('button', { name: '바꿔서 열기' }));
    await waitFor(() => expect(reload).toHaveBeenCalled());
    expect(switchPod).toHaveBeenCalledWith('b');
    expect(document.location.hash).toBe('#/profiles?name=main&pane=env&key=X'); // 해시 라우터 주소(stub 아닌 실제 문서 주소)
  });

  // 사용자 결정 D14(2026-10-29): 묻는 곳은 Claude Code 비밀값·자격증명·MCP 링크(`#/profiles?pod=…&name=…`)뿐이다.
  // 채팅·목록 서랍 등 다른 화면은 화면이 pod 를 스스로 처리한다(채팅은 그 묶음을 열고, 목록 서랍은 열지 않고 알린다)
  it.each(['/chat?agent=main&pod=b', '/chat?agent=main&pod=b&session=y', '/agents?open=x&pod=b', '/skills?open=x&pod=b', '/cron?open=ma%2Fj1&pod=b', '/profiles?pod=b'])(
    '프로파일 링크(name 있음)가 아니면 묻지 않고 주소도 건드리지 않는다: %s',
    async (at) => {
      stubApi({});
      mountScreen(<LinkPodSwitch me={ME} />, at);
      await act(async () => {});
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(screen.getByTestId('loc')).toHaveTextContent(at);
    }
  );
});

/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { mountScreen, postedTo, stubApi } from '@/test/mountScreen';

import { RequestAdminButton } from './RequestAdminButton';

afterEach(() => vi.unstubAllGlobals());

describe('관리자에게 요청 단추(스펙 2026-10-15-011 단계 5)', () => {
  it('내용을 적어 보내면 프로파일·종류·내용을 POST 한다', async () => {
    const fn = stubApi({ '/api/requests': { waiting: [] } });
    mountScreen(<RequestAdminButton profile="ma" kind="model_change" />, '/');
    await userEvent.click(await screen.findByRole('button', { name: '관리자에게 요청' }));
    const dlg = await screen.findByRole('dialog', { name: '모델 변경 요청' });
    await userEvent.type(within(dlg).getByLabelText('요청 내용'), ' 더 큰 모델로 바꿔 주세요 ');
    await userEvent.click(within(dlg).getByRole('button', { name: '요청 보내기' }));
    await waitFor(() => expect(postedTo(fn, '/api/requests')).toEqual([{ profile: 'ma', kind: 'model_change', detail: '더 큰 모델로 바꿔 주세요' }]));
  });

  it('같은 요청이 처리를 기다리면 단추 대신 대기 일수를 보인다', async () => {
    stubApi({ '/api/requests': { waiting: [{ profile: 'ma', kind: 'model_change', waiting_days: 2 }] } });
    mountScreen(<RequestAdminButton profile="ma" kind="model_change" />, '/');
    expect(await screen.findByText('처리 대기 중(2일째)')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '관리자에게 요청' })).toBeNull();
  });

  it('서버가 거절하면 대화 상자에 이유를 보인다(중복·상한)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, init?: RequestInit) =>
        Promise.resolve(
          init?.method === 'POST'
            ? new Response(JSON.stringify({ error: '이미 같은 요청이 처리를 기다리고 있습니다' }), { status: 409 })
            : new Response(JSON.stringify({ waiting: [] }), { status: 200 })
        )
      )
    );
    mountScreen(<RequestAdminButton profile="ma" kind="other" />, '/');
    await userEvent.click(await screen.findByRole('button', { name: '관리자에게 요청' }));
    await userEvent.click(await screen.findByRole('button', { name: '요청 보내기' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('이미 같은 요청이 처리를 기다리고 있습니다');
  });
});

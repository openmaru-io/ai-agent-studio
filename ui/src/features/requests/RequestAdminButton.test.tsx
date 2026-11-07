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

  it('대기 요청 상한(429)이면 대화 상자에 서버 이유를 보인다', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, init?: RequestInit) =>
        Promise.resolve(
          init?.method === 'POST'
            ? new Response(JSON.stringify({ error: '처리를 기다리는 요청이 10건 있습니다' }), { status: 429 })
            : new Response(JSON.stringify({ waiting: [] }), { status: 200 })
        )
      )
    );
    mountScreen(<RequestAdminButton profile="ma" kind="other" />, '/');
    await userEvent.click(await screen.findByRole('button', { name: '관리자에게 요청' }));
    await userEvent.click(await screen.findByRole('button', { name: '요청 보내기' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('처리를 기다리는 요청이 10건 있습니다');
  });

  it('이미 같은 요청이 대기 중(409)이면 오류 대신 대기 표시로 바꾼다(스펙 2026-11-06-005 D7)', async () => {
    let gets = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, init?: RequestInit) => {
        if (init?.method === 'POST') return Promise.resolve(new Response(JSON.stringify({ error: '이미 같은 요청이' }), { status: 409 }));
        gets += 1;
        const waiting = gets > 1 ? [{ profile: 'ma', kind: 'other', waiting_days: 0 }] : [];
        return Promise.resolve(new Response(JSON.stringify({ waiting }), { status: 200 }));
      })
    );
    mountScreen(<RequestAdminButton profile="ma" kind="other" />, '/');
    await userEvent.click(await screen.findByRole('button', { name: '관리자에게 요청' }));
    await userEvent.click(await screen.findByRole('button', { name: '요청 보내기' }));
    expect(await screen.findByText('오늘 요청함')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('pod 를 주면 그 작업공간으로 묻고 보낸다, 이름은 aria-label(D6·D20)', async () => {
    const fn = vi.fn((_url: string, _init?: RequestInit) => Promise.resolve(new Response(JSON.stringify({ waiting: [], ok: true }), { status: 200 })));
    vi.stubGlobal('fetch', fn);
    mountScreen(<RequestAdminButton profile="_workspace" kind="workspace_size" pod="aas-agent-b" label="관리자에게 메모리 늘리기 요청" ariaLabel="B 메모리 요청" />, '/');
    await userEvent.click(await screen.findByRole('button', { name: 'B 메모리 요청' }));
    expect(screen.getByText('처리되면 작업공간이 한 번 다시 시작됩니다.')).toBeInTheDocument();
    await userEvent.click(await screen.findByRole('button', { name: '요청 보내기' }));
    expect(fn.mock.calls.some(([u]) => String(u).includes('/api/requests?pod=aas-agent-b'))).toBe(true);
    const post = fn.mock.calls.find(([, i]) => i?.method === 'POST');
    expect(JSON.parse(String(post?.[1]?.body))).toMatchObject({ pod: 'aas-agent-b', kind: 'workspace_size', profile: '_workspace' });
  });
});

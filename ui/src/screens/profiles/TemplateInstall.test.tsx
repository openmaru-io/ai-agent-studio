/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { mountScreen, postedTo, stubApi } from '@/test/mountScreen';

import { TemplateInstall } from './TemplateInstall';

const CARD = {
  id: 'paid/sales',
  namespace: 'paid',
  name: 'sales',
  version: '1.2.0',
  public: false,
  description: '영업 도우미',
  author: '영업팀',
  env_requires: [{ name: 'JIRA_TOKEN', description: 'JIRA 토큰', required: true, used_by: [] }],
  mcp: [
    { name: 'jira', url: 'https://jira/mcp', stdio: false },
    { name: 'fs', stdio: true },
  ],
  skills: 1,
  hub_skills: [],
  cron: 1,
  files: 0,
  model_hint: 'gpt-x',
  examples: ['견적 요청을 정리해 줘'],
  installs: 3,
};
const DETAIL = {
  ...CARD,
  mcp: [
    { name: 'jira', url: 'https://jira/mcp', stdio: false, keys: ['JIRA_TOKEN'] },
    { name: 'fs', stdio: true, keys: [], command: 'npx', args: ['-y', '@s/fs@1.0.0'], consent_hash: 'h'.repeat(64) },
  ],
  cron: [{ name: '주간', schedule: '0 9 * * 1', prompt: '정리해', script: '' }],
  files: [],
  soul: '나는 영업 도우미',
  agents: '',
  readme: '',
};

function setup(requestStatus: 'done' | 'failed') {
  const api = stubApi({
    '/api/market/templates': { items: [CARD], failed: 0, error: '', limit: 3, used: 1, profiles: ['main'] },
    '/api/market/template': DETAIL,
    '/api/market/install': { ok: true, request: { id: '20261118090000000000-abcdef', status: 'queued' } },
    '/api/market/request': { id: '20261118090000000000-abcdef', status: requestStatus, message: requestStatus === 'failed' ? '거절' : '설치했습니다', code: '' },
    '/api/profile/action': { ok: true, mcp_enabled: ['jira'] },
  });
  const onDone = vi.fn();
  mountScreen(<TemplateInstall onDone={onDone} />, '/');
  return { api, onDone };
}

async function toKeys() {
  fireEvent.click(await screen.findByRole('button', { name: /sales/ }));
  expect(await screen.findByText('npx -y @s/fs@1.0.0')).toBeTruthy();
  const next = screen.getByRole('button', { name: '다음' });
  expect((next as HTMLButtonElement).disabled).toBe(true); // stdio 동의 전에는 막힌다
  fireEvent.click(screen.getByRole('checkbox', { name: /이 명령을 내 AI 에이전트 작업공간에서 실행하는 데 동의합니다/ }));
  fireEvent.click(next);
}

describe('TemplateInstall', () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('스킬 허브에서 온 템플릿(preselect)은 목록을 받으면 한 번 골라 확인 단계로 간다. 허용되지 않은 것은 고르지 않는다(2026-11-18-014)', async () => {
    stubApi({ '/api/market/templates': { items: [CARD], failed: 0, error: '', limit: 3, used: 1, profiles: ['main'] }, '/api/market/template': DETAIL });
    mountScreen(<TemplateInstall onDone={vi.fn()} preselect="paid/sales" />, '/');
    expect(await screen.findByText('npx -y @s/fs@1.0.0')).toBeTruthy();                      // 확인 단계(stdio 동의)가 바로 보인다
    cleanup();
    stubApi({ '/api/market/templates': { items: [{ ...CARD, allowed: false }], failed: 0, error: '', limit: 3, used: 1, profiles: ['main'] }, '/api/market/template': DETAIL });
    mountScreen(<TemplateInstall onDone={vi.fn()} preselect="paid/sales" />, '/');
    expect(await screen.findByRole('button', { name: /sales/ })).toBeTruthy();                // 목록 그대로
    expect(screen.queryByText('npx -y @s/fs@1.0.0')).toBeNull();
  });

  it('필수 KEY 가 비면 만들기를 막고, 설치가 done 이 되면 그때 env_set 한다', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { api } = setup('done');
    await toKeys();
    const create = screen.getByRole('button', { name: '만들기' }) as HTMLButtonElement;
    expect(create.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(/JIRA_TOKEN/, { selector: 'input:not([type="checkbox"])' }), { target: { value: 'tok-1' } });
    expect(create.disabled).toBe(false);
    fireEvent.click(create);
    expect(await screen.findByText('프로파일을 만드는 중입니다')).toBeTruthy();
    const installed = postedTo(api, '/api/market/install');
    expect(installed[0]).toMatchObject({ namespace: 'paid', name: 'sales', profile: 'sales', consents: ['h'.repeat(64)] });
    expect(JSON.stringify(installed[0])).not.toContain('tok-1'); // KEY 값은 설치 요청에 실리지 않는다
    expect(postedTo(api, '/api/profile/action')).toEqual([]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3100);
    });
    expect(await screen.findByText('프로파일을 만들었습니다.')).toBeTruthy();
    expect(postedTo(api, '/api/profile/action')).toEqual([{ name: 'sales', action: 'env_set', target: 'JIRA_TOKEN', value: 'tok-1' }]);
    expect(screen.getByText('켠 MCP: jira')).toBeTruthy();
  });

  it('새 프로파일 이름은 ② 확인에서 바꾸고, 바꾼 이름으로 만든다(2026-11-18 사용자 요청)', async () => {
    const { api } = setup('done');
    fireEvent.click(await screen.findByRole('button', { name: /sales/ }));
    const nameBox = (await screen.findByLabelText('새 프로파일 이름')) as HTMLInputElement;
    expect(nameBox.value).toBe('sales');                                         // 템플릿 이름으로 채워 둔다
    fireEvent.change(nameBox, { target: { value: 'Bad Name' } });
    fireEvent.click(screen.getByRole('checkbox', { name: /이 명령을 내 AI 에이전트 작업공간에서 실행하는 데 동의합니다/ }));
    expect((screen.getByRole('button', { name: '다음' }) as HTMLButtonElement).disabled).toBe(true);   // 이름 규칙에 맞아야 넘어간다
    fireEvent.change(nameBox, { target: { value: 'sales-kim' } });
    fireEvent.click(screen.getByRole('button', { name: '다음' }));
    expect(screen.getByTestId('tpl-new-name').textContent).toBe('sales-kim');
    fireEvent.click(screen.getByRole('checkbox', { name: 'JIRA_TOKEN 나중에 넣기' }));
    fireEvent.click(screen.getByRole('button', { name: '만들기' }));
    await waitFor(() => expect(postedTo(api, '/api/market/install')[0]).toMatchObject({ profile: 'sales-kim' }));
  });

  it('설치가 실패하면 KEY 를 넣지 않는다', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { api } = setup('failed');
    await toKeys();
    fireEvent.click(screen.getByRole('checkbox', { name: 'JIRA_TOKEN 나중에 넣기' }));
    fireEvent.click(screen.getByRole('button', { name: '만들기' }));
    await screen.findByText('프로파일을 만드는 중입니다');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3100);
    });
    expect(await screen.findByText(/프로파일을 만들지 못했습니다/)).toBeTruthy();
    expect(postedTo(api, '/api/profile/action')).toEqual([]);
  });

  it('「나중에」를 고르면 꺼진 채로 만들어질 MCP 수를 알린다', async () => {
    setup('done');
    await toKeys();
    fireEvent.click(screen.getByRole('checkbox', { name: 'JIRA_TOKEN 나중에 넣기' }));
    expect(screen.getByText('MCP 1개가 꺼진 채로 만들어집니다. KEY 를 넣으면 켜집니다.')).toBeTruthy();
    // 나중에 넣을 KEY 칸은 막는다 — 값을 넣어도 쓰지 않는다는 것을 칸이 보인다(OKE my-template, 2026-11-18)
    expect((screen.getByLabelText(/JIRA_TOKEN/, { selector: 'input:not([type="checkbox"])' }) as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: '만들기' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('작업공간이 받을 수 없는 구역의 템플릿은 고를 수 없고 이유를 보인다', async () => {
    stubApi({ '/api/market/templates': { items: [{ ...CARD, allowed: false }], failed: 0, error: '', limit: 3, used: 1, profiles: ['main'] } });
    mountScreen(<TemplateInstall onDone={vi.fn()} />, '/');
    const card = (await screen.findByRole('button', { name: /sales/ })) as HTMLButtonElement;
    expect(card.disabled).toBe(true);
    expect(await screen.findByText(/이 구역의 AI 에이전트 템플릿을 받을 수 없습니다/)).toBeTruthy();   // 관리자 여부(/api/me)를 읽은 뒤의 문구
    expect(card.contains(screen.getByText(/이 구역의 AI 에이전트 템플릿을 받을 수 없습니다/))).toBe(false);   // 안내는 꺼진 카드 단추 밖(스펙 2026-11-18-015 §3-4)
  });
});

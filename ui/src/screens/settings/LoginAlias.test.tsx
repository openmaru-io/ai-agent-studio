/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { mountScreen, postedTo, stubApi } from '@/test/mountScreen';

import { LoginAlias, LoginAliasData, resultLabel } from './LoginAlias';

afterEach(() => vi.unstubAllGlobals());

const ROW = { id: 7, created: 1763190000, source: 'bulk', mode: 'run', kase: 'rename', result: 'done', step: 'agents_renamed',
  login_email: 'hong@legacy.example.com', company_email: 'hong@openmaru.io', error: '' };

const DATA = (over: Partial<LoginAliasData> = {}): LoginAliasData => ({
  config: { mode: 'off', pairs: [['legacy.example.com', 'openmaru.io']], providers: ['google'], exclude: [] },
  source: 'install',
  install: { mode: 'off', pairs: [['legacy.example.com', 'openmaru.io']], providers: ['google'], exclude: [] },
  observed: [{ client: 'aas', alias: 'google', n: 3 }, { client: 'aas', alias: '', n: 1 }, { client: 'wiki', alias: 'google', n: 9 }],
  client: 'aas',
  no_claim: false,
  unseen_providers: [],
  keycloak: true,
  records: [],
  attention: [],
  ...over,
});

describe('설정 › 로그인 도메인', () => {
  it('관찰은 이 AAS client 것만 보이고, 출처와 빈 목록 문구를 보인다', async () => {
    stubApi({ '/api/settings/login': DATA() });
    mountScreen(<LoginAlias />, '/settings');
    const seen = await screen.findByTestId('login-observed');
    expect(within(seen).getByText('google: 3번')).toBeInTheDocument();
    expect(within(seen).getByText('제공자 정보 없음(비밀번호 로그인 등): 1번')).toBeInTheDocument();
    expect(within(seen).queryByText('google: 9번')).toBeNull();
    expect(screen.getByTestId('login-source')).toHaveTextContent('설치 값입니다');
    expect(screen.getByTestId('login-attention')).toHaveTextContent('확인할 것이 없습니다.');
    expect(screen.getByTestId('login-records')).toHaveTextContent('아직 처리 기록이 없습니다.');
    expect(screen.queryByRole('button', { name: '설치 값으로 되돌리기' })).toBeNull();
  });

  it('aas client 에 claim 이 0건이면 「기록만」·「켬」을 고를 때 처리하지 않는다는 띠를 보인다', async () => {
    stubApi({ '/api/settings/login': DATA({ no_claim: true, observed: [] }) });
    mountScreen(<LoginAlias />, '/settings');
    await userEvent.click(await screen.findByRole('radio', { name: '켬' }));
    expect(await screen.findByTestId('login-no-claim')).toHaveTextContent('aas-login-provider');
  });

  it('끔이면 claim 이 0건이어도 띠를 보이지 않는다(구글 제공자가 없는 설치, 스펙 2026-11-19-004 §5)', async () => {
    stubApi({ '/api/settings/login': DATA({ no_claim: true, observed: [] }) });
    mountScreen(<LoginAlias />, '/settings');
    await screen.findByTestId('login-source');
    expect(screen.queryByTestId('login-no-claim')).toBeNull();
  });

  it('저장하면 켜기·도메인 짝·제공자·제외를 보낸다', async () => {
    const fn = stubApi({ '/api/settings/login': (_u: string, b: Record<string, unknown>) => (b.action ? { ok: true, ...DATA({ source: 'screen', config: { mode: 'record', pairs: [['legacy.example.com', 'openmaru.io']], providers: ['google'], exclude: [] } }) } : DATA()) });
    mountScreen(<LoginAlias />, '/settings');
    await userEvent.click(await screen.findByRole('radio', { name: '기록만' }));
    await userEvent.click(screen.getByRole('button', { name: '저장' }));
    await waitFor(() => expect(postedTo(fn, '/api/settings/login')).toHaveLength(1));
    expect(postedTo(fn, '/api/settings/login')[0]).toEqual({ action: 'save', mode: 'record', pairs: 'legacy.example.com:openmaru.io', providers: 'google', exclude: '' });
    expect(await screen.findByTestId('login-source')).toHaveTextContent('화면에서 저장한 값입니다');
  });

  it('저장 거절(400)은 그 칸 아래에 보인다', async () => {
    stubApi({
      '/api/settings/login': (_u: string, b: Record<string, unknown>) =>
        b.action
          ? new Response(JSON.stringify({ error: '2번째 줄의 도메인 짝이 틀렸습니다', code: 'bad_pair', field: 'pairs', line: 2, value: 'x', expected: 'a:b' }), { status: 400 })
          : DATA(),
    });
    mountScreen(<LoginAlias />, '/settings');
    const pairs = await screen.findByTestId('login-pairs');
    await userEvent.type(pairs, '\nx');
    await userEvent.click(screen.getByRole('button', { name: '저장' }));
    expect(await screen.findByText('2번째 줄의 도메인 짝이 틀렸습니다')).toBeInTheDocument();
  });

  it('미리 보기는 겹친 사람·제외한 사람을 가리고, 전원 바꾸기는 확인 뒤 보낸다', async () => {
    const fn = stubApi({
      '/api/settings/login/preview': { people: [
        { user_id: 'u1', login_email: 'hong@legacy.example.com', company_email: 'hong@openmaru.io', enabled: true, excluded: false, conflict: false },
        { user_id: 'u2', login_email: 'lee@legacy.example.com', company_email: 'lee@openmaru.io', enabled: true, excluded: false, conflict: true },
      ] },
      '/api/settings/login/bulk': { ok: true, result: { done: 1, recorded: 0, rejected: 1, failed: 0, skipped: 0 }, ...DATA({ records: [ROW] }) },
      '/api/settings/login': DATA(),
    });
    mountScreen(<LoginAlias />, '/settings');
    await userEvent.click(await screen.findByRole('button', { name: '미리 보기' }));
    const pv = await screen.findByTestId('login-preview');
    expect(within(pv).getByText('바뀜')).toBeInTheDocument();
    expect(within(pv).getByText('회사 계정 있음 — 손으로 정리')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: '전원 바꾸기' }));
    const dialog = await screen.findByRole('dialog');
    expect(postedTo(fn, '/api/settings/login/bulk')).toHaveLength(0);
    await userEvent.click(within(dialog).getByRole('button', { name: '전원 바꾸기' }));
    await waitFor(() => expect(postedTo(fn, '/api/settings/login/bulk')).toEqual([{ action: 'run' }]));
    expect(await screen.findByTestId('login-records')).toHaveTextContent('hong@legacy.example.com → hong@openmaru.io');
  });

  it('Keycloak 관리 설정이 없으면 미리 보기·전원 바꾸기를 막는다', async () => {
    stubApi({ '/api/settings/login': DATA({ keycloak: false }) });
    mountScreen(<LoginAlias />, '/settings');
    expect(await screen.findByRole('button', { name: '미리 보기' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '전원 바꾸기' })).toBeDisabled();
  });

  it('다른 모양의 응답이면 그리지 않는다', async () => {
    stubApi({ '/api/settings/login': { company_name: '' } });
    const { container } = mountScreen(<LoginAlias />, '/settings');
    await new Promise((r) => setTimeout(r, 20));
    expect(container.querySelector('section')).toBeNull();
  });

  it('결과 문구: 실패는 어디까지 했는지, 겹침은 코드를 보인다', () => {
    expect(resultLabel({ kase: 'rename', result: 'failed', step: 'renamed' })).toBe('실패(AAS 기록 까지 함) — 다시 실행하면 이어 합니다');
    expect(resultLabel({ kase: 'needs_admin', result: 'rejected', step: '' })).toContain('AAS-LM-NEEDS-ADMIN');
    expect(resultLabel({ kase: 'rename', result: 'failed', step: '' })).toContain('시작 전');
  });
});

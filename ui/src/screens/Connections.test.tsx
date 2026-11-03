/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { mountScreen, postedTo, stubApi } from '@/test/mountScreen';

import { Connections } from './Connections';

afterEach(() => vi.unstubAllGlobals());

const NOW = Date.now() / 1000;
const ME = { auth_enabled: true, admin: false, user: { email: 'kim@corp.example', name: 'kim' }, connections: { active: 2, expiring: 1 } };
const row = (over: Record<string, unknown>) => ({
  id: 't1',
  kind: 'pat',
  name: '빌드 서버',
  bundle: 'skill-dev',
  scopes: [],
  prefix: 'abcd1234',
  created: NOW - 86400,
  expires: NOW + 30 * 86400,
  last_used: NOW - 60,
  last_ip: '10.0.0.5',
  state: 'active',
  ended: null,
  ...over,
});
const DATA = (tokens: unknown[], over: Record<string, unknown> = {}) => ({
  tokens,
  bundles: { all: [], 'skill-dev': [], read: [] },
  expiry_days: [7, 30, 60, 90],
  default_days: 30,
  max: 10,
  mcp_url: 'https://aas.example/mcp',
  ...over,
});

describe('Claude Code 연결 화면', () => {
  it('빈 상태: 연결 명령이 주 행동이고, 「브라우저 없는 곳에서 쓰기」가 토큰 만들기 창을 연다. 모두 끊기는 없다', async () => {
    const user = userEvent.setup();
    stubApi({ '/api/me': ME, '/api/tokens': DATA([]) });
    mountScreen(<Connections />, '/connections');
    expect(await screen.findByTestId('conn-command')).toHaveTextContent('claude mcp add --scope user --transport http aas https://aas.example/mcp');
    expect(screen.getByTestId('conn-login')).toHaveTextContent('claude mcp login aas');
    expect(screen.queryByRole('button', { name: '모두 끊기' })).toBeNull();
    await user.click(screen.getByRole('button', { name: '브라우저 없는 곳에서 쓰기' }));
    expect(await screen.findByRole('dialog', { name: '토큰 만들기' })).toBeInTheDocument();
  });

  it('사설 CA 안내: 접혀 있다가 펼치면 연결 주소의 호스트로 만든 명령과 OS 별 등록 명령이 나온다', async () => {
    const user = userEvent.setup();
    stubApi({ '/api/me': ME, '/api/tokens': DATA([]) });
    mountScreen(<Connections />, '/connections');
    await screen.findByTestId('conn-command');
    expect(screen.queryByTestId('conn-ca-fetch')).toBeNull();
    await user.click(screen.getByRole('button', { name: /인증서 오류가 나면/ }));
    expect(await screen.findByTestId('conn-ca-fetch')).toHaveTextContent('-connect aas.example:443');
    expect(screen.getAllByTestId('conn-ca-register')).toHaveLength(2);   // 시험 환경(jsdom)은 platform 이 비어 Linux 탭이 먼저 열린다
    expect(screen.getAllByTestId('conn-ca-register')[0]).toHaveTextContent('update-ca-certificates');
    await user.click(screen.getByRole('tab', { name: 'macOS' }));
    expect(screen.getByTestId('conn-ca-register')).toHaveTextContent('security add-trusted-cert');
    expect(screen.getByTestId('conn-ca-curl')).toHaveTextContent('CURL_CA_BUNDLE');   // macOS 의 curl 은 키체인을 읽지 않는다
    await user.click(screen.getByRole('tab', { name: 'Windows (PowerShell)' }));
    expect(screen.getByTestId('conn-ca-fetch')).toHaveTextContent('SslStream');
    expect(screen.getByTestId('conn-ca-register')).toHaveTextContent('Import-Certificate');
    expect(screen.queryByTestId('conn-ca-curl')).toBeNull();
    expect(screen.queryByText(/NODE_EXTRA_CA_CERTS=|export /)).toBeNull();
  });

  it('http 주소(로컬 시험)에는 CA 안내를 보이지 않는다', async () => {
    stubApi({ '/api/me': ME, '/api/tokens': DATA([], { mcp_url: 'http://localhost:8080/mcp' }) });
    mountScreen(<Connections />, '/connections');
    await screen.findByTestId('conn-command');
    expect(screen.queryByRole('button', { name: /인증서 오류가 나면/ })).toBeNull();
  });

  it('구역: OAuth 와 수동을 나누고, 7일 안에 끝나는 수동 토큰은 「곧 끝남」, 끊기 단추 이름에 연결 이름', async () => {
    stubApi({
      '/api/me': ME,
      '/api/tokens': DATA([row({ id: 'o1', kind: 'oauth', name: 'Claude Code (aas)', bundle: 'all' }), row({ expires: NOW + 3 * 86400 })]),
    });
    mountScreen(<Connections />, '/connections');
    const pat = await screen.findByTestId('conn-row-t1');
    expect(within(pat).getByText(/곧 끝남/)).toHaveAttribute('data-expiring', 'yes');
    expect(within(pat).getByText('수동')).toBeInTheDocument();
    const oauth = screen.getByTestId('conn-row-o1');
    expect(within(oauth).getByText('OAuth')).toBeInTheDocument();
    expect(within(oauth).queryByText(/곧 끝남/)).toBeNull();
    expect(screen.getByRole('button', { name: 'Claude Code (aas) 연결 끊기' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '모두 끊기' })).toBeInTheDocument();
  });

  it('끊기: 확인한 뒤에만 보낸다. 실패하면 그 줄에 오류와 다시 시도', async () => {
    const user = userEvent.setup();
    let fail = true;
    const fn = stubApi({
      '/api/me': ME,
      '/api/tokens/revoke': () => (fail ? new Response(JSON.stringify({ error: '서버가 바쁩니다' }), { status: 503 }) : { ok: true }),
      '/api/tokens': DATA([row({})]),
    });
    mountScreen(<Connections />, '/connections');
    await user.click(await screen.findByRole('button', { name: '빌드 서버 연결 끊기' }));
    const dlg = await screen.findByRole('dialog');
    expect(dlg).toHaveTextContent('빌드 서버 을 쓰는 Claude Code 가 바로 끊깁니다');
    await user.click(within(dlg).getByRole('button', { name: '토큰 폐기' }));
    await waitFor(() => expect(postedTo(fn, '/api/tokens/revoke')).toEqual([{ id: 't1' }]));
    expect(await screen.findByText('서버가 바쁩니다')).toBeInTheDocument();
    fail = false;
    await user.click(await screen.findByRole('button', { name: '다시 시도' }));             // 확인창이 닫히며 바탕의 aria-hidden 이 풀린 뒤
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: '토큰 폐기' }));
    await waitFor(() => expect(screen.queryByText('서버가 바쁩니다')).toBeNull());
  });

  it('토큰 만들기: 원문은 한 번만, ESC 로 닫히지 않고 닫을 때 한 번 더 묻는다. 명령에는 원문이 없다', async () => {
    const user = userEvent.setup();
    const fn = stubApi({
      '/api/me': ME,
      '/api/tokens/create': { ok: true, token: row({ id: 'new' }), secret: 'aas_pat_SECRET123' },
      '/api/tokens': DATA([]),
    });
    mountScreen(<Connections />, '/connections');
    await user.click(await screen.findByRole('button', { name: '토큰 만들기' }));
    const dlg = await screen.findByRole('dialog', { name: '토큰 만들기' });
    const create = within(dlg).getByRole('button', { name: '만들기' });
    expect(create).toBeDisabled();
    await user.type(within(dlg).getByRole('textbox', { name: '이름' }), '빌드 서버');
    await user.click(within(dlg).getByRole('radio', { name: /읽기만/ }));
    await user.click(create);
    await waitFor(() => expect(postedTo(fn, '/api/tokens/create')).toEqual([{ name: '빌드 서버', bundle: 'read', days: 30 }]));
    const done = await screen.findByRole('dialog', { name: '토큰을 만들었습니다' });
    expect(within(done).getByTestId('conn-secret')).toHaveValue('aas_pat_SECRET123');
    expect(within(done).queryAllByText(/aas_pat_SECRET123/)).toHaveLength(0);                  // 원문은 입력칸 하나에만(글로 두 번 보이지 않는다)
    expect(within(done).getByTestId('conn-add-with-token')).not.toHaveTextContent('SECRET123');
    await user.keyboard('{Escape}');
    expect(screen.getByRole('dialog', { name: '토큰을 만들었습니다' })).toBeInTheDocument();
    await user.click(within(done).getByRole('button', { name: '닫기' }));
    const ask = await screen.findByText('토큰을 복사했나요? 닫으면 다시 볼 수 없습니다.');
    await user.click(within(ask.closest('[role="dialog"]') as HTMLElement).getByRole('button', { name: '닫기' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '토큰을 만들었습니다' })).toBeNull());
  });

  it('연결이 상한이면 만들기를 막고 안내한다', async () => {
    stubApi({ '/api/me': ME, '/api/tokens': DATA([row({ id: 'a' }), row({ id: 'b' })], { max: 2 }) });
    mountScreen(<Connections />, '/connections');
    expect(await screen.findByText(/연결은 2개까지입니다/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '토큰 만들기' })).toBeDisabled();
  });

  it('모두 끊기: 내 이메일을 적어야 누를 수 있고, 끝나면 로그인 화면으로', async () => {
    const user = userEvent.setup();
    const assign = vi.fn();
    vi.stubGlobal('location', { ...window.location, assign });
    const fn = stubApi({ '/api/me': ME, '/api/tokens/revoke-all': { ok: true, revoked: 2 }, '/api/tokens': DATA([row({})]) });
    mountScreen(<Connections />, '/connections');
    await user.click(await screen.findByRole('button', { name: '모두 끊기' }));
    const dlg = await screen.findByRole('dialog', { name: '모든 연결을 끊을까요?' });
    expect(dlg).toHaveTextContent('이 브라우저도 로그아웃됩니다');
    const ok = within(dlg).getByRole('button', { name: '모두 끊기' });
    expect(ok).toBeDisabled();
    await user.type(within(dlg).getByRole('textbox'), 'KIM@corp.example');
    await user.click(ok);
    await waitFor(() => expect(postedTo(fn, '/api/tokens/revoke-all')).toEqual([{ confirm: 'KIM@corp.example' }]));
    await waitFor(() => expect(assign).toHaveBeenCalledWith('/auth/login'));
  });

  // 「읽기만」에서 보내기가 빠진 뒤의 안내(스펙 2026-11-03-001 DD7·DD8·DD11)
  const NOTICE = /‘읽기만’ 연결은 이제 AI 에이전트에게 메시지를 보낼 수 없습니다/;

  it('반영 전에 만든 살아 있는 「읽기만」 연결이 있을 때만 목록 위에 안내 하나', async () => {
    localStorage.clear();
    stubApi({
      '/api/me': ME,
      '/api/tokens': DATA([
        row({ id: 'r1', bundle: 'read', read_send_removed: true }),
        row({ id: 'r2', kind: 'oauth', bundle: 'read', read_send_removed: true }),
        row({ id: 'r3', bundle: 'read', read_send_removed: true, state: 'revoked', ended: NOW - 60 }),
      ]),
    });
    mountScreen(<Connections />, '/connections');
    await screen.findByTestId('conn-row-r1');
    expect(screen.getAllByText(NOTICE)).toHaveLength(1);
    expect(screen.getByText(NOTICE).textContent).toContain('수동 토큰은 새로 만드세요');
  });

  it('새로 만든 「읽기만」·다른 묶음·끝난 연결만 있으면 안내가 없다', async () => {
    localStorage.clear();
    stubApi({
      '/api/me': ME,
      '/api/tokens': DATA([
        row({ id: 'r1', bundle: 'read', read_send_removed: false }),
        row({ id: 'r2', bundle: 'skill-dev', read_send_removed: false }),
        row({ id: 'r3', bundle: 'read', read_send_removed: true, state: 'expired', ended: NOW - 60 }),
      ]),
    });
    mountScreen(<Connections />, '/connections');
    await screen.findByTestId('conn-row-r1');
    expect(screen.queryByText(NOTICE)).toBeNull();
  });

  it('안내 닫기: 닫으면 사라지고 다시 열어도 보이지 않는다', async () => {
    localStorage.clear();
    const user = userEvent.setup();
    const api = { '/api/me': ME, '/api/tokens': DATA([row({ id: 'r1', bundle: 'read', read_send_removed: true })]) };
    stubApi(api);
    const { unmount } = mountScreen(<Connections />, '/connections');
    await screen.findByText(NOTICE);
    await user.click(screen.getByRole('button', { name: '안내 닫기' }));
    await waitFor(() => expect(screen.queryByText(NOTICE)).toBeNull());
    unmount();
    stubApi(api);
    mountScreen(<Connections />, '/connections');
    await screen.findByTestId('conn-row-r1');
    expect(screen.queryByText(NOTICE)).toBeNull();
    localStorage.clear();
  });

  it('저장소가 예외를 던져도 화면과 안내가 보이고 닫힌다', async () => {
    const user = userEvent.setup();
    const boom = () => {
      throw new Error('SecurityError');
    };
    const get = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(boom);
    const set = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(boom);
    try {
      stubApi({ '/api/me': ME, '/api/tokens': DATA([row({ id: 'r1', bundle: 'read', read_send_removed: true })]) });
      mountScreen(<Connections />, '/connections');
      expect(await screen.findByText(NOTICE)).toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: '안내 닫기' }));
      await waitFor(() => expect(screen.queryByText(NOTICE)).toBeNull());
      expect(screen.getByTestId('conn-row-r1')).toBeInTheDocument();
    } finally {
      get.mockRestore();
      set.mockRestore();
    }
  });

  it('만들기 창의 「읽기만」 설명은 보내지 못한다고 적는다', async () => {
    const user = userEvent.setup();
    stubApi({ '/api/me': ME, '/api/tokens': DATA([]) });
    mountScreen(<Connections />, '/connections');
    await user.click(await screen.findByRole('button', { name: '토큰 만들기' }));
    const dlg = await screen.findByRole('dialog', { name: '토큰 만들기' });
    expect(within(dlg).getByRole('radio', { name: '읽기만 — 대화를 보고 결과를 받습니다. 메시지는 보낼 수 없습니다' })).toBeInTheDocument();
  });

  it('로그인을 끈 설치는 안내만', async () => {
    stubApi({ '/api/tokens': new Response(JSON.stringify({ error: 'off', reason: 'login_off' }), { status: 404 }) });
    mountScreen(<Connections />, '/connections');
    expect(await screen.findByText('로그인을 켠 설치에서만 Claude Code 를 연결할 수 있습니다.')).toBeInTheDocument();
  });
});

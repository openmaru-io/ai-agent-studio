/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 게이트웨이 다시 시작 필요 — 상단 막대 아이콘·대화 상자·서랍 표시·메신저 알림(스펙 2026-11-18-016 4-5)
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { setLang } from '@/i18n';
import type { RestartItem, RestartPending } from '@/lib/data';
import { mountScreen, postedTo, stubApi } from '@/test/mountScreen';

import { MessengerRestart } from './MessengerRestart';
import {
  agoText,
  byText,
  closeRestartPending,
  kindText,
  openRestartPending,
  RestartPendingButton,
  RestartPendingDialog,
  RestartPendingPill,
} from './RestartPending';

afterEach(() => {
  vi.unstubAllGlobals();
  act(() => closeRestartPending());
  setLang('ko');
});

const NOW = Date.now() / 1000;
const item = (over: Partial<RestartItem> = {}): RestartItem => ({
  profile: 'main',
  kind: 'mcp',
  target: 'docmost',
  note: 'Docmost 도구 범위 바꾸기',
  by: 'kim@x.com',
  by_name: '김소유',
  by_kind: 'person',
  at: NOW - 180,
  ...over,
});
const pending = (items: RestartItem[], over: Partial<RestartPending> = {}): RestartPending => ({ items, total: items.length, has_members: false, ...over });
const ME = (rp?: RestartPending, extra: Record<string, unknown> = {}) => ({
  auth_enabled: true,
  admin: false,
  user: { email: 'kim@x.com', name: '김소유' },
  pod: { id: 'kim', owner: 'kim@x.com', ...(rp ? { restart_pending: rp } : {}), ...extra },
  pods: [],
});

function mount(me: unknown, routes: Record<string, unknown> = {}) {
  const fn = stubApi({ '/api/me': me, ...routes });
  const out = mountScreen(
    <>
      <RestartPendingButton />
      <RestartPendingDialog />
      <RestartPendingPill profile="main" />
    </>,
    '/'
  );
  return { fn, ...out };
}

describe('문구', () => {
  it('kind 여섯 가지(ko·en)', () => {
    const ko = [
      kindText(item()),
      kindText(item({ note: '' })),
      kindText(item({ kind: 'channel', target: 'telegram' })),
      kindText(item({ kind: 'pairing', target: '*' })),
      kindText(item({ kind: 'pairing', target: 'slack' })),
      kindText(item({ kind: 'env', target: 'MCP_DOCMOST_API_KEY' })),
      kindText(item({ kind: 'config', target: 'config.yaml' })),
      kindText(item({ kind: 'mindwiki', target: 'mindwiki' })),
    ];
    expect(ko).toEqual([
      'MCP 서버 docmost 설정(Docmost 도구 범위 바꾸기)',
      'MCP 서버 docmost 설정',
      '메신저 채널 telegram',
      '메신저 페어링 설정',
      '메신저 페어링 설정(slack)',
      '비밀값 MCP_DOCMOST_API_KEY',
      '설정 파일의 config.yaml',
      'MindWiki 연결 키 재발급',
    ]);
    setLang('en');
    expect(kindText(item({ note: '' }))).toBe('MCP server docmost settings');
    expect(kindText(item({ kind: 'pairing', target: '*' }))).toBe('Messenger pairing settings');
    expect(kindText(item({ kind: 'mindwiki' }))).toBe('MindWiki connection key reissued');
  });

  it('바꾼 사람과 상대 시각', () => {
    expect(byText(item())).toBe('김소유');
    expect(byText(item({ by_kind: 'mcp_tool' }))).toBe('김소유 · MCP 도구');
    expect(byText(item({ by_kind: 'auto', by: '', by_name: '' }))).toBe('자동');
    expect(agoText(NOW - 180, NOW * 1000)).toBe('3분 전');
    expect(agoText(0)).toBe('—');
  });
});

describe('상단 막대 아이콘', () => {
  it('기록이 있으면 배지와 함께 보이고, 없거나 다시 시작하는 중이면 숨는다', async () => {
    mount(ME(pending([item(), item({ target: 'outline' })])));
    const btn = await screen.findByRole('button', { name: '바꾼 설정 2건이 게이트웨이를 다시 시작해야 반영됩니다' });
    expect(within(btn).getByText('2')).toBeInTheDocument();
    expect(screen.getByTestId('restart-pending-live')).toHaveTextContent('바꾼 설정 2건');
  });

  it('없으면 숨는다', async () => {
    const { fn } = mount(ME(pending([])));
    await waitFor(() => expect(fn).toHaveBeenCalled());
    expect(screen.queryByTestId('restart-pending-button')).toBeNull();
  });

  it('다시 시작하는 중이면 숨는다', async () => {
    const { fn } = mount(ME(pending([item()]), { restarting: true }));
    await waitFor(() => expect(fn).toHaveBeenCalled());
    expect(screen.queryByTestId('restart-pending-button')).toBeNull();
  });

  it('좁은 화면에서도 보인다(넓은 화면 전용 표시가 없다)', async () => {
    mount(ME(pending([item()])));
    const btn = await screen.findByTestId('restart-pending-button');
    expect(getComputedStyle(btn).display).not.toBe('none');
  });
});

describe('대화 상자', () => {
  it('아이콘을 누르면 목록·경고·바깥 변경 안내가 순서대로 보이고 초점은 「나중에」', async () => {
    const user = userEvent.setup();
    mount(ME(pending([item()], { has_members: true })));
    await user.click(await screen.findByTestId('restart-pending-button'));
    const dlg = await screen.findByRole('dialog', { name: '게이트웨이 다시 시작 필요' });
    expect(within(dlg).getByText('바꾼 설정 1건이 게이트웨이를 다시 시작하면 반영됩니다.')).toBeInTheDocument();
    expect(within(dlg).getByText('MCP 서버 docmost 설정(Docmost 도구 범위 바꾸기)')).toBeInTheDocument();
    expect(within(dlg).getByText('3분 전')).toBeInTheDocument();
    expect(within(dlg).getByText(/함께 쓰는 사람의 대화·메신저도/)).toBeInTheDocument();
    expect(within(dlg).getByText(/AAS 밖/)).toBeInTheDocument();
    expect(within(dlg).getByRole('button', { name: '나중에' })).toHaveFocus();
  });

  it('쿠버네티스면 모든 프로파일이 멈춘다는 경고', async () => {
    mount(ME(pending([item()], { shared_gateway: true })));
    act(() => openRestartPending());
    expect(await screen.findByText(/게이트웨이 하나가 모든 프로파일을 돌립니다/)).toBeInTheDocument();
  });

  it('프로파일이 둘 이상이면 묶고 focusProfile 묶음이 맨 위', async () => {
    mount(ME(pending([item(), item({ profile: 'work', kind: 'env', target: 'K' })])));
    act(() => openRestartPending({ focusProfile: 'work' }));
    const dlg = await screen.findByRole('dialog');
    const groups = within(dlg).getAllByTestId(/restart-pending-group-/);
    expect(groups.map((g) => g.getAttribute('data-testid'))).toEqual(['restart-pending-group-work', 'restart-pending-group-main']);
  });

  it('20건을 넘으면 「외 N건」', async () => {
    const items = Array.from({ length: 20 }, (_, i) => item({ target: `s${i}` }));
    mount(ME(pending(items, { total: 23 })));
    act(() => openRestartPending());
    expect(await screen.findByText(/외 3건/)).toBeInTheDocument();
  });

  it('「지금 다시 시작」 성공: 요청 중 단추가 꺼지고, 닫고 알림', async () => {
    const user = userEvent.setup();
    let release: (v: unknown) => void = () => undefined;
    const { fn } = mount(ME(pending([item()])), { '/api/restart-pending/apply': { done: ['main'], failed: [] } });
    const base = fn.getMockImplementation()!;
    // 요청이 끝나기 전 상태를 보려고 다시 시작 요청만 붙잡아 둔다(stubApi 는 곧바로 답한다)
    fn.mockImplementation((url: string, init?: RequestInit) =>
      String(url).startsWith('/api/restart-pending/apply') ? new Promise((r) => (release = r)).then(() => base(url, init)) : base(url, init)
    );
    act(() => openRestartPending());
    const dlg = await screen.findByRole('dialog');
    await user.click(within(dlg).getByRole('button', { name: '지금 다시 시작' }));
    await waitFor(() => expect(within(dlg).getByRole('button', { name: '나중에' })).toBeDisabled());
    expect(within(dlg).getByRole('button', { name: '반영됨으로 표시' })).toBeDisabled();
    act(() => release(null));
    expect(await screen.findByText(/다시 시작을 요청했습니다/)).toBeInTheDocument();
    expect(postedTo(fn, '/api/restart-pending/apply')).toEqual([{ pod: 'kim' }]);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('일부 실패: 대화 상자에 남아 이유와 실패 표시, 「다시 시도」 두 번 뒤에는 안내', async () => {
    const user = userEvent.setup();
    const fail = () =>
      new Response(
        JSON.stringify({ error: 'x', reason: 'restart_failed', done: [], failed: [{ profile: 'main', reason: 'outcome_unknown', error: 'Hermes 응답 없음' }], asked_at: 123 }),
        { status: 502 }
      );
    const { fn } = mount(ME(pending([item()])), { '/api/restart-pending/apply': fail });
    act(() => openRestartPending());
    const dlg = await screen.findByRole('dialog');
    await user.click(within(dlg).getByRole('button', { name: '지금 다시 시작' }));
    expect(await within(dlg).findByText(/main — Hermes 응답 없음/)).toBeInTheDocument();
    expect(within(dlg).getByText('실패')).toBeInTheDocument();
    await user.click(within(dlg).getByRole('button', { name: '다시 시도' }));
    await waitFor(() => expect(postedTo(fn, '/api/restart-pending/apply')).toHaveLength(2));
    expect(postedTo(fn, '/api/restart-pending/apply')[1]).toEqual({ pod: 'kim', since: 123 });
    await user.click(await within(dlg).findByRole('button', { name: '다시 시도' }));
    expect(await within(dlg).findByText(/게이트웨이 상태를 확인하세요/)).toBeInTheDocument();
    expect(within(dlg).queryByRole('button', { name: '다시 시도' })).toBeNull();
    expect(within(dlg).getByRole('link', { name: '프로파일 서랍 열기' })).toBeInTheDocument();
  });

  it('409: 이미 다시 시작 중·잠금은 남은 초', async () => {
    const user = userEvent.setup();
    let reply = new Response(JSON.stringify({ error: 'x', reason: 'restart_in_progress' }), { status: 409 });
    mount(ME(pending([item()])), { '/api/restart-pending/apply': () => reply });
    act(() => openRestartPending());
    const dlg = await screen.findByRole('dialog');
    await user.click(within(dlg).getByRole('button', { name: '지금 다시 시작' }));
    expect(await within(dlg).findByText('이미 다시 시작하는 중입니다.')).toBeInTheDocument();
    reply = new Response(JSON.stringify({ error: 'x', reason: 'restart_locked', retry_after: 17 }), { status: 409 });
    await user.click(within(dlg).getByRole('button', { name: '지금 다시 시작' }));
    expect(await within(dlg).findByText(/17초 뒤 다시 하세요/)).toBeInTheDocument();
  });

  it('열려 있는 동안 기록이 0건이 되면 닫고 알림', async () => {
    let me = ME(pending([item()]));
    const { qc } = mount(() => me);
    await screen.findByTestId('restart-pending-button');
    act(() => openRestartPending());
    await screen.findByRole('dialog');
    me = ME(pending([]));
    await act(() => qc.invalidateQueries({ queryKey: ['me'] }));
    expect(await screen.findByText('바꾼 설정이 모두 반영됐습니다.')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('「반영됨으로 표시」: 일반 줄은 바로, MindWiki 줄은 확인', async () => {
    const user = userEvent.setup();
    const { fn } = mount(ME(pending([item({ kind: 'env', target: 'K' }), item({ kind: 'mindwiki', target: 'mindwiki', by_kind: 'auto' })])), {
      '/api/restart-pending/dismiss': { ok: true, removed: 1 },
    });
    act(() => openRestartPending());
    const dlg = await screen.findByRole('dialog', { name: '게이트웨이 다시 시작 필요' });
    const buttons = within(dlg).getAllByRole('button', { name: '반영됨으로 표시' });
    await user.click(buttons[0]);
    await waitFor(() => expect(postedTo(fn, '/api/restart-pending/dismiss')).toEqual([{ pod: 'kim', profile: 'main', kind: 'env', target: 'K' }]));
    await user.click(buttons[1]);
    expect(await screen.findByText(/MindWiki 키가 이미 반영됐다고 표시합니다/)).toBeInTheDocument();
    expect(postedTo(fn, '/api/restart-pending/dismiss')).toHaveLength(1);
  });
});

describe('다른 입구', () => {
  it('서랍 머리 「다시 시작 필요」는 그 프로파일에 기록이 있을 때 보이고 대화 상자를 연다', async () => {
    const user = userEvent.setup();
    mount(ME(pending([item(), item({ profile: 'work', target: 'x' })])));
    await user.click(await screen.findByRole('button', { name: '다시 시작 필요' }));
    const dlg = await screen.findByRole('dialog');
    expect(within(dlg).getAllByTestId(/restart-pending-group-/)[0]).toHaveAttribute('data-testid', 'restart-pending-group-main');
  });

  it('메신저 알림은 페어링·채널 기록이 있을 때만 보이고 대화 상자를 연다', async () => {
    const user = userEvent.setup();
    stubApi({ '/api/me': ME(pending([item({ kind: 'pairing', target: 'telegram' })])) });
    mountScreen(
      <>
        <MessengerRestart pod="kim" />
        <RestartPendingDialog />
      </>,
      '/'
    );
    await user.click(await screen.findByRole('button', { name: '자세히 보고 다시 시작' }));
    expect(await screen.findByRole('dialog', { name: '게이트웨이 다시 시작 필요' })).toBeInTheDocument();
  });

  it('메신저 알림은 MCP 기록만 있으면 보이지 않는다', async () => {
    const fn = stubApi({ '/api/me': ME(pending([item()])) });
    mountScreen(<MessengerRestart pod="kim" />, '/');
    await waitFor(() => expect(fn).toHaveBeenCalled());
    expect(screen.queryByRole('button', { name: '자세히 보고 다시 시작' })).toBeNull();
  });
});

/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 주소 서랍(useRouteDrawer)의 저장 확인·되돌림(스펙 2026-10-28-014 D6·D11)과 기록 되감기(D9), 같은 값 다시 열기(외부 검토 C2)
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, NavigateFunction, useLocation, useNavigate } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { DrawerHost } from './DrawerHost';
import { UiProvider, useUi } from './UiContext';
import { useOpenParam, useRouteDrawer, useRouteDrawerParams } from './useRouteDrawer';

let ui: ReturnType<typeof useUi>;
let nav: NavigateFunction;
let openRow: (v: string) => void;

/** 주소를 읽는 서랍 본문(프로파일 상세의 탭처럼 pane 을 읽는다) */
function Body({ v }: { v: string }) {
  const pane = useRouteDrawerParams('name').get('pane') ?? '없음';
  return (
    <p>
      본문 {v} 탭 {pane}
    </p>
  );
}

function Screen() {
  ui = useUi();
  nav = useNavigate();
  const write = useOpenParam('name');
  openRow = (v) => write({ name: v });
  useRouteDrawer('name', (v) => ({ title: `서랍 ${v}`, body: <Body v={v} /> }), ['pane']);
  const loc = useLocation();
  return <div data-testid="loc">{loc.pathname + loc.search}</div>;
}

/** 앞 칸(/start)에서 목록(/list…)으로 들어온 기록 */
function mount(at = '/list') {
  render(
    <MemoryRouter initialEntries={['/start', at]} initialIndex={1}>
      <UiProvider>
        <Screen />
        <DrawerHost />
      </UiProvider>
    </MemoryRouter>
  );
}
const loc = () => screen.getByTestId('loc').textContent;
const dialog = (v: string) => screen.queryByRole('dialog', { name: `서랍 ${v}` });

let answer = true;
const guard = vi.fn(async () => answer);
beforeEach(() => {
  answer = true;
  guard.mockClear();
});

describe('주소 서랍의 저장 확인(D6·D11)', () => {
  it('값이 사라질 때(뒤로 가기) 저장 확인을 묻고, 취소하면 앞 주소로 되돌려 서랍을 남긴다', async () => {
    mount();
    act(() => openRow('a'));
    expect(await screen.findByRole('dialog', { name: '서랍 a' })).toBeInTheDocument();
    act(() => ui.setCloseGuard('route:name', guard));
    answer = false;
    act(() => nav(-1));
    await waitFor(() => expect(guard).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(loc()).toBe('/list?name=a'));
    expect(dialog('a')).toBeInTheDocument();
    expect(guard).toHaveBeenCalledTimes(1); // 되돌린 주소로는 다시 묻지 않는다
  });

  it('확인하면 값이 사라질 때 서랍을 닫는다', async () => {
    mount('/list?name=a');
    expect(await screen.findByRole('dialog', { name: '서랍 a' })).toBeInTheDocument();
    act(() => ui.setCloseGuard('route:name', guard));
    act(() => nav('/list'));
    await waitFor(() => expect(dialog('a')).toBeNull());
    expect(guard).toHaveBeenCalledTimes(1);
    expect(loc()).toBe('/list');
  });

  it('값이 다른 값으로 바뀔 때도 묻고, 취소하면 앞 값과 서랍이 남는다', async () => {
    mount('/list?name=a');
    await screen.findByRole('dialog', { name: '서랍 a' });
    act(() => ui.setCloseGuard('route:name', guard));
    answer = false;
    act(() => nav('/list?name=b'));
    await waitFor(() => expect(loc()).toBe('/list?name=a'));
    expect(guard).toHaveBeenCalledTimes(1);
    expect(dialog('a')).toBeInTheDocument();
    expect(dialog('b')).toBeNull();
    answer = true;
    act(() => nav('/list?name=b'));
    expect(await screen.findByRole('dialog', { name: '서랍 b' })).toBeInTheDocument();
    expect(guard).toHaveBeenCalledTimes(2);
  });

  // OKE 2026-10-29: 묻는 동안 본문이 바뀐 주소(pane 없음)로 다시 그려져 편집기가 닫혔다. 묻는 동안·취소 뒤에도 본문은 묻기 전 값을 읽는다
  it('묻는 동안 본문은 묻기 전 주소 값을 읽는다: 뒤로 가기(D6)', async () => {
    mount();
    act(() => openRow('a'));
    act(() => nav('/list?name=a&pane=soul', { replace: true }));
    expect(await screen.findByText('본문 a 탭 soul')).toBeInTheDocument();
    let answerWith: (ok: boolean) => void = () => {};
    act(() => ui.setCloseGuard('route:name', () => new Promise<boolean>((r) => (answerWith = r))));
    act(() => nav(-1));
    expect(loc()).toBe('/list');
    expect(screen.getByText('본문 a 탭 soul')).toBeInTheDocument(); // 묻는 중
    await act(async () => answerWith(false));
    await waitFor(() => expect(loc()).toBe('/list?name=a&pane=soul'));
    expect(screen.getByText('본문 a 탭 soul')).toBeInTheDocument();
  });

  it('묻는 동안 본문은 묻기 전 주소 값을 읽는다: 다른 값으로 바뀜(D11)', async () => {
    mount('/list?name=a&pane=soul');
    expect(await screen.findByText('본문 a 탭 soul')).toBeInTheDocument();
    let answerWith: (ok: boolean) => void = () => {};
    act(() => ui.setCloseGuard('route:name', () => new Promise<boolean>((r) => (answerWith = r))));
    act(() => nav('/list?name=b'));
    expect(screen.getByText('본문 a 탭 soul')).toBeInTheDocument(); // 묻는 중
    await act(async () => answerWith(false));
    await waitFor(() => expect(loc()).toBe('/list?name=a&pane=soul'));
    expect(screen.getByText('본문 a 탭 soul')).toBeInTheDocument();
    // 확인(버림)이면 지금처럼 새 값의 본문이 주소를 읽는다
    act(() => nav('/list?name=b'));
    await act(async () => answerWith(true));
    expect(await screen.findByText('본문 b 탭 없음')).toBeInTheDocument();
    expect(dialog('a')).toBeNull();
  });

  it('저장 확인이 없으면 묻지 않고 곧바로 닫는다', async () => {
    mount('/list?name=a');
    await screen.findByRole('dialog', { name: '서랍 a' });
    act(() => nav('/list'));
    expect(dialog('a')).toBeNull();
  });
});

describe('서랍 기록(D9)', () => {
  it('화면 안에서 열고 닫으면 기록 길이가 열기 전과 같다: 닫은 뒤 뒤로 가기 한 번이면 앞 화면이다', async () => {
    const user = userEvent.setup();
    mount();
    act(() => openRow('a'));
    expect(loc()).toBe('/list?name=a');
    act(() => openRow('b')); // 열린 채 다른 대상은 replace
    expect(await screen.findByRole('dialog', { name: '서랍 b' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '닫기' }));
    await waitFor(() => expect(loc()).toBe('/list'));
    expect(screen.queryByRole('dialog')).toBeNull();
    act(() => nav(-1));
    expect(loc()).toBe('/start');
  });

  it('뒤로 가기는 화면 안에서 연 서랍을 닫는다', async () => {
    mount();
    act(() => openRow('a'));
    await screen.findByRole('dialog', { name: '서랍 a' });
    act(() => nav(-1));
    expect(loc()).toBe('/list');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('링크로 들어온 서랍을 닫으면 값과 딸린 값을 지우는 replace 다(되감을 칸이 없다)', async () => {
    const user = userEvent.setup();
    mount('/list?tab=x&name=a&pane=env');
    await screen.findByRole('dialog', { name: '서랍 a' });
    await user.click(screen.getByRole('button', { name: '닫기' }));
    expect(loc()).toBe('/list?tab=x');
    act(() => nav(-1));
    expect(loc()).toBe('/start'); // push 였다면 /list?…&name=a 로 돌아간다
  });

  it('닫기 단추의 저장 확인을 거절하면 서랍과 주소가 그대로다', async () => {
    const user = userEvent.setup();
    mount();
    act(() => openRow('a'));
    await screen.findByRole('dialog', { name: '서랍 a' });
    act(() => ui.setCloseGuard('route:name', guard));
    answer = false;
    await user.click(screen.getByRole('button', { name: '닫기' }));
    expect(guard).toHaveBeenCalledTimes(1);
    expect(loc()).toBe('/list?name=a');
    expect(dialog('a')).toBeInTheDocument();
  });
});

describe('같은 값으로 다시 열기(외부 검토 C2)', () => {
  it('서랍만 치운 뒤 같은 행을 누르면(주소 값은 같고 기록 칸만 새로) 다시 연다', async () => {
    mount();
    act(() => openRow('a'));
    await screen.findByRole('dialog', { name: '서랍 a' });
    act(() => ui.dismissDrawer()); // 검색 팔레트·「이 화면으로 열기」·가이드가 서랍만 치운 경우
    expect(screen.queryByRole('dialog')).toBeNull();
    act(() => openRow('a'));
    expect(await screen.findByRole('dialog', { name: '서랍 a' })).toBeInTheDocument();
    expect(loc()).toBe('/list?name=a');
  });
});

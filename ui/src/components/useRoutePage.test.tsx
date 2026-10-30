/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 목록 서랍 공용 훅(useRoutePage, 스펙 2026-10-28-014 D8·D10·D12·외부 검토 C2).
// 등록부의 본문(화면 모듈)은 가짜 본문으로 바꾼다 — 주소 → 페이지 → 서랍 규칙만 본다. 본문의 없는 대상 안내는 화면 시험이 본다
import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { mountScreen, stubApi } from '@/test/mountScreen';

import type { DrawerPage } from './drawerPages';
import { ListView } from './ListView';
import { useUi } from './UiContext';
import { useRoutePage } from './useRoutePage';

vi.mock('./drawerPages', async (orig) => {
  const real = await orig<typeof import('./drawerPages')>();
  return { ...real, drawerSpecFor: (page: DrawerPage) => ({ title: `틀 ${real.pageKey(page)}`, body: <p>본문 {real.pageKey(page)}</p> }) };
});

const ME = { auth_enabled: true, admin: true, user: { email: 'kim@x' }, pod: { id: 'p1', owner: 'kim@x' }, pods: [{ id: 'p1', owner: 'kim@x' }, { id: 'p2', owner: 'lee@x' }] };

let ui: ReturnType<typeof useUi>;
let route: ReturnType<typeof useRoutePage>;

type Row = { id: string };
function Screen({ view = 'skills', pod = true }: { view?: string; pod?: boolean }) {
  ui = useUi();
  route = useRoutePage(view, { pod });
  return (
    <ListView<Row>
      title="목록"
      tabs={[
        { id: 'a', label: '첫 탭', items: [{ id: 'x' }, { id: 'y' }] },
        { id: 'b', label: '둘째 탭', items: [{ id: 'x' }] },
      ]}
      columns={[{ id: 'id', label: '이름', value: (r) => r.id }]}
      rowId={(r) => r.id}
      onRow={(r) => route.openRow(r.id)}
      openId={route.open}
      clearOnTab={route.clearOnTab}
    />
  );
}

function mount(at: string, opts: { view?: string; pod?: boolean } = {}) {
  stubApi({ '/api/me': ME });
  return mountScreen(<Screen {...opts} />, at);
}
const loc = () => screen.getByTestId('loc').textContent;

afterEach(() => vi.unstubAllGlobals());

describe('목록 서랍 공용 훅', () => {
  it('행을 누르면 주소에 open 과 지금 POD 를 쓰고, 그 페이지 서랍을 연다. 닫으면 값이 지워진다', async () => {
    const user = userEvent.setup();
    const { qc } = mount('/skills');
    await waitFor(() => expect(qc.getQueryData(['me'])).toBeDefined()); // 지금 POD 를 안 뒤에 누른다
    await user.click(await screen.findByRole('row', { name: /^x/ }));
    await waitFor(() => expect(loc()).toBe('/skills?open=x&pod=p1'));
    expect(await screen.findByRole('dialog', { name: '틀 skill:x' })).toBeInTheDocument();
    expect(ui.drawer?.id).toBe('route:open');
    expect(ui.drawer?.keep).toBe(true);
    await user.click(screen.getByRole('button', { name: '닫기' }));
    await waitFor(() => expect(loc()).toBe('/skills'));
  });

  it('같은 값으로 다시 들어오면(서랍만 치운 뒤 같은 행) 다시 연다', async () => {
    const user = userEvent.setup();
    mount('/skills?open=x');
    await screen.findByRole('dialog', { name: '틀 skill:x' });
    act(() => ui.dismissDrawer());
    expect(screen.queryByRole('dialog')).toBeNull();
    await user.click(await screen.findByRole('row', { name: /^x/ }));
    expect(await screen.findByRole('dialog', { name: '틀 skill:x' })).toBeInTheDocument();
  });

  it('탭을 바꾸면 open·pod 를 지우고 서랍을 닫는다(D12)', async () => {
    const user = userEvent.setup();
    mount('/skills?open=x&pod=p1');
    await screen.findByRole('dialog', { name: '틀 skill:x' });
    await user.click(screen.getByRole('tab', { name: /둘째 탭/, hidden: true }));
    await waitFor(() => expect(loc()).toBe('/skills?tab=b'));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('탭을 바꿀 때 저장 확인을 취소하면 앞 탭과 서랍이 남는다', async () => {
    const user = userEvent.setup();
    mount('/skills?open=x');
    await screen.findByRole('dialog', { name: '틀 skill:x' });
    const ask = vi.fn(async () => false);
    act(() => ui.setCloseGuard('route:open', ask));
    await user.click(screen.getByRole('tab', { name: /둘째 탭/, hidden: true }));
    await waitFor(() => expect(ask).toHaveBeenCalled());
    await waitFor(() => expect(loc()).toBe('/skills?open=x'));
    expect(screen.getByRole('dialog', { name: '틀 skill:x' })).toBeInTheDocument();
  });

  it('open 은 탭과 함께 읽는다: 모델 화면 tab=profiles&open=x 는 프로파일 페이지다', async () => {
    mount('/models?tab=profiles&open=ma', { view: 'models' });
    expect(await screen.findByRole('dialog', { name: '틀 profile:name=ma' })).toBeInTheDocument();
  });

  it('pod 가 없는 옛 링크는 지금 POD 로 연다', async () => {
    mount('/cron?open=ma/j1', { view: 'cron' });
    expect(await screen.findByRole('dialog', { name: '틀 cronJob:ma/j1' })).toBeInTheDocument();
    expect(loc()).toBe('/cron?open=ma/j1');
  });

  // 사용자 결정 D14(2026-10-29): 다른 POD 의 링크는 볼 수 있는 POD 든 아니든 바꿔 열지 않는다. 전환 확인(LinkPodSwitch)은 묻지 않는다
  it.each(['p9', 'p2'])('다른 POD(%s) 의 링크는 지금 POD 의 같은 이름을 열지 않고, 알린 뒤 open·pod 를 지운다(D10·D14)', async (pod) => {
    mount(`/skills?tab=b&open=x&pod=${pod}`);
    expect(await screen.findByText('다른 AI 에이전트 작업공간의 링크라 상세를 열지 않았습니다.')).toBeInTheDocument();
    await waitFor(() => expect(loc()).toBe('/skills?tab=b'));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('지금 POD 와 같은 pod 의 링크는 연다', async () => {
    mount('/skills?open=x&pod=p1');
    expect(await screen.findByRole('dialog', { name: '틀 skill:x' })).toBeInTheDocument();
    expect(loc()).toBe('/skills?open=x&pod=p1');
  });

  it('pod 를 쓰지 않는 화면(에이전트)은 pod 값을 보지 않고 쓰지도 않는다', async () => {
    const user = userEvent.setup();
    mount('/agents?open=x&pod=p9', { view: 'agents', pod: false });
    expect(await screen.findByRole('dialog', { name: '틀 agent:x' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '닫기' }));
    await waitFor(() => expect(loc()).toBe('/agents'));
    await user.click(await screen.findByRole('row', { name: /^y/ }));
    await waitFor(() => expect(loc()).toBe('/agents?open=y'));
  });
});

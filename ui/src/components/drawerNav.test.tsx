/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 서랍 안 기록(스펙 2026-10-26-003): 같은 서랍에서 열기·이전·이후·저장 확인·주소 서랍 첫 페이지 새로 고침.
// 등록부의 본문(화면 모듈)은 이 시험의 가짜 본문으로 바꾼다 — 기록 규칙만 본다
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ReactElement, useEffect, useState } from 'react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';

import { LinkChip } from './bits';
import { DrawerHost } from './DrawerHost';
import type { DrawerPage } from './drawerPages';
import { pageDrawer, pageFromLink, pageHref, pageKey } from './drawerPages';
import { useDrawerGuard, useDrawerHead } from './drawerScope';
import { DRAWER_HISTORY_MAX, UiProvider, useUi } from './UiContext';
import { useRouteDrawer } from './useRouteDrawer';

vi.mock('./drawerPages', async (orig) => {
  const real = await orig<typeof import('./drawerPages')>();
  return {
    ...real,
    drawerSpecFor: (page: DrawerPage) => ({ title: `틀 ${real.pageKey(page)}`, wide: page.kind === 'skillMap', body: <FakePage page={page} /> }),
  };
});

let failKey = '';
const guardFor: Record<string, () => boolean> = {};

function FakePage({ page }: { page: DrawerPage }) {
  const key = pageKey(page);
  if (failKey === key) throw new Error('묶음을 받지 못함');
  useDrawerHead({ title: `제목 ${key}` });
  const guard = useDrawerGuard();
  useEffect(() => {
    const g = guardFor[key];
    if (!g) return;
    guard(g);
    return () => guard(null);
  }, [guard, key]);
  return (
    <div data-testid="page">
      본문 {key}
      <LinkChip to="skills" params={{ open: 'b' }} page={{ kind: 'skill', id: 'b' }}>
        스킬 b
      </LinkChip>
      <LinkChip to="flows" params={{ root: 'skill:b' }} page={{ kind: 'skillMap', root: 'skill:b' }}>
        연결도 b
      </LinkChip>
    </div>
  );
}

function Where() {
  const loc = useLocation();
  return <div data-testid="loc">{loc.pathname + loc.search}</div>;
}

let ui: ReturnType<typeof useUi>;
function Grab() {
  ui = useUi();
  return null;
}

function RootBody() {
  return (
    <p>
      첫 본문
      <LinkChip to="skills" params={{ open: 'a' }} page={{ kind: 'skill', id: 'a' }}>
        스킬 a
      </LinkChip>
    </p>
  );
}

function mount(extra?: ReactElement) {
  render(
    <MemoryRouter initialEntries={['/profiles?name=ma']}>
      <UiProvider>
        <Grab />
        {extra}
        <DrawerHost />
        <Where />
      </UiProvider>
    </MemoryRouter>
  );
}

// pageDrawer 는 진짜 drawerSpecFor 를 부르므로 첫 페이지 내용을 준다(가짜 본문)
const pageA = () => pageDrawer({ kind: 'skill', id: 'a' }, { title: '스킬 a', body: <FakePage page={{ kind: 'skill', id: 'a' }} /> });
const title = () => screen.getByRole('heading', { level: 2 });
const back = () => screen.getByRole('button', { name: '이전' });
const fwd = () => screen.getByRole('button', { name: '이후' });

async function openRoot(spec: Partial<Parameters<typeof ui.openDrawer>[0]> = {}) {
  act(() => void ui.openDrawer({ title: '첫 서랍', body: <RootBody />, id: 'route:name', keep: true, ...spec }));
  return screen.findByRole('dialog', { name: '첫 서랍' });
}

describe('서랍 안 기록', () => {
  it('서랍 안 링크는 메뉴를 옮기지 않고 같은 서랍에 열고, 이전·이후로 오간다(T1·T2)', async () => {
    const user = userEvent.setup();
    mount();
    await openRoot();
    expect(screen.queryByRole('button', { name: '이전' })).toBeNull(); // 첫 페이지에는 단추가 없다
    await user.click(screen.getByRole('link', { name: '스킬 a' }));
    expect(await screen.findByTestId('page')).toHaveTextContent('본문 skill:a');
    expect(title()).toHaveTextContent('제목 skill:a'); // 본문이 채운 머리
    expect(screen.getByTestId('loc')).toHaveTextContent('/profiles?name=ma'); // 메뉴(주소) 그대로
    expect(back()).toBeEnabled();
    expect(fwd()).toBeDisabled();
    expect(title()).toHaveFocus(); // 페이지를 옮기면 제목에 초점(M4)

    await user.click(screen.getByRole('link', { name: '연결도 b' }));
    expect(await screen.findByTestId('page')).toHaveTextContent('본문 skillMap:skill:b');
    expect(ui.drawer?.wide).toBe(true); // 스킬 연결도는 넓은 서랍(§5-5)

    await user.click(back());
    expect(await screen.findByTestId('page')).toHaveTextContent('본문 skill:a');
    expect(ui.drawer?.wide).toBeFalsy();
    await user.click(back());
    expect(screen.getByText('첫 본문')).toBeInTheDocument();
    expect(title()).toHaveTextContent('첫 서랍');
    expect(back()).toBeDisabled();
    await user.click(fwd());
    expect(await screen.findByTestId('page')).toHaveTextContent('본문 skill:a');
    expect(ui.drawer?.id).toBe('route:name'); // 서랍 자리(id·keep)는 그대로
    expect(ui.drawer?.keep).toBe(true);
  });

  it('이전으로 간 뒤 새 링크를 누르면 앞 기록을 버리고, 같은 대상은 쌓지 않고, 30개를 넘지 않는다(T3)', async () => {
    const user = userEvent.setup();
    mount();
    await openRoot();
    await user.click(screen.getByRole('link', { name: '스킬 a' }));
    await user.click(await screen.findByRole('link', { name: '스킬 b' }));
    await user.click(back());
    await user.click(await screen.findByRole('link', { name: '연결도 b' }));
    expect(ui.drawer?.history?.pages.map((e) => (e.page ? pageKey(e.page) : 'root'))).toEqual(['root', 'skill:a', 'skillMap:skill:b']);
    expect(fwd()).toBeDisabled();
    await act(() => ui.navigateDrawer({ kind: 'skillMap', root: 'skill:b' })); // 지금 대상과 같다
    expect(ui.drawer?.history?.pages).toHaveLength(3);
    for (let i = 0; i < DRAWER_HISTORY_MAX + 5; i++) await act(() => ui.navigateDrawer({ kind: 'skill', id: `s${i}` }));
    expect(ui.drawer?.history?.pages).toHaveLength(DRAWER_HISTORY_MAX);
    expect(ui.drawer?.history?.index).toBe(DRAWER_HISTORY_MAX - 1);
  });

  it('저장하지 않은 편집이 있으면 링크·이전·이후 모두 확인을 묻고, 거절하면 옮기지 않는다(T4)', async () => {
    const user = userEvent.setup();
    mount();
    await openRoot();
    let ok = false;
    const ask = vi.fn(() => ok);
    act(() => ui.setCloseGuard('route:name', ask));
    await user.click(screen.getByRole('link', { name: '스킬 a' }));
    expect(ask).toHaveBeenCalledTimes(1);
    expect(screen.getByText('첫 본문')).toBeInTheDocument();
    ok = true;
    await user.click(screen.getByRole('link', { name: '스킬 a' }));
    expect(await screen.findByTestId('page')).toHaveTextContent('본문 skill:a');
    // 옮긴 뒤에는 앞 페이지의 확인이 지워지고 새 페이지가 건 확인이 쓰인다(P7)
    guardFor['skillMap:skill:b'] = vi.fn(() => false);
    await user.click(screen.getByRole('link', { name: '연결도 b' }));
    expect(await screen.findByTestId('page')).toHaveTextContent('본문 skillMap:skill:b');
    expect(ask).toHaveBeenCalledTimes(2);
    await user.click(back());
    expect(guardFor['skillMap:skill:b']).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('page')).toHaveTextContent('본문 skillMap:skill:b'); // 거절 → 그대로
    delete guardFor['skillMap:skill:b'];
  });

  it('서랍 밖 링크·page 없는 링크·Ctrl 클릭은 지금처럼 메뉴를 옮긴다(T6)', async () => {
    const user = userEvent.setup();
    mount(
      <LinkChip to="skills" params={{ open: 'z' }} page={{ kind: 'skill', id: 'z' }}>
        밖 링크
      </LinkChip>
    );
    await user.click(screen.getByRole('link', { name: '밖 링크' }));
    expect(screen.getByTestId('loc')).toHaveTextContent('/skills?open=z');
    await openRoot();
    const link = screen.getByRole('link', { name: '스킬 a' });
    expect(link).toHaveAttribute('href', '/skills?open=a'); // 새 탭으로 열 주소는 그대로
    // jsdom 은 링크의 기본 이동(새 탭)을 하지 못해 오류를 찍는다. 화면 코드가 다 본 뒤 문서에서 막는다
    const stop = (e: Event) => e.preventDefault();
    document.addEventListener('click', stop);
    await user.keyboard('{Control>}');
    await user.click(link);
    await user.keyboard('{/Control}');
    document.removeEventListener('click', stop);
    expect(ui.drawer?.history).toBeUndefined(); // 서랍 안에서 옮기지 않았다
  });

  it('기록을 가진 임시 서랍 위에서 연 서랍은 쌓이고, 닫으면 그 기록 위치로 돌아온다(T8·H1)', async () => {
    const user = userEvent.setup();
    mount();
    act(() => void ui.openDrawer(pageA()));
    await user.click(await screen.findByRole('link', { name: '연결도 b' }));
    expect(await screen.findByTestId('page')).toHaveTextContent('본문 skillMap:skill:b');
    act(() => void ui.openDrawer({ title: '주기 바꾸기', body: <p>위 서랍</p> }));
    expect(ui.drawers).toHaveLength(2);
    await act(() => ui.closeDrawer());
    expect(ui.drawers).toHaveLength(1);
    expect(ui.drawer?.history?.index).toBe(1);
    expect(screen.getByTestId('page')).toHaveTextContent('본문 skillMap:skill:b');
  });

  it('주소 서랍의 첫 페이지만 새로 고치고, 옮긴 페이지·기록·위 서랍은 그대로다(T11·H5)', async () => {
    const user = userEvent.setup();
    mount();
    await openRoot();
    await user.click(screen.getByRole('link', { name: '스킬 a' }));
    act(() => void ui.openDrawer({ title: '위', body: <p>위 서랍</p> }));
    let found = false;
    act(() => void (found = ui.refreshRoot('route:name', { title: '새 첫 서랍', body: <p>새 첫 본문</p> })));
    expect(found).toBe(true);
    expect(ui.drawers).toHaveLength(2); // 위 서랍이 남는다
    await act(() => ui.closeDrawer());
    expect(screen.getByTestId('page')).toHaveTextContent('본문 skill:a');
    await user.click(back());
    expect(screen.getByText('새 첫 본문')).toBeInTheDocument();
    expect(title()).toHaveTextContent('새 첫 서랍');
    expect(ui.refreshRoot('route:none', { title: 'x', body: null })).toBe(false);
  });

  it('목록이 다시 읽어 바꾼 내용은 첫 페이지에 들고, 다른 페이지를 보고 있으면 그대로 둔다', async () => {
    const user = userEvent.setup();
    mount();
    let k = 0;
    act(() => void (k = ui.openDrawer(pageA())));
    await user.click(await screen.findByRole('link', { name: '연결도 b' }));
    act(() => ui.updateDrawer(k, { title: '스킬 a(새)', body: <p>새 행</p> }));
    expect(screen.getByTestId('page')).toHaveTextContent('본문 skillMap:skill:b');
    await user.click(back());
    expect(screen.getByText('새 행')).toBeInTheDocument();
  });

  it('첫 페이지로 되돌리기는 저장 확인을 묻는다(가이드, H4)', async () => {
    const user = userEvent.setup();
    mount();
    await openRoot();
    guardFor['skill:a'] = () => false;
    await user.click(screen.getByRole('link', { name: '스킬 a' }));
    await waitFor(() => expect(screen.getByTestId('page')).toBeInTheDocument());
    let res = true;
    await act(async () => void (res = await ui.drawerHome('route:name')));
    expect(res).toBe(false);
    delete guardFor['skill:a'];
    act(() => ui.setCloseGuard('route:name', null));
    await act(async () => void (res = await ui.drawerHome('route:name')));
    expect(res).toBe(true);
    expect(screen.getByText('첫 본문')).toBeInTheDocument();
  });

  it('페이지 본문이 실패하면 그 서랍 안에만 오류를 보인다(T13·C2)', async () => {
    const user = userEvent.setup();
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mount();
    await openRoot();
    failKey = 'skill:a';
    await user.click(screen.getByRole('link', { name: '스킬 a' }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByRole('alert')).toHaveTextContent('묶음을 받지 못함');
    failKey = '';
    await user.click(back()); // 이전으로 돌아가면 새 경계라 다시 보인다
    expect(screen.getByText('첫 본문')).toBeInTheDocument();
    spy.mockRestore();
  });

  it('「이 화면으로 열기」는 서랍을 치우고 그 페이지의 메뉴로 옮긴다(T5)', async () => {
    const user = userEvent.setup();
    mount();
    await openRoot();
    await user.click(screen.getByRole('link', { name: '스킬 a' }));
    await user.click(await screen.findByRole('button', { name: '이 화면으로 열기' }));
    expect(screen.getByTestId('loc')).toHaveTextContent('/skills?tab=all&open=a');
    expect(ui.drawers).toHaveLength(0);
  });

  it('「이 화면으로 열기」 주소에는 받아 둔 내 정보의 지금 POD 를 함께 쓴다(스펙 2026-10-28-014 D10)', async () => {
    const user = userEvent.setup();
    const qc = new QueryClient();
    qc.setQueryData(['me'], { pod: { id: 'p1', owner: 'kim@x' }, pods: [] });
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={['/profiles?name=ma']}>
          <UiProvider>
            <Grab />
            <DrawerHost />
            <Where />
          </UiProvider>
        </MemoryRouter>
      </QueryClientProvider>
    );
    await openRoot();
    await user.click(screen.getByRole('link', { name: '스킬 a' }));
    await user.click(await screen.findByRole('button', { name: '이 화면으로 열기' }));
    expect(screen.getByTestId('loc')).toHaveTextContent('/skills?tab=all&open=a&pod=p1');
  });

  it('임시 서랍을 치우면 그 서랍의 저장 확인도 지운다', async () => {
    mount();
    const spec = pageA();
    act(() => void ui.openDrawer(spec));
    const ask = vi.fn(() => false);
    act(() => ui.setCloseGuard(spec.id as string, ask));
    act(() => ui.dismissTransient());
    expect(await ui.runGuard(spec.id as string)).toBe(true);
    expect(ask).not.toHaveBeenCalled();
  });
});

describe('주소 서랍(useRouteDrawer)', () => {
  let setDep: (v: string) => void;
  let setPod: (v: string) => void;
  function Screen() {
    const [dep, sd] = useState('1');
    const [pod, sp] = useState('a');
    setDep = sd;
    setPod = sp;
    useRouteDrawer('name', (name) => ({ title: `${name} ${dep}`, body: <RootBody /> }), [], [dep], [pod]);
    return null;
  }

  it('deps 만 바뀌면 첫 페이지 내용만 바꾸고, resetOn 이 바뀌면 기록을 첫 페이지 하나로 되돌린다(T11·M5)', async () => {
    const user = userEvent.setup();
    mount(<Screen />);
    expect(await screen.findByRole('dialog', { name: 'ma 1' })).toBeInTheDocument();
    await user.click(screen.getByRole('link', { name: '스킬 a' }));
    act(() => void ui.openDrawer({ title: '위', body: <p>위 서랍</p> }));
    act(() => setDep('2'));
    expect(ui.drawers).toHaveLength(2); // 위 서랍·옮긴 페이지가 남는다
    expect(ui.drawers[0].history?.index).toBe(1);
    await act(() => ui.closeDrawer());
    await user.click(back());
    expect(title()).toHaveTextContent('ma 2'); // 새 deps 로 만든 첫 페이지
    await user.click(fwd());
    act(() => setPod('b'));
    expect(title()).toHaveTextContent('ma 2');
    expect(ui.drawer?.history).toBeUndefined(); // 새로 열어 기록이 없다
  });
});

describe('페이지 등록부', () => {
  it('서버 링크 중 서랍이 있는 것만 페이지로 바꾼다(H3)', () => {
    expect(pageFromLink('skills', { open: 'ma:report' })).toEqual({ kind: 'skill', id: 'ma:report' });
    expect(pageFromLink('flows', { root: 'skill:x' })).toEqual({ kind: 'skillMap', root: 'skill:x' });
    expect(pageFromLink('cron', { open: 'ma/j1' })).toEqual({ kind: 'cronJob', profile: 'ma', id: 'j1' });
    expect(pageFromLink('cron', { tab: 'jobs', q: 'daily' })).toBeNull(); // 목록 필터
    expect(pageFromLink('tools', { tab: 'all', q: 'run.py' })).toBeNull();
    expect(pageFromLink('skills', { lens: 'mcp:chart' })).toBeNull();
    // 2단계: 프로파일(탭·값은 extra)·에이전트
    expect(pageFromLink('profiles', { name: 'ma', pane: 'env', key: 'X', server: '' })).toEqual({ kind: 'profile', name: 'ma', pane: 'env', extra: { key: 'X' } });
    expect(pageFromLink('profiles', { name: 'ma' })).toEqual({ kind: 'profile', name: 'ma' });
    expect(pageFromLink('profiles', { tab: 'all' })).toBeNull();
    expect(pageFromLink('agents', { open: 'p2' })).toEqual({ kind: 'agent', pod: 'p2' });
  });

  // 스펙 2026-10-28-014 D8·D10·D12: 주소 꼴은 pageHref·pageFromLink 한 쌍이 정한다. 둘이 어긋나면 링크가 다른 서랍을 연다
  it.each([
    { kind: 'skill', id: 'ma:report' },
    { kind: 'skill', id: 'report', prefer: 'ops' },
    { kind: 'skillMap', root: 'skill:ma:report' },
    { kind: 'cronJob', profile: 'ma', id: 'j1' },
    { kind: 'profile', name: 'ma', pane: 'tools', extra: { server: 'chart' } },
    { kind: 'agent', pod: 'p2' },
    { kind: 'model', id: 'qwen3' },
    { kind: 'channel', name: 'ma' },
    { kind: 'user', key: 'u-1' },
    // 크론 탭의 id 공간(T7): 사고 탭은 사고 id, 프로파일 탭은 프로파일 이름. 작업 탭은 위 cronJob(「프로파일/작업」)
    { kind: 'cronIncident', id: 'i1' },
    { kind: 'cronIncident', id: 'i2', settled: true },
    { kind: 'cronProfile', name: 'ma' },
  ] as DrawerPage[])('pageHref 가 만든 주소로 다시 들어오면 같은 페이지다: $kind', (page) => {
    for (const pod of [undefined, 'p1']) {
      const href = pageHref(page, pod);
      const [path, search] = href.split('?');
      const q = new URLSearchParams(search);
      expect(pageFromLink(path.slice(1), Object.fromEntries(q)), href).toEqual(page);
      // pod 는 목록 서랍 주소에만 쓴다(에이전트는 값이 POD id, 사람 관리는 POD 와 관계없음, D10)
      expect(q.get('pod'), href).toBe(pod && ['skill', 'cronJob', 'model', 'channel', 'cronIncident', 'cronProfile'].includes(page.kind) ? pod : null);
    }
  });

  it('open 은 탭과 함께 읽는다(D12): 탭마다 id 공간이 다르다', () => {
    expect(pageFromLink('models', { open: 'qwen3' })).toEqual({ kind: 'model', id: 'qwen3' });
    expect(pageFromLink('models', { tab: 'models', open: 'qwen3' })).toEqual({ kind: 'model', id: 'qwen3' });
    expect(pageFromLink('models', { tab: 'profiles', open: 'ma' })).toEqual({ kind: 'profile', name: 'ma' });
    expect(pageFromLink('cron', { tab: 'jobs', open: 'ma/j1' })).toEqual({ kind: 'cronJob', profile: 'ma', id: 'j1' });
    // 크론 탭 7개의 id 공간(T7): 작업 탭 「프로파일/작업」, 사고 탭(실패 중·이미 해결) 사고 id, 프로파일 탭 프로파일 이름.
    // 실패·멈춤·알림 없음·무시 탭은 주소 서랍이 없다(행 id 는 「프로파일/작업」이지만 그 탭의 요약 서랍은 주소에 넣지 않는다)
    expect(pageFromLink('cron', { open: 'ma/j1' })).toEqual({ kind: 'cronJob', profile: 'ma', id: 'j1' }); // 탭 없는 옛 링크 = 작업 탭
    expect(pageFromLink('cron', { tab: 'incidents', open: 'i1' })).toEqual({ kind: 'cronIncident', id: 'i1' });
    expect(pageFromLink('cron', { tab: 'settled', open: 'i2' })).toEqual({ kind: 'cronIncident', id: 'i2', settled: true });
    expect(pageFromLink('cron', { tab: 'profiles', open: 'ma' })).toEqual({ kind: 'cronProfile', name: 'ma' });
    for (const tab of ['failed_jobs', 'stalled', 'silent', 'muted']) expect(pageFromLink('cron', { tab, open: 'ma/j1' }), tab).toBeNull();
    expect(pageFromLink('cron', { tab: 'jobs', q: 'ma' })).toBeNull(); // 목록 필터 링크는 서랍이 없다
    expect(pageFromLink('skills', { tab: 'all', profile: '*', open: 'report' })).toEqual({ kind: 'skill', id: 'report' }); // 전체 프로파일은 고르지 않는다
    expect(pageFromLink('skills', { tab: 'all', profile: 'ops', open: 'report', pod: 'p1' })).toEqual({ kind: 'skill', id: 'report', prefer: 'ops' });
  });

  it('같은 대상 비교는 보이는 이름을 보지 않고, 주소는 그 메뉴의 서랍 주소다', () => {
    expect(pageKey({ kind: 'cronJob', profile: 'ma', id: 'j1', label: '아침' })).toBe(pageKey({ kind: 'cronJob', profile: 'ma', id: 'j1' }));
    expect(pageHref({ kind: 'cronJob', profile: 'ma', id: 'j1' })).toBe('/cron?open=ma%2Fj1');
    expect(pageHref({ kind: 'skillMap', root: 'skill:ma:report' })).toBe('/flows?root=skill%3Ama%3Areport');
    expect(pageHref({ kind: 'skill', id: 'ma:report' })).toBe('/skills?tab=all&open=ma%3Areport');
    expect(pageHref({ kind: 'profile', name: 'ma', pane: 'tools', extra: { server: 'chart' } })).toBe('/profiles?name=ma&pane=tools&server=chart');
    expect(pageKey({ kind: 'profile', name: 'ma', extra: { b: '2', a: '1' } })).toBe(pageKey({ kind: 'profile', name: 'ma', extra: { a: '1', b: '2' } }));
    expect(pageKey({ kind: 'profile', name: 'ma', pane: 'env' })).not.toBe(pageKey({ kind: 'profile', name: 'ma' }));
  });
});

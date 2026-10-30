/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FakeES } from '@/test/fakeEventSource';
import { HistoryBack, ME_USER, mountScreen, postedTo, stubApi } from '@/test/mountScreen';
import { listAgents, pickAgent } from '@/test/pickAgent';

import { Office } from './Office';

vi.mock('@/features/office/OfficeScene', () => ({ default: () => <div /> }));

// 칸반 보드 토픽의 받는 함수를 잡아 두고 시험이 서버 push 를 흉내 낸다. 다른 토픽은 그대로 둔다
const pushed = vi.hoisted(() => ({ board: null as ((d: unknown) => void) | null }));
vi.mock('@/lib/ws', async (orig) => {
  const real = await orig<typeof import('@/lib/ws')>();
  return {
    ...real,
    useTopic: (topic: string | null, onData: (d: unknown) => void, client?: Parameters<typeof real.useTopic>[2]) => {
      const live = real.useTopic(topic, onData, client);
      if (topic?.startsWith('office:kanban:')) pushed.board = onData;
      return live;
    },
  };
});

const OFFICE = {
  seats: [
    { alias: 'ma', pod: 'one', profile: 'ma', enabled: true, title: '', role: '', team: '', note: '' },
    { alias: 'qa', pod: 'two', profile: 'qa', enabled: true, title: '', role: '', team: '', note: '' },
  ],
  rooms: [],
  pods: [],
  problems: [],
  can_edit: true,
};
const card = (id: string, status: string, extra = {}) => ({
  id,
  title: `카드 ${id}`,
  assignee: 'ma',
  status,
  priority: 0,
  ...extra,
});
const BOARD = {
  columns: [
    { name: 'ready', tasks: [card('t1', 'ready', { priority: 2 })] },
    { name: 'running', tasks: [card('t2', 'running')] },
    { name: 'review', tasks: [card('t3', 'review', { comment_count: 1 })] },
    { name: 'done', tasks: [] },
    { name: 'archived', tasks: [card('t9', 'archived')] },
  ],
};
const DETAIL = (status: string) => ({
  task: card('t3', status, { body: '견적서 **초안**', created_at: 1760000000 }),
  comments: [{ id: 1, author: 'ma', body: '초안을 올렸습니다', created_at: 1760000100 }],
  runs: [{ id: 1, profile: 'ma', outcome: 'completed', started_at: 1760000000 }],
});

beforeEach(() => {
  FakeES.all = [];
  localStorage.clear(); // 접은 칸 상태가 시험 사이에 새지 않게(OMAI-1163)
  vi.stubGlobal('EventSource', FakeES);
});
afterEach(() => vi.unstubAllGlobals());

function mount(
  data = OFFICE,
  boards = [{ slug: 'office-aa', name: '오피스', total: 3, archived: false }],
  detailStatus = 'review',
  me?: unknown,
  extra: Record<string, unknown> = {}
) {
  const fn = stubApi({
    ...(me ? { '/api/me': me } : {}),
    ...extra,
    '/api/office/state': { agents: [], seq: 0 },
    '/api/office/kanban/boards': { boards },
    '/api/office/kanban/board': BOARD,
    '/api/office/kanban/dispatch': { spawned: [{ task_id: 't1', profile: 'ma' }] },
    '/api/office/kanban/tasks/t3': DETAIL(detailStatus),
    '/api/office/kanban/tasks': { task: card('t4', 'ready') },
    '/api/office': data,
  });
  mountScreen(<Office />, '/office?tab=kanban');
  return fn;
}

describe('Office 칸반', () => {
  it('열마다 카드를 보이고 보관 칸은 숨긴다. 준비 칸은 기본으로 접혀 있고 「더 보기」로 연다(OMAI-1163)', async () => {
    mount();
    expect(within(await screen.findByRole('region', { name: '진행 중' })).getByText('카드 t2')).toBeInTheDocument();
    expect(screen.getByRole('region', { name: '완료' })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: '준비' })).toBeNull();
    expect(screen.queryByText('카드 t1')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: /접은 칸 \d개 보기/ }));
    const ready = await screen.findByRole('region', { name: '준비' });
    expect(within(ready).getByText('카드 t1')).toBeInTheDocument();
    expect(within(ready).getByText('우선 2')).toBeInTheDocument();
    expect(screen.queryByText('카드 t9')).toBeNull();
  });

  it('보드가 없으면 안내하고 새 보드를 만든다', async () => {
    const fn = mount(OFFICE, []);
    expect(await screen.findByText(/아직 보드가 없습니다/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: '새 보드' }));
    await userEvent.type(await screen.findByLabelText('보드 이름'), '영업 보드');
    await userEvent.click(screen.getByRole('button', { name: '만들기' }));
    await waitFor(() => expect(postedTo(fn, '/api/office/kanban/boards')).toHaveLength(1));
    const body = postedTo(fn, '/api/office/kanban/boards')[0];
    expect(body.name).toBe('영업 보드');
    expect(String(body.slug)).toMatch(/^office-[0-9a-f]{12}$/);
  });

  it('카드를 담당과 함께 만든다', async () => {
    const fn = mount();
    await userEvent.click(await screen.findByRole('button', { name: '카드 추가' }));
    await userEvent.type(await screen.findByLabelText('제목'), '견적서 초안');
    await userEvent.click(screen.getByRole('button', { name: '자유 입력' })); // 기본은 항목별 입력이라 제목만 쓰는 흐름은 자유 입력에서 한다(스펙 2026-10-18-002 R3)
    // 담당 목록은 「별칭 (설치본 id)」 대신 서버가 준 이름(없으면 별칭)이다(스펙 2026-10-19-003)
    expect(await listAgents(userEvent.setup(), screen.getByRole('combobox', { name: '담당' }))).toEqual(expect.arrayContaining(['ma', 'qa']));
    await pickAgent(userEvent.setup(), screen.getByRole('combobox', { name: '담당' }), /^qa$/);
    await userEvent.click(screen.getByRole('button', { name: '만들기' }));
    await waitFor(() => expect(postedTo(fn, '/api/office/kanban/tasks?board=office-aa')).toHaveLength(1));
    expect(postedTo(fn, '/api/office/kanban/tasks?board=office-aa')[0]).toMatchObject({
      title: '견적서 초안',
      assignee: 'qa',
    });
  });

  it('지금 실행은 dispatch 를 부르고 실행한 수를 알린다', async () => {
    const fn = mount();
    await userEvent.click(await screen.findByRole('button', { name: '지금 실행' }));
    await waitFor(() => expect(postedTo(fn, '/api/office/kanban/dispatch?board=office-aa')).toHaveLength(1));
    expect(await screen.findByText('카드 1개를 실행했습니다')).toBeInTheDocument();
  });

  it('검토 카드의 동작은 서랍 머리 단추이고, 대화 상자에서 확인한 뒤 진행한다(OMAI-1135)', async () => {
    const fn = mount();
    await userEvent.click(await screen.findByText('카드 t3'));
    const dlg = await screen.findByRole('dialog', { name: '카드 t3' });
    expect(await within(dlg).findByText('초안을 올렸습니다')).toBeInTheDocument();
    const head = dlg.querySelector('[data-drawer-head]') as HTMLElement;
    // 변경 요청: 대화 상자에 내용을 적어야 보낼 수 있다
    await userEvent.click(within(head).getByRole('button', { name: '변경 요청' }));
    let box = await screen.findByRole('dialog', { name: '변경 요청' });
    const send = within(box).getByRole('button', { name: '변경 요청' });
    expect(send).toBeDisabled();
    await userEvent.type(within(box).getByLabelText('변경 요청 내용'), '표를 넣어 주세요');
    await userEvent.click(send);
    await waitFor(() => expect(postedTo(fn, '/api/office/kanban/tasks/t3/request-changes')).toHaveLength(1));
    expect(postedTo(fn, '/api/office/kanban/tasks/t3/request-changes')[0]).toEqual({ comment: '표를 넣어 주세요' });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '변경 요청' })).toBeNull());
    // 승인: 확인 대화 상자를 거친다. 취소하면 보내지 않는다
    await userEvent.click(await within(head).findByRole('button', { name: '승인(완료로 옮김)' })); // 대화 상자가 닫히는 동안은 서랍이 가려져 있다
    box = await screen.findByRole('dialog', { name: '승인(완료로 옮김)' });
    expect(box).toHaveTextContent('"카드 t3" 카드를 승인해 완료 칸으로 옮깁니다.');
    await userEvent.click(within(box).getByRole('button', { name: '취소' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '승인(완료로 옮김)' })).toBeNull());
    expect(postedTo(fn, '/api/office/kanban/tasks/t3/approve')).toHaveLength(0);
    await userEvent.click(await within(head).findByRole('button', { name: '승인(완료로 옮김)' })); // 대화 상자가 닫히는 동안은 서랍이 가려져 있다
    box = await screen.findByRole('dialog', { name: '승인(완료로 옮김)' });
    await userEvent.click(within(box).getByRole('button', { name: '승인(완료로 옮김)' }));
    await waitFor(() => expect(postedTo(fn, '/api/office/kanban/tasks/t3/approve')).toHaveLength(1));
  });

  it('담당 바꾸기는 본문에 남고 확인을 받는다', async () => {
    const fn = mount();
    await userEvent.click(await screen.findByText('카드 t3'));
    const dlg = await screen.findByRole('dialog', { name: '카드 t3' });
    await pickAgent(userEvent.setup(), await within(dlg).findByRole('combobox', { name: '다른 담당' }), /^qa/);
    await userEvent.click(within(dlg).getByRole('button', { name: '바꾸기' }));
    expect(await screen.findByText(/담당을 qa\(으\)로 바꿉니다/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: '확인' }));
    await waitFor(() => expect(postedTo(fn, '/api/office/kanban/tasks/t3/reassign')).toEqual([{ profile: 'qa' }]));
  });

  it('카드 지우기는 확인을 받고 DELETE 로 보낸다', async () => {
    const fn = mount();
    await userEvent.click(await screen.findByText('카드 t3'));
    await userEvent.click(await screen.findByRole('button', { name: '카드 지우기' }));
    const box = await screen.findByRole('dialog', { name: '카드 지우기' });
    await userEvent.click(within(box).getByRole('button', { name: '카드 지우기' }));
    await waitFor(() =>
      expect(fn.mock.calls.some((c) => (c[1] as RequestInit | undefined)?.method === 'DELETE')).toBe(true)
    );
    const del = fn.mock.calls.find((c) => (c[1] as RequestInit | undefined)?.method === 'DELETE');
    expect(String(del?.[0])).toBe('/api/office/kanban/tasks/t3?board=office-aa');
  });

  it('서버가 거절하면 이유를 서랍에 보인다', async () => {
    const reply = (body: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status }));
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) => {
        if (url.includes('/approve')) return reply({ error: '검토 칸에 있는 카드만 승인할 수 있습니다' }, 409);
        if (url.startsWith('/api/office/state')) return reply({ agents: [], seq: 0 });
        if (url.startsWith('/api/office/kanban/boards'))
          return reply({ boards: [{ slug: 'office-aa', name: '오피스', total: 3, archived: false }] });
        if (url.startsWith('/api/office/kanban/board')) return reply(BOARD);
        if (url.startsWith('/api/office/kanban/tasks/t3')) return reply(DETAIL('review'));
        return reply(OFFICE);
      })
    );
    mountScreen(<Office />, '/office?tab=kanban');
    await userEvent.click(await screen.findByText('카드 t3'));
    await userEvent.click(await screen.findByRole('button', { name: '승인(완료로 옮김)' }));
    const box = await screen.findByRole('dialog', { name: '승인(완료로 옮김)' });
    await userEvent.click(within(box).getByRole('button', { name: '승인(완료로 옮김)' }));
    expect(await screen.findByText('검토 칸에 있는 카드만 승인할 수 있습니다')).toBeInTheDocument();
  });

  it('편집 권한이 없으면 만들기·실행 버튼이 없다', async () => {
    mount({ ...OFFICE, can_edit: false });
    await screen.findByRole('region', { name: '검토' });
    expect(screen.queryByRole('button', { name: '카드 추가' })).toBeNull();
    expect(screen.queryByRole('button', { name: '지금 실행' })).toBeNull();
    await userEvent.click(screen.getByText('카드 t3'));
    expect(await screen.findByText('초안을 올렸습니다')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '승인(완료로 옮김)' })).toBeNull();
  });

  it('관리자가 아니어도 오피스 API 를 쓸 수 있으면(can_act) 카드를 만들 수 있다. 지금 실행·새 보드는 관리자만(OMAI-1122)', async () => {
    mount({ ...OFFICE, can_edit: false, can_act: true } as typeof OFFICE, undefined, undefined, ME_USER);
    expect(await screen.findByRole('button', { name: '카드 추가' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '지금 실행' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '새 보드' })).not.toBeInTheDocument();
  });

  it('권한이 없다는 서버의 사유(403)를 서랍에 그대로 보인다', async () => {
    const reply = (body: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status }));
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) => {
        if (url.startsWith('/api/office/kanban/tasks?'))
          return reply({ error: 'ma 는 내가 쓸 수 있는 AI 에이전트가 아닙니다.' }, 403);
        if (url.startsWith('/api/office/state')) return reply({ agents: [], seq: 0 });
        if (url.startsWith('/api/office/kanban/boards'))
          return reply({ boards: [{ slug: 'office-aa', name: '오피스', total: 0, archived: false }] });
        if (url.startsWith('/api/office/kanban/board')) return reply({ columns: [] });
        return reply({ ...OFFICE, can_edit: false, can_act: true });
      })
    );
    mountScreen(<Office />, '/office?tab=kanban');
    await userEvent.click(await screen.findByRole('button', { name: '카드 추가' }));
    await userEvent.type(await screen.findByLabelText('제목'), '남의 일');
    await userEvent.click(screen.getByRole('button', { name: '자유 입력' })); // 기본은 항목별 입력이라 제목만 쓰는 흐름은 자유 입력에서 한다(스펙 2026-10-18-002 R3)
    await userEvent.click(screen.getByRole('button', { name: '만들기' }));
    expect(await screen.findByText(/내가 쓸 수 있는 AI 에이전트가 아닙니다/)).toBeInTheDocument();
  });
  it('열어 둔 카드 서랍은 다른 사람이 카드를 옮기면(웹소켓 push) 머리와 본문을 새 값으로 바꾼다', async () => {
    let moved = false;
    stubApi({
      '/api/office/state': { agents: [], seq: 0 },
      '/api/office/kanban/boards': { boards: [{ slug: 'office-aa', name: '오피스', total: 3, archived: false }] },
      '/api/office/kanban/board': BOARD,
      '/api/office/kanban/tasks/t3': () =>
        moved
          ? { ...DETAIL('done'), comments: [{ id: 2, author: 'qa', body: '검토를 마쳤습니다', created_at: 1760000200 }] }
          : DETAIL('review'),
      '/api/office': OFFICE,
    });
    mountScreen(<Office />, '/office?tab=kanban');
    await userEvent.click(await screen.findByText('카드 t3'));
    const dlg = await screen.findByRole('dialog', { name: '카드 t3' });
    expect(within(dlg).getByText('검토 · ma')).toBeInTheDocument();
    expect(await within(dlg).findByText('초안을 올렸습니다')).toBeInTheDocument();
    // 다른 사람이 카드를 완료로 옮기고 담당을 바꿨다
    moved = true;
    const done = {
      columns: BOARD.columns.map((c) => ({
        ...c,
        tasks:
          c.name === 'review' ? [] : c.name === 'done' ? [card('t3', 'done', { assignee: 'qa', comment_count: 2 })] : c.tasks,
      })),
    };
    await waitFor(() => expect(pushed.board).not.toBeNull());
    act(() => pushed.board?.(done));
    const now = await screen.findByRole('dialog', { name: '카드 t3' });
    expect(await within(now).findByText('완료 · qa')).toBeInTheDocument();
    expect(await within(now).findByText('검토를 마쳤습니다')).toBeInTheDocument();
  });
});

// 스펙 2026-10-28-014 §4-4: 카드 서랍을 주소 card=<카드 id> 와 묶는다(board 와 함께)
describe('Office 칸반: 카드 서랍 주소(card)', () => {
  const BOARDS = [
    { slug: 'office-aa', name: '오피스', total: 3, archived: false },
    { slug: 'sales-bb', name: '영업', total: 3, archived: false },
  ];
  const stub = () =>
    stubApi({
      '/api/office/state': { agents: [], seq: 0 },
      '/api/office/kanban/boards': { boards: BOARDS },
      '/api/office/kanban/board': BOARD,
      '/api/office/kanban/tasks/t3': DETAIL('review'),
      '/api/office': OFFICE,
    });
  const mountAt = (initial: string) =>
    mountScreen(
      <>
        <Office />
        <HistoryBack />
      </>,
      initial
    );

  it('카드를 누르면 주소에 board·card 가 생기고, 닫기·뒤로 가기로 서랍이 닫히며 값이 지워진다(D9)', async () => {
    stub();
    mountAt('/office?tab=kanban');
    await userEvent.click(await screen.findByText('카드 t3'));
    expect(await screen.findByRole('dialog', { name: '카드 t3' })).toBeInTheDocument();
    expect(screen.getByTestId('loc')).toHaveTextContent(/^\/office\?tab=kanban&board=office-aa&card=t3$/);
    // 닫기: 화면 안에서 쌓은 칸이므로 되감는다(board 도 쓰기 전 주소로 돌아간다)
    await userEvent.click(within(screen.getByRole('dialog', { name: '카드 t3' })).getByRole('button', { name: '닫기' }));
    await waitFor(() => expect(screen.getByTestId('loc')).toHaveTextContent(/^\/office\?tab=kanban$/));
    expect(screen.queryByRole('dialog', { name: '카드 t3' })).toBeNull();
    // 뒤로 가기
    await userEvent.click(await screen.findByText('카드 t3'));
    expect(await screen.findByRole('dialog', { name: '카드 t3' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '뒤로 가기', hidden: true }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '카드 t3' })).toBeNull());
    expect(screen.getByTestId('loc')).toHaveTextContent(/^\/office\?tab=kanban$/);
  });

  it('서랍이 열린 채 다른 카드를 누르면 기록을 늘리지 않고 바꾼다', async () => {
    stub();
    mountAt('/office?tab=kanban');
    await userEvent.click(await screen.findByText('카드 t3'));
    expect(await screen.findByRole('dialog', { name: '카드 t3' })).toBeInTheDocument();
    fireEvent.click(screen.getByText('카드 t2'));
    expect(await screen.findByRole('dialog', { name: '카드 t2' })).toBeInTheDocument();
    expect(screen.getByTestId('loc')).toHaveTextContent(/card=t2$/);
    fireEvent.click(screen.getByRole('button', { name: '뒤로 가기', hidden: true }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.getByTestId('loc')).toHaveTextContent(/^\/office\?tab=kanban$/);
  });

  it('#/office?tab=kanban&board=…&card=… 로 들어오면 그 보드의 카드 서랍을 연다', async () => {
    stub();
    mountAt('/office?tab=kanban&board=sales-bb&card=t3');
    const dlg = await screen.findByRole('dialog', { name: '카드 t3' });
    expect(await within(dlg).findByText('초안을 올렸습니다')).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: '보드', hidden: true })).toHaveValue('sales-bb');
    // 링크로 들어온 서랍은 되감을 칸이 없어 card 만 지운다(replace)
    await userEvent.click(within(dlg).getByRole('button', { name: '닫기' }));
    await waitFor(() => expect(screen.getByTestId('loc')).toHaveTextContent(/^\/office\?tab=kanban&board=sales-bb$/));
  });

  it('보드를 바꾸면 card 가 지워지고 서랍이 닫힌다', async () => {
    stub();
    mountAt('/office?tab=kanban&board=office-aa&card=t3');
    expect(await screen.findByRole('dialog', { name: '카드 t3' })).toBeInTheDocument();
    fireEvent.change(screen.getByRole('combobox', { name: '보드', hidden: true }), { target: { value: 'sales-bb' } });
    await waitFor(() => expect(screen.getByTestId('loc')).toHaveTextContent(/^\/office\?tab=kanban&board=sales-bb$/));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '카드 t3' })).toBeNull());
  });

  it('보드에 없는 카드의 링크는 서랍을 열지 않고 알린 뒤 card 를 지운다', async () => {
    stub();
    mountAt('/office?tab=kanban&board=office-aa&card=gone');
    expect(await screen.findByText(/링크의 카드 gone 를 이 보드에서 찾지 못했습니다/)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId('loc')).toHaveTextContent(/^\/office\?tab=kanban&board=office-aa$/));
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

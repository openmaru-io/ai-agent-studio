/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 회의 「새 대화」·「지난 대화」(스펙 2026-10-20-027, 디자인 리뷰 DR1~DR15)
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FakeES } from '@/test/fakeEventSource';
import { mountScreen, postedTo, stubApi } from '@/test/mountScreen';

import { Office } from '../Office';
import { MeetingRoom } from './MeetingRoom';

vi.mock('@/features/office/OfficeScene', () => ({ default: () => <div /> }));

const seat = (alias: string, pod: string) => ({ alias, pod, profile: alias, enabled: true, title: '', role: '', team: '', note: '' });
const OFFICE = {
  seats: [seat('sa', 'yj'), seat('doc', 'scdf')],
  rooms: [{ id: 1, name: '제안 TFT', purpose: 'RFP 대응', owner: 'kim', seats: ['sa', 'doc'], people: ['kim'], status: 'open' }],
  pods: [],
  problems: [],
  can_edit: true,
};
const PARTS = [
  { alias: 'sa', title: '영업', pod: 'yj', enabled: true },
  { alias: 'doc', title: '', pod: 'scdf', enabled: true },
];
const TALK = [
  { id: 1, role: 'user', author: 'kim', content: '일정 어떻게 돼?', ts: '2026-10-20T14:03:00+09:00' },
  { id: 2, role: 'assistant', author: 'sa', content: '다음 주입니다', ts: '2026-10-20T14:03:05+09:00' },
];
const view = (over: Record<string, unknown> = {}) => ({
  room: { id: 1, name: '제안 TFT', purpose: 'RFP 대응', status: 'open' },
  participants: PARTS,
  messages: TALK,
  pending: [],
  thread: 0,
  viewing: 0,
  ...over,
});
const STARTED = {
  id: 10,
  role: 'system',
  author: 'kim@x.com',
  content: 'kim@x.com 님이 새 대화를 시작했습니다',
  ts: '2026-10-20T15:00:00+09:00',
  kind: 'thread_started',
  data: { by: 'kim@x.com', prev: 0, prev_ok: true },
};
const THREADS = {
  current: 5,
  threads: [
    { id: 5, ts: '2026-10-20T15:00:00+09:00', by: 'kim@x.com', by_label: '김', count: 0, first: '', current: true },
    { id: 0, ts: '2026-10-20T14:03:00+09:00', by: '', by_label: '', count: 2, first: '일정 어떻게 돼?', current: false },
  ],
};

beforeEach(() => {
  FakeES.all = [];
  vi.stubGlobal('EventSource', FakeES);
});
afterEach(() => vi.unstubAllGlobals());

function mount(v: Record<string, unknown> = view(), extra: Record<string, unknown> = {}, at = '/office?tab=meeting&room=1') {
  const fn = stubApi({
    '/api/office/state': { agents: [], seq: 0 },
    '/api/office/meeting/new': { thread: 5 },
    '/api/office/meeting/threads': THREADS,
    '/api/office/meeting/say': { ok: true, targets: ['sa', 'doc'] },
    ...extra,
    '/api/office/meeting': (url: string) => (url.includes('thread=') ? view({ messages: TALK, thread: 5, viewing: 0 }) : v),
    '/api/office': OFFICE,
  });
  const out = mountScreen(<Office />, at);
  return { fn, qc: out.qc };
}

const btn = (name: string) => screen.findByRole('button', { name });

describe('회의 「새 대화」', () => {
  it('머리줄 순서는 지난 대화 · 회의록 요약 · 새 대화(DR1)', async () => {
    mount();
    const summary = await btn('회의록 요약 내려받기');
    const past = screen.getByRole('button', { name: '지난 대화 보기' });
    const fresh = screen.getByRole('button', { name: '새 대화 시작' });
    expect(past.compareDocumentPosition(summary) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(summary.compareDocumentPosition(fresh) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('확인 창은 제목·단추가 새 대화이고 처음 초점은 취소다. 취소하면 보내지 않고, 시작하면 POST 뒤 입력칸으로(DR4·DR9)', async () => {
    const { fn } = mount();
    await screen.findByText('다음 주입니다');
    await userEvent.click(await btn('새 대화 시작'));
    const dlg = await screen.findByRole('dialog', { name: '새 대화를 시작할까요?' });
    expect(within(dlg).getByText(/이어 쓸 수는 없습니다/)).toBeInTheDocument();
    expect(within(dlg).getByRole('button', { name: '취소' })).toHaveFocus();
    await userEvent.click(within(dlg).getByRole('button', { name: '취소' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(postedTo(fn, '/api/office/meeting/new')).toEqual([]);
    await userEvent.click(await btn('새 대화 시작'));
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: '새 대화 시작' }));
    await waitFor(() => expect(postedTo(fn, '/api/office/meeting/new')).toEqual([{ room: 1 }]));
    await waitFor(() => expect(screen.getByRole('textbox', { name: '메시지' })).toHaveFocus());
  });

  it('답하는 중이면 단추가 막혀 있고 누르면 확인 창 대신 이유를 보인다(DR15)', async () => {
    const { fn } = mount(view({ pending: ['sa'] }));
    const b = await btn('새 대화 시작');
    await waitFor(() => expect(b).toHaveAttribute('aria-disabled', 'true'));
    await userEvent.click(b);
    expect(await screen.findByRole('alert')).toHaveTextContent('AI 에이전트가 답하는 중에는 새 대화를 시작할 수 없습니다'); // 툴팁과 같은 문장을 입력칸 위 줄에도
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(postedTo(fn, '/api/office/meeting/new')).toEqual([]);
  });

  it('서버가 409 busy 로 거절하면 우리말 이유를 보인다(DR4)', async () => {
    mount(view(), {
      '/api/office/meeting/new': () => new Response(JSON.stringify({ error: 'busy en', reason: 'busy' }), { status: 409 }),
    });
    await screen.findByText('다음 주입니다');
    await userEvent.click(await btn('새 대화 시작'));
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: '새 대화 시작' }));
    expect(await screen.findByText('AI 에이전트가 답하는 중에는 새 대화를 시작할 수 없습니다')).toBeInTheDocument();
    expect(screen.queryByText('busy en')).not.toBeInTheDocument();
  });

  it('알림 줄은 경고가 아닌 상태 줄이고, 새 차례의 빈 화면은 앞 대화를 넘겨받지 않는다고 말한다. 요약 단추는 없다(DR3·DR5·R13)', async () => {
    mount(view({ messages: [STARTED], thread: 5, viewing: 5, labels: { 'kim@x.com': '김' } }));
    const line = await screen.findByText(/김 님이 새 대화를 시작했습니다/);
    expect(line.closest('[role="status"]')).not.toBeNull();
    expect(line.closest('[role="alert"]')).toBeNull();
    expect(screen.getByText('새 대화입니다. AI 에이전트들은 앞 대화를 넘겨받지 않습니다.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '회의록 요약 내려받기' })).not.toBeInTheDocument();
  });

  it('다른 사람이 새 대화를 시작했고 쓰던 글이 있으면 입력칸 위에 알린다(DR11)', async () => {
    const { qc } = mount();
    await userEvent.type(await screen.findByRole('textbox', { name: '메시지' }), '위의 것을 고쳐 줘');
    act(() => qc.setQueryData(['meeting', 1], view({ messages: [STARTED], thread: 5, viewing: 5, labels: { 'kim@x.com': '김' } })));
    expect(await screen.findByText('김 님이 새 대화를 시작했습니다. 보낼 글은 새 대화로 갑니다.')).toBeInTheDocument();
  });
});

describe('회의 「지난 대화」', () => {
  it('목록은 최근 것이 앞이고 지금 대화에 표시가 있다. 고르면 위에 읽기 전용 상세가 쌓인다(DR6·DR8·DR12·DR14)', async () => {
    const { fn } = mount(view({ messages: [STARTED], thread: 5, viewing: 5 }));
    await userEvent.click(await btn('지난 대화 보기'));
    const list = await screen.findByRole('dialog', { name: '지난 대화' });
    expect(within(list).getByText('제안 TFT · 누르면 읽기 전용으로 봅니다')).toBeInTheDocument();
    expect(within(list).getByText('지금 대화')).toBeInTheDocument();
    await userEvent.click(within(list).getByText('일정 어떻게 돼?'));
    const detail = await screen.findByRole('dialog', { name: /지난 대화 · / });
    expect(within(detail).getByText('읽기 전용 · 이어 쓸 수 없습니다')).toBeInTheDocument();
    expect(await within(detail).findByText('다음 주입니다')).toBeInTheDocument();
    expect(within(detail).queryByRole('textbox')).not.toBeInTheDocument();
    expect(within(detail).getByRole('region', { name: /지난 대화 기록\(읽기 전용\)/ })).toBeInTheDocument();
    expect(fn.mock.calls.some((c) => String(c[0]).includes('/api/office/meeting?room=1&thread=0'))).toBe(true);
  });

  it('지난 대화가 없으면 빈 목록 안내(DR6). 읽기만 하는 사람도 단추가 있다(DR7)', async () => {
    mount(view(), { '/api/office/meeting/threads': { current: 0, threads: [{ ...THREADS.threads[1], current: true }] } });
    await userEvent.click(await btn('지난 대화 보기'));
    expect(await screen.findByText(/아직 지난 대화가 없습니다/)).toBeInTheDocument();
  });

  it('알림 줄의 「지난 대화 보기」는 바로 앞 차례를 연다(DR10)', async () => {
    const { fn } = mount(view({ messages: [STARTED], thread: 5, viewing: 5 }));
    const line = (await screen.findByText(/님이 새 대화를 시작했습니다/)).closest('[role="status"]') as HTMLElement;
    await userEvent.click(within(line).getByRole('button', { name: '지난 대화 보기' }));
    await screen.findByRole('dialog', { name: /지난 대화 · / });
    expect(fn.mock.calls.some((c) => String(c[0]).includes('thread=0'))).toBe(true);
  });

  it('없는 대화(404)는 「찾을 수 없는 대화입니다」(DR8)', async () => {
    mount(view({ messages: [STARTED], thread: 5, viewing: 5 }), {
      '/api/office/meeting?room=1&thread=': () => new Response(JSON.stringify({ error: 'x', reason: 'not_found' }), { status: 404 }),
    });
    await userEvent.click(await btn('지난 대화 보기'));
    await userEvent.click(within(await screen.findByRole('dialog', { name: '지난 대화' })).getByText('일정 어떻게 돼?'));
    expect(await screen.findByText('찾을 수 없는 대화입니다')).toBeInTheDocument();
  });

  it('창에서 옮겨 온 주소(?past=1)는 큰 화면에서 목록을 열고 주소에서 지운다(DR13)', async () => {
    mount(view(), {}, '/office?tab=meeting&room=1&past=1');
    expect(await screen.findByRole('dialog', { name: '지난 대화' })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId('loc')).toHaveTextContent('/office?tab=meeting&room=1'));
    expect(screen.getByTestId('loc')).not.toHaveTextContent('past=');
  });

  it('주소의 방이 아직 목록에 없으면 다른 방의 「지난 대화」를 열지 않는다(OKE 확인 2026-10-20)', async () => {
    // 방 목록이 오래돼 ?room= 의 방이 없으면 회의 탭은 첫 방을 보인다. 그때 past=1 을 처리하면 엉뚱한 방의 서랍이 열렸다
    mount(view(), {}, '/office?tab=meeting&room=99&past=1');
    await screen.findByRole('button', { name: '지난 대화 보기' });
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByRole('dialog', { name: '지난 대화' })).not.toBeInTheDocument();
    expect(screen.getByTestId('loc')).toHaveTextContent('past=1');                 // 방이 나타나면 그때 연다
  });

  it('오피스 장면 위 창(compact)에서는 서랍 대신 큰 회의 화면으로 옮긴다(DR13)', async () => {
    stubApi({ '/api/office/meeting': view() });
    mountScreen(<MeetingRoom roomId={1} canAct compact />, '/office');
    await userEvent.click(await btn('지난 대화 보기'));
    await waitFor(() => expect(screen.getByTestId('loc')).toHaveTextContent('/office?tab=meeting&room=1&past=1'));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});

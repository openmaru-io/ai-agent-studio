/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FakeES } from '@/test/fakeEventSource';
import { mountScreen, postedTo, stubApi } from '@/test/mountScreen';

import { Office } from './Office';

vi.mock('@/features/office/OfficeScene', () => ({ default: () => <div /> }));

const seat = (alias: string, pod: string) => ({
  alias,
  pod,
  profile: alias,
  enabled: true,
  title: '',
  role: '',
  team: '',
  note: '',
});
const room = (id: number, name: string, status = 'open') => ({
  id,
  name,
  purpose: 'RFP 대응',
  owner: 'kim',
  seats: ['sa', 'doc'],
  people: ['kim'],
  status,
});
const OFFICE = {
  seats: [seat('sa', 'yj'), seat('doc', 'scdf')],
  rooms: [room(1, '제안 TFT'), room(2, '끝난 방', 'closed')],
  pods: [],
  problems: [],
  can_edit: true,
};
const VIEW = {
  room: { id: 1, name: '제안 TFT', purpose: 'RFP 대응', status: 'open' },
  participants: [
    { alias: 'sa', title: '영업', pod: 'yj', enabled: true },
    { alias: 'doc', title: '', pod: 'scdf', enabled: true },
  ],
  messages: [
    { id: 1, role: 'user', author: 'kim', content: '일정 어떻게 돼?', ts: '2026-10-10T10:00:00+09:00' },
    { id: 2, role: 'assistant', author: 'sa', content: '다음 주 **화요일**입니다', ts: '2026-10-10T10:00:05+09:00' },
    {
      id: 3,
      role: 'system',
      author: 'doc',
      content: 'doc 가 답하지 못했습니다: 시간 초과',
      ts: '2026-10-10T10:00:09+09:00',
    },
  ],
  pending: ['sa'],
};

beforeEach(() => {
  FakeES.all = [];
  vi.stubGlobal('EventSource', FakeES);
});
afterEach(() => vi.unstubAllGlobals());

function mount(data = OFFICE, view: Record<string, unknown> = VIEW) {
  const fn = stubApi({
    '/api/office/state': { agents: [], seq: 0 },
    '/api/office/meeting/say': { ok: true, targets: ['sa', 'doc'] },
    '/api/office/meeting/summary': { markdown: '# 회의록' },
    '/api/office/meeting': view,
    '/api/office': data,
  });
  mountScreen(<Office />, '/office?tab=meeting');
  return fn;
}

const styleText = () => Array.from(document.querySelectorAll('style')).map((s) => s.textContent ?? '').join('\n');

describe('Office 회의: 본문 열 폭', () => {
  it('기록·입력 카드가 채팅과 같은 열 폭(720~960px)을 쓴다(OMAI-1224)', async () => {
    mount();
    await screen.findByRole('log', { name: '회의 기록' });
    const css = styleText();
    expect(css).toContain('clamp(720px, 56vw, 960px)');
    expect(css).not.toMatch(/max-width:\s*720px/);
  });
});

describe('Office 회의', () => {
  it('열린 방의 기록·참가자·답하는 중 표시를 보인다', async () => {
    mount();
    const log = await screen.findByRole('log', { name: '회의 기록' });
    expect(await screen.findByText('일정 어떻게 돼?')).toBeInTheDocument();
    expect(log).toHaveTextContent('kim · ');
    expect(screen.getByText('화요일')).toBeInTheDocument(); // 에이전트의 답은 마크다운으로 그린다
    expect(screen.getByText(/doc 가 답하지 못했습니다/)).toBeInTheDocument();
    expect(screen.getByText('sa 가 답하는 중…')).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: /sa \(영업\) · yj/ })).toBeChecked();
    // 방이 하나여도 왼쪽 목록은 늘 보이고, 끝난 방은 목록에 없다(사용자 결정 2026-10-15)
    const list = screen.getByRole('complementary', { name: '회의 방 목록' });
    expect(within(within(list).getByRole('list')).getAllByRole('button').map((x) => x.getAttribute('aria-label'))).toEqual(['제안 TFT']); // 목록 위 「새 TFT 방」 단추는 빼고 센다
    expect(within(list).getByRole('button', { name: '제안 TFT' })).toHaveAttribute('aria-current', 'true');
    expect(screen.getByRole('heading', { level: 2, name: '제안 TFT' })).toBeInTheDocument();
  });

  it('목록에서 다른 방을 누르면 그 방의 기록을 읽고 선택 표시가 옮겨 간다', async () => {
    const data = { ...OFFICE, rooms: [room(1, '제안 TFT'), room(3, '장애 대응')] };
    const fn = mount(data);
    await screen.findByText('일정 어떻게 돼?');
    const list = screen.getByRole('complementary', { name: '회의 방 목록' });
    await userEvent.click(within(list).getByRole('button', { name: '장애 대응' }));
    await waitFor(() => expect(fn.mock.calls.some((c) => String(c[0]).includes('/api/office/meeting?room=3'))).toBe(true));
    expect(within(list).getByRole('button', { name: '장애 대응' })).toHaveAttribute('aria-current', 'true');
    expect(within(list).getByRole('button', { name: '제안 TFT' })).toHaveAttribute('aria-current', 'false');
  });

  it('좁은 화면용 「회의 방 목록으로」 단추는 ?room 을 지워 목록으로 돌아간다', async () => {
    mount();
    await screen.findByText('일정 어떻게 돼?');
    await userEvent.click(screen.getByRole('button', { name: '회의 방 목록으로' }));
    expect(screen.getByRole('complementary', { name: '회의 방 목록' })).toBeInTheDocument();
  });

  it('말을 보내면 받을 에이전트와 함께 서버로 간다', async () => {
    const fn = mount();
    await screen.findByText('일정 어떻게 돼?');
    const send = screen.getByRole('button', { name: '보내기' });
    expect(send).toBeDisabled();
    await userEvent.click(screen.getByRole('checkbox', { name: /doc · scdf/ })); // doc 는 이번 말을 받지 않는다
    await userEvent.type(screen.getByLabelText('메시지'), '영업만 봐 줘');
    await userEvent.click(send);
    await waitFor(() => expect(postedTo(fn, '/api/office/meeting/say')).toHaveLength(1));
    expect(postedTo(fn, '/api/office/meeting/say')[0]).toEqual({ room: 1, text: '영업만 봐 줘', targets: ['sa'] });
    await waitFor(() => expect(screen.getByLabelText('메시지')).toHaveValue(''));
  });

  it('Ctrl+Enter 로도 보낸다', async () => {
    const fn = mount();
    await userEvent.type(await screen.findByLabelText('메시지'), '안녕{Control>}{Enter}{/Control}');
    await waitFor(() => expect(postedTo(fn, '/api/office/meeting/say')).toHaveLength(1));
  });

  it('서버가 거절한 이유를 보이고 입력은 남겨 둔다', async () => {
    const reply = (body: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status }));
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) => {
        if (url.startsWith('/api/office/meeting/say'))
          return reply({ error: '끝난 방입니다. 다시 열어야 말할 수 있습니다' }, 409);
        if (url.startsWith('/api/office/meeting')) return reply(VIEW);
        if (url.startsWith('/api/office/state')) return reply({ agents: [], seq: 0 });
        return reply(OFFICE);
      })
    );
    mountScreen(<Office />, '/office?tab=meeting');
    await userEvent.type(await screen.findByLabelText('메시지'), '다시 열자');
    await userEvent.click(screen.getByRole('button', { name: '보내기' }));
    expect(await screen.findByText(/끝난 방입니다/)).toBeInTheDocument();
    expect(screen.getByLabelText('메시지')).toHaveValue('다시 열자');
  });

  it('열린 방이 없으면 안내한다', async () => {
    mount({ ...OFFICE, rooms: [room(2, '끝난 방', 'closed')] });
    expect(await screen.findByText(/열려 있는 TFT 방이 없습니다/)).toBeInTheDocument();
  });

  it('편집 권한이 없으면 기록만 보인다', async () => {
    mount({ ...OFFICE, can_edit: false });
    expect(await screen.findByText('일정 어떻게 돼?')).toBeInTheDocument();
    expect(screen.queryByLabelText('메시지')).toBeNull();
    expect(screen.getByText(/관리자만 할 수 있습니다/)).toBeInTheDocument();
  });

  it('구성원인 일반 사용자(can_act)는 회의에서 말할 수 있다', async () => {
    mount({ ...OFFICE, can_edit: false, can_act: true } as typeof OFFICE);
    expect(await screen.findByLabelText('메시지')).toBeInTheDocument();
    expect(screen.queryByText(/관리자만 할 수 있습니다/)).toBeNull();
  });

  it('답하는 중인 글을 기록에 바로 보이고, 회의록 요약을 내려받는다(P3)', async () => {
    const created = vi.fn(() => 'blob:x');
    vi.stubGlobal('URL', { ...URL, createObjectURL: created, revokeObjectURL: vi.fn() });
    const fn = mount(OFFICE, { ...VIEW, partial: { sa: '지금 쓰는 답' } });
    const log = await screen.findByRole('log', { name: '회의 기록' });
    expect(await within(log).findByText('지금 쓰는 답')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: '회의록 요약 내려받기' }));
    await waitFor(() => expect(postedTo(fn, '/api/office/meeting/summary')).toEqual([{ room: 1 }]));
    expect(created).toHaveBeenCalled();
  });

  it('채팅처럼 Enter 로 보내고 Shift+Enter 는 줄을 바꾼다(사용자 결정 2026-10-15, 스펙 §5 D3)', async () => {
    const fn = mount();
    const box = await screen.findByLabelText('메시지');
    await userEvent.type(box, '첫 줄{Shift>}{Enter}{/Shift}둘째 줄');
    expect(postedTo(fn, '/api/office/meeting/say')).toHaveLength(0);
    expect(box).toHaveValue('첫 줄\n둘째 줄');
    await userEvent.type(box, '{Enter}');
    await waitFor(() => expect(postedTo(fn, '/api/office/meeting/say')).toHaveLength(1));
    await waitFor(() => expect(box).toHaveValue(''));
    expect(box).toHaveFocus(); // 보낸 뒤에도 입력칸에 머문다(디자인 리뷰 3-1)
  });

  it('받는 에이전트를 모두 끄면 이유를 칩 줄에 보이고, Enter 는 보내지도 줄을 바꾸지도 않는다(디자인 리뷰 2-3)', async () => {
    const fn = mount();
    await screen.findByText('일정 어떻게 돼?');
    await userEvent.click(screen.getByRole('checkbox', { name: /sa \(영업\) · yj/ }));
    await userEvent.click(screen.getByRole('checkbox', { name: /doc · scdf/ }));
    const reason = screen.getByText('받는 AI 에이전트를 하나 이상 켜 주세요');
    const box = screen.getByLabelText('메시지');
    expect(box.getAttribute('aria-describedby')).toContain(reason.id);
    await userEvent.type(box, '안녕{Enter}');
    expect(postedTo(fn, '/api/office/meeting/say')).toHaveLength(0);
    expect(box).toHaveValue('안녕');
    expect(screen.getByRole('button', { name: '보내기' })).toBeDisabled();
  });

  it('@이름 으로 대상이 좁혀지면 나머지 칩이 흐려지고 안내가 보인다', async () => {
    mount();
    await screen.findByRole('log', { name: '회의 기록' });
    await userEvent.type(screen.getByLabelText('메시지'), '@doc 확인');
    expect(screen.getByText(/@doc 에게만 보냅니다/)).toBeInTheDocument();
    const sa = screen.getByRole('checkbox', { name: /sa \(영업\) · yj/ }).closest('label') as HTMLElement;
    const doc = screen.getByRole('checkbox', { name: /doc · scdf/ }).closest('label') as HTMLElement;
    expect(getComputedStyle(sa).opacity).toBe('0.45');
    expect(getComputedStyle(doc).opacity).toBe('1');
  });

  it('요약 비용 안내는 단추 아래에 늘 보이지 않고, 단추에 올리면 툴팁으로 보이며 단추가 가리킨다(사용자 결정 2026-10-20)', async () => {
    mount();
    const btn = await screen.findByRole('button', { name: '회의록 요약 내려받기' });
    expect(screen.queryByText(/요약은 .* 가 따로 만든 대화로 씁니다/)).toBeNull();
    await userEvent.hover(btn);
    const tip = await screen.findByRole('tooltip');
    expect(tip).toHaveTextContent(/요약은 .* 가 따로 만든 대화로 씁니다/);
    expect(btn).toHaveAttribute('aria-describedby', tip.id);
  });

  it('기록을 불러오지 못하면 오류 줄과 「다시 불러오기」를 보이고, 누르면 다시 읽는다(디자인 리뷰 2-1)', async () => {
    let fail = true;
    const reply = (body: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status }));
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) => {
        if (url.startsWith('/api/office/meeting')) {
          calls.push(url);
          return fail ? reply({ error: '연결 거부' }, 500) : reply(VIEW);
        }
        if (url.startsWith('/api/office/state')) return reply({ agents: [], seq: 0 });
        return reply(OFFICE);
      })
    );
    mountScreen(<Office />, '/office?tab=meeting');
    const row = await screen.findByRole('alert');
    expect(row).toHaveTextContent('회의 기록을 불러오지 못했습니다');
    fail = false;
    await userEvent.click(within(row).getByRole('button', { name: '다시 불러오기' }));
    expect(await screen.findByText('일정 어떻게 돼?')).toBeInTheDocument();
    expect(screen.queryByText(/불러오지 못했습니다/)).toBeNull();
  });

  it('불러오는 동안 틀 맨 위에 진행 막대를 보인다(디자인 리뷰 2-1)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) => {
        if (url.startsWith('/api/office/meeting')) return new Promise(() => {}); // 끝내 오지 않는 응답
        if (url.startsWith('/api/office/state')) return Promise.resolve(new Response(JSON.stringify({ agents: [], seq: 0 })));
        return Promise.resolve(new Response(JSON.stringify(OFFICE)));
      })
    );
    mountScreen(<Office />, '/office?tab=meeting');
    expect(await screen.findByRole('progressbar', { name: '회의 기록을 불러오는 중…' })).toBeInTheDocument();
  });

  it('열린 방이 없으면 「TFT 방 탭 열기」 단추로 바로 간다(디자인 리뷰 2-2)', async () => {
    mount({ ...OFFICE, rooms: [room(2, '끝난 방', 'closed')] });
    await userEvent.click(await screen.findByRole('button', { name: 'TFT 방 탭 열기' }));
    await waitFor(() => expect(screen.getByTestId('loc')).toHaveTextContent('tab=rooms'));
  });

  it('관리자 전용이면 입력 카드 자리에 조용한 안내 줄을 두고 옛 파란 안내 상자는 쓰지 않는다(디자인 리뷰 2-2)', async () => {
    mount({ ...OFFICE, can_edit: false });
    const note = await screen.findByText(/관리자만 할 수 있습니다/);
    expect(note.closest('.MuiAlert-root')).toBeNull();
  });

  it('긴 별칭의 칩은 최대 폭에서 말줄임이고 전체 값은 title 로 보인다(디자인 리뷰 7-2)', async () => {
    const long = 'aas-agent-omai1151-e2e-af8d-with-a-very-long-alias-name';
    mount(OFFICE, { ...VIEW, participants: [{ alias: long, title: '', pod: 'yj', enabled: true }, ...VIEW.participants] });
    const chip = (await screen.findByRole('checkbox', { name: new RegExp(long) })).closest('label') as HTMLElement;
    expect(chip).toHaveAttribute('title', `${long} · yj`);
    expect(getComputedStyle(chip).maxWidth).toBe('180px');
  });

  it('같은 에이전트가 1분 안에 이어 말하면 머리줄(이름)은 한 번만 보인다', async () => {
    mount(OFFICE, {
      ...VIEW,
      pending: [],
      messages: [
        { id: 1, role: 'assistant', author: 'sa', content: '하나', ts: '2026-10-10T10:00:00+09:00' },
        { id: 2, role: 'assistant', author: 'sa', content: '둘', ts: '2026-10-10T10:00:20+09:00' },
        { id: 3, role: 'assistant', author: 'sa', content: '셋', ts: '2026-10-10T10:02:00+09:00' },
      ],
    });
    const log = await screen.findByRole('log', { name: '회의 기록' });
    await within(log).findByText('하나');
    expect(within(log).getAllByTitle('sa')).toHaveLength(2); // 첫 줄과 2분 뒤의 셋
  });

  it('쓰는 중인 부분 답 행은 시각 없이 항상 머리줄을 보이고 확정 행이 오면 사라진다(스펙 §4-8, 흔들림 없음)', async () => {
    mount(OFFICE, { ...VIEW, partial: { sa: '지금 쓰는 답' } });
    const log = await screen.findByRole('log', { name: '회의 기록' });
    const partial = (await within(log).findByText('지금 쓰는 답')).closest('.chat-row') as HTMLElement;
    expect(partial).not.toBeNull();
    expect(within(partial).getByTitle('sa')).toBeInTheDocument();
    expect(partial.textContent).not.toMatch(/\d{4}-\d{2}-\d{2}/); // 렌더마다 만든 시각을 보이지 않는다
  });

  it('「@이름」 으로 시작하면 그 에이전트에게만 보낸다(P2)', async () => {
    const fn = mount();
    await screen.findByRole('log', { name: '회의 기록' });
    await userEvent.type(screen.getByLabelText('메시지'), '@doc 일정 확인해 줘');
    await userEvent.click(screen.getByRole('button', { name: '보내기' }));
    await waitFor(() => expect(postedTo(fn, '/api/office/meeting/say')).toHaveLength(1));
    expect(postedTo(fn, '/api/office/meeting/say')[0]).toMatchObject({ targets: ['doc'] });
  });
});

// 가드레일 차단 줄과 받는 사람 좁힘(스펙 2026-10-20-026 F2·F3, 디자인 리뷰 DD3~DD14)
describe('Office 회의: 가드레일 차단 줄', () => {
  const blocked = (id: number, alias: string) => ({
    id,
    role: 'system',
    author: alias,
    content: `${alias} 는 가드레일에 막혀 답하지 못했습니다`,
    ts: '2026-10-10T10:01:00+09:00',
    kind: 'guard_blocked',
    data: { alias },
  });
  const view = (extra: Record<string, unknown>[], more: Record<string, unknown> = {}) => ({
    ...VIEW,
    messages: [VIEW.messages[0], ...extra],
    pending: [],
    ...more,
  });

  it('이어진 차단 행은 호박색 경고 한 줄로 묶이고 보조 문장과 「다시 말하기」가 있다', async () => {
    mount(OFFICE, view([blocked(5, 'sa'), blocked(6, 'doc')]));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('sa, doc 는 가드레일에 막혀 답하지 못했습니다');
    expect(alert).toHaveTextContent('같은 말이 계속 막히면 관리자에게 알려 주세요');
    expect(screen.getAllByRole('alert')).toHaveLength(1);
    await userEvent.click(within(alert).getByRole('button', { name: '@sa @doc 에게 다시 말하기' }));
    expect(screen.getByLabelText('메시지')).toHaveValue('@sa @doc ');
    expect(screen.getByLabelText('메시지')).toHaveFocus();
  });

  it('꺼진 에이전트에게는 「다시 말하기」를 보이지 않는다', async () => {
    mount(
      OFFICE,
      view([blocked(5, 'doc')], {
        participants: [VIEW.participants[0], { ...VIEW.participants[1], enabled: false }],
      }),
    );
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('doc 는 가드레일에 막혀 답하지 못했습니다');
    expect(within(alert).queryByRole('button')).toBeNull();
  });

  it('쓰는 중인 부분 답이 차단 안내면 말풍선 대신 쓰는 중 점을 보인다', async () => {
    mount(OFFICE, view([], { pending: ['sa'], partial: { sa: '🚫 죄송합니다. 입력하신 내용이 정책에 위반되어 처리할 수 없습니다.' } }));
    await screen.findByRole('log', { name: '회의 기록' });
    expect(screen.queryByText(/정책에 위반/)).toBeNull();
  });
});

// 서버가 다시 시작돼 잃은 답(스펙 2026-10-20-030 R8·DR6·DR7)
describe('Office 회의: 서버가 다시 시작된 뒤', () => {
  const lost = (id: number, alias: string, mid: number | null) => ({
    id,
    role: 'system',
    author: alias,
    content: `서버가 다시 시작돼 ${alias} 의 답을 받지 못했습니다`,
    ts: '2026-10-10T10:01:00+09:00',
    kind: 'reply_lost',
    data: { alias, mid },
  });
  const view = (extra: Record<string, unknown>[], more: Record<string, unknown> = {}) => ({
    ...VIEW,
    messages: [VIEW.messages[0], ...extra],
    pending: [],
    ...more,
  });

  it('답을 받지 못한 줄은 경고(alert) 가 아니라 호박색 알림 한 줄이고, 「다시 묻기」는 빈 입력 칸에 @이름과 원래 말을 채운다', async () => {
    mount(OFFICE, view([lost(5, 'sa', 1), lost(6, 'doc', 1)]));
    const note = await screen.findByRole('note');
    expect(note).toHaveTextContent('서버가 다시 시작돼 sa, doc 의 답을 받지 못했습니다');
    expect(screen.queryByRole('alert')).toBeNull();
    await userEvent.click(within(note).getByRole('button', { name: '다시 묻기' }));
    expect(screen.getByLabelText('메시지')).toHaveValue('@sa @doc 일정 어떻게 돼?');
  });

  it('쓰던 글은 덮지 않고, 원래 말을 모르면(옛 행) 링크가 없다', async () => {
    mount(OFFICE, view([lost(5, 'sa', null)]));
    const note = await screen.findByRole('note');
    expect(within(note).queryByRole('button')).toBeNull();
  });

  it('정리 전 죽은 서버의 기다림은 입력 중 점 대신 「확인하는 중」이다', async () => {
    mount(OFFICE, view([], { stale: ['doc'] }));
    expect(await screen.findByText('doc 의 답을 확인하는 중입니다')).toBeInTheDocument();
  });
});

describe('Office 회의: @ 뒤 받는 사람 좁힘', () => {
  const checked = (re: RegExp) => (screen.getByRole('checkbox', { name: re }) as HTMLInputElement).checked;

  async function narrowTo(fn: ReturnType<typeof mount>, text = '@doc 확인') {
    await screen.findByRole('log', { name: '회의 기록' });
    await userEvent.type(screen.getByLabelText('메시지'), text);
    await userEvent.click(screen.getByRole('button', { name: '보내기' }));
    await waitFor(() => expect(postedTo(fn, '/api/office/meeting/say')).toHaveLength(1));
    await waitFor(() => expect(screen.getByLabelText('메시지')).toHaveValue(''));
  }

  it('@ 로 부른 말 뒤 다음 한 말만 그 대상에게 가고, 보낸 뒤 원래대로 돌아간다', async () => {
    const fn = mount();
    await narrowTo(fn);
    expect(screen.getByText(/이어서 @doc 에게만 보냅니다/)).toBeInTheDocument();
    expect([checked(/sa \(영업\) · yj/), checked(/doc · scdf/)]).toEqual([false, true]);
    await userEvent.type(screen.getByLabelText('메시지'), '저장해 줘');
    await userEvent.click(screen.getByRole('button', { name: '보내기' }));
    await waitFor(() => expect(postedTo(fn, '/api/office/meeting/say')).toHaveLength(2));
    expect(postedTo(fn, '/api/office/meeting/say')[1]).toMatchObject({ targets: ['doc'] });
    await waitFor(() => expect(screen.queryByText(/이어서 @doc 에게만 보냅니다/)).toBeNull());
    expect([checked(/sa \(영업\) · yj/), checked(/doc · scdf/)]).toEqual([true, true]);
  });

  it('「모두에게」를 누르면 이번 좁힘만 풀린다', async () => {
    const fn = mount();
    await narrowTo(fn);
    await userEvent.click(screen.getByRole('button', { name: '모두에게' }));
    expect(screen.queryByText(/이어서 @doc 에게만 보냅니다/)).toBeNull();
    expect([checked(/sa \(영업\) · yj/), checked(/doc · scdf/)]).toEqual([true, true]);
  });

  it('좁혀진 동안 칩을 누르면 이번 말의 받는 사람만 고친다', async () => {
    const fn = mount();
    await narrowTo(fn);
    await userEvent.click(screen.getByRole('checkbox', { name: /sa \(영업\) · yj/ }));
    await userEvent.type(screen.getByLabelText('메시지'), '둘 다');
    await userEvent.click(screen.getByRole('button', { name: '보내기' }));
    await waitFor(() => expect(postedTo(fn, '/api/office/meeting/say')).toHaveLength(2));
    expect(postedTo(fn, '/api/office/meeting/say')[1]).toMatchObject({ targets: ['sa', 'doc'] });
  });

  it('보내기가 실패하면 좁히지 않고, 건너뛴 대상은 좁힘에서 뺀다', async () => {
    const failing = stubApi({
      '/api/office/state': { agents: [], seq: 0 },
      '/api/office/meeting/say': new Response(JSON.stringify({ error: '끝난 방입니다' }), { status: 409 }),
      '/api/office/meeting': VIEW,
      '/api/office': OFFICE,
    });
    mountScreen(<Office />, '/office?tab=meeting');
    await screen.findByRole('log', { name: '회의 기록' });
    await userEvent.type(screen.getByLabelText('메시지'), '@doc 확인');
    await userEvent.click(screen.getByRole('button', { name: '보내기' }));
    await waitFor(() => expect(postedTo(failing, '/api/office/meeting/say')).toHaveLength(1));
    expect(screen.queryByText(/이어서 @doc 에게만 보냅니다/)).toBeNull();
  });

  it('여러 명을 부르면 모두로 좁히되 이번 말을 건너뛴 대상은 뺀다', async () => {
    const fn = stubApi({
      '/api/office/state': { agents: [], seq: 0 },
      '/api/office/meeting/say': { ok: true, targets: ['sa'], skipped: [{ alias: 'doc', reason: 'unsupported' }] },
      '/api/office/meeting': VIEW,
      '/api/office': OFFICE,
    });
    mountScreen(<Office />, '/office?tab=meeting');
    await narrowTo(fn, '@sa @doc 비교해 줘');
    expect(screen.getByText(/이어서 @sa 에게만 보냅니다/)).toBeInTheDocument();
  });
});

// TFT 방을 만들 때 적은 내용을 회의 화면에서도 고친다(스펙 2026-10-18-007). 고치기는 관리자만(서버 /api/office/action 과 같다)
describe('Office 회의: 방 정보 고치기', () => {
  it('관리자는 TFT 방 머리의 「방 정보 고치기」로 만들 때의 서랍을 지금 값으로 열고, 저장하면 그 방 id 로 room.set 을 보낸다', async () => {
    const fn = mount();
    await userEvent.click(await screen.findByRole('button', { name: '방 정보 고치기' }));
    const name = await screen.findByLabelText(/방 이름/);
    expect(name).toHaveValue('제안 TFT');
    await userEvent.clear(name);
    await userEvent.type(name, '제안 TFT 2');
    await userEvent.click(screen.getByRole('button', { name: '저장' }));
    await waitFor(() =>
      expect(postedTo(fn, '/api/office/action')).toContainEqual(expect.objectContaining({ action: 'room.set', id: 1, name: '제안 TFT 2' }))
    );
  });

  it('담당·구성원은 자기 TFT 방에서 단추를 본다(2026-10-18-009)', async () => {
    mount({ ...OFFICE, can_edit: false, rooms: [{ ...room(1, '제안 TFT'), my_role: 'owner' }] } as unknown as typeof OFFICE);
    expect(await screen.findByRole('button', { name: '방 정보 고치기' })).toBeInTheDocument();
  });

  it('관리자가 아니고 역할도 없으면 단추가 없다', async () => {
    mount({ ...OFFICE, can_edit: false });
    expect(await screen.findByText('일정 어떻게 돼?')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '방 정보 고치기' })).not.toBeInTheDocument();
  });

  it('팀 방은 자리의 팀을 따라가므로 단추가 없다', async () => {
    mount({ ...OFFICE, rooms: [{ ...room(1, '플랫폼'), kind: 'team' }] } as unknown as typeof OFFICE);
    expect(await screen.findByText('일정 어떻게 돼?')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '방 정보 고치기' })).not.toBeInTheDocument();
  });
});

// 같은 이름의 팀 방과 TFT 방을 구분하도록 이름 옆에 종류 뱃지를 단다(스펙 2026-10-20-020)
describe('Office 회의: 방 종류 뱃지', () => {
  it('팀 방은 「팀」, TFT 방은 「TFT」 뱃지를 달고, 둘째 줄은 목적만 보인다', async () => {
    mount({ ...OFFICE, rooms: [{ ...room(5, 'AAS 개발팀'), kind: 'team', purpose: '' }, { ...room(1, 'AAS 개발팀'), purpose: '기능개발 완료' }] } as unknown as typeof OFFICE);
    const list = within(await screen.findByRole('list'));
    const [team, tft] = list.getAllByRole('button');
    expect(team.querySelector('[data-pill]')).toHaveTextContent(/^팀$/);
    expect(tft.querySelector('[data-pill]')).toHaveTextContent(/^TFT$/);
    expect(team).not.toHaveTextContent('팀 회의'); // 종류는 뱃지로만 알린다
    expect(tft).toHaveTextContent('기능개발 완료');
    expect(team).toHaveAttribute('aria-label', 'AAS 개발팀 · 팀 회의'); // 화면 읽기 이름은 그대로
  });
});

// 회의 탭에서 바로 TFT 방을 만들고 그 방의 회의로 옮겨 간다(스펙 2026-10-20-018). 만들기는 관리자만
describe('Office 회의: 새 TFT 방', () => {
  it('관리자는 방 목록 위 「새 TFT 방」으로 방을 만들고, 저장하면 새 방이 선택된다', async () => {
    let made = false;
    const fn = stubApi({
      '/api/office/state': { agents: [], seq: 0 },
      '/api/office/meeting': VIEW,
      '/api/office/action': () => {
        made = true;
        return { ok: true, id: 7 };
      },
      '/api/office': () => (made ? { ...OFFICE, rooms: [...OFFICE.rooms, room(7, '릴리즈 점검')] } : OFFICE),
    });
    mountScreen(<Office />, '/office?tab=meeting');
    const list = await screen.findByRole('complementary', { name: '회의 방 목록' });
    await userEvent.click(within(list).getByRole('button', { name: '새 TFT 방' }));
    await userEvent.type(await screen.findByLabelText('방 이름'), '릴리즈 점검');
    await userEvent.type(screen.getByLabelText(/무엇을 끝내려고 모였나요/), '릴리즈 전 점검을 끝낸다');
    await userEvent.click(screen.getByRole('button', { name: '저장' }));
    await waitFor(() => expect(postedTo(fn, '/api/office/action')[0]).toMatchObject({ action: 'room.set', id: 0, name: '릴리즈 점검' }));
    await waitFor(() => expect(within(list).getByRole('button', { name: '릴리즈 점검' })).toHaveAttribute('aria-current', 'true'));
    await waitFor(() => expect(fn.mock.calls.some((c) => String(c[0]).includes('/api/office/meeting?room=7'))).toBe(true));
  }, 15000);

  it('관리자가 아니면 「새 TFT 방」 단추가 없다', async () => {
    mount({ ...OFFICE, can_edit: false });
    await screen.findByRole('complementary', { name: '회의 방 목록' });
    expect(screen.queryByRole('button', { name: '새 TFT 방' })).not.toBeInTheDocument();
  });

  it('열린 방이 없으면 관리자에게는 「새 TFT 방」을, 다른 사람에게는 TFT 방 탭 안내만 보인다', async () => {
    mount({ ...OFFICE, rooms: [] });
    expect(await screen.findByRole('button', { name: '새 TFT 방' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'TFT 방 탭 열기' })).toBeInTheDocument();
  });

  it('열린 방이 없을 때 관리자가 아니면 만들기 단추가 없다', async () => {
    mount({ ...OFFICE, can_edit: false, rooms: [] });
    expect(await screen.findByRole('button', { name: 'TFT 방 탭 열기' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '새 TFT 방' })).not.toBeInTheDocument();
  });
});

// 회의 화면은 자리 별칭(aas-agent-…) 대신 에이전트 이름을 보인다(스펙 2026-10-18-010). 서버가 label·labels 를 준다
describe('Office 회의: 에이전트 이름', () => {
  const LABELED = {
    ...VIEW,
    participants: [
      { alias: 'sa', title: '영업', pod: 'yj', enabled: true, label: 'AAS 관리자' },
      { alias: 'doc', title: '', pod: 'scdf', enabled: true, label: '시험계정' },
    ],
    labels: { sa: 'AAS 관리자', doc: '시험계정' },
    pending: ['sa'],
    messages: [
      ...VIEW.messages.slice(0, 2),
      { id: 3, role: 'system', author: 'doc', content: '시험계정 가 답하지 못했습니다: 시간 초과', ts: '2026-10-10T10:00:09+09:00' },
    ],
  };

  it('받는 에이전트 칩·답한 사람·답하는 중 줄이 에이전트 이름이다', async () => {
    mount(OFFICE, LABELED);
    const chip = await screen.findByRole('checkbox', { name: /AAS 관리자 \(영업\) · yj/ });
    expect(chip.closest('label')).toHaveTextContent('AAS 관리자');
    expect(screen.getByRole('checkbox', { name: /시험계정 · scdf/ })).toBeInTheDocument();
    expect(screen.queryByText('sa')).not.toBeInTheDocument(); // 화면 어디에도 별칭이 글자로 남지 않는다
    expect(screen.getAllByText('AAS 관리자').length).toBeGreaterThan(1); // 칩 + 답한 사람 머리
  });

  it('이름을 주지 않으면 별칭을 그대로 보인다(예전 서버)', async () => {
    mount();
    expect(await screen.findByRole('checkbox', { name: /sa \(영업\) · yj/ })).toBeInTheDocument();
  });
});

// 입력창 「@」 에이전트·「/」 스킬(스펙 2026-10-19-012 P5·D2·D3, 디자인 DD6·DD8·DD9)
describe('Office 회의: @ 이름과 / 스킬', () => {
  const VIEW2 = {
    ...VIEW,
    participants: [
      { alias: 'sa', title: '영업', pod: 'yj', enabled: true, label: '관리자 에이전트' },
      { alias: 'doc', title: '', pod: 'scdf', enabled: true, label: '문서' },
    ],
    labels: { sa: '관리자 에이전트', doc: '문서' },
    pending: [],
  };
  const SKILLS = {
    skills: [{ command: '/요약', name: '요약', description: '주간 요약', usage: 1, agents: ['sa'] }],
    members: ['sa', 'doc'],
    failed: [],
  };
  function mount2(skills: unknown = SKILLS) {
    const fn = stubApi({
      '/api/office/state': { agents: [], seq: 0 },
      '/api/office/meeting/say': { ok: true, targets: ['sa'] },
      '/api/office/meeting/skills': skills,
      '/api/office/meeting': VIEW2,
      '/api/office': OFFICE,
    });
    mountScreen(<Office />, '/office?tab=meeting');
    return fn;
  }
  const say = () => screen.getByRole('textbox', { name: '메시지' });

  it('한글·띄어쓰기 이름으로 대상이 좁혀지고 안내는 이름으로 쓴다. 두 번 부르면 둘 다', async () => {
    const fn = mount2();
    const user = userEvent.setup();
    await screen.findByRole('log', { name: '회의 기록' });
    await user.type(say(), '@관리자 에이전트 확인해 줘');
    expect(screen.getByText(/@관리자 에이전트 에게만 보냅니다/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '보내기' }));
    await waitFor(() => expect(postedTo(fn, '/api/office/meeting/say')).toHaveLength(1));
    expect(postedTo(fn, '/api/office/meeting/say')[0]).toMatchObject({ targets: ['sa'] });
    await user.type(say(), '@관리자 에이전트 @문서 둘 다');
    await user.click(screen.getByRole('button', { name: '보내기' }));
    await waitFor(() => expect(postedTo(fn, '/api/office/meeting/say')).toHaveLength(2));
    expect(postedTo(fn, '/api/office/meeting/say')[1]).toMatchObject({ targets: ['sa', 'doc'] });
  });

  it('칩으로 끈 에이전트도 @ 로 부르면 받고(D3) 「받는 에이전트 없음」이 뜨지 않는다', async () => {
    const fn = mount2();
    const user = userEvent.setup();
    await screen.findByRole('log', { name: '회의 기록' });
    await user.click(await screen.findByRole('checkbox', { name: /관리자 에이전트 \(영업\)/ }));
    await user.click(screen.getByRole('checkbox', { name: /문서 · scdf/ }));
    expect(screen.getByText('받는 AI 에이전트를 하나 이상 켜 주세요')).toBeInTheDocument();
    await user.type(say(), '@문서 봐 줘');
    expect(screen.queryByText('받는 AI 에이전트를 하나 이상 켜 주세요')).toBeNull();
    expect(screen.getByRole('checkbox', { name: /문서 · scdf/ })).toBeChecked();
    await user.click(screen.getByRole('button', { name: '보내기' }));
    await waitFor(() => expect(postedTo(fn, '/api/office/meeting/say')[0]).toMatchObject({ targets: ['doc'] }));
  });

  it('@ 목록은 부른 사람을 빼고, 고르면 이름을 넣는다(DD8)', async () => {
    mount2();
    const user = userEvent.setup();
    await screen.findByRole('log', { name: '회의 기록' });
    await user.type(say(), '@');
    const names = () => within(screen.getByRole('listbox', { name: 'AI 에이전트' })).getAllByRole('option').map((o) => o.textContent);
    expect(names()).toEqual(['관리자 에이전트영업', '문서']);
    await user.keyboard('{ArrowDown}{Enter}');
    expect(say()).toHaveValue('@문서 ');
    await user.type(say(), '@');
    expect(names()).toEqual(['관리자 에이전트영업']);
  });

  it('/ 목록은 받는 대상이 가진 스킬과 「1/2 에이전트」, 보낼 때 skill 을 붙이고 없는 대상을 미리 알린다(DD9)', async () => {
    const fn = mount2();
    const user = userEvent.setup();
    await screen.findByRole('log', { name: '회의 기록' });
    await user.type(say(), '/');
    const opt = await screen.findByRole('option', { name: /\/요약, 2명 중 1명이 가짐, 문서 에는 없음/ });
    expect(opt).toHaveTextContent('1/2 AI 에이전트');
    await user.keyboard('{Enter}정리');
    expect(screen.getByText(/스킬 \/요약 으로 보냅니다/)).toBeInTheDocument();
    expect(screen.getByText(/문서 에게는 이 스킬이 없어 글만 갑니다/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '보내기' }));
    await waitFor(() => expect(postedTo(fn, '/api/office/meeting/say')).toHaveLength(1));
    expect(postedTo(fn, '/api/office/meeting/say')[0]).toMatchObject({ text: '/요약 정리', skill: '요약', targets: ['sa', 'doc'] });
  });

  it('읽지 못한 참가자는 목록 아래 호박색 줄로 알린다(DD4)', async () => {
    mount2({ ...SKILLS, failed: ['doc'] });
    const user = userEvent.setup();
    await screen.findByRole('log', { name: '회의 기록' });
    await user.type(say(), '/');
    expect(await screen.findByText('문서 의 스킬을 읽지 못했습니다')).toBeInTheDocument();
  });
});

// 스펙 2026-10-20-017 디자인 리뷰 이슈 8: 회의 머리줄에 에이전트가 모이는 회의실(장면과 같은 규칙)
describe('Office 회의: 장소', () => {
  const ITEMS = [
    { _uid: 'kr_tft_1', type: 'room', kind: 'tft', label: 'TFT 회의실 1', x: 0, y: 0, w: 280, h: 240 },
    { _uid: 'kr_big', type: 'room', kind: 'meeting', label: '대회의실', x: 400, y: 0, w: 360, h: 200 },
  ];
  const mountPlace = (meetings: object[]) => {
    stubApi({
      '/api/office/state': { agents: [], seq: 0, layout_version: 1, rooms: [{ uid: 'kr_tft_1', kind: 'tft', label: '제안 TFT', room: 1 }] },
      '/api/office/layout': { version: 1, items: ITEMS, desks: {} },
      '/api/office/meeting/active': { meetings },
      '/api/office/meeting': VIEW,
      '/api/office': OFFICE,
    });
    mountScreen(<Office />, '/office?tab=meeting');
  };

  it('회의가 없으면 서버 짝 회의실의 명패 글자를 장소로 보인다', async () => {
    mountPlace([]);
    expect(await screen.findByText('장소: 제안 TFT')).toBeInTheDocument();
  });

  it('짝이 없는 방의 회의는 대회의실이 장소다', async () => {
    stubApi({
      '/api/office/state': { agents: [], seq: 0, layout_version: 1, rooms: [] },
      '/api/office/layout': { version: 1, items: ITEMS, desks: {} },
      '/api/office/meeting/active': { meetings: [{ room: 1, seats: ['sa'], pending: [], speaker: null, at: 1 }] },
      '/api/office/meeting': VIEW,
      '/api/office': OFFICE,
    });
    mountScreen(<Office />, '/office?tab=meeting');
    expect(await screen.findByText('장소: 대회의실')).toBeInTheDocument();
  });
});

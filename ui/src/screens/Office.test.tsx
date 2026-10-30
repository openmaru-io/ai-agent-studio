/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { chatStore } from '@/lib/chatStore';
import { popupStanding, raisePopup } from '@/lib/popupOrder';
import { closeRoomChat, roomChatPopupState } from '@/lib/roomChatPopup';
import { watchChatPopup } from '@/test/chatPopup';
import { FakeES } from '@/test/fakeEventSource';
import { HistoryBack, mountScreen, postedTo, rowByName, stubApi } from '@/test/mountScreen';

import { Office } from './Office';

// WebGL 은 jsdom 에서 그릴 수 없다. 장면은 받은 자리 목록을 글자로 보여 주는 대역으로 바꾼다.
vi.mock('@/features/office/OfficeScene', () => ({
  default: ({
    agents,
    furniture,
    desks,
    speech,
    meeting,
    onDevice,
    onMeetingScreen,
    onRoomLabel,
    roomsInMeeting,
    roomStatus,
    onLayoutMissing,
    onSelectAgent,
    focusRequest,
    followAgentId,
  }: {
    focusRequest?: { id: string; n: number; at?: { x: number; y: number }; highlight?: string } | null;
    followAgentId?: string | null;
    roomStatus?: Record<string, { text: string; moved: boolean }>;
    onMeetingScreen?: (screenUid: string) => void;
    onRoomLabel?: (roomUid: string) => void;
    roomsInMeeting?: Set<string>;
    speech?: Record<string, string>;
    onDevice?: (d: string) => void;
    meeting?: { participantOrder: string[]; currentSpeakerAgentId: string | null } | null;
    agents: { id: string; name: string; status: string }[];
    furniture: { _uid: string }[] | null;
    desks: Record<string, string>;
    onLayoutMissing?: (items: { _uid: string; type: string; x: number; y: number }[]) => void;
    onSelectAgent?: (id: string) => void;
  }) => (
    <div>
      <ul aria-label="장면">
        {agents.map((a) => (
          <li key={a.id}>
            <button onClick={() => onSelectAgent?.(a.id)}>{`${a.name}:${a.status}`}</button>
          </li>
        ))}
      </ul>
      <p>{furniture ? `가구 ${furniture.length}` : '판 없음'}</p>
      {['server', 'qa', 'kanban', 'meeting'].map((d) => (
        <button key={d} onClick={() => onDevice?.(d)}>{`장치 ${d}`}</button>
      ))}
      {(furniture as { _uid: string; type: string }[] | null)
        ?.filter((f) => f.type === 'tv_meeting')
        .map((f) => (
          <button key={f._uid} onClick={() => onMeetingScreen?.(f._uid)}>{`스크린 ${f._uid}`}</button>
        ))}
      {(furniture as { _uid: string; type: string }[] | null)
        ?.filter((f) => f.type === 'room')
        .map((f) => (
          <button key={f._uid} onClick={() => onRoomLabel?.(f._uid)}>{`명패 ${f._uid}`}</button>
        ))}
      <p>{`회의 중인 방 ${[...(roomsInMeeting ?? [])].join(',')}`}</p>
      <p>{`명패 글 ${Object.entries(roomStatus ?? {}).map(([u, st]) => `${u}=${st.text}${st.moved ? '(옮겨 감)' : ''}`).join(',')}`}</p>
      {meeting && <p>{`회의실 ${meeting.participantOrder.join(',')} 말하는 ${meeting.currentSpeakerAgentId ?? '-'}`}</p>}
      {Object.entries(speech ?? {}).map(([id, text]) => (
        <p key={id}>{`말풍선 ${id}: ${text}`}</p>
      ))}
      <p>{`책상 ${Object.entries(desks).map(([d, a]) => `${d}=${a}`).join(',')}`}</p>
      <p>{`카메라 ${focusRequest ? `${focusRequest.id}@${focusRequest.at ? `${focusRequest.at.x},${focusRequest.at.y}` : '-'}` : '-'}`}</p>
      <p>{`표시 ${focusRequest?.highlight ?? '-'}`}</p>
      <p>{`따라가기 ${followAgentId ?? '-'}`}</p>
      {!furniture && (
        <button onClick={() => onLayoutMissing?.([{ _uid: 'office_0', type: 'desk_cubicle', x: 1, y: 1 }])}>기본 배치 올리기</button>
      )}
    </div>
  ),
}));

// jsdom 에는 WebGL 이 없다. 기본은 '있음'으로 두고, 없을 때의 2D 대체는 따로 시험한다.
const webgl = vi.hoisted(() => ({ ok: true }));
vi.mock('@/features/office/SceneBoundary', async (orig) => ({
  ...(await orig<typeof import('@/features/office/SceneBoundary')>()),
  canUseWebGL: () => webgl.ok,
}));

// 오피스 정보 변경 신호 office:changed 의 받는 함수를 잡아 시험이 서버 push 를 흉내 낸다(스펙 2026-10-26-001). 다른 토픽은 그대로 둔다
const changed = vi.hoisted(() => ({ push: null as ((d: unknown) => void) | null }));
vi.mock('@/lib/ws', async (orig) => {
  const real = await orig<typeof import('@/lib/ws')>();
  return {
    ...real,
    useTopic: (topic: string | null, onData: (d: unknown) => void, client?: Parameters<typeof real.useTopic>[2]) => {
      if (topic === 'office:changed') changed.push = onData;
      return real.useTopic(topic, onData, client);
    },
  };
});

const seat = (alias: string, extra = {}) => ({
  alias,
  pod: 'one',
  profile: alias,
  enabled: true,
  title: '',
  role: '',
  team: '',
  note: '',
  has_key: false,
  ...extra,
});
const agent = (alias: string, status = 'idle', extra = {}) => ({
  alias,
  pod: 'one',
  profile: alias,
  status,
  title: '',
  role: '',
  team: '',
  avatar: '',
  ...extra,
});

const OFFICE = {
  seats: [seat('ops', { role: '운영', team: '플랫폼' })],
  rooms: [
    { id: 3, name: '장애 대응', purpose: '결제 지연', owner: 'kim', seats: ['ops'], people: ['lee'], status: 'open' },
  ],
  pods: [
    {
      id: 'one',
      owner: 'kim',
      profiles: [
        { name: 'ops', seated: true },
        { name: 'qa', seated: false },
      ],
    },
  ],
  problems: [],
  can_edit: true,
};

beforeEach(() => {
  webgl.ok = true;
  FakeES.all = [];
  vi.stubGlobal('EventSource', FakeES);
});
afterEach(() => vi.unstubAllGlobals());

const LAYOUT = { version: 1, items: [{ _uid: 'office_0', type: 'desk_cubicle', x: 1, y: 1 }], desks: { office_0: 'ops' } };

function mount(initial = '/office', data: Record<string, unknown> = OFFICE, layout: unknown = LAYOUT) {
  const fn = stubApi({
    '/api/office/action': { ok: true },
    '/api/office/state': { agents: [agent('ops')], seq: 1, desks: { office_0: 'ops' }, layout_version: 1 },
    '/api/office/layout': layout,
    '/api/office/presence': { people: [] },
    '/api/users': { users: [{ email: 'lee@x.com', name: '이영희' }, { email: 'park@x.com', name: '박민수' }, { email: 'choi@x.com', name: '최지원', department: '개발팀' }] },
    // 「회의 열기」로 회의 탭에 닿는 시험이 쓴다. `/api/office` 보다 앞에 있어야 접두어 맞춤에서 먼저 잡힌다
    '/api/office/meeting': { room: { id: 3, name: '장애 대응', purpose: '', status: 'open' }, participants: [], messages: [], pending: [] },
    '/api/office': data,
  });
  mountScreen(<Office />, initial);
  return fn;
}

/** 명단 행 단추(행마다 '대화'·'상세' 단추가 따로 있어 이름으로는 행을 고를 수 없다, OMAI-1115). */
const rows = (roster: HTMLElement) => [...roster.querySelectorAll<HTMLElement>('[data-roster-item]')];

describe('Office', () => {
  it('3D 장면을 받는 동안의 안내는 장면 영역 한가운데에 보인다(왼쪽 위 구석이 아니다)', async () => {
    stubApi({
      '/api/office/state': { agents: [agent('ops')], seq: 1, desks: { office_0: 'ops' }, layout_version: 1 },
      '/api/office/presence': { people: [] },
      '/api/office': OFFICE,
    });
    const base = globalThis.fetch;
    // 배치(layout)만 끝내 오지 않게 해 「불러오는 중」 상태를 붙잡는다
    vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => (String(url).startsWith('/api/office/layout') ? new Promise<Response>(() => {}) : base(url, init))));
    mountScreen(<Office />, '/office');
    const loading = (await screen.findByText('장면을 불러오는 중…')).closest('[role=status]') as HTMLElement;
    expect(loading).toHaveStyle({ position: 'absolute', display: 'grid' });
    expect(loading).not.toHaveStyle({ paddingLeft: '320px' });                 // 예전 pl: 40(=320px) 로 왼쪽 위 구석에 붙지 않는다
  });

  it('팀 방은 TFT 방 탭과 개수에서 빠지고 회의 탭에서는 맨 앞에 「팀 회의」로 나온다(계획 2026-10-13-011)', async () => {
    const team = { id: 9, name: '플랫폼', purpose: '', owner: '', seats: ['ops'], people: [], status: 'open', kind: 'team' };
    stubApi({
      '/api/office/meeting': { room: team, participants: [], messages: [], pending: [] },
      '/api/office/state': { agents: [agent('ops')], seq: 1, desks: {}, layout_version: 1 },
      '/api/office/layout': LAYOUT,
      '/api/office/presence': { people: [] },
      '/api/office': { ...OFFICE, rooms: [...OFFICE.rooms, team] },
    });
    mountScreen(<Office />, '/office?tab=rooms');
    expect(await screen.findByRole('tab', { name: 'TFT 방 1' })).toBeInTheDocument();
    expect(await screen.findByText('장애 대응')).toBeInTheDocument(); // 방 표는 탭을 열 때 받는다(lazy)
    expect(screen.queryByRole('row', { name: /플랫폼/ })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('tab', { name: '회의실' }));
    const list = within(await screen.findByRole('complementary', { name: '회의 방 목록' }));
    expect(within(list.getByRole('list')).getAllByRole('button').map((o) => o.getAttribute('aria-label'))).toEqual(['플랫폼 · 팀 회의', '장애 대응']); // 목록 위 「새 TFT 방」 단추는 빼고 센다
  });

  it('화면 제목은 「<회사> > <부서> 오피스」다(OMAI-1121 §3-5, 좌측 메뉴는 「오피스」 그대로)', async () => {
    stubApi({
      '/api/office/state': { agents: [agent('ops')], seq: 1, desks: { office_0: 'ops' }, layout_version: 1 },
      '/api/office/layout': LAYOUT,
      '/api/office/presence': { people: [] },
      '/api/office': OFFICE,
      '/api/me': { auth_enabled: true, admin: false, user: { email: 'lee@x.com' }, department: '마케팅팀', company_name: 'ACME' },
    });
    mountScreen(<Office />, '/office?tab=seats');
    expect(await screen.findByRole('heading', { level: 1, name: 'ACME > 마케팅팀 오피스' })).toBeInTheDocument();
  });

  it('탭은 오피스·칸반·회의실·TFT 방·배치 순서다(회의실과 TFT 방을 붙이고 설정인 배치는 끝, 스펙 2026-10-20-019·020)', async () => {
    mount();
    await screen.findByRole('tab', { name: '배치 1' });
    // 상태판에도 탭(명단·회의실)이 있어 화면 탭 목록 안에서만 센다(스펙 2026-10-20-021 F7)
    const screenTabs = within(screen.getByRole('tablist', { name: '오피스 탭' })).getAllByRole('tab');
    expect(screenTabs.map((x) => x.textContent)).toEqual(['오피스', '칸반', '회의실', 'TFT 방1', '배치1']);
  });

  it('탭에 자리·방 개수를 보이고 실시간 상태를 장면에 넘긴다', async () => {
    mount();
    expect(await screen.findByRole('tab', { name: '배치 1' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'TFT 방 1' })).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'ops:idle' })).toBeInTheDocument();
    act(() => FakeES.all[0].emit('chat.start', { alias: 'ops' }, '2'));
    expect(await screen.findByRole('button', { name: 'ops:working' })).toBeInTheDocument();
  });

  it('탭의 개수는 다른 화면의 탭과 같은 배지(Chip 이 아니라 탭 글자 오른쪽 위 모서리)로 보인다(OMAI-1234)', async () => {
    mount();
    for (const name of ['배치 1']) {
      const tab = await screen.findByRole('tab', { name });
      expect(tab.querySelector('.MuiChip-root')).toBeNull();
      const badge = tab.querySelector('.MuiBadge-badge');
      expect(badge).not.toBeNull();
      expect(badge).toHaveClass('MuiBadge-anchorOriginTopRight');
      expect(badge?.textContent).toBe('1');
    }
  });

  it('서버 레이아웃과 책상 배정을 장면에 넘긴다(모두가 같은 오피스, 계획 007 P−1)', async () => {
    mount();
    expect(await screen.findByText('가구 1')).toBeInTheDocument();
    expect(await screen.findByText('책상 office_0=ops')).toBeInTheDocument();
  });

  it('서버에 판이 없어도 브라우저는 배치를 올리지 않는다 — 판은 서버가 만든다(계획 2026-10-13-001 §3-5)', async () => {
    const fn = mount('/office', OFFICE, { version: 0, items: null, desks: {} });
    await userEvent.click(await screen.findByRole('button', { name: '기본 배치 올리기' }));
    await new Promise((r) => setTimeout(r, 50));
    expect(postedTo(fn, '/api/office/layout')).toHaveLength(0);
  });

  it('도구·답 글 이벤트를 말풍선으로 넘기고, 대화가 끝나면 지운다(P1)', async () => {
    mount();
    await screen.findByRole('button', { name: 'ops:idle' });
    act(() => FakeES.all[0].emit('tool', { alias: 'ops', name: 'web_search' }, '2'));
    expect(await screen.findByText('말풍선 ops: 도구: web_search')).toBeInTheDocument();
    act(() => FakeES.all[0].emit('chat.delta', { alias: 'ops', text: '찾아보니' }, '3'));
    expect(await screen.findByText('말풍선 ops: 찾아보니')).toBeInTheDocument();
    act(() => FakeES.all[0].emit('chat.end', { alias: 'ops' }, '4'));
    await waitFor(() => expect(screen.queryByText(/말풍선 ops/)).not.toBeInTheDocument());
  });

  it('진행 중인 회의의 참가 에이전트를 장면의 회의실로 모은다(P3)', async () => {
    stubApi({
      '/api/office/meeting/active': {
        meetings: [{ room: 3, name: '장애 대응', seats: ['ops', 'nobody'], pending: ['ops'], speaker: 'ops', at: 1, partial: { ops: '확인 중' } }],
      },
      '/api/office/state': { agents: [agent('ops')], seq: 1, desks: {}, layout_version: 1 },
      '/api/office/layout': LAYOUT,
      '/api/office': OFFICE,
    });
    mountScreen(<Office />, '/office');
    expect(await screen.findByText('회의실 ops 말하는 ops')).toBeInTheDocument();
  });

  it('탭 줄 오른쪽 끝에 받은편지함 종이 없다 — 상단 막대에만 둔다(2026-10-15)', async () => {
    stubApi({
      '/api/office/inbox': { items: [{ id: 'c', kind: 'cron_failed', alias: 'ops', text: '아침 보고' }] },
      '/api/office/cards': { cards: [] },
      '/api/agents': { admin: false, enabled: true, agents: [] },
      '/api/office/state': { agents: [agent('ops')], seq: 1, desks: {}, layout_version: 1 },
      '/api/office/layout': LAYOUT,
      '/api/office': OFFICE,
    });
    mountScreen(<Office />, '/office');
    await screen.findByRole('tab', { name: /오피스/ });
    expect(screen.queryByRole('button', { name: /받은편지함/ })).not.toBeInTheDocument();
  });

  it('장치를 누르면 AAS 기능을 연다 — 칸반 보드·QA 단말·서버 단말·회의 탁자(P5)', async () => {
    stubApi({
      '/api/office/cards': { cards: [{ board: 'b', task_id: '1', status: 'running', assignee: 'ops', title: '배포 준비' }] },
      '/api/office/inbox': { items: [{ id: 'c', kind: 'cron_failed', alias: 'ops', text: '아침 보고' }, { id: 'a', kind: 'approval', alias: 'ops', text: '승인' }] },
      '/api/agents': { admin: false, enabled: true, agents: [] },
      '/api/office/meeting': { room: { id: 3, name: '장애 대응', purpose: '', status: 'open' }, participants: [], messages: [], pending: [] },
      '/api/office/state': { agents: [agent('ops')], seq: 1, desks: {}, layout_version: 1 },
      '/api/office/layout': LAYOUT,
      '/api/office': OFFICE,
    });
    mountScreen(<Office />, '/office');
    await userEvent.click(await screen.findByRole('button', { name: '장치 kanban' }));
    expect(await screen.findByText('배포 준비')).toBeInTheDocument();
    await userEvent.keyboard('{Escape}');
    await userEvent.click(await screen.findByRole('button', { name: '장치 qa' }));
    expect(await screen.findByText('아침 보고')).toBeInTheDocument();
    expect(screen.queryByText('승인')).not.toBeInTheDocument(); // QA 단말은 실패한 크론·막힌 카드만
    await userEvent.keyboard('{Escape}');
    await userEvent.click(await screen.findByRole('button', { name: '장치 server' }));
    expect(await screen.findByText('AI 에이전트 작업공간 상태는 관리자만 볼 수 있습니다')).toBeInTheDocument();
    await userEvent.keyboard('{Escape}');
    await userEvent.click(await screen.findByRole('button', { name: '장치 meeting' }));
    await waitFor(() => expect(screen.getByTestId('loc')).toHaveTextContent('/office?tab=meeting'));
  });

  // 명단의 「상세」 로 에이전트 서랍을 연다(장면의 몸통 클릭은 따라가기다)
  const openAgentDrawer = async (alias = 'ops') => {
    const roster = await screen.findByRole('list', { name: 'AI 에이전트' });
    await userEvent.click(await within(roster).findByRole('button', { name: `${alias} 상세` }));
  };

  it('장면에서 에이전트 몸통을 누르면 서랍이 아니라 따라가기가 켜지고, 다시 누르면 꺼진다', async () => {
    mount();
    await userEvent.click(await screen.findByRole('button', { name: 'ops:idle' }));
    expect(await screen.findByRole('button', { name: '따라가기 끄기' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.queryByRole('dialog', { name: 'ops' })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'ops:idle' }));
    expect(await screen.findByRole('button', { name: '따라가기' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('장면에서 에이전트를 고르면 서랍에서 그 에이전트와의 대화 팝업을 연다', async () => {
    mount();
    const popup = watchChatPopup();
    await openAgentDrawer();
    // 남의 자리(내 POD 의 내 에이전트가 아님)는 오피스 대화 경로로 연다(OMAI-1115)
    await userEvent.click(await screen.findByRole('button', { name: 'ops 와 대화' }));
    expect(popup()).toMatchObject({ kind: 'office', alias: 'ops' });
    expect(screen.getByRole('link', { name: '칸반 보기' })).toHaveAttribute('href', '/office?tab=kanban');
    // 이 에이전트가 앉은 열린 방의 회의로 바로 간다
    expect(screen.getByRole('link', { name: '회의: 장애 대응' })).toHaveAttribute('href', '/office?tab=meeting&room=3');
  });

  it('에이전트 서랍은 제목·부제·에이전트 행을 에이전트 이름으로 보이고 id 는 풍선말이다(2026-10-18-014)', async () => {
    stubApi({
      '/api/office/state': { agents: [agent('ops', 'idle', { label: 'AAS 관리자', pod_name: '관리자 에이전트', owner_name: '김관리' })], seq: 1, desks: { office_0: 'ops' }, layout_version: 1 },
      '/api/office/layout': LAYOUT,
      '/api/office/presence': { people: [] },
      '/api/office': OFFICE,
    });
    mountScreen(<Office />, '/office');
    await openAgentDrawer('AAS 관리자'); // 명단의 단추 이름도 에이전트 이름이다(2026-10-18-017)
    const dlg = await screen.findByRole('dialog', { name: 'AAS 관리자' });
    expect(dlg).toHaveTextContent('김관리 · 관리자 에이전트 › ops'); // 부제는 「주인 · 에이전트 › 프로파일」(스펙 2026-10-19-003)
    expect(dlg).not.toHaveTextContent('one');
    const chip = within(dlg).getByText('관리자 에이전트', { selector: 'span span' });
    expect(chip.closest('[title]')).toHaveAttribute('title', 'one');
  });

  it('연 에이전트 서랍은 웹소켓으로 바뀐 상태·카드를 제자리에서 따라간다', async () => {
    mount();
    await openAgentDrawer();
    const dlg = await screen.findByRole('dialog', { name: 'ops' });
    expect(within(dlg).getByText('대기')).toBeInTheDocument();
    act(() => FakeES.all[0].emit('chat.start', { alias: 'ops' }, '2'));
    expect(await within(screen.getByRole('dialog', { name: 'ops' })).findByText('일하는 중')).toBeInTheDocument();
    expect(within(screen.getByRole('dialog', { name: 'ops' })).queryByText('대기')).not.toBeInTheDocument();
  });

  it('칸반 보드·서버 단말 서랍은 요약 한 줄과 상태 뱃지로 보인다', async () => {
    stubApi({
      '/api/office/cards': {
        cards: [
          { board: 'b', task_id: '1', status: 'running', assignee: 'ops', title: '배포 준비' },
          { board: 'b', task_id: '2', status: 'blocked', assignee: 'ops', title: '키 발급' },
        ],
      },
      '/api/agents': {
        admin: true,
        enabled: true,
        agents: [
          { name: 'p-a', owner: 'a@x.com', phase: 'Ready', ready: true },
          { name: 'p-b', owner: 'b@x.com', phase: 'Suspended', ready: false },
        ],
      },
      '/api/office/state': { agents: [agent('ops')], seq: 1, desks: {}, layout_version: 1 },
      '/api/office/layout': LAYOUT,
      '/api/office': OFFICE,
    });
    mountScreen(<Office />, '/office');
    await userEvent.click(await screen.findByRole('button', { name: '장치 kanban' }));
    expect(await screen.findByText('열린 카드 2장')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '막힘' })).toBeInTheDocument();
    await userEvent.keyboard('{Escape}');
    await userEvent.click(await screen.findByRole('button', { name: '장치 server' }));
    expect(await screen.findByText('1/2 준비됨')).toBeInTheDocument();
    expect(document.querySelector('[data-pill="good"]')).toHaveTextContent('준비됨');
    expect(document.querySelector('[data-pill="warn"]')).toHaveTextContent('Suspended');
  });

  it('연 칸반 보드 서랍은 카드가 다시 읽혀 바뀌면 그 값을 보인다', async () => {
    stubApi({
      '/api/office/cards': { cards: [{ board: 'b', task_id: '1', status: 'running', assignee: 'ops', title: '배포 준비' }] },
      '/api/office/state': { agents: [agent('ops')], seq: 1, desks: {}, layout_version: 1 },
      '/api/office/layout': LAYOUT,
      '/api/office': OFFICE,
    });
    const { qc } = mountScreen(<Office />, '/office');
    await userEvent.click(await screen.findByRole('button', { name: '장치 kanban' }));
    expect(await screen.findByText('배포 준비')).toBeInTheDocument();
    act(() =>
      qc.setQueryData(['office-cards'], { cards: [{ board: 'b', task_id: '2', status: 'running', assignee: 'ops', title: '새로 생긴 카드' }] })
    );
    expect(await screen.findByText('새로 생긴 카드')).toBeInTheDocument();
  });

  it('앉힌 자리가 없으면 안내한다', async () => {
    stubApi({
      '/api/office/state': { agents: [], seq: 1, desks: {}, layout_version: 1 },
      '/api/office/layout': LAYOUT,
      '/api/office': { ...OFFICE, seats: [] },
    });
    mountScreen(<Office />, '/office');
    expect(await screen.findByText(/아직 오피스에 배치한 AI 에이전트가 없습니다/)).toBeInTheDocument();
  });

  it('실시간 연결이 끊기면 장면을 밀지 않고 상태판에 마지막 갱신 시각을 보인다(G4)', async () => {
    mount();
    await screen.findByRole('button', { name: 'ops:idle' });
    act(() => void FakeES.all[0].onerror?.());
    expect(await screen.findByText(/마지막 갱신 \d+초 전/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'ops:idle' })).toBeInTheDocument();
  });

  it('WebGL 을 쓸 수 없으면 같은 자리에 2D 표를 보인다(G4)', async () => {
    webgl.ok = false;
    mount();
    const table = await screen.findByRole('table', { name: '2D 보기' });
    expect(await within(table).findByText('ops')).toBeInTheDocument();
    expect(within(table).getByText('배정됨')).toBeInTheDocument();
    expect(screen.queryByRole('list', { name: '장면' })).not.toBeInTheDocument();
  });

  it('다른 사람이 있으면 머리줄에 접속자 얼굴을 보이고, 나 혼자면 숨긴다(P6a)', async () => {
    const people = [
      { id: '1', name: '나', seed: 's1', viewing: 'room', me: true },
      { id: '2', name: '김철수', seed: 's2', viewing: 'room', me: false },
    ];
    const fn = stubApi({
      '/api/office/presence': { people },
      '/api/office/state': { agents: [agent('ops')], seq: 1, desks: {}, layout_version: 1 },
      '/api/office/layout': LAYOUT,
      '/api/office': OFFICE,
    });
    mountScreen(<Office />, '/office');
    await userEvent.click(await screen.findByRole('button', { name: '지금 오피스에 있는 사람 2명' }));
    expect(await screen.findByText('김철수')).toBeInTheDocument();
    expect(screen.queryByText('Avatars by Multiavatar.com')).not.toBeInTheDocument();
    expect(postedTo(fn, '/api/office/presence')[0]).toMatchObject({ viewing: 'room' });
  });

  it('혼자면 접속자 얼굴을 숨긴다', async () => {
    stubApi({
      '/api/office/presence': { people: [{ id: '1', name: '나', seed: 's1', viewing: 'room', me: true }] },
      '/api/office/state': { agents: [agent('ops')], seq: 1, desks: {}, layout_version: 1 },
      '/api/office/layout': LAYOUT,
      '/api/office': OFFICE,
    });
    mountScreen(<Office />, '/office');
    await screen.findByRole('button', { name: 'ops:idle' });
    expect(screen.queryByRole('button', { name: /지금 오피스에 있는 사람/ })).not.toBeInTheDocument();
  });

  it('명단과 3D 이름표용 이름은 직함 > 에이전트 이름(label) > 별칭이다. 명단의 단추 이름도 같다(2026-10-18-017)', async () => {
    stubApi({
      '/api/office/state': {
        agents: [agent('aas-agent-x', 'idle', { label: 'AAS 관리자' }), agent('ops', 'idle', { label: '운영', title: '운영 담당' })],
        seq: 1,
        desks: {},
        layout_version: 1,
      },
      '/api/office/layout': LAYOUT,
      '/api/office/presence': { people: [] },
      '/api/office': OFFICE,
    });
    mountScreen(<Office />, '/office');
    const roster = await screen.findByRole('list', { name: 'AI 에이전트' });
    expect(await within(roster).findByRole('button', { name: 'AAS 관리자 상세' })).toBeInTheDocument();
    expect(within(roster).getByRole('button', { name: '운영 담당 상세' })).toBeInTheDocument();
    expect(within(roster).queryByText('aas-agent-x')).toBeNull();
  });

  it('내 에이전트는 명단 맨 위에 「내 에이전트」로 보이고, 서랍에 주인 이름이 나온다(P6a·G5)', async () => {
    sessionStorage.clear();
    stubApi({
      '/api/office/state': {
        agents: [agent('ops', 'error', { owner_name: '이영희' }), agent('mine', 'idle', { owner_name: '나', mine: true })],
        seq: 1,
        desks: {},
        layout_version: 1,
      },
      '/api/office/layout': LAYOUT,
      '/api/office': OFFICE,
    });
    mountScreen(<Office />, '/office');
    const roster = await screen.findByRole('list', { name: 'AI 에이전트' });
    await waitFor(() => expect(rows(roster)[0]).toHaveTextContent('내 AI 에이전트'));
    expect(rows(roster)[1]).toHaveTextContent('이영희');
    expect(await screen.findByText(/내 AI 에이전트입니다/)).toBeInTheDocument(); // 처음 방문 안내(세션당 한 번)
    expect(screen.getByText('표시 -')).toBeInTheDocument(); // 처음 방문 안내는 사용자가 고른 것이 아니라 표시하지 않는다(2026-10-21-012 D6)
    await openAgentDrawer('ops');
    expect(await screen.findByText('이영희', { selector: 'dd, td, span, div' })).toBeInTheDocument();
  });

  it('명단 행의 대화 단추는 대화 팝업을, 상세 단추는 서랍을 연다(OMAI-1115)', async () => {
    stubApi({
      '/api/office/state': { agents: [agent('ops', 'idle')], seq: 1, desks: {}, layout_version: 1 },
      '/api/office/layout': LAYOUT,
      '/api/office': OFFICE,
    });
    mountScreen(<Office />, '/office');
    const popup = watchChatPopup();
    const roster = await screen.findByRole('list', { name: 'AI 에이전트' });
    await userEvent.click(await within(roster).findByRole('button', { name: 'ops 대화' }));
    expect(popup()).toMatchObject({ kind: 'office', alias: 'ops' });
    await userEvent.click(within(roster).getByRole('button', { name: 'ops 상세' }));
    expect(await screen.findByRole('dialog', { name: 'ops' })).toBeInTheDocument();
  });

  // 지금 고른 에이전트가 아닌 내 에이전트도 채팅 경로로 연다 — 오피스 경로는 머리·첨부가 없다(사용자 보고 2026-10-21)
  it('내 에이전트는 지금 고른 에이전트가 아니어도 그 에이전트의 채팅 대화로 연다', async () => {
    stubApi({
      '/api/office/state': {
        agents: [agent('admin-aas', 'idle', { pod: 'two', profile: 'main', mine: true }), agent('ma', 'idle', { pod: 'one', profile: 'main', mine: true })],
        seq: 1,
        desks: {},
        layout_version: 1,
      },
      '/api/office/layout': LAYOUT,
      '/api/office': OFFICE,
      '/api/me': { auth_enabled: true, admin: false, user: { email: 'lee@x.com' }, pod: { id: 'one' } },
    });
    mountScreen(<Office />, '/office');
    const popup = watchChatPopup();
    const roster = await screen.findByRole('list', { name: 'AI 에이전트' });
    await userEvent.click(await within(roster).findByRole('button', { name: 'admin-aas 대화' }));
    expect(popup()).toEqual({ kind: 'chat', agent: 'main', pod: 'two' });
    expect(chatStore.openAgent).toHaveBeenCalledWith('main', 'two');
  });

  it('상태판에서 상태를 누르면 명단을 그 상태로 거른다', async () => {
    stubApi({
      '/api/office/state': { agents: [agent('ops', 'working'), agent('qa', 'idle')], seq: 1, desks: {}, layout_version: 1 },
      '/api/office/layout': LAYOUT,
      '/api/office': OFFICE,
    });
    mountScreen(<Office />, '/office');
    const roster = await screen.findByRole('list', { name: 'AI 에이전트' });
    await waitFor(() => expect(rows(roster)).toHaveLength(2));
    await userEvent.click(screen.getByRole('button', { name: '일하는 중 1' }));
    expect(rows(roster)).toHaveLength(1);
    expect(rows(roster)[0]).toHaveTextContent('ops');
  });

  it('명단은 화살표로 이동하고 F 로 따라가기를 켠다(키보드 사용자, G8)', async () => {
    stubApi({
      '/api/office/state': { agents: [agent('ops', 'error'), agent('qa', 'idle')], seq: 1, desks: {}, layout_version: 1 },
      '/api/office/layout': LAYOUT,
      '/api/office': OFFICE,
    });
    mountScreen(<Office />, '/office');
    const roster = await screen.findByRole('list', { name: 'AI 에이전트' });
    await waitFor(() => expect(rows(roster)[0]).toHaveTextContent('ops')); // 오류가 맨 위
    rows(roster)[0].focus();
    await userEvent.keyboard('{ArrowDown}');
    expect(rows(roster)[1]).toHaveTextContent('qa');
    expect(rows(roster)[1]).toHaveFocus();
    await userEvent.keyboard('f');
    expect(rows(roster)[1]).toHaveTextContent('따라가기');
  });

  it('명단 행을 누르면 카메라를 옮기고 그 에이전트를 장면에 표시한다(스펙 2026-10-21-012 §3-4)', async () => {
    stubApi({
      '/api/office/state': { agents: [agent('ops', 'error'), agent('qa', 'idle')], seq: 1, desks: {}, layout_version: 1 },
      '/api/office/layout': LAYOUT,
      '/api/office': OFFICE,
    });
    mountScreen(<Office />, '/office');
    const roster = await screen.findByRole('list', { name: 'AI 에이전트' });
    await waitFor(() => expect(rows(roster)).toHaveLength(2));
    expect(screen.getByText('표시 -')).toBeInTheDocument();
    await userEvent.click(rows(roster)[1]);
    expect(screen.getByText('카메라 qa@-')).toBeInTheDocument();
    expect(screen.getByText('표시 qa')).toBeInTheDocument();
  });

  it('자리 탭에서 프로파일을 앉힌다', async () => {
    const fn = mount('/office?tab=seats');
    await userEvent.click(await rowByName(/ qa /)); // 행을 누르면 배치 서랍(OMAI-1127 단계 7)
    await userEvent.type(await screen.findByLabelText('역할'), '검수');
    await userEvent.click(screen.getByRole('button', { name: '저장' }));
    await waitFor(() => expect(postedTo(fn, '/api/office/action')).toHaveLength(1));
    expect(postedTo(fn, '/api/office/action')[0]).toMatchObject({
      action: 'seat.set',
      pod: 'one',
      profile: 'qa',
      alias: 'qa',
      role: '검수',
      enabled: true,
    });
  });

  it('프로파일이 default 뿐인 설치본은 설치본 이름을 오피스 이름 기본값으로 쓴다', async () => {
    // 서버는 오피스 이름 default 를 거절한다. 사용자별 Hermes 는 프로파일이 default 하나라 기본값을 그대로 두면 저장이 실패한다.
    const fn = mount('/office?tab=seats', {
      ...OFFICE,
      seats: [],
      pods: [{ id: 'hag-kim-ab12', owner: 'kim', profiles: [{ name: 'default', seated: false }] }],
    });
    await userEvent.click(await rowByName(/ default /));
    expect(await screen.findByLabelText('오피스에서 쓸 이름')).toHaveValue('hag-kim-ab12');
    await userEvent.click(screen.getByRole('button', { name: '저장' }));
    await waitFor(() => expect(postedTo(fn, '/api/office/action')).toHaveLength(1));
    expect(postedTo(fn, '/api/office/action')[0]).toMatchObject({ pod: 'hag-kim-ab12', profile: 'default', alias: 'hag-kim-ab12' });
  });

  it('서버가 거절한 이유를 서랍에 보인다', async () => {
    const reply = (body: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status }));
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) =>
        url.startsWith('/api/office/action')
          ? reply({ error: '그 이름은 이미 쓰고 있습니다' }, 400)
          : reply(url.startsWith('/api/office/state') ? { agents: [], seq: 0 } : OFFICE)
      )
    );
    mountScreen(<Office />, '/office?tab=seats');
    await userEvent.click(await rowByName(/ qa /)); // 행을 누르면 배치 서랍(OMAI-1127 단계 7)
    await userEvent.click(await screen.findByRole('button', { name: '저장' }));
    expect(await screen.findByText('그 이름은 이미 쓰고 있습니다')).toBeInTheDocument();
  });

  it('일반 구성원도 TFT 방 표에서 그 방의 회의를 연다(계획 2026-10-14-027)', async () => {
    mount('/office?tab=rooms', { ...OFFICE, can_edit: false });
    const link = await screen.findByRole('link', { name: '회의 열기' });
    expect(link).toHaveAttribute('href', '/office?tab=meeting&room=3');
    await userEvent.click(link);
    await waitFor(() => expect(screen.getByTestId('loc')).toHaveTextContent('/office?tab=meeting&room=3'));
  });

  it('「회의 열기」는 별도 열이 아니라 방 이름 옆 뱃지로 나온다(OMAI-1186)', async () => {
    mount('/office?tab=rooms', { ...OFFICE, can_edit: false });
    const link = await screen.findByRole('link', { name: '회의 열기' });
    const title = screen.getAllByText('장애 대응').find((el) => el.hasAttribute('data-row-title'));
    expect(title).toBeTruthy();
    // 이름과 뱃지가 같은 칸(이름 칸) 안에 있다
    const cell = title!.closest('[role="gridcell"], td, [role="cell"]') ?? title!.parentElement!.parentElement!.parentElement!;
    expect(cell.contains(link)).toBe(true);
    expect(screen.queryByRole('columnheader', { name: '회의' })).toBeNull();
  });

  it('관리자가 표의 「회의 열기」 링크를 눌러도 방 편집 서랍은 열리지 않는다', async () => {
    mount('/office?tab=rooms');
    await userEvent.click(await screen.findByRole('link', { name: '회의 열기' }));
    await waitFor(() => expect(screen.getByTestId('loc')).toHaveTextContent('/office?tab=meeting&room=3'));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('끝난 방의 행에는 「회의 열기」 링크가 없다', async () => {
    mount('/office?tab=rooms', { ...OFFICE, rooms: [{ ...OFFICE.rooms[0], status: 'closed' }] });
    expect(await screen.findByText('장애 대응')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: '회의 열기' })).toBeNull();
  });

  it('방 서랍의 「회의 열기」 단추는 서랍을 닫고 그 방의 회의로 간다', async () => {
    mount('/office?tab=rooms');
    await userEvent.click(await rowByName(/장애 대응/));
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: '회의 열기' }));
    await waitFor(() => expect(screen.getByTestId('loc')).toHaveTextContent('/office?tab=meeting&room=3'));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('끝난 방의 서랍에는 「회의 열기」 단추가 없다', async () => {
    mount('/office?tab=rooms', { ...OFFICE, rooms: [{ ...OFFICE.rooms[0], status: 'closed' }] });
    await userEvent.click(await rowByName(/장애 대응/));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).queryByRole('button', { name: '회의 열기' })).toBeNull();
    expect(within(dialog).getByRole('button', { name: /지우기|삭제/ })).toBeInTheDocument();
  });

  it('TFT 방 탭에서 새 방을 만든다', async () => {
    const fn = mount('/office?tab=rooms');
    expect(await screen.findByText('장애 대응')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: '새 TFT 방' }));
    await userEvent.type(await screen.findByLabelText('방 이름'), '릴리즈 점검');
    await userEvent.type(screen.getByLabelText(/무엇을 끝내려고 모였나요/), '릴리즈 전 점검을 끝낸다');
    await userEvent.click(screen.getByRole('button', { name: /다른 사람의 AI 에이전트 1개 보기/ })); // 구성원이 아닌 사람(kim)의 자리는 접혀 있다
    await userEvent.click(screen.getByRole('checkbox', { name: /ops/ }));
    await userEvent.click(screen.getByRole('button', { name: '저장' }));
    await waitFor(() => expect(postedTo(fn, '/api/office/action')).toHaveLength(1));
    expect(postedTo(fn, '/api/office/action')[0]).toMatchObject({
      action: 'room.set',
      id: 0,
      name: '릴리즈 점검',
      purpose: '### 목표\n릴리즈 전 점검을 끝낸다',
      seats: ['ops'],
      status: 'open',
    });
  }, 15000); // 자동완성 칸에 글자를 많이 쳐 전체 실행의 부하에서 5초를 넘긴다

  it('편집 권한이 없으면 고치기 버튼을 숨긴다', async () => {
    mount('/office?tab=rooms', { ...OFFICE, can_edit: false });
    expect(await screen.findByText('장애 대응')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '새 TFT 방' })).toBeNull();
    // 편집 권한이 없으면 행을 눌러도 서랍이 없다. 행에는 「회의 열기」 링크가 있으므로 aria-disabled 를 달지 않는다(링크가 사용 불가로 읽히지 않게)
    expect(screen.getByRole('row', { name: /^장애 대응/ })).not.toHaveAttribute('aria-disabled');
    expect(screen.getByRole('link', { name: '회의 열기' })).toBeEnabled();
  });

  it('자리 탭은 모든 에이전트의 프로파일을 한 표에 두고 에이전트·소유자 열을 보이고 표 위에 따로 요약을 두지 않는다(OMAI-1127 단계 7)', async () => {
    mount('/office?tab=seats');
    const row = await rowByName(/ qa /);
    expect(within(row).getByText('one')).toBeInTheDocument(); // 에이전트(POD) 칸
    expect(screen.getByRole('columnheader', { name: /에이전트/ })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: /소유자/ })).toBeInTheDocument();
    expect(screen.queryByText(/프로파일 \d+개/)).toBeNull();
    // 열 순서: 소유자 → 에이전트 → 프로파일 → 오피스 이름 → 역할 · 팀 → 상태
    const heads = screen.getAllByRole('columnheader').map((h) => h.textContent ?? '');
    const at = (re: RegExp) => heads.findIndex((h) => re.test(h));
    const order = [/소유자/, /에이전트/, /프로파일/, /오피스 이름/, /역할/, /상태/].map(at);
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it('관리자는 방 표에서 구성원 수를 보고, 구성원은 사용자 목록에서 골라 저장한다(2026-10-18: 「사람」 칸 없음)', async () => {
    const data = { ...OFFICE, rooms: [{ ...OFFICE.rooms[0], members: ['lee@x.com', 'park@x.com'] }] };
    const fn = mount('/office?tab=rooms', data);
    expect(await screen.findByRole('columnheader', { name: /구성원/ })).toBeInTheDocument();
    expect(screen.getByText('2명')).toBeInTheDocument();
    await userEvent.click(await rowByName(/^장애 대응/)); // 행을 누르면 방 서랍
    expect(await screen.findByRole('button', { name: '이영희' })).toBeInTheDocument(); // 구성원은 이름 칩
    expect(screen.getByRole('button', { name: '박민수' })).toBeInTheDocument();
    expect(screen.queryByLabelText('사람')).not.toBeInTheDocument();
    const box = screen.getByLabelText('구성원');
    await userEvent.type(box, '최');
    await userEvent.click(await screen.findByRole('option', { name: /최지원/ }));
    await userEvent.type(box, 'kim@x.com{Enter}'); // 목록에 없는 이메일은 적고 Enter
    await userEvent.click(screen.getByRole('button', { name: '저장' }));
    await waitFor(() => expect(postedTo(fn, '/api/office/action')).toHaveLength(1));
    const sent = postedTo(fn, '/api/office/action')[0];
    expect(sent).toMatchObject({ action: 'room.set', id: 3, owner: 'kim', members: ['lee@x.com', 'park@x.com', 'choi@x.com', 'kim@x.com'] });
    expect(sent).not.toHaveProperty('people'); // 사람은 서버가 구성원으로 만든다
  }, 15000); // 자동완성 칸에 글자를 많이 쳐 전체 실행의 부하에서 5초를 넘긴다

  it('새 방은 만드는 사람이 담당·구성원이고, 담당은 구성원 칩에서 지우지 못한다', async () => {
    const fn = stubApi({
      '/api/me': { auth_enabled: true, admin: true, user: { email: 'choi@x.com', name: '최지원' } },
      '/api/office/action': { ok: true },
      '/api/office/state': { agents: [agent('ops')], seq: 1, desks: { office_0: 'ops' }, layout_version: 1 },
      '/api/office/layout': LAYOUT,
      '/api/office/presence': { people: [] },
      '/api/users': { users: [{ email: 'choi@x.com', name: '최지원' }, { email: 'lee@x.com', name: '이영희' }] },
      '/api/office': OFFICE,
    });
    mountScreen(<Office />, '/office?tab=rooms');
    await userEvent.click(await screen.findByRole('button', { name: '새 TFT 방' }));
    await waitFor(() => expect((screen.getByLabelText('담당') as HTMLInputElement).value).toBe('최지원')); // 담당 칸은 이름, 보내는 값은 이메일(2026-10-20)
    const chip = (await screen.findByText('최지원', { selector: '.MuiChip-label' })).closest('.MuiChip-root') as HTMLElement;
    expect(chip.querySelector('.MuiChip-deleteIcon')).toBeNull(); // 담당 칩에는 지우기 단추가 없다
    await userEvent.type(screen.getByLabelText('방 이름'), '새 방');
    await userEvent.type(screen.getByLabelText(/무엇을 끝내려고 모였나요/), '확정');
    await userEvent.click(screen.getByRole('button', { name: '저장' }));
    await waitFor(() => expect(postedTo(fn, '/api/office/action')).toHaveLength(1));
    expect(postedTo(fn, '/api/office/action')[0]).toMatchObject({ action: 'room.set', name: '새 방', owner: 'choi@x.com', members: ['choi@x.com'] });
  }, 15000); // 자동완성 칸에 글자를 많이 쳐 전체 실행의 부하에서 5초를 넘긴다

  it('일반 사용자는 구성원 열도 편집 버튼도 보지 못하고, 방이 없으면 요청 방법을 안내받는다', async () => {
    mount('/office?tab=rooms', { ...OFFICE, can_edit: false, can_act: true, rooms: [] });
    expect(await screen.findByText(/관리자에게 구성원으로 넣어 달라고 요청하세요/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '새 TFT 방' })).toBeNull();
  });
});

describe('Office: 회의실 빔 스크린을 누르면 회의실 채팅 창을 연다(OMAI-1257)', () => {
  const ROOM_ITEMS = [
    { _uid: 'kr_room_a', type: 'room', kind: 'tft', label: 'TFT 회의실 1', x: 0, y: 0, w: 300, h: 200 },
    { _uid: 'kr_scr_a', type: 'tv_meeting', x: 100, y: 10, w: 150, h: 6 },
    { _uid: 'kr_room_b', type: 'room', kind: 'tft', label: 'TFT 회의실 2', x: 400, y: 0, w: 300, h: 200 },
    { _uid: 'kr_scr_b', type: 'tv_meeting', x: 500, y: 10, w: 150, h: 6 },
  ];
  const mountRooms = (canEdit = true) => {
    stubApi({
      '/api/office/state': {
        agents: [agent('ops')],
        seq: 1,
        desks: {},
        layout_version: 1,
        rooms: [
          { uid: 'kr_room_a', kind: 'tft', label: '제안 TFT', room: 3 },
          { uid: 'kr_room_b', kind: 'tft', label: 'TFT 회의실 2' },
        ],
      },
      '/api/office/layout': { version: 1, items: ROOM_ITEMS, desks: {} },
      '/api/office': { ...OFFICE, can_edit: canEdit },
    });
    mountScreen(<Office />, '/office');
  };
  afterEach(() => closeRoomChat());

  it('서버 방과 짝이 있으면 그 방 번호·이름·보내기 권한으로 연다', async () => {
    mountRooms();
    await userEvent.click(await screen.findByRole('button', { name: '스크린 kr_scr_a' }));
    expect(roomChatPopupState().target).toEqual({ room: 3, name: '제안 TFT', canAct: true });
  });

  it('회의실 명패를 눌러도 같은 회의실 채팅 창을 연다', async () => {
    mountRooms();
    await userEvent.click(await screen.findByRole('button', { name: '명패 kr_room_a' }));
    expect(roomChatPopupState().target).toEqual({ room: 3, name: '제안 TFT', canAct: true });
  });

  it('열린 회의가 짝지어진 방만 장면에 회의 중으로 알린다', async () => {
    stubApi({
      '/api/office/state': {
        agents: [agent('ops')],
        seq: 1,
        desks: {},
        layout_version: 1,
        rooms: [
          { uid: 'kr_room_a', kind: 'tft', label: '제안 TFT', room: 3 },
          { uid: 'kr_room_b', kind: 'tft', label: 'TFT 회의실 2' },
        ],
      },
      '/api/office/layout': { version: 1, items: ROOM_ITEMS, desks: {} },
      '/api/office/meeting/active': { meetings: [{ room: 3, seats: ['ops'], pending: [], speaker: null, at: 1 }] },
      '/api/office': { ...OFFICE, can_edit: true },
    });
    mountScreen(<Office />, '/office');
    expect(await screen.findByText('회의 중인 방 kr_room_a')).toBeInTheDocument();
  });

  it('짝이 없는 방은 방 번호 없이(안내 상태) 3D 방 이름으로 연다', async () => {
    mountRooms(false);
    await userEvent.click(await screen.findByRole('button', { name: '스크린 kr_scr_b' }));
    expect(roomChatPopupState().target).toEqual({ room: null, name: 'TFT 회의실 2', canAct: false });
  });
});

// 스펙 2026-10-20-017: 큰 팀 회의는 대회의실로 모이고, 명패 둘째 줄·누르면 여는 창이 그 회의를 가리킨다(디자인 리뷰 이슈 1~4, R7)
describe('Office: 대회의실 명패와 회의 채팅 창(스펙 2026-10-20-017)', () => {
  // 팀 회의실에는 의자가 없어(0개) 에이전트가 하나만 있어도 팀 회의는 대회의실로 간다
  const ITEMS = [
    { _uid: 'kr_team_1', type: 'room', kind: 'team', label: '팀 회의실 1', x: 0, y: 0, w: 240, h: 200 },
    { _uid: 'kr_big', type: 'room', kind: 'meeting', label: '대회의실', x: 400, y: 0, w: 360, h: 200 },
  ];
  const ROOMS = [{ uid: 'kr_team_1', kind: 'team', label: '마케팅팀 회의실', name: '마케팅팀', room: 5 }];
  const mountWith = (meetings: object[]) => {
    stubApi({
      '/api/office/state': { agents: [agent('ops')], seq: 1, desks: {}, layout_version: 1, rooms: ROOMS },
      '/api/office/layout': { version: 1, items: ITEMS, desks: {} },
      '/api/office/meeting/active': { meetings },
      '/api/office': { ...OFFICE, can_edit: true },
    });
    mountScreen(<Office />, '/office');
  };
  afterEach(() => closeRoomChat());

  it('대회의실로 옮겨 간 팀 회의: 명패 둘째 줄이 팀을 가리키고, 대회의실을 누르면 그 팀 회의를 팀 회의실 이름으로 연다', async () => {
    mountWith([{ room: 5, seats: ['ops'], pending: [], speaker: null, at: 1, since: 1 }]);
    expect(await screen.findByText('명패 글 kr_big=마케팅팀 회의 중,kr_team_1=→ 대회의실에서 회의 중(옮겨 감)')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: '명패 kr_big' }));
    expect(roomChatPopupState().target).toEqual({ room: 5, name: '마케팅팀 회의실', canAct: true });
  });

  it('대회의실을 둘이 같이 쓰면 「회의 2건」이고, 누르면 내가 구성원인(name 이 있는) 회의를 먼저 연다', async () => {
    mountWith([
      { room: 5, seats: ['ops'], pending: [], speaker: null, at: 1, since: 1 },
      { room: 9, name: '긴급 TFT', seats: ['ops'], pending: [], speaker: null, at: 2, since: 2 },
    ]);
    expect(await screen.findByText(/kr_big=회의 2건/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: '명패 kr_big' }));
    expect(roomChatPopupState().target).toEqual({ room: 9, name: '긴급 TFT', canAct: true });
  });

  it('빈 대회의실을 누르면 TFT 방 안내 대신 대회의실 안내로 연다', async () => {
    mountWith([]);
    await userEvent.click(await screen.findByRole('button', { name: '명패 kr_big' }));
    expect(roomChatPopupState().target).toEqual({
      room: null,
      name: '대회의실',
      canAct: true,
      emptyNote: '지금 대회의실에서 열린 회의가 없습니다. 팀 회의실 의자보다 AI 에이전트가 많은 팀의 회의는 여기서 열립니다.',
    });
  });
});

// TFT 방 표: 행마다 「고치기」 단추(행을 눌러도 된다). 만들 때의 서랍을 지금 값으로 연다(스펙 2026-10-18-007)
describe('Office TFT 방 고치기', () => {
  it('관리자는 행의 「고치기」 단추로 그 방의 서랍을 지금 값으로 연다', async () => {
    mount('/office?tab=rooms');
    const btn = await screen.findByRole('button', { name: '장애 대응 고치기' });
    await userEvent.click(btn);
    expect(await screen.findByLabelText(/방 이름/)).toHaveValue('장애 대응');
  });

  it('관리자가 아니고 그 방의 담당·구성원도 아니면 「고치기」 단추가 없다', async () => {
    mount('/office?tab=rooms', { ...OFFICE, can_edit: false });
    expect(await screen.findByRole('link', { name: '회의 열기' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /고치기$/ })).not.toBeInTheDocument();
  });

  it('담당·구성원은 자기 방의 「고치기」로 서랍을 연다(2026-10-18-009)', async () => {
    mount('/office?tab=rooms', { ...OFFICE, can_edit: false, rooms: [{ ...OFFICE.rooms[0], my_role: 'member' }] });
    await userEvent.click(await screen.findByRole('button', { name: '장애 대응 고치기' }));
    expect(await screen.findByText('구성원은 방 이름과 목적만 고칠 수 있습니다')).toBeInTheDocument();
  });
});

// 배치·TFT 방 표는 자리 별칭·설치본 id(aas-agent-…) 대신 에이전트 이름을 보인다(스펙 2026-10-18-010)
describe('Office 표: 에이전트 이름', () => {
  const NAMED = {
    ...OFFICE,
    seats: [seat('aas-agent-one', { label: 'AAS 관리자' })],
    rooms: [{ id: 3, name: '장애 대응', purpose: '결제 지연', owner: 'kim', seats: ['aas-agent-one'], people: [], status: 'open' }],
    pods: [{ id: 'one', owner: 'kim', name: 'AAS 관리자', profiles: [{ name: 'aas-agent-one', seated: true }] }],
  };

  it('배치 표의 「에이전트」 열은 에이전트 이름이고, 설치본 id 는 풍선말에만 있다', async () => {
    mount('/office?tab=seats', NAMED);
    const chips = await screen.findAllByText('AAS 관리자', { selector: '[data-agent-chip] span' });
    expect(chips.length).toBeGreaterThan(0);
    expect(chips[0].closest('[data-agent-chip]')).toHaveAttribute('title', 'one');
    expect(screen.queryByText('one', { selector: '[data-agent-chip] span' })).not.toBeInTheDocument();
  });

  it('TFT 방 표의 에이전트 칩도 에이전트 이름이다', async () => {
    mount('/office?tab=rooms', NAMED);
    const chip = await screen.findByText('AAS 관리자', { selector: '[data-agent-chip] span' });
    expect(chip.closest('[data-agent-chip]')).toHaveAttribute('title', 'aas-agent-one');
    expect(screen.queryByText('aas-agent-one', { selector: '[data-agent-chip] span' })).not.toBeInTheDocument();
  });

  it('이름을 주지 않으면 예전처럼 id·별칭을 보인다', async () => {
    mount('/office?tab=rooms');
    expect(await screen.findByText('ops', { selector: '[data-agent-chip] span' })).toBeInTheDocument();
  });
});

// 스펙 2026-10-20-021: 상태판 「회의실」 탭 — 행은 카메라(장면 자리가 있는 방), 말풍선은 회의실 채팅 창
describe('Office: 상태판 회의실 탭(스펙 2026-10-20-021)', () => {
  const ITEMS = [
    { _uid: 'kr_team_1', type: 'room', kind: 'team', label: '팀 회의실 1', x: 0, y: 0, w: 240, h: 200 },
    { _uid: 'kr_big', type: 'room', kind: 'meeting', label: '대회의실', x: 400, y: 0, w: 360, h: 200 },
  ];
  const LABELS = [{ uid: 'kr_team_1', kind: 'team', label: '마케팅팀 회의실', name: '마케팅팀', room: 5 }];
  const TEAM = { id: 5, name: '마케팅팀', kind: 'team', purpose: '', owner: '', seats: ['ops'], people: [], status: 'open' };
  const DATA = { ...OFFICE, rooms: [TEAM, ...OFFICE.rooms] };
  const mountWith = (extra: Record<string, unknown> = {}) => {
    const fn = stubApi({
      '/api/office/action': { ok: true, id: 11 },
      '/api/office/state': { agents: [agent('ops')], seq: 1, desks: {}, layout_version: 1, rooms: LABELS },
      '/api/office/layout': { version: 1, items: ITEMS, desks: {} },
      '/api/office/meeting/active': { meetings: [] },
      '/api/office/presence': { people: [] },
      '/api/users': { users: [{ email: 'lee@x.com', name: '이영희' }] },
      '/api/office': DATA,
      ...extra,
    });
    mountScreen(<Office />, '/office');
    return fn;
  };
  const officeCalls = (fn: ReturnType<typeof stubApi>) => fn.mock.calls.filter((c) => String(c[0]) === '/api/office').length;
  const openRoomsTab = async () => userEvent.click(await screen.findByRole('tab', { name: /^회의실 2/ }));
  afterEach(() => closeRoomChat());

  it('팀 방 행은 따라가기를 끄고 카메라를 그 회의실 가운데로 옮긴다(R12·N6)', async () => {
    mountWith();
    await userEvent.click(await screen.findByRole('button', { name: 'ops:idle' }));   // 몸통을 누르면 따라가기가 켜진다
    expect(screen.getByText('따라가기 ops')).toBeInTheDocument();
    await openRoomsTab();
    await userEvent.click(screen.getByRole('button', { name: '마케팅팀 · 팀 회의 위치 보기' }));
    expect(screen.getByText('카메라 room:5@120,100')).toBeInTheDocument();
    expect(screen.getByText('표시 kr_team_1')).toBeInTheDocument(); // 고른 회의실을 장면에 표시한다(스펙 2026-10-21-012 §3-4)
    expect(screen.getByText('따라가기 -')).toBeInTheDocument();
  });

  it('팀 방 말풍선은 명패와 같은 제목으로 창을 열고 알린다. 자리 없는 방의 행은 창을 연다(R1·DR5·DR18)', async () => {
    mountWith();
    await openRoomsTab();
    await userEvent.click(screen.getByRole('button', { name: '마케팅팀 · 팀 회의 채팅 열기' }));
    expect(roomChatPopupState().target).toEqual({ room: 5, name: '마케팅팀 회의실', canAct: true });
    expect(screen.getByTestId('room-chat-announce')).toHaveTextContent('마케팅팀 회의실 채팅을 열었습니다');
    closeRoomChat();
    await userEvent.click(screen.getByRole('button', { name: '명패 kr_team_1' }));
    expect(roomChatPopupState().target?.name).toBe('마케팅팀 회의실');                       // 장면 경로와 같은 제목
    await userEvent.click(screen.getByRole('button', { name: '장애 대응 채팅 열기' }));       // 짝 회의실이 없는 TFT 방(3)
    expect(roomChatPopupState().target).toEqual({ room: 3, name: '장애 대응', canAct: true });
  });

  it('상태판 말풍선은 에이전트 창 뒤에 있던 회의실 창을 앞으로 올린다(N5)', async () => {
    mountWith();
    await openRoomsTab();
    raisePopup('aas.chatPopup.rect');
    await userEvent.click(screen.getByRole('button', { name: '마케팅팀 · 팀 회의 채팅 열기' }));
    expect(popupStanding('aas.roomChatPopup.rect')).toBe('front');
  });

  it('회의실 탭을 고르면 방 목록을 다시 읽고, 실패하면 알린다(R9·N7)', async () => {
    let n = 0;
    const fn = mountWith({ '/api/office': () => (++n === 1 ? DATA : new Response(JSON.stringify({ error: 'x' }), { status: 500 })) });
    await screen.findByRole('tab', { name: /^회의실 2/ });
    const before = officeCalls(fn);
    await openRoomsTab();
    await waitFor(() => expect(officeCalls(fn)).toBe(before + 1));
    expect(await screen.findByText('회의실 목록을 새로 읽지 못했습니다')).toBeInTheDocument();
  });

  it('회의 목록을 읽지 못하면 알린다(DR6)', async () => {
    mountWith({ '/api/office/meeting/active': new Response(JSON.stringify({ error: 'x' }), { status: 500 }) });
    await openRoomsTab();
    expect(await screen.findByText('회의 상태를 읽지 못했습니다')).toBeInTheDocument();
  });

  it('관리자가 상태판에서 새 TFT 방을 저장하면 그 방의 회의 창을 연다(R13·R14)', async () => {
    let saved = false;
    const created = { id: 11, name: '릴리즈 점검', purpose: '', owner: '', seats: ['ops'], people: [], status: 'open' };
    mountWith({
      '/api/office/action': () => {
        saved = true;
        return { ok: true, id: 11 };
      },
      '/api/office': () => (saved ? { ...DATA, rooms: [...DATA.rooms, created] } : DATA),
    });
    await openRoomsTab();
    await userEvent.click(screen.getByRole('button', { name: '새 TFT 방' }));
    await userEvent.type(await screen.findByLabelText('방 이름'), '릴리즈 점검');
    await userEvent.type(screen.getByLabelText(/무엇을 끝내려고 모였나요/), '점검');
    await userEvent.click(screen.getByRole('button', { name: /다른 사람의 AI 에이전트 1개 보기/ }));
    await userEvent.click(screen.getByRole('checkbox', { name: /ops/ }));
    await userEvent.click(screen.getByRole('button', { name: '저장' }));
    await waitFor(() => expect(roomChatPopupState().target).toEqual({ room: 11, name: '릴리즈 점검', canAct: true }));
  }, 15000);
});

describe('Office: 관리자의 「볼 부서」(스펙 2026-10-22-002)', () => {
  const ADMIN_ME = { auth_enabled: true, admin: true, user: { email: 'boss@x.com' }, department: '플랫폼' };
  const DEPT_OFFICE = {
    ...OFFICE,
    seats: [seat('ops', { team: '플랫폼' }), seat('qa', { team: '영업' }), seat('dev', { team: '영업' })],
    // dev 는 영업 자리지만 플랫폼 사람이 구성원인 TFT 방에 앉아 있다(D3a)
    rooms: [{ id: 3, name: '장애 대응', purpose: '', owner: 'kim', seats: ['dev'], people: [], members: ['p@x.com'], teams: ['플랫폼'], status: 'open', kind: 'tft' }],
    departments: ['플랫폼', '영업'],
  };
  const deptStub = (me: unknown) =>
    stubApi({
      '/api/office/state': {
        agents: [agent('ops', 'idle', { team: '플랫폼' }), agent('qa', 'idle', { team: '영업' }), agent('dev', 'idle', { team: '영업' })],
        seq: 1,
        desks: {},
        layout_version: 1,
      },
      '/api/office/layout': LAYOUT,
      '/api/office/presence': { people: [] },
      '/api/office': DEPT_OFFICE,
      '/api/me': me,
    });
  const shown = async () => {
    const roster = await screen.findByRole('list', { name: 'AI 에이전트' });
    return ['ops', 'qa', 'dev'].filter((a) => within(roster).queryByRole('button', { name: `${a} 상세` }));
  };
  const pick = async (name: string) => {
    // 상세 서랍이 열려 있으면 배경이 접근성 트리에서 숨겨진다(hidden) — 서랍은 오른쪽에 떠 있어 콤보박스는 그대로 누를 수 있다
    await userEvent.click(screen.getByRole('combobox', { name: '볼 부서', hidden: true }));
    await userEvent.click(await screen.findByRole('option', { name }));
  };
  afterEach(() => localStorage.removeItem('aas.office.adminDepartment'));

  it('관리자는 내 부서로 시작하고, 부서를 고르면 그 부서와 그 부서 TFT 방 에이전트만 남는다(A7, D1·D3a)', async () => {
    deptStub(ADMIN_ME);
    mountScreen(<Office />, '/office');
    await waitFor(async () => expect(await shown()).toEqual(['ops', 'dev']));
    await pick('영업');
    await waitFor(async () => expect(await shown()).toEqual(['qa', 'dev']));
    expect(localStorage.getItem('aas.office.adminDepartment')).toBe('영업'); // 이 브라우저에 기억한다(D4)
    await pick('전체');
    await waitFor(async () => expect(await shown()).toEqual(['ops', 'qa', 'dev']));
  });

  it('다른 사람이 부서를 바꿔 변경 번호가 오르면 다시 읽고, 다시 읽은 뒤에도 「볼 부서」·「배치 편집」·현수막이 그대로다(스펙 2026-10-26-001 회귀 계약 2, T10)', async () => {
    const random = vi.spyOn(Math, 'random').mockReturnValue(0);         // 다시 읽기 분산을 0 으로 — 묶기 500ms 뒤 바로 읽는다
    let depts = ['플랫폼', '영업'];
    const fn = stubApi({
      '/api/office/state': { agents: [agent('ops', 'idle', { team: '플랫폼' })], seq: 1, desks: {}, layout_version: 1 },
      '/api/office/layout': LAYOUT,
      '/api/office/presence': { people: [] },
      '/api/office': () => ({ ...DEPT_OFFICE, departments: depts, banners: [{ team: '플랫폼', goal: '목표' }], mine: '플랫폼' }),
      '/api/me': ADMIN_ME,
    });
    mountScreen(<Office />, '/office');
    expect(await screen.findByRole('button', { name: '배치 편집' })).toBeInTheDocument();
    await waitFor(() => expect(changed.push).not.toBeNull());
    const reads = () => fn.mock.calls.filter(([u]) => String(u).split('?')[0] === '/api/office').length;
    const before = reads();
    depts = ['플랫폼', '영업', '마케팅'];
    act(() => changed.push?.({ n: 1, admin: 0 }));                      // 처음 값 — 읽지 않는다
    act(() => changed.push?.({ n: 1, admin: 1 }));                      // 부서는 관리자 전용 번호
    await waitFor(() => expect(reads()).toBe(before + 1), { timeout: 3000 });
    await userEvent.click(screen.getByRole('combobox', { name: '볼 부서', hidden: true }));
    expect(await screen.findByRole('option', { name: '마케팅' })).toBeInTheDocument();
    await userEvent.keyboard('{Escape}');
    expect(screen.getByRole('button', { name: '배치 편집' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /현수막/ })).toBeInTheDocument();
    random.mockRestore();
  });

  it('일반 사용자와 다른 탭에는 콤보박스가 없다(A7)', async () => {
    deptStub({ ...ADMIN_ME, admin: false });
    mountScreen(<Office />, '/office');
    await screen.findByRole('list', { name: 'AI 에이전트' });
    expect(screen.queryByRole('combobox', { name: '볼 부서' })).not.toBeInTheDocument();
  });

  it('부서를 바꿔 숨겨진 에이전트의 상세 서랍은 닫히고 따라가기는 풀린다(A7, 리뷰 R1·R4)', async () => {
    deptStub(ADMIN_ME);
    mountScreen(<Office />, '/office');
    await waitFor(async () => expect(await shown()).toEqual(['ops', 'dev']));
    await userEvent.click(await screen.findByRole('button', { name: 'ops:idle' }));
    expect(await screen.findByRole('button', { name: '따라가기 끄기' })).toHaveAttribute('aria-pressed', 'true');
    const roster = await screen.findByRole('list', { name: 'AI 에이전트' });
    await userEvent.click(within(roster).getByRole('button', { name: 'ops 상세' }));
    expect(await screen.findByRole('dialog', { name: 'ops' })).toBeInTheDocument();
    await pick('영업');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'ops' })).not.toBeInTheDocument());
    expect(screen.queryByRole('button', { name: '따라가기 끄기' })).not.toBeInTheDocument();
  });

  it('부서를 바꿔 숨겨진 에이전트의 서랍은 주소의 open 도 함께 지운다(스펙 2026-10-28-014 §4-4)', async () => {
    deptStub(ADMIN_ME);
    mountScreen(<Office />, '/office');
    await waitFor(async () => expect(await shown()).toEqual(['ops', 'dev']));
    const roster = await screen.findByRole('list', { name: 'AI 에이전트' });
    await userEvent.click(within(roster).getByRole('button', { name: 'ops 상세' }));
    expect(await screen.findByRole('dialog', { name: 'ops' })).toBeInTheDocument();
    expect(screen.getByTestId('loc')).toHaveTextContent(/^\/office\?open=ops$/);
    await pick('영업');
    await waitFor(() => expect(screen.getByTestId('loc')).toHaveTextContent(/^\/office$/));
    expect(screen.queryByRole('dialog', { name: 'ops' })).toBeNull();
  });
});

// 스펙 2026-10-28-014 §4-4: 명단·말풍선의 「상세」 로 연 에이전트 서랍을 주소 open=<별칭> 과 묶는다(pod 는 쓰지 않는다)
describe('Office: 에이전트 서랍 주소(open)', () => {
  const stub = () =>
    stubApi({
      '/api/office/state': { agents: [agent('ops')], seq: 1, desks: { office_0: 'ops' }, layout_version: 1 },
      '/api/office/layout': LAYOUT,
      '/api/office/presence': { people: [] },
      '/api/office': OFFICE,
    });
  const mountWithBack = (initial: string) =>
    mountScreen(
      <>
        <Office />
        <HistoryBack />
      </>,
      initial
    );
  const detail = async (alias = 'ops') => {
    const roster = await screen.findByRole('list', { name: 'AI 에이전트' });
    await userEvent.click(await within(roster).findByRole('button', { name: `${alias} 상세` }));
  };

  it('「상세」 를 누르면 주소에 open 이 생기고, 닫기·뒤로 가기로 서랍이 닫히며 값이 지워진다(D9)', async () => {
    stub();
    mountWithBack('/office');
    await detail();
    expect(await screen.findByRole('dialog', { name: 'ops' })).toBeInTheDocument();
    expect(screen.getByTestId('loc')).toHaveTextContent(/^\/office\?open=ops$/);
    // 닫기: 화면 안에서 쌓은 칸이므로 되감는다
    await userEvent.click(within(screen.getByRole('dialog', { name: 'ops' })).getByRole('button', { name: '닫기' }));
    await waitFor(() => expect(screen.getByTestId('loc')).toHaveTextContent(/^\/office$/));
    expect(screen.queryByRole('dialog', { name: 'ops' })).toBeNull();
    // 뒤로 가기
    await detail();
    expect(await screen.findByRole('dialog', { name: 'ops' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '뒤로 가기', hidden: true }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'ops' })).toBeNull());
    expect(screen.getByTestId('loc')).toHaveTextContent(/^\/office$/);
  });

  it('#/office?open=<별칭> 으로 들어오면 그 에이전트 서랍을 열고, 닫으면 값만 지운다(링크 진입은 replace)', async () => {
    stub();
    mountScreen(<Office />, '/office?open=ops');
    const dlg = await screen.findByRole('dialog', { name: 'ops' });
    expect(within(dlg).getByText('대기')).toBeInTheDocument();
    await userEvent.click(within(dlg).getByRole('button', { name: '닫기' }));
    await waitFor(() => expect(screen.getByTestId('loc')).toHaveTextContent(/^\/office$/));
    expect(screen.queryByRole('dialog', { name: 'ops' })).toBeNull();
  });

  it('주소로 연 서랍도 웹소켓으로 바뀐 상태를 제자리에서 따라간다', async () => {
    stub();
    mountScreen(<Office />, '/office?open=ops');
    expect(within(await screen.findByRole('dialog', { name: 'ops' })).getByText('대기')).toBeInTheDocument();
    act(() => FakeES.all[0].emit('chat.start', { alias: 'ops' }, '2'));
    expect(await within(screen.getByRole('dialog', { name: 'ops' })).findByText('일하는 중')).toBeInTheDocument();
  });

  it('오피스에 없는 별칭의 링크는 서랍을 열지 않고 알린 뒤 값을 지운다', async () => {
    stub();
    mountScreen(<Office />, '/office?open=ghost');
    expect(await screen.findByText(/링크의 AI 에이전트 ghost 이\(가\) 이 오피스에 없어/)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId('loc')).toHaveTextContent(/^\/office$/));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('기존 TFT 방 탭 링크는 그대로 그 탭을 연다(회귀 계약 — 회의 탭 room·past 링크는 MeetingThreads.test.tsx)', async () => {
    stub();
    mountScreen(<Office />, '/office?tab=rooms');
    expect(await screen.findByText('장애 대응')).toBeInTheDocument();
    expect(screen.getByTestId('loc')).toHaveTextContent(/^\/office\?tab=rooms$/);
  });

  it('탭을 바꾸면 open 이 지워지고 서랍이 닫힌다', async () => {
    stub();
    mountScreen(<Office />, '/office?open=ops');
    expect(await screen.findByRole('dialog', { name: 'ops' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: 'TFT 방 1', hidden: true }));
    await waitFor(() => expect(screen.getByTestId('loc')).toHaveTextContent(/^\/office\?tab=rooms$/));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'ops' })).toBeNull());
  });
});

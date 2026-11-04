/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ReactElement } from 'react';
import { useNavigate } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { readAloud, resetReadAloud } from '@/components/chat/readAloudPlayer';
import { resetVoice } from '@/components/chat/VoiceInput';
import { LinkPodSwitch } from '@/components/LinkPodSwitch';
import { ChatStore } from '@/lib/chatStore';
import { chatTokens } from '@/lib/chatTokens';
import type { Me } from '@/lib/data';
import { FakeES } from '@/test/fakeEventSource';
import { FakeMedia, installFakeMedia, uninstallFakeMedia } from '@/test/fakeMedia';
import { mountScreen, postedTo, stubApi } from '@/test/mountScreen';

import { Chat } from './Chat';

const STATUS = (over = {}) => ({
  configured: true,
  agents: [
    {
      name: 'ma',
      title: '마케팅',
      description: '마케팅 담당',
      running: true,
      channels: ['telegram'],
      last_activity: '2026-10-10T08:00:00+09:00',
    },
    { name: 'ops', title: '', description: '운영', running: false, failed_jobs: 2 },
    { name: 'zed', title: 'Zed', description: '' },
  ],
  sessions: [],
  ...over,
});
const HISTORY = {
  sessions: [
    {
      id: 'h1',
      source: 'telegram',
      title: '텔레그램 대화',
      preview: '안녕하세요',
      started_at: 1760000000,
      message_count: 4,
      live_session_id: null,
    },
    { id: 'h2', source: 'cron', title: '크론 실행', preview: '자동', started_at: 1760000100, message_count: 2 },
  ],
};
// Claude Code 가 연 대화(스펙 2026-10-28-001 §3-7 ⑤). 에이전트를 열 때 「가장 최근 AAS 대화」를 잇는 시험이 흔들리지 않게 기본 목록에는 넣지 않고 그 시험만 더한다
const CLAUDE_ROWS = [
  { id: 'h3', source: 'aas', title: '스킬 시험 대화', preview: 't', started_at: 1760000200, message_count: 2, claude: { purpose: 'skill-test', active: false } },
  { id: 'h4', source: 'aas', title: 'Claude 작업', preview: 'w', started_at: 1760000300, message_count: 2, claude: { purpose: '', active: true } },
];
let extraHistory: unknown[] = [];

let store: ChatStore;
beforeEach(() => {
  FakeES.all = [];
  vi.stubGlobal('EventSource', FakeES);
  store = new ChatStore();
  extraHistory = [];
});
afterEach(() => vi.unstubAllGlobals());

function mount(initial = '/chat', status: unknown = STATUS(), me?: unknown, extra?: ReactElement) {
  const fn = stubApi({
    ...(me ? { '/api/me': me } : {}),
    '/api/chat/status': status,
    '/api/chat/history': () => ({ sessions: [...HISTORY.sessions, ...extraHistory] }),
    '/api/chat/session': (_u: string, b: Record<string, unknown>) => ({
      session_id: 's-' + b.profile,
      profile: b.profile,
      title: '',
    }),
    '/api/chat/resume': (_u: string, b: Record<string, unknown>) =>
      b.stored_id === 'gone' // 링크의 대화가 지워진 경우(스펙 2026-10-28-014)
        ? new Response(JSON.stringify({ error: '없는 대화' }), { status: 404 })
        : { session_id: 'r-' + b.stored_id, profile: b.profile, title: '' },
    '/api/chat/send': { ok: true },
    '/api/chat/skills': { profile: 'ma', skills: [{ command: '/요약', name: '요약', description: '주간 요약', usage: 1 }], warning: '' },
    '/api/chat/interrupt': { ok: true },
    '/api/chat/approval': { ok: true },
    '/api/chat/clarify': { ok: true },
    '/api/health': { collected_at: '', totals: {}, dashboard_url: 'http://hermes.local' },
  });
  mountScreen(
    <>
      <Chat store={store} />
      {extra}
    </>,
    initial
  );
  return fn;
}
const emit = (i: number, type: string, payload: Record<string, unknown> = {}) =>
  act(() => FakeES.all[i].emit(type, payload));
const open = async (name = '마케팅') => {
  const user = userEvent.setup();
  const fn = mount();
  await user.click(await screen.findByRole('button', { name: new RegExp(`^${name} 와 대화`) }));
  await screen.findByRole('textbox', { name: /에게 보낼 메시지/ });
  return { user, fn };
};
const input = () => screen.getByRole('textbox', { name: /에게 보낼 메시지/ });

const styleText = () => Array.from(document.querySelectorAll('style')).map((s) => s.textContent ?? '').join('\n');

describe('Chat: 본문 열 폭', () => {
  it('메시지·입력 카드는 넓은 화면에서 넓어지는 열 폭(720~960px)을 쓰고 720px 고정이 아니다(OMAI-1224)', async () => {
    await open();
    const css = styleText();
    expect(css).toContain('clamp(720px, 56vw, 960px)');
    expect(css).not.toMatch(/max-width:\s*720px/);
  });
});

describe('Chat: 에이전트 목록', () => {
  it('오피스처럼 제목이 있고, 목록을 읽는 동안과 지난 대화를 여는 동안 빨간 진행 막대를 보인다', async () => {
    mount();
    // 상태를 받기 전: 제목 아래 진행 막대(다른 화면의 ScreenLoading 과 같다)
    expect(screen.getByRole('heading', { level: 1, name: '채팅' })).toBeInTheDocument();
    expect(screen.getByRole('progressbar')).toBeInTheDocument();
    await screen.findByText('왼쪽에서 세션을 고르거나 「새 세션」을 시작하세요.');
    expect(screen.getByRole('heading', { level: 1, name: '채팅' })).toBeInTheDocument();
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
    act(() => {
      store.opening = 'ma';
      store.notify();
    });
    expect(screen.getByRole('progressbar', { name: '지난 대화를 불러오는 중…' })).toBeInTheDocument();
    act(() => {
      store.opening = '';
      store.notify();
    });
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
  });

  it('설정이 없을 때도 제목을 보인다', async () => {
    mount('/chat', { configured: false, error: '', env_file: '', agents: [] });
    await screen.findByText('Hermes API 서버 로그인 정보가 없어 채팅을 쓸 수 없습니다.');
    expect(screen.getByRole('heading', { level: 1, name: '채팅' })).toBeInTheDocument();
  });

  it('설정이 없으면 설정 방법을 안내한다', async () => {
    mount('/chat', { configured: false, error: '로그인 정보 없음', env_file: '/etc/aas/aas.env', agents: [] });
    expect(await screen.findByText('Hermes API 서버 로그인 정보가 없어 채팅을 쓸 수 없습니다.')).toBeInTheDocument();
    expect(screen.getByText(/\/etc\/aas\/aas.env/)).toBeInTheDocument();
    expect(screen.getByText('로그인 정보 없음')).toBeInTheDocument();
  });

  it('에이전트마다 제목·이름·상태·마지막 글을 보인다. 왼쪽에서 고르라는 안내가 있다', async () => {
    mount();
    expect(await screen.findByText('왼쪽에서 세션을 고르거나 「새 세션」을 시작하세요.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^마케팅 와 대화/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^ops 와 대화, 게이트웨이 중지됨/ })).toBeInTheDocument();
    expect(screen.getByText('실패 2')).toBeInTheDocument();
    expect(screen.getByText('마케팅 담당')).toBeInTheDocument();
  });

  it('검색은 이름·제목·설명으로 거른다', async () => {
    const user = userEvent.setup();
    mount();
    await screen.findByRole('button', { name: /^마케팅 와 대화/ });
    await user.type(screen.getByRole('searchbox', { name: 'AI 에이전트 찾기' }), '운영');
    expect(screen.queryByRole('button', { name: /^마케팅/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^ops/ })).toBeInTheDocument();
    await user.clear(screen.getByRole('searchbox', { name: 'AI 에이전트 찾기' }));
    await user.type(screen.getByRole('searchbox', { name: 'AI 에이전트 찾기' }), 'zzzz');
    expect(screen.getByText('일치하는 AI 에이전트가 없습니다. 검색어를 바꿔 보세요.')).toBeInTheDocument();
  });

  it('주 프로파일(main)을 만드는 동안 목록이 비면 「준비 중」 안내를 보인다(2026-10-19-001 D7·D9)', async () => {
    mount('/chat', STATUS({ agents: [] }), { auth_enabled: true, admin: false, pod: { id: 'p' }, user: { email: 'k@x.com' }, primary: { profile: 'main', ready: false } });
    expect(await screen.findByRole('status')).toHaveTextContent('주 프로파일(main)을 만들고 있습니다');
  });

  it('에이전트를 누르면 대화가 열리고 머리말에 이름이 나온다. 뒤로 가면 목록으로 돌아간다', async () => {
    const { user } = await open();
    expect(screen.getByRole('region', { name: '마케팅 와 나눈 대화' })).toBeInTheDocument();
    // 세션 중심 채팅: 에이전트를 고르면 새 세션이 열리고, 첫 말 전에는 큰 안내 화면이다
    expect(screen.getByTestId('new-session-hero')).toHaveTextContent('무엇을 맡길까요?');
    await user.click(screen.getByRole('button', { name: 'AI 에이전트 목록으로' }));
    expect(await screen.findByText('왼쪽에서 세션을 고르거나 「새 세션」을 시작하세요.')).toBeInTheDocument();
  });

  it('?agent= 로 들어오면 그 에이전트가 열린다', async () => {
    mount('/chat?agent=ops');
    expect(await screen.findByRole('region', { name: 'ops 와 나눈 대화' })).toBeInTheDocument();
  });

  it('?agent=&text= 는 새 대화를 열고 입력창에 글을 채우되 보내지 않는다', async () => {
    const fn = mount('/chat?agent=ma&text=' + encodeURIComponent('이 스킬을 설명해 줘'));
    await waitFor(() => expect(input()).toHaveValue('이 스킬을 설명해 줘'));
    expect(postedTo(fn, '/api/chat/send')).toEqual([]);
    expect(postedTo(fn, '/api/chat/session')).toEqual([{ profile: 'ma' }]);
  });
});

describe('Chat: 보내기와 답', () => {
  it('Enter 로 보내고 Shift+Enter 는 줄을 바꾼다', async () => {
    const { user, fn } = await open();
    await user.type(input(), '첫 줄{Shift>}{Enter}{/Shift}둘째');
    expect(input()).toHaveValue('첫 줄\n둘째');
    expect(postedTo(fn, '/api/chat/send')).toEqual([]);
    await user.keyboard('{Enter}');
    await waitFor(() => expect(postedTo(fn, '/api/chat/send')).toEqual([{ session_id: 's-ma', text: '첫 줄\n둘째' }]));
    expect(input()).toHaveValue('');
  });

  it('「/」로 스킬을 골라 보내면 skill 을 붙이고, 보내기 전에 안내한다(스펙 2026-10-19-012 R7·DD6)', async () => {
    const { user, fn } = await open();
    await user.type(input(), '/요');
    await user.keyboard('{Enter}');
    expect(input()).toHaveValue('/요약 ');
    await user.type(input(), '이번 주');
    expect(screen.getByText('· 스킬 /요약 으로 보냅니다')).toBeInTheDocument();
    await user.keyboard('{Enter}');
    await waitFor(() => expect(postedTo(fn, '/api/chat/send')).toEqual([{ session_id: 's-ma', text: '/요약 이번 주', skill: '요약' }]));
    expect(fn.mock.calls.some((c) => String(c[0]).startsWith('/api/chat/skills?profile=ma'))).toBe(true);
  });

  it('목록에 없는 /낱말은 글 그대로 보낸다(R6)', async () => {
    const { user, fn } = await open();
    await user.type(input(), '/etc/hosts 열어 줘{Enter}');
    await waitFor(() => expect(postedTo(fn, '/api/chat/send')).toEqual([{ session_id: 's-ma', text: '/etc/hosts 열어 줘' }]));
  });

  it('스킬을 붙이지 못하면 호박색 안내 줄로 이유를 보인다(DD5)', async () => {
    const { user } = await open();
    await user.type(input(), '말{Enter}');
    await waitFor(() => expect(FakeES.all.length).toBeGreaterThan(0));
    await emit(0, 'aas.notice', { code: 'skill_failed', name: '요약', reason: 'collision' });
    expect(await screen.findByRole('note')).toHaveTextContent('스킬 /요약 를 붙이지 못해 글만 보냈습니다 · 다른 명령과 이름이 같음');
  });

  it('보내기 버튼도 보낸다', async () => {
    const { user, fn } = await open();
    await user.type(input(), '버튼');
    await user.click(screen.getByRole('button', { name: '보내기' }));
    await waitFor(() => expect(postedTo(fn, '/api/chat/send')).toHaveLength(1));
  });

  it('서버 이벤트로 사용자 말풍선과 답변(마크다운)이 그려지고 복사 버튼이 있다', async () => {
    const { user } = await open();
    await user.type(input(), '안녕{Enter}');
    await waitFor(() => expect(FakeES.all).toHaveLength(1));
    const write = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue();
    await emit(0, 'aas.user', { text: '안녕' });
    await emit(0, 'message.delta', { text: '**반가워요**' });
    await emit(0, 'message.complete', { text: '**반가워요**' });
    const log = screen.getByRole('log', { name: '대화 내용' });
    expect(within(log).getByText('안녕')).toBeInTheDocument();
    // 내 말은 이제 단색 판이다(파란 채움 없음). 본문 글자색은 대화 토큰의 text 색이고, 판과의 대비는 chatTokens.test.ts 가 고정한다.
    // 처음에는 라이트 모드에서 어두운 글자가 진한 파란 말풍선 위에 얹혀 읽을 수 없었다(OKE 라이트 모드 확인에서 발견)
    const hex = chatTokens.dark.text; // 화면 시험의 기본 테마는 다크다
    const rgb = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(', ');
    expect(getComputedStyle(within(log).getByText('안녕')).color).toBe(`rgb(${rgb})`);
    expect(within(log).getByText('반가워요').tagName).toBe('STRONG');
    // 답이 끝나면 숨은 상태 영역이 한 번 알린다(스트리밍 중에는 aria-busy 로 조각을 읽지 않는다, 디자인 리뷰 6-2)
    expect(within(log).getByRole('status')).toHaveTextContent('답이 도착했습니다');
    expect(log).not.toHaveAttribute('aria-busy');
    await user.click(within(log).getByRole('button', { name: '답변 복사' }));
    expect(write).toHaveBeenCalledWith('**반가워요**');
    await waitFor(() => expect(within(log).getByRole('status')).toHaveTextContent('복사했습니다'));
  });

  it('본문을 위로 올리면 뜨는 「맨 아래로」 버튼은 바탕이 비치지 않는 불투명한 칠이다(본문 글자와 겹쳐 안 보이던 문제)', async () => {
    const { user } = await open();
    await user.type(input(), '안녕{Enter}');
    await waitFor(() => expect(FakeES.all).toHaveLength(1));
    await emit(0, 'aas.user', { text: '안녕' });
    await emit(0, 'message.complete', { text: '답' });
    const log = screen.getByRole('log', { name: '대화 내용' });
    Object.defineProperty(log, 'scrollHeight', { configurable: true, value: 2000 });
    fireEvent.scroll(log);
    const btn = await screen.findByRole('button', { name: '맨 아래로' });
    const rgb = [1, 3, 5].map((i) => parseInt(chatTokens.dark.canvas.slice(i, i + 2), 16)).join(', ');
    expect(getComputedStyle(btn).backgroundColor).toBe(`rgb(${rgb})`);
  });

  it('답하는 중에는 보내기 버튼이 중단 버튼이 된다. 누르면 interrupt 를 보낸다', async () => {
    const { user, fn } = await open();
    await user.type(input(), 'q{Enter}');
    await waitFor(() => expect(FakeES.all).toHaveLength(1));
    await emit(0, 'aas.user', { text: 'q' });
    const stop = await screen.findByRole('button', { name: '답변 중단' });
    await user.click(stop);
    await waitFor(() => expect(postedTo(fn, '/api/chat/interrupt')).toEqual([{ session_id: 's-ma' }]));
    expect(screen.getByText('응답을 만드는 중…')).toBeInTheDocument();
  });

  it('진행 단계는 접혀 있다가 눌러 펼친다', async () => {
    const { user } = await open();
    await user.type(input(), 'q{Enter}');
    await waitFor(() => expect(FakeES.all).toHaveLength(1));
    await emit(0, 'aas.user', { text: 'q' });
    await emit(0, 'tool.start', { tool_id: 't1', name: 'web_search', context: '날씨' });
    await emit(0, 'tool.complete', { tool_id: 't1' });
    await emit(0, 'message.complete', { text: '맑음' });
    const summary = screen.getByText(/작업 1단계/);
    const details = summary.closest('details') as HTMLDetailsElement;
    expect(details.open).toBe(false);
    await user.click(summary);
    expect(details.open).toBe(true);
    expect(within(details).getByText('web_search')).toBeInTheDocument();
  });

  it('안전장치가 명령을 막으면 단계와 답에 빨간 표시를 단다(스펙 2026-10-24-004)', async () => {
    const { user } = await open();
    await user.type(input(), 'q{Enter}');
    await waitFor(() => expect(FakeES.all).toHaveLength(1));
    await emit(0, 'aas.user', { text: 'q' });
    await emit(0, 'tool.start', { tool_id: 't1', name: 'terminal', context: 'rm -rf /opt/data/profiles/x' });
    await emit(0, 'tool.complete', { tool_id: 't1', result: { status: 'blocked', exit_code: -1, error: 'BLOCKED (hardline): recursive delete of Hermes data (/opt/data/profiles/x). This command is on the unconditional blocklist.' } });
    await emit(0, 'message.complete', { text: '요청한 명령은 실행되지 않았습니다.' });
    const mark = screen.getByRole('note', { name: '안전장치가 위험한 명령을 막았습니다' });
    expect(mark).toHaveTextContent('recursive delete of Hermes data (/opt/data/profiles/x)');
    expect(screen.getByText(/작업 1단계 · 안전장치가 막음/)).toBeInTheDocument();
    // 다음 턴의 보통 답에는 붙지 않는다
    await emit(0, 'aas.user', { text: 'q2' });
    await emit(0, 'message.complete', { text: '네' });
    expect(screen.getAllByRole('note', { name: '안전장치가 위험한 명령을 막았습니다' })).toHaveLength(1);
  });

  it('보내기 실패 오류 줄에서 다시 보낼 수 있다', async () => {
    const user = userEvent.setup();
    let fail = true;
    const reply = (body: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status }));
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) => {
        const u = String(url);
        if (u.startsWith('/api/chat/send')) return fail ? reply({ error: '연결 거부' }, 500) : reply({ ok: true });
        if (u.startsWith('/api/chat/status')) return reply(STATUS());
        if (u.startsWith('/api/chat/history')) return reply({ sessions: [] });
        if (u.startsWith('/api/chat/session')) return reply({ session_id: 's1', profile: 'ma', title: '' });
        return reply({});
      })
    );
    mountScreen(<Chat store={store} />, '/chat');
    await user.click(await screen.findByRole('button', { name: /^마케팅 와 대화/ }));
    await user.type(await screen.findByRole('textbox', { name: /에게 보낼 메시지/ }), '다시{Enter}');
    expect(await screen.findByRole('alert')).toHaveTextContent('보내지 못했습니다: 연결 거부');
    fail = false;
    await user.click(screen.getByRole('button', { name: '다시 보내기' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: '다시 보내기' })).not.toBeInTheDocument());
    expect(screen.getByRole('alert')).toHaveTextContent('(다시 보냄)');
  });

  // 스펙 2026-10-20-030: 끊긴 대화는 저절로 다시 연다. 다시 여는 동안 입력 칸 위 회색 줄과 「지금 다시 열기」, 보내기·멈춤은 막는다
  it('연결이 끊기면 입력 칸 위에 「다시 여는 중」 줄이 뜨고 보내기를 막으며, 「지금 다시 열기」로 바로 다시 연다', async () => {
    const user = userEvent.setup();
    const reply = (body: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status }));
    let up = false;
    const fn = vi.fn((url: string) => {
      const u = String(url);
      if (u.startsWith('/api/chat/status')) return reply(STATUS());
      if (u.startsWith('/api/chat/history')) return reply({ sessions: [{ id: 'old1', title: '지난', source: 'aas' }] });
      if (u.startsWith('/api/chat/resume')) {
        return up ? reply({ session_id: 's2', profile: 'ma', title: '지난', reused: true, history: false }) : reply({ error: 'down' }, 503);
      }
      if (u.startsWith('/api/chat/session')) return reply({ session_id: 's1', profile: 'ma', title: '' }); // 에이전트를 고르면 새 세션
      return reply({ ok: true });
    });
    vi.stubGlobal('fetch', fn);
    mountScreen(<Chat store={store} />, '/chat');
    await user.click(await screen.findByRole('button', { name: /^마케팅 와 대화/ }));
    await waitFor(() => expect(FakeES.all.length).toBeGreaterThan(0));
    const resumes = () => fn.mock.calls.filter(([u]) => String(u).startsWith('/api/chat/resume')).length;
    const before = resumes();
    FakeES.all.at(-1)!.onerror?.();
    const row = await screen.findByTestId('reconnect-row');
    expect(row).toHaveTextContent('이 대화를 다시 여는 중입니다');
    expect(screen.getByRole('button', { name: '보내기' })).toBeDisabled();
    expect(screen.getByText('다시 연결되면 보내거나 멈출 수 있습니다')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument(); // 빨간 오류 줄이 아니다
    await waitFor(() => expect(resumes()).toBe(before + 1));
    up = true;
    await user.click(within(row).getByRole('button', { name: '지금 다시 열기' }));
    await waitFor(() => expect(screen.queryByTestId('reconnect-row')).not.toBeInTheDocument());
    expect(resumes()).toBe(before + 2);
  });

  it('Hermes 에 대화가 없으면 빨간 줄과 「새 대화」로 내린다(404)', async () => {
    const user = userEvent.setup();
    const reply = (body: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status }));
    const fn = vi.fn((url: string) => {
      const u = String(url);
      if (u.startsWith('/api/chat/status')) return reply(STATUS());
      if (u.startsWith('/api/chat/history')) return reply({ sessions: [{ id: 'old1', title: '지난', source: 'aas' }] });
      if (u.startsWith('/api/chat/resume'))
        return reply({ error: 'gone', code: 'not_found' }, 404); // 에이전트를 고르면 새 세션(s3)이고, 끊긴 뒤 다시 열 때 저장 대화가 없다
      if (u === '/api/chat/session')
        return reply({ session_id: fn.mock.calls.filter(([x]) => String(x) === '/api/chat/session').length > 1 ? 's4' : 's3', profile: 'ma', title: '' });
      return reply({ ok: true });
    });
    vi.stubGlobal('fetch', fn);
    mountScreen(<Chat store={store} />, '/chat');
    await user.click(await screen.findByRole('button', { name: /^마케팅 와 대화/ }));
    await waitFor(() => expect(FakeES.all.length).toBeGreaterThan(0));
    FakeES.all.at(-1)!.onerror?.();
    expect(await screen.findByRole('alert')).toHaveTextContent('이 대화를 찾을 수 없습니다');
    await user.click(screen.getByRole('button', { name: '새 대화' }));
    await waitFor(() => expect(fn.mock.calls.filter(([u]) => String(u) === '/api/chat/session').length).toBe(2));
  });
});

describe('Chat: 승인과 되묻기', () => {
  const start = async () => {
    const r = await open();
    await r.user.type(input(), 'q{Enter}');
    await waitFor(() => expect(FakeES.all).toHaveLength(1));
    await emit(0, 'aas.user', { text: 'q' });
    return r;
  };

  it('승인 요청은 입력창 위 카드로 뜨고 선택지를 누르면 approval 을 보낸다', async () => {
    const { user, fn } = await start();
    await emit(0, 'approval.request', { request_id: 'r1', command: 'rm -rf /tmp/x', description: '파일 삭제' });
    const card = await screen.findByRole('group', { name: '승인 요청' });
    expect(within(card).getByText('rm -rf /tmp/x')).toBeInTheDocument();
    expect(screen.getByText('↓ 아래 입력창 위에서 답을 기다리고 있습니다')).toBeInTheDocument();
    await user.click(within(card).getByRole('button', { name: '한 번 허용' }));
    await waitFor(() =>
      expect(postedTo(fn, '/api/chat/approval')).toEqual([{ session_id: 's-ma', choice: 'once', request_id: 'r1' }])
    );
    await emit(0, 'aas.approval.answered', { choice: 'once' });
    expect(screen.queryByRole('group', { name: '승인 요청' })).not.toBeInTheDocument();
    expect(screen.getByText(/승인 요청에 「한 번 허용」\(으\)로 답함/)).toBeInTheDocument();
  });

  it('승인 카드가 나타날 때 숨은 role=alert 로 알리고(디자인 리뷰 6-2), 답하면 포커스가 입력칸으로 돌아온다(3-1)', async () => {
    const { user } = await start();
    await emit(0, 'approval.request', { request_id: 'r7', command: 'ls' });
    const card = await screen.findByRole('group', { name: '승인 요청' });
    expect(within(card).getByRole('alert')).toHaveTextContent('명령 실행 승인 요청이 도착했습니다');
    // 거부는 되돌릴 수 있지만 명령 실행을 막는 안전 단추라 빨강 윤곽선을 유지한다(결정 R10), 한 번 허용은 단색 Tier 1
    expect(within(card).getByRole('button', { name: '거부' }).className).toMatch(/colorError/);
    expect(within(card).getByRole('button', { name: '한 번 허용' }).className).not.toMatch(/colorPrimary|contained/);
    await user.click(within(card).getByRole('button', { name: '한 번 허용' }));
    expect(input()).toHaveFocus();
  });

  // 스펙 2026-10-23-005 디자인 D3·D4·D7·D9: 취소된 카드는 닫히고 요청 자리의 줄이 이유를 말한다. 화면 읽기 프로그램도 한 번 읽는다
  it('Hermes 가 요청을 끝내면 카드를 닫고 이유를 줄로 남긴다', async () => {
    await start();
    await emit(0, 'approval.request', { request_id: 'r9', command: 'rm -rf /tmp/y' });
    await screen.findByRole('group', { name: '승인 요청' });
    await emit(0, 'aas.request.cancelled', { request_id: 'r9', method: 'approval', reason: 'timeout' });
    await waitFor(() => expect(screen.queryByRole('group', { name: '승인 요청' })).toBeNull());
    expect(screen.getAllByText(/승인 요청이 시간 초과로 끝났습니다. 명령을 실행하지 않았습니다/).length).toBeGreaterThan(0);
    expect(screen.queryByText('↓ 아래 입력창 위에서 답을 기다리고 있습니다')).toBeNull();
    const status = screen.getAllByRole('status').find((el) => /시간 초과로 끝났습니다/.test(el.textContent ?? ''));
    expect(status).toBeTruthy();
  });

  it('답하지 않은 요청이 연달아 오면 대기 줄은 하나만 보인다(R10)', async () => {
    await start();
    await emit(0, 'approval.request', { request_id: 'r1', command: 'a' });
    await emit(0, 'clarify.request', { request_id: 'q1', questions: [{ qid: 'a', question: '어느 쪽?', choices: [] }, { qid: 'b', question: '언제?', choices: [] }] });
    await waitFor(() => expect(screen.getAllByRole('group', { name: /승인 요청|AI 에이전트의 물음/ })).toHaveLength(3));
    expect(screen.getAllByText('↓ 아래 입력창 위에서 답을 기다리고 있습니다')).toHaveLength(1);
  });

  it('답 보내기가 실패하면 카드 안에 오류 줄을 두고 다시 누를 수 있다(D5·D6)', async () => {
    const { user, fn } = await start();
    const real = fn.getMockImplementation()!;
    fn.mockImplementation((u: string, init?: RequestInit) =>
      String(u).startsWith('/api/chat/approval')
        ? Promise.resolve(new Response(JSON.stringify({ error: 'Hermes 응답 없음' }), { status: 503 }))
        : real(u, init)
    );
    await emit(0, 'approval.request', { request_id: 'r1', command: 'ls' });
    const card = await screen.findByRole('group', { name: '승인 요청' });
    await user.click(within(card).getByRole('button', { name: '한 번 허용' }));
    await waitFor(() => expect(within(card).getByText(/답을 보내지 못했습니다/)).toHaveAttribute('role', 'alert'));
    expect(card).toHaveAttribute('aria-busy', 'false');
    expect(within(card).getByRole('button', { name: '한 번 허용' })).toBeEnabled();
    expect(screen.queryByText(/^Hermes 응답 없음$/)).toBeNull(); // 대화 목록 오류 줄로 넣지 않는다
  });

  it('선택지가 정해지면 그것만 낸다', async () => {
    await start();
    await emit(0, 'approval.request', { request_id: 'r2', command: 'x', choices: ['deny', 'once'] });
    const card = await screen.findByRole('group', { name: '승인 요청' });
    expect(
      within(card)
        .getAllByRole('button')
        .map((b) => b.textContent)
    ).toEqual(['거부', '한 번 허용']);
  });

  it('되묻기: 선택지를 누르면 답이 가고, 직접 입력도 된다', async () => {
    const { user, fn } = await start();
    await emit(0, 'clarify.request', {
      request_id: 'q1',
      questions: [{ qid: 'a', question: '어느 쪽?', choices: ['왼쪽', { label: '오른쪽', value: 'r' }] }],
    });
    const card = await screen.findByRole('group', { name: 'AI 에이전트의 물음' });
    expect(within(card).getByText('어느 쪽?')).toBeInTheDocument();
    await user.click(within(card).getByRole('button', { name: '오른쪽' }));
    await waitFor(() =>
      expect(postedTo(fn, '/api/chat/clarify')).toEqual([
        { session_id: 's-ma', request_id: 'q1', question_id: 'a', answer: '오른쪽' },
      ])
    );
    // 답을 보낸 뒤에는 카드가 잠겨 두 번 답하지 않는다(스펙 2026-10-23-005 디자인 D6). 답한 이벤트가 오면 카드가 닫힌다
    await waitFor(() => expect(card).toHaveAttribute('aria-busy', 'true'));
    expect(within(card).getByRole('textbox', { name: '답 직접 입력' })).toBeDisabled();
    await emit(0, 'clarify.request', { request_id: 'q2', questions: [{ qid: 'b', question: '언제?', choices: [] }] });
    const second = (await screen.findAllByRole('group', { name: 'AI 에이전트의 물음' })).at(-1) as HTMLElement;
    await user.type(within(second).getByRole('textbox', { name: '답 직접 입력' }), '가운데{Enter}');
    await waitFor(() => expect(postedTo(fn, '/api/chat/clarify')[1]).toMatchObject({ request_id: 'q2', answer: '가운데' }));
  });

  it('여러 개 고르는 되묻기는 체크한 것을 배열로 보낸다', async () => {
    const { user, fn } = await start();
    await emit(0, 'clarify.request', {
      request_id: 'q2',
      questions: [{ qid: 'b', question: '무엇 무엇?', choices: ['가', '나', '다'], multi_select: true }],
    });
    const card = await screen.findByRole('group', { name: 'AI 에이전트의 물음' });
    expect(within(card).getByText(/여러 개 선택 가능/)).toBeInTheDocument();
    await user.click(within(card).getByRole('checkbox', { name: '가' }));
    await user.click(within(card).getByRole('checkbox', { name: '다' }));
    await user.click(within(card).getByRole('button', { name: '답하기' }));
    await waitFor(() =>
      expect(postedTo(fn, '/api/chat/clarify')).toEqual([
        { session_id: 's-ma', request_id: 'q2', question_id: 'b', answer: ['가', '다'] },
      ])
    );
  });
});

describe('Chat: 대화 메뉴와 지난 대화', () => {
  it('「새 대화」 단추를 누르면 입력칸에 포커스가 간다(디자인 리뷰 3-1)', async () => {
    const { user } = await open();
    await user.click(screen.getByRole('button', { name: /새 대화 시작/ }));
    expect(input()).toHaveFocus();
  });

  it('머리줄 단추: 새 대화·지난 대화는 메뉴가 아니라 단추이고, 메뉴에는 이어서 보기 링크만 남는다', async () => {
    const { user, fn } = await open();
    expect(screen.queryByRole('menuitem', { name: /새 대화 시작/ })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /^대화/ }));
    expect(screen.getByRole('menuitem', { name: /프로파일 설정/ })).toHaveAttribute('href', '/profiles?name=ma');
    expect(screen.getByRole('menuitem', { name: /예약 작업/ })).toHaveAttribute('href', '/cron?tab=profiles&q=ma');
    expect(screen.queryByRole('menuitem', { name: /에이전트 대시보드/ })).not.toBeInTheDocument(); // 에이전트 대시보드로 나가는 링크는 두지 않는다(OMAI-1117)
    expect(screen.queryByRole('menuitem', { name: /지난 대화 보기/ })).not.toBeInTheDocument();
    await user.keyboard('{Escape}');
    await user.click(screen.getByRole('button', { name: /새 대화 시작/ }));
    await waitFor(() => expect(postedTo(fn, '/api/chat/session')).toHaveLength(2)); // 에이전트를 고를 때 한 번 + 새 대화 한 번
  });

  it('지난 대화: 기본은 크론을 빼고 보이며, 고르면 이어 쓴다', async () => {
    const { user, fn } = await open();
    await user.click(screen.getByRole('button', { name: /지난 대화 보기/ }));
    const dlg = await screen.findByRole('dialog', { name: '지난 대화' });
    expect(await within(dlg).findByText('텔레그램 대화')).toBeInTheDocument();
    expect(within(dlg).queryByText('크론 실행')).not.toBeInTheDocument();
    // 프로파일 서랍과 같은 줄 모양(아이콘·이름·뱃지·미리 보기)
    const row = within(dlg).getByText('텔레그램 대화').closest('[data-item-row]') as HTMLElement;
    expect(row).not.toBeNull();
    expect(row.querySelector('[data-item-icon]')).toHaveAttribute('aria-hidden', 'true');
    await user.selectOptions(within(dlg).getByRole('combobox', { name: '출처' }), 'all');
    expect(within(dlg).getByText('크론 실행')).toBeInTheDocument();
    await user.click(within(dlg).getByRole('button', { name: /텔레그램 대화/ }));
    await waitFor(() => expect(postedTo(fn, '/api/chat/resume')).toEqual([{ profile: 'ma', stored_id: 'h1' }]));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('지난 대화: Claude Code 가 연 대화는 표시하고, 스킬 시험은 기본 거름에서 빼며, 쓰는 중인 대화를 열면 띠를 보인다(스펙 2026-10-28-001 §3-7 ⑤)', async () => {
    const { user, fn } = await open();
    extraHistory = CLAUDE_ROWS;
    await user.click(screen.getByRole('button', { name: /지난 대화 보기/ }));
    const dlg = await screen.findByRole('dialog', { name: '지난 대화' });
    const busy = (await within(dlg).findByText('Claude 작업')).closest('[data-item-row]') as HTMLElement;
    expect(within(busy).getByText('Claude Code 가 쓰는 중')).toBeInTheDocument();
    expect(within(dlg).queryByText('스킬 시험 대화')).not.toBeInTheDocument();
    await user.selectOptions(within(dlg).getByRole('combobox', { name: '출처' }), 'skill-test');
    const test = (await within(dlg).findByText('스킬 시험 대화')).closest('[data-item-row]') as HTMLElement;
    expect(within(test).getByText('Claude Code')).toBeInTheDocument();
    expect(within(dlg).queryByText('Claude 작업')).not.toBeInTheDocument();
    await user.selectOptions(within(dlg).getByRole('combobox', { name: '출처' }), 'talk');
    await user.click(within(dlg).getByRole('button', { name: /Claude 작업/ }));
    await waitFor(() => expect(postedTo(fn, '/api/chat/resume')).toEqual([{ profile: 'ma', stored_id: 'h4' }]));
    expect(await screen.findByTestId('claude-using')).toHaveTextContent('Claude Code 가 이 대화를 쓰는 중입니다');
    // 이 대화의 승인 카드에는 「Claude Code 가 답할 수 있음」(§3-7 ④)
    await waitFor(() => expect(FakeES.all.length).toBeGreaterThan(0));
    await emit(FakeES.all.length - 1, 'approval.request', { request_id: 'r1', command: 'rm -rf build' });
    const card = await screen.findByRole('group', { name: /승인/ });
    expect(within(card).getByText('Claude Code 가 답할 수 있음')).toBeInTheDocument();
  });

  it('지난 대화: 연 적 없는 크론 세션은 「새 결과」 표시와 개수를 보이고, 열면 사라진다(스펙 2026-10-15-003 R8)', async () => {
    window.localStorage.clear();
    const { user } = await open();
    await user.click(screen.getByRole('button', { name: /지난 대화 보기/ }));
    const dlg = await screen.findByRole('dialog', { name: '지난 대화' });
    await within(dlg).findByText('텔레그램 대화');
    expect(within(dlg).getByRole('option', { name: /새 결과 1/ })).toBeInTheDocument();
    await user.selectOptions(within(dlg).getByRole('combobox', { name: '출처' }), 'cron');
    expect(within(dlg).getByText('새 결과')).toBeInTheDocument();
    await user.click(within(dlg).getByRole('button', { name: /크론 실행/ }));
    expect(JSON.parse(window.localStorage.getItem('aas.chat.cronSeen') ?? '[]')).toEqual(['h2']);
  });

  it('다른 에이전트에서 승인 대기가 생기면 목록에 확인 표시가 뜨고 위로 올라온다', async () => {
    const { user } = await open();
    await user.type(input(), 'q{Enter}');
    await waitFor(() => expect(FakeES.all).toHaveLength(1));
    await user.click(screen.getByRole('button', { name: 'AI 에이전트 목록으로' }));
    await emit(0, 'approval.request', { request_id: 'r9', command: 'x' });
    const first = (await screen.findAllByRole('button', { name: / 와 대화/ }))[0];
    expect(first).toHaveAccessibleName(/^마케팅 와 대화.*답을 기다림/);
    expect(within(first).getByText('답 필요')).toBeInTheDocument();
  });

  it('제목은 오피스처럼 「<회사> > <부서> 채팅」이고 회사·부서가 없으면 「채팅」이다', async () => {
    mount('/chat', STATUS(), { auth_enabled: true, admin: false, user: { email: 'a@x.com' }, company_name: 'ACME', department: '마케팅팀' });
    expect(await screen.findByRole('heading', { level: 1, name: 'ACME > 마케팅팀 채팅' })).toBeInTheDocument();
  });
});

// 에이전트 목록의 이름 옆에 누구의 것인지 사람 이름(스펙 2026-10-18-010)
describe('Chat: 에이전트 목록의 주인 이름', () => {
  it('서버가 주인 이름을 주면 목록의 각 에이전트 옆에 보인다', async () => {
    mount('/chat', STATUS({ owner_name: 'AAS 관리자' }));
    const list = within(await screen.findByRole('complementary', { name: /에이전트/ }));
    expect(list.getAllByText('AAS 관리자').length).toBe(3);
  });

  it('주인 이름이 없으면 보이지 않는다', async () => {
    mount();
    await screen.findByRole('complementary', { name: /에이전트/ });
    expect(screen.queryByText('AAS 관리자')).not.toBeInTheDocument();
  });
});

// 2026-10-19-001 R2·디자인 D3~D7·D13·D14: 채팅에 내 에이전트를 모두 묶음으로 보인다
describe('Chat — 여러 에이전트 묶음', () => {
  const GROUPS = (over: Record<string, unknown>[] = []) => ({
    pod: 'a',
    groups: [
      { pod: 'a', current: true, configured: true, name: '관리자 AAS', primary: 'main', agents: [{ name: 'main' }], sessions: [] },
      { pod: 'b', configured: true, name: '마케팅 도우미', primary: 'main', agents: [{ name: 'main' }, { name: 'plan', title: '기획 담당' }], sessions: [] },
      ...over,
    ],
  });
  beforeEach(() => {
    try {
      localStorage.removeItem('aas-chat-collapsed');
    } catch {
      /* 저장소 없음 */
    }
  });

  it('묶음 머리에 에이전트 이름과 「지금 에이전트」, 줄 이름에 에이전트가 들어가고 다른 에이전트의 main 을 그 에이전트로 연다', async () => {
    const user = userEvent.setup();
    const fn = mount('/chat', GROUPS());
    const head = await screen.findByRole('button', { name: /마케팅 도우미/, expanded: true });
    // 프로파일이 하나뿐인 a 는 묶음 머리 없이 에이전트 이름 줄 하나 — 「지금 에이전트」는 줄로 옮겨 낭독 이름에도 들어간다(2026-10-19-013 R3·DD11)
    expect(screen.queryByRole('group', { name: /관리자 AAS/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^관리자 AAS 와 대화, 지금 AI 에이전트 작업공간/ })).toHaveTextContent('지금 AI 에이전트 작업공간');
    await user.click(screen.getByRole('button', { name: /^마케팅 도우미의 main 와 대화/ }));
    // 에이전트를 고르면 그 묶음(pod b)의 main 으로 새 세션
    await waitFor(() => expect(postedTo(fn, '/api/chat/session')).toContainEqual({ profile: 'main', pod: 'b' }));
    expect(await screen.findByText('마케팅 도우미 / main 에서 실행')).toBeInTheDocument(); // 대화 머리(디자인 D4)
    expect(head).toBeInTheDocument();
  });

  it('묶음 머리를 누르면 접히고, 접은 상태를 기억하며, 검색 중에는 다시 펼친다', async () => {
    const user = userEvent.setup();
    mount('/chat', GROUPS());
    const head = await screen.findByRole('button', { name: /마케팅 도우미/, expanded: true });
    await user.click(head);
    expect(head).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('button', { name: /^마케팅 도우미의 main 와 대화/ })).not.toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem('aas-chat-collapsed') || '[]')).toEqual(['b']);
    await user.type(screen.getByRole('searchbox', { name: 'AI 에이전트 찾기' }), '마케팅');
    expect(screen.getByRole('button', { name: /^마케팅 도우미의 main 와 대화/ })).toBeInTheDocument(); // 묶음 이름이 맞으면 줄을 모두 보인다(D14)
    expect(screen.getByRole('button', { name: /^마케팅 도우미의 기획 담당 와 대화/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^관리자 AAS 와 대화/ })).not.toBeInTheDocument(); // 결과가 없는 에이전트는 숨긴다
  });

  // 2026-10-19-013: 프로파일이 하나뿐인 에이전트는 에이전트 이름만
  it('프로파일 1개: 줄·아바타·대화 머리·입력창·답한 사람이 에이전트 이름이고 프로파일은 풍선말에만(DD8·DD12)', async () => {
    const user = userEvent.setup();
    mount('/chat', GROUPS());
    const row = await screen.findByRole('button', { name: /^관리자 AAS 와 대화/ });
    expect(within(row).getByTitle('관리자 AAS · 프로파일 main')).toHaveTextContent('관리자 AAS');
    expect(row).not.toHaveTextContent(/\bmain\b/);
    await user.click(row);
    const box = await screen.findByRole('textbox', { name: /^관리자 AAS 에게 보낼 메시지/ });
    expect(box).toHaveAttribute('placeholder', '관리자 AAS 에게 보낼 메시지를 입력하세요 (/ 명령·스킬)'); // 「/」 스킬 안내(스펙 2026-10-19-012 DD7)
    const head = screen.getByRole('region', { name: /관리자 AAS/ });
    // 머리 둘째 줄: 이 세션이 도는 에이전트(프로파일 이름 없이)
    expect(within(screen.getByTestId('chat-head')).getByText('관리자 AAS 에서 실행')).toBeInTheDocument();
    // 대화를 시작하기 전의 새 세션 화면도 같은 이름을 쓴다
    expect(within(screen.getByTestId('new-session-hero')).getByText(/관리자 AAS 에게 새 세션으로/)).toBeInTheDocument();
    expect(within(screen.getByTestId('new-session-hero')).queryByText(/\bmain\b/)).toBeNull();
    expect(head).toBeInTheDocument();
  });

  it('머리 없는 다른 에이전트의 줄을 누르면 그 에이전트로 연다(C3)', async () => {
    const user = userEvent.setup();
    const fn = mount('/chat', GROUPS([{ pod: 'c', configured: true, name: '영업 도우미', primary: 'main', agents: [{ name: 'main' }], sessions: [] }]));
    await user.click(await screen.findByRole('button', { name: /^영업 도우미 와 대화/ }));
    await waitFor(() => expect(postedTo(fn, '/api/chat/session')).toContainEqual({ profile: 'main', pod: 'c' }));
    expect(screen.getByRole('button', { name: /^영업 도우미 와 대화/ })).toHaveAttribute('aria-current', 'true');
    expect(screen.getByRole('button', { name: /^관리자 AAS 와 대화/ })).toHaveAttribute('aria-current', 'false');
  });

  it('첫 줄 순서는 이름 → 주인 → 지금 에이전트, 낭독 이름에 주인도 들어간다(DD10·DD11)', async () => {
    mount('/chat', GROUPS([{ pod: 's', current: false, shared: true, owner_name: '홍길동', configured: true, name: '나눠 받은 것', primary: 'main', agents: [{ name: 'main' }], sessions: [] }]));
    const row = await screen.findByRole('button', { name: /^나눠 받은 것 와 대화, 홍길동님의 AI 에이전트 작업공간/ });
    const line = row.textContent ?? '';
    expect(line.indexOf('나눠 받은 것')).toBeLessThan(line.indexOf('홍길동'));
    const mine = screen.getByRole('button', { name: /^관리자 AAS 와 대화/ }).textContent ?? '';
    expect(mine.indexOf('관리자 AAS')).toBeLessThan(mine.indexOf('지금 AI 에이전트 작업공간'));
  });

  it('main 을 만드는 중이면 프로파일이 하나여도 머리와 프로파일 줄을 남긴다(DD3)', async () => {
    mount('/chat', GROUPS([{ pod: 'e', configured: true, name: '새 것', state: 'ok', primary: 'main', primary_ready: false, agents: [{ name: 'default' }], sessions: [] }]));
    expect(await screen.findByRole('button', { name: /새 것/, expanded: true })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^새 것의 default 와 대화/ })).toBeInTheDocument();
  });

  it('이름이 없는 묶음은 머리에 id 대신 주 프로파일 이름(DD14), 묶음 머리 이름은 줄 제목과 같은 13px(DD2)', async () => {
    mount('/chat', GROUPS([{ pod: 'aas-agent-x-1a2b', configured: true, name: '', primary: 'main', agents: [{ name: 'main' }, { name: 'ops' }], sessions: [] }]));
    await screen.findByRole('button', { name: /마케팅 도우미/, expanded: true });
    expect(screen.queryByText('aas-agent-x-1a2b')).not.toBeInTheDocument();
    const head = screen.getByRole('button', { name: /^main/, expanded: true });
    expect(within(head).getByText('main')).toHaveStyle({ fontSize: '13px' });
  });

  it('준비가 끝나 머리가 사라지면 머리에 있던 키보드 포커스를 그 에이전트 줄로 옮긴다(DD4)', async () => {
    let n = 0;
    const e = (ready: boolean) => ({ pod: 'e', configured: true, name: '새 것', state: 'ok', primary: 'main', primary_ready: ready, agents: [{ name: ready ? 'main' : 'default' }], sessions: [] });
    mount('/chat', () => (n++ === 0 ? GROUPS([e(false)]) : GROUPS([e(true)])));
    const head = await screen.findByRole('button', { name: /새 것/, expanded: true });
    act(() => head.focus());
    await act(async () => {
      await store.refresh(); // 15초마다·창으로 돌아올 때 다시 읽는 것과 같다
    });
    await waitFor(() => expect(screen.queryByRole('button', { name: /새 것/, expanded: true })).not.toBeInTheDocument());
    await waitFor(() => expect(document.activeElement).toHaveAttribute('data-chat-row', 'e'));
  });

  it('묶음을 읽기 전에는 「에이전트가 없습니다」를 보이지 않는다(DD5 — 화면 전체가 읽는 중이라 이미 지켜진다)', () => {
    mount('/chat', GROUPS());
    expect(screen.queryByText(/일치하는 AI 에이전트 작업공간이 없습니다/)).not.toBeInTheDocument();
  });

  it('묶음이 하나이고 프로파일도 하나면 에이전트 이름 줄, 「지금 에이전트」는 붙이지 않고 이름으로 찾는다(DD13·C2)', async () => {
    const user = userEvent.setup();
    mount('/chat', { pod: 'a', groups: [{ pod: 'a', current: true, configured: true, name: '관리자 AAS', primary: 'main', agents: [{ name: 'main' }], sessions: [] }] });
    const row = await screen.findByRole('button', { name: /^관리자 AAS 와 대화/ });
    expect(row).not.toHaveTextContent('지금 AI 에이전트 작업공간');
    await user.type(screen.getByRole('searchbox', { name: 'AI 에이전트 찾기' }), '관리자');
    expect(screen.getByRole('button', { name: /^관리자 AAS 와 대화/ })).toBeInTheDocument();
  });

  // 팀 관리자(스펙 2026-10-22-001 DD2·DD5·DD11): 묶음 이름은 그대로, 머리에 「내 팀」, 입력 칸 위 대상 상태 줄
  const TEAM = (over: Record<string, unknown> = {}) => ({
    pod: 't',
    shared: true,
    team: true,
    owner_name: '박팀원',
    configured: true,
    name: '영업 도우미',
    primary: 'main',
    agents: [{ name: 'main' }, { name: 'plan', title: '기획 담당' }],
    sessions: [],
    ...over,
  });

  it('팀원 에이전트 묶음: 이름은 「에이전트 · 주인」 그대로이고 머리에 「내 팀」 배지가 있다', async () => {
    mount('/chat', GROUPS([TEAM()]));
    const head = await screen.findByRole('button', { name: /영업 도우미/, expanded: true });
    expect(head).toHaveTextContent('영업 도우미· 박팀원');
    expect(within(head).getByText('내 팀')).toBeInTheDocument();
    expect(within(screen.getByRole('button', { name: /마케팅 도우미/, expanded: true })).queryByText('내 팀')).toBeNull();
  });

  it('지금 에이전트가 팀원 것이어도(shared 거짓) 묶음 이름에 주인이 남는다', async () => {
    mount('/chat', { pod: 't', groups: [GROUPS().groups[0], TEAM({ current: true, shared: false })] });
    const head = await screen.findByRole('button', { name: /영업 도우미/, expanded: true });
    expect(head).toHaveTextContent('· 박팀원');
    expect(within(head).getByText('내 팀')).toBeInTheDocument();
  });

  it('프로파일이 하나인 팀원 에이전트 줄에도 「내 팀」이 있다', async () => {
    mount('/chat', GROUPS([TEAM({ agents: [{ name: 'main' }] })]));
    const row = await screen.findByRole('button', { name: /^영업 도우미 와 대화/ });
    expect(within(row).getByText('내 팀')).toBeInTheDocument();
  });

  it('팀원 에이전트와 대화할 때만 입력 칸 위에 「<주인>의 에이전트에게 보냅니다」 상태 줄이 있다', async () => {
    const user = userEvent.setup();
    mount('/chat', GROUPS([TEAM()]));
    await user.click(await screen.findByRole('button', { name: /^영업 도우미의 main 와 대화/ }));
    await screen.findByRole('textbox', { name: /보낼 메시지/ });
    const row = await screen.findByText('박팀원의 AI 에이전트에게 보냅니다');
    expect(row.closest('[role="status"]')).not.toBeNull();
    await user.click(screen.getByRole('button', { name: /^마케팅 도우미의 main 와 대화/ }));
    await waitFor(() => expect(screen.queryByText('박팀원의 AI 에이전트에게 보냅니다')).toBeNull());
  });

  it('묶음마다 상태: 연결 없음은 다시 시도, 멈춤은 에이전트 화면 링크, main 준비 중은 안내', async () => {
    mount(
      '/chat',
      GROUPS([
        { pod: 'c', configured: false, name: '끊긴 것', state: 'error', agents: [], sessions: [] },
        { pod: 'd', configured: false, name: '멈춘 것', state: 'stopped', agents: [], sessions: [] },
        { pod: 'e', configured: true, name: '새 것', state: 'ok', primary: 'main', primary_ready: false, agents: [], sessions: [] },
      ])
    );
    const c = await screen.findByRole('group', { name: /끊긴 것/ });
    expect(within(c).getByText('연결 없음')).toBeInTheDocument();
    expect(within(c).getByRole('button', { name: '다시 시도' })).toBeInTheDocument();
    expect(within(screen.getByRole('group', { name: /멈춘 것/ })).getByRole('link', { name: 'AI 에이전트 작업공간 화면에서 다시 시작' })).toHaveAttribute('href', '/agents');
    expect(within(screen.getByRole('group', { name: /새 것/ })).getByRole('status')).toHaveTextContent('주 프로파일(main)을 만들고 있습니다');
  });
});


// 말로 입력(스펙 2026-10-22-005 §3-10-1·§8-6): 채팅 화면의 막힘과 대화 바꾸기
describe('Chat: 말로 입력', () => {
  let m: FakeMedia;
  beforeEach(() => {
    m = installFakeMedia();
  });
  afterEach(() => {
    act(() => resetVoice());
    uninstallFakeMedia();
  });
  const openWith = async (over: Record<string, unknown>) => {
    const user = userEvent.setup();
    const fn = mount('/chat', STATUS(over));
    await user.click(await screen.findByRole('button', { name: /^마케팅 와 대화/ }));
    await screen.findByRole('textbox', { name: /에게 보낼 메시지/ });
    return { user, fn };
  };

  it('connected:false 라도 error 가 없으면 마이크를 막지 않는다(connected 는 채팅 웹소켓이 열려 있는지일 뿐)', async () => {
    await openWith({ stt: true, connected: false });
    const b = await screen.findByRole('button', { name: '말로 입력' });
    expect(b).not.toHaveAttribute('aria-disabled');
  });

  it('상태에 error 가 있으면 막고, 막힌 마이크를 누르면 상태를 다시 읽는다(M3)', async () => {
    const { fn } = await openWith({ stt: true, error: 'AI 에이전트 작업공간에 연결할 수 없습니다' });
    const b = await screen.findByRole('button', { name: '말로 입력' });
    expect(b).toHaveAttribute('aria-disabled', 'true');
    const reads = () => fn.mock.calls.filter((c) => String(c[0]).startsWith('/api/chat/status')).length;
    const before = reads();
    fireEvent.click(b);
    await waitFor(() => expect(reads()).toBeGreaterThan(before));
    expect(m.getUserMedia).not.toHaveBeenCalled();
  });

  it('같은 프로파일에서 새 대화로 바꾸면 녹음을 버린다(21A)', async () => {
    const { user, fn } = await openWith({ stt: true });
    fireEvent.click(await screen.findByRole('button', { name: '말로 입력' }));
    await screen.findByText('0:00 / 1:00');
    await user.click(screen.getByRole('button', { name: /새 대화 시작/ }));
    await waitFor(() => expect(postedTo(fn, '/api/chat/session')).toHaveLength(2));
    await waitFor(() => expect(screen.queryByText('0:00 / 1:00')).toBeNull());
    expect(m.tracks[0].stop).toHaveBeenCalled();
    expect(postedTo(fn, '/api/chat/transcribe')).toHaveLength(0);
  });
});

// 스펙 2026-10-28-014 §4-2: 채팅 주소가 원본이다(D4). 고르면 주소가 바뀌고, 주소로 들어오면 같은 대화가 열린다
describe('Chat — 딥 링크', () => {
  const GROUPS = {
    pod: 'a',
    groups: [
      { pod: 'a', current: true, configured: true, name: '관리자 AAS', primary: 'main', agents: [{ name: 'main' }], sessions: [] },
      { pod: 'b', configured: true, name: '마케팅 도우미', primary: 'main', agents: [{ name: 'main' }, { name: 'plan', title: '기획 담당' }], sessions: [] },
    ],
  };
  /** 브라우저 뒤로가기 */
  function Back() {
    const nav = useNavigate();
    return (
      <button type="button" onClick={() => nav(-1)}>
        브라우저 뒤로
      </button>
    );
  }
  const loc = () => screen.getByTestId('loc');
  const sessionFor = (id: string) => FakeES.all.findIndex((e) => e.url.includes(`session_id=${id}`));

  beforeEach(() => {
    try {
      localStorage.removeItem('aas-chat-collapsed');
    } catch {
      /* 저장소 없음 */
    }
  });

  it('에이전트를 누르면 주소에 agent·pod 가 생기고(push), 대화가 저장되면 session 이 replace 로 붙는다. 뒤로가기는 앞 에이전트로 돌아간다', async () => {
    const user = userEvent.setup();
    mount('/chat', GROUPS, undefined, <Back />);
    await user.click(await screen.findByRole('button', { name: /^관리자 AAS 와 대화/ }));
    await waitFor(() => expect(loc()).toHaveTextContent(/^\/chat\?agent=main&pod=a$/));
    await screen.findByRole('textbox', { name: /^관리자 AAS 에게 보낼 메시지/ });
    await user.click(screen.getByRole('button', { name: /^마케팅 도우미의 기획 담당 와 대화/ }));
    await waitFor(() => expect(loc()).toHaveTextContent(/^\/chat\?agent=plan&pod=b$/));
    await waitFor(() => expect(store.profile).toBe('plan'));
    await user.type(await screen.findByRole('textbox', { name: /기획 담당 에게 보낼 메시지/ }), '안녕{Enter}');
    await waitFor(() => expect(sessionFor('s-plan')).toBeGreaterThanOrEqual(0));
    await emit(sessionFor('s-plan'), 'session.title', { session_id: 'st-9', title: '기획' });
    await waitFor(() => expect(loc()).toHaveTextContent(/^\/chat\?agent=plan&pod=b&session=st-9$/));
    // session 이 replace 였으므로 뒤로가기 한 번에 앞 에이전트(a 의 main)로 간다
    await user.click(screen.getByRole('button', { name: '브라우저 뒤로' }));
    await waitFor(() => expect(loc()).toHaveTextContent(/^\/chat\?agent=main&pod=a$/));
    await waitFor(() => expect(store.status?.pod).toBe('a'));
    expect(store.profile).toBe('main');
    expect(await screen.findByRole('textbox', { name: /^관리자 AAS 에게 보낼 메시지/ })).toBeInTheDocument();
  });

  it('최근 대화가 있어도 session 링크로 들어오면 그 대화를 열고, 주소의 session 을 바꾸지 않는다(외부 검토 C1)', async () => {
    extraHistory = [{ id: 'recent', source: 'aas', title: '최근', started_at: 1760000400, message_count: 2 }];
    const fn = mount('/chat?agent=plan&pod=b&session=y', GROUPS);
    await waitFor(() => expect(store.current()?.id).toBe('r-y'));
    expect(postedTo(fn, '/api/chat/resume')).toEqual([{ profile: 'plan', stored_id: 'y', pod: 'b' }]);
    expect(store.status?.pod).toBe('b');
    expect(loc()).toHaveTextContent(/^\/chat\?agent=plan&pod=b&session=y$/);
  });

  it('채팅 화면이 떠 있는 동안 팝업이 store 를 다른 에이전트로 바꿔도 되돌리지 않고, 그 대화의 id 를 주소에 쓰지 않는다(D4·외부 검토 H1)', async () => {
    mount('/chat?agent=main&pod=a', GROUPS);
    await screen.findByRole('textbox', { name: /^관리자 AAS 에게 보낼 메시지/ });
    // 떠 있는 채팅 팝업의 openChat 이 부르는 것과 같다(lib/chatPopup.ts)
    await act(async () => {
      await store.openAgent('plan', 'b');
      await store.send('팝업에서');
    });
    await emit(sessionFor('s-plan'), 'session.title', { session_id: 'st-p', title: '팝업' });
    expect(store.profile).toBe('plan');
    expect(store.status?.pod).toBe('b');
    expect(loc()).toHaveTextContent(/^\/chat\?agent=main&pod=a$/);
  });

  it('볼 수 없는 POD·그 묶음에 없는 이름의 링크는 열지 않고 안내한 뒤 값을 지운다(D5·외부 검토 M5)', async () => {
    const spy = vi.spyOn(store, 'openAgent');
    const fn = mount('/chat?agent=main&pod=zz&session=y', GROUPS);
    expect(await screen.findByText('링크의 AI 에이전트 작업공간을 볼 수 없어 대화를 열지 않았습니다.')).toBeInTheDocument();
    await waitFor(() => expect(loc()).toHaveTextContent(/^\/chat$/));
    expect(spy).not.toHaveBeenCalled();
    expect(store.profile).toBe('');
    expect(postedTo(fn, '/api/chat/resume')).toEqual([]);
    spy.mockRestore();
  });

  it('그 묶음에 없는 이름이면 주 에이전트로 바꿔 열지 않는다(외부 검토 M5)', async () => {
    const spy = vi.spyOn(store, 'openAgent');
    mount('/chat?agent=ghost&pod=b&text=' + encodeURIComponent('안녕'), GROUPS);
    expect(await screen.findByText('링크의 ghost 이(가) 이 AI 에이전트 작업공간에 없어 대화를 열지 않았습니다.')).toBeInTheDocument();
    await waitFor(() => expect(loc()).toHaveTextContent(/^\/chat$/));
    expect(spy).not.toHaveBeenCalled();
    expect(store.profile).toBe('');
    spy.mockRestore();
  });

  it('?text= 는 처리한 뒤 주소에서 사라지고 입력창의 글은 남는다. 새 대화는 주소의 pod 에서 연다(외부 검토 H2)', async () => {
    const fn = mount('/chat?agent=plan&pod=b&text=' + encodeURIComponent('설명해 줘'), GROUPS);
    await waitFor(() => expect(loc()).toHaveTextContent(/^\/chat\?agent=plan&pod=b$/));
    await waitFor(() => expect(input()).toHaveValue('설명해 줘'));
    expect(postedTo(fn, '/api/chat/session')).toEqual([{ profile: 'plan', pod: 'b' }]);
    expect(postedTo(fn, '/api/chat/send')).toEqual([]);
  });

  it('pod 없는 옛 링크의 ?text= 도 처리 뒤 사라진다', async () => {
    mount('/chat?agent=ma&text=' + encodeURIComponent('이 스킬을 설명해 줘'));
    await waitFor(() => expect(loc()).toHaveTextContent(/^\/chat\?agent=ma$/));
    expect(input()).toHaveValue('이 스킬을 설명해 줘');
  });

  it('링크의 대화를 열지 못하면 안내하고 session 을 지운다. 다른 대화를 대신 잇지 않는다', async () => {
    extraHistory = [{ id: 'recent', source: 'aas', title: '최근', started_at: 1760000400, message_count: 2 }];
    const fn = mount('/chat?agent=plan&pod=b&session=gone', GROUPS);
    expect(await screen.findByText('링크의 대화를 열지 못했습니다: 없는 대화')).toBeInTheDocument();
    await waitFor(() => expect(loc()).toHaveTextContent(/^\/chat\?agent=plan&pod=b$/));
    expect(postedTo(fn, '/api/chat/resume')).toEqual([{ profile: 'plan', stored_id: 'gone', pod: 'b' }]);
    expect(store.current()).toBeNull();
  });

  it('휴대폰 뒤로 단추는 주소에서 agent·pod·session 을 지워 목록으로 돌아가고(push), 브라우저 뒤로가기로 다시 열린다(외부 검토 M3)', async () => {
    const user = userEvent.setup();
    mount('/chat?agent=plan&pod=b', GROUPS, undefined, <Back />);
    await screen.findByRole('textbox', { name: /기획 담당 에게 보낼 메시지/ });
    await user.click(screen.getByRole('button', { name: 'AI 에이전트 목록으로' }));
    await waitFor(() => expect(loc()).toHaveTextContent(/^\/chat$/));
    expect(await screen.findByText('왼쪽에서 세션을 고르거나 「새 세션」을 시작하세요.')).toBeInTheDocument();
    expect(store.profile).toBe('');
    await user.click(screen.getByRole('button', { name: '브라우저 뒤로' }));
    await waitFor(() => expect(loc()).toHaveTextContent(/^\/chat\?agent=plan&pod=b$/));
    expect(await screen.findByRole('textbox', { name: /기획 담당 에게 보낼 메시지/ })).toBeInTheDocument();
  });

  it('주소와 같은 에이전트를 다시 누르면 주소를 바꾸지 않고 그 에이전트로 새 세션을 연다(외부 검토 M3)', async () => {
    const user = userEvent.setup();
    mount('/chat?agent=plan&pod=b', GROUPS);
    await screen.findByRole('textbox', { name: /기획 담당 에게 보낼 메시지/ });
    const spy = vi.spyOn(store, 'startNew');
    await user.click(screen.getByRole('button', { name: /^마케팅 도우미의 기획 담당 와 대화/ }));
    expect(spy).toHaveBeenCalledWith('plan', 'b');
    expect(loc()).toHaveTextContent(/^\/chat\?agent=plan&pod=b$/);
    spy.mockRestore();
  });

  // 사용자 결정 D14(2026-10-29): 셸(AppShell)이 올리는 링크 전환 확인(LinkPodSwitch)은 채팅 주소의 pod 로 묻지 않는다 — 채팅이 묶음으로 연다
  const ME_AB = { auth_enabled: true, admin: false, user: { email: 'kim@x' }, pod: { id: 'a', owner: 'kim@x' }, pods: [{ id: 'a', owner: 'kim@x' }, { id: 'b', owner: 'lee@x', name: '마케팅 도우미' }] } as unknown as Me;
  const askPod = () => screen.queryByText('AI 에이전트 작업공간을 바꿀까요?');

  it('다른 묶음의 에이전트를 눌러도 작업공간 전환 확인이 뜨지 않고 그 묶음의 대화가 열린다(D14)', async () => {
    const user = userEvent.setup();
    mount('/chat', GROUPS, undefined, <LinkPodSwitch me={ME_AB} />);
    await user.click(await screen.findByRole('button', { name: /^마케팅 도우미의 기획 담당 와 대화/ }));
    await waitFor(() => expect(loc()).toHaveTextContent(/^\/chat\?agent=plan&pod=b$/));
    await screen.findByRole('textbox', { name: /기획 담당 에게 보낼 메시지/ });
    expect(store.status?.pod).toBe('b');
    expect(askPod()).toBeNull();
  });

  it('다른 묶음의 채팅 링크로 들어와도 작업공간 전환 확인이 뜨지 않고 그 대화가 열린다(D14)', async () => {
    const fn = mount('/chat?agent=plan&pod=b&session=y', GROUPS, undefined, <LinkPodSwitch me={ME_AB} />);
    await waitFor(() => expect(store.current()?.id).toBe('r-y'));
    expect(postedTo(fn, '/api/chat/resume')).toEqual([{ profile: 'plan', stored_id: 'y', pod: 'b' }]);
    expect(loc()).toHaveTextContent(/^\/chat\?agent=plan&pod=b&session=y$/);
    expect(askPod()).toBeNull();
  });

  // 2단계 T7: 「지난 대화」·「파일」 서랍은 주소 panel 과 묶인다. 서랍은 주소의 agent·pod 대화에 딸린다
  const FILES = { ...GROUPS, groups: GROUPS.groups.map((g) => ({ ...g, files: true })) };
  const dialog = (name: string) => screen.findByRole('dialog', { name });

  it('「지난 대화」 단추는 panel=past 를 쌓고(push), 닫으면 그 칸을 되감는다. 뒤로가기 한 번이면 목록 주소로 간다', async () => {
    const user = userEvent.setup();
    mount('/chat', GROUPS, undefined, <Back />);
    await user.click(await screen.findByRole('button', { name: /^마케팅 도우미의 기획 담당 와 대화/ }));
    await screen.findByRole('textbox', { name: /기획 담당 에게 보낼 메시지/ });
    await user.click(screen.getByRole('button', { name: /지난 대화 보기/ }));
    await waitFor(() => expect(loc()).toHaveTextContent(/^\/chat\?agent=plan&pod=b&panel=past$/));
    const dlg = await dialog('지난 대화');
    await user.click(within(dlg).getByRole('button', { name: '닫기' }));
    await waitFor(() => expect(loc()).toHaveTextContent(/^\/chat\?agent=plan&pod=b$/));
    expect(screen.queryByRole('dialog')).toBeNull();
    // 닫기가 칸을 되감았으므로 뒤로가기 한 번에 에이전트를 고르기 전 주소다
    await user.click(screen.getByRole('button', { name: '브라우저 뒤로' }));
    await waitFor(() => expect(loc()).toHaveTextContent(/^\/chat$/));
  });

  it('브라우저 뒤로가기는 서랍을 닫고, 대화는 그대로다', async () => {
    const user = userEvent.setup();
    mount('/chat?agent=plan&pod=b', FILES, undefined, <Back />);
    await screen.findByRole('textbox', { name: /기획 담당 에게 보낼 메시지/ });
    await user.click(screen.getByRole('button', { name: '파일' }));
    await waitFor(() => expect(loc()).toHaveTextContent(/^\/chat\?agent=plan&pod=b&panel=files$/));
    await dialog('파일');
    fireEvent.click(screen.getByRole('button', { name: '브라우저 뒤로', hidden: true })); // 서랍이 떠 있는 동안 뒤 화면은 가려진다
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(loc()).toHaveTextContent(/^\/chat\?agent=plan&pod=b$/);
    expect(store.profile).toBe('plan');
  });

  it('?agent=&pod=&panel=files 로 들어오면 그 대화를 열고 그 대화의 파일 서랍을 연다. 에이전트를 바꾸면 panel 이 사라진다', async () => {
    const user = userEvent.setup();
    mount('/chat?agent=plan&pod=b&panel=files', FILES);
    const dlg = await dialog('파일');
    expect(within(dlg).getByText(/기획 담당/)).toBeInTheDocument(); // 부제: 그 대화의 대상
    expect(store.profile).toBe('plan');
    expect(store.status?.pod).toBe('b');
    await user.click(screen.getByRole('button', { name: /^관리자 AAS 와 대화/, hidden: true }));
    await waitFor(() => expect(loc()).toHaveTextContent(/^\/chat\?agent=main&pod=a$/));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('지난 대화를 고르면 panel 만 지우고 고른 대화의 session 을 쓴다(되감으면 앞 대화로 돌아간다)', async () => {
    const user = userEvent.setup();
    const fn = mount('/chat?agent=plan&pod=b&panel=past', GROUPS);
    const dlg = await dialog('지난 대화');
    await user.click(await within(dlg).findByRole('button', { name: /텔레그램 대화/ }));
    await waitFor(() => expect(loc()).toHaveTextContent(/^\/chat\?agent=plan&pod=b&session=h1$/));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(postedTo(fn, '/api/chat/resume')).toEqual([expect.objectContaining({ stored_id: 'h1' })]);
    expect(store.current()?.id).toBe('r-h1');
  });

  it('새 대화를 시작한 뒤 서랍을 여닫아도 주소의 앞 대화로 되돌아가지 않는다', async () => {
    const user = userEvent.setup();
    const fn = mount('/chat?agent=plan&pod=b&session=y', GROUPS);
    await waitFor(() => expect(store.current()?.id).toBe('r-y'));
    await user.click(await screen.findByRole('button', { name: /새 대화 시작/ }));
    await waitFor(() => expect(postedTo(fn, '/api/chat/session')).toHaveLength(1));
    await user.click(screen.getByRole('button', { name: /지난 대화 보기/ }));
    await user.click(within(await dialog('지난 대화')).getByRole('button', { name: '닫기' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(postedTo(fn, '/api/chat/resume')).toHaveLength(1); // 링크로 들어올 때 한 번뿐
    expect(store.current()?.id).toBe('s-plan');
  });

  it('에이전트가 없는 주소의 panel 은 지운다', async () => {
    mount('/chat?panel=past', GROUPS);
    await waitFor(() => expect(loc()).toHaveTextContent(/^\/chat$/));
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

// 답 「읽어 주기」(스펙 2026-10-28-012 §3-9·§7-1): tts 값에 따른 단추, 대화 상대 에이전트·프로파일로 읽기, 쓰는 중 막기, 다른 대화로 바꾸면 멈춤
describe('Chat: 읽어 주기', () => {
  beforeEach(() =>
    resetReadAloud({
      makeAudio: () => ({ src: '', onended: null, onerror: null, play: () => Promise.resolve(), pause: () => undefined }),
      createUrl: () => 'blob:x',
      revokeUrl: () => undefined,
    })
  );
  afterEach(() => act(() => resetReadAloud()));
  const openWith = async (over: Record<string, unknown>) => {
    const user = userEvent.setup();
    const fn = mount('/chat', STATUS(over));
    await user.click(await screen.findByRole('button', { name: /^마케팅 와 대화/ }));
    await screen.findByRole('textbox', { name: /에게 보낼 메시지/ });
    await user.type(input(), '안녕{Enter}');
    await waitFor(() => expect(FakeES.all).toHaveLength(1));
    return { user, fn };
  };

  it('tts:false 면 답 아래에 [복사]만 있고 [읽어 주기]가 없다', async () => {
    await openWith({ tts: false });
    await emit(0, 'aas.user', { text: '안녕' });
    await emit(0, 'message.complete', { text: '반가워요' });
    expect(screen.getByRole('button', { name: '답변 복사' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '읽어 주기' })).toBeNull();
  });

  it('tts:true 면 [읽어 주기]가 있고, 쓰는 중에는 막고, 끝난 답은 대화 상대 프로파일로 읽는다. 다른 대화로 바꾸면 멈춘다', async () => {
    const { user, fn } = await openWith({ tts: true, tts_voices: [{ id: 'v1', name: 'v1', gender: 'female' }] });
    await emit(0, 'aas.user', { text: '안녕' });
    await emit(0, 'message.start');
    await emit(0, 'message.delta', { text: '반가' });
    expect(screen.getByRole('button', { name: '읽어 주기' })).toHaveAttribute('aria-disabled', 'true');
    await emit(0, 'message.delta', { text: '워요' });
    await emit(0, 'message.complete', { text: '반가워요' });
    const btn = screen.getByRole('button', { name: '읽어 주기' });
    expect(btn).not.toHaveAttribute('aria-disabled');
    fireEvent.click(btn);
    await waitFor(() => expect(postedTo(fn, '/api/chat/speak')).toHaveLength(1));
    expect(postedTo(fn, '/api/chat/speak')[0]).toMatchObject({ profile: 'ma', text: '반가워요', voice: 'v1', part: 0 });
    expect(readAloud.snap.phase).not.toBe('idle');
    await user.click(screen.getByRole('button', { name: /^Zed 와 대화/ }));
    await waitFor(() => expect(readAloud.snap.phase).toBe('idle'));
  });
});

describe('Chat — 세션 목록', () => {
  it('「새 세션」은 AI 에이전트 찾기 칸으로 포커스를 옮긴다', async () => {
    const user = userEvent.setup();
    mount();
    await user.click(await screen.findByRole('button', { name: /골라 새 세션을 시작/ }));
    expect(document.activeElement).toBe(screen.getByRole('searchbox', { name: /에이전트/ }));
  });
});

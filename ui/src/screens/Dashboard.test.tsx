/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 대시보드(계획 2026-10-14-014). 첫 describe 의 시험은 예전 홈(Home.test.tsx)을 옮긴 것이다 — 「지금 정보 유지」(D1) 회귀 계약.
import { fireEvent, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { newSession } from '@/lib/chat';
import { chatStore } from '@/lib/chatStore';
import { Dashboard as DashboardData } from '@/lib/dashboard';
import { guideRunState, resetGuideRunForTest, setGuideUser } from '@/lib/guideRun';
import { ME_ADMIN, ME_USER, mountScreen, postedTo, stubApi } from '@/test/mountScreen';

import { Dashboard } from './Dashboard';

// jsdom 에서는 캔버스 그래프를 그리지 않는다. 그래프 자리에 제목만 남긴다
vi.mock('./dashboard/TrendCharts', () => ({
  default: ({ specs }: { specs: { title: string }[] }) => <div data-testid="charts">{specs.map((s) => s.title).join(',')}</div>,
}));

const failed = (n: number, muted = false) =>
  Array.from({ length: n }, (_, i) => ({
    job: `nightly${i}`,
    job_id: `j${i}`,
    profile: 'ma',
    error: '타임아웃\n발생',
    streak: 3,
    muted,
  }));

const HEALTH = (over = {}) => ({
  collected_at: '2026-10-10T14:00:00+09:00',
  totals: { jobs_active: 7, jobs: 9, failed_jobs: 2, stalled: 1, settled_incidents: 2, silent: 1, muted_jobs: 3 },
  failed_jobs: [...failed(2), { job: 'quiet', job_id: 'q', profile: 'ma', error: 'x', streak: 9, muted: true }],
  stalled: [{ job: 'slowpoke', job_id: 's1', profile: 'ops', kind: '지연', cause: '락 대기', hours: 5.6 }],
  ...over,
});
const PROFILES = {
  profiles: [
    {
      name: 'ma',
      title: '마케팅',
      running: false,
      issues: [
        { level: 'bad', text: '게이트웨이가 꺼져 있음', from: '채널' },
        { level: 'bad', text: '크론 오류', from: '크론' },
      ],
    },
    { name: 'ops', running: true, issues: [] },
  ],
};
const CREDS = {
  totals: {},
  items: [
    {
      name: 'OPENAI',
      scope: '프로파일',
      profile: 'ma',
      location: '/d/.env',
      expires: '2026-09-30T00:00:00Z',
      flags: ['만료됨'],
    },
    {
      name: 'OLD_BAK',
      scope: '전역',
      location: '/d/.env.bak',
      expires: '2026-01-01T00:00:00Z',
      flags: ['만료됨', '백업 파일'],
    },
    { name: 'FINE', scope: '전역', location: '/d/.env', flags: [] },
  ],
};
const CHANGES = {
  rows: [
    { ts: '2026-10-10T10:00:00+09:00', group: '크론', kind: 'cron_update', failed: false, who: 'kim', what: '크론 수정', detail: 'ma/abc' },
    { ts: '2026-10-10T09:00:00+09:00', group: '접속', kind: 'login', failed: false, what: '로그인' },
  ],
};

afterEach(() => vi.unstubAllGlobals());

const ME_A = { ...ME_ADMIN, pod: { id: 'a', owner: '*' }, pods: [{ id: 'a', owner: '*' }] };
const USAGE = { totals: { sessions: 12, messages: 340, input_tokens: 25000, output_tokens: 900 } };
const VALUES = { profiles: 3, gateways_up: 2, profiles_bad: 0, creds_expiring: 0, jobs: 4, jobs_active: 3, failed_jobs: 0, stalled_jobs: 0, open_incidents: 0 };
const pod = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  owner: id + '@x.com',
  owner_me: false,
  ready: true,
  phase: 'Ready',
  collected: true,
  ok: true,
  reason: '',
  ts: '2026-10-14T09:00:00+09:00',
  checked: '2026-10-14T09:00:00+09:00',
  stale: false,
  values: VALUES,
  last_day: '2026-10-13',
  ...over,
});
const DASH = (over: Partial<DashboardData> = {}): DashboardData =>
  ({
    admin: true,
    now: '2026-10-14T09:10:00+09:00',
    next_collect: '2026-10-14T09:30+09:00',
    collected_at: '2026-10-14T09:00:00+09:00',
    pods: [
      pod('a'),
      pod('b', { values: { ...VALUES, failed_jobs: 2, stalled_jobs: 1, profiles_bad: 1 } }),
      pod('c', { ok: false, reason: '시간 초과', ts: '2026-10-14T06:00:00+09:00' }),
      pod('d', { ready: false, phase: 'Pending', collected: false, values: null, ts: null, checked: null, last_day: null }),
    ],
    totals: { agents_ready: 3, agents_total: 4, failed_stalled: 3, profiles_bad: 1, creds_expiring: 0, counted: 2, countable: 3, failed: 1 },
    trend: [
      { day: '2026-10-12', runs_7d: 40, failed_jobs: 1, stalled: 0, open_incidents: 2, collect_errors: 0 },
      { day: '2026-10-13', runs_7d: 42, failed_jobs: 3, stalled: 1, open_incidents: 3, collect_errors: 1 },
    ],
    usage: [{ day: '2026-10-13', sessions: 5, messages: 9, input_tokens: 100, output_tokens: 20 }],
    ops: { users: 4, last_login: '2026-10-14T08:00:00+09:00', litellm: { reachable: true }, market: null, collect: null },
    ...over,
  }) as DashboardData;

function mount(
  health: unknown = HEALTH(),
  profiles: unknown = PROFILES,
  creds: unknown = CREDS,
  changes: unknown = CHANGES,
  extra: Record<string, unknown> = {}
) {
  const fn = stubApi({
    '/api/me': ME_A,
    '/api/health': health,
    '/api/profiles': profiles,
    '/api/credentials': creds,
    '/api/changes': changes,
    '/api/activity': USAGE,
    '/api/dashboard': DASH(),
    ...extra,
  });
  mountScreen(<Dashboard />, '/dashboard');
  return fn;
}

/** 「지금 에이전트」 구역 */
const current = async () => (await screen.findByRole('heading', { name: /지금 AI 에이전트 작업공간: a/ })).closest('section')!;


describe('대시보드 › 지금 에이전트(예전 홈)', () => {
  it('제목과 수집 시각, 숫자 네 개', async () => {
    mount();
    expect(await screen.findByText(/지금 AI 에이전트 작업공간 2026-10-10 14:00/)).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1, name: '대시보드' })).toBeInTheDocument();
    const sec = await current();
    expect(await within(sec).findByText('1/2')).toBeInTheDocument(); // 게이트웨이가 도는 프로파일
    expect(within(sec).getByRole('button', { name: /활성 예약 작업/ })).toHaveTextContent('7');
    expect(within(sec).getByText('전체 9개')).toBeInTheDocument();
    expect(within(sec).getByRole('button', { name: /실패했거나 멈춘 작업/ })).toHaveTextContent('3');
    await within(sec).findByText('백업 파일 제외');
    expect(within(sec).getByRole('button', { name: /만료됐거나 곧 만료되는 API 키·토큰/ })).toHaveTextContent('1'); // 백업은 뺀다
  });

  it('실패 작업 블록은 무시한 작업을 빼고 줄 안의 오류는 한 줄로 줄여 보이며, 누르면 크론 화면으로 간다', async () => {
    const user = userEvent.setup();
    mount();
    const block = (await screen.findByRole('heading', { name: /지금도 실패 중인 작업/ })).closest('section')!;
    expect(within(block).getByRole('heading')).toHaveTextContent('2');
    expect(within(block).getAllByText('ma · 타임아웃 발생')).toHaveLength(2);
    expect(within(block).getAllByText('연속 3회')).toHaveLength(2);
    expect(within(block).queryByText('quiet')).not.toBeInTheDocument();
    await user.click(within(block).getByRole('button', { name: /nightly0/ }));
    expect(screen.getByTestId('loc')).toHaveTextContent('/cron?tab=failed_jobs&open=ma%2Fj0');
  });

  it('5개를 넘으면 N개 더 보기가 크론 화면으로 잇는다', async () => {
    const user = userEvent.setup();
    mount(HEALTH({ failed_jobs: failed(8) }));
    await user.click(await screen.findByRole('button', { name: '3개 더 보기' }));
    expect(screen.getByTestId('loc')).toHaveTextContent('/cron?tab=failed_jobs');
  });

  it('멈춘 작업은 시간을 반올림해 보이고 프로파일 문제는 크론에서 온 것을 뺀다', async () => {
    mount();
    expect(await screen.findByText('6시간')).toBeInTheDocument();
    expect(screen.getByText('ops · 지연 · 락 대기')).toBeInTheDocument();
    const block = (await screen.findByRole('heading', { name: /문제가 있는 프로파일/ })).closest('section')!;
    expect(within(block).getByText('게이트웨이가 꺼져 있음')).toBeInTheDocument();
    expect(within(block).queryByText('크론 오류')).not.toBeInTheDocument();
    expect(within(block).getByText('게이트웨이 중지됨')).toBeInTheDocument();
    expect(within(block).getByText('마케팅')).toBeInTheDocument();
  });

  it('만료 자격증명 블록은 백업 파일을 빼고 만료일을 보인다', async () => {
    mount();
    const block = (await screen.findByRole('heading', { name: /만료됐거나 곧 만료되는 API 키·토큰/ })).closest('section')!;
    expect(within(block).getByText('OPENAI')).toBeInTheDocument();
    expect(within(block).queryByText('OLD_BAK')).not.toBeInTheDocument();
    expect(within(block).getByText('2026-09-30')).toBeInTheDocument();
  });

  it('정리할 것, 최근 바꾼 것(접속 기록 제외)을 보인다', async () => {
    mount();
    expect(await screen.findByText('이미 해결된 문제 2건')).toBeInTheDocument();
    expect(screen.getByText('알림 대상이 없는 작업 1개')).toBeInTheDocument();
    expect(screen.getByText('무시한 작업 3개')).toBeInTheDocument();
    expect(await screen.findByText('크론 수정')).toBeInTheDocument();
    expect(screen.queryByText('로그인')).not.toBeInTheDocument();
  });

  it('손볼 것이 없으면 안내 문구를 보인다', async () => {
    mount(
      HEALTH({
        totals: { jobs_active: 1, jobs: 1, failed_jobs: 0, stalled: 0 },
        failed_jobs: [],
        stalled: [],
      }),
      { profiles: [{ name: 'ma', running: true, issues: [] }] },
      { totals: {}, items: [] },
      { rows: [] }
    );
    expect(await screen.findByText('지금 처리할 문제가 없습니다 · 마지막 확인 2026-10-10 14:00')).toBeInTheDocument();
  });

  it('답이나 승인을 기다리는 대화가 있으면 맨 위 블록으로 알리고 채팅으로 잇는다', async () => {
    const user = userEvent.setup();
    const S = newSession({ session_id: 'w1', profile: 'ma' });
    S.items.push({ kind: 'approval', p: { request_id: 'r' }, answered: null });
    chatStore.sessions.w1 = S;
    try {
      mount();
      const block = (await screen.findByRole('heading', { name: /답을 기다리는 대화/ })).closest('section')!;
      expect(within(block).getByRole('heading')).toHaveTextContent('1');
      await user.click(within(block).getByRole('button', { name: /AI 에이전트가 승인이나 답을 기다리고 있습니다/ }));
      expect(screen.getByTestId('loc')).toHaveTextContent('/chat');
    } finally {
      delete chatStore.sessions.w1;
    }
  });
});

describe('대시보드 › 상태와 권한', () => {
  beforeEach(() => {
    Element.prototype.scrollIntoView = vi.fn();
  });

  it('값을 못 받으면 「…」 를 끝없이 보이지 않고 「—」 와 다시 시도를 보인다(디자인 §19-4)', async () => {
    mount(HEALTH(), PROFILES, CREDS, CHANGES, {
      '/api/health': () => {
        throw new Error('끊김');
      },
    });
    const sec = await current();
    expect(await within(sec).findByRole('button', { name: '다시 시도' })).toBeInTheDocument();
    expect(within(sec).getByRole('button', { name: /활성 예약 작업/ })).toHaveTextContent('—');
    expect(sec.textContent).not.toContain('…');
  });

  it('관리자가 아니면 전체 구역이 없고, 관리자만 고칠 항목은 누를 수 없게 「관리자 조치 필요」 를 붙인다(DD7)', async () => {
    const fn = mount(HEALTH(), PROFILES, CREDS, CHANGES, { '/api/me': { ...ME_USER, pod: { id: 'a', owner: 'lee@x.com' }, pods: [], owner: false } });
    const sec = await current();
    expect(await within(sec).findByText('nightly0')).toBeInTheDocument();
    expect(screen.queryByText('전체 AI 에이전트 작업공간')).not.toBeInTheDocument();
    const failedBlock = within(sec).getByRole('heading', { name: /지금도 실패 중인 작업/ }).closest('section')!;
    expect(within(failedBlock).queryByRole('button', { name: /nightly0/ })).not.toBeInTheDocument();
    expect(within(failedBlock).getAllByText('관리자 조치 필요')).toHaveLength(2);
    expect(fn.mock.calls.some((c) => String(c[0]).startsWith('/api/dashboard'))).toBe(false);
    expect(fn.mock.calls.some((c) => String(c[0]).startsWith('/api/changes'))).toBe(false); // 주인도 관리자도 아니면 변경 기록 없음
  });

  it('주 프로파일을 만드는 중이면 준비 중 안내를 보인다', async () => {
    mount(HEALTH(), PROFILES, CREDS, CHANGES, { '/api/me': { ...ME_A, primary: { profile: 'main', ready: false } } });
    expect(await screen.findByText('AI 에이전트 작업공간을 준비하고 있습니다')).toBeInTheDocument();
  });

  it('내 사용량(7일)을 숫자 줄로 보인다', async () => {
    mount();
    const sec = await current();
    expect(await within(sec).findByRole('button', { name: /^25k\s*입력 토큰/ })).toBeInTheDocument();
    expect(within(sec).getByRole('button', { name: /^340\s*메시지/ })).toBeInTheDocument();
  });
});

describe('대시보드 › 전체 에이전트(관리자)', () => {
  beforeEach(() => {
    Element.prototype.scrollIntoView = vi.fn();
  });
  const fleet = async () => (await screen.findByRole('heading', { name: /전체 AI 에이전트 작업공간/ })).closest('section')!;
  const order = (sec: HTMLElement) => [...sec.querySelectorAll('tr[data-pod]')].map((r) => r.getAttribute('data-pod'));

  it('숫자 줄과 부분 수집 문구, 문제 수 순서의 표, 운영 정보', async () => {
    mount();
    const sec = await fleet();
    expect(await within(sec).findByRole('button', { name: /^3\/4\s*AI 에이전트 작업공간 준비/ })).toBeInTheDocument();
    expect(within(sec).getByRole('button', { name: /^3\s*실패·멈춘 작업/ })).toBeInTheDocument();
    expect(within(sec).getByText('3개 중 2개 기준 · 1개 수집 실패')).toBeInTheDocument();
    expect(order(sec)).toEqual(['b', 'c', 'a', 'd']); // 문제 수 → 수집 실패 → 이름, 준비 중은 끝
    expect(within(sec).getByText('수집 실패 · 2026-10-14 06:00 값')).toBeInTheDocument();
    expect(within(sec).getAllByText('준비 중 (Pending)')).toHaveLength(2); // 준비 열과 수집 열
    expect(within(sec).getByText(/로그인한 사용자 4명 · 최근 로그인 2026-10-14 08:00 · LiteLLM 정상/)).toBeInTheDocument();
  });

  it('준비 상태와 「지금 보는 에이전트」 는 뱃지이고, 작은 제목의 내용은 제목 글자 자리로 들어간다', async () => {
    mount();
    const sec = await fleet();
    await within(sec).findByRole('button', { name: /^3\/4\s*AI 에이전트 작업공간 준비/ });
    expect(sec.querySelectorAll('[data-pill="good"]').length).toBeGreaterThan(0);
    expect(sec.querySelectorAll('[data-pill="warn"]').length).toBeGreaterThan(0); // 준비 중 줄
    const ops = sec.querySelector('[data-ops]')!;
    expect(ops.parentElement).toHaveStyle({ paddingLeft: '24px' });
  });

  it('구역 제목과 작은 제목 앞에 아이콘이 있다', async () => {
    mount();
    const sec = await fleet();
    await within(sec).findByRole('button', { name: /^3\/4\s*AI 에이전트 작업공간 준비/ });
    // 아이콘은 글자가 아니라 SVG 이고 화면 읽기 프로그램에는 숨긴다
    const iconOf = (name: RegExp) => screen.getByRole('heading', { name }).querySelector('svg[aria-hidden="true"]');
    for (const name of [/전체 AI 에이전트 작업공간/, /지금 AI 에이전트 작업공간: a/, /AI 에이전트 작업공간별 현황/, /^추이/, /운영 정보/, /확인할 것/]) {
      expect(iconOf(name), String(name)).not.toBeNull();
    }
    // 구역마다 다른 아이콘이다
    const svgs = ['전체 AI 에이전트 작업공간', 'AI 에이전트 작업공간별 현황', '추이', '운영 정보', '확인할 것'].map((n) =>
      screen.getByRole('heading', { name: new RegExp(n) }).querySelector('svg')!.getAttribute('data-testid')
    );
    expect(new Set(svgs).size).toBe(svgs.length);
  });

  it('부분 수집 문구와 숫자를 누르면 표를 거르고, 거름을 풀 수 있다', async () => {
    const user = userEvent.setup();
    mount();
    const sec = await fleet();
    await user.click(await within(sec).findByText('3개 중 2개 기준 · 1개 수집 실패'));
    expect(order(sec)).toEqual(['c']);
    await user.click(within(sec).getByRole('button', { name: /실패·멈춘 작업/ }));
    expect(order(sec)).toEqual(['b']);
    await user.click(within(sec).getByLabelText('거름 풀기'));
    expect(order(sec)).toHaveLength(4);
  });

  it('주인 칸은 사람 이름으로 보이고 이메일은 풍선말이다(2026-10-18). 이름이 없으면 이메일', async () => {
    mount(HEALTH(), PROFILES, CREDS, CHANGES, { '/api/dashboard': DASH({ pods: [pod('a', { owner_name: '김철수' }), pod('b')] }) });
    const f = within(await fleet());
    const chip = await f.findByText('김철수');
    expect(chip.closest('[data-user-chip]')).toHaveAttribute('title', 'a@x.com');
    expect(f.queryByText('a@x.com')).toBeNull();
    expect(f.getByText('b@x.com')).toBeInTheDocument();
  });

  it('에이전트 칸은 에이전트 이름으로 보이고 id 는 풍선말이다. 이름이 없으면 id(스펙 2026-10-18-013)', async () => {
    mount(HEALTH(), PROFILES, CREDS, CHANGES, { '/api/dashboard': DASH({ pods: [pod('a', { name: 'AAS 관리자' }), pod('b')] }) });
    const f = within(await fleet());
    const chip = await f.findByText('AAS 관리자');
    expect(chip.closest('[title]')).toHaveAttribute('title', 'a');
    expect(f.queryByText('a')).toBeNull();
    expect(f.getByText('b')).toBeInTheDocument();
  });

  it('「지금 에이전트」 제목은 에이전트 이름이고, 다른 에이전트를 누르면 「지금 보는 에이전트」 뱃지와 제목이 새 에이전트로 옮겨 간다(2026-10-18)', async () => {
    const names: Record<string, string> = { a: '관리자 AAS', b: '시험계정' };
    let cur = 'a';
    const me = () => ({ ...ME_ADMIN, pod: { id: cur, owner: '*', name: names[cur] }, pods: [{ id: 'a', owner: '*', name: names.a }, { id: 'b', owner: '*', name: names.b }] });
    mount(HEALTH(), PROFILES, CREDS, CHANGES, {
      '/api/me': me,
      '/api/pod': (_u: string, b: Record<string, unknown>) => ((cur = String(b.id)), { ok: true }),
      '/api/dashboard': DASH({ pods: [pod('a', { name: '관리자 AAS' }), pod('b', { name: '시험계정' })] }),
    });
    const sec = await fleet();
    const badgeRow = () => [...sec.querySelectorAll('tr[data-pod]')].filter((r) => within(r as HTMLElement).queryByText('지금 보는 AI 에이전트 작업공간')).map((r) => r.getAttribute('data-pod'));
    await vi.waitFor(() => expect(badgeRow()).toEqual(['a']));
    expect(await screen.findByText('지금 AI 에이전트 작업공간: 관리자 AAS')).toBeInTheDocument(); // id(a)가 아니라 이름
    fireEvent.click(sec.querySelector('tr[data-pod="b"]')!);
    await vi.waitFor(() => expect(badgeRow()).toEqual(['b']));
    expect(await screen.findByText('지금 AI 에이전트 작업공간: 시험계정')).toBeInTheDocument();
  });

  it('「메신저 연결」 칸은 게이트웨이 수가 아니라 연결된 메신저 수다. 하나도 없으면 「연결 없음」, 옛 기록은 「—」(2026-10-18)', async () => {
    const v = (o: Record<string, unknown>) => ({ ...VALUES, profiles: 1, gateways_up: 1, ...o }); // 게이트웨이는 모두 실행 중(1/1)
    mount(HEALTH(), PROFILES, CREDS, CHANGES, {
      '/api/dashboard': DASH({
        pods: [
          pod('a', { values: v({ messengers_connected: 0, messengers_total: 0 }) }),
          pod('b', { values: v({ messengers_connected: 1, messengers_total: 2 }) }),
          pod('c', { values: v({ messengers_connected: null, messengers_total: null }) }),
        ],
      }),
    });
    const sec = await fleet();
    const cell = (id: string) => within(sec.querySelector(`tr[data-pod="${id}"]`) as HTMLElement);
    expect(await cell('a').findByText('연결 없음')).toBeInTheDocument();
    expect(cell('a').queryByText('1/1')).toBeNull(); // 게이트웨이 1/1 을 메신저 연결로 보이지 않는다
    expect(cell('b').getByText('1/2')).toBeInTheDocument();
    expect(cell('c').queryByText('연결 없음')).toBeNull();
    expect(cell('c').queryByText('1/1')).toBeNull();
  });

  it('1시간 넘은 값은 「n시간 전 값」 이다', async () => {
    mount(HEALTH(), PROFILES, CREDS, CHANGES, { '/api/dashboard': DASH({ pods: [pod('a', { checked: '2026-10-14T06:10:00+09:00' })] }) });
    expect(await within(await fleet()).findByText('3시간 전 값')).toBeInTheDocument();
  });

  it('다른 에이전트 줄을 누르면 /api/pod 로 바꾸고 페이지를 다시 불러오지 않고 데이터만 다시 받으며 「지금 에이전트」 구역으로 내려간다(2026-10-18). 지금 에이전트 줄은 아래 구역으로 내려간다', async () => {
    const reload = vi.fn();
    const orig = window.location;
    Object.defineProperty(window, 'location', { configurable: true, value: { ...orig, reload } });
    try {
      const fn = mount(HEALTH(), PROFILES, CREDS, CHANGES, { '/api/pod': { ok: true } });
      const sec = await fleet();
      const row = (id: string) => sec.querySelector(`tr[data-pod="${id}"]`)!;
      await within(sec).findByText('3개 중 2개 기준 · 1개 수집 실패');
      const gets = (path: string) => fn.mock.calls.filter((c) => String(c[0]).split('?')[0] === path && !(c[1] as RequestInit | undefined)?.method).length;
      fireEvent.click(row('a'));
      expect(Element.prototype.scrollIntoView).toHaveBeenCalled();
      expect(postedTo(fn, '/api/pod')).toEqual([]);
      fireEvent.click(row('d')); // 준비 중은 누를 수 없다
      expect(postedTo(fn, '/api/pod')).toEqual([]);
      const before = { me: gets('/api/me'), dash: gets('/api/dashboard'), health: gets('/api/health') };
      (Element.prototype.scrollIntoView as ReturnType<typeof vi.fn>).mockClear();
      fireEvent.keyDown(row('b'), { key: 'Enter' });
      await vi.waitFor(() => expect(postedTo(fn, '/api/pod')).toEqual([{ id: 'b' }]));
      // 전체 페이지를 다시 불러오지 않고, 보고 있는 데이터(내 정보·표·지금 에이전트)만 다시 받는다
      await vi.waitFor(() => expect([gets('/api/me') - before.me, gets('/api/dashboard') - before.dash, gets('/api/health') - before.health]).toEqual([1, 1, 1]));
      await vi.waitFor(() => expect(Element.prototype.scrollIntoView).toHaveBeenCalled());
      expect(reload).not.toHaveBeenCalled();
      expect(row('b').getAttribute('aria-busy')).not.toBe('true');
    } finally {
      Object.defineProperty(window, 'location', { configurable: true, value: orig });
    }
  });

  it('추이는 그래프 3장이고 「표로 보기」 로 같은 값을 표로 본다', async () => {
    const user = userEvent.setup();
    mount();
    const sec = await fleet();
    expect(await within(sec).findByTestId('charts')).toHaveTextContent('작업,열린 문제,사용량');
    await user.click(within(sec).getByRole('button', { name: '표로 보기' }));
    const jobs = within(sec).getByRole('table', { name: '작업' });
    expect(within(jobs).getAllByRole('row').map((r) => r.textContent)).toEqual(['날짜7일 실행실패멈춤', '10-124010', '10-134231']);
  });

  it('에이전트가 하나도 없으면 안내와 에이전트 화면 단추', async () => {
    mount(HEALTH(), PROFILES, CREDS, CHANGES, { '/api/dashboard': DASH({ pods: [] }) });
    expect(await within(await fleet()).findByText('아직 AI 에이전트 작업공간이 없습니다')).toBeInTheDocument();
  });
});

// 시작하기 띠(OMAI-1274 §4-5, 디자인 리뷰 5A). 기록이 사용자별이라 사용자를 알 때만 보인다
describe('대시보드 › 시작하기 띠', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    resetGuideRunForTest();
    setGuideUser('a@x');
  });

  it('보통 상태면 띠를 보이고, 「시작」은 첫 대화 가이드를, 「다시 보지 않기」는 띠를 숨기고 사용자별로 기억한다', async () => {
    const user = userEvent.setup();
    mount();
    const banner = await screen.findByText("처음이라면 'AI 에이전트와 첫 대화하기'부터 따라해 보세요.");
    await user.click(screen.getByRole('button', { name: '시작' }));
    expect(guideRunState().run?.id).toBe('user.first-chat');
    await user.click(screen.getByRole('button', { name: '다시 보지 않기' }));
    expect(banner).not.toBeInTheDocument();
    expect(localStorage.getItem('aas-guide-banner:a@x')).toBe('1');
  });

  it('사용자를 아직 모르면(기록 주인을 정하기 전) 띠를 그리지 않는다', async () => {
    resetGuideRunForTest();
    mount();
    await current();
    expect(screen.queryByText(/처음이라면/)).toBeNull();
  });

  it('주 에이전트를 만드는 중이면 띠를 그리지 않는다', async () => {
    mount(HEALTH(), PROFILES, CREDS, CHANGES, { '/api/me': { ...ME_A, primary: { profile: 'main', ready: false } } });
    expect(await screen.findByText('AI 에이전트 작업공간을 준비하고 있습니다')).toBeInTheDocument();
    expect(screen.queryByText(/처음이라면/)).toBeNull();
  });

  it('에이전트가 없으면 띠 대신 기존 안내에 「따라하기: 내 에이전트 만들기」를 더한다', async () => {
    const user = userEvent.setup();
    mount(HEALTH(), PROFILES, CREDS, CHANGES, { '/api/me': { ...ME_ADMIN, pod: null, pods: [] } });
    await user.click(await screen.findByRole('button', { name: '따라하기: 내 AI 에이전트 작업공간 만들기' }));
    expect(guideRunState().run?.id).toBe('user.my-agents');
    expect(screen.queryByText(/처음이라면/)).toBeNull();
  });
});

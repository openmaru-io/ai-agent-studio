/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { cleanup, screen, waitFor, within } from '@testing-library/react';
import { fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { watchChatPopup } from '@/test/chatPopup';
import { HistoryBack, ME_ADMIN, ME_USER, mountScreen, postedTo, rowByName, stubApi } from '@/test/mountScreen';
import { pickAgent } from '@/test/pickAgent';

import { Cron } from './Cron';

const INC = (over = {}) => ({
  id: 'i1',
  job: 'nightly',
  job_id: 'j1',
  profile: 'ma',
  error: '타임아웃\n발생',
  now: 'failing',
  state: 'detected',
  age_days: 3,
  last_seen_at: '2026-10-10T08:00:00+09:00',
  new: true,
  ack: 'hermes cron ack i1',
  ...over,
});
const HEALTH = (over = {}) => ({
  collected_at: '2026-10-10T14:00:00+09:00',
  totals: {
    jobs: 9,
    jobs_active: 7,
    live_incidents: 1,
    new_incidents: 1,
    open_incidents: 3,
    settled_incidents: 2,
    failed_jobs: 1,
    stalled: 1,
    silent: 1,
    stale_profiles: [],
  },
  incidents: [
    INC(),
    INC({ id: 'i2', job: 'old', job_id: 'j2', now: 'ok', state: 'notified', new: false, ack: 'hermes cron ack i2' }),
    INC({ id: 'i3', job: 'gone', job_id: 'j3', now: 'gone', ack: 'hermes cron ack i3', profile: 'ops' }),
    INC({ id: 'i4', job: 'hushed', job_id: 'j4', muted: true }),
  ],
  failed_jobs: [
    {
      job: 'digest',
      job_id: 'j5',
      profile: 'ma',
      schedule: '0 9 * * *',
      error: '401 인증',
      streak: 3,
      last_run_at: '2026-10-10T09:00:00+09:00',
      deliver: 'local',
      skills: ['report'],
    },
  ],
  stalled: [
    {
      job: 'slow',
      job_id: 'j6',
      profile: 'ops',
      schedule: '30m',
      kind: '지연',
      cause: '락',
      since: '2026-10-08T00:00:00+09:00',
      hours: 60,
    },
  ],
  silent: [
    {
      job: 'quiet',
      job_id: 'j7',
      profile: 'ma',
      schedule: '0 8 * * *',
      reason: '전달 대상이 local',
      delivery_error: '',
    },
  ],
  muted: [
    {
      profile: 'ma',
      job_id: 'j4',
      job: 'hushed',
      note: '고칠 계획 없음',
      ts: '2026-10-01T00:00:00Z',
      by: 'kim',
      failing: true,
      incidents: 1,
    },
  ],
  profiles: [
    {
      name: 'ma',
      open_incidents: 1,
      failed_jobs: 1,
      stalled_jobs: 0,
      silent_jobs: 1,
      jobs_total: 5,
      jobs_active: 4,
      runs_7d: 10,
      runs_failed_7d: 2,
      stale: false,
      exec_status: 'ok',
      jobs_status: 'ok',
      detail: '',
    },
    {
      name: 'ops',
      open_incidents: 0,
      failed_jobs: 0,
      stalled_jobs: 1,
      silent_jobs: 0,
      jobs_total: 1,
      jobs_active: 1,
      runs_7d: 0,
      runs_failed_7d: 0,
      stale: true,
      exec_status: 'ok',
      jobs_status: 'ok',
      detail: '',
    },
  ],
  ...over,
});
const FLOWS = {
  starts: [
    {
      id: 'ma/j1',
      label: 'nightly',
      profile: 'ma',
      status: 'bad',
      badges: ['실패'],
      sub: 'ma · 30 9 * * *',
      skills: ['report'],
      scripts: ['run.py'],
      note: '메모',
    },
  ],
};
const JOB = (over = {}) => ({
  can_edit: true,
  job: {
    id: 'j1',
    name: 'nightly',
    enabled: true,
    state: 'scheduled',
    schedule_display: '30 9 * * *',
    next_run_at: '2026-10-11T09:30:00+09:00',
    last_run_at: '2026-10-10T09:30:00+09:00',
    last_status: 'error',
    failure_streak: 3,
    last_error: '타임아웃',
    deliver: 'local',
    skills: ['report'],
  },
  targets: [
    { id: 'local', name: '저장만', ready: true },
    { id: 'telegram', name: '텔레그램', ready: false },
  ],
  runs: [{ started_at: 1760056200, ended_at: 1760056242, status: 'ok', tool_call_count: 3 }],
  muted: null,
  note_doc: { lines: ['메모 글'], sha: 'n1', versions: 0, masked_lines: [] },
  prompt_doc: { lines: ['지시문 글'], sha: 'p1', versions: 0, masked_lines: [] },
  ...over,
});
const EXPLAIN = {
  skill: {
    id: 'ma:report',
    name: 'report',
    where: 'ma',
    description: '**주간** 보고',
    outline: [{ level: 1, text: '개요' }],
  },
  root: 'cron:ma/j1',
  checks: [
    { level: 'bad', text: '키가 만료됨' },
    { level: 'ok', text: '스킬 있음' },
  ],
  groups: [
    {
      title: 'MCP 서버',
      items: [
        {
          label: 'chart',
          badges: [],
          conf: 'doc',
          observed: 2,
          summary: '차트',
          tools: ['render'],
          evidence: { file: 'a/SKILL.md', line: 4, text: 'call chart' },
        },
      ],
    },
  ],
  observed: { days: 7, scope: '이 작업', runs: 5, matched: 1 },
};

afterEach(() => vi.unstubAllGlobals());

function mount(initial = '/cron', health: unknown = HEALTH(), job: unknown = JOB()) {
  const fn = stubApi({
    '/api/cron/explain': EXPLAIN,
    '/api/cron/job': job,
    '/api/cron/action': { ok: true },
    '/api/cron/mute': { ok: true },
    '/api/cron/note': { ok: true },
    '/api/health': health,
    '/api/flows': FLOWS,
    '/api/skills': {
      skills: [
        { id: 'ma:report', name: 'report', profile: 'ma' },
        { id: 'ma:weekly-review', name: 'weekly-review', profile: 'ma' },
        { id: 'ops:ops-only', name: 'ops-only', profile: 'ops' },
      ],
    },
    '/api/text/versions': { versions: [] },
  });
  mountScreen(<Cron />, initial);
  return fn;
}
const acts = (fn: ReturnType<typeof mount>) => postedTo(fn, '/api/cron/action');

describe('Cron: 목록', () => {
  it('보기 카드(탭 줄 대신)와 제목 줄. 예전 카드의 설명은 보기 카드의 둘째 줄이다(2026-10-17-011)', async () => {
    mount();
    expect(await screen.findByText('작업 9개 중 활성 7개 · 마지막 수집 2026-10-10 14:00')).toBeInTheDocument();
    expect(screen.getAllByRole('tablist')).toHaveLength(1);
    expect(screen.getByRole('tab', { name: /^실패 중인 문제, \d+$/ })).toHaveAccessibleDescription('신규 1 · 열림 3');
    expect(screen.getByRole('tab', { name: /^이미 해결된 문제, \d+$/ })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /^알림 없는 작업, \d+$/ })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /^전체 작업 · 일정, / })).toHaveAccessibleDescription('활성 7');
  });

  it('「전체 작업·일정」 탭이 맨 앞이고 주소에 탭이 없으면 그 탭이 먼저 열린다', async () => {
    mount();
    const tabs = await screen.findAllByRole('tab');
    expect(tabs[0]).toHaveAccessibleName(/전체 작업/);
    expect(tabs[0]).toHaveAttribute('aria-selected', 'true');
    expect(tabs.map((t) => t.getAttribute('aria-label'))).toEqual(
      expect.arrayContaining([expect.stringMatching(/실패 중인 문제/), expect.stringMatching(/프로파일별/)])
    );
  });

  it('실패 중인 문제 탭: 배지·오류 한 줄·n일째. 무시한 문제는 뺀다', async () => {
    mount('/cron?tab=incidents');
    expect(await screen.findByText('신규')).toBeInTheDocument();
    expect(screen.getByText('지금도 실패 중')).toBeInTheDocument();
    expect(screen.getByText('알림 보내지 않음')).toBeInTheDocument();
    expect(within(await rowByName(/^nightly/)).getByText('타임아웃 발생')).toBeInTheDocument(); // 오류 칸
    expect(screen.getByText('3일째')).toBeInTheDocument();
    expect(screen.queryByText('hushed')).not.toBeInTheDocument();
  });

  it('이미 해결된 문제 탭: 지금 상태 배지와 확인 명령 모두 복사', async () => {
    const user = userEvent.setup();
    const write = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue();
    mount('/cron?tab=settled');
    expect(await screen.findByText('지금은 정상')).toBeInTheDocument();
    expect(screen.getByText('삭제된 작업')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '확인 명령 2줄 모두 복사' }));
    expect(write).toHaveBeenCalledWith('hermes cron ack i2\nhermes cron ack i3');
  });

  it('프로파일 필터를 고르면 모두 복사가 그 프로파일 것만 복사한다', async () => {
    const user = userEvent.setup();
    const write = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue();
    mount('/cron?tab=settled&profile=ops');
    await user.click(await screen.findByRole('button', { name: '확인 명령 1줄 모두 복사' }));
    expect(write).toHaveBeenCalledWith('hermes cron ack i3');
  });

  it('실패·멈춤·알림 없음 탭의 행', async () => {
    const user = userEvent.setup();
    mount('/cron?tab=failed_jobs');
    expect(await screen.findByText('연속 3회')).toBeInTheDocument();
    expect(within(await rowByName(/^digest/)).getByText('알림 없음')).toBeInTheDocument(); // 결과 전달 칸
    await user.click(screen.getByRole('tab', { name: /멈춘 작업/ }));
    expect(screen.getByText('3일 지남')).toBeInTheDocument(); // 60시간 = 2.5일 → 3일
    await user.click(screen.getByRole('tab', { name: /알림 없는 작업/ }));
    expect(screen.getByText('전달 대상이 local')).toBeInTheDocument();
  });

  it('전체 작업 탭은 일정 풀이와 스킬·스크립트를 보이고 행을 누르면 작업 서랍이 열린다', async () => {
    const user = userEvent.setup();
    mount('/cron?tab=jobs');
    const row = await rowByName(/^nightly/);
    expect(within(row).getByText('30 9 * * * (매일 09:30)')).toBeInTheDocument(); // 일정 칸
    expect(within(row).getByText('메모')).toBeInTheDocument(); // 메모 칸
    expect(within(row).getByText('report')).toBeInTheDocument(); // 스킬 칸
    await user.click(row);
    expect(await screen.findByRole('dialog', { name: 'nightly' })).toBeInTheDocument();
  });

  it('무시한 것 탭과 프로파일별 탭', async () => {
    const user = userEvent.setup();
    mount('/cron?tab=muted');
    expect(await screen.findByText('무시함')).toBeInTheDocument();
    expect(screen.getByText('고칠 계획 없음')).toBeInTheDocument(); // 메모 칸
    await user.click(screen.getByRole('tab', { name: /프로파일별/ }));
    const ma = await rowByName(/^ma /);
    expect([...ma.querySelectorAll('[role="cell"]')].slice(2, 6).map((c) => c.textContent)).toEqual(['5', '4', '10', '20%']);
    expect(screen.getByText('실행 이력이 최신이 아님')).toBeInTheDocument();
  });

  it('수집 실패 프로파일과 오래된 이력을 알림으로 보인다', async () => {
    const h = HEALTH();
    h.profiles[0] = { ...h.profiles[0], jobs_status: 'error', detail: '읽기 오류' };
    h.totals.stale_profiles = ['ops'] as never;
    mount('/cron', h);
    const a = await screen.findByRole('alert');
    expect(a).toHaveTextContent('수집 실패: ma (읽기 오류)');
    expect(a).toHaveTextContent('실행 이력이 최신이 아닐 수 있습니다: ops');
  });

  it('?open=프로파일/작업 으로 들어오면 그 작업 서랍이 열린다', async () => {
    mount('/cron?open=ma/j1');
    expect(await screen.findByRole('dialog', { name: 'j1' })).toBeInTheDocument();
  });

  // 스펙 2026-10-28-014 D8·D9·D10: 작업 탭 행 클릭은 주소에 open 과 지금 POD 를 쓰고, 선택 행을 표시한다. 뒤로 가기는 서랍을 닫는다
  it('작업 탭 행을 누르면 주소에 open·pod 가 생기고 그 행이 선택되며, 뒤로 가기로 닫힌다', async () => {
    const user = userEvent.setup();
    const me = { ...ME_ADMIN, pod: { id: 'p1', owner: 'kim@x' }, pods: [{ id: 'p1', owner: 'kim@x' }] };
    stubApi({ '/api/me': me, '/api/cron/job': JOB(), '/api/health': HEALTH(), '/api/flows': FLOWS, '/api/cron/explain': EXPLAIN });
    const { qc } = mountScreen(
      <>
        <Cron />
        <HistoryBack />
      </>,
      '/cron'
    );
    await waitFor(() => expect(qc.getQueryData(['me'])).toBeDefined());
    await user.click(await rowByName(/^nightly/));
    expect(await screen.findByRole('dialog', { name: 'nightly' })).toBeInTheDocument();
    expect(screen.getByTestId('loc')).toHaveTextContent(/^\/cron\?open=ma%2Fj1&pod=p1$/);
    expect(screen.getByRole('row', { name: /^nightly/, hidden: true })).toHaveAttribute('aria-current', 'true');
    fireEvent.click(screen.getByRole('button', { name: '뒤로 가기', hidden: true }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.getByTestId('loc')).toHaveTextContent(/^\/cron$/);
  });

  // 2단계 T7: 사고 탭(사고 id)·프로파일 탭(프로파일 이름)의 행 서랍도 주소 open 과 묶인다. open 은 탭과 함께 읽는다(D12)
  const withPod = () => {
    const me = { ...ME_ADMIN, pod: { id: 'p1', owner: 'kim@x' }, pods: [{ id: 'p1', owner: 'kim@x' }] };
    stubApi({ '/api/me': me, '/api/cron/job': JOB(), '/api/health': HEALTH(), '/api/flows': FLOWS, '/api/cron/explain': EXPLAIN });
    const { qc } = mountScreen(<Cron />, '/cron?tab=incidents');
    return qc;
  };
  const loc = () => screen.getByTestId('loc');

  it('사고 탭 행을 누르면 주소에 tab=incidents&open=<사고 id>·pod 가 생기고 그 행이 선택된다', async () => {
    const user = userEvent.setup();
    const qc = withPod();
    await waitFor(() => expect(qc.getQueryData(['me'])).toBeDefined());
    await user.click(await rowByName(/^nightly/));
    expect(await screen.findByRole('dialog', { name: 'nightly' })).toBeInTheDocument();
    expect(loc()).toHaveTextContent(/^\/cron\?tab=incidents&open=i1&pod=p1$/);
    expect(screen.getByRole('row', { name: /^nightly/, hidden: true })).toHaveAttribute('aria-current', 'true');
  });

  it('?tab=incidents&open=<사고 id> 로 들어오면 그 사고 서랍이 열린다', async () => {
    mount('/cron?tab=incidents&open=i1');
    const dlg = await screen.findByRole('dialog', { name: 'nightly' });
    expect(within(dlg).getByText('ma · 열린 문제')).toBeInTheDocument();
    expect(within(dlg).getByRole('button', { name: '확인(ack) 명령 복사' })).toBeInTheDocument();
  });

  it('이미 해결된 문제 탭의 사고도 주소로 열린다', async () => {
    mount('/cron?tab=settled&open=i2');
    expect(await screen.findByRole('dialog', { name: 'old' })).toBeInTheDocument();
  });

  it('없는 사고 id 면 서랍에 찾지 못했다고 알린다', async () => {
    mount('/cron?tab=incidents&open=nope');
    const dlg = await screen.findByRole('dialog', { name: 'nope' });
    expect(await within(dlg).findByText('문제 nope 을(를) 찾지 못했습니다. 확인(ack)으로 닫혔거나 지워졌을 수 있습니다.')).toBeInTheDocument();
  });

  it('프로파일 탭 행은 tab=profiles&open=<프로파일> 로 프로파일 요약 서랍을 열고, 주소로 들어와도 같다', async () => {
    const user = userEvent.setup();
    mount('/cron?tab=profiles');
    await user.click(await rowByName(/^ma /));
    const dlg = await screen.findByRole('dialog', { name: 'ma' });
    expect(await within(dlg).findByText('이 프로파일만 보기')).toBeInTheDocument();
    expect(loc()).toHaveTextContent(/^\/cron\?tab=profiles&open=ma$/);
    cleanup();
    mount('/cron?tab=profiles&open=ops');
    expect(await screen.findByRole('dialog', { name: 'ops' })).toBeInTheDocument();
  });

  it('없는 프로파일이면 찾지 못했다고 알린다', async () => {
    mount('/cron?tab=profiles&open=ghost');
    const dlg = await screen.findByRole('dialog', { name: 'ghost' });
    expect(await within(dlg).findByText('프로파일 ghost 을(를) 찾지 못했습니다. 지워졌거나 이름이 바뀌었을 수 있습니다.')).toBeInTheDocument();
  });

  it('사고 id 를 다른 탭(작업 탭)의 open 으로 읽지 않고, 탭을 바꾸면 open·pod 가 지워지고 서랍이 닫힌다(D12)', async () => {
    const user = userEvent.setup();
    const qc = withPod();
    await waitFor(() => expect(qc.getQueryData(['me'])).toBeDefined());
    await user.click(await rowByName(/^nightly/));
    await screen.findByRole('dialog', { name: 'nightly' });
    expect(loc()).toHaveTextContent(/^\/cron\?tab=incidents&open=i1&pod=p1$/);
    fireEvent.click(screen.getByRole('tab', { name: /프로파일별/, hidden: true }));
    await waitFor(() => expect(loc()).toHaveTextContent(/^\/cron\?tab=profiles$/));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('기존 링크는 그대로다: 탭 없는 open=<프로파일>/<작업>, tab=jobs&profile=, tab=jobs&q=', async () => {
    mount('/cron?tab=jobs&profile=ma');
    expect(await rowByName(/^nightly/)).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).toBeNull();
    cleanup();
    mount('/cron?tab=jobs&q=ma');
    expect(await rowByName(/^nightly/)).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).toBeNull();
    cleanup();
    mount('/cron?open=ma/j1');
    expect(await screen.findByRole('dialog', { name: 'j1' })).toBeInTheDocument();
  });
});

describe('Cron: 문제 상세 패널', () => {
  it('오류·확인 명령 복사·대화로 조사·이어서 보기', async () => {
    const user = userEvent.setup();
    const write = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue();
    mount('/cron?tab=incidents');
    await user.click(await rowByName(/^nightly/));
    const dlg = await screen.findByRole('dialog', { name: 'nightly' });
    await user.click(within(dlg).getByRole('button', { name: '확인(ack) 명령 복사' }));
    expect(write).toHaveBeenCalledWith('hermes cron ack i1');
    const popup = watchChatPopup(); // 서랍을 닫지 않고 대화 팝업에 물을 글을 채워 연다(OMAI-1115)
    fireEvent.click(within(dlg).getByRole('button', { name: '대화로 조사' }));
    expect(popup()).toMatchObject({ kind: 'chat', agent: 'ma', text: expect.any(String) });
    expect(within(dlg).getByRole('link', { name: '이 작업의 스킬 연결도' })).toHaveAttribute(
      'href',
      '/flows?root=cron%3Ama%2Fj1'
    );
    expect(within(dlg).getByRole('link', { name: 'ma 프로파일 설정' })).toHaveAttribute('href', '/profiles?name=ma');
  });
});

describe('Cron: 작업 서랍', () => {
  const open = async (initial = '/cron?tab=jobs', job: unknown = JOB()) => {
    const user = userEvent.setup();
    const fn = mount(initial, HEALTH(), job);
    await user.click(await rowByName(/^nightly/));
    const dlg = await screen.findByRole('dialog', { name: 'nightly' });
    await within(dlg).findByText('마지막 오류');
    return { user, fn, dlg };
  };

  it('상태·주기·다음 실행·전달·오류·최근 실행', async () => {
    const { dlg } = await open();
    expect(within(dlg).getByText('켜짐')).toBeInTheDocument();
    expect(within(dlg).getByText('마지막 실행 error')).toBeInTheDocument();
    expect(within(dlg).getByText('연속 실패 3회')).toBeInTheDocument();
    expect(within(dlg).getAllByText('30 9 * * *').length).toBeGreaterThan(0);
    expect(within(dlg).getAllByText(/매일 09:30/).length).toBeGreaterThan(0);
    expect(within(dlg).getByText('2026-10-11 09:30')).toBeInTheDocument();
    expect(within(dlg).getByText('실패해도 알림 없음')).toBeInTheDocument();
    expect(within(dlg).getByText('타임아웃')).toBeInTheDocument();
    expect(within(dlg).getByText(/42초/)).toBeInTheDocument();
    expect(within(dlg).getByText(/도구 3회/)).toBeInTheDocument();
  });

  // 동작 단추는 서랍 머리(닫기 앞)에 있고, 누르면 그 동작 이름의 대화 상자에서 확인한다(OMAI-1135)
  const head = (dlg: HTMLElement) => dlg.querySelector('[data-drawer-head]') as HTMLElement;
  const confirmIn = async (user: ReturnType<typeof userEvent.setup>, name: string) => {
    const box = await screen.findByRole('dialog', { name });
    await user.click(within(box).getByRole('button', { name }));
  };

  it('동작 단추는 서랍 머리에 끄기·지금 한 번 실행·이 작업 무시·작업 삭제 순서로 있다', async () => {
    const { dlg } = await open();
    expect(within(head(dlg)).getAllByRole('button').map((b) => b.getAttribute('aria-label'))).toEqual([
      '끄기',
      '지금 한 번 실행',
      '이 작업 무시',
      '작업 삭제',
      '닫기',
    ]);
  });

  it('끄기는 확인 뒤 pause 를 보낸다', async () => {
    const { user, fn, dlg } = await open();
    await user.click(within(head(dlg)).getByRole('button', { name: '끄기' }));
    expect(await screen.findByText('이 작업을 끕니다. 다시 켤 때까지 실행되지 않습니다.', { selector: 'p, div' })).toBeInTheDocument();
    expect(acts(fn)).toEqual([]);
    await confirmIn(user, '끄기');
    await waitFor(() => expect(acts(fn)).toEqual([{ profile: 'ma', id: 'j1', action: 'pause', job_name: 'nightly' }]));
  });

  it('지금 한 번 실행은 확인 뒤 trigger 를 보낸다', async () => {
    const { user, fn, dlg } = await open();
    await user.click(within(head(dlg)).getByRole('button', { name: '지금 한 번 실행' }));
    await confirmIn(user, '지금 한 번 실행');
    await waitFor(() => expect(acts(fn)[0]).toMatchObject({ action: 'trigger' }));
  });

  it('주기: 방식을 고르면 식과 다음 실행을 미리 보이고, 바꾸기는 확인 뒤 schedule 을 보낸다', async () => {
    const { user, fn, dlg } = await open();
    await user.selectOptions(within(dlg).getByRole('combobox', { name: '방식' }), 'weekdays');
    expect(within(dlg).getByText('30 9 * * 1-5')).toBeInTheDocument();
    expect(within(dlg).getByText(/다음 실행\(이 PC 시간 기준\):/)).toBeInTheDocument();
    await user.click(within(dlg).getByRole('button', { name: '이 주기로 바꾸기' }));
    expect(await screen.findByText(/30 9 \* \* \* → 30 9 \* \* 1-5\(으\)로 바꿉니다/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '확인' }));
    await waitFor(() =>
      expect(acts(fn)).toEqual([
        { profile: 'ma', id: 'j1', action: 'schedule', job_name: 'nightly', schedule: '30 9 * * 1-5' },
      ])
    );
  });

  it('주기가 지금과 같으면 바꾸기 버튼이 막힌다', async () => {
    const { dlg } = await open();
    expect(within(dlg).getByRole('button', { name: '지금 주기와 같습니다' })).toBeDisabled();
  });

  it('직접 입력은 간격 표기도 받는다', async () => {
    const { user, dlg } = await open();
    await user.selectOptions(within(dlg).getByRole('combobox', { name: '방식' }), 'custom');
    const input = within(dlg).getByRole('textbox', { name: '주기' });
    await user.clear(input);
    await user.type(input, '30m');
    expect(within(dlg).getByText(/· 30분마다/)).toBeInTheDocument();
  });

  it('결과 전달 대상을 바꾸면 deliver 를 보낸다. 받을 곳이 없는 대상은 표시한다', async () => {
    const { user, fn, dlg } = await open();
    const sel = within(dlg).getByRole('combobox', { name: '결과 전달 대상' });
    expect(within(sel).getByRole('option', { name: '텔레그램 — 받을 곳이 설정되지 않음' })).toBeInTheDocument();
    await user.selectOptions(sel, 'telegram');
    await user.click(within(dlg).getByRole('button', { name: '대상 바꾸기' }));
    await user.click(await screen.findByRole('button', { name: '확인' }));
    await waitFor(() => expect(acts(fn)[0]).toMatchObject({ action: 'deliver', deliver: 'telegram' }));
  });

  it('무시 등록: 머리 단추 → 대화 상자에서 이유를 적고 무시', async () => {
    const { user, fn, dlg } = await open();
    await user.click(within(head(dlg)).getByRole('button', { name: '이 작업 무시' }));
    const box = await screen.findByRole('dialog', { name: '이 작업 무시' });
    await user.type(within(box).getByRole('textbox', { name: '무시하는 이유' }), '11월에 다시 봄');
    await user.click(within(box).getByRole('button', { name: '이 작업 무시' }));
    await waitFor(() =>
      expect(postedTo(fn, '/api/cron/mute')).toEqual([
        { profile: 'ma', id: 'j1', job_name: 'nightly', mute: true, note: '11월에 다시 봄' },
      ])
    );
  });

  it('무시 중이면 풀기 버튼', async () => {
    const { user, fn, dlg } = await open(
      '/cron?tab=jobs',
      JOB({ muted: { ts: '2026-10-01T00:00:00Z', by: 'kim', note: '메모' } })
    );
    expect(within(dlg).getByText('무시하는 중')).toBeInTheDocument(); // 기본 정보 표
    await user.click(within(head(dlg)).getByRole('button', { name: '무시 풀기' }));
    await confirmIn(user, '무시 풀기');
    await waitFor(() => expect(postedTo(fn, '/api/cron/mute')[0]).toMatchObject({ mute: false }));
  });

  it('실행할 스킬 바꾸기: 목록에 없는 이름도 적은 그대로 보낸다', async () => {
    const { user, fn, dlg } = await open();
    const input = within(dlg).getByRole('combobox', { name: '실행할 스킬' });
    await user.clear(input);
    await user.type(input, 'alert');
    await user.click(within(dlg).getByRole('button', { name: '스킬 바꾸기' }));
    await user.click(await screen.findByRole('button', { name: '확인' }));
    await waitFor(() => expect(acts(fn)[0]).toMatchObject({ action: 'skill', skill: 'alert' }));
  });

  it('실행할 스킬 바꾸기: 글자를 적으면 이 프로파일의 스킬만 걸러 보이고, 골라서 바꾼다', async () => {
    const { user, fn, dlg } = await open();
    const input = within(dlg).getByRole('combobox', { name: '실행할 스킬' });
    await user.clear(input);
    await user.type(input, 'rev');
    const list = await screen.findByRole('listbox');
    expect(within(list).getAllByRole('option').map((o) => o.textContent)).toEqual(['weekly-review']);
    await user.click(within(list).getByRole('option', { name: 'weekly-review' }));
    expect(input).toHaveValue('weekly-review');
    await user.click(within(dlg).getByRole('button', { name: '스킬 바꾸기' }));
    await user.click(await screen.findByRole('button', { name: '확인' }));
    await waitFor(() => expect(acts(fn)[0]).toMatchObject({ action: 'skill', skill: 'weekly-review' }));
  });

  it('실행할 스킬: 이미 고른 이름이 들어 있어도 누르면 전체 목록이 열린다', async () => {
    const { user, dlg } = await open();
    await user.click(within(dlg).getByRole('combobox', { name: '실행할 스킬' }));
    const names = within(await screen.findByRole('listbox')).getAllByRole('option').map((o) => o.textContent);
    expect(names).toEqual(['report', 'weekly-review']);
  });

  it('삭제는 머리 단추 → 대화 상자에서 작업 이름을 입력해야 풀리고 delete 를 보낸다', async () => {
    const { user, fn, dlg } = await open();
    await user.click(within(head(dlg)).getByRole('button', { name: '작업 삭제' }));
    const box = await screen.findByRole('dialog', { name: '작업 삭제' });
    const go = within(box).getByRole('button', { name: '작업 삭제' });
    expect(go).toBeDisabled();
    await user.type(within(box).getByRole('textbox', { name: '확인용 작업 이름' }), 'nightly');
    await user.click(go);
    await waitFor(() =>
      expect(acts(fn)).toEqual([{ profile: 'ma', id: 'j1', action: 'delete', job_name: 'nightly', confirm: 'nightly' }])
    );
  });

  it('관리자가 아니면 바꾸는 부분이 없다', async () => {
    const { dlg } = await open('/cron?tab=jobs', JOB({ can_edit: false }));
    expect(within(dlg).getAllByText('이 AI 에이전트 작업공간의 주인, 팀 관리자, 관리자만 바꿀 수 있습니다.').length).toBeGreaterThan(0);
    expect(within(head(dlg)).getAllByRole('button').map((b) => b.getAttribute('aria-label'))).toEqual(['닫기']); // 머리 동작 단추 없음
  });

  it('이 작업이 하는 일: 요약·스킬 설명·조건·연결', async () => {
    const { dlg } = await open();
    expect(
      await within(dlg).findByText('매일 09:30에 ma 이(가) report 스킬을 돌려 결과를 저장만 한다(알림 없음).')
    ).toBeInTheDocument();
    expect(within(dlg).getByText('주간').tagName).toBe('STRONG');
    expect(within(dlg).getByText('실행에 필요한 조건 · 막힌 것 1')).toBeInTheDocument();
    expect(within(dlg).getByText('막힘')).toBeInTheDocument();
    expect(within(dlg).getByText('스킬 문서의 지시')).toBeInTheDocument();
    expect(within(dlg).getByText('실행에서 2회')).toBeInTheDocument();
    expect(within(dlg).getByText('call chart')).toBeInTheDocument();
  });
});

describe('Cron: 새 Cron 작업', () => {
  it('「새 Cron 작업」은 제목 옆의 + 아이콘이고, 표 툴바 오른쪽 끝에도 글자 단추가 있다(2026-10-21-020)', async () => {
    mount();
    const [btn, grid] = await screen.findAllByRole('button', { name: '새 예약 작업' });
    expect(btn.textContent).toBe(''); // 글자 없이 아이콘만
    const h1 = screen.getByRole('heading', { level: 1 });
    expect(h1.parentElement).toBe(btn.parentElement?.parentElement); // 제목과 같은 줄 묶음
    expect(btn.closest('[data-grid-toolbar]')).toBeNull();
    expect(grid.closest('[data-grid-toolbar]')).not.toBeNull();
    expect(grid).toHaveTextContent('새 예약 작업');
  });

  it('프로파일·이름·주기·전달을 보내 만들고 전체 작업 탭으로 간다', async () => {
    const user = userEvent.setup();
    const fn = mount();
    await user.click((await screen.findAllByRole('button', { name: '새 예약 작업' }))[0]);
    const dlg = await screen.findByRole('dialog', { name: '새 예약 작업' });
    await pickAgent(user, within(dlg).getByRole('combobox', { name: '프로파일(작업을 실행할 프로파일)' }), 'ops');
    await user.type(within(dlg).getByRole('textbox', { name: '작업 이름' }), 'weekly-report');
    // Autocomplete 는 글자마다 목록 위치를 다시 계산해 jsdom 에서 type 이 느리다. 붙여넣기로 한 번에 넣는다
    await user.click(within(dlg).getByRole('combobox', { name: '실행할 스킬' }));
    await user.paste('report');
    await user.type(within(dlg).getByRole('textbox', { name: '지시문' }), '요약해 줘');
    await user.selectOptions(within(dlg).getByRole('combobox', { name: '결과 전달' }), 'telegram');
    await user.click(within(dlg).getByRole('button', { name: '작업 만들기' }));
    await waitFor(() =>
      expect(acts(fn)).toEqual([
        {
          action: 'create',
          profile: 'ops',
          job_name: 'weekly-report',
          schedule: '0 9 * * *',
          skill: 'report',
          prompt: '요약해 줘',
          deliver: 'telegram',
        },
      ])
    );
    await waitFor(() => expect(screen.getByTestId('loc')).toHaveTextContent('/cron?tab=jobs&q=weekly-report'));
  }, 15000);

  it('실행할 스킬은 서랍과 같은 검색 선택이고, 고른 프로파일의 스킬만 보인다', async () => {
    const user = userEvent.setup();
    mount();
    await user.click((await screen.findAllByRole('button', { name: '새 예약 작업' }))[0]);
    const dlg = await screen.findByRole('dialog', { name: '새 예약 작업' });
    const input = within(dlg).getByRole('combobox', { name: '실행할 스킬' });
    await user.click(input);
    let names = within(await screen.findByRole('listbox')).getAllByRole('option').map((o) => o.textContent);
    expect(names).toEqual(['report', 'weekly-review']);
    await user.keyboard('{Escape}');
    await pickAgent(user, within(dlg).getByRole('combobox', { name: '프로파일(작업을 실행할 프로파일)' }), 'ops');
    await user.click(input);
    names = within(await screen.findByRole('listbox')).getAllByRole('option').map((o) => o.textContent);
    expect(names).toEqual(['ops-only']);
  }, 15000);

  it('만들기 전에 확인 요약이 보인다', async () => {
    const user = userEvent.setup();
    mount();
    await user.click((await screen.findAllByRole('button', { name: '새 예약 작업' }))[0]);
    const dlg = await screen.findByRole('dialog', { name: '새 예약 작업' });
    expect(
      within(dlg).getAllByText('매일 09:00에 ma 이(가) 지시문대로 일하고 결과를 저장만 한다(알림 없음).').length
    ).toBeGreaterThan(0);
  });
});

// 모든 에이전트가 같은 프로파일 이름(main)을 쓰게 된 뒤로, 프로파일 이름만으로는 작업이 어느 에이전트에 생기는지 알 수 없었다(2026-10-19-010)
describe('Cron: 지금 에이전트 이름', () => {
  const ME_POD = { ...ME_USER, admin: true, pod: { id: 'aas-agent-lee-1', owner: 'lee@x.com', name: '마케팅 도우미' } };
  const mountWithPod = () => {
    stubApi({
      '/api/me': ME_POD,
      '/api/cron/explain': EXPLAIN,
      '/api/cron/action': { ok: true },
      '/api/health': HEALTH(),
      '/api/flows': FLOWS,
      '/api/skills': { skills: [] },
    });
    mountScreen(<Cron />, '/cron');
  };

  it('화면 머리 문구에 지금 에이전트 이름을 붙인다', async () => {
    mountWithPod();
    expect(await screen.findByText('마케팅 도우미의 작업 9개 중 활성 7개 · 마지막 수집 2026-10-10 14:00')).toBeInTheDocument();
  });

  it('새 예약 작업 서랍의 부제·안내·요약 문장에 에이전트 이름이 들어간다', async () => {
    const user = userEvent.setup();
    mountWithPod();
    await screen.findByText(/^마케팅 도우미의 작업/);
    await user.click(screen.getAllByRole('button', { name: '새 예약 작업' })[0]);
    const dlg = await screen.findByRole('dialog', { name: '새 예약 작업' });
    expect(within(dlg).getByText('마케팅 도우미에 작업을 새로 만듭니다')).toBeInTheDocument();
    expect(within(dlg).getByText('다른 AI 에이전트 작업공간에 만들려면 오른쪽 위에서 AI 에이전트 작업공간을 바꾸세요')).toBeInTheDocument();
    expect(
      within(dlg).getAllByText('매일 09:00에 마케팅 도우미의 ma 이(가) 지시문대로 일하고 결과를 저장만 한다(알림 없음).').length
    ).toBeGreaterThan(0);
  });

  it('에이전트 이름이 없는 구성(compose)은 지금 문구 그대로다', async () => {
    const user = userEvent.setup();
    mount();
    expect(await screen.findByText('작업 9개 중 활성 7개 · 마지막 수집 2026-10-10 14:00')).toBeInTheDocument();
    await user.click(screen.getAllByRole('button', { name: '새 예약 작업' })[0]);
    const dlg = await screen.findByRole('dialog', { name: '새 예약 작업' });
    expect(within(dlg).getByText('AI 에이전트에 작업을 새로 만듭니다')).toBeInTheDocument();
    expect(within(dlg).queryByText(/오른쪽 위에서 에이전트를 바꾸세요/)).toBeNull();
  });
});

// 팀 관리자(스펙 2026-10-22-001 DD5): 다루는 에이전트가 팀원 것일 때만 화면 머리에 대상 표시
describe('Cron: 팀원 에이전트 표시', () => {
  const mountMe = (pod: Record<string, unknown>) => {
    stubApi({ '/api/me': { ...ME_USER, pod }, '/api/cron/explain': EXPLAIN, '/api/health': HEALTH(), '/api/flows': FLOWS, '/api/skills': { skills: [] } });
    mountScreen(<Cron />, '/cron');
  };

  it('지금 에이전트가 팀원 것이면 「팀원 <주인>의 에이전트를 바꿉니다」 상태 줄이 있다', async () => {
    mountMe({ id: 'aas-agent-park-1', owner: 'park@x.com', owner_name: '박팀원', name: '영업 도우미', team: true });
    const note = await screen.findByText('팀원 박팀원의 AI 에이전트 작업공간을 바꿉니다');
    expect(note.closest('[role="status"]')).not.toBeNull();
  });

  it('내 에이전트(team 거짓)면 표시가 없다', async () => {
    mountMe({ id: 'aas-agent-lee-1', owner: 'lee@x.com', name: '마케팅 도우미', team: false });
    await screen.findByText(/^마케팅 도우미의 작업/);
    expect(screen.queryByText(/에이전트를 바꿉니다/)).toBeNull();
  });
});

describe('Cron: 편집 열(OMAI-1210)', () => {
  it('작업 행의 「편집」은 그 작업의 서랍(켜기·끄기·기간·메모를 고치는 곳)을 연다', async () => {
    mount('/cron?tab=failed_jobs');
    expect(within(await rowByName(/digest/)).getByRole('link', { name: 'digest 편집' })).toHaveAttribute('href', '/cron?open=ma%2Fj5');
  });

  it('문제 탭의 행도 그 작업의 서랍으로 보낸다', async () => {
    mount('/cron?tab=incidents');
    expect(within(await rowByName(/nightly/)).getByRole('link', { name: 'nightly 편집' })).toHaveAttribute('href', '/cron?open=ma%2Fj1');
  });

  it('처음 열리는 「전체 작업·일정」 탭의 행도 그 작업의 서랍으로 보낸다(OMAI-1210)', async () => {
    mount('/cron');
    expect(within(await rowByName(/nightly/)).getByRole('link', { name: 'nightly 편집' })).toHaveAttribute('href', '/cron?open=ma%2Fj1');
  });

  it('전체 작업 행의 id 가 「cron:프로파일/작업」 꼴이어도 서랍 주소는 「프로파일/작업」이다(OKE 확인, OMAI-1210)', async () => {
    stubApi({ '/api/me': ME_ADMIN, '/api/health': HEALTH(), '/api/flows': { starts: [{ ...FLOWS.starts[0], id: 'cron:ma/j1' }] }, '/api/skills': { skills: [] } });
    mountScreen(<Cron />, '/cron');
    expect(within(await rowByName(/nightly/)).getByRole('link', { name: 'nightly 편집' })).toHaveAttribute('href', '/cron?open=ma%2Fj1');
  });

  it('프로파일별 탭', async () => {
    mount('/cron?tab=profiles');
    expect(within(await rowByName(/^ma/)).getByRole('link', { name: 'ma 편집' })).toHaveAttribute('href', '/profiles?name=ma&pane=cron');
  });

  it('관리자도 주인도 아니면 「편집」 열이 없다', async () => {
    stubApi({ '/api/me': ME_USER, '/api/health': HEALTH(), '/api/flows': FLOWS, '/api/skills': { skills: [] } });
    mountScreen(<Cron />, '/cron?tab=failed_jobs');
    await rowByName(/digest/);
    expect(screen.queryByRole('link', { name: /편집/ })).toBeNull();
  });
});

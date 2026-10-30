/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ME_USER, mountScreen, rowByName, stubApi } from '@/test/mountScreen';

import { Activity } from './Activity';

const DATA = (days: number) => ({
  days,
  totals: {
    sessions: 10,
    messages: 12345,
    tool_calls: 20000,
    input_tokens: 2_500_000,
    output_tokens: 90000,
    idle_profiles: 1,
  },
  by_source: [
    { source: 'cron', sessions: 4 },
    { source: 'telegram', sessions: 6 },
  ],
  by_model: [
    { model: 'qwen3', sessions: 8, input_tokens: 2_000_000, output_tokens: 80000 },
    { model: '', sessions: 2, input_tokens: 5, output_tokens: 6 },
  ],
  profiles: [
    {
      name: 'ma',
      status: 'ok',
      sessions: 10,
      messages: 12345,
      tool_calls: 20000,
      input_tokens: 2_500_000,
      output_tokens: 90000,
      last_activity: '2026-10-10T08:15:00+09:00',
      sources: [
        { source: 'telegram', sessions: 6 },
        { source: 'cron', sessions: 4 },
      ],
    },
    {
      name: 'idle',
      status: 'ok',
      sessions: 0,
      messages: 0,
      tool_calls: 0,
      input_tokens: 0,
      output_tokens: 0,
      last_activity: null,
      sources: [],
    },
    {
      name: 'nodb',
      status: 'no_db',
      sessions: 0,
      messages: 0,
      tool_calls: 0,
      input_tokens: 0,
      output_tokens: 0,
      sources: [],
    },
  ],
});

afterEach(() => vi.unstubAllGlobals());

function mount(initial = '/activity') {
  const fn = stubApi({ '/api/activity': (u: string) => DATA(Number(new URL(u, 'http://x').searchParams.get('days'))) });
  mountScreen(<Activity />, initial);
  return fn;
}

describe('Activity', () => {
  it('프로파일 이름 옆에 프로파일 목록과 같은 「내 전용」·「<이름>님 전용」을 보인다(2026-10-18)', async () => {
    stubApi({ '/api/activity': (u: string) => ({ ...DATA(Number(new URL(u, 'http://x').searchParams.get('days'))), owner_name: '김철수' }) });
    mountScreen(<Activity />, '/activity');
    expect(await screen.findAllByText('김철수님 전용')).not.toHaveLength(0);
  });

  it('숫자만 카드 셋, 보기 카드(출처별에 크론 비율)와 프로파일별 행을 보인다', async () => {
    mount();
    expect(await screen.findByText('최근 7일 세션')).toBeInTheDocument();
    expect(screen.getByText('메시지 12k · 도구 20k')).toBeInTheDocument();
    expect(screen.getByText('2.5M', { selector: '[data-card] *' })).toBeInTheDocument(); // 입력 토큰 카드
    // 크론 4 / 10. 보기 카드(2026-10-17-011): 크론 비율은 「출처별」 보기 카드의 둘째 줄이다
    expect(screen.getByRole('tab', { name: /^출처별, \d+$/ })).toHaveAccessibleDescription('예약 작업 비율 40%');
    expect(screen.getByText('쉬는 프로파일')).toBeInTheDocument();
    expect(screen.getAllByText('활동 없음')).toHaveLength(1); // idle 의 상태 칸. 마지막 활동 칸은 기록이 없으면 비운다(OMAI-1127)
    // 상태 칸은 공통 표처럼 모든 행에 점 + 글자를 보인다. 활동이 있는 프로파일도 비우지 않는다
    expect(within(await rowByName(/^ma /)).getByText('활동 있음')).toBeInTheDocument();
    for (const name of [/^ma /, /^idle /, /^nodb /]) expect((await rowByName(name)).querySelector('[data-dot]')).not.toBeNull();
    expect(screen.getByText('기록 없음')).toBeInTheDocument();
    expect(screen.getByText('텔레그램 6')).toBeInTheDocument();
    expect(within(await rowByName(/^ma /)).getByText('2.5M')).toBeInTheDocument(); // 입력 토큰 칸
  });

  it('기간을 바꾸면 days 를 주소에 담아 다시 받는다(7일은 주소에서 뺀다)', async () => {
    const user = userEvent.setup();
    const fn = mount();
    await screen.findByText('최근 7일 세션');
    await user.selectOptions(screen.getByRole('combobox', { name: '기간' }), '30');
    expect(await screen.findByText('최근 30일 세션')).toBeInTheDocument();
    expect(screen.getByTestId('loc')).toHaveTextContent('days=30');
    expect(fn.mock.calls.some((c) => String(c[0]).includes('days=30'))).toBe(true);
    await user.selectOptions(screen.getByRole('combobox', { name: '기간' }), '7');
    await screen.findByText('최근 7일 세션');
    expect(screen.getByTestId('loc')).not.toHaveTextContent('days=');
  });

  it('주소의 days=30 으로 시작한다', async () => {
    const fn = mount('/activity?days=30');
    await screen.findByText('최근 30일 세션');
    expect(String(fn.mock.calls[0][0])).toContain('days=30');
  });

  it('프로파일 서랍에 출처 비율과 이어서 보기가 있다', async () => {
    const user = userEvent.setup();
    mount();
    await user.click(await rowByName(/^ma /));
    const dlg = await screen.findByRole('dialog', { name: 'ma' });
    const table = within(dlg).getByRole('table');
    expect(within(table).getByText('60%')).toBeInTheDocument();
    expect(within(dlg).getByRole('link', { name: 'ma 예약 작업 보기' })).toHaveAttribute('href', '/cron?tab=profiles&q=ma');
    expect(within(dlg).getByRole('link', { name: 'ma 메신저 연결 보기' })).toHaveAttribute('href', '/channels?tab=all&q=ma');
  });

  it('모델별 탭은 모델 이름이 없으면 (모델 기록 없음) 으로 보이고 설정 화면으로 잇는다', async () => {
    const user = userEvent.setup();
    mount('/activity?tab=models');
    expect(await screen.findByText('(모델 기록 없음)')).toBeInTheDocument();
    await user.click(await rowByName(/qwen3/));
    const dlg = await screen.findByRole('dialog', { name: 'qwen3' });
    expect(within(dlg).getByText('8 (80%)')).toBeInTheDocument();
    expect(within(dlg).getByRole('link', { name: '이 모델 설정 보기' })).toHaveAttribute(
      'href',
      '/models?tab=models&q=qwen3'
    );
  });

  it('출처별 탭의 서랍은 그 출처를 쓴 프로파일을 세션 순으로 보인다', async () => {
    const user = userEvent.setup();
    mount('/activity?tab=sources');
    await user.click(await rowByName(/^예약 작업 /));
    const dlg = await screen.findByRole('dialog', { name: '예약 작업' });
    const rows = within(within(dlg).getByRole('table')).getAllByRole('row');
    expect(rows).toHaveLength(2); // 머리말 + ma 하나
    expect(within(rows[1]).getByText('ma')).toBeInTheDocument();
  });

  describe('편집 열(OMAI-1210)', () => {
    it('프로파일별 행은 그 프로파일 서랍으로, 모델별 행은 모델 화면의 그 모델로 간다', async () => {
      mount();
      expect(within(await rowByName(/^ma/)).getByRole('link', { name: 'ma 편집' })).toHaveAttribute('href', '/profiles?name=ma');
    });

    it('모델별 탭의 모델 행', async () => {
      mount('/activity?tab=models');
      expect(within(await rowByName(/qwen3/)).getByRole('link', { name: 'qwen3 편집' })).toHaveAttribute('href', '/models?tab=models&q=qwen3');
      expect(within(await rowByName(/모델 기록 없음/)).queryByRole('link', { name: /편집/ })).toBeNull(); // 이름 없는 모델은 열 곳이 없다
    });

    it('관리자도 주인도 아니면 「편집」 열이 없다', async () => {
      stubApi({ '/api/me': ME_USER, '/api/activity': (u: string) => DATA(Number(new URL(u, 'http://x').searchParams.get('days'))) });
      mountScreen(<Activity />, '/activity');
      await rowByName(/^ma/);
      expect(screen.queryByRole('link', { name: /편집/ })).toBeNull();
    });
  });
});

/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { mountScreen, postedTo, stubApi } from '@/test/mountScreen';

import { AiSummary, SummaryBody, SummaryView } from './AiSummary';

afterEach(() => vi.unstubAllGlobals());

const BODY: SummaryBody = {
  one_line: '주간 보고서를 만든다',
  use_when: ['금요일 보고'],
  what_it_does: ['일정을 모은다'],
  strengths: ['손으로 하는 것보다 빠르다'],
  requires: ['Slack 토큰'],
  cautions: ['외부로 보낸다'],
};
const view = (over: Partial<SummaryView> = {}): SummaryView => ({
  enabled: true,
  lang: 'ko',
  summary: BODY,
  at: '2026-10-17T11:30:00+0900',
  model: 'cogentai-aas',
  stale: false,
  src: '0.0.1',
  other: null,
  ...over,
});

describe('AiSummary', () => {
  it('저장된 요약을 접어서 보이고 「더 보기」로 모두 편다. 만든 사람은 보이지 않는다', async () => {
    const fn = stubApi({ '/api/skill/summary': view() });
    mountScreen(<AiSummary target={{ id: 'ma:skills/x' }} facts={<span>SLACK_TOKEN · 필요</span>} />, '/');
    expect(await screen.findByText('주간 보고서를 만든다')).toBeInTheDocument();
    expect(screen.getByText('금요일 보고')).toBeInTheDocument();
    expect(screen.queryByText('일정을 모은다')).toBeNull();
    expect(screen.getByText(/AI 요약 · .* · cogentai-aas/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: '더 보기' }));
    for (const s of ['일정을 모은다', '손으로 하는 것보다 빠르다', 'Slack 토큰', '외부로 보낸다', 'SLACK_TOKEN · 필요'])
      expect(screen.getByText(s)).toBeInTheDocument();
    expect(postedTo(fn, '/api/skill/summary')).toHaveLength(0);       // 이미 있으면 만들지 않는다
    expect(fn.mock.calls.some((c) => String(c[0]) === '/api/skill/summary?id=ma%3Askills%2Fx')).toBe(true);
  });

  it('보조 작업 별칭 cogentai-aas-aux 는 cogentai-aas 로 보인다', async () => {
    stubApi({ '/api/skill/summary': view({ model: 'cogentai-aas-aux' }) });
    mountScreen(<AiSummary target={{ id: 'ma:skills/x' }} />, '/');
    expect(await screen.findByText(/AI 요약 · .* · cogentai-aas$/)).toBeInTheDocument();
    expect(screen.queryByText(/cogentai-aas-aux/)).toBeNull();
  });

  it('요약이 없으면 열 때 한 번 만들고 그 결과를 보인다', async () => {
    const fn = stubApi({ '/api/skill/summary': (_u: string, b: Record<string, unknown>) => (b.ns ? view() : view({ summary: null })) });
    mountScreen(<AiSummary target={{ ns: 'community', name: 'weekly' }} />, '/');
    expect(await screen.findByText('주간 보고서를 만든다')).toBeInTheDocument();
    expect(postedTo(fn, '/api/skill/summary')).toEqual([{ ns: 'community', name: 'weekly', refresh: false }]);
  });

  // 스킬 화면의 개요 탭은 머문 뒤에만 만든다(스펙 2026-11-06-003 D3). 표 서랍·스킬 허브는 지연을 주지 않아 지금처럼 바로(D9)
  it('autoDelay 를 주면 그 시간이 지난 뒤에만 만들고, 그 전에 닫히면 만들지 않는다', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const fn = stubApi({ '/api/skill/summary': (_u: string, b: Record<string, unknown>) => (b.id ? view() : view({ summary: null })) });
      const first = mountScreen(<AiSummary target={{ id: 'a' }} autoDelay={1500} />, '/');
      await screen.findByTestId('ai-summary');
      await act(() => vi.advanceTimersByTimeAsync(1000));
      expect(postedTo(fn, '/api/skill/summary')).toHaveLength(0);
      first.unmount();
      await act(() => vi.advanceTimersByTimeAsync(2000));
      expect(postedTo(fn, '/api/skill/summary')).toHaveLength(0);       // 닫히면 타이머를 지운다
      mountScreen(<AiSummary target={{ id: 'b' }} autoDelay={1500} />, '/');
      await screen.findByTestId('ai-summary');
      await act(() => vi.advanceTimersByTimeAsync(1600));
      await waitFor(() => expect(postedTo(fn, '/api/skill/summary')).toEqual([{ id: 'b', refresh: false }]));
      expect(await screen.findByText('주간 보고서를 만든다')).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it('autoDelay 를 주지 않으면 지금처럼 열자마자 만든다(표 서랍·스킬 허브)', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const fn = stubApi({ '/api/skill/summary': (_u: string, b: Record<string, unknown>) => (b.id ? view() : view({ summary: null })) });
      mountScreen(<AiSummary target={{ id: 'a' }} />, '/');
      await waitFor(() => expect(postedTo(fn, '/api/skill/summary')).toEqual([{ id: 'a', refresh: false }]));
    } finally {
      vi.useRealTimers();
    }
  });

  it('버전이 바뀐 요약은 「이전 버전 기준」을 보이고 열 때 다시 만든다', async () => {
    let release: () => void = () => {};
    const posts: unknown[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, init?: RequestInit) => {
        if (!init?.body) return Promise.resolve(new Response(JSON.stringify(view({ stale: true })), { status: 200 }));
        posts.push(JSON.parse(String(init.body)));
        return new Promise<Response>((res) => {
          release = () => res(new Response(JSON.stringify(view({ src: '0.0.2' })), { status: 200 }));
        });
      })
    );
    mountScreen(<AiSummary target={{ ns: 'community', name: 'weekly' }} />, '/');
    expect(await screen.findByText('이전 버전(v0.0.1) 기준')).toBeInTheDocument();
    expect(posts).toEqual([{ ns: 'community', name: 'weekly', refresh: false }]);
    release();
    await waitFor(() => expect(screen.queryByText('이전 버전(v0.0.1) 기준')).toBeNull());
  });

  it('「다시 요약」은 refresh 로 보내고, 10분 안에 다시 누르면 안내를 보인다', async () => {
    let n = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string, init?: RequestInit) => {
        if (!init?.body) return Promise.resolve(new Response(JSON.stringify(view()), { status: 200 }));
        n += 1;
        return n === 1
          ? Promise.resolve(new Response(JSON.stringify(view({ summary: { ...BODY, one_line: '새 요약' } })), { status: 200 }))
          : Promise.resolve(new Response(JSON.stringify({ error: 'x', reason: 'too_soon' }), { status: 429 }));
      })
    );
    mountScreen(<AiSummary target={{ id: 'ma:skills/x' }} />, '/');
    await userEvent.click(await screen.findByRole('button', { name: '다시 요약' }));
    expect(await screen.findByText('새 요약')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: '다시 요약' }));
    expect(await screen.findByText(/다시 요약은 10분에 한 번/)).toBeInTheDocument();
    expect(screen.getByText('새 요약')).toBeInTheDocument();          // 실패해도 기존 요약은 남는다
  });

  it('LiteLLM 이 없거나 요약 경로가 없으면 요약은 숨기고 대화 단추만 남긴다', async () => {
    const fn = stubApi({ '/api/skill/summary': view({ enabled: false, summary: null }) });
    const first = mountScreen(<AiSummary target={{ id: 'a' }} actions={<button>AI 에게 더 묻기</button>} />, '/');
    expect(await screen.findByRole('button', { name: 'AI 에게 더 묻기' })).toBeInTheDocument();
    expect(screen.queryByTestId('ai-summary')).toBeNull();
    expect(postedTo(fn, '/api/skill/summary')).toHaveLength(0);
    first.unmount();
    const none = stubApi({});                                        // 옛 서버: 404
    mountScreen(<AiSummary target={{ id: 'a' }} actions={<button>AI 에게 더 묻기</button>} />, '/');
    expect(await screen.findByRole('button', { name: 'AI 에게 더 묻기' })).toBeInTheDocument();
    expect(postedTo(none, '/api/skill/summary')).toHaveLength(0);
  });

  it('요약은 글자 그대로 보인다(원문에서 온 링크·마크다운을 렌더하지 않는다)', async () => {
    stubApi({ '/api/skill/summary': view({ summary: { ...BODY, one_line: '[여기](http://evil.example) **굵게**' } }) });
    mountScreen(<AiSummary target={{ id: 'a' }} />, '/');
    const box = await screen.findByTestId('ai-summary');
    expect(within(box).getByText('[여기](http://evil.example) **굵게**')).toBeInTheDocument();
    expect(within(box).queryByRole('link')).toBeNull();
  });

  it('이 언어 요약을 만드는 동안 다른 언어 요약을 안내와 함께 보인다', async () => {
    let release: () => void = () => {};
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, init?: RequestInit) =>
        init?.body
          ? new Promise<Response>((res) => {
              release = () => res(new Response(JSON.stringify(view()), { status: 200 }));
            })
          : Promise.resolve(new Response(JSON.stringify(view({ summary: null, other: { lang: 'en', summary: { ...BODY, one_line: 'Makes reports' } } })), { status: 200 }))
      )
    );
    mountScreen(<AiSummary target={{ id: 'a' }} />, '/');
    expect(await screen.findByText('Makes reports')).toBeInTheDocument();
    expect(screen.getByText('AI 가 요약하는 중입니다…')).toBeInTheDocument();
    release();
    expect(await screen.findByText('주간 보고서를 만든다')).toBeInTheDocument();
  });
});

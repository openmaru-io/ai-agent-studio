/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ME_USER, mountScreen, rowByName, stubApi } from '@/test/mountScreen';

import { Models } from './Models';

const DATA = {
  litellm: { url: 'http://litellm:4000', reachable: true, auth: 'ok', key_source: 'env', prefix: 'cogentai-aas', hidden: 2 },
  totals: { litellm_models: 3, profiles_with_bad: 1, profiles_with_warn: 2, fallback_trace_jobs: 0, unused_models: 1 },
  models: [
    { id: 'qwen3', in_litellm: true, primary: ['ma', 'ops'], fallback: ['ma'], auxiliary: ['vision'], cron: [] },
    { id: 'ghost', in_litellm: false, primary: ['x'], fallback: [], auxiliary: [], cron: [] },
    { id: 'spare', in_litellm: true, primary: [], fallback: [], auxiliary: [], cron: [] },
  ],
  profiles: [
    {
      name: 'ma',
      has_config: true,
      primary: { model: 'qwen3', provider: 'litellm' },
      fallbacks: [{ model: 'ghost', provider: 'litellm' }],
      auxiliary: [{ task: 'vision', model: 'qwen3' }],
      cron_overrides: [{ jobs: ['a', 'b'], model: 'qwen3' }],
      issues: [{ level: 'bad', text: '폴백 모델이 LiteLLM 에 없습니다' }],
    },
    { name: 'bare', has_config: false, primary: null, fallbacks: [], auxiliary: [], cron_overrides: [], issues: [] },
  ],
};

afterEach(() => vi.unstubAllGlobals());

function mount(initial = '/models', data: unknown = DATA, probe: unknown = { ok: true, ms: 1234 }) {
  const fn = stubApi({ '/api/models/probe': probe, '/api/models': data });
  mountScreen(<Models />, initial);
  return fn;
}

describe('Models', () => {
  it('기본 모델 이름 옆에 「기본 모델」 뱃지를 보인다(2026-10-18)', async () => {
    mount('/models', { ...DATA, default_model: 'qwen3' });
    const row = await rowByName(/^qwen3/);
    expect(within(row).getByText('기본 모델')).toBeInTheDocument();
    expect(within(await rowByName(/^spare/)).queryByText('기본 모델')).toBeNull();
  });

  it('주소와 카드를 보이고 모델 탭에 LiteLLM 포함 여부 태그를 단다', async () => {
    mount();
    // 부제는 주소·키 출처 글자 대신 「CogentAI LiteLLM」 뱃지다. 주소와 키 출처는 풍선말에 둔다
    const badge = await screen.findByText('CogentAI LiteLLM');
    expect(badge.closest('[title]')).toHaveAttribute('title', 'http://litellm:4000 · 키 출처: env');
    expect(screen.queryByText('http://litellm:4000 · 키 출처: env')).toBeNull();
    // 보기 카드(2026-10-17-011): LiteLLM 모델 수·거르기와 문제 프로파일 수는 보기 카드의 둘째 줄이다
    expect(screen.getByRole('tab', { name: /^모델, \d+$/ })).toHaveAccessibleDescription(/^LiteLLM \d+ · cogentai-aas\* · 숨김 2$/);
    expect(screen.getByRole('tab', { name: /^프로파일별 설정, \d+$/ })).toHaveAccessibleDescription(/^문제 \d+ · 주의 2$/);
    expect(screen.getAllByText('LiteLLM 에 있음')).toHaveLength(2);
    expect(screen.getByText('LiteLLM 에 없음')).toBeInTheDocument();
    const row = await rowByName(/^qwen3/);
    expect(within(row).getByText('ma, ops')).toBeInTheDocument(); // 주 모델로 쓰는 프로파일 칸
    expect(within(row).getByText('ma')).toBeInTheDocument(); // 폴백으로 쓰는 프로파일 칸
    expect(screen.getByText('사용하지 않음')).toBeInTheDocument();
  });

  it('접두어 밖 모델에만 「AAS 모델 아님」 태그를 단다', async () => {
    const models = DATA.models.map((m) => ({ ...m, aas_model: m.id !== 'qwen3' }));
    mount('/models', { ...DATA, models });
    expect(await screen.findAllByText('AAS 모델 아님')).toHaveLength(1);
    expect(await rowByName(/^qwen3/)).toHaveTextContent('AAS 모델 아님');
  });

  it('접두어가 비면 모든 모델을 보인다고 적는다', async () => {
    mount('/models', { ...DATA, litellm: { ...DATA.litellm, prefix: '', hidden: 0 } });
    expect(await screen.findByText(/· 전체 표시$/)).toBeInTheDocument();
    expect(screen.queryByText('AAS 모델 아님')).not.toBeInTheDocument();
  });

  it('LiteLLM 에 닿지 못하면 이유와 검사가 빠졌다는 안내를 알림으로 보인다', async () => {
    mount('/models', { ...DATA, litellm: { ...DATA.litellm, reachable: false, auth: 'x', error: '연결 거부' } });
    expect(await screen.findByRole('alert')).toHaveTextContent(
      '연결 거부 (아래 목록은 프로파일 설정에 적힌 내용만으로 만들어서'
    );
  });

  it('점검을 누르면 POST 로 모델을 보내고 서랍에 응답 시간을, 닫은 뒤 목록 배지에도 보인다', async () => {
    const user = userEvent.setup();
    const fn = mount();
    await user.click(await rowByName(/^qwen3/));
    const dlg = await screen.findByRole('dialog', { name: 'qwen3' });
    // 서랍 본문은 페이지 등록부의 늦게 불러오는 본문이다(스펙 2026-10-28-014 D8) — 그려질 때까지 기다린다
    await user.click(await within(dlg).findByRole('button', { name: '점검' }));
    expect(await within(dlg).findByText('응답 1.2초')).toBeInTheDocument();
    const call = fn.mock.calls.find((c) => String(c[0]).startsWith('/api/models/probe'))!;
    expect(JSON.parse((call[1] as RequestInit).body as string)).toEqual({ model: 'qwen3' });
    expect((call[1] as RequestInit).headers).toMatchObject({ 'X-AAS': '1' });
    await user.click(within(dlg).getByRole('button', { name: '닫기' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(screen.getByText('응답 1.2초')).toBeInTheDocument();
  });

  // 스펙 2026-10-28-014 D8·D9: 모델 탭 행 서랍은 주소 ?open=<모델 id> 와 묶인다
  it('모델 행을 누르면 주소에 open 이 생기고, 닫으면 지워진다', async () => {
    const user = userEvent.setup();
    mount();
    await user.click(await rowByName(/^qwen3/));
    const dlg = await screen.findByRole('dialog', { name: 'qwen3' });
    expect(screen.getByTestId('loc')).toHaveTextContent(/^\/models\?open=qwen3$/);
    await user.click(within(dlg).getByRole('button', { name: '닫기' }));
    await waitFor(() => expect(screen.getByTestId('loc')).toHaveTextContent(/^\/models$/));
  });

  it('없는 모델의 링크는 서랍 안에 찾지 못했다고 알린다', async () => {
    mount('/models?open=gone');
    expect(await screen.findByText('모델 gone 을(를) 찾지 못했습니다. LiteLLM 이나 프로파일 설정에서 빠졌을 수 있습니다.')).toBeInTheDocument();
  });

  it('관리자가 아니면 점검 단추가 없다(모델 시험 호출은 관리자만, OMAI-1122)', async () => {
    const user = userEvent.setup();
    stubApi({ '/api/me': ME_USER, '/api/models': DATA });
    mountScreen(<Models />, '/models');
    await user.click(await rowByName(/^qwen3/));
    const dlg = await screen.findByRole('dialog', { name: 'qwen3' });
    await within(dlg).findByText('LiteLLM 에 있음'); // 본문이 그려진 뒤에 본다
    expect(within(dlg).queryByRole('button', { name: '점검' })).not.toBeInTheDocument();
  });

  it('점검이 실패하면 오류 글을 보이고, LiteLLM 에 없는 모델은 점검을 막는다', async () => {
    const user = userEvent.setup();
    mount('/models', DATA, { ok: false, ms: 0, error: '401 키 거절' });
    await user.click(await rowByName(/^qwen3/));
    let dlg = await screen.findByRole('dialog', { name: 'qwen3' });
    await user.click(within(dlg).getByRole('button', { name: '점검' }));
    expect(await within(dlg).findByText('401 키 거절')).toBeInTheDocument();
    await user.click(within(dlg).getByRole('button', { name: '닫기' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await user.click(await rowByName(/^ghost/));
    dlg = await screen.findByRole('dialog', { name: 'ghost' });
    expect(within(dlg).getByRole('button', { name: '점검' })).toBeDisabled();
  });

  it('서랍에서 쓰는 프로파일을 프로파일별 탭으로 잇는다', async () => {
    const user = userEvent.setup();
    mount();
    await user.click(await rowByName(/^qwen3/));
    const dlg = await screen.findByRole('dialog', { name: 'qwen3' });
    expect(within(dlg).getAllByRole('link', { name: 'ma' })[0]).toHaveAttribute('href', '/models?tab=profiles&q=ma');
    expect(within(dlg).getByText('vision')).toBeInTheDocument(); // 보조·크론 지정
  });

  it('프로파일별 탭: 문제 태그, 설정 없음 행, 서랍의 모델 설정', async () => {
    const user = userEvent.setup();
    mount('/models?tab=profiles');
    expect(await screen.findByText('문제')).toBeInTheDocument();
    expect(screen.getByText('설정 파일 없음')).toBeInTheDocument();
    await user.click(await rowByName(/^ma/));
    const dlg = await screen.findByRole('dialog', { name: 'ma' });
    expect(within(dlg).getAllByText(/litellm/).length).toBeGreaterThan(0); // 주 모델·폴백의 제공자
    expect(within(dlg).getByText('vision: qwen3')).toBeInTheDocument();
    expect(within(dlg).getByText('작업 2개: qwen3')).toBeInTheDocument();
    expect(within(dlg).getByText('폴백 모델이 LiteLLM 에 없습니다')).toBeInTheDocument();
    expect(within(dlg).getByRole('link', { name: 'ma 프로파일 설정(모델 바꾸기)' })).toHaveAttribute(
      'href',
      '/profiles?name=ma'
    );
  });
});

/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SloganSuggestButton } from '@/components/SloganSuggest';
import { DepartmentGoals } from '@/screens/settings/DepartmentGoals';
import { mountScreen, postedTo, stubApi } from '@/test/mountScreen';

const THREE = { suggestions: ['고객이 먼저 찾는 제품', '함께 빠르게 만든다', '작게 시작해 크게 키운다'] };

afterEach(() => vi.unstubAllGlobals());

describe('부서 슬로건 AI 추천(2026-10-17-015)', () => {
  it('설정의 입력 칸 옆 단추: 부서 이름으로 3개를 받고, 고른 것을 칸에 넣는다(저장하지 않는다)', async () => {
    const user = userEvent.setup();
    // 주소는 앞부분으로 고르므로 /suggest 를 먼저 둔다
    const fn = stubApi({ '/api/settings/goal/suggest': THREE, '/api/settings/goal': { ok: true } });
    mountScreen(<DepartmentGoals rows={[{ team: '영업', goal: '', people: 2 }]} max={60} canEdit />, '/settings');
    await user.click(screen.getByRole('button', { name: '영업 슬로건을 AI 로 추천받기' }));
    const dialog = await screen.findByRole('dialog', { name: '영업 슬로건 AI 추천' });
    const options = await within(dialog).findAllByRole('option');
    expect(options.map((o) => o.textContent)).toEqual(THREE.suggestions.map((x) => `${x}${x.length}자`)); // 글자 수는 공백을 포함한다(저장 한도와 같은 셈)
    expect(postedTo(fn, '/api/settings/goal/suggest')).toEqual([{ team: '영업', keywords: '' }]);
    await user.click(options[1]);
    await user.click(within(dialog).getByRole('button', { name: '이 슬로건 넣기' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.getByLabelText('영업')).toHaveValue('함께 빠르게 만든다');
    expect(fn.mock.calls.filter((c) => c[0] === '/api/settings/goal')).toHaveLength(0);
  });

  it('키워드를 적고 다시 추천받으면 키워드를 함께 보낸다', async () => {
    const user = userEvent.setup();
    const fn = stubApi({ '/api/settings/goal/suggest': THREE });
    mountScreen(<SloganSuggestButton team="AAS 개발팀" onPick={vi.fn()} />, '/');
    await user.click(screen.getByRole('button', { name: /슬로건을 AI 로 추천받기$/ }));
    const dialog = await screen.findByRole('dialog');
    await within(dialog).findAllByRole('option');
    await user.type(within(dialog).getByLabelText('키워드(선택)'), '속도, 고객');
    await user.click(within(dialog).getByRole('button', { name: '다시 추천' }));
    await waitFor(() => expect(postedTo(fn, '/api/settings/goal/suggest')).toHaveLength(2));
    expect(postedTo(fn, '/api/settings/goal/suggest')[1]).toEqual({ team: 'AAS 개발팀', keywords: '속도, 고객' });
  });

  it('부서 상세 창처럼 바로 저장하는 곳은 단추 글이 바뀌고, 저장이 끝나야 창이 닫힌다', async () => {
    const user = userEvent.setup();
    stubApi({ '/api/settings/goal/suggest': THREE });
    const onPick = vi.fn(() => Promise.resolve());
    mountScreen(<SloganSuggestButton team="영업" onPick={onPick} pickLabel="이 슬로건으로 저장" />, '/');
    await user.click(screen.getByRole('button', { name: /슬로건을 AI 로 추천받기$/ }));
    const dialog = await screen.findByRole('dialog');
    await within(dialog).findAllByRole('option');
    await user.click(within(dialog).getByRole('button', { name: '이 슬로건으로 저장' }));
    expect(onPick).toHaveBeenCalledWith('고객이 먼저 찾는 제품');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('서버 오류는 창 안에 보이고, 부서 이름이 없으면 단추를 누를 수 없다', async () => {
    const user = userEvent.setup();
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(JSON.stringify({ error: 'AI 추천을 쓸 수 없습니다(LiteLLM 이 설정되지 않음)', reason: 'not_configured' }), { status: 503 }))));
    mountScreen(<SloganSuggestButton team="영업" onPick={vi.fn()} />, '/');
    await user.click(screen.getByRole('button', { name: /슬로건을 AI 로 추천받기$/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent('AI 추천을 쓸 수 없습니다');
    expect(within(screen.getByRole('dialog')).getByRole('button', { name: '이 슬로건 넣기' })).toBeDisabled();
  });

  it('새 부서 추가 줄의 단추는 부서 이름을 적어야 켜진다', async () => {
    const user = userEvent.setup();
    stubApi({ '/api/settings/goal/suggest': THREE });
    mountScreen(<DepartmentGoals rows={[]} max={60} canEdit />, '/settings');
    expect(screen.getByRole('button', { name: 'AI 로 슬로건 추천받기' })).toBeDisabled();
    await user.type(screen.getByLabelText('목록에 없는 부서 이름'), '디자인');
    expect(screen.getByRole('button', { name: '디자인 슬로건을 AI 로 추천받기' })).toBeEnabled();
  });
});

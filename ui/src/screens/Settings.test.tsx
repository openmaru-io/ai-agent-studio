/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ME_USER, mountScreen, postedTo, stubApi } from '@/test/mountScreen';

import { identitySentence, Settings } from './Settings';

afterEach(() => vi.unstubAllGlobals());

const DATA = (over: Record<string, unknown> = {}) => ({
  company_name: '',
  default_company: 'OPENMARU, Inc.',
  effective_company: 'OPENMARU, Inc.',
  identity_sentence: 'You are CogentAI AAS Agent, built by OPENMARU, Inc.',
  max: 80,
  can_edit: true,
  ...over,
});

describe('Settings 회사 정보', () => {
  it('항목 제목 아래 내용은 제목 글자 자리에서 시작한다(들여 쓰기)', async () => {
    stubApi({ '/api/settings': DATA() });
    mountScreen(<Settings />, '/settings');
    const heads = await screen.findAllByRole('heading', { level: 3 });
    expect(heads.length).toBeGreaterThanOrEqual(3);
    for (const h of heads) {
      const body = h.closest('section')!.querySelector('.aas-section-body') as HTMLElement;
      expect(getComputedStyle(body).paddingLeft).toBe('22px');
    }
  });

  it('소개 문장은 마침표로 끝나는 회사 이름에 마침표를 더 붙이지 않는다', () => {
    expect(identitySentence('OPENMARU, Inc.')).toBe('You are CogentAI AAS Agent, built by OPENMARU, Inc.');
    expect(identitySentence('오픈마루')).toBe('You are CogentAI AAS Agent, built by 오픈마루.');
  });

  it('비어 있으면 기본 회사로 미리 보고, 입력하면 미리 보기가 바뀌고 저장하면 company_name 을 보낸다', async () => {
    const user = userEvent.setup();
    const fn = stubApi({ '/api/settings': (_u: string, b: Record<string, unknown>) => (b.company_name !== undefined ? { ok: true } : DATA()) });
    mountScreen(<Settings />, '/settings');
    expect(await screen.findByTestId('identity-preview')).toHaveTextContent('You are CogentAI AAS Agent, built by OPENMARU, Inc.');
    // 안내문은 Hermes 기본 문장을 설명하지 않는다
    expect(screen.getByText(/첫 문장을 직접 고친 성격은 그대로 둡니다/)).not.toHaveTextContent(/Hermes/);
    const save = screen.getByRole('button', { name: '저장' });
    expect(save).toBeDisabled();
    await user.type(screen.getByRole('textbox', { name: '회사 이름' }), '  오픈마루   주식회사 ');
    expect(screen.getByTestId('identity-preview')).toHaveTextContent('You are CogentAI AAS Agent, built by 오픈마루 주식회사.');
    await user.click(save);
    await waitFor(() => expect(postedTo(fn, '/api/settings')).toEqual([{ company_name: '오픈마루 주식회사' }]));
  });

  it('일반 사용자: 회사 이름·소개 문장은 보이지 않고 자기 부서 한 줄만 보이며 저장하면 그 부서로 보낸다(OMAI-1230)', async () => {
    const user = userEvent.setup();
    const fn = stubApi({
      '/api/me': ME_USER,
      '/api/settings/goal': { ok: true },
      '/api/settings': DATA({ can_edit: false, can_edit_goal: true, goal_scope: 'own', goal_max: 60, department_goals: [{ team: '영업', goal: '꾸준히', people: 4 }] }),
    });
    mountScreen(<Settings />, '/settings');
    const mine = await screen.findByRole('textbox', { name: '영업' });
    expect(screen.queryByRole('textbox', { name: '회사 이름' })).toBeNull();
    expect(screen.queryByTestId('identity-preview')).toBeNull();
    expect(screen.queryByRole('textbox', { name: '목록에 없는 부서 이름' })).toBeNull(); // 새 부서는 관리자만 만든다
    expect(screen.getByText(/자기 부서의 한 줄만/)).toBeInTheDocument();
    await user.clear(mine);
    await user.type(mine, '함께 만든다');
    await user.click(screen.getByRole('button', { name: '저장' }));
    await waitFor(() => expect(postedTo(fn, '/api/settings/goal')).toEqual([{ team: '영업', goal: '함께 만든다' }]));
  });

  it('일반 사용자인데 부서가 없으면 입력 칸 대신 관리자에게 부서를 넣어 달라는 안내를 보인다', async () => {
    stubApi({ '/api/me': ME_USER, '/api/settings': DATA({ can_edit: false, can_edit_goal: false, goal_scope: 'own', goal_max: 60, department_goals: [] }) });
    mountScreen(<Settings />, '/settings');
    expect(await screen.findByText(/부서가 정해지지 않아/)).toBeInTheDocument();
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.queryByRole('button', { name: '저장' })).toBeNull();
  });

  it('부서 슬로건·목표: 부서마다 한 줄을 보이고, 바꾼 줄만 저장하며, 비우면 지운다(스펙 2026-10-15-018)', async () => {
    const user = userEvent.setup();
    const fn = stubApi({
      '/api/settings/goal': { ok: true },
      '/api/settings': DATA({ goal_max: 60, department_goals: [{ team: '개발', goal: '빠르게 만든다', people: 3 }, { team: '영업', goal: '', people: 1 }] }),
    });
    mountScreen(<Settings />, '/settings');
    const dev = await screen.findByRole('textbox', { name: '개발' });
    expect(dev).toHaveValue('빠르게 만든다');
    expect(screen.getByText('7/60자 · 이 부서 사람 3명')).toBeInTheDocument();
    const saves = screen.getAllByRole('button', { name: '저장' });
    expect(saves.slice(1).every((b) => (b as HTMLButtonElement).disabled)).toBe(true); // 부서 줄의 저장은 바꾸기 전에 꺼져 있다
    await user.clear(dev);
    await user.type(dev, '  꾸준히   만든다 ');
    await user.click(screen.getAllByRole('button', { name: '저장' })[1]);
    await waitFor(() => expect(postedTo(fn, '/api/settings/goal')).toEqual([{ team: '개발', goal: '꾸준히 만든다' }]));
    await user.clear(dev);
    await user.click(screen.getAllByRole('button', { name: '저장' })[1]);
    await waitFor(() => expect(postedTo(fn, '/api/settings/goal')[1]).toEqual({ team: '개발', goal: '' }));
  });

  it('부서 문구가 상한을 넘으면 저장할 수 없고, 글꼴에 없는 글자는 빠진다고 알린다', async () => {
    const user = userEvent.setup();
    stubApi({ '/api/settings/goal': { ok: true }, '/api/settings': DATA({ goal_max: 10, department_goals: [{ team: '개발', goal: '', people: 0 }] }) });
    mountScreen(<Settings />, '/settings');
    const dev = await screen.findByRole('textbox', { name: '개발' });
    await user.type(dev, '가나다라마바사아자차카');
    expect(screen.getAllByRole('button', { name: '저장' })[1]).toBeDisabled();
    await user.clear(dev);
    await user.type(dev, '함께 😀');
    expect(screen.getByText(/이모지 같은 글자는 현수막에서 빠집니다/)).toBeInTheDocument();
  });

  it('목록에 없는 부서는 이름과 문구를 넣어 추가한다', async () => {
    const user = userEvent.setup();
    const fn = stubApi({ '/api/settings/goal': { ok: true }, '/api/settings': DATA({ goal_max: 60, department_goals: [] }) });
    mountScreen(<Settings />, '/settings');
    expect(await screen.findByText(/아직 알려진 부서가 없습니다/)).toBeInTheDocument();
    const add = screen.getByRole('button', { name: '추가' });
    expect(add).toBeDisabled();
    await user.type(screen.getByRole('textbox', { name: '목록에 없는 부서 이름' }), '기획');
    await user.type(screen.getByRole('textbox', { name: '문구' }), '방향을 정한다');
    await user.click(add);
    await waitFor(() => expect(postedTo(fn, '/api/settings/goal')).toEqual([{ team: '기획', goal: '방향을 정한다' }]));
  });

  it('관리자가 아니면 회사 이름·소개 문장을 보이지 않는다(OMAI-1122). 화면은 열리고 부서 문구 구역만 있다(OMAI-1230)', async () => {
    stubApi({ '/api/me': ME_USER, '/api/settings': DATA({ company_name: 'ACME', can_edit: false, can_edit_goal: false, goal_scope: 'own', goal_max: 60, department_goals: [] }) });
    mountScreen(<Settings />, '/settings');
    expect(await screen.findByText('부서 슬로건·목표')).toBeInTheDocument();
    expect(screen.queryByText('회사 이름')).not.toBeInTheDocument();
    expect(screen.queryByTestId('identity-preview')).not.toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: '회사 이름' })).not.toBeInTheDocument();
    expect(screen.queryByText('ACME')).not.toBeInTheDocument();
  });

  it('서버가 바꿀 수 없다고 하면(can_edit 거짓) 입력할 수 없고 저장 단추가 없다', async () => {
    stubApi({ '/api/settings': DATA({ company_name: 'ACME', can_edit: false }) });
    mountScreen(<Settings />, '/settings');
    expect(await screen.findByRole('textbox', { name: '회사 이름' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: '저장' })).not.toBeInTheDocument();
    expect(screen.getByText('관리자만 바꿀 수 있습니다.')).toBeInTheDocument();
    expect(screen.getByTestId('identity-preview')).toHaveTextContent('You are CogentAI AAS Agent, built by ACME.');
  });
});

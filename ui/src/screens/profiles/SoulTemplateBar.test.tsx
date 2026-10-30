/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { mountScreen, postedTo, stubApi } from '@/test/mountScreen';

import { SoulTemplateBar } from './SoulTemplateBar';
import type { SoulTemplateHint } from './types';

afterEach(() => vi.unstubAllGlobals());

const T = (id: string, name: string, rev = 0) => ({
  id,
  lang: 'ko',
  name,
  body: '## 역할\n',
  keywords: name,
  builtin: true,
  modified: rev > 0,
  deleted: false,
  rev,
  updated_by: '',
  updated_at: '',
});
const api = () =>
  stubApi({
    '/api/soul-templates/render': { content: 'You are CogentAI AAS Agent, built by OPENMARU, Inc.\n\n## 역할\n인사', rev: 2 },
    '/api/soul-templates': {
      templates: [T('marketing', '마케팅'), T('hr', '인사', 2)],
      langs: ['ko', 'en'],
      placeholders: [],
      can_edit: true,
      identity_sentence: '',
    },
  });
const hint = (over: Partial<SoulTemplateHint> = {}): SoulTemplateHint => ({
  use: null,
  is_default: true,
  department: '인사팀',
  recommend: null,
  ...over,
});

describe('프로파일 SOUL 창의 템플릿에서 시작', () => {
  it('기본 SOUL 뿐이면 주인의 부서에 맞는 추천을 보이고, 누르면 이 프로파일 기준으로 채운 글로 편집기를 연다', async () => {
    const user = userEvent.setup();
    const fn = api();
    const onStart = vi.fn();
    mountScreen(
      <SoulTemplateBar
        name="ma"
        hint={hint({ recommend: { id: 'hr', lang: 'ko', name: '인사' } })}
        onStart={onStart}
      />,
      '/profiles'
    );
    expect(await screen.findByText(/추천: 인사/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '이 템플릿으로 시작' }));
    await waitFor(() => expect(onStart).toHaveBeenCalled());
    expect(postedTo(fn, '/api/soul-templates/render')).toEqual([{ id: 'hr', lang: 'ko', profile: 'ma' }]);
    expect(onStart.mock.calls[0][0]).toContain('You are CogentAI AAS Agent');
    expect(onStart.mock.calls[0][1]).toEqual({ id: 'hr', lang: 'ko', rev: 2, name: '인사' });
  });

  it('적용한 뒤 템플릿이 바뀌면 「다시 적용」 안내를 보인다', async () => {
    api();
    const use = { template_id: 'hr', lang: 'ko', rev: 1, name: '인사', exists: true, current_rev: 2, changed: true };
    mountScreen(<SoulTemplateBar name="ma" hint={hint({ is_default: false, use })} onStart={vi.fn()} />, '/profiles');
    expect(await screen.findByText(/템플릿이 바뀜/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '다시 적용' })).toBeInTheDocument();
  });

  it('템플릿을 골라 편집기로 연다', async () => {
    const user = userEvent.setup();
    const onStart = vi.fn();
    api();
    mountScreen(<SoulTemplateBar name="ma" hint={hint({ is_default: false })} onStart={onStart} />, '/profiles');
    await user.click(await screen.findByRole('button', { name: '템플릿에서 시작' }));
    await user.selectOptions(screen.getByRole('combobox', { name: '템플릿 고르기' }), 'marketing.ko');
    await user.click(screen.getByRole('button', { name: '편집기로 열기' }));
    await waitFor(() => expect(onStart).toHaveBeenCalled());
  });
});

/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { mountScreen, postedTo, stubApi } from '@/test/mountScreen';

import { type SoulTemplate, SoulTemplates, summaryOf } from './SoulTemplates';

afterEach(() => vi.unstubAllGlobals());

const tpl = (over: Partial<SoulTemplate> = {}): SoulTemplate => ({
  id: 'marketing',
  lang: 'ko',
  name: '마케팅',
  body: '## 역할\n{company} {department} 소속 마케팅 담당 에이전트다.\n\n## 하는 일\n- 기획\n',
  keywords: '마케팅, marketing',
  builtin: true,
  modified: false,
  deleted: false,
  rev: 0,
  updated_by: '',
  updated_at: '',
  ...over,
});
const LIST = (over: Record<string, unknown> = {}) => ({
  templates: [
    tpl(),
    tpl({ id: 'u_1', name: '보안', builtin: false, rev: 2, keywords: '보안' }),
    tpl({ id: 'hr', name: '인사', deleted: true }),
  ],
  langs: ['ko', 'en'],
  placeholders: ['company', 'department', 'role', 'agent'],
  can_edit: true,
  identity_sentence: 'You are CogentAI AAS Agent, built by OPENMARU, Inc.',
  ...over,
});

describe('SOUL 템플릿', () => {
  it('목록 둘째 줄은 「## 역할」 다음 첫 문장이다', () => {
    expect(summaryOf('## 역할\n첫 문장.\n## 하는 일\n- a')).toBe('첫 문장.');
  });

  it('지운 템플릿은 「지움」 탭에만 있고, 행을 누르면 서랍에서 고쳐 지금 버전과 함께 저장한다', async () => {
    const user = userEvent.setup();
    const fn = stubApi({
      '/api/soul-templates/render': { content: 'You are CogentAI AAS Agent, built by OPENMARU, Inc.\n\n## 역할\n…' },
      '/api/soul-templates': (_u: string, b: Record<string, unknown>) =>
        b.op ? { ok: true, template: tpl({ rev: 1 }) } : LIST(),
    });
    mountScreen(<SoulTemplates />, '/soul-templates');
    expect((await screen.findAllByText('보안')).length).toBeGreaterThan(0);
    expect(screen.queryByText('인사')).not.toBeInTheDocument();
    await user.click(screen.getByText('마케팅'));
    const body = await screen.findByRole('textbox', { name: '템플릿 본문' });
    fireEvent.change(body, { target: { value: '## 역할\n고침\n' } });
    await user.click(screen.getByRole('button', { name: '저장' }));
    await waitFor(() =>
      expect(postedTo(fn, '/api/soul-templates').filter((b) => b.op)).toEqual([
        expect.objectContaining({ op: 'save', id: 'marketing', lang: 'ko', body: '## 역할\n고침\n', base_rev: 0 }),
      ])
    );
  });

  it('이전 버전 줄의 「보기/접기」는 보이는 글자는 짧고 접근 이름에 줄 제목이 들어간다(스펙 2026-10-19-005 G12·R15)', async () => {
    const user = userEvent.setup();
    stubApi({
      '/api/soul-templates': (u: string) =>
        u.includes('?id=')
          ? {
              versions: [
                { rev: 1, ts: '2026-10-19T10:00:00', by: 'a@x.com', note: '', body: '## 역할\n고침\n' },
                { rev: 0, ts: '2026-10-01T10:00:00', by: '', note: '', body: '## 역할\n처음\n' },
              ],
            }
          : LIST(),
    });
    mountScreen(<SoulTemplates />, '/soul-templates');
    await user.click(await screen.findByText('마케팅'));
    await user.click(await screen.findByRole('button', { name: '이전 버전' }));
    const first = await screen.findByRole('button', { name: '처음 내용 보기' });
    expect(first).toHaveTextContent(/^보기$/);
    expect(screen.getByRole('button', { name: '버전 1 보기' })).toHaveAttribute('aria-expanded', 'false');
    await user.click(first);
    const hide = screen.getByRole('button', { name: '처음 내용 접기' });
    expect(document.getElementById(hide.getAttribute('aria-controls') as string)).toHaveTextContent('처음');
  });

  it('미리 보기는 서버가 회사 문장을 붙여 채운 글을 보인다', async () => {
    const user = userEvent.setup();
    stubApi({
      '/api/soul-templates/render': {
        content: 'You are CogentAI AAS Agent, built by OPENMARU, Inc.\n\n## 역할\nOPENMARU, Inc. 소속',
      },
      '/api/soul-templates': LIST(),
    });
    mountScreen(<SoulTemplates />, '/soul-templates?tpl=marketing.ko');
    await user.click(await screen.findByRole('button', { name: '미리 보기' }));
    await waitFor(() =>
      expect(screen.getByTestId('soul-template-preview')).toHaveTextContent(
        'You are CogentAI AAS Agent, built by OPENMARU, Inc.'
      )
    );
  });

  it('관리자가 아니면 새 템플릿·저장 단추가 없고 지운 탭도 없다', async () => {
    stubApi({ '/api/soul-templates': LIST({ can_edit: false, templates: [tpl()] }) });
    mountScreen(<SoulTemplates />, '/soul-templates?tpl=marketing.ko');
    expect(await screen.findByRole('textbox', { name: '템플릿 본문' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '저장' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '새 템플릿' })).not.toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: /지움/ })).not.toBeInTheDocument();
  });

  it('고친 기본 템플릿은 서랍 머리 단추로 처음으로 되돌린다(OMAI-1135)', async () => {
    const user = userEvent.setup();
    const fn = stubApi({
      '/api/soul-templates': (_u: string, b: Record<string, unknown>) =>
        b.op ? { ok: true, template: tpl() } : LIST({ templates: [tpl({ modified: true, rev: 3 })] }),
    });
    mountScreen(<SoulTemplates />, '/soul-templates?tpl=marketing.ko');
    await screen.findByRole('dialog');
    const head = document.querySelector('[data-drawer-head]') as HTMLElement;
    expect(await within(head).findByRole('button', { name: '복제' })).toBeInTheDocument(); // 목록을 받은 뒤 그려진다
    await user.click(await within(head).findByRole('button', { name: '처음으로 되돌리기' }));
    const box = await screen.findByRole('dialog', { name: '처음으로 되돌리기' });
    await user.click(within(box).getByRole('button', { name: '처음으로 되돌리기' }));
    await waitFor(() =>
      expect(postedTo(fn, '/api/soul-templates').filter((b) => b.op)).toEqual([
        { op: 'reset', id: 'marketing', lang: 'ko' },
      ])
    );
  });

  it('관리자는 부서가 없을 때 쓸 템플릿을 고르고 op: default 로 저장한다(스펙 2026-10-14-003 리뷰 D9)', async () => {
    const user = userEvent.setup();
    const fn = stubApi({
      '/api/soul-templates': (_u: string, b: Record<string, unknown>) =>
        b.op ? { default_template: 'marketing.ko' } : LIST({ default_template: '' }),
    });
    mountScreen(<SoulTemplates />, '/soul-templates');
    const sel = await screen.findByRole('combobox', { name: '부서가 없을 때 쓸 템플릿' });
    await user.selectOptions(sel, 'marketing.ko');
    await waitFor(() => expect(postedTo(fn, '/api/soul-templates')).toEqual([{ op: 'default', id: 'marketing', lang: 'ko' }]));
  });
});

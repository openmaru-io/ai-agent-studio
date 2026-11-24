/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */
// 보호 스킬 설치 규칙 대화상자(cogentai-aas-docs 스펙 2026-11-24-001 6절, R2)
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { checkRulesText, type RulesView } from '@/lib/protectedRules';
import { mountScreen, postedTo, stubApi } from '@/test/mountScreen';

import { ProtectedRules } from './ProtectedRulesEditor';

const CASES = JSON.parse(readFileSync(resolve(process.cwd(), '../tests/fixtures/protected_rules_cases.json'), 'utf-8')) as {
  limits: RulesView['limits'];
  cases: { name: string; text: string; check: string | null; line: number }[];
};

const VIEW: RulesView = {
  rev: 3,
  text: '- 담당 부서를 적는다.',
  base_version: '0.8.5',
  author: 'kim@corp.example',
  ts: '2026-11-24T10:12:00+09:00',
  note: '',
  source_version: '0.8.6',
  versions: [
    { rev: 3, author: 'kim@corp.example', ts: '2026-11-24T10:12:00+09:00', chars: 13, note: '' },
    { rev: 2, author: 'kim@corp.example', ts: '2026-11-24T09:00:00+09:00', chars: 0, note: '규칙 지움' },
  ],
  applied_rev: 3,
  apply_state: 'applied',
  clone_of: '',
  base_stale: false,
  can_edit: true,
  enabled: true,
  reads_rules: true,
  fixed_rules: '- 개인정보를 요청하지 않는다',
  limits: CASES.limits,
};
const RULES = '/api/protected-skills/rules';

const stub = (view: Partial<RulesView> = {}, extra: Record<string, unknown> = {}) =>
  stubApi({
    [`${RULES}/preview`]: { ok: true, rev: (view.rev ?? VIEW.rev) + 1, tail: '## 이 설치의 규칙\n\n…', source_tail: '원본 끝' },
    [`${RULES}/ack`]: { ok: true, rev: 3, base_version: '0.8.6' },
    [`${RULES}/restore`]: { ok: true, rev: 4 },
    [`${RULES}?profile=p1&skill=s1&rev=`]: { rev: 2, text: '' },
    [RULES]: (url: string) => (url.startsWith(RULES + '?') ? { ...VIEW, ...view } : { ok: true, rev: 4, apply_state: 'pending' }),
    ...extra,
  });

const open = async (user: ReturnType<typeof userEvent.setup>, name = '설치 규칙') => {
  await user.click(await screen.findByRole('button', { name }));
  return screen.findByRole('dialog', { name: 's1 · 설치 규칙' });
};

beforeEach(() => localStorage.clear());
afterEach(cleanup);

describe('글 검사는 서버와 같은 사례를 쓴다', () => {
  it('tests/fixtures/protected_rules_cases.json 의 구조 사례(비밀값 제외)가 서버 판정과 같다', () => {
    for (const c of CASES.cases) {
      if (c.check === 'secret') continue;                     // 비밀값은 서버 미리보기가 판정한다(D8)
      const got = checkRulesText(c.text, CASES.limits.max_chars);
      expect(got, c.name).toEqual(c.check === null ? null : [c.check, c.line]);
    }
    expect(checkRulesText('가'.repeat(CASES.limits.max_chars + 1))).toEqual(['length', 0]);
  });
});

describe('설치 규칙 단추와 대화상자', () => {
  it('쓸 수 있으면 「설치 규칙」과 규칙 판 Pill, 없으면 「설치 규칙 보기」', async () => {
    stub();
    mountScreen(<ProtectedRules profile="p1" skill="s1" />, '/skills');
    expect(await screen.findByRole('button', { name: '설치 규칙' })).toBeInTheDocument();
    expect(await screen.findByText('규칙 버전 3')).toBeInTheDocument();
    cleanup();
    stub({ can_edit: false });
    mountScreen(<ProtectedRules profile="p1" skill="s1" />, '/skills');
    expect(await screen.findByRole('button', { name: '설치 규칙 보기' })).toBeInTheDocument();
  });

  it('머리 줄 · 반영 상태 · 안내 · 접힌 「바꿀 수 없는 것」 · 판 목록의 지운 판', async () => {
    const user = userEvent.setup();
    stub();
    mountScreen(<ProtectedRules profile="p1" skill="s1" />, '/skills');
    const dlg = await open(user);
    expect(await within(dlg).findByText('원본 버전 0.8.6 · 규칙 버전 3')).toBeInTheDocument();
    expect(within(dlg).getByRole('status')).toHaveTextContent('반영됨(버전 3)');
    expect(within(dlg).getByText(/처리 정보 줄에서 「설치 규칙 판 N」/)).toBeInTheDocument();
    expect(within(dlg).getByText(/고객이 직접 고치는 문구/)).toBeInTheDocument();
    expect(within(dlg).getByText('바꿀 수 없는 것')).toBeInTheDocument();
    expect(within(dlg).queryByText(/이 스킬은 설치 규칙을 읽는다고/)).not.toBeInTheDocument();
  });

  it('반영 대기 · 실패, 읽지 않는 스킬 경고, 고정 절이 없으면 칸을 숨김', async () => {
    const user = userEvent.setup();
    stub({ apply_state: 'pending', applied_rev: 2, reads_rules: false, fixed_rules: '' });
    mountScreen(<ProtectedRules profile="p1" skill="s1" />, '/skills');
    const dlg = await open(user);
    expect(await within(dlg).findByRole('status')).toHaveTextContent('반영 대기(버전 3)');
    expect(within(dlg).getByText(/이 스킬은 설치 규칙을 읽는다고 적혀 있지 않습니다.*OPENMARU 에 스킬 갱신을 요청/)).toBeInTheDocument();
    expect(within(dlg).queryByText('바꿀 수 없는 것')).not.toBeInTheDocument();
    cleanup();
    stub({ apply_state: 'failed' });
    mountScreen(<ProtectedRules profile="p1" skill="s1" />, '/skills');
    const dlg2 = await open(user);
    expect(await within(dlg2).findByRole('status')).toHaveTextContent('반영 실패(「확인할 것」을 보세요)');
  });

  it('읽기 전용 문구 셋(복제본 · 꺼짐 · 권한)', async () => {
    const user = userEvent.setup();
    for (const [view, text] of [
      [{ clone_of: 'team-a', can_edit: false }, 'MindWiki 자동화 복제본입니다. 원래 프로파일 team-a 의 규칙을 그대로 씁니다'],
      [{ enabled: false, can_edit: false, apply_state: 'off' as const }, '이 스킬이 꺼져 있습니다. 다시 켜면 이 규칙으로 씁니다'],
      [{ can_edit: false }, '편집 권한이 있는 사람(소유자·팀 관리자·「편집」으로 공유받은 사람·관리자)만 고칩니다'],
    ] as [Partial<RulesView>, string][]) {
      stub(view);
      mountScreen(<ProtectedRules profile="p1" skill="s1" />, '/skills');
      const dlg = await open(user, '설치 규칙 보기');
      expect((await within(dlg).findAllByText(text))[0]).toBeInTheDocument();
      expect(within(dlg).queryByRole('button', { name: '규칙 지우기' })).not.toBeInTheDocument();
      expect(within(dlg).queryByRole('button', { name: /바뀐 줄 확인/ })).not.toBeInTheDocument();   // 읽기만 되면 고치기 모드로 열지 않는다(2026-11-24 OKE)
      cleanup();
    }
  });

  it('고쳐 저장하면 미리보기로 비밀값을 보고 base_rev 와 함께 보낸다', async () => {
    const user = userEvent.setup();
    const fn = stub();
    mountScreen(<ProtectedRules profile="p1" skill="s1" />, '/skills');
    const dlg = await open(user);
    const area = await within(dlg).findByRole('textbox', { name: /설치 규칙 고치기/ });
    await user.type(area, '\n- 맺음말 뒤에 부서 이름');
    await user.click(within(dlg).getByRole('button', { name: /바뀐 줄 확인/ }));
    expect(await within(dlg).findByTestId('rules-preview')).toHaveTextContent('원본 끝');   // 저장 전 사본 끝 모양(D12)
    await user.click(await within(dlg).findByRole('button', { name: '이대로 저장' }));
    await waitFor(() =>
      expect(postedTo(fn, RULES).filter((b) => 'base_rev' in b)).toEqual([
        { profile: 'p1', skill: 's1', text: '- 담당 부서를 적는다.\n- 맺음말 뒤에 부서 이름', base_rev: 3, note: '' },
      ])
    );
    expect(postedTo(fn, `${RULES}/preview`)[0]).toEqual({ profile: 'p1', skill: 's1', text: '- 담당 부서를 적는다.\n- 맺음말 뒤에 부서 이름' });
    expect(await screen.findByText('60초 안에 반영됩니다(대기 중)')).toBeInTheDocument();
  });

  it('저장 뒤 반영될 때까지 poll_s 마다 다시 읽어 「반영됨」으로 바뀐다(2026-11-24 실화면에서 멈춘 회귀)', async () => {
    const user = userEvent.setup();
    let savedAt = 0;
    stub({}, {
      [RULES]: (url: string) => {
        if (!url.startsWith(RULES + '?')) {
          savedAt = Date.now();
          return { ok: true, rev: 4, apply_state: 'pending' };
        }
        const slow = { ...VIEW.limits, poll_s: 0.3 };
        if (!savedAt) return { ...VIEW, limits: slow };
        const age = Date.now() - savedAt;
        // 저장 직후 첫 읽기는 아직 옛 판(판 3 반영됨)일 수 있다 — 이 값으로 다시 읽기를 멈추면 안 된다(2026-11-24 실화면 회귀)
        if (age < 300) return { ...VIEW, limits: slow };
        const done = age > 900;
        return { ...VIEW, rev: 4, applied_rev: done ? 4 : 3, apply_state: done ? 'applied' : 'pending', limits: slow };
      },
    });
    mountScreen(<ProtectedRules profile="p1" skill="s1" />, '/skills');
    const dlg = await open(user);
    await user.type(await within(dlg).findByRole('textbox', { name: /설치 규칙 고치기/ }), '!');
    await user.click(within(dlg).getByRole('button', { name: /바뀐 줄 확인/ }));
    await user.click(await within(dlg).findByRole('button', { name: '이대로 저장' }));
    expect(await within(dlg).findByText('반영됨(버전 4)', {}, { timeout: 3000 })).toBeInTheDocument();
  });

  it('구조를 깨는 줄은 줄 번호와 함께 막고, 있던 규칙을 비워 저장하지 못한다', async () => {
    const user = userEvent.setup();
    stub();
    mountScreen(<ProtectedRules profile="p1" skill="s1" />, '/skills');
    const dlg = await open(user);
    const area = await within(dlg).findByRole('textbox', { name: /설치 규칙 고치기/ });
    await user.type(area, '\n## 다른 절');
    await user.click(within(dlg).getByRole('button', { name: /바뀐 줄 확인/ }));
    expect(await within(dlg).findByText('2 번째 줄: # · ## 제목은 쓸 수 없습니다(### 부터 씁니다)')).toBeInTheDocument();
    expect(within(dlg).getByRole('button', { name: '이대로 저장' })).toBeDisabled();
    await user.click(within(dlg).getByRole('button', { name: '더 고치기' }));
    await user.clear(area);
    await user.click(within(dlg).getByRole('button', { name: /바뀐 줄 확인/ }));
    expect(await within(dlg).findByText('있던 규칙을 비우려면 「규칙 지우기」를 쓰세요')).toBeInTheDocument();
  });

  it('서버가 비밀값으로 거절하면 걸린 줄 번호로 알린다', async () => {
    const user = userEvent.setup();
    stub({}, {
      [`${RULES}/preview`]: () =>
        new Response(JSON.stringify({ error: '2 번째 줄을 고치세요', reason: 'invalid_text', check: 'secret', line: 2, field: 'text' }), { status: 422 }),
    });
    mountScreen(<ProtectedRules profile="p1" skill="s1" />, '/skills');
    const dlg = await open(user);
    await user.type(await within(dlg).findByRole('textbox', { name: /설치 규칙 고치기/ }), '\nKEY=abc');
    await user.click(within(dlg).getByRole('button', { name: /바뀐 줄 확인/ }));
    expect(await within(dlg).findByText('2 번째 줄: 비밀값처럼 보이는 글은 쓸 수 없습니다')).toBeInTheDocument();
  });

  it('다른 사람이 먼저 저장하면(409) 고치던 글을 두고 바뀐 줄을 다시 보게 한다', async () => {
    const user = userEvent.setup();
    stub({}, {
      [RULES]: (url: string) =>
        url.startsWith(RULES + '?')
          ? VIEW
          : new Response(JSON.stringify({ error: 'busy', reason: 'busy', current: { rev: 4, author: 'lee', ts: '' } }), { status: 409 }),
    });
    mountScreen(<ProtectedRules profile="p1" skill="s1" />, '/skills');
    const dlg = await open(user);
    const area = await within(dlg).findByRole('textbox', { name: /설치 규칙 고치기/ });
    await user.type(area, '!');
    await user.click(within(dlg).getByRole('button', { name: /바뀐 줄 확인/ }));
    await user.click(await within(dlg).findByRole('button', { name: '이대로 저장' }));
    expect(await within(dlg).findByText('다른 사람이 먼저 저장했습니다. 바뀐 줄을 보고 다시 저장하세요')).toBeInTheDocument();
    expect((area as HTMLTextAreaElement).value).toBe('- 담당 부서를 적는다.!');
  });

  it('이전 버전 목록에서 고른 버전으로 되돌린다(2026-11-24 OKE: 버튼이 없던 회귀)', async () => {
    const user = userEvent.setup();
    const fn = stub({}, { [`${RULES}?profile=p1&skill=s1&rev=`]: { rev: 2, text: '' } });
    mountScreen(<ProtectedRules profile="p1" skill="s1" />, '/skills');
    const dlg = await open(user);
    await user.click(within(dlg).getByRole('button', { name: '취소' }));
    await user.click(await within(dlg).findByRole('button', { name: '이전 버전 1' }));
    const restore = await within(dlg).findAllByRole('button', { name: '되돌리기' });
    await user.click(restore[0]);
    const ask = await screen.findByRole('dialog', { name: '확인' });                // TextEditor 의 되돌리기 확인 창
    await user.click(within(ask).getByRole('button', { name: '확인' }));
    await waitFor(() => expect(postedTo(fn, `${RULES}/restore`)).toEqual([{ profile: 'p1', skill: 's1', rev: 2, base_rev: 3 }]));
  });

  it('규칙 지우기는 확인을 거쳐 빈 글 판을 저장한다', async () => {
    const user = userEvent.setup();
    const fn = stub();
    mountScreen(<ProtectedRules profile="p1" skill="s1" />, '/skills');
    const dlg = await open(user);
    await user.click(await within(dlg).findByRole('button', { name: '규칙 지우기' }));
    const ask = await screen.findByRole('dialog', { name: '설치 규칙을 지울까요?' });
    expect(within(ask).getByText('모든 사본에서 이 절을 뺍니다. 이전 버전 기록은 남습니다')).toBeInTheDocument();
    await user.click(within(ask).getByRole('button', { name: '규칙 지우기' }));
    await waitFor(() => expect(postedTo(fn, RULES).filter((b) => 'base_rev' in b)).toEqual([{ profile: 'p1', skill: 's1', text: '', base_rev: 3, note: '규칙 지움' }]));
    expect(await screen.findByText('규칙을 지웠습니다')).toBeInTheDocument();
  });

  it('원본이 올랐으면 알림 띠와 「이 원본 판에서 다시 확인함」(새 판 없이 ack)', async () => {
    const user = userEvent.setup();
    const fn = stub({ base_stale: true, source_version: '0.9.0' });
    mountScreen(<ProtectedRules profile="p1" skill="s1" />, '/skills');
    const dlg = await open(user);
    expect(await within(dlg).findByText('원본이 0.9.0 버전입니다. 규칙은 0.8.5 버전에서 썼습니다')).toBeInTheDocument();
    await user.click(within(dlg).getByRole('button', { name: '이 원본 버전에서 다시 확인함' }));
    await waitFor(() => expect(postedTo(fn, `${RULES}/ack`)).toEqual([{ profile: 'p1', skill: 's1', rev: 3 }]));
  });

  it('GET 이 실패하면 다시 읽기', async () => {
    const user = userEvent.setup();
    stub({}, { [RULES]: () => new Response(JSON.stringify({ error: 'x' }), { status: 500 }) });
    mountScreen(<ProtectedRules profile="p1" skill="s1" />, '/skills');
    const dlg = await open(user);
    expect(await within(dlg).findByText('설치 규칙을 읽지 못했습니다')).toBeInTheDocument();
    expect(within(dlg).getByRole('button', { name: '다시 읽기' })).toBeInTheDocument();
  });
});

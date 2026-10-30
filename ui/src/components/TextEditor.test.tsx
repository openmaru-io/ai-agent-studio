/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/lib/api';

import { AppProviders } from './AppProviders';
import { Doc, normalizeCheck, TextEditor, TextEditorProps } from './TextEditor';

const DOC: Doc = { lines: ['# 제목', '- 가', '본문'], sha: 'sha1', versions: 2 };

function Host(over: Partial<TextEditorProps> & { doc?: Doc } = {}) {
  const [doc, setDoc] = useState<Doc>(over.doc ?? DOC);
  const props: TextEditorProps = {
    label: 'SOUL',
    doc,
    editable: true,
    draftKey: 'k1',
    filename: 'SOUL.md',
    save: vi.fn().mockResolvedValue(undefined),
    reload: async () => setDoc({ ...doc, sha: 'sha2' }),
    ...over,
  };
  return <TextEditor {...props} doc={doc} />;
}
const mount = (over: Partial<TextEditorProps> & { doc?: Doc } = {}) =>
  render(
    <AppProviders>
      <Host {...over} />
    </AppProviders>
  );
const area = () => screen.getByRole('textbox', { name: /SOUL 고치기/ }) as HTMLTextAreaElement;

beforeEach(() => localStorage.clear());
afterEach(() => vi.useRealTimers());

describe('TextEditor 보기', () => {
  it('마크다운으로 그리고 줄·글자 수와 가린 줄 수를 보인다', () => {
    mount({ doc: { ...DOC, masked_lines: [3, 4] } });
    expect(screen.getByRole('heading', { level: 1, name: '제목' })).toBeInTheDocument();
    expect(screen.getByText(/3줄 · 11자 · 비밀값으로 보이는 2줄은 가렸습니다/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '고치기' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '이전 버전 2' })).toBeInTheDocument();
  });

  it('원문 보기는 줄마다 보이고 다시 누르면 돌아온다', async () => {
    const user = userEvent.setup();
    mount();
    await user.click(screen.getByRole('button', { name: '원문 보기' }));
    // 원문은 고칠 때와 같은 Monaco 편집기(보기 전용)로 보인다. 시험에서는 읽기 전용 입력칸이 대신한다.
    const raw = await screen.findByRole('textbox', { name: 'SOUL' });
    expect(raw).toHaveAttribute('readonly');
    expect((raw as HTMLTextAreaElement).value).toContain('# 제목');
    await user.click(screen.getByRole('button', { name: '보기 좋게' }));
    expect(screen.getByRole('heading', { name: '제목' })).toBeInTheDocument();
  });

  it('편집할 수 없으면 이유를 보이고 고치기 버튼이 없다. 내용이 없으면 쓰기', () => {
    mount({ editable: false, whyNot: '관리자만 고칠 수 있습니다' });
    expect(screen.getByText('관리자만 고칠 수 있습니다')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '고치기' })).not.toBeInTheDocument();
  });

  it('빈 문서는 안내와 쓰기 버튼', () => {
    mount({ doc: { lines: [], sha: 'e' } });
    expect(screen.getByText('아직 내용이 없습니다.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '쓰기' })).toBeInTheDocument();
  });
});

describe('TextEditor 고치기와 저장', () => {
  it('고치면 저장 안 됨 표시가 켜지고 바뀐 줄 확인 버튼이 풀린다', async () => {
    const user = userEvent.setup();
    mount();
    await user.click(screen.getByRole('button', { name: '고치기' }));
    expect(screen.getByText(/바뀐 것 없음/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /바뀐 줄 확인/ })).toBeDisabled();
    await user.type(area(), '!');
    expect(screen.getByText(/● 저장하지 않음/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /바뀐 줄 확인/ })).toBeEnabled();
  });

  it('바뀐 줄 확인 → 메모와 함께 저장하면 save(내용, sha, 메모) 후 보기로 돌아온다', async () => {
    const user = userEvent.setup();
    const save = vi.fn().mockResolvedValue(undefined);
    mount({ save });
    await user.click(screen.getByRole('button', { name: '고치기' }));
    await user.type(area(), '끝');
    await user.click(screen.getByRole('button', { name: /바뀐 줄 확인/ }));
    expect(await screen.findByText('더한 줄 1 · 뺀 줄 1')).toBeInTheDocument();
    expect(screen.getByLabelText('바뀐 줄')).toHaveTextContent('+본문끝');
    await user.type(screen.getByRole('textbox', { name: '저장 메모' }), '말투 수정');
    await user.click(screen.getByRole('button', { name: '이대로 저장' }));
    await waitFor(() => expect(save).toHaveBeenCalledWith('# 제목\n- 가\n본문끝', 'sha1', '말투 수정'));
    expect(await screen.findByRole('button', { name: '고치기' })).toBeInTheDocument(); // 보기로 돌아옴
    expect(localStorage.getItem('aas.draft.k1')).toBeNull();
  });

  it('check 가 문제를 알리면 저장을 막고 알림으로 보인다', async () => {
    const user = userEvent.setup();
    const save = vi.fn();
    mount({ save, check: async () => '형식이 맞지 않습니다', mode: 'code' });
    await user.click(screen.getByRole('button', { name: '고치기' }));
    await user.type(area(), 'x');
    await user.click(screen.getByRole('button', { name: /바뀐 줄 확인/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent('형식이 맞지 않습니다');
    expect(screen.getByRole('button', { name: '이대로 저장' })).toBeDisabled();
    expect(save).not.toHaveBeenCalled();
  });

  it('상태 코드 409(그사이 다른 곳에서 바뀜)가 오면 문장과 상관없이 새로 받고 차이 보기를 권한다', async () => {
    const user = userEvent.setup();
    const refetch = vi.fn().mockResolvedValue(undefined);
    const save = vi.fn().mockRejectedValue(new ApiError('The file changed in the meantime.', 409));
    mount({ save, refetch });
    await user.click(screen.getByRole('button', { name: '고치기' }));
    await user.type(area(), 'x');
    await user.click(screen.getByRole('button', { name: /바뀐 줄 확인/ }));
    await user.click(await screen.findByRole('button', { name: '이대로 저장' }));
    expect(
      await screen.findByText(/그사이 다른 곳\(다른 사람이나 AI 에이전트\)에서 이 글을 고쳤습니다/)
    ).toBeInTheDocument();
    expect(refetch).toHaveBeenCalled();
    expect(screen.getByRole('button', { name: '차이 보기' })).toBeInTheDocument();
    expect(area().value).toBe('# 제목\n- 가\n본문x'); // 고치던 글은 그대로
  });

  it('그만두기는 확인을 받고 취소하면 편집을 이어 간다', async () => {
    const user = userEvent.setup();
    mount();
    await user.click(screen.getByRole('button', { name: '고치기' }));
    await user.type(area(), 'x');
    await user.click(screen.getByRole('button', { name: '취소' }));
    expect(await screen.findByText(/저장하지 않은 수정이 있습니다/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '취소' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(area().value).toContain('본문x');
    await user.click(screen.getByRole('button', { name: '취소' }));
    await user.click(await screen.findByRole('button', { name: '확인' }));
    expect(await screen.findByRole('button', { name: '고치기' })).toBeInTheDocument();
  });
});

describe('TextEditor 도구와 단축키', () => {
  it('굵게 도구는 선택한 글을 감싼다', async () => {
    const user = userEvent.setup();
    mount();
    await user.click(screen.getByRole('button', { name: '고치기' }));
    const ta = area();
    ta.focus();
    ta.setSelectionRange(2, 4); // "제목"
    await user.click(screen.getByRole('button', { name: '굵게 (⌘B)' }));
    expect(ta.value).toBe('# **제목**\n- 가\n본문');
  });

  it('목록 줄에서 Enter 는 다음 항목을 잇는다', async () => {
    const user = userEvent.setup();
    mount({ doc: { lines: ['- 가'], sha: 's' } });
    await user.click(screen.getByRole('button', { name: '고치기' }));
    const ta = area();
    ta.focus();
    ta.setSelectionRange(3, 3);
    await user.keyboard('{Enter}나');
    expect(ta.value).toBe('- 가\n- 나');
  });

  it('Tab 은 들여쓰고 Esc 를 누른 뒤에는 칸 이동을 허용한다', async () => {
    const user = userEvent.setup();
    mount({ doc: { lines: ['가'], sha: 's' }, mode: 'code' });
    await user.click(screen.getByRole('button', { name: '고치기' }));
    area().focus();
    area().setSelectionRange(0, 0);
    await user.keyboard('{Tab}');
    expect(area().value).toBe('  가');
    await user.keyboard('{Escape}');
    expect(screen.getByText('Tab 으로 다음 칸으로 넘어갈 수 있습니다')).toBeInTheDocument();
  });

  it('코드 방식은 마크다운 도구 줄이 없다', async () => {
    const user = userEvent.setup();
    mount({ mode: 'code' });
    await user.click(screen.getByRole('button', { name: '고치기' }));
    expect(screen.queryByRole('button', { name: '굵게 (⌘B)' })).not.toBeInTheDocument();
    expect(screen.getByText(/코드 모드/)).toBeInTheDocument();
  });

  it('미리 보기 전환은 마크다운으로 그린다', async () => {
    const user = userEvent.setup();
    mount();
    await user.click(screen.getByRole('button', { name: '고치기' }));
    await user.click(screen.getByRole('button', { name: '미리 보기' }));
    expect(within(screen.getByLabelText('미리 보기')).getByRole('heading', { name: '제목' })).toBeInTheDocument();
  });
});

describe('TextEditor 임시 저장', () => {
  it('0.6초 뒤 브라우저에 임시 저장하고, 다시 열면 이어 쓰기/버리기를 묻는다', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const first = mount();
    await user.click(screen.getByRole('button', { name: '고치기' }));
    await user.type(area(), '!');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(700);
    });
    expect(JSON.parse(localStorage.getItem('aas.draft.k1')!)).toMatchObject({
      text: '# 제목\n- 가\n본문!',
      sha: 'sha1',
    });
    first.unmount();

    mount();
    expect(screen.getByText(/이 브라우저에 저장하지 않은 수정이 있습니다/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '이어 쓰기' }));
    expect(area().value).toBe('# 제목\n- 가\n본문!');
  });

  it('버리기는 임시 저장을 지운다', async () => {
    localStorage.setItem('aas.draft.k1', JSON.stringify({ text: '다른 글', sha: 'sha1', ts: Date.now() }));
    const user = userEvent.setup();
    mount();
    await user.click(screen.getByRole('button', { name: '버리기' }));
    expect(localStorage.getItem('aas.draft.k1')).toBeNull();
    expect(screen.queryByText(/이 브라우저에 저장하지 않은 수정이 있습니다/)).not.toBeInTheDocument();
  });
});

describe('TextEditor 이전 판', () => {
  const VERSIONS = [
    { id: 3, sha: 'sha1', saved_at: '2026-10-10T09:00:00', by: 'kim', size: 12, note: '현재' },
    { id: 2, sha: 'old', saved_at: '2026-10-09T09:00:00', by: 'lee', size: 10 },
    { id: 1, sha: 'older', saved_at: '2026-10-08T09:00:00', size: 8 },
  ];
  const api = () => ({
    versions: vi.fn().mockResolvedValue(VERSIONS),
    version: vi.fn().mockResolvedValue({ lines: ['옛', '글'] }),
    diff: vi.fn().mockResolvedValue({ lines: ['@@ x @@', '-옛', '+새'], added: 1, removed: 1, same: false }),
    diff2: vi.fn().mockResolvedValue({ lines: ['-a', '+b'], added: 1, removed: 1, same: false }),
    rename: vi.fn().mockResolvedValue(undefined),
    revert: vi.fn().mockResolvedValue(undefined),
  });

  it('목록, 지금과 차이, 보기', async () => {
    const user = userEvent.setup();
    const a = api();
    mount(a);
    await user.click(screen.getByRole('button', { name: '이전 버전 2' }));
    expect(await screen.findByText('SOUL · 이전 버전 3')).toBeInTheDocument();
    expect(screen.getByText('현재 내용')).toBeInTheDocument();
    expect(screen.getByText('2026-10-09 09:00 · lee · 10자')).toBeInTheDocument();
    expect(screen.getByText('2026-10-08 09:00 · 고치기 전 상태 · 8자')).toBeInTheDocument();
    const row = screen.getByText('버전 2').closest('li')!;
    expect(row).toHaveAttribute('data-item-row'); // 프로파일 서랍과 같은 줄 모양
    await user.click(within(row).getByRole('button', { name: '현재와 비교' }));
    expect(await screen.findByText('버전 2 → 현재: 더한 줄 1 · 뺀 줄 1')).toBeInTheDocument();
    expect(a.diff).toHaveBeenCalledWith(2);
    await user.click(within(row).getByRole('button', { name: '내용 보기' }));
    const old = await screen.findByDisplayValue(/옛/);
    expect(old).toHaveAttribute('readonly');
    expect((old as HTMLTextAreaElement).value).toBe('옛\n글');
  });

  it('두 판을 골라 비교한다', async () => {
    const user = userEvent.setup();
    const a = api();
    mount(a);
    await user.click(screen.getByRole('button', { name: '이전 버전 2' }));
    await screen.findByText('SOUL · 이전 버전 3');
    const compare = screen.getByRole('button', { name: '선택한 두 버전 비교' });
    expect(compare).toBeDisabled();
    await user.click(screen.getByRole('checkbox', { name: '버전 1 선택' }));
    await user.click(screen.getByRole('checkbox', { name: '버전 3 선택' }));
    await user.click(compare);
    expect(await screen.findByText('버전 1 → 버전 3: 더한 줄 1 · 뺀 줄 1')).toBeInTheDocument();
    expect(a.diff2).toHaveBeenCalledWith(1, 3);
  });

  it('되돌리기는 확인을 받고 revert(id, 지금 sha) 후 보기로 돌아온다. 지금 내용 판에는 없다', async () => {
    const user = userEvent.setup();
    const a = api();
    mount(a);
    await user.click(screen.getByRole('button', { name: '이전 버전 2' }));
    await screen.findByText('SOUL · 이전 버전 3');
    expect(
      within(screen.getByText('버전 3').closest('li')!).queryByRole('button', { name: '되돌리기' })
    ).not.toBeInTheDocument();
    await user.click(within(screen.getByText('버전 2').closest('li')!).getByRole('button', { name: '되돌리기' }));
    expect(await screen.findByText(/버전 2 의 내용으로 되돌립니다/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '확인' }));
    await waitFor(() => expect(a.revert).toHaveBeenCalledWith(2, 'sha1'));
    expect(await screen.findByRole('button', { name: '고치기' })).toBeInTheDocument();
  });

  it('이름 붙이기', async () => {
    const user = userEvent.setup();
    const a = api();
    mount(a);
    await user.click(screen.getByRole('button', { name: '이전 버전 2' }));
    await screen.findByText('SOUL · 이전 버전 3');
    await user.click(within(screen.getByText('버전 2').closest('li')!).getByRole('button', { name: '이름 붙이기' }));
    await user.type(screen.getByRole('textbox', { name: '버전 2 이름' }), '릴리즈 전');
    await user.click(screen.getByRole('button', { name: '저장' }));
    await waitFor(() => expect(a.rename).toHaveBeenCalledWith(2, '릴리즈 전'));
    expect(await screen.findByText('릴리즈 전')).toBeInTheDocument();
  });

  it('돌아가기', async () => {
    const user = userEvent.setup();
    mount(api());
    await user.click(screen.getByRole('button', { name: '이전 버전 2' }));
    await user.click(await screen.findByRole('button', { name: '← 돌아가기' }));
    expect(screen.getByRole('button', { name: '고치기' })).toBeInTheDocument();
  });
});

// 작업 지침(AGENTS.md) 탭이 쓰는 선택 항목(스펙 2026-10-19-004 §9·§10 L2·L3). 넘기지 않는 다른 화면은 지금과 같다
describe('TextEditor 경고·한도·도움말(2026-10-19-004)', () => {
  const LIMIT = { max: 15, warn: (n: number) => `${n}자로 한도 15자를 넘습니다.` };

  it('check 반환값 정규화: 문자열은 막는 문제, 객체는 문제와 경고, 빈 값은 없음', () => {
    expect(normalizeCheck('틀림')).toEqual({ problem: '틀림', warnings: [] });
    expect(normalizeCheck({ problem: '', warnings: ['크다', ''] })).toEqual({ problem: '', warnings: ['크다'] });
    expect(normalizeCheck({ warnings: ['크다'] })).toEqual({ problem: '', warnings: ['크다'] });
    expect(normalizeCheck(undefined)).toEqual({ problem: '', warnings: [] });
    expect(normalizeCheck('')).toEqual({ problem: '', warnings: [] });
  });

  it('check 가 경고만 주면 경고 알림을 보이고 저장 단추는 켜져 저장된다', async () => {
    const user = userEvent.setup();
    const save = vi.fn().mockResolvedValue(undefined);
    mount({ save, check: async () => ({ problem: '', warnings: ['크기가 한도를 넘습니다'] }) });
    await user.click(screen.getByRole('button', { name: '고치기' }));
    await user.type(area(), '!');
    await user.click(screen.getByRole('button', { name: /바뀐 줄 확인/ }));
    const warn = await screen.findByText('크기가 한도를 넘습니다');
    expect(warn.closest('.MuiAlert-standardWarning')).not.toBeNull();
    const btn = screen.getByRole('button', { name: '이대로 저장' });
    expect(btn).toBeEnabled();
    await user.click(btn);
    await waitFor(() => expect(save).toHaveBeenCalled());
  });

  it('객체의 problem 은 문자열처럼 저장을 막는다', async () => {
    const user = userEvent.setup();
    mount({ check: () => ({ problem: '막힘', warnings: ['경고'] }) });
    await user.click(screen.getByRole('button', { name: '고치기' }));
    await user.type(area(), '!');
    await user.click(screen.getByRole('button', { name: /바뀐 줄 확인/ }));
    expect(await screen.findByText('막힘')).toBeInTheDocument();
    expect(screen.getByText('경고')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '이대로 저장' })).toBeDisabled();
  });

  it('한도가 있으면 상태 줄에 「n / 한도자」, 넘으면 경고 색 표시와 한 번 읽어 줄 문장', async () => {
    const user = userEvent.setup();
    mount({ limit: LIMIT });
    await user.click(screen.getByRole('button', { name: '고치기' }));
    expect(screen.getByText(/11 \/ 15자/)).toHaveAttribute('data-limit-count', 'ok');
    expect(screen.queryByText(/글자 수가 한도를 넘었습니다/)).not.toBeInTheDocument();
    await user.type(area(), '12345');
    const count = screen.getByText(/16 \/ 15자/);
    expect(count).toHaveAttribute('data-limit-count', 'over');
    expect(count).toHaveTextContent('(한도 넘음)'); // 색만으로 구분하지 않는다(D13)
    expect(screen.getByText(/글자 수가 한도를 넘었습니다/)).toHaveAttribute('aria-live', 'polite');
  });

  it('한도가 없으면 상태 줄은 지금처럼 줄·글자 수다', async () => {
    const user = userEvent.setup();
    mount();
    await user.click(screen.getByRole('button', { name: '고치기' }));
    expect(screen.getByText(/3줄 · 11자/)).toBeInTheDocument();
    expect(document.querySelector('[data-limit-count]')).toBeNull();
  });

  it('hintBelow: 도움말은 읽기 전용일 때도 본문 아래 회색 글자로 보이고, 고치는 중에도 편집기 아래에 있다', async () => {
    const user = userEvent.setup();
    const first = mount({ editable: false, hint: '새 대화부터 적용됩니다', hintBelow: true });
    const hint = screen.getByText('새 대화부터 적용됩니다');
    expect(hint).toHaveAttribute('data-editor-hint');
    // 본문(제목) 뒤에 온다
    expect(screen.getByRole('heading', { name: '제목' }).compareDocumentPosition(hint) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    first.unmount();
    mount({ hint: '새 대화부터 적용됩니다', hintBelow: true });
    await user.click(screen.getByRole('button', { name: '고치기' }));
    expect(screen.getByText('새 대화부터 적용됩니다')).toHaveAttribute('data-editor-hint');
  });

  it('hintBelow 가 없으면 지금처럼 고칠 수 있을 때만 단추 줄에 도움말을 보인다', () => {
    mount({ editable: false, hint: '도움말', whyNot: '못 고침' });
    expect(screen.queryByText('도움말')).not.toBeInTheDocument();
    expect(screen.getByText('못 고침')).toBeInTheDocument();
  });

  it('editDisabled: 고칠 수 없어도 「고치기」가 꺼진 채 보이고 사유 요소를 aria-describedby 로 잇는다', () => {
    mount({ editable: false, editDisabled: true, describedBy: 'why-1' });
    const btn = screen.getByRole('button', { name: '고치기' });
    expect(btn).toBeDisabled();
    expect(btn).toHaveAttribute('aria-describedby', 'why-1');
  });

  it('conflictText 가 있으면 409 때 그 문장을 보인다', async () => {
    const user = userEvent.setup();
    const save = vi.fn().mockRejectedValue(new ApiError('changed', 409));
    mount({ save, refetch: vi.fn().mockResolvedValue(undefined), conflictText: 'AI 에이전트가 그사이 고쳤습니다.' });
    await user.click(screen.getByRole('button', { name: '고치기' }));
    await user.type(area(), 'x');
    await user.click(screen.getByRole('button', { name: /바뀐 줄 확인/ }));
    await user.click(await screen.findByRole('button', { name: '이대로 저장' }));
    expect(await screen.findByText('AI 에이전트가 그사이 고쳤습니다.')).toBeInTheDocument();
  });

  it('agentChip: 판 작성자 hermes:* 는 「에이전트」 칩, 사람은 이름 그대로. 한도를 넘는 판을 되돌리면 확인 창에 경고', async () => {
    const user = userEvent.setup();
    const revert = vi.fn().mockResolvedValue(undefined);
    mount({
      agentChip: true,
      limit: LIMIT,
      revert,
      versions: vi.fn().mockResolvedValue([
        { id: 3, sha: 'sha1', saved_at: '2026-10-10T09:00:00', by: 'hermes:ma', size: 11 },
        { id: 2, sha: 'old', saved_at: '2026-10-09T09:00:00', by: 'lee', size: 40 },
      ]),
    });
    await user.click(screen.getByRole('button', { name: '이전 버전 2' }));
    await screen.findByText('SOUL · 이전 버전 2');
    const agentRow = screen.getByText('버전 3').closest('li')!;
    expect(agentRow.querySelector('[data-actor-chip="agent"]')).toHaveTextContent('에이전트');
    expect(agentRow).not.toHaveTextContent('hermes:ma');
    expect(screen.getByText('2026-10-09 09:00 · lee · 40자')).toBeInTheDocument();
    await user.click(within(screen.getByText('버전 2').closest('li')!).getByRole('button', { name: '되돌리기' }));
    expect(await screen.findByText(/버전 2 의 내용으로 되돌립니다.*40자로 한도 15자를 넘습니다/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '확인' }));
    await waitFor(() => expect(revert).toHaveBeenCalledWith(2, 'sha1'));
  });

  it('agentChip 이 없으면 hermes:* 도 글자 그대로다(스킬 등 다른 화면)', async () => {
    const user = userEvent.setup();
    mount({ versions: vi.fn().mockResolvedValue([{ id: 2, sha: 'old', saved_at: '2026-10-09T09:00:00', by: 'hermes:ma', size: 4 }]) });
    await user.click(screen.getByRole('button', { name: '이전 버전 2' }));
    expect(await screen.findByText('2026-10-09 09:00 · hermes:ma · 4자')).toBeInTheDocument();
  });
});

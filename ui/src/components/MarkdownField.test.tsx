/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';

import { MarkdownField } from './MarkdownField';

function Host({ initial = '', monaco = false }: { initial?: string; monaco?: boolean }) {
  const [v, setV] = useState(initial);
  return <MarkdownField value={v} onChange={setV} label="용도·메모" monaco={monaco} />;
}
const box = () => screen.getByLabelText('용도·메모') as HTMLTextAreaElement;

describe('MarkdownField', () => {
  it('눈에 보이는 이름표와 편집 도구를 낸다', () => {
    render(<Host />);
    expect(screen.getByRole('toolbar', { name: '편집 도구' })).toBeInTheDocument();
    expect(screen.getAllByRole('button').map((b) => b.getAttribute('aria-label') ?? b.textContent)).toEqual([
      '굵게 (⌘B)',
      '목록',
      '코드',
      '링크 (⌘K)',
      '미리 보기',
    ]);
    expect(screen.getByText('용도·메모')).toBeInTheDocument();
  });

  it('선택한 글을 굵게 만들고 다시 누르면 푼다', async () => {
    const user = userEvent.setup();
    render(<Host initial="결제 서버" />);
    box().setSelectionRange(0, 2);
    await user.click(screen.getByRole('button', { name: '굵게 (⌘B)' }));
    expect(box().value).toBe('**결제** 서버');
  });

  it('목록·코드 도구가 줄 머리와 감싸기를 한다', async () => {
    const user = userEvent.setup();
    render(<Host initial="항목" />);
    box().setSelectionRange(0, 2);
    await user.click(screen.getByRole('button', { name: '목록' }));
    expect(box().value).toBe('- 항목');
    await user.click(screen.getByRole('button', { name: '코드' }));
    expect(box().value).toContain('`');
  });

  it('미리 보기 중에는 도구를 쓸 수 없다', async () => {
    const user = userEvent.setup();
    render(<Host initial="**글**" />);
    await user.click(screen.getByRole('button', { name: '미리 보기' }));
    expect(screen.getByRole('button', { name: '굵게 (⌘B)' })).toBeDisabled();
  });

  // 새 스킬 본문은 Monaco 편집기로 고친다(2026-10-28-003). 시험에서는 setup.ts 가 같은 약속의 입력칸(PlainEditor)으로 바꿔 끼운다
  it('monaco 를 켜면 마크다운 편집기를 쓰고 도구 줄이 선택 범위에 적용된다', async () => {
    const user = userEvent.setup();
    render(<Host initial="결제 서버" monaco />);
    const el = (await screen.findByLabelText('용도·메모')) as HTMLTextAreaElement;
    expect(el).toHaveAttribute('data-language', 'markdown');
    el.setSelectionRange(0, 2);
    await user.click(screen.getByRole('button', { name: '굵게 (⌘B)' }));
    expect(el.value).toBe('**결제** 서버');
    await user.click(screen.getByRole('button', { name: '목록' }));
    expect(el.value).toBe('- **결제** 서버');
  });

  it('monaco 편집기에서 ⌘B 로 굵게 하고 Tab 은 들여쓴다', async () => {
    const user = userEvent.setup();
    render(<Host initial="항목" monaco />);
    const el = (await screen.findByLabelText('용도·메모')) as HTMLTextAreaElement;
    el.focus();
    el.setSelectionRange(0, 2);
    await user.keyboard('{Meta>}b{/Meta}');
    expect(el.value).toBe('**항목**');
    await user.keyboard('{Tab}');
    expect(el.value.startsWith('  ') || el.value.startsWith('\t')).toBe(true);
  });
});

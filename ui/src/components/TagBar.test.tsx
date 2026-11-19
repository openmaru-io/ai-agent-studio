/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { isWorkTag, tagCounts, tagMatches, toggleTag, WORK_TAGS } from './TagBar';
import { TagBar } from './TagBar';

const PKGS = [
  { id: 'a', tags: ['design', 'image'] },
  { id: 'b', tags: ['design'] },
  { id: 'c', tags: ['docs'] },
  { id: 'd', tags: [] },
  { id: 'e' },
];

describe('tagCounts·tagMatches (OMAI-1275)', () => {
  it('태그마다 몇 개가 가졌는지 세고 많은 순으로(같으면 id 순) 내놓는다. 태그 없는 항목은 세지 않는다', () => {
    expect(tagCounts(PKGS)).toEqual([
      { id: 'design', n: 2 },
      { id: 'docs', n: 1 },
      { id: 'image', n: 1 },
    ]);
    expect(tagCounts([])).toEqual([]);
  });

  it('고른 태그를 모두 가진 것만 맞는다. 고른 것이 없으면 모두 맞는다', () => {
    expect(PKGS.filter((p) => tagMatches(p, ['design', 'image'])).map((p) => p.id)).toEqual(['a']);
    expect(PKGS.filter((p) => tagMatches(p, ['design'])).map((p) => p.id)).toEqual(['a', 'b']);
    expect(PKGS.filter((p) => tagMatches(p, [])).map((p) => p.id)).toEqual(['a', 'b', 'c', 'd', 'e']);
  });
});

describe('TagBar', () => {
  const counts = [{ id: 'design', n: 2 }, { id: 'docs', n: 1 }];

  it('「전체」 칩과 태그 칩(개수 포함)을 그리고 켠 칩은 aria-pressed 다', () => {
    render(<TagBar counts={counts} total={5} active={['docs']} onToggle={vi.fn()} onClear={vi.fn()} />);
    const bar = screen.getByRole('group', { name: '태그로 거르기' });
    expect(within(bar).getByRole('button', { name: /전체/ })).toHaveAttribute('aria-pressed', 'false'); // 켠 칩이 있으면 「전체」는 꺼진다
    expect(within(bar).getByRole('button', { name: /디자인/ })).toHaveTextContent('2');
    expect(within(bar).getByRole('button', { name: /문서·글쓰기/ })).toHaveAttribute('aria-pressed', 'true');
  });

  it('칩을 누르면 onToggle(id), 「전체」를 누르면 onClear', async () => {
    const user = userEvent.setup();
    const f = { onToggle: vi.fn(), onClear: vi.fn() };
    render(<TagBar counts={counts} total={5} active={[]} {...f} />);
    expect(screen.getByRole('button', { name: /전체/ })).toHaveAttribute('aria-pressed', 'true');
    await user.click(screen.getByRole('button', { name: /디자인/ }));
    await user.click(screen.getByRole('button', { name: /전체/ }));
    expect(f.onToggle).toHaveBeenCalledWith('design');
    expect(f.onClear).toHaveBeenCalledTimes(1);
  });

  it('태그가 하나도 없으면 칩 줄은 그리지 않는다. 오른쪽 동작(관리자 단추)이 있으면 그것만 남긴다', () => {
    const { container, rerender } = render(<TagBar counts={[]} total={0} active={[]} onToggle={vi.fn()} onClear={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
    rerender(<TagBar counts={[]} total={0} active={[]} onToggle={vi.fn()} onClear={vi.fn()} action={<button>다시</button>} />);
    expect(screen.getByRole('button', { name: '다시' })).toBeInTheDocument();
    expect(screen.queryByRole('group')).not.toBeInTheDocument();
    rerender(<TagBar counts={counts} total={3} active={[]} onToggle={vi.fn()} onClear={vi.fn()} action={<button>다시</button>} />);
    expect(screen.getByRole('button', { name: '다시' })).toBeInTheDocument();
  });
});

describe('업무 태그(스펙 2026-11-17-003)', () => {
  it('업무 id 는 서버 어휘와 같은 11개이고 기능 id 와 겹치지 않는다', () => {
    expect(WORK_TAGS).toHaveLength(11);
    expect(isWorkTag('sales')).toBe(true);
    expect(isWorkTag('common')).toBe(true);
    expect(isWorkTag('docs')).toBe(false);
  });

  it('toggleTag: 업무 칩은 하나만 켜지고(다른 업무 칩은 꺼진다), 기능 칩은 여러 개 켜진다', () => {
    expect(toggleTag([], 'sales')).toEqual(['sales']);
    expect(toggleTag(['sales', 'docs'], 'marketing')).toEqual(['docs', 'marketing']);
    expect(toggleTag(['sales', 'docs'], 'automation')).toEqual(['sales', 'docs', 'automation']);
    expect(toggleTag(['sales', 'docs'], 'sales')).toEqual(['docs']);
    expect(toggleTag(['sales', 'docs'], 'docs')).toEqual(['sales']);
  });

  it('업무와 기능이 둘 다 있으면 「업무별」·「기능별」 두 줄(아이콘 이름표)이고, 업무 칩은 업무 목록 순서다', () => {
    const counts = [
      { id: 'docs', n: 4 },
      { id: 'sales', n: 3 },
      { id: 'marketing', n: 1 },
    ];
    render(<TagBar counts={counts} total={5} active={[]} onToggle={vi.fn()} onClear={vi.fn()} />);
    const work = screen.getByRole('group', { name: '업무별' });
    expect(within(work).getByRole('button', { name: /전체/ })).toBeInTheDocument();
    expect(within(work).getAllByRole('button').map((b) => b.textContent)).toEqual(['전체5', '마케팅1', '세일즈3']);
    const kind = screen.getByRole('group', { name: '기능별' });
    expect(within(kind).getAllByRole('button').map((b) => b.textContent)).toEqual(['문서·글쓰기4']);
    expect(screen.queryByRole('group', { name: '태그로 거르기' })).not.toBeInTheDocument();
  });

  it('한 갈래만 있으면 이름표 없이 지금처럼 한 줄이다', () => {
    render(<TagBar counts={[{ id: 'sales', n: 2 }]} total={2} active={[]} onToggle={vi.fn()} onClear={vi.fn()} />);
    expect(screen.getByRole('group', { name: '태그로 거르기' })).toBeInTheDocument();
    expect(screen.queryByText('업무별')).not.toBeInTheDocument();
  });
});

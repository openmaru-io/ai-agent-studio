/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { AgentPicker } from './AgentPicker';

const OPTIONS = [
  { value: 'main', label: 'main' },
  { value: 'ma', label: '마케팅 (ma)' },
  { value: 'ops', label: '운영 (ops)' },
];

function Harness({ initial = 'main', emptyLabel, spy }: { initial?: string; emptyLabel?: string; spy?: (v: string) => void }) {
  const [v, setV] = useState(initial);
  return (
    <AgentPicker
      label="프로파일"
      value={v}
      onChange={(x) => {
        spy?.(x);
        setV(x);
      }}
      options={OPTIONS}
      emptyLabel={emptyLabel}
    />
  );
}

describe('AgentPicker(OMAI-1225)', () => {
  it('접근 이름은 라벨이고, 열면 고른 값이 있어도 전체 목록이 보인다', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const box = screen.getByRole('combobox', { name: '프로파일' });
    expect(box).toHaveValue('main');
    await user.click(box);
    const list = await screen.findByRole('listbox');
    expect(within(list).getAllByRole('option').map((o) => o.textContent)).toEqual(['main', '마케팅 (ma)', '운영 (ops)']);
  });

  it('글자를 치면 이름·표시 이름에 포함된 것만 남고, 고르면 값(value)을 돌려준다', async () => {
    const user = userEvent.setup();
    const spy = vi.fn();
    render(<Harness spy={spy} />);
    const box = screen.getByRole('combobox', { name: '프로파일' });
    await user.clear(box);
    await user.type(box, '마케');
    const list = await screen.findByRole('listbox');
    expect(within(list).getAllByRole('option').map((o) => o.textContent)).toEqual(['마케팅 (ma)']);
    await user.click(within(list).getByRole('option', { name: '마케팅 (ma)' }));
    expect(spy).toHaveBeenLastCalledWith('ma');
    expect(box).toHaveValue('마케팅 (ma)');
  });

  it('목록에 없는 글자는 맞는 항목이 없다고 알린다(freeSolo 아님)', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const box = screen.getByRole('combobox', { name: '프로파일' });
    await user.clear(box);
    await user.type(box, 'zzz');
    expect(await screen.findByText('맞는 AI 에이전트가 없습니다')).toBeInTheDocument();
  });

  it('빈 선택(emptyLabel)이 있으면 비웠을 때 값이 빈 문자열이고 안내 글이 보인다. 없으면 지우기(×)가 없다', async () => {
    const user = userEvent.setup();
    const spy = vi.fn();
    const { unmount } = render(<Harness initial="ma" emptyLabel="빈 상태에서 시작" spy={spy} />);
    const box = screen.getByRole('combobox', { name: '프로파일' });
    await user.click(screen.getByTitle('선택 지우기')); // 마우스를 올려야 보이는 단추라(visibility hidden) 접근 이름이 비어 title 로 찾는다
    expect(spy).toHaveBeenLastCalledWith('');
    expect(box).toHaveAttribute('placeholder', '빈 상태에서 시작');
    unmount();
    render(<Harness initial="ma" />);
    expect(screen.queryByTitle('선택 지우기')).not.toBeInTheDocument();
  });
});

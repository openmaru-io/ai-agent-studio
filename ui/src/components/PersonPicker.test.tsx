/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { PersonPicker } from './PersonPicker';

const PEOPLE = [
  { name: '김철수', email: 'kim@x.com', username: 'chulsoo', department: '개발팀' },
  { name: '이영희', email: 'lee@x.com', username: 'younghee' },
];

function Harness({ store = 'name', initial = '', spy, showName }: { store?: 'name' | 'email'; initial?: string; spy?: (v: string) => void; showName?: boolean }) {
  const [v, setV] = useState(initial);
  return (
    <PersonPicker
      label="담당"
      value={v}
      onChange={(x) => {
        spy?.(x);
        setV(x);
      }}
      people={PEOPLE}
      store={store}
      showName={showName}
    />
  );
}

describe('PersonPicker(OMAI-1229)', () => {
  it('열면 모든 사람이 이름과 함께 아이디·부서가 작게 보인다(이메일은 보이지 않는다, 2026-10-20)', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole('combobox', { name: '담당' }));
    const list = await screen.findByRole('listbox');
    const options = within(list).getAllByRole('option');
    expect(options).toHaveLength(2);
    expect(options[0]).toHaveTextContent('김철수');
    expect(options[0]).toHaveTextContent('chulsoo');
    expect(options[0]).not.toHaveTextContent('kim@x.com');
    expect(options[0]).toHaveTextContent('개발팀');
    expect(options[1]).toHaveTextContent('younghee');
    expect(options[1]).not.toHaveTextContent('lee@x.com');
  });

  it('store=name 이면 고른 사람의 표시 이름이 값이다', async () => {
    const user = userEvent.setup();
    const spy = vi.fn();
    render(<Harness spy={spy} />);
    const box = screen.getByRole('combobox', { name: '담당' });
    await user.click(box);
    await user.click(await screen.findByRole('option', { name: /이영희/ }));
    expect(spy).toHaveBeenLastCalledWith('이영희');
    expect(box).toHaveValue('이영희');
  });

  it('store=email 이면 고른 사람의 이메일이 값이다', async () => {
    const user = userEvent.setup();
    const spy = vi.fn();
    render(<Harness store="email" spy={spy} />);
    await user.click(screen.getByRole('combobox', { name: '담당' }));
    await user.click(await screen.findByRole('option', { name: /김철수/ }));
    expect(spy).toHaveBeenLastCalledWith('kim@x.com');
  });

  it('이름·이메일·부서로 거르고, 목록에 없는 글자도 그대로 값이 된다(freeSolo)', async () => {
    const user = userEvent.setup();
    const spy = vi.fn();
    render(<Harness spy={spy} />);
    const box = screen.getByRole('combobox', { name: '담당' });
    await user.type(box, 'lee@');
    expect(within(await screen.findByRole('listbox')).getAllByRole('option')).toHaveLength(1);
    await user.clear(box);
    await user.type(box, '개발');
    expect(within(await screen.findByRole('listbox')).getAllByRole('option')).toHaveLength(1);
    await user.clear(box);
    await user.type(box, 'alice');
    expect(spy).toHaveBeenLastCalledWith('alice');
    expect(box).toHaveValue('alice');
  });

  it('이미 고른 이름이 입력 칸에 있어도 열면 전체 목록이 보인다', async () => {
    const user = userEvent.setup();
    render(<Harness initial="김철수" />);
    await user.click(screen.getByRole('combobox', { name: '담당' }));
    expect(within(await screen.findByRole('listbox')).getAllByRole('option')).toHaveLength(2);
  });

  it('store=email·showName 이면 칸에는 이름이 보이고 값은 이메일이다(TFT 방 담당, 2026-10-20)', async () => {
    const user = userEvent.setup();
    const spy = vi.fn();
    render(<Harness store="email" showName initial="kim@x.com" spy={spy} />);
    const box = screen.getByRole('combobox', { name: '담당' });
    expect(box).toHaveValue('김철수');
    await user.click(box);
    expect(within(await screen.findByRole('listbox')).getAllByRole('option')).toHaveLength(2); // 고른 이름이 칸에 있어도 전체
    await user.click(await screen.findByRole('option', { name: /이영희/ }));
    expect(spy).toHaveBeenLastCalledWith('lee@x.com');
    expect(box).toHaveValue('이영희');
  });

  it('showName 이면 목록에 없는 값(옛 담당 글자)은 그대로 보이고, 이름을 다 치고 Enter 면 그 사람의 이메일이 값이다', async () => {
    const user = userEvent.setup();
    const spy = vi.fn();
    render(<Harness store="email" showName initial="운영팀" spy={spy} />);
    const box = screen.getByRole('combobox', { name: '담당' });
    expect(box).toHaveValue('운영팀');
    await user.clear(box);
    await user.type(box, '이영희{Enter}');
    expect(spy).toHaveBeenLastCalledWith('lee@x.com');
    expect(box).toHaveValue('이영희');
  });
});

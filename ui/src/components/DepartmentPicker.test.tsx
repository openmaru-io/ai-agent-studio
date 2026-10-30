/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { DepartmentPicker } from './DepartmentPicker';

const OPTIONS = ['개발팀', '영업팀', '오픈마루'];

function Harness({
  initial = '',
  options = OPTIONS,
  status = 'ready',
  current,
  spy,
  retry = () => undefined,
}: {
  initial?: string;
  options?: string[];
  status?: 'loading' | 'error' | 'ready';
  current?: string;
  spy?: (v: string) => void;
  retry?: () => void;
}) {
  const [v, setV] = useState(initial);
  return (
    <DepartmentPicker
      label="부서"
      value={v}
      onChange={(x) => {
        spy?.(x);
        setV(x);
      }}
      options={options}
      status={status}
      current={current}
      onRetry={retry}
    />
  );
}

describe('DepartmentPicker(OMAI-1242)', () => {
  it('열면 모든 부서가 보이고 하나를 고르면 그 이름이 값이 된다', async () => {
    const user = userEvent.setup();
    const spy = vi.fn();
    render(<Harness spy={spy} />);
    await user.click(screen.getByRole('combobox', { name: '부서' }));
    const list = await screen.findByRole('listbox');
    expect(within(list).getAllByRole('option').map((o) => o.textContent)).toEqual(OPTIONS);
    await user.click(within(list).getByRole('option', { name: '영업팀' }));
    expect(spy).toHaveBeenLastCalledWith('영업팀');
    expect(screen.getByRole('combobox', { name: '부서' })).toHaveValue('영업팀');
  });

  it('글자를 치면 포함 검색이고, 목록에 없는 글자는 값이 되지 않는다(자유 입력 끔)', async () => {
    const user = userEvent.setup();
    const spy = vi.fn();
    render(<Harness initial="개발팀" spy={spy} />);
    const box = screen.getByRole('combobox', { name: '부서' });
    await user.clear(box);
    await user.type(box, '업');
    expect(within(await screen.findByRole('listbox')).getAllByRole('option').map((o) => o.textContent)).toEqual(['영업팀']);
    await user.clear(box);
    await user.type(box, '없는부서');
    expect(await screen.findByText('맞는 부서가 없습니다')).toBeInTheDocument();
    await user.tab();
    expect(spy).not.toHaveBeenCalledWith('없는부서');
  });

  it('지우면 빈 값(부서 없음)이 된다', async () => {
    const user = userEvent.setup();
    const spy = vi.fn();
    render(<Harness initial="개발팀" spy={spy} />);
    // 지우기 단추는 가리키거나 포커스를 줄 때만 보인다(jsdom 은 :hover 를 모른다)
    await user.click(screen.getByTitle('지우기'));
    expect(spy).toHaveBeenLastCalledWith('');
  });

  it('불러오는 중이면 칸을 끄고 안내한다', () => {
    render(<Harness status="loading" options={[]} />);
    expect(screen.getByRole('combobox', { name: '부서' })).toBeDisabled();
    expect(screen.getByText('부서 목록을 불러오는 중입니다')).toBeInTheDocument();
  });

  it('받지 못했으면 칸을 끄고 alert 와 「다시 시도」를 보인다', async () => {
    const user = userEvent.setup();
    const retry = vi.fn();
    render(<Harness status="error" options={[]} retry={retry} />);
    expect(screen.getByRole('combobox', { name: '부서' })).toBeDisabled();
    expect(screen.getByRole('alert')).toHaveTextContent('부서 목록을 불러오지 못했습니다.');
    await user.click(screen.getByRole('button', { name: '다시 시도' }));
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it('목록이 비면 칸을 끄고 부서 탭을 새 브라우저 탭으로 여는 링크와 「목록 새로 고침」을 보인다', async () => {
    const user = userEvent.setup();
    const retry = vi.fn();
    render(<Harness options={[]} retry={retry} />);
    expect(screen.getByRole('combobox', { name: '부서' })).toBeDisabled();
    const link = screen.getByRole('link', { name: '부서 목록' });
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', expect.stringContaining('noopener'));
    expect(link.getAttribute('href')).toContain('#/users?tab=departments');
    await user.click(screen.getByRole('button', { name: '목록 새로 고침' }));
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it('목록 밖 현재 값은 지우지 않고 보이며 칸 아래 도움말과 옵션의 「목록에 없음」 알약이 있다', async () => {
    const user = userEvent.setup();
    render(<Harness initial="옛 부서" current="옛 부서" />);
    const box = screen.getByRole('combobox', { name: '부서' });
    expect(box).toHaveValue('옛 부서');
    expect(box).toBeEnabled();
    expect(screen.getByText('이 부서는 목록에 없습니다. 그대로 두거나 목록에서 다시 고르세요.')).toBeInTheDocument();
    expect(box).toHaveAccessibleDescription(/목록에 없습니다/);
    await user.click(box);
    const list = await screen.findByRole('listbox');
    const first = within(list).getAllByRole('option')[0];
    expect(first).toHaveTextContent('옛 부서');
    expect(within(first).getByText('목록에 없음')).toBeInTheDocument();
    await user.click(within(list).getByRole('option', { name: '개발팀' }));
    expect(screen.queryByText('이 부서는 목록에 없습니다. 그대로 두거나 목록에서 다시 고르세요.')).not.toBeInTheDocument();
  });

  it('서버 오류 문구(helperText)를 칸 아래에 보인다', () => {
    render(
      <DepartmentPicker label="부서" value="" onChange={() => undefined} options={OPTIONS} status="ready" onRetry={() => undefined} error helperText="목록에 없는 부서입니다." />
    );
    expect(screen.getByText('목록에 없는 부서입니다.')).toBeInTheDocument();
  });
});

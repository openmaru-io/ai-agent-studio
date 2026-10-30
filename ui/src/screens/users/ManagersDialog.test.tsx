/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/lib/api';

import { ManagersDialog } from './DepartmentDialogs';
import type { DeptRow } from './departments';
import { ManagersCell } from './DepartmentsTab';
import type { KcUser } from './logic';

const user = (email: string, name: string, department: string): KcUser =>
  ({ key: email, id: email, username: email.split('@')[0], email, name, department, enabled: true }) as KcUser;

const KIM = user('kim@corp.example', '김철수', '개발팀');
const PARK = user('park@corp.example', '박영희', '개발팀');
const CHOI = user('choi@corp.example', '최민수', '개발팀');
const LEE = user('lee@corp.example', '이옮김', '영업팀');
const OTHER = user('han@corp.example', '한다른', '영업팀');
const USERS = [KIM, PARK, CHOI, LEE, OTHER];

const row = (o: Partial<DeptRow> = {}): DeptRow => ({
  key: '개발팀',
  name: '개발팀',
  goal: '',
  ts: '',
  listed: true,
  members: [KIM, PARK, CHOI],
  people: 3,
  managers: [],
  moved: [],
  ...o,
});

function setup(dept: DeptRow, onSubmit = vi.fn(async () => undefined), onClose = vi.fn()) {
  render(<ManagersDialog dept={dept} users={USERS} onClose={onClose} onSubmit={onSubmit} />);
  return { onSubmit, onClose, user: userEvent.setup() };
}

/** 후보에서 박영희를 더한다(처음 값과 달라져 저장이 켜진다) */
async function addPark(u: ReturnType<typeof userEvent.setup>) {
  await u.type(screen.getByRole('combobox', { name: '팀 관리자' }), '박영');
  await u.click(await screen.findByRole('option', { name: /박영희/ }));
}

describe('ManagersDialog — 팀 관리자 지정 창(DD3·DD4·DD11)', () => {
  it('처음 값과 같으면 저장이 꺼지고, 옮긴 사람 칩을 지우면 켜진다', async () => {
    const { user: u } = setup(row({ managers: ['kim@corp.example'], moved: ['lee@corp.example'] }));
    expect(screen.getByRole('button', { name: '저장' })).toBeDisabled();
    await u.click(within(screen.getByRole('button', { name: '이옮김' })).getByTestId('CancelIcon'));
    expect(screen.getByRole('button', { name: '저장' })).toBeEnabled();
  });

  it('0명 부서에 옮긴 사람 행만 남으면 처음엔 저장이 꺼지고, 칩을 지우면 빈 목록을 보낸다', async () => {
    const { user: u, onSubmit } = setup(row({ members: [], people: 0, moved: ['lee@corp.example'] }));
    expect(screen.getByText('이 부서에 사람이 없습니다')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '저장' })).toBeDisabled();
    await u.click(within(screen.getByRole('button', { name: '이옮김' })).getByTestId('CancelIcon'));
    await u.click(screen.getByRole('button', { name: '저장' }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith([]));
  });

  it('후보는 그 부서 사람뿐이다', async () => {
    setup(row());
    const box = screen.getByRole('combobox', { name: '팀 관리자' });
    // 열면 칸에 초점이 가고 후보 목록이 바로 열린다(openOnFocus)
    await waitFor(() => expect(box).toHaveFocus());
    const list = await screen.findByRole('listbox');
    const names = within(list).getAllByRole('option').map((o) => o.textContent ?? '');
    expect(names.some((n) => n.includes('한다른'))).toBe(false);
    expect(names.filter((n) => /김철수|박영희|최민수/.test(n))).toHaveLength(3);
  });

  it('고르고 저장하면 이메일 목록을 보낸다', async () => {
    const { user: u, onSubmit } = setup(row());
    await u.type(screen.getByRole('combobox', { name: '팀 관리자' }), '박영');
    await u.click(await screen.findByRole('option', { name: /박영희/ }));
    await u.click(screen.getByRole('button', { name: '저장' }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith(['park@corp.example']));
  });

  it('구성원을 모르면 후보 없이 이메일을 적는 칸과 안내를 보인다', async () => {
    const { user: u, onSubmit } = setup(row({ members: [], people: null }));
    expect(screen.getByText('구성원을 불러오지 못했습니다. 이메일을 적으면 서버가 부서를 확인합니다')).toBeInTheDocument();
    const box = screen.getByRole('combobox', { name: '팀 관리자' });
    await u.click(box);
    expect(screen.queryAllByRole('option')).toHaveLength(0);
    await u.type(box, 'New@Corp.example{Enter}');
    await u.click(screen.getByRole('button', { name: '저장' }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith(['new@corp.example']));
  });

  it('구성원이 0명이면 빈 안내를 보이고 저장 단추가 꺼진다', () => {
    setup(row({ members: [], people: 0 }));
    expect(screen.getByText('이 부서에 사람이 없습니다')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '저장' })).toBeDisabled();
  });

  it('지금 팀 관리자를 빼고 저장하면 먼저 확인한다', async () => {
    const { user: u, onSubmit } = setup(row({ managers: ['kim@corp.example', 'park@corp.example'] }));
    const chip = screen.getByRole('button', { name: '김철수' });
    await u.click(within(chip).getByTestId('CancelIcon'));
    await u.click(screen.getByRole('button', { name: '저장' }));
    expect(await screen.findByText('김철수 님은 이제 팀원 AI 에이전트 작업공간을 다루지 못합니다')).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
    await u.click(screen.getByRole('button', { name: '빼고 저장' }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith(['park@corp.example']));
  });

  it('확인에서 취소하면 보내지 않는다', async () => {
    const { user: u, onSubmit } = setup(row({ managers: ['kim@corp.example'] }));
    await u.click(within(screen.getByRole('button', { name: '김철수' })).getByTestId('CancelIcon'));
    await u.click(screen.getByRole('button', { name: '저장' }));
    const confirm = await screen.findByRole('dialog', { name: '팀 관리자 빼기' });
    await u.click(within(confirm).getByRole('button', { name: '취소' }));
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('부서를 옮긴 사람은 줄을 그은 회색 칩이고 툴팁은 지금 부서, 빼고 저장하면 목록에서 빠진다', async () => {
    const { user: u, onSubmit } = setup(row({ managers: ['kim@corp.example'], moved: ['lee@corp.example', 'gone@corp.example'] }));
    const lee = screen.getByRole('button', { name: '이옮김' });
    expect(lee).toHaveAttribute('data-moved');
    expect(lee).toHaveAttribute('title', '지금 부서: 영업팀');
    expect(screen.getByRole('button', { name: 'gone@corp.example' })).toHaveAttribute('title', '지금 부서: 다른 부서');
    await u.click(within(lee).getByTestId('CancelIcon'));
    await u.click(screen.getByRole('button', { name: '저장' }));
    // 옮긴 사람만 뺐으니 확인 없이 보낸다
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith(['kim@corp.example', 'gone@corp.example']));
  });

  it('400 은 칸 아래 서버 문구, 403 은 창 안 오류 줄', async () => {
    const bad = new ApiError('이 부서로 로그인한 적이 없는 사람입니다: x@corp.example', 400, '', 'emails');
    const onSubmit = vi.fn().mockRejectedValueOnce(bad).mockRejectedValueOnce(new ApiError('관리자만 할 수 있습니다', 403));
    const { user: u } = setup(row({ managers: ['kim@corp.example'] }), onSubmit);
    await addPark(u);
    await u.click(screen.getByRole('button', { name: '저장' }));
    expect(await screen.findByText('이 부서로 로그인한 적이 없는 사람입니다: x@corp.example')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
    await u.click(screen.getByRole('button', { name: '저장' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('관리자만 할 수 있습니다');
  });

  it('저장 중에는 입력이 잠기고 Esc 로 닫히지 않는다', async () => {
    let done: () => void = () => undefined;
    const onSubmit = vi.fn(() => new Promise<void>((r) => (done = r)));
    const { user: u, onClose } = setup(row({ managers: ['kim@corp.example'] }), onSubmit);
    await addPark(u);
    await u.click(screen.getByRole('button', { name: '저장' }));
    expect(screen.getByRole('combobox', { name: '팀 관리자' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '저장' })).toBeDisabled();
    await u.keyboard('{Escape}');
    expect(onClose).not.toHaveBeenCalled();
    done();
  });
});

describe('ManagersCell — 표의 팀 관리자 칸(DD1·DD4)', () => {
  const names = new Map(USERS.map((x) => [x.email, x.name]));
  it('칩 최대 2개 + 「외 n」', () => {
    render(<ManagersCell row={row({ managers: ['kim@corp.example', 'park@corp.example', 'choi@corp.example'] })} names={names} />);
    expect(screen.getByText('김철수')).toBeInTheDocument();
    expect(screen.getByText('박영희')).toBeInTheDocument();
    expect(screen.queryByText('최민수')).toBeNull();
    expect(screen.getByText('외 1')).toHaveAttribute('title', '최민수');
  });

  it('옮긴 사람은 흐린 「옮김 n」 글자와 툴팁, 호박 알약은 없다', () => {
    const { container } = render(<ManagersCell row={row({ managers: ['kim@corp.example'], moved: ['lee@corp.example'] })} names={names} />);
    expect(screen.getByText('옮김 1')).toHaveAttribute('title', '부서를 옮겨 권한이 없습니다');
    expect(container.querySelector('[data-pill]')).toBeNull();
  });

  it('없으면 흐린 「—」', () => {
    render(<ManagersCell row={row()} names={names} />);
    expect(screen.getByText('—')).toBeInTheDocument();
  });
});

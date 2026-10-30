/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 관리 › 공지(스펙 2026-10-24-007 4-6, 디자인 리뷰 2B·2C·2D·2E·3A·3B·5E·5G)
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { mountScreen, postedTo, stubApi } from '@/test/mountScreen';

import { type AdminNotice, Notices } from './Notices';

afterEach(() => vi.unstubAllGlobals());

const row = (over: Partial<AdminNotice> = {}): AdminNotice => ({
  id: 1,
  kind: 'maintenance',
  title: '판 올리기 작업',
  body: '오늘 밤 작업합니다',
  link: '',
  starts_at: '2026-10-24T13:00:00+00:00',
  ends_at: '2026-10-24T15:00:00+00:00',
  dismissible: true,
  updated_ts: 'u1',
  reshow_ts: 'r1',
  audience: 'all',
  status: 'active',
  author: 'admin@x',
  author_name: '김관리',
  ts: 't',
  editor: 'admin@x',
  deleted: false,
  ...over,
});

const LIST = (notices: AdminNotice[], over: Record<string, unknown> = {}) => ({ notices, limited: false, limit: 1000, reach_enabled: true, ...over });
const DEPTS = { departments: [{ name: '개발팀', goal: '', ts: '' }, { name: '영업팀', goal: '', ts: '' }] };
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

function stub(list: () => unknown, onPost?: (b: Record<string, unknown>) => unknown) {
  return stubApi({
    '/api/departments': DEPTS,
    '/api/notices': (_u: string, b: Record<string, unknown>) => (b.action ? (b.action === 'reach' ? { reach: 12 } : onPost?.(b) ?? { ok: true, notice: row() }) : list()),
  });
}

const cards = async () => {
  await screen.findByRole('tablist');
  return screen.getAllByRole('tab').map((t) => t.getAttribute('aria-label'));
};

describe('공지 관리', () => {
  it('보기 카드 4개(보이는 중 기본)와 개수, 상태 Pill, 대상 부서가 없어진 공지는 「대상 부서가 없어짐」, 작성자는 이메일이 아니라 이름', async () => {
    stub(() =>
      LIST([
        row(),
        row({ id: 2, title: '새 기능 소개', kind: 'feature', status: 'scheduled' }),
        row({ id: 3, title: '옛 작업', status: 'ended' }),
        row({ id: 4, title: '사라진 부서 공지', audience: ['없는팀'] }),
      ])
    );
    mountScreen(<Notices />, '/notices');
    expect(await screen.findByText('판 올리기 작업')).toBeInTheDocument();
    expect(await cards()).toEqual(['보이는 중, 2', '예정, 1', '끝남, 1', '내림, 0']);
    expect(screen.getAllByRole('tab')[0]).toHaveAttribute('aria-selected', 'true');
    expect(screen.queryByText('새 기능 소개')).toBeNull();
    expect(await screen.findByText('대상 부서가 없어짐')).toBeInTheDocument();
    expect(screen.getAllByText('김관리').length).toBeGreaterThan(0);
    expect(screen.queryByText('admin@x')).toBeNull();
  });

  it('공지가 하나도 없으면 안내 문장과 「+ 새 공지」, 1,000행이면 안내 띠', async () => {
    stub(() => LIST([], { limited: true }));
    mountScreen(<Notices />, '/notices');
    expect(await screen.findByText(/아직 공지가 없습니다/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /새 공지/ })).toBeInTheDocument();
    expect(screen.getByText('최근 1,000개만 보입니다')).toBeInTheDocument();
  });

  it('서버가 거절한 칸(400 field)은 그 칸 아래에 오류를 보인다(2E)', async () => {
    const user = userEvent.setup();
    const fn = stub(
      () => LIST([]),
      () => json(400, { error: '주소를 쓸 수 없습니다', field: 'link' })
    );
    mountScreen(<Notices />, '/notices');
    await user.click(await screen.findByRole('button', { name: /새 공지/ }));
    fireEvent.change(await screen.findByRole('textbox', { name: '제목' }), { target: { value: '점검' } });
    await user.click(screen.getByRole('button', { name: '저장' }));
    expect(await screen.findByText('주소를 쓸 수 없습니다')).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: '바로 가기' })).toHaveAttribute('aria-invalid', 'true');
    expect(postedTo(fn, '/api/notices').filter((b) => b.action === 'save')).toEqual([
      expect.objectContaining({ action: 'save', kind: 'info', title: '점검', audience: 'all', dismissible: true }),
    ]);
  });

  it('저장 전에 화면이 먼저 본다: 주소 형식·제목 글자 수(N/80)', async () => {
    const user = userEvent.setup();
    const fn = stub(() => LIST([]));
    mountScreen(<Notices />, '/notices');
    await user.click(await screen.findByRole('button', { name: /새 공지/ }));
    fireEvent.change(await screen.findByRole('textbox', { name: '제목' }), { target: { value: '가'.repeat(81) } });
    fireEvent.change(screen.getByRole('textbox', { name: '바로 가기' }), { target: { value: 'javascript:alert(1)' } });
    expect(screen.getByText('81/80')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '저장' }));
    expect(await screen.findByText('80자까지 쓸 수 있습니다')).toBeInTheDocument();
    expect(screen.getByText(/#\/ 로 시작하는/)).toBeInTheDocument();
    expect(postedTo(fn, '/api/notices').filter((b) => b.action === 'save')).toEqual([]);
  });

  it('장애를 고르면 닫기 허용이 꺼지고 비활성이며 안내가 보인다', async () => {
    const user = userEvent.setup();
    stub(() => LIST([]));
    mountScreen(<Notices />, '/notices');
    await user.click(await screen.findByRole('button', { name: /새 공지/ }));
    const sw = await screen.findByRole('checkbox', { name: '사용자가 닫을 수 있게 하기' });
    expect(sw).toBeChecked();
    await user.click(screen.getByRole('radio', { name: /장애/ }));
    expect(sw).not.toBeChecked();
    expect(sw).toBeDisabled();
    expect(screen.getByText('장애 공지는 닫을 수 없습니다')).toBeInTheDocument();
  });

  it('「1시간 연장」은 본 끝 시각을 함께 보내고, 409 면 알리고 목록을 다시 읽는다(3A)', async () => {
    const user = userEvent.setup();
    let reads = 0;
    const fn = stub(
      () => (reads++, LIST([row()])),
      () => json(409, { error: '그사이 공지가 바뀌었습니다. 목록을 다시 읽습니다.', reason: 'changed' })
    );
    mountScreen(<Notices />, '/notices');
    await user.click(await screen.findByRole('button', { name: '판 올리기 작업 동작' }));
    await user.click(await screen.findByRole('menuitem', { name: '1시간 연장' }));
    expect(await screen.findByText('그사이 공지가 바뀌었습니다. 목록을 다시 읽습니다.')).toBeInTheDocument();
    expect(postedTo(fn, '/api/notices').filter((b) => b.action === 'extend')).toEqual([{ action: 'extend', id: 1, ends_at: '2026-10-24T15:00:00+00:00' }]);
    await waitFor(() => expect(reads).toBeGreaterThan(1));
  });

  it('「지금 내리기」는 확인(Tier 3 「내리기」)을 거치고, 「「완료」 안내 공지 이어서 만들기」를 켜면 내린 뒤 같은 대상·(완료) 제목·안내 종류의 새 공지 서랍을 연다(3B·E8)', async () => {
    const user = userEvent.setup();
    const fn = stub(
      () => LIST([row({ audience: ['개발팀'] })]),
      (b) => (b.action === 'remove' ? { ok: true, notice: row({ deleted: true, status: 'deleted' }) } : { ok: true, notice: row() })
    );
    mountScreen(<Notices />, '/notices');
    await user.click(await screen.findByText('판 올리기 작업'));
    await user.click(await screen.findByRole('button', { name: '지금 내리기' }));
    const dlg = await screen.findByRole('dialog', { name: '‘판 올리기 작업’ 공지를 내릴까요?' });
    expect(within(dlg).getByText('대상 사람의 화면에서 곧 사라집니다. 내린 공지는 되살릴 수 없습니다. 같은 공지가 필요하면 「복사해서 새로 만들기」를 쓰세요')).toBeInTheDocument();
    await user.click(within(dlg).getByRole('checkbox', { name: '「완료」 안내 공지 이어서 만들기' }));
    await user.click(within(dlg).getByRole('button', { name: '내리기' }));
    await waitFor(() => expect(postedTo(fn, '/api/notices').filter((b) => b.action === 'remove')).toEqual([{ action: 'remove', id: 1 }]));
    expect(await screen.findByDisplayValue('(완료) 판 올리기 작업')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('radio', { name: /^안내/ })).toBeChecked());
    expect(await screen.findByRole('checkbox', { name: '개발팀' })).toBeChecked();
  });

  it('내리기를 취소하면 아무것도 보내지 않는다', async () => {
    const user = userEvent.setup();
    const fn = stub(() => LIST([row()]));
    mountScreen(<Notices />, '/notices');
    await user.click(await screen.findByText('판 올리기 작업'));
    await user.click(await screen.findByRole('button', { name: '지금 내리기' }));
    const dlg = await screen.findByRole('dialog');
    await user.click(within(dlg).getByRole('button', { name: '취소' }));
    expect(postedTo(fn, '/api/notices').filter((b) => b.action === 'remove')).toEqual([]);
  });

  it('저장하면 보이는 중이면 대상 사람 수를 토스트로 알린다(2C)', async () => {
    const user = userEvent.setup();
    stub(
      () => LIST([]),
      () => ({ ok: true, notice: row(), reach: 34 })
    );
    mountScreen(<Notices />, '/notices');
    await user.click(await screen.findByRole('button', { name: /새 공지/ }));
    fireEvent.change(await screen.findByRole('textbox', { name: '제목' }), { target: { value: '점검' } });
    expect(await screen.findByText('약 12명(아직 로그인하지 않은 사람 포함)')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '저장' }));
    expect(await screen.findByText('저장했습니다. 약 34명의 화면에 곧 보입니다')).toBeInTheDocument();
  });
});

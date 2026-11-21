/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';

import { filterShareRows, SEARCH_MIN, SharePicker, ShareRow, shareRows } from './SharePicker';

const NAMES: Record<string, string> = { 'kim@x.com': '김영주', 'lee@x.com': '이유리' };
const nameOf = (e: string) => NAMES[e];

describe('shareRows(스펙 2026-11-18-001)', () => {
  it('사람 이름 순, 같은 사람 안에서는 작업공간 이름 순, 주인 없는 것은 끝', () => {
    const rows = shareRows(
      [
        { id: 'p1', owner: 'lee@x.com', name: '구글 에이전트' },
        { id: 'p2', name: '공용' },
        { id: 'p3', owner: 'kim@x.com', name: '영업' },
        { id: 'p4', owner: 'kim@x.com', name: '마케팅' },
        { id: 'p5', owner: 'park@x.com' },
      ],
      nameOf,
    );
    expect(rows.map((r) => [r.owner, r.agent])).toEqual([
      ['김영주', '마케팅'],
      ['김영주', '영업'],
      ['이유리', '구글 에이전트'],
      ['park@x.com', 'p5'], // 이름을 모르면 이메일, 작업공간 이름이 없으면 id
      ['', '공용'],
    ]);
  });

  it('찾기는 사람 이름·작업공간 이름·id 를 대소문자 없이 본다', () => {
    const rows: ShareRow[] = [
      { id: 'share-sales', owner: '김영주', agent: 'Sales' },
      { id: 'p2', owner: '이유리', agent: '구글' },
    ];
    expect(filterShareRows(rows, ' sales ').map((r) => r.id)).toEqual(['share-sales']);
    expect(filterShareRows(rows, '유리').map((r) => r.id)).toEqual(['p2']);
    expect(filterShareRows(rows, '')).toHaveLength(2);
  });
});

function Harness({ rows, initial = [] }: { rows: ShareRow[]; initial?: string[] }) {
  const [v, setV] = useState(initial);
  return <SharePicker rows={rows} value={v} onChange={setV} />;
}

const many = (n: number): ShareRow[] =>
  Array.from({ length: n }, (_, i) => ({ id: `p${i}`, owner: i < 3 ? '김영주' : `사람${i}`, agent: `작업공간${i}` }));

describe('SharePicker', () => {
  it('같은 사람의 작업공간은 사람 이름을 첫 줄에만 보이고, 체크박스 이름은 줄마다 「주인 · 작업공간」', () => {
    render(<Harness rows={many(3)} />);
    expect(screen.getAllByText('김영주')).toHaveLength(1);
    expect(screen.getByRole('checkbox', { name: '김영주 · 작업공간2' })).toBeInTheDocument();
  });

  it('고르면 개수가 바뀌고 「모두 해제」로 비운다', async () => {
    const u = userEvent.setup();
    render(<Harness rows={many(3)} />);
    expect(screen.getByText('3개 중 0개 공유')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '모두 해제' })).not.toBeInTheDocument();
    await u.click(screen.getByRole('checkbox', { name: '김영주 · 작업공간0' }));
    await u.click(screen.getByRole('checkbox', { name: '김영주 · 작업공간1' }));
    expect(screen.getByText('3개 중 2개 공유')).toBeInTheDocument();
    await u.click(screen.getByRole('button', { name: '모두 해제' }));
    expect(screen.getByText('3개 중 0개 공유')).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: '김영주 · 작업공간0' })).not.toBeChecked();
  });

  it('목록에 없는 id 는 세지 않고 「모두 해제」도 지우지 않는다', async () => {
    const u = userEvent.setup();
    let last: string[] = [];
    render(<SharePicker rows={many(2)} value={['gone', 'p0']} onChange={(ids) => (last = ids)} />);
    expect(screen.getByText('2개 중 1개 공유')).toBeInTheDocument();
    await u.click(screen.getByRole('button', { name: '모두 해제' }));
    expect(last).toEqual(['gone']);
  });

  it(`${SEARCH_MIN}개를 넘을 때만 찾기 칸이 있고, 맞는 것이 없으면 알린다`, async () => {
    const u = userEvent.setup();
    const { unmount } = render(<Harness rows={many(SEARCH_MIN)} />);
    expect(screen.queryByRole('searchbox')).not.toBeInTheDocument();
    unmount();
    render(<Harness rows={many(SEARCH_MIN + 1)} />);
    await u.type(screen.getByRole('searchbox', { name: '사람이나 AI 에이전트 작업공간 이름으로 찾기' }), '사람5');
    expect(screen.getAllByRole('checkbox')).toHaveLength(1);
    await u.clear(screen.getByRole('searchbox'));
    await u.type(screen.getByRole('searchbox'), '없는이름');
    expect(screen.getByText('「없는이름」에 맞는 AI 에이전트 작업공간이 없습니다')).toBeInTheDocument();
  });

  it('공유할 것이 없으면 목록 대신 안내', () => {
    render(<Harness rows={[]} />);
    expect(screen.getByText('공유할 AI 에이전트 작업공간이 없습니다')).toBeInTheDocument();
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
  });
});

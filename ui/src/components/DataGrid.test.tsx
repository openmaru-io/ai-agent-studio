/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ageColumn,
  ageText,
  clampPage,
  DataGrid,
  DataGridProps,
  formatSort,
  GridColumn,
  GridSort,
  loadRowsPerPage,
  LocalDataGrid,
  nameColumn,
  nextSort,
  overflows,
  parseSort,
  sortRows,
  togglePage,
} from './DataGrid';

interface R {
  id: string;
  name: string;
  size?: number;
  at?: string;
}

const COLS: GridColumn<R>[] = [
  nameColumn<R>({ label: '이름', value: (r) => r.name }),
  { id: 'size', label: '크기', value: (r) => r.size, num: true },
];

describe('정렬·페이지 규칙(§4-9 7A)', () => {
  const rows: R[] = [
    { id: '1', name: 'agent-10', size: 3 },
    { id: '2', name: 'agent-2' },
    { id: '3', name: 'Agent-1', size: 1 },
    { id: '4', name: '', size: 2 },
  ];

  it('누를 때마다 오름 → 내림 → 해제, 다른 열은 오름부터', () => {
    expect(nextSort(null, 'name')).toEqual({ id: 'name', desc: false });
    expect(nextSort({ id: 'name', desc: false }, 'name')).toEqual({ id: 'name', desc: true });
    expect(nextSort({ id: 'name', desc: true }, 'name')).toBeNull();
    expect(nextSort({ id: 'name', desc: true }, 'size')).toEqual({ id: 'size', desc: false });
  });

  it('주소의 sort 를 읽고 쓴다', () => {
    expect(parseSort('size,desc')).toEqual({ id: 'size', desc: true });
    expect(parseSort('name,asc')).toEqual({ id: 'name', desc: false });
    expect(parseSort(null)).toBeNull();
    expect(formatSort({ id: 'size', desc: false })).toBe('size,asc');
    expect(formatSort(null)).toBeNull();
  });

  it('문자는 숫자를 인식하고 대소문자를 가리지 않으며, 빈 값은 방향과 상관없이 끝', () => {
    expect(sortRows(rows, COLS, { id: 'name', desc: false }).map((r) => r.id)).toEqual(['3', '2', '1', '4']);
    expect(sortRows(rows, COLS, { id: 'name', desc: true }).map((r) => r.id)).toEqual(['1', '2', '3', '4']);
    expect(sortRows(rows, COLS, { id: 'size', desc: false }).map((r) => r.id)).toEqual(['3', '4', '1', '2']);
    expect(sortRows(rows, COLS, { id: 'size', desc: true }).map((r) => r.id)).toEqual(['1', '4', '3', '2']);
  });

  it('그 탭에 없는 열·정렬을 끈 열이면 원래 순서(검토 D19)', () => {
    expect(sortRows(rows, COLS, { id: 'nope', desc: false })).toBe(rows);
    const noSort: GridColumn<R>[] = [{ ...COLS[1], sort: false }];
    expect(sortRows(rows, noSort, { id: 'size', desc: false })).toBe(rows);
  });

  it('경과 시간 열은 시각 값으로 정렬하고 시각이 없으면 끝', () => {
    const col = ageColumn<R>({ label: '경과', value: (r) => r.at });
    const at: R[] = [
      { id: 'a', name: 'a', at: '2026-10-13T10:00:00Z' },
      { id: 'b', name: 'b' },
      { id: 'c', name: 'c', at: '2026-10-12T10:00:00Z' },
    ];
    expect(sortRows(at, [col], { id: 'age', desc: false }).map((r) => r.id)).toEqual(['c', 'a', 'b']);
  });

  it('페이지가 범위를 벗어나면 마지막 페이지로(회귀 계약 10)', () => {
    expect(clampPage(3, 30, 20)).toBe(1);
    expect(clampPage(1, 30, 20)).toBe(1);
    expect(clampPage(2, 0, 20)).toBe(0);
  });

  it('경과 시간 표기: 방금 / 분 / 시간 / 일 / 30일 넘으면 날짜', () => {
    const now = Date.parse('2026-10-13T12:00:00Z');
    expect(ageText('2026-10-13T11:59:30Z', now)).toBe('방금');
    expect(ageText('2026-10-13T11:55:00Z', now)).toBe('5분');
    expect(ageText('2026-10-13T09:00:00Z', now)).toBe('3시간');
    expect(ageText('2026-10-10T12:00:00Z', now)).toBe('3일');
    expect(ageText('2026-08-01T12:00:00Z', now)).toBe('2026-08-01'); // 연도까지
    expect(ageText(undefined, now)).toBe('');
  });

  it('넘칠 때만 tooltip(재검토 D5)', () => {
    expect(overflows({ scrollWidth: 120, clientWidth: 100 })).toBe(true);
    expect(overflows({ scrollWidth: 100, clientWidth: 100 })).toBe(false);
    expect(overflows(null)).toBe(false);
  });
});

function Harness(over: Partial<DataGridProps<R>> & { all?: R[] }) {
  const all = over.all ?? Array.from({ length: 25 }, (_, n) => ({ id: String(n), name: `row${n}`, size: n }));
  const [page, setPage] = useState(0);
  const [size, setSize] = useState(20);
  const [sort, setSort] = useState<GridSort | null>(null);
  const sorted = sortRows(all, COLS, sort);
  return (
    <DataGrid<R>
      storageKey="test.all"
      label="시험 표"
      columns={COLS}
      rows={sorted.slice(page * size, (page + 1) * size)}
      rowId={(r) => r.id}
      rowName={(r) => r.name}
      total={all.length}
      page={page}
      rowsPerPage={size}
      onPage={setPage}
      onRowsPerPage={setSize}
      sort={sort}
      onSort={setSort}
      {...over}
    />
  );
}

describe('DataGrid', () => {
  afterEach(() => {
    vi.useRealTimers();
    localStorage.clear();
  });

  it('머리를 누르면 정렬하고 aria-sort 로 알린다', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const head = screen.getByRole('columnheader', { name: /크기/ });
    expect(head).toHaveAttribute('aria-sort', 'none');
    await user.click(within(head).getByRole('button'));
    expect(head).toHaveAttribute('aria-sort', 'ascending');
    await user.click(within(head).getByRole('button'));
    expect(head).toHaveAttribute('aria-sort', 'descending');
    expect(screen.getAllByRole('row')[1]).toHaveTextContent('row24');
  });

  it('열 목록이 바뀌면(탭 이동) 새 열 목록의 순서대로 그린다', () => {
    // 라이브러리 → 설치 환경 탭에서 앞 탭의 열 순서가 남아 이름 열이 가운데로 가던 것(OMAI-1127 단계 5)
    const { rerender } = render(<Harness />);
    const other: GridColumn<R>[] = [
      nameColumn<R>({ id: 'env', label: '환경', value: (r) => r.name }),
      { id: 'at', label: '시각', value: (r) => r.at },
      { id: 'size', label: '크기', value: (r) => r.size, num: true },
    ];
    rerender(<Harness columns={other} storageKey="test.other" />);
    expect(screen.getAllByRole('columnheader').map((h) => h.textContent)).toEqual(['환경', '시각', '크기']);
  });

  it('행이 가장 작은 행 수 옵션보다 많을 때만 바닥 줄이 있고, 다음 페이지로 간다', async () => {
    const user = userEvent.setup();
    const { container, unmount } = render(<Harness />);
    expect(container.querySelector('[data-grid-range]')).toHaveTextContent('1–20 / 25');
    await user.click(screen.getByRole('button', { name: '다음 페이지' }));
    expect(container.querySelector('[data-grid-range]')).toHaveTextContent('21–25 / 25');
    unmount();
    const few = Array.from({ length: 20 }, (_, n) => ({ id: String(n), name: `r${n}` }));
    const r2 = render(<Harness all={few} />);
    expect(r2.container.querySelector('[data-grid-footer]')).toBeNull();
  });

  it('열을 숨기면 그 키에 남고 다시 그릴 때 읽는다. 이름 열은 숨길 수 없다. 기본값으로 되돌린다', async () => {
    const user = userEvent.setup();
    const { unmount } = render(<Harness />);
    await user.click(screen.getByRole('button', { name: '열 고르기' }));
    const menu = screen.getByRole('menu');
    expect(within(menu).queryByText('이름')).not.toBeInTheDocument();
    await user.click(within(menu).getByText('크기'));
    expect(JSON.parse(localStorage.getItem('aas.grid.test.all') ?? '[]')).toEqual(['size']);
    unmount();
    render(<Harness />);
    expect(screen.queryByRole('columnheader', { name: /크기/ })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '열 고르기' }));
    await user.click(screen.getByText('기본값으로'));
    expect(localStorage.getItem('aas.grid.test.all')).toBeNull();
    expect(screen.getByRole('columnheader', { name: /크기/ })).toBeInTheDocument();
  });

  it('localStorage 가 예외를 던져도 기본값으로 그린다', () => {
    const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    try {
      render(<Harness />);
      expect(screen.getByRole('table', { name: '시험 표' })).toBeInTheDocument();
      expect(loadRowsPerPage()).toBe(20);
    } finally {
      spy.mockRestore();
    }
  });

  it('행을 누르거나 Enter·Space 로 연다. 메뉴 단추는 행 누르기를 일으키지 않는다', async () => {
    const user = userEvent.setup();
    const seen: string[] = [];
    const acted: string[] = [];
    render(
      <Harness
        onRow={(r) => seen.push(r.id)}
        actions={[
          { id: 'open', label: '상세 보기', onClick: (r) => seen.push(r.id) },
          { id: 'resume', label: '재개', onClick: (r) => acted.push(r.id), visible: (r) => r.id === '1' },
        ]}
      />
    );
    const rows = screen.getAllByRole('row');
    await user.click(within(rows[1]).getByText('row0'));
    expect(seen).toEqual(['0']);
    rows[2].focus();
    await user.keyboard('{Enter}');
    rows[3].focus();
    await user.keyboard(' ');
    expect(seen).toEqual(['0', '1', '2']);
    await user.click(screen.getByRole('button', { name: 'row1 동작' }));
    expect(seen).toEqual(['0', '1', '2']);
    await user.click(screen.getByRole('menuitem', { name: '재개' }));
    expect(acted).toEqual(['1']);
    await user.click(screen.getByRole('button', { name: 'row0 동작' }));
    expect(screen.queryByRole('menuitem', { name: '재개' })).not.toBeInTheDocument();
  });

  it('메뉴 항목이 상세 보기 하나뿐이면 메뉴 열이 없다', () => {
    render(<Harness actions={[{ id: 'open', label: '상세 보기', onClick: () => undefined }]} />);
    expect(screen.queryByRole('button', { name: /동작$/ })).not.toBeInTheDocument();
  });

  it('선택한 행은 aria-current 이고 누를 수 없는 행은 aria-disabled', () => {
    render(<Harness selectedId="1" />);
    const rows = screen.getAllByRole('row');
    expect(rows[2]).toHaveAttribute('aria-current', 'true');
    expect(rows[1]).toHaveAttribute('aria-current', 'false');
    expect(rows[1]).toHaveAttribute('aria-disabled', 'true');
  });

  it('셀에 링크·단추가 있는 표(cellControls)는 누를 수 없는 행에도 aria-disabled 를 달지 않는다', () => {
    render(<Harness cellControls />);
    expect(screen.getAllByRole('row')[1]).not.toHaveAttribute('aria-disabled');
  });

  it('행이 없으면 머리를 두고 몸체 칸에 안내를 보이며 바닥 줄은 없다', () => {
    const { container } = render(<Harness all={[]} empty="비어 있습니다" />);
    expect(screen.getByRole('columnheader', { name: /이름/ })).toBeInTheDocument();
    expect(container.querySelector('[data-grid-empty]')).toHaveTextContent('비어 있습니다');
    expect(container.querySelector('[data-grid-footer]')).toBeNull();
  });

  it('새로 고침은 누른 때만 진행 막대를 보인다(재검토 D4)', async () => {
    const user = userEvent.setup();
    const onRefresh = vi.fn();
    const { rerender } = render(<Harness onRefresh={onRefresh} refreshing />);
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument(); // 자동 다시 받기
    rerender(<Harness onRefresh={onRefresh} refreshing={false} />);
    await user.click(screen.getByRole('button', { name: '새로 고침' }));
    expect(onRefresh).toHaveBeenCalledTimes(1);
    rerender(<Harness onRefresh={onRefresh} refreshing />);
    expect(screen.getByRole('progressbar')).toBeInTheDocument();
    rerender(<Harness onRefresh={onRefresh} refreshing={false} />);
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
  });

  it('경과 시간 칸은 5초마다 다시 그린다', () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    vi.setSystemTime(Date.parse('2026-10-13T12:00:50Z'));
    const cols: GridColumn<R>[] = [nameColumn<R>({ label: '이름', value: (r) => r.name }), ageColumn<R>({ label: '경과', value: (r) => r.at })];
    const { container } = render(
      <DataGrid<R>
        storageKey="test.age"
        label="표"
        columns={cols}
        rows={[{ id: 'x', name: 'x', at: '2026-10-13T12:00:00Z' }]}
        rowId={(r) => r.id}
        rowName={(r) => r.name}
        total={1}
        page={0}
        rowsPerPage={20}
        onPage={() => undefined}
        onRowsPerPage={() => undefined}
        sort={null}
        onSort={() => undefined}
      />
    );
    expect(container.querySelector('[data-age]')).toHaveTextContent('방금');
    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(container.querySelector('[data-age]')).toHaveTextContent('1분');
  });
});

describe('LocalDataGrid(주소에 담지 않는 작은 표, 단계 7 오피스)', () => {
  const rows: R[] = [
    { id: 'a', name: 'beta', size: 2 },
    { id: 'b', name: 'alpha', size: 3 },
    { id: 'c', name: 'gamma', size: 1 },
  ];
  it('머리를 누르면 안에서 정렬하고, 검색창은 search 로 거르며 개수를 「N개 중 M개」로 보인다', async () => {
    const user = userEvent.setup();
    render(<LocalDataGrid<R> storageKey="t.local" label="작은 표" columns={COLS} rows={rows} rowId={(r) => r.id} search={(r) => r.name} />);
    const names = () => screen.getAllByRole('row').slice(1).map((r) => r.querySelector('[data-row-title]')?.textContent);
    expect(names()).toEqual(['beta', 'alpha', 'gamma']); // 받은 순서
    await user.click(within(screen.getByRole('columnheader', { name: /이름/ })).getByRole('button'));
    expect(names()).toEqual(['alpha', 'beta', 'gamma']);
    await user.type(screen.getByRole('searchbox'), 'mm');
    expect(names()).toEqual(['gamma']);
    expect(document.querySelector('[data-grid-count]')).toHaveTextContent('3개 중 1개');
  });

  it('search 가 없으면 검색창이 없고, 행을 누르면 onRow 를 부른다', async () => {
    const user = userEvent.setup();
    const seen: string[] = [];
    render(<LocalDataGrid<R> storageKey="t.local2" label="작은 표" columns={COLS} rows={rows} rowId={(r) => r.id} onRow={(r) => seen.push(r.id)} />);
    expect(screen.queryByRole('searchbox')).toBeNull();
    await user.click(screen.getByRole('row', { name: /gamma/ }));
    expect(seen).toEqual(['c']);
  });

  it('빨간 링은 키보드로 행에 닿았을 때만 그린다: 마우스로 연 행은 서랍을 Esc 로 몇 번 눌러 닫아도 링이 없다(2026-10-18 재발)', async () => {
    // 마우스로 연 행의 서랍을 Esc 로 닫으면 MUI 가 초점을 행으로 되돌리고, 브라우저는 마지막 입력이 키보드라 그 행을 :focus-visible 로 본다.
    // 예전에는 「마우스로 눌렀다」는 표시(data-pointer)를 두고 키를 누르면 지웠다. Esc 를 한 번 더 누르거나 길게 누르면(자동 반복) 표시가 지워져 링이 생겼다.
    // 이제는 거꾸로 「키보드로 닿았다」는 표시(data-kbd)가 있을 때만 그린다. Esc 는 닫는 키라 표시를 달지 않는다. jsdom 은 :focus-visible 을 계산하지 않아 표시와 규칙을 본다.
    const user = userEvent.setup();
    render(
      <>
        <button type="button">앞</button>
        <LocalDataGrid<R> storageKey="t.local3" label="작은 표" columns={COLS} rows={rows} rowId={(r) => r.id} onRow={() => undefined} />
        <div role="dialog" tabIndex={-1} data-testid="drawer" />
        <button type="button">바깥</button>
      </>
    );
    const row = screen.getByRole('row', { name: /gamma/ });
    await user.click(row);
    expect(row).not.toHaveAttribute('data-kbd');
    act(() => screen.getByTestId('drawer').focus()); // 서랍이 열려 초점이 서랍으로 간다
    act(() => row.focus()); // 서랍이 Esc 로 닫혀 초점이 돌아온다
    await user.keyboard('{Escape}{Escape}'); // 한 번 더(또는 길게) 눌러도 링을 달지 않는다
    expect(row).not.toHaveAttribute('data-kbd');
    await user.keyboard('{ArrowDown}'); // 키보드로 움직이면 그린다
    expect(row).toHaveAttribute('data-kbd');
    await user.click(row); // 마우스로 누르면 다시 지운다
    expect(row).not.toHaveAttribute('data-kbd');
    act(() => screen.getByRole('button', { name: '바깥' }).focus());
    await user.click(screen.getByRole('button', { name: '앞' }));
    for (let i = 0; i < 12 && document.activeElement !== row; i++) await user.tab(); // Tab 으로 행에 닿으면 그린다(표 머리의 단추를 지나서)
    expect(row).toHaveFocus();
    expect(row).toHaveAttribute('data-kbd');
    act(() => screen.getByTestId('drawer').focus()); // 키보드로 연 서랍으로 초점이 가도 표시는 남아, 닫고 돌아오면 링이 보인다
    expect(row).toHaveAttribute('data-kbd');
    act(() => row.focus()); // 서랍이 닫혀 초점이 돌아온다 — 키보드로 연 행이므로 링이 보인다
    expect(row).toHaveAttribute('data-kbd');
    act(() => screen.getByRole('button', { name: '바깥' }).focus()); // 서랍이 아닌 곳으로 떠나면 지운다
    expect(row).not.toHaveAttribute('data-kbd');
    const css = [...document.styleSheets].flatMap((s) => [...s.cssRules].map((r) => r.cssText)).join('\n');
    expect(css).toMatch(/\[data-kbd\]:focus-visible::after/);
  });
});


describe('줄 고르기 열(스펙 2026-10-24-003 D16)', () => {
  function Pick() {
    const [sel, setSel] = useState<Set<string>>(() => new Set());
    return (
      <>
        <Harness select={{ selectable: (r) => Number(r.id) % 2 === 0, reason: () => '고친 내용이 있어 하나씩 올립니다', selected: sel, onChange: setSel }} />
        <output data-testid="sel">{[...sel].sort((a, b) => Number(a) - Number(b)).join(',')}</output>
      </>
    );
  }

  it('머리 체크는 이 페이지의 고를 수 있는 줄만 고르고 다시 누르면 푼다', () => {
    const rows = [{ id: '0', name: 'a' }, { id: '1', name: 'b' }, { id: '2', name: 'c' }];
    const sel = { selectable: (r: R) => r.id !== '1', selected: new Set(['9']) };
    const on = togglePage(rows, (r) => r.id, sel);
    expect([...on].sort()).toEqual(['0', '2', '9']);                // 다른 페이지의 고른 것(9)은 그대로
    expect([...togglePage(rows, (r) => r.id, { ...sel, selected: on })]).toEqual(['9']);
  });

  it('고를 수 없는 줄은 꺼져 있고 이유를 도움말로 단다, 고른 것은 페이지를 넘겨도 남는다', async () => {
    const user = userEvent.setup();
    render(<Pick />);
    expect(screen.getByRole('checkbox', { name: 'row1 선택' })).toBeDisabled();
    expect(document.querySelector('[data-select-reason="고친 내용이 있어 하나씩 올립니다"]')).not.toBeNull();
    await user.click(screen.getByRole('checkbox', { name: '이 페이지에서 선택할 수 있는 줄 모두 선택' }));
    expect(screen.getByTestId('sel').textContent).toBe('0,2,4,6,8,10,12,14,16,18');
    await user.click(screen.getByRole('button', { name: '다음 페이지' }));
    await user.click(screen.getByRole('checkbox', { name: 'row20 선택' }));
    expect(screen.getByTestId('sel').textContent).toBe('0,2,4,6,8,10,12,14,16,18,20');
  });

  it('select 가 없으면 체크 열을 그리지 않는다', () => {
    render(<Harness />);
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0);
  });
});

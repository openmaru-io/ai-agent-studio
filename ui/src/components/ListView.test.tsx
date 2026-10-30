/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';

import { DrawerHost } from './DrawerHost';
import { ListView, ListViewProps } from './ListView';
import { UiProvider, useUi } from './UiContext';

interface Item {
  id: string;
  name: string;
  kind: string;
}
const ITEMS: Item[] = [
  { id: 'a', name: 'alpha', kind: 'x' },
  { id: 'b', name: 'beta', kind: 'y' },
  { id: 'c', name: 'gamma', kind: 'x' },
];

function Where() {
  const l = useLocation();
  return <div data-testid="loc">{l.pathname + l.search}</div>;
}

function props(over: Partial<ListViewProps<Item>> = {}): ListViewProps<Item> {
  return {
    title: '시험 화면',
    sub: '부제',
    // 탭으로 가는 카드는 없어졌다. 보기를 고르는 카드는 탭의 card 로 만든다(보기 카드, 2026-10-17-011)
    cards: [{ n: 7, label: '카드만' }],
    tabs: [
      { id: 'issue', label: '확인할 것', tone: 'bad', items: ITEMS.slice(0, 1), empty: '확인할 것이 없습니다.' },
      { id: 'all', label: '전체', items: ITEMS },
      { id: 'none', label: '빈 탭', items: [], empty: '비어 있는 탭입니다.' },
    ],
    filters: [{ key: 'kind', label: '종류', get: (i) => i.kind }],
    text: (i) => `${i.name} ${i.kind}`,
    // 두 줄 목록(row)은 단계 7 에서 지웠다. 모든 시험이 표(columns·rowId)로 그린다
    columns: [
      { id: 'name', label: '이름', value: (i) => i.name, hideable: false, render: (i) => <span data-row-title="">{i.name}</span> },
      { id: 'kind', label: '종류', value: (i) => i.kind },
    ],
    rowId: (i) => i.id,
    detail: (i) => ({ title: i.name, sub: '상세', body: <div>{`상세 ${i.name}`}</div> }),
    ...over,
  };
}

function mount(p: ListViewProps<Item>, initial = '/x') {
  return render(
    <MemoryRouter initialEntries={[initial]}>
      <UiProvider>
        <ListView {...p} />
        <DrawerHost />
        <Where />
      </UiProvider>
    </MemoryRouter>
  );
}
const loc = () => screen.getByTestId('loc').textContent;
const bodyRows = () => screen.getAllByRole('row').slice(1);

describe('ListView', () => {
  it('제목·부제·카드·탭(개수)·행·합계를 보인다', () => {
    mount(props());
    expect(screen.getByRole('heading', { level: 1, name: '시험 화면' })).toBeInTheDocument();
    expect(screen.getByText('부제')).toBeInTheDocument();
    const tabs = screen.getByRole('tablist');
    expect(within(tabs).getByRole('tab', { name: /확인할 것/ })).toHaveTextContent('1');
    expect(within(tabs).getByRole('tab', { name: /전체/ })).toHaveTextContent('3');
    expect(screen.getByText('1개')).toBeInTheDocument(); // 첫 탭(확인할 것)의 합계
  });

  it('탭 개수 배지는 0 이면 탭의 색(빨강·주황)을 쓰지 않고 무채색이다(사용자 보고 2026-10-13)', () => {
    mount(props({ tabs: [
      { id: 'bad', label: '실패', tone: 'bad', items: ITEMS.slice(0, 1) },
      { id: 'zero', label: '멈춤', tone: 'bad', items: [] },
      { id: 'warn0', label: '알림 없음', tone: 'warn', items: [] },
    ] }));
    const badge = (name: RegExp) => screen.getByRole('tab', { name }).querySelector('.MuiBadge-badge') as HTMLElement;
    expect(badge(/실패/)).toHaveClass('MuiBadge-colorError');
    for (const name of [/멈춤/, /알림 없음/]) {
      expect(badge(name)).not.toHaveClass('MuiBadge-colorError'); // 0 이면 탭의 tone 색(빨강·주황)을 쓰지 않는다
      expect(badge(name)).not.toHaveClass('MuiBadge-colorWarning');
    }
  });

  it('요약 카드 숫자도 0 이면 화면이 준 색(good 포함)을 쓰지 않는다', () => {
    mount(props({ cards: [{ n: 0, label: '영', tone: 'good' }, { n: 5, label: '색 없음' }, { n: 2, label: '둘', tone: 'bad' }] }));
    const color = (label: string) =>
      getComputedStyle(screen.getByText(label).closest('[data-card]')!.querySelector('[data-card-n]') as HTMLElement).color;
    expect(color('영')).toBe(color('색 없음'));
    expect(color('둘')).not.toBe(color('색 없음'));
  });

  it('첫 탭이 기본이고 주소에 tab 이 없다. 다른 탭을 누르면 tab 이 담긴다', async () => {
    const user = userEvent.setup();
    mount(props());
    expect(screen.getByText('alpha')).toBeInTheDocument();
    expect(screen.queryByText('beta')).not.toBeInTheDocument();
    await user.click(screen.getByRole('tab', { name: /전체/ }));
    expect(loc()).toBe('/x?tab=all');
    expect(screen.getByText('beta')).toBeInTheDocument();
    await user.click(screen.getByRole('tab', { name: /확인할 것/ }));
    expect(loc()).toBe('/x'); // 첫 탭으로 돌아오면 주소에서 뺀다
  });

  it('주소의 tab·q·필터로 시작한다', () => {
    mount(props(), '/x?tab=all&q=ga&kind=x');
    expect(screen.getByText('gamma')).toBeInTheDocument();
    expect(screen.queryByText('alpha')).not.toBeInTheDocument();
    expect(screen.getByRole('searchbox')).toHaveValue('ga');
  });

  it('검색은 text() 에 대해 대소문자 없이 거르고 q 를 주소에 담는다', async () => {
    const user = userEvent.setup();
    mount(props(), '/x?tab=all');
    await user.type(screen.getByRole('searchbox'), 'BET');
    expect(bodyRows()).toHaveLength(1);
    expect(loc()).toBe('/x?tab=all&q=BET');
  });

  it('필터는 종류가 둘 이상일 때만 열 필터 줄에 나오고 고르면 거른다. 필터 지우기가 되돌린다', async () => {
    const user = userEvent.setup();
    mount(props(), '/x?tab=all');
    await user.click(screen.getByRole('button', { name: '열 필터' }));
    await user.selectOptions(screen.getByRole('combobox', { name: '종류' }), 'x');
    expect(loc()).toBe('/x?tab=all&kind=x');
    expect(bodyRows()).toHaveLength(2);
    await user.click(screen.getAllByRole('button', { name: '필터 지우기' })[0]);
    expect(loc()).toBe('/x?tab=all');
    expect(bodyRows()).toHaveLength(3);
  });

  it('필터 후보가 하나뿐이면 열 필터 단추를 보이지 않는다', () => {
    mount(props(), '/x'); // 첫 탭엔 kind 가 x 하나
    expect(screen.queryByRole('button', { name: '열 필터' })).not.toBeInTheDocument();
  });

  it('숫자만 카드는 누를 수 없다(버튼이 아니다)', () => {
    mount(props());
    expect(screen.queryByRole('button', { name: /카드만/ })).not.toBeInTheDocument();
    expect(screen.getByText('카드만')).toBeInTheDocument();
  });

  it('행을 누르면 서랍이 열리고 그 행에 aria-current 가 붙는다. 닫으면 풀린다', async () => {
    const user = userEvent.setup();
    mount(props(), '/x?tab=all');
    await user.click(screen.getByRole('row', { name: /beta/ }));
    const dlg = await screen.findByRole('dialog', { name: 'beta' });
    expect(within(dlg).getByText('상세 beta')).toBeInTheDocument();
    expect(screen.getByRole('row', { name: /beta/, hidden: true })).toHaveAttribute('aria-current', 'true');
    await user.click(within(dlg).getByRole('button', { name: '닫기' }));
    await screen.findByRole('row', { name: /beta/ });
    expect(screen.getByRole('row', { name: /beta/ })).not.toHaveAttribute('aria-current', 'true');
  });

  it('탭이나 화면에 onRow 가 있으면 서랍 대신 그것을 부른다', async () => {
    const user = userEvent.setup();
    const seen: string[] = [];
    mount(props({ onRow: (i) => seen.push(i.id) }), '/x?tab=all');
    await user.click(screen.getByRole('row', { name: /gamma/ }));
    expect(seen).toEqual(['c']);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('조건에 맞는 항목이 없으면 안내하고, 탭이 비었으면 그 탭의 안내를 보인다', async () => {
    const user = userEvent.setup();
    mount(props(), '/x?tab=all&q=zzz');
    expect(screen.getByText('조건에 맞는 항목이 없습니다.')).toBeInTheDocument();
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: '' } });
    await user.click(screen.getByRole('tab', { name: /빈 탭/ }));
    expect(screen.getByText('비어 있는 탭입니다.')).toBeInTheDocument();
  });

  it('화면 고유 인자(days 등)는 탭·검색을 바꿔도 주소에 남는다', async () => {
    const user = userEvent.setup();
    mount(props(), '/x?days=30');
    await user.click(screen.getByRole('tab', { name: /전체/ }));
    expect(loc()).toBe('/x?days=30&tab=all');
  });

  it('카드 설명(sub)을 보인다', () => {
    mount(props({ cards: [{ n: 1, label: '카드', sub: '프로파일마다 하나' }] }));
    expect(screen.getByText('프로파일마다 하나')).toBeInTheDocument();
  });

  it('탭마다 다른 열·상세를 쓰고 toolbar 를 툴바에 둔다', async () => {
    const user = userEvent.setup();
    const col = (prefix: string) => [{ id: 'name', label: '이름', value: (i: Item) => `${prefix} ${i.name}` }];
    mount(
      props({
        detail: undefined,
        toolbar: <select aria-label="기간" />,
        tabs: [
          {
            id: 'one',
            label: '하나',
            items: ITEMS.slice(0, 1),
            columns: col('첫째'),
            detail: (i: Item) => ({ title: `상세1 ${i.name}`, body: null }),
          },
          { id: 'two', label: '둘', items: ITEMS.slice(1, 2), columns: col('둘째') },
        ],
      })
    );
    expect(screen.getByRole('combobox', { name: '기간' })).toBeInTheDocument();
    await user.click(screen.getByRole('row', { name: /첫째 alpha/ }));
    expect(await screen.findByRole('dialog', { name: '상세1 alpha' })).toBeInTheDocument();
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: '닫기' }));
    await screen.findByRole('tab', { name: /둘/ });
    await user.click(screen.getByRole('tab', { name: /둘/ }));
    expect(screen.getByText('둘째 beta')).toBeInTheDocument();
    expect(screen.getByRole('row', { name: /둘째 beta/ })).toHaveAttribute('aria-disabled', 'true'); // 상세가 없는 탭의 행은 누를 수 없다
  });

  it('toolbar 를 함수로 주면 현재 탭과 필터 값을 받는다', async () => {
    const user = userEvent.setup();
    mount(
      props({ toolbar: ({ tab, filters }) => <span data-testid="ctx">{`${tab}|${filters.kind ?? ''}`}</span> }),
      '/x?kind=x'
    );
    expect(screen.getByTestId('ctx')).toHaveTextContent('issue|x');
    await user.click(screen.getByRole('tab', { name: /전체/ }));
    expect(screen.getByTestId('ctx')).toHaveTextContent('all|x');
  });

  it('카드의 이름과 설명은 위아래로 쌓여 붙어 보이지 않는다', () => {
    const { container } = mount(props({ cards: [{ n: 2, label: '지금도 실패 중인 문제', sub: '신규 0 · 열린 문제 전체 2' }] }));
    const text = container.querySelector('[data-card] [data-card-text]') as HTMLElement;
    // 이름과 설명이 한 줄에 이어 붙으면 영어에서 「Issues still failingNew 0」 처럼 읽혔다
    expect(getComputedStyle(text).flexDirection).toBe('column');
    expect(within(text).getByText('지금도 실패 중인 문제')).toBeInTheDocument();
    expect(within(text).getByText('신규 0 · 열린 문제 전체 2')).toBeInTheDocument();
  });

  it('자동 대조용 표식: 카드의 숫자·이름, 행의 제목, 탭의 개수', () => {
    const { container } = mount(props());
    const cards = [...container.querySelectorAll('[data-card]')].map((c) => [
      c.querySelector('[data-card-n]')?.textContent,
      c.querySelector('[data-card-label]')?.textContent,
    ]);
    expect(cards).toEqual([['7', '카드만']]);
    expect([...container.querySelectorAll('[data-row-title]')].map((e) => e.textContent)).toEqual(['alpha']);
    expect([...container.querySelectorAll('[role=tab]')].map((e) => e.getAttribute('data-count'))).toEqual([
      '1',
      '3',
      '0',
    ]);
  });

  it('탭의 개수는 받은편지함 종과 같은 배지(18px 원, 글자 10px 굵게)로 탭 글자의 오른쪽 위 모서리에 붙는다(OMAI-1224)', () => {
    const { container } = mount(props());
    for (const tab of container.querySelectorAll('[role=tab]')) {
      expect(tab.querySelector('.MuiChip-root')).toBeNull(); // 예전에는 글자 옆 알약(Chip)이었다
      const badge = tab.querySelector('.MuiBadge-badge');
      expect(badge).not.toBeNull();
      expect(badge).toHaveClass('MuiBadge-anchorOriginTopRight');
      expect(badge?.textContent).toBe(tab.getAttribute('data-count')); // 0 도 보인다(탭 줄에서 어느 탭이 비었는지 보이게)
      // 치수(18px·10px·700)는 jsdom 이 CSS 우선순위를 가리지 못해 여기서 잴 수 없다. 실제 브라우저(Playwright)로 확인했다
    }
  });

  it('열·행 식별자가 없는 탭은 오류로 알린다(두 줄 목록은 단계 7 에서 지웠다)', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(() => mount(props({ columns: undefined, rowId: undefined }))).toThrow(/columns.*rowId/);
    err.mockRestore();
  });

  it('error 가 있으면 알림으로 보인다', () => {
    mount(props({ error: '수집하지 못했습니다' }));
    expect(screen.getByRole('alert')).toHaveTextContent('수집하지 못했습니다');
  });

  it('검색창에는 / 단축키가 찾는 표식이 있다', () => {
    mount(props());
    expect(screen.getByRole('searchbox')).toHaveAttribute('data-view-search');
  });
});

// ── 표 모드(OMAI-1127, 계획 2026-10-13-015 §7-1 회귀 계약) ──
describe('ListView 표 모드', () => {
  const many = (n: number): Item[] => Array.from({ length: n }, (_, i) => ({ id: `i${i}`, name: `n${String(i).padStart(2, '0')}`, kind: i % 2 ? 'odd' : 'even' }));
  const tableProps = (items: Item[], over: Partial<ListViewProps<Item>> = {}): ListViewProps<Item> =>
    props({
      id: 'test',
      cards: [{ n: 9, label: '카드만' }],
      tabs: [
        { id: 'all', label: '전체', items },
        { id: 'none', label: '빈 탭', items: [], empty: '비어 있는 탭입니다.' },
      ],
      columns: [
        { id: 'name', label: '이름', value: (i) => i.name, hideable: false, render: (i) => <span data-row-title="">{i.name}</span> },
        { id: 'kind', label: '종류', value: (i) => i.kind },
      ],
      rowId: (i) => i.id,
      ...over,
    });
  const rows = (hidden = false) => screen.getAllByRole('row', { hidden }).slice(1);
  const range = () => document.querySelector('[data-grid-range]')?.textContent;

  it('툴바: 화면 도구와 검색창은 오른쪽 개수 앞에, 걸린 필터 칩은 왼쪽에 둔다', () => {
    mount(tableProps(many(3), { toolbar: <button type="button">새 작업</button>, filters: [{ key: 'kind', label: '종류', get: (i) => i.kind }] }), '/x?kind=odd');
    const bar = document.querySelector('[data-grid-toolbar]') as HTMLElement;
    const [start, end] = [...bar.children] as HTMLElement[];
    const tool = screen.getByRole('button', { name: '새 작업' });
    const search = screen.getByRole('searchbox');
    const count = bar.querySelector('[data-grid-count]') as HTMLElement;
    expect(start).toHaveTextContent('종류');
    expect(start).not.toContainElement(tool);
    for (const el of [tool, search, count]) expect(end).toContainElement(el);
    const order = [tool, search, count].map((el) => [...end.querySelectorAll('*')].indexOf(el));
    expect(order).toEqual([...order].sort((a, b) => a - b)); // 새 작업 → 검색 → 개수
  });

  it('행은 role row 이고 표식(data-row-title·data-view-search·data-card·data-count)을 단다(계약 5·8·11)', () => {
    const { container } = mount(tableProps(many(3)));
    expect(rows()).toHaveLength(3);
    expect([...container.querySelectorAll('[data-row-title]')].map((e) => e.textContent)).toEqual(['n00', 'n01', 'n02']);
    expect(screen.getByRole('searchbox')).toHaveAttribute('data-view-search');
    expect(container.querySelector('[data-card] [data-card-n]')).toHaveTextContent('9');
    expect(screen.getByRole('tab', { name: /전체/ })).toHaveAttribute('data-count', '3');
  });

  it('주소의 q·필터·sort 로 시작하고, 걸린 필터는 툴바 칩으로 보이며 × 로 지운다(계약 1, 검토 D12)', async () => {
    const user = userEvent.setup();
    mount(tableProps(many(6)), '/x?kind=odd&sort=name,desc');
    expect(rows().map((r) => r.textContent?.slice(0, 3))).toEqual(['n05', 'n03', 'n01']);
    expect(screen.getByText('6개 중 3개')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '종류 필터 지우기' }));
    expect(loc()).toBe('/x?sort=name%2Cdesc');
    expect(rows()).toHaveLength(6);
    expect(screen.getByText('6개')).toBeInTheDocument();
  });

  it('머리를 누르면 sort 를 주소에 담고 첫 페이지로 간다(계약 2)', async () => {
    const user = userEvent.setup();
    mount(tableProps(many(45)));
    await user.click(screen.getByRole('button', { name: '다음 페이지' }));
    expect(range()).toBe('21–40 / 45');
    await user.click(within(screen.getByRole('columnheader', { name: /이름/ })).getByRole('button'));
    expect(loc()).toBe('/x?sort=name%2Casc');
    expect(range()).toBe('1–20 / 45');
  });

  it('서랍을 열거나 자료를 다시 받아도 페이지와 열린 행 표시를 지킨다(계약 3·4)', async () => {
    const user = userEvent.setup();
    const items = many(45);
    const { rerender } = mount(tableProps(items), '/x');
    await user.click(screen.getByRole('button', { name: '다음 페이지' }));
    await user.click(within(rows()[0]).getByText('n20'));
    await screen.findByRole('dialog', { name: 'n20' });
    expect(range()).toBe('21–40 / 45');
    expect(rows(true)[0]).toHaveAttribute('aria-current', 'true'); // 서랍(모달)이 뒤를 aria-hidden 으로 가린다
    // 다시 받기: 같은 내용의 새 객체 배열
    rerender(
      <MemoryRouter initialEntries={['/x']}>
        <UiProvider>
          <ListView {...tableProps(items.map((i) => ({ ...i })))} />
          <DrawerHost />
          <Where />
        </UiProvider>
      </MemoryRouter>
    );
    expect(range()).toBe('21–40 / 45');
    expect(rows(true)[0]).toHaveAttribute('aria-current', 'true');
  });

  it('자료가 줄어 페이지가 범위를 벗어나면 마지막 페이지로(계약 10)', async () => {
    const user = userEvent.setup();
    const r = render(
      <MemoryRouter initialEntries={['/x']}>
        <UiProvider>
          <ListView {...tableProps(many(45))} />
        </UiProvider>
      </MemoryRouter>
    );
    await user.click(screen.getByRole('button', { name: '다음 페이지' }));
    await user.click(screen.getByRole('button', { name: '다음 페이지' }));
    expect(range()).toBe('41–45 / 45');
    r.rerender(
      <MemoryRouter initialEntries={['/x']}>
        <UiProvider>
          <ListView {...tableProps(many(30))} />
        </UiProvider>
      </MemoryRouter>
    );
    expect(range()).toBe('21–30 / 30');
  });

  it('행을 누르면 서랍, 「…」 메뉴는 행 누르기를 일으키지 않는다(계약 7)', async () => {
    const user = userEvent.setup();
    const acted: string[] = [];
    mount(tableProps(many(2), { actions: [{ id: 'x', label: '재개', onClick: (i) => acted.push(i.id) }] }));
    await user.click(screen.getByRole('button', { name: 'n01 동작' }));
    await user.click(screen.getByRole('menuitem', { name: '재개' }));
    expect(acted).toEqual(['i1']);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'n00 동작' }));
    await user.click(screen.getByRole('menuitem', { name: '상세 보기' }));
    expect(await screen.findByRole('dialog', { name: 'n00' })).toBeInTheDocument();
  });

  it('빈 탭은 탭 안내, 결과 없음은 안내와 「필터 지우기」(계약 6, 디자인 2B)', async () => {
    const user = userEvent.setup();
    mount(tableProps(many(3)), '/x?q=zzz');
    const empty = document.querySelector('[data-grid-empty]') as HTMLElement;
    expect(empty).toHaveTextContent('조건에 맞는 항목이 없습니다.');
    await user.click(within(empty).getByRole('button', { name: '필터 지우기' }));
    expect(loc()).toBe('/x');
    await user.click(screen.getByRole('tab', { name: /빈 탭/ }));
    expect(document.querySelector('[data-grid-empty]')).toHaveTextContent('비어 있는 탭입니다.');
  });

  it('거르기 배지는 현재 탭을 match 로 세고, 켜면 OR 로 거르며 chip 을 주소에 담는다. 탭을 바꾸면 지운다(검토 D11)', async () => {
    const user = userEvent.setup();
    mount(
      tableProps(many(6), {
        toggles: [
          { id: 'odd', label: '홀수', match: (i) => i.kind === 'odd' },
          { id: 'first', label: '첫째', match: (i) => i.id === 'i0' },
        ],
      })
    );
    const odd = screen.getByRole('button', { name: /홀수/ });
    expect(odd).toHaveTextContent('3');
    expect(odd).toHaveAttribute('aria-pressed', 'false');
    await user.click(odd);
    expect(loc()).toBe('/x?chip=odd');
    expect(rows()).toHaveLength(3);
    await user.click(screen.getByRole('button', { name: /첫째/ }));
    expect(rows()).toHaveLength(4);
    await user.click(screen.getByRole('tab', { name: /빈 탭/ }));
    expect(loc()).toBe('/x?tab=none');
  });

  it('탭이 toggles 를 덮어쓰면 그 탭에서는 그 배지만 보인다(설치 환경 탭, OMAI-1127 단계 5)', async () => {
    const user = userEvent.setup();
    const items = many(4);
    mount(
      tableProps(items, {
        tabs: [
          { id: 'all', label: '전체', items },
          { id: 'other', label: '다른 행', items, toggles: [] },
        ],
        toggles: [{ id: 'odd', label: '홀수', match: (i) => i.kind === 'odd' }],
      })
    );
    expect(screen.getByRole('button', { name: /홀수/ })).toBeInTheDocument();
    await user.click(screen.getByRole('tab', { name: /다른 행/ }));
    expect(screen.queryByRole('button', { name: /홀수/ })).not.toBeInTheDocument();
  });

  it('openId 의 행이 다른 페이지에 있으면 그 페이지로 간다(검토 D15)', () => {
    mount(tableProps(many(45), { openId: 'i42' }));
    expect(range()).toBe('41–45 / 45');
    expect(rows()[2]).toHaveAttribute('aria-current', 'true');
  });

  it('목록이 다시 받아져 값이 바뀌면 열린 서랍도 같은 행의 새 값으로 바뀐다(사용자 보고 2026-10-14, 스킬 허브 요청 기록)', async () => {
    const user = userEvent.setup();
    const first = [{ id: 'a', name: '대기 중', kind: 'x' }];
    const view = (items: Item[]) => (
      <MemoryRouter initialEntries={['/x']}>
        <UiProvider>
          <ListView {...props({ tabs: [{ id: 'all', label: '전체', items }] })} />
          <DrawerHost />
        </UiProvider>
      </MemoryRouter>
    );
    const { rerender } = render(view(first));
    await user.click(screen.getByRole('row', { name: /대기 중/ }));
    expect(await screen.findByText('상세 대기 중')).toBeInTheDocument();
    // 5초 뒤 목록 조회가 끝나 같은 행(id a)의 값이 완료로 바뀐다
    rerender(view([{ id: 'a', name: '완료', kind: 'x' }]));
    expect(await screen.findByText('상세 완료')).toBeInTheDocument();
    expect(screen.queryByText('상세 대기 중')).not.toBeInTheDocument();
  });

  it('열린 행이 목록에서 사라져도 서랍은 마지막 값으로 남고, 서랍 안의 입력은 목록이 갱신돼도 지켜진다', async () => {
    const user = userEvent.setup();
    const detail = (i: Item) => ({ title: i.name, body: <input aria-label="메모" /> });
    const view = (items: Item[]) => (
      <MemoryRouter initialEntries={['/x']}>
        <UiProvider>
          <ListView {...props({ detail, tabs: [{ id: 'all', label: '전체', items }] })} />
          <DrawerHost />
        </UiProvider>
      </MemoryRouter>
    );
    const { rerender } = render(view([{ id: 'a', name: '첫값', kind: 'x' }]));
    await user.click(screen.getByRole('row', { name: /첫값/ }));
    await user.type(await screen.findByRole('textbox', { name: '메모' }), '쓰는 중');
    rerender(view([{ id: 'a', name: '둘째값', kind: 'x' }]));
    expect(await screen.findByRole('heading', { name: '둘째값' })).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: '메모' })).toHaveValue('쓰는 중'); // 같은 서랍이라 다시 만들지 않는다
    rerender(view([]));
    expect(screen.getByRole('heading', { name: '둘째값' })).toBeInTheDocument();
  });

  it('부모 화면이 서랍 상태를 구독해 매번 새 배열을 만들어도 서랍 갱신이 고리를 만들지 않는다', async () => {
    const user = userEvent.setup();
    let renders = 0;
    function Parent({ name }: { name: string }) {
      useUi(); // 서랍이 바뀔 때마다 이 화면도 다시 그려진다
      renders += 1;
      // 값은 같지만 매번 새 객체
      const items = [{ id: 'a', name, kind: 'x' }].map((i) => ({ ...i }));
      return <ListView {...props({ tabs: [{ id: 'all', label: '전체', items }] })} />;
    }
    const view = (name: string) => (
      <MemoryRouter initialEntries={['/x']}>
        <UiProvider>
          <Parent name={name} />
          <DrawerHost />
        </UiProvider>
      </MemoryRouter>
    );
    const { rerender } = render(view('옛 이름'));
    await user.click(screen.getByRole('row', { name: /옛 이름/ }));
    expect(await screen.findByText('상세 옛 이름')).toBeInTheDocument();
    const before = renders;
    rerender(view('새 이름'));
    expect(await screen.findByText('상세 새 이름')).toBeInTheDocument();
    expect(renders - before).toBeLessThan(10); // 갱신 한 번에 몇 번 더 그리는 정도이고, 끝없이 되풀이하지 않는다
  });
  it('행은 그대로여도 detailKey(행 밖 자료)가 바뀌면 열린 서랍을 새로 만들고, 둘 다 같으면 건드리지 않는다', async () => {
    const user = userEvent.setup();
    const items = [{ id: 'a', name: '행', kind: 'x' }];
    let builds = 0;
    const view = (outside: string) => (
      <MemoryRouter initialEntries={['/x']}>
        <UiProvider>
          <ListView
            {...props({
              tabs: [{ id: 'all', label: '전체', items }],
              detail: (i) => {
                builds += 1;
                return { title: i.name, body: <div>{`바깥 ${outside}`}</div> };
              },
              detailKey: outside,
            })}
          />
          <DrawerHost />
        </UiProvider>
      </MemoryRouter>
    );
    const { rerender } = render(view('옛값'));
    await user.click(screen.getByRole('row', { name: /행/ }));
    expect(await screen.findByText('바깥 옛값')).toBeInTheDocument();
    rerender(view('옛값'));
    const same = builds;
    rerender(view('새값'));
    expect(await screen.findByText('바깥 새값')).toBeInTheDocument();
    expect(builds).toBe(same + 1);
  });
  it('rowId 가 탭에만 있는 화면(스킬 허브·활동)에서도 열린 서랍이 행을 따라간다', async () => {
    const user = userEvent.setup();
    const view = (name: string) => (
      <MemoryRouter initialEntries={['/x']}>
        <UiProvider>
          <ListView
            {...props({
              rowId: undefined,
              columns: undefined,
              tabs: [{ id: 'all', label: '전체', items: [{ id: 'a', name, kind: 'x' }], rowId: (i) => `탭/${i.id}`, columns: props().columns }],
            })}
          />
          <DrawerHost />
        </UiProvider>
      </MemoryRouter>
    );
    const { rerender } = render(view('옛이름'));
    await user.click(screen.getByRole('row', { name: /옛이름/ }));
    expect(await screen.findByText('상세 옛이름')).toBeInTheDocument();
    rerender(view('새이름'));
    expect(await screen.findByText('상세 새이름')).toBeInTheDocument();
  });
});

// 카드 모드(2026-10-17-011): 모든 탭에 card 가 있으면 탭 줄 대신 보기 카드 줄을 그린다
describe('ListView 카드 모드', () => {
  const cardProps = (over: Partial<ListViewProps<Item>> = {}) =>
    props({
      cards: [{ n: 7, label: '카드만' }],
      tabs: [
        { id: 'all', label: '전체', items: ITEMS, card: { sub: '설명 줄' } },
        { id: 'issue', label: '확인할 것', tone: 'bad', items: ITEMS.slice(0, 1), card: {}, banner: { severity: 'info', message: '탭 띠' } },
        { id: 'loading', label: '불러오는 중', items: [], count: null, card: {} },
      ],
      toggles: [{ id: 'x', label: 'x 종류', match: (i) => i.kind === 'x' }],
      ...over,
    });

  it('탭 줄 대신 보기 카드 줄 하나만 그리고, 카드의 접근 이름은 「라벨, 숫자」다', () => {
    mount(cardProps());
    const lists = screen.getAllByRole('tablist');
    expect(lists).toHaveLength(1);
    expect(lists[0]).toHaveAttribute('aria-label', '시험 화면');
    const all = within(lists[0]).getByRole('tab', { name: '전체, 3' });
    expect(all).toHaveAttribute('aria-selected', 'true');
    expect(all).toHaveAccessibleDescription('설명 줄');
    expect(within(lists[0]).getByRole('tab', { name: '확인할 것, 1' })).toHaveAttribute('aria-selected', 'false');
    // 불러오는 중(count: null)은 0 대신 「—」
    expect(within(lists[0]).getByRole('tab', { name: '불러오는 중, —' })).toHaveTextContent('—');
  });

  it('카드를 누르면 그 보기로 가고(?tab=), 켜 둔 거르기 배지는 꺼진다', async () => {
    const user = userEvent.setup();
    mount(cardProps(), '/x?chip=x');
    await user.click(screen.getByRole('tab', { name: '확인할 것, 1' }));
    expect(loc()).toBe('/x?tab=issue');
    expect(screen.getByRole('tab', { name: '확인할 것, 1' })).toHaveAttribute('aria-selected', 'true');
  });

  it('화살표 키는 포커스만 옮기고 보기는 Enter 로 바꾼다(수동 활성화)', async () => {
    const user = userEvent.setup();
    mount(cardProps());
    await user.click(screen.getByRole('tab', { name: '전체, 3' }));
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('tab', { name: '확인할 것, 1' })).toHaveFocus();
    expect(loc()).toBe('/x');
    await user.keyboard('{Enter}');
    expect(loc()).toBe('/x?tab=issue');
  });

  it('순서는 보기 카드, 거르기 배지, 숫자만 카드이고 배지·숫자만 카드는 탭 목록 밖이다', () => {
    mount(cardProps());
    const cards = [...document.querySelectorAll('[data-card]')];
    expect(cards.map((c) => (c.hasAttribute('data-view-card') ? 'view' : c.hasAttribute('data-toggle') ? 'toggle' : 'kpi'))).toEqual([
      'view',
      'view',
      'view',
      'toggle',
      'kpi',
    ]);
    const list = screen.getByRole('tablist');
    expect(within(list).queryByRole('button', { name: /x 종류/ })).toBeNull();
    expect(screen.getByRole('button', { name: /x 종류/ })).toHaveAttribute('aria-pressed', 'false');
  });

  it('보기 카드의 숫자는 count ?? items.length 이고 data-count 로도 단다', () => {
    mount(cardProps());
    const view = [...document.querySelectorAll('[data-view-card]')];
    expect(view.map((c) => c.getAttribute('data-count'))).toEqual(['3', '1', '']);
  });

  it('탭 전용 띠는 카드 줄 아래에 그려 카드를 눌러도 카드가 밀리지 않는다', async () => {
    const user = userEvent.setup();
    mount(cardProps());
    await user.click(screen.getByRole('tab', { name: '확인할 것, 1' }));
    const band = document.querySelector('[data-tab-banner]') as Element;
    const row = document.querySelector('[data-view-cards]') as Element;
    expect(band).toHaveTextContent('탭 띠');
    expect(row.compareDocumentPosition(band) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('일부 탭에만 card 가 있으면 탭 줄로 그리고 개발 빌드에서 한 번 알린다', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mount(
      props({
        title: '일부 카드',
        tabs: [
          { id: 'all', label: '전체', items: ITEMS, card: {} },
          { id: 'issue', label: '확인할 것', items: [] },
        ],
      })
    );
    expect(document.querySelector('[data-view-cards]')).toBeNull();
    expect(within(screen.getByRole('tablist')).getByRole('tab', { name: /확인할 것/ })).toBeInTheDocument();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('issue'));
    warn.mockRestore();
  });
  // 표 툴바 오른쪽 끝의 「+ 새 …」 단추(스펙 2026-10-21-020)
  it('gridAction 은 표 툴바의 맨 끝(새로고침 뒤)에 글자 단추로 놓이고, 누르면 동작을 부른다', async () => {
    const onClick = vi.fn();
    mount(props({ onRefresh: () => {}, gridAction: { label: '새 항목', onClick } }));
    const bar = document.querySelector('[data-grid-toolbar]') as HTMLElement;
    const btn = within(bar).getByRole('button', { name: '새 항목' });
    const buttons = within(bar).getAllByRole('button');
    expect(buttons[buttons.length - 1]).toBe(btn);
    expect(buttons.indexOf(within(bar).getByRole('button', { name: '새로 고침' }))).toBeLessThan(buttons.indexOf(btn));
    await userEvent.click(btn);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('gridAction 이 비활성이면 이유를 보조 기술에 주고, 탭마다 다른 동작을 줄 수 있다', () => {
    mount(
      props({
        gridAction: ({ tab }) => (tab === 'all' ? { label: '새 항목', onClick: () => {}, disabled: true, disabledReason: '한도에 닿았습니다' } : null),
      }),
      '/x?tab=all'
    );
    const btn = screen.getByRole('button', { name: '새 항목' });
    expect(btn).toBeDisabled();
    expect(btn).toHaveAccessibleDescription('한도에 닿았습니다');
  });

  it('gridAction 이 없으면 툴바에 글자 단추를 그리지 않는다', () => {
    mount(props());
    expect(screen.queryByRole('button', { name: '새 항목' })).not.toBeInTheDocument();
  });
});

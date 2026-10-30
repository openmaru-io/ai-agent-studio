/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 목록 화면의 공통 틀: 카드 → 탭 → 공통 표(DataGrid) → 상세 서랍.
// 탭·검색어·필터는 주소(?tab=&q=&종류=)에 담아 새로 고침과 링크 공유에서도 그대로 남긴다.
// ListView 가 거르기·정렬·페이지 자르기의 주인이고(OMAI-1127 검토 D5, 재검토 D2), 정렬(sort=)·켠 배지(chip=)도 주소에 담는다.
// 예전의 두 줄 목록(row)은 모든 화면을 표로 옮긴 뒤 지웠다(단계 7).
import CheckIcon from '@mui/icons-material/Check';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import { Alert, Box, Button, Divider, NativeSelect, Stack, Tab, Tabs, Typography, useMediaQuery, useTheme } from '@mui/material';
import { ReactNode, useEffect, useId, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';

import { t } from '@/i18n';
import { FOCUS_RING, gridTokens, tabTokens } from '@/lib/shellTokens';

import { AddAction, AddButton } from './AddIconButton';
import {
  clampPage,
  DataGrid,
  FilterChip,
  formatSort,
  GridAction,
  GridColumn,
  GridSearch,
  GridSelect,
  loadRowsPerPage,
  parseSort,
  saveRowsPerPage,
  sortRows,
} from './DataGrid';
import { PageTitle } from './PageTitle';
import { TabCountBadge } from './TabCountBadge';
import { DrawerSpec, useUi } from './UiContext';

export type Tone = 'bad' | 'warn' | 'good';

const toneColor = (tone?: Tone) =>
  tone === 'bad' ? 'error' : tone === 'warn' ? 'warning' : tone === 'good' ? 'success' : 'default';

/** 숫자만 보이는 카드(KPI). 보기를 고르는 카드는 탭의 card 로 만든다(보기 카드, 2026-10-17-011).
 *  onClick 이 있으면 버튼으로 그린다(서랍을 여는 숫자 카드, 스펙 2026-10-30-003 R8). ariaLabel 은 그 버튼의 접근 이름 */
export interface ListCard {
  n: number | string;
  label: string;
  sub?: string;
  tone?: Tone;
  onClick?: () => void;
  ariaLabel?: string;
}

/** 표 모드에서 현재 탭 안을 거르는 배지(검토 D11). match 가 있으면 누를 때마다 켜고 끈다(OR, 주소 chip=).
 *  숫자는 현재 탭 항목을 match 로 센 값이다. */
export interface ListToggleCard<T> extends Omit<ListCard, 'tab' | 'n'> {
  id: string;
  match: (item: T) => boolean;
}

export interface ListTab<T> {
  id: string;
  label: string;
  tone?: Tone;
  items: T[];
  /** 이 탭에 항목이 하나도 없을 때의 안내 */
  empty?: ReactNode;
  /** 항목은 있는데 검색·배지·거르기로 0 줄일 때 「맞는 항목이 없습니다」 대신 보일 안내(스킬 화면의 다른 프로파일 안내, 스펙 2026-10-27-013 디자인 5A) */
  noMatch?: ReactNode;
  onRow?: (item: T) => void;
  /** 이 탭만의 상세. 없으면 화면 전체의 detail 을 쓴다. null 이면 서랍을 열지 않는다. */
  detail?: (item: T) => DrawerSpec | null;
  /** 이 탭만의 표 열·행 식별자. 없으면 화면 전체의 columns·rowId 를 쓴다(검토 D6) */
  columns?: GridColumn<T>[];
  rowId?: (item: T) => string;
  /** 이 탭만의 거르기 배지. 행 종류가 다른 탭(설치 환경 등)은 [] 로 화면 배지를 끈다 */
  toggles?: ListToggleCard<T>[];
  /** 있으면 이 탭은 표 대신 이 내용을 그린다(부서 탭, 스펙 2026-10-15-026). columns·rowId 가 없어도 된다. 검색창·거르기는 그리지 않는다 */
  content?: ReactNode;
  /** 탭 개수 배지의 숫자. 없으면 items.length. null 이면 불러오는 중이라 보기 카드에 「—」를 그린다(2026-10-17-011 원칙 8) */
  count?: number | null;
  /** 있으면 이 탭을 보기 카드로 그린다. 모든 탭에 있으면 탭 줄 대신 보기 카드 줄을 그린다(카드 모드, 2026-10-17-011).
   *  sub 는 카드의 둘째 줄(지표), 색은 tone 을 쓴다 */
  card?: { sub?: string };
  /** 이 탭이 열렸을 때만 목록 위에 보이는 안내 띠(화면 전체 banner 와 따로, OMAI-1249) */
  banner?: ListBanner | null;
  /** 이 탭의 탭 줄 바로 아래, 표 바로 위에 두는 것(스킬 허브의 태그 칩 줄, OMAI-1275) */
  above?: ReactNode;
  /** 이 탭만의 행 메뉴. 있으면 화면 전체의 actions 대신 쓴다 */
  actions?: GridAction<T>[];
  /** 줄 고르기 열(스펙 2026-10-24-003 D16) */
  select?: GridSelect<T>;
}

/** 목록 위 안내 띠. error(늘 빨강)와 달리 경보가 아닌 안내에 쓴다: 설정 없음은 info(파랑), 연결 실패·권한 없음은 warning(호박색).
 *  빨강은 쓰지 않는다(DESIGN §1-1.1, 2026-10-14-011 V5) */
export interface ListBanner {
  severity: 'info' | 'warning';
  message: ReactNode;
  /** 띠 오른쪽 끝의 단추·링크 */
  action?: ReactNode;
  /** false 면 띠를 live 영역(role=status)으로 두지 않는다. 자주 바뀌는 진행 띠가 갱신마다 통째로 읽히지 않게 하고,
   *  알릴 사건은 화면이 따로 둔 숨은 영역이 말한다(롤아웃 띠, 스펙 2026-10-28-015 DD16) */
  live?: boolean;
}

export interface ListFilter<T> {
  key: string;
  label: string;
  get: (item: T) => string | undefined | null;
}

export interface ListViewProps<T> {
  title: string;
  sub?: ReactNode;
  error?: string | null;
  banner?: ListBanner | null;
  cards?: ListCard[];
  tabs: ListTab<T>[];
  filters?: ListFilter<T>[];
  /** 검색이 훑는 글. 없으면 검색창을 보이지 않는다. */
  text?: (item: T) => string;
  /** 툴바 오른쪽, 검색창 앞에 둘 도구(새 작업·기간 선택 등) */
  toolbar?: ReactNode | ((ctx: { tab: string; filters: Record<string, string> }) => ReactNode);
  /** 목록 아래에 붙이는 한 줄 안내 */
  note?: string;
  /** 화면 제목 줄 오른쪽에 둘 주 동작(새 작업 등) */
  headerAction?: ReactNode;
  /** 가이드(따라하기)가 표 전체를 강조할 때 쓰는 data-guide 값 */
  guide?: string;
  /** 제목 바로 옆(같은 줄)에 둘 「새 항목 추가」 아이콘(AddIconButton) */
  titleAction?: ReactNode | ((ctx: { tab: string }) => ReactNode);
  /** 표 툴바 오른쪽 끝에 둘 「+ 새 …」 단추. 보통 titleAction 과 같은 동작을 준다 */
  gridAction?: AddAction | null | ((ctx: { tab: string }) => AddAction | null | undefined);
  /** 행을 눌렀을 때 서랍에 보일 내용. onRow 가 있으면 onRow 가 먼저다. */
  /** null 을 돌려주면 서랍을 열지 않는다(열 수 없는 행을 안내만 할 때) */
  detail?: (item: T) => DrawerSpec | null;
  onRow?: (item: T) => void;
  // ── 공통 표(OMAI-1127) ──
  /** 열 숨김 저장 키 앞부분(aas.grid.<id>.<탭>) */
  id?: string;
  /** 표의 열·행 식별자. 탭이 덮어쓸 수 있다. 화면이나 탭 어느 한쪽에는 꼭 있어야 한다 */
  columns?: GridColumn<T>[];
  rowId?: (item: T) => string;
  /** 거르기 배지 */
  toggles?: ListToggleCard<T>[];
  /** 행 「…」 메뉴. 「상세 보기」는 ListView 가 앞에 붙인다(검토 D17: 확인 창이 필요 없는 동작만) */
  actions?: GridAction<T>[];
  /** `detail(item)` 가 행 밖의 자료(한도·제공자 상태 등)를 읽으면 그 값을 여기 준다. 바뀌면 열린 서랍도 새로 만든다. */
  detailKey?: unknown;
  onRefresh?: () => void;
  isFetching?: boolean;
  /** 주소 ?open= 으로 연 항목의 식별자. 그 행이 있는 페이지로 간다(검토 D15) */
  openId?: string | null;
  /** 탭을 바꿀 때 함께 지울 주소 값. 목록 서랍의 open·pod 는 탭마다 id 공간이 달라 지운다(useRoutePage, 스펙 2026-10-28-014 D12) */
  clearOnTab?: string[];
  /** 행 메뉴 단추의 읽기 이름. 없으면 첫 열 값(같은 이름 행이 여럿인 목록은 구분되는 이름을 준다, 스펙 2026-10-19-018 디자인 DD11) */
  rowName?: (item: T) => string;
  /** 행의 보조 설명(aria-description) */
  rowDescription?: (item: T) => string | undefined;
  /** 행마다 다른 「상세 보기」 항목 이름 */
  openLabel?: (item: T) => string;
}

/** 행 값이 바뀌었는지 보는 지문. 순환 구조 같아 직렬화할 수 없으면 null(그때는 같은 객체인지로만 가른다). */
function fingerprint(x: unknown): string | null {
  try {
    return JSON.stringify(x) ?? null;
  } catch {
    return null;
  }
}

export function ListView<T>(props: ListViewProps<T>) {
  const { title, sub, error, banner, cards, tabs, filters = [], text, toolbar, note } = props;
  const [params, setParams] = useSearchParams();
  const { drawer, drawers, openDrawer, updateDrawer } = useUi();
  // 선택 표시는 행 객체가 아니라 식별자로 기억한다 — 목록이 다시 받아지면 행 객체가 새로 만들어지고, 식별자 함수도 새로 만들어질 수 있다
  const [selected, setSelected] = useState<string | null>(null);
  // 행을 눌러 연 서랍. 목록이 다시 받아져 그 행의 값이 바뀌면 서랍도 새 값으로 다시 만든다(사용자 보고 2026-10-14)
  const track = useRef<{ key: number; rid: string; tabId: string; last: T; lastKey: unknown; lastFp: string | null } | null>(null);
  const [page, setPage] = useState(0);
  const [rowsPerPage, setRowsPerPage] = useState(loadRowsPerPage);

  const tab = tabs.find((t) => t.id === params.get('tab')) ?? tabs[0];
  const q = params.get('q') ?? '';
  const columns = tab?.columns ?? props.columns;
  const rowId = tab?.rowId ?? props.rowId;
  if (tab && !tab.content && (!columns || !rowId))
    throw new Error(`ListView(${props.title}): tab ${tab.id} has no columns/rowId`);
  const sort = parseSort(params.get('sort'));
  const chips = (params.get('chip') ?? '').split(',').filter(Boolean);
  const toggles = tab?.toggles ?? props.toggles ?? [];
  const activeToggles = toggles.filter((c) => chips.includes(c.id));

  const patch = (changes: Record<string, string | null>) =>
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        for (const [k, v] of Object.entries(changes)) {
          if (v) next.set(k, v);
          else next.delete(k);
        }
        return next;
      },
      { replace: true }
    );

  const active = filters.map((f) => [f.key, params.get(f.key) ?? ''] as const);
  const activeKey = JSON.stringify([tab?.id, q, active, params.get('sort'), params.get('chip')]);
  // 거르기·탭·정렬·배지가 바뀌면 처음으로. 그 밖(서랍 열기·다시 받기)에는 페이지를 지킨다(검토 D9)
  useEffect(() => {
    setPage(0);
  }, [activeKey]);

  const options = useMemo(
    () =>
      filters.map((f) => {
        const seen = new Set<string>();
        for (const item of tab?.items ?? []) {
          const v = f.get(item);
          if (v) seen.add(v);
        }
        return [...seen].sort();
      }),
    [filters, tab]
  );

  const visible = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const filtered = (tab?.items ?? []).filter((item) => {
      if (activeToggles.length && !activeToggles.some((c) => c.match(item))) return false;
      if (needle && text && !text(item).toLowerCase().includes(needle)) return false;
      return filters.every((f) => {
        const want = params.get(f.key);
        return !want || f.get(item) === want;
      });
    });
    return columns ? sortRows(filtered, columns, sort) : filtered;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, q, text, filters, params, columns]);

  // 자료가 줄어 지금 페이지가 범위를 벗어나면 마지막 페이지로(회귀 계약 10)
  const pageNow = clampPage(page, visible.length, rowsPerPage);
  useEffect(() => {
    if (pageNow !== page) setPage(pageNow);
  }, [pageNow, page]);

  // ?open= 으로 연 행이 다른 페이지에 있으면 그 페이지로(검토 D15)
  const openId = props.openId ?? null;
  useEffect(() => {
    if (!openId || !rowId) return;
    const at = visible.findIndex((x) => rowId(x) === openId);
    if (at >= 0) setPage(Math.floor(at / rowsPerPage));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openId, rowsPerPage]);

  // 목록(tabs)이 바뀌면 열린 행을 다시 찾아 서랍을 그 값으로 바꾼다. 값이 같으면 건드리지 않아 서랍·화면이 서로를 다시 그리는 고리가 생기지 않는다.
  // 행이 목록에서 사라지면 서랍은 마지막 값으로 남는다. 서랍이 닫혔으면 따라가기를 멈춘다.
  useEffect(() => {
    const cur = track.current;
    if (!cur) return;
    if (!drawers.some((d) => d._k === cur.key)) {
      track.current = null;
      return;
    }
    // 행 식별자는 탭마다 다를 수 있고, 화면이 매번 새로 만든다(받은 목록으로 만든 표를 읽는 경우). 그래서 지금 값으로 찾는다.
    // 연 탭에서 먼저 찾고, 같은 식별자를 쓰는 다른 탭에서도 찾는다
    const opened = tabs.find((x) => x.id === cur.tabId);
    const idOf = opened?.rowId ?? props.rowId;
    if (!idOf) return;
    const pool = [opened, ...tabs.filter((x) => x.id !== cur.tabId && (x.rowId ?? props.rowId) === idOf)].filter((x): x is ListTab<T> => !!x);
    const fresh = pool.flatMap((x) => x.items).find((x) => idOf(x) === cur.rid);
    if (!fresh) return;
    // 행 값과 행 밖 자료(detailKey) 둘 다 같으면 건드리지 않는다
    const fp = fingerprint([fresh, props.detailKey]);
    if (fp !== null ? fp === cur.lastFp : fresh === cur.last && props.detailKey === cur.lastKey) return;
    const build = (tabs.find((x) => x.id === cur.tabId) ?? tab)?.detail ?? props.detail;
    if (!build) return;
    cur.last = fresh;
    cur.lastKey = props.detailKey;
    cur.lastFp = fp;
    const next = build(fresh);
    if (!next) return;
    updateDrawer(cur.key, { title: next.title, sub: next.sub, body: next.body });
  }, [tabs, drawers, updateDrawer, props.detailKey]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!tab) return null;
  // 내용(content) 탭은 표를 그리지 않아 columns·rowId 가 없을 수 있다. 아래 표 코드는 이 값으로 읽는다
  const gridColumns = columns ?? [];
  const gridRowId = rowId ?? ((): string => '');
  const anyFilter = active.some(([, v]) => v);
  const handler = tab.onRow ?? props.onRow;
  const detail = tab.detail ?? props.detail;

  const open = (item: T) => {
    if (handler) return handler(item);
    if (!detail) return;
    const spec = detail(item);
    if (!spec) return;
    setSelected(gridRowId(item));
    track.current = { key: openDrawer(spec), rid: gridRowId(item), tabId: tab.id, last: item, lastKey: props.detailKey, lastFp: fingerprint([item, props.detailKey]) };
  };
  const clickable = !!(handler || detail);
  const anyNarrow = anyFilter || !!q.trim() || activeToggles.length > 0;
  const clearAll = () => patch({ ...Object.fromEntries(filters.map((f) => [f.key, null])), q: null, chip: null });
  const toggleChip = (id: string) => {
    const next = chips.includes(id) ? chips.filter((x) => x !== id) : [...chips, id];
    patch({ chip: next.length ? next.join(',') : null });
  };
  const changeTab = (id: string) =>
    patch({ tab: id === tabs[0].id ? null : id, chip: null, ...Object.fromEntries((props.clearOnTab ?? []).map((k) => [k, null])) });

  // 카드 모드(2026-10-17-011): 모든 탭에 card 가 있으면 탭 줄 대신 보기 카드 줄을 그린다. 일부만 있으면 탭 줄 그대로다
  const cardMode = tabs.every((x) => !!x.card);
  if (import.meta.env.DEV && !cardMode && tabs.some((x) => !!x.card)) warnPartialCards(title, tabs);
  const tabBanner = tab.banner ? (
    <Alert severity={tab.banner.severity} action={tab.banner.action} role={tab.banner.live === false ? 'none' : 'status'} sx={{ mb: 2 }} data-banner={tab.banner.severity} data-tab-banner="">
      {tab.banner.message}
    </Alert>
  ) : null;
  // 숫자만 보이는 카드(KPI): 테두리 없음, 누를 수 없음(§4-9 1A). 카드 모드에서는 보기 카드·거르기 배지 뒤에 둔다(2026-10-17-011 원칙 4)
  const kpiCard = (c: ListCard) =>
    c.onClick ? (
      <Button
        key={c.label}
        data-card=""
        data-kpi=""
        variant="text"
        color="inherit"
        onClick={c.onClick}
        aria-label={c.ariaLabel}
        sx={{ px: 2, py: 1, display: 'flex', alignItems: 'center', textTransform: 'none', borderRadius: '6px', '&.Mui-focusVisible': { outline: `2px solid ${FOCUS_RING}`, outlineOffset: 2 } }}
      >
        <CardBody n={c.n} label={c.label} sub={c.sub} tone={c.tone} />
        <ChevronRightIcon sx={{ fontSize: 10, color: 'text.secondary', ml: 1 }} />
      </Button>
    ) : (
      <Box key={c.label} data-card="" data-kpi="" sx={{ px: 2, py: 1, display: 'flex', alignItems: 'center' }}>
        <CardBody n={c.n} label={c.label} sub={c.sub} tone={c.tone} />
      </Box>
    );
  const toggleButtons = toggles.map((c) => {
    const on = chips.includes(c.id);
    const n = tab.items.filter(c.match).length;
    return (
      // 거르기 배지: 켜면 단색 wash + 테두리 + 체크(§4-9 1A, 검토 D11). 고른 보기 카드(아래 선만)와 모양이 다르다
      <Button
        key={c.id}
        data-card=""
        data-toggle=""
        variant="outlined"
        color="inherit"
        aria-pressed={on}
        onClick={() => toggleChip(c.id)}
        startIcon={on ? <CheckIcon sx={{ fontSize: '12px !important' }} /> : undefined}
        sx={(th) => {
          const tk = gridTokens[th.palette.mode];
          return {
            textTransform: 'none',
            borderRadius: '8px',
            borderColor: on ? tk.selectedAccent : tk.toggleLine,
            bgcolor: on ? tk.selected : 'transparent',
          };
        }}
      >
        <CardBody n={n} label={c.label} sub={c.sub} tone={c.tone} dimZero />
      </Button>
    );
  });
  const kpiCards = cardMode ? (cards ?? []).map(kpiCard) : [];
  const afterCards = toggleButtons.length + kpiCards.length > 0 ? [...toggleButtons, ...kpiCards] : null;

  const titleAction = typeof props.titleAction === 'function' ? props.titleAction({ tab: tab.id }) : props.titleAction;
  // 추가 단추는 제목 옆, 도움말 단추 앞에 둔다(PageTitle 의 action, OMAI-1274 디자인 리뷰 12A)
  const heading = <PageTitle action={titleAction}>{title}</PageTitle>;
  const gridAction = typeof props.gridAction === 'function' ? props.gridAction({ tab: tab.id }) : props.gridAction;

  return (
    <Box>
      {props.headerAction ? (
        <Stack direction="row" alignItems="center" justifyContent="space-between" spacing={2}>
          {heading}
          {props.headerAction}
        </Stack>
      ) : (
        heading
      )}
      {sub && (
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          {sub}
        </Typography>
      )}
      {error && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {error}
        </Alert>
      )}
      {banner && (
        <Alert severity={banner.severity} action={banner.action} role={banner.live === false ? 'none' : 'status'} sx={{ mb: 2 }} data-banner={banner.severity}>
          {banner.message}
        </Alert>
      )}
      {cardMode ? (
        // 카드 모드: 보기 카드 줄이 탭 줄을 대신한다. 탭 전용 띠는 카드 줄 아래에 그려 카드를 눌러도 카드가 밀리지 않는다(2026-10-17-011 §5-2)
        <>
          <ViewCards title={title} tabs={tabs} value={tab.id} onChange={changeTab} after={afterCards} />
          {tabBanner && <Box sx={{ mt: 1.5 }}>{tabBanner}</Box>}
        </>
      ) : (
        <>
          {tabBanner}
          {((cards && cards.length > 0) || toggles.length > 0) && (
            <Stack direction="row" spacing={1.5} useFlexGap flexWrap="wrap" sx={{ mb: 2 }}>
              {(cards ?? []).map(kpiCard)}
              {toggleButtons}
            </Stack>
          )}
          <Tabs
            value={tab.id}
            onChange={(_, id: string) => changeTab(id)}
            aria-label={title}
            // 탭이 넘칠 때만 좌우 스크롤 버튼이 나타난다. 넘치지 않으면 지금과 같다(디자인 리뷰 6B, 스펙 2026-10-15-026)
            variant="scrollable"
            scrollButtons="auto"
            allowScrollButtonsMobile
            sx={(th) => ({ borderBottom: `1px solid ${tabTokens[th.palette.mode].line}` })}
          >
            {tabs.map((t) => (
              <Tab
                key={t.id}
                value={t.id}
                data-count={t.count ?? t.items.length}
                label={
                  <TabCountBadge count={t.count ?? t.items.length} tone={t.tone}>
                    {t.label}
                  </TabCountBadge>
                }
                sx={{ textTransform: 'none' }}
              />
            ))}
          </Tabs>
        </>
      )}
      {tab?.above}

      <Box sx={{ mt: 1.5 }} data-guide={props.guide}>
        {tab.content ?? (
        <DataGrid<T>
          storageKey={`${props.id ?? title}.${tab.id}`}
          label={title}
          columns={gridColumns}
          rows={visible.slice(pageNow * rowsPerPage, (pageNow + 1) * rowsPerPage)}
          rowId={gridRowId}
          rowName={props.rowName ?? ((x) => String(gridColumns[0]?.value(x) ?? ''))}
          rowDescription={props.rowDescription}
          total={visible.length}
          page={pageNow}
          rowsPerPage={rowsPerPage}
          onPage={setPage}
          onRowsPerPage={(n) => {
            saveRowsPerPage(n);
            setRowsPerPage(n);
            setPage(0);
          }}
          sort={sort}
          onSort={(s) => patch({ sort: formatSort(s) })}
          onRow={clickable ? open : undefined}
          selectedId={(drawer && selected ? selected : null) ?? openId}
          actions={[
            ...(clickable ? [{ id: 'open', label: t('common.grid.openDetail'), labelFor: props.openLabel, onClick: open }] : []),
            ...(tab.actions ?? props.actions ?? []),
          ]}
          select={tab.select}
          onRefresh={props.onRefresh}
          refreshing={props.isFetching}
          toolbarAction={gridAction ? <AddButton {...gridAction} /> : undefined}
          count={
            anyNarrow
              ? t('common.grid.shownOf', { total: tab.items.length, shown: visible.length })
              : t('common.grid.count', { total: visible.length })
          }
          filtersActive={anyFilter}
          filterRow={
            filters.some((_, i) => options[i].length > 1) ? (
              <>
                {/* 같은 id 의 열이 있는 필터를 먼저, 맞는 열이 없는 필터는 줄 끝에(재검토 D6) */}
                {[...filters]
                  .map((f, i) => ({ f, i }))
                  .sort(
                    (a, b) =>
                      Number(!gridColumns.some((c) => c.id === a.f.key)) - Number(!gridColumns.some((c) => c.id === b.f.key))
                  )
                  .map(({ f, i }) =>
                    options[i].length > 1 ? (
                      <NativeSelect
                        key={f.key}
                        value={params.get(f.key) ?? ''}
                        onChange={(e) => patch({ [f.key]: e.target.value })}
                        inputProps={{ 'aria-label': f.label }}
                        sx={{ fontSize: 12.5 }}
                      >
                        <option value="">{t('common.filterAll', { label: f.label })}</option>
                        {options[i].map((v) => (
                          <option key={v} value={v}>
                            {v}
                          </option>
                        ))}
                      </NativeSelect>
                    ) : null
                  )}
              </>
            ) : undefined
          }
          // 걸린 필터 칩은 왼쪽, 화면 도구(새 작업·기간 등)와 검색창은 오른쪽 개수 앞
          toolbarEnd={
            <>
              {typeof toolbar === 'function' ? toolbar({ tab: tab.id, filters: Object.fromEntries(active) }) : toolbar}
              {text && <GridSearch value={q} onChange={(v) => patch({ q: v })} />}
            </>
          }
          toolbarStart={
            <>
              {filters.map((f) => {
                const v = params.get(f.key);
                return v ? (
                  <FilterChip key={f.key} label={f.label} value={v} onClear={() => patch({ [f.key]: null })} />
                ) : null;
              })}
              {anyFilter && (
                <Button
                  size="small"
                  color="inherit"
                  onClick={() => patch(Object.fromEntries(filters.map((f) => [f.key, null])))}
                  sx={{ color: 'text.secondary', '&:hover': { color: 'text.primary' } }}
                >
                  {t('common.clearFilters')}
                </Button>
              )}
            </>
          }
          empty={
            tab.items.length === 0 ? (
              tab.empty ?? t('common.empty')
            ) : (
              tab.noMatch ?? (
              <>
                {t('common.noMatch')}
                {anyNarrow && (
                  <Button size="small" color="inherit" onClick={clearAll} sx={{ color: 'text.secondary' }}>
                    {t('common.clearFilters')}
                  </Button>
                )}
              </>
              )
            )
          }
        />
        )}
      </Box>
      {note && (
        <Typography variant="caption" color="text.secondary" component="p" sx={{ mt: 2 }}>
          {note}
        </Typography>
      )}
    </Box>
  );
}

/** 항목 모양이 탭마다 다른 화면에서, 탭 하나를 자기 항목 모양으로 쓰고 목록에 넣을 수 있게 맞춘다. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const tabOf = <U,>(t: ListTab<U>): ListTab<any> => t as ListTab<any>;

/** 카드의 숫자·라벨·둘째 줄. 0 이면 무채색(탭 배지·거르기 배지와 같은 규칙). 화면이 0 에 'good' 을 줘도 초록으로 칠하지 않는다 */
function CardBody({ n, label, sub, tone, dimZero, subId }: { n: number | string; label: string; sub?: string; tone?: Tone; dimZero?: boolean; subId?: string }) {
  const color = dimZero && n === 0 ? 'text.disabled' : tone && n !== 0 && n !== '—' ? `${toneColor(tone)}.main` : undefined;
  return (
    <>
      <Typography data-card-n="" variant="h6" component="span" color={color}>
        {n}
      </Typography>
      <Box data-card-text="" sx={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', ml: 1, textAlign: 'left' }}>
        <Typography data-card-label="" variant="caption" color="text.secondary">
          {label}
        </Typography>
        {sub && (
          <Typography id={subId} variant="caption" color="text.disabled" component="div">
            {sub}
          </Typography>
        )}
      </Box>
    </>
  );
}

const warned = new Set<string>();
/** 일부 탭에만 card 가 있으면 화면이 조용히 탭 줄로 돌아간다(조건부 탭에 card 를 빠뜨린 경우). 개발 빌드에서 한 번 알린다(2026-10-17-011 §5-4) */
function warnPartialCards<T>(title: string, tabs: ListTab<T>[]) {
  if (warned.has(title)) return;
  warned.add(title);
  console.warn(`ListView(${title}): tabs without card fall back to the tab bar: ${tabs.filter((x) => !x.card).map((x) => x.id).join(', ')}`);
}

/** 보기 카드 줄(2026-10-17-011). MUI Tabs 를 다시 쓰고 탭 라벨을 카드 모양으로 그린다(D8): 수동 활성화(화살표는 포커스만, Enter·Space 로 고름)·roving 포커스·aria-selected 를 그대로 얻는다.
 *  고른 카드는 아래 2px 선만(DESIGN.md Bordered Tabs active), wash 는 켠 거르기 배지에만 쓴다. 넓은 화면은 줄을 넘기고, xs 는 보기 카드만 가로 스크롤하고 배지는 다음 줄로 내린다(D4) */
function ViewCards<T>({
  title,
  tabs,
  value,
  onChange,
  after,
}: {
  title: string;
  tabs: ListTab<T>[];
  value: string;
  onChange: (id: string) => void;
  after: ReactNode[] | null;
}) {
  const theme = useTheme();
  const narrow = useMediaQuery(theme.breakpoints.down('sm'));
  const base = useId();
  return (
    <Stack
      data-view-cards=""
      direction={narrow ? 'column' : 'row'}
      spacing={1.5}
      useFlexGap
      flexWrap="wrap"
      alignItems={narrow ? 'stretch' : 'center'}
      // 아래 여백은 두지 않는다. 표(mt 1.5)·태그 칩 줄(mt 1.5)이 위 간격 12px 를 갖는다 — 탭 줄이 있을 때와 같은 간격
    >
      <Tabs
        value={value}
        onChange={(_, id: string) => onChange(id)}
        aria-label={title}
        variant={narrow ? 'scrollable' : 'standard'}
        scrollButtons={narrow ? 'auto' : false}
        allowScrollButtonsMobile
        TabIndicatorProps={{ style: { display: 'none' } }}
        sx={{
          minHeight: 0,
          '& .MuiTabs-flexContainer': { flexWrap: narrow ? 'nowrap' : 'wrap', gap: 1.5 },
          ...(narrow ? {} : { '& .MuiTabs-scroller': { overflow: 'visible !important' } }),
        }}
      >
        {tabs.map((x) => {
          const n = x.count === null ? null : x.count ?? x.items.length;
          const subId = `${base}-${x.id}`;
          return (
            <Tab
              key={x.id}
              value={x.id}
              data-card=""
              data-view-card=""
              data-count={n ?? ''}
              // 접근 이름은 「라벨, 숫자」. DOM 순서(숫자·라벨·둘째 줄)대로 읽히지 않게 명시하고, 둘째 줄은 설명으로 건다(2026-10-17-011 §5-3)
              aria-label={`${x.label}, ${n ?? '—'}`}
              aria-describedby={x.card?.sub ? subId : undefined}
              label={
                <>
                  <CardBody n={n ?? '—'} label={x.label} sub={x.card?.sub} tone={x.tone} subId={subId} />
                  <ChevronRightIcon sx={{ fontSize: 10, color: 'text.secondary', ml: 1 }} />
                </>
              }
              sx={(th) => {
                const tk = tabTokens[th.palette.mode];
                const line = `inset 0 -2px 0 ${tk.accent}`;
                return {
                  textTransform: 'none',
                  minHeight: 0,
                  minWidth: 0,
                  maxWidth: 'none',
                  px: 2,
                  py: 1,
                  flexDirection: 'row',
                  alignItems: 'center',
                  border: '1px solid',
                  borderColor: 'divider',
                  borderRadius: '6px',
                  flexShrink: 0,
                  '&.Mui-selected': { backgroundColor: 'transparent', boxShadow: line },
                  '&.Mui-selected:hover': { boxShadow: line },
                  '&.Mui-selected [data-card-label]': { color: tk.activeText, fontWeight: 600 },
                };
              }}
            />
          );
        })}
      </Tabs>
      {after && (
        <>
          {!narrow && <Divider orientation="vertical" flexItem />}
          <Stack data-view-after="" direction="row" spacing={1.5} useFlexGap flexWrap="wrap">
            {after}
          </Stack>
        </>
      )}
    </Stack>
  );
}

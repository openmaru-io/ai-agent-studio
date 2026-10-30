/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 공통 표(OMAI-1127, 계획 docs-plan/ui/common-data-grid.md 2026-10-13-015).
// 상태(거르기·정렬·페이지)의 주인은 ListView 다. 이 표는 받은 행과 상태를 그리고, 바뀐 값을 알리기만 한다.
// material-react-table 은 열 모델·열 보이기 상태를 맡고(manualFiltering·manualSorting·manualPagination),
// 몸체는 COP Table.tsx 처럼 gridTemplateColumns 로 직접 그려 fr 너비와 CSS 고정(sticky) 칸을 쓴다(재검토 D1).
// 셀 도우미(이름·상태·경과 시간)도 여기에 둔다 — bits.tsx 는 첫 화면이 쓰므로 거기 두면 표 라이브러리가 첫 화면 묶음에 들어간다.
import ChevronLeftIcon from '@mui/icons-material/ChevronLeft';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import FilterListIcon from '@mui/icons-material/FilterList';
import MoreHorizIcon from '@mui/icons-material/MoreHoriz';
import RefreshIcon from '@mui/icons-material/Refresh';
import ViewColumnOutlinedIcon from '@mui/icons-material/ViewColumnOutlined';
import {
  Box,
  Checkbox,
  Divider,
  IconButton,
  LinearProgress,
  ListItemIcon,
  ListItemText,
  Menu,
  MenuItem,
  NativeSelect,
  TableSortLabel,
  TextField,
  Tooltip,
  Typography,
  useMediaQuery,
} from '@mui/material';
import { createTheme, Theme, ThemeProvider, useTheme } from '@mui/material/styles';
import { visuallyHidden } from '@mui/utils';
import { MRT_ColumnDef, MRT_VisibilityState, useMaterialReactTable } from 'material-react-table';
import {
  createContext,
  KeyboardEvent,
  MouseEvent,
  ReactNode,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';

import { AgentChip, ProfileChip } from '@/components/AgentChip';
import { getLang, t } from '@/i18n';
import { fmtTs } from '@/lib/format';
import { MONO_FONT } from '@/lib/monoFont';
import { gridMetrics, gridTokens } from '@/lib/shellTokens';

import type { Tone } from './ListView';

// ── 열·동작·정렬 ──

export interface GridColumn<T> {
  id: string;
  label: string;
  /** 정렬과 기본 표시 값. undefined·빈 문자열은 정렬에서 늘 끝(§4-9 7A) */
  value: (row: T) => string | number | undefined | null;
  render?: (row: T) => ReactNode;
  /** CSS grid 값. 숫자는 fr */
  width?: string | number;
  sort?: boolean | ((a: T, b: T) => number);
  /** 처음에 숨김 */
  hidden?: boolean;
  /** false 면 열 고르기에서 숨길 수 없다(이름 열) */
  hideable?: boolean;
  num?: boolean;
  /** 머리 칸 설명. 마우스를 올리면 툴팁으로 보이고, 보조기기는 접근 가능한 설명(Tooltip describeChild)으로 읽는다(OMAI-1249 V8) */
  help?: string;
  /** 모노스페이스로 그린다(주소·명령 같은 값). render 가 없을 때만 쓰인다 */
  mono?: boolean;
}

export interface GridAction<T> {
  id: string;
  label: string;
  onClick: (row: T) => void;
  /** 관리자 여부·행 권한 값으로 감춘다. 서랍과 같은 함수를 부른다 */
  visible?: (row: T) => boolean;
  /** 행마다 다른 항목 이름(예: 다른 에이전트의 줄은 「…(으)로 바꿔 열기」, 스펙 2026-10-19-018 디자인 DD11). 없으면 label */
  labelFor?: (row: T) => string;
  /** 저장하는 동안 등 잠시 누를 수 없을 때(디자인 DD5) */
  disabled?: (row: T) => boolean;
}

/** 줄 고르기 열(스펙 2026-10-24-003 D16). 고른 것은 행 식별자로 기억해 페이지·거르기가 바뀌어도 남는다 */
export interface GridSelect<T> {
  /** 고를 수 있는 줄인가. 아니면 체크 칸을 끄고 reason 을 도움말로 보인다 */
  selectable: (row: T) => boolean;
  reason?: (row: T) => string | undefined;
  selected: Set<string>;
  onChange: (next: Set<string>) => void;
}

/** 머리 체크: 이 페이지의 고를 수 있는 줄을 모두 고르거나(하나라도 안 골랐으면) 모두 푼다. 다른 페이지의 고른 것은 그대로 */
export function togglePage<T>(rows: T[], rowId: (row: T) => string, select: Pick<GridSelect<T>, 'selectable' | 'selected'>): Set<string> {
  const ids = rows.filter(select.selectable).map(rowId);
  const next = new Set(select.selected);
  const all = ids.length > 0 && ids.every((id) => next.has(id));
  for (const id of ids) {
    if (all) next.delete(id);
    else next.add(id);
  }
  return next;
}

export interface GridSort {
  id: string;
  desc: boolean;
}

export const PAGE_SIZES = [20, 50, 100] as const;

export const parseSort = (v: string | null | undefined): GridSort | null => {
  if (!v) return null;
  const [id, dir] = v.split(',');
  return id ? { id, desc: dir === 'desc' } : null;
};
export const formatSort = (s: GridSort | null): string | null => (s ? `${s.id},${s.desc ? 'desc' : 'asc'}` : null);

/** 머리를 누를 때: 오름 → 내림 → 해제 */
export const nextSort = (cur: GridSort | null, id: string): GridSort | null =>
  !cur || cur.id !== id ? { id, desc: false } : !cur.desc ? { id, desc: true } : null;

const blank = (v: unknown) => v === undefined || v === null || v === '';

/** 정렬(§4-9 7A): 빈 값은 방향과 상관없이 늘 끝, 문자는 현재 언어·숫자 인식 비교. 같은 값은 원래 순서를 지킨다.
 *  sort 의 열이 없거나(탭을 바꿈) 정렬을 끈 열이면 그대로 돌려준다(검토 D19). */
export function sortRows<T>(rows: T[], columns: GridColumn<T>[], sort: GridSort | null): T[] {
  if (!sort) return rows;
  const col = columns.find((c) => c.id === sort.id);
  if (!col || col.sort === false) return rows;
  const dir = sort.desc ? -1 : 1;
  const lang = getLang();
  const indexed = rows.map((row, i) => ({ row, i, v: col.value(row) }));
  indexed.sort((a, b) => {
    if (typeof col.sort === 'function') return col.sort(a.row, b.row) * dir || a.i - b.i;
    const ab = blank(a.v);
    const bb = blank(b.v);
    if (ab || bb) return ab === bb ? a.i - b.i : ab ? 1 : -1;
    const c =
      typeof a.v === 'number' && typeof b.v === 'number'
        ? a.v - b.v
        : String(a.v).localeCompare(String(b.v), lang, { numeric: true, sensitivity: 'base' });
    return c * dir || a.i - b.i;
  });
  return indexed.map((x) => x.row);
}

/** 페이지가 범위를 벗어나면 마지막 페이지로(회귀 계약 10) */
export const clampPage = (page: number, total: number, size: number) =>
  Math.max(0, Math.min(page, Math.ceil(total / size) - 1));

// ── 저장(localStorage 가 막혀도 기본값으로 그린다) ──

const ROWS_KEY = 'aas.grid.rowsPerPage';
const colsKey = (key: string) => `aas.grid.${key}`;

export function loadRowsPerPage(): number {
  try {
    const n = Number(localStorage.getItem(ROWS_KEY));
    return (PAGE_SIZES as readonly number[]).includes(n) ? n : PAGE_SIZES[0];
  } catch {
    return PAGE_SIZES[0];
  }
}
export function saveRowsPerPage(n: number) {
  try {
    localStorage.setItem(ROWS_KEY, String(n));
  } catch {
    /* 저장하지 못해도 이번 화면에서는 고른 값으로 보인다 */
  }
}
function loadHidden(key: string): string[] | null {
  try {
    const raw = localStorage.getItem(colsKey(key));
    const v = raw ? JSON.parse(raw) : null;
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : null;
  } catch {
    return null;
  }
}
function saveHidden(key: string, hidden: string[] | null) {
  try {
    if (hidden) localStorage.setItem(colsKey(key), JSON.stringify(hidden));
    else localStorage.removeItem(colsKey(key));
  } catch {
    /* 저장하지 못해도 화면은 바뀐다 */
  }
}

// ── 경과 시간: 표마다 타이머 하나가 5초마다 시각을 바꾸고, 경과 시간 칸만 구독한다(검토 D8·D21) ──

// 행에 키보드로 닿았는지 가린다(포커스 링은 그때만, 위 행 onFocus 주석). Tab·방향키 같은 이동·실행 키만 센다 — Esc 는 닫는 키라 뺀다.
// Tab 으로 행에 닿을 때 keydown 은 이전 요소에서 일어나므로 창 전체에서 캡처로 시각만 적어 두고, 행 초점이 그 직후일 때만 인정한다
const NAV_KEYS = new Set(['Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown', 'Enter', ' ']);
const NAV_KEY_WINDOW_MS = 300;
let navKeyAt = -Infinity;
if (typeof window !== 'undefined')
  window.addEventListener('keydown', (e) => void (e.key === 'Escape' ? (navKeyAt = -Infinity) : NAV_KEYS.has(e.key) && (navKeyAt = e.timeStamp)), true);

const NowContext = createContext<number>(0);
export const AGE_TICK_MS = 5000;

function NowProvider({ children }: { children: ReactNode }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const h = setInterval(() => setNow(Date.now()), AGE_TICK_MS);
    return () => clearInterval(h);
  }, []);
  return <NowContext.Provider value={now}>{children}</NowContext.Provider>;
}

/** 방금 / N분 / N시간 / N일, 30일이 넘으면 날짜(§4-9 7C) */
export function ageText(ts: string | null | undefined, now: number): string {
  if (!ts) return '';
  const at = Date.parse(ts);
  if (Number.isNaN(at)) return '';
  const s = Math.max(0, (now - at) / 1000);
  if (s < 60) return t('common.grid.justNow');
  if (s < 3600) return t('common.grid.minutes', { n: Math.floor(s / 60) });
  if (s < 86400) return t('common.grid.hours', { n: Math.floor(s / 3600) });
  if (s < 86400 * 30) return t('common.grid.days', { n: Math.floor(s / 86400) });
  return fmtTs(ts).slice(0, 10); // YYYY-MM-DD
}

export function AgeCell({ ts }: { ts?: string | null }) {
  const now = useContext(NowContext) || Date.now();
  if (!ts) return null;
  return (
    <Tooltip title={fmtTs(ts)}>
      <span data-age="">{ageText(ts, now)}</span>
    </Tooltip>
  );
}

// ── 셀 도우미 ──

const dotColor = (tone?: Tone | 'info') =>
  tone === 'bad' ? '#DA291C' : tone === 'warn' ? '#f59e0b' : tone === 'good' ? '#27a644' : tone === 'info' ? '#60a5fa' : '#8a8f98';

const pillColors = (tone: Tone | 'info' | undefined, dark: boolean) => {
  // 안내(예정 등). 색은 토스트의 info 와 같은 하늘색(DESIGN §1-1, 스펙 공지 바 2B)
  if (tone === 'info') return dark ? ['rgba(96,165,250,0.15)', '#60a5fa', 'rgba(96,165,250,0.25)'] : ['#eff6ff', '#2563eb', '#bfdbfe'];
  if (tone === 'bad') return dark ? ['rgba(218,41,28,0.15)', '#ef5350', 'rgba(218,41,28,0.25)'] : ['#fef2f2', '#dc2626', '#fecaca'];
  if (tone === 'warn') return dark ? ['rgba(245,158,11,0.15)', '#f59e0b', 'rgba(245,158,11,0.25)'] : ['#fffbeb', '#b45309', '#fde68a'];
  if (tone === 'good') return dark ? ['rgba(39,166,68,0.15)', '#27a644', 'rgba(39,166,68,0.25)'] : ['#f0fdf4', '#15803d', '#bbf7d0'];
  return dark ? ['rgba(255,255,255,0.05)', '#d0d6e0', 'rgba(255,255,255,0.08)'] : ['#f3f4f6', '#374151', '#e5e7eb'];
};

/** 덧붙는 상태(멈춤 등)의 Pill. DESIGN Pill: 높이 20, 11px 500, radius 9999(§4-9 5C) */
export function Pill({ tone, children, flush }: { tone?: Tone | 'info'; children: ReactNode; /** 글자 옆에 덧붙지 않고 칸 안에 홀로 둘 때(왼쪽 여백 없음) */ flush?: boolean }) {
  const dark = useTheme().palette.mode === 'dark';
  const [bg, fg, line] = pillColors(tone, dark);
  return (
    <Box
      component="span"
      data-pill=""
      sx={{ display: 'inline-flex', alignItems: 'center', height: 20, px: 1, borderRadius: 9999, fontSize: 11, fontWeight: 500,
        bgcolor: bg, color: fg, border: `1px solid ${line}`, ml: flush ? 0 : 1, whiteSpace: 'nowrap' }}
    >
      {children}
    </Box>
  );
}

/** 이름 칸: 단색 앞 글자 배지 + 글자 이름(링크 아님, §4-9 4A) */
export function nameColumn<T>(o: { id?: string; label: string; value: (row: T) => string; letter?: string }): GridColumn<T> {
  return {
    id: o.id ?? 'name',
    label: o.label,
    value: o.value,
    width: 'minmax(200px, 2fr)',
    hideable: false,
    render: (row) => (
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, minWidth: 0 }}>
        <Box
          component="span"
          aria-hidden
          sx={(th) => ({ flex: '0 0 20px', height: 20, borderRadius: '4px', display: 'inline-flex', alignItems: 'center',
            justifyContent: 'center', fontSize: 11, fontWeight: 600, color: 'text.secondary',
            bgcolor: gridTokens[th.palette.mode].badgeBg })}
        >
          {(o.letter ?? o.value(row) ?? '?').slice(0, 1).toUpperCase()}
        </Box>
        <Overflow data-row-title="" text={o.value(row)} className="grid-name" />
      </Box>
    ),
  };
}

/** 에이전트 이름 칸: 「● 이름」 칩. 정렬·검색 값은 이름 글자이고 nameColumn 과 같은 칸 너비다. */
export function agentNameColumn<T>(o: { id?: string; label: string; value: (row: T) => string; colorKey?: (row: T) => string }): GridColumn<T> {
  return {
    id: o.id ?? 'name',
    label: o.label,
    value: o.value,
    width: 'minmax(200px, 2fr)',
    hideable: false,
    render: (row) => <AgentChip name={o.value(row)} colorKey={o.colorKey?.(row)} size="sm" />,
  };
}

/** 프로파일 이름 칸: 모서리 4px 사각 칩. agentNameColumn 과 같고 모양만 다르다. */
export function profileNameColumn<T>(o: { id?: string; label: string; value: (row: T) => string; colorKey?: (row: T) => string }): GridColumn<T> {
  return { ...agentNameColumn(o), render: (row) => <ProfileChip name={o.value(row)} colorKey={o.colorKey?.(row)} size="sm" /> };
}

/** 상태 칸: 8px 점 + 글자, 덧붙는 상태는 옆에 Pill(§4-9 5C) */
export function statusColumn<T>(o: {
  id?: string;
  label: string;
  value: (row: T) => string;
  tone: (row: T) => Tone | undefined;
  extra?: (row: T) => ReactNode;
}): GridColumn<T> {
  return {
    id: o.id ?? 'status',
    label: o.label,
    value: o.value,
    width: 'minmax(120px, auto)',
    render: (row) => (
      <Box sx={{ display: 'flex', alignItems: 'center', minWidth: 0 }}>
        <Box component="span" data-dot="" sx={{ width: 8, height: 8, borderRadius: '50%', flex: '0 0 8px', mr: 1, bgcolor: dotColor(o.tone(row)) }} />
        <span>{o.value(row)}</span>
        {o.extra?.(row)}
      </Box>
    ),
  };
}

/** 경과 시간 칸: 88px, 오른쪽 정렬, 시각 값으로 정렬(§4-9 5E·7C) */
export function ageColumn<T>(o: { id?: string; label: string; value: (row: T) => string | null | undefined }): GridColumn<T> {
  const at = (r: T) => {
    const v = o.value(r);
    return v ? Date.parse(v) : NaN;
  };
  return {
    id: o.id ?? 'age',
    label: o.label,
    value: (r) => o.value(r) ?? undefined,
    width: '88px',
    num: true,
    sort: (a, b) => {
      const x = at(a);
      const y = at(b);
      if (Number.isNaN(x) || Number.isNaN(y)) return Number.isNaN(x) === Number.isNaN(y) ? 0 : Number.isNaN(x) ? 1 : -1;
      return x - y;
    },
    render: (r) => <AgeCell ts={o.value(r)} />,
  };
}

/** 한 줄 말줄임. 넘칠 때만 전체 값 tooltip(재검토 D5) */
export const overflows = (el: { scrollWidth: number; clientWidth: number } | null) => !!el && el.scrollWidth > el.clientWidth;

function Overflow({ text, mono, ...rest }: { text: string; mono?: boolean; className?: string; 'data-row-title'?: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [open, setOpen] = useState(false);
  return (
    <Tooltip title={text} open={open} onOpen={() => setOpen(overflows(ref.current))} onClose={() => setOpen(false)}>
      <Box component="span" ref={ref} {...rest} sx={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0, ...(mono ? { fontFamily: MONO_FONT } : {}) }}>
        {text}
      </Box>
    </Tooltip>
  );
}

// ── 표 ──

export interface DataGridProps<T> {
  /** 열 숨김 저장 키(aas.grid.<화면>.<탭>) */
  storageKey: string;
  label: string;
  columns: GridColumn<T>[];
  /** 이번 페이지의 행(ListView 가 거르고 정렬하고 자른 것) */
  rows: T[];
  rowId: (row: T) => string;
  /** 행 메뉴 단추의 읽기 이름에 쓰는 행 이름 */
  rowName: (row: T) => string;
  /** 행의 보조 설명(aria-description). 누르면 일어나는 일이 다른 행에 단다(디자인 DD11) */
  rowDescription?: (row: T) => string | undefined;
  /** 거른 뒤 전체 행 수 */
  total: number;
  page: number;
  rowsPerPage: number;
  onPage: (page: number) => void;
  onRowsPerPage: (n: number) => void;
  sort: GridSort | null;
  onSort: (s: GridSort | null) => void;
  onRow?: (row: T) => void;
  /** 셀 안에 링크·단추가 있는 표. onRow 가 없어도 행을 aria-disabled 로 표시하지 않는다(안의 링크가 사용 불가로 읽히지 않게) */
  cellControls?: boolean;
  selectedId?: string | null;
  /** 첫 항목은 「상세 보기」. 항목이 하나뿐이면 메뉴 열을 그리지 않는다 */
  actions?: GridAction<T>[];
  /** 툴바 왼쪽(걸린 필터 칩) */
  toolbarStart?: ReactNode;
  /** 툴바 오른쪽, 개수 앞에 두는 것(화면 도구·검색창) */
  toolbarEnd?: ReactNode;
  /** 툴바 오른쪽 끝, 아이콘 뒤의 주 동작(「+ 새 …」 단추) */
  toolbarAction?: ReactNode;
  /** 툴바 오른쪽 아이콘 앞의 개수 문구 */
  count?: string;
  /** 열 필터 줄 내용. 없으면 필터 단추를 그리지 않는다 */
  filterRow?: ReactNode;
  /** 걸린 필터가 있으면 필터 단추를 켠 모양으로 */
  filtersActive?: boolean;
  onRefresh?: () => void;
  refreshing?: boolean;
  /** 행이 없을 때 몸체에 보일 안내 */
  empty?: ReactNode;
  /** 있으면 왼쪽에 줄 고르기 열을 둔다(D16) */
  select?: GridSelect<T>;
}

const neutralTheme = (outer: Theme) =>
  createTheme(outer, {
    // MRT·MUI 의 활성 표시가 primary 파랑(#1565C0)을 쓰지 않게 표 영역에서만 무채색으로 바꾼다(§4-9 5A)
    palette: { primary: { main: outer.palette.text.primary, contrastText: outer.palette.background.paper } },
  });

export function DataGrid<T>(p: DataGridProps<T>) {
  const outer = useTheme();
  const theme = useMemo(() => neutralTheme(outer), [outer]);
  return (
    <ThemeProvider theme={theme}>
      <NowProvider>
        <Grid {...p} />
      </NowProvider>
    </ThemeProvider>
  );
}

function defaultsHidden<T>(columns: GridColumn<T>[]) {
  return columns.filter((c) => c.hidden && c.hideable !== false).map((c) => c.id);
}

function Grid<T>(p: DataGridProps<T>) {
  const descBase = useId();
  const theme = useTheme();
  const mode = theme.palette.mode;
  const tk = gridTokens[mode];
  const narrow = useMediaQuery(theme.breakpoints.down('sm'));
  const [hidden, setHidden] = useState<string[]>(() => loadHidden(p.storageKey) ?? defaultsHidden(p.columns));
  useEffect(() => setHidden(loadHidden(p.storageKey) ?? defaultsHidden(p.columns)), [p.storageKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const [showFilters, setShowFilters] = useState(false);
  const [colsAnchor, setColsAnchor] = useState<HTMLElement | null>(null);
  const [moreAnchor, setMoreAnchor] = useState<HTMLElement | null>(null);
  const [menu, setMenu] = useState<{ el: HTMLElement; row: T } | null>(null);
  const [pressed, setPressed] = useState(false); // 사용자가 누른 새로 고침만 표시한다(재검토 D4)
  useEffect(() => {
    if (!p.refreshing) setPressed(false);
  }, [p.refreshing]);

  const visibility: MRT_VisibilityState = useMemo(
    () => Object.fromEntries(p.columns.map((c) => [c.id, c.hideable === false || !hidden.includes(c.id)])),
    [p.columns, hidden]
  );
  const mrtColumns = useMemo<MRT_ColumnDef<T & object>[]>(
    () => p.columns.map((c) => ({ id: c.id, header: c.label, accessorFn: (r) => c.value(r as T) ?? '' })),
    [p.columns]
  );
  const table = useMaterialReactTable<T & object>({
    columns: mrtColumns,
    data: p.rows as (T & object)[],
    getRowId: (r) => p.rowId(r as T),
    manualFiltering: true,
    manualSorting: true,
    manualPagination: true,
    rowCount: p.total,
    autoResetPageIndex: false,
    enableColumnActions: false,
    enableColumnDragging: false,
    enableColumnResizing: false,
    enableDensityToggle: false,
    enableFullScreenToggle: false,
    enableFilterMatchHighlighting: false,
    enableGlobalFilter: false,
    enableColumnFilters: false,
    enableSorting: false,
    enablePagination: false,
    enableRowSelection: false,
    enableTopToolbar: false,
    enableBottomToolbar: false,
    layoutMode: 'grid',
    mrtTheme: {
      baseBackgroundColor: tk.surface,
      selectedRowBackgroundColor: tk.selectedSolid,
      pinnedRowBackgroundColor: tk.selectedSolid,
      draggingBorderColor: tk.selectedAccent,
      matchHighlightColor: 'transparent',
    },
    // 열 순서도 넘겨 준다. MRT 는 처음 받은 열 순서를 상태로 들고 있어, 탭을 바꿔 열 목록이 달라지면
    // 앞 탭에 있던 열이 앞에 남는다(라이브러리 → 설치 환경, OMAI-1127 단계 5)
    state: { columnVisibility: visibility, columnOrder: p.columns.map((c) => c.id) },
  });

  const byId = useMemo(() => new Map(p.columns.map((c) => [c.id, c])), [p.columns]);
  const cols = table.getVisibleLeafColumns().map((c) => byId.get(c.id)).filter(Boolean) as GridColumn<T>[];
  const rows = table.getRowModel().rows;
  const actions = p.actions ?? [];
  const hasMenu = actions.length > 1;
  const sel = p.select;
  const SELECT_W = 44;
  const pageIds = sel ? rows.map((r) => r.original as T).filter(sel.selectable).map(p.rowId) : [];
  const pageOn = pageIds.filter((id) => sel?.selected.has(id)).length;
  const firstLeft = sel ? SELECT_W : 0;
  const template = [
    ...(sel ? [`${SELECT_W}px`] : []),
    ...cols.map((c) => (typeof c.width === 'number' ? `${c.width}fr` : c.width ?? 'minmax(100px, 1fr)')),
    ...(hasMenu ? ['40px'] : []),
  ].join(' ');

  const toggleHidden = (id: string) => {
    const next = hidden.includes(id) ? hidden.filter((x) => x !== id) : [...hidden, id];
    setHidden(next);
    saveHidden(p.storageKey, next);
  };
  const resetColumns = () => {
    setHidden(defaultsHidden(p.columns));
    saveHidden(p.storageKey, null);
    setColsAnchor(null);
  };
  const refresh = () => {
    if (!p.onRefresh) return;
    setPressed(true);
    p.onRefresh();
  };
  const showProgress = !!(p.refreshing && pressed);

  const open = (row: T) => p.onRow?.(row);
  const onKey = (e: KeyboardEvent, row: T) => {
    if (e.target !== e.currentTarget) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      open(row);
    }
  };

  const iconSx = { width: 32, height: 32, color: 'text.secondary', '&.on': { color: 'text.primary' } };
  const icons = (
    <>
      {p.filterRow && (
        <Tooltip title={t('common.grid.filters')}>
          <IconButton
            className={showFilters || p.filtersActive ? 'on' : undefined}
            aria-label={t('common.grid.filters')}
            aria-pressed={showFilters}
            onClick={() => setShowFilters((v) => !v)}
            sx={iconSx}
          >
            <FilterListIcon fontSize="small" />
          </IconButton>
        </Tooltip>
      )}
      <Tooltip title={t('common.grid.columns')}>
        <IconButton aria-label={t('common.grid.columns')} onClick={(e) => setColsAnchor(e.currentTarget)} sx={iconSx}>
          <ViewColumnOutlinedIcon fontSize="small" />
        </IconButton>
      </Tooltip>
      {p.onRefresh && (
        <Tooltip title={t('common.grid.refresh')}>
          <span>
            <IconButton aria-label={t('common.grid.refresh')} onClick={refresh} disabled={showProgress} sx={iconSx}>
              <RefreshIcon
                fontSize="small"
                sx={showProgress ? { animation: 'grid-spin 1s linear infinite', '@keyframes grid-spin': { to: { transform: 'rotate(360deg)' } } } : undefined}
              />
            </IconButton>
          </span>
        </Tooltip>
      )}
    </>
  );

  const lastPage = Math.max(0, Math.ceil(p.total / p.rowsPerPage) - 1);
  const from = p.total ? p.page * p.rowsPerPage + 1 : 0;
  const to = Math.min(p.total, (p.page + 1) * p.rowsPerPage);
  const showFooter = p.total > PAGE_SIZES[0] && rows.length > 0;
  const cellPx = `${gridMetrics.cellX}px`;

  const stickyBg = (selected: boolean) => (selected ? tk.selectedSolid : tk.surface);

  return (
    <Box
      data-grid=""
      sx={{ border: `1px solid ${tk.barLine}`, borderRadius: 1, bgcolor: tk.surface, overflow: 'hidden', fontSize: 12.5 }}
    >
      {/* 툴바 한 줄: [필터 칩] ··· [화면 도구][검색][개수][아이콘][+ 새 …]. 처음 정한 6A(도구·검색이 왼쪽)를 바꿨다(2026-10-13) */}
      <Box
        data-grid-toolbar=""
        sx={{ position: 'relative', display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 1, minHeight: gridMetrics.toolbar,
          px: 1.5, py: 0.5, bgcolor: tk.bar, borderBottom: `1px solid ${tk.barLine}` }}
      >
        <Box sx={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 1, flex: '0 1 auto', minWidth: 0 }}>{p.toolbarStart}</Box>
        <Box sx={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', justifyContent: 'flex-end', gap: 0.25, flex: '1 1 auto', minWidth: 0, ml: 'auto' }}>
          {/* 화면 도구는 줄어들지 않고(글자가 잘리거나 두 줄이 되지 않게), 검색창만 줄어들거나 다음 줄로 간다 */}
          {p.toolbarEnd && (
            <Box
              sx={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', justifyContent: 'flex-end', gap: 1, mr: 1, minWidth: 0, flex: '1 1 auto',
                '& > :not([data-grid-search])': { flexShrink: 0, whiteSpace: 'nowrap' } }}
            >
              {p.toolbarEnd}
            </Box>
          )}
          {/* 개수와 아이콘은 한 덩어리로 둔다(좁은 화면에서 서로 다른 줄로 갈라지지 않게) */}
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.25, flex: '0 0 auto' }}>
            {p.count && (
              <Typography variant="caption" color="text.secondary" sx={{ mr: 1, whiteSpace: 'nowrap' }} data-grid-count="">
                {p.count}
              </Typography>
            )}
            {narrow ? (
              <IconButton aria-label={t('common.grid.moreTools')} onClick={(e) => setMoreAnchor(e.currentTarget)} sx={iconSx}>
                <MoreHorizIcon fontSize="small" />
              </IconButton>
            ) : (
              icons
            )}
            {p.toolbarAction && <Box sx={{ ml: 1, display: 'inline-flex' }}>{p.toolbarAction}</Box>}
          </Box>
        </Box>
        {showProgress && (
          <LinearProgress aria-label={t('common.loading')} sx={{ position: 'absolute', left: 0, right: 0, bottom: 0 }} />
        )}
      </Box>
      <Menu anchorEl={moreAnchor} open={!!moreAnchor} onClose={() => setMoreAnchor(null)}>
        {p.filterRow && (
          <MenuItem onClick={() => (setShowFilters((v) => !v), setMoreAnchor(null))}>{t('common.grid.filters')}</MenuItem>
        )}
        <MenuItem onClick={(e) => (setColsAnchor(e.currentTarget), setMoreAnchor(null))}>{t('common.grid.columns')}</MenuItem>
        {p.onRefresh && <MenuItem onClick={() => (refresh(), setMoreAnchor(null))}>{t('common.grid.refresh')}</MenuItem>}
      </Menu>

      {/* 열 고르기: 체크박스, 이름 열은 숨길 수 없다, 맨 아래 기본값으로(§4-9 7C, 재검토 M2) */}
      <Menu anchorEl={colsAnchor} open={!!colsAnchor} onClose={() => setColsAnchor(null)}>
        {p.columns
          .filter((c) => c.hideable !== false)
          .map((c) => (
            <MenuItem key={c.id} dense onClick={() => toggleHidden(c.id)}>
              <ListItemIcon>
                <Checkbox size="small" edge="start" tabIndex={-1} disableRipple checked={!hidden.includes(c.id)} sx={{ p: 0 }} />
              </ListItemIcon>
              <ListItemText>{c.label}</ListItemText>
            </MenuItem>
          ))}
        <Divider />
        <MenuItem dense onClick={resetColumns}>
          {t('common.grid.resetColumns')}
        </MenuItem>
      </Menu>

      {p.filterRow && showFilters && (
        <Box data-grid-filters="" sx={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 1.5, px: 1.5, py: 1, bgcolor: tk.bar, borderBottom: `1px solid ${tk.barLine}` }}>
          {p.filterRow}
        </Box>
      )}

      <Box sx={{ overflowX: 'auto' }}>
        <Box role="table" aria-label={p.label} aria-rowcount={p.total + 1} sx={{ display: 'grid', gridTemplateColumns: template, minWidth: '100%' }}>
          <Box role="row" sx={{ display: 'grid', gridColumn: '1 / -1', gridTemplateColumns: 'subgrid', minHeight: gridMetrics.head, bgcolor: tk.head, borderBottom: `1px solid ${tk.barLine}` }}>
            {sel && (
              <Box role="columnheader" sx={{ position: 'sticky', left: 0, zIndex: 2, bgcolor: tk.headSolid, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <Checkbox
                  size="small"
                  data-select-page=""
                  disabled={!pageIds.length}
                  checked={pageIds.length > 0 && pageOn === pageIds.length}
                  indeterminate={pageOn > 0 && pageOn < pageIds.length}
                  onChange={() => sel.onChange(togglePage(rows.map((r) => r.original as T), p.rowId, sel))}
                  inputProps={{ 'aria-label': t('common.grid.selectPage') }}
                  sx={{ p: 0.5, '@media (pointer: coarse)': { width: 44, height: 44 } }}
                />
              </Box>
            )}
            {cols.map((c, i) => {
              const active = p.sort?.id === c.id ? p.sort : null;
              const sortable = c.sort !== false;
              const head = (
                <Box
                  key={c.id}
                  role="columnheader"
                  aria-sort={active ? (active.desc ? 'descending' : 'ascending') : sortable ? 'none' : undefined}
                  sx={{ display: 'flex', alignItems: 'center', justifyContent: c.num ? 'flex-end' : 'flex-start', px: cellPx,
                    pl: i === 0 ? `${gridMetrics.firstCellX}px` : cellPx, fontSize: 12, fontWeight: 500, whiteSpace: 'nowrap',
                    // 헤더 글자는 흐리게 두고(COP), hover 에서 진해지며, 정렬 중인 열만 본문 글자색이다
                    color: active ? 'text.primary' : tk.headText, '&:hover': { color: active ? 'text.primary' : tk.headHover }, transition: 'color 120ms ease',
                    ...(i === 0 ? { position: 'sticky', left: firstLeft, zIndex: 2, bgcolor: tk.headSolid } : {}) }}
                >
                  {sortable ? (
                    <TableSortLabel
                      active={!!active}
                      direction={active?.desc ? 'desc' : 'asc'}
                      onClick={() => p.onSort(nextSort(p.sort, c.id))}
                      sx={{ color: 'inherit', '& .MuiTableSortLabel-icon': { fontSize: 14 }, '&:not(.Mui-active) .MuiTableSortLabel-icon': { opacity: 0 }, '&:hover:not(.Mui-active) .MuiTableSortLabel-icon': { opacity: 0.5 } }}
                    >
                      {c.label}
                    </TableSortLabel>
                  ) : (
                    c.label
                  )}
                </Box>
              );
              return c.help ? (
                <Tooltip key={c.id} title={c.help} describeChild>
                  {head}
                </Tooltip>
              ) : (
                head
              );
            })}
            {hasMenu && (
              <Box role="columnheader" aria-label={t('common.grid.actions')} sx={{ position: 'sticky', right: 0, zIndex: 2, bgcolor: tk.headSolid }} />
            )}
          </Box>

          {rows.length === 0 ? (
            <Box role="row" sx={{ gridColumn: '1 / -1' }}>
              <Box role="cell" data-grid-empty="" sx={{ minHeight: 120, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 1, color: 'text.secondary', fontSize: 12.5 }}>
                {p.empty}
              </Box>
            </Box>
          ) : (
            rows.map((r, idx) => {
              const row = r.original as T;
              const desc = p.rowDescription?.(row);
              const selected = !!p.selectedId && p.selectedId === r.id;
              const clickable = !!p.onRow;
              const rowActions = actions.filter((a) => !a.visible || a.visible(row));
              return (
                <Box
                  key={r.id}
                  role="row"
                  data-row-id={r.id}
                  aria-current={selected}
                  aria-describedby={desc ? `${descBase}-${idx}` : undefined}
                  aria-disabled={clickable || p.cellControls ? undefined : true}
                  tabIndex={clickable ? 0 : undefined}
                  onClick={clickable ? () => open(row) : undefined}
                  // 포커스 링은 「키보드로 닿았다」는 표시(data-kbd)가 있을 때만 그린다. 서랍을 Esc 로 닫으면 MUI 가 초점을 행으로 되돌리고
                  // 브라우저는 마지막 입력이 키보드라 그 행을 :focus-visible 로 본다. 예전(OMAI-1288)에는 「마우스로 눌렀다」는 표시를 두고 키를 누르면
                  // 지웠는데, Esc 를 한 번 더 누르면(첫 Esc 가 서랍을 닫고 둘째가 행에 닿는다) 표시가 지워져 링이 생겼다(2026-10-18 재발).
                  // Esc 는 닫는 키라 표시를 달지 않는다. 키보드로 연 서랍으로 초점이 가도 표시는 남고, 서랍이 아닌 곳으로 떠나면 지운다
                  onFocus={clickable ? (e) => void (e.timeStamp - navKeyAt < NAV_KEY_WINDOW_MS && (e.currentTarget.dataset.kbd = '')) : undefined}
                  onKeyDown={
                    clickable
                      ? (e) => {
                          if (NAV_KEYS.has(e.key)) e.currentTarget.dataset.kbd = '';
                          onKey(e, row);
                        }
                      : undefined
                  }
                  onPointerDown={clickable ? (e) => void delete e.currentTarget.dataset.kbd : undefined}
                  onBlur={
                    clickable
                      ? (e) => {
                          if (!(e.relatedTarget as Element | null)?.closest?.('[role="dialog"]')) delete e.currentTarget.dataset.kbd;
                        }
                      : undefined
                  }
                  sx={{ position: 'relative', display: 'grid', gridColumn: '1 / -1', gridTemplateColumns: 'subgrid', minHeight: gridMetrics.row,
                    borderBottom: `1px solid ${tk.rowLine}`, cursor: clickable ? 'pointer' : 'default', outline: 'none',
                    bgcolor: selected ? tk.selected : 'transparent', color: selected ? tk.selectedText : 'text.primary',
                    '&:hover': clickable ? { bgcolor: selected ? tk.selected : tk.hover, '& .grid-sticky': { bgcolor: selected ? tk.selectedSolid : tk.hoverSolid }, '& .grid-name': { textDecoration: 'underline' } } : undefined,
                    // 키보드 포커스는 선택과 별개로 빨간 inset 링(디자인 6B). 고정 칸에 가리지 않게 행 위 덮개로 그린다(재검토 D1)
                    '&[data-kbd]:focus-visible::after': { content: '""', position: 'absolute', inset: 0, boxShadow: `inset 0 0 0 2px ${tk.focusRing}`, zIndex: 3, pointerEvents: 'none' } }}
                >
                  {sel && (
                    <Box role="cell" className="grid-sticky" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}
                      sx={{ position: 'sticky', left: 0, zIndex: 1, bgcolor: stickyBg(selected), display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                      {(() => {
                        const id = p.rowId(row);
                        const can = sel.selectable(row);
                        const box = (
                          <Checkbox
                            size="small"
                            data-select-row={id}
                            disabled={!can}
                            checked={can && sel.selected.has(id)}
                            onChange={() => {
                              const next = new Set(sel.selected);
                              if (next.has(id)) next.delete(id);
                              else next.add(id);
                              sel.onChange(next);
                            }}
                            inputProps={{ 'aria-label': t('common.grid.selectRow', { name: p.rowName(row) }) }}
                            sx={{ p: 0.5, '@media (pointer: coarse)': { width: 44, height: 44 } }}
                          />
                        );
                        const why = can ? undefined : sel.reason?.(row);
                        return why ? (
                          <Tooltip title={why}>
                            <span data-select-reason={why}>{box}</span>
                          </Tooltip>
                        ) : (
                          box
                        );
                      })()}
                    </Box>
                  )}
                  {cols.map((c, i) => (
                    <Box
                      key={c.id}
                      role="cell"
                      className={i === 0 ? 'grid-sticky' : undefined}
                      sx={{ display: 'flex', alignItems: 'center', justifyContent: c.num ? 'flex-end' : 'flex-start', minWidth: 0, px: cellPx,
                        pl: i === 0 ? `${gridMetrics.firstCellX}px` : cellPx, overflow: 'hidden',
                        fontVariantNumeric: c.num ? 'tabular-nums' : undefined, color: c.num ? 'text.secondary' : undefined,
                        ...(i === 0
                          ? { position: 'sticky', left: firstLeft, zIndex: 1, bgcolor: stickyBg(selected),
                              boxShadow: selected ? `inset 2px 0 0 ${tk.selectedAccent}` : undefined }
                          : {}) }}
                    >
                      {c.render ? c.render(row) : <Overflow text={String(c.value(row) ?? '')} mono={c.mono} />}
                    </Box>
                  ))}
                  {hasMenu && (
                    <Box role="cell" className="grid-sticky" sx={{ position: 'sticky', right: 0, zIndex: 1, bgcolor: stickyBg(selected), display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                      {rowActions.length > 0 && (
                        <IconButton
                          aria-label={t('common.grid.actionsFor', { name: p.rowName(row) })}
                          aria-haspopup="menu"
                          onClick={(e: MouseEvent<HTMLElement>) => {
                            e.stopPropagation();
                            setMenu({ el: e.currentTarget, row });
                          }}
                          onKeyDown={(e) => e.stopPropagation()}
                          // 손가락 화면에서는 44px(DESIGN §4, 스펙 2026-10-19-018 디자인 DD13)
                          sx={{ width: 32, height: 32, color: 'text.secondary', '@media (pointer: coarse)': { width: 44, height: 44 } }}
                        >
                          <MoreHorizIcon fontSize="small" />
                        </IconButton>
                      )}
                    </Box>
                  )}
                </Box>
              );
            })
          )}
        </Box>
      </Box>

      {/* 행의 보조 설명(rowDescription). 행 안에는 셀만 두므로 표 밖의 숨긴 글로 잇는다(디자인 DD11) */}
      {p.rowDescription && (
        <Box sx={visuallyHidden}>
          {rows.map((r, idx) => {
            const desc = p.rowDescription?.(r.original as T);
            return desc ? (
              <span key={r.id} id={`${descBase}-${idx}`}>
                {desc}
              </span>
            ) : null;
          })}
        </Box>
      )}
      <Menu anchorEl={menu?.el} open={!!menu} onClose={() => setMenu(null)} onClick={(e) => e.stopPropagation()}>
        {menu &&
          actions
            .filter((a) => !a.visible || a.visible(menu.row))
            .map((a) => (
              <MenuItem
                key={a.id}
                dense
                disabled={a.disabled?.(menu.row)}
                onClick={() => {
                  const row = menu.row;
                  setMenu(null);
                  a.onClick(row);
                }}
              >
                {a.labelFor?.(menu.row) ?? a.label}
              </MenuItem>
            ))}
      </Menu>

      {showFooter && (
        <Box
          data-grid-footer=""
          sx={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 1.5, minHeight: gridMetrics.footer, px: 1.5,
            bgcolor: tk.bar, borderTop: `1px solid ${tk.barLine}`, fontSize: 12, color: 'text.secondary' }}
        >
          <Box component="label" sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            {t('common.grid.rowsPerPage')}
            <NativeSelect
              value={p.rowsPerPage}
              onChange={(e) => p.onRowsPerPage(Number(e.target.value))}
              inputProps={{ 'aria-label': t('common.grid.rowsPerPage') }}
              sx={{ fontSize: 12 }}
              disableUnderline
            >
              {PAGE_SIZES.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </NativeSelect>
          </Box>
          <span data-grid-range="">{t('common.grid.range', { from, to, total: p.total })}</span>
          <IconButton aria-label={t('common.grid.prev')} disabled={p.page <= 0} onClick={() => p.onPage(p.page - 1)} sx={{ width: 28, height: 28 }}>
            <ChevronLeftIcon fontSize="small" />
          </IconButton>
          <IconButton aria-label={t('common.grid.next')} disabled={p.page >= lastPage} onClick={() => p.onPage(p.page + 1)} sx={{ width: 28, height: 28 }}>
            <ChevronRightIcon fontSize="small" />
          </IconButton>
        </Box>
      )}
    </Box>
  );
}

/** 걸린 필터 칩: Neutral Pill, 높이 24, 값 최대 160px 말줄임(§4-9 5D) */
export function FilterChip({ label, value, onClear }: { label: string; value: string; onClear: () => void }) {
  const dark = useTheme().palette.mode === 'dark';
  const [bg, , line] = pillColors(undefined, dark);
  return (
    <Box
      component="span"
      data-filter-chip=""
      sx={{ display: 'inline-flex', alignItems: 'center', height: 24, pl: 1, pr: 0.25, borderRadius: 9999, fontSize: 12, fontWeight: 500,
        bgcolor: bg, border: `1px solid ${line}`, maxWidth: 260 }}
    >
      <Box component="span" sx={{ color: 'text.secondary', mr: 0.5, whiteSpace: 'nowrap' }}>
        {label}:
      </Box>
      <Box component="span" sx={{ color: 'text.primary', maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {value}
      </Box>
      <IconButton aria-label={t('common.grid.clearFilter', { label })} onClick={onClear} sx={{ width: 20, height: 20, ml: 0.25 }}>
        <Box component="span" aria-hidden sx={{ fontSize: 14, lineHeight: 1 }}>
          ×
        </Box>
      </IconButton>
    </Box>
  );
}

/** 표 툴바의 검색창(ListView·LocalDataGrid 가 같이 쓴다). 툴바 오른쪽에서 기본 240px, 좁으면 120px 까지 줄어든다 */
export function GridSearch({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <TextField
      type="search"
      size="small"
      placeholder={t('common.search')}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      data-grid-search=""
      slotProps={{ htmlInput: { 'aria-label': t('common.search'), 'data-view-search': '' } }}
      sx={(th) => {
        const tk = gridTokens[th.palette.mode];
        return {
          flex: '0 1 240px',
          minWidth: 120,
          maxWidth: 240,
          '& .MuiOutlinedInput-root': { bgcolor: tk.searchBg, fontSize: 12.5, height: 30 },
          '& .MuiOutlinedInput-notchedOutline': { borderColor: tk.searchLine },
          '& .Mui-focused .MuiOutlinedInput-notchedOutline': {
            borderColor: `${tk.searchFocus} !important`,
            borderWidth: '1px !important',
          },
        };
      }}
    />
  );
}

/** 주소에 담지 않는 작은 표(오피스 자리·TFT 방, OMAI-1127 단계 7). 정렬·페이지·검색 상태를 컴포넌트 안에 둔다.
 *  목록 화면은 ListView 가 같은 일을 주소(?sort=&q=)와 함께 한다 */
export function LocalDataGrid<T>(p: {
  storageKey: string;
  label: string;
  columns: GridColumn<T>[];
  rows: T[];
  rowId: (row: T) => string;
  onRow?: (row: T) => void;
  cellControls?: boolean;
  /** 툴바 오른쪽, 검색창 앞(새로 만들기 단추 등) */
  toolbarEnd?: ReactNode;
  /** 있으면 검색창을 두고 이 글로 거른다 */
  search?: (row: T) => string;
  empty?: ReactNode;
  /** 행 「…」 메뉴. 첫 항목은 「상세 보기」 자리다(DataGrid 의 actions 와 같다) */
  actions?: GridAction<T>[];
  /** 참인 행은 정렬을 바꿔도 맨 위에 모은다(부서 탭의 「목록에 없음」 줄) */
  pin?: (row: T) => boolean;
  /** 이 행이 눌려 서랍이 열려 있을 때 표시할 행 식별자 */
  selectedId?: string | null;
}) {
  const [sort, setSort] = useState<GridSort | null>(null);
  const [page, setPage] = useState(0);
  const [size, setSize] = useState(loadRowsPerPage);
  const [q, setQ] = useState('');
  const needle = q.trim().toLowerCase();
  const shown = needle && p.search ? p.rows.filter((r) => p.search!(r).toLowerCase().includes(needle)) : p.rows;
  const ordered = sortRows(shown, p.columns, sort);
  const sorted = p.pin ? [...ordered.filter((r) => p.pin!(r)), ...ordered.filter((r) => !p.pin!(r))] : ordered;
  const pageNow = clampPage(page, sorted.length, size);
  return (
    <DataGrid<T>
      storageKey={p.storageKey}
      label={p.label}
      columns={p.columns}
      rows={sorted.slice(pageNow * size, (pageNow + 1) * size)}
      rowId={p.rowId}
      rowName={(r) => String(p.columns[0]?.value(r) ?? '')}
      total={sorted.length}
      page={pageNow}
      rowsPerPage={size}
      onPage={setPage}
      onRowsPerPage={(n) => {
        saveRowsPerPage(n);
        setSize(n);
        setPage(0);
      }}
      sort={sort}
      onSort={(x) => {
        setSort(x);
        setPage(0);
      }}
      onRow={p.onRow}
      cellControls={p.cellControls}
      actions={p.actions}
      selectedId={p.selectedId}
      count={
        needle
          ? t('common.grid.shownOf', { total: p.rows.length, shown: sorted.length })
          : t('common.grid.count', { total: sorted.length })
      }
      toolbarEnd={
        p.toolbarEnd || p.search ? (
          <>
            {p.toolbarEnd}
            {p.search && (
              <GridSearch
                value={q}
                onChange={(v) => {
                  setQ(v);
                  setPage(0);
                }}
              />
            )}
          </>
        ) : undefined
      }
      empty={needle && !sorted.length ? t('common.noMatch') : p.empty}
    />
  );
}

